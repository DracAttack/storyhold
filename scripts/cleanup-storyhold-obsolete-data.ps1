param(
  [switch]$ConfirmCleanup,
  [switch]$PreflightOnly
)

$ErrorActionPreference = "Stop"

if ($ConfirmCleanup -and $PreflightOnly) {
  throw "Choose either -PreflightOnly or -ConfirmCleanup, not both."
}
if (-not $ConfirmCleanup -and -not $PreflightOnly) {
  throw "Nothing was deleted. Run with -PreflightOnly to verify the targets or -ConfirmCleanup to perform the guarded cleanup."
}

$repoRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
$dataRoot = (Resolve-Path -LiteralPath (Join-Path $repoRoot ".storyhold-data")).Path
$environmentPath = Join-Path $repoRoot ".storyhold.env"
$activeVaultName = "postgres-recovered-20260905"
$activeVaultPath = (Resolve-Path -LiteralPath (Join-Path $dataRoot $activeVaultName)).Path
$activeVaultLeasePath = Join-Path $dataRoot ".$activeVaultName.storyhold-owner"
$currentBackupPath = Join-Path $dataRoot "vault-current-20260905.sql"
$expectedBackupBytes = 349455
$expectedBackupHash = "BB0B57275767121BE5463E75D437D54D4E2CDAFF82E51FD753E51E513BEADEB4"
$verifyScript = Join-Path $repoRoot "scripts\verify-recovery-server.ts"
$inventoryScript = Join-Path $repoRoot "scripts\inspect-world-reset.ts"
$tsxPath = Join-Path $repoRoot "artifacts\api-server\node_modules\.bin\tsx.cmd"
$startScript = Join-Path $repoRoot "scripts\start-storyhold-background.ps1"

# This is an intentionally closed allowlist. The active vault, current logical
# backup, installed models, account configuration, source code, and storage root
# are not members and cannot be selected by this script.
$obsoleteDirectoryNames = @(
  "backups",
  "comparison-snapshots",
  "postgres-overcorrection-20260826-2320",
  "proof-inspection-copy",
  "proof-v3-inspection-copy",
  "postgres-corrupt-checkpoint-20260822",
  "recovery-backup-diagnostic-20260822",
  "recovery-diagnostic-20260822",
  "schema-smoke-20260815",
  "verification-3011",
  "test-postgres",
  "discrepancy-test-postgres",
  "auto-test-runtime",
  "discrepancy-test-runtime",
  "test-runtime",
  "proof-v2-runtime",
  "postgres",
  "postgres-rebuilt",
  "recovery-current-20260905",
  "review-runs",
  "staging",
  "staging-quarantine",
  "recovery-tools",
  "uploads"
)

function Test-StoryholdHealthy {
  try {
    $response = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/healthz" -TimeoutSec 2
    return $response.status -eq "ok" -and $response.service -eq "storyhold"
  } catch {
    return $false
  }
}

function Assert-VerifiedCurrentState {
  Push-Location $repoRoot
  try {
    & $tsxPath $verifyScript
    if ($LASTEXITCODE -ne 0) {
      throw "Storyhold's account, zero-world state, or active-vault protections did not verify. Nothing will be deleted."
    }
  } finally {
    Pop-Location
  }
}

function Assert-PreservedFiles {
  if (-not (Test-Path -LiteralPath $environmentPath -PathType Leaf)) {
    throw "Storyhold's environment file is missing."
  }

  $dataDirSettings = @(
    Get-Content -LiteralPath $environmentPath |
      Where-Object { $_ -match '^STORYHOLD_LOCAL_DATA_DIR=' }
  )
  if ($dataDirSettings.Count -ne 1 -or $dataDirSettings[0] -ne "STORYHOLD_LOCAL_DATA_DIR=.storyhold-data/$activeVaultName") {
    throw "The configured active vault is not the recovered vault expected by this cleanup."
  }

  if (-not (Test-Path -LiteralPath $activeVaultPath -PathType Container)) {
    throw "The active recovered vault is missing."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $repoRoot ".storyhold-runtime") -PathType Container)) {
    throw "Storyhold's installed-model directory is missing."
  }

  $backup = Get-Item -LiteralPath $currentBackupPath
  $backupHash = (Get-FileHash -LiteralPath $backup.FullName -Algorithm SHA256).Hash
  if ($backup.Length -ne $expectedBackupBytes -or -not $backupHash.Equals($expectedBackupHash, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The compact current backup no longer matches the verified post-reset backup."
  }
}

function Get-SafeCleanupTargets {
  $targets = @()
  foreach ($name in $obsoleteDirectoryNames) {
    $candidatePath = Join-Path $dataRoot $name
    if (-not (Test-Path -LiteralPath $candidatePath)) {
      continue
    }

    $resolvedPath = (Resolve-Path -LiteralPath $candidatePath).Path
    $item = Get-Item -LiteralPath $resolvedPath -Force
    if (-not $item.PSIsContainer) {
      throw "Cleanup target is not a directory: $name"
    }
    if (-not $item.Parent.FullName.Equals($dataRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Cleanup target is not a direct child of Storyhold's data directory: $name"
    }
    if ($resolvedPath.Equals($activeVaultPath, [StringComparison]::OrdinalIgnoreCase)) {
      throw "The active vault somehow appeared in the cleanup list. Nothing will be deleted."
    }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Cleanup target is a link or junction: $name"
    }

    $descendants = @(Get-ChildItem -LiteralPath $resolvedPath -Recurse -Force -ErrorAction Stop)
    $linkedDescendant = $descendants |
      Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 } |
      Select-Object -First 1
    if ($null -ne $linkedDescendant) {
      throw "Cleanup target contains a link or junction: $name"
    }

    $files = @($descendants | Where-Object { -not $_.PSIsContainer })
    # Storyhold recreates this reusable directory at startup. An empty uploads
    # directory is current scaffolding, not stale world data.
    if ($name -eq "uploads" -and $descendants.Count -eq 0) {
      continue
    }
    $bytes = ($files | Measure-Object -Property Length -Sum).Sum
    if ($null -eq $bytes) {
      $bytes = 0
    }
    $targets += [pscustomobject]@{
      Name = $name
      Path = $resolvedPath
      Bytes = [long]$bytes
    }
  }
  return $targets
}

function Assert-ServerStopped {
  if (Test-StoryholdHealthy) {
    throw "Storyhold still answers on port 3000. Nothing will be deleted."
  }
  if (Test-Path -LiteralPath $activeVaultLeasePath) {
    throw "The active database ownership lease still exists. Nothing will be deleted."
  }
}

function Stop-StoryholdCleanly {
  if (-not (Test-StoryholdHealthy)) {
    throw "Storyhold stopped answering before its clean-shutdown request. Nothing will be deleted."
  }
  if (-not (Test-Path -LiteralPath $activeVaultLeasePath -PathType Container)) {
    throw "The active database ownership record is missing. Nothing will be deleted."
  }

  $ownerRecordPath = Join-Path $activeVaultLeasePath "owner.json"
  $ownerRecord = Get-Content -LiteralPath $ownerRecordPath -Raw | ConvertFrom-Json
  $ownerProcessId = [int]$ownerRecord.pid
  if ($ownerProcessId -le 0) {
    throw "The active database ownership record has no valid process ID. Nothing will be deleted."
  }

  $response = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/storyhold/local/shutdown" -Method Post -TimeoutSec 5
  if ($response.status -ne "stopping") {
    throw "Storyhold did not accept its clean-shutdown request. Nothing will be deleted."
  }

  # There is deliberately no Stop-Process fallback here. Deletion is allowed
  # only after Storyhold itself closes PGlite, releases the vault lease, and
  # exits. A timeout safely aborts the cleanup.
  foreach ($attempt in 1..240) {
    $ownerStillRunning = $null -ne (Get-Process -Id $ownerProcessId -ErrorAction SilentlyContinue)
    if (-not $ownerStillRunning -and -not (Test-Path -LiteralPath $activeVaultLeasePath)) {
      break
    }
    Start-Sleep -Milliseconds 250
  }

  Assert-ServerStopped
  if ($null -ne (Get-Process -Id $ownerProcessId -ErrorAction SilentlyContinue)) {
    throw "Storyhold's database process did not exit cleanly. Nothing will be deleted."
  }
}

function Assert-GloballyEmptyVault {
  Assert-ServerStopped

  Push-Location $repoRoot
  try {
    $inventoryOutput = @(& $tsxPath $inventoryScript --summary 2>&1)
    if ($LASTEXITCODE -ne 0) {
      throw "The exclusive global world inventory failed. Nothing will be deleted."
    }
  } finally {
    Pop-Location
  }

  $jsonLine = $inventoryOutput |
    ForEach-Object { [string]$_ } |
    Where-Object { $_.TrimStart().StartsWith("{") } |
    Select-Object -Last 1
  if ([string]::IsNullOrWhiteSpace($jsonLine)) {
    throw "The exclusive global world inventory returned no readable result. Nothing will be deleted."
  }

  try {
    $inventory = $jsonLine | ConvertFrom-Json
  } catch {
    throw "The exclusive global world inventory returned invalid data. Nothing will be deleted."
  }

  if (@($inventory.worlds).Count -ne 0 -or @($inventory.active).Count -ne 0 -or @($inventory.held).Count -ne 0) {
    throw "The database contains a world, active intake, or held credit reservation. Nothing will be deleted."
  }

  # The inventory helper closes PGlite before releasing its ownership lease.
  Assert-ServerStopped
}

Assert-PreservedFiles

if (-not (Test-StoryholdHealthy)) {
  Write-Host "Starting Storyhold so the recovered account and empty world library can be verified..."
  & $startScript
}

Assert-VerifiedCurrentState
$targets = @(Get-SafeCleanupTargets)
$totalBytes = [long](($targets | Measure-Object -Property Bytes -Sum).Sum)
$totalGiB = [math]::Round($totalBytes / 1GB, 2)
$freeBefore = (Get-PSDrive -Name C).Free

if ($PreflightOnly) {
  Write-Host "Preflight passed. $($targets.Count) exact obsolete directories currently total $totalGiB GiB."
  Write-Host "Nothing was deleted and Storyhold remains online."
  exit 0
}

if ($targets.Count -eq 0) {
  Write-Host "All 24 obsolete Storyhold directories have already been removed."
  exit 0
}

Write-Host "Verified $($targets.Count) exact obsolete directories totaling $totalGiB GiB."
$cleanupError = $null
$restartError = $null
$deletedNames = [System.Collections.Generic.List[string]]::new()

try {
  Write-Host "Stopping Storyhold cleanly before deletion..."
  Stop-StoryholdCleanly
  Write-Host "Checking the stopped vault for any world or active intake..."
  Assert-GloballyEmptyVault

  foreach ($target in $targets) {
    # Reassert the two most important invariants before every destructive step.
    Assert-ServerStopped
    Assert-PreservedFiles

    Write-Host "Deleting $($target.Name)..."
    Remove-Item -LiteralPath $target.Path -Recurse -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $target.Path) {
      throw "Windows reported success but the directory still exists: $($target.Name)"
    }
    $deletedNames.Add($target.Name)
  }
} catch {
  $cleanupError = $_
}

try {
  Write-Host "Restarting Storyhold..."
  if (Test-Path -LiteralPath $activeVaultLeasePath) {
    throw "The previous database owner still holds its lease, so starting a second database process would be unsafe."
  }
  if (-not (Test-StoryholdHealthy)) {
    & $startScript
  }
  if (-not (Test-StoryholdHealthy)) {
    throw "Storyhold did not become healthy after the cleanup attempt."
  }
  Assert-VerifiedCurrentState
  Assert-PreservedFiles
} catch {
  $restartError = $_
}

if ($null -ne $cleanupError) {
  if ($null -ne $restartError) {
    throw "Cleanup stopped after deleting $($deletedNames.Count) directories: $($cleanupError.Exception.Message) Storyhold also failed to restart: $($restartError.Exception.Message)"
  }
  throw "Cleanup stopped after deleting $($deletedNames.Count) directories: $($cleanupError.Exception.Message) Storyhold was restarted and verified. Run the script again to remove any remaining allowlisted directories."
}

if ($null -ne $restartError) {
  throw "The obsolete directories were deleted, but Storyhold failed its restart check: $($restartError.Exception.Message)"
}

$remainingTargets = @(Get-SafeCleanupTargets)
if ($remainingTargets.Count -ne 0) {
  throw "Cleanup finished without an error, but $($remainingTargets.Count) allowlisted directories remain."
}

$freeAfter = (Get-PSDrive -Name C).Free
$freedGiB = [math]::Round(($freeAfter - $freeBefore) / 1GB, 2)
Write-Host "Cleanup complete. Deleted all $($deletedNames.Count) obsolete directories."
Write-Host "Windows reports $freedGiB GiB of additional free space."
Write-Host "The active vault, current backup, installed models, account, project code, and running Storyhold server were preserved and verified."

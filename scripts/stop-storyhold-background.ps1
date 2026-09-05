$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $repoRoot ".storyhold-data"
$pidPath = Join-Path $runtimeRoot "storyhold-local.pid"

if (-not (Test-Path -LiteralPath $pidPath)) {
  Write-Host "Storyhold is not running."
  & (Join-Path $PSScriptRoot "stop-storyhold-gliner.ps1")
  exit 0
}

$processId = [int](Get-Content -LiteralPath $pidPath -Raw)
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue

if (-not $process -or $process.ProcessName -ne "node") {
  Remove-Item -LiteralPath $pidPath -Force
  Write-Host "Storyhold is not running. The old launcher record was cleared."
  & (Join-Path $PSScriptRoot "stop-storyhold-gliner.ps1")
  exit 0
}

$shutdownRequested = $false
try {
  $response = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/storyhold/local/shutdown" -Method Post -TimeoutSec 2
  $shutdownRequested = $response.status -eq "stopping"
} catch {
  # Compatibility fallback for a preview started before orderly shutdown was
  # added. New previews should always exit through the endpoint above.
}

if ($shutdownRequested) {
  foreach ($attempt in 1..40) {
    if ($process.HasExited) { break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $process.HasExited) {
    # The database-owning child has already closed cleanly; only the launcher
    # wrapper remains at this point.
    Stop-Process -Id $processId
    $process.WaitForExit(5000) | Out-Null
  }
}

if (-not $shutdownRequested -and -not $process.HasExited) {
  Stop-Process -Id $processId
  $process.WaitForExit(5000) | Out-Null
}
Remove-Item -LiteralPath $pidPath -Force
Write-Host "Storyhold has stopped."
& (Join-Path $PSScriptRoot "stop-storyhold-gliner.ps1")

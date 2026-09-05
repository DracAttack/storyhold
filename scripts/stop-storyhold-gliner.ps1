$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $repoRoot ".storyhold-runtime\gliner"
$venvRoot = Join-Path $runtimeRoot "venv"
$pidPath = Join-Path $runtimeRoot "gliner.pid"
$healthUrl = "http://127.0.0.1:8765/health"
$shutdownUrl = "http://127.0.0.1:8765/shutdown"

function Test-LorekeeperProcessPath {
  param($Process, [string[]]$ExpectedPaths)
  if ($null -eq $Process -or $Process.ProcessName -ne "python") { return $false }
  $actualPath = $Process.Path
  if ([string]::IsNullOrWhiteSpace($actualPath)) { return $false }
  foreach ($expectedPath in $ExpectedPaths) {
    if ($actualPath.Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

function Get-LorekeeperProcess {
  param([int]$ProcessId)
  try { return Get-Process -Id $ProcessId -ErrorAction Stop } catch {
    # Permission errors do not prove the process exited.
    if ($_.FullyQualifiedErrorId -like "NoProcessFoundForGivenId*") { return $null }
    throw
  }
}

# Windows venv Python can redirect into its recorded base executable. Accept
# these exact paths, never an arbitrary process merely named Python.
$expectedPythonPaths = @((Join-Path $venvRoot "Scripts\python.exe"))
$venvConfigPath = Join-Path $venvRoot "pyvenv.cfg"
if (Test-Path -LiteralPath $venvConfigPath -PathType Leaf) {
  foreach ($line in Get-Content -LiteralPath $venvConfigPath) {
    if ($line -match '^executable\s*=\s*(.+)$') {
      $basePythonPath = $Matches[1].Trim()
      if ([IO.Path]::IsPathRooted($basePythonPath) -and
          [IO.Path]::GetFileName($basePythonPath) -ieq "python.exe") {
        $expectedPythonPaths += $basePythonPath
      }
    }
  }
}

try { $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2 } catch { $health = $null }
$recordedPidText = if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
  (Get-Content -LiteralPath $pidPath -Raw).Trim()
} else { $null }
$recordedPid = 0
if ($null -ne $recordedPidText -and
    (-not [int]::TryParse($recordedPidText, [ref]$recordedPid) -or $recordedPid -le 0)) {
  throw "Storyhold's Lorekeeper PID record is invalid. No processes were stopped and the record was preserved."
}
if ($null -eq $health) {
  if ($recordedPid -gt 0 -and $null -ne (Get-LorekeeperProcess $recordedPid)) {
    throw "Lorekeeper is not answering, so its identity and child cleanup cannot be verified. No process was forced to stop; its PID record was preserved."
  }
  Write-Host "Lorekeeper is not answering and no recorded process is running. No process or PID record was changed."
  exit 0
}
if ($health.service -ne "storyhold-lorekeeper-local") {
  throw "Port 8765 is not the Storyhold Lorekeeper service. Nothing was stopped."
}
$supervisorPid = 0
if (-not [int]::TryParse([string]$health.supervisorPid, [ref]$supervisorPid) -or $supervisorPid -le 0) {
  throw "The Lorekeeper health response has no valid supervisor identity. Nothing was stopped."
}
$processIds = [System.Collections.Generic.HashSet[int]]::new()
[void]$processIds.Add($supervisorPid)
if ($recordedPid -gt 0) { [void]$processIds.Add($recordedPid) }
if ($null -ne $health.workerPid) {
  $workerPid = 0
  if (-not [int]::TryParse([string]$health.workerPid, [ref]$workerPid) -or $workerPid -le 0) {
    throw "The Lorekeeper worker identity is invalid. Nothing was stopped."
  }
  [void]$processIds.Add($workerPid)
}
$trackedProcesses = @()
foreach ($storyholdProcessId in $processIds) {
  $process = Get-LorekeeperProcess $storyholdProcessId
  if ($null -eq $process) {
    if ($storyholdProcessId -eq $supervisorPid) { throw "The Lorekeeper supervisor disappeared before shutdown. Retry after checking its status." }
    continue
  }
  if (-not (Test-LorekeeperProcessPath $process $expectedPythonPaths)) {
    throw "Process $storyholdProcessId does not have a verified Storyhold Python path. Nothing was stopped."
  }
  $trackedProcesses += $process
}
$response = Invoke-RestMethod -Uri $shutdownUrl -Method Post -TimeoutSec 5
if ($response.status -ne "stopping") { throw "Lorekeeper did not accept orderly shutdown. The PID record was preserved." }

# The supervisor may need up to 25 seconds to dispose its model worker. Do not
# kill that parent halfway through cleanup and leave an orphaned worker behind.
foreach ($attempt in 1..240) {
  if (@($trackedProcesses | Where-Object { -not $_.HasExited }).Count -eq 0) { break }
  Start-Sleep -Milliseconds 250
}
if (@($trackedProcesses | Where-Object { -not $_.HasExited }).Count -ne 0) {
  throw "Lorekeeper has not finished orderly shutdown. No process was forced to stop; its PID record was preserved."
}
try { $remainingHealth = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2 } catch { $remainingHealth = $null }
if ($null -ne $remainingHealth) { throw "A service still answers on port 8765. Its PID record was preserved." }
if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
  if ((Get-Content -LiteralPath $pidPath -Raw).Trim() -ne $recordedPidText) {
    throw "The Lorekeeper PID record changed during shutdown and was preserved."
  }
  Remove-Item -LiteralPath $pidPath -Force
}
Write-Host "Storyhold's local Lorekeeper and its recorded worker have stopped cleanly."

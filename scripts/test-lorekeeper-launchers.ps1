$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$startPath = Join-Path $PSScriptRoot "start-storyhold-gliner.ps1"
$stopPath = Join-Path $PSScriptRoot "stop-storyhold-gliner.ps1"
$stopCode = Get-Content -LiteralPath $stopPath -Raw

function Assert-True {
  param([bool]$Value, [string]$Message)
  if (-not $Value) { throw $Message }
}

# Parse and load only the readiness function: never execute a real launcher.
$tokens = $null
$parseErrors = $null
$startAst = [System.Management.Automation.Language.Parser]::ParseFile($startPath, [ref]$tokens, [ref]$parseErrors)
Assert-True (@($parseErrors).Count -eq 0) "Start script failed to parse."
$readyFunction = $startAst.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq "Test-GlinerReady" }, $true)
Invoke-Expression $readyFunction.Extent.Text
function Get-GlinerHealth { return $script:mockHealth }
$script:mockHealth = [pscustomobject]@{
  status = "ready"; service = "storyhold-lorekeeper-local"; sequential = $true
  processIsolation = $true; maximumResidentWorkers = 1; components = [pscustomobject]@{}
}
foreach ($stage in @("gliner2", "minilm", "bge", "nli", "coreference", "qwen")) {
  $script:mockHealth.components | Add-Member -NotePropertyName $stage -NotePropertyValue ([pscustomobject]@{ configured=$true; ready=$false })
}
Assert-True (Test-GlinerReady) "Blocked but configured models must reuse the live supervisor."
$script:mockHealth.components.gliner2.configured = $false
$script:mockHealth.components.gliner2.ready = $true
Assert-True (-not (Test-GlinerReady)) "An explicitly unconfigured model cannot pass through its legacy ready flag."
$script:mockHealth.components.gliner2 = [pscustomobject]@{ ready=$true }
Assert-True (Test-GlinerReady) "Legacy health without configured should remain compatible."
$script:mockHealth.service = "another-service"
Assert-True (-not (Test-GlinerReady)) "A different service must never be considered Lorekeeper."

function Invoke-MockedStop {
  param([string]$Scenario)
  # Every external operation is replaced before invoking the production script.
  # No real files, services, processes, or timers are touched by these scenarios.
  & {
    param($Code, $Case, $Root)
    $script:mockPosts = 0
    $script:mockRemovals = 0
    $script:mockTicks = 0
    $script:mockPIDText = "123"
    $pythonPath = Join-Path $Root ".storyhold-runtime\gliner\venv\Scripts\python.exe"
    $script:mockProcesses = @{
      123 = [pscustomobject]@{ ProcessName="python"; Path=$pythonPath; HasExited=$false }
      124 = [pscustomobject]@{ ProcessName="python"; Path=$pythonPath; HasExited=$false }
    }
    if ($Case -eq "wrong-path") { $script:mockProcesses[124].Path = "C:\Unrelated\python.exe" }
    if ($Case -eq "unreadable-path") { $script:mockProcesses[123].Path = $null }
    $script:mockStopHealth = [pscustomobject]@{ service="storyhold-lorekeeper-local"; supervisorPid=123; workerPid=124 }
    if ($Case -eq "wrong-service") { $script:mockStopHealth.service = "another-service" }

    function Test-Path { param($LiteralPath, $PathType) return $LiteralPath -like "*gliner.pid" }
    function Get-Content { param($LiteralPath, [switch]$Raw) return $script:mockPIDText }
    function Get-Process { [CmdletBinding()]param([int]$Id) return $script:mockProcesses[$Id] }
    function Remove-Item { param($LiteralPath, [switch]$Force) $script:mockRemovals++ }
    function Stop-Process { throw "A launcher must not force-stop any process." }
    function Write-Host { param($Object) }
    function Start-Sleep {
      param($Milliseconds)
      $script:mockTicks++
      # Simulate a child needing 30 seconds: longer than the old 10-second kill.
      if ($Case -ne "timeout" -and $script:mockTicks -ge 120) {
        $script:mockProcesses[123].HasExited = $true
        $script:mockProcesses[124].HasExited = $true
        if ($Case -eq "changed-pid") { $script:mockPIDText = "999" }
      }
    }
    function Invoke-RestMethod {
      param($Uri, $Method, $TimeoutSec)
      if ($Method -eq "Post") {
        $script:mockPosts++
        if ($Case -eq "rejected-shutdown") { return [pscustomobject]@{ status="rejected" } }
        return [pscustomobject]@{ status="stopping" }
      }
      if ($script:mockProcesses[123].HasExited) { throw "Mock server offline." }
      return $script:mockStopHealth
    }
    $failure = $null
    # An in-memory scriptblock has no script-file root. Substitute only this
    # path derivation; all shutdown branches remain the production code.
    $mockCode = $Code.Replace('$repoRoot = Split-Path -Parent $PSScriptRoot', '$repoRoot = $Root')
    try { & ([scriptblock]::Create($mockCode)) } catch { $failure = $_.Exception.Message }
    [pscustomobject]@{ Failure=$failure; Posts=$script:mockPosts; Removals=$script:mockRemovals; Ticks=$script:mockTicks }
  } $stopCode $Scenario $repoRoot
}

$stopTokens = $null
$stopErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($stopPath, [ref]$stopTokens, [ref]$stopErrors)
Assert-True (@($stopErrors).Count -eq 0) "Stop script failed to parse."
foreach ($case in @("wrong-service", "wrong-path", "unreadable-path")) {
  $result = Invoke-MockedStop $case
  Assert-True ($null -ne $result.Failure -and $result.Posts -eq 0 -and $result.Removals -eq 0) "$case did not fail closed before shutdown."
}
foreach ($case in @("timeout", "changed-pid", "rejected-shutdown")) {
  $result = Invoke-MockedStop $case
  Assert-True ($null -ne $result.Failure -and $result.Posts -eq 1 -and $result.Removals -eq 0) "$case did not preserve the PID record."
}
$success = Invoke-MockedStop "graceful-slow-worker"
Assert-True ($null -eq $success.Failure -and $success.Posts -eq 1 -and $success.Removals -eq 1 -and $success.Ticks -eq 120) "A slowly closing worker must finish before its PID record is removed. $($success.Failure)"
Write-Output "Passed: 4 readiness cases and 7 fully mocked stop scenarios; no live service or model was used."

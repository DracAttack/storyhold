$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$starter = Join-Path $PSScriptRoot "start-storyhold-background.ps1"
$storyholdUrl = "http://127.0.0.1:3000/"
$runtimeRoot = Join-Path $repoRoot ".storyhold-data"
$launcherErrorPath = Join-Path $runtimeRoot "logs\desktop-launcher.err.log"

try {
  & $starter
  Start-Process $storyholdUrl
  exit 0
} catch {
  $message = "Storyhold could not start.`r`n`r`n$($_.Exception.Message)`r`n`r`nDetails were saved to:`r`n$launcherErrorPath"
  New-Item -ItemType Directory -Path (Split-Path -Parent $launcherErrorPath) -Force | Out-Null
  [System.IO.File]::WriteAllText($launcherErrorPath, "$(Get-Date -Format o)`r`n$($_ | Out-String)")

  try {
    Add-Type -AssemblyName PresentationFramework
    [void][System.Windows.MessageBox]::Show(
      $message,
      "Storyhold Startup Problem",
      [System.Windows.MessageBoxButton]::OK,
      [System.Windows.MessageBoxImage]::Error
    )
  } catch {
    Write-Error $message
  }
  exit 1
}

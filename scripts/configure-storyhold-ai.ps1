$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$examplePath = Join-Path $repositoryRoot ".storyhold.env.example"
$settingsPath = Join-Path $repositoryRoot ".storyhold.env"

if (-not (Test-Path -LiteralPath $settingsPath)) {
  Copy-Item -LiteralPath $examplePath -Destination $settingsPath
}

Start-Process -FilePath "notepad.exe" -ArgumentList @($settingsPath)

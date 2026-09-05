param(
  [switch]$VerifyOnly
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $repoRoot ".storyhold-runtime\gliner"
$pythonPath = Join-Path $runtimeRoot "venv\Scripts\python.exe"
$stopScript = Join-Path $PSScriptRoot "stop-storyhold-gliner.ps1"
$verificationScript = Join-Path $PSScriptRoot "verify-storyhold-llama-gpu.py"
$cudaStatusPath = Join-Path $runtimeRoot "cuda-status.json"
$version = "0.3.35"
$wheelIndex = "https://abetlen.github.io/llama-cpp-python/whl/vulkan"

if (-not (Test-Path -LiteralPath $pythonPath)) {
  throw "Storyhold's isolated local-model environment is missing. Run pnpm run storyhold:install-gliner first."
}

if (-not $VerifyOnly) {
  if (Test-Path -LiteralPath $stopScript) {
    & $stopScript
  }
  Write-Host "Installing the official llama-cpp-python $version Vulkan GPU wheel..."
  & $pythonPath -m pip install --disable-pip-version-check --upgrade --force-reinstall --no-deps `
    "llama-cpp-python==$version" --index-url $wheelIndex
  if ($LASTEXITCODE -ne 0) {
    throw "The GPU-enabled llama.cpp wheel could not be installed."
  }
}

$receipt = & $pythonPath $verificationScript
if ($LASTEXITCODE -ne 0 -or -not $receipt) {
  throw "The llama.cpp GPU verification command failed."
}
$capability = $receipt | Select-Object -Last 1 | ConvertFrom-Json
if ($capability.version -ne $version -or $capability.gpuOffload -ne $true) {
  throw "llama.cpp installed, but its GPU-offload capability is unavailable."
}

if (Test-Path -LiteralPath $cudaStatusPath) {
  $cudaStatus = Get-Content -LiteralPath $cudaStatusPath -Raw | ConvertFrom-Json
  $cudaStatus.qwen = "llama.cpp-gpu-offload-ready"
  $cudaStatus | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $cudaStatusPath -Encoding utf8
}

Write-Host "Storyhold llama.cpp $($capability.version) supports GPU offload."
Write-Host "The safe Qwen layer count still comes from the Storyhold benchmark; this installer does not guess it."

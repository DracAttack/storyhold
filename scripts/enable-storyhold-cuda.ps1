param(
  [switch]$VerifyOnly
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $repoRoot ".storyhold-runtime\gliner"
$pythonPath = Join-Path $runtimeRoot "venv\Scripts\python.exe"
$stopScript = Join-Path $PSScriptRoot "stop-storyhold-gliner.ps1"
$verificationScript = Join-Path $PSScriptRoot "verify-storyhold-cuda.py"
$statusPath = Join-Path $runtimeRoot "cuda-status.json"
$torchVersion = "2.13.0"
$torchvisionVersion = "0.28.0"
$cudaWheel = "cu132"
$cudaIndex = "https://download.pytorch.org/whl/$cudaWheel"

if (-not (Test-Path -LiteralPath $pythonPath)) {
  throw "Storyhold's isolated local-model environment is missing. Run pnpm run storyhold:install-gliner first."
}

$nvidiaSmi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
if (-not $nvidiaSmi) {
  throw "No NVIDIA driver was found. Storyhold left its CPU runtime unchanged."
}

$gpuName = (& $nvidiaSmi.Source --query-gpu=name --format=csv,noheader 2>$null | Select-Object -First 1).Trim()
if (-not $gpuName) {
  throw "The NVIDIA driver did not report an available GPU. Storyhold left its CPU runtime unchanged."
}

if (-not $VerifyOnly) {
  if (Test-Path -LiteralPath $stopScript) {
    & $stopScript
  }

  Write-Host "Installing Storyhold's official PyTorch CUDA 13.2 runtime for $gpuName..."
  & $pythonPath -m pip install --disable-pip-version-check --upgrade --force-reinstall `
    "torch==$torchVersion" "torchvision==$torchvisionVersion" "fsspec==2026.6.0" `
    --index-url $cudaIndex
  if ($LASTEXITCODE -ne 0) {
    throw "The CUDA-enabled PyTorch wheels could not be installed."
  }
}

$verification = & $pythonPath $verificationScript
if ($LASTEXITCODE -ne 0) {
  throw "The CUDA runtime installed, but Storyhold's GPU verification failed."
}

$verificationJson = @($verification) |
  Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } |
  Select-Object -Last 1
if (-not $verificationJson) {
  throw "CUDA completed no readable verification receipt."
}
try {
  $verificationObject = $verificationJson | ConvertFrom-Json
} catch {
  throw "CUDA returned an invalid verification receipt: $verificationJson"
}
if (
  $verificationObject.available -ne $true `
  -or [string]::IsNullOrWhiteSpace([string]$verificationObject.device) `
  -or [long]$verificationObject.totalMemoryBytes -le 0 `
  -or [string]::IsNullOrWhiteSpace([string]$verificationObject.torchVersion) `
  -or [string]::IsNullOrWhiteSpace([string]$verificationObject.cudaRuntime)
) {
  throw "CUDA verification did not report a complete GPU capability receipt."
}
$status = [ordered]@{
  installedAt = [DateTimeOffset]::UtcNow.ToString("o")
  accelerator = "cuda"
  mode = "auto-with-cpu-fallback"
  cudaStages = @("gliner2", "coreference", "nli", "minilm", "bge")
  qwen = "managed-separately-by-llama.cpp-gpu-offload"
  device = $verificationObject.device
  totalMemoryBytes = [long]$verificationObject.totalMemoryBytes
  torchVersion = $verificationObject.torchVersion
  cudaRuntime = $verificationObject.cudaRuntime
}
$status | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statusPath -Encoding utf8

Write-Host "Storyhold CUDA is ready on $($verificationObject.device)."
Write-Host "GLiNER2, coreference, NLI, MiniLM, and BGE will try the GPU sequentially and fall back to CPU if a stage does not fit."
Write-Host "Qwen 4B uses its separately verified llama.cpp GPU-offload runtime when available."
Write-Host "Restart Storyhold normally to use the new runtime."

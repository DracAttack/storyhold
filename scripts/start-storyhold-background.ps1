$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$apiRoot = Join-Path $repoRoot "artifacts\api-server"
$healthUrl = "http://127.0.0.1:3000/api/healthz"
$siteUrl = "http://127.0.0.1:3000/"
$runtimeRoot = Join-Path $repoRoot ".storyhold-data"
$logRoot = Join-Path $runtimeRoot "logs"
$pidPath = Join-Path $runtimeRoot "storyhold-local.pid"
$stdoutPath = Join-Path $logRoot "local-server.out.log"
$stderrPath = Join-Path $logRoot "local-server.err.log"
$glinerStarter = Join-Path $PSScriptRoot "start-storyhold-gliner.ps1"

$env:STORYHOLD_REQUIRE_FULL_LOCAL_INTAKE = "true"
$env:STORYHOLD_LOCAL_ACCELERATION = if ($env:STORYHOLD_LOCAL_ACCELERATION) {
  $env:STORYHOLD_LOCAL_ACCELERATION
} else {
  "auto"
}
if (-not $env:STORYHOLD_LOCAL_CUDA_STAGES) {
  $env:STORYHOLD_LOCAL_CUDA_STAGES = "gliner2,coreference,nli,minilm,bge"
}
$env:STORYHOLD_LOCAL_GLINER2_ENABLED = "true"
$env:STORYHOLD_LOCAL_GLINER2_URL = "http://127.0.0.1:8765/gliner2"
$env:STORYHOLD_LOCAL_NER_ENABLED = "true"
$env:STORYHOLD_LOCAL_NER_URL = $env:STORYHOLD_LOCAL_GLINER2_URL
$env:STORYHOLD_LOCAL_MINILM_ENABLED = "true"
$env:STORYHOLD_LOCAL_MINILM_URL = "http://127.0.0.1:8765/rerank/fast"
$env:STORYHOLD_LOCAL_RERANKER_ENABLED = "true"
$env:STORYHOLD_LOCAL_RERANKER_URL = "http://127.0.0.1:8765/rerank/final"
$env:STORYHOLD_LOCAL_NLI_ENABLED = "true"
$env:STORYHOLD_LOCAL_NLI_URL = "http://127.0.0.1:8765/nli"
$env:STORYHOLD_LOCAL_COREFERENCE_ENABLED = "true"
$env:STORYHOLD_LOCAL_COREFERENCE_URL = "http://127.0.0.1:8765/coreference"
if (-not $env:STORYHOLD_LOCAL_GLINER2_MODEL) {
  $env:STORYHOLD_LOCAL_GLINER2_MODEL = "fastino/gliner2-base-v1"
}
$env:STORYHOLD_LOCAL_NER_MODEL = $env:STORYHOLD_LOCAL_GLINER2_MODEL
if (-not $env:STORYHOLD_LOCAL_MINILM_MODEL) {
  $env:STORYHOLD_LOCAL_MINILM_MODEL = "cross-encoder/ms-marco-MiniLM-L6-v2"
}
if (-not $env:STORYHOLD_LOCAL_BGE_MODEL) {
  $env:STORYHOLD_LOCAL_BGE_MODEL = "BAAI/bge-reranker-v2-m3"
}
$env:STORYHOLD_LOCAL_RERANKER_MODEL = $env:STORYHOLD_LOCAL_BGE_MODEL
if (-not $env:STORYHOLD_LOCAL_NLI_MODEL) {
  $env:STORYHOLD_LOCAL_NLI_MODEL = "cross-encoder/nli-deberta-v3-xsmall"
}
if (-not $env:STORYHOLD_LOCAL_COREFERENCE_MODEL) {
  $env:STORYHOLD_LOCAL_COREFERENCE_MODEL = "biu-nlp/f-coref"
}
if (-not $env:STORYHOLD_LOCAL_QWEN_MODEL) {
  $env:STORYHOLD_LOCAL_QWEN_MODEL = "Qwen/Qwen3.5-4B-Instruct"
}
if (-not $env:STORYHOLD_LOCAL_QWEN_GPU_LAYERS) {
  # Keep the maximum layer offload benchmarked for this laptop's RTX 3050.
  # Transient inference headroom is managed independently by the micro-batch.
  $env:STORYHOLD_LOCAL_QWEN_GPU_LAYERS = "32"
}
if (-not $env:STORYHOLD_LOCAL_QWEN_BATCH_SIZE) {
  $env:STORYHOLD_LOCAL_QWEN_BATCH_SIZE = "512"
}
if (-not $env:STORYHOLD_LOCAL_QWEN_MICRO_BATCH_SIZE) {
  # Smaller physical chunks avoid the observed peak Vulkan allocation without
  # changing Qwen's weights, 16K context, evidence, or output settings.
  $env:STORYHOLD_LOCAL_QWEN_MICRO_BATCH_SIZE = "128"
}
if (-not $env:STORYHOLD_LOCAL_QWEN_OFFLOAD_KQV) {
  $env:STORYHOLD_LOCAL_QWEN_OFFLOAD_KQV = "true"
}
if (-not $env:STORYHOLD_LOCAL_QWEN_VULKAN_DEVICE) {
  # Vulkan enumerates the Intel iGPU first and the NVIDIA dGPU second here.
  $env:STORYHOLD_LOCAL_QWEN_VULKAN_DEVICE = "1"
}
$env:GGML_VK_VISIBLE_DEVICES = $env:STORYHOLD_LOCAL_QWEN_VULKAN_DEVICE

function Start-LorekeeperInBackground {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:8765/health" -TimeoutSec 2
    if ($health.status -eq "ready" -and $health.service -eq "storyhold-lorekeeper-local") {
      return
    }
  } catch {
    # The Lorekeeper service is not ready yet. Its guarded launcher below will
    # either start it or wait for the one already loading.
  }

  $windowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $powerShellPath = if (Test-Path -LiteralPath $windowsPowerShell) {
    $windowsPowerShell
  } else {
    (Get-Command powershell.exe -ErrorAction Stop).Source
  }

  Start-Process -FilePath $powerShellPath `
    -ArgumentList @(
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-WindowStyle", "Hidden",
      "-File", ('"{0}"' -f $glinerStarter)
    ) `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden | Out-Null
}

# Lorekeeper's larger local models can take a while to verify on a cold start.
# Start that guarded process alongside the web server so the desktop shortcut
# can open Storyhold promptly instead of displaying an apparently empty shell.
Start-LorekeeperInBackground

function Test-StoryholdReady {
  try {
    $response = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1
    return $response.status -eq "ok"
  } catch {
    return $false
  }
}

if (Test-StoryholdReady) {
  Write-Host "Storyhold is already running at $siteUrl. Restart it once if this is the first GLiNER installation so the server receives the new local-reader settings."
  exit 0
}

$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$tsxCli = Get-ChildItem -Path (Join-Path $repoRoot "node_modules\.pnpm\tsx@*\node_modules\tsx\dist\cli.mjs") -File |
  Select-Object -First 1 -ExpandProperty FullName

if (-not $tsxCli) {
  throw "Storyhold's local dependencies are missing. Ask Codex to reinstall them."
}

$builtSite = Join-Path $repoRoot "artifacts\site\dist\public\index.html"
if (-not (Test-Path -LiteralPath $builtSite)) {
  throw "Storyhold's local interface has not been built yet. Ask Codex to prepare it."
}

New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$startParameters = @{
  FilePath = $nodePath
  ArgumentList = @($tsxCli, ".\src\local.ts")
  WorkingDirectory = $apiRoot
  WindowStyle = "Hidden"
  RedirectStandardOutput = $stdoutPath
  RedirectStandardError = $stderrPath
  PassThru = $true
}

# Some Windows hosts inject both `Path` and `PATH` into the process environment.
# Start-Process treats those as the same key and refuses to launch, so normalize
# the current launcher's copy without changing the user's system environment.
$cleanPath = [System.Environment]::GetEnvironmentVariable("Path", "Process")
[System.Environment]::SetEnvironmentVariable("PATH", $null, "Process")
[System.Environment]::SetEnvironmentVariable("Path", $cleanPath, "Process")

$process = Start-Process @startParameters

[System.IO.File]::WriteAllText($pidPath, [string]$process.Id)

# Large saved worlds can need more than a minute to reconcile their local
# projections after an upgrade. Keep the guarded launcher alive for up to five
# minutes so a healthy cold start is not mistaken for a failed shortcut.
foreach ($attempt in 1..600) {
  if (Test-StoryholdReady) {
    Write-Host "Storyhold is running at $siteUrl"
    exit 0
  }

  if ($process.HasExited) {
    $details = if (Test-Path -LiteralPath $stderrPath) {
      Get-Content -LiteralPath $stderrPath -Raw
    } else {
      "No error log was created."
    }
    throw "Storyhold stopped during startup.`n$details"
  }

  Start-Sleep -Milliseconds 500
}

throw "Storyhold took too long to start. Ask Codex to inspect $stderrPath"

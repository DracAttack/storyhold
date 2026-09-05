$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $repoRoot ".storyhold-runtime\gliner"
$venvRoot = Join-Path $runtimeRoot "venv"
$pythonPath = Join-Path $venvRoot "Scripts\python.exe"
$modelCache = Join-Path $runtimeRoot "models"
$serviceScript = Join-Path $PSScriptRoot "gliner-service.py"
$logRoot = Join-Path $repoRoot ".storyhold-data\logs"
$pidPath = Join-Path $runtimeRoot "gliner.pid"
$stdoutPath = Join-Path $logRoot "gliner.out.log"
$stderrPath = Join-Path $logRoot "gliner.err.log"
$healthUrl = "http://127.0.0.1:8765/health"
$cudaStatusPath = Join-Path $runtimeRoot "cuda-status.json"
$gliner2Model = if ($env:STORYHOLD_LOCAL_GLINER2_MODEL) {
  $env:STORYHOLD_LOCAL_GLINER2_MODEL
} elseif ($env:STORYHOLD_LOCAL_NER_MODEL) {
  $env:STORYHOLD_LOCAL_NER_MODEL
} else {
  "fastino/gliner2-base-v1"
}
$miniLmModel = if ($env:STORYHOLD_LOCAL_MINILM_MODEL) {
  $env:STORYHOLD_LOCAL_MINILM_MODEL
} else {
  "cross-encoder/ms-marco-MiniLM-L6-v2"
}
$bgeModel = if ($env:STORYHOLD_LOCAL_BGE_MODEL) {
  $env:STORYHOLD_LOCAL_BGE_MODEL
} elseif ($env:STORYHOLD_LOCAL_RERANKER_MODEL) {
  $env:STORYHOLD_LOCAL_RERANKER_MODEL
} else {
  "BAAI/bge-reranker-v2-m3"
}
$nliModel = if ($env:STORYHOLD_LOCAL_NLI_MODEL) {
  $env:STORYHOLD_LOCAL_NLI_MODEL
} else {
  "cross-encoder/nli-deberta-v3-xsmall"
}
$coreferenceModel = if ($env:STORYHOLD_LOCAL_COREFERENCE_MODEL) {
  $env:STORYHOLD_LOCAL_COREFERENCE_MODEL
} else {
  "biu-nlp/f-coref"
}
$qwenModel = if ($env:STORYHOLD_LOCAL_QWEN_MODEL) {
  $env:STORYHOLD_LOCAL_QWEN_MODEL
} else {
  "Qwen/Qwen3.5-4B-Instruct"
}
$qwenGgufPath = Join-Path $runtimeRoot "gguf\qwen3.5-4b-instruct-Q4_K_M.gguf"
$qwenRuntimeModel = if (Test-Path -LiteralPath $qwenGgufPath) { $qwenGgufPath } else { $qwenModel }
$device = if ($env:STORYHOLD_LOCAL_ACCELERATION) {
  $env:STORYHOLD_LOCAL_ACCELERATION
} else {
  "auto"
}
if (-not $env:STORYHOLD_LOCAL_QWEN_GPU_LAYERS) {
  $env:STORYHOLD_LOCAL_QWEN_GPU_LAYERS = "32"
}
if (-not $env:STORYHOLD_LOCAL_QWEN_BATCH_SIZE) {
  # Keep the logical prompt batch large, but split its physical compute work
  # below so llama.cpp does not request a single peak-sized Vulkan buffer.
  $env:STORYHOLD_LOCAL_QWEN_BATCH_SIZE = "512"
}
if (-not $env:STORYHOLD_LOCAL_QWEN_MICRO_BATCH_SIZE) {
  # A 128-token micro-batch keeps the same model, context, and evidence. It
  # trades some prompt-ingestion speed for reliable headroom on the 4 GB GPU.
  $env:STORYHOLD_LOCAL_QWEN_MICRO_BATCH_SIZE = "128"
}
if (-not $env:STORYHOLD_LOCAL_QWEN_OFFLOAD_KQV) {
  $env:STORYHOLD_LOCAL_QWEN_OFFLOAD_KQV = "true"
}
if (-not $env:STORYHOLD_LOCAL_QWEN_VULKAN_DEVICE) {
  $env:STORYHOLD_LOCAL_QWEN_VULKAN_DEVICE = "1"
}
# The official Vulkan llama.cpp wheel sees the Intel iGPU as device 0 on this
# laptop. Constrain Qwen to the RTX 3050 without changing any of the CUDA-backed
# PyTorch stages that run before it.
$env:GGML_VK_VISIBLE_DEVICES = $env:STORYHOLD_LOCAL_QWEN_VULKAN_DEVICE

function Get-GlinerHealth {
  try {
    return Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
  } catch {
    return $null
  }
}

function Test-GlinerReady {
  $response = Get-GlinerHealth
  $supervisorReady = $null -ne $response `
    -and $response.status -eq "ready" `
    -and $response.service -eq "storyhold-lorekeeper-local" `
    -and $response.sequential -eq $true `
    -and $response.processIsolation -eq $true `
    -and $response.maximumResidentWorkers -eq 1
  if (-not $supervisorReady) { return $false }
  foreach ($stage in @("gliner2", "minilm", "bge", "nli", "coreference", "qwen")) {
    $component = $response.components.$stage
    if ($null -eq $component) { return $false }
    # Memory-blocked readers still belong to this live supervisor. Do not start
    # another Python just because its next model cannot currently be loaded.
    if ($null -ne $component.PSObject.Properties["configured"]) {
      if ($component.configured -ne $true) { return $false }
    } elseif ($component.ready -ne $true) {
      return $false
    }
  }
  return $true
}

function Save-SupervisorPid {
  $health = Get-GlinerHealth
  $supervisorPid = if ($null -ne $health) { [int]$health.supervisorPid } else { 0 }
  if ($supervisorPid -gt 0) {
    [System.IO.File]::WriteAllText($pidPath, [string]$supervisorPid)
  }
}

$hashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
try {
  $repoHash = ([System.BitConverter]::ToString(
    $hashAlgorithm.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($repoRoot.ToLowerInvariant()))
  )).Replace("-", "").Substring(0, 16)
} finally {
  $hashAlgorithm.Dispose()
}
$launcherMutex = [System.Threading.Mutex]::new($false, "Local\StoryholdLorekeeper-$repoHash")
$launcherLockTaken = $false
try {
  try {
    $launcherLockTaken = $launcherMutex.WaitOne([TimeSpan]::FromMinutes(15))
  } catch [System.Threading.AbandonedMutexException] {
    $launcherLockTaken = $true
  }
  if (-not $launcherLockTaken) {
    throw "Another Storyhold Lorekeeper launcher did not finish within 15 minutes."
  }

  if (Test-GlinerReady) {
    Save-SupervisorPid
    Write-Host "Storyhold's sequential Lorekeeper readers are already ready."
    exit 0
  }

  # A model process can take several minutes to load while /health is not yet
  # responsive. Reuse that recorded process instead of starting another Python
  # copy and exhausting memory.
  if (Test-Path -LiteralPath $pidPath) {
    $recordedPid = 0
    [void][int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$recordedPid)
    $recordedProcess = if ($recordedPid -gt 0) {
      Get-Process -Id $recordedPid -ErrorAction SilentlyContinue
    } else {
      $null
    }
    if (
      $recordedProcess `
      -and $recordedProcess.ProcessName -eq "python" `
      -and $recordedProcess.Path -eq $pythonPath
    ) {
      Write-Host "Storyhold's Lorekeeper process is already starting. Waiting for its readers instead of launching another copy."
      foreach ($attempt in 1..600) {
        if (Test-GlinerReady) {
          Save-SupervisorPid
          Write-Host "Storyhold's baseline companion readers, coreference, NLI, MiniLM, BGE, and Qwen are ready to run sequentially."
          exit 0
        }
        if ($recordedProcess.HasExited) { break }
        Start-Sleep -Milliseconds 500
      }
      if (-not $recordedProcess.HasExited) {
        throw "The existing Storyhold Lorekeeper process is still running but did not become ready. Inspect $stderrPath before restarting it."
      }
    }
  }

  if (Test-Path -LiteralPath $pythonPath) {
    # Check installed package metadata without importing PyTorch and reserving
    # model-runtime memory in a throwaway process before the supervisor starts.
    & $pythonPath -B -c "import importlib.util; raise SystemExit(0 if all(importlib.util.find_spec(name) is not None for name in ('gliner2', 'fastcoref')) else 1)" 2>$null
    $runtimeAvailable = $LASTEXITCODE -eq 0
  } else {
    $runtimeAvailable = $false
  }

  if (-not $runtimeAvailable) {
    throw "Storyhold's full local intake stack is not installed. Run scripts\install-storyhold-gliner.ps1 once from an internet-enabled terminal."
  }

New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
New-Item -ItemType Directory -Path $modelCache -Force | Out-Null
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null

# Some Windows hosts expose both Path and PATH. Start-Process treats those as
# the same key, so normalize only this launcher process before starting Python.
$cleanPath = [System.Environment]::GetEnvironmentVariable("Path", "Process")
[System.Environment]::SetEnvironmentVariable("PATH", $null, "Process")
[System.Environment]::SetEnvironmentVariable("Path", $cleanPath, "Process")
$env:HF_HUB_OFFLINE = "1"
$env:TRANSFORMERS_OFFLINE = "1"
$env:HF_HUB_DISABLE_TELEMETRY = "1"
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
$env:STORYHOLD_CUDA_STATUS_PATH = $cudaStatusPath

  $process = Start-Process -FilePath $pythonPath `
  -ArgumentList @($serviceScript, "--host", "127.0.0.1", "--port", "8765", "--gliner2-model", $gliner2Model, "--minilm-model", $miniLmModel, "--bge-model", $bgeModel, "--nli-model", $nliModel, "--coreference-model", $coreferenceModel, "--qwen-model", $qwenRuntimeModel, "--device", $device, "--cache-dir", $modelCache) `
  -WorkingDirectory $repoRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -PassThru
  [System.IO.File]::WriteAllText($pidPath, [string]$process.Id)

  foreach ($attempt in 1..600) {
    if (Test-GlinerReady) {
      Save-SupervisorPid
      Write-Host "Storyhold's baseline companion readers, coreference, NLI, MiniLM, BGE, and Qwen are ready to run sequentially."
      exit 0
    }
    if ($process.HasExited) {
      $details = if (Test-Path -LiteralPath $stderrPath) {
        Get-Content -LiteralPath $stderrPath -Raw
      } else {
        "No GLiNER error log was created."
      }
      throw "Storyhold's local Lorekeeper service stopped during startup.`n$details"
    }
    Start-Sleep -Milliseconds 500
  }

  throw "Storyhold's local Lorekeeper service took too long to start. Inspect $stderrPath"
} finally {
  if ($launcherLockTaken) {
    $launcherMutex.ReleaseMutex()
  }
  $launcherMutex.Dispose()
}

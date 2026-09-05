$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $repoRoot ".storyhold-runtime\gliner"
$venvRoot = Join-Path $runtimeRoot "venv"
$pythonPath = Join-Path $venvRoot "Scripts\python.exe"
$modelCache = Join-Path $runtimeRoot "models"
$serviceScript = Join-Path $PSScriptRoot "gliner-service.py"
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
$qwenGgufRoot = Join-Path $runtimeRoot "gguf"
$qwenGgufPath = Join-Path $qwenGgufRoot "qwen3.5-4b-instruct-Q4_K_M.gguf"
$qwenGgufSha256 = "2e3c607324e016a3f59bced47a5fa411330f1a252d18ad0237caded161f12b45"
$device = if ($env:STORYHOLD_LOCAL_ACCELERATION) {
  $env:STORYHOLD_LOCAL_ACCELERATION
} else {
  "auto"
}
$fastCorefCommit = "ae224139196d122b225af5a7e73b5fc0b6e1076d"

New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
New-Item -ItemType Directory -Path $modelCache -Force | Out-Null
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

if (-not (Test-Path -LiteralPath $pythonPath)) {
  $systemPython = (Get-Command python.exe -ErrorAction Stop).Source
  Write-Host "Preparing Storyhold's isolated GLiNER environment..."
  & $systemPython -m venv $venvRoot
  if ($LASTEXITCODE -ne 0) { throw "Python could not create Storyhold's GLiNER environment." }
}

Write-Host "Installing the pinned GLiNER2 runtime..."
& $pythonPath -m pip install --disable-pip-version-check "gliner2[local]==1.3.2"
if ($LASTEXITCODE -ne 0) { throw "The GLiNER2 runtime could not be downloaded and installed." }

& $pythonPath -m pip install --disable-pip-version-check "sentencepiece==0.2.1"
if ($LASTEXITCODE -ne 0) { throw "The Lorekeeper pair-model tokenizer could not be installed." }

& $pythonPath -m pip install --disable-pip-version-check "pillow>=11,<13" "torchvision>=0.28,<0.29"
if ($LASTEXITCODE -ne 0) { throw "Qwen's official local processor dependencies could not be installed." }

& $pythonPath -m pip install --disable-pip-version-check `
  --extra-index-url "https://abetlen.github.io/llama-cpp-python/whl/cpu" `
  "llama-cpp-python==0.3.35"
if ($LASTEXITCODE -ne 0) { throw "Qwen's quantized CPU runtime could not be installed." }

New-Item -ItemType Directory -Path $qwenGgufRoot -Force | Out-Null
& $pythonPath -c "from huggingface_hub import hf_hub_download; hf_hub_download(repo_id='openresearchtools/Qwen3.5-4B-Instruct-GGUF', filename='qwen3.5-4b-instruct-Q4_K_M.gguf', local_dir=r'$qwenGgufRoot')"
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $qwenGgufPath)) {
  throw "The quantized Qwen 3.5 model could not be downloaded."
}
$downloadedHash = (Get-FileHash -LiteralPath $qwenGgufPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($downloadedHash -ne $qwenGgufSha256) {
  throw "The downloaded Qwen 3.5 model did not match its published SHA-256 checksum."
}

Write-Host "Installing Storyhold's pinned local fiction-reference resolver..."
& $pythonPath -m pip install --disable-pip-version-check `
  "scipy==1.18.1" "spacy==3.8.15" "datasets==5.0.1" `
  "wandb==0.28.2" "pandas==3.0.5" "protobuf==7.36.0"
if ($LASTEXITCODE -ne 0) { throw "The local coreference dependencies could not be installed." }
& $pythonPath -m pip install --disable-pip-version-check --no-deps `
  "https://github.com/shon-otmazgin/fastcoref/archive/$fastCorefCommit.zip"
if ($LASTEXITCODE -ne 0) { throw "The pinned FastCoref runtime could not be installed." }

Write-Host "Downloading and validating Storyhold's local specialist models..."
& $pythonPath $serviceScript --download-only --gliner2-model $gliner2Model --minilm-model $miniLmModel --bge-model $bgeModel --nli-model $nliModel --coreference-model $coreferenceModel --qwen-model $qwenGgufPath --device $device --cache-dir $modelCache
if ($LASTEXITCODE -ne 0) { throw "One or more Lorekeeper specialist models could not be downloaded or loaded." }

Write-Host "Storyhold's sequential GLiNER2, coreference, NLI, MiniLM, BGE, and Qwen intake stack is installed."

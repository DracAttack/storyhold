[CmdletBinding()]
param(
  [ValidateRange(1, 10000)]
  [int]$MaxSteps = 80,
  [switch]$ValidateOnly,
  [switch]$AllowLowMemory
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$pythonPath = Join-Path $repoRoot ".storyhold-runtime\gliner\venv\Scripts\python.exe"
$trainerPath = Join-Path $repoRoot "training\train_qwen.py"
$trainPath = Join-Path $repoRoot "training\data\qwen-storyhold-v1-train.jsonl"
$evalPath = Join-Path $repoRoot "training\data\qwen-storyhold-v1-eval.jsonl"
$outputPath = Join-Path $repoRoot ".storyhold-training-runs\qwen-storyhold-v1"

if (-not (Test-Path -LiteralPath $pythonPath)) {
  throw "Storyhold's isolated local-model environment is missing. Run scripts\install-storyhold-gliner.ps1 first."
}

$arguments = @(
  $trainerPath,
  "--repo-root", $repoRoot,
  "--train", $trainPath,
  "--eval", $evalPath,
  "--output", $outputPath,
  "--max-steps", [string]$MaxSteps
)
if ($ValidateOnly) { $arguments += "--validate-only" }
if ($AllowLowMemory) { $arguments += "--allow-low-memory" }

& $pythonPath @arguments
if ($LASTEXITCODE -ne 0) { throw "Storyhold Qwen adapter training failed with exit code $LASTEXITCODE." }

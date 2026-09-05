"""Benchmark one isolated Qwen GGUF load at a requested GPU offload level."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from typing import Any

import llama_cpp
from llama_cpp import Llama


def gpu_memory_mebibytes() -> int | None:
    try:
        completed = subprocess.run(
            [
                "nvidia-smi.exe",
                "--query-gpu=memory.used",
                "--format=csv,noheader,nounits",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return int(completed.stdout.splitlines()[0].strip())
    except (FileNotFoundError, IndexError, ValueError, subprocess.SubprocessError):
        return None


parser = argparse.ArgumentParser()
parser.add_argument("--model", required=True)
parser.add_argument("--layers", type=int, required=True)
parser.add_argument("--context", type=int, default=16_384)
parser.add_argument(
    "--batch-size",
    type=int,
    default=int(os.environ.get("STORYHOLD_LOCAL_QWEN_BATCH_SIZE", "512")),
)
parser.add_argument(
    "--micro-batch-size",
    type=int,
    default=int(os.environ.get("STORYHOLD_LOCAL_QWEN_MICRO_BATCH_SIZE", "128")),
)
parser.add_argument(
    "--cpu-kqv",
    action="store_true",
    help="Keep K/Q/V compute on CPU for extra VRAM headroom (slower, same model quality).",
)
parser.add_argument("--output", type=int, default=64)
args = parser.parse_args()
batch_size = max(32, min(512, args.batch_size))
micro_batch_size = max(16, min(batch_size, args.micro_batch_size))

if not os.path.isfile(args.model):
    raise SystemExit(f"Qwen GGUF not found: {args.model}")
if not llama_cpp.llama_supports_gpu_offload():
    raise SystemExit("The installed llama.cpp runtime does not support GPU offload.")

memory_before = gpu_memory_mebibytes()
load_started = time.monotonic()
model = Llama(
    model_path=args.model,
    n_ctx=args.context,
    n_batch=batch_size,
    n_ubatch=micro_batch_size,
    n_threads=max(1, min(8, os.cpu_count() or 4)),
    n_threads_batch=max(1, min(8, os.cpu_count() or 4)),
    n_gpu_layers=args.layers,
    offload_kqv=not args.cpu_kqv,
    verbose=False,
)
load_ms = round((time.monotonic() - load_started) * 1_000)
memory_loaded = gpu_memory_mebibytes()

prompt = (
    "Use only this evidence. Return JSON with summary and confidence. "
    "Evidence: Alec dragged Lilly clear of the attackers and stood between "
    "Michael and the gunfire. Describe Alec as a person, never as an extraction process."
)
infer_started = time.monotonic()
completion: dict[str, Any] = model.create_chat_completion(
    messages=[{"role": "user", "content": prompt}],
    max_tokens=args.output,
    temperature=0.0,
    seed=101,
    response_format={"type": "json_object"},
)
inference_ms = round((time.monotonic() - infer_started) * 1_000)
usage = completion.get("usage", {})
output_tokens = int(usage.get("completion_tokens", 0))
text = str(completion["choices"][0]["message"]["content"] or "").strip()
system_info = llama_cpp.llama_print_system_info()
if isinstance(system_info, bytes):
    system_info = system_info.decode("utf-8", "replace")

print(json.dumps({
    "layers": args.layers,
    "context": args.context,
    "batchSize": batch_size,
    "microBatchSize": micro_batch_size,
    "offloadKqv": not args.cpu_kqv,
    "loadMilliseconds": load_ms,
    "inferenceMilliseconds": inference_ms,
    "inputTokens": int(usage.get("prompt_tokens", 0)),
    "outputTokens": output_tokens,
    "outputTokensPerSecond": round(output_tokens / max(0.001, inference_ms / 1_000), 3),
    "gpuMemoryBeforeMiB": memory_before,
    "gpuMemoryLoadedMiB": memory_loaded,
    "gpuMemoryDeltaMiB": (
        memory_loaded - memory_before
        if memory_before is not None and memory_loaded is not None
        else None
    ),
    "gpuOffloadSupported": bool(llama_cpp.llama_supports_gpu_offload()),
    "systemInfo": str(system_info),
    "text": text,
}))

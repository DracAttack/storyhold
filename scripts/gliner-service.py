"""Loopback-only Lorekeeper specialist service managed by Storyhold."""

from __future__ import annotations

import argparse
import ctypes
import gc
import importlib.util
import json
import multiprocessing
import os
import select
import socket
import sys
import threading
import time
import traceback
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from contextlib import contextmanager
from typing import Any


MAX_REQUEST_BYTES = 2_500_000
MAX_TEXT_CHARACTERS = 20_000
MAX_LABELS = 64
MAX_RERANK_CANDIDATES = 800
MAX_NLI_PAIRS = 160
MAX_COREFERENCE_DOCUMENTS = 32
MAX_QWEN_PROMPT_CHARACTERS = 32_000
MAX_QWEN_OUTPUT_TOKENS = 2_400
MAX_QWEN_CLASSIFICATION_PROMPTS = 40

QWEN_LLAMA_CONTEXT_TOKENS = 16_384
QWEN_LLAMA_DEFAULT_BATCH_TOKENS = 512
QWEN_LLAMA_DEFAULT_MICRO_BATCH_TOKENS = 128
WINDOWS_CPP_EXCEPTION = 0xE06D7363


class LocalRequestError(RuntimeError):
    """A bounded local request cannot safely start or continue."""


def worker_exception_message(error: BaseException) -> str:
    # GLiNER2 tries an optional .bin after ANY safetensors exception. Keep the
    # original Windows allocation error instead of reporting a missing model.
    chain: list[str] = []
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen and len(chain) < 8:
        seen.add(id(current))
        chain.append(f"{type(current).__name__}: {current}")
        current = current.__cause__ or current.__context__
    for message in chain:
        if any(marker in message.lower() for marker in ("1455", "paging file", "pagefile", "commit limit")):
            return " ".join(message.split())[:700]
    return " | Caused by: ".join(" ".join(item.split()) for item in chain)[:700]


def can_retry_on_cpu(error: BaseException) -> bool:
    message = worker_exception_message(error).lower()
    if any(marker in message for marker in ("1455", "paging file", "pagefile", "commit limit", "localentrynotfound", "filenotfound", "cannot find")):
        return False
    return ("cuda" in message or "vulkan" in message) and any(
        marker in message for marker in ("out of memory", "allocation", "not available", "not compiled", "no kernel image")
    )


def bounded_environment_integer(
    name: str,
    default: int,
    minimum: int,
    maximum: int,
) -> int:
    try:
        value = int(os.environ.get(name, str(default)) or default)
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


def environment_boolean(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None or not value.strip():
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def qwen_llama_context_settings() -> dict[str, Any]:
    """Return bounded, quality-neutral llama.cpp memory settings.

    The model and 16K context stay unchanged. A smaller physical micro-batch
    subdivides the same logical prompt batch and trades some prompt-ingestion
    speed for a substantially smaller transient Vulkan compute buffer, which
    is important on a 4 GB GPU.
    Operators can additionally keep K/Q/V work on CPU if a shared display GPU
    needs more headroom; that affects speed and placement, never model quality.
    """
    batch_tokens = bounded_environment_integer(
        "STORYHOLD_LOCAL_QWEN_BATCH_SIZE",
        QWEN_LLAMA_DEFAULT_BATCH_TOKENS,
        32,
        512,
    )
    micro_batch_tokens = min(
        batch_tokens,
        bounded_environment_integer(
            "STORYHOLD_LOCAL_QWEN_MICRO_BATCH_SIZE",
            QWEN_LLAMA_DEFAULT_MICRO_BATCH_TOKENS,
            16,
            512,
        ),
    )
    return {
        "n_ctx": QWEN_LLAMA_CONTEXT_TOKENS,
        "n_batch": batch_tokens,
        "n_ubatch": micro_batch_tokens,
        "offload_kqv": environment_boolean(
            "STORYHOLD_LOCAL_QWEN_OFFLOAD_KQV",
            True,
        ),
    }


def worker_failure_record(
    stage: str | None,
    pid: int | None,
    exit_code: int | None,
    message: str,
) -> dict[str, Any]:
    clean_message = " ".join(str(message or "").split())[:700]
    lowered = clean_message.lower()
    native_exit_code = (
        exit_code & 0xFFFFFFFF
        if isinstance(exit_code, int) and os.name == "nt"
        else None
    )
    explicit_gpu_oom = any(marker in lowered for marker in (
        "out of memory",
        "failed to allocate",
        "allocation failed",
        "cannot allocate",
        "erroroutofdevicememory",
        "vk_error_out_of_device_memory",
    )) or (
        "allocation" in lowered and
        ("failed" in lowered or "failure" in lowered)
    )
    native_qwen_gpu_failure = (
        stage == "qwen" and (
            native_exit_code == WINDOWS_CPP_EXCEPTION or
            "0xe06d7363" in lowered or
            "-529697949" in lowered
        )
    )
    if any(marker in lowered for marker in ("1455", "paging file", "pagefile", "commit limit", "system commit")):
        kind = "system_memory_exhausted"
        diagnostic = clean_message
    elif "localentrynotfound" in lowered or "filenotfound" in lowered:
        kind = "model_files_unavailable"
        diagnostic = clean_message
    elif explicit_gpu_oom:
        kind = "gpu_out_of_memory"
        diagnostic = (
            clean_message or
            "The Qwen worker reported a GPU memory allocation failure."
        )
    elif native_qwen_gpu_failure:
        kind = "gpu_memory_or_native_backend_failure"
        diagnostic = (
            "The Qwen Vulkan worker terminated during inference with Windows "
            "native exception 0xe06d7363. On this 4 GB profile, the observed "
            "cause is typically a failed llama.cpp GPU allocation; inspect the "
            "Lorekeeper worker log immediately before this event for the exact "
            "allocation message."
        )
    else:
        kind = "worker_failure"
        diagnostic = clean_message or "The isolated model worker exited unexpectedly."
    record: dict[str, Any] = {
        "stage": stage,
        "pid": pid,
        "exitCode": exit_code,
        "kind": kind,
        "message": diagnostic,
    }
    if native_exit_code is not None and native_exit_code > 255:
        record["nativeExitCode"] = f"0x{native_exit_code:08x}"
    return record

PASSAGE_KINDS = {
    "dialogue": "Spoken conversation or quoted speech between characters",
    "action": "A character or creature explicitly performs an action",
    "setting description": "Description of a place, environment, structure, or atmosphere",
    "character description": "Description of a character's appearance, traits, capability, or condition",
    "relationship statement": "A literal, former, disputed, or figurative relationship is described",
    "secret revelation": "Hidden information is revealed or described as secret",
    "chronology marker": "A date, duration, flashback, time jump, before/after relation, or era is stated",
    "rule or constraint": "A durable rule, limitation, law, lifecycle, power condition, or world constraint is stated",
    "belief or rumor": "A belief, assumption, lie, rumor, interpretation, or limited point of view is expressed",
    "figurative language": "Metaphor, analogy, title, affectionate kinship, or other non-literal wording appears",
}

TRUTH_MODES = [
    "fact", "belief", "rumor", "lie", "disputed", "unknown", "figurative",
]

CHANGE_TYPES = [
    "injury", "death", "possession", "location", "relationship", "membership",
    "title", "knowledge", "secret", "promise", "goal", "identity", "status",
]


def json_safe_entity(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    text = str(value.get("text", "")).strip()
    label = str(value.get("label", "")).strip()
    if not text or not label:
        return {}
    try:
        score = float(value.get("confidence", value.get("score", 0.0)))
    except (TypeError, ValueError):
        score = 0.0
    try:
        start = int(value.get("start", -1))
        end = int(value.get("end", start + len(text)))
    except (TypeError, ValueError):
        start = -1
        end = -1
    return {
        "text": text,
        "label": label,
        "score": max(0.0, min(1.0, score)),
        "start": start,
        "end": end,
    }


def configured_cuda_stages() -> set[str]:
    configured = os.environ.get(
        "STORYHOLD_LOCAL_CUDA_STAGES",
        "gliner2,coreference,nli,minilm,bge",
    )
    return {
        stage.strip().lower()
        for stage in configured.split(",")
        if stage.strip()
    }


def local_device(requested: str, stage: str) -> str:
    # Qwen's GGUF runtime has its own layer-offload switch. The PyTorch
    # specialists use this stage allow-list so a small laptop GPU can be used
    # without accidentally trying to hold an unsuitable model in VRAM.
    if stage == "qwen":
        if requested != "auto":
            return requested
        try:
            configured_layers = int(
                os.environ.get("STORYHOLD_LOCAL_QWEN_GPU_LAYERS", "0") or 0
            )
        except ValueError:
            configured_layers = 0
        # Do not import PyTorch before llama.cpp here. On this hybrid-graphics
        # Windows laptop, initializing CUDA first changes Vulkan enumeration
        # and causes llama.cpp's device selector to resolve to the Intel iGPU.
        return "cuda" if configured_layers != 0 else "cpu"
    if stage != "qwen" and stage not in configured_cuda_stages():
        return "cpu"
    if requested != "auto":
        return requested
    # CPU execution needs the same framework import. Retrying a failed import
    # on CPU only duplicates allocation/cache failures and hides their cause.
    import torch
    return "cuda" if torch.cuda.is_available() else "cpu"


def cuda_capability() -> dict[str, Any]:
    # The supervisor must stay lightweight. Importing PyTorch here caused every
    # harmless /health poll to make the long-lived parent retain roughly 1.3 GB
    # of committed memory before a model worker even started. The CUDA setup
    # script already writes a verified, immutable capability snapshot, so serve
    # that instead and leave all framework imports inside disposable workers.
    status_path = os.environ.get("STORYHOLD_CUDA_STATUS_PATH", "").strip()
    if status_path:
        try:
            # PowerShell's JSON writer may include a UTF-8 BOM; utf-8-sig
            # accepts both BOM and ordinary UTF-8 snapshots.
            with open(status_path, "r", encoding="utf-8-sig") as status_file:
                status = json.load(status_file)
            accelerator = str(status.get("accelerator", "")).strip().lower()
            return {
                "available": accelerator == "cuda",
                "deviceCount": 1 if accelerator == "cuda" else 0,
                "name": str(status.get("device", "")),
                "totalMemoryBytes": int(status.get("totalMemoryBytes", 0) or 0),
                "torchVersion": str(status.get("torchVersion", "")),
                "runtimeVersion": str(status.get("cudaRuntime", "")),
                "verifiedAt": str(status.get("installedAt", "")),
                "source": "verified-local-snapshot",
            }
        except (OSError, TypeError, ValueError, json.JSONDecodeError) as error:
            return {
                "available": False,
                "error": f"CUDA capability snapshot could not be read: {type(error).__name__}",
                "source": "verified-local-snapshot",
            }

    # Direct development launches may omit the verified status path. Report an
    # unknown capability without importing a multi-gigabyte runtime into the
    # supervisor; the requested stage worker still performs the authoritative
    # device check when it starts.
    return {
        "available": False,
        "error": "No verified CUDA capability snapshot was configured.",
        "source": "unconfigured",
    }


def legacy_cuda_capability_for_diagnostics() -> dict[str, Any]:
    """Framework probe retained only for explicit one-shot diagnostics.

    Normal service health must never call this function. Keeping it named and
    isolated makes the expensive behavior available to diagnostic scripts while
    preventing an accidental regression back into the long-lived supervisor.
    """
    try:
        import torch
        available = bool(torch.cuda.is_available())
        if not available:
            return {
                "available": False,
                "torchVersion": str(torch.__version__),
                "runtimeVersion": str(torch.version.cuda or ""),
            }
        properties = torch.cuda.get_device_properties(0)
        return {
            "available": True,
            "deviceCount": int(torch.cuda.device_count()),
            "name": str(properties.name),
            "totalMemoryBytes": int(properties.total_memory),
            "torchVersion": str(torch.__version__),
            "runtimeVersion": str(torch.version.cuda or ""),
        }
    except Exception as error:
        return {"available": False, "error": f"{type(error).__name__}: {str(error)[:240]}"}


def system_memory_status() -> dict[str, Any]:
    """Return lightweight Windows memory/commit headroom for diagnostics."""
    if os.name != "nt":
        return {"available": False, "reason": "Windows memory counters are not available."}

    class MemoryStatusEx(ctypes.Structure):
        _fields_ = [
            ("length", ctypes.c_ulong),
            ("memoryLoadPercent", ctypes.c_ulong),
            ("totalPhysicalBytes", ctypes.c_ulonglong),
            ("availablePhysicalBytes", ctypes.c_ulonglong),
            ("totalCommitBytes", ctypes.c_ulonglong),
            ("availableCommitBytes", ctypes.c_ulonglong),
            ("totalVirtualBytes", ctypes.c_ulonglong),
            ("availableVirtualBytes", ctypes.c_ulonglong),
            ("availableExtendedVirtualBytes", ctypes.c_ulonglong),
        ]

    status = MemoryStatusEx()
    status.length = ctypes.sizeof(MemoryStatusEx)
    try:
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return {"available": False, "reason": "GlobalMemoryStatusEx failed."}
    except (AttributeError, OSError) as error:
        return {"available": False, "reason": f"{type(error).__name__}: {str(error)[:160]}"}
    return {
        "available": True,
        "memoryLoadPercent": int(status.memoryLoadPercent),
        "totalPhysicalBytes": int(status.totalPhysicalBytes),
        "availablePhysicalBytes": int(status.availablePhysicalBytes),
        # On Windows these page-file fields represent the system commit limit
        # and its remaining headroom, which is the key signal for large model
        # activation—not merely the size of pagefile.sys.
        "totalCommitBytes": int(status.totalCommitBytes),
        "availableCommitBytes": int(status.availableCommitBytes),
    }


def load_gliner2_model(model_name: str, cache_dir: str, device: str):
    os.environ.setdefault("HF_HOME", cache_dir)
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", os.path.join(cache_dir, "hub"))
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    from gliner2 import GLiNER2  # Imported after cache variables are established.

    return GLiNER2.from_pretrained(model_name, map_location=device)


def load_gliner1_model(model_name: str, cache_dir: str, device: str):
    os.environ.setdefault("HF_HOME", cache_dir)
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", os.path.join(cache_dir, "hub"))
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    from gliner import GLiNER

    return GLiNER.from_pretrained(
        model_name,
        cache_dir=cache_dir,
        map_location=device,
        local_files_only=os.environ.get("HF_HUB_OFFLINE") == "1",
    )


def load_pair_classifier(model_name: str, cache_dir: str, device: str):
    os.environ.setdefault("HF_HOME", cache_dir)
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", os.path.join(cache_dir, "hub"))
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(model_name, cache_dir=cache_dir)
    load_options: dict[str, Any] = {
        "cache_dir": cache_dir,
        "local_files_only": os.environ.get("HF_HUB_OFFLINE") == "1",
        # Stream checkpoint shards into their destination instead of building a
        # full second CPU copy before transfer. This materially lowers BGE's
        # peak RAM/commit demand while keeping the exact same model and dtype.
        "low_cpu_mem_usage": True,
    }
    if device == "cuda":
        load_options["dtype"] = torch.float16
        load_options["device_map"] = {"": "cuda:0"}
    model = AutoModelForSequenceClassification.from_pretrained(
        model_name,
        **load_options,
    )
    if device != "cuda":
        model.to(device)
    model.eval()
    return tokenizer, model, device


def load_coreference_model(model_name: str, cache_dir: str, device: str):
    os.environ.setdefault("HF_HOME", cache_dir)
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", os.path.join(cache_dir, "hub"))
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    import spacy
    from fastcoref import FCoref

    return FCoref(
        model_name_or_path=model_name,
        device=device,
        nlp=spacy.blank("en"),
        enable_progress_bar=False,
    )


def load_qwen_model(model_name: str, cache_dir: str, device: str):
    """Load the official Qwen text-capable multimodal checkpoint.

    Qwen 3.5's Hugging Face checkpoint uses AutoProcessor and
    AutoModelForMultimodalLM even for text-only prompts. Keeping the processor
    and model inside the disposable stage worker gives Qwen the same strict
    one-resident-model guarantee as every other Lorekeeper specialist.
    """
    if model_name.lower().endswith(".gguf"):
        if not os.path.isfile(model_name):
            raise RuntimeError(f"The configured Qwen GGUF file does not exist: {model_name}")
        # Windows' multiprocessing spawn preserved Storyhold's configuration
        # but did not reliably carry llama.cpp's backend-specific selector into
        # the disposable worker. Re-apply it immediately before importing the
        # Vulkan runtime so device 1 is the RTX 3050 rather than the Intel iGPU.
        vulkan_device = os.environ.get("STORYHOLD_LOCAL_QWEN_VULKAN_DEVICE", "").strip()
        if vulkan_device:
            os.environ["GGML_VK_VISIBLE_DEVICES"] = vulkan_device
        print(
            f"[lorekeeper:{os.getpid()}] Qwen Vulkan selector: "
            f"{os.environ.get('GGML_VK_VISIBLE_DEVICES', '<unset>')}",
            flush=True,
        )
        import llama_cpp
        from llama_cpp import Llama

        supports_gpu_offload = bool(
            hasattr(llama_cpp, "llama_supports_gpu_offload")
            and llama_cpp.llama_supports_gpu_offload()
        )
        try:
            requested_layers = int(os.environ.get("STORYHOLD_LOCAL_QWEN_GPU_LAYERS", "0") or 0)
        except ValueError:
            requested_layers = 0
        gpu_layers = requested_layers if device == "cuda" and supports_gpu_offload else 0
        system_info = llama_cpp.llama_print_system_info()
        if isinstance(system_info, bytes):
            system_info = system_info.decode("utf-8", "replace")
        normalized_system_info = str(system_info).lower()
        gpu_backend = (
            "vulkan" if "vulkan" in normalized_system_info
            else "cuda" if "cuda" in normalized_system_info
            else "gpu"
        )
        context_settings = qwen_llama_context_settings()
        print(
            f"[lorekeeper:{os.getpid()}] Qwen llama.cpp memory profile: "
            f"context={context_settings['n_ctx']}, "
            f"batch={context_settings['n_batch']}, "
            f"micro-batch={context_settings['n_ubatch']}, "
            f"GPU K/Q/V={'on' if context_settings['offload_kqv'] else 'off'}, "
            f"GPU layers={gpu_layers}.",
            flush=True,
        )

        return {
            "runtime": "llama.cpp",
            "model": Llama(
                model_path=model_name,
                # Full local dossiers carry dozens of ranked manuscript
                # excerpts plus room for a complete structured response.
                # Sixteen thousand tokens keeps the evidence and the answer
                # in one pass without loading a second model process.
                n_ctx=context_settings["n_ctx"],
                # Conservative batching keeps the same model, evidence window,
                # and maximum layer offload while shrinking transient Vulkan
                # decode buffers. The cost is slower prompt ingestion; output
                # quality and token generation settings are unchanged.
                n_batch=context_settings["n_batch"],
                n_ubatch=context_settings["n_ubatch"],
                n_threads=max(1, min(8, os.cpu_count() or 4)),
                n_threads_batch=max(1, min(8, os.cpu_count() or 4)),
                n_gpu_layers=gpu_layers,
                offload_kqv=context_settings["offload_kqv"],
                verbose=False,
            ),
            "device": gpu_backend if gpu_layers != 0 else "cpu",
            "gpuLayers": gpu_layers,
            "gpuOffloadSupported": supports_gpu_offload,
            "gpuBackend": gpu_backend if supports_gpu_offload else None,
            "contextSettings": context_settings,
        }

    os.environ.setdefault("HF_HOME", cache_dir)
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", os.path.join(cache_dir, "hub"))
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    import torch
    from transformers import AutoModelForMultimodalLM, AutoProcessor

    offline = os.environ.get("HF_HUB_OFFLINE") == "1"
    processor = AutoProcessor.from_pretrained(
        model_name,
        cache_dir=cache_dir,
        local_files_only=offline,
    )
    model = AutoModelForMultimodalLM.from_pretrained(
        model_name,
        cache_dir=cache_dir,
        local_files_only=offline,
        dtype="auto",
        low_cpu_mem_usage=True,
    )
    model.to(device)
    model.eval()
    return {
        "runtime": "transformers",
        "processor": processor,
        "model": model,
        "device": device,
        "torch": torch,
    }


def qwen_audit_with_model(
    loaded: Any,
    prompt: str,
    maximum_output_tokens: int,
    seed: int,
    response_schema: dict[str, Any] | None = None,
    json_mode: bool = True,
) -> dict[str, Any]:
    if loaded["runtime"] == "llama.cpp":
        started_at = time.monotonic()
        response_format: dict[str, Any] = {"type": "json_object"}
        if response_schema:
            response_format["schema"] = response_schema
        completion_options: dict[str, Any] = {
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": maximum_output_tokens,
            "temperature": 0.0,
            "seed": seed,
        }
        if json_mode:
            # Machine-consumed audit passes use constrained JSON. Compact
            # dossier prose can opt into a line protocol that is more stable
            # on the smallest local checkpoint.
            completion_options["response_format"] = response_format
        completion = loaded["model"].create_chat_completion(**completion_options)
        text = str(completion["choices"][0]["message"]["content"] or "").strip()
        usage = completion.get("usage", {})
        return {
            "text": text,
            "inputTokens": int(usage.get("prompt_tokens", 0)),
            "outputTokens": int(usage.get("completion_tokens", 0)),
            "elapsedMilliseconds": max(0, round((time.monotonic() - started_at) * 1_000)),
            "device": loaded["device"],
            "runtime": loaded["runtime"],
        }
    processor = loaded["processor"]
    model = loaded["model"]
    device = loaded["device"]
    torch = loaded["torch"]
    messages = [{
        "role": "user",
        "content": [{"type": "text", "text": prompt}],
    }]
    inputs = processor.apply_chat_template(
        messages,
        add_generation_prompt=True,
        tokenize=True,
        return_dict=True,
        return_tensors="pt",
    )
    inputs = {key: value.to(device) for key, value in inputs.items()}
    input_tokens = int(inputs["input_ids"].shape[-1])
    torch.manual_seed(seed)
    started_at = time.monotonic()
    with torch.inference_mode():
        generated = model.generate(
            **inputs,
            max_new_tokens=maximum_output_tokens,
            do_sample=False,
            use_cache=True,
        )
    output_ids = generated[0][input_tokens:]
    text = processor.decode(output_ids, skip_special_tokens=True).strip()
    return {
        "text": text,
        "inputTokens": input_tokens,
        "outputTokens": int(output_ids.shape[-1]),
        "elapsedMilliseconds": max(0, round((time.monotonic() - started_at) * 1_000)),
        "device": device,
    }


def qwen_classify_with_model(
    loaded: Any,
    prompts: list[dict[str, Any]],
) -> dict[str, Any]:
    """Score compact audit verdicts without slow autoregressive JSON typing."""
    if loaded["runtime"] == "llama.cpp":
        started_at = time.monotonic()
        decisions: list[dict[str, Any]] = []
        input_tokens = 0
        output_tokens = 0
        label_codes = {
            "valid": "c",
            "noise": "x",
            "unknown": "u",
            "wrong": "r",
            "alias": "m",
        }
        for prompt in prompts:
            completion = loaded["model"].create_chat_completion(
                messages=[{"role": "user", "content": str(prompt["text"])}],
                max_tokens=3,
                temperature=0.0,
                seed=4_001 + int(prompt["index"]),
            )
            content = str(completion["choices"][0]["message"]["content"] or "").strip().lower()
            label = next((candidate for candidate in label_codes if content.startswith(candidate)), "unknown")
            usage = completion.get("usage", {})
            input_tokens += int(usage.get("prompt_tokens", 0))
            output_tokens += int(usage.get("completion_tokens", 0))
            decisions.append({
                "index": int(prompt["index"]),
                "code": label_codes[label],
                # Greedy constrained labels are useful local leads, but keep
                # their confidence below certainty and leave merge/category
                # application to evidence-complete verification.
                "confidence": 0.86 if label in {"valid", "noise"} else 0.74,
            })
        return {
            "decisions": decisions,
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "elapsedMilliseconds": max(0, round((time.monotonic() - started_at) * 1_000)),
            "device": loaded["device"],
            "runtime": loaded["runtime"],
        }
    processor = loaded["processor"]
    model = loaded["model"]
    device = loaded["device"]
    torch = loaded["torch"]
    tokenizer = processor.tokenizer
    choices = [
        ("c", "valid"),
        ("x", "noise"),
        ("u", "unknown"),
        ("r", "wrong"),
        ("m", "alias"),
    ]
    choice_token_ids: list[list[int]] = []
    for _, label in choices:
        variants = [
            tokenizer.encode(label, add_special_tokens=False),
            tokenizer.encode(f" {label}", add_special_tokens=False),
        ]
        token_ids = [int(tokens[0]) for tokens in variants if len(tokens) == 1]
        if not token_ids:
            raise RuntimeError(f"Qwen's audit label {label!r} has no single-token form.")
        choice_token_ids.append(list(dict.fromkeys(token_ids)))

    rendered: list[str] = []
    for prompt in prompts:
        rendered.append(tokenizer.apply_chat_template(
            [{"role": "user", "content": str(prompt["text"]) }],
            add_generation_prompt=True,
            tokenize=False,
        ))
    prior_padding_side = tokenizer.padding_side
    tokenizer.padding_side = "right"
    try:
        inputs = tokenizer(
            rendered,
            padding=True,
            truncation=True,
            max_length=2_048,
            return_tensors="pt",
        )
    finally:
        tokenizer.padding_side = prior_padding_side
    inputs = {key: value.to(device) for key, value in inputs.items()}
    lengths = inputs["attention_mask"].sum(dim=1).long() - 1
    started_at = time.monotonic()
    with torch.inference_mode():
        output = model(**inputs, return_dict=True)
        row_indexes = torch.arange(len(prompts), device=output.logits.device)
        next_logits = output.logits[row_indexes, lengths, :]
        choice_logits = torch.stack([
            next_logits[:, token_ids].float().max(dim=1).values
            for token_ids in choice_token_ids
        ], dim=1)
        probabilities = torch.softmax(choice_logits, dim=1)
        winning_probabilities, winning_indexes = probabilities.max(dim=1)
    decisions: list[dict[str, Any]] = []
    for prompt, winning_index, probability in zip(
        prompts,
        winning_indexes.tolist(),
        winning_probabilities.tolist(),
    ):
        decisions.append({
            "index": int(prompt["index"]),
            "code": choices[int(winning_index)][0],
            # Normalize the restricted-choice probability into a conservative
            # application confidence. A weak plurality stays below the 0.8
            # boundary used for automatic rejection.
            "confidence": max(0.0, min(0.95, 0.35 + float(probability) * 0.65)),
        })
    return {
        "decisions": decisions,
        "inputTokens": int(inputs["attention_mask"].sum().item()),
        "outputTokens": len(decisions),
        "elapsedMilliseconds": max(0, round((time.monotonic() - started_at) * 1_000)),
        "device": device,
    }


def coreference_with_model(
    model: Any,
    documents: list[dict[str, str]],
    max_tokens_in_batch: int,
) -> list[dict[str, Any]]:
    predictions = model.predict(
        texts=[document["text"] for document in documents],
        max_tokens_in_batch=max_tokens_in_batch,
    )
    results: list[dict[str, Any]] = []
    for document, prediction in zip(documents, predictions):
        clusters: list[dict[str, Any]] = []
        for cluster_index, spans in enumerate(prediction.get_clusters(as_strings=False)):
            mentions: list[dict[str, Any]] = []
            for start, end in spans:
                if start < 0 or end <= start or end > len(document["text"]):
                    continue
                mentions.append({
                    "start": int(start),
                    "end": int(end),
                    "text": document["text"][start:end],
                })
            if len(mentions) >= 2:
                clusters.append({"id": f"{document['id']}:{cluster_index}", "mentions": mentions})
        prediction.release_logits()
        results.append({"id": document["id"], "clusters": clusters})
    return results


def rerank_with_model(
    tokenizer: Any,
    model: Any,
    device: str,
    query: str,
    candidates: list[dict[str, str]],
) -> list[dict[str, Any]]:
    import torch

    ranked: list[dict[str, Any]] = []
    for start in range(0, len(candidates), 8):
        batch = candidates[start : start + 8]
        features = tokenizer(
            [[query, candidate["text"]] for candidate in batch],
            padding=True,
            truncation=True,
            max_length=512,
            return_tensors="pt",
        )
        features = {key: value.to(device) for key, value in features.items()}
        with torch.no_grad():
            logits = model(**features, return_dict=True).logits.reshape(-1).float()
            scores = torch.sigmoid(logits).tolist()
        ranked.extend(
            {"id": candidate["id"], "score": float(score)}
            for candidate, score in zip(batch, scores)
        )
    return sorted(ranked, key=lambda row: row["score"], reverse=True)


def nli_with_model(
    tokenizer: Any,
    model: Any,
    device: str,
    pairs: list[dict[str, str]],
) -> list[dict[str, Any]]:
    import torch

    results: list[dict[str, Any]] = []
    labels = ["contradiction", "entailment", "neutral"]
    for start in range(0, len(pairs), 24):
        batch = pairs[start : start + 24]
        features = tokenizer(
            [pair["premise"] for pair in batch],
            [pair["hypothesis"] for pair in batch],
            padding=True,
            truncation=True,
            max_length=512,
            return_tensors="pt",
        )
        features = {key: value.to(device) for key, value in features.items()}
        with torch.no_grad():
            probabilities = torch.softmax(
                model(**features, return_dict=True).logits.float(),
                dim=1,
            ).tolist()
        for pair, scores in zip(batch, probabilities):
            normalized_scores = {
                label: float(scores[index]) if index < len(scores) else 0.0
                for index, label in enumerate(labels)
            }
            results.append({
                "id": pair["id"],
                **normalized_scores,
                "label": max(normalized_scores, key=normalized_scores.get),
            })
    return results


def extract_with_model(
    model: Any,
    text: str,
    labels: list[str],
    relations: list[str],
    threshold: float,
    include_story_signals: bool,
) -> dict[str, Any]:
    """Run Storyhold's combined extraction schema in one GLiNER2 forward pass."""
    schema = model.create_schema().entities(labels)
    if relations:
        schema = schema.relations(relations)
    if include_story_signals:
        schema = schema.classification(
            "passage_kinds",
            PASSAGE_KINDS,
            multi_label=True,
            cls_threshold=max(0.25, threshold - 0.08),
        )
        schema = (
            schema.structure("story_claim")
            .field("subject", dtype="str", description="The subject whose state or belief is described")
            .field("predicate", dtype="str", description="The exact relation, property, belief, or assertion")
            .field("object", dtype="str", description="The object or value of the assertion")
            .field("epistemic_holder", dtype="str", description="Who believes or reports this, if not objective narration")
            .field("truth_mode", dtype="str", choices=TRUTH_MODES, description="Whether the passage states fact, belief, rumor, lie, dispute, uncertainty, or figurative language")
            .field("temporal_scope", dtype="str", description="When this assertion is true or believed")
            .structure("story_action")
            .field("actor", dtype="str", description="Who explicitly performs the action")
            .field("action", dtype="str", description="The explicit action performed")
            .field("target", dtype="str", description="The target or recipient of the action")
            .field("object", dtype="str", description="The object, item, device, weapon, or vehicle involved")
            .field("condition", dtype="str", description="An explicit condition attached to the action, offer, or promise")
            .field("outcome", dtype="str", description="The explicitly stated outcome, not an inferred result")
            .structure("state_change")
            .field("subject", dtype="str", description="The entity whose durable state changes")
            .field("change_type", dtype="str", choices=CHANGE_TYPES, description="The kind of durable change")
            .field("target", dtype="str", description="A related entity affected by the change")
            .field("before", dtype="str", description="The explicitly stated earlier state")
            .field("after", dtype="str", description="The explicitly stated resulting state")
            .field("time_marker", dtype="str", description="Date, duration, era, or before/after anchor")
        )
    return model.batch_extract(
        [text],
        schema,
        batch_size=1,
        threshold=threshold,
        include_confidence=True,
        include_spans=True,
    )[0]


def extract_with_gliner1(
    model: Any,
    text: str,
    labels: list[str],
    threshold: float,
) -> dict[str, Any]:
    return {
        "entities": model.predict_entities(
            text,
            labels,
            threshold=threshold,
            flat_ner=True,
        ),
        "relations": [],
        "classifications": [],
        "signals": [],
    }


def lorekeeper_stage_worker(
    connection: Any,
    stage: str,
    model_name: str,
    cache_dir: str,
    requested_device: str,
) -> None:
    """Load and run one specialist in a disposable child process.

    PyTorch's CPU allocator frequently keeps released model pages reserved inside
    a long-lived process. On Windows, exiting this worker is the reliable way to
    return those pages to the operating system before the next specialist loads.
    """
    model: Any = None
    resolved_device = requested_device

    def load_stage(device: str) -> Any:
        if stage == "gliner1":
            return load_gliner1_model(model_name, cache_dir, device)
        if stage == "gliner2":
            return load_gliner2_model(model_name, cache_dir, device)
        if stage == "coreference":
            return load_coreference_model(model_name, cache_dir, device)
        if stage in {"nli", "minilm", "bge"}:
            return load_pair_classifier(model_name, cache_dir, device)
        if stage == "qwen":
            return load_qwen_model(model_name, cache_dir, device)
        raise RuntimeError(f"Unknown Lorekeeper model stage: {stage}")

    try:
        resolved_device = local_device(requested_device, stage)
        print(
            f"[lorekeeper:{os.getpid()}] Loading {stage}: {model_name} on {resolved_device}...",
            flush=True,
        )
        try:
            model = load_stage(resolved_device)
        except BaseException as cuda_error:
            # Auto means "use the GPU when this particular model fits," not
            # "fail intake if a 4 GB laptop GPU cannot hold it." An explicit
            # --device cuda remains strict and surfaces the real failure.
            if resolved_device != "cuda" or requested_device != "auto" or not can_retry_on_cpu(cuda_error):
                raise
            print(
                f"[lorekeeper:{os.getpid()}] {stage} could not start on CUDA "
                f"({type(cuda_error).__name__}: {str(cuda_error)[:240]}). Retrying on CPU...",
                flush=True,
            )
            model = None
            gc.collect()
            try:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
            resolved_device = "cpu"
            model = load_stage(resolved_device)

        if stage == "qwen" and isinstance(model, dict):
            resolved_device = str(model.get("device", resolved_device))

        connection.send({
            "type": "ready",
            "pid": os.getpid(),
            "device": resolved_device,
        })
        print(f"[lorekeeper:{os.getpid()}] {stage} is ready.", flush=True)

        while True:
            try:
                message = connection.recv()
            except EOFError:
                break
            if not isinstance(message, dict):
                continue
            if message.get("type") == "shutdown":
                break

            request_id = message.get("id")
            operation = str(message.get("operation", ""))
            payload = message.get("payload")
            payload = payload if isinstance(payload, dict) else {}
            try:
                if operation == "extract_gliner1" and stage == "gliner1":
                    result = extract_with_gliner1(
                        model,
                        str(payload.get("text", "")),
                        list(payload.get("labels", [])),
                        float(payload.get("threshold", 0.42)),
                    )
                elif operation == "extract_gliner2" and stage == "gliner2":
                    result = extract_with_model(
                        model,
                        str(payload.get("text", "")),
                        list(payload.get("labels", [])),
                        list(payload.get("relations", [])),
                        float(payload.get("threshold", 0.42)),
                        payload.get("includeStorySignals", True) is not False,
                    )
                elif operation == "coreference" and stage == "coreference":
                    result = coreference_with_model(
                        model,
                        list(payload.get("documents", [])),
                        int(payload.get("maxTokensInBatch", 3_000)),
                    )
                elif operation == "rerank" and stage in {"minilm", "bge"}:
                    tokenizer, pair_model, device = model
                    result = rerank_with_model(
                        tokenizer,
                        pair_model,
                        device,
                        str(payload.get("query", "")),
                        list(payload.get("candidates", [])),
                    )
                elif operation == "nli" and stage == "nli":
                    tokenizer, pair_model, device = model
                    result = nli_with_model(
                        tokenizer,
                        pair_model,
                        device,
                        list(payload.get("pairs", [])),
                    )
                elif operation == "qwen_audit" and stage == "qwen":
                    result = qwen_audit_with_model(
                        model,
                        str(payload.get("prompt", "")),
                        int(payload.get("maximumOutputTokens", 240)),
                        int(payload.get("seed", 101)),
                        payload.get("responseSchema")
                        if isinstance(payload.get("responseSchema"), dict)
                        else None,
                        payload.get("jsonMode") is not False,
                    )
                elif operation == "qwen_classify" and stage == "qwen":
                    result = qwen_classify_with_model(
                        model,
                        list(payload.get("prompts", [])),
                    )
                else:
                    raise RuntimeError(f"Operation {operation!r} is invalid for {stage}.")
                connection.send({"type": "result", "id": request_id, "result": result})
            except BaseException as error:  # Keep the supervisor alive when one inference fails.
                traceback.print_exc()
                connection.send({
                    "type": "error",
                    "id": request_id,
                    "error": worker_exception_message(error),
                })
    except BaseException as error:
        traceback.print_exc()
        try:
            connection.send({
                "type": "boot_error",
                "pid": os.getpid(),
                "error": worker_exception_message(error),
            })
        except (BrokenPipeError, EOFError, OSError):
            pass
    finally:
        model = None
        gc.collect()
        try:
            torch = sys.modules.get("torch")
            if torch is not None and torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        try:
            connection.close()
        except OSError:
            pass
        print(f"[lorekeeper:{os.getpid()}] {stage} worker stopped.", flush=True)


class SequentialModelManager:
    """Keep exactly one Lorekeeper specialist in a disposable process."""

    def __init__(self, models: dict[str, str], cache_dir: str, device: str):
        self.models = models
        self.cache_dir = cache_dir
        self.device = device
        self.resolved_device: str | None = None
        self.active_stage: str | None = None
        self.loading_stage: str | None = None
        self.worker_pid: int | None = None
        self.worker_process: Any = None
        self.worker_connection: Any = None
        self.request_sequence = 0
        self.last_worker_failure: dict[str, Any] | None = None
        self.stage_failures: dict[str, dict[str, Any]] = {}
        self.retry_after: dict[str, float] = {}
        self.request_deadline: float | None = None
        self.request_cancelled: Any = None
        self.request_requires_loaded = False
        self.shutdown_requested = threading.Event()
        self.context = multiprocessing.get_context("spawn")

    @property
    def worker_alive(self) -> bool:
        process = self.worker_process
        try:
            return bool(process is not None and process.is_alive())
        except ValueError:
            # A health snapshot can overlap disposal of this exact process.
            return False

    def _stop_worker(self, force: bool = False) -> None:
        process = self.worker_process
        connection = self.worker_connection
        if process is None:
            return
        if process.pid is None:
            if connection is not None:
                connection.close()
            return
        if force and process.is_alive():
            process.terminate()
        if not force and process.is_alive() and connection is not None:
            try:
                connection.send({"type": "shutdown"})
            except (BrokenPipeError, EOFError, OSError):
                pass
        process.join(timeout=1 if force else 10)
        if process.is_alive():
            print(
                f"[lorekeeper] Worker {process.pid} did not stop cleanly; terminating it.",
                flush=True,
            )
            process.terminate()
            process.join(timeout=10)
        if process.is_alive() and hasattr(process, "kill"):
            process.kill()
            process.join(timeout=5)
        if process.is_alive():
            raise RuntimeError("The previous local worker could not be stopped; refusing to start another copy.")
        if connection is not None:
            try:
                connection.close()
            except OSError:
                pass
        try:
            process.close()
        except (OSError, ValueError):
            pass

    def release(self, force: bool = False) -> None:
        self._stop_worker(force=force)
        self.worker_process = None
        self.worker_connection = None
        self.worker_pid = None
        self.active_stage = None
        self.loading_stage = None

    def _record_worker_failure(
        self,
        message: str,
        exit_code: int | None = None,
    ) -> dict[str, Any]:
        process = self.worker_process
        if process is not None and exit_code is None:
            exit_code = process.exitcode
        failure = worker_failure_record(
            self.active_stage or self.loading_stage,
            self.worker_pid or (process.pid if process is not None else None),
            exit_code,
            message,
        )
        self.last_worker_failure = failure
        stage = failure.get("stage")
        if stage:
            self.stage_failures[stage] = failure
            self.retry_after[stage] = time.monotonic() + 60
            failure["retryAfterSeconds"] = 60
        return failure

    def check_request(self) -> None:
        if self.shutdown_requested.is_set():
            raise LocalRequestError("LOREKEEPER_STOPPING: the service is shutting down; model work was cancelled.")
        if self.request_deadline is not None and time.monotonic() >= self.request_deadline:
            raise LocalRequestError("LOREKEEPER_DEADLINE: the request expired; its model work was cancelled.")
        if self.request_cancelled is not None and self.request_cancelled():
            raise LocalRequestError("LOREKEEPER_CANCELLED: the caller disconnected; its model work was cancelled.")

    def component_status(self, stage: str) -> dict[str, Any]:
        remaining = max(0, self.retry_after.get(stage, 0) - time.monotonic())
        return {
            "ready": remaining == 0,
            "configured": True,
            "loaded": self.active_stage == stage and self.worker_alive,
            "loading": self.loading_stage == stage,
            "blocked": remaining > 0,
            "retryAfterSeconds": round(remaining, 1),
            "lastFailure": self.stage_failures.get(stage),
            "model": self.models[stage],
        }

    def reconcile_worker_state(self) -> None:
        """Turn an externally-killed child into an explicit, recoverable state."""
        if self.worker_process is None or self.worker_alive:
            return
        failure = self._record_worker_failure(
            "The isolated model worker exited unexpectedly and was cleared.",
            self.worker_process.exitcode,
        )
        self.release()
        self.last_worker_failure = failure

    def _receive(self, timeout_seconds: float) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            self.check_request()
            connection = self.worker_connection
            process = self.worker_process
            if connection is not None and connection.poll(0.1):
                try:
                    message = connection.recv()
                except EOFError as error:
                    if process is not None:
                        process.join(timeout=0.25)
                    failure = self._record_worker_failure(
                        "The local model worker closed its control connection unexpectedly.",
                        process.exitcode if process is not None else None,
                    )
                    raise RuntimeError(str(failure["message"])) from error
                if isinstance(message, dict):
                    return message
                raise RuntimeError("The local model worker returned an invalid response.")
            if process is None or not process.is_alive():
                exit_code = process.exitcode if process is not None else None
                failure = self._record_worker_failure(
                    f"The isolated model worker exited unexpectedly (exit code {exit_code}).",
                    exit_code,
                )
                raise RuntimeError(str(failure["message"]))
        failure = self._record_worker_failure(
            f"The local model worker did not respond within {int(timeout_seconds)} seconds."
        )
        failure["kind"] = "worker_timeout"
        raise TimeoutError(str(failure["message"]))

    def activate(self, stage: str) -> dict[str, Any]:
        self.check_request()
        if self.active_stage == stage and self.worker_alive:
            return {
                "stage": stage,
                "pid": self.worker_pid,
                "device": self.resolved_device or self.device,
            }
        if self.request_requires_loaded:
            raise LocalRequestError(f"LOREKEEPER_NOT_READY: {stage} is not resident; this quick check did not start a model. Full validation can load it.")
        if stage not in self.models:
            raise RuntimeError(f"Unknown Lorekeeper model stage: {stage}")
        if self.retry_after.get(stage, 0) > time.monotonic():
            failure = self.stage_failures[stage]
            raise LocalRequestError(f"LOREKEEPER_COOLDOWN: {stage} is paused after a failure: {failure['message']}")
        self.release()
        self.check_request()
        self.loading_stage = stage
        self.last_worker_failure = None
        memory = system_memory_status()
        minimum_commit = 2 * 1024 ** 3
        if memory.get("available") and memory.get("availableCommitBytes", minimum_commit) < minimum_commit:
            self._record_worker_failure(
                "Insufficient system commit headroom to load a local model safely "
                f"({memory['availableCommitBytes'] // (1024 ** 2)} MiB available; at least 2048 MiB required). "
                "Close memory-heavy applications before retrying; no model was started."
            )
            self.loading_stage = None
            raise LocalRequestError(f"LOREKEEPER_MEMORY: {self.last_worker_failure['message']}")
        model_name = self.models[stage]
        parent_connection, child_connection = self.context.Pipe(duplex=True)
        process = self.context.Process(
            target=lorekeeper_stage_worker,
            args=(child_connection, stage, model_name, self.cache_dir, self.device),
            name=f"storyhold-{stage}",
            daemon=True,
        )
        self.worker_process = process
        self.worker_connection = parent_connection
        try:
            self.check_request()
            process.start()
            # Expose the child immediately so a loading or memory-stalled model
            # can be diagnosed; waiting until the ready handshake made health
            # misleadingly report a live worker with no PID.
            self.worker_pid = process.pid
            child_connection.close()
            message = self._receive(600)
            if message.get("type") != "ready":
                failure = self._record_worker_failure(
                    str(message.get("error", "The model worker failed during startup."))
                )
                raise RuntimeError(str(failure["message"]))
            self.active_stage = stage
            self.worker_pid = int(message.get("pid", process.pid or 0)) or process.pid
            self.resolved_device = str(message.get("device", self.device))
            self.loading_stage = None
            self.last_worker_failure = None
            self.stage_failures.pop(stage, None)
            self.retry_after.pop(stage, None)
            print(
                f"[lorekeeper] {stage} worker {self.worker_pid} is ready on {self.resolved_device}.",
                flush=True,
            )
            return {
                "stage": stage,
                "pid": self.worker_pid,
                "device": self.resolved_device,
            }
        except Exception as error:
            child_connection.close()
            if isinstance(error, LocalRequestError) or self.last_worker_failure is None:
                self._record_worker_failure(str(error))
            self.release(force=isinstance(error, (LocalRequestError, TimeoutError)))
            raise

    def invoke(
        self,
        stage: str,
        operation: str,
        payload: dict[str, Any],
        timeout_seconds: float = 600,
    ) -> Any:
        self.activate(stage)
        if not self.worker_alive or self.worker_connection is None:
            raise RuntimeError(f"The {stage} worker is not running.")
        self.request_sequence += 1
        request_id = self.request_sequence
        try:
            self.check_request()
            self.worker_connection.send({
                "type": "request",
                "id": request_id,
                "operation": operation,
                "payload": payload,
            })
            message = self._receive(timeout_seconds)
        except Exception as error:
            if isinstance(error, LocalRequestError) or self.last_worker_failure is None:
                self._record_worker_failure(str(error))
            self.release(force=isinstance(error, (LocalRequestError, TimeoutError)))
            raise
        if message.get("id") != request_id:
            failure = self._record_worker_failure(
                "The local model worker returned an out-of-sequence response."
            )
            self.release()
            self.last_worker_failure = failure
            raise RuntimeError(str(failure["message"]))
        if message.get("type") == "error":
            failure = self._record_worker_failure(
                str(message.get("error", "Local model inference failed."))
            )
            # A llama.cpp/Vulkan decode error can leave the otherwise-live
            # process with poisoned allocator state. Dispose the stage now so
            # the OS reclaims its VRAM; a later activation reloads the same 4B
            # model with the configured conservative micro-batch.
            self.release()
            self.last_worker_failure = failure
            raise RuntimeError(str(failure["message"]))
        if message.get("type") != "result":
            failure = self._record_worker_failure(
                "The local model worker returned an invalid result."
            )
            self.release()
            self.last_worker_failure = failure
            raise RuntimeError(str(failure["message"]))
        self.last_worker_failure = None
        return message.get("result")


class StoryholdLorekeeperServer(ThreadingHTTPServer):
    # Inference remains strictly sequential behind inference_lock, while health
    # checks and shutdown stay responsive during a long model request. The
    # socket backlog is deliberately small so duplicate inference callers cannot
    # build an unbounded queue of waiting threads.
    request_queue_size = 4
    daemon_threads = True
    block_on_close = False

    def __init__(
        self,
        address,
        handler,
        manager: SequentialModelManager,
    ):
        super().__init__(address, handler)
        self.manager = manager
        self.inference_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server: StoryholdLorekeeperServer

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(15)

    @property
    def response_device(self) -> str:
        return getattr(self, "_response_device", self.server.manager.device)

    @property
    def response_worker_pid(self) -> int | None:
        return getattr(self, "_response_worker_pid", None)

    def caller_disconnected(self) -> bool:
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            return bool(readable) and self.connection.recv(1, socket.MSG_PEEK) == b""
        except (OSError, ValueError):
            return True

    @contextmanager
    def inference_scope(self, payload: Any = None):
        # Do not queue HTTP threads behind a stalled model. The durable intake
        # coordinator owns retries, not abandoned sockets in this supervisor.
        if not self.server.inference_lock.acquire(blocking=False):
            raise LocalRequestError("LOREKEEPER_BUSY: another local model request is still running.")
        manager = self.server.manager
        try:
            deadline = payload.get("deadlineUnixMs") if isinstance(payload, dict) else None
            if deadline is not None:
                if isinstance(deadline, bool) or not isinstance(deadline, (int, float)) or not 0 < deadline < 1e15:
                    raise LocalRequestError("LOREKEEPER_DEADLINE: invalid request deadline.")
                manager.request_deadline = time.monotonic() + min(600, (deadline - time.time() * 1000) / 1000)
            manager.request_cancelled = self.caller_disconnected
            manager.request_requires_loaded = isinstance(payload, dict) and payload.get("requireLoaded") is True
            manager.check_request()
            yield
        finally:
            self._response_device = manager.resolved_device or manager.device
            self._response_worker_pid = manager.worker_pid
            manager.request_deadline = None
            manager.request_cancelled = None
            manager.request_requires_loaded = False
            self.server.inference_lock.release()

    def log_message(self, format_string: str, *args: Any) -> None:
        print(f"[lorekeeper] {self.address_string()} {format_string % args}", flush=True)

    def send_json(self, status: int, payload: dict[str, Any]) -> bool:
        if status == HTTPStatus.INTERNAL_SERVER_ERROR and "LOREKEEPER_" in str(payload.get("error", "")):
            status = HTTPStatus.SERVICE_UNAVAILABLE
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return True
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            # The caller timed out or closed the page while a large model was
            # finishing. The inference result can be discarded without turning
            # an ordinary disconnect into a second server failure/traceback.
            return False

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path.rstrip("/") == "/health":
            # Never release/close a worker concurrently with its inference.
            if self.server.inference_lock.acquire(blocking=False):
                try:
                    self.server.manager.reconcile_worker_state()
                finally:
                    self.server.inference_lock.release()
            self.send_json(
                HTTPStatus.OK,
                {
                    "status": "ready",
                    "service": "storyhold-lorekeeper-local",
                    "device": self.server.manager.resolved_device or self.server.manager.device,
                    "requestedDevice": self.server.manager.device,
                    "cudaStages": sorted(configured_cuda_stages()),
                    "cuda": cuda_capability(),
                    "qwenLlamaContext": qwen_llama_context_settings(),
                    "memory": system_memory_status(),
                    "supervisorPid": os.getpid(),
                    "workerPid": self.server.manager.worker_pid,
                    "workerAlive": self.server.manager.worker_alive,
                    "lastWorkerFailure": self.server.manager.last_worker_failure,
                    "activeStage": self.server.manager.active_stage,
                    "loadingStage": self.server.manager.loading_stage,
                    "components": {
                        stage: self.server.manager.component_status(stage)
                        for stage, model in self.server.manager.models.items()
                    },
                    "local": True,
                    "sequential": True,
                    "processIsolation": True,
                    "maximumResidentWorkers": 1,
                    "requestCancellation": True,
                    "runtimeVersion": 2,
                },
            )
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"error": "Not found."})

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path.rstrip("/") == "/shutdown":
            self.server.manager.shutdown_requested.set()
            self.send_json(HTTPStatus.ACCEPTED, {"status": "stopping"})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        route = self.path.rstrip("/")
        if route == "/stage/release":
            try:
                with self.inference_scope():
                    self.server.manager.release()
                self.send_json(HTTPStatus.OK, {"status": "released"})
            except LocalRequestError as error:
                self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": str(error)})
            return
        if route not in {
            "/gliner", "/gliner1", "/gliner2", "/rerank", "/rerank/fast",
            "/rerank/final", "/nli", "/coreference", "/qwen/audit", "/qwen/classify", "/stage/activate",
        }:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Not found."})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_REQUEST_BYTES:
            self.send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "Invalid request size."})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Request body must be JSON."})
            return

        if route == "/stage/activate":
            stage = str(payload.get("stage", "")).strip() if isinstance(payload, dict) else ""
            if stage not in self.server.manager.models:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "That local intake stage is not configured."})
                return
            try:
                with self.inference_scope(payload):
                    self.server.manager.activate(stage)
                self.send_json(HTTPStatus.OK, {
                    "status": "ready",
                    "stage": stage,
                    "model": self.server.manager.models[stage],
                    "device": self.response_device,
                    "workerPid": self.response_worker_pid,
                })
            except Exception as error:
                self.send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": f"The {stage} stage could not be loaded: {str(error)[:500]}"},
                )
            return

        if route == "/coreference":
            if importlib.util.find_spec("fastcoref") is None:
                self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "The local coreference reader is not installed."})
                return
            documents = payload.get("documents") if isinstance(payload, dict) else None
            max_tokens = payload.get("maxTokensInBatch", 3_000) if isinstance(payload, dict) else 3_000
            if not isinstance(documents, list) or not 1 <= len(documents) <= MAX_COREFERENCE_DOCUMENTS:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "The coreference request is invalid."})
                return
            cleaned_documents: list[dict[str, str]] = []
            for document in documents:
                if not isinstance(document, dict):
                    self.send_json(HTTPStatus.BAD_REQUEST, {"error": "A coreference document is invalid."})
                    return
                document_id = str(document.get("id", "")).strip()[:160]
                document_text = str(document.get("text", "")).replace("\x00", "")[:MAX_TEXT_CHARACTERS]
                if not document_id or not document_text.strip():
                    self.send_json(HTTPStatus.BAD_REQUEST, {"error": "A coreference document is empty."})
                    return
                cleaned_documents.append({"id": document_id, "text": document_text})
            try:
                max_tokens = max(256, min(12_000, int(max_tokens)))
            except (TypeError, ValueError):
                max_tokens = 3_000
            try:
                with self.inference_scope(payload):
                    results = self.server.manager.invoke(
                        "coreference",
                        "coreference",
                        {
                            "documents": cleaned_documents,
                            "maxTokensInBatch": max_tokens,
                        },
                    )
                self.send_json(HTTPStatus.OK, {
                    "documents": results,
                    "model": self.server.manager.models["coreference"],
                    "device": self.response_device,
                })
            except Exception as error:
                self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Coreference inference failed: {str(error)[:500]}"})
            return

        if route == "/qwen/audit":
            prompt = payload.get("prompt") if isinstance(payload, dict) else None
            maximum_output_tokens = payload.get("maximumOutputTokens", 240) if isinstance(payload, dict) else 240
            seed = payload.get("seed", 101) if isinstance(payload, dict) else 101
            response_schema = payload.get("responseSchema") if isinstance(payload, dict) else None
            if (
                not isinstance(prompt, str)
                or not prompt.strip()
                or len(prompt) > MAX_QWEN_PROMPT_CHARACTERS
            ):
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "The Qwen audit prompt is invalid."})
                return
            try:
                maximum_output_tokens = max(32, min(MAX_QWEN_OUTPUT_TOKENS, int(maximum_output_tokens)))
                seed = max(0, min(2_147_483_647, int(seed)))
            except (TypeError, ValueError):
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "The Qwen generation settings are invalid."})
                return
            try:
                with self.inference_scope(payload):
                    result = self.server.manager.invoke(
                        "qwen",
                        "qwen_audit",
                        {
                            "prompt": prompt,
                            "maximumOutputTokens": maximum_output_tokens,
                            "seed": seed,
                            "responseSchema": response_schema if isinstance(response_schema, dict) else None,
                            "jsonMode": payload.get("jsonMode") is not False,
                        },
                        timeout_seconds=15 * 60,
                    )
                self.send_json(HTTPStatus.OK, {
                    **result,
                    "model": self.server.manager.models["qwen"],
                    "stage": "qwen",
                    "workerPid": self.response_worker_pid,
                })
            except Exception as error:
                self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Qwen audit failed: {str(error)[:500]}"})
            return

        if route == "/qwen/classify":
            prompts = payload.get("prompts") if isinstance(payload, dict) else None
            if not isinstance(prompts, list) or not 1 <= len(prompts) <= MAX_QWEN_CLASSIFICATION_PROMPTS:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "The Qwen classification batch is invalid."})
                return
            cleaned_prompts: list[dict[str, Any]] = []
            for prompt in prompts:
                if not isinstance(prompt, dict):
                    self.send_json(HTTPStatus.BAD_REQUEST, {"error": "A Qwen classification prompt is invalid."})
                    return
                try:
                    prompt_index = int(prompt.get("index"))
                except (TypeError, ValueError):
                    self.send_json(HTTPStatus.BAD_REQUEST, {"error": "A Qwen classification prompt index is invalid."})
                    return
                prompt_text = str(prompt.get("text", "")).strip()
                if prompt_index < 0 or not prompt_text or len(prompt_text) > 8_000:
                    self.send_json(HTTPStatus.BAD_REQUEST, {"error": "A Qwen classification prompt is empty or too large."})
                    return
                cleaned_prompts.append({"index": prompt_index, "text": prompt_text})
            try:
                with self.inference_scope(payload):
                    result = self.server.manager.invoke(
                        "qwen",
                        "qwen_classify",
                        {"prompts": cleaned_prompts},
                        timeout_seconds=15 * 60,
                    )
                self.send_json(HTTPStatus.OK, {
                    **result,
                    "model": self.server.manager.models["qwen"],
                    "stage": "qwen",
                    "workerPid": self.response_worker_pid,
                })
            except Exception as error:
                self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Qwen classification failed: {str(error)[:500]}"})
            return

        if route in {"/rerank", "/rerank/fast", "/rerank/final"}:
            stage = "minilm" if route == "/rerank/fast" else "bge"
            query = payload.get("query") if isinstance(payload, dict) else None
            candidates = payload.get("candidates") if isinstance(payload, dict) else None
            maximum = payload.get("maximum", 96) if isinstance(payload, dict) else 96
            if (
                not isinstance(query, str)
                or not query.strip()
                or len(query) > 4_000
                or not isinstance(candidates, list)
                or not 1 <= len(candidates) <= MAX_RERANK_CANDIDATES
            ):
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "The reranking request is invalid."})
                return
            cleaned_candidates: list[dict[str, str]] = []
            for candidate in candidates:
                if not isinstance(candidate, dict):
                    self.send_json(HTTPStatus.BAD_REQUEST, {"error": "A reranking candidate is invalid."})
                    return
                candidate_id = str(candidate.get("id", "")).strip()[:160]
                candidate_text = str(candidate.get("text", "")).strip()[:2_400]
                if not candidate_id or not candidate_text:
                    self.send_json(HTTPStatus.BAD_REQUEST, {"error": "A reranking candidate is empty."})
                    return
                cleaned_candidates.append({"id": candidate_id, "text": candidate_text})
            try:
                maximum = max(1, min(len(cleaned_candidates), int(maximum)))
            except (TypeError, ValueError):
                maximum = min(96, len(cleaned_candidates))
            try:
                with self.inference_scope(payload):
                    rankings = self.server.manager.invoke(
                        stage,
                        "rerank",
                        {"query": query.strip(), "candidates": cleaned_candidates},
                    )
                self.send_json(HTTPStatus.OK, {
                    "rankings": rankings[:maximum],
                    "model": self.server.manager.models[stage],
                    "stage": stage,
                    "device": self.response_device,
                })
            except Exception as error:
                self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Reranking failed: {str(error)[:500]}"})
            return

        if route == "/nli":
            pairs = payload.get("pairs") if isinstance(payload, dict) else None
            if not isinstance(pairs, list) or not 1 <= len(pairs) <= MAX_NLI_PAIRS:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "The canon inspection request is invalid."})
                return
            cleaned_pairs: list[dict[str, str]] = []
            for pair in pairs:
                if not isinstance(pair, dict):
                    self.send_json(HTTPStatus.BAD_REQUEST, {"error": "A canon inspection pair is invalid."})
                    return
                pair_id = str(pair.get("id", "")).strip()[:160]
                premise = str(pair.get("premise", "")).strip()[:1_800]
                hypothesis = str(pair.get("hypothesis", "")).strip()[:1_800]
                if not pair_id or not premise or not hypothesis:
                    self.send_json(HTTPStatus.BAD_REQUEST, {"error": "A canon inspection pair is empty."})
                    return
                cleaned_pairs.append({"id": pair_id, "premise": premise, "hypothesis": hypothesis})
            try:
                with self.inference_scope(payload):
                    results = self.server.manager.invoke(
                        "nli",
                        "nli",
                        {"pairs": cleaned_pairs},
                    )
                self.send_json(HTTPStatus.OK, {
                    "results": results,
                    "model": self.server.manager.models["nli"],
                    "device": self.response_device,
                })
            except Exception as error:
                self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Canon inspection failed: {str(error)[:500]}"})
            return

        text = payload.get("text") if isinstance(payload, dict) else None
        labels = payload.get("labels") if isinstance(payload, dict) else None
        relations = payload.get("relations", []) if isinstance(payload, dict) else []
        include_story_signals = payload.get("storySignals", True) is not False if isinstance(payload, dict) else True
        threshold_value = payload.get("threshold", 0.42) if isinstance(payload, dict) else 0.42
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARACTERS:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Text is missing or too large."})
            return
        if (
            not isinstance(labels, list)
            or not 1 <= len(labels) <= MAX_LABELS
            or any(not isinstance(label, str) or not label.strip() for label in labels)
        ):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Labels are missing or invalid."})
            return
        if (
            not isinstance(relations, list)
            or len(relations) > MAX_LABELS
            or any(not isinstance(label, str) or not label.strip() for label in relations)
        ):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Relations are invalid."})
            return
        try:
            threshold = max(0.05, min(0.95, float(threshold_value)))
        except (TypeError, ValueError):
            threshold = 0.42

        stage = "gliner1" if route == "/gliner1" else "gliner2"
        try:
            with self.inference_scope(payload):
                if stage == "gliner1":
                    result = self.server.manager.invoke(
                        stage,
                        "extract_gliner1",
                        {
                            "text": text,
                            "labels": [label.strip() for label in labels],
                            "threshold": threshold,
                        },
                    )
                else:
                    result = self.server.manager.invoke(
                        stage,
                        "extract_gliner2",
                        {
                            "text": text,
                            "labels": [label.strip() for label in labels],
                            "relations": [label.strip() for label in relations],
                            "threshold": threshold,
                            "includeStorySignals": include_story_signals,
                        },
                    )
            entities = normalize_entity_result(result, text)
            relation_rows = normalize_relation_result(result, text)
            classifications = normalize_classification_result(result)
            signals = normalize_story_signals(result)
            self.send_json(
                HTTPStatus.OK,
                {
                    "entities": entities,
                    "relations": relation_rows,
                    "classifications": classifications,
                    "signals": signals,
                    "model": self.server.manager.models[stage],
                    "stage": stage,
                    "device": self.response_device,
                },
            )
        except Exception as error:  # Keep model failures visible without terminating the service.
            self.send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": f"{stage} inference failed: {str(error)[:500]}"},
            )


def span_for(text: str, value: str, declared_start: Any = None) -> tuple[int, int]:
    try:
        start = int(declared_start)
    except (TypeError, ValueError):
        start = -1
    if start < 0 or text[start : start + len(value)] != value:
        start = text.find(value)
    return (start, start + len(value)) if start >= 0 else (-1, -1)


def normalize_entity_result(result: Any, text: str) -> list[dict[str, Any]]:
    payload = result.get("entities", result) if isinstance(result, dict) else result
    rows: list[dict[str, Any]] = []
    if isinstance(payload, list):
        rows = [entity for entity in map(json_safe_entity, payload) if entity]
    elif isinstance(payload, dict):
        for label, values in payload.items():
            if not isinstance(values, list):
                continue
            for value in values:
                if isinstance(value, dict):
                    row = json_safe_entity({**value, "label": value.get("label", label)})
                else:
                    entity_text = str(value).strip()
                    start, end = span_for(text, entity_text)
                    row = {
                        "text": entity_text,
                        "label": str(label),
                        "score": 0.5,
                        "start": start,
                        "end": end,
                    }
                if row:
                    rows.append(row)
    return rows


def relation_endpoint(value: Any, text: str) -> dict[str, Any]:
    if isinstance(value, dict):
        endpoint_text = str(value.get("text", "")).strip()
        start, end = span_for(text, endpoint_text, value.get("start"))
        try:
            score = float(value.get("confidence", value.get("score", 0.5)))
        except (TypeError, ValueError):
            score = 0.5
        return {
            "text": endpoint_text,
            "start": start,
            "end": end,
            "score": max(0.0, min(1.0, score)),
        }
    endpoint_text = str(value).strip()
    start, end = span_for(text, endpoint_text)
    return {"text": endpoint_text, "start": start, "end": end, "score": 0.5}


def normalize_relation_result(result: Any, text: str) -> list[dict[str, Any]]:
    payload = result.get("relation_extraction", {}) if isinstance(result, dict) else {}
    if not isinstance(payload, dict):
        return []
    rows: list[dict[str, Any]] = []
    for label, values in payload.items():
        if not isinstance(values, list):
            continue
        for value in values:
            if isinstance(value, dict):
                head = relation_endpoint(value.get("head", value.get("subject", {})), text)
                tail = relation_endpoint(value.get("tail", value.get("object", {})), text)
            elif isinstance(value, (list, tuple)) and len(value) >= 2:
                head = relation_endpoint(value[0], text)
                tail = relation_endpoint(value[1], text)
            else:
                continue
            if not head["text"] or not tail["text"]:
                continue
            rows.append(
                {
                    "label": str(label),
                    "subject": head,
                    "target": tail,
                    "score": min(float(head["score"]), float(tail["score"])),
                }
            )
    return rows


def normalize_classification_result(result: Any) -> list[dict[str, Any]]:
    payload = result.get("passage_kinds", []) if isinstance(result, dict) else []
    values = payload if isinstance(payload, list) else [payload]
    rows: list[dict[str, Any]] = []
    for value in values:
        if isinstance(value, dict):
            label = str(value.get("label", value.get("text", ""))).strip()
            raw_score = value.get("confidence", value.get("score", 0.5))
        else:
            label = str(value).strip()
            raw_score = 0.5
        if not label:
            continue
        try:
            score = float(raw_score)
        except (TypeError, ValueError):
            score = 0.5
        rows.append({"label": label, "score": max(0.0, min(1.0, score))})
    return rows


def normalize_signal_field(value: Any) -> list[dict[str, Any]]:
    values = value if isinstance(value, list) else [value]
    rows: list[dict[str, Any]] = []
    for item in values:
        if isinstance(item, dict):
            text = str(item.get("text", item.get("label", ""))).strip()
            raw_score = item.get("confidence", item.get("score", 0.5))
            start = item.get("start", -1)
            end = item.get("end", -1)
        else:
            text = str(item).strip() if item is not None else ""
            raw_score = 0.5
            start = -1
            end = -1
        if not text:
            continue
        try:
            score = float(raw_score)
        except (TypeError, ValueError):
            score = 0.5
        rows.append({
            "text": text,
            "score": max(0.0, min(1.0, score)),
            "start": start,
            "end": end,
        })
    return rows


def normalize_story_signals(result: Any) -> list[dict[str, Any]]:
    if not isinstance(result, dict):
        return []
    rows: list[dict[str, Any]] = []
    for signal_type in ("story_claim", "story_action", "state_change"):
        payload = result.get(signal_type, [])
        values = payload if isinstance(payload, list) else [payload]
        for value in values:
            if not isinstance(value, dict):
                continue
            fields = {
                str(key): normalized
                for key, raw in value.items()
                if (normalized := normalize_signal_field(raw))
            }
            if fields:
                rows.append({"signalType": signal_type, "fields": fields})
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description="Storyhold's sequential local Lorekeeper service")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--gliner2-model", default="fastino/gliner2-base-v1")
    parser.add_argument("--minilm-model", default="cross-encoder/ms-marco-MiniLM-L6-v2")
    parser.add_argument("--bge-model", default="BAAI/bge-reranker-v2-m3")
    parser.add_argument("--nli-model", default="cross-encoder/nli-deberta-v3-xsmall")
    parser.add_argument("--coreference-model", default="biu-nlp/f-coref")
    parser.add_argument("--qwen-model", default="Qwen/Qwen3.5-4B-Instruct")
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--download-only", action="store_true")
    parser.add_argument(
        "--download-stage",
        choices=["all", "gliner2", "coreference", "nli", "minilm", "bge", "qwen"],
        default="all",
    )
    args = parser.parse_args()
    if args.host not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit("Storyhold's local Lorekeeper service may only bind to loopback.")

    os.makedirs(args.cache_dir, exist_ok=True)
    models = {
        "gliner2": args.gliner2_model,
        "coreference": args.coreference_model,
        "nli": args.nli_model,
        "minilm": args.minilm_model,
        "bge": args.bge_model,
        "qwen": args.qwen_model,
    }
    manager = SequentialModelManager(models, args.cache_dir, args.device)
    if args.download_only:
        selected_stages = list(models) if args.download_stage == "all" else [args.download_stage]
        for stage in selected_stages:
            manager.activate(stage)
            manager.release()
        print(
            f"Lorekeeper local stage(s) {', '.join(selected_stages)} are installed, loadable, and ready for sequential intake.",
            flush=True,
        )
        return

    server = StoryholdLorekeeperServer(
        (args.host, args.port),
        Handler,
        manager,
    )
    print(
        f"Storyhold's process-isolated Lorekeeper supervisor is ready at http://{args.host}:{args.port} ({args.device}).",
        flush=True,
    )
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        manager.shutdown_requested.set()
        with server.inference_lock:
            manager.release(force=True)
        server.server_close()


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()

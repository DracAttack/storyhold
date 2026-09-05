"""Emit a machine-readable llama.cpp GPU capability receipt."""

from __future__ import annotations

import json

import llama_cpp


system_info = llama_cpp.llama_print_system_info()
if isinstance(system_info, bytes):
    system_info = system_info.decode("utf-8", "replace")

print(json.dumps({
    "version": llama_cpp.__version__,
    "gpuOffload": bool(llama_cpp.llama_supports_gpu_offload()),
    "systemInfo": str(system_info),
}))

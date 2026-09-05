"""Perform a real CUDA operation and emit Storyhold's capability receipt."""

from __future__ import annotations

import json

import torch


if not torch.cuda.is_available():
    raise SystemExit("PyTorch installed, but CUDA is still unavailable.")

device = torch.device("cuda:0")
left = torch.arange(4096, device=device, dtype=torch.float32).reshape(64, 64)
right = torch.eye(64, device=device, dtype=torch.float32)
result = left @ right
torch.cuda.synchronize()
properties = torch.cuda.get_device_properties(0)

print(json.dumps({
    "available": True,
    "device": properties.name,
    "totalMemoryBytes": properties.total_memory,
    "torchVersion": torch.__version__,
    "cudaRuntime": torch.version.cuda,
    "tensorCheck": float(result[63, 63].item()),
}))

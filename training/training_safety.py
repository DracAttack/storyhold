from __future__ import annotations

import json
import os
from contextlib import contextmanager
from pathlib import Path

import psutil


def available_gib() -> float:
    return psutil.virtual_memory().available / (1024 ** 3)


def require_available_memory(minimum_gib: float, allow_low_memory: bool) -> None:
    available = available_gib()
    if available >= minimum_gib or allow_low_memory:
        print(f"Memory preflight: {available:.2f} GiB available (minimum {minimum_gib:.2f} GiB).")
        return
    raise RuntimeError(
        f"Training did not start: only {available:.2f} GiB of RAM is available; "
        f"this run requires at least {minimum_gib:.2f} GiB. Close memory-heavy programs, "
        "stop Storyhold, and run the same command again. Nothing was killed or changed."
    )


def require_lorekeeper_stopped(repo_root: Path) -> None:
    pid_file = repo_root / ".storyhold-runtime" / "gliner" / "gliner.pid"
    if not pid_file.exists():
        return
    try:
        pid = int(pid_file.read_text(encoding="utf-8").strip())
        process = psutil.Process(pid)
    except (ValueError, psutil.Error):
        return
    if process.is_running() and "python" in process.name().lower():
        raise RuntimeError(
            f"Training did not start because Storyhold's Lorekeeper inference process {pid} is active. "
            "Use Stop Storyhold first; the trainer will not terminate it automatically."
        )


@contextmanager
def exclusive_training_lock(repo_root: Path, name: str):
    lock_root = repo_root / ".storyhold-training-runs"
    lock_root.mkdir(parents=True, exist_ok=True)
    lock_path = lock_root / "active-training.lock"
    try:
        descriptor = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as error:
        try:
            details = lock_path.read_text(encoding="utf-8")
        except OSError:
            details = "another Storyhold adapter run"
        raise RuntimeError(f"Training did not start because {details.strip()} is already active.") from error
    try:
        os.write(descriptor, json.dumps({"name": name, "pid": os.getpid()}).encode("utf-8"))
        os.close(descriptor)
        yield
    finally:
        try:
            os.close(descriptor)
        except OSError:
            pass
        lock_path.unlink(missing_ok=True)


def local_snapshot(cache_root: Path, repository: str) -> Path:
    model_root = cache_root / f"models--{repository.replace('/', '--')}" / "snapshots"
    snapshots = sorted((path for path in model_root.glob("*") if path.is_dir()), key=lambda path: path.stat().st_mtime, reverse=True)
    if not snapshots:
        raise FileNotFoundError(f"No offline checkpoint for {repository} was found under {model_root}.")
    return snapshots[0]


def jsonl_rows(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            line = line.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"{path}:{line_number}: {error}") from error
            if not isinstance(value, dict):
                raise ValueError(f"{path}:{line_number}: each JSONL row must be an object.")
            rows.append(value)
    if not rows:
        raise ValueError(f"{path} contains no training rows.")
    return rows

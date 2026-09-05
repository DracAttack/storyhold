from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from gliner2.training.data import DataLoader_Factory
from gliner2.training.trainer import train_gliner2

from training_safety import (
    exclusive_training_lock,
    jsonl_rows,
    require_available_memory,
    require_lorekeeper_stopped,
)


def validate(path: Path) -> int:
    expected = len(jsonl_rows(path))
    validated = DataLoader_Factory.load(path, shuffle=False, validate=True)
    if len(validated) != expected:
        raise ValueError(
            f"{path} retained only {len(validated)} of {expected} examples after GLiNER2 validation."
        )
    return expected


def main() -> None:
    parser = argparse.ArgumentParser(description="Train Storyhold's GLiNER2 canon adapter.")
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--train", type=Path, required=True)
    parser.add_argument("--eval", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", default="fastino/gliner2-base-v1")
    parser.add_argument("--max-steps", type=int, default=120)
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--allow-low-memory", action="store_true")
    args = parser.parse_args()

    args.repo_root = args.repo_root.resolve()
    args.train = args.train.resolve()
    args.eval = args.eval.resolve()
    args.output = args.output.resolve()
    train_count = validate(args.train)
    eval_count = validate(args.eval)
    print(f"Validated {train_count} GLiNER2 training examples and {eval_count} held-out examples.")
    if args.validate_only:
        return

    if args.max_steps < 1:
        raise ValueError("--max-steps must be positive.")
    require_lorekeeper_stopped(args.repo_root)
    require_available_memory(3.5, args.allow_low_memory)
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    os.environ.setdefault("OMP_NUM_THREADS", "2")
    os.environ.setdefault("MKL_NUM_THREADS", "2")

    args.output.mkdir(parents=True, exist_ok=True)
    with exclusive_training_lock(args.repo_root, "Storyhold GLiNER2 adapter training"):
        results = train_gliner2(
            args.model,
            str(args.train),
            output_dir=str(args.output),
            eval_data=str(args.eval),
            experiment_name="storyhold-canon-gliner2-v1",
            num_epochs=20,
            max_steps=args.max_steps,
            batch_size=1,
            eval_batch_size=1,
            gradient_accumulation_steps=8,
            encoder_lr=2e-5,
            task_lr=2e-4,
            weight_decay=0.01,
            scheduler_type="cosine",
            warmup_ratio=0.08,
            fp16=False,
            bf16=False,
            eval_strategy="steps",
            eval_steps=max(5, args.max_steps // 4),
            save_total_limit=2,
            save_best=True,
            logging_steps=1,
            report_to_wandb=False,
            early_stopping=True,
            early_stopping_patience=3,
            num_workers=0,
            pin_memory=False,
            seed=81417,
            deterministic=True,
            validate_data=True,
            max_len=384,
            use_lora=True,
            lora_r=8,
            lora_alpha=16,
            lora_dropout=0.05,
            lora_target_modules=["encoder.query", "encoder.value", "span_rep", "classifier", "count_pred"],
            save_adapter_only=True,
        )
        (args.output / "storyhold-training-result.json").write_text(
            json.dumps(results, indent=2, default=str),
            encoding="utf-8",
        )
    print(f"GLiNER2 adapter training completed at {args.output}.")


if __name__ == "__main__":
    main()

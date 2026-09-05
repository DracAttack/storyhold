# Storyhold Model Adaptation

Storyhold trains narrow, versioned adapters from owner-confirmed canon corrections. Training is deliberately separate from intake and the local Lorekeeper service:

- GLiNER2 learns manuscript spans, alias links, speakers, literalness, and temporal qualification.
- Qwen learns evidence-bound canon judgments and customer-safe structured outputs.
- An adapter is never enabled merely because training completed. It must improve the held-out regression set without weakening existing extraction.
- Training is offline, single-process, and guarded by a lock and available-memory checks.

The seed corpus in `training/data` contains only curated Storyhold corrections and compact synthetic counterexamples. It must not be populated automatically from private customer manuscripts or thumbs-down notes.

## Current Model Roles

`fastino/gliner2-base-v1` is the GLiNER2 base. Its adapter can eventually be merged into a local Storyhold checkpoint after regression evaluation.

`Qwen/Qwen3.5-0.8B` is the currently cached trainable Qwen checkpoint. Its first adapter is a narrow canon/identity judge. It does **not** replace the stronger 4B GGUF dossier writer. GGUF inference files cannot consume a PEFT adapter directly; promotion to the 4B runtime requires obtaining the matching trainable 4B checkpoint, training that version, evaluating it, then exporting a new GGUF.

## Commands

Validate the corpora without loading a model:

```powershell
.\scripts\train-storyhold-gliner2.ps1 -ValidateOnly
.\scripts\train-storyhold-qwen.ps1 -ValidateOnly
```

Start bounded adapter runs:

```powershell
.\scripts\train-storyhold-gliner2.ps1 -MaxSteps 120
.\scripts\train-storyhold-qwen.ps1 -MaxSteps 80
```

The wrappers refuse to run while the Lorekeeper inference supervisor is active. Stop Storyhold first so training cannot compete with intake for RAM.

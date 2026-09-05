# Lorekeeper execution architecture

This document records the boundary between Storyhold's web application and its
model execution. It does not enable a cloud worker or send manuscripts off this
computer.

## Active local arrangement

- The Storyhold API owns intake runs, credit reservations, source fingerprints,
  checkpoints, pause/resume state, and the final database transaction.
- A loopback-only supervisor listens on `127.0.0.1:8765`.
- The supervisor starts exactly one disposable specialist process at a time.
- The active sequence is deterministic parsing, GLiNER2, coreference, NLI,
  MiniLM, BGE, and Qwen. Each stage consumes the durable output and evidence
  references produced by the earlier stages.
- PyTorch specialists use CUDA when the configured stage fits on the local GPU.
  Automatic mode retries the same unmodified model on CPU when CUDA loading
  fails. It never substitutes a smaller model or skips the stage.
- Qwen uses the official Vulkan-enabled llama.cpp runtime on the current Acer
  Nitro 5. The launcher constrains Vulkan to the NVIDIA RTX 3050 and offloads
  32 layers. It retains the full 16K context and 512-token logical batch while
  dividing compute into 128-token physical micro-batches, lowering transient
  VRAM pressure without changing model quality. The same Qwen 3.5 4B Q4_K_M
  weights remain available on CPU if the operator deliberately sets the
  offload count to zero.
- Any worker inference or protocol failure releases the isolated process so
  native allocations are reclaimed. The supervisor retains a structured last
  failure—including recognized Vulkan OOM/native-exception diagnostics—after
  release so health checks do not erase the cause.
- Every stage receipt records the model, actual device, processed-item count,
  elapsed time, and failure. Checkpoints remain valid across process restarts.

The web application is therefore not coupled to a particular GPU. It owns the
job and evidence contract; the local supervisor only executes one requested
stage and returns a bounded result.

## Dormant hosted-worker boundary

The first hosted version should preserve the same intake and checkpoint
contract. Only the executor changes:

1. The web/API process stores the upload in private object storage and creates
   a durable intake job.
2. An authenticated worker leases one stage at a time from the queue.
3. The worker reads only the source objects required by that job, runs the same
   stage schema, and writes a result plus its execution receipt.
4. The API verifies the stage result, advances the checkpoint, and queues the
   next stage. A lease timeout makes the stage retryable without repeating
   already completed stages.
5. Finished source working copies are removed from worker-local storage. The
   canonical upload and evidence ledger remain owned by Storyhold.

This should initially be a single autoscaled GPU-worker class, not a collection
of permanent model servers. Sequential model loading and queued intake keep
idle GPU cost low. Multiple worker classes are justified only after production
measurements show a real bottleneck.

## Gates before enabling remote execution

Remote execution remains disabled until all of these are measured and chosen:

- representative 50k, 150k, and 250k-word intake benchmarks;
- peak RAM and VRAM per stage, plus cold-load and inference time;
- retry/idempotency tests using the existing durable checkpoints;
- object-storage encryption, job authentication, lease expiry, and deletion
  policy;
- concurrency limits and a hard maximum cost per intake;
- a comparison of browser, CPU, rented GPU, and premium-provider cost and
  quality;
- privacy and terms wording that accurately describes where manuscripts run.

Until those gates are satisfied, `STORYHOLD_LOCAL_MODELS_ALLOW_REMOTE=false`
remains the required setting and all local-model endpoints must resolve to
loopback.

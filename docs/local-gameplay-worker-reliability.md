# Local Gameplay Worker Reliability — September 5, 2026

Subsequent product decision: [AI-led gameplay](ai-led-gameplay.md) removes these
specialist calls from normal live turns. The safeguards below remain relevant to
intake and explicitly invoked specialist operations; this document records the
failure and repair work, not the current default gameplay model sequence.

## Observed Failure

The first Taco Hell Test turn committed once, without paid AI or credit charges,
but its local semantic verification failed. The old pipeline spent about 60
seconds extracting two narration segments and then another 90 seconds extracting
the same prose again. Those were per-segment timeouts, not one overall deadline.

The installed GLiNER2 safetensors file is present (833,938,108 bytes) and its
header/data offsets are consistent. Logs contain Windows error 1455 (insufficient
system commit/pagefile capacity). GLiNER2 then tried an optional `.bin` file,
masking the original allocation failure as an offline model-cache error.
The supervisor's broad CUDA-to-CPU retry repeated failures that were unrelated to
GPU placement. HTTP disconnection did not cancel the Python worker's work.

## Changes

- Reuse the canon inspector's extraction for the gameplay postcheck.
- Bound gameplay narration extraction and NLI with one 30-second deadline.
  Failed gameplay extraction stops further segments; successful segments remain
  in the diagnostic receipt. Full manuscript intake retains its existing limits
  and checkpoint behavior.
- Preserve local errors and incomplete coverage in private diagnostics. Failed
  extraction is not a passed or skipped semantic check. Actual contradictions
  remain rejection conditions. Existing commit policy for unavailable semantic
  checks was not changed by this repair.
- The existing 2.5-second best-effort action precheck uses a resident model only.
  It does not repeatedly start and cancel a cold loader. Its `not_ready` result is
  explicit. Full narration validation and intake can still load the same model.
- Carry `deadlineUnixMs` into the worker supervisor. Cancel expired/disconnected
  requests and dispose their worker before permitting another inference.
- Reject concurrent inference immediately instead of accumulating waiting
  request threads. Preserve the one-resident-worker sequence.
- Retain the original chained allocation error. CPU retry is restricted to
  genuine GPU-placement failures, not missing files or Windows commit exhaustion.
- Refuse a new model load below 2 GiB available system commit and impose a
  60-second per-stage cooldown after worker failure. This is a minimum safeguard,
  not a promise that every model fits. No model weights, context sizes, Windows
  pagefile settings, or machine-wide configuration were changed.
- Coordinate shutdown with in-flight cancellation and the inference lock.
  Launcher shutdown waits for the supervisor and recorded worker, validates their
  identity, never force-kills the parent during cleanup, and preserves the PID
  marker if shutdown cannot be verified.
- Launcher installation probes use package metadata without importing PyTorch.
  Health distinguishes configured, loaded, loading, and cooldown-blocked stages.

## Verification / Deployment Boundary

Automated Python tests use fake workers, not model downloads. Backend tests use
mock/loopback services and in-memory databases; they do not contact a paid model
or replay the saved campaign turn. PowerShell launcher tests fully mock external
operations and do not stop a live service.

The user subsequently authorized a per-process PowerShell execution-policy
allowance. All 11 mocked launcher scenarios passed. The Python supervisor and
API were shut down cleanly and restarted on September 5, 2026. The API's
database owner released its lease and exited before restart; no force termination
was used. Runtime health now reports version 2 and request cancellation support.
No permanent Windows execution policy was changed.

Live API and isolated-browser checks confirmed the saved Taco Hell turn, game
state, and credits were unchanged. Opening gameplay did not load a model or
create a worker, consistent with the newer AI-led gameplay policy.

A real-model extraction/cancellation smoke test remains outstanding. These
activation checks intentionally did not warm large models on this memory-limited
laptop. Do not treat configured/idle health as proof that model inference works.
Do not resubmit the committed Taco Hell action or call premium AI for that test.

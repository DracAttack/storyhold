import type { PGlite } from "@electric-sql/pglite";
import type { Express, Request, RequestHandler, Response } from "express";
import {
  finalizePremiumRecovery,
  inspectPremiumRecovery,
  listPremiumRecoveries,
  PremiumRecoveryError,
  type PremiumRecoveryDetail,
  type PremiumRecoveryReceipt,
} from "./premiumReviewReconciliation";

type RecoveryDb = Pick<PGlite, "query" | "exec" | "transaction">;
type OperatorRequest = Request & { localUser?: { id: string; role: string } };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const serviceDefaults = { listPremiumRecoveries, inspectPremiumRecovery, finalizePremiumRecovery };

function containsCredentialLikeText(value: string): boolean {
  return [
    /\bbearer\s+[a-z0-9._~+/=-]{12,}/iu,
    /\bsk-(?:or-v1-|ant-(?:api\d{2}-)?)?[a-z0-9_-]{16,}/iu,
    /\b(?:openai|openrouter|anthropic|xai|mistral|google|gemini|groq|together|fireworks|perplexity)[_-]?api[_-]?key\s*[:=]\s*\S+/iu,
    /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/iu,
    /-----BEGIN OPENSSH PRIVATE KEY-----/iu,
  ].some((pattern) => pattern.test(value));
}

function safePublicText(value: string, fallback: string): string {
  return containsCredentialLikeText(value) ? fallback : value;
}

const publicErrors: Record<string, { status: number; message: string }> = {
  ACTIVE_WORKER: { status: 409, message: "A worker is still active for this world. No billing changes were made." },
  ALREADY_FINALIZED: { status: 409, message: "This review was already finalized with a different audit request." },
  COST_EXCEEDS_HOLD: { status: 409, message: "The verified usage exceeds the original credit hold. No additional credits were charged." },
  DECISIONS_REQUIRED: { status: 400, message: "Every unresolved provider step requires exactly one verified decision." },
  FORBIDDEN: { status: 403, message: "Only Storyhold owners and administrators can use Premium Recovery." },
  INSUFFICIENT_CREDITS: { status: 409, message: "The verified usage costs more than the original hold plus the paying account's available credits. No billing changes were made; add credits before retrying." },
  INVALID_COST: { status: 409, message: "The provider cost exceeds the supported accounting range." },
  INVALID_DECISION: { status: 400, message: "One or more provider decisions are incomplete or invalid." },
  INVALID_REQUEST: { status: 400, message: "The recovery request is incomplete or invalid." },
  KNOWN_COST_CONFLICT: { status: 400, message: "A verified step total is lower than usage already recorded for that step." },
  NOT_FINALIZABLE: { status: 409, message: "This saved review is not eligible for automatic recovery finalization." },
  NOT_FOUND: { status: 404, message: "Premium review not found." },
  RECEIPT_MISMATCH: { status: 409, message: "The saved receipt no longer matches this review. Manual investigation is required." },
  SETTLEMENT_MISMATCH: { status: 409, message: "The credit settlement did not match the verified provider usage." },
  STALE_FINGERPRINT: { status: 409, message: "The saved review changed. Inspect it again before finalizing." },
  STATE_CHANGED: { status: 409, message: "The saved review changed before closure could be recorded. No settlement was completed." },
};

function publicReceipt(receipt: PremiumRecoveryReceipt): PremiumRecoveryReceipt {
  return {
    id: receipt.id,
    actorId: receipt.actorId,
    note: safePublicText(receipt.note, "[Credential-like audit text redacted]"),
    decisions: receipt.decisions.map((decision) => ({
      stepKey: decision.stepKey,
      outcome: decision.outcome,
      costMicros: decision.costMicros,
      providerReference: safePublicText(decision.providerReference, "[Credential-like reference redacted]"),
    })),
    costMicros: receipt.costMicros,
    creditsUsed: receipt.creditsUsed,
    creditsRefunded: receipt.creditsRefunded,
    createdAt: receipt.createdAt,
  };
}

/** Keep the HTTP boundary explicit even if a service object later gains private fields. */
function publicReview(review: PremiumRecoveryDetail): PremiumRecoveryDetail {
  return {
    id: review.id,
    runId: review.runId,
    worldId: review.worldId,
    worldName: safePublicText(review.worldName, "Untitled World"),
    status: review.status,
    stage: review.stage,
    progress: review.progress,
    createdAt: review.createdAt,
    fingerprint: review.fingerprint,
    recoveryMode: review.recoveryMode,
    canFinalize: review.canFinalize,
    blockReason: review.blockReason,
    reservedCredits: review.reservedCredits,
    knownCostMicros: review.knownCostMicros,
    steps: review.steps.map((step) => ({
      stepKey: step.stepKey,
      status: step.status,
      provider: safePublicText(step.provider, "Unrecorded Provider"),
      model: safePublicText(step.model, "Unrecorded Model"),
      knownCostMicros: step.knownCostMicros,
      needsDecision: step.needsDecision,
      dispatchedAt: step.dispatchedAt,
      lastRecordedAt: step.lastRecordedAt,
    })),
    receipt: review.receipt ? publicReceipt(review.receipt) : null,
  };
}

/** This private operator surface never returns provider prompts or source text. */
export function registerPremiumRecoveryRoutes(params: {
  app: Express;
  db: RecoveryDb;
  requireUser: RequestHandler;
  isWorldWorkerActive: (worldId: string) => boolean;
  services?: typeof serviceDefaults;
}) {
  const { app, db, requireUser, isWorldWorkerActive } = params;
  const service = params.services ?? serviceDefaults;
  const base = "/api/storyhold/admin/premium-recovery";

  async function operator(req: OperatorRequest, res: Response): Promise<string | null> {
    res.setHeader("Cache-Control", "no-store");
    const id = req.localUser?.id;
    if (!id || !uuid.test(id)) {
      res.status(401).json({ code: "UNAUTHENTICATED", error: "Sign in to use Premium Recovery." });
      return null;
    }
    // Do not trust a client-supplied role or even a previously cached session role.
    const account = await db.query<{ role: string }>("SELECT role FROM storyhold.players WHERE id = $1", [id]);
    if (!["owner", "admin"].includes(account.rows[0]?.role ?? "")) {
      res.status(403).json({ code: "FORBIDDEN", error: publicErrors.FORBIDDEN.message });
      return null;
    }
    return id;
  }

  function runId(req: Request, res: Response): string | null {
    const value = req.params.runId;
    if (typeof value !== "string" || !uuid.test(value)) {
      res.status(404).json({ code: "NOT_FOUND", error: publicErrors.NOT_FOUND.message });
      return null;
    }
    return value;
  }

  function failure(res: Response, error: unknown) {
    if (error instanceof PremiumRecoveryError) {
      const safe = publicErrors[error.code];
      if (safe) {
        res.status(safe.status).json({ code: error.code, error: safe.message });
        return;
      }
    }
    // Unexpected SQL/provider errors may contain private values. Keep them off the wire.
    res.status(500).json({ error: "Premium Recovery could not complete this request. Refresh and check the saved state before trying again." });
  }

  function liveStatus<T extends { worldId: string; canFinalize: boolean; blockReason: string | null }>(review: T): T {
    return isWorldWorkerActive(review.worldId)
      ? { ...review, canFinalize: false, blockReason: "A worker is still active for this world. Stop the worker safely before closing this review." }
      : review;
  }

  app.get(base, requireUser, async (req: OperatorRequest, res) => {
    try {
      const actorId = await operator(req, res);
      if (!actorId) return;
      res.json({ runs: (await service.listPremiumRecoveries(db, actorId)).map(publicReview).map(liveStatus) });
    } catch (error) { failure(res, error); }
  });

  app.get(`${base}/:runId`, requireUser, async (req: OperatorRequest, res) => {
    try {
      const actorId = await operator(req, res);
      if (!actorId) return;
      const id = runId(req, res);
      if (!id) return;
      res.json({ review: liveStatus(publicReview(await service.inspectPremiumRecovery(db, { actorId, runId: id }))) });
    } catch (error) { failure(res, error); }
  });

  app.post(`${base}/:runId/finalize`, requireUser, async (req: OperatorRequest, res) => {
    try {
      const actorId = await operator(req, res);
      if (!actorId) return;
      const id = runId(req, res);
      if (!id) return;
      if (!req.is("application/json") || !req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
        res.status(400).json({ code: "INVALID_REQUEST", error: "Send a JSON recovery decision." });
        return;
      }
      if (typeof req.body.note === "string" && containsCredentialLikeText(req.body.note)) {
        res.status(400).json({ code: "INVALID_REQUEST", error: "Remove credentials and authorization tokens from the audit note." });
        return;
      }
      if (Array.isArray(req.body.decisions) && req.body.decisions.some((decision: unknown) => {
        if (!decision || typeof decision !== "object") return false;
        const reference = (decision as { providerReference?: unknown }).providerReference;
        return typeof reference === "string" && containsCredentialLikeText(reference);
      })) {
        res.status(400).json({ code: "INVALID_DECISION", error: "Provider evidence must contain only a request or invoice reference, never credentials." });
        return;
      }
      const review = await service.inspectPremiumRecovery(db, { actorId, runId: id });
      if (!review.receipt && isWorldWorkerActive(review.worldId)) {
        res.status(409).json({ code: "ACTIVE_WORKER", error: publicErrors.ACTIVE_WORKER.message });
        return;
      }
      const result = await service.finalizePremiumRecovery(db, {
        actorId,
        runId: id,
        expectedFingerprint: req.body.expectedFingerprint,
        note: req.body.note,
        confirmProviderChecked: req.body.confirmProviderChecked,
        decisions: req.body.decisions,
      }, { isWorldWorkerActive });
      const reviewDto = publicReview(result);
      res.json({ receipt: reviewDto.receipt, review: reviewDto });
    } catch (error) { failure(res, error); }
  });
}

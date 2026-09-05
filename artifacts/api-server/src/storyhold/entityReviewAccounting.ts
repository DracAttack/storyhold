import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { combineAiUsage, type AiBillableAttempt, type AiUsage } from "./aiGateway";
import { canonPayloadFingerprint, type JsonObject } from "./analysisVerificationContracts";
import { creditsForUsage, settleCreditReservationInTransaction } from "./creditEconomy";
import { finalizeEntityReviewCall, lockEntityReviewCallForFinalization, type EntityReviewCallRow, type EntityReviewCallScope } from "./entityReviewJournal";

type Db = Pick<PGlite, "query" | "exec">;
const NUMERIC_USAGE = ["inputUnits", "outputUnits", "cachedInputUnits", "cacheWriteInputUnits", "reasoningUnits", "estimatedCostMicros"] as const;
export class EntityReviewAccountingError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "EntityReviewAccountingError"; }
}
function fail(code: string, message: string): never { throw new EntityReviewAccountingError(code, message); }
function hash(value: unknown): string { return canonPayloadFingerprint(value as JsonObject); }
function knownUsage(value: unknown): value is AiUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  return usage.pricingKnown === true && typeof usage.pricingVersion === "string" && usage.pricingVersion.length > 0
    && NUMERIC_USAGE.every((key) => typeof usage[key] === "number" && Number.isSafeInteger(usage[key]) && usage[key] >= 0);
}
function strictAttempts(value: unknown): AiBillableAttempt[] {
  if (!Array.isArray(value) || !value.length) fail("DOSSIER_ACCOUNTING_UNCERTAIN", "The dossier call has no complete known provider usage inventory.");
  for (const attempt of value) {
    if (!attempt || typeof attempt !== "object" || !knownUsage(attempt.usage)
      || typeof attempt.provider !== "string" || !attempt.provider.trim()
      || typeof attempt.model !== "string" || !attempt.model.trim()
      || typeof attempt.resolvedModel !== "string" || !attempt.resolvedModel.trim()
      || attempt.stage !== "dossier" || !["low", "medium", "high"].includes(attempt.reasoning)) {
      fail("DOSSIER_ACCOUNTING_UNCERTAIN", "A provider attempt has incomplete or unknown dossier usage; explicit reconciliation is required.");
    }
  }
  const attempts = structuredClone(value) as AiBillableAttempt[];
  const total = combineAiUsage(attempts.map((attempt) => attempt.usage));
  if (!knownUsage(total)) fail("DOSSIER_ACCOUNTING_RANGE", "The dossier usage total exceeds supported accounting limits.");
  return attempts;
}

/** Customer-safe funding state for a saved dossier outcome. Provider routing
 * stays in the private journal; this exposes only whether the already-finished
 * work can settle and, if not, the exact post-run top-up still needed. */
export function savedEntityReviewFundingStatus(
  call: Pick<EntityReviewCallRow, "status" | "billable_attempts" | "reserved_credits" | "unlimited" | "finalization_snapshot">,
  availableCredits: number,
): {
  settlementReady: boolean;
  topUpCreditsNeeded: number;
  additionalCreditsDue: number;
} | null {
  if (call.finalization_snapshot || !["completed", "rejected"].includes(call.status)) return null;
  if (call.unlimited) {
    return { settlementReady: true, topUpCreditsNeeded: 0, additionalCreditsDue: 0 };
  }
  const usage = combineAiUsage(strictAttempts(call.billable_attempts).map((attempt) => attempt.usage));
  const actualCredits = creditsForUsage(usage);
  const heldCredits = Math.max(0, Number(call.reserved_credits) || 0);
  const additionalCreditsDue = Math.max(0, actualCredits - heldCredits);
  const spendableCredits = Math.max(0, Math.floor(Number(availableCredits) || 0));
  const topUpCreditsNeeded = Math.max(0, additionalCreditsDue - spendableCredits);
  return {
    settlementReady: topUpCreditsNeeded === 0,
    topUpCreditsNeeded,
    additionalCreditsDue,
  };
}

/** Caller owns the transaction, allowing the canonical write, every usage row,
 * credit settlement, and immutable HTTP result to commit or roll back together. */
export async function settleEntityReviewAccountingInTransaction(db: Db, params: {
  scope: EntityReviewCallScope; outcome: "applied" | "not_applied"; response?: JsonObject;
}): Promise<JsonObject> {
  const call = await lockEntityReviewCallForFinalization(db, params.scope);
  if (call.finalization_snapshot) return structuredClone(call.finalization_snapshot);
  if (params.outcome !== "applied" && params.outcome !== "not_applied") fail("DOSSIER_ACCOUNTING_OUTCOME", "The dossier application outcome is invalid.");
  if (!["completed", "rejected"].includes(call.status)) fail("DOSSIER_ACCOUNTING_UNCERTAIN", "The provider outcome is unresolved; credits remain reserved pending reconciliation.");
  if (params.outcome === "applied" && call.status !== "completed") fail("DOSSIER_ACCOUNTING_OUTCOME", "A rejected provider response cannot be recorded as applied.");
  const attempts = strictAttempts(call.billable_attempts);
  if (call.status === "completed") {
    const result = call.result_snapshot;
    if (!result || !knownUsage(result.usage)) fail("DOSSIER_ACCOUNTING_UNCERTAIN", "The saved completed result has no trusted provider usage.");
    const expected = [...(result.priorBillableAttempts ?? []), {
      provider: result.provider, model: result.model, resolvedModel: result.runtime.execution?.resolvedModel ?? result.model,
      upstreamProvider: result.runtime.execution?.upstreamProvider ?? null, stage: result.runtime.stage, reasoning: result.reasoning, usage: result.usage,
    }];
    if (hash(expected) !== hash(attempts)) fail("DOSSIER_ACCOUNTING_INVENTORY", "The saved provider result and billable attempt inventory disagree.");
  }
  const usage = combineAiUsage(attempts.map((attempt) => attempt.usage));
  const last = attempts.at(-1)!;
  const existingUsage = await db.query("SELECT id FROM storyhold.ai_usage_ledger WHERE operation = 'entity_review' AND request_id = $1 LIMIT 1", [params.scope.reviewId]);
  if (existingUsage.rows.length) fail("DOSSIER_ACCOUNTING_DUPLICATE", "Usage exists without an immutable dossier finalization; explicit reconciliation is required.");
  let creditsUsed = 0; let creditsRemaining = 0; let uncoveredCredits = 0;
  if (call.unlimited) {
    if (call.reservation_id !== null || Number(call.reserved_credits) !== 0) fail("DOSSIER_ACCOUNTING_FUNDING", "An exempt dossier review cannot carry a metered hold.");
    const player = (await db.query<{ credits: number; role: string }>("SELECT credits, role FROM storyhold.players WHERE id = $1 FOR UPDATE", [params.scope.playerId])).rows[0];
    if (!player || !["owner", "admin"].includes(player.role)) fail("DOSSIER_ACCOUNTING_FUNDING", "The original exempt account must remain an owner or administrator.");
    creditsRemaining = Number(player.credits);
  } else {
    if (!call.reservation_id) fail("DOSSIER_ACCOUNTING_FUNDING", "The dossier review is missing its original credit hold.");
    const hold = (await db.query<Record<string, unknown>>("SELECT * FROM storyhold.credit_reservations WHERE id = $1 FOR UPDATE", [call.reservation_id])).rows[0];
    const metadata = hold?.usage as Record<string, unknown> | undefined;
    if (!hold || hold.player_id !== params.scope.playerId || hold.world_id !== params.scope.worldId
      || hold.operation !== "entity_review" || hold.request_id !== params.scope.reviewId || hold.status !== "reserved"
      || Number(hold.reserved_credits) !== Number(call.reserved_credits) || metadata?.retainUntilReconciled !== true
      || metadata.entityReviewJournalId !== params.scope.reviewId) {
      fail("DOSSIER_ACCOUNTING_FUNDING", "The original retained credit reservation no longer matches this dossier review.");
    }
    const settlement = await settleCreditReservationInTransaction(db, { reservationId: call.reservation_id,
      usage, provider: last.provider, model: last.resolvedModel, reasoning: last.reasoning,
      requireFullPayment: true });
    ({ creditsUsed, creditsRemaining, uncoveredCredits } = settlement);
    if (uncoveredCredits > 0) {
      fail("DOSSIER_ACCOUNTING_FUNDING", "The dossier review could not be fully settled.");
    }
    await db.query("UPDATE storyhold.credit_reservations SET usage = usage || $2::jsonb WHERE id = $1", [call.reservation_id,
      JSON.stringify({ accountingSource: "entity_review_journal", entityReviewJournalId: params.scope.reviewId, entityId: params.scope.entityId,
        outcome: params.outcome, billableAttempts: attempts, uncoveredCredits })]);
  }
  let assignedCredits = 0; let cumulativeCost = 0;
  for (const [index, attempt] of attempts.entries()) {
    cumulativeCost += attempt.usage.estimatedCostMicros;
    const cumulativeCredits = usage.estimatedCostMicros > 0
      ? Number(BigInt(creditsUsed) * BigInt(cumulativeCost) / BigInt(usage.estimatedCostMicros)) : 0;
    const attemptCredits = cumulativeCredits - assignedCredits; assignedCredits = cumulativeCredits;
    await db.query(`INSERT INTO storyhold.ai_usage_ledger
      (id, player_id, world_id, campaign_id, operation, provider, model, input_units, output_units,
       cached_input_units, cache_write_input_units, reasoning_units, cost_micros, cache_hit, pricing_version,
       credits_charged, request_id, metadata)
      VALUES ($1, $2, $3, NULL, 'entity_review', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)`, [
      randomUUID(), params.scope.playerId, params.scope.worldId, attempt.provider, attempt.resolvedModel,
      attempt.usage.inputUnits, attempt.usage.outputUnits, attempt.usage.cachedInputUnits, attempt.usage.cacheWriteInputUnits,
      attempt.usage.reasoningUnits, attempt.usage.estimatedCostMicros, attempt.usage.cachedInputUnits > 0, attempt.usage.pricingVersion,
      attemptCredits, params.scope.reviewId, JSON.stringify({ accountingSource: "entity_review_journal", entityId: params.scope.entityId,
        reviewId: params.scope.reviewId, attemptIndex: index, attemptCount: attempts.length, outcome: params.outcome,
        requestedModel: attempt.model, resolvedModel: attempt.resolvedModel, upstreamProvider: attempt.upstreamProvider,
        stage: attempt.stage, reasoning: attempt.reasoning, usageFingerprint: hash(attempt.usage), uncoveredCredits }),
    ]);
  }
  if (assignedCredits !== creditsUsed) fail("DOSSIER_ACCOUNTING_ALLOCATION", "Dossier credit allocation does not match its settled total.");
  const { provider: _provider, model: _model, ...publicResponse } = params.response ?? {};
  const finalized: JsonObject = { ...publicResponse, reviewed: params.outcome === "applied", entityId: params.scope.entityId,
    creditsUsed, creditsRemaining, unlimited: call.unlimited };
  if (params.outcome === "not_applied") {
    const explanation = typeof finalized.error === "string" ? finalized.error : "The review could not be applied to your dossier.";
    finalized.error = creditsUsed > 0
      ? `${explanation} ${creditsUsed.toLocaleString("en-US")} credits were used for the review already performed; resuming will not charge them again.`
      : explanation;
  }
  await finalizeEntityReviewCall(db, params.scope, finalized);
  return structuredClone(finalized);
}

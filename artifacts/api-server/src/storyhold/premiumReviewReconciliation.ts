import { createHash, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { AiUsage } from "./aiGateway";
import { canonPayloadFingerprint, type JsonObject } from "./analysisVerificationContracts";
import {
  CreditEconomyError,
  creditsForProviderCost,
  settleCreditReservationInTransaction,
} from "./creditEconomy";
import {
  PREMIUM_CLOCK_PAGES_PER_VERIFICATION_BATCH_LIMIT,
  readPremiumReviewPlan,
  type PremiumReviewPlan,
} from "./premiumReviewPlan";
import {
  LEGACY_PREMIUM_RECOVERY_MODEL,
  LEGACY_PREMIUM_RECOVERY_PROVIDER,
  LEGACY_PREMIUM_RECOVERY_TOTAL_STEP_KEY,
  exactTrustedAttempt,
  exactTrustedUsage,
  legacyPremiumRecoveryFundingFingerprint,
  plannedJournalScopeMatches,
  premiumReviewFinalizationMatches,
  readSettledPremiumRecoveryAccounting,
  readPremiumJournalSnapshot,
  SETTLED_PREMIUM_RECOVERY_MODE,
  type LegacyPremiumRecoveryFundingIdentity,
  type PremiumJournalRow,
  type SettledPremiumRecoveryAccounting,
} from "./premiumReviewJournal";

type Db = Pick<PGlite, "query" | "exec" | "transaction">;
type QueryDb = Pick<PGlite, "query">;
type Row = Record<string, unknown>;
type RecoveryOptions = { isWorldWorkerActive?: (worldId: string) => boolean };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CANCELLATION_STAGE = "Premium review reconciled and cancelled";
const REDACTED_OPERATOR_TEXT = "[redacted sensitive value]";
const CREDENTIAL_LIKE_PATTERNS = [
  /\bbearer\s+[a-z0-9._~+/=-]{12,}/iu,
  /\bsk-(?:or-v1-|ant-)?[a-z0-9_-]{12,}/iu,
  /\b[a-z][a-z0-9_]{1,80}_api_key\s*[:=]\s*\S+/iu,
  /-----BEGIN (?:[A-Z0-9]+ )*(?:OPENSSH )?PRIVATE KEY-----/u,
];

export type PremiumRecoveryDecision = {
  stepKey: string;
  outcome: "no_charge" | "charged";
  /** Total for the entire step, including any already-known billable attempts. */
  costMicros: number;
  providerReference: string;
};
export type PremiumRecoveryReceipt = {
  id: string;
  actorId: string;
  note: string;
  decisions: PremiumRecoveryDecision[];
  costMicros: number;
  creditsUsed: number;
  creditsRefunded: number;
  createdAt: string;
};
export type PremiumRecoveryMode =
  | "planned_attestation"
  | "legacy_total_attestation"
  | "settled_accounting_adoption";
export type PremiumRecoveryStep = {
  stepKey: string;
  status: string;
  provider: string;
  model: string;
  knownCostMicros: number | null;
  needsDecision: boolean;
  dispatchedAt: string | null;
  lastRecordedAt: string | null;
};
export type PremiumRecoveryDetail = {
  id: string;
  runId: string;
  worldId: string;
  worldName: string;
  status: string;
  stage: string;
  progress: number;
  createdAt: string | null;
  fingerprint: string;
  recoveryMode: PremiumRecoveryMode;
  canFinalize: boolean;
  blockReason: string | null;
  reservedCredits: number;
  knownCostMicros: number;
  steps: PremiumRecoveryStep[];
  receipt: PremiumRecoveryReceipt | null;
};
type StoredReceipt = PremiumRecoveryReceipt & {
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  runId: string;
  worldId: string;
  playerId: string;
  reservationId: string | null;
  reservedCredits?: number;
  expectedFingerprint: string;
  journalFingerprint: string;
  planFingerprint: string | null;
  reconciliationMode?: "legacy_retained_hold" | "settled_accounting_adoption";
  legacyFundingFingerprint?: string;
  syntheticStepKey?: string;
  settledFundingFingerprint?: string;
  settlementLedgerFingerprint?: string;
  usageLedgerFingerprint?: string;
  clockManifestFingerprint?: string | null;
  requiredCredits?: number;
  uncoveredCredits?: number;
  finalRunFingerprint: string;
  finalReservationFingerprint: string;
  receiptFingerprint?: string;
};
type ReceiptRow = { request_fingerprint: string; journal_fingerprint: string; receipt: unknown };
type State = {
  detail: PremiumRecoveryDetail;
  run: Row;
  reservation: Row | null;
  plan: PremiumReviewPlan | null;
  journalFingerprint: string;
  planFingerprint: string | null;
  storedReceipt: ReceiptRow | null;
  validatedReceipt: StoredReceipt | null;
  knownByStep: Map<string, number>;
  funding: {
    mode: "planned" | "legacy_retained_hold" | "settled_accounting_adoption";
    reservationId: string | null;
    reservedCredits: number;
    unlimited: boolean;
    provider: string;
    model: string;
    fingerprint: string | null;
    settledAccounting: SettledPremiumRecoveryAccounting | null;
  } | null;
};

export class PremiumRecoveryError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 409) {
    super(message);
    this.name = "PremiumRecoveryError";
  }
}
function fail(code: string, message: string, statusCode = 409): never {
  throw new PremiumRecoveryError(code, message, statusCode);
}
function hash(value: unknown): string {
  return canonPayloadFingerprint(JSON.parse(JSON.stringify(value)) as JsonObject);
}
function sealStoredReceipt(receipt: Omit<StoredReceipt, "receiptFingerprint">): StoredReceipt {
  return {
    ...receipt,
    receiptFingerprint: hash({
      namespace: "storyhold:premium-reconciliation-receipt:v1",
      receipt,
    }),
  };
}
function reconciliationRequestFingerprint(params: {
  receiptVersion: 3 | 4 | 5 | 6 | 7 | 8;
  recoveryMode: PremiumRecoveryMode;
  actorId: string;
  runId: string;
  expectedFingerprint: string;
  note: string;
  decisions: PremiumRecoveryDecision[];
}): string {
  return hash({
    namespace: "storyhold:premium-reconciliation-request:v2",
    receiptVersion: params.receiptVersion,
    recoveryMode: params.recoveryMode,
    actorId: params.actorId,
    runId: params.runId,
    expectedFingerprint: params.expectedFingerprint,
    note: params.note,
    decisions: params.decisions,
  });
}
// The original worker's frozen-scope hash uses locale-sorted JSON, without the
// canon payload namespace. Keep this compatible with worldStudio's exported
// lorekeeperSnapshotFingerprint (covered by a production-shape test).
function scopeJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(scopeJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Row;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined)
      .sort((a, b) => a.localeCompare(b)).map((key) => `${JSON.stringify(key)}:${scopeJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function scopeHash(value: unknown): string { return createHash("sha256").update(scopeJson(value)).digest("hex"); }
function originalEvidencePin(run: Row): Row {
  const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
  return {
    parentLocalRunId: text(run.parent_local_run_id, 64), corpusFingerprint: text(run.corpus_fingerprint, 128),
    evidenceGraphFingerprint: text(run.evidence_graph_fingerprint, 128),
    constraintSnapshotFingerprint: text(run.constraint_snapshot_fingerprint, 128),
    verificationContextFingerprint: text(run.verification_context_fingerprint, 128),
    verificationPacketVersion: Number(run.verification_packet_version ?? 0),
  };
}
function validInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function addCost(left: number, right: number): number {
  const total = left + right;
  if (!validInteger(total)) fail("INVALID_COST", "Provider costs exceed the supported accounting range.");
  return total;
}
function timestamp(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
function identifier(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._:/@+ -]{0,199}$/iu.test(value) ? value : fallback;
}
function containsCredentialLikeText(value: string): boolean {
  return CREDENTIAL_LIKE_PATTERNS.some((pattern) => pattern.test(value));
}
function publicOperatorText(value: string): string {
  return containsCredentialLikeText(value) ? REDACTED_OPERATOR_TEXT : value;
}
function checkId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !UUID.test(value)) fail("INVALID_REQUEST", "A valid account and review ID are required.", 400);
}
async function authorize(db: QueryDb, actorId: string, lock = false): Promise<void> {
  checkId(actorId);
  const actor = await db.query<{ role: string }>(
    `SELECT role FROM storyhold.players WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [actorId],
  );
  if (!["owner", "admin"].includes(actor.rows[0]?.role ?? "")) {
    fail("FORBIDDEN", "Only a current owner or administrator can reconcile premium reviews.", 403);
  }
}
function stepAccounting(row: PremiumJournalRow): { step: PremiumRecoveryStep; known: number } {
  let known = 0;
  let complete = ["completed", "rejected"].includes(row.status) && row.billable_attempts.length > 0;
  for (const attempt of row.billable_attempts) {
    if (!exactTrustedAttempt(attempt)) complete = false;
    else known = addCost(known, attempt.usage.estimatedCostMicros);
  }
  // Completed results must agree with the attempt journal before being treated
  // as fully known; a legacy result with no attempt inventory is not free.
  if (row.status === "completed") {
    const result = row.result_snapshot;
    if (!result) complete = false;
    else {
      let resultKnown = exactTrustedUsage(result.usage) ? result.usage.estimatedCostMicros : 0;
      if (!exactTrustedUsage(result.usage)) complete = false;
      const prior = Array.isArray(result.priorBillableAttempts) ? result.priorBillableAttempts : [];
      for (const attempt of prior) {
        if (exactTrustedAttempt(attempt)) resultKnown = addCost(resultKnown, attempt.usage.estimatedCostMicros);
        else complete = false;
      }
      // A partially recorded attempt inventory cannot erase known charges in
      // the separately fingerprinted result. These are competing inventories
      // of the same work, so use their maximum, never double-count them.
      known = Math.max(known, resultKnown);
      const expected = [...prior, {
        provider: result.provider, model: result.model,
        resolvedModel: result.runtime.execution?.resolvedModel ?? result.model,
        upstreamProvider: result.runtime.execution?.upstreamProvider ?? null,
        stage: result.runtime.stage, reasoning: result.reasoning, usage: result.usage,
      }];
      if (expected.some((attempt) => !exactTrustedAttempt(attempt))) complete = false;
      if (hash(row.billable_attempts) !== hash(expected)) complete = false;
    }
  }
  return {
    known,
    step: {
      stepKey: identifier(row.step_key), status: row.status,
      provider: identifier(row.request_snapshot.provider), model: identifier(row.request_snapshot.model),
      knownCostMicros: complete ? known : known > 0 ? known : null,
      needsDecision: !complete,
      dispatchedAt: timestamp(row.dispatched_at ?? row.created_at),
      lastRecordedAt: timestamp(row.updated_at ?? row.completed_at ?? row.dispatched_at ?? row.created_at),
    },
  };
}
function publicReceipt(receipt: StoredReceipt): PremiumRecoveryReceipt {
  return {
    id: receipt.id, actorId: receipt.actorId, note: publicOperatorText(receipt.note),
    decisions: receipt.decisions.map((decision) => ({
      stepKey: decision.stepKey,
      outcome: decision.outcome,
      costMicros: decision.costMicros,
      providerReference: publicOperatorText(decision.providerReference),
    })),
    costMicros: receipt.costMicros, creditsUsed: receipt.creditsUsed,
    creditsRefunded: receipt.creditsRefunded, createdAt: receipt.createdAt,
  };
}

function receiptForProjection(value: unknown): StoredReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  if (![1, 2, 3, 4, 5, 6, 7, 8].includes(Number(receipt.version))
    || typeof receipt.id !== "string" || !UUID.test(receipt.id)
    || typeof receipt.actorId !== "string" || !UUID.test(receipt.actorId)
    || typeof receipt.note !== "string"
    || !validInteger(receipt.costMicros) || !validInteger(receipt.creditsUsed)
    || !validInteger(receipt.creditsRefunded)
    || typeof receipt.createdAt !== "string" || !Number.isFinite(Date.parse(receipt.createdAt))
    || !Array.isArray(receipt.decisions) || receipt.decisions.length > 10_000
    || receipt.decisions.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return true;
      const decision = item as Record<string, unknown>;
      return typeof decision.stepKey !== "string"
        || (decision.outcome !== "no_charge" && decision.outcome !== "charged")
        || !validInteger(decision.costMicros)
        || typeof decision.providerReference !== "string";
    })) return null;
  return value as StoredReceipt;
}

async function readState(db: QueryDb, runId: string, options: RecoveryOptions = {}, lock = false): Promise<State> {
  checkId(runId);
  const initial = await db.query<{ world_id: string }>("SELECT world_id FROM storyhold.world_analysis_runs WHERE id = $1", [runId]);
  if (!initial.rows[0]) fail("NOT_FOUND", "Premium review not found.", 404);
  const worldId = initial.rows[0].world_id;
  const world = await db.query<{ name: string }>(
    `SELECT name FROM storyhold.worlds WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [worldId],
  );
  const result = await db.query<Row>(
    `SELECT * FROM storyhold.world_analysis_runs WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [runId],
  );
  const run = result.rows[0];
  if (!run || run.world_id !== worldId || run.analysis_kind !== "ai_enrichment") fail("NOT_FOUND", "Premium review not found.", 404);
  let blockReason: string | null = null;
  const block = (reason: string) => { blockReason ??= reason; };
  if (!["paused", "failed"].includes(String(run.status))) block("Only an inactive paused or failed review can be finalized.");
  if (options.isWorldWorkerActive?.(worldId)) block("This world still has an active worker. Wait for it to stop before finalizing.");
  const competing = await db.query(
    "SELECT id FROM storyhold.world_analysis_runs WHERE world_id = $1 AND id <> $2 AND status IN ('queued', 'running') LIMIT 1",
    [worldId, runId],
  );
  if (competing.rows.length) block("Another review in this world is active.");
  let plan: PremiumReviewPlan | null = null;
  let planReadFailed = false;
  try { plan = await readPremiumReviewPlan(db, runId); }
  catch {
    planReadFailed = true;
    block("The saved execution plan failed its integrity check; manual investigation is required.");
  }
  if (plan && (plan.worldId !== worldId || plan.editionId !== run.canon_edition_id
    || plan.playerId !== run.requested_by_player_id || plan.provider !== run.provider || plan.model !== run.model)) {
    block("The review no longer matches its original execution plan.");
  }
  const planFingerprint = plan ? hash(plan) : null;
  const evidence = originalEvidencePin(run);
  if (plan && (scopeHash(evidence) !== plan.scopeFingerprint
    || scopeHash(run.verification_context_snapshot ?? {}) !== evidence.verificationContextFingerprint)) {
    block("The original frozen evidence scope failed its integrity check.");
  }
  const requestScopeFingerprint = scopeHash({ evidence, plan });
  let reservation: Row | null = null;
  if (plan?.reservationId) {
    reservation = (await db.query<Row>(
      `SELECT * FROM storyhold.credit_reservations WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [plan.reservationId],
    )).rows[0] ?? null;
  }
  const relatedHolds = await db.query<Row>(
    `SELECT * FROM storyhold.credit_reservations
      WHERE operation = 'world_analysis' AND request_id = $1${lock ? " FOR UPDATE" : ""}`,
    [runId],
  );
  if (plan && relatedHolds.rows.some((hold) => hold.id !== plan.reservationId)) {
    block("The review has conflicting credit reservation identities.");
  }
  if (plan?.unlimited && relatedHolds.rows.length > 0) {
    block("An exempt review cannot also have a credit reservation.");
  }
  if (!plan && relatedHolds.rows.length === 1) reservation = relatedHolds.rows[0] ?? null;
  const payer = await db.query<{ role: string }>(
    `SELECT role FROM storyhold.players WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [run.requested_by_player_id],
  );
  if (!payer.rows[0]) block("The original paying account is unavailable.");
  if (plan?.unlimited && !["owner", "admin"].includes(payer.rows[0]?.role ?? "")) {
    block("The original exempt review requires its player's current owner or administrator role.");
  }
  if (plan && !plan.unlimited && (!reservation || reservation.world_id !== worldId
    || reservation.player_id !== run.requested_by_player_id || reservation.operation !== "world_analysis"
    || reservation.request_id !== runId || Number(reservation.reserved_credits) !== plan.reservedCredits)) {
    block("The exact original credit reservation does not match this review.");
  }
  let journalFingerprint = "invalid";
  const steps: PremiumRecoveryStep[] = [];
  const knownByStep = new Map<string, number>();
  let knownCostMicros = 0;
  let journalCallCount = 0;
  let legacySentinelCollision = false;
  try {
    const journal = await readPremiumJournalSnapshot(db, runId);
    journalFingerprint = journal.fingerprint;
    journalCallCount = journal.rows.length;
    if (plan && !(await plannedJournalScopeMatches(
      db,
      plan as unknown as Row,
      run,
      journal.rows,
    ))) {
      block("The saved provider journal does not match the original execution order and scope; manual investigation is required.");
    }
    for (const row of journal.rows) {
      if (identifier(row.step_key) !== row.step_key) block("A stored provider step has an invalid identifier.");
      if (!plan && row.step_key === LEGACY_PREMIUM_RECOVERY_TOTAL_STEP_KEY) {
        legacySentinelCollision = true;
        block("A legacy provider step collides with Storyhold's aggregate recovery boundary; manual investigation is required.");
      }
      if (plan && (row.request_snapshot.scopeFingerprint !== requestScopeFingerprint
        || row.request_snapshot.provider !== plan.provider || row.request_snapshot.model !== plan.model)) {
        block("A provider call does not match the original execution scope.");
      }
      const accounting = stepAccounting(row);
      // Without an immutable plan there is no proof that surviving rows are a
      // complete inventory. They remain useful as a cost lower bound, but one
      // aggregate provider attestation accounts for the whole legacy review.
      steps.push(plan ? accounting.step : { ...accounting.step, needsDecision: false });
      knownByStep.set(row.step_key, accounting.known);
      knownCostMicros = addCost(knownCostMicros, accounting.known);
    }
  } catch {
    block("The saved provider journal or usage failed its integrity check; manual investigation is required.");
  }
  let funding: State["funding"] = plan ? {
    mode: "planned",
    reservationId: plan.reservationId,
    reservedCredits: plan.reservedCredits,
    unlimited: plan.unlimited,
    provider: plan.provider,
    model: plan.model,
    fingerprint: null,
    settledAccounting: null,
  } : null;
  if (plan && !plan.unlimited && reservation?.status === "settled" && String(run.status) === "paused") {
    const settledAccounting = await readSettledPremiumRecoveryAccounting(db, {
      runId,
      worldId,
      editionId: String(run.canon_edition_id),
      playerId: String(run.requested_by_player_id),
      reservationId: String(plan.reservationId),
      reservedCredits: Number(plan.reservedCredits),
      planVersion: plan.version,
      verificationStepKeys: (plan.version === 2 || plan.version === 3)
        ? plan.verificationPages.map((page) => page.stepKey)
        : plan.verificationBatches.map((_batch, index) => `verification:${index}`),
      maximumChronologySteps: plan.verificationBatches.length
        * PREMIUM_CLOCK_PAGES_PER_VERIFICATION_BATCH_LIMIT,
      requestScopeFingerprint,
      requestProvider: plan.provider,
      requestModel: plan.model,
    });
    if (!settledAccounting) {
      block("The already-settled credit record does not exactly match the immutable plan, provider journal, and accounting ledgers; manual investigation is required.");
    } else {
      funding = {
        mode: "settled_accounting_adoption",
        reservationId: String(plan.reservationId),
        reservedCredits: Number(plan.reservedCredits),
        unlimited: false,
        provider: settledAccounting.provider,
        model: settledAccounting.model,
        fingerprint: settledAccounting.fundingFingerprint,
        settledAccounting,
      };
    }
  }
  if (!plan && !planReadFailed && !legacySentinelCollision) {
    if (relatedHolds.rows.length !== 1 || !reservation) {
      block("A legacy review requires exactly one original retained credit hold before it can be reconciled.");
    } else {
      const reservedCredits = Number(reservation.reserved_credits);
      const identityValid = typeof reservation.id === "string" && UUID.test(reservation.id)
        && reservation.world_id === worldId
        && reservation.player_id === run.requested_by_player_id
        && reservation.operation === "world_analysis"
        && reservation.request_id === runId
        && Number.isSafeInteger(reservedCredits) && reservedCredits > 0
        && Number(run.premium_ai_credits_charged ?? 0) === 0;
      if (!identityValid) {
        block("The legacy review's exact original credit hold does not match its world and paying account.");
      } else {
        const usage = reservation.usage as Row | null;
        const provablyUnusedModernHold = journalCallCount === 0 && usage?.premiumResumeVersion === 1;
        if (provablyUnusedModernHold) {
          block("This modern review stopped before its mandatory plan and first provider request; its unused hold must follow the automatic refund path.");
        } else {
          const legacyIdentity: LegacyPremiumRecoveryFundingIdentity = {
            runId, worldId, editionId: String(run.canon_edition_id),
            playerId: String(run.requested_by_player_id), reservationId: String(reservation.id),
            reservedCredits,
          };
          funding = {
            mode: "legacy_retained_hold", reservationId: legacyIdentity.reservationId,
            reservedCredits, unlimited: false,
            provider: LEGACY_PREMIUM_RECOVERY_PROVIDER,
            model: LEGACY_PREMIUM_RECOVERY_MODEL,
            fingerprint: legacyPremiumRecoveryFundingFingerprint(legacyIdentity),
            settledAccounting: null,
          };
          knownByStep.set(LEGACY_PREMIUM_RECOVERY_TOTAL_STEP_KEY, knownCostMicros);
          steps.push({
            stepKey: LEGACY_PREMIUM_RECOVERY_TOTAL_STEP_KEY,
            status: "legacy_review_total",
            provider: LEGACY_PREMIUM_RECOVERY_PROVIDER,
            model: LEGACY_PREMIUM_RECOVERY_MODEL,
            knownCostMicros: knownCostMicros > 0 ? knownCostMicros : null,
            needsDecision: true,
            dispatchedAt: null,
            lastRecordedAt: null,
          });
        }
      }
    }
  }
  const storedReceipt = (await db.query<ReceiptRow>(
    "SELECT request_fingerprint, journal_fingerprint, receipt FROM storyhold.world_analysis_premium_reconciliations WHERE run_id = $1", [runId],
  )).rows[0] ?? null;
  const projectedReceipt = storedReceipt ? receiptForProjection(storedReceipt.receipt) : null;
  const receiptMatches = Boolean(projectedReceipt && await premiumReviewFinalizationMatches(db, runId));
  if (storedReceipt) {
    if (!receiptMatches) {
      block("The final receipt no longer matches the saved review. Further investigation is required.");
    } else blockReason = "This premium review has already been finalized.";
  } else if (funding && funding.mode !== "settled_accounting_adoption" && !funding.unlimited
    && (reservation?.status !== "reserved"
      || (reservation?.usage as Row | null)?.retainUntilReconciled !== true)) {
    block("The original protected credit hold is unavailable or was already finalized.");
  }
  const fingerprint = hash({
    version: 2, run, planFingerprint, reservation, journalFingerprint,
    payerRole: payer.rows[0]?.role ?? null, recoveryMode: funding?.mode ?? null,
    fundingFingerprint: funding?.fingerprint ?? null,
  });
  return {
    detail: {
      id: runId, runId, worldId, worldName: String(world.rows[0]?.name ?? "Unknown world"),
      status: String(run.status), stage: storedReceipt
        ? CANCELLATION_STAGE
        : funding?.mode === "settled_accounting_adoption"
          ? "Settled premium accounting awaiting safe closure"
          : "Premium review requires operator reconciliation",
      progress: Number(run.progress), createdAt: timestamp(run.created_at),
      fingerprint,
      recoveryMode: receiptMatches && (projectedReceipt?.version === 2
        || projectedReceipt?.version === 5 || projectedReceipt?.version === 7)
        ? "legacy_total_attestation"
        : receiptMatches && (projectedReceipt?.version === 3 || projectedReceipt?.version === 8)
          ? "settled_accounting_adoption"
          : funding?.mode === "legacy_retained_hold"
            ? "legacy_total_attestation"
            : funding?.mode === "settled_accounting_adoption"
              ? "settled_accounting_adoption"
              : "planned_attestation",
      canFinalize: blockReason === null, blockReason,
      reservedCredits: funding?.reservedCredits ?? 0, knownCostMicros, steps,
      receipt: receiptMatches && projectedReceipt ? publicReceipt(projectedReceipt) : null,
    },
    run, reservation, plan, journalFingerprint, planFingerprint, storedReceipt,
    validatedReceipt: receiptMatches ? projectedReceipt : null, knownByStep, funding,
  };
}

/** No provider requests, manuscript text, provider response, or raw error is returned. */
export async function inspectPremiumRecovery(db: Db, params: { actorId: string; runId: string }, options: RecoveryOptions = {}): Promise<PremiumRecoveryDetail> {
  await authorize(db, params.actorId);
  return (await readState(db, params.runId, options)).detail;
}
export async function listPremiumRecoveries(db: Db, actorId: string, options: RecoveryOptions = {}): Promise<PremiumRecoveryDetail[]> {
  await authorize(db, actorId);
  const runs = await db.query<{ id: string }>(
    `SELECT run.id FROM storyhold.world_analysis_runs AS run
      WHERE run.analysis_kind = 'ai_enrichment' AND (run.status = 'paused'
        OR EXISTS (SELECT 1 FROM storyhold.world_analysis_ai_calls AS call
          WHERE call.run_id = run.id AND call.status IN ('dispatched', 'uncertain'))
        OR EXISTS (SELECT 1 FROM storyhold.credit_reservations AS hold
          WHERE hold.request_id = run.id::text AND hold.operation = 'world_analysis' AND hold.status = 'reserved')
        OR EXISTS (SELECT 1 FROM storyhold.world_analysis_premium_reconciliations AS receipt WHERE receipt.run_id = run.id))
      ORDER BY run.created_at DESC, run.id LIMIT 100`,
  );
  const details: PremiumRecoveryDetail[] = [];
  for (const run of runs.rows) details.push((await readState(db, run.id, options)).detail);
  return details;
}

export async function finalizePremiumRecovery(db: Db, params: {
  actorId: string;
  runId: string;
  expectedFingerprint: string;
  note: string;
  confirmProviderChecked: boolean;
  decisions: PremiumRecoveryDecision[];
}, options: RecoveryOptions = {}): Promise<PremiumRecoveryDetail> {
  await authorize(db, params.actorId);
  checkId(params.runId);
  if (params.confirmProviderChecked !== true || typeof params.expectedFingerprint !== "string"
    || params.expectedFingerprint.length < 16 || params.expectedFingerprint.length > 200
    || typeof params.note !== "string" || params.note.trim().length < 12 || params.note.length > 2000
    || containsCredentialLikeText(params.note)
    || !Array.isArray(params.decisions) || params.decisions.length > 10_000) {
    fail("INVALID_REQUEST", "Confirm the provider records were checked, supply the inspected fingerprint, and include a note of 12–2000 characters.", 400);
  }
  const decisions: PremiumRecoveryDecision[] = [];
  const unique = new Set<string>();
  for (const decision of params.decisions) {
    if (!decision || typeof decision.stepKey !== "string" || identifier(decision.stepKey) !== decision.stepKey
      || !["no_charge", "charged"].includes(decision.outcome) || !validInteger(decision.costMicros)
      || (decision.outcome === "no_charge" && decision.costMicros !== 0)
      || (decision.outcome === "charged" && decision.costMicros === 0)
      || typeof decision.providerReference !== "string" || decision.providerReference.trim().length < 4
      || decision.providerReference.length > 300 || containsCredentialLikeText(decision.providerReference)
      || unique.has(decision.stepKey)) {
      fail("INVALID_DECISION", "Each unresolved step needs one unique provider attestation with a valid charge and reference of 4–300 characters.", 400);
    }
    unique.add(decision.stepKey);
    decisions.push({ stepKey: decision.stepKey, outcome: decision.outcome, costMicros: decision.costMicros, providerReference: decision.providerReference.trim() });
  }
  decisions.sort((left, right) => left.stepKey.localeCompare(right.stepKey));
  const note = params.note.trim();
  const legacyRequestFingerprint = hash({
    actorId: params.actorId, runId: params.runId,
    expectedFingerprint: params.expectedFingerprint, note, decisions,
  });
  return db.transaction(async (tx) => {
    // Lock order is shared with review resume: world -> run -> original hold ->
    // paying player -> operator. The authoritative role check is repeated here.
    const state = await readState(tx, params.runId, options, true);
    await authorize(tx, params.actorId, true);
    if (state.storedReceipt) {
      if (state.detail.blockReason !== "This premium review has already been finalized.") fail("RECEIPT_MISMATCH", "The final receipt no longer matches the saved review.");
      const storedVersion = state.validatedReceipt?.version;
      const replayFingerprint = storedVersion === 1 || storedVersion === 2
        ? legacyRequestFingerprint
        : storedVersion === 3 || storedVersion === 4 || storedVersion === 5
          || storedVersion === 6 || storedVersion === 7 || storedVersion === 8
          ? reconciliationRequestFingerprint({
              receiptVersion: storedVersion,
              recoveryMode: state.detail.recoveryMode,
              actorId: params.actorId,
              runId: params.runId,
              expectedFingerprint: params.expectedFingerprint,
              note,
              decisions,
            })
          : "";
      if (state.storedReceipt.request_fingerprint !== replayFingerprint) fail("ALREADY_FINALIZED", "This review was finalized with a different operator request.");
      return state.detail;
    }
    if (options.isWorldWorkerActive?.(state.detail.worldId)) fail("ACTIVE_WORKER", "This world still has an active worker.");
    if (state.detail.fingerprint !== params.expectedFingerprint) fail("STALE_FINGERPRINT", "The saved review changed. Inspect it again before finalizing.");
    if (!state.detail.canFinalize || !state.funding) fail("NOT_FINALIZABLE", state.detail.blockReason ?? "This review cannot be finalized.");
    const required = state.detail.steps.filter((step) => step.needsDecision);
    if (required.length !== decisions.length || decisions.some((decision) => !required.some((step) => step.stepKey === decision.stepKey))) {
      fail("DECISIONS_REQUIRED", "Supply exactly one provider attestation for every unresolved step, and no other steps.", 400);
    }
    let costMicros = 0;
    if (state.funding.mode === "settled_accounting_adoption") {
      const accounting = state.funding.settledAccounting;
      if (!accounting || decisions.length !== 0) {
        fail("SETTLEMENT_MISMATCH", "The already-settled accounting no longer matches this review.");
      }
      costMicros = accounting.usage.estimatedCostMicros;
    } else if (state.funding.mode === "legacy_retained_hold") {
      const aggregate = decisions.find((item) => item.stepKey === LEGACY_PREMIUM_RECOVERY_TOTAL_STEP_KEY);
      if (!aggregate) fail("DECISIONS_REQUIRED", "The entire legacy review requires one aggregate provider attestation.", 400);
      if (aggregate.costMicros < state.detail.knownCostMicros) {
        fail("KNOWN_COST_CONFLICT", "The attested review total cannot discard authenticated provider charges already present in the saved journal.", 400);
      }
      costMicros = aggregate.costMicros;
    } else {
      for (const step of state.detail.steps) {
        const known = state.knownByStep.get(step.stepKey) ?? 0;
        const decision = decisions.find((item) => item.stepKey === step.stepKey);
        if (decision && decision.costMicros < known) fail("KNOWN_COST_CONFLICT", "An attested step total cannot discard already-known provider charges.", 400);
        costMicros = addCost(costMicros, decision ? decision.costMicros : known);
      }
    }
    const requiredCredits = state.funding.mode === "settled_accounting_adoption"
      ? state.funding.settledAccounting!.requiredCredits
      : creditsForProviderCost(costMicros);
    let creditsUsed = state.funding.mode === "settled_accounting_adoption"
      ? state.funding.settledAccounting!.creditsUsed
      : 0;
    if (!state.funding.unlimited && state.funding.mode !== "settled_accounting_adoption") {
      // Synthetic *accounting* usage, not fabricated token telemetry. Only the
      // verified total feeds settlement; original per-call usage stays untouched.
      const usage: AiUsage = {
        inputUnits: 0, outputUnits: 0, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 0,
        estimatedCostMicros: costMicros, pricingKnown: true,
        pricingVersion: "storyhold:operator-reconciliation:v1", costEstimated: false,
      };
      let settlement;
      try {
        settlement = await settleCreditReservationInTransaction(tx, {
          reservationId: state.funding.reservationId!, usage,
          provider: state.funding.provider, model: state.funding.model, reasoning: "high",
          requireFullPayment: true,
        });
      } catch (error) {
        if (error instanceof CreditEconomyError && error.code === "INSUFFICIENT_CREDITS") {
          fail(
            "INSUFFICIENT_CREDITS",
            `The verified provider usage requires ${requiredCredits} credits, but the original hold and current balance cannot cover it. No billing changes were made; add credits before retrying.`,
          );
        }
        throw error;
      }
      if (settlement.uncoveredCredits !== 0) {
        // The settlement primitive may collect the hold plus every currently
        // spendable credit. Recovery must never finalize an unpaid remainder:
        // throwing here rolls that provisional debit back with the transaction,
        // leaving the original hold intact for a retry after account top-up.
        fail(
          "INSUFFICIENT_CREDITS",
          `The verified provider usage requires ${requiredCredits} credits, but only ${settlement.creditsUsed} are currently collectible. No billing changes were made; add credits before retrying.`,
        );
      }
      if (settlement.creditsUsed !== requiredCredits) fail("SETTLEMENT_MISMATCH", "The credit settlement did not match the verified provider usage.");
      creditsUsed = settlement.creditsUsed;
      await tx.query(
        `UPDATE storyhold.credit_reservations SET usage = usage || $2::jsonb WHERE id = $1`,
        [state.funding.reservationId, JSON.stringify({
          accountingSource: state.funding.mode === "legacy_retained_hold"
            ? "operator_reconciliation_legacy_total" : "operator_reconciliation",
          tokenCountersUnavailable: true,
        })],
      );
    }
    const finalizedRun = await tx.query(
      `UPDATE storyhold.world_analysis_runs
          SET status = 'failed', premium_resume_status = 'not_available', stage = $2,
              pause_requested = false, completed_at = now(), error = NULL, premium_ai_credits_charged = $3
        WHERE id = $1 AND status IN ('paused', 'failed') RETURNING id`,
      [params.runId, CANCELLATION_STAGE, creditsUsed],
    );
    if (finalizedRun.rows.length !== 1) fail("STATE_CHANGED", "The premium review changed before its cancellation could be recorded.");
    const finalRun = (await tx.query<Row>("SELECT * FROM storyhold.world_analysis_runs WHERE id = $1", [params.runId])).rows[0];
    const finalReservation = state.funding.reservationId
      ? (await tx.query<Row>("SELECT * FROM storyhold.credit_reservations WHERE id = $1", [state.funding.reservationId])).rows[0] : null;
    const unsignedReceipt: Omit<StoredReceipt, "receiptFingerprint"> = state.funding.mode === "settled_accounting_adoption" ? {
      version: state.funding.settledAccounting!.creditsUsed > state.funding.reservedCredits ? 8 : 3,
      id: randomUUID(), actorId: params.actorId, note, decisions: [], costMicros, creditsUsed,
      creditsRefunded: state.funding.settledAccounting!.creditsRefunded, createdAt: new Date().toISOString(),
      runId: params.runId, worldId: state.plan!.worldId, playerId: state.plan!.playerId,
      reservationId: state.funding.reservationId, reservedCredits: state.funding.reservedCredits,
      expectedFingerprint: params.expectedFingerprint, journalFingerprint: state.journalFingerprint,
      planFingerprint: state.planFingerprint!, reconciliationMode: SETTLED_PREMIUM_RECOVERY_MODE,
      settledFundingFingerprint: state.funding.settledAccounting!.fundingFingerprint,
      settlementLedgerFingerprint: state.funding.settledAccounting!.settlementLedgerFingerprint,
      usageLedgerFingerprint: state.funding.settledAccounting!.usageLedgerFingerprint,
      clockManifestFingerprint: state.funding.settledAccounting!.clockManifestFingerprint,
      requiredCredits, uncoveredCredits: state.funding.settledAccounting!.uncoveredCredits,
      finalRunFingerprint: hash(finalRun), finalReservationFingerprint: hash(finalReservation),
    } : state.funding.mode === "legacy_retained_hold" ? {
      version: 7, id: randomUUID(), actorId: params.actorId, note, decisions, costMicros, creditsUsed,
      creditsRefunded: Math.max(0, state.funding.reservedCredits - creditsUsed), createdAt: new Date().toISOString(),
      runId: params.runId, worldId: state.detail.worldId, playerId: String(state.run.requested_by_player_id),
      reservationId: state.funding.reservationId, reservedCredits: state.funding.reservedCredits,
      expectedFingerprint: params.expectedFingerprint, journalFingerprint: state.journalFingerprint,
      planFingerprint: null, reconciliationMode: "legacy_retained_hold",
      legacyFundingFingerprint: state.funding.fingerprint!,
      syntheticStepKey: LEGACY_PREMIUM_RECOVERY_TOTAL_STEP_KEY,
      finalRunFingerprint: hash(finalRun), finalReservationFingerprint: hash(finalReservation),
    } : {
      version: 6, id: randomUUID(), actorId: params.actorId, note, decisions, costMicros, creditsUsed,
      creditsRefunded: Math.max(0, state.funding.reservedCredits - creditsUsed), createdAt: new Date().toISOString(),
      runId: params.runId, worldId: state.plan!.worldId, playerId: state.plan!.playerId,
      reservationId: state.funding.reservationId, expectedFingerprint: params.expectedFingerprint,
      journalFingerprint: state.journalFingerprint, planFingerprint: state.planFingerprint!,
      finalRunFingerprint: hash(finalRun), finalReservationFingerprint: hash(finalReservation),
    };
    const receipt = sealStoredReceipt(unsignedReceipt);
    const requestFingerprint = reconciliationRequestFingerprint({
      receiptVersion: receipt.version as 3 | 4 | 5 | 6 | 7 | 8,
      recoveryMode: state.funding.mode === "settled_accounting_adoption"
        ? "settled_accounting_adoption"
        : state.funding.mode === "legacy_retained_hold"
          ? "legacy_total_attestation"
          : "planned_attestation",
      actorId: params.actorId,
      runId: params.runId,
      expectedFingerprint: params.expectedFingerprint,
      note,
      decisions,
    });
    await tx.query(
      `INSERT INTO storyhold.world_analysis_premium_reconciliations
        (run_id, id, journal_fingerprint, request_fingerprint, receipt) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [params.runId, receipt.id, state.journalFingerprint, requestFingerprint, JSON.stringify(receipt)],
    );
    if (!(await premiumReviewFinalizationMatches(tx, params.runId))) {
      fail("RECEIPT_MISMATCH", "The finalized accounting receipt failed its integrity check; no recovery changes were committed.");
    }
    return (await readState(tx, params.runId, options)).detail;
  });
}

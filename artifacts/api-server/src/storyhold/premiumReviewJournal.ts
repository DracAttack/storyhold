import { createHash } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import {
  AiGatewayUnavailableError,
  combineAiUsage,
  type AiBillableAttempt,
  type AiTextResult,
  type AiUsage,
  type GenerateAiTextInput,
} from "./aiGateway";
import {
  canonPayloadFingerprint,
  type JsonObject,
} from "./analysisVerificationContracts";
import { PREMIUM_CLOCK_PAGES_PER_VERIFICATION_BATCH_LIMIT } from "./premiumReviewLimits";

type JournalDb = Pick<PGlite, "query" | "transaction">;
type JournalQueryDb = Pick<PGlite, "query">;
type JournalStatus = "dispatched" | "completed" | "rejected" | "uncertain";
const RECOVERY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** A planless legacy review has no trustworthy call inventory. Recovery therefore
 * attests one aggregate total rather than pretending the surviving rows are a
 * complete bill. These constants are also bound into its immutable receipt. */
export const LEGACY_PREMIUM_RECOVERY_TOTAL_STEP_KEY = "legacy:review-total";
export const LEGACY_PREMIUM_RECOVERY_PROVIDER = "operator-reconciliation";
export const LEGACY_PREMIUM_RECOVERY_MODEL = "legacy-unattributed";
export const SETTLED_PREMIUM_RECOVERY_MODE = "settled_accounting_adoption";

export type LegacyPremiumRecoveryFundingIdentity = {
  runId: string;
  worldId: string;
  editionId: string;
  playerId: string;
  reservationId: string;
  reservedCredits: number;
};

export function legacyPremiumRecoveryFundingFingerprint(
  funding: LegacyPremiumRecoveryFundingIdentity,
): string {
  return canonPayloadFingerprint(jsonSnapshot({
    version: "storyhold:legacy-premium-recovery-funding:v1",
    ...funding,
  }) as unknown as JsonObject);
}

export type SettledPremiumRecoveryIdentity = {
  runId: string;
  worldId: string;
  editionId: string;
  playerId: string;
  reservationId: string;
  reservedCredits: number;
  planVersion: 1 | 2 | 3;
  verificationStepKeys: string[];
  maximumChronologySteps: number;
  requestScopeFingerprint: string;
  requestProvider: string;
  requestModel: string;
};

export type SettledPremiumRecoveryAccounting = {
  usage: AiUsage;
  provider: string;
  model: string;
  reasoning: "high";
  requiredCredits: number;
  creditsUsed: number;
  uncoveredCredits: number;
  creditsRefunded: number;
  settlementLedgerFingerprint: string;
  usageLedgerFingerprint: string;
  clockManifestFingerprint: string | null;
  fundingFingerprint: string;
};

export const premiumReviewJournalSchemaSql = String.raw`
  CREATE TABLE IF NOT EXISTS storyhold.world_analysis_ai_calls (
    run_id uuid NOT NULL REFERENCES storyhold.world_analysis_runs(id) ON DELETE CASCADE,
    step_key text NOT NULL CHECK (length(step_key) > 0),
    request_fingerprint text NOT NULL,
    request_snapshot jsonb NOT NULL,
    status text NOT NULL DEFAULT 'dispatched'
      CHECK (status IN ('dispatched', 'completed', 'rejected', 'uncertain')),
    result_snapshot jsonb,
    result_fingerprint text,
    billable_attempts jsonb NOT NULL DEFAULT '[]'::jsonb,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    dispatched_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    PRIMARY KEY (run_id, step_key)
  );

  CREATE TABLE IF NOT EXISTS storyhold.world_analysis_premium_reconciliations (
    run_id uuid PRIMARY KEY,
    id uuid NOT NULL UNIQUE,
    journal_fingerprint text NOT NULL,
    request_fingerprint text NOT NULL,
    receipt jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE OR REPLACE FUNCTION storyhold.reject_premium_reconciliation_mutation()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'Premium review reconciliation receipts are append-only';
  END;
  $$;
  DROP TRIGGER IF EXISTS premium_reconciliation_append_only ON storyhold.world_analysis_premium_reconciliations;
  CREATE TRIGGER premium_reconciliation_append_only
    BEFORE UPDATE OR DELETE ON storyhold.world_analysis_premium_reconciliations
    FOR EACH ROW EXECUTE FUNCTION storyhold.reject_premium_reconciliation_mutation();
`;

export class PremiumJournalError extends Error {
  constructor(
    public readonly code:
      | "REQUEST_MISMATCH"
      | "OUTCOME_UNRESOLVED"
      | "PREVIOUSLY_REJECTED"
      | "JOURNAL_INTEGRITY"
      | "JOURNAL_PERSISTENCE"
      | "REVIEW_FINALIZED"
      | "RESERVATION_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "PremiumJournalError";
  }
}

export type PremiumJournalRow = {
  step_key: string;
  request_fingerprint: string;
  request_snapshot: JsonObject;
  status: JournalStatus;
  result_snapshot: AiTextResult | null;
  result_fingerprint: string | null;
  billable_attempts: AiBillableAttempt[];
  created_at?: string | Date;
  dispatched_at?: string | Date;
  updated_at?: string | Date;
  completed_at?: string | Date | null;
};
type JournalRow = PremiumJournalRow;

/** Presence alone blocks replay, even if a receipt needs integrity investigation. */
export async function premiumReviewHasFinalization(db: JournalQueryDb, runId: string): Promise<boolean> {
  return (await db.query(
    "SELECT run_id FROM storyhold.world_analysis_premium_reconciliations WHERE run_id = $1", [runId],
  )).rows.length > 0;
}

function safeNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function recoveryScopeJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(recoveryScopeJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${recoveryScopeJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function recoveryScopeFingerprint(value: unknown): string {
  return createHash("sha256").update(recoveryScopeJson(value)).digest("hex");
}

function recoveryEvidencePin(run: Record<string, unknown>): Record<string, unknown> {
  const text = (value: unknown, maximum: number) => typeof value === "string"
    ? value.trim().slice(0, maximum)
    : "";
  return {
    parentLocalRunId: text(run.parent_local_run_id, 64),
    corpusFingerprint: text(run.corpus_fingerprint, 128),
    evidenceGraphFingerprint: text(run.evidence_graph_fingerprint, 128),
    constraintSnapshotFingerprint: text(run.constraint_snapshot_fingerprint, 128),
    verificationContextFingerprint: text(run.verification_context_fingerprint, 128),
    verificationPacketVersion: Number(run.verification_packet_version ?? 0),
  };
}

export function exactTrustedUsage(value: unknown): value is AiUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  return usage.pricingKnown === true
    && typeof usage.pricingVersion === "string"
    && usage.pricingVersion.length > 0
    && typeof usage.costEstimated === "boolean"
    && [
      "inputUnits",
      "outputUnits",
      "cachedInputUnits",
      "cacheWriteInputUnits",
      "reasoningUnits",
      "estimatedCostMicros",
    ].every((field) => safeNonnegativeInteger(usage[field]));
}

export function exactTrustedAttempt(value: unknown): value is AiBillableAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const attempt = value as Record<string, unknown>;
  return typeof attempt.provider === "string" && attempt.provider.length > 0
    && typeof attempt.model === "string" && attempt.model.length > 0
    && typeof attempt.resolvedModel === "string" && attempt.resolvedModel.length > 0
    && (attempt.upstreamProvider === null || typeof attempt.upstreamProvider === "string")
    && typeof attempt.stage === "string" && attempt.stage.length > 0
    && ["low", "medium", "high"].includes(String(attempt.reasoning))
    && exactTrustedUsage(attempt.usage);
}

function safeUsageTotal(usages: AiUsage[]): AiUsage | null {
  if (!usages.length || usages.some((usage) => !exactTrustedUsage(usage))) return null;
  const combined = combineAiUsage(usages);
  return exactTrustedUsage(combined) ? combined : null;
}

async function settledJournalShapeMatches(
  db: JournalQueryDb,
  identity: SettledPremiumRecoveryIdentity,
  rows: PremiumJournalRow[],
): Promise<boolean> {
  if (![1, 2, 3].includes(identity.planVersion)
    || !safeNonnegativeInteger(identity.maximumChronologySteps)
    || !Array.isArray(identity.verificationStepKeys)
    || identity.verificationStepKeys.length === 0
    || identity.verificationStepKeys.some((key, index) => key !== `verification:${index}`)) return false;
  const verification: Array<{ index: number; status: JournalStatus }> = [];
  const chronology: Array<{ index: number; status: JournalStatus }> = [];
  for (const row of rows) {
    if (row.request_snapshot.scopeFingerprint !== identity.requestScopeFingerprint
      || row.request_snapshot.provider !== identity.requestProvider
      || row.request_snapshot.model !== identity.requestModel) return false;
    const key = /^(verification|chronology):(0|[1-9][0-9]*)$/u.exec(row.step_key);
    if (!key) return false;
    const item = { index: Number(key[2]), status: row.status };
    (key[1] === "verification" ? verification : chronology).push(item);
    if (row.status === "completed") {
      if (!row.result_snapshot || row.billable_attempts.length === 0
        || row.billable_attempts.some((attempt) => !exactTrustedAttempt(attempt))
        || canonPayloadFingerprint(jsonSnapshot(row.billable_attempts) as unknown as JsonObject)
          !== canonPayloadFingerprint(jsonSnapshot(successfulAttempts(row.result_snapshot)) as unknown as JsonObject)) return false;
    } else if (row.status === "rejected") {
      if (row.result_snapshot !== null || row.billable_attempts.length === 0
        || row.billable_attempts.some((attempt) => !exactTrustedAttempt(attempt))) return false;
    } else return false;
  }
  verification.sort((left, right) => left.index - right.index);
  chronology.sort((left, right) => left.index - right.index);
  if (verification.some((item, position) => item.index !== position)
    || verification.length > identity.verificationStepKeys.length
    || chronology.some((item, position) => item.index !== position)
    || chronology.length > identity.maximumChronologySteps) return false;
  const rejectedVerification = verification.findIndex((item) => item.status === "rejected");
  const rejectedChronology = chronology.findIndex((item) => item.status === "rejected");
  if ((rejectedVerification >= 0 && rejectedVerification !== verification.length - 1)
    || verification.filter((item) => item.status === "rejected").length > 1
    // Legacy v1/v2 synthesis deliberately treated chronology groups as
    // independent best-effort calls. A known rejected group could therefore
    // be followed by later completed (or rejected) groups. Preserve that exact
    // bounded history for recovery; v3's receipt-driven clock stops at its
    // first rejected page and remains strictly prefix-shaped.
    || (identity.planVersion === 3 && rejectedChronology >= 0
      && rejectedChronology !== chronology.length - 1)
    || (identity.planVersion === 3
      && chronology.filter((item) => item.status === "rejected").length > 1)
    || (chronology.length > 0 && (verification.length !== identity.verificationStepKeys.length
      || rejectedVerification >= 0))) return false;

  const manifests = (await db.query<{ snapshot: Record<string, unknown>; fingerprint: string }>(
    "SELECT snapshot, fingerprint FROM storyhold.world_analysis_premium_clock_manifests WHERE run_id = $1",
    [identity.runId],
  )).rows;
  if (identity.planVersion !== 3) return manifests.length === 0;
  if (manifests.length > 1 || (chronology.length > 0 && manifests.length !== 1)) return false;
  if (!manifests.length) return true;
  if (verification.length !== identity.verificationStepKeys.length || rejectedVerification >= 0) return false;
  const manifest = manifests[0]!;
  const snapshot = manifest.snapshot;
  const keys = Object.keys(snapshot).sort().join("\n");
  const expectedKeys = [
    "editionId", "inputFingerprint", "pageCount", "pageManifestFingerprint",
    "requestManifestFingerprint", "runId", "version", "worldId",
  ].sort().join("\n");
  if (keys !== expectedKeys
    || snapshot.version !== 1
    || snapshot.runId !== identity.runId
    || snapshot.worldId !== identity.worldId
    || snapshot.editionId !== identity.editionId
    || !safeNonnegativeInteger(snapshot.pageCount)
    || snapshot.pageCount > identity.maximumChronologySteps
    || chronology.length > snapshot.pageCount
    || typeof snapshot.pageManifestFingerprint !== "string"
    || !/^clock_page_manifest_[0-9a-f]{64}$/u.test(snapshot.pageManifestFingerprint)
    || typeof snapshot.inputFingerprint !== "string"
    || !/^clock_inventory_[0-9a-f]{64}$/u.test(snapshot.inputFingerprint)
    || typeof snapshot.requestManifestFingerprint !== "string"
    || !/^canon_payload_[0-9a-f]{64}$/u.test(snapshot.requestManifestFingerprint)
    || manifest.fingerprint !== canonPayloadFingerprint({
      namespace: "storyhold:premium-clock-manifest:v1",
      manifest: snapshot as JsonObject,
    })) return false;
  return true;
}

/**
 * Recognize only the transaction written by worldStudio's known-failure
 * settlement path. This never estimates a historical retail price from the
 * current environment: the append-only settlement ledger is authoritative for
 * required and uncovered credits, while the journal is authoritative for
 * provider usage. Any missing, duplicate, or disagreeing record fails closed.
 */
export async function readSettledPremiumRecoveryAccounting(
  db: JournalQueryDb,
  identity: SettledPremiumRecoveryIdentity,
): Promise<SettledPremiumRecoveryAccounting | null> {
  try {
    if (!safeNonnegativeInteger(identity.reservedCredits) || identity.reservedCredits <= 0) return null;
    const journal = await readPremiumJournalSnapshot(db, identity.runId);
    if (!journal.rows.length || !await settledJournalShapeMatches(db, identity, journal.rows)) {
      return null;
    }
    // Match worldStudio's original settlement order exactly. Provider/model
    // strings preserve first-seen order, so the receipt-snapshot ordering by
    // step key is not interchangeable with chronological accounting order.
    const journalAccounting = await readPremiumJournalAccounting(db, identity.runId);
    if (journalAccounting.hasUncertain || journalAccounting.callCount !== journal.rows.length) return null;
    const attempts = journalAccounting.attempts;
    const usage = safeUsageTotal(attempts.map((attempt) => attempt.usage));
    if (!usage) return null;
    const provider = [...new Set(attempts.map((attempt) => attempt.provider))].join(",") || "mixed";
    const model = [...new Set(attempts.map((attempt) => attempt.model))].join(",") || "mixed";

    const run = (await db.query<Record<string, unknown>>(
      "SELECT * FROM storyhold.world_analysis_runs WHERE id = $1",
      [identity.runId],
    )).rows[0];
    const reservation = (await db.query<Record<string, unknown>>(
      "SELECT * FROM storyhold.credit_reservations WHERE id = $1",
      [identity.reservationId],
    )).rows[0];
    if (!run || !reservation
      || run.analysis_kind !== "ai_enrichment"
      || run.world_id !== identity.worldId
      || run.canon_edition_id !== identity.editionId
      || run.requested_by_player_id !== identity.playerId
      || reservation.status !== "settled"
      || reservation.player_id !== identity.playerId
      || reservation.world_id !== identity.worldId
      || reservation.campaign_id !== null
      || reservation.operation !== "world_analysis"
      || reservation.request_id !== identity.runId
      || Number(reservation.reserved_credits) !== identity.reservedCredits
      || reservation.provider !== provider
      || reservation.model !== model
      || reservation.reasoning_level !== "high"
      || reservation.pricing_version !== usage.pricingVersion
      || Number(reservation.cost_micros) !== usage.estimatedCostMicros
      || canonPayloadFingerprint(jsonSnapshot(reservation.usage) as JsonObject)
        !== canonPayloadFingerprint(jsonSnapshot(usage) as unknown as JsonObject)) {
      return null;
    }
    const creditsUsed = Number(reservation.actual_credits);
    if (!safeNonnegativeInteger(creditsUsed)
      || Number(run.premium_ai_credits_charged) !== creditsUsed) return null;

    const ledgerRows = (await db.query<Record<string, unknown>>(
      `SELECT * FROM storyhold.credit_ledger
        WHERE reservation_id = $1 ORDER BY created_at, id`,
      [identity.reservationId],
    )).rows;
    if (ledgerRows.length !== 2) return null;
    const reserveLedger = ledgerRows.find((row) => row.entry_kind === "reserve");
    const settlementLedger = ledgerRows.find((row) => row.entry_kind === "settle_adjustment");
    if (!reserveLedger || !settlementLedger) return null;
    const settlementMetadata = settlementLedger.metadata as Record<string, unknown> | null;
    const requiredCredits = settlementMetadata?.requiredCredits;
    const uncoveredCredits = settlementMetadata?.uncoveredCredits;
    if (!safeNonnegativeInteger(requiredCredits)
      || !safeNonnegativeInteger(uncoveredCredits)
      || requiredCredits !== creditsUsed
      || uncoveredCredits !== 0
      || reserveLedger.player_id !== identity.playerId
      || reserveLedger.world_id !== identity.worldId
      || reserveLedger.campaign_id !== null
      || reserveLedger.operation !== "world_analysis"
      || reserveLedger.request_id !== identity.runId
      || Number(reserveLedger.credits_delta) !== -identity.reservedCredits
      || settlementLedger.player_id !== identity.playerId
      || settlementLedger.world_id !== identity.worldId
      || settlementLedger.campaign_id !== null
      || settlementLedger.operation !== "world_analysis"
      || settlementLedger.request_id !== identity.runId
      || Number(settlementLedger.credits_delta) !== identity.reservedCredits - creditsUsed
      || settlementLedger.provider !== provider
      || settlementLedger.model !== model
      || Number(settlementLedger.cost_micros) !== usage.estimatedCostMicros
      || settlementMetadata?.pricingVersion !== usage.pricingVersion
      || settlementMetadata?.reasoning !== "high") return null;

    const promoted = await db.query<{ count: number }>(
      `SELECT (
        (SELECT count(*) FROM storyhold.world_analysis_claim_reviews WHERE run_id = $1) +
        (SELECT count(*) FROM storyhold.world_analysis_graph_reviews WHERE run_id = $1) +
        (SELECT count(*) FROM storyhold.world_analysis_stat_reviews WHERE run_id = $1) +
        (SELECT count(*) FROM storyhold.world_analysis_clock_reviews WHERE run_id = $1)
      )::int AS count`,
      [identity.runId],
    );
    if (Number(promoted.rows[0]?.count ?? -1) !== 0) return null;

    const usageLedgerRows = (await db.query<Record<string, unknown>>(
      `SELECT * FROM storyhold.ai_usage_ledger
        WHERE request_id = $1
        ORDER BY created_at, id`,
      [identity.runId],
    )).rows;
    if (usageLedgerRows.length !== 1) return null;
    const usageLedger = usageLedgerRows[0]!;
    const usageMetadata = usageLedger.metadata as Record<string, unknown> | null;
    if (usageLedger.player_id !== identity.playerId
      || usageLedger.world_id !== identity.worldId
      || usageLedger.campaign_id !== null
      || usageLedger.operation !== "world_analysis_rejected_output"
      || usageLedger.provider !== provider
      || usageLedger.model !== model
      || Number(usageLedger.input_units) !== usage.inputUnits
      || Number(usageLedger.output_units) !== usage.outputUnits
      || Number(usageLedger.cached_input_units) !== usage.cachedInputUnits
      || Number(usageLedger.cache_write_input_units) !== usage.cacheWriteInputUnits
      || Number(usageLedger.reasoning_units) !== usage.reasoningUnits
      || Number(usageLedger.cost_micros) !== usage.estimatedCostMicros
      || usageLedger.cache_hit !== (usage.cachedInputUnits > 0)
      || usageLedger.pricing_version !== usage.pricingVersion
      || Number(usageLedger.credits_charged) !== creditsUsed
      || usageMetadata?.canonPromoted !== false
      || usageMetadata?.pricingKnown !== true
      || usageMetadata?.attemptCount !== attempts.length) return null;

    const settlementLedgerFingerprint = canonPayloadFingerprint(jsonSnapshot({
      version: "storyhold:settled-premium-credit-ledger:v1",
      rows: ledgerRows,
    }) as unknown as JsonObject);
    const usageLedgerFingerprint = canonPayloadFingerprint(jsonSnapshot({
      version: "storyhold:settled-premium-usage-ledger:v1",
      rows: usageLedgerRows,
    }) as unknown as JsonObject);
    const clockManifestRows = (await db.query<Record<string, unknown>>(
      "SELECT * FROM storyhold.world_analysis_premium_clock_manifests WHERE run_id = $1 ORDER BY run_id",
      [identity.runId],
    )).rows;
    const clockManifestFingerprint = clockManifestRows.length === 0
      ? null
      : canonPayloadFingerprint(jsonSnapshot({
        version: "storyhold:settled-premium-clock-manifest-row:v1",
        rows: clockManifestRows,
      }) as unknown as JsonObject);
    const creditsRefunded = Math.max(0, identity.reservedCredits - creditsUsed);
    const fundingFingerprint = canonPayloadFingerprint(jsonSnapshot({
      version: "storyhold:settled-premium-recovery-funding:v1",
      identity,
      usage,
      provider,
      model,
      reasoning: "high",
      requiredCredits,
      creditsUsed,
      uncoveredCredits,
      creditsRefunded,
      settlementLedgerFingerprint,
      usageLedgerFingerprint,
      clockManifestFingerprint,
    }) as unknown as JsonObject);
    return {
      usage,
      provider,
      model,
      reasoning: "high",
      requiredCredits,
      creditsUsed,
      uncoveredCredits,
      creditsRefunded,
      settlementLedgerFingerprint,
      usageLedgerFingerprint,
      clockManifestFingerprint,
      fundingFingerprint,
    };
  } catch {
    return null;
  }
}

type ReceiptDecision = {
  stepKey: string;
  outcome: "no_charge" | "charged";
  costMicros: number;
  providerReference: string;
};

function validReceiptDecision(value: unknown): value is ReceiptDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const decision = value as Record<string, unknown>;
  return typeof decision.stepKey === "string" && decision.stepKey.length > 0
    && (decision.outcome === "no_charge" || decision.outcome === "charged")
    && safeNonnegativeInteger(decision.costMicros)
    && ((decision.outcome === "no_charge" && decision.costMicros === 0)
      || (decision.outcome === "charged" && decision.costMicros > 0))
    && typeof decision.providerReference === "string"
    && decision.providerReference.trim().length >= 4
    && decision.providerReference.length <= 300;
}

function validReceiptBase(receipt: Record<string, unknown>, runId: string): receipt is Record<string, unknown> & {
  decisions: ReceiptDecision[];
  costMicros: number;
  creditsUsed: number;
  creditsRefunded: number;
} {
  if (typeof receipt.id !== "string" || !RECOVERY_UUID.test(receipt.id)
    || typeof receipt.actorId !== "string" || !RECOVERY_UUID.test(receipt.actorId)
    || typeof receipt.note !== "string" || receipt.note.trim().length < 12 || receipt.note.length > 2_000
    || receipt.runId !== runId
    || typeof receipt.expectedFingerprint !== "string"
    || receipt.expectedFingerprint.length < 16 || receipt.expectedFingerprint.length > 200
    || typeof receipt.createdAt !== "string" || !Number.isFinite(Date.parse(receipt.createdAt))
    || new Date(receipt.createdAt).toISOString() !== receipt.createdAt
    || !safeNonnegativeInteger(receipt.costMicros)
    || !safeNonnegativeInteger(receipt.creditsUsed)
    || !safeNonnegativeInteger(receipt.creditsRefunded)
    || !Array.isArray(receipt.decisions)
    || receipt.decisions.length > 10_000
    || receipt.decisions.some((decision) => !validReceiptDecision(decision))) return false;
  const decisions = receipt.decisions as ReceiptDecision[];
  const keys = new Set(decisions.map((decision) => decision.stepKey));
  if (keys.size !== decisions.length
    || decisions.some((decision, index) => index > 0
      && decision.stepKey.localeCompare(decisions[index - 1]!.stepKey) <= 0)
    || ![1, 2, 3, 4, 5, 6, 7, 8].includes(Number(receipt.version))) return false;
  if (receipt.receiptFingerprint === undefined) return receipt.version === 1 || receipt.version === 2;
  if (typeof receipt.receiptFingerprint !== "string") return false;
  const { receiptFingerprint: _storedFingerprint, ...unsigned } = receipt;
  return receipt.receiptFingerprint === canonPayloadFingerprint({
    namespace: "storyhold:premium-reconciliation-receipt:v1",
    receipt: jsonSnapshot(unsigned) as JsonObject,
  });
}

function receiptJournalEconomics(
  rows: PremiumJournalRow[],
  decisions: ReceiptDecision[],
  mode: "planned" | "legacy",
): number | null {
  let knownTotal = 0;
  const unresolved = new Set<string>();
  for (const row of rows) {
    let known = 0;
    let complete = (row.status === "completed" || row.status === "rejected")
      && row.billable_attempts.length > 0;
    for (const attempt of row.billable_attempts) {
      if (!exactTrustedAttempt(attempt)) complete = false;
      else {
        known += attempt.usage.estimatedCostMicros;
        if (!Number.isSafeInteger(known)) return null;
      }
    }
    if (row.status === "completed") {
      const result = row.result_snapshot;
      if (!result || !exactTrustedUsage(result.usage)) complete = false;
      else {
        const expected = successfulAttempts(result);
        let resultKnown = 0;
        for (const attempt of expected) {
          if (!exactTrustedAttempt(attempt)) complete = false;
          else {
            resultKnown += attempt.usage.estimatedCostMicros;
            if (!Number.isSafeInteger(resultKnown)) return null;
          }
        }
        known = Math.max(known, resultKnown);
        if (canonPayloadFingerprint(jsonSnapshot(row.billable_attempts) as unknown as JsonObject)
          !== canonPayloadFingerprint(jsonSnapshot(expected) as unknown as JsonObject)) complete = false;
      }
    }
    knownTotal += known;
    if (!Number.isSafeInteger(knownTotal)) return null;
    if (!complete) unresolved.add(row.step_key);
  }
  if (mode === "legacy") {
    if (decisions.length !== 1
      || decisions[0]?.stepKey !== LEGACY_PREMIUM_RECOVERY_TOTAL_STEP_KEY
      || decisions[0].costMicros < knownTotal) return null;
    return decisions[0].costMicros;
  }
  if (decisions.length !== unresolved.size
    || decisions.some((decision) => !unresolved.has(decision.stepKey))) return null;
  let total = 0;
  for (const row of rows) {
    const decision = decisions.find((item) => item.stepKey === row.step_key);
    if (decision) {
      const knownForStep = (() => {
        let value = 0;
        for (const attempt of row.billable_attempts) {
          if (exactTrustedAttempt(attempt)) value += attempt.usage.estimatedCostMicros;
        }
        if (row.status === "completed" && row.result_snapshot) {
          let resultValue = 0;
          for (const attempt of successfulAttempts(row.result_snapshot)) {
            if (exactTrustedAttempt(attempt)) resultValue += attempt.usage.estimatedCostMicros;
          }
          value = Math.max(value, resultValue);
        }
        return value;
      })();
      if (!Number.isSafeInteger(knownForStep) || decision.costMicros < knownForStep) return null;
      total += decision.costMicros;
    } else {
      for (const attempt of row.billable_attempts) {
        if (!exactTrustedAttempt(attempt)) return null;
        total += attempt.usage.estimatedCostMicros;
      }
    }
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

async function reconciliationSettlementMatches(
  db: JournalQueryDb,
  reservation: Record<string, unknown>,
  expected: {
    provider: string;
    model: string;
    costMicros: number;
    creditsUsed: number;
    creditsRefunded: number;
    accountingSource: "operator_reconciliation" | "operator_reconciliation_legacy_total";
  },
  allowFundedOverage = false,
): Promise<boolean> {
  const reservedCredits = Number(reservation.reserved_credits);
  if (!safeNonnegativeInteger(reservedCredits)
    || (!allowFundedOverage && expected.creditsUsed > reservedCredits)
    || expected.creditsRefunded !== (allowFundedOverage
      ? Math.max(0, reservedCredits - expected.creditsUsed)
      : reservedCredits - expected.creditsUsed)
    || reservation.status !== "settled"
    || Number(reservation.actual_credits) !== expected.creditsUsed
    || Number(reservation.cost_micros) !== expected.costMicros
    || reservation.provider !== expected.provider
    || reservation.model !== expected.model
    || reservation.reasoning_level !== "high"
    || reservation.pricing_version !== "storyhold:operator-reconciliation:v1") return false;
  const usage = reservation.usage as Record<string, unknown> | null;
  if (!usage || usage.inputUnits !== 0 || usage.outputUnits !== 0
    || usage.cachedInputUnits !== 0 || usage.cacheWriteInputUnits !== 0
    || usage.reasoningUnits !== 0 || usage.estimatedCostMicros !== expected.costMicros
    || usage.pricingKnown !== true || usage.pricingVersion !== "storyhold:operator-reconciliation:v1"
    || usage.costEstimated !== false || usage.accountingSource !== expected.accountingSource
    || usage.tokenCountersUnavailable !== true) return false;
  const rows = (await db.query<Record<string, unknown>>(
    "SELECT * FROM storyhold.credit_ledger WHERE reservation_id = $1 ORDER BY created_at, id",
    [reservation.id],
  )).rows;
  if (rows.length !== 2) return false;
  const reserve = rows.find((row) => row.entry_kind === "reserve");
  const settle = rows.find((row) => row.entry_kind === "settle_adjustment");
  const metadata = settle?.metadata as Record<string, unknown> | null;
  return Boolean(reserve && settle
    && reserve.player_id === reservation.player_id
    && reserve.world_id === reservation.world_id
    && reserve.campaign_id === reservation.campaign_id
    && reserve.operation === reservation.operation
    && reserve.request_id === reservation.request_id
    && Number(reserve.credits_delta) === -reservedCredits
    && settle.player_id === reservation.player_id
    && settle.world_id === reservation.world_id
    && settle.campaign_id === reservation.campaign_id
    && settle.operation === reservation.operation
    && settle.request_id === reservation.request_id
    && Number(settle.credits_delta) === reservedCredits - expected.creditsUsed
    && settle.provider === expected.provider
    && settle.model === expected.model
    && Number(settle.cost_micros) === expected.costMicros
    && metadata?.pricingVersion === "storyhold:operator-reconciliation:v1"
    && metadata?.reasoning === "high"
    && metadata?.requiredCredits === expected.creditsUsed
    && metadata?.uncoveredCredits === 0);
}

export async function plannedJournalScopeMatches(
  db: JournalQueryDb,
  plan: Record<string, unknown>,
  run: Record<string, unknown>,
  rows: PremiumJournalRow[],
): Promise<boolean> {
  if (!Array.isArray(plan.verificationBatches) || plan.verificationBatches.length === 0) return false;
  let expectedVerification: string[];
  if (plan.version === 1) {
    expectedVerification = plan.verificationBatches.map((_batch, index) => `verification:${index}`);
  } else if ((plan.version === 2 || plan.version === 3) && Array.isArray(plan.verificationPages)) {
    expectedVerification = plan.verificationPages.map((page) => {
      if (!page || typeof page !== "object" || Array.isArray(page)) return "";
      return String((page as Record<string, unknown>).stepKey ?? "");
    });
  } else return false;
  if (expectedVerification.length === 0
    || expectedVerification.some((key, index) => key !== `verification:${index}`)) return false;
  const scopeFingerprint = recoveryScopeFingerprint({ evidence: recoveryEvidencePin(run), plan });
  const verification: Array<{ index: number; status: JournalStatus }> = [];
  const chronology: Array<{ index: number; status: JournalStatus }> = [];
  for (const row of rows) {
    if (row.request_snapshot.scopeFingerprint !== scopeFingerprint
      || row.request_snapshot.provider !== plan.provider
      || row.request_snapshot.model !== plan.model) return false;
    const match = /^(verification|chronology):(0|[1-9][0-9]*)$/u.exec(row.step_key);
    if (!match) return false;
    (match[1] === "verification" ? verification : chronology).push({
      index: Number(match[2]), status: row.status,
    });
  }
  verification.sort((left, right) => left.index - right.index);
  chronology.sort((left, right) => left.index - right.index);
  if (verification.some((item, index) => item.index !== index)
    || verification.length > expectedVerification.length
    || chronology.some((item, index) => item.index !== index)
    || chronology.length > plan.verificationBatches.length
      * PREMIUM_CLOCK_PAGES_PER_VERIFICATION_BATCH_LIMIT) return false;
  const firstUnfinishedVerification = verification.findIndex((item) => item.status !== "completed");
  const firstBlockingChronology = chronology.findIndex((item) =>
    item.status !== "completed"
    && !((plan.version === 1 || plan.version === 2) && item.status === "rejected")
  );
  if ((firstUnfinishedVerification >= 0 && firstUnfinishedVerification !== verification.length - 1)
    // v1/v2 ran bounded chronology groups independently and continued after a
    // known rejection. A dispatched/uncertain call still blocks later work in
    // every version; v3 also treats a known rejection as terminal.
    || (firstBlockingChronology >= 0
      && firstBlockingChronology !== chronology.length - 1)
    || (chronology.length > 0 && (verification.length !== expectedVerification.length
      || firstUnfinishedVerification >= 0))) return false;
  if (plan.version !== 3) {
    const manifests = await db.query(
      "SELECT run_id FROM storyhold.world_analysis_premium_clock_manifests WHERE run_id = $1",
      [run.id],
    );
    return manifests.rows.length === 0;
  }
  const manifests = (await db.query<{ snapshot: Record<string, unknown>; fingerprint: string }>(
    "SELECT snapshot, fingerprint FROM storyhold.world_analysis_premium_clock_manifests WHERE run_id = $1",
    [run.id],
  )).rows;
  if (manifests.length > 1) return false;
  if (manifests.length === 0) return chronology.length === 0;
  if (verification.length !== expectedVerification.length
    || verification.some((item) => item.status !== "completed")) return false;
  const manifest = manifests[0]!;
  const keys = Object.keys(manifest.snapshot).sort().join("\n");
  const expectedKeys = [
    "editionId", "inputFingerprint", "pageCount", "pageManifestFingerprint",
    "requestManifestFingerprint", "runId", "version", "worldId",
  ].sort().join("\n");
  return keys === expectedKeys
    && manifest.snapshot.version === 1
    && safeNonnegativeInteger(manifest.snapshot.pageCount)
    && manifest.snapshot.pageCount <= plan.verificationBatches.length
      * PREMIUM_CLOCK_PAGES_PER_VERIFICATION_BATCH_LIMIT
    && chronology.length <= manifest.snapshot.pageCount
    && manifest.snapshot.runId === run.id
    && manifest.snapshot.worldId === run.world_id
    && manifest.snapshot.editionId === run.canon_edition_id
    && typeof manifest.snapshot.pageManifestFingerprint === "string"
    && /^clock_page_manifest_[0-9a-f]{64}$/u.test(manifest.snapshot.pageManifestFingerprint)
    && typeof manifest.snapshot.inputFingerprint === "string"
    && /^clock_inventory_[0-9a-f]{64}$/u.test(manifest.snapshot.inputFingerprint)
    && typeof manifest.snapshot.requestManifestFingerprint === "string"
    && /^canon_payload_[0-9a-f]{64}$/u.test(manifest.snapshot.requestManifestFingerprint)
    && manifest.fingerprint === canonPayloadFingerprint({
      namespace: "storyhold:premium-clock-manifest:v1",
      manifest: manifest.snapshot as JsonObject,
    });
}

/** Validate a final receipt without operator permissions, for fresh-run guards.
 * Deliberately reads plan data directly to avoid journal/plan import cycles.
 * The plan's own immutable snapshot hash and the receipt's final-state hashes
 * must all agree before any unresolved call can be considered accounted for.
 */
export async function premiumReviewFinalizationMatches(db: JournalQueryDb, runId: string): Promise<boolean> {
  const fingerprint = (value: unknown) => canonPayloadFingerprint(jsonSnapshot(value) as JsonObject);
  try {
    const stored = (await db.query<{
      id: string; journal_fingerprint: string; request_fingerprint: string; receipt: Record<string, unknown>;
    }>("SELECT * FROM storyhold.world_analysis_premium_reconciliations WHERE run_id = $1", [runId])).rows[0];
    if (!stored?.receipt || typeof stored.receipt !== "object" || Array.isArray(stored.receipt)
      || !validReceiptBase(stored.receipt, runId)) return false;
    const receipt = stored.receipt;
    const run = (await db.query<Record<string, unknown>>(
      "SELECT * FROM storyhold.world_analysis_runs WHERE id = $1", [runId],
    )).rows[0];
    const savedPlan = (await db.query<{ snapshot: Record<string, unknown>; fingerprint: string }>(
      "SELECT snapshot, fingerprint FROM storyhold.world_analysis_premium_plans WHERE run_id = $1", [runId],
    )).rows[0];
    const plan = savedPlan?.snapshot;
    if (!run || stored.id !== receipt.id || run.status !== "failed"
      || run.premium_resume_status !== "not_available"
      || run.stage !== "Premium review reconciled and cancelled"
      || Number(run.premium_ai_credits_charged) !== receipt.creditsUsed
      || receipt.runId !== runId
      || receipt.worldId !== run.world_id || receipt.playerId !== run.requested_by_player_id
      || fingerprint(run) !== receipt.finalRunFingerprint) return false;
    const journal = await readPremiumJournalSnapshot(db, runId);
    if (stored.journal_fingerprint !== journal.fingerprint || receipt.journalFingerprint !== journal.fingerprint) return false;
    const related = await db.query<{ id: string }>(
      "SELECT id FROM storyhold.credit_reservations WHERE operation = 'world_analysis' AND request_id = $1", [runId],
    );
    let reservation: Record<string, unknown> | null = null;
    if (receipt.version === 1 || receipt.version === 4 || receipt.version === 6) {
      if (!plan || receipt.reconciliationMode !== undefined || receipt.legacyFundingFingerprint !== undefined
        || receipt.syntheticStepKey !== undefined || receipt.settledFundingFingerprint !== undefined
        || receipt.settlementLedgerFingerprint !== undefined || receipt.usageLedgerFingerprint !== undefined
        || receipt.requiredCredits !== undefined || receipt.uncoveredCredits !== undefined
        || receipt.clockManifestFingerprint !== undefined || plan.runId !== runId
        || plan.worldId !== run.world_id || plan.playerId !== run.requested_by_player_id
        || plan.editionId !== run.canon_edition_id || receipt.reservationId !== plan.reservationId
        || ![1, 2, 3].includes(Number(plan.version))
        || fingerprint({ namespace: `storyhold:premium-review-plan:v${Number(plan.version)}`, plan }) !== savedPlan?.fingerprint
        || fingerprint(plan) !== receipt.planFingerprint) return false;
      if (!(await plannedJournalScopeMatches(db, plan, run, journal.rows))) return false;
      const journalCost = receiptJournalEconomics(journal.rows, receipt.decisions, "planned");
      if (journalCost === null || receipt.costMicros !== journalCost) return false;
      if (plan.unlimited === true) {
        // Current role is an admission check, not historical receipt truth. A
        // later demotion cannot reopen an already-finalized provider run.
        if (plan.reservationId !== null || plan.reservedCredits !== 0
          || receipt.creditsUsed !== 0 || receipt.creditsRefunded !== 0
          || related.rows.length) return false;
      } else {
        if (plan.unlimited !== false || typeof plan.reservationId !== "string" || related.rows.length !== 1 || related.rows[0]?.id !== plan.reservationId) return false;
        reservation = (await db.query<Record<string, unknown>>(
          "SELECT * FROM storyhold.credit_reservations WHERE id = $1", [plan.reservationId],
        )).rows[0] ?? null;
        if (!reservation || reservation.status !== "settled" || reservation.operation !== "world_analysis"
          || reservation.world_id !== run.world_id || reservation.player_id !== run.requested_by_player_id
          || reservation.request_id !== runId || Number(reservation.reserved_credits) !== plan.reservedCredits
          || Number(reservation.actual_credits) !== receipt.creditsUsed || Number(reservation.cost_micros) !== receipt.costMicros
          || !(await reconciliationSettlementMatches(db, reservation, {
            provider: String(plan.provider), model: String(plan.model), costMicros: receipt.costMicros,
           creditsUsed: receipt.creditsUsed, creditsRefunded: receipt.creditsRefunded,
           accountingSource: "operator_reconciliation",
          }, receipt.version === 6))) return false;
      }
    } else if (receipt.version === 2 || receipt.version === 5 || receipt.version === 7) {
      if (savedPlan || receipt.reconciliationMode !== "legacy_retained_hold"
        || receipt.planFingerprint !== null
        || receipt.syntheticStepKey !== LEGACY_PREMIUM_RECOVERY_TOTAL_STEP_KEY
        || receipt.settledFundingFingerprint !== undefined
        || receipt.settlementLedgerFingerprint !== undefined
        || receipt.usageLedgerFingerprint !== undefined
        || receipt.requiredCredits !== undefined || receipt.uncoveredCredits !== undefined
        || receipt.clockManifestFingerprint !== undefined
        || typeof receipt.reservationId !== "string"
        || !safeNonnegativeInteger(receipt.reservedCredits)
        || related.rows.length !== 1 || related.rows[0]?.id !== receipt.reservationId
        || !Array.isArray(receipt.decisions) || receipt.decisions.length !== 1
        || receipt.decisions[0]?.stepKey !== LEGACY_PREMIUM_RECOVERY_TOTAL_STEP_KEY
        || journal.rows.some((row) => row.step_key === LEGACY_PREMIUM_RECOVERY_TOTAL_STEP_KEY)) return false;
      reservation = (await db.query<Record<string, unknown>>(
        "SELECT * FROM storyhold.credit_reservations WHERE id = $1", [receipt.reservationId],
      )).rows[0] ?? null;
      const journalCost = receiptJournalEconomics(journal.rows, receipt.decisions, "legacy");
      if (journalCost === null || receipt.costMicros !== journalCost) return false;
      if (!reservation || reservation.status !== "settled" || reservation.operation !== "world_analysis"
        || reservation.world_id !== run.world_id || reservation.player_id !== run.requested_by_player_id
        || reservation.request_id !== runId || Number(reservation.reserved_credits) !== receipt.reservedCredits
        || Number(reservation.actual_credits) !== receipt.creditsUsed || Number(reservation.cost_micros) !== receipt.costMicros
        || reservation.provider !== LEGACY_PREMIUM_RECOVERY_PROVIDER
        || reservation.model !== LEGACY_PREMIUM_RECOVERY_MODEL
        || receipt.creditsRefunded !== (receipt.version === 7
          ? Math.max(0, Number(reservation.reserved_credits) - Number(reservation.actual_credits))
          : Number(reservation.reserved_credits) - Number(reservation.actual_credits))
        || !(await reconciliationSettlementMatches(db, reservation, {
          provider: LEGACY_PREMIUM_RECOVERY_PROVIDER, model: LEGACY_PREMIUM_RECOVERY_MODEL,
          costMicros: receipt.costMicros, creditsUsed: receipt.creditsUsed,
           creditsRefunded: receipt.creditsRefunded,
           accountingSource: "operator_reconciliation_legacy_total",
          }, receipt.version === 7))
        || legacyPremiumRecoveryFundingFingerprint({
          runId, worldId: String(run.world_id), editionId: String(run.canon_edition_id),
          playerId: String(run.requested_by_player_id), reservationId: String(reservation.id),
          reservedCredits: Number(reservation.reserved_credits),
        }) !== receipt.legacyFundingFingerprint) return false;
    } else if (receipt.version === 3 || receipt.version === 8) {
      if (!plan || receipt.reconciliationMode !== SETTLED_PREMIUM_RECOVERY_MODE
        || receipt.legacyFundingFingerprint !== undefined
        || receipt.syntheticStepKey !== undefined
        || receipt.planFingerprint !== fingerprint(plan)
        || plan.runId !== runId
        || plan.worldId !== run.world_id
        || plan.editionId !== run.canon_edition_id
        || plan.playerId !== run.requested_by_player_id
        || ![1, 2, 3].includes(Number(plan.version))
        || fingerprint({ namespace: `storyhold:premium-review-plan:v${Number(plan.version)}`, plan }) !== savedPlan?.fingerprint
        || plan.unlimited !== false
        || typeof plan.reservationId !== "string"
        || receipt.reservationId !== plan.reservationId
        || !safeNonnegativeInteger(receipt.reservedCredits)
        || receipt.reservedCredits !== plan.reservedCredits
        // v3 retains its original within-hold meaning. v8 explicitly records
        // a fully funded settlement that exceeded the original estimate.
        || (receipt.version === 3 && receipt.creditsUsed > Number(receipt.reservedCredits))
        || (receipt.version === 8 && receipt.creditsUsed <= Number(receipt.reservedCredits))
        || !safeNonnegativeInteger(receipt.requiredCredits)
        || !safeNonnegativeInteger(receipt.uncoveredCredits)
        || typeof receipt.settledFundingFingerprint !== "string"
        || typeof receipt.settlementLedgerFingerprint !== "string"
        || typeof receipt.usageLedgerFingerprint !== "string"
        || (receipt.clockManifestFingerprint !== null
          && typeof receipt.clockManifestFingerprint !== "string")
        || !Array.isArray(receipt.decisions)
        || receipt.decisions.length !== 0
        || related.rows.length !== 1
        || related.rows[0]?.id !== plan.reservationId) return false;
      reservation = (await db.query<Record<string, unknown>>(
        "SELECT * FROM storyhold.credit_reservations WHERE id = $1", [plan.reservationId],
      )).rows[0] ?? null;
      const accounting = await readSettledPremiumRecoveryAccounting(db, {
        runId,
        worldId: String(run.world_id),
        editionId: String(run.canon_edition_id),
        playerId: String(run.requested_by_player_id),
        reservationId: plan.reservationId,
        reservedCredits: Number(plan.reservedCredits),
        planVersion: Number(plan.version) as 1 | 2 | 3,
        verificationStepKeys: (plan.version === 2 || plan.version === 3)
          ? (plan.verificationPages as Array<{ stepKey: string }>).map((page) => page.stepKey)
          : (plan.verificationBatches as unknown[]).map((_batch, index) => `verification:${index}`),
        maximumChronologySteps: Array.isArray(plan.verificationBatches)
          ? plan.verificationBatches.length * PREMIUM_CLOCK_PAGES_PER_VERIFICATION_BATCH_LIMIT
          : -1,
        requestScopeFingerprint: recoveryScopeFingerprint({
          evidence: recoveryEvidencePin(run),
          plan,
        }),
        requestProvider: String(plan.provider),
        requestModel: String(plan.model),
      });
      if (!reservation || !accounting
        || receipt.costMicros !== accounting.usage.estimatedCostMicros
        || receipt.creditsUsed !== accounting.creditsUsed
        || receipt.creditsRefunded !== accounting.creditsRefunded
        || receipt.requiredCredits !== accounting.requiredCredits
        || receipt.uncoveredCredits !== accounting.uncoveredCredits
        || receipt.settledFundingFingerprint !== accounting.fundingFingerprint
        || receipt.settlementLedgerFingerprint !== accounting.settlementLedgerFingerprint
        || receipt.usageLedgerFingerprint !== accounting.usageLedgerFingerprint
        || receipt.clockManifestFingerprint !== accounting.clockManifestFingerprint) return false;
    } else return false;
    if (fingerprint(reservation) !== receipt.finalReservationFingerprint) return false;
    const request = {
      actorId: receipt.actorId,
      runId,
      expectedFingerprint: receipt.expectedFingerprint,
      note: receipt.note,
      decisions: receipt.decisions,
    };
    const expectedRequestFingerprint = receipt.version === 1 || receipt.version === 2
      ? fingerprint(request)
      : fingerprint({
          namespace: "storyhold:premium-reconciliation-request:v2",
          receiptVersion: receipt.version,
          recoveryMode: receipt.version === 3 || receipt.version === 8
            ? "settled_accounting_adoption"
            : receipt.version === 5 || receipt.version === 7
              ? "legacy_total_attestation"
              : "planned_attestation",
          ...request,
        });
    return stored.request_fingerprint === expectedRequestFingerprint;
  } catch {
    return false;
  }
}

/** The receipt covers every stored field and every call, not only unresolved calls. */
export async function readPremiumJournalSnapshot(db: JournalQueryDb, runId: string): Promise<{
  rows: PremiumJournalRow[];
  fingerprint: string;
}> {
  const result = await db.query<PremiumJournalRow>(
    "SELECT * FROM storyhold.world_analysis_ai_calls WHERE run_id = $1 ORDER BY step_key",
    [runId],
  );
  for (const row of result.rows) assertIntegrity(row);
  return {
    rows: result.rows,
    fingerprint: canonPayloadFingerprint(jsonSnapshot({
      version: "storyhold:premium-review-journal:v1", rows: result.rows,
    }) as unknown as JsonObject),
  };
}

/** Hash exactly the JSON that can be durably stored, never executable callbacks. */
function jsonSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function outcomeFingerprint(
  status: JournalStatus,
  result: AiTextResult | null,
  attempts: AiBillableAttempt[],
): string {
  return canonPayloadFingerprint(jsonSnapshot({
    version: "storyhold:premium-review-outcome:v1",
    status,
    result,
    billableAttempts: attempts,
  }) as unknown as JsonObject);
}

function assertIntegrity(row: JournalRow): void {
  try {
    if (
      !row.request_snapshot
      || canonPayloadFingerprint(row.request_snapshot) !== row.request_fingerprint
      || !Array.isArray(row.billable_attempts)
      || !["dispatched", "completed", "rejected", "uncertain"].includes(row.status)
      || (row.status === "dispatched" && (
        row.result_snapshot !== null
        || row.result_fingerprint !== null
        || row.billable_attempts.length !== 0
      ))
      || (row.status !== "dispatched" && (
        !row.result_fingerprint
        || outcomeFingerprint(row.status, row.result_snapshot, row.billable_attempts)
          !== row.result_fingerprint
      ))
      || (row.status === "completed" && (
        !row.result_snapshot
        || typeof row.result_snapshot.text !== "string"
        || !row.result_snapshot.usage
        || !row.result_snapshot.runtime
      ))
    ) {
      throw new Error("Stored journal contents do not match their fingerprint.");
    }
  } catch {
    throw new PremiumJournalError(
      "JOURNAL_INTEGRITY",
      `Premium review step ${row.step_key} failed its stored journal integrity check.`,
    );
  }
}

function successfulAttempts(result: AiTextResult): AiBillableAttempt[] {
  return [
    ...(result.priorBillableAttempts ?? []),
    {
      provider: result.provider,
      model: result.model,
      resolvedModel: result.runtime.execution?.resolvedModel ?? result.model,
      upstreamProvider: result.runtime.execution?.upstreamProvider ?? null,
      stage: result.runtime.stage,
      reasoning: result.reasoning,
      usage: result.usage,
    },
  ];
}

async function saveOutcome(
  db: JournalQueryDb,
  params: { runId: string; stepKey: string; requestFingerprint: string },
  status: Exclude<JournalStatus, "dispatched">,
  result: AiTextResult | null,
  attempts: AiBillableAttempt[],
  error: string | null,
): Promise<void> {
  try {
    const saved = await db.query(
      `UPDATE storyhold.world_analysis_ai_calls
          SET status = $4, result_snapshot = $5::jsonb,
              result_fingerprint = $6, billable_attempts = $7::jsonb,
              error = $8, updated_at = now(), completed_at = now()
        WHERE run_id = $1 AND step_key = $2 AND request_fingerprint = $3
          AND status = 'dispatched'
          AND NOT EXISTS (
            SELECT 1 FROM storyhold.world_analysis_premium_reconciliations WHERE run_id = $1
          )
        RETURNING step_key`,
      [
        params.runId,
        params.stepKey,
        params.requestFingerprint,
        status,
        result === null ? null : JSON.stringify(result),
        outcomeFingerprint(status, result, attempts),
        JSON.stringify(attempts),
        error,
      ],
    );
    if (saved.rows.length !== 1) throw new Error("The dispatched journal row changed.");
  } catch {
    // Do not attempt another write or remote call. A failed/ambiguous commit
    // must remain visibly unresolved until an operator reconciles the charge.
    throw new PremiumJournalError(
      "JOURNAL_PERSISTENCE",
      `Could not durably record premium review step ${params.stepKey}; reconciliation is required before any retry.`,
    );
  }
}

export async function executeJournaledPremiumCall(
  db: JournalDb,
  params: {
    runId: string;
    stepKey: string;
    request: GenerateAiTextInput;
    provider: string;
    model: string;
    scopeFingerprint?: string;
    reservationId?: string | null;
    invoke: () => Promise<AiTextResult>;
  },
): Promise<AiTextResult> {
  const { validate: _validate, ...request } = params.request;
  const requestSnapshot = jsonSnapshot({
    version: "storyhold:premium-review-request:v1",
    provider: params.provider,
    model: params.model,
    scopeFingerprint: params.scopeFingerprint,
    request,
  }) as unknown as JsonObject;
  const requestFingerprint = canonPayloadFingerprint(requestSnapshot);
  let existing: JournalRow | undefined;
  try {
    existing = await db.transaction(async (tx) => {
      // Serialize dispatch with operator finalization before touching any hold.
      await tx.query("SELECT id FROM storyhold.world_analysis_runs WHERE id = $1 FOR UPDATE", [params.runId]);
      if (await premiumReviewHasFinalization(tx, params.runId)) {
        throw new PremiumJournalError("REVIEW_FINALIZED", "This premium review was finalized and cannot dispatch or replay provider work.");
      }
      const inserted = await tx.query(
        `INSERT INTO storyhold.world_analysis_ai_calls
          (run_id, step_key, request_fingerprint, request_snapshot)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (run_id, step_key) DO NOTHING
         RETURNING step_key`,
        [params.runId, params.stepKey, requestFingerprint, JSON.stringify(requestSnapshot)],
      );
      if (inserted.rows.length > 0) {
        if (params.reservationId) {
          const held = await tx.query(
            `UPDATE storyhold.credit_reservations AS reservation
                SET usage = reservation.usage || '{"retainUntilReconciled":true}'::jsonb
              WHERE reservation.id = $1 AND reservation.status = 'reserved'
                AND reservation.operation = 'world_analysis'
                AND reservation.request_id = $2
                AND EXISTS (
                  SELECT 1 FROM storyhold.world_analysis_runs AS run
                   WHERE run.id = $2::uuid
                     AND run.world_id = reservation.world_id
                     AND run.requested_by_player_id = reservation.player_id
                )
              RETURNING reservation.id`,
            [params.reservationId, params.runId],
          );
          if (held.rows.length !== 1) {
            throw new PremiumJournalError(
              "RESERVATION_UNAVAILABLE",
              "Premium review requires an active credit reservation before dispatch.",
            );
          }
        }
        return undefined;
      }
      const prior = await tx.query<JournalRow>(
        "SELECT * FROM storyhold.world_analysis_ai_calls WHERE run_id = $1 AND step_key = $2",
        [params.runId, params.stepKey],
      );
      if (!prior.rows[0]) throw new Error("The existing journal row is missing.");
      return prior.rows[0];
    });
  } catch (error) {
    if (error instanceof PremiumJournalError) throw error;
    throw new PremiumJournalError(
      "JOURNAL_PERSISTENCE",
      "The premium review dispatch could not be journaled; no provider call was started.",
    );
  }

  if (existing) {
    assertIntegrity(existing);
    if (existing.request_fingerprint !== requestFingerprint) {
      throw new PremiumJournalError(
        "REQUEST_MISMATCH",
        `Premium review step ${params.stepKey} already has a different request; a new reviewed run is required.`,
      );
    }
    if (existing.status !== "completed") {
      throw new PremiumJournalError(
        existing.status === "rejected" ? "PREVIOUSLY_REJECTED" : "OUTCOME_UNRESOLVED",
        `Premium review step ${params.stepKey} is ${existing.status}; automatic redispatch is blocked.`,
      );
    }
    const result = existing.result_snapshot!;
    params.request.validate?.(result.text);
    return result;
  }

  // No network call happens until BOTH dispatch and its retained hold commit.
  let result: AiTextResult;
  try {
    result = await params.invoke();
  } catch (error) {
    const attempts = error instanceof AiGatewayUnavailableError
      ? error.billableAttempts
      : [];
    // Known attempt receipts do not prove that every dispatched attempt has a
    // known outcome. For example, one invalid billable response can be followed
    // by a timeout whose bill is still unknown. Only an explicit false from the
    // gateway is enough to close the attempt inventory as rejected-and-known;
    // undefined is deliberately not evidence of no additional charge.
    const hasUncertainOutcome = !(error instanceof AiGatewayUnavailableError)
      || error.hasUncertainOutcome !== false;
    await saveOutcome(
      db,
      { ...params, requestFingerprint },
      attempts.length > 0 && !hasUncertainOutcome ? "rejected" : "uncertain",
      null,
      attempts,
      error instanceof Error ? error.message.slice(0, 1000) : "Unknown provider failure",
    );
    if (hasUncertainOutcome || attempts.length === 0) {
      throw new PremiumJournalError(
        "OUTCOME_UNRESOLVED",
        `Premium review step ${params.stepKey} has an unknown provider outcome; reconciliation is required.`,
      );
    }
    throw error;
  }

  // Snapshot and persist the whole result, including usage, before callers can
  // fail validation, update progress, pause, or crash in any downstream work.
  try {
    result = jsonSnapshot({ ...result, journalCompletedAt: new Date().toISOString() });
    await saveOutcome(
      db,
      { ...params, requestFingerprint },
      "completed",
      result,
      successfulAttempts(result),
      null,
    );
  } catch (error) {
    if (error instanceof PremiumJournalError) throw error;
    throw new PremiumJournalError(
      "JOURNAL_PERSISTENCE",
      `Premium review step ${params.stepKey} returned an unrecordable result; reconciliation is required.`,
    );
  }
  return result;
}

export async function readPremiumJournalAccounting(
  db: JournalQueryDb,
  runId: string,
): Promise<{ attempts: AiBillableAttempt[]; hasUncertain: boolean; callCount: number }> {
  const rows = await db.query<JournalRow>(
    "SELECT * FROM storyhold.world_analysis_ai_calls WHERE run_id = $1 ORDER BY created_at, step_key",
    [runId],
  );
  const attempts: AiBillableAttempt[] = [];
  let hasUncertain = false;
  for (const row of rows.rows) {
    assertIntegrity(row);
    if (row.status === "dispatched" || row.status === "uncertain") {
      hasUncertain = true;
    }
    attempts.push(...row.billable_attempts);
  }
  return { attempts, hasUncertain, callCount: rows.rows.length };
}

/** A fresh run must not bypass an earlier unresolved charge in the same world. */
export async function premiumReviewReconciliationPending(
  db: JournalQueryDb,
  worldId: string,
): Promise<boolean> {
  const pending = await db.query<{ pending: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM storyhold.credit_reservations
        WHERE world_id = $1 AND operation = 'world_analysis'
          AND status = 'reserved' AND usage->>'retainUntilReconciled' = 'true'
     ) AS pending`,
    [worldId],
  );
  if (pending.rows[0]?.pending === true) return true;
  const runs = await db.query<{
    id: string; status: string; journal_fingerprint: string | null;
  }>(
    `SELECT run.id, run.status, receipt.journal_fingerprint
       FROM storyhold.world_analysis_runs AS run
       LEFT JOIN storyhold.world_analysis_premium_reconciliations AS receipt ON receipt.run_id = run.id
      WHERE run.world_id = $1 AND (receipt.run_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM storyhold.world_analysis_ai_calls AS call
         WHERE call.run_id = run.id AND call.status IN ('dispatched', 'uncertain')
      ) OR (run.status IN ('queued', 'running', 'paused') AND EXISTS (
        SELECT 1 FROM storyhold.credit_reservations AS hold
         WHERE hold.request_id = run.id::text
           AND hold.operation = 'world_analysis' AND hold.status = 'settled'
      )))`,
    [worldId],
  );
  for (const run of runs.rows) {
    if (!run.journal_fingerprint || run.status !== "failed") return true;
    if (!await premiumReviewFinalizationMatches(db, run.id)) return true;
  }
  return false;
}

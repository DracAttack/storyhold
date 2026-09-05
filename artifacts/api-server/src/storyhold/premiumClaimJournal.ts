import type { PGlite } from "@electric-sql/pglite";
import { buildVerifiedPromotionPlan, canonPayloadFingerprint, type JsonObject } from "./analysisVerificationContracts";
import { assertPremiumClaimReceipt, type PremiumClaimPayload, type PremiumClaimReviewReceipt } from "./premiumClaimVerification";
import { knowledgeClaimFingerprint, loadWorldEntityNameResolution, type KnowledgeEvidence } from "./worldKnowledge";

type QueryDb = Pick<PGlite, "query">;
export type PremiumClaimScope = { worldId: string; editionId: string; analysisRunId: string };
type StoredRow = {
  run_id: string;
  world_id: string;
  edition_id: string;
  step_key: string;
  receipt_fingerprint: string;
  snapshot_fingerprint: string;
  snapshot: PremiumClaimReviewReceipt;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const premiumClaimJournalSchemaSql = String.raw`
  CREATE TABLE IF NOT EXISTS storyhold.world_analysis_claim_reviews (
    run_id uuid NOT NULL REFERENCES storyhold.world_analysis_runs(id) ON DELETE CASCADE,
    world_id uuid NOT NULL,
    edition_id uuid NOT NULL,
    step_key text NOT NULL CHECK (length(step_key) BETWEEN 1 AND 200),
    receipt_fingerprint text NOT NULL,
    snapshot_fingerprint text NOT NULL,
    snapshot jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, step_key)
  );
  CREATE OR REPLACE FUNCTION storyhold.reject_premium_claim_review_update()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'Premium claim review receipts are immutable';
  END;
  $$;
  DROP TRIGGER IF EXISTS premium_claim_review_immutable ON storyhold.world_analysis_claim_reviews;
  CREATE TRIGGER premium_claim_review_immutable
    BEFORE UPDATE ON storyhold.world_analysis_claim_reviews
    FOR EACH ROW EXECUTE FUNCTION storyhold.reject_premium_claim_review_update();

  CREATE TABLE IF NOT EXISTS storyhold.world_knowledge_claim_verifications (
    claim_id uuid NOT NULL REFERENCES storyhold.world_knowledge_claims(id) ON DELETE CASCADE,
    run_id uuid NOT NULL,
    step_key text NOT NULL,
    proposal_id text NOT NULL,
    decision_id text NOT NULL,
    payload_fingerprint text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, step_key, proposal_id),
    FOREIGN KEY (run_id, step_key) REFERENCES storyhold.world_analysis_claim_reviews(run_id, step_key) ON DELETE CASCADE
  );
  DROP TRIGGER IF EXISTS premium_claim_verification_link_immutable ON storyhold.world_knowledge_claim_verifications;
  CREATE TRIGGER premium_claim_verification_link_immutable
    BEFORE UPDATE ON storyhold.world_knowledge_claim_verifications
    FOR EACH ROW EXECUTE FUNCTION storyhold.reject_premium_claim_review_update();
`;

export class PremiumClaimJournalError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "PremiumClaimJournalError";
  }
}
function invalid(code: string, message: string): never { throw new PremiumClaimJournalError(code, message); }
function validateScope(scope: PremiumClaimScope): void {
  if (!scope || [scope.worldId, scope.editionId, scope.analysisRunId].some((id) => typeof id !== "string" || !UUID.test(id))) {
    invalid("CLAIM_SCOPE_INVALID", "Claim reviews require an exact world, edition, and analysis run.");
  }
}
function validateStepKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || key.length === 0 || key.length > 200 || key !== key.trim() || /[\u0000-\u001f\u007f]/u.test(key)) {
    invalid("CLAIM_STEP_INVALID", "A claim review requires a bounded, nonblank step identifier.");
  }
}
function sameScope(left: PremiumClaimScope, right: PremiumClaimScope): boolean {
  return left.worldId === right.worldId && left.editionId === right.editionId && left.analysisRunId === right.analysisRunId;
}
function fingerprint(receipt: PremiumClaimReviewReceipt): string {
  return canonPayloadFingerprint(receipt as unknown as JsonObject);
}
function snapshot(receipt: PremiumClaimReviewReceipt): PremiumClaimReviewReceipt {
  try {
    assertPremiumClaimReceipt(receipt);
    validateScope(receipt.request.scope);
    validateStepKey(receipt.request.stepKey);
    // Hash before serialization: otherwise non-JSON values may disappear or
    // become null silently. Persist only the exact fully validated JSON value.
    const before = fingerprint(receipt);
    const value = JSON.parse(JSON.stringify(receipt)) as PremiumClaimReviewReceipt;
    assertPremiumClaimReceipt(value);
    if (fingerprint(value) !== before) invalid("CLAIM_RECEIPT_INVALID", "Claim review serialization changed its contents.");
    return value;
  } catch (error) {
    if (error instanceof PremiumClaimJournalError) throw error;
    invalid("CLAIM_RECEIPT_INVALID", "The claim review receipt failed validation.");
  }
}

async function assertRunScope(db: QueryDb, scope: PremiumClaimScope, lock: boolean): Promise<void> {
  validateScope(scope);
  const run = await db.query(
    `SELECT id FROM storyhold.world_analysis_runs
      WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3
        AND analysis_kind = 'ai_enrichment'${lock ? " FOR UPDATE" : ""}`,
    [scope.analysisRunId, scope.worldId, scope.editionId],
  );
  if (run.rows.length !== 1) invalid("CLAIM_SCOPE_MISMATCH", "The premium analysis run no longer matches this claim review's world and edition.");
}
function validateStored(row: StoredRow, scope: PremiumClaimScope): PremiumClaimReviewReceipt {
  try {
    const receipt = snapshot(row.snapshot);
    if (row.run_id !== scope.analysisRunId || row.world_id !== scope.worldId || row.edition_id !== scope.editionId
      || !sameScope(receipt.request.scope, scope) || row.step_key !== receipt.request.stepKey
      || row.receipt_fingerprint !== receipt.fingerprint || row.snapshot_fingerprint !== fingerprint(receipt)) {
      invalid("CLAIM_JOURNAL_INTEGRITY", "The stored claim review no longer matches its scope or full snapshot fingerprint.");
    }
    return receipt;
  } catch {
    invalid("CLAIM_JOURNAL_INTEGRITY", "The stored claim review failed its integrity check.");
  }
}

export async function ensurePremiumClaimJournal(db: Pick<PGlite, "exec">): Promise<void> {
  await db.exec(premiumClaimJournalSchemaSql);
}

/** Caller owns the transaction that also writes canonical claims. No provider
 * requests, nested transaction, scope inference, or receipt rewrite occurs.
 * journalCompletedAt makes identical response replay byte-for-byte stable.
 */
export async function savePremiumClaimReview(db: QueryDb, receipt: PremiumClaimReviewReceipt): Promise<PremiumClaimReviewReceipt> {
  const value = snapshot(receipt);
  const scope = value.request.scope;
  await assertRunScope(db, scope, true);
  const fullFingerprint = fingerprint(value);
  await db.query(
    `INSERT INTO storyhold.world_analysis_claim_reviews
      (run_id, world_id, edition_id, step_key, receipt_fingerprint, snapshot_fingerprint, snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (run_id, step_key) DO NOTHING`,
    [scope.analysisRunId, scope.worldId, scope.editionId, value.request.stepKey,
      value.fingerprint, fullFingerprint, JSON.stringify(value)],
  );
  const stored = (await db.query<StoredRow>(
    "SELECT * FROM storyhold.world_analysis_claim_reviews WHERE run_id = $1 AND step_key = $2",
    [scope.analysisRunId, value.request.stepKey],
  )).rows[0];
  if (!stored) invalid("CLAIM_JOURNAL_PERSISTENCE", "The claim review receipt was not durably saved.");
  const existing = validateStored(stored, scope);
  if (fingerprint(existing) !== fullFingerprint) {
    invalid("CLAIM_RECEIPT_MISMATCH", "A different immutable claim review already exists for this analysis step.");
  }
  return existing;
}

export async function readPremiumClaimReviews(db: QueryDb, scope: PremiumClaimScope): Promise<PremiumClaimReviewReceipt[]> {
  await assertRunScope(db, scope, false);
  // Read by run alone so corrupted redundant scope columns cannot disappear
  // behind a WHERE filter and produce an apparently valid partial inventory.
  const stored = await db.query<StoredRow>(
    "SELECT * FROM storyhold.world_analysis_claim_reviews WHERE run_id = $1 ORDER BY step_key", [scope.analysisRunId],
  );
  return stored.rows.map((row) => validateStored(row, scope));
}

/** Exact set equality is required at the canonical write boundary, including
 * zero-claim batches: every expected paid batch needs its own trusted receipt.
 */
export function assertExpectedPremiumClaimReviews(receipts: PremiumClaimReviewReceipt[], params: {
  scope: PremiumClaimScope;
  expectedStepKeys: string[];
}): void {
  validateScope(params.scope);
  if (!Array.isArray(receipts) || !Array.isArray(params.expectedStepKeys)) {
    invalid("CLAIM_RECEIPTS_INCOMPLETE", "Expected claim review receipts must be explicit arrays.");
  }
  const expected = new Set<string>();
  for (const key of params.expectedStepKeys) {
    validateStepKey(key);
    if (expected.has(key)) invalid("CLAIM_RECEIPTS_INCOMPLETE", "Expected claim review step identifiers must be unique.");
    expected.add(key);
  }
  if (receipts.length !== expected.size) invalid("CLAIM_RECEIPTS_INCOMPLETE", "Every expected premium batch must have exactly one claim review receipt.");
  const seen = new Set<string>();
  for (const receipt of receipts) {
    const value = snapshot(receipt);
    const key = value.request.stepKey;
    if (!sameScope(value.request.scope, params.scope)) invalid("CLAIM_SCOPE_MISMATCH", "A claim review belongs to a different world, edition, or analysis run.");
    if (!expected.has(key) || seen.has(key)) invalid("CLAIM_RECEIPTS_INCOMPLETE", "Claim review receipts contain an extra or duplicate premium batch.");
    seen.add(key);
  }
}

/** Record only verified decisions which actually materialized as this run's
 * non-user canonical rows. A review receipt alone never implies canon exists.
 * Call after syncWorldKnowledgeClaims in the same caller-owned transaction.
 * The return value counts newly inserted links; an exact replay returns zero.
 */
export async function linkPremiumClaimReviewsToCanon(db: QueryDb, receipts: PremiumClaimReviewReceipt[]): Promise<number> {
  const normalized = (value: string) => value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const evidenceKey = (value: KnowledgeEvidence) => `${value.chunkId}\u0000${value.sourceId}\u0000${normalized(value.quote).slice(0, 500)}`;
  const inventories = new Map<string, Map<string, PremiumClaimReviewReceipt>>();
  const resolutions = new Map<string, Awaited<ReturnType<typeof loadWorldEntityNameResolution>>>();
  const seen = new Set<string>();
  let linked = 0;
  for (const supplied of receipts) {
    const receipt = snapshot(supplied);
    const scope = receipt.request.scope;
    const scopeKey = `${scope.worldId}:${scope.editionId}:${scope.analysisRunId}`;
    const stepIdentity = `${scopeKey}:${receipt.request.stepKey}`;
    if (seen.has(stepIdentity)) invalid("CLAIM_RECEIPTS_INCOMPLETE", "Duplicate claim review receipts cannot produce canonical links.");
    seen.add(stepIdentity);
    let inventory = inventories.get(scopeKey);
    if (!inventory) {
      inventory = new Map((await readPremiumClaimReviews(db, scope)).map((item) => [item.request.stepKey, item]));
      inventories.set(scopeKey, inventory);
    }
    const saved = inventory.get(receipt.request.stepKey);
    if (!saved || fingerprint(saved) !== fingerprint(receipt)) {
      invalid("CLAIM_RECEIPT_MISMATCH", "Canonical links require the exact durably saved claim review receipt.");
    }
    let resolution = resolutions.get(scopeKey);
    if (!resolution) {
      resolution = await loadWorldEntityNameResolution({ db, worldId: scope.worldId, editionId: scope.editionId });
      resolutions.set(scopeKey, resolution);
    }
    const anchors = new Map(receipt.packet.evidence.map((anchor) => [anchor.id, anchor]));
    for (const entry of buildVerifiedPromotionPlan(receipt.packet, receipt.decisions, receipt.batch)) {
      const claim = entry.payload as unknown as PremiumClaimPayload;
      const subjectId = resolution.idsByName.get(normalized(claim.subject));
      const objectId = claim.value ? resolution.idsByName.get(normalized(claim.value)) : undefined;
      const holderId = claim.epistemicHolder ? resolution.idsByName.get(normalized(claim.epistemicHolder)) : undefined;
      if (!subjectId || objectId === null || (claim.epistemicHolder && !holderId)) continue;
      const identity = {
        subjectEntityId: subjectId, predicate: claim.predicate, polarity: claim.polarity ?? "positive",
        objectEntityId: objectId ?? null, objectText: claim.value, epistemicHolderEntityId: holderId ?? null,
        truthStatus: claim.truthStatus, validFromLabel: claim.validFromLabel, validUntilLabel: claim.validUntilLabel,
      };
      const expectedFingerprint = knowledgeClaimFingerprint(identity);
      const materialized = (await db.query<{
        id: string; fingerprint: string; subject_entity_id: string; predicate: string; polarity: "positive" | "negative";
        object_entity_id: string | null; object_text: string; epistemic_holder_entity_id: string | null;
        truth_status: PremiumClaimPayload["truthStatus"]; valid_from_label: string; valid_until_label: string;
        evidence: KnowledgeEvidence[];
      }>(
        `SELECT * FROM storyhold.world_knowledge_claims
          WHERE world_id = $1 AND canon_edition_id = $2 AND fingerprint = $3
            AND source_analysis_run_id = $4 AND assignment_source <> 'user' FOR UPDATE`,
        [scope.worldId, scope.editionId, expectedFingerprint, scope.analysisRunId],
      )).rows[0];
      if (!materialized || !Array.isArray(materialized.evidence)) continue;
      // Fingerprint column alone is not authority if the materialized payload
      // drifted; recompute it using exactly the production identity mapping.
      if (knowledgeClaimFingerprint({
        subjectEntityId: materialized.subject_entity_id, predicate: materialized.predicate, polarity: materialized.polarity,
        objectEntityId: materialized.object_entity_id, objectText: materialized.object_text,
        epistemicHolderEntityId: materialized.epistemic_holder_entity_id, truthStatus: materialized.truth_status,
        validFromLabel: materialized.valid_from_label, validUntilLabel: materialized.valid_until_label,
      }) !== expectedFingerprint) continue;
      const retainedEvidence = new Set(materialized.evidence.filter((anchor) => anchor && typeof anchor.chunkId === "string"
        && typeof anchor.sourceId === "string" && typeof anchor.quote === "string").map(evidenceKey));
      const supporting = entry.decision.supportingEvidenceIds.map((id) => anchors.get(id));
      if (!supporting.length || supporting.some((anchor) => !anchor || !retainedEvidence.has(evidenceKey(anchor)))) continue;
      const inserted = await db.query(
        `INSERT INTO storyhold.world_knowledge_claim_verifications
          (claim_id, run_id, step_key, proposal_id, decision_id, payload_fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (run_id, step_key, proposal_id) DO NOTHING RETURNING claim_id`,
        [materialized.id, scope.analysisRunId, receipt.request.stepKey, entry.proposal.id, entry.decision.id, entry.payloadFingerprint],
      );
      if (inserted.rows.length) linked += 1;
      else {
        const existing = (await db.query<{ claim_id: string; decision_id: string; payload_fingerprint: string }>(
          `SELECT claim_id, decision_id, payload_fingerprint FROM storyhold.world_knowledge_claim_verifications
            WHERE run_id = $1 AND step_key = $2 AND proposal_id = $3`,
          [scope.analysisRunId, receipt.request.stepKey, entry.proposal.id],
        )).rows[0];
        if (!existing || existing.claim_id !== materialized.id || existing.decision_id !== entry.decision.id
          || existing.payload_fingerprint !== entry.payloadFingerprint) {
          invalid("CLAIM_LINK_MISMATCH", "A different immutable canonical claim link already exists for this verified decision.");
        }
      }
    }
  }
  return linked;
}

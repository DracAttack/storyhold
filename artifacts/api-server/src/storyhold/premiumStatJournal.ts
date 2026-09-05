import type { PGlite } from "@electric-sql/pglite";
import { buildVerifiedPromotionPlan, canonPayloadFingerprint, type JsonObject, type VerifiedPromotionEntry } from "./analysisVerificationContracts";
import { assertPremiumStatReceipt, statsFromPremiumReceipts, type PremiumStatReviewReceipt } from "./premiumStatVerification";
import { PREMIUM_STAT_FAMILIES, PREMIUM_STAT_NAMES, premiumNeutralStats, premiumStatCandidates } from "./premiumStatCandidates";
import type { CharacterFinding, NamedFinding, WorldFindings } from "./worldAnalysis";

type QueryDb = Pick<PGlite, "query">;
export type PremiumStatScope = { worldId: string; editionId: string; analysisRunId: string };
type StoredReview = {
  run_id: string; world_id: string; edition_id: string; step_key: string;
  receipt_fingerprint: string; snapshot_fingerprint: string; snapshot: PremiumStatReviewReceipt;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const premiumStatJournalSchemaSql = String.raw`
  CREATE TABLE IF NOT EXISTS storyhold.world_analysis_stat_reviews (
    run_id uuid NOT NULL REFERENCES storyhold.world_analysis_runs(id) ON DELETE CASCADE,
    world_id uuid NOT NULL, edition_id uuid NOT NULL,
    step_key text NOT NULL CHECK (length(step_key) BETWEEN 1 AND 200),
    receipt_fingerprint text NOT NULL, snapshot_fingerprint text NOT NULL, snapshot jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (run_id, step_key)
  );
  CREATE OR REPLACE FUNCTION storyhold.reject_premium_stat_review_update()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RAISE EXCEPTION 'Premium stat verification receipts are immutable'; END;
  $$;
  DROP TRIGGER IF EXISTS premium_stat_review_immutable ON storyhold.world_analysis_stat_reviews;
  CREATE TRIGGER premium_stat_review_immutable BEFORE UPDATE ON storyhold.world_analysis_stat_reviews
    FOR EACH ROW EXECUTE FUNCTION storyhold.reject_premium_stat_review_update();
  CREATE TABLE IF NOT EXISTS storyhold.world_entity_stat_verifications (
    entity_id uuid NOT NULL REFERENCES storyhold.world_entities(id) ON DELETE CASCADE,
    dossier_id uuid REFERENCES storyhold.character_dossiers(id) ON DELETE CASCADE,
    run_id uuid NOT NULL, step_key text NOT NULL, proposal_id text NOT NULL,
    decision_id text NOT NULL, stat_name text NOT NULL, payload_fingerprint text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (run_id, step_key, proposal_id),
    FOREIGN KEY (run_id, step_key) REFERENCES storyhold.world_analysis_stat_reviews(run_id, step_key) ON DELETE CASCADE
  );
  DROP TRIGGER IF EXISTS premium_stat_link_immutable ON storyhold.world_entity_stat_verifications;
  CREATE TRIGGER premium_stat_link_immutable BEFORE UPDATE ON storyhold.world_entity_stat_verifications
    FOR EACH ROW EXECUTE FUNCTION storyhold.reject_premium_stat_review_update();
`;

export class PremiumStatJournalError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "PremiumStatJournalError"; }
}
function fail(code: string, message: string): never { throw new PremiumStatJournalError(code, message); }
function fullHash(value: unknown): string { return canonPayloadFingerprint(value as JsonObject); }
function validateScope(scope: PremiumStatScope): void {
  if (!scope || [scope.worldId, scope.editionId, scope.analysisRunId].some((value) => typeof value !== "string" || !UUID.test(value))) {
    fail("STAT_SCOPE_INVALID", "Stat verification requires an exact world, edition, and analysis run.");
  }
}
function stepKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("STAT_STEP_INVALID", "Stat verification requires a bounded nonblank step identifier.");
  }
}
function sameScope(left: PremiumStatScope, right: PremiumStatScope): boolean {
  return left.worldId === right.worldId && left.editionId === right.editionId && left.analysisRunId === right.analysisRunId;
}
function snapshot(value: PremiumStatReviewReceipt): PremiumStatReviewReceipt {
  try {
    assertPremiumStatReceipt(value);
    validateScope(value.request.scope);
    stepKey(value.request.stepKey);
    const before = fullHash(value);
    const copy = JSON.parse(JSON.stringify(value)) as PremiumStatReviewReceipt;
    assertPremiumStatReceipt(copy);
    if (fullHash(copy) !== before) throw new Error("Non-JSON receipt");
    return copy;
  } catch (error) {
    if (error instanceof PremiumStatJournalError) throw error;
    fail("STAT_RECEIPT_INVALID", "The stat review receipt failed validation.");
  }
}
async function assertRun(db: QueryDb, scope: PremiumStatScope, lock: boolean): Promise<void> {
  validateScope(scope);
  const run = await db.query(
    `SELECT id FROM storyhold.world_analysis_runs WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3
      AND analysis_kind = 'ai_enrichment'${lock ? " FOR UPDATE" : ""}`,
    [scope.analysisRunId, scope.worldId, scope.editionId],
  );
  if (run.rows.length !== 1) fail("STAT_SCOPE_MISMATCH", "The premium stat review does not match the analysis run scope.");
}
function checkedStored(row: StoredReview, scope: PremiumStatScope): PremiumStatReviewReceipt {
  try {
    const receipt = snapshot(row.snapshot);
    if (row.run_id !== scope.analysisRunId || row.world_id !== scope.worldId || row.edition_id !== scope.editionId
      || !sameScope(receipt.request.scope, scope) || row.step_key !== receipt.request.stepKey
      || row.receipt_fingerprint !== receipt.fingerprint || row.snapshot_fingerprint !== fullHash(receipt)) throw new Error("Scope or hash mismatch");
    return receipt;
  } catch { fail("STAT_JOURNAL_INTEGRITY", "The stored stat review failed its scope or integrity check."); }
}
export async function ensurePremiumStatJournal(db: Pick<PGlite, "exec">): Promise<void> { await db.exec(premiumStatJournalSchemaSql); }
/** Save inside the same caller-owned transaction as all generated dossier writes. */
export async function savePremiumStatReview(db: QueryDb, value: PremiumStatReviewReceipt): Promise<PremiumStatReviewReceipt> {
  const receipt = snapshot(value);
  const scope = receipt.request.scope;
  await assertRun(db, scope, true);
  await db.query(`INSERT INTO storyhold.world_analysis_stat_reviews
    (run_id, world_id, edition_id, step_key, receipt_fingerprint, snapshot_fingerprint, snapshot)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) ON CONFLICT (run_id, step_key) DO NOTHING`,
  [scope.analysisRunId, scope.worldId, scope.editionId, receipt.request.stepKey, receipt.fingerprint, fullHash(receipt), JSON.stringify(receipt)]);
  const stored = (await db.query<StoredReview>("SELECT * FROM storyhold.world_analysis_stat_reviews WHERE run_id = $1 AND step_key = $2", [scope.analysisRunId, receipt.request.stepKey])).rows[0];
  if (!stored) fail("STAT_JOURNAL_PERSISTENCE", "The stat review receipt was not durably stored.");
  const existing = checkedStored(stored, scope);
  if (fullHash(existing) !== fullHash(receipt)) fail("STAT_RECEIPT_MISMATCH", "A different immutable stat review already exists for this step.");
  return existing;
}
export async function readPremiumStatReviews(db: QueryDb, scope: PremiumStatScope): Promise<PremiumStatReviewReceipt[]> {
  await assertRun(db, scope, false);
  const rows = await db.query<StoredReview>("SELECT * FROM storyhold.world_analysis_stat_reviews WHERE run_id = $1 ORDER BY step_key", [scope.analysisRunId]);
  return rows.rows.map((row) => checkedStored(row, scope));
}
export function assertExpectedPremiumStatReviews(receipts: PremiumStatReviewReceipt[], params: { scope: PremiumStatScope; expectedStepKeys: string[] }): void {
  validateScope(params.scope);
  if (!Array.isArray(receipts) || !Array.isArray(params.expectedStepKeys)) fail("STAT_RECEIPTS_INCOMPLETE", "Stat review inventories must be explicit arrays.");
  const expected = new Set<string>();
  for (const key of params.expectedStepKeys) {
    stepKey(key);
    if (expected.has(key)) fail("STAT_RECEIPTS_INCOMPLETE", "Expected stat review steps must be unique.");
    expected.add(key);
  }
  if (receipts.length !== expected.size) fail("STAT_RECEIPTS_INCOMPLETE", "Every premium batch requires exactly one stat review receipt.");
  for (const value of receipts) {
    const receipt = snapshot(value);
    if (!sameScope(receipt.request.scope, params.scope)) fail("STAT_SCOPE_MISMATCH", "Stat receipt belongs to a different analysis scope.");
    if (!expected.delete(receipt.request.stepKey)) fail("STAT_RECEIPTS_INCOMPLETE", "Stat review inventory contains an extra or duplicate step.");
  }
}

type VerifiedStat = ReturnType<typeof statsFromPremiumReceipts>[number];
type PlannedStat = { value: VerifiedStat; receipt: PremiumStatReviewReceipt; entry: VerifiedPromotionEntry };
const label = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
const slotKey = (family: string, entity: string, stat: string) => JSON.stringify([family, label(entity), stat]);
function statValue(value: VerifiedStat): CharacterFinding["estimatedStats"]["strength"] {
  return { score: value.score, rationale: value.rationale, confidence: value.confidence, evidence: structuredClone(value.evidence) };
}

/** Conflicting verified estimates are retained in the immutable reviews, not
 * silently resolved by whichever model happened to report higher confidence.
 * Equal semantic payloads select one exact receipt, including its evidence;
 * we never manufacture a synthetic union with no matching verification. */
function selectedVerifiedStats(receipts: readonly PremiumStatReviewReceipt[]): Map<string, PlannedStat> {
  const slots = new Map<string, Array<PlannedStat & { semantic: string; order: string }>>();
  let scope: PremiumStatScope | undefined;
  const steps = new Set<string>();
  for (const supplied of receipts) {
    const receipt = snapshot(supplied);
    if (scope && !sameScope(scope, receipt.request.scope)) fail("STAT_SCOPE_MISMATCH", "Stat receipts belong to different analysis scopes.");
    scope = receipt.request.scope;
    if (steps.has(receipt.request.stepKey)) fail("STAT_RECEIPTS_INCOMPLETE", "Stat review inventory contains a duplicate step.");
    steps.add(receipt.request.stepKey);
    const entries = buildVerifiedPromotionPlan(receipt.packet, receipt.decisions, receipt.batch);
    for (const value of statsFromPremiumReceipts([receipt])) {
      const key = slotKey(value.family, value.entity, value.stat);
      const values = slots.get(key) ?? [];
      const payloadHash = fullHash({ family: value.family, entity: value.entity, stat: value.stat, score: value.score, rationale: value.rationale });
      const entry = entries.find((candidate) => candidate.payloadFingerprint === payloadHash);
      if (!entry) fail("STAT_RECEIPT_INVALID", "Verified stat projection has no matching promotion decision.");
      values.push({ value, receipt, entry, semantic: fullHash({ score: value.score, rationale: value.rationale }),
        order: `${receipt.fingerprint}:${fullHash(statValue(value))}` });
      slots.set(key, values);
    }
  }
  const selected = new Map<string, PlannedStat>();
  for (const [key, values] of slots) {
    if (new Set(values.map((value) => value.semantic)).size !== 1) continue;
    values.sort((left, right) => left.order.localeCompare(right.order));
    selected.set(key, values[0]!);
  }
  return selected;
}

/** Receipt-only projection for generated results, before local/owner baseline
 * preservation at the persistence boundary. This never creates entities or
 * interprets aliases, species inheritance, or form links as stat approval. */
export function applyPremiumVerifiedStats(findings: WorldFindings, receipts: readonly PremiumStatReviewReceipt[]): WorldFindings {
  const selected = selectedVerifiedStats(receipts);
  const output = structuredClone(findings);
  for (const family of PREMIUM_STAT_FAMILIES) {
    for (const entry of output[family]) {
      const approved = PREMIUM_STAT_NAMES.map((stat) => [stat, selected.get(slotKey(family, entry.name, stat))?.value] as const);
      if (family !== "characters" && entry.estimatedStats === undefined && approved.every(([, value]) => !value)) continue;
      entry.estimatedStats = premiumNeutralStats();
      for (const [stat, value] of approved) {
        if (value) entry.estimatedStats[stat] = statValue(value);
      }
    }
  }
  return output;
}

/** Check immediately before generated findings are persisted. Rejected,
 * uncertain, conflicting, inherited, or merge-modified estimates cannot cross
 * this boundary. Omitted verified findings do not manufacture entity cards. */
export function assertPremiumStatProjection(findings: WorldFindings, receipts: readonly PremiumStatReviewReceipt[]): void {
  const selected = selectedVerifiedStats(receipts);
  let candidates: ReturnType<typeof premiumStatCandidates>;
  try { candidates = premiumStatCandidates(findings); }
  catch { fail("STAT_PROJECTION_INVALID", "The generated stat projection contains malformed estimates."); }
  for (const value of candidates) {
    const approved = selected.get(slotKey(value.family, value.entity, value.stat))?.value;
    if (!approved || fullHash(statValue(approved)) !== fullHash({ score: value.score, rationale: value.rationale,
      confidence: value.confidence, evidence: value.evidence })) {
      fail("STAT_PROJECTION_MISMATCH", "A generated stat estimate differs from its exact verified receipt.");
    }
  }
}

const FAMILY_ENTITY_TYPES: Readonly<Record<string, string>> = {
  characters: "character", locations: "place", factions: "faction", institutions: "institution", governments: "government",
  powerStructures: "power_structure", creatures: "creature", species: "species", technologies: "technology", vehicles: "vehicle",
  devices: "device", weapons: "weapon", powers: "power", titles: "title", ambiguous: "ambiguous",
};

/** Category adjudication can move or merge named findings after the original
 * projection check. Rebuild estimates from receipts for the final entity type
 * and exact name, never carry estimates across that category boundary. */
export function premiumStatsForEntity(
  entityType: string,
  name: string,
  receipts: readonly PremiumStatReviewReceipt[],
): NamedFinding["estimatedStats"] | undefined {
  return preparePremiumEntityStatProjection(receipts)(entityType, name);
}

/** Validate and index once for a persistence batch, not once per dossier. Each
 * lookup returns a fresh block so later normalization cannot mutate the index. */
export function preparePremiumEntityStatProjection(
  receipts: readonly PremiumStatReviewReceipt[],
): (entityType: string, name: string) => NamedFinding["estimatedStats"] | undefined {
  const selected = selectedVerifiedStats(receipts);
  const familiesByType = new Map<string, string[]>();
  for (const [family, type] of Object.entries(FAMILY_ENTITY_TYPES)) {
    familiesByType.set(type, [...(familiesByType.get(type) ?? []), family]);
  }
  return (entityType, name) => {
    const families = familiesByType.get(entityType);
    if (families?.length !== 1) return undefined;
    const family = families[0]!;
    const approved = PREMIUM_STAT_NAMES.map((stat) => [stat, selected.get(slotKey(family, name, stat))?.value] as const);
    if (approved.every(([, value]) => !value)) return undefined;
    const stats = premiumNeutralStats();
    for (const [stat, value] of approved) {
      if (value) stats[stat] = statValue(value);
    }
    return stats;
  };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Records actual canonical IDs only after the caller has persisted generated
 * dossiers/entities in the same transaction. This cannot change any stat or
 * infer an identity from an alias, and never claims an owner-authored value. */
export async function linkPremiumStatReviewsToCanon(db: QueryDb, receipts: readonly PremiumStatReviewReceipt[]): Promise<number> {
  const planned = selectedVerifiedStats(receipts);
  for (const supplied of receipts) {
    const value = snapshot(supplied);
    await assertRun(db, value.request.scope, true);
    const row = (await db.query<StoredReview>("SELECT * FROM storyhold.world_analysis_stat_reviews WHERE run_id = $1 AND step_key = $2",
      [value.request.scope.analysisRunId, value.request.stepKey])).rows[0];
    if (!row || fullHash(checkedStored(row, value.request.scope)) !== fullHash(value)) {
      fail("STAT_RECEIPT_MISMATCH", "Canonical stat links require the exact durably saved stat receipt.");
    }
  }
  let linked = 0;
  for (const { value, receipt, entry } of planned.values()) {
    const type = FAMILY_ENTITY_TYPES[value.family];
    // World rules do not currently have standalone world_entities records.
    if (!type) continue;
    const scope = receipt.request.scope;
    const normalizedName = label(value.entity).toLocaleLowerCase();
    const rows = (await db.query<Record<string, unknown>>(`SELECT entity.id, entity.name, entity.normalized_name, entity.entity_type,
      entity.classification_source, entity.review_status, entity.pull_status, entity.scanner_present, entity.merged_into_entity_id,
      entity.estimated_stats, dossier.id AS dossier_id, dossier.world_id AS dossier_world_id,
      dossier.canon_edition_id AS dossier_edition_id, dossier.normalized_name AS dossier_normalized_name,
      dossier.user_edited_at, dossier.dossier_status, dossier.profile
      FROM storyhold.world_entities entity LEFT JOIN storyhold.character_dossiers dossier ON dossier.id = entity.dossier_id
      WHERE entity.world_id = $1 AND entity.canon_edition_id = $2 AND entity.normalized_name = $3
      FOR UPDATE OF entity`, [scope.worldId, scope.editionId, normalizedName])).rows;
    if (rows.length !== 1) continue;
    const row = rows[0]!;
    if (row.entity_type !== type || typeof row.name !== "string" || label(row.name) !== label(value.entity)
      || row.classification_source === "user" || row.review_status === "user_confirmed" || row.pull_status !== "active"
      || row.scanner_present !== true || row.merged_into_entity_id != null) continue;
    let actual: unknown;
    let dossierId: string | null = null;
    if (type === "character") {
      if (typeof row.dossier_id !== "string" || row.dossier_world_id !== scope.worldId || row.dossier_edition_id !== scope.editionId
        || row.dossier_normalized_name !== normalizedName || row.user_edited_at != null || row.dossier_status !== "active") continue;
      dossierId = row.dossier_id;
      // Lock and re-read the nullable joined row separately: an owner edit
      // committed while the entity lock was waiting must not gain an AI link.
      const dossier = (await db.query<Record<string, unknown>>(`SELECT world_id, canon_edition_id, normalized_name,
        user_edited_at, dossier_status, profile FROM storyhold.character_dossiers WHERE id = $1 FOR UPDATE`, [dossierId])).rows[0];
      if (!dossier || dossier.world_id !== scope.worldId || dossier.canon_edition_id !== scope.editionId
        || dossier.normalized_name !== normalizedName || dossier.user_edited_at != null || dossier.dossier_status !== "active") continue;
      actual = object(object(dossier.profile).estimatedStats)[value.stat];
    } else actual = object(row.estimated_stats)[value.stat];
    if (actual === undefined || fullHash(actual) !== fullHash(statValue(value))) continue;
    const values = [row.id, dossierId, scope.analysisRunId, receipt.request.stepKey, entry.proposal.id,
      entry.decision.id, value.stat, entry.payloadFingerprint];
    const saved = await db.query(`INSERT INTO storyhold.world_entity_stat_verifications
      (entity_id, dossier_id, run_id, step_key, proposal_id, decision_id, stat_name, payload_fingerprint)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (run_id, step_key, proposal_id) DO NOTHING RETURNING entity_id`, values);
    if (saved.rows.length) { linked += 1; continue; }
    const existing = (await db.query<Record<string, unknown>>(`SELECT entity_id, dossier_id, decision_id, stat_name, payload_fingerprint
      FROM storyhold.world_entity_stat_verifications WHERE run_id = $1 AND step_key = $2 AND proposal_id = $3`, values.slice(2, 5))).rows[0];
    if (!existing || existing.entity_id !== row.id || existing.dossier_id !== dossierId || existing.decision_id !== entry.decision.id
      || existing.stat_name !== value.stat || existing.payload_fingerprint !== entry.payloadFingerprint) {
      fail("STAT_LINK_MISMATCH", "An immutable stat verification link conflicts with its canonical target.");
    }
  }
  return linked;
}

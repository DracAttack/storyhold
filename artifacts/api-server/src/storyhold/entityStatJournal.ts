import type { PGlite } from "@electric-sql/pglite";
import { buildVerifiedPromotionPlan, canonPayloadFingerprint, type JsonObject } from "./analysisVerificationContracts";
import { assertEntityStatReviews } from "./entityStatVerification";
import { preparePremiumEntityStatProjection } from "./premiumStatJournal";
import { assertPremiumStatReceipt, statsFromPremiumReceipts, type PremiumStatReviewReceipt } from "./premiumStatVerification";
import type { EntityReviewInput } from "./entityReview";
import type { CharacterFinding } from "./worldAnalysis";

type QueryDb = Pick<PGlite, "query">;
export type EntityStatJournalScope = { worldId: string; editionId: string; entityId: string; reviewId: string };
type Stored = {
  world_id: string; edition_id: string; entity_id: string; review_id: string; step_key: string;
  input_snapshot: EntityReviewInput; input_fingerprint: string; snapshot: PremiumStatReviewReceipt;
  receipt_fingerprint: string; snapshot_fingerprint: string;
};
type Bundle = { input: EntityReviewInput; receipts: readonly PremiumStatReviewReceipt[] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ENTITY_STAT_FAMILIES: Readonly<Record<string, string>> = {
  character: "characters", creature: "creatures", species: "species", place: "locations", faction: "factions",
  institution: "institutions", government: "governments", power_structure: "powerStructures", technology: "technologies",
  vehicle: "vehicles", device: "devices", weapon: "weapons", power: "powers", title: "titles", ambiguous: "ambiguous",
};
const hash = (value: unknown) => canonPayloadFingerprint(value as JsonObject);
const label = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export class EntityStatJournalError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "EntityStatJournalError"; }
}
function fail(code: string, message: string): never { throw new EntityStatJournalError(code, message); }
function validScope(value: EntityStatJournalScope): void {
  if (!value || [value.worldId, value.editionId, value.entityId, value.reviewId].some((id) => typeof id !== "string" || !UUID.test(id))) {
    fail("ENTITY_STAT_SCOPE_INVALID", "Dossier stat receipts require exact world, edition, entity, and review identifiers.");
  }
}
function scopeOf(input: EntityReviewInput): EntityStatJournalScope {
  const value = { worldId: input.premiumStatScope?.worldId!, editionId: input.premiumStatScope?.editionId!,
    entityId: input.entity.id, reviewId: input.premiumStatScope?.analysisRunId! };
  validScope(value);
  return value;
}
function checkedBundle(params: Bundle): { input: EntityReviewInput; receipts: PremiumStatReviewReceipt[]; scope: EntityStatJournalScope } {
  try {
    const input = JSON.parse(JSON.stringify(params.input)) as EntityReviewInput;
    const receipts = JSON.parse(JSON.stringify(params.receipts)) as PremiumStatReviewReceipt[];
    const scope = scopeOf(input);
    assertEntityStatReviews(input, receipts);
    return { input, receipts, scope };
  } catch (error) {
    if (error instanceof EntityStatJournalError) throw error;
    fail("ENTITY_STAT_RECEIPT_INVALID", "Dossier stat receipts do not match the exact review input and target.");
  }
}

export const entityStatJournalSchemaSql = String.raw`
  CREATE TABLE IF NOT EXISTS storyhold.entity_review_stat_reviews (
    world_id uuid NOT NULL, edition_id uuid NOT NULL,
    entity_id uuid NOT NULL REFERENCES storyhold.world_entities(id) ON DELETE CASCADE,
    review_id uuid NOT NULL, step_key text NOT NULL,
    input_snapshot jsonb NOT NULL, input_fingerprint text NOT NULL,
    snapshot jsonb NOT NULL, snapshot_fingerprint text NOT NULL, receipt_fingerprint text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (world_id, edition_id, entity_id, review_id, step_key)
  );
  CREATE OR REPLACE FUNCTION storyhold.reject_entity_stat_review_update()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RAISE EXCEPTION 'Dossier stat receipts and application links are immutable'; END;
  $$;
  DROP TRIGGER IF EXISTS entity_stat_review_immutable ON storyhold.entity_review_stat_reviews;
  CREATE TRIGGER entity_stat_review_immutable BEFORE UPDATE ON storyhold.entity_review_stat_reviews
    FOR EACH ROW EXECUTE FUNCTION storyhold.reject_entity_stat_review_update();
  CREATE TABLE IF NOT EXISTS storyhold.entity_review_stat_verifications (
    world_id uuid NOT NULL, edition_id uuid NOT NULL,
    entity_id uuid NOT NULL REFERENCES storyhold.world_entities(id) ON DELETE CASCADE,
    review_id uuid NOT NULL, step_key text NOT NULL, proposal_id text NOT NULL,
    dossier_id uuid REFERENCES storyhold.character_dossiers(id) ON DELETE CASCADE,
    decision_id text NOT NULL, stat_name text NOT NULL, payload_fingerprint text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (world_id, edition_id, entity_id, review_id, step_key, proposal_id),
    FOREIGN KEY (world_id, edition_id, entity_id, review_id, step_key)
      REFERENCES storyhold.entity_review_stat_reviews(world_id, edition_id, entity_id, review_id, step_key) ON DELETE CASCADE
  );
  DROP TRIGGER IF EXISTS entity_stat_link_immutable ON storyhold.entity_review_stat_verifications;
  CREATE TRIGGER entity_stat_link_immutable BEFORE UPDATE ON storyhold.entity_review_stat_verifications
    FOR EACH ROW EXECUTE FUNCTION storyhold.reject_entity_stat_review_update();
`;
export async function ensureEntityStatJournal(db: Pick<PGlite, "exec">): Promise<void> { await db.exec(entityStatJournalSchemaSql); }

async function target(db: QueryDb, input: EntityReviewInput): Promise<Record<string, unknown>> {
  const scope = scopeOf(input);
  const rows = (await db.query<Record<string, unknown>>(`SELECT * FROM storyhold.world_entities
    WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3 FOR UPDATE`, [scope.entityId, scope.worldId, scope.editionId])).rows;
  const row = rows[0];
  if (rows.length !== 1 || !row || typeof row.name !== "string" || label(row.name) !== label(input.entity.name)
    || row.entity_type !== input.entity.entityType || row.pull_status !== "active" || row.merged_into_entity_id != null) {
    fail("ENTITY_STAT_TARGET_CHANGED", "The dossier stat review target changed or is no longer active.");
  }
  return row;
}

export async function readEntityStatReviews(db: QueryDb, scope: EntityStatJournalScope): Promise<PremiumStatReviewReceipt[]> {
  validScope(scope);
  const rows = (await db.query<Stored>(`SELECT * FROM storyhold.entity_review_stat_reviews
    WHERE world_id = $1 AND edition_id = $2 AND entity_id = $3 AND review_id = $4 ORDER BY step_key`,
  [scope.worldId, scope.editionId, scope.entityId, scope.reviewId])).rows;
  if (!rows.length) return [];
  try {
    const input = rows[0]!.input_snapshot;
    const inputHash = hash(input);
    for (const row of rows) {
      const fromInput = scopeOf(row.input_snapshot);
      if (hash(fromInput) !== hash(scope) || row.world_id !== scope.worldId || row.edition_id !== scope.editionId
        || row.entity_id !== scope.entityId || row.review_id !== scope.reviewId || hash(row.input_snapshot) !== inputHash
        || row.input_fingerprint !== inputHash || row.snapshot_fingerprint !== hash(row.snapshot)
        || row.receipt_fingerprint !== row.snapshot.fingerprint || row.step_key !== row.snapshot.request.stepKey) throw new Error("Scope or fingerprint mismatch");
    }
    return checkedBundle({ input, receipts: rows.map((row) => row.snapshot) }).receipts;
  } catch { fail("ENTITY_STAT_JOURNAL_INTEGRITY", "Stored dossier stat receipts failed their scope, inventory, or integrity check."); }
}

/** Called inside the transaction that persists the manually requested review.
 * Review UUIDs are not intake-run IDs and never create synthetic intake runs. */
export async function saveEntityStatReviews(db: QueryDb, params: Bundle): Promise<void> {
  const { input, receipts, scope } = checkedBundle(params);
  await target(db, input);
  for (const receipt of receipts) {
    await db.query(`INSERT INTO storyhold.entity_review_stat_reviews
      (world_id, edition_id, entity_id, review_id, step_key, input_snapshot, input_fingerprint, snapshot, snapshot_fingerprint, receipt_fingerprint)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, $10)
      ON CONFLICT (world_id, edition_id, entity_id, review_id, step_key) DO NOTHING`,
    [scope.worldId, scope.editionId, scope.entityId, scope.reviewId, receipt.request.stepKey, JSON.stringify(input), hash(input), JSON.stringify(receipt), hash(receipt), receipt.fingerprint]);
  }
  const stored = await readEntityStatReviews(db, scope);
  const ordered = (values: readonly PremiumStatReviewReceipt[]) => [...values].sort((a, b) => a.request.stepKey.localeCompare(b.request.stepKey));
  if (hash(ordered(stored)) !== hash(ordered(receipts))) fail("ENTITY_STAT_RECEIPT_MISMATCH", "Different immutable dossier stat receipts already exist for this review.");
  const rows = (await db.query<{ input_fingerprint: string }>(`SELECT input_fingerprint FROM storyhold.entity_review_stat_reviews
    WHERE world_id = $1 AND edition_id = $2 AND entity_id = $3 AND review_id = $4`, [scope.worldId, scope.editionId, scope.entityId, scope.reviewId])).rows;
  if (rows.some((row) => row.input_fingerprint !== hash(input))) fail("ENTITY_STAT_INPUT_MISMATCH", "The immutable dossier review input cannot be replaced.");
}

export async function linkEntityStatReviewsToCanon(db: QueryDb, params: Bundle): Promise<number> {
  const { input, receipts, scope } = checkedBundle(params);
  const stored = await readEntityStatReviews(db, scope);
  const expected = new Map(receipts.map((receipt) => [receipt.request.stepKey, hash(receipt)]));
  if (stored.length !== expected.size || stored.some((receipt) => expected.get(receipt.request.stepKey) !== hash(receipt))) {
    fail("ENTITY_STAT_RECEIPT_MISMATCH", "Canonical dossier stat links require the exact durably saved receipts.");
  }
  const row = await target(db, input);
  if (row.classification_source === "user" || row.review_status === "user_confirmed" || row.scanner_present !== true) return 0;
  let actualStats = object(row.estimated_stats);
  let dossierId: string | null = null;
  if (input.entity.entityType === "character") {
    if (typeof row.dossier_id !== "string") return 0;
    const dossier = (await db.query<Record<string, unknown>>(`SELECT * FROM storyhold.character_dossiers WHERE id = $1 FOR UPDATE`, [row.dossier_id])).rows[0];
    if (!dossier || dossier.world_id !== scope.worldId || dossier.canon_edition_id !== scope.editionId || dossier.user_edited_at != null
      || dossier.dossier_status !== "active" || dossier.normalized_name !== label(input.entity.name).toLocaleLowerCase()) return 0;
    dossierId = row.dossier_id;
    actualStats = object(object(dossier.profile).estimatedStats);
  }
  const approved = preparePremiumEntityStatProjection(receipts)(input.entity.entityType, input.entity.name);
  if (!approved) return 0;
  let linked = 0;
  for (const receipt of receipts) {
    const materialized = statsFromPremiumReceipts([receipt]);
    for (const entry of buildVerifiedPromotionPlan(receipt.packet, receipt.decisions, receipt.batch)) {
      const value = materialized.find((candidate) => hash({ family: candidate.family, entity: candidate.entity,
        stat: candidate.stat, score: candidate.score, rationale: candidate.rationale }) === entry.payloadFingerprint);
      if (!value) continue;
      const stat = value.stat as keyof CharacterFinding["estimatedStats"];
      const exact = { score: value.score, rationale: value.rationale, confidence: value.confidence, evidence: value.evidence };
      if (hash(approved[stat]) !== hash(exact) || actualStats[stat] === undefined || hash(actualStats[stat]) !== hash(exact)) continue;
      const values = [scope.worldId, scope.editionId, scope.entityId, scope.reviewId, receipt.request.stepKey, entry.proposal.id,
        dossierId, entry.decision.id, stat, entry.payloadFingerprint];
      const result = await db.query(`INSERT INTO storyhold.entity_review_stat_verifications
        (world_id, edition_id, entity_id, review_id, step_key, proposal_id, dossier_id, decision_id, stat_name, payload_fingerprint)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (world_id, edition_id, entity_id, review_id, step_key, proposal_id) DO NOTHING RETURNING entity_id`, values);
      if (result.rows.length) { linked += 1; continue; }
      const existing = (await db.query<Record<string, unknown>>(`SELECT dossier_id, decision_id, stat_name, payload_fingerprint
        FROM storyhold.entity_review_stat_verifications WHERE world_id = $1 AND edition_id = $2 AND entity_id = $3
        AND review_id = $4 AND step_key = $5 AND proposal_id = $6`, values.slice(0, 6))).rows[0];
      if (!existing || existing.dossier_id !== dossierId || existing.decision_id !== entry.decision.id
        || existing.stat_name !== stat || existing.payload_fingerprint !== entry.payloadFingerprint) {
        fail("ENTITY_STAT_LINK_MISMATCH", "An immutable dossier stat link conflicts with the saved canonical target.");
      }
    }
  }
  return linked;
}

/** Identify only estimates whose current exact values still have immutable
 * premium application proofs. Historical links and an AI-labelled dossier do
 * not, by themselves, protect later local changes as premium-reviewed stats. */
export async function currentEntityPremiumStatNames(db: QueryDb, params: {
  worldId: string; editionId: string; entityId: string; entityType: string; name: string; stats: unknown;
}): Promise<string[]> {
  if ([params.worldId, params.editionId, params.entityId].some((id) => typeof id !== "string" || !UUID.test(id))) {
    fail("ENTITY_STAT_SCOPE_INVALID", "Current stat provenance requires an exact canonical entity scope.");
  }
  type Linked = { proposal_id: string; decision_id: string; stat_name: string; payload_fingerprint: string;
    snapshot: PremiumStatReviewReceipt; snapshot_fingerprint: string; receipt_fingerprint: string;
    step_key: string; run_id?: string; review_id?: string };
  const intake = (await db.query<Linked>(`SELECT link.proposal_id, link.decision_id, link.stat_name, link.payload_fingerprint,
    review.snapshot, review.snapshot_fingerprint, review.receipt_fingerprint, review.run_id, review.step_key
    FROM storyhold.world_entity_stat_verifications link JOIN storyhold.world_analysis_stat_reviews review
      ON review.run_id = link.run_id AND review.step_key = link.step_key
    WHERE link.entity_id = $1 AND review.world_id = $2 AND review.edition_id = $3`,
  [params.entityId, params.worldId, params.editionId])).rows;
  const dossier = (await db.query<Linked>(`SELECT link.proposal_id, link.decision_id, link.stat_name, link.payload_fingerprint,
    review.snapshot, review.snapshot_fingerprint, review.receipt_fingerprint, review.review_id, review.step_key
    FROM storyhold.entity_review_stat_verifications link JOIN storyhold.entity_review_stat_reviews review
      ON review.world_id = link.world_id AND review.edition_id = link.edition_id AND review.entity_id = link.entity_id
      AND review.review_id = link.review_id AND review.step_key = link.step_key
    WHERE link.entity_id = $1 AND review.world_id = $2 AND review.edition_id = $3`,
  [params.entityId, params.worldId, params.editionId])).rows;
  const checkedDossierReviews = new Set<string>();
  const current = object(params.stats);
  const protectedNames = new Set<string>();
  for (const link of [...intake, ...dossier]) {
    try {
      const receipt = link.snapshot;
      assertPremiumStatReceipt(receipt);
      if (hash(receipt) !== link.snapshot_fingerprint || receipt.fingerprint !== link.receipt_fingerprint
        || receipt.request.scope.worldId !== params.worldId || receipt.request.scope.editionId !== params.editionId
        || receipt.request.scope.analysisRunId !== (link.run_id ?? link.review_id) || receipt.request.stepKey !== link.step_key) throw new Error("Invalid linked receipt");
      if (link.review_id && !checkedDossierReviews.has(link.review_id)) {
        await readEntityStatReviews(db, { worldId: params.worldId, editionId: params.editionId, entityId: params.entityId, reviewId: link.review_id });
        checkedDossierReviews.add(link.review_id);
      }
      const entry = buildVerifiedPromotionPlan(receipt.packet, receipt.decisions, receipt.batch).find((candidate) =>
        candidate.proposal.id === link.proposal_id && candidate.decision.id === link.decision_id && candidate.payloadFingerprint === link.payload_fingerprint);
      if (!entry || entry.payload.stat !== link.stat_name) throw new Error("Invalid stat application link");
      if (entry.payload.entity !== label(params.name) || entry.payload.family !== ENTITY_STAT_FAMILIES[params.entityType]) continue;
      const projected = preparePremiumEntityStatProjection([receipt])(params.entityType, params.name);
      const exact = projected?.[link.stat_name as keyof CharacterFinding["estimatedStats"]];
      if (exact && exact.score === entry.payload.score && exact.rationale === entry.payload.rationale
        && current[link.stat_name] !== undefined && hash(exact) === hash(current[link.stat_name])) protectedNames.add(link.stat_name);
    } catch (error) {
      if (error instanceof EntityStatJournalError) throw error;
      fail("ENTITY_STAT_JOURNAL_INTEGRITY", "The current stat's premium application proof failed validation.");
    }
  }
  return [...protectedNames].sort();
}

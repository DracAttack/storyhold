import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { buildEntityStatRequests, validateEntityStatReviews } from "./entityStatVerification";
import { currentEntityPremiumStatNames, ensureEntityStatJournal, EntityStatJournalError, linkEntityStatReviewsToCanon,
  readEntityStatReviews, saveEntityStatReviews } from "./entityStatJournal";
import { ensurePremiumStatJournal, linkPremiumStatReviewsToCanon, savePremiumStatReview } from "./premiumStatJournal";
import { buildPremiumStatRequest, validatePremiumStatResponse } from "./premiumStatVerification";
import { premiumNeutralStats } from "./premiumStatCandidates";
import type { EntityReviewInput } from "./entityReview";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { worldId: uuid(1), editionId: uuid(2), entityId: uuid(3), reviewId: uuid(4) };
const quote = "Mira held the heavy beam above her companions until they escaped.";
const evidence = [{ chunkId: uuid(20), sourceId: uuid(21), quote }];
function input(): EntityReviewInput {
  const stats = premiumNeutralStats();
  stats.strength = { score: 16, confidence: 0.9, rationale: "Held a heavy beam while her companions escaped.", evidence };
  return { worldName: "Fixture", worldPremise: "", worldGenre: "", depth: "full", knownEntities: [],
    premiumStatScope: { worldId: scope.worldId, editionId: scope.editionId, analysisRunId: scope.reviewId },
    entity: { id: scope.entityId, name: "Mira", entityType: "character", summary: "", aliases: [], details: [], relationships: [], estimatedStats: stats },
    chunks: [{ id: uuid(20), sourceId: uuid(21), sourceTitle: "Fixture", index: 0, content: quote }],
  };
}
function reviews(value = input(), completedAt = "2026-09-03T12:00:00.000Z") {
  return validateEntityStatReviews(value, { statVerifications: buildEntityStatRequests(value).map((request) => ({
    requestFingerprint: request.fingerprint, newStats: [], decisions: request.proposals.map((proposal) => ({
      proposalId: proposal.id, verdict: "verified", explanation: "The passage demonstrates sustained lifting strength.", confidence: 0.9,
      supportingEvidence: [{ chunkId: uuid(20), quote }], contradictingEvidence: [], retrievalRequests: [],
    })),
  })) }, { provider: "test", model: "fixture", completedAt });
}
const code = (name: string) => (error: unknown) => error instanceof EntityStatJournalError && error.code === name;
async function database(value = input()) {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.world_analysis_runs (id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL, analysis_kind text NOT NULL DEFAULT 'ai_enrichment');
    CREATE TABLE storyhold.character_dossiers (id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
      normalized_name text NOT NULL, user_edited_at timestamptz, dossier_status text DEFAULT 'active', profile jsonb DEFAULT '{}');
    CREATE TABLE storyhold.world_entities (id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
      dossier_id uuid REFERENCES storyhold.character_dossiers(id), name text NOT NULL, normalized_name text NOT NULL,
      entity_type text NOT NULL, classification_source text DEFAULT 'ai', review_status text DEFAULT 'verified',
      pull_status text DEFAULT 'active', scanner_present boolean DEFAULT true, merged_into_entity_id uuid, estimated_stats jsonb DEFAULT '{}');`);
  await ensurePremiumStatJournal(db); await ensureEntityStatJournal(db);
  await db.query("INSERT INTO storyhold.character_dossiers (id, world_id, canon_edition_id, normalized_name, profile) VALUES ($1, $2, $3, 'mira', $4::jsonb)",
    [uuid(30), scope.worldId, scope.editionId, JSON.stringify({ estimatedStats: value.entity.estimatedStats })]);
  await db.query(`INSERT INTO storyhold.world_entities (id, world_id, canon_edition_id, dossier_id, name, normalized_name, entity_type, estimated_stats)
    VALUES ($1, $2, $3, $4, 'Mira', 'mira', $5, $6::jsonb)`,
    [scope.entityId, scope.worldId, scope.editionId, uuid(30), value.entity.entityType, JSON.stringify(value.entity.estimatedStats)]);
  return db;
}

test("dossier stat reviews save exact immutable two-group bundles without creating intake runs", async () => {
  const value = input(); const receipts = reviews(value); const db = await database(value);
  try {
    await db.transaction((tx) => saveEntityStatReviews(tx, { input: value, receipts }));
    await db.transaction((tx) => saveEntityStatReviews(tx, { input: value, receipts }));
    assert.deepEqual(await readEntityStatReviews(db, { reviewId: scope.reviewId, entityId: scope.entityId, editionId: scope.editionId, worldId: scope.worldId }), receipts);
    assert.equal((await db.query("SELECT count(*) AS count FROM storyhold.entity_review_stat_reviews")).rows[0]?.count, 2);
    assert.equal((await db.query("SELECT count(*) AS count FROM storyhold.world_analysis_runs")).rows[0]?.count, 0);
    await assert.rejects(db.query("UPDATE storyhold.entity_review_stat_reviews SET step_key = 'changed'"), /immutable/);
    await assert.rejects(db.transaction((tx) => saveEntityStatReviews(tx, { input: value, receipts: reviews(value, "2026-09-03T12:00:01.000Z") })), code("ENTITY_STAT_RECEIPT_MISMATCH"));
  } finally { await db.close(); }
});

test("dossier stat journal rejects changed inputs, missing groups and changed canonical targets", async () => {
  const value = input(); const receipts = reviews(value); const db = await database(value);
  try {
    await assert.rejects(saveEntityStatReviews(db, { input: { ...value, userGuidance: "Different instructions" }, receipts }), code("ENTITY_STAT_RECEIPT_INVALID"));
    await assert.rejects(saveEntityStatReviews(db, { input: value, receipts: receipts.slice(0, 1) }), code("ENTITY_STAT_RECEIPT_INVALID"));
    await db.query("UPDATE storyhold.world_entities SET entity_type = 'creature'");
    await assert.rejects(saveEntityStatReviews(db, { input: value, receipts }), code("ENTITY_STAT_TARGET_CHANGED"));
    assert.deepEqual(await readEntityStatReviews(db, scope), []);
  } finally { await db.close(); }
});

test("dossier receipt and application writes are atomic and tamper checked", async () => {
  const value = input(); const receipts = reviews(value); const db = await database(value);
  try {
    await assert.rejects(db.transaction(async (tx) => { await saveEntityStatReviews(tx, { input: value, receipts }); throw new Error("write failed"); }), /write failed/);
    assert.deepEqual(await readEntityStatReviews(db, scope), []);
    await db.transaction((tx) => saveEntityStatReviews(tx, { input: value, receipts }));
    await db.exec("ALTER TABLE storyhold.entity_review_stat_reviews DISABLE TRIGGER entity_stat_review_immutable");
    await db.query("UPDATE storyhold.entity_review_stat_reviews SET input_fingerprint = 'tampered'");
    await assert.rejects(readEntityStatReviews(db, scope), code("ENTITY_STAT_JOURNAL_INTEGRITY"));
  } finally { await db.close(); }
});

test("dossier stat links record exact canonical IDs once and never claim altered values", async () => {
  const value = input(); const receipts = reviews(value); const db = await database(value);
  try {
    await assert.rejects(linkEntityStatReviewsToCanon(db, { input: value, receipts }), code("ENTITY_STAT_RECEIPT_MISMATCH"));
    await db.transaction((tx) => saveEntityStatReviews(tx, { input: value, receipts }));
    assert.equal(await db.transaction((tx) => linkEntityStatReviewsToCanon(tx, { input: value, receipts })), 1);
    assert.equal(await db.transaction((tx) => linkEntityStatReviewsToCanon(tx, { input: value, receipts })), 0);
    const row = (await db.query("SELECT * FROM storyhold.entity_review_stat_verifications")).rows[0]!;
    assert.equal(row.entity_id, scope.entityId); assert.equal(row.dossier_id, uuid(30)); assert.equal(row.review_id, scope.reviewId);
    await assert.rejects(db.query("UPDATE storyhold.entity_review_stat_verifications SET decision_id = 'changed'"), /immutable/);
    await db.query("UPDATE storyhold.character_dossiers SET profile = jsonb_set(profile, '{estimatedStats,strength,score}', '19')");
    assert.equal(await linkEntityStatReviewsToCanon(db, { input: value, receipts }), 0);
  } finally { await db.close(); }
});

test("manual review can retain owner-target receipts without claiming owner-authored stat values", async () => {
  const value = input(); const receipts = reviews(value); const db = await database(value);
  try {
    await db.query("UPDATE storyhold.world_entities SET classification_source = 'user'");
    await db.transaction((tx) => saveEntityStatReviews(tx, { input: value, receipts }));
    assert.equal(await linkEntityStatReviewsToCanon(db, { input: value, receipts }), 0);
    await db.query("UPDATE storyhold.world_entities SET classification_source = 'ai'");
    await db.query("UPDATE storyhold.character_dossiers SET user_edited_at = now()");
    assert.equal(await linkEntityStatReviewsToCanon(db, { input: value, receipts }), 0);
  } finally { await db.close(); }
});

test("only current exact dossier receipt-backed stats are protected against local fallback", async () => {
  const value = input(); const receipts = reviews(value); const db = await database(value);
  const params = { worldId: scope.worldId, editionId: scope.editionId, entityId: scope.entityId, entityType: "character", name: "Mira", stats: value.entity.estimatedStats };
  try {
    assert.deepEqual(await currentEntityPremiumStatNames(db, params), []);
    await db.transaction(async (tx) => { await saveEntityStatReviews(tx, { input: value, receipts }); await linkEntityStatReviewsToCanon(tx, { input: value, receipts }); });
    assert.deepEqual(await currentEntityPremiumStatNames(db, params), ["strength"]);
    const changed = structuredClone(value.entity.estimatedStats!); changed.strength!.score = 19;
    assert.deepEqual(await currentEntityPremiumStatNames(db, { ...params, stats: changed }), []);
    assert.deepEqual(await currentEntityPremiumStatNames(db, { ...params, entityType: "creature" }), []);
    assert.deepEqual(await currentEntityPremiumStatNames(db, { ...params, name: "The Singer" }), []);
  } finally { await db.close(); }
});

test("current premium stat protection also recognizes intake verification links without blanket AI status", async () => {
  const value = input(); const db = await database(value);
  try {
    const intakeScope = { worldId: scope.worldId, editionId: scope.editionId, analysisRunId: uuid(90) };
    await db.query("INSERT INTO storyhold.world_analysis_runs (id, world_id, canon_edition_id) VALUES ($1, $2, $3)", [intakeScope.analysisRunId, scope.worldId, scope.editionId]);
    const request = buildPremiumStatRequest({ scope: intakeScope, stepKey: "verification:0", chunks: [{ id: uuid(20), sourceId: uuid(21), text: quote }],
      findings: { characters: [{ name: "Mira", estimatedStats: value.entity.estimatedStats }] } as never, context: {} });
    const receipt = validatePremiumStatResponse(request, { statVerification: { requestFingerprint: request.fingerprint, newStats: [],
      decisions: request.proposals.map((proposal) => ({ proposalId: proposal.id, verdict: "verified", confidence: 0.9, explanation: "The passage demonstrates lifting strength.",
        supportingEvidence: [{ chunkId: uuid(20), quote }], contradictingEvidence: [], retrievalRequests: [] })) } },
    { provider: "test", model: "fixture", completedAt: "2026-09-03T12:00:00.000Z" });
    await db.transaction(async (tx) => { await savePremiumStatReview(tx, receipt); await linkPremiumStatReviewsToCanon(tx, [receipt]); });
    const params = { worldId: scope.worldId, editionId: scope.editionId, entityId: scope.entityId, entityType: "character", name: "Mira", stats: value.entity.estimatedStats };
    assert.deepEqual(await currentEntityPremiumStatNames(db, params), ["strength"]);
    await db.exec("ALTER TABLE storyhold.world_analysis_stat_reviews DISABLE TRIGGER premium_stat_review_immutable");
    await db.query("UPDATE storyhold.world_analysis_stat_reviews SET snapshot_fingerprint = 'tampered'");
    await assert.rejects(currentEntityPremiumStatNames(db, params), code("ENTITY_STAT_JOURNAL_INTEGRITY"));
  } finally { await db.close(); }
});

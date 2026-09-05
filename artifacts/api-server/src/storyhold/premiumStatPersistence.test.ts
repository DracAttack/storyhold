import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { buildPremiumGraphRequest, validatePremiumGraphResponse } from "./premiumGraphVerification";
import { ensurePremiumGraphJournal, savePremiumGraphReview } from "./premiumGraphJournal";
import { buildPremiumStatRequest, validatePremiumStatResponse } from "./premiumStatVerification";
import {
  applyPremiumVerifiedStats, ensurePremiumStatJournal, linkPremiumStatReviewsToCanon, savePremiumStatReview,
} from "./premiumStatJournal";
import { isNeutralPremiumStatEstimate, premiumNeutralStats } from "./premiumStatCandidates";
import { localEntityCategoryFromEvidence, parseWorldFindingsFromModel, type WorldFindings } from "./worldAnalysis";
import { syncWorldEntities } from "./worldStudio";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { worldId: uuid(801), editionId: uuid(802), analysisRunId: uuid(803) };
const chunkId = uuid(804), sourceId = uuid(805);
const verifier = { provider: "offline-provider", model: "offline-fixture", completedAt: "2026-09-03T12:00:00.000Z" };

function fixture(name: string, quote: string) {
  const chunks = [{ id: chunkId, sourceId, text: quote }];
  const finding = { name, summary: `${name} can hold a heavy fallen beam.`,
    evidence: [{ chunkId, sourceId, quote }], confidence: 0.9, reviewStatus: "candidate" as const,
    estimatedStats: premiumNeutralStats() };
  finding.estimatedStats.strength = { score: 16, confidence: 0.8,
    rationale: "Held a heavy fallen beam while others escaped.", evidence: finding.evidence };
  const findings: WorldFindings = { ...parseWorldFindingsFromModel({}, []), creatures: [finding] };
  const statRequest = buildPremiumStatRequest({ scope, stepKey: "verification:0", chunks, findings, context: {} });
  const statReceipt = validatePremiumStatResponse(statRequest, { statVerification: {
    requestFingerprint: statRequest.fingerprint, newStats: [], decisions: statRequest.proposals.map((proposal) => ({
      proposalId: proposal.id, verdict: "verified", explanation: "The quoted action demonstrates lifting strength.", confidence: 0.85,
      supportingEvidence: [{ chunkId, quote }], contradictingEvidence: [], retrievalRequests: [],
    })),
  } }, verifier);
  const graphRequest = buildPremiumGraphRequest({ scope, stepKey: "verification:0", chunks, relations: [], rules: [], context: {} });
  const graphReceipt = validatePremiumGraphResponse(graphRequest, { entityRelations: [], entityRules: [], graphVerification: {
    requestFingerprint: graphRequest.fingerprint, decisions: [], newFindings: [],
  } }, verifier);
  return { findings: applyPremiumVerifiedStats(findings, [statReceipt]), statReceipt, graphReceipt };
}

async function database() {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.world_analysis_runs (id uuid PRIMARY KEY, world_id uuid NOT NULL,
      canon_edition_id uuid NOT NULL, analysis_kind text DEFAULT 'ai_enrichment');
    CREATE TABLE storyhold.character_dossiers (id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
      source_analysis_run_id uuid, normalized_name text, name text, profile jsonb DEFAULT '{}',
      user_edited_at timestamptz, dossier_status text DEFAULT 'active', updated_at timestamptz DEFAULT now());
    CREATE TABLE storyhold.world_entities (id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
      dossier_id uuid REFERENCES storyhold.character_dossiers(id), source_analysis_run_id uuid,
      canonical_key text, normalized_name text NOT NULL, name text NOT NULL, entity_type text NOT NULL,
      aliases jsonb DEFAULT '[]', summary text DEFAULT '', details jsonb DEFAULT '[]', relationships jsonb DEFAULT '[]',
      evidence jsonb DEFAULT '[]', mention_count integer DEFAULT 0, mention_source_count integer DEFAULT 0,
      confidence real DEFAULT 0.5, classification_source text DEFAULT 'local', review_status text DEFAULT 'candidate',
      estimated_stats jsonb DEFAULT '{}', pull_status text DEFAULT 'active', scanner_present boolean DEFAULT true,
      merged_into_entity_id uuid, updated_at timestamptz DEFAULT now());
    CREATE TABLE storyhold.world_entity_relations (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.world_entity_rules (id uuid PRIMARY KEY);`);
  await ensurePremiumGraphJournal(db);
  await ensurePremiumStatJournal(db);
  await db.query("INSERT INTO storyhold.world_analysis_runs (id, world_id, canon_edition_id) VALUES ($1, $2, $3)",
    [scope.analysisRunId, scope.worldId, scope.editionId]);
  return db;
}

async function persist(db: PGlite, input: ReturnType<typeof fixture>) {
  return db.transaction(async (tx) => {
    await savePremiumStatReview(tx, input.statReceipt);
    await savePremiumGraphReview(tx, input.graphReceipt);
    await syncWorldEntities({
      db: tx as unknown as Parameters<typeof syncWorldEntities>[0]["db"], worldId: scope.worldId,
      editionId: scope.editionId, runId: scope.analysisRunId, analysisKind: "ai_enrichment",
      findings: input.findings, premiumGraphReviews: [input.graphReceipt], premiumStatReviews: [input.statReceipt],
    });
    return linkPremiumStatReviewsToCanon(tx, [input.statReceipt]);
  });
}

test("premium creature estimates cannot follow a local reclassification into a species", async () => {
  const input = fixture("Humans", "Humans are one species among many. Humans held the fallen beam until the others escaped.");
  assert.equal(localEntityCategoryFromEvidence("Humans", input.findings.creatures[0]!.evidence, "creature"), "species");
  const db = await database();
  try {
    assert.equal(await persist(db, input), 0);
    const rows = (await db.query<{ entity_type: string; estimated_stats: Record<string, unknown>; classification_source: string }>(
      "SELECT entity_type, estimated_stats, classification_source FROM storyhold.world_entities")).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.entity_type, "species");
    assert.equal(rows[0]!.classification_source, "ai");
    assert.ok(isNeutralPremiumStatEstimate(rows[0]!.estimated_stats.strength));
    assert.equal((await db.query("SELECT count(*) AS count FROM storyhold.world_entity_stat_verifications")).rows[0]!.count, 0);
    assert.equal((await db.query("SELECT count(*) AS count FROM storyhold.world_analysis_stat_reviews")).rows[0]!.count, 1);
  } finally { await db.close(); }
});

test("a matching creature estimate survives actual SQL persistence and links the exact canonical entity", async () => {
  const input = fixture("Thrall", "The Thrall roared as the beast raised its claws. The Thrall held the fallen beam until the others escaped.");
  assert.equal(localEntityCategoryFromEvidence("Thrall", input.findings.creatures[0]!.evidence, "creature"), "creature");
  const db = await database();
  try {
    assert.equal(await persist(db, input), 1);
    const rows = (await db.query<{ id: string; entity_type: string; estimated_stats: Record<string, unknown>; classification_source: string }>(
      "SELECT id, entity_type, estimated_stats, classification_source FROM storyhold.world_entities")).rows;
    assert.equal(rows.length, 1);
    const saved = rows[0]!;
    assert.equal(saved.entity_type, "creature");
    assert.equal(saved.classification_source, "ai");
    assert.deepEqual(saved.estimated_stats.strength, input.findings.creatures[0]!.estimatedStats!.strength);
    const links = (await db.query<{ entity_id: string; dossier_id: string | null; run_id: string; stat_name: string }>(
      "SELECT entity_id, dossier_id, run_id, stat_name FROM storyhold.world_entity_stat_verifications")).rows;
    assert.deepEqual(links, [{ entity_id: saved.id, dossier_id: null, run_id: scope.analysisRunId, stat_name: "strength" }]);
    assert.equal(await persist(db, input), 0);
    assert.equal((await db.query("SELECT count(*) AS count FROM storyhold.world_entities")).rows[0]!.count, 1);
    assert.equal((await db.query("SELECT count(*) AS count FROM storyhold.world_entity_stat_verifications")).rows[0]!.count, 1);
  } finally { await db.close(); }
});

test("reclassifying a new premium estimate preserves an established stat rather than installing the wrong-family value", async () => {
  const input = fixture("Humans", "Humans are one species among many. Humans held the fallen beam until the others escaped.");
  const db = await database();
  const prior = { score: 11, confidence: 0.6, rationale: "Earlier local estimate.", evidence: [{ chunkId, sourceId, quote: "Earlier source evidence." }] };
  try {
    await db.query(`INSERT INTO storyhold.world_entities (id, world_id, canon_edition_id, name, normalized_name, entity_type, estimated_stats)
      VALUES ($1, $2, $3, 'Humans', 'humans', 'species', $4::jsonb)`,
    [uuid(820), scope.worldId, scope.editionId, JSON.stringify({ strength: prior })]);
    assert.equal(await persist(db, input), 0);
    const saved = (await db.query<{ estimated_stats: Record<string, unknown> }>("SELECT estimated_stats FROM storyhold.world_entities WHERE id = $1", [uuid(820)])).rows[0]!;
    assert.deepEqual(saved.estimated_stats.strength, prior);
    assert.equal((await db.query("SELECT count(*) AS count FROM storyhold.world_entity_stat_verifications")).rows[0]!.count, 0);
  } finally { await db.close(); }
});

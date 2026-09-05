import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { ensureEntityStatJournal } from "./entityStatJournal";
import { buildEntityStatRequests, projectEntityReviewedStats, validateEntityStatReviews } from "./entityStatVerification";
import { premiumNeutralStats } from "./premiumStatCandidates";
import { ensurePremiumStatJournal } from "./premiumStatJournal";
import { buildEntityGraphRequest, projectEntityReviewedGraph, validateEntityGraphReview } from "./entityGraphVerification";
import { ensurePremiumGraphJournal } from "./premiumGraphJournal";
import { ensureEntityReviewGraphLinks, ensureEntityReviewJournal, executeJournaledEntityReviewCall,
  readEntityReviewCall, saveEntityReviewVerificationBundle, type EntityReviewCallScope } from "./entityReviewJournal";
import { getAiRuntimeStatus, type AiTextResult } from "./aiGateway";
import type { JsonObject } from "./analysisVerificationContracts";
import type { EntityReviewFinding, EntityReviewInput } from "./entityReview";
import type { CharacterFinding, EntityRelationFinding } from "./worldAnalysis";
import { saveEntityReview } from "./worldStudio";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const WORLD = uuid(901), EDITION = uuid(902), ENTITY = uuid(903), REVIEW = uuid(904), DOSSIER = uuid(905);
const CHUNK = uuid(906), SOURCE = uuid(907);
const QUOTE = "Mira held the heavy beam until her companions escaped.";
const evidence = [{ chunkId: CHUNK, sourceId: SOURCE, quote: QUOTE }];
const priorStrength = { score: 12, confidence: 0.9, rationale: "The earlier estimate of lifting ability.", evidence };
const reviewedStrength = { score: 16, confidence: 0.8, rationale: "Held the heavy beam while her companions escaped.", evidence };
const priorDexterity = { score: 14, confidence: 0.7, rationale: "A retained local movement estimate.", evidence };
type SaveParameters = Parameters<typeof saveEntityReview>[0];

function character(): CharacterFinding {
  return {
    name: "Mira", aliases: [], role: "Scout", summary: "Mira refuses to abandon her companions.",
    traits: ["Loyal"], motivations: [], fears: [], capabilities: [], history: [], origins: [], powers: [],
    moralSystem: [], physicalCharacteristics: [], relationships: [], relationshipWeb: [],
    estimatedStats: { ...premiumNeutralStats(), strength: structuredClone(priorStrength), dexterity: structuredClone(priorDexterity) },
    socioPoliticalAxis: { economic: 0, authority: 0, label: "Undetermined", rationale: "", confidence: 0 },
    knowledge: [], secrets: [], factionMemberships: [], evidence, confidence: 0.8,
  };
}

function input(type: "character" | "creature" = "creature"): EntityReviewInput {
  return {
    worldName: "A test world", worldPremise: "An expedition.", worldGenre: "Science Fiction", depth: "focused",
    premiumStatScope: { worldId: WORLD, editionId: EDITION, analysisRunId: REVIEW },
    entity: { id: ENTITY, name: "Mira", entityType: type, aliases: [], summary: "An established dossier.",
      details: [], relationships: [], estimatedStats: { strength: structuredClone(priorStrength) } },
    chunks: [{ id: CHUNK, sourceId: SOURCE, sourceTitle: "Manuscript", index: 0, content: QUOTE }],
    knownEntities: [{ name: "Mira", entityType: type, aliases: [] }],
    ...(type === "character" ? { currentCharacter: character() } : {}),
  };
}

function reviewed(reviewInput: EntityReviewInput) {
  const requests = buildEntityStatRequests(reviewInput);
  const statResponse = {
    statVerifications: requests.map((request, index) => ({
      requestFingerprint: request.fingerprint,
      decisions: request.proposals.map((proposal) => ({
        proposalId: proposal.id, verdict: "rejected", explanation: "The earlier estimate requires revision or remains unestablished.",
        confidence: 0.8, supportingEvidence: [], contradictingEvidence: [], retrievalRequests: [],
      })),
      newStats: index === 0 ? [{ payload: {
        family: reviewInput.entity.entityType === "character" ? "characters" : "creatures", entity: "Mira", stat: "strength",
        score: reviewedStrength.score, rationale: reviewedStrength.rationale,
      }, verdict: "verified", explanation: "The passage demonstrates the lifting action.", confidence: reviewedStrength.confidence,
      supportingEvidence: [{ chunkId: CHUNK, quote: QUOTE }], contradictingEvidence: [], retrievalRequests: [] }] : [],
    })),
  };
  const receipts = validateEntityStatReviews(reviewInput, statResponse,
    { provider: "offline-provider", model: "offline-fixture", completedAt: "2026-09-03T12:00:00.000Z" });
  const proposed: EntityReviewFinding = {
    aliases: [], summary: "Mira holds the beam so her companions can escape.", details: [], relationships: [],
    evidence, confidence: 0.8, estimatedStats: null,
    character: reviewInput.entity.entityType === "character" ? character() : null,
    relations: [], rules: [],
  };
  return { receipts, finding: projectEntityReviewedStats(reviewInput, proposed, receipts), statResponse };
}

async function database(type: "character" | "creature" = "creature") {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.worlds (id uuid PRIMARY KEY, updated_at timestamptz DEFAULT now());
    CREATE TABLE storyhold.world_analysis_runs (id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
      analysis_kind text DEFAULT 'ai_enrichment');
    CREATE TABLE storyhold.character_dossiers (id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
      canonical_character_id uuid, normalized_name text, name text, aliases jsonb DEFAULT '[]', role text DEFAULT '', summary text DEFAULT '',
      profile jsonb DEFAULT '{}', evidence jsonb DEFAULT '[]', confidence real DEFAULT 0.5, axis_estimate jsonb DEFAULT '{}',
      mention_count integer DEFAULT 0, mention_source_count integer DEFAULT 0,
      user_edited_at timestamptz, dossier_status text DEFAULT 'active', updated_at timestamptz DEFAULT now());
    CREATE TABLE storyhold.world_entities (id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
      dossier_id uuid REFERENCES storyhold.character_dossiers(id), canonical_key text DEFAULT 'mira', normalized_name text NOT NULL,
      name text NOT NULL, entity_type text NOT NULL, aliases jsonb DEFAULT '[]', summary text DEFAULT '', details jsonb DEFAULT '[]',
      relationships jsonb DEFAULT '[]', evidence jsonb DEFAULT '[]', mention_count integer DEFAULT 0, mention_source_count integer DEFAULT 0,
      confidence real DEFAULT 0.5, classification_source text DEFAULT 'local', review_status text DEFAULT 'candidate',
      estimated_stats jsonb DEFAULT '{}', pull_status text DEFAULT 'active', scanner_present boolean DEFAULT true,
      merged_into_entity_id uuid, updated_at timestamptz DEFAULT now());
    CREATE TABLE storyhold.world_sources (id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
      processing_status text DEFAULT 'ready', canon_status text DEFAULT 'canon');
    CREATE TABLE storyhold.world_source_chunks (id uuid PRIMARY KEY, source_id uuid NOT NULL, world_id uuid NOT NULL,
      canon_edition_id uuid NOT NULL, content text NOT NULL);`);
  await ensureEntityStatJournal(db);
  await ensurePremiumStatJournal(db);
  await db.query("INSERT INTO storyhold.worlds (id) VALUES ($1)", [WORLD]);
  if (type === "character") await db.query(`INSERT INTO storyhold.character_dossiers
    (id, world_id, canon_edition_id, normalized_name, name, profile, evidence) VALUES ($1, $2, $3, 'mira', 'Mira', $4::jsonb, $5::jsonb)`,
  [DOSSIER, WORLD, EDITION, JSON.stringify(character()), JSON.stringify(evidence)]);
  await db.query(`INSERT INTO storyhold.world_entities
    (id, world_id, canon_edition_id, dossier_id, normalized_name, name, entity_type, estimated_stats)
    VALUES ($1, $2, $3, $4, 'mira', 'Mira', $5, $6::jsonb)`,
  [ENTITY, WORLD, EDITION, type === "character" ? DOSSIER : null, type, JSON.stringify({ strength: priorStrength })]);
  await db.query("INSERT INTO storyhold.world_sources (id, world_id, canon_edition_id) VALUES ($1, $2, $3)", [SOURCE, WORLD, EDITION]);
  await db.query("INSERT INTO storyhold.world_source_chunks (id, source_id, world_id, canon_edition_id, content) VALUES ($1, $2, $3, $4, $5)",
    [CHUNK, SOURCE, WORLD, EDITION, QUOTE]);
  return db;
}

async function context(db: PGlite, reviewInput: EntityReviewInput): Promise<SaveParameters["context"]> {
  return {
    entityRow: (await db.query<Record<string, unknown>>("SELECT * FROM storyhold.world_entities WHERE id = $1", [ENTITY])).rows[0]!,
    input: reviewInput, mentionCount: 1, mentionSourceCount: 1, entityIdsByName: new Map([["mira", ENTITY]]), selectedPassages: [],
  };
}
async function save(db: PGlite, reviewInput: EntityReviewInput, overrides: Partial<SaveParameters> = {}) {
  const completed = reviewed(reviewInput);
  const prepared = await context(db, reviewInput);
  return db.transaction((tx) => saveEntityReview({
    db: tx as unknown as SaveParameters["db"], worldId: WORLD, editionId: EDITION, context: prepared,
    finding: completed.finding, reviewMode: "premium", statReviews: completed.receipts, ...overrides,
  }));
}
async function storedStats(db: PGlite) {
  return (await db.query<{ estimated_stats: Record<string, unknown> }>("SELECT estimated_stats FROM storyhold.world_entities WHERE id = $1", [ENTITY])).rows[0]!.estimated_stats;
}
async function reviewCount(db: PGlite) {
  return (await db.query<{ count: number }>("SELECT count(*) AS count FROM storyhold.entity_review_stat_reviews")).rows[0]!.count;
}

test("paid creature reruns persist only exact approved estimates and durable links", async () => {
  const db = await database();
  try {
    await save(db, input());
    assert.deepEqual((await storedStats(db)).strength, reviewedStrength);
    assert.equal(await reviewCount(db), 2);
    const links = (await db.query<{ entity_id: string; stat_name: string }>("SELECT entity_id, stat_name FROM storyhold.entity_review_stat_verifications")).rows;
    assert.deepEqual(links, [{ entity_id: ENTITY, stat_name: "strength" }]);
  } finally { await db.close(); }
});

test("paid character reruns replace approved stats and preserve omitted baseline estimates", async () => {
  const db = await database("character");
  try {
    await save(db, input("character"));
    const profile = (await db.query<{ profile: { estimatedStats: Record<string, unknown> } }>("SELECT profile FROM storyhold.character_dossiers WHERE id = $1", [DOSSIER])).rows[0]!.profile;
    assert.deepEqual(profile.estimatedStats.strength, reviewedStrength);
    assert.deepEqual(profile.estimatedStats.dexterity, priorDexterity);
    const links = (await db.query<{ entity_id: string; dossier_id: string; stat_name: string }>("SELECT entity_id, dossier_id, stat_name FROM storyhold.entity_review_stat_verifications")).rows;
    assert.deepEqual(links, [{ entity_id: ENTITY, dossier_id: DOSSIER, stat_name: "strength" }]);
  } finally { await db.close(); }
});

test("missing, foreign, or altered paid stat approvals cannot modify a dossier", async () => {
  const db = await database();
  try {
    await assert.rejects(save(db, input(), { statReviews: [] }));
    const reviewInput = input();
    const altered = reviewed(reviewInput);
    altered.finding.estimatedStats!.strength!.score = 20;
    await assert.rejects(save(db, reviewInput, { finding: altered.finding, statReviews: altered.receipts }));
    const foreign = input();
    foreign.premiumStatScope = { ...foreign.premiumStatScope!, worldId: uuid(999) };
    await assert.rejects(save(db, foreign));
    assert.deepEqual((await storedStats(db)).strength, priorStrength);
    assert.equal(await reviewCount(db), 0);
  } finally { await db.close(); }
});

test("changed or withdrawn manuscript sources prevent paid rerun persistence", async () => {
  const db = await database();
  try {
    for (const sql of [
      "UPDATE storyhold.world_source_chunks SET content = 'Changed manuscript'",
      "UPDATE storyhold.world_sources SET canon_status = 'excluded'",
      "UPDATE storyhold.world_sources SET processing_status = 'failed'",
      `UPDATE storyhold.world_source_chunks SET source_id = '${uuid(998)}'`,
    ]) {
      const reviewInput = input(); const completed = reviewed(reviewInput); const prepared = await context(db, reviewInput);
      await assert.rejects(db.transaction(async (tx) => {
        await tx.exec(sql);
        await saveEntityReview({ db: tx as unknown as SaveParameters["db"], worldId: WORLD, editionId: EDITION, context: prepared,
          finding: completed.finding, reviewMode: "premium", statReviews: completed.receipts });
      }));
      assert.deepEqual((await storedStats(db)).strength, priorStrength);
      assert.equal(await reviewCount(db), 0);
    }
  } finally { await db.close(); }
});

test("renamed, reclassified, merged, and hidden targets fail before paid updates", async () => {
  const db = await database();
  try {
    for (const sql of [
      "UPDATE storyhold.world_entities SET name = 'Changed Name'",
      "UPDATE storyhold.world_entities SET entity_type = 'species'",
      `UPDATE storyhold.world_entities SET merged_into_entity_id = '${uuid(997)}'`,
      "UPDATE storyhold.world_entities SET pull_status = 'do_not_pull'",
    ]) {
      const reviewInput = input(); const completed = reviewed(reviewInput); const prepared = await context(db, reviewInput);
      await assert.rejects(db.transaction(async (tx) => {
        await tx.exec(sql);
        await saveEntityReview({ db: tx as unknown as SaveParameters["db"], worldId: WORLD, editionId: EDITION, context: prepared,
          finding: completed.finding, reviewMode: "premium", statReviews: completed.receipts });
      }));
      assert.deepEqual((await storedStats(db)).strength, priorStrength);
      assert.equal(await reviewCount(db), 0);
    }
  } finally { await db.close(); }
});

test("owner-confirmed creature stats remain unchanged by paid review", async () => {
  const db = await database();
  try {
    await db.query("UPDATE storyhold.world_entities SET classification_source = 'user', review_status = 'user_confirmed'");
    await save(db, input());
    assert.deepEqual((await storedStats(db)).strength, priorStrength);
    assert.equal((await db.query<{ count: number }>("SELECT count(*) AS count FROM storyhold.entity_review_stat_verifications")).rows[0]!.count, 0);
  } finally { await db.close(); }
});

test("owner-edited character stats remain unchanged by paid review", async () => {
  const db = await database("character");
  try {
    await db.query("UPDATE storyhold.character_dossiers SET user_edited_at = now()");
    await save(db, input("character"));
    const profile = (await db.query<{ profile: { estimatedStats: Record<string, unknown> } }>("SELECT profile FROM storyhold.character_dossiers WHERE id = $1", [DOSSIER])).rows[0]!.profile;
    assert.deepEqual(profile.estimatedStats.strength, priorStrength);
    assert.equal((await db.query<{ count: number }>("SELECT count(*) AS count FROM storyhold.entity_review_stat_verifications")).rows[0]!.count, 0);
  } finally { await db.close(); }
});

test("local reruns remain available without premium receipts and cannot replace a receipt-backed stat", async () => {
  const db = await database();
  try {
    const reviewInput = input();
    const local = reviewed(reviewInput).finding;
    local.estimatedStats!.strength = { ...reviewedStrength, score: 18, rationale: "A provisional local estimate." };
    await save(db, reviewInput, { reviewMode: "local", finding: local, statReviews: undefined });
    assert.deepEqual((await storedStats(db)).strength, local.estimatedStats!.strength);
    assert.equal(await reviewCount(db), 0);
    await save(db, reviewInput);
    assert.deepEqual((await storedStats(db)).strength, reviewedStrength);
    await save(db, reviewInput, { reviewMode: "local", finding: local, statReviews: undefined });
    assert.deepEqual((await storedStats(db)).strength, reviewedStrength);
    assert.equal(await reviewCount(db), 2);
  } finally { await db.close(); }
});

async function membershipFixture(db: PGlite, reviewInput: EntityReviewInput, targetType = "faction") {
  await db.exec(`CREATE TABLE storyhold.world_entity_relations (
    id uuid PRIMARY KEY, world_id uuid, canon_edition_id uuid, source_entity_id uuid, relation_type text, target_entity_id uuid,
    relation_status text, summary text, valid_from_label text, valid_until_label text, evidence jsonb,
    assignment_source text, confidence real, updated_at timestamptz DEFAULT now(),
    UNIQUE(world_id,canon_edition_id,source_entity_id,relation_type,target_entity_id,relation_status,valid_from_label,valid_until_label));
    CREATE TABLE storyhold.world_entity_faction_memberships (entity_id uuid, faction_entity_id uuid,
    assignment_source text, confidence real, evidence jsonb, updated_at timestamptz DEFAULT now(), PRIMARY KEY(entity_id,faction_entity_id));`);
  const factionId = uuid(908);
  await db.query("INSERT INTO storyhold.world_entities (id,world_id,canon_edition_id,normalized_name,name,entity_type) VALUES ($1,$2,$3,'ash guild','Ash Guild',$4)", [factionId, WORLD, EDITION, targetType]);
  reviewInput.knownEntities.push({ name: "Ash Guild", entityType: targetType, aliases: [] });
  const prepared = await context(db, reviewInput);
  prepared.entityIdsByName.set("ash guild", factionId);
  return { factionId, prepared };
}
function membershipRelation(changes: Partial<EntityRelationFinding> = {}): EntityRelationFinding {
  return { subject: "Mira", relationType: "member_of", target: "Ash Guild", status: "active", summary: "Mira joined the Ash Guild.",
    validFromLabel: "", validUntilLabel: "", evidence, confidence: 0.8, ...changes };
}

test("local dossier reruns preserve dated and noncurrent membership relations without flattening them into current factions", async () => {
  const db = await database();
  try {
    const reviewInput = input(); const { prepared } = await membershipFixture(db, reviewInput);
    const completed = reviewed(reviewInput);
    completed.finding.relations = [
      ...(["former", "conditional", "disputed", "unknown"] as const).map((status) => membershipRelation({ status })),
      membershipRelation({ validFromLabel: "Book Two ending" }), membershipRelation({ validUntilLabel: "Chapter 12" }),
      membershipRelation({ validFromLabel: "Before winter", validUntilLabel: "After the siege" }),
    ];
    await save(db, reviewInput, { context: prepared, finding: completed.finding, reviewMode: "local", statReviews: undefined });
    const relations = (await db.query<{ relation_status: string; valid_from_label: string; valid_until_label: string }>("SELECT relation_status,valid_from_label,valid_until_label FROM storyhold.world_entity_relations")).rows;
    assert.equal(relations.length, 7);
    assert.ok(relations.some((relation) => relation.relation_status === "former"));
    assert.ok(relations.some((relation) => relation.valid_from_label === "Book Two ending"));
    assert.ok(relations.some((relation) => relation.valid_until_label === "Chapter 12"));
    assert.equal((await db.query("SELECT * FROM storyhold.world_entity_faction_memberships")).rows.length, 0);
  } finally { await db.close(); }
});

test("local active undated faction membership projects while blank-space labels are harmless", async () => {
  const db = await database();
  try {
    const reviewInput = input(); const { prepared, factionId } = await membershipFixture(db, reviewInput);
    const completed = reviewed(reviewInput);
    completed.finding.relations = [membershipRelation({ validFromLabel: " \t", validUntilLabel: "\n\u00a0" })];
    await save(db, reviewInput, { context: prepared, finding: completed.finding, reviewMode: "local", statReviews: undefined });
    const memberships = (await db.query<{ entity_id: string; faction_entity_id: string; assignment_source: string }>("SELECT entity_id,faction_entity_id,assignment_source FROM storyhold.world_entity_faction_memberships")).rows;
    assert.deepEqual(memberships, [{ entity_id: ENTITY, faction_entity_id: factionId, assignment_source: "ai" }]);
    assert.equal((await db.query("SELECT * FROM storyhold.world_entity_relations")).rows.length, 1);
  } finally { await db.close(); }
});

test("a local active membership-shaped relation to a nonfaction never creates faction membership", async () => {
  const db = await database();
  try {
    const reviewInput = input(); const { prepared } = await membershipFixture(db, reviewInput, "place");
    const completed = reviewed(reviewInput); completed.finding.relations = [membershipRelation()];
    await save(db, reviewInput, { context: prepared, finding: completed.finding, reviewMode: "local", statReviews: undefined });
    assert.equal((await db.query("SELECT * FROM storyhold.world_entity_relations")).rows.length, 1);
    assert.equal((await db.query("SELECT * FROM storyhold.world_entity_faction_memberships")).rows.length, 0);
  } finally { await db.close(); }
});

test("local current faction membership resolves both source and target aliases to canonical entity types", async () => {
  const db = await database();
  try {
    const reviewInput = input(); const { prepared, factionId } = await membershipFixture(db, reviewInput);
    reviewInput.entity.aliases = ["The Scout"];
    reviewInput.knownEntities[0]!.aliases = ["The Scout"];
    reviewInput.knownEntities[1]!.aliases = ["The Guild"];
    prepared.entityIdsByName.set("the scout", ENTITY);
    prepared.entityIdsByName.set("the guild", factionId);
    const completed = reviewed(reviewInput);
    completed.finding.relations = [membershipRelation({ subject: "The Scout", target: "The Guild" })];
    await save(db, reviewInput, { context: prepared, finding: completed.finding, reviewMode: "local", statReviews: undefined });
    assert.deepEqual((await db.query("SELECT entity_id,faction_entity_id FROM storyhold.world_entity_faction_memberships")).rows,
      [{ entity_id: ENTITY, faction_entity_id: factionId }]);
    assert.deepEqual((await db.query("SELECT source_entity_id,target_entity_id FROM storyhold.world_entity_relations")).rows,
      [{ source_entity_id: ENTITY, target_entity_id: factionId }]);
  } finally { await db.close(); }
});

test("an ineligible local source remains a relation but cannot project current faction membership", async () => {
  const db = await database();
  try {
    const reviewInput = input();
    const finding = reviewed(reviewInput).finding;
    finding.estimatedStats = null;
    finding.relations = [membershipRelation()];
    reviewInput.entity.entityType = "place";
    reviewInput.knownEntities[0]!.entityType = "place";
    await db.query("UPDATE storyhold.world_entities SET entity_type='place' WHERE id=$1", [ENTITY]);
    const { prepared } = await membershipFixture(db, reviewInput);
    await db.transaction((tx) => saveEntityReview({ db: tx as unknown as SaveParameters["db"],
      worldId: WORLD, editionId: EDITION, context: prepared, finding, reviewMode: "local" }));
    assert.equal((await db.query("SELECT * FROM storyhold.world_entity_relations")).rows.length, 1);
    assert.equal((await db.query("SELECT * FROM storyhold.world_entity_faction_memberships")).rows.length, 0);
  } finally { await db.close(); }
});

test("local dossier membership projection preserves owner-assigned rows and never deletes them for historical links", async () => {
  const db = await database();
  try {
    const reviewInput = input(); const { prepared, factionId } = await membershipFixture(db, reviewInput);
    await db.query("INSERT INTO storyhold.world_entity_faction_memberships (entity_id,faction_entity_id,assignment_source,confidence,evidence) VALUES ($1,$2,'user',0.25,'[{\"quote\":\"Owner-established membership\"}]')", [ENTITY, factionId]);
    const before = (await db.query("SELECT * FROM storyhold.world_entity_faction_memberships")).rows;
    const completed = reviewed(reviewInput); completed.finding.relations = [membershipRelation(), membershipRelation({ status: "former", validUntilLabel: "Book Two" })];
    await save(db, reviewInput, { context: prepared, finding: completed.finding, reviewMode: "local", statReviews: undefined });
    assert.deepEqual((await db.query("SELECT * FROM storyhold.world_entity_faction_memberships")).rows, before);
    assert.equal((await db.query("SELECT * FROM storyhold.world_entity_relations")).rows.length, 2);
  } finally { await db.close(); }
});

test("local character faction strings and relationship-web prose do not bypass explicit membership relations", async () => {
  const db = await database("character");
  try {
    const reviewInput = input("character"); const { prepared } = await membershipFixture(db, reviewInput);
    const completed = reviewed(reviewInput);
    completed.finding.character!.factionMemberships = ["Ash Guild"];
    completed.finding.character!.relationshipWeb = [{ name: "Ash Guild", relationship: "Former member", summary: "Mira left after the uprising.", sentiment: "professional", evidence }];
    await save(db, reviewInput, { context: prepared, finding: completed.finding, reviewMode: "local", statReviews: undefined });
    assert.equal((await db.query("SELECT * FROM storyhold.world_entity_faction_memberships")).rows.length, 0);
    assert.equal((await db.query("SELECT * FROM storyhold.world_entity_relations")).rows.length, 0);
    const profile = (await db.query<{ profile: { relationshipWeb: Array<{ relationship: string }> } }>("SELECT profile FROM storyhold.character_dossiers WHERE id=$1", [DOSSIER])).rows[0]!.profile;
    assert.ok(profile.relationshipWeb.some((link) => link.relationship === "Former member"));
  } finally { await db.close(); }
});

async function rulesTable(db: PGlite) {
  await db.exec(`CREATE TABLE storyhold.world_entity_rules (
    id uuid PRIMARY KEY, world_id uuid, canon_edition_id uuid, entity_id uuid, canonical_key text,
    name text, description text DEFAULT '', rule_kind text, trigger_text text DEFAULT '', effect_text text DEFAULT '',
    evidence jsonb DEFAULT '[]', assignment_source text DEFAULT 'local', confidence real DEFAULT 0.5,
    rule_status text DEFAULT 'active', updated_at timestamptz DEFAULT now(), UNIQUE(world_id,canon_edition_id,entity_id,canonical_key));`);
}

test("legacy paid responses retain existing canon and supported prose/stats but withhold raw graph and web changes with a warning", async () => {
  const db = await database("character");
  try {
    const reviewInput = input("character");
    const { prepared, factionId } = await membershipFixture(db, reviewInput);
    await rulesTable(db);
    const ownerWeb = [{ name: "Ash Guild", relationship: "Owner-established connection", summary: "The author's existing interpretation.", sentiment: "unknown", evidence }];
    await db.query("UPDATE storyhold.world_entities SET relationships = $2::jsonb WHERE id = $1", [ENTITY, JSON.stringify(["Owner-established connection"])]);
    await db.query("UPDATE storyhold.character_dossiers SET profile = profile || $2::jsonb WHERE id = $1",
      [DOSSIER, JSON.stringify({ relationships: ["Owner-established connection"], relationshipWeb: ownerWeb })]);
    await db.query(`INSERT INTO storyhold.world_entity_relations
      (id,world_id,canon_edition_id,source_entity_id,relation_type,target_entity_id,relation_status,summary,valid_from_label,valid_until_label,evidence,assignment_source,confidence)
      VALUES ($1,$2,$3,$4,'member_of',$5,'active','Owner-established connection','','','[]','user',0.9)`,
    [uuid(920), WORLD, EDITION, ENTITY, factionId]);
    await db.query(`INSERT INTO storyhold.world_entity_rules
      (id,world_id,canon_edition_id,entity_id,canonical_key,name,description,rule_kind,assignment_source)
      VALUES ($1,$2,$3,$4,'owner-rule','Owner Rule','Retain this rule','trait','user')`, [uuid(921), WORLD, EDITION, ENTITY]);
    const beforeRelations = (await db.query("SELECT * FROM storyhold.world_entity_relations")).rows;
    const beforeRules = (await db.query("SELECT * FROM storyhold.world_entity_rules")).rows;
    const completed = reviewed(reviewInput);
    completed.finding.relationships = ["Mira secretly commands the Ash Guild."];
    completed.finding.relations = [membershipRelation({ relationType: "leads" })];
    completed.finding.rules = [{ entity: "Mira", name: "Unverified Flight", description: "Mira can fly.", ruleKind: "ability", trigger: "", effect: "Flight", evidence, confidence: 0.8 }];
    completed.finding.character!.relationships = [...completed.finding.relationships];
    completed.finding.character!.relationshipWeb = [{ name: "Ash Guild", relationship: "Secret leader", summary: "Unverified new graph claim.", sentiment: "professional", evidence }];
    completed.finding.character!.factionMemberships = ["Ash Guild"];
    const outcome = await save(db, reviewInput, { context: prepared, finding: completed.finding });
    assert.ok(outcome.warnings.some((warning) => /connection and rule changes were not applied/u.test(warning)));
    assert.deepEqual((await db.query("SELECT * FROM storyhold.world_entity_relations")).rows, beforeRelations);
    assert.deepEqual((await db.query("SELECT * FROM storyhold.world_entity_rules")).rows, beforeRules);
    assert.equal((await db.query("SELECT * FROM storyhold.world_entity_faction_memberships")).rows.length, 0);
    const entity = (await db.query<{ summary: string; relationships: string[] }>("SELECT summary,relationships FROM storyhold.world_entities WHERE id=$1", [ENTITY])).rows[0]!;
    assert.equal(entity.summary, completed.finding.summary);
    assert.deepEqual(entity.relationships, ["Owner-established connection"]);
    const profile = (await db.query<{ profile: { estimatedStats: Record<string, unknown>; relationshipWeb: unknown[]; relationships: string[] } }>("SELECT profile FROM storyhold.character_dossiers WHERE id=$1", [DOSSIER])).rows[0]!.profile;
    assert.deepEqual(profile.relationshipWeb, ownerWeb);
    assert.deepEqual(profile.relationships, ["Owner-established connection"]);
    assert.deepEqual(profile.estimatedStats.strength, reviewedStrength);
    assert.equal(await reviewCount(db), 2);
  } finally { await db.close(); }
});

async function modernGraphFixture(db: PGlite) {
  const reviewInput = input("character");
  const { factionId, prepared } = await membershipFixture(db, reviewInput);
  await rulesTable(db);
  await db.exec(`CREATE TABLE storyhold.players (id uuid PRIMARY KEY, role text NOT NULL DEFAULT 'player');
    CREATE TABLE storyhold.credit_reservations (id uuid PRIMARY KEY, player_id uuid, world_id uuid, operation text,
      request_id text, status text DEFAULT 'reserved', reserved_credits integer DEFAULT 30, usage jsonb DEFAULT '{}');`);
  await ensureEntityReviewJournal(db);
  await ensurePremiumGraphJournal(db);
  await ensureEntityReviewGraphLinks(db);
  const graphQuote = "Mira joined the Ash Guild. Mira can glow when she sings, casting blue light.";
  reviewInput.chunks[0]!.content = `${QUOTE} ${graphQuote}`;
  await db.query("UPDATE storyhold.world_source_chunks SET content=$2 WHERE id=$1", [CHUNK, reviewInput.chunks[0]!.content]);
  const graphEvidence = [{ chunkId: CHUNK, sourceId: SOURCE, quote: graphQuote }];
  reviewInput.graphReview = {
    version: 1,
    entities: [{ id: ENTITY, name: "Mira", entityType: "character", aliases: [] }, { id: factionId, name: "Ash Guild", entityType: "faction", aliases: [] }],
    relations: [membershipRelation({ evidence: graphEvidence })],
    rules: [{ entity: "Mira", name: "Singing Glow", description: "Mira glows when she sings.", ruleKind: "ability", trigger: "Mira sings", effect: "Blue light", evidence: graphEvidence, confidence: 0.9 }],
  };
  const graphRequest = buildEntityGraphRequest(reviewInput)!;
  const stats = reviewed(reviewInput);
  const raw = { ...stats.finding, character: { ...stats.finding.character!, estimatedStats: null },
    ...stats.statResponse, relations: [], rules: [], entityRelations: [], entityRules: [],
    graphVerification: { requestFingerprint: graphRequest.fingerprint, newFindings: [], decisions: graphRequest.proposals.map((proposal) => ({
      proposalId: proposal.id, verdict: "verified", explanation: "The supplied passage explicitly supports this.", confidence: 0.9,
      supportingEvidence: [{ chunkId: CHUNK, quote: graphQuote }], contradictingEvidence: [], retrievalRequests: [],
    })) },
  };
  const graphScope: EntityReviewCallScope = { reviewId: REVIEW, playerId: uuid(909), worldId: WORLD, editionId: EDITION, entityId: ENTITY };
  await db.query("INSERT INTO storyhold.players(id) VALUES($1)", [graphScope.playerId]);
  await db.query("INSERT INTO storyhold.credit_reservations(id,player_id,world_id,operation,request_id) VALUES($1,$2,$3,'entity_review',$4)",
    [uuid(910), graphScope.playerId, WORLD, REVIEW]);
  const model = "offline-model";
  const providerResult: AiTextResult = { text: JSON.stringify(raw), provider: "openrouter", model, reasoning: "high",
    usage: { inputUnits: 1000, outputUnits: 100, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 0,
      estimatedCostMicros: 1500, pricingKnown: true, pricingVersion: "fixture", costEstimated: false },
    runtime: { ...getAiRuntimeStatus("canon_review", "standard", "dossier"), configured: true, mode: "connected", provider: "openrouter", model,
      stage: "dossier", billable: true, sendsSourceTextOffDevice: true, execution: { connectionId: "managed:openrouter", credentialSource: "environment",
        connectionSource: "storyhold_managed", billingSource: "storyhold_credits", requestedModel: model, resolvedModel: model, upstreamProvider: "fixture", privacyMode: "zero-data-retention" } } };
  const completed = await executeJournaledEntityReviewCall(db, { scope: graphScope, reservationId: uuid(910),
    contextSnapshot: { version: 1, input: reviewInput } as unknown as JsonObject,
    request: { task: "canon_review", stage: "dossier", system: "Review fixture evidence.", messages: [{ role: "user", content: reviewInput.chunks[0]!.content }],
      allowProviderFallback: false, providerFailurePolicy: "stop" }, provider: "openrouter", model, invoke: async () => providerResult });
  const verifier = { provider: completed.provider, model, completedAt: completed.journalCompletedAt! };
  const graphReview = validateEntityGraphReview(reviewInput, raw, verifier)!;
  const statReviews = validateEntityStatReviews(reviewInput, raw, verifier);
  const finding = projectEntityReviewedGraph(reviewInput, projectEntityReviewedStats(reviewInput, stats.finding, statReviews), graphReview);
  const args: SaveParameters = { db, worldId: WORLD, editionId: EDITION, context: prepared, finding,
    reviewMode: "premium", statReviews, graphReview, graphScope };
  const apply = (withProof = true) => db.transaction(async (tx) => {
    if (withProof) await saveEntityReviewVerificationBundle(tx, graphScope, { version: 1, graph: graphReview });
    return saveEntityReview({ ...args, db: tx as unknown as SaveParameters["db"] });
  });
  return { graphScope, factionId, apply, args };
}

async function graphAndStatState(db: PGlite) {
  return {
    entities: (await db.query<{ id: string; relationships: unknown[] }>("SELECT * FROM storyhold.world_entities ORDER BY id")).rows,
    dossiers: (await db.query<{ profile: unknown }>("SELECT * FROM storyhold.character_dossiers ORDER BY id")).rows,
    stats: (await db.query("SELECT * FROM storyhold.entity_review_stat_reviews ORDER BY step_key")).rows,
    statLinks: (await db.query("SELECT * FROM storyhold.entity_review_stat_verifications ORDER BY step_key,proposal_id")).rows,
    relations: (await db.query("SELECT * FROM storyhold.world_entity_relations ORDER BY id")).rows,
    rules: (await db.query("SELECT * FROM storyhold.world_entity_rules ORDER BY id")).rows,
    memberships: (await db.query("SELECT * FROM storyhold.world_entity_faction_memberships ORDER BY entity_id,faction_entity_id")).rows,
    relationLinks: (await db.query<{ entity_review_id: string; run_id: string | null }>("SELECT * FROM storyhold.world_entity_relation_verifications ORDER BY step_key,proposal_id")).rows,
    ruleLinks: (await db.query("SELECT * FROM storyhold.world_entity_rule_verifications ORDER BY step_key,proposal_id")).rows,
    proof: (await db.query("SELECT verification_snapshot,verification_fingerprint FROM storyhold.entity_review_ai_calls WHERE review_id=$1", [REVIEW])).rows,
  };
}

test("modern paid dossier save requires its exact private proof and commits graph, stats and linked displays together", async () => {
  const db = await database("character");
  try {
    const modern = await modernGraphFixture(db);
    const before = await graphAndStatState(db);
    await assert.rejects(modern.apply(false));
    assert.deepEqual(await graphAndStatState(db), before);
    await modern.apply();
    const saved = await graphAndStatState(db);
    assert.equal(saved.relations.length, 1); assert.equal(saved.rules.length, 1); assert.equal(saved.memberships.length, 1);
    assert.equal(saved.relationLinks.length, 1); assert.equal(saved.ruleLinks.length, 1);
    assert.equal(saved.relationLinks[0]?.entity_review_id, REVIEW); assert.equal(saved.relationLinks[0]?.run_id, null);
    assert.equal(saved.statLinks.length, 1); assert.equal(saved.stats.length, 2);
    const profile = (saved.dossiers[0]!.profile as Record<string, unknown>);
    assert.equal((profile.relationshipWeb as unknown[]).length, 1);
    assert.deepEqual((profile.estimatedStats as Record<string, unknown>).strength, reviewedStrength);
    assert.equal((await db.query("SELECT * FROM storyhold.world_analysis_runs")).rows.length, 0);
  } finally { await db.close(); }
});

test("modern paid dossier does not display a new relation when the owner row blocks that graph update", async () => {
  const db = await database("character");
  try {
    const modern = await modernGraphFixture(db);
    await db.query(`INSERT INTO storyhold.world_entity_relations
      (id,world_id,canon_edition_id,source_entity_id,relation_type,target_entity_id,relation_status,summary,valid_from_label,valid_until_label,evidence,assignment_source,confidence)
      VALUES($1,$2,$3,$4,'member_of',$5,'active','Owner preserves the old interpretation','','','[]','user',0.8)`,
    [uuid(922), WORLD, EDITION, ENTITY, modern.factionId]);
    const owner = (await db.query<Record<string, unknown>>("SELECT * FROM storyhold.world_entity_relations")).rows;
    await modern.apply();
    const saved = await graphAndStatState(db);
    assert.deepEqual(saved.relations, owner);
    assert.equal(saved.relationLinks.length, 0); assert.equal(saved.memberships.length, 0);
    assert.equal(saved.rules.length, 1); assert.equal(saved.statLinks.length, 1);
    const dossier = saved.dossiers[0]!.profile as Record<string, unknown>;
    assert.deepEqual(dossier.relationships, []); assert.deepEqual(dossier.relationshipWeb, []);
    assert.deepEqual(saved.entities.find((entity) => entity.id === ENTITY)?.relationships, []);
  } finally { await db.close(); }
});

test("changed source rolls back a newly saved graph proof and all dossier/stat/graph writes", async () => {
  const db = await database("character");
  try {
    const modern = await modernGraphFixture(db);
    await db.query("UPDATE storyhold.world_source_chunks SET content='The source was replaced.' WHERE id=$1", [CHUNK]);
    const before = await graphAndStatState(db);
    await assert.rejects(modern.apply(), /manuscript changed/);
    assert.deepEqual(await graphAndStatState(db), before);
    assert.equal((await readEntityReviewCall(db, modern.graphScope))?.status, "completed");
  } finally { await db.close(); }
});

test("late dossier failure rolls back already-written graph, stat receipts and private proof", async () => {
  const db = await database("character");
  try {
    const modern = await modernGraphFixture(db);
    await db.exec(`CREATE FUNCTION storyhold.fail_dossier_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Temporary dossier write failure'; END; $$;
      CREATE TRIGGER fail_dossier BEFORE UPDATE ON storyhold.character_dossiers FOR EACH ROW EXECUTE FUNCTION storyhold.fail_dossier_update();`);
    const before = await graphAndStatState(db);
    await assert.rejects(modern.apply(), /Temporary dossier write failure/);
    assert.deepEqual(await graphAndStatState(db), before);
    assert.equal((await readEntityReviewCall(db, modern.graphScope))?.status, "completed");
    await db.exec("DROP TRIGGER fail_dossier ON storyhold.character_dossiers");
    await modern.apply();
    assert.equal((await graphAndStatState(db)).relationLinks.length, 1);
  } finally { await db.close(); }
});

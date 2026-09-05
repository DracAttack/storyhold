import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { buildPremiumStatRequest, validatePremiumStatResponse, type PremiumStatReviewReceipt } from "./premiumStatVerification";
import { premiumNeutralStats } from "./premiumStatCandidates";
import {
  applyPremiumVerifiedStats, assertExpectedPremiumStatReviews, assertPremiumStatProjection, ensurePremiumStatJournal,
  linkPremiumStatReviewsToCanon, preparePremiumEntityStatProjection, premiumStatsForEntity, PremiumStatJournalError, readPremiumStatReviews, savePremiumStatReview,
} from "./premiumStatJournal";
import type { CharacterFinding, WorldFindings } from "./worldAnalysis";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { worldId: uuid(1), editionId: uuid(2), analysisRunId: uuid(3) };
const QUOTE = "Mira lifted the fallen beam and held it until the others escaped.";
const EVIDENCE = [{ chunkId: uuid(20), sourceId: uuid(21), quote: QUOTE }];
const hasCode = (code: string) => (error: unknown) => error instanceof PremiumStatJournalError && error.code === code;

function findings(): WorldFindings {
  return {
    summary: "", genres: [], atmosphere: [], themes: [], worldRules: [], locations: [], factions: [], institutions: [],
    governments: [], powerStructures: [], creatures: [], species: [], technologies: [], vehicles: [], devices: [],
    weapons: [], powers: [], titles: [], ambiguous: [], chapterSummaries: [], chronology: [], openQuestions: [],
    recurringTerms: [], characters: [], entityRelations: [], entityRules: [], claims: [], cohesionProposals: [],
  };
}
function character(name = "Mira"): CharacterFinding {
  return {
    name, aliases: [], role: "", summary: "", traits: [], motivations: [], fears: [], capabilities: [], history: [],
    origins: [], powers: [], moralSystem: [], physicalCharacteristics: [], relationships: [], relationshipWeb: [],
    estimatedStats: premiumNeutralStats(), socioPoliticalAxis: { economic: 0, authority: 0, label: "Undetermined", rationale: "", confidence: 0.05 },
    knowledge: [], secrets: [], factionMemberships: [], evidence: EVIDENCE, confidence: 0.9,
  };
}
function fixture(options: { family?: "characters" | "creatures"; entity?: string; score?: number; rationale?: string } = {}): WorldFindings {
  const result = findings();
  const entity = character(options.entity ?? "Mira");
  entity.estimatedStats.strength = { score: options.score ?? 16, confidence: 0.9,
    rationale: options.rationale ?? "Held a fallen beam long enough for others to escape.", evidence: EVIDENCE };
  if (options.family === "creatures") result.creatures.push({ name: entity.name, summary: "", evidence: EVIDENCE, estimatedStats: entity.estimatedStats });
  else result.characters.push(entity);
  return result;
}
function receipt(options: {
  step?: string; verdict?: "verified" | "rejected"; completedAt?: string; family?: "characters" | "creatures";
  entity?: string; score?: number; rationale?: string;
} = {}): PremiumStatReviewReceipt {
  const request = buildPremiumStatRequest({ scope, stepKey: options.step ?? "verification:0",
    chunks: [{ id: uuid(20), sourceId: uuid(21), text: QUOTE }], findings: fixture(options), context: {} });
  return validatePremiumStatResponse(request, { statVerification: {
    requestFingerprint: request.fingerprint, newStats: [], decisions: request.proposals.map((proposal) => ({
      proposalId: proposal.id, verdict: options.verdict ?? "verified", explanation: "The passage demonstrates sustained lifting strength.", confidence: 0.9,
      supportingEvidence: options.verdict === "rejected" ? [] : [{ chunkId: uuid(20), quote: QUOTE }], contradictingEvidence: [], retrievalRequests: [],
    })),
  } }, { provider: "test-provider", model: "test-model", completedAt: options.completedAt ?? "2026-09-03T12:00:00.000Z" });
}
async function database() {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.world_analysis_runs (id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
      analysis_kind text NOT NULL DEFAULT 'ai_enrichment');
    CREATE TABLE storyhold.character_dossiers (id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
      normalized_name text NOT NULL, user_edited_at timestamptz, dossier_status text DEFAULT 'active', profile jsonb DEFAULT '{}');
    CREATE TABLE storyhold.world_entities (id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
      dossier_id uuid REFERENCES storyhold.character_dossiers(id), name text NOT NULL, normalized_name text NOT NULL,
      entity_type text NOT NULL, classification_source text DEFAULT 'ai', review_status text DEFAULT 'verified',
      pull_status text DEFAULT 'active', scanner_present boolean DEFAULT true, merged_into_entity_id uuid, estimated_stats jsonb DEFAULT '{}');`);
  await ensurePremiumStatJournal(db);
  await db.query("INSERT INTO storyhold.world_analysis_runs (id, world_id, canon_edition_id) VALUES ($1, $2, $3)", [scope.analysisRunId, scope.worldId, scope.editionId]);
  return db;
}

test("stat receipts are immutable, exact, scoped and idempotently replayable", async () => {
  const db = await database();
  try {
    const value = receipt();
    assert.deepEqual(await db.transaction((tx) => savePremiumStatReview(tx, value)), value);
    assert.deepEqual(await db.transaction((tx) => savePremiumStatReview(tx, structuredClone(value))), value);
    assert.deepEqual(await readPremiumStatReviews(db, scope), [value]);
    assert.equal((await db.query<{ count: number }>("SELECT count(*) AS count FROM storyhold.world_analysis_stat_reviews")).rows[0]?.count, 1);
    await assert.rejects(db.transaction((tx) => savePremiumStatReview(tx, receipt({ completedAt: "2026-09-03T12:00:01.000Z" }))), hasCode("STAT_RECEIPT_MISMATCH"));
    await assert.rejects(readPremiumStatReviews(db, { ...scope, worldId: uuid(99) }), hasCode("STAT_SCOPE_MISMATCH"));
    await assert.rejects(db.query("UPDATE storyhold.world_analysis_stat_reviews SET step_key = 'changed'"), /immutable/);
  } finally { await db.close(); }
});

test("stat journal detects a corrupt stored snapshot before replay", async () => {
  const db = await database();
  try {
    await db.transaction((tx) => savePremiumStatReview(tx, receipt()));
    await db.exec("ALTER TABLE storyhold.world_analysis_stat_reviews DISABLE TRIGGER premium_stat_review_immutable");
    await db.query("UPDATE storyhold.world_analysis_stat_reviews SET snapshot_fingerprint = 'tampered'");
    await assert.rejects(readPremiumStatReviews(db, scope), hasCode("STAT_JOURNAL_INTEGRITY"));
    await assert.rejects(db.transaction((tx) => savePremiumStatReview(tx, receipt())), hasCode("STAT_JOURNAL_INTEGRITY"));
  } finally { await db.close(); }
});

test("stat receipts and generated writes roll back together", async () => {
  const db = await database();
  try {
    await assert.rejects(db.transaction(async (tx) => { await savePremiumStatReview(tx, receipt()); throw new Error("projection write failed"); }), /projection write failed/);
    assert.deepEqual(await readPremiumStatReviews(db, scope), []);
  } finally { await db.close(); }
});

test("exact stat receipt inventory rejects missing, duplicate and foreign review pages", () => {
  const first = receipt(); const second = receipt({ step: "verification:1" });
  const expected = { scope, expectedStepKeys: ["verification:0", "verification:1"] };
  assertExpectedPremiumStatReviews([second, first], expected);
  assert.throws(() => assertExpectedPremiumStatReviews([first], expected), hasCode("STAT_RECEIPTS_INCOMPLETE"));
  assert.throws(() => assertExpectedPremiumStatReviews([first, first], expected), hasCode("STAT_RECEIPTS_INCOMPLETE"));
  assert.throws(() => assertExpectedPremiumStatReviews([first, second], { ...expected, scope: { ...scope, editionId: uuid(99) } }), hasCode("STAT_SCOPE_MISMATCH"));
  assert.throws(() => assertExpectedPremiumStatReviews([first, second], { ...expected, expectedStepKeys: ["verification:0", "verification:0"] }), hasCode("STAT_RECEIPTS_INCOMPLETE"));
});

test("receipt-only stat projection preserves prose without mutating source findings", () => {
  const input = fixture(); input.characters[0]!.summary = "Mira refuses to abandon her companions.";
  input.characters[0]!.estimatedStats.dexterity = { score: 20, confidence: 1, rationale: "Invented dexterity.", evidence: EVIDENCE };
  const original = structuredClone(input); const value = receipt();
  const output = applyPremiumVerifiedStats(input, [value]);
  assert.deepEqual(input, original);
  assert.equal(output.characters[0]!.summary, input.characters[0]!.summary);
  assert.equal(output.characters[0]!.estimatedStats.strength.score, 16);
  assert.deepEqual(output.characters[0]!.estimatedStats.dexterity, premiumNeutralStats().dexterity);
  assertPremiumStatProjection(output, [value]);
});

test("stat projection rejects altered score, rationale, confidence and supporting evidence", () => {
  const value = receipt(); const approved = applyPremiumVerifiedStats(fixture(), [value]);
  for (const mutate of [
    (stat: CharacterFinding["estimatedStats"]["strength"]) => { stat.score = 17; },
    (stat: CharacterFinding["estimatedStats"]["strength"]) => { stat.rationale += " She is a giant."; },
    (stat: CharacterFinding["estimatedStats"]["strength"]) => { stat.confidence = 1; },
    (stat: CharacterFinding["estimatedStats"]["strength"]) => { stat.evidence = []; },
  ]) {
    const altered = structuredClone(approved); mutate(altered.characters[0]!.estimatedStats.strength);
    assert.throws(() => assertPremiumStatProjection(altered, [value]), hasCode("STAT_PROJECTION_MISMATCH"));
  }
});

test("rejected stats remain audited but cannot promote or manufacture entities", () => {
  const rejected = receipt({ verdict: "rejected" });
  const output = applyPremiumVerifiedStats(fixture(), [rejected]);
  assert.deepEqual(output.characters[0]!.estimatedStats, premiumNeutralStats());
  assertPremiumStatProjection(output, [rejected]);
  assert.throws(() => assertPremiumStatProjection(fixture(), [rejected]), hasCode("STAT_PROJECTION_MISMATCH"));
  assert.deepEqual(applyPremiumVerifiedStats(findings(), [receipt()]), findings());
});

test("family, identity and aliases do not authorize transferring a verified stat", () => {
  const value = receipt({ family: "creatures", entity: "Mira's War Form" });
  const input = fixture(); input.characters[0]!.aliases = ["Mira's War Form"];
  input.creatures.push({ name: "Mira's War Form", summary: "", evidence: EVIDENCE });
  const output = applyPremiumVerifiedStats(input, [value]);
  assert.deepEqual(output.characters[0]!.estimatedStats, premiumNeutralStats());
  assert.equal(output.creatures[0]!.estimatedStats!.strength.score, 16);
  assertPremiumStatProjection(output, [value]);
  output.characters[0]!.estimatedStats.strength = structuredClone(output.creatures[0]!.estimatedStats!.strength);
  assert.throws(() => assertPremiumStatProjection(output, [value]), hasCode("STAT_PROJECTION_MISMATCH"));
});

test("conflicting verified stat variants remain unprojected rather than selecting high confidence", () => {
  const first = receipt(); const second = receipt({ step: "verification:1", score: 18 });
  const output = applyPremiumVerifiedStats(fixture(), [first, second]);
  assert.deepEqual(output.characters[0]!.estimatedStats.strength, premiumNeutralStats().strength);
  assertPremiumStatProjection(output, [first, second]);
  assert.throws(() => assertPremiumStatProjection(fixture(), [first, second]), hasCode("STAT_PROJECTION_MISMATCH"));
  const reasonVariant = receipt({ step: "verification:2", rationale: "Possesses enormous strength in every circumstance." });
  assert.deepEqual(applyPremiumVerifiedStats(fixture(), [first, reasonVariant]).characters[0]!.estimatedStats.strength, premiumNeutralStats().strength);
});

test("identical stat payloads choose one exact deterministic receipt across replay order", () => {
  const first = receipt(); const second = receipt({ step: "verification:1" });
  const forward = applyPremiumVerifiedStats(fixture(), [first, second]);
  const reverse = applyPremiumVerifiedStats(fixture(), [second, first]);
  assert.deepEqual(forward, reverse);
  assertPremiumStatProjection(forward, [second, first]);
});

test("neutral unknown defaults are allowed but confident ordinary scores require verification", () => {
  const input = findings(); input.characters.push(character());
  assertPremiumStatProjection(input, []);
  input.characters[0]!.estimatedStats.strength = { score: 10, confidence: 0.8, rationale: "Demonstrates ordinary lifting strength.", evidence: EVIDENCE };
  assert.throws(() => assertPremiumStatProjection(input, []), hasCode("STAT_PROJECTION_MISMATCH"));
});

test("final entity classification can only receive stats verified for that exact family and name", () => {
  const value = receipt({ family: "creatures" });
  const approved = premiumStatsForEntity("creature", "Mira", [value]);
  assert.ok(approved);
  assert.equal(approved.strength.score, 16);
  assert.deepEqual(approved.dexterity, premiumNeutralStats().dexterity);
  assert.equal(premiumStatsForEntity("character", "Mira", [value]), undefined);
  assert.equal(premiumStatsForEntity("species", "Mira", [value]), undefined);
  assert.equal(premiumStatsForEntity("creature", "The Singer", [value]), undefined);
  assert.equal(premiumStatsForEntity("world_rule", "Mira", [value]), undefined);
  const again = premiumStatsForEntity("creature", "Mira", [value]);
  approved.strength.score = 20;
  assert.equal(again!.strength.score, 16);
});

test("final entity stat projection leaves rejected, conflicting and absent approvals unset", () => {
  const first = receipt();
  assert.equal(premiumStatsForEntity("character", "Mira", []), undefined);
  assert.equal(premiumStatsForEntity("character", "Mira", [receipt({ verdict: "rejected" })]), undefined);
  assert.equal(premiumStatsForEntity("character", "Mira", [first, receipt({ step: "verification:1", score: 18 })]), undefined);
  assert.equal(premiumStatsForEntity("character", "Mira", [first])!.strength.score, 16);
});

test("prepared entity stat projection snapshots receipts once and returns isolated stat blocks", () => {
  const source = structuredClone(receipt());
  const project = preparePremiumEntityStatProjection([source]);
  source.fingerprint = "changed after preparation";
  const first = project("character", "Mira")!;
  first.strength.evidence[0]!.quote = "changed projected evidence";
  first.strength.score = 20;
  assert.equal(project("character", "Mira")!.strength.score, 16);
  assert.equal(project("character", "Mira")!.strength.evidence[0]!.quote, QUOTE);
  assert.equal(project("creature", "Mira"), undefined);
});

async function canonicalStat(db: PGlite, value: PremiumStatReviewReceipt, family: "characters" | "creatures" = "characters") {
  const output = applyPremiumVerifiedStats(fixture({ family }), [value]);
  const stats = family === "characters" ? output.characters[0]!.estimatedStats : output.creatures[0]!.estimatedStats;
  if (family === "characters") {
    await db.query("INSERT INTO storyhold.character_dossiers (id, world_id, canon_edition_id, normalized_name, profile) VALUES ($1, $2, $3, 'mira', $4::jsonb)",
      [uuid(30), scope.worldId, scope.editionId, JSON.stringify({ estimatedStats: stats })]);
  }
  await db.query(`INSERT INTO storyhold.world_entities
    (id, world_id, canon_edition_id, dossier_id, name, normalized_name, entity_type, estimated_stats)
    VALUES ($1, $2, $3, $4, 'Mira', 'mira', $5, $6::jsonb)`,
    [uuid(31), scope.worldId, scope.editionId, family === "characters" ? uuid(30) : null, family === "characters" ? "character" : "creature", JSON.stringify(stats)]);
}

test("canonical stat links require durable receipts and exact persisted values, and replay once", async () => {
  const db = await database();
  try {
    const value = receipt(); await canonicalStat(db, value);
    await assert.rejects(linkPremiumStatReviewsToCanon(db, [value]), hasCode("STAT_RECEIPT_MISMATCH"));
    await db.transaction((tx) => savePremiumStatReview(tx, value));
    assert.equal(await db.transaction((tx) => linkPremiumStatReviewsToCanon(tx, [value])), 1);
    assert.equal(await db.transaction((tx) => linkPremiumStatReviewsToCanon(tx, [value])), 0);
    const links = (await db.query<{ entity_id: string; dossier_id: string; stat_name: string; run_id: string }>("SELECT * FROM storyhold.world_entity_stat_verifications")).rows;
    assert.equal(links.length, 1); assert.equal(links[0]?.entity_id, uuid(31)); assert.equal(links[0]?.dossier_id, uuid(30));
    assert.equal(links[0]?.stat_name, "strength"); assert.equal(links[0]?.run_id, scope.analysisRunId);
    await assert.rejects(db.query("UPDATE storyhold.world_entity_stat_verifications SET decision_id = 'changed'"), /immutable/);
  } finally { await db.close(); }
});

test("canonical stat linker refuses edited dossiers, owner entities and altered values without changing them", async () => {
  const db = await database();
  try {
    const value = receipt(); await canonicalStat(db, value); await db.transaction((tx) => savePremiumStatReview(tx, value));
    await db.query("UPDATE storyhold.character_dossiers SET user_edited_at = now()");
    assert.equal(await linkPremiumStatReviewsToCanon(db, [value]), 0);
    await db.query("UPDATE storyhold.character_dossiers SET user_edited_at = NULL");
    await db.query("UPDATE storyhold.world_entities SET classification_source = 'user'");
    assert.equal(await linkPremiumStatReviewsToCanon(db, [value]), 0);
    await db.query("UPDATE storyhold.world_entities SET classification_source = 'ai', entity_type = 'creature'");
    assert.equal(await linkPremiumStatReviewsToCanon(db, [value]), 0);
    await db.query("UPDATE storyhold.world_entities SET entity_type = 'character'");
    await db.query("UPDATE storyhold.character_dossiers SET profile = jsonb_set(profile, '{estimatedStats,strength,score}', '19')");
    const before = (await db.query("SELECT profile FROM storyhold.character_dossiers")).rows;
    assert.equal(await linkPremiumStatReviewsToCanon(db, [value]), 0);
    assert.deepEqual((await db.query("SELECT profile FROM storyhold.character_dossiers")).rows, before);
    assert.equal((await db.query<{ count: number }>("SELECT count(*) AS count FROM storyhold.world_entity_stat_verifications")).rows[0]?.count, 0);
  } finally { await db.close(); }
});

test("creature stat links target entity storage and never infer aliases or ambiguous identities", async () => {
  const db = await database();
  try {
    const value = receipt({ family: "creatures" }); await canonicalStat(db, value, "creatures");
    await db.transaction((tx) => savePremiumStatReview(tx, value));
    await db.query("UPDATE storyhold.world_entities SET name = 'The Singer', normalized_name = 'the singer'");
    assert.equal(await linkPremiumStatReviewsToCanon(db, [value]), 0);
    await db.query("UPDATE storyhold.world_entities SET name = 'Mira', normalized_name = 'mira'");
    await db.query(`INSERT INTO storyhold.world_entities (id, world_id, canon_edition_id, name, normalized_name, entity_type)
      VALUES ($1, $2, $3, 'Mira', 'mira', 'creature')`, [uuid(32), scope.worldId, scope.editionId]);
    assert.equal(await linkPremiumStatReviewsToCanon(db, [value]), 0);
    await db.query("DELETE FROM storyhold.world_entities WHERE id = $1", [uuid(32)]);
    assert.equal(await linkPremiumStatReviewsToCanon(db, [value]), 1);
    const link = (await db.query<{ entity_id: string; dossier_id: string | null }>("SELECT entity_id, dossier_id FROM storyhold.world_entity_stat_verifications")).rows[0];
    assert.equal(link?.entity_id, uuid(31)); assert.equal(link?.dossier_id, null);
  } finally { await db.close(); }
});

test("conflicting stat judgments produce no canonical application links", async () => {
  const db = await database();
  try {
    const first = receipt(); const second = receipt({ step: "verification:1", score: 18 });
    await canonicalStat(db, first);
    await db.transaction(async (tx) => { await savePremiumStatReview(tx, first); await savePremiumStatReview(tx, second); });
    assert.equal(await linkPremiumStatReviewsToCanon(db, [first, second]), 0);
  } finally { await db.close(); }
});

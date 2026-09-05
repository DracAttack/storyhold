import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { buildVerifiedPromotionPlan, canonPayloadFingerprint } from "./analysisVerificationContracts";
import { buildPremiumGraphRequest, validatePremiumGraphResponse, type PremiumGraphReviewReceipt } from "./premiumGraphVerification";
import {
  assertExpectedPremiumGraphReviews, ensurePremiumGraphJournal, PremiumGraphJournalError,
  readPremiumGraphReviews, savePremiumGraphReview, syncPremiumVerifiedGraph,
  syncEntityVerifiedGraph,
} from "./premiumGraphJournal";
import type { EntityRelationFinding, EntityRuleFinding } from "./worldAnalysis";
import { assertEntityGraphReview, buildEntityGraphRequest, validateEntityGraphReview, type EntityGraphContext } from "./entityGraphVerification";
import { ensureEntityReviewJournal, ensureEntityReviewGraphLinks, executeJournaledEntityReviewCall, executeJournaledEntityReviewPages,
  finalizeEntityReviewCall, readEntityReviewCall, saveEntityReviewVerificationBundle, type EntityReviewCallScope } from "./entityReviewJournal";
import { getAiRuntimeStatus, type AiTextResult } from "./aiGateway";
import type { EntityReviewInput } from "./entityReview";
import { prepareEntityReviewPages } from "./entityReviewPages";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { worldId: uuid(1), editionId: uuid(2), analysisRunId: uuid(3) };
const QUOTE = "Mira joined the Ash Guild. Mira can glow when she sings, casting blue light.";
const EVIDENCE = [{ chunkId: uuid(20), sourceId: uuid(21), quote: QUOTE }];
const policy = {
  canPassRelation: (_type: unknown, source: string, target: string) => source === "character" && target === "faction",
  assertRelationSemantics: (_relation: EntityRelationFinding, _chunks: Array<{ id: string; sourceId: string; text: string }>) => {},
};
function relation(changes: Partial<EntityRelationFinding> = {}): EntityRelationFinding {
  return { subject: "Mira", relationType: "member_of", target: "Ash Guild", status: "active", summary: "Mira is a guild member.",
    validFromLabel: "", validUntilLabel: "", evidence: EVIDENCE, confidence: 0.9, ...changes };
}
function rule(changes: Partial<EntityRuleFinding> = {}): EntityRuleFinding {
  return { entity: "Mira", name: "Singing Glow", description: "Mira glows when she sings.", ruleKind: "ability",
    trigger: "Mira sings", effect: "Blue light", evidence: EVIDENCE, confidence: 0.9, ...changes };
}
function receipt(params: {
  step?: string; relations?: EntityRelationFinding[]; rules?: EntityRuleFinding[];
  verdict?: "verified" | "rejected"; completedAt?: string;
} = {}): PremiumGraphReviewReceipt {
  const request = buildPremiumGraphRequest({ scope, stepKey: params.step ?? "verification:0",
    chunks: [{ id: uuid(20), sourceId: uuid(21), text: QUOTE }], relations: params.relations ?? [relation()], rules: params.rules ?? [rule()], context: {} });
  return validatePremiumGraphResponse(request, { entityRelations: [], entityRules: [], graphVerification: {
    requestFingerprint: request.fingerprint, newFindings: [], decisions: request.proposals.map((proposal) => ({
      proposalId: proposal.id, verdict: params.verdict ?? "verified", explanation: "The supplied passage directly states this.", confidence: 0.9,
      supportingEvidence: params.verdict === "rejected" ? [] : [{ chunkId: uuid(20), quote: QUOTE }], contradictingEvidence: [], retrievalRequests: [],
    })),
  } }, { provider: "test-provider", model: "test-model", completedAt: params.completedAt ?? "2026-09-03T12:00:00.000Z" });
}
async function database() {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.worlds (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.canon_editions (id uuid PRIMARY KEY, world_id uuid REFERENCES storyhold.worlds(id) ON DELETE CASCADE);
    CREATE TABLE storyhold.world_analysis_runs (id uuid PRIMARY KEY, world_id uuid REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
      canon_edition_id uuid REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE, analysis_kind text DEFAULT 'ai_enrichment');
    CREATE TABLE storyhold.world_entities (id uuid PRIMARY KEY, world_id uuid REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
      canon_edition_id uuid REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE, name text NOT NULL, aliases jsonb DEFAULT '[]',
      entity_type text NOT NULL, pull_status text DEFAULT 'active', scanner_present boolean DEFAULT true, merged_into_entity_id uuid,
      classification_source text DEFAULT 'local', review_status text DEFAULT 'candidate');
    CREATE TABLE storyhold.world_entity_relations (id uuid PRIMARY KEY, world_id uuid REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
      canon_edition_id uuid REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE, source_entity_id uuid REFERENCES storyhold.world_entities(id) ON DELETE CASCADE,
      relation_type text, target_entity_id uuid REFERENCES storyhold.world_entities(id) ON DELETE CASCADE, relation_status text DEFAULT 'active',
      summary text DEFAULT '', valid_from_label text DEFAULT '', valid_until_label text DEFAULT '', evidence jsonb DEFAULT '[]',
      assignment_source text DEFAULT 'local', confidence real DEFAULT 0.5, updated_at timestamptz DEFAULT now(),
      UNIQUE (world_id, canon_edition_id, source_entity_id, relation_type, target_entity_id, relation_status, valid_from_label, valid_until_label));
    CREATE TABLE storyhold.world_entity_rules (id uuid PRIMARY KEY, world_id uuid REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
      canon_edition_id uuid REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE, entity_id uuid REFERENCES storyhold.world_entities(id) ON DELETE CASCADE,
      canonical_key text, name text, description text DEFAULT '', rule_kind text, trigger_text text DEFAULT '', effect_text text DEFAULT '',
      evidence jsonb DEFAULT '[]', assignment_source text DEFAULT 'local', confidence real DEFAULT 0.5, rule_status text DEFAULT 'active',
      updated_at timestamptz DEFAULT now(), UNIQUE (world_id, canon_edition_id, entity_id, canonical_key));
    CREATE TABLE storyhold.world_entity_faction_memberships (entity_id uuid REFERENCES storyhold.world_entities(id) ON DELETE CASCADE,
      faction_entity_id uuid REFERENCES storyhold.world_entities(id) ON DELETE CASCADE, assignment_source text DEFAULT 'local',
      confidence real DEFAULT 0.5, evidence jsonb DEFAULT '[]', updated_at timestamptz DEFAULT now(), PRIMARY KEY (entity_id, faction_entity_id));`);
  await ensurePremiumGraphJournal(db);
  await db.query("INSERT INTO storyhold.worlds VALUES ($1)", [scope.worldId]);
  await db.query("INSERT INTO storyhold.canon_editions VALUES ($1, $2)", [scope.editionId, scope.worldId]);
  await db.query("INSERT INTO storyhold.world_analysis_runs (id, world_id, canon_edition_id) VALUES ($1, $2, $3)", [scope.analysisRunId, scope.worldId, scope.editionId]);
  await db.query(`INSERT INTO storyhold.world_entities (id, world_id, canon_edition_id, name, entity_type, aliases) VALUES
    ($1, $3, $4, 'Mira', 'character', '["The Singer"]'), ($2, $3, $4, 'Ash Guild', 'faction', '["The Guild"]')`, [uuid(10), uuid(11), scope.worldId, scope.editionId]);
  return db;
}
const hasCode = (code: string) => (error: unknown) => error instanceof PremiumGraphJournalError && error.code === code;
async function sync(db: PGlite, receipts: PremiumGraphReviewReceipt[]) {
  return db.transaction(async (tx) => {
    for (const value of receipts) await savePremiumGraphReview(tx, value);
    return syncPremiumVerifiedGraph(tx, receipts, policy);
  });
}
async function materialized(db: PGlite) {
  return {
    relations: (await db.query("SELECT * FROM storyhold.world_entity_relations ORDER BY id")).rows,
    rules: (await db.query("SELECT * FROM storyhold.world_entity_rules ORDER BY id")).rows,
    memberships: (await db.query("SELECT * FROM storyhold.world_entity_faction_memberships ORDER BY entity_id")).rows,
    relationLinks: (await db.query("SELECT * FROM storyhold.world_entity_relation_verifications ORDER BY proposal_id")).rows,
    ruleLinks: (await db.query("SELECT * FROM storyhold.world_entity_rule_verifications ORDER BY proposal_id")).rows,
  };
}

test("graph receipts are exact, immutable, scoped, tamper-checked and replayable", async () => {
  const db = await database();
  try {
    const value = receipt();
    assert.deepEqual(await db.transaction((tx) => savePremiumGraphReview(tx, value)), value);
    assert.deepEqual(await db.transaction((tx) => savePremiumGraphReview(tx, structuredClone(value))), value);
    assert.deepEqual(await readPremiumGraphReviews(db, scope), [value]);
    await assert.rejects(db.transaction((tx) => savePremiumGraphReview(tx, receipt({ completedAt: "2026-09-03T12:00:01.000Z" }))), hasCode("GRAPH_RECEIPT_MISMATCH"));
    await assert.rejects(readPremiumGraphReviews(db, { ...scope, worldId: uuid(99) }), hasCode("GRAPH_SCOPE_MISMATCH"));
    await assert.rejects(db.query("UPDATE storyhold.world_analysis_graph_reviews SET step_key = 'changed'"), /immutable/);
    await db.exec("ALTER TABLE storyhold.world_analysis_graph_reviews DISABLE TRIGGER premium_graph_review_immutable");
    await db.query("UPDATE storyhold.world_analysis_graph_reviews SET snapshot_fingerprint = 'tampered'");
    await assert.rejects(readPremiumGraphReviews(db, scope), hasCode("GRAPH_JOURNAL_INTEGRITY"));
    await assert.rejects(syncPremiumVerifiedGraph(db, [value], policy), hasCode("GRAPH_JOURNAL_INTEGRITY"));
    assert.equal((await materialized(db)).relations.length, 0);
  } finally { await db.close(); }
});

test("exact expected inventory blocks omission, duplication and foreign receipt batches", () => {
  const first = receipt(); const second = receipt({ step: "verification:1" });
  const expected = { scope, expectedStepKeys: ["verification:0", "verification:1"] };
  assertExpectedPremiumGraphReviews([second, first], expected);
  assert.throws(() => assertExpectedPremiumGraphReviews([first], expected), hasCode("GRAPH_RECEIPTS_INCOMPLETE"));
  assert.throws(() => assertExpectedPremiumGraphReviews([first, first], expected), hasCode("GRAPH_RECEIPTS_INCOMPLETE"));
  assert.throws(() => assertExpectedPremiumGraphReviews([first, second], { ...expected, scope: { ...scope, editionId: uuid(99) } }), hasCode("GRAPH_SCOPE_MISMATCH"));
});

test("only durable verified decisions materialize graph rows, current-run links and evidence-backed membership", async () => {
  const db = await database();
  try {
    const value = receipt();
    await assert.rejects(syncPremiumVerifiedGraph(db, [value], policy), hasCode("GRAPH_RECEIPT_MISMATCH"));
    const result = await sync(db, [value]);
    assert.equal(result.relationsSaved, 1); assert.equal(result.rulesSaved, 1); assert.equal(result.membershipsSaved, 1); assert.equal(result.linksCreated, 2);
    const rows = await materialized(db);
    assert.equal(rows.relations[0]?.source_analysis_run_id, scope.analysisRunId);
    assert.equal(rows.rules[0]?.source_analysis_run_id, scope.analysisRunId);
    const entries = buildVerifiedPromotionPlan(value.packet, value.decisions, value.batch);
    assert.deepEqual(new Set([...rows.relationLinks, ...rows.ruleLinks].map((row) => row.payload_fingerprint)), new Set(entries.map((entry) => entry.payloadFingerprint)));
    assert.deepEqual(rows.memberships[0]?.evidence, EVIDENCE);
    assert.equal((await sync(db, [value])).linksCreated, 0);
    await assert.rejects(db.query("UPDATE storyhold.world_entity_relation_verifications SET decision_id = 'different'"), /immutable/);
    await assert.rejects(db.query("UPDATE storyhold.world_entity_rule_verifications SET decision_id = 'different'"), /immutable/);
  } finally { await db.close(); }
});

test("rejected batches do not promote or delete previously materialized graph rows", async () => {
  const db = await database();
  try {
    await sync(db, [receipt()]);
    const before = await materialized(db);
    const rejected = receipt({ step: "verification:1", verdict: "rejected" });
    const result = await sync(db, [rejected]);
    assert.equal(result.relationsSaved + result.rulesSaved + result.membershipsSaved, 0);
    assert.deepEqual(await materialized(db), before);
  } finally { await db.close(); }
});

test("temporal and status-distinct relations survive and never become timeless memberships", async () => {
  const db = await database();
  try {
    const value = receipt({ rules: [], relations: [
      relation({ validFromLabel: "Chapter One", validUntilLabel: "Chapter Two" }),
      relation({ validFromLabel: "Chapter Three", validUntilLabel: "Chapter Four" }),
      relation({ status: "former" }), relation({ status: "conditional" }),
    ] });
    const result = await sync(db, [value]);
    assert.equal(result.relationsSaved, 4); assert.equal(result.membershipsSaved, 0);
    assert.equal((await materialized(db)).relations.length, 4);
  } finally { await db.close(); }
});

test("owner relations, memberships and legacy alias-key rules cannot be overwritten or bypassed", async () => {
  const db = await database();
  try {
    await sync(db, [receipt()]);
    await db.query("UPDATE storyhold.world_entity_relations SET assignment_source = 'user'");
    await db.query("UPDATE storyhold.world_entity_rules SET assignment_source = 'user', canonical_key = 'old-alias-key'");
    await db.query("UPDATE storyhold.world_entity_faction_memberships SET assignment_source = 'user'");
    const before = await materialized(db);
    const result = await sync(db, [receipt({ step: "verification:1", relations: [relation({ subject: "The Singer", target: "The Guild" })], rules: [rule({ entity: "The Singer" })] })]);
    assert.equal(result.relationsSaved + result.rulesSaved + result.membershipsSaved + result.linksCreated, 0);
    assert.deepEqual(await materialized(db), before);
  } finally { await db.close(); }
});

test("legacy generated rule keys are reused after alias resolution without migration or duplicate records", async () => {
  const db = await database();
  try {
    await sync(db, [receipt({ relations: [] })]);
    await db.query("UPDATE storyhold.world_entity_rules SET canonical_key = 'legacy-alias-key', assignment_source = 'local'");
    const oldId = (await materialized(db)).rules[0]!.id;
    const result = await sync(db, [receipt({ step: "verification:1", relations: [], rules: [rule({ entity: "The Singer" })] })]);
    assert.equal(result.rulesSaved, 1);
    const rows = (await materialized(db)).rules;
    assert.equal(rows.length, 1); assert.equal(rows[0]?.id, oldId); assert.equal(rows[0]?.canonical_key, "legacy-alias-key");
  } finally { await db.close(); }
});

test("a unique active local baseline rule upgrades to the exact verified rule and provenance", async () => {
  const db = await database();
  try {
    await db.query(`INSERT INTO storyhold.world_entity_rules
      (id, world_id, canon_edition_id, entity_id, canonical_key, name, description, rule_kind, trigger_text, effect_text, assignment_source)
      VALUES ($1, $2, $3, $4, 'legacy-local-key', 'Singing Glow', 'An uncertain baseline description.', 'ability', 'Mira speaks', 'Dim green light', 'local')`,
    [uuid(30), scope.worldId, scope.editionId, uuid(10)]);
    const value = receipt({ relations: [], rules: [rule({ entity: "The Singer" })] });
    const result = await sync(db, [value]);
    assert.equal(result.rulesSaved, 1); assert.equal(result.linksCreated, 1); assert.equal(result.conflicts.length, 0);
    const rows = await materialized(db);
    assert.equal(rows.rules.length, 1); assert.equal(rows.rules[0]?.id, uuid(30));
    assert.equal(rows.rules[0]?.canonical_key, "legacy-local-key");
    assert.equal(rows.rules[0]?.description, "Mira glows when she sings.");
    assert.equal(rows.rules[0]?.trigger_text, "Mira sings"); assert.equal(rows.rules[0]?.effect_text, "Blue light");
    assert.equal(rows.rules[0]?.assignment_source, "ai"); assert.equal(rows.rules[0]?.source_analysis_run_id, scope.analysisRunId);
    assert.equal(rows.ruleLinks[0]?.rule_id, uuid(30)); assert.equal(rows.ruleLinks[0]?.run_id, scope.analysisRunId);
    assert.equal(rows.ruleLinks[0]?.payload_fingerprint, buildVerifiedPromotionPlan(value.packet, value.decisions, value.batch)[0]!.payloadFingerprint);
  } finally { await db.close(); }
});

test("local baseline correction does not override retired, disputed, or ambiguous existing rules", async () => {
  const db = await database();
  try {
    await db.query(`INSERT INTO storyhold.world_entity_rules
      (id, world_id, canon_edition_id, entity_id, canonical_key, name, description, rule_kind, trigger_text, effect_text, assignment_source)
      VALUES ($1, $2, $3, $4, 'legacy-local-key', 'Singing Glow', 'Baseline description.', 'ability', 'Mira speaks', 'Dim green light', 'local')`,
    [uuid(30), scope.worldId, scope.editionId, uuid(10)]);
    for (const status of ["retired", "disputed"]) {
      await db.query("UPDATE storyhold.world_entity_rules SET rule_status = $1", [status]);
      const before = (await materialized(db)).rules;
      const result = await sync(db, [receipt({ step: `verification:${status}`, relations: [] })]);
      assert.equal(result.rulesSaved, 0); assert.equal(result.linksCreated, 0);
      assert.match(result.conflicts[0]!.summary, new RegExp(`previously marked ${status}`));
      assert.deepEqual((await materialized(db)).rules, before);
    }
    await db.query("UPDATE storyhold.world_entity_rules SET rule_status = 'active'");
    await db.query(`INSERT INTO storyhold.world_entity_rules
      (id, world_id, canon_edition_id, entity_id, canonical_key, name, description, rule_kind, trigger_text, effect_text, assignment_source)
      VALUES ($1, $2, $3, $4, 'other-legacy-key', 'Singing Glow', 'Another baseline.', 'ability', 'Mira hums', 'Gold light', 'local')`,
    [uuid(31), scope.worldId, scope.editionId, uuid(10)]);
    const before = (await materialized(db)).rules;
    const ambiguous = await sync(db, [receipt({ step: "verification:ambiguous", relations: [] })]);
    assert.equal(ambiguous.rulesSaved, 0); assert.equal(ambiguous.linksCreated, 0); assert.equal(ambiguous.conflicts.length, 1);
    assert.deepEqual((await materialized(db)).rules, before);
  } finally { await db.close(); }
});

test("alias-resolved conflicting rule effects produce actionable conflicts and no promoted hybrid", async () => {
  const db = await database();
  try {
    const result = await sync(db, [receipt({ relations: [], rules: [rule(), rule({ entity: "The Singer", effect: "Red light" })] })]);
    assert.equal(result.rulesSaved, 0); assert.equal(result.linksCreated, 0); assert.equal(result.conflicts.length, 1);
    assert.match(result.conflicts[0]!.summary, /disagree/);
    assert.match(result.conflicts[0]!.summary, /Blue light/);
    assert.match(result.conflicts[0]!.summary, /Red light/);
    assert.doesNotMatch(result.conflicts[0]!.summary, /payload|promotion/);
    assert.equal((await materialized(db)).rules.length, 0);
  } finally { await db.close(); }
});

test("identical effects with different rule descriptions stay conflicted and show both descriptions", async () => {
  const db = await database();
  try {
    const result = await sync(db, [receipt({ relations: [], rules: [rule(), rule({ entity: "The Singer", description: "Mira produces moonlight rather than ordinary light." })] })]);
    assert.equal(result.rulesSaved, 0); assert.equal(result.conflicts.length, 1);
    assert.match(result.conflicts[0]!.summary, /Mira glows when she sings/);
    assert.match(result.conflicts[0]!.summary, /Mira produces moonlight/);
  } finally { await db.close(); }
});

test("existing retired rules remain unchanged with an explicit readable status conflict", async () => {
  const db = await database();
  try {
    await sync(db, [receipt({ relations: [] })]);
    await db.query("UPDATE storyhold.world_entity_rules SET rule_status = 'retired'");
    const before = (await materialized(db)).rules;
    const result = await sync(db, [receipt({ step: "verification:1", relations: [], rules: [rule({ effect: "Silver light" })] })]);
    assert.equal(result.rulesSaved, 0); assert.equal(result.conflicts.length, 1);
    assert.match(result.conflicts[0]!.summary, /previously marked retired/);
    assert.match(result.conflicts[0]!.summary, /Blue light/);
    assert.match(result.conflicts[0]!.summary, /Silver light/);
    assert.deepEqual((await materialized(db)).rules, before);
  } finally { await db.close(); }
});

test("a new verified rule cannot silently supersede a different active saved rule through an alias", async () => {
  const db = await database();
  try {
    await sync(db, [receipt({ relations: [] })]);
    const before = await materialized(db);
    const result = await sync(db, [receipt({ step: "verification:1", relations: [], rules: [rule({ entity: "The Singer", trigger: "Mira whispers", effect: "Red light" })] })]);
    assert.equal(result.rulesSaved, 0); assert.equal(result.linksCreated, 0); assert.equal(result.conflicts.length, 1);
    assert.match(result.conflicts[0]!.summary, /saved rule and the new passage disagree/);
    assert.match(result.conflicts[0]!.summary, /Mira sings/);
    assert.match(result.conflicts[0]!.summary, /Mira whispers/);
    assert.match(result.conflicts[0]!.summary, /Blue light/);
    assert.match(result.conflicts[0]!.summary, /Red light/);
    assert.deepEqual(await materialized(db), before);
  } finally { await db.close(); }
});

test("same relation identity chooses an exact deterministic summary without borrowing another decision's payload", async () => {
  const db = await database();
  try {
    const value = receipt({ rules: [], relations: [relation({ summary: "First exact account." }), relation({ summary: "Second exact account." })] });
    const expected = buildVerifiedPromotionPlan(value.packet, value.decisions, value.batch).sort((a, b) => a.payloadFingerprint.localeCompare(b.payloadFingerprint))[0]!;
    const result = await sync(db, [value]);
    assert.equal(result.relationsSaved, 1); assert.equal(result.linksCreated, 1);
    const rows = await materialized(db);
    assert.equal(rows.relations[0]?.summary, expected.payload.summary);
    assert.equal(rows.relationLinks[0]?.payload_fingerprint, expected.payloadFingerprint);
  } finally { await db.close(); }
});

test("missing, ambiguous, scanner-hidden or category-incompatible endpoints are not fabricated", async () => {
  const db = await database();
  try {
    const value = receipt({ relations: [relation({ subject: "Unknown Person" })], rules: [rule({ entity: "Unknown Person" })] });
    const result = await sync(db, [value]);
    assert.equal(result.referenceIssues.length, 2); assert.equal(result.relationsSaved + result.rulesSaved, 0);
    const valid = receipt({ step: "verification:1", rules: [] });
    await db.transaction(async (tx) => {
      await savePremiumGraphReview(tx, valid);
      const rejected = await syncPremiumVerifiedGraph(tx, [valid], { ...policy, canPassRelation: () => false });
      assert.equal(rejected.relationsSaved, 0); assert.equal(rejected.referenceIssues.length, 1);
    });
    await db.query("UPDATE storyhold.world_entities SET scanner_present = false WHERE id = $1", [uuid(10)]);
    assert.equal((await db.transaction((tx) => syncPremiumVerifiedGraph(tx, [valid], policy))).relationsSaved, 0);
  } finally { await db.close(); }
});

test("relationship meaning checks see every exact verified candidate and veto atomically before canonical writes", async () => {
  const db = await database();
  try {
    const value = receipt({ relations: [relation({ summary: "First exact account." }), relation({ summary: "Second exact account." })] });
    const checked: EntityRelationFinding[] = [];
    await assert.rejects(db.transaction(async (tx) => {
      await savePremiumGraphReview(tx, value);
      return syncPremiumVerifiedGraph(tx, [value], { ...policy, assertRelationSemantics: (candidate, chunks) => {
        assert.deepEqual(chunks, value.request.chunks);
        assert.deepEqual(candidate.evidence, EVIDENCE);
        assert.equal(candidate.reviewStatus, "verified");
        checked.push(candidate);
        if (checked.length === 2) throw new Error("The verified relationship would change meaning.");
      } });
    }), /would change meaning/);
    assert.equal(checked.length, 2);
    assert.deepEqual(new Set(checked.map((candidate) => candidate.summary)), new Set(["First exact account.", "Second exact account."]));
    assert.deepEqual(await readPremiumGraphReviews(db, scope), []);
    assert.equal(Object.values(await materialized(db)).reduce((sum, rows) => sum + rows.length, 0), 0);
    await assert.rejects(syncPremiumVerifiedGraph(db, [value], { canPassRelation: policy.canPassRelation } as Parameters<typeof syncPremiumVerifiedGraph>[2]), hasCode("GRAPH_SYNC_INVALID"));
  } finally { await db.close(); }
});

test("receipt, graph rows, membership and decision links roll back atomically and cascade with world deletion", async () => {
  const db = await database();
  try {
    const value = receipt();
    await assert.rejects(db.transaction(async (tx) => {
      await savePremiumGraphReview(tx, value); await syncPremiumVerifiedGraph(tx, [value], policy); throw new Error("downstream canonical failure");
    }), /downstream canonical/);
    assert.deepEqual(await readPremiumGraphReviews(db, scope), []);
    const rolled = await materialized(db);
    assert.equal(Object.values(rolled).reduce((sum, rows) => sum + rows.length, 0), 0);
    await sync(db, [value]);
    await db.query("DELETE FROM storyhold.worlds WHERE id = $1", [scope.worldId]);
    assert.equal((await db.query("SELECT * FROM storyhold.world_analysis_graph_reviews")).rows.length, 0);
    const removed = await materialized(db);
    assert.equal(Object.values(removed).reduce((sum, rows) => sum + rows.length, 0), 0);
  } finally { await db.close(); }
});

const dossierScope: EntityReviewCallScope = { reviewId: uuid(30), playerId: uuid(31), worldId: scope.worldId,
  editionId: scope.editionId, entityId: uuid(10) };
async function dossierDatabase(db: PGlite) {
  await db.exec(`CREATE TABLE storyhold.players (id uuid PRIMARY KEY, role text NOT NULL DEFAULT 'admin');
    CREATE TABLE storyhold.credit_reservations (id uuid PRIMARY KEY, operation text, request_id text);`);
  await ensureEntityReviewJournal(db);
  await ensureEntityReviewGraphLinks(db);
  await db.query("INSERT INTO storyhold.players (id) VALUES ($1)", [dossierScope.playerId]);
}
function dossierInput(changes: { relations?: EntityRelationFinding[]; rules?: EntityRuleFinding[] } = {}): EntityReviewInput & { graphReview: EntityGraphContext } {
  return {
    worldName: "The Ash Guild", worldPremise: "An expedition", worldGenre: "Fantasy", depth: "focused",
    entity: { id: dossierScope.entityId, name: "Mira", entityType: "character", aliases: ["The Singer"], summary: "", details: [], relationships: [] },
    premiumStatScope: { worldId: scope.worldId, editionId: scope.editionId, analysisRunId: dossierScope.reviewId },
    chunks: [{ id: uuid(20), sourceId: uuid(21), content: QUOTE, index: 0, sourceTitle: "Chapter One" }],
    knownEntities: [{ name: "Mira", entityType: "character", aliases: ["The Singer"] }, { name: "Ash Guild", entityType: "faction", aliases: ["The Guild"] }],
    graphReview: { version: 1, relations: changes.relations ?? [relation()], rules: changes.rules ?? [rule()], entities: [
      { id: uuid(10), name: "Mira", entityType: "character", aliases: ["The Singer"] },
      { id: uuid(11), name: "Ash Guild", entityType: "faction", aliases: ["The Guild"] },
    ] },
  };
}
async function dossierFixture(db: PGlite, changes: { relations?: EntityRelationFinding[]; rules?: EntityRuleFinding[]; saveBundle?: boolean; uncertain?: boolean } = {}) {
  await dossierDatabase(db);
  const input = dossierInput(changes);
  const request = buildEntityGraphRequest(input)!;
  const raw = { relations: [], rules: [], entityRelations: [], entityRules: [], graphVerification: {
    requestFingerprint: request.fingerprint, newFindings: [], decisions: request.proposals.map((proposal) => ({
      proposalId: proposal.id, verdict: "verified", explanation: "The supplied passage states this.", confidence: 0.9,
      supportingEvidence: [{ chunkId: uuid(20), quote: QUOTE }], contradictingEvidence: [], retrievalRequests: [],
    })),
  } };
  const result: AiTextResult = { text: JSON.stringify(raw), provider: "test-provider", model: "test-model", reasoning: "high",
    usage: { inputUnits: 100, outputUnits: 50, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 0,
      estimatedCostMicros: 100, pricingKnown: true, pricingVersion: "test", costEstimated: false },
    runtime: { ...getAiRuntimeStatus("canon_review", "standard", "dossier"), provider: "test-provider", model: "test-model" },
  };
  const saved = await executeJournaledEntityReviewCall(db, {
    scope: dossierScope, reservationId: null, contextSnapshot: JSON.parse(JSON.stringify({ version: 1, input })),
    request: { task: "canon_review", stage: "dossier", reasoning: "high", maxOutputTokens: 2000, temperature: 0,
      system: "Verify the supplied graph.", messages: [{ role: "user", content: QUOTE }], allowProviderFallback: false, providerFailurePolicy: "stop" },
    provider: result.provider, model: result.model, invoke: async () => {
      if (changes.uncertain) throw new Error("Provider outcome is unknown.");
      return result;
    },
  }).catch((error) => {
    if (!changes.uncertain) throw error;
    assert.equal(error.code, "OUTCOME_UNRESOLVED");
    return { ...result, journalCompletedAt: "2026-09-03T12:00:00.000Z" };
  });
  const graph = validateEntityGraphReview(input, raw, { provider: saved.provider, model: saved.runtime.execution?.resolvedModel ?? saved.model, completedAt: saved.journalCompletedAt! })!;
  const persisted = (await readEntityReviewCall(db, dossierScope))!;
  assertEntityGraphReview(persisted.context_snapshot.input as unknown as EntityReviewInput, graph);
  if (!changes.uncertain) assert.deepEqual(validateEntityGraphReview(persisted.context_snapshot.input as unknown as EntityReviewInput, JSON.parse(persisted.result_snapshot!.text), {
    provider: persisted.result_snapshot!.provider, model: persisted.result_snapshot!.runtime.execution?.resolvedModel ?? persisted.result_snapshot!.model,
    completedAt: persisted.result_snapshot!.journalCompletedAt!,
  }), graph);
  if (changes.saveBundle !== false) await db.transaction((tx) => saveEntityReviewVerificationBundle(tx, dossierScope, { version: 1, graph }));
  return { input, graph };
}
async function syncDossier(db: PGlite, graph: PremiumGraphReviewReceipt | readonly PremiumGraphReviewReceipt[]) {
  return db.transaction((tx) => syncEntityVerifiedGraph(tx, dossierScope, graph, policy));
}

test("dossier graph uses the same writer with real paid-call links and no fabricated analysis run", async () => {
  const db = await database();
  try {
    const { graph } = await dossierFixture(db, { relations: [relation({ subject: "The Singer", target: "The Guild" })], rules: [rule({ entity: "The Singer" })] });
    let identityCheck = "";
    const result = await db.transaction((tx) => syncEntityVerifiedGraph({ query: ((sql: string, values?: unknown[]) => {
      if (sql.includes("SELECT id, name, entity_type, aliases, pull_status")) identityCheck = sql;
      return tx.query(sql, values);
    }) as PGlite["query"] }, dossierScope, graph, policy));
    assert.match(identityCheck, /FOR SHARE/); assert.doesNotMatch(identityCheck, /FOR UPDATE/);
    assert.equal(result.relationsSaved, 1); assert.equal(result.rulesSaved, 1); assert.equal(result.membershipsSaved, 1); assert.equal(result.linksCreated, 2);
    assert.equal(result.appliedRelations?.length, 1); assert.equal(result.appliedRelations[0]!.subject, "The Singer");
    const rows = await materialized(db);
    assert.equal(rows.relations[0]?.source_analysis_run_id, null);
    assert.equal(rows.rules[0]?.source_analysis_run_id, null);
    for (const link of [...rows.relationLinks, ...rows.ruleLinks]) {
      assert.equal(link.run_id, null); assert.equal(link.entity_review_id, dossierScope.reviewId); assert.equal(link.step_key, "dossier_graph:0");
    }
    assert.equal((await db.query("SELECT * FROM storyhold.world_analysis_runs WHERE id=$1", [dossierScope.reviewId])).rows.length, 0);
    assert.equal((await db.query("SELECT * FROM storyhold.world_analysis_graph_reviews")).rows.length, 0);
    assert.equal((await syncDossier(db, graph)).linksCreated, 0);
    assert.equal((await syncDossier(db, [graph])).linksCreated, 0, "legacy single-receipt replay also accepts a one-page inventory");
  } finally { await db.close(); }
});

test("dossier graph refuses absent or mismatched private bundles and finalized calls", async () => {
  const db = await database();
  try {
    const { graph } = await dossierFixture(db, { saveBundle: false });
    await assert.rejects(syncDossier(db, graph), hasCode("GRAPH_RECEIPT_MISMATCH"));
    await db.transaction((tx) => saveEntityReviewVerificationBundle(tx, dossierScope, { version: 1, graph }));
    await assert.rejects(syncDossier(db, []), hasCode("GRAPH_RECEIPTS_INCOMPLETE"));
    await assert.rejects(syncDossier(db, [graph, graph]), hasCode("GRAPH_RECEIPT_MISMATCH"));
    await assert.rejects(syncEntityVerifiedGraph(db, { ...dossierScope, playerId: uuid(99) }, graph, policy), /different scope/);
    await assert.rejects(syncDossier(db, receipt()), hasCode("GRAPH_RECEIPT_MISMATCH"));
    await db.transaction((tx) => finalizeEntityReviewCall(tx, dossierScope, { reviewed: false }));
    await assert.rejects(syncDossier(db, graph), hasCode("ENTITY_GRAPH_CALL_UNAVAILABLE"));
    assert.equal(Object.values(await materialized(db)).reduce((sum, rows) => sum + rows.length, 0), 0);
  } finally { await db.close(); }
});

test("a syntactically valid graph receipt cannot authorize an uncertain paid dossier call", async () => {
  const db = await database();
  try {
    const { graph } = await dossierFixture(db, { saveBundle: false, uncertain: true });
    assert.equal((await readEntityReviewCall(db, dossierScope))!.status, "uncertain");
    await assert.rejects(syncDossier(db, graph), hasCode("ENTITY_GRAPH_CALL_UNAVAILABLE"));
    assert.equal(Object.values(await materialized(db)).reduce((sum, rows) => sum + rows.length, 0), 0);
  } finally { await db.close(); }
});

test("dossier graph refuses changed, hidden, merged, reclassified or replaced frozen counterpart identities", async () => {
  const db = await database();
  try {
    const { graph } = await dossierFixture(db);
    for (const sql of ["name='New Guild'", "entity_type='place'", "pull_status='hidden'", "scanner_present=false",
      `merged_into_entity_id='${uuid(10)}'`, "aliases='[]'::jsonb"]) {
      await assert.rejects(db.transaction(async (tx) => {
        await tx.query(`UPDATE storyhold.world_entities SET ${sql} WHERE id=$1`, [uuid(11)]);
        await syncEntityVerifiedGraph(tx, dossierScope, graph, policy);
      }), hasCode("ENTITY_GRAPH_CONTEXT_STALE"));
    }
    await assert.rejects(db.transaction(async (tx) => {
      await tx.query("DELETE FROM storyhold.world_entities WHERE id=$1", [uuid(11)]);
      await tx.query("INSERT INTO storyhold.world_entities (id,world_id,canon_edition_id,name,entity_type,aliases) VALUES ($1,$2,$3,'Ash Guild','faction','[\"The Guild\"]')", [uuid(80), scope.worldId, scope.editionId]);
      await syncEntityVerifiedGraph(tx, dossierScope, graph, policy);
    }), hasCode("ENTITY_GRAPH_CONTEXT_STALE"));
    assert.equal(Object.values(await materialized(db)).reduce((sum, rows) => sum + rows.length, 0), 0);
  } finally { await db.close(); }
});

test("dossier graph accepts active scanner-absent owner-created or owner-confirmed identities without widening world intake", async () => {
  const db = await database();
  try {
    const { graph } = await dossierFixture(db);
    for (const marker of ["classification_source='user',review_status='candidate'", "classification_source='local',review_status='user_confirmed'"]) {
      await db.query(`UPDATE storyhold.world_entities SET scanner_present=false,${marker}`);
      const result = await syncDossier(db, graph);
      assert.equal(result.relationsSaved, 1); assert.equal(result.rulesSaved, 1); assert.equal(result.membershipsSaved, 1);
      assert.equal(result.appliedRelations?.length, 1);
    }
    const baseline = await sync(db, [receipt()]);
    assert.equal(baseline.relationsSaved, 0); assert.equal(baseline.rulesSaved, 0);
    assert.equal(baseline.referenceIssues.length, 3, "the existing world-intake scanner policy is unchanged");
    await db.query("UPDATE storyhold.world_entities SET classification_source='local',review_status='candidate'");
    await assert.rejects(syncDossier(db, graph), hasCode("ENTITY_GRAPH_CONTEXT_STALE"));
  } finally { await db.close(); }
});

test("dossier graph keeps temporal links separate and invokes category and meaning policies before promotion", async () => {
  const db = await database();
  try {
    const { graph } = await dossierFixture(db, { rules: [], relations: [relation({ status: "former" }), relation({ validFromLabel: "Book Two" })] });
    await assert.rejects(db.transaction((tx) => syncEntityVerifiedGraph(tx, dossierScope, graph, {
      ...policy, assertRelationSemantics: () => { throw new Error("meaning rejected"); },
    })), /meaning rejected/);
    const rejected = await db.transaction((tx) => syncEntityVerifiedGraph(tx, dossierScope, graph, { ...policy, canPassRelation: () => false }));
    assert.equal(rejected.referenceIssues.length, 2); assert.equal(rejected.relationsSaved, 0);
    assert.deepEqual(rejected.appliedRelations, []);
    const result = await syncDossier(db, graph);
    assert.equal(result.relationsSaved, 2); assert.equal(result.membershipsSaved, 0);
    assert.equal((await materialized(db)).relations.length, 2);
  } finally { await db.close(); }
});

test("dossier graph shares owner protection and exact conflicting-rule policy", async () => {
  const db = await database();
  try {
    await sync(db, [receipt()]);
    await db.query("UPDATE storyhold.world_entity_relations SET assignment_source='user'");
    await db.query("UPDATE storyhold.world_entity_faction_memberships SET assignment_source='user'");
    const { graph } = await dossierFixture(db, { rules: [rule({ effect: "Red light", description: "A contradictory new description." })] });
    const before = await materialized(db);
    const result = await syncDossier(db, graph);
    assert.equal(result.relationsSaved, 0); assert.equal(result.membershipsSaved, 0); assert.equal(result.rulesSaved, 0); assert.equal(result.linksCreated, 0);
    assert.deepEqual(result.appliedRelations, []);
    assert.equal(result.conflicts.length, 1); assert.match(result.conflicts[0]!.summary, /Blue light/); assert.match(result.conflicts[0]!.summary, /Red light/);
    assert.deepEqual(await materialized(db), before);
  } finally { await db.close(); }
});

test("dossier graph bundle, canon and provenance roll back together without losing the completed paid result", async () => {
  const db = await database();
  try {
    const { graph } = await dossierFixture(db, { saveBundle: false });
    await assert.rejects(db.transaction(async (tx) => {
      await saveEntityReviewVerificationBundle(tx, dossierScope, { version: 1, graph });
      await syncEntityVerifiedGraph(tx, dossierScope, graph, policy);
      throw new Error("billing transaction rolled back");
    }), /billing transaction rolled back/);
    const call = await readEntityReviewCall(db, dossierScope);
    assert.equal(call!.status, "completed"); assert.equal(call!.verification_snapshot, null);
    assert.equal(Object.values(await materialized(db)).reduce((sum, rows) => sum + rows.length, 0), 0);
    await db.transaction(async (tx) => {
      await saveEntityReviewVerificationBundle(tx, dossierScope, { version: 1, graph });
      await syncEntityVerifiedGraph(tx, dossierScope, graph, policy);
    });
    assert.equal((await materialized(db)).relationLinks.length, 1);
  } finally { await db.close(); }
});

async function pagedDossierFixture(db: PGlite, options: { count?: number; duplicate?: "verified" | "rejected" | "insufficient_evidence";
  relations?: boolean; saveBundle?: boolean } = {}) {
  await dossierDatabase(db);
  const count = options.count ?? 13;
  const input = dossierInput(options.relations ? { rules: [], relations: Array.from({ length: count }, (_, index) =>
    relation({ validFromLabel: `Period ${index + 1}` })) } : { relations: [], rules: Array.from({ length: count }, (_, index) =>
    rule({ name: `Singing Glow ${index + 1}` })) });
  input.graphReview.version = 2;
  const plan = prepareEntityReviewPages(input);
  const requests = plan.pages.map((page) => buildEntityGraphRequest(page.input)!);
  assert.ok(requests.length > 1);
  const duplicate = requests[1]!.proposals[0]!;
  const decision = (verdict: "verified" | "rejected" | "insufficient_evidence") => ({ verdict,
    explanation: verdict === "verified" ? "The supplied passage supports this claim." : "This passage does not establish this claim.",
    confidence: 0.8, supportingEvidence: verdict === "verified" ? [{ chunkId: uuid(20), quote: QUOTE }] : [],
    contradictingEvidence: [], retrievalRequests: [],
  });
  const raws = requests.map((request, index) => ({ relations: [], rules: [], entityRelations: [], entityRules: [], graphVerification: {
    requestFingerprint: request.fingerprint,
    newFindings: index === 0 && options.duplicate ? [{ kind: duplicate.kind, payload: duplicate.payload, ...decision("verified") }] : [],
    decisions: request.proposals.map((proposal) => ({ proposalId: proposal.id,
      ...decision(index === 1 && proposal.id === duplicate.id && options.duplicate ? options.duplicate : "verified") })),
  } }));
  const results: AiTextResult[] = raws.map((raw, index) => ({ text: JSON.stringify(raw), provider: "test-provider", model: `page-model-${index}`,
    reasoning: "high", usage: { inputUnits: 100, outputUnits: 50, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 0,
      estimatedCostMicros: 100, pricingKnown: true, pricingVersion: "test", costEstimated: false },
    runtime: { ...getAiRuntimeStatus("canon_review", "standard", "dossier"), provider: "test-provider", model: `page-model-${index}` },
  }));
  const saved = await executeJournaledEntityReviewPages(db, {
    scope: dossierScope, reservationId: null, contextSnapshot: JSON.parse(JSON.stringify({ version: 1, input })),
    pages: plan.pages.map((page, index) => ({ stepKey: page.stepKey, provider: results[index]!.provider, model: results[index]!.model,
      request: { task: "canon_review", stage: "dossier", reasoning: "high", maxOutputTokens: 2000, temperature: 0,
        system: "Verify the complete graph page.", messages: [{ role: "user", content: page.stepKey }],
        allowProviderFallback: false, providerFailurePolicy: "stop" },
    })),
    invoke: async (page: { stepKey: string }) => results[plan.pages.findIndex((entry) => entry.stepKey === page.stepKey)]!,
  });
  const graphs = saved.entityReviewPages.map((page, index) => validateEntityGraphReview(plan.pages[index]!.input,
    JSON.parse(page.result.text), { provider: page.result.provider, model: page.result.runtime.execution?.resolvedModel ?? page.result.model,
      completedAt: page.result.journalCompletedAt! })!);
  if (options.saveBundle !== false) await db.transaction((tx) => saveEntityReviewVerificationBundle(tx, dossierScope, { version: 2, graphs }));
  return { input, graphs, duplicate, plan, saved, raws };
}

test("v2 dossier graph writes every complete page under one paid review and reuses its exact provenance", async () => {
  const db = await database();
  try {
    const { graphs, plan } = await pagedDossierFixture(db, { count: 25 });
    assert.equal(graphs.length, 3);
    const result = await syncDossier(db, graphs);
    assert.equal(result.rulesSaved, 25); assert.equal(result.linksCreated, 25);
    const rows = await materialized(db);
    assert.equal(rows.rules.length, 25);
    assert.deepEqual(new Set(rows.ruleLinks.map((link) => link.step_key)), new Set(plan.pages.map((page) => page.stepKey)));
    assert.ok(rows.ruleLinks.every((link) => link.run_id === null && link.entity_review_id === dossierScope.reviewId));
    assert.ok(rows.rules.every((entry) => entry.source_analysis_run_id === null));
    assert.equal((await syncDossier(db, graphs)).linksCreated, 0);
    assert.equal((await db.query("SELECT * FROM storyhold.world_analysis_graph_reviews")).rows.length, 0);
  } finally { await db.close(); }
});

test("v2 dossier graph requires the complete ordered private page inventory before any canonical write", async () => {
  const db = await database();
  try {
    const { graphs } = await pagedDossierFixture(db);
    for (const invalid of [[graphs[0]!], [...graphs].reverse(), [graphs[0]!, graphs[0]!], [...graphs, graphs[0]!]]) {
      await assert.rejects(syncDossier(db, invalid), hasCode("GRAPH_RECEIPT_MISMATCH"));
    }
    assert.equal(Object.values(await materialized(db)).reduce((sum, rows) => sum + rows.length, 0), 0);
    assert.equal((await syncDossier(db, graphs)).rulesSaved, 13);
  } finally { await db.close(); }
});

test("v2 page-zero discovery cannot override a later rejection of the exact required rule candidate", async () => {
  const db = await database();
  try {
    const { graphs, duplicate } = await pagedDossierFixture(db, { duplicate: "rejected" });
    assert.equal(graphs[1]!.decisions.find((decision) => decision.proposalId === duplicate.id)!.verdict, "rejected");
    const result = await syncDossier(db, graphs);
    assert.equal(result.rulesSaved, 12); assert.equal(result.conflicts.length, 1);
    const rows = await materialized(db);
    assert.ok(rows.rules.every((entry) => entry.name !== duplicate.payload.name));
    assert.ok(rows.ruleLinks.every((link) => link.payload_fingerprint !== canonPayloadFingerprint(duplicate.payload)));
    assert.equal((await readEntityReviewCall(db, dossierScope))!.verification_snapshot!.version, 2);
  } finally { await db.close(); }
});

test("v2 conflicting relation verdicts are withheld from canon, memberships and applied display", async () => {
  const db = await database();
  try {
    const { graphs, duplicate } = await pagedDossierFixture(db, { duplicate: "insufficient_evidence", relations: true });
    const result = await syncDossier(db, graphs);
    assert.equal(result.relationsSaved, 12); assert.equal(result.conflicts.length, 1); assert.equal(result.membershipsSaved, 0);
    assert.ok(result.appliedRelations!.every((entry) => entry.validFromLabel !== duplicate.payload.validFromLabel));
    const rows = await materialized(db);
    assert.ok(rows.relationLinks.every((link) => link.payload_fingerprint !== canonPayloadFingerprint(duplicate.payload)));
  } finally { await db.close(); }
});

test("v2 duplicate discovery still requires the later candidate decision and all-verified agreement writes one rule", async () => {
  const db = await database();
  try {
    const { graphs, duplicate, plan, raws, saved } = await pagedDossierFixture(db, { duplicate: "verified" });
    assert.equal(graphs[1]!.decisions.find((decision) => decision.proposalId === duplicate.id)!.verdict, "verified");
    const missingLaterDecision = structuredClone(raws[1]!);
    missingLaterDecision.graphVerification.decisions = missingLaterDecision.graphVerification.decisions.filter((decision) => decision.proposalId !== duplicate.id);
    const later = saved.entityReviewPages[1]!.result;
    assert.throws(() => validateEntityGraphReview(plan.pages[1]!.input, missingLaterDecision, {
      provider: later.provider, model: later.runtime.execution?.resolvedModel ?? later.model, completedAt: later.journalCompletedAt!,
    }), /decision/);
    const result = await syncDossier(db, graphs);
    assert.equal(result.rulesSaved, 13); assert.equal(result.conflicts.length, 0);
    assert.equal((await materialized(db)).rules.filter((entry) => entry.name === duplicate.payload.name).length, 1);
  } finally { await db.close(); }
});

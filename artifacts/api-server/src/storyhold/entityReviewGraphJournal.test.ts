import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { canonPayloadFingerprint, type JsonObject } from "./analysisVerificationContracts";
import { AiGatewayUnavailableError, getAiRuntimeStatus, type AiBillableAttempt, type AiTextResult } from "./aiGateway";
import { buildEntityGraphRequest, validateEntityGraphReview } from "./entityGraphVerification";
import type { EntityReviewInput } from "./entityReview";
import {
  ensureEntityReviewGraphLinks, ensureEntityReviewJournal, EntityReviewJournalError,
  executeJournaledEntityReviewCall, finalizeEntityReviewCall, readEntityReviewCall,
  saveEntityReviewVerificationBundle, type EntityReviewCallScope, type EntityReviewVerificationBundle,
} from "./entityReviewJournal";
import { ensurePremiumGraphJournal } from "./premiumGraphJournal";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope: EntityReviewCallScope = { reviewId: uuid(1), playerId: uuid(2), worldId: uuid(3), editionId: uuid(4), entityId: uuid(5) };
const reservation = uuid(6), guild = uuid(7), chunk = uuid(8), source = uuid(9);
const quote = "Mira joined the Ash Guild. Mira can glow when she sings, casting blue light.";
const evidence = [{ chunkId: chunk, sourceId: source, quote }];
const model = "synthetic-dossier-model";
const hasCode = (code: string) => (error: unknown) => error instanceof EntityReviewJournalError && error.code === code;

function input(): EntityReviewInput {
  return {
    worldName: "A Test World", worldPremise: "A guild of singers.", worldGenre: "Fantasy", depth: "focused",
    premiumStatScope: { worldId: scope.worldId, editionId: scope.editionId, analysisRunId: scope.reviewId },
    entity: { id: scope.entityId, name: "Mira", entityType: "character", aliases: [], summary: "", details: [], relationships: [] },
    chunks: [{ id: chunk, sourceId: source, sourceTitle: "Manuscript", index: 0, content: quote }],
    knownEntities: [{ name: "Mira", entityType: "character", aliases: [] }, { name: "Ash Guild", entityType: "faction", aliases: [] }],
    graphReview: {
      version: 1,
      entities: [{ id: scope.entityId, name: "Mira", entityType: "character", aliases: [] }, { id: guild, name: "Ash Guild", entityType: "faction", aliases: [] }],
      relations: [{ subject: "Mira", relationType: "member_of", target: "Ash Guild", status: "active", summary: "Mira is a guild member.",
        validFromLabel: "", validUntilLabel: "", evidence, confidence: 0.9 }],
      rules: [{ entity: "Mira", name: "Singing Glow", description: "Mira glows when she sings.", ruleKind: "ability",
        trigger: "Mira sings", effect: "Blue light", evidence, confidence: 0.9 }],
    },
  };
}

function response(reviewInput = input(), verdict: "verified" | "rejected" = "verified") {
  const request = buildEntityGraphRequest(reviewInput)!;
  return {
    summary: "Mira sings for the Ash Guild.", relations: [], rules: [], entityRelations: [], entityRules: [],
    graphVerification: { requestFingerprint: request.fingerprint, newFindings: [], decisions: request.proposals.map((proposal) => ({
      proposalId: proposal.id, verdict, explanation: "The supplied passage states this.", confidence: 0.9,
      supportingEvidence: verdict === "verified" ? [{ chunkId: chunk, quote }] : [], contradictingEvidence: [], retrievalRequests: [],
    })) },
  };
}

function result(text = JSON.stringify(response())): AiTextResult {
  return {
    text, provider: "openrouter", model, reasoning: "high",
    usage: { inputUnits: 1000, outputUnits: 100, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 0,
      estimatedCostMicros: 1500, pricingKnown: true, pricingVersion: "fixture", costEstimated: false },
    runtime: { ...getAiRuntimeStatus("canon_review", "standard", "dossier"), configured: true, mode: "connected",
      provider: "openrouter", model, stage: "dossier", billable: true, sendsSourceTextOffDevice: true,
      execution: { connectionId: "managed:openrouter", credentialSource: "environment", connectionSource: "storyhold_managed",
        billingSource: "storyhold_credits", requestedModel: model, resolvedModel: "resolved-fixture", upstreamProvider: "fixture", privacyMode: "zero-data-retention" } },
  };
}

function proof(completed: AiTextResult, raw: unknown = response(), reviewInput = input()): EntityReviewVerificationBundle {
  return { version: 1, graph: validateEntityGraphReview(reviewInput, raw, {
    provider: completed.provider, model: completed.runtime.execution!.resolvedModel!, completedAt: completed.journalCompletedAt!,
  })! };
}

async function database() {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.players (id uuid PRIMARY KEY, role text NOT NULL DEFAULT 'player');
    CREATE TABLE storyhold.world_entities (id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL);
    CREATE TABLE storyhold.world_analysis_runs (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.world_entity_relations (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.world_entity_rules (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.credit_reservations (id uuid PRIMARY KEY, player_id uuid NOT NULL, world_id uuid NOT NULL,
      operation text NOT NULL, request_id text NOT NULL, status text DEFAULT 'reserved', reserved_credits integer DEFAULT 30, usage jsonb DEFAULT '{}');`);
  await ensureEntityReviewJournal(db);
  await ensurePremiumGraphJournal(db);
  await db.query("INSERT INTO storyhold.players (id) VALUES ($1)", [scope.playerId]);
  await db.query("INSERT INTO storyhold.world_entities VALUES ($1, $2, $3)", [scope.entityId, scope.worldId, scope.editionId]);
  await db.query("INSERT INTO storyhold.credit_reservations (id, player_id, world_id, operation, request_id) VALUES ($1, $2, $3, 'entity_review', $4)",
    [reservation, scope.playerId, scope.worldId, scope.reviewId]);
  return db;
}

function dispatch(db: PGlite, overrides: Partial<Parameters<typeof executeJournaledEntityReviewCall>[1]> = {}) {
  return executeJournaledEntityReviewCall(db, {
    scope, reservationId: reservation, contextSnapshot: { input: input() } as unknown as JsonObject,
    request: { task: "canon_review", stage: "dossier", system: "Review supplied evidence.", messages: [{ role: "user", content: quote }],
      allowProviderFallback: false, providerFailurePolicy: "stop" },
    provider: "openrouter", model, invoke: async () => result(), ...overrides,
  });
}
const save = (db: PGlite, bundle: EntityReviewVerificationBundle) => db.transaction((tx) => saveEntityReviewVerificationBundle(tx, scope, bundle));

test("private dossier graph proof is exact, immutable, replayable, and absent from public finalization", async () => {
  const db = await database();
  try {
    const completed = await dispatch(db);
    const bundle = proof(completed);
    assert.deepEqual(await save(db, bundle), bundle);
    assert.deepEqual(await save(db, structuredClone(bundle)), bundle);
    const row = await readEntityReviewCall(db, scope);
    assert.deepEqual(row?.verification_snapshot, bundle);
    assert.equal(row?.verification_fingerprint, canonPayloadFingerprint(bundle as unknown as JsonObject));
    const publicResult = { reviewed: true, entityId: scope.entityId };
    await db.transaction((tx) => finalizeEntityReviewCall(tx, scope, publicResult));
    assert.deepEqual((await readEntityReviewCall(db, scope))?.finalization_snapshot, publicResult);
    assert.deepEqual(await save(db, structuredClone(bundle)), bundle);
    await assert.rejects(db.query("UPDATE storyhold.entity_review_ai_calls SET verification_snapshot = NULL, verification_fingerprint = NULL"), /immutable/);
    await assert.rejects(db.query("UPDATE storyhold.entity_review_ai_calls SET verification_fingerprint = 'changed'"), /immutable/);
  } finally { await db.close(); }
});

test("journal proof cannot substitute another valid receipt or different actual verifier", async () => {
  const db = await database();
  try {
    const completed = await dispatch(db);
    const alternate = proof(completed, response(input(), "rejected"));
    await assert.rejects(save(db, alternate), hasCode("VERIFICATION_INVALID"));
    const otherModel = proof({ ...completed, runtime: { ...completed.runtime, execution: { ...completed.runtime.execution!, resolvedModel: "other-model" } } });
    await assert.rejects(save(db, otherModel), hasCode("VERIFICATION_INVALID"));
    const otherTime = proof({ ...completed, journalCompletedAt: "2026-09-01T00:00:00.000Z" });
    await assert.rejects(save(db, otherTime), hasCode("VERIFICATION_INVALID"));
    const otherInput = input(); otherInput.userGuidance = "Use the owner's revised direction.";
    await assert.rejects(save(db, proof(completed, response(otherInput), otherInput)), hasCode("VERIFICATION_INVALID"));
    await assert.rejects(save(db, { ...proof(completed), unexpected: true } as EntityReviewVerificationBundle), hasCode("VERIFICATION_INVALID"));
    assert.equal((await readEntityReviewCall(db, scope))?.verification_snapshot, null);
    await assert.rejects(db.transaction((tx) => saveEntityReviewVerificationBundle(tx, { ...scope, playerId: uuid(99) }, proof(completed))), hasCode("SCOPE_MISMATCH"));
  } finally { await db.close(); }
});

test("saved fenced JSON reconstructs through the same parser as dossier review", async () => {
  const db = await database();
  try {
    const completed = await dispatch(db, { invoke: async () => result(`\`\`\`json\n${JSON.stringify(response())}\n\`\`\``) });
    assert.deepEqual(await save(db, proof(completed)), proof(completed));
  } finally { await db.close(); }
});

test("journal reads reject tampered proof fingerprints and self-consistent substituted receipts", async () => {
  const db = await database();
  try {
    const completed = await dispatch(db);
    await save(db, proof(completed));
    await db.exec("ALTER TABLE storyhold.entity_review_ai_calls DISABLE TRIGGER entity_review_call_guard");
    await db.query("UPDATE storyhold.entity_review_ai_calls SET verification_fingerprint = 'tampered'");
    await assert.rejects(readEntityReviewCall(db, scope), hasCode("JOURNAL_INTEGRITY"));
    const alternate = proof(completed, response(input(), "rejected"));
    await db.query("UPDATE storyhold.entity_review_ai_calls SET verification_snapshot = $1::jsonb, verification_fingerprint = $2",
      [JSON.stringify(alternate), canonPayloadFingerprint(alternate as unknown as JsonObject)]);
    await assert.rejects(readEntityReviewCall(db, scope), hasCode("JOURNAL_INTEGRITY"));
  } finally { await db.close(); }
});

test("legacy null proof stays readable and finalized reviews cannot gain a later proof", async () => {
  const db = await database();
  try {
    const completed = await dispatch(db);
    await ensureEntityReviewJournal(db);
    assert.equal((await readEntityReviewCall(db, scope))?.verification_snapshot, null);
    await db.transaction((tx) => finalizeEntityReviewCall(tx, scope, { reviewed: false }));
    await assert.rejects(save(db, proof(completed)), hasCode("REVIEW_FINALIZED"));
    await assert.rejects(db.query("UPDATE storyhold.entity_review_ai_calls SET verification_snapshot = '{}'::jsonb, verification_fingerprint = 'later'"), /after finalization/);
    assert.equal((await readEntityReviewCall(db, scope))?.verification_fingerprint, null);
  } finally { await db.close(); }
});

test("legacy input without the frozen graph contract cannot acquire a modern receipt", async () => {
  const db = await database();
  try {
    const legacy = input(); delete legacy.graphReview;
    const completed = await dispatch(db, { contextSnapshot: { input: legacy } as unknown as JsonObject });
    await assert.rejects(save(db, proof(completed)), hasCode("VERIFICATION_INVALID"));
    assert.equal((await readEntityReviewCall(db, scope))?.verification_snapshot, null);
  } finally { await db.close(); }
});

for (const uncertain of [true, false]) {
  test(`${uncertain ? "uncertain" : "rejected"} dossier outcomes cannot save a private graph proof`, async () => {
    const db = await database();
    try {
      const value = result();
      const attempt: AiBillableAttempt = { provider: value.provider, model, resolvedModel: "resolved-fixture", upstreamProvider: "fixture",
        stage: "dossier", reasoning: "high", usage: value.usage };
      await assert.rejects(dispatch(db, { invoke: async () => { throw new AiGatewayUnavailableError("Failure", ["one"], [attempt], uncertain); } }));
      const bundle = proof({ ...value, journalCompletedAt: "2026-09-03T12:00:00.000Z" });
      await assert.rejects(save(db, bundle), hasCode(uncertain ? "OUTCOME_UNRESOLVED" : "VERIFICATION_INVALID"));
      assert.equal((await readEntityReviewCall(db, scope))?.verification_snapshot, null);
    } finally { await db.close(); }
  });
}

test("graph link migration preserves world history, is idempotent, and requires exactly one valid provenance source", async () => {
  const db = await database();
  try {
    await dispatch(db);
    const worldRun = uuid(60), relationId = uuid(61), ruleId = uuid(62);
    await db.query("INSERT INTO storyhold.world_analysis_runs VALUES ($1)", [worldRun]);
    await db.query("INSERT INTO storyhold.world_entity_relations (id) VALUES ($1)", [relationId]);
    await db.query("INSERT INTO storyhold.world_entity_rules (id) VALUES ($1)", [ruleId]);
    await db.query(`INSERT INTO storyhold.world_analysis_graph_reviews
      (run_id, world_id, edition_id, step_key, receipt_fingerprint, snapshot_fingerprint, snapshot)
      VALUES ($1, $2, $3, 'old_step', 'historical', 'historical', '{}')`, [worldRun, scope.worldId, scope.editionId]);
    for (const [table, column, id] of [
      ["world_entity_relation_verifications", "relation_id", relationId],
      ["world_entity_rule_verifications", "rule_id", ruleId],
    ]) {
      await db.query(`INSERT INTO storyhold.${table} (${column}, run_id, step_key, proposal_id, decision_id, payload_fingerprint)
        VALUES ($1, $2, 'old_step', 'old_proposal', 'old_decision', 'old_payload')`, [id, worldRun]);
    }
    await ensureEntityReviewGraphLinks(db);
    await ensureEntityReviewGraphLinks(db);
    // Running the existing initializer again must not restore the old primary
    // key or damage either lineage after the migration.
    await ensurePremiumGraphJournal(db);
    await ensureEntityReviewGraphLinks(db);
    for (const [table, column, id] of [
      ["world_entity_relation_verifications", "relation_id", relationId],
      ["world_entity_rule_verifications", "rule_id", ruleId],
    ]) {
      const old = (await db.query<Record<string, unknown>>(`SELECT * FROM storyhold.${table}`)).rows[0]!;
      assert.equal(old.run_id, worldRun); assert.equal(old.entity_review_id, null);
      assert.equal(old.payload_fingerprint, "old_payload");
      const insert = `INSERT INTO storyhold.${table} (${column}, run_id, entity_review_id, step_key, proposal_id, decision_id, payload_fingerprint)
        VALUES ($1, $2, $3, $4, $5, 'decision', 'payload')`;
      await db.query(insert, [id, null, scope.reviewId, "dossier_graph:0", "new_proposal"]);
      await assert.rejects(db.query(insert, [id, null, null, "step", "neither"]), /exclusive_source/);
      await assert.rejects(db.query(insert, [id, worldRun, scope.reviewId, "old_step", "both"]), /exclusive_source/);
      await assert.rejects(db.query(insert, [id, null, uuid(99), "step", "missing_review"]), /foreign key/);
      await assert.rejects(db.query(insert, [id, uuid(98), null, "step", "missing_world"]), /foreign key/);
      await assert.rejects(db.query(insert, [id, null, scope.reviewId, "dossier_graph:0", "new_proposal"]), /duplicate key/);
      await assert.rejects(db.query(insert, [id, worldRun, null, "old_step", "old_proposal"]), /duplicate key/);
      await assert.rejects(db.query(`UPDATE storyhold.${table} SET decision_id = 'tampered'`), /immutable/);
      assert.equal((await db.query(`SELECT * FROM storyhold.${table}`)).rows.length, 2);
    }
  } finally { await db.close(); }
});

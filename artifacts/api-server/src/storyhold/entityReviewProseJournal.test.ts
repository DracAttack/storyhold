import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { canonPayloadFingerprint, type JsonObject } from "./analysisVerificationContracts";
import { getAiRuntimeStatus, type AiTextResult, type StoryholdProviderId } from "./aiGateway";
import { buildEntityGraphRequest, validateEntityGraphReview } from "./entityGraphVerification";
import { buildEntityProseRequest, validateEntityProseReview } from "./entityProseVerification";
import { prepareEntityReviewPages } from "./entityReviewPages";
import type { EntityReviewInput } from "./entityReview";
import { ensureEntityReviewJournal, EntityReviewJournalError, executeJournaledEntityReviewPages,
  finalizeEntityReviewCall, readEntityReviewCall, saveEntityReviewVerificationBundle,
  type EntityReviewCallScope, type EntityReviewVerificationBundle } from "./entityReviewJournal";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope: EntityReviewCallScope = { reviewId: uuid(1), playerId: uuid(2), worldId: uuid(3), editionId: uuid(4), entityId: uuid(5) };
const reservationId = uuid(6), chunkId = uuid(7), sourceId = uuid(8), model = "synthetic-prose-review-model";
const guilds = Array.from({ length: 13 }, (_, index) => ({ id: uuid(100 + index), name: `Guild ${index}`, entityType: "faction", aliases: [] }));
const quote = `Mira shelters fugitives. Mira gives them a place to hide. ${guilds.map((guild) => `Mira joined ${guild.name}.`).join(" ")}`;
const code = (name: string) => (error: unknown) => error instanceof EntityReviewJournalError && error.code === name;
const hash = (value: unknown) => canonPayloadFingerprint(value as JsonObject);

function input(prose = true): EntityReviewInput {
  return { worldName: "A Test World", worldPremise: "A network of guilds.", worldGenre: "Fantasy", depth: "focused",
    premiumStatScope: { worldId: scope.worldId, editionId: scope.editionId, analysisRunId: scope.reviewId },
    ...(prose ? { proseReview: { version: 1 as const } } : {}),
    entity: { id: scope.entityId, name: "Mira", entityType: "character", aliases: [], summary: "", details: [], relationships: [] },
    chunks: [{ id: chunkId, sourceId, sourceTitle: "Manuscript", index: 0, content: quote }],
    knownEntities: [{ name: "Mira", entityType: "character", aliases: [] }, ...guilds],
    graphReview: { version: 2, entities: [{ id: scope.entityId, name: "Mira", entityType: "character", aliases: [] }, ...guilds],
      relations: guilds.map((guild) => ({ subject: "Mira", relationType: "member_of", target: guild.name, status: "active",
        summary: `Mira is a member of ${guild.name}.`, validFromLabel: "", validUntilLabel: "",
        evidence: [{ chunkId, sourceId, quote }], confidence: 0.9 })), rules: [] } };
}
function proseResponse(reviewInput = input(), value = "Mira shelters fugitives.") {
  const request = buildEntityProseRequest(reviewInput)!;
  return { claims: [], character: null,
    claimVerification: { requestFingerprint: request.fingerprint, decisions: [], newClaims: [
      { predicate: "dossier.summary", value }, { predicate: "dossier.details", value: "Mira gives them a place to hide." },
    ].map((claim) => ({
      claim: { subject: "Mira", ...claim, polarity: "positive", epistemicHolder: "", truthStatus: "fact", validFromLabel: "", validUntilLabel: "" },
      verdict: "verified", explanation: "The supplied manuscript states this.", confidence: 0.9,
      supportingEvidence: [{ chunkId, quote }], contradictingEvidence: [], retrievalRequests: [],
    })) }, prosePresentation: { displayOrder: [0, 1] } };
}
function rawGraph(reviewInput: EntityReviewInput) {
  const request = buildEntityGraphRequest(reviewInput)!;
  return { relations: [], rules: [], entityRelations: [], entityRules: [],
    graphVerification: { requestFingerprint: request.fingerprint, newFindings: [], decisions: request.proposals.map((proposal) => ({
      proposalId: proposal.id, verdict: "verified", explanation: "The supplied passage explicitly records this membership.", confidence: 0.9,
      supportingEvidence: [{ chunkId, quote }], contradictingEvidence: [], retrievalRequests: [],
    })) } };
}
function result(raw: unknown, index: number): AiTextResult {
  return { text: JSON.stringify(raw), provider: "openrouter", model, reasoning: "high",
    usage: { inputUnits: 1000, outputUnits: 100, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 0,
      estimatedCostMicros: 1500, pricingKnown: true, pricingVersion: "fixture", costEstimated: false },
    runtime: { ...getAiRuntimeStatus("canon_review", "standard", "dossier"), configured: true, mode: "connected", provider: "openrouter", model,
      stage: "dossier", billable: true, sendsSourceTextOffDevice: true,
      execution: { connectionId: "managed:openrouter", credentialSource: "environment", connectionSource: "storyhold_managed",
        billingSource: "storyhold_credits", requestedModel: model, resolvedModel: `resolved-page-${index}`, upstreamProvider: "fixture", privacyMode: "zero-data-retention" } } };
}
function verifier(result: AiTextResult): { provider: StoryholdProviderId; model: string; completedAt: string } {
  return { provider: result.provider, model: result.runtime.execution!.resolvedModel!, completedAt: result.journalCompletedAt! };
}
async function fixture(prose = true, alter?: (raw: Record<string, unknown>, index: number) => void) {
  const db = new PGlite();
  try {
  await db.exec(`CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.players (id uuid PRIMARY KEY, role text NOT NULL DEFAULT 'player');
    CREATE TABLE storyhold.world_entities (id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL);
    CREATE TABLE storyhold.credit_reservations (id uuid PRIMARY KEY, player_id uuid NOT NULL, world_id uuid NOT NULL,
      operation text NOT NULL, request_id text NOT NULL, status text DEFAULT 'reserved', reserved_credits integer DEFAULT 30, usage jsonb DEFAULT '{}');`);
  await ensureEntityReviewJournal(db);
  await db.query("INSERT INTO storyhold.players (id) VALUES ($1)", [scope.playerId]);
  await db.query("INSERT INTO storyhold.world_entities VALUES ($1,$2,$3)", [scope.entityId, scope.worldId, scope.editionId]);
  await db.query("INSERT INTO storyhold.credit_reservations (id,player_id,world_id,operation,request_id) VALUES ($1,$2,$3,'entity_review',$4)",
    [reservationId, scope.playerId, scope.worldId, scope.reviewId]);
  const reviewInput = input(prose); const plan = prepareEntityReviewPages(reviewInput);
  assert.equal(plan.pages.length, 2);
  const raws = plan.pages.map((page, index): Record<string, unknown> => {
    const raw = { ...rawGraph(page.input), ...(index === 0 && prose ? proseResponse(reviewInput) : {}) };
    alter?.(raw, index); return raw;
  });
  let calls = 0;
  const completed = await executeJournaledEntityReviewPages(db, { scope, reservationId, contextSnapshot: { version: 1, input: reviewInput } as unknown as JsonObject,
    pages: plan.pages.map((page) => ({ stepKey: page.stepKey, provider: "openrouter", model,
      request: { task: "canon_review", stage: "dossier", system: "Review exact supplied claims and graph candidates.",
        messages: [{ role: "user", content: `Page ${page.index}: ${quote}` }], allowProviderFallback: false, providerFailurePolicy: "stop" } })),
    invoke: async (_page, index) => { calls++; return result(raws[index], index); } });
  const graphs = plan.pages.map((page, index) => validateEntityGraphReview(page.input, raws[index], verifier(completed.entityReviewPages[index]!.result))!);
  const first = completed.entityReviewPages[0]!.result;
  const proof = (raw: unknown = raws[0], usedInput = reviewInput, provenance = verifier(first)) => validateEntityProseReview(usedInput, raw, provenance)!;
  const save = (bundle: EntityReviewVerificationBundle) => db.transaction((tx) => saveEntityReviewVerificationBundle(tx, scope, bundle));
  return { db, reviewInput, plan, raws, completed, graphs, proof, save, calls: () => calls };
  } catch (error) { await db.close(); throw error; }
}

test("first paid page supplies the immutable private prose proof without another call or public leakage", async () => {
  const f = await fixture();
  try {
    const bundle: EntityReviewVerificationBundle = { version: 3, graphs: f.graphs, prose: f.proof() };
    assert.deepEqual(await f.save(bundle), bundle); assert.deepEqual(await f.save(structuredClone(bundle)), bundle);
    assert.equal(f.calls(), 2); assert.equal(f.completed.runtime.execution?.resolvedModel, "resolved-page-1");
    assert.deepEqual((await readEntityReviewCall(f.db, scope))?.verification_snapshot, bundle);
    const publicResult = { reviewed: true, entityId: scope.entityId };
    await f.db.transaction((tx) => finalizeEntityReviewCall(tx, scope, publicResult));
    assert.deepEqual((await readEntityReviewCall(f.db, scope))?.finalization_snapshot, publicResult);
    assert.deepEqual(await f.save(bundle), bundle);
    await assert.rejects(f.db.query("UPDATE storyhold.entity_review_ai_calls SET verification_snapshot=NULL,verification_fingerprint=NULL"), /immutable/);
  } finally { await f.db.close(); }
});

test("prose-required review cannot downgrade to a graph-only proof or omit/reorder proof coverage", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.save({ version: 2, graphs: f.graphs }), code("VERIFICATION_INVALID"));
    await assert.rejects(f.save({ version: 3, graphs: f.graphs } as EntityReviewVerificationBundle), code("VERIFICATION_INVALID"));
    await assert.rejects(f.save({ version: 3, graphs: f.graphs.slice(0, 1), prose: f.proof() }), code("VERIFICATION_INVALID"));
    await assert.rejects(f.save({ version: 3, graphs: [...f.graphs].reverse(), prose: f.proof() }), code("VERIFICATION_INVALID"));
    const reversedProse = { ...f.raws[0], prosePresentation: { displayOrder: [1, 0] } };
    await assert.rejects(f.save({ version: 3, graphs: f.graphs, prose: f.proof(reversedProse) }), code("VERIFICATION_INVALID"));
    await assert.rejects(f.save({ version: 3, graphs: f.graphs, prose: f.proof(), extra: true } as EntityReviewVerificationBundle), code("VERIFICATION_INVALID"));
    assert.equal((await readEntityReviewCall(f.db, scope))?.verification_snapshot, null);
  } finally { await f.db.close(); }
});

test("prose proof rejects other page provenance, forged time, or changed owner direction", async () => {
  const f = await fixture();
  try {
    const first = verifier(f.completed.entityReviewPages[0]!.result);
    for (const provenance of [verifier(f.completed.entityReviewPages[1]!.result), { ...first, provider: "anthropic" as StoryholdProviderId },
      { ...first, model: "other-model" }, { ...first, completedAt: "2026-01-01T00:00:00.000Z" }]) {
      await assert.rejects(f.save({ version: 3, graphs: f.graphs, prose: f.proof(f.raws[0], f.reviewInput, provenance) }), code("VERIFICATION_INVALID"));
    }
    const changed = { ...f.reviewInput, userGuidance: "Follow the revised owner's instructions." };
    const alternate = { ...f.raws[0], ...proseResponse(changed) };
    await assert.rejects(f.save({ version: 3, graphs: f.graphs, prose: f.proof(alternate, changed) }), code("VERIFICATION_INVALID"));
  } finally { await f.db.close(); }
});

test("a valid alternate prose interpretation cannot substitute for the actual paid response", async () => {
  const f = await fixture();
  try {
    const alternative = { ...f.raws[0], ...proseResponse(f.reviewInput, "Mira gives fugitives a place to hide.") };
    const substituted = { version: 3 as const, graphs: f.graphs, prose: f.proof(alternative) };
    await assert.rejects(f.save(substituted), code("VERIFICATION_INVALID"));
    await f.save({ version: 3, graphs: f.graphs, prose: f.proof() });
    await f.db.exec("ALTER TABLE storyhold.entity_review_ai_calls DISABLE TRIGGER entity_review_call_guard");
    await f.db.query("UPDATE storyhold.entity_review_ai_calls SET verification_snapshot=$1::jsonb,verification_fingerprint=$2", [JSON.stringify(substituted), hash(substituted)]);
    await assert.rejects(readEntityReviewCall(f.db, scope), code("JOURNAL_INTEGRITY"));
  } finally { await f.db.close(); }
});

test("legacy paged response keeps its graph-only proof and cannot acquire a prose contract afterward", async () => {
  const f = await fixture(false);
  try {
    const modernInput = { ...f.reviewInput, proseReview: { version: 1 as const } };
    const forged = f.proof(proseResponse(modernInput), modernInput);
    await assert.rejects(f.save({ version: 3, graphs: f.graphs, prose: forged }), code("VERIFICATION_INVALID"));
    const legacy = { version: 2 as const, graphs: f.graphs };
    assert.deepEqual(await f.save(legacy), legacy); await ensureEntityReviewJournal(f.db);
    assert.deepEqual((await readEntityReviewCall(f.db, scope))?.verification_snapshot, legacy);
  } finally { await f.db.close(); }
});

test("unchecked raw prose in a saved response cannot bypass the claim proof at persistence", async () => {
  const f = await fixture(true, (raw, index) => { if (index === 0) raw.summary = "Mira commands an invisible dragon army."; });
  try {
    const clean = { ...f.raws[0], summary: "" };
    const proof = f.proof(clean);
    await assert.rejects(f.save({ version: 3, graphs: f.graphs, prose: proof }), code("VERIFICATION_INVALID"));
    assert.equal((await readEntityReviewCall(f.db, scope))?.verification_snapshot, null);
  } finally { await f.db.close(); }
});

test("prose on a later paid page cannot repair missing proof on the first paid page", async () => {
  const f = await fixture(true, (raw, index) => {
    if (index === 0) { delete raw.claimVerification; delete raw.prosePresentation; }
    else { Object.assign(raw, proseResponse()); delete raw.claims; }
  });
  try {
    const validFirstClaim = { ...f.raws[0], ...proseResponse(f.reviewInput) };
    await assert.rejects(f.save({ version: 3, graphs: f.graphs, prose: f.proof(validFirstClaim) }), code("VERIFICATION_INVALID"));
  } finally { await f.db.close(); }
});

test("completed prose review cannot acquire its proof only after public finalization", async () => {
  const f = await fixture();
  try {
    await f.db.transaction((tx) => finalizeEntityReviewCall(tx, scope, { reviewed: false }));
    await assert.rejects(f.save({ version: 3, graphs: f.graphs, prose: f.proof() }), code("REVIEW_FINALIZED"));
    assert.equal((await readEntityReviewCall(f.db, scope))?.verification_snapshot, null);
  } finally { await f.db.close(); }
});

test("successful modern finalization cannot bypass missing graph and prose verification", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.db.transaction((tx) => finalizeEntityReviewCall(tx, scope, { reviewed: true, entityId: scope.entityId })), code("VERIFICATION_REQUIRED"));
    assert.equal((await readEntityReviewCall(f.db, scope))?.finalization_snapshot, null);
    await f.save({ version: 3, graphs: f.graphs, prose: f.proof() });
    await f.db.transaction((tx) => finalizeEntityReviewCall(tx, scope, { reviewed: true, entityId: scope.entityId }));
    assert.equal((await readEntityReviewCall(f.db, scope))?.finalization_snapshot?.reviewed, true);
  } finally { await f.db.close(); }
});

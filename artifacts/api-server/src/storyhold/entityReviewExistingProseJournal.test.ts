import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { canonPayloadFingerprint, type JsonObject } from "./analysisVerificationContracts";
import { getAiRuntimeStatus, type AiTextResult } from "./aiGateway";
import { buildEntityGraphRequest, validateEntityGraphReview } from "./entityGraphVerification";
import { buildEntityProseRequest, validateEntityProseReview } from "./entityProseVerification";
import { buildExistingProseInventory, prepareEntityExistingProsePages, validateEntityExistingProseReview } from "./entityExistingProseReview";
import { prepareEntityReviewPages } from "./entityReviewPages";
import type { EntityReviewInput } from "./entityReview";
import { ensureEntityReviewJournal, EntityReviewJournalError, executeJournaledEntityReviewCall, executeJournaledEntityReviewPages,
  finalizeEntityReviewCall, readEntityReviewCall, readEntityReviewPageProgress, saveEntityReviewVerificationBundle,
  type EntityReviewCallScope, type EntityReviewJournalPage, type EntityReviewVerificationBundle, type PagedEntityReviewResult } from "./entityReviewJournal";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope: EntityReviewCallScope = { reviewId: uuid(1), playerId: uuid(2), worldId: uuid(3), editionId: uuid(4), entityId: uuid(5) };
const reservationId = uuid(6), chunkId = uuid(7), sourceId = uuid(8), model = "offline-existing-prose-model";
const guilds = Array.from({ length: 13 }, (_, index) => ({ id: uuid(100 + index), name: `Guild ${index}`, entityType: "faction", aliases: [] }));
const quote = `Mira shelters fugitives. ${guilds.map((guild) => `Mira joined ${guild.name}.`).join(" ")}`;
const code = (name: string) => (error: unknown) => error instanceof EntityReviewJournalError && error.code === name;
const hash = (value: unknown) => canonPayloadFingerprint(value as JsonObject);

function input(itemCount: number | null = 11): EntityReviewInput {
  const details = Array.from({ length: itemCount ?? 0 }, (_, index) => `Mira's earlier adventure ${index} has not yet been established.`);
  return { worldName: "A Test World", worldPremise: "A network of guilds.", worldGenre: "Fantasy", depth: "focused",
    premiumStatScope: { worldId: scope.worldId, editionId: scope.editionId, analysisRunId: scope.reviewId },
    proseReview: { version: 1 },
    ...(itemCount === null ? {} : { existingProseReview: buildExistingProseInventory({ details }) }),
    entity: { id: scope.entityId, name: "Mira", entityType: "character", aliases: [], summary: "", details, relationships: [] },
    chunks: [{ id: chunkId, sourceId, sourceTitle: "Manuscript", index: 0, content: quote }],
    knownEntities: [{ name: "Mira", entityType: "character", aliases: [] }, ...guilds],
    graphReview: { version: 2, entities: [{ id: scope.entityId, name: "Mira", entityType: "character", aliases: [] }, ...guilds],
      relations: guilds.map((guild) => ({ subject: "Mira", relationType: "member_of", target: guild.name, status: "active",
        summary: `Mira is a member of ${guild.name}.`, validFromLabel: "", validUntilLabel: "",
        evidence: [{ chunkId, sourceId, quote }], confidence: 0.9 })), rules: [] } };
}
function graphRaw(reviewInput: EntityReviewInput, first = false) {
  const request = buildEntityGraphRequest(reviewInput)!;
  return { relations: [], rules: [], entityRelations: [], entityRules: [],
    graphVerification: { requestFingerprint: request.fingerprint, newFindings: [], decisions: request.proposals.map((proposal) => ({
      proposalId: proposal.id, verdict: "verified", explanation: "The manuscript records this membership.", confidence: 0.9,
      supportingEvidence: [{ chunkId, quote }], contradictingEvidence: [], retrievalRequests: [],
    })) }, ...(first ? { claims: [], character: null,
      claimVerification: { requestFingerprint: buildEntityProseRequest(reviewInput)!.fingerprint, decisions: [], newClaims: [{
        claim: { subject: "Mira", predicate: "dossier.summary", value: "Mira shelters fugitives.", polarity: "positive", epistemicHolder: "",
          truthStatus: "fact", validFromLabel: "", validUntilLabel: "" },
        verdict: "verified", explanation: "The manuscript states this.", confidence: 0.9,
        supportingEvidence: [{ chunkId, quote }], contradictingEvidence: [], retrievalRequests: [],
      }] }, prosePresentation: { displayOrder: [0] } } : {}) };
}
function result(raw: unknown, index: number): AiTextResult {
  return { text: JSON.stringify(raw), provider: "openrouter", model, reasoning: "high",
    usage: { inputUnits: 1000 + index, outputUnits: 100, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 0,
      estimatedCostMicros: 1500 + index, pricingKnown: true, pricingVersion: "fixture", costEstimated: false },
    runtime: { ...getAiRuntimeStatus("canon_review", "standard", "dossier"), configured: true, mode: "connected", provider: "openrouter", model,
      stage: "dossier", billable: true, sendsSourceTextOffDevice: true,
      execution: { connectionId: "managed:openrouter", credentialSource: "environment", connectionSource: "storyhold_managed",
        billingSource: "storyhold_credits", requestedModel: model, resolvedModel: `resolved-page-${index}`, upstreamProvider: "fixture", privacyMode: "zero-data-retention" } } };
}
function provenance(result: AiTextResult) {
  return { provider: result.provider, model: result.runtime.execution!.resolvedModel!, completedAt: result.journalCompletedAt! };
}
async function fixture(itemCount: number | null = 11) {
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
    const reviewInput = input(itemCount), graphPlan = prepareEntityReviewPages(reviewInput), auditPlan = prepareEntityExistingProsePages(reviewInput);
    assert.equal(graphPlan.pages.length, 2);
    const raws: Record<string, unknown>[] = [
      ...graphPlan.pages.map((page, index) => graphRaw(page.input, index === 0)),
      ...auditPlan.map((page) => ({ existingProseVerification: { requestFingerprint: page.requestFingerprint, decisions: page.items.map((item) => ({
        itemId: item.itemId, verdict: "needs_more_evidence", explanation: "The supplied excerpt does not establish this earlier adventure.",
        confidence: 0.4, supportingEvidence: [], contradictingEvidence: [], retrievalRequests: ["Find the passage describing this earlier adventure."],
      })) } })),
    ];
    const pages: EntityReviewJournalPage[] = [...graphPlan.pages, ...auditPlan].map((page) => ({ stepKey: page.stepKey, provider: "openrouter", model,
      request: { task: "canon_review", stage: "dossier", system: "Review only the exact supplied page.",
        messages: [{ role: "user", content: `${page.stepKey}: ${quote}` }], allowProviderFallback: false, providerFailurePolicy: "stop" } }));
    const contextSnapshot = { version: 1, input: reviewInput } as unknown as JsonObject;
    const calls: number[] = [];
    const invoke = async (_page: EntityReviewJournalPage, index: number) => { calls.push(index); return result(raws[index], index); };
    const run = (options: Partial<Parameters<typeof executeJournaledEntityReviewPages>[1]> = {}) => executeJournaledEntityReviewPages(db,
      { scope, reservationId, contextSnapshot, pages, invoke, ...options });
    function bundle(completed: PagedEntityReviewResult): Extract<EntityReviewVerificationBundle, { version: 4 }> {
      const graphs = graphPlan.pages.map((page, index) => validateEntityGraphReview(page.input, raws[index], provenance(completed.entityReviewPages[index]!.result))!);
      const prose = validateEntityProseReview(reviewInput, raws[0], provenance(completed.entityReviewPages[0]!.result))!;
      const existingProse = auditPlan.map((page, index) => validateEntityExistingProseReview(reviewInput, page, raws[graphPlan.pages.length + index],
        provenance(completed.entityReviewPages[graphPlan.pages.length + index]!.result)));
      return { version: 4, graphs, prose, existingProse };
    }
    const save = (value: EntityReviewVerificationBundle) => db.transaction((tx) => saveEntityReviewVerificationBundle(tx, scope, value));
    return { db, reviewInput, graphPlan, auditPlan, raws, pages, contextSnapshot, calls, invoke, run, bundle, save };
  } catch (error) { await db.close(); throw error; }
}

test("existing prose uses ordered saved audit pages, one hold, and a private immutable bundle4", async () => {
  const f = await fixture();
  try {
    const completed = await f.run(); const bundle = f.bundle(completed);
    assert.deepEqual(completed.entityReviewPages.map((page) => page.stepKey), ["dossier_graph:0", "dossier_graph:1", "dossier_existing_prose:0", "dossier_existing_prose:1"]);
    assert.deepEqual(f.calls, [0, 1, 2, 3]); assert.equal(bundle.existingProse.flatMap((page) => page.decisions).length, 11);
    const row = (await readEntityReviewCall(f.db, scope))!;
    assert.equal(row.request_snapshot.version, "storyhold:entity-review-request:v3");
    assert.equal(row.reservation_id, reservationId); assert.equal(row.billable_attempts.length, 4);
    assert.equal(completed.priorBillableAttempts?.length, 3);
    assert.deepEqual(await f.save(bundle), bundle); assert.deepEqual(await f.save(structuredClone(bundle)), bundle);
    const publicResult = { reviewed: true, entityId: scope.entityId };
    await f.db.transaction((tx) => finalizeEntityReviewCall(tx, scope, publicResult));
    assert.deepEqual((await readEntityReviewCall(f.db, scope))?.finalization_snapshot, publicResult);
    assert.deepEqual(await f.save(bundle), bundle);
    await assert.rejects(f.db.query("UPDATE storyhold.entity_review_ai_calls SET verification_snapshot=NULL,verification_fingerprint=NULL"), /immutable/);
  } finally { await f.db.close(); }
});

test("a paused graph prefix resumes only missing existing-prose pages and saved completion replays offline", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.run({ beforePage: async (_page, index) => { if (index === 2) throw new Error("Pause before the audit"); } }), /Pause before the audit/);
    assert.deepEqual(f.calls, [0, 1]);
    assert.deepEqual(await readEntityReviewPageProgress(f.db, scope), { completedPages: 2, totalPages: 4, canResume: true, blockedStatus: null, nextStepKey: "dossier_existing_prose:0" });
    const completed = await f.run(); assert.deepEqual(f.calls, [0, 1, 2, 3]);
    const replay = await f.run({ invoke: async () => { throw new Error("No repeat provider call is permitted"); } });
    assert.deepEqual(replay, completed); await f.save(f.bundle(replay));
    assert.equal((await readEntityReviewCall(f.db, scope))?.billable_attempts.length, 4);
  } finally { await f.db.close(); }
});

test("an unknown audit outcome freezes the original hold after its known paid graph prefix", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.run({ invoke: async (page, index) => {
      if (index === 2) { f.calls.push(index); throw new Error("Connection disappeared after dispatch"); }
      return f.invoke(page, index);
    } }), /Connection disappeared after dispatch|uncertain|could not be completed/i);
    const row = (await readEntityReviewCall(f.db, scope))!;
    assert.equal(row.status, "uncertain"); assert.equal(row.billable_attempts.length, 2);
    assert.deepEqual(await readEntityReviewPageProgress(f.db, scope), { completedPages: 2, totalPages: 4, canResume: false, blockedStatus: "uncertain", nextStepKey: "dossier_existing_prose:0" });
    await assert.rejects(f.run(), code("OUTCOME_UNRESOLVED")); assert.deepEqual(f.calls, [0, 1, 2]);
    const hold = (await f.db.query<{ status: string; usage: { retainUntilReconciled: boolean } }>("SELECT status,usage FROM storyhold.credit_reservations")).rows[0]!;
    assert.equal(hold.status, "reserved"); assert.equal(hold.usage.retainUntilReconciled, true);
  } finally { await f.db.close(); }
});

test("bundle4 requires every ordered audit receipt and actual page provenance, not an alternative valid answer", async () => {
  const f = await fixture();
  try {
    const completed = await f.run(), bundle = f.bundle(completed);
    for (const existingProse of [[], bundle.existingProse.slice(0, 1), [...bundle.existingProse].reverse()]) {
      await assert.rejects(f.save({ ...bundle, existingProse }), code("VERIFICATION_INVALID"));
    }
    const auditPage = f.auditPlan[0]!, auditRaw = f.raws[2];
    const real = provenance(completed.entityReviewPages[2]!.result);
    for (const verifier of [provenance(completed.entityReviewPages[0]!.result), provenance(completed.entityReviewPages[3]!.result),
      { ...real, completedAt: "2020-01-01T00:00:00.000Z" }]) {
      const forged = validateEntityExistingProseReview(f.reviewInput, auditPage, auditRaw, verifier);
      await assert.rejects(f.save({ ...bundle, existingProse: [forged, bundle.existingProse[1]!] }), code("VERIFICATION_INVALID"));
    }
    const altered = structuredClone(auditRaw) as { existingProseVerification: { decisions: { explanation: string }[] } };
    altered.existingProseVerification.decisions[0]!.explanation = "A different but well-formed rationale not returned by the paid model.";
    const alternate = validateEntityExistingProseReview(f.reviewInput, auditPage, altered, real);
    const substituted = { ...bundle, existingProse: [alternate, bundle.existingProse[1]!] };
    await assert.rejects(f.save(substituted), code("VERIFICATION_INVALID"));
    await f.save(bundle);
    await f.db.exec("ALTER TABLE storyhold.entity_review_ai_calls DISABLE TRIGGER entity_review_call_guard");
    await f.db.query("UPDATE storyhold.entity_review_ai_calls SET verification_snapshot=$1::jsonb,verification_fingerprint=$2", [JSON.stringify(substituted), hash(substituted)]);
    await assert.rejects(readEntityReviewCall(f.db, scope), code("JOURNAL_INTEGRITY"));
  } finally { await f.db.close(); }
});

test("missing or reordered audit pages and legacy singleton bypass fail before any paid dispatch", async () => {
  const f = await fixture();
  try {
    for (const pages of [f.pages.slice(0, 2), f.pages.slice(0, 3), [...f.pages.slice(2), ...f.pages.slice(0, 2)], [...f.pages, f.pages[3]!]]) {
      await assert.rejects(f.run({ pages }), code("REQUEST_INVALID"));
    }
    await assert.rejects(executeJournaledEntityReviewCall(f.db, { scope, reservationId, contextSnapshot: f.contextSnapshot,
      request: f.pages[0]!.request, provider: "openrouter", model, invoke: async () => { throw new Error("Must not call"); } }), code("REQUEST_INVALID"));
    assert.deepEqual(f.calls, []); assert.equal(await readEntityReviewCall(f.db, scope), null);
    await assert.rejects(f.run({ beforePage: async () => { throw new Error("Paused"); } }), /Paused/);
    const changed = { ...f.reviewInput, existingProseReview: buildExistingProseInventory({ details: ["Changed old dossier"] }) };
    await assert.rejects(f.run({ contextSnapshot: { version: 1, input: changed } as unknown as JsonObject, pages: f.pages.slice(0, 3) }), code("REQUEST_MISMATCH"));
    assert.deepEqual(f.calls, []);
  } finally { await f.db.close(); }
});

test("empty old prose still requires bundle4 and cannot downgrade its frozen success contract", async () => {
  const f = await fixture(0);
  try {
    const completed = await f.run(), bundle = f.bundle(completed);
    assert.equal(f.auditPlan.length, 0); assert.deepEqual(bundle.existingProse, []); assert.deepEqual(f.calls, [0, 1]);
    assert.equal((await readEntityReviewCall(f.db, scope))?.request_snapshot.version, "storyhold:entity-review-request:v3");
    await assert.rejects(f.save({ version: 3, graphs: bundle.graphs, prose: bundle.prose }), code("VERIFICATION_INVALID"));
    await assert.rejects(f.save({ version: 4, graphs: bundle.graphs, prose: bundle.prose } as EntityReviewVerificationBundle), code("VERIFICATION_INVALID"));
    await assert.rejects(f.db.transaction((tx) => finalizeEntityReviewCall(tx, scope, { reviewed: true })), code("VERIFICATION_REQUIRED"));
    await f.save(bundle); await f.db.transaction((tx) => finalizeEntityReviewCall(tx, scope, { reviewed: true }));
  } finally { await f.db.close(); }
});

test("legacy prose-only pages retain request-v2 and bundle3 and cannot acquire the new audit flag", async () => {
  const f = await fixture(null);
  try {
    const completed = await f.run(), attempted = f.bundle(completed);
    assert.equal((await readEntityReviewCall(f.db, scope))?.request_snapshot.version, "storyhold:entity-review-request:v2");
    await assert.rejects(f.save(attempted), code("VERIFICATION_INVALID"));
    const legacy = { version: 3 as const, graphs: attempted.graphs, prose: attempted.prose };
    assert.deepEqual(await f.save(legacy), legacy); await ensureEntityReviewJournal(f.db);
    assert.deepEqual((await readEntityReviewCall(f.db, scope))?.verification_snapshot, legacy);
  } finally { await f.db.close(); }
});

test("a saved old-prose page cannot smuggle new raw biography through an otherwise valid bundle", async () => {
  const f = await fixture();
  try {
    const completed = await f.run({ invoke: async (page, index) => {
      const paid = await f.invoke(page, index);
      return index === 2 ? { ...paid, text: JSON.stringify({ ...f.raws[index], summary: "An unverified replacement biography." }) } : paid;
    } });
    await assert.rejects(f.save(f.bundle(completed)), code("VERIFICATION_INVALID"));
    assert.equal((await readEntityReviewCall(f.db, scope))?.verification_snapshot, null);
    await f.db.transaction((tx) => finalizeEntityReviewCall(tx, scope, { reviewed: false, outcome: "not_applied" }));
    assert.equal((await readEntityReviewCall(f.db, scope))?.finalization_snapshot?.reviewed, false);
  } finally { await f.db.close(); }
});

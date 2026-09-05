import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { getAiRuntimeStatus, type AiTextResult } from "./aiGateway";
import type { JsonObject } from "./analysisVerificationContracts";
import { buildEntityGraphRequest, validateEntityGraphReview } from "./entityGraphVerification";
import { buildEntityProseRequest, validateEntityProseReview } from "./entityProseVerification";
import { buildExistingProseInventory, prepareEntityExistingProsePages, validateEntityExistingProseReview,
  type EntityExistingProseItem, type EntityExistingProseReviewContext, type EntityExistingProseVerdict } from "./entityExistingProseReview";
import type { EntityReviewInput } from "./entityReview";
import { ensureEntityReviewJournal, executeJournaledEntityReviewPages, finalizeEntityReviewCall, saveEntityReviewVerificationBundle,
  type EntityReviewCallScope } from "./entityReviewJournal";
import { prepareEntityReviewPages } from "./entityReviewPages";
import { loadEntityProseRetrievalLeads } from "./entityProseRetrieval";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { playerId: id(2), worldId: id(3), editionId: id(4), entityId: id(5) };
const CHUNK = id(7), SOURCE = id(8), quote = "Mira shelters fugitives. She has never visited the western castle.";
const inventory = (details: string[]) => buildExistingProseInventory({ details });
const unknown = () => "needs_more_evidence" as const;

async function fixture() {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.worlds(id uuid PRIMARY KEY,owner_player_id uuid);
      CREATE TABLE storyhold.players(id uuid PRIMARY KEY,role text DEFAULT 'admin');
      CREATE TABLE storyhold.credit_reservations(id uuid PRIMARY KEY,operation text,request_id text);
      CREATE TABLE storyhold.world_entities(id uuid PRIMARY KEY,world_id uuid,canon_edition_id uuid,name text,
        pull_status text DEFAULT 'active',merged_into_entity_id uuid);
      CREATE TABLE storyhold.world_sources(id uuid PRIMARY KEY,world_id uuid,canon_edition_id uuid);
      CREATE TABLE storyhold.world_source_chunks(id uuid PRIMARY KEY,source_id uuid,content text);`);
    await ensureEntityReviewJournal(db);
    await db.query("INSERT INTO storyhold.worlds VALUES($1,$2)", [scope.worldId, scope.playerId]);
    await db.query("INSERT INTO storyhold.players(id) VALUES($1)", [scope.playerId]);
    await db.query("INSERT INTO storyhold.world_entities(id,world_id,canon_edition_id,name) VALUES($1,$2,$3,'Mira')", [scope.entityId, scope.worldId, scope.editionId]);
    await db.query("INSERT INTO storyhold.world_sources VALUES($1,$2,$3)", [SOURCE, scope.worldId, scope.editionId]);
    await db.query("INSERT INTO storyhold.world_source_chunks VALUES($1,$2,$3)", [CHUNK, SOURCE, quote]);
    let sequence = 100, calls = 0;
    async function audit(current: EntityExistingProseReviewContext | null,
      decide: (item: EntityExistingProseItem) => EntityExistingProseVerdict = unknown,
      options: { finalize?: boolean; reviewed?: boolean; uncertain?: boolean; requests?: (item: EntityExistingProseItem) => string[];
        chunks?: EntityReviewInput["chunks"] } = {}) {
      const usedScope: EntityReviewCallScope = { ...scope, reviewId: id(sequence++) };
      const input: EntityReviewInput = { worldName: "Refuge", worldPremise: "A hidden refuge", worldGenre: "Fantasy", depth: "full", proseReview: { version: 1 },
        premiumStatScope: { worldId: scope.worldId, editionId: scope.editionId, analysisRunId: usedScope.reviewId },
        ...(current ? { existingProseReview: current } : {}),
        entity: { id: scope.entityId, name: "Mira", entityType: "character", aliases: [], summary: "", details: [], relationships: [] },
        chunks: options.chunks ?? [{ id: CHUNK, sourceId: SOURCE, content: quote, sourceTitle: "The Book", index: 0, sectionTitle: "Earlier Events" }],
        knownEntities: [{ name: "Mira", entityType: "character", aliases: [] }],
        graphReview: { version: 2, relations: [], rules: [], entities: [{ id: scope.entityId, name: "Mira", entityType: "character", aliases: [] }] } };
      const graphPage = prepareEntityReviewPages(input).pages[0]!;
      const initial = { claims: [], character: null,
        claimVerification: { requestFingerprint: buildEntityProseRequest(input)!.fingerprint, decisions: [], newClaims: [] },
        prosePresentation: { displayOrder: [] }, relations: [], rules: [], entityRelations: [], entityRules: [],
        graphVerification: { requestFingerprint: buildEntityGraphRequest(graphPage.input)!.fingerprint, decisions: [], newFindings: [] } };
      const auditPages = prepareEntityExistingProsePages(input);
      const raws = [initial, ...auditPages.map((page) => ({ existingProseVerification: { requestFingerprint: page.requestFingerprint,
        decisions: page.items.map((item) => {
          const verdict = decide(item);
          return { itemId: item.itemId, verdict, explanation: "Read this exact stored text in context.", confidence: 0.8,
            supportingEvidence: verdict === "supported" ? [{ chunkId: CHUNK, quote }] : [],
            contradictingEvidence: verdict === "contradicted" ? [{ chunkId: CHUNK, quote }] : [],
            retrievalRequests: verdict === "needs_more_evidence" ? options.requests?.(item) ?? [`Find the earlier scene for ${item.text}`] : [] };
        }) } }))];
      const execute = () => executeJournaledEntityReviewPages(db, { scope: usedScope, reservationId: null,
        contextSnapshot: { version: 1, input } as unknown as JsonObject,
        pages: [graphPage, ...auditPages].map((page) => ({ stepKey: page.stepKey, provider: "openrouter", model: "offline-audit-model",
          request: { task: "canon_review", stage: "dossier", system: "OFFLINE TEST ONLY", messages: [{ role: "user", content: quote }],
            allowProviderFallback: false, providerFailurePolicy: "stop" } })),
        invoke: async (_page, index) => {
          calls++;
          if (options.uncertain) throw new Error("Simulated unknown outcome");
          return { text: JSON.stringify(raws[index]), provider: "openrouter", model: "offline-audit-model", reasoning: "high",
            usage: { inputUnits: 100, outputUnits: 100, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 0,
              estimatedCostMicros: 100, pricingKnown: true, pricingVersion: "fixture", costEstimated: false },
            runtime: getAiRuntimeStatus("canon_review", "standard", "dossier") } satisfies AiTextResult;
        } });
      if (options.uncertain) { await assert.rejects(execute(), /uncertain provider outcome/i); return { scope: usedScope, input }; }
      const completed = await execute();
      const verifier = (index: number) => ({ provider: "openrouter", model: "offline-audit-model", completedAt: completed.entityReviewPages[index]!.result.journalCompletedAt! });
      await db.transaction(async (tx) => {
        const graphs = [validateEntityGraphReview(graphPage.input, initial, verifier(0))!], prose = validateEntityProseReview(input, initial, verifier(0))!;
        await saveEntityReviewVerificationBundle(tx, usedScope, current ? { version: 4, graphs, prose,
          existingProse: auditPages.map((page, index) => validateEntityExistingProseReview(input, page, raws[index + 1], verifier(index + 1))) }
          : { version: 3, graphs, prose });
        if (options.finalize !== false) await finalizeEntityReviewCall(tx, usedScope, { reviewed: options.reviewed !== false, entityId: scope.entityId });
      });
      return { scope: usedScope, input };
    }
    return { db, audit, calls: () => calls, load: (current: EntityExistingProseReviewContext) => loadEntityProseRetrievalLeads(db, scope, current) };
  } catch (error) { await db.close(); throw error; }
}

test("loads the complete unresolved inventory without caps, preserves raw slots and previous text, and searches no sources", async () => {
  const f = await fixture();
  try {
    const details = Array.from({ length: 27 }, (_, index) => `Old detail ${index}\nWith an exact qualifier.`);
    const current = inventory(details), prior = await f.audit(current, unknown, { requests: (item) => item.index === 0 ? [] : [`Exact request ${item.index}`, `Another request ${item.index}`] });
    await f.db.query("UPDATE storyhold.world_source_chunks SET content='The manuscript was edited after the audit.'");
    const before = (await f.db.query("SELECT * FROM storyhold.entity_review_ai_calls ORDER BY review_id")).rows;
    const providerCalls = f.calls(), queries: string[] = [];
    const readonly = { query: ((sql: string, values?: unknown[]) => {
      queries.push(sql); assert.match(sql.trim(), /^SELECT\b/u); assert.doesNotMatch(sql, /world_source_chunks|world_sources/u);
      return f.db.query(sql, values);
    }) as PGlite["query"] };
    const loaded = await loadEntityProseRetrievalLeads(readonly, scope, inventory([...details, "A newly added detail"]));
    assert.equal(loaded.skippedReviews, 0); assert.equal(loaded.leads.length, 27);
    assert.deepEqual(loaded.leads.map((lead) => lead.item), current.items);
    assert.deepEqual(loaded.leads[0]!.requests, [details[0]]);
    assert.deepEqual(loaded.leads[26]!.requests, ["Exact request 26", "Another request 26"]);
    assert.ok(loaded.leads.every((lead) => lead.reviewId === prior.scope.reviewId));
    assert.deepEqual(loaded.leads[0]!.previousChunks, prior.input.chunks);
    assert.equal(f.calls(), providerCalls); assert.ok(queries.length > 1);
    assert.deepEqual((await f.db.query("SELECT * FROM storyhold.entity_review_ai_calls ORDER BY review_id")).rows, before);
  } finally { await f.db.close(); }
});

test("newest applicable supported and contradicted judgments suppress older unresolved retrieval requests", async () => {
  const f = await fixture();
  try {
    const current = inventory(["Mira shelters fugitives.", "Mira visited the western castle.", "Mira's lost childhood."]);
    await f.audit(current);
    const latest = await f.audit(current, (item) => item.index === 0 ? "supported" : item.index === 1 ? "contradicted" : "needs_more_evidence",
      { requests: () => ["Find childhood chapters, not the current refuge scene."] });
    const loaded = await f.load(current);
    assert.equal(loaded.skippedReviews, 0); assert.equal(loaded.leads.length, 1);
    assert.equal(loaded.leads[0]!.item.itemId, current.items[2]!.itemId);
    assert.equal(loaded.leads[0]!.reviewId, latest.scope.reviewId);
    assert.deepEqual(loaded.leads[0]!.requests, ["Find childhood chapters, not the current refuge scene."]);
  } finally { await f.db.close(); }
});

test("all applicable paid reading history survives later audits, including different versions of the same chunk", async () => {
  const f = await fixture();
  try {
    const current = inventory(["Mira's lost childhood."]);
    const a = { id: CHUNK, sourceId: SOURCE, content: quote, sourceTitle: "The Book", index: 0 };
    const b = { ...a, id: id(40), index: 1, content: `${quote} The earlier childhood passage B.` };
    const c = { ...a, id: id(41), index: 2, content: `${quote} Another childhood passage C.` };
    const changedB = { ...b, content: `${quote} A revised childhood passage B.` };
    await f.audit(current, unknown, { chunks: [a], requests: () => ["First request"] });
    await f.audit(current, unknown, { chunks: [a, b], requests: () => ["Second request"] });
    const latest = await f.audit(current, unknown, { chunks: [a, c], requests: () => ["Latest request"] });
    const afterC = (await f.load(current)).leads[0]!;
    assert.equal(afterC.reviewId, latest.scope.reviewId); assert.deepEqual(afterC.requests, ["Latest request"]);
    assert.deepEqual(afterC.previousChunks, [a, c, b], "B must remain in the exclusion history after the latest review reads only A+C");
    await f.audit(current, unknown, { chunks: [a, changedB] });
    const variants = (await f.load(current)).leads[0]!.previousChunks;
    assert.deepEqual(variants, [a, changedB, c, b]);
    assert.deepEqual(variants.filter((chunk) => chunk.id === b.id).map((chunk) => chunk.content), [changedB.content, b.content]);
    await f.audit(current, () => "supported", { chunks: [a] });
    assert.deepEqual(await f.load(current), { leads: [], skippedReviews: 0 }, "historical unknowns cannot undo the latest resolved judgment");
  } finally { await f.db.close(); }
});

test("field applicability preserves origin, duplicate positions and exact sequence while allowing only trailing additions", async () => {
  const f = await fixture();
  try {
    const old = buildExistingProseInventory({ details: ["Duplicate", "Duplicate", "Tail"] }, { profile: { traits: ["Patient", "Practical"] } });
    await f.audit(old);
    const appended = buildExistingProseInventory({ details: ["Duplicate", "Duplicate", "Tail", "Added"] }, { profile: { traits: ["Patient", "Practical", "Added"] } });
    assert.deepEqual((await f.load(appended)).leads.map((lead) => lead.item), old.items);
    for (const details of [["Duplicate", "Tail"], ["Tail", "Duplicate", "Duplicate"], ["Duplicate", "Edited", "Tail"]]) {
      const changed = buildExistingProseInventory({ details }, { profile: { traits: ["Patient", "Practical"] } });
      const loaded = await f.load(changed);
      assert.deepEqual(loaded.leads.map((lead) => [lead.item.origin, lead.item.field, lead.item.index]), [["character", "traits", 0], ["character", "traits", 1]]);
    }
    const movedOrigin = buildExistingProseInventory({ details: ["Patient", "Practical"] });
    assert.deepEqual((await f.load(movedOrigin)).leads, []);
  } finally { await f.db.close(); }
});

test("only an active unmerged target owned by this player in this exact world and edition exposes leads", async () => {
  const f = await fixture();
  try {
    const current = inventory(["An unresolved detail"]); await f.audit(current);
    for (const changed of [{ playerId: id(90) }, { worldId: id(91) }, { editionId: id(92) }, { entityId: id(93) }]) {
      assert.deepEqual(await loadEntityProseRetrievalLeads(f.db, { ...scope, ...changed }, current), { leads: [], skippedReviews: 0 });
    }
    await f.db.query("UPDATE storyhold.world_entities SET pull_status='hidden'");
    assert.deepEqual(await f.load(current), { leads: [], skippedReviews: 0 });
    await f.db.query("UPDATE storyhold.world_entities SET pull_status='active',merged_into_entity_id=$1", [id(94)]);
    assert.deepEqual(await f.load(current), { leads: [], skippedReviews: 0 });
    await f.db.query("UPDATE storyhold.world_entities SET merged_into_entity_id=NULL");
    await f.db.query("UPDATE storyhold.worlds SET owner_player_id=$1", [id(95)]);
    assert.deepEqual(await f.load(current), { leads: [], skippedReviews: 0 });
  } finally { await f.db.close(); }
});

test("legacy, not-applied, unfinished and unknown outcomes never supply retrieval leads", async () => {
  const f = await fixture();
  try {
    const current = inventory(["An unresolved detail"]);
    await f.audit(null); await f.audit(current, unknown, { reviewed: false });
    const pending = await f.audit(current, unknown, { finalize: false });
    assert.deepEqual(await f.load(current), { leads: [], skippedReviews: 0 });
    await f.db.transaction((tx) => finalizeEntityReviewCall(tx, pending.scope, { reviewed: false, entityId: scope.entityId }));
    await f.audit(current, unknown, { uncertain: true });
    assert.deepEqual(await f.load(current), { leads: [], skippedReviews: 0 });
  } finally { await f.db.close(); }
});

test("corrupt journal evidence is counted but operational database failures propagate", async () => {
  const f = await fixture();
  try {
    const current = inventory(["An unresolved detail"]), original = await f.audit(current), newer = await f.audit(current, () => "supported");
    await f.db.exec("ALTER TABLE storyhold.entity_review_ai_calls DISABLE TRIGGER entity_review_call_guard");
    await f.db.query("UPDATE storyhold.entity_review_ai_calls SET verification_fingerprint='damaged' WHERE review_id=$1", [newer.scope.reviewId]);
    const loaded = await f.load(current);
    assert.equal(loaded.skippedReviews, 1); assert.equal(loaded.leads.length, 1); assert.equal(loaded.leads[0]!.reviewId, original.scope.reviewId);
    for (const match of [/FROM storyhold.world_entities/u, /SELECT review_id FROM storyhold.entity_review_ai_calls/u, /SELECT \* FROM storyhold.entity_review_ai_calls/u, /FROM storyhold.entity_review_ai_pages/u]) {
      const failure = new Error("Simulated storage read failure");
      const broken = { query: ((sql: string, values?: unknown[]) => {
        if (match.test(sql)) throw failure;
        return f.db.query(sql, values);
      }) as PGlite["query"] };
      await assert.rejects(loadEntityProseRetrievalLeads(broken, scope, current), (error) => error === failure);
    }
  } finally { await f.db.close(); }
});

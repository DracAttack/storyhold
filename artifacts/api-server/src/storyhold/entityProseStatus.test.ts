import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { getAiRuntimeStatus, type AiTextResult } from "./aiGateway";
import type { JsonObject } from "./analysisVerificationContracts";
import { buildEntityGraphRequest, validateEntityGraphReview } from "./entityGraphVerification";
import { buildEntityProseRequest, validateEntityProseReview } from "./entityProseVerification";
import { ensureEntityReviewClaimLinks, syncEntityVerifiedProse } from "./entityProseJournal";
import { readEntityProseStatus, type EntityProseStatus, type EntityProseVisible } from "./entityProseStatus";
import type { EntityReviewInput } from "./entityReview";
import { ensureEntityReviewJournal, executeJournaledEntityReviewPages, finalizeEntityReviewCall,
  saveEntityReviewVerificationBundle, type EntityReviewCallScope } from "./entityReviewJournal";
import { prepareEntityReviewPages } from "./entityReviewPages";
import { buildExistingProseInventory, prepareEntityExistingProsePages, validateEntityExistingProseReview,
  type EntityExistingProseItem, type EntityExistingProseVerdict } from "./entityExistingProseReview";
import { ensurePremiumClaimJournal } from "./premiumClaimJournal";
import type { PremiumClaimPayload } from "./premiumClaimVerification";
import { serializeDossier } from "./worldStudio";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope: EntityReviewCallScope = { reviewId: id(1), playerId: id(2), worldId: id(3), editionId: id(4), entityId: id(5) };
const DOSSIER = id(6), CHUNK = id(7), SOURCE = id(8);
const quote = "Mira shelters fugitives. She risks arrest for them. She is patient and practical. Until Book Two, she kept the refuge secret.";
const claim = (predicate: string, value: string, changes: Partial<PremiumClaimPayload> = {}): PremiumClaimPayload => ({
  subject: "Mira", predicate: `dossier.${predicate}`, value, polarity: "positive", epistemicHolder: "", truthStatus: "fact",
  validFromLabel: "", validUntilLabel: "", ...changes });
const claims = [claim("summary", "Mira shelters fugitives."), claim("summary", "She risks arrest for them."),
  claim("traits", "Patient"), claim("traits", "Practical"), claim("secrets", "she kept the refuge secret", { validUntilLabel: "Book Two" })];
const reviewedFields = (value: EntityProseStatus) => value.fields.filter((field) => field.verifiedItems > 0);
async function fixture(finalized = true) {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.worlds(id uuid PRIMARY KEY,owner_player_id uuid);
      CREATE TABLE storyhold.players(id uuid PRIMARY KEY,role text DEFAULT 'admin');
      CREATE TABLE storyhold.credit_reservations(id uuid PRIMARY KEY,operation text,request_id text);
      CREATE TABLE storyhold.world_analysis_runs(id uuid PRIMARY KEY,world_id uuid,canon_edition_id uuid,analysis_kind text DEFAULT 'ai_enrichment');
      CREATE TABLE storyhold.character_dossiers(id uuid PRIMARY KEY,world_id uuid,canon_edition_id uuid,user_edited_at timestamptz);
      CREATE TABLE storyhold.world_entities(id uuid PRIMARY KEY,world_id uuid,canon_edition_id uuid,name text,entity_type text DEFAULT 'character',
        aliases jsonb DEFAULT '[]',pull_status text DEFAULT 'active',scanner_present boolean DEFAULT true,merged_into_entity_id uuid,
        classification_source text DEFAULT 'local',review_status text DEFAULT 'candidate',dossier_id uuid);
      CREATE TABLE storyhold.world_knowledge_claims(id uuid PRIMARY KEY,world_id uuid,canon_edition_id uuid,source_analysis_run_id uuid,
        supersedes_claim_id uuid,fingerprint text,subject_entity_id uuid,predicate text,polarity text DEFAULT 'positive',object_entity_id uuid,object_text text,
        epistemic_holder_entity_id uuid,truth_status text,valid_from_label text DEFAULT '',valid_until_label text DEFAULT '',summary text DEFAULT '',
        evidence jsonb DEFAULT '[]',confidence real DEFAULT 0,claim_status text DEFAULT 'active',assignment_source text DEFAULT 'ai',
        created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),UNIQUE(world_id,canon_edition_id,fingerprint));
      CREATE TABLE storyhold.world_sources(id uuid PRIMARY KEY,world_id uuid,canon_edition_id uuid,processing_status text DEFAULT 'ready',
        canon_status text DEFAULT 'canon',source_kind text DEFAULT 'manuscript');
      CREATE TABLE storyhold.world_source_chunks(id uuid PRIMARY KEY,source_id uuid,world_id uuid,canon_edition_id uuid,content text);`);
    await ensureEntityReviewJournal(db); await ensurePremiumClaimJournal(db); await ensureEntityReviewClaimLinks(db);
    await db.query("INSERT INTO storyhold.worlds VALUES($1,$2)", [scope.worldId, scope.playerId]);
    await db.query("INSERT INTO storyhold.players(id) VALUES($1)", [scope.playerId]);
    await db.query("INSERT INTO storyhold.character_dossiers(id,world_id,canon_edition_id) VALUES($1,$2,$3)", [DOSSIER, scope.worldId, scope.editionId]);
    await db.query("INSERT INTO storyhold.world_entities(id,world_id,canon_edition_id,name,dossier_id) VALUES($1,$2,$3,'Mira',$4)", [scope.entityId, scope.worldId, scope.editionId, DOSSIER]);
    await db.query("INSERT INTO storyhold.world_sources(id,world_id,canon_edition_id) VALUES($1,$2,$3)", [SOURCE, scope.worldId, scope.editionId]);
    await db.query("INSERT INTO storyhold.world_source_chunks VALUES($1,$2,$3,$4,$5)", [CHUNK, SOURCE, scope.worldId, scope.editionId, quote]);
    const input: EntityReviewInput = { worldName: "Refuge", worldPremise: "A hidden refuge", worldGenre: "Fantasy", depth: "full", proseReview: { version: 1 },
      premiumStatScope: { worldId: scope.worldId, editionId: scope.editionId, analysisRunId: scope.reviewId },
      entity: { id: scope.entityId, name: "Mira", entityType: "character", aliases: [], summary: "", details: [], relationships: [] },
      ownerCanonConstraints: [{ id: id(19), kind: "fact", instruction: "PRIVATE OWNER GUIDANCE MUST NOT LEAK" }],
      chunks: [{ id: CHUNK, sourceId: SOURCE, content: quote, sourceTitle: "The Book", index: 0 }],
      knownEntities: [{ name: "Mira", entityType: "character", aliases: [] }],
      graphReview: { version: 2, relations: [], rules: [], entities: [{ id: scope.entityId, name: "Mira", entityType: "character", aliases: [] }] } };
    const page = prepareEntityReviewPages(input).pages[0]!;
    const graphRequest = buildEntityGraphRequest(page.input)!;
    const proseRequest = buildEntityProseRequest(input)!;
    const raw = { claims: [], character: null, claimVerification: { requestFingerprint: proseRequest.fingerprint, decisions: [],
      newClaims: claims.map((value) => ({ claim: value, verdict: "verified", explanation: "Supported by the manuscript.", confidence: 0.9,
        supportingEvidence: [{ chunkId: CHUNK, quote }], contradictingEvidence: [], retrievalRequests: [] })) },
      prosePresentation: { displayOrder: claims.map((_claim, index) => index) }, relations: [], rules: [], entityRelations: [], entityRules: [],
      graphVerification: { requestFingerprint: graphRequest.fingerprint, decisions: [], newFindings: [] } };
    let calls = 0;
    const completed = await executeJournaledEntityReviewPages(db, { scope, reservationId: null, contextSnapshot: { version: 1, input } as unknown as JsonObject,
      pages: [{ stepKey: page.stepKey, provider: "openrouter", model: "private-model-name", request: { task: "canon_review", stage: "dossier",
        system: "PRIVATE PROVIDER PROMPT", messages: [{ role: "user", content: quote }], allowProviderFallback: false, providerFailurePolicy: "stop" } }],
      invoke: async () => { calls++; return { text: JSON.stringify(raw), provider: "openrouter", model: "private-model-name", reasoning: "high",
        usage: { inputUnits: 100, outputUnits: 100, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 0,
          estimatedCostMicros: 100, pricingKnown: true, pricingVersion: "fixture", costEstimated: false },
        runtime: getAiRuntimeStatus("canon_review", "standard", "dossier") } satisfies AiTextResult; } });
    const actual = completed.entityReviewPages[0]!.result;
    const verifier = { provider: actual.provider, model: actual.model, completedAt: actual.journalCompletedAt! };
    const prose = validateEntityProseReview(input, raw, verifier)!;
    await db.transaction(async (tx) => {
      await saveEntityReviewVerificationBundle(tx, scope, { version: 3, graphs: [validateEntityGraphReview(page.input, raw, verifier)!], prose });
      await syncEntityVerifiedProse(tx, scope, prose);
      if (finalized) await finalizeEntityReviewCall(tx, scope, { reviewed: true, entityId: scope.entityId });
    });
    const visible: EntityProseVisible = { aliases: [], summary: "Wrong entity summary is not the character's visible summary", details: [], authorControlled: false,
      character: { aliases: [], summary: "Mira shelters fugitives. She risks arrest for them.", role: "", profile: {
        traits: ["Patient", "Practical", "Unreviewed old trait"], secrets: ["Until Book Two: she kept the refuge secret"] } } };
    const read = (value = visible, usedScope = scope) => readEntityProseStatus(db, usedScope, value);
    let auditCounter = 100;
    const audit = async (decide: (item: EntityExistingProseItem) => EntityExistingProseVerdict, oldVisible = visible) => {
      const auditScope = { ...scope, reviewId: id(auditCounter++) };
      const auditInput: EntityReviewInput = { ...structuredClone(input),
        premiumStatScope: { ...input.premiumStatScope!, analysisRunId: auditScope.reviewId },
        existingProseReview: buildExistingProseInventory(oldVisible, oldVisible.character ?? undefined) };
      const graphPage = prepareEntityReviewPages(auditInput).pages[0]!;
      const graphRequest = buildEntityGraphRequest(graphPage.input)!;
      const proseRequest = buildEntityProseRequest(auditInput)!;
      const initial = { claims: [], character: null, claimVerification: { requestFingerprint: proseRequest.fingerprint, decisions: [], newClaims: [] },
        prosePresentation: { displayOrder: [] }, relations: [], rules: [], entityRelations: [], entityRules: [],
        graphVerification: { requestFingerprint: graphRequest.fingerprint, decisions: [], newFindings: [] } };
      const auditPages = prepareEntityExistingProsePages(auditInput);
      const raws = [initial, ...auditPages.map((page) => ({ existingProseVerification: { requestFingerprint: page.requestFingerprint,
        decisions: page.items.map((item) => {
          const verdict = decide(item);
          return { itemId: item.itemId, verdict, explanation: `Read the complete ${item.field} wording in context.`, confidence: 0.8,
            supportingEvidence: verdict === "supported" ? [{ chunkId: CHUNK, quote }] : [],
            contradictingEvidence: verdict === "contradicted" ? [{ chunkId: CHUNK, quote }] : [],
            retrievalRequests: verdict === "needs_more_evidence" ? ["Locate the earlier scene establishing this detail."] : [] };
        }) } }))];
      const complete = await executeJournaledEntityReviewPages(db, { scope: auditScope, reservationId: null,
        contextSnapshot: { version: 1, input: auditInput } as unknown as JsonObject,
        pages: [graphPage, ...auditPages].map((page) => ({ stepKey: page.stepKey, provider: "openrouter", model: "private-audit-model",
          request: { task: "canon_review", stage: "dossier", system: "PRIVATE AUDIT PROMPT", messages: [{ role: "user", content: quote }],
            allowProviderFallback: false, providerFailurePolicy: "stop" } })),
        invoke: async (_page, index) => { calls++; return { text: JSON.stringify(raws[index]), provider: "openrouter", model: "private-audit-model", reasoning: "high",
          usage: actual.usage, runtime: actual.runtime } satisfies AiTextResult; } });
      const verifierFor = (index: number) => ({ provider: "openrouter", model: "private-audit-model", completedAt: complete.entityReviewPages[index]!.result.journalCompletedAt! });
      const prose = validateEntityProseReview(auditInput, initial, verifierFor(0))!;
      await db.transaction(async (tx) => {
        await saveEntityReviewVerificationBundle(tx, auditScope, { version: 4,
          graphs: [validateEntityGraphReview(graphPage.input, initial, verifierFor(0))!], prose,
          existingProse: auditPages.map((page,index) => validateEntityExistingProseReview(auditInput,page,raws[index+1],verifierFor(index+1))) });
        assert.equal((await syncEntityVerifiedProse(tx,auditScope,prose)).claimsSaved,0,"read-only audits never fabricate canonical claims");
        await finalizeEntityReviewCall(tx,auditScope,{reviewed:true,entityId:scope.entityId});
      });
      return auditScope;
    };
    return { db, visible, read, audit, calls: () => calls };
  } catch (error) { await db.close(); throw error; }
}

test("only exact currently visible text receives field/item proof and safe manuscript citations", async () => {
  const f = await fixture();
  try {
    const result = await f.read();
    assert.deepEqual(result.fields.map((field) => [field.field, field.status, field.verifiedItems, field.totalItems]),
      [["summary", "verified", 1, 1], ["traits", "partial", 2, 3], ["secrets", "verified", 1, 1]]);
    const summary = result.fields[0]!.items[0]!;
    assert.deepEqual(summary.evidence, [{ chunkId: CHUNK, sourceId: SOURCE, quote }]);
    assert.equal(summary.confidence, 0.9);
    const old = result.fields.find((field) => field.field === "traits")!.items[2]!;
    assert.deepEqual(old, { text: "Unreviewed old trait", status: "not_reviewed", evidence: [] });
    const serialized = JSON.stringify(result);
    for (const secret of ["PRIVATE OWNER", "PRIVATE PROVIDER", "private-model-name", "openrouter", scope.reviewId, "proposalId", "requestFingerprint"]) assert.ok(!serialized.includes(secret));
    const malformedVisible = await f.read({ aliases: [null, 12, "An Unreviewed Alias"], summary: 42, details: {}, character: null, authorControlled: false });
    assert.deepEqual(malformedVisible.fields.map((field) => [field.field, field.status, field.totalItems]), [["aliases", "not_reviewed", 1]]);
    assert.equal(f.calls(), 1, "status reads never invoke models");
  } finally { await f.db.close(); }
});

test("complete old-text audits expose observational verdicts without adding, deleting, or promoting canon", async () => {
  const f = await fixture();
  try {
    const before = (await f.db.query("SELECT * FROM storyhold.world_knowledge_claims ORDER BY id")).rows;
    const links = (await f.db.query("SELECT * FROM storyhold.world_knowledge_claim_verifications ORDER BY proposal_id")).rows;
    await f.audit((item) => item.text === "Practical" ? "contradicted" : item.text === "Unreviewed old trait" ? "needs_more_evidence" : "supported");
    const result = await f.read();
    assert.equal(result.fields.find((field) => field.field === "summary")!.status,"supported");
    const traits = result.fields.find((field) => field.field === "traits")!;
    assert.equal(traits.status,"needs_attention"); assert.equal(traits.verifiedItems,0); assert.equal(traits.reviewedItems,3); assert.equal(traits.sourceCheckedItems,1);
    assert.deepEqual(traits.items.map((item) => item.status),["supported","needs_attention","needs_evidence"]);
    assert.ok(traits.items.every((item) => item.reviewBasis === "existing_text_audit"));
    assert.deepEqual(traits.items[2]!.retrievalRequests,["Locate the earlier scene establishing this detail."]);
    assert.deepEqual((await f.db.query("SELECT * FROM storyhold.world_knowledge_claims ORDER BY id")).rows,before);
    assert.deepEqual((await f.db.query("SELECT * FROM storyhold.world_knowledge_claim_verifications ORDER BY proposal_id")).rows,links);
    assert.equal((await f.db.query("SELECT * FROM storyhold.world_analysis_runs")).rows.length,0);
    assert.ok(!JSON.stringify(result).includes("private-audit-model"));
  } finally { await f.db.close(); }
});

test("newest applicable audit wins, and stale sources never restore an older reassuring verdict", async () => {
  const f = await fixture();
  try {
    await f.audit(() => "supported");
    assert.equal((await f.read()).fields.find((field) => field.field === "traits")!.items[0]!.status,"supported");
    await f.audit((item) => item.text === "Patient" ? "contradicted" : "needs_more_evidence");
    assert.equal((await f.read()).fields.find((field) => field.field === "traits")!.items[0]!.status,"needs_attention");
    const untouched = structuredClone(f.visible); untouched.character!.summary = "Mira shelters fugitives.";
    assert.equal((await f.read(untouched)).fields.find((field) => field.field === "summary")!.status,"not_reviewed","summary matching is whole-item exact");
    await f.db.query("UPDATE storyhold.world_source_chunks SET content=content || ' Edited afterward.'");
    const stale = await f.read();
    assert.ok(stale.fields.every((field) => field.status === "not_reviewed"));
    assert.match(stale.fields[0]!.items[0]!.explanation!,/changed or are unavailable/);
  } finally { await f.db.close(); }
});

test("duplicate slots and plain connection notes retain origin/index without acquiring graph authority", async () => {
  const f = await fixture();
  try {
    const repeated = structuredClone(f.visible);
    repeated.character!.profile = { traits: ["Patient","Patient","Practical"], relationships: ["Mira distrusts the guild."] };
    repeated.relationships = ["An entity-only note."];
    await f.audit((item) => item.field === "traits" ? item.index === 0 ? "supported" : "contradicted" : "supported",repeated);
    const result = await f.read(repeated);
    assert.deepEqual(result.fields.find((field) => field.field === "traits")!.items.map((item) => item.status),["supported","needs_attention","needs_attention"]);
    assert.deepEqual(result.fields.find((field) => field.field === "relationships")!.items.map((item) => [item.text,item.status]),[["Mira distrusts the guild.","supported"]]);
    const deduplicated = structuredClone(repeated); deduplicated.character!.profile = { traits: ["Patient","Practical"] };
    assert.equal((await f.read(deduplicated)).fields.find((field) => field.field === "traits")!.items[0]!.status,"not_reviewed","collapsed duplicates cannot borrow one convenient verdict");
    await f.db.query("UPDATE storyhold.character_dossiers SET user_edited_at=now()");
    assert.ok((await f.read(repeated)).fields.every((field) => field.status === "author_controlled"));
  } finally { await f.db.close(); }
});

test("actual dossier serialization aggregates every raw duplicate slot without losing later audit results", async () => {
  const f = await fixture();
  try {
    const stored = structuredClone(f.visible);
    stored.character!.profile = { traits: ["Patient", "", "Patient", "Practical", "Patient", "Unreviewed old trait"],
      relationships: ["Mira distrusts the guild.", "Mira distrusts the guild."] };
    await f.audit((item) => item.field === "traits" && item.index === 2 ? "contradicted"
      : item.field === "traits" && [4,5].includes(item.index) ? "needs_more_evidence"
      : item.field === "relationships" && item.index === 1 ? "needs_more_evidence" : "supported", stored);
    const serialized = serializeDossier({ ...stored.character });
    const visible = { ...stored, character: { aliases: serialized.aliases, summary: serialized.summary,
      role: serialized.role, profile: serialized.profile } };
    assert.deepEqual(visible.character.profile.traits, ["Patient", "Practical", "Unreviewed old trait"]);
    const result = await readEntityProseStatus(f.db, scope, visible, stored);
    const traits = result.fields.find((field) => field.field === "traits")!;
    assert.deepEqual(traits.items.map((item) => item.status), ["needs_attention", "supported", "needs_evidence"]);
    assert.equal(traits.reviewedItems, 3); assert.equal(traits.sourceCheckedItems, 1);
    assert.match(traits.items[0]!.explanation!, /reviews differ/);
    assert.deepEqual(traits.items[0]!.retrievalRequests, ["Locate the earlier scene establishing this detail."]);
    assert.equal(result.fields.find((field) => field.field === "relationships")!.items[0]!.status, "needs_evidence");
    await f.audit(() => "supported", stored);
    assert.ok((await readEntityProseStatus(f.db, scope, visible, stored)).fields.every((field) => field.status === "supported"));
    const changed = structuredClone(stored);
    changed.character!.profile = { traits: ["Practical", "", "Patient", "Patient", "Patient", "Unreviewed old trait"] };
    const changedDisplay = serializeDossier({ ...changed.character });
    const shifted = await readEntityProseStatus(f.db, scope, { ...changed, character: changedDisplay }, changed);
    assert.ok(shifted.fields.find((field) => field.field === "traits")!.items.every((item) => item.status === "not_reviewed"),
      "changing the raw sequence cannot lend old proof to a newly positioned visible row");
  } finally { await f.db.close(); }
});

test("raw projection permits new trailing text but cannot conceal an unaudited duplicate occurrence", async () => {
  const f = await fixture();
  try {
    const stored = structuredClone(f.visible);
    stored.character!.profile = { traits: ["Patient", "Patient", "Practical"] };
    await f.audit(() => "supported", stored);
    const appended = structuredClone(stored);
    appended.character!.profile = { traits: ["Patient", "Patient", "Practical", "A newly written trait"] };
    const display = serializeDossier({ ...appended.character });
    const result = await readEntityProseStatus(f.db, scope, { ...appended, character: display }, appended);
    assert.deepEqual(result.fields.find((field) => field.field === "traits")!.items.map((item) => item.status),
      ["supported", "supported", "not_reviewed"]);
    appended.character!.profile = { traits: ["Patient", "Patient", "Practical", "Patient"] };
    const duplicateDisplay = serializeDossier({ ...appended.character });
    assert.deepEqual((await readEntityProseStatus(f.db, scope, { ...appended, character: duplicateDisplay }, appended))
      .fields.find((field) => field.field === "traits")!.items.map((item) => item.status), ["not_reviewed", "supported"]);
    const modifiedDisplay = { ...display, profile: { ...display.profile, traits: ["Patient", "Practical", "Invented replacement"] } };
    assert.equal((await readEntityProseStatus(f.db, scope, { ...stored, character: modifiedDisplay }, stored))
      .fields.find((field) => field.field === "traits")!.items[2]!.status, "not_reviewed");
  } finally { await f.db.close(); }
});

test("summary proof never uses splitting, reordered sentences, substrings, or qualifier removal", async () => {
  const f = await fixture();
  try {
    for (const summary of ["Mira shelters fugitives.", "She risks arrest for them. Mira shelters fugitives.",
      "Mira shelters fugitives. She risks arrest for them. She is immortal.", "mira shelters fugitives. She risks arrest for them."]) {
      const visible = structuredClone(f.visible); visible.character!.summary = summary;
      assert.equal((await f.read(visible)).fields.find((field) => field.field === "summary")!.status, "not_reviewed");
    }
    const visible = structuredClone(f.visible); visible.character!.profile = { traits: ["patient"], secrets: ["she kept the refuge secret"], history: ["Patient"] };
    const result = await f.read(visible);
    assert.ok(result.fields.filter((field) => field.field !== "summary").every((field) => field.status === "not_reviewed"));
    await f.db.query("DELETE FROM storyhold.world_knowledge_claim_verifications WHERE claim_id IN (SELECT id FROM storyhold.world_knowledge_claims WHERE object_text='She risks arrest for them.')");
    assert.equal((await f.read()).fields.find((field) => field.field === "summary")!.status, "not_reviewed", "both joined sentences require current exact links");
  } finally { await f.db.close(); }
});

test("edited, missing, excluded, reference, and cross-edition sources cannot confer current proof", async () => {
  const f = await fixture();
  try {
    for (const [sql, args] of [
      ["UPDATE storyhold.world_source_chunks SET content=content || ' Later edited.' WHERE id=$1", [CHUNK]],
      ["DELETE FROM storyhold.world_source_chunks WHERE id=$1", [CHUNK]],
      ["UPDATE storyhold.world_source_chunks SET source_id=$2 WHERE id=$1", [CHUNK, id(99)]],
      ["UPDATE storyhold.world_source_chunks SET canon_edition_id=$2 WHERE id=$1", [CHUNK, id(99)]],
      ["UPDATE storyhold.world_sources SET canon_edition_id=$2 WHERE id=$1", [SOURCE, id(99)]],
      ["UPDATE storyhold.world_sources SET canon_status='excluded' WHERE id=$1", [SOURCE]],
      ["UPDATE storyhold.world_sources SET canon_status='reference' WHERE id=$1", [SOURCE]],
      ["UPDATE storyhold.world_sources SET source_kind='reference' WHERE id=$1", [SOURCE]],
      ["UPDATE storyhold.world_sources SET processing_status='processing' WHERE id=$1", [SOURCE]],
    ] as Array<[string, string[]]>) {
      const rollback = new Error("rollback source edit");
      await assert.rejects(f.db.transaction(async (tx) => {
        await tx.query(sql, args); assert.equal(reviewedFields(await readEntityProseStatus(tx, scope, f.visible)).length, 0, sql); throw rollback;
      }), (error: unknown) => error === rollback);
    }
    assert.equal(reviewedFields(await f.read()).length, 3);
  } finally { await f.db.close(); }
});

test("claim edits and corrupted historical journals fail closed without breaking dossier reads", async () => {
  const f = await fixture();
  try {
    const partialRollback = new Error("rollback one stale item");
    await assert.rejects(f.db.transaction(async (tx) => {
      await tx.query("UPDATE storyhold.world_knowledge_claims SET evidence='[]' WHERE object_text='Patient'");
      const result = await readEntityProseStatus(tx, scope, f.visible);
      assert.equal(result.fields.find((field) => field.field === "traits")!.verifiedItems, 1);
      assert.equal(result.fields.find((field) => field.field === "summary")!.status, "verified");
      throw partialRollback;
    }), (error: unknown) => error === partialRollback);
    for (const mutation of ["object_text='Different statement'", "predicate='dossier.history'", "polarity='negative'", "truth_status='belief'",
      `epistemic_holder_entity_id='${id(88)}'`, "valid_until_label='Later'", "evidence='[]'", "claim_status='superseded'"]) {
      const rollback = new Error("rollback claim edit");
      await assert.rejects(f.db.transaction(async (tx) => {
        await tx.query(`UPDATE storyhold.world_knowledge_claims SET ${mutation}`);
        assert.equal(reviewedFields(await readEntityProseStatus(tx, scope, f.visible)).length, 0, mutation); throw rollback;
      }), (error: unknown) => error === rollback);
    }
    await f.db.exec("ALTER TABLE storyhold.entity_review_ai_calls DISABLE TRIGGER entity_review_call_guard");
    await f.db.query("UPDATE storyhold.entity_review_ai_calls SET verification_fingerprint='corrupt'");
    assert.equal(reviewedFields(await f.read()).length, 0);
    assert.ok((await f.read()).fields.every((field) => field.status === "not_reviewed"));
  } finally { await f.db.close(); }
});

test("an unfinished or unlinked review is not current item verification", async () => {
  const f = await fixture(false);
  try {
    assert.equal(reviewedFields(await f.read()).length, 0);
    await f.db.transaction((tx) => finalizeEntityReviewCall(tx, scope, { reviewed: true, entityId: scope.entityId }));
    assert.equal(reviewedFields(await f.read()).length, 3);
    await f.db.query("DELETE FROM storyhold.world_knowledge_claim_verifications");
    assert.equal(reviewedFields(await f.read()).length, 0, "a completed paid call by itself supplies no item proof");
  } finally { await f.db.close(); }
});

test("owner and field controls are read from current canon and secrets stay owner-scoped", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.read(f.visible, { ...scope, playerId: id(999) }), { fields: [] });
    assert.deepEqual(await f.read(f.visible, { ...scope, editionId: id(999) }), { fields: [] });
    assert.equal((await f.read({ ...f.visible, authorControlled: true })).fields[0]!.status, "verified", "stale caller flag cannot mislabel owner authority");
    for (const sql of ["UPDATE storyhold.world_entities SET classification_source='user'", "UPDATE storyhold.world_entities SET review_status='user_confirmed'",
      "UPDATE storyhold.character_dossiers SET user_edited_at=now()"] ) {
      const rollback = new Error("rollback owner control");
      await assert.rejects(f.db.transaction(async (tx) => {
        await tx.query(sql); const result = await readEntityProseStatus(tx, scope, f.visible);
        assert.ok(result.fields.every((field) => field.status === "author_controlled" && field.verifiedItems === 0));
        assert.ok(result.fields.flatMap((field) => field.items).every((item) => item.evidence.length === 0 && item.confidence === undefined)); throw rollback;
      }), (error: unknown) => error === rollback);
    }
    await f.db.query("UPDATE storyhold.world_knowledge_claims SET assignment_source='user' WHERE predicate='dossier.traits'");
    const fields = (await f.read()).fields;
    assert.equal(fields.find((field) => field.field === "traits")!.status, "author_controlled");
    assert.equal(fields.find((field) => field.field === "summary")!.status, "verified");
    await f.db.query("UPDATE storyhold.world_knowledge_claims SET predicate='dossier.moralsystem' WHERE object_text='Patient'");
    const visible = structuredClone(f.visible);
    visible.character!.profile = { moralSystem: ["The owner's moral outlook."] };
    assert.equal((await f.read(visible)).fields.find((field) => field.field === "moralSystem")!.status, "author_controlled");
  } finally { await f.db.close(); }
});

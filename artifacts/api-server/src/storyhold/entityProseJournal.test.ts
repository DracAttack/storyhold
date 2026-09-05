import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { getAiRuntimeStatus, type AiTextResult } from "./aiGateway";
import { canonPayloadFingerprint, type JsonObject } from "./analysisVerificationContracts";
import { buildEntityGraphRequest, validateEntityGraphReview } from "./entityGraphVerification";
import { buildEntityProseRequest, validateEntityProseReview } from "./entityProseVerification";
import { ensureEntityReviewClaimLinks, syncEntityVerifiedProse } from "./entityProseJournal";
import type { EntityReviewInput } from "./entityReview";
import { ensureEntityReviewJournal, executeJournaledEntityReviewPages, finalizeEntityReviewCall,
  readEntityReviewCall, saveEntityReviewVerificationBundle, type EntityReviewCallScope } from "./entityReviewJournal";
import { prepareEntityReviewPages } from "./entityReviewPages";
import { ensurePremiumClaimJournal, savePremiumClaimReview } from "./premiumClaimJournal";
import { buildPremiumClaimRequest, validatePremiumClaimResponse, type PremiumClaimPayload } from "./premiumClaimVerification";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope: EntityReviewCallScope = { reviewId: id(1), playerId: id(2), worldId: id(3), editionId: id(4), entityId: id(5) };
const DOSSIER = id(6), HOLDER = id(7), CHUNK = id(8), SOURCE = id(9), LEGACY_RUN = id(10);
const quote = "Mira shelters fugitives. Marek believes the bridge is unsafe. Mira never disclosed the refuge. They call Mira the Warden.";
const evidence = [{ chunkId: CHUNK, sourceId: SOURCE, quote }];
const hash = (value: unknown) => canonPayloadFingerprint(value as JsonObject);
const claim = (changes: Partial<PremiumClaimPayload> = {}): PremiumClaimPayload => ({ subject: "Mira", predicate: "dossier.summary",
  value: "Mira shelters fugitives.", polarity: "positive", epistemicHolder: "", truthStatus: "fact", validFromLabel: "", validUntilLabel: "", ...changes });
const defaults = () => [claim(),
  claim({ predicate: "dossier.knowledge", value: "the bridge is unsafe", epistemicHolder: "Marek", truthStatus: "belief", validFromLabel: "Book Two" }),
  claim({ predicate: "dossier.secrets", value: "Mira disclosed the refuge", polarity: "negative", validUntilLabel: "Book Two" }),
  claim({ predicate: "dossier.aliases", value: "The Warden" })];

function input(): EntityReviewInput {
  return { worldName: "The Refuge", worldGenre: "Fantasy", worldPremise: "A hidden refuge", depth: "full", proseReview: { version: 1 },
    premiumStatScope: { worldId: scope.worldId, editionId: scope.editionId, analysisRunId: scope.reviewId },
    entity: { id: scope.entityId, name: "Mira", entityType: "character", aliases: ["Captain Mira"], summary: "", details: [], relationships: [] },
    chunks: [{ id: CHUNK, sourceId: SOURCE, content: quote, sourceTitle: "Book Two", index: 0 }],
    knownEntities: [{ name: "Mira", entityType: "character", aliases: ["Captain Mira"] }, { name: "Marek", entityType: "character", aliases: [] }],
    ownerCanonConstraints: [{ id: id(20), kind: "fact", instruction: "Mira has never disclosed the refuge." }],
    graphReview: { version: 2, relations: [], rules: [], entities: [
      { id: scope.entityId, name: "Mira", entityType: "character", aliases: ["Captain Mira"] },
      { id: HOLDER, name: "Marek", entityType: "character", aliases: [] }] },
  };
}
function rawProse(reviewInput: EntityReviewInput, claims = defaults(), rejected = false) {
  const request = buildEntityProseRequest(reviewInput)!;
  return { claims: [], character: null, claimVerification: { requestFingerprint: request.fingerprint, decisions: [],
    newClaims: claims.map((value) => ({ claim: value, verdict: rejected ? "rejected" : "verified", explanation: "The manuscript supplies this exact account.",
      confidence: 0.9, supportingEvidence: rejected ? [] : [{ chunkId: CHUNK, quote }], contradictingEvidence: [], retrievalRequests: [] })) },
    prosePresentation: { displayOrder: rejected ? [] : claims.map((_value, index) => index).reverse() } };
}
async function fixture(claims = defaults(), rejected = false) {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.players(id uuid PRIMARY KEY,role text DEFAULT 'admin');
      CREATE TABLE storyhold.credit_reservations(id uuid PRIMARY KEY,operation text,request_id text);
      CREATE TABLE storyhold.world_analysis_runs(id uuid PRIMARY KEY,world_id uuid,canon_edition_id uuid,analysis_kind text DEFAULT 'ai_enrichment');
      CREATE TABLE storyhold.character_dossiers(id uuid PRIMARY KEY,world_id uuid,canon_edition_id uuid,user_edited_at timestamptz);
      CREATE TABLE storyhold.world_entities(id uuid PRIMARY KEY,world_id uuid,canon_edition_id uuid,name text,entity_type text DEFAULT 'character',
        aliases jsonb DEFAULT '[]',pull_status text DEFAULT 'active',scanner_present boolean DEFAULT true,merged_into_entity_id uuid,
        classification_source text DEFAULT 'local',review_status text DEFAULT 'candidate',dossier_id uuid);
      CREATE TABLE storyhold.world_knowledge_claims(id uuid PRIMARY KEY,world_id uuid,canon_edition_id uuid,
        source_analysis_run_id uuid REFERENCES storyhold.world_analysis_runs(id),supersedes_claim_id uuid,
        fingerprint text,subject_entity_id uuid,predicate text,polarity text DEFAULT 'positive',object_entity_id uuid,object_text text,
        epistemic_holder_entity_id uuid,truth_status text,valid_from_label text DEFAULT '',valid_until_label text DEFAULT '',summary text DEFAULT '',
        evidence jsonb DEFAULT '[]',confidence real DEFAULT 0,claim_status text DEFAULT 'active',assignment_source text DEFAULT 'ai',
        created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),UNIQUE(world_id,canon_edition_id,fingerprint));`);
    await ensureEntityReviewJournal(db); await ensurePremiumClaimJournal(db); await ensureEntityReviewClaimLinks(db);
    await db.query("INSERT INTO storyhold.players(id) VALUES($1)", [scope.playerId]);
    await db.query("INSERT INTO storyhold.character_dossiers(id,world_id,canon_edition_id) VALUES($1,$2,$3)", [DOSSIER, scope.worldId, scope.editionId]);
    await db.query(`INSERT INTO storyhold.world_entities(id,world_id,canon_edition_id,name,aliases,dossier_id)
      VALUES($1,$3,$4,'Mira','["Captain Mira"]',$5),($2,$3,$4,'Marek','[]',NULL)`, [scope.entityId, HOLDER, scope.worldId, scope.editionId, DOSSIER]);
    const reviewInput = input(); const page = prepareEntityReviewPages(reviewInput).pages[0]!;
    const graph = buildEntityGraphRequest(page.input)!;
    const raw = { ...rawProse(reviewInput, claims, rejected), relations: [], rules: [], entityRelations: [], entityRules: [],
      graphVerification: { requestFingerprint: graph.fingerprint, decisions: [], newFindings: [] } };
    let calls = 0;
    const completed = await executeJournaledEntityReviewPages(db, { scope, reservationId: null,
      contextSnapshot: { version: 1, input: reviewInput } as unknown as JsonObject,
      pages: [{ stepKey: page.stepKey, provider: "openrouter", model: "offline-test", request: { task: "canon_review", stage: "dossier",
        system: "Verify supplied claims.", messages: [{ role: "user", content: quote }], allowProviderFallback: false, providerFailurePolicy: "stop" } }],
      invoke: async () => { calls++; return { text: JSON.stringify(raw), provider: "openrouter", model: "offline-test", reasoning: "high",
        usage: { inputUnits: 100, outputUnits: 100, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 0,
          estimatedCostMicros: 100, pricingKnown: true, pricingVersion: "fixture", costEstimated: false },
        runtime: getAiRuntimeStatus("canon_review", "standard", "dossier") } satisfies AiTextResult; } });
    const first = completed.entityReviewPages[0]!.result;
    const verifier = { provider: first.provider, model: first.model, completedAt: first.journalCompletedAt! };
    const prose = validateEntityProseReview(reviewInput, raw, verifier)!;
    const graphs = [validateEntityGraphReview(page.input, raw, verifier)!];
    const saveBundle = () => db.transaction((tx) => saveEntityReviewVerificationBundle(tx, scope, { version: 3, graphs, prose }));
    const apply = () => db.transaction((tx) => syncEntityVerifiedProse(tx, scope, prose));
    return { db, reviewInput, raw, prose, graphs, verifier, saveBundle, apply, calls: () => calls };
  } catch (error) { await db.close(); throw error; }
}

test("dossier prose writes exact fact/belief/negative/time identities and real paid-call links once", async () => {
  const f = await fixture();
  try {
    await f.db.query("UPDATE storyhold.world_entities SET scanner_present=false,classification_source='user' WHERE id=$1", [HOLDER]);
    await f.saveBundle(); const result = await f.apply();
    assert.equal(result.claimsSaved, 4); assert.equal(result.linksCreated, 4); assert.equal(result.appliedProposalIds.size, 4);
    assert.deepEqual([...result.appliedProposalIds].sort(), [...f.prose.displayOrder].sort());
    const rows = (await f.db.query<Record<string, unknown>>("SELECT * FROM storyhold.world_knowledge_claims ORDER BY predicate")).rows;
    assert.equal(rows.length, 4); assert.ok(rows.every((row) => row.source_analysis_run_id === null && row.object_entity_id === null));
    const belief = rows.find((row) => row.predicate === "dossier.knowledge")!;
    assert.equal(belief.epistemic_holder_entity_id, HOLDER); assert.equal(belief.truth_status, "belief");
    assert.equal(belief.valid_from_label, "Book Two"); assert.equal(belief.object_text, "the bridge is unsafe");
    const negative = rows.find((row) => row.predicate === "dossier.secrets")!;
    assert.equal(negative.polarity, "negative"); assert.equal(negative.valid_until_label, "Book Two");
    assert.deepEqual(negative.evidence, evidence);
    const links = (await f.db.query<Record<string, unknown>>("SELECT * FROM storyhold.world_knowledge_claim_verifications")).rows;
    assert.ok(links.every((link) => link.run_id === null && link.entity_review_id === scope.reviewId && link.step_key === "dossier_prose:0"));
    assert.equal((await f.db.query("SELECT * FROM storyhold.world_analysis_runs")).rows.length, 0);
    const repeat = await f.apply(); assert.equal(repeat.linksCreated, 0); assert.equal(repeat.appliedClaimIds.length, 4); assert.equal(f.calls(), 1);
    await assert.rejects(f.db.query("UPDATE storyhold.world_knowledge_claim_verifications SET decision_id='changed'"), /immutable/);
  } finally { await f.db.close(); }
});

test("normalized fingerprints cannot authorize changed exact prose or a conflicting application link", async () => {
  const f = await fixture([claim()]);
  try {
    await f.saveBundle(); await f.apply();
    await f.db.query("UPDATE storyhold.world_knowledge_claims SET object_text='mira shelters fugitives.'");
    await assert.rejects(f.apply(), /saved claim no longer matches/);
    assert.equal((await f.db.query("SELECT * FROM storyhold.world_knowledge_claim_verifications")).rows.length, 1);
    await f.db.query("UPDATE storyhold.world_knowledge_claims SET object_text='Mira shelters fugitives.'");
    await f.db.exec("ALTER TABLE storyhold.world_knowledge_claim_verifications DISABLE TRIGGER premium_claim_verification_link_immutable");
    await f.db.query("UPDATE storyhold.world_knowledge_claim_verifications SET decision_id='different-decision'");
    await f.db.exec("ALTER TABLE storyhold.world_knowledge_claim_verifications ENABLE TRIGGER premium_claim_verification_link_immutable");
    await assert.rejects(f.apply(), /different immutable prose application link/);
    assert.equal(f.calls(), 1);
  } finally { await f.db.close(); }
});

test("a full older evidence list cannot silently drop the paid review's supporting passages", async () => {
  const f = await fixture([claim()]);
  try {
    await f.saveBundle(); await f.apply();
    await f.db.query("DELETE FROM storyhold.world_knowledge_claim_verifications");
    const olderEvidence = Array.from({ length: 30 }, (_value, index) => ({ chunkId: id(100 + index), sourceId: SOURCE,
      quote: `Older documented support number ${index} for the refuge.` }));
    await f.db.query("UPDATE storyhold.world_knowledge_claims SET evidence=$1::jsonb", [JSON.stringify(olderEvidence)]);
    const before = (await f.db.query("SELECT * FROM storyhold.world_knowledge_claims")).rows;
    await assert.rejects(f.apply(), /retain all of its supporting passages/);
    assert.deepEqual((await f.db.query("SELECT * FROM storyhold.world_knowledge_claims")).rows, before);
    assert.equal((await f.db.query("SELECT * FROM storyhold.world_knowledge_claim_verifications")).rows.length, 0);
    assert.equal((await readEntityReviewCall(f.db, scope))?.status, "completed");
    assert.equal((await readEntityReviewCall(f.db, scope))?.finalization_snapshot, null);
    assert.equal(f.calls(), 1);
  } finally { await f.db.close(); }
});

test("owner-owned fields and user-edited dossiers cannot become AI prose even when verified", async () => {
  const f = await fixture();
  try {
    await f.saveBundle();
    await f.db.query(`INSERT INTO storyhold.world_knowledge_claims(id,world_id,canon_edition_id,fingerprint,subject_entity_id,predicate,
      object_text,truth_status,assignment_source) VALUES($1,$2,$3,'owner-fact',$4,'dossier.summary','The author controls this sentence.','fact','user')`,
    [id(30), scope.worldId, scope.editionId, scope.entityId]);
    const ownerBefore = (await f.db.query("SELECT * FROM storyhold.world_knowledge_claims WHERE id=$1", [id(30)])).rows;
    const result = await f.apply(); assert.equal(result.claimsSaved, 3); assert.equal(result.appliedProposalIds.size, 3);
    assert.ok(result.warnings.some((warning) => warning.includes("summary")));
    const summaryId = f.prose.projection.find((item) => item.field === "summary")!.proposalId;
    assert.equal(result.appliedProposalIds.has(summaryId), false);
    assert.deepEqual((await f.db.query("SELECT * FROM storyhold.world_knowledge_claims WHERE id=$1", [id(30)])).rows, ownerBefore);
    for (const mutation of ["UPDATE storyhold.world_entities SET classification_source='user' WHERE id=$1",
      "UPDATE storyhold.world_entities SET review_status='user_confirmed' WHERE id=$1",
      "UPDATE storyhold.character_dossiers SET user_edited_at=now() WHERE id=$1"]) {
      const rollback = new Error("rollback owner marker");
      await assert.rejects(f.db.transaction(async (tx) => {
        await tx.query(mutation, [mutation.includes("character_dossiers") ? DOSSIER : scope.entityId]);
        const blocked = await syncEntityVerifiedProse(tx, scope, f.prose);
        assert.equal(blocked.claimsSaved, 0); assert.equal(blocked.appliedProposalIds.size, 0); assert.ok(blocked.warnings.length);
        throw rollback;
      }), (error: unknown) => error === rollback);
    }
  } finally { await f.db.close(); }
});

test("saved proof is mandatory, and substituted, stale, foreign, or finalized authority cannot write claims", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.apply(), /exact saved private/);
    await f.saveBundle();
    const other = validateEntityProseReview(f.reviewInput, rawProse(f.reviewInput, [claim({ value: "Mira gives shelter to fugitives." })]), f.verifier)!;
    await assert.rejects(f.db.transaction((tx) => syncEntityVerifiedProse(tx, scope, other)), /exact saved private/);
    await assert.rejects(f.db.transaction((tx) => syncEntityVerifiedProse(tx, { ...scope, entityId: HOLDER }, f.prose)), /different scope/);
    for (const mutation of ["name='Different Mira'", "aliases='[\"New Alias\"]'", "pull_status='hidden'", "scanner_present=false",
      "entity_type='technology'", `merged_into_entity_id='${HOLDER}'`]) {
      const rollback = new Error("rollback changed registry");
      await assert.rejects(f.db.transaction(async (tx) => {
        await tx.query(`UPDATE storyhold.world_entities SET ${mutation} WHERE id=$1`, [scope.entityId]);
        await assert.rejects(syncEntityVerifiedProse(tx, scope, f.prose), /frozen prose-review identity/); throw rollback;
      }), (error: unknown) => error === rollback);
    }
    assert.equal((await f.db.query("SELECT * FROM storyhold.world_knowledge_claims")).rows.length, 0);
    await f.db.transaction((tx) => finalizeEntityReviewCall(tx, scope, { reviewed: false }));
    await assert.rejects(f.apply(), /unfinalized completed/);
  } finally { await f.db.close(); }
});

test("all rejected claims remain private audit and a late failure rolls back all canon links", async () => {
  const f = await fixture(defaults(), true);
  try {
    await f.saveBundle(); const result = await f.apply();
    assert.equal(result.claimsSaved, 0); assert.equal(result.linksCreated, 0); assert.equal(result.appliedProposalIds.size, 0);
    assert.equal((await f.db.query("SELECT * FROM storyhold.world_knowledge_claims")).rows.length, 0);
    assert.equal((await readEntityReviewCall(f.db, scope))?.verification_snapshot?.version, 3);
  } finally { await f.db.close(); }
  const verified = await fixture();
  try {
    await assert.rejects(verified.db.transaction(async (tx) => {
      await saveEntityReviewVerificationBundle(tx, scope, { version: 3, graphs: verified.graphs, prose: verified.prose });
      assert.equal((await syncEntityVerifiedProse(tx, scope, verified.prose)).linksCreated, 4);
      throw new Error("Late canonical save failed");
    }), /Late canonical save/);
    assert.equal((await verified.db.query("SELECT * FROM storyhold.world_knowledge_claims")).rows.length, 0);
    assert.equal((await verified.db.query("SELECT * FROM storyhold.world_knowledge_claim_verifications")).rows.length, 0);
    assert.equal((await readEntityReviewCall(verified.db, scope))?.verification_snapshot, null);
    await verified.saveBundle(); assert.equal((await verified.apply()).linksCreated, 4); assert.equal(verified.calls(), 1);
  } finally { await verified.db.close(); }
});

test("claim-link migration is idempotent, retains legacy run proofs and enforces exactly one real authority", async () => {
  const f = await fixture();
  try {
    await f.saveBundle(); await f.apply();
    await f.db.query("INSERT INTO storyhold.world_analysis_runs(id,world_id,canon_edition_id) VALUES($1,$2,$3)", [LEGACY_RUN, scope.worldId, scope.editionId]);
    const request = buildPremiumClaimRequest({ scope: { worldId: scope.worldId, editionId: scope.editionId, analysisRunId: LEGACY_RUN },
      stepKey: "verification:0", chunks: [{ id: CHUNK, sourceId: SOURCE, text: quote }], claims: [], context: {} });
    const legacy = validatePremiumClaimResponse(request, { claims: [], claimVerification: { requestFingerprint: request.fingerprint,
      decisions: [], newClaims: [] } }, f.verifier);
    await savePremiumClaimReview(f.db, legacy);
    const claimId = (await f.db.query<{ id: string }>("SELECT id FROM storyhold.world_knowledge_claims LIMIT 1")).rows[0]!.id;
    await f.db.query(`INSERT INTO storyhold.world_knowledge_claim_verifications(claim_id,run_id,step_key,proposal_id,decision_id,payload_fingerprint)
      VALUES($1,$2,'verification:0','legacy-proposal','legacy-decision','legacy-payload')`, [claimId, LEGACY_RUN]);
    const before = (await f.db.query("SELECT * FROM storyhold.world_knowledge_claim_verifications ORDER BY proposal_id")).rows;
    await ensureEntityReviewClaimLinks(f.db); await ensurePremiumClaimJournal(f.db); await ensureEntityReviewClaimLinks(f.db);
    assert.deepEqual((await f.db.query("SELECT * FROM storyhold.world_knowledge_claim_verifications ORDER BY proposal_id")).rows, before);
    for (const [run, review] of [[null, null], [LEGACY_RUN, scope.reviewId], [null, id(999)]]) {
      await assert.rejects(f.db.query(`INSERT INTO storyhold.world_knowledge_claim_verifications
        (claim_id,run_id,entity_review_id,step_key,proposal_id,decision_id,payload_fingerprint)
        VALUES($1,$2,$3,'verification:0','invalid','invalid','invalid')`, [claimId, run, review]), /constraint/);
    }
    assert.equal(hash((await f.db.query("SELECT snapshot FROM storyhold.world_analysis_claim_reviews WHERE run_id=$1", [LEGACY_RUN])).rows[0]!.snapshot), hash(legacy));
  } finally { await f.db.close(); }
});

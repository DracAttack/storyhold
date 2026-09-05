import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { getAiRuntimeStatus, type AiTextResult } from "./aiGateway";
import type { JsonObject } from "./analysisVerificationContracts";
import { buildEntityGraphRequest, validateEntityGraphReview } from "./entityGraphVerification";
import { buildEntityProseRequest, validateEntityProseReview } from "./entityProseVerification";
import { buildExistingProseInventory } from "./entityExistingProseReview";
import { approvedEntityCompassEstimate, buildEntityCompassRequest, validateEntityCompassReview,
  type EntityCompassEstimate, type EntityCompassVerdict } from "./entityCompassVerification";
import { EntityCompassPersistenceError, readEntityCompassStatus, syncEntityVerifiedCompass } from "./entityCompassPersistence";
import type { EntityReviewInput } from "./entityReview";
import { ensureEntityReviewJournal, executeJournaledEntityReviewPages, finalizeEntityReviewCall,
  readEntityReviewCall, saveEntityReviewVerificationBundle, type EntityReviewCallScope } from "./entityReviewJournal";
import { prepareEntityReviewPages } from "./entityReviewPages";
import { premiumNeutralStats } from "./premiumStatCandidates";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { playerId: id(2), worldId: id(3), editionId: id(4), entityId: id(5) };
const DOSSIER = id(6), CHUNK = id(7), SOURCE = id(8), HOLDER = id(9);
const quote = "Mira shared the stores equally and let each household refuse the council's orders. Until the siege she opposed centralized rule. Tomas called her a stubborn collectivist.";
const oldAxis = { economic: 0, authority: 0, label: "Undetermined", rationale: "No supported interpretation yet.", confidence: 0 };
const estimate: EntityCompassEstimate = { economic: -45, authority: -35, label: "Mutual aid with local autonomy",
  rationale: "Before the siege, Mira shared resources and allowed households to refuse collective orders.",
  validFromLabel: "Before the siege", validUntilLabel: "The siege", perspective: "demonstrated_behavior", epistemicHolderId: null };
const errorCode = (code: string) => (error: unknown) => error instanceof EntityCompassPersistenceError && error.code === code;

async function fixture() {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.worlds(id uuid PRIMARY KEY,owner_player_id uuid);
      CREATE TABLE storyhold.players(id uuid PRIMARY KEY,role text DEFAULT 'admin');
      CREATE TABLE storyhold.credit_reservations(id uuid PRIMARY KEY,operation text,request_id text);
      CREATE TABLE storyhold.character_dossiers(id uuid PRIMARY KEY,world_id uuid,canon_edition_id uuid,name text,
        dossier_status text DEFAULT 'active',axis_estimate jsonb DEFAULT '{}',axis_user_override jsonb,user_edited_at timestamptz,
        profile jsonb DEFAULT '{"traits":["Original prose"]}',updated_at timestamptz DEFAULT now());
      CREATE TABLE storyhold.world_entities(id uuid PRIMARY KEY,world_id uuid,canon_edition_id uuid,name text,entity_type text DEFAULT 'character',
        pull_status text DEFAULT 'active',merged_into_entity_id uuid,scanner_present boolean DEFAULT true,
        classification_source text DEFAULT 'local',review_status text DEFAULT 'candidate',dossier_id uuid);
      CREATE TABLE storyhold.world_sources(id uuid PRIMARY KEY,world_id uuid,canon_edition_id uuid,processing_status text DEFAULT 'ready',
        canon_status text DEFAULT 'canon',source_kind text DEFAULT 'manuscript');
      CREATE TABLE storyhold.world_source_chunks(id uuid PRIMARY KEY,source_id uuid,world_id uuid,canon_edition_id uuid,content text);`);
    await ensureEntityReviewJournal(db);
    await db.query("INSERT INTO storyhold.worlds VALUES($1,$2)", [scope.worldId, scope.playerId]);
    await db.query("INSERT INTO storyhold.players(id) VALUES($1)", [scope.playerId]);
    await db.query("INSERT INTO storyhold.character_dossiers(id,world_id,canon_edition_id,name,axis_estimate) VALUES($1,$2,$3,'Mira',$4::jsonb)",
      [DOSSIER, scope.worldId, scope.editionId, JSON.stringify(oldAxis)]);
    await db.query("INSERT INTO storyhold.world_entities(id,world_id,canon_edition_id,name,dossier_id) VALUES($1,$2,$3,'Mira',$4)", [scope.entityId, scope.worldId, scope.editionId, DOSSIER]);
    await db.query("INSERT INTO storyhold.world_sources(id,world_id,canon_edition_id) VALUES($1,$2,$3)", [SOURCE, scope.worldId, scope.editionId]);
    await db.query("INSERT INTO storyhold.world_source_chunks VALUES($1,$2,$3,$4,$5)", [CHUNK, SOURCE, scope.worldId, scope.editionId, quote]);
    let nextReview = 100, calls = 0;
    const row = async () => (await db.query<{ axis_estimate: unknown; axis_user_override: unknown; profile: unknown }>("SELECT axis_estimate,axis_user_override,profile FROM storyhold.character_dossiers WHERE id=$1", [DOSSIER])).rows[0]!;
    async function review(verdict: EntityCompassVerdict = "supported", options: { proposed?: EntityCompassEstimate; frozenOverride?: unknown } = {}) {
      const usedScope: EntityReviewCallScope = { ...scope, reviewId: id(nextReview++) };
      const current = await row();
      const input: EntityReviewInput = { worldName: "Refuge", worldPremise: "A hidden refuge", worldGenre: "Fantasy", depth: "full",
        proseReview: { version: 1 }, existingProseReview: buildExistingProseInventory({}),
        compassReview: { version: 1, currentEstimate: current.axis_estimate, ownerOverride: options.frozenOverride ?? current.axis_user_override },
        premiumStatScope: { worldId: scope.worldId, editionId: scope.editionId, analysisRunId: usedScope.reviewId },
        entity: { id: scope.entityId, name: "Mira", entityType: "character", aliases: [], summary: "", details: [], relationships: [] },
        currentCharacter: { name: "Mira", aliases: [], role: "", summary: "", traits: [], motivations: [], fears: [], capabilities: [], history: [], origins: [], powers: [],
          moralSystem: [], physicalCharacteristics: [], relationships: [], relationshipWeb: [], knowledge: [], secrets: [], factionMemberships: [],
          evidence: [], confidence: 0, estimatedStats: premiumNeutralStats(), socioPoliticalAxis: oldAxis },
        chunks: [{ id: CHUNK, sourceId: SOURCE, content: quote, sourceTitle: "The Book", index: 0 }],
        knownEntities: [{ name: "Mira", entityType: "character", aliases: [] }, { name: "Tomas", entityType: "character", aliases: [] }],
        graphReview: { version: 2, relations: [], rules: [], entities: [{ id: scope.entityId, name: "Mira", entityType: "character", aliases: [] },
          { id: HOLDER, name: "Tomas", entityType: "character", aliases: [] }] } };
      const proposed = options.proposed ?? estimate;
      const compassRaw = { requestFingerprint: buildEntityCompassRequest(input)!.fingerprint, verdict,
        estimate: verdict === "supported" ? proposed : null, explanation: "This is a time-bounded interpretation, not objective canon.", confidence: 0.83,
        supportingEvidence: verdict === "supported" ? [{ chunkId: CHUNK, quote, axes: ["economic", "authority"],
          perspective: proposed.perspective === "mixed" ? "demonstrated_behavior" : proposed.perspective }] : [],
        contradictingEvidence: verdict === "disputed" ? [{ chunkId: CHUNK, quote, axes: ["authority"], perspective: "demonstrated_behavior" }] : [],
        retrievalRequests: verdict === "supported" ? [] : ["Find Mira's later views after the siege."] };
      const page = prepareEntityReviewPages(input).pages[0]!;
      const raw = { claims: [], character: null,
        claimVerification: { requestFingerprint: buildEntityProseRequest(input)!.fingerprint, decisions: [], newClaims: [] },
        prosePresentation: { displayOrder: [] }, relations: [], rules: [], entityRelations: [], entityRules: [],
        graphVerification: { requestFingerprint: buildEntityGraphRequest(page.input)!.fingerprint, decisions: [], newFindings: [] }, compassVerification: compassRaw };
      const completed = await executeJournaledEntityReviewPages(db, { scope: usedScope, reservationId: null,
        contextSnapshot: { version: 1, input, entityRow: { id: scope.entityId, dossier_id: DOSSIER } } as unknown as JsonObject,
        pages: [{ stepKey: page.stepKey, provider: "openrouter", model: "private-compass-model",
          request: { task: "canon_review", stage: "dossier", system: "OFFLINE TEST ONLY", messages: [{ role: "user", content: quote }],
            allowProviderFallback: false, providerFailurePolicy: "stop" } }],
        invoke: async () => { calls++; return { text: JSON.stringify(raw), provider: "openrouter", model: "private-compass-model", reasoning: "high",
          usage: { inputUnits: 100, outputUnits: 100, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 0,
            estimatedCostMicros: 100, pricingKnown: true, pricingVersion: "fixture", costEstimated: false },
          runtime: getAiRuntimeStatus("canon_review", "standard", "dossier") } satisfies AiTextResult; } });
      const verifier = { provider: "openrouter", model: "private-compass-model", completedAt: completed.entityReviewPages[0]!.result.journalCompletedAt! };
      const receipt = validateEntityCompassReview(input, raw, verifier)!;
      const bundle = { version: 5 as const, graphs: [validateEntityGraphReview(page.input, raw, verifier)!],
        prose: validateEntityProseReview(input, raw, verifier)!, existingProse: [], compass: receipt };
      const saveProof = () => db.transaction((tx) => saveEntityReviewVerificationBundle(tx, usedScope, bundle));
      const apply = () => db.transaction(async (tx) => {
        await saveEntityReviewVerificationBundle(tx, usedScope, bundle);
        const outcome = await syncEntityVerifiedCompass(tx, usedScope, receipt);
        await finalizeEntityReviewCall(tx, usedScope, { reviewed: true, entityId: scope.entityId });
        return outcome;
      });
      return { input, raw, verifier, receipt, bundle, scope: usedScope, saveProof, apply };
    }
    return { db, review, row, calls: () => calls, status: () => readEntityCompassStatus(db, scope) };
  } catch (error) { await db.close(); throw error; }
}

test("only exact supported paid compass interpretation persists, losslessly and without touching prose", async () => {
  const f = await fixture();
  try {
    const reviewed = await f.review(); const before = await f.row();
    await assert.rejects(f.db.transaction(async (tx) => {
      await saveEntityReviewVerificationBundle(tx, reviewed.scope, reviewed.bundle);
      assert.equal((await syncEntityVerifiedCompass(tx, reviewed.scope, reviewed.receipt)).saved, true);
      await finalizeEntityReviewCall(tx, reviewed.scope, { reviewed: true, entityId: scope.entityId });
      throw new Error("Later canonical write failed");
    }), /Later canonical write failed/);
    assert.deepEqual(await f.row(), before); assert.equal((await readEntityReviewCall(f.db, reviewed.scope))?.verification_snapshot, null);
    const saved = await reviewed.apply(); assert.deepEqual(saved, { saved: true, dossierId: DOSSIER, warnings: [] });
    const approved = approvedEntityCompassEstimate(reviewed.input, reviewed.receipt)!;
    assert.deepEqual((await f.row()).axis_estimate, approved); assert.deepEqual((await f.row()).profile, before.profile);
    const status = await f.status(); assert.equal(status.status, "supported"); assert.deepEqual(status.estimate, approved);
    assert.equal(status.estimate!.validUntilLabel, "The siege"); assert.deepEqual(status.evidence[0]!.axes, approved.evidence[0]!.axes);
    assert.equal(f.calls(), 1); assert.deepEqual(await f.status(), status);
    for (const privateValue of ["openrouter", "private-compass-model", reviewed.scope.reviewId, "requestFingerprint"]) assert.ok(!JSON.stringify(status).includes(privateValue));
  } finally { await f.db.close(); }
});

test("missing or substituted private receipt cannot save a compass", async () => {
  const f = await fixture();
  try {
    const reviewed = await f.review();
    await assert.rejects(f.db.transaction((tx) => syncEntityVerifiedCompass(tx, reviewed.scope, reviewed.receipt)), errorCode("COMPASS_RECEIPT_MISMATCH"));
    await reviewed.saveProof();
    const forged = validateEntityCompassReview(reviewed.input, { ...reviewed.raw, compassVerification: {
      ...reviewed.raw.compassVerification, estimate: { ...estimate, economic: -70 },
    } }, reviewed.verifier)!;
    await assert.rejects(f.db.transaction((tx) => syncEntityVerifiedCompass(tx, reviewed.scope, forged)), errorCode("COMPASS_RECEIPT_MISMATCH"));
    assert.deepEqual((await f.row()).axis_estimate, oldAxis);
  } finally { await f.db.close(); }
});

test("compass journals cannot downgrade their proof or finalize without the actual first-page compass", async () => {
  const f = await fixture();
  try {
    const reviewed = await f.review();
    const call = await readEntityReviewCall(f.db, reviewed.scope);
    assert.equal(call!.request_snapshot.version, "storyhold:entity-review-request:v4");
    await assert.rejects(f.db.transaction((tx) => finalizeEntityReviewCall(tx, reviewed.scope,
      { reviewed: true, entityId: scope.entityId })), /complete saved graph and prose verification proof/);
    const { compass: _compass, ...oldBundle } = reviewed.bundle;
    await assert.rejects(f.db.transaction((tx) => saveEntityReviewVerificationBundle(tx, reviewed.scope,
      { ...oldBundle, version: 4 })), /does not match its saved provider response and context/);
    const substituted = validateEntityCompassReview(reviewed.input, { ...reviewed.raw, compassVerification: {
      ...reviewed.raw.compassVerification, estimate: { ...estimate, economic: -70 },
    } }, reviewed.verifier)!;
    await assert.rejects(f.db.transaction((tx) => saveEntityReviewVerificationBundle(tx, reviewed.scope,
      { ...reviewed.bundle, compass: substituted })), /does not match its saved provider response and context/);
    assert.equal((await readEntityReviewCall(f.db, reviewed.scope))!.verification_snapshot, null);
    assert.deepEqual((await f.row()).axis_estimate, oldAxis);
    await reviewed.apply();
    assert.equal((await f.status()).status, "supported");
    assert.equal(f.calls(), 1, "Proof rejection and safe replay must not dispatch a second provider request");
  } finally { await f.db.close(); }
});

test("current source scope, text and readiness are rechecked before compass persistence", async () => {
  const f = await fixture();
  try {
    const reviewed = await f.review(); await reviewed.saveProof();
    for (const sql of ["UPDATE storyhold.world_source_chunks SET content='Different source text'",
      `UPDATE storyhold.world_source_chunks SET canon_edition_id='${id(60)}'`,
      `UPDATE storyhold.world_sources SET world_id='${id(61)}'`, "UPDATE storyhold.world_sources SET processing_status='pending'",
      "UPDATE storyhold.world_sources SET source_kind='reference'"]) {
      await assert.rejects(f.db.transaction(async (tx) => { await tx.query(sql); await syncEntityVerifiedCompass(tx, reviewed.scope, reviewed.receipt); }), errorCode("COMPASS_SOURCE_STALE"));
    }
    assert.deepEqual((await f.row()).axis_estimate, oldAxis);
  } finally { await f.db.close(); }
});

test("stale target identity, dossier relinking, and intervening axis changes block the write", async () => {
  const f = await fixture();
  try {
    const reviewed = await f.review(); await reviewed.saveProof();
    for (const sql of ["UPDATE storyhold.world_entities SET name='A different Mira'", "UPDATE storyhold.world_entities SET pull_status='hidden'",
      `UPDATE storyhold.world_entities SET merged_into_entity_id='${id(62)}'`, "UPDATE storyhold.character_dossiers SET dossier_status='suppressed'",
      "UPDATE storyhold.character_dossiers SET name='Another character'"]) {
      await assert.rejects(f.db.transaction(async (tx) => { await tx.query(sql); await syncEntityVerifiedCompass(tx, reviewed.scope, reviewed.receipt); }), errorCode("COMPASS_TARGET_STALE"));
    }
    await assert.rejects(f.db.transaction(async (tx) => {
      await tx.query("INSERT INTO storyhold.character_dossiers(id,world_id,canon_edition_id,name,axis_estimate) SELECT $1,world_id,canon_edition_id,name,axis_estimate FROM storyhold.character_dossiers WHERE id=$2", [id(63), DOSSIER]);
      await tx.query("UPDATE storyhold.world_entities SET dossier_id=$1", [id(63)]);
      await syncEntityVerifiedCompass(tx, reviewed.scope, reviewed.receipt);
    }), errorCode("COMPASS_TARGET_STALE"));
    await assert.rejects(f.db.transaction(async (tx) => {
      await tx.query("UPDATE storyhold.character_dossiers SET axis_estimate=$1::jsonb", [JSON.stringify({ ...oldAxis, economic: 22 })]);
      await syncEntityVerifiedCompass(tx, reviewed.scope, reviewed.receipt);
    }), errorCode("COMPASS_ESTIMATE_STALE"));
    assert.deepEqual((await f.row()).axis_estimate, oldAxis);
  } finally { await f.db.close(); }
});

test("owner-controlled entities, edited dossiers and explicit compass overrides retain their values", async () => {
  const f = await fixture();
  try {
    const reviewed = await f.review(); await reviewed.saveProof();
    for (const sql of ["UPDATE storyhold.world_entities SET classification_source='user'", "UPDATE storyhold.world_entities SET review_status='user_confirmed'",
      "UPDATE storyhold.character_dossiers SET user_edited_at=now()", "UPDATE storyhold.character_dossiers SET axis_user_override='{}'::jsonb"]) {
      await assert.rejects(f.db.transaction(async (tx) => {
        await tx.query(sql); const outcome = await syncEntityVerifiedCompass(tx, reviewed.scope, reviewed.receipt);
        assert.equal(outcome.saved, false); assert.match(outcome.warnings[0]!, /author-controlled/);
        assert.equal((await readEntityCompassStatus(tx, scope)).status, "author_controlled");
        throw new Error("Restore fixture");
      }), /Restore fixture/);
    }
    assert.deepEqual((await f.row()).axis_estimate, oldAxis);
  } finally { await f.db.close(); }
});

test("unresolved and disputed later reviews preserve the old axis but replace its reassuring support status", async () => {
  const f = await fixture();
  try {
    await (await f.review()).apply(); const previous = (await f.row()).axis_estimate;
    for (const verdict of ["needs_more_evidence", "disputed", "rejected"] as const) {
      const reviewed = await f.review(verdict); const outcome = await reviewed.apply();
      assert.equal(outcome.saved, false); assert.deepEqual((await f.row()).axis_estimate, previous);
      const status = await f.status(); assert.equal(status.status, verdict === "needs_more_evidence" ? "needs_evidence" : "needs_attention");
      assert.equal(status.estimate, undefined); assert.deepEqual(status.retrievalRequests, ["Find Mira's later views after the siege."]);
    }
  } finally { await f.db.close(); }
});

test("status is owner-only, requires finalization and exact current values/sources, and safely names a viewpoint holder", async () => {
  const f = await fixture();
  try {
    const reviewed = await f.review("supported", { proposed: { ...estimate, perspective: "others_interpretation", epistemicHolderId: HOLDER } });
    await reviewed.saveProof();
    await f.db.transaction((tx) => syncEntityVerifiedCompass(tx, reviewed.scope, reviewed.receipt));
    assert.equal((await f.status()).status, "not_reviewed");
    await f.db.transaction((tx) => finalizeEntityReviewCall(tx, reviewed.scope, { reviewed: true, entityId: scope.entityId }));
    const status = await f.status(); assert.equal(status.status, "supported"); assert.equal(status.estimate!.epistemicHolderName, "Tomas");
    for (const changed of [{ playerId: id(70) }, { worldId: id(71) }, { editionId: id(72) }, { entityId: id(73) }]) {
      assert.deepEqual(await readEntityCompassStatus(f.db, { ...scope, ...changed }), { status: "not_reviewed", evidence: [] });
    }
    await f.db.query("UPDATE storyhold.world_source_chunks SET content=content || ' Changed after the review.'");
    assert.equal((await f.status()).status, "not_reviewed");
    await f.db.query("UPDATE storyhold.world_source_chunks SET content=$1", [quote]);
    await f.db.query("UPDATE storyhold.character_dossiers SET axis_estimate=axis_estimate || '{\"authority\":99}'::jsonb");
    assert.equal((await f.status()).status, "not_reviewed");
  } finally { await f.db.close(); }
});

test("generic-writer retention preserves qualified JSON while a later dedicated verified compass can replace it", async () => {
  const f = await fixture();
  try {
    await (await f.review()).apply(); const qualified = (await f.row()).axis_estimate;
    // Exercise PostgreSQL's retention expression, not a mock JSON merge. The
    // production generic-writer call sites need their own wiring regressions.
    await f.db.query(`UPDATE storyhold.character_dossiers SET axis_estimate=
      CASE WHEN axis_estimate ? 'perspective' THEN axis_estimate ELSE $1::jsonb END WHERE id=$2`,
    [JSON.stringify(oldAxis), DOSSIER]);
    assert.deepEqual((await f.row()).axis_estimate, qualified);
    assert.equal((await f.status()).status, "supported");
    const next = await f.review("supported", { proposed: { ...estimate, economic: -30, authority: -20,
      rationale: "The pre-siege resource sharing and household vetoes suggest moderate collective economics and local autonomy." } });
    assert.equal((await next.apply()).saved, true);
    assert.deepEqual((await f.row()).axis_estimate, approvedEntityCompassEstimate(next.input, next.receipt));
    assert.equal((await f.status()).status, "supported"); assert.equal(f.calls(), 2);
  } finally { await f.db.close(); }
});

import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  assertExpectedPremiumClaimReviews,
  ensurePremiumClaimJournal,
  linkPremiumClaimReviewsToCanon,
  PremiumClaimJournalError,
  readPremiumClaimReviews,
  savePremiumClaimReview,
  type PremiumClaimScope,
} from "./premiumClaimJournal";
import { buildPremiumClaimRequest, validatePremiumClaimResponse, type PremiumClaimReviewReceipt } from "./premiumClaimVerification";
import { claimsFromPremiumClaimReceipts } from "./premiumClaimVerification";
import { buildVerifiedPromotionPlan } from "./analysisVerificationContracts";
import { syncWorldKnowledgeClaims, worldKnowledgeSchemaSql } from "./worldKnowledge";
import type { CanonClaimFinding } from "./worldAnalysis";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SCOPE: PremiumClaimScope = { worldId: uuid(1), editionId: uuid(2), analysisRunId: uuid(3) };
const OTHER: PremiumClaimScope = { worldId: uuid(4), editionId: uuid(5), analysisRunId: uuid(6) };
const COMPLETED_AT = "2026-09-03T12:00:00.000Z";

function receipt(stepKey = "verification:0", scope = SCOPE, completedAt = COMPLETED_AT): PremiumClaimReviewReceipt {
  const request = buildPremiumClaimRequest({
    scope, stepKey,
    chunks: [{ id: "chunk-one", sourceId: "source-one", text: "Alec crossed the eastern bridge." }],
    claims: [], context: { existingCanonContext: "", externalReferenceContext: "", userGuidance: "" },
  });
  return validatePremiumClaimResponse(request, {
    claims: [], claimVerification: { requestFingerprint: request.fingerprint, decisions: [], newClaims: [] },
  }, { provider: "test-provider", model: "test-verifier", completedAt });
}
async function database() {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.worlds (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.canon_editions (id uuid PRIMARY KEY, world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE);
    CREATE TABLE storyhold.world_analysis_runs (
      id uuid PRIMARY KEY, world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
      canon_edition_id uuid NOT NULL, analysis_kind text NOT NULL DEFAULT 'ai_enrichment'
    );
    CREATE TABLE storyhold.claim_projection (id text PRIMARY KEY, body text NOT NULL);
    CREATE TABLE storyhold.world_entities (
      id uuid PRIMARY KEY, world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
      canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
      name text NOT NULL, aliases jsonb NOT NULL DEFAULT '[]', entity_type text NOT NULL DEFAULT 'character',
      pull_status text NOT NULL DEFAULT 'active', scanner_present boolean NOT NULL DEFAULT true,
      merged_into_entity_id uuid REFERENCES storyhold.world_entities(id) ON DELETE SET NULL
    );
    CREATE TABLE storyhold.world_sources (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.world_source_chunks (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.world_clock_events (id uuid PRIMARY KEY);
  `);
  await db.exec(worldKnowledgeSchemaSql);
  await ensurePremiumClaimJournal(db);
  await db.query("INSERT INTO storyhold.worlds VALUES ($1), ($2)", [SCOPE.worldId, OTHER.worldId]);
  for (const scope of [SCOPE, OTHER]) {
    await db.query("INSERT INTO storyhold.canon_editions VALUES ($1, $2)", [scope.editionId, scope.worldId]);
    await db.query("INSERT INTO storyhold.world_analysis_runs (id, world_id, canon_edition_id) VALUES ($1, $2, $3)", [scope.analysisRunId, scope.worldId, scope.editionId]);
  }
  return db;
}
const fails = (code: string) => (error: unknown) => error instanceof PremiumClaimJournalError && error.code === code;

test("durable claim receipts round-trip complete evidence, decisions and exact verifier timestamp", async () => {
  const db = await database();
  try {
    const original = receipt();
    await db.transaction((tx) => savePremiumClaimReview(tx, original));
    const saved = await readPremiumClaimReviews(db, SCOPE);
    assert.deepEqual(saved, [original]);
    assert.equal(saved[0]?.verifier.completedAt, COMPLETED_AT);
    assert.equal(saved[0]?.request.chunks[0]?.text, "Alec crossed the eastern bridge.");
    assert.deepEqual(await readPremiumClaimReviews(db, OTHER), []);
    await ensurePremiumClaimJournal(db);
    assert.deepEqual(await readPremiumClaimReviews(db, SCOPE), [original]);
  } finally { await db.close(); }
});

test("strict replay is idempotent across concurrent transactions; differing timestamps cannot overwrite", async () => {
  const db = await database();
  try {
    const original = receipt();
    const rows = await Promise.all([
      db.transaction((tx) => savePremiumClaimReview(tx, original)),
      db.transaction((tx) => savePremiumClaimReview(tx, structuredClone(original))),
    ]);
    assert.deepEqual(rows, [original, original]);
    assert.equal((await db.query("SELECT * FROM storyhold.world_analysis_claim_reviews")).rows.length, 1);
    const changed = receipt("verification:0", SCOPE, "2026-09-03T12:00:01.000Z");
    await assert.rejects(db.transaction((tx) => savePremiumClaimReview(tx, changed)), fails("CLAIM_RECEIPT_MISMATCH"));
    assert.deepEqual(await readPremiumClaimReviews(db, SCOPE), [original]);
    await assert.rejects(db.query("UPDATE storyhold.world_analysis_claim_reviews SET step_key = 'verification:2'"), /immutable/);
  } finally { await db.close(); }
});

test("save and read require the current exact world, edition, and premium run scope", async () => {
  const db = await database();
  try {
    for (const scope of [
      { ...SCOPE, worldId: OTHER.worldId }, { ...SCOPE, editionId: OTHER.editionId }, { ...SCOPE, analysisRunId: uuid(99) },
    ]) {
      await assert.rejects(db.transaction((tx) => savePremiumClaimReview(tx, receipt("verification:0", scope))), fails("CLAIM_SCOPE_MISMATCH"));
      await assert.rejects(readPremiumClaimReviews(db, scope), fails("CLAIM_SCOPE_MISMATCH"));
    }
    await db.query("UPDATE storyhold.world_analysis_runs SET analysis_kind = 'local_scan' WHERE id = $1", [SCOPE.analysisRunId]);
    await assert.rejects(db.transaction((tx) => savePremiumClaimReview(tx, receipt())), fails("CLAIM_SCOPE_MISMATCH"));
    assert.equal((await db.query("SELECT * FROM storyhold.world_analysis_claim_reviews")).rows.length, 0);
  } finally { await db.close(); }
});

test("snapshot byte drift, receipt fingerprints, and redundant scope corruption fail closed", async () => {
  const db = await database();
  try {
    const original = receipt();
    await db.transaction((tx) => savePremiumClaimReview(tx, original));
    const stored = (await db.query<Record<string, unknown>>("SELECT * FROM storyhold.world_analysis_claim_reviews")).rows[0]!;
    // Temporary-database corruption simulation only; production trigger stays immutable.
    await db.exec("ALTER TABLE storyhold.world_analysis_claim_reviews DISABLE TRIGGER premium_claim_review_immutable");
    for (const mutation of [
      "UPDATE storyhold.world_analysis_claim_reviews SET snapshot_fingerprint = 'tampered'",
      "UPDATE storyhold.world_analysis_claim_reviews SET receipt_fingerprint = 'tampered'",
      `UPDATE storyhold.world_analysis_claim_reviews SET world_id = '${OTHER.worldId}'`,
      `UPDATE storyhold.world_analysis_claim_reviews SET edition_id = '${OTHER.editionId}'`,
      "UPDATE storyhold.world_analysis_claim_reviews SET step_key = 'verification:99'",
      "UPDATE storyhold.world_analysis_claim_reviews SET snapshot = jsonb_set(snapshot, '{verifier,completedAt}', '\"2026-09-03T12:00:09.000Z\"')",
    ]) {
      await db.exec(mutation);
      await assert.rejects(readPremiumClaimReviews(db, SCOPE), fails("CLAIM_JOURNAL_INTEGRITY"));
      await db.query(`UPDATE storyhold.world_analysis_claim_reviews
        SET world_id = $1, edition_id = $2, step_key = $3, receipt_fingerprint = $4, snapshot_fingerprint = $5, snapshot = $6::jsonb`,
      [stored.world_id, stored.edition_id, stored.step_key, stored.receipt_fingerprint, stored.snapshot_fingerprint, JSON.stringify(stored.snapshot)]);
    }
    await db.exec("ALTER TABLE storyhold.world_analysis_claim_reviews ENABLE TRIGGER premium_claim_review_immutable");
    assert.deepEqual(await readPremiumClaimReviews(db, SCOPE), [original]);
  } finally { await db.close(); }
});

test("receipt and canonical projection persist or roll back in the caller's single transaction", async () => {
  const db = await database();
  try {
    await assert.rejects(db.transaction(async (tx) => {
      await savePremiumClaimReview(tx, receipt());
      await tx.query("INSERT INTO storyhold.claim_projection VALUES ('claim-one', 'Verified claim')");
      throw new Error("simulated downstream canonical write failure");
    }), /simulated downstream/);
    assert.deepEqual(await readPremiumClaimReviews(db, SCOPE), []);
    assert.equal((await db.query("SELECT * FROM storyhold.claim_projection")).rows.length, 0);
    await db.transaction(async (tx) => {
      await savePremiumClaimReview(tx, receipt());
      await tx.query("INSERT INTO storyhold.claim_projection VALUES ('claim-one', 'Verified claim')");
    });
    assert.equal((await readPremiumClaimReviews(db, SCOPE)).length, 1);
    assert.equal((await db.query("SELECT * FROM storyhold.claim_projection")).rows.length, 1);
  } finally { await db.close(); }
});

test("expected receipt inventory rejects missing, duplicate, extra and foreign review batches", () => {
  const first = receipt("verification:0");
  const second = receipt("verification:1");
  const expected = { scope: SCOPE, expectedStepKeys: ["verification:0", "verification:1"] };
  assertExpectedPremiumClaimReviews([second, first], expected);
  assertExpectedPremiumClaimReviews([], { scope: SCOPE, expectedStepKeys: [] });
  for (const rows of [[first], [first, first], [first, receipt("verification:2")], [first, second, second]]) {
    assert.throws(() => assertExpectedPremiumClaimReviews(rows, expected), fails("CLAIM_RECEIPTS_INCOMPLETE"));
  }
  assert.throws(() => assertExpectedPremiumClaimReviews([first, receipt("verification:1", OTHER)], expected), fails("CLAIM_SCOPE_MISMATCH"));
  assert.throws(() => assertExpectedPremiumClaimReviews([first, second], { ...expected, expectedStepKeys: ["verification:0", "verification:0"] }), fails("CLAIM_RECEIPTS_INCOMPLETE"));
  assert.throws(() => assertExpectedPremiumClaimReviews([first], { scope: SCOPE, expectedStepKeys: [" verification:0"] }), fails("CLAIM_STEP_INVALID"));
});

test("invalid or changed receipt content is rejected before any durable write", async () => {
  const db = await database();
  try {
    const changed = structuredClone(receipt());
    changed.request.chunks[0]!.text = "Altered manuscript evidence";
    await assert.rejects(db.transaction((tx) => savePremiumClaimReview(tx, changed)), fails("CLAIM_RECEIPT_INVALID"));
    assert.equal((await db.query("SELECT * FROM storyhold.world_analysis_claim_reviews")).rows.length, 0);
  } finally { await db.close(); }
});

test("claim receipts follow ordinary world deletion through their run without blocking deletion", async () => {
  const db = await database();
  try {
    await db.transaction(async (tx) => {
      await savePremiumClaimReview(tx, receipt());
      await savePremiumClaimReview(tx, receipt("verification:0", OTHER));
    });
    await db.query("DELETE FROM storyhold.worlds WHERE id = $1", [SCOPE.worldId]);
    const remaining = (await db.query<{ run_id: string }>("SELECT run_id FROM storyhold.world_analysis_claim_reviews")).rows;
    assert.deepEqual(remaining, [{ run_id: OTHER.analysisRunId }]);
  } finally { await db.close(); }
});

const CLAIM_QUOTE = "Alec crossed Eastern Bridge while Mira watched him cross.";
function claimFinding(changes: Partial<CanonClaimFinding> = {}): CanonClaimFinding {
  return {
    subject: "Alec", predicate: "crossed", value: "Eastern Bridge", polarity: "positive", epistemicHolder: "",
    truthStatus: "fact", validFromLabel: "Chapter One", validUntilLabel: "",
    evidence: [{ chunkId: "chunk-one", sourceId: "source-one", quote: CLAIM_QUOTE }], confidence: 0.95,
    ...changes,
  };
}
function reviewedReceipt(claims = [claimFinding()], verdict: "verified" | "rejected" = "verified") {
  const request = buildPremiumClaimRequest({
    scope: SCOPE, stepKey: "verification:0", chunks: [{ id: "chunk-one", sourceId: "source-one", text: CLAIM_QUOTE }], claims, context: {},
  });
  return validatePremiumClaimResponse(request, {
    claims: [], claimVerification: {
      requestFingerprint: request.fingerprint, newClaims: [],
      decisions: request.proposals.map((proposal) => ({
        proposalId: proposal.id, verdict, explanation: "The cited passage directly states this event.", confidence: 0.95,
        supportingEvidence: verdict === "verified" ? [{ chunkId: "chunk-one", quote: CLAIM_QUOTE }] : [],
        contradictingEvidence: [], retrievalRequests: [],
      })),
    },
  }, { provider: "test-provider", model: "test-verifier", completedAt: COMPLETED_AT });
}
async function seedClaimEntities(db: PGlite) {
  await db.query(`INSERT INTO storyhold.world_entities (id, world_id, canon_edition_id, name, aliases) VALUES
    ($1, $4, $5, 'Alec', '["The Traveler"]'), ($2, $4, $5, 'Eastern Bridge', '["East Span"]'), ($3, $4, $5, 'Mira', '[]')`,
  [uuid(10), uuid(11), uuid(12), SCOPE.worldId, SCOPE.editionId]);
}
async function syncReviewed(db: Pick<PGlite, "query">, reviewed: PremiumClaimReviewReceipt) {
  return syncWorldKnowledgeClaims({
    db, worldId: SCOPE.worldId, editionId: SCOPE.editionId, runId: SCOPE.analysisRunId,
    claims: claimsFromPremiumClaimReceipts([reviewed]).map((claim) => ({
      subject: claim.subject, predicate: claim.predicate, object: claim.value, objectEntity: claim.value,
      polarity: claim.polarity ?? "positive", epistemicHolder: claim.epistemicHolder || undefined,
      truthStatus: claim.truthStatus, validFromLabel: claim.validFromLabel, validUntilLabel: claim.validUntilLabel,
      evidence: claim.evidence, confidence: claim.confidence,
    })), assignmentSource: "ai", preserveUnreviewedAiClaims: true,
  });
}

test("verified decisions link only actual materialized claims using stable semantic payload fingerprints", async () => {
  const db = await database();
  try {
    await seedClaimEntities(db);
    const reviewed = reviewedReceipt();
    const entries = buildVerifiedPromotionPlan(reviewed.packet, reviewed.decisions, reviewed.batch);
    const inserted = await db.transaction(async (tx) => {
      await savePremiumClaimReview(tx, reviewed);
      assert.equal(await linkPremiumClaimReviewsToCanon(tx, [reviewed]), 0, "A saved decision does not imply a canonical row exists");
      assert.equal((await syncReviewed(tx, reviewed)).saved, 1);
      return linkPremiumClaimReviewsToCanon(tx, [reviewed]);
    });
    assert.equal(inserted, 1);
    const links = (await db.query<{ claim_id: string; decision_id: string; proposal_id: string; payload_fingerprint: string }>(
      "SELECT claim_id, decision_id, proposal_id, payload_fingerprint FROM storyhold.world_knowledge_claim_verifications",
    )).rows;
    const claimId = (await db.query<{ id: string }>("SELECT id FROM storyhold.world_knowledge_claims")).rows[0]!.id;
    assert.deepEqual(links, [{ claim_id: claimId, decision_id: entries[0]!.decision.id, proposal_id: entries[0]!.proposal.id, payload_fingerprint: entries[0]!.payloadFingerprint }]);
    assert.equal(await db.transaction((tx) => linkPremiumClaimReviewsToCanon(tx, [reviewed])), 0);
    await assert.rejects(db.query("UPDATE storyhold.world_knowledge_claim_verifications SET decision_id = 'different'"), /immutable/);
    await db.query("DELETE FROM storyhold.world_knowledge_claims WHERE id = $1", [claimId]);
    assert.equal((await db.query("SELECT * FROM storyhold.world_knowledge_claim_verifications")).rows.length, 0);
    assert.equal((await readPremiumClaimReviews(db, SCOPE)).length, 1);
  } finally { await db.close(); }
});

test("materialized links skip owner-protected, wrong-run, unsupported, drifted, and unresolved claims", async () => {
  const db = await database();
  try {
    await seedClaimEntities(db);
    const reviewed = reviewedReceipt();
    await assert.rejects(linkPremiumClaimReviewsToCanon(db, [reviewed]), fails("CLAIM_RECEIPT_MISMATCH"));
    await db.transaction(async (tx) => { await savePremiumClaimReview(tx, reviewed); await syncReviewed(tx, reviewed); });
    const original = (await db.query<{ evidence: unknown }>("SELECT evidence FROM storyhold.world_knowledge_claims")).rows[0]!;
    for (const mutate of [
      "UPDATE storyhold.world_knowledge_claims SET assignment_source = 'user'",
      `UPDATE storyhold.world_knowledge_claims SET assignment_source = 'ai', source_analysis_run_id = '${OTHER.analysisRunId}'`,
      `UPDATE storyhold.world_knowledge_claims SET source_analysis_run_id = '${SCOPE.analysisRunId}', evidence = '[]'`,
    ]) {
      await db.exec(mutate);
      assert.equal(await linkPremiumClaimReviewsToCanon(db, [reviewed]), 0);
    }
    await db.query("UPDATE storyhold.world_knowledge_claims SET evidence = $1::jsonb, predicate = 'invented payload'", [JSON.stringify(original.evidence)]);
    assert.equal(await linkPremiumClaimReviewsToCanon(db, [reviewed]), 0);
    await db.query("UPDATE storyhold.world_knowledge_claims SET predicate = 'crossed'");
    await db.query("UPDATE storyhold.world_entities SET scanner_present = false WHERE id = $1", [uuid(10)]);
    assert.equal(await linkPremiumClaimReviewsToCanon(db, [reviewed]), 0);
    assert.equal((await db.query("SELECT * FROM storyhold.world_knowledge_claim_verifications")).rows.length, 0);
  } finally { await db.close(); }
});

test("canon links use alias resolution and preserve polarity, epistemic holder and time identity", async () => {
  const db = await database();
  try {
    await seedClaimEntities(db);
    const reviewed = reviewedReceipt([
      claimFinding({ subject: "The Traveler", value: "East Span" }),
      claimFinding({ truthStatus: "belief", epistemicHolder: "Mira" }),
      claimFinding({ polarity: "negative", validFromLabel: "Before Chapter One", validUntilLabel: "Chapter One" }),
    ]);
    await db.transaction(async (tx) => {
      await savePremiumClaimReview(tx, reviewed);
      assert.equal((await syncReviewed(tx, reviewed)).saved, 3);
      assert.equal(await linkPremiumClaimReviewsToCanon(tx, [reviewed]), 3);
    });
    assert.equal((await db.query("SELECT * FROM storyhold.world_knowledge_claims")).rows.length, 3);
    const links = (await db.query<{ payload_fingerprint: string }>("SELECT payload_fingerprint FROM storyhold.world_knowledge_claim_verifications")).rows;
    assert.equal(new Set(links.map((item) => item.payload_fingerprint)).size, 3);
  } finally { await db.close(); }
});

test("non-verified decisions cannot link and caller failure rolls back a materialized link", async () => {
  const db = await database();
  try {
    await seedClaimEntities(db);
    const rejected = reviewedReceipt([claimFinding()], "rejected");
    await db.transaction(async (tx) => { await savePremiumClaimReview(tx, rejected); assert.equal(await linkPremiumClaimReviewsToCanon(tx, [rejected]), 0); });
    await db.query("DELETE FROM storyhold.world_analysis_claim_reviews WHERE run_id = $1", [SCOPE.analysisRunId]);
    const reviewed = reviewedReceipt();
    await assert.rejects(db.transaction(async (tx) => {
      await savePremiumClaimReview(tx, reviewed);
      await syncReviewed(tx, reviewed);
      assert.equal(await linkPremiumClaimReviewsToCanon(tx, [reviewed]), 1);
      throw new Error("canonical transaction failed");
    }), /canonical transaction failed/);
    assert.equal((await db.query("SELECT * FROM storyhold.world_knowledge_claim_verifications")).rows.length, 0);
    assert.equal((await db.query("SELECT * FROM storyhold.world_knowledge_claims")).rows.length, 0);
    assert.deepEqual(await readPremiumClaimReviews(db, SCOPE), []);
  } finally { await db.close(); }
});

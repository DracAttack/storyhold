import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { AiTextResult } from "./aiGateway";
import { canonPayloadFingerprint, type JsonObject } from "./analysisVerificationContracts";
import { executeJournaledPremiumCall, premiumReviewJournalSchemaSql, readPremiumJournalAccounting } from "./premiumReviewJournal";
import {
  type PremiumReviewPlan, PremiumReviewPlanError, premiumReviewPlanSchemaSql,
  premiumReviewVerificationStepKeys, readPremiumReviewPlan, savePremiumReviewPlan, validatePremiumReviewResume,
} from "./premiumReviewPlan";
import { buildCompletePremiumVerificationPages, type PremiumVerificationPage } from "./premiumVerificationPages";
import { parseWorldFindingsFromModel, type AnalysisChunk } from "./worldAnalysis";
import { buildPremiumGraphRequest, validatePremiumGraphResponse } from "./premiumGraphVerification";
import { finalizeChunkCoverage } from "./worldStudio";

const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const RUN = uuid(901), WORLD = uuid(902), EDITION = uuid(903), PLAYER = uuid(904), HOLD = uuid(905);
const chunks: AnalysisChunk[] = [0, 1].map((index) => ({
  id: uuid(910 + index), sourceId: uuid(920 + index), sourceTitle: `Book ${index + 1}`,
  index, content: index === 0 ? "Mira crossed the northern bridge." : "Mira entered the eastern keep.",
}));

function inventory() {
  return chunks.map((chunk, batchIndex) => ({
    ...parseWorldFindingsFromModel({}, [chunk]),
    locations: Array.from({ length: batchIndex === 0 ? 13 : 1 }, (_, index) => ({
      name: `Place ${batchIndex}-${index}`, summary: "Specific geography. ".repeat(350),
      evidence: [{ chunkId: chunk.id, sourceId: chunk.sourceId, quote: chunk.content }],
    })),
  }));
}

function plan(pageVersion: 2 | 3 = 2): Extract<PremiumReviewPlan, { version: 2 }> {
  const packets = inventory();
  if (pageVersion === 3) Object.assign(packets[0]!.locations[0]!, {
    estimatedStats: { strength: { score: 12, confidence: 0.7, rationale: "The bridge bears the expedition's weight.",
      evidence: [{ chunkId: chunks[0]!.id, sourceId: chunks[0]!.sourceId, quote: chunks[0]!.content }] } },
  });
  return {
    version: 2, runId: RUN, worldId: WORLD, editionId: EDITION, playerId: PLAYER,
    executionVersion: pageVersion === 3 ? "premium-packet-v6" : "premium-packet-v5", scopeFingerprint: "frozen-inventory-scope",
    provider: "openrouter", model: "test-model", worldContext: {
      worldName: "Inventory World", premise: "Two books", genre: "Fantasy", userGuidance: "Keep every relevant finding.",
    }, chunks: structuredClone(chunks), verificationBatches: chunks.map((chunk) => [chunk.id]),
    verificationPages: buildCompletePremiumVerificationPages(packets, pageVersion),
    incremental: false, partialDueToCredits: false, reservationId: HOLD, reservedCredits: 29, unlimited: false,
  };
}

function legacyPlan(): Extract<PremiumReviewPlan, { version: 2 }> {
  return {
    ...plan(), executionVersion: "premium-packet-v4", verificationPages: chunks.map((_chunk, batchIndex) => ({
      stepKey: `verification:${batchIndex}`, batchIndex, pageIndex: 0, pageCount: 1,
      candidateKeys: [], packetFingerprint: `premium_packet_${String(batchIndex + 1).repeat(64)}`,
    })),
  };
}

function resumeParams(saved: PremiumReviewPlan) {
  return {
    runId: saved.runId, worldId: saved.worldId, editionId: saved.editionId,
    playerId: saved.playerId, executionVersion: saved.executionVersion,
    scopeFingerprint: saved.scopeFingerprint, provider: saved.provider, model: saved.model,
  };
}

function planError(code: string) {
  return (error: unknown) => error instanceof PremiumReviewPlanError && error.code === code;
}

async function database() {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.players (id uuid PRIMARY KEY, role text NOT NULL);
    CREATE TABLE storyhold.world_analysis_runs (
      id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
      requested_by_player_id uuid NOT NULL, status text NOT NULL DEFAULT 'paused'
    );
    CREATE TABLE storyhold.credit_reservations (
      id uuid PRIMARY KEY, world_id uuid NOT NULL, player_id uuid NOT NULL,
      operation text NOT NULL, request_id text NOT NULL, reserved_credits integer NOT NULL,
      status text NOT NULL DEFAULT 'reserved', usage jsonb NOT NULL DEFAULT '{"original":"metadata"}'::jsonb
    );
  `);
  await db.exec(premiumReviewJournalSchemaSql);
  await db.exec(premiumReviewPlanSchemaSql);
  await db.query("INSERT INTO storyhold.players VALUES ($1, 'player')", [PLAYER]);
  await db.query("INSERT INTO storyhold.world_analysis_runs (id, world_id, canon_edition_id, requested_by_player_id) VALUES ($1, $2, $3, $4)", [RUN, WORLD, EDITION, PLAYER]);
  await db.query("INSERT INTO storyhold.credit_reservations (id, world_id, player_id, operation, request_id, reserved_credits) VALUES ($1, $2, $3, 'world_analysis', $4, 29)", [HOLD, WORLD, PLAYER, RUN]);
  return db;
}

function result(): AiTextResult {
  return {
    text: '{"verified":true}', provider: "openrouter", model: "test-model", reasoning: "high",
    usage: { inputUnits: 100, outputUnits: 10, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 0, estimatedCostMicros: 75, pricingKnown: true, pricingVersion: "fixture", costEstimated: true },
    runtime: {
      configured: true, mode: "connected", provider: "openrouter", model: "test-model", billable: true,
      sendsSourceTextOffDevice: true, explanation: "Offline fixture", stage: "verification", execution: null,
      localExtraction: { enabled: false, configured: false, provider: "gliner2", model: "local", endpoint: null, endpointKind: null, sendsSourceTextOffDevice: false, explanation: "Disabled" },
      providers: [], routing: { director: null, narration: null, adultNarration: null, analysis: null, canonReview: "openrouter" },
      stageRouting: { extraction: null, verification: "openrouter", dossier: null, chronology: null, director: null, narration: null, adaptation: null },
    },
  };
}

function journalCall(db: PGlite, stepKey: string, invoke: () => Promise<AiTextResult> = async () => result()) {
  return executeJournaledPremiumCall(db, {
    runId: RUN, stepKey, provider: "openrouter", model: "test-model",
    request: { task: "canon_review", stage: "verification", system: "Frozen inventory review", messages: [{ role: "user", content: stepKey }] }, invoke,
  });
}

test("nested v2 and v3 inventory pages freeze within plan v2 without rewriting historical fingerprints", async () => {
  for (const supplied of [legacyPlan(), plan(), plan(3)]) {
    const db = await database();
    try {
      const expected = structuredClone(supplied);
      await savePremiumReviewPlan(db, supplied);
      assert.deepEqual(await readPremiumReviewPlan(db, RUN), expected);
      const stored = await db.query<{ fingerprint: string }>("SELECT fingerprint FROM storyhold.world_analysis_premium_plans WHERE run_id = $1", [RUN]);
      assert.equal(stored.rows[0]?.fingerprint, canonPayloadFingerprint({ namespace: "storyhold:premium-review-plan:v2", plan: expected as unknown as JsonObject }));
      assert.deepEqual(premiumReviewVerificationStepKeys(expected), expected.verificationPages.map((page) => page.stepKey));
      assert.deepEqual(await validatePremiumReviewResume(db, resumeParams(expected)), expected);
      supplied.verificationPages[0]!.candidateKeys.push(`finding:locations:${"e".repeat(64)}`);
      assert.deepEqual(await readPremiumReviewPlan(db, RUN), expected);
      await assert.rejects(validatePremiumReviewResume(db, { ...resumeParams(expected), executionVersion: "another-packet-version" }), planError("RESUME_SCOPE_MISMATCH"));
    } finally { await db.close(); }
  }
});

test("complete inventory plan rejects mixed nested contracts and malformed boundaries before retaining a hold", async () => {
  const db = await database();
  try {
    const frozen = plan();
    assert.ok(JSON.stringify(inventory()[0]).length > 64_000);
    assert.equal(frozen.verificationPages.length, 4);
    const pages = frozen.verificationPages;
    const mixedBatch = pages.map((page, index) => index === pages.length - 1
      ? { ...legacyPlan().verificationPages[1]!, stepKey: page.stepKey } : page);
    const invalidInventories: unknown[] = [
      mixedBatch,
      pages.map((page, index) => index === 0 ? { ...page, version: 1 } : page),
      pages.map((page, index) => index === 0 ? { ...page, packetFingerprint: `premium_packet_${"a".repeat(64)}` } : page),
      pages.map((page, index) => index === 1 ? { ...page, candidateKeys: pages[0]!.candidateKeys } : page),
      pages.map((page, index) => index === 0 ? { ...page, candidateKeys: [`finding:unsupported:${"b".repeat(64)}`] } : page),
      pages.filter((_page, index) => index !== 1),
    ];
    for (const verificationPages of invalidInventories) {
      await assert.rejects(savePremiumReviewPlan(db, { ...frozen, verificationPages } as PremiumReviewPlan), planError("PLAN_INVALID"));
    }
    const held = await db.query<{ usage: Record<string, unknown> }>("SELECT usage FROM storyhold.credit_reservations");
    assert.deepEqual(held.rows[0]?.usage, { original: "metadata" });
    assert.equal(await readPremiumReviewPlan(db, RUN), null);
  } finally { await db.close(); }
});

test("complete inventory resume reuses completed pages once and retains the same original credit reservation", async () => {
  const db = await database();
  try {
    const frozen = plan();
    await savePremiumReviewPlan(db, frozen);
    let calls = 0;
    await journalCall(db, "verification:0", async () => { calls += 1; return result(); });
    const accountingBefore = await readPremiumJournalAccounting(db, RUN);
    assert.deepEqual(await validatePremiumReviewResume(db, resumeParams(frozen)), frozen);
    await journalCall(db, "verification:0", async () => { calls += 1; throw new Error("Completed inventory page must replay"); });
    assert.equal(calls, 1);
    assert.deepEqual(await readPremiumJournalAccounting(db, RUN), accountingBefore);
    for (const page of frozen.verificationPages.slice(1)) await journalCall(db, page.stepKey);
    await journalCall(db, "chronology:0");
    assert.deepEqual(await validatePremiumReviewResume(db, resumeParams(frozen)), frozen);
    const held = await db.query<{ id: string; reserved_credits: number; status: string; usage: unknown }>("SELECT id, reserved_credits, status, usage FROM storyhold.credit_reservations");
    assert.deepEqual(held.rows, [{ id: HOLD, reserved_credits: 29, status: "reserved", usage: { original: "metadata", retainUntilReconciled: true } }]);
  } finally { await db.close(); }
});

test("complete inventory chronology cannot start merely because the number of calls equals source batches", async () => {
  const db = await database();
  try {
    const frozen = plan();
    await savePremiumReviewPlan(db, frozen);
    await journalCall(db, "verification:0");
    await journalCall(db, "verification:1");
    await journalCall(db, "chronology:0");
    await assert.rejects(validatePremiumReviewResume(db, resumeParams(frozen)), planError("JOURNAL_NOT_RESUMABLE"));
  } finally { await db.close(); }
});

function coverageReceipt(page: PremiumVerificationPage, frozen: ReturnType<typeof plan>, changedText = false) {
  const source = chunks[page.batchIndex]!;
  const request = buildPremiumGraphRequest({
    scope: { worldId: WORLD, editionId: EDITION, analysisRunId: RUN }, stepKey: page.stepKey,
    chunks: [{ id: source.id, sourceId: source.sourceId, text: source.content + (changedText ? " Changed." : "") }],
    relations: [], rules: [], context: {},
  });
  return validatePremiumGraphResponse(request, { entityRelations: [], entityRules: [], graphVerification: {
    requestFingerprint: request.fingerprint, decisions: [], newFindings: [],
  } }, { provider: "openrouter", model: "test-model", completedAt: "2026-09-03T12:00:00.000Z" });
}

test("ordinary inventory pages retain exact repeated source authority and finalize each chunk only once", async () => {
  const frozen = plan();
  const projected = parseWorldFindingsFromModel({}, chunks);
  projected.locations = inventory().flatMap((packet) => packet.locations);
  const reviews = frozen.verificationPages.map((page) => coverageReceipt(page, frozen));
  const settings = {
    scope: { worldId: WORLD, editionId: EDITION, analysisRunId: RUN }, reviews,
    expectedStepKeys: premiumReviewVerificationStepKeys(frozen),
    verificationPages: frozen.verificationPages, verificationBatches: frozen.verificationBatches,
  };
  const writes: unknown[][] = [];
  const db = { query: async (_sql: string, params: unknown[]) => { writes.push(params); return { rows: [] }; } } as unknown as Parameters<typeof finalizeChunkCoverage>[0];
  await finalizeChunkCoverage(db, RUN, chunks, projected, settings);
  assert.equal(writes.length, chunks.length);
  // Existing ordinary coverage counts distinct cited passages, not dossiers;
  // repeating one quote across thirteen candidates must not inflate it.
  assert.deepEqual(writes.map((params) => params.slice(1)), [[chunks[0]!.id, "analyzed", 1], [chunks[1]!.id, "analyzed", 1]]);
  writes.length = 0;
  await assert.rejects(finalizeChunkCoverage(db, RUN, chunks, projected, { ...settings, reviews: reviews.slice(0, -1) }));
  const changed = [...reviews];
  changed[1] = coverageReceipt(frozen.verificationPages[1]!, frozen, true);
  await assert.rejects(finalizeChunkCoverage(db, RUN, chunks, projected, { ...settings, reviews: changed }), /exact frozen source batch/);
  assert.deepEqual(writes, []);
});

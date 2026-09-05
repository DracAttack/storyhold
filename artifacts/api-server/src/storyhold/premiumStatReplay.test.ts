import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { getAiRuntimeStatus, type AiTextResult, type GenerateAiTextInput } from "./aiGateway";
import { analyzeWorld, buildWorldPremiumVerificationPages, parseWorldFindingsFromModel, type WorldAnalysisInput } from "./worldAnalysis";
import { PREMIUM_STAT_NAMES, premiumNeutralStats, premiumStatCandidates } from "./premiumStatCandidates";
import { assertPremiumStatReceipt, validatePremiumStatResponse } from "./premiumStatVerification";
import { executeJournaledPremiumCall, premiumReviewJournalSchemaSql, readPremiumJournalAccounting } from "./premiumReviewJournal";

const scope = {
  worldId: "00000000-0000-4000-8000-000000000961",
  editionId: "00000000-0000-4000-8000-000000000962",
  analysisRunId: "00000000-0000-4000-8000-000000000963",
};
const playerId = "00000000-0000-4000-8000-000000000964";
const reservationId = "00000000-0000-4000-8000-000000000965";
function fixture(): WorldAnalysisInput {
  const chunk = { id: "replay-stat-chunk", sourceId: "replay-stat-source", sourceTitle: "Synthetic assessment", index: 0,
    content: PREMIUM_STAT_NAMES.map((stat) => `Mara demonstrated exceptional ${stat} during the assessment.`).join(" ") };
  const stats = premiumNeutralStats();
  for (const stat of PREMIUM_STAT_NAMES) stats[stat] = {
    score: 17, confidence: 0.8, rationale: `The assessment demonstrates exceptional ${stat}.`,
    evidence: [{ chunkId: chunk.id, sourceId: chunk.sourceId, quote: `Mara demonstrated exceptional ${stat} during the assessment.` }],
  };
  const findings = parseWorldFindingsFromModel({ characters: [{ name: "Mara", summary: "Mara participates in the assessment.", estimatedStats: stats,
    evidence: [{ chunkId: chunk.id, quote: "Mara demonstrated exceptional strength during the assessment." }] }] }, [chunk], "candidate");
  return { worldName: "Stat replay fixture", premise: "", genre: "", chunks: [chunk], sources: [],
    persistedLocalFindings: findings, premiumClaimScope: scope, analysisMode: "connected" };
}
type Contract = { requestFingerprint: string; proposals: Array<{ id: string; payload: { stat: string } }> };
function contract(request: GenerateAiTextInput, kind: "STAT" | "CLAIM" | "GRAPH"): Contract {
  const match = request.messages.map((message) => message.content).join("\n")
    .match(new RegExp(`<${kind}_VERIFICATION_REQUEST trust="unverified">\\s*([\\s\\S]*?)\\s*</${kind}_VERIFICATION_REQUEST>`, "u"));
  assert.ok(match, `${kind} request must be included`);
  return JSON.parse(match[1]!) as Contract;
}
function reply(request: GenerateAiTextInput, params: WorldAnalysisInput, step: string): AiTextResult {
  const stats = contract(request, "STAT"); const claims = contract(request, "CLAIM"); const graph = contract(request, "GRAPH");
  assert.equal(claims.proposals.length, 0); assert.equal(graph.proposals.length, 0);
  assert.ok(stats.proposals.length > 0 && stats.proposals.length <= 6);
  const profile = { ...params.persistedLocalFindings!.characters[0]!, estimatedStats: premiumNeutralStats() };
  const body = {
    characters: step === "verification:1" ? [profile] : [], claims: [], entityRelations: [], entityRules: [],
    claimVerification: { requestFingerprint: claims.requestFingerprint, decisions: [], newClaims: [] },
    graphVerification: { requestFingerprint: graph.requestFingerprint, decisions: [], newFindings: [] },
    statVerification: { requestFingerprint: stats.requestFingerprint, decisions: stats.proposals.map((proposal) => ({
      proposalId: proposal.id, verdict: "verified", explanation: "The manuscript assessment supports this estimate.", confidence: 0.75,
      supportingEvidence: [{ chunkId: params.chunks[0]!.id, quote: `Mara demonstrated exceptional ${proposal.payload.stat} during the assessment.` }],
      contradictingEvidence: [], retrievalRequests: [],
    })), newStats: [] },
    coverage: [{ chunkId: params.chunks[0]!.id, status: "findings" }],
  };
  const text = JSON.stringify(body);
  request.validate!(text);
  const runtime = getAiRuntimeStatus(request.task, request.contentMode, request.stage);
  return { text, runtime, provider: "openrouter", model: runtime.model, reasoning: "high",
    usage: { inputUnits: 10, outputUnits: 5, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 0,
      estimatedCostMicros: 100, pricingKnown: true, pricingVersion: "fixture", costEstimated: true } };
}
async function database(): Promise<PGlite> {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.world_analysis_runs (id uuid PRIMARY KEY, world_id uuid NOT NULL, requested_by_player_id uuid NOT NULL);
      CREATE TABLE storyhold.credit_reservations (id uuid PRIMARY KEY, world_id uuid NOT NULL, player_id uuid NOT NULL,
        operation text NOT NULL, request_id text NOT NULL, status text NOT NULL DEFAULT 'reserved',
        reserved_credits integer NOT NULL DEFAULT 20, usage jsonb NOT NULL DEFAULT '{}'::jsonb);`);
    await db.exec(premiumReviewJournalSchemaSql);
    await db.query("INSERT INTO storyhold.world_analysis_runs VALUES ($1, $2, $3)", [scope.analysisRunId, scope.worldId, playerId]);
    await db.query("INSERT INTO storyhold.credit_reservations (id, world_id, player_id, operation, request_id) VALUES ($1, $2, $3, 'world_analysis', $4)",
      [reservationId, scope.worldId, playerId, scope.analysisRunId]);
    return db;
  } catch (error) { await db.close(); throw error; }
}

test("saved stat decisions survive interrupted review and replay with exact timestamps and no duplicate usage", async () => {
  const environment = { STORYHOLD_VERIFICATION_PROVIDER: "openrouter", STORYHOLD_CHRONOLOGY_PROVIDER: "openrouter",
    STORYHOLD_OPENROUTER_API_KEY: "fake-stat-replay-key", STORYHOLD_OPENROUTER_CHRONOLOGY_MODEL: "mistralai/mistral-small-2603" };
  const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  let db: PGlite | undefined;
  try {
    Object.assign(process.env, environment);
    globalThis.fetch = async () => { fetchCount += 1; throw new Error("Network is forbidden in stat replay fixtures."); };
    db = await database();
    const base = fixture();
    const params = { ...base, premiumVerificationPages: buildWorldPremiumVerificationPages(base) };
    assert.equal(params.premiumVerificationPages.length, 2);
    const invocations: string[] = [];
    const delivered: Array<{ step: string; result: AiTextResult }> = [];
    let coverageWrites = 0;
    const interruption = new Error("Synthetic interruption after first stat page was durably saved");
    const executor = (interrupt: boolean): NonNullable<WorldAnalysisInput["executePremiumCall"]> => async (step, request) => {
      if (interrupt && step === "verification:1") throw interruption;
      const runtime = getAiRuntimeStatus(request.task, request.contentMode, request.stage);
      const result = await executeJournaledPremiumCall(db!, {
        runId: scope.analysisRunId, reservationId, stepKey: step, request, provider: runtime.provider, model: runtime.model,
        scopeFingerprint: "synthetic-stat-replay-plan",
        invoke: async () => { invocations.push(step); return reply(request, params, step); },
      });
      delivered.push({ step, result });
      return result;
    };
    await assert.rejects(analyzeWorld({ ...params, executePremiumCall: executor(true), onCoverage: () => { coverageWrites += 1; } }),
      (error: unknown) => error === interruption);
    assert.deepEqual(invocations, ["verification:0"]);
    assert.equal(coverageWrites, 0, "saved first-page stats do not falsely complete source coverage");
    const firstDelivery = delivered[0]!.result;
    assert.ok(firstDelivery.journalCompletedAt, "the journal supplies the durable completion timestamp");
    const firstRaw = JSON.parse(firstDelivery.text);
    assert.equal(firstRaw.statVerification.decisions.length, 6);
    const saved = await readPremiumJournalAccounting(db, scope.analysisRunId);
    assert.equal(saved.callCount, 1); assert.equal(saved.attempts.length, 1); assert.equal(saved.hasUncertain, false);
    const savedHold = (await db.query<{ status: string; reserved_credits: number; usage: unknown }>("SELECT status, reserved_credits, usage FROM storyhold.credit_reservations")).rows;
    assert.equal(savedHold[0]!.status, "reserved");
    assert.equal(savedHold[0]!.reserved_credits, 20);
    const frozenAfterJsonRestore = JSON.parse(JSON.stringify(params)) as WorldAnalysisInput;
    const resumed = await analyzeWorld({ ...frozenAfterJsonRestore, executePremiumCall: executor(false) });
    assert.deepEqual(invocations, ["verification:0", "verification:1"]);
    const firstReplay = delivered.filter((item) => item.step === "verification:0")[1]!.result;
    assert.deepEqual(firstReplay, firstDelivery, "replay delivers the exact saved result, not a regenerated estimate");
    assert.equal(resumed.statReviews?.length, 2);
    const reviewedFirst = resumed.statReviews![0]!;
    const expectedFirst = validatePremiumStatResponse(reviewedFirst.request, firstRaw, {
      provider: firstDelivery.provider,
      model: firstDelivery.runtime.execution?.resolvedModel ?? firstDelivery.model,
      completedAt: firstDelivery.journalCompletedAt!,
    });
    assert.deepEqual(reviewedFirst, expectedFirst, "exact decisions, evidence, model provenance, and timestamp reproduce the receipt");
    assertPremiumStatReceipt(reviewedFirst);
    assert.ok(reviewedFirst.decisions.every((decision) => decision.completedAt === firstDelivery.journalCompletedAt));
    assert.equal(resumed.statReviews!.flatMap((receipt) => receipt.decisions).length, 7);
    assert.equal(premiumStatCandidates(resumed.findings).length, 7);
    assert.ok(PREMIUM_STAT_NAMES.every((stat) => resumed.findings.characters[0]!.estimatedStats[stat].score === 17));
    assert.equal(resumed.coverage?.complete, true);
    assert.equal(resumed.usage.estimatedCostMicros, 200);
    assert.equal(resumed.usageRecords?.length, 2);
    const accounting = await readPremiumJournalAccounting(db, scope.analysisRunId);
    assert.equal(accounting.callCount, 2); assert.equal(accounting.attempts.length, 2); assert.equal(accounting.hasUncertain, false);
    const replayAgain = await analyzeWorld({ ...frozenAfterJsonRestore, executePremiumCall: executor(false) });
    assert.deepEqual(replayAgain.statReviews, resumed.statReviews);
    assert.deepEqual(replayAgain.findings, resumed.findings);
    assert.equal(replayAgain.usage.estimatedCostMicros, 200);
    assert.deepEqual(invocations, ["verification:0", "verification:1"], "completed rerun makes no additional provider calls");
    assert.deepEqual(await readPremiumJournalAccounting(db, scope.analysisRunId), accounting);
    const hold = (await db.query<{ status: string; reserved_credits: number; usage: unknown }>("SELECT status, reserved_credits, usage FROM storyhold.credit_reservations")).rows;
    assert.deepEqual(hold, savedHold, "replay neither changes nor duplicates the original hold");
    assert.equal(fetchCount, 0);
  } finally {
    if (db) await db.close();
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { getAiRuntimeStatus, quoteAiCostReservation, type AiTextResult, type GenerateAiTextInput } from "./aiGateway";
import { analyzeWorld, buildWorldPremiumVerificationPages, parseWorldFindingsFromModel, quoteWorldAnalysisReservation,
  type WorldAnalysisInput, type WorldFindings } from "./worldAnalysis";
import { PREMIUM_STAT_NAMES, premiumNeutralStats, premiumStatCandidates } from "./premiumStatCandidates";
import { mergeReviewedStatEstimates, findingCountsByChunk } from "./worldStudio";

const scope = {
  worldId: "00000000-0000-4000-8000-000000000931",
  editionId: "00000000-0000-4000-8000-000000000932",
  analysisRunId: "00000000-0000-4000-8000-000000000933",
};
function fixture(count = 7): WorldAnalysisInput {
  const chunk = { id: "stat-chunk", sourceId: "stat-source", sourceTitle: "Synthetic assessment", index: 0,
    content: PREMIUM_STAT_NAMES.map((stat) => `Mara demonstrated exceptional ${stat} during the assessment.`).join(" ") };
  const stats = premiumNeutralStats();
  for (const stat of PREMIUM_STAT_NAMES.slice(0, count)) stats[stat] = {
    score: 17, confidence: 0.8, rationale: `The assessment demonstrates exceptional ${stat}.`,
    evidence: [{ chunkId: chunk.id, sourceId: chunk.sourceId, quote: `Mara demonstrated exceptional ${stat} during the assessment.` }],
  };
  const findings = parseWorldFindingsFromModel({ characters: [{
    name: "Mara", summary: "Mara participates in the assessment.", estimatedStats: stats,
    evidence: [{ chunkId: chunk.id, quote: "Mara demonstrated exceptional strength during the assessment." }],
  }] }, [chunk], "candidate");
  return { worldName: "Stat fixture", premise: "", genre: "", chunks: [chunk], sources: [],
    persistedLocalFindings: findings, premiumClaimScope: scope, analysisMode: "connected" };
}
type Contract = { requestFingerprint: string; proposals: Array<{ id: string; payload: { stat: string } }> };
function contract(request: GenerateAiTextInput, kind: string): Contract {
  const match = request.messages.map((message) => message.content).join("\n")
    .match(new RegExp(`<${kind}_VERIFICATION_REQUEST trust="unverified">\\s*([\\s\\S]*?)\\s*</${kind}_VERIFICATION_REQUEST>`, "u"));
  assert.ok(match);
  return JSON.parse(match[1]!) as Contract;
}
function bodyFor(request: GenerateAiTextInput, params: WorldAnalysisInput, verdict = "verified", includeCharacter = true) {
  const stats = contract(request, "STAT");
  const claims = contract(request, "CLAIM");
  const graph = contract(request, "GRAPH");
  assert.equal(claims.proposals.length, 0);
  assert.equal(graph.proposals.length, 0);
  const profile = { ...params.persistedLocalFindings!.characters[0]!, estimatedStats: premiumNeutralStats() };
  return {
    characters: includeCharacter ? [profile] : [],
    claims: [], entityRelations: [], entityRules: [],
    claimVerification: { requestFingerprint: claims.requestFingerprint, decisions: [], newClaims: [] },
    graphVerification: { requestFingerprint: graph.requestFingerprint, decisions: [], newFindings: [] },
    statVerification: { requestFingerprint: stats.requestFingerprint, decisions: stats.proposals.map((proposal) => ({
      proposalId: proposal.id, verdict, explanation: "The manuscript assessment supports this estimate.", confidence: 0.75,
      supportingEvidence: verdict === "verified" ? [{ chunkId: params.chunks[0]!.id,
        quote: `Mara demonstrated exceptional ${proposal.payload.stat} during the assessment.` }] : [],
      contradictingEvidence: [], retrievalRequests: [],
    })), newStats: [] },
    coverage: [{ chunkId: params.chunks[0]!.id, status: includeCharacter || (verdict === "verified" && stats.proposals.length) ? "findings" : "no_findings" }],
  };
}
function result(request: GenerateAiTextInput, body: unknown): AiTextResult {
  const text = JSON.stringify(body);
  request.validate!(text);
  const runtime = getAiRuntimeStatus(request.task, request.contentMode, request.stage);
  return { text, runtime, provider: runtime.provider, model: runtime.model, reasoning: "high",
    journalCompletedAt: "2026-09-03T00:00:00.000Z", usage: { inputUnits: 10, outputUnits: 5, cachedInputUnits: 0,
      cacheWriteInputUnits: 0, reasoningUnits: 0, estimatedCostMicros: 100, pricingKnown: true,
      pricingVersion: "fixture", costEstimated: true } };
}
async function offline(run: () => Promise<void>) {
  const env = { STORYHOLD_VERIFICATION_PROVIDER: "openrouter", STORYHOLD_CHRONOLOGY_PROVIDER: "openrouter",
    STORYHOLD_OPENROUTER_API_KEY: "fake-stat-test-key", STORYHOLD_OPENROUTER_CHRONOLOGY_MODEL: "mistralai/mistral-small-2603" };
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    Object.assign(process.env, env);
    globalThis.fetch = async () => { calls += 1; throw new Error("Network forbidden in stat tests."); };
    await run();
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

test("seven estimates become bounded decisions, survive projection, and complete coverage only after every page", async () => {
  await offline(async () => {
    const params = fixture();
    const pages = buildWorldPremiumVerificationPages(params);
    assert.equal(pages.length, 2);
    const seen: string[] = [];
    const completed: number[] = [];
    const output = await analyzeWorld({ ...params, premiumVerificationPages: pages,
      executePremiumCall: async (step, request) => {
        seen.push(step);
        assert.ok(contract(request, "STAT").proposals.length <= 6);
        return result(request, bodyFor(request, params, "verified", step === "verification:1"));
      }, onCoverage: () => completed.push(seen.length),
    });
    assert.deepEqual(seen, pages.map((page) => page.stepKey));
    assert.ok(completed.every((count) => count === 2));
    assert.equal(output.statReviews?.length, 2);
    assert.equal(output.statReviews?.flatMap((receipt) => receipt.decisions).length, 7);
    assert.equal(premiumStatCandidates(output.findings).length, 7);
    assert.ok(PREMIUM_STAT_NAMES.every((stat) => output.findings.characters[0]!.estimatedStats[stat].score === 17));
    assert.equal(output.coverage?.complete, true);
    assert.equal(output.usage.estimatedCostMicros, 200);
    assert.equal(findingCountsByChunk(output.findings, output.graphReviews, output.statReviews).get("stat-chunk"), 8);
  });
});

test("missing stat decisions stop the review before passage completion", async () => {
  await offline(async () => {
    const params = fixture(1);
    let coverageWrites = 0;
    await assert.rejects(analyzeWorld({ ...params, executePremiumCall: async (_step, request) => {
      const { statVerification: _omitted, ...body } = bodyFor(request, params);
      return result(request, body);
    }, onCoverage: () => { coverageWrites += 1; } }), /statVerification|stat.*object|missing/iu);
    assert.equal(coverageWrites, 0);
  });
});

test("ordinary dossier output cannot smuggle a score past the explicit stat gate", async () => {
  await offline(async () => {
    const params = fixture(0);
    await assert.rejects(analyzeWorld({ ...params, executePremiumCall: async (_step, request) => {
      const body = bodyFor(request, params);
      body.characters[0]!.estimatedStats.strength = { score: 19, confidence: 0.9,
        rationale: "Invented supernatural strength.", evidence: body.characters[0]!.evidence };
      return result(request, body);
    } }), /statVerification|stat estimates/iu);
  });
});

test("rejected estimates stay neutral in generated output and do not wipe existing estimates", async () => {
  await offline(async () => {
    const params = fixture(1);
    const output = await analyzeWorld({ ...params, executePremiumCall: async (_step, request) => result(request, bodyFor(request, params, "rejected")) });
    assert.equal(premiumStatCandidates(output.findings).length, 0);
    const original = params.persistedLocalFindings!.characters[0]!.estimatedStats;
    const merged = mergeReviewedStatEstimates(original, output.findings.characters[0]!.estimatedStats);
    assert.deepEqual(merged.strength, original.strength);
    assert.equal(output.statReviews![0]!.decisions[0]!.verdict, "rejected");
  });
});

test("an explicitly reviewed correction wins over a higher-confidence old estimate without altering unrelated slots", () => {
  const prior = premiumNeutralStats();
  prior.strength = { score: 19, confidence: 0.99, rationale: "Earlier estimate.", evidence: [] };
  prior.wisdom = { score: 14, confidence: 0.6, rationale: "Earlier wisdom.", evidence: [] };
  const incoming = premiumNeutralStats();
  incoming.strength = { score: 12, confidence: 0.7, rationale: "Reviewed ordinary strength.", evidence: [] };
  const merged = mergeReviewedStatEstimates(prior, incoming);
  assert.deepEqual(merged.strength, incoming.strength);
  assert.deepEqual(merged.wisdom, prior.wisdom);
});

test("stat decision prompts and extra pages are included in the exact reservation", async () => {
  await offline(async () => {
    const full = fixture();
    const empty = fixture(0);
    const priced = async (params: WorldAnalysisInput) => {
      const costs: number[] = [];
      await analyzeWorld({ ...params, executePremiumCall: async (step, request) => {
        assert.match(request.system, /STAT VERIFICATION OVERRIDE/u);
        costs.push(quoteAiCostReservation(request).maximumCostMicros);
        return result(request, bodyFor(request, params, "verified", step === "verification:0" || step === "verification:1"));
      } });
      return costs.reduce((sum, cost) => sum + cost, 0);
    };
    const fullQuote = quoteWorldAnalysisReservation(full);
    const emptyQuote = quoteWorldAnalysisReservation(empty);
    assert.equal(fullQuote.batchCount - emptyQuote.batchCount, 1);
    assert.equal(fullQuote.maximumCostMicros - emptyQuote.maximumCostMicros, await priced(full) - await priced(empty));
  });
});

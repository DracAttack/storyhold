import assert from "node:assert/strict";
import test from "node:test";
import { entityReviewRequest, premiumEntityReviewRequest, quoteEntityReviewReservation, reviewEntity, reviewEntityFromBrowser, reviewEntityFromSavedResult, type EntityReviewInput } from "./entityReview";
import { getAiRuntimeStatus, quoteAiCostReservation, type AiTextResult, type GenerateAiTextInput } from "./aiGateway";
import { assertEntityStatReviews } from "./entityStatVerification";
import { PREMIUM_STAT_NAMES, premiumNeutralStats } from "./premiumStatCandidates";
import type { CharacterFinding } from "./worldAnalysis";

const quote = "Mara lifted the gate and held it open until the others escaped.";
function input(depth: EntityReviewInput["depth"] = "focused", entityType = "character"): EntityReviewInput {
  const stats = premiumNeutralStats();
  for (const stat of PREMIUM_STAT_NAMES) stats[stat] = { score: 14, confidence: 0.6,
    rationale: `Mara demonstrates exceptional ${stat}.`, evidence: [{ chunkId: "c1", sourceId: "s1", quote }] };
  return {
    worldName: "Synthetic world", worldPremise: "", worldGenre: "Fantasy", depth,
    entity: { id: "entity-1", name: "Mara", entityType, aliases: [], summary: "Mara holds the gate.", details: [], relationships: [], estimatedStats: stats },
    currentCharacter: entityType === "character" ? { name: "Mara", estimatedStats: stats } as CharacterFinding : undefined,
    chunks: [{ id: "c1", sourceId: "s1", sourceTitle: "Book One", index: 0, content: quote }],
    knownEntities: [{ name: "Mara", entityType, aliases: [] }],
    premiumStatScope: { worldId: "world-1", editionId: "edition-1", analysisRunId: "review-1" },
    userGuidance: "Review the ordinary character, not a transformed creature.",
  };
}
type Contract = { requestFingerprint: string; proposals: Array<{ id: string; payload: { stat: string } }> };
function contracts(request: GenerateAiTextInput): Contract[] {
  const content = request.messages.map((message) => message.content).join("\n");
  return [...content.matchAll(/<STAT_VERIFICATION_REQUEST trust="unverified">\s*([\s\S]*?)\s*<\/STAT_VERIFICATION_REQUEST>/gu)]
    .map((match) => JSON.parse(match[1]!) as Contract);
}
function body(request: GenerateAiTextInput, verdict = "verified", prose = true) {
  return {
    summary: prose ? "Mara protects the others by holding the escape route open." : "",
    evidence: prose ? [{ chunkId: "c1", quote }] : [], aliases: [], details: [], relationships: [], confidence: 0.8,
    estimatedStats: null, character: null, relations: [], rules: [],
    statVerifications: contracts(request).map((contract) => ({ requestFingerprint: contract.requestFingerprint,
      decisions: contract.proposals.map((proposal) => ({ proposalId: proposal.id, verdict,
        explanation: "The demonstrated action supports the exact estimate.", confidence: 0.75,
        supportingEvidence: verdict === "verified" ? [{ chunkId: "c1", quote }] : [], contradictingEvidence: [], retrievalRequests: [],
      })), newStats: [] })),
  };
}
function result(request: GenerateAiTextInput, value: unknown): AiTextResult {
  const text = JSON.stringify(value);
  assert.ok(request.validate, "connected review must validate before returning any result");
  request.validate(text);
  const runtime = getAiRuntimeStatus(request.task, request.contentMode, request.stage);
  assert.equal(runtime.provider, "openrouter");
  return { text, runtime, provider: "openrouter", model: runtime.model, reasoning: "high",
    usage: { inputUnits: 100, outputUnits: 50, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 0,
      estimatedCostMicros: 250, pricingKnown: true, pricingVersion: "fixture", costEstimated: true } };
}
async function offline(run: () => Promise<void>): Promise<void> {
  const environment = { STORYHOLD_DOSSIER_PROVIDER: "openrouter", STORYHOLD_OPENROUTER_API_KEY: "fake-premium-dossier-test-key" };
  const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    Object.assign(process.env, environment);
    globalThis.fetch = async () => { calls += 1; throw new Error("Network is forbidden in premium dossier tests."); };
    await run();
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

async function withoutProviderConfiguration(run: () => Promise<void>): Promise<void> {
  const keys = ["STORYHOLD_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY", "AI_INTEGRATIONS_ANTHROPIC_API_KEY",
    "STORYHOLD_OPENAI_API_KEY", "OPENAI_API_KEY", "STORYHOLD_XAI_API_KEY", "XAI_API_KEY",
    "STORYHOLD_KIMI_API_KEY", "KIMI_API_KEY", "MOONSHOT_API_KEY", "STORYHOLD_OPENROUTER_API_KEY"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = "";
    assert.equal(getAiRuntimeStatus("canon_review", "standard", "dossier").configured, false);
    await run();
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

test("focused and full dossier reruns verify all seven stats in one quoted provider call", async () => {
  await offline(async () => {
    for (const depth of ["focused", "full"] as const) {
      const params = input(depth); let count = 0;
      let actualRequest: GenerateAiTextInput | undefined;
      const output = await reviewEntity(params, { execute: async (request) => {
        count += 1; actualRequest = request;
        assert.deepEqual(contracts(request).map((contract) => contract.proposals.length), [6, 1]);
        return result(request, body(request));
      } });
      assert.equal(count, 1);
      assert.equal(actualRequest!.maxOutputTokens, depth === "focused" ? 6_000 : 9_500);
      assert.equal(actualRequest!.maxOutputTokens! - entityReviewRequest(params).maxOutputTokens!, 2_500);
      assert.deepEqual(quoteEntityReviewReservation(params), quoteAiCostReservation(actualRequest!));
      assert.equal(quoteEntityReviewReservation(params).maxOutputUnits, actualRequest!.maxOutputTokens);
      assert.equal(output.statReviews.length, 2);
      assert.equal(output.statReviews.flatMap((review) => review.decisions).length, 7);
      assertEntityStatReviews(params, output.statReviews);
      for (const stat of PREMIUM_STAT_NAMES) {
        assert.equal(output.finding.character!.estimatedStats[stat].score, 14);
        assert.equal(output.finding.character!.estimatedStats[stat].confidence, 0.75);
        assert.deepEqual(output.finding.character!.estimatedStats[stat].evidence, [{ chunkId: "c1", sourceId: "s1", quote }]);
      }
      assert.match(actualRequest!.system, /PREMIUM STAT OVERRIDE/);
      assert.match(actualRequest!.messages.map((message) => message.content).join("\n"), /ONE provider call/);
    }
  });
});

test("creature dossier rerun uses the same gate and cultural references retain ordinary output budgets", async () => {
  await offline(async () => {
    const creature = input("focused", "creature"); let count = 0;
    const output = await reviewEntity(creature, { execute: async (request) => { count += 1; return result(request, body(request)); } });
    assert.equal(count, 1); assert.equal(output.finding.character, null);
    assert.equal(output.finding.estimatedStats!.strength!.score, 14);
    for (const type of ["term", "cultural_reference"]) {
      const params = input("focused", type);
      assert.equal(premiumEntityReviewRequest(params).maxOutputTokens, entityReviewRequest(params).maxOutputTokens);
      const reference = await reviewEntity(params, { execute: async (request) => {
        assert.equal(contracts(request).length, 0);
        return result(request, body(request));
      } });
      assert.deepEqual(reference.statReviews, []); assert.equal(reference.finding.estimatedStats, null);
    }
  });
});

test("raw meaningful dossier stats are rejected before score clamping or current-stat carryover", async () => {
  await offline(async () => {
    for (const nested of [false, true]) {
      const params = input();
      await assert.rejects(reviewEntity(params, { execute: async (request) => {
        const raw: Record<string, unknown> = body(request);
        const unauthorized = { strength: { score: 100, confidence: 0.99, rationale: "An invented estimate.", evidence: [{ chunkId: "c1", quote }] } };
        if (nested) raw.character = { estimatedStats: unauthorized };
        else raw.estimatedStats = unauthorized;
        return result(request, raw);
      } }), /integer|raw estimatedStats/);
    }
    const params = input();
    await assert.rejects(reviewEntity(params, { execute: async (request) => {
      const raw: Record<string, unknown> = body(request);
      raw.character = { estimatedStats: params.currentCharacter!.estimatedStats };
      return result(request, raw);
    } }), /raw estimatedStats/);
  });
});

test("missing or incomplete stat review groups cannot produce a successful connected dossier", async () => {
  await offline(async () => {
    for (const change of ["absent", "empty", "one", "decision"] as const) {
      await assert.rejects(reviewEntity(input(), { execute: async (request) => {
        const raw = body(request);
        if (change === "absent") return result(request, { ...raw, statVerifications: undefined });
        if (change === "empty") raw.statVerifications = [];
        if (change === "one") raw.statVerifications.pop();
        if (change === "decision") raw.statVerifications[0]!.decisions.pop();
        return result(request, raw);
      } }), /expected review groups|exactly one/);
    }
  });
});

test("verified stat-only output is useful, but rejected-only blank output cannot claim a completed review", async () => {
  await offline(async () => {
    for (const entityType of ["character", "creature"]) {
      const params = input("focused", entityType);
      const output = await reviewEntity(params, { execute: async (request) => result(request, body(request, "verified", false)) });
      assert.equal(output.finding.summary, "");
      assert.deepEqual(output.finding.evidence, []);
      assert.equal(output.statReviews.flatMap((review) => review.decisions).length, 7);
      assert.equal(output.finding.character?.estimatedStats.strength.score ?? output.finding.estimatedStats?.strength?.score, 14);
      await assert.rejects(reviewEntity(params, { execute: async (request) => result(request, body(request, "rejected", false)) }), /useful dossier claims/);
    }
  });
});

test("actual routed model and durable completion timestamp are fixed on every stat receipt", async () => {
  await offline(async () => {
    const params = input();
    const completedAt = "2026-09-04T03:04:05.678Z";
    const output = await reviewEntity(params, { execute: async (request) => {
      const generated = result(request, body(request));
      assert.ok(generated.runtime.execution);
      return { ...generated, journalCompletedAt: completedAt,
        runtime: { ...generated.runtime, execution: { ...generated.runtime.execution, resolvedModel: "fixture/resolved-model", upstreamProvider: "fixture-gpu" } } };
    } });
    assert.ok(output.statReviews.every((receipt) => receipt.verifier.completedAt === completedAt && receipt.verifier.model === "fixture/resolved-model" && receipt.verifier.provider === "openrouter"));
    assert.ok(output.statReviews.flatMap((receipt) => receipt.decisions).every((decision) => decision.completedAt === completedAt && decision.verifier.model === "fixture/resolved-model"));
    assertEntityStatReviews(params, output.statReviews);
  });
});

test("saved dossier results revalidate with no provider configured and retain the exact completion and routed model", async () => {
  await offline(async () => {
    const params = input(); let executions = 0;
    const completedAt = "2026-09-04T04:05:06.789Z";
    const completed = await reviewEntity(params, { execute: async (request) => {
      executions += 1;
      const generated = result(request, body(request));
      return { ...generated, journalCompletedAt: completedAt,
        runtime: { ...generated.runtime, execution: { ...generated.runtime.execution!, resolvedModel: "fixture/offline-resolved-model", upstreamProvider: "fixture-upstream" } } };
    } });
    const storedResult = structuredClone(completed.result);
    await withoutProviderConfiguration(async () => {
      await assert.rejects(reviewEntity(params, { execute: async () => { executions += 1; return storedResult; } }), /No connected AI provider/);
      const replay = reviewEntityFromSavedResult(params, storedResult);
      assert.deepEqual(replay.finding, completed.finding);
      assert.deepEqual(replay.result, storedResult);
      assert.deepEqual(replay.statReviews, completed.statReviews);
      assert.equal(replay.result.journalCompletedAt, completedAt);
      assert.ok(replay.statReviews.every((receipt) => receipt.verifier.completedAt === completedAt
        && receipt.verifier.model === "fixture/offline-resolved-model" && receipt.verifier.provider === "openrouter"));
      assert.ok(replay.statReviews.flatMap((receipt) => receipt.decisions).every((decision) => decision.completedAt === completedAt
        && decision.verifier.model === "fixture/offline-resolved-model"));
      assertEntityStatReviews(params, replay.statReviews);
    });
    assert.equal(executions, 1, "offline replay never executes a provider or local model");
  });
});

test("offline saved dossier replay still rejects changed sources and incomplete verification decisions", async () => {
  await offline(async () => {
    const params = input();
    const completed = await reviewEntity(params, { execute: async (request) => ({
      ...result(request, body(request)), journalCompletedAt: "2026-09-04T04:05:06.789Z",
    }) });
    await withoutProviderConfiguration(async () => {
      const changed = structuredClone(params); changed.chunks[0]!.content = "Mara left the gate untouched.";
      assert.throws(() => reviewEntityFromSavedResult(changed, completed.result), /fingerprint|request|match/iu);
      const raw = JSON.parse(completed.result.text); raw.statVerifications[0].decisions.pop();
      assert.throws(() => reviewEntityFromSavedResult(params, { ...completed.result, text: JSON.stringify(raw) }), /exactly one|decision/iu);
    });
  });
});

test("verified stat evidence cannot authorize unrelated uncited dossier prose", async () => {
  await offline(async () => {
    const params = input();
    await assert.rejects(reviewEntity(params, { execute: async (request) => {
      const raw = body(request, "verified", false);
      raw.summary = "Mara is immortal.";
      assert.deepEqual(raw.evidence, []);
      assert.equal(raw.character, null);
      return result(request, raw);
    } }), /exact supplied passage/);
  });
});

test("local browser dossier reruns stay provisional and do not need a premium scope or receipt", () => {
  const params = input(); delete params.premiumStatScope;
  const local = reviewEntityFromBrowser(params, { model: "Qwen-local-test", inputTokens: 100, outputTokens: 40,
    text: JSON.stringify({ summary: "Mara protects the escape route.", evidence: [{ chunkId: "c1", quote }], character: { summary: "Mara holds the gate." } }) });
  assert.equal(local.result.provider, "storyhold-browser");
  assert.equal(local.result.model, "Qwen-local-test");
  assert.equal(local.result.usage.estimatedCostMicros, 0);
  assert.equal(Object.hasOwn(local, "statReviews"), false);
  assert.equal(local.finding.character!.reviewStatus, undefined);
  assert.deepEqual(local.finding.character!.estimatedStats, params.currentCharacter!.estimatedStats);
  const emptyBase = input(); delete emptyBase.premiumStatScope; delete emptyBase.currentCharacter;
  const defaults = reviewEntityFromBrowser(emptyBase, { model: "Qwen-local-test", inputTokens: 100, outputTokens: 40,
    text: JSON.stringify({ summary: "Mara protects the escape route.", evidence: [{ chunkId: "c1", quote }] }) });
  assert.equal(defaults.finding.character!.estimatedStats.strength.score, 10);
  assert.equal(defaults.finding.character!.estimatedStats.strength.confidence, 0);
  assert.deepEqual(defaults.finding.character!.estimatedStats.strength.evidence, []);
});

test("connected review requires an explicit premium scope before dispatch", async () => {
  await offline(async () => {
    const params = input(); delete params.premiumStatScope; let dispatched = 0;
    await assert.rejects(reviewEntity(params, { execute: async (request) => { dispatched += 1; return result(request, body(request)); } }), /scoped premium review ID/);
    assert.equal(dispatched, 0);
    assert.throws(() => quoteEntityReviewReservation(params), /scoped premium review ID/);
  });
});

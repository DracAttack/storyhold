import assert from "node:assert/strict";
import test from "node:test";
import {
  entityReviewRequest, premiumEntityReviewRequest, quoteEntityReviewReservation, reviewEntity, reviewEntityFromSavedResult,
  type EntityReviewInput,
} from "./entityReview";
import { getAiRuntimeStatus, quoteAiCostReservation, type AiTextResult, type GenerateAiTextInput } from "./aiGateway";
import { buildEntityGraphRequest } from "./entityGraphVerification";
import { buildEntityStatRequests } from "./entityStatVerification";
import { premiumNeutralStats } from "./premiumStatCandidates";
import type { CharacterFinding, EntityRelationFinding } from "./worldAnalysis";

const quote = "Mira was a member of the Watch until the winter uprising.";
const statQuote = "Mira lifted the iron gate and held it open while the others escaped.";
const completedAt = "2026-09-04T13:14:15.000Z";
const entities = [{ id: "mira-id", name: "Mira", entityType: "character", aliases: ["Miri"] },
  { id: "watch-id", name: "Watch", entityType: "faction", aliases: [] }];
function relation(): EntityRelationFinding {
  return { subject: "Mira", target: "Watch", relationType: "member_of", status: "former", summary: "Mira left the Watch during the uprising.",
    validFromLabel: "before winter", validUntilLabel: "winter uprising", evidence: [{ chunkId: "c1", sourceId: "s1", quote }], confidence: 0.7 };
}
function input(depth: EntityReviewInput["depth"] = "focused"): EntityReviewInput {
  const stats = premiumNeutralStats();
  stats.strength = { score: 14, confidence: 0.6, rationale: "Mira lifts and holds an iron gate.", evidence: [{ chunkId: "c1", sourceId: "s1", quote: statQuote }] };
  return { worldName: "Winter Watch", worldPremise: "A winter uprising changes loyalties.", worldGenre: "Fantasy", depth,
    entity: { id: "mira-id", name: "Mira", entityType: "character", aliases: ["Miri"], summary: "Mira was a Watch guard.", details: [], relationships: [], estimatedStats: stats },
    currentCharacter: { name: "Mira", estimatedStats: stats } as CharacterFinding,
    chunks: [{ id: "c1", sourceId: "s1", sourceTitle: "Winter", index: 0, content: `${quote} ${statQuote}` }],
    knownEntities: structuredClone(entities), premiumStatScope: { worldId: "world-1", editionId: "edition-1", analysisRunId: "review-1" },
    userGuidance: "Preserve earlier allegiance and the later departure.",
    graphReview: { version: 1, relations: [relation()], rules: [], entities: structuredClone(entities) } };
}
function decision(proposalId: string, evidenceQuote: string, verdict = "verified") {
  return { proposalId, verdict, explanation: "The passage directly supports this complete interpretation.", confidence: 0.9,
    supportingEvidence: verdict === "verified" ? [{ chunkId: "c1", quote: evidenceQuote }] : [], contradictingEvidence: [], retrievalRequests: [] };
}
function body(params: EntityReviewInput, options: { prose?: boolean; stats?: string; graph?: string } = {}) {
  const graph = buildEntityGraphRequest(params);
  return { summary: options.prose === false ? "" : "Mira protects the others and leaves the Watch during the uprising.",
    evidence: options.prose === false ? [] : [{ chunkId: "c1", quote: statQuote }], aliases: [], details: [], relationships: [], confidence: 0.9,
    estimatedStats: null, character: null, relations: [], rules: [],
    statVerifications: buildEntityStatRequests(params).map((request) => ({ requestFingerprint: request.fingerprint,
      decisions: request.proposals.map((proposal) => decision(proposal.id, statQuote, options.stats)), newStats: [] })),
    ...(graph ? { entityRelations: [], entityRules: [], graphVerification: { requestFingerprint: graph.fingerprint,
      decisions: graph.proposals.map((proposal) => decision(proposal.id, quote, options.graph)), newFindings: [] as Array<Record<string, unknown>> } } : {}),
  };
}
function savedResult(request: GenerateAiTextInput, raw: unknown): AiTextResult {
  const runtime = getAiRuntimeStatus(request.task, request.contentMode, request.stage);
  return { text: JSON.stringify(raw), provider: "openrouter", model: "fixture/requested-model", reasoning: "high", journalCompletedAt: completedAt,
    runtime: { ...runtime, execution: { ...runtime.execution!, resolvedModel: "fixture/actual-routed-model", upstreamProvider: "fixture-gpu" } },
    usage: { inputUnits: 200, outputUnits: 100, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 0,
      estimatedCostMicros: 400, pricingKnown: true, pricingVersion: "fixture", costEstimated: true } };
}
async function offline(run: () => Promise<void>): Promise<void> {
  const configured = { STORYHOLD_DOSSIER_PROVIDER: "openrouter", STORYHOLD_OPENROUTER_API_KEY: "fake-offline-graph-flow-key" };
  const previous = new Map(Object.keys(configured).map((key) => [key, process.env[key]]));
  const fetch = globalThis.fetch; let fetches = 0;
  try {
    Object.assign(process.env, configured);
    globalThis.fetch = async () => { fetches += 1; throw new Error("Live network is forbidden in graph flow tests."); };
    await run(); assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = fetch;
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
async function disconnected(run: () => Promise<void>): Promise<void> {
  const keys = ["STORYHOLD_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY", "AI_INTEGRATIONS_ANTHROPIC_API_KEY", "STORYHOLD_OPENAI_API_KEY", "OPENAI_API_KEY",
    "STORYHOLD_XAI_API_KEY", "XAI_API_KEY", "STORYHOLD_KIMI_API_KEY", "KIMI_API_KEY", "MOONSHOT_API_KEY", "STORYHOLD_OPENROUTER_API_KEY"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try { for (const key of keys) process.env[key] = ""; assert.equal(getAiRuntimeStatus("canon_review", "standard", "dossier").configured, false); await run(); }
  finally { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

test("focused and full review share exactly one quoted call for prose, graph and both stat groups", async () => {
  await offline(async () => {
    for (const depth of ["focused", "full"] as const) {
      const params = input(depth); let calls = 0; let dispatched: GenerateAiTextInput | undefined;
      const reviewed = await reviewEntity(params, { execute: async (request) => {
        calls += 1; dispatched = request;
        const content = request.messages.map((message) => message.content).join("\n");
        assert.equal([...content.matchAll(/<STAT_VERIFICATION_REQUEST trust="unverified">/gu)].length, 2);
        assert.equal([...content.matchAll(/<GRAPH_VERIFICATION_REQUEST trust="unverified">/gu)].length, 1);
        assert.match(content, /SAME single provider call/);
        assert.match(content, /mira-id/);
        assert.equal(request.allowProviderFallback, false); assert.equal(request.providerFailurePolicy, "stop");
        const result = savedResult(request, body(params)); request.validate!(result.text); return result;
      } });
      assert.equal(calls, 1); assert.ok(dispatched);
      assert.equal(dispatched.maxOutputTokens, depth === "focused" ? 12_500 : 16_000);
      assert.equal(dispatched.maxOutputTokens! - entityReviewRequest(params).maxOutputTokens!, 9_000);
      assert.deepEqual(quoteEntityReviewReservation(params), quoteAiCostReservation(dispatched));
      assert.equal(quoteEntityReviewReservation(params).maxOutputUnits, dispatched.maxOutputTokens);
      assert.equal(reviewed.statReviews.length, 2); assert.ok(reviewed.graphReview);
      assert.equal(reviewed.finding.relations.length, 1); assert.equal(reviewed.finding.character!.estimatedStats.strength.score, 14);
      assert.deepEqual(reviewed.finding.character!.factionMemberships, []);
    }
  });
});

test("new graph request capacity fails before an injected provider could execute", async () => {
  await offline(async () => {
    const params = input(); params.graphReview!.relations = [];
    params.graphReview!.rules = Array.from({ length: 13 }, (_, index) => ({ entity: "Mira", name: `Rule ${index}`, description: "A behavior.", ruleKind: "trait" as const,
      trigger: "", effect: "A behavior.", confidence: 0.5, evidence: [{ chunkId: "c1", sourceId: "s1", quote }] }));
    let calls = 0;
    assert.throws(() => quoteEntityReviewReservation(params), /exceeds 12/);
    await assert.rejects(reviewEntity(params, { execute: async (request) => { calls += 1; return savedResult(request, {}); } }), /exceeds 12/);
    assert.equal(calls, 0);
  });
});

test("modern saved output replays offline with exact actual provider, routed model and durable completion time", async () => {
  await offline(async () => {
    const params = input(); let calls = 0;
    const reviewed = await reviewEntity(params, { execute: async (request) => {
      calls += 1; const result = savedResult(request, body(params)); request.validate!(result.text); return result;
    } });
    await disconnected(async () => {
      await assert.rejects(reviewEntity(params, { execute: async () => { calls += 1; return reviewed.result; } }), /No connected AI provider/);
      const replay = reviewEntityFromSavedResult(params, structuredClone(reviewed.result));
      assert.deepEqual(replay.finding, reviewed.finding); assert.deepEqual(replay.graphReview, reviewed.graphReview); assert.deepEqual(replay.statReviews, reviewed.statReviews);
      assert.deepEqual(replay.graphReview!.verifier, { provider: "openrouter", model: "fixture/actual-routed-model", completedAt });
      for (const receipt of [replay.graphReview!, ...replay.statReviews]) {
        assert.equal(receipt.verifier.completedAt, completedAt);
        assert.equal(receipt.verifier.model, "fixture/actual-routed-model");
        assert.ok(receipt.decisions.every((entry) => entry.completedAt === completedAt && entry.verifier.provider === "openrouter" && entry.verifier.model === "fixture/actual-routed-model"));
      }
      const changed = structuredClone(params); changed.graphReview!.entities[1]!.id = "replacement-canonical-record";
      assert.throws(() => reviewEntityFromSavedResult(changed, reviewed.result), /requestFingerprint/);
    });
    assert.equal(calls, 1);
  });
});

test("legacy saved response retains its prior parser and stat output without acquiring a new graph receipt", async () => {
  await offline(async () => {
    const params = input(); delete params.graphReview;
    const request = premiumEntityReviewRequest(params);
    assert.equal(request.maxOutputTokens, 6_000);
    assert.doesNotMatch(request.messages.map((message) => message.content).join("\n"), /GRAPH_VERIFICATION_REQUEST/);
    const raw = { ...body(params), relations: [relation()], relationships: ["Mira used to belong to the Watch."] };
    const saved = savedResult(request, raw);
    const original = reviewEntityFromSavedResult(params, saved);
    await disconnected(async () => {
      const replay = reviewEntityFromSavedResult(params, structuredClone(saved));
      assert.deepEqual(replay.finding, original.finding); assert.equal(replay.graphReview, undefined);
      assert.equal(replay.finding.relations[0]!.status, "former");
      assert.deepEqual(replay.finding.relationships, raw.relationships);
      assert.equal(replay.finding.character!.estimatedStats.strength.score, 14);
    });
  });
});

test("graph-only corrections are meaningful without inventing new biography or approving rejected stats", async () => {
  await offline(async () => {
    const params = input();
    const raw = body(params, { prose: false, stats: "rejected" });
    const reviewed = reviewEntityFromSavedResult(params, savedResult(premiumEntityReviewRequest(params), raw));
    assert.equal(reviewed.finding.summary, ""); assert.deepEqual(reviewed.finding.evidence, []);
    assert.equal(reviewed.finding.relations.length, 1); assert.deepEqual(reviewed.finding.character!.estimatedStats.strength, premiumNeutralStats().strength);
    assert.match(reviewed.finding.character!.relationshipWeb[0]!.relationship, /Former: Member Of/);
    const rejected = body(params, { prose: false, stats: "rejected", graph: "rejected" });
    assert.throws(() => reviewEntityFromSavedResult(params, savedResult(premiumEntityReviewRequest(params), rejected)), /useful dossier claims/);
  });
});

test("verified graph evidence cannot authorize unrelated uncited ordinary biography, aliases or details", async () => {
  await offline(async () => {
    const params = input();
    const mutations: Array<(raw: Record<string, unknown>) => void> = [
      (raw) => { raw.summary = "Mira is immortal."; }, (raw) => { raw.aliases = ["The Immortal"]; },
      (raw) => { raw.details = ["Mira can never die."]; },
      (raw) => { raw.character = { summary: "Mira is immortal.", relationships: [], relationshipWeb: [], factionMemberships: [] }; },
      (raw) => { raw.character = { aliases: ["The Immortal"], relationships: [], relationshipWeb: [], factionMemberships: [] }; },
      (raw) => { raw.character = { traits: ["Immortal"], relationships: [], relationshipWeb: [], factionMemberships: [] }; },
    ];
    for (const mutate of mutations) {
      const raw = body(params, { prose: false, stats: "rejected" }) as Record<string, unknown>; mutate(raw);
      assert.throws(() => reviewEntityFromSavedResult(params, savedResult(premiumEntityReviewRequest(params), raw)), /exact supplied passage|own.*evidence|ordinary/);
    }
  });
});

test("modern execution and saved replay reject missing graph decisions and raw relationship bypasses", async () => {
  await offline(async () => {
    const params = input();
    const mutations: Array<(raw: Record<string, unknown>) => void> = [
      (raw) => { delete raw.graphVerification; }, (raw) => { raw.relations = [relation()]; }, (raw) => { raw.entityRelations = [relation()]; },
      (raw) => { raw.relationships = ["Mira controls the Watch."]; },
      (raw) => { raw.character = { relationshipWeb: [{ name: "Watch", relationship: "Controls" }] }; },
      (raw) => { raw.character = { factionMemberships: ["Watch"] }; },
      (raw) => { (raw.graphVerification as { decisions: unknown[] }).decisions = []; },
    ];
    for (const mutate of mutations) {
      let attempts = 0; const raw = body(params) as Record<string, unknown>; mutate(raw);
      await assert.rejects(reviewEntity(params, { execute: async (request) => {
        attempts += 1; const result = savedResult(request, raw); request.validate!(result.text); return result;
      } }), /graphVerification|empty array|exactly one/);
      assert.equal(attempts, 1, "validation never issues another provider request");
      assert.throws(() => reviewEntityFromSavedResult(params, savedResult(premiumEntityReviewRequest(params), raw)), /graphVerification|empty array|exactly one/);
    }
  });
});

test("new graph output cannot introduce a dossier, unknown endpoint, or undeclared entity array", async () => {
  await offline(async () => {
    const params = input();
    const raw = body(params); const { evidence: _evidence, confidence: _confidence, ...payload } = relation();
    raw.graphVerification!.newFindings = [{ kind: "relation", payload: { ...payload, target: "Invented Stranger" },
      ...decision("unused", quote, "rejected") }];
    delete raw.graphVerification!.newFindings[0]!.proposalId;
    assert.throws(() => reviewEntityFromSavedResult(params, savedResult(premiumEntityReviewRequest(params), raw)), /missing or ambiguous/);
    for (const name of ["characters", "newEntities", "places"]) {
      assert.throws(() => reviewEntityFromSavedResult(params, savedResult(premiumEntityReviewRequest(params), { ...body(params), [name]: [{ name: "Invented Stranger" }] })), /undeclared response array/);
    }
  });
});

test("modern graph and stat receipts survive JSONB-style nested object key reordering with owner corrections", async () => {
  await offline(async () => {
    const params = input(); params.ownerCanonConstraints = [{ id: "owner-1", kind: "relationship", instruction: "Keep the earlier membership and later departure separate." }];
    const reviewed = reviewEntityFromSavedResult(params, savedResult(premiumEntityReviewRequest(params), body(params)));
    const reordered = JSON.parse(JSON.stringify(params, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => right.localeCompare(left))) : value)) as EntityReviewInput;
    assert.notEqual(JSON.stringify(reordered.ownerCanonConstraints), JSON.stringify(params.ownerCanonConstraints));
    const replay = reviewEntityFromSavedResult(reordered, reviewed.result);
    assert.deepEqual(replay.graphReview, reviewed.graphReview); assert.deepEqual(replay.statReviews, reviewed.statReviews);
  });
});

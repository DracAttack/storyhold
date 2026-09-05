import assert from "node:assert/strict";
import test from "node:test";
import { buildEntityGraphRequest } from "./entityGraphVerification";
import { buildEntityStatRequests } from "./entityStatVerification";
import { premiumEntityReviewPages, quoteEntityReviewReservation, reviewEntity, reviewEntityFromSavedResult,
  type EntityReviewInput, type PagedEntityReviewResult } from "./entityReview";
import { getAiRuntimeStatus, quoteAiCostReservation, type AiBillableAttempt, type AiTextResult } from "./aiGateway";

const passage = "Mira keeps watch at night and cannot leave her post until dawn.";
function input(count = 25): EntityReviewInput {
  return { worldName: "Night Watch", worldPremise: "Guarding the city.", worldGenre: "Fantasy", depth: "focused",
    entity: { id: "mira", name: "Mira", entityType: "character", aliases: [], summary: "", details: [], relationships: [] },
    knownEntities: [{ name: "Mira", entityType: "character", aliases: [] }],
    premiumStatScope: { worldId: "world", editionId: "edition", analysisRunId: "review" },
    ownerCanonConstraints: [{ id: "direction", kind: "correction", instruction: "Preserve the night-only condition." }],
    chunks: [{ id: "chunk", sourceId: "source", sourceTitle: "Night", index: 0, content: passage }],
    graphReview: { version: 2, entities: [{ id: "mira", name: "Mira", entityType: "character", aliases: [] }], relations: [],
      rules: Array.from({ length: count }, (_, index) => ({ entity: "Mira", name: `Night Rule ${index}`, description: "Mira guards at night.",
        ruleKind: "constraint", trigger: "At night", effect: "Remain at her post until dawn", confidence: 0.5,
        evidence: [{ chunkId: "chunk", sourceId: "source", quote: passage }] })) } };
}
function raw(page: ReturnType<typeof premiumEntityReviewPages>[number], index: number, verdict = "verified") {
  const graph = buildEntityGraphRequest(page.input)!;
  return { ...(index === 0 ? { summary: "Mira guards the city through the night.", evidence: [{ chunkId: "chunk", quote: passage }],
    aliases: [], details: [], relationships: [], estimatedStats: null, character: null, confidence: 0.9,
    statVerifications: buildEntityStatRequests(page.input).map((request) => ({ requestFingerprint: request.fingerprint, decisions: [], newStats: [] })) } : {}),
    relations: [], rules: [], entityRelations: [], entityRules: [], graphVerification: { requestFingerprint: graph.fingerprint,
      decisions: graph.proposals.map((proposal) => ({ proposalId: proposal.id, verdict, confidence: 0.9,
        explanation: verdict === "verified" ? "The passage directly supports the restriction." : "The passage does not establish this rule.",
        supportingEvidence: verdict === "verified" ? [{ chunkId: "chunk", quote: passage }] : [], contradictingEvidence: [], retrievalRequests: [] })), newFindings: [] } };
}
function result(value: unknown, index: number): AiTextResult {
  return { text: JSON.stringify(value), provider: "openrouter", model: "requested-fixture", reasoning: "medium",
    journalCompletedAt: `2026-09-05T00:00:${String(index).padStart(2, "0")}.000Z`,
    runtime: { ...getAiRuntimeStatus("canon_review", "standard", "dossier"), execution: {
      ...getAiRuntimeStatus("canon_review", "standard", "dossier").execution!, resolvedModel: `actual-model-${index}`, upstreamProvider: "fixture" } },
    usage: { inputUnits: 100, outputUnits: 80, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 0,
      estimatedCostMicros: 100, pricingKnown: true, pricingVersion: "fixture", costEstimated: true } };
}
function aggregate(pages: ReturnType<typeof premiumEntityReviewPages>, values = pages.map((page, index) => raw(page, index))): PagedEntityReviewResult {
  const results = pages.map((page, index) => ({ stepKey: page.stepKey, result: result(values[index], index) }));
  const priorBillableAttempts: AiBillableAttempt[] = results.slice(0, -1).map(({ result: value }) => ({ provider: value.provider,
    model: value.model, resolvedModel: value.runtime.execution!.resolvedModel, upstreamProvider: "fixture", stage: "dossier", reasoning: value.reasoning, usage: value.usage }));
  return { ...results.at(-1)!.result, priorBillableAttempts, entityReviewPages: results };
}

test("dense dossier uses bounded graph continuation requests, retaining every candidate and one prose/stat pass", async () => {
  const params = input(); const pages = premiumEntityReviewPages(params);
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map((page) => page.request.maxOutputTokens), [12_500, 6_500, 6_500]);
  assert.deepEqual(pages.map((page) => buildEntityGraphRequest(page.input)!.proposals.length), [12, 12, 1]);
  assert.equal(pages.filter((page) => page.request.messages.some((message) => message.content.includes("<STAT_VERIFICATION_REQUEST"))).length, 1);
  let executions = 0;
  const reviewed = await reviewEntity(params, { executePages: async (requests) => {
    executions += 1; assert.equal(requests.length, 3);
    requests.forEach((page, index) => page.request.validate!(JSON.stringify(raw(page, index))));
    return aggregate(requests);
  } });
  assert.equal(executions, 1); assert.equal(reviewed.finding.rules.length, 25);
  assert.equal(reviewed.statReviews.length, 2); assert.equal(reviewed.graphReviews!.length, 3);
  assert.deepEqual(reviewed.graphReviews!.map((receipt) => receipt.verifier.model), ["actual-model-0", "actual-model-1", "actual-model-2"]);
  assert.equal(reviewed.finding.summary, "Mira guards the city through the night.");
});

test("small dossier still takes one request and aggregate reservation covers every dense request", () => {
  // Fixed offline rates ensure this is not merely checking that zero + zero =
  // zero on a machine with no configured provider. Nothing invokes the gateway.
  const settings = { STORYHOLD_DOSSIER_PROVIDER: "openrouter", STORYHOLD_OPENROUTER_API_KEY: "offline-fixture-key",
    STORYHOLD_OPENROUTER_DOSSIER_MODEL: "fixture/dossier", STORYHOLD_OPENROUTER_DOSSIER_INPUT_USD_PER_M: "1.25",
    STORYHOLD_OPENROUTER_DOSSIER_OUTPUT_USD_PER_M: "5" };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, settings);
    assert.equal(premiumEntityReviewPages(input(3)).length, 1);
    const params = input(); const quotes = premiumEntityReviewPages(params).map((page) => quoteAiCostReservation(page.request));
    const total = quoteEntityReviewReservation(params);
    assert.equal(total.pricingKnown, true);
    assert.ok(total.maximumCostMicros > quotes[0]!.maximumCostMicros && quotes[0]!.maximumCostMicros > 0);
    assert.equal(total.candidates.length, 1);
    assert.equal(total.candidates[0]!.maximumCostMicros, total.maximumCostMicros);
    for (const [totalKey, pageKey] of [["inputUnits", "inputUnits"], ["maxOutputUnits", "maxOutputUnits"], ["maximumCostMicros", "maximumCostMicros"]] as const) {
      assert.equal(total[totalKey], quotes.reduce((sum, quote) => sum + quote[pageKey], 0));
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("saved dossier requires every unique ordered page before any aggregate projection", () => {
  const params = input(); const pages = premiumEntityReviewPages(params); const saved = aggregate(pages);
  for (const change of [
    (value: PagedEntityReviewResult) => { value.entityReviewPages.pop(); },
    (value: PagedEntityReviewResult) => { value.entityReviewPages.reverse(); },
    (value: PagedEntityReviewResult) => { value.entityReviewPages[1] = value.entityReviewPages[0]!; },
  ]) {
    const broken = structuredClone(saved); change(broken);
    assert.throws(() => reviewEntityFromSavedResult(params, broken), /incomplete|order|provenance/u);
  }
  assert.equal(reviewEntityFromSavedResult(params, saved).finding.rules.length, 25);
});

test("graph continuation cannot rewrite biography, aliases, character or stat output", () => {
  const params = input(13); const pages = premiumEntityReviewPages(params);
  for (const extra of [{ summary: "Mira is immortal." }, { character: null }, { aliases: [] }, { statVerifications: [] }]) {
    assert.throws(() => pages[1]!.request.validate!(JSON.stringify({ ...raw(pages[1]!, 1), ...extra })), /only connection and rule|undeclared/u);
  }
});

test("all-rejected graph pages are complete work and do not demand invented biography", () => {
  const params = input(13); const pages = premiumEntityReviewPages(params);
  const values = pages.map((page, index) => raw(page, index, "rejected"));
  values[0]!.summary = ""; values[0]!.evidence = [];
  const reviewed = reviewEntityFromSavedResult(params, aggregate(pages, values));
  assert.equal(reviewed.finding.summary, ""); assert.deepEqual(reviewed.finding.rules, []);
  assert.equal(reviewed.graphReviews!.reduce((sum, receipt) => sum + receipt.decisions.length, 0), 13);
});

test("version2 cannot dispatch through a nonjournaled singleton executor", async () => {
  let calls = 0;
  await assert.rejects(reviewEntity(input(13), { execute: async () => { calls++; return result({}, 0); } }), /durable page executor/u);
  assert.equal(calls, 0);
});

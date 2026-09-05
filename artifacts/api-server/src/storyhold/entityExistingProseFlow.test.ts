import assert from "node:assert/strict";
import test from "node:test";
import { getAiRuntimeStatus, quoteAiCostReservation, type AiTextResult } from "./aiGateway";
import { buildEntityGraphRequest } from "./entityGraphVerification";
import { buildEntityStatRequests } from "./entityStatVerification";
import { buildEntityProseRequest } from "./entityProseVerification";
import { buildExistingProseInventory, prepareEntityExistingProsePages } from "./entityExistingProseReview";
import { planEntityProseRetrieval } from "./entityProseRetrievalPlan";
import { premiumEntityReviewPages, quoteEntityReviewReservation, reviewEntity, reviewEntityFromSavedResult,
  type EntityReviewInput, type PagedEntityReviewResult } from "./entityReview";

const quote = "Mira shelters fugitives in the watchtower. She stays until the spring thaw.";
function input(count = 27): EntityReviewInput {
  const entity = { id: "mira", name: "Mira", entityType: "character", aliases: [], summary: "Mira shelters fugitives.",
    details: Array.from({ length: count }, (_, index) => `Old detail ${index}.`), relationships: [] };
  return { worldName: "Watchtower", worldGenre: "Fantasy", worldPremise: "A winter refuge.", entity,
    depth: "focused", chunks: [{ id: "chunk", sourceId: "source", sourceTitle: "Winter", index: 0, content: quote }],
    knownEntities: [{ name: "Mira", entityType: "character", aliases: [] }],
    premiumStatScope: { worldId: "world", editionId: "edition", analysisRunId: "review" },
    graphReview: { version: 2, entities: [{ id: "mira", name: "Mira", entityType: "character", aliases: [] }], relations: [], rules: [] },
    proseReview: { version: 1 }, existingProseReview: buildExistingProseInventory(entity),
  };
}
function replies(params: EntityReviewInput) {
  const requests = premiumEntityReviewPages(params);
  const graph = buildEntityGraphRequest(requests[0]!.input)!;
  const first = { aliases: [], summary: "", details: [], relationships: [], evidence: [], estimatedStats: null, character: null,
    relations: [], rules: [], entityRelations: [], entityRules: [],
    statVerifications: buildEntityStatRequests(requests[0]!.input).map((request) => ({ requestFingerprint: request.fingerprint,
      decisions: request.proposals.map((proposal) => ({ proposalId: proposal.id, verdict: "needs_more_evidence", confidence: 0,
        explanation: "No numeric ability is established.", supportingEvidence: [], contradictingEvidence: [], retrievalRequests: ["Find an ability passage."] })), newStats: [] })),
    graphVerification: { requestFingerprint: graph.fingerprint, decisions: [], newFindings: [] },
    claims: [], claimVerification: { requestFingerprint: buildEntityProseRequest(params)!.fingerprint, decisions: [], newClaims: [] },
    prosePresentation: { displayOrder: [] },
  };
  const old = prepareEntityExistingProsePages(params).map((page) => ({ existingProseVerification: { requestFingerprint: page.requestFingerprint,
    decisions: page.items.map((item) => ({ itemId: item.itemId, verdict: item.field === "summary" ? "supported" : "needs_more_evidence",
      explanation: item.field === "summary" ? "The passage supports this complete summary." : "The selected passages do not settle this old detail.",
      confidence: item.field === "summary" ? 0.9 : 0.2, supportingEvidence: item.field === "summary" ? [{ chunkId: "chunk", quote }] : [],
      contradictingEvidence: [], retrievalRequests: item.field === "summary" ? [] : ["Find the relevant earlier chapter."] })),
  } }));
  return { requests, values: [first, ...old] };
}
function result(value: unknown, index: number): AiTextResult {
  return { text: JSON.stringify(value), provider: "openrouter", model: "fixture-model", reasoning: "medium",
    runtime: { ...getAiRuntimeStatus("canon_review", "standard", "dossier"), execution: { resolvedModel: "actual-auditor" } as never },
    journalCompletedAt: `2026-09-04T12:00:${String(index).padStart(2, "0")}.000Z`,
    usage: { inputUnits: 100, outputUnits: 100, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 0,
      estimatedCostMicros: 100, pricingKnown: true, pricingVersion: "fixture", costEstimated: false } };
}
function aggregate(params: EntityReviewInput): PagedEntityReviewResult {
  const { requests, values } = replies(params);
  const pages = requests.map((page, index) => ({ stepKey: page.stepKey, result: result(values[index], index) }));
  return { ...pages.at(-1)!.result, entityReviewPages: pages };
}

test("every old text slot gets a bounded saved audit request after the unchanged graph/prose request", async () => {
  const params = input(87); const { requests, values } = replies(params);
  assert.equal(requests.length, 10);
  assert.equal(requests[0]!.stepKey, "dossier_graph:0");
  assert.equal(requests[1]!.stepKey, "dossier_existing_prose:0");
  assert.ok(requests.slice(1).every((page) => page.request.maxOutputTokens === 16_000 && page.request.allowProviderFallback === false));
  requests.forEach((page, index) => page.request.validate!(JSON.stringify(values[index])));
  let executions = 0;
  const reviewed = await reviewEntity(params, { executePages: async () => { executions++; return aggregate(params); } });
  assert.equal(executions, 1);
  assert.equal(reviewed.existingProseReviews!.flatMap((receipt) => receipt.decisions).length, 88);
  assert.equal(reviewed.finding.summary, "", "Auditing old prose must not synthesize a replacement or grant promotion authority");
  assert.deepEqual(reviewed.finding.details, []);
  assert.equal(reviewed.existingProseReviews![0]!.verifier.model, "actual-auditor");
});

test("no missing, reordered or duplicate audit page can finalize the review", () => {
  const params = input();
  for (const change of [
    (saved: PagedEntityReviewResult) => { saved.entityReviewPages.pop(); },
    (saved: PagedEntityReviewResult) => { [saved.entityReviewPages[1], saved.entityReviewPages[2]] = [saved.entityReviewPages[2]!, saved.entityReviewPages[1]!]; },
    (saved: PagedEntityReviewResult) => { saved.entityReviewPages[2] = saved.entityReviewPages[1]!; },
  ]) {
    const saved = aggregate(params); change(saved);
    assert.throws(() => reviewEntityFromSavedResult(params, saved), /incomplete|order|provenance/);
  }
});

test("old-text pages cannot smuggle new prose, stats, aliases or canon updates", () => {
  const { requests, values } = replies(input());
  for (const extra of [{ summary: "Immortal." }, { statVerifications: [] }, { aliases: [] }, { claims: [] }]) {
    assert.throws(() => requests[1]!.request.validate!(JSON.stringify({ ...values[1], ...extra })));
  }
});

test("reservation includes every old-prose request before any dispatch", () => {
  const params = input(); const { requests } = replies(params);
  const total = quoteEntityReviewReservation(params);
  const quotes = requests.map((page) => quoteAiCostReservation(page.request));
  assert.equal(total.maxOutputUnits, quotes.reduce((sum, quote) => sum + quote.maxOutputUnits, 0));
  assert.ok(total.maxOutputUnits > quotes[0]!.maxOutputUnits);
  assert.equal(total.maximumCostMicros, quotes.reduce((sum, quote) => sum + quote.maximumCostMicros, 0));
});

test("legacy requests keep the old plan and existing-text audits cannot bypass durable paging", async () => {
  const params = input(); delete params.existingProseReview;
  assert.equal(premiumEntityReviewPages(params).length, 1);
  const invalid = { ...input(), graphReview: { ...input().graphReview!, version: 1 as const } };
  assert.throws(() => quoteEntityReviewReservation(invalid), /complete durable page plan/);
  await assert.rejects(reviewEntity(invalid), /durable page executor/);
  assert.throws(() => reviewEntityFromSavedResult(invalid, result({}, 0)), /complete durable page plan/);
});

test("a targeted later-book passage reaches every new request and can be cited only after it is included", () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("No live model or network is allowed in this retrieval fixture."); };
  try {
    const previous = input(0);
    previous.entity.summary = "Mira survived the winter.";
    previous.existingProseReview = buildExistingProseInventory(previous.entity);
    const original = structuredClone(previous);
    const later = { id: "later-book-chunk", sourceId: "book-two", sourceTitle: "The Reunion", index: 9,
      content: "Mira survived the winter. Her brother found her at the gate during the reunion." };
    const nearby = { ...later, id: "later-book-neighbor", index: 8,
      content: "Her brother approached the old gate and called out. Someone answered from the other side." };
    const plan = planEntityProseRetrieval({ leads: [{ item: previous.existingProseReview.items[0]!, reviewId: "previous-review",
      requests: ["Find the winter reunion and who confirmed that Mira survived."], previousChunks: previous.chunks }],
      chunks: [...previous.chunks, nearby, later], selectedChunks: previous.chunks,
      target: previous.entity, depth: previous.depth });
    assert.equal(plan.items[0]!.status, "added");
    assert.ok(plan.chunks.some((chunk) => chunk.id === later.id && chunk.content === later.content));
    assert.ok(plan.chunks.some((chunk) => chunk.id === nearby.id));
    const expanded: EntityReviewInput = { ...structuredClone(previous), chunks: [...previous.chunks, ...plan.chunks] };
    assert.deepEqual(previous, original, "Searching cannot alter the earlier frozen request");
    assert.deepEqual(expanded.existingProseReview, previous.existingProseReview, "The original dossier slot IDs do not change");
    const { requests, values } = replies(expanded);
    const page = prepareEntityExistingProsePages(expanded)[0]!;
    const audit = { existingProseVerification: { requestFingerprint: page.requestFingerprint, decisions: [{
      itemId: page.items[0]!.itemId, verdict: "supported", explanation: "The reunion establishes her survival after winter.",
      confidence: 0.9, supportingEvidence: [{ chunkId: later.id, quote: later.content }], contradictingEvidence: [], retrievalRequests: [],
    }] } };
    values[1] = audit as typeof values[1];
    requests.forEach((request, index) => request.request.validate!(JSON.stringify(values[index])));
    for (const request of requests) {
      const prompt = request.request.messages.map((message) => message.content).join("\n");
      assert.ok(prompt.includes(later.content), "The added source text must be in the real model prompt, not merely the UI count");
      assert.ok(prompt.includes(nearby.content));
    }
    const originalRequest = premiumEntityReviewPages(previous)[1]!;
    const invalid = structuredClone(audit);
    invalid.existingProseVerification.requestFingerprint = prepareEntityExistingProsePages(previous)[0]!.requestFingerprint;
    assert.throws(() => originalRequest.request.validate!(JSON.stringify(invalid)), /outside this frozen review/u);
    assert.ok(quoteEntityReviewReservation(expanded).inputUnits > quoteEntityReviewReservation(previous).inputUnits,
      "Additional source text is included in predispatch accounting, not a hidden unreserved extra");
    const pages = requests.map((request, index) => ({ stepKey: request.stepKey, result: result(values[index], index) }));
    const saved: PagedEntityReviewResult = { ...pages.at(-1)!.result, entityReviewPages: pages };
    const checked = reviewEntityFromSavedResult(expanded, saved);
    assert.equal(checked.existingProseReviews![0]!.decisions[0]!.verdict, "supported");
    assert.equal(checked.finding.summary, "", "A search hit and old-text judgment still cannot rewrite canon");
    assert.deepEqual(reviewEntityFromSavedResult(JSON.parse(JSON.stringify(expanded)), saved), checked,
      "Saved source packets replay unchanged, without searching or calling a model again");
  } finally { globalThis.fetch = originalFetch; }
});

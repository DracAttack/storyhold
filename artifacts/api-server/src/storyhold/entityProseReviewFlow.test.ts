import assert from "node:assert/strict";
import test from "node:test";
import { getAiRuntimeStatus, type AiTextResult } from "./aiGateway";
import { buildEntityGraphRequest } from "./entityGraphVerification";
import { buildEntityProseRequest } from "./entityProseVerification";
import { buildEntityStatRequests } from "./entityStatVerification";
import { premiumEntityReviewPages, reviewEntityFromSavedResult, entityReviewPublicError,
  type EntityReviewInput, type PagedEntityReviewResult } from "./entityReview";

const quote = "Echo was an alien symbiont living inside Alec Sumner. Together they could transform Alec's body.";
function input(graphCount = 0): EntityReviewInput {
  return { worldName: "Ashes Fixture", worldPremise: "Survival", worldGenre: "Science Fiction", depth: "focused",
    entity: { id: "alec", name: "Alec Sumner", aliases: ["Alec"], entityType: "character", summary: "", details: [], relationships: [] },
    knownEntities: [{ name: "Alec Sumner", aliases: ["Alec"], entityType: "character" }],
    chunks: [{ id: "chunk", sourceId: "source", sourceTitle: "Fixture", index: 0, content: quote }],
    premiumStatScope: { worldId: "world", editionId: "edition", analysisRunId: "review" },
    ownerCanonConstraints: [{ id: "owner", kind: "correction", instruction: "Echo is not Alec's literal daughter." }],
    proseReview: { version: 1 },
    graphReview: { version: 2, entities: [{ id: "alec", name: "Alec Sumner", aliases: ["Alec"], entityType: "character" }],
      relations: [], rules: Array.from({ length: graphCount }, (_, index) => ({ entity: "Alec Sumner", name: `Form condition ${index}`,
        description: "Alec changes form with Echo.", ruleKind: "biological", trigger: "With Echo", effect: "Changes form",
        evidence: [{ chunkId: "chunk", sourceId: "source", quote }], confidence: 0.5 })) } };
}
function decision(verdict: "verified" | "rejected" = "verified") {
  return { verdict, confidence: 0.9, explanation: "The passage establishes the individual statement.",
    supportingEvidence: verdict === "verified" ? [{ chunkId: "chunk", quote }] : [], contradictingEvidence: [], retrievalRequests: [] };
}
function raw(page: ReturnType<typeof premiumEntityReviewPages>[number], index: number, verdict: "verified" | "rejected" = "verified") {
  const graph = buildEntityGraphRequest(page.input)!;
  const body: Record<string, unknown> = { relations: [], rules: [], entityRelations: [], entityRules: [], graphVerification: {
    requestFingerprint: graph.fingerprint, decisions: graph.proposals.map((proposal) => ({ proposalId: proposal.id, ...decision(verdict) })), newFindings: [] } };
  if (index === 0) Object.assign(body, { aliases: [], summary: "", details: [], relationships: [], evidence: [], confidence: 0,
    character: null, estimatedStats: null, claims: [],
    statVerifications: buildEntityStatRequests(page.input).map((request) => ({ requestFingerprint: request.fingerprint, decisions: [], newStats: [] })),
    claimVerification: { requestFingerprint: buildEntityProseRequest(page.input)!.fingerprint, decisions: [], newClaims: [
      { claim: { subject: "Alec Sumner", predicate: "dossier.summary", value: "An alien symbiont named Echo lives inside Alec.",
        polarity: "positive", epistemicHolder: "", truthStatus: "fact", validFromLabel: "", validUntilLabel: "" }, ...decision(verdict) },
      { claim: { subject: "Alec Sumner", predicate: "dossier.summary", value: "Together, Alec and Echo can transform Alec's body.",
        polarity: "positive", epistemicHolder: "", truthStatus: "fact", validFromLabel: "", validUntilLabel: "" }, ...decision(verdict) },
    ] }, prosePresentation: { displayOrder: verdict === "verified" ? [0, 1] : [] } });
  return body;
}
function result(text: string, index: number): AiTextResult {
  return { text, provider: "openrouter", model: "fixture", reasoning: "medium", journalCompletedAt: "2026-09-03T01:00:00.000Z",
    usage: { inputUnits: 100, outputUnits: 50, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 0,
      estimatedCostMicros: 100, pricingKnown: true, pricingVersion: "fixture", costEstimated: false },
    runtime: { ...getAiRuntimeStatus("canon_review", "standard", "dossier"), execution: {
      connectionId: "fixture", requestedModel: "fixture", resolvedModel: `actual-${index}`, upstreamProvider: "fixture",
      credentialSource: "environment", connectionSource: "storyhold_managed", billingSource: "storyhold_credits", privacyMode: "zero-data-retention" } } };
}
function saved(pages: ReturnType<typeof premiumEntityReviewPages>, verdict: "verified" | "rejected" = "verified"): PagedEntityReviewResult {
  const entityReviewPages = pages.map((page, index) => ({ stepKey: page.stepKey, result: result(JSON.stringify(raw(page, index, verdict)), index) }));
  return { ...entityReviewPages.at(-1)!.result, entityReviewPages };
}

test("individual verified sentences become readable dossier prose in the declared order, with actual first-page proof", () => {
  const source = input(); const pages = premiumEntityReviewPages(source);
  assert.equal(pages.length, 1);
  pages[0]!.request.validate!(JSON.stringify(raw(pages[0]!, 0)));
  const reviewed = reviewEntityFromSavedResult(source, saved(pages));
  assert.equal(reviewed.finding.summary, "An alien symbiont named Echo lives inside Alec. Together, Alec and Echo can transform Alec's body.");
  assert.equal(reviewed.proseReview!.claimReceipt.verifier.model, "actual-0");
  assert.equal(reviewed.proseReview!.projection.length, 2);
  assert.ok(reviewed.finding.evidence.every((entry) => entry.quote === quote));
});

test("per-item prose shares page zero and its reservation, without another provider pass", () => {
  const pages = premiumEntityReviewPages(input(13));
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map((page) => page.request.maxOutputTokens), [20_500, 6_500]);
  assert.equal(pages.filter((page) => page.request.messages.some((message) => message.content.includes("CLAIM_VERIFICATION_REQUEST"))).length, 1);
  assert.equal(reviewEntityFromSavedResult(input(13), saved(pages)).finding.rules.length, 13);
  assert.throws(() => pages[1]!.request.validate!(JSON.stringify({ ...raw(pages[1]!, 1), prosePresentation: { displayOrder: [] } })), /only connection and rule/);
});

test("a general citation cannot authorize raw prose, aliases, character fields or compass values", () => {
  const page = premiumEntityReviewPages(input())[0]!;
  for (const extra of [{ summary: "Alec is invincible." }, { aliases: ["Little Alec"] },
    { character: { summary: "Alec is a child." } }, { socioPoliticalAxis: { economic: 75, authority: 40 } }]) {
    assert.throws(() => page.request.validate!(JSON.stringify({ ...raw(page, 0), ...extra })), /prose verification/);
  }
});

test("all-rejected individual claims finish as audited work without generating filler", () => {
  const source = input(); const pages = premiumEntityReviewPages(source);
  const reviewed = reviewEntityFromSavedResult(source, saved(pages, "rejected"));
  assert.equal(reviewed.finding.summary, ""); assert.deepEqual(reviewed.finding.details, []);
  assert.equal(reviewed.proseReview!.claimReceipt.decisions.length, 2);
});

test("unflagged saved contracts keep their schema and cannot acquire first-page claim authority", () => {
  const source = input(); delete source.proseReview;
  const page = premiumEntityReviewPages(source)[0]!;
  assert.match(page.request.system, /"summary":"grounded concise overview"/);
  assert.equal(page.request.maxOutputTokens, 12_500);
  assert.doesNotMatch(page.request.messages[0]!.content, /CLAIM_VERIFICATION_REQUEST/);
  assert.throws(() => page.request.validate!(JSON.stringify(raw(premiumEntityReviewPages(input())[0]!, 0))), /undeclared response array claims|fingerprint/);
});

test("private per-claim failures receive a customer-safe message", () => {
  const message = entityReviewPublicError(new Error("Dossier prose verification: claim_candidate_deadbeef fingerprint changed"));
  assert.match(message, /could not verify each proposed dossier detail/);
  assert.doesNotMatch(message, /claim_candidate|fingerprint|deadbeef/);
});

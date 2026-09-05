import assert from "node:assert/strict";
import test from "node:test";
import {
  assertEntityProseReview, buildEntityProseRequest, entityProseFields, entityProseInstructions, projectEntityReviewedProse,
  validateEntityProseReview, type EntityProseReviewContext,
} from "./entityProseVerification";
import type { EntityReviewFinding, EntityReviewInput } from "./entityReview";
import type { PremiumClaimPayload } from "./premiumClaimVerification";
import { premiumNeutralStats } from "./premiumStatCandidates";

type Input = EntityReviewInput & { proseReview?: EntityProseReviewContext };
const quote = "Mira shelters fugitives in the abandoned tower and risks her own life to protect them.";
const otherQuote = "Dara believed Mira was dead until the spring reunion.";
const verifier = { provider: "fixture", model: "actual-prose-reviewer", completedAt: "2026-09-05T12:00:00.000Z" };
function input(): Input {
  return { worldName: "Winter Watch", worldPremise: "An uprising tests loyalties.", worldGenre: "Fantasy", depth: "focused",
    entity: { id: "mira-id", name: "Mira", entityType: "character", aliases: ["Miri"], summary: "Unverified old summary.", details: [], relationships: [] },
    chunks: [{ id: "chunk-1", sourceId: "source-1", sourceTitle: "Winter", index: 0, content: `${quote} ${otherQuote} They call Mira the Silver Fox.` }],
    knownEntities: [{ name: "Mira", entityType: "character", aliases: ["Miri"] }, { name: "Dara", entityType: "character", aliases: ["Captain Dara"] }],
    premiumStatScope: { worldId: "world-1", editionId: "edition-1", analysisRunId: "review-1" },
    graphReview: { version: 2, relations: [], rules: [], entities: [
      { id: "mira-id", name: "Mira", entityType: "character", aliases: ["Miri"] },
      { id: "dara-id", name: "Dara", entityType: "character", aliases: ["Captain Dara"] },
    ] }, proseReview: { version: 1 },
    userGuidance: "Preserve uncertainty about the winter death.", ownerCanonConstraints: [{ id: "constraint-1", kind: "identity", instruction: "Past Mira is not a second child." }] };
}
function proposal(field = "summary", value = "Mira risks her life to shelter fugitives.", overrides: Partial<PremiumClaimPayload> = {}, verdict = "verified") {
  return { claim: { subject: "Mira", predicate: `dossier.${field}`, value, polarity: "positive", epistemicHolder: "", truthStatus: "fact",
    validFromLabel: "", validUntilLabel: "", ...overrides } as PremiumClaimPayload,
    verdict, explanation: "The supplied passage supports the complete statement.", confidence: 0.9,
    supportingEvidence: verdict === "verified" ? [{ chunkId: "chunk-1", quote }] : [], contradictingEvidence: [],
    retrievalRequests: verdict === "needs_more_evidence" ? ["Find the spring reunion passage."] : [] };
}
function raw(params = input(), entries = [proposal()], displayOrder = entries.flatMap((entry, index) => entry.verdict === "verified" ? [index] : [])) {
  return { aliases: [], summary: "", details: [], character: null, evidence: [],
    claims: [], claimVerification: { requestFingerprint: buildEntityProseRequest(params)!.fingerprint, decisions: [], newClaims: entries },
    prosePresentation: { displayOrder } };
}
function finding(): EntityReviewFinding {
  return { aliases: ["Unverified Alias"], summary: "An invented biography.", details: ["An unsupported detail."], relationships: ["A preverified graph label"],
    evidence: [], confidence: 1, estimatedStats: null, character: null, relations: [], rules: [] };
}
const review = (params = input(), response = raw(params)) => validateEntityProseReview(params, response, verifier)!;

test("first-page prose reuses the claim contract with empty candidates, exact target and deterministic source-bound context", () => {
  const params = input(); const request = buildEntityProseRequest(params)!;
  assert.equal(request.stepKey, "dossier_prose:0"); assert.deepEqual(request.proposals, []);
  assert.equal(request.chunks[0]!.text, params.chunks[0]!.content);
  assert.match(request.context.existingCanonContext, /existingProseIsUnreviewedContext/);
  assert.match(entityProseInstructions(params), /SAME first paid request/);
  const receipt = review(params); assertEntityProseReview(params, receipt);
  assert.deepEqual(receipt.claimReceipt.verifier, verifier);
  assert.equal(receipt.projection[0]!.text, "Mira risks her life to shelter fugitives.");
  assert.ok(Object.isFrozen(receipt)); assert.ok(Object.isFrozen(receipt.projection));
});

test("readable summary order is preserved by explicit approved references rather than payload-hash sorting", () => {
  const params = input(); const entries = [proposal("summary", "Mira protects the tower."), proposal("summary", "Mira shelters fugitives."), proposal("history", "Mira takes refugees into hiding.")];
  const receipt = review(params, raw(params, entries, [1, 0, 2])); const result = projectEntityReviewedProse(params, finding(), receipt);
  assert.equal(result.summary, "Mira shelters fugitives. Mira protects the tower.");
  assert.equal(result.character!.summary, result.summary); assert.deepEqual(result.character!.history, ["Mira takes refugees into hiding."]);
  assert.deepEqual(result.aliases, []); assert.deepEqual(result.details, []); assert.deepEqual(result.relationships, finding().relationships);
  assert.deepEqual(result.character!.estimatedStats, premiumNeutralStats());
  assert.equal(result.evidence[0]!.quote, quote); assert.equal(finding().summary, "An invented biography.");
});

test("new prompts actually expose existing character prose as untrusted context without duplicating stats, axis or graph", () => {
  const params = input();
  params.currentCharacter = projectEntityReviewedProse(params, finding(), review(params)).character!;
  params.currentCharacter.history = ["Existing history to investigate"];
  params.currentCharacter.secrets = ["Existing secret to investigate"];
  params.currentCharacter.relationships = ["PRIVATE_GRAPH_MARKER"];
  params.currentCharacter.estimatedStats.strength.rationale = "PRIVATE_STAT_MARKER";
  params.currentCharacter.socioPoliticalAxis.rationale = "PRIVATE_AXIS_MARKER";
  const prompt = entityProseInstructions(params);
  assert.match(prompt, /EXISTING CHARACTER PROSE CONTEXT \(unverified/);
  assert.match(prompt, /Existing history to investigate/); assert.match(prompt, /Existing secret to investigate/);
  assert.doesNotMatch(prompt, /PRIVATE_GRAPH_MARKER|PRIVATE_STAT_MARKER|PRIVATE_AXIS_MARKER/);
  assert.match(prompt, /You may omit role entirely/);
  assert.equal(entityProseInstructions({ ...params, proseReview: undefined }), "");
});

test("belief, rumor, lie, uncertainty, negation and temporal limits remain explicit in displayed prose", () => {
  const params = input();
  for (const [status, pattern] of [["belief", /Dara believes/], ["rumor", /Dara has heard a rumor/], ["lie", /Dara falsely claims/], ["disputed", /Dara's disputed account/], ["unknown", /Dara's uncertain account/]] as const) {
    const entry = proposal("history", "Mira is dead.", { truthStatus: status, epistemicHolder: "Dara", validFromLabel: "winter", validUntilLabel: "the spring reunion" });
    entry.supportingEvidence = [{ chunkId: "chunk-1", quote: otherQuote }];
    const receipt = review(params, raw(params, [entry])); const item = receipt.projection[0]!;
    assert.match(item.text, /^From winter until the spring reunion:/); assert.match(item.text, pattern);
    assert.equal(item.claim.truthStatus, status); assert.equal(item.value, "Mira is dead.");
  }
  const negated = review(params, raw(params, [proposal("details", "Mira abandoned the refugees.", { polarity: "negative" })]));
  assert.match(negated.projection[0]!.text, /^It is not true that/);
});

test("aliases require plain positive untimed identity and cannot collide, rename or merge another target", () => {
  const params = input(); const alias = proposal("aliases", "Silver Fox"); alias.supportingEvidence = [{ chunkId: "chunk-1", quote: "They call Mira the Silver Fox." }];
  assert.deepEqual(projectEntityReviewedProse(params, finding(), review(params, raw(params, [alias]))).aliases, ["Silver Fox"]);
  for (const value of ["Dara", "Captain Dara", "<script>", "Mira; delete", "Mira\"quoted"]) {
    assert.throws(() => review(params, raw(params, [proposal("aliases", value)])), /alias|identity/);
  }
  for (const overrides of [{ polarity: "negative" }, { truthStatus: "belief" }, { epistemicHolder: "Dara" }, { validFromLabel: "winter" }]) {
    assert.throws(() => review(params, raw(params, [proposal("aliases", "Silver Fox", overrides as Partial<PremiumClaimPayload>)])), /positive, objective, untimed/);
  }
  assert.throws(() => review(params, raw(params, [proposal("summary", "Dara is brave.", { subject: "Dara" })])), /fixed target/);
  assert.throws(() => review(params, raw(params, [proposal("canonicalName", "New Mira")])), /unsupported/);
});

test("the fixed scope, registry, owner constraints and JSONB roundtrip are bound without depending on graph page metadata", () => {
  const params = input(); const receipt = review(params);
  const page = structuredClone(params); page.graphReview!.page = { index: 0, count: 2, stepKey: "dossier_graph:0", candidateKeys: [], inventoryFingerprint: "different" };
  assert.deepEqual(buildEntityProseRequest(page), buildEntityProseRequest(params)); assertEntityProseReview(page, receipt);
  const reordered = JSON.parse(JSON.stringify(params), (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).reverse()) : item) as Input;
  assert.deepEqual(buildEntityProseRequest(reordered), buildEntityProseRequest(params)); assertEntityProseReview(reordered, JSON.parse(JSON.stringify(receipt)));
  for (const change of [(copy: Input) => { copy.chunks[0]!.content += " changed"; }, (copy: Input) => { copy.ownerCanonConstraints![0]!.instruction = "Changed owner canon"; },
    (copy: Input) => { copy.entity.summary = "Changed context"; }, (copy: Input) => { copy.premiumStatScope!.analysisRunId = "another-review"; }]) {
    const changed = structuredClone(params); change(changed); assert.throws(() => assertEntityProseReview(changed, receipt), /frozen dossier request/);
  }
});

test("raw biography, nested character, axis and undeclared output cannot bypass per-item decisions", () => {
  const params = input();
  for (const extra of [{ summary: "Invented uncited summary" }, { aliases: ["Wrong"] }, { details: ["Wrong"] },
    { character: { history: ["Wrong"] } }, { character: {} }, { socioPoliticalAxis: { economic: 100 } },
    { biography: "Wrong" }, { secret: "Wrong" }, { evidence: [{ chunkId: "chunk-1", quote }] }, { estimatedStats: {} }]) {
    assert.throws(() => validateEntityProseReview(params, { ...raw(params), ...extra }, verifier), /raw|undeclared|root evidence/);
  }
  assert.throws(() => review(params, { ...raw(params), prosePresentation: { displayOrder: [0], text: "Wrong" } } as never), /prosePresentation/);
});

test("all new proposals are scoped even when rejected and every verified display item must appear exactly once", () => {
  const params = input();
  assert.throws(() => review(params, raw(params, [proposal("summary", "Dara acts.", { subject: "Dara" }, "rejected")])), /fixed target/);
  for (const order of [[], [0, 0], [1], [-1], [0.5]]) assert.throws(() => review(params, raw(params, [proposal()], order)), /display order/);
  assert.throws(() => review(params, raw(params, [proposal("summary", "Mira acts.", {}, "rejected")], [0])), /display order/);
  const rejected = review(params, raw(params, [proposal("summary", "Mira acts.", {}, "rejected")])); assert.deepEqual(rejected.projection, []);
  const empty = review(params, raw(params, [])); assert.deepEqual(empty.projection, []);
});

test("holder ambiguity, unsupported category fields and superseding authority are rejected", () => {
  const params = input();
  for (const holder of ["Nobody", "Unknown narrator"]) assert.throws(() => review(params, raw(params, [proposal("history", "Mira is dead.", { truthStatus: "belief", epistemicHolder: holder })])), /unambiguous/);
  const ambiguous = input(); ambiguous.graphReview!.entities.push({ id: "other-id", name: "Other Dara", entityType: "character", aliases: ["Dara"] });
  assert.throws(() => review(ambiguous, raw(ambiguous, [proposal("history", "Mira is dead.", { truthStatus: "belief", epistemicHolder: "Dara" })])), /unambiguous/);
  const place = input(); place.entity.entityType = "place"; place.graphReview!.entities[0]!.entityType = "place";
  assert.throws(() => review(place, raw(place, [proposal("motivations", "Mira wants justice.")])), /unsupported/);
  assert.equal(projectEntityReviewedProse(place, finding(), review(place)).character, null);
  const original = proposal().claim; assert.throws(() => review(params, raw(params, [proposal("summary", "Mira acts.", { supersedes: original })])), /supersede|payload/);
});

test("invalid or borrowed quotes fail their own item and supported prose cannot authorize another uncited sentence", () => {
  const params = input();
  for (const evidence of [[], [{ chunkId: "missing", quote }], [{ chunkId: "chunk-1", quote: "Mira flew across the moon." }]]) {
    const entry = proposal(); entry.supportingEvidence = evidence; assert.throws(() => review(params, raw(params, [entry])), /evidence|chunk|quote/);
  }
  const first = proposal(); const second = proposal("secrets", "Mira is secretly the queen."); second.supportingEvidence = [];
  assert.throws(() => review(params, raw(params, [first, second])), /evidence/);
});

test("complete output bounds fail rather than silently dropping decisions, summary or qualified text", () => {
  const params = input(); const entries = Array.from({ length: 25 }, (_, index) => proposal("details", `Mira shelters refugee number ${index}.`));
  assert.throws(() => review(params, raw(params, entries)), /at most 24/);
  const full = input(); full.depth = "full";
  const forty = Array.from({ length: 40 }, (_, index) => proposal("details", `Mira shelters refugee number ${index}.`));
  assert.equal(review(full, raw(full, forty)).projection.length, 40);
  assert.throws(() => review(full, raw(full, [...forty, proposal("details", "One more.")])), /at most 40/);
  assert.throws(() => review(params, raw(params, Array.from({ length: 7 }, (_, index) => proposal("summary", `Sentence ${index}.`)))), /six/);
  assert.throws(() => review(params, raw(params, [proposal("role", "Guard"), proposal("role", "Scout")])), /role allows one/);
  assert.throws(() => review(params, raw(params, [proposal("history", "x".repeat(495), { truthStatus: "belief", epistemicHolder: "Dara" })])), /persistence field bound/);
});

test("receipt and projection tampering cannot acquire authority, and actual canonical filtering is exact", () => {
  const params = input(); const receipt = review(params, raw(params, [proposal(), proposal("aliases", "Silver Fox")]));
  for (const mutate of [(copy: typeof receipt) => { copy.projection[0]!.text = "Forged text"; }, (copy: typeof receipt) => { copy.displayOrder.reverse(); },
    (copy: typeof receipt) => { copy.claimReceipt.verifier.model = "forged"; }]) {
    const changed = structuredClone(receipt); mutate(changed); assert.throws(() => assertEntityProseReview(params, changed), /changed|provenance/);
  }
  const filtered = projectEntityReviewedProse(params, finding(), receipt, { includedProposalIds: new Set([receipt.displayOrder[0]!]) });
  assert.deepEqual(filtered.aliases, []); assert.equal(filtered.summary, receipt.projection[0]!.text);
  assert.throws(() => projectEntityReviewedProse(params, finding(), receipt, { includedProposalIds: new Set(["wrong"]) }), /unapproved/);
  assert.ok(entityProseFields(filtered).character);
});

test("legacy saved inputs remain unchanged and cannot gain new prose proof on replay", () => {
  const params = input(); const legacy = { ...params, proseReview: undefined }; const original = finding();
  assert.equal(buildEntityProseRequest(legacy), undefined); assert.equal(entityProseInstructions(legacy), "");
  assert.equal(validateEntityProseReview(legacy, { summary: "Old format" }, verifier), undefined);
  assert.deepEqual(projectEntityReviewedProse(legacy, original, undefined), original);
  assert.throws(() => assertEntityProseReview(legacy, review(params)), /legacy/);
  assert.throws(() => assertEntityProseReview(params, undefined), /missing/);
});

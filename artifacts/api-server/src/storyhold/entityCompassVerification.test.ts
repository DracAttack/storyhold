import assert from "node:assert/strict";
import test from "node:test";
import {
  approvedEntityCompassEstimate, assertEntityCompassReview, buildEntityCompassRequest,
  entityCompassInstructions, validateEntityCompassReview, type EntityCompassReviewContext,
} from "./entityCompassVerification";
import type { EntityReviewInput } from "./entityReview";
import type { CharacterFinding } from "./worldAnalysis";

type Input = EntityReviewInput & { compassReview?: EntityCompassReviewContext };
const economics = "Mira argued that the village should share the harvest equally.";
const authority = "Mira insisted that each villager could refuse the council's orders.";
const opinion = "Dara called Mira an advocate for common ownership and personal liberty.";
const contrary = "In winter, Mira ordered the village to surrender its harvest to her command.";
const verifier = { provider: "actual-provider", model: "actual-resolved-model", completedAt: "2026-09-04T12:00:00.000Z" };
function input(): Input {
  return {
    worldName: "The Valley", worldPremise: "A village changes during a war.", worldGenre: "Fantasy",
    entity: { id: "mira-id", name: "Mira", entityType: "character", aliases: ["Captain Mira"], summary: "", details: [], relationships: [] },
    currentCharacter: { name: "Mira", socioPoliticalAxis: { economic: 0, authority: 0, label: "Undetermined", rationale: "No earlier interpretation.", confidence: 0 } } as CharacterFinding,
    chunks: [{ id: "chunk-1", sourceId: "source-1", sourceTitle: "The Valley", index: 0, content: `${economics} ${authority} ${opinion} ${contrary}` }],
    knownEntities: [], depth: "focused", premiumStatScope: { worldId: "world-1", editionId: "edition-1", analysisRunId: "review-1" },
    graphReview: { version: 2, relations: [], rules: [], entities: [
      { id: "mira-id", name: "Mira", entityType: "character", aliases: ["Captain Mira"] },
      { id: "dara-id", name: "Dara", entityType: "character", aliases: [] },
      { id: "village-id", name: "The Village", entityType: "place", aliases: [] },
    ] },
    proseReview: { version: 1 }, compassReview: { version: 1, currentEstimate: { economic: 10, authority: 20, label: "Earlier estimate", rationale: "Unverified older interpretation.", confidence: 0.8 }, ownerOverride: null },
    ownerCanonConstraints: [{ id: "constraint-1", kind: "canon", instruction: "An early ideal is not automatically a later settled belief." }],
  };
}
function response(params: Input) {
  return { compassVerification: { requestFingerprint: buildEntityCompassRequest(params)!.fingerprint,
    verdict: "supported", estimate: { economic: -45, authority: -40, label: "Community-Minded and Liberty-Leaning",
      rationale: "In the spring debates, Mira favors shared harvests and villagers' freedom to refuse council orders; this estimate does not describe her later wartime conduct.",
      validFromLabel: "Spring debates", validUntilLabel: "Before winter", perspective: "demonstrated_behavior", epistemicHolderId: null as string | null },
    explanation: "Both axes are supported by separate relevant passages; the contrary winter action is outside this period.", confidence: 0.75,
    supportingEvidence: [
      { chunkId: "chunk-1", quote: economics, axes: ["economic"], perspective: "demonstrated_behavior" },
      { chunkId: "chunk-1", quote: authority, axes: ["authority"], perspective: "demonstrated_behavior" },
    ], contradictingEvidence: [] as Array<{ chunkId: string; quote: string; axes: string[]; perspective: string }>, retrievalRequests: [] as string[] } };
}

test("supported compass retains exact numeric, complete rationale, time and source provenance as an interpretation", () => {
  const params = input(); const raw = response(params);
  const receipt = validateEntityCompassReview(params, raw, verifier)!;
  assertEntityCompassReview(params, receipt);
  const result = approvedEntityCompassEstimate(params, receipt)!;
  assert.deepEqual(result, { ...raw.compassVerification.estimate, confidence: 0.75,
    evidence: raw.compassVerification.supportingEvidence.map((entry) => ({ ...entry, sourceId: "source-1" })) });
  assert.equal(receipt.verifier.model, "actual-resolved-model");
  assert.equal(receipt.request.scope.entityId, "mira-id");
  assert.equal(receipt.request.scope.reviewId, "review-1");
  assert.ok(Object.isFrozen(receipt)); assert.ok(Object.isFrozen(receipt.decision));
  assert.ok(Object.isFrozen(receipt.decision.supportingEvidence));
  assert.equal(params.currentCharacter!.socioPoliticalAxis.label, "Undetermined");
  assert.equal(Object.hasOwn(result, "truthStatus"), false);
});

test("legacy requests remain absent; modern target and first-page constraints fail closed", () => {
  const legacy = input(); delete legacy.compassReview;
  assert.equal(buildEntityCompassRequest(legacy), undefined); assert.equal(entityCompassInstructions(legacy), "");
  assert.equal(validateEntityCompassReview(legacy, {}, verifier), undefined); assertEntityCompassReview(legacy, undefined);
  const modernReceipt = validateEntityCompassReview(input(), response(input()), verifier)!;
  assert.throws(() => assertEntityCompassReview(legacy, modernReceipt), /legacy/);
  for (const mutate of [
    (value: Input) => { value.entity.entityType = "creature"; },
    (value: Input) => { delete value.currentCharacter; },
    (value: Input) => { delete value.proseReview; },
    (value: Input) => { value.graphReview!.version = 1; },
    (value: Input) => { value.graphReview!.page = { index: 1, count: 2, stepKey: "dossier_graph:1", candidateKeys: [], inventoryFingerprint: "test" }; },
  ]) { const params = input(); mutate(params); assert.throws(() => buildEntityCompassRequest(params), /modern character review/); }
  const wrong = input(); wrong.graphReview!.entities[0]!.id = "impostor";
  assert.throws(() => buildEntityCompassRequest(wrong), /frozen canonical identity/);
});

test("parent and page zero fingerprints survive JSONB key ordering without dropping owner context", () => {
  const params = input(); const expected = buildEntityCompassRequest(params)!;
  const child = structuredClone(params); child.graphReview!.page = { index: 0, count: 2, stepKey: "dossier_graph:0", candidateKeys: [], inventoryFingerprint: "inventory" };
  assert.deepEqual(buildEntityCompassRequest(child), expected);
  const reordered = JSON.parse(JSON.stringify(child), (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).reverse()) : value) as Input;
  assert.deepEqual(buildEntityCompassRequest(reordered), expected);
  const receipt = validateEntityCompassReview(child, response(child), verifier)!;
  assertEntityCompassReview(reordered, receipt); assertEntityCompassReview(params, receipt);
  for (const mutate of [
    (value: Input) => { value.ownerCanonConstraints![0]!.instruction = "Changed owner instruction"; },
    (value: Input) => { value.chunks[0]!.content += " New later evidence."; },
    (value: Input) => { value.premiumStatScope!.analysisRunId = "different-review"; },
    (value: Input) => { value.compassReview!.currentEstimate = { label: "Changed prior" }; },
  ]) { const changed = structuredClone(params); mutate(changed); assert.throws(() => assertEntityCompassReview(changed, receipt), /exact compass receipt/); }
});

test("instructions expose old estimate as untrusted and define axes without inventing moral or temporal facts", () => {
  const prompt = entityCompassInstructions(input());
  assert.match(prompt, /Unverified older interpretation/); assert.match(prompt, /An early ideal is not automatically/);
  assert.match(prompt, /NOT an objective fact/); assert.match(prompt, /Zero is a real middle estimate/);
  assert.match(prompt, /either axis lacks support/); assert.match(prompt, /empty bounds mean unspecified, not timeless or current/);
  assert.match(prompt, /Do not infer economics from aggression/); assert.match(prompt, /owner's override/);
});

test("missing evidence for either axis cannot be labeled supported and quotes must match exact bound sources", () => {
  const params = input();
  const missing = response(params); missing.compassVerification.supportingEvidence.pop();
  assert.throws(() => validateEntityCompassReview(params, missing, verifier), /both axes/);
  const absent = response(params); absent.compassVerification.supportingEvidence[0]!.quote = "Mira supports private monopolies.";
  assert.throws(() => validateEntityCompassReview(params, absent, verifier), /quote is absent/);
  const wrongSource = response(params); wrongSource.compassVerification.supportingEvidence[0]!.chunkId = "unselected-chunk";
  assert.throws(() => validateEntityCompassReview(params, wrongSource, verifier), /absent manuscript chunk/);
  const suppliedSource = response(params); Object.assign(suppliedSource.compassVerification.supportingEvidence[0]!, { sourceId: "forged" });
  assert.throws(() => validateEntityCompassReview(params, suppliedSource, verifier), /undeclared fields/);
  const nullEstimate = response(params); (nullEstimate.compassVerification as unknown as { estimate: unknown }).estimate = null;
  assert.throws(() => validateEntityCompassReview(params, nullEstimate, verifier), /both axes/);
});

test("non-supported decisions and author overrides do not replace the prior estimate", () => {
  const params = input();
  for (const verdict of ["needs_more_evidence", "rejected", "disputed"]) {
    const raw = response(params); raw.compassVerification.verdict = verdict;
    if (verdict === "needs_more_evidence") raw.compassVerification.retrievalRequests = ["Find Mira's later harvest decisions."];
    if (verdict === "disputed") raw.compassVerification.contradictingEvidence.push({ chunkId: "chunk-1", quote: contrary, axes: ["economic", "authority"], perspective: "demonstrated_behavior" });
    const receipt = validateEntityCompassReview(params, raw, verifier)!;
    assert.equal(approvedEntityCompassEstimate(params, receipt), undefined);
    assert.deepEqual(params.compassReview!.currentEstimate, input().compassReview!.currentEstimate);
  }
  const overridden = input(); overridden.compassReview!.ownerOverride = { economic: 60, authority: 5, rationale: "Author decision", confidence: 1 };
  const receipt = validateEntityCompassReview(overridden, response(overridden), verifier)!;
  assert.equal(approvedEntityCompassEstimate(overridden, receipt), undefined);
  const unknown = response(params); unknown.compassVerification.verdict = "needs_more_evidence";
  (unknown.compassVerification as unknown as { estimate: unknown }).estimate = null;
  unknown.compassVerification.supportingEvidence = []; unknown.compassVerification.retrievalRequests = ["Find later harvest decisions"];
  assert.equal(validateEntityCompassReview(params, unknown, verifier)!.decision.estimate, null);
});

test("rationale, numeric and confidence validation never clips, rounds, clamps or coerces values", () => {
  const params = input();
  for (const economic of [101, -101, 1.5, "20", NaN, null]) {
    const raw = response(params); (raw.compassVerification.estimate as unknown as { economic: unknown }).economic = economic;
    assert.throws(() => validateEntityCompassReview(params, raw, verifier), /integers between/);
  }
  for (const confidence of [-0.1, 1.01, "0.8", NaN]) {
    const raw = response(params); (raw.compassVerification as unknown as { confidence: unknown }).confidence = confidence;
    assert.throws(() => validateEntityCompassReview(params, raw, verifier), /confidence/);
  }
  const long = response(params); long.compassVerification.estimate.rationale = "A".repeat(1001);
  assert.throws(() => validateEntityCompassReview(params, long, verifier), /rationale/);
  const middle = response(params); middle.compassVerification.estimate.economic = 0; middle.compassVerification.estimate.authority = 0;
  assert.equal(approvedEntityCompassEstimate(params, validateEntityCompassReview(params, middle, verifier))!.economic, 0);
});

test("explicit viewpoint binds other characters' interpretations rather than relabeling them as behavior", () => {
  const params = input(); const raw = response(params);
  raw.compassVerification.estimate.perspective = "others_interpretation"; raw.compassVerification.estimate.epistemicHolderId = "dara-id";
  raw.compassVerification.estimate.rationale = "During spring, Dara describes Mira as favoring common ownership and personal liberty; this records Dara's view, not a timeless fact about Mira.";
  raw.compassVerification.supportingEvidence = [{ chunkId: "chunk-1", quote: opinion, axes: ["economic", "authority"], perspective: "others_interpretation" }];
  const result = approvedEntityCompassEstimate(params, validateEntityCompassReview(params, raw, verifier))!;
  assert.equal(result.epistemicHolderId, "dara-id"); assert.equal(result.perspective, "others_interpretation");
  for (const holder of [null, "mira-id", "village-id", "invented-id"]) {
    const bad = structuredClone(raw); bad.compassVerification.estimate.epistemicHolderId = holder;
    assert.throws(() => validateEntityCompassReview(params, bad, verifier), /holder|character/);
  }
  const laundered = structuredClone(raw); laundered.compassVerification.estimate.perspective = "demonstrated_behavior";
  laundered.compassVerification.estimate.epistemicHolderId = null;
  assert.throws(() => validateEntityCompassReview(params, laundered, verifier), /viewpoints/);
  const self = response(params); self.compassVerification.estimate.perspective = "self_description";
  assert.throws(() => validateEntityCompassReview(params, self, verifier), /self-description/);
});

test("padded labels and rationales cannot produce checked text that the dossier display silently trims", () => {
  const params = input();
  for (const field of ["label", "rationale"] as const) {
    for (const padding of [" ", "\n", "\t", "\u00a0"]) {
      const raw = response(params); raw.compassVerification.estimate[field] = `${padding}${raw.compassVerification.estimate[field]}${padding}`;
      assert.throws(() => validateEntityCompassReview(params, raw, verifier), /cannot be silently trimmed/);
    }
  }
  const exact = response(params);
  exact.compassVerification.estimate.rationale = "During spring, Mira favors shared harvests.\nShe also defends villagers' freedom to refuse orders.";
  exact.compassVerification.estimate.validFromLabel = " Spring debates ";
  const approved = approvedEntityCompassEstimate(params, validateEntityCompassReview(params, exact, verifier))!;
  assert.equal(approved.rationale, exact.compassVerification.estimate.rationale);
  assert.equal(approved.validFromLabel, " Spring debates ");
});

test("raw axis bypasses and extra decision or estimate fields are rejected", () => {
  const params = input();
  for (const key of ["socioPoliticalAxis", "axis_estimate", "axis_user_override", "compass", "compassEstimate"]) {
    for (const nested of [false, true]) {
      const raw: Record<string, unknown> = response(params);
      if (nested) raw.character = { [key]: { economic: 50 } }; else raw[key] = { economic: 50 };
      assert.throws(() => validateEntityCompassReview(params, raw, verifier), /bypass/);
    }
  }
  const extra = response(params); Object.assign(extra.compassVerification.estimate, { entityId: "someone-else" });
  assert.throws(() => validateEntityCompassReview(params, extra, verifier), /undeclared fields/);
  const decision = response(params); Object.assign(decision.compassVerification, { newEstimate: { economic: 10 } });
  assert.throws(() => validateEntityCompassReview(params, decision, verifier), /undeclared fields/);
  assert.throws(() => validateEntityCompassReview(params, {}, verifier), /must be an object/);
});

test("receipt reconstruction rejects modified quotes, actual model and source IDs even if privately well shaped", () => {
  const params = input(); const receipt = validateEntityCompassReview(params, response(params), verifier)!;
  for (const mutate of [
    (value: typeof receipt) => { value.decision.supportingEvidence[0]!.sourceId = "wrong-source"; },
    (value: typeof receipt) => { value.decision.estimate!.economic = -10; },
    (value: typeof receipt) => { value.verifier.model = "claimed-model"; },
    (value: typeof receipt) => { value.decision.estimate!.validUntilLabel = "All time"; },
  ]) { const altered = structuredClone(receipt); mutate(altered); assert.throws(() => assertEntityCompassReview(params, altered), /receipt|provenance/); }
  assert.throws(() => validateEntityCompassReview(params, response(params), { ...verifier, completedAt: "not-a-date" }), /completion time/);
});

test("quote counts, duplicate supports and retrieval limits are explicit rather than silently truncated", () => {
  const params = input(); const raw = response(params);
  raw.compassVerification.supportingEvidence.push(structuredClone(raw.compassVerification.supportingEvidence[0]!));
  assert.throws(() => validateEntityCompassReview(params, raw, verifier), /duplicate evidence/);
  const queries = response(params); queries.compassVerification.retrievalRequests = Array.from({ length: 5 }, (_, i) => `Find passage ${i}`);
  assert.throws(() => validateEntityCompassReview(params, queries, verifier), /bounded list/);
  const axes = response(params); axes.compassVerification.supportingEvidence[0]!.axes = ["economic", "economic"];
  assert.throws(() => validateEntityCompassReview(params, axes, verifier), /unique axis/);
  const disputed = response(params); disputed.compassVerification.verdict = "disputed";
  assert.throws(() => validateEntityCompassReview(params, disputed, verifier), /contrary evidence/);
});

test("isolated tokens, relabeled duplicate quotes and identical support/contradiction cannot create evidence", () => {
  const params = input();
  for (const quote of ["Mira", "village", "In winter"]) {
    const raw = response(params); raw.compassVerification.supportingEvidence[0]!.quote = quote;
    if (quote === "In winter") assert.doesNotThrow(() => validateEntityCompassReview(params, raw, verifier));
    else assert.throws(() => validateEntityCompassReview(params, raw, verifier), /meaningful quotation/);
  }
  const duplicate = response(params);
  duplicate.compassVerification.supportingEvidence[1]!.quote = `  ${economics.replaceAll(" ", "  ")}  `;
  assert.throws(() => validateEntityCompassReview(params, duplicate, verifier), /duplicate evidence/);
  const both = response(params);
  both.compassVerification.contradictingEvidence.push({ chunkId: "chunk-1", quote: ` ${economics} `, axes: ["authority"], perspective: "self_description" });
  assert.throws(() => validateEntityCompassReview(params, both, verifier), /both support and contradiction/);
  const unresolved = response(params); unresolved.compassVerification.verdict = "needs_more_evidence";
  assert.throws(() => validateEntityCompassReview(params, unresolved, verifier), /concrete retrieval query/);
});

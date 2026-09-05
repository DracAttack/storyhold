import assert from "node:assert/strict";
import test from "node:test";
import { assertEntityStatReviews, buildEntityStatRequests, entityStatInstructions, projectEntityReviewedStats, validateEntityStatReviews } from "./entityStatVerification";
import { PREMIUM_STAT_NAMES, premiumNeutralStats } from "./premiumStatCandidates";
import type { PremiumStatPayload, PremiumStatRequest } from "./premiumStatVerification";
import type { EntityReviewFinding, EntityReviewInput } from "./entityReview";
import type { CharacterFinding } from "./worldAnalysis";

const quote = "Mara lifted the iron gate, holding it open until everyone escaped.";
const verifier = { provider: "fixture", model: "review-model", completedAt: "2026-09-04T01:00:00.000Z" };
function input(type = "character", count = 7): EntityReviewInput {
  const stats = premiumNeutralStats();
  for (const stat of PREMIUM_STAT_NAMES.slice(0, count)) stats[stat] = { score: 14, confidence: 0.6,
    rationale: `The manuscript supports Mara's ${stat}.`, evidence: [{ chunkId: "c1", sourceId: "s1", quote }] };
  const character = { name: "Mara", estimatedStats: stats } as CharacterFinding;
  return {
    worldName: "Test world", worldPremise: "A character study", worldGenre: "Fantasy", depth: "focused",
    entity: { id: "entity-1", entityType: type, name: "Mara", aliases: [], summary: "Mara guards the pass.", details: [], relationships: [], estimatedStats: stats },
    currentCharacter: type === "character" ? character : undefined,
    chunks: [{ id: "c1", sourceId: "s1", sourceTitle: "Test book", index: 0, content: quote }], knownEntities: [],
    premiumStatScope: { worldId: "world-1", editionId: "edition-1", analysisRunId: "review-1" },
    userGuidance: "Distinguish Mara's ordinary and transformed abilities.", ownerCanonConstraints: [{ id: "constraint-1", kind: "canon", instruction: "Mara cannot fly." }],
  };
}
function decision(verdict = "verified") {
  return { verdict, explanation: "The manuscript supports this calibrated estimate.", confidence: 0.8,
    supportingEvidence: verdict === "verified" ? [{ chunkId: "c1", quote }] : [], contradictingEvidence: [], retrievalRequests: verdict === "needs_more_evidence" ? ["Find the later transformation scene."] : [] };
}
function group(request: PremiumStatRequest, verdict = "verified") {
  return { requestFingerprint: request.fingerprint, decisions: request.proposals.map((proposal) => ({ proposalId: proposal.id, ...decision(verdict) })), newStats: [] as Array<Record<string, unknown>> };
}
function response(params: EntityReviewInput, verdict = "verified") {
  return { estimatedStats: null, character: null, statVerifications: buildEntityStatRequests(params).map((request) => group(request, verdict)) };
}
function finding(params: EntityReviewInput): EntityReviewFinding {
  return { aliases: [], summary: "Mara holds the gate for the others.", details: [], relationships: [], evidence: [], confidence: 0.7,
    estimatedStats: structuredClone(params.entity.estimatedStats ?? null), character: structuredClone(params.currentCharacter ?? null), relations: [], rules: [] };
}

test("one dossier call uses two fixed bounded groups for seven explicit stat estimates", () => {
  const params = input(); const requests = buildEntityStatRequests(params);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => request.stepKey), ["dossier_stats:0", "dossier_stats:1"]);
  assert.equal(requests[0]!.proposals.length, 6); assert.equal(requests[1]!.proposals.length, 1);
  assert.deepEqual(new Set(requests[0]!.proposals.map((proposal) => proposal.payload.stat)), new Set(PREMIUM_STAT_NAMES.slice(0, 6)));
  assert.equal(requests[1]!.proposals[0]!.payload.stat, "acrobatics");
  assert.deepEqual(requests[0]!.chunks, requests[1]!.chunks);
  const receipts = validateEntityStatReviews(params, response(params), verifier);
  assertEntityStatReviews(params, receipts);
  const projected = projectEntityReviewedStats(params, finding(params), receipts);
  assert.ok(PREMIUM_STAT_NAMES.every((stat) => projected.character!.estimatedStats[stat].score === 14));
  assert.ok(PREMIUM_STAT_NAMES.every((stat) => projected.character!.estimatedStats[stat].confidence === 0.8));
  assert.equal(projected.estimatedStats, null);
  assert.equal(projected.summary, finding(params).summary);
});

test("empty candidates still require both fixed groups without automatically approving averages", () => {
  const params = input("character", 0); const requests = buildEntityStatRequests(params);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.proposals.length === 0));
  const receipts = validateEntityStatReviews(params, response(params), verifier);
  const output = projectEntityReviewedStats(params, finding(params), receipts);
  assert.deepEqual(output.character!.estimatedStats, premiumNeutralStats());
  for (const bad of [{}, { statVerifications: [] }, { statVerifications: [response(params).statVerifications[0]] }, { statVerifications: [...response(params).statVerifications, response(params).statVerifications[0]] }]) assert.throws(() => validateEntityStatReviews(params, bad, verifier), /exactly/);
});

test("all stable entity categories map explicitly and cultural references never gain numeric stats", () => {
  const categories = { character: "characters", creature: "creatures", species: "species", place: "locations", faction: "factions", institution: "institutions",
    government: "governments", power_structure: "powerStructures", technology: "technologies", vehicle: "vehicles", device: "devices", weapon: "weapons", power: "powers", title: "titles", ambiguous: "ambiguous" };
  for (const [type, family] of Object.entries(categories)) {
    const params = input(type, 1); const requests = buildEntityStatRequests(params);
    assert.equal(requests[0]!.proposals[0]!.payload.family, family);
    const projected = projectEntityReviewedStats(params, finding(params), validateEntityStatReviews(params, response(params), verifier));
    assert.equal(type === "character" ? projected.character!.estimatedStats.strength.score : projected.estimatedStats!.strength!.score, 14);
  }
  for (const type of ["cultural_reference", "term"]) {
    const params = input(type); assert.deepEqual(buildEntityStatRequests(params), []);
    assert.deepEqual(validateEntityStatReviews(params, { statVerifications: [] }, verifier), []);
    assert.throws(() => validateEntityStatReviews(params, {}, verifier), /exactly/);
    assert.throws(() => validateEntityStatReviews(params, { statVerifications: [], estimatedStats: params.entity.estimatedStats }, verifier), /raw estimatedStats/);
    assert.equal(projectEntityReviewedStats(params, finding(params), []).estimatedStats, null);
  }
  assert.throws(() => buildEntityStatRequests(input("invented-category")), /unsupported/);
});

test("missing review scope and changed entity/context/source prevent replay", () => {
  const params = input(); const receipts = validateEntityStatReviews(params, response(params), verifier);
  assert.throws(() => buildEntityStatRequests({ ...params, premiumStatScope: undefined }), /scoped/);
  const mutations: Array<(value: EntityReviewInput) => void> = [
    (value) => { value.entity.id = "entity-other"; }, (value) => { value.entity.name = "Dara"; },
    (value) => { value.entity.entityType = "creature"; }, (value) => { value.depth = "full"; },
    (value) => { value.userGuidance = "Changed instruction."; }, (value) => { value.ownerCanonConstraints![0]!.instruction = "Mara can fly."; },
    (value) => { value.premiumStatScope!.worldId = "world-other"; }, (value) => { value.premiumStatScope!.editionId = "edition-other"; },
    (value) => { value.premiumStatScope!.analysisRunId = "review-other"; }, (value) => { value.chunks[0]!.content += " Revised source."; },
    (value) => { value.chunks[0]!.sourceId = "source-other"; }, (value) => { value.currentCharacter!.estimatedStats.strength.score = 19; },
    (value) => { value.conceptResolutionContext = "New source lead."; }, (value) => { value.browserAuditContext = "Different private lead."; },
  ];
  for (const mutate of mutations) { const changed = structuredClone(params); mutate(changed); assert.throws(() => assertEntityStatReviews(changed, receipts)); }
  assert.throws(() => assertEntityStatReviews(params, [...receipts].reverse()), /changed|fixed order/);
  assert.throws(() => assertEntityStatReviews(params, [receipts[0]!]), /incomplete/);
  const tampered = structuredClone(receipts); tampered[0]!.decisions[0]!.confidence = 1;
  assert.throws(() => assertEntityStatReviews(params, tampered), /changed/);
});

test("root and nested character stats cannot bypass the explicit gate before permissive parsing", () => {
  const params = input(); const raw = response(params);
  for (const responseBody of [
    { ...raw, estimatedStats: params.entity.estimatedStats },
    { ...raw, character: { estimatedStats: params.entity.estimatedStats } },
    { ...raw, estimatedStats: { strength: { score: 100, rationale: "Forged.", confidence: 0.7, evidence: [] } } },
    { ...raw, character: { estimatedStats: { strength: 20 } } },
    { ...raw, estimatedStats: false }, { ...raw, character: [] }, { ...raw, statVerification: raw.statVerifications[0] },
  ]) assert.throws(() => validateEntityStatReviews(params, responseBody, verifier));
  assert.equal(validateEntityStatReviews(params, { ...raw, estimatedStats: premiumNeutralStats(), character: { estimatedStats: premiumNeutralStats() } }, verifier).length, 2);
});

test("new estimates may not migrate to another entity, category, or stat group", () => {
  const params = input("character", 0);
  const base: PremiumStatPayload = { family: "characters", entity: "Mara", stat: "strength", score: 15, rationale: "Mara holds up the iron gate." };
  for (const payload of [{ ...base, entity: "Dara" }, { ...base, entity: "mara" }, { ...base, family: "creatures" }, { ...base, stat: "acrobatics" }]) {
    const raw = response(params); raw.statVerifications[0]!.newStats = [{ payload, ...decision() }];
    assert.throws(() => validateEntityStatReviews(params, raw, verifier), /entity|category|group/);
  }
  const raw = response(params); raw.statVerifications[1]!.newStats = [{ payload: base, ...decision() }];
  assert.throws(() => validateEntityStatReviews(params, raw, verifier), /allowed group/);
});

test("approved new estimates are projected without inheriting unreviewed old slots", () => {
  const params = input(); const raw = response(params, "rejected");
  raw.statVerifications[0]!.newStats = [{ payload: { family: "characters", entity: "Mara", stat: "strength", score: 12, rationale: "The gate lift supports limited ordinary strength." }, ...decision() }];
  const prior = finding(params); const original = structuredClone(prior);
  const projected = projectEntityReviewedStats(params, prior, validateEntityStatReviews(params, raw, verifier));
  assert.equal(projected.character!.estimatedStats.strength.score, 12);
  assert.equal(projected.character!.estimatedStats.wisdom.score, 10);
  assert.equal(projected.character!.estimatedStats.wisdom.evidence.length, 0);
  assert.equal(projected.character!.estimatedStats.acrobatics.score, 10);
  assert.deepEqual(prior, original, "projection never mutates the supplied finding or local base");
});

test("conflicting stat variants are withheld instead of favoring confidence or output order", () => {
  const params = input("creature", 1); const raw = response(params);
  raw.statVerifications[0]!.newStats = [{ payload: { family: "creatures", entity: "Mara", stat: "strength", score: 19, rationale: "A different estimate of the same creature." }, ...decision(), confidence: 0.99 }];
  const receipts = validateEntityStatReviews(params, raw, verifier);
  assert.equal(receipts[0]!.decisions.filter((decision) => decision.verdict === "verified").length, 2);
  assert.equal(projectEntityReviewedStats(params, finding(params), receipts).estimatedStats, null);
});

test("rejected and uncertain estimates stay neutral or absent without creating entities", () => {
  for (const type of ["character", "creature"]) for (const verdict of ["rejected", "disputed", "insufficient_evidence", "needs_more_evidence"]) {
    const params = input(type); const receipts = validateEntityStatReviews(params, response(params, verdict), verifier);
    const projected = projectEntityReviewedStats(params, finding(params), receipts);
    assert.equal(projected.estimatedStats, null);
    if (type === "character") assert.deepEqual(projected.character!.estimatedStats, premiumNeutralStats());
    const noCharacter = { ...finding(params), character: null };
    assert.equal(projectEntityReviewedStats(params, noCharacter, receipts).character, null);
  }
  const params = input(); const receipts = validateEntityStatReviews(params, response(params), verifier);
  const wrong = finding(params); wrong.character!.name = "Other person";
  assert.throws(() => projectEntityReviewedStats(params, wrong, receipts), /create or rename/);
});

test("existing stat inputs are validated before grouping rather than silently truncated", () => {
  for (const bad of [20.5, 99, "14"]) {
    const params = input(); (params.currentCharacter!.estimatedStats.strength as unknown as Record<string, unknown>).score = bad;
    assert.throws(() => buildEntityStatRequests(params), /integer/);
  }
  const params = input(); (params.currentCharacter!.estimatedStats as unknown as Record<string, unknown>).luck = params.currentCharacter!.estimatedStats.strength;
  assert.throws(() => buildEntityStatRequests(params), /stat name/);
});

test("dossier contract describes two groups in one response and cannot be replaced by singular verification", () => {
  const requests = buildEntityStatRequests(input()); const instructions = entityStatInstructions(requests);
  assert.match(instructions, /ONE provider call/);
  assert.match(instructions, /EXACTLY TWO/);
  assert.match(instructions, /including newStats/);
  assert.match(instructions, /statVerifications/);
  assert.equal(instructions.split('<STAT_VERIFICATION_REQUEST trust="unverified">').length, 3);
  assert.throws(() => entityStatInstructions([requests[0]!]), /exactly two/);
  assert.throws(() => entityStatInstructions([...requests].reverse()), /fixed order/);
  assert.match(entityStatInstructions([]), /statVerifications:\[\]/);
});

test("group fingerprints, quote evidence, and decision inventories remain mandatory", () => {
  const params = input();
  const wrongFingerprint = response(params); wrongFingerprint.statVerifications[0]!.requestFingerprint = "wrong";
  assert.throws(() => validateEntityStatReviews(params, wrongFingerprint, verifier), /requestFingerprint/);
  const missing = response(params); missing.statVerifications[0]!.decisions.pop();
  assert.throws(() => validateEntityStatReviews(params, missing, verifier), /exactly one/);
  const badEvidence = response(params); badEvidence.statVerifications[0]!.decisions[0]!.supportingEvidence = [{ chunkId: "outside", quote }];
  assert.throws(() => validateEntityStatReviews(params, badEvidence, verifier), /unknown manuscript/);
});

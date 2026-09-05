import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { getAiRuntimeStatus, type AiTextResult } from "./aiGateway";
import { buildEntityCompassRequest } from "./entityCompassVerification";
import { buildEntityGraphRequest } from "./entityGraphVerification";
import { buildEntityStatRequests } from "./entityStatVerification";
import { buildEntityProseRequest } from "./entityProseVerification";
import { buildExistingProseInventory } from "./entityExistingProseReview";
import { premiumNeutralStats } from "./premiumStatCandidates";
import { premiumEntityReviewPages, quoteEntityReviewReservation, reviewEntity, reviewEntityFromSavedResult,
  entityReviewPublicError, type EntityReviewInput, type PagedEntityReviewResult } from "./entityReview";

const quote = "Mira demanded that the granary belong to everyone and that every adult have an equal vote on village rules.";
function input(): EntityReviewInput {
  const entity = { id: "mira", name: "Mira", entityType: "character", aliases: [], summary: "", details: [], relationships: [] };
  const axis = { economic: 0, authority: 0, label: "Undetermined", rationale: "", confidence: 0 };
  return { worldName: "Watchtower", worldGenre: "Fantasy", worldPremise: "A winter refuge.", entity, depth: "focused",
    chunks: [{ id: "chunk", sourceId: "source", sourceTitle: "Winter", index: 0, content: quote }],
    knownEntities: [{ name: "Mira", entityType: "character", aliases: [] }],
    premiumStatScope: { worldId: "world", editionId: "edition", analysisRunId: "review" },
    graphReview: { version: 2, entities: [{ ...entity }], relations: [], rules: [] },
    proseReview: { version: 1 }, existingProseReview: buildExistingProseInventory(entity),
    currentCharacter: { name: "Mira", aliases: [], summary: "", role: "", traits: [], motivations: [], fears: [], capabilities: [],
      history: [], origins: [], powers: [], moralSystem: [], physicalCharacteristics: [], relationships: [], relationshipWeb: [],
      factionMemberships: [], knowledge: [], secrets: [], evidence: [], confidence: 0, estimatedStats: premiumNeutralStats(), socioPoliticalAxis: axis },
    compassReview: { version: 1, currentEstimate: axis, ownerOverride: null },
  };
}
function reply(params: EntityReviewInput, unresolved = false) {
  const first = premiumEntityReviewPages(params)[0]!.input;
  return { aliases: [], summary: "", details: [], relationships: [], evidence: [], estimatedStats: null, character: null,
    relations: [], rules: [], entityRelations: [], entityRules: [],
    statVerifications: buildEntityStatRequests(first).map((request) => ({ requestFingerprint: request.fingerprint,
      decisions: request.proposals.map((proposal) => ({ proposalId: proposal.id, verdict: "needs_more_evidence", confidence: 0,
        explanation: "No ability is established.", supportingEvidence: [], contradictingEvidence: [], retrievalRequests: ["Find an ability passage."] })), newStats: [] })),
    graphVerification: { requestFingerprint: buildEntityGraphRequest(first)!.fingerprint, decisions: [], newFindings: [] },
    claims: [], claimVerification: { requestFingerprint: buildEntityProseRequest(params)!.fingerprint, decisions: [], newClaims: [] },
    prosePresentation: { displayOrder: [] },
    compassVerification: { requestFingerprint: buildEntityCompassRequest(params)!.fingerprint,
      verdict: unresolved ? "needs_more_evidence" : "supported", estimate: unresolved ? null : {
        economic: -60, authority: -50, label: "Cooperative and Participatory", rationale: "Mira favors communal food ownership and equal votes.",
        validFromLabel: "During the winter council", validUntilLabel: "", perspective: "self_description", epistemicHolderId: "mira" },
      explanation: unresolved ? "The passages do not establish her political preferences." : "The council statement supports both tendencies.",
      confidence: unresolved ? 0 : 0.8, supportingEvidence: unresolved ? [] : [{ chunkId: "chunk", quote, axes: ["economic", "authority"], perspective: "self_description" }],
      contradictingEvidence: [], retrievalRequests: unresolved ? ["Find Mira's council speech about shared resources and voting."] : [] },
  };
}
function saved(params: EntityReviewInput, value: unknown): PagedEntityReviewResult {
  const result: AiTextResult = { text: JSON.stringify(value), provider: "openrouter", model: "fixture-model", reasoning: "medium",
    runtime: { ...getAiRuntimeStatus("canon_review", "standard", "dossier"), execution: { resolvedModel: "actual-reviewer" } as never },
    journalCompletedAt: "2026-09-04T15:00:00.000Z", usage: { inputUnits: 100, outputUnits: 100, cachedInputUnits: 0, cacheWriteInputUnits: 0,
      reasoningUnits: 0, estimatedCostMicros: 100, pricingKnown: true, pricingVersion: "fixture", costEstimated: false } };
  return { ...result, entityReviewPages: [{ stepKey: premiumEntityReviewPages(params)[0]!.stepKey, result }] };
}

test("compass shares the first paid page, includes its bounded output in reservation, and leaves legacy requests unchanged", () => {
  const params = input(); const legacy = structuredClone(params); delete legacy.compassReview;
  const modernPages = premiumEntityReviewPages(params); const oldPages = premiumEntityReviewPages(legacy);
  assert.equal(modernPages.length, oldPages.length);
  assert.equal(modernPages.length, 1);
  assert.equal(modernPages[0]!.request.maxOutputTokens! - oldPages[0]!.request.maxOutputTokens!, 2_000);
  assert.equal(quoteEntityReviewReservation(params).maxOutputUnits - quoteEntityReviewReservation(legacy).maxOutputUnits, 2_000);
  assert.doesNotMatch(oldPages[0]!.request.messages.map((message) => message.content).join("\n"), /COMPASS INTERPRETATION REVIEW/);
  assert.equal(buildEntityCompassRequest(params)!.fingerprint, buildEntityCompassRequest(modernPages[0]!.input)!.fingerprint);
  assert.match(modernPages[0]!.request.messages.map((message) => message.content).join("\n"), /NOT an objective fact/);
});

test("supported compass-only work succeeds without inventing biography, stats or immutable canon", async () => {
  const params = input(); const value = reply(params);
  premiumEntityReviewPages(params)[0]!.request.validate!(JSON.stringify(value));
  let executions = 0;
  const checked = await reviewEntity(params, { executePages: async () => { executions++; return saved(params, value); } });
  assert.equal(executions, 1);
  assert.equal(checked.compassReview!.decision.verdict, "supported");
  assert.equal(checked.compassReview!.verifier.model, "actual-reviewer");
  assert.equal(checked.finding.summary, "");
  assert.deepEqual(checked.finding.character!.socioPoliticalAxis, params.currentCharacter!.socioPoliticalAxis,
    "Only the dedicated compass writer, never prose projection, may apply the interpretation");
  assert.deepEqual(checked.proseReview!.claimReceipt.decisions, []);
  assert.deepEqual(reviewEntityFromSavedResult(JSON.parse(JSON.stringify(params)), saved(params, value)), checked);
});

test("insufficient compass evidence is completed review work, not a paid retry or a cleared estimate", () => {
  const params = input(); const checked = reviewEntityFromSavedResult(params, saved(params, reply(params, true)));
  assert.equal(checked.compassReview!.decision.verdict, "needs_more_evidence");
  assert.deepEqual(checked.finding.character!.socioPoliticalAxis, params.currentCharacter!.socioPoliticalAxis);
});

test("a missing compass, raw bypass, changed source or changed owner override cannot pass saved-result replay", () => {
  const params = input(); const value = reply(params); const raw = { ...value } as Record<string, unknown>;
  delete raw.compassVerification;
  assert.throws(() => reviewEntityFromSavedResult(params, saved(params, raw)), /compass/);
  assert.throws(() => reviewEntityFromSavedResult(params, saved(params, { ...value, socioPoliticalAxis: { economic: 100 } })), /compass|undeclared/);
  for (const change of [
    (next: EntityReviewInput) => { next.chunks[0]!.content += " New contrary context."; },
    (next: EntityReviewInput) => { next.compassReview!.ownerOverride = { economic: 60 }; },
  ]) {
    const next = structuredClone(params); change(next);
    assert.throws(() => reviewEntityFromSavedResult(next, saved(next, value)), /request|fingerprint|compass/);
  }
  assert.doesNotMatch(entityReviewPublicError(new Error("Dossier compass verification: secret fingerprint")), /fingerprint/);
});

test("route wiring saves proof before a guarded separate compass write and exposes status only on the owned dossier", () => {
  const source = readFileSync(new URL("./worldStudio.ts", import.meta.url), "utf8");
  const finish = source.slice(source.indexOf("export async function finishSavedEntityReview"), source.indexOf("export async function saveEntityReview"));
  assert.ok(finish.indexOf("version: 5") < finish.indexOf("await saveEntityReview("));
  assert.match(source, /compassReview: reviewed\.compassReview, graphScope: scope/);
  assert.match(source, /axis_estimate = CASE WHEN \$11 OR axis_estimate \? 'perspective' THEN axis_estimate ELSE \$8::jsonb END/);
  assert.match(source, /axis_estimate = CASE WHEN storyhold\.character_dossiers\.axis_estimate \? 'perspective'/);
  assert.match(source, /axis_estimate = CASE WHEN axis_estimate \? 'perspective' THEN axis_estimate ELSE \$8::jsonb END/);
  assert.match(source, /currentEstimate: currentDossier\.axis_estimate \?\? \{\}, ownerOverride: currentDossier\.axis_user_override \?\? null/);
  assert.equal((source.match(/await readEntityCompassStatus\(/g) ?? []).length, 1);
  assert.match(source, /readEntityCompassStatus\(db, \{ playerId: user\.id, worldId, editionId: edition\.id, entityId: row\.hold_entity_id \}\)/);
});

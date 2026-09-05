import assert from "node:assert/strict";
import test from "node:test";
import {
  assertEntityGraphReview, buildEntityGraphRequest, entityGraphInstructions, MAX_ENTITY_GRAPH_CANDIDATES,
  MAX_ENTITY_GRAPH_DISCOVERIES, projectEntityReviewedGraph, validateEntityGraphReview, type EntityGraphContext,
} from "./entityGraphVerification";
import { buildPremiumGraphRequest, validatePremiumGraphResponse, type PremiumGraphReviewReceipt } from "./premiumGraphVerification";
import { premiumNeutralStats } from "./premiumStatCandidates";
import type { EntityReviewFinding, EntityReviewInput } from "./entityReview";
import type { CharacterFinding, EntityRelationFinding, EntityRuleFinding } from "./worldAnalysis";

type Input = EntityReviewInput & { graphReview?: EntityGraphContext };
const quote = "Mira was a member of the Watch until the winter uprising.";
const ruleQuote = "Mira opens the ward only at dusk and drains a silver charge.";
const parentQuote = "Mira was Dara's biological daughter.";
const metaphorQuote = "Mira called Dara a mother figure.";
const verifier = { provider: "fixture", model: "resolved-review-model", completedAt: "2026-09-04T10:00:00.000Z" };
const entities = [
  { id: "mira-id", name: "Mira", entityType: "character", aliases: ["Miri"] },
  { id: "watch-id", name: "Watch", entityType: "faction", aliases: ["The Watch"] },
  { id: "dara-id", name: "Dara", entityType: "character", aliases: [] },
  { id: "rowan-id", name: "Rowan", entityType: "character", aliases: [] },
];
function relation(overrides: Partial<EntityRelationFinding> = {}): EntityRelationFinding {
  return { subject: "Mira", relationType: "member_of", target: "Watch", status: "former", summary: "Mira left the Watch during the uprising.",
    validFromLabel: "before winter", validUntilLabel: "winter uprising", evidence: [{ chunkId: "chunk-1", sourceId: "source-1", quote }],
    confidence: 0.7, reviewStatus: "candidate", ...overrides };
}
function rule(overrides: Partial<EntityRuleFinding> = {}): EntityRuleFinding {
  return { entity: "Mira", name: "Silver Ward", description: "Opening the ward consumes silver charge.", ruleKind: "ability", trigger: "at dusk",
    effect: "opens the ward and drains a silver charge", evidence: [{ chunkId: "chunk-1", sourceId: "source-1", quote: ruleQuote }],
    confidence: 0.8, reviewStatus: "candidate", ...overrides };
}
function character(): CharacterFinding {
  return { name: "Mira", aliases: [], role: "Watch guard", summary: "Mira protects the gate.", traits: [], motivations: [], fears: [], capabilities: [], history: [], origins: [],
    powers: [], moralSystem: [], physicalCharacteristics: [], relationships: [], relationshipWeb: [], knowledge: [], secrets: [], factionMemberships: [],
    estimatedStats: premiumNeutralStats(), socioPoliticalAxis: { economic: 0, authority: 0, label: "Unknown", rationale: "", confidence: 0 }, evidence: [], confidence: 0.7 };
}
function input(): Input {
  return { worldName: "Winter Watch", worldPremise: "The uprising changes loyalties.", worldGenre: "Fantasy",
    entity: { id: "mira-id", name: "Mira", entityType: "character", aliases: ["Miri"], summary: "Mira guards the ward.", details: [], relationships: [] },
    currentCharacter: character(), depth: "focused", userGuidance: "Preserve earlier and later relationships.",
    ownerCanonConstraints: [{ id: "owner-1", kind: "relationship", instruction: "Dara's parental language can be metaphorical." }],
    chunks: [{ id: "chunk-1", sourceId: "source-1", sourceTitle: "Winter", index: 0,
      content: `${quote} ${ruleQuote} ${metaphorQuote} ${parentQuote} Mira joined the Watch. Dara leads the Watch. Mira and Rowan were friends.` }],
    knownEntities: structuredClone(entities), premiumStatScope: { worldId: "world-1", editionId: "edition-1", analysisRunId: "review-1" },
    graphReview: { version: 1, relations: [relation()], rules: [rule()], entities: structuredClone(entities) } };
}
function fields(verdict = "verified", evidenceQuote = quote) {
  return { verdict, explanation: "The exact passage supports the full interpretation.", confidence: 0.9,
    supportingEvidence: verdict === "verified" ? [{ chunkId: "chunk-1", quote: evidenceQuote }] : [],
    contradictingEvidence: [] as Array<{ chunkId: string; quote: string }>, retrievalRequests: verdict === "needs_more_evidence" ? ["Find the later change in allegiance."] : [] };
}
function response(params: Input, verdict = "verified") {
  const request = buildEntityGraphRequest(params)!;
  return { relations: [], rules: [], entityRelations: [], entityRules: [], relationships: [],
    character: { relationships: [], relationshipWeb: [], factionMemberships: [] },
    graphVerification: { requestFingerprint: request.fingerprint,
      decisions: request.proposals.map((proposal) => ({ proposalId: proposal.id, ...fields(verdict, proposal.kind === "rule" ? ruleQuote : quote) })),
      newFindings: [] as Array<Record<string, unknown>> } };
}
function finding(params = input()): EntityReviewFinding {
  return { aliases: [], summary: "Mira protects the gate.", details: [], relationships: [], evidence: [], confidence: 0.8,
    estimatedStats: null, character: structuredClone(params.currentCharacter ?? null), relations: [], rules: [] };
}
function receipt(params = input()): PremiumGraphReviewReceipt { return validateEntityGraphReview(params, response(params), verifier)!; }

test("bounded dossier adapter reuses one graph contract and retains exact source, identity and provenance", () => {
  const params = input(); const request = buildEntityGraphRequest(params)!;
  assert.equal(request.stepKey, "dossier_graph:0");
  assert.equal(request.proposals.length, 2);
  assert.deepEqual(request, buildEntityGraphRequest(params));
  assert.match(entityGraphInstructions(params), /SAME single provider call/);
  assert.match(entityGraphInstructions(params), /at most 4 newFindings TOTAL/);
  assert.match(entityGraphInstructions(params), /mira-id/);
  assert.equal(MAX_ENTITY_GRAPH_CANDIDATES, 12); assert.equal(MAX_ENTITY_GRAPH_DISCOVERIES, 4);
  const reviewed = receipt(params); assertEntityGraphReview(params, reviewed);
  assert.deepEqual(reviewed.verifier, verifier);
  assert.equal(reviewed.decisions[0]!.completedAt, verifier.completedAt);
  assert.ok(Object.isFrozen(reviewed));
});

test("legacy input stays legacy and can never be assigned modern graph proof", () => {
  const modern = input(); const legacy = { ...modern, graphReview: undefined };
  assert.equal(buildEntityGraphRequest(legacy), undefined);
  assert.equal(entityGraphInstructions(legacy), "");
  assert.equal(validateEntityGraphReview(legacy, { relations: [relation()] }, verifier), undefined);
  assertEntityGraphReview(legacy, undefined);
  assert.throws(() => assertEntityGraphReview(legacy, receipt(modern)), /legacy/);
  const original = finding(); original.relations = [relation()];
  const copy = projectEntityReviewedGraph(legacy, original, undefined);
  assert.deepEqual(copy, original); assert.notEqual(copy, original);
  assert.throws(() => assertEntityGraphReview(modern, undefined), /missing/);
});

test("every legacy relationship array and all alternate graph output paths are forbidden", () => {
  const params = input();
  for (const key of ["relations", "rules", "entityRelations", "entityRules", "relationships"]) {
    const raw = { ...response(params), [key]: [relation()] };
    assert.throws(() => validateEntityGraphReview(params, raw, verifier), /empty array/);
  }
  for (const key of ["relations", "rules", "entityRelations", "entityRules"]) {
    const raw = response(params) as Record<string, unknown>; delete raw[key];
    assert.throws(() => validateEntityGraphReview(params, raw, verifier), /empty array/);
  }
  for (const key of ["relationships", "relationshipWeb", "factionMemberships"]) {
    assert.throws(() => validateEntityGraphReview(params, { ...response(params), character: { [key]: ["invented"] } }, verifier), /empty array/);
    assert.throws(() => validateEntityGraphReview(params, { ...response(params), character: { [key]: "invented" } }, verifier), /empty array/);
  }
  for (const key of ["newRelations", "claims", "factionMemberships", "relationshipWeb", "graphVerifications"]) {
    assert.throws(() => validateEntityGraphReview(params, { ...response(params), [key]: [] }, verifier), /undeclared response array/);
  }
  assert.throws(() => validateEntityGraphReview(params, { ...response(params), character: { newRelations: [] } }, verifier), /undeclared character array/);
});

test("empty inventories still require the complete graph response without silent defaults", () => {
  const params = input(); params.graphReview!.relations = []; params.graphReview!.rules = [];
  const raw = response(params);
  assert.deepEqual(projectEntityReviewedGraph(params, finding(params), validateEntityGraphReview(params, raw, verifier)).relations, []);
  assert.throws(() => validateEntityGraphReview(params, {}, verifier), /empty array/);
  assert.throws(() => validateEntityGraphReview(params, { ...raw, graphVerification: undefined }, verifier), /graphVerification/);
  assert.throws(() => validateEntityGraphReview(params, { ...raw, graphVerification: { ...raw.graphVerification, ignoredRelations: [] } }, verifier), /unexpected fields/);
});

test("all candidate and discovered proposals must touch the target, including rejected proposals", () => {
  const params = input(); params.graphReview!.relations = [relation({ subject: "Dara", target: "Watch" })];
  assert.throws(() => buildEntityGraphRequest(params), /reviewed canonical entity/);
  params.graphReview!.relations = []; params.graphReview!.rules = [rule({ entity: "Dara" })];
  assert.throws(() => buildEntityGraphRequest(params), /reviewed canonical entity/);
  const fresh = input(); const raw = response(fresh, "rejected");
  const { evidence: _e, confidence: _c, reviewStatus: _s, ...payload } = relation({ subject: "Dara", target: "Watch" });
  raw.graphVerification.newFindings = [{ kind: "relation", payload, ...fields("rejected") }];
  assert.throws(() => validateEntityGraphReview(fresh, raw, verifier), /reviewed canonical entity/);
  raw.graphVerification.newFindings = [{ kind: "rule", payload: { entity: "Dara", name: "Other rule", description: "Other behavior", ruleKind: "trait", trigger: "", effect: "" }, ...fields("rejected") }];
  assert.throws(() => validateEntityGraphReview(fresh, raw, verifier), /reviewed canonical entity/);
});

test("canonical aliases resolve only when unambiguous and never create entities or self-links", () => {
  const params = input(); params.graphReview!.relations[0]!.subject = "Miri";
  assert.equal(buildEntityGraphRequest(params)!.proposals.find((proposal) => proposal.kind === "relation")!.payload.subject, "Miri");
  params.graphReview!.entities[2]!.aliases = ["Miri"];
  assert.throws(() => buildEntityGraphRequest(params), /ambiguous/);
  for (const target of ["Unknown Person", "Miri"]) {
    const changed = input(); changed.graphReview!.relations[0]!.target = target;
    assert.throws(() => buildEntityGraphRequest(changed), /ambiguous|different known entity/);
  }
  const changed = input(); changed.graphReview!.entities.push(structuredClone(changed.graphReview!.entities[0]!));
  assert.throws(() => buildEntityGraphRequest(changed), /unique/);
});

test("unknown categories, scope, version and canonical identity mismatches fail before dispatch", () => {
  const mutations: Array<(value: Input) => void> = [
    (value) => { value.premiumStatScope = undefined; }, (value) => { value.premiumStatScope!.worldId = ""; },
    (value) => { value.graphReview!.entities[1]!.entityType = "invented"; },
    (value) => { value.graphReview!.version = 2 as 1; }, (value) => { value.entity.id = "not-the-target"; },
    (value) => { value.entity.entityType = "faction"; }, (value) => { value.entity.name = "Dara"; },
  ];
  for (const mutate of mutations) { const params = input(); mutate(params); assert.throws(() => buildEntityGraphRequest(params), /Dossier graph verification/); }
});

test("the exact frozen input, source and owner constraints are bound on saved review replay", () => {
  const params = input(); const reviewed = receipt(params);
  const mutations: Array<(value: Input) => void> = [
    (value) => { value.depth = "full"; }, (value) => { value.userGuidance = "Different guidance"; },
    (value) => { value.ownerCanonConstraints![0]!.instruction = "Different correction"; },
    (value) => { value.premiumStatScope!.analysisRunId = "different-review"; },
    (value) => { value.chunks[0]!.content += " Changed source."; }, (value) => { value.chunks[0]!.sourceId = "different-source"; },
    (value) => { value.graphReview!.entities[1]!.id = "different-canonical-id"; },
    (value) => { value.graphReview!.entities[1]!.aliases.push("Wardens"); },
    (value) => { value.entity.summary = "Different dossier context"; },
    (value) => { value.currentCharacter!.relationshipWeb = [{ name: "Dara", relationship: "Other", summary: "Other", sentiment: "unknown", evidence: [] }]; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(params); mutate(changed);
    assert.throws(() => assertEntityGraphReview(changed, reviewed), /different sources/);
  }
  const tampered = structuredClone(reviewed); tampered.verifier.model = "substituted-model";
  assert.throws(() => assertEntityGraphReview(params, tampered), /changed|provenance/);
});

test("the 12-candidate capacity is checked after exact shared-contract deduplication, never truncation", () => {
  const params = input(); params.graphReview!.relations = Array.from({ length: 20 }, () => relation());
  assert.equal(buildEntityGraphRequest(params)!.proposals.length, 2);
  params.graphReview!.relations = []; params.graphReview!.rules = Array.from({ length: 12 }, (_, index) => rule({ name: `Rule ${index}` }));
  assert.equal(buildEntityGraphRequest(params)!.proposals.length, 12);
  params.graphReview!.rules.push(rule({ name: "Thirteenth" }));
  assert.throws(() => buildEntityGraphRequest(params), /exceeds 12/);
  assert.throws(() => entityGraphInstructions(params), /exceeds 12/);
});

test("discoveries have a strict four-item allowance counting all verdicts", () => {
  const params = input(); const raw = response(params);
  raw.graphVerification.newFindings = Array.from({ length: 4 }, (_, index) => ({ kind: "rule", payload: {
    entity: "Mira", name: `Alternative ${index}`, description: "Uncertain behavior", ruleKind: "trait", trigger: "", effect: "" }, ...fields("rejected") }));
  assert.equal(validateEntityGraphReview(params, raw, verifier)!.packet.proposals.length, 6);
  raw.graphVerification.newFindings.push({ ...raw.graphVerification.newFindings[0], payload: { ...raw.graphVerification.newFindings[0]!.payload as object, name: "Fifth" } });
  assert.throws(() => validateEntityGraphReview(params, raw, verifier), /at most 4/);
  const original = buildEntityGraphRequest(params)!;
  const external = validatePremiumGraphResponse(original, raw, verifier);
  assert.throws(() => assertEntityGraphReview(params, external), /discovery capacity/);
});

test("missing decisions, changed requests and invented or wrong-source quotes cannot approve a graph", () => {
  const params = input(); const missing = response(params); missing.graphVerification.decisions.pop();
  assert.throws(() => validateEntityGraphReview(params, missing, verifier), /exactly one/);
  const changed = response(params); changed.graphVerification.requestFingerprint = "another-request";
  assert.throws(() => validateEntityGraphReview(params, changed, verifier), /requestFingerprint/);
  for (const support of [{ chunkId: "missing", quote }, { chunkId: "chunk-1", quote: "Mira invented a dragon." }, { chunkId: "chunk-1", quote, sourceId: "forged" }]) {
    const raw = response(params); raw.graphVerification.decisions[0]!.supportingEvidence = [support];
    assert.throws(() => validateEntityGraphReview(params, raw, verifier), /unknown|absent|unexpected/);
  }
});

test("figurative kinship and reversed biological direction are rejected before display or persistence", () => {
  for (const [subject, target, supporting] of [["Mira", "Dara", metaphorQuote], ["Dara", "Mira", parentQuote]]) {
    const params = input(); params.graphReview!.rules = [];
    params.graphReview!.relations = [relation({ subject, target, relationType: "child_of", status: "active", summary: "A parent-child bond.", validFromLabel: "", validUntilLabel: "" })];
    const raw = response(params); raw.graphVerification.decisions[0]!.supportingEvidence = [{ chunkId: "chunk-1", quote: supporting! }];
    assert.throws(() => validateEntityGraphReview(params, raw, verifier), /Premium relation semantics rejected/);
    assert.doesNotThrow(() => validateEntityGraphReview(params, response(params, "rejected"), verifier));
  }
});

test("directed parenthood renders from the reviewed target's perspective without reversing canon", () => {
  const params = input(); params.graphReview!.rules = [];
  params.entity = { ...params.entity, id: "dara-id", name: "Dara", aliases: [] }; params.currentCharacter = { ...character(), name: "Dara" };
  params.graphReview!.relations = [relation({ subject: "Mira", target: "Dara", relationType: "child_of", status: "active", summary: "Mira is Dara's daughter.", validFromLabel: "", validUntilLabel: "" })];
  const raw = response(params); raw.graphVerification.decisions[0]!.supportingEvidence = [{ chunkId: "chunk-1", quote: parentQuote }];
  const projected = projectEntityReviewedGraph(params, finding(params), validateEntityGraphReview(params, raw, verifier));
  assert.equal(projected.relations[0]!.subject, "Mira"); assert.equal(projected.relations[0]!.target, "Dara");
  assert.equal(projected.character!.relationshipWeb[0]!.name, "Mira");
  assert.equal(projected.character!.relationshipWeb[0]!.relationship, "Parent Of");
});

test("former, conditional, disputed and dated membership remains temporal instead of becoming current faction membership", () => {
  for (const status of ["former", "conditional", "disputed", "unknown", "active"] as const) {
    const params = input(); params.graphReview!.rules = []; params.graphReview!.relations = [relation({ status })];
    const projected = projectEntityReviewedGraph(params, finding(params), receipt(params));
    assert.equal(projected.relations[0]!.status, status);
    assert.equal(projected.relations[0]!.validFromLabel, "before winter"); assert.equal(projected.relations[0]!.validUntilLabel, "winter uprising");
    assert.deepEqual(projected.character!.factionMemberships, []);
    assert.match(projected.character!.relationshipWeb[0]!.relationship, /From before winter; Until winter uprising/);
  }
  const params = input(); params.graphReview!.rules = []; params.graphReview!.relations = [relation({ status: "active", validFromLabel: "", validUntilLabel: "" })];
  const raw = response(params); raw.graphVerification.decisions[0]!.supportingEvidence = [{ chunkId: "chunk-1", quote: "Mira joined the Watch." }];
  const projected = projectEntityReviewedGraph(params, finding(params), validateEntityGraphReview(params, raw, verifier));
  assert.deepEqual(projected.character!.factionMemberships, ["Watch"]);
});

test("only verified decisions populate graph displays, clearing legacy strings without mutating the input", () => {
  const params = input(); const original = finding(params);
  original.relationships = ["Mira rules the Watch."]; original.relations = [relation()]; original.rules = [rule()];
  original.character!.relationshipWeb = [{ name: "Dara", relationship: "Invented", summary: "Unsupported", sentiment: "hostile", evidence: [] }];
  original.character!.relationships = ["Unsupported"]; original.character!.factionMemberships = ["Other faction"];
  const before = structuredClone(original);
  for (const verdict of ["rejected", "disputed", "insufficient_evidence", "needs_more_evidence"]) {
    const projected = projectEntityReviewedGraph(params, original, validateEntityGraphReview(params, response(params, verdict), verifier));
    assert.deepEqual(projected.relations, []); assert.deepEqual(projected.rules, []); assert.deepEqual(projected.relationships, []);
    assert.deepEqual(projected.character!.relationshipWeb, []); assert.deepEqual(projected.character!.relationships, []); assert.deepEqual(projected.character!.factionMemberships, []);
    assert.equal(projected.summary, original.summary);
  }
  assert.deepEqual(original, before);
});

test("saved receipts built for unrelated requests are rejected even when the generic receipt is valid", () => {
  const params = input(); const current = buildEntityGraphRequest(params)!;
  const unrelated = buildPremiumGraphRequest({ ...current, scope: { ...current.scope, analysisRunId: "other-review" }, relations: params.graphReview!.relations, rules: params.graphReview!.rules });
  const raw = response(params); raw.graphVerification.requestFingerprint = unrelated.fingerprint;
  raw.graphVerification.decisions = unrelated.proposals.map((proposal) => ({ proposalId: proposal.id, ...fields("rejected") }));
  const reviewed = validatePremiumGraphResponse(unrelated, raw, verifier);
  assert.throws(() => assertEntityGraphReview(params, reviewed), /different sources/);
});

test("JSONB-style object key reordering preserves the exact request and receipt on replay", () => {
  const params = input(); const reviewed = receipt(params);
  const reordered = JSON.parse(JSON.stringify(params, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => right.localeCompare(left))) : value)) as Input;
  assert.notEqual(JSON.stringify(reordered.graphReview!.entities), JSON.stringify(params.graphReview!.entities));
  assert.notEqual(JSON.stringify(reordered.ownerCanonConstraints), JSON.stringify(params.ownerCanonConstraints));
  assert.deepEqual(buildEntityGraphRequest(reordered), buildEntityGraphRequest(params));
  assertEntityGraphReview(reordered, reviewed);
});

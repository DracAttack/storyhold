import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPremiumGraphReceipt, buildPremiumGraphRequest, graphFromPremiumReceipts,
  premiumGraphInstructions, validatePremiumGraphResponse,
  type PremiumGraphRequest, type PremiumRelationPayload, type PremiumRulePayload,
} from "./premiumGraphVerification";
import type { EntityRelationFinding, EntityRuleFinding } from "./worldAnalysis";

const scope = { worldId: "world-1", editionId: "edition-1", analysisRunId: "run-1" };
const verifier = { provider: "openai", model: "fixture-verifier", completedAt: "2026-09-03T12:00:00.000Z" };
const relationQuote = "Mira was a member of the Watch until the winter uprising.";
const ruleQuote = "The ward opens only at dusk and drains a silver charge.";
const chunks = [
  { id: "chunk-1", sourceId: "source-1", text: `${relationQuote} ${ruleQuote} Mira called Dara a mother figure. Mira was Dara's biological daughter.` },
  { id: "chunk-2", sourceId: "source-2", text: "Before winter, Mira served the Watch. At dawn the ward closes and restores a silver charge." },
];
const relationPayload: PremiumRelationPayload = {
  subject: "Mira", relationType: "member_of", target: "Watch", status: "former",
  summary: "Mira left the Watch during the winter uprising.", validFromLabel: "before winter", validUntilLabel: "winter uprising",
};
const rulePayload: PremiumRulePayload = {
  entity: "ward", name: "Silver gate", description: "The ward spends silver charge to open at dusk.",
  ruleKind: "constraint", trigger: "at dusk", effect: "opens and drains a silver charge",
};
function relation(overrides: Partial<EntityRelationFinding> = {}): EntityRelationFinding {
  return { ...relationPayload, confidence: 0.7, evidence: [{ chunkId: "chunk-1", sourceId: "source-1", quote: relationQuote }], reviewStatus: "candidate", ...overrides };
}
function rule(overrides: Partial<EntityRuleFinding> = {}): EntityRuleFinding {
  return { ...rulePayload, confidence: 0.8, evidence: [{ chunkId: "chunk-1", sourceId: "source-1", quote: ruleQuote }], reviewStatus: "candidate", ...overrides };
}
function request(relations = [relation()], rules = [rule()], stepKey = "verification:0"): PremiumGraphRequest {
  return buildPremiumGraphRequest({ scope, stepKey, chunks, relations, rules, context: { userGuidance: "Keep former membership and temporary states distinct." } });
}
function fields(verdict = "verified", quote = relationQuote) {
  return { verdict, explanation: "The supplied passage explicitly supports this interpretation.", confidence: 0.9,
    supportingEvidence: verdict === "verified" ? [{ chunkId: "chunk-1", quote }] : [],
    contradictingEvidence: [] as Array<{ chunkId: string; quote: string }>, retrievalRequests: verdict === "needs_more_evidence" ? ["Find the later passage."] : [],
  };
}
function response(input: PremiumGraphRequest, verdict = "verified") {
  return { entityRelations: [], entityRules: [], graphVerification: {
    requestFingerprint: input.fingerprint,
    decisions: input.proposals.map((proposal) => ({ proposalId: proposal.id, ...fields(verdict, proposal.kind === "relation" ? relationQuote : ruleQuote) })),
    newFindings: [] as Array<Record<string, unknown>>,
  } };
}

test("request and receipt are immutable, deterministic, and bind complete source context", () => {
  const input = request();
  assert.deepEqual(input, request());
  assert.ok(Object.isFrozen(input.proposals[0]!.payload));
  const receipt = validatePremiumGraphResponse(input, response(input), verifier);
  assert.deepEqual(receipt, validatePremiumGraphResponse(input, response(input), verifier));
  assertPremiumGraphReceipt(receipt);
  assert.equal(receipt.packet.ownerConstraints[0]!.instruction, input.context.userGuidance);
  const changed = buildPremiumGraphRequest({ scope, stepKey: input.stepKey, chunks, relations: [relation()], rules: [rule()], context: { userGuidance: "Different owner instruction." } });
  assert.notEqual(changed.fingerprint, input.fingerprint);
  assert.throws(() => validatePremiumGraphResponse(changed, response(input), verifier), /requestFingerprint/);
  const edited = structuredClone(input);
  edited.chunks[0]!.text += " Revised passage.";
  assert.throws(() => premiumGraphInstructions(edited), /provenance/);
});

test("reviewStatus is not identity but directed roles, statuses, periods, and rule behavior are", () => {
  const original = request();
  assert.equal(request([relation({ reviewStatus: "verified" })], [rule({ reviewStatus: "verified" })]).fingerprint, original.fingerprint);
  const originalRelationId = original.proposals.find((item) => item.kind === "relation")!.id;
  for (const changed of [relation({ subject: "Watch", target: "Mira" }), relation({ status: "active" }), relation({ relationType: "related_to" }), relation({ validFromLabel: "spring" }), relation({ validUntilLabel: "summer" }), relation({ summary: "A different interpretation." })]) {
    assert.notEqual(request([changed], []).proposals[0]!.id, originalRelationId);
  }
  const originalRuleId = original.proposals.find((item) => item.kind === "rule")!.id;
  for (const changed of [rule({ trigger: "at dawn" }), rule({ effect: "closes and restores charge" }), rule({ description: "A disputed principle." }), rule({ ruleKind: "ability" })]) {
    assert.notEqual(request([], [changed]).proposals[0]!.id, originalRuleId);
  }
});

test("every candidate requires exactly one known explicit decision", () => {
  const input = request();
  const missing = response(input);
  missing.graphVerification.decisions.pop();
  assert.throws(() => validatePremiumGraphResponse(input, missing, verifier), /exactly one explicit decision/);
  const duplicate = response(input);
  duplicate.graphVerification.decisions[1] = duplicate.graphVerification.decisions[0]!;
  assert.throws(() => validatePremiumGraphResponse(input, duplicate, verifier), /exactly one/);
  const unknown = response(input);
  unknown.graphVerification.decisions[0]!.proposalId = "invented";
  assert.throws(() => validatePremiumGraphResponse(input, unknown, verifier), /exactly one/);
});

test("empty candidates still require graph verification and explicitly empty legacy arrays", () => {
  const input = request([], []);
  assert.throws(() => validatePremiumGraphResponse(input, { entityRelations: [], entityRules: [] }, verifier), /graphVerification/);
  assert.throws(() => validatePremiumGraphResponse(input, { ...response(input), entityRelations: [relation()] }, verifier), /legacy/);
  assert.throws(() => validatePremiumGraphResponse(input, { ...response(input), entityRules: [rule()] }, verifier), /legacy/);
  const receipt = validatePremiumGraphResponse(input, response(input), verifier);
  assert.equal(receipt.verifier.provider, "openai");
  assert.deepEqual(graphFromPremiumReceipts([receipt]), { entityRelations: [], entityRules: [], conflicts: [] });
});

test("forged quotes, source swaps, unknown chunks, and tiny support cannot verify", () => {
  const input = request([relation()], []);
  for (const evidence of [
    { chunkId: "chunk-1", quote: "Mira controls the Watch." },
    { chunkId: "outside-reference", quote: relationQuote },
    { chunkId: "chunk-1", sourceId: "source-2", quote: relationQuote },
    { chunkId: "chunk-1", quote: "Mira" },
  ]) {
    const raw = response(input);
    raw.graphVerification.decisions[0]!.supportingEvidence = [evidence];
    assert.throws(() => validatePremiumGraphResponse(input, raw, verifier), /quote|chunk|unexpected fields|supporting/);
  }
});

test("quote validation normalizes NFKC and whitespace without fuzzy matching", () => {
  const input = buildPremiumGraphRequest({ scope, stepKey: "verification:0", chunks: [{ id: "c", sourceId: "s", text: "Ｍｉｒａ\n   joined the Watch." }], relations: [], rules: [], context: {} });
  const raw = response(input);
  raw.graphVerification.newFindings = [{ kind: "relation", payload: { ...relationPayload, status: "active" }, ...fields(), supportingEvidence: [{ chunkId: "c", quote: "Mira joined the Watch." }] }];
  const graph = graphFromPremiumReceipts([validatePremiumGraphResponse(input, raw, verifier)]);
  assert.equal(graph.entityRelations[0]!.evidence[0]!.sourceId, "s");
  raw.graphVerification.newFindings[0]!.supportingEvidence = [{ chunkId: "c", quote: "Mira joined The Watch." }];
  assert.throws(() => validatePremiumGraphResponse(input, raw, verifier), /absent/);
});

test("invalid historical local quotes are nonauthoritative but leave candidates reviewable", () => {
  const input = request([relation({ evidence: [{ chunkId: "missing", sourceId: "wrong", quote: "Not in the manuscript." }] })], []);
  assert.equal(input.proposals.length, 1);
  assert.deepEqual(input.evidence, []);
  const result = graphFromPremiumReceipts([validatePremiumGraphResponse(input, response(input, "rejected"), verifier)]);
  assert.deepEqual(result.entityRelations, []);
});

test("uncertain and rejected verdicts never produce canonical relations or rules", () => {
  for (const verdict of ["rejected", "disputed", "insufficient_evidence", "needs_more_evidence"]) {
    const input = request();
    const receipt = validatePremiumGraphResponse(input, response(input, verdict), verifier);
    assert.equal(receipt.decisions.length, 2);
    assert.deepEqual(graphFromPremiumReceipts([receipt]), { entityRelations: [], entityRules: [], conflicts: [] });
  }
});

test("verified former and disputed relation statuses remain distinct from verdicts", () => {
  const input = request([relation(), relation({ status: "disputed" }), relation({ status: "conditional" })], []);
  const graph = graphFromPremiumReceipts([validatePremiumGraphResponse(input, response(input), verifier)]);
  assert.deepEqual(new Set(graph.entityRelations.map((item) => item.status)), new Set(["former", "disputed", "conditional"]));
  assert.ok(graph.entityRelations.every((item) => item.validFromLabel === "before winter" && item.validUntilLabel === "winter uprising"));
});

test("role reversal and separate membership periods cannot collapse during projection", () => {
  const input = request([relation(), relation({ subject: "Watch", target: "Mira" }), relation({ validFromLabel: "next spring", validUntilLabel: "next summer" })], []);
  const graph = graphFromPremiumReceipts([validatePremiumGraphResponse(input, response(input), verifier)]);
  assert.equal(graph.entityRelations.length, 3);
  assert.ok(graph.entityRelations.some((item) => item.subject === "Watch" && item.target === "Mira"));
  assert.ok(graph.entityRelations.some((item) => item.validFromLabel === "next spring"));
});

test("figurative family correction is explicit rejection plus a newly verified relation", () => {
  const input = request([relation({ relationType: "child_of", target: "Dara", status: "active", summary: "Dara is a mother figure to Mira." })], []);
  const raw = response(input, "rejected");
  raw.graphVerification.newFindings = [{ kind: "relation", payload: { ...relationPayload, relationType: "related_to", target: "Dara", status: "active", summary: "Dara is a mother figure to Mira." }, ...fields(), supportingEvidence: [{ chunkId: "chunk-1", quote: "Mira called Dara a mother figure." }] }];
  const receipt = validatePremiumGraphResponse(input, raw, verifier);
  const graph = graphFromPremiumReceipts([receipt]);
  assert.equal(graph.entityRelations.length, 1);
  assert.equal(graph.entityRelations[0]!.relationType, "related_to");
  assert.equal(receipt.decisions.filter((item) => item.verdict === "rejected").length, 1);
  const prompt = premiumGraphInstructions(input);
  assert.match(prompt, /biological or legal kinship/);
  assert.match(prompt, /never chosen\/found family/);
});

test("literal kinship stays directed when explicitly verified", () => {
  const input = request([relation({ relationType: "child_of", target: "Dara", status: "active", summary: "Mira is Dara's biological daughter." })], []);
  const raw = response(input);
  raw.graphVerification.decisions[0]!.supportingEvidence = [{ chunkId: "chunk-1", quote: "Mira was Dara's biological daughter." }];
  const [verified] = graphFromPremiumReceipts([validatePremiumGraphResponse(input, raw, verifier)]).entityRelations;
  assert.equal(verified!.relationType, "child_of");
  assert.equal(verified!.subject, "Mira");
  assert.equal(verified!.target, "Dara");
});

test("corrections cannot be hidden in decision payload fields", () => {
  const input = request();
  const raw = response(input);
  Object.assign(raw.graphVerification.decisions[0]!, { correctedPayload: { ...rulePayload, effect: "restores charge" } });
  assert.throws(() => validatePremiumGraphResponse(input, raw, verifier), /unexpected fields/);
});

test("new findings require explicit kinds and complete semantic payloads", () => {
  const input = request([], []);
  const raw = response(input);
  raw.graphVerification.newFindings = [{ kind: "rule", payload: { ...rulePayload }, ...fields("verified", ruleQuote) }];
  assert.equal(graphFromPremiumReceipts([validatePremiumGraphResponse(input, raw, verifier)]).entityRules.length, 1);
  const { ruleKind: _ruleKind, ...missingKind } = rulePayload;
  raw.graphVerification.newFindings[0]!.payload = missingKind;
  assert.throws(() => validatePremiumGraphResponse(input, raw, verifier), /missing required/);
  raw.graphVerification.newFindings[0]!.payload = { ...rulePayload, ruleKind: "magic" };
  assert.throws(() => validatePremiumGraphResponse(input, raw, verifier), /ruleKind/);
  raw.graphVerification.newFindings[0]!.kind = "entity";
  assert.throws(() => validatePremiumGraphResponse(input, raw, verifier), /finding kind/);
});

test("unchanged candidate rediscovery and duplicate discoveries fail closed", () => {
  const input = request([], [rule()]);
  const raw = response(input);
  raw.graphVerification.newFindings = [{ kind: "rule", payload: rulePayload, ...fields("verified", ruleQuote) }];
  assert.throws(() => validatePremiumGraphResponse(input, raw, verifier), /repeats/);
  const empty = request([], []);
  const discovered = response(empty);
  const entry = { kind: "rule", payload: rulePayload, ...fields("verified", ruleQuote) };
  discovered.graphVerification.newFindings = [entry, entry];
  assert.throws(() => validatePremiumGraphResponse(empty, discovered, verifier), /repeats/);
});

test("receipt tampering cannot change direction, status, rule effect, source, verdict, or timestamp", () => {
  const input = request();
  const receipt = validatePremiumGraphResponse(input, response(input), verifier);
  for (const tamper of [
    (value: typeof receipt) => { value.packet.proposals.find((item) => item.kind === "relation")!.payload.subject = "Watch"; },
    (value: typeof receipt) => { value.packet.proposals.find((item) => item.kind === "relation")!.payload.status = "active"; },
    (value: typeof receipt) => { value.packet.proposals.find((item) => item.kind === "rule")!.payload.effect = "restores charge"; },
    (value: typeof receipt) => { value.packet.evidence[0]!.sourceId = "another-source"; },
    (value: typeof receipt) => { value.decisions[0]!.verdict = "rejected"; },
    (value: typeof receipt) => { value.verifier.completedAt = "2026-09-04T12:00:00.000Z"; },
    (value: typeof receipt) => { value.fingerprint = "forged"; },
  ]) {
    const changed = structuredClone(receipt);
    tamper(changed);
    assert.throws(() => assertPremiumGraphReceipt(changed), /verification/);
    assert.throws(() => graphFromPremiumReceipts([changed]), /verification/);
  }
});

test("duplicate exact payloads union support deterministically without altering descriptions", () => {
  const first = request();
  const second = request([relation()], [rule()], "verification:1");
  const raw = response(second);
  for (const decision of raw.graphVerification.decisions) decision.supportingEvidence = [{ chunkId: "chunk-2", quote: chunks[1]!.text }];
  const receipts = [validatePremiumGraphResponse(first, response(first), verifier), validatePremiumGraphResponse(second, raw, verifier)];
  const graph = graphFromPremiumReceipts(receipts);
  assert.deepEqual(graph, graphFromPremiumReceipts([...receipts].reverse()));
  assert.equal(graph.entityRelations.length, 1);
  assert.equal(graph.entityRelations[0]!.evidence.length, 2);
  assert.equal(graph.entityRules[0]!.evidence.length, 2);
  assert.equal(graph.entityRules[0]!.description, rulePayload.description);
});

test("relation paraphrases choose one exact verified representative without cross-payload evidence", () => {
  const first = request([relation()], []);
  const second = request([relation({ summary: "Mira's service with the Watch ended in winter." })], [], "verification:1");
  const raw = response(second);
  raw.graphVerification.decisions[0]!.supportingEvidence = [{ chunkId: "chunk-2", quote: "Before winter, Mira served the Watch." }];
  const receipts = [validatePremiumGraphResponse(first, response(first), verifier), validatePremiumGraphResponse(second, raw, verifier)];
  const graph = graphFromPremiumReceipts(receipts);
  assert.deepEqual(graph, graphFromPremiumReceipts([...receipts].reverse()));
  assert.equal(graph.entityRelations.length, 1);
  assert.equal(graph.entityRelations[0]!.evidence.length, 1);
  assert.ok([relationPayload.summary, "Mira's service with the Watch ended in winter."].includes(graph.entityRelations[0]!.summary));
  assert.equal(graph.conflicts.length, 0);
});

test("incompatible rule trigger and effect variants are held as concrete conflicts, not overwritten", () => {
  const input = request([], [rule(), rule({ description: "The ward restores charge at dawn.", trigger: "at dawn", effect: "closes and restores a silver charge" })]);
  const receipt = validatePremiumGraphResponse(input, response(input), verifier);
  const graph = graphFromPremiumReceipts([receipt]);
  assert.equal(receipt.decisions.length, 2);
  assert.deepEqual(graph.entityRules, []);
  assert.equal(graph.conflicts.length, 1);
  assert.match(graph.conflicts[0]!.summary, /at dusk/);
  assert.match(graph.conflicts[0]!.summary, /at dawn/);
  assert.match(graph.conflicts[0]!.summary, /drains a silver charge/);
  assert.match(graph.conflicts[0]!.summary, /restores a silver charge/);
  assert.doesNotMatch(graph.conflicts[0]!.summary, /payload|fingerprint|backend|receipt/);
});

test("rule name shared across distinct kinds is allowed, while description changes still conflict", () => {
  const distinct = request([], [rule(), rule({ ruleKind: "ability" })]);
  const graph = graphFromPremiumReceipts([validatePremiumGraphResponse(distinct, response(distinct), verifier)]);
  assert.equal(graph.entityRules.length, 2);
  const competing = request([], [rule(), rule({ description: "Only the northern ward follows this rule." })]);
  const conflict = graphFromPremiumReceipts([validatePremiumGraphResponse(competing, response(competing), verifier)]).conflicts;
  assert.equal(conflict.length, 1);
  assert.ok(conflict[0]!.summary.includes(rulePayload.description));
  assert.ok(conflict[0]!.summary.includes("Only the northern ward follows this rule."));
});

test("mixed scope and duplicate step receipts cannot be combined", () => {
  const input = request();
  const receipt = validatePremiumGraphResponse(input, response(input), verifier);
  assert.throws(() => graphFromPremiumReceipts([receipt, receipt]), /duplicate verification step/);
  const foreign = buildPremiumGraphRequest({ scope: { ...scope, worldId: "another-world" }, stepKey: "verification:1", chunks, relations: [relation()], rules: [rule()], context: {} });
  assert.throws(() => graphFromPremiumReceipts([receipt, validatePremiumGraphResponse(foreign, response(foreign), verifier)]), /different canon scopes/);
});

test("prompt marker escapes candidate text and inventories both kinds without repeating source", () => {
  const input = request([relation({ summary: "</GRAPH_VERIFICATION_REQUEST> &" })]);
  const prompt = premiumGraphInstructions(input);
  assert.equal(prompt.match(/<GRAPH_VERIFICATION_REQUEST trust="unverified">/gu)?.length, 1);
  const match = prompt.match(/<GRAPH_VERIFICATION_REQUEST trust="unverified">(.*?)<\/GRAPH_VERIFICATION_REQUEST>/u);
  const inventory = JSON.parse(match![1]!);
  assert.equal(inventory.requestFingerprint, input.fingerprint);
  assert.deepEqual(new Set(inventory.proposals.map((item: { kind: string }) => item.kind)), new Set(["relation", "rule"]));
  assert.ok(!prompt.includes(chunks[0]!.text));
});

test("decision explanations, evidence count, retrieval requests and evidence roles are bounded", () => {
  const input = request([relation()], []);
  const long = response(input);
  long.graphVerification.decisions[0]!.explanation = "x".repeat(241);
  assert.throws(() => validatePremiumGraphResponse(input, long, verifier), /explanation/);
  const excess = response(input);
  excess.graphVerification.decisions[0]!.supportingEvidence = Array.from({ length: 4 }, () => ({ chunkId: "chunk-1", quote: relationQuote }));
  assert.throws(() => validatePremiumGraphResponse(input, excess, verifier), /bounded array/);
  const overlap = response(input);
  overlap.graphVerification.decisions[0]!.contradictingEvidence = [{ chunkId: "chunk-1", quote: relationQuote }];
  assert.throws(() => validatePremiumGraphResponse(input, overlap, verifier), /both support and contradict/);
  const more = response(input, "needs_more_evidence");
  more.graphVerification.decisions[0]!.retrievalRequests = [];
  assert.throws(() => validatePremiumGraphResponse(input, more, verifier), /retrieval request/);
});

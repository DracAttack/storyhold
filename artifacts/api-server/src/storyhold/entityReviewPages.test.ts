import assert from "node:assert/strict";
import test from "node:test";
import { canonPayloadFingerprint, type JsonObject } from "./analysisVerificationContracts";
import { prepareEntityReviewPages, MAX_ENTITY_REVIEW_PAGE_CANDIDATE_BYTES } from "./entityReviewPages";
import { assertEntityGraphReviews, buildEntityGraphRequest, dossierGraphConflicts, entityGraphInstructions,
  projectEntityReviewedGraphs, validateEntityGraphReview } from "./entityGraphVerification";
import { graphFromPremiumReceipts, type PremiumGraphRequest, type PremiumGraphReviewReceipt } from "./premiumGraphVerification";
import type { EntityReviewFinding, EntityReviewInput } from "./entityReview";
import type { EntityRuleFinding } from "./worldAnalysis";

const quote = "The ward opens at dusk and consumes a silver charge.";
const secondQuote = "At dusk the ward drains another silver charge when opened.";
const verifier = { provider: "fixture", model: "page-model", completedAt: "2026-09-04T16:17:18.000Z" };
const hash = (value: unknown) => canonPayloadFingerprint(value as JsonObject);
function rule(index: number): EntityRuleFinding {
  return { entity: "Ward", name: `Rule ${index}`, description: "The ward consumes silver when opened.", ruleKind: "constraint", trigger: "at dusk", effect: "opens and consumes silver",
    confidence: 0.7, evidence: [{ chunkId: "c1", sourceId: "s1", quote }] };
}
function input(count = 25): EntityReviewInput {
  return { worldName: "Winter", worldGenre: "Fantasy", worldPremise: "A ward guards the city.", depth: "full",
    entity: { id: "ward", name: "Ward", entityType: "device", aliases: [], summary: "A silver-powered ward.", details: [], relationships: [] },
    knownEntities: [{ name: "Ward", entityType: "device", aliases: [] }],
    chunks: [{ id: "c1", sourceId: "s1", sourceTitle: "Winter", index: 0, content: `${quote} ${secondQuote}` }],
    premiumStatScope: { worldId: "world", editionId: "edition", analysisRunId: "review" },
    ownerCanonConstraints: [{ id: "owner", kind: "rule", instruction: "Preserve conditional limits." }],
    graphReview: { version: 2, relations: [], rules: Array.from({ length: count }, (_, index) => rule(index)),
      entities: [{ id: "ward", name: "Ward", entityType: "device", aliases: [] }] } };
}
function fields(verdict = "verified") {
  return { verdict, explanation: "This passage supports the complete rule.", confidence: 0.9,
    supportingEvidence: verdict === "verified" ? [{ chunkId: "c1", quote }] : [], contradictingEvidence: [],
    retrievalRequests: verdict === "needs_more_evidence" ? ["Find a passage about the ward's effect."] : [] };
}
function response(request: PremiumGraphRequest, verdict = "verified") {
  return { relations: [], rules: [], entityRelations: [], entityRules: [], graphVerification: { requestFingerprint: request.fingerprint,
    decisions: request.proposals.map((proposal) => ({ proposalId: proposal.id, ...fields(verdict) })), newFindings: [] as Array<Record<string, unknown>> } };
}
function receipts(params: EntityReviewInput): PremiumGraphReviewReceipt[] {
  return prepareEntityReviewPages(params).pages.map((page) => validateEntityGraphReview(page.input, response(buildEntityGraphRequest(page.input)!), verifier)!);
}
function finding(): EntityReviewFinding {
  return { aliases: [], summary: "", details: [], relationships: [], evidence: [], confidence: 0.9, estimatedStats: null, character: null, relations: [], rules: [] };
}

test("dense inventories deterministically partition every candidate into bounded ordered pages", () => {
  const params = input(); const before = structuredClone(params); const plan = prepareEntityReviewPages(params);
  assert.deepEqual(plan.pages.map((page) => page.candidateKeys.length), [12, 12, 1]);
  assert.deepEqual(plan.pages.map((page) => page.stepKey), ["dossier_graph:0", "dossier_graph:1", "dossier_graph:2"]);
  assert.ok(plan.pages.every((page, index) => page.index === index && page.count === 3));
  const keys = plan.pages.flatMap((page) => page.candidateKeys); assert.equal(new Set(keys).size, 25);
  assert.deepEqual(keys, [...keys].sort()); assert.deepEqual(plan, prepareEntityReviewPages(params)); assert.deepEqual(params, before);
  assert.match(entityGraphInstructions(plan.pages[0]!.input), /first provider call also supplies the dossier and both stat groups/);
  assert.match(entityGraphInstructions(plan.pages[1]!.input), /continuation is graph-only/);
  assert.throws(() => buildEntityGraphRequest(params), /derived page metadata/);
});

test("empty inventory retains one discovery-capable first page", () => {
  const params = input(0); const plan = prepareEntityReviewPages(params);
  assert.equal(plan.pages.length, 1); assert.deepEqual(plan.pages[0]!.candidateKeys, []);
  const request = buildEntityGraphRequest(plan.pages[0]!.input)!;
  const raw = response(request); const { evidence: _e, confidence: _c, ...payload } = rule(1);
  raw.graphVerification.newFindings.push({ kind: "rule", payload, ...fields() });
  const reviewed = validateEntityGraphReview(plan.pages[0]!.input, raw, verifier)!;
  assertEntityGraphReviews(params, [reviewed]); assert.equal(projectEntityReviewedGraphs(params, finding(), [reviewed]).rules.length, 1);
});

test("semantic duplicate deduplication retains distinct supporting passages and maximum proposal confidence", () => {
  const params = input(1); const duplicate = structuredClone(params.graphReview!.rules[0]!);
  duplicate.evidence = [{ chunkId: "c1", sourceId: "s1", quote: secondQuote }]; duplicate.confidence = 0.85;
  params.graphReview!.rules.push(duplicate);
  const plan = prepareEntityReviewPages(params); assert.equal(plan.pages[0]!.candidateKeys.length, 1);
  const request = buildEntityGraphRequest(plan.pages[0]!.input)!;
  assert.equal(request.proposals[0]!.confidence, 0.85);
  assert.deepEqual(new Set(request.evidence.map((anchor) => anchor.quote)), new Set([quote, secondQuote]));
  const reordered = structuredClone(params); reordered.graphReview!.rules.reverse();
  assert.deepEqual(prepareEntityReviewPages(reordered), plan);
});

test("all exact source, owner and candidate support changes alter the complete inventory fingerprint", () => {
  const params = input(13); const original = prepareEntityReviewPages(params);
  const mutations: Array<(value: EntityReviewInput) => void> = [
    (value) => { value.chunks[0]!.content += " A revised passage."; },
    (value) => { value.ownerCanonConstraints![0]!.instruction = "A different instruction."; },
    (value) => { value.graphReview!.rules[12]!.evidence = [{ chunkId: "c1", sourceId: "s1", quote: secondQuote }]; },
    (value) => { value.graphReview!.entities[0]!.aliases.push("Silver Ward"); },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(params); mutate(changed); const plan = prepareEntityReviewPages(changed);
    assert.notEqual(plan.fingerprint, original.fingerprint);
    assert.ok(plan.pages.every((page) => page.inventoryFingerprint !== original.pages[0]!.inventoryFingerprint));
  }
});

test("JSONB object key order does not change pages or their per-call fingerprints", () => {
  const params = input(13);
  const reordered = JSON.parse(JSON.stringify(params, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => right.localeCompare(left))) : value)) as EntityReviewInput;
  assert.deepEqual(prepareEntityReviewPages(reordered), prepareEntityReviewPages(params));
  assertEntityGraphReviews(reordered, receipts(params));
});

test("UTF-8 evidence byte bounds split pages before reaching the candidate-count limit", () => {
  const params = input(4);
  const quotes = Array.from({ length: 40 }, (_, index) => `${index} ${"界".repeat(195)}`);
  params.chunks[0]!.content = quotes.join("\n");
  for (const candidate of params.graphReview!.rules) candidate.evidence = quotes.map((text) => ({ chunkId: "c1", sourceId: "s1", quote: text }));
  const plan = prepareEntityReviewPages(params);
  assert.ok(plan.pages.length > 1);
  for (const page of plan.pages) {
    const graph = page.input.graphReview!;
    assert.ok(Buffer.byteLength(JSON.stringify({ relations: graph.relations, rules: graph.rules }), "utf8") <= MAX_ENTITY_REVIEW_PAGE_CANDIDATE_BYTES);
  }
  const tooLarge = input(1); tooLarge.chunks[0]!.content = Array.from({ length: 100 }, (_, index) => `${index} ${"界".repeat(400)}`).join("\n");
  tooLarge.graphReview!.rules[0]!.evidence = tooLarge.chunks[0]!.content.split("\n").map((text) => ({ chunkId: "c1", sourceId: "s1", quote: text }));
  assert.throws(() => prepareEntityReviewPages(tooLarge), /evidence cannot be truncated/);
});

test("partial, repeated, reordered and tampered pages cannot produce a complete graph", () => {
  const params = input(25); const complete = receipts(params); assertEntityGraphReviews(params, complete);
  assert.equal(projectEntityReviewedGraphs(params, finding(), complete).rules.length, 25);
  for (const invalid of [complete.slice(0, 2), [complete[0]!, complete[0]!, complete[2]!], [...complete].reverse()]) {
    assert.throws(() => assertEntityGraphReviews(params, invalid), /every frozen|different sources/);
    assert.throws(() => projectEntityReviewedGraphs(params, finding(), invalid), /every frozen|different sources/);
  }
  const plan = prepareEntityReviewPages(params); const page = structuredClone(plan.pages[0]!.input);
  page.graphReview!.page!.candidateKeys.pop(); assert.throws(() => buildEntityGraphRequest(page), /exact assigned/);
  assert.throws(() => prepareEntityReviewPages(plan.pages[0]!.input), /unpaged/);
});

test("continuation corrections are bounded, explicit and remain tied to their assigned candidate decisions", () => {
  const params = input(13); const plan = prepareEntityReviewPages(params);
  const reviewed = plan.pages.map((page) => {
    const request = buildEntityGraphRequest(page.input)!; const raw = response(request);
    if (page.index === 1) {
      raw.graphVerification.decisions[0] = { proposalId: request.proposals[0]!.id, ...fields("rejected") };
      raw.graphVerification.newFindings.push({ kind: "rule", payload: { ...request.proposals[0]!.payload, effect: "a corrected supported effect" }, ...fields() });
    }
    return validateEntityGraphReview(page.input, raw, verifier)!;
  });
  const projected = projectEntityReviewedGraphs(params, finding(), reviewed);
  assert.equal(projected.rules.length, 13); assert.ok(projected.rules.some((candidate) => candidate.effect === "a corrected supported effect"));
});

test("rediscovery on page zero never consumes a later page's required candidate decision", () => {
  const params = input(13); const plan = prepareEntityReviewPages(params); const later = buildEntityGraphRequest(plan.pages[1]!.input)!.proposals[0]!;
  const reviewed = plan.pages.map((page) => {
    const request = buildEntityGraphRequest(page.input)!; const raw = response(request);
    if (page.index === 0) raw.graphVerification.newFindings.push({ kind: later.kind, payload: later.payload, ...fields() });
    return validateEntityGraphReview(page.input, raw, verifier)!;
  });
  assert.throws(() => assertEntityGraphReviews(params, reviewed.slice(0, 1)), /every frozen/);
  assert.equal(projectEntityReviewedGraphs(params, finding(), reviewed).rules.length, 13);
  assert.equal(dossierGraphConflicts(reviewed).blockedPayloadFingerprints.size, 0);
});

test("cross-page verified versus any nonverified exact payload is withheld with an explicit conflict", () => {
  const params = input(13); const plan = prepareEntityReviewPages(params); const later = buildEntityGraphRequest(plan.pages[1]!.input)!.proposals[0]!;
  for (const verdict of ["rejected", "disputed", "insufficient_evidence", "needs_more_evidence"]) {
    const reviewed = plan.pages.map((page) => {
      const request = buildEntityGraphRequest(page.input)!; const raw = response(request, page.index === 1 ? verdict : "verified");
      if (page.index === 0) raw.graphVerification.newFindings.push({ kind: later.kind, payload: later.payload, ...fields() });
      return validateEntityGraphReview(page.input, raw, verifier)!;
    });
    const conflict = dossierGraphConflicts(reviewed);
    assert.ok(conflict.blockedPayloadFingerprints.has(hash(later.payload))); assert.equal(conflict.conflicts.length, 1);
    assert.match(conflict.conflicts[0]!.summary, /withheld/);
    assert.equal(projectEntityReviewedGraphs(params, finding(), reviewed).rules.length, 12);
  }
});

test("shared graph exclusions happen before competing rule selection and never modify receipts", () => {
  const params = input(0); const plan = prepareEntityReviewPages(params); const request = buildEntityGraphRequest(plan.pages[0]!.input)!;
  const raw = response(request); const { evidence: _e, confidence: _c, ...first } = rule(0);
  const second = { ...first, effect: "another supported effect" };
  raw.graphVerification.newFindings.push({ kind: "rule", payload: first, ...fields() }, { kind: "rule", payload: second, ...fields() });
  const reviewed = validateEntityGraphReview(plan.pages[0]!.input, raw, verifier)!; const before = structuredClone(reviewed);
  assert.equal(graphFromPremiumReceipts([reviewed]).entityRules.length, 0);
  const filtered = graphFromPremiumReceipts([reviewed], { excludedPayloadFingerprints: new Set([hash(first)]) });
  assert.equal(filtered.entityRules.length, 1); assert.equal(filtered.entityRules[0]!.effect, second.effect);
  assert.deepEqual(reviewed, before);
});

test("legacy version one still uses one original request and does not acquire page metadata", () => {
  const params = input(1); params.graphReview!.version = 1;
  const request = buildEntityGraphRequest(params)!; assert.equal(request.stepKey, "dossier_graph:0");
  assert.equal(JSON.parse(request.context.existingCanonContext).page, undefined);
  const reviewed = validateEntityGraphReview(params, response(request), verifier)!;
  assertEntityGraphReviews(params, [reviewed]); assert.equal(projectEntityReviewedGraphs(params, finding(), [reviewed]).rules.length, 1);
  assert.throws(() => prepareEntityReviewPages(params), /version-2/);
});

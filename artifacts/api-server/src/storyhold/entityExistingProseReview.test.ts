import assert from "node:assert/strict";
import test from "node:test";
import {
  assertEntityExistingProseReviews, buildExistingProseInventory, entityExistingProseInstructions,
  MAX_EXISTING_PROSE_PAGE_BYTES, MAX_EXISTING_PROSE_PAGES, prepareEntityExistingProsePages,
  validateEntityExistingProseReview, type EntityExistingProsePage, type EntityExistingProseReviewContext,
} from "./entityExistingProseReview";
import type { EntityReviewInput } from "./entityReview";

type Input = EntityReviewInput & { existingProseReview?: EntityExistingProseReviewContext };
const passage = "Dara believed Mira was dead until the spring reunion. Mira crossed the river. Mira was alive at the reunion.";
const verifier = { provider: "actual-provider", model: "actual-resolved-model", completedAt: "2026-09-08T12:00:00.000Z" };
function input(details = ["Dara believed Mira was dead until the spring reunion."]): Input {
  return {
    worldName: "Winter Watch", worldPremise: "A disputed death.", worldGenre: "Fantasy", depth: "full",
    entity: { id: "mira-id", name: "Mira", entityType: "character", aliases: [], summary: "", details, relationships: [] },
    knownEntities: [{ name: "Mira", entityType: "character", aliases: [] }],
    chunks: [{ id: "chunk-1", sourceId: "source-1", sourceTitle: "Winter", index: 0, content: passage }],
    premiumStatScope: { worldId: "world-1", editionId: "edition-1", analysisRunId: "review-1" },
    graphReview: { version: 2, relations: [], rules: [], entities: [{ id: "mira-id", name: "Mira", entityType: "character", aliases: [] }] },
    proseReview: { version: 1 }, existingProseReview: buildExistingProseInventory({ details }),
    userGuidance: "Keep the death uncertain.", ownerCanonConstraints: [{ id: "owner-1", kind: "canon", instruction: "A believed death is not an established death." }],
  };
}
function raw(page: EntityExistingProsePage, verdict = "supported") {
  return { existingProseVerification: { requestFingerprint: page.requestFingerprint, decisions: page.items.map((item) => ({
    itemId: item.itemId, verdict, explanation: "The passage establishes the belief with its time boundary, not a literal death.", confidence: 0.9,
    supportingEvidence: verdict === "supported" ? [{ chunkId: "chunk-1", quote: "Dara believed Mira was dead until the spring reunion." }] : [],
    contradictingEvidence: verdict === "contradicted" ? [{ chunkId: "chunk-1", quote: "Mira was alive at the reunion." }] : [],
    retrievalRequests: verdict === "needs_more_evidence" ? ["Find Mira's earlier whereabouts."] : [],
  })) } };
}

test("inventory preserves complete long summaries, original whitespace, duplicate slots and origin", () => {
  const summary = ` Rumor holds: ${"Mira was missing. ".repeat(310)}\nUntil spring, nobody knew. `;
  const result = buildExistingProseInventory({ aliases: ["Miri", "Miri"], summary, details: ["Same fact", "Same fact"] },
    { aliases: ["Miri"], summary, role: "Captain", profile: { traits: ["Protective"], history: [" Line one\nLine two "], secrets: ["Unknown fate"] } });
  assert.equal(result.items.filter((item) => item.field === "summary").length, 2);
  assert.equal(result.items.find((item) => item.field === "summary")!.text, summary);
  assert.deepEqual(result.items.filter((item) => item.origin === "entity" && item.field === "details").map((item) => item.index), [0, 1]);
  assert.equal(new Set(result.items.map((item) => item.itemId)).size, result.items.length);
  assert.equal(result.items.find((item) => item.field === "history")!.text, " Line one\nLine two ");
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.items));
  assert.ok(Object.isFrozen(result.items[0]));
});

test("plain relationship notes are audited without treating structured relationships, axis or stats as prose", () => {
  const inventory = buildExistingProseInventory({ relationships: ["Mira once trusted Dara."] }, { profile: {
    relationships: ["Dara believes Mira betrayed her."], relationshipWeb: [{ name: "Dara", relationship: "friend" }],
    estimatedStats: { strength: { score: 16 } }, socioPoliticalAxis: { label: "Unresolved" },
  } });
  assert.deepEqual(inventory.items.map(({ origin, field, text }) => ({ origin, field, text })), [
    { origin: "entity", field: "relationships", text: "Mira once trusted Dara." },
    { origin: "character", field: "relationships", text: "Dara believes Mira betrayed her." },
  ]);
  const params = input([]); params.existingProseReview = inventory;
  assert.equal(prepareEntityExistingProsePages(params)[0]!.items.length, 2);
});

test("pages cover every exact slot once with stable scope and JSONB-order-independent fingerprints", () => {
  const params = input(Array.from({ length: 23 }, (_, i) => `Stored detail ${i}`));
  const pages = prepareEntityExistingProsePages(params);
  assert.deepEqual(pages.map((page) => page.items.length), [10, 10, 3]);
  assert.deepEqual(pages.map((page) => page.stepKey), ["dossier_existing_prose:0", "dossier_existing_prose:1", "dossier_existing_prose:2"]);
  assert.deepEqual(pages.flatMap((page) => page.items), params.existingProseReview!.items);
  assert.equal(pages[0]!.scope.entityId, "mira-id"); assert.equal(pages[0]!.scope.reviewId, "review-1");
  const jsonb = JSON.parse(JSON.stringify(params), (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).reverse()) : value) as Input;
  assert.deepEqual(prepareEntityExistingProsePages(jsonb), pages);
  assert.ok(Object.isFrozen(pages)); assert.ok(Object.isFrozen(pages[0]!.items));
});

test("byte bounds split pages without splitting stored items and reject oversized text before dispatch", () => {
  const params = input(["第一件".repeat(3_500), "第二件".repeat(3_500), "第三件".repeat(3_500)]);
  const pages = prepareEntityExistingProsePages(params);
  assert.ok(pages.length >= 2);
  assert.deepEqual(pages.flatMap((page) => page.items), params.existingProseReview!.items);
  for (const page of pages) assert.ok(Buffer.byteLength(JSON.stringify({ items: page.items }), "utf8") <= MAX_EXISTING_PROSE_PAGE_BYTES);
  assert.throws(() => prepareEntityExistingProsePages(input(["A".repeat(MAX_EXISTING_PROSE_PAGE_BYTES)])), /cannot be clipped or split/);
  assert.throws(() => prepareEntityExistingProsePages(input(Array.from({ length: MAX_EXISTING_PROSE_PAGES * 10 + 1 }, (_, i) => `Fact ${i}`))), /safety bound/);
});

test("new audit flag requires modern parent input; legacy and empty inventory add no paid pages", () => {
  const legacy = input(); delete legacy.existingProseReview;
  assert.deepEqual(prepareEntityExistingProsePages(legacy), []);
  assertEntityExistingProseReviews(legacy, []);
  assert.deepEqual(prepareEntityExistingProsePages(input([])), []);
  const oldGraph = input(); oldGraph.graphReview!.version = 1;
  assert.throws(() => prepareEntityExistingProsePages(oldGraph), /modern, unpaged/);
  const oldProse = input(); delete oldProse.proseReview;
  assert.throws(() => prepareEntityExistingProsePages(oldProse), /modern, unpaged/);
  const child = input(); child.graphReview!.page = { index: 0, count: 1, stepKey: "dossier_graph:0", candidateKeys: [], inventoryFingerprint: "old" };
  assert.throws(() => prepareEntityExistingProsePages(child), /modern, unpaged/);
});

test("instructions expose only current page items, all passages and owner constraints without turning prose into facts", () => {
  const params = input(Array.from({ length: 11 }, (_, i) => `UniqueOldDetail-${i}-end`));
  const page = prepareEntityExistingProsePages(params)[0]!;
  const prompt = entityExistingProseInstructions(params, page);
  assert.match(prompt, /UniqueOldDetail-0-end/); assert.doesNotMatch(prompt, /UniqueOldDetail-10-end/);
  assert.ok(prompt.includes(passage)); assert.match(prompt, /A believed death is not an established death/);
  assert.match(prompt, /whole summary is ONE item/); assert.match(prompt, /does not change, delete, supersede or promote canon/);
  assert.match(prompt, /If any material clause lacks adequate evidence, choose needs_more_evidence/);
});

test("supported, contradicted and unresolved audits retain exact display text and source-bound actual verifier", () => {
  for (const verdict of ["supported", "contradicted", "needs_more_evidence"]) {
    const params = input(); const original = structuredClone(params); const page = prepareEntityExistingProsePages(params)[0]!;
    const receipt = validateEntityExistingProseReview(params, page, raw(page, verdict), verifier);
    assert.equal(receipt.decisions[0]!.verdict, verdict);
    assert.deepEqual(receipt.verifier, verifier); assert.deepEqual(params, original);
    assert.equal(receipt.page.items[0]!.text, original.existingProseReview!.items[0]!.text);
    const evidence = [...receipt.decisions[0]!.supportingEvidence, ...receipt.decisions[0]!.contradictingEvidence];
    if (evidence.length) assert.equal(evidence[0]!.sourceId, "source-1");
    assertEntityExistingProseReviews(params, [receipt]); assert.ok(Object.isFrozen(receipt));
    assert.deepEqual(Object.keys(receipt).sort(), ["version", "page", "decisions", "verifier", "fingerprint"].sort());
  }
});

test("missing, duplicate, foreign and extra-output decisions are rejected", () => {
  const params = input(["First item", "Second item"]); const page = prepareEntityExistingProsePages(params)[0]!;
  const validate = (value: unknown) => validateEntityExistingProseReview(params, page, value, verifier);
  const missing = raw(page); missing.existingProseVerification.decisions.pop(); assert.throws(() => validate(missing), /exactly one/);
  const duplicate = raw(page); duplicate.existingProseVerification.decisions[1]!.itemId = page.items[0]!.itemId; assert.throws(() => validate(duplicate), /duplicate or undeclared/);
  const foreign = raw(page); foreign.existingProseVerification.decisions[0]!.itemId = "other-entity-item"; assert.throws(() => validate(foreign), /duplicate or undeclared/);
  assert.throws(() => validate({ ...raw(page), summary: "A fabricated rewrite." }), /undeclared fields/);
  assert.throws(() => validate({ ...raw(page), claims: [] }), /undeclared fields/);
  const inventedVerdict = raw(page, "verified"); assert.throws(() => validate(inventedVerdict), /verdict/);
});

test("support and contradiction require their own exact manuscript quotes, not owner text or injected sources", () => {
  const params = input(); const page = prepareEntityExistingProsePages(params)[0]!;
  const validate = (value: unknown) => validateEntityExistingProseReview(params, page, value, verifier);
  const unsupported = raw(page); unsupported.existingProseVerification.decisions[0]!.supportingEvidence = [];
  assert.throws(() => validate(unsupported), /support quote/);
  const noContrary = raw(page, "contradicted"); noContrary.existingProseVerification.decisions[0]!.contradictingEvidence = [];
  assert.throws(() => validate(noContrary), /contrary manuscript quote/);
  const wrongText = raw(page); wrongText.existingProseVerification.decisions[0]!.supportingEvidence[0]!.quote = params.ownerCanonConstraints![0]!.instruction;
  assert.throws(() => validate(wrongText), /absent/);
  const wrongChunk = raw(page); wrongChunk.existingProseVerification.decisions[0]!.supportingEvidence[0]!.chunkId = "outside-chunk";
  assert.throws(() => validate(wrongChunk), /outside this frozen review/);
  const injectedSource = raw(page); Object.assign(injectedSource.existingProseVerification.decisions[0]!.supportingEvidence[0]!, { sourceId: "fake-source" });
  assert.throws(() => validate(injectedSource), /undeclared fields/);
  const normalizedQuote = raw(page); normalizedQuote.existingProseVerification.decisions[0]!.supportingEvidence[0]!.quote = "Dara believed\nMira was dead until the spring reunion.";
  assert.equal(validate(normalizedQuote).decisions[0]!.supportingEvidence[0]!.quote, "Dara believed Mira was dead until the spring reunion.");
});

test("confidence, quote and retrieval budgets fail safely rather than silently trimming", () => {
  const params = input(); const page = prepareEntityExistingProsePages(params)[0]!;
  const validate = (value: unknown) => validateEntityExistingProseReview(params, page, value, verifier);
  const oversized = raw(page); oversized.existingProseVerification.decisions[0]!.supportingEvidence[0]!.quote = "A".repeat(501);
  assert.throws(() => validate(oversized), /exceeds its bound/);
  const tooMany = raw(page); tooMany.existingProseVerification.decisions[0]!.supportingEvidence = Array(9).fill({ chunkId: "chunk-1", quote: "Mira" });
  assert.throws(() => validate(tooMany), /eight quotes/);
  const duplicates = raw(page); duplicates.existingProseVerification.decisions[0]!.supportingEvidence.push(...duplicates.existingProseVerification.decisions[0]!.supportingEvidence);
  assert.throws(() => validate(duplicates), /duplicate evidence/);
  const badConfidence = raw(page); badConfidence.existingProseVerification.decisions[0]!.confidence = NaN;
  assert.throws(() => validate(badConfidence), /confidence/);
  const tooManyRetrieval = raw(page, "needs_more_evidence"); tooManyRetrieval.existingProseVerification.decisions[0]!.retrievalRequests = Array(9).fill("Find context");
  assert.throws(() => validate(tooManyRetrieval), /bounded list/);
});

test("complete receipt coverage rejects missing/reordered pages and any changed scope, sources, owner guidance or slots", () => {
  const params = input(Array.from({ length: 12 }, (_, i) => `Stored detail ${i}`));
  const pages = prepareEntityExistingProsePages(params);
  const receipts = pages.map((page) => validateEntityExistingProseReview(params, page, raw(page, "needs_more_evidence"), verifier));
  assertEntityExistingProseReviews(params, receipts);
  assert.throws(() => assertEntityExistingProseReviews(params, receipts.slice(0, 1)), /incomplete/);
  assert.throws(() => assertEntityExistingProseReviews(params, [...receipts].reverse()), /another page/);
  for (const change of [
    (value: Input) => { value.premiumStatScope!.worldId = "different-world"; },
    (value: Input) => { value.premiumStatScope!.editionId = "different-edition"; },
    (value: Input) => { value.premiumStatScope!.analysisRunId = "different-review"; },
    (value: Input) => { value.chunks[0]!.sourceId = "different-source"; },
    (value: Input) => { value.chunks[0]!.content += " More context."; },
    (value: Input) => { value.ownerCanonConstraints![0]!.instruction += " Another constraint."; },
    (value: Input) => { value.userGuidance += " More guidance."; },
  ]) {
    const changed = structuredClone(params); change(changed);
    assert.throws(() => assertEntityExistingProseReviews(changed, receipts), /another page/);
  }
  const tampered = structuredClone(receipts); tampered[0]!.decisions[0]!.explanation = "Changed after completion.";
  assert.throws(() => assertEntityExistingProseReviews(params, tampered), /saved audit was changed/);
  const forgedSlot = structuredClone(params); forgedSlot.existingProseReview!.items[0]!.text = "Changed old canon";
  assert.throws(() => prepareEntityExistingProsePages(forgedSlot), /fingerprint/);
  const reordered = structuredClone(params); reordered.existingProseReview!.items.reverse();
  assert.throws(() => prepareEntityExistingProsePages(reordered), /original stable order/);
});

test("receipt evidence cannot change its source ID or reuse another page's request fingerprint", () => {
  const params = input(); const page = prepareEntityExistingProsePages(params)[0]!;
  const receipt = validateEntityExistingProseReview(params, page, raw(page), verifier);
  const wrongSource = structuredClone(receipt); wrongSource.decisions[0]!.supportingEvidence[0]!.sourceId = "different-source";
  assert.throws(() => assertEntityExistingProseReviews(params, [wrongSource]), /saved audit was changed/);
  const stale = raw(page); stale.existingProseVerification.requestFingerprint = "previous-request";
  assert.throws(() => validateEntityExistingProseReview(params, page, stale, verifier), /different frozen page/);
  const fakePage = structuredClone(page); fakePage.items[0]!.text = "Changed text";
  assert.throws(() => validateEntityExistingProseReview(params, fakePage, raw(fakePage), verifier), /does not match/);
});

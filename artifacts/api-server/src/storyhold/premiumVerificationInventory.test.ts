import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPremiumVerificationPages,
  buildCompletePremiumVerificationPages,
  buildPremiumVerificationPages,
  premiumVerificationPageOrdinaryFields,
  prepareCompletePremiumVerificationPages,
  proposalForPremiumVerificationPage,
} from "./premiumVerificationPages";
import type { CanonClaimFinding, WorldFindings } from "./worldAnalysis";

const ORDINARY_FIELDS = [
  "worldRules", "locations", "factions", "institutions", "governments", "powerStructures", "creatures",
  "species", "technologies", "vehicles", "devices", "weapons", "powers", "titles", "ambiguous",
  "chapterSummaries", "chronology", "openQuestions", "recurringTerms", "characters", "cohesionProposals",
] as const;
const CANDIDATE_FIELDS = [...ORDINARY_FIELDS, "claims", "entityRelations", "entityRules"] as const;

function empty(): WorldFindings {
  return {
    summary: "A complete chapter inventory.", genres: ["Science Fiction"], atmosphere: ["Uneasy"], themes: ["Identity"],
    worldRules: [], locations: [], factions: [], institutions: [], governments: [], powerStructures: [],
    creatures: [], species: [], technologies: [], vehicles: [], devices: [], weapons: [], powers: [],
    titles: [], ambiguous: [], chapterSummaries: [], chronology: [], openQuestions: [], recurringTerms: [],
    characters: [], entityRelations: [], entityRules: [], claims: [], cohesionProposals: [],
  };
}

function evidence(index: number) {
  return Array.from({ length: 9 }, (_, passage) => ({
    sourceId: "source-1", chunkId: `chunk-${passage}`,
    quote: `Evidence ${index}/${passage}: Écho 原典 🧬 <quoted>\nCafe\u0301 remains exactly as written.`,
  }));
}

function named(index: number, length = 20) {
  return { name: `Artifact ${index}`, summary: `${index}: ${"x".repeat(length)}`, confidence: 0.71, evidence: evidence(index) };
}

function claim(index: number): CanonClaimFinding {
  return {
    subject: `Artifact ${index}`, predicate: "stored_in", value: `Vault ${index}`,
    polarity: "positive", epistemicHolder: "", truthStatus: "fact", validFromLabel: "", validUntilLabel: "",
    confidence: 0.7, reviewStatus: "candidate", evidence: evidence(index),
  };
}

test("historical v2 inventories larger than 64k preserve every finding family across bounded pages", () => {
  const packet = empty();
  for (const field of CANDIDATE_FIELDS) {
    (packet as unknown as Record<string, unknown>)[field] = Array.from({ length: 3 }, (_, index) =>
      field === "openQuestions" || field === "recurringTerms" ? `${field}/${index}: ${"x".repeat(2_400)}` : named(index, 2_400));
  }
  assert.ok(JSON.stringify(packet).length > 64_000);
  const before = structuredClone(packet);
  const pages = buildCompletePremiumVerificationPages([packet], 2);
  const proposals = pages.map((page) => proposalForPremiumVerificationPage(packet, page));
  assert.equal(pages.flatMap((page) => page.candidateKeys).length, CANDIDATE_FIELDS.length * 3);
  for (const page of pages) {
    assert.equal(page.version, 2);
    assert.match(page.packetFingerprint, /^premium_inventory_[a-f0-9]{64}$/u);
    assert.ok(page.candidateKeys.length <= 6);
  }
  for (const proposal of proposals) assert.ok(JSON.stringify(proposal).length <= 64_000);
  for (const field of CANDIDATE_FIELDS) {
    assert.deepEqual(proposals.flatMap((proposal) => proposal[field] ?? []), packet[field], `${field} was preserved in order`);
  }
  assert.equal(proposals[0]!.summary, packet.summary);
  for (const proposal of proposals.slice(1)) {
    assert.equal(proposal.summary, "");
    assert.deepEqual(proposal.genres, []);
    assert.deepEqual(proposal.atmosphere, []);
    assert.deepEqual(proposal.themes, []);
  }
  assert.deepEqual(packet, before);
  assertPremiumVerificationPages(pages, 1);
});

test("ordinary entries have explicit membership and do not all leak onto the first page", () => {
  const packet = { ...empty(), claims: Array.from({ length: 6 }, (_, index) => claim(index)), locations: [named(0)] };
  const pages = buildCompletePremiumVerificationPages([packet]);
  assert.equal(pages.length, 2);
  assert.deepEqual(premiumVerificationPageOrdinaryFields(pages[0]!), []);
  assert.deepEqual(premiumVerificationPageOrdinaryFields(pages[1]!), ["locations"]);
  assert.deepEqual(proposalForPremiumVerificationPage(packet, pages[0]!).locations, []);
  assert.deepEqual(proposalForPremiumVerificationPage(packet, pages[1]!).locations, packet.locations);
});

test("size limits can make nonfinal pages smaller than six without dropping their entries", () => {
  const packet = { ...empty(), locations: Array.from({ length: 4 }, (_, index) => named(index, 33_000)) };
  const pages = buildCompletePremiumVerificationPages([packet]);
  assert.deepEqual(pages.map((page) => page.candidateKeys.length), [1, 1, 1, 1]);
  assertPremiumVerificationPages(pages, 1);
  assert.deepEqual(pages.flatMap((page) => proposalForPremiumVerificationPage(packet, page).locations), packet.locations);
});

test("large context is retained on a context-only first page when a candidate needs its own page", () => {
  const packet = { ...empty(), summary: "s".repeat(62_000), locations: [named(0, 8_000)] };
  const pages = buildCompletePremiumVerificationPages([packet]);
  assert.deepEqual(pages.map((page) => page.candidateKeys.length), [0, 1]);
  assertPremiumVerificationPages(pages, 1);
  const first = proposalForPremiumVerificationPage(packet, pages[0]!);
  const second = proposalForPremiumVerificationPage(packet, pages[1]!);
  assert.equal(first.summary, packet.summary);
  assert.deepEqual(first.locations, []);
  assert.equal(second.summary, "");
  assert.deepEqual(second.locations, packet.locations);
  assert.ok(JSON.stringify(first).length <= 64_000);
  assert.ok(JSON.stringify(second).length <= 64_000);
});

test("an oversized entry fails with its field before returning any usable page plan", () => {
  for (const field of CANDIDATE_FIELDS) {
    const packet = empty();
    (packet as unknown as Record<string, unknown>)[field] = [
      field === "openQuestions" || field === "recurringTerms" ? "x".repeat(64_001) : named(0, 64_001),
    ];
    assert.throws(() => buildCompletePremiumVerificationPages([empty(), packet]), new RegExp(`single ${field} candidate.*cannot be truncated`, "iu"));
  }
});

test("sizing includes the complete JSON envelope, not just a candidate's bare payload", () => {
  const packet = { ...empty(), openQuestions: ["x".repeat(63_800)] };
  assert.ok(JSON.stringify(packet.openQuestions[0]).length < 64_000);
  assert.ok(JSON.stringify(packet).length > 64_000);
  assert.throws(() => buildCompletePremiumVerificationPages([packet]), /single openQuestions candidate.*cannot fit/iu);
});

test("oversized summary or metadata fail explicitly rather than disappearing", () => {
  assert.throws(() => buildCompletePremiumVerificationPages([{ ...empty(), summary: "x".repeat(64_000) }]), /context metadata.*cannot be truncated/iu);
  assert.throws(() => buildCompletePremiumVerificationPages([{ ...empty(), themes: ["x".repeat(64_000)] }]), /context metadata.*cannot be truncated/iu);
});

test("only full exact duplicates within the same family collapse", () => {
  const original = named(0);
  const differentSupport = { ...structuredClone(original), evidence: evidence(1) };
  const differentConfidence = { ...structuredClone(original), confidence: 0.9 };
  const packet = {
    ...empty(),
    locations: [original, structuredClone(original), differentSupport, differentConfidence],
    worldRules: [structuredClone(original)],
    openQuestions: ["Who?", "Who?", "Who? "], recurringTerms: ["Who?"],
  };
  const pages = buildCompletePremiumVerificationPages([packet]);
  const proposals = pages.map((page) => proposalForPremiumVerificationPage(packet, page));
  assert.equal(pages.flatMap((page) => page.candidateKeys).length, 7);
  assert.deepEqual(proposals.flatMap((proposal) => proposal.locations), [original, differentSupport, differentConfidence]);
  assert.deepEqual(proposals.flatMap((proposal) => proposal.worldRules), [original]);
  assert.deepEqual(proposals.flatMap((proposal) => proposal.openQuestions), ["Who?", "Who? "]);
  assert.deepEqual(proposals.flatMap((proposal) => proposal.recurringTerms), ["Who?"]);
});

test("complete fingerprints bind the tail, metadata, evidence, and original ordering", () => {
  const packet = { ...empty(), locations: Array.from({ length: 20 }, (_, index) => named(index, 4_000)) };
  const pages = buildCompletePremiumVerificationPages([packet]);
  for (const mutate of [
    (changed: WorldFindings) => { changed.locations[19]!.summary += "changed tail"; },
    (changed: WorldFindings) => { changed.locations[19]!.evidence[8]!.quote += "changed ninth citation"; },
    (changed: WorldFindings) => { changed.themes.push("Another theme"); },
    (changed: WorldFindings) => { changed.locations.reverse(); },
  ]) {
    const changed = structuredClone(packet);
    mutate(changed);
    assert.throws(() => proposalForPremiumVerificationPage(changed, pages[0]!), /changed since.*frozen/iu);
  }
});

test("new plans remain deterministic across object-key order and independently mutable materializations", () => {
  const packet = { ...empty(), claims: [claim(0)], locations: [named(0)] };
  const reordered = Object.fromEntries(Object.entries(packet).reverse()) as WorldFindings;
  reordered.locations = packet.locations.map((entry) => Object.fromEntries(Object.entries(entry).reverse()) as typeof entry);
  const pages = buildCompletePremiumVerificationPages([packet]);
  assert.deepEqual(buildCompletePremiumVerificationPages([reordered]), pages);
  const result = proposalForPremiumVerificationPage(packet, pages[0]!);
  assert.deepEqual(result.locations, packet.locations);
  assert.equal(result.locations[0]!.evidence.length, 9);
  result.locations[0]!.evidence[8]!.quote = "Only this copy changed";
  result.genres.push("Only this copy changed");
  assert.deepEqual(proposalForPremiumVerificationPage(packet, pages[0]!).locations, packet.locations);
  assert.deepEqual(proposalForPremiumVerificationPage(packet, pages[0]!).genres, packet.genres);
});

test("candidate keys, assignment order, and size-based boundaries cannot be forged", () => {
  const packet = { ...empty(), locations: Array.from({ length: 3 }, (_, index) => named(index, 33_000)) };
  const pages = buildCompletePremiumVerificationPages([packet]);
  for (const mutate of [
    (page: typeof pages[number]) => { page.candidateKeys[0] = `finding:locations:${"a".repeat(64)}`; },
    (page: typeof pages[number]) => { page.candidateKeys = [...pages[1]!.candidateKeys]; },
    (page: typeof pages[number]) => { page.candidateKeys.push(pages[1]!.candidateKeys[0]!); },
    (page: typeof pages[number]) => { page.pageCount += 1; },
    (page: typeof pages[number]) => { page.candidateKeys = []; },
  ]) {
    const changed = structuredClone(pages[0]!);
    mutate(changed);
    assert.throws(() => proposalForPremiumVerificationPage(packet, changed), /keys or boundaries/iu);
  }
});

test("new page shape rejects unknown fields, illegal key families, and empty continuations", () => {
  const pages = buildCompletePremiumVerificationPages([{ ...empty(), locations: Array.from({ length: 7 }, (_, index) => named(index)) }]);
  for (const changed of [
    { ...pages[0], version: 1 }, { ...pages[0], extra: true },
    { ...pages[0], packetFingerprint: `premium_packet_${"a".repeat(64)}` },
    { ...pages[0], candidateKeys: [`finding:genres:${"a".repeat(64)}`] },
    { ...pages[0], candidateKeys: [`finding:claims:${"a".repeat(64)}`] },
    { ...pages[0], candidateKeys: [`finding:unknown:${"a".repeat(64)}`] },
    { ...pages[0], candidateKeys: [`finding:locations:${"a".repeat(63)}`] },
  ]) {
    assert.throws(() => assertPremiumVerificationPages([changed, pages[1]], 1), /Premium verification pages/iu);
  }
  assert.throws(() => assertPremiumVerificationPages([pages[0], { ...pages[1], candidateKeys: [] }], 1), /empty candidate page/iu);
});

test("legacy plans remain readable while mixing page versions in one frozen inventory is rejected", () => {
  const packet = { ...empty(), claims: Array.from({ length: 7 }, (_, index) => claim(index)), locations: [named(0)] };
  const legacy = buildPremiumVerificationPages([packet]);
  assert.equal(Object.hasOwn(legacy[0]!, "version"), false);
  assertPremiumVerificationPages(legacy, 1);
  assert.deepEqual(proposalForPremiumVerificationPage(packet, legacy[0]!).locations, packet.locations);
  assert.deepEqual(proposalForPremiumVerificationPage(packet, legacy[1]!).locations, []);
  assert.deepEqual(premiumVerificationPageOrdinaryFields(legacy[0]!), [...ORDINARY_FIELDS]);
  assert.deepEqual(premiumVerificationPageOrdinaryFields(legacy[1]!), []);
  const newPage = buildCompletePremiumVerificationPages([empty()])[0]!;
  const oldPage = buildPremiumVerificationPages([empty()])[0]!;
  assert.throws(() => assertPremiumVerificationPages([newPage, { ...oldPage, batchIndex: 1, stepKey: "verification:1" }], 2), /cannot mix inventory versions/iu);
  assert.throws(() => assertPremiumVerificationPages([oldPage, { ...newPage, batchIndex: 1, stepKey: "verification:1" }], 2), /cannot mix inventory versions/iu);
});

test("each source batch retains an independent complete page group and canonical global keys", () => {
  const packet = { ...empty(), locations: Array.from({ length: 7 }, (_, index) => named(index)) };
  const pages = buildCompletePremiumVerificationPages([packet, packet]);
  assert.deepEqual(pages.map((page) => page.stepKey), ["verification:0", "verification:1", "verification:2", "verification:3"]);
  assert.deepEqual(pages.map((page) => page.batchIndex), [0, 0, 1, 1]);
  assert.deepEqual(pages[0]!.candidateKeys, pages[2]!.candidateKeys);
  assertPremiumVerificationPages(pages, 2);
  const repeated = structuredClone(pages);
  repeated[1]!.candidateKeys = [pages[0]!.candidateKeys[0]!];
  assert.throws(() => assertPremiumVerificationPages(repeated, 2), /multiple pages/iu);
  assert.throws(() => assertPremiumVerificationPages(pages.slice(0, -1), 2), /omit part/iu);
});

test("empty inventory produces one context page, optional claims normalize safely, and zero batches produce none", () => {
  const packet = empty();
  delete packet.claims;
  const pages = buildCompletePremiumVerificationPages([packet]);
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0]!.candidateKeys, []);
  assert.equal(proposalForPremiumVerificationPage(packet, pages[0]!).summary, packet.summary);
  assert.deepEqual(proposalForPremiumVerificationPage(packet, pages[0]!).claims, []);
  assert.deepEqual(buildCompletePremiumVerificationPages([]), []);
  assertPremiumVerificationPages([], 0);
});

test("malformed complete inventories fail before a frozen plan can be created", () => {
  const circular = empty();
  circular.locations.push(circular as never);
  const malformed = [
    circular, { ...empty(), claims: [null] }, { ...empty(), locations: ["Not an object"] },
    { ...empty(), locations: [{ ...named(0), confidence: Infinity }] },
    { ...empty(), openQuestions: [null] }, { ...empty(), recurringTerms: [{}] },
    { ...empty(), themes: [{}] }, { ...empty(), locations: {} },
    { ...empty(), unknownFindings: [] }, { ...empty(), genres: [undefined] },
  ];
  for (const packet of malformed) {
    assert.throws(() => buildCompletePremiumVerificationPages([packet as unknown as WorldFindings]), /Premium verification pages/iu);
  }
});

test("prepared proposals match strict materialization without shared input or cross-page mutations", () => {
  const packet = { ...empty(), locations: Array.from({ length: 12 }, (_, index) => named(index, 8_000)) };
  const before = structuredClone(packet);
  const prepared = prepareCompletePremiumVerificationPages([packet, packet]);
  assert.deepEqual(prepared.pages, buildCompletePremiumVerificationPages([packet, packet]));
  assert.deepEqual(prepared.proposals, prepared.pages.map((page) => proposalForPremiumVerificationPage(packet, page)));
  prepared.proposals[0]!.locations[0]!.summary = "Changed only in this prepared copy.";
  prepared.proposals[0]!.locations[0]!.evidence[0]!.quote = "Changed only in this evidence copy.";
  assert.deepEqual(packet, before);
  const nextBatchIndex = prepared.pages.findIndex((page) => page.batchIndex === 1);
  assert.deepEqual(prepared.proposals[nextBatchIndex]!.locations[0], packet.locations[0]);
  assert.deepEqual(prepareCompletePremiumVerificationPages([packet, packet]).proposals[0]!.locations[0], packet.locations[0]);
});

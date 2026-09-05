import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPremiumVerificationPages,
  buildPremiumVerificationPages,
  PREMIUM_VERIFICATION_CANDIDATES_PER_PAGE,
  proposalForPremiumVerificationPage,
} from "./premiumVerificationPages";
import type { CanonClaimFinding, WorldFindings } from "./worldAnalysis";

function empty(): WorldFindings {
  return {
    summary: "Saved chapter-level synthesis.", genres: ["Science Fiction"], atmosphere: [], themes: [],
    worldRules: [], locations: [], factions: [], institutions: [], governments: [], powerStructures: [],
    creatures: [], species: [], technologies: [], vehicles: [], devices: [], weapons: [], powers: [],
    titles: [], ambiguous: [], chapterSummaries: [], chronology: [], openQuestions: [], recurringTerms: [],
    characters: [], entityRelations: [], entityRules: [], claims: [], cohesionProposals: [],
  };
}

function evidence(index: number) {
  return [{ sourceId: "source-1", chunkId: `chunk-${index}`, quote: `The vault contains Artifact ${index}.` }];
}

function claim(index: number): CanonClaimFinding {
  return {
    subject: `Artifact ${index}`, predicate: "stored_in", value: `Vault ${index}`,
    polarity: "positive", epistemicHolder: "", truthStatus: "fact", validFromLabel: "", validUntilLabel: "",
    confidence: 0.7, reviewStatus: "candidate", evidence: evidence(index),
  };
}

function dense(): WorldFindings {
  return {
    ...empty(),
    claims: Array.from({ length: 24 }, (_, index) => claim(index)),
    entityRelations: Array.from({ length: 24 }, (_, index) => ({
      subject: `Agent ${index}`, relationType: "member_of", target: `Guild ${index}`, status: "active",
      summary: `Agent ${index} joined Guild ${index}.`, validFromLabel: `Winter ${index}`, validUntilLabel: "",
      confidence: 0.63, reviewStatus: "candidate", evidence: evidence(index),
    })),
    entityRules: Array.from({ length: 12 }, (_, index) => ({
      entity: `Device ${index}`, name: `Lever ${index}`, ruleKind: "constraint", description: `A specific condition for Device ${index}.`,
      trigger: `Lever ${index} pulled`, effect: `Device ${index} opens`, confidence: 0.81,
      reviewStatus: "candidate", evidence: evidence(index),
    })),
  };
}

test("sixty selected typed candidates produce ten pages without altering payload, evidence, or confidence", () => {
  const packet = dense();
  const before = structuredClone(packet);
  const pages = buildPremiumVerificationPages([packet]);
  assert.equal(PREMIUM_VERIFICATION_CANDIDATES_PER_PAGE, 6);
  assert.equal(pages.length, 10);
  assert.ok(pages.every((page) => page.candidateKeys.length === 6));
  assert.equal(new Set(pages.flatMap((page) => page.candidateKeys)).size, 60);
  const proposals = pages.map((page) => proposalForPremiumVerificationPage(packet, page));
  assert.deepEqual(proposals.flatMap((proposal) => proposal.claims ?? []), packet.claims);
  assert.deepEqual(proposals.flatMap((proposal) => proposal.entityRelations), packet.entityRelations);
  assert.deepEqual(proposals.flatMap((proposal) => proposal.entityRules), packet.entityRules);
  assert.deepEqual(packet, before);
});

test("only page zero retains ordinary proposal fields and summaries", () => {
  const packet = dense();
  packet.openQuestions = ["Who opened the vault?"];
  packet.locations = [{ name: "The Vault", summary: "An underground archive.", confidence: 0.8, evidence: evidence(1) }];
  const proposals = buildPremiumVerificationPages([packet]).map((page) => proposalForPremiumVerificationPage(packet, page));
  assert.equal(proposals[0]!.summary, packet.summary);
  assert.deepEqual(proposals[0]!.locations, packet.locations);
  assert.deepEqual(proposals[0]!.openQuestions, packet.openQuestions);
  for (const proposal of proposals.slice(1)) {
    assert.equal(proposal.summary, "");
    for (const [key, value] of Object.entries(proposal)) {
      if (["summary", "claims", "entityRelations", "entityRules"].includes(key)) continue;
      assert.deepEqual(value, [], `${key} should not be synthesized again on later pages`);
    }
  }
});

test("page plans are deterministic across deep copies and JSON object key order", () => {
  const packet = dense();
  const reordered = Object.fromEntries(Object.entries(packet).reverse()) as WorldFindings;
  reordered.claims = packet.claims!.map((candidate) => Object.fromEntries(Object.entries(candidate).reverse()) as CanonClaimFinding);
  assert.deepEqual(buildPremiumVerificationPages([structuredClone(packet)]), buildPremiumVerificationPages([packet]));
  assert.deepEqual(buildPremiumVerificationPages([reordered]), buildPremiumVerificationPages([packet]));
});

test("only exact candidate duplicates collapse; different support and confidence remain separate", () => {
  const original = claim(0);
  const extraSupport = { ...structuredClone(original), evidence: [...evidence(0), ...evidence(1)] };
  const differentConfidence = { ...structuredClone(original), confidence: 0.9 };
  const packet = { ...empty(), claims: [original, structuredClone(original), extraSupport, differentConfidence] };
  const [page] = buildPremiumVerificationPages([packet]);
  assert.equal(page!.candidateKeys.length, 3);
  assert.deepEqual(proposalForPremiumVerificationPage(packet, page!).claims, [original, extraSupport, differentConfidence]);
});

test("identical candidates in separate source batches receive separate review pages", () => {
  const packet = { ...empty(), claims: [claim(0)] };
  const pages = buildPremiumVerificationPages([packet, structuredClone(packet)]);
  assert.equal(pages.length, 2);
  assert.equal(pages[0]!.candidateKeys[0], pages[1]!.candidateKeys[0]);
  assert.deepEqual(pages.map(({ stepKey, batchIndex, pageIndex, pageCount }) => ({ stepKey, batchIndex, pageIndex, pageCount })), [
    { stepKey: "verification:0", batchIndex: 0, pageIndex: 0, pageCount: 1 },
    { stepKey: "verification:1", batchIndex: 1, pageIndex: 0, pageCount: 1 },
  ]);
  assertPremiumVerificationPages(pages, 2);
});

test("empty selected packets still receive one source-review page, but zero source batches receive none", () => {
  const packet = empty();
  delete packet.claims;
  const pages = buildPremiumVerificationPages([packet]);
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0]!.candidateKeys, []);
  assert.equal(proposalForPremiumVerificationPage(packet, pages[0]!).summary, packet.summary);
  assert.deepEqual(buildPremiumVerificationPages([]), []);
  assertPremiumVerificationPages([], 0);
  assert.throws(() => assertPremiumVerificationPages([], 1), /omit part/iu);
});

test("changes to typed and ordinary packet fields invalidate frozen pages", () => {
  const packet = dense();
  const [page] = buildPremiumVerificationPages([packet]);
  for (const mutate of [
    (changed: WorldFindings) => { changed.summary += " A new source interpretation."; },
    (changed: WorldFindings) => { changed.claims![0]!.evidence[0]!.quote += " Different support."; },
    (changed: WorldFindings) => { changed.entityRelations[0]!.validUntilLabel = "Winter 3"; },
    (changed: WorldFindings) => { changed.entityRules[0]!.trigger = "A different trigger"; },
    (changed: WorldFindings) => { changed.claims!.reverse(); },
  ]) {
    const changed = structuredClone(packet);
    mutate(changed);
    assert.throws(() => proposalForPremiumVerificationPage(changed, page!), /changed since.*frozen/iu);
  }
});

test("unknown, repeated, reordered, and shifted candidate boundaries cannot materialize", () => {
  const packet = dense();
  const pages = buildPremiumVerificationPages([packet]);
  const unknown = structuredClone(pages[0]!);
  unknown.candidateKeys[0] = `claim:${"a".repeat(64)}`;
  assert.throws(() => proposalForPremiumVerificationPage(packet, unknown), /keys or boundaries/iu);
  const repeated = structuredClone(pages[0]!);
  repeated.candidateKeys[1] = repeated.candidateKeys[0]!;
  assert.throws(() => proposalForPremiumVerificationPage(packet, repeated), /repeats/iu);
  const reordered = structuredClone(pages[0]!);
  reordered.candidateKeys.reverse();
  assert.throws(() => proposalForPremiumVerificationPage(packet, reordered), /keys or boundaries/iu);
  const shifted = structuredClone(pages[0]!);
  shifted.candidateKeys[5] = pages[1]!.candidateKeys[0]!;
  assert.throws(() => proposalForPremiumVerificationPage(packet, shifted), /keys or boundaries/iu);
});

test("persisted structure rejects nonsequential, incomplete, duplicated, and inconsistent page groups", () => {
  const pages = buildPremiumVerificationPages([dense(), empty()]);
  for (const mutate of [
    (changed: typeof pages) => { changed[0]!.stepKey = "verification:01"; },
    (changed: typeof pages) => { changed[1]!.stepKey = "verification:0"; },
    (changed: typeof pages) => { changed[1]!.pageIndex = 2; },
    (changed: typeof pages) => { changed[1]!.pageCount = 11; },
    (changed: typeof pages) => { changed[1]!.batchIndex = 1; },
    (changed: typeof pages) => { changed[1]!.packetFingerprint = `premium_packet_${"f".repeat(64)}`; },
    (changed: typeof pages) => { changed[1]!.candidateKeys[0] = changed[0]!.candidateKeys[0]!; },
    (changed: typeof pages) => { changed[0]!.candidateKeys.pop(); },
    (changed: typeof pages) => { changed.pop(); },
    (changed: typeof pages) => { changed[0]!.candidateKeys = []; },
  ]) {
    const changed = structuredClone(pages);
    mutate(changed);
    assert.throws(() => assertPremiumVerificationPages(changed, 2), /Premium verification pages/iu);
  }
});

test("page shape rejects malformed fields and nonfinite counts", () => {
  const [page] = buildPremiumVerificationPages([empty()]);
  for (const bad of [null, {}, { ...page, extra: true }, { ...page, pageCount: NaN },
    { ...page, batchIndex: -1 }, { ...page, packetFingerprint: "fake" },
    { ...page, candidateKeys: ["unknown:1"] }, { ...page, candidateKeys: Array(7).fill(`claim:${"a".repeat(64)}`) }]) {
    assert.throws(() => assertPremiumVerificationPages([bad], 1), /Premium verification pages/iu);
  }
  assert.throws(() => assertPremiumVerificationPages([page], Infinity), /source batch count/iu);
  assert.throws(() => assertPremiumVerificationPages({}, 1), /must be an array/iu);
});

test("oversize candidates or packets fail explicitly and never return truncated pages", () => {
  const packet = { ...empty(), claims: [{ ...claim(0), value: "x".repeat(64_001) }] };
  assert.throws(() => buildPremiumVerificationPages([packet]), /single claim candidate.*cannot be truncated/iu);
  const largeOrdinaryPacket = { ...empty(), summary: "x".repeat(64_001) };
  assert.throws(() => buildPremiumVerificationPages([largeOrdinaryPacket]), /selected packet exceeds/iu);
});

test("unicode, literal markup, newlines, and independently mutable snapshots remain intact", () => {
  const packet = { ...empty(), claims: [{ ...claim(0), value: "Écho 原典 🧬 <quoted>\nCafe\u0301", evidence: [
    { chunkId: "unicode", sourceId: "source-1", quote: "Écho 原典 🧬 <quoted>\nCafe\u0301" },
  ] }] };
  const pages = buildPremiumVerificationPages([packet]);
  const first = proposalForPremiumVerificationPage(packet, pages[0]!);
  assert.deepEqual(first.claims, packet.claims);
  first.claims![0]!.value = "Changed only in returned proposal.";
  first.genres.push("Changed genre");
  const second = proposalForPremiumVerificationPage(packet, pages[0]!);
  assert.deepEqual(second.claims, packet.claims);
  assert.deepEqual(second.genres, packet.genres);
  assert.notDeepEqual(first.claims, second.claims);
});

test("malformed selected data does not acquire a seemingly valid page plan", () => {
  const circular = empty();
  circular.openQuestions.push(circular as unknown as string);
  const nonfinite = { ...empty(), claims: [{ ...claim(0), confidence: Infinity }] };
  const nullCandidate = { ...empty(), claims: [null] } as unknown as WorldFindings;
  const wrongArray = { ...empty(), entityRules: {} } as unknown as WorldFindings;
  for (const packet of [circular, nonfinite, nullCandidate, wrongArray]) {
    assert.throws(() => buildPremiumVerificationPages([packet]), /Premium verification pages/iu);
  }
});

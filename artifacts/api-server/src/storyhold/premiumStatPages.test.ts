import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPremiumVerificationPages,
  buildCompletePremiumVerificationPages,
  buildPremiumVerificationPages,
  prepareCompletePremiumVerificationPages,
  premiumVerificationPageOrdinaryFields,
  proposalForPremiumVerificationPage,
} from "./premiumVerificationPages";
import { PREMIUM_STAT_NAMES, premiumStatCandidates } from "./premiumStatCandidates";
import type { CharacterFinding, EvidenceReference, NamedFinding, WorldFindings } from "./worldAnalysis";

function empty(): WorldFindings {
  return {
    summary: "The chapter concerns the expedition.", genres: ["Science Fiction"], atmosphere: [], themes: [],
    worldRules: [], locations: [], factions: [], institutions: [], governments: [], powerStructures: [],
    creatures: [], species: [], technologies: [], vehicles: [], devices: [], weapons: [], powers: [],
    titles: [], ambiguous: [], chapterSummaries: [], chronology: [], openQuestions: [], recurringTerms: [],
    characters: [], entityRelations: [], entityRules: [], claims: [], cohesionProposals: [],
  };
}
const evidence: EvidenceReference[] = [{
  sourceId: "source-1", chunkId: "chunk-1", quote: "Captain Gray lifted the jammed hatch.",
  sectionTitle: "The Hatch", perspective: "Captain Gray",
}];
function estimate(index = 0) {
  return { score: 12 + index, confidence: 0.74, rationale: `An observed ability ${index}.`, evidence: structuredClone(evidence) };
}
function character(): CharacterFinding {
  return {
    name: "Captain Gray", aliases: ["Addison"], role: "Captain", summary: "A protective and resourceful captain.",
    traits: ["Protective"], motivations: [], fears: [], capabilities: [], history: [], origins: [], powers: [],
    moralSystem: [], physicalCharacteristics: [], relationships: [], relationshipWeb: [],
    estimatedStats: Object.fromEntries(PREMIUM_STAT_NAMES.map((stat, index) => [stat, estimate(index)])) as CharacterFinding["estimatedStats"],
    socioPoliticalAxis: { economic: 0, authority: 0, label: "Undetermined", rationale: "", confidence: 0 },
    knowledge: [], secrets: [], factionMemberships: [], evidence: structuredClone(evidence), confidence: 0.8,
  };
}
function withCharacter(): WorldFindings { return { ...empty(), characters: [character()] }; }

test("meaningful stat estimates each occupy one of six page slots before the ordinary dossier", () => {
  const packet = withCharacter();
  const before = structuredClone(packet);
  const { pages, proposals } = prepareCompletePremiumVerificationPages([packet]);
  assert.equal(pages.length, 2);
  assert.ok(pages.every((page) => page.version === 3 && page.packetFingerprint.startsWith("premium_stat_inventory_")));
  assert.equal(pages[0]!.candidateKeys.length, 6);
  assert.ok(pages[0]!.candidateKeys.every((key) => key.startsWith("stat:")));
  assert.equal(pages[1]!.candidateKeys.length, 2);
  assert.match(pages[1]!.candidateKeys[0]!, /^stat:/u);
  assert.match(pages[1]!.candidateKeys[1]!, /^finding:characters:/u);
  assert.equal(proposals.flatMap((proposal) => premiumStatCandidates(proposal)).length, 7);
  assert.deepEqual(packet, before);
  assert.deepEqual(premiumVerificationPageOrdinaryFields(pages[0]!), []);
  assert.deepEqual(premiumVerificationPageOrdinaryFields(pages[1]!), ["characters"]);
});

test("stat wrappers preserve exact payload and source metadata without leaking unrelated dossier prose", () => {
  const packet = withCharacter();
  packet.characters[0]!.estimatedStats.strength.rationale = "She  demonstrated strength.\nNot invulnerability.";
  const { pages, proposals } = prepareCompletePremiumVerificationPages([packet]);
  const wrapper = proposals[0]!.characters[0]!;
  assert.equal(wrapper.name, "Captain Gray");
  assert.deepEqual(wrapper.estimatedStats, { strength: packet.characters[0]!.estimatedStats.strength });
  assert.deepEqual(wrapper.evidence, evidence);
  assert.equal(wrapper.summary, "");
  assert.equal(wrapper.role, "");
  assert.deepEqual(wrapper.aliases, []);
  assert.deepEqual(wrapper.traits, []);
  assert.deepEqual(wrapper.relationshipWeb, []);
  const ordinary = proposals[1]!.characters.find((item) => item.summary.length > 0)!;
  assert.equal(ordinary.estimatedStats, undefined);
  assert.equal(ordinary.summary, packet.characters[0]!.summary);
  pages.forEach((page, index) => assert.deepEqual(proposalForPremiumVerificationPage(packet, page), proposals[index]));
});

test("typed claims, graph candidates, stats, and ordinary findings share the same page budget", () => {
  const packet = withCharacter();
  packet.claims = [{ subject: "Gray", predicate: "leads", value: "Expedition", epistemicHolder: "", truthStatus: "fact", validFromLabel: "", validUntilLabel: "", evidence, confidence: 0.8 }];
  packet.entityRelations = [{ subject: "Gray", relationType: "leads", target: "Expedition", status: "active", summary: "Gray leads.", validFromLabel: "", validUntilLabel: "", evidence, confidence: 0.8 }];
  packet.entityRules = [{ entity: "Hatch", name: "Jammed", description: "The hatch requires force.", ruleKind: "constraint", trigger: "Lifting", effect: "Opening", evidence, confidence: 0.8 }];
  const pages = buildCompletePremiumVerificationPages([packet]);
  assert.deepEqual(pages.map((page) => page.candidateKeys.length), [6, 5]);
  assert.deepEqual(pages[0]!.candidateKeys.map((key) => key.split(":")[0]), ["claim", "relation", "rule", "stat", "stat", "stat"]);
});

test("neutral unknown defaults do not create seven pretend ability findings", () => {
  const packet = withCharacter();
  for (const stat of PREMIUM_STAT_NAMES) packet.characters[0]!.estimatedStats[stat] = {
    score: 10, confidence: 0.1, rationale: "Neutral estimate pending stronger source evidence.", evidence: [],
  };
  const { pages, proposals } = prepareCompletePremiumVerificationPages([packet]);
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.candidateKeys.length, 1);
  assert.match(pages[0]!.candidateKeys[0]!, /^finding:characters:/u);
  assert.equal(proposals[0]!.characters[0]!.estimatedStats, undefined);
});

test("an evidenced ordinary score of ten is still a meaningful estimate", () => {
  const packet = empty();
  packet.creatures = [{ name: "The Sentinel", summary: "A sentry organism.", evidence,
    estimatedStats: { strength: { ...estimate(), score: 10 } } as CharacterFinding["estimatedStats"] }];
  const { pages, proposals } = prepareCompletePremiumVerificationPages([packet]);
  assert.deepEqual(pages[0]!.candidateKeys.map((key) => key.split(":")[0]), ["stat", "finding"]);
  assert.deepEqual(proposals[0]!.creatures[0]!.estimatedStats, packet.creatures[0]!.estimatedStats);
  assert.equal(proposals[0]!.creatures[1]!.estimatedStats, undefined);
});

test("every named-finding family can carry independent stat estimates", () => {
  const packet = empty();
  const families = ["worldRules", "locations", "factions", "institutions", "governments", "powerStructures", "creatures", "species", "technologies", "vehicles", "devices", "weapons", "powers", "titles", "ambiguous"] as const;
  for (const family of families) packet[family] = [{ name: `Subject ${family}`, summary: family, evidence,
    estimatedStats: { strength: estimate() } as CharacterFinding["estimatedStats"] }];
  const { pages, proposals } = prepareCompletePremiumVerificationPages([packet]);
  assert.equal(pages.flatMap((page) => page.candidateKeys).filter((key) => key.startsWith("stat:")).length, families.length);
  assert.deepEqual(new Set(proposals.flatMap((proposal) => premiumStatCandidates(proposal)).map((candidate) => candidate.family)), new Set(families));
  assert.ok(pages.every((page) => page.candidateKeys.length <= 6));
});

test("chronology and chapter records are not statistical subjects", () => {
  const packet = empty();
  packet.chronology = [{ name: "The Hatch Opens", summary: "The hatch opens.", evidence,
    estimatedStats: { strength: estimate() } as CharacterFinding["estimatedStats"] }];
  const { pages, proposals } = prepareCompletePremiumVerificationPages([packet]);
  assert.deepEqual(pages[0]!.candidateKeys.map((key) => key.split(":")[0]), ["finding"]);
  assert.equal(proposals[0]!.chronology[0]!.estimatedStats, undefined);
});

test("different evidence or confidence remains independently assigned and exactly bound", () => {
  const packet = empty();
  const first: NamedFinding = { name: "Sentinel", summary: "A sentry.", evidence, estimatedStats: { strength: estimate() } as CharacterFinding["estimatedStats"] };
  const second = structuredClone(first);
  second.estimatedStats!.strength.confidence = 0.91;
  const third = structuredClone(first);
  third.estimatedStats!.strength.evidence[0]!.perspective = "Engineer";
  packet.creatures = [first, structuredClone(first), second, third];
  const pages = buildCompletePremiumVerificationPages([packet]);
  const keys = pages.flatMap((page) => page.candidateKeys).filter((key) => key.startsWith("stat:"));
  assert.equal(keys.length, 3);
  assert.equal(new Set(keys).size, 3);
  const changed = structuredClone(packet);
  changed.creatures[0]!.estimatedStats!.strength.evidence[0]!.perspective = "Observer";
  assert.throws(() => proposalForPremiumVerificationPage(changed, pages[0]!), /inventory has changed/u);
});

test("frozen stat inventory rejects key, boundary, fingerprint, and version tampering", () => {
  const packet = withCharacter();
  const pages = buildCompletePremiumVerificationPages([packet]);
  assert.throws(() => proposalForPremiumVerificationPage(packet, { ...pages[0]!, candidateKeys: pages[0]!.candidateKeys.slice(1) }), /keys or boundaries/u);
  assert.throws(() => proposalForPremiumVerificationPage(packet, { ...pages[0]!, version: 2 }), /fingerprint/u);
  assert.throws(() => proposalForPremiumVerificationPage(packet, { ...pages[0]!, pageCount: 3 }), /keys or boundaries/u);
  const legacyPages = buildCompletePremiumVerificationPages([empty()], 2);
  assert.throws(() => assertPremiumVerificationPages([pages[0]!, { ...legacyPages[0]!, stepKey: "verification:1", batchIndex: 1 }], 2), /mix inventory versions/u);
  assert.throws(() => assertPremiumVerificationPages([{ ...legacyPages[0]!, candidateKeys: [pages[0]!.candidateKeys[0]!] }], 1), /candidate keys/u);
});

test("historical v2 and legacy selected-packet materialization retain their original nested stats", () => {
  const packet = withCharacter();
  const v2 = buildCompletePremiumVerificationPages([packet], 2);
  assert.equal(v2[0]!.version, 2);
  assert.equal(v2[0]!.candidateKeys.length, 1);
  assert.deepEqual(proposalForPremiumVerificationPage(packet, v2[0]!).characters, packet.characters);
  const legacy = buildPremiumVerificationPages([packet]);
  assert.equal(legacy[0]!.version, undefined);
  assert.deepEqual(proposalForPremiumVerificationPage(packet, legacy[0]!).characters, packet.characters);
});

test("oversized individual statistical evidence fails explicitly instead of being truncated", () => {
  const packet = empty();
  packet.creatures = [{ name: "Sentinel", summary: "A sentry.", evidence: [], estimatedStats: {
    strength: { ...estimate(), evidence: [{ sourceId: "source-1", chunkId: "chunk-1", quote: "x".repeat(65_000) }] },
  } as CharacterFinding["estimatedStats"] }];
  assert.throws(() => buildCompletePremiumVerificationPages([packet]), /single creatures candidate.*cannot be truncated/u);
});

test("stat inventories and prepared pages remain stable through JSON key-order changes", () => {
  const packet = withCharacter();
  const reordered = Object.fromEntries(Object.entries(packet).reverse()) as WorldFindings;
  reordered.characters = packet.characters.map((entry) => Object.fromEntries(Object.entries(entry).reverse()) as CharacterFinding);
  assert.deepEqual(prepareCompletePremiumVerificationPages([packet]), prepareCompletePremiumVerificationPages([reordered]));
});

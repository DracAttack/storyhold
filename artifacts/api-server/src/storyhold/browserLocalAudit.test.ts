import assert from "node:assert/strict";
import test from "node:test";
import {
  browserAuditCandidates,
  browserAuditReservedUsage,
  generatedEntityPresentationIsUseful,
  generatedEntityAliasPair,
  generatedAliasIsCustomerVisible,
  explicitCharacterAliasPair,
  explicitAbbreviationAliasPair,
  evidenceBasedEntityCategory,
  generatedCharacterAliasIsUseful,
  genericCasingFalsePositive,
  localQwenAuditClassificationPrompt,
  packBrowserAuditCandidates,
  preferredGeneratedCharacterLabel,
  strongConceptConsensus,
} from "./browserLocalAudit";
import { browserQwenUsageCredits } from "./canonIntakePricing";
import type { WorldFindings } from "./worldAnalysis";

const evidence = [{
  chunkId: "11111111-1111-4111-8111-111111111111",
  sourceId: "22222222-2222-4222-8222-222222222222",
  quote: "Sanctuary stood beyond the ridge.",
}];

function findings(): WorldFindings {
  return {
    summary: "",
    genres: [],
    atmosphere: [],
    themes: [],
    worldRules: [],
    locations: [{ name: "Sanctuary", summary: "A town.", evidence }],
    factions: [],
    institutions: [],
    governments: [],
    powerStructures: [],
    creatures: [],
    species: [],
    technologies: [],
    vehicles: [],
    devices: [],
    weapons: [],
    powers: [],
    titles: [],
    ambiguous: [{ name: "Unsupported", summary: "No citation.", evidence: [] }],
    chapterSummaries: [],
    chronology: [{
      name: "The town is founded",
      summary: "Sanctuary is founded.",
      evidence,
      actors: ["Alec"],
    }],
    openQuestions: [],
    recurringTerms: [],
    characters: [],
    entityRelations: [{
      subject: "Alec",
      relationType: "located_in",
      target: "Sanctuary",
      status: "active",
      summary: "Alec lives in Sanctuary.",
      validFromLabel: "",
      validUntilLabel: "",
      evidence,
      confidence: 0.9,
    }],
    entityRules: [],
    claims: [],
    cohesionProposals: [],
  };
}

test("browser audit inventories every evidence-grounded proposal and omits unsupported noise", () => {
  const candidates = browserAuditCandidates(findings());
  assert.equal(candidates.length, 3);
  assert.deepEqual(candidates.map((candidate) => candidate.kind), [
    "concept", "relationship", "event",
  ]);
  assert.equal(new Set(candidates.map((candidate) => candidate.candidateKey)).size, 3);
  assert.equal(candidates.some((candidate) => candidate.name === "Unsupported"), false);
});

test("browser audit batching never silently truncates a large inventory", () => {
  const base = browserAuditCandidates(findings())[0];
  const candidates = Array.from({ length: 137 }, (_, index) => ({
    ...base,
    candidateKey: `${base.candidateKey}-${index}`,
    name: `Concept ${index}`,
  }));
  const batches = packBrowserAuditCandidates(candidates, 9, 8_000);
  assert.equal(batches.flat().length, 137);
  assert.equal(batches.every((batch) => batch.length <= 9), true);
  assert.deepEqual(
    batches.flat().map((candidate) => candidate.candidateKey),
    candidates.map((candidate) => candidate.candidateKey),
  );
});

test("local Qwen classifier examples are world neutral", () => {
  const prompt = localQwenAuditClassificationPrompt({
    candidateKey: "neutral:character:iona",
    kind: "character",
    category: "character",
    name: "Iona",
    summary: "A named traveler.",
    aliases: [],
    evidence: [{
      chunkId: "neutral-chunk",
      sourceId: "neutral-source",
      quote: "Iona entered Glass Harbor.",
    }],
  });

  assert.match(prompt, /place Glass Harbor \| "Iona entered Glass Harbor\." => valid/u);
  assert.match(prompt, /creature the Emberkin[\s\S]+=> valid/u);
  assert.doesNotMatch(prompt, /\b(?:Sanctuary|Alec|Turned)\b/u);
});

test("browser Qwen reserves from the complete compact audit workload", () => {
  const candidates = browserAuditCandidates(findings());
  const batches = packBrowserAuditCandidates(candidates, 2, 8_000);
  const usage = browserAuditReservedUsage(batches);
  assert.equal(batches.length, 2);
  assert.ok(usage.inputTokens > 0);
  assert.equal(usage.outputTokens, 480);
  assert.ok(browserQwenUsageCredits(usage) > 0);
});

test("generated character display names prefer formal or frequent durable surfaces", () => {
  assert.equal(preferredGeneratedCharacterLabel({
    name: "Little Alec",
    aliases: ["Sir Alec", "Alec"],
    literalMentionCounts: new Map([["little alec", 1], ["sir alec", 1], ["alec", 162]]),
  }), "Alec");
  assert.equal(preferredGeneratedCharacterLabel({
    name: "Kendall Kendall",
    aliases: ["Kendall"],
    literalMentionCounts: new Map([["kendall kendall", 1], ["kendall", 75]]),
  }), "Kendall");
  assert.equal(preferredGeneratedCharacterLabel({
    name: "Alec",
    aliases: ["Alec Sumner"],
    literalMentionCounts: new Map([["alec", 162], ["alec sumner", 5]]),
  }), "Alec Sumner");
  assert.equal(preferredGeneratedCharacterLabel({
    name: "Kelp",
    aliases: ["Father Kelp"],
    literalMentionCounts: new Map([["kelp", 0], ["father kelp", 3]]),
  }), "Father Kelp");
});

test("generic casing gate rejects sentence-initial nouns without rejecting proper names", () => {
  assert.equal(genericCasingFalsePositive({
    name: "Body",
    aliases: [],
    literalSurfaceCounts: [{ surface: "Body", count: 2 }, { surface: "body", count: 121 }],
  }), true);
  assert.equal(genericCasingFalsePositive({
    name: "James",
    aliases: [],
    literalSurfaceCounts: [{ surface: "James", count: 162 }],
  }), false);
  assert.equal(genericCasingFalsePositive({
    name: "Thrall",
    aliases: ["The Thrall"],
    literalSurfaceCounts: [{ surface: "Thrall", count: 2 }, { surface: "thrall", count: 30 }],
  }), false);
});

test("customer-facing local cards require durable names in name-dependent categories", () => {
  for (const [name, entityType] of [
    ["room", "place"], ["the cabin", "place"], ["hunting group", "faction"],
    ["chair", "device"], ["weapon", "weapon"], ["voice", "power"],
    ["alien weapon", "ambiguous"], ["My Mossberg", "weapon"],
    ["Jesus fucking Christ", "character"], ["Mr. Aldrin", "title"],
    ["Wife", "ambiguous"], ["Bullets", "weapon"],
  ]) {
    assert.equal(generatedEntityPresentationIsUseful({ name, entityType }), false, `${entityType}: ${name}`);
  }
  assert.equal(generatedEntityPresentationIsUseful({
    name: "Belly of The Beast",
    entityType: "creature",
    evidenceQuotes: ["Chapter 11 - Belly of The Beast (Alec - Past)"],
  }), false);
  for (const [name, entityType] of [
    ["Sanctuary", "place"], ["The Hive", "government"], ["Mossberg", "device"],
    ["GA-18", "place"], ["Visharath", "species"], ["deep cycle batteries", "technology"],
  ]) {
    assert.equal(generatedEntityPresentationIsUseful({ name, entityType }), true, `${entityType}: ${name}`);
  }
});

test("strong cross-pass evidence resolves category conflicts while close calls stay open", () => {
  const base = browserAuditCandidates(findings())[0]!;
  const consensus = strongConceptConsensus([
    { ...base, candidateKey: "macon-place", name: "Macon", category: "place", evidence: [...evidence, ...evidence, ...evidence] },
    { ...base, candidateKey: "macon-government", name: "Macon", category: "government", evidence },
    { ...base, candidateKey: "turned-creature", name: "the Turned", category: "creature", evidence: [...evidence, ...evidence, ...evidence, ...evidence] },
    { ...base, candidateKey: "turned-tech", name: "Turned", category: "technology", evidence },
    { ...base, candidateKey: "hive-place", name: "Hive", category: "place", evidence: [...evidence, ...evidence] },
    { ...base, candidateKey: "hive-government", name: "The Hive", category: "government", evidence: [...evidence, ...evidence] },
  ]);
  assert.equal(consensus.get("macon-government")?.preferredCandidateKey, "macon-place");
  assert.equal(consensus.get("turned-tech")?.preferredCandidateKey, "turned-creature");
  assert.equal(consensus.has("hive-place"), false);
});

test("local alias repair accepts strong plurals and typos without merging cameo names", () => {
  assert.equal(generatedEntityAliasPair({
    leftName: "Lilly", leftType: "character", leftMentions: 202,
    rightName: "Lily", rightType: "character", rightMentions: 1,
  }), true);
  assert.equal(generatedEntityAliasPair({
    leftName: "the Turned", leftType: "creature", leftMentions: 52,
    rightName: "Turmed", rightType: "creature", rightMentions: 1,
  }), true);
  assert.equal(generatedEntityAliasPair({
    leftName: "Visharath", leftType: "species", leftMentions: 20,
    rightName: "Visharaths", rightType: "species", rightMentions: 3,
  }), true);
  assert.equal(generatedEntityAliasPair({
    leftName: "Alec", leftType: "character", leftMentions: 162,
    rightName: "Alex", rightType: "character", rightMentions: 1,
  }), false);
});

test("explicit self-introduction evidence merges formal and familiar names", () => {
  assert.equal(explicitCharacterAliasPair({
    leftName: "David",
    rightName: "Dave",
    evidenceQuotes: ['David smiled. "Mr. Aldrin!" He exclaimed. "Call me Dave, please."'],
  }), true);
  assert.equal(explicitCharacterAliasPair({
    leftName: "Alec",
    rightName: "Alex",
    evidenceQuotes: ["Alec met Alex at the gate."],
  }), false);
});

test("durable spatial evidence repairs obvious place classifications", () => {
  assert.equal(evidenceBasedEntityCategory({
    name: "HQ",
    currentType: "institution",
    evidenceQuotes: [
      "We stepped into the welcome glow of the HQ's interior lights.",
      "The car alarms waited back at HQ.",
    ],
  }), "place");
  assert.equal(evidenceBasedEntityCategory({
    name: "Google",
    currentType: "institution",
    evidenceQuotes: ["Google employs thousands of staff and company leaders."],
  }), "institution");
  assert.equal(evidenceBasedEntityCategory({
    name: "Nicois", currentType: "ambiguous",
    evidenceQuotes: ["I was thinking of Nicois and his trove of scavenged goods."],
  }), "character");
  assert.equal(evidenceBasedEntityCategory({
    name: "Derringer", currentType: "ambiguous",
    evidenceQuotes: ["I reached for my ankle, drawing the tiny Derringer that I kept there."],
  }), "weapon");
  assert.equal(evidenceBasedEntityCategory({
    name: "Derringer", currentType: "character",
    evidenceQuotes: ["She pulled the handkerchief from her mouth and noticed the Derringer in my hand."],
  }), "weapon");
  assert.equal(evidenceBasedEntityCategory({
    name: "Banshee", currentType: "ambiguous",
    evidenceQuotes: ["This wire network is the Banshee's nervous system. It connects each piezo mic to car alarms."],
  }), "technology");
  assert.equal(evidenceBasedEntityCategory({
    name: "Citizen's Band Radio", currentType: "ambiguous",
    evidenceQuotes: ["Citizen's Band Radio means we can broadcast."],
  }), "device");
  assert.equal(evidenceBasedEntityCategory({
    name: "Citizen's Band Radio", currentType: "character",
    evidenceQuotes: ["Citizen's Band Radio, James answered, surprising me with his knowledge."],
  }), "device");
});

test("explicit in-passage abbreviations merge into their durable full names", () => {
  assert.equal(explicitAbbreviationAliasPair({
    leftName: "CB",
    rightName: "Citizen's Band Radio",
    evidenceQuotes: [`"What's a CB?" "Citizen's Band Radio," James answered.`],
  }), true);
  assert.equal(explicitAbbreviationAliasPair({
    leftName: "HQ",
    rightName: "Hive Queen",
    evidenceQuotes: ["HQ was quiet while the Hive Queen moved elsewhere."],
  }), false);
});

test("mechanically duplicated character surfaces never become customer aliases", () => {
  assert.equal(generatedCharacterAliasIsUseful("Kendall Kendall"), false);
  assert.equal(generatedCharacterAliasIsUseful("Sir Alec"), true);
  assert.equal(generatedCharacterAliasIsUseful("Father Kelp"), true);
});

test("one-off spelling repairs composite internally without becoming visible nicknames", () => {
  assert.equal(generatedAliasIsCustomerVisible({
    alias: "Jame",
    canonicalName: "James",
    aliasMentions: 1,
    canonicalMentions: 86,
  }), false);
  assert.equal(generatedAliasIsCustomerVisible({
    alias: "Buzz",
    canonicalName: "Alec",
    aliasMentions: 1,
    canonicalMentions: 450,
    explicitlyAttributed: true,
  }), true);
  assert.equal(generatedAliasIsCustomerVisible({
    alias: "Anne",
    canonicalName: "Anna",
    aliasMentions: 12,
    canonicalMentions: 40,
  }), true);
});

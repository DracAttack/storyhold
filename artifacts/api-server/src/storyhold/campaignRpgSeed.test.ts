import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCampaignSeed,
  campaignCapabilitiesFromRules,
  campaignEvidenceIsRetained,
  campaignRulesFromTemporalEvidence,
  campaignStatsFromDossier,
  campaignStatsFromTemporalEvidence,
} from "./campaignRpgSeed";

const IDS = {
  campaign: "38ed7a6d-4a49-48cf-8c5e-b63224f5a9a0",
  world: "bbf8b57e-eb7c-4c29-826a-29fa324bc223",
  edition: "3c96e5ab-0a43-4472-951c-b8ed1082ee39",
  character: "8f0893e7-0fd1-4af0-a3d6-60aa157b3485",
};

test("an imported campaign seed carries locked canon and evidence-backed character mechanics", () => {
  const source = {
    strength: { score: 17, confidence: 0.8, evidence: [{ quote: "She bent the bar." }] },
    wisdom: { score: 15, confidence: 0.2, evidence: [], reviewStatus: "verified" },
    charisma: { score: 19, confidence: 0.9, evidence: [] },
  };
  const seed = buildCampaignSeed({
    campaignId: IDS.campaign,
    worldId: IDS.world,
    editionId: IDS.edition,
    worldName: "The Ash Coast",
    worldPremise: "Survivors inherit an altered world.",
    origin: "imported",
    canonAnchor: "before:fall-of-sanctuary",
    resolutionMode: "light_rules",
    character: {
      id: IDS.character,
      name: "Mara",
      estimatedStats: source,
      rules: [{
        id: "echo-form",
        name: "Echo Form",
        ruleKind: "ability",
        confidence: 0.95,
        evidence: [{ quote: "Her body changed." }],
      }],
    },
    facts: [{
      id: "canon-1",
      subject: "Mara",
      predicate: "protects",
      object: "the settlement",
      provenance: "manuscript",
    }],
  });

  assert.equal(seed.origin.kind, "imported");
  assert.equal(seed.world.facts[0]?.locked, true);
  assert.equal(seed.initialState.characters[0]?.stats.strength, 17);
  assert.equal(seed.initialState.characters[0]?.stats.wisdom, 15);
  assert.equal(seed.initialState.characters[0]?.stats.charisma, 10);
  assert.deepEqual(seed.initialState.characters[0]?.capabilities.map(({ name, rank }) => ({ name, rank })), [
    { name: "Echo Form", rank: 2 },
  ]);
  assert.equal(Object.isFrozen(seed), true);
  assert.equal(Object.isFrozen(seed.world.facts), true);
});

test("an original adventure keeps the world premise separate from the player character", () => {
  const seed = buildCampaignSeed({
    campaignId: IDS.campaign,
    worldId: IDS.world,
    editionId: IDS.edition,
    worldName: "Lunch Rush Inferno",
    worldPremise: "Demons and humans share an ordinary modern city.",
    origin: "original",
    generatorVersion: "storyhold-original-v1",
    resolutionMode: "story_first",
    character: { id: IDS.character, name: "A Broke Demon Prince" },
    initialObjective: "Survive the lunch rush without exposing his magic",
  });

  assert.equal(seed.origin.kind, "original");
  assert.equal(seed.world.premise, "Demons and humans share an ordinary modern city.");
  assert.equal(seed.initialState.characters[0]?.name, "A Broke Demon Prince");
  assert.notEqual(seed.world.premise, seed.initialState.characters[0]?.name);
  assert.deepEqual(seed.initialState.objectives, [{
    id: "opening-objective",
    title: "Survive the lunch rush without exposing his magic",
    description: "",
    status: "active",
    progress: 0,
    target: 1,
  }]);
});

test("an omitted opening objective does not fabricate a player goal", () => {
  const seed = buildCampaignSeed({
    campaignId: IDS.campaign,
    worldId: IDS.world,
    editionId: IDS.edition,
    worldName: "Unwritten Road",
    worldPremise: "The road changes whenever no one is looking.",
    origin: "original",
    resolutionMode: "light_rules",
    character: { id: IDS.character, name: "Mara" },
  });

  assert.deepEqual(seed.initialState.objectives, []);
});

test("unsupported estimates and inactive or constraining rules do not become mechanics", () => {
  assert.deepEqual(campaignStatsFromDossier({
    strength: { score: 18, confidence: 0.9, evidence: [] },
    dexterity: { score: 14, confidence: 0.4, evidence: [{ quote: "Quick." }] },
  }), { dexterity: 14 });
  assert.deepEqual(campaignCapabilitiesFromRules([
    { id: "a", name: "Unverified Gift", ruleKind: "ability", status: "active" },
    { id: "b", name: "Sourced Gift", ruleKind: "ability", status: "active", evidence: [{ quote: "She flew." }] },
    { id: "c", name: "Owner Gift", ruleKind: "ability", status: "active", assignmentSource: "user" },
    { id: "d", name: "Retired Gift", ruleKind: "ability", status: "retired", premiumVerified: true },
    { id: "e", name: "Cannot Cross Salt", ruleKind: "constraint", status: "active", evidence: [{ quote: "Salt stopped her." }] },
  ]).map((entry) => entry.name), ["Sourced Gift", "Owner Gift"]);
});

test("strict mechanics require authority and a complete retained evidence inventory", () => {
  const retained = [{
    source_id: "source-1",
    chunk_id: "chunk-1",
    excerpt: "Before dawn, Mara bends the iron bar and takes wing.",
  }];
  const strength = {
    score: 17,
    confidence: 0.9,
    rationale: "Mara bends iron.",
    evidence: [{
      sourceId: "source-1",
      chunkId: "chunk-1",
      quote: "Mara bends the iron bar",
    }],
  };
  const futureDexterity = {
    score: 18,
    confidence: 0.95,
    evidence: [{
      sourceId: "source-2",
      chunkId: "chunk-2",
      quote: "Much later, Mara catches a bullet.",
    }],
  };
  assert.equal(campaignEvidenceIsRetained(strength.evidence, retained), true);
  assert.equal(campaignEvidenceIsRetained(futureDexterity.evidence, retained), false);
  assert.deepEqual(campaignStatsFromTemporalEvidence({
    estimatedStats: { strength, dexterity: futureDexterity },
    retainedEvidence: retained,
    premiumVerifiedStatNames: ["strength", "dexterity"],
  }), { strength: 17 });

  const projectedRules = campaignRulesFromTemporalEvidence({
    retainedEvidence: retained,
    rules: [{
      id: "flight",
      name: "Winged Form",
      ruleKind: "ability",
      premiumVerified: true,
      evidence: [{ sourceId: "source-1", chunkId: "chunk-1", quote: "takes wing" }],
    }, {
      id: "future-form",
      name: "Solar Form",
      ruleKind: "ability",
      premiumVerified: true,
      evidence: futureDexterity.evidence,
    }, {
      id: "unverified",
      name: "Rumored Gift",
      ruleKind: "ability",
      evidence: strength.evidence,
    }],
  });
  assert.deepEqual(projectedRules.map((rule) => rule.name), ["Winged Form"]);
  assert.deepEqual(
    campaignCapabilitiesFromRules(projectedRules).map((capability) => capability.name),
    ["Winged Form"],
  );
});

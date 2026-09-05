import assert from "node:assert/strict";
import test from "node:test";
import { buildCampaignSeed } from "./campaignRpgSeed";
import { createInitialCampaignRpgState } from "./campaignRpgState";
import {
  buildLocalCampaignCheck,
  localCampaignCheckAbility,
  localCampaignCheckDifficulty,
  localCampaignCheckParticipants,
  planLocalCampaignCheck,
} from "./campaignRpgAdjudication";

const seed = buildCampaignSeed({
  campaignId: "38ed7a6d-4a49-48cf-8c5e-b63224f5a9a0",
  worldId: "bbf8b57e-eb7c-4c29-826a-29fa324bc223",
  editionId: "3c96e5ab-0a43-4472-951c-b8ed1082ee39",
  worldName: "Test World",
  origin: "original",
  resolutionMode: "tactical",
  character: {
    id: "8f0893e7-0fd1-4af0-a3d6-60aa157b3485",
    name: "Mara",
    estimatedStats: {
      dexterity: { score: 15, reviewStatus: "verified" },
    },
    rules: [{
      id: "locksmith",
      name: "Locksmith",
      description: "Opening locks with careful tools",
      ruleKind: "ability",
      status: "active",
      evidence: [{
        sourceId: "test-source",
        chunkId: "test-chunk",
        quote: "Mara opened the lock with her familiar tools.",
      }],
    }],
  },
});
const state = createInitialCampaignRpgState(seed);

test("local adjudication chooses an action-relevant ability without choosing an outcome", () => {
  assert.equal(localCampaignCheckAbility("I force the steel door open."), "strength");
  assert.equal(localCampaignCheckAbility("I persuade the guard to let us pass."), "charisma");
  assert.equal(localCampaignCheckAbility("I inspect the tracks."), "wisdom");
  const plan = planLocalCampaignCheck({
    state,
    actorId: state.activeCharacterId,
    action: "I pick the lock with my locksmith tools.",
    certainty: "check_required",
  });
  assert.equal(plan.ability, "dexterity");
  assert.equal(plan.capabilityId, "locksmith");
  assert.equal(Object.hasOwn(plan, "roll"), false);
  assert.equal(Object.hasOwn(plan, "outcome"), false);
  assert.equal(Object.hasOwn(plan, "modifier"), false);
});

test("difficulty language remains categorical and the kernel owns the modifier", () => {
  assert.equal(localCampaignCheckDifficulty("I effortlessly perform this trivial repair."), "standard");
  assert.equal(localCampaignCheckDifficulty("I cross under heavy fire."), "severe");
  const check = buildLocalCampaignCheck({
    state,
    actorId: state.activeCharacterId,
    action: "I pick the lock with my locksmith tools while wounded.",
    certainty: "check_required",
  });
  assert.equal(check.difficulty, "hard");
  assert.equal(check.ability, "dexterity");
  assert.ok(check.contributions.some((entry) => entry.source === "ability"));
  assert.ok(check.contributions.some((entry) => entry.source === "capability"));
  assert.ok(check.contributions.some((entry) => entry.source === "difficulty"));
});

test("multi-step actions use the primary or final intended task instead of pattern order", () => {
  assert.equal(
    localCampaignCheckAbility(
      "I persuade the guard while dodging the crowd around us.",
      "communication",
    ),
    "charisma",
  );
  assert.equal(
    localCampaignCheckAbility(
      "I shove the crate aside, then pick the lock behind it.",
      "manipulation",
    ),
    "dexterity",
  );
  assert.equal(
    localCampaignCheckAbility(
      "I open the sealed door by decoding the maintenance panel.",
      "manipulation",
    ),
    "intelligence",
  );
});

test("local participants require explicit help or opposition and known character IDs", () => {
  const oneCharacterSeed = buildCampaignSeed({
    campaignId: "e8e85ae7-ce72-4019-9404-35ca4a01b880",
    worldId: "8794392b-657c-4405-98c8-47c41ef05883",
    editionId: "f2e85566-1776-4019-9828-70cd5327f648",
    worldName: "Party Test",
    origin: "original",
    resolutionMode: "tactical",
    character: { id: "hero", name: "Mara" },
  });
  const hero = oneCharacterSeed.initialState.characters[0]!;
  const partySeed = {
    ...oneCharacterSeed,
    initialState: {
      ...oneCharacterSeed.initialState,
      characters: [
        hero,
        { ...hero, characterId: "ally", name: "Jon Bell", capabilities: [] },
        { ...hero, characterId: "rival", name: "Captain Voss", capabilities: [] },
      ],
    },
  };
  const partyState = createInitialCampaignRpgState(partySeed);
  const neutral = localCampaignCheckParticipants({
    state: partyState,
    actorId: "hero",
    action: "I glance toward Jon Bell and Captain Voss.",
    ability: "wisdom",
  });
  assert.deepEqual(neutral.assistingCharacterIds, []);
  assert.equal(neutral.opposition, null);

  const participants = localCampaignCheckParticipants({
    state: partyState,
    actorId: "hero",
    action: "With the help of Jon Bell, I try to outmaneuver Captain Voss.",
    ability: "intelligence",
  });
  assert.deepEqual(participants.assistingCharacterIds, ["ally"]);
  assert.deepEqual(participants.opposition, {
    characterId: "rival",
    ability: "intelligence",
  });
});

test("objective hazard language expands difficulty without trusting easy adjectives", () => {
  assert.equal(localCampaignCheckDifficulty("I perform an impossibly easy shot."), "standard");
  assert.equal(localCampaignCheckDifficulty("I cross the chamber in total darkness."), "hard");
  assert.equal(localCampaignCheckDifficulty("I hold the breach in hard vacuum."), "severe");
  assert.equal(localCampaignCheckDifficulty("I repair the engine while falling from orbit."), "extreme");
});

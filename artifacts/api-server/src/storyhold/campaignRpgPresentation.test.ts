import assert from "node:assert/strict";
import test from "node:test";
import { createInitialCampaignRpgState, normalizeCampaignSeed } from "./campaignRpgState";
import { projectCampaignRpgStateForPlayer } from "./campaignRpgPresentation";

function seed(mode: "story_first" | "tactical") {
  return normalizeCampaignSeed({
    schemaVersion: 1,
    seedId: "00000000-0000-4000-8000-000000000991",
    origin: { kind: "original", worldId: null, generatorVersion: "test" },
    world: { name: "The Reach", premise: "A dangerous frontier.", facts: [] },
    rules: { resolutionMode: mode },
    initialState: {
      activeCharacterId: "hero",
      characters: [{
        characterId: "hero",
        name: "Mara",
        stats: { strength: 15 },
        harms: [{
          id: "bruised-ribs",
          name: "Bruised Ribs",
          severity: 2,
          description: "Sudden movement hurts.",
        }],
        capabilities: [{ id: "pilot", name: "Pilot", description: "Flies old ships.", rank: 2 }],
      }],
      location: { entityId: null, name: "Dock Nine", zone: "Lower Ring" },
      companions: [],
      reputations: [],
      sharedResources: [],
      objectives: [{ id: "escape", title: "Escape the Station", description: "Reach the shuttle.", status: "active", progress: 1, target: 4 }],
    },
  });
}

test("story-first projection describes state without leaking numbers or seed facts", () => {
  const lockedSeed = seed("story_first");
  const view = projectCampaignRpgStateForPlayer({
    seed: lockedSeed,
    state: createInitialCampaignRpgState(lockedSeed),
  });

  assert.equal(view.mode, "story-first");
  assert.deepEqual(view.visibility, { showNumbers: false, showBreakdowns: false });
  assert.equal(view.location?.name, "Dock Nine");
  assert.equal(view.objectives[0]?.title, "Escape the Station");
  assert.equal(view.objectives[0]?.progress, undefined);
  assert.equal(view.vitality?.current, undefined);
  assert.equal(view.vitality?.note, undefined);
  assert.equal(view.conditions[0]?.name, "Bruised Ribs");
  assert.equal(view.capabilities[0]?.rating, undefined);
  assert.equal("stats" in view, false);
  assert.equal("facts" in view, false);
});

test("tactical projection includes player-facing values", () => {
  const lockedSeed = seed("tactical");
  const view = projectCampaignRpgStateForPlayer({
    seed: lockedSeed,
    state: createInitialCampaignRpgState(lockedSeed),
  });

  assert.equal(view.mode, "tactical");
  assert.deepEqual(view.visibility, { showNumbers: true, showBreakdowns: true });
  assert.deepEqual(view.objectives[0]?.progress, { current: 1, maximum: 4 });
  assert.equal(view.vitality?.current, 10);
  assert.equal(view.vitality?.note, "1 active injury");
  assert.equal(view.capabilities[0]?.rating, 2);
});

test("projection fails closed when state and immutable seed disagree", () => {
  const lockedSeed = seed("story_first");
  const state = {
    ...createInitialCampaignRpgState(lockedSeed),
    seedId: "another-seed",
  };
  assert.throws(
    () => projectCampaignRpgStateForPlayer({ seed: lockedSeed, state }),
    /does not belong/,
  );
});

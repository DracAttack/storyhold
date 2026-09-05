import assert from "node:assert/strict";
import test from "node:test";
import {
  createInitialCampaignRpgState,
  normalizeCampaignSeed,
} from "./campaignRpgState";
import {
  buildAcceptedCampaignRpgDelta,
  CampaignRpgTurnDeltaError,
} from "./campaignRpgTurnDelta";

function state() {
  const seed = normalizeCampaignSeed({
    seedId: "turn-delta-seed",
    origin: { kind: "original", generatorVersion: "test" },
    world: { name: "The Reach", premise: "A dangerous frontier." },
    initialState: {
      activeCharacterId: "mara",
      characters: [{
        characterId: "mara",
        name: "Mara",
        vitality: { current: 10, maximum: 10 },
        stress: { current: 0, maximum: 10 },
        inventory: [],
        equipment: [],
        capabilities: [],
        harms: [],
        conditions: [],
        resources: [],
      }],
      location: { entityId: null, name: "Dock Nine", zone: null },
      objectives: [{
        id: "escape",
        title: "Escape",
        description: "Reach the shuttle.",
        status: "active",
        progress: 0,
        target: 3,
      }],
    },
  });
  return createInitialCampaignRpgState(seed);
}

test("every accepted turn gets an aligned journal boundary, even without a tracked change", () => {
  const delta = buildAcceptedCampaignRpgDelta({
    state: state(),
    proposed: null,
    outcome: "none",
    reason: "Mara asks the dockmaster a question.",
    allowedCausalBasis: [],
  });
  assert.deepEqual(delta, {
    expectedStateVersion: 0,
    reason: "Mara asks the dockmaster a question.",
    turnAccepted: true,
  });
});

test("an evidence-bound success may advance typed state", () => {
  const delta = buildAcceptedCampaignRpgDelta({
    state: state(),
    proposed: {
      causalBasis: ["Mara reaches the inner airlock."],
      location: { entityId: null, name: "Inner Airlock", zone: null },
      objectiveChanges: [{ kind: "progress", objectiveId: "escape", amount: 1 }],
    },
    outcome: "success",
    reason: "Mara reaches the inner airlock.",
    allowedCausalBasis: ["Mara reaches the inner airlock."],
  });
  assert.equal(delta.location?.name, "Inner Airlock");
  assert.equal(delta.objectiveChanges?.[0]?.kind, "progress");
});

test("the Director cannot choose version fields, alter stats, or invent causes", () => {
  for (const proposed of [
    { expectedStateVersion: 99 },
    { characterChanges: [{ characterId: "mara", stats: { strength: 20 } }], causalBasis: ["Cause"] },
    { location: { entityId: null, name: "Vault", zone: null }, causalBasis: ["Invented cause"] },
  ]) {
    assert.throws(
      () => buildAcceptedCampaignRpgDelta({
        state: state(),
        proposed,
        outcome: "success",
        reason: "Cause",
        allowedCausalBasis: ["Cause"],
      }),
      (error: unknown) =>
        error instanceof CampaignRpgTurnDeltaError ||
        (error instanceof Error && /not permitted/iu.test(error.message)),
    );
  }
});

test("failure cannot award items, abilities, recovery, reputation, or objective progress", () => {
  const rewards = [
    { characterChanges: [{ characterId: "mara", vitalityChange: 1 }] },
    { characterChanges: [{ characterId: "mara", stressChange: -1 }] },
    { characterChanges: [{ characterId: "mara", inventoryChanges: [{ kind: "add", item: { id: "key", name: "Key", quantity: 1, description: "", tags: [], checkEffects: [] } }] }] },
    { characterChanges: [{ characterId: "mara", capabilityChanges: [{ kind: "add", capability: { id: "hacking", name: "Hacking", rank: 1, description: "" } }] }] },
    { reputationChanges: [{ kind: "add", reputation: { targetId: "crew", targetName: "Crew", score: 5 } }] },
    { objectiveChanges: [{ kind: "progress", objectiveId: "escape", amount: 1 }] },
  ];
  for (const proposed of rewards) {
    assert.throws(
      () => buildAcceptedCampaignRpgDelta({
        state: state(),
        proposed: { ...proposed, causalBasis: ["The attempt fails."] },
        outcome: "failure",
        reason: "The attempt fails.",
        allowedCausalBasis: ["The attempt fails."],
      }),
      (error: unknown) =>
        error instanceof CampaignRpgTurnDeltaError &&
        error.code === "OUTCOME_RPG_STATE_MISMATCH",
    );
  }
});

test("failure may still apply a supported cost or injury", () => {
  const delta = buildAcceptedCampaignRpgDelta({
    state: state(),
    proposed: {
      causalBasis: ["The security door crushes Mara's shoulder."],
      characterChanges: [{
        characterId: "mara",
        vitalityChange: -2,
        stressChange: 2,
        addHarms: [{ id: "crushed-shoulder", name: "Crushed Shoulder", severity: 3, description: "Movement is painful." }],
      }],
    },
    outcome: "failure",
    reason: "The security door crushes Mara's shoulder.",
    allowedCausalBasis: ["The security door crushes Mara's shoulder."],
  });
  assert.equal(delta.characterChanges?.[0]?.vitalityChange, -2);
});

test("a matured world event may advance state independently of a failed player action", () => {
  const delta = buildAcceptedCampaignRpgDelta({
    state: state(),
    proposed: {
      causalBasis: ["The already-matured rescue clock reaches the station."],
      objectiveChanges: [{ kind: "progress", objectiveId: "escape", amount: 1 }],
    },
    outcome: "failure",
    advancementSource: "matured_clock",
    reason: "The rescue clock matures while Mara's own attempt fails.",
    allowedCausalBasis: ["The already-matured rescue clock reaches the station."],
  });
  assert.equal(delta.objectiveChanges?.[0]?.kind, "progress");
});

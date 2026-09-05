import assert from "node:assert/strict";
import test from "node:test";
import {
  createInitialCampaignRpgState,
  normalizeCampaignSeed,
  type CampaignRpgState,
} from "./campaignRpgState";
import type {
  DeterministicEngineEnvelope,
  ObjectiveImpact,
} from "./causalEngine";
import {
  buildCampaignRpgRewardBudget,
  CampaignRpgRewardBudgetError,
  normalizeCampaignRpgProposalAgainstRewardBudget,
  type CampaignRpgRewardAuthorization,
} from "./campaignRpgRewardBudget";

function state(): CampaignRpgState {
  return createInitialCampaignRpgState(normalizeCampaignSeed({
    seedId: "reward-seed",
    origin: { kind: "original", generatorVersion: "test" },
    world: { name: "The Reach", premise: "A dangerous frontier." },
    initialState: {
      activeCharacterId: "mara",
      characters: [{
        characterId: "mara",
        name: "Mara",
        vitality: { current: 6, maximum: 10 },
        stress: { current: 4, maximum: 10 },
        harms: [{
          id: "burn",
          name: "Plasma Burn",
          severity: 2,
          description: "A painful burn.",
        }],
        conditions: [{
          id: "shaken",
          name: "Shaken",
          description: "Mara is rattled.",
          checkEffects: [{
            id: "shaken-penalty",
            label: "Shaken",
            modifier: -2,
            abilities: [],
            capabilities: [],
          }],
        }],
        resources: [{ id: "focus", name: "Focus", current: 1, maximum: 5 }],
        inventory: [{
          id: "flare",
          name: "Flare",
          quantity: 1,
          description: "A signal flare.",
          tags: ["consumable"],
          checkEffects: [],
        }],
        equipment: [],
        capabilities: [{ id: "scouting", name: "Scouting", rank: 1, description: "Fieldcraft." }],
      }],
      location: { entityId: "dock", name: "Dock Nine", zone: null },
      companions: [{
        id: "ivy",
        entityId: "ivy-character",
        name: "Ivy",
        status: "missing",
        loyalty: 40,
      }],
      reputations: [{ targetId: "guild", targetName: "Guild", score: -10 }],
      objectives: [{
        id: "escape",
        title: "Escape the Station",
        description: "Reach the waiting shuttle.",
        status: "active",
        progress: 1,
        target: 4,
      }],
      sharedResources: [{ id: "supplies", name: "Supplies", current: 1, maximum: 5 }],
    },
  }));
}

function envelope(options: {
  outcome?: "success" | "mixed" | "failure" | "uncertain" | "none";
  band?: DeterministicEngineEnvelope["resolution"]["band"];
  impact?: ObjectiveImpact;
  targets?: string[];
  matured?: string[];
  actionScope?: DeterministicEngineEnvelope["progression"]["actionScope"];
} = {}): DeterministicEngineEnvelope {
  const outcome = options.outcome ?? "success";
  return {
    schemaVersion: 1,
    campaignId: "campaign-one",
    requestId: "turn-one",
    baseStateVersion: 3,
    intent: "action",
    inputCommitment: "committed-input",
    fortune: { seedCommitment: "fortune", percentile: 75, d20: 15 },
    resolution: {
      certainty: "check_required",
      band: options.band ?? (outcome === "mixed" ? "mixed" : outcome === "failure" ? "failure" : "success"),
      outcome,
      percentile: 75,
      modifier: 0,
      effectivePercentile: 75,
      timeAdvanceMinutes: 1,
    },
    clockEligibility: {
      resolve: options.matured ?? [],
      acknowledgeMatured: options.matured ?? [],
    },
    progression: {
      actionScope: options.actionScope ?? "movement",
      objectiveTargets: options.targets ?? ["shuttle"],
      explicitObjectiveAttempt: true,
      maximumObjectiveImpact: options.impact ?? "progress",
      clockDrivenOverrideAllowed: (options.matured?.length ?? 0) > 0,
      priorObjectiveClues: 2,
      priorObjectiveMilestones: 0,
      objectiveImmediatelyAccessible: false,
    },
  };
}

function build(options: Parameters<typeof envelope>[0] = {}) {
  return buildCampaignRpgRewardBudget({
    state: state(),
    engineEnvelope: envelope(options),
    playerAction: "I proceed toward the shuttle.",
  });
}

function assertRewardError(
  run: () => unknown,
  code: string,
) {
  assert.throws(run, (error: unknown) =>
    error instanceof CampaignRpgRewardBudgetError && error.code === code,
  );
}

test("a successful player action can advance only the matching active objective", () => {
  const budget = build();
  assert.equal(budget.outcomePolicy, "objective_progress");
  assert.deepEqual(budget.grants, [{
    grantId: "player-objective:turn-one:escape",
    source: { kind: "player_action" },
    kind: "objective_progress",
    objectiveId: "escape",
    maximumAmount: 1,
  }]);
  assert.ok(Object.isFrozen(budget));

  const proposal = normalizeCampaignRpgProposalAgainstRewardBudget({
    state: state(),
    budget,
    proposed: {
      causalBasis: ["Mara reaches the launch corridor."],
      objectiveChanges: [{ kind: "progress", objectiveId: "escape", amount: 1 }],
    },
  });
  assert.equal(proposal?.objectiveChanges?.[0]?.kind, "progress");
});

test("the same frozen inputs issue the same immutable reward budget", () => {
  const first = build();
  const replay = build();
  assert.deepEqual(replay, first);
  assert.equal(Object.isFrozen(replay.grants), true);

  const nextRequest = buildCampaignRpgRewardBudget({
    state: state(),
    engineEnvelope: { ...envelope(), requestId: "turn-two" },
    playerAction: "I proceed toward the shuttle.",
  });
  assert.notEqual(nextRequest.requestId, first.requestId);
  assert.notEqual(nextRequest.grants[0]?.grantId, first.grants[0]?.grantId);
});

test("outcome policy is fail-closed and cannot turn partial progress into completion", () => {
  assert.equal(build({ outcome: "failure" }).outcomePolicy, "no_player_reward");
  assert.equal(build({ outcome: "uncertain", band: "uncertain" }).grants.length, 0);
  assert.equal(build({ outcome: "none", band: "none" }).grants.length, 0);

  const mixed = build({ outcome: "mixed", impact: "completion" });
  assert.equal(mixed.outcomePolicy, "partial_objective_progress");
  assert.equal(mixed.grants[0] && "maximumAmount" in mixed.grants[0] ? mixed.grants[0].maximumAmount : 0, 1);

  const completion = build({ outcome: "success", impact: "completion" });
  assert.equal(completion.outcomePolicy, "objective_completion");
  assert.equal(completion.grants[0] && "maximumAmount" in completion.grants[0] ? completion.grants[0].maximumAmount : 0, 3);
});

test("an ambiguous or unknown objective target creates no player reward", () => {
  const original = state();
  const ambiguous: CampaignRpgState = {
    ...original,
    objectives: [
      ...original.objectives,
      {
        id: "warn-shuttle",
        title: "Warn the Shuttle",
        description: "Reach the shuttle crew by radio.",
        status: "active",
        progress: 0,
        target: 3,
      },
    ],
  };
  const budget = buildCampaignRpgRewardBudget({
    state: ambiguous,
    engineEnvelope: envelope(),
    playerAction: "I proceed toward the shuttle.",
  });
  assert.equal(budget.grants.length, 0);
  assert.equal(build({ targets: ["reactor"] }).grants.length, 0);
});

test("the budget is bound to the frozen player action scope and current RPG state", () => {
  assertRewardError(
    () => buildCampaignRpgRewardBudget({
      state: state(),
      engineEnvelope: envelope(),
      playerAction: "I ask the guard about the shuttle.",
    }),
    "RPG_REWARD_INPUT_MISMATCH",
  );
  const budget = build();
  assertRewardError(
    () => normalizeCampaignRpgProposalAgainstRewardBudget({
      state: { ...state(), stateVersion: 1 },
      budget,
      proposed: { objectiveChanges: [{ kind: "progress", objectiveId: "escape", amount: 1 }] },
    }),
    "RPG_REWARD_BUDGET_STATE_MISMATCH",
  );
  assertRewardError(
    () => normalizeCampaignRpgProposalAgainstRewardBudget({
      state: { ...state(), location: { entityId: "vault", name: "Vault", zone: null } },
      budget,
      proposed: { objectiveChanges: [{ kind: "progress", objectiveId: "escape", amount: 1 }] },
    }),
    "RPG_REWARD_BUDGET_STATE_MISMATCH",
  );
});

test("failure cannot mint any ordinary player reward merely because the Director asks", () => {
  const budget = build({ outcome: "failure" });
  const attacks = [
    { characterChanges: [{ characterId: "mara", vitalityChange: 1 }] },
    { characterChanges: [{ characterId: "mara", stressChange: -1 }] },
    { characterChanges: [{ characterId: "mara", removeHarmIds: ["burn"] }] },
    { characterChanges: [{ characterId: "mara", removeConditionIds: ["shaken"] }] },
    { characterChanges: [{ characterId: "mara", resourceChanges: [{ kind: "adjust", poolId: "focus", amount: 1 }] }] },
    { characterChanges: [{ characterId: "mara", inventoryChanges: [{ kind: "quantity", itemId: "flare", amount: 1 }] }] },
    { characterChanges: [{ characterId: "mara", capabilityChanges: [{ kind: "adjust_rank", capabilityId: "scouting", amount: 1 }] }] },
    { sharedResourceChanges: [{ kind: "adjust", poolId: "supplies", amount: 1 }] },
    { companionChanges: [{ kind: "update", companionId: "ivy", loyaltyChange: 1 }] },
    { reputationChanges: [{ kind: "adjust", targetId: "guild", amount: 1 }] },
    { objectiveChanges: [{ kind: "progress", objectiveId: "escape", amount: 1 }] },
  ];
  for (const proposed of attacks) {
    assertRewardError(
      () => normalizeCampaignRpgProposalAgainstRewardBudget({ state: state(), budget, proposed }),
      "CAMPAIGN_RPG_REWARD_NOT_AUTHORIZED",
    );
  }
});

test("split mutations share one cumulative cap and cannot exceed it", () => {
  const budget = build();
  assertRewardError(
    () => normalizeCampaignRpgProposalAgainstRewardBudget({
      state: state(),
      budget,
      proposed: {
        objectiveChanges: [
          { kind: "progress", objectiveId: "escape", amount: 1 },
          { kind: "progress", objectiveId: "escape", amount: 1 },
        ],
      },
    }),
    "CAMPAIGN_RPG_REWARD_BUDGET_EXCEEDED",
  );
});

test("unknown IDs fail before the ordinary state transition validator", () => {
  const budget = build();
  assertRewardError(
    () => normalizeCampaignRpgProposalAgainstRewardBudget({
      state: state(),
      budget,
      proposed: { characterChanges: [{ characterId: "invented", vitalityChange: 1 }] },
    }),
    "UNKNOWN_RPG_REWARD_TARGET",
  );
  const badAuthorization: CampaignRpgRewardAuthorization = {
    grantId: "invented-item",
    source: { kind: "campaign_rule", authorizationId: "trusted-loot-table" },
    kind: "inventory_quantity",
    characterId: "mara",
    itemId: "invented",
    maximumAmount: 1,
  };
  assertRewardError(
    () => buildCampaignRpgRewardBudget({
      state: state(),
      engineEnvelope: envelope(),
      playerAction: "I proceed toward the shuttle.",
      independentAuthorizations: [badAuthorization],
    }),
    "UNKNOWN_RPG_REWARD_TARGET",
  );
});

test("alternate mutation kinds cannot launder an unauthorized reward", () => {
  const budget = build();
  const attacks = [
    { objectiveChanges: [{ kind: "status", objectiveId: "escape", status: "completed" }] },
    { objectiveChanges: [{ kind: "add", objective: { id: "won", title: "Won", description: "", status: "completed", progress: 1, target: 1 } }] },
    { reputationChanges: [{ kind: "remove", targetId: "guild" }] },
    { companionChanges: [{ kind: "update", companionId: "ivy", status: "present" }] },
    { characterChanges: [{ characterId: "mara", inventoryChanges: [{ kind: "equip", itemId: "flare", slot: "hand" }] }] },
    { characterChanges: [{ characterId: "mara", addConditions: [{ id: "blessed", name: "Blessed", description: "", checkEffects: [{ id: "gift", label: "Gift", modifier: 4, abilities: [], capabilities: [] }] }] }] },
  ];
  for (const proposed of attacks) {
    assertRewardError(
      () => normalizeCampaignRpgProposalAgainstRewardBudget({ state: state(), budget, proposed }),
      "CAMPAIGN_RPG_REWARD_NOT_AUTHORIZED",
    );
  }
});

test("an independently authorized item is exact; the Director cannot strengthen it", () => {
  const item = {
    id: "medkit",
    name: "Field Medkit",
    quantity: 1,
    description: "One emergency treatment.",
    tags: ["medical"],
    checkEffects: [],
  } as const;
  const authorization: CampaignRpgRewardAuthorization = {
    grantId: "rule-medkit",
    source: { kind: "campaign_rule", authorizationId: "starting-loot:medkit" },
    kind: "inventory_item",
    characterId: "mara",
    item,
  };
  const budget = buildCampaignRpgRewardBudget({
    state: state(),
    engineEnvelope: envelope(),
    playerAction: "I proceed toward the shuttle.",
    independentAuthorizations: [authorization],
  });
  const accepted = normalizeCampaignRpgProposalAgainstRewardBudget({
    state: state(),
    budget,
    proposed: {
      characterChanges: [{
        characterId: "mara",
        inventoryChanges: [{ kind: "add", item }],
      }],
    },
  });
  assert.equal(accepted?.characterChanges?.[0]?.inventoryChanges?.[0]?.kind, "add");
  assert.ok(Object.isFrozen(accepted));

  assertRewardError(
    () => normalizeCampaignRpgProposalAgainstRewardBudget({
      state: state(),
      budget,
      proposed: {
        characterChanges: [{
          characterId: "mara",
          inventoryChanges: [{
            kind: "add",
            item: {
              ...item,
              quantity: 99,
              checkEffects: [{ id: "god-mode", label: "Perfect", modifier: 20, abilities: [], capabilities: [] }],
            },
          }],
        }],
      },
    }),
    "CAMPAIGN_RPG_REWARD_NOT_AUTHORIZED",
  );
});

test("healing and advancement work only through exact independent grants", () => {
  const authorizations: CampaignRpgRewardAuthorization[] = [
    {
      grantId: "rest-vitality",
      source: { kind: "campaign_rule", authorizationId: "safe-rest" },
      kind: "vitality_recovery",
      characterId: "mara",
      maximumAmount: 2,
    },
    {
      grantId: "rest-harm",
      source: { kind: "campaign_rule", authorizationId: "treat-burn" },
      kind: "harm_removal",
      characterId: "mara",
      harmIds: ["burn"],
    },
    {
      grantId: "training",
      source: { kind: "campaign_rule", authorizationId: "training-complete" },
      kind: "capability_rank",
      characterId: "mara",
      capabilityId: "scouting",
      maximumAmount: 1,
    },
  ];
  const budget = buildCampaignRpgRewardBudget({
    state: state(),
    engineEnvelope: envelope(),
    playerAction: "I proceed toward the shuttle.",
    independentAuthorizations: authorizations,
  });
  const accepted = normalizeCampaignRpgProposalAgainstRewardBudget({
    state: state(),
    budget,
    proposed: {
      characterChanges: [{
        characterId: "mara",
        vitalityChange: 2,
        removeHarmIds: ["burn"],
        capabilityChanges: [{ kind: "adjust_rank", capabilityId: "scouting", amount: 1 }],
      }],
    },
  });
  assert.equal(accepted?.characterChanges?.[0]?.vitalityChange, 2);
});

test("matured-clock grants require both frozen eligibility and actual acknowledgement", () => {
  const authorization: CampaignRpgRewardAuthorization = {
    grantId: "resupply-arrives",
    source: { kind: "matured_clock", clockEventId: "resupply-clock" },
    kind: "shared_resource",
    poolId: "supplies",
    maximumAmount: 2,
  };
  assertRewardError(
    () => buildCampaignRpgRewardBudget({
      state: state(),
      engineEnvelope: envelope({ outcome: "failure", matured: ["resupply-clock"] }),
      playerAction: "I proceed toward the shuttle.",
      independentAuthorizations: [authorization],
    }),
    "INELIGIBLE_RPG_REWARD_SOURCE",
  );
  assertRewardError(
    () => buildCampaignRpgRewardBudget({
      state: state(),
      engineEnvelope: envelope({ outcome: "failure" }),
      playerAction: "I proceed toward the shuttle.",
      acknowledgedMaturedClockEventIds: ["resupply-clock"],
      independentAuthorizations: [authorization],
    }),
    "INELIGIBLE_RPG_REWARD_SOURCE",
  );

  const budget = buildCampaignRpgRewardBudget({
    state: state(),
    engineEnvelope: envelope({ outcome: "failure", matured: ["resupply-clock"] }),
    playerAction: "I proceed toward the shuttle.",
    acknowledgedMaturedClockEventIds: ["resupply-clock"],
    independentAuthorizations: [authorization],
  });
  const accepted = normalizeCampaignRpgProposalAgainstRewardBudget({
    state: state(),
    budget,
    proposed: { sharedResourceChanges: [{ kind: "adjust", poolId: "supplies", amount: 2 }] },
  });
  assert.equal(accepted?.sharedResourceChanges?.[0]?.kind, "adjust");
});

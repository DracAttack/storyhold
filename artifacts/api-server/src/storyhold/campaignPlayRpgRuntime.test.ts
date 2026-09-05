import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  assertDirectorRpgMutationPolicy,
  buildAcceptedRpgDeltaForResolution,
  buildCampaignRpgTurnMechanics,
  campaignIntentIsAllowed,
  loadCampaignRpgRuntime,
  normalizeCampaignResolution,
  projectCampaignRpgForPlayer,
  serializeTurn,
  serializeTurnProposal,
  turnOutcomeCertainty,
  validateFrozenTurnMechanics,
} from "./campaignPlay";
import { buildLocalCampaignCheck } from "./campaignRpgAdjudication";
import {
  campaignRpgSha256,
  commitCampaignRpgStateDeltaInTransaction,
  ensureCampaignRpgPersistence,
  initializeCampaignRpgState,
  loadCampaignRpgSnapshot,
  loadCampaignRpgStateEvents,
  type PersistedCampaignRpgSnapshot,
} from "./campaignRpgPersistence";
import { buildCampaignSeed } from "./campaignRpgSeed";
import {
  applyCampaignRpgStateDelta,
  createInitialCampaignRpgState,
  type CampaignResolutionMode,
  type CampaignSeed,
} from "./campaignRpgState";
import {
  classifyTurnActionScope,
  createDeterministicEngineEnvelope,
  type TurnIntent,
} from "./causalEngine";

const CAMPAIGN_ID = "70000000-0000-4000-8000-000000000001";
const LEGACY_CAMPAIGN_ID = "70000000-0000-4000-8000-000000000002";
const WORLD_ID = "70000000-0000-4000-8000-000000000003";
const EDITION_ID = "70000000-0000-4000-8000-000000000004";
const ACTOR_ID = "70000000-0000-4000-8000-000000000005";
const SERVER_SECRET = "campaign-rpg-runtime-test-secret";

function campaignSeed(mode: CampaignResolutionMode = "tactical"): CampaignSeed {
  return buildCampaignSeed({
    campaignId: CAMPAIGN_ID,
    worldId: WORLD_ID,
    editionId: EDITION_ID,
    worldName: "The Reach",
    worldPremise: "Mara must cross a hostile station.",
    origin: "imported",
    resolutionMode: mode,
    character: {
      id: ACTOR_ID,
      name: "Mara",
      estimatedStats: {
        strength: { score: 20, reviewStatus: "verified" },
      },
    },
    initialObjective: "Reach the Inner Airlock",
    facts: [{
      id: "private-seed-fact",
      subject: "The station",
      predicate: "contains",
      object: "a hidden command key",
      provenance: "manuscript",
    }],
  });
}

function persistedSnapshot(mode: CampaignResolutionMode = "tactical"):
  PersistedCampaignRpgSnapshot {
  const seed = campaignSeed(mode);
  const state = createInitialCampaignRpgState(seed);
  return {
    campaignId: CAMPAIGN_ID,
    seed,
    seedSha256: campaignRpgSha256(seed),
    baseState: state,
    baseStateSha256: campaignRpgSha256(state),
    state,
    stateSha256: campaignRpgSha256(state),
  };
}

function envelope(input: {
  requestId?: string;
  action?: string;
  certainty?: "automatic_success" | "automatic_failure" | "check_required" | "unresolved" | "not_applicable";
  modifier?: number;
  includeD20?: boolean;
  actionScope?: "communication" | "observation" | "movement" | "manipulation" | "other";
  intent?: TurnIntent;
  objectiveTargets?: string[];
  explicitObjectiveAttempt?: boolean;
  maximumObjectiveImpact?: "none" | "clue" | "progress" | "completion";
  priorObjectiveClues?: number;
  priorObjectiveMilestones?: number;
  objectiveImmediatelyAccessible?: boolean;
}) {
  const action = input.action ?? "I lift the steel gate.";
  const intent = input.intent ?? "action";
  return createDeterministicEngineEnvelope({
    campaignId: CAMPAIGN_ID,
    requestId: input.requestId ?? "runtime-envelope",
    playerInput: action,
    serverSecret: SERVER_SECRET,
    baseStateVersion: 1,
    intent,
    certainty: input.certainty ?? "check_required",
    modifier: input.modifier ?? 0,
    includeD20: input.includeD20 ?? true,
    progression: {
      actionScope: input.actionScope ?? classifyTurnActionScope(intent, action),
      objectiveTargets: input.objectiveTargets ?? [],
      explicitObjectiveAttempt: input.explicitObjectiveAttempt ?? false,
      maximumObjectiveImpact: input.maximumObjectiveImpact ?? "none",
      clockDrivenOverrideAllowed: false,
      priorObjectiveClues: input.priorObjectiveClues ?? 0,
      priorObjectiveMilestones: input.priorObjectiveMilestones ?? 0,
      objectiveImmediatelyAccessible: input.objectiveImmediatelyAccessible ?? false,
    },
  });
}

function resolution(input: {
  outcome: "success" | "mixed" | "failure" | "uncertain" | "none";
  cause?: string;
  advancementSource?: "none" | "player_action" | "matured_clock" | "established_state";
  rpgStateChange?: unknown;
  actionScope?: "movement" | "manipulation" | "other";
}) {
  const cause = input.cause ?? "The scene changes in a directly observed way.";
  return normalizeCampaignResolution({
    narration: "The scene changes in a concrete way that everyone present can observe.",
    sceneSummary: cause,
    outcome: input.outcome,
    worldTimeLabel: "Moments later",
    timeAdvanceMinutes: 1,
    stateChanges: input.rpgStateChange === null
      ? []
      : [{
          entityType: "plot",
          subject: "The current scene",
          summary: cause,
          facts: [],
          relatedEntities: [],
          causalBasis: [cause],
          visibility: "campaign",
        }],
    rpgStateChange: input.rpgStateChange ?? null,
    clockEvents: [],
    memories: [],
    propositions: [],
    storyMoves: [],
    progression: {
      actionScope: input.actionScope ?? "manipulation",
      resolvedAction: cause,
      objectiveImpact: "none",
      objectiveTargetsAdvanced: [],
      advancementSource: input.advancementSource ?? "none",
      causalSteps: input.rpgStateChange === null ? [] : [cause],
    },
    resolveClockEventIds: [],
    acknowledgedMaturedClockEventIds: [],
  });
}

function seedLineage(seed: CampaignSeed) {
  return {
    schemaVersion: 1,
    seedId: seed.seedId,
    seedSha256: campaignRpgSha256(seed),
    origin: seed.origin.kind,
    initialStateVersion: 0,
    baselineCampaignStateVersion: 1,
  };
}

async function database() {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.campaigns (
      id uuid PRIMARY KEY,
      state_version bigint NOT NULL,
      start_contract jsonb NOT NULL DEFAULT '{}'::jsonb
    );
  `);
  await ensureCampaignRpgPersistence(db);
  await db.query(
    `INSERT INTO storyhold.campaigns (id, state_version, start_contract)
     VALUES ($1, 1, '{}'::jsonb), ($2, 1, '{}'::jsonb)`,
    [CAMPAIGN_ID, LEGACY_CAMPAIGN_ID],
  );
  return db;
}

test("the local RPG modifier is frozen into the deterministic outcome", () => {
  const snapshot = persistedSnapshot("tactical");
  const action = "I lift the steel gate.";
  const check = buildLocalCampaignCheck({
    state: snapshot.state,
    actorId: snapshot.state.activeCharacterId,
    action,
    certainty: "check_required",
  });
  assert.equal(check.ability, "strength");
  assert.equal(check.modifier, 20);

  let selected: ReturnType<typeof envelope> | null = null;
  let unmodified: ReturnType<typeof envelope> | null = null;
  for (let index = 0; index < 200; index += 1) {
    const requestId = `modifier-check-${index}`;
    const withoutModifier = envelope({ requestId, action, modifier: 0 });
    const withModifier = envelope({ requestId, action, modifier: check.modifier });
    if (withoutModifier.resolution.band !== withModifier.resolution.band) {
      selected = withModifier;
      unmodified = withoutModifier;
      break;
    }
  }
  assert.ok(selected);
  assert.ok(unmodified);
  assert.equal(selected.resolution.modifier, 20);
  assert.notEqual(selected.resolution.band, unmodified.resolution.band);
  assert.equal(
    selected.resolution.effectivePercentile,
    Math.min(100, Number(selected.resolution.percentile) + check.modifier),
  );

  const mechanics = buildCampaignRpgTurnMechanics({
    snapshot,
    action,
    intent: "action",
    engineEnvelope: selected,
  });
  assert.equal(mechanics.stateVersion, 0);
  assert.equal(mechanics.check.modifier, 20);
  assert.equal(mechanics.playerCheck.numbers?.modifier, 20);
});

test("compound actions cannot borrow automatic success and solo players cannot author events", () => {
  assert.equal(turnOutcomeCertainty("action", "I nod."), "automatic_success");
  assert.equal(
    turnOutcomeCertainty("action", "I ask the guard to surrender and give me the vault key."),
    "check_required",
  );
  assert.equal(
    turnOutcomeCertainty("action", "I look around and steal the command key."),
    "check_required",
  );
  assert.equal(
    campaignIntentIsAllowed({ start_contract: { experienceMode: "solo" } }, "event"),
    false,
  );
  assert.equal(
    campaignIntentIsAllowed({ start_contract: { experienceMode: "author" } }, "event"),
    true,
  );
});

test("saved turn mechanics are rebound to the authoritative RPG snapshot on recovery", () => {
  const snapshot = persistedSnapshot("tactical");
  const action = "I lift the steel gate.";
  const check = buildLocalCampaignCheck({
    state: snapshot.state,
    actorId: snapshot.state.activeCharacterId,
    action,
    certainty: "check_required",
  });
  const frozenEnvelope = envelope({
    requestId: "recover-bound-check",
    action,
    modifier: check.modifier,
  });
  const rpg = buildCampaignRpgTurnMechanics({
    snapshot,
    action,
    intent: "action",
    engineEnvelope: frozenEnvelope,
  });
  const raw = {
    percentile: frozenEnvelope.fortune.percentile,
    d20: frozenEnvelope.fortune.d20,
    rpg,
  };
  assert.deepEqual(
    validateFrozenTurnMechanics({
      raw,
      context: { rpgSnapshot: snapshot } as never,
      action,
      intent: "action",
      engineEnvelope: frozenEnvelope,
    }),
    raw,
  );
  assert.throws(
    () => validateFrozenTurnMechanics({
      raw: { ...raw, rpg: { ...rpg, stateSha256: "0".repeat(64) } },
      context: { rpgSnapshot: snapshot } as never,
      action,
      intent: "action",
      engineEnvelope: frozenEnvelope,
    }),
    /TURN_REQUEST_RPG_BINDING_INVALID/,
  );
  assert.throws(
    () => validateFrozenTurnMechanics({
      raw: {
        ...raw,
        rpg: {
          ...rpg,
          rewardBudget: {
            ...rpg.rewardBudget,
            grants: [{
              grantId: "forged",
              source: { kind: "player_action" },
              kind: "objective_progress",
              objectiveId: "opening-objective",
              maximumAmount: 999,
            }],
          },
        },
      },
      context: { rpgSnapshot: snapshot } as never,
      action,
      intent: "action",
      engineEnvelope: frozenEnvelope,
    }),
    /TURN_REQUEST_RPG_BINDING_INVALID/,
  );

  const legacyEnvelope = envelope({
    requestId: "recover-legacy-check",
    action,
    modifier: 0,
  });
  assert.equal(
    validateFrozenTurnMechanics({
      raw: {
        percentile: legacyEnvelope.fortune.percentile,
        d20: legacyEnvelope.fortune.d20,
        rpg: null,
      },
      context: { rpgSnapshot: null } as never,
      action,
      intent: "action",
      engineEnvelope: legacyEnvelope,
    }).rpg,
    null,
  );
  assert.throws(
    () => validateFrozenTurnMechanics({
      raw: {
        percentile: legacyEnvelope.fortune.percentile,
        d20: legacyEnvelope.fortune.d20,
        rpg: null,
      },
      context: { rpgSnapshot: null } as never,
      action,
      intent: "action",
      engineEnvelope: envelope({
        requestId: "recover-legacy-check",
        action,
        modifier: 1,
      }),
    }),
    /TURN_REQUEST_RPG_BINDING_INVALID/,
  );
});

test("story-first turn and proposal JSON expose only their redacted check projection", () => {
  const snapshot = persistedSnapshot("story_first");
  const action = "I lift the steel gate.";
  const check = buildLocalCampaignCheck({
    state: snapshot.state,
    actorId: snapshot.state.activeCharacterId,
    action,
    certainty: "check_required",
  });
  const frozenEnvelope = envelope({
    requestId: "story-first-check",
    action,
    modifier: check.modifier,
    includeD20: false,
  });
  const mechanics = buildCampaignRpgTurnMechanics({
    snapshot,
    action,
    intent: "action",
    engineEnvelope: frozenEnvelope,
  });
  const turn = serializeTurn({
    id: "turn-1",
    turn_number: 1,
    player_action: action,
    intent_kind: "action",
    narration: "Mara strains against the steel gate until it finally begins to move.",
    scene_summary: "Mara moves the gate.",
    outcome: frozenEnvelope.resolution.outcome,
    world_time_label: "Moments later",
    reasoning_level: "low",
    mechanics: {
      percentile: frozenEnvelope.fortune.percentile,
      d20: frozenEnvelope.fortune.d20,
      resolutionMode: "story_first",
      show: false,
      rpg: mechanics,
    },
  });
  assert.equal(turn.check?.mode, "story_first");
  assert.equal(turn.roll, null);
  assert.equal(turn.check?.numbers, undefined);
  assert.equal(turn.check?.breakdown, undefined);
  assert.equal(turn.check?.factors, undefined);
  assert.equal(turn.check?.difficulty, undefined);
  assert.equal(JSON.stringify(turn).includes("rewardBudget"), false);

  const privateChange = {
    causalBasis: ["Mara reaches the inner airlock."],
    location: { entityId: null, name: "Inner Airlock", zone: null },
  };
  const proposal = serializeTurnProposal({
    id: "proposal-1",
    request_id: "proposal-request-1",
    player_input: action,
    intent_kind: "action",
    narration: "Mara reaches the inner airlock after forcing the gate aside.",
    direction: {
      ...resolution({
        outcome: "success",
        cause: "Mara reaches the inner airlock.",
        rpgStateChange: privateChange,
      }),
      narration: undefined,
    },
    rpg_check_view: mechanics.playerCheck,
    revision: 1,
    status: "pending",
    base_state_version: 1,
    credits_used: 0,
    director_provider: "openai",
    director_model: "director",
    director_reasoning: "low",
    narrator_provider: "openai",
    narrator_model: "narrator",
    narrator_reasoning: "low",
  });
  assert.equal(proposal.check?.mode, "story_first");
  assert.equal(proposal.roll, null);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      proposal.browserNarrationTask?.direction ?? {},
      "rpgStateChange",
    ),
    false,
  );
  assert.equal(JSON.stringify(proposal).includes("rpgStateChange"), false);
  assert.equal(JSON.stringify(proposal).includes("rewardBudget"), false);
});

test("frozen objective allowances distinguish failure, mixed progress, completion, and unrelated success", () => {
  const snapshot = persistedSnapshot("light_rules");
  const objective = snapshot.state.objectives[0]!;
  const action = "I proceed to the Inner Airlock.";
  const progression = {
    action,
    actionScope: "movement" as const,
    objectiveTargets: ["inner", "airlock"],
    explicitObjectiveAttempt: true,
    maximumObjectiveImpact: "completion" as const,
  };

  let successEnvelope: ReturnType<typeof envelope> | null = null;
  let mixedEnvelope: ReturnType<typeof envelope> | null = null;
  let failureEnvelope: ReturnType<typeof envelope> | null = null;
  for (let index = 0; index < 500; index += 1) {
    const candidate = envelope({ requestId: `objective-band-${index}`, ...progression });
    if (candidate.resolution.outcome === "success" && !successEnvelope) successEnvelope = candidate;
    if (candidate.resolution.outcome === "mixed" && !mixedEnvelope) mixedEnvelope = candidate;
    if (candidate.resolution.outcome === "failure" && !failureEnvelope) failureEnvelope = candidate;
    if (successEnvelope && mixedEnvelope && failureEnvelope) break;
  }
  assert.ok(successEnvelope);
  assert.ok(mixedEnvelope);
  assert.ok(failureEnvelope);

  const successMechanics = buildCampaignRpgTurnMechanics({
    snapshot,
    action,
    intent: "action",
    engineEnvelope: successEnvelope,
  });
  const successGrant = successMechanics.rewardBudget.grants.find((grant) =>
    grant.kind === "objective_progress",
  );
  assert.ok(successGrant && successGrant.kind === "objective_progress");
  assert.equal(successGrant.maximumAmount, objective.target - objective.progress);

  const mixedMechanics = buildCampaignRpgTurnMechanics({
    snapshot,
    action,
    intent: "action",
    engineEnvelope: mixedEnvelope,
  });
  const mixedGrant = mixedMechanics.rewardBudget.grants.find((grant) =>
    grant.kind === "objective_progress",
  );
  assert.ok(mixedGrant && mixedGrant.kind === "objective_progress");
  assert.equal(mixedGrant.maximumAmount, 1);

  const failureMechanics = buildCampaignRpgTurnMechanics({
    snapshot,
    action,
    intent: "action",
    engineEnvelope: failureEnvelope,
  });
  assert.equal(failureMechanics.rewardBudget.grants.length, 0);

  const unrelatedAction = "I smile.";
  const unrelatedEnvelope = envelope({
    requestId: "unrelated-objective-success",
    action: unrelatedAction,
    certainty: "automatic_success",
    actionScope: "other",
    objectiveTargets: ["inner", "airlock"],
    explicitObjectiveAttempt: false,
    maximumObjectiveImpact: "clue",
  });
  const unrelatedMechanics = buildCampaignRpgTurnMechanics({
    snapshot,
    action: unrelatedAction,
    intent: "action",
    engineEnvelope: unrelatedEnvelope,
  });
  assert.equal(unrelatedMechanics.rewardBudget.grants.length, 0);
});

test("successful state movement is evidence-bound while positive rewards fail closed", () => {
  const snapshot = persistedSnapshot("light_rules");
  const cause = "Mara reaches the inner airlock.";
  const playerAction = "I move to the Inner Airlock.";
  const successEnvelope = envelope({
    certainty: "automatic_success",
    action: playerAction,
    actionScope: "movement",
  });
  const movement = resolution({
    outcome: "success",
    cause,
    advancementSource: "player_action",
    actionScope: "movement",
    rpgStateChange: {
      causalBasis: [cause],
      location: { entityId: null, name: "Inner Airlock", zone: null },
    },
  });
  const delta = buildAcceptedRpgDeltaForResolution({
    snapshot,
    resolution: movement,
    turnRequestId: "accepted-movement",
    engineEnvelope: successEnvelope,
    playerAction,
    knownLocationNames: ["Inner Airlock"],
  });
  const next = applyCampaignRpgStateDelta(snapshot.state, delta);
  assert.equal(next.location.name, "Inner Airlock");
  assert.equal(next.stateVersion, 1);

  const reward = resolution({
    outcome: "success",
    cause,
    advancementSource: "player_action",
    rpgStateChange: {
      causalBasis: [cause],
      objectiveChanges: [{
        kind: "progress",
        objectiveId: "opening-objective",
        amount: 1,
      }],
    },
  });
  assert.throws(
    () => buildAcceptedRpgDeltaForResolution({
      snapshot,
      resolution: reward,
      turnRequestId: "unbudgeted-reward",
      engineEnvelope: successEnvelope,
      playerAction,
      knownLocationNames: ["Inner Airlock"],
    }),
    /CAMPAIGN_RPG_REWARD_NOT_AUTHORIZED/,
  );
});

test("Director advancement claims cannot bypass rewards and injuries remain bounded", () => {
  const snapshot = persistedSnapshot("light_rules");
  const cause = "The reactor surge catches Mara in the doorway.";
  const failureEnvelope = envelope({ certainty: "automatic_failure" });
  const fakeWorldReward = resolution({
    outcome: "failure",
    cause,
    advancementSource: "established_state",
    rpgStateChange: {
      causalBasis: [cause],
      objectiveChanges: [{
        kind: "progress",
        objectiveId: "opening-objective",
        amount: 1,
      }],
    },
  });
  assert.throws(
    () => buildAcceptedRpgDeltaForResolution({
      snapshot,
      resolution: fakeWorldReward,
      turnRequestId: "fake-established-state",
      engineEnvelope: failureEnvelope,
      playerAction: "I lift the steel gate.",
      knownLocationNames: [],
    }),
    /CAMPAIGN_RPG_REWARD_NOT_AUTHORIZED/,
  );

  const boundedInjury = resolution({
    outcome: "failure",
    cause,
    rpgStateChange: {
      causalBasis: [cause],
      characterChanges: [{ characterId: ACTOR_ID, vitalityChange: -3 }],
    },
  });
  assert.doesNotThrow(() => buildAcceptedRpgDeltaForResolution({
    snapshot,
    resolution: boundedInjury,
    turnRequestId: "bounded-injury",
    engineEnvelope: failureEnvelope,
    playerAction: "I lift the steel gate.",
    knownLocationNames: [],
  }));

  const excessiveInjury = resolution({
    outcome: "failure",
    cause,
    rpgStateChange: {
      causalBasis: [cause],
      characterChanges: [{ characterId: ACTOR_ID, vitalityChange: -4 }],
    },
  });
  assert.throws(
    () => assertDirectorRpgMutationPolicy({
      snapshot,
      proposed: excessiveInjury.rpgStateChange,
      engineEnvelope: failureEnvelope,
      playerAction: "I lift the steel gate.",
      knownLocationNames: [],
    }),
    /CAMPAIGN_RPG_CONSEQUENCE_BUDGET_EXCEEDED/,
  );

  const stackedInjury = resolution({
    outcome: "failure",
    cause,
    rpgStateChange: {
      causalBasis: [cause],
      characterChanges: [{
        characterId: ACTOR_ID,
        vitalityChange: -2,
        stressChange: 2,
      }],
    },
  });
  assert.throws(
    () => assertDirectorRpgMutationPolicy({
      snapshot,
      proposed: stackedInjury.rpgStateChange,
      engineEnvelope: failureEnvelope,
      playerAction: "I lift the steel gate.",
      knownLocationNames: [],
    }),
    /CAMPAIGN_RPG_CONSEQUENCE_BUDGET_EXCEEDED: aggregate/,
  );

  const successfulPunishment = resolution({
    outcome: "success",
    cause,
    rpgStateChange: {
      causalBasis: [cause],
      characterChanges: [{ characterId: ACTOR_ID, vitalityChange: -1 }],
    },
  });
  assert.throws(
    () => assertDirectorRpgMutationPolicy({
      snapshot,
      proposed: successfulPunishment.rpgStateChange,
      engineEnvelope: envelope({ certainty: "automatic_success" }),
      playerAction: "I lift the steel gate.",
      knownLocationNames: [],
    }),
    /CAMPAIGN_RPG_CONSEQUENCE_BUDGET_EXCEEDED/,
  );

  assert.throws(
    () => assertDirectorRpgMutationPolicy({
      snapshot,
      proposed: {
        causalBasis: [cause],
        location: { entityId: null, name: "Invented Palace", zone: null },
      },
      engineEnvelope: envelope({
        certainty: "automatic_success",
        action: "I move to the Invented Palace.",
        actionScope: "movement",
      }),
      playerAction: "I move to the Invented Palace.",
      knownLocationNames: [],
    }),
    /CAMPAIGN_RPG_LOCATION_CHANGE_NOT_AUTHORIZED/,
  );

  assert.throws(
    () => assertDirectorRpgMutationPolicy({
      snapshot,
      proposed: {
        causalBasis: [cause],
        characterChanges: [{
          characterId: ACTOR_ID,
          addConditions: [{
            id: "blessed",
            name: "Blessed",
            description: "A disguised positive reward.",
            checkEffects: [{
              id: "blessing",
              label: "Blessing",
              modifier: 20,
              abilities: [],
              capabilities: [],
            }],
          }],
        }],
      },
      engineEnvelope: failureEnvelope,
      playerAction: "I lift the steel gate.",
      knownLocationNames: [],
    }),
    /CAMPAIGN_RPG_REWARD_NOT_AUTHORIZED/,
  );
});

test("a no-op acceptance advances only the aligned RPG turn marker", () => {
  const snapshot = persistedSnapshot("story_first");
  const noOp = resolution({ outcome: "none", rpgStateChange: null });
  const delta = buildAcceptedRpgDeltaForResolution({
    snapshot,
    resolution: noOp,
    turnRequestId: "accepted-question",
    engineEnvelope: envelope({
      certainty: "not_applicable",
      action: "I ask what time it is.",
      intent: "question",
    }),
    playerAction: "I ask what time it is.",
    knownLocationNames: [],
  });
  assert.deepEqual(delta, {
    expectedStateVersion: 0,
    reason: "Accepted campaign turn accepted-question.",
    turnAccepted: true,
  });
  const next = applyCampaignRpgStateDelta(snapshot.state, delta);
  assert.equal(next.stateVersion, 1);
  assert.equal(next.location.name, snapshot.state.location.name);
  assert.deepEqual(next.characters, snapshot.state.characters);
});

test("legacy campaigns remain playable, while initialized state requires its immutable pointer", async () => {
  const db = await database();
  try {
    const legacy = await loadCampaignRpgRuntime({
      db,
      campaign: {
        id: LEGACY_CAMPAIGN_ID,
        state_version: 1,
        start_contract: {},
      },
    });
    assert.equal(legacy, null);

    const seed = campaignSeed("light_rules");
    await initializeCampaignRpgState({ db, campaignId: CAMPAIGN_ID, seed });
    await assert.rejects(
      loadCampaignRpgRuntime({
        db,
        campaign: {
          id: CAMPAIGN_ID,
          state_version: 1,
          start_contract: {},
        },
      }),
      /CAMPAIGN_RPG_LINEAGE_MISSING/,
    );
    const startContract = { version: 8, rpgSeed: seedLineage(seed) };
    await db.query(
      "UPDATE storyhold.campaigns SET start_contract = $2::jsonb WHERE id = $1",
      [CAMPAIGN_ID, JSON.stringify(startContract)],
    );
    const loaded = await loadCampaignRpgRuntime({
      db,
      campaign: {
        id: CAMPAIGN_ID,
        state_version: 1,
        start_contract: startContract,
      },
    });
    assert.equal(loaded?.snapshot.state.stateVersion, 0);
  } finally {
    await db.close();
  }
});

test("non-turn campaign state changes do not corrupt the independent RPG journal", async () => {
  const db = await database();
  try {
    const seed = campaignSeed("light_rules");
    const startContract = { version: 8, rpgSeed: seedLineage(seed) };
    await db.query(
      "UPDATE storyhold.campaigns SET start_contract = $2::jsonb, state_version = 17 WHERE id = $1",
      [CAMPAIGN_ID, JSON.stringify(startContract)],
    );
    await initializeCampaignRpgState({ db, campaignId: CAMPAIGN_ID, seed });
    const loaded = await loadCampaignRpgRuntime({
      db,
      campaign: {
        id: CAMPAIGN_ID,
        state_version: 17,
        start_contract: startContract,
      },
    });
    assert.equal(loaded?.snapshot.state.stateVersion, 0);

    const accepted = resolution({ outcome: "none", rpgStateChange: null });
    const delta = buildAcceptedRpgDeltaForResolution({
      snapshot: loaded!.snapshot,
      resolution: accepted,
      turnRequestId: "atomic-no-op",
      engineEnvelope: envelope({
        certainty: "not_applicable",
        action: "I ask what time it is.",
        intent: "question",
      }),
      playerAction: "I ask what time it is.",
      knownLocationNames: [],
    });
    await assert.rejects(
      db.transaction(async (tx) => {
        await commitCampaignRpgStateDeltaInTransaction({
          db: tx,
          campaignId: CAMPAIGN_ID,
          requestId: "campaign-turn:atomic-no-op",
          delta,
        });
        await tx.query(
          "UPDATE storyhold.campaigns SET state_version = state_version + 1 WHERE id = $1",
          [CAMPAIGN_ID],
        );
        throw new Error("ROLL_BACK_ACCEPTANCE");
      }),
      /ROLL_BACK_ACCEPTANCE/,
    );
    assert.equal((await loadCampaignRpgSnapshot(db, CAMPAIGN_ID)).state.stateVersion, 0);
    assert.equal((await loadCampaignRpgStateEvents(db, CAMPAIGN_ID)).length, 0);

    const committed = await db.transaction(async (tx) => {
      const result = await commitCampaignRpgStateDeltaInTransaction({
        db: tx,
        campaignId: CAMPAIGN_ID,
        requestId: "campaign-turn:atomic-no-op",
        delta,
      });
      await tx.query(
        "UPDATE storyhold.campaigns SET state_version = state_version + 1 WHERE id = $1",
        [CAMPAIGN_ID],
      );
      return result;
    });
    assert.equal(committed.replayed, false);
    assert.equal(committed.state.stateVersion, 1);
    const replay = await db.transaction((tx) =>
      commitCampaignRpgStateDeltaInTransaction({
        db: tx,
        campaignId: CAMPAIGN_ID,
        requestId: "campaign-turn:atomic-no-op",
        delta,
      })
    );
    assert.equal(replay.replayed, true);
    assert.equal((await loadCampaignRpgStateEvents(db, CAMPAIGN_ID)).length, 1);

    const afterManualCampaignAdvance = await loadCampaignRpgRuntime({
      db,
      campaign: {
        id: CAMPAIGN_ID,
        state_version: 99,
        start_contract: startContract,
      },
    });
    assert.equal(afterManualCampaignAdvance?.snapshot.state.stateVersion, 1);
  } finally {
    await db.close();
  }
});

test("preparing checks and deltas does not mutate persisted RPG state", async () => {
  const db = await database();
  try {
    const seed = campaignSeed("tactical");
    await initializeCampaignRpgState({ db, campaignId: CAMPAIGN_ID, seed });
    const snapshot = await loadCampaignRpgSnapshot(db, CAMPAIGN_ID);
    const action = "I lift the steel gate.";
    const check = buildLocalCampaignCheck({
      state: snapshot.state,
      actorId: snapshot.state.activeCharacterId,
      action,
      certainty: "check_required",
    });
    const frozenEnvelope = envelope({ action, modifier: check.modifier });
    buildCampaignRpgTurnMechanics({
      snapshot,
      action,
      intent: "action",
      engineEnvelope: frozenEnvelope,
    });
    buildAcceptedRpgDeltaForResolution({
      snapshot,
      resolution: resolution({ outcome: "none", rpgStateChange: null }),
      turnRequestId: "draft-only",
      engineEnvelope: envelope({
        certainty: "not_applicable",
        action: "I ask what time it is.",
        intent: "question",
      }),
      playerAction: "I ask what time it is.",
      knownLocationNames: [],
    });
    assert.equal((await loadCampaignRpgSnapshot(db, CAMPAIGN_ID)).state.stateVersion, 0);
    assert.equal((await loadCampaignRpgStateEvents(db, CAMPAIGN_ID)).length, 0);
  } finally {
    await db.close();
  }
});

test("player RPG projection never includes immutable seed facts or raw stats", () => {
  const view = projectCampaignRpgForPlayer(persistedSnapshot("story_first"));
  const serialized = JSON.stringify(view);
  assert.ok(view);
  assert.equal(serialized.includes("private-seed-fact"), false);
  assert.equal(serialized.includes("hidden command key"), false);
  assert.equal(serialized.includes("strength"), false);
  assert.equal(serialized.includes("stateSha256"), false);
});

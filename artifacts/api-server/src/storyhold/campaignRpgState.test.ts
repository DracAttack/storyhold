import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCampaignRpgStateDelta,
  buildCampaignRelevantCheck,
  CampaignRpgValidationError,
  createInitialCampaignRpgState,
  normalizeCampaignRpgState,
  normalizeCampaignSeed,
  projectCampaignCheckResolution,
  resolveCampaignRelevantCheck,
  STORYHOLD_STAT_NAMES,
  validateCampaignRpgStateDelta,
  type CampaignRules,
  type CampaignSeedDraft,
  type CharacterRpgState,
} from "./campaignRpgState";

function character(
  characterId: string,
  name: string,
  overrides: Partial<CharacterRpgState> = {},
): CampaignSeedDraft["initialState"]["characters"][number] {
  return {
    characterId,
    name,
    stats: {
      strength: 10,
      dexterity: 10,
      constitution: 10,
      intelligence: 10,
      wisdom: 10,
      charisma: 10,
      acrobatics: 10,
      ...(overrides.stats ?? {}),
    },
    vitality: overrides.vitality ?? { current: 10, maximum: 10 },
    harms: overrides.harms ?? [],
    stress: overrides.stress ?? { current: 0, maximum: 10 },
    conditions: overrides.conditions ?? [],
    resources: overrides.resources ?? [],
    inventory: overrides.inventory ?? [],
    equipment: overrides.equipment ?? [],
    capabilities: overrides.capabilities ?? [],
  };
}

function importedSeedDraft(): CampaignSeedDraft {
  return {
    seedId: "ashes-start-at-sanctuary",
    origin: {
      kind: "imported",
      worldId: "ashes-world",
      editionId: "ashes-and-embers-edition",
      canonAnchor: "book-one:chapter-one",
    },
    world: {
      name: "Ashes of the Earth",
      premise: "Alec reaches Sanctuary after the world ends.",
      facts: [{
        id: "fact-alec-echo",
        subject: "Alec Sumner",
        predicate: "shares a symbiotic bond with",
        object: "Echo",
        provenance: "manuscript",
      }],
    },
    rules: { resolutionMode: "story_first" },
    initialState: {
      activeCharacterId: "alec",
      characters: [character("alec", "Alec Sumner")],
      location: { entityId: "sanctuary", name: "Sanctuary", zone: "Northern Gate" },
      companions: [],
      reputations: [],
      objectives: [{
        id: "reach-safety",
        title: "Reach Safety",
        description: "Find defensible shelter.",
        status: "active",
        progress: 0,
        target: 2,
      }],
      sharedResources: [{ id: "food", name: "Food", current: 3, maximum: 8 }],
    },
  };
}

test("one normalized campaign seed represents an imported manuscript world and is deeply immutable", () => {
  const draft = importedSeedDraft();
  const seed = normalizeCampaignSeed(draft);

  assert.equal(seed.origin.kind, "imported");
  assert.equal(seed.origin.canonAnchor, "book-one:chapter-one");
  assert.equal(seed.world.facts[0]!.locked, true);
  assert.deepEqual(Object.keys(seed.initialState.characters[0]!.stats), STORYHOLD_STAT_NAMES);
  assert.equal(seed.initialState.characters[0]!.stats.strength, 10);
  assert.ok(Object.isFrozen(seed));
  assert.ok(Object.isFrozen(seed.world));
  assert.ok(Object.isFrozen(seed.world.facts));
  assert.ok(Object.isFrozen(seed.initialState.characters[0]!.stats));

  draft.world.name = "Mutated outside";
  draft.world.facts![0]!.object = "Someone else";
  assert.equal(seed.world.name, "Ashes of the Earth");
  assert.equal(seed.world.facts[0]!.object, "Echo");
});

test("the same seed contract accepts a generated original adventure", () => {
  const seed = normalizeCampaignSeed({
    seedId: "original-001",
    origin: { kind: "original", generatorVersion: "seed-builder-v1" },
    world: {
      name: "The Clockwork Sea",
      premise: "Pirates sail between mechanical islands.",
      facts: [{
        id: "fact-sea",
        subject: "The Clockwork Sea",
        predicate: "contains",
        object: "mechanical islands",
        provenance: "generated",
      }],
    },
    initialState: {
      activeCharacterId: "captain",
      characters: [character("captain", "Captain Vale")],
      location: { entityId: null, name: "Brasswater Harbor", zone: null },
    },
  });

  assert.deepEqual(seed.origin, {
    kind: "original",
    worldId: null,
    generatorVersion: "seed-builder-v1",
  });
  assert.equal(seed.rules.resolutionMode, "story_first");
  assert.equal(seed.world.facts[0]!.locked, true);
});

test("seed normalization rejects unlocked canon and invalid equipment references", () => {
  const unlocked = importedSeedDraft();
  unlocked.world.facts![0]!.locked = false;
  assert.throws(
    () => normalizeCampaignSeed(unlocked),
    (error: unknown) =>
      error instanceof CampaignRpgValidationError &&
      error.issues[0]?.code === "INVARIANT_VIOLATION",
  );

  const badEquipment = importedSeedDraft();
  badEquipment.initialState.characters[0]!.equipment = [{ slot: "hand", itemId: "missing" }];
  assert.throws(
    () => normalizeCampaignSeed(badEquipment),
    (error: unknown) =>
      error instanceof CampaignRpgValidationError &&
      error.issues[0]?.code === "MISSING_REFERENCE",
  );
});

test("runtime state is an isolated copy and a broad valid delta advances it atomically", () => {
  const seed = normalizeCampaignSeed(importedSeedDraft());
  const initial = createInitialCampaignRpgState(seed);
  const next = applyCampaignRpgStateDelta(initial, {
    expectedStateVersion: 0,
    reason: "Alec forces the gate and earns the watch's trust.",
    location: { entityId: "sanctuary", name: "Sanctuary", zone: "Inside the Gate" },
    characterChanges: [{
      characterId: "alec",
      vitalityChange: -2,
      stressChange: 3,
      addHarms: [{ id: "bruised-ribs", name: "Bruised Ribs", severity: 2, description: "Painful breathing." }],
      addConditions: [{
        id: "winded",
        name: "Winded",
        description: "Needs a moment to recover.",
        checkEffects: [{
          id: "winded-constitution",
          label: "Short of Breath",
          modifier: -3,
          abilities: ["constitution"],
          capabilities: [],
        }],
      }],
      resourceChanges: [{
        kind: "add",
        pool: { id: "ammo", name: "Ammunition", current: 6, maximum: 12 },
      }],
      inventoryChanges: [
        {
          kind: "add",
          item: {
            id: "crowbar",
            name: "Crowbar",
            quantity: 1,
            description: "A useful lever.",
            tags: ["Tool"],
            checkEffects: [{
              id: "leverage",
              label: "Leverage",
              modifier: 4,
              abilities: ["strength"],
              capabilities: [],
            }],
          },
        },
        { kind: "equip", itemId: "crowbar", slot: "hands" },
      ],
      capabilityChanges: [{
        kind: "add",
        capability: { id: "salvage", name: "Salvage", rank: 1, description: "Makes use of ruins." },
      }],
    }],
    sharedResourceChanges: [{ kind: "adjust", poolId: "food", amount: -1 }],
    companionChanges: [{
      kind: "add",
      companion: { id: "echo", entityId: "echo-entity", name: "Echo", status: "present", loyalty: 80 },
    }],
    reputationChanges: [{
      kind: "add",
      reputation: { targetId: "sanctuary-watch", targetName: "Sanctuary Watch", score: 10 },
    }],
    objectiveChanges: [{ kind: "progress", objectiveId: "reach-safety", amount: 2 }],
  });

  assert.equal(next.stateVersion, 1);
  assert.deepEqual(next.location, { entityId: "sanctuary", name: "Sanctuary", zone: "Inside the Gate" });
  assert.deepEqual(next.characters[0]!.vitality, { current: 8, maximum: 10 });
  assert.equal(next.characters[0]!.stress.current, 3);
  assert.equal(next.characters[0]!.harms[0]!.name, "Bruised Ribs");
  assert.equal(next.characters[0]!.inventory[0]!.tags[0], "tool");
  assert.deepEqual(next.characters[0]!.equipment, [{ slot: "hands", itemId: "crowbar" }]);
  assert.equal(next.sharedResources[0]!.current, 2);
  assert.equal(next.objectives[0]!.status, "completed");
  assert.equal(next.companions[0]!.name, "Echo");
  assert.equal(next.reputations[0]!.score, 10);
  assert.ok(Object.isFrozen(next));
  assert.ok(Object.isFrozen(next.characters[0]!.inventory));

  assert.equal(initial.stateVersion, 0);
  assert.equal(initial.characters[0]!.vitality.current, 10);
  assert.equal(initial.characters[0]!.inventory.length, 0);
  assert.equal(seed.initialState.characters[0]!.vitality.current, 10);
  assert.equal(seed.initialState.objectives[0]!.status, "active");
});

test("a server-owned accepted-turn boundary advances history without inventing state", () => {
  const state = createInitialCampaignRpgState(normalizeCampaignSeed(importedSeedDraft()));
  const next = applyCampaignRpgStateDelta(state, {
    expectedStateVersion: 0,
    reason: "The accepted scene did not alter a tracked RPG value.",
    turnAccepted: true,
  });

  assert.equal(next.stateVersion, 1);
  assert.deepEqual({ ...next, stateVersion: 0 }, state);
  assert.throws(
    () => applyCampaignRpgStateDelta(state, {
      expectedStateVersion: 0,
      reason: "Invalid boundary.",
      turnAccepted: false as never,
    }),
    /turnAccepted/,
  );
});

test("state deltas reject stale writes, unknown seed fields, bound violations, and equipped deletion", () => {
  const state = createInitialCampaignRpgState(normalizeCampaignSeed(importedSeedDraft()));
  assert.throws(
    () => applyCampaignRpgStateDelta(state, {
      expectedStateVersion: 1,
      reason: "stale",
      location: state.location,
    }),
    (error: unknown) =>
      error instanceof CampaignRpgValidationError &&
      error.issues[0]?.code === "STATE_VERSION_MISMATCH",
  );
  assert.throws(
    () => applyCampaignRpgStateDelta(state, {
      expectedStateVersion: 0,
      reason: "try to rewrite canon",
      location: state.location,
      world: { facts: [] },
    } as never),
    (error: unknown) =>
      error instanceof CampaignRpgValidationError &&
      error.issues[0]?.code === "UNKNOWN_FIELD",
  );
  const validation = validateCampaignRpgStateDelta(state, {
    expectedStateVersion: 0,
    reason: "impossible damage",
    characterChanges: [{ characterId: "alec", vitalityChange: -11 }],
  });
  assert.equal(validation.ok, false);
  if (!validation.ok) assert.equal(validation.issues[0]!.code, "INVARIANT_VIOLATION");
  assert.equal(state.characters[0]!.vitality.current, 10);

  const armedDraft = importedSeedDraft();
  armedDraft.initialState.characters[0]!.inventory = [{
    id: "knife",
    name: "Knife",
    quantity: 1,
    description: "",
    tags: [],
    checkEffects: [],
  }];
  armedDraft.initialState.characters[0]!.equipment = [{ slot: "hand", itemId: "knife" }];
  const armed = createInitialCampaignRpgState(normalizeCampaignSeed(armedDraft));
  assert.throws(
    () => applyCampaignRpgStateDelta(armed, {
      expectedStateVersion: 0,
      reason: "drop it incorrectly",
      characterChanges: [{
        characterId: "alec",
        inventoryChanges: [{ kind: "remove", itemId: "knife" }],
      }],
    }),
    (error: unknown) =>
      error instanceof CampaignRpgValidationError &&
      error.issues[0]?.code === "INVARIANT_VIOLATION",
  );
});

function checkState() {
  const draft = importedSeedDraft();
  draft.initialState.characters = [
    character("alec", "Alec", {
      stats: {
        strength: 10,
        dexterity: 14,
        constitution: 10,
        intelligence: 10,
        wisdom: 10,
        charisma: 10,
        acrobatics: 10,
      },
      capabilities: [{ id: "stealth", name: "Stealth", rank: 2, description: "Moves quietly." }],
      inventory: [{
        id: "soft-boots",
        name: "Soft Boots",
        quantity: 1,
        description: "Muffle footfalls.",
        tags: ["footwear"],
        checkEffects: [{
          id: "quiet-soles",
          label: "Quiet Soles",
          modifier: 3,
          abilities: ["dexterity"],
          capabilities: ["stealth"],
        }],
      }],
      equipment: [{ slot: "feet", itemId: "soft-boots" }],
      conditions: [{
        id: "shaken",
        name: "Shaken",
        description: "Nerves interfere with careful movement.",
        checkEffects: [{
          id: "unsteady",
          label: "Unsteady",
          modifier: -4,
          abilities: ["dexterity"],
          capabilities: [],
        }],
      }],
    }),
    character("lilly", "Lilly", {
      stats: {
        strength: 10,
        dexterity: 12,
        constitution: 10,
        intelligence: 10,
        wisdom: 10,
        charisma: 10,
        acrobatics: 10,
      },
      capabilities: [{ id: "stealth", name: "Stealth", rank: 1, description: "Knows concealment." }],
    }),
    character("guard", "Gate Guard", {
      stats: {
        strength: 10,
        dexterity: 13,
        constitution: 10,
        intelligence: 10,
        wisdom: 10,
        charisma: 10,
        acrobatics: 10,
      },
      capabilities: [{ id: "stealth", name: "Stealth", rank: 1, description: "Watches shadows." }],
    }),
  ];
  return createInitialCampaignRpgState(normalizeCampaignSeed(draft));
}

test("a relevant check deterministically uses stats, capability, equipment, assistance, difficulty, opposition, and conditions", () => {
  const state = checkState();
  const check = buildCampaignRelevantCheck(state, {
    actorId: "alec",
    ability: "dexterity",
    capabilityId: "stealth",
    difficulty: "hard",
    assistingCharacterIds: ["lilly"],
    opposition: { characterId: "guard" },
  });

  assert.deepEqual(
    check.contributions.map(({ source, value }) => [source, value]),
    [
      ["ability", 8],
      ["capability", 8],
      ["equipment", 3],
      ["assistance", 4],
      ["difficulty", -10],
      ["opposition", -15],
      ["condition", -4],
    ],
  );
  assert.equal(check.rawModifier, -6);
  assert.equal(check.modifier, -6);
  assert.ok(Object.isFrozen(check));

  const resolution = resolveCampaignRelevantCheck(check, {
    seedCommitment: "server-created-commitment",
    percentile: 70,
    d20: 14,
  });
  assert.equal(resolution.result.effectivePercentile, 64);
  assert.equal(resolution.result.outcome, "mixed");
  assert.equal(resolution.result.band, "mixed");
});

test("only applicable equipped effects and conditions contribute", () => {
  const state = checkState();
  const check = buildCampaignRelevantCheck(state, {
    actorId: "alec",
    ability: "strength",
    difficulty: "standard",
  });
  assert.deepEqual(
    check.contributions.map((entry) => entry.source),
    ["ability", "difficulty"],
  );
});

test("mechanical modifiers are capped and automatic results do not consult fortune", () => {
  const draft = importedSeedDraft();
  draft.initialState.characters = [character("alec", "Alec", {
    stats: {
      strength: 20,
      dexterity: 10,
      constitution: 10,
      intelligence: 10,
      wisdom: 10,
      charisma: 10,
      acrobatics: 10,
    },
    capabilities: [{ id: "force", name: "Force", rank: 5, description: "" }],
  })];
  const state = createInitialCampaignRpgState(normalizeCampaignSeed(draft));
  const check = buildCampaignRelevantCheck(state, {
    actorId: "alec",
    ability: "strength",
    capabilityId: "force",
    difficulty: "trivial",
    certainty: "automatic_success",
  });
  assert.equal(check.rawModifier, 60);
  assert.equal(check.modifier, 40);
  const result = resolveCampaignRelevantCheck(check, null);
  assert.equal(result.result.outcome, "success");
  assert.equal(result.result.percentile, null);
});

test("check requests cannot provide arbitrary bonuses, rolls, outcomes, or invalid participants", () => {
  const state = checkState();
  assert.throws(
    () => buildCampaignRelevantCheck(state, {
      actorId: "alec",
      ability: "dexterity",
      difficulty: "standard",
      modifier: 99,
      roll: 100,
      outcome: "success",
    } as never),
    (error: unknown) =>
      error instanceof CampaignRpgValidationError &&
      error.issues[0]?.code === "UNKNOWN_FIELD",
  );
  assert.throws(
    () => buildCampaignRelevantCheck(state, {
      actorId: "alec",
      ability: "dexterity",
      difficulty: "standard",
      assistingCharacterIds: ["alec"],
    }),
    (error: unknown) =>
      error instanceof CampaignRpgValidationError &&
      error.issues[0]?.code === "INVARIANT_VIOLATION",
  );
});

const MODES: Record<"story" | "light" | "tactical" | "custom", CampaignRules> = {
  story: {
    resolutionMode: "story_first",
    customCheckVisibility: {
      showOutcome: true, showBand: true, showDifficulty: true, showFactors: true,
      showNumbers: true, showBreakdown: true, showD20: true,
    },
  },
  light: {
    resolutionMode: "light_rules",
    customCheckVisibility: {
      showOutcome: false, showBand: false, showDifficulty: false, showFactors: false,
      showNumbers: false, showBreakdown: false, showD20: false,
    },
  },
  tactical: {
    resolutionMode: "tactical",
    customCheckVisibility: {
      showOutcome: false, showBand: false, showDifficulty: false, showFactors: false,
      showNumbers: false, showBreakdown: false, showD20: false,
    },
  },
  custom: {
    resolutionMode: "custom",
    customCheckVisibility: {
      showOutcome: false,
      showBand: false,
      showDifficulty: true,
      showFactors: false,
      showNumbers: true,
      showBreakdown: false,
      showD20: false,
    },
  },
};

test("story-first, light, tactical, and custom projections reveal only intended mechanics", () => {
  const check = buildCampaignRelevantCheck(checkState(), {
    actorId: "alec",
    ability: "dexterity",
    capabilityId: "stealth",
    difficulty: "hard",
  });
  const resolution = resolveCampaignRelevantCheck(check, {
    seedCommitment: "server-created-commitment",
    percentile: 70,
    d20: 14,
  });

  const story = projectCampaignCheckResolution(resolution, MODES.story);
  assert.deepEqual(story, { mode: "story_first", result: { outcome: "success" } });

  const light = projectCampaignCheckResolution(resolution, MODES.light);
  assert.equal(light.result?.outcome, "success");
  assert.equal(light.result?.band, "success");
  assert.equal(light.difficulty, "hard");
  assert.ok(light.factors?.some((factor) => factor.influence === "helps"));
  assert.ok(light.factors?.some((factor) => factor.influence === "hinders"));
  assert.ok(light.factors?.some((factor) => factor.label === "Dexterity"));
  assert.ok(light.factors?.some((factor) => factor.label === "Stealth"));
  assert.equal(light.factors?.some((factor) => /\d|\bRank\b/iu.test(factor.label)), false);
  assert.equal("numbers" in light, false);
  assert.equal("breakdown" in light, false);

  const tactical = projectCampaignCheckResolution(resolution, MODES.tactical);
  assert.equal(tactical.numbers?.percentile, 70);
  assert.equal(tactical.numbers?.d20, 14);
  assert.equal(tactical.numbers?.effectivePercentile, 75);
  assert.equal(tactical.breakdown?.length, check.contributions.length);
  assert.ok(tactical.factors?.some((factor) => /\bRank\s+\d+\b/iu.test(factor.label)));
  assert.equal(tactical.result?.certainty, "check_required");

  const custom = projectCampaignCheckResolution(resolution, MODES.custom);
  assert.equal("result" in custom, false);
  assert.equal(custom.difficulty, "hard");
  assert.equal(custom.numbers?.percentile, 70);
  assert.equal("d20" in custom.numbers!, false);
  assert.equal("factors" in custom, false);
  assert.equal("breakdown" in custom, false);
});

test("normalizing persisted state rejects unexpected fields and completed objectives require full progress", () => {
  const state = createInitialCampaignRpgState(normalizeCampaignSeed(importedSeedDraft()));
  assert.throws(
    () => normalizeCampaignRpgState({ ...state, canonicalFacts: [] }),
    (error: unknown) =>
      error instanceof CampaignRpgValidationError &&
      error.issues[0]?.code === "UNKNOWN_FIELD",
  );
  assert.throws(
    () => normalizeCampaignSeed({
      ...importedSeedDraft(),
      initialState: {
        ...importedSeedDraft().initialState,
        objectives: [{
          id: "bad",
          title: "Bad completion",
          description: "",
          status: "completed",
          progress: 1,
          target: 2,
        }],
      },
    }),
    (error: unknown) =>
      error instanceof CampaignRpgValidationError &&
      error.issues[0]?.code === "INVARIANT_VIOLATION",
  );
});

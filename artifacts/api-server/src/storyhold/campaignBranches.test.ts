import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  activateCampaignBranch,
  campaignBranchHistoryMigrationSql,
  campaignBranchParentForeignKeyMigrationSql,
  campaignBranchSnapshotHash,
  CampaignBranchActivationError,
  CampaignBranchSnapshotCaptureError,
  captureCampaignBranchSnapshot,
  isCompleteCampaignBranchSnapshot,
} from "./campaignBranches";
import { type AdventureSetupContext, type AdventureSetupPlan } from "./adventureSetup";
import { adventureSetupSchemaSql } from "./adventureSetupPersistence";
import { loadAdventureSetup, publicAdventureSetup } from "./adventureSetupAccess";
import { manualStorytellerSha256 } from "./manualStoryteller";
import {
  campaignCanonScopeSchemaSql,
  createCampaignCanonScopeSnapshot,
  loadStrictCampaignCanonClaims,
  loadStrictCampaignCanonEvidence,
  lockedCampaignCanonScope,
  persistCampaignCanonScopeSnapshots,
} from "./campaignCanonScope";
import {
  CampaignRpgPersistenceError,
  campaignRpgSha256,
  commitCampaignRpgStateDelta,
  ensureCampaignRpgPersistence,
  initializeCampaignRpgState,
  loadCampaignRpgState,
} from "./campaignRpgPersistence";
import { normalizeCampaignSeed, type CampaignSeed } from "./campaignRpgState";

const ids = {
  sourceCampaign: "00000000-0000-4000-8000-000000000101",
  branch: "00000000-0000-4000-8000-000000000102",
  checkpoint: "00000000-0000-4000-8000-000000000103",
  world: "00000000-0000-4000-8000-000000000104",
  edition: "00000000-0000-4000-8000-000000000105",
  player: "00000000-0000-4000-8000-000000000106",
  character: "00000000-0000-4000-8000-000000000107",
  corruptBranch: "00000000-0000-4000-8000-000000000112",
  oldClock: "00000000-0000-4000-8000-000000000113",
  futureClock: "00000000-0000-4000-8000-000000000114",
  oldRule: "00000000-0000-4000-8000-000000000115",
  futureRule: "00000000-0000-4000-8000-000000000116",
};

function branchRpgSeed(): CampaignSeed {
  return normalizeCampaignSeed({
    seedId: "locked-hold-rpg",
    origin: {
      kind: "imported",
      worldId: ids.world,
      editionId: ids.edition,
      canonAnchor: "before-the-door",
    },
    world: {
      name: "The Locked Hold",
      premise: "Mara guards a hold whose passages keep changing.",
      facts: [],
    },
    rules: { resolutionMode: "story_first" },
    initialState: {
      activeCharacterId: "mara",
      characters: [{
        characterId: "mara",
        name: "Mara",
        stats: {},
        vitality: { current: 10, maximum: 10 },
        harms: [],
        stress: { current: 0, maximum: 10 },
        conditions: [],
        resources: [],
        inventory: [],
        equipment: [],
        capabilities: [],
      }],
      location: { entityId: null, name: "The Hold", zone: "Passage 0" },
      companions: [],
      reputations: [],
      objectives: [],
      sharedResources: [],
    },
  });
}

function activationHarness(
  snapshotOverride?: Record<string, unknown>,
  checkpointHashOverride?: string,
  startContractOverride?: Record<string, unknown>,
) {
  const startContract = startContractOverride ?? { version: 2, world: { name: "Locked Hold" } };
  const snapshot = snapshotOverride ?? {
    schemaVersion: 2,
    campaignId: ids.sourceCampaign,
    stateVersion: 7,
    worldTimeMinutes: 90,
    worldTimeLabel: "Nightfall",
    startContractHash: campaignBranchSnapshotHash(startContract),
    recentTurns: [],
    facts: [],
    epistemicAssertions: [],
    stateSummaries: [],
    clockEvents: [],
    noveltyMoves: [],
    memories: [],
    rules: [],
  };
  const state = {
    playableCampaignId: null as string | null,
    campaignInsertCount: 0,
    queries: [] as Array<{ sql: string; params: unknown[] }>,
  };
  const tx = {
    async query(sql: string, params: unknown[] = []) {
      state.queries.push({ sql, params });
      if (sql.includes("FOR UPDATE OF branch")) {
        return {
          rows: [
            {
              id: ids.branch,
              campaign_id: snapshot.campaignId,
              checkpoint_id: ids.checkpoint,
              created_by_player_id: ids.player,
              name: "The other door",
              mode: "alternate",
              status: "draft",
              branch_snapshot: snapshot,
              branch_snapshot_sha256: campaignBranchSnapshotHash(snapshot),
              checkpoint_snapshot: snapshot,
              checkpoint_snapshot_sha256:
                checkpointHashOverride ?? campaignBranchSnapshotHash(snapshot),
              playable_campaign_id: state.playableCampaignId,
              checkpoint_name: "Before the door",
              checkpoint_note: "Choose carefully",
              checkpoint_state_version: 7,
              checkpoint_world_time_minutes: 90,
              checkpoint_world_time_label: "Nightfall",
              source_world_id: ids.world,
              source_canon_edition_id: ids.edition,
              source_ruleset_id: null,
              source_owner_player_id: ids.player,
              source_canonical_key: "locked-hold",
              source_campaign_name: "Locked Hold",
              source_start_contract: startContract,
              source_start_locked_at: "2026-09-04T00:00:00.000Z",
              source_character_id: ids.character,
              source_resolution_mode: "story_first",
            },
          ],
        };
      }
      if (/INSERT INTO storyhold\.campaigns\s/u.test(sql)) {
        state.campaignInsertCount += 1;
      }
      if (/UPDATE storyhold\.campaign_branches/u.test(sql)) {
        state.playableCampaignId = String(params[0]);
      }
      return { rows: [] };
    },
  };
  const db = {
    query: tx.query,
    async transaction<T>(operation: (value: typeof tx) => Promise<T>) {
      return operation(tx);
    },
  };
  return {
    db: db as unknown as Parameters<typeof activateCampaignBranch>[0]["db"],
    snapshot,
    state,
  };
}

test("branch activation is idempotent, isolated, and never enters credit accounting", async () => {
  const harness = activationHarness();
  const input = {
    db: harness.db,
    sourceCampaignId: ids.sourceCampaign,
    branchId: ids.branch,
    playerId: ids.player,
  };
  const first = await activateCampaignBranch(input);
  const resumed = await activateCampaignBranch(input);

  assert.equal(first.created, true);
  assert.equal(resumed.created, false);
  assert.equal(resumed.campaignId, first.campaignId);
  assert.notEqual(first.campaignId, ids.sourceCampaign);
  assert.equal(harness.state.campaignInsertCount, 1);
  assert.equal(
    harness.state.queries.some(({ sql }) =>
      /credit|reservation|usage_ledger/iu.test(sql)
    ),
    false,
  );

  const campaignInsert = harness.state.queries.find(({ sql }) =>
    /INSERT INTO storyhold\.campaigns\s/u.test(sql)
  );
  assert.equal(campaignInsert?.params[5], ids.sourceCampaign);
  assert.equal(campaignInsert?.params[0], first.campaignId);
  assert.ok(
    harness.state.queries.some(({ sql, params }) =>
      sql.includes("campaign_entity_snapshots") &&
      params[0] === first.campaignId &&
      params[1] === ids.sourceCampaign
    ),
  );
  assert.ok(
    harness.state.queries.some(({ sql, params }) =>
      sql.includes("campaign_canon_event_snapshots") &&
      params[0] === first.campaignId &&
      params[1] === ids.sourceCampaign
    ),
  );
});

test("activation fails closed for a legacy incomplete snapshot", async () => {
  const harness = activationHarness({
    schemaVersion: 1,
    campaignId: ids.sourceCampaign,
    stateVersion: 7,
  });
  await assert.rejects(
    activateCampaignBranch({
      db: harness.db,
      sourceCampaignId: ids.sourceCampaign,
      branchId: ids.branch,
      playerId: ids.player,
    }),
    (error: unknown) =>
      error instanceof CampaignBranchActivationError &&
      error.code === "BRANCH_SNAPSHOT_INVALID",
  );
  assert.equal(harness.state.campaignInsertCount, 0);
});

test("activation fails closed when the checkpoint digest no longer matches", async () => {
  const harness = activationHarness(undefined, "0".repeat(64));

  await assert.rejects(
    activateCampaignBranch({
      db: harness.db,
      sourceCampaignId: ids.sourceCampaign,
      branchId: ids.branch,
      playerId: ids.player,
    }),
    (error: unknown) =>
      error instanceof CampaignBranchActivationError &&
      error.code === "BRANCH_SNAPSHOT_INVALID",
  );
  assert.equal(harness.state.campaignInsertCount, 0);
});

test("snapshot capture retains a campaign transcript beyond 48 turns", async () => {
  const transcript = Array.from({ length: 61 }, (_, index) => ({
    id: `turn-${index + 1}`,
    turn_number: index + 1,
    state_version: index + 2,
  }));
  const queries: string[] = [];
  const db = {
    async query(sql: string) {
      queries.push(sql);
      return {
        rows: sql.includes("FROM storyhold.campaigns")
          ? [{
              state_version: 70,
              world_time_minutes: 120,
              current_time_label: "Later",
              start_contract: {},
            }]
          : sql.includes("FROM storyhold.campaign_turns")
            ? [...transcript].reverse()
            : [],
      };
    },
  } as unknown as Parameters<typeof captureCampaignBranchSnapshot>[0]["db"];
  const snapshot = await captureCampaignBranchSnapshot({
    db,
    campaignId: ids.sourceCampaign,
    stateVersion: 70,
    worldTimeMinutes: 120,
    worldTimeLabel: "Later",
    startContract: {},
  });
  assert.equal(snapshot.recentTurns.length, 61);
  assert.equal(snapshot.recentTurns[0]?.turn_number, 1);
  assert.equal(snapshot.recentTurns.at(-1)?.turn_number, 61);
  assert.doesNotMatch(
    queries.find((sql) => sql.includes("FROM storyhold.campaign_turns")) ?? "",
    /LIMIT\s+48/iu,
  );
});

const captureProjectionTables = [
  "campaign_turns",
  "campaign_facts",
  "campaign_epistemic_assertions",
  "campaign_state_summaries",
  "world_clock_events",
  "campaign_novelty_ledger",
  "vault_memory_chunks",
  "campaign_runtime_rules",
] as const;

async function captureRaceDatabase() {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.campaigns (
      id uuid PRIMARY KEY,
      state_version bigint NOT NULL,
      world_time_minutes bigint NOT NULL,
      current_time_label text NOT NULL,
      start_contract jsonb NOT NULL
    );
  `);
  await db.query(
    `INSERT INTO storyhold.campaigns
      (id, state_version, world_time_minutes, current_time_label, start_contract)
     VALUES ($1, 1, 90, 'Nightfall', '{}'::jsonb)`,
    [ids.sourceCampaign],
  );
  return db;
}

test("checkpoint capture rejects a campaign coordinate race", async () => {
  const db = await captureRaceDatabase();
  let campaignLocks = 0;
  const captureDb = {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes("FROM storyhold.campaigns") && sql.includes("FOR UPDATE")) {
        campaignLocks += 1;
        if (campaignLocks === 2) {
          await db.query(
            "UPDATE storyhold.campaigns SET state_version = 2 WHERE id = $1",
            [ids.sourceCampaign],
          );
        }
        return db.query(sql, values);
      }
      if (captureProjectionTables.some((table) => sql.includes(`FROM storyhold.${table}`))) {
        return { rows: [] };
      }
      return db.query(sql, values);
    },
  } as unknown as Parameters<typeof captureCampaignBranchSnapshot>[0]["db"];
  try {
    await assert.rejects(
      captureCampaignBranchSnapshot({
        db: captureDb,
        campaignId: ids.sourceCampaign,
        stateVersion: 1,
        worldTimeMinutes: 90,
        worldTimeLabel: "Nightfall",
        startContract: {},
      }),
      (error: unknown) =>
        error instanceof CampaignBranchSnapshotCaptureError &&
        error.code === "CAMPAIGN_STATE_CHANGED",
    );
  } finally {
    await db.close();
  }
});

test("checkpoint capture rejects an RPG pointer race", async () => {
  const db = await captureRaceDatabase();
  await ensureCampaignRpgPersistence(db);
  await initializeCampaignRpgState({
    db,
    campaignId: ids.sourceCampaign,
    seed: branchRpgSeed(),
  });
  let campaignLocks = 0;
  let advanced = false;
  const captureDb = {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes("FROM storyhold.campaigns") && sql.includes("FOR UPDATE")) {
        campaignLocks += 1;
      }
      if (
        sql.includes("to_regclass('storyhold.campaign_rpg_seeds')") &&
        campaignLocks >= 2 &&
        !advanced
      ) {
        advanced = true;
        await commitCampaignRpgStateDelta({
          db,
          campaignId: ids.sourceCampaign,
          requestId: "racing-rpg-update",
          delta: {
            expectedStateVersion: 0,
            reason: "The roleplaying state advances during a stale capture.",
            location: {
              entityId: null,
              name: "The Hold",
              zone: "Changed Passage",
            },
          },
        });
      }
      if (captureProjectionTables.some((table) => sql.includes(`FROM storyhold.${table}`))) {
        return { rows: [] };
      }
      return db.query(sql, values);
    },
  } as unknown as Parameters<typeof captureCampaignBranchSnapshot>[0]["db"];
  try {
    await assert.rejects(
      captureCampaignBranchSnapshot({
        db: captureDb,
        campaignId: ids.sourceCampaign,
        stateVersion: 1,
        worldTimeMinutes: 90,
        worldTimeLabel: "Nightfall",
        startContract: {},
      }),
      (error: unknown) =>
        error instanceof CampaignBranchSnapshotCaptureError &&
        error.code === "RPG_STATE_CHANGED",
    );
  } finally {
    await db.close();
  }
});

test("snapshot hashes are stable across JSON object key order", () => {
  assert.equal(
    campaignBranchSnapshotHash({ b: 2, a: { z: 3, y: [2, 1] } }),
    campaignBranchSnapshotHash({ a: { y: [2, 1], z: 3 }, b: 2 }),
  );
});

function originalSetupCapsule() {
  const context: AdventureSetupContext = {
    campaign: { id: ids.sourceCampaign, name: "A Quiet Workshop", origin: "original", premise: "A comic workshop prepares for a neighborhood fair." },
    lockedStart: "The player reaches the workshop before the fair opens.",
    currentMinute: 0, currentTurnNumber: 0, existingSummary: "", recentTurns: [],
  };
  const plan: AdventureSetupPlan = {
    publicOpening: "A tilted display blocks the workshop door. Jo asks where to start.",
    locationName: "The workshop",
    visibleObjective: { key: "prepare_fair", title: "Prepare the display", description: "Choose how to arrange a workable demonstration.", target: 3 },
    cast: [
      { key: "jo", name: "Jo", role: "Organizer", presence: "present", publicSummary: "Jo steadies the tilted display.", privateMotivation: "Jo wants the fair to fund a new pottery wheel." },
      { key: "ren", name: "Ren", role: "Neighbor", presence: "unmet", publicSummary: "Ren arrives with an oversized cart.", privateMotivation: "Ren hopes to join the workshop without admitting any inexperience." },
    ],
    secrets: [{ key: "old_order", truth: "The blue ledger conceals a reserved copper teapot.", clues: ["A blue ledger has a folded corner.", "One empty shelf bears a copper-colored ring."], discoverableVia: ["Compare the shelf tags with the ledger."] }],
    pressures: [
      { key: "visitors", title: "Waiting visitors", privateSummary: "The visitors may leave unless someone offers an activity.", observableConsequence: "A few visitors begin checking their watches.", clueOpportunities: ["A visitor can explain the day's advertised demonstration."], maturesAfterMinutes: 10, objectiveKey: "prepare_fair" },
      { key: "delivery", title: "A delayed delivery", privateSummary: "The spare display cloths may arrive too late unless someone calls the driver.", observableConsequence: "The delivery window narrows.", clueOpportunities: ["A delivery note includes an alternate pickup location."], maturesAfterMinutes: 20 },
    ],
    privateDirection: { premise: "Practical compromises can make the fair work.", goalSteps: [
      { key: "display", title: "Choose a display", condition: "If the player examines the stock.", possibleNextStep: "They may propose a smaller demonstration." },
      { key: "reservation", title: "Consider the reservation", condition: "Only if the ledger's clues earn a discovery.", possibleNextStep: "They may negotiate a substitute or seek the customer." },
    ], alternatePaths: ["A shared demonstration could buy time.", "A smaller fair could avoid a delivery dependency."] },
  };
  const frozenInput = { context };
  return {
    schemaVersion: 1, id: ids.oldRule, campaignId: ids.sourceCampaign,
    expectedStateVersion: 0, appliedStateVersion: 1,
    frozenInput, inputSha256: manualStorytellerSha256(frozenInput), plan, planSha256: manualStorytellerSha256(plan),
  };
}

test("checkpoint captures only a ready setup that already exists at its state version", async () => {
  const db = await captureRaceDatabase();
  try {
    await db.exec("CREATE TABLE storyhold.players (id uuid PRIMARY KEY)");
    await db.query("INSERT INTO storyhold.players (id) VALUES ($1)", [ids.player]);
    await db.exec(adventureSetupSchemaSql);
    const capsule = originalSetupCapsule();
    await db.query(
      `INSERT INTO storyhold.campaign_adventure_setups
        (id, campaign_id, player_id, expected_state_version, applied_state_version,
         input_sha256, frozen_input, request, plan, plan_sha256, status)
       VALUES ($1, $2, $3, 0, 1, $4, $5::jsonb, '{}', $6::jsonb, $7, 'ready')`,
      [capsule.id, ids.sourceCampaign, ids.player, capsule.inputSha256,
        JSON.stringify(capsule.frozenInput), JSON.stringify(capsule.plan), capsule.planSha256],
    );
    const captureDb = {
      async query(sql: string, values?: unknown[]) {
        if (captureProjectionTables.some((table) => sql.includes(`FROM storyhold.${table}`))) return { rows: [] };
        return db.query(sql, values);
      },
    } as unknown as Parameters<typeof captureCampaignBranchSnapshot>[0]["db"];
    const capture = () => captureCampaignBranchSnapshot({
      db: captureDb, campaignId: ids.sourceCampaign, stateVersion: 1,
      worldTimeMinutes: 90, worldTimeLabel: "Nightfall", startContract: {},
    });
    assert.deepEqual((await capture()).adventureSetup, capsule);
    await db.query("UPDATE storyhold.campaign_adventure_setups SET applied_state_version = 2 WHERE id = $1", [capsule.id]);
    assert.equal((await capture()).adventureSetup, null);
    await db.query("UPDATE storyhold.campaign_adventure_setups SET applied_state_version = 1, status = 'awaiting_response' WHERE id = $1", [capsule.id]);
    assert.equal((await capture()).adventureSetup, null);
  } finally {
    await db.close();
  }
});

test("setup inheritance uses only the checkpoint capsule and rebases the origin checkpoint for nested branches", async () => {
  const capsule = originalSetupCapsule();
  const harness = activationHarness({ ...activationHarness().snapshot, schemaVersion: 4, rpgState: null, adventureSetup: capsule });
  const activated = await activateCampaignBranch({ db: harness.db, sourceCampaignId: ids.sourceCampaign, branchId: ids.branch, playerId: ids.player });
  const setupInsert = harness.state.queries.find(({ sql }) => sql.includes("INSERT INTO storyhold.campaign_adventure_setups"))!;
  assert.ok(setupInsert);
  assert.match(setupInsert.sql, /'ready'/u);
  assert.equal(setupInsert.params[1], activated.campaignId);
  assert.equal(setupInsert.params[4], 1);
  assert.notEqual(setupInsert.params[0], capsule.id);
  const inheritedPlan = JSON.parse(String(setupInsert.params[8])) as AdventureSetupPlan;
  assert.equal(inheritedPlan.publicOpening, "");
  assert.deepEqual(inheritedPlan.secrets, capsule.plan.secrets);
  const inheritedInput = JSON.parse(String(setupInsert.params[6]));
  assert.equal(inheritedInput.context.campaign.id, activated.campaignId);
  assert.equal(inheritedInput.branchOrigin.sourceSetupId, capsule.id);
  assert.equal(inheritedInput.branchOrigin.sourceInputSha256, capsule.inputSha256);
  assert.equal(setupInsert.params[5], manualStorytellerSha256(inheritedInput));
  assert.equal(setupInsert.params[9], manualStorytellerSha256(inheritedPlan));
  assert.equal(harness.state.queries.some(({ sql }) => /SELECT[\s\S]*FROM storyhold\.campaign_adventure_setups/iu.test(sql)), false);
  assert.equal(harness.state.queries.some(({ sql }) => /INSERT INTO storyhold\.(world_clock_events|campaign_state_summaries|campaign_rpg_state_events)/u.test(sql)), false);
  const checkpointInsert = harness.state.queries.find(({ sql }) => sql.includes("INSERT INTO storyhold.campaign_checkpoints"))!;
  const originSnapshot = JSON.parse(String(checkpointInsert.params[9]));
  const campaignInsert = harness.state.queries.find(({ sql }) => /INSERT INTO storyhold\.campaigns\s/u.test(sql))!;
  const childStartContract = JSON.parse(String(campaignInsert.params[8]));
  assert.equal(originSnapshot.adventureSetup.id, setupInsert.params[0]);
  assert.equal(originSnapshot.adventureSetup.campaignId, activated.campaignId);
  assert.equal(isCompleteCampaignBranchSnapshot(originSnapshot, { campaignId: activated.campaignId, stateVersion: 7, startContract: childStartContract }), true);
  // Exercise the actual setup schema and the same child-only reader used by play.
  const storage = await captureRaceDatabase();
  try {
    await storage.exec("CREATE TABLE storyhold.players (id uuid PRIMARY KEY)");
    await storage.query("INSERT INTO storyhold.players (id) VALUES ($1)", [ids.player]);
    await storage.exec(adventureSetupSchemaSql);
    await storage.query(
      `INSERT INTO storyhold.campaigns (id, state_version, world_time_minutes, current_time_label, start_contract)
       VALUES ($1, 7, 90, 'Nightfall', $2::jsonb)`, [activated.campaignId, JSON.stringify(childStartContract)],
    );
    await storage.query(setupInsert.sql, setupInsert.params);
    const child = { id: activated.campaignId, world_creation_mode: "quickstart", start_contract: childStartContract };
    const loaded = await loadAdventureSetup(storage, child);
    assert.equal(loaded?.status, "ready");
    assert.equal(loaded?.plan_sha256, manualStorytellerSha256(loaded?.plan));
    assert.equal(loaded?.input_sha256, manualStorytellerSha256(loaded?.frozen_input));
    assert.ok(Number(loaded?.expected_state_version) >= 0);
    assert.ok(Number(loaded?.applied_state_version) > Number(loaded?.expected_state_version));
    assert.ok(Number(loaded?.applied_state_version) <= 7);
    assert.equal(publicAdventureSetup(child, loaded).opening, null);
  } finally {
    await storage.close();
  }
  const nested = activationHarness(originSnapshot, undefined, childStartContract);
  const grandchild = await activateCampaignBranch({ db: nested.db, sourceCampaignId: activated.campaignId, branchId: ids.corruptBranch, playerId: ids.player });
  const nestedInsert = nested.state.queries.find(({ sql }) => sql.includes("INSERT INTO storyhold.campaign_adventure_setups"))!;
  const nestedInput = JSON.parse(String(nestedInsert.params[6]));
  assert.equal(nestedInsert.params[1], grandchild.campaignId);
  assert.equal(nestedInput.branchOrigin.sourceSetupId, setupInsert.params[0]);
  assert.equal(nestedInput.branchOrigin.sourceCampaignId, activated.campaignId);
});

test("future or corrupt setup capsules fail closed and legacy snapshots never import a setup", async () => {
  const base = activationHarness().snapshot;
  for (const capsule of [
    { ...originalSetupCapsule(), appliedStateVersion: 8 },
    { ...originalSetupCapsule(), planSha256: "0".repeat(64) },
    undefined,
  ]) {
    const harness = activationHarness({ ...base, schemaVersion: 4, rpgState: null, adventureSetup: capsule });
    await assert.rejects(activateCampaignBranch({ db: harness.db, sourceCampaignId: ids.sourceCampaign, branchId: ids.branch, playerId: ids.player }), CampaignBranchActivationError);
    assert.equal(harness.state.campaignInsertCount, 0);
  }
  // Even an extraneous field in an older snapshot has no authority to add setup state.
  const legacy = activationHarness({ ...base, adventureSetup: originalSetupCapsule() });
  await activateCampaignBranch({ db: legacy.db, sourceCampaignId: ids.sourceCampaign, branchId: ids.branch, playerId: ids.player });
  assert.equal(legacy.state.queries.some(({ sql }) => sql.includes("campaign_adventure_setups")), false);
});

test("parent branch migration is idempotent and nulls nested lineage on cleanup", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.campaign_branches (
        id uuid PRIMARY KEY,
        parent_branch_id uuid
          REFERENCES storyhold.campaign_branches(id) ON DELETE RESTRICT
      );
    `);
    await db.exec(campaignBranchParentForeignKeyMigrationSql);
    await db.exec(campaignBranchParentForeignKeyMigrationSql);
    await db.query(
      `INSERT INTO storyhold.campaign_branches (id, parent_branch_id)
       VALUES ($1, NULL), ($2, $1)`,
      [ids.branch, ids.checkpoint],
    );
    await db.query(
      "DELETE FROM storyhold.campaign_branches WHERE id = $1",
      [ids.branch],
    );
    const nested = await db.query<{ parent_branch_id: string | null }>(
      "SELECT parent_branch_id FROM storyhold.campaign_branches WHERE id = $1",
      [ids.checkpoint],
    );
    assert.equal(nested.rows[0]?.parent_branch_id, null);
  } finally {
    await db.close();
  }
});

test("history migration backfills stable clock and rule state boundaries", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.campaigns (
        id uuid PRIMARY KEY,
        state_version bigint NOT NULL
      );
      CREATE TABLE storyhold.campaign_turns (
        id uuid PRIMARY KEY,
        campaign_id uuid NOT NULL,
        state_version bigint NOT NULL,
        created_at timestamptz NOT NULL
      );
      CREATE TABLE storyhold.world_clock_events (
        id uuid PRIMARY KEY,
        campaign_id uuid,
        status text NOT NULL,
        matured_state_version bigint,
        maturation_narrated_at timestamptz,
        created_at timestamptz NOT NULL
      );
      CREATE TABLE storyhold.campaign_runtime_rules (
        id uuid PRIMARY KEY,
        campaign_id uuid NOT NULL,
        status text NOT NULL,
        created_at timestamptz NOT NULL
      );
    `);
    await db.query(
      "INSERT INTO storyhold.campaigns (id, state_version) VALUES ($1, 4)",
      [ids.sourceCampaign],
    );
    await db.query(
      `INSERT INTO storyhold.campaign_turns
        (id, campaign_id, state_version, created_at)
       VALUES
        ('00000000-0000-4000-8000-000000000117', $1, 2,
         '2026-09-04T01:00:00Z'),
        ('00000000-0000-4000-8000-000000000118', $1, 3,
         '2026-09-04T02:00:00Z')`,
      [ids.sourceCampaign],
    );
    await db.query(
      `INSERT INTO storyhold.world_clock_events
        (id, campaign_id, status, matured_state_version,
         maturation_narrated_at, created_at)
       VALUES ($1, $2, 'resolved', 3, '2026-09-04T02:15:00Z',
               '2026-09-04T01:30:00Z')`,
      [ids.oldClock, ids.sourceCampaign],
    );
    await db.query(
      `INSERT INTO storyhold.campaign_runtime_rules
        (id, campaign_id, status, created_at)
       VALUES ($1, $2, 'retired', '2026-09-04T02:30:00Z')`,
      [ids.oldRule, ids.sourceCampaign],
    );

    await db.exec(campaignBranchHistoryMigrationSql);
    await db.exec(campaignBranchHistoryMigrationSql);

    const clock = await db.query<{
      created_state_version: number;
      resolved_state_version: number;
      maturation_narrated_state_version: number;
    }>(
      `SELECT created_state_version, resolved_state_version,
              maturation_narrated_state_version
         FROM storyhold.world_clock_events WHERE id = $1`,
      [ids.oldClock],
    );
    assert.deepEqual(clock.rows[0], {
      created_state_version: 2,
      resolved_state_version: 4,
      maturation_narrated_state_version: 3,
    });
    const rule = await db.query<{
      created_state_version: number;
      retired_state_version: number;
    }>(
      `SELECT created_state_version, retired_state_version
         FROM storyhold.campaign_runtime_rules WHERE id = $1`,
      [ids.oldRule],
    );
    assert.deepEqual(rule.rows[0], {
      created_state_version: 3,
      retired_state_version: 4,
    });
  } finally {
    await db.close();
  }
});

test("real activation preserves strict canon and the exact historical RPG state", async () => {
  const db = new PGlite();
  const evidence = [{
    evidence_key: "gate-proof",
    world_id: ids.world,
    canon_edition_id: ids.edition,
    source_id: "00000000-0000-4000-8000-000000000108",
    chunk_id: "00000000-0000-4000-8000-000000000109",
    source_content_hash: "1".repeat(64),
    chunk_content_hash: "2".repeat(64),
    source_title: "The Locked Hold",
    source_kind: "manuscript",
    chronology_label: "Before the door",
    excerpt: "Mara guards the western gate.",
    excerpt_hash: "3".repeat(64),
    event_ids: ["00000000-0000-4000-8000-000000000110"],
    chronology_orders: [7],
  }];
  const claims = [{
    claim_id: "00000000-0000-4000-8000-000000000111",
    world_id: ids.world,
    canon_edition_id: ids.edition,
    fingerprint: "mara-guards-western-gate",
    supersedes_claim_id: null,
    subject_entity_id: ids.character,
    predicate: "guards",
    polarity: "positive" as const,
    object_entity_id: null,
    object_text: "the western gate",
    epistemic_holder_entity_id: null,
    truth_status: "fact" as const,
    valid_from_label: "Before the door",
    valid_until_label: "",
    summary: "Mara is the western gate's guard.",
    evidence: [{
      evidenceKey: evidence[0].evidence_key,
      sourceId: evidence[0].source_id,
      chunkId: evidence[0].chunk_id,
      quote: evidence[0].excerpt,
    }],
    confidence: 0.95,
    claim_status: "active" as const,
    assignment_source: "user" as const,
    source_updated_at: "2026-09-04T01:02:03.000Z",
    snapshot_hash: "4".repeat(64),
  }];
  const entities = [{
    entity_id: ids.character,
    dossier_id: null,
    canonical_character_id: ids.character,
    canonical_key: "mara",
    entity_type: "character",
    name: "Mara",
    aliases: [] as [],
    role: "" as const,
    summary: "" as const,
    profile: {},
    details: [] as [],
    relationships: [] as [],
    socio_political_axis: {},
    faction_memberships: [] as [],
    entity_links: [] as [],
    entity_rules: [] as [],
    mention_count: 0 as const,
    confidence: 0.9,
  }];
  const startContract = {
    version: 7,
    rpgSeed: {
      schemaVersion: 1,
      seedId: "locked-hold-rpg",
      seedSha256: campaignRpgSha256(branchRpgSeed()),
      origin: "imported",
      initialStateVersion: 0,
      baselineCampaignStateVersion: 1,
    },
    canonScopeSnapshot: createCampaignCanonScopeSnapshot({
      mode: "anchored_strict",
      anchorEventId: evidence[0].event_ids[0],
      anchorMode: "after",
      maximumChronologyOrder: 7,
      evidence,
      claims,
      entities,
    }),
  };
  try {
    await db.exec(`
      CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.campaigns (
        id uuid PRIMARY KEY,
        world_id uuid NOT NULL,
        canon_edition_id uuid,
        ruleset_id uuid,
        owner_player_id uuid NOT NULL,
        parent_campaign_id uuid REFERENCES storyhold.campaigns(id) ON DELETE CASCADE,
        canonical_key text NOT NULL UNIQUE,
        name text NOT NULL,
        start_contract jsonb NOT NULL,
        start_locked_at timestamptz,
        perspective_character_id uuid,
        current_time_label text NOT NULL DEFAULT '',
        world_time_minutes bigint NOT NULL DEFAULT 0,
        resolution_mode text NOT NULL DEFAULT 'story_first',
        status text NOT NULL DEFAULT 'active',
        state_version bigint NOT NULL DEFAULT 0
      );
      CREATE TABLE storyhold.campaign_members (
        campaign_id uuid NOT NULL,
        player_id uuid NOT NULL,
        character_id uuid,
        PRIMARY KEY (campaign_id, player_id)
      );
      CREATE TABLE storyhold.campaign_checkpoints (
        id uuid PRIMARY KEY,
        campaign_id uuid NOT NULL,
        created_by_player_id uuid NOT NULL,
        turn_id uuid,
        state_version bigint NOT NULL,
        world_time_minutes bigint NOT NULL,
        world_time_label text NOT NULL,
        name text NOT NULL,
        note text NOT NULL DEFAULT '',
        snapshot jsonb NOT NULL,
        snapshot_sha256 text NOT NULL
      );
      CREATE TABLE storyhold.campaign_branches (
        id uuid PRIMARY KEY,
        campaign_id uuid NOT NULL REFERENCES storyhold.campaigns(id) ON DELETE CASCADE,
        checkpoint_id uuid NOT NULL,
        parent_branch_id uuid REFERENCES storyhold.campaign_branches(id) ON DELETE SET NULL,
        created_by_player_id uuid NOT NULL,
        name text NOT NULL,
        mode text NOT NULL,
        status text NOT NULL,
        branch_snapshot jsonb NOT NULL,
        branch_snapshot_sha256 text NOT NULL,
        request_id text NOT NULL,
        credits_charged integer NOT NULL DEFAULT 0,
        playable_campaign_id uuid,
        activated_by_player_id uuid,
        activated_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE storyhold.world_state_events (
        id uuid PRIMARY KEY,
        campaign_id uuid NOT NULL,
        sequence_number bigint NOT NULL,
        event_type text NOT NULL,
        payload jsonb NOT NULL,
        caused_by_player_id uuid
      );
      CREATE TABLE storyhold.world_clock_events (
        id uuid PRIMARY KEY,
        world_id uuid NOT NULL,
        canon_edition_id uuid,
        campaign_id uuid,
        source_id uuid,
        created_by_player_id uuid,
        visible_to_character_id uuid,
        causal_parent_id uuid,
        canonical_key text NOT NULL,
        event_kind text NOT NULL,
        title text NOT NULL,
        summary text NOT NULL DEFAULT '',
        world_time_label text NOT NULL DEFAULT '',
        chronology_order bigint NOT NULL DEFAULT 0,
        visibility text NOT NULL DEFAULT 'campaign',
        knowledge_status text NOT NULL DEFAULT 'observed',
        known_effects jsonb NOT NULL DEFAULT '[]',
        internal_effects jsonb NOT NULL DEFAULT '[]',
        evidence jsonb NOT NULL DEFAULT '[]',
        scheduled_for_label text NOT NULL DEFAULT '',
        reveal_rule jsonb NOT NULL DEFAULT '{}',
        status text NOT NULL DEFAULT 'committed',
        due_world_time_minutes bigint,
        due_turn_number bigint,
        matured_at timestamptz,
        matured_state_version bigint,
        maturation_narrated_at timestamptz,
        temporal_status text NOT NULL DEFAULT 'relative',
        importance text NOT NULL DEFAULT 'major',
        source_chapter_keys jsonb NOT NULL DEFAULT '[]',
        trigger_definition jsonb NOT NULL DEFAULT '{}',
        causal_basis jsonb NOT NULL DEFAULT '[]',
        clue_opportunities jsonb NOT NULL DEFAULT '[]',
        matured_by_event_id uuid,
        created_state_version bigint NOT NULL DEFAULT 1,
        resolved_state_version bigint,
        maturation_narrated_state_version bigint,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE storyhold.campaign_runtime_rules (
        id uuid PRIMARY KEY,
        world_id uuid NOT NULL,
        campaign_id uuid NOT NULL,
        canonical_key text NOT NULL,
        name text NOT NULL,
        rule_kind text NOT NULL,
        trigger_definition jsonb NOT NULL DEFAULT '{}',
        requirements jsonb NOT NULL DEFAULT '[]',
        effects jsonb NOT NULL DEFAULT '[]',
        visibility text NOT NULL DEFAULT 'system',
        authored_by text NOT NULL DEFAULT 'storyhold',
        status text NOT NULL DEFAULT 'active',
        created_state_version bigint NOT NULL DEFAULT 1,
        retired_state_version bigint,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE storyhold.campaign_entity_snapshots (
        campaign_id uuid NOT NULL,
        entity_id uuid NOT NULL,
        dossier_id uuid,
        canonical_character_id uuid,
        canonical_key text NOT NULL,
        entity_type text NOT NULL,
        name text NOT NULL,
        aliases jsonb NOT NULL,
        role text NOT NULL,
        summary text NOT NULL,
        profile jsonb NOT NULL,
        details jsonb NOT NULL,
        relationships jsonb NOT NULL,
        socio_political_axis jsonb NOT NULL,
        faction_memberships jsonb NOT NULL,
        entity_links jsonb NOT NULL,
        entity_rules jsonb NOT NULL,
        mention_count integer NOT NULL,
        confidence real NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (campaign_id, entity_id)
      );
      CREATE TABLE storyhold.campaign_canon_event_snapshots (
        campaign_id uuid NOT NULL,
        event_id uuid NOT NULL,
        canonical_key text NOT NULL,
        title text NOT NULL,
        summary text NOT NULL,
        world_time_label text NOT NULL,
        chronology_order bigint NOT NULL,
        temporal_status text NOT NULL,
        importance text NOT NULL,
        source_chapter_keys jsonb NOT NULL,
        evidence jsonb NOT NULL,
        causal_links jsonb NOT NULL,
        participant_entity_ids jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (campaign_id, event_id)
      );
    `);
    await db.exec(campaignCanonScopeSchemaSql);
    await ensureCampaignRpgPersistence(db);
    await db.query(
      `INSERT INTO storyhold.campaigns
        (id, world_id, canon_edition_id, owner_player_id, canonical_key, name,
         start_contract, start_locked_at, perspective_character_id,
         current_time_label, world_time_minutes, resolution_mode, status,
         state_version)
       VALUES ($1, $2, $3, $4, 'source', 'Source timeline', $5::jsonb,
               now(), $6, 'Nightfall', 90, 'story_first', 'active', 7)`,
      [
        ids.sourceCampaign,
        ids.world,
        ids.edition,
        ids.player,
        JSON.stringify(startContract),
        ids.character,
      ],
    );
    await initializeCampaignRpgState({
      db,
      campaignId: ids.sourceCampaign,
      seed: branchRpgSeed(),
    });
    for (let version = 0; version < 7; version += 1) {
      await commitCampaignRpgStateDelta({
        db,
        campaignId: ids.sourceCampaign,
        requestId: `source-rpg-${version + 1}`,
        delta: {
          expectedStateVersion: version,
          reason: `Mara reaches passage ${version + 1}.`,
          location: {
            entityId: null,
            name: "The Hold",
            zone: `Passage ${version + 1}`,
          },
        },
      });
    }
    await db.query(
      `INSERT INTO storyhold.world_clock_events
        (id, world_id, canon_edition_id, campaign_id, canonical_key,
         event_kind, title, chronology_order, status, created_state_version,
         resolved_state_version)
       VALUES
        ($1, $2, $3, $4, 'old-warning', 'commitment', 'Old warning', 1,
         'resolved', 3, 8),
        ($5, $2, $3, $4, 'future-ambush', 'scene', 'Future ambush', 2,
         'committed', 8, NULL)`,
      [
        ids.oldClock,
        ids.world,
        ids.edition,
        ids.sourceCampaign,
        ids.futureClock,
      ],
    );
    await db.query(
      `INSERT INTO storyhold.campaign_runtime_rules
        (id, world_id, campaign_id, canonical_key, name, rule_kind, status,
         created_state_version, retired_state_version)
       VALUES
        ($1, $2, $3, 'old-rule', 'Old rule', 'world_rule', 'retired', 2, 8),
        ($4, $2, $3, 'future-rule', 'Future rule', 'world_rule', 'active', 8, NULL)`,
      [ids.oldRule, ids.world, ids.sourceCampaign, ids.futureRule],
    );
    const ignoredCaptureTables = new Set([
      "campaign_turns",
      "campaign_facts",
      "campaign_epistemic_assertions",
      "campaign_state_summaries",
      "campaign_novelty_ledger",
      "vault_memory_chunks",
    ]);
    const captureDb = {
      async query(sql: string, values?: unknown[]) {
        const ignored = [...ignoredCaptureTables].some((table) =>
          sql.includes(`FROM storyhold.${table}`),
        );
        if (ignored) return { rows: [] };
        return db.query(sql, values);
      },
    } as unknown as Parameters<typeof captureCampaignBranchSnapshot>[0]["db"];
    const snapshot = await captureCampaignBranchSnapshot({
      db: captureDb,
      campaignId: ids.sourceCampaign,
      stateVersion: 7,
      worldTimeMinutes: 90,
      worldTimeLabel: "Nightfall",
      startContract,
    });
    assert.equal(snapshot.rpgState?.stateVersion, 7);
    assert.deepEqual(
      snapshot.clockEvents.map((event) => [event.title, event.status]),
      [["Old warning", "committed"]],
    );
    assert.deepEqual(
      snapshot.rules.map((rule) => [rule.name, rule.status]),
      [["Old rule", "active"]],
    );
    const snapshotHash = campaignBranchSnapshotHash(snapshot);

    await commitCampaignRpgStateDelta({
      db,
      campaignId: ids.sourceCampaign,
      requestId: "source-rpg-8",
      delta: {
        expectedStateVersion: 7,
        reason: "Mara reaches passage 8.",
        location: {
          entityId: null,
          name: "The Hold",
          zone: "Passage 8",
        },
      },
    });
    await db.query(
      `UPDATE storyhold.campaigns
          SET state_version = 8, world_time_minutes = 100,
              current_time_label = 'After the warning'
        WHERE id = $1`,
      [ids.sourceCampaign],
    );
    await db.query(
      `INSERT INTO storyhold.campaign_members
        (campaign_id, player_id, character_id) VALUES ($1, $2, $3)`,
      [ids.sourceCampaign, ids.player, ids.character],
    );
    await db.query(
      `INSERT INTO storyhold.campaign_entity_snapshots
        (campaign_id, entity_id, dossier_id, canonical_character_id,
         canonical_key, entity_type, name, aliases, role, summary, profile,
         details, relationships, socio_political_axis, faction_memberships,
         entity_links, entity_rules, mention_count, confidence)
       VALUES ($1, $2, NULL, $2, 'mara', 'character', 'Mara', '[]', '', '',
               '{}', '[]', '[]', '{}', '[]', '[]', '[]', 0, 0.9)`,
      [ids.sourceCampaign, ids.character],
    );
    await persistCampaignCanonScopeSnapshots({
      db,
      campaignId: ids.sourceCampaign,
      evidence,
      claims,
    });
    await db.query(
      `INSERT INTO storyhold.campaign_checkpoints
        (id, campaign_id, created_by_player_id, turn_id, state_version,
         world_time_minutes, world_time_label, name, note, snapshot,
         snapshot_sha256)
       VALUES ($1, $2, $3, NULL, 7, 90, 'Nightfall', 'Before the door', '',
               $4::jsonb, $5)`,
      [ids.checkpoint, ids.sourceCampaign, ids.player, JSON.stringify(snapshot), snapshotHash],
    );
    await db.query(
      `INSERT INTO storyhold.campaign_branches
        (id, campaign_id, checkpoint_id, parent_branch_id,
         created_by_player_id, name, mode, status, branch_snapshot,
         branch_snapshot_sha256, request_id, credits_charged)
       VALUES ($1, $2, $3, NULL, $4, 'The other door', 'alternate', 'draft',
               $5::jsonb, $6, 'branch-request', 500)`,
      [ids.branch, ids.sourceCampaign, ids.checkpoint, ids.player, JSON.stringify(snapshot), snapshotHash],
    );

    const activated = await activateCampaignBranch({
      db,
      sourceCampaignId: ids.sourceCampaign,
      branchId: ids.branch,
      playerId: ids.player,
    });
    const child = await db.query<{ start_contract: unknown; parent_campaign_id: string }>(
      "SELECT start_contract, parent_campaign_id FROM storyhold.campaigns WHERE id = $1",
      [activated.campaignId],
    );
    const scope = lockedCampaignCanonScope(child.rows[0]?.start_contract);
    assert.equal(scope.valid, true);
    assert.equal(scope.mode, "anchored_strict");
    assert.equal(child.rows[0]?.parent_campaign_id, ids.sourceCampaign);

    const childRpgState = await loadCampaignRpgState(db, activated.campaignId);
    const currentSourceRpgState = await loadCampaignRpgState(
      db,
      ids.sourceCampaign,
    );
    assert.equal(childRpgState.stateVersion, 7);
    assert.equal(childRpgState.location.zone, "Passage 7");
    assert.equal(currentSourceRpgState.stateVersion, 8);
    assert.equal(currentSourceRpgState.location.zone, "Passage 8");
    const childClocks = await db.query<{
      title: string;
      status: string;
      resolved_state_version: number | null;
    }>(
      `SELECT title, status, resolved_state_version
         FROM storyhold.world_clock_events
        WHERE campaign_id = $1 ORDER BY chronology_order`,
      [activated.campaignId],
    );
    assert.deepEqual(childClocks.rows, [{
      title: "Old warning",
      status: "committed",
      resolved_state_version: null,
    }]);
    assert.equal(
      (await db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM storyhold.world_clock_events
          WHERE campaign_id = $1`,
        [ids.sourceCampaign],
      )).rows[0]?.count,
      2,
    );
    const childRules = await db.query<{
      name: string;
      status: string;
      retired_state_version: number | null;
    }>(
      `SELECT name, status, retired_state_version
         FROM storyhold.campaign_runtime_rules
        WHERE campaign_id = $1`,
      [activated.campaignId],
    );
    assert.deepEqual(childRules.rows, [{
      name: "Old rule",
      status: "active",
      retired_state_version: null,
    }]);

    const resumed = await activateCampaignBranch({
      db,
      sourceCampaignId: ids.sourceCampaign,
      branchId: ids.branch,
      playerId: ids.player,
    });
    assert.deepEqual(resumed, { campaignId: activated.campaignId, created: false });
    assert.equal(
      (await db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM storyhold.campaign_rpg_seeds
          WHERE campaign_id = $1`,
        [activated.campaignId],
      )).rows[0]?.count,
      1,
    );

    const strictEvidence = await loadStrictCampaignCanonEvidence({
      db,
      campaignId: activated.campaignId,
      action: "western gate",
    });
    const strictClaims = await loadStrictCampaignCanonClaims({
      db,
      campaignId: activated.campaignId,
      action: "Mara guards",
    });
    assert.equal(strictEvidence.rows[0]?.content, evidence[0].excerpt);
    assert.equal(strictClaims.rows[0]?.predicate, claims[0].predicate);

    for (const table of [
      "campaign_canon_evidence_snapshots",
      "campaign_canon_claim_snapshots",
    ]) {
      const copied = await db.query<{ value: unknown }>(
        `SELECT to_jsonb(snapshot) - 'campaign_id' AS value
           FROM storyhold.${table} snapshot
          WHERE campaign_id IN ($1, $2)
          ORDER BY campaign_id`,
        [ids.sourceCampaign, activated.campaignId],
      );
      assert.equal(copied.rows.length, 2);
      assert.deepEqual(copied.rows[0]?.value, copied.rows[1]?.value);
    }

    await db.query(
      `INSERT INTO storyhold.campaign_branches
        (id, campaign_id, checkpoint_id, parent_branch_id,
         created_by_player_id, name, mode, status, branch_snapshot,
         branch_snapshot_sha256, request_id, credits_charged)
       VALUES ($1, $2, $3, NULL, $4, 'Corrupt fork', 'alternate', 'draft',
               $5::jsonb, $6, 'corrupt-branch-request', 500)`,
      [
        ids.corruptBranch,
        ids.sourceCampaign,
        ids.checkpoint,
        ids.player,
        JSON.stringify(snapshot),
        snapshotHash,
      ],
    );
    await db.query(
      `UPDATE storyhold.campaign_rpg_states
          SET state = jsonb_set(state, '{location,zone}', '"Counterfeit"'::jsonb)
        WHERE campaign_id = $1`,
      [ids.sourceCampaign],
    );
    await assert.rejects(
      activateCampaignBranch({
        db,
        sourceCampaignId: ids.sourceCampaign,
        branchId: ids.corruptBranch,
        playerId: ids.player,
      }),
      (error: unknown) =>
        error instanceof CampaignRpgPersistenceError &&
        error.code === "STATE_TAMPERED",
    );
    assert.equal(
      (await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM storyhold.campaigns",
      )).rows[0]?.count,
      2,
    );
    assert.equal(
      (await db.query<{ playable_campaign_id: string | null }>(
        `SELECT playable_campaign_id FROM storyhold.campaign_branches
          WHERE id = $1`,
        [ids.corruptBranch],
      )).rows[0]?.playable_campaign_id,
      null,
    );
  } finally {
    await db.close();
  }
});

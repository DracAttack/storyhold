import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  CampaignRpgPersistenceError,
  campaignRpgSha256,
  commitCampaignRpgStateDelta,
  copyCampaignRpgStateToChild,
  ensureCampaignRpgPersistence,
  initializeCampaignRpgState,
  initializeCampaignRpgStateInTransaction,
  loadCampaignRpgSnapshot,
  loadCampaignRpgState,
  loadCampaignRpgStateAtVersion,
  loadCampaignRpgStateEvents,
} from "./campaignRpgPersistence";
import {
  createInitialCampaignRpgState,
  normalizeCampaignSeed,
  type CampaignRpgStateDelta,
  type CampaignSeed,
} from "./campaignRpgState";

const SOURCE = "10000000-0000-4000-8000-000000000001";
const CHILD = "10000000-0000-4000-8000-000000000002";
const OTHER = "10000000-0000-4000-8000-000000000003";

function seed(overrides: { seedId?: string; worldName?: string } = {}): CampaignSeed {
  return normalizeCampaignSeed({
    seedId: overrides.seedId ?? "ashes-rpg-seed",
    origin: {
      kind: "imported",
      worldId: "ashes-world",
      editionId: "ashes-and-embers",
      canonAnchor: "book-one:chapter-one",
    },
    world: {
      name: overrides.worldName ?? "Ashes of the Earth",
      premise: "Alec arrives in Sanctuary after the world ends.",
      facts: [{
        id: "alec-echo",
        subject: "Alec Sumner",
        predicate: "shares a symbiotic bond with",
        object: "Echo",
        provenance: "manuscript",
      }],
    },
    rules: { resolutionMode: "light_rules" },
    initialState: {
      activeCharacterId: "alec",
      characters: [{
        characterId: "alec",
        name: "Alec Sumner",
        stats: {
          strength: 13,
          dexterity: 14,
          constitution: 13,
          intelligence: 12,
          wisdom: 11,
          charisma: 12,
          acrobatics: 13,
        },
        vitality: { current: 10, maximum: 10 },
        harms: [],
        stress: { current: 0, maximum: 10 },
        conditions: [],
        resources: [{ id: "ammo", name: "Ammunition", current: 6, maximum: 12 }],
        inventory: [],
        equipment: [],
        capabilities: [{
          id: "survival",
          name: "Survival",
          rank: 2,
          description: "Alec reads danger and makes practical plans.",
        }],
      }],
      location: { entityId: "sanctuary", name: "Sanctuary", zone: "Northern Gate" },
      companions: [{
        id: "echo",
        entityId: "echo-entity",
        name: "Echo",
        status: "present",
        loyalty: 85,
      }],
      reputations: [],
      objectives: [{
        id: "enter-sanctuary",
        title: "Enter Sanctuary",
        description: "Get through the gate without bloodshed.",
        status: "active",
        progress: 0,
        target: 2,
      }],
      sharedResources: [{ id: "food", name: "Food", current: 4, maximum: 8 }],
    },
  });
}

async function database() {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.campaigns (
      id uuid PRIMARY KEY,
      name text NOT NULL DEFAULT ''
    );
  `);
  await ensureCampaignRpgPersistence(db);
  await db.query(
    "INSERT INTO storyhold.campaigns (id, name) VALUES ($1, 'Source'), ($2, 'Child'), ($3, 'Other')",
    [SOURCE, CHILD, OTHER],
  );
  return db;
}

function moveInside(expectedStateVersion: number): CampaignRpgStateDelta {
  return {
    expectedStateVersion,
    reason: "Alec enters Sanctuary.",
    location: { entityId: "sanctuary", name: "Sanctuary", zone: "Inside the Gate" },
    objectiveChanges: [{ kind: "progress", objectiveId: "enter-sanctuary", amount: 1 }],
  };
}

test("schema makes seeds and state events immutable while campaign deletion cascades", async () => {
  const db = await database();
  try {
    await initializeCampaignRpgState({ db, campaignId: SOURCE, seed: seed() });
    await commitCampaignRpgStateDelta({
      db,
      campaignId: SOURCE,
      requestId: "turn-1",
      delta: moveInside(0),
    });

    await assert.rejects(
      db.query(
        "UPDATE storyhold.campaign_rpg_seeds SET seed = seed WHERE campaign_id = $1",
        [SOURCE],
      ),
      /immutable/,
    );
    await assert.rejects(
      db.query(
        "DELETE FROM storyhold.campaign_rpg_seeds WHERE campaign_id = $1",
        [SOURCE],
      ),
      /immutable/,
    );
    await assert.rejects(
      db.query(
        "UPDATE storyhold.campaign_rpg_state_events SET delta = delta WHERE campaign_id = $1",
        [SOURCE],
      ),
      /append-only/,
    );
    await assert.rejects(
      db.query(
        "DELETE FROM storyhold.campaign_rpg_state_events WHERE campaign_id = $1",
        [SOURCE],
      ),
      /append-only/,
    );

    await db.query("DELETE FROM storyhold.campaigns WHERE id = $1", [SOURCE]);
    const counts = await Promise.all([
      db.query<{ count: number }>("SELECT count(*)::int AS count FROM storyhold.campaign_rpg_seeds"),
      db.query<{ count: number }>("SELECT count(*)::int AS count FROM storyhold.campaign_rpg_states"),
      db.query<{ count: number }>("SELECT count(*)::int AS count FROM storyhold.campaign_rpg_state_events"),
    ]);
    assert.deepEqual(counts.map((result) => result.rows[0]!.count), [0, 0, 0]);
  } finally {
    await db.close();
  }
});

test("initialization stores one normalized seed and current state and replays only an identical seed", async () => {
  const db = await database();
  try {
    const first = await initializeCampaignRpgState({ db, campaignId: SOURCE, seed: seed() });
    assert.equal(first.created, true);
    assert.equal(first.state.stateVersion, 0);
    assert.equal(first.baseState.stateVersion, 0);
    assert.equal(first.seedSha256, campaignRpgSha256(first.seed));
    assert.equal(first.stateSha256, campaignRpgSha256(first.state));
    assert.ok(Object.isFrozen(first.seed));
    assert.ok(Object.isFrozen(first.state));

    const replay = await initializeCampaignRpgState({ db, campaignId: SOURCE, seed: seed() });
    assert.equal(replay.created, false);
    assert.equal(replay.seedSha256, first.seedSha256);
    await assert.rejects(
      initializeCampaignRpgState({
        db,
        campaignId: SOURCE,
        seed: seed({ worldName: "Changed after launch" }),
      }),
      (error: unknown) =>
        error instanceof CampaignRpgPersistenceError &&
        error.code === "SEED_ALREADY_LOCKED",
    );
    assert.equal(
      (await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM storyhold.campaign_rpg_seeds",
      )).rows[0]!.count,
      1,
    );
  } finally {
    await db.close();
  }
});

test("accepted transition atomically updates current state and appends a hashed event", async () => {
  const db = await database();
  try {
    await initializeCampaignRpgState({ db, campaignId: SOURCE, seed: seed() });
    const delta = moveInside(0);
    const committed = await commitCampaignRpgStateDelta({
      db,
      campaignId: SOURCE,
      requestId: "accepted-turn-1",
      delta,
    });
    assert.equal(committed.replayed, false);
    assert.equal(committed.state.stateVersion, 1);
    assert.equal(committed.state.location.zone, "Inside the Gate");
    assert.equal(committed.state.objectives[0]!.progress, 1);
    assert.equal(committed.event.fromVersion, 0);
    assert.equal(committed.event.toVersion, 1);
    assert.equal(committed.event.deltaSha256, campaignRpgSha256(delta));
    assert.equal(committed.event.nextStateSha256, campaignRpgSha256(committed.state));

    const loaded = await loadCampaignRpgSnapshot(db, SOURCE);
    assert.deepEqual(loaded.state, committed.state);
    assert.equal(loaded.stateSha256, committed.event.nextStateSha256);
    const events = await loadCampaignRpgStateEvents(db, SOURCE);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], committed.event);
  } finally {
    await db.close();
  }
});

test("request replay is idempotent even after later turns and conflicting reuse fails", async () => {
  const db = await database();
  try {
    await initializeCampaignRpgState({ db, campaignId: SOURCE, seed: seed() });
    const firstDelta = moveInside(0);
    const first = await commitCampaignRpgStateDelta({
      db,
      campaignId: SOURCE,
      requestId: "stable-request",
      delta: firstDelta,
    });
    await commitCampaignRpgStateDelta({
      db,
      campaignId: SOURCE,
      requestId: "later-request",
      delta: {
        expectedStateVersion: 1,
        reason: "The group eats while they wait.",
        sharedResourceChanges: [{ kind: "adjust", poolId: "food", amount: -1 }],
      },
    });

    const replay = await commitCampaignRpgStateDelta({
      db,
      campaignId: SOURCE,
      requestId: "stable-request",
      delta: firstDelta,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.event.id, first.event.id);
    assert.deepEqual(replay.state, first.state);
    assert.equal((await loadCampaignRpgState(db, SOURCE)).stateVersion, 2);
    assert.equal(
      (await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM storyhold.campaign_rpg_state_events WHERE campaign_id = $1",
        [SOURCE],
      )).rows[0]!.count,
      2,
    );

    await assert.rejects(
      commitCampaignRpgStateDelta({
        db,
        campaignId: SOURCE,
        requestId: "stable-request",
        delta: {
          expectedStateVersion: 0,
          reason: "A different operation under the same key.",
          sharedResourceChanges: [{ kind: "adjust", poolId: "food", amount: -1 }],
        },
      }),
      (error: unknown) =>
        error instanceof CampaignRpgPersistenceError &&
        error.code === "REQUEST_ID_CONFLICT",
    );
  } finally {
    await db.close();
  }
});

test("stale or invalid transitions roll back without changing state or appending an event", async () => {
  const db = await database();
  try {
    await initializeCampaignRpgState({ db, campaignId: SOURCE, seed: seed() });
    await commitCampaignRpgStateDelta({
      db,
      campaignId: SOURCE,
      requestId: "turn-1",
      delta: moveInside(0),
    });
    await assert.rejects(
      commitCampaignRpgStateDelta({
        db,
        campaignId: SOURCE,
        requestId: "stale-turn",
        delta: moveInside(0),
      }),
      (error: unknown) =>
        error instanceof CampaignRpgPersistenceError && error.code === "STALE_STATE",
    );
    await assert.rejects(
      commitCampaignRpgStateDelta({
        db,
        campaignId: SOURCE,
        requestId: "invalid-turn",
        delta: {
          expectedStateVersion: 1,
          reason: "Impossible damage.",
          characterChanges: [{ characterId: "alec", vitalityChange: -99 }],
        },
      }),
      (error: unknown) =>
        error instanceof CampaignRpgPersistenceError && error.code === "DELTA_INVALID",
    );
    const current = await loadCampaignRpgState(db, SOURCE);
    assert.equal(current.stateVersion, 1);
    assert.equal(current.characters[0]!.vitality.current, 10);
    assert.equal(
      (await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM storyhold.campaign_rpg_state_events WHERE campaign_id = $1",
        [SOURCE],
      )).rows[0]!.count,
      1,
    );
  } finally {
    await db.close();
  }
});

test("stored seed and state fingerprints detect out-of-band tampering", async () => {
  const db = await database();
  try {
    await initializeCampaignRpgState({ db, campaignId: SOURCE, seed: seed() });
    await db.exec("DROP TRIGGER campaign_rpg_seeds_immutable ON storyhold.campaign_rpg_seeds");
    await db.query(
      `UPDATE storyhold.campaign_rpg_seeds
          SET seed = jsonb_set(seed, '{world,name}', '"Counterfeit"'::jsonb)
        WHERE campaign_id = $1`,
      [SOURCE],
    );
    await assert.rejects(
      loadCampaignRpgSnapshot(db, SOURCE),
      (error: unknown) =>
        error instanceof CampaignRpgPersistenceError && error.code === "SEED_TAMPERED",
    );
  } finally {
    await db.close();
  }

  const stateDb = await database();
  try {
    await initializeCampaignRpgState({ db: stateDb, campaignId: SOURCE, seed: seed() });
    await stateDb.query(
      `UPDATE storyhold.campaign_rpg_states
          SET state = jsonb_set(state, '{location,zone}', '"Nowhere"'::jsonb)
        WHERE campaign_id = $1`,
      [SOURCE],
    );
    await assert.rejects(
      loadCampaignRpgState(stateDb, SOURCE),
      (error: unknown) =>
        error instanceof CampaignRpgPersistenceError && error.code === "STATE_TAMPERED",
    );
  } finally {
    await stateDb.close();
  }
});

test("child campaign copies an authentic historical runtime state and then evolves independently", async () => {
  const db = await database();
  try {
    const originalSeed = seed();
    await initializeCampaignRpgState({ db, campaignId: SOURCE, seed: originalSeed });
    const atOne = await commitCampaignRpgStateDelta({
      db,
      campaignId: SOURCE,
      requestId: "source-1",
      delta: moveInside(0),
    });
    await commitCampaignRpgStateDelta({
      db,
      campaignId: SOURCE,
      requestId: "source-2",
      delta: {
        expectedStateVersion: 1,
        reason: "Alec spends ammunition defending the inner gate.",
        characterChanges: [{
          characterId: "alec",
          resourceChanges: [{ kind: "adjust", poolId: "ammo", amount: -2 }],
        }],
      },
    });

    const copied = await copyCampaignRpgStateToChild({
      db,
      sourceCampaignId: SOURCE,
      childCampaignId: CHILD,
      sourceStateVersion: 1,
    });
    assert.equal(copied.created, true);
    assert.equal(copied.state.stateVersion, 1);
    assert.deepEqual(copied.state, atOne.state);
    assert.equal(copied.baseState.stateVersion, 1);
    assert.equal(copied.seedSha256, campaignRpgSha256(originalSeed));
    assert.equal((await loadCampaignRpgState(db, SOURCE)).stateVersion, 2);
    assert.equal((await loadCampaignRpgStateEvents(db, CHILD)).length, 0);

    const replay = await copyCampaignRpgStateToChild({
      db,
      sourceCampaignId: SOURCE,
      childCampaignId: CHILD,
      sourceStateVersion: 1,
    });
    assert.equal(replay.created, false);

    const childTurn = await commitCampaignRpgStateDelta({
      db,
      campaignId: CHILD,
      requestId: "child-2",
      delta: {
        expectedStateVersion: 1,
        reason: "In this timeline, Alec gives the ammunition away.",
        characterChanges: [{
          characterId: "alec",
          resourceChanges: [{ kind: "adjust", poolId: "ammo", amount: -4 }],
        }],
      },
    });
    assert.equal(childTurn.state.characters[0]!.resources[0]!.current, 2);
    assert.equal((await loadCampaignRpgState(db, SOURCE)).characters[0]!.resources[0]!.current, 4);
    assert.equal((await loadCampaignRpgStateAtVersion(db, CHILD, 1)).characters[0]!.resources[0]!.current, 6);
    await assert.rejects(
      loadCampaignRpgStateAtVersion(db, CHILD, 0),
      (error: unknown) =>
        error instanceof CampaignRpgPersistenceError &&
        error.code === "STATE_VERSION_NOT_FOUND",
    );

    await db.query("DELETE FROM storyhold.campaigns WHERE id = $1", [SOURCE]);
    assert.equal((await loadCampaignRpgState(db, CHILD)).stateVersion, 2);
    assert.equal((await loadCampaignRpgStateEvents(db, CHILD)).length, 1);
  } finally {
    await db.close();
  }
});

test("branch copy refuses a previously initialized child with different mutable state", async () => {
  const db = await database();
  try {
    await initializeCampaignRpgState({ db, campaignId: SOURCE, seed: seed() });
    await initializeCampaignRpgState({
      db,
      campaignId: CHILD,
      seed: seed({ seedId: "another-seed", worldName: "Another World" }),
    });
    await assert.rejects(
      copyCampaignRpgStateToChild({
        db,
        sourceCampaignId: SOURCE,
        childCampaignId: CHILD,
        sourceStateVersion: 0,
      }),
      (error: unknown) =>
        error instanceof CampaignRpgPersistenceError &&
        error.code === "BRANCH_TARGET_ALREADY_INITIALIZED",
    );
  } finally {
    await db.close();
  }
});

test("missing campaigns and uninitialized campaigns fail closed", async () => {
  const db = await database();
  try {
    await assert.rejects(
      loadCampaignRpgState(db, OTHER),
      (error: unknown) =>
        error instanceof CampaignRpgPersistenceError && error.code === "NOT_INITIALIZED",
    );
    await assert.rejects(
      initializeCampaignRpgState({
        db,
        campaignId: "10000000-0000-4000-8000-000000000099",
        seed: seed(),
      }),
      (error: unknown) =>
        error instanceof CampaignRpgPersistenceError && error.code === "CAMPAIGN_NOT_FOUND",
    );
    const initial = createInitialCampaignRpgState(seed());
    assert.equal(initial.stateVersion, 0);
  } finally {
    await db.close();
  }
});

test("in-transaction integration helper participates in its caller's rollback", async () => {
  const db = await database();
  try {
    await assert.rejects(
      db.transaction(async (tx) => {
        await initializeCampaignRpgStateInTransaction({
          db: tx,
          campaignId: SOURCE,
          seed: seed(),
        });
        throw new Error("roll back the surrounding campaign creation");
      }),
      /roll back the surrounding campaign creation/,
    );
    assert.equal(
      (await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM storyhold.campaign_rpg_seeds",
      )).rows[0]!.count,
      0,
    );
    assert.equal(
      (await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM storyhold.campaign_rpg_states",
      )).rows[0]!.count,
      0,
    );
  } finally {
    await db.close();
  }
});

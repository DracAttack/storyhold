import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { type AdventureSetupContext, type AdventureSetupPlan } from "./adventureSetup";
import { adventureSetupSchemaSql, applyAdventureSetupPlanInTransaction } from "./adventureSetupPersistence";
import {
  campaignRpgPersistenceSchemaSql, initializeCampaignRpgState,
  loadCampaignRpgSnapshot, loadCampaignRpgStateEvents,
} from "./campaignRpgPersistence";
import { normalizeCampaignSeed } from "./campaignRpgState";
import { manualStorytellerSha256 } from "./manualStoryteller";

const PLAYER = "71000000-0000-4000-8000-000000000011";
const WORLD = "71000000-0000-4000-8000-000000000012";
const EDITION = "71000000-0000-4000-8000-000000000014";
const SAVED_SUMMARY = "Mara waits at the harbor gate after asking the guard for directions.";
const SAVED_NARRATION = "The guard points toward the quay. Mara has not left the gate.";
const MARA_KEY = `mara-${createHash("sha256").update("mara").digest("hex").slice(0, 12)}`;

function plan(): AdventureSetupPlan {
  return {
    publicOpening: "", locationName: "Harbor Gate",
    visibleObjective: { key: "harbor_goal", title: "Find passage across the harbor", description: "Learn which vessels can carry you to the opposite shore.", target: 3 },
    cast: [
      { key: "mara", name: "Mara", role: "Fellow traveler", presence: "present", existingSubject: MARA_KEY,
        publicSummary: SAVED_SUMMARY, privateMotivation: "Mara privately hopes to recover a letter before her family learns it is missing." },
      { key: "osa", name: "Osa", role: "Gate attendant", presence: "present", publicSummary: "Osa keeps the ferry timetable beside the gate.",
        privateMotivation: "Osa wants enough fares to repair a damaged boat without requesting a guild loan." },
      { key: "fen", name: "Fen", role: "Tide observer", presence: "unmet", publicSummary: "Fen carries a brass measuring rod.",
        privateMotivation: "Fen intends to conceal a calculation error until the harbor master leaves town." },
    ],
    secrets: [{ key: "ledger", truth: "The blue ledger records a private exemption purchased by the glassmakers guild.",
      clues: ["One dock ticket carries a blue wax mark.", "A page number is missing from the public fare list."],
      discoverableVia: ["Compare a ticket with the public fare ledger."] }],
    pressures: [
      { key: "tide", title: "The changing tide", privateSummary: "The falling tide will make the narrow quay harder to approach if no boat is moved.",
        observableConsequence: "A strip of dark mud appears beside the quay.", clueOpportunities: ["An exposed mooring mark offers a useful tide reading."],
        maturesAfterMinutes: 15, objectiveKey: "harbor_goal" },
      { key: "fare", title: "A changing fare board", privateSummary: "The ferry clerk is preparing a revised fare schedule and could still be persuaded to delay it.",
        observableConsequence: "A clerk brings a fresh chalkboard toward the gate.", clueOpportunities: ["The old board can be compared with a posted ticket."],
        maturesAfterMinutes: 30, objectiveKey: "compare_routes" },
    ],
    privateDirection: {
      premise: "Give the travelers several ways across the harbor without deciding which they choose.",
      goalSteps: [
        { key: "compare_routes", title: "Compare passage options", condition: "If the player asks about vessels or examines the timetable.", possibleNextStep: "The player might negotiate a fare or seek a different quay." },
        { key: "earn_passage", title: "Choose an arrangement", condition: "If a suitable route or helpful contact has been found.", possibleNextStep: "The player may pay, exchange assistance, or decline the crossing." },
      ],
      alternatePaths: ["A direct negotiation can obtain information without investigating the ledger.", "The player may walk along the shore and leave the ferry problem unresolved."],
    },
  };
}

/** One WASM database, isolated campaign IDs per subtest; no live endpoints. */
async function fixture(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.players (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.worlds (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.canon_editions (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.campaigns (
      id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
      owner_player_id uuid NOT NULL, name text NOT NULL, state_version bigint NOT NULL DEFAULT 1,
      status text NOT NULL DEFAULT 'active', world_time_minutes bigint NOT NULL DEFAULT 12,
      current_time_label text NOT NULL DEFAULT 'Dawn', start_contract jsonb NOT NULL
    );
    CREATE TABLE storyhold.campaign_turns (
      id uuid PRIMARY KEY, campaign_id uuid NOT NULL REFERENCES storyhold.campaigns(id),
      turn_number integer NOT NULL, narration text NOT NULL, player_input text NOT NULL
    );
    CREATE TABLE storyhold.world_state_events (
      id uuid PRIMARY KEY, campaign_id uuid NOT NULL REFERENCES storyhold.campaigns(id),
      sequence_number bigint NOT NULL CHECK (sequence_number > 0), event_type text NOT NULL,
      payload jsonb NOT NULL, caused_by_player_id uuid REFERENCES storyhold.players(id),
      UNIQUE(campaign_id, sequence_number)
    );
    CREATE TABLE storyhold.manual_storyteller_turns (id uuid PRIMARY KEY, campaign_id uuid NOT NULL, status text NOT NULL);
    CREATE TABLE storyhold.campaign_turn_requests (id uuid PRIMARY KEY, campaign_id uuid NOT NULL, status text NOT NULL);
    CREATE TABLE storyhold.campaign_turn_proposals (id uuid PRIMARY KEY, campaign_id uuid NOT NULL, status text NOT NULL);
    CREATE TABLE storyhold.campaign_state_summaries (
      id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
      campaign_id uuid NOT NULL, entity_type text NOT NULL, canonical_key text NOT NULL,
      display_name text NOT NULL, summary text NOT NULL, facts jsonb NOT NULL DEFAULT '[]',
      related_entities jsonb NOT NULL DEFAULT '[]', history jsonb NOT NULL DEFAULT '[]',
      source_memory_ids jsonb NOT NULL DEFAULT '[]', state_version bigint NOT NULL, visibility text NOT NULL,
      UNIQUE(campaign_id, entity_type, canonical_key)
    );
    CREATE TABLE storyhold.world_clock_events (
      id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL, campaign_id uuid NOT NULL,
      canonical_key text NOT NULL, event_kind text NOT NULL CHECK(event_kind IN ('scheduled_effect')),
      title text NOT NULL, summary text NOT NULL, world_time_label text NOT NULL, chronology_order bigint NOT NULL,
      visibility text NOT NULL CHECK(visibility IN ('world','campaign','character','system','studio')),
      knowledge_status text NOT NULL CHECK(knowledge_status IN ('observed','told','inferred','disputed','secret','revealed')),
      known_effects jsonb NOT NULL, internal_effects jsonb NOT NULL, scheduled_for_label text NOT NULL,
      reveal_rule jsonb NOT NULL, status text NOT NULL, due_world_time_minutes bigint,
      trigger_definition jsonb NOT NULL, causal_basis jsonb NOT NULL, clue_opportunities jsonb NOT NULL,
      created_state_version bigint NOT NULL, UNIQUE(world_id, canonical_key)
    );
    CREATE TABLE storyhold.credit_reservations (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.ai_usage_ledger (id uuid PRIMARY KEY);
  `);
  await db.exec(campaignRpgPersistenceSchemaSql);
  await db.exec(adventureSetupSchemaSql);
  await db.query("INSERT INTO storyhold.players VALUES ($1)", [PLAYER]);
  await db.query("INSERT INTO storyhold.worlds VALUES ($1)", [WORLD]);
  await db.query("INSERT INTO storyhold.canon_editions VALUES ($1)", [EDITION]);
  return db;
}

async function queued(db: PGlite, options: { objective?: boolean; location?: string; locationEntityId?: string; fresh?: boolean } = {}) {
  const campaignId = randomUUID();
  const setupId = randomUUID();
  const startContract = { experienceMode: "solo", startingPoint: "At the harbor gate.", untouched: "Immutable launch settings" };
  await db.query(`INSERT INTO storyhold.campaigns
    (id,world_id,canon_edition_id,owner_player_id,name,start_contract,world_time_minutes,state_version)
    VALUES ($1,$2,$3,$4,'Harbor Test',$5::jsonb,$6,$7)`,
  [campaignId, WORLD, EDITION, PLAYER, JSON.stringify(startContract), options.fresh ? 0 : 12, options.fresh ? 0 : 1]);
  const initial = await initializeCampaignRpgState({ db, campaignId, seed: normalizeCampaignSeed({
    seedId: `seed-${campaignId}`, origin: { kind: "original", worldId: WORLD, generatorVersion: "test" },
    world: { name: "Harbor", premise: "Travelers seek passage across a busy harbor." },
    initialState: { activeCharacterId: "mara", characters: [{ characterId: "mara", name: "Mara", stats: { strength: 13, wisdom: 14 } }],
      location: { entityId: options.locationEntityId ?? null, name: options.location ?? "Opening Scene", zone: "Gate" },
      objectives: options.objective ? [{ id: "launch-goal", title: plan().visibleObjective.title,
        description: "Keep this player-authored goal intact.", status: "active", progress: 1, target: 4 }] : [],
    },
  }) });
  if (!options.fresh) {
    await db.query("INSERT INTO storyhold.campaign_turns VALUES ($1,$2,1,$3,'Which way is the quay?')", [randomUUID(), campaignId, SAVED_NARRATION]);
    await db.query("INSERT INTO storyhold.world_state_events VALUES ($1,$2,1,'player_turn_resolved',$3::jsonb,$4)",
      [randomUUID(), campaignId, JSON.stringify({ narration: SAVED_NARRATION }), PLAYER]);
  }
  await db.query(`INSERT INTO storyhold.campaign_state_summaries
    (id,world_id,canon_edition_id,campaign_id,entity_type,canonical_key,display_name,summary,state_version,visibility)
    VALUES ($1,$2,$3,$4,'character',$5,'Mara',$6,1,'campaign')`,
  [randomUUID(), WORLD, EDITION, campaignId, MARA_KEY, SAVED_SUMMARY]);
  const context: AdventureSetupContext = {
    campaign: { id: campaignId, name: "Harbor Test", origin: "original", premise: initial.seed.world.premise },
    lockedStart: startContract.startingPoint, currentMinute: options.fresh ? 0 : 12, currentTurnNumber: options.fresh ? 0 : 1,
    existingSummary: options.fresh ? "" : SAVED_SUMMARY,
    recentTurns: options.fresh ? [] : [{ turnNumber: 1, playerAction: "Which way is the quay?", narration: SAVED_NARRATION }],
    existingCast: [{ subject: MARA_KEY, name: "Mara", publicSummary: SAVED_SUMMARY }],
  };
  const frozenInput = { context, rpgSnapshot: { seedSha256: initial.seedSha256, stateSha256: initial.stateSha256 } };
  const inputSha256 = manualStorytellerSha256(frozenInput);
  await db.query(`INSERT INTO storyhold.campaign_adventure_setups
    (id,campaign_id,player_id,expected_state_version,input_sha256,frozen_input,request)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,'{}')`,
  [setupId, campaignId, PLAYER, options.fresh ? 0 : 1, inputSha256, JSON.stringify(frozenInput)]);
  return { campaignId, setupId, inputSha256, initial, startContract, context };
}

type Queued = Awaited<ReturnType<typeof queued>>;
async function apply(db: PGlite, setup: Queued, proposed = plan()) {
  return db.transaction((tx) => applyAdventureSetupPlanInTransaction({
    db: tx, setupId: setup.setupId, inputSha256: setup.inputSha256, plan: proposed,
  }));
}

async function footprint(db: PGlite, campaignId: string) {
  const tables = ["campaigns", "campaign_turns", "world_state_events", "campaign_state_summaries", "world_clock_events",
    "campaign_adventure_setups", "campaign_rpg_seeds", "campaign_rpg_states", "campaign_rpg_state_events"];
  return Promise.all(tables.map(async (table) => ({ table, rows: (await db.query(
    `SELECT * FROM storyhold.${table} WHERE ${table === "campaigns" ? "id" : "campaign_id"} = $1`, [campaignId],
  )).rows })));
}

test("adventure setup applies atomically without creating a turn, spending, or leaking private state", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  let networkCalls = 0;
  t.mock.method(globalThis, "fetch", async () => { networkCalls += 1; throw new Error("No network permitted"); });

  await t.test("continuation installs an unprogressed goal and hidden clocks while preserving saved history and seed", async () => {
    const setup = await queued(db);
    const beforeSummary = (await db.query("SELECT * FROM storyhold.campaign_state_summaries WHERE campaign_id=$1", [setup.campaignId])).rows[0];
    const beforeTurns = (await db.query("SELECT * FROM storyhold.campaign_turns WHERE campaign_id=$1", [setup.campaignId])).rows;
    assert.deepEqual(await apply(db, setup), { duplicate: false, stateVersion: 2 });
    const campaign = (await db.query<Record<string, unknown>>("SELECT * FROM storyhold.campaigns WHERE id=$1", [setup.campaignId])).rows[0]!;
    assert.equal(Number(campaign.state_version), 2);
    assert.equal(Number(campaign.world_time_minutes), 12);
    assert.equal(campaign.current_time_label, "Dawn");
    assert.deepEqual(campaign.start_contract, setup.startContract);
    assert.deepEqual((await db.query("SELECT * FROM storyhold.campaign_turns WHERE campaign_id=$1", [setup.campaignId])).rows, beforeTurns);
    const after = await loadCampaignRpgSnapshot(db, setup.campaignId);
    assert.deepEqual(after.seed, setup.initial.seed);
    assert.equal(after.seedSha256, setup.initial.seedSha256);
    assert.deepEqual(after.state.characters, setup.initial.state.characters);
    assert.equal(after.state.location.name, "Harbor Gate");
    assert.equal(after.state.objectives.length, 1);
    assert.deepEqual(after.state.objectives[0], {
      id: `setup-${setup.setupId}-objective`, title: plan().visibleObjective.title,
      description: plan().visibleObjective.description, status: "active", progress: 0, target: 3,
    });
    const rpgEvents = await loadCampaignRpgStateEvents(db, setup.campaignId);
    assert.equal(rpgEvents.length, 1);
    assert.equal(rpgEvents[0]!.delta.turnAccepted, undefined);
    const summaries = (await db.query<Record<string, unknown>>("SELECT * FROM storyhold.campaign_state_summaries WHERE campaign_id=$1", [setup.campaignId])).rows;
    assert.deepEqual(summaries.find((row) => row.display_name === "Mara"), beforeSummary);
    assert.deepEqual(summaries.map((row) => row.display_name).sort(), ["Mara", "Osa"]);
    assert.equal(summaries.find((row) => row.display_name === "Osa")!.canonical_key,
      `osa-${createHash("sha256").update("osa").digest("hex").slice(0, 12)}`);
    const clocks = (await db.query<Record<string, unknown>>("SELECT * FROM storyhold.world_clock_events WHERE campaign_id=$1 ORDER BY chronology_order", [setup.campaignId])).rows;
    assert.equal(clocks.length, 2);
    for (const [index, clock] of clocks.entries()) {
      assert.equal(clock.visibility, "system"); assert.equal(clock.knowledge_status, "secret"); assert.equal(clock.status, "scheduled");
      assert.equal(Number(clock.created_state_version), 2);
      assert.equal(Number(clock.due_world_time_minutes), 12 + plan().pressures[index]!.maturesAfterMinutes);
      assert.deepEqual(clock.known_effects, [plan().pressures[index]!.observableConsequence]);
      assert.deepEqual(clock.internal_effects, [plan().pressures[index]!.privateSummary]);
      assert.deepEqual(clock.clue_opportunities, plan().pressures[index]!.clueOpportunities);
    }
    const visibleClocks = await db.query(`SELECT * FROM storyhold.world_clock_events WHERE campaign_id=$1
      AND visibility IN ('world','campaign') AND knowledge_status <> 'secret'`, [setup.campaignId]);
    assert.equal(visibleClocks.rows.length, 0);
    const events = (await db.query<Record<string, unknown>>("SELECT * FROM storyhold.world_state_events WHERE campaign_id=$1 ORDER BY sequence_number", [setup.campaignId])).rows;
    assert.equal(events.length, 2); assert.equal(events[1]!.event_type, "adventure_initialized");
    assert.deepEqual(Object.keys(events[1]!.payload as object).sort(), ["goal", "opening", "setupId", "summary"]);
    const publicJson = JSON.stringify({ events, summaries, rpgEvents });
    for (const privateText of [plan().secrets[0]!.truth, plan().privateDirection.premise, ...plan().cast.map((npc) => npc.privateMotivation), ...plan().pressures.map((pressure) => pressure.privateSummary)]) {
      assert.ok(!publicJson.includes(privateText));
    }
    assert.ok(!publicJson.includes("Fen"));
    const saved = (await db.query<Record<string, unknown>>("SELECT * FROM storyhold.campaign_adventure_setups WHERE id=$1", [setup.setupId])).rows[0]!;
    assert.equal(saved.status, "ready"); assert.deepEqual(saved.plan, plan());
    assert.equal(saved.plan_sha256, manualStorytellerSha256(plan()));
  });

  await t.test("identical replay survives later campaign advancement; different plans never overwrite", async () => {
    const setup = await queued(db); await apply(db, setup);
    await db.query("UPDATE storyhold.campaigns SET state_version=3, world_time_minutes=20 WHERE id=$1", [setup.campaignId]);
    const before = await footprint(db, setup.campaignId);
    assert.deepEqual(await apply(db, setup), { duplicate: true, stateVersion: 2 });
    assert.deepEqual(await footprint(db, setup.campaignId), before);
    const changed = plan(); changed.privateDirection.premise = "A different private premise must not replace the accepted plan.";
    await assert.rejects(apply(db, setup, changed), /ADVENTURE_SETUP_PLAN_CONFLICT/);
    assert.deepEqual(await footprint(db, setup.campaignId), before);
  });

  await t.test("an existing objective and real location retain every original field", async () => {
    const setup = await queued(db, { objective: true, location: "Harbor Gate", locationEntityId: "gate-entity" });
    await apply(db, setup);
    const after = await loadCampaignRpgSnapshot(db, setup.campaignId);
    assert.deepEqual(after.state.objectives, setup.initial.state.objectives);
    assert.deepEqual(after.state.location, setup.initial.state.location);
    const otherGoal = await queued(db, { objective: true });
    const changed = plan(); changed.visibleObjective.title = "Replace the existing goal";
    await assert.rejects(apply(db, otherGoal, changed), /ADVENTURE_SETUP_OBJECTIVE_CONFLICT/);
    const realLocation = await queued(db, { location: "Market Square", locationEntityId: "market" });
    await assert.rejects(apply(db, realLocation), /ADVENTURE_SETUP_LOCATION_CONFLICT/);
    const realGenericName = await queued(db, { location: "Opening Scene", locationEntityId: "real-place" });
    await assert.rejects(apply(db, realGenericName), /ADVENTURE_SETUP_LOCATION_CONFLICT/);
  });

  await t.test("fresh setup writes opening once and no player turn", async () => {
    const setup = await queued(db, { fresh: true });
    const proposed = plan(); proposed.publicOpening = "At the harbor gate, a ferry timetable offers several routes. Which would you like to examine?";
    assert.deepEqual(await apply(db, setup, proposed), { duplicate: false, stateVersion: 1 });
    assert.equal((await db.query("SELECT id FROM storyhold.campaign_turns WHERE campaign_id=$1", [setup.campaignId])).rows.length, 0);
    const event = (await db.query<{ payload: { opening: string } }>("SELECT payload FROM storyhold.world_state_events WHERE campaign_id=$1", [setup.campaignId])).rows[0]!;
    assert.equal(event.payload.opening, proposed.publicOpening);
  });

  await t.test("a final-write failure rolls back RPG state, summaries, clocks and the public event together", async () => {
    const setup = await queued(db);
    await db.exec(`CREATE FUNCTION storyhold.reject_test_setup_ready() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status = 'ready' THEN RAISE EXCEPTION 'test final write rejected'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER reject_test_setup_ready BEFORE UPDATE ON storyhold.campaign_adventure_setups
      FOR EACH ROW EXECUTE FUNCTION storyhold.reject_test_setup_ready();`);
    const before = await footprint(db, setup.campaignId);
    try { await assert.rejects(apply(db, setup), /test final write rejected/); }
    finally { await db.exec("DROP TRIGGER reject_test_setup_ready ON storyhold.campaign_adventure_setups; DROP FUNCTION storyhold.reject_test_setup_ready();"); }
    assert.deepEqual(await footprint(db, setup.campaignId), before);
  });

  await t.test("stale state, corrupted frozen input, invalid plans and every pending turn channel reject without writes", async () => {
    const stale = await queued(db);
    await db.query("UPDATE storyhold.campaigns SET state_version=2 WHERE id=$1", [stale.campaignId]);
    const staleBefore = await footprint(db, stale.campaignId);
    await assert.rejects(apply(db, stale), /ADVENTURE_SETUP_STATE_CHANGED/);
    assert.deepEqual(await footprint(db, stale.campaignId), staleBefore);
    const corrupt = await queued(db);
    await db.query("UPDATE storyhold.campaign_adventure_setups SET frozen_input=jsonb_set(frozen_input,'{context,currentMinute}','99') WHERE id=$1", [corrupt.setupId]);
    const corruptBefore = await footprint(db, corrupt.campaignId);
    await assert.rejects(apply(db, corrupt), /ADVENTURE_SETUP_INPUT_CHANGED/);
    assert.deepEqual(await footprint(db, corrupt.campaignId), corruptBefore);
    const invalid = await queued(db);
    const badPlan = plan(); badPlan.pressures[0]!.maturesAfterMinutes = 0;
    const invalidBefore = await footprint(db, invalid.campaignId);
    await assert.rejects(apply(db, invalid, badPlan), /Invalid adventure setup/);
    assert.deepEqual(await footprint(db, invalid.campaignId), invalidBefore);
    for (const [table, status] of [
      ["manual_storyteller_turns", "awaiting_direction"], ["manual_storyteller_turns", "awaiting_narration"],
      ["campaign_turn_requests", "generating"], ["campaign_turn_requests", "generated"], ["campaign_turn_proposals", "pending"],
    ]) {
      const setup = await queued(db);
      await db.query(`INSERT INTO storyhold.${table} VALUES ($1,$2,$3)`, [randomUUID(), setup.campaignId, status]);
      const before = await footprint(db, setup.campaignId);
      await assert.rejects(apply(db, setup), /ADVENTURE_SETUP_TURN_PENDING/);
      assert.deepEqual(await footprint(db, setup.campaignId), before);
    }
  });
  assert.equal(networkCalls, 0);
  assert.equal((await db.query("SELECT * FROM storyhold.credit_reservations")).rows.length, 0);
  assert.equal((await db.query("SELECT * FROM storyhold.ai_usage_ledger")).rows.length, 0);
});

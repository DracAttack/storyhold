import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import {
  campaignPlaySchemaSql, queueManualStorytellerTurn,
  submitManualStorytellerDirection, completeManualStorytellerTurn,
  registerCampaignPlayRoutes,
} from "./campaignPlay";
import { manualStorytellerEnabled, manualStorytellerSha256 } from "./manualStoryteller";

const PLAYER = "70000000-0000-4000-8000-000000000011";
const WORLD = "70000000-0000-4000-8000-000000000012";
const CAMPAIGN = "70000000-0000-4000-8000-000000000013";
const EDITION = "70000000-0000-4000-8000-000000000014";

function context(options: {
  narrativeLength?: string;
  lockedNarrativeLength?: string;
  experienceMode?: "solo" | "author";
  voice?: { tone: string; genre: string; premise: string; characterConcept: string };
} = {}) {
  const voice = options.voice ?? {
    tone: "Harbor adventure",
    genre: "Adventure",
    premise: "A traveler navigates a difficult harbor city.",
    characterConcept: "A resourceful traveler looking for a way forward.",
  };
  return {
    campaign: { id: CAMPAIGN, world_id: WORLD, canon_edition_id: EDITION,
      owner_player_id: PLAYER, state_version: 0, world_time_minutes: 0,
      status: "active", start_contract: { experienceMode: options.experienceMode ?? "solo", startingPoint: "At the harbor gate.",
        world: { genre: voice.genre, premise: voice.premise },
        worldContract: { tone: voice.tone, premise: voice.premise },
        character: { concept: voice.characterConcept },
        ...(options.lockedNarrativeLength ? { storyPreferences: { narrativeLength: options.lockedNarrativeLength } } : {}) },
      current_time_label: "Dawn", character_name: "Mara", world_name: "Harbor", resolution_mode: "story_first", world_contract: {}, content_settings: {} },
    player: { id: PLAYER, role: "owner", credits: 500 },
    preferences: options.narrativeLength ? { narrative_length: options.narrativeLength } : {}, learnedPreferenceProfile: {},
    recentFeedbackSignals: [], communityPreferenceSignals: [], turns: [], memories: [], sourceChunks: [],
    referenceLore: [], characterDossiers: [], entityIndex: [], canonicalEntityPackets: [], stateSummaries: [],
    breakdown: null, rules: [], clockEvents: [], canonHistory: [], worldClaims: [], importedCanonClaims: [],
    facts: [], epistemicAssertions: [], noveltyMoves: [], amendments: [], rpgSnapshot: null,
    retrievalDiagnostics: { queryHash: "test", cacheHit: false, candidatePassages: 0, selectedPassages: 0,
      resolvedEntities: [], graphNeighbors: [], multiHopNeighbors: [], graphPaths: [], coverageTerms: [],
      missingCoverageTerms: [], atomicClaims: 0, reranker: {}, browserAssist: null,
      localPrecheck: { status: "disabled", entities: [], relations: 0, signals: 0, elapsedMilliseconds: 0 } },
    expectedSequence: 0,
  };
}

async function fixture() {
  const db = await PGlite.create({ extensions: { vector } });
  await db.exec(`
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.players (id uuid PRIMARY KEY, role text, credits integer, display_name text);
    CREATE TABLE storyhold.worlds (id uuid PRIMARY KEY, name text);
    CREATE TABLE storyhold.characters (id uuid PRIMARY KEY, name text);
    CREATE TABLE storyhold.canon_editions (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.campaigns (id uuid PRIMARY KEY, world_id uuid, owner_player_id uuid,
      name text, state_version bigint DEFAULT 0, status text DEFAULT 'active',
      world_time_minutes bigint DEFAULT 0, current_time_label text DEFAULT 'Dawn', start_contract jsonb DEFAULT '{}', created_at timestamptz DEFAULT now());
    CREATE TABLE storyhold.campaign_members (campaign_id uuid, player_id uuid);
    CREATE TABLE storyhold.world_state_events (id uuid PRIMARY KEY, campaign_id uuid, sequence_number bigint,
      event_type text, payload jsonb, caused_by_player_id uuid);
    CREATE TABLE storyhold.vault_memory_chunks (id uuid PRIMARY KEY, world_id uuid, campaign_id uuid,
      player_id uuid, character_id uuid, memory_kind text, content text, compact_summary text,
      metadata jsonb, state_version bigint);
    CREATE TABLE storyhold.world_clock_events (id uuid PRIMARY KEY, campaign_id uuid,
      canonical_key text, event_kind text, title text, summary text, world_time_label text,
      chronology_order bigint, visibility text, knowledge_status text, known_effects jsonb,
      scheduled_for_label text, due_world_time_minutes bigint, due_turn_number bigint,
      matured_at timestamptz, matured_state_version bigint, maturation_narrated_at timestamptz,
      matured_by_event_id uuid, visible_to_character_id uuid, status text, created_at timestamptz DEFAULT now());
    CREATE TABLE storyhold.campaign_runtime_rules (id uuid PRIMARY KEY, campaign_id uuid, status text, created_at timestamptz DEFAULT now());
    CREATE TABLE storyhold.credit_reservations (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.ai_usage_ledger (id uuid PRIMARY KEY);
  `);
  try { await db.exec(campaignPlaySchemaSql); } catch (error) { await db.close(); throw error; }
  await db.query("INSERT INTO storyhold.players VALUES ($1, 'owner', 500, 'Operator')", [PLAYER]);
  await db.query("INSERT INTO storyhold.worlds VALUES ($1, 'Harbor')", [WORLD]);
  await db.query("INSERT INTO storyhold.canon_editions VALUES ($1)", [EDITION]);
  await db.query("INSERT INTO storyhold.campaigns(id, world_id, owner_player_id, name) VALUES ($1,$2,$3,'Harbor Test')", [CAMPAIGN,WORLD,PLAYER]);
  return db;
}

async function saved(db: PGlite, id: string) {
  return (await db.query<Record<string, any>>("SELECT * FROM storyhold.manual_storyteller_turns WHERE id = $1", [id])).rows[0]!;
}

async function isolatedCampaignContext(db: PGlite, options: Parameters<typeof context>[0] = {}) {
  const isolated = context(options);
  isolated.campaign.id = randomUUID();
  await db.query("INSERT INTO storyhold.campaigns(id, world_id, owner_player_id, name) VALUES ($1,$2,$3,'Isolated Prompt Test')",
    [isolated.campaign.id, WORLD, PLAYER]);
  return isolated;
}

function responseFor(row: Record<string, any>) {
  const envelope = row.frozen_input.request.engineEnvelope;
  return {
    sceneSummary: "Mara asks the guard which way leads to the harbor.",
    outcome: envelope.resolution.outcome, worldTimeLabel: "", timeAdvanceMinutes: envelope.resolution.timeAdvanceMinutes,
    stateChanges: [], rpgStateChange: null, clockEvents: [], memories: [], propositions: [], storyMoves: [],
    resolveClockEventIds: [], acknowledgedMaturedClockEventIds: [],
    progression: { actionScope: envelope.progression.actionScope,
      resolvedAction: "Ask the guard for directions.", objectiveImpact: "none", objectiveTargetsAdvanced: [],
      advancementSource: "none", causalSteps: ["Mara asks the guard for directions."] },
  };
}

function enable(t: TestContext) {
  const names = ["NODE_ENV", "STORYHOLD_MANUAL_STORYTELLER", "REPLIT_DEPLOYMENT", "STORYHOLD_LOCAL_GLINER2_ENABLED", "STORYHOLD_LOCAL_NLI_ENABLED", "SOURCE_VAULT_EMBED_PROVIDER"];
  const before = Object.fromEntries(names.map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = "test";
  process.env.STORYHOLD_MANUAL_STORYTELLER = "true";
  delete process.env.REPLIT_DEPLOYMENT;
  process.env.STORYHOLD_LOCAL_GLINER2_ENABLED = "false";
  process.env.STORYHOLD_LOCAL_NLI_ENABLED = "false";
  process.env.SOURCE_VAULT_EMBED_PROVIDER = "local";
  t.after(() => { for (const key of names) {
    if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
  } });
}

test("manual mode requires an explicit flag, operator role, and a non-deployed process", () => {
  assert.equal(manualStorytellerEnabled("owner", { STORYHOLD_MANUAL_STORYTELLER: "true" }), true);
  assert.equal(manualStorytellerEnabled("player", { STORYHOLD_MANUAL_STORYTELLER: "true" }), false);
  assert.equal(manualStorytellerEnabled("owner", { STORYHOLD_MANUAL_STORYTELLER: "true", NODE_ENV: "production" }), false);
  assert.equal(manualStorytellerEnabled("owner", { STORYHOLD_MANUAL_STORYTELLER: "true", REPLIT_DEPLOYMENT: "1" }), false);
  assert.equal(manualStorytellerEnabled("admin", {}), false);
});

test("narrator prompts carry a binding voice brief across distinct story modes", async (t) => {
  enable(t);
  const db = await fixture(); t.after(() => db.close());
  const cases = [
    { tone: "Anime workplace comedy", genre: "Anime workplace comedy", premise: "A fallen demon lord works at a fast-food restaurant.", characterConcept: "A proud demon lord trapped in a humiliating day job." },
    { tone: "Slow-burn cosmic horror", genre: "Cosmic horror", premise: "A research crew traces a signal beneath polar ice.", characterConcept: "A skeptical field scientist." },
    { tone: "Warm second-chance romance", genre: "Contemporary romance", premise: "Two former friends reopen a neighborhood bookstore.", characterConcept: "A guarded bookseller." },
    { tone: "Kinetic pulp action", genre: "Adventure action", premise: "A courier races a stolen device across a flooded city.", characterConcept: "A reckless but loyal courier." },
    { tone: "Intimate literary drama", genre: "Literary fiction", premise: "A daughter returns home to settle her mother's estate.", characterConcept: "A grieving archivist." },
  ];
  for (const voice of cases) {
    const isolated = await isolatedCampaignContext(db, { voice });
    const queued = await queueManualStorytellerTurn({ db, context: isolated,
      action: "I study the harbor gate.", intent: "action", requestId: randomUUID() });
    const row = await saved(db, queued.manualTurn.id);
    await submitManualStorytellerDirection({ db, id: row.id, operatorId: PLAYER,
      inputSha256: row.input_sha256, direction: responseFor(row) });
    const directed = await saved(db, row.id);
    assert.match(directed.narrator_request.system, /binding craft direction/i);
    assert.match(directed.narrator_request.system, /generic sardonic narration/i);
    assert.match(directed.narrator_request.system, /genuine crossroads/i);
    assert.match(directed.narrator_request.system, /not provide them every turn/i);
    assert.match(directed.narrator_request.system, /intent and attempted action/i);
    assert.match(directed.narrator_request.system, /at least two concrete elements/i);
    assert.match(directed.narrator_request.system, /ordinary texture, momentary reactions, and non-durable staging/i);
    assert.match(directed.narrator_request.messages[0].content, /narrativeVoice/);
    assert.match(directed.narrator_request.messages[0].content, new RegExp(voice.tone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(directed.narrator_request.messages[0].content, new RegExp(voice.characterConcept.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("manual queue freezes input, rejects bad direction, commits one real turn, and spends nothing", async (t) => {
  enable(t);
  const db = await fixture(); t.after(() => db.close());
  let networkCalls = 0;
  t.mock.method(globalThis, "fetch", async () => { networkCalls += 1; throw new Error("No network permitted in manual tests"); });
  const preparedContext = { ...context(), adventureSetup: {id:"test-setup",status:"ready",applied_state_version:0,
    plan:{secrets:[{truth:"The sealed blue ledger records the clerk's private debt."}], worldFoundation:{ identitySecrecy:{status:"secret",truth:"Mara does not know the traveler's private origin.",knownBy:["Mara"],exposureStakes:"A reveal changes trust."}, broaderForces:[{name:"Harbor Guild"}], unresolvedBackground:[{question:"Who changed the tide chart?"}] } } } };
  const queued = await queueManualStorytellerTurn({ db, context: preparedContext, action: "Which way is the harbor?", intent: "question", requestId: "manual-test-first" });
  const row = await saved(db, queued.manualTurn.id);
  assert.equal(queued.creditsUsed, 0);
  assert.equal(row.input_sha256, manualStorytellerSha256(row.frozen_input));
  assert.equal(row.frozen_input.narrationPolicy, "intent-aware");
  assert.match(row.director_request.system, /private game Director/);
  assert.match(row.director_request.messages[0].content, /sealed blue ledger/);
  assert.match(row.director_request.messages[0].content, /Mara does not know the traveler's private origin/);
  assert.equal((await db.query("SELECT * FROM storyhold.campaign_turns")).rows.length, 0);
  const replay = await queueManualStorytellerTurn({ db, context: preparedContext, action: "Which way is the harbor?", intent: "question", requestId: "manual-test-first" });
  assert.equal(replay.manualTurn.id, queued.manualTurn.id);
  await assert.rejects(queueManualStorytellerTurn({ db, context: context(), action: "Steal a boat.", intent: "action", requestId: "manual-test-first" }), /CONFLICT/);
  await assert.rejects(submitManualStorytellerDirection({ db, id: row.id, operatorId: PLAYER, inputSha256: row.input_sha256,
    direction: { ...responseFor(row), outcome: "success" } }), /outcome|Outcome|resolution|RESOLUTION/);
  assert.equal((await saved(db, row.id)).status, "awaiting_direction");
  await submitManualStorytellerDirection({ db, id: row.id, operatorId: PLAYER, inputSha256: row.input_sha256, direction: responseFor(row) });
  const directed = await saved(db, row.id);
  assert.equal(directed.status, "awaiting_narration");
  assert.match(directed.narrator_request.system, /player-facing prose/);
  assert.doesNotMatch(JSON.stringify(directed.narrator_request), /sealed blue ledger|private debt|private origin|PRIVATE ADVENTURE FOUNDATION/);
  assert.match(directed.narrator_request.messages[0].content, /1-3 sentences/);
  assert.match(directed.narrator_request.messages[0].content, /No minimum word count/);
  assert.doesNotMatch(directed.narrator_request.messages[0].content, /Write roughly 220-420 words/);
  await assert.rejects(completeManualStorytellerTurn({ db, id: row.id, operatorId: PLAYER, inputSha256: row.input_sha256, narration: "x".repeat(12001) }), /not be truncated/);
  // Changing embedding settings after queueing must not cause a paid side effect.
  process.env.SOURCE_VAULT_EMBED_PROVIDER = "perplexity";
  const narration = 'The guard tips her chin toward the quays. "Harbor is that way," she says. Gulls wheel over the rooftops.';
  const completed = await completeManualStorytellerTurn({ db, id: row.id, operatorId: PLAYER, inputSha256: row.input_sha256, narration, notes: "No objective delivered early." });
  assert.equal(completed.duplicate, false);
  assert.equal(completed.turn?.narration, narration);
  assert.equal((await saved(db, row.id)).status, "completed");
  const duplicate = await completeManualStorytellerTurn({ db, id: row.id, operatorId: PLAYER, inputSha256: row.input_sha256, narration });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.turn?.id, completed.turn?.id);
  assert.equal((await db.query("SELECT * FROM storyhold.campaign_turns")).rows.length, 1);
  assert.equal((await db.query("SELECT * FROM storyhold.world_state_events")).rows.length, 1);
  assert.equal((await db.query("SELECT * FROM storyhold.credit_reservations")).rows.length, 0);
  assert.equal((await db.query("SELECT * FROM storyhold.ai_usage_ledger")).rows.length, 0);
  assert.equal((await db.query<{credits:number}>("SELECT credits FROM storyhold.players")).rows[0]!.credits, 500);
  assert.equal(networkCalls, 0);
});

test("question prompts stay brief across narrative preferences while action and event targets remain unchanged", async (t) => {
  enable(t);
  const db = await fixture(); t.after(() => db.close());
  let networkCalls = 0;
  t.mock.method(globalThis, "fetch", async () => { networkCalls += 1; throw new Error("No network permitted in manual tests"); });
  const lengths = [
    { value: undefined, directive: "Write roughly 220-420 words.", tokens: 1_500 },
    { value: "concise", directive: "Write roughly 120-220 words.", tokens: 1_500 },
    { value: "balanced", directive: "Write roughly 220-420 words.", tokens: 1_500 },
    { value: "expansive", directive: "Write roughly 450-800 words when the scene supports it.", tokens: 2_400 },
  ];
  for (const intent of ["question", "action", "event"] as const) {
    for (const length of lengths) {
      await t.test(`${intent} with ${length.value ?? "default"} length`, async () => {
        const queued = await queueManualStorytellerTurn({ db,
          context: await isolatedCampaignContext(db, { narrativeLength: length.value, experienceMode: intent === "event" ? "author" : "solo" }),
          action: "Which way is the harbor?", intent, requestId: `manual-length-${intent}-${length.value ?? "default"}` });
        const row = await saved(db, queued.manualTurn.id);
        assert.equal(row.frozen_input.narrationPolicy, "intent-aware");
        assert.equal(row.director_request.maxOutputTokens, 3_200);
        assert.doesNotMatch(row.director_request.messages[0].content, /1-3 sentences|No minimum word count/);
        await submitManualStorytellerDirection({ db, id: row.id, operatorId: PLAYER,
          inputSha256: row.input_sha256, direction: responseFor(row) });
        const directed = await saved(db, row.id);
        const prompt = directed.narrator_request.messages[0].content;
        assert.match(prompt, new RegExp(`INPUT KIND: ${intent}`));
        if (intent === "question") {
          assert.match(prompt, /1-3 sentences/);
          assert.match(prompt, /No minimum word count/);
          assert.match(prompt, /Give more detail only when the question genuinely needs it or the player explicitly asks for it/);
          assert.doesNotMatch(prompt, /Write roughly (?:120-220|220-420|450-800) words/);
        } else {
          assert.ok(prompt.includes(length.directive));
          assert.doesNotMatch(prompt, /1-3 sentences|No minimum word count/);
          assert.equal(directed.narrator_request.maxOutputTokens, length.tokens);
        }
        assert.equal((await db.query("SELECT * FROM storyhold.credit_reservations")).rows.length, 0);
        assert.equal((await db.query("SELECT * FROM storyhold.ai_usage_ledger")).rows.length, 0);
      });
    }
  }
  assert.equal(networkCalls, 0);
});

test("locked scene length retains precedence without making questions expansive", async (t) => {
  enable(t);
  const db = await fixture(); t.after(() => db.close());
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No network permitted in manual tests"); });
  for (const intent of ["question", "action"] as const) {
    await t.test(intent, async () => {
      const queued = await queueManualStorytellerTurn({ db,
        context: await isolatedCampaignContext(db, { narrativeLength: "concise", lockedNarrativeLength: "expansive" }),
        action: "Which way is the harbor?", intent, requestId: `manual-locked-length-${intent}` });
      const row = await saved(db, queued.manualTurn.id);
      await submitManualStorytellerDirection({ db, id: row.id, operatorId: PLAYER,
        inputSha256: row.input_sha256, direction: responseFor(row) });
      const directed = await saved(db, row.id);
      const prompt = directed.narrator_request.messages[0].content;
      if (intent === "question") {
        assert.match(prompt, /1-3 sentences/);
        assert.match(prompt, /No minimum word count/);
        assert.doesNotMatch(prompt, /Write roughly (?:120-220|220-420|450-800) words/);
      } else {
        assert.match(prompt, /Write roughly 450-800 words when the scene supports it/);
        assert.doesNotMatch(prompt, /Write roughly 120-220 words/);
        assert.equal(directed.narrator_request.maxOutputTokens, 2_400);
      }
    });
  }
});

test("legacy frozen manual packets resume both pending stages with their exact original requests", async (t) => {
  enable(t);
  const db = await fixture(); t.after(() => db.close());
  let networkCalls = 0;
  t.mock.method(globalThis, "fetch", async () => { networkCalls += 1; throw new Error("No network permitted in manual tests"); });
  for (const length of [undefined, "expansive"]) {
    await t.test(length ?? "default", async () => {
      const requestId = `manual-legacy-length-${length ?? "default"}`;
      const legacyContext = await isolatedCampaignContext(db, { narrativeLength: length });
      const queued = await queueManualStorytellerTurn({ db, context: legacyContext,
        action: "Which way is the harbor?", intent: "question", requestId });
      const current = await saved(db, queued.manualTurn.id);
      await submitManualStorytellerDirection({ db, id: current.id, operatorId: PLAYER,
        inputSha256: current.input_sha256, direction: responseFor(current) });
      const currentDirected = await saved(db, current.id);
      // Rebuild the historical Narrator request independently of the legacy code branch:
      // the original format put one literal length sentence after the content-settings line.
      const expectedLegacyNarrator = structuredClone(currentDirected.narrator_request);
      const currentPrompt = expectedLegacyNarrator.messages[0].content as string;
      const inputKindOffset = currentPrompt.indexOf("\nINPUT KIND: question\n");
      assert.ok(inputKindOffset > 0);
      const legacyDirective = length === "expansive"
        ? "Write roughly 450-800 words when the scene supports it."
        : "Write roughly 220-420 words.";
      expectedLegacyNarrator.messages[0].content = currentPrompt.slice(0, currentPrompt.indexOf("\n")) +
        "\n" + legacyDirective + currentPrompt.slice(inputKindOffset);
      expectedLegacyNarrator.maxOutputTokens = length === "expansive" ? 2_400 : 1_500;
      // Simulate an already-saved pre-policy packet, whose hash never included a policy marker.
      const legacyFrozen = structuredClone(current.frozen_input);
      delete legacyFrozen.narrationPolicy;
      const legacyHash = manualStorytellerSha256(legacyFrozen);
      await db.query(`UPDATE storyhold.manual_storyteller_turns SET frozen_input = $2::jsonb, input_sha256 = $3,
        status = 'awaiting_direction', direction = NULL, narrator_request = NULL WHERE id = $1`,
        [current.id, JSON.stringify(legacyFrozen), legacyHash]);
      const legacy = await saved(db, current.id);
      assert.equal(legacy.status, "awaiting_direction");
      assert.deepEqual(legacy.director_request, current.director_request);
      const changedContext = { ...legacyContext, preferences: { narrative_length: "concise" } };
      const requeued = await queueManualStorytellerTurn({ db, context: changedContext,
        action: "Which way is the harbor?", intent: "question", requestId });
      assert.equal(requeued.duplicate, true);
      assert.equal(requeued.manualTurn.id, legacy.id);
      await submitManualStorytellerDirection({ db, id: legacy.id, operatorId: PLAYER,
        inputSha256: legacyHash, direction: responseFor(legacy) });
      const directed = await saved(db, legacy.id);
      assert.equal(directed.status, "awaiting_narration");
      assert.deepEqual(directed.director_request, current.director_request);
      assert.equal(directed.input_sha256, legacyHash);
      assert.equal(directed.frozen_input.narrationPolicy, undefined);
      assert.deepEqual(directed.narrator_request, expectedLegacyNarrator);
      assert.match(directed.narrator_request.messages[0].content,
        length === "expansive" ? /Write roughly 450-800 words when the scene supports it/ : /Write roughly 220-420 words/);
      assert.doesNotMatch(directed.narrator_request.messages[0].content, /1-3 sentences|No minimum word count/);
      assert.equal(directed.narrator_request.maxOutputTokens, length === "expansive" ? 2_400 : 1_500);
      const repeatedDirection = await submitManualStorytellerDirection({ db, id: legacy.id, operatorId: PLAYER,
        inputSha256: legacyHash, direction: responseFor(legacy) });
      assert.equal(repeatedDirection.duplicate, true);
      assert.deepEqual((await saved(db, legacy.id)).narrator_request, directed.narrator_request);
      const narration = 'The guard points toward the quays. "Harbor is that way," she says.';
      const completed = await completeManualStorytellerTurn({ db, id: legacy.id, operatorId: PLAYER,
        inputSha256: legacyHash, narration });
      assert.equal(completed.duplicate, false);
      const duplicate = await completeManualStorytellerTurn({ db, id: legacy.id, operatorId: PLAYER,
        inputSha256: legacyHash, narration });
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.turn?.id, completed.turn?.id);
      assert.deepEqual((await saved(db, legacy.id)).narrator_request, directed.narrator_request);
      assert.equal((await db.query("SELECT * FROM storyhold.campaign_turns WHERE campaign_id = $1", [legacyContext.campaign.id])).rows.length, 1);
      assert.equal((await db.query("SELECT * FROM storyhold.credit_reservations")).rows.length, 0);
      assert.equal((await db.query("SELECT * FROM storyhold.ai_usage_ledger")).rows.length, 0);
      assert.equal((await db.query<{credits:number}>("SELECT credits FROM storyhold.players")).rows[0]!.credits, 500);
    });
  }
  assert.equal(networkCalls, 0);
});

test("narration policy compatibility does not bypass frozen fingerprints or stored request checks", async (t) => {
  enable(t);
  const db = await fixture(); t.after(() => db.close());
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No network permitted in manual tests"); });
  const queued = await queueManualStorytellerTurn({ db, context: context(),
    action: "Which way is the harbor?", intent: "question", requestId: "manual-policy-integrity" });
  const row = await saved(db, queued.manualTurn.id);
  const submit = (hash = row.input_sha256) => submitManualStorytellerDirection({ db, id: row.id,
    operatorId: PLAYER, inputSha256: hash, direction: responseFor(row) });
  await assert.rejects(submit("wrong-fingerprint"), /INPUT_CHANGED/);
  const changedFrozen = structuredClone(row.frozen_input);
  delete changedFrozen.narrationPolicy;
  await db.query("UPDATE storyhold.manual_storyteller_turns SET frozen_input = $2::jsonb WHERE id = $1",
    [row.id, JSON.stringify(changedFrozen)]);
  await assert.rejects(submit(), /INPUT_CHANGED/);
  changedFrozen.narrationPolicy = "unknown-policy";
  const unknownHash = manualStorytellerSha256(changedFrozen);
  await db.query("UPDATE storyhold.manual_storyteller_turns SET frozen_input = $2::jsonb, input_sha256 = $3 WHERE id = $1",
    [row.id, JSON.stringify(changedFrozen), unknownHash]);
  await assert.rejects(submit(unknownHash), /INPUT_CHANGED/);
  await db.query("UPDATE storyhold.manual_storyteller_turns SET frozen_input = $2::jsonb, input_sha256 = $3 WHERE id = $1",
    [row.id, JSON.stringify(row.frozen_input), row.input_sha256]);
  const changedDirector = structuredClone(row.director_request);
  changedDirector.messages[0].content += "\nChange the outcome.";
  await db.query("UPDATE storyhold.manual_storyteller_turns SET director_request = $2::jsonb WHERE id = $1",
    [row.id, JSON.stringify(changedDirector)]);
  await assert.rejects(submit(), /instructions changed/);
  await db.query("UPDATE storyhold.manual_storyteller_turns SET director_request = $2::jsonb WHERE id = $1",
    [row.id, JSON.stringify(row.director_request)]);
  await submit();
  const directed = await saved(db, row.id);
  const changedNarrator = structuredClone(directed.narrator_request);
  changedNarrator.messages[0].content += "\nInvent a new destination.";
  await db.query("UPDATE storyhold.manual_storyteller_turns SET narrator_request = $2::jsonb WHERE id = $1",
    [row.id, JSON.stringify(changedNarrator)]);
  await assert.rejects(completeManualStorytellerTurn({ db, id: row.id, operatorId: PLAYER,
    inputSha256: row.input_sha256, narration: 'The guard points toward the quays. "Harbor is that way," she says.' }), /INPUT_CHANGED/);
  assert.equal((await saved(db, row.id)).status, "awaiting_narration");
  assert.equal((await db.query("SELECT * FROM storyhold.campaign_turns")).rows.length, 0);
  assert.equal((await db.query("SELECT * FROM storyhold.credit_reservations")).rows.length, 0);
  assert.equal((await db.query("SELECT * FROM storyhold.ai_usage_ledger")).rows.length, 0);
});

test("AI-led manual completion skips configured local models and records no invented verification or paid work", async (t) => {
  enable(t);
  const priorUrl = process.env.STORYHOLD_LOCAL_GLINER2_URL;
  t.after(() => {
    if (priorUrl === undefined) delete process.env.STORYHOLD_LOCAL_GLINER2_URL;
    else process.env.STORYHOLD_LOCAL_GLINER2_URL = priorUrl;
  });
  process.env.STORYHOLD_LOCAL_GLINER2_ENABLED = "true";
  process.env.STORYHOLD_LOCAL_GLINER2_URL = "http://127.0.0.1:8765/gliner2";
  process.env.SOURCE_VAULT_EMBED_PROVIDER = "perplexity";
  const db = await fixture(); t.after(() => db.close());
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
    requests.push(String(url));
    assert.equal(String(url), "http://127.0.0.1:8765/gliner2");
    return Response.json({ error: "Local worker cannot load the cached model." }, { status: 503 });
  });
  const queued = await queueManualStorytellerTurn({ db, context: context(), action: "Which way is the harbor?", intent: "question", requestId: "manual-local-failure" });
  const row = await saved(db, queued.manualTurn.id);
  await submitManualStorytellerDirection({ db, id: row.id, operatorId: PLAYER, inputSha256: row.input_sha256, direction: responseFor(row) });
  const completed = await completeManualStorytellerTurn({ db, id: row.id, operatorId: PLAYER, inputSha256: row.input_sha256,
    narration: 'The guard points toward the quays. "That way," she says. Gulls wheel above the harbor.' });
  assert.equal(completed.duplicate, false);
  assert.equal(requests.length, 0);
  const turn = (await db.query<{ mechanics: Record<string, any> }>("SELECT mechanics FROM storyhold.campaign_turns")).rows[0]!;
  assert.equal(turn.mechanics.localPostcheck.status, "not_run");
  assert.equal(turn.mechanics.localPostcheck.canonInspection.status, "skipped");
  assert.equal(turn.mechanics.localPostcheck.canonInspection.reason, "ai_led_live_play");
  assert.deepEqual(turn.mechanics.localPostcheck.errors, []);
  assert.equal((await db.query("SELECT * FROM storyhold.credit_reservations")).rows.length, 0);
  assert.equal((await db.query("SELECT * FROM storyhold.ai_usage_ledger")).rows.length, 0);
  assert.equal((await db.query<{credits:number}>("SELECT credits FROM storyhold.players")).rows[0]!.credits, 500);
});

test("stale manual state is refused, retired on refresh, and can be followed by a new request", async (t) => {
  enable(t);
  const db = await fixture(); t.after(() => db.close());
  const queued = await queueManualStorytellerTurn({ db, context: context(), action: "Which way is the harbor?", intent: "question", requestId: "manual-stale-first" });
  const row = await saved(db, queued.manualTurn.id);
  await db.query("UPDATE storyhold.campaigns SET status = 'paused'");
  await assert.rejects(submitManualStorytellerDirection({ db, id: row.id, operatorId: PLAYER, inputSha256: row.input_sha256, direction: responseFor(row) }), /STATE_CHANGED/);
  const anotherContext = context(); anotherContext.campaign.status = "paused";
  await assert.rejects(queueManualStorytellerTurn({ db, context: anotherContext, action: "Look around the harbor.", intent: "action", requestId: "manual-stale-second" }), /STATE_CHANGED/);
  assert.equal((await saved(db, row.id)).status, "stale");
  assert.equal((await db.query<{status:string}>("SELECT status FROM storyhold.campaign_turn_requests WHERE id = $1", [row.turn_request_id])).rows[0]!.status, "failed");
  await db.query("UPDATE storyhold.campaigns SET status = 'active'");
  const fresh = await queueManualStorytellerTurn({ db, context: context(), action: "Look around the harbor.", intent: "action", requestId: "manual-stale-second" });
  assert.equal(fresh.manualTurn.status, "awaiting_direction");
  await assert.rejects(submitManualStorytellerDirection({ db, id: fresh.manualTurn.id, operatorId: PLAYER, inputSha256: "bad", direction: responseFor(row) }), /INPUT_CHANGED/);
});

test("manual mode blocks premium auxiliary handlers before they can run", async (t) => {
  enable(t);
  const posts: Array<{ path: unknown; handlers: any[] }> = [];
  const app = { get() {}, put() {}, patch() {}, post(path: unknown, ...handlers: any[]) { posts.push({ path, handlers }); } };
  registerCampaignPlayRoutes({ app: app as any, db: {} as any, requireUser: ((_req:any,_res:any,next:any) => next()) as any });
  const guard = posts.find((route) => Array.isArray(route.path))!;
  assert.equal((guard.path as string[]).length, 3);
  let status = 0; let forwarded = false;
  const res = { status(value:number) { status = value; return this; }, json() {} };
  guard.handlers[1]({ localUser: { id: PLAYER, role: "owner" } }, res, () => { forwarded = true; });
  assert.equal(status, 409); assert.equal(forwarded, false);
});

test("operator endpoint retains a rejected response and accepts a corrected retry", async (t) => {
  enable(t);
  const db = await fixture(); t.after(() => db.close());
  const queued = await queueManualStorytellerTurn({ db, context: context(), action: "Which way is the harbor?", intent: "question", requestId: "manual-audit-first" });
  const row = await saved(db, queued.manualTurn.id);
  const posts: Array<{ path: unknown; handlers: any[] }> = [];
  const app = { get() {}, put() {}, patch() {}, post(path: unknown, ...handlers: any[]) { posts.push({ path, handlers }); } };
  registerCampaignPlayRoutes({ app: app as any, db, requireUser: ((_req:any,_res:any,next:any) => next()) as any });
  const route = posts.find((entry) => entry.path === "/api/storyhold/admin/manual-storyteller/:manualId/direction")!;
  let status = 200; let body: any;
  const res = { status(value:number) { status = value; return this; }, json(value:any) { body = value; } };
  const request = { params: { manualId: row.id }, localUser: { id: PLAYER, role: "owner" },
    body: { inputSha256: row.input_sha256, direction: { ...responseFor(row), outcome: "success" }, notes: "Intentionally wrong outcome." } };
  await route.handlers.at(-1)(request, res);
  assert.equal(status, 422);
  assert.equal(body.entry.attempts.length, 1);
  assert.equal(body.entry.attempts[0].accepted, false);
  assert.equal(body.entry.attempts[0].response.outcome, "success");
  assert.equal(body.entry.status, "awaiting_direction");
  request.body.direction = responseFor(row); status = 200;
  await route.handlers.at(-1)(request, res);
  assert.equal(status, 200);
  assert.equal(body.entry.attempts.length, 2);
  assert.equal(body.entry.attempts[1].accepted, true);
  assert.equal(body.entry.error, "");
  assert.equal(body.entry.status, "awaiting_narration");
  let authorized = false;
  route.handlers[1]({ localUser: { id: PLAYER, role: "player" } }, res, () => { authorized = true; });
  assert.equal(status, 403); assert.equal(authorized, false);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import {
  activeAdventureSetups,
  loadAdventureSetup,
  privateAdventureSetupContext,
  publicAdventureSetup,
  requiresAdventureSetup,
  type AdventureSetupRow,
} from "./adventureSetupAccess";
import { prepareAdventureSetup, registerAdventureSetupRoutes, setupContextFromCampaign, validateSetupResponse } from "./adventureSetupRuntime";
import { validateAdventureSetupPlan, type AdventureSetupContext, type AdventureSetupPlan } from "./adventureSetup";
import { manualStorytellerSha256 } from "./manualStoryteller";

const PLAYER = "72000000-0000-4000-8000-000000000011";
const CAMPAIGN = "72000000-0000-4000-8000-000000000012";
const SETUP = "72000000-0000-4000-8000-000000000013";
const WORLD = "72000000-0000-4000-8000-000000000014";

function campaign(overrides: Record<string, unknown> = {}) {
  return { id: CAMPAIGN, world_id: WORLD, name: "Harbor Gate", world_premise: "A harbor town where travelers negotiate passage.",
    owner_player_id: PLAYER, world_creation_mode: "quickstart", status: "active", state_version: 1,
    world_time_minutes: 0, start_contract: { startingPoint: "At the harbor gate.", rpgSeed: { origin: "original" } }, ...overrides };
}

function context(): AdventureSetupContext {
  return { campaign: { id: CAMPAIGN, name: "Harbor Gate", origin: "original", premise: "A harbor town where travelers negotiate passage." },
    lockedStart: "A traveler stands at the harbor gate.", currentMinute: 0, currentTurnNumber: 0, existingSummary: "", recentTurns: [] };
}

function plan(): AdventureSetupPlan {
  return {
    publicOpening: "Rain patters against the harbor gate. Osa waits beside a posted timetable.", locationName: "Harbor Gate",
    visibleObjective: { key: "passage", title: "Find passage across the harbor", description: "Learn which vessels can carry you to the other shore.", target: 3 },
    worldFoundation: { settingBaseline: "The harbor is ordinary trade territory shaped by tides, fares, and competing travel routes.", identitySecrecy: { status: "limited", truth: "The traveler has a disputed past that is not common knowledge at the harbor.", knownBy: ["the traveler"], exposureStakes: "Exposure may change who will negotiate, trust, or seek leverage." }, broaderForces: [{ key: "ferry_guild", name: "Ferry Guild", summary: "A local guild regulates the scheduled crossings.", relationshipToCampaign: "Its rules can matter if the traveler seeks passage, but it need not arrive at the gate now." }, { key: "coastal_trade", name: "Coastal Trade", summary: "Independent crews and merchants operate beyond the guild schedule.", relationshipToCampaign: "It offers a later alternative route without deciding which route the traveler chooses." }], unresolvedBackground: [{ key: "missing_ledger", question: "Why was the public fare list altered?", currentTruth: "A private exemption exists, but its terms remain unknown to the player.", discoveryBoundary: "A ticket, clerk, or actual records must provide evidence before the terms are known." }, { key: "tide_error", question: "Why does the tide reading differ from the timetable?", currentTruth: "A routine calculation error may have affected the posted schedule.", discoveryBoundary: "The traveler must inspect the reading or consult someone with access before treating it as fact." }] },
    cast: [
      { key: "osa", name: "Osa", role: "Ferry attendant", presence: "present", publicSummary: "Osa keeps a timetable beside the gate.", privateMotivation: "Osa secretly wants to repay a disputed family debt." },
      { key: "fen", name: "Fen", role: "Tide observer", presence: "unmet", publicSummary: "Fen carries a brass measuring rod.", privateMotivation: "Fen privately intends to conceal an erroneous tide calculation." },
    ],
    secrets: [{ key: "ledger", truth: "The guild quietly purchased an exemption recorded in a blue ledger.", clues: ["One ticket carries a blue wax mark.", "A page is missing from the public fare list."], discoverableVia: ["Compare a ticket with the posted fares."] }],
    pressures: [
      { key: "tide", title: "The changing tide", privateSummary: "The falling tide threatens the narrow quay unless someone moves the boat.", observableConsequence: "Dark mud appears beside the quay.", clueOpportunities: ["An exposed mooring mark offers a tide reading."], maturesAfterMinutes: 15, objectiveKey: "passage" },
      { key: "fare", title: "A changing fare board", privateSummary: "The clerk is planning a revised fare schedule and could be persuaded to delay it.", observableConsequence: "A clerk carries a fresh chalkboard toward the gate.", clueOpportunities: ["The old board can be compared with a ticket."], maturesAfterMinutes: 30, objectiveKey: "compare" },
    ],
    privateDirection: { premise: "Offer several ways across the harbor without deciding which the traveler chooses.",
      goalSteps: [
        { key: "compare", title: "Compare passage options", condition: "If the traveler examines the timetable.", possibleNextStep: "The traveler might negotiate or seek another quay." },
        { key: "arrange", title: "Choose an arrangement", condition: "If a suitable route has been identified.", possibleNextStep: "The traveler may pay, exchange help, or decline." },
      ], alternatePaths: ["A direct negotiation may obtain passage without exploring the ledger.", "The traveler may walk along the shore and leave the ferry behind."] },
  };
}

function setup(status = "awaiting_response"): AdventureSetupRow {
  const frozen = { context: context(), request: { system: "PRIVATE_FROZEN_PROMPT", messages: [] } };
  const acceptedPlan = validateAdventureSetupPlan(plan(), context());
  return { id: SETUP, campaign_id: CAMPAIGN, player_id: PLAYER, campaign_name: "Harbor Gate", status, expected_state_version: 1,
    frozen_input: frozen, input_sha256: manualStorytellerSha256(frozen), request: { mode: "manual", attempt: 0 },
    plan: acceptedPlan, plan_sha256: manualStorytellerSha256(acceptedPlan), applied_state_version: 2,
    last_error: "PRIVATE_VALIDATION_DETAILS", notes: "PRIVATE_REVIEW_NOTES", created_at: "2026-09-05T00:00:00Z", updated_at: "2026-09-05T00:00:00Z" };
}

/** A read-only SQL spy: any credit mutation, generation journal, or unexpected query fails. */
function readDb(options: { campaign?: Record<string, unknown> | null; setup?: AdventureSetupRow | null } = {}) {
  const queries: string[] = [];
  let transactions = 0;
  const db = {
    async query(sql: string) {
      queries.push(sql);
      assert.match(sql.trim(), /^SELECT\b/i, "The lightweight runtime fixture must not write or buy inference.");
      if (sql.includes("FROM storyhold.campaigns")) return { rows: options.campaign === null ? [] : [options.campaign ?? campaign()] };
      if (sql.includes("FROM storyhold.campaign_adventure_setups")) return { rows: options.setup ? [options.setup] : [] };
      throw new Error(`Unexpected query in read-only setup test: ${sql}`);
    },
    async exec() { throw new Error("No direct SQL execution is permitted in the setup runtime fixture."); },
    async transaction<T>(run: (tx: any) => Promise<T>) { transactions += 1; return run(db); },
  };
  return { db: db as any, queries, transactionCount: () => transactions };
}

type Route = { method: "GET" | "POST"; path: string | string[]; handlers: any[] };
function captureRoutes(db: any) {
  const routes: Route[] = [];
  const requireUser = (req: any, res: any, next: () => void) => {
    if (!req.localUser) { res.status(401).json({ error: "Sign in." }); return; }
    next();
  };
  const app = {
    get(path: string | string[], ...handlers: any[]) { routes.push({ method: "GET", path, handlers }); },
    post(path: string | string[], ...handlers: any[]) { routes.push({ method: "POST", path, handlers }); },
  };
  registerAdventureSetupRoutes({ app: app as any, db, requireUser });
  return routes;
}

async function dispatch(route: Route, request: any) {
  let status = 200;
  let body: any;
  let forwarded = false;
  const res = { status(value: number) { status = value; return this; }, json(value: unknown) { body = value; return this; } };
  for (const handler of route.handlers) {
    let nextCalled = false;
    await handler(request, res, () => { nextCalled = true; });
    if (!nextCalled) return { status, body, forwarded };
  }
  forwarded = true;
  return { status, body, forwarded };
}

function enableManualWithoutNetwork(t: TestContext) {
  const keys = ["NODE_ENV", "STORYHOLD_MANUAL_STORYTELLER", "REPLIT_DEPLOYMENT"];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.NODE_ENV = "test";
  process.env.STORYHOLD_MANUAL_STORYTELLER = "true";
  delete process.env.REPLIT_DEPLOYMENT;
  t.after(() => { for (const key of keys) {
    if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
  } });
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("No network or paid AI is permitted in setup runtime tests."); });
  return network;
}

test("public setup projection exposes only progress and the approved opening, never private plans", () => {
  const row = setup("ready");
  assert.deepEqual(publicAdventureSetup(campaign(), row), { required: true, status: "ready", opening: plan().publicOpening });
  const serialized = JSON.stringify(publicAdventureSetup(campaign(), row));
  for (const privateText of ["privateMotivation", "secrets", "pressures", "goalSteps", "PRIVATE_FROZEN_PROMPT", "PRIVATE_VALIDATION_DETAILS", "PRIVATE_REVIEW_NOTES", "unmet", "input_sha256", "plan_sha256"]) {
    assert.ok(!serialized.includes(privateText), `Player projection must not expose ${privateText}`);
  }
  for (const status of ["awaiting_response", "failed"]) {
    assert.equal(publicAdventureSetup(campaign(), { ...row, status }).opening, null);
  }
  assert.deepEqual(publicAdventureSetup(campaign(), null), { required: true, status: "required", opening: null });
});

test("private Director context contains the foundation only after acceptance and subordinates it to committed reality", () => {
  for (const status of ["awaiting_response", "generating", "failed"]) assert.equal(privateAdventureSetupContext(setup(status)), null);
  assert.equal(privateAdventureSetupContext(null), null);
  const row = setup("ready");
  const privateContext = privateAdventureSetupContext(row)!;
  assert.deepEqual(privateContext.plan, row.plan);
  assert.equal(privateContext.establishedAtStateVersion, 2);
  assert.match(privateContext.boundary, /not player knowledge/);
  assert.match(privateContext.boundary, /supersede initial intentions/);
  assert.match(privateContext.boundary, /never destined events/);
});

test("original quickstarts require setup, imported and other world launches do not", async () => {
  assert.equal(requiresAdventureSetup(campaign()), true);
  for (const excluded of [
    campaign({ world_creation_mode: "import" }),
    campaign({ world_creation_mode: "manual" }),
    campaign({ start_contract: { rpgSeed: { origin: "imported" } } }),
  ]) {
    assert.equal(requiresAdventureSetup(excluded), false);
    const fixture = readDb({ campaign: excluded, setup: setup("ready") });
    assert.equal(await loadAdventureSetup(fixture.db, excluded), null);
    assert.equal(fixture.queries.length, 0);
    assert.deepEqual(publicAdventureSetup(excluded, setup("ready")), { required: false, status: "not_required", opening: null });
  }
});

test("read-only loading verifies accepted plan integrity and reports interrupted generation as retryable", async () => {
  const row = setup("ready");
  const fixture = readDb({ setup: row });
  assert.deepEqual(await loadAdventureSetup(fixture.db, campaign()), row);
  const changed = readDb({ setup: { ...row, plan: { ...plan(), locationName: "Changed Harbor" } } });
  await assert.rejects(loadAdventureSetup(changed.db, campaign()), /ADVENTURE_SETUP_PLAN_CHANGED/);
  const generating = setup("generating");
  assert.equal(publicAdventureSetup(campaign(), generating).status, "failed");
  activeAdventureSetups.add(CAMPAIGN);
  try { assert.equal(publicAdventureSetup(campaign(), generating).status, "generating"); }
  finally { activeAdventureSetups.delete(CAMPAIGN); }
  assert.equal(fixture.transactionCount(), 0);
});

test("server guards block turns and proposals until setup is ready, before downstream queue work", async () => {
  for (const status of [null, "awaiting_response", "generating", "failed"] as const) {
    const fixture = readDb({ setup: status ? setup(status) : null });
    const guard = captureRoutes(fixture.db).find(route => Array.isArray(route.path))!;
    assert.deepEqual(guard.path, ["/api/storyhold/campaigns/:campaignId/turns", "/api/storyhold/campaigns/:campaignId/proposals"]);
    const result = await dispatch(guard, { params: { campaignId: CAMPAIGN }, localUser: { id: PLAYER, role: "owner" } });
    assert.equal(result.status, 409);
    assert.equal(result.forwarded, false);
    assert.equal(result.body.adventureSetup.required, true);
    assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_|privateMotivation|plan_sha256/);
    assert.equal(fixture.transactionCount(), 0);
  }
  for (const options of [{ setup: setup("ready") }, { campaign: campaign({ world_creation_mode: "import" }) }]) {
    const fixture = readDb(options);
    const guard = captureRoutes(fixture.db).find(route => Array.isArray(route.path))!;
    assert.equal((await dispatch(guard, { params: { campaignId: CAMPAIGN }, localUser: { id: PLAYER, role: "owner" } })).forwarded, true);
  }
});

test("authentication, campaign access, and owner checks reject before querying a setup or dispatching AI", async (t) => {
  const network = enableManualWithoutNetwork(t);
  const unauthorized = readDb();
  const guard = captureRoutes(unauthorized.db).find(route => Array.isArray(route.path))!;
  assert.equal((await dispatch(guard, { params: { campaignId: CAMPAIGN } })).status, 401);
  assert.equal(unauthorized.queries.length, 0);
  assert.equal((await dispatch(guard, { params: { campaignId: "invalid" }, localUser: { id: PLAYER, role: "owner" } })).status, 400);
  assert.equal(unauthorized.queries.length, 0);
  const inaccessible = readDb({ campaign: null });
  const inaccessibleGuard = captureRoutes(inaccessible.db).find(route => Array.isArray(route.path))!;
  assert.equal((await dispatch(inaccessibleGuard, { params: { campaignId: CAMPAIGN }, localUser: { id: PLAYER, role: "owner" } })).status, 404);
  assert.equal(inaccessible.queries.length, 1);
  await assert.rejects(prepareAdventureSetup({ db: inaccessible.db, campaignId: CAMPAIGN, playerId: PLAYER, role: "owner" }), /NOT_FOUND/);
  const member = readDb({ campaign: campaign({ owner_player_id: "another-player" }) });
  await assert.rejects(prepareAdventureSetup({ db: member.db, campaignId: CAMPAIGN, playerId: PLAYER, role: "owner" }), /OWNER_REQUIRED/);
  assert.equal(member.queries.length, 1);
  assert.equal(network.mock.callCount(), 0);
});

test("a frozen manual setup retries the same input without a provider, credit reservation, or mutation", async (t) => {
  const network = enableManualWithoutNetwork(t);
  const row = setup();
  const before = structuredClone(row);
  const fixture = readDb({ setup: row });
  const first = await prepareAdventureSetup({ db: fixture.db, campaignId: CAMPAIGN, playerId: PLAYER, role: "owner" });
  const second = await prepareAdventureSetup({ db: fixture.db, campaignId: CAMPAIGN, playerId: PLAYER, role: "owner" });
  assert.deepEqual(first, { adventureSetup: { required: true, status: "awaiting_response", opening: null }, creditsUsed: 0 });
  assert.deepEqual(second, first);
  assert.deepEqual(row, before);
  assert.equal(fixture.transactionCount(), 0);
  assert.equal(network.mock.callCount(), 0);
  assert.equal(activeAdventureSetups.has(CAMPAIGN), false);
  assert.doesNotMatch(fixture.queries.join("\n"), /credit_|metered_ai|^\s*(?:INSERT|UPDATE)\b/im);
});

test("private setup GETs require an operator and are read-only, including repeated progress review", async (t) => {
  const network = enableManualWithoutNetwork(t);
  const row = setup();
  const fixture = readDb({ setup: row });
  const routes = captureRoutes(fixture.db);
  const list = routes.find(route => route.method === "GET" && route.path === "/api/storyhold/admin/adventure-setups")!;
  const detail = routes.find(route => route.method === "GET" && route.path === "/api/storyhold/admin/adventure-setups/:id")!;
  assert.equal((await dispatch(list, { localUser: { id: PLAYER, role: "player" } })).status, 403);
  assert.equal(fixture.queries.length, 0);
  const summaries = await dispatch(list, { localUser: { id: PLAYER, role: "owner" } });
  assert.equal(summaries.body.enabled, true);
  assert.equal(summaries.body.entries.length, 1);
  assert.equal(summaries.body.entries[0].request, undefined);
  assert.equal(summaries.body.entries[0].plan, undefined);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await dispatch(detail, { params: { id: SETUP }, localUser: { id: PLAYER, role: "owner" } });
    assert.equal(result.body.entry.inputSha256, row.input_sha256);
    assert.deepEqual(result.body.entry.request, (row.frozen_input as any).request);
  }
  assert.equal(fixture.transactionCount(), 0);
  assert.equal(network.mock.callCount(), 0);
});

test("manual completion replay validates the accepted plan and returns once without paid AI or extra state writes", async (t) => {
  const network = enableManualWithoutNetwork(t);
  const row = setup("ready");
  const fixture = readDb({ setup: row });
  const complete = captureRoutes(fixture.db).find(route => route.path === "/api/storyhold/admin/adventure-setups/:id/complete")!;
  const request = { params: { id: SETUP }, localUser: { id: PLAYER, role: "owner" }, body: { inputSha256: row.input_sha256, plan: row.plan, notes: "Checked the opening." } };
  const first = await dispatch(complete, request);
  assert.equal(first.status, 200);
  assert.equal(first.body.duplicate, true);
  assert.equal(first.body.entry.status, "ready");
  assert.equal(fixture.transactionCount(), 1);
  assert.equal(network.mock.callCount(), 0);
  assert.doesNotMatch(fixture.queries.join("\n"), /credit_|metered_ai|^\s*(?:INSERT|UPDATE)\b/im);
  assert.match(fixture.queries.join("\n"), /FOR UPDATE/);
});

test("play GET only projects setup and the guard is registered before turn handlers", () => {
  const play = readFileSync(new URL("./campaignPlay.ts", import.meta.url), "utf8");
  const studio = readFileSync(new URL("./worldStudio.ts", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("./adventureSetupRuntime.ts", import.meta.url), "utf8");
  const start = play.indexOf('    "/api/storyhold/campaigns/:campaignId/play",');
  const end = play.indexOf("\n  app.", start);
  assert.ok(start >= 0 && end > start);
  const getPlay = play.slice(start, end);
  assert.match(getPlay, /adventureSetup:\s*publicAdventureSetup\(context.campaign, context.adventureSetup\)/);
  assert.doesNotMatch(getPlay, /prepareAdventureSetup\(|generateAiText\(|reserveCredits\(|applyAdventureSetupPlanInTransaction\(/);
  assert.doesNotMatch(getPlay, /privateAdventureSetupContext\(|adventureSetup\.plan/);
  assert.ok(studio.indexOf("  registerAdventureSetupRoutes({ app, db, requireUser });") < studio.indexOf("  registerCampaignPlayRoutes({ app, db, requireUser });"));
  const complete = runtime.slice(runtime.indexOf('  app.post("/api/storyhold/admin/adventure-setups/:id/complete"'));
  assert.match(complete, /applyAdventureSetupPlanInTransaction/);
  assert.doesNotMatch(complete, /generateAiText\(|reserveCredits\(|runOrResumeMeteredAiResult\(/);
});

test("setup snapshots distinguish an untouched beginning from real saved history", () => {
  const untouched = { campaign: campaign(), turns: [], facts: [], stateSummaries: [], rpgSnapshot: { state: { objectives: [], location: null } } };
  const initial = setupContextFromCampaign(untouched as any);
  assert.equal(initial.currentTurnNumber, 0);
  assert.doesNotThrow(() => validateAdventureSetupPlan(plan(), initial), "A new campaign must still permit a public opening.");
  const established = setupContextFromCampaign({ ...untouched,
    campaign: campaign({ world_time_minutes: 12, latest_scene_summary: "You asked the attendant about a ferry." }),
    turns: [{ turn_number: 1, player_action: "Ask about the ferry.", narration: "The attendant points toward a schedule." }],
  } as any);
  assert.equal(established.currentTurnNumber, 1);
  assert.equal(established.currentMinute, 12);
  assert.match(established.existingSummary, /asked the attendant/);
  assert.throws(() => validateAdventureSetupPlan(plan(), established), /existing campaign/);
  assert.doesNotThrow(() => validateAdventureSetupPlan({ ...plan(), publicOpening: "" }, established));
});

test("provider setup validation preserves the established goal title and non-placeholder location before acceptance", () => {
  const locked = {
    currentLocation: { entityId: "harbor-gate", name: "Harbor Gate" },
    trackedObjectives: [{ title: plan().visibleObjective.title, status: "active", progress: 2, target: 3 }],
  };
  const frozen = { ...context(), lockedStart: JSON.stringify(locked) };
  assert.deepEqual(validateSetupResponse(JSON.stringify(plan()), frozen), plan());
  assert.throws(() => validateSetupResponse(JSON.stringify({ ...plan(), locationName: "Northern Quay" }), frozen), /LOCATION_CONFLICT/);
  assert.throws(() => validateSetupResponse(JSON.stringify({ ...plan(), visibleObjective: { ...plan().visibleObjective, title: "Find a new job" } }), frozen), /OBJECTIVE_CONFLICT/);
  assert.doesNotThrow(() => validateSetupResponse(JSON.stringify({ ...plan(), locationName: "  HARBOR   GATE  " }), frozen));
  const placeholder = { ...context(), lockedStart: JSON.stringify({ currentLocation: { entityId: null, name: "Opening Scene" }, trackedObjectives: [] }) };
  assert.doesNotThrow(() => validateSetupResponse(JSON.stringify(plan()), placeholder));
  const namedPlaceholder = { ...context(), lockedStart: JSON.stringify({ currentLocation: { entityId: "real-location", name: "Opening Scene" }, trackedObjectives: [] }) };
  assert.throws(() => validateSetupResponse(JSON.stringify(plan()), namedPlaceholder), /LOCATION_CONFLICT/);
  assert.equal(JSON.parse(frozen.lockedStart).trackedObjectives[0].progress, 2);
});

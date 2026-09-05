import { createHash, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import {
  validateAdventureSetupPlan,
  type AdventureSetupContext,
  type AdventureSetupPlan,
} from "./adventureSetup";
import {
  commitCampaignRpgStateDeltaInTransaction,
  loadCampaignRpgSnapshot,
} from "./campaignRpgPersistence";
import { manualStorytellerSha256 } from "./manualStoryteller";

export const adventureSetupSchemaSql = String.raw`
  CREATE TABLE IF NOT EXISTS storyhold.campaign_adventure_setups (
    id uuid PRIMARY KEY,
    campaign_id uuid NOT NULL UNIQUE REFERENCES storyhold.campaigns(id) ON DELETE CASCADE,
    player_id uuid NOT NULL REFERENCES storyhold.players(id) ON DELETE CASCADE,
    expected_state_version bigint NOT NULL CHECK (expected_state_version >= 0),
    input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
    frozen_input jsonb NOT NULL,
    request jsonb NOT NULL,
    plan jsonb,
    plan_sha256 text CHECK (plan_sha256 IS NULL OR plan_sha256 ~ '^[0-9a-f]{64}$'),
    status text NOT NULL DEFAULT 'awaiting_response'
      CHECK (status IN ('awaiting_response', 'generating', 'ready', 'failed')),
    notes text NOT NULL DEFAULT '',
    last_error text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    applied_state_version bigint CHECK (applied_state_version > expected_state_version),
    CHECK (status <> 'ready' OR (plan IS NOT NULL AND plan_sha256 IS NOT NULL AND applied_state_version IS NOT NULL))
  );
`;

type SetupDb = Pick<PGlite, "query">;
type Row = Record<string, unknown>;

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function fail(code: string): never {
  // Codes deliberately contain no private model prose.
  throw new Error(`ADVENTURE_SETUP_${code}`);
}

function integer(value: unknown): number {
  const result = Number(value);
  if (value === null || value === undefined || !Number.isSafeInteger(result) || result < 0) {
    fail("STATE_INVALID");
  }
  return result;
}

function sameName(left: string, right: string): boolean {
  const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
  return normalize(left) === normalize(right);
}

/** Keep the exact campaignPlay stateKey convention for future consolidation. */
function stateKey(subject: string): string {
  const lower = subject.toLocaleLowerCase();
  const readable = lower.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 72) || "state";
  return `${readable}-${createHash("sha256").update(lower).digest("hex").slice(0, 12)}`;
}

/**
 * The caller MUST own a transaction encompassing this operation and any paid
 * settlement. This function never opens a transaction, calls a provider, spends
 * credits, advances time, or edits a saved turn or immutable launch contract.
 */
export async function applyAdventureSetupPlanInTransaction(params: {
  db: SetupDb;
  setupId: string;
  plan: AdventureSetupPlan;
  inputSha256: string;
  notes?: string;
}): Promise<{ duplicate: boolean; stateVersion: number }> {
  const { db } = params;
  // Read only the routing ID before locking. All authoritative data is re-read
  // after the campaign lock, matching the established player-turn lock order.
  const routing = (await db.query<{ campaign_id: string }>(
    "SELECT campaign_id FROM storyhold.campaign_adventure_setups WHERE id = $1",
    [params.setupId],
  )).rows[0];
  if (!routing) fail("NOT_FOUND");
  const campaign = (await db.query<Row>(
    "SELECT * FROM storyhold.campaigns WHERE id = $1 FOR UPDATE",
    [routing.campaign_id],
  )).rows[0];
  if (!campaign) fail("NOT_FOUND");
  const setup = (await db.query<Row>(
    "SELECT * FROM storyhold.campaign_adventure_setups WHERE id = $1 AND campaign_id = $2 FOR UPDATE",
    [params.setupId, routing.campaign_id],
  )).rows[0];
  if (!setup) fail("NOT_FOUND");
  if (params.inputSha256 !== setup.input_sha256 ||
      manualStorytellerSha256(setup.frozen_input) !== setup.input_sha256) {
    fail("INPUT_CHANGED");
  }
  const frozenInput = record(setup.frozen_input);
  const context = frozenInput.context as AdventureSetupContext;
  if (!context || record(context.campaign).id !== campaign.id) fail("INPUT_CHANGED");
  const plan = validateAdventureSetupPlan(params.plan, context);
  const planSha256 = manualStorytellerSha256(plan);
  if (setup.status === "ready") {
    if (setup.plan_sha256 !== planSha256 || manualStorytellerSha256(setup.plan) !== planSha256 ||
        setup.applied_state_version === null) fail("PLAN_CONFLICT");
    // Return the original acceptance version, even if ordinary play advanced.
    return { duplicate: true, stateVersion: integer(setup.applied_state_version) };
  }
  if (setup.status !== "awaiting_response" && setup.status !== "generating") fail("NOT_PENDING");
  const expectedVersion = integer(setup.expected_state_version);
  const currentMinute = integer(campaign.world_time_minutes);
  if (campaign.status !== "active" || integer(campaign.state_version) !== expectedVersion ||
      currentMinute !== context.currentMinute) fail("STATE_CHANGED");
  const pending = await db.query(
    `SELECT id FROM storyhold.manual_storyteller_turns
      WHERE campaign_id = $1 AND status IN ('awaiting_direction', 'awaiting_narration')
     UNION ALL SELECT id FROM storyhold.campaign_turn_requests
      WHERE campaign_id = $1 AND status IN ('generating', 'generated')
     UNION ALL SELECT id FROM storyhold.campaign_turn_proposals
      WHERE campaign_id = $1 AND status = 'pending' LIMIT 1`,
    [campaign.id],
  );
  if (pending.rows.length) fail("TURN_PENDING");
  const sequence = (await db.query<{ sequence: number | string }>(
    "SELECT COALESCE(MAX(sequence_number), 0) AS sequence FROM storyhold.world_state_events WHERE campaign_id = $1",
    [campaign.id],
  )).rows[0];
  if (integer(sequence?.sequence) !== expectedVersion || expectedVersion >= Number.MAX_SAFE_INTEGER) {
    fail("STATE_CHANGED");
  }
  const nextVersion = expectedVersion + 1;
  const snapshot = await loadCampaignRpgSnapshot(db, routing.campaign_id);
  if (snapshot.seed.origin.kind !== "original") fail("ORIGIN_INVALID");
  const frozenRpg = record(frozenInput.rpgSnapshot);
  if ((frozenRpg.seedSha256 !== undefined && frozenRpg.seedSha256 !== snapshot.seedSha256) ||
      (frozenRpg.stateSha256 !== undefined && frozenRpg.stateSha256 !== snapshot.stateSha256)) {
    fail("STATE_CHANGED");
  }
  const currentLocation = snapshot.state.location;
  const genericLocation = currentLocation.entityId === null &&
    ["Opening Scene", "Starting Scene"].some((name) => sameName(name, currentLocation.name));
  if (!genericLocation && !sameName(currentLocation.name, plan.locationName)) fail("LOCATION_CONFLICT");
  const existingObjectives = snapshot.state.objectives.filter((goal) =>
    (goal.status === "active" || goal.status === "pending") && goal.title.trim());
  if (existingObjectives.length && !existingObjectives.some((goal) => goal.title === plan.visibleObjective.title)) {
    fail("OBJECTIVE_CONFLICT");
  }
  const objective = existingObjectives.find((goal) => goal.title === plan.visibleObjective.title) ?? {
    id: `setup-${params.setupId}-objective`, title: plan.visibleObjective.title,
    description: plan.visibleObjective.description, status: "active" as const,
    progress: 0, target: plan.visibleObjective.target,
  };
  const publicLocation = genericLocation ? { ...currentLocation, name: plan.locationName } : currentLocation;
  await commitCampaignRpgStateDeltaInTransaction({
    db, campaignId: routing.campaign_id, requestId: `adventure-setup:${params.setupId}`,
    delta: {
      expectedStateVersion: snapshot.state.stateVersion,
      reason: "Initialize the campaign adventure setup.",
      // Keeping the already-established location unchanged is also a valid
      // projection event when the opening objective was supplied at launch.
      location: publicLocation,
      ...(existingObjectives.length ? {} : { objectiveChanges: [{ kind: "add" as const, objective }] }),
    },
  });
  const summaryRows = (await db.query<{ display_name: string; canonical_key: string }>(
    "SELECT display_name, canonical_key FROM storyhold.campaign_state_summaries WHERE campaign_id = $1 AND entity_type = 'character'",
    [campaign.id],
  )).rows;
  const knownNames = [
    ...summaryRows.map((row) => row.display_name),
    ...snapshot.state.characters.map((character) => character.name),
    ...snapshot.state.companions.map((companion) => companion.name),
  ];
  for (const npc of plan.cast) {
    if (npc.presence !== "present" || npc.existingSubject || knownNames.some((name) => sameName(name, npc.name))) continue;
    const canonicalKey = stateKey(npc.name);
    if (summaryRows.some((row) => row.canonical_key === canonicalKey)) continue;
    await db.query(
      `INSERT INTO storyhold.campaign_state_summaries
        (id, world_id, canon_edition_id, campaign_id, entity_type, canonical_key,
         display_name, summary, facts, related_entities, history, source_memory_ids, state_version, visibility)
       VALUES ($1, $2, $3, $4, 'character', $5, $6, $7, '[]'::jsonb, '[]'::jsonb,
               $8::jsonb, '[]'::jsonb, $9, 'campaign')
       ON CONFLICT (campaign_id, entity_type, canonical_key) DO NOTHING`,
      [randomUUID(), campaign.world_id, campaign.canon_edition_id, campaign.id,
        canonicalKey, npc.name, npc.publicSummary,
        JSON.stringify([{ stateVersion: nextVersion, summary: npc.publicSummary, facts: [] }]), nextVersion],
    );
    knownNames.push(npc.name);
  }
  const order = (await db.query<{ chronology_order: number | string }>(
    "SELECT COALESCE(MAX(chronology_order), 0) AS chronology_order FROM storyhold.world_clock_events WHERE campaign_id = $1",
    [campaign.id],
  )).rows[0];
  let chronologyOrder = integer(order?.chronology_order);
  for (const pressure of plan.pressures) {
    const dueMinute = currentMinute + pressure.maturesAfterMinutes;
    chronologyOrder += 1;
    if (!Number.isSafeInteger(dueMinute) || !Number.isSafeInteger(chronologyOrder)) fail("STATE_INVALID");
    await db.query(
      `INSERT INTO storyhold.world_clock_events
        (id, world_id, canon_edition_id, campaign_id, canonical_key, event_kind,
         title, summary, world_time_label, chronology_order, visibility, knowledge_status,
         known_effects, internal_effects, scheduled_for_label, reveal_rule, status,
         due_world_time_minutes, trigger_definition, causal_basis, clue_opportunities, created_state_version)
       VALUES ($1, $2, $3, $4, $5, 'scheduled_effect', $6, $7, $8, $9, 'system', 'secret',
               $10::jsonb, $11::jsonb, '', $12::jsonb, 'scheduled', $13, '{"kind":"none"}'::jsonb,
               $14::jsonb, $15::jsonb, $16)`,
      [randomUUID(), campaign.world_id, campaign.canon_edition_id, campaign.id,
        `setup-${params.setupId}-${pressure.key}`, pressure.title, pressure.privateSummary,
        String(campaign.current_time_label ?? ""), chronologyOrder,
        JSON.stringify([pressure.observableConsequence]), JSON.stringify([pressure.privateSummary]),
        JSON.stringify({ when: "Only reveal through a supported observation or earned discovery; maturity alone does not reveal private facts." }),
        dueMinute, JSON.stringify([
          `Adventure setup ${params.setupId}: ${pressure.key}`,
          ...(pressure.objectiveKey ? [`Contingent objective reference: ${pressure.objectiveKey}`] : []),
        ]), JSON.stringify(pressure.clueOpportunities), nextVersion],
    );
  }
  // Whitelist this payload: the append-only event stream is player-visible.
  await db.query(
    `INSERT INTO storyhold.world_state_events
      (id, campaign_id, sequence_number, event_type, payload, caused_by_player_id)
     VALUES ($1, $2, $3, 'adventure_initialized', $4::jsonb, $5)`,
    [randomUUID(), campaign.id, nextVersion, JSON.stringify({
      setupId: params.setupId,
      summary: "Adventure setup initialized.",
      goal: { id: objective.id, title: objective.title, description: objective.description, target: objective.target },
      opening: plan.publicOpening,
    }), setup.player_id],
  );
  const updatedCampaign = await db.query(
    "UPDATE storyhold.campaigns SET state_version = $3 WHERE id = $1 AND state_version = $2 RETURNING id",
    [campaign.id, expectedVersion, nextVersion],
  );
  if (updatedCampaign.rows.length !== 1) fail("STATE_CHANGED");
  const updatedSetup = await db.query(
    `UPDATE storyhold.campaign_adventure_setups
        SET plan = $2::jsonb, plan_sha256 = $3, status = 'ready', applied_state_version = $4,
            notes = $5, last_error = '', updated_at = now()
      WHERE id = $1 AND status IN ('awaiting_response', 'generating') RETURNING id`,
    [params.setupId, JSON.stringify(plan), planSha256, nextVersion, params.notes ?? ""],
  );
  if (updatedSetup.rows.length !== 1) fail("NOT_PENDING");
  return { duplicate: false, stateVersion: nextVersion };
}

/**
 * A correction is deliberately narrower than initial application. It is for an
 * operator-reviewed foundation that has not yet influenced a later player turn:
 * public setup output remains fixed, old private timers are replaced, and an
 * append-only correction marker records the change. It never rewrites turns,
 * character state, objectives, location, or the immutable RPG seed.
 */
export async function refineAdventureSetupPlanInTransaction(params: {
  db: SetupDb;
  setupId: string;
  inputSha256: string;
  expectedPlanSha256: string;
  plan: AdventureSetupPlan;
  notes?: string;
}): Promise<{ stateVersion: number }> {
  const routing = (await params.db.query<{ campaign_id: string }>(
    "SELECT campaign_id FROM storyhold.campaign_adventure_setups WHERE id = $1", [params.setupId],
  )).rows[0];
  if (!routing) fail("NOT_FOUND");
  const campaign = (await params.db.query<Row>(
    "SELECT * FROM storyhold.campaigns WHERE id = $1 FOR UPDATE", [routing.campaign_id],
  )).rows[0];
  const setup = (await params.db.query<Row>(
    "SELECT * FROM storyhold.campaign_adventure_setups WHERE id = $1 AND campaign_id = $2 FOR UPDATE",
    [params.setupId, routing.campaign_id],
  )).rows[0];
  if (!campaign || !setup) fail("NOT_FOUND");
  if (setup.status !== "ready" || setup.applied_state_version === null ||
      params.inputSha256 !== setup.input_sha256 ||
      manualStorytellerSha256(setup.frozen_input) !== setup.input_sha256 ||
      params.expectedPlanSha256 !== setup.plan_sha256 ||
      manualStorytellerSha256(setup.plan) !== setup.plan_sha256) fail("PLAN_CONFLICT");
  const appliedVersion = integer(setup.applied_state_version);
  if (campaign.status !== "active" || integer(campaign.state_version) !== appliedVersion) {
    fail("POST_SETUP_STATE_EXISTS");
  }
  const frozen = record(setup.frozen_input);
  const context = frozen.context as AdventureSetupContext;
  if (!context || record(context.campaign).id !== campaign.id) fail("INPUT_CHANGED");
  const next = validateAdventureSetupPlan(params.plan, context);
  const prior = validateAdventureSetupPlan(setup.plan, context);
  const same = (left: string, right: string) => sameName(left, right);
  if (next.publicOpening !== prior.publicOpening || !same(next.locationName, prior.locationName) ||
      next.visibleObjective.key !== prior.visibleObjective.key ||
      next.visibleObjective.title !== prior.visibleObjective.title ||
      next.visibleObjective.description !== prior.visibleObjective.description ||
      next.visibleObjective.target !== prior.visibleObjective.target) fail("PUBLIC_STATE_CHANGED");
  for (const oldNpc of prior.cast.filter((npc) => npc.presence === "present")) {
    const replacement = next.cast.find((npc) => npc.name === oldNpc.name);
    if (!replacement || replacement.presence !== "present" || replacement.publicSummary !== oldNpc.publicSummary ||
        replacement.existingSubject !== oldNpc.existingSubject) fail("PUBLIC_CAST_CHANGED");
  }
  const clocks = await params.db.query<Row>(
    `SELECT id, status, matured_at, resolved_state_version FROM storyhold.world_clock_events
       WHERE campaign_id = $1 AND canonical_key LIKE $2 FOR UPDATE`,
    [campaign.id, `setup-${params.setupId}-%`],
  );
  if (clocks.rows.length !== prior.pressures.length || clocks.rows.some((clock) =>
    clock.status !== "scheduled" || clock.matured_at !== null || clock.resolved_state_version !== null)) {
    fail("PRESSURE_ALREADY_USED");
  }
  const sequence = (await params.db.query<{ sequence: number | string }>(
    "SELECT COALESCE(MAX(sequence_number), 0) AS sequence FROM storyhold.world_state_events WHERE campaign_id = $1",
    [campaign.id],
  )).rows[0];
  if (integer(sequence?.sequence) !== appliedVersion || appliedVersion >= Number.MAX_SAFE_INTEGER) fail("STATE_CHANGED");
  const nextVersion = appliedVersion + 1;
  await params.db.query("DELETE FROM storyhold.world_clock_events WHERE id = ANY($1::uuid[])", [clocks.rows.map((clock) => clock.id)]);
  const order = (await params.db.query<{ chronology_order: number | string }>(
    "SELECT COALESCE(MAX(chronology_order), 0) AS chronology_order FROM storyhold.world_clock_events WHERE campaign_id = $1",
    [campaign.id],
  )).rows[0];
  let chronologyOrder = integer(order?.chronology_order);
  const currentMinute = integer(campaign.world_time_minutes);
  for (const pressure of next.pressures) {
    chronologyOrder += 1;
    const dueMinute = currentMinute + pressure.maturesAfterMinutes;
    await params.db.query(
      `INSERT INTO storyhold.world_clock_events
        (id, world_id, canon_edition_id, campaign_id, canonical_key, event_kind, title, summary,
         world_time_label, chronology_order, visibility, knowledge_status, known_effects, internal_effects,
         scheduled_for_label, reveal_rule, status, due_world_time_minutes, trigger_definition,
         causal_basis, clue_opportunities, created_state_version)
       VALUES ($1,$2,$3,$4,$5,'scheduled_effect',$6,$7,$8,$9,'system','secret',$10::jsonb,$11::jsonb,
         '',$12::jsonb,'scheduled',$13,'{"kind":"none"}'::jsonb,$14::jsonb,$15::jsonb,$16)`,
      [randomUUID(), campaign.world_id, campaign.canon_edition_id, campaign.id,
        `setup-${params.setupId}-${pressure.key}`, pressure.title, pressure.privateSummary,
        String(campaign.current_time_label ?? ""), chronologyOrder,
        JSON.stringify([pressure.observableConsequence]), JSON.stringify([pressure.privateSummary]),
        JSON.stringify({ when: "Only reveal through a supported observation or earned discovery; maturity alone does not reveal private facts." }),
        dueMinute, JSON.stringify([`Adventure setup ${params.setupId}: ${pressure.key}`,
          ...(pressure.objectiveKey ? [`Contingent objective reference: ${pressure.objectiveKey}`] : [])]),
        JSON.stringify(pressure.clueOpportunities), nextVersion],
    );
  }
  const planSha256 = manualStorytellerSha256(next);
  await params.db.query(
    `INSERT INTO storyhold.world_state_events (id,campaign_id,sequence_number,event_type,payload,caused_by_player_id)
      VALUES ($1,$2,$3,'adventure_foundation_refined',$4::jsonb,$5)`,
    [randomUUID(), campaign.id, nextVersion, JSON.stringify({
      setupId: params.setupId, summary: "Adventure background refined.",
    }), setup.player_id],
  );
  const changedCampaign = await params.db.query(
    "UPDATE storyhold.campaigns SET state_version = $3 WHERE id = $1 AND state_version = $2 RETURNING id",
    [campaign.id, appliedVersion, nextVersion],
  );
  if (changedCampaign.rows.length !== 1) fail("STATE_CHANGED");
  const changedSetup = await params.db.query(
    `UPDATE storyhold.campaign_adventure_setups SET plan = $2::jsonb, plan_sha256 = $3,
       applied_state_version = $4, notes = $5, updated_at = now() WHERE id = $1 AND status = 'ready' RETURNING id`,
    [params.setupId, JSON.stringify(next), planSha256, nextVersion, params.notes ?? ""],
  );
  if (changedSetup.rows.length !== 1) fail("PLAN_CONFLICT");
  return { stateVersion: nextVersion };
}

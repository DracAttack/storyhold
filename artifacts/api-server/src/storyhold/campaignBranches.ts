import { createHash, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import {
  copyCampaignRpgStateToChildInTransaction,
  loadCampaignRpgSnapshot,
} from "./campaignRpgPersistence";
import { validateAdventureSetupPlan, type AdventureSetupContext, type AdventureSetupPlan } from "./adventureSetup";
import { manualStorytellerSha256 } from "./manualStoryteller";

type BranchDb = Pick<PGlite, "query">;
type BranchRootDb = BranchDb & Pick<PGlite, "transaction">;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
}

function text(value: unknown, maximum = 20_000): string {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
    );
  }
  return value;
}

function uuid(value: unknown): string | null {
  const candidate = text(value, 60);
  return UUID_PATTERN.test(candidate) ? candidate : null;
}

function integer(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  const candidate = text(value, 80) as T;
  return allowed.includes(candidate) ? candidate : fallback;
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(json(canonicalJsonValue(value)))
    .digest("hex");
}

export const campaignBranchSnapshotHash = hash;

/**
 * Upgrade the nested-branch self reference without rebuilding the table.
 * Looking up the FK by its constrained column also handles installations
 * whose PostgreSQL-generated constraint name differs from the current name.
 */
export const campaignBranchParentForeignKeyMigrationSql = String.raw`
  DO $campaign_branch_parent_fk$
  DECLARE
    existing_name text;
    existing_delete_action "char";
  BEGIN
    SELECT constraint_row.conname, constraint_row.confdeltype
      INTO existing_name, existing_delete_action
      FROM pg_constraint constraint_row
      JOIN pg_attribute attribute
        ON attribute.attrelid = constraint_row.conrelid
       AND attribute.attnum = constraint_row.conkey[1]
     WHERE constraint_row.conrelid =
             'storyhold.campaign_branches'::regclass
       AND constraint_row.contype = 'f'
       AND array_length(constraint_row.conkey, 1) = 1
       AND attribute.attname = 'parent_branch_id'
     LIMIT 1;

    IF existing_name IS NULL OR existing_delete_action <> 'n' THEN
      IF existing_name IS NOT NULL THEN
        EXECUTE format(
          'ALTER TABLE storyhold.campaign_branches DROP CONSTRAINT %I',
          existing_name
        );
      END IF;
      ALTER TABLE storyhold.campaign_branches
        ADD CONSTRAINT campaign_branches_parent_branch_id_fkey
        FOREIGN KEY (parent_branch_id)
        REFERENCES storyhold.campaign_branches(id) ON DELETE SET NULL;
    END IF;
  END
  $campaign_branch_parent_fk$;
`;

/**
 * Version markers make an explicitly older checkpoint reproducible even when
 * it is captured after the live campaign has advanced. Existing rows are
 * conservatively backfilled from the latest turn that existed when each row
 * was created. Mutable terminal/reveal markers are backfilled at the current
 * campaign version because the older schema did not record their transition.
 */
export const campaignBranchHistoryMigrationSql = String.raw`
  ALTER TABLE storyhold.world_clock_events
    ADD COLUMN IF NOT EXISTS created_state_version bigint;
  ALTER TABLE storyhold.world_clock_events
    ADD COLUMN IF NOT EXISTS resolved_state_version bigint;
  ALTER TABLE storyhold.world_clock_events
    ADD COLUMN IF NOT EXISTS maturation_narrated_state_version bigint;

  UPDATE storyhold.world_clock_events event
     SET created_state_version = COALESCE(
       (
         SELECT max(turn_row.state_version)
           FROM storyhold.campaign_turns turn_row
          WHERE turn_row.campaign_id = event.campaign_id
            AND turn_row.created_at <= event.created_at
       ),
       CASE WHEN event.campaign_id IS NULL THEN 0 ELSE 1 END
     )
   WHERE event.created_state_version IS NULL;
  UPDATE storyhold.world_clock_events event
     SET resolved_state_version = campaign.state_version
    FROM storyhold.campaigns campaign
   WHERE event.campaign_id = campaign.id
     AND event.status IN ('resolved', 'cancelled', 'superseded')
     AND event.resolved_state_version IS NULL;
  UPDATE storyhold.world_clock_events event
     SET maturation_narrated_state_version = COALESCE(
       event.matured_state_version,
       campaign.state_version
     )
    FROM storyhold.campaigns campaign
   WHERE event.campaign_id = campaign.id
     AND event.maturation_narrated_at IS NOT NULL
     AND event.maturation_narrated_state_version IS NULL;
  ALTER TABLE storyhold.world_clock_events
    ALTER COLUMN created_state_version SET DEFAULT 1;
  ALTER TABLE storyhold.world_clock_events
    ALTER COLUMN created_state_version SET NOT NULL;

  ALTER TABLE storyhold.campaign_runtime_rules
    ADD COLUMN IF NOT EXISTS created_state_version bigint;
  ALTER TABLE storyhold.campaign_runtime_rules
    ADD COLUMN IF NOT EXISTS retired_state_version bigint;
  UPDATE storyhold.campaign_runtime_rules runtime_rule
     SET created_state_version = COALESCE(
       (
         SELECT max(turn_row.state_version)
           FROM storyhold.campaign_turns turn_row
          WHERE turn_row.campaign_id = runtime_rule.campaign_id
            AND turn_row.created_at <= runtime_rule.created_at
       ),
       1
     )
   WHERE runtime_rule.created_state_version IS NULL;
  UPDATE storyhold.campaign_runtime_rules runtime_rule
     SET retired_state_version = campaign.state_version
    FROM storyhold.campaigns campaign
   WHERE runtime_rule.campaign_id = campaign.id
     AND runtime_rule.status IN ('resolved', 'retired')
     AND runtime_rule.retired_state_version IS NULL;
  ALTER TABLE storyhold.campaign_runtime_rules
    ALTER COLUMN created_state_version SET DEFAULT 1;
  ALTER TABLE storyhold.campaign_runtime_rules
    ALTER COLUMN created_state_version SET NOT NULL;
`;

const CAMPAIGN_BRANCH_SNAPSHOT_ARRAYS = [
  "recentTurns",
  "facts",
  "epistemicAssertions",
  "stateSummaries",
  "clockEvents",
  "noveltyMoves",
  "memories",
  "rules",
] as const;

type CampaignBranchRpgPointer = {
  schemaVersion: 1;
  seedSha256: string;
  stateVersion: number;
  stateSha256: string;
};

type CampaignBranchAdventureSetup = {
  schemaVersion: 1;
  id: string;
  campaignId: string;
  expectedStateVersion: number;
  appliedStateVersion: number;
  frozenInput: Record<string, unknown>;
  inputSha256: string;
  plan: AdventureSetupPlan;
  planSha256: string;
};

/** The capsule is self-contained: activation must never read the live parent's setup. */
function adventureSetupCapsule(value: unknown, campaignId: string, stateVersion: number): CampaignBranchAdventureSetup | null {
  const capsule = record(value);
  const frozenInput = record(capsule.frozenInput);
  const context = frozenInput.context as AdventureSetupContext | undefined;
  const expectedVersion = integer(capsule.expectedStateVersion, -1);
  const appliedVersion = integer(capsule.appliedStateVersion, -1);
  if (capsule.schemaVersion !== 1 || !uuid(capsule.id) || capsule.campaignId !== campaignId ||
      expectedVersion < 0 || appliedVersion <= expectedVersion || appliedVersion > stateVersion ||
      !context || record(context.campaign).id !== campaignId ||
      capsule.inputSha256 !== manualStorytellerSha256(frozenInput) ||
      capsule.planSha256 !== manualStorytellerSha256(capsule.plan)) return null;
  try {
    const plan = validateAdventureSetupPlan(capsule.plan, context);
    if (manualStorytellerSha256(plan) !== capsule.planSha256) return null;
    return {
      schemaVersion: 1, id: String(capsule.id), campaignId,
      expectedStateVersion: expectedVersion, appliedStateVersion: appliedVersion,
      frozenInput, inputSha256: String(capsule.inputSha256), plan, planSha256: String(capsule.planSha256),
    };
  } catch {
    return null;
  }
}

async function captureAdventureSetup(db: BranchDb, campaignId: string, stateVersion: number): Promise<CampaignBranchAdventureSetup | null> {
  const table = await db.query<{ table_name: string | null }>(
    "SELECT to_regclass('storyhold.campaign_adventure_setups')::text AS table_name",
  );
  if (!table.rows[0]?.table_name) return null;
  const result = await db.query<Record<string, unknown>>(
    `SELECT id, expected_state_version, applied_state_version, frozen_input,
            input_sha256, plan, plan_sha256
       FROM storyhold.campaign_adventure_setups
      WHERE campaign_id = $1 AND status = 'ready' AND applied_state_version <= $2`,
    [campaignId, stateVersion],
  );
  const row = result.rows[0];
  if (!row) return null;
  const capsule = adventureSetupCapsule({
    schemaVersion: 1, id: row.id, campaignId,
    expectedStateVersion: row.expected_state_version, appliedStateVersion: row.applied_state_version,
    frozenInput: row.frozen_input, inputSha256: row.input_sha256, plan: row.plan, planSha256: row.plan_sha256,
  }, campaignId, stateVersion);
  if (!capsule) throw new CampaignBranchSnapshotCaptureError("ADVENTURE_SETUP_INVALID", "The adventure setup no longer matches its saved evidence.");
  return capsule;
}

async function inheritAdventureSetup(params: {
  db: BranchDb;
  source: CampaignBranchAdventureSetup;
  childCampaignId: string;
  childCampaignName: string;
  playerId: string;
  branchId: string;
  checkpointId: string;
}): Promise<CampaignBranchAdventureSetup> {
  const { source } = params;
  const context = source.frozenInput.context as AdventureSetupContext;
  const origin = {
    sourceSetupId: source.id, sourceCampaignId: source.campaignId,
    sourceInputSha256: source.inputSha256, sourcePlanSha256: source.planSha256,
    sourceCheckpointId: params.checkpointId, branchId: params.branchId,
  };
  const frozenInput = {
    ...source.frozenInput,
    context: {
      ...context,
      campaign: { ...context.campaign, id: params.childCampaignId, name: params.childCampaignName },
      // This is authoring provenance, not an appended scene or changed turn.
      existingSummary: context.existingSummary || "Adventure setup was already initialized at this checkpoint.",
    },
    branchOrigin: origin,
  };
  const plan = { ...source.plan, publicOpening: "" };
  const inherited: CampaignBranchAdventureSetup = {
    ...source, id: randomUUID(), campaignId: params.childCampaignId, frozenInput,
    inputSha256: manualStorytellerSha256(frozenInput), plan, planSha256: manualStorytellerSha256(plan),
  };
  await params.db.query(
    `INSERT INTO storyhold.campaign_adventure_setups
      (id, campaign_id, player_id, expected_state_version, applied_state_version,
       input_sha256, frozen_input, request, plan, plan_sha256, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, 'ready')`,
    [inherited.id, inherited.campaignId, params.playerId, inherited.expectedStateVersion,
      inherited.appliedStateVersion, inherited.inputSha256, json(frozenInput),
      json({ kind: "inherited_adventure_setup", ...origin }), json(plan), inherited.planSha256],
  );
  return inherited;
}

function campaignBranchRpgPointer(value: unknown): CampaignBranchRpgPointer | null {
  const pointer = record(value);
  const seedSha256 = text(pointer.seedSha256, 80);
  const stateSha256 = text(pointer.stateSha256, 80);
  const stateVersion = integer(pointer.stateVersion, -1);
  if (
    integer(pointer.schemaVersion, -1) !== 1 ||
    !/^[0-9a-f]{64}$/u.test(seedSha256) ||
    !/^[0-9a-f]{64}$/u.test(stateSha256) ||
    stateVersion < 0
  ) {
    return null;
  }
  return { schemaVersion: 1, seedSha256, stateVersion, stateSha256 };
}

export function isCompleteCampaignBranchSnapshot(
  value: unknown,
  expected: {
    campaignId: string;
    stateVersion: number;
    startContract: unknown;
  },
): boolean {
  const snapshot = record(value);
  const schemaVersion = integer(snapshot.schemaVersion);
  return (
    (schemaVersion === 2 || schemaVersion === 3 || schemaVersion === 4) &&
    uuid(snapshot.campaignId) === expected.campaignId &&
    integer(snapshot.stateVersion, -1) === expected.stateVersion &&
    expected.stateVersion >= 1 &&
    text(snapshot.startContractHash, 80) === hash(expected.startContract) &&
    Number.isSafeInteger(Number(snapshot.worldTimeMinutes)) &&
    typeof snapshot.worldTimeLabel === "string" &&
    CAMPAIGN_BRANCH_SNAPSHOT_ARRAYS.every((key) => Array.isArray(snapshot[key])) &&
    (schemaVersion < 3 ||
      snapshot.rpgState === null ||
      campaignBranchRpgPointer(snapshot.rpgState) !== null) &&
    (schemaVersion < 4 || snapshot.adventureSetup === null ||
      adventureSetupCapsule(snapshot.adventureSetup, expected.campaignId, expected.stateVersion) !== null)
  );
}

export class CampaignBranchActivationError extends Error {
  constructor(
    readonly code:
      | "BRANCH_ARCHIVED"
      | "BRANCH_SNAPSHOT_INVALID"
      | "BRANCH_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "CampaignBranchActivationError";
  }
}

export class CampaignBranchSnapshotCaptureError extends Error {
  constructor(
    readonly code:
      | "CAMPAIGN_NOT_FOUND"
      | "CAMPAIGN_STATE_CHANGED"
      | "RPG_STATE_CHANGED"
      | "ADVENTURE_SETUP_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "CampaignBranchSnapshotCaptureError";
  }
}

async function assertCampaignSnapshotCoordinates(params: {
  db: BranchDb;
  campaignId: string;
  stateVersion: number;
  worldTimeMinutes: number;
  worldTimeLabel: string;
  startContract: unknown;
}): Promise<void> {
  const campaign = await params.db.query<Record<string, unknown>>(
    `SELECT state_version, world_time_minutes, current_time_label,
            start_contract
       FROM storyhold.campaigns
      WHERE id = $1
      FOR UPDATE`,
    [params.campaignId],
  );
  const row = campaign.rows[0];
  if (!row) {
    throw new CampaignBranchSnapshotCaptureError(
      "CAMPAIGN_NOT_FOUND",
      "Campaign not found while saving its checkpoint.",
    );
  }
  if (
    integer(row.state_version, -1) !== params.stateVersion ||
    integer(row.world_time_minutes) !== params.worldTimeMinutes ||
    text(row.current_time_label, 160) !== params.worldTimeLabel ||
    hash(row.start_contract) !== hash(params.startContract)
  ) {
    throw new CampaignBranchSnapshotCaptureError(
      "CAMPAIGN_STATE_CHANGED",
      "The campaign changed while its checkpoint was being saved.",
    );
  }
}

function sameCampaignRpgPointer(
  left: CampaignBranchRpgPointer | null,
  right: CampaignBranchRpgPointer | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.seedSha256 === right.seedSha256 &&
    left.stateVersion === right.stateVersion &&
    left.stateSha256 === right.stateSha256
  );
}

async function hasCampaignRpgSeed(
  db: BranchDb,
  campaignId: string,
): Promise<boolean> {
  const table = await db.query<{ table_name: string | null }>(
    "SELECT to_regclass('storyhold.campaign_rpg_seeds')::text AS table_name",
  );
  if (!table.rows[0]?.table_name) return false;
  const seed = await db.query<{ campaign_id: string }>(
    `SELECT campaign_id FROM storyhold.campaign_rpg_seeds
      WHERE campaign_id = $1 LIMIT 1`,
    [campaignId],
  );
  return seed.rows.length === 1;
}

async function captureCampaignRpgPointer(
  db: BranchDb,
  campaignId: string,
): Promise<CampaignBranchRpgPointer | null> {
  if (!await hasCampaignRpgSeed(db, campaignId)) return null;
  const snapshot = await loadCampaignRpgSnapshot(db, campaignId);
  return {
    schemaVersion: 1,
    seedSha256: snapshot.seedSha256,
    stateVersion: snapshot.state.stateVersion,
    stateSha256: snapshot.stateSha256,
  };
}

export type CampaignBranchLineageNode = {
  branchId: string;
  branchName: string;
  mode: "writer" | "alternate";
  sourceCampaignId: string;
  sourceCampaignName: string;
  checkpointId: string;
  checkpointName: string;
  checkpointNote: string;
  stateVersion: number;
  worldTimeLabel: string;
  createdAt: string;
};

/**
 * Capture the complete mutable campaign projection needed to create an
 * isolated playable fork. Canon/entity snapshots are copied directly during
 * activation because those tables are immutable; everything mutable is frozen
 * here so later activity on the source campaign cannot bleed into a branch.
 */
export async function captureCampaignBranchSnapshot(params: {
  db: BranchDb;
  campaignId: string;
  stateVersion: number;
  worldTimeMinutes: number;
  worldTimeLabel: string;
  startContract: unknown;
}) {
  const { db, campaignId, stateVersion } = params;
  await assertCampaignSnapshotCoordinates(params);
  const rpgState = await captureCampaignRpgPointer(db, campaignId);
  const adventureSetup = await captureAdventureSetup(db, campaignId, stateVersion);
  const [
    turns,
    facts,
    epistemicAssertions,
    stateSummaries,
    clockEvents,
    noveltyMoves,
    memories,
    rules,
  ] = await Promise.all([
    db.query<Record<string, unknown>>(
      `SELECT id, turn_number, state_version, player_id, character_id,
              player_action, narration, scene_summary, outcome, world_time_label,
              reasoning_level, provider, model, director_provider, director_model,
              director_reasoning, mechanics, engine_envelope, direction,
              resolution, usage, intent_kind, created_at
         FROM storyhold.campaign_turns
        WHERE campaign_id = $1 AND state_version <= $2
        ORDER BY turn_number DESC`,
      [campaignId, stateVersion],
    ),
    db.query<Record<string, unknown>>(
      `SELECT DISTINCT ON (fact_key) *
         FROM storyhold.campaign_facts
        WHERE campaign_id = $1 AND state_version <= $2
        ORDER BY fact_key, state_version DESC, created_at DESC`,
      [campaignId, stateVersion],
    ),
    db.query<Record<string, unknown>>(
      `SELECT DISTINCT ON (assertion_key) *
         FROM storyhold.campaign_epistemic_assertions
        WHERE campaign_id = $1 AND state_version <= $2
        ORDER BY assertion_key, state_version DESC, created_at DESC`,
      [campaignId, stateVersion],
    ),
    db.query<Record<string, unknown>>(
      `SELECT id, entity_type, canonical_key, display_name, summary, facts,
              related_entities, history, source_memory_ids, state_version,
              visibility, visible_to_character_id, created_at, updated_at
         FROM storyhold.campaign_state_summaries
        WHERE campaign_id = $1 AND state_version <= $2
        ORDER BY entity_type, canonical_key`,
      [campaignId, stateVersion],
    ),
    db.query<Record<string, unknown>>(
      `SELECT id, source_id, created_by_player_id, visible_to_character_id,
              causal_parent_id, canonical_key, event_kind, title, summary,
              world_time_label, chronology_order, visibility, knowledge_status,
              known_effects, internal_effects, evidence, scheduled_for_label,
              reveal_rule,
              CASE
                WHEN resolved_state_version IS NOT NULL
                 AND resolved_state_version <= $2 THEN status
                WHEN matured_state_version IS NOT NULL
                 AND matured_state_version <= $2 THEN 'committed'
                WHEN event_kind = 'scheduled_effect' THEN 'scheduled'
                ELSE 'committed'
              END AS status,
              due_world_time_minutes, due_turn_number,
              CASE WHEN matured_state_version <= $2 THEN matured_at END AS matured_at,
              CASE WHEN matured_state_version <= $2
                   THEN matured_state_version END AS matured_state_version,
              CASE WHEN maturation_narrated_state_version <= $2
                   THEN maturation_narrated_at END AS maturation_narrated_at,
              temporal_status, importance, source_chapter_keys,
              trigger_definition, causal_basis, clue_opportunities,
              CASE WHEN matured_state_version <= $2
                   THEN matured_by_event_id END AS matured_by_event_id,
              created_state_version,
              CASE WHEN resolved_state_version <= $2
                   THEN resolved_state_version END AS resolved_state_version,
              CASE WHEN maturation_narrated_state_version <= $2
                   THEN maturation_narrated_state_version
              END AS maturation_narrated_state_version,
              created_at
         FROM storyhold.world_clock_events
        WHERE campaign_id = $1 AND created_state_version <= $2
        ORDER BY chronology_order, created_at`,
      [campaignId, stateVersion],
    ),
    db.query<Record<string, unknown>>(
      `SELECT * FROM storyhold.campaign_novelty_ledger
        WHERE campaign_id = $1 AND state_version <= $2
        ORDER BY state_version DESC, created_at DESC`,
      [campaignId, stateVersion],
    ),
    db.query<Record<string, unknown>>(
      `SELECT id, player_id, character_id, memory_kind, content,
              compact_summary, metadata, state_version, created_at
         FROM storyhold.vault_memory_chunks
        WHERE campaign_id = $1 AND state_version <= $2
        ORDER BY state_version DESC, created_at DESC`,
      [campaignId, stateVersion],
    ),
    db.query<Record<string, unknown>>(
      `SELECT id, canonical_key, name, rule_kind, trigger_definition,
              requirements, effects, visibility, authored_by,
              CASE
                WHEN retired_state_version IS NOT NULL
                 AND retired_state_version <= $2 THEN status
                WHEN status IN ('resolved', 'retired') THEN 'active'
                ELSE status
              END AS status,
              created_state_version,
              CASE WHEN retired_state_version <= $2
                   THEN retired_state_version END AS retired_state_version,
              created_at
         FROM storyhold.campaign_runtime_rules
        WHERE campaign_id = $1 AND created_state_version <= $2
        ORDER BY created_at`,
      [campaignId, stateVersion],
    ),
  ]);

  await assertCampaignSnapshotCoordinates(params);
  const confirmedRpgState = await captureCampaignRpgPointer(db, campaignId);
  if (!sameCampaignRpgPointer(rpgState, confirmedRpgState)) {
    throw new CampaignBranchSnapshotCaptureError(
      "RPG_STATE_CHANGED",
      "The roleplaying state changed while its checkpoint was being saved.",
    );
  }

  return {
    schemaVersion: 4,
    campaignId,
    stateVersion,
    rpgState,
    adventureSetup,
    worldTimeMinutes: params.worldTimeMinutes,
    worldTimeLabel: params.worldTimeLabel,
    turnId: turns.rows[0]?.id ?? null,
    startContractHash: hash(params.startContract),
    recentTurns: [...turns.rows].reverse(),
    facts: facts.rows,
    epistemicAssertions: epistemicAssertions.rows,
    stateSummaries: stateSummaries.rows,
    clockEvents: clockEvents.rows,
    noveltyMoves: [...noveltyMoves.rows].reverse(),
    memories: [...memories.rows].reverse(),
    rules: rules.rows,
  };
}

export async function loadCampaignBranchLineage(
  db: BranchDb,
  playableCampaignId: string,
): Promise<CampaignBranchLineageNode[]> {
  const result = await db.query<Record<string, unknown>>(
    `WITH RECURSIVE branch_lineage AS (
       SELECT branch.id, branch.parent_branch_id, branch.name, branch.mode,
              branch.campaign_id, branch.checkpoint_id, branch.created_at,
              source_campaign.name AS source_campaign_name,
              checkpoint.name AS checkpoint_name,
              checkpoint.note AS checkpoint_note,
              checkpoint.state_version AS checkpoint_state_version,
              checkpoint.world_time_label AS checkpoint_world_time_label,
              0 AS depth
         FROM storyhold.campaign_branches branch
         JOIN storyhold.campaigns source_campaign ON source_campaign.id = branch.campaign_id
         JOIN storyhold.campaign_checkpoints checkpoint ON checkpoint.id = branch.checkpoint_id
        WHERE branch.playable_campaign_id = $1
       UNION ALL
       SELECT parent.id, parent.parent_branch_id, parent.name, parent.mode,
              parent.campaign_id, parent.checkpoint_id, parent.created_at,
              source_campaign.name AS source_campaign_name,
              checkpoint.name AS checkpoint_name,
              checkpoint.note AS checkpoint_note,
              checkpoint.state_version AS checkpoint_state_version,
              checkpoint.world_time_label AS checkpoint_world_time_label,
              child.depth + 1
         FROM storyhold.campaign_branches parent
         JOIN branch_lineage child ON child.parent_branch_id = parent.id
         JOIN storyhold.campaigns source_campaign ON source_campaign.id = parent.campaign_id
         JOIN storyhold.campaign_checkpoints checkpoint ON checkpoint.id = parent.checkpoint_id
     )
     SELECT * FROM branch_lineage ORDER BY depth DESC`,
    [playableCampaignId],
  );
  return result.rows.map((row) => ({
    branchId: String(row.id),
    branchName: text(row.name, 120) || "Alternate timeline",
    mode: row.mode === "writer" ? "writer" : "alternate",
    sourceCampaignId: String(row.campaign_id),
    sourceCampaignName: text(row.source_campaign_name, 180) || "Parent timeline",
    checkpointId: String(row.checkpoint_id),
    checkpointName: text(row.checkpoint_name, 120) || "Saved checkpoint",
    checkpointNote: text(row.checkpoint_note, 600),
    stateVersion: integer(row.checkpoint_state_version),
    worldTimeLabel: text(row.checkpoint_world_time_label, 160),
    createdAt: String(row.created_at ?? ""),
  }));
}

/**
 * The additive integration point for immutable, campaign-scoped canon. Any
 * future frozen retrieval table belongs here before branches can be enabled
 * for that schema version, preventing fallback to mutable world-studio data.
 */
export async function copyCampaignImmutableCanonScope(params: {
  db: BranchDb;
  sourceCampaignId: string;
  targetCampaignId: string;
}) {
  await params.db.query(
    `INSERT INTO storyhold.campaign_entity_snapshots
      (campaign_id, entity_id, dossier_id, canonical_character_id,
       canonical_key, entity_type, name, aliases, role, summary, profile,
       details, relationships, socio_political_axis, faction_memberships,
       entity_links, entity_rules, mention_count, confidence, created_at)
     SELECT $1, entity_id, dossier_id, canonical_character_id, canonical_key,
            entity_type, name, aliases, role, summary, profile, details,
            relationships, socio_political_axis, faction_memberships,
            entity_links, entity_rules, mention_count, confidence, created_at
       FROM storyhold.campaign_entity_snapshots WHERE campaign_id = $2`,
    [params.targetCampaignId, params.sourceCampaignId],
  );
  await params.db.query(
    `INSERT INTO storyhold.campaign_canon_event_snapshots
      (campaign_id, event_id, canonical_key, title, summary,
       world_time_label, chronology_order, temporal_status, importance,
       source_chapter_keys, evidence, causal_links, participant_entity_ids,
       created_at)
     SELECT $1, event_id, canonical_key, title, summary, world_time_label,
            chronology_order, temporal_status, importance, source_chapter_keys,
            evidence, causal_links, participant_entity_ids, created_at
       FROM storyhold.campaign_canon_event_snapshots WHERE campaign_id = $2`,
    [params.targetCampaignId, params.sourceCampaignId],
  );
  await params.db.query(
    `INSERT INTO storyhold.campaign_canon_evidence_snapshots
      (campaign_id, evidence_key, world_id, canon_edition_id, source_id,
       chunk_id, source_content_hash, chunk_content_hash, source_title,
       source_kind, chronology_label, excerpt, excerpt_hash, event_ids,
       chronology_orders, created_at)
     SELECT $1, evidence_key, world_id, canon_edition_id, source_id, chunk_id,
            source_content_hash, chunk_content_hash, source_title, source_kind,
            chronology_label, excerpt, excerpt_hash, event_ids,
            chronology_orders, created_at
       FROM storyhold.campaign_canon_evidence_snapshots
      WHERE campaign_id = $2`,
    [params.targetCampaignId, params.sourceCampaignId],
  );
  await params.db.query(
    `INSERT INTO storyhold.campaign_canon_claim_snapshots
      (campaign_id, claim_id, world_id, canon_edition_id, fingerprint,
       supersedes_claim_id, subject_entity_id, predicate, polarity,
       object_entity_id, object_text, epistemic_holder_entity_id, truth_status,
       valid_from_label, valid_until_label, summary, evidence, confidence,
       claim_status, assignment_source, source_updated_at, snapshot_hash,
       created_at)
     SELECT $1, claim_id, world_id, canon_edition_id, fingerprint,
            supersedes_claim_id, subject_entity_id, predicate, polarity,
            object_entity_id, object_text, epistemic_holder_entity_id,
            truth_status, valid_from_label, valid_until_label, summary,
            evidence, confidence, claim_status, assignment_source,
            source_updated_at, snapshot_hash, created_at
       FROM storyhold.campaign_canon_claim_snapshots
      WHERE campaign_id = $2`,
    [params.targetCampaignId, params.sourceCampaignId],
  );
}

/**
 * Campaigns created before the RPG kernel was introduced legitimately have no
 * seed row and keep their existing branch behavior. Once a campaign has an
 * RPG seed, however, every playable child must receive the exact historical
 * runtime projection selected by the checkpoint. Any missing/corrupt state or
 * broken event chain is therefore allowed to abort the surrounding activation
 * transaction instead of silently producing a mechanically inconsistent fork.
 */
async function copyCampaignRpgStateWhenInitialized(params: {
  db: BranchDb;
  sourceCampaignId: string;
  childCampaignId: string;
  snapshotPointer: unknown;
  seedReference: unknown;
}): Promise<boolean> {
  const sourceHasSeed = await hasCampaignRpgSeed(
    params.db,
    params.sourceCampaignId,
  );
  const pointer = campaignBranchRpgPointer(params.snapshotPointer);
  const seedReference = record(params.seedReference);
  const expectsRpgState = Object.keys(seedReference).length > 0;
  const referencedSeedHash = text(seedReference.seedSha256, 80);
  if (expectsRpgState && !/^[0-9a-f]{64}$/u.test(referencedSeedHash)) {
    throw new CampaignBranchActivationError(
      "BRANCH_SNAPSHOT_INVALID",
      "This branch's roleplaying foundation is incomplete.",
    );
  }
  if (!sourceHasSeed) {
    if (
      expectsRpgState ||
      (params.snapshotPointer !== null && params.snapshotPointer !== undefined)
    ) {
      throw new CampaignBranchActivationError(
        "BRANCH_SNAPSHOT_INVALID",
        "This branch's roleplaying state no longer matches its checkpoint.",
      );
    }
    return false;
  }
  if (!pointer) {
    throw new CampaignBranchActivationError(
      "BRANCH_SNAPSHOT_INVALID",
      "This branch predates the campaign's roleplaying-state checkpoint.",
    );
  }

  const copied = await copyCampaignRpgStateToChildInTransaction({
    db: params.db,
    sourceCampaignId: params.sourceCampaignId,
    childCampaignId: params.childCampaignId,
    sourceStateVersion: pointer.stateVersion,
  });
  if (
    copied.seedSha256 !== pointer.seedSha256 ||
    (expectsRpgState && copied.seedSha256 !== referencedSeedHash) ||
    copied.stateSha256 !== pointer.stateSha256 ||
    copied.state.stateVersion !== pointer.stateVersion
  ) {
    throw new CampaignBranchActivationError(
      "BRANCH_SNAPSHOT_INVALID",
      "This branch's roleplaying state no longer matches its checkpoint.",
    );
  }
  return true;
}

function snapshotStateVersion(snapshot: Record<string, unknown>, fallback: unknown) {
  return integer(snapshot.stateVersion, integer(fallback));
}

function branchClockKey(branchId: string, original: unknown, index: number) {
  const base = text(original, 180).replace(/[^a-zA-Z0-9_-]+/g, "-") || `event-${index + 1}`;
  return `branch-${branchId.slice(0, 12)}-${base}`.slice(0, 240);
}

/**
 * Idempotently materialize an isolated campaign from a paid branch record.
 * This function deliberately contains no credit-ledger operations: the branch
 * creation endpoint owns the one-time product charge, while activation and
 * every later resume are free.
 */
export async function activateCampaignBranch(params: {
  db: BranchRootDb;
  sourceCampaignId: string;
  branchId: string;
  playerId: string;
}): Promise<{ campaignId: string; created: boolean }> {
  const preparedCampaignId = randomUUID();
  return params.db.transaction(async (tx) => {
    const lockedResult = await tx.query<Record<string, unknown>>(
      `SELECT branch.*, checkpoint.snapshot AS checkpoint_snapshot,
              checkpoint.snapshot_sha256 AS checkpoint_snapshot_sha256,
              checkpoint.name AS checkpoint_name,
              checkpoint.note AS checkpoint_note,
              checkpoint.state_version AS checkpoint_state_version,
              checkpoint.world_time_minutes AS checkpoint_world_time_minutes,
              checkpoint.world_time_label AS checkpoint_world_time_label,
              source_campaign.world_id AS source_world_id,
              source_campaign.canon_edition_id AS source_canon_edition_id,
              source_campaign.ruleset_id AS source_ruleset_id,
              source_campaign.owner_player_id AS source_owner_player_id,
              source_campaign.canonical_key AS source_canonical_key,
              source_campaign.name AS source_campaign_name,
              source_campaign.start_contract AS source_start_contract,
              source_campaign.start_locked_at AS source_start_locked_at,
              source_campaign.perspective_character_id AS source_character_id,
              source_campaign.resolution_mode AS source_resolution_mode
         FROM storyhold.campaign_branches branch
         JOIN storyhold.campaign_checkpoints checkpoint
           ON checkpoint.id = branch.checkpoint_id
          AND checkpoint.campaign_id = branch.campaign_id
         JOIN storyhold.campaigns source_campaign
           ON source_campaign.id = branch.campaign_id
        WHERE branch.id = $1 AND branch.campaign_id = $2
          AND (branch.created_by_player_id = $3 OR source_campaign.owner_player_id = $3)
        LIMIT 1
        FOR UPDATE OF branch`,
      [params.branchId, params.sourceCampaignId, params.playerId],
    );
    const branch = lockedResult.rows[0];
    if (!branch) {
      throw new CampaignBranchActivationError(
        "BRANCH_NOT_FOUND",
        "Branch not found.",
      );
    }
    if (branch.status === "archived") {
      throw new CampaignBranchActivationError(
        "BRANCH_ARCHIVED",
        "Restore this timeline before opening it.",
      );
    }

    const existingCampaignId = uuid(branch.playable_campaign_id);
    if (existingCampaignId) {
      await tx.query(
        `INSERT INTO storyhold.campaign_members (campaign_id, player_id, character_id)
         SELECT $1, $2, COALESCE(member.character_id, campaign.perspective_character_id)
           FROM storyhold.campaigns campaign
           LEFT JOIN storyhold.campaign_members member
             ON member.campaign_id = campaign.id AND member.player_id = $2
          WHERE campaign.id = $3
         ON CONFLICT (campaign_id, player_id) DO NOTHING`,
        [existingCampaignId, params.playerId, params.sourceCampaignId],
      );
      return { campaignId: existingCampaignId, created: false };
    }

    const snapshot = record(branch.branch_snapshot);
    const checkpointSnapshot = record(branch.checkpoint_snapshot);
    const stateVersion = snapshotStateVersion(
      snapshot,
      branch.checkpoint_state_version,
    );
    const snapshotCampaignId = uuid(snapshot.campaignId);
    const sourceStartContract = record(branch.source_start_contract);
    const expectedSnapshotHash = text(branch.branch_snapshot_sha256, 80);
    const checkpointSnapshotHash = text(
      branch.checkpoint_snapshot_sha256,
      80,
    );
    if (
      !isCompleteCampaignBranchSnapshot(snapshot, {
        campaignId: params.sourceCampaignId,
        stateVersion,
        startContract: sourceStartContract,
      }) ||
      !isCompleteCampaignBranchSnapshot(checkpointSnapshot, {
        campaignId: params.sourceCampaignId,
        stateVersion,
        startContract: sourceStartContract,
      }) ||
      !expectedSnapshotHash ||
      !checkpointSnapshotHash ||
      expectedSnapshotHash !== campaignBranchSnapshotHash(snapshot) ||
      checkpointSnapshotHash !== campaignBranchSnapshotHash(checkpointSnapshot) ||
      expectedSnapshotHash !== checkpointSnapshotHash ||
      stateVersion !== integer(branch.checkpoint_state_version) ||
      snapshotCampaignId !== params.sourceCampaignId
    ) {
      throw new CampaignBranchActivationError(
        "BRANCH_SNAPSHOT_INVALID",
        "This branch no longer matches its immutable checkpoint.",
      );
    }

    const campaignId = preparedCampaignId;
    const forkStartContract = {
      ...sourceStartContract,
      branchLineage: {
        version: 1,
        branchId: params.branchId,
        sourceCampaignId: params.sourceCampaignId,
        checkpointId: String(branch.checkpoint_id),
        checkpointStateVersion: stateVersion,
      },
    };
    const worldId = String(branch.source_world_id);
    const editionId = uuid(branch.source_canon_edition_id);
    const characterId = uuid(branch.source_character_id);
    const branchName = text(branch.name, 120) || "Alternate timeline";
    const worldTimeMinutes = integer(
      snapshot.worldTimeMinutes,
      integer(branch.checkpoint_world_time_minutes),
    );
    const worldTimeLabel =
      text(snapshot.worldTimeLabel, 160) ||
      text(branch.checkpoint_world_time_label, 160) ||
      "The beginning";

    await tx.query(
      `INSERT INTO storyhold.campaigns
        (id, world_id, canon_edition_id, ruleset_id, owner_player_id, parent_campaign_id,
         canonical_key, name, start_contract, start_locked_at,
         perspective_character_id, current_time_label, world_time_minutes,
         resolution_mode, status, state_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13,
               $14, 'active', $15)`,
      [
        campaignId,
        worldId,
        editionId,
        uuid(branch.source_ruleset_id),
        String(branch.source_owner_player_id),
        params.sourceCampaignId,
        `branch-${params.branchId}`,
        branchName,
        json(forkStartContract),
        branch.source_start_locked_at ?? new Date().toISOString(),
        characterId,
        worldTimeLabel,
        worldTimeMinutes,
        text(branch.source_resolution_mode, 40) || "story_first",
        stateVersion,
      ],
    );

    await copyCampaignRpgStateWhenInitialized({
      db: tx,
      sourceCampaignId: params.sourceCampaignId,
      childCampaignId: campaignId,
      snapshotPointer: snapshot.rpgState,
      seedReference: sourceStartContract.rpgSeed,
    });

    // Legacy snapshots have no capsule; absence never falls back to current parent data.
    const sourceSetup = integer(snapshot.schemaVersion) >= 4 && snapshot.adventureSetup !== null
      ? adventureSetupCapsule(snapshot.adventureSetup, params.sourceCampaignId, stateVersion)
      : null;
    const inheritedSetup = sourceSetup ? await inheritAdventureSetup({
      db: tx, source: sourceSetup, childCampaignId: campaignId, childCampaignName: branchName,
      playerId: params.playerId, branchId: params.branchId, checkpointId: String(branch.checkpoint_id),
    }) : null;

    await tx.query(
      `INSERT INTO storyhold.campaign_members (campaign_id, player_id, character_id)
       SELECT $1, player_id, character_id
         FROM storyhold.campaign_members WHERE campaign_id = $2
       ON CONFLICT (campaign_id, player_id) DO NOTHING`,
      [campaignId, params.sourceCampaignId],
    );
    await tx.query(
      `INSERT INTO storyhold.campaign_members (campaign_id, player_id, character_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (campaign_id, player_id) DO NOTHING`,
      [campaignId, params.playerId, characterId],
    );

    await copyCampaignImmutableCanonScope({
      db: tx,
      sourceCampaignId: params.sourceCampaignId,
      targetCampaignId: campaignId,
    });

    const baselineEventId = randomUUID();
    await tx.query(
      `INSERT INTO storyhold.world_state_events
        (id, campaign_id, sequence_number, event_type, payload,
         caused_by_player_id)
       VALUES ($1, $2, $3, 'campaign_branch_activated', $4::jsonb, $5)`,
      [
        baselineEventId,
        campaignId,
        stateVersion,
        json({
          schemaVersion: 1,
          branchId: params.branchId,
          sourceCampaignId: params.sourceCampaignId,
          checkpointId: branch.checkpoint_id,
          checkpointStateVersion: stateVersion,
        }),
        params.playerId,
      ],
    );

    const turnIdMap = new Map<string, string>();
    const clonedTurns = records(snapshot.recentTurns)
      .filter((turn) => integer(turn.turn_number) > 0)
      .sort((left, right) => integer(left.turn_number) - integer(right.turn_number));
    for (const turn of clonedTurns) {
      const newTurnId = randomUUID();
      const oldTurnId = uuid(turn.id);
      if (oldTurnId) turnIdMap.set(oldTurnId, newTurnId);
      const turnNumber = integer(turn.turn_number);
      const turnStateVersion = Math.max(
        1,
        Math.min(
          stateVersion,
          integer(turn.state_version, Math.min(stateVersion, turnNumber + 1)),
        ),
      );
      const outcome = enumValue(
        turn.outcome,
        ["success", "mixed", "failure", "uncertain", "none"] as const,
        "none",
      );
      await tx.query(
        `INSERT INTO storyhold.campaign_turns
          (id, campaign_id, world_id, player_id, character_id, request_id,
           turn_number, state_version, player_action, narration, scene_summary,
           outcome, world_time_label, reasoning_level, provider, model,
           director_provider, director_model, director_reasoning, mechanics,
           engine_envelope, direction, resolution, usage, intent_kind, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21::jsonb,
                 $22::jsonb, $23::jsonb, $24::jsonb, $25, $26)`,
        [
          newTurnId,
          campaignId,
          worldId,
          uuid(turn.player_id) ?? params.playerId,
          uuid(turn.character_id),
          `branch_${params.branchId.slice(0, 12)}_${turnNumber}_${newTurnId.slice(0, 8)}`,
          turnNumber,
          turnStateVersion,
          text(turn.player_action, 4_000),
          text(turn.narration, 100_000),
          text(turn.scene_summary, 2_000),
          outcome,
          text(turn.world_time_label, 160),
          enumValue(turn.reasoning_level, ["low", "medium", "high"] as const, "low"),
          text(turn.provider, 120) || "storyhold",
          text(turn.model, 240) || "branch-history",
          text(turn.director_provider, 120),
          text(turn.director_model, 240),
          enumValue(turn.director_reasoning, ["low", "medium", "high"] as const, "low"),
          json(record(turn.mechanics)),
          json(record(turn.engine_envelope)),
          json(record(turn.direction)),
          json(
            Object.keys(record(turn.resolution)).length
              ? record(turn.resolution)
              : {
                  narration: text(turn.narration, 100_000),
                  sceneSummary: text(turn.scene_summary, 2_000),
                  outcome,
                  worldTimeLabel: text(turn.world_time_label, 160),
                },
          ),
          json(record(turn.usage)),
          enumValue(turn.intent_kind, ["action", "question", "event"] as const, "action"),
          turn.created_at ?? new Date().toISOString(),
        ],
      );
    }

    const factIdMap = new Map<string, string>();
    for (const fact of records(snapshot.facts)) {
      const factKey = text(fact.fact_key, 500);
      if (!factKey) continue;
      const newFactId = randomUUID();
      const oldFactId = uuid(fact.id);
      if (oldFactId) factIdMap.set(oldFactId, newFactId);
      await tx.query(
        `INSERT INTO storyhold.campaign_facts
          (id, campaign_id, source_event_id, source_turn_id, state_version,
           fact_key, subject_entity_id, subject, predicate, object_value,
           stance, confidence, causal_basis, supersedes_fact_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13::jsonb, NULL, $14)`,
        [
          newFactId,
          campaignId,
          baselineEventId,
          turnIdMap.get(String(fact.source_turn_id ?? "")) ?? null,
          Math.max(1, Math.min(stateVersion, integer(fact.state_version, stateVersion))),
          factKey,
          uuid(fact.subject_entity_id),
          text(fact.subject, 500) || "Campaign state",
          text(fact.predicate, 500) || "is",
          text(fact.object_value, 2_000),
          enumValue(
            fact.stance,
            ["affirmed", "denied", "uncertain", "disputed"] as const,
            "affirmed",
          ),
          Math.max(0, Math.min(1, Number(fact.confidence) || 0.75)),
          json(Array.isArray(fact.causal_basis) ? fact.causal_basis : []),
          fact.created_at ?? new Date().toISOString(),
        ],
      );
    }

    for (const assertion of records(snapshot.epistemicAssertions)) {
      const assertionKey = text(assertion.assertion_key, 500);
      if (!assertionKey) continue;
      await tx.query(
        `INSERT INTO storyhold.campaign_epistemic_assertions
          (id, campaign_id, source_event_id, source_turn_id, source_fact_id,
           state_version, assertion_key, layer, holder_entity_id, holder,
           subject_entity_id, subject, predicate, object_value, stance,
           visibility, confidence, causal_basis, supersedes_assertion_id,
           created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13, $14, $15, $16, $17, $18::jsonb, NULL, $19)`,
        [
          randomUUID(),
          campaignId,
          baselineEventId,
          turnIdMap.get(String(assertion.source_turn_id ?? "")) ?? null,
          factIdMap.get(String(assertion.source_fact_id ?? "")) ?? null,
          Math.max(1, Math.min(stateVersion, integer(assertion.state_version, stateVersion))),
          assertionKey,
          enumValue(assertion.layer, ["knowledge", "belief", "claim"] as const, "knowledge"),
          uuid(assertion.holder_entity_id),
          text(assertion.holder, 500) || "Campaign",
          uuid(assertion.subject_entity_id),
          text(assertion.subject, 500) || "Campaign state",
          text(assertion.predicate, 500) || "is",
          text(assertion.object_value, 2_000),
          enumValue(
            assertion.stance,
            ["affirmed", "denied", "uncertain", "disputed"] as const,
            "affirmed",
          ),
          enumValue(
            assertion.visibility,
            ["campaign", "character", "system", "studio"] as const,
            "character",
          ),
          Math.max(0, Math.min(1, Number(assertion.confidence) || 0.75)),
          json(Array.isArray(assertion.causal_basis) ? assertion.causal_basis : []),
          assertion.created_at ?? new Date().toISOString(),
        ],
      );
    }

    for (const summary of records(snapshot.stateSummaries)) {
      const canonicalKey = text(summary.canonical_key, 500);
      if (!canonicalKey) continue;
      await tx.query(
        `INSERT INTO storyhold.campaign_state_summaries
          (id, world_id, canon_edition_id, campaign_id, entity_type,
           canonical_key, display_name, summary, facts, related_entities,
           history, source_memory_ids, state_version, visibility,
           visible_to_character_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb,
                 $11::jsonb, $12::jsonb, $13, $14, $15, $16, $17)`,
        [
          randomUUID(),
          worldId,
          editionId,
          campaignId,
          enumValue(
            summary.entity_type,
            ["character", "relationship", "location", "faction", "plot", "item"] as const,
            "plot",
          ),
          canonicalKey,
          text(summary.display_name, 500) || canonicalKey,
          text(summary.summary, 4_000),
          json(Array.isArray(summary.facts) ? summary.facts : []),
          json(Array.isArray(summary.related_entities) ? summary.related_entities : []),
          json(Array.isArray(summary.history) ? summary.history : []),
          json(Array.isArray(summary.source_memory_ids) ? summary.source_memory_ids : []),
          Math.max(0, Math.min(stateVersion, integer(summary.state_version, stateVersion))),
          enumValue(summary.visibility, ["campaign", "character", "system"] as const, "campaign"),
          uuid(summary.visible_to_character_id),
          summary.created_at ?? new Date().toISOString(),
          summary.updated_at ?? new Date().toISOString(),
        ],
      );
    }

    for (const memory of records(snapshot.memories)) {
      await tx.query(
        `INSERT INTO storyhold.vault_memory_chunks
          (id, world_id, canon_edition_id, campaign_id, player_id, character_id,
           memory_kind, content, compact_summary, metadata, state_version,
           created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)`,
        [
          randomUUID(),
          worldId,
          editionId,
          campaignId,
          uuid(memory.player_id),
          uuid(memory.character_id),
          text(memory.memory_kind, 100) || "branch_memory",
          text(memory.content, 100_000),
          text(memory.compact_summary, 4_000) || null,
          json(record(memory.metadata)),
          Math.max(0, Math.min(stateVersion, integer(memory.state_version, stateVersion))),
          memory.created_at ?? new Date().toISOString(),
        ],
      );
    }

    for (const rule of records(snapshot.rules)) {
      const canonicalKey = text(rule.canonical_key, 500);
      if (!canonicalKey) continue;
      await tx.query(
        `INSERT INTO storyhold.campaign_runtime_rules
          (id, world_id, campaign_id, canonical_key, name, rule_kind,
           trigger_definition, requirements, effects, visibility, authored_by,
           status, created_state_version, retired_state_version, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb,
                 $10, $11, $12, $13, $14, $15)`,
        [
          randomUUID(),
          worldId,
          campaignId,
          canonicalKey,
          text(rule.name, 500) || canonicalKey,
          enumValue(
            rule.rule_kind,
            ["world_rule", "trigger", "clock", "ad_hoc_ruling", "safety_boundary"] as const,
            "world_rule",
          ),
          json(record(rule.trigger_definition)),
          json(Array.isArray(rule.requirements) ? rule.requirements : []),
          json(Array.isArray(rule.effects) ? rule.effects : []),
          enumValue(rule.visibility, ["player", "system", "studio"] as const, "system"),
          enumValue(rule.authored_by, ["source", "player", "storyhold", "imported_ruleset"] as const, "storyhold"),
          enumValue(rule.status, ["draft", "active", "resolved", "retired"] as const, "active"),
          Math.max(
            1,
            Math.min(stateVersion, integer(rule.created_state_version, 1)),
          ),
          rule.retired_state_version === null ||
          rule.retired_state_version === undefined
            ? null
            : Math.max(
                1,
                Math.min(
                  stateVersion,
                  integer(rule.retired_state_version, stateVersion),
                ),
              ),
          rule.created_at ?? new Date().toISOString(),
        ],
      );
    }

    const clockRows = records(snapshot.clockEvents);
    const clockIdMap = new Map<string, string>();
    clockRows.forEach((clock) => {
      const oldId = uuid(clock.id);
      if (oldId) clockIdMap.set(oldId, randomUUID());
    });
    for (const [index, clock] of clockRows.entries()) {
      const oldId = uuid(clock.id);
      const newClockId = oldId ? clockIdMap.get(oldId)! : randomUUID();
      const visibility = enumValue(
        clock.visibility,
        ["world", "campaign", "character", "system", "studio"] as const,
        "campaign",
      );
      await tx.query(
        `INSERT INTO storyhold.world_clock_events
          (id, world_id, canon_edition_id, campaign_id, source_id,
           created_by_player_id, visible_to_character_id, causal_parent_id,
           canonical_key, event_kind, title, summary, world_time_label,
           chronology_order, visibility, knowledge_status, known_effects,
           internal_effects, evidence, scheduled_for_label, reveal_rule, status,
           due_world_time_minutes, due_turn_number, matured_at,
           matured_state_version, maturation_narrated_at, temporal_status,
           importance, source_chapter_keys, trigger_definition, causal_basis,
           clue_opportunities, matured_by_event_id, created_state_version,
           resolved_state_version, maturation_narrated_state_version, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13, $14, $15, $16, $17::jsonb, $18::jsonb, $19::jsonb,
                 $20, $21::jsonb, $22, $23, $24, $25, $26, $27, $28, $29,
                 $30::jsonb, $31::jsonb, $32::jsonb, $33::jsonb, $34, $35,
                 $36, $37, $38)`,
        [
          newClockId,
          worldId,
          editionId,
          campaignId,
          uuid(clock.source_id),
          uuid(clock.created_by_player_id) ?? params.playerId,
          visibility === "character"
            ? uuid(clock.visible_to_character_id) ?? characterId
            : uuid(clock.visible_to_character_id),
          clockIdMap.get(String(clock.causal_parent_id ?? "")) ?? null,
          branchClockKey(params.branchId, clock.canonical_key, index),
          enumValue(
            clock.event_kind,
            ["canon", "scene", "commitment", "reminder", "discovery", "state_change", "scheduled_effect", "ruling"] as const,
            "scene",
          ),
          text(clock.title, 500) || "Branch event",
          text(clock.summary, 4_000),
          text(clock.world_time_label, 160),
          integer(clock.chronology_order, index),
          visibility,
          enumValue(
            clock.knowledge_status,
            ["observed", "told", "inferred", "disputed", "secret", "revealed"] as const,
            "observed",
          ),
          json(Array.isArray(clock.known_effects) ? clock.known_effects : []),
          json(Array.isArray(clock.internal_effects) ? clock.internal_effects : []),
          json(Array.isArray(clock.evidence) ? clock.evidence : []),
          text(clock.scheduled_for_label, 160),
          json(record(clock.reveal_rule)),
          enumValue(
            clock.status,
            ["committed", "scheduled", "resolved", "cancelled", "superseded"] as const,
            "committed",
          ),
          clock.due_world_time_minutes ?? null,
          clock.due_turn_number ?? null,
          clock.matured_at ?? null,
          clock.matured_state_version ?? null,
          clock.maturation_narrated_at ?? null,
          enumValue(clock.temporal_status, ["exact", "relative", "uncertain", "parallel"] as const, "relative"),
          enumValue(clock.importance, ["major", "turning_point"] as const, "major"),
          json(Array.isArray(clock.source_chapter_keys) ? clock.source_chapter_keys : []),
          json(record(clock.trigger_definition)),
          json(Array.isArray(clock.causal_basis) ? clock.causal_basis : []),
          json(Array.isArray(clock.clue_opportunities) ? clock.clue_opportunities : []),
          clock.matured_by_event_id ? baselineEventId : null,
          Math.max(
            1,
            Math.min(stateVersion, integer(clock.created_state_version, 1)),
          ),
          clock.resolved_state_version === null ||
          clock.resolved_state_version === undefined
            ? null
            : Math.max(
                1,
                Math.min(
                  stateVersion,
                  integer(clock.resolved_state_version, stateVersion),
                ),
              ),
          clock.maturation_narrated_state_version === null ||
          clock.maturation_narrated_state_version === undefined
            ? null
            : Math.max(
                1,
                Math.min(
                  stateVersion,
                  integer(
                    clock.maturation_narrated_state_version,
                    stateVersion,
                  ),
                ),
              ),
          clock.created_at ?? new Date().toISOString(),
        ],
      );
    }

    const latestClonedTurnId = clonedTurns.length
      ? turnIdMap.get(String(clonedTurns.at(-1)?.id ?? "")) ?? null
      : null;
    if (latestClonedTurnId) {
      for (const novelty of records(snapshot.noveltyMoves)) {
        await tx.query(
          `INSERT INTO storyhold.campaign_novelty_ledger
            (id, campaign_id, source_event_id, source_turn_id, state_version,
             device, structure, summary, intentional_motif, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            randomUUID(),
            campaignId,
            baselineEventId,
            turnIdMap.get(String(novelty.source_turn_id ?? "")) ?? latestClonedTurnId,
            Math.max(1, Math.min(stateVersion, integer(novelty.state_version, stateVersion))),
            text(novelty.device, 500) || "branch motif",
            text(novelty.structure, 500),
            text(novelty.summary, 2_000),
            Boolean(novelty.intentional_motif),
            novelty.created_at ?? new Date().toISOString(),
          ],
        );
      }
    }

    const originCheckpointId = randomUUID();
    const forkSnapshot = {
      ...snapshot,
      schemaVersion: Math.max(2, integer(snapshot.schemaVersion, 1)),
      campaignId,
      startContractHash: hash(forkStartContract),
      ...(integer(snapshot.schemaVersion) >= 4 ? { adventureSetup: inheritedSetup } : {}),
      branchOrigin: {
        branchId: params.branchId,
        sourceCampaignId: params.sourceCampaignId,
        sourceCheckpointId: branch.checkpoint_id,
      },
    };
    const forkSnapshotJson = json(forkSnapshot);
    await tx.query(
      `INSERT INTO storyhold.campaign_checkpoints
        (id, campaign_id, created_by_player_id, turn_id, state_version,
         world_time_minutes, world_time_label, name, note, snapshot,
         snapshot_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
      [
        originCheckpointId,
        campaignId,
        params.playerId,
        latestClonedTurnId,
        stateVersion,
        worldTimeMinutes,
        worldTimeLabel,
        `Branch origin · ${text(branch.checkpoint_name, 120) || "Saved checkpoint"}`,
        text(branch.checkpoint_note, 600),
        forkSnapshotJson,
        campaignBranchSnapshotHash(forkSnapshot),
      ],
    );

    await tx.query(
      `UPDATE storyhold.campaign_branches
          SET playable_campaign_id = $1, activated_by_player_id = $2,
              activated_at = now(), updated_at = now()
        WHERE id = $3 AND campaign_id = $4`,
      [campaignId, params.playerId, params.branchId, params.sourceCampaignId],
    );
    return { campaignId, created: true };
  });
}

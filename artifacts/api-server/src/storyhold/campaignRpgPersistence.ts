import { createHash, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import {
  CampaignRpgValidationError,
  applyCampaignRpgStateDelta,
  createInitialCampaignRpgState,
  normalizeCampaignRpgState,
  normalizeCampaignSeed,
  type CampaignRpgState,
  type CampaignRpgStateDelta,
  type CampaignSeed,
} from "./campaignRpgState";

type CampaignRpgQueryDb = Pick<PGlite, "query">;
type CampaignRpgRootDb = CampaignRpgQueryDb & Pick<PGlite, "transaction">;

/**
 * The launch seed is immutable, the current projection has one row, and every
 * accepted transition is append-only. Update-only triggers deliberately allow
 * foreign-key cascade deletion when the owning campaign is deleted.
 */
export const campaignRpgPersistenceSchemaSql = String.raw`
  CREATE TABLE IF NOT EXISTS storyhold.campaign_rpg_seeds (
    campaign_id uuid PRIMARY KEY
      REFERENCES storyhold.campaigns(id) ON DELETE CASCADE,
    seed_id text NOT NULL,
    seed jsonb NOT NULL,
    seed_sha256 text NOT NULL CHECK (seed_sha256 ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS storyhold.campaign_rpg_states (
    campaign_id uuid PRIMARY KEY
      REFERENCES storyhold.campaign_rpg_seeds(campaign_id) ON DELETE CASCADE,
    seed_id text NOT NULL,
    base_state_version bigint NOT NULL CHECK (base_state_version >= 0),
    base_state jsonb NOT NULL,
    base_state_sha256 text NOT NULL CHECK (base_state_sha256 ~ '^[0-9a-f]{64}$'),
    state_version bigint NOT NULL CHECK (state_version >= 0),
    state jsonb NOT NULL,
    state_sha256 text NOT NULL CHECK (state_sha256 ~ '^[0-9a-f]{64}$'),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (state->>'seedId' = seed_id),
    CHECK (base_state->>'seedId' = seed_id),
    CHECK ((base_state->>'stateVersion')::bigint = base_state_version),
    CHECK ((state->>'stateVersion')::bigint = state_version),
    CHECK (state_version >= base_state_version)
  );

  CREATE TABLE IF NOT EXISTS storyhold.campaign_rpg_state_events (
    id uuid PRIMARY KEY,
    campaign_id uuid NOT NULL
      REFERENCES storyhold.campaign_rpg_seeds(campaign_id) ON DELETE CASCADE,
    request_id text NOT NULL,
    from_version bigint NOT NULL CHECK (from_version >= 0),
    to_version bigint NOT NULL CHECK (to_version = from_version + 1),
    delta jsonb NOT NULL,
    delta_sha256 text NOT NULL CHECK (delta_sha256 ~ '^[0-9a-f]{64}$'),
    prior_state_sha256 text NOT NULL CHECK (prior_state_sha256 ~ '^[0-9a-f]{64}$'),
    next_state_sha256 text NOT NULL CHECK (next_state_sha256 ~ '^[0-9a-f]{64}$'),
    result_state jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((delta->>'expectedStateVersion')::bigint = from_version),
    CHECK ((result_state->>'stateVersion')::bigint = to_version),
    UNIQUE (campaign_id, request_id),
    UNIQUE (campaign_id, to_version)
  );

  CREATE INDEX IF NOT EXISTS campaign_rpg_state_events_version
    ON storyhold.campaign_rpg_state_events (campaign_id, from_version, to_version);

  CREATE OR REPLACE FUNCTION storyhold.reject_campaign_rpg_seed_update()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Campaign RPG seed is immutable';
  END;
  $$;

  DROP TRIGGER IF EXISTS campaign_rpg_seeds_immutable
    ON storyhold.campaign_rpg_seeds;
  CREATE TRIGGER campaign_rpg_seeds_immutable
    BEFORE UPDATE OR DELETE ON storyhold.campaign_rpg_seeds
    FOR EACH ROW EXECUTE FUNCTION storyhold.reject_campaign_rpg_seed_update();

  CREATE OR REPLACE FUNCTION storyhold.reject_campaign_rpg_event_update()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Campaign RPG state events are append-only';
  END;
  $$;

  DROP TRIGGER IF EXISTS campaign_rpg_state_events_append_only
    ON storyhold.campaign_rpg_state_events;
  CREATE TRIGGER campaign_rpg_state_events_append_only
    BEFORE UPDATE OR DELETE ON storyhold.campaign_rpg_state_events
    FOR EACH ROW EXECUTE FUNCTION storyhold.reject_campaign_rpg_event_update();
`;

export async function ensureCampaignRpgPersistence(
  db: Pick<PGlite, "exec">,
): Promise<void> {
  await db.exec(campaignRpgPersistenceSchemaSql);
}

type StableJson = null | boolean | number | string | StableJson[] | {
  [key: string]: StableJson | undefined;
};

function stableJson(value: unknown): StableJson | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Campaign RPG persistence cannot hash a non-finite number.");
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((entry) => stableJson(entry) ?? null);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableJson(entry)]),
    );
  }
  throw new Error(`Campaign RPG persistence cannot hash ${typeof value}.`);
}

/** Stable across JSON object key order and JSONB round-trips. */
export function campaignRpgSha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableJson(value) ?? null))
    .digest("hex");
}

export type CampaignRpgPersistenceErrorCode =
  | "CAMPAIGN_NOT_FOUND"
  | "NOT_INITIALIZED"
  | "STATE_MISSING"
  | "SEED_ALREADY_LOCKED"
  | "SEED_TAMPERED"
  | "STATE_TAMPERED"
  | "EVENT_TAMPERED"
  | "STALE_STATE"
  | "DELTA_INVALID"
  | "REQUEST_ID_INVALID"
  | "REQUEST_ID_CONFLICT"
  | "STATE_VERSION_NOT_FOUND"
  | "BRANCH_TARGET_ALREADY_INITIALIZED"
  | "BRANCH_STATE_SEED_MISMATCH"
  | "BRANCH_TARGET_EQUALS_SOURCE";

export class CampaignRpgPersistenceError extends Error {
  constructor(
    readonly code: CampaignRpgPersistenceErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CampaignRpgPersistenceError";
  }
}

function fail(
  code: CampaignRpgPersistenceErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new CampaignRpgPersistenceError(code, message, cause);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function campaignId(value: unknown, path: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail("CAMPAIGN_NOT_FOUND", `${path} must be a campaign UUID.`);
  }
  return value.toLocaleLowerCase("en-US");
}

function requestId(value: unknown): string {
  if (typeof value !== "string") {
    fail("REQUEST_ID_INVALID", "RPG transition requestId must be a string.");
  }
  const result = value.normalize("NFKC").replace(/\u0000/gu, "").trim();
  if (!result || result.length > 240) {
    fail("REQUEST_ID_INVALID", "RPG transition requestId must contain 1-240 characters.");
  }
  return result;
}

function safeInteger(value: unknown): number | null {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

type SnapshotRow = {
  campaign_id: string;
  seed_id: string;
  seed: unknown;
  seed_sha256: string;
  seed_created_at: Date | string;
  state_campaign_id: string | null;
  state_seed_id: string | null;
  base_state_version: number | bigint | null;
  base_state: unknown;
  base_state_sha256: string | null;
  state_version: number | bigint | null;
  state: unknown;
  state_sha256: string | null;
  state_updated_at: Date | string | null;
};

type EventRow = {
  id: string;
  campaign_id: string;
  request_id: string;
  from_version: number | bigint;
  to_version: number | bigint;
  delta: unknown;
  delta_sha256: string;
  prior_state_sha256: string;
  next_state_sha256: string;
  result_state: unknown;
  created_at: Date | string;
};

export type PersistedCampaignRpgSnapshot = {
  readonly campaignId: string;
  readonly seed: CampaignSeed;
  readonly seedSha256: string;
  readonly baseState: CampaignRpgState;
  readonly baseStateSha256: string;
  readonly state: CampaignRpgState;
  readonly stateSha256: string;
};

export type PersistedCampaignRpgStateEvent = {
  readonly id: string;
  readonly campaignId: string;
  readonly requestId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly delta: CampaignRpgStateDelta;
  readonly deltaSha256: string;
  readonly priorStateSha256: string;
  readonly nextStateSha256: string;
  readonly resultState: CampaignRpgState;
  readonly createdAt: string;
};

function frozen<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) frozen(child);
  return Object.freeze(value);
}

function parseSeed(
  raw: unknown,
  storedSeedId: unknown,
  storedHash: unknown,
): { seed: CampaignSeed; hash: string } {
  let seed: CampaignSeed;
  try {
    seed = normalizeCampaignSeed(raw);
  } catch (error) {
    fail("SEED_TAMPERED", "The persisted campaign seed is malformed.", error);
  }
  const rawHash = campaignRpgSha256(raw);
  const normalizedHash = campaignRpgSha256(seed);
  if (
    typeof storedHash !== "string" ||
    storedHash !== rawHash ||
    storedHash !== normalizedHash ||
    storedSeedId !== seed.seedId
  ) {
    fail("SEED_TAMPERED", "The persisted campaign seed no longer matches its immutable fingerprint.");
  }
  return { seed, hash: normalizedHash };
}

function parseState(
  raw: unknown,
  storedSeedId: unknown,
  storedVersion: unknown,
  storedHash: unknown,
  seed: CampaignSeed,
): { state: CampaignRpgState; hash: string } {
  let state: CampaignRpgState;
  try {
    state = normalizeCampaignRpgState(raw);
  } catch (error) {
    fail("STATE_TAMPERED", "The persisted campaign RPG state is malformed.", error);
  }
  const version = safeInteger(storedVersion);
  const rawHash = campaignRpgSha256(raw);
  const normalizedHash = campaignRpgSha256(state);
  if (
    version === null ||
    version !== state.stateVersion ||
    typeof storedHash !== "string" ||
    storedHash !== rawHash ||
    storedHash !== normalizedHash ||
    storedSeedId !== state.seedId ||
    state.seedId !== seed.seedId
  ) {
    fail("STATE_TAMPERED", "The persisted campaign RPG state does not match its seed, version, or fingerprint.");
  }
  return { state, hash: normalizedHash };
}

function snapshotFromRow(row: SnapshotRow): PersistedCampaignRpgSnapshot {
  const parsedSeed = parseSeed(row.seed, row.seed_id, row.seed_sha256);
  if (!row.state_campaign_id) {
    fail("STATE_MISSING", "The campaign has an immutable RPG seed but no current RPG state.");
  }
  const parsedState = parseState(
    row.state,
    row.state_seed_id,
    row.state_version,
    row.state_sha256,
    parsedSeed.seed,
  );
  const parsedBaseState = parseState(
    row.base_state,
    row.state_seed_id,
    row.base_state_version,
    row.base_state_sha256,
    parsedSeed.seed,
  );
  if (parsedBaseState.state.stateVersion > parsedState.state.stateVersion) {
    fail("STATE_TAMPERED", "The campaign RPG baseline is newer than its current state.");
  }
  return frozen({
    campaignId: row.campaign_id,
    seed: parsedSeed.seed,
    seedSha256: parsedSeed.hash,
    baseState: parsedBaseState.state,
    baseStateSha256: parsedBaseState.hash,
    state: parsedState.state,
    stateSha256: parsedState.hash,
  });
}

function eventFromRow(row: EventRow, expectedSeed: CampaignSeed): PersistedCampaignRpgStateEvent {
  const fromVersion = safeInteger(row.from_version);
  const toVersion = safeInteger(row.to_version);
  let resultState: CampaignRpgState;
  try {
    resultState = normalizeCampaignRpgState(row.result_state);
  } catch (error) {
    fail("EVENT_TAMPERED", "A campaign RPG state event contains malformed result state.", error);
  }
  if (
    fromVersion === null ||
    toVersion === null ||
    toVersion !== fromVersion + 1 ||
    resultState.stateVersion !== toVersion ||
    resultState.seedId !== expectedSeed.seedId ||
    campaignRpgSha256(row.delta) !== row.delta_sha256 ||
    campaignRpgSha256(row.result_state) !== row.next_state_sha256 ||
    campaignRpgSha256(resultState) !== row.next_state_sha256
  ) {
    fail("EVENT_TAMPERED", "A campaign RPG state event failed its version or fingerprint checks.");
  }
  return frozen({
    id: row.id,
    campaignId: row.campaign_id,
    requestId: row.request_id,
    fromVersion,
    toVersion,
    delta: structuredClone(row.delta) as CampaignRpgStateDelta,
    deltaSha256: row.delta_sha256,
    priorStateSha256: row.prior_state_sha256,
    nextStateSha256: row.next_state_sha256,
    resultState,
    createdAt: new Date(row.created_at).toISOString(),
  });
}

async function campaignExists(db: CampaignRpgQueryDb, id: string): Promise<boolean> {
  return (await db.query<{ id: string }>(
    "SELECT id FROM storyhold.campaigns WHERE id = $1 LIMIT 1",
    [id],
  )).rows.length === 1;
}

async function snapshotRow(
  db: CampaignRpgQueryDb,
  id: string,
  lock: "none" | "share" | "update" = "none",
): Promise<SnapshotRow | undefined> {
  const join = lock === "none" ? "LEFT JOIN" : "JOIN";
  const suffix = lock === "update"
    ? " FOR UPDATE OF runtime"
    : lock === "share"
      ? " FOR SHARE OF runtime"
      : "";
  return (await db.query<SnapshotRow>(
    `SELECT seed.campaign_id, seed.seed_id, seed.seed, seed.seed_sha256,
            seed.created_at AS seed_created_at,
            runtime.campaign_id AS state_campaign_id,
            runtime.seed_id AS state_seed_id,
            runtime.base_state_version, runtime.base_state,
            runtime.base_state_sha256,
            runtime.state_version, runtime.state, runtime.state_sha256,
            runtime.updated_at AS state_updated_at
       FROM storyhold.campaign_rpg_seeds seed
       ${join} storyhold.campaign_rpg_states runtime
         ON runtime.campaign_id = seed.campaign_id
      WHERE seed.campaign_id = $1${suffix}`,
    [id],
  )).rows[0];
}

async function requiredSnapshot(
  db: CampaignRpgQueryDb,
  id: string,
  lock: "none" | "share" | "update" = "none",
): Promise<PersistedCampaignRpgSnapshot> {
  const row = await snapshotRow(db, id, lock);
  if (!row) {
    const seedExists = (await db.query<{ campaign_id: string }>(
      "SELECT campaign_id FROM storyhold.campaign_rpg_seeds WHERE campaign_id = $1 LIMIT 1",
      [id],
    )).rows.length === 1;
    if (seedExists) {
      fail("STATE_MISSING", "The campaign has an immutable RPG seed but no current RPG state.");
    }
    if (!await campaignExists(db, id)) fail("CAMPAIGN_NOT_FOUND", "Campaign not found.");
    fail("NOT_INITIALIZED", "Campaign RPG state has not been initialized.");
  }
  return snapshotFromRow(row);
}

export async function loadCampaignRpgSnapshot(
  db: CampaignRpgQueryDb,
  rawCampaignId: string,
): Promise<PersistedCampaignRpgSnapshot> {
  return requiredSnapshot(db, campaignId(rawCampaignId, "campaignId"));
}

export async function loadCampaignRpgSeed(
  db: CampaignRpgQueryDb,
  rawCampaignId: string,
): Promise<CampaignSeed> {
  return (await loadCampaignRpgSnapshot(db, rawCampaignId)).seed;
}

export async function loadCampaignRpgState(
  db: CampaignRpgQueryDb,
  rawCampaignId: string,
): Promise<CampaignRpgState> {
  return (await loadCampaignRpgSnapshot(db, rawCampaignId)).state;
}

export type InitializeCampaignRpgResult = PersistedCampaignRpgSnapshot & {
  readonly created: boolean;
};

/** In-transaction variant for campaign creation's larger atomic write. */
export async function initializeCampaignRpgStateInTransaction(params: {
  db: CampaignRpgQueryDb;
  campaignId: string;
  seed: CampaignSeed;
}): Promise<InitializeCampaignRpgResult> {
  const id = campaignId(params.campaignId, "campaignId");
  const seed = normalizeCampaignSeed(params.seed);
  const state = createInitialCampaignRpgState(seed);
  const seedHash = campaignRpgSha256(seed);
  const stateHash = campaignRpgSha256(state);
  const campaign = await params.db.query<{ id: string }>(
    "SELECT id FROM storyhold.campaigns WHERE id = $1 FOR UPDATE",
    [id],
  );
  if (campaign.rows.length !== 1) fail("CAMPAIGN_NOT_FOUND", "Campaign not found.");
  const existing = await snapshotRow(params.db, id);
  if (existing) {
    const snapshot = snapshotFromRow(existing);
    if (snapshot.seedSha256 !== seedHash) {
      fail("SEED_ALREADY_LOCKED", "This campaign already has a different immutable RPG seed.");
    }
    return frozen({ ...snapshot, created: false });
  }
  await params.db.query(
    `INSERT INTO storyhold.campaign_rpg_seeds
      (campaign_id, seed_id, seed, seed_sha256)
     VALUES ($1, $2, $3::jsonb, $4)`,
    [id, seed.seedId, json(seed), seedHash],
  );
  await params.db.query(
    `INSERT INTO storyhold.campaign_rpg_states
      (campaign_id, seed_id, base_state_version, base_state,
       base_state_sha256, state_version, state, state_sha256)
     VALUES ($1, $2, $3, $4::jsonb, $5, $3, $4::jsonb, $5)`,
    [id, seed.seedId, state.stateVersion, json(state), stateHash],
  );
  return frozen({
    campaignId: id,
    seed,
    seedSha256: seedHash,
    baseState: state,
    baseStateSha256: stateHash,
    state,
    stateSha256: stateHash,
    created: true,
  });
}

/** Persist a normalized seed once. Repeating the same initialization is safe. */
export async function initializeCampaignRpgState(params: {
  db: CampaignRpgRootDb;
  campaignId: string;
  seed: CampaignSeed;
}): Promise<InitializeCampaignRpgResult> {
  return params.db.transaction((tx) => initializeCampaignRpgStateInTransaction({
    ...params,
    db: tx,
  }));
}

export type CommitCampaignRpgStateDeltaResult = {
  readonly state: CampaignRpgState;
  readonly event: PersistedCampaignRpgStateEvent;
  readonly replayed: boolean;
};

/**
 * Serialize one accepted transition by locking the current projection. The
 * same request ID and payload returns the original result without a second
 * state change; reusing the ID for another payload fails closed.
 */
export async function commitCampaignRpgStateDeltaInTransaction(params: {
  db: CampaignRpgQueryDb;
  campaignId: string;
  requestId: string;
  delta: CampaignRpgStateDelta;
}): Promise<CommitCampaignRpgStateDeltaResult> {
  const id = campaignId(params.campaignId, "campaignId");
  const stableRequestId = requestId(params.requestId);
  const suppliedDeltaHash = campaignRpgSha256(params.delta);
  const snapshot = await requiredSnapshot(params.db, id, "update");
  const replayRow = (await params.db.query<EventRow>(
      `SELECT * FROM storyhold.campaign_rpg_state_events
        WHERE campaign_id = $1 AND request_id = $2 LIMIT 1`,
      [id, stableRequestId],
    )).rows[0];
  if (replayRow) {
    const event = eventFromRow(replayRow, snapshot.seed);
    if (event.deltaSha256 !== suppliedDeltaHash) {
      fail("REQUEST_ID_CONFLICT", "This RPG transition request ID was already used for a different delta.");
    }
    return frozen({ state: event.resultState, event, replayed: true });
  }

  let next: CampaignRpgState;
  try {
    next = applyCampaignRpgStateDelta(snapshot.state, params.delta);
  } catch (error) {
    if (
      error instanceof CampaignRpgValidationError &&
      error.issues.some((issue) => issue.code === "STATE_VERSION_MISMATCH")
    ) {
      fail("STALE_STATE", "The campaign changed before this RPG transition could be accepted.", error);
    }
    if (error instanceof CampaignRpgValidationError) {
      fail("DELTA_INVALID", "The proposed RPG state transition is invalid.", error);
    }
    throw error;
  }

  const nextHash = campaignRpgSha256(next);
  const eventId = randomUUID();
  await params.db.query(
      `INSERT INTO storyhold.campaign_rpg_state_events
        (id, campaign_id, request_id, from_version, to_version, delta,
         delta_sha256, prior_state_sha256, next_state_sha256, result_state)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::jsonb)`,
      [
        eventId,
        id,
        stableRequestId,
        snapshot.state.stateVersion,
        next.stateVersion,
        json(params.delta),
        suppliedDeltaHash,
        snapshot.stateSha256,
        nextHash,
        json(next),
      ],
    );
  const updated = await params.db.query<{ campaign_id: string }>(
      `UPDATE storyhold.campaign_rpg_states
          SET state_version = $3, state = $4::jsonb,
              state_sha256 = $5, updated_at = now()
        WHERE campaign_id = $1 AND state_version = $2
          AND state_sha256 = $6
        RETURNING campaign_id`,
      [
        id,
        snapshot.state.stateVersion,
        next.stateVersion,
        json(next),
        nextHash,
        snapshot.stateSha256,
      ],
    );
  if (updated.rows.length !== 1) {
    fail("STALE_STATE", "The campaign changed before this RPG transition could be saved.");
  }
  const eventRow = (await params.db.query<EventRow>(
    "SELECT * FROM storyhold.campaign_rpg_state_events WHERE id = $1",
    [eventId],
  )).rows[0];
  if (!eventRow) fail("EVENT_TAMPERED", "The saved RPG transition could not be read back.");
  return frozen({
    state: next,
    event: eventFromRow(eventRow, snapshot.seed),
    replayed: false,
  });
}

export async function commitCampaignRpgStateDelta(params: {
  db: CampaignRpgRootDb;
  campaignId: string;
  requestId: string;
  delta: CampaignRpgStateDelta;
}): Promise<CommitCampaignRpgStateDeltaResult> {
  return params.db.transaction((tx) => commitCampaignRpgStateDeltaInTransaction({
    ...params,
    db: tx,
  }));
}

export async function loadCampaignRpgStateEvents(
  db: CampaignRpgQueryDb,
  rawCampaignId: string,
): Promise<readonly PersistedCampaignRpgStateEvent[]> {
  const id = campaignId(rawCampaignId, "campaignId");
  const snapshot = await requiredSnapshot(db, id);
  const rows = (await db.query<EventRow>(
    `SELECT * FROM storyhold.campaign_rpg_state_events
      WHERE campaign_id = $1 ORDER BY to_version ASC`,
    [id],
  )).rows;
  let expectedPriorHash = snapshot.baseStateSha256;
  let expectedFrom = snapshot.baseState.stateVersion;
  const events = rows.map((row) => {
    const event = eventFromRow(row, snapshot.seed);
    if (
      event.fromVersion !== expectedFrom ||
      event.priorStateSha256 !== expectedPriorHash
    ) {
      fail("EVENT_TAMPERED", "The campaign RPG event chain is discontinuous.");
    }
    expectedFrom = event.toVersion;
    expectedPriorHash = event.nextStateSha256;
    return event;
  });
  if (
    expectedFrom !== snapshot.state.stateVersion ||
    expectedPriorHash !== snapshot.stateSha256
  ) {
    fail("STATE_TAMPERED", "Current campaign RPG state does not match the complete event chain.");
  }
  return frozen(events);
}

async function stateAtVersion(
  db: CampaignRpgQueryDb,
  snapshot: PersistedCampaignRpgSnapshot,
  version: number,
): Promise<CampaignRpgState> {
  if (!Number.isSafeInteger(version) || version < 0) {
    fail("STATE_VERSION_NOT_FOUND", "RPG state version must be a non-negative integer.");
  }
  if (version === snapshot.state.stateVersion) return snapshot.state;
  if (version === snapshot.baseState.stateVersion) return snapshot.baseState;
  if (version < snapshot.baseState.stateVersion) {
    fail(
      "STATE_VERSION_NOT_FOUND",
      `Campaign RPG state version ${version} predates this branch's baseline.`,
    );
  }
  const event = (await loadCampaignRpgStateEvents(db, snapshot.campaignId))
    .find((entry) => entry.toVersion === version);
  if (!event) fail("STATE_VERSION_NOT_FOUND", `Campaign RPG state version ${version} was not found.`);
  return event.resultState;
}

export async function loadCampaignRpgStateAtVersion(
  db: CampaignRpgQueryDb,
  rawCampaignId: string,
  version: number,
): Promise<CampaignRpgState> {
  const snapshot = await requiredSnapshot(db, campaignId(rawCampaignId, "campaignId"));
  return stateAtVersion(db, snapshot, version);
}

export type CopyCampaignRpgStateToChildResult = PersistedCampaignRpgSnapshot & {
  readonly sourceCampaignId: string;
  readonly sourceStateVersion: number;
  readonly created: boolean;
};

/**
 * Materialize a child campaign from an authentic source state version. The
 * immutable seed value is copied, while the child receives its own current row
 * and an empty future event journal.
 */
export async function copyCampaignRpgStateToChildInTransaction(params: {
  db: CampaignRpgQueryDb;
  sourceCampaignId: string;
  childCampaignId: string;
  sourceStateVersion: number;
}): Promise<CopyCampaignRpgStateToChildResult> {
  const sourceId = campaignId(params.sourceCampaignId, "sourceCampaignId");
  const childId = campaignId(params.childCampaignId, "childCampaignId");
  if (sourceId === childId) {
    fail("BRANCH_TARGET_EQUALS_SOURCE", "A branch target must be a different campaign.");
  }
  const campaignRows = await params.db.query<{ id: string }>(
    `SELECT id FROM storyhold.campaigns
      WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [[sourceId, childId]],
  );
  if (campaignRows.rows.length !== 2) fail("CAMPAIGN_NOT_FOUND", "Source or child campaign not found.");

  const source = await requiredSnapshot(params.db, sourceId, "share");
  const branchState = await stateAtVersion(
    params.db,
    source,
    params.sourceStateVersion,
  );
  if (branchState.seedId !== source.seed.seedId) {
    fail("BRANCH_STATE_SEED_MISMATCH", "The selected branch state does not belong to the source campaign seed.");
  }
  const stateHash = campaignRpgSha256(branchState);
  const existing = await snapshotRow(params.db, childId);
  if (existing) {
    const child = snapshotFromRow(existing);
    if (
      child.seedSha256 !== source.seedSha256 ||
      child.stateSha256 !== stateHash ||
      child.state.stateVersion !== params.sourceStateVersion
    ) {
      fail(
        "BRANCH_TARGET_ALREADY_INITIALIZED",
        "The child campaign already contains a different RPG seed or runtime state.",
      );
    }
    return frozen({
      ...child,
      sourceCampaignId: sourceId,
      sourceStateVersion: params.sourceStateVersion,
      created: false,
    });
  }

  await params.db.query(
    `INSERT INTO storyhold.campaign_rpg_seeds
      (campaign_id, seed_id, seed, seed_sha256)
     VALUES ($1, $2, $3::jsonb, $4)`,
    [childId, source.seed.seedId, json(source.seed), source.seedSha256],
  );
  await params.db.query(
    `INSERT INTO storyhold.campaign_rpg_states
      (campaign_id, seed_id, base_state_version, base_state,
       base_state_sha256, state_version, state, state_sha256)
     VALUES ($1, $2, $3, $4::jsonb, $5, $3, $4::jsonb, $5)`,
    [childId, source.seed.seedId, branchState.stateVersion, json(branchState), stateHash],
  );
  return frozen({
    campaignId: childId,
    seed: source.seed,
    seedSha256: source.seedSha256,
    baseState: branchState,
    baseStateSha256: stateHash,
    state: branchState,
    stateSha256: stateHash,
    sourceCampaignId: sourceId,
    sourceStateVersion: params.sourceStateVersion,
    created: true,
  });
}

export async function copyCampaignRpgStateToChild(params: {
  db: CampaignRpgRootDb;
  sourceCampaignId: string;
  childCampaignId: string;
  sourceStateVersion: number;
}): Promise<CopyCampaignRpgStateToChildResult> {
  return params.db.transaction((tx) => copyCampaignRpgStateToChildInTransaction({
    ...params,
    db: tx,
  }));
}

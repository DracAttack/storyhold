import { createHash } from "node:crypto";

/** This adapter is deliberately unavailable in a deployed production process. */
export function manualStorytellerEnabled(
  role: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment.NODE_ENV !== "production" &&
    environment.REPLIT_DEPLOYMENT !== "1" && environment.REPLIT_DEPLOYMENT !== "true" &&
    environment.STORYHOLD_MANUAL_STORYTELLER === "true" &&
    (role === "owner" || role === "admin");
}

export const manualStorytellerSchemaSql = String.raw`
  CREATE TABLE IF NOT EXISTS storyhold.manual_storyteller_turns (
    id uuid PRIMARY KEY,
    campaign_id uuid NOT NULL REFERENCES storyhold.campaigns(id) ON DELETE CASCADE,
    player_id uuid NOT NULL REFERENCES storyhold.players(id) ON DELETE CASCADE,
    turn_request_id uuid NOT NULL REFERENCES storyhold.campaign_turn_requests(id) ON DELETE CASCADE,
    request_id text NOT NULL,
    expected_state_version integer NOT NULL,
    player_input text NOT NULL,
    intent_kind text NOT NULL,
    input_sha256 text NOT NULL,
    frozen_input jsonb NOT NULL,
    director_request jsonb NOT NULL,
    direction jsonb,
    narrator_request jsonb,
    status text NOT NULL DEFAULT 'awaiting_direction'
      CHECK (status IN ('awaiting_direction', 'awaiting_narration', 'completed', 'stale')),
    last_error text NOT NULL DEFAULT '',
    turn_id uuid REFERENCES storyhold.campaign_turns(id) ON DELETE SET NULL,
    completed_response_sha256 text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (campaign_id, request_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS manual_storyteller_one_pending_campaign
    ON storyhold.manual_storyteller_turns(campaign_id)
    WHERE status IN ('awaiting_direction', 'awaiting_narration');
  CREATE TABLE IF NOT EXISTS storyhold.manual_storyteller_attempts (
    id uuid PRIMARY KEY,
    manual_turn_id uuid NOT NULL REFERENCES storyhold.manual_storyteller_turns(id) ON DELETE CASCADE,
    operator_player_id uuid NOT NULL REFERENCES storyhold.players(id) ON DELETE CASCADE,
    stage text NOT NULL CHECK (stage IN ('direction', 'narration')),
    response jsonb NOT NULL,
    accepted boolean NOT NULL,
    error text NOT NULL DEFAULT '',
    notes text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
  );
  -- Corrections to local manual tests are an append-only presentation overlay.
  -- They cannot change a committed turn, its causality, or its model receipt.
  CREATE TABLE IF NOT EXISTS storyhold.manual_storyteller_narration_revisions (
    id uuid PRIMARY KEY,
    manual_turn_id uuid NOT NULL REFERENCES storyhold.manual_storyteller_turns(id) ON DELETE CASCADE,
    turn_id uuid NOT NULL REFERENCES storyhold.campaign_turns(id) ON DELETE CASCADE,
    operator_player_id uuid NOT NULL REFERENCES storyhold.players(id) ON DELETE CASCADE,
    prior_response_sha256 text NOT NULL,
    narration text NOT NULL,
    notes text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS manual_storyteller_narration_revisions_turn
    ON storyhold.manual_storyteller_narration_revisions(turn_id, created_at DESC);
`;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function manualStorytellerSha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function assertManualStorytellerInput(row: Record<string, unknown>, suppliedHash: unknown) {
  if (typeof suppliedHash !== "string" || suppliedHash !== row.input_sha256 ||
    manualStorytellerSha256(row.frozen_input) !== row.input_sha256) {
    throw new Error("MANUAL_STORYTELLER_INPUT_CHANGED");
  }
}

export function serializeManualStorytellerTurn(row: Record<string, unknown>) {
  return {
    id: String(row.id), campaignId: String(row.campaign_id),
    requestId: String(row.request_id), status: String(row.status),
    createdAt: row.created_at, updatedAt: row.updated_at,
    error: String(row.last_error ?? ""), turnId: row.turn_id ?? null,
  };
}

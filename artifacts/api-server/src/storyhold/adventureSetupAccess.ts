import type { PGlite } from "@electric-sql/pglite";
import type { AdventureSetupPlan } from "./adventureSetup";
import { manualStorytellerSha256 } from "./manualStoryteller";

export type AdventureSetupRow = Record<string, unknown>;
export const activeAdventureSetups = new Set<string>();

export function requiresAdventureSetup(campaign: Record<string, unknown>): boolean {
  const start = campaign.start_contract as Record<string, unknown> | null;
  const seed = start?.rpgSeed as Record<string, unknown> | undefined;
  return campaign.world_creation_mode === "quickstart" && seed?.origin !== "imported";
}

export async function loadAdventureSetup(db: Pick<PGlite, "query">, campaign: Record<string, unknown>) {
  if (!requiresAdventureSetup(campaign)) return null;
  const rows = await db.query<AdventureSetupRow>(
    "SELECT * FROM storyhold.campaign_adventure_setups WHERE campaign_id = $1",
    [campaign.id],
  );
  const row = rows.rows[0] ?? null;
  if (row?.status === "ready" && manualStorytellerSha256(row.plan) !== row.plan_sha256) {
    throw new Error("ADVENTURE_SETUP_PLAN_CHANGED");
  }
  return row;
}

/** The player never receives the private plan, prompt, cast list, or diagnostics. */
export function publicAdventureSetup(campaign: Record<string, unknown>, row: AdventureSetupRow | null | undefined) {
  const required = requiresAdventureSetup(campaign);
  const status = !required ? "not_required" : !row ? "required"
    : row.status === "generating" && !activeAdventureSetups.has(String(row.campaign_id)) ? "failed"
    : String(row.status);
  return {
    required,
    status: status as "not_required" | "required" | "awaiting_response" | "generating" | "ready" | "failed",
    opening: status === "ready" ? (row?.plan as AdventureSetupPlan)?.publicOpening || null : null,
  };
}

/** Frozen in manual turn packets. Initial plans are subordinate to later committed reality. */
export function privateAdventureSetupContext(row: AdventureSetupRow | null | undefined) {
  if (row?.status !== "ready") return null;
  return {
    setupId: String(row.id), establishedAtStateVersion: Number(row.applied_state_version),
    boundary: "Private initial adventure state, not player knowledge. Current committed facts, revealed knowledge, completed objectives, and matured clocks supersede initial intentions. Goal steps and alternate paths are contingent opportunities, never destined events. Unmet NPCs remain offstage until causally introduced. Clue opportunities are not discoveries. Let choices change motives and plans; never force the initial goal sequence or deliver the premise immediately.",
    plan: row.plan as AdventureSetupPlan,
  };
}

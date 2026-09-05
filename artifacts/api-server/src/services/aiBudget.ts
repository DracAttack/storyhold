import { db, aiUsageEventsTable } from "@workspace/db";
import { gte, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

/**
 * Cost guardrails for the heavy, unattended bulk AI jobs (daily pipeline, trend
 * scan, source/internal-link backfills). These loops can fan out into dozens of
 * billable model calls; a runaway (bad cron, stuck retry, someone kicking off a
 * huge backfill) could quietly burn real money. This module gives those jobs a
 * cheap way to (a) be disabled entirely via env and (b) abort mid-run once a
 * per-run or rolling daily USD ceiling is crossed.
 *
 * Spend is read from the same `ai_usage_events` meter that powers the cost
 * dashboard, so the ceilings reflect actual recorded USD. Because usage is
 * recorded fire-and-forget (a short async lag after each call), the guard is
 * intentionally coarse — it stops the NEXT unit of work once the ceiling is
 * already exceeded, rather than pre-authorizing each call to the cent.
 */

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Calendar-UTC-day USD ceiling across ALL recorded AI spend. */
export const DAILY_BUDGET_USD = envNumber("AI_DAILY_BUDGET_USD", 25);
/** Per-run USD ceiling for a single bulk job invocation. */
export const BULK_RUN_BUDGET_USD = envNumber("AI_BULK_RUN_BUDGET_USD", 5);

/**
 * Whether the unattended bulk AI jobs are allowed to run at all. Defaults to
 * ON; set `AI_BULK_JOBS_ENABLED=false` (or `0`) to hard-disable every bulk loop
 * (pipeline drafting, trend scan, link backfills) without touching code — an
 * emergency cost brake. Manual, single-item admin actions are unaffected.
 */
export function isBulkJobsEnabled(): boolean {
  const raw = process.env.AI_BULK_JOBS_ENABLED;
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return !(v === "false" || v === "0" || v === "no" || v === "off");
}

/** Start of the current UTC calendar day. */
function startOfUtcDay(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Total recorded AI spend (USD) since the start of the current UTC day. Reads
 * the cost meter; a raw SQL SUM comes back as a string, so it is coerced to a
 * number. Never throws — on a query failure it logs and returns 0 so a metering
 * hiccup can't wedge the pipeline (fail-open on read, the per-run cap still
 * bounds a single invocation).
 */
export async function getTodaySpendUsd(now: Date = new Date()): Promise<number> {
  try {
    const [row] = await db
      .select({ cost: sql<string>`COALESCE(SUM(${aiUsageEventsTable.costUsd}), 0)` })
      .from(aiUsageEventsTable)
      .where(gte(aiUsageEventsTable.createdAt, startOfUtcDay(now)));
    return Number(row?.cost ?? 0);
  } catch (err) {
    logger.warn({ err }, "aiBudget: failed to read today's spend; treating as 0");
    return 0;
  }
}

/** Thrown when a bulk job is stopped by the budget guard. */
export class BudgetExceededError extends Error {
  constructor(
    public readonly reason: "bulk_disabled" | "daily_cap" | "run_cap",
    message: string,
  ) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

/**
 * A coarse spend guard for one bulk-job invocation. Create it at the top of a
 * job; call `check()` before each expensive unit of work (per beat, per author,
 * per article). It aborts the loop by throwing `BudgetExceededError` when:
 *   - bulk jobs are disabled via env, or
 *   - total spend this UTC day has crossed the daily ceiling, or
 *   - spend accrued SINCE this guard was created has crossed the per-run ceiling.
 *
 * Callers should catch `BudgetExceededError` at the job boundary and finish the
 * run cleanly (record what was done so far) rather than surfacing a 500.
 */
export class BudgetGuard {
  private readonly startSpend: number;
  private readonly startedAt: Date;

  private constructor(
    public readonly label: string,
    startSpend: number,
    startedAt: Date,
  ) {
    this.startSpend = startSpend;
    this.startedAt = startedAt;
  }

  /**
   * Build a guard, enforcing the "may I even start?" checks up front: bulk jobs
   * must be enabled and the day's spend must be under the daily ceiling.
   */
  static async start(label: string, now: Date = new Date()): Promise<BudgetGuard> {
    if (!isBulkJobsEnabled()) {
      throw new BudgetExceededError(
        "bulk_disabled",
        `Bulk AI jobs are disabled (AI_BULK_JOBS_ENABLED); skipping ${label}.`,
      );
    }
    const spend = await getTodaySpendUsd(now);
    if (spend >= DAILY_BUDGET_USD) {
      throw new BudgetExceededError(
        "daily_cap",
        `Daily AI budget reached ($${spend.toFixed(2)} ≥ $${DAILY_BUDGET_USD}); skipping ${label}.`,
      );
    }
    return new BudgetGuard(label, spend, now);
  }

  /**
   * Re-check the ceilings before the next unit of work. Throws
   * `BudgetExceededError` when the daily or per-run cap is crossed. Cheap enough
   * to call once per loop iteration (one indexed SUM query).
   */
  async check(now: Date = new Date()): Promise<void> {
    if (!isBulkJobsEnabled()) {
      throw new BudgetExceededError(
        "bulk_disabled",
        `Bulk AI jobs were disabled mid-run; stopping ${this.label}.`,
      );
    }
    const spend = await getTodaySpendUsd(now);
    if (spend >= DAILY_BUDGET_USD) {
      throw new BudgetExceededError(
        "daily_cap",
        `Daily AI budget reached ($${spend.toFixed(2)} ≥ $${DAILY_BUDGET_USD}); stopping ${this.label}.`,
      );
    }
    const runSpend = spend - this.startSpend;
    if (runSpend >= BULK_RUN_BUDGET_USD) {
      throw new BudgetExceededError(
        "run_cap",
        `Per-run AI budget reached ($${runSpend.toFixed(2)} ≥ $${BULK_RUN_BUDGET_USD}) for ${this.label}; stopping.`,
      );
    }
  }
}

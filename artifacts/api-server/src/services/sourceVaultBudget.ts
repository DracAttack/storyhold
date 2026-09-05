import { db, aiUsageEventsTable } from "@workspace/db";
import { and, gte, inArray, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

// --- Source Vault budget / kill-switch (Phase 0) -------------------------
// The vault's ingest loop can fan out into many Perplexity embed calls (one per
// chunk, per source) plus search calls. This is a small, cheap guardrail —
// independent of the article-pipeline aiBudget — so a runaway vault run (e.g. a
// huge batch of sources) can be (a) hard-disabled via env and (b) aborted once a
// per-run or rolling daily USD ceiling for VAULT spend is crossed.
//
// Spend is read from the shared ai_usage_events meter, filtered to the vault's
// own operations, so the ceilings reflect actual recorded Perplexity USD.

const VAULT_OPERATIONS = [
  "sourceVaultSearch",
  "sourceVaultEmbed",
  "sourceVaultResearch",
  "claimExtraction",
  "claimReconciliation",
] as const;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Calendar-UTC-day USD ceiling for Source Vault spend. */
export const VAULT_DAILY_BUDGET_USD = envNumber("SOURCE_VAULT_DAILY_BUDGET_USD", 5);
/** Per-run USD ceiling for a single vault ingest/search invocation. */
export const VAULT_RUN_BUDGET_USD = envNumber("SOURCE_VAULT_RUN_BUDGET_USD", 1);

/**
 * Whether the Source Vault is allowed to perform paid work at all. Defaults ON;
 * set `SOURCE_VAULT_ENABLED=false` (or `0`) to hard-disable ingest/search/embed
 * without touching code. Read-only inspection (listing docs, viewing chunks) is
 * unaffected — only the paid Perplexity paths gate on this.
 */
export function isSourceVaultEnabled(): boolean {
  const raw = process.env.SOURCE_VAULT_ENABLED;
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return !(v === "false" || v === "0" || v === "no" || v === "off");
}

function startOfUtcDay(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Total recorded Source Vault spend (USD) since the start of the current UTC
 * day. Never throws — a metering hiccup returns 0 (fail-open on read; the
 * per-run cap still bounds a single invocation).
 */
export async function getTodayVaultSpendUsd(now: Date = new Date()): Promise<number> {
  try {
    const [row] = await db
      .select({ cost: sql<string>`COALESCE(SUM(${aiUsageEventsTable.costUsd}), 0)` })
      .from(aiUsageEventsTable)
      .where(
        and(
          gte(aiUsageEventsTable.createdAt, startOfUtcDay(now)),
          inArray(aiUsageEventsTable.operation, [...VAULT_OPERATIONS]),
        ),
      );
    return Number(row?.cost ?? 0);
  } catch (err) {
    logger.warn({ err }, "sourceVaultBudget: failed to read today's spend; treating as 0");
    return 0;
  }
}

/** Thrown when a vault job is stopped by the budget guard. */
export class VaultBudgetExceededError extends Error {
  constructor(
    public readonly reason: "disabled" | "daily_cap" | "run_cap",
    message: string,
  ) {
    super(message);
    this.name = "VaultBudgetExceededError";
  }
}

/**
 * A coarse spend guard for one vault invocation. Create it at the top of an
 * ingest/search job; call `check()` before each expensive unit (per source, per
 * embed batch). Aborts by throwing VaultBudgetExceededError when the vault is
 * disabled, or the daily / per-run USD ceiling is crossed. Callers catch it at
 * the job boundary and finish cleanly (record what was done so far).
 */
export class VaultBudgetGuard {
  private constructor(
    public readonly label: string,
    private readonly startSpend: number,
    private readonly paid: boolean,
  ) {}

  /**
   * Start a guard for one vault invocation. `paid` (default true) says whether
   * this invocation actually spends money: paid work enforces both the
   * kill-switch AND the USD ceilings; free work (e.g. local embeddings) enforces
   * ONLY the kill-switch, so a free path is never blocked by budget crossed by
   * unrelated paid spend. The `SOURCE_VAULT_ENABLED` kill-switch always applies.
   */
  static async start(
    label: string,
    opts: { paid?: boolean; now?: Date } = {},
  ): Promise<VaultBudgetGuard> {
    const paid = opts.paid ?? true;
    const now = opts.now ?? new Date();
    if (!isSourceVaultEnabled()) {
      throw new VaultBudgetExceededError(
        "disabled",
        `Source Vault is disabled (SOURCE_VAULT_ENABLED); skipping ${label}.`,
      );
    }
    const spend = await getTodayVaultSpendUsd(now);
    if (paid && spend >= VAULT_DAILY_BUDGET_USD) {
      throw new VaultBudgetExceededError(
        "daily_cap",
        `Daily Source Vault budget reached ($${spend.toFixed(2)} ≥ $${VAULT_DAILY_BUDGET_USD}); skipping ${label}.`,
      );
    }
    return new VaultBudgetGuard(label, spend, paid);
  }

  async check(now: Date = new Date()): Promise<void> {
    if (!isSourceVaultEnabled()) {
      throw new VaultBudgetExceededError(
        "disabled",
        `Source Vault was disabled mid-run; stopping ${this.label}.`,
      );
    }
    if (!this.paid) return; // free path: only the kill-switch gates it.
    const spend = await getTodayVaultSpendUsd(now);
    if (spend >= VAULT_DAILY_BUDGET_USD) {
      throw new VaultBudgetExceededError(
        "daily_cap",
        `Daily Source Vault budget reached ($${spend.toFixed(2)} ≥ $${VAULT_DAILY_BUDGET_USD}); stopping ${this.label}.`,
      );
    }
    const runSpend = spend - this.startSpend;
    if (runSpend >= VAULT_RUN_BUDGET_USD) {
      throw new VaultBudgetExceededError(
        "run_cap",
        `Per-run Source Vault budget reached ($${runSpend.toFixed(2)} ≥ $${VAULT_RUN_BUDGET_USD}) for ${this.label}; stopping.`,
      );
    }
  }
}

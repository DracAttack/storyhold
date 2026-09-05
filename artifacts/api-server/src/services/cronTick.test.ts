import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { claimJobPeriod } from "./cronClaim";

// Safety regression for the autoscale duplicate-prevention guarantee. Scheduled
// work (daily pipeline, weekly newsletter, dedup scan, maintenance) is triggered
// by an external ping to GET /api/cron/tick and made idempotent across instances
// by a per-period "claim" in the cron_job_runs table. claimJobPeriod(job,
// periodKey) (in ./cronClaim, re-exported by ./cronTick) must return true
// exactly once per (job, period), even when two instances race the same ping.
// Runs against the dev/test Postgres pointed to by DATABASE_URL.

// Use throwaway job names (cron_job_runs.job is the PRIMARY KEY) so we never
// clobber the real job rows used in production.
const JOB_SEQUENTIAL = "zz-test-claim-sequential";
const JOB_CONCURRENT = "zz-test-claim-concurrent";

async function cleanup(): Promise<void> {
  await db.execute(
    sql`DELETE FROM "cron_job_runs" WHERE "job" IN (${JOB_SEQUENTIAL}, ${JOB_CONCURRENT})`,
  );
}

before(async () => {
  // The table is created at boot by ensureRuntimeTables, but the test runner may
  // execute before any server boot, so create it idempotently here too.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "cron_job_runs" (
      "job" text PRIMARY KEY,
      "period_key" text NOT NULL,
      "ran_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await cleanup();
});

after(async () => {
  await cleanup();
});

test("first claim for a (job, period) returns true, repeat returns false", async () => {
  const period = "period-A";

  // First claim in this period wins.
  assert.equal(await claimJobPeriod(JOB_SEQUENTIAL, period), true, "first claim must win");

  // Any later ping in the same period is a no-op (already claimed).
  assert.equal(
    await claimJobPeriod(JOB_SEQUENTIAL, period),
    false,
    "second claim in same period must lose",
  );
  assert.equal(
    await claimJobPeriod(JOB_SEQUENTIAL, period),
    false,
    "third claim in same period must lose",
  );
});

test("a claim for a new period returns true again", async () => {
  // Advancing to the next period unlocks exactly one new run.
  assert.equal(
    await claimJobPeriod(JOB_SEQUENTIAL, "period-B"),
    true,
    "new period must win once",
  );
  assert.equal(
    await claimJobPeriod(JOB_SEQUENTIAL, "period-B"),
    false,
    "repeat of new period must lose",
  );
});

test("two near-simultaneous claims for the same period: exactly one wins", async () => {
  const period = "race-period";

  // Fire many claims concurrently to simulate multiple instances racing the
  // same ping. The ON CONFLICT row lock must serialize them so only the
  // instance that actually changes the period_key gets a row back.
  const results = await Promise.all(
    Array.from({ length: 16 }, () => claimJobPeriod(JOB_CONCURRENT, period)),
  );

  const winners = results.filter(Boolean).length;
  assert.equal(winners, 1, "exactly one concurrent claim may win");
});

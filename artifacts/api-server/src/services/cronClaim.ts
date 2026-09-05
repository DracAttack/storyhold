import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * Atomically claim a job for a given period. Returns true exactly once per
 * (job, periodKey) across ALL instances: the upsert only updates (and returns a
 * row) when the stored period_key differs from the new one, and the row lock
 * taken by ON CONFLICT serializes concurrent instances so only the first one to
 * change the period sees the change. A later ping in the same period — or a
 * second instance racing the same ping — gets no row back and skips the job.
 *
 * Kept in its own module (no logger / heavy service imports) so it can be
 * unit-tested without dragging pino's worker-thread transport into the test
 * bundle.
 */
export async function claimJobPeriod(job: string, periodKey: string): Promise<boolean> {
  // Ordering guard: period keys are fixed-width, zero-padded UTC buckets
  // (e.g. "pipeline:2026-07-09T13"), so lexicographic comparison equals
  // chronological comparison. Requiring the stored key to sort BEFORE the new
  // one (not merely differ) means a delayed or replayed tick carrying an
  // older period can never re-claim a job that already advanced.
  const res = await db.execute(sql`
    INSERT INTO "cron_job_runs" ("job", "period_key")
    VALUES (${job}, ${periodKey})
    ON CONFLICT ("job") DO UPDATE
      SET "period_key" = EXCLUDED."period_key", "ran_at" = now()
      WHERE "cron_job_runs"."period_key" < EXCLUDED."period_key"
    RETURNING "job"
  `);
  return res.rows.length > 0;
}

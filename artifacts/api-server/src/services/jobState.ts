import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

/**
 * DB-backed long-running job state + lock. Replaces the in-memory boolean guards
 * and progress counters that heavy background jobs used (content pipeline,
 * weekly newsletter, trend scan, social-pack backfill). In-memory state is lost
 * on restart and invisible to other instances; on autoscale that means a job can
 * appear stuck after a deploy, double-run across instances, or have its progress
 * hidden from the admin poller served by a different instance.
 *
 * The `background_jobs` table (created in services/seed.ts ensureRuntimeTables)
 * holds one row per job key: a run-ownership token (`run_id`), status,
 * started/heartbeat/finished timestamps, a free-form progress JSONB, an error
 * string, and a cancel flag.
 *
 * Fencing: `acquireJobLock` mints a fresh `runId` and returns it (or null if the
 * lock is held by a live run). Every heartbeat/finish update is guarded on that
 * `runId`, so if a run is declared stale (heartbeat older than TTL) and a NEW
 * run takes the lock over, a late write from the OLD run is a no-op — it can't
 * clobber the new run's state or prematurely flip status. Callers MUST thread
 * the returned runId into heartbeatJob/finishJob.
 *
 * Kept logger-free and free of heavy service imports so it stays cheap to test.
 */

export type JobStatus = "idle" | "running" | "succeeded" | "failed";

export interface JobStateRow {
  job: string;
  runId: string | null;
  status: JobStatus;
  startedAt: string | null;
  heartbeatAt: string | null;
  finishedAt: string | null;
  progress: Record<string, unknown> | null;
  error: string | null;
  cancelRequested: boolean;
  updatedAt: string;
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value as string).toISOString();
}

function mapRow(row: Record<string, unknown>): JobStateRow {
  return {
    job: String(row.job),
    runId: (row.run_id as string | null) ?? null,
    status: row.status as JobStatus,
    startedAt: toIso(row.started_at),
    heartbeatAt: toIso(row.heartbeat_at),
    finishedAt: toIso(row.finished_at),
    progress: (row.progress as Record<string, unknown> | null) ?? null,
    error: (row.error as string | null) ?? null,
    cancelRequested: row.cancel_requested === true,
    updatedAt: toIso(row.updated_at) ?? new Date().toISOString(),
  };
}

/**
 * Atomically acquire the long-running lock for `job`. Returns a fresh `runId`
 * string exactly when this caller wins the lock: the row is claimed only if no
 * run is currently marked running, OR the previous runner's heartbeat is older
 * than `ttlMs` (treated as crashed and taken over). A live concurrent run (its
 * own heartbeat fresh) blocks acquisition, so a second instance — or the next
 * cron period firing while the first run is still going — gets `null` and skips.
 * The row lock taken by ON CONFLICT serializes racing instances. On success the
 * progress is reset to `opts.progress` (or {}) and the cancel flag is cleared.
 * Thread the returned runId into heartbeatJob/finishJob so a late write from a
 * superseded run can't clobber the winner.
 */
export async function acquireJobLock(
  job: string,
  opts: { ttlMs: number; progress?: Record<string, unknown> },
): Promise<string | null> {
  const runId = randomUUID();
  const progress = JSON.stringify(opts.progress ?? {});
  const ttlSeconds = Math.max(1, Math.ceil(opts.ttlMs / 1000));
  const res = await db.execute(sql`
    INSERT INTO "background_jobs"
      ("job", "run_id", "status", "started_at", "heartbeat_at", "finished_at", "progress", "error", "cancel_requested", "updated_at")
    VALUES (${job}, ${runId}, 'running', now(), now(), NULL, ${progress}::jsonb, NULL, false, now())
    ON CONFLICT ("job") DO UPDATE
      SET "run_id" = EXCLUDED."run_id",
          "status" = 'running',
          "started_at" = now(),
          "heartbeat_at" = now(),
          "finished_at" = NULL,
          "progress" = EXCLUDED."progress",
          "error" = NULL,
          "cancel_requested" = false,
          "updated_at" = now()
      WHERE "background_jobs"."status" <> 'running'
         OR "background_jobs"."heartbeat_at" < now() - (${ttlSeconds} || ' seconds')::interval
    RETURNING "run_id"
  `);
  return res.rows.length > 0 ? runId : null;
}

/**
 * Refresh the heartbeat (and optionally the progress snapshot) of a run. Guarded
 * on runId, so a superseded (stale-taken-over) runner's heartbeat is a no-op.
 */
export async function heartbeatJob(
  job: string,
  runId: string,
  progress?: Record<string, unknown>,
): Promise<void> {
  if (progress === undefined) {
    await db.execute(
      sql`UPDATE "background_jobs" SET "heartbeat_at" = now(), "updated_at" = now() WHERE "job" = ${job} AND "run_id" = ${runId}`,
    );
    return;
  }
  await db.execute(sql`
    UPDATE "background_jobs"
    SET "heartbeat_at" = now(), "progress" = ${JSON.stringify(progress)}::jsonb, "updated_at" = now()
    WHERE "job" = ${job} AND "run_id" = ${runId}
  `);
}

/**
 * Mark a run finished (succeeded/failed), persisting final progress + error.
 * Guarded on runId so a superseded run can't flip the winner's status.
 */
export async function finishJob(
  job: string,
  runId: string,
  status: Exclude<JobStatus, "idle" | "running">,
  opts: { progress?: Record<string, unknown>; error?: string } = {},
): Promise<void> {
  if (opts.progress === undefined) {
    await db.execute(sql`
      UPDATE "background_jobs"
      SET "status" = ${status}, "finished_at" = now(), "heartbeat_at" = now(),
          "error" = ${opts.error ?? null}, "updated_at" = now()
      WHERE "job" = ${job} AND "run_id" = ${runId}
    `);
    return;
  }
  await db.execute(sql`
    UPDATE "background_jobs"
    SET "status" = ${status}, "finished_at" = now(), "heartbeat_at" = now(),
        "progress" = ${JSON.stringify(opts.progress)}::jsonb,
        "error" = ${opts.error ?? null}, "updated_at" = now()
    WHERE "job" = ${job} AND "run_id" = ${runId}
  `);
}

/** Request cooperative cancellation of the currently-running job (cross-instance). */
export async function requestJobCancel(job: string): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE "background_jobs"
    SET "cancel_requested" = true, "updated_at" = now()
    WHERE "job" = ${job} AND "status" = 'running'
    RETURNING "job"
  `);
  return res.rows.length > 0;
}

/**
 * Force-release a stuck job by marking it failed regardless of runId.
 * Use only when the heartbeat has gone stale and the TTL takeover isn't
 * fast enough (e.g. the user wants to reset immediately from the UI).
 * Returns true if a row was updated (i.e. there was a running job to clear).
 */
export async function forceReleaseJob(
  job: string,
  reason = "force-released by admin",
): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE "background_jobs"
    SET "status" = 'failed',
        "error" = ${reason},
        "finished_at" = now(),
        "cancel_requested" = false,
        "updated_at" = now()
    WHERE "job" = ${job} AND "status" = 'running'
    RETURNING "job"
  `);
  return res.rows.length > 0;
}

/** True if cancellation has been requested for the running job. */
export async function isCancelRequested(job: string): Promise<boolean> {
  const res = await db.execute(
    sql`SELECT "cancel_requested" FROM "background_jobs" WHERE "job" = ${job} LIMIT 1`,
  );
  return res.rows[0]?.cancel_requested === true;
}

/** Read the current/last state of a job, or null if it has never run. */
export async function getJobState(job: string): Promise<JobStateRow | null> {
  const res = await db.execute(
    sql`SELECT * FROM "background_jobs" WHERE "job" = ${job} LIMIT 1`,
  );
  const row = res.rows[0];
  return row ? mapRow(row as Record<string, unknown>) : null;
}

// Pure staleness helper lives in its own dependency-free module so it can be
// unit-tested without bundling the DB/logger. Re-exported here because it is
// part of the job-state API surface.
export { isJobRunning } from "./jobStaleness";

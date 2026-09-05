/**
 * Pure staleness helper for DB-backed background jobs. Deliberately free of any
 * db/logger imports so it can be unit-tested without bundling the whole service
 * (pg, pino, etc.) into the test.
 */

/**
 * Whether a job row represents a genuinely LIVE run: status "running" AND a
 * heartbeat newer than `ttlMs`. A stale (or missing) heartbeat means the worker
 * crashed without finalizing the row — the fire-and-forget worker died on an
 * autoscale scale-down or a mid-run deploy. acquireJobLock() already treats such
 * a lock as takeable, so any reader that gates UI on "running" MUST agree:
 * otherwise the UI shows the job running forever and disables the control that
 * would trigger the takeover, deadlocking the operator. `now` is injectable for
 * tests.
 */
export function isJobRunning(
  row: { status: string; heartbeatAt: string | null } | null,
  ttlMs: number,
  now: number = Date.now(),
): boolean {
  if (!row || row.status !== "running") return false;
  const heartbeatMs = row.heartbeatAt ? new Date(row.heartbeatAt).getTime() : 0;
  return now - heartbeatMs <= ttlMs;
}

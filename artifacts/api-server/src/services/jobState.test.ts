import { test } from "node:test";
import assert from "node:assert/strict";
import { isJobRunning } from "./jobStaleness";

// =============================================================================
// Regression lock for the "stuck Trend Radar scan" deadlock.
//
// getTrendScanJob() gates the admin Scan button on `running`. A scan worker is
// fire-and-forget, so it can die mid-run (autoscale scale-down / a mid-scan
// deploy) leaving the background_jobs row at status="running" with a frozen
// heartbeat FOREVER. Before this fix the reader reported such a row as running,
// so the UI showed "Scanning…" permanently and disabled the button — and since
// starting a new scan is the ONLY thing that takes the stale lock over
// (acquireJobLock), the operator was deadlocked.
//
// isJobRunning() encodes the fix: a run is live only while its heartbeat is
// newer than the takeover TTL, matching acquireJobLock's staleness rule.
// =============================================================================

const TTL_MS = 15 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 5, 12, 0, 0);
const heartbeat = (msAgo: number) => new Date(NOW - msAgo).toISOString();

test("fresh heartbeat on a running row => live", () => {
  assert.equal(isJobRunning({ status: "running", heartbeatAt: heartbeat(60_000) }, TTL_MS, NOW), true);
});

test("heartbeat older than the TTL => not live (crashed worker)", () => {
  assert.equal(
    isJobRunning({ status: "running", heartbeatAt: heartbeat(TTL_MS + 60_000) }, TTL_MS, NOW),
    false,
  );
});

test("the actual stuck-scan case: a 3-day-old running row => not live", () => {
  assert.equal(
    isJobRunning({ status: "running", heartbeatAt: heartbeat(3 * 24 * 60 * 60 * 1000) }, TTL_MS, NOW),
    false,
  );
});

test("a running row with a null heartbeat => not live (treated as infinitely stale)", () => {
  assert.equal(isJobRunning({ status: "running", heartbeatAt: null }, TTL_MS, NOW), false);
});

test("non-running statuses are never live regardless of heartbeat", () => {
  for (const status of ["succeeded", "failed", "idle", "cancelled"]) {
    assert.equal(isJobRunning({ status, heartbeatAt: heartbeat(1000) }, TTL_MS, NOW), false, status);
  }
});

test("a null row (job never ran) => not live", () => {
  assert.equal(isJobRunning(null, TTL_MS, NOW), false);
});

test("exactly at the TTL boundary is still live (inclusive)", () => {
  assert.equal(isJobRunning({ status: "running", heartbeatAt: heartbeat(TTL_MS) }, TTL_MS, NOW), true);
});

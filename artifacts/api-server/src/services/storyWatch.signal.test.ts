import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import {
  db,
  storyClustersTable,
  storyUpdateSignalsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  markSignalRetried,
  MAX_SIGNAL_RETRIES,
} from "./developmentSignalDetector";
import { listWatchedClusters } from "./storyWatch";
import trendsRouter from "../routes/admin/trends";

// =============================================================================
// End-to-end regression for the signal exhaustion + reset flow (Task #389).
//
// Three invariants are locked here:
//
//   1. markSignalRetried exhausts a signal exactly at MAX_SIGNAL_RETRIES:
//      a row at retryCount = (MAX_SIGNAL_RETRIES - 1) flips to status =
//      "exhausted" on the next failed attempt.
//
//   2. POST /admin/trends/clusters/:id/signal/reset returns 200 and resets the
//      row back to status = "pending" / retryCount = 0 / consumedAt = null,
//      even from an exhausted state — so an editor forced retry can always
//      unblock a stuck cluster.
//
//   3. listWatchedClusters projects the joined signal row's status, retryCount,
//      and trackType onto every WatchedCluster result, so editors can see the
//      signal state directly in the watch list without a separate query.
//
// All tests use throwaway rows (zz-test- prefixed / tracked UUIDs) and are
// cleaned up in after() so real data is never touched. storyUpdateSignalsTable
// has no FK constraint on cluster_id, so tests 1 and 2 use phantom cluster UUIDs
// and never need a real story_clusters row. Test 3 inserts a real cluster to
// satisfy the WHERE watched = true join path in listWatchedClusters.
//
// Runs against the dev/test Postgres pointed to by DATABASE_URL.
// =============================================================================

const BEAT = "zz-signal-test-beat";
const BEAT_LABEL = "ZZ Signal Exhaustion Test";

// Track inserted IDs so cleanup is exact.
const signalIds: string[] = [];
const clusterIds: string[] = [];

let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
  if (signalIds.length > 0) {
    // Delete by each tracked id — no FK cascade, safe to do directly.
    for (const id of signalIds) {
      await db.delete(storyUpdateSignalsTable).where(eq(storyUpdateSignalsTable.id, id));
    }
  }
  if (clusterIds.length > 0) {
    for (const id of clusterIds) {
      await db.delete(storyClustersTable).where(eq(storyClustersTable.id, id));
    }
  }
}

/** Insert a fresh signal row and track its id for cleanup. */
async function insertSignal(opts: {
  clusterId: string;
  status?: string;
  retryCount?: number;
  trackType?: string;
}): Promise<typeof storyUpdateSignalsTable.$inferSelect> {
  const [row] = await db
    .insert(storyUpdateSignalsTable)
    .values({
      clusterId: opts.clusterId,
      status: opts.status ?? "pending",
      retryCount: opts.retryCount ?? 0,
      trackType: opts.trackType ?? "corroboration",
      lastSignalAt: new Date(),
    })
    .returning();
  signalIds.push(row!.id);
  return row!;
}

/** Insert a watched cluster row and track its id for cleanup. */
async function insertWatchedCluster(): Promise<string> {
  const [row] = await db
    .insert(storyClustersTable)
    .values({
      beatSlug: BEAT,
      beat: BEAT_LABEL,
      label: `zz-signal-test-cluster-${randomUUID()}`,
      keywords: ["signal", "test"],
      status: "active",
      coverageStatus: "open",
      score: 30,
      watched: true,
      watchedAt: new Date(),
    })
    .returning({ id: storyClustersTable.id });
  clusterIds.push(row!.id);
  return row!.id;
}

before(async () => {
  await cleanup();

  // Mount the trends router without auth/CSRF guards — auth middleware lives at
  // the /admin mount point in routes/index.ts, not inside the router itself, so
  // exercising just the route handler is correct for this unit/integration test.
  const app = express();
  app.use(express.json());
  app.use(trendsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("No test server address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  server?.close();
  await cleanup();
});

// ---------------------------------------------------------------------------
// Test 1: markSignalRetried → exhausted after MAX_SIGNAL_RETRIES
// ---------------------------------------------------------------------------

test("markSignalRetried exhausts a signal exactly at MAX_SIGNAL_RETRIES", async () => {
  // Start at one retry short of the limit so one more call triggers exhaustion.
  const clusterId = randomUUID();
  const row = await insertSignal({
    clusterId,
    status: "pending",
    retryCount: MAX_SIGNAL_RETRIES - 1,
  });

  await markSignalRetried(clusterId);

  const [updated] = await db
    .select()
    .from(storyUpdateSignalsTable)
    .where(eq(storyUpdateSignalsTable.id, row.id));

  assert.ok(updated, "signal row must still exist after markSignalRetried");
  assert.equal(
    updated!.status,
    "exhausted",
    `status must be "exhausted" once retryCount reaches MAX_SIGNAL_RETRIES (${MAX_SIGNAL_RETRIES})`,
  );
  assert.equal(
    updated!.retryCount,
    MAX_SIGNAL_RETRIES,
    "retryCount must equal MAX_SIGNAL_RETRIES after exhaustion",
  );
});

test("markSignalRetried does NOT exhaust a signal before MAX_SIGNAL_RETRIES", async () => {
  // Verify the exhaustion threshold is exact: a signal with retryCount = 0
  // calling markSignalRetried once must stay pending (assuming MAX_SIGNAL_RETRIES > 1).
  if (MAX_SIGNAL_RETRIES <= 1) return; // trivially exhausted — skip

  const clusterId = randomUUID();
  const row = await insertSignal({ clusterId, status: "pending", retryCount: 0 });

  await markSignalRetried(clusterId);

  const [updated] = await db
    .select()
    .from(storyUpdateSignalsTable)
    .where(eq(storyUpdateSignalsTable.id, row.id));

  assert.ok(updated, "signal row must still exist");
  assert.equal(
    updated!.status,
    "pending",
    "status must remain pending when retryCount has not reached MAX_SIGNAL_RETRIES",
  );
  assert.equal(updated!.retryCount, 1, "retryCount must increment to 1");
});

// ---------------------------------------------------------------------------
// Test 2: POST /admin/trends/clusters/:id/signal/reset endpoint
// ---------------------------------------------------------------------------

test("signal reset endpoint returns 200 and resets exhausted signal to pending", async () => {
  const clusterId = randomUUID();
  const row = await insertSignal({
    clusterId,
    status: "exhausted",
    retryCount: MAX_SIGNAL_RETRIES,
    trackType: "authority",
  });

  const res = await fetch(`${baseUrl}/trends/clusters/${clusterId}/signal/reset`, {
    method: "POST",
  });

  assert.equal(res.status, 200, "reset endpoint must return 200 for an existing signal");
  const body = (await res.json()) as { reset: boolean; clusterId: string };
  assert.equal(body.reset, true, "response body must have reset: true");
  assert.equal(body.clusterId, clusterId, "response body must echo the cluster id");

  const [updated] = await db
    .select()
    .from(storyUpdateSignalsTable)
    .where(eq(storyUpdateSignalsTable.id, row.id));

  assert.ok(updated, "signal row must still exist after reset");
  assert.equal(updated!.status, "pending", "status must be reset to pending");
  assert.equal(updated!.retryCount, 0, "retryCount must be reset to 0");
  assert.equal(updated!.consumedAt, null, "consumedAt must be cleared to null");
});

test("signal reset endpoint returns 404 when no signal row exists for cluster", async () => {
  const missingClusterId = randomUUID();

  const res = await fetch(`${baseUrl}/trends/clusters/${missingClusterId}/signal/reset`, {
    method: "POST",
  });

  assert.equal(res.status, 404, "must return 404 when no signal row exists for the cluster");
  const body = (await res.json()) as { error: string };
  assert.ok(typeof body.error === "string" && body.error.length > 0, "must return an error message");
});

// ---------------------------------------------------------------------------
// Test 3: listWatchedClusters projects signal fields
// ---------------------------------------------------------------------------

test("listWatchedClusters includes signalStatus, signalRetryCount, and signalTrackType", async () => {
  const clusterId = await insertWatchedCluster();

  // Insert a signal row for this cluster so the join has data to project.
  await insertSignal({
    clusterId,
    status: "exhausted",
    retryCount: 2,
    trackType: "corroboration",
  });

  const clusters = await listWatchedClusters({ includeSources: false });
  const match = clusters.find((c) => c.id === clusterId);

  assert.ok(match, "the watched cluster must appear in listWatchedClusters results");
  assert.equal(match!.signalStatus, "exhausted", "signalStatus must reflect the joined signal row");
  assert.equal(match!.signalRetryCount, 2, "signalRetryCount must reflect the joined signal row");
  assert.equal(match!.signalTrackType, "corroboration", "signalTrackType must reflect the joined signal row");
});

test("listWatchedClusters returns null signal fields when no signal row exists", async () => {
  const clusterId = await insertWatchedCluster();
  // Deliberately do NOT insert a signal row.

  const clusters = await listWatchedClusters({ includeSources: false });
  const match = clusters.find((c) => c.id === clusterId);

  assert.ok(match, "the watched cluster must appear in listWatchedClusters results");
  assert.equal(match!.signalStatus, null, "signalStatus must be null when no signal exists");
  assert.equal(match!.signalRetryCount, null, "signalRetryCount must be null when no signal exists");
  assert.equal(match!.signalTrackType, null, "signalTrackType must be null when no signal exists");
});

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, sourceIngestQueueTable, type SourceIngestQueueItem } from "@workspace/db";
import { eq, inArray, like, sql } from "drizzle-orm";
import { enqueueUrl, drainIngestQueue, type QueueIngestFn } from "./sourceIngestQueue";

// Concurrency + durability regression for the bounded batch ingestion queue
// (source_ingest_queue). The queue's whole job is to never LOSE a URL and never
// DOUBLE-PROCESS one, under overlapping cron drains, budget stops, and crash
// recovery — behaviors that silently break under load and are hard to catch by
// hand. These tests exercise the REAL claim / requeue / reclaim / retry logic:
//   1. two concurrent drains never claim the same row (FOR UPDATE SKIP LOCKED),
//   2. a stop mid-drain requeues every not-yet-processed claimed row to pending,
//   3. a row abandoned in `processing` past the lease is reclaimed and finished,
//   4. idempotent enqueue revives only terminal rows, never an in-flight one,
//   5. a drain never throws, even when every ingest fails.
//
// The per-URL ingest step is INJECTED (opts.ingest) so no network/model call is
// made and the queue's own state machine is what's under test. Runs against the
// dev/test Postgres pointed to by DATABASE_URL (same style as jobState.test.ts /
// editorialScreen.test.ts). The real dev queue is NOT assumed empty (feed
// watcher / back-catalog harvest keep it populated), so every drain here passes
// `urlPrefix: URL_PREFIX` — a test-only DrainOptions scope that claims/reclaims
// ONLY test-owned rows. beforeEach wipes those rows; real queue rows are never
// touched by these tests.

const URL_PREFIX = "https://zz-test-ingest-queue.example.com/";

async function cleanup(): Promise<void> {
  await db.delete(sourceIngestQueueTable).where(like(sourceIngestQueueTable.url, `${URL_PREFIX}%`));
}

async function insertRow(opts: {
  url: string;
  status?: SourceIngestQueueItem["status"];
  attempts?: number;
  updatedAt?: Date;
  documentId?: string | null;
}): Promise<SourceIngestQueueItem> {
  const [row] = await db
    .insert(sourceIngestQueueTable)
    .values({
      url: opts.url,
      status: opts.status ?? "pending",
      attempts: opts.attempts ?? 0,
      documentId: opts.documentId ?? null,
      ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
    })
    .returning();
  return row!;
}

async function getRow(id: string): Promise<SourceIngestQueueItem | undefined> {
  const [row] = await db.select().from(sourceIngestQueueTable).where(eq(sourceIngestQueueTable.id, id));
  return row;
}

// A successful ingest stub: records the URLs it saw and returns a fresh document
// id (a valid uuid for the document_id column). The tiny delay lets concurrent
// drains interleave their claim windows.
function okIngest(seen?: string[]): QueueIngestFn {
  return async (url) => {
    if (seen) seen.push(url);
    await new Promise((r) => setTimeout(r, 5));
    return { document: { id: randomUUID() } };
  };
}

before(async () => {
  // ensureRuntimeTables creates this at boot, but the test runner may run before
  // any server boot, so create it idempotently here too (mirrors seed.ts).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "source_ingest_queue" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "url" text NOT NULL,
      "discovered_via" text NOT NULL DEFAULT 'manual_url',
      "lead_snippet" text,
      "approve_low_quality" boolean NOT NULL DEFAULT false,
      "status" text NOT NULL DEFAULT 'pending',
      "attempts" integer NOT NULL DEFAULT 0,
      "last_error" text,
      "document_id" uuid,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
      "processed_at" timestamp with time zone
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS "source_ingest_queue_url_key" ON "source_ingest_queue" ("url")`,
  );
  await db.execute(sql`ALTER TABLE "source_ingest_queue" ADD COLUMN IF NOT EXISTS "beat_slug" text`);
});

beforeEach(cleanup);
after(cleanup);

test("two concurrent drains never claim the same row", async () => {
  // Insert enough rows that two concurrent drains both have work to claim and
  // their FOR UPDATE SKIP LOCKED windows genuinely overlap. The invariant under
  // test (no row claimed twice; every row processed exactly once) holds for any
  // DRAIN_BATCH_SIZE >= this count.
  const urls = Array.from({ length: 10 }, (_, i) => `${URL_PREFIX}concurrent/${i}`);
  const ids: string[] = [];
  for (const url of urls) ids.push((await insertRow({ url })).id);

  const seenA: string[] = [];
  const seenB: string[] = [];
  const [a, b] = await Promise.all([
    drainIngestQueue(new Date(), { ingest: okIngest(seenA), urlPrefix: URL_PREFIX }),
    drainIngestQueue(new Date(), { ingest: okIngest(seenB), urlPrefix: URL_PREFIX }),
  ]);

  // No URL may be processed by both runners.
  const overlap = seenA.filter((u) => seenB.includes(u));
  assert.deepEqual(overlap, [], `no row may be claimed by both drains; overlap: ${overlap.join(", ")}`);

  // Every inserted row is processed exactly once, across the two drains.
  const processed = [...seenA, ...seenB].filter((u) => urls.includes(u));
  assert.equal(new Set(processed).size, processed.length, "no row is processed twice");
  assert.equal(processed.length, urls.length, "every pending row is processed exactly once");
  assert.equal(a.ingested + b.ingested, urls.length, "ingested counts sum to the number of rows");

  // And the DB agrees: all rows are done.
  const rows = await db.select().from(sourceIngestQueueTable).where(inArray(sourceIngestQueueTable.id, ids));
  for (const r of rows) assert.equal(r.status, "done", `row ${r.url} must be done`);
});

test("a stop mid-drain requeues every not-yet-processed claimed row to pending", async () => {
  const urls = Array.from({ length: 4 }, (_, i) => `${URL_PREFIX}requeue/${i}`);
  const ids: string[] = [];
  for (const url of urls) ids.push((await insertRow({ url })).id);

  let processedCount = 0;
  // Trip the guard right after the first item. A mid-run stop — whether a spend
  // cap or the kill-switch — raises VaultBudgetExceededError, which hits the same
  // requeue branch and reports stoppedBy: "budget". We flip the kill-switch
  // because it is deterministic and needs no DB spend state.
  const ingest: QueueIngestFn = async () => {
    processedCount += 1;
    process.env.SOURCE_VAULT_ENABLED = "false"; // the next guard.check() aborts.
    return { document: { id: randomUUID() } };
  };

  let result: Awaited<ReturnType<typeof drainIngestQueue>>;
  try {
    result = await drainIngestQueue(new Date(), { ingest, urlPrefix: URL_PREFIX });
  } finally {
    delete process.env.SOURCE_VAULT_ENABLED;
  }

  assert.equal(processedCount, 1, "only the first claimed row is ingested before the stop");
  assert.equal(result.stoppedBy, "budget", "a mid-run guard abort reports a budget stop");
  assert.equal(result.ingested, 1, "exactly one row is ingested");
  assert.equal(result.requeued, 3, "the three unprocessed claimed rows are requeued");

  const rows = await db.select().from(sourceIngestQueueTable).where(inArray(sourceIngestQueueTable.id, ids));
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  assert.equal(byStatus.done ?? 0, 1, "exactly one row is done");
  assert.equal(byStatus.pending ?? 0, 3, "every unprocessed claimed row is back to pending (work preserved)");
  assert.equal(byStatus.processing ?? 0, 0, "no row is left stuck in processing");
});

test("a row abandoned in processing past the lease is reclaimed and finished", async () => {
  const base = new Date();
  // One row stuck in `processing` longer than the 15-min lease (a crashed /
  // restarted runner)...
  const staleId = (
    await insertRow({
      url: `${URL_PREFIX}stale/abandoned`,
      status: "processing",
      updatedAt: new Date(base.getTime() - 20 * 60 * 1000),
    })
  ).id;
  // ...and one freshly claimed (well within the lease) that must be left alone.
  const freshId = (
    await insertRow({
      url: `${URL_PREFIX}stale/fresh`,
      status: "processing",
      updatedAt: base,
    })
  ).id;

  const seen: string[] = [];
  await drainIngestQueue(base, { ingest: okIngest(seen), urlPrefix: URL_PREFIX });

  const stale = await getRow(staleId);
  const fresh = await getRow(freshId);
  assert.equal(stale?.status, "done", "the abandoned row is reclaimed to pending, then ingested to done");
  assert.equal(fresh?.status, "processing", "a fresh (within-lease) processing row is left untouched");
  assert.ok(seen.includes(`${URL_PREFIX}stale/abandoned`), "the reclaimed row is the one that got ingested");
  assert.ok(!seen.includes(`${URL_PREFIX}stale/fresh`), "the fresh in-flight row is never ingested");
});

test("enqueue revives only terminal rows and never disturbs an in-flight one", async () => {
  // Pending: a queued-but-not-started row must be left exactly as-is.
  const pending = await insertRow({ url: `${URL_PREFIX}enqueue/pending`, status: "pending", attempts: 1 });
  const pendingRes = await enqueueUrl(pending.url);
  const pendingAfter = await getRow(pending.id);
  assert.equal(pendingAfter?.status, "pending", "a pending row stays pending");
  assert.equal(pendingAfter?.attempts, 1, "a pending row's attempts are not reset");
  assert.equal(pendingRes.item.id, pending.id, "enqueue upserts the same row (no duplicate)");

  // Processing: a claimed, in-flight row must NOT be revived — reviving it would
  // let a second runner grab it and double-process the URL.
  const processing = await insertRow({
    url: `${URL_PREFIX}enqueue/processing`,
    status: "processing",
    attempts: 1,
  });
  const procRes = await enqueueUrl(processing.url);
  const procAfter = await getRow(processing.id);
  assert.equal(procAfter?.status, "processing", "an in-flight (processing) row is not disturbed");
  assert.equal(procAfter?.attempts, 1, "an in-flight row's attempts are unchanged");
  assert.equal(procRes.enqueued, false, "re-enqueuing an in-flight row queues no new work");

  // Terminal (done/failed/skipped): each is revived to pending with attempts
  // reset, so a previously finished URL can be re-ingested on demand.
  for (const status of ["done", "failed", "skipped"] as const) {
    const row = await insertRow({
      url: `${URL_PREFIX}enqueue/${status}`,
      status,
      attempts: 3,
      documentId: status === "done" ? randomUUID() : null,
    });
    const res = await enqueueUrl(row.url);
    const after = await getRow(row.id);
    assert.equal(after?.status, "pending", `a ${status} row is revived to pending`);
    assert.equal(after?.attempts, 0, `a revived ${status} row has its attempts reset`);
    assert.equal(res.enqueued, true, `reviving a ${status} row reports enqueued`);
  }

  // A brand-new URL inserts a fresh pending row.
  const fresh = await enqueueUrl(`${URL_PREFIX}enqueue/brand-new`);
  assert.equal(fresh.enqueued, true, "a brand-new URL is enqueued");
  assert.equal(fresh.item.status, "pending", "a brand-new URL starts pending");
});

test("drain never throws on ingest failure; the row is retried, then failed at the cap", async () => {
  // A row with one attempt already used: a failing ingest bumps it to 2 (below
  // the max of 3) so it returns to pending for another try, not failed.
  const retryId = (await insertRow({ url: `${URL_PREFIX}fail/retry`, attempts: 1 })).id;
  // A row on its last allowed attempt: the next failure is terminal (failed).
  const terminalId = (await insertRow({ url: `${URL_PREFIX}fail/terminal`, attempts: 2 })).id;

  const boom: QueueIngestFn = async () => {
    throw new Error("simulated ingest failure");
  };

  let result: Awaited<ReturnType<typeof drainIngestQueue>> | undefined;
  await assert.doesNotReject(async () => {
    result = await drainIngestQueue(new Date(), { ingest: boom, urlPrefix: URL_PREFIX });
  }, "a drain must never throw, even when every ingest fails");

  const retry = await getRow(retryId);
  const terminal = await getRow(terminalId);
  assert.equal(retry?.status, "pending", "a non-terminal failure returns the row to pending");
  assert.equal(retry?.attempts, 2, "the failed attempt is counted");
  assert.equal(retry?.lastError, "simulated ingest failure", "the failure message is recorded");
  assert.equal(terminal?.status, "failed", "a failure at the attempt cap marks the row failed");
  assert.equal(terminal?.attempts, 3, "the cap attempt is counted");
  assert.equal(result?.ingested, 0, "no row is ingested when every ingest fails");
  assert.equal(result?.requeued, 1, "one row is requeued for retry");
  assert.equal(result?.failed, 1, "one row hits the terminal failed state");
});

test("junk URLs are recorded as skipped at enqueue and never revive to pending", async () => {
  // A media-downloader URL (the CDC MMWR-feed shape) must never enter the
  // pending queue: it can't extract, and before this guard each one burned the
  // fetch + 3 retry attempts and left a permanent failed vault row.
  const junkUrl = `${URL_PREFIX}api/embed/downloader/download.asp?m=403372`;

  const first = await enqueueUrl(junkUrl);
  assert.equal(first.enqueued, false, "a junk URL is not enqueued");
  assert.equal(first.item.status, "skipped", "the junk URL is tracked as skipped");
  assert.match(first.item.lastError ?? "", /junk_url/, "the skip reason is recorded");

  // Re-enqueue with default reviveTerminal (true): a normal skipped row would
  // revive to pending — a junk row must NOT (it would just fail again forever).
  const again = await enqueueUrl(junkUrl);
  assert.equal(again.enqueued, false, "re-enqueueing a junk URL is a no-op");
  const row = await getRow(first.item.id);
  assert.equal(row?.status, "skipped", "a junk row is never revived to pending");

  // A skipped row is invisible to the drain (claims only pending rows).
  const seen: string[] = [];
  await drainIngestQueue(new Date(), { ingest: okIngest(seen), urlPrefix: URL_PREFIX });
  assert.equal(seen.includes(junkUrl), false, "the drain never processes a junk row");
});

import {
  db,
  sourceIngestQueueTable,
  sourceDocumentsTable,
  type SourceIngestQueueItem,
} from "@workspace/db";
import { and, eq, like, lt, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { ingestUrl } from "./sourceVault";
import { cascadeSourceRetraction } from "./retractionCascade";
import {
  VaultBudgetGuard,
  VaultBudgetExceededError,
  isSourceVaultEnabled,
} from "./sourceVaultBudget";
import { isEmbeddingPaid } from "./embeddings";
import { isJunkIngestUrl } from "./ingestGuards";

// --- Bounded batch ingestion queue (Step 5) -----------------------------
// A DB-backed work queue of URLs awaiting ingestion. Discovery (Perplexity /
// manual bulk paste) ENQUEUES; the cron tick DRAINS a small batch each run,
// bounded by the per-run/day VAULT budgets. Anything not reached this run stays
// `pending` for the next tick — work is preserved across stops, never lost. The
// queue is single-server-safe via a claim (UPDATE ... FOR UPDATE SKIP LOCKED)
// so overlapping ticks never process the same row twice.

// How many queued URLs a single cron drain will attempt at most, before the
// per-run budget or this hard cap stops it. The drain runs fire-and-forget from
// the cron tick (see cronTick.ts step 8), so a larger batch drains a backlog
// faster without slowing the pinger. Local embedding is free (only the paid
// path is budget-bounded), so this is the main lever on ingestion throughput.
const DRAIN_BATCH_SIZE = 25;
// Give up on a queue item after this many failed attempts (marked `failed`).
const MAX_ATTEMPTS = 3;
// A row claimed to `processing` that hasn't reached a terminal state within this
// window is assumed abandoned (process crashed/restarted mid-ingest) and is
// reset to `pending` so a later drain finishes it — no row stays stuck forever.
const PROCESSING_LEASE_MS = 15 * 60 * 1000;

/** Add a URL to the ingest queue. Idempotent: a pending/processing dup is a
 * no-op; a previously done/failed/skipped URL is reset to pending for a retry.
 *
 * `reviveTerminal` (default true) controls whether a terminal (done/failed/
 * skipped) row is revived to pending. The known-source feed watcher passes
 * `false`: a feed re-polls the same items repeatedly, and a URL already ingested
 * (`done`) must NOT be re-ingested every poll — the feed's own per-item dedupe
 * table decides novelty, so a conflict here is a genuine no-op. */
export async function enqueueUrl(
  url: string,
  opts: {
    discoveredVia?: SourceIngestQueueItem["discoveredVia"];
    leadSnippet?: string | null;
    approveLowQuality?: boolean;
    beatSlug?: string | null;
    reviveTerminal?: boolean;
  } = {},
): Promise<{ enqueued: boolean; item: SourceIngestQueueItem }> {
  const trimmed = url.trim();
  // Junk URLs (media downloaders, search-result pages, raw feeds) can never
  // extract — record them as `skipped` (tracked + idempotent, so a feed
  // re-emitting them every poll stays a no-op) and never let them revive to
  // pending. Saves the fetch attempt, the retries, and the failed vault row.
  if (isJunkIngestUrl(trimmed)) {
    const [row] = await db
      .insert(sourceIngestQueueTable)
      .values({
        url: trimmed,
        discoveredVia: opts.discoveredVia ?? "manual_url",
        leadSnippet: opts.leadSnippet ?? null,
        approveLowQuality: opts.approveLowQuality ?? false,
        beatSlug: opts.beatSlug ?? null,
        status: "skipped",
        lastError: "junk_url: not an ingestible article",
      })
      .onConflictDoNothing({ target: sourceIngestQueueTable.url })
      .returning();
    const item =
      row ??
      (
        await db
          .select()
          .from(sourceIngestQueueTable)
          .where(eq(sourceIngestQueueTable.url, trimmed))
          .limit(1)
      )[0]!;
    return { enqueued: false, item };
  }
  const reviveTerminal = opts.reviveTerminal ?? true;
  const insert = db
    .insert(sourceIngestQueueTable)
    .values({
      url: trimmed,
      discoveredVia: opts.discoveredVia ?? "manual_url",
      leadSnippet: opts.leadSnippet ?? null,
      approveLowQuality: opts.approveLowQuality ?? false,
      beatSlug: opts.beatSlug ?? null,
      status: "pending",
    });
  const [row] = reviveTerminal
    ? await insert
        .onConflictDoUpdate({
          target: sourceIngestQueueTable.url,
          // Only revive terminal rows (done/failed/skipped) back to pending; leave a
          // pending/processing row untouched so an in-flight drain isn't disturbed.
          set: {
            status: sql`CASE WHEN ${sourceIngestQueueTable.status} IN ('done','failed','skipped')
              THEN 'pending' ELSE ${sourceIngestQueueTable.status} END`,
            attempts: sql`CASE WHEN ${sourceIngestQueueTable.status} IN ('done','failed','skipped')
              THEN 0 ELSE ${sourceIngestQueueTable.attempts} END`,
            updatedAt: new Date(),
          },
        })
        .returning()
    : await insert
        // Never revive: a re-enqueue of any existing URL is a no-op. The RETURNING
        // clause is empty on conflict, so a missing row means "already existed".
        .onConflictDoNothing({ target: sourceIngestQueueTable.url })
        .returning();
  if (!row) {
    // Conflict with reviveTerminal=false: the URL is already tracked. Report not
    // enqueued and fetch the existing row so callers keep a stable return shape.
    const [existing] = await db
      .select()
      .from(sourceIngestQueueTable)
      .where(eq(sourceIngestQueueTable.url, trimmed))
      .limit(1);
    return { enqueued: false, item: existing! };
  }
  return { enqueued: row.status === "pending", item: row };
}

/** Enqueue many URLs at once (bulk paste / discovery fan-out). `leadSnippets`,
 * when provided, carries per-URL lead context aligned by index with `urls` (e.g.
 * the Perplexity search snippet for a discovered lead), preserved onto each row. */
export async function enqueueUrls(
  urls: string[],
  opts: {
    discoveredVia?: SourceIngestQueueItem["discoveredVia"];
    approveLowQuality?: boolean;
    beatSlug?: string | null;
    leadSnippets?: (string | null)[];
  } = {},
): Promise<{ enqueued: number; total: number }> {
  const { leadSnippets, ...common } = opts;
  const seen = new Set<string>();
  let enqueued = 0;
  for (let i = 0; i < urls.length; i += 1) {
    const url = urls[i]!.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    try {
      const r = await enqueueUrl(url, { ...common, leadSnippet: leadSnippets?.[i] ?? null });
      if (r.enqueued) enqueued += 1;
    } catch (err) {
      logger.warn({ err, url }, "sourceIngestQueue: enqueue failed");
    }
  }
  return { enqueued, total: seen.size };
}

/**
 * Atomically claim up to `limit` pending queue rows, flipping them to
 * `processing` in one statement so a concurrent tick can't grab the same rows
 * (FOR UPDATE SKIP LOCKED). Returns the claimed rows for this runner to process.
 */
async function claimBatch(limit: number, urlPrefix?: string): Promise<SourceIngestQueueItem[]> {
  const prefixFilter = urlPrefix
    ? sql` AND "url" LIKE ${`${urlPrefix}%`}`
    : sql``;
  const rows = await db.execute<SourceIngestQueueItem>(sql`
    UPDATE "source_ingest_queue" SET "status" = 'processing', "updated_at" = now()
    WHERE "id" IN (
      SELECT "id" FROM "source_ingest_queue"
      WHERE "status" = 'pending'${prefixFilter}
      ORDER BY
        CASE
          -- Only items explicitly enqueued as part of a watched-cluster search
          -- (and therefore already Jaccard-screened for cluster relevance) get
          -- priority. Broad beat-slug matching was too coarse: it promoted ALL
          -- items from the same beat, starving unrelated traffic.
          WHEN "discovered_via" = 'watched_cluster_search' THEN 0
          ELSE 1
        END ASC,
        "created_at" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);
  return (rows.rows ?? (rows as unknown as SourceIngestQueueItem[])) as SourceIngestQueueItem[];
}

/** Outcome of a queue drain. */
export interface DrainResult {
  claimed: number;
  ingested: number;
  failed: number;
  requeued: number;
  stoppedBy: "budget" | "batch_done" | "disabled" | "empty";
}

/**
 * The per-URL ingest step a drain runs for each claimed row. Real callers use
 * {@link ingestUrl}; tests inject a deterministic stub so the queue's claim /
 * requeue / retry invariants can be exercised without any network or model
 * spend. Structurally a subset of {@link ingestUrl} so the real fn slots in.
 */
export type QueueIngestFn = (
  url: string,
  opts: {
    discoveredVia?: SourceIngestQueueItem["discoveredVia"];
    leadSnippet?: string;
    approveLowQuality?: boolean;
    beatSlug?: string | null;
  },
) => Promise<{ document: { id: string } }>;

/** Options for {@link drainIngestQueue}. */
export interface DrainOptions {
  /** Injected ingest step (tests). Defaults to the real {@link ingestUrl}. */
  ingest?: QueueIngestFn;
  /**
   * TEST-ONLY scope: when set, the drain claims/reclaims only rows whose URL
   * starts with this prefix. Production drains never pass it (whole table).
   * Exists so the queue tests can run against a shared dev DB without touching
   * — or being broken by — real queued rows.
   */
  urlPrefix?: string;
}

/**
 * Reset rows abandoned in `processing` (claimed by a runner that crashed or was
 * restarted before finishing) back to `pending`, once their lease has elapsed.
 * Guarantees no row is stuck in `processing` forever. Returns the reset count.
 */
async function reclaimStaleProcessing(now: Date, urlPrefix?: string): Promise<number> {
  const cutoff = new Date(now.getTime() - PROCESSING_LEASE_MS);
  const rows = await db
    .update(sourceIngestQueueTable)
    .set({ status: "pending", updatedAt: new Date() })
    .where(
      and(
        eq(sourceIngestQueueTable.status, "processing"),
        lt(sourceIngestQueueTable.updatedAt, cutoff),
        ...(urlPrefix ? [like(sourceIngestQueueTable.url, `${urlPrefix}%`)] : []),
      ),
    )
    .returning({ id: sourceIngestQueueTable.id });
  return rows.length;
}

/**
 * Drain a bounded batch of the ingest queue. First reclaims any abandoned
 * `processing` rows, then claims up to DRAIN_BATCH_SIZE pending rows, ingests
 * each within the VAULT budget guard, and STOPS early the moment the budget is
 * crossed — re-queuing (status→pending) any already-claimed rows it didn't get
 * to, so no work is lost. Never throws: any unexpected error requeues the rows
 * still claimed by this runner before returning.
 */
export async function drainIngestQueue(
  now: Date = new Date(),
  opts: DrainOptions = {},
): Promise<DrainResult> {
  const ingest: QueueIngestFn = opts.ingest ?? ingestUrl;
  const result: DrainResult = {
    claimed: 0,
    ingested: 0,
    failed: 0,
    requeued: 0,
    stoppedBy: "empty",
  };

  if (!isSourceVaultEnabled()) {
    result.stoppedBy = "disabled";
    return result;
  }

  try {
    await reclaimStaleProcessing(now, opts.urlPrefix);
  } catch (err) {
    logger.warn({ err }, "sourceIngestQueue: reclaim stale processing failed");
  }

  let guard: VaultBudgetGuard;
  try {
    // Ingestion only spends money when embeddings are paid; a free/local
    // embedding path is bounded solely by the kill-switch.
    guard = await VaultBudgetGuard.start("queue drain", { paid: isEmbeddingPaid(), now });
  } catch (err) {
    if (err instanceof VaultBudgetExceededError) {
      result.stoppedBy = "budget";
    } else {
      logger.warn({ err }, "sourceIngestQueue: budget guard failed to start");
      result.stoppedBy = "disabled";
    }
    return result;
  }

  const batch = await claimBatch(DRAIN_BATCH_SIZE, opts.urlPrefix);
  result.claimed = batch.length;
  if (batch.length === 0) {
    result.stoppedBy = "empty";
    return result;
  }

  for (let i = 0; i < batch.length; i += 1) {
    const item = batch[i]!;

    // Stop before spending on the next item once the budget is crossed; requeue
    // this and every remaining claimed row so a later tick finishes them.
    try {
      await guard.check(now);
    } catch (err) {
      const remaining = batch.slice(i).map((r) => r.id);
      await requeuePending(remaining);
      result.requeued += remaining.length;
      result.stoppedBy = err instanceof VaultBudgetExceededError ? "budget" : "disabled";
      if (!(err instanceof VaultBudgetExceededError)) {
        logger.warn({ err }, "sourceIngestQueue: budget check failed, requeued remaining");
      }
      return result;
    }

    try {
      const { document } = await ingest(item.url, {
        discoveredVia: item.discoveredVia,
        leadSnippet: item.leadSnippet ?? undefined,
        approveLowQuality: item.approveLowQuality,
        beatSlug: item.beatSlug ?? null,
      });
      await db
        .update(sourceIngestQueueTable)
        .set({ status: "done", documentId: document.id, processedAt: new Date(), updatedAt: new Date() })
        .where(eq(sourceIngestQueueTable.id, item.id));
      result.ingested += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = item.attempts + 1;
      const terminal = attempts >= MAX_ATTEMPTS;
      await db
        .update(sourceIngestQueueTable)
        .set({
          status: terminal ? "failed" : "pending",
          attempts,
          lastError: message,
          updatedAt: new Date(),
          ...(terminal ? { processedAt: new Date() } : {}),
        })
        .where(eq(sourceIngestQueueTable.id, item.id));
      if (terminal) result.failed += 1;
      else result.requeued += 1;
      logger.warn({ err, url: item.url, attempts }, "sourceIngestQueue: ingest attempt failed");
    }
  }

  result.stoppedBy = "batch_done";
  return result;
}

/** Return the given claimed rows to `pending` (budget stop; work preserved). */
async function requeuePending(ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      await db
        .update(sourceIngestQueueTable)
        .set({ status: "pending", updatedAt: new Date() })
        .where(and(eq(sourceIngestQueueTable.id, id), eq(sourceIngestQueueTable.status, "processing")));
    } catch (err) {
      logger.warn({ err, id }, "sourceIngestQueue: requeue failed (stale-processing reclaim will recover)");
    }
  }
}

/**
 * Lifecycle recheck: mark any `active` document whose freshness window has
 * elapsed (`stale_after` < now) as `stale`. Stale docs are excluded from
 * retrieval (semanticSearch filters lifecycle_status = 'active'), so they are no
 * longer treated as fresh support until re-fetched. Idempotent; returns count.
 */
export async function markStaleDocuments(now: Date = new Date()): Promise<number> {
  const rows = await db
    .update(sourceDocumentsTable)
    .set({ lifecycleStatus: "stale", updatedAt: new Date() })
    .where(
      and(
        eq(sourceDocumentsTable.lifecycleStatus, "active"),
        lt(sourceDocumentsTable.staleAfter, now),
      ),
    )
    .returning({ id: sourceDocumentsTable.id });

  // Fire-and-forget cascade for each newly staled document: runs them
  // sequentially in the background so we don't flood the DB pool.
  if (rows.length > 0) {
    void (async () => {
      for (const { id } of rows) {
        await cascadeSourceRetraction(id, "stale");
      }
    })();
  }

  return rows.length;
}

/** Queue counters for the admin surface. */
export interface QueueStats {
  pending: number;
  processing: number;
  done: number;
  failed: number;
  skipped: number;
}

export async function getQueueStats(): Promise<QueueStats> {
  const rows = await db
    .select({ status: sourceIngestQueueTable.status, n: sql<string>`count(*)` })
    .from(sourceIngestQueueTable)
    .groupBy(sourceIngestQueueTable.status);
  const stats: QueueStats = { pending: 0, processing: 0, done: 0, failed: 0, skipped: 0 };
  for (const r of rows) stats[r.status] = Number(r.n);
  return stats;
}

export async function listQueue(limit = 50): Promise<SourceIngestQueueItem[]> {
  return db
    .select()
    .from(sourceIngestQueueTable)
    .orderBy(sql`${sourceIngestQueueTable.createdAt} DESC`)
    .limit(limit);
}

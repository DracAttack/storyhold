/**
 * Story Watch service (Task #348).
 *
 * Provides:
 *   watchCluster / unwatchCluster  — toggle the watch flag on a cluster
 *   listWatchedClusters            — watched clusters + newDocsSinceViewed badge + signal status
 *   markWatchedViewed              — stamp site_settings.watched_last_viewed_at
 *   resetExhaustedSignal           — reset an exhausted signal back to pending
 *   ingestAndWatchUrl              — SSRF-safe enqueue for the "paste a URL" flow
 *   autoWatchAfterCluster          — cron helper: auto-watch clusters from ingest_watch docs
 */

import {
  db,
  storyClustersTable,
  sourceDocumentsTable,
  siteSettingsTable,
  storyUpdateSignalsTable,
} from "@workspace/db";
import { eq, and, inArray, isNotNull, desc, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { enqueueUrl } from "./sourceIngestQueue";
import { getStoryCluster, type StoryClusterWithSources } from "./storyClusters";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WatchedCluster extends StoryClusterWithSources {
  newDocsSinceViewed: number;
  /** Lifecycle status of the development signal for this cluster (null when no signal has ever fired). */
  signalStatus: string | null;
  /** Number of failed generation attempts (0 when never retried, null when no signal row exists). */
  signalRetryCount: number | null;
  /** ISO timestamp when the signal was marked consumed; null when not yet consumed. */
  signalConsumedAt: string | null;
  /** Track type that last triggered: "corroboration" | "authority" | null when no signal. */
  signalTrackType: string | null;
  /** ISO timestamp of when the signal last fired; null when no signal. */
  signalLastSignalAt: string | null;
}

// ---------------------------------------------------------------------------
// Watch toggle
// ---------------------------------------------------------------------------

/**
 * Mark a cluster as watched.
 * If `sourceUrl` is provided and non-empty it is immediately enqueued for
 * ingest via discoveredVia="ingest_watch". Fire-and-forget — never blocks.
 */
export async function watchCluster(
  id: string,
  sourceUrl?: string | null,
): Promise<StoryClusterWithSources | null> {
  const [updated] = await db
    .update(storyClustersTable)
    .set({ watched: true, watchedAt: new Date(), updatedAt: new Date() })
    .where(eq(storyClustersTable.id, id))
    .returning({ id: storyClustersTable.id });

  if (!updated) return null;

  if (sourceUrl) {
    const trimmed = sourceUrl.trim();
    if (trimmed) {
      void enqueueUrl(trimmed, { discoveredVia: "ingest_watch" }).catch((err) => {
        logger.warn({ err, clusterId: id, url: trimmed }, "storyWatch.watchCluster: enqueue failed");
      });
    }
  }

  return getStoryCluster(id);
}

/** Clear the watch flag on a cluster. */
export async function unwatchCluster(id: string): Promise<StoryClusterWithSources | null> {
  const [updated] = await db
    .update(storyClustersTable)
    .set({ watched: false, watchedAt: null, updatedAt: new Date() })
    .where(eq(storyClustersTable.id, id))
    .returning({ id: storyClustersTable.id });

  if (!updated) return null;
  return getStoryCluster(id);
}

// ---------------------------------------------------------------------------
// Watched list
// ---------------------------------------------------------------------------

/**
 * List all watched clusters ordered by watchedAt desc.
 * Each result includes a `newDocsSinceViewed` count: source documents whose
 * createdAt > the last mark-viewed stamp.
 */
export async function listWatchedClusters(opts: {
  includeSources?: boolean;
} = {}): Promise<WatchedCluster[]> {
  const clusters = await db
    .select()
    .from(storyClustersTable)
    .where(eq(storyClustersTable.watched, true))
    // Most recently active first (lastSeenAt = latest incoming doc), with
    // watchedAt as a stable tiebreaker for clusters with equal activity.
    .orderBy(desc(storyClustersTable.lastSeenAt), desc(storyClustersTable.watchedAt));

  if (clusters.length === 0) return [];

  const ids = clusters.map((c) => c.id);

  const [settings] = await db
    .select({ watchedLastViewedAt: siteSettingsTable.watchedLastViewedAt })
    .from(siteSettingsTable)
    .where(eq(siteSettingsTable.id, "global"))
    .limit(1);
  const since: Date | null = settings?.watchedLastViewedAt ?? null;

  const newDocCounts = new Map<string, number>();
  if (since) {
    const rows = await db
      .select({
        clusterId: sourceDocumentsTable.clusterId,
        n: sql<number>`count(*)::int`,
      })
      .from(sourceDocumentsTable)
      .where(
        and(
          inArray(sourceDocumentsTable.clusterId, ids),
          sql`${sourceDocumentsTable.createdAt} > ${since}`,
        ),
      )
      .groupBy(sourceDocumentsTable.clusterId);
    for (const r of rows) {
      if (r.clusterId) newDocCounts.set(r.clusterId, Number(r.n));
    }
  }

  const sourcesByCluster = new Map<string, StoryClusterWithSources["sources"]>();
  if (opts.includeSources !== false) {
    const allSources = await db
      .select()
      .from(sourceDocumentsTable)
      .where(inArray(sourceDocumentsTable.clusterId, ids));
    for (const s of allSources) {
      if (!s.clusterId) continue;
      const list = sourcesByCluster.get(s.clusterId) ?? [];
      list.push({
        id: s.id,
        url: s.url,
        domain: s.domain ?? "",
        title: s.title ?? null,
        authorityTier: s.authorityTier,
        lifecycleStatus: s.lifecycleStatus,
        publishedAt: (s.publishedAt ?? s.fetchedAt)?.toISOString() ?? null,
        sourceFamilyId: s.sourceFamilyId ?? null,
      });
      sourcesByCluster.set(s.clusterId, list);
    }
  }

  // Fetch signal rows for all watched clusters.
  const signalRows = ids.length > 0
    ? await db
        .select({
          clusterId: storyUpdateSignalsTable.clusterId,
          status: storyUpdateSignalsTable.status,
          retryCount: storyUpdateSignalsTable.retryCount,
          consumedAt: storyUpdateSignalsTable.consumedAt,
          trackType: storyUpdateSignalsTable.trackType,
          lastSignalAt: storyUpdateSignalsTable.lastSignalAt,
        })
        .from(storyUpdateSignalsTable)
        .where(inArray(storyUpdateSignalsTable.clusterId, ids))
    : [];

  const signalByCluster = new Map(signalRows.map((s) => [s.clusterId, s]));

  return clusters.map((c) => {
    const sig = signalByCluster.get(c.id) ?? null;
    return {
      ...c,
      sources: sourcesByCluster.get(c.id) ?? [],
      newDocsSinceViewed: newDocCounts.get(c.id) ?? 0,
      signalStatus: sig?.status ?? null,
      signalRetryCount: sig?.retryCount ?? null,
      signalConsumedAt: sig?.consumedAt?.toISOString() ?? null,
      signalTrackType: sig?.trackType ?? null,
      signalLastSignalAt: sig?.lastSignalAt?.toISOString() ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Reset exhausted signal
// ---------------------------------------------------------------------------

/**
 * Reset an exhausted (or consumed) signal back to pending so the next cron
 * tick will attempt generation again. Editors use this when they believe the
 * failure was transient and want to force a retry.
 *
 * Returns true when a row was found and reset, false when no signal row exists
 * for the cluster.
 */
export async function resetExhaustedSignal(clusterId: string): Promise<boolean> {
  const now = new Date();
  const [updated] = await db
    .update(storyUpdateSignalsTable)
    .set({ status: "pending", retryCount: 0, consumedAt: null, updatedAt: now })
    .where(eq(storyUpdateSignalsTable.clusterId, clusterId))
    .returning({ id: storyUpdateSignalsTable.id });

  if (!updated) return false;
  logger.info({ clusterId }, "storyWatch.resetExhaustedSignal: signal reset to pending");
  return true;
}

// ---------------------------------------------------------------------------
// Mark viewed
// ---------------------------------------------------------------------------

/** Stamp site_settings.watched_last_viewed_at = now(). Returns the timestamp. */
export async function markWatchedViewed(): Promise<Date> {
  const now = new Date();
  await db
    .insert(siteSettingsTable)
    .values({ id: "global", watchedLastViewedAt: now })
    .onConflictDoUpdate({
      target: siteSettingsTable.id,
      set: { watchedLastViewedAt: now },
    });
  return now;
}

// ---------------------------------------------------------------------------
// Ingest & Watch — "paste a URL" flow
// ---------------------------------------------------------------------------

export class IngestWatchError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "IngestWatchError";
  }
}

/**
 * Fast pre-flight SSRF guard. The full DNS-resolution check runs inside the
 * ingest worker — this only rejects obviously bad inputs immediately.
 */
function validateIngestUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new IngestWatchError(400, "Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new IngestWatchError(400, "Only http and https URLs are allowed");
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\./.test(host)
  ) {
    throw new IngestWatchError(400, "URL resolves to a private or reserved address");
  }
  return parsed;
}

export interface IngestWatchResult {
  enqueued: boolean;
  url: string;
  itemId: string | null;
  message: string | null;
}

/**
 * Enqueue a URL for ingest with discoveredVia="ingest_watch".
 * After clustering, {@link autoWatchAfterCluster} will auto-watch the cluster.
 */
export async function ingestAndWatchUrl(rawUrl: string): Promise<IngestWatchResult> {
  const parsed = validateIngestUrl(rawUrl);
  const url = parsed.href;

  const { enqueued, item } = await enqueueUrl(url, {
    discoveredVia: "ingest_watch",
  });

  logger.info({ url, enqueued, itemId: item?.id }, "storyWatch: ingest-watch URL enqueued");

  return {
    enqueued,
    url,
    itemId: item?.id ?? null,
    message: enqueued
      ? "URL enqueued — the cluster will appear in Watched Stories within ~2 minutes."
      : "URL was already in the ingest queue and will be watched once clustered.",
  };
}

// ---------------------------------------------------------------------------
// Auto-watch after cluster — cron tick helper
// ---------------------------------------------------------------------------

/**
 * Finds source_documents with discoveredVia="ingest_watch" that have been
 * assigned to a cluster but whose cluster is not yet watched. Marks those
 * clusters as watched. Idempotent; called from the cron tick every 5 min.
 */
export async function autoWatchAfterCluster(): Promise<number> {
  const docs = await db
    .select({ clusterId: sourceDocumentsTable.clusterId })
    .from(sourceDocumentsTable)
    .where(
      and(
        eq(sourceDocumentsTable.discoveredVia, "ingest_watch"),
        isNotNull(sourceDocumentsTable.clusterId),
      ),
    );

  if (docs.length === 0) return 0;

  const clusterIds = [...new Set(docs.map((d) => d.clusterId!))];

  const unwatched = await db
    .select({ id: storyClustersTable.id })
    .from(storyClustersTable)
    .where(
      and(
        inArray(storyClustersTable.id, clusterIds),
        eq(storyClustersTable.watched, false),
      ),
    );

  if (unwatched.length === 0) return 0;

  const toWatch = unwatched.map((r) => r.id);
  await db
    .update(storyClustersTable)
    .set({ watched: true, watchedAt: new Date(), updatedAt: new Date() })
    .where(inArray(storyClustersTable.id, toWatch));

  logger.info({ ids: toWatch }, "storyWatch.autoWatchAfterCluster: auto-watched clusters");
  return toWatch.length;
}

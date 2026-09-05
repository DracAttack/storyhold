import {
  db,
  trendMarkersTable,
  rejectedSourcesTable,
  storyClustersTable,
  type TrendMarker,
  type RejectedSource,
} from "@workspace/db";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { detectPlatform } from "./sourceAuthority";
import type { TrendMarkerPlatform } from "@workspace/db";
import {
  findMatchingClusterForText,
  recomputeStoryCluster,
} from "./storyClusters";
import { enqueueUrl } from "./sourceIngestQueue";

// --- Trend markers & rejected sources (Task #227) -----------------------
// Storage + lifecycle for the two NON-evidence source roles. A trend marker is a
// weak social observation (YouTube/Reddit/X/TikTok…): recorded for its
// public-interest / velocity signal only, NEVER fetched, chunked, or embedded,
// and it can never satisfy the authority floor. Rejected junk (aggregator /
// link-farm spam) is logged thin, purely for admin transparency. An editor can
// ESCALATE a marker, which re-runs its URL through the normal SSRF-safe ingest +
// verify pipeline — the only path a marker can ever become evidence. Nothing
// here calls paid AI.

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

export interface RecordMarkerInput {
  url: string;
  title?: string | null;
  snippet?: string | null;
  beatSlug?: string | null;
  discoveredVia?: string;
  platform?: TrendMarkerPlatform;
}

/**
 * Record (or re-observe) a trend marker. Idempotent by URL: a repeat observation
 * bumps observationCount + lastSeenAt rather than inserting a duplicate. When the
 * marker carries a beat, it is attached to the best-matching active story cluster
 * (velocity signal) and that cluster is recomputed. Never throws.
 */
export async function recordMarker(input: RecordMarkerInput): Promise<TrendMarker | null> {
  const url = input.url.trim();
  if (!url) return null;
  const domain = hostOf(url);
  const platform = input.platform ?? detectPlatform(url);
  try {
    // Attach to a matching evidence cluster when we have a beat + text to match.
    let clusterId: string | null = null;
    if (input.beatSlug) {
      const text = [input.title ?? "", input.snippet ?? ""].join(" ").trim();
      if (text) clusterId = await findMatchingClusterForText(input.beatSlug, text);
    }

    const [row] = await db
      .insert(trendMarkersTable)
      .values({
        url,
        domain,
        platform,
        title: input.title ?? null,
        snippet: input.snippet ?? null,
        beatSlug: input.beatSlug ?? null,
        clusterId,
        discoveredVia: input.discoveredVia ?? "perplexity_search",
        status: "observed",
      })
      .onConflictDoUpdate({
        target: trendMarkersTable.url,
        set: {
          observationCount: sql`${trendMarkersTable.observationCount} + 1`,
          lastSeenAt: new Date(),
          // Backfill a cluster association if we found one and none was set, and
          // refresh beat/title/snippet if newly known. Never demote an escalated
          // marker back to observed.
          clusterId: sql`COALESCE(${trendMarkersTable.clusterId}, ${clusterId})`,
          beatSlug: sql`COALESCE(${trendMarkersTable.beatSlug}, ${input.beatSlug ?? null})`,
          title: sql`COALESCE(${trendMarkersTable.title}, ${input.title ?? null})`,
          snippet: sql`COALESCE(${trendMarkersTable.snippet}, ${input.snippet ?? null})`,
          updatedAt: new Date(),
        },
      })
      .returning();

    // Recompute the cluster the marker landed on so velocity/markerCount refresh.
    const effectiveCluster = row?.clusterId ?? clusterId;
    if (effectiveCluster) await recomputeStoryCluster(effectiveCluster);
    return row ?? null;
  } catch (err) {
    logger.warn({ err, url }, "trendMarkers: recordMarker failed");
    return null;
  }
}

export interface RecordRejectedInput {
  url: string;
  reason: string;
  beatSlug?: string | null;
  discoveredVia?: string;
}

/**
 * Record a rejected junk source (aggregator/link-farm). Idempotent by URL: a
 * repeat bumps observationCount + lastSeenAt. Thin, transparency-only. Never
 * throws.
 */
export async function recordRejected(input: RecordRejectedInput): Promise<RejectedSource | null> {
  const url = input.url.trim();
  if (!url) return null;
  try {
    const [row] = await db
      .insert(rejectedSourcesTable)
      .values({
        url,
        domain: hostOf(url),
        reason: input.reason,
        beatSlug: input.beatSlug ?? null,
        discoveredVia: input.discoveredVia ?? "perplexity_search",
      })
      .onConflictDoUpdate({
        target: rejectedSourcesTable.url,
        set: {
          observationCount: sql`${rejectedSourcesTable.observationCount} + 1`,
          lastSeenAt: new Date(),
        },
      })
      .returning();
    return row ?? null;
  } catch (err) {
    logger.warn({ err, url }, "trendMarkers: recordRejected failed");
    return null;
  }
}

export interface ListMarkersFilter {
  status?: TrendMarker["status"];
  platform?: TrendMarkerPlatform;
  beatSlug?: string;
  clusterId?: string;
  limit?: number;
}

/** List trend markers, most-buzzing first (observationCount, then recency). */
export async function listTrendMarkers(filter: ListMarkersFilter = {}): Promise<TrendMarker[]> {
  const where = [];
  if (filter.status) where.push(eq(trendMarkersTable.status, filter.status));
  if (filter.platform) where.push(eq(trendMarkersTable.platform, filter.platform));
  if (filter.beatSlug) where.push(eq(trendMarkersTable.beatSlug, filter.beatSlug));
  if (filter.clusterId) where.push(eq(trendMarkersTable.clusterId, filter.clusterId));
  return db
    .select()
    .from(trendMarkersTable)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(trendMarkersTable.observationCount), desc(trendMarkersTable.lastSeenAt))
    .limit(Math.min(Math.max(filter.limit ?? 100, 1), 500));
}

/** List rejected junk sources, most-recent first. */
export async function listRejectedSources(limit = 100): Promise<RejectedSource[]> {
  return db
    .select()
    .from(rejectedSourcesTable)
    .orderBy(desc(rejectedSourcesTable.lastSeenAt))
    .limit(Math.min(Math.max(limit, 1), 500));
}

export class TrendMarkerError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "TrendMarkerError";
  }
}

/**
 * Escalate a trend marker into the evidence pipeline: enqueue its URL for the
 * normal SSRF-safe ingest (where it is judged on its OWN authority — escalation
 * does NOT grant it evidence status) and mark the marker `escalated`. This is
 * the only path by which a marker can ever contribute to an evidence packet.
 */
export async function escalateMarker(id: string, now: Date = new Date()): Promise<TrendMarker> {
  const [marker] = await db
    .select()
    .from(trendMarkersTable)
    .where(eq(trendMarkersTable.id, id))
    .limit(1);
  if (!marker) throw new TrendMarkerError(404, "Trend marker not found");
  if (marker.status === "escalated") return marker;

  await enqueueUrl(marker.url, {
    discoveredVia: "manual_url",
    leadSnippet: marker.snippet ?? undefined,
    beatSlug: marker.beatSlug ?? undefined,
  });

  const [updated] = await db
    .update(trendMarkersTable)
    .set({ status: "escalated", escalatedAt: now, updatedAt: now })
    .where(eq(trendMarkersTable.id, id))
    .returning();
  // markerCount counts non-dismissed markers, so re-escalating a previously
  // dismissed marker changes the cluster's velocity/markerCount — recompute so
  // ranking doesn't go stale until the next background pass.
  if (marker.status === "dismissed" && marker.clusterId) {
    await recomputeStoryCluster(marker.clusterId, now);
  }
  return updated!;
}

/** Dismiss a trend marker (hide it + drop its velocity contribution). */
export async function dismissMarker(id: string, now: Date = new Date()): Promise<TrendMarker> {
  const [marker] = await db
    .select()
    .from(trendMarkersTable)
    .where(eq(trendMarkersTable.id, id))
    .limit(1);
  if (!marker) throw new TrendMarkerError(404, "Trend marker not found");

  const [updated] = await db
    .update(trendMarkersTable)
    .set({ status: "dismissed", updatedAt: now })
    .where(eq(trendMarkersTable.id, id))
    .returning();
  // Dropping a marker changes its cluster's velocity/markerCount.
  if (marker.clusterId) await recomputeStoryCluster(marker.clusterId, now);
  return updated!;
}

/**
 * Attach not-yet-clustered, observed markers that carry a beat to the best
 * matching active story cluster, then recompute every touched cluster so their
 * velocity/markerCount reflect the buzz. Runs from the cron AFTER clustering (so
 * evidence clusters exist to match against). Bounded per pass; never throws.
 */
export async function associateMarkersToClusters(
  now: Date = new Date(),
  batchSize = 100,
): Promise<{ processed: number; attached: number }> {
  const result = { processed: 0, attached: 0 };
  try {
    const pending = await db
      .select()
      .from(trendMarkersTable)
      .where(
        and(
          isNull(trendMarkersTable.clusterId),
          eq(trendMarkersTable.status, "observed"),
          ne(trendMarkersTable.beatSlug, ""),
        ),
      )
      .orderBy(desc(trendMarkersTable.lastSeenAt))
      .limit(Math.min(Math.max(batchSize, 1), 500));

    const touched = new Set<string>();
    for (const m of pending) {
      result.processed += 1;
      if (!m.beatSlug) continue;
      const text = [m.title ?? "", m.snippet ?? ""].join(" ").trim();
      if (!text) continue;
      const clusterId = await findMatchingClusterForText(m.beatSlug, text);
      if (!clusterId) continue;
      await db
        .update(trendMarkersTable)
        .set({ clusterId, updatedAt: new Date() })
        .where(eq(trendMarkersTable.id, m.id));
      touched.add(clusterId);
      result.attached += 1;
    }
    for (const clusterId of touched) await recomputeStoryCluster(clusterId, now);
  } catch (err) {
    logger.warn({ err }, "trendMarkers: associateMarkersToClusters failed");
  }
  return result;
}

import { db, beatsTable, storyClustersTable, type Beat } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getSiteSettings } from "./siteSettings";
import { enqueueUrl } from "./sourceIngestQueue";
import { listTrendSignals } from "./trends";
import {
  VaultBudgetGuard,
  VaultBudgetExceededError,
  isSourceVaultEnabled,
} from "./sourceVaultBudget";
import { searchWithFallback, isResearchCapabilityAvailable } from "./researchFallback";
import { recordMarker, recordRejected } from "./trendMarkers";
import { beatsCoveredByFeeds } from "./feedWatcher";

// --- Automatic lead discovery (Task #199) -------------------------------
// Turns the vault from manually-fed into an OBSERVER. Each scheduled run:
//   1) enqueues the source URLs behind existing Trend Scout signals (free — no
//      external call), tagged with the signal's beat, and
//   2) if Perplexity is configured, runs a bounded fresh-lead SEARCH per active
//      beat and enqueues the returned URLs, tagged with that beat.
// Everything is FAIL-CLOSED: no live search results → nothing enqueued (we never
// fabricate leads), and the whole pass is bounded by the vault budget guard and
// hard per-run caps. Enqueued URLs are ingested later by the queue drain, so the
// existing SSRF-safe fetch + quality + budget pipeline still governs ingestion.

// ---------------------------------------------------------------------------
// Topical relevance helpers (local to sourceDiscovery; mirrors the equivalent
// helpers in developmentSignalDetector without creating a shared import cycle).
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the","a","an","in","of","on","at","to","for","by","is","are","was","were",
  "be","been","being","have","has","had","do","does","did","will","would","can",
  "could","should","may","might","shall","and","or","but","not","with","from",
  "as","this","that","it","its","also","about","after","before","more","than",
]);

function termBag(titles: (string | null | undefined)[]): Set<string> {
  const bag = new Set<string>();
  for (const t of titles) {
    if (!t) continue;
    for (const raw of t.toLowerCase().split(/\W+/)) {
      if (raw.length >= 3 && !STOP_WORDS.has(raw)) bag.add(raw);
    }
  }
  return bag;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/** Minimum Jaccard overlap for a watched-cluster search lead to be enqueued.
 *  Set low to be permissive — this is a coarse pre-filter to discard obviously
 *  off-topic results (e.g. a broad search returning sports news for a science story). */
const MIN_WATCHED_CLUSTER_LEAD_RELEVANCE = 0.06;

// Bounded per-run caps so one tick stays cheap and quick.
const MAX_BEATS_PER_RUN = 6;
const MAX_LEADS_PER_BEAT = 5;
const MAX_SIGNAL_URLS_PER_RUN = 20;

export interface DiscoveryResult {
  ran: boolean;
  beatsScanned: number;
  signalUrlsEnqueued: number;
  searchLeadsEnqueued: number;
  // Social leads recorded as trend markers (velocity signal only, never ingested).
  trendMarkersRecorded: number;
  // Aggregator/link-farm leads dropped to the rejected log.
  junkRejected: number;
  perplexityUsed: boolean;
  stoppedBy: "disabled" | "budget" | "not_configured" | "done";
}

/** Build a compact, beat-scoped search query for fresh developments. */
function beatQuery(beat: Pick<Beat, "name" | "slant" | "description">): string {
  const focus = [beat.name, beat.slant ?? beat.description ?? ""].filter(Boolean).join(" — ");
  return `Latest developments and breaking news in ${focus}. Recent, newsworthy, specific stories.`;
}

/**
 * Run one bounded discovery pass. Enqueues fresh leads for later ingestion.
 * Never throws — budget/disable/not-configured are reported via `stoppedBy`.
 */
export async function runSourceDiscovery(now: Date = new Date()): Promise<DiscoveryResult> {
  const result: DiscoveryResult = {
    ran: false,
    beatsScanned: 0,
    signalUrlsEnqueued: 0,
    searchLeadsEnqueued: 0,
    trendMarkersRecorded: 0,
    junkRejected: 0,
    perplexityUsed: false,
    stoppedBy: "done",
  };

  const settings = await getSiteSettings();
  if (!isSourceVaultEnabled() || !settings.sourceDiscoveryEnabled) {
    result.stoppedBy = "disabled";
    return result;
  }
  result.ran = true;

  // --- Step 1: enqueue Trend Scout signal source URLs (free) --------------
  try {
    const signals = await listTrendSignals({ status: "new" });
    let count = 0;
    for (const sig of signals) {
      if (count >= MAX_SIGNAL_URLS_PER_RUN) break;
      if (!sig.sourceUrl || !sig.beatSlug) continue;
      try {
        const { enqueued } = await enqueueUrl(sig.sourceUrl, {
          discoveredVia: "trend_signal",
          beatSlug: sig.beatSlug,
          leadSnippet: sig.headline,
        });
        if (enqueued) result.signalUrlsEnqueued += 1;
        count += 1;
      } catch (err) {
        logger.warn({ err, url: sig.sourceUrl }, "sourceDiscovery: enqueue signal URL failed");
      }
    }
  } catch (err) {
    logger.warn({ err }, "sourceDiscovery: listing trend signals failed");
  }

  // --- Step 2: fresh-lead search per active beat (Perplexity, with Claude
  // fallback when Perplexity is unconfigured or erroring — Task #341) --------
  if (!(await isResearchCapabilityAvailable())) {
    result.stoppedBy = "not_configured";
    return result;
  }

  let guard: VaultBudgetGuard;
  try {
    guard = await VaultBudgetGuard.start("source discovery", { paid: true, now });
  } catch (err) {
    result.stoppedBy = err instanceof VaultBudgetExceededError ? "budget" : "disabled";
    if (!(err instanceof VaultBudgetExceededError)) {
      logger.warn({ err }, "sourceDiscovery: budget guard failed to start");
    }
    return result;
  }

  const beats = await db
    .select()
    .from(beatsTable)
    .orderBy(beatsTable.sortOrder)
    .limit(MAX_BEATS_PER_RUN);

  const defWindow =
    settings.sourceFreshnessDefaultDays > 0 ? settings.sourceFreshnessDefaultDays : 7;

  // Feeds first, Perplexity as gap-filler (Task #227): a beat already served by
  // an enabled known-source feed is refilled deterministically by the feed
  // watcher, so skip the PAID Perplexity search for it here.
  let coveredBeats: Set<string>;
  try {
    coveredBeats = await beatsCoveredByFeeds();
  } catch (err) {
    logger.warn({ err }, "sourceDiscovery: could not load feed coverage; not skipping any beat");
    coveredBeats = new Set();
  }

  for (const beat of beats) {
    if (coveredBeats.has(beat.slug)) continue;
    try {
      await guard.check(now);
    } catch (err) {
      result.stoppedBy = err instanceof VaultBudgetExceededError ? "budget" : "disabled";
      return result;
    }

    const recencyDays = settings.sourceFreshnessByBeat[beat.slug] ?? defWindow;
    let leads;
    try {
      const allowedDomains = settings.sourceDiscoveryAllowedDomains ?? [];
      leads = await searchWithFallback(beatQuery(beat), {
        maxResults: MAX_LEADS_PER_BEAT,
        recencyDays,
        domains: allowedDomains.length > 0 ? allowedDomains : undefined,
      });
      result.perplexityUsed = true;
    } catch (err) {
      // Fail closed for this beat: no results → nothing enqueued.
      logger.warn({ err, beat: beat.slug }, "sourceDiscovery: perplexity search failed for beat");
      continue;
    }
    result.beatsScanned += 1;

    for (const lead of leads) {
      if (!lead.url) continue;
      // Three-way routing (Task #227): evidence → ingest queue; trend markers →
      // recorded for velocity/Trend Radar only (never ingested); junk → dropped
      // to the rejected log. Nothing is silently discarded.
      try {
        if (lead.role === "trend_marker") {
          await recordMarker({
            url: lead.url,
            title: lead.title || null,
            snippet: lead.snippet || null,
            beatSlug: beat.slug,
            discoveredVia: "perplexity_search",
            platform: lead.platform ?? undefined,
          });
          result.trendMarkersRecorded += 1;
          continue;
        }
        if (lead.role === "rejected_junk") {
          await recordRejected({
            url: lead.url,
            reason: lead.roleReason,
            beatSlug: beat.slug,
            discoveredVia: "perplexity_search",
          });
          result.junkRejected += 1;
          continue;
        }
        const { enqueued } = await enqueueUrl(lead.url, {
          discoveredVia: "perplexity_search",
          beatSlug: beat.slug,
          leadSnippet: lead.snippet || lead.title || null,
        });
        if (enqueued) result.searchLeadsEnqueued += 1;
      } catch (err) {
        logger.warn({ err, url: lead.url }, "sourceDiscovery: route search lead failed");
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Watched-cluster targeted discovery
// ---------------------------------------------------------------------------

// No per-run cap on watched clusters — process every actively-watched cluster
// so the editorial "always-on boost" applies uniformly. The per-cluster lead
// cap and budget guard keep cost bounded.
const MAX_WATCHED_CLUSTERS_PER_RUN = 20;
const MAX_LEADS_PER_WATCHED_CLUSTER = 10;

/**
 * Runs targeted Perplexity searches for each actively-watched story cluster,
 * enqueuing fresh leads into the source ingest queue. Called AFTER the main
 * beat-level discovery pass so watched stories get an extra ingestion push
 * on every cron tick where discovery is enabled.
 *
 * Fail-safe: any per-cluster error is logged and skipped; the whole pass
 * never throws.
 */
export async function runWatchedClusterDiscovery(
  _now: Date = new Date(),
): Promise<{ clustersScanned: number; leadsEnqueued: number }> {
  const result = { clustersScanned: 0, leadsEnqueued: 0 };
  if (!isSourceVaultEnabled() || !isResearchCapabilityAvailable()) return result;

  const watchedClusters = await db
    .select({
      id: storyClustersTable.id,
      label: storyClustersTable.label,
      beatSlug: storyClustersTable.beatSlug,
    })
    .from(storyClustersTable)
    .where(and(eq(storyClustersTable.watched, true), eq(storyClustersTable.status, "active")));

  for (const cluster of watchedClusters) {
    result.clustersScanned++;
    const query = `Latest breaking news and new developments: ${cluster.label}`;
    let leads;
    try {
      leads = await searchWithFallback(query, {
        maxResults: MAX_LEADS_PER_WATCHED_CLUSTER,
        recencyDays: 2,
      });
    } catch (err) {
      logger.warn({ err, clusterId: cluster.id }, "watchedClusterDiscovery: search failed; skipping cluster");
      continue;
    }

    // Pre-compute cluster term bag once per cluster for the Jaccard pre-screen.
    const clusterTerms = termBag([cluster.label]);

    for (const lead of leads) {
      if (!lead.url) continue;
      if (lead.role === "trend_marker" || lead.role === "rejected_junk") continue;

      // Jaccard topical relevance pre-screen: skip leads whose title+snippet
      // share < MIN_WATCHED_CLUSTER_LEAD_RELEVANCE term overlap with the
      // cluster label. This drops clearly off-topic search results before they
      // enter the ingest queue — the vault drain doesn't need to waste a fetch
      // cycle on them and the signal detector sees cleaner evidence.
      const leadTerms = termBag([lead.title, lead.snippet]);
      const relevance = clusterTerms.size > 0 ? jaccardSimilarity(clusterTerms, leadTerms) : 1;
      if (relevance < MIN_WATCHED_CLUSTER_LEAD_RELEVANCE) {
        logger.debug(
          { url: lead.url, clusterId: cluster.id, relevance },
          "watchedClusterDiscovery: lead below topical relevance threshold, skipping",
        );
        continue;
      }

      try {
        const { enqueued } = await enqueueUrl(lead.url, {
          // "watched_cluster_search" items are drained before standard
          // perplexity_search leads (prioritized in claimBatch ORDER BY).
          discoveredVia: "watched_cluster_search",
          beatSlug: cluster.beatSlug,
          leadSnippet: lead.snippet || lead.title || null,
        });
        if (enqueued) result.leadsEnqueued++;
      } catch (err) {
        logger.warn({ err, url: lead.url }, "watchedClusterDiscovery: enqueue failed");
      }
    }
  }

  if (result.clustersScanned > 0) {
    logger.info(result, "watchedClusterDiscovery: targeted discovery pass complete");
  }
  return result;
}

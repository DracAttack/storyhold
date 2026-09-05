import {
  db,
  trendMarkersTable,
  type TrendMarker,
  type TrendMarkerPlatform,
} from "@workspace/db";
import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getSiteSettings, type SiteSettingsValues } from "./siteSettings";
import { enqueueUrl } from "./sourceIngestQueue";
import {
  VaultBudgetGuard,
  VaultBudgetExceededError,
  isSourceVaultEnabled,
} from "./sourceVaultBudget";
import { type SearchLead } from "./perplexity";
import { searchWithFallback, isResearchCapabilityAvailable } from "./researchFallback";
import { semanticSearch } from "./sourceVault";
import { recordMarker, recordRejected, TrendMarkerError } from "./trendMarkers";
import { tokens, jaccard } from "./dedupe";

// --- Hot-marker source harvest (Task #236) ------------------------------
// A HOT trend-marker topic is buzz worth investigating: a story that social
// platforms are talking about a lot. Discovery already records those social
// observations as trend markers (velocity signal only). This turns that buzz
// into cheap, citable EVIDENCE — WITHOUT ever ingesting the social URL itself.
//
// When a topic crosses the buzz thresholds (a single marker at
// observationCount >= obsThreshold, OR a topic seen across >= platformThreshold
// distinct platforms) a bounded harvest runs:
//   1) FREE Source Vault semantic lookup on the topic (title/snippet/beat). If
//      the vault already covers the story well, stop — no paid call.
//   2) Otherwise a budget-gated Perplexity search on the SAME topic text,
//      restricted to sourceDiscoveryAllowedDomains, NEVER the social URL.
//   3) Route every returned lead exactly like runSourceDiscovery: evidence →
//      enqueueUrl (ingest queue), trend_marker → recordMarker (velocity only),
//      rejected_junk → recordRejected.
// Triggering markers are marked `investigated` (with a cooldown timestamp +
// short result summary) so a topic is harvested at most once per cooldown.
//
// This is DISTINCT from Escalate (which ingests a marker's OWN url) and from
// hot→article (this never drafts). Everything is FAIL-CLOSED: disabled,
// unconfigured (no Perplexity), or over-budget → nothing happens. Never throws
// from the scheduled path.

// Bounded per-run caps so one tick stays cheap and quick.
const MAX_TOPICS_PER_RUN = 4;
const MAX_LEADS_PER_TOPIC = 6;
// A topic is not re-harvested while any of its markers was investigated within
// this window (cooldown). Keeps a persistently-buzzing story from re-harvesting
// every tick.
const HARVEST_COOLDOWN_HOURS = 72;
// Minimum lexical overlap for two unclustered markers to be treated as the same
// topic (fallback grouping when markers have no story cluster).
const LEXICAL_TOPIC_MIN_JACCARD = 0.3;
// If the free vault lookup already returns this many strongly-similar chunks the
// story is considered covered and the PAID Perplexity search is skipped.
const VAULT_COVERED_MIN_HITS = 3;
const VAULT_COVERED_MIN_SIMILARITY = 0.6;
const VAULT_LOOKUP_LIMIT = 8;
// Recency window (days) for the topic Perplexity search when the topic has no
// beat-specific override — hot buzz is recent by definition.
const DEFAULT_HARVEST_RECENCY_DAYS = 7;

/** Why a topic was flagged hot (for logging + the marker's summary). */
export type HotReason = "observation_count" | "multi_platform";

/** A hot marker topic: one or more markers about the same buzzing story. */
export interface HotTopic {
  // Stable key: the cluster id, or "lex:<markerId>" for lexical groups.
  key: string;
  clusterId: string | null;
  beatSlug: string | null;
  // All non-dismissed markers in the topic (for platform counting + context).
  markers: TrendMarker[];
  // The currently-observed markers we will flip to `investigated` on harvest.
  triggerMarkerIds: string[];
  reason: HotReason;
  // Distinct social platforms the topic has been seen on.
  platformCount: number;
  // Highest single-marker observation count in the topic.
  maxObservations: number;
  // The search text mined from the hottest marker (title/snippet + beat).
  queryText: string;
}

export interface HarvestOutcome {
  ran: boolean;
  vaultHits: number;
  vaultCovered: boolean;
  perplexityUsed: boolean;
  leadsEnqueued: number;
  markersRecorded: number;
  junkRejected: number;
  markersInvestigated: number;
  stoppedBy: "disabled" | "budget" | "not_configured" | "vault_covered" | "done";
  summary: string;
}

export interface HotHarvestResult {
  ran: boolean;
  topicsConsidered: number;
  topicsHarvested: number;
  leadsEnqueued: number;
  markersRecorded: number;
  junkRejected: number;
  markersInvestigated: number;
  perplexityUsed: boolean;
  stoppedBy: "disabled" | "budget" | "not_configured" | "done";
}

/**
 * Injectable side-effecting dependencies of a harvest. Production defaults to the
 * real vault lookup / Perplexity search / budget guard; tests pass fakes so the
 * concurrency + budget behaviour can be exercised without any network call.
 */
export interface HarvestDeps {
  vaultLookup?: (query: string, opts: { limit: number }) => Promise<{ similarity: number }[]>;
  search?: (
    query: string,
    opts: { maxResults: number; recencyDays: number; domains?: string[] },
  ) => Promise<SearchLead[]>;
  startGuard?: (
    label: string,
    opts: { paid: boolean; now: Date },
  ) => Promise<{ check: (now: Date) => Promise<void> }>;
}

function platformOf(m: TrendMarker): TrendMarkerPlatform {
  return m.platform;
}

/** Build the topic search text from a marker's title/snippet (never its URL). */
function topicQuery(marker: TrendMarker): string {
  const title = (marker.title ?? "").trim();
  const snippet = (marker.snippet ?? "").trim();
  const core = [title, snippet].filter(Boolean).join(". ").slice(0, 400);
  const beat = (marker.beatSlug ?? "").trim();
  const focus = beat ? ` (${beat.replace(/-/g, " ")})` : "";
  const base = core || title || snippet;
  if (!base) return "";
  return `Latest reporting and primary sources on: ${base}${focus}. Recent, specific, citable coverage.`;
}

/** The hottest marker in a group (most observations, then most recent). */
function hottestMarker(markers: TrendMarker[]): TrendMarker {
  return [...markers].sort((a, b) => {
    if (b.observationCount !== a.observationCount) return b.observationCount - a.observationCount;
    return new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime();
  })[0]!;
}

/**
 * Detect hot marker topics eligible for harvest. Groups candidate markers by
 * story cluster; still-unclustered markers fall back to greedy lexical topic
 * grouping (shared title/snippet tokens). A topic is hot when any member marker
 * hits the observation threshold OR the group spans enough distinct platforms.
 * Topics whose markers were investigated within the cooldown are skipped. Pure
 * read + never throws.
 */
export async function detectHotTopics(
  settings: SiteSettingsValues,
  now: Date = new Date(),
): Promise<HotTopic[]> {
  const obsThreshold = Math.max(settings.hotMarkerObservationThreshold, 1);
  const platformThreshold = Math.max(settings.hotMarkerPlatformThreshold, 1);
  const cooldownCutoff = new Date(now.getTime() - HARVEST_COOLDOWN_HOURS * 3600_000);

  let rows: TrendMarker[];
  try {
    // Candidate markers: currently observed (never escalated/dismissed/already
    // investigated) and not investigated within the cooldown window. status
    // becomes `investigated` after a harvest so re-harvest is naturally gated;
    // the cooldown clause additionally protects topics with mixed member state.
    rows = await db
      .select()
      .from(trendMarkersTable)
      .where(
        and(
          eq(trendMarkersTable.status, "observed"),
          or(
            isNull(trendMarkersTable.investigatedAt),
            lt(trendMarkersTable.investigatedAt, cooldownCutoff),
          ),
        ),
      )
      .orderBy(desc(trendMarkersTable.observationCount), desc(trendMarkersTable.lastSeenAt))
      .limit(500);
  } catch (err) {
    logger.warn({ err }, "sourceHarvest: detectHotTopics query failed");
    return [];
  }
  if (rows.length === 0) return [];

  // Recent investigation timestamps per cluster, so a clustered topic in
  // cooldown (some members already investigated recently) is not re-harvested.
  const recentlyInvestigatedClusters = new Set<string>();
  try {
    const recent = await db
      .select({ clusterId: trendMarkersTable.clusterId })
      .from(trendMarkersTable)
      .where(
        and(
          ne(trendMarkersTable.status, "dismissed"),
          sql`${trendMarkersTable.investigatedAt} IS NOT NULL`,
          sql`${trendMarkersTable.investigatedAt} >= ${cooldownCutoff}`,
        ),
      );
    for (const r of recent) if (r.clusterId) recentlyInvestigatedClusters.add(r.clusterId);
  } catch (err) {
    logger.warn({ err }, "sourceHarvest: cooldown lookup failed");
  }

  const topics: HotTopic[] = [];

  // --- Clustered markers: group by clusterId -----------------------------
  const byCluster = new Map<string, TrendMarker[]>();
  const unclustered: TrendMarker[] = [];
  for (const m of rows) {
    if (m.clusterId) {
      const list = byCluster.get(m.clusterId) ?? [];
      list.push(m);
      byCluster.set(m.clusterId, list);
    } else {
      unclustered.push(m);
    }
  }

  for (const [clusterId, markers] of byCluster) {
    if (recentlyInvestigatedClusters.has(clusterId)) continue;
    const topic = evaluateGroup(clusterId, clusterId, markers, obsThreshold, platformThreshold);
    if (topic) topics.push(topic);
  }

  // --- Unclustered markers: greedy lexical topic grouping ----------------
  const used = new Set<string>();
  const tokenized = unclustered.map((m) => ({
    marker: m,
    toks: tokens([m.title ?? "", m.snippet ?? ""].join(" ")),
  }));
  for (let i = 0; i < tokenized.length; i++) {
    const head = tokenized[i]!;
    if (used.has(head.marker.id)) continue;
    used.add(head.marker.id);
    const group = [head.marker];
    for (let j = i + 1; j < tokenized.length; j++) {
      const cand = tokenized[j]!;
      if (used.has(cand.marker.id)) continue;
      if (head.toks.size === 0 || cand.toks.size === 0) continue;
      if (jaccard(head.toks, cand.toks) >= LEXICAL_TOPIC_MIN_JACCARD) {
        group.push(cand.marker);
        used.add(cand.marker.id);
      }
    }
    const topic = evaluateGroup(
      `lex:${head.marker.id}`,
      null,
      group,
      obsThreshold,
      platformThreshold,
    );
    if (topic) topics.push(topic);
  }

  // Hottest topics first, capped per run.
  topics.sort((a, b) => {
    if (b.maxObservations !== a.maxObservations) return b.maxObservations - a.maxObservations;
    return b.platformCount - a.platformCount;
  });
  return topics.slice(0, MAX_TOPICS_PER_RUN);
}

/** Decide if a marker group is hot; build the HotTopic when it is. */
function evaluateGroup(
  key: string,
  clusterId: string | null,
  markers: TrendMarker[],
  obsThreshold: number,
  platformThreshold: number,
): HotTopic | null {
  if (markers.length === 0) return null;
  const platforms = new Set<TrendMarkerPlatform>();
  let maxObs = 0;
  for (const m of markers) {
    platforms.add(platformOf(m));
    if (m.observationCount > maxObs) maxObs = m.observationCount;
  }
  const byObservation = maxObs >= obsThreshold;
  const byPlatform = platforms.size >= platformThreshold;
  if (!byObservation && !byPlatform) return null;

  const hottest = hottestMarker(markers);
  const queryText = topicQuery(hottest);
  if (!queryText) return null;

  return {
    key,
    clusterId,
    beatSlug: hottest.beatSlug ?? markers.find((m) => m.beatSlug)?.beatSlug ?? null,
    markers,
    // Flip every currently-observed member to investigated so the whole topic
    // shares the cooldown clock (not just the single hottest marker).
    triggerMarkerIds: markers.filter((m) => m.status === "observed").map((m) => m.id),
    reason: byObservation ? "observation_count" : "multi_platform",
    platformCount: platforms.size,
    maxObservations: maxObs,
    queryText,
  };
}

/**
 * Harvest a single hot topic: FREE vault lookup first, then (only if needed and
 * in budget) a Perplexity topic search restricted to the domain allowlist, with
 * three-way lead routing. Marks the topic's trigger markers `investigated` with
 * a cooldown timestamp + summary. Never ingests the marker's own social URL.
 * Never throws.
 */
export async function harvestTopic(
  topic: HotTopic,
  settings: SiteSettingsValues,
  now: Date = new Date(),
  opts: { requireClaim?: boolean; deps?: HarvestDeps } = {},
): Promise<HarvestOutcome> {
  const requireClaim = opts.requireClaim ?? false;
  const deps = opts.deps ?? {};
  const vaultLookup = deps.vaultLookup ?? ((q, o) => semanticSearch(q, o));
  const search = deps.search ?? ((q, o) => searchWithFallback(q, o));
  const startGuard =
    deps.startGuard ?? ((label, o) => VaultBudgetGuard.start(label, o));
  const outcome: HarvestOutcome = {
    ran: false,
    vaultHits: 0,
    vaultCovered: false,
    perplexityUsed: false,
    leadsEnqueued: 0,
    markersRecorded: 0,
    junkRejected: 0,
    markersInvestigated: 0,
    stoppedBy: "done",
    summary: "",
  };

  if (!isSourceVaultEnabled()) {
    outcome.stoppedBy = "disabled";
    return outcome;
  }
  outcome.ran = true;

  if (!topic.queryText.trim()) {
    // Nothing to search on (marker had no title/snippet). Mark investigated so
    // it doesn't keep re-qualifying, but spend nothing.
    outcome.summary = "no topic text to search";
    await markInvestigated(topic, outcome, now);
    return outcome;
  }

  // --- Step 1: FREE Source Vault semantic lookup on the topic ------------
  // If the vault already covers this story we skip the paid Perplexity call.
  try {
    const hits = await vaultLookup(topic.queryText, { limit: VAULT_LOOKUP_LIMIT });
    outcome.vaultHits = hits.length;
    const strong = hits.filter((h) => h.similarity >= VAULT_COVERED_MIN_SIMILARITY);
    if (strong.length >= VAULT_COVERED_MIN_HITS) {
      outcome.vaultCovered = true;
    }
  } catch (err) {
    // Embedding not configured / disabled / budget → treat as "no vault
    // coverage" and fall through to the (still-gated) Perplexity search.
    logger.debug({ err, topic: topic.key }, "sourceHarvest: vault lookup unavailable");
  }

  if (outcome.vaultCovered) {
    outcome.stoppedBy = "vault_covered";
    outcome.summary = `vault already covers (${outcome.vaultHits} hits) — no search`;
    await markInvestigated(topic, outcome, now);
    return outcome;
  }

  // --- Step 2: budget-gated topic search (Perplexity, Claude fallback) ---
  if (!deps.search && !(await isResearchCapabilityAvailable())) {
    outcome.stoppedBy = "not_configured";
    outcome.summary = `vault miss (${outcome.vaultHits} hits); no research provider configured`;
    // Nothing spent, nothing found — still mark investigated so we don't retry
    // the same dead topic every tick (cooldown applies).
    await markInvestigated(topic, outcome, now);
    return outcome;
  }

  let guard: { check: (now: Date) => Promise<void> };
  try {
    guard = await startGuard(`hot-marker harvest ${topic.key}`, { paid: true, now });
  } catch (err) {
    outcome.stoppedBy = err instanceof VaultBudgetExceededError ? "budget" : "disabled";
    if (!(err instanceof VaultBudgetExceededError)) {
      logger.warn({ err, topic: topic.key }, "sourceHarvest: budget guard failed to start");
    }
    // Do NOT mark investigated on budget stop — retry next window when budget frees.
    return outcome;
  }

  let leads;
  try {
    await guard.check(now);

    // --- ATOMIC CLAIM before the paid search ----------------------------
    // Flip this topic's currently-observed trigger markers to `investigated`
    // in ONE atomic UPDATE ... WHERE status = 'observed'. Row locks let at most
    // one concurrent runner win the flip; the rest get zero rows back. This is
    // the single choke point that guarantees a hot topic is harvested at most
    // once: when a run loses the claim (`claimed === 0`) another run is already
    // (or has just finished) harvesting this exact topic, so we ABORT here —
    // BEFORE spending a cent on Perplexity — instead of double-harvesting under
    // racing cron ticks or rapid "Investigate" clicks. Manual re-investigation
    // of an already-investigated marker passes requireClaim=false so an explicit
    // admin action can still (re)run even though nothing flips.
    const claimed = await claimTopicMarkers(topic, now);
    outcome.markersInvestigated = claimed;
    if (requireClaim && claimed === 0) {
      outcome.stoppedBy = "done";
      outcome.summary = "skipped: topic already harvested by a concurrent run";
      return outcome;
    }

    const allowedDomains = settings.sourceDiscoveryAllowedDomains ?? [];
    const recencyDays =
      (topic.beatSlug ? settings.sourceFreshnessByBeat[topic.beatSlug] : undefined) ??
      (settings.sourceFreshnessDefaultDays > 0
        ? settings.sourceFreshnessDefaultDays
        : DEFAULT_HARVEST_RECENCY_DAYS);
    leads = await search(topic.queryText, {
      maxResults: MAX_LEADS_PER_TOPIC,
      recencyDays,
      domains: allowedDomains.length > 0 ? allowedDomains : undefined,
    });
    outcome.perplexityUsed = true;
  } catch (err) {
    if (err instanceof VaultBudgetExceededError) {
      outcome.stoppedBy = "budget";
      return outcome;
    }
    // Fail closed: no results → nothing enqueued. The topic is already claimed
    // (investigated) above, so just refresh the summary (cooldown still applies)
    // so a flaky/empty topic doesn't hammer the search every tick.
    logger.warn({ err, topic: topic.key }, "sourceHarvest: perplexity search failed");
    outcome.summary = `search failed (vault ${outcome.vaultHits} hits)`;
    await stampHarvestSummary(topic, outcome.summary, now);
    return outcome;
  }

  // Never re-observe the topic's OWN social URLs as fresh evidence. Discovery's
  // classifier already routes social URLs to trend_marker (recordMarker), not
  // the ingest queue, but guard explicitly against enqueueing a known marker URL.
  const markerUrls = new Set(topic.markers.map((m) => m.url));

  for (const lead of leads) {
    if (!lead.url) continue;
    try {
      if (lead.role === "trend_marker") {
        await recordMarker({
          url: lead.url,
          title: lead.title || null,
          snippet: lead.snippet || null,
          beatSlug: topic.beatSlug ?? undefined,
          discoveredVia: "hot_marker_harvest",
          platform: lead.platform ?? undefined,
        });
        outcome.markersRecorded += 1;
        continue;
      }
      if (lead.role === "rejected_junk") {
        await recordRejected({
          url: lead.url,
          reason: lead.roleReason,
          beatSlug: topic.beatSlug ?? undefined,
          discoveredVia: "hot_marker_harvest",
        });
        outcome.junkRejected += 1;
        continue;
      }
      // evidence → ingest queue (SSRF-safe fetch + quality + budget still gate
      // the actual ingestion later). Skip the social URL itself defensively.
      if (markerUrls.has(lead.url)) continue;
      const { enqueued } = await enqueueUrl(lead.url, {
        discoveredVia: "hot_marker_harvest",
        beatSlug: topic.beatSlug ?? undefined,
        leadSnippet: lead.snippet || lead.title || null,
      });
      if (enqueued) outcome.leadsEnqueued += 1;
    } catch (err) {
      logger.warn({ err, url: lead.url }, "sourceHarvest: route lead failed");
    }
  }

  outcome.summary =
    `${outcome.leadsEnqueued} leads enqueued, ${outcome.markersRecorded} marker(s), ` +
    `${outcome.junkRejected} junk (vault: ${outcome.vaultHits} hits)`;
  // The topic was already claimed (flipped to `investigated`) before the paid
  // search; just refresh the summary — do NOT re-flip (that would zero out the
  // claimed count and race a concurrent re-observation).
  await stampHarvestSummary(topic, outcome.summary, now);
  return outcome;
}

/** Flip the topic's trigger markers to `investigated`, stamping the cooldown. */
async function markInvestigated(
  topic: HotTopic,
  outcome: HarvestOutcome,
  now: Date,
): Promise<void> {
  if (topic.triggerMarkerIds.length === 0) return;
  const summary = outcome.summary || "harvest ran";
  try {
    const updated = await db
      .update(trendMarkersTable)
      .set({ status: "investigated", investigatedAt: now, harvestSummary: summary, updatedAt: now })
      .where(
        and(
          inArray(trendMarkersTable.id, topic.triggerMarkerIds),
          eq(trendMarkersTable.status, "observed"),
        ),
      )
      .returning({ id: trendMarkersTable.id });
    outcome.markersInvestigated = updated.length;
  } catch (err) {
    logger.warn({ err, topic: topic.key }, "sourceHarvest: markInvestigated failed");
  }
}

/**
 * Atomically CLAIM a topic for harvest just before the paid Perplexity search:
 * flip its currently-observed trigger markers to `investigated` and stamp the
 * cooldown, returning how many rows this run actually flipped. Because the
 * UPDATE ... WHERE status = 'observed' takes per-row locks, at most one of many
 * concurrent runners can flip a given marker — the rest get 0 back and know a
 * peer is already harvesting the topic. A provisional summary is written now; the
 * real result overwrites it via stampHarvestSummary once the harvest finishes.
 */
async function claimTopicMarkers(topic: HotTopic, now: Date): Promise<number> {
  if (topic.triggerMarkerIds.length === 0) return 0;
  try {
    const updated = await db
      .update(trendMarkersTable)
      .set({
        status: "investigated",
        investigatedAt: now,
        harvestSummary: "harvesting…",
        updatedAt: now,
      })
      .where(
        and(
          inArray(trendMarkersTable.id, topic.triggerMarkerIds),
          eq(trendMarkersTable.status, "observed"),
        ),
      )
      .returning({ id: trendMarkersTable.id });
    return updated.length;
  } catch (err) {
    logger.warn({ err, topic: topic.key }, "sourceHarvest: claimTopicMarkers failed");
    return 0;
  }
}

/** Refresh the harvest summary on the topic's already-investigated markers. */
async function stampHarvestSummary(topic: HotTopic, summary: string, now: Date): Promise<void> {
  if (topic.triggerMarkerIds.length === 0) return;
  try {
    await db
      .update(trendMarkersTable)
      .set({ harvestSummary: summary, updatedAt: now })
      .where(
        and(
          inArray(trendMarkersTable.id, topic.triggerMarkerIds),
          eq(trendMarkersTable.status, "investigated"),
        ),
      );
  } catch (err) {
    logger.warn({ err, topic: topic.key }, "sourceHarvest: stampHarvestSummary failed");
  }
}

/**
 * One bounded scheduled pass: detect hot topics and harvest them. Gated by the
 * site setting + Source Vault kill-switch; fail-closed and never throws (the
 * cron catches too, but this is defensive). Perplexity-not-configured is fine —
 * the vault-only lookups still run for free.
 */
export async function runHotMarkerHarvest(
  now: Date = new Date(),
  deps: HarvestDeps = {},
): Promise<HotHarvestResult> {
  const result: HotHarvestResult = {
    ran: false,
    topicsConsidered: 0,
    topicsHarvested: 0,
    leadsEnqueued: 0,
    markersRecorded: 0,
    junkRejected: 0,
    markersInvestigated: 0,
    perplexityUsed: false,
    stoppedBy: "done",
  };
  try {
    const settings = await getSiteSettings();
    if (!isSourceVaultEnabled() || !settings.hotMarkerHarvestEnabled) {
      result.stoppedBy = "disabled";
      return result;
    }
    result.ran = true;

    const topics = await detectHotTopics(settings, now);
    result.topicsConsidered = topics.length;
    for (const topic of topics) {
      // Scheduled topics are always driven by currently-observed markers, so the
      // atomic claim is required: if a peer run already claimed the topic we skip
      // it (no double search / spend) rather than harvest it again.
      const outcome = await harvestTopic(topic, settings, now, { requireClaim: true, deps });
      if (outcome.perplexityUsed) result.perplexityUsed = true;
      result.leadsEnqueued += outcome.leadsEnqueued;
      result.markersRecorded += outcome.markersRecorded;
      result.junkRejected += outcome.junkRejected;
      result.markersInvestigated += outcome.markersInvestigated;
      if (outcome.markersInvestigated > 0 || outcome.leadsEnqueued > 0) result.topicsHarvested += 1;
      // Stop the whole pass cleanly the moment the budget is exhausted.
      if (outcome.stoppedBy === "budget") {
        result.stoppedBy = "budget";
        break;
      }
      if (outcome.stoppedBy === "not_configured") result.stoppedBy = "not_configured";
    }
  } catch (err) {
    logger.error({ err }, "sourceHarvest: runHotMarkerHarvest failed");
  }
  return result;
}

/**
 * Manually harvest the buzz around ONE marker on demand ("Investigate this
 * buzz"). Runs the SAME harvest routine, scoped to the marker's cluster (or the
 * marker alone). Bypasses the hotMarkerHarvestEnabled toggle (an explicit admin
 * action) but still respects the Source Vault kill-switch + budget (fail-closed).
 * Throws TrendMarkerError(404) when the marker is missing.
 */
export async function investigateMarker(
  id: string,
  now: Date = new Date(),
  deps: HarvestDeps = {},
): Promise<{ marker: TrendMarker; outcome: HarvestOutcome }> {
  const [marker] = await db
    .select()
    .from(trendMarkersTable)
    .where(eq(trendMarkersTable.id, id))
    .limit(1);
  if (!marker) throw new TrendMarkerError(404, "Trend marker not found");
  if (marker.status === "dismissed") {
    throw new TrendMarkerError(409, "Cannot investigate a dismissed marker");
  }
  // When the chosen marker is still `observed`, the harvest is a genuine
  // first-investigation and MUST win the atomic claim — so two rapid
  // "Investigate" clicks (or a click racing the cron) can't both search/spend.
  // A re-investigation of an already-investigated / escalated marker is an
  // explicit admin re-run: nothing flips, so we don't gate it on the claim.
  const requireClaim = marker.status === "observed";

  const settings = await getSiteSettings();

  // Scope the harvest to the marker's whole cluster when it has one, so the
  // topic (not just this one URL) drives the query + cooldown.
  let markers: TrendMarker[] = [marker];
  if (marker.clusterId) {
    try {
      markers = await db
        .select()
        .from(trendMarkersTable)
        .where(
          and(
            eq(trendMarkersTable.clusterId, marker.clusterId),
            ne(trendMarkersTable.status, "dismissed"),
          ),
        );
      if (markers.length === 0) markers = [marker];
    } catch {
      markers = [marker];
    }
  }

  const platforms = new Set(markers.map((m) => m.platform));
  const maxObs = Math.max(...markers.map((m) => m.observationCount));
  const hottest = hottestMarker(markers);
  const topic: HotTopic = {
    key: marker.clusterId ?? `manual:${marker.id}`,
    clusterId: marker.clusterId,
    beatSlug: hottest.beatSlug ?? markers.find((m) => m.beatSlug)?.beatSlug ?? null,
    markers,
    reason:
      maxObs >= settings.hotMarkerObservationThreshold ? "observation_count" : "multi_platform",
    platformCount: platforms.size,
    maxObservations: maxObs,
    // Include the chosen marker so, if it is currently observed, it flips to
    // investigated with the rest of the topic.
    triggerMarkerIds: Array.from(
      new Set([marker.id, ...markers.filter((m) => m.status === "observed").map((m) => m.id)]),
    ),
    queryText: topicQuery(hottest),
  };

  const outcome = await harvestTopic(topic, settings, now, { requireClaim, deps });

  // Manual re-investigation always refreshes the chosen marker's timestamp +
  // summary (even when it was already investigated / escalated) so the admin
  // sees the latest harvest result. Status is only ever flipped observed →
  // investigated (handled inside harvestTopic); never demoted here.
  try {
    await db
      .update(trendMarkersTable)
      .set({
        investigatedAt: now,
        harvestSummary: outcome.summary || "harvest ran",
        updatedAt: now,
      })
      .where(eq(trendMarkersTable.id, id));
  } catch (err) {
    logger.warn({ err, id }, "sourceHarvest: refresh chosen marker failed");
  }

  const [refreshed] = await db
    .select()
    .from(trendMarkersTable)
    .where(eq(trendMarkersTable.id, id))
    .limit(1);
  return { marker: refreshed ?? marker, outcome };
}

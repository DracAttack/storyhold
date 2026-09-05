import { db } from "@workspace/db";
import { articlesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  runDailyPipeline,
  publishDueArticles,
  autoApproveStaleIdeas,
  autoLockStaleDrafts,
  runBackCatalogueMaintenance,
  purgeOldPageViews,
} from "./articles";
import { sendWeeklyNewsletterToAll } from "./weeklyNewsletter";
import { startDuplicateScan } from "./duplicateScan";
import { getSiteSettings } from "./siteSettings";
import { claimJobPeriod } from "./cronClaim";
import { postNextDueSlot, generateMissingSocialPacks } from "./socialQueue";
import { postNextDueMeme } from "./memeQueue";
import { runTermOfDay } from "./termOfDay";
import { isZernioConfigured } from "./social";
import { drainIngestQueue, markStaleDocuments } from "./sourceIngestQueue";
import { reconcileHarvestedSources } from "./backCatalogHarvest";
import {
  recheckActiveDocuments,
  reembedExtractedDocuments,
  repairMisclassifiedReviewArticles,
} from "./sourceVault";
import { isSourceVaultEnabled } from "./sourceVaultBudget";
import { runSourceDiscovery, runWatchedClusterDiscovery } from "./sourceDiscovery";
import { pollDueFeeds } from "./feedWatcher";
import { runClustering, sweepClusterLifecycle, runSemanticClusterReconciler } from "./storyClusters";
import { associateMarkersToClusters } from "./trendMarkers";
import { runHotMarkerHarvest } from "./sourceHarvest";
import { isResearchCapabilityAvailable } from "./researchFallback";
import { runEditorialScreening } from "./editorialScreen";
import { isAiFunctionEnabled } from "./aiSettings";
import { backfillConcepts, isConceptBackfillRunning } from "./conceptExplainer";
import { reconcileGlossaryVault } from "./glossaryVaultSync";
import { runRetractionRescan } from "./retractionCascade";
import { startConceptBeatAffinityRecompute } from "./conceptBeatAffinityJob";
import {
  startConceptHealthPass,
  isConceptHealthPassRunning,
} from "./conceptEvidenceHealthJob";
import { startCrossBeatRadarRun } from "./crossBeatRadarJob";
import { autoInjectTrendSignals } from "./trends";
import { startCoverageMapPass, isCoverageMapPassRunning } from "./coverageMapJob";
import { autoWatchAfterCluster } from "./storyWatch";
import {
  scanWatchedClustersForSignals,
  markSignalConsumed,
  markSignalRetried,
} from "./developmentSignalDetector";
import { generateUpdateArticle } from "./updateArticleGenerator";
import { AiFunctionDisabledError } from "./llm";
import { rankCoveringAuthors } from "./authorAssignment";
import { reconcilePendingClaimConcepts } from "./claimGraph";

export { claimJobPeriod };

/** UTC hour bucket, e.g. "2026-06-20T14". Used to gate hour-granular jobs. */
function hourKey(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const h = String(now.getUTCHours()).padStart(2, "0");
  return `${y}-${m}-${d}T${h}`;
}

/** UTC day bucket, e.g. "2026-06-20". Used to gate once-per-day jobs. */
function dayKey(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Fixed quiet UTC hour for the once-a-day back-catalogue maintenance pass.
const BACK_CATALOGUE_HOUR_UTC = 4;
// Radar runs the hour AFTER the affinity recompute so bridge profiles are fresh.
const CROSS_BEAT_RADAR_HOUR_UTC = 5;
// Coverage map runs one hour after the concept health pass (BACK_CATALOGUE_HOUR_UTC)
// so it always reads that day's fresh health snapshots.
const COVERAGE_MAP_HOUR_UTC = 5;

// Daily Facebook-queue slots, expressed in UTC. These are the three Phoenix
// times 8a/2p/8p (Arizona is UTC−7, no DST): 15, 21, 3 UTC. One queue item posts
// per slot — THREE article posts per day (the daily article cap). Must stay in
// sync with SLOT_HOURS_UTC in socialQueue.ts and the dev gate in index.ts.
const SOCIAL_QUEUE_SLOTS_UTC = [15, 21, 3];

// Daily MEME posting slots, expressed in UTC. The three Phoenix times
// 10am/4pm/7pm (Arizona is UTC−7, no DST): 17, 23, 2 UTC. One meme posts per
// slot. SEPARATE from the article-link queue slots above so the two cadences
// never collide, with a distinct claim key ("meme_queue_slot").
const MEME_QUEUE_SLOTS_UTC = [17, 23, 2];

// In-process guards so a fire-and-forget Source Vault drain / re-embed sweep
// that outlives its tick doesn't stack a second concurrent run on the next tick.
// Cross-instance safety still comes from the per-minute claimJobPeriod below.
let drainInFlight = false;
let reembedInFlight = false;

export interface CronTickSummary {
  ranAt: string;
  maintenance: "ran" | "skipped";
  published: number;
  pipeline: "started" | "skipped";
  newsletter: "started" | "skipped";
  dedup: "started" | "skipped";
  backCatalogue: "started" | "skipped";
  socialQueue: "posted" | "skipped";
  memeQueue: "posted" | "skipped";
  termOfDay: "posted" | "drafted" | "skipped";
  sourceVaultQueue: "drained" | "skipped";
  sourceVaultReembed: "ran" | "skipped";
  sourceVaultLifecycle: "ran" | "skipped";
  feedPoll: "ran" | "skipped";
  sourceDiscovery: "ran" | "skipped";
  storyClustering: "ran" | "skipped";
  hotMarkerHarvest: "ran" | "skipped";
  editorialScreening: "ran" | "skipped";
  conceptBackfill: "started" | "skipped";
  glossaryVaultReconcile: "started" | "skipped";
  retractionRescan: "ran" | "skipped";
  clusterReconcile: "ran" | "skipped";
  conceptBeatAffinity: "started" | "skipped";
  storyWatch: "ran" | "skipped";
  conceptHealth: "started" | "skipped";
  crossBeatRadar: "started" | "skipped";
  trendAutoInject: "started" | "skipped";
  coverageMap: "started" | "skipped";
  reviewTierRepair: "ran" | "skipped";
  claimReconciliation: "started" | "skipped";
}

/**
 * Run all scheduled work that is due "now". Designed to be invoked by an
 * external pinger (UptimeRobot, ~every 5 min) instead of in-process node-cron,
 * which is unreliable on autoscale (no instance to fire the timer when idle;
 * duplicate fires when scaled out). Each job is gated by the SAME site_settings
 * rules the crons used, plus a DB-backed per-period claim (claimJobPeriod) for
 * cross-instance idempotency. Heavy jobs (pipeline, newsletter, dedup) run
 * fire-and-forget so the tick returns promptly and the pinger never times out.
 */
export async function runCronTick(now: Date = new Date()): Promise<CronTickSummary> {
  const summary: CronTickSummary = {
    ranAt: now.toISOString(),
    maintenance: "skipped",
    published: 0,
    pipeline: "skipped",
    conceptBackfill: "skipped",
    newsletter: "skipped",
    dedup: "skipped",
    backCatalogue: "skipped",
    socialQueue: "skipped",
    memeQueue: "skipped",
    termOfDay: "skipped",
    sourceVaultQueue: "skipped",
    sourceVaultReembed: "skipped",
    sourceVaultLifecycle: "skipped",
    feedPoll: "skipped",
    sourceDiscovery: "skipped",
    storyClustering: "skipped",
    hotMarkerHarvest: "skipped",
    editorialScreening: "skipped",
    glossaryVaultReconcile: "skipped",
    retractionRescan: "skipped",
    clusterReconcile: "skipped",
    conceptBeatAffinity: "skipped",
    storyWatch: "skipped",
    conceptHealth: "skipped",
    crossBeatRadar: "skipped",
    trendAutoInject: "skipped",
    coverageMap: "skipped",
    reviewTierRepair: "skipped",
    claimReconciliation: "skipped",
  };

  const s = await getSiteSettings();

  // 1. Maintenance / publishing loop. Cheap and must run reliably so scheduled
  //    posts are never stranded. Gated to once per publishCheckMinutes window so
  //    two instances don't both run it in the same window. Auto-approve /
  //    auto-lock / publish are all idempotent (threshold- and status-guarded).
  try {
    const interval = s.publishCheckMinutes > 0 ? s.publishCheckMinutes : 1;
    const windowIndex = Math.floor(Math.floor(now.getTime() / 60000) / interval);
    if (await claimJobPeriod("maintenance", `maint:${windowIndex}`)) {
      await autoApproveStaleIdeas(now, {
        enabled: s.autoApproveEnabled,
        afterHours: s.autoApproveHours,
      });
      await autoLockStaleDrafts(now, { enabled: s.autoLockEnabled, afterHours: s.autoLockHours });
      summary.published = await publishDueArticles(now);
      summary.maintenance = "ran";
    }
  } catch (e) {
    logger.error({ err: e }, "cron tick: maintenance loop failed");
  }

  // 2. Content pipeline. Hourly. runDailyPipeline self-gates on pipelineEnabled +
  //    active-hours window + per-author runHourUtc/cadence, so the tick just
  //    starts it once per UTC hour. Fire-and-forget — LLM + hero-image work can
  //    take minutes (mirrors the manual "Run pipeline now" route).
  try {
    if (await claimJobPeriod("pipeline", `pipeline:${hourKey(now)}`)) {
      summary.pipeline = "started";
      void runDailyPipeline(now)
        .then((r) => {
          if (r.draftsCreated > 0 || r.ideasGenerated > 0 || r.articlesPublished > 0) {
            logger.info(r, "cron tick: pipeline produced work");
          }
        })
        .catch((e) => logger.error({ err: e }, "cron tick: pipeline failed"));
    }
  } catch (e) {
    logger.error({ err: e }, "cron tick: pipeline claim failed");
  }

  // 3. Weekly newsletter. Same weekday + hour gate as the old hourly cron; claim
  //    per hour so it fires once in the matching hour. Fire-and-forget (sends are
  //    sequential per recipient with a delay).
  try {
    if (
      s.weeklyNewsletterEnabled &&
      now.getUTCDay() === s.weeklyNewsletterWeekday &&
      now.getUTCHours() === s.weeklyNewsletterHour &&
      (await claimJobPeriod("weekly_newsletter", `newsletter:${hourKey(now)}`))
    ) {
      summary.newsletter = "started";
      void sendWeeklyNewsletterToAll()
        .then((r) => logger.info(r, "cron tick: weekly newsletter"))
        .catch((e) => logger.error({ err: e }, "cron tick: weekly newsletter failed"));
    }
  } catch (e) {
    logger.error({ err: e }, "cron tick: weekly newsletter failed");
  }

  // 4. Dedup scan. Same hour / weekday / frequency gate as the old hourly cron;
  //    claim per hour. startDuplicateScan is itself fire-and-forget with an
  //    in-flight guard.
  try {
    const dedupeDue =
      s.dedupeScanEnabled &&
      now.getUTCHours() === s.dedupeScanHour &&
      (s.dedupeScanFrequency !== "weekly" || now.getUTCDay() === s.dedupeScanWeekday);
    if (dedupeDue && (await claimJobPeriod("dedupe_scan", `dedupe:${hourKey(now)}`))) {
      const { started, alreadyRunning } = await startDuplicateScan();
      summary.dedup = started ? "started" : "skipped";
      logger.info({ started, alreadyRunning }, "cron tick: dedup scan");
    }
  } catch (e) {
    logger.error({ err: e }, "cron tick: dedup scan failed");
  }

  // 5. Back-catalogue maintenance. Once a day at a fixed quiet UTC hour: strips
  //    legacy scholar/search links from the published catalogue, then backfills
  //    real verified source links and internal links onto articles missing them
  //    (bounded per run). Fire-and-forget — the source/internal backfills make
  //    an LLM call per article and can run for minutes. The claim gates it to
  //    once per UTC day across instances; the backfills additionally have their
  //    own in-flight guards so they never collide with manual admin runs.
  try {
    if (
      now.getUTCHours() === BACK_CATALOGUE_HOUR_UTC &&
      (await claimJobPeriod("back_catalogue", `backcat:${dayKey(now)}`))
    ) {
      summary.backCatalogue = "started";
      void runBackCatalogueMaintenance()
        .then((r) => logger.info(r, "cron tick: back-catalogue maintenance"))
        .catch((e) => logger.error({ err: e }, "cron tick: back-catalogue maintenance failed"));
    }
  } catch (e) {
    logger.error({ err: e }, "cron tick: back-catalogue maintenance failed");
  }

  // 6. Facebook posting QUEUE. One queue item posts per daily Phoenix slot
  //    (UTC 15/18/21/0/3). Gated by activation + pause + Zernio config; the
  //    per-slot claim makes it fire at most once per slot per UTC day across
  //    instances. postNextDueSlot self-gates again and never throws. A cheap
  //    caption backfill runs first so the picked item is caption-ready.
  try {
    if (
      SOCIAL_QUEUE_SLOTS_UTC.includes(now.getUTCHours()) &&
      s.socialQueueActivated &&
      !s.socialQueuePaused &&
      isZernioConfigured() &&
      (await claimJobPeriod("social_queue_slot", `slot:${hourKey(now)}`))
    ) {
      await generateMissingSocialPacks(3);
      const r = await postNextDueSlot(now);
      summary.socialQueue = r.status === "posted" ? "posted" : "skipped";
      logger.info({ result: r }, "cron tick: social queue slot");
    }
  } catch (e) {
    logger.error({ err: e }, "cron tick: social queue slot failed");
  }

  // 7. MEME posting cadence. Up to three memes/day at the Phoenix times
  //    10am/4pm/7pm (UTC 17/23/2) — SEPARATE from the article-link queue (step
  //    6) with its OWN distinct claim key so the two cadences never collide.
  //    Gated by meme activation + pause + Zernio config; the per-slot claim
  //    makes it fire at most once per slot per UTC day across instances.
  //    postNextDueMeme self-gates again and never throws.
  try {
    if (
      MEME_QUEUE_SLOTS_UTC.includes(now.getUTCHours()) &&
      s.memeQueueActivated &&
      !s.memeQueuePaused &&
      isZernioConfigured() &&
      (await claimJobPeriod("meme_queue_slot", `meme:${hourKey(now)}`))
    ) {
      const r = await postNextDueMeme(now);
      summary.memeQueue = r.status === "posted" ? "posted" : "skipped";
      logger.info({ result: r }, "cron tick: meme queue slot");
    }
  } catch (e) {
    logger.error({ err: e }, "cron tick: meme queue slot failed");
  }

  // 7b. Term of the Day. Up to TWO glossary-term posts per UTC day at the
  //     configured hours (slot 1 = termOfDayHourUtc, slot 2 = the optional
  //     termOfDayHour2Utc; null disables slot 2). Gated by the feature toggle +
  //     Zernio config; each slot has its OWN per-day claim so the tick fires
  //     each at most once per day across instances, and the partial-unique
  //     (date, slot) claim inside runTermOfDay makes the post itself idempotent
  //     even if this claim were ever bypassed (manual queue-now). Slot 1 keeps
  //     the legacy `tod:` key so a mid-day deploy never re-fires it.
  try {
    const todSlots: Array<{ slot: 1 | 2; hourUtc: number | null; jobName: string; claimKey: string }> = [
      { slot: 1, hourUtc: s.termOfDayHourUtc, jobName: "term_of_day", claimKey: `tod:${dayKey(now)}` },
      { slot: 2, hourUtc: s.termOfDayHour2Utc, jobName: "term_of_day_2", claimKey: `tod2:${dayKey(now)}` },
    ];
    for (const { slot, hourUtc, jobName, claimKey } of todSlots) {
      if (
        s.termOfDayEnabled &&
        hourUtc !== null &&
        now.getUTCHours() === hourUtc &&
        (s.termOfDayDraftOnly || isZernioConfigured()) &&
        (await claimJobPeriod(jobName, claimKey))
      ) {
        const r = await runTermOfDay(now, { slot });
        summary.termOfDay =
          r.status === "posted" ? "posted" : r.status === "drafted" ? "drafted" : "skipped";
        logger.info({ result: r, slot }, "cron tick: term of the day");
      }
    }
  } catch (e) {
    logger.error({ err: e }, "cron tick: term of the day failed");
  }

  // 8. Source Vault ingest queue. Drain a bounded batch of pending URLs every
  //    tick, budget-guarded so a big backlog drains without blowing the per-run/
  //    day ceilings; anything not reached stays `pending` for the next tick (work
  //    preserved on stop). Runs FIRE-AND-FORGET (like the pipeline/newsletter) so
  //    a larger batch never slows the pinger; a module in-process guard stops a
  //    slow drain from stacking on the next tick, and the per-minute claim +
  //    FOR UPDATE SKIP LOCKED keep it single-server-safe. Skipped when disabled.
  try {
    if (
      isSourceVaultEnabled() &&
      !drainInFlight &&
      (await claimJobPeriod("source_vault_queue", `svqueue:${Math.floor(now.getTime() / 60000)}`))
    ) {
      summary.sourceVaultQueue = "drained";
      drainInFlight = true;
      void drainIngestQueue(now)
        .then(async (r) => {
          if (r.claimed > 0) logger.info({ result: r }, "cron tick: source vault queue drain");
          // After a drain, link any back-catalog-harvested (#228) evidence rows
          // still awaiting ingest to the source_documents the drain just produced.
          // Cheap, DB-only, idempotent; no-op when nothing is pending.
          try {
            const linked = await reconcileHarvestedSources();
            if (linked > 0) logger.info({ linked }, "cron tick: back-catalog sources reconciled");
          } catch (e) {
            logger.error({ err: e }, "cron tick: back-catalog reconcile failed");
          }
        })
        .catch((e) => logger.error({ err: e }, "cron tick: source vault queue drain failed"))
        .finally(() => {
          drainInFlight = false;
        });
    }
  } catch (e) {
    logger.error({ err: e }, "cron tick: source vault queue drain failed");
  }

  // 8b. Source Vault re-embed sweep. Embed documents stranded at "extracted"
  //     with usable text but no chunks (embedding never completed at ingest), so
  //     a good document can never stay permanently unsearchable. Local embedding
  //     is free (the sweep is budget-guarded for paid providers only), bounded
  //     per run, and idempotent — once embedded, a doc drops out of the set.
  //     Fire-and-forget + in-process guard + per-minute claim, same as the drain.
  try {
    if (
      isSourceVaultEnabled() &&
      !reembedInFlight &&
      (await claimJobPeriod("source_vault_reembed", `svreembed:${Math.floor(now.getTime() / 60000)}`))
    ) {
      summary.sourceVaultReembed = "ran";
      reembedInFlight = true;
      void reembedExtractedDocuments(now)
        .then((r) => {
          if (r.embedded > 0 || r.failed > 0) {
            logger.info({ result: r }, "cron tick: source vault re-embed sweep");
          }
        })
        .catch((e) => logger.error({ err: e }, "cron tick: source vault re-embed sweep failed"))
        .finally(() => {
          reembedInFlight = false;
        });
    }
  } catch (e) {
    logger.error({ err: e }, "cron tick: source vault re-embed sweep failed");
  }

  // 9. Source Vault lifecycle recheck. Once a day at the same quiet UTC hour as
  //    back-catalogue maintenance: (a) mark any `active` document past its
  //    freshness window (`stale_after` < now) as `stale`, and (b) re-fetch a
  //    bounded batch of due `active` documents to catch removals (→ unavailable),
  //    retractions (→ retracted) and corrections/content changes. Both drop the
  //    affected docs from retrieval via the lifecycle filter. Fetch-only (free),
  //    idempotent, single claim per day.
  try {
    if (
      now.getUTCHours() === BACK_CATALOGUE_HOUR_UTC &&
      (await claimJobPeriod("source_vault_lifecycle", `svlifecycle:${dayKey(now)}`))
    ) {
      const staled = await markStaleDocuments(now);
      const recheck = await recheckActiveDocuments(now);
      summary.sourceVaultLifecycle = "ran";
      if (staled > 0 || recheck.checked > 0) {
        logger.info({ staled, ...recheck }, "cron tick: source vault lifecycle recheck");
      }
    }
  } catch (e) {
    logger.error({ err: e }, "cron tick: source vault lifecycle recheck failed");
  }

  // 9b. Review-article tier repair sweep. Once a day at the quiet UTC hour.
  //     Finds auto-classified `primary` docs whose title (written after the
  //     initial ingest) now matches a review-article signal (systematic review,
  //     meta-analysis, etc.) and downgrades them to `reported`. Preprint servers
  //     (arxiv.org, biorxiv.org, medrxiv.org, ssrn.com) and academic journal
  //     domains initially classify as `primary`; if the title was null at first
  //     ingest the review-article check in resolveAuthority never fired. This
  //     sweep is the safety net. Cheap, DB-only, idempotent, bounded per run.
  try {
    if (
      isSourceVaultEnabled() &&
      now.getUTCHours() === BACK_CATALOGUE_HOUR_UTC &&
      (await claimJobPeriod("review_tier_repair", `rtrep:${dayKey(now)}`))
    ) {
      const { repaired } = await repairMisclassifiedReviewArticles();
      summary.reviewTierRepair = "ran";
      if (repaired > 0) {
        logger.info({ repaired }, "cron tick: review-article tier repair");
      }
    }
  } catch (e) {
    logger.error({ err: e }, "cron tick: review-article tier repair failed");
  }

  // 10a. Known Source Watcher (Task #227). Poll admin-registered RSS/Atom feeds
  //      that are due (conditional GET via ETag/Last-Modified), enqueue NEW,
  //      discoverable items to the ingest queue tagged discoveredVia=
  //      "known_source" + beatSlug. Runs BEFORE discovery so trusted feeds refill
  //      the vault first (Perplexity is the gap-filler). Each feed self-gates on
  //      its own nextPollAt; pollDueFeeds never throws. Claim per tick minute so
  //      overlapping ticks don't both poll. Skipped when the vault is disabled.
  //      NOT gated on sourceDiscoveryEnabled — that switch controls only the
  //      PAID Perplexity discovery below; feed polling is free and must keep
  //      running when discovery is paused (see pollDueFeeds doc).
  try {
    if (
      isSourceVaultEnabled() &&
      (await claimJobPeriod("feed_poll", `feedpoll:${Math.floor(now.getTime() / 60000)}`))
    ) {
      const r = await pollDueFeeds(now);
      summary.feedPoll = r.ran ? "ran" : "skipped";
      if (r.feedsPolled > 0 || r.itemsEnqueued > 0) {
        logger.info({ result: r }, "cron tick: known source watcher");
      }
    }
  } catch (e) {
    logger.error({ err: e }, "cron tick: known source watcher failed");
  }

  // 10. Source Vault automatic DISCOVERY. Once per UTC hour: enqueue fresh leads
  //     (Trend Scout signal URLs + Perplexity per-beat search) for later
  //     ingestion by the queue drain (step 8). Self-gates on sourceDiscoveryEnabled
  //     + the vault kill-switch, is budget-guarded, and fails closed (no live
  //     results → nothing enqueued). Claim per UTC hour so it fires once/hour.
  try {
    if (
      isSourceVaultEnabled() &&
      s.sourceDiscoveryEnabled &&
      (await claimJobPeriod("source_discovery", `svdiscovery:${hourKey(now)}`))
    ) {
      const r = await runSourceDiscovery(now);
      summary.sourceDiscovery = r.ran ? "ran" : "skipped";
      if (r.signalUrlsEnqueued > 0 || r.searchLeadsEnqueued > 0) {
        logger.info({ result: r }, "cron tick: source discovery");
      }
      // Targeted discovery pass for explicitly-watched story clusters — runs
      // immediately after the standard beat-level pass so watched stories get
      // an extra ingestion push on each tick where discovery is enabled.
      void runWatchedClusterDiscovery(now).catch((err: unknown) => {
        logger.error({ err }, "cron tick: watched cluster discovery failed");
      });
    }
  } catch (e) {
    logger.error({ err: e }, "cron tick: source discovery failed");
  }

  // 11. Story clustering + lifecycle sweep. Cheap, deterministic, NO paid AI:
  //     group newly-ingested vault sources into story clusters, recompute their
  //     scores, then age stale clusters to dormant and reopen covered clusters
  //     whose resurface window elapsed. Runs every tick (claim per minute so
  //     overlapping ticks don't both run it). Skipped when the vault is disabled.
  try {
    if (
      isSourceVaultEnabled() &&
      (await claimJobPeriod("story_clustering", `clustering:${Math.floor(now.getTime() / 60000)}`))
    ) {
      const clustered = await runClustering(now);
      const swept = await sweepClusterLifecycle(now);
      // Attach freshly-observed trend markers to the evidence clusters they best
      // match, AFTER clustering (so target clusters exist), then recompute those
      // clusters' velocity/markerCount. Markers never create clusters themselves.
      const markers = await associateMarkersToClusters(now);
      summary.storyClustering = "ran";
      if (
        clustered.processed > 0 ||
        swept.dormant > 0 ||
        swept.reopened > 0 ||
        markers.attached > 0
      ) {
        logger.info({ ...clustered, ...swept, ...markers }, "cron tick: story clustering");
      }

      // Semantic reconciler runs immediately after each lexical clustering pass
      // (still inside the same per-minute claim). Gated by the
      // semanticClusterReconcileEnabled site setting — returns immediately when off.
      const reconciled = await runSemanticClusterReconciler(now);
      summary.clusterReconcile = "ran";
      if (reconciled.merged > 0 || reconciled.judged > 0) {
        logger.info(reconciled, "cron tick: cluster reconciler");
      }

      // Story Watch auto-watch: any ingest_watch-sourced docs that were just
      // clustered get their cluster auto-watched. Cheap, DB-only, runs inside
      // the same per-minute claim as clustering (so it's always in sync).
      const autoWatched = await autoWatchAfterCluster();
      if (autoWatched > 0) {
        logger.info({ autoWatched }, "cron tick: story-watch auto-watch");
      }
    }
  } catch (e) {
    logger.error({ err: e }, "cron tick: story clustering failed");
  }

  // 11b. Hot-marker source harvest (Task #236). Runs AFTER clustering so markers
  //      are attached to their story clusters and topic grouping is accurate.
  //      Turns HOT trend-marker topics (buzz over the site-configured thresholds)
  //      into cheap, bounded, topic-scoped source harvests: FREE Source Vault
  //      lookup first, then budget-gated Perplexity restricted to the domain
  //      allowlist — searching the topic (title/snippet/beat), NEVER the social
  //      URL. Evidence leads land in the ingest queue; the buzz markers are
  //      marked `investigated` (cooldown). OFF BY DEFAULT (hotMarkerHarvestEnabled)
  //      and fail-closed; the harvest never throws. Claimed hourly so a topic is
  //      considered at most once per hour across instances.
  try {
    if (
      isSourceVaultEnabled() &&
      s.hotMarkerHarvestEnabled &&
      (await isResearchCapabilityAvailable()) &&
      (await claimJobPeriod("hot_marker_harvest", `hotharvest:${hourKey(now)}`))
    ) {
      const harvested = await runHotMarkerHarvest(now);
      summary.hotMarkerHarvest = "ran";
      if (
        harvested.topicsHarvested > 0 ||
        harvested.leadsEnqueued > 0 ||
        harvested.markersInvestigated > 0
      ) {
        logger.info({ ...harvested }, "cron tick: hot-marker harvest");
      }
    }
  } catch (e) {
    logger.error({ err: e }, "cron tick: hot-marker harvest failed");
  }

  // 12. Editorial screening (Task #200). CHEAP AI: build evidence packets for
  //     qualified clusters lacking a current packet. Vault-first (never a paid
  //     research call from the cron), skips clusters whose sources are unchanged.
  //     OFF BY DEFAULT — auto-screening only runs when EDITORIAL_SCREEN_AUTO is
  //     truthy AND the vault + editorial_screen AI function are enabled. Manual
  //     admin triggers always work regardless of this env flag.
  try {
    if (
      editorialScreenAutoEnabled() &&
      isSourceVaultEnabled() &&
      (await isAiFunctionEnabled("editorial_screen")) &&
      (await claimJobPeriod("editorial_screening", `screen:${Math.floor(now.getTime() / 60000)}`))
    ) {
      const screened = await runEditorialScreening(now);
      summary.editorialScreening = "ran";
      if (screened.created > 0 || screened.errors > 0) {
        logger.info({ ...screened }, "cron tick: editorial screening");
      }
    }
  } catch (e) {
    logger.error({ err: e }, "cron tick: editorial screening failed");
  }

  // 13. Concept Explainer backfill (Task #284). Runs every tick (rate-limited by
  //     the in-process backfillInFlight guard + the 20-article-per-call cap).
  //     Gated by Perplexity config + concept_detection AI function being enabled.
  //     Fire-and-forget — each article runs 5–7 Perplexity calls and can take
  //     a few seconds; we never block the tick on it.
  try {
    if (
      (await isResearchCapabilityAvailable()) &&
      !isConceptBackfillRunning() &&
      (await isAiFunctionEnabled("concept_detection")) &&
      (await claimJobPeriod("concept_backfill", `concepts:${Math.floor(now.getTime() / 60000)}`))
    ) {
      summary.conceptBackfill = "started";
      void backfillConcepts(20)
        .then((r) => {
          if (r.processed > 0 || r.failed > 0) {
            logger.info(r, "cron tick: concept backfill batch");
          }
        })
        .catch((e) => logger.error({ err: e }, "cron tick: concept backfill failed"));
    }
  } catch (e) {
    logger.error({ err: e }, "cron tick: concept backfill failed");
  }

  // 14. Glossary → Source Vault reconciliation (once per hour).
  //     Upserts all live/draft concepts into the vault's glossary_concept lane
  //     so their definitions are available as INTERNAL CONCEPT MEMORY during
  //     drafting. Cheap, DB-only for the upsert phase; embedding is handled by
  //     the re-embed sweep (step 8b). Idempotent across autoscale instances via
  //     the per-hour claim. Fire-and-forget — logs synced/skipped/deactivated/
  //     orphaned/failed counts on completion.
  try {
    if (await claimJobPeriod("glossary_vault_reconcile", `gvault:${hourKey(now)}`)) {
      summary.glossaryVaultReconcile = "started";
      void reconcileGlossaryVault()
        .then((r) => {
          logger.info(r, "cron tick: glossary vault reconcile");
        })
        .catch((e) => logger.error({ err: e }, "cron tick: glossary vault reconcile failed"));
    }
  } catch (e) {
    logger.error({ err: e }, "cron tick: glossary vault reconcile failed");
  }

  // 15. Retraction rescan (Task #329). Once per day at the same quiet UTC hour
  //     as back-catalogue work. Sweeps all articles with an uncleared retraction
  //     impact and auto-clears the flag when the article still has at least one
  //     active trusted-tier source. Cheap, DB-only — no AI, no paid calls.
  try {
    if (
      now.getUTCHours() === BACK_CATALOGUE_HOUR_UTC &&
      (await claimJobPeriod("retraction_rescan", `retraction:${dayKey(now)}`))
    ) {
      const result = await runRetractionRescan();
      summary.retractionRescan = "ran";
      if (result.rescanned > 0) {
        logger.info(result, "cron tick: retraction rescan complete");
      }
    }
  } catch (e) {
    logger.error({ err: e }, "cron tick: retraction rescan failed");
  }

  // 16. Concept-to-beat affinity recompute. Once per day at the quiet UTC hour.
  //     Deterministic, DB-only (no AI cost); full rewrite per concept in a
  //     transaction. Fire-and-forget via the same start function the admin
  //     trigger uses (in-process claim inside).
  try {
    if (
      now.getUTCHours() === BACK_CATALOGUE_HOUR_UTC &&
      (await claimJobPeriod("concept_beat_affinity", `cbaff:${dayKey(now)}`))
    ) {
      const { started } = startConceptBeatAffinityRecompute();
      summary.conceptBeatAffinity = started ? "started" : "skipped";
    }
  } catch (e) {
    logger.error({ err: e }, "cron tick: concept beat affinity recompute failed");
  }

  // 17. Concept evidence-health pass. Once per day at the quiet UTC hour,
  //     alongside the affinity recompute it feeds on. Deterministic, DB-only
  //     (no AI cost); fire-and-forget via the same start function the admin
  //     trigger uses (in-process claim inside).
  try {
    if (
      now.getUTCHours() === BACK_CATALOGUE_HOUR_UTC &&
      (await claimJobPeriod("concept_health", `chealth:${dayKey(now)}`))
    ) {
      const { started } = startConceptHealthPass();
      summary.conceptHealth = started ? "started" : "skipped";
    }
  } catch (e) {
    logger.error({ err: e }, "cron tick: concept health pass failed");
  }

  // 18. Cross-Beat Radar run. Once per day, ONE HOUR AFTER the affinity
  //     recompute (hour 5) so it reads fresh bridge profiles. Bounded LLM cost
  //     (RADAR_MAX_SUGGESTIONS_PER_RUN cheap pitch calls); each gated
  //     candidate is idempotent via the suggestion dedupe key.
  try {
    if (
      now.getUTCHours() === CROSS_BEAT_RADAR_HOUR_UTC &&
      (await claimJobPeriod("cross_beat_radar", `radar:${dayKey(now)}`))
    ) {
      const { started } = startCrossBeatRadarRun();
      summary.crossBeatRadar = started ? "started" : "skipped";
    }
  } catch (e) {
    logger.error({ err: e }, "cron tick: cross-beat radar run failed");
  }

  // 19. Trend auto-inject: once per day, push qualifying "new" trend signals
  //     into the approved-ideas queue without requiring manual editor action.
  //     Signals below the urgency threshold stay "new" for the editor to review.
  try {
    if (
      s.trendAutoInjectEnabled &&
      (await claimJobPeriod("trend_auto_inject", `trend_inject:${dayKey(now)}`))
    ) {
      summary.trendAutoInject = "started";
      void autoInjectTrendSignals()
        .then((r) => {
          if (r.injected > 0 || r.errors > 0) {
            logger.info(r, "cron tick: trend auto-inject");
          }
        })
        .catch((e) => logger.error({ err: e }, "cron tick: trend auto-inject failed"));
    }
  } catch (e) {
    logger.error({ err: e }, "cron tick: trend auto-inject claim failed");
  }

  // 20. Living Coverage Map pass. Once per day, ONE HOUR AFTER the evidence
  //     health pass (hour 4) so it reads fresh health snapshots — the health
  //     pass is fire-and-forget, so running in the same tick would race it.
  //     Also defers while a health pass is still in flight (retries next tick;
  //     the period claim is only taken once the guard passes). Purely
  //     deterministic (no AI cost); fire-and-forget.
  try {
    if (
      now.getUTCHours() === COVERAGE_MAP_HOUR_UTC &&
      !isConceptHealthPassRunning() &&
      !isCoverageMapPassRunning() &&
      (await claimJobPeriod("coverage_map", `covmap:${dayKey(now)}`))
    ) {
      const { started } = startCoverageMapPass();
      summary.coverageMap = started ? "started" : "skipped";
    }
  } catch (e) {
    logger.error({ err: e }, "cron tick: coverage map pass failed");
  }

  // 21. Page-view retention purge. Once per day at the quiet UTC hour: delete
  //     page_views rows older than 90 days so the table doesn't grow
  //     indefinitely. Purely destructive and cheap; no AI cost. Fire-and-forget
  //     (errors are logged, never propagated to the tick summary).
  try {
    if (
      now.getUTCHours() === BACK_CATALOGUE_HOUR_UTC &&
      (await claimJobPeriod("pageview_purge", `pvpurge:${dayKey(now)}`))
    ) {
      purgeOldPageViews()
        .then((deleted) => {
          if (deleted > 0) logger.info({ deleted }, "cron tick: page-view retention purge");
        })
        .catch((e) => logger.error({ err: e }, "cron tick: page-view retention purge failed"));
    }
  } catch (e) {
    logger.error({ err: e }, "cron tick: page-view retention purge failed");
  }

  // 22. Story Watch — development signal detection + update article generation.
  //     Scans watched clusters for Track A/B signals; for each fired signal
  //     picks the best covering author and enqueues an update article draft.
  //     Runs on every tick (signals are self-gating via 2-hour cooldown).
  //     Fire-and-forget; errors logged but never bubble to the tick summary.
  try {
    const scanResult = await scanWatchedClustersForSignals();
    if (scanResult.signals.length > 0) {
      logger.info({ count: scanResult.signals.length }, "cron tick: story watch signals fired");
      for (const signal of scanResult.signals) {
        try {
          // Lock the update to the original article's author when available;
          // only fall back to rankCoveringAuthors for brand-new chains with no
          // prior article yet.
          let authorId: string;
          if (signal.latestChainArticleId) {
            const [orig] = await db
              .select({ authorId: articlesTable.authorId })
              .from(articlesTable)
              .where(eq(articlesTable.id, signal.latestChainArticleId))
              .limit(1);
            if (!orig) {
              logger.warn({ clusterId: signal.clusterId }, "cron tick: story watch — original article not found, skipping");
              continue;
            }
            authorId = orig.authorId;
          } else {
            const covering = await rankCoveringAuthors(signal.beatSlug);
            if (covering.length === 0) {
              logger.warn({ clusterId: signal.clusterId }, "cron tick: story watch — no covering author, skipping");
              continue;
            }
            authorId = covering[0]!.author.id;
          }
          let generationSucceeded = false;
          try {
            const result = await generateUpdateArticle({ signal, authorId });
            // null = redundant development suppressed by novelty gate — still mark
            // consumed so the same triggering docs don't re-fire on the next tick.
            generationSucceeded = true;
            await markSignalConsumed(signal.clusterId).catch((err: unknown) => {
              logger.error({ err, clusterId: signal.clusterId }, "cron tick: story watch — markSignalConsumed failed; signal may re-fire after cooldown");
            });
            if (result === null) {
              logger.info({ clusterId: signal.clusterId }, "cron tick: story watch — update suppressed by novelty gate; signal consumed");
            }
          } catch (err: unknown) {
            if (err instanceof AiFunctionDisabledError) {
              // AI disabled — don't count as a retry failure; leave signal pending.
              continue;
            }
            logger.error({ err, clusterId: signal.clusterId }, "cron tick: story watch — update generation failed");
            if (!generationSucceeded) {
              await markSignalRetried(signal.clusterId).catch((retryErr: unknown) => {
                logger.warn({ err: retryErr, clusterId: signal.clusterId }, "cron tick: story watch — markSignalRetried failed");
              });
            }
          }
        } catch (e) {
          logger.error({ err: e, clusterId: signal.clusterId }, "cron tick: story watch — signal processing failed");
        }
      }
    }
    summary.storyWatch = "ran";
  } catch (e) {
    logger.error({ err: e }, "cron tick: story watch scan failed");
  }

  // Vault claim reconciliation: bounded to five concepts per hourly bucket.
  // The DB period claim prevents overlapping autoscale instances; pair-level
  // relationships are idempotent and update on conflict.
  try {
    if (
      (await isAiFunctionEnabled("claim_reconciliation")) &&
      (await claimJobPeriod("claim_reconciliation", `claims:${hourKey(now)}`))
    ) {
      summary.claimReconciliation = "started";
      void reconcilePendingClaimConcepts(5)
        .then((results) => logger.info({ results }, "cron tick: claim reconciliation"))
        .catch((err) => logger.error({ err }, "cron tick: claim reconciliation failed"));
    }
  } catch (err) {
    logger.error({ err }, "cron tick: claim reconciliation claim failed");
  }

  return summary;
}

// Auto-screening is off unless explicitly enabled via EDITORIAL_SCREEN_AUTO
// (1/true/yes/on). Manual admin triggers bypass this entirely.
function editorialScreenAutoEnabled(): boolean {
  const v = (process.env.EDITORIAL_SCREEN_AUTO ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

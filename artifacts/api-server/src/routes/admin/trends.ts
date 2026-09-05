import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { logger } from "../../lib/logger";
import {
  beginTrendScanJob,
  getTrendScanJob,
  runTrendScan,
  listTrendSignals,
  draftTrendSignal,
  sendTrendSignalToIdeas,
  dismissTrendSignal,
  TrendSignalError,
} from "../../services/trends";
import {
  listStoryClusters,
  getStoryCluster,
  setClusterCoverage,
  beginVaultResortJob,
  cancelVaultResortJob,
  forceReleaseVaultResortIfStale,
  runVaultResort,
  getVaultResortJob,
  type ResortStartPhase,
  recomputeStoryCluster,
  StoryClusterError,
  listClusterMerges,
  getClusterMergeStats,
  listResortSnapshots,
  deleteResortSnapshot,
  deleteAllResortSnapshots,
  restoreResortSnapshot,
} from "../../services/storyClusters";
import { db, storyClustersTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import {
  watchCluster,
  unwatchCluster,
  listWatchedClusters,
  markWatchedViewed,
  ingestAndWatchUrl,
  resetExhaustedSignal,
  IngestWatchError,
} from "../../services/storyWatch";
import {
  buildEvidencePacket,
  listPackets,
  getLatestPacket,
  getPacket,
  EditorialScreenError,
} from "../../services/editorialScreen";
import {
  listTrendMarkers,
  listRejectedSources,
  escalateMarker,
  dismissMarker,
  TrendMarkerError,
} from "../../services/trendMarkers";
import { investigateMarker } from "../../services/sourceHarvest";
import type { ClusterCoverageStatus, TrendMarkerPlatform } from "@workspace/db";

const router: IRouter = Router();

const coverageSchema = z.object({
  status: z.enum(["open", "covered", "do_not_cover"]),
  reason: z.string().nullable().optional(),
  resurfaceAfterDays: z.number().int().min(1).max(365).nullable().optional(),
  coveredArticleId: z.string().nullable().optional(),
});

const scanSchema = z.object({
  beatSlugs: z.array(z.string().min(1)).optional(),
  count: z.number().int().min(1).max(10).optional(),
});

const screenSchema = z.object({
  research: z.enum(["vault_only", "sonar", "deep_research"]).optional(),
});

// Start a Trend Radar scan in the background. Like run-pipeline, this can take
// minutes (web search + scoring per beat), so it's fire-and-forget: claim the
// single-flight lock, return 202 immediately, run the work unawaited. The page
// polls /trends/scan-status while it runs.
router.post("/trends/scan", async (req, res) => {
  const parsed = scanSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }
  const runId = await beginTrendScanJob();
  if (!runId) {
    res.status(202).json({ started: false, alreadyRunning: true });
    return;
  }
  req.log?.info({ adminEmail: req.session?.adminEmail, beatSlugs: parsed.data.beatSlugs }, "trend-scan: start (background)");
  res.status(202).json({ started: true, alreadyRunning: false });
  void runTrendScan(runId, parsed.data.beatSlugs, { count: parsed.data.count })
    .then((result) => {
      logger.info({ result }, "trend-scan: done");
    })
    .catch((e) => {
      logger.error({ err: e }, "trend-scan: failed");
    });
});

// Poll the current/last scan job state. Registered before "/trends/:id".
router.get("/trends/scan-status", async (_req, res) => {
  res.json(await getTrendScanJob());
});

// List stored signals, filterable by status and beat. Registered before "/:id".
router.get("/trends", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const beatSlug = typeof req.query.beatSlug === "string" ? req.query.beatSlug : undefined;
  if (status !== undefined && !["new", "drafted", "dismissed"].includes(status)) {
    res.status(400).json({ error: "Invalid status filter" });
    return;
  }
  const items = await listTrendSignals({
    status: status as "new" | "drafted" | "dismissed" | undefined,
    beatSlug,
  });
  res.json({ items });
});

// --- Story clusters (automatic Source Vault observer). Registered before the
// "/trends/:id/*" routes; all cluster paths are GET/PATCH so they never collide
// with the POST signal actions, but keeping them here documents the precedence.
router.get("/trends/clusters", async (req, res) => {
  const beatSlug = typeof req.query.beatSlug === "string" ? req.query.beatSlug : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const coverageStatus =
    typeof req.query.coverageStatus === "string" ? req.query.coverageStatus : undefined;
  if (status !== undefined && !["active", "dormant"].includes(status)) {
    res.status(400).json({ error: "Invalid status filter" });
    return;
  }
  if (
    coverageStatus !== undefined &&
    !["open", "covered", "do_not_cover"].includes(coverageStatus)
  ) {
    res.status(400).json({ error: "Invalid coverageStatus filter" });
    return;
  }
  const limit =
    typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
  const items = await listStoryClusters({
    beatSlug,
    status: status as "active" | "dormant" | undefined,
    coverageStatus: coverageStatus as ClusterCoverageStatus | undefined,
    // Default suppresses covered/do-not-cover; pass ?excludeCovered=false to include all.
    excludeCovered: req.query.excludeCovered !== "false",
    includeSources: req.query.includeSources !== "false",
    limit: Number.isFinite(limit) ? limit : undefined,
  });
  res.json({ items });
});

// Re-sort the whole vault (one-shot maintenance): re-score existing clusters +
// re-cluster un-acted groups under the current tokenizer. Heavy (touches the
// back-catalogue), so fire-and-forget like /trends/scan: claim the single-flight
// lock, return 202, run unawaited. The page polls /trends/clusters/resort-status.
// Registered before "/trends/clusters/:id" so "resort"/"resort-status" don't get
// captured as an :id.
router.post("/trends/clusters/resort", async (req, res) => {
  // Optional resume point: "a" (default, full run), "b" (skip re-score),
  // "c" (semantic merge only — typically after restoring a pre_c snapshot).
  const rawPhase = (req.body as { startPhase?: unknown } | undefined)?.startPhase;
  if (rawPhase !== undefined && rawPhase !== "a" && rawPhase !== "b" && rawPhase !== "c") {
    res.status(400).json({ error: "startPhase must be one of: a, b, c" });
    return;
  }
  const startPhase: ResortStartPhase = rawPhase ?? "a";
  const runId = await beginVaultResortJob();
  if (!runId) {
    res.status(202).json({ started: false, alreadyRunning: true });
    return;
  }
  req.log?.info(
    { adminEmail: req.session?.adminEmail, startPhase },
    "vault-resort: start (background)",
  );
  res.status(202).json({ started: true, alreadyRunning: false });
  void runVaultResort(runId, new Date(), startPhase)
    .then((result) => {
      logger.info({ result }, "vault-resort: done");
    })
    .catch((e) => {
      logger.error({ err: e }, "vault-resort: failed");
    });
});

// Cancel a running re-sort (cooperative — the job checks the flag at each
// phase boundary). Returns 200 {cancelled: true} when flagged, 200
// {cancelled: false} when no job was running. Registered before "/:id".
router.post("/trends/clusters/resort/cancel", async (req, res) => {
  // Cooperative cancel: flags the running job to stop at its next checkpoint.
  const cancelled = await cancelVaultResortJob();
  // Force-release: if the heartbeat is stale (process crashed/restarted), mark
  // the job failed immediately so the UI unblocks without waiting for TTL takeover.
  const forceReleased = await forceReleaseVaultResortIfStale();
  req.log?.info(
    { adminEmail: req.session?.adminEmail, cancelled, forceReleased },
    "vault-resort: cancel requested",
  );
  res.json({ cancelled: cancelled || forceReleased, forceReleased });
});

// Poll the current/last vault re-sort job state. Registered before "/:id".
router.get("/trends/clusters/resort-status", async (_req, res) => {
  res.json(await getVaultResortJob());
});

// --- Vault re-sort snapshots. All registered before "/:id" so the literal
// paths "resort/snapshots" and "resort/snapshots/:id/restore" are matched first.

router.get("/trends/clusters/resort/snapshots", async (_req, res) => {
  const snapshots = await listResortSnapshots();
  res.json({ snapshots });
});

router.delete("/trends/clusters/resort/snapshots", async (req, res) => {
  const deleted = await deleteAllResortSnapshots();
  req.log?.info({ adminEmail: req.session?.adminEmail, deleted }, "vault-resort: all snapshots deleted");
  res.json({ deleted });
});

router.post("/trends/clusters/resort/snapshots/:id/restore", async (req, res) => {
  try {
    const result = await restoreResortSnapshot(req.params.id);
    req.log?.info(
      { adminEmail: req.session?.adminEmail, snapshotId: req.params.id, ...result },
      "vault-resort: snapshot restored",
    );
    res.json(result);
  } catch (e) {
    if (e instanceof Error && e.message.includes("not found")) {
      res.status(404).json({ error: e.message });
      return;
    }
    if (e instanceof Error && e.message.includes("in progress")) {
      res.status(409).json({ error: e.message });
      return;
    }
    req.log?.error({ err: e, snapshotId: req.params.id }, "vault-resort: snapshot restore failed");
    res.status(500).json({ error: "Restore failed", message: e instanceof Error ? e.message : String(e) });
  }
});

router.delete("/trends/clusters/resort/snapshots/:id", async (req, res) => {
  const deleted = await deleteResortSnapshot(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: "Snapshot not found" });
    return;
  }
  req.log?.info(
    { adminEmail: req.session?.adminEmail, snapshotId: req.params.id },
    "vault-resort: snapshot deleted",
  );
  res.json({ deleted: true });
});

// --- Semantic reconciler audit (Task #330). Registered before "/:id" so
// "merges" is never misinterpreted as a cluster ID.
router.get("/trends/clusters/merges", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const [merges, stats] = await Promise.all([listClusterMerges(limit), getClusterMergeStats()]);
  res.json({ merges, totalMerges: stats.totalMerges });
});

// --- Story Watch (Task #348) -----------------------------------------------
// Registered BEFORE the /:id routes so "watched", "watched/mark-viewed", and
// "ingest-watch" are never mistaken for cluster IDs.

// POST /admin/trends/clusters/ingest-watch
// Paste-a-URL flow: force-ingest a URL and auto-watch its resulting cluster.
router.post("/trends/clusters/ingest-watch", async (req, res) => {
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!url) {
    res.status(400).json({ error: "url is required" });
    return;
  }
  try {
    const result = await ingestAndWatchUrl(url);
    req.log?.info(
      { adminEmail: req.session?.adminEmail, url, enqueued: result.enqueued },
      "story-watch: ingest-watch URL enqueued",
    );
    res.status(202).json(result);
  } catch (e) {
    if (e instanceof IngestWatchError) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    req.log?.error({ err: e, url }, "ingest-watch failed");
    res.status(500).json({ error: "Ingest failed", message: e instanceof Error ? e.message : String(e) });
  }
});

// GET /admin/trends/clusters/watched — list watched clusters with new-doc badge
router.get("/trends/clusters/watched", async (req, res) => {
  const includeSources = req.query.includeSources !== "false";
  const clusters = await listWatchedClusters({ includeSources });
  res.json({ items: clusters });
});

// POST /admin/trends/clusters/watched/mark-viewed — reset the NEW badge
router.post("/trends/clusters/watched/mark-viewed", async (_req, res) => {
  const viewedAt = await markWatchedViewed();
  res.json({ viewedAt: viewedAt.toISOString() });
});

// POST /admin/trends/clusters/:id/signal/reset — reset exhausted/consumed signal to pending
// Registered BEFORE /:id routes so "signal/reset" is never mistaken for a cluster ID.
router.post("/trends/clusters/:id/signal/reset", async (req, res) => {
  try {
    const found = await resetExhaustedSignal(req.params.id);
    if (!found) {
      res.status(404).json({ error: "No signal row found for this cluster" });
      return;
    }
    req.log?.info(
      { adminEmail: req.session?.adminEmail, clusterId: req.params.id },
      "story-watch: signal reset to pending",
    );
    res.json({ reset: true, clusterId: req.params.id });
  } catch (e) {
    req.log?.error({ err: e, id: req.params.id }, "Signal reset failed");
    res.status(500).json({ error: "Reset failed", message: e instanceof Error ? e.message : String(e) });
  }
});

router.get("/trends/clusters/:id", async (req, res) => {
  const cluster = await getStoryCluster(req.params.id);
  if (!cluster) {
    res.status(404).json({ error: "Cluster not found" });
    return;
  }
  res.json(cluster);
});

// PATCH /admin/trends/clusters/:id/watch — toggle watch flag (optionally with seed URL)
const watchSchema = z.object({
  watched: z.boolean(),
  sourceUrl: z.string().nullable().optional(),
});
router.patch("/trends/clusters/:id/watch", async (req, res) => {
  const parsed = watchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }
  try {
    const cluster = parsed.data.watched
      ? await watchCluster(req.params.id, parsed.data.sourceUrl ?? null)
      : await unwatchCluster(req.params.id);
    if (!cluster) {
      res.status(404).json({ error: "Cluster not found" });
      return;
    }
    req.log?.info(
      { adminEmail: req.session?.adminEmail, id: req.params.id, watched: parsed.data.watched },
      "story-watch: cluster watch toggled",
    );
    res.json(cluster);
  } catch (e) {
    if (e instanceof IngestWatchError) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    req.log?.error({ err: e, id: req.params.id }, "Set cluster watch failed");
    res.status(500).json({ error: "Watch toggle failed", message: e instanceof Error ? e.message : String(e) });
  }
});

router.patch("/trends/clusters/:id/coverage", async (req, res) => {
  const parsed = coverageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }
  try {
    const cluster = await setClusterCoverage(req.params.id, parsed.data);
    res.json(cluster);
  } catch (e) {
    if (e instanceof StoryClusterError) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    req.log?.error({ err: e, id: req.params.id }, "Set cluster coverage failed");
    res
      .status(500)
      .json({ error: "Set coverage failed", message: e instanceof Error ? e.message : String(e) });
  }
});

// --- Evidence packets (editorial screen, Task #200). Read-only GETs + one POST
// trigger. Registered before the "/trends/:id/*" signal actions; all cluster
// packet paths are under /trends/clusters/* so they never collide.
router.get("/trends/clusters/:id/packets", async (req, res) => {
  const items = await listPackets(req.params.id);
  res.json({ items });
});

router.get("/trends/clusters/:id/packets/latest", async (req, res) => {
  const packet = await getLatestPacket(req.params.id);
  if (!packet) {
    res.status(404).json({ error: "No packet exists for this cluster yet" });
    return;
  }
  res.json(packet);
});

router.post("/trends/clusters/:id/screen", async (req, res) => {
  const parsed = screenSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }
  try {
    const { packet } = await buildEvidencePacket(req.params.id, {
      research: parsed.data.research,
    });
    req.log?.info(
      { adminEmail: req.session?.adminEmail, clusterId: req.params.id, decision: packet.decision },
      "editorial screen: manual trigger",
    );
    res.json(packet);
  } catch (e) {
    if (e instanceof EditorialScreenError) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    req.log?.error({ err: e, id: req.params.id }, "Editorial screen failed");
    res
      .status(500)
      .json({ error: "Screen failed", message: e instanceof Error ? e.message : String(e) });
  }
});

router.get("/trends/packets/:packetId", async (req, res) => {
  const packet = await getPacket(req.params.packetId);
  if (!packet) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(packet);
});

router.post("/trends/:id/draft", async (req, res) => {
  try {
    const signal = await draftTrendSignal(req.params.id);
    res.status(202).json(signal);
  } catch (e) {
    if (e instanceof TrendSignalError) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    req.log?.error({ err: e, id: req.params.id }, "Draft from trend signal failed");
    res.status(500).json({ error: "Draft failed", message: e instanceof Error ? e.message : String(e) });
  }
});

router.post("/trends/:id/send-to-ideas", async (req, res) => {
  try {
    const signal = await sendTrendSignalToIdeas(req.params.id);
    res.status(202).json(signal);
  } catch (e) {
    if (e instanceof TrendSignalError) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    req.log?.error({ err: e, id: req.params.id }, "Send trend signal to ideas failed");
    res.status(500).json({ error: "Send to ideas failed", message: e instanceof Error ? e.message : String(e) });
  }
});

router.post("/trends/:id/dismiss", async (req, res) => {
  try {
    const signal = await dismissTrendSignal(req.params.id);
    res.json(signal);
  } catch (e) {
    if (e instanceof TrendSignalError) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    req.log?.error({ err: e, id: req.params.id }, "Dismiss trend signal failed");
    res.status(500).json({ error: "Dismiss failed", message: e instanceof Error ? e.message : String(e) });
  }
});

// --- Trend markers & rejected junk (Task #227) --------------------------

router.get("/trends/markers", async (req, res) => {
  const q = req.query;
  const status = typeof q.status === "string" ? q.status : undefined;
  const items = await listTrendMarkers({
    status:
      status === "observed" ||
      status === "investigated" ||
      status === "escalated" ||
      status === "dismissed"
        ? status
        : undefined,
    platform: typeof q.platform === "string" ? (q.platform as TrendMarkerPlatform) : undefined,
    beatSlug: typeof q.beatSlug === "string" ? q.beatSlug : undefined,
    clusterId: typeof q.clusterId === "string" ? q.clusterId : undefined,
    limit: parseLimit(q.limit),
  });
  res.json({ items });
});

router.post("/trends/markers/:id/escalate", async (req, res) => {
  try {
    const marker = await escalateMarker(req.params.id);
    req.log?.info(
      { adminEmail: req.session?.adminEmail, markerId: req.params.id },
      "trend marker: escalated to evidence pipeline",
    );
    res.json(marker);
  } catch (e) {
    if (e instanceof TrendMarkerError) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    req.log?.error({ err: e, id: req.params.id }, "Escalate trend marker failed");
    res.status(500).json({ error: "Escalate failed", message: e instanceof Error ? e.message : String(e) });
  }
});

router.post("/trends/markers/:id/investigate", async (req, res) => {
  try {
    const { marker, outcome } = await investigateMarker(req.params.id);
    req.log?.info(
      {
        adminEmail: req.session?.adminEmail,
        markerId: req.params.id,
        leadsEnqueued: outcome.leadsEnqueued,
        stoppedBy: outcome.stoppedBy,
      },
      "trend marker: investigated buzz (topic-scoped source harvest)",
    );
    res.json({
      marker,
      ran: outcome.ran,
      leadsEnqueued: outcome.leadsEnqueued,
      markersRecorded: outcome.markersRecorded,
      junkRejected: outcome.junkRejected,
      vaultHits: outcome.vaultHits,
      vaultCovered: outcome.vaultCovered,
      perplexityUsed: outcome.perplexityUsed,
      stoppedBy: outcome.stoppedBy,
      summary: outcome.summary,
    });
  } catch (e) {
    if (e instanceof TrendMarkerError) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    req.log?.error({ err: e, id: req.params.id }, "Investigate trend marker failed");
    res
      .status(500)
      .json({ error: "Investigate failed", message: e instanceof Error ? e.message : String(e) });
  }
});

router.post("/trends/markers/:id/dismiss", async (req, res) => {
  try {
    const marker = await dismissMarker(req.params.id);
    res.json(marker);
  } catch (e) {
    if (e instanceof TrendMarkerError) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    req.log?.error({ err: e, id: req.params.id }, "Dismiss trend marker failed");
    res.status(500).json({ error: "Dismiss failed", message: e instanceof Error ? e.message : String(e) });
  }
});

router.get("/trends/rejected", async (req, res) => {
  const items = await listRejectedSources(parseLimit(req.query.limit));
  res.json({ items });
});

/**
 * POST /admin/story-clusters/recompute-labels
 *
 * On-demand pass that recomputes labels for every active/dormant cluster using
 * the current bestTitle logic (title ?? leadSnippet ?? domain). Fire-and-forget:
 * responds 202 immediately, runs the pass in an unawaited promise. Useful after
 * ingesting a new batch of feed items whose RSS titles fix stale domain labels.
 */
router.post("/story-clusters/recompute-labels", async (req, res) => {
  const rows = await db
    .select({ id: storyClustersTable.id })
    .from(storyClustersTable)
    .where(inArray(storyClustersTable.status, ["active", "dormant"]));

  const ids = rows.map((r) => r.id);
  req.log?.info({ count: ids.length }, "story-clusters/recompute-labels: starting");

  void (async () => {
    let updated = 0;
    for (const id of ids) {
      await recomputeStoryCluster(id);
      updated += 1;
    }
    logger.info({ updated }, "story-clusters/recompute-labels: done");
  })();

  res.status(202).json({ queued: ids.length });
});

// Parse a `limit` query param, ignoring NaN/non-positive values so the service
// default applies instead of a bogus limit.
function parseLimit(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export default router;

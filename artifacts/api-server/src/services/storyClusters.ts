import {
  db,
  sourceDocumentsTable,
  storyClustersTable,
  clusterPairVerdictsTable,
  clusterMergesTable,
  vaultResortSnapshotsTable,
  trendMarkersTable,
  beatsTable,
  type SourceDocument,
  type StoryCluster,
  type ClusterCoverageStatus,
  type ClusterMergeRow,
  type ResortRunOutcome,
} from "@workspace/db";
import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { tokens, jaccard } from "./dedupe";
import { govDocDisplayTitle, isGovInfoDoc, stripGovBoilerplate } from "./govDoc";
import { isHubPage } from "./ingestGuards";
import { scoreCluster, strongestAuthorityTier, AUTHORITY_TIER_ORDER } from "./clusterScore";
import { getSiteSettings } from "./siteSettings";
import { isAiFunctionEnabled } from "./aiSettings";
import { llmClusterSameStory } from "./llm";
import {
  acquireJobLock,
  heartbeatJob,
  finishJob,
  getJobState,
  forceReleaseJob,
  isCancelRequested,
  requestJobCancel,
} from "./jobState";
import http from "node:http";

// --- Story clustering (Task #199) ---------------------------------------
// Incrementally groups freshly-ingested vault sources into durable story
// clusters. Each unclustered, active source is assigned to the best-matching
// same-beat cluster by lexical token overlap (dedupe tokens/jaccard) or seeds a
// a new cluster. Every touched cluster is then FULLY recomputed from its members
// (counts, syndication-aware diversity, authority, recency, deterministic score,
// keywords, label) so aggregates never drift. A separate sweep ages clusters to
// `dormant` and reopens covered / do-not-cover clusters once their resurface
// window elapses. NO paid AI anywhere in this module.

// Minimum lexical overlap for a source to join an existing cluster.
const JOIN_THRESHOLD = 0.2;
// How many unclustered docs one clustering pass processes (bounded per tick).
const CLUSTER_BATCH_SIZE = 40;
// How many representative keywords a cluster keeps for matching + display.
const MAX_KEYWORDS = 25;

// Masthead boilerplate that some sources (notably Wikipedia) carry where a real
// summary should be. Left in, `{wikipedia,free,encyclopedia}` becomes the ONLY
// vocabulary shared across otherwise-unrelated pages, false-merging them into
// one junk cluster. Always stripped before tokenizing.
const BOILERPLATE_RE = /from\s+wikipedia,?\s+the\s+free\s+encyclopedia/gi;
// When a source's excerpt is boilerplate/too thin, substitute a bounded lead of
// the extracted body so clustering tokenizes real content instead of a near-empty
// title. Bounded to keep token counts in the same regime as a normal excerpt —
// validated on prod data that unrelated Wikipedia pages then separate while real
// multi-source clusters are unaffected (their real excerpts are used as-is).
const BODY_LEAD_CHARS = 500;
const MIN_MEANINGFUL_EXCERPT = 40;

/** Strip masthead boilerplate and collapse whitespace. */
function stripBoilerplate(s: string): string {
  return s.replace(BOILERPLATE_RE, " ").replace(/\s+/g, " ").trim();
}

/**
 * Text used to tokenize a source for clustering. Normally title + excerpt + lead
 * snippet; when the excerpt is boilerplate/too thin (e.g. Wikipedia, whose real
 * article body IS stored in `extractedText` but whose Readability excerpt is just
 * the masthead line), a bounded lead of the extracted body is substituted so real
 * content — not near-empty boilerplate — drives clustering.
 */
function docText(d: SourceDocument): string {
  // GovInfo documents share a fixed masthead ("119TH CONGRESS", "HOUSE OF
  // REPRESENTATIVES", session serials…) that otherwise dominates the token set
  // and false-merges UNRELATED reports/hearings into one giant cluster. Strip
  // that structural vocabulary and swap the opaque serial title for the
  // extracted human subject so only the document's actual topic drives
  // clustering. Same failure mode + fix as the Wikipedia masthead above.
  if (isGovInfoDoc(d.domain)) {
    const subject = govDocDisplayTitle(d) ?? d.title ?? "";
    const lead = stripGovBoilerplate(
      stripBoilerplate((d.extractedText ?? d.excerpt ?? "").slice(0, BODY_LEAD_CHARS * 3)),
    ).slice(0, BODY_LEAD_CHARS);
    return [subject, lead].join(" ").trim();
  }
  const excerpt = stripBoilerplate(d.excerpt ?? "");
  const lead =
    excerpt.length >= MIN_MEANINGFUL_EXCERPT
      ? excerpt
      : stripBoilerplate((d.extractedText ?? "").slice(0, BODY_LEAD_CHARS * 3)).slice(
          0,
          BODY_LEAD_CHARS,
        );
  return [d.title ?? "", lead, d.leadSnippet ?? ""].join(" ").trim();
}

/** Best timestamp representing when a source's story surfaced. */
function docWhen(d: SourceDocument): Date {
  return d.publishedAt ?? d.fetchedAt ?? d.createdAt;
}

/** Resolve the freshness window (days) for a beat/sub-beat slug from settings. */
function freshnessDaysFor(
  slug: string | null,
  settings: { sourceFreshnessDefaultDays: number; sourceFreshnessByBeat: Record<string, number> },
): number {
  const def = settings.sourceFreshnessDefaultDays > 0 ? settings.sourceFreshnessDefaultDays : 7;
  if (!slug) return def;
  const override = settings.sourceFreshnessByBeat[slug];
  return typeof override === "number" && override > 0 ? override : def;
}

/** Frequency-rank tokens across the given texts, keeping the top `MAX_KEYWORDS`. */
function deriveKeywords(texts: string[]): string[] {
  const freq = new Map<string, number>();
  for (const t of texts) {
    for (const tok of tokens(t)) freq.set(tok, (freq.get(tok) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_KEYWORDS)
    .map(([tok]) => tok);
}

export interface ClusteringResult {
  processed: number;
  assigned: number;
  created: number;
  recomputed: number;
}

/** A drizzle executor: either the pool handle or an open transaction. */
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Run one bounded clustering pass over unclustered, active, non-duplicate
 * sources that carry a beat.
 *
 * The ENTIRE pass runs inside a single transaction: candidate rows are locked
 * with `FOR UPDATE SKIP LOCKED` (so an overlapping per-minute tick can never
 * process the same docs — the clustering claim window is only per-minute and a
 * long pass can spill past it), and every write — the `clustered_at` stamp,
 * cluster assignment, cluster creation, and recompute — commits together or
 * not at all. **Why a tx and not a claim-then-process UPDATE:** stamping
 * `clustered_at` up front and processing afterwards means any failure (or a
 * crash) between claim and assignment leaves docs with `clustered_at != null`
 * and `cluster_id = null`, which the candidate predicate (`clustered_at IS
 * NULL`) then excludes FOREVER — a permanent data-loss path. Rolling the whole
 * pass back on error keeps those docs claimable next tick. There are no network
 * calls inside the pass (no paid AI anywhere), so holding the tx is cheap.
 * Never throws — on error it logs and returns whatever counts were tallied.
 */
export async function runClustering(now: Date = new Date()): Promise<ClusteringResult> {
  const result: ClusteringResult = { processed: 0, assigned: 0, created: 0, recomputed: 0 };

  const settings = await getSiteSettings();

  try {
    await db.transaction(async (tx) => {
      // Lock a bounded batch of candidate sources for the life of the tx.
      // Candidate sources are ingested (extracted/embedded), editorially active,
      // not a syndicated duplicate, carrying a beat, and not yet clustered.
      const locked = await tx.execute<{ id: string }>(sql`
        SELECT "id" FROM "source_documents"
        WHERE "clustered_at" IS NULL
          AND "duplicate_of_id" IS NULL
          AND "lifecycle_status" = 'active'
          AND "status" IN ('extracted', 'embedded')
          AND "beat_slug" IS NOT NULL
        ORDER BY "created_at" ASC
        LIMIT ${CLUSTER_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      `);
      const lockedIds = (locked.rows ?? []).map((r) => r.id);
      if (lockedIds.length === 0) return;

      // Re-read the locked rows as fully-typed (camelCase) documents to process.
      const candidates = await tx
        .select()
        .from(sourceDocumentsTable)
        .where(inArray(sourceDocumentsTable.id, lockedIds))
        .orderBy(sourceDocumentsTable.createdAt);

      // Per-beat cache of existing active clusters (id + keyword set) to match
      // into, extended with any clusters created during this pass.
      const beatCache = new Map<string, Array<{ id: string; keywords: Set<string> }>>();
      const slugName = new Map<string, string>();
      const touched = new Set<string>();

      async function activeClustersForBeat(beatSlug: string) {
        const cached = beatCache.get(beatSlug);
        if (cached) return cached;
        const rows = await tx
          .select({ id: storyClustersTable.id, keywords: storyClustersTable.keywords })
          .from(storyClustersTable)
          .where(
            and(eq(storyClustersTable.beatSlug, beatSlug), eq(storyClustersTable.status, "active")),
          );
        const mapped = rows.map((r) => ({ id: r.id, keywords: new Set(r.keywords) }));
        beatCache.set(beatSlug, mapped);
        return mapped;
      }

      async function beatName(beatSlug: string): Promise<string> {
        const cached = slugName.get(beatSlug);
        if (cached) return cached;
        const [b] = await tx
          .select({ name: beatsTable.name })
          .from(beatsTable)
          .where(eq(beatsTable.slug, beatSlug))
          .limit(1);
        const name = b?.name ?? beatSlug;
        slugName.set(beatSlug, name);
        return name;
      }

      for (const doc of candidates) {
        result.processed += 1;
        const beatSlug = doc.beatSlug!;
        const docTokens = tokens(docText(doc));

        // Hub/section/index pages are link-lists, not stories: their headline
        // soup false-merges unrelated stories and their generic titles become
        // cluster labels. Stamp them processed but never cluster them (same
        // mechanism as the zero-token path below). Logged so over-blocking
        // (a real story matching a hub pattern) is visible in the logs.
        const hub = isHubPage(doc);
        if (docTokens.size === 0 || hub) {
          if (hub) {
            logger.info(
              { documentId: doc.id, url: doc.url, title: doc.title },
              "Clustering: hub/section page excluded from clustering",
            );
          }
          // Nothing to match on — stamp it processed (so it isn't retried
          // forever) but leave it unclustered (no cluster_id).
          await tx
            .update(sourceDocumentsTable)
            .set({ clusteredAt: now, updatedAt: new Date() })
            .where(eq(sourceDocumentsTable.id, doc.id));
          continue;
        }

        const clusters = await activeClustersForBeat(beatSlug);
        let bestId: string | null = null;
        let bestScore = 0;
        for (const c of clusters) {
          const s = jaccard(docTokens, c.keywords);
          if (s > bestScore) {
            bestScore = s;
            bestId = c.id;
          }
        }

        let targetId: string;
        if (bestId && bestScore >= JOIN_THRESHOLD) {
          targetId = bestId;
          result.assigned += 1;
        } else {
          const label =
            govDocDisplayTitle(doc) ?? ((doc.title ?? doc.leadSnippet ?? "").trim() || doc.domain);
          const [created] = await tx
            .insert(storyClustersTable)
            .values({
              beatSlug,
              beat: await beatName(beatSlug),
              label,
              keywords: [...docTokens].slice(0, MAX_KEYWORDS),
              status: "active",
              firstSeenAt: docWhen(doc),
              lastSeenAt: docWhen(doc),
            })
            .returning({ id: storyClustersTable.id });
          targetId = created!.id;
          clusters.push({ id: targetId, keywords: docTokens });
          result.created += 1;
        }

        // Stamp assignment + processed marker together, inside the tx.
        await tx
          .update(sourceDocumentsTable)
          .set({ clusterId: targetId, clusteredAt: now, updatedAt: new Date() })
          .where(eq(sourceDocumentsTable.id, doc.id));
        touched.add(targetId);
      }

      // Recompute every touched cluster in the same tx. A recompute failure
      // rolls the whole pass back (docs stay claimable) rather than leaving
      // half-updated aggregates.
      for (const id of touched) {
        await recomputeCluster(id, now, settings, tx);
        result.recomputed += 1;
      }
    });
  } catch (err) {
    logger.warn({ err }, "storyClusters: clustering pass rolled back");
  }

  return result;
}

// --- Vault re-sort (one-shot maintenance) ------------------------------
// After a change to how sources are tokenized/scored, EXISTING clusters keep
// their stale groupings + stored scores (incremental clustering only ever touches
// freshly-ingested docs). This operator-triggered pass brings the back-catalogue
// in line with the current logic in two phases:
//   A. Recompute every SURVIVING (protected) cluster so the corrected score
//      applies to already-grouped stories.
//   B. Release the members of every un-acted-upon cluster (no promoted idea /
//      article, no evidence packet, no attached trend marker, no coverage
//      decision) and re-run clustering to a fixpoint, so previously false-merged
//      groups (e.g. unrelated pages sharing only boilerplate vocabulary) split
//      apart under the corrected tokenizer. The now-empty released clusters are
//      deleted.
// Clusters that carry ANY downstream lineage or an editorial coverage decision
// are left completely untouched so evidence-packet history and article lineage
// never dangle. Guarded by the shared background-job lock (single-flight, TTL
// stale-takeover, cooperative cancel) and fully idempotent — re-running converges
// on the same grouping.
const VAULT_RESORT_JOB = "vault_resort";
const VAULT_RESORT_TTL_MS = 15 * 60 * 1000;

/** Interval between self-keepalive pings during a long re-sort.
 * Autoscale instances idle out after ~15 min of no incoming requests.
 * Phase C (the semantic reconciler) can run 30-60 min with zero HTTP
 * traffic — pinging /healthz every 60s keeps the instance alive.
 * The DB ping keeps the Neon connection from expiring during the long
 * gaps while the LLM judge is running (can be 1-3 min per pair). */
const KEEPALIVE_INTERVAL_MS = 60_000;

/** Send a lightweight HTTP GET to localhost /api/healthz to keep the autoscale
 * instance alive during long background work. Never throws — fire-and-forget. */
function pingKeepalive(): void {
  const port = process.env["PORT"] ?? "8080";
  const req = http.get(`http://127.0.0.1:${port}/api/healthz`, { timeout: 5000 }, (res) => {
    res.resume(); // consume response so socket closes promptly
  });
  req.on("error", () => {
    /* ignore — keepalive is best-effort */
  });
  req.on("timeout", () => {
    req.destroy();
  });
}

/** Fire a lightweight DB query to prevent the Neon connection from expiring
 * during the long gaps between DB writes in Phase C. Never throws. */
function pingDbKeepalive(): void {
  db.execute(sql`SELECT 1`).catch(() => {
    /* best-effort — pool will reconnect on the next real query */
  });
}

class ResortCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "ResortCancelled";
  }
}

export interface VaultResortResult {
  // Protected clusters re-scored in place (phase A).
  recomputed: number;
  /** Total clusters to re-score in phase A (set once at start of phase A). */
  totalToRecompute: number;
  // Un-acted clusters whose members were released + deleted (phase B).
  releasedClusters: number;
  docsReleased: number;
  clustersDeleted: number;
  // Aggregate of the re-clustering passes over the released docs.
  reclustered: ClusteringResult;
  // Aggregate of the semantic reconciler passes (phase C).
  reconciled: ReconcilerResult;
}

export interface VaultResortJobStatus extends VaultResortResult {
  running: boolean;
  /** runId of the current/last run — lets the UI tell "this snapshot's run is
   * the one currently running" apart from "its run was interrupted". */
  runId: string | null;
  phase: string | null;
  startedAt: string | null;
  heartbeatAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

/** Which phase a re-sort starts from. "a" = full run; "b" resumes after the
 * re-score (typically after restoring a pre_b snapshot); "c" runs only the
 * semantic merge (after restoring a pre_c snapshot). */
export type ResortStartPhase = "a" | "b" | "c";

/** Claim the single-flight re-sort lock. Returns a runId, or null if busy. */
export async function beginVaultResortJob(): Promise<string | null> {
  return acquireJobLock(VAULT_RESORT_JOB, {
    ttlMs: VAULT_RESORT_TTL_MS,
    progress: { phase: "starting" },
  });
}

function emptyResortResult(): VaultResortResult {
  return {
    recomputed: 0,
    totalToRecompute: 0,
    releasedClusters: 0,
    docsReleased: 0,
    clustersDeleted: 0,
    reclustered: { processed: 0, assigned: 0, created: 0, recomputed: 0 },
    reconciled: { judged: 0, merged: 0, distinct: 0, uncertain: 0, skipped: 0 },
  };
}

/** Request cooperative cancellation of a running re-sort. Returns true when a
 * running job was found and flagged; false when nothing is running. */
export async function cancelVaultResortJob(): Promise<boolean> {
  return requestJobCancel(VAULT_RESORT_JOB);
}

/** Force-release a stale/crashed re-sort (heartbeat older than half the TTL).
 * Safe to call alongside cancelVaultResortJob — no-ops if nothing is running.
 * Threshold is STALL_MS (3 min) to stay in sync with the UI's "Clear stuck job"
 * button, not the full TTL (15 min). The UI declares stalled at 3 min; if the
 * backend waits 7.5 min, the operator clicks "Clear" repeatedly and nothing
 * happens. */
export async function forceReleaseVaultResortIfStale(): Promise<boolean> {
  const row = await getJobState(VAULT_RESORT_JOB);
  if (!row || row.status !== "running") return false;
  const age = row.heartbeatAt ? Date.now() - new Date(row.heartbeatAt).getTime() : Infinity;
  const STALL_MS = 3 * 60 * 1000;
  if (age < STALL_MS) return false; // still fresh enough — leave cooperative cancel to handle it
  // The crashed run's snapshots would otherwise stay outcome-less ("interrupted"
  // in the UI) — stamp them failed so the cards reflect what happened.
  if (row.runId) await markRunSnapshotsOutcome(row.runId, "failed");
  return forceReleaseJob(VAULT_RESORT_JOB);
}

/** Read the current/last re-sort job state, mapped for the admin poller.
 * A "running" row whose heartbeat is older than the TTL is a crashed run
 * (e.g. the server restarted mid-run and killed the fire-and-forget promise) —
 * without this check the UI would show it as running/"comparing…" forever.
 * We finish the row as failed so the operator can restart or restore. */
export async function getVaultResortJob(): Promise<VaultResortJobStatus> {
  let row = await getJobState(VAULT_RESORT_JOB);
  if (row?.status === "running") {
    const age = row.heartbeatAt ? Date.now() - new Date(row.heartbeatAt).getTime() : Infinity;
    if (age > VAULT_RESORT_TTL_MS) {
      logger.warn(
        { heartbeatAt: row.heartbeatAt, ageMs: age },
        "storyClusters: vault re-sort heartbeat stale — releasing crashed run",
      );
      await forceReleaseJob(
        VAULT_RESORT_JOB,
        "stalled — run died without a heartbeat (server likely restarted mid-run)",
      );
      // Stamp the dead run's snapshots as failed so the admin panel can badge
      // them accurately (they'd otherwise sit outcome-less forever, since the
      // crashed promise never reached its own catch block).
      if (row.runId) await markRunSnapshotsOutcome(row.runId, "failed");
      row = await getJobState(VAULT_RESORT_JOB);
    }
  }
  const progress = (row?.progress ?? {}) as Partial<VaultResortResult> & { phase?: string };
  const base = emptyResortResult();
  return {
    running: row?.status === "running",
    runId: row?.runId ?? null,
    phase: progress.phase ?? null,
    startedAt: row?.startedAt ?? null,
    heartbeatAt: row?.heartbeatAt ?? null,
    finishedAt: row?.finishedAt ?? null,
    error: row?.error ?? null,
    recomputed: progress.recomputed ?? base.recomputed,
    totalToRecompute: progress.totalToRecompute ?? base.totalToRecompute,
    releasedClusters: progress.releasedClusters ?? base.releasedClusters,
    docsReleased: progress.docsReleased ?? base.docsReleased,
    clustersDeleted: progress.clustersDeleted ?? base.clustersDeleted,
    reclustered: progress.reclustered ?? base.reclustered,
    reconciled: progress.reconciled ?? base.reconciled,
  };
}

/**
 * Run the vault re-sort under a previously-acquired lock (`runId`). Never throws
 * — always resolves the job (succeeded / failed) so the poller unwinds. See the
 * section comment above for the two-phase design + safety envelope.
 */
export async function runVaultResort(
  runId: string,
  now: Date = new Date(),
  startPhase: ResortStartPhase = "a",
): Promise<VaultResortResult> {
  const result = emptyResortResult();
  const heartbeat = (phase: string) =>
    heartbeatJob(VAULT_RESORT_JOB, runId, { phase, ...result });
  const ensureLive = async () => {
    if (await isCancelRequested(VAULT_RESORT_JOB)) throw new ResortCancelled();
  };

  // Start a self-keepalive timer so the autoscale instance isn't killed for
  // idleness during the long Phase C reconciler (can run 30-60 min with zero
  // incoming HTTP traffic). Pings /healthz every 60s; cleared on completion.
  const keepaliveTimer =
    process.env["NODE_ENV"] === "production"
      ? setInterval(() => {
          pingKeepalive();
          pingDbKeepalive();
        }, KEEPALIVE_INTERVAL_MS)
      : null;

  try {
    const settings = await getSiteSettings();
    await heartbeat("preparing");

    // Clusters that carry downstream lineage or an editorial coverage decision
    // must NEVER be re-clustered/deleted (would orphan packets or break article
    // lineage). Everything else — plain "open" clusters that were never acted on
    // — is eligible for release. Only needed when Phase A or B will run.
    let eligibleIds = new Set<string>();
    if (startPhase !== "c") {
      const eligibleRows = await db.execute<{ id: string }>(sql`
        SELECT c."id" FROM "story_clusters" c
        WHERE c."coverage_status" = 'open'
          AND c."covered_article_id" IS NULL
          AND NOT EXISTS (SELECT 1 FROM "topic_ideas" ti WHERE ti."cluster_id" = c."id")
          AND NOT EXISTS (SELECT 1 FROM "articles" a WHERE a."cluster_id" = c."id")
          AND NOT EXISTS (SELECT 1 FROM "evidence_packets" ep WHERE ep."cluster_id" = c."id")
          AND NOT EXISTS (SELECT 1 FROM "trend_markers" tm WHERE tm."cluster_id" = c."id")
      `);
      eligibleIds = new Set((eligibleRows.rows ?? []).map((r) => r.id));
    }
    await heartbeat("snapshot_a");

    if (startPhase === "a") {
      // Snapshot before Phase A: captures initial vault state so restore is
      // possible if the run fails at any later phase.
      await saveResortSnapshot(runId, "pre_a");

      // --- Phase A: re-score the protected (surviving) clusters in place.
      const allIds = await db
        .select({ id: storyClustersTable.id })
        .from(storyClustersTable);
      // Exclude eligible (will be deleted) from the recompute count so the
      // "X of Y" progress display only counts the clusters that actually run.
      const protectedIds = allIds.filter(({ id }) => !eligibleIds.has(id));
      result.totalToRecompute = protectedIds.length;
      await heartbeat("recompute"); // initial heartbeat so UI shows total immediately
      logger.info(
        { total: protectedIds.length, eligible: eligibleIds.size },
        "storyClusters: vault re-sort Phase A starting",
      );
      // Run in concurrent batches so Phase A finishes in O(N/10) time instead of O(N).
      // Each batch checks for cancellation before submitting, then heartbeats after.
      const PHASE_A_CONCURRENCY = 10;
      for (let i = 0; i < protectedIds.length; i += PHASE_A_CONCURRENCY) {
        await ensureLive();
        const batch = protectedIds.slice(i, i + PHASE_A_CONCURRENCY);
        await Promise.all(batch.map(({ id }) => recomputeCluster(id, now, settings)));
        result.recomputed += batch.length;
        await heartbeat("recompute");
      }
      await heartbeat("recompute");
    } else {
      logger.info({ startPhase }, "storyClusters: vault re-sort resuming at later phase");
    }

    if (startPhase !== "c") {
    await heartbeat("snapshot_b");
    // Snapshot before Phase B: captures re-scored cluster state (or, on a
    // resume-at-B, the restored state the run is continuing from).
    await saveResortSnapshot(runId, "pre_b");

    // --- Phase B: release + delete un-acted clusters, then re-cluster.
    if (eligibleIds.size > 0) {
      const ids = [...eligibleIds];

      // RE-VALIDATE eligibility AT DELETE TIME. The snapshot above was taken
      // before Phase A (which can run for a while); in that window another admin
      // action may have attached lineage (a draft, article, packet or marker) to
      // a once-eligible cluster. References are soft (no FK), so a stale delete
      // would silently orphan that lineage. Deleting with the same guards in one
      // atomic statement means any cluster that gained lineage mid-run no longer
      // matches and survives untouched; RETURNING tells us exactly what went.
      const deletedRows = await db.execute<{ id: string }>(sql`
        DELETE FROM "story_clusters" c
        WHERE c."id" IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})
          AND c."coverage_status" = 'open'
          AND c."covered_article_id" IS NULL
          AND NOT EXISTS (SELECT 1 FROM "topic_ideas" ti WHERE ti."cluster_id" = c."id")
          AND NOT EXISTS (SELECT 1 FROM "articles" a WHERE a."cluster_id" = c."id")
          AND NOT EXISTS (SELECT 1 FROM "evidence_packets" ep WHERE ep."cluster_id" = c."id")
          AND NOT EXISTS (SELECT 1 FROM "trend_markers" tm WHERE tm."cluster_id" = c."id")
        RETURNING c."id"
      `);
      const deletedIds = (deletedRows.rows ?? []).map((r) => r.id);
      result.clustersDeleted = deletedIds.length;

      // Release docs for EXACTLY the clusters we deleted (not the stale snapshot)
      // so a survivor keeps its members clustered.
      if (deletedIds.length > 0) {
        const released = await db
          .update(sourceDocumentsTable)
          .set({ clusterId: null, clusteredAt: null, updatedAt: new Date() })
          .where(inArray(sourceDocumentsTable.clusterId, deletedIds))
          .returning({ id: sourceDocumentsTable.id });
        result.docsReleased = released.length;
        result.releasedClusters = deletedIds.length;
      }
      if (deletedIds.length !== ids.length) {
        logger.info(
          { eligible: ids.length, deleted: deletedIds.length },
          "storyClusters: vault re-sort kept clusters that gained lineage mid-run",
        );
      }
      await heartbeat("recluster");
    }

    // Re-run clustering to a fixpoint over the released docs (bounded batches).
    for (let guard = 0; guard < 5000; guard += 1) {
      await ensureLive();
      const pass = await runClustering(now);
      result.reclustered.processed += pass.processed;
      result.reclustered.assigned += pass.assigned;
      result.reclustered.created += pass.created;
      result.reclustered.recomputed += pass.recomputed;
      await heartbeat("recluster");
      if (pass.processed === 0) break;
    }
    } // end Phase B (skipped when resuming at "c")

    await heartbeat("snapshot_c");
    // Snapshot before Phase C: captures post-recluster state (or, on a
    // resume-at-C, the restored state the run is continuing from).
    await saveResortSnapshot(runId, "pre_c");

    // --- Phase C: semantic reconciler fixpoint.
    // The lexical clustering pass (JOIN_THRESHOLD = 0.2) leaves pairs with
    // Jaccard 0.08–0.18 as separate singleton clusters. The reconciler asks the
    // LLM to merge those that are the same story. We bypass the
    // semanticClusterReconcileEnabled site setting here (the re-sort is an
    // explicit full-reprocess action — all stages should run), but still gate on
    // the AI function so a hard-disabled environment isn't surprised. Each
    // reconciler pass may merge clusters whose members now push some third cluster
    // into the 0.08–0.18 window, so we run to fixpoint (bounded).
    await heartbeat("reconcile");
    // Thread cancel + heartbeat into the reconciler's inner pair loop so cancel
    // is responsive mid-pass, not only between passes. ResortCancelled propagates
    // straight through the reconciler and is caught by the outer try/catch below.
    // The reconciler passes its LIVE in-pass counts via `partial`; merge them
    // with the counts accumulated from completed passes so the status endpoint
    // shows real-time judged/merged numbers, not 0 until the pass finishes.
    const reconcilerProgress = async (partial: ReconcilerResult) => {
      await heartbeatJob(VAULT_RESORT_JOB, runId, {
        phase: "reconcile",
        ...result,
        reconciled: {
          judged: result.reconciled.judged + partial.judged,
          merged: result.reconciled.merged + partial.merged,
          distinct: result.reconciled.distinct + partial.distinct,
          uncertain: result.reconciled.uncertain + partial.uncertain,
          skipped: result.reconciled.skipped + partial.skipped,
        },
      });
      if (await isCancelRequested(VAULT_RESORT_JOB)) throw new ResortCancelled();
    };
    for (let rPass = 0; rPass < 20; rPass++) {
      await ensureLive();
      const rec = await runSemanticClusterReconciler(now, {
        forceRun: true,
        onProgress: reconcilerProgress,
      });
      result.reconciled.judged += rec.judged;
      result.reconciled.merged += rec.merged;
      result.reconciled.distinct += rec.distinct;
      result.reconciled.uncertain += rec.uncertain;
      result.reconciled.skipped += rec.skipped;
      await heartbeat("reconcile");
      if (rec.merged === 0) break; // converged — no more pairs to merge
    }

    // Keep the run's snapshots (badged as a finished run in the admin panel;
    // auto-expire 72h after run_finished_at) so the operator can still inspect
    // or roll back a successful sort until they're satisfied with the result.
    await markRunSnapshotsOutcome(runId, "succeeded");
    await finishJob(VAULT_RESORT_JOB, runId, "succeeded", {
      progress: { phase: "done", ...result },
    });
  } catch (err) {
    const cancelled = err instanceof ResortCancelled;
    if (!cancelled) logger.error({ err }, "storyClusters: vault re-sort failed");
    // Never let outcome-stamping failure prevent the job-lock release below —
    // a stuck "running" row would block re-runs until TTL takeover. The stale
    // detector re-stamps unstamped snapshots "failed" later anyway.
    try {
      await markRunSnapshotsOutcome(runId, cancelled ? "cancelled" : "failed");
    } catch (stampErr) {
      logger.error({ err: stampErr }, "storyClusters: failed to stamp snapshot outcome");
    }
    await finishJob(VAULT_RESORT_JOB, runId, "failed", {
      progress: { phase: cancelled ? "cancelled" : "error", ...result },
      error: cancelled ? "cancelled" : err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
    }
  }

  return result;
}

// --- Vault re-sort snapshots -------------------------------------------
// Captures full cluster state (story_clusters rows + doc assignments +
// cluster_pair_verdicts) at each phase boundary. Snapshots are kept after the
// run terminates — stamped with the run's outcome (succeeded/failed/cancelled)
// so the admin panel can badge them — and an admin can restore any of them,
// then resume the re-sort from that phase. Snapshots of a SUCCEEDED run
// auto-expire 72h after run_finished_at (lazy purge in listResortSnapshots);
// failed/cancelled-run snapshots are kept until manually deleted.

/** Capture current vault state. Called before each major phase. Internal only. */
async function saveResortSnapshot(
  runId: string,
  snapshotType: "pre_a" | "pre_b" | "pre_c",
): Promise<void> {
  const [clusters, docRows, pairVerdicts] = await Promise.all([
    db.select().from(storyClustersTable),
    db
      .select({ id: sourceDocumentsTable.id, clusterId: sourceDocumentsTable.clusterId })
      .from(sourceDocumentsTable)
      .where(isNotNull(sourceDocumentsTable.clusterId)),
    db.select().from(clusterPairVerdictsTable),
  ]);
  await db.insert(vaultResortSnapshotsTable).values({
    runId,
    snapshotType,
    clusterCount: clusters.length,
    docCount: docRows.length,
    verdictCount: pairVerdicts.length,
    clustersJson: clusters,
    docAssignmentsJson: docRows.map((d) => ({ id: d.id, clusterId: d.clusterId! })),
    pairVerdictsJson: pairVerdicts,
  });
  logger.info(
    { runId, snapshotType, clusters: clusters.length, docs: docRows.length },
    "vault-resort: snapshot saved",
  );
}

/** How long a SUCCEEDED run's snapshots are kept before lazy auto-purge. */
const FINISHED_SNAPSHOT_RETENTION_MS = 72 * 60 * 60 * 1000;

/** Stamp every snapshot of a run with the run's terminal outcome. Succeeded
 * runs also get run_finished_at, which starts the 72h auto-expiry clock.
 * Idempotent and only fills NULL outcomes, so a late stamp from a superseded
 * runner can't overwrite an earlier verdict. */
async function markRunSnapshotsOutcome(
  runId: string,
  outcome: ResortRunOutcome,
): Promise<void> {
  await db
    .update(vaultResortSnapshotsTable)
    .set({
      runOutcome: outcome,
      runFinishedAt: outcome === "succeeded" ? new Date() : null,
    })
    .where(
      and(
        eq(vaultResortSnapshotsTable.runId, runId),
        isNull(vaultResortSnapshotsTable.runOutcome),
      ),
    );
}

/** List snapshots (metadata only — no JSON payload) for the admin UI.
 * Lazily purges snapshots of succeeded runs older than the 72h retention
 * window before returning, so expiry needs no separate cron. */
export async function listResortSnapshots() {
  await db
    .delete(vaultResortSnapshotsTable)
    .where(
      and(
        eq(vaultResortSnapshotsTable.runOutcome, "succeeded"),
        lt(
          vaultResortSnapshotsTable.runFinishedAt,
          new Date(Date.now() - FINISHED_SNAPSHOT_RETENTION_MS),
        ),
      ),
    );
  return db
    .select({
      id: vaultResortSnapshotsTable.id,
      runId: vaultResortSnapshotsTable.runId,
      snapshotType: vaultResortSnapshotsTable.snapshotType,
      clusterCount: vaultResortSnapshotsTable.clusterCount,
      docCount: vaultResortSnapshotsTable.docCount,
      verdictCount: vaultResortSnapshotsTable.verdictCount,
      runOutcome: vaultResortSnapshotsTable.runOutcome,
      runFinishedAt: vaultResortSnapshotsTable.runFinishedAt,
      createdAt: vaultResortSnapshotsTable.createdAt,
    })
    .from(vaultResortSnapshotsTable)
    .orderBy(desc(vaultResortSnapshotsTable.createdAt));
}

/** Delete one snapshot by id. Returns false if it did not exist. */
export async function deleteResortSnapshot(id: string): Promise<boolean> {
  const deleted = await db
    .delete(vaultResortSnapshotsTable)
    .where(eq(vaultResortSnapshotsTable.id, id))
    .returning({ id: vaultResortSnapshotsTable.id });
  return deleted.length > 0;
}

/** Delete ALL snapshots across all runs (admin "clear all" command). */
export async function deleteAllResortSnapshots(): Promise<number> {
  const deleted = await db
    .delete(vaultResortSnapshotsTable)
    .returning({ id: vaultResortSnapshotsTable.id });
  return deleted.length;
}

/**
 * Restore vault cluster state from a snapshot.
 *
 * Re-applies story_clusters rows, source_document cluster assignments, and
 * cluster_pair_verdicts to exactly the state at snapshot time. Clusters created
 * AFTER the snapshot (by Phase B/C) are deleted if they are still lineage-free
 * (same eligibility guard as Phase B). Any lineage-carrying cluster absent from
 * the snapshot is left in place rather than deleted.
 */
export async function restoreResortSnapshot(
  id: string,
): Promise<{ clustersRestored: number; docsRestored: number; verdictsRestored: number }> {
  // Mutual exclusion with a running re-sort at the DB LOCK layer (not a
  // preflight status check, which would be a TOCTOU race — a new run could
  // claim the lock between the check and our writes). We claim the SAME
  // background_jobs row the re-sort uses: if a run is live, the claim fails
  // and we refuse; while we hold it, POST /resort returns alreadyRunning.
  // acquireJobLock's TTL stale-takeover means a crashed run never deadlocks
  // this. The lock is released in the finally below.
  const lockRunId = await acquireJobLock(VAULT_RESORT_JOB, {
    ttlMs: VAULT_RESORT_TTL_MS,
    progress: { phase: "restoring" },
  });
  if (!lockRunId) {
    throw new Error("A vault re-sort is currently in progress — cancel it before restoring a snapshot");
  }
  try {
    const result = await restoreResortSnapshotLocked(id);
    await finishJob(VAULT_RESORT_JOB, lockRunId, "succeeded", {
      progress: { phase: "restore-done" },
    });
    return result;
  } catch (err) {
    // finishJob is not status-guarded, so failure and success paths must each
    // stamp exactly once — never both.
    await finishJob(VAULT_RESORT_JOB, lockRunId, "failed", {
      progress: { phase: "restore-failed" },
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** Inner restore body — caller (restoreResortSnapshot) holds the re-sort job lock. */
async function restoreResortSnapshotLocked(
  id: string,
): Promise<{ clustersRestored: number; docsRestored: number; verdictsRestored: number }> {
  const [snap] = await db
    .select()
    .from(vaultResortSnapshotsTable)
    .where(eq(vaultResortSnapshotsTable.id, id))
    .limit(1);
  if (!snap) throw new Error(`Snapshot ${id} not found`);

  // JSONB round-trips Date columns into ISO STRINGS. Drizzle's timestamp
  // mapToDriverValue calls value.toISOString() unconditionally, so feeding
  // these rows straight into insert()/onConflictDoUpdate crashes at runtime
  // ("value.toISOString is not a function"). Revive every timestamp field
  // back into a Date before any write.
  const reviveDate = (v: unknown): Date | null =>
    v == null ? null : v instanceof Date ? v : new Date(v as string);
  const reviveDateRequired = (v: unknown): Date => reviveDate(v) ?? new Date();

  const clusterRows = (snap.clustersJson as StoryCluster[]).map((c) => ({
    ...c,
    firstSeenAt: reviveDateRequired(c.firstSeenAt),
    lastSeenAt: reviveDateRequired(c.lastSeenAt),
    freshUntil: reviveDate(c.freshUntil),
    coverageResurfaceAfter: reviveDate(c.coverageResurfaceAfter),
    archivedAt: reviveDate(c.archivedAt),
    createdAt: reviveDateRequired(c.createdAt),
    updatedAt: reviveDateRequired(c.updatedAt),
  }));
  const docAssignments = snap.docAssignmentsJson as { id: string; clusterId: string }[];
  const verdictRows = (
    snap.pairVerdictsJson as (typeof clusterPairVerdictsTable.$inferSelect)[]
  ).map((v) => ({
    ...v,
    judgedAt: reviveDateRequired(v.judgedAt),
    createdAt: reviveDateRequired(v.createdAt),
  }));
  const snapClusterIds = new Set(clusterRows.map((c) => c.id));

  return db.transaction(async (tx) => {
    // Step 1: find lineage-free clusters NOT in the snapshot (created during
    // Phase B/C) and delete them, releasing their docs first.
    const candidatesResult = await tx.execute<{ id: string }>(sql`
      SELECT c."id" FROM "story_clusters" c
      WHERE c."coverage_status" = 'open'
        AND c."covered_article_id" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "topic_ideas" ti WHERE ti."cluster_id" = c."id")
        AND NOT EXISTS (SELECT 1 FROM "articles" a WHERE a."cluster_id" = c."id")
        AND NOT EXISTS (SELECT 1 FROM "evidence_packets" ep WHERE ep."cluster_id" = c."id")
        AND NOT EXISTS (SELECT 1 FROM "trend_markers" tm WHERE tm."cluster_id" = c."id")
    `);
    const toDelete = (candidatesResult.rows ?? [])
      .map((r) => r.id)
      .filter((cId) => !snapClusterIds.has(cId));

    if (toDelete.length > 0) {
      await tx
        .update(sourceDocumentsTable)
        .set({ clusterId: null, clusteredAt: null, updatedAt: new Date() })
        .where(inArray(sourceDocumentsTable.clusterId, toDelete));
      await tx.execute(sql`
        DELETE FROM "story_clusters"
        WHERE "id" IN (${sql.join(toDelete.map((cId) => sql`${cId}::uuid`), sql`, `)})
      `);
    }

    // Step 2: UPSERT all snapshotted clusters back to their snapshotted state.
    let clustersRestored = 0;
    for (const c of clusterRows) {
      await tx
        .insert(storyClustersTable)
        .values(c)
        .onConflictDoUpdate({
          target: storyClustersTable.id,
          set: {
            label: c.label,
            keywords: c.keywords,
            status: c.status,
            score: c.score,
            scoreBreakdown: c.scoreBreakdown,
            sourceCount: c.sourceCount,
            familyCount: c.familyCount,
            domainCount: c.domainCount,
            topAuthorityTier: c.topAuthorityTier,
            markerCount: c.markerCount,
            lastSeenAt: c.lastSeenAt,
            freshUntil: c.freshUntil,
            coverageStatus: c.coverageStatus,
            coverageReason: c.coverageReason,
            coverageResurfaceAfter: c.coverageResurfaceAfter,
            coveredArticleId: c.coveredArticleId,
            archivedAt: c.archivedAt,
            updatedAt: new Date(),
          },
        });
      clustersRestored++;
    }

    // Step 3: restore doc assignments. Reset SCOPED to snapshot-owned clusters
    // only — a blanket reset would also strip the members of lineage-carrying
    // clusters created after the snapshot (which step 1 deliberately preserves),
    // leaving them alive but empty. Docs in step-1-deleted clusters were already
    // released above. A doc the snapshot claims that currently sits in a
    // preserved cluster is still re-pointed by the per-cluster restore below
    // (the snapshot wins for snapshot docs).
    if (snapClusterIds.size > 0) {
      await tx.execute(sql`
        UPDATE "source_documents"
        SET "cluster_id" = NULL, "clustered_at" = NULL, "updated_at" = now()
        WHERE "cluster_id" IN (${sql.join([...snapClusterIds].map((cId) => sql`${cId}::uuid`), sql`, `)})
      `);
    }
    const byCluster = new Map<string, string[]>();
    for (const d of docAssignments) {
      const list = byCluster.get(d.clusterId) ?? [];
      list.push(d.id);
      byCluster.set(d.clusterId, list);
    }
    // NOTE: clusteredAt must also be set here. The candidate predicate in
    // runClustering uses `clustered_at IS NULL` (not `cluster_id IS NULL`) to
    // avoid a permanent data-loss path where a crash leaves clustered_at=null
    // + cluster_id=null. Skipping clusteredAt would mark every restored doc as
    // "unclustered" and the next clustering tick would immediately re-queue them
    // all, corrupting the restored state. We use now() as the restore time —
    // the exact original value isn't stored in the snapshot and isn't needed.
    const restoredAt = new Date();
    for (const [clusterId, docIds] of byCluster) {
      await tx
        .update(sourceDocumentsTable)
        .set({ clusterId, clusteredAt: restoredAt, updatedAt: restoredAt })
        .where(inArray(sourceDocumentsTable.id, docIds));
    }

    // Step 4: restore pair verdicts (clear + re-insert).
    await tx.delete(clusterPairVerdictsTable);
    if (verdictRows.length > 0) {
      await tx.insert(clusterPairVerdictsTable).values(verdictRows);
    }

    logger.info(
      { snapshotId: id, clustersRestored, docsRestored: docAssignments.length, verdictsRestored: verdictRows.length },
      "vault-resort: snapshot restored",
    );
    return { clustersRestored, docsRestored: docAssignments.length, verdictsRestored: verdictRows.length };
  });
}

/**
 * Recompute a cluster's aggregates, deterministic score, keywords, label,
 * freshness window and status from its current member sources. Members that
 * became duplicates/inactive are excluded from scoring but the cluster is kept.
 */
async function recomputeCluster(
  clusterId: string,
  now: Date,
  settings: { sourceFreshnessDefaultDays: number; sourceFreshnessByBeat: Record<string, number> },
  exec: Executor = db,
): Promise<void> {
  const [cluster] = await exec
    .select()
    .from(storyClustersTable)
    .where(eq(storyClustersTable.id, clusterId))
    .limit(1);
  if (!cluster) return;

  const members = await exec
    .select()
    .from(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.clusterId, clusterId));

  // Score only over active, non-duplicate members (fresh support).
  const active = members.filter((m) => m.lifecycleStatus === "active" && !m.duplicateOfId);
  const scoring = active.length > 0 ? active : members;

  const families = new Set<string>();
  const domains = new Set<string>();
  for (const m of scoring) {
    families.add(m.sourceFamilyId ?? m.id);
    if (m.domain) domains.add(m.domain);
  }

  // Volume + diversity credit counts ONLY members that could actually
  // corroborate a story. `reference` sources (encyclopedias/background) are
  // context, never evidence — a pile of them must not inflate a cluster's heat
  // toward looking promotable (a reference-only cluster otherwise banked ~49 pts
  // on volume+diversity alone). Authority + recency still consider every member,
  // and the STORED counts below stay full so the admin display stays accurate.
  const creditable = scoring.filter((m) => m.authorityTier !== "reference");
  const creditFamilies = new Set(creditable.map((m) => m.sourceFamilyId ?? m.id));

  const topTier = strongestAuthorityTier(scoring.map((m) => m.authorityTier));
  const whens = scoring.map(docWhen);
  const newest = whens.length ? new Date(Math.max(...whens.map((d) => d.getTime()))) : null;
  const oldest = whens.length ? new Date(Math.min(...whens.map((d) => d.getTime()))) : cluster.firstSeenAt;

  const windowDays = freshnessDaysFor(cluster.beatSlug, settings);
  const freshUntil = newest ? new Date(newest.getTime() + windowDays * 24 * 60 * 60 * 1000) : null;

  // Count attached, non-dismissed trend markers (weak social observations). They
  // are NOT member sources — they only feed the velocity component below and can
  // never satisfy the authority floor.
  const [markerRow] = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(trendMarkersTable)
    .where(
      and(
        eq(trendMarkersTable.clusterId, clusterId),
        ne(trendMarkersTable.status, "dismissed"),
      ),
    );
  const markerCount = Number(markerRow?.n ?? 0);

  const { score, breakdown } = scoreCluster({
    sourceCount: creditable.length,
    familyCount: creditFamilies.size,
    domainCount: domains.size,
    topAuthorityTier: topTier,
    newestSourceAt: newest,
    freshnessWindowDays: windowDays,
    markerCount,
    now,
  });

  // Label = best available title from members. Two-pass selection:
  //  1. Prefer any doc that has a usable title (title or leadSnippet) over any
  //     doc that doesn't — a titled lower-tier doc beats an untitled primary
  //     source. Among titled docs, strongest authority tier wins, then recency.
  //  2. If NO doc has a usable title, fall back to the strongest-tier doc
  //     (bestTitle will be empty → we drop through to cluster.label).
  // `leadSnippet` carries the RSS feed item headline for feed-ingested sources
  // (e.g. GovInfo PDFs whose Readability-extracted title is null).
  const tierRank = (t: SourceDocument["authorityTier"]): number => {
    const idx = AUTHORITY_TIER_ORDER.indexOf(t);
    return idx >= 0 ? idx : AUTHORITY_TIER_ORDER.length;
  };
  const bestTitle = (d: SourceDocument): string =>
    govDocDisplayTitle(d) ?? (d.title ?? d.leadSnippet ?? "").trim();
  const tierRecencySort = (a: SourceDocument, b: SourceDocument): number => {
    const ra = tierRank(a.authorityTier), rb = tierRank(b.authorityTier);
    return ra !== rb ? ra - rb : docWhen(b).getTime() - docWhen(a).getTime();
  };
  // Hub/section pages (already-clustered legacy members) must never supply the
  // label or dominate the keyword set — their generic chrome titles ("Latest
  // News & Updates | BBC News") mislabel real stories and their headline soup
  // attracts unrelated docs. Fall back to the full set only when a cluster is
  // ENTIRELY hub pages (nothing better to describe it with).
  const storyDocs = scoring.filter((d) => !isHubPage(d));
  const labelPool = storyDocs.length > 0 ? storyDocs : scoring;
  const titledDocs = labelPool.filter((d) => bestTitle(d).length > 0);
  const labelDoc = (titledDocs.length > 0 ? [...titledDocs] : [...labelPool]).sort(
    tierRecencySort,
  )[0];
  const label = (labelDoc ? bestTitle(labelDoc) : null) || cluster.label;

  const keywords = deriveKeywords((storyDocs.length > 0 ? storyDocs : scoring).map(docText));
  const status: StoryCluster["status"] = freshUntil && freshUntil < now ? "dormant" : "active";

  await exec
    .update(storyClustersTable)
    .set({
      label,
      keywords: keywords.length ? keywords : cluster.keywords,
      score,
      scoreBreakdown: breakdown as unknown as Record<string, number>,
      sourceCount: scoring.length,
      familyCount: families.size,
      domainCount: domains.size,
      topAuthorityTier: topTier,
      markerCount,
      firstSeenAt: oldest,
      lastSeenAt: newest ?? cluster.lastSeenAt,
      freshUntil,
      status,
      updatedAt: new Date(),
    })
    .where(eq(storyClustersTable.id, clusterId));
}

/**
 * Public entry point to recompute a single cluster's aggregates + score (loads
 * settings, uses the pool). Used after trend markers attach/detach so the
 * velocity component and markerCount stay current outside a clustering pass.
 * Never throws — logs and returns on error.
 */
export async function recomputeStoryCluster(
  clusterId: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    const settings = await getSiteSettings();
    await recomputeCluster(clusterId, now, settings, db);
  } catch (err) {
    logger.warn({ err, clusterId }, "storyClusters: recomputeStoryCluster failed");
  }
}

/**
 * Find the best-matching ACTIVE story cluster for a piece of text within a beat
 * by the same lexical token overlap used for source clustering. Returns the
 * cluster id when overlap clears JOIN_THRESHOLD, else null. Used to attach trend
 * markers to the evidence cluster they most plausibly belong to (velocity signal)
 * WITHOUT ever creating a cluster from a marker alone.
 */
export async function findMatchingClusterForText(
  beatSlug: string,
  text: string,
): Promise<string | null> {
  const textTokens = tokens(text);
  if (textTokens.size === 0) return null;
  const rows = await db
    .select({ id: storyClustersTable.id, keywords: storyClustersTable.keywords })
    .from(storyClustersTable)
    .where(
      and(eq(storyClustersTable.beatSlug, beatSlug), eq(storyClustersTable.status, "active")),
    );
  let bestId: string | null = null;
  let bestScore = 0;
  for (const c of rows) {
    const s = jaccard(textTokens, new Set(c.keywords));
    if (s > bestScore) {
      bestScore = s;
      bestId = c.id;
    }
  }
  return bestId && bestScore >= JOIN_THRESHOLD ? bestId : null;
}

/**
 * Does `text` belong in the cluster with these `keywords`? Uses the exact same
 * lexical gate (dedupe tokens + jaccard vs `JOIN_THRESHOLD`) the async
 * clustering pass applies, so callers that attach docs to a cluster OUTSIDE the
 * normal clustering pass (e.g. admin source-boost) can enforce the same
 * relevance bar and never force an off-topic source onto a cluster.
 */
export function textMatchesClusterKeywords(keywords: string[], text: string): boolean {
  const textTokens = tokens(text);
  if (textTokens.size === 0 || keywords.length === 0) return false;
  return jaccard(textTokens, new Set(keywords)) >= JOIN_THRESHOLD;
}

/**
 * Sweep cluster lifecycle: (a) mark active clusters whose freshness window has
 * elapsed as `dormant`; (b) reopen covered / do-not-cover clusters whose
 * `coverage_resurface_after` has passed (null = permanent, never reopened).
 * Idempotent; returns the counts changed.
 */
export async function sweepClusterLifecycle(
  now: Date = new Date(),
): Promise<{ dormant: number; reopened: number }> {
  const dormant = await db
    .update(storyClustersTable)
    .set({ status: "dormant", updatedAt: new Date() })
    .where(
      and(
        eq(storyClustersTable.status, "active"),
        sql`${storyClustersTable.freshUntil} IS NOT NULL AND ${storyClustersTable.freshUntil} < ${now}`,
      ),
    )
    .returning({ id: storyClustersTable.id });

  const reopened = await db
    .update(storyClustersTable)
    .set({
      coverageStatus: "open",
      coverageReason: null,
      coverageResurfaceAfter: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        ne(storyClustersTable.coverageStatus, "open"),
        sql`${storyClustersTable.coverageResurfaceAfter} IS NOT NULL AND ${storyClustersTable.coverageResurfaceAfter} < ${now}`,
      ),
    )
    .returning({ id: storyClustersTable.id });

  return { dormant: dormant.length, reopened: reopened.length };
}

export interface ClusterSourceSummary {
  id: string;
  url: string;
  domain: string;
  title: string | null;
  authorityTier: string;
  lifecycleStatus: string;
  publishedAt: string | null;
  sourceFamilyId: string | null;
}

export interface StoryClusterWithSources extends StoryCluster {
  sources: ClusterSourceSummary[];
}

export interface ListClustersFilter {
  beatSlug?: string;
  status?: StoryCluster["status"];
  coverageStatus?: ClusterCoverageStatus;
  // Suppress covered / do-not-cover clusters (coverage memory). Defaults to
  // true when no explicit `coverageStatus` is given, so the ranking view never
  // resurfaces clusters an editor has already dispositioned. Pass `false` to
  // include every coverage status.
  excludeCovered?: boolean;
  includeSources?: boolean;
  limit?: number;
}

function toSourceSummary(d: SourceDocument): ClusterSourceSummary {
  return {
    id: d.id,
    url: d.url,
    domain: d.domain,
    title: govDocDisplayTitle(d) ?? d.title,
    authorityTier: d.authorityTier,
    lifecycleStatus: d.lifecycleStatus,
    publishedAt: (d.publishedAt ?? d.fetchedAt)?.toISOString() ?? null,
    sourceFamilyId: d.sourceFamilyId,
  };
}

/** List clusters ranked by score (desc), optionally with their member sources. */
export async function listStoryClusters(
  filter: ListClustersFilter = {},
): Promise<StoryClusterWithSources[]> {
  const where = [];
  if (filter.beatSlug) where.push(eq(storyClustersTable.beatSlug, filter.beatSlug));
  if (filter.status) where.push(eq(storyClustersTable.status, filter.status));
  if (filter.coverageStatus) {
    // Explicit coverage filter always wins (used to review covered/do-not-cover).
    where.push(eq(storyClustersTable.coverageStatus, filter.coverageStatus));
  } else if (filter.excludeCovered !== false) {
    // Default: coverage memory suppresses dispositioned clusters from ranking.
    where.push(eq(storyClustersTable.coverageStatus, "open"));
  }

  const rows = await db
    .select()
    .from(storyClustersTable)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(storyClustersTable.score), desc(storyClustersTable.lastSeenAt))
    .limit(Math.min(Math.max(filter.limit ?? 100, 1), 500));

  if (rows.length === 0) return [];
  if (filter.includeSources === false) {
    return rows.map((c) => ({ ...c, sources: [] }));
  }

  const ids = rows.map((c) => c.id);
  const sources = await db
    .select()
    .from(sourceDocumentsTable)
    .where(inArray(sourceDocumentsTable.clusterId, ids));
  const byCluster = new Map<string, ClusterSourceSummary[]>();
  for (const s of sources) {
    if (!s.clusterId) continue;
    const list = byCluster.get(s.clusterId) ?? [];
    list.push(toSourceSummary(s));
    byCluster.set(s.clusterId, list);
  }
  return rows.map((c) => ({ ...c, sources: byCluster.get(c.id) ?? [] }));
}

/** Fetch a single cluster with its member sources, or null. */
export async function getStoryCluster(id: string): Promise<StoryClusterWithSources | null> {
  const [cluster] = await db
    .select()
    .from(storyClustersTable)
    .where(eq(storyClustersTable.id, id))
    .limit(1);
  if (!cluster) return null;
  const sources = await db
    .select()
    .from(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.clusterId, id))
    .orderBy(desc(sourceDocumentsTable.publishedAt));
  return { ...cluster, sources: sources.map(toSourceSummary) };
}

export class StoryClusterError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "StoryClusterError";
  }
}

// --- Semantic cluster reconciler (Task #330) ----------------------------
// Borderline Jaccard window: below LOW the clusters are already clearly
// distinct; above HIGH they would merge in the next lexical pass. LLM only
// judges the ambiguous middle.
const RECONCILE_JACCARD_LOW = 0.08;
const RECONCILE_JACCARD_HIGH = 0.18;

/** Stable fingerprint of a cluster's keyword set (sorted join). */
function keywordHash(keywords: string[]): string {
  return [...keywords].sort().join("|");
}

export interface ReconcilerResult {
  judged: number;
  merged: number;
  distinct: number;
  uncertain: number;
  skipped: number;
}

/**
 * Second-stage semantic reconciler. After each lexical clustering tick, loads
 * all active non-archived clusters, identifies same-beat pairs with Jaccard
 * similarity in the borderline window (0.08–0.18), and asks an LLM to decide:
 *
 *   same_story  → smaller cluster merged into the larger; archived
 *   distinct    → verdict cached with keyword hashes; re-judged only if keywords change
 *   uncertain   → verdict cached with keyword hashes; re-judged only if keywords change
 *
 * Gated by `semanticClusterReconcileEnabled` in site settings. Safe to call
 * every cron tick — the verdict cache ensures pairs are not re-judged for free.
 *
 * Multi-merge safety: clusters archived during the current run are tracked in
 * `mergedDuringRun` and skipped from all subsequent pair evaluations so an
 * already-archived cluster can never absorb further members.
 */
export async function runSemanticClusterReconciler(
  _now: Date = new Date(),
  opts: { forceRun?: boolean; onProgress?: (partial: ReconcilerResult) => Promise<void> } = {},
): Promise<ReconcilerResult> {
  const result: ReconcilerResult = {
    judged: 0,
    merged: 0,
    distinct: 0,
    uncertain: 0,
    skipped: 0,
  };

  const settings = await getSiteSettings();
  // Normal cron path: respect the site setting. Re-sort path (forceRun=true):
  // bypass it — the re-sort is an explicit full-reprocess and should run all
  // stages so the caller gets a fully-converged clustering, not a half-finished
  // one gated on a feature flag the operator may have left at default=false.
  if (!settings.semanticClusterReconcileEnabled && !opts.forceRun) return result;

  // Guard against the AI function being disabled independently of the site
  // setting. If we allowed the loop to run in disabled state, llmClusterSameStory
  // would return verdict="uncertain" for every borderline pair, and those verdicts
  // would be cached by keyword hash — causing them to be permanently skipped once
  // the function is re-enabled (unless keywords change). Exit early instead.
  const judgeEnabled = await isAiFunctionEnabled("cluster_reconcile_judge");
  if (!judgeEnabled) return result;

  // Load all active, non-archived clusters.
  const clusters = await db
    .select({
      id: storyClustersTable.id,
      beatSlug: storyClustersTable.beatSlug,
      beat: storyClustersTable.beat,
      label: storyClustersTable.label,
      keywords: storyClustersTable.keywords,
      sourceCount: storyClustersTable.sourceCount,
    })
    .from(storyClustersTable)
    .where(and(eq(storyClustersTable.status, "active"), isNull(storyClustersTable.archivedAt)));

  const clusterIds = clusters.map((c) => c.id);
  if (clusterIds.length < 2) return result;

  // Read the configurable borderline window from settings.
  const jaccardLow = settings.reconcileJaccardLow;
  const jaccardHigh = settings.reconcileJaccardHigh;

  // Batch-fetch top-5 member titles + lead excerpts per cluster for richer LLM context.
  const memberRows =
    clusterIds.length > 0
      ? await db
          .select({
            clusterId: sourceDocumentsTable.clusterId,
            title: sourceDocumentsTable.title,
            excerpt: sourceDocumentsTable.excerpt,
          })
          .from(sourceDocumentsTable)
          .where(inArray(sourceDocumentsTable.clusterId, clusterIds))
          .orderBy(desc(sourceDocumentsTable.publishedAt))
          .limit(clusterIds.length * 5)
      : [];

  const memberTitlesByCluster = new Map<string, string[]>();
  const memberExcerptsByCluster = new Map<string, string[]>();
  for (const row of memberRows) {
    if (!row.clusterId) continue;
    if (row.title) {
      const list = memberTitlesByCluster.get(row.clusterId) ?? [];
      if (list.length < 5) {
        list.push(row.title);
        memberTitlesByCluster.set(row.clusterId, list);
      }
    }
    if (row.excerpt) {
      const list = memberExcerptsByCluster.get(row.clusterId) ?? [];
      if (list.length < 3) {
        list.push(row.excerpt);
        memberExcerptsByCluster.set(row.clusterId, list);
      }
    }
  }

  // Group by beat.
  const byBeat = new Map<string, Array<(typeof clusters)[number] & { keywords: string[] }>>();
  for (const c of clusters) {
    const kws = (c.keywords ?? []) as string[];
    const list = byBeat.get(c.beatSlug) ?? [];
    list.push({ ...c, keywords: kws });
    byBeat.set(c.beatSlug, list);
  }

  // Load all cached verdict rows for quick lookup.
  const verdictRows = await db.select().from(clusterPairVerdictsTable);
  const verdictMap = new Map<string, (typeof verdictRows)[number]>();
  for (const v of verdictRows) {
    verdictMap.set(`${v.clusterAId}::${v.clusterBId}`, v);
  }

  // Mutable in-memory cluster state so multi-merge decisions within the same
  // tick use current (post-merge) sourceCount and keywords, not initial values.
  const clusterState = new Map<string, { sourceCount: number; keywords: string[] }>();
  for (const c of clusters) {
    clusterState.set(c.id, {
      sourceCount: c.sourceCount ?? 0,
      keywords: (c.keywords ?? []) as string[],
    });
  }

  // Track clusters archived during THIS run so we never route more members
  // to an already-merged (archived) cluster in subsequent pair evaluations.
  const mergedDuringRun = new Set<string>();

  for (const [, beatClusters] of byBeat) {
    if (beatClusters.length < 2) continue;

    for (let i = 0; i < beatClusters.length; i++) {
      for (let j = i + 1; j < beatClusters.length; j++) {
        const cA = beatClusters[i]!;
        const cB = beatClusters[j]!;

        // Skip either cluster if it was archived earlier in this run.
        if (mergedDuringRun.has(cA.id) || mergedDuringRun.has(cB.id)) {
          result.skipped++;
          continue;
        }

        // Use in-memory state for Jaccard + size comparison so multi-merge
        // direction is always based on current (post-merge) counts and keywords.
        const stateA = clusterState.get(cA.id)!;
        const stateB = clusterState.get(cB.id)!;
        if (stateA.keywords.length === 0 || stateB.keywords.length === 0) continue;

        // Jaccard over current in-memory keyword token sets.
        const setA = new Set<string>(stateA.keywords.flatMap((k) => [...tokens(k)]));
        const setB = new Set<string>(stateB.keywords.flatMap((k) => [...tokens(k)]));
        const score = jaccard(setA, setB);
        // Only evaluate borderline window pairs; skip anything outside it.
        if (score < jaccardLow || score > jaccardHigh) continue;

        // Canonical pair ordering (smaller UUID first) keeps the cache key
        // stable regardless of which cluster appears as i vs j.
        const [idA, idB] = cA.id < cB.id ? [cA.id, cB.id] : [cB.id, cA.id];
        const clA = cA.id < cB.id ? cA : cB;
        const clB = cA.id < cB.id ? cB : cA;
        const stateForA = cA.id < cB.id ? stateA : stateB;
        const stateForB = cA.id < cB.id ? stateB : stateA;
        const hashA = keywordHash(stateForA.keywords);
        const hashB = keywordHash(stateForB.keywords);
        const pairKey = `${idA}::${idB}`;

        // Skip if the cached verdict was made with the same keyword hashes.
        // This covers distinct AND uncertain — re-judged only when a cluster's
        // keyword set changes (a new member arrived).
        const cached = verdictMap.get(pairKey);
        if (cached && cached.keywordHashA === hashA && cached.keywordHashB === hashB) {
          result.skipped++;
          continue;
        }

        // Fire the onProgress hook before EVERY LLM call so the resort job can
        // heartbeat live counts and check for cooperative cancellation mid-pair.
        // Each LLM call takes seconds (up to 30s timeout × retry), so a sparser
        // cadence risked heartbeat gaps beyond the stale-job TTL — the UI (and
        // the lock takeover logic) would see the run as dead while it was still
        // working. The hook may throw (ResortCancelled) which propagates.
        if (opts.onProgress) {
          await opts.onProgress(result);
        }

        const judgment = await llmClusterSameStory(
            {
              id: idA,
              label: clA.label,
              keywords: stateForA.keywords,
              beat: clA.beat,
              memberTitles: memberTitlesByCluster.get(clA.id),
              memberExcerpts: memberExcerptsByCluster.get(clA.id),
            },
            {
              id: idB,
              label: clB.label,
              keywords: stateForB.keywords,
              beat: clB.beat,
              memberTitles: memberTitlesByCluster.get(clB.id),
              memberExcerpts: memberExcerptsByCluster.get(clB.id),
            },
          );
        result.judged++;

        if (judgment.verdict === "same_story") {
          // Merge: smaller cluster (fewer sources) → larger cluster.
          // sourceCount is read from the mutable in-memory state so chained
          // merges within the same tick always pick the correct direction.
          const smaller = stateForA.sourceCount <= stateForB.sourceCount ? clA : clB;
          const smallerState = smaller === clA ? stateForA : stateForB;
          const larger = smaller === clA ? clB : clA;
          const largerState = smaller === clA ? stateForB : stateForA;

          // Re-assign all members from the smaller cluster to the larger.
          const reassigned = await db
            .update(sourceDocumentsTable)
            .set({ clusterId: larger.id, clusteredAt: new Date() })
            .where(eq(sourceDocumentsTable.clusterId, smaller.id))
            .returning({ id: sourceDocumentsTable.id });

          // Merge keywords: larger's list first, then any new from smaller, capped.
          const mergedKeywords = [
            ...largerState.keywords,
            ...smallerState.keywords.filter((k) => !largerState.keywords.includes(k)),
          ].slice(0, MAX_KEYWORDS);

          await db
            .update(storyClustersTable)
            .set({ keywords: mergedKeywords, updatedAt: new Date() })
            .where(eq(storyClustersTable.id, larger.id));

          // Archive the smaller cluster so it is excluded from future passes.
          await db
            .update(storyClustersTable)
            .set({ archivedAt: new Date(), status: "dormant", updatedAt: new Date() })
            .where(eq(storyClustersTable.id, smaller.id));

          // Mark as archived in this run so later pairs skip it.
          mergedDuringRun.add(smaller.id);

          // Update in-memory state of the survivor so subsequent pair decisions
          // within this tick use the correct post-merge sourceCount and keywords.
          clusterState.set(larger.id, {
            sourceCount: largerState.sourceCount + smallerState.sourceCount,
            keywords: mergedKeywords,
          });

          // Recompute the surviving cluster's DB aggregates + score so sourceCount,
          // familyCount, domainCount, freshness, and score are immediately correct.
          await recomputeCluster(larger.id, _now, settings);

          // Write the audit row.
          await db.insert(clusterMergesTable).values({
            mergedFromClusterId: smaller.id,
            mergedFromLabel: smaller.label,
            mergedIntoClusterId: larger.id,
            mergedIntoLabel: larger.label,
            beatSlug: larger.beatSlug,
            beat: larger.beat,
            rationale: judgment.rationale,
            membersReassigned: reassigned.length,
            judgedAt: new Date(),
          });

          // Cache the verdict so the pair is never re-evaluated.
          await db
            .insert(clusterPairVerdictsTable)
            .values({
              clusterAId: idA,
              clusterBId: idB,
              verdict: "same_story",
              rationale: judgment.rationale,
              keywordHashA: hashA,
              keywordHashB: hashB,
            })
            .onConflictDoUpdate({
              target: [clusterPairVerdictsTable.clusterAId, clusterPairVerdictsTable.clusterBId],
              set: {
                verdict: "same_story",
                rationale: judgment.rationale,
                keywordHashA: hashA,
                keywordHashB: hashB,
                judgedAt: new Date(),
              },
            });

          result.merged++;
          logger.info(
            {
              from: smaller.id,
              fromLabel: smaller.label,
              into: larger.id,
              intoLabel: larger.label,
              beat: larger.beatSlug,
              reassigned: reassigned.length,
              jaccardScore: score,
            },
            "cluster reconciler: merged",
          );
        } else {
          // distinct or uncertain — both cached by keyword hash.
          // Re-evaluated only when a cluster's keyword set changes.
          await db
            .insert(clusterPairVerdictsTable)
            .values({
              clusterAId: idA,
              clusterBId: idB,
              verdict: judgment.verdict,
              rationale: judgment.rationale,
              keywordHashA: hashA,
              keywordHashB: hashB,
            })
            .onConflictDoUpdate({
              target: [clusterPairVerdictsTable.clusterAId, clusterPairVerdictsTable.clusterBId],
              set: {
                verdict: judgment.verdict,
                rationale: judgment.rationale,
                keywordHashA: hashA,
                keywordHashB: hashB,
                judgedAt: new Date(),
              },
            });

          if (judgment.verdict === "distinct") result.distinct++;
          else result.uncertain++;
        }
      }
    }
  }

  return result;
}

/** Return the N most-recent cluster merge audit rows, newest first. */
export async function listClusterMerges(limit = 20): Promise<ClusterMergeRow[]> {
  return db
    .select()
    .from(clusterMergesTable)
    .orderBy(desc(clusterMergesTable.createdAt))
    .limit(Math.min(limit, 100));
}

/** Total number of cluster merges recorded in the audit log. */
export async function getClusterMergeStats(): Promise<{ totalMerges: number }> {
  const [row] = await db.select({ n: sql<string>`count(*)` }).from(clusterMergesTable);
  return { totalMerges: Number(row?.n ?? 0) };
}

export interface SetCoverageInput {
  status: ClusterCoverageStatus;
  reason?: string | null;
  // Days until the cluster reopens. Omit/null = permanent (never resurface).
  resurfaceAfterDays?: number | null;
  coveredArticleId?: string | null;
}

/**
 * Record coverage memory on a cluster: mark it covered (with the covering
 * article) or do-not-cover (with a reason), optionally with a resurface window
 * after which the sweep reopens it. Setting status back to `open` clears memory.
 */
export async function setClusterCoverage(
  id: string,
  input: SetCoverageInput,
  now: Date = new Date(),
): Promise<StoryClusterWithSources> {
  const [cluster] = await db
    .select({ id: storyClustersTable.id })
    .from(storyClustersTable)
    .where(eq(storyClustersTable.id, id))
    .limit(1);
  if (!cluster) throw new StoryClusterError(404, "Cluster not found");

  const resurfaceAfter =
    input.status === "open" || input.resurfaceAfterDays == null || input.resurfaceAfterDays <= 0
      ? null
      : new Date(now.getTime() + input.resurfaceAfterDays * 24 * 60 * 60 * 1000);

  await db
    .update(storyClustersTable)
    .set({
      coverageStatus: input.status,
      coverageReason: input.status === "open" ? null : (input.reason ?? null),
      coverageResurfaceAfter: resurfaceAfter,
      coveredArticleId:
        input.status === "covered" ? (input.coveredArticleId ?? null) : null,
      updatedAt: new Date(),
    })
    .where(eq(storyClustersTable.id, id));

  const updated = await getStoryCluster(id);
  if (!updated) throw new StoryClusterError(404, "Cluster not found");
  return updated;
}

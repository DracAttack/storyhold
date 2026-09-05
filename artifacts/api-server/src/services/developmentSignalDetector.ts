/**
 * Development Signal Detector — Task #348 Story Watch.
 *
 * Scans watched story clusters for meaningful new source-vault developments.
 * Two fire tracks, both deterministic (no AI, no paid calls):
 *
 *   Track A — Corroboration fire: ≥3 ACTIVE trusted-tier (primary/firsthand/wire)
 *              source documents added to the cluster SINCE the last published
 *              article in its story chain. Multiple independent voices corroborate
 *              a development — that's a signal worth an update.
 *
 *   Track B — Authority override: ≥1 NEW primary or wire source whose title
 *              contains terminal-event vocabulary (verdict, sentenced, ruling …).
 *              A single authoritative source confirming a decisive event is enough.
 *
 * Retraction integration: documents whose lifecycle_status is 'retracted' or
 * 'unavailable' are EXCLUDED from both tracks. They cannot trigger an update.
 * If the cluster's story chain has any article with an uncleared retraction
 * impact (retraction_impact_at IS NOT NULL AND retraction_impact_cleared_at IS
 * NULL), the signal fires with chainHasRetractionImpact=true so the depth scorer
 * and generator can apply conservative treatment.
 *
 * Cooldown: after a signal fires for a cluster, the cluster is suppressed for
 * 2 hours (tracked via story_update_signals.last_signal_at). This prevents
 * simultaneous vault ingests from spawning duplicate draft jobs before any
 * finish. The novelty gate (LLM topic-overlap check) in the generator is the
 * real re-fire protection; this is just a practical race guard.
 */

import {
  db,
  storyClustersTable,
  sourceDocumentsTable,
  articlesTable,
  storyUpdateSignalsTable,
} from "@workspace/db";
import { eq, and, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { resolveModel } from "./aiSettings";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Trusted authority tiers that can trigger a Track A corroboration signal.
 *  "reported" is included (BBC/NPR/NYT-tier coverage counts as corroboration);
 *  Track B authority still requires primary/wire only. */
const TRUSTED_TIERS = new Set(["primary", "firsthand", "wire", "reported"]);

/** Only primary/wire can trigger Track B (single high-authority source). */
const TRACK_B_TIERS = new Set(["primary", "wire"]);

/**
 * After this many milliseconds an exhausted signal is eligible for a
 * time-based auto-reset (retryCount → 0, status → pending) even when no new
 * triggering doc IDs have arrived.  This prevents a transient generation
 * failure from permanently suppressing a cluster — the scanner will retry
 * once per day until it succeeds or new docs push it back through the full
 * novelty gate.
 */
const EXHAUSTED_RESET_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Active lifecycles — retracted/unavailable docs cannot trigger signals. */
const ACTIVE_LIFECYCLES = new Set(["active", "stale"]);

// ---------------------------------------------------------------------------
// Novelty gate
// ---------------------------------------------------------------------------

/** Below this Jaccard overlap the new docs are definitively novel → fire immediately. */
const NOVELTY_AMBIGUOUS_THRESHOLD = 0.20;
/** At or above this Jaccard overlap the new docs are definitively redundant → suppress. */
const NOVELTY_HIGH_THRESHOLD = 0.55;

/** Simple term bag (lowercased words ≥4 chars) for Jaccard overlap computation. */
function termBag(texts: (string | null | undefined)[]): Set<string> {
  const bag = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const w of t.toLowerCase().split(/\W+/)) {
      if (w.length >= 4) bag.add(w);
    }
  }
  return bag;
}

/** Jaccard similarity between two term bags. Returns 0 when both are empty. */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) { if (b.has(t)) intersection++; }
  return intersection / (a.size + b.size - intersection);
}

/**
 * Haiku binary adjudication for the ambiguous middle band.
 * Returns true when the new docs appear to bring genuinely new information.
 * Fail-open: if the model call fails or returns an unclear answer, defaults to true (fire).
 */
async function adjudicateNovelty(
  newTitles: (string | null | undefined)[],
  oldTitles: (string | null | undefined)[],
  beatSlug: string,
): Promise<boolean> {
  const model = await resolveModel("story_update");
  if (!model) return true; // No model configured → fail open.
  const systemPrompt =
    "You are a news editor deciding whether new source documents contain genuinely new information for an ongoing story. Reply with a single word: YES if the new documents contain meaningful new facts or developments NOT already covered by the existing sources, NO if they merely repeat what is already known.";
  const userPrompt =
    `Beat: ${beatSlug}\n\nExisting story coverage (source titles):\n${oldTitles.filter(Boolean).slice(0, 8).map((t, i) => `${i + 1}. ${t}`).join("\n")}\n\nNew source documents just ingested:\n${newTitles.filter(Boolean).slice(0, 5).map((t, i) => `${i + 1}. ${t}`).join("\n")}\n\nAre the new documents genuinely new (YES/NO)?`;
  try {
    const msg = await anthropic.messages.create({
      model,
      max_tokens: 10,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const reply = msg.content[0]?.type === "text" ? msg.content[0].text.trim().toUpperCase() : "";
    return !reply.startsWith("NO");
  } catch (err) {
    logger.warn({ err }, "developmentSignalDetector: novelty adjudication failed; defaulting to fire");
    return true;
  }
}

/** Terminal-event vocabulary for Track B headline matching (always-on clusters
 *  that are NOT explicitly watched require a decisive keyword). */
const TERMINAL_VOCAB = [
  "verdict", "sentenced", "ruling", "convicted", "acquitted", "dismissed",
  "final", "over", "ends", "ended", "killed", "dies", "died", "arrested",
  "charged", "indicted", "settlement", "settled", "ceasefire", "signed",
  "approved", "passed", "banned", "resolved", "concluded",
];

/** Minimum corroborating trusted sources for Track A (unwatched covered clusters). */
const TRACK_A_MIN_SOURCES = 3;

/** Lower Track A threshold for explicitly watched clusters. */
const TRACK_A_WATCHED_MIN_SOURCES = 2;

/** Minimum distinct root-domain families for Track A corroboration (unwatched clusters).
 *  Requires 3 independent publishers so a single-outlet story doesn't trigger updates. */
const TRACK_A_UNWATCHED_MIN_DISTINCT_DOMAINS = 3;

/** Minimum distinct root-domain families for Track A on explicitly-watched clusters.
 *  Two independent publishers suffice because editorial intent is already established. */
const TRACK_A_WATCHED_MIN_DISTINCT_DOMAINS = 2;

/** Signal cooldown in milliseconds (2 hours). */
const SIGNAL_COOLDOWN_MS = 2 * 60 * 60 * 1000;

/** Track A new-docs window for UNWATCHED covered clusters (12 h). */
const TRACK_A_UNWATCHED_WINDOW_MS = 12 * 60 * 60 * 1000;

/** Track A new-docs window for WATCHED clusters (18 h — editorial intent
 *  broadens the look-back so fewer signals slip through overnight). */
const TRACK_A_WATCHED_WINDOW_MS = 18 * 60 * 60 * 1000;

/** Track B new-docs window: only count docs ingested in the last 6 hours. */
const TRACK_B_WINDOW_MS = 6 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Flatten an ArticleBlock[] JSONB value into a single plain-text string for
 * Jaccard overlap computation. Only paragraph blocks carry substantive prose;
 * image/header/etc. blocks are skipped.
 */
function extractBlockText(body: unknown): string {
  if (!Array.isArray(body)) return "";
  return (body as { type?: string; content?: string }[])
    .filter((b) => b.type === "paragraph" || b.type === "heading")
    .map((b) => b.content ?? "")
    .join(" ");
}

/** Extract a normalised root domain (hostname without www.) from a URL string. */
function rootDomain(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SignalTrack = "corroboration" | "authority";

export interface DevelopmentSignal {
  clusterId: string;
  clusterScore: number;
  beatSlug: string;
  trackType: SignalTrack;
  triggeringDocIds: string[];
  /** The most recent published article in this cluster's chain. */
  latestChainArticleId: string | null;
  /** True if any chain article has an uncleared retraction impact. */
  chainHasRetractionImpact: boolean;
  /** Number of prior published articles in the chain (for depth scoring). */
  priorChainDepth: number;
  /** Count of active trusted-tier vault sources for this cluster (evidence ceiling). */
  activeTrustedSourceCount: number;
}

export interface SignalScanResult {
  scanned: number;
  fired: number;
  suppressed: number;
  signals: DevelopmentSignal[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasTerminalVocab(title: string | null | undefined): boolean {
  if (!title) return false;
  const lower = title.toLowerCase();
  return TERMINAL_VOCAB.some((w) => lower.includes(w));
}

// ---------------------------------------------------------------------------
// Main scan
// ---------------------------------------------------------------------------

/**
 * Scan all covered clusters for new developments. "Covered" means the cluster
 * already has a published article (coveredArticleId IS NOT NULL).
 *
 * Two tiers:
 *   - Watched clusters (watched=true): lower Track A threshold (≥2 trusted sources).
 *   - Unwatch covered clusters: standard Track A threshold (≥3 trusted sources).
 *
 * Track B (single decisive primary/wire source) applies to both tiers equally.
 *
 * Idempotent — safe to call every cron tick. Already-fired clusters within
 * the cooldown window are skipped without re-raising.
 */
export async function scanWatchedClustersForSignals(
  now: Date = new Date(),
): Promise<SignalScanResult> {
  // Fetch ALL covered active clusters — not just explicitly-watched ones.
  // A covered cluster has coveredArticleId set (its story was already written),
  // so further developments are meaningful update candidates for all of them.
  // Watched clusters get a lower threshold; unwatch covered clusters need more
  // corroboration.
  const covered = await db
    .select({
      id: storyClustersTable.id,
      score: storyClustersTable.score,
      beatSlug: storyClustersTable.beatSlug,
      watched: storyClustersTable.watched,
    })
    .from(storyClustersTable)
    .where(
      and(
        isNotNull(storyClustersTable.coveredArticleId),
        eq(storyClustersTable.status, "active"),
      ),
    );

  if (covered.length === 0) return { scanned: 0, fired: 0, suppressed: 0, signals: [] };

  // Alias for the rest of the function (was `watched`, now all covered).
  const watched = covered;

  const clusterIds = watched.map((c) => c.id);

  // Fetch existing signal rows for cooldown check and consumed-suppression.
  const existingSignals = await db
    .select({
      clusterId: storyUpdateSignalsTable.clusterId,
      lastSignalAt: storyUpdateSignalsTable.lastSignalAt,
      status: storyUpdateSignalsTable.status,
      triggeringDocIds: storyUpdateSignalsTable.triggeringDocIds,
    })
    .from(storyUpdateSignalsTable)
    .where(inArray(storyUpdateSignalsTable.clusterId, clusterIds));

  const lastSignalByCluster = new Map(
    existingSignals.map((s) => [s.clusterId, s.lastSignalAt]),
  );
  // Full existing-row map for consumed-suppression logic.
  const existingRowByCluster = new Map(
    existingSignals.map((s) => [s.clusterId, s]),
  );

  // For each cluster: find the latest published chain article (if any).
  // We use the latest publishedAt across the chain to define "new since last update".
  const chainArticles = await db
    .select({
      clusterId: articlesTable.clusterId,
      id: articlesTable.id,
      title: articlesTable.title,
      body: articlesTable.body,
      publishedAt: articlesTable.publishedAt,
      chainPosition: articlesTable.chainPosition,
      retractionImpactAt: articlesTable.retractionImpactAt,
      retractionImpactClearedAt: articlesTable.retractionImpactClearedAt,
    })
    .from(articlesTable)
    .where(
      and(
        inArray(articlesTable.clusterId, clusterIds),
        eq(articlesTable.status, "published"),
        isNull(articlesTable.quarantinedAt),
      ),
    );

  // Group by clusterId.
  const chainByCluster = new Map<string, typeof chainArticles>();
  for (const a of chainArticles) {
    if (!a.clusterId) continue;
    const existing = chainByCluster.get(a.clusterId) ?? [];
    existing.push(a);
    chainByCluster.set(a.clusterId, existing);
  }

  // Fetch all active/stale source docs for these clusters (no AI cost).
  const allDocs = await db
    .select({
      id: sourceDocumentsTable.id,
      clusterId: sourceDocumentsTable.clusterId,
      authorityTier: sourceDocumentsTable.authorityTier,
      lifecycleStatus: sourceDocumentsTable.lifecycleStatus,
      title: sourceDocumentsTable.title,
      createdAt: sourceDocumentsTable.createdAt,
      url: sourceDocumentsTable.url,
    })
    .from(sourceDocumentsTable)
    .where(
      and(
        isNotNull(sourceDocumentsTable.clusterId),
        inArray(sourceDocumentsTable.clusterId, clusterIds),
        // Only fetched/extracted/embedded docs — not low_quality or failed.
        inArray(sourceDocumentsTable.status, ["fetched", "extracted", "embedded"]),
      ),
    );

  // Group docs by cluster.
  const docsByCluster = new Map<string, typeof allDocs>();
  for (const doc of allDocs) {
    if (!doc.clusterId) continue;
    const list = docsByCluster.get(doc.clusterId) ?? [];
    list.push(doc);
    docsByCluster.set(doc.clusterId, list);
  }

  const signals: DevelopmentSignal[] = [];
  let suppressed = 0;

  for (const cluster of watched) {
    // Cooldown check.
    const lastSignal = lastSignalByCluster.get(cluster.id);
    if (lastSignal) {
      const age = now.getTime() - new Date(lastSignal).getTime();
      if (age < SIGNAL_COOLDOWN_MS) {
        suppressed++;
        continue;
      }
    }

    const chain = (chainByCluster.get(cluster.id) ?? []).sort(
      (a, b) =>
        (b.chainPosition ?? 0) - (a.chainPosition ?? 0) ||
        new Date(b.publishedAt ?? 0).getTime() - new Date(a.publishedAt ?? 0).getTime(),
    );

    const latestArticle = chain[0] ?? null;
    const latestPublishedAt = latestArticle?.publishedAt ? new Date(latestArticle.publishedAt) : null;

    const chainHasRetractionImpact = chain.some(
      (a) => a.retractionImpactAt && !a.retractionImpactClearedAt,
    );
    const priorChainDepth = chain.length;

    const clusterDocs = docsByCluster.get(cluster.id) ?? [];

    // Only consider docs that are NOT retracted/unavailable.
    const activeDocs = clusterDocs.filter(
      (d) => d.lifecycleStatus === null || ACTIVE_LIFECYCLES.has(d.lifecycleStatus ?? ""),
    );

    // "New" docs: created AFTER the last published chain article.
    // If there's no chain article yet, ALL docs in the cluster count.
    const newDocs = latestPublishedAt
      ? activeDocs.filter((d) => new Date(d.createdAt).getTime() > latestPublishedAt.getTime())
      : activeDocs;

    // Trusted-tier new docs (primary/firsthand/wire).
    const newTrustedDocs = newDocs.filter(
      (d) => d.authorityTier && TRUSTED_TIERS.has(d.authorityTier),
    );

    // Active trusted docs total (for evidence ceiling in depth score).
    const activeTrustedSourceCount = activeDocs.filter(
      (d) => d.authorityTier && TRUSTED_TIERS.has(d.authorityTier),
    ).length;

    // Track B check: single decisive primary/wire source within the 6-hour window.
    // For watched clusters editorial intent is established, so a high-authority doc
    // fires Track B without needing terminal-event vocabulary.
    // For unwatched always-on clusters the headline must carry decisive vocabulary.
    const trackBWindowCutoff = now.getTime() - TRACK_B_WINDOW_MS;
    const newHighAuthorityDocs = newTrustedDocs.filter(
      (d) =>
        d.authorityTier &&
        TRACK_B_TIERS.has(d.authorityTier) &&
        new Date(d.createdAt).getTime() >= trackBWindowCutoff,
    );
    const trackBDocs = cluster.watched
      ? newHighAuthorityDocs                                          // watched: no vocab gate
      : newHighAuthorityDocs.filter((d) => hasTerminalVocab(d.title)); // always-on: vocab required

    let signalFired: DevelopmentSignal | null = null;

    if (trackBDocs.length > 0) {
      signalFired = {
        clusterId: cluster.id,
        clusterScore: cluster.score,
        beatSlug: cluster.beatSlug,
        trackType: "authority",
        triggeringDocIds: trackBDocs.map((d) => d.id),
        latestChainArticleId: latestArticle?.id ?? null,
        chainHasRetractionImpact,
        priorChainDepth,
        activeTrustedSourceCount,
      };
    } else {
      // Track A corroboration: N trusted docs (incl. "reported" tier) from
      // ≥2 distinct root domains, all within a rolling time window.
      // Watched clusters get a wider 18 h look-back (editorial intent already
      // expressed) and a lower count threshold; unwatched covered clusters
      // use a tighter 12 h window and require 3 sources.
      const trackAWindowMs = cluster.watched ? TRACK_A_WATCHED_WINDOW_MS : TRACK_A_UNWATCHED_WINDOW_MS;
      const trackAWindowCutoff = now.getTime() - trackAWindowMs;
      const trackADocs = newTrustedDocs.filter(
        (d) => new Date(d.createdAt).getTime() >= trackAWindowCutoff,
      );
      const distinctDomains = new Set(trackADocs.map((d) => rootDomain(d.url)));
      const trackAMin = cluster.watched ? TRACK_A_WATCHED_MIN_SOURCES : TRACK_A_MIN_SOURCES;
      const trackAMinDomains = cluster.watched ? TRACK_A_WATCHED_MIN_DISTINCT_DOMAINS : TRACK_A_UNWATCHED_MIN_DISTINCT_DOMAINS;
      if (trackADocs.length >= trackAMin && distinctDomains.size >= trackAMinDomains) {
        signalFired = {
          clusterId: cluster.id,
          clusterScore: cluster.score,
          beatSlug: cluster.beatSlug,
          trackType: "corroboration",
          triggeringDocIds: trackADocs.map((d) => d.id),
          latestChainArticleId: latestArticle?.id ?? null,
          chainHasRetractionImpact,
          priorChainDepth,
          activeTrustedSourceCount,
        };
      }
    }

    // Two-stage novelty gate (chain-aware):
    //   Low overlap  → definitively novel, fire immediately.
    //   High overlap → suppress (same story retold verbatim).
    //   Middle band  → Haiku binary adjudication (fail-open on error).
    //
    // "Old" context = existing cluster source doc titles PLUS all previously
    // published chain article titles for this cluster. Including chain article
    // titles prevents a duplicate update article when a second burst of sources
    // corroborates what we already wrote about.
    if (signalFired) {
      const oldDocs = activeDocs.filter((d) => !newDocs.some((n) => n.id === d.id));
      // chain articles in scope (chainByCluster.get set earlier in this iteration).
      const chainTitles = chain.map((a) => a.title).filter(Boolean);
      // Extract plain body text from each chain article (paragraphs only) so
      // the Jaccard overlap is computed over full editorial content, not just
      // titles. Truncate each body to 800 chars to bound the term bag size.
      const chainBodyTexts = chain.map((a) => extractBlockText(a.body).slice(0, 800));
      if (oldDocs.length > 0 || chainTitles.length > 0) {
        const triggeringTitles = signalFired.triggeringDocIds.map(
          (id) => newDocs.find((d) => d.id === id)?.title,
        );
        // Combine existing source doc titles with previously published chain
        // article titles AND truncated body text so the overlap calculation
        // covers the full editorial record for this story, not just source vault
        // doc titles. Chain body text catches "same story, same angle" that
        // title-only comparison misses when an update was already written.
        const oldTitles = [
          ...oldDocs.map((d) => d.title),
          ...chainTitles,
          ...chainBodyTexts,
        ];
        const overlap = jaccardSimilarity(termBag(triggeringTitles), termBag(oldTitles));
        if (overlap >= NOVELTY_HIGH_THRESHOLD) {
          suppressed++;
          signalFired = null;
          logger.debug(
            { clusterId: cluster.id, overlap, threshold: NOVELTY_HIGH_THRESHOLD },
            "developmentSignalDetector: signal suppressed by high novelty overlap",
          );
        } else if (overlap >= NOVELTY_AMBIGUOUS_THRESHOLD) {
          // Haiku sees both the incoming source headlines AND the full chain
          // of previously published articles, so it can catch "same angle
          // already covered in update #2" situations.
          const novel = await adjudicateNovelty(triggeringTitles, oldTitles, cluster.beatSlug);
          if (!novel) {
            suppressed++;
            signalFired = null;
            logger.debug(
              { clusterId: cluster.id, overlap },
              "developmentSignalDetector: signal suppressed by Haiku novelty adjudication (chain-aware)",
            );
          }
        }
        // else: low overlap → definitively novel, proceed.
      }
    }

    if (signalFired) {
      // Lifecycle check: compare new triggering docs against the existing row.
      //
      // • Same doc set + consumed/exhausted → suppress. The same event was
      //   already processed or permanently failed; don't re-fire for the same
      //   documents. Genuinely new docs (IDs not in the existing set) bypass
      //   this gate and reset the lifecycle to pending.
      //
      // • Same doc set + pending → upsert WITHOUT resetting retryCount or
      //   status so that accumulated retry failures carry forward. Resetting
      //   here would prevent the signal from ever reaching MAX_SIGNAL_RETRIES.
      //
      // • New docs (any ID not in the existing set) → reset retryCount=0 and
      //   status='pending' because this is a fresh development event.
      //
      // • No existing row → insert fresh pending signal.
      const existingRow = existingRowByCluster.get(cluster.id);
      const existingDocSet = new Set(existingRow?.triggeringDocIds ?? []);
      const hasNewDocs = !existingRow || signalFired.triggeringDocIds.some((id) => !existingDocSet.has(id));

      if (!hasNewDocs && existingRow) {
        // Same doc set — apply lifecycle rules.
        if (existingRow.status === "consumed") {
          suppressed++;
          logger.debug(
            { clusterId: cluster.id, status: existingRow.status },
            "developmentSignalDetector: signal suppressed — all triggering docs already processed",
          );
          continue;
        }

        if (existingRow.status === "exhausted") {
          // Time-based auto-reset: if the signal has been exhausted for at
          // least EXHAUSTED_RESET_MS (24 h), treat this tick as a fresh
          // attempt so transient generation failures don't permanently
          // suppress a cluster.
          const exhaustedAge = now.getTime() - (existingRow.lastSignalAt?.getTime() ?? 0);
          if (exhaustedAge < EXHAUSTED_RESET_MS) {
            suppressed++;
            logger.debug(
              {
                clusterId: cluster.id,
                exhaustedAgeHours: Math.round(exhaustedAge / 3_600_000),
              },
              "developmentSignalDetector: signal suppressed — exhausted, reset window not yet elapsed",
            );
            continue;
          }
          // Age ≥ 24 h — reset to pending so the cluster gets another attempt.
          logger.info(
            { clusterId: cluster.id, exhaustedAgeHours: Math.round(exhaustedAge / 3_600_000) },
            "developmentSignalDetector: resetting exhausted signal after 24 h cooldown",
          );
          signals.push(signalFired);
          await db
            .update(storyUpdateSignalsTable)
            .set({
              trackType: signalFired.trackType,
              triggeringDocIds: signalFired.triggeringDocIds,
              originalArticleId: signalFired.latestChainArticleId ?? undefined,
              status: "pending",
              retryCount: 0,
              consumedAt: sql`NULL`,
              lastSignalAt: now,
              updatedAt: now,
            })
            .where(eq(storyUpdateSignalsTable.clusterId, cluster.id));
          continue;
        } else {
          // status === "pending": same docs, retry in progress. Upsert metadata
          // fields only — preserve retryCount and status so retries accumulate.
          signals.push(signalFired);
          await db
            .update(storyUpdateSignalsTable)
            .set({
              trackType: signalFired.trackType,
              triggeringDocIds: signalFired.triggeringDocIds,
              originalArticleId: signalFired.latestChainArticleId ?? undefined,
              lastSignalAt: now,
              updatedAt: now,
            })
            .where(eq(storyUpdateSignalsTable.clusterId, cluster.id));
          continue;
        }
      } else {
        // New docs (or no existing row) — insert / reset to fresh pending state.
        signals.push(signalFired);
        await db
          .insert(storyUpdateSignalsTable)
          .values({
            clusterId: cluster.id,
            trackType: signalFired.trackType,
            triggeringDocIds: signalFired.triggeringDocIds,
            originalArticleId: signalFired.latestChainArticleId ?? undefined,
            status: "pending",
            retryCount: 0,
            consumedAt: undefined,
            lastSignalAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: storyUpdateSignalsTable.clusterId,
            set: {
              trackType: signalFired.trackType,
              triggeringDocIds: signalFired.triggeringDocIds,
              originalArticleId: signalFired.latestChainArticleId ?? undefined,
              status: "pending",
              retryCount: 0,
              consumedAt: sql`NULL`,
              lastSignalAt: now,
              updatedAt: now,
            },
          });
      }
    }
  }

  const result: SignalScanResult = {
    scanned: watched.length,
    fired: signals.length,
    suppressed,
    signals,
  };

  if (signals.length > 0) {
    logger.info(
      { scanned: result.scanned, fired: result.fired, suppressed: result.suppressed },
      "developmentSignalDetector: signals fired",
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Signal lifecycle helpers — called by cronTick after generation attempts.
// ---------------------------------------------------------------------------

/** Maximum number of generation attempts before a signal is marked exhausted. */
export const MAX_SIGNAL_RETRIES = 3;

/**
 * Mark a cluster's pending signal as consumed. Called after generateUpdateArticle
 * succeeds (including when it returns null = redundant development suppressed).
 * Future scans will not re-fire the same triggering docs for this cluster.
 */
export async function markSignalConsumed(clusterId: string): Promise<void> {
  const now = new Date();
  await db
    .update(storyUpdateSignalsTable)
    .set({ status: "consumed", consumedAt: now, updatedAt: now })
    .where(eq(storyUpdateSignalsTable.clusterId, clusterId));
}

/**
 * Record a failed generation attempt for a cluster's signal.
 * Atomically increments retryCount. When the new count reaches MAX_SIGNAL_RETRIES
 * the signal is marked exhausted and will no longer be retried automatically.
 */
export async function markSignalRetried(clusterId: string): Promise<void> {
  const now = new Date();
  // Atomically increment and read the new retry count in one round-trip.
  const [updated] = await db
    .update(storyUpdateSignalsTable)
    .set({
      retryCount: sql`${storyUpdateSignalsTable.retryCount} + 1`,
      updatedAt: now,
    })
    .where(eq(storyUpdateSignalsTable.clusterId, clusterId))
    .returning({ retryCount: storyUpdateSignalsTable.retryCount });

  const nextRetry = updated?.retryCount ?? MAX_SIGNAL_RETRIES;
  if (nextRetry >= MAX_SIGNAL_RETRIES) {
    await db
      .update(storyUpdateSignalsTable)
      .set({ status: "exhausted", updatedAt: now })
      .where(eq(storyUpdateSignalsTable.clusterId, clusterId));
    logger.warn(
      { clusterId, retries: nextRetry },
      "developmentSignalDetector: signal exhausted after max retries — no further auto-retry",
    );
  }
}

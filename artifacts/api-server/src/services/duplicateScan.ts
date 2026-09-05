import { db, articlesTable, authorsTable, duplicateReviewsTable, articleConceptMentionsTable, type ArticleBlock } from "@workspace/db";
import { recalcConceptArticleCounts, scrubInternalLinksToSlug } from "./articles";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { conceptScore, tokens, jaccard } from "./dedupe";
import { llmConceptDuplicateCheck } from "./llm";
import { logger } from "../lib/logger";
import { acquireJobLock, finishJob, getJobState, heartbeatJob, isJobRunning } from "./jobState";

// Cheap lexical pre-filter: only pairs scoring at/above this become LLM
// candidates (same default as findOverlappingArticles). Keeps the O(n²) judge
// cost bounded — most pairs are nowhere near this.
const CANDIDATE_THRESHOLD = 0.35;
// Body-aware floor: a pair also becomes an LLM candidate when its full concept
// overlap (title + dek + body excerpt) clears this lower bar, even if the cheap
// title+dek score does not. It's intentionally permissive because clearing it
// only sends the pair to the cost-capped, highest-score-first Sonnet judge —
// which makes the final call on the actual text. This is what lets the scan
// catch conceptual near-twins that use different deks (e.g. two reef-bleaching
// pieces) but argue the same thesis in the body.
const BODY_CANDIDATE_THRESHOLD = 0.22;
// Hard cap on Sonnet judge calls per scan so a noisy corpus can't run away with
// cost/latency. Candidates are judged highest-lexical-score first.
const MAX_LLM_CALLS = 60;

export interface DuplicateScanResult {
  scanned: number;
  candidatePairs: number;
  llmCalls: number;
  quarantined: number;
}

interface ScanRow {
  id: string;
  title: string;
  dek: string;
  slug: string;
  body: ArticleBlock[];
  publishedAt: Date | null;
  createdAt: Date;
}

// Flatten an article body (jsonb ArticleBlock[]) into a compact plain-text
// excerpt for concept matching. Paragraphs only (where the thesis lives),
// markdown links unwrapped, capped so both the O(n²) token work and the Sonnet
// judge prompt stay bounded. The lede + opening argument carry the concept, so
// the first ~1800 chars are plenty.
function bodyConceptText(body: ArticleBlock[], maxChars = 1800): string {
  const parts: string[] = [];
  let len = 0;
  for (const block of body) {
    if (block.type !== "paragraph") continue;
    const text = (block.content ?? "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
    if (!text) continue;
    parts.push(text);
    len += text.length;
    if (len >= maxChars) break;
  }
  return parts.join(" ").slice(0, maxChars);
}

// "Newer" = the later-published of the pair (the offender we quarantine).
// Fall back to createdAt when either lacks a publishedAt so the ordering is
// always total and deterministic.
function effectiveDate(r: ScanRow): number {
  return (r.publishedAt ?? r.createdAt).getTime();
}

function pairKey(aId: string, bId: string): string {
  return aId < bId ? `${aId}:${bId}` : `${bId}:${aId}`;
}

// ── Durable job state ───────────────────────────────────────────────────────
// The scan can outlive an autoscale instance. Persist its lock and outcome so a
// restart is visible to the admin UI and another instance cannot overlap it.
// A heartbeat every 30 seconds keeps a live run fresh; after two missed minutes
// a replacement instance may safely take over.
const DUPLICATE_SCAN_JOB = "duplicate_scan";
const DUPLICATE_SCAN_TTL_MS = 2 * 60 * 1000;
const DUPLICATE_SCAN_HEARTBEAT_MS = 30 * 1000;

export async function getDuplicateScanStatus(): Promise<{
  running: boolean;
  interrupted: boolean;
  lastResult: DuplicateScanResult | null;
  lastError: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
}> {
  const row = await getJobState(DUPLICATE_SCAN_JOB);
  const running = isJobRunning(row, DUPLICATE_SCAN_TTL_MS);
  const progress = row?.progress;
  const lastResult =
    row?.status === "succeeded" && progress
      ? {
          scanned: Number(progress["scanned"] ?? 0),
          candidatePairs: Number(progress["candidatePairs"] ?? 0),
          llmCalls: Number(progress["llmCalls"] ?? 0),
          quarantined: Number(progress["quarantined"] ?? 0),
        }
      : null;
  return {
    running,
    interrupted: !running && row?.status === "running",
    lastResult,
    lastError: row?.error ?? null,
    lastStartedAt: row?.startedAt ?? null,
    lastFinishedAt: row?.finishedAt ?? null,
  };
}

/**
 * Daily AI dedup scan over every published, non-quarantined article.
 *
 * 1. Cheap lexical pre-filter (conceptScore) builds candidate pairs, avoiding
 *    an O(n²) wall of LLM calls.
 * 2. Each candidate is confirmed by the Sonnet judge (llmConceptDuplicateCheck),
 *    highest-lexical-score first, capped at MAX_LLM_CALLS.
 * 3. A confirmed pair quarantines the NEWER article (hidden from all public
 *    reads) and records a pending duplicate_reviews row pointing at the older
 *    original.
 *
 * Pairs with an existing pending OR kept review are skipped — "kept" means an
 * admin already decided to overlook them, so they are never re-flagged. Once an
 * article is quarantined within a run it is excluded from any further pairs.
 */
export async function scanForDuplicates(): Promise<DuplicateScanResult> {
  const rows: ScanRow[] = await db
    .select({
      id: articlesTable.id,
      title: articlesTable.title,
      dek: articlesTable.dek,
      slug: articlesTable.slug,
      body: articlesTable.body,
      publishedAt: articlesTable.publishedAt,
      createdAt: articlesTable.createdAt,
    })
    .from(articlesTable)
    .where(and(eq(articlesTable.status, "published"), isNull(articlesTable.quarantinedAt)));

  // Remember pairs we must never re-flag: anything already pending (awaiting a
  // decision) or kept (admin chose to overlook forever).
  const priorReviews = await db
    .select({
      newerArticleId: duplicateReviewsTable.newerArticleId,
      olderArticleId: duplicateReviewsTable.olderArticleId,
      status: duplicateReviewsTable.status,
    })
    .from(duplicateReviewsTable)
    .where(inArray(duplicateReviewsTable.status, ["pending", "kept"]));
  const skipPairs = new Set(priorReviews.map((r) => pairKey(r.newerArticleId, r.olderArticleId)));

  // Precompute each article's concept text (dek + body excerpt) and its token set
  // ONCE, so the O(n²) pair loop never re-tokenizes a body. The body is the only
  // place a shared thesis lives when two pieces use different deks, so the
  // retroactive scan reads it (unlike the pre-publish check, where the proposed
  // article has no body yet).
  type Prepared = ScanRow & { conceptText: string; conceptTokens: Set<string> };
  const prepared: Prepared[] = rows.map((r) => {
    const conceptText = `${r.dek}\n\n${bodyConceptText(r.body)}`.trim();
    return { ...r, conceptText, conceptTokens: tokens(`${r.title} ${conceptText}`) };
  });

  // A pair becomes an LLM candidate when EITHER the cheap title+dek score clears
  // the original floor (`legacy`) OR the body-aware concept overlap clears the
  // lower BODY_CANDIDATE_THRESHOLD (`body-only`).
  type Candidate = { older: Prepared; newer: Prepared; score: number; legacy: boolean };
  const candidates: Candidate[] = [];
  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      const a = prepared[i]!;
      const b = prepared[j]!;
      const titleDekScore = conceptScore(a.title, a.dek, b.title, b.dek).score;
      const bodyScore = jaccard(a.conceptTokens, b.conceptTokens);
      const legacy = titleDekScore >= CANDIDATE_THRESHOLD;
      if (!legacy && bodyScore < BODY_CANDIDATE_THRESHOLD) continue;
      const score = Math.max(titleDekScore, bodyScore);
      const [older, newer] = effectiveDate(a) <= effectiveDate(b) ? [a, b] : [b, a];
      if (skipPairs.has(pairKey(older.id, newer.id))) continue;
      candidates.push({ older, newer, score, legacy });
    }
  }
  // Judge legacy (title+dek) candidates first, each group highest-score-first, so
  // the new body-only candidates can only consume LEFTOVER budget under
  // MAX_LLM_CALLS — a pair that the old title+dek scan would have judged is never
  // crowded out of the cap by the wider body-aware net.
  candidates.sort((x, y) => {
    if (x.legacy !== y.legacy) return x.legacy ? -1 : 1;
    return y.score - x.score;
  });

  const quarantinedThisRun = new Set<string>();
  let llmCalls = 0;
  let quarantined = 0;

  for (const c of candidates) {
    if (llmCalls >= MAX_LLM_CALLS) break;
    // Skip any pair touching an article already quarantined in this run: it is
    // hidden, so it can't be an "original" and must not be quarantined twice.
    if (quarantinedThisRun.has(c.newer.id) || quarantinedThisRun.has(c.older.id)) continue;

    llmCalls += 1;
    const verdict = await llmConceptDuplicateCheck(
      { title: c.newer.title, angle: c.newer.conceptText },
      [{ title: c.older.title, description: c.older.conceptText }],
    );
    if (verdict.duplicateIndex !== 0) continue;

    // Confirmed duplicate: quarantine the newer offender + record the review as
    // one atomic unit. If the article is no longer eligible (already quarantined
    // or gone — affected !== 1) we skip the review insert, so an article can
    // never be left hidden without a matching pending review row.
    const now = new Date();
    const inserted = await db.transaction(async (tx) => {
      const updated = await tx
        .update(articlesTable)
        .set({ quarantinedAt: now })
        .where(and(eq(articlesTable.id, c.newer.id), isNull(articlesTable.quarantinedAt)))
        .returning({ id: articlesTable.id });
      if (updated.length !== 1) return false;
      await tx.insert(duplicateReviewsTable).values({
        newerArticleId: c.newer.id,
        olderArticleId: c.older.id,
        reason: verdict.reason,
        score: c.score,
        status: "pending",
      });
      return true;
    });
    if (!inserted) continue;
    quarantinedThisRun.add(c.newer.id);
    quarantined += 1;
    logger.info(
      { newer: c.newer.slug, older: c.older.slug, score: c.score },
      "dedup scan quarantined duplicate",
    );
  }

  return { scanned: rows.length, candidatePairs: candidates.length, llmCalls, quarantined };
}

/**
 * Fire-and-forget wrapper used by the cron and the manual "Scan now" button.
 * Returns immediately with `started:false` when a scan is already running so a
 * double-click / overlapping cron can't launch a second pass.
 */
export async function startDuplicateScan(): Promise<{ started: boolean; alreadyRunning: boolean }> {
  const runId = await acquireJobLock(DUPLICATE_SCAN_JOB, {
    ttlMs: DUPLICATE_SCAN_TTL_MS,
    progress: {},
  });
  if (!runId) return { started: false, alreadyRunning: true };

  void (async () => {
    const heartbeat = setInterval(() => {
      void heartbeatJob(DUPLICATE_SCAN_JOB, runId).catch((err) =>
        logger.error({ err }, "dedup scan heartbeat failed"),
      );
    }, DUPLICATE_SCAN_HEARTBEAT_MS);
    heartbeat.unref();

    try {
      const result = await scanForDuplicates();
      await finishJob(DUPLICATE_SCAN_JOB, runId, "succeeded", { progress: { ...result } });
      logger.info({ ...result }, "dedup scan finished");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await finishJob(DUPLICATE_SCAN_JOB, runId, "failed", { error: message });
      logger.error({ err }, "dedup scan failed");
    } finally {
      clearInterval(heartbeat);
    }
  })().catch((err) => logger.error({ err }, "dedup scan job-state update failed"));
  return { started: true, alreadyRunning: false };
}

export interface PendingDuplicate {
  id: string;
  reason: string;
  score: number;
  createdAt: string;
  newer: DuplicateArticleSummary;
  older: DuplicateArticleSummary;
}

export interface DuplicateArticleSummary {
  id: string;
  slug: string;
  title: string;
  dek: string;
  category: string;
  heroImage: string;
  publishedAt: string | null;
  authorName: string;
}

/**
 * List the pending review queue, newest-flagged first, with summaries of both
 * the quarantined offender (`newer`) and the original it duplicates (`older`).
 */
export async function listPendingDuplicates(): Promise<PendingDuplicate[]> {
  const newer = alias(articlesTable, "newer_article");
  const older = alias(articlesTable, "older_article");
  const newerAuthor = alias(authorsTable, "newer_author");
  const olderAuthor = alias(authorsTable, "older_author");

  const rows = await db
    .select({
      id: duplicateReviewsTable.id,
      reason: duplicateReviewsTable.reason,
      score: duplicateReviewsTable.score,
      createdAt: duplicateReviewsTable.createdAt,
      newerId: newer.id,
      newerSlug: newer.slug,
      newerTitle: newer.title,
      newerDek: newer.dek,
      newerCategory: newer.category,
      newerHero: newer.heroImage,
      newerPublishedAt: newer.publishedAt,
      newerAuthor: newerAuthor.name,
      olderId: older.id,
      olderSlug: older.slug,
      olderTitle: older.title,
      olderDek: older.dek,
      olderCategory: older.category,
      olderHero: older.heroImage,
      olderPublishedAt: older.publishedAt,
      olderAuthor: olderAuthor.name,
    })
    .from(duplicateReviewsTable)
    .innerJoin(newer, eq(newer.id, duplicateReviewsTable.newerArticleId))
    .innerJoin(older, eq(older.id, duplicateReviewsTable.olderArticleId))
    .innerJoin(newerAuthor, eq(newerAuthor.id, newer.authorId))
    .innerJoin(olderAuthor, eq(olderAuthor.id, older.authorId))
    .where(eq(duplicateReviewsTable.status, "pending"))
    .orderBy(desc(duplicateReviewsTable.createdAt));

  return rows.map((r) => ({
    id: r.id,
    reason: r.reason,
    score: r.score,
    createdAt: r.createdAt.toISOString(),
    newer: {
      id: r.newerId,
      slug: r.newerSlug,
      title: r.newerTitle,
      dek: r.newerDek,
      category: r.newerCategory,
      heroImage: r.newerHero,
      publishedAt: r.newerPublishedAt ? r.newerPublishedAt.toISOString() : null,
      authorName: r.newerAuthor,
    },
    older: {
      id: r.olderId,
      slug: r.olderSlug,
      title: r.olderTitle,
      dek: r.olderDek,
      category: r.olderCategory,
      heroImage: r.olderHero,
      publishedAt: r.olderPublishedAt ? r.olderPublishedAt.toISOString() : null,
      authorName: r.olderAuthor,
    },
  }));
}

export class DuplicateReviewNotFoundError extends Error {}

/**
 * Keep the offender: clear its quarantine (back on the public site) and mark the
 * review `kept` so this exact pair is never re-flagged by future scans.
 */
export async function keepDuplicate(reviewId: string): Promise<void> {
  await db.transaction(async (tx) => {
    // Flip the review to "kept" first, guarded on it still being pending, so two
    // concurrent admin actions on the same review can't both proceed.
    const decided = await tx
      .update(duplicateReviewsTable)
      .set({ status: "kept", decidedAt: new Date() })
      .where(
        and(eq(duplicateReviewsTable.id, reviewId), eq(duplicateReviewsTable.status, "pending")),
      )
      .returning({ newerArticleId: duplicateReviewsTable.newerArticleId });
    if (decided.length !== 1) throw new DuplicateReviewNotFoundError("No pending review with that id");
    await tx
      .update(articlesTable)
      .set({ quarantinedAt: null })
      .where(eq(articlesTable.id, decided[0]!.newerArticleId));
  });
  logger.info({ reviewId }, "dedup review kept");
}

/**
 * Delete the offender: hard-delete the newer article. The duplicate_reviews FK
 * cascades, so the review row disappears with it.
 */
export async function deleteDuplicate(reviewId: string): Promise<void> {
  // Capture data needed for post-commit side effects inside the transaction
  // (where FK cascade hasn't run yet), then fire them AFTER commit so they
  // read the committed state rather than racing it.
  const { deletedSlug, affectedConceptIds, deletedArticleId } = await db.transaction(async (tx) => {
    // Mark the review "deleted" first, guarded on pending, so a concurrent
    // keep/delete on the same review can't also run. The article delete then
    // cascades the (now "deleted") review row away.
    const decided = await tx
      .update(duplicateReviewsTable)
      .set({ status: "deleted", decidedAt: new Date() })
      .where(
        and(eq(duplicateReviewsTable.id, reviewId), eq(duplicateReviewsTable.status, "pending")),
      )
      .returning({ newerArticleId: duplicateReviewsTable.newerArticleId });
    if (decided.length !== 1) throw new DuplicateReviewNotFoundError("No pending review with that id");
    const deletedArticleId = decided[0]!.newerArticleId;
    const [article] = await tx
      .select({ slug: articlesTable.slug })
      .from(articlesTable)
      .where(eq(articlesTable.id, deletedArticleId))
      .limit(1);
    // Capture concept IDs BEFORE deleting — the FK cascade removes
    // article_concept_mentions rows with the article, making them invisible
    // to any post-delete lookup inside recalcConceptArticleCounts.
    const affectedConceptIds = (
      await tx
        .selectDistinct({ conceptId: articleConceptMentionsTable.conceptId })
        .from(articleConceptMentionsTable)
        .where(eq(articleConceptMentionsTable.articleId, deletedArticleId))
    ).map((r) => r.conceptId);
    await tx.delete(articlesTable).where(eq(articlesTable.id, deletedArticleId));
    logger.info(
      { reviewId, deletedArticle: deletedArticleId },
      "dedup review deleted offender",
    );
    return { deletedSlug: article?.slug ?? null, affectedConceptIds, deletedArticleId };
  });

  // Self-heal inbound links and concept counts AFTER the transaction commits
  // so the FK cascades have already run and reads see the committed state.
  if (deletedSlug) {
    void scrubInternalLinksToSlug(deletedSlug).catch((err) =>
      logger.error({ err, deletedSlug }, "Failed to scrub inbound links after dedup delete"),
    );
  }
  if (affectedConceptIds.length > 0) {
    void recalcConceptArticleCounts(undefined, affectedConceptIds).catch((err) =>
      logger.error({ err, articleId: deletedArticleId }, "Failed to recalc concept counts after dedup delete"),
    );
  }
}

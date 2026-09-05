import { and, inArray, ne, sql } from "drizzle-orm";
import { db, articleSourcesTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { acquireJobLock, heartbeatJob, finishJob, getJobState } from "./jobState";
import { clearJunkSourceTitles } from "./citationMetadata";
import { backfillArticleSourceLinks } from "./articles";

// --- Source diversity sweep (Task #274) -------------------------------------
// Detects same-paper mirror duplicates within each article's reference list
// (doi.org + PubMed Central + publisher all citing the same paper), rejects
// the inferior copies, and clears any junk titles (bot-wall captcha pages)
// that slipped into source_title during vault copy.
//
// After the sweep the affected articles have fewer sources than the cap, so
// the existing "Top up sources" job will naturally pick them up on the next
// admin trigger or cron tick.

export const DIVERSITY_SWEEP_JOB = "source_diversity_sweep";
const SWEEP_TTL_MS = 5 * 60 * 1000;

export interface DiversitySweepReport {
  duplicateGroups: number;
  rowsRejected: number;
  junkTitlesCleared: number;
  articlesAffected: number;
  topUpLinksAdded: number;
  topUpArticlesFilled: number;
}

export async function startDiversitySweep(): Promise<boolean> {
  const runId = await acquireJobLock(DIVERSITY_SWEEP_JOB, { ttlMs: SWEEP_TTL_MS });
  if (!runId) return false;
  void runSweep(runId).catch((err) => {
    logger.error({ err }, "sourceDiversity: sweep failed");
  });
  return true;
}

async function runSweep(runId: string): Promise<DiversitySweepReport> {
  const report: DiversitySweepReport = {
    duplicateGroups: 0,
    rowsRejected: 0,
    junkTitlesCleared: 0,
    articlesAffected: 0,
    topUpLinksAdded: 0,
    topUpArticlesFilled: 0,
  };
  try {
    // Pass 1: clear existing junk titles (bot-wall captcha pages, etc.) so
    // they fall back to URL-slug / anchor-text resolution at render time.
    report.junkTitlesCleared = await clearJunkSourceTitles();

    // Pass 2: find same-title duplicate groups within each article.
    // Normalization mirrors the display-time normRefTitle function in public.ts:
    // lowercase, strip non-alphanumeric, collapse spaces.
    const dupes = await db.execute(sql`
      SELECT
        "article_id",
        array_agg("id" ORDER BY
          CASE "tier"
            WHEN 'primary'     THEN 0
            WHEN 'firsthand'   THEN 1
            WHEN 'wire'        THEN 2
            WHEN 'reported'    THEN 3
            WHEN 'commentary'  THEN 4
            WHEN 'social'      THEN 5
            WHEN 'aggregator'  THEN 6
            WHEN 'reference'   THEN 7
            ELSE 8
          END ASC,
          ("source_authors" IS NOT NULL) DESC,
          "id" ASC
        ) AS ids
      FROM "article_sources"
      WHERE "role" = 'evidence'
        AND "status" <> 'rejected'
        AND "source_title" IS NOT NULL
        AND btrim("source_title") <> ''
      GROUP BY
        "article_id",
        lower(trim(regexp_replace(
          regexp_replace("source_title", '[^[:alnum:][:space:]]', '', 'gi'),
          '[[:space:]]+', ' ', 'g'
        )))
      HAVING count(*) > 1
    `);

    report.duplicateGroups = dupes.rows.length;

    if (dupes.rows.length > 0) {
      const affectedArticles = new Set<string>();

      for (const row of dupes.rows) {
        const ids = row.ids as string[];
        if (ids.length <= 1) continue;
        // ids[0] is the best-tier representative (kept); reject the rest.
        const toReject = ids.slice(1);
        await db
          .update(articleSourcesTable)
          .set({ status: "rejected", rejectionReason: "duplicate_title", updatedAt: new Date() })
          .where(
            and(
              inArray(articleSourcesTable.id, toReject),
              ne(articleSourcesTable.status, "rejected"),
            ),
          );
        report.rowsRejected += toReject.length;
        affectedArticles.add(row.article_id as string);

        if (report.duplicateGroups > 10 && report.rowsRejected % 10 === 0) {
          await heartbeatJob(DIVERSITY_SWEEP_JOB, runId, { ...report });
        }
      }

      report.articlesAffected = affectedArticles.size;

      // Pass 3: top-up the articles that lost sources so they return to the
      // SOURCE_LINK_TARGET cap. We call the existing per-article backfill
      // which is idempotent (skips at-target articles) and vault-first (no
      // web search needed when relevant vault docs already exist).
      await heartbeatJob(DIVERSITY_SWEEP_JOB, runId, { ...report });
      let topUpProcessed = 0;
      for (const articleId of affectedArticles) {
        try {
          const result = await backfillArticleSourceLinks(articleId);
          if (!result.skipped && result.linksAdded > 0) {
            report.topUpLinksAdded += result.linksAdded;
            report.topUpArticlesFilled += 1;
          }
        } catch (err) {
          logger.warn({ err, articleId }, "sourceDiversity: top-up failed for article; skipping");
        }
        // Heartbeat inside the (slow, LLM-bound) top-up loop so the 5-min lock
        // TTL can't expire mid-run and let a second sweep start.
        topUpProcessed += 1;
        if (topUpProcessed % 3 === 0) {
          await heartbeatJob(DIVERSITY_SWEEP_JOB, runId, { ...report });
        }
      }
    }

    await finishJob(DIVERSITY_SWEEP_JOB, runId, "succeeded", { progress: { ...report } });
    logger.info(report, "sourceDiversity: sweep complete");
    return report;
  } catch (err) {
    await finishJob(DIVERSITY_SWEEP_JOB, runId, "failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    logger.error({ err }, "sourceDiversity: sweep failed");
    throw err;
  }
}

export async function getDiversitySweepStatus(): Promise<{
  status: string;
  progress: Record<string, unknown> | null;
}> {
  const state = await getJobState(DIVERSITY_SWEEP_JOB);
  return {
    status: state?.status ?? "idle",
    progress: (state?.progress as Record<string, unknown> | null) ?? null,
  };
}

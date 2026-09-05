import { and, eq, isNull, isNotNull, ne, sql } from "drizzle-orm";
import { db, articlesTable, articleSourcesTable, sourceDocumentsTable } from "@workspace/db";
import type { ArticleBlock } from "@workspace/db";
import { logger } from "../lib/logger";
import { generateCitationNotes, AiFunctionDisabledError } from "./llm";
import { BudgetGuard, BudgetExceededError } from "./aiBudget";
import { acquireJobLock, heartbeatJob, finishJob, isCancelRequested, getJobState, requestJobCancel } from "./jobState";
import { isJobRunning } from "./jobStaleness";

// --- Citation notes ("evidence map", Task #273) -----------------------------
// One AI-written sentence per (article, evidence source) explaining WHY the
// source is included — shown as a quiet secondary line under each entry in the
// public References list. ONE batched Haiku call per article covers all its
// sources; the model omits any source it can't confidently explain (a NULL
// note renders nothing — better than a guessed one). note_generated_at stamps
// every attempted row (even declined ones) so re-runs never re-bill the same
// rows; the backfill is resumable and budget-guarded.

function blocksToText(body: ArticleBlock[] | null | undefined): string {
  return (body ?? [])
    .filter((b) => b.type === "paragraph" || b.type === "heading" || b.type === "pullquote")
    .map((b) => b.content)
    .join("\n\n")
    .replace(/\s+/g, " ")
    .trim();
}

export interface CitationNotesResult {
  attempted: number;
  notesWritten: number;
}

/**
 * Generate citation notes for every evidence source of ONE article that has
 * no note and no prior generation attempt. Safe to call repeatedly (attempted
 * rows are stamped). Throws AiFunctionDisabledError when the function is
 * paused so callers can degrade cleanly.
 */
export async function generateCitationNotesForArticle(articleId: string): Promise<CitationNotesResult> {
  const [article] = await db
    .select({ id: articlesTable.id, title: articlesTable.title, dek: articlesTable.dek, body: articlesTable.body })
    .from(articlesTable)
    .where(eq(articlesTable.id, articleId))
    .limit(1);
  if (!article) return { attempted: 0, notesWritten: 0 };

  // Same row population the public References list renders (evidence,
  // non-rejected, note not yet attempted), with the same display-name
  // preference: snapshot title → vault doc title → domain.
  const rows = await db
    .select({
      id: articleSourcesTable.id,
      url: articleSourcesTable.url,
      domain: articleSourcesTable.domain,
      anchorText: articleSourcesTable.anchorText,
      sourceTitle: articleSourcesTable.sourceTitle,
      docTitle: sourceDocumentsTable.title,
      docExcerpt: sourceDocumentsTable.excerpt,
      docText: sourceDocumentsTable.extractedText,
    })
    .from(articleSourcesTable)
    // LEFT join: when a source has a matched Vault doc its stored text grounds
    // the note; when it doesn't (the overwhelmingly common case — most woven
    // links were never vault-ingested), the note is grounded in the article
    // body + the source's snapshot metadata (title/publisher/anchor context).
    // The model is instructed to omit any source it can't confidently explain,
    // so a missing excerpt degrades to "no note", never a guessed one.
    .leftJoin(sourceDocumentsTable, eq(sourceDocumentsTable.id, articleSourcesTable.sourceDocumentId))
    .where(
      and(
        eq(articleSourcesTable.articleId, articleId),
        eq(articleSourcesTable.role, "evidence"),
        ne(articleSourcesTable.status, "rejected"),
        isNull(articleSourcesTable.citationNote),
        isNull(articleSourcesTable.noteGeneratedAt),
      ),
    );
  if (rows.length === 0) return { attempted: 0, notesWritten: 0 };

  const bodyText = blocksToText(article.body as ArticleBlock[] | null);
  if (!bodyText) return { attempted: 0, notesWritten: 0 };

  const sources = rows.map((r) => ({
    name: (r.sourceTitle ?? "").trim() || (r.docTitle ?? "").trim() || r.domain,
    domain: r.domain,
    anchorText: r.anchorText,
    // Vault-stored source text grounds the note; prefer the full extracted
    // text (llm.ts truncates it), fall back to the ingest excerpt.
    sourceText: (r.docText ?? "").trim() || (r.docExcerpt ?? "").trim() || null,
  }));

  // May throw AiFunctionDisabledError — callers decide how to degrade. Any
  // other failure also propagates WITHOUT stamping attempts, so a transient
  // API error doesn't permanently mark rows as "tried".
  const notes = await generateCitationNotes({
    title: article.title,
    dek: article.dek,
    bodyText,
    sources,
    articleId,
  });

  const now = new Date();
  let notesWritten = 0;
  for (let i = 0; i < rows.length; i++) {
    const note = notes.get(i + 1) ?? null;
    if (note) notesWritten += 1;
    await db
      .update(articleSourcesTable)
      .set({
        ...(note ? { citationNote: note } : {}),
        noteGeneratedAt: now,
        updatedAt: now,
      })
      .where(and(eq(articleSourcesTable.id, rows[i].id), isNull(articleSourcesTable.citationNote)));
  }
  return { attempted: rows.length, notesWritten };
}

// --- Backfill job ------------------------------------------------------------

export const CITATION_NOTES_JOB = "citation_notes_backfill";
const NOTES_TTL_MS = 3 * 60 * 1000;
// Per-run article cap: one LLM call per article, resumable via note_generated_at.
const MAX_ARTICLES_PER_RUN = 150;

export interface CitationNotesReport {
  articlesProcessed: number;
  notesWritten: number;
  rowsSkipped: number;
  failures: number;
  remaining: number;
  stoppedBy?: string;
}

// Every non-rejected evidence row without a note or prior attempt is eligible.
// Vault text (when present) enriches the grounding, but is NOT required — the
// article body + snapshot metadata suffice, and the model omits notes it can't
// confidently write.
const ELIGIBLE_ROW_SQL = sql`
  s."role" = 'evidence' AND s."status" <> 'rejected'
  AND s."citation_note" IS NULL AND s."note_generated_at" IS NULL
`;

async function countRemaining(): Promise<number> {
  const res = await db.execute(sql`
    SELECT count(DISTINCT s."article_id")::int AS n
    FROM "article_sources" s
    JOIN "articles" a ON a."id" = s."article_id"
    WHERE a."status" = 'published' AND ${ELIGIBLE_ROW_SQL}
  `);
  return Number(res.rows[0]?.n ?? 0);
}

/**
 * Deterministic, free pre-step: link article_sources rows to existing Vault
 * docs by exact URL / canonical-URL match so their stored text can ground the
 * note. Most woven links were never vault-ingested (so most rows stay
 * unlinked), but this rescues the ones that were.
 */
async function linkSourcesToVaultDocs(): Promise<number> {
  const res = await db.execute(sql`
    UPDATE "article_sources" s
    SET "source_document_id" = d."id", "updated_at" = now()
    FROM "source_documents" d
    WHERE s."source_document_id" IS NULL
      AND s."role" = 'evidence' AND s."status" <> 'rejected'
      AND (d."url" = s."url" OR d."canonical_url" = s."url"
           OR (s."canonical_url" IS NOT NULL AND d."canonical_url" = s."canonical_url"))
      AND (coalesce(d."extracted_text", '') <> '' OR coalesce(d."excerpt", '') <> '')
  `);
  return res.rowCount ?? 0;
}

/**
 * Fire-and-forget admin trigger: acquires the shared job lock (false = 409
 * path) and runs the backfill in an unawaited promise.
 */
export async function startCitationNotesBackfill(): Promise<boolean> {
  const runId = await acquireJobLock(CITATION_NOTES_JOB, { ttlMs: NOTES_TTL_MS });
  if (!runId) return false;
  void runNotesBackfill(runId).catch((err) => {
    logger.error({ err }, "citationNotes: background run failed");
  });
  return true;
}

async function runNotesBackfill(runId: string): Promise<CitationNotesReport> {
  const report: CitationNotesReport = {
    articlesProcessed: 0,
    notesWritten: 0,
    rowsSkipped: 0,
    failures: 0,
    remaining: 0,
  };
  try {
    const budget = await BudgetGuard.start("citation-notes backfill");

    // Free deterministic pre-step: rescue vault grounding where a doc with the
    // same URL already exists but was never linked to the source row.
    const linked = await linkSourcesToVaultDocs();
    if (linked > 0) logger.info({ linked }, "citationNotes: linked sources to vault docs by URL");

    // Published articles with at least one evidence source that has neither a
    // note nor a prior generation attempt — oldest first so the back catalog
    // fills in deterministic order across resumed runs.
    const pending = await db.execute(sql`
      SELECT DISTINCT s."article_id" AS id, min(a."published_at") AS pub
      FROM "article_sources" s
      JOIN "articles" a ON a."id" = s."article_id"
      WHERE a."status" = 'published' AND ${ELIGIBLE_ROW_SQL}
      GROUP BY s."article_id"
      ORDER BY pub ASC NULLS LAST
      LIMIT ${MAX_ARTICLES_PER_RUN}
    `);
    const articleIds = pending.rows.map((r) => String(r.id));

    for (const articleId of articleIds) {
      if (await isCancelRequested(CITATION_NOTES_JOB)) {
        report.stoppedBy = "canceled";
        break;
      }
      try {
        await budget.check();
      } catch (e) {
        if (e instanceof BudgetExceededError) {
          report.stoppedBy = "budget";
          logger.warn({ reason: e.reason, ...report }, e.message);
          break;
        }
        throw e;
      }
      if (report.articlesProcessed % 5 === 0) {
        await heartbeatJob(CITATION_NOTES_JOB, runId, {
          processed: report.articlesProcessed,
          total: articleIds.length,
          ...report,
        });
      }
      try {
        const res = await generateCitationNotesForArticle(articleId);
        report.articlesProcessed += 1;
        report.notesWritten += res.notesWritten;
        report.rowsSkipped += res.attempted - res.notesWritten;
      } catch (err) {
        if (err instanceof AiFunctionDisabledError) {
          report.stoppedBy = "disabled";
          logger.warn("citationNotes: function paused — stopping backfill");
          break;
        }
        report.failures += 1;
        logger.warn({ err, articleId }, "citationNotes: article failed");
      }
    }

    report.remaining = await countRemaining();
    await finishJob(CITATION_NOTES_JOB, runId, "succeeded", { progress: { ...report } });
    logger.info(report, "citationNotes: run complete");
    return report;
  } catch (err) {
    await finishJob(CITATION_NOTES_JOB, runId, "failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    logger.error({ err }, "citationNotes: run failed");
    throw err;
  }
}

/**
 * Request cooperative cancellation of a running citation-notes backfill.
 * Returns true if the cancel flag was set, false if no job is running.
 */
export async function cancelCitationNotesBackfill(): Promise<boolean> {
  return requestJobCancel(CITATION_NOTES_JOB);
}

/**
 * Clear note_generated_at on evidence sources where the model previously
 * declined to write a note (note_generated_at stamped but citation_note IS
 * NULL). This makes those rows eligible again for the next backfill run.
 * Returns the number of rows reset.
 */
export async function resetDeclinedNoteAttempts(): Promise<number> {
  const result = await db
    .update(articleSourcesTable)
    .set({ noteGeneratedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(articleSourcesTable.role, "evidence"),
        ne(articleSourcesTable.status, "rejected"),
        isNull(articleSourcesTable.citationNote),
        isNotNull(articleSourcesTable.noteGeneratedAt),
      ),
    );
  return result.rowCount ?? 0;
}

export async function getCitationNotesStatus(): Promise<{
  status: string;
  isStale: boolean;
  progress: Record<string, unknown> | null;
  remaining: number;
  declinedAttempts: number;
  sourcesTotal: number;
  sourcesWithNotes: number;
  articlesTotal: number;
  articlesWithNotes: number;
}> {
  const state = await getJobState(CITATION_NOTES_JOB);
  // Coverage over the same population the public References list renders:
  // evidence-role, non-rejected sources on published articles.
  const cov = await db.execute(sql`
    SELECT
      count(*)::int AS sources_total,
      count(*) FILTER (WHERE s."citation_note" IS NOT NULL)::int AS sources_with_notes,
      count(DISTINCT s."article_id")::int AS articles_total,
      count(DISTINCT s."article_id") FILTER (WHERE s."citation_note" IS NOT NULL)::int AS articles_with_notes
    FROM "article_sources" s
    JOIN "articles" a ON a."id" = s."article_id"
    WHERE a."status" = 'published' AND s."role" = 'evidence' AND s."status" <> 'rejected'
  `);
  // Count evidence sources that were attempted but the model declined (stamp
  // present, note absent) — these are retryable via resetDeclinedNoteAttempts.
  const declinedRes = await db.execute(sql`
    SELECT count(DISTINCT s."article_id")::int AS n
    FROM "article_sources" s
    JOIN "articles" a ON a."id" = s."article_id"
    WHERE a."status" = 'published'
      AND s."role" = 'evidence' AND s."status" <> 'rejected'
      AND s."citation_note" IS NULL AND s."note_generated_at" IS NOT NULL
  `);

  const row = cov.rows[0] ?? {};
  return {
    status: state?.status ?? "idle",
    isStale: state?.status === "running" && !isJobRunning(state, NOTES_TTL_MS),
    progress: (state?.progress as Record<string, unknown> | null) ?? null,
    remaining: await countRemaining(),
    declinedAttempts: Number(declinedRes.rows[0]?.n ?? 0),
    sourcesTotal: Number(row.sources_total ?? 0),
    sourcesWithNotes: Number(row.sources_with_notes ?? 0),
    articlesTotal: Number(row.articles_total ?? 0),
    articlesWithNotes: Number(row.articles_with_notes ?? 0),
  };
}

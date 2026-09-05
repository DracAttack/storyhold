// --- Source Gap Scanner ---------------------------------------------------
// Scans published article bodies for claims that reference a specific year +
// publication/journal but have NO inline citation link. These "unsourced claims"
// are gaps in the article's evidence graph that can be backfilled by web search.
//
// Design principles:
//   - DB-only scan is FREE (no AI, no web_search, no fetching).
//   - Detection is regex-based on known citation patterns.
//   - Search + ingest is a SEPARATE step, gated on Perplexity config + budget.
//   - All writes are idempotent: duplicate (article_id, claim_text) rows skip.
//   - applyGapFill weaves the link into the article body AND updates article_sources
//     (trust box) in one atomic operation.

import {
  db,
  articlesTable,
  sourceGapsTable,
  articleSourcesTable,
  type ArticleBlock,
} from "@workspace/db";
import { eq, and, isNull, desc, asc, sql, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import { type SearchLead } from "./perplexity";
import { searchWithFallback } from "./researchFallback";
import { enqueueUrl } from "./sourceIngestQueue";
import { classifySourceRole, isCitationIntermediaryUrl } from "./sourceAuthority";

// --- Detection patterns ----------------------------------------------------

// Match phrases like:
//   "A 2023 review published in Nature..."
//   "A 2021 study in the Journal of..."
//   "A 2020 paper by Smith et al. in..."
//   "According to a 2022 meta-analysis in..."
// These are claims that SHOULD have a citation but often don't in early drafts.
const UNSOURCED_CLAIM_RE =
  /\b(?:[Aa]\s+(?:\d{4})\s+(?:review|study|paper|meta-analysis|survey|report|analysis)\s+(?:published\s+)?(?:in|by|from)\s+[^.;]{5,120})/g;

// Broader catch: year (19xx/20xx) within ~150 chars of a stronger evidence
// term (study/review/journal/meta-analysis/paper). Excludes weak tokens like
// "team" or "published" alone that fire on non-claim prose.
const YEAR_JOURNAL_RE = /\b(?:19|20)\d{2}\b.{0,150}\b(?:journal|review|study|paper|meta-analysis|analysis|survey|report)\b/gi;

// Any markdown link — used for duplicate detection and phrase-wrapping.
const ANY_MD_LINK_RE = /\[([^\]]*)\]\(([^)]*)\)/g;

// External http/https link specifically.
const EXTERNAL_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)]*)\)/g;

// --- Helpers ---------------------------------------------------------------

function extractYear(text: string): number | null {
  const m = text.match(/\b(19|20)\d{2}\b/);
  return m ? parseInt(m[1] + m[0].slice(2), 10) : null;
}

function extractPublication(claim: string): string | null {
  const m = claim.match(/(?:in|by|from)\s+([^.;]{3,80})/i);
  if (!m) return null;
  const raw = m[1].trim();
  const cleaned = raw
    .replace(/,\s+(?:the|a|an)\s+.*$/i, "")
    .replace(/\s+(?:and|with|for|on|at|to|that|which)\s+.*$/i, "")
    .replace(
      /\s+(?:found|showed|reported|noted|said|wrote|argued|suggested|concluded|changed|demonstrated|revealed|established|confirmed|indicated|described|identified|observed)\s+.*$/i,
      "",
    )
    .replace(/\s+(?:researchers|team|group|scientists|authors)\s+.*$/i, "")
    .trim();
  return cleaned.length > 2 ? cleaned : null;
}

/**
 * Extract the domain from a URL. Returns empty string on parse failure.
 */
function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Wrap the FIRST verbatim occurrence of `phrase` in `paragraph` as an external
 * Markdown link to `url`, but only where that occurrence sits in ordinary prose
 * — never inside an existing Markdown link. Returns the new paragraph string,
 * or null if no linkable occurrence is found.
 */
function wrapPhraseAsLink(paragraph: string, phrase: string, url: string): string | null {
  const needle = phrase.trim();
  if (!needle) return null;
  const linkRanges: Array<[number, number]> = [];
  for (const m of paragraph.matchAll(ANY_MD_LINK_RE)) {
    const start = m.index ?? 0;
    linkRanges.push([start, start + m[0].length]);
  }
  let from = 0;
  while (from <= paragraph.length) {
    const at = paragraph.indexOf(needle, from);
    if (at === -1) return null;
    const end = at + needle.length;
    const insideLink = linkRanges.some(([s, e]) => at < e && end > s);
    if (!insideLink) {
      return paragraph.slice(0, at) + `[${needle}](${url})` + paragraph.slice(end);
    }
    from = at + 1;
  }
  return null;
}

/**
 * Returns true if `url` already appears as a link target in any paragraph block.
 */
function urlAlreadyLinkedInBody(body: ArticleBlock[], url: string): boolean {
  const needle = url.toLowerCase();
  for (const block of body) {
    if (block.type !== "paragraph" || typeof block.content !== "string") continue;
    for (const m of block.content.matchAll(EXTERNAL_LINK_RE)) {
      if ((m[2] ?? "").toLowerCase() === needle) return true;
    }
  }
  return false;
}

// --- Scanning --------------------------------------------------------------

export interface GapCandidate {
  claimText: string;
  contextText: string;
  publicationHint: string | null;
  yearHint: number | null;
}

/**
 * Scan a single article body for unsourced claims. Returns candidates that
 * are NOT already present as inline markdown links in the body.
 */
export function scanArticleBody(body: ArticleBlock[]): GapCandidate[] {
  const candidates: GapCandidate[] = [];
  const seen = new Set<string>();

  for (const block of body) {
    if (block.type !== "paragraph" && block.type !== "pullquote") continue;
    const text = block.content;

    // Skip the entire paragraph if it already contains any citation links —
    // a paragraph with inline citations is considered sufficiently sourced.
    const paragraphHasLinks = /\[([^\]]+)\]\(\s*([^)\s]+)\s*\)/.test(text);
    if (paragraphHasLinks) continue;

    // Strategy 1: strong unsourced claim pattern ("A 2023 review in Nature...").
    let foundInBlock = false;
    for (const match of text.matchAll(UNSOURCED_CLAIM_RE)) {
      const claim = match[0];
      if (seen.has(claim)) continue;
      seen.add(claim);
      foundInBlock = true;
      candidates.push({
        claimText: claim,
        contextText: text.slice(0, 500),
        publicationHint: extractPublication(claim),
        yearHint: extractYear(claim),
      });
    }

    // Strategy 2: broader catch for year+journal-ish word mentions.
    // Only runs if Strategy 1 found nothing in this block — keeps precision
    // high while not missing simpler phrasings like "the 2023 Nature study".
    if (!foundInBlock) {
      for (const match of text.matchAll(YEAR_JOURNAL_RE)) {
        // Expand to the containing sentence (up to 250 chars).
        const start = Math.max(match.index! - 40, 0);
        const end = Math.min(match.index! + match[0].length + 160, text.length);
        const claim = text.slice(start, end).trim();
        if (seen.has(claim)) continue;
        seen.add(claim);
        candidates.push({
          claimText: claim,
          contextText: text.slice(0, 500),
          publicationHint: extractPublication(claim),
          yearHint: extractYear(claim),
        });
      }
    }
  }

  // Dedupe by claim text (exact match).
  const unique: GapCandidate[] = [];
  const uniq = new Set<string>();
  for (const c of candidates) {
    if (uniq.has(c.claimText)) continue;
    uniq.add(c.claimText);
    unique.push(c);
  }
  return unique;
}

// --- Admin-facing scan + persist ------------------------------------------

export interface ArticleScanDetail {
  id: string;
  slug: string;
  gapsFound: number;
  gapsInserted: number;
  gapsSkipped: number;
}

export interface ScanReport {
  dryRun: boolean;
  articlesScanned: number;
  gapsFound: number;
  gapsInserted: number;
  gapsSkipped: number;
  articles: ArticleScanDetail[];
}

/**
 * Scan published articles for unsourced claims and persist gaps.
 * Bounded: scans at most `batchSize` articles and `maxGapsPerArticle` gaps.
 */
export async function scanForSourceGaps(opts: {
  dryRun?: boolean;
  batchSize?: number;
  maxGapsPerArticle?: number;
} = {}): Promise<ScanReport> {
  const dryRun = opts.dryRun ?? false;
  const batchSize = Math.min(Math.max(opts.batchSize ?? 25, 1), 50);
  const maxGapsPerArticle = Math.min(Math.max(opts.maxGapsPerArticle ?? 5, 1), 20);

  // Advance through the catalog: oldest un-scanned articles first, then
  // the oldest scanned ones (re-check in case body was edited since last scan).
  const articleRows = await db
    .select({ id: articlesTable.id, slug: articlesTable.slug, body: articlesTable.body })
    .from(articlesTable)
    .where(
      and(
        eq(articlesTable.status, "published"),
        isNull(articlesTable.quarantinedAt),
        sql`${articlesTable.body} IS NOT NULL`,
      ),
    )
    .orderBy(
      // NULLS FIRST so never-scanned articles are picked before re-checked ones.
      sql`${articlesTable.sourceGapScannedAt} ASC NULLS FIRST`,
      asc(articlesTable.publishedAt),
    )
    .limit(batchSize);

  let gapsFound = 0;
  let gapsInserted = 0;
  let gapsSkipped = 0;
  const articles: ArticleScanDetail[] = [];

  for (const row of articleRows) {
    const body = (row.body ?? []) as ArticleBlock[];
    const candidates = scanArticleBody(body).slice(0, maxGapsPerArticle);
    let aFound = candidates.length;
    let aInserted = 0;
    let aSkipped = 0;

    if (!dryRun) {
      for (const c of candidates) {
        try {
          const [inserted] = await db
            .insert(sourceGapsTable)
            .values({
              articleId: row.id,
              claimText: c.claimText,
              contextText: c.contextText,
              publicationHint: c.publicationHint,
              yearHint: c.yearHint,
              status: "pending",
            })
            .onConflictDoNothing({
              target: [sourceGapsTable.articleId, sourceGapsTable.claimText],
            })
            .returning({ id: sourceGapsTable.id });
          if (inserted) {
            gapsInserted += 1;
            aInserted += 1;
          } else {
            gapsSkipped += 1;
            aSkipped += 1;
          }
        } catch (err) {
          gapsSkipped += 1;
          aSkipped += 1;
          logger.warn({ err, articleId: row.id }, "scanForSourceGaps: insert failed");
        }
      }
      // Stamp the article so it advances behind fresher un-scanned rows.
      await db
        .update(articlesTable)
        .set({ sourceGapScannedAt: new Date() })
        .where(eq(articlesTable.id, row.id));
    }

    gapsFound += aFound;
    articles.push({
      id: row.id,
      slug: row.slug,
      gapsFound: aFound,
      gapsInserted: aInserted,
      gapsSkipped: aSkipped,
    });
  }

  logger.info(
    { dryRun, articlesScanned: articleRows.length, gapsFound, gapsInserted, gapsSkipped },
    "scanForSourceGaps: complete",
  );

  return {
    dryRun,
    articlesScanned: articleRows.length,
    gapsFound,
    gapsInserted,
    gapsSkipped,
    articles,
  };
}

// --- Search + Ingest step -------------------------------------------------

export interface GapSearchResult {
  gapId: string;
  status: "found" | "not_found" | "failed" | "duplicate";
  foundUrl?: string;
  foundTitle?: string;
  rationale?: string;
  duplicateReason?: string;
}

/**
 * Search for a source that corroborates a single gap claim, then enqueue
 * the best match into the Source Vault ingest queue.
 *
 * Duplicate detection: if the found URL is already linked in the article body
 * or already in article_sources, the gap is dismissed as a duplicate instead
 * of creating a redundant row.
 */
export async function searchAndEnqueueGap(
  gapId: string,
): Promise<GapSearchResult> {
  const [gap] = await db
    .select()
    .from(sourceGapsTable)
    .where(eq(sourceGapsTable.id, gapId))
    .limit(1);
  if (!gap) return { gapId, status: "failed" };

  // Load article body for duplicate detection.
  const [article] = await db
    .select({ id: articlesTable.id, body: articlesTable.body })
    .from(articlesTable)
    .where(eq(articlesTable.id, gap.articleId))
    .limit(1);
  const body = (article?.body ?? []) as ArticleBlock[];

  // Build search query from claim + hints.
  const parts: string[] = [gap.claimText];
  if (gap.publicationHint) parts.push(gap.publicationHint);
  if (gap.yearHint) parts.push(String(gap.yearHint));
  const query = parts.join(" ").slice(0, 240);

  // Update status to searching.
  await db
    .update(sourceGapsTable)
    .set({ status: "searching", searchQuery: query, updatedAt: new Date() })
    .where(eq(sourceGapsTable.id, gapId));

  let leads: SearchLead[] = [];
  try {
    leads = await searchWithFallback(query, { maxResults: 5, operation: "sourceGapSearch" });
  } catch (err) {
    logger.warn({ err, gapId }, "searchAndEnqueueGap: perplexity search failed");
    await db
      .update(sourceGapsTable)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(sourceGapsTable.id, gapId));
    return { gapId, status: "failed" };
  }

  // Filter to evidence-tier leads only; pick the first good one.
  const evidenceLeads = leads.filter((l) => l.role === "evidence");
  const best = evidenceLeads[0] ?? leads[0];

  if (!best) {
    await db
      .update(sourceGapsTable)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(sourceGapsTable.id, gapId));
    return { gapId, status: "not_found" };
  }

  // Duplicate detection: is this URL already in the article body?
  if (urlAlreadyLinkedInBody(body, best.url)) {
    await db
      .update(sourceGapsTable)
      .set({
        status: "dismissed",
        dismissReason: "already_linked_in_body",
        foundUrl: best.url,
        foundTitle: best.title,
        updatedAt: new Date(),
      })
      .where(eq(sourceGapsTable.id, gapId));
    return {
      gapId,
      status: "duplicate",
      foundUrl: best.url,
      foundTitle: best.title,
      duplicateReason: "This URL is already cited in the article body.",
    };
  }

  // Duplicate detection: is this URL already in article_sources?
  const [existingSource] = await db
    .select({ id: articleSourcesTable.id })
    .from(articleSourcesTable)
    .where(
      and(
        eq(articleSourcesTable.articleId, gap.articleId),
        eq(articleSourcesTable.url, best.url),
      ),
    )
    .limit(1);

  if (existingSource) {
    await db
      .update(sourceGapsTable)
      .set({
        status: "dismissed",
        dismissReason: "already_in_trust_box",
        foundUrl: best.url,
        foundTitle: best.title,
        updatedAt: new Date(),
      })
      .where(eq(sourceGapsTable.id, gapId));
    return {
      gapId,
      status: "duplicate",
      foundUrl: best.url,
      foundTitle: best.title,
      duplicateReason: "This source is already in the article's trust box.",
    };
  }

  // Enqueue for Source Vault ingestion and only mark "found" after success.
  const rationale = best.snippet || null;
  try {
    await enqueueUrl(best.url, {
      discoveredVia: "article_source_gap_fill",
      leadSnippet: gap.claimText.slice(0, 300),
      beatSlug: null,
      reviveTerminal: false,
    });
    await db
      .update(sourceGapsTable)
      .set({
        status: "found",
        foundUrl: best.url,
        foundTitle: best.title,
        rationale,
        updatedAt: new Date(),
      })
      .where(eq(sourceGapsTable.id, gapId));
    return {
      gapId,
      status: "found",
      foundUrl: best.url,
      foundTitle: best.title,
      rationale: rationale ?? undefined,
    };
  } catch (err) {
    logger.warn({ err, gapId, url: best.url }, "searchAndEnqueueGap: enqueue failed");
    await db
      .update(sourceGapsTable)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(sourceGapsTable.id, gapId));
    return { gapId, status: "failed" };
  }
}

// --- Apply gap fill (weave link + update trust box) -----------------------

export type ApplyGapResult =
  | { applied: true; phrase: string; url: string; title: string | null; rationale: string | null; articleSlug: string }
  | { applied: false; reason: "not_found" | "wrong_status" | "already_linked" | "already_in_trust_box" | "phrase_not_in_body" | "article_not_found" };

/**
 * Weave the found source link into the article body AND add an article_sources
 * row (trust box entry). Idempotent: if the link is already present, returns
 * {applied: false, reason: "already_linked"}.
 *
 * Only acts on gaps with status="found". Marks the gap "ingested" on success.
 */
export async function applyGapFill(gapId: string): Promise<ApplyGapResult> {
  const [gap] = await db
    .select()
    .from(sourceGapsTable)
    .where(eq(sourceGapsTable.id, gapId))
    .limit(1);

  if (!gap) return { applied: false, reason: "not_found" };
  if (gap.status !== "found") return { applied: false, reason: "wrong_status" };
  if (!gap.foundUrl) return { applied: false, reason: "not_found" };

  const url = gap.foundUrl;

  // Load article.
  const [article] = await db
    .select({ id: articlesTable.id, slug: articlesTable.slug, body: articlesTable.body })
    .from(articlesTable)
    .where(eq(articlesTable.id, gap.articleId))
    .limit(1);

  if (!article) return { applied: false, reason: "article_not_found" };

  const body = (article.body ?? []) as ArticleBlock[];

  // Idempotency: is the URL already linked in the body?
  if (urlAlreadyLinkedInBody(body, url)) {
    return { applied: false, reason: "already_linked" };
  }

  // Idempotency: is the URL already in article_sources?
  const [existingSource] = await db
    .select({ id: articleSourcesTable.id })
    .from(articleSourcesTable)
    .where(
      and(
        eq(articleSourcesTable.articleId, gap.articleId),
        eq(articleSourcesTable.url, url),
      ),
    )
    .limit(1);
  if (existingSource) {
    return { applied: false, reason: "already_in_trust_box" };
  }

  // Find the paragraph containing claimText and wrap it.
  let weavedBody: ArticleBlock[] | null = null;
  for (let i = 0; i < body.length; i++) {
    const block = body[i]!;
    if (block.type !== "paragraph" || typeof block.content !== "string") continue;
    if (!block.content.includes(gap.claimText)) continue;
    const wrapped = wrapPhraseAsLink(block.content, gap.claimText, url);
    if (wrapped) {
      weavedBody = body.slice();
      weavedBody[i] = { ...block, content: wrapped };
      break;
    }
  }

  if (!weavedBody) {
    // Claim text no longer present in body (article may have been edited).
    return { applied: false, reason: "phrase_not_in_body" };
  }

  // Classify the source for article_sources.
  const classification = classifySourceRole(url);
  const domain = domainOf(url);

  // Write both the updated body and the article_sources row atomically.
  await db.transaction(async (tx) => {
    await tx
      .update(articlesTable)
      .set({ body: weavedBody, updatedAt: new Date() })
      .where(eq(articlesTable.id, gap.articleId));

    await tx
      .insert(articleSourcesTable)
      .values({
        articleId: gap.articleId,
        url,
        domain: domain || "unknown",
        role: classification.role === "evidence" ? "evidence" : "rejected_junk",
        tier: classification.tier,
        status: "queued",
        anchorText: gap.claimText.slice(0, 500),
        sourceTitle: gap.foundTitle ?? null,
        isIntermediary: isCitationIntermediaryUrl(url),
      })
      .onConflictDoNothing({
        target: [articleSourcesTable.articleId, articleSourcesTable.url],
      });

    await tx
      .update(sourceGapsTable)
      .set({
        status: "ingested",
        weavedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(sourceGapsTable.id, gapId));
  });

  logger.info(
    { gapId, articleId: gap.articleId, url, phrase: gap.claimText.slice(0, 80) },
    "applyGapFill: wove link into article body and updated trust box",
  );

  return {
    applied: true,
    phrase: gap.claimText,
    url,
    title: gap.foundTitle ?? null,
    rationale: gap.rationale ?? null,
    articleSlug: article.slug,
  };
}

// --- List / stats -----------------------------------------------------------

export interface GapListItem {
  id: string;
  articleId: string;
  articleSlug: string;
  articleTitle: string;
  claimText: string;
  contextText: string;
  publicationHint: string | null;
  yearHint: number | null;
  status: string;
  searchQuery: string | null;
  foundUrl: string | null;
  foundTitle: string | null;
  rationale: string | null;
  weavedAt: Date | null;
  createdAt: Date;
}

export async function listSourceGaps(opts: {
  status?: string | null;
  articleId?: string | null;
  limit?: number;
  offset?: number;
} = {}): Promise<{ items: GapListItem[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const whereConditions = [];
  if (opts.status) whereConditions.push(eq(sourceGapsTable.status, opts.status as never));
  if (opts.articleId) whereConditions.push(eq(sourceGapsTable.articleId, opts.articleId));

  const baseWhere = whereConditions.length > 0 ? and(...whereConditions) : undefined;

  const items = await db
    .select({
      id: sourceGapsTable.id,
      articleId: sourceGapsTable.articleId,
      articleSlug: articlesTable.slug,
      articleTitle: articlesTable.title,
      claimText: sourceGapsTable.claimText,
      contextText: sourceGapsTable.contextText,
      publicationHint: sourceGapsTable.publicationHint,
      yearHint: sourceGapsTable.yearHint,
      status: sourceGapsTable.status,
      searchQuery: sourceGapsTable.searchQuery,
      foundUrl: sourceGapsTable.foundUrl,
      foundTitle: sourceGapsTable.foundTitle,
      rationale: sourceGapsTable.rationale,
      weavedAt: sourceGapsTable.weavedAt,
      createdAt: sourceGapsTable.createdAt,
    })
    .from(sourceGapsTable)
    .innerJoin(articlesTable, eq(articlesTable.id, sourceGapsTable.articleId))
    .where(baseWhere)
    .orderBy(desc(sourceGapsTable.createdAt))
    .limit(limit)
    .offset(offset);

  const countRow = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(sourceGapsTable)
    .innerJoin(articlesTable, eq(articlesTable.id, sourceGapsTable.articleId))
    .where(baseWhere)
    .then((rows) => rows[0]);

  return { items, total: countRow?.count ?? 0 };
}

export async function getGapStats(): Promise<{
  total: number;
  pending: number;
  searching: number;
  found: number;
  ingested: number;
  dismissed: number;
  failed: number;
}> {
  const rows = await db
    .select({
      status: sourceGapsTable.status,
      count: sql<number>`count(*)::int`,
    })
    .from(sourceGapsTable)
    .groupBy(sourceGapsTable.status);

  const map = new Map<string, number>();
  for (const r of rows) map.set(r.status, r.count);

  return {
    total: Array.from(map.values()).reduce((a, b) => a + b, 0),
    pending: map.get("pending") ?? 0,
    searching: map.get("searching") ?? 0,
    found: map.get("found") ?? 0,
    ingested: map.get("ingested") ?? 0,
    dismissed: map.get("dismissed") ?? 0,
    failed: map.get("failed") ?? 0,
  };
}

// --- Actions --------------------------------------------------------------

export async function dismissGap(gapId: string, reason?: string): Promise<boolean> {
  const result = await db
    .update(sourceGapsTable)
    .set({ status: "dismissed", dismissReason: reason ?? null, updatedAt: new Date() })
    .where(eq(sourceGapsTable.id, gapId));
  return (result.rowCount ?? 0) > 0;
}

export async function markGapSourced(gapId: string, documentId: string): Promise<boolean> {
  const result = await db
    .update(sourceGapsTable)
    .set({ status: "ingested", sourceDocumentId: documentId, updatedAt: new Date() })
    .where(eq(sourceGapsTable.id, gapId));
  return (result.rowCount ?? 0) > 0;
}

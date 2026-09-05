import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import {
  articlesTable,
  articleSourcesTable,
  authorsTable,
  beatsTable,
  topicIdeasTable,
  trendSignalsTable,
  sourceDocumentsTable,
  sourceIngestQueueTable,
  conceptsTable,
  articleConceptMentionsTable,
  conceptBeatAffinitiesTable,
  type Author,
  type Article,
  type ArticleBlock,
  type SourceLinkInsertionMode,
  type DraftResearchMode,
  type ArticleSourceRole,
  type ArticleSourceStatus,
  type SourceAuthorityTier,
} from "@workspace/db";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, not, sql } from "drizzle-orm";
import { generateArticleDraft, generateIdeasForAuthor, regenerateBlock, insertInternalLinks, insertSourceLinks, generateHooksAndSocialPack, AiFunctionDisabledError } from "./llm";
import { extractCandidateTerms } from "./termExtraction";
import type { GeneratedHookKit, SourceLinkCandidate } from "./llm";
import { semanticSearch, searchLeads } from "./sourceVault";
import { enqueueUrl, drainIngestQueue } from "./sourceIngestQueue";
import { isSourceVaultEnabled } from "./sourceVaultBudget";
import { PerplexityNotConfiguredError } from "./perplexity";
import { researchWithFallback, isResearchCapabilityAvailable } from "./researchFallback";

import { isEmbeddingConfigured } from "./embeddings";
import {
  applyDevSourceLinkGuard,
  devSourceLinkWebSearchAllowed,
  maxSearchQueriesFor,
} from "./sourceLinkPolicy";
import {
  applyDevDraftResearchGuard,
  devDraftWebSearchAllowed,
  maxDraftWebSearchesFor,
  shouldHarvestBeforeHold,
} from "./draftResearchPolicy";
import { isAiFunctionEnabled } from "./aiSettings";
import { BudgetGuard, BudgetExceededError } from "./aiBudget";
import { sendDailyDigest } from "./notifications";
import { readingTimeFromBody, slugify } from "../lib/slug";
import { logger } from "../lib/logger";
import { findOverlappingArticles, renderAvoidList, llmArticleConceptDuplicate, dedupeTitle, checkPublishGateDedupe, type PublishGateVerdict } from "./dedupe";
import { rankCoveringAuthors } from "./authorAssignment";
import { generateAndStoreHeroImage } from "./heroImage";
import { generateAndStoreShareImage, generateAndStoreFeedImage } from "./shareImage";
import { findPublicObject, deletePublicObject, DEFAULT_SHARE_CARD_URL } from "../lib/objectStorage";
import { pingArticleSlugs } from "../lib/indexnow";
import { assignDraftScheduleSlot, nextFreeSlot, reservedSlotKeysForAuthor, pickRotatedWeekday, pickRandomHour, pickRandomDayOfMonth, slotKey, slotMatchesCadence, dayMatchesCadence, MIN_SCHEDULE_LEAD_MS } from "./scheduling";
import { getSiteSettings } from "./siteSettings";
import { autoPostPublished } from "./social";
import { sanitizeCitations, sourceUrlIsReachable, isSearchQueryUrl } from "./citations";
import { normalizeSubBeats } from "./beatAdjacency";
import { extractOutboundLinks, domainOf } from "./backCatalogLinks";
import { routeArticleLinksIntoGraph, repairSourceGraphDrift } from "./backCatalogHarvest";
import { copyVaultCitationMetadata } from "./citationMetadata";
import { generateCitationNotesForArticle } from "./citationNotes";
import { classifySourceRole } from "./sourceAuthority";
import { recordMarker, recordRejected } from "./trendMarkers";
import { acquireJobLock, heartbeatJob, finishJob, getJobState, requestJobCancel, isCancelRequested } from "./jobState";

/**
 * Build the list of beats this author is allowed to publish under: their
 * primary plus any sub-beats. Sub-beat display names are looked up in the
 * existing categories-in-use list; if a sub-beat slug is orphaned (no author
 * currently uses it as their primary), we still include it using the slug as
 * a temporary display name so generated ideas still land on the right beat.
 */
export async function resolveAllowedBeats(author: {
  category: string;
  categorySlug: string;
  subBeats?: string[] | null;
}): Promise<{ category: string; categorySlug: string; slant?: string | null }[]> {
  // Sub-beats are admin-curated and authoritative: honour exactly what the admin
  // assigned (de-duped, primary beat dropped). We no longer adjacency-filter here
  // — the admin's explicit pick wins, so the AI can use every assigned sub-beat.
  const adjacentSubBeats = normalizeSubBeats(author.categorySlug, author.subBeats);
  const wantedSlugs = new Set<string>([author.categorySlug, ...adjacentSubBeats]);
  // Single lookup against the beats master table for canonical names + slants.
  const beatRows = await db
    .select({ slug: beatsTable.slug, name: beatsTable.name, slant: beatsTable.slant })
    .from(beatsTable)
    .where(inArray(beatsTable.slug, Array.from(wantedSlugs)));
  const beatBySlug = new Map(beatRows.map((b) => [b.slug, b]));

  const out: { category: string; categorySlug: string; slant?: string | null }[] = [];
  const primary = beatBySlug.get(author.categorySlug);
  out.push({
    category: primary?.name ?? author.category,
    categorySlug: author.categorySlug,
    slant: primary?.slant ?? null,
  });
  for (const slug of adjacentSubBeats) {
    const meta = beatBySlug.get(slug);
    out.push({ categorySlug: slug, category: meta?.name ?? slug, slant: meta?.slant ?? null });
  }
  return out;
}

/**
 * Resolve an idea/article's secondary-subject beat SLUGS to their display
 * names (Task #258). Used only to widen draft-time Source Vault evidence across
 * all of a cross-sectional item's beats — never for reader-facing placement.
 * Falls back to the slug itself when a beat row is missing.
 */
export async function resolveSecondaryBeatNames(
  slugs: string[] | null | undefined,
): Promise<string[]> {
  const clean = Array.from(new Set((slugs ?? []).filter((s) => typeof s === "string" && s.length > 0)));
  if (clean.length === 0) return [];
  const rows = await db
    .select({ slug: beatsTable.slug, name: beatsTable.name })
    .from(beatsTable)
    .where(inArray(beatsTable.slug, clean));
  const nameBySlug = new Map(rows.map((r) => [r.slug, r.name]));
  return clean.map((s) => nameBySlug.get(s) ?? s);
}

export class DuplicateArticleError extends Error {
  readonly name = "DuplicateArticleError";
  readonly conflictingTitle: string;
  readonly conflictingId: string;
  readonly score: number;
  constructor(message: string, info: { conflictingTitle: string; conflictingId: string; score: number }) {
    super(message);
    this.conflictingTitle = info.conflictingTitle;
    this.conflictingId = info.conflictingId;
    this.score = info.score;
  }
}

/**
 * Thrown when a draft cannot be started because another job has already claimed
 * the idea (its status is `drafting`). Lets callers skip cleanly instead of
 * producing a second, duplicate draft for the same idea.
 */
export class IdeaAlreadyDraftingError extends Error {
  readonly name = "IdeaAlreadyDraftingError";
  readonly ideaId: string;
  constructor(ideaId: string) {
    super(`Idea ${ideaId} is already being drafted.`);
    this.ideaId = ideaId;
  }
}

/**
 * Thrown when a draft is HELD because the Source Vault lacks enough trusted
 * evidence to ground it (Task #233). The idea has been moved to `needs_sources`
 * with an explanatory note — it is "good, but lacks fuel", eligible for a later
 * Source Harvest, and must NOT be treated as a generic draft failure (no
 * "Draft generation failed" note, no revert to `approved`).
 */
export class IdeaHeldNeedsSourcesError extends Error {
  readonly name = "IdeaHeldNeedsSourcesError";
  readonly ideaId: string;
  readonly reason: string;
  constructor(ideaId: string, reason: string) {
    super(`Idea ${ideaId} held for sources: ${reason}`);
    this.ideaId = ideaId;
    this.reason = reason;
  }
}

/**
 * Build a shortlist of existing published articles the draft generator may link
 * to in-body. Biased toward the same beat (most relevant) then filled out with
 * other recent stories so cross-beat connections are still possible. The new
 * article's own source is excluded for continuance ideas.
 */
// Very small stopword set so topical scoring keys off meaningful words, not
// glue. Intentionally tiny — better to keep a borderline word than over-prune.
const LINK_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with", "is", "are", "was",
  "were", "be", "been", "by", "at", "as", "it", "its", "this", "that", "these", "those", "from",
  "how", "why", "what", "when", "where", "who", "your", "you", "we", "our", "my", "i", "do", "does",
  "did", "can", "will", "about", "into", "than", "then", "they", "their", "them", "he", "she", "his",
  "her", "not", "no", "yes", "more", "most", "new", "have", "has", "had", "out", "up", "so", "if",
]);

/** Lowercase content words (length >= 3, non-stopword) for topical overlap. */
function topicTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 3 && !LINK_STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

/**
 * Candidate pool for internal linking. Considers the published, non-quarantined
 * back catalog (up to 1000 rows, effectively the whole catalog at current scale,
 * not just the most-recent slice as before) and ranks by
 * topical relevance to the source article so the LLM is shown targets that
 * actually relate, not just whatever is newest. Scoring: shared content-word
 * count between `relevanceText` (source title + dek/angle) and each candidate's
 * title+dek, plus a small same-category boost, with recency as the final
 * tie-break (rows arrive newest-first). When `relevanceText` is omitted this
 * degrades gracefully to same-category-first, then recency.
 */
async function fetchInternalLinkCandidates(
  categorySlug: string,
  excludeArticleId?: string,
  limit = 20,
  relevanceText?: string,
): Promise<{ title: string; slug: string }[]> {
  const rows = await db
    .select({
      id: articlesTable.id,
      title: articlesTable.title,
      slug: articlesTable.slug,
      categorySlug: articlesTable.categorySlug,
      dek: articlesTable.dek,
    })
    .from(articlesTable)
    .where(and(eq(articlesTable.status, "published"), isNull(articlesTable.quarantinedAt)))
    .orderBy(desc(articlesTable.publishedAt))
    .limit(1000);
  const usable = rows.filter((r) => r.id !== excludeArticleId);
  const queryTokens = relevanceText ? topicTokens(relevanceText) : new Set<string>();
  const scored = usable.map((r, idx) => {
    let score = 0;
    if (queryTokens.size > 0) {
      const candTokens = topicTokens(`${r.title} ${r.dek ?? ""}`);
      for (const t of candTokens) if (queryTokens.has(t)) score += 1;
    }
    // Mild nudge toward same-category targets; never enough to outrank a clearly
    // more on-topic cross-category match.
    if (r.categorySlug === categorySlug) score += 0.5;
    return { r, score, idx };
  });
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored.slice(0, limit).map(({ r }) => ({ title: r.title, slug: r.slug }));
}

// Matches in-body internal links the model embeds as [phrase](/article/<slug>).
const INTERNAL_LINK_RE = /\[([^\]]+)\]\((\/article\/[^\s)]+)\)/g;

/**
 * After generation, drop any internal article link whose target slug isn't in
 * the set of real published slugs we offered (the model can hallucinate a slug).
 * Invalid links are unlinked — the visible phrase is kept, only the broken
 * anchor is removed — so no broken internal links ever ship. External
 * http(s) source links are untouched here (handled by sanitizeCitations).
 */
function sanitizeInternalLinks(body: ArticleBlock[], validSlugs: Set<string>): ArticleBlock[] {
  let dropped = 0;
  const cleaned = body.map((block) => {
    if (block.type !== "paragraph" || typeof block.content !== "string") return block;
    const content = block.content.replace(INTERNAL_LINK_RE, (full, phrase: string, href: string) => {
      const rawSlug = href.replace(/^\/article\//, "").split(/[?#]/)[0] ?? "";
      let slug = rawSlug;
      try {
        slug = decodeURIComponent(rawSlug);
      } catch {
        slug = rawSlug;
      }
      if (validSlugs.has(slug)) return full;
      dropped += 1;
      return phrase;
    });
    return content === block.content ? block : { ...block, content };
  });
  if (dropped > 0) {
    logger.warn({ dropped }, "Unlinked fabricated/unresolvable internal article links from draft");
  }
  return cleaned;
}

/** Remove every in-body internal link, keeping the visible phrase as plain text. */
function stripInternalLinks(content: string): string {
  return content.replace(INTERNAL_LINK_RE, (_full, phrase: string) => phrase);
}

/** Count in-body internal links across all paragraph blocks. */
function countInternalLinks(body: ArticleBlock[]): number {
  let n = 0;
  for (const block of body) {
    if (block.type !== "paragraph" || typeof block.content !== "string") continue;
    const matches = block.content.match(INTERNAL_LINK_RE);
    if (matches) n += matches.length;
  }
  return n;
}

/** Any Markdown link span — internal (/article/…) or external (citation). */
const ANY_MD_LINK_RE = /\[[^\]]*\]\([^)]*\)/g;

/**
 * Wrap the FIRST verbatim occurrence of `phrase` in `paragraph` as an internal
 * Markdown link to `/article/<slug>`, but only where that occurrence sits in
 * ordinary prose — never inside an existing Markdown link (citation or internal).
 * Returns the new paragraph string, or null if no linkable occurrence is found.
 * Because we only ever wrap an existing substring, the surrounding prose cannot
 * change — this is what guarantees the backfill never mangles a published article.
 */
function wrapPhraseAsInternalLink(paragraph: string, phrase: string, slug: string): string | null {
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
      return paragraph.slice(0, at) + `[${needle}](/article/${slug})` + paragraph.slice(end);
    }
    from = at + 1;
  }
  return null;
}

export class BackfillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackfillError";
  }
}

// Per-article link caps. Backfill is idempotent by these caps, NOT by a binary
// "done" flag: a top-up pass adds links only until the article reaches its
// target, then stops, so re-running on an at-target article is a no-op. Keep in
// sync with the mirrored constants in the admin galleries
// (artifacts/site/src/pages/admin/{InternalLinks,SourceLinks}.tsx).
export const INTERNAL_LINK_TARGET = 4;
export const SOURCE_LINK_TARGET = 6;

/**
 * Every currently-valid internal-link TARGET slug: published and not
 * quarantined. This is the authoritative "live" set used both to scrub dead
 * in-body links (any /article/<slug> whose slug isn't here) and to guard the
 * final sanitize so existing valid links to articles outside the 20-candidate
 * slice are never clobbered during an incremental top-up.
 */
async function fetchLivePublishedSlugs(): Promise<Set<string>> {
  const rows = await db
    .select({ slug: articlesTable.slug })
    .from(articlesTable)
    .where(and(eq(articlesTable.status, "published"), isNull(articlesTable.quarantinedAt)));
  return new Set(rows.map((r) => r.slug));
}

/**
 * Unwrap every in-body internal link whose target slug is NOT in `liveSlugs`,
 * keeping the visible anchor phrase as plain text. Pure string work — no LLM.
 * Returns the rewritten body and how many dead links were removed. External
 * (http/https) source links are untouched.
 */
function scrubDeadInternalLinks(
  body: ArticleBlock[],
  liveSlugs: Set<string>,
): { body: ArticleBlock[]; removed: number } {
  const cleaned = sanitizeInternalLinks(body, liveSlugs);
  const removed = countInternalLinks(body) - countInternalLinks(cleaned);
  return { body: cleaned, removed };
}

export type BackfillResult = {
  article: Article;
  linksAdded: number;
  linksRemoved?: number;
  skipped?: "not_published" | "no_candidates" | "no_links_added" | "at_target";
};

/**
 * Admin-triggered, reversible internal-link backfill for a single published
 * article. Re-runs the same contextual-linking pass used at draft time over an
 * existing article's prose, weaving a few links to OTHER real published
 * articles into paragraph text.
 *
 * Incremental / cap-based: this is a TOP-UP, not a replace. Existing valid links
 * are always preserved; we only add links to still-unlinked phrases and only up
 * to {@link INTERNAL_LINK_TARGET}, so re-running an at-target article is a no-op.
 * A single pass does two things in one write: (1) scrub dead links — unwrap any
 * /article/<slug> whose target is no longer a live published article (pure
 * string work, no LLM) — then (2) top up toward the cap.
 *
 * Safety / reversibility:
 *  - Only acts on PUBLISHED articles.
 *  - The LLM is asked to add links WITHOUT rewriting prose; we then verify that
 *    every paragraph is byte-identical once internal links are stripped from
 *    both the original and the model's output. If anything else changed, the
 *    whole run is rejected (BackfillError) and nothing is written.
 *  - The final sanitize uses the FULL live-published slug set (not just the
 *    20-candidate slice), so a top-up can never clobber an existing valid link
 *    to an article that happens to be outside this run's candidates.
 *  - Before the first modification we snapshot the original body into
 *    `internalLinksBackup`, so {@link undoArticleInternalLinks} can restore it.
 *  - If the pass neither adds nor removes a link, nothing is written.
 *
 * @param opts.liveSlugs Pre-computed live-published slug set, passed by the bulk
 *   job so it isn't re-queried per article. Computed on demand when omitted.
 */
export async function backfillArticleInternalLinks(
  articleId: string,
  opts: { liveSlugs?: Set<string> } = {},
): Promise<BackfillResult> {
  const [article] = await db.select().from(articlesTable).where(eq(articlesTable.id, articleId)).limit(1);
  if (!article) throw new BackfillError("Article not found");
  if (article.status !== "published") {
    return { article, linksAdded: 0, skipped: "not_published" };
  }
  const [author] = await db.select().from(authorsTable).where(eq(authorsTable.id, article.authorId)).limit(1);
  if (!author) throw new BackfillError("Author not found");

  const liveSlugs = opts.liveSlugs ?? (await fetchLivePublishedSlugs());
  const originalBody = article.body as ArticleBlock[];

  // STEP 1 — scrub dead links (AI-free): unwrap any /article/<slug> whose target
  // is no longer a live published article. We work off the scrubbed body from
  // here on, so the prose baseline and the link budget both reflect reality.
  const { body: scrubbedBody, removed: linksRemoved } = scrubDeadInternalLinks(originalBody, liveSlugs);

  // Index of each paragraph block so we can stitch the model's output back in.
  const paragraphIndexes: number[] = [];
  const paragraphs: string[] = [];
  scrubbedBody.forEach((block, i) => {
    if (block.type === "paragraph" && typeof block.content === "string") {
      paragraphIndexes.push(i);
      paragraphs.push(block.content);
    }
  });

  // STEP 2 — top up toward the cap. Budget is whatever room remains after the
  // (now all-live) existing links. Already-linked targets are excluded from the
  // candidate pool so a top-up only ever adds links to NEW targets.
  const alreadyLinked = new Set(internalLinkSlugs(scrubbedBody));
  const budget = INTERNAL_LINK_TARGET - alreadyLinked.size;
  const editedParagraphs = paragraphs.slice();
  let applied = 0;
  if (budget > 0 && paragraphs.length > 0) {
    const candidates = (
      await fetchInternalLinkCandidates(article.categorySlug, article.id, 20, `${article.title} ${article.dek}`)
    ).filter((c) => !alreadyLinked.has(c.slug));
    if (candidates.length > 0) {
      const insertions = await insertInternalLinks(author as Author, {
        title: article.title,
        dek: article.dek,
        paragraphs,
        candidates,
        articleId: article.id,
      });
      // Apply each chosen link OURSELVES instead of trusting the model to re-emit
      // the prose. We only ever wrap an existing verbatim phrase in link markup,
      // so the surrounding prose physically cannot change. Cap at the remaining
      // budget and never link the same target twice.
      const validSlugs = new Set(candidates.map((c) => c.slug));
      for (const ins of insertions) {
        if (applied >= budget) break;
        if (!validSlugs.has(ins.slug) || alreadyLinked.has(ins.slug)) continue;
        const current = editedParagraphs[ins.index];
        if (typeof current !== "string") continue;
        const wrapped = wrapPhraseAsInternalLink(current, ins.phrase, ins.slug);
        if (wrapped) {
          editedParagraphs[ins.index] = wrapped;
          alreadyLinked.add(ins.slug);
          applied += 1;
        }
      }
    }
  }

  // Nothing changed (no dead links, already at/over cap or no new fit) → no-op.
  if (linksRemoved === 0 && applied === 0) {
    return { article, linksAdded: 0, linksRemoved: 0, skipped: budget > 0 ? "no_links_added" : "at_target" };
  }

  // Rebuild the body with the (scrubbed + newly linked) paragraph content, then
  // sanitize against the FULL live set so only real published slugs survive as
  // links — never the candidate slice, which would drop existing valid links.
  const rebuilt = scrubbedBody.slice();
  paragraphIndexes.forEach((bodyIdx, k) => {
    rebuilt[bodyIdx] = { ...rebuilt[bodyIdx]!, content: editedParagraphs[k]! } as ArticleBlock;
  });
  const newBody = sanitizeInternalLinks(rebuilt, liveSlugs);

  // Belt-and-suspenders: stripping internal links from the FINAL persisted body
  // must reproduce the prose exactly. Both scrub (unlink only) and top-up (wrap
  // existing substrings only) keep visible text identical, so this compares the
  // final stripped prose to the scrubbed baseline (== original stripped prose).
  for (let k = 0; k < paragraphs.length; k++) {
    const finalBlock = newBody[paragraphIndexes[k]!];
    const finalContent =
      finalBlock && finalBlock.type === "paragraph" && typeof finalBlock.content === "string"
        ? finalBlock.content
        : "";
    if (stripInternalLinks(finalContent) !== stripInternalLinks(paragraphs[k]!)) {
      throw new BackfillError(
        "Internal-link pass altered article prose; refusing to save. No changes were made.",
      );
    }
  }

  // Snapshot the original body the first time we modify this article, so a bad
  // run (or several) can be undone back to the true pre-backfill state.
  const backup = article.internalLinksBackup ?? originalBody;
  const [updated] = await db
    .update(articlesTable)
    .set({
      body: newBody,
      internalLinksBackup: backup,
      readingTimeMinutes: readingTimeFromBody(newBody),
      updatedAt: new Date(),
    })
    .where(eq(articlesTable.id, articleId))
    .returning();
  if (updated?.status === "published") void pingArticleSlugs([updated.slug]);
  logger.info(
    { articleId, slug: article.slug, linksAdded: applied, linksRemoved },
    "Backfilled internal links into published article",
  );
  return { article: updated!, linksAdded: applied, linksRemoved };
}

/**
 * Unwrap every in-body internal link pointing at `slug` across all published
 * articles, keeping the anchor phrase as plain text. Pure string/DB work (no
 * LLM) — used to self-heal inbound links the instant an article is deleted, so
 * the back catalog never serves a /article/<deleted-slug> 404. Returns how many
 * articles were touched and how many links were removed.
 */
export async function scrubInternalLinksToSlug(
  slug: string,
): Promise<{ articlesUpdated: number; linksRemoved: number }> {
  const target = `/article/${slug}`;
  const rows = await db
    .select({ id: articlesTable.id, slug: articlesTable.slug, body: articlesTable.body })
    .from(articlesTable)
    .where(eq(articlesTable.status, "published"));
  let articlesUpdated = 0;
  let linksRemoved = 0;
  const pinged: string[] = [];
  for (const row of rows) {
    const body = row.body as ArticleBlock[];
    let removed = 0;
    const cleaned = body.map((block) => {
      if (block.type !== "paragraph" || typeof block.content !== "string") return block;
      if (!block.content.includes(target)) return block;
      const content = block.content.replace(INTERNAL_LINK_RE, (full, phrase: string, href: string) => {
        const rawSlug = href.replace(/^\/article\//, "").split(/[?#]/)[0] ?? "";
        let s = rawSlug;
        try {
          s = decodeURIComponent(rawSlug);
        } catch {
          s = rawSlug;
        }
        if (s === slug) {
          removed += 1;
          return phrase;
        }
        return full;
      });
      return content === block.content ? block : { ...block, content };
    });
    if (removed === 0) continue;
    await db
      .update(articlesTable)
      .set({ body: cleaned, readingTimeMinutes: readingTimeFromBody(cleaned), updatedAt: new Date() })
      .where(eq(articlesTable.id, row.id));
    articlesUpdated += 1;
    linksRemoved += removed;
    pinged.push(row.slug);
  }
  if (pinged.length) void pingArticleSlugs(pinged);
  if (linksRemoved > 0) {
    logger.info({ deletedSlug: slug, articlesUpdated, linksRemoved }, "Scrubbed inbound internal links to deleted article");
  }
  return { articlesUpdated, linksRemoved };
}

/**
 * Recompute `articleCount` for every concept that was linked to a set of
 * articles.  Must be called after an article is deleted (or its status changes
 * to non-published) so the cached count stays in sync with the live
 * article_concept_mentions rows.
 *
 * IMPORTANT — delete callers: article_concept_mentions rows are cascade-deleted
 * with the article, so querying them AFTER deletion finds nothing. Pass
 * `preloadedConceptIds` (captured before deletion) to bypass the lookup.
 *
 * When both `articleIds` and `preloadedConceptIds` are omitted, the entire
 * concepts table is updated (full sweep).
 */
export async function recalcConceptArticleCounts(
  articleIds?: string[],
  preloadedConceptIds?: string[],
): Promise<{ conceptsUpdated: number }> {
  let conceptsUpdated = 0;

  if (preloadedConceptIds && preloadedConceptIds.length > 0) {
    // Concept IDs were captured before deletion — skip the (now-empty) lookup.
    const ids = preloadedConceptIds;
    await db
      .update(conceptsTable)
      .set({
        articleCount: sql`(
          SELECT COUNT(DISTINCT acm.article_id)
          FROM article_concept_mentions acm
          INNER JOIN articles a ON a.id = acm.article_id AND a.status = 'published'
          WHERE acm.concept_id = ${conceptsTable.id}
        )`,
        updatedAt: new Date(),
      })
      .where(inArray(conceptsTable.id, ids));
    return { conceptsUpdated: ids.length };
  }

  if (articleIds && articleIds.length > 0) {
    // Narrow: only concepts that were linked to the removed articles.
    // NOTE: only safe when mention rows are still present (non-delete callers).
    const conceptRows = await db
      .selectDistinct({ conceptId: articleConceptMentionsTable.conceptId })
      .from(articleConceptMentionsTable)
      .where(inArray(articleConceptMentionsTable.articleId, articleIds));
    const ids = conceptRows.map((r) => r.conceptId);
    if (ids.length === 0) return { conceptsUpdated };
    await db
      .update(conceptsTable)
      .set({
        articleCount: sql`(
          SELECT COUNT(DISTINCT acm.article_id)
          FROM article_concept_mentions acm
          INNER JOIN articles a ON a.id = acm.article_id AND a.status = 'published'
          WHERE acm.concept_id = ${conceptsTable.id}
        )`,
        updatedAt: new Date(),
      })
      .where(inArray(conceptsTable.id, ids));
    conceptsUpdated = ids.length;
  } else {
    // Full sweep — useful for batch / orphaned-row repair.
    const allConcepts = await db.select({ id: conceptsTable.id }).from(conceptsTable);
    if (allConcepts.length === 0) return { conceptsUpdated };
    await db
      .update(conceptsTable)
      .set({
        articleCount: sql`(
          SELECT COUNT(DISTINCT acm.article_id)
          FROM article_concept_mentions acm
          INNER JOIN articles a ON a.id = acm.article_id AND a.status = 'published'
          WHERE acm.concept_id = ${conceptsTable.id}
        )`,
        updatedAt: new Date(),
      })
      .where(inArray(conceptsTable.id, allConcepts.map((c) => c.id)));
    conceptsUpdated = allConcepts.length;
  }

  return { conceptsUpdated };
}

/**
 * Undo a previous internal-link backfill by restoring the snapshot stored in
 * `internalLinksBackup` and clearing it. No-op (restored: false) when there is
 * no snapshot — i.e. the article was never backfilled.
 */
export async function undoArticleInternalLinks(
  articleId: string,
): Promise<{ article: Article; restored: boolean }> {
  const [article] = await db.select().from(articlesTable).where(eq(articlesTable.id, articleId)).limit(1);
  if (!article) throw new BackfillError("Article not found");
  const backup = article.internalLinksBackup as ArticleBlock[] | null;
  if (!backup) return { article, restored: false };
  const [updated] = await db
    .update(articlesTable)
    .set({
      body: backup,
      internalLinksBackup: null,
      readingTimeMinutes: readingTimeFromBody(backup),
      updatedAt: new Date(),
    })
    .where(eq(articlesTable.id, articleId))
    .returning();
  if (updated?.status === "published") void pingArticleSlugs([updated.slug]);
  logger.info({ articleId, slug: article.slug }, "Reverted internal-link backfill to pre-backfill body");
  return { article: updated!, restored: true };
}

// ---------------------------------------------------------------------------
// Internal-link bulk job: live progress + cooperative cancellation. Mirrors the
// share-image job below — an in-process, fire-and-forget backfill (single
// server) whose progress the admin "Internal links" gallery polls, with a
// cancel flag the loop checks between articles so an admin can halt a long run.
// Single-server only — a multi-instance deploy would need shared job state.
// ---------------------------------------------------------------------------
export interface InternalLinkJobState {
  running: boolean;
  total: number;
  processed: number;
  updated: number;
  skipped: number;
  failed: number;
  linksAdded: number;
  linksRemoved: number;
  canceled: boolean;
  startedAt: string | null;
  finishedAt: string | null;
}

let internalLinkJob: InternalLinkJobState = {
  running: false,
  total: 0,
  processed: 0,
  updated: 0,
  skipped: 0,
  failed: 0,
  linksAdded: 0,
  linksRemoved: 0,
  canceled: false,
  startedAt: null,
  finishedAt: null,
};
let internalLinkCancelRequested = false;

/** Snapshot of the current/last internal-link job (safe copy). */
export function getInternalLinkJob(): InternalLinkJobState {
  return { ...internalLinkJob };
}

/** Request cooperative cancellation of a running job. Returns false if idle. */
export function requestInternalLinkJobCancel(): boolean {
  if (!internalLinkJob.running) return false;
  internalLinkCancelRequested = true;
  return true;
}

/**
 * Atomically check-and-start the bulk internal-link job. Returns false if one is
 * already running, so the caller can respond `alreadyRunning` without launching
 * a second loop. Must be called synchronously (the route does) before the async
 * worker runs.
 */
export function beginInternalLinkJob(): boolean {
  if (internalLinkJob.running) return false;
  internalLinkJob = {
    running: true,
    total: 0,
    processed: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    linksAdded: 0,
    linksRemoved: 0,
    canceled: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  internalLinkCancelRequested = false;
  return true;
}

/**
 * Bulk backfill across the whole back catalog: every published article that has
 * NO in-body internal links yet (i.e. predates the draft-time linking feature)
 * gets one pass. Runs sequentially so the LLM isn't hammered, and a single
 * article's failure never aborts the batch. Drives the shared internalLinkJob
 * state so the admin gallery can render live progress, and checks the cancel
 * flag between articles. Call beginInternalLinkJob() first (the route does) to
 * claim the lock. Returns the final job state.
 */
export async function backfillAllInternalLinks(opts: { limit?: number } = {}): Promise<InternalLinkJobState> {
  try {
    const guard = await BudgetGuard.start("internal-link backfill");
    const liveSlugs = await fetchLivePublishedSlugs();
    const rows = await db
      .select({ id: articlesTable.id, body: articlesTable.body })
      .from(articlesTable)
      .where(eq(articlesTable.status, "published"))
      .orderBy(desc(articlesTable.publishedAt));
    // Eligible = below the per-article cap (room for more links) OR carrying any
    // dead link that needs scrubbing. An at-cap, dead-link-free article is left
    // untouched, so re-runs converge and cost no LLM calls on saturated rows.
    const scored = rows
      .map((r) => {
        const slugs = internalLinkSlugs(r.body as ArticleBlock[]);
        // DISTINCT live targets — must match the per-article budget math
        // (budget = TARGET - distinct-live), or an article linking one slug
        // several times would be wrongly treated as at-cap. `dead` counts any
        // link instance whose target isn't live (those all get scrubbed).
        const live = new Set(slugs.filter((s) => liveSlugs.has(s))).size;
        const dead = slugs.filter((s) => !liveSlugs.has(s)).length;
        return { id: r.id, live, dead };
      })
      .filter((r) => r.live < INTERNAL_LINK_TARGET || r.dead > 0);
    // Fewest current (distinct live) links first, so bare/new articles get linked
    // before we top up already-rich ones; rows arrive newest-first, a stable tie.
    scored.sort((a, b) => a.live - b.live);
    let eligible = scored;
    if (opts.limit && opts.limit > 0) eligible = eligible.slice(0, opts.limit);
    internalLinkJob.total = eligible.length;
    for (const row of eligible) {
      // Cooperative cancel: stop cleanly before starting the next article.
      if (internalLinkCancelRequested) {
        internalLinkJob.canceled = true;
        break;
      }
      // Spend guardrail: stop cleanly at the per-run / daily ceiling.
      try {
        await guard.check();
      } catch (e) {
        if (e instanceof BudgetExceededError) {
          internalLinkJob.canceled = true;
          logger.warn({ reason: e.reason, processed: internalLinkJob.processed }, e.message);
          break;
        }
        throw e;
      }
      try {
        const result = await backfillArticleInternalLinks(row.id, { liveSlugs });
        const removed = result.linksRemoved ?? 0;
        if (!result.skipped && (result.linksAdded > 0 || removed > 0)) {
          internalLinkJob.updated += 1;
          internalLinkJob.linksAdded += result.linksAdded;
          internalLinkJob.linksRemoved += removed;
        } else {
          internalLinkJob.skipped += 1;
        }
      } catch (err) {
        internalLinkJob.failed += 1;
        logger.error({ err, articleId: row.id }, "Internal-link backfill failed for article; continuing batch");
      } finally {
        // Count every attempted row so the progress bar advances even on skips.
        internalLinkJob.processed += 1;
      }
    }
    return getInternalLinkJob();
  } catch (e) {
    // A budget stop at start time (bulk disabled / daily cap already hit) ends
    // the job cleanly with nothing processed rather than surfacing an error.
    if (e instanceof BudgetExceededError) {
      internalLinkJob.canceled = true;
      logger.warn({ reason: e.reason }, e.message);
      return getInternalLinkJob();
    }
    throw e;
  } finally {
    internalLinkJob.running = false;
    internalLinkJob.finishedAt = new Date().toISOString();
    internalLinkCancelRequested = false;
  }
}

// ===========================================================================
// SOURCE-LINK BACKFILL (external citations) — mirrors the internal-link backfill
// above. Adds verified external SOURCE/citation links to older published
// articles that predate the draft-time CITATIONS rule. The model only PICKS
// {index, phrase, url}; we wrap verbatim phrases ourselves (no prose rewrite)
// and verify every URL (https + reachable + not a search page) before saving.
// Reversible per-article via a SEPARATE backup column (sourceLinksBackup) so a
// source-link undo never clobbers an internal-link undo.
// ===========================================================================

/** External (http/https) Markdown links — source citations, not /article/ links. */
const EXTERNAL_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

/** Strip EVERY Markdown link (internal or external), keeping the visible phrase. */
function stripAllMarkdownLinks(content: string): string {
  return content.replace(ANY_MD_LINK_RE, (full) => {
    const m = /^\[([^\]]*)\]\([^)]*\)$/.exec(full);
    return m ? m[1]! : full;
  });
}

/** Count external (http/https) source links across all paragraph blocks. */
function countExternalLinks(body: ArticleBlock[]): number {
  let n = 0;
  for (const block of body) {
    if (block.type !== "paragraph" || typeof block.content !== "string") continue;
    const matches = block.content.match(EXTERNAL_LINK_RE);
    if (matches) n += matches.length;
  }
  return n;
}

/**
 * Wrap the FIRST verbatim occurrence of `phrase` in `paragraph` as an external
 * Markdown link to `url`, but only where that occurrence sits in ordinary prose
 * — never inside an existing Markdown link (internal or citation). Returns the
 * new paragraph string, or null if no linkable occurrence is found. Because we
 * only ever wrap an existing substring, the surrounding prose cannot change.
 */
function wrapPhraseAsExternalLink(paragraph: string, phrase: string, url: string): string | null {
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

export type SourceBackfillResult = {
  article: Article;
  linksAdded: number;
  skipped?: "not_published" | "no_paragraphs" | "no_links_added" | "at_target";
};

// Which of the SHARED source-link callers is running (Task #226). All feed
// the same weaveSourceLinksIntoBody → gatherSourceCandidates → insertSourceLinks
// path; origin is threaded only for attribution/auditing.
export type SourceLinkOrigin = "draft_creation" | "admin_backfill" | "admin_redistribute";

/**
 * Resolve the effective source-link insertion mode (Task #226). Reads the
 * admin-configured `sourceLinkInsertionMode` site setting, then applies a DEV
 * MONEY GUARD: in a non-production environment any web-search-capable mode
 * (`vault_first_with_capped_search` / `legacy_web_search`) is downgraded to
 * `vault_only`, so dev cron / pipeline runs never spend on paid source-link web
 * search — unless explicitly opted in via `ALLOW_DEV_SOURCE_LINK_WEB_SEARCH`.
 * Never throws — falls back to the safe prod default on any read failure.
 */
async function resolveSourceLinkMode(): Promise<SourceLinkInsertionMode> {
  let mode: SourceLinkInsertionMode = "vault_first_with_capped_search";
  try {
    mode = (await getSiteSettings()).sourceLinkInsertionMode;
  } catch {
    // fall back to the safe default on any settings read failure
  }
  return applyDevSourceLinkGuard(mode, {
    isProd: process.env.NODE_ENV === "production",
    devWebSearchAllowed: devSourceLinkWebSearchAllowed(process.env.ALLOW_DEV_SOURCE_LINK_WEB_SEARCH),
  });
}

/**
 * Resolve the effective draft research mode (Task #233). Reads the admin-
 * configured `draftResearchMode` site setting, then applies the DEV MONEY GUARD:
 * in a non-production environment the web-search-capable `legacy_web_search`
 * mode is downgraded to `vault_required` so dev cron / pipeline runs never spend
 * on paid draft-time web search — unless explicitly opted in via
 * `ALLOW_DEV_DRAFT_WEB_SEARCH`. Never throws — falls back to the prod default on
 * any read failure.
 */
async function resolveDraftResearchMode(): Promise<DraftResearchMode> {
  let mode: DraftResearchMode = "vault_first_harvest_if_needed";
  try {
    mode = (await getSiteSettings()).draftResearchMode;
  } catch {
    // fall back to the safe default on any settings read failure
  }
  return applyDevDraftResearchGuard(mode, {
    isProd: process.env.NODE_ENV === "production",
    devWebSearchAllowed: devDraftWebSearchAllowed(process.env.ALLOW_DEV_DRAFT_WEB_SEARCH),
  });
}

/** Pool size below which the Perplexity top-up tier kicks in (coverage-gated). */
const SOURCE_POOL_TOPUP_THRESHOLD = 12;

/**
 * Build the vetted source-URL pool (Task #226) in priority order:
 *   1. evidence packet sources (highest authority; vetted at screen time),
 *   2. Source Vault semantic hits (embedded, stored sources),
 *   3. existing BrainHook citations in the same category (already-verified URLs),
 *   4. Sonar gap-fill (only when mode's cap > 0 AND pool is thin): one
 *      Perplexity Sonar call whose citation URLs come EXCLUSIVELY from
 *      res.citations (never model prose). Each URL is enqueued into Source
 *      Vault for background ingestion and added directly to the pool for this
 *      placement pass — no synchronous drain required.
 * Returns the pool plus whether it is packet-backed (which forces the Sonar
 * cap to 0). Never throws — any tier that fails is logged and skipped. Every
 * mode (including legacy_web_search) now builds the vault-first pool; both
 * search-capable modes allow one Sonar gap-fill call.
 */
async function gatherSourceCandidates(
  meta: {
    title: string;
    dek: string;
    category: string;
    evidencePacketId?: string | null;
    packetSources?: SourceLinkCandidate[];
    // Article paragraphs (plain text). When provided, a deterministic
    // term-extraction pass mines them for distinct entities/noun phrases and
    // runs a vault query PER TERM, so the pool covers claims deep in the body
    // instead of only the headline topic (fixes front-loaded citations).
    paragraphs?: string[];
  },
  mode: SourceLinkInsertionMode,
  // Explicit admin override for the Perplexity top-up query cap (e.g. the
  // manual "Add source links" button forces 3; redistribute forces 0).
  searchQueriesOverride?: number,
): Promise<{ sources: SourceLinkCandidate[]; packetBacked: boolean; sonarGapFillRan: boolean }> {
  const byUrl = new Map<string, SourceLinkCandidate>();
  const sources: SourceLinkCandidate[] = [];
  const add = (url: unknown, title: unknown, domain: unknown, paragraphHints?: number[]) => {
    if (typeof url !== "string") return;
    const trimmed = url.trim();
    if (!trimmed) return;
    let host: string;
    try {
      const u = new URL(trimmed);
      if (u.protocol !== "https:" && u.protocol !== "http:") return;
      host = u.hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return;
    }
    const existing = byUrl.get(trimmed);
    if (existing) {
      // Merge paragraph hints into an already-pooled candidate.
      if (paragraphHints && paragraphHints.length > 0) {
        const merged = new Set([...(existing.paragraphHints ?? []), ...paragraphHints]);
        existing.paragraphHints = [...merged].sort((a, b) => a - b);
      }
      return;
    }
    const candidate: SourceLinkCandidate = {
      url: trimmed,
      title: typeof title === "string" ? title : null,
      domain: typeof domain === "string" && domain ? domain : host,
      ...(paragraphHints && paragraphHints.length > 0
        ? { paragraphHints: [...new Set(paragraphHints)].sort((a, b) => a - b) }
        : {}),
    };
    byUrl.set(trimmed, candidate);
    sources.push(candidate);
  };

  // 1. Evidence packet sources.
  let packetSources = meta.packetSources;
  if ((!packetSources || packetSources.length === 0) && meta.evidencePacketId) {
    try {
      const { getPacket } = await import("./editorialScreen");
      const packet = await getPacket(meta.evidencePacketId);
      if (packet) {
        packetSources = packet.sources.map((s) => ({ url: s.url, title: s.title, domain: s.domain }));
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), packetId: meta.evidencePacketId },
        "Source-link pool: evidence packet load failed; continuing without packet sources",
      );
    }
  }
  const packetBacked = !!packetSources && packetSources.length > 0;
  if (packetSources) for (const s of packetSources) add(s.url, s.title, s.domain);

  // 2. Source Vault semantic retrieval — headline query first.
  try {
    if (isEmbeddingConfigured()) {
      const hits = await semanticSearch(`${meta.title} ${meta.dek}`.trim(), { limit: 12 });
      for (const h of hits) add(h.document.url, h.document.title, h.document.domain);
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Source-link pool: Source Vault retrieval failed; continuing without vault sources",
    );
  }

  // 2b. Term-extraction pass (no LLM): mine the body for distinct entities /
  // noun phrases and query the vault per term, tagging each hit with the
  // paragraph(s) the term came from. This is what lets the model cite claims
  // in the middle/late article instead of front-loading around the headline.
  // Local embeddings make these extra queries effectively free.
  try {
    if (isEmbeddingConfigured() && meta.paragraphs && meta.paragraphs.length > 0) {
      const terms = extractCandidateTerms(meta.paragraphs, { max: 6 });
      const results = await Promise.allSettled(
        terms.map(async (t) => ({
          term: t,
          hits: await semanticSearch(t.term, { limit: 3 }),
        })),
      );
      for (const r of results) {
        if (r.status !== "fulfilled") {
          logger.warn(
            { err: r.reason instanceof Error ? r.reason.message : String(r.reason) },
            "Source-link pool: per-term vault query failed; continuing",
          );
          continue;
        }
        for (const h of r.value.hits) {
          add(h.document.url, h.document.title, h.document.domain, r.value.term.paragraphIndexes);
        }
      }
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Source-link pool: term-extraction pass failed; continuing without per-term sources",
    );
  }

  // 3. Existing BrainHook citations from same-category published articles.
  try {
    const rows = await db
      .select({ body: articlesTable.body })
      .from(articlesTable)
      .where(and(eq(articlesTable.status, "published"), eq(articlesTable.category, meta.category)))
      .orderBy(desc(articlesTable.publishedAt))
      .limit(40);
    outer: for (const row of rows) {
      for (const block of row.body as ArticleBlock[]) {
        if (block.type !== "paragraph" || typeof block.content !== "string") continue;
        for (const m of block.content.matchAll(EXTERNAL_LINK_RE)) {
          const url = m[2];
          if (url && !isSearchQueryUrl(url)) add(url, null, null);
          if (sources.length >= 24) break outer;
        }
      }
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Source-link pool: existing-citation gather failed; continuing",
    );
  }

  // 4. Sonar gap-fill — when the pool is thin after vault/packet/catalog gather,
  // run a single Perplexity Sonar call to surface additional citable URLs.
  // Citation URLs come EXCLUSIVELY from res.citations (Sonar's structured
  // top-level field) — res.content (model prose) is never read. Each citation
  // URL is enqueued for background Source Vault ingestion (fire-and-forget) and
  // also added directly to the candidate pool for this placement pass. Fail
  // closed: any error leaves the pool as-is (vault/packet sources still usable).
  let sonarGapFillRan = false;
  const sonarEnabled =
    Math.max(0, Math.floor(searchQueriesOverride ?? maxSearchQueriesFor(mode, packetBacked))) > 0;
  if (
    sonarEnabled &&
    sources.length < SOURCE_POOL_TOPUP_THRESHOLD &&
    (await isResearchCapabilityAvailable())
  ) {
    try {
      const paragraphSummary = (meta.paragraphs ?? [])
        .slice(0, 3)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500);
      const system =
        "You are a research assistant helping a journalist find citable web sources for an article. Return a brief answer; the caller only uses your citation URLs.";
      const user =
        `Find citable web sources for this article:\n\nTitle: ${meta.title}\nSubhead: ${meta.dek}${paragraphSummary ? `\n\nOpening: ${paragraphSummary}` : ""}`.slice(
          0,
          2000,
        );
      const res = await researchWithFallback(system, user, {
        maxTokens: 256,
        operation: "sourceLinkGapFill",
      });
      sonarGapFillRan = true;
      let sonarAdded = 0;
      for (const citationUrl of res.citations) {
        if (!citationUrl) continue;
        const beforeLen = sources.length;
        add(citationUrl, null, null);
        if (sources.length > beforeLen) {
          sonarAdded += 1;
          // Enqueue for background vault ingestion — fire-and-forget, no drain.
          // reviveTerminal=false so an already-processed URL is never reset.
          void enqueueUrl(citationUrl, {
            discoveredVia: "article_source_gap_fill",
            beatSlug: meta.category ?? null,
            reviveTerminal: false,
          }).catch((err) =>
            logger.warn(
              { err: err instanceof Error ? err.message : String(err), url: citationUrl },
              "Source-link pool: gap-fill enqueue failed",
            ),
          );
        }
      }
      logger.info(
        {
          citations: res.citations.length,
          sonarAdded,
          poolAfter: sources.length,
          mode,
        },
        "Source-link pool: Sonar gap-fill complete",
      );
    } catch (err) {
      if (err instanceof PerplexityNotConfiguredError) {
        logger.info("Source-link pool: Perplexity not configured; skipping Sonar gap-fill");
      } else {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "Source-link pool: Sonar gap-fill failed; continuing with existing pool",
        );
      }
    }
  }

  return { sources: sources.slice(0, 24), packetBacked, sonarGapFillRan };
}

/**
 * Shared SOURCE-link weaving core, used by BOTH the draft pipeline (woven in at
 * creation time) and the admin "Add source links" failsafe (top-up on older
 * articles). Asks the model for {index, phrase, url} citations, verifies each URL
 * server-side (https + not a search page + confidently reachable), then wraps up
 * to `budget` verified phrases by EXACT substring match so prose can never drift.
 * Returns the (possibly unchanged) body plus how many links were added.
 *
 * It never rewrites prose; the belt-and-suspenders check below guarantees that
 * stripping all Markdown links from the result reproduces the original prose, and
 * throws {@link BackfillError} if anything else changed (so a bug can never
 * corrupt an article — callers treat the throw as "make no change").
 */
async function weaveSourceLinksIntoBody(
  body: ArticleBlock[],
  author: Author,
  meta: {
    title: string;
    dek: string;
    category: string;
    articleId?: string | null;
    // Task #226: which shared caller this is, plus packet/cluster attribution and
    // any already-loaded packet sources, so the mode-aware vault-first pool can
    // be built identically for both callers.
    origin: SourceLinkOrigin;
    evidencePacketId?: string | null;
    clusterId?: string | null;
    packetSources?: SourceLinkCandidate[];
    // When set by an explicit admin action (e.g. the "Add source links" button),
    // overrides the mode-derived Perplexity top-up query cap so the manual
    // trigger always has full discovery capability regardless of site settings
    // or the dev guard. 0 disables discovery entirely (redistribute).
    searchQueriesOverride?: number;
  },
  budget: number,
): Promise<{ body: ArticleBlock[]; linksAdded: number }> {
  if (budget <= 0) return { body, linksAdded: 0 };

  const paragraphIndexes: number[] = [];
  const paragraphs: string[] = [];
  body.forEach((block, i) => {
    if (block.type === "paragraph" && typeof block.content === "string") {
      paragraphIndexes.push(i);
      paragraphs.push(block.content);
    }
  });
  if (paragraphs.length === 0) return { body, linksAdded: 0 };

  // Resolve the mode-aware, vault-first strategy ONCE here so BOTH callers (draft
  // creation + admin/backfill) share identical behavior (Task #226).
  const mode = await resolveSourceLinkMode();
  if (mode === "off") return { body, linksAdded: 0 };
  // Any gap discovery (Perplexity → Vault ingestion) happens INSIDE the pool
  // gather; the citation-picking model below never searches the web and may
  // only cite pool URLs (enforced server-side in insertSourceLinks).
  const { sources, sonarGapFillRan } = await gatherSourceCandidates(
    { ...meta, paragraphs },
    mode,
    meta.searchQueriesOverride,
  );

  const insertions = await insertSourceLinks(author, {
    title: meta.title,
    dek: meta.dek,
    category: meta.category,
    paragraphs,
    articleId: meta.articleId,
    evidencePacketId: meta.evidencePacketId,
    clusterId: meta.clusterId,
    candidateSources: sources,
    mode,
    sonarGapFillRan,
  });
  if (insertions.length === 0) return { body, linksAdded: 0 };

  // Verify each candidate URL concurrently — https + not-a-search-page +
  // confidently reachable. Only verified URLs are eligible for wrapping.
  const verified = new Set<string>();
  await Promise.all(
    Array.from(new Set(insertions.map((i) => i.url))).map(async (url) => {
      if (isSearchQueryUrl(url)) return;
      try {
        if (await sourceUrlIsReachable(url)) verified.add(url);
      } catch {
        // any error → treat as unverified (drop the link)
      }
    }),
  );

  // Apply each verified link OURSELVES by exact substring match, so prose can
  // never drift. Insertions whose phrase isn't found verbatim (or sits inside an
  // existing link) are skipped.
  const editedParagraphs = paragraphs.slice();
  const linkedUrls = new Set<string>();
  const rejected: Array<{ index: number; phrase: string; reason: string }> = [];
  let applied = 0;
  for (const ins of insertions) {
    if (applied >= budget) break;
    if (!verified.has(ins.url) || linkedUrls.has(ins.url)) {
      rejected.push({
        index: ins.index,
        phrase: ins.phrase.slice(0, 80),
        reason: linkedUrls.has(ins.url) ? "url_already_linked" : "url_unverified",
      });
      continue;
    }
    const current = editedParagraphs[ins.index];
    if (typeof current !== "string") {
      rejected.push({ index: ins.index, phrase: ins.phrase.slice(0, 80), reason: "bad_index" });
      continue;
    }
    const wrapped = wrapPhraseAsExternalLink(current, ins.phrase, ins.url);
    if (wrapped) {
      editedParagraphs[ins.index] = wrapped;
      linkedUrls.add(ins.url);
      applied += 1;
    } else {
      rejected.push({ index: ins.index, phrase: ins.phrase.slice(0, 80), reason: "phrase_not_found" });
    }
  }
  logger.info(
    {
      articleId: meta.articleId,
      origin: meta.origin,
      insertions: insertions.length,
      uniqueUrls: new Set(insertions.map((i) => i.url)).size,
      verified: verified.size,
      applied,
      budget,
      ...(rejected.length > 0 ? { rejected } : {}),
    },
    "Source-link weave: apply summary",
  );
  if (applied === 0) return { body, linksAdded: 0 };

  const newBody = body.slice();
  paragraphIndexes.forEach((bodyIdx, k) => {
    newBody[bodyIdx] = { ...newBody[bodyIdx]!, content: editedParagraphs[k]! } as ArticleBlock;
  });

  // Belt-and-suspenders: stripping ALL Markdown links from the FINAL body must
  // reproduce the original prose exactly (we only inserted link markup).
  for (let k = 0; k < paragraphs.length; k++) {
    const finalBlock = newBody[paragraphIndexes[k]!];
    const finalContent =
      finalBlock && finalBlock.type === "paragraph" && typeof finalBlock.content === "string"
        ? finalBlock.content
        : "";
    if (stripAllMarkdownLinks(finalContent) !== stripAllMarkdownLinks(paragraphs[k]!)) {
      throw new BackfillError(
        "Source-link pass altered article prose; refusing to save. No changes were made.",
      );
    }
  }

  const linksAdded = countExternalLinks(newBody) - countExternalLinks(body);
  if (linksAdded <= 0) return { body, linksAdded: 0 };
  return { body: newBody, linksAdded };
}

/**
 * Admin-triggered, reversible SOURCE-link (external citation) backfill for a
 * single published article. Runs the same web-search-grounded citation pass used
 * at draft time over an existing article's prose, weaving in a few links to real,
 * verifiable external sources.
 *
 * Safety / reversibility:
 *  - Only acts on PUBLISHED articles.
 *  - The LLM only PICKS {index, phrase, url}; it never rewrites prose. We wrap the
 *    verbatim phrase ourselves, so the surrounding prose physically cannot change.
 *  - Every model-supplied URL is verified server-side before use: it must be a
 *    syntactically-valid https URL, not a search-query results page, and
 *    confidently reachable ({@link sourceUrlIsReachable}). This is what enforces
 *    "only link a source when it can be found with high confidence" — fabricated,
 *    dead, or search-page URLs are dropped.
 *  - Belt-and-suspenders: stripping ALL Markdown links from the final body must
 *    reproduce the original prose exactly; if anything else changed the whole run
 *    is rejected (BackfillError) and nothing is written.
 *  - Before the first modification we snapshot the original body into
 *    `sourceLinksBackup` (separate from internalLinksBackup), so
 *    {@link undoArticleSourceLinks} can restore it.
 *  - If the pass adds zero verified links, nothing is written (no_links_added).
 */
export async function backfillArticleSourceLinks(articleId: string): Promise<SourceBackfillResult> {
  const [article] = await db.select().from(articlesTable).where(eq(articlesTable.id, articleId)).limit(1);
  if (!article) throw new BackfillError("Article not found");
  if (article.status !== "published") {
    return { article, linksAdded: 0, skipped: "not_published" };
  }
  const [author] = await db.select().from(authorsTable).where(eq(authorsTable.id, article.authorId)).limit(1);
  if (!author) throw new BackfillError("Author not found");

  const originalBody = article.body as ArticleBlock[];

  // Cap-based top-up: only add links until the article reaches SOURCE_LINK_TARGET.
  // Existing source links are always preserved (we only wrap new phrases), so an
  // at-target article is a no-op and re-runs converge without extra web searches.
  const budget = SOURCE_LINK_TARGET - countExternalLinks(originalBody);
  if (budget <= 0) {
    // Even with nothing to add, reconcile the source graph with the current
    // body (repairs drift from links woven after the one-time harvest), so the
    // admin button doubles as a References-box repair tool.
    void routeBackfilledLinks(articleId, originalBody, article.categorySlug || null);
    return { article, linksAdded: 0, skipped: "at_target" };
  }

  const hasParagraph = originalBody.some(
    (b) => b.type === "paragraph" && typeof b.content === "string",
  );
  if (!hasParagraph) {
    return { article, linksAdded: 0, skipped: "no_paragraphs" };
  }

  const { body: newBody, linksAdded } = await weaveSourceLinksIntoBody(
    originalBody,
    author as Author,
    {
      title: article.title,
      dek: article.dek,
      category: article.category,
      articleId: article.id,
      origin: "admin_backfill",
      evidencePacketId: article.evidencePacketId,
      clusterId: article.clusterId,
      // Admin manual trigger always gets 3 Perplexity top-up queries regardless
      // of site mode or the dev guard — the user explicitly asked for sources.
      searchQueriesOverride: 3,
    },
    budget,
  );
  if (linksAdded <= 0) {
    void routeBackfilledLinks(articleId, originalBody, article.categorySlug || null);
    return { article, linksAdded: 0, skipped: "no_links_added" };
  }

  // Snapshot the original body the first time we modify this article (separate
  // column from internalLinksBackup) so the run can be undone cleanly.
  const backup = article.sourceLinksBackup ?? originalBody;
  const [updated] = await db
    .update(articlesTable)
    .set({
      body: newBody,
      sourceLinksBackup: backup,
      readingTimeMinutes: readingTimeFromBody(newBody),
      updatedAt: new Date(),
    })
    .where(eq(articlesTable.id, articleId))
    .returning();
  if (updated?.status === "published") void pingArticleSlugs([updated.slug]);
  logger.info({ articleId, slug: article.slug, linksAdded }, "Backfilled source links into published article");
  // Route the newly-woven links into the article_sources graph so the public
  // References/trust box learns about them (historically the backfill only
  // rewrote the body, leaving the graph — and thus the trust box — stale).
  void routeBackfilledLinks(articleId, newBody, article.categorySlug || null);
  return { article: updated!, linksAdded };
}

/**
 * Fire-and-forget follow-up to a source-link backfill: route the body's
 * outbound links into the source graph (article_sources + vault queue), then
 * top up citation metadata + notes — the same follow-up the post-draft hook
 * runs. Best-effort; never throws.
 */
async function routeBackfilledLinks(
  articleId: string,
  body: ArticleBlock[],
  beatSlug: string | null,
): Promise<void> {
  try {
    const routed = await routeArticleLinksIntoGraph(articleId, body, beatSlug);
    if (routed.linksFound === 0 || routed.routed === 0) return;
    await copyVaultCitationMetadata();
    try {
      await generateCitationNotesForArticle(articleId);
    } catch (err) {
      if (err instanceof AiFunctionDisabledError) {
        logger.info({ articleId }, "source-link backfill: citation notes paused — skipped");
      } else {
        logger.warn({ err, articleId }, "source-link backfill: citation notes failed");
      }
    }
  } catch (err) {
    logger.warn({ err, articleId }, "source-link backfill: source-graph routing failed");
  }
}

/**
 * Undo a previous source-link backfill by restoring the snapshot stored in
 * `sourceLinksBackup` and clearing it. No-op (restored: false) when there is no
 * snapshot — i.e. the article was never source-link backfilled.
 */
export async function undoArticleSourceLinks(
  articleId: string,
): Promise<{ article: Article; restored: boolean }> {
  const [article] = await db.select().from(articlesTable).where(eq(articlesTable.id, articleId)).limit(1);
  if (!article) throw new BackfillError("Article not found");
  const backup = article.sourceLinksBackup as ArticleBlock[] | null;
  if (!backup) return { article, restored: false };
  const [updated] = await db
    .update(articlesTable)
    .set({
      body: backup,
      sourceLinksBackup: null,
      readingTimeMinutes: readingTimeFromBody(backup),
      updatedAt: new Date(),
    })
    .where(eq(articlesTable.id, articleId))
    .returning();
  if (updated?.status === "published") void pingArticleSlugs([updated.slug]);
  logger.info({ articleId, slug: article.slug }, "Reverted source-link backfill to pre-backfill body");
  return { article: updated!, restored: true };
}

// ---------------------------------------------------------------------------
// Source-link bulk job: live progress + cooperative cancellation. Mirrors the
// internal-link job above — an in-process, fire-and-forget backfill (single
// server) whose progress the admin "Source links" gallery polls, with a cancel
// flag the loop checks between articles. Single-server only.
// ---------------------------------------------------------------------------
export interface SourceLinkJobState {
  running: boolean;
  // Which flavor of bulk source-link job this state describes: "backfill" tops
  // up under-target articles; "redistribute" re-places existing front-loaded
  // citations across the whole body. They share one state/lock so they can
  // never run concurrently (both rewrite article bodies).
  mode: "backfill" | "redistribute" | null;
  total: number;
  processed: number;
  updated: number;
  skipped: number;
  failed: number;
  linksAdded: number;
  canceled: boolean;
  startedAt: string | null;
  finishedAt: string | null;
}

let sourceLinkJob: SourceLinkJobState = {
  running: false,
  mode: null,
  total: 0,
  processed: 0,
  updated: 0,
  skipped: 0,
  failed: 0,
  linksAdded: 0,
  canceled: false,
  startedAt: null,
  finishedAt: null,
};
let sourceLinkCancelRequested = false;

/** Snapshot of the current/last source-link job (safe copy). */
export function getSourceLinkJob(): SourceLinkJobState {
  return { ...sourceLinkJob };
}

/** Request cooperative cancellation of a running source-link job. False if idle. */
export function requestSourceLinkJobCancel(): boolean {
  if (!sourceLinkJob.running) return false;
  sourceLinkCancelRequested = true;
  return true;
}

/**
 * Atomically check-and-start the bulk source-link job. Returns false if one is
 * already running, so the caller can respond `alreadyRunning` without launching
 * a second loop. Must be called synchronously (the route does) before the async
 * worker runs.
 */
export function beginSourceLinkJob(mode: "backfill" | "redistribute" = "backfill"): boolean {
  if (sourceLinkJob.running) return false;
  sourceLinkJob = {
    running: true,
    mode,
    total: 0,
    processed: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    linksAdded: 0,
    canceled: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  sourceLinkCancelRequested = false;
  return true;
}

/**
 * Bulk source-link backfill across the back catalog: every published article
 * that has NO external source links yet gets one web-search-grounded pass. Runs
 * sequentially so the LLM/web-search isn't hammered, and a single article's
 * failure never aborts the batch. Drives the shared sourceLinkJob state so the
 * admin gallery can render live progress, and checks the cancel flag between
 * articles. Call beginSourceLinkJob() first (the route does) to claim the lock.
 * Eligibility is cap-based: any published article BELOW SOURCE_LINK_TARGET gets a
 * top-up pass, processed fewest-sources-first, so a re-run converges and skips
 * articles already at the cap.
 */
export async function backfillAllSourceLinks(opts: { limit?: number } = {}): Promise<SourceLinkJobState> {
  try {
    const guard = await BudgetGuard.start("source-link backfill");
    const rows = await db
      .select({ id: articlesTable.id, body: articlesTable.body })
      .from(articlesTable)
      .where(eq(articlesTable.status, "published"))
      .orderBy(desc(articlesTable.publishedAt));
    const scored = rows
      .map((r) => ({ id: r.id, count: countExternalLinks(r.body as ArticleBlock[]) }))
      .filter((r) => r.count < SOURCE_LINK_TARGET);
    // Fewest current sources first, so bare articles get cited before topping up.
    scored.sort((a, b) => a.count - b.count);
    let eligible = scored;
    if (opts.limit && opts.limit > 0) eligible = eligible.slice(0, opts.limit);
    sourceLinkJob.total = eligible.length;
    for (const row of eligible) {
      if (sourceLinkCancelRequested) {
        sourceLinkJob.canceled = true;
        break;
      }
      // Spend guardrail: stop cleanly at the per-run / daily ceiling.
      try {
        await guard.check();
      } catch (e) {
        if (e instanceof BudgetExceededError) {
          sourceLinkJob.canceled = true;
          logger.warn({ reason: e.reason, processed: sourceLinkJob.processed }, e.message);
          break;
        }
        throw e;
      }
      try {
        const result = await backfillArticleSourceLinks(row.id);
        if (!result.skipped && result.linksAdded > 0) {
          sourceLinkJob.updated += 1;
          sourceLinkJob.linksAdded += result.linksAdded;
        } else {
          sourceLinkJob.skipped += 1;
        }
      } catch (err) {
        sourceLinkJob.failed += 1;
        logger.error({ err, articleId: row.id }, "Source-link backfill failed for article; continuing batch");
      } finally {
        sourceLinkJob.processed += 1;
      }
    }
    return getSourceLinkJob();
  } catch (e) {
    // A budget stop at start time (bulk disabled / daily cap already hit) ends
    // the job cleanly with nothing processed rather than surfacing an error.
    if (e instanceof BudgetExceededError) {
      sourceLinkJob.canceled = true;
      logger.warn({ reason: e.reason }, e.message);
      return getSourceLinkJob();
    }
    throw e;
  } finally {
    sourceLinkJob.running = false;
    sourceLinkJob.finishedAt = new Date().toISOString();
    sourceLinkCancelRequested = false;
  }
}

/**
 * Strip EVERY non-search external source link from a body, keeping the visible
 * anchor phrase, and collect the removed URLs in document order (deduped).
 * Search-query links are also stripped but NOT collected (they were never real
 * sources). Internal links are untouched. Used by the redistribute pass, which
 * unpins existing citations and re-places the same URLs across the whole body.
 */
function stripExternalSourceLinksFromBody(body: ArticleBlock[]): {
  body: ArticleBlock[];
  urls: string[];
  /** Original anchor location per unique URL, for lossless restore. */
  stripped: Array<{ blockIndex: number; phrase: string; url: string }>;
} {
  const urls: string[] = [];
  const stripped: Array<{ blockIndex: number; phrase: string; url: string }> = [];
  const seen = new Set<string>();
  const out = body.map((block, blockIndex) => {
    if (block.type !== "paragraph" || typeof block.content !== "string") return block;
    const next = block.content.replace(EXTERNAL_LINK_RE, (_full, phrase: string, url: string) => {
      if (!isSearchQueryUrl(url) && !seen.has(url)) {
        seen.add(url);
        urls.push(url);
        stripped.push({ blockIndex, phrase, url });
      }
      return phrase;
    });
    return next === block.content ? block : { ...block, content: next };
  });
  return { body: out, urls, stripped };
}

/**
 * Front-loaded-citation detector for the bulk redistribute pass. True when the
 * article has enough prose to be worth spreading over (≥6 paragraphs), at least
 * 2 external links, and EVERY external link sits in the first third of the
 * paragraph blocks — the "all citations crammed at the top" shape the
 * redistribute job exists to fix.
 */
function hasFrontLoadedSourceLinks(body: ArticleBlock[]): boolean {
  const linkedOrdinals: number[] = [];
  let ordinal = 0;
  let links = 0;
  for (const block of body) {
    if (block.type !== "paragraph" || typeof block.content !== "string") continue;
    for (const m of block.content.matchAll(EXTERNAL_LINK_RE)) {
      const url = m[2];
      if (url && !isSearchQueryUrl(url)) {
        links += 1;
        linkedOrdinals.push(ordinal);
      }
    }
    ordinal += 1;
  }
  if (ordinal < 6 || links < 2) return false;
  const deepest = Math.max(...linkedOrdinals);
  return deepest < ordinal / 3;
}

export type SourceRedistributeResult = {
  article: Article;
  linksRemoved: number;
  linksAdded: number;
  skipped?: "not_published" | "no_links" | "no_paragraphs" | "insufficient_replacement";
};

/**
 * Redistribute an article's EXISTING external citations across the whole body.
 * Strips every current source link (keeping the prose), then re-runs the shared
 * weave pass with the stripped URLs as the highest-priority candidates and web
 * search forced to 0 — so no new spend on discovery; the model only re-places
 * known-good URLs (plus free vault candidates) guided by the term-extraction
 * paragraph hints and the distribution prompt rule.
 *
 * Safety:
 *  - LOSSLESS per unique URL: every stripped URL must end up in the final body
 *    — either re-placed by the model or restored at its original anchor phrase.
 *    If even one source would be lost, the original body is kept untouched.
 *    Duplicate anchors of the SAME URL are intentionally collapsed to one link
 *    (matching the weave's one-link-per-URL rule); the count of distinct cited
 *    sources can never shrink.
 *  - Same belt-and-suspenders prose check as every weave (throws → no change).
 *  - Reversible: snapshots into sourceLinksBackup (same undo as the backfill).
 */
export async function redistributeArticleSourceLinks(
  articleId: string,
): Promise<SourceRedistributeResult> {
  const [article] = await db.select().from(articlesTable).where(eq(articlesTable.id, articleId)).limit(1);
  if (!article) throw new BackfillError("Article not found");
  if (article.status !== "published") {
    return { article, linksRemoved: 0, linksAdded: 0, skipped: "not_published" };
  }
  const [author] = await db.select().from(authorsTable).where(eq(authorsTable.id, article.authorId)).limit(1);
  if (!author) throw new BackfillError("Author not found");

  const originalBody = article.body as ArticleBlock[];
  const hasParagraph = originalBody.some(
    (b) => b.type === "paragraph" && typeof b.content === "string",
  );
  if (!hasParagraph) {
    return { article, linksRemoved: 0, linksAdded: 0, skipped: "no_paragraphs" };
  }

  const { body: strippedBody, urls, stripped } = stripExternalSourceLinksFromBody(originalBody);
  if (urls.length === 0) {
    return { article, linksRemoved: 0, linksAdded: 0, skipped: "no_links" };
  }

  const budget = Math.min(urls.length, SOURCE_LINK_TARGET);
  const woven = await weaveSourceLinksIntoBody(
    strippedBody,
    author as Author,
    {
      title: article.title,
      dek: article.dek,
      category: article.category,
      articleId: article.id,
      origin: "admin_redistribute",
      evidencePacketId: article.evidencePacketId,
      clusterId: article.clusterId,
      // The article's own (already-verified) URLs become the top-priority
      // candidate pool; title/domain are re-derived from the URL.
      packetSources: urls.map((u) => ({ url: u, title: null, domain: "" })),
      // Never discover during a redistribute — this pass re-places known
      // URLs, it does not search for new ones.
      searchQueriesOverride: 0,
    },
    budget,
  );

  if (woven.linksAdded === 0) {
    logger.info(
      { articleId, slug: article.slug, removed: urls.length, rePlaced: 0 },
      "Redistribute: nothing re-placed; keeping original body",
    );
    return {
      article,
      linksRemoved: urls.length,
      linksAdded: 0,
      skipped: "insufficient_replacement",
    };
  }

  // LOSSLESS GUARANTEE: any stripped URL the model did not re-place is restored
  // at its ORIGINAL anchor phrase (the phrase is plain prose in the woven body,
  // since we stripped its link markup). If even one URL can neither be re-placed
  // nor restored, make no change at all — a redistribute must never lose a
  // citation.
  const finalBody = woven.body.slice();
  const placedUrls = new Set<string>();
  for (const block of finalBody) {
    if (block.type !== "paragraph" || typeof block.content !== "string") continue;
    for (const m of block.content.matchAll(EXTERNAL_LINK_RE)) {
      if (m[2]) placedUrls.add(m[2]);
    }
  }
  let restored = 0;
  for (const s of stripped) {
    if (placedUrls.has(s.url)) continue;
    let done = false;
    // Try the original block first, then every other paragraph block.
    const tryBlocks = [s.blockIndex, ...finalBody.keys()];
    for (const bi of tryBlocks) {
      const block = finalBody[bi];
      if (!block || block.type !== "paragraph" || typeof block.content !== "string") continue;
      const wrapped = wrapPhraseAsExternalLink(block.content, s.phrase, s.url);
      if (wrapped) {
        finalBody[bi] = { ...block, content: wrapped };
        placedUrls.add(s.url);
        restored += 1;
        done = true;
        break;
      }
    }
    if (!done) {
      logger.info(
        { articleId, slug: article.slug, url: s.url, removed: urls.length, rePlaced: woven.linksAdded },
        "Redistribute: could not re-place or restore a citation; keeping original body",
      );
      return {
        article,
        linksRemoved: urls.length,
        linksAdded: 0,
        skipped: "insufficient_replacement",
      };
    }
  }

  const backup = article.sourceLinksBackup ?? originalBody;
  const [updated] = await db
    .update(articlesTable)
    .set({
      body: finalBody,
      sourceLinksBackup: backup,
      readingTimeMinutes: readingTimeFromBody(finalBody),
      updatedAt: new Date(),
    })
    .where(eq(articlesTable.id, articleId))
    .returning();
  if (updated?.status === "published") void pingArticleSlugs([updated.slug]);
  logger.info(
    { articleId, slug: article.slug, removed: urls.length, rePlaced: woven.linksAdded, restored },
    "Redistributed source links across published article",
  );
  // Reconcile the source graph with the rewritten body (same follow-up as the
  // backfill) so the References/trust box stays in sync.
  void routeBackfilledLinks(articleId, finalBody, article.categorySlug || null);
  return { article: updated!, linksRemoved: urls.length, linksAdded: woven.linksAdded + restored };
}

/**
 * Bulk citation redistribute across the back catalog: every published article
 * whose external citations are front-loaded (all in the first third of the
 * prose) gets one redistribute pass. Shares the source-link job state/lock with
 * the backfill (they can never overlap) and the same budget guardrail — each
 * article is one LLM call (no web search). Call beginSourceLinkJob("redistribute")
 * first (the route does) to claim the lock.
 */
export async function redistributeAllSourceLinks(
  opts: { limit?: number } = {},
): Promise<SourceLinkJobState> {
  try {
    const guard = await BudgetGuard.start("source-link redistribute");
    const rows = await db
      .select({ id: articlesTable.id, body: articlesTable.body })
      .from(articlesTable)
      .where(eq(articlesTable.status, "published"))
      .orderBy(desc(articlesTable.publishedAt));
    let eligible = rows.filter((r) => hasFrontLoadedSourceLinks(r.body as ArticleBlock[]));
    if (opts.limit && opts.limit > 0) eligible = eligible.slice(0, opts.limit);
    sourceLinkJob.total = eligible.length;
    for (const row of eligible) {
      if (sourceLinkCancelRequested) {
        sourceLinkJob.canceled = true;
        break;
      }
      try {
        await guard.check();
      } catch (e) {
        if (e instanceof BudgetExceededError) {
          sourceLinkJob.canceled = true;
          logger.warn({ reason: e.reason, processed: sourceLinkJob.processed }, e.message);
          break;
        }
        throw e;
      }
      try {
        const result = await redistributeArticleSourceLinks(row.id);
        if (!result.skipped && result.linksAdded > 0) {
          sourceLinkJob.updated += 1;
          sourceLinkJob.linksAdded += result.linksAdded;
        } else {
          sourceLinkJob.skipped += 1;
        }
      } catch (err) {
        sourceLinkJob.failed += 1;
        logger.error({ err, articleId: row.id }, "Source-link redistribute failed for article; continuing batch");
      } finally {
        sourceLinkJob.processed += 1;
      }
    }
    return getSourceLinkJob();
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      sourceLinkJob.canceled = true;
      logger.warn({ reason: e.reason }, e.message);
      return getSourceLinkJob();
    }
    throw e;
  } finally {
    sourceLinkJob.running = false;
    sourceLinkJob.finishedAt = new Date().toISOString();
    sourceLinkCancelRequested = false;
  }
}

/**
 * Strip legacy Google-Scholar / search-query external links from a body,
 * keeping the visible anchor phrase. Returns the rewritten body and how many
 * such links were removed. Non-search external links (real verified sources)
 * and internal links are left untouched.
 */
function stripSearchLinksFromBody(body: ArticleBlock[]): { body: ArticleBlock[]; removed: number } {
  let removed = 0;
  const out = body.map((block) => {
    if (block.type !== "paragraph" || typeof block.content !== "string") return block;
    const next = block.content.replace(EXTERNAL_LINK_RE, (full, phrase: string, url: string) => {
      if (isSearchQueryUrl(url)) {
        removed += 1;
        return phrase;
      }
      return full;
    });
    return next === block.content ? block : { ...block, content: next };
  });
  return { body: out, removed };
}

/**
 * Publish-time safeguard: strip Google-Scholar / search-query links from the
 * given articles' bodies. Any article left with ZERO external links afterwards
 * gets an immediate fire-and-forget vault-first source top-up so it doesn't go
 * live citation-less until the next daily pass.
 */
export async function sanitizeSearchLinksOnPublish(articleIds: string[]): Promise<number> {
  if (articleIds.length === 0) return 0;
  const rows = await db
    .select({ id: articlesTable.id, body: articlesTable.body })
    .from(articlesTable)
    .where(inArray(articlesTable.id, articleIds));
  let linksRemoved = 0;
  const cleaned: string[] = [];
  for (const row of rows) {
    const { body, removed } = stripSearchLinksFromBody(row.body as ArticleBlock[]);
    if (removed === 0) continue;
    await db
      .update(articlesTable)
      .set({ body, updatedAt: new Date() })
      .where(eq(articlesTable.id, row.id));
    linksRemoved += removed;
    cleaned.push(row.id);
    logger.warn({ articleId: row.id, removed }, "publish: stripped search-query links from body");
  }
  // Fire-and-forget top-up for the articles that just lost links — they were
  // relying on scholar links, so they likely have no real sources at all.
  for (const id of cleaned) {
    void backfillArticleSourceLinks(id).catch((err) =>
      logger.warn({ err, articleId: id }, "publish: post-strip source top-up failed"),
    );
  }
  return linksRemoved;
}

/**
 * Sweep the published catalogue and remove any leftover Google-Scholar /
 * search-query links (the 31 legacy articles authored before draft-time
 * sanitization). Cheap and network-free — pure string work — so it runs inline
 * at the start of the daily back-catalogue pass. After stripping, an article
 * whose only external links were scholar links becomes eligible for the
 * source-link backfill (which targets zero-external-link articles), so real
 * verified sources get woven in on the same daily pass.
 */
export async function stripSearchLinksFromCatalogue(): Promise<{
  scanned: number;
  updated: number;
  linksRemoved: number;
}> {
  const rows = await db
    .select({ id: articlesTable.id, body: articlesTable.body })
    .from(articlesTable)
    .where(eq(articlesTable.status, "published"));
  let updated = 0;
  let linksRemoved = 0;
  for (const row of rows) {
    const { body, removed } = stripSearchLinksFromBody(row.body as ArticleBlock[]);
    if (removed === 0) continue;
    await db
      .update(articlesTable)
      .set({ body, updatedAt: new Date() })
      .where(eq(articlesTable.id, row.id));
    updated += 1;
    linksRemoved += removed;
  }
  return { scanned: rows.length, updated, linksRemoved };
}

// The daily back-catalogue pass bounds how many articles it backfills per run so
// a single tick stays cheap (each source/internal backfill makes an LLM call per
// article). Re-runs pick up where the last left off (eligibility is "no links
// yet"), so the whole catalogue is covered over a few days.
const DAILY_BACKFILL_LIMIT = 25;

export interface BackCatalogueMaintenanceResult {
  scholarScanned: number;
  scholarUpdated: number;
  scholarLinksRemoved: number;
  sourceLinks: "ran" | "busy";
  sourceLinksUpdated: number;
  internalLinks: "ran" | "busy";
  internalLinksUpdated: number;
  driftArticlesRepaired: number;
  driftLinksRouted: number;
}

/**
 * Daily back-catalogue maintenance: (1) strip legacy scholar/search links from
 * the published catalogue, (2) backfill real verified source links onto
 * articles missing them, (3) backfill internal links onto articles missing
 * them. Steps 2 and 3 reuse the manual admin backfill jobs' in-flight guards
 * (beginSourceLinkJob / beginInternalLinkJob) so the daily pass never collides
 * with an admin-triggered run — if one is already running, that step is skipped
 * this tick and retried next day.
 */
export async function runBackCatalogueMaintenance(): Promise<BackCatalogueMaintenanceResult> {
  const scholar = await stripSearchLinksFromCatalogue();

  let sourceLinks: "ran" | "busy" = "busy";
  let sourceLinksUpdated = 0;
  if (beginSourceLinkJob()) {
    const state = await backfillAllSourceLinks({ limit: DAILY_BACKFILL_LIMIT });
    sourceLinks = "ran";
    sourceLinksUpdated = state.updated;
  }

  let internalLinks: "ran" | "busy" = "busy";
  let internalLinksUpdated = 0;
  if (beginInternalLinkJob()) {
    const state = await backfillAllInternalLinks({ limit: DAILY_BACKFILL_LIMIT });
    internalLinks = "ran";
    internalLinksUpdated = state.updated;
  }

  // (4) Source-graph drift repair: route any body links added AFTER an
  // article's one-time harvest (e.g. by the source-link backfill before it
  // learned to record them) into article_sources, so the public References
  // list self-heals. DB-only, free, idempotent, bounded per day.
  let driftArticlesRepaired = 0;
  let driftLinksRouted = 0;
  try {
    const drift = await repairSourceGraphDrift(DAILY_BACKFILL_LIMIT);
    driftArticlesRepaired = drift.articlesRepaired;
    driftLinksRouted = drift.linksRouted;
  } catch (err) {
    logger.warn({ err }, "back-catalogue maintenance: drift repair failed");
  }

  return {
    scholarScanned: scholar.scanned,
    scholarUpdated: scholar.updated,
    scholarLinksRemoved: scholar.linksRemoved,
    sourceLinks,
    sourceLinksUpdated,
    internalLinks,
    internalLinksUpdated,
    driftArticlesRepaired,
    driftLinksRouted,
  };
}

// Stored hero/share image URLs are served from object storage under this prefix.
const PUBLIC_OBJECT_PREFIX = "/api/storage/public-objects/";

/**
 * Bulk backfill the branded social share card onto every published article that
 * doesn't have one yet. The share card (1200×630, brand wordmark + title
 * overlay) is normally only built when a hero image is generated, so articles
 * that predate the feature fall back to the raw hero in og:image/twitter:image.
 *
 * This REUSES each article's existing stored hero image — it downloads the hero
 * bytes from object storage and re-composites the share card. It never calls the
 * AI image model, so there's no generation cost and the hero is untouched.
 *
 * Safety:
 *  - Only acts on PUBLISHED articles with a null/empty `shareImage`.
 *  - Articles whose hero isn't a readable stored public object (e.g. an external
 *    placeholder URL, or a missing binary) are skipped, not failed.
 *  - Runs sequentially; a single article's failure never aborts the batch.
 *  - The UPDATE is guarded on the share image still being empty, so a concurrent
 *    regenerate-image can't be clobbered.
 */
// ---------------------------------------------------------------------------
// Share-image bulk job: live progress + cooperative cancellation.
//
// The backfill/rebuild loop is an in-process, fire-and-forget job (single
// server). We expose its live progress so the admin gallery can render a
// progress bar, and a cancel flag the loop checks between articles so an admin
// can halt a long run. Single-server only — a multi-instance deploy would need
// shared (DB/Redis) job state instead.
// ---------------------------------------------------------------------------
export type ShareImageJobMode = "backfill" | "rebuild";

export interface ShareImageJobState {
  running: boolean;
  mode: ShareImageJobMode | null;
  total: number;
  processed: number;
  updated: number;
  skipped: number;
  failed: number;
  canceled: boolean;
  startedAt: string | null;
  finishedAt: string | null;
}

let shareImageJob: ShareImageJobState = {
  running: false,
  mode: null,
  total: 0,
  processed: 0,
  updated: 0,
  skipped: 0,
  failed: 0,
  canceled: false,
  startedAt: null,
  finishedAt: null,
};
let shareImageCancelRequested = false;
// Separate lock for the synchronous bulk-delete so it can't run concurrently
// with a backfill/rebuild (and vice-versa). Both `begin*` helpers check both
// flags, giving full mutual exclusion across interleaved requests.
let shareImageDeleting = false;

/** Snapshot of the current/last share-image job (safe copy). */
export function getShareImageJob(): ShareImageJobState {
  return { ...shareImageJob };
}

/** True while any share-image operation (job OR bulk-delete) holds the lock. */
export function isShareImageBusy(): boolean {
  return shareImageJob.running || shareImageDeleting;
}

/**
 * Atomically claim the lock for a bulk delete. Returns false if a job or
 * another delete is already in flight. Pair with endShareImageDelete() in a
 * finally so the lock is always released.
 */
export function beginShareImageDelete(): boolean {
  if (shareImageJob.running || shareImageDeleting) return false;
  shareImageDeleting = true;
  return true;
}

/** Release the bulk-delete lock. */
export function endShareImageDelete(): void {
  shareImageDeleting = false;
}

/** Request cooperative cancellation of a running job. Returns false if idle. */
export function requestShareImageJobCancel(): boolean {
  if (!shareImageJob.running) return false;
  shareImageCancelRequested = true;
  return true;
}

/**
 * Atomically check-and-start a job. Returns false if one is already running, so
 * the caller can respond `alreadyRunning` without launching a second loop. Must
 * be called synchronously (the routes do) before the async worker runs.
 */
export function beginShareImageJob(mode: ShareImageJobMode): boolean {
  if (shareImageJob.running || shareImageDeleting) return false;
  shareImageJob = {
    running: true,
    mode,
    total: 0,
    processed: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    canceled: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  shareImageCancelRequested = false;
  return true;
}

export async function backfillShareImages(
  opts: { force?: boolean } = {},
): Promise<ShareImageJobState> {
  // force=true re-composites EVERY published article's cards (used after a
  // branding/layout change); the default only fills in cards that are missing.
  // "Missing" now means EITHER the 1.91:1 share card (og:image) OR the 1:1 feed
  // card (the attached Facebook photo) is absent — both are composed from the
  // same downloaded hero buffer in one pass.
  const force = opts.force ?? false;
  const missingShare = sql`(${articlesTable.shareImage} IS NULL OR ${articlesTable.shareImage} = '')`;
  const missingFeed = sql`(${articlesTable.feedImage} IS NULL OR ${articlesTable.feedImage} = '')`;
  const missingCard = sql`(${missingShare} OR ${missingFeed})`;
  try {
    const rows = await db
      .select({
        id: articlesTable.id,
        slug: articlesTable.slug,
        title: articlesTable.title,
        heroImage: articlesTable.heroImage,
        shareImage: articlesTable.shareImage,
        feedImage: articlesTable.feedImage,
      })
      .from(articlesTable)
      .where(
        force
          ? eq(articlesTable.status, "published")
          : and(eq(articlesTable.status, "published"), missingCard),
      )
      .orderBy(desc(articlesTable.publishedAt));
    shareImageJob.total = rows.length;
    for (const row of rows) {
      // Cooperative cancel: stop cleanly before starting the next article.
      if (shareImageCancelRequested) {
        shareImageJob.canceled = true;
        break;
      }
      try {
        const hero = row.heroImage ?? "";
        if (!hero.startsWith(PUBLIC_OBJECT_PREFIX)) {
          shareImageJob.skipped += 1;
          continue;
        }
        const rawPath = hero.slice(PUBLIC_OBJECT_PREFIX.length).split(/[?#]/)[0] ?? "";
        let filePath = rawPath;
        try {
          filePath = decodeURIComponent(rawPath);
        } catch {
          filePath = rawPath;
        }
        const file = await findPublicObject(filePath);
        if (!file) {
          shareImageJob.skipped += 1;
          continue;
        }
        const [heroBuf] = await file.download();
        // Build whichever card(s) are missing (or both on force), reusing the
        // single downloaded hero buffer. og:image share card is 1.91:1; the
        // attached Facebook feed photo is 1:1.
        const needShare = force || !row.shareImage;
        const needFeed = force || !row.feedImage;
        const newShare = needShare
          ? await generateAndStoreShareImage(heroBuf, row.title, row.slug)
          : null;
        const newFeed = needFeed
          ? await generateAndStoreFeedImage(heroBuf, row.title, row.slug)
          : null;
        if ((needShare && !newShare) || (needFeed && !newFeed)) {
          shareImageJob.failed += 1;
          continue;
        }
        const patch: Partial<typeof articlesTable.$inferInsert> = { updatedAt: new Date() };
        if (newShare) patch.shareImage = newShare;
        if (newFeed) patch.feedImage = newFeed;
        const changed = await db
          .update(articlesTable)
          .set(patch)
          .where(force ? eq(articlesTable.id, row.id) : and(eq(articlesTable.id, row.id), missingCard))
          .returning({ id: articlesTable.id });
        // If the guard matched nothing, another writer (e.g. regenerate-image)
        // populated the cards first; count it as skipped, not updated.
        if (changed.length > 0) shareImageJob.updated += 1;
        else shareImageJob.skipped += 1;
      } catch (err) {
        shareImageJob.failed += 1;
        logger.error({ err, articleId: row.id }, "Share-image backfill failed for article; continuing batch");
      } finally {
        // Count every attempted row so the progress bar advances even on skips.
        shareImageJob.processed += 1;
      }
    }
    return getShareImageJob();
  } finally {
    shareImageJob.running = false;
    shareImageJob.finishedAt = new Date().toISOString();
    shareImageCancelRequested = false;
  }
}

/**
 * Delete every stored branded share card: null the `share_image` column for all
 * articles that have one and best-effort remove the underlying objects from
 * public storage so they don't accumulate as orphans. Articles fall back to
 * their raw hero image for og:image until cards are rebuilt. Returns the count
 * cleared.
 */
export async function deleteAllShareImages(): Promise<{ deleted: number }> {
  const hasCard = sql`${articlesTable.shareImage} IS NOT NULL AND ${articlesTable.shareImage} <> ''`;
  const rows = await db
    .select({ id: articlesTable.id, shareImage: articlesTable.shareImage })
    .from(articlesTable)
    .where(hasCard);
  for (const row of rows) {
    const url = row.shareImage ?? "";
    if (!url.startsWith(PUBLIC_OBJECT_PREFIX)) continue;
    const rawPath = url.slice(PUBLIC_OBJECT_PREFIX.length).split(/[?#]/)[0] ?? "";
    let filePath = rawPath;
    try {
      filePath = decodeURIComponent(rawPath);
    } catch {
      filePath = rawPath;
    }
    try {
      await deletePublicObject(filePath);
    } catch (err) {
      logger.warn({ err, articleId: row.id }, "Failed to delete share-image object; continuing");
    }
  }
  await db
    .update(articlesTable)
    .set({ shareImage: null, updatedAt: new Date() })
    .where(hasCard);
  return { deleted: rows.length };
}

// ---------------------------------------------------------------------------
// Social-pack bulk job: live progress + cooperative cancellation.
//
// Same in-process, fire-and-forget pattern as the share-image job above:
// `backfill` fills in articles that have no social pack yet; `rebuild`
// regenerates every published article (used after a prompt change). Single
// server only — a multi-instance deploy would need shared job state.
// ---------------------------------------------------------------------------
export type SocialPackJobMode = "backfill" | "rebuild";

export interface SocialPackJobState {
  running: boolean;
  mode: SocialPackJobMode | null;
  total: number;
  processed: number;
  updated: number;
  skipped: number;
  failed: number;
  canceled: boolean;
  startedAt: string | null;
  finishedAt: string | null;
}

// Long-running lock key for the daily content pipeline (drafts + publish +
// digest for every active author). A full manual run can be tens of minutes.
const DAILY_PIPELINE_JOB = "daily_pipeline";
const DAILY_PIPELINE_TTL_MS = 30 * 60 * 1000;

const SOCIAL_PACK_JOB = "social_pack_backfill";
// A rebuild touches every published article (LLM call each) and can run a long
// time; a heartbeat older than this marks a crashed run stale so a later job can
// take the lock over.
const SOCIAL_PACK_TTL_MS = 30 * 60 * 1000;

type SocialPackProgress = {
  mode: SocialPackJobMode | null;
  total: number;
  processed: number;
  updated: number;
  skipped: number;
  failed: number;
  canceled: boolean;
};

function emptySocialPackProgress(mode: SocialPackJobMode | null): SocialPackProgress {
  return { mode, total: 0, processed: 0, updated: 0, skipped: 0, failed: 0, canceled: false };
}

/**
 * Snapshot of the current/last social-pack job. DB-backed (table
 * `background_jobs` via jobState.ts) so progress survives a restart and is
 * consistent across autoscale instances.
 */
export async function getSocialPackJob(): Promise<SocialPackJobState> {
  const row = await getJobState(SOCIAL_PACK_JOB);
  if (!row) {
    return { running: false, ...emptySocialPackProgress(null), startedAt: null, finishedAt: null };
  }
  const p = (row.progress ?? {}) as Partial<SocialPackProgress>;
  return {
    running: row.status === "running",
    mode: p.mode ?? null,
    total: p.total ?? 0,
    processed: p.processed ?? 0,
    updated: p.updated ?? 0,
    skipped: p.skipped ?? 0,
    failed: p.failed ?? 0,
    canceled: p.canceled ?? false,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

/**
 * Request cooperative cancellation of a running job (cross-instance via the DB
 * cancel flag — the worker checks it between articles). Returns false if idle.
 */
export async function requestSocialPackJobCancel(): Promise<boolean> {
  return requestJobCancel(SOCIAL_PACK_JOB);
}

/**
 * Atomically claim the social-pack job lock (DB-backed). Returns false if one is
 * already running on any instance. Must be awaited before the async worker runs.
 */
export async function beginSocialPackJob(mode: SocialPackJobMode): Promise<string | null> {
  return acquireJobLock(SOCIAL_PACK_JOB, {
    ttlMs: SOCIAL_PACK_TTL_MS,
    progress: emptySocialPackProgress(mode),
  });
}

/**
 * Regenerate the hook kit + social pack for a single article and persist it.
 * Throws if the article is missing or generation fails so the route can map it
 * to a 404 / 502. Overwrites any existing variants/assignments/pack.
 */
export async function regenerateArticleHooksAndSocialPack(id: string): Promise<Article> {
  const [article] = await db.select().from(articlesTable).where(eq(articlesTable.id, id)).limit(1);
  if (!article) throw new BackfillError("Article not found");
  const [author] = await db.select().from(authorsTable).where(eq(authorsTable.id, article.authorId)).limit(1);
  if (!author) throw new Error("Author not found");
  const kit = await generateHooksAndSocialPack(
    author as Author,
    {
      title: article.title,
      dek: article.dek,
      category: article.category,
      body: article.body,
    },
    { operation: "regenerateHooksAndSocialPack", articleId: id },
  );
  const [updated] = await db
    .update(articlesTable)
    .set({
      hookVariants: kit.hookVariants,
      hookAssignments: kit.hookAssignments,
      socialPack: kit.socialPack,
      updatedAt: new Date(),
    })
    .where(eq(articlesTable.id, id))
    .returning();
  return updated!;
}

/**
 * Bulk-generate the hook kit + social pack across published articles. `force`
 * regenerates every published article; the default only fills articles that
 * have no social pack yet. Fire-and-forget worker loop with cooperative cancel.
 */
export async function backfillSocialPacks(
  runId: string,
  opts: { force?: boolean } = {},
): Promise<SocialPackJobState> {
  const force = opts.force ?? false;
  const mode: SocialPackJobMode = force ? "rebuild" : "backfill";
  const progress = emptySocialPackProgress(mode);
  // If the hook/social-pack function is paused via the AI Control Center, skip
  // the whole batch cleanly instead of marking every article as "failed".
  if (!(await isAiFunctionEnabled("hook_social_pack"))) {
    logger.info("Social-pack backfill skipped; hook_social_pack is paused");
    await finishJob(SOCIAL_PACK_JOB, runId, "succeeded", { progress: { ...progress } });
    return getSocialPackJob();
  }
  const missingPack = sql`${articlesTable.socialPack} IS NULL`;
  let runError: unknown = null;
  try {
    const rows = await db
      .select({ id: articlesTable.id })
      .from(articlesTable)
      .where(
        force
          ? eq(articlesTable.status, "published")
          : and(eq(articlesTable.status, "published"), missingPack),
      )
      .orderBy(desc(articlesTable.publishedAt));
    progress.total = rows.length;
    await heartbeatJob(SOCIAL_PACK_JOB, runId, { ...progress });
    for (const row of rows) {
      // Cancellation is cross-instance via the DB flag; checked between articles.
      if (await isCancelRequested(SOCIAL_PACK_JOB)) {
        progress.canceled = true;
        break;
      }
      try {
        // Re-read the article inside the loop so a long run always works off the
        // current content (an editor may have edited it mid-batch).
        const [article] = await db.select().from(articlesTable).where(eq(articlesTable.id, row.id)).limit(1);
        if (!article) {
          progress.skipped += 1;
          continue;
        }
        // Skip if another writer populated the pack while we were running and
        // we're not forcing — keeps backfill idempotent on re-run.
        if (!force && article.socialPack) {
          progress.skipped += 1;
          continue;
        }
        const [author] = await db.select().from(authorsTable).where(eq(authorsTable.id, article.authorId)).limit(1);
        if (!author) {
          progress.skipped += 1;
          continue;
        }
        const kit = await generateHooksAndSocialPack(
          author as Author,
          {
            title: article.title,
            dek: article.dek,
            category: article.category,
            body: article.body,
          },
          { operation: "backfillHooksAndSocialPack", articleId: row.id },
        );
        const changed = await db
          .update(articlesTable)
          .set({
            hookVariants: kit.hookVariants,
            hookAssignments: kit.hookAssignments,
            socialPack: kit.socialPack,
            updatedAt: new Date(),
          })
          .where(force ? eq(articlesTable.id, row.id) : and(eq(articlesTable.id, row.id), missingPack))
          .returning({ id: articlesTable.id });
        if (changed.length > 0) progress.updated += 1;
        else progress.skipped += 1;
      } catch (err) {
        progress.failed += 1;
        logger.error({ err, articleId: row.id }, "Social-pack backfill failed for article; continuing batch");
      } finally {
        progress.processed += 1;
        await heartbeatJob(SOCIAL_PACK_JOB, runId, { ...progress });
      }
    }
  } catch (e) {
    runError = e;
  } finally {
    await finishJob(SOCIAL_PACK_JOB, runId, runError ? "failed" : "succeeded", {
      progress: { ...progress },
      error: runError ? (runError instanceof Error ? runError.message : String(runError)) : undefined,
    });
  }
  if (runError) throw runError;
  return getSocialPackJob();
}

async function ensureUniqueSlug(base: string): Promise<string> {
  let slug = base;
  let n = 1;
  while (true) {
    const existing = await db
      .select({ id: articlesTable.id })
      .from(articlesTable)
      .where(eq(articlesTable.slug, slug))
      .limit(1);
    if (existing.length === 0) return slug;
    n += 1;
    slug = `${base}-${n}`;
  }
}

/**
 * Atomic single-claim of an idea for drafting. Transitions the idea into
 * `drafting` ONLY if it isn't already in that state, and returns the updated
 * row. Returns null when the idea is already being drafted (or doesn't exist) —
 * the signal to the caller that another job owns it and no second draft should
 * start. This is the one place both the manual and the automated pipeline must
 * go through so the same idea can never be drafted twice concurrently.
 */
export async function claimIdeaForDraft(
  ideaId: string,
): Promise<typeof topicIdeasTable.$inferSelect | null> {
  const [updated] = await db
    .update(topicIdeasTable)
    .set({ status: "drafting", notes: null, updatedAt: new Date() })
    .where(and(eq(topicIdeasTable.id, ideaId), not(inArray(topicIdeasTable.status, ["drafting", "harvesting_sources"]))))
    .returning();
  return updated ?? null;
}

/**
 * Shared cleanup for a draft job that threw. Mirrors the manual path's recovery:
 *  - DuplicateArticleError: runDraftArticleFromIdea already set status=rejected → no-op.
 *  - AiFunctionDisabledError: paused via the AI Control Center → restore to a
 *    clean `approved` (no failure note) so it drafts once re-enabled.
 *  - anything else: revert to `approved` with the error written to `notes`.
 * The revert is guarded on `status='drafting'` so it never clobbers a row that a
 * different process has since moved to a terminal state.
 */
async function revertDraftingIdeaAfterError(ideaId: string, err: unknown): Promise<void> {
  if (err instanceof DuplicateArticleError) return;
  // A held idea was moved to `needs_sources` on purpose (not a failure). Never
  // revert it to `approved` or overwrite its explanatory note.
  if (err instanceof IdeaHeldNeedsSourcesError) return;
  const note =
    err instanceof AiFunctionDisabledError
      ? null
      : `Draft generation failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 500)}`;
  try {
    await db
      .update(topicIdeasTable)
      .set({ status: "approved", notes: note, updatedAt: new Date() })
      .where(and(eq(topicIdeasTable.id, ideaId), inArray(topicIdeasTable.status, ["drafting", "harvesting_sources"])));
  } catch (revertErr) {
    logger.error({ err: revertErr, ideaId }, "Failed to revert drafting idea after error");
  }
}

/**
 * Extract named entities from idea text to produce a more targeted Perplexity
 * discovery query. Returns person names, quoted phrases, and key legal/event
 * terms alongside the general idea context.
 */
function extractNamedEntities(text: string): string[] {
  const entities: string[] = [];
  const propNounRe = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = propNounRe.exec(text)) !== null) {
    entities.push(m[1]!);
  }
  const quotedRe = /"([^"]{3,50})"/g;
  while ((m = quotedRe.exec(text)) !== null) {
    entities.push(m[1]!);
  }
  const termRe = /\b(ICE|FBI|DOJ|DHS|convicted|sentenced|charged|indicted|obstruction|conspiracy|protest|arrested|immigration|deportation|detention|zines?|anti-[a-z]+|[A-Z]{3,})\b/g;
  while ((m = termRe.exec(text)) !== null) {
    entities.push(m[0]!);
  }
  return [...new Set(entities)].slice(0, 8);
}

/** Outcome of a controlled Source Harvest for one idea's beat (Task #233). */
interface IdeaHarvestResult {
  ran: boolean;
  leadsEnqueued: number;
  ingested: number;
  reason: string;
}

/**
 * Controlled Source Harvest for a single idea (Task #233, Step 6). A SEPARATE
 * research/ingest step — never the writer searching mid-draft. Reuses the same
 * bounded discovery + ingest-queue machinery as the automated crawler: a
 * Perplexity evidence-lead search scoped to the idea's beat, enqueued into the
 * bounded ingest queue, then drained (fetch + extract + embed) so the Source
 * Vault has fresh, citable material to ground the retry. Respects the existing
 * VaultBudgetGuard (inside searchLeads / drainIngestQueue) and the vault
 * kill-switch. Never throws — a failed harvest just reports ran=false and the
 * caller holds the idea.
 */
async function harvestSourcesForIdea(
  idea: typeof topicIdeasTable.$inferSelect,
  author: Author,
): Promise<IdeaHarvestResult> {
  const result: IdeaHarvestResult = { ran: false, leadsEnqueued: 0, ingested: 0, reason: "" };
  if (!isSourceVaultEnabled()) {
    result.reason = "Source Vault is disabled.";
    return result;
  }
  if (!(await isResearchCapabilityAvailable())) {
    result.reason = "No discovery provider configured (Perplexity or the Claude fallback).";
    return result;
  }

  const beat = idea.category ?? author.category;
  const beatSlug = idea.categorySlug ?? author.categorySlug;
  // Cross-sectional (Task #258): resolve the idea's secondary subjects to beat
  // names so discovery spans ALL of the idea's beats, not just the primary — the
  // draft can then synthesize evidence across subjects. Names only widen the
  // search query; leads are still tagged under the primary beat below.
  const secondaryBeatNames = await resolveSecondaryBeatNames(idea.secondaryBeats);
  // Extract named entities (person names, event phrases, legal terms) from the
  // idea so Perplexity searches for "Daniel Sanchez Estrada zines anti-ICE
  // obstruction" rather than just the generic beat name.
  const entityHints = extractNamedEntities(`${idea.title} ${idea.angle ?? ""}`);
  const queryParts = [idea.title, ...entityHints, idea.angle, beat, ...secondaryBeatNames].filter(Boolean);
  const query = queryParts.join(" ").slice(0, 400);

  let recencyDays = 7;
  let allowedDomains: string[] = [];
  try {
    const settings = await getSiteSettings();
    recencyDays =
      settings.sourceFreshnessByBeat[beatSlug] ??
      (settings.sourceFreshnessDefaultDays > 0 ? settings.sourceFreshnessDefaultDays : 7);
    allowedDomains = settings.sourceDiscoveryAllowedDomains ?? [];
  } catch {
    // fall back to the safe defaults on any settings read failure
  }

  // Step 1: bounded evidence-lead search scoped to the idea's beat (paid, but
  // budget-guarded inside searchLeads). Fail closed on any error.
  let leads;
  try {
    leads = await searchLeads(query, {
      maxResults: 6,
      recencyDays,
      ...(allowedDomains.length > 0 ? { domains: allowedDomains } : {}),
    });
  } catch (err) {
    result.reason = `Discovery search failed: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn({ err, ideaId: idea.id }, "harvest: discovery search failed");
    return result;
  }
  result.ran = true;

  // Step 2: enqueue the fresh leads into the bounded ingest queue.
  for (const lead of leads) {
    if (!lead.url) continue;
    try {
      const { enqueued } = await enqueueUrl(lead.url, {
        discoveredVia: "perplexity_search",
        beatSlug,
        leadSnippet: lead.title || lead.snippet || null,
      });
      if (enqueued) result.leadsEnqueued += 1;
    } catch (err) {
      logger.warn({ err, url: lead.url, ideaId: idea.id }, "harvest: enqueue lead failed");
    }
  }

  // Step 3: drain the queue (fetch + extract + embed) so the vault is populated
  // BEFORE grounding is retried. Budget-guarded internally.
  try {
    const drain = await drainIngestQueue();
    result.ingested = drain.ingested;
  } catch (err) {
    result.reason = `Ingest drain failed: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn({ err, ideaId: idea.id }, "harvest: ingest drain failed");
    return result;
  }

  result.reason = `Harvested ${result.leadsEnqueued} leads, ingested ${result.ingested}.`;
  logger.info(
    { ideaId: idea.id, beatSlug, leadsEnqueued: result.leadsEnqueued, ingested: result.ingested },
    "harvest: controlled source harvest complete",
  );
  return result;
}

/**
 * Turn a harvest result into a short, editor-facing sentence for the idea note
 * (Task #239). A harvest that surfaced nothing new must read clearly differently
 * from one that populated the Vault, so a still-held retry is explainable rather
 * than looking identical to a successful grounding.
 */
function summarizeHarvestForNote(h: IdeaHarvestResult): string {
  if (!h.ran) {
    return `Source harvest didn't run${h.reason ? `: ${h.reason}` : "."}`;
  }
  if (h.ingested === 0 && h.leadsEnqueued === 0) {
    return "Source harvest found no new sources for this beat.";
  }
  const sources = `${h.ingested} new source${h.ingested === 1 ? "" : "s"}`;
  const leads = `${h.leadsEnqueued} lead${h.leadsEnqueued === 1 ? "" : "s"}`;
  return `Source harvest added ${sources} (${leads} queued).`;
}

export async function draftArticleFromIdea(
  authorId: string,
  ideaId: string,
  opts: { force?: boolean; forceHarvest?: boolean } = {},
): Promise<Article> {
  const [author] = await db.select().from(authorsTable).where(eq(authorsTable.id, authorId)).limit(1);
  if (!author) throw new Error("Author not found");
  // Claim the idea atomically BEFORE any expensive AI work. If another job (a
  // concurrent pipeline run, or a manual draft) already claimed it, skip rather
  // than produce a duplicate draft for the same idea.
  const claimed = await claimIdeaForDraft(ideaId);
  if (!claimed) {
    const [existing] = await db
      .select({ id: topicIdeasTable.id })
      .from(topicIdeasTable)
      .where(eq(topicIdeasTable.id, ideaId))
      .limit(1);
    if (!existing) throw new Error("Idea not found");
    throw new IdeaAlreadyDraftingError(ideaId);
  }
  try {
    return await runDraftArticleFromIdea(author as Author, claimed, opts);
  } catch (err) {
    await revertDraftingIdeaAfterError(ideaId, err);
    throw err;
  }
}

async function runDraftArticleFromIdea(
  author: Author,
  idea: typeof topicIdeasTable.$inferSelect,
  opts: { force?: boolean; forceHarvest?: boolean; editorialLabelOverride?: string | null } = {},
): Promise<Article> {
  // force=true is the manual "approve → send to draft" path: the editor has
  // explicitly chosen to publish this idea, so every dedupe gate that would
  // REJECT the idea (lexical overlap, LLM concept-duplicate, post-generation
  // overlap) is skipped, and the editor's chosen title is kept verbatim (no
  // near-twin rewrite). The automated pipeline never forces, so it still
  // enforces the full dedupe.
  const force = opts.force ?? false;

  // For continuance ideas we deliberately overlap with the original article,
  // so dedupe is scoped to OTHER articles only. We still compute overlaps even
  // when forcing — they feed the "avoid retreading" context for the writer.
  const overlaps = await findOverlappingArticles(idea.title, idea.angle, {
    excludeArticleId: idea.continuesArticleId ?? undefined,
    threshold: 0.3,
  });
  const blocking = force ? undefined : overlaps.find((h) => h.score >= 0.45);
  if (blocking) {
    await db
      .update(topicIdeasTable)
      .set({
        status: "rejected",
        notes: `Auto-rejected: too similar to existing article "${blocking.article.title}" (overlap ${(blocking.score * 100).toFixed(0)}%).`,
        updatedAt: new Date(),
      })
      .where(eq(topicIdeasTable.id, idea.id));
    throw new DuplicateArticleError(
      `This idea overlaps too much with existing article "${blocking.article.title}".`,
      { conflictingTitle: blocking.article.title, conflictingId: blocking.article.id, score: blocking.score },
    );
  }

  // Lexical check passed. Run the LLM concept backstop against the closest
  // existing articles to catch paraphrased near-duplicates that share no
  // distinctive wording (the lexical jaccard guard above misses these).
  // Continuance ideas deliberately overlap with their source, so that one
  // article is excluded; the check still runs against every OTHER article,
  // matching the lexical guard's scoping above.
  const llmDup = force
    ? null
    : await llmArticleConceptDuplicate(idea.title, idea.angle, {
        excludeArticleId: idea.continuesArticleId ?? undefined,
        proposedAuthor: { name: author.name, beat: author.category },
      });
  if (llmDup) {
    await db
      .update(topicIdeasTable)
      .set({
        status: "rejected",
        notes: `Auto-rejected: conceptually duplicates existing article "${llmDup.article.title}"${llmDup.reason ? ` — ${llmDup.reason}` : ""}.`,
        updatedAt: new Date(),
      })
      .where(eq(topicIdeasTable.id, idea.id));
    throw new DuplicateArticleError(
      `This idea conceptually duplicates existing article "${llmDup.article.title}".`,
      { conflictingTitle: llmDup.article.title, conflictingId: llmDup.article.id, score: 1.0 },
    );
  }

  // Title near-twin handling: even when the concept is genuinely distinct, a
  // headline that reads as a formulaic copy of an existing one is undesirable.
  // Rather than rejecting the (otherwise novel) idea, rewrite the working title
  // into a distinct headline so the front page doesn't fill with twin names.
  let workingTitle = idea.title;
  if (!force) {
    const titleDedupe = await dedupeTitle(workingTitle, idea.angle, {
      ...(idea.continuesArticleId ? { excludeArticleId: idea.continuesArticleId } : {}),
    });
    if (titleDedupe.changed) {
      logger.info(
        { ideaId: idea.id, from: workingTitle, to: titleDedupe.title, clashedWith: titleDedupe.clashedWith },
        "Rewrote draft title to avoid near-twin headline",
      );
      workingTitle = titleDedupe.title;
    }
  }

  let previousArticle: { title: string; dek: string; firstParagraph: string } | undefined;
  if (idea.continuesArticleId) {
    const [prev] = await db
      .select()
      .from(articlesTable)
      .where(eq(articlesTable.id, idea.continuesArticleId))
      .limit(1);
    if (prev) {
      const firstParagraph = (prev.body.find((b) => b.type === "paragraph")?.content ?? "").slice(0, 800);
      previousArticle = { title: prev.title, dek: prev.dek, firstParagraph };
    }
  }

  const allowedBeats = await resolveAllowedBeats(author);
  // Editorial override: when an idea was deliberately filed under a beat the
  // author doesn't normally cover (the custom-idea beat picker), pull that
  // beat's slant into the prompt context so the draft actually takes the chosen
  // lane's house take — not just the author's own beats. This is the one
  // sanctioned way a writer covers a beat outside their usual territory.
  if (idea.categorySlug && !allowedBeats.some((b) => b.categorySlug === idea.categorySlug)) {
    const [overrideBeat] = await db
      .select({ slug: beatsTable.slug, name: beatsTable.name, slant: beatsTable.slant })
      .from(beatsTable)
      .where(eq(beatsTable.slug, idea.categorySlug))
      .limit(1);
    if (overrideBeat) {
      allowedBeats.push({
        category: overrideBeat.name,
        categorySlug: overrideBeat.slug,
        slant: overrideBeat.slant ?? null,
      });
    }
  }
  const internalLinkCandidates = await fetchInternalLinkCandidates(
    idea.categorySlug ?? author.categorySlug,
    idea.continuesArticleId ?? undefined,
    20,
    `${workingTitle} ${idea.angle ?? ""}`,
  );
  const articleId = randomUUID();

  // --- Auto-ground the draft from the Source Vault (Task #233) ----------------
  // EVERY draft must first try to get an evidence packet. An idea promoted from
  // the Editor Cockpit already carries `evidencePacketId` and skips straight to
  // the packet-grounded path below. A manual idea (no packet) is auto-grounded
  // here from the Source Vault, branching on the admin `draftResearchMode`:
  //   - vault_required: weak vault → hold `needs_sources`, never web-search.
  //   - vault_first_harvest_if_needed (prod default): weak vault → run a
  //     controlled Source Harvest for the idea's beat, retry grounding once,
  //     then hold `needs_sources` if still weak.
  //   - legacy_web_search (emergency override): weak vault → fall through to the
  //     legacy web-search-grounded draft path, recorded as `drafted_legacy_override`.
  // On success the freshly-built packet id is attached to the idea, so the
  // existing packet-grounded path (below) takes over unchanged.
  let groundingOutcome:
    | "grounded_from_vault"
    | "packet_verified"
    | "held_needs_sources"
    | "drafted_legacy_override"
    | null = idea.evidencePacketId ? "packet_verified" : null;
  const draftResearchMode = await resolveDraftResearchMode();
  // Set when a controlled Source Harvest ran on this attempt (Task #239). Kept
  // in function scope so both the held note (below) and the success note (idea
  // marked `used`) can tell the editor what the harvest actually surfaced.
  let harvest: IdeaHarvestResult | null = null;
  if (!idea.evidencePacketId) {
    const { buildEvidencePacketForIdea } = await import("./editorialScreen");
    let grounding = await buildEvidencePacketForIdea(idea, author);
    if (!grounding.ok && (opts.forceHarvest || shouldHarvestBeforeHold(draftResearchMode))) {
      // Signal to the admin UI that the system is actively sourcing, not stuck
      // in `drafting`. The idea moves harvesting_sources → drafting → used|needs_sources.
      await db
        .update(topicIdeasTable)
        .set({ status: "harvesting_sources", updatedAt: new Date() })
        .where(eq(topicIdeasTable.id, idea.id));
      idea.status = "harvesting_sources";
      harvest = await harvestSourcesForIdea(idea, author);
      logger.info(
        { ideaId: idea.id, ran: harvest.ran, leadsEnqueued: harvest.leadsEnqueued, ingested: harvest.ingested },
        "auto-ground: controlled harvest attempted before retry",
      );
      // Flip back to `drafting` before the retry grounding so the idea stays in a
      // coherent state if the retry succeeds and `runDraftArticleFromIdea` continues.
      await db
        .update(topicIdeasTable)
        .set({ status: "drafting", updatedAt: new Date() })
        .where(eq(topicIdeasTable.id, idea.id));
      idea.status = "drafting";
      grounding = await buildEvidencePacketForIdea(idea, author);
    }
    if (grounding.ok && grounding.packet) {
      idea.evidencePacketId = grounding.packet.id;
      groundingOutcome = "grounded_from_vault";
    } else if (draftResearchMode === "legacy_web_search" && !opts.forceHarvest) {
      // Emergency override only: draft via the legacy web-search path.
      // Explicitly excluded from the forceHarvest (breaking-news intake) lane —
      // when a writer triggers harvest-and-retry, the research step is the
      // controlled Perplexity ingest; if vault is still thin after that, the idea
      // must hold as needs_sources, never fall back to writer-side live web search.
      groundingOutcome = "drafted_legacy_override";
      logger.warn(
        { ideaId: idea.id, reason: grounding.reason },
        "auto-ground: legacy_web_search override — drafting without a Vault packet",
      );
      await db
        .update(topicIdeasTable)
        .set({ draftGroundingOutcome: "drafted_legacy_override", updatedAt: new Date() })
        .where(eq(topicIdeasTable.id, idea.id));
    } else if (opts.force && !opts.forceHarvest) {
      // Editor manually pushed this idea ("Send to draft" / "Harvest & draft").
      // Don't hold it for sources — let the writer self-source via draft-time
      // web search instead of forcing the editor into an infinite retry loop.
      // EXCLUDED from the forceHarvest (breaking-news intake) lane: that route
      // passes force:true only to skip dedupe gates, and its contract is to
      // HOLD as needs_sources when the vault is still thin after the harvest —
      // never to fall through to writer-side self-sourcing.
      groundingOutcome = "drafted_legacy_override";
      logger.info(
        { ideaId: idea.id, reason: grounding.reason },
        "editor-direct: drafting without Vault packet — writer self-sourcing",
      );
      await db
        .update(topicIdeasTable)
        .set({ draftGroundingOutcome: "drafted_legacy_override", updatedAt: new Date() })
        .where(eq(topicIdeasTable.id, idea.id));
    } else {
      // Vault too weak and no override: hold the idea as `needs_sources`. Set the
      // status DIRECTLY (not via the error-revert path) so it isn't clobbered
      // back to `approved` and doesn't get a generic "Draft failed" note.
      const heldNote = `Held: not enough trusted Vault evidence to ground this draft. ${grounding.reason}`;
      await db
        .update(topicIdeasTable)
        .set({
          status: "needs_sources",
          draftGroundingOutcome: "held_needs_sources",
          notes: harvest ? `${heldNote} ${summarizeHarvestForNote(harvest)}` : heldNote,
          updatedAt: new Date(),
        })
        .where(eq(topicIdeasTable.id, idea.id));
      throw new IdeaHeldNeedsSourcesError(idea.id, grounding.reason);
    }
  }

  // The per-mode draft-time web-search cap. Packet-backed drafts always get 0
  // (the packet already carries vetted sources); only `legacy_web_search` with
  // no packet reproduces the old nonzero cap.
  const maxDraftWebSearches =
    opts.force && !idea.evidencePacketId
      ? 3 // editor override: let the writer self-source
      : maxDraftWebSearchesFor(draftResearchMode, !!idea.evidencePacketId);

  // If this idea was promoted from a screened evidence packet (Editor Cockpit),
  // load it and feed its vetted grounding into the drafter so the draft is built
  // on already-verified sources/claims/quotes instead of re-researching from
  // scratch. FAIL CLOSED on packet problems: the web-search allowance was
  // already computed as 0 for packet-backed drafts, so silently continuing
  // would produce a draft with no packet, no research, AND no verification —
  // while still carrying the packet id in its lineage. A missing packet holds
  // the idea (needs_sources); a transient load error aborts the draft attempt
  // (idea reverts through the normal failure path and a later run retries).
  let evidencePacketGrounding:
    | {
        label: string;
        claims: { text: string; sourceIds: string[] }[];
        sources: { id: string; url: string; domain: string; title: string | null; authorityTier: string }[];
        quotes: { text: string; attribution: string; sourceId: string | null }[];
        contradictions: { summary: string }[];
        supportingChunks?: { sourceId: string; text: string; similarity?: number }[];
      }
    | undefined;
  // The full loaded packet, kept so the post-draft verifier (#201) can check the
  // finished draft against the SAME locked packet that grounded it.
  let loadedPacket: import("@workspace/db").EvidencePacket | null = null;
  if (idea.evidencePacketId) {
    try {
      const { getPacket } = await import("./editorialScreen");
      const packet = await getPacket(idea.evidencePacketId);
      if (packet) {
        // A stale packet means at least one source has been retracted or
        // superseded since the packet was screened. The prior approve_draft
        // decision no longer reflects the current evidence; drafting against
        // it would ground the article in discredited sources. Hold the idea
        // so the editor must refresh the packet before a draft is created.
        if (packet.stalePacket) {
          const heldNote = `Held: evidence packet ${idea.evidencePacketId} is stale (retracted/superseded sources); re-run editorial screening before drafting.`;
          await db
            .update(topicIdeasTable)
            .set({
              status: "needs_sources",
              draftGroundingOutcome: "held_needs_sources",
              notes: heldNote,
              updatedAt: new Date(),
            })
            .where(eq(topicIdeasTable.id, idea.id));
          throw new IdeaHeldNeedsSourcesError(idea.id, "evidence packet stale — requires re-screening");
        }
        loadedPacket = packet;
        evidencePacketGrounding = {
          label: packet.label,
          claims: packet.claims,
          sources: packet.sources.map((s) => ({
            id: s.id,
            url: s.url,
            domain: s.domain,
            title: s.title,
            authorityTier: s.authorityTier,
          })),
          quotes: packet.quoteCandidates
            .filter((q) => q.allowedToQuote && q.verified)
            .map((q) => ({ text: q.text, attribution: q.attribution, sourceId: q.sourceId })),
          contradictions: packet.contradictions.map((c) => ({ summary: c.summary })),
          // Verbatim Vault excerpts (Task #233): a PacketChunk's documentId is
          // the Vault document id, which is also the packet source id, so the
          // drafter can group excerpts under their [S#] source label.
          supportingChunks: packet.supportingChunks.map((ch) => ({
            sourceId: ch.documentId,
            text: ch.content,
            similarity: ch.similarity,
          })),
        };
      } else {
        // Packet id points at nothing (deleted/never persisted). Retrying
        // won't help — hold the idea for re-grounding instead of drafting
        // an ungrounded article that still claims packet lineage.
        const heldNote = `Held: evidence packet ${idea.evidencePacketId} was missing at draft time; re-ground the idea before drafting.`;
        await db
          .update(topicIdeasTable)
          .set({
            status: "needs_sources",
            draftGroundingOutcome: "held_needs_sources",
            notes: heldNote,
            updatedAt: new Date(),
          })
          .where(eq(topicIdeasTable.id, idea.id));
        throw new IdeaHeldNeedsSourcesError(idea.id, "evidence packet missing at draft time");
      }
    } catch (err) {
      if (err instanceof IdeaHeldNeedsSourcesError) throw err;
      // Transient load failure: abort this draft attempt (fail closed) rather
      // than drafting with zero research and no verification.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), ideaId: idea.id },
        "Evidence packet load failed during draft; aborting draft attempt (fail closed)",
      );
      throw err;
    }
  }

  const generated = await generateArticleDraft(
    author as Author,
    { title: workingTitle, angle: idea.angle },
    {
      avoidContext: renderAvoidList(overlaps),
      allowedBeats,
      ...(internalLinkCandidates.length ? { internalLinkCandidates } : {}),
      ...(previousArticle ? { previousArticle } : {}),
      ...(evidencePacketGrounding ? { evidencePacket: evidencePacketGrounding } : {}),
      ...(idea.evidencePacketId ? { packetId: idea.evidencePacketId } : {}),
      ...(idea.clusterId ? { clusterId: idea.clusterId } : {}),
      maxWebSearches: maxDraftWebSearches,
      articleId,
      ...(opts.editorialLabelOverride ? { editorialLabelOverride: opts.editorialLabelOverride } : {}),
    },
  );

  // Post-generation concept safety net: evaluate the title we will actually
  // save (workingTitle, already title-deduped) plus the produced dek. Because
  // workingTitle is title-deduped above, this now blocks only on genuine
  // content/concept overlap, not on a title-only clash.
  const postOverlaps = force
    ? []
    : await findOverlappingArticles(workingTitle, generated.dek, {
        excludeArticleId: idea.continuesArticleId ?? undefined,
        threshold: 0.4,
      });
  const postBlocking = postOverlaps.find((h) => h.score >= 0.5);
  if (postBlocking) {
    await db
      .update(topicIdeasTable)
      .set({
        status: "rejected",
        notes: `Auto-rejected after drafting: produced article too similar to "${postBlocking.article.title}".`,
        updatedAt: new Date(),
      })
      .where(eq(topicIdeasTable.id, idea.id));
    throw new DuplicateArticleError(
      `Generated article "${workingTitle}" overlaps too much with existing "${postBlocking.article.title}".`,
      { conflictingTitle: postBlocking.article.title, conflictingId: postBlocking.article.id, score: postBlocking.score },
    );
  }

  const validInternalSlugs = new Set(internalLinkCandidates.map((c) => c.slug));
  const linkedBody: ArticleBlock[] = sanitizeInternalLinks(generated.body, validInternalSlugs);
  // Strip unfalsifiable search-query "citations" and unlink fabricated/dead
  // source URLs before the draft is persisted.
  const citationResult = await sanitizeCitations(linkedBody);
  let body: ArticleBlock[] = citationResult.body;
  if (citationResult.strippedSearch > 0 || citationResult.strippedDead > 0) {
    logger.warn(
      { strippedSearch: citationResult.strippedSearch, strippedDead: citationResult.strippedDead },
      "Sanitized citations: removed search-query and/or unreachable source links from draft",
    );
  }
  // Keep the writer's (possibly title-deduped) working title as the draft title
  // and surface the LLM's sharpened titles as suggestions the editor can pick.
  const draftTitle = workingTitle;
  const llmCandidates = [generated.title, ...(generated.titleCandidates ?? [])]
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter((s) => s.length > 0 && s !== draftTitle);
  const titleCandidates = Array.from(new Set(llmCandidates)).slice(0, 4);
  const slug = await ensureUniqueSlug(slugify(draftTitle));
  // Honor the beat the idea was generated under (sub-beat or primary), with
  // the author's primary as fallback for legacy ideas missing the field.
  const articleCategory = idea.category ?? author.category;
  const articleCategorySlug = idea.categorySlug ?? author.categorySlug;

  // Weave verified SOURCE citations into the draft NOW, at creation time — not
  // only later via the admin "Add source links" failsafe. Tops up toward
  // SOURCE_LINK_TARGET using the same verify-then-wrap path the backfill uses.
  // Best-effort: a failure here must never sink an otherwise-good draft (the
  // failsafe backfill can still add links to it later).
  try {
    const sourceBudget = SOURCE_LINK_TARGET - countExternalLinks(body);
    if (sourceBudget > 0) {
      const woven = await weaveSourceLinksIntoBody(
        body,
        author,
        {
          title: generated.title,
          dek: generated.dek,
          category: articleCategory,
          articleId,
          origin: "draft_creation",
          evidencePacketId: idea.evidencePacketId,
          clusterId: idea.clusterId,
          // Reuse the packet already loaded for grounding (avoids a second fetch);
          // packet-backed drafts then never web-search for sources.
          ...(loadedPacket
            ? {
                packetSources: loadedPacket.sources.map((s) => ({
                  url: s.url,
                  title: s.title,
                  domain: s.domain,
                })),
              }
            : {}),
        },
        sourceBudget,
      );
      if (woven.linksAdded > 0) {
        body = woven.body;
        logger.info({ slug, linksAdded: woven.linksAdded }, "Wove source citations into new draft");
      }
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), slug },
      "Source-link weaving failed during draft; continuing (failsafe backfill can add links later)",
    );
  }

  let heroImage: string;
  let shareImage: string | null = null;
  let feedImage: string | null = null;
  try {
    const generatedImages = await generateAndStoreHeroImage(
      { title: generated.title, dek: generated.dek, category: articleCategory, body },
      author as Author,
      slug,
      { articleId },
    );
    heroImage = generatedImages.heroImage;
    shareImage = generatedImages.shareImage;
    feedImage = generatedImages.feedImage;
  } catch (err) {
    logger.error({ err, slug }, "Hero image generation failed; using branded default card (no stock fallback)");
    heroImage = DEFAULT_SHARE_CARD_URL;
    shareImage = DEFAULT_SHARE_CARD_URL;
    feedImage = DEFAULT_SHARE_CARD_URL;
  }
  const readingTimeMinutes = readingTimeFromBody(body);

  // Generate the headline-hook kit + social pack alongside the draft. This is
  // best-effort: a failure here must never sink an otherwise-good article, so
  // we log and leave the columns NULL (the backfill job / regenerate endpoint
  // can fill them in later, and resolution falls back to the plain headline).
  let hookKit: GeneratedHookKit | null = null;
  try {
    hookKit = await generateHooksAndSocialPack(author as Author, {
      title: draftTitle,
      dek: generated.dek,
      category: articleCategory,
      body,
    }, { articleId });
  } catch (err) {
    if (err instanceof AiFunctionDisabledError) {
      logger.info({ slug }, "Hook/social-pack generation paused; leaving columns null");
    } else {
      logger.error({ err, slug }, "Hook/social-pack generation failed; leaving columns null");
    }
  }

  // Bake the strongest hook into the visible headline automatically so drafts
  // never ship with a bland, formulaic title. The model-chosen hook becomes the
  // article's actual `title`, which propagates to the on-page H1, listing cards,
  // related rails, and share intents (all of which key off `title`, not the
  // article-only hook columns). The slug and dedupe already ran against the
  // literal `draftTitle` above, so headline styling never destabilizes the URL
  // or duplicate detection, and the <title>/search title still resolves to the
  // keyword-forward plain_seo hook. Falls back to draftTitle if the kit failed.
  let headlineTitle = draftTitle;
  if (hookKit) {
    const chosen = hookKit.hookVariants.find((v) => v.mode === hookKit.headlineMode)?.text.trim();
    if (chosen) headlineTitle = chosen;
  }

  // Reserve a publish slot at least 72h out (target 72–96h) while the article
  // stays in `draft` for review. This is the slot the 48h auto-lock will lock
  // into if no editor touches the draft. If no free slot is found we leave it
  // null — the auto-lock's edge-case handler will assign one when it fires.
  const scheduledFor = await assignDraftScheduleSlot(author as Author);

  const [inserted] = await db
    .insert(articlesTable)
    .values({
      id: articleId,
      slug,
      authorId: author.id,
      ideaId: idea.id,
      title: headlineTitle,
      titleCandidates,
      dek: generated.dek,
      category: articleCategory,
      categorySlug: articleCategorySlug,
      body,
      heroImage,
      shareImage,
      feedImage,
      readingTimeMinutes,
      status: "draft",
      ...(hookKit
        ? {
            hookVariants: hookKit.hookVariants,
            hookAssignments: hookKit.hookAssignments,
            socialPack: hookKit.socialPack,
          }
        : {}),
      ...(scheduledFor ? { scheduledFor } : {}),
      ...(idea.continuesArticleId ? { continuesArticleId: idea.continuesArticleId } : {}),
      // Evidence lineage carried from the promoting idea (Editor Cockpit only).
      ...(idea.evidencePacketId ? { evidencePacketId: idea.evidencePacketId } : {}),
      ...(idea.clusterId ? { clusterId: idea.clusterId } : {}),
      // Cross-sectional secondary subjects (Task #258): admin-only metadata,
      // carried from the idea. Never affects reader-facing placement.
      ...(idea.secondaryBeats && idea.secondaryBeats.length > 0
        ? { secondaryBeats: idea.secondaryBeats }
        : {}),
      ...(opts.editorialLabelOverride ? { editorialLabelOverride: opts.editorialLabelOverride } : {}),
    })
    .returning();

  // Post-draft evidence verification (#201): when this draft was grounded on a
  // locked evidence packet, check the finished draft against that SAME packet and
  // quarantine it for a human if the draft asserts anything the packet doesn't
  // support. Best-effort — never let a verifier hiccup break the draft pipeline.
  if (loadedPacket && inserted) {
    try {
      const { verifyPacketGroundedDraft } = await import("./editorialScreen");
      await verifyPacketGroundedDraft({
        articleId: inserted.id,
        title: inserted.title,
        body,
        packet: loadedPacket,
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), articleId: inserted.id },
        "post-draft verification failed; draft left unverified",
      );
    }
  }

  await db
    .update(topicIdeasTable)
    .set({
      status: "used",
      ...(groundingOutcome ? { draftGroundingOutcome: groundingOutcome } : {}),
      // If a controlled harvest ran on this attempt (Task #239), record what it
      // surfaced so the editor can see the retry succeeded *because* the harvest
      // populated the Vault (vs an unrelated grounding).
      ...(harvest ? { notes: summarizeHarvestForNote(harvest) } : {}),
      updatedAt: new Date(),
    })
    .where(eq(topicIdeasTable.id, idea.id));

  // Post-draft: classify + route every outbound URL from the article body into
  // the Source Vault and write the article_sources graph — same pattern as the
  // back-catalog harvest (backCatalogHarvest.ts). Best-effort, fire-safe — ingest
  // failure must never fail the draft. sourcesHarvestedAt is only stamped when
  // ALL links were fully routed (all-or-null rule, mirrors back-catalog semantics).
  if (inserted) {
    const insertedId = inserted.id;
    const articleBody = body;
    const articleCatSlug = articleCategorySlug ?? null;
    void (async () => {
      try {
        const routed = await routeArticleLinksIntoGraph(insertedId, articleBody, articleCatSlug);
        if (routed.linksFound === 0) return;
        // Snapshot true-citation metadata (source title/author/date) from any
        // vault docs the new rows matched — free, idempotent, DB-only.
        await copyVaultCitationMetadata();
        // Citation notes ("evidence map", Task #273): one batched Haiku call
        // writing the "why it's included" sentence for the new evidence rows.
        // Best-effort — a pause (AiFunctionDisabledError) or API error just
        // leaves notes NULL (renders nothing); the admin backfill can top up.
        try {
          await generateCitationNotesForArticle(insertedId);
        } catch (err) {
          if (err instanceof AiFunctionDisabledError) {
            logger.info({ articleId: insertedId }, "post-draft: citation notes paused — skipped");
          } else {
            logger.warn({ err, articleId: insertedId }, "post-draft: citation notes failed");
          }
        }
      } catch (err) {
        logger.warn({ err, articleId: insertedId }, "post-draft: vault ingest step failed");
      }
    })();
  }

  // If this article originated from a Trend Radar signal, link the signal back
  // to the final article. The signal was tied to the idea at consume time (the
  // article didn't exist yet); now that it does, populate trend_signals.articleId
  // so the signal→idea→article provenance is complete. No-op for non-trend ideas
  // (no signal references this ideaId).
  await db
    .update(trendSignalsTable)
    .set({ articleId: inserted!.id, updatedAt: new Date() })
    .where(eq(trendSignalsTable.ideaId, idea.id));

  return inserted;
}

/**
 * Recent author titles + deks to pass to the idea generator so it doesn't
 * propose things we've already covered.
 */
async function recentTitlesForAuthor(_authorId: string, limit = 60): Promise<string[]> {
  // We dedupe across the whole magazine, not just per-author. Many beats overlap
  // (e.g. neuroscience appears in both psychology and longevity), so an author
  // must avoid concepts that any other author has already covered or proposed.
  const [articleRows, ideaRows] = await Promise.all([
    db
      .select({ title: articlesTable.title, dek: articlesTable.dek })
      .from(articlesTable)
      .orderBy(desc(articlesTable.createdAt))
      .limit(limit),
    db
      .select({ title: topicIdeasTable.title, angle: topicIdeasTable.angle, status: topicIdeasTable.status })
      .from(topicIdeasTable)
      .orderBy(desc(topicIdeasTable.createdAt))
      .limit(limit),
  ]);
  const articleLines = articleRows.map((r) => `[article] ${r.title} — ${r.dek}`);
  const ideaLines = ideaRows
    .filter((r) => r.status !== "rejected")
    .map((r) => `[idea/${r.status}] ${r.title} — ${r.angle}`);
  return [...articleLines, ...ideaLines];
}

export { recentTitlesForAuthor };

/**
 * Returns the titles of the most recently published articles in a given
 * category, for use as cross-batch construction context in idea generation.
 * The caller passes these alongside avoidTitles so the model can see which
 * rhetorical shapes have already been used in this category and avoid
 * repeating the same silhouette even on a different subject.
 */
async function recentPublishedTitlesForCategory(categorySlug: string, limit = 15): Promise<string[]> {
  const rows = await db
    .select({ title: articlesTable.title })
    .from(articlesTable)
    .where(and(eq(articlesTable.categorySlug, categorySlug), eq(articlesTable.status, "published")))
    .orderBy(desc(articlesTable.publishedAt))
    .limit(limit);
  return rows.map((r) => r.title);
}

export { recentPublishedTitlesForCategory };

/**
 * Mark an idea as `drafting` and kick off draft generation as an unawaited
 * background task. Returns the updated idea row immediately so the route can
 * respond with 202 Accepted.
 *
 * On success the idea ends up `used` (set inside `runDraftArticleFromIdea`).
 * On `DuplicateArticleError` it ends up `rejected` (also set there).
 * On any other error we revert the idea back to `approved` and write the error
 * into `notes` so the editor can retry.
 */
export async function startDraftArticleFromIdea(
  authorId: string,
  ideaId: string,
  opts: { force?: boolean; forceHarvest?: boolean; editorialLabelOverride?: string | null } = {},
): Promise<typeof topicIdeasTable.$inferSelect> {
  const [author] = await db.select().from(authorsTable).where(eq(authorsTable.id, authorId)).limit(1);
  if (!author) throw new Error("Author not found");
  const [idea] = await db.select().from(topicIdeasTable).where(eq(topicIdeasTable.id, ideaId)).limit(1);
  if (!idea) throw new Error("Idea not found");

  // Atomic claim via the shared helper: only transition into `drafting` if the
  // idea isn't already being drafted. This guards against a double-click / two
  // admins launching two parallel background jobs for the same idea (which,
  // under force, would each produce a duplicate draft instead of being filtered
  // by dedupe). If no row is returned, another job already claimed it — return
  // its current state without starting a second job.
  const updated = await claimIdeaForDraft(idea.id);
  if (!updated) {
    const [current] = await db
      .select()
      .from(topicIdeasTable)
      .where(eq(topicIdeasTable.id, idea.id))
      .limit(1);
    logger.warn({ ideaId: idea.id }, "Draft already in progress; skipping duplicate background job");
    return current ?? idea;
  }

  // Fire-and-forget: do not await. Errors are logged inside the catch.
  void (async () => {
    try {
      await runDraftArticleFromIdea(author as Author, updated!, opts);
    } catch (err) {
      if (err instanceof DuplicateArticleError) {
        // runDraftArticleFromIdea already set status=rejected with notes.
        logger.warn(
          { ideaId: idea.id, conflict: err.conflictingTitle, score: err.score },
          "Background draft rejected as duplicate",
        );
      } else if (err instanceof IdeaHeldNeedsSourcesError) {
        // runDraftArticleFromIdea already set status=needs_sources with a note.
        logger.info({ ideaId: idea.id, reason: err.reason }, "Background draft held: not enough Vault evidence");
      } else if (err instanceof AiFunctionDisabledError) {
        logger.info({ ideaId: idea.id }, "Draft generation paused; idea left approved");
      } else {
        logger.error({ err, ideaId: idea.id }, "Background draft generation failed");
      }
      await revertDraftingIdeaAfterError(idea.id, err);
    }
  })();

  return updated!;
}

/**
 * Startup recovery: any idea left in `drafting` belongs to a previous server
 * process that died mid-job. Flip them back to `approved` so the editor can
 * retry. This is the safety net that makes in-process background work
 * acceptable at current scale.
 */
export async function recoverDraftingIdeas(): Promise<number> {
  const reverted = await db
    .update(topicIdeasTable)
    .set({
      status: "approved",
      notes: "Reverted from in-progress state on server startup — previous draft was interrupted.",
      updatedAt: new Date(),
    })
    .where(inArray(topicIdeasTable.status, ["drafting", "harvesting_sources"]))
    .returning({ id: topicIdeasTable.id });
  if (reverted.length > 0) {
    logger.warn({ count: reverted.length }, "Recovered orphaned drafting ideas on startup");
  }
  return reverted.length;
}

export async function regenerateArticleSection(
  articleId: string,
  blockIndex: number,
  instructions?: string,
): Promise<Article> {
  const [article] = await db.select().from(articlesTable).where(eq(articlesTable.id, articleId)).limit(1);
  if (!article) throw new Error("Article not found");
  const [author] = await db.select().from(authorsTable).where(eq(authorsTable.id, article.authorId)).limit(1);
  if (!author) throw new Error("Author not found");
  const body = article.body as ArticleBlock[];
  const target = body[blockIndex];
  if (!target) throw new Error("Block index out of range");
  // AI block writing only makes sense for prose blocks. image/relatedArticle
  // carry a URL/slug, not text — the UI hides the button for them, but guard the
  // route too so a direct API call can't produce nonsense for those types.
  if (target.type !== "paragraph" && target.type !== "heading" && target.type !== "pullquote") {
    const err = new Error(`AI writing is not available for ${target.type} blocks`);
    err.name = "BlockTypeNotWritableError";
    throw err;
  }
  const newBlock = await regenerateBlock(author as Author, {
    title: article.title,
    dek: article.dek,
    body,
    blockIndex,
    ...(instructions ? { instructions } : {}),
    articleId,
    ...(article.editorialLabelOverride ? { editorialLabelOverride: article.editorialLabelOverride } : {}),
  });
  const newBody = body.slice();
  newBody[blockIndex] = newBlock;
  const [updated] = await db
    .update(articlesTable)
    .set({ body: newBody, readingTimeMinutes: readingTimeFromBody(newBody), updatedAt: new Date() })
    .where(eq(articlesTable.id, articleId))
    .returning();
  return updated!;
}

// ---------------------------------------------------------------------------
// Publish-gate helpers
// ---------------------------------------------------------------------------

/**
 * For the given article, find the beat most topically adjacent to
 * `currentBeatSlug` by summing concept-beat affinity weights of the article's
 * mentioned concepts across all OTHER beats. Returns null when concept data is
 * absent or no adjacent beat passes the robustness floor.
 */
const MIN_ADJACENT_AFFINITY_SUM = 0.5;

async function findAdjacentBeat(articleId: string, currentBeatSlug: string): Promise<string | null> {
  const mentions = await db
    .select({ conceptId: articleConceptMentionsTable.conceptId })
    .from(articleConceptMentionsTable)
    .where(eq(articleConceptMentionsTable.articleId, articleId));
  if (mentions.length === 0) return null;

  const conceptIds = mentions.map((m) => m.conceptId);
  const rows = await db
    .select({
      beatSlug: conceptBeatAffinitiesTable.beatSlug,
      totalWeight: sql<number>`sum(${conceptBeatAffinitiesTable.weight})::real`,
    })
    .from(conceptBeatAffinitiesTable)
    .where(
      and(
        inArray(conceptBeatAffinitiesTable.conceptId, conceptIds),
        ne(conceptBeatAffinitiesTable.beatSlug, currentBeatSlug),
      ),
    )
    .groupBy(conceptBeatAffinitiesTable.beatSlug)
    .orderBy(desc(sql`sum(${conceptBeatAffinitiesTable.weight})`));

  const best = rows[0];
  if (!best || Number(best.totalWeight) < MIN_ADJACENT_AFFINITY_SUM) return null;
  return best.beatSlug;
}

/**
 * Kicked off as fire-and-forget when the publish gate quarantines an article as
 * a near-duplicate. Creates a new approved idea for an alternative author
 * (ranked by fewest recent assignments, different from the original), optionally
 * with the topically adjacent beat attached as a secondary beat to give the
 * redraft a differentiated angle, then immediately starts drafting it.
 *
 * The new draft goes through the full pipeline (evidence screening, draft-time
 * dedupe, publish gate again) so it may still be caught if the catalog evolves
 * further. Any failure here is logged but never rethrows — the quarantine of
 * the original article must not be undone.
 */
async function handlePublishDedupeReassignment(
  article: {
    id: string;
    title: string;
    dek: string | null;
    authorId: string;
    categorySlug: string;
    category: string;
  },
  conflictReason: string,
): Promise<void> {
  const ranked = await rankCoveringAuthors(article.categorySlug);
  const alternatives = ranked.filter((r) => r.author.id !== article.authorId);
  if (alternatives.length === 0) {
    logger.warn(
      { articleId: article.id, beatSlug: article.categorySlug },
      "publish-gate reassignment: no alternative author on beat — quarantine is final",
    );
    return;
  }
  const newAuthor = alternatives[0]!.author;

  const adjacentBeat = await findAdjacentBeat(article.id, article.categorySlug);

  const noteLines = [
    `Reassigned from publish-gate dedupe (original article ${article.id}).`,
    `Conflict: ${conflictReason}`,
    adjacentBeat
      ? `Sub-beat added: ${adjacentBeat} (topically adjacent to ${article.categorySlug}).`
      : null,
    `Original author: ${article.authorId}. Reassigned to: ${newAuthor.name}.`,
  ].filter((l): l is string => l != null);

  const [newIdea] = await db
    .insert(topicIdeasTable)
    .values({
      authorId: newAuthor.id,
      title: article.title,
      angle: article.dek ?? "",
      category: article.category,
      categorySlug: article.categorySlug,
      secondaryBeats: adjacentBeat ? [adjacentBeat] : null,
      status: "approved",
      notes: noteLines.join(" | "),
    })
    .returning();

  if (!newIdea) {
    logger.error({ articleId: article.id }, "publish-gate reassignment: failed to insert idea");
    return;
  }

  await startDraftArticleFromIdea(newAuthor.id, newIdea.id, { force: false });
  logger.info(
    {
      originalArticleId: article.id,
      newIdeaId: newIdea.id,
      newAuthorId: newAuthor.id,
      newAuthorName: newAuthor.name,
      adjacentBeat,
    },
    "publish-gate reassignment: redraft started",
  );
}

// ---------------------------------------------------------------------------

export async function publishDueArticles(now = new Date()): Promise<number> {
  // Pre-select all articles scheduled to publish so we can run per-article
  // checks before committing the bulk status transition.
  const due = await db
    .select({
      id: articlesTable.id,
      title: articlesTable.title,
      dek: articlesTable.dek,
      slug: articlesTable.slug,
      authorId: articlesTable.authorId,
      category: articlesTable.category,
      categorySlug: articlesTable.categorySlug,
      body: articlesTable.body,
      evidencePacketId: articlesTable.evidencePacketId,
      verificationReport: articlesTable.verificationReport,
    })
    .from(articlesTable)
    .where(
      and(
        eq(articlesTable.status, "scheduled"),
        sql`${articlesTable.scheduledFor} <= ${now}`,
        // Quarantined articles never auto-publish; a human clears the
        // quarantine (manual publish / clear action) as the explicit override.
        isNull(articlesTable.quarantinedAt),
      ),
    );

  if (due.length === 0) return 0;

  const s = await getSiteSettings();
  const toPublish: string[] = [];

  for (const article of due) {
    // Verification gate: a packet-grounded draft may only auto-publish with a
    // verification verdict that isn't quarantine-worthy. "Verification never
    // happened" (paused → status:"error" report, or a crashed verifier → no
    // report at all) is NOT the same as "verification passed" — those drafts
    // get one re-verification attempt here, and if it still can't produce a
    // clean verdict the article is HELD (stays scheduled; next tick retries;
    // a human can manually publish as the explicit override).
    if (article.evidencePacketId) {
      const { getPacket, verifyPacketGroundedDraft, shouldQuarantineReport } = await import(
        "./editorialScreen"
      );
      let report = article.verificationReport;
      if (!report || report.status === "error") {
        // Throttle paid re-verification: if the last attempt (skipped or
        // failed) was under an hour ago, hold without re-billing this tick.
        const lastAttempt = report?.checkedAt ? Date.parse(report.checkedAt) : NaN;
        if (Number.isFinite(lastAttempt) && now.getTime() - lastAttempt < 60 * 60 * 1000) {
          logger.info(
            { articleId: article.id },
            "publishDueArticles: holding unverified packet-grounded article (retry throttled)",
          );
          continue;
        }
        try {
          const packet = await getPacket(article.evidencePacketId);
          report = packet
            ? await verifyPacketGroundedDraft({
                articleId: article.id,
                title: article.title,
                body: article.body,
                packet,
              })
            : null;
        } catch (err) {
          logger.warn(
            { err, articleId: article.id },
            "publishDueArticles: publish-time re-verification failed",
          );
          report = null;
        }
      }
      if (!report || shouldQuarantineReport(report)) {
        // Hard failures were quarantined inside verifyPacketGroundedDraft and
        // will be excluded by the due query from now on; paused/crashed
        // verification just holds the slot.
        logger.warn(
          { articleId: article.id, reportStatus: report?.status ?? null },
          "publishDueArticles: holding packet-grounded article without a passing verification",
        );
        continue;
      }
    }
    // Source-coverage gate: packet-grounded articles must have at least one
    // evidence-role row in article_sources. Zero rows means the back-catalog
    // harvest never ran (or found no links to classify). Hold the article and
    // record the reason so editors can diagnose and run the coverage backfill.
    // The check is a cheap COUNT — never throws.
    if (article.evidencePacketId) {
      const [coverageRow] = await db
        .select({ evidenceCount: sql<number>`count(*)::int` })
        .from(articleSourcesTable)
        .where(and(eq(articleSourcesTable.articleId, article.id), eq(articleSourcesTable.role, "evidence")));
      const evidenceCount = coverageRow?.evidenceCount ?? 0;
      if (evidenceCount === 0) {
        logger.info(
          { articleId: article.id },
          "publishDueArticles: holding packet-grounded article — zero evidence sources in article_sources",
        );
        await db
          .update(articlesTable)
          .set({ holdReason: "no_evidence_sources", updatedAt: now })
          .where(eq(articlesTable.id, article.id));
        continue;
      }
    }
    if (s.publishGateDedupeEnabled) {
      let verdict: PublishGateVerdict;
      try {
        verdict = await checkPublishGateDedupe(article.id);
      } catch (err) {
        // Check failed: fail closed — hold this article for the next tick
        // rather than risk publishing a duplicate during a transient DB or
        // model failure. The scheduler will retry on the next cron tick.
        logger.warn(
          { err, articleId: article.id },
          "publishDueArticles: publish-gate dedupe error — holding article (fail closed)",
        );
        continue;
      }
      if (verdict.duplicate) {
        logger.info(
          { articleId: article.id, conflict: verdict.conflictTitle, reason: verdict.reason },
          "publishDueArticles: publish gate quarantined article as near-duplicate",
        );
        await db
          .update(articlesTable)
          .set({ quarantinedAt: now, updatedAt: now })
          .where(eq(articlesTable.id, article.id));
        void handlePublishDedupeReassignment(article, verdict.reason ?? "near-duplicate at publish gate").catch((e) =>
          logger.error({ err: e, articleId: article.id }, "publish-gate reassignment failed"),
        );
        continue;
      }
    }
    toPublish.push(article.id);
  }

  if (toPublish.length === 0) return 0;

  const result = await db
    .update(articlesTable)
    .set({ status: "published", publishedAt: now, updatedAt: now, holdReason: null })
    .where(inArray(articlesTable.id, toPublish))
    .returning({ id: articlesTable.id, slug: articlesTable.slug, authorId: articlesTable.authorId });

  if (result.length > 0) {
    // Write-time safeguard: never let a Google-Scholar / search-query link go
    // live. Legacy drafts (authored before draft-time sanitization) can sit
    // scheduled for weeks and slip past the daily published-only sweep, so the
    // strip runs HERE, at the moment of publish. Awaited (cheap string work)
    // so the article is clean before pings/auto-post fire.
    try {
      await sanitizeSearchLinksOnPublish(result.map((r) => r.id));
    } catch (e) {
      logger.warn({ err: e }, "publishDueArticles: search-link sanitation failed (publish unaffected)");
    }
    void pingArticleSlugs(result.map((r) => r.slug));
    // Auto-post each freshly-published article to Facebook (via Zernio).
    // Fire-and-forget and fully guarded: gated by the socialAutoPostEnabled site
    // setting + Zernio config, idempotent per article, and never throws — a
    // social-posting hiccup must not affect the publish that already succeeded.
    void autoPostPublished(result.map((r) => r.id));
    // Fire concept detection for each newly published article. Fire-and-forget:
    // concept pipeline failures must never roll back or delay a successful
    // publish. Import is lazy to avoid hoisting a heavy dependency at module
    // load time; the function itself guards against misconfiguration.
    void import("./conceptExplainer").then(({ processArticleConcepts }) =>
      Promise.all(
        result.map((r) =>
          processArticleConcepts(r.id, false).catch((err) =>
            logger.warn({ err, articleId: r.id }, "publishDue: concept processing failed (non-fatal)"),
          ),
        ),
      ),
    );
    // Rotation is a follow-up nicety: never let it undo or block a successful
    // publish. A failed rotation just leaves the author on their current day,
    // and they'll rotate on their next publish.
    try {
      await rotateAuthorsAfterPublish([...new Set(result.map((r) => r.authorId))], now);
    } catch (e) {
      logger.error({ err: e }, "Author rotation after publish failed; articles were still published");
    }
  }
  return result.length;
}

/**
 * Post-publish schedule randomization. Once an author's scheduled post
 * publishes, authors with `randomizeSchedule` on are moved to a *fresh* set of
 * publishing day(s) and a new random publish hour for their next cycle, keeping
 * their configured cadence. Authors with randomization off (fixed schedule) and
 * daily authors (no day to shuffle) are left untouched.
 *
 * For weekday-based cadences the new day(s) are chosen with a bias toward the
 * currently least-occupied days (see {@link pickRotatedWeekday}) so the week
 * stays evenly spread, while the specific days keep shifting over time. Monthly
 * authors get a fresh day-of-month. Runs once per author per publish tick (an
 * author with several pieces going live at once still rotates once).
 */
async function rotateAuthorsAfterPublish(authorIds: string[], now: Date): Promise<void> {
  if (authorIds.length === 0) return;
  const actives = await db
    .select({
      id: authorsTable.id,
      cadence: authorsTable.cadence,
      weekday: authorsTable.weekday,
      secondWeekday: authorsTable.secondWeekday,
      randomizeSchedule: authorsTable.randomizeSchedule,
    })
    .from(authorsTable)
    .where(eq(authorsTable.active, true));
  const counts = new Array<number>(7).fill(0);
  const byId = new Map<string, (typeof actives)[number]>();
  for (const a of actives) {
    byId.set(a.id, a);
    if (a.weekday !== null && a.weekday >= 0 && a.weekday <= 6) counts[a.weekday] += 1;
    if (a.cadence === "twice_weekly" && a.secondWeekday !== null && a.secondWeekday >= 0 && a.secondWeekday <= 6) {
      counts[a.secondWeekday] += 1;
    }
  }
  for (const authorId of authorIds) {
    const a = byId.get(authorId);
    if (!a) continue;
    // Fixed schedule (randomization off) or daily (no day to shuffle): leave as-is.
    if (!a.randomizeSchedule || a.cadence === "daily") continue;

    if (a.cadence === "monthly") {
      const dayOfMonth = pickRandomDayOfMonth();
      const runHourUtc = pickRandomHour();
      await db
        .update(authorsTable)
        .set({ dayOfMonth, runHourUtc, updatedAt: now })
        .where(eq(authorsTable.id, authorId));
      logger.info({ authorId, toDayOfMonth: dayOfMonth, runHourUtc }, "Rotated monthly author after publish");
      continue;
    }

    // Weekday-based cadences (weekly / biweekly / twice_weekly). Discount this
    // author's current day(s) so we don't bias against where they already sit,
    // then pick balanced new day(s) and re-occupy.
    const current = a.weekday;
    if (current !== null && counts[current]! > 0) counts[current]! -= 1;
    if (a.cadence === "twice_weekly" && a.secondWeekday !== null && counts[a.secondWeekday]! > 0) {
      counts[a.secondWeekday]! -= 1;
    }
    const weekday = pickRotatedWeekday(current, counts);
    counts[weekday]! += 1;
    const runHourUtc = pickRandomHour();
    const updates: Record<string, unknown> = { weekday, runHourUtc, updatedAt: now };
    if (a.cadence === "twice_weekly") {
      const secondWeekday = pickRotatedWeekday(weekday, counts);
      counts[secondWeekday]! += 1;
      updates["secondWeekday"] = secondWeekday;
    }
    await db.update(authorsTable).set(updates).where(eq(authorsTable.id, authorId));
    logger.info(
      { authorId, cadence: a.cadence, fromWeekday: current, toWeekday: weekday, runHourUtc },
      "Rotated author to a new weekday/hour after publish",
    );
  }
}

/** A draft is auto-locked into its slot after this long with no editor edits. */
const AUTO_LOCK_AFTER_MS = 48 * 60 * 60 * 1000;

/**
 * Per-author *approved-idea* cap. Idea generation is the valve that creates new
 * topic ideas; once an author's bank of `approved` (ready-to-draft) ideas reaches
 * this many, the system stops generating MORE ideas for them. The bank drains
 * naturally because the pipeline drafts one approved idea per run (approved →
 * used), so generation auto-resumes once the count falls back below the cap.
 * Drafting is deliberately NOT gated — it's the only thing that drains the bank,
 * so pausing the author entirely would deadlock the auto-resume.
 */
export const MAX_APPROVED_IDEAS = 20;

/**
 * The effective approved-idea cap, read from site settings (admin-configurable
 * on /admin/settings). Falls back to {@link MAX_APPROVED_IDEAS} if unset. Call
 * this at request time instead of referencing the constant so changes take
 * effect without a redeploy.
 */
export async function getApprovedIdeaCap(): Promise<number> {
  const { approvedIdeaCap } = await getSiteSettings();
  return approvedIdeaCap > 0 ? approvedIdeaCap : MAX_APPROVED_IDEAS;
}

/** Count an author's bank of approved (ready-to-draft) ideas. */
export async function countApprovedIdeas(authorId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(topicIdeasTable)
    .where(
      and(
        eq(topicIdeasTable.authorId, authorId),
        eq(topicIdeasTable.status, "approved"),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * Safety net for unattended drafts: any `draft` article whose last edit
 * (`updatedAt`) is at least 48h ago is flipped to `scheduled`, keeping its
 * reserved `scheduled_for` so the normal publish-due job ships it at its
 * scheduled time. It does NOT publish early — the slot is always 24h+ beyond
 * the 48h lock by construction.
 *
 * Edge case: if the draft's `scheduled_for` is missing or already in the past
 * (e.g. repeated late edits pushed the lock past the original slot), assign
 * the next valid future cadence slot when locking so it never gets stuck or
 * published with a stale time.
 *
 * Editing a draft bumps `updatedAt` (PATCH/regenerate routes do this), which
 * restarts the 48h countdown. Manually scheduling moves the article out of
 * `draft`, so it naturally leaves the timer.
 */
export async function autoLockStaleDrafts(
  now: Date = new Date(),
  opts: { enabled?: boolean; afterHours?: number } = {},
): Promise<number> {
  if (opts.enabled === false) return 0;
  const afterMs =
    opts.afterHours && opts.afterHours > 0 ? opts.afterHours * 60 * 60 * 1000 : AUTO_LOCK_AFTER_MS;
  const cutoff = new Date(now.getTime() - afterMs);
  const stale = await db
    .select()
    .from(articlesTable)
    .where(and(eq(articlesTable.status, "draft"), sql`${articlesTable.updatedAt} <= ${cutoff}`));

  let locked = 0;
  for (const article of stale) {
    if (await lockDraftIntoSlot(article, now)) locked += 1;
  }
  if (locked > 0) {
    logger.info({ locked }, "Auto-locked unattended drafts into their scheduled slots");
  }
  return locked;
}

/**
 * Lock a single draft into a `scheduled` slot. Reuses the draft's reserved
 * `scheduled_for` when it's still in the future; otherwise assigns the next free
 * cadence slot. Recomputes the author's occupied slots on every call, so locking
 * a batch of drafts sequentially never double-books a slot. The final UPDATE is
 * guarded on `status = 'draft'` so a concurrent edit/schedule/publish can't be
 * clobbered. Returns true only when this call performed the lock.
 *
 * Shared by the 48h {@link autoLockStaleDrafts} safety net and the admin
 * "force schedule now" actions ({@link forceScheduleDraft} /
 * {@link forceScheduleAllDrafts}), which apply the same logic on demand without
 * the staleness gate.
 */
async function lockDraftIntoSlot(
  article: typeof articlesTable.$inferSelect,
  now: Date,
): Promise<boolean> {
  let scheduledFor = article.scheduledFor ? new Date(article.scheduledFor) : null;
  if (!scheduledFor || scheduledFor.getTime() <= now.getTime()) {
    const [author] = await db
      .select()
      .from(authorsTable)
      .where(eq(authorsTable.id, article.authorId))
      .limit(1);
    if (!author) {
      logger.error({ articleId: article.id }, "lockDraftIntoSlot: author missing, skipping");
      return false;
    }
    const occupied = await reservedSlotKeysForAuthor(article.authorId, article.id);
    scheduledFor = nextFreeSlot(author as Author, now, occupied);
    if (!scheduledFor) {
      logger.error({ articleId: article.id }, "lockDraftIntoSlot: no free slot found, skipping");
      return false;
    }
  }
  // Guard against a concurrent edit/schedule racing us: only lock if still a draft.
  const [updated] = await db
    .update(articlesTable)
    .set({ status: "scheduled", scheduledFor, updatedAt: now })
    .where(and(eq(articlesTable.id, article.id), eq(articlesTable.status, "draft")))
    .returning({ id: articlesTable.id });
  return Boolean(updated);
}

/**
 * Force one draft into its scheduled slot immediately, on admin request, without
 * waiting for the 48h auto-lock. No-op (returns null) when the article doesn't
 * exist, isn't a draft, or no slot could be assigned. Returns the updated row.
 */
export async function forceScheduleDraft(
  articleId: string,
  now: Date = new Date(),
): Promise<typeof articlesTable.$inferSelect | null> {
  const [article] = await db.select().from(articlesTable).where(eq(articlesTable.id, articleId)).limit(1);
  if (!article || article.status !== "draft") return null;
  if (!(await lockDraftIntoSlot(article, now))) return null;
  const [updated] = await db.select().from(articlesTable).where(eq(articlesTable.id, articleId)).limit(1);
  return updated ?? null;
}

/**
 * Raised by {@link reassignArticleAuthor} for caller-facing failures. `status`
 * carries the HTTP code the route should map it to.
 */
export class ReassignAuthorError extends Error {
  readonly name = "ReassignAuthorError";
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Reassign an existing article to a different author.
 *
 * - The target author must exist, else a {@link ReassignAuthorError} (400).
 * - **draft**: just swap the author. The draft keeps any tentative
 *   `scheduled_for`; it re-derives a valid slot for the new author at auto-lock,
 *   so no slot recompute is needed here (per spec: no scheduling side effects).
 * - **scheduled**: the old slot belongs to the *old* author's weekday/hour and
 *   may collide with the new author's bookings, so we move the article onto the
 *   next free cadence slot for the new author (>= MIN_SCHEDULE_LEAD_MS out). If
 *   no slot is free a {@link ReassignAuthorError} (409) is thrown so the editor
 *   can re-pick a slot.
 * - **published**: just swap the author; the new byline shows immediately and we
 *   re-ping the slug so search engines re-crawl.
 *
 * Reassigning to the same author is a no-op (returns the row unchanged).
 */
export async function reassignArticleAuthor(
  articleId: string,
  newAuthorId: string,
  now: Date = new Date(),
): Promise<typeof articlesTable.$inferSelect> {
  const [article] = await db.select().from(articlesTable).where(eq(articlesTable.id, articleId)).limit(1);
  if (!article) throw new ReassignAuthorError("Article not found", 404);
  if (article.authorId === newAuthorId) return article;

  const [author] = await db.select().from(authorsTable).where(eq(authorsTable.id, newAuthorId)).limit(1);
  if (!author) throw new ReassignAuthorError("Unknown author", 400);

  const update: Record<string, unknown> = { authorId: newAuthorId, updatedAt: now };

  if (article.status === "scheduled") {
    // The existing slot was reserved against the OLD author. Recompute a valid
    // slot for the new author so we never keep an off-cadence slot or collide
    // with the new author's own scheduled/draft bookings.
    const occupied = await reservedSlotKeysForAuthor(newAuthorId, article.id);
    const minTime = new Date(now.getTime() + MIN_SCHEDULE_LEAD_MS);
    const slot = nextFreeSlot(author as Author, minTime, occupied);
    if (!slot) {
      throw new ReassignAuthorError(
        "No free schedule slot for the new author — re-pick a slot after reassigning.",
        409,
      );
    }
    update.scheduledFor = slot;
  }

  const [updated] = await db
    .update(articlesTable)
    .set(update)
    .where(eq(articlesTable.id, articleId))
    .returning();
  if (!updated) throw new ReassignAuthorError("Article not found", 404);
  if (updated.status === "published") void pingArticleSlugs([updated.slug]);
  logger.info(
    { articleId, fromAuthor: article.authorId, toAuthor: newAuthorId, status: updated.status },
    "Reassigned article to a different author",
  );
  return updated;
}

/**
 * Force every current draft into its scheduled slot immediately (the on-demand
 * equivalent of {@link autoLockStaleDrafts} with no staleness gate). Slots are
 * assigned sequentially so the batch never double-books an author. Returns the
 * number of drafts that were locked.
 */
export async function forceScheduleAllDrafts(
  now: Date = new Date(),
): Promise<{ scheduled: number; skippedNoSources: number }> {
  const drafts = await db.select().from(articlesTable).where(eq(articlesTable.status, "draft"));

  // Batch-fetch evidence source counts for every packet-grounded draft so we
  // can filter in one query instead of N per-article round-trips.
  const groundedIds = drafts
    .filter((a) => a.evidencePacketId != null)
    .map((a) => a.id);
  const evidenceCounts = groundedIds.length > 0
    ? await db
        .select({ articleId: articleSourcesTable.articleId, cnt: sql<number>`count(*)::int` })
        .from(articleSourcesTable)
        .where(
          and(
            inArray(articleSourcesTable.articleId, groundedIds),
            eq(articleSourcesTable.role, "evidence"),
          ),
        )
        .groupBy(articleSourcesTable.articleId)
    : [];
  const evidenceByArticle = new Map(evidenceCounts.map((r) => [r.articleId, Number(r.cnt)]));

  let scheduled = 0;
  let skippedNoSources = 0;
  for (const article of drafts) {
    if (article.evidencePacketId != null) {
      const count = evidenceByArticle.get(article.id) ?? 0;
      if (count === 0) {
        skippedNoSources += 1;
        continue;
      }
    }
    if (await lockDraftIntoSlot(article, now)) scheduled += 1;
  }
  if (scheduled > 0 || skippedNoSources > 0) {
    logger.info(
      { scheduled, skippedNoSources },
      "Force-scheduled drafts into their slots on admin request",
    );
  }
  return { scheduled, skippedNoSources };
}

/**
 * Realign an author's pending articles after their schedule definition
 * (cadence / weekday / run hour) changes, so the calendar reflects the new
 * cadence instead of keeping slots derived from the old one:
 *
 * - **daily**: re-pack every pending article that holds a slot — `scheduled`
 *   rows and `draft` rows with a reserved `scheduled_for` — onto consecutive
 *   daily slots starting one lead-time out, oldest first. This actually "runs"
 *   the daily schedule, filling the calendar day by day.
 * - **non-daily** (weekly / biweekly / twice_weekly / monthly): drop any slot
 *   that no longer sits on the author's cadence (day + run hour). `scheduled`
 *   rows move back to `draft` (slot cleared); drafts simply lose their stale
 *   reserved slot. They re-acquire a sparse slot through the normal auto-lock /
 *   projection path.
 *
 * Low-volume admin action — run inline. Returns counts for logging.
 */
export async function reslotAuthorSchedule(
  authorId: string,
  now: Date = new Date(),
): Promise<{ rescheduled: number; unscheduled: number }> {
  // Run the whole realign atomically so a mid-loop failure can't leave the
  // author's backlog half-reslotted, and every UPDATE is guarded on the row
  // still being pending (draft/scheduled) so a concurrent publish can never be
  // clobbered (no rewriting scheduled_for on a row that just went published).
  return db.transaction(async (tx) => {
    const [author] = await tx
      .select()
      .from(authorsTable)
      .where(eq(authorsTable.id, authorId))
      .limit(1);
    if (!author) return { rescheduled: 0, unscheduled: 0 };

    const pending = await tx
      .select()
      .from(articlesTable)
      .where(
        and(
          eq(articlesTable.authorId, authorId),
          inArray(articlesTable.status, ["draft", "scheduled"]),
          isNotNull(articlesTable.scheduledFor),
        ),
      )
      .orderBy(asc(articlesTable.scheduledFor));

    if (author.cadence === "daily") {
      const minTime = new Date(now.getTime() + MIN_SCHEDULE_LEAD_MS);
      const occupied = new Set<string>();
      let rescheduled = 0;
      for (const a of pending) {
        const slot = nextFreeSlot(author as Author, minTime, occupied);
        if (!slot) break;
        occupied.add(slotKey(authorId, slot));
        const current = a.scheduledFor ? new Date(a.scheduledFor).getTime() : null;
        if (current === slot.getTime()) continue; // already on the right slot — no move, don't count
        const [u] = await tx
          .update(articlesTable)
          .set({ scheduledFor: slot, updatedAt: now })
          .where(and(eq(articlesTable.id, a.id), inArray(articlesTable.status, ["draft", "scheduled"])))
          .returning({ id: articlesTable.id });
        if (u) rescheduled += 1;
      }
      if (rescheduled > 0) {
        logger.info({ authorId, rescheduled }, "Re-packed author onto daily cadence after schedule change");
      }
      return { rescheduled, unscheduled: 0 };
    }

    // Non-daily cadences (weekly / biweekly / twice_weekly / monthly): the slots
    // are scarce, so rather than re-pack we just shed any pending event that no
    // longer sits on the author's cadence back to draft. forceScheduleAllDrafts
    // (called after reslot in reconcile) then re-locks them into fresh slots.
    const spec = {
      cadence: author.cadence,
      weekday: author.weekday,
      secondWeekday: author.secondWeekday ?? null,
      dayOfMonth: author.dayOfMonth ?? null,
      runHourUtc: author.runHourUtc ?? 14,
    };
    let unscheduled = 0;
    for (const a of pending) {
      const d = new Date(a.scheduledFor!);
      if (slotMatchesCadence(spec, d)) continue;
      if (a.status === "scheduled") {
        const [u] = await tx
          .update(articlesTable)
          .set({ status: "draft", scheduledFor: null, updatedAt: now })
          .where(and(eq(articlesTable.id, a.id), eq(articlesTable.status, "scheduled")))
          .returning({ id: articlesTable.id });
        if (u) unscheduled += 1;
      } else {
        await tx
          .update(articlesTable)
          .set({ scheduledFor: null, updatedAt: now })
          .where(and(eq(articlesTable.id, a.id), eq(articlesTable.status, "draft")));
      }
    }
    if (unscheduled > 0) {
      logger.info({ authorId, unscheduled }, "Unscheduled off-cadence events after cadence change");
    }
    return { rescheduled: 0, unscheduled };
  });
}

/**
 * Force-rebuild the whole publishing schedule on admin request — the on-demand
 * "repair" the schedule view exposes when scheduling looks stalled. It is purely
 * a DB reshuffle (no LLM, no early publishing):
 *
 * 1. For every active author, {@link reslotAuthorSchedule} realigns their pending
 *    articles to their *current* cadence (daily authors get re-packed onto
 *    consecutive slots; weekly authors shed off-cadence slots back to draft).
 * 2. {@link forceScheduleAllDrafts} then locks every remaining draft — including
 *    the ones step 1 just demoted from weekly — into its next free cadence slot.
 *
 * Approved ideas are intentionally left alone: turning ideas into drafts is the
 * editorial pipeline's job (LLM generation), not a schedule reshuffle. Returns
 * aggregate counts for the toast/logging.
 */
export async function reconcileAllSchedules(
  now: Date = new Date(),
): Promise<{ authors: number; rescheduled: number; unscheduled: number; scheduled: number; skippedNoSources: number }> {
  const authors = await db.select({ id: authorsTable.id }).from(authorsTable).where(eq(authorsTable.active, true));
  let rescheduled = 0;
  let unscheduled = 0;
  for (const a of authors) {
    const r = await reslotAuthorSchedule(a.id, now);
    rescheduled += r.rescheduled;
    unscheduled += r.unscheduled;
  }
  const { scheduled, skippedNoSources } = await forceScheduleAllDrafts(now);
  logger.info(
    { authors: authors.length, rescheduled, unscheduled, scheduled, skippedNoSources },
    "Reconciled publishing schedule on admin request",
  );
  return { authors: authors.length, rescheduled, unscheduled, scheduled, skippedNoSources };
}

// A Drizzle transaction handle (same query-builder surface as `db`), derived
// from db.transaction's callback so we don't import internal pg types.
type ArticleDateTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Extract internal-link target slugs (`/article/<slug>`) from a body's prose. */
function internalLinkSlugs(body: ArticleBlock[]): string[] {
  const slugs: string[] = [];
  for (const block of body) {
    if (block.type !== "paragraph" || typeof block.content !== "string") continue;
    for (const m of block.content.matchAll(INTERNAL_LINK_RE)) {
      const href = m[2] ?? "";
      const rawSlug = href.replace(/^\/article\//, "").split(/[?#]/)[0] ?? "";
      let slug = rawSlug;
      try {
        slug = decodeURIComponent(rawSlug);
      } catch {
        slug = rawSlug;
      }
      if (slug) slugs.push(slug);
    }
  }
  return slugs;
}

/**
 * Enforce truthful publish-date floors across all published articles, then
 * re-spread the dates that violate their floor across each article's legal
 * window `[floor, now]` so the archive stays naturally spread (not bunched at
 * creation dates) while never claiming a date earlier than the events a piece
 * reports on.
 *
 * Per-article floor = max(
 *   - its own real `createdAt` (the article was authored after the events it
 *     covers, and `createdAt` was never randomized — the bulletproof lower bound),
 *   - the finalized `publishedAt` of its `continues_article_id` parent (if any).
 * )
 *
 * In-body `/article/<slug>` links are deliberately NOT a floor. The internal-link
 * backfill densely cross-links the catalog in both directions, so a link floor
 * chains nearly every article up to the newest one's date and collapses the whole
 * archive into the last few days (observed in prod: 301/308 articles "published"
 * within a week while creations spanned six months). Retroactively added links
 * are normal editorial practice — an older piece linking to a newer one is
 * covered by `updatedAt` (dateModified), which this function always keeps
 * `>= publishedAt` and fresh whenever a date is touched.
 *
 * Two phases. Phase 1 walks articles in `createdAt` order, applying createdAt +
 * continuation-parent floors with even spacing. Phase 2 is a fixpoint that
 * repeatedly raises any article still dated before its continuation parent
 * (continuations are normally created after their parent, so this is a cheap
 * safety net for out-of-order creation); dates only ever move later and are
 * capped at `now`, so it converges.
 *
 * Modes:
 *  - `keepSafe: true`  (repair/migration): an article whose current `publishedAt`
 *    already meets its floor is kept unchanged; only violators are re-spread.
 *  - `keepSafe: false` (admin "randomize dates"): every published article is
 *    re-spread within its legal window.
 *
 * Re-spread placement advances through the remaining window so dates fill
 * `[floor, now]` evenly (with jitter + random time-of-day) instead of pinning to
 * the floor; a running high-water mark keeps reassigned dates in createdAt order.
 * `updatedAt = min(now, max(newPublishedAt, existingUpdatedAt))` so `dateModified`
 * is never earlier than `datePublished`. Runs against the supplied transaction.
 */
export async function enforceTruthfulArticleDates(
  tx: ArticleDateTx,
  now: Date = new Date(),
  opts: { keepSafe?: boolean } = {},
): Promise<{ reassigned: number; kept: number; violations: number; earliest: string | null; latest: string | null }> {
  const keepSafe = opts.keepSafe !== false;
  const rows = await tx
    .select({
      id: articlesTable.id,
      createdAt: articlesTable.createdAt,
      publishedAt: articlesTable.publishedAt,
      updatedAt: articlesTable.updatedAt,
      continuesArticleId: articlesTable.continuesArticleId,
    })
    .from(articlesTable)
    .where(eq(articlesTable.status, "published"))
    // Secondary key makes ordering deterministic when articles share a createdAt
    // (same generation burst), so the monotonic re-spread is reproducible.
    .orderBy(asc(articlesTable.createdAt), asc(articlesTable.id));
  if (rows.length === 0) return { reassigned: 0, kept: 0, violations: 0, earliest: null, latest: null };

  const nowMs = now.getTime();
  const finalById = new Map<string, number>();

  // Estimate the cohort size that drives even spacing. In keepSafe mode that's
  // the floor violators (current publishedAt missing or before createdAt); when
  // randomizing every row is reassigned.
  const cohort = keepSafe
    ? rows.filter((r) => {
        const c = r.createdAt ? r.createdAt.getTime() : 0;
        const p = r.publishedAt ? r.publishedAt.getTime() : null;
        return p === null || p < c;
      }).length
    : rows.length;
  const M = Math.max(cohort, 1);

  const originalById = new Map<string, number | null>();

  let prev = 0; // high-water mark keeps reassigned dates in createdAt order
  let reassignedIdx = 0;

  // Phase 1: assign each article a date in createdAt order, applying createdAt +
  // continuation-parent floors, with even spacing across the remaining window.
  // In-body links are intentionally NOT floors (see docstring).
  for (const r of rows) {
    // Postgres stores created_at to MICROsecond precision but JS Dates only
    // carry milliseconds, so getTime() truncates DOWN — a floor equal to that
    // truncated value can sit sub-millisecond BEFORE the real created_at at the
    // SQL level. Round the createdAt floor UP to the next full second so
    // published_at >= created_at holds under any precision.
    const createdMs = r.createdAt ? Math.ceil(r.createdAt.getTime() / 1000) * 1000 : 0;
    let floor = createdMs;
    if (r.continuesArticleId) {
      const parentFinal = finalById.get(r.continuesArticleId);
      if (parentFinal !== undefined) floor = Math.max(floor, parentFinal);
    }
    if (floor > nowMs) floor = nowMs;

    const currentMs = r.publishedAt ? r.publishedAt.getTime() : null;
    originalById.set(r.id, currentMs);
    let finalMs: number;
    if (keepSafe && currentMs !== null && currentMs >= floor) {
      finalMs = currentMs;
    } else {
      const lo = Math.max(floor, prev);
      if (lo >= nowMs) {
        finalMs = nowMs;
      } else {
        const remaining = Math.max(M - reassignedIdx, 1);
        const step = (nowMs - lo) / remaining;
        let ts = lo + step * (0.4 + Math.random() * 1.2);
        const d = new Date(ts);
        d.setUTCHours(
          6 + Math.floor(Math.random() * 17),
          Math.floor(Math.random() * 60),
          Math.floor(Math.random() * 60),
          0,
        );
        ts = d.getTime();
        if (ts < lo) ts = lo;
        if (ts > nowMs) ts = nowMs;
        finalMs = ts;
      }
      prev = finalMs;
      reassignedIdx += 1;
    }

    finalById.set(r.id, finalMs);
  }

  // Phase 2: fixpoint enforcing any continuation-parent floor the single
  // createdAt-ordered pass couldn't see (a parent created AFTER its
  // continuation — abnormal, but cheap to guard). Dates only ever increase and
  // are capped at `now`, so this converges.
  const maxPasses = rows.length + 1;
  let changed = true;
  let passes = 0;
  while (changed && passes < maxPasses) {
    changed = false;
    passes += 1;
    for (const r of rows) {
      const current = finalById.get(r.id)!;
      let floor = current;
      if (r.continuesArticleId) {
        const parentFinal = finalById.get(r.continuesArticleId);
        if (parentFinal !== undefined) floor = Math.max(floor, parentFinal);
      }
      if (floor > nowMs) floor = nowMs;
      if (floor > current) {
        finalById.set(r.id, floor);
        changed = true;
      }
    }
  }
  if (changed) {
    // Should be unreachable: dates only increase and are capped at `now`, so the
    // fixpoint must settle within `maxPasses`. Log loudly if it ever doesn't.
    logger.warn({ passes, rows: rows.length }, "Truthful-date fixpoint did not converge");
  }

  // Tally + build the write set once dates have stabilized. An article whose
  // phase-1 "kept" date got raised by the fixpoint counts as reassigned.
  let reassigned = 0;
  let kept = 0;
  let earliest: number | null = null;
  let latest: number | null = null;
  const updates: { id: string; publishedAt: Date; updatedAt: Date }[] = [];
  for (const r of rows) {
    const finalMs = finalById.get(r.id)!;
    const currentMs = originalById.get(r.id) ?? null;
    if (currentMs !== null && currentMs === finalMs) kept += 1;
    else reassigned += 1;
    if (earliest === null || finalMs < earliest) earliest = finalMs;
    if (latest === null || finalMs > latest) latest = finalMs;

    const existingUpdated = r.updatedAt ? r.updatedAt.getTime() : finalMs;
    const newUpdated = Math.min(nowMs, Math.max(finalMs, existingUpdated));
    const pubChanged = currentMs === null || currentMs !== finalMs;
    const updChanged = !r.updatedAt || r.updatedAt.getTime() !== newUpdated;
    if (pubChanged || updChanged) {
      updates.push({ id: r.id, publishedAt: new Date(finalMs), updatedAt: new Date(newUpdated) });
    }
  }

  for (const u of updates) {
    await tx
      .update(articlesTable)
      .set({ publishedAt: u.publishedAt, updatedAt: u.updatedAt })
      .where(eq(articlesTable.id, u.id));
  }

  // Verification (proof, not a fix): recompute from the stabilized dates and
  // count any row still violating a truthfulness constraint — (a) published <
  // createdAt, (b) published < continuation-parent published. By construction
  // this is 0; surface it so the migration/admin caller can assert/log it.
  let violations = 0;
  for (const r of rows) {
    const finalMs = finalById.get(r.id)!;
    const createdMs = r.createdAt ? r.createdAt.getTime() : 0;
    if (finalMs < Math.min(createdMs, nowMs)) {
      violations += 1;
      continue;
    }
    if (r.continuesArticleId) {
      const parentFinal = finalById.get(r.continuesArticleId);
      if (parentFinal !== undefined && finalMs < parentFinal) {
        violations += 1;
        continue;
      }
    }
  }
  if (violations > 0) {
    logger.warn({ violations, rows: rows.length }, "Truthful-date enforcement left residual violations");
  }

  return {
    reassigned,
    kept,
    violations,
    earliest: earliest === null ? null : new Date(earliest).toISOString(),
    latest: latest === null ? null : new Date(latest).toISOString(),
  };
}

/**
 * Admin "randomize dates" action: re-spread every published article's
 * `publishedAt`/`updatedAt` within each article's legal window `[floor, now]`
 * (see {@link enforceTruthfulArticleDates}). Floor-aware, so a run can never
 * backdate an article before its real `createdAt` or before an article it
 * continues. Runs in one transaction; overwrites real publish dates and cannot
 * be undone — a deliberate maintenance action.
 */
export async function randomizeArticleDates(
  now: Date = new Date(),
): Promise<{ updated: number; earliest: string | null; latest: string | null }> {
  const result = await db.transaction((tx) => enforceTruthfulArticleDates(tx, now, { keepSafe: false }));
  logger.info({ updated: result.reassigned }, "Randomized published article dates within legal floors");
  return { updated: result.reassigned, earliest: result.earliest, latest: result.latest };
}

/**
 * Safety net for unattended topic ideas: any `pending` idea whose last edit
 * (`updatedAt`) is at least 48h ago is flipped to `approved`, making it eligible
 * for the normal auto-draft pipeline. Mirrors {@link autoLockStaleDrafts}: the
 * countdown is based on the idea's last-touched time, and any edit bumps
 * `updatedAt` (the PATCH route does this), restarting the clock. Approving or
 * rejecting moves the idea out of `pending`, so it naturally leaves the timer.
 *
 * The conditional UPDATE (status still `pending` in its WHERE) atomically guards
 * against a concurrent status change racing us.
 */
export async function autoApproveStaleIdeas(
  now: Date = new Date(),
  opts: { enabled?: boolean; afterHours?: number } = {},
): Promise<number> {
  if (opts.enabled === false) return 0;
  const afterMs =
    opts.afterHours && opts.afterHours > 0 ? opts.afterHours * 60 * 60 * 1000 : AUTO_LOCK_AFTER_MS;
  const cutoff = new Date(now.getTime() - afterMs);
  const approvedRows = await db
    .update(topicIdeasTable)
    .set({ status: "approved", updatedAt: now })
    .where(and(eq(topicIdeasTable.status, "pending"), sql`${topicIdeasTable.updatedAt} <= ${cutoff}`))
    .returning({ id: topicIdeasTable.id });
  if (approvedRows.length > 0) {
    logger.info({ approved: approvedRows.length }, "Auto-approved unattended pending ideas");
  }
  return approvedRows.length;
}

export interface PipelineResult {
  draftsCreated: number;
  articlesPublished: number;
  ideasGenerated: number;
  digestNotificationId: string | null;
}

export async function runDailyPipeline(
  now: Date = new Date(),
  opts: { manual?: boolean } = {},
): Promise<PipelineResult> {
  const manual = opts.manual === true;
  // Respect the admin pause switch for automated (cron) runs only. A manual
  // "Run pipeline now" click is explicit intent and always proceeds. Publishing
  // of already-scheduled articles is handled by a separate cron, so pausing the
  // pipeline never strands scheduled posts.
  if (!manual) {
    const settings = await getSiteSettings();
    if (!settings.pipelineEnabled) {
      logger.info("Content pipeline is paused — skipping automated run");
      return { draftsCreated: 0, articlesPublished: 0, ideasGenerated: 0, digestNotificationId: null };
    }
    // Active-hours window (UTC, inclusive). Authors slotted outside the window
    // are skipped this hour. A wrapping window (start > end) means overnight.
    const h = now.getUTCHours();
    const start = settings.contentActiveStartHour;
    const end = settings.contentActiveEndHour;
    const inWindow = start <= end ? h >= start && h <= end : h >= start || h <= end;
    if (!inWindow) {
      logger.info({ hour: h, start, end }, "Outside content active-hours window — skipping automated run");
      return { draftsCreated: 0, articlesPublished: 0, ideasGenerated: 0, digestNotificationId: null };
    }
  }
  // Claim the long-running pipeline lock so two cron ticks (or two autoscale
  // instances) can't run the multi-minute drafting loop concurrently and double
  // up drafts. A stale heartbeat (crashed prior run) lets a later run take over.
  // If the lock is held by a live run, skip cleanly with an empty result.
  const runId = await acquireJobLock(DAILY_PIPELINE_JOB, { ttlMs: DAILY_PIPELINE_TTL_MS });
  if (!runId) {
    logger.info("Daily pipeline already running — skipping overlapping run");
    return { draftsCreated: 0, articlesPublished: 0, ideasGenerated: 0, digestNotificationId: null };
  }
  let articlesPublished = 0;
  let draftsCreated = 0;
  let ideasGenerated = 0;
  let digestNotificationId: string | null = null;
  let runError: unknown = null;
  try {
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    articlesPublished = await publishDueArticles(now);

    const authors = await db.select().from(authorsTable).where(eq(authorsTable.active, true));
    const hour = now.getUTCHours();

    // Cost guardrail for the unattended (cron) drafting loop. A manual "Run
    // pipeline now" is explicit admin intent and bypasses the budget gate, same
    // as it bypasses the pause + active-hours gates above.
    const budget = manual ? null : await BudgetGuard.start("daily pipeline");

    for (const author of authors) {
      await heartbeatJob(DAILY_PIPELINE_JOB, runId, { draftsCreated, ideasGenerated });
      if (budget) {
        try {
          await budget.check();
        } catch (e) {
          if (e instanceof BudgetExceededError) {
            logger.warn({ reason: e.reason, draftsCreated, ideasGenerated }, e.message);
            break;
          }
          throw e;
        }
      }
    // Cadence + per-author hour gating only applies to scheduled/cron runs.
    // A manual click is explicit intent — draft for every active author
    // regardless of weekday or hour.
    if (!manual) {
      if ((author.runHourUtc ?? 14) !== hour) continue;
      // Enforce the author's full cadence (daily / twice-weekly / weekly /
      // biweekly / monthly) using the same predicate that drives slot
      // assignment, so a non-daily author only drafts on its cadence days.
      if (
        !dayMatchesCadence(
          {
            cadence: author.cadence,
            weekday: author.weekday,
            secondWeekday: author.secondWeekday ?? null,
            dayOfMonth: author.dayOfMonth ?? null,
            runHourUtc: author.runHourUtc ?? 14,
          },
          now,
        )
      ) {
        continue;
      }
    }

    // Don't double-draft. For scheduled runs we look at any article created
    // today (so we don't pile drafts on top of an already-published piece).
    // For manual runs we only de-dupe on existing *drafts* — published seed
    // articles shouldn't block the editor from forcing a fresh draft.
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const recentWhere = manual
      ? and(
          eq(articlesTable.authorId, author.id),
          eq(articlesTable.status, "draft"),
          sql`${articlesTable.createdAt} >= ${todayStart}`,
        )
      : and(eq(articlesTable.authorId, author.id), sql`${articlesTable.createdAt} >= ${todayStart}`);
    const recent = await db
      .select({ id: articlesTable.id })
      .from(articlesTable)
      .where(recentWhere)
      .limit(1);
    if (recent.length > 0) continue;

    // Draft one article for this author, rerolling on duplicate-overlap. Each
    // attempt picks the next approved idea (or generates a fresh batch when the
    // bank is empty). A duplicate idea is marked `rejected` inside
    // draftArticleFromIdea, so it naturally drops out of the "approved" query on
    // the next attempt — we simply try another idea rather than skipping the
    // author entirely. Bounded so a stubborn run of duplicates can't loop or
    // burn unbounded LLM/image calls on one author.
    const MAX_DRAFT_ATTEMPTS = 3;
    let drafted = false;
    let lastDuplicate: { conflict: string; score: number } | null = null;
    for (let attempt = 1; attempt <= MAX_DRAFT_ATTEMPTS && !drafted; attempt++) {
      // Find the next approved idea. If none exist, first drain the author's
      // PENDING backlog (promote the oldest pending idea to approved) before
      // spending an LLM call. Each generation batch produces one approved idea
      // plus several pending ones; reusing those pending ideas here means a
      // single batch covers multiple releases instead of being regenerated from
      // scratch every cycle — that's what kept piling up the queue and burning
      // AI on ideas we'd already paid for. Only when the author has nothing
      // banked at all (no approved AND no pending) do we generate a fresh batch.
      let nextIdea = (
        await db
          .select()
          .from(topicIdeasTable)
          .where(and(eq(topicIdeasTable.authorId, author.id), eq(topicIdeasTable.status, "approved")))
          .orderBy(topicIdeasTable.createdAt)
          .limit(1)
      )[0];

      if (!nextIdea) {
        const oldestPending = (
          await db
            .select()
            .from(topicIdeasTable)
            .where(and(eq(topicIdeasTable.authorId, author.id), eq(topicIdeasTable.status, "pending")))
            .orderBy(topicIdeasTable.createdAt)
            .limit(1)
        )[0];
        if (oldestPending) {
          // Promote atomically and guard on status='pending' so a concurrent
          // admin edit (reject/draft/delete) that lands between the select above
          // and this update is never clobbered back to "approved". If the row is
          // no longer pending (raced), the update returns nothing and we fall
          // through to generation rather than forcing a stale state.
          nextIdea = (
            await db
              .update(topicIdeasTable)
              .set({ status: "approved", updatedAt: new Date() })
              .where(and(eq(topicIdeasTable.id, oldestPending.id), eq(topicIdeasTable.status, "pending")))
              .returning()
          )[0];
          if (nextIdea) {
            logger.info(
              { author: author.name, ideaId: oldestPending.id },
              "Reusing pending idea from backlog instead of generating a fresh batch",
            );
          }
        }
      }

      if (!nextIdea) {
        try {
          const [avoidTitles, recentCategoryTitles, allowedBeats] = await Promise.all([
            recentTitlesForAuthor(author.id),
            recentPublishedTitlesForCategory(author.categorySlug),
            resolveAllowedBeats(author),
          ]);
          const generated = await generateIdeasForAuthor(author as Author, { avoidTitles, recentCategoryTitles, allowedBeats });
          if (generated.length === 0) break;
          const slugToName = new Map(allowedBeats.map((b) => [b.categorySlug, b.category]));
          const beatFor = (slug: string) => ({
            categorySlug: slug,
            category: slugToName.get(slug) ?? author.category,
          });
          const [first, ...rest] = generated;
          const firstBeat = beatFor(first!.categorySlug);
          const inserted = await db
            .insert(topicIdeasTable)
            .values([
              {
                authorId: author.id,
                title: first!.title,
                angle: first!.angle,
                category: firstBeat.category,
                categorySlug: firstBeat.categorySlug,
                status: "approved" as const,
              },
              ...rest.map((g) => {
                const b = beatFor(g.categorySlug);
                return {
                  authorId: author.id,
                  title: g.title,
                  angle: g.angle,
                  category: b.category,
                  categorySlug: b.categorySlug,
                };
              }),
            ])
            .returning();
          ideasGenerated += inserted.length;
          nextIdea = inserted.find((i) => i.status === "approved") ?? inserted[0]!;
        } catch (e) {
          logger.error({ err: e, author: author.name }, "Idea generation failed in pipeline");
          break;
        }
      }

      if (!nextIdea) break;

      try {
        await draftArticleFromIdea(author.id, nextIdea.id);
        draftsCreated += 1;
        drafted = true;
      } catch (e) {
        if (e instanceof DuplicateArticleError) {
          lastDuplicate = { conflict: e.conflictingTitle, score: e.score };
          logger.warn(
            { author: author.name, conflict: e.conflictingTitle, score: e.score, attempt },
            "Duplicate-overlap draft in pipeline — rerolling with another idea",
          );
          // Idea is now rejected; loop to try the next approved/fresh idea.
          continue;
        } else if (e instanceof IdeaAlreadyDraftingError) {
          logger.info({ author: author.name, ideaId: e.ideaId }, "Idea already being drafted; skipped in pipeline");
          break;
        } else if (e instanceof IdeaHeldNeedsSourcesError) {
          logger.info(
            { author: author.name, ideaId: e.ideaId, reason: e.reason },
            "Idea held (needs_sources) in pipeline — rerolling with another idea",
          );
          // Idea is now needs_sources; loop to try the next approved/fresh idea.
          continue;
        } else if (e instanceof AiFunctionDisabledError) {
          logger.info({ author: author.name }, "Draft generation paused; skipped draft in pipeline");
          break;
        } else {
          logger.error({ err: e, author: author.name }, "Draft generation failed in pipeline");
          break;
        }
      }
    }

    if (!drafted && lastDuplicate) {
      logger.warn(
        { author: author.name, conflict: lastDuplicate.conflict, attempts: MAX_DRAFT_ATTEMPTS },
        "No non-duplicate idea after reroll attempts — skipping author this run",
      );
    }
  }

    try {
      const { dailyDigestEnabled } = await getSiteSettings();
      if (dailyDigestEnabled) {
        const digest = await sendDailyDigest({ draftsCreated, articlesPublished, since });
        digestNotificationId = digest.notificationId;
      } else {
        logger.info("Daily digest skipped — disabled in site settings");
      }
    } catch (e) {
      logger.error({ err: e }, "sendDailyDigest failed");
    }
  } catch (e) {
    // A budget stop at start time (bulk disabled / daily cap already hit) is a
    // clean no-op, not a pipeline failure.
    if (e instanceof BudgetExceededError) {
      logger.warn({ reason: e.reason }, e.message);
    } else {
      runError = e;
    }
  } finally {
    await finishJob(DAILY_PIPELINE_JOB, runId, runError ? "failed" : "succeeded", {
      progress: { draftsCreated, articlesPublished, ideasGenerated },
      error: runError ? (runError instanceof Error ? runError.message : String(runError)) : undefined,
    });
  }
  if (runError) throw runError;
  return { draftsCreated, articlesPublished, ideasGenerated, digestNotificationId };
}

// Admin re-run of the post-draft evidence verification (#201) for a single
// packet-grounded article. Re-checks the CURRENT body against the article's
// LOCKED evidence packet (no live web) and rewrites its verificationReport. A
// passing result clears any verification-driven quarantine (the human fixed the
// draft); a non-passing result (re-)quarantines it. Throws BackfillError
// "Article not found" (missing article) / "No evidence packet" (never grounded
// on a packet, or the packet row is gone) and AiFunctionDisabledError when
// verification is paused in AI Control — a manual action must report, not
// silently no-op.
export async function verifyArticle(articleId: string) {
  const [article] = await db
    .select()
    .from(articlesTable)
    .where(eq(articlesTable.id, articleId))
    .limit(1);
  if (!article) throw new BackfillError("Article not found");
  if (!article.evidencePacketId) throw new BackfillError("No evidence packet");
  if (!(await isAiFunctionEnabled("draft_verification"))) {
    throw new AiFunctionDisabledError("draft_verification");
  }
  const { getPacket, verifyPacketGroundedDraft } = await import("./editorialScreen");
  const packet = await getPacket(article.evidencePacketId);
  if (!packet) throw new BackfillError("No evidence packet");
  await verifyPacketGroundedDraft({
    articleId: article.id,
    title: article.title,
    body: article.body,
    packet,
    clearQuarantineOnPass: true,
  });
  const [updated] = await db
    .select()
    .from(articlesTable)
    .where(eq(articlesTable.id, articleId))
    .limit(1);
  return updated;
}

// Thrown when a post-draft evidence refresh cannot produce a new packet —
// either the article has no prior packet to key the new version on, or the
// vault (still) lacks enough case-specific core evidence. Routes map it to 422.
export class EvidenceRefreshError extends Error {}

/**
 * Post-draft evidence refresh: rebuild the article's evidence packet from the
 * CURRENT Source Vault (picking up sources ingested after the article was
 * drafted), lock it as a new packet version on the same cluster key, re-point
 * the article at it, and re-verify the EXISTING draft against the new packet
 * (clearing quarantine on a clean pass). The body is never regenerated here —
 * the editor reviews the fresh verification and decides to redraft or clear
 * quarantine manually.
 *
 * Grounding inputs come from the live idea when it still exists (original
 * title/angle are the best statement of what the story is about), else from
 * the article's own title + dek. The new packet version is keyed on the PRIOR
 * packet's clusterId so versions stay in one lineage.
 */
export async function refreshArticleEvidence(articleId: string): Promise<{
  article: Article;
  packetVersion: number;
  verificationStatus: "passed" | "flagged" | "error";
}> {
  const [article] = await db.select().from(articlesTable).where(eq(articlesTable.id, articleId)).limit(1);
  if (!article) throw new BackfillError("Article not found");
  if (!(await isAiFunctionEnabled("draft_verification"))) {
    throw new AiFunctionDisabledError("draft_verification");
  }

  const { getPacket, buildGroundedPacket, verifyPacketGroundedDraft } = await import("./editorialScreen");

  const priorPacket = article.evidencePacketId ? await getPacket(article.evidencePacketId) : null;
  if (!priorPacket) {
    throw new EvidenceRefreshError(
      "This article has no evidence packet to refresh — it was drafted before packet grounding existed.",
    );
  }

  // Prefer the live idea's title/angle/beat; fall back to the article itself.
  let title = article.title;
  let angle: string | null = article.dek ?? null;
  let beat: string | null = priorPacket.beat || null;
  let beatSlug: string | null = priorPacket.beatSlug || null;
  if (article.ideaId) {
    const [idea] = await db
      .select()
      .from(topicIdeasTable)
      .where(eq(topicIdeasTable.id, article.ideaId))
      .limit(1);
    if (idea) {
      title = idea.title;
      angle = idea.angle;
      beat = idea.category ?? beat;
      beatSlug = idea.categorySlug ?? beatSlug;
    }
  }

  const res = await buildGroundedPacket({
    clusterKey: priorPacket.clusterId,
    title,
    angle,
    beat,
    beatSlug,
    researchNote: `Post-draft evidence refresh for article ${articleId} — rebuilt from the current Source Vault to pick up sources ingested after drafting.`,
  });
  if (!res.ok || !res.packet) {
    throw new EvidenceRefreshError(res.reason);
  }

  await db
    .update(articlesTable)
    .set({ evidencePacketId: res.packet.id, updatedAt: new Date() })
    .where(eq(articlesTable.id, articleId));

  const report = await verifyPacketGroundedDraft({
    articleId: article.id,
    title: article.title,
    body: article.body,
    packet: res.packet,
    clearQuarantineOnPass: true,
  });

  const [updated] = await db
    .select()
    .from(articlesTable)
    .where(eq(articlesTable.id, articleId))
    .limit(1);
  return {
    article: updated as Article,
    packetVersion: res.packet.version,
    verificationStatus: report?.status ?? "error",
  };
}

/**
 * Regenerate the body of an existing article from scratch, grounded against a
 * fresh vault-only evidence packet (if the article has a cluster). Keeps the
 * hero/share images, slug, author, and category unchanged. Clears all derived
 * state (hooks, social pack, verification report, quarantine) and moves the
 * article back to "draft" so the editor can review before re-publishing.
 *
 * Packet-grounded re-drafts get 0 web searches (the packet carries vetted
 * sources); un-grounded re-drafts get 3 so fresh breaking-news articles are
 * covered even when the vault has no matching content yet.
 */
export async function redraftArticle(articleId: string): Promise<Article> {
  const [article] = await db.select().from(articlesTable).where(eq(articlesTable.id, articleId)).limit(1);
  if (!article) throw new BackfillError("Article not found");

  const [author] = await db.select().from(authorsTable).where(eq(authorsTable.id, article.authorId)).limit(1);
  if (!author) throw new BackfillError("Author not found");

  const now = new Date();

  // Build a fresh evidence packet from the current vault when the article is
  // cluster-linked. Vault-only (free): no paid Perplexity call. Best-effort —
  // a failed build logs a warning and falls back to un-grounded drafting.
  let evidencePacketGrounding:
    | {
        label: string;
        claims: { text: string; sourceIds: string[] }[];
        sources: { id: string; url: string; domain: string; title: string | null; authorityTier: string }[];
        quotes: { text: string; attribution: string; sourceId: string | null }[];
        contradictions: { summary: string }[];
        supportingChunks?: { sourceId: string; text: string; similarity?: number }[];
      }
    | undefined;
  let freshPacketId: string | null = null;
  // Track whether a packet build was attempted but failed, so the DB update
  // can clear the stale evidencePacketId — the new body is un-grounded and
  // must not appear packet-linked.
  let packetBuildFailed = false;

  if (article.clusterId) {
    try {
      const { buildEvidencePacket } = await import("./editorialScreen");
      // skipIfUnchanged: reuse the latest packet when the cluster's source set
      // hasn't changed since it was built — no reason to re-bill the screen
      // model for an identical sources fingerprint.
      const { packet } = await buildEvidencePacket(article.clusterId, {
        research: "vault_only",
        skipIfUnchanged: true,
      });
      freshPacketId = packet.id;
      evidencePacketGrounding = {
        label: packet.label,
        claims: packet.claims,
        sources: packet.sources.map((s) => ({
          id: s.id,
          url: s.url,
          domain: s.domain,
          title: s.title,
          authorityTier: s.authorityTier,
        })),
        quotes: packet.quoteCandidates
          .filter((q) => q.allowedToQuote && q.verified)
          .map((q) => ({ text: q.text, attribution: q.attribution, sourceId: q.sourceId })),
        contradictions: packet.contradictions.map((c) => ({ summary: c.summary })),
        supportingChunks: packet.supportingChunks.map((ch) => ({
          sourceId: ch.documentId,
          text: ch.content,
          similarity: ch.similarity,
        })),
      };
    } catch (err) {
      packetBuildFailed = true;
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), articleId },
        "Re-draft: evidence packet build failed; drafting without packet grounding",
      );
    }
  }

  // Pull recently published articles as internal-link candidates (same as the
  // normal draft pipeline), excluding this article itself to avoid self-links.
  const internalLinkCandidates = await db
    .select({ title: articlesTable.title, slug: articlesTable.slug })
    .from(articlesTable)
    .where(and(eq(articlesTable.status, "published"), ne(articlesTable.id, articleId)))
    .orderBy(desc(articlesTable.publishedAt))
    .limit(30);

  // Keep the existing title (slug stability) and dek (brief/angle) — only the
  // body is regenerated. The drafter uses title+dek as the brief.
  const allowedBeats = [
    { category: author.category, categorySlug: author.categorySlug, slant: null },
  ];
  const generated = await generateArticleDraft(
    author as Author,
    { title: article.title, angle: article.dek ?? "" },
    {
      allowedBeats,
      internalLinkCandidates,
      articleId,
      ...(evidencePacketGrounding ? { evidencePacket: evidencePacketGrounding } : {}),
      ...(freshPacketId ? { packetId: freshPacketId } : {}),
      ...(article.clusterId ? { clusterId: article.clusterId } : {}),
      maxWebSearches: evidencePacketGrounding ? 0 : 3,
      ...(article.editorialLabelOverride ? { editorialLabelOverride: article.editorialLabelOverride } : {}),
    },
  );

  // Sanitize: strip internal links to missing articles, remove fabricated/dead
  // source citations — same guards as the normal draft creation path.
  const validSlugs = new Set(internalLinkCandidates.map((c) => c.slug));
  const linkedBody = sanitizeInternalLinks(generated.body, validSlugs);
  const { body } = await sanitizeCitations(linkedBody);

  // When the packet build was attempted but failed the new body is un-grounded
  // (drafted with 3 web searches), so the old evidencePacketId must be cleared.
  // Keeping it would make the new body look packet-grounded to the publisher
  // gate (finding #1) and to the verification check below.
  const effectivePacketId = packetBuildFailed ? null : (freshPacketId ?? article.evidencePacketId);

  // Persist: replace body, reset all derived/verification state, move back to
  // draft for human review before re-publishing. Hero/share images, slug,
  // author, category, and cluster attribution are intentionally preserved.
  const [redrafted] = await db
    .update(articlesTable)
    .set({
      body,
      readingTimeMinutes: readingTimeFromBody(body),
      status: "draft",
      publishedAt: null,
      scheduledFor: null,
      evidencePacketId: effectivePacketId,
      quarantinedAt: null,
      verificationReport: null,
      sourceLinksBackup: null,
      internalLinksBackup: null,
      hookVariants: null,
      socialPack: null,
      updatedAt: now,
    })
    .where(eq(articlesTable.id, articleId))
    .returning();

  // Post-redraft verification: run the same packet-grounded check as the
  // initial draft pipeline. Without this the new body is unchecked, and
  // after 48 h auto-lock the publisher gate (finding #1) will either block
  // it (throttled re-verify) or — after the first re-verify — publish
  // something the editor never had a chance to review in a quarantined state.
  // Best-effort: if the verifier throws, we log and return the draft as-is;
  // the editor will see the missing report and can trigger a manual refresh.
  if (effectivePacketId) {
    try {
      const { getPacket, verifyPacketGroundedDraft } = await import("./editorialScreen");
      const packetForVerify = freshPacketId
        ? (await getPacket(freshPacketId))
        : article.evidencePacketId
          ? await getPacket(article.evidencePacketId)
          : null;
      if (packetForVerify) {
        await verifyPacketGroundedDraft({
          articleId,
          title: article.title,
          body,
          packet: packetForVerify,
          clearQuarantineOnPass: false, // article is in draft; quarantine is meaningful here
        });
        logger.info({ articleId, packetId: effectivePacketId }, "Re-draft: post-redraft verification complete");
      } else {
        logger.warn({ articleId, packetId: effectivePacketId }, "Re-draft: packet not found for post-redraft verification");
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), articleId },
        "Re-draft: post-redraft verification failed; article stays in draft pending manual review",
      );
    }
  }

  // Re-fetch so the returned article reflects any quarantine set by the verifier.
  const [finalRedrafted] = await db
    .select()
    .from(articlesTable)
    .where(eq(articlesTable.id, articleId))
    .limit(1);

  logger.info(
    { articleId, cluster: article.clusterId, packetId: effectivePacketId, packetBacked: !!evidencePacketGrounding },
    "Article re-drafted",
  );
  return (finalRedrafted ?? redrafted) as Article;
}

/**
 * Purge page_view records older than `maxAgeDays` days (default 90).
 * Runs as a daily cron step so the table doesn't grow indefinitely. Returns
 * the number of rows deleted.
 *
 * page_views is a runtime-only table (not in the Drizzle schema), so this uses
 * raw SQL. The cutoff is parameterized to prevent injection.
 */
export async function purgeOldPageViews(maxAgeDays = 90): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
  const result = await db.execute(
    sql`DELETE FROM page_views WHERE created_at < ${cutoff}`,
  );
  return Number((result as unknown as { rowCount?: number | null }).rowCount ?? 0);
}

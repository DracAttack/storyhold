import { db, articlesTable, authorsTable, topicIdeasTable, articleSourcesTable, type Article, type TopicIdea } from "@workspace/db";
import { eq, ne, and, inArray, desc, isNotNull, sql } from "drizzle-orm";

const STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "for", "to", "and", "or", "but", "is", "are",
  "was", "were", "be", "been", "being", "as", "at", "by", "with", "from", "that",
  "this", "these", "those", "it", "its", "i", "you", "we", "they", "he", "she",
  "what", "why", "how", "when", "where", "who", "whom", "which", "do", "does",
  "did", "have", "has", "had", "can", "could", "should", "would", "may", "might",
  "will", "shall", "than", "then", "so", "if", "about", "into", "over", "under",
  "your", "our", "their", "his", "her", "my", "me", "us", "them",
]);

/**
 * Light stem to collapse trivial inflections so "cracks" and "cracking" hash
 * to the same token, "memories" and "memory", "rewires" and "rewire", etc.
 * Conservative — only chops common English suffixes.
 */
function stem(w: string): string {
  if (w.length <= 4) return w;
  if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
  if (w.endsWith("sses")) return w.slice(0, -2);
  if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("ly") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 4) return w.slice(0, -1);
  return w;
}

/**
 * Order-preserving tokenizer (same normalization/stemming/stopwords as
 * `tokens`, but keeps sequence + repetition) so callers can build n-gram phrase
 * features. `tokens` is the deduped Set view of this.
 */
export function orderedTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .map(stem);
}

export function tokens(s: string): Set<string> {
  return new Set(orderedTokens(s));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface OverlapHit {
  article: Pick<Article, "id" | "title" | "dek" | "slug" | "status" | "publishedAt" | "authorId">;
  score: number;
}

export interface OverlapOpts {
  excludeArticleId?: string;
  limit?: number;
  threshold?: number;
}

/**
 * Score two concepts (each given as title + supporting text) using both a
 * title-only jaccard and a combined jaccard, then return the higher of the
 * two relative to its own threshold. This catches both "two articles whose
 * titles are nearly identical" and "two articles whose full briefs paraphrase
 * one another with different titles".
 */
export function conceptScore(
  aTitle: string, aBody: string,
  bTitle: string, bBody: string,
): { score: number; titleScore: number; combinedScore: number } {
  const titleScore = jaccard(tokens(aTitle), tokens(bTitle));
  const combinedScore = jaccard(tokens(`${aTitle} ${aBody}`), tokens(`${bTitle} ${bBody}`));
  // Title-only is roughly twice as informative as combined (because deks add
  // a lot of unique noise), so we boost it before taking the max.
  const score = Math.max(titleScore * 0.85 + 0.05, combinedScore);
  return { score, titleScore, combinedScore };
}

/**
 * Find existing articles whose title+dek overlap meaningfully with the
 * supplied title/angle. Uses simple token Jaccard over the title and dek so
 * it works without any extensions. Anything above `threshold` (default 0.35)
 * is considered too close to safely re-publish.
 */
export async function findOverlappingArticles(
  title: string,
  angle: string,
  opts: OverlapOpts = {},
): Promise<OverlapHit[]> {
  const threshold = opts.threshold ?? 0.35;
  const limit = opts.limit ?? 5;
  if (tokens(`${title} ${angle}`).size === 0) return [];

  const where = opts.excludeArticleId
    ? and(ne(articlesTable.id, opts.excludeArticleId))
    : undefined;
  const rows = await db
    .select({
      id: articlesTable.id,
      title: articlesTable.title,
      dek: articlesTable.dek,
      slug: articlesTable.slug,
      status: articlesTable.status,
      publishedAt: articlesTable.publishedAt,
      authorId: articlesTable.authorId,
    })
    .from(articlesTable)
    .where(where);

  const hits: OverlapHit[] = [];
  for (const r of rows) {
    const { score } = conceptScore(title, angle, r.title, r.dek);
    if (score >= threshold) hits.push({ article: r, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/**
 * Render a short context block listing existing titles so an LLM prompt can
 * "do not retread" them. Capped to a reasonable number of titles.
 */
export function renderAvoidList(hits: OverlapHit[]): string {
  if (hits.length === 0) return "";
  const lines = hits.map((h) => `- "${h.article.title}" — ${h.article.dek}`);
  return `\n\nThese existing BrainHook articles already cover related ground. Choose a clearly different angle and do not duplicate their thesis or examples:\n${lines.join("\n")}`;
}

/**
 * Article-only LLM concept-duplicate backstop. Casts a wide lexical net to
 * find the closest existing articles, then asks an LLM whether the proposed
 * concept is essentially the same story as any of them. Catches paraphrased
 * near-duplicates that share no distinctive wording (so the lexical jaccard
 * guard misses them). Returns the matching article + reason, or null.
 */
export async function llmArticleConceptDuplicate(
  title: string,
  angle: string,
  opts: {
    excludeArticleId?: string;
    limit?: number;
    proposedAuthor?: { name: string; beat: string };
  } = {},
): Promise<{ article: OverlapHit["article"]; reason: string } | null> {
  if (tokens(`${title} ${angle}`).size === 0) return null;
  const wide = await findOverlappingArticles(title, angle, {
    threshold: 0.05,
    limit: opts.limit ?? 6,
    ...(opts.excludeArticleId ? { excludeArticleId: opts.excludeArticleId } : {}),
  });
  if (wide.length === 0) return null;

  // Resolve each candidate's author so the judge can weigh whether a genuinely
  // different columnist/beat would bring a fresh take on a shared subject.
  const authorIds = Array.from(new Set(wide.map((h) => h.article.authorId).filter(Boolean)));
  const authorRows = authorIds.length
    ? await db
        .select({ id: authorsTable.id, name: authorsTable.name, category: authorsTable.category })
        .from(authorsTable)
        .where(inArray(authorsTable.id, authorIds))
    : [];
  const authorById = new Map(authorRows.map((a) => [a.id, a]));

  const { llmConceptDuplicateCheck } = await import("./llm");
  const verdict = await llmConceptDuplicateCheck(
    { title, angle, ...(opts.proposedAuthor ? { author: opts.proposedAuthor } : {}) },
    wide.map((h) => {
      const a = authorById.get(h.article.authorId);
      return {
        title: h.article.title,
        description: h.article.dek,
        ...(a ? { author: { name: a.name, beat: a.category } } : {}),
      };
    }),
  );
  if (verdict.duplicateIndex >= 0 && verdict.duplicateIndex < wide.length) {
    return { article: wide[verdict.duplicateIndex]!.article, reason: verdict.reason };
  }
  return null;
}

export interface IdeaOverlapHit {
  idea: Pick<TopicIdea, "id" | "title" | "angle" | "authorId" | "status">;
  score: number;
}

/**
 * Find existing topic_ideas (excluding rejected ones) whose title+angle
 * overlap meaningfully. Used to prevent duplicate ideas from piling up
 * even before they are drafted.
 */
export async function findOverlappingIdeas(
  title: string,
  angle: string,
  opts: { excludeIdeaId?: string; threshold?: number; limit?: number } = {},
): Promise<IdeaOverlapHit[]> {
  const threshold = opts.threshold ?? 0.35;
  const limit = opts.limit ?? 5;
  const queryTokens = tokens(`${title} ${angle}`);
  if (queryTokens.size === 0) return [];

  const where = opts.excludeIdeaId
    ? and(
        ne(topicIdeasTable.id, opts.excludeIdeaId),
        inArray(topicIdeasTable.status, ["pending", "approved", "used"] as const),
      )
    : inArray(topicIdeasTable.status, ["pending", "approved", "used"] as const);

  const rows = await db
    .select({
      id: topicIdeasTable.id,
      title: topicIdeasTable.title,
      angle: topicIdeasTable.angle,
      authorId: topicIdeasTable.authorId,
      status: topicIdeasTable.status,
    })
    .from(topicIdeasTable)
    .where(where);

  const hits: IdeaOverlapHit[] = [];
  for (const r of rows) {
    const { score } = conceptScore(title, angle, r.title, r.angle);
    if (score >= threshold) hits.push({ idea: r, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

export interface TitleClash {
  kind: "article" | "idea";
  id: string;
  title: string;
  reason: string;
}

/**
 * Title near-twin backstop. Fetches a broad set of recent existing TITLES
 * (articles, and optionally non-rejected ideas) and asks an LLM whether the
 * proposed title reads as a near-duplicate headline — same phrasing, structure,
 * or hook — even when the underlying article is about a different subject.
 *
 * Title clashes are lexical/structural and frequently share no content tokens,
 * so unlike the concept guard we can't pre-filter candidates by jaccard
 * overlap; we hand the model a recent slice of titles directly. Returns the
 * clashing item, or null.
 */
export async function llmSimilarTitle(
  title: string,
  opts: {
    excludeArticleId?: string;
    excludeIdeaId?: string;
    includeIdeas?: boolean;
    articleLimit?: number;
    ideaLimit?: number;
  } = {},
): Promise<TitleClash | null> {
  const probe = title.trim();
  if (!probe) return null;

  const articleRows = await db
    .select({ id: articlesTable.id, title: articlesTable.title })
    .from(articlesTable)
    .where(opts.excludeArticleId ? ne(articlesTable.id, opts.excludeArticleId) : undefined)
    .orderBy(desc(articlesTable.createdAt))
    .limit(opts.articleLimit ?? 100);

  const candidates: { kind: "article" | "idea"; id: string; title: string }[] = articleRows.map(
    (r) => ({ kind: "article" as const, id: r.id, title: r.title }),
  );

  if (opts.includeIdeas) {
    const ideaWhere = opts.excludeIdeaId
      ? and(
          ne(topicIdeasTable.id, opts.excludeIdeaId),
          inArray(topicIdeasTable.status, ["pending", "approved", "used"] as const),
        )
      : inArray(topicIdeasTable.status, ["pending", "approved", "used"] as const);
    const ideaRows = await db
      .select({ id: topicIdeasTable.id, title: topicIdeasTable.title })
      .from(topicIdeasTable)
      .where(ideaWhere)
      .orderBy(desc(topicIdeasTable.createdAt))
      .limit(opts.ideaLimit ?? 60);
    for (const r of ideaRows) candidates.push({ kind: "idea", id: r.id, title: r.title });
  }

  if (candidates.length === 0) return null;

  const { llmTitleSimilarityCheck } = await import("./llm");
  const verdict = await llmTitleSimilarityCheck(probe, candidates.map((c) => c.title));
  if (verdict.index >= 0 && verdict.index < candidates.length) {
    const c = candidates[verdict.index]!;
    return { kind: c.kind, id: c.id, title: c.title, reason: verdict.reason };
  }
  return null;
}

/**
 * Ensure a title does not read as a near-twin of an existing headline. If it
 * does, ask the LLM to REWRITE it into a distinct headline (same subject and
 * angle) rather than rejecting the otherwise-novel piece, then re-check and
 * retry a couple of times. Conceptually distinct articles are never blocked on
 * title alone — at worst we return the best rewrite attempt.
 */
export async function dedupeTitle(
  title: string,
  angle: string,
  opts: {
    excludeArticleId?: string;
    excludeIdeaId?: string;
    includeIdeas?: boolean;
    maxAttempts?: number;
  } = {},
): Promise<{ title: string; changed: boolean; clashedWith?: string }> {
  const findOpts = {
    ...(opts.excludeArticleId ? { excludeArticleId: opts.excludeArticleId } : {}),
    ...(opts.excludeIdeaId ? { excludeIdeaId: opts.excludeIdeaId } : {}),
    ...(opts.includeIdeas ? { includeIdeas: true } : {}),
  };
  const first = await llmSimilarTitle(title, findOpts);
  if (!first) return { title, changed: false };

  const { llmRewriteTitle } = await import("./llm");
  let current = title;
  let clashedWith = first.title;
  const maxAttempts = opts.maxAttempts ?? 2;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const rewritten = await llmRewriteTitle({ title: current, angle }, [clashedWith]);
    if (!rewritten || rewritten === current) break;
    current = rewritten;
    const stillClash = await llmSimilarTitle(current, findOpts);
    if (!stillClash) return { title: current, changed: true, clashedWith: first.title };
    clashedWith = stillClash.title;
  }
  return { title: current, changed: current !== title, clashedWith: first.title };
}

/**
 * Single overlap probe used at idea-creation time. Checks BOTH existing
 * articles and existing non-rejected ideas with a lexical jaccard, then —
 * if nothing tripped — asks an LLM whether the proposal is conceptually a
 * duplicate of any of the lexically-closest items (catches paraphrases like
 * "recall a memory" vs "remember something"), and finally whether its title
 * reads as a near-twin of an existing headline.
 */
export async function probeConceptOverlap(
  title: string,
  angle: string,
  opts: { excludeIdeaId?: string; threshold?: number; useLlm?: boolean } = {},
): Promise<{
  worst: { kind: "article" | "idea"; title: string; score: number; reason?: string } | null;
  articleHits: OverlapHit[];
  ideaHits: IdeaOverlapHit[];
}> {
  const threshold = opts.threshold ?? 0.35;
  const useLlm = opts.useLlm !== false;
  const [articleHits, ideaHits] = await Promise.all([
    findOverlappingArticles(title, angle, { threshold }),
    findOverlappingIdeas(title, angle, {
      threshold,
      ...(opts.excludeIdeaId ? { excludeIdeaId: opts.excludeIdeaId } : {}),
    }),
  ]);
  const a = articleHits[0];
  const i = ideaHits[0];
  let worst: { kind: "article" | "idea"; title: string; score: number; reason?: string } | null = null;
  if (a && (!i || a.score >= i.score)) worst = { kind: "article", title: a.article.title, score: a.score };
  else if (i) worst = { kind: "idea", title: i.idea.title, score: i.score };

  if (worst || !useLlm) return { worst, articleHits, ideaHits };

  // Lexical probe found nothing. Cast a wider lexical net to find the most
  // plausible candidates for an LLM concept-similarity check. (Title near-twins
  // are NOT blocked here — those are fixed by rewriting the title at draft time
  // via dedupeTitle, so a conceptually-distinct idea is never denied entry.)
  const [wideArticles, wideIdeas] = await Promise.all([
    findOverlappingArticles(title, angle, { threshold: 0.05, limit: 6 }),
    findOverlappingIdeas(title, angle, {
      threshold: 0.05,
      limit: 6,
      ...(opts.excludeIdeaId ? { excludeIdeaId: opts.excludeIdeaId } : {}),
    }),
  ]);
  const candidates: { kind: "article" | "idea"; title: string; description: string }[] = [
    ...wideArticles.map((h) => ({ kind: "article" as const, title: h.article.title, description: h.article.dek })),
    ...wideIdeas.map((h) => ({ kind: "idea" as const, title: h.idea.title, description: h.idea.angle })),
  ];
  if (candidates.length === 0) return { worst: null, articleHits, ideaHits };

  const { llmConceptDuplicateCheck } = await import("./llm");
  const verdict = await llmConceptDuplicateCheck(
    { title, angle },
    candidates.map((c) => ({ title: c.title, description: c.description })),
  );
  if (verdict.duplicateIndex >= 0 && verdict.duplicateIndex < candidates.length) {
    const c = candidates[verdict.duplicateIndex]!;
    worst = { kind: c.kind, title: c.title, score: 1.0, reason: verdict.reason };
  }
  return { worst, articleHits, ideaHits };
}

// ---------------------------------------------------------------------------
// Publish-gate deduplication
// ---------------------------------------------------------------------------

export interface PublishGateVerdict {
  duplicate: boolean;
  conflictArticleId?: string;
  conflictTitle?: string;
  reason?: string;
}

/**
 * Last-chance deduplication check run immediately before a scheduled article
 * transitions to published. Catches articles that slipped past draft-time
 * dedupe because a parallel author drafted a near-identical piece in the same
 * pipeline window, or because the catalog grew while the draft sat queued.
 *
 * Three-layer check:
 *  1. Lexical concept overlap (Jaccard ≥ 0.25, lower than draft-time 0.35, to
 *     cast a wider pre-LLM net and surface borderline cases for the judge).
 *  2. Vault source overlap: if this article shares ≥ 2 evidence-role source
 *     documents with another published/scheduled article, they likely cover the
 *     same underlying story.
 *  3. LLM judge: final arbitration over the merged candidate set.
 *
 * Fail-open: callers should catch errors and publish anyway rather than
 * blocking on a check failure.
 */
export async function checkPublishGateDedupe(articleId: string): Promise<PublishGateVerdict> {
  const [article] = await db
    .select({ id: articlesTable.id, title: articlesTable.title, dek: articlesTable.dek })
    .from(articlesTable)
    .where(eq(articlesTable.id, articleId))
    .limit(1);
  if (!article) return { duplicate: false };

  // --- Layer 1: Lexical concept overlap ---
  const conceptHits = await findOverlappingArticles(article.title, article.dek ?? "", {
    threshold: 0.25,
    limit: 6,
    excludeArticleId: articleId,
  });

  // --- Layer 2: Vault source overlap (≥ 2 shared evidence-role documents) ---
  const mySources = await db
    .select({ sourceDocumentId: articleSourcesTable.sourceDocumentId })
    .from(articleSourcesTable)
    .where(
      and(
        eq(articleSourcesTable.articleId, articleId),
        eq(articleSourcesTable.role, "evidence"),
        isNotNull(articleSourcesTable.sourceDocumentId),
      ),
    );
  const myDocIds = mySources
    .map((s) => s.sourceDocumentId)
    .filter((id): id is string => id != null);

  const sourceConflicts = new Map<string, number>(); // other articleId → shared count
  if (myDocIds.length > 0) {
    const sharedRows = await db
      .select({
        articleId: articleSourcesTable.articleId,
        sourceDocumentId: articleSourcesTable.sourceDocumentId,
      })
      .from(articleSourcesTable)
      .where(
        and(
          ne(articleSourcesTable.articleId, articleId),
          eq(articleSourcesTable.role, "evidence"),
          isNotNull(articleSourcesTable.sourceDocumentId),
          sql`${articleSourcesTable.sourceDocumentId} = ANY(ARRAY[${sql.join(
            myDocIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]::uuid[])`,
        ),
      );
    for (const r of sharedRows) {
      sourceConflicts.set(r.articleId, (sourceConflicts.get(r.articleId) ?? 0) + 1);
    }
  }

  const sourceHitIds = [...sourceConflicts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([id]) => id);

  const sourceHitArticles =
    sourceHitIds.length > 0
      ? await db
          .select({ id: articlesTable.id, title: articlesTable.title, dek: articlesTable.dek })
          .from(articlesTable)
          .where(
            and(
              inArray(articlesTable.id, sourceHitIds),
              inArray(articlesTable.status, ["published", "scheduled"]),
            ),
          )
      : [];

  // --- Merge candidates ---
  const candidateMap = new Map<string, { id: string; title: string; dek: string | null }>();
  for (const h of conceptHits) {
    candidateMap.set(h.article.id, { id: h.article.id, title: h.article.title, dek: h.article.dek });
  }
  for (const a of sourceHitArticles) {
    if (!candidateMap.has(a.id)) {
      candidateMap.set(a.id, { id: a.id, title: a.title, dek: a.dek });
    }
  }
  if (candidateMap.size === 0) return { duplicate: false };

  // Quick lexical short-circuit: strong overlap → skip LLM cost.
  const topHit = conceptHits[0];
  if (topHit && topHit.score >= 0.45) {
    return {
      duplicate: true,
      conflictArticleId: topHit.article.id,
      conflictTitle: topHit.article.title,
      reason: `High lexical overlap (score ${topHit.score.toFixed(2)}) with "${topHit.article.title}"`,
    };
  }

  // --- Layer 3: LLM judge ---
  const { llmConceptDuplicateCheck } = await import("./llm");
  const candidates = [...candidateMap.values()];
  const verdict = await llmConceptDuplicateCheck(
    { title: article.title, angle: article.dek ?? "" },
    candidates.map((c) => ({ title: c.title, description: c.dek ?? "" })),
  );
  if (verdict.duplicateIndex >= 0 && verdict.duplicateIndex < candidates.length) {
    const conflict = candidates[verdict.duplicateIndex]!;
    return {
      duplicate: true,
      conflictArticleId: conflict.id,
      conflictTitle: conflict.title,
      reason: verdict.reason,
    };
  }

  return { duplicate: false };
}

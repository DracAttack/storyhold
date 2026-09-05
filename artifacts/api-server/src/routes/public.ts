import { Router, type IRouter, type Request } from "express";
import { randomBytes } from "node:crypto";
import { hashEmail } from "../lib/pii";
import { db, articlesTable, articleSourcesTable, authorsTable, authorSlugRedirectsTable, beatsTable, sourceDocumentsTable, subscribersTable, shareEventsTable, pageViewsTable, internalClicksTable, swipeEventsTable, conceptsTable, conceptAliasesTable, conceptRelationshipsTable, articleConceptMentionsTable, conceptSourcesTable, articleRelationsTable, SOURCE_AUTHORITY_TIER, type ArticleBlock } from "@workspace/db";
import { and, asc, desc, eq, gt, ilike, ne, isNull, inArray, notInArray, sql, type SQL } from "drizzle-orm";
import { SubscribeNewsletterBody, UnsubscribeNewsletterBody, RecordShareEventBody, RecordPageViewBody, RecordInternalClickBody, RecordSwipeEventBody } from "@workspace/api-zod";
import { publicObjectExists, DEFAULT_SHARE_CARD_URL } from "../lib/objectStorage";
import { getSiteSettings } from "../services/siteSettings";
import { isAdminEmail } from "../lib/auth";
import { sendWelcomeEmail } from "../services/welcomeEmail";
import { tokens } from "../services/dedupe";
import { isJunkCitationTitle, titleFromUrlSlug } from "../services/citationMetadata";
import { getArticleConceptMentions } from "../services/conceptExplainer";
import { isSearchQueryUrl } from "../services/citations";

const router: IRouter = Router();

// Per-IP rate limit for the public subscribe endpoint. Mirrors the in-memory
// limiter pattern used by the admin login route. A single server instance keeps
// this in process memory; horizontal scaling would need a shared store (Redis).
const SUBSCRIBE_WINDOW_MS = 60 * 60 * 1000;
const SUBSCRIBE_MAX = 5;
const subscribeAttempts = new Map<string, { count: number; resetAt: number }>();

function clientKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

// ── Rate-limit map hygiene ────────────────────────────────────────────────────
// The limiter maps only evict an entry when the SAME key returns after its
// window, so an attacker rotating IPs grows them without bound until a restart.
// Two guards: a periodic sweep of expired entries, and an inline sweep when a
// map crosses a size threshold on insert (bounds worst-case growth even if the
// interval hasn't fired yet).
type RateEntry = { count: number; resetAt: number };
const RATE_MAP_SWEEP_MS = 10 * 60 * 1000;
const RATE_MAP_MAX_BEFORE_SWEEP = 50_000;

function sweepExpired(map: Map<string, RateEntry>): void {
  const now = Date.now();
  for (const [k, v] of map) if (v.resetAt < now) map.delete(k);
}

function guardedSet(map: Map<string, RateEntry>, key: string, entry: RateEntry): void {
  if (map.size >= RATE_MAP_MAX_BEFORE_SWEEP && !map.has(key)) sweepExpired(map);
  map.set(key, entry);
}

function recordSubscribeAttempt(key: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const entry = subscribeAttempts.get(key);
  if (!entry || entry.resetAt < now) {
    guardedSet(subscribeAttempts, key, { count: 1, resetAt: now + SUBSCRIBE_WINDOW_MS });
    return { allowed: true, retryAfterSec: 0 };
  }
  if (entry.count >= SUBSCRIBE_MAX) {
    return { allowed: false, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count += 1;
  return { allowed: true, retryAfterSec: 0 };
}

// Per-IP rate limit for the public share-tracking endpoint. Far more generous
// than subscribe — a single reader legitimately clicks several share buttons —
// but still caps abusive flooding of the share counters. Same single-server
// in-memory caveat as the subscribe limiter.
const SHARE_WINDOW_MS = 60 * 1000;
const SHARE_MAX = 60;
const shareAttempts = new Map<string, { count: number; resetAt: number }>();

function recordShareAttempt(key: string): boolean {
  const now = Date.now();
  const entry = shareAttempts.get(key);
  if (!entry || entry.resetAt < now) {
    guardedSet(shareAttempts, key, { count: 1, resetAt: now + SHARE_WINDOW_MS });
    return true;
  }
  if (entry.count >= SHARE_MAX) return false;
  entry.count += 1;
  return true;
}

// Per-IP rate limit for the public page-view endpoint. A reader can legitimately
// open several articles in a minute, so this is generous; it only caps abusive
// flooding of the view counter. Same single-server in-memory caveat as above.
const VIEW_WINDOW_MS = 60 * 1000;
const VIEW_MAX = 120;
const viewAttempts = new Map<string, { count: number; resetAt: number }>();

// Per-IP rate limit for the public swipe-next endpoints (articles + concepts).
// A normal reader might swipe through dozens of articles in a session; 120/min
// is generous for that while blocking trivial amplification abuse.
const NEXT_WINDOW_MS = 60 * 1000;
const NEXT_MAX = 120;
const nextAttempts = new Map<string, { count: number; resetAt: number }>();

function recordNextAttempt(key: string): boolean {
  const now = Date.now();
  const entry = nextAttempts.get(key);
  if (!entry || entry.resetAt < now) {
    guardedSet(nextAttempts, key, { count: 1, resetAt: now + NEXT_WINDOW_MS });
    return true;
  }
  if (entry.count >= NEXT_MAX) return false;
  entry.count += 1;
  return true;
}

// Periodic background sweep across all limiter maps. `unref()` so the
// timer never keeps the process alive on shutdown.
setInterval(() => {
  for (const m of [subscribeAttempts, shareAttempts, viewAttempts, nextAttempts]) sweepExpired(m);
}, RATE_MAP_SWEEP_MS).unref();

function recordViewAttempt(key: string): boolean {
  const now = Date.now();
  const entry = viewAttempts.get(key);
  if (!entry || entry.resetAt < now) {
    guardedSet(viewAttempts, key, { count: 1, resetAt: now + VIEW_WINDOW_MS });
    return true;
  }
  if (entry.count >= VIEW_MAX) return false;
  entry.count += 1;
  return true;
}

const STORAGE_PREFIX = "/api/storage/public-objects/";

function heroPlaceholder(): string {
  return DEFAULT_SHARE_CARD_URL;
}

/**
 * If a hero image points at an object-storage path whose binary is missing
 * (e.g. dev DB was resynced from prod but the image files weren't), swap it for
 * the branded default card so clients never request a 404 URL. Any legacy
 * stock-photo (picsum) URL still stored on old rows is also mapped to the
 * branded default card — we never surface a picsum image. Other absolute URLs
 * are returned untouched. Failures are non-fatal — the original value is kept if
 * the existence check itself errors.
 */
async function resolveHeroImage(heroImage: string, _slug: string): Promise<string> {
  if (!heroImage) return heroImage;
  if (heroImage.includes("picsum.photos")) return DEFAULT_SHARE_CARD_URL;
  if (!heroImage.startsWith(STORAGE_PREFIX)) return heroImage;
  const filePath = heroImage.slice(STORAGE_PREFIX.length);
  try {
    if (await publicObjectExists(filePath)) return heroImage;
    return heroPlaceholder();
  } catch {
    return heroImage;
  }
}

/**
 * Resolve the branded composite share image. Returns null (so consumers fall
 * back to the raw hero for og:image) when there is no composite or its binary is
 * missing from object storage (e.g. a dev DB resynced from prod without the
 * files). A non-storage absolute URL is returned as-is. Existence-check failures
 * are non-fatal — the stored value is kept.
 */
async function resolveShareImage(shareImage: string | null): Promise<string | null> {
  if (!shareImage) return null;
  if (shareImage.includes("picsum.photos")) return DEFAULT_SHARE_CARD_URL;
  if (!shareImage.startsWith(STORAGE_PREFIX)) return shareImage;
  const filePath = shareImage.slice(STORAGE_PREFIX.length);
  try {
    return (await publicObjectExists(filePath)) ? shareImage : null;
  } catch {
    return shareImage;
  }
}

function toPublicAuthor(a: typeof authorsTable.$inferSelect) {
  return {
    id: a.id,
    slug: a.slug,
    name: a.name,
    bio: a.bio,
    avatarUrl: a.avatarUrl,
    category: a.category,
    categorySlug: a.categorySlug,
  };
}

// Column projection for the public list/feed endpoints. Deliberately omits the
// large jsonb `body` (and `forceAutoRelated`) so list responses carry summary
// data only — the full article body is served exclusively by
// GET /public/articles/:slug. The nested `author` object mirrors PublicAuthor.
const articleSummaryColumns = {
  id: articlesTable.id,
  slug: articlesTable.slug,
  title: articlesTable.title,
  dek: articlesTable.dek,
  category: articlesTable.category,
  categorySlug: articlesTable.categorySlug,
  heroImage: articlesTable.heroImage,
  readingTimeMinutes: articlesTable.readingTimeMinutes,
  publishedAt: articlesTable.publishedAt,
  articleKind: articlesTable.articleKind,
  storyChainId: articlesTable.storyChainId,
  chainPosition: articlesTable.chainPosition,
  author: {
    id: authorsTable.id,
    slug: authorsTable.slug,
    name: authorsTable.name,
    bio: authorsTable.bio,
    avatarUrl: authorsTable.avatarUrl,
    category: authorsTable.category,
    categorySlug: authorsTable.categorySlug,
  },
} as const;

// Resolve a missing object-storage hero to a placeholder, preserving the rest
// of the summary row shape returned by the list/feed endpoints.
async function resolveSummaryHero<T extends { slug: string; heroImage: string }>(r: T): Promise<T> {
  return { ...r, heroImage: await resolveHeroImage(r.heroImage, r.slug) };
}

router.get("/articles", async (req, res) => {
  const category = typeof req.query.category === "string" ? req.query.category : undefined;
  const author = typeof req.query.author === "string" ? req.query.author : undefined;
  // Free-text search. Each whitespace-separated term must appear (AND) in the
  // title, dek, or body text. When present we force recency order and ignore the
  // random-order/offset paging used by the home/category feeds.
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const limit = req.query.limit ? Math.min(Math.max(Number(req.query.limit) || 50, 1), 100) : 100;
  const randomOrder = !q && req.query.order === "random";
  // Offset is only meaningful for stable recent ordering (paging past the
  // recent shuffled pool on category pages); it's ignored for random order.
  const offset = !randomOrder && req.query.offset ? Math.max(Number(req.query.offset) || 0, 0) : 0;
  const conds = [eq(articlesTable.status, "published"), isNull(articlesTable.quarantinedAt), eq(articlesTable.articleKind, "standard")];
  if (category) conds.push(eq(articlesTable.categorySlug, category));
  if (author) conds.push(eq(authorsTable.slug, author));
  if (q) {
    // Cap term count so a pathological query can't generate a huge WHERE.
    const terms = q.split(/\s+/).filter(Boolean).slice(0, 8);
    for (const term of terms) {
      const like = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      conds.push(
        sql`(${articlesTable.title} ILIKE ${like} ESCAPE '\\' OR ${articlesTable.dek} ILIKE ${like} ESCAPE '\\' OR ${articlesTable.body}::text ILIKE ${like} ESCAPE '\\')`,
      );
    }
  }
  const rows = await db
    .select(articleSummaryColumns)
    .from(articlesTable)
    .innerJoin(authorsTable, eq(authorsTable.id, articlesTable.authorId))
    .where(and(...conds))
    .orderBy(randomOrder ? sql`RANDOM()` : sql`${articlesTable.publishedAt} DESC NULLS LAST`)
    .limit(limit)
    .offset(offset);
  const items = await Promise.all(rows.map(resolveSummaryHero));
  res.json({ items }); return;
});

// Minimum IDF-weighted topical score for an article to count as a genuine
// neighbor. Scoring is over the FULL body (see corpus cache below), so the scale
// differs from a title-only one: genuine neighbors land ~0.12–0.24, loosely
// adjacent essays ~0.10–0.12, and clearly off-topic pieces (a space article
// under an apology piece) floor ~0.06. 0.10 keeps the real neighbors and drops
// the off-topic floor; when an article has none, the rail simply shows fewer (or
// no) items rather than padding with off-topic recency picks.
const RELATED_MIN_SCORE = 0.1;
// Swipe-to-next subject diversity: once the reader has already read this many
// articles in the CURRENT article's category this browsing session, the next
// pick prefers the best still-related neighbor from a DIFFERENT category so the
// walk broadens across subjects instead of dwelling in one dense cluster.
const SAME_CATEGORY_READS_LIMIT = 2;

// ── Related-articles corpus cache ────────────────────────────────────────────
// Topical scoring keys off each article's FULL body text, not just title + dek.
// Title+dek alone (~25 words) is far too sparse: genuinely related pieces that
// don't reuse each other's exact headline words scored ~0 (an apology article
// and "...Fight Better in Person Than Over Text" shared no title tokens at all),
// so real neighbors never surfaced. Body text is rich enough that IDF weighting
// cleanly separates real neighbors (which share RARE words like "apology",
// "repair", "read receipt") from corpus-wide filler ("people", "research").
//
// Tokenizing every published body is too heavy to redo on each request (this
// endpoint is hit on every article view + SSR), so the tokenized corpus +
// document-frequency map are cached in process and rebuilt at most every
// CORPUS_TTL_MS. Articles publish ~1–2/day, so a few minutes of staleness in the
// "more like this" rail is fine. Single-server assumption, like the rate limiters.
interface RelatedDoc {
  id: string;
  slug: string;
  categorySlug: string;
  publishedAt: Date | null;
  tokens: Set<string>;
  // Canonical URLs of the article's harvested EVIDENCE sources (#228 graph).
  // Two articles that cite the same evidence URL are genuine topical neighbors
  // even when their prose diverges — see the evidence blend in the handler.
  sourceKeys: Set<string>;
}
interface RelatedCorpus {
  docs: RelatedDoc[];
  docFreq: Map<string, number>;
  // How many articles cite each evidence URL, for IDF weighting: a source cited
  // by many articles is far less discriminating than one shared by only two.
  sourceFreq: Map<string, number>;
  builtAt: number;
}
const CORPUS_TTL_MS = 5 * 60 * 1000;
let relatedCorpus: RelatedCorpus | null = null;
let relatedCorpusBuilding: Promise<RelatedCorpus> | null = null;

// Flatten an article body to plain topical text: paragraph + heading blocks
// carry the subject matter; image/pullquote/relatedArticle blocks are skipped.
// Markdown links are reduced to their visible text so URLs don't pollute tokens.
function blocksToText(body: ArticleBlock[] | null): string {
  if (!body) return "";
  const parts: string[] = [];
  for (const b of body) {
    if (b.type !== "paragraph" && b.type !== "heading") continue;
    const t = (b.content ?? "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
    if (t) parts.push(t);
  }
  return parts.join(" ");
}

async function buildRelatedCorpus(): Promise<RelatedCorpus> {
  const rows = await db
    .select({
      id: articlesTable.id,
      slug: articlesTable.slug,
      title: articlesTable.title,
      dek: articlesTable.dek,
      categorySlug: articlesTable.categorySlug,
      publishedAt: articlesTable.publishedAt,
      body: articlesTable.body,
    })
    .from(articlesTable)
    .where(and(eq(articlesTable.status, "published"), isNull(articlesTable.quarantinedAt)));
  const docs: RelatedDoc[] = rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    categorySlug: r.categorySlug,
    publishedAt: r.publishedAt,
    tokens: tokens(`${r.title} ${r.dek ?? ""} ${blocksToText(r.body)}`),
    sourceKeys: new Set<string>(),
  }));
  const docFreq = new Map<string, number>();
  for (const d of docs) for (const t of d.tokens) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);

  // Attach the #228 evidence graph: one cheap query for every evidence-role
  // article_sources row, grouped onto its article. Only "evidence" links carry
  // topical signal (trend markers / rejected junk are noise). The canonical url
  // is the shared-source identity key (present whether or not the source has
  // been ingested into the vault yet, so it works for queued rows too).
  const byId = new Map(docs.map((d) => [d.id, d]));
  const evidenceRows = await db
    .select({ articleId: articleSourcesTable.articleId, url: articleSourcesTable.url })
    .from(articleSourcesTable)
    .where(eq(articleSourcesTable.role, "evidence"));
  const sourceFreq = new Map<string, number>();
  for (const e of evidenceRows) {
    const d = byId.get(e.articleId);
    if (!d || d.sourceKeys.has(e.url)) continue;
    d.sourceKeys.add(e.url);
    sourceFreq.set(e.url, (sourceFreq.get(e.url) ?? 0) + 1);
  }
  return { docs, docFreq, sourceFreq, builtAt: Date.now() };
}

// Single-flight cached corpus: concurrent requests during a (re)build await the
// same in-flight promise instead of each firing the heavy all-bodies query.
async function getRelatedCorpus(): Promise<RelatedCorpus> {
  if (relatedCorpus && Date.now() - relatedCorpus.builtAt < CORPUS_TTL_MS) return relatedCorpus;
  if (!relatedCorpusBuilding) {
    relatedCorpusBuilding = buildRelatedCorpus()
      .then((c) => {
        relatedCorpus = c;
        return c;
      })
      .finally(() => {
        relatedCorpusBuilding = null;
      });
  }
  return relatedCorpusBuilding;
}

// Blended related-ranking shared by the "More like this" rail AND the swipe-to-
// next gesture. Ranks every OTHER published article against `target` by the same
// IDF-weighted body-token overlap plus the additive evidence-graph blend, and
// returns them sorted best-first — WITHOUT applying any threshold or limit, so
// callers slice/filter to taste. Kept in one place so the rail and the swipe
// walk can never diverge on what "most related" means.
async function rankRelatedCandidates(target: {
  id: string;
  title: string;
  dek: string | null;
  body: ArticleBlock[] | null;
  categorySlug: string;
}): Promise<{ slug: string; score: number; sameCat: number; published: number }[]> {
  const corpus = await getRelatedCorpus();
  const targetTokens = tokens(`${target.title} ${target.dek ?? ""} ${blocksToText(target.body)}`);
  const corpusSize = corpus.docs.length;
  // Smoothed IDF: always positive, ~ln(N) for a token seen once, ~1 for ubiquitous.
  const idf = (t: string) => Math.log((corpusSize + 1) / ((corpus.docFreq.get(t) ?? 0) + 1)) + 1;
  const weightedScore = (cand: Set<string>): number => {
    let inter = 0;
    let union = 0;
    for (const t of targetTokens) {
      const w = idf(t);
      union += w;
      if (cand.has(t)) inter += w;
    }
    for (const t of cand) if (!targetTokens.has(t)) union += idf(t);
    return union === 0 ? 0 : inter / union;
  };

  // ── Evidence-aware boost (#229) ──────────────────────────────────────────
  // Two pieces citing the same evidence URL (#228 article_sources graph) are
  // genuine topical neighbors even when their prose diverges. Blend an IDF-
  // weighted Jaccard over shared source URLs on top of the text score. PURELY
  // ADDITIVE: when either side has no harvested evidence, evidenceScore is 0 and
  // the ranking is identical to the text-only scorer. The target's own source
  // set is fetched fresh so a just-published target still contributes.
  const targetSourceRows = await db
    .select({ url: articleSourcesTable.url })
    .from(articleSourcesTable)
    .where(and(eq(articleSourcesTable.articleId, target.id), eq(articleSourcesTable.role, "evidence")));
  const targetSources = new Set(targetSourceRows.map((r) => r.url));
  const sourceIdf = (u: string) => Math.log((corpusSize + 1) / ((corpus.sourceFreq.get(u) ?? 0) + 1)) + 1;
  const evidenceScore = (cand: Set<string>): number => {
    if (targetSources.size === 0 || cand.size === 0) return 0;
    let inter = 0;
    let union = 0;
    for (const u of targetSources) {
      const w = sourceIdf(u);
      union += w;
      if (cand.has(u)) inter += w;
    }
    for (const u of cand) if (!targetSources.has(u)) union += sourceIdf(u);
    return union === 0 ? 0 : inter / union;
  };
  const EVIDENCE_WEIGHT = 0.25;

  // Topical score is primary; same-category and recency only as tiebreakers.
  return corpus.docs
    .filter((d) => d.id !== target.id)
    .map((d) => ({
      slug: d.slug,
      score: weightedScore(d.tokens) + EVIDENCE_WEIGHT * evidenceScore(d.sourceKeys),
      sameCat: d.categorySlug === target.categorySlug ? 1 : 0,
      published: d.publishedAt ? d.publishedAt.getTime() : 0,
    }))
    .sort((a, b) => b.score - a.score || b.sameCat - a.sameCat || b.published - a.published);
}

// Topically-ranked "More like this" rail. Ranks true topical neighbors by an
// IDF-weighted token overlap (not category + recency, which surfaced whatever
// was merely newest in a category regardless of subject). Topical score is
// primary; same-category and recency are only tiebreakers — so a strongly-
// related cross-category piece can surface. Below-threshold rows are dropped
// (not padded with category-recent), and a curated `relatedSlugs` list on the
// article overrides the auto-scorer.
// Registered before `/articles/:slug` for clarity (the paths don't actually
// collide). Scoring runs over the in-process cached corpus (see above), so the
// only per-request DB work is the target row + a summary fetch for the winners.
router.get("/articles/:slug/related", async (req, res) => {
  const limit = req.query.limit ? Math.min(Math.max(Number(req.query.limit) || 6, 1), 12) : 6;
  const [target] = await db
    .select({
      id: articlesTable.id,
      title: articlesTable.title,
      dek: articlesTable.dek,
      body: articlesTable.body,
      categorySlug: articlesTable.categorySlug,
      relatedSlugs: articlesTable.relatedSlugs,
    })
    .from(articlesTable)
    .where(and(eq(articlesTable.slug, req.params.slug), eq(articlesTable.status, "published"), isNull(articlesTable.quarantinedAt)))
    .limit(1);
  if (!target) { res.json({ items: [] }); return; }

  // Editor override: when the article has a curated `relatedSlugs` list, return
  // exactly those (published, non-quarantined, self excluded) in the editor's
  // order, bypassing the auto-scorer entirely. Lets editors fix off-topic slips.
  const override = (target.relatedSlugs ?? []).filter((s) => typeof s === "string" && s && s !== req.params.slug);
  if (override.length > 0) {
    const wanted = override.slice(0, limit);
    const rows = await db
      .select(articleSummaryColumns)
      .from(articlesTable)
      .innerJoin(authorsTable, eq(authorsTable.id, articlesTable.authorId))
      .where(and(eq(articlesTable.status, "published"), isNull(articlesTable.quarantinedAt), eq(articlesTable.articleKind, "standard"), inArray(articlesTable.slug, wanted)));
    const bySlug = new Map(rows.map((r) => [r.slug, r]));
    const ordered = wanted.map((s) => bySlug.get(s)).filter((r): r is NonNullable<typeof r> => Boolean(r));
    const items = await Promise.all(ordered.map(resolveSummaryHero));
    res.json({ items }); return;
  }

  // Auto-scorer: rank via the shared blended scorer (IDF-weighted full-body token
  // overlap + additive evidence blend — see rankRelatedCandidates), then drop
  // anything below RELATED_MIN_SCORE. When an article has no genuine topical
  // neighbors the rail simply shows fewer (or no) items rather than padding with
  // floor-scored off-topic recency picks (which is how a sun article once
  // surfaced under a polyamory piece).
  const ranked = await rankRelatedCandidates(target);
  const wantedSlugs = ranked
    .filter((x) => x.score >= RELATED_MIN_SCORE)
    .slice(0, limit)
    .map((x) => x.slug);
  if (wantedSlugs.length === 0) { res.json({ items: [] }); return; }

  // Fetch summary rows only for the winners (≤ limit), then restore score order.
  const summaryRows = await db
    .select(articleSummaryColumns)
    .from(articlesTable)
    .innerJoin(authorsTable, eq(authorsTable.id, articlesTable.authorId))
    .where(and(eq(articlesTable.status, "published"), isNull(articlesTable.quarantinedAt), inArray(articlesTable.slug, wantedSlugs)));
  const bySlug = new Map(summaryRows.map((r) => [r.slug, r]));
  const ordered = wantedSlugs.map((s) => bySlug.get(s)).filter((r): r is NonNullable<typeof r> => Boolean(r));
  const items = await Promise.all(ordered.map(resolveSummaryHero));
  res.json({ items }); return;
});

// "Next article" for the swipe-to-next gesture — relevance-first but exhaustive.
// It prefers the most closely RELATED unseen article (same blended topical +
// shared-source scorer as the "More like this" rail), which is what the reader
// actually wants when swiping. A plain rank-1 related pick is symmetric (A's top
// neighbor is B whose top neighbor is A) and ping-ponged between two articles, so
// the client posts the set of articles already seen this session and we skip
// them. When the related pool is exhausted we fall back to a deterministic TOTAL
// order over the catalog (category sort → publish date → id), skipping visited,
// so a swipe always advances and every article stays reachable — and if the whole
// catalog has been seen we walk it anyway (ignoring visited) so it never dead-ends.
// POST (not GET) so the visited slug list rides in the body, dodging the Orval
// path+query codegen clash. Registered before `/articles/:slug` (paths don't collide).
router.post("/articles/:slug/next", async (req, res) => {
  if (!recordNextAttempt(clientKey(req))) {
    res.status(429).json({ error: "Too many requests" });
    return;
  }
  const [current] = await db
    .select({
      id: articlesTable.id,
      title: articlesTable.title,
      dek: articlesTable.dek,
      body: articlesTable.body,
      categorySlug: articlesTable.categorySlug,
      publishedAt: articlesTable.publishedAt,
      sortOrder: beatsTable.sortOrder,
    })
    .from(articlesTable)
    .leftJoin(beatsTable, eq(beatsTable.slug, articlesTable.categorySlug))
    .where(and(eq(articlesTable.slug, req.params.slug), eq(articlesTable.status, "published"), isNull(articlesTable.quarantinedAt)))
    .limit(1);
  if (!current) { res.json({ next: null }); return; }

  // Articles already seen this browsing session (client-tracked in sessionStorage
  // and posted here). Always treat the current article as visited so we never
  // return the one being read. Non-string junk is ignored defensively, and the
  // list is capped so an untrusted client can't bloat the exclusion query.
  const VISITED_CAP = 200;
  const visitedBody = Array.isArray(req.body?.visited) ? (req.body.visited as unknown[]) : [];
  const visited = new Set<string>(
    visitedBody.filter((s): s is string => typeof s === "string").slice(0, VISITED_CAP),
  );
  visited.add(req.params.slug);

  // 1) RELEVANCE-FIRST, with a light subject-diversity nudge. The base pick is
  // the most-related UNSEEN neighbor above threshold, using the same blended
  // (topical + shared-source) scorer as the "More like this" rail. Skipping
  // visited slugs is what breaks the symmetry that made a plain rank-1 pick
  // ping-pong between the same two articles forever.
  //
  // BUT dense topical clusters (e.g. lots of neuroscience/psychology) mean the
  // single top neighbor is almost always the SAME category, so a reader swiping
  // through "next" gets stuck in one subject. So once they've already read a
  // couple of articles in the current article's category this session, we prefer
  // the best still-related neighbor from a DIFFERENT category — broadening the
  // walk across subjects without abandoning relevance (the cross pick must still
  // clear RELATED_MIN_SCORE). `ranked` is sorted best-first, so the first
  // different-category entry is the strongest cross-subject neighbor.
  const ranked = await rankRelatedCandidates(current);
  const unseen = ranked.filter((x) => x.score >= RELATED_MIN_SCORE && !visited.has(x.slug));
  if (unseen.length > 0) {
    // How many articles already read this session share the current category
    // (the current slug itself is excluded — it's always in `visited`).
    const priorSlugs = [...visited].filter((s) => s !== req.params.slug);
    let sameCategoryReads = 0;
    if (priorSlugs.length > 0) {
      const priorCats = await db
        .select({ categorySlug: articlesTable.categorySlug })
        .from(articlesTable)
        .where(inArray(articlesTable.slug, priorSlugs));
      sameCategoryReads = priorCats.filter((r) => r.categorySlug === current.categorySlug).length;
    }
    const bestOverall = unseen[0];
    const bestCrossCategory = unseen.find((x) => x.sameCat === 0);
    const broaden =
      bestOverall.sameCat === 1 && sameCategoryReads >= SAME_CATEGORY_READS_LIMIT;
    const chosen = broaden && bestCrossCategory ? bestCrossCategory : bestOverall;
    const [row] = await db
      .select(articleSummaryColumns)
      .from(articlesTable)
      .innerJoin(authorsTable, eq(authorsTable.id, articlesTable.authorId))
      .where(and(eq(articlesTable.status, "published"), isNull(articlesTable.quarantinedAt), eq(articlesTable.slug, chosen.slug)))
      .limit(1);
    if (row) { res.json({ next: await resolveSummaryHero(row) }); return; }
  }

  // 2) EXHAUSTIVE FALLBACK — a deterministic catalog walk so a swipe always
  // advances even once the related pool is used up, and every article stays
  // reachable. Total-order key: category sort first (categories with no beat row
  // sort last), then newest-first publish date (null dates coalesced to the epoch
  // so they sort last), then id as a final deterministic tiebreaker.
  const cs = current.sortOrder ?? 2_147_483_647;
  const cp = current.publishedAt ?? new Date(0);
  const ci = current.id;
  const soExpr = sql`COALESCE(${beatsTable.sortOrder}, 2147483647)`;
  const cpExpr = sql`COALESCE(${articlesTable.publishedAt}, to_timestamp(0))`;

  const baseConds = and(
    eq(articlesTable.status, "published"),
    isNull(articlesTable.quarantinedAt),
    eq(articlesTable.articleKind, "standard"),
    ne(articlesTable.id, current.id),
  );
  // Strictly after the current article in the total order.
  const afterCurrent = sql`(
    ${soExpr} > ${cs}
    OR (${soExpr} = ${cs} AND ${cpExpr} < ${cp})
    OR (${soExpr} = ${cs} AND ${cpExpr} = ${cp} AND ${articlesTable.id} < ${ci})
  )`;
  const notVisited = notInArray(articlesTable.slug, [...visited]);

  const pick = async (conds: (SQL | undefined)[]) => {
    const [row] = await db
      .select(articleSummaryColumns)
      .from(articlesTable)
      .innerJoin(authorsTable, eq(authorsTable.id, articlesTable.authorId))
      .leftJoin(beatsTable, eq(beatsTable.slug, articlesTable.categorySlug))
      .where(and(baseConds, ...conds.filter((c): c is SQL => Boolean(c))))
      .orderBy(sql`${soExpr} ASC`, sql`${cpExpr} DESC`, sql`${articlesTable.id} DESC`)
      .limit(1);
    return row;
  };

  // Prefer the next UNSEEN article after the current one, then the global-first
  // unseen (wrap). If literally everything has been visited this session, fall
  // back to the plain catalog walk (ignoring visited) so a swipe still advances.
  const row =
    (await pick([afterCurrent, notVisited])) ??
    (await pick([notVisited])) ??
    (await pick([afterCurrent])) ??
    (await pick([]));
  if (!row) { res.json({ next: null }); return; }
  res.json({ next: await resolveSummaryHero(row) }); return;
});

// ── Article references & editorial trust metadata ───────────────────────────
// The public References list is the article's harvested EVIDENCE source graph
// (article_sources, role=evidence, non-rejected), deduplicated by URL and
// joined to the Source Vault for real document titles. Display name falls back
// title → in-body anchor text → bare domain. Ordered most-authoritative tier
// first so primary research leads the list. Derived deterministically — no AI.
const TIER_RANK = new Map<string, number>(SOURCE_AUTHORITY_TIER.map((t, i) => [t, i]));
// Tiers that count as "primary research" for the trust box: original/primary
// documents, firsthand statements, and wire services (matches the authority
// floor's trusted set).
const PRIMARY_RESEARCH_TIERS = new Set<string>(["primary", "firsthand", "wire"]);

// Academic databases (PubMed, CrossRef, etc.) encode special formatting inside
// stored titles using HTML markup — e.g. <i>Faecalibacterium prausnitzii</i>.
// Strip those tags here at resolution time so the link text is always plain
// readable text. Also decode the handful of entities that appear in titles.
function stripCitationHtml(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Normalized title key for detecting mirror copies of the same paper across
// different hosting URLs (doi.org, PubMed Central, publisher site). Strips all
// punctuation, lowercases, and collapses whitespace so minor typographic
// differences don't create false non-matches.
function normRefTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Last-resort display name when both snapshot title and vault title are empty
// or junk (common with bot-walled pages like doi.org resolvers). We allow the
// in-body anchor text — which is article prose, NOT a formal title — only as a
// final fallback, tightly filtered so it never shows as a sentence fragment.
// Rules: ≤80 chars, not starting with prose filler words or conjugated verbs,
// no copular predicate structure (" is "," are "," was "," were "), ≥2 words.
const PROSE_FILLER_PREFIX =
  /^(according to|a study|the study|researchers|as (noted|reported|shown)|this|the paper|it |they |we )/i;
// Anchor text that STARTS with a conjugated/auxiliary verb is a sentence
// fragment, not a title ("have reasonable trial support", "shows that…").
const STARTS_WITH_VERB_RE =
  /^(have|has|had|is|are|was|were|will|can|may|do|does|did|shows?|suggests?|indicates?|supports?|demonstrates?|reveals?|finds?|confirms?)\s/i;
// Anchor text that contains a copular predicate structure is scientific prose
// claiming something, not a bibliographic title ("elevation is well documented",
// "findings are consistent with…", "results were significant").
const COPULA_PREDICATE_RE = / (is|are|was|were|has been|have been|had been) /i;
function anchorTextAsFallback(anchor: string | null | undefined): string {
  const t = (anchor ?? "").trim();
  if (!t || t.length > 80) return "";
  if (PROSE_FILLER_PREFIX.test(t)) return "";
  if (STARTS_WITH_VERB_RE.test(t)) return "";
  if (COPULA_PREDICATE_RE.test(t)) return "";
  // Two-word minimum — admits proper names like "ESA's EnVision", "motivated
  // reasoning", "PURSUE initiative" that would otherwise fall to bare domain.
  if (t.split(/\s+/).length < 2) return "";
  return t;
}

type PublicReference = {
  name: string;
  url: string;
  domain: string;
  tier: string;
  authors: string | null;
  publisher: string | null;
  publishedAt: string | null;
  note: string | null;
};

async function buildArticleReferences(articleId: string): Promise<{
  references: PublicReference[];
  lastSourceInsertedAt: Date | null;
}> {
  const rows = await db
    .select({
      url: articleSourcesTable.url,
      domain: articleSourcesTable.domain,
      tier: articleSourcesTable.tier,
      createdAt: articleSourcesTable.createdAt,
      anchorText: articleSourcesTable.anchorText,
      sourceTitle: articleSourcesTable.sourceTitle,
      sourceAuthors: articleSourcesTable.sourceAuthors,
      publisherName: articleSourcesTable.publisherName,
      sourcePublishedAt: articleSourcesTable.sourcePublishedAt,
      citationNote: articleSourcesTable.citationNote,
      isIntermediary: articleSourcesTable.isIntermediary,
      docTitle: sourceDocumentsTable.title,
      docAuthor: sourceDocumentsTable.author,
      docPublishedAt: sourceDocumentsTable.publishedAt,
    })
    .from(articleSourcesTable)
    .leftJoin(sourceDocumentsTable, eq(sourceDocumentsTable.id, articleSourcesTable.sourceDocumentId))
    .where(
      and(
        eq(articleSourcesTable.articleId, articleId),
        eq(articleSourcesTable.role, "evidence"),
        ne(articleSourcesTable.status, "rejected"),
      ),
    );
  const byUrl = new Map<string, PublicReference>();
  // Track the most recent source insertion: when sources are topped up later
  // (back-catalogue harvest, source-link backfill, cockpit source boost), the
  // trust box's "Last updated" line should reflect THAT moment — not the
  // article's publication/edit time. Computed in JS from the already-fetched
  // rows (raw SQL aggregates come back as strings; see drizzle gotcha).
  let lastSourceInsertedAt: Date | null = null;
  for (const r of rows) {
    if (!lastSourceInsertedAt || r.createdAt > lastSourceInsertedAt) lastSourceInsertedAt = r.createdAt;
    // Search-query URLs (Google Scholar / search results pages) are not
    // sources — never surface them as references, whatever their snapshot.
    if (isSearchQueryUrl(r.url)) continue;
    // Intermediary aggregators (SciSpace, ResearchGate, Semantic Scholar) host
    // copies of papers — not the original journal publication. Skip them so the
    // public References list shows the canonical source, not the mirror.
    if (r.isIntermediary) continue;
    // Internal article cross-links stored as evidence sources are broken
    // external URLs (host has no dot / TLD) — skip them entirely.
    try {
      const u = new URL(r.url);
      if (!u.hostname.includes(".")) continue;
    } catch {
      continue;
    }
    // True citation: the snapshot title (or vault doc title). Strip any HTML
    // markup that academic databases embed in titles (e.g. <i>Species name</i>
    // from PubMed/CrossRef) so the link text is always clean readable text.
    // Junk interstitial titles ("Checking your browser") are rejected here as
    // a render-time safety net.
    const snapTitle = stripCitationHtml((r.sourceTitle ?? "").trim());
    const vaultTitle = stripCitationHtml((r.docTitle ?? "").trim());
    // Fallback chain: title → URL slug → anchor text (strictly filtered) →
    // bare domain. Anchor text is article prose, NOT the source name, so it
    // only enters when everything else fails AND it looks title-like (short,
    // not a sentence fragment, not starting with a filler phrase).
    const name =
      (!isJunkCitationTitle(snapTitle, r.domain) && snapTitle) ||
      (!isJunkCitationTitle(vaultTitle, r.domain) && vaultTitle) ||
      titleFromUrlSlug(r.url) ||
      anchorTextAsFallback(r.anchorText) ||
      r.domain;
    // Duplicate-URL rows: keep the row with the better citation (a real title
    // beats a bare-domain fallback) instead of blind first-row-wins.
    const note = (r.citationNote ?? "").trim() || null;
    const existing = byUrl.get(r.url);
    if (existing && !(existing.name === existing.domain && name !== r.domain)) {
      // Kept row lacks a note but this duplicate has one — fill it in.
      if (!existing.note && note) existing.note = note;
      continue;
    }
    const publishedAt = r.sourcePublishedAt ?? r.docPublishedAt ?? null;
    byUrl.set(r.url, {
      name,
      url: r.url,
      domain: r.domain,
      tier: r.tier,
      authors: (r.sourceAuthors ?? "").trim() || (r.docAuthor ?? "").trim() || null,
      publisher: (r.publisherName ?? "").trim() || null,
      publishedAt: publishedAt ? publishedAt.toISOString() : null,
      note: note ?? existing?.note ?? null,
    });
  }
  // Secondary dedup: collapse mirror copies of the same paper (same title at
  // different URLs — doi.org, PubMed Central, publisher site). Group byUrl
  // entries by normalized title; within each group the best-tier row wins and
  // inherits the runner-up's citation note when absent. Bare-domain fallback
  // entries (name === domain) are keyed by URL so they're never merged.
  const byTitle = new Map<string, PublicReference>();
  for (const ref of byUrl.values()) {
    const isBare = ref.name === ref.domain;
    const key = isBare ? `url:${ref.url}` : normRefTitle(ref.name);
    if (!key) {
      byTitle.set(`url:${ref.url}`, ref);
      continue;
    }
    const existing = byTitle.get(key);
    if (!existing) {
      byTitle.set(key, ref);
    } else {
      const rankNew = TIER_RANK.get(ref.tier) ?? SOURCE_AUTHORITY_TIER.length;
      const rankEx = TIER_RANK.get(existing.tier) ?? SOURCE_AUTHORITY_TIER.length;
      const newWins =
        rankNew < rankEx || (rankNew === rankEx && !!ref.authors && !existing.authors);
      if (newWins) {
        if (!ref.note && existing.note) ref.note = existing.note;
        byTitle.set(key, ref);
      } else {
        if (!existing.note && ref.note) existing.note = ref.note;
      }
    }
  }
  const references = [...byTitle.values()].sort((a, b) => {
    const ra = TIER_RANK.get(a.tier) ?? SOURCE_AUTHORITY_TIER.length;
    const rb = TIER_RANK.get(b.tier) ?? SOURCE_AUTHORITY_TIER.length;
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });
  return { references, lastSourceInsertedAt };
}

router.get("/articles/:slug", async (req, res) => {
  const [row] = await db
    .select()
    .from(articlesTable)
    .innerJoin(authorsTable, eq(authorsTable.id, articlesTable.authorId))
    .where(and(eq(articlesTable.slug, req.params.slug), eq(articlesTable.status, "published"), isNull(articlesTable.quarantinedAt)))
    .limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const { references, lastSourceInsertedAt } = await buildArticleReferences(row.articles.id);
  const primarySourceCount = references.filter((r) => PRIMARY_RESEARCH_TIERS.has(r.tier)).length;
  // What kind of editorial work produced this article — derived
  // deterministically, no AI. "Original reporting" (interviews / records /
  // firsthand data) is never auto-claimed: nothing in the pipeline gathers
  // information firsthand, so claiming it would stretch the word. Instead:
  //   - research_synthesis: drafted from an editorial evidence packet, or
  //     connects 2+ primary/firsthand/wire sources into one piece.
  //   - analysis: interprets at least one cited external source.
  //   - explainer: no external sources cited (pure explanation/essay).
  // When an editor has set an explicit override, use it verbatim. Otherwise
  // auto-derive: research_synthesis requires an evidence packet OR ≥3 primary/
  // firsthand/wire sources (raised from 2 so the label is a stronger claim).
  const editorialLabel =
    row.articles.editorialLabelOverride ??
    (row.articles.evidencePacketId || primarySourceCount >= 3
      ? "research_synthesis"
      : references.length > 0
        ? "analysis"
        : "explainer");
  res.json({
    id: row.articles.id,
    slug: row.articles.slug,
    title: row.articles.title,
    dek: row.articles.dek,
    seoTitle: row.articles.seoTitle,
    seoDescription: row.articles.seoDescription,
    category: row.articles.category,
    categorySlug: row.articles.categorySlug,
    body: row.articles.body,
    heroImage: await resolveHeroImage(row.articles.heroImage, row.articles.slug),
    shareImage: await resolveShareImage(row.articles.shareImage),
    readingTimeMinutes: row.articles.readingTimeMinutes,
    publishedAt: row.articles.publishedAt,
    articleKind: row.articles.articleKind,
    storyChainId: row.articles.storyChainId,
    chainPosition: row.articles.chainPosition,
    forceAutoRelated: row.articles.forceAutoRelated,
    hookVariants: row.articles.hookVariants,
    hookAssignments: row.articles.hookAssignments,
    socialPack: row.articles.socialPack,
    author: toPublicAuthor(row.authors),
    references,
    editorial: {
      label: editorialLabel,
      // Automated evidence verification timestamp where one exists (only
      // packet-grounded drafts get a report); the site falls back to
      // "Last updated" when null. No AI backfill — free metadata only.
      factCheckedAt: row.articles.verificationReport?.checkedAt ?? null,
      // "Last updated" = the most recent source insertion where sources
      // exist (so topping up sources refreshes the box), falling back to the
      // article's own updatedAt only when it has no sources at all.
      updatedAt: lastSourceInsertedAt ?? row.articles.updatedAt,
      sourceCount: references.length,
      primarySourceCount,
      // True when one or more evidence sources for this article have transitioned
      // to a non-active lifecycle status and the impact has not yet been cleared.
      // The trust box surfaces a disclosure notice when this is true.
      retractionNotice: !!(
        row.articles.retractionImpactAt && !row.articles.retractionImpactClearedAt
      ),
    },
  });
});

// GET /public/articles/:slug/chain — the full update chain for an article.
// Returns every published article in the same storyChainId, ordered by
// chainPosition, including the anchor (position 0) and all updates. If the
// article has no storyChainId (i.e. it's a standalone standard article) the
// list is empty.
router.get("/articles/:slug/chain", async (req, res) => {
  const [anchor] = await db
    .select({ storyChainId: articlesTable.storyChainId })
    .from(articlesTable)
    .where(and(eq(articlesTable.slug, req.params.slug), eq(articlesTable.status, "published"), isNull(articlesTable.quarantinedAt)))
    .limit(1);
  if (!anchor?.storyChainId) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const rows = await db
    .select(articleSummaryColumns)
    .from(articlesTable)
    .innerJoin(authorsTable, eq(authorsTable.id, articlesTable.authorId))
    .where(
      and(
        eq(articlesTable.storyChainId, anchor.storyChainId),
        eq(articlesTable.status, "published"),
        isNull(articlesTable.quarantinedAt),
      ),
    )
    .orderBy(asc(articlesTable.chainPosition));
  const items = await Promise.all(rows.map(resolveSummaryHero));
  // Shape as { original, updates } per the OpenAPI contract.
  // The original is chainPosition 0 (or the first row as fallback).
  const original = items.find((a) => (a.chainPosition ?? 0) === 0) ?? items[0];
  const updates = items.filter((a) => a !== original);
  res.json({ original, updates });
});

// GET /public/articles/:slug/relations — sibling articles related to this one
// via explicit article_relations edges (kind = 'subject_sibling' or other
// future kinds). Returns published, non-quarantined summaries only.
router.get("/articles/:slug/relations", async (req, res) => {
  const [anchor] = await db
    .select({ id: articlesTable.id })
    .from(articlesTable)
    .where(and(eq(articlesTable.slug, req.params.slug), eq(articlesTable.status, "published"), isNull(articlesTable.quarantinedAt)))
    .limit(1);
  if (!anchor) {
    res.json({ items: [] });
    return;
  }
  // Edges are directional (articleAId=earlier, articleBId=later); fetch both
  // directions and deduplicate so callers see one flat sibling list.
  const [asA, asB] = await Promise.all([
    db
      .select({ siblingId: articleRelationsTable.articleBId, kind: articleRelationsTable.kind })
      .from(articleRelationsTable)
      .where(eq(articleRelationsTable.articleAId, anchor.id)),
    db
      .select({ siblingId: articleRelationsTable.articleAId, kind: articleRelationsTable.kind })
      .from(articleRelationsTable)
      .where(eq(articleRelationsTable.articleBId, anchor.id)),
  ]);
  const relatedIds = [...new Set([...asA, ...asB].map((r) => r.siblingId))];
  if (relatedIds.length === 0) {
    res.json({ items: [] });
    return;
  }
  const rows = await db
    .select(articleSummaryColumns)
    .from(articlesTable)
    .innerJoin(authorsTable, eq(authorsTable.id, articlesTable.authorId))
    .where(
      and(
        inArray(articlesTable.id, relatedIds),
        eq(articlesTable.status, "published"),
        isNull(articlesTable.quarantinedAt),
      ),
    )
    .orderBy(desc(articlesTable.publishedAt));
  const items = await Promise.all(rows.map(resolveSummaryHero));
  res.json({ items });
});

// Randomized home-page feeds. The selection is drawn from the most-recently
// published articles, then shuffled server-side and re-rolled on every request
// (`no-store` keeps any proxy/CDN from pinning one shuffle). Without a category
// it draws from the 120 most-recent overall — powering BOTH the hero "lead
// story" and the "Latest Stories" rail as one consistent set (so the same post
// never shows twice at the top). With `?category=<slug>` it draws from that
// category's 50 most-recent — powering each home-page category section. The pool
// is bounded to recent rows FIRST, THEN shuffled, so older archive posts never
// surface here. `?developing=true` inverts the filter: returns ONLY update-kind
// articles (the "Developing" rail). Returns an empty list (not an error) when
// nothing is published so the client can fall back cleanly.
router.get("/home-feed", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const category = typeof req.query.category === "string" ? req.query.category : undefined;
  const developing = req.query.developing === "true";
  const poolSize = category ? 50 : 120;
  const limit = req.query.limit
    ? Math.min(Math.max(Number(req.query.limit) || 0, 0), poolSize)
    : poolSize;
  const conds = [eq(articlesTable.status, "published"), isNull(articlesTable.quarantinedAt)];
  // Standard feed: exclude update articles so they don't clutter the main feed.
  // Developing rail (?developing=true): return ORIGINAL (standard) articles that
  // have at least one update published in the last 14 days — so the rail surfaces
  // the root story, which the reader can then navigate to the latest update from.
  if (developing) {
    conds.push(eq(articlesTable.articleKind, "standard"));
    // Surface only the chain ROOT (position 0) — otherwise a Tier 2 promoted
    // update (also article_kind='standard') would appear alongside its root,
    // duplicating the same story in the rail.
    conds.push(sql`COALESCE(${articlesTable.chainPosition}, 0) = 0`);
    // A chain qualifies if it has ANY update published in the last 14 days —
    // Tier 1 stubs (article_kind='update') OR Tier 2 promoted full articles
    // (article_kind='standard' with chain_position>0). Using chain_position>0
    // catches both without requiring a specific article_kind.
    conds.push(
      sql`${articlesTable.storyChainId} IN (
        SELECT story_chain_id FROM articles
        WHERE chain_position > 0
          AND status = 'published'
          AND quarantined_at IS NULL
          AND story_chain_id IS NOT NULL
          AND published_at > NOW() - INTERVAL '14 days'
      )`,
    );
  } else {
    conds.push(eq(articlesTable.articleKind, "standard"));
  }
  if (category) conds.push(eq(articlesTable.categorySlug, category));
  const rows = await db
    .select(articleSummaryColumns)
    .from(articlesTable)
    .innerJoin(authorsTable, eq(authorsTable.id, articlesTable.authorId))
    .where(and(...conds))
    .orderBy(sql`${articlesTable.publishedAt} DESC NULLS LAST`)
    .limit(poolSize);
  // Fisher-Yates shuffle the recent pool, then take the requested count.
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  const picked = rows.slice(0, limit);
  const items = await Promise.all(picked.map(resolveSummaryHero));
  res.json({ items }); return;
});

// Random "featured" hero story for the home page. Unlike /home-feed (which draws
// from the most-recent rows overall), the eligibility pool here is the 10
// most-recently-published articles *per category* (≈120 across all beats),
// computed with a per-category ROW_NUMBER window function. One article is then
// chosen at random and re-rolled on every request (`no-store`), so the hero
// rotates across categories on each home-page access instead of being dominated
// by whichever beats publish most often. Returns 404 when nothing is published
// so the client can fall back to its newest-first list.
router.get("/featured-article", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const ranked = await db
    .select({
      id: articlesTable.id,
      rn: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${articlesTable.categorySlug} ORDER BY ${articlesTable.publishedAt} DESC NULLS LAST)`,
    })
    .from(articlesTable)
    .where(and(eq(articlesTable.status, "published"), isNull(articlesTable.quarantinedAt), eq(articlesTable.articleKind, "standard")));
  const poolIds = ranked.filter((r) => Number(r.rn) <= 10).map((r) => r.id);
  if (poolIds.length === 0) { res.status(404).json({ error: "Not found" }); return; }
  const pickId = poolIds[Math.floor(Math.random() * poolIds.length)];
  const [row] = await db
    .select(articleSummaryColumns)
    .from(articlesTable)
    .innerJoin(authorsTable, eq(authorsTable.id, articlesTable.authorId))
    .where(eq(articlesTable.id, pickId))
    .limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(await resolveSummaryHero(row)); return;
});

router.get("/beats", async (_req, res) => {
  // Public navigation (Categories chevron + footer) only lists beats that
  // actually have at least one published, non-quarantined article — empty
  // categories stay hidden until they have content. Alphabetical by name.
  const [rows, published] = await Promise.all([
    db
      .select({
        slug: beatsTable.slug,
        name: beatsTable.name,
        description: beatsTable.description,
        seoDescription: beatsTable.seoDescription,
        heroImageUrl: beatsTable.heroImageUrl,
      })
      .from(beatsTable)
      .orderBy(asc(beatsTable.name)),
    db
      .select({ slug: articlesTable.categorySlug })
      .from(articlesTable)
      .where(and(eq(articlesTable.status, "published"), isNull(articlesTable.quarantinedAt)))
      .groupBy(articlesTable.categorySlug),
  ]);
  const haveArticles = new Set(published.map((r) => r.slug));
  res.json({ items: rows.filter((b) => haveArticles.has(b.slug)) });
  return;
});

// Fisher-Yates shuffle in place (shared by the homepage aggregate below).
function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Same selection as GET /home-feed: bound to the most-recent pool first (120
// overall, 50 per category), THEN shuffle, then take the requested count.
async function fetchShuffledFeed(category: string | undefined, limit: number) {
  const poolSize = category ? 50 : 120;
  const conds = [eq(articlesTable.status, "published"), isNull(articlesTable.quarantinedAt), eq(articlesTable.articleKind, "standard")];
  if (category) conds.push(eq(articlesTable.categorySlug, category));
  const rows = await db
    .select(articleSummaryColumns)
    .from(articlesTable)
    .innerJoin(authorsTable, eq(authorsTable.id, articlesTable.authorId))
    .where(and(...conds))
    .orderBy(sql`${articlesTable.publishedAt} DESC NULLS LAST`)
    .limit(poolSize);
  shuffleInPlace(rows);
  return rows.slice(0, Math.max(limit, 0));
}

// Same pick as GET /featured-article: random from the 10 most-recent per
// category. Returns null (not 404) when nothing is published.
async function pickFeaturedRow() {
  const ranked = await db
    .select({
      id: articlesTable.id,
      rn: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${articlesTable.categorySlug} ORDER BY ${articlesTable.publishedAt} DESC NULLS LAST)`,
    })
    .from(articlesTable)
    .where(and(eq(articlesTable.status, "published"), isNull(articlesTable.quarantinedAt), eq(articlesTable.articleKind, "standard")));
  const poolIds = ranked.filter((r) => Number(r.rn) <= 10).map((r) => r.id);
  if (poolIds.length === 0) return null;
  const pickId = poolIds[Math.floor(Math.random() * poolIds.length)];
  const [row] = await db
    .select(articleSummaryColumns)
    .from(articlesTable)
    .innerJoin(authorsTable, eq(authorsTable.id, articlesTable.authorId))
    .where(eq(articlesTable.id, pickId))
    .limit(1);
  return row ?? null;
}

// Aggregate home-page payload: featured hero + "Latest Stories" rail + every
// per-category section, in one request. Composes the exact logic the home page
// used to run client-side across getFeaturedArticle / getHomeFeed (overall) /
// getHomeFeed (per category) / beats — same randomization, same `no-store`
// freshness, and the same cross-section de-duplication (no story appears twice).
// Empty category sections are omitted; `featured` is null only when nothing is
// published.
router.get("/homepage", async (_req, res) => {
  res.set("Cache-Control", "no-store");

  const [pickedFeatured, feedRows, beatRows] = await Promise.all([
    pickFeaturedRow(),
    fetchShuffledFeed(undefined, 7),
    db
      .select({
        slug: beatsTable.slug,
        name: beatsTable.name,
        description: beatsTable.description,
        heroImageUrl: beatsTable.heroImageUrl,
      })
      .from(beatsTable)
      .orderBy(asc(beatsTable.name)),
  ]);

  // Mirror the client fallback: if the featured pick is empty, use the first
  // shuffled feed item (in practice both are empty only when nothing exists).
  const featuredRow = pickedFeatured ?? (feedRows.length > 0 ? feedRows[0] : null);
  const featuredId = featuredRow?.id;

  // The "Latest Stories" rail is the shuffled feed minus the featured story.
  const recentRows = feedRows.filter((a) => a.id !== featuredId).slice(0, 6);
  const excludeIds = new Set<string>(
    [featuredId, ...recentRows.map((a) => a.id)].filter((id): id is string => Boolean(id)),
  );

  // Each category section draws from its own shuffled recent pool, drops
  // anything already shown at the top, and keeps the first 3.
  const rawSections = await Promise.all(
    beatRows.map(async (beat) => {
      const catRows = await fetchShuffledFeed(beat.slug, 12);
      const items = catRows.filter((a) => !excludeIds.has(a.id)).slice(0, 3);
      return { beat, items };
    }),
  );

  const featured = featuredRow ? await resolveSummaryHero(featuredRow) : null;
  const latest = await Promise.all(recentRows.map(resolveSummaryHero));
  const sections = await Promise.all(
    rawSections
      .filter((s) => s.items.length > 0)
      .map(async (s) => ({
        beat: s.beat,
        items: await Promise.all(s.items.map(resolveSummaryHero)),
      })),
  );

  res.json({ featured, latest, sections });
  return;
});

router.get("/authors", async (_req, res) => {
  const items = await db.select().from(authorsTable).where(eq(authorsTable.active, true));
  res.json({ items: items.map(toPublicAuthor) }); return;
});

// Resolve an author slug to its canonical (current) slug. Powers the per-author
// page's 301-redirect of retired slugs after a rename (see the prod SSR server's
// /author/ handler). Resolution checks the live authors table first (a real slug
// is always canonical and wins over any stale redirect row), then falls back to
// the redirect map, looking up the author BY ID so chained renames always
// collapse to the author's current slug. Not in the OpenAPI spec on purpose:
// it's consumed only by the SSR server via raw fetch (same pattern as the SEO
// routes), not by the generated client.
router.get("/authors/:slug/resolve", async (req, res) => {
  const slug = req.params.slug;
  const [author] = await db
    .select({ slug: authorsTable.slug })
    .from(authorsTable)
    .where(eq(authorsTable.slug, slug))
    .limit(1);
  if (author) {
    res.json({ canonical: author.slug, redirect: false });
    return;
  }
  const [redirected] = await db
    .select({ slug: authorsTable.slug })
    .from(authorSlugRedirectsTable)
    .innerJoin(authorsTable, eq(authorsTable.id, authorSlugRedirectsTable.authorId))
    .where(eq(authorSlugRedirectsTable.oldSlug, slug))
    .limit(1);
  if (redirected) {
    res.json({ canonical: redirected.slug, redirect: true });
    return;
  }
  res.status(404).json({ error: "not_found" });
  return;
});

router.get("/site-settings", async (_req, res) => {
  const s = await getSiteSettings();
  // Only expose visitor-facing flags publicly. Operational flags like
  // pipelineEnabled stay on the admin endpoint.
  res.json({ adsEnabled: s.adsEnabled });
  return;
});

router.post("/subscribe", async (req, res) => {
  const rate = recordSubscribeAttempt(clientKey(req));
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "Too many requests. Please try again later." });
    return;
  }

  const parsed = SubscribeNewsletterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Please enter a valid email address." });
    return;
  }

  // Honeypot: a real user never fills the hidden `website` field. Bots that do
  // get a success response (so they don't probe further) but nothing is stored.
  if (parsed.data.website && parsed.data.website.trim().length > 0) {
    req.log.warn({ key: clientKey(req) }, "Honeypot triggered on subscribe");
    res.json({ ok: true, alreadySubscribed: false });
    return;
  }

  const email = parsed.data.email.trim().toLowerCase();

  // Reader-chosen topic preference. Validate the submitted slug against the
  // beats list so a stale/forged slug can never be stored; anything that doesn't
  // resolve to a real beat is treated as "everything" (null). Empty string and
  // null both mean "no preference".
  const requestedCategory = parsed.data.preferredCategory?.trim().toLowerCase() || null;
  let preferredCategory: string | null = null;
  if (requestedCategory) {
    const beat = await db
      .select({ slug: beatsTable.slug })
      .from(beatsTable)
      .where(eq(beatsTable.slug, requestedCategory))
      .limit(1);
    if (beat.length > 0) preferredCategory = requestedCategory;
  }

  // Insert a brand-new subscriber, OR re-activate one who had previously
  // unsubscribed (clears `unsubscribedAt`). The `setWhere` guard means an
  // already-active subscriber is left untouched and RETURNING yields no row, so
  // `inserted.length === 0` cleanly distinguishes "nothing to do" from both a
  // first-time signup and a genuine re-subscribe — both of which deserve the
  // welcome email. The unsubscribe token is generated once and kept stable. A
  // reactivation also adopts the freshly-submitted preference (only when one was
  // given, so it never clobbers a stored preference with a blank).
  const inserted = await db
    .insert(subscribersTable)
    .values({ email, unsubscribeToken: randomBytes(24).toString("hex"), preferredCategory })
    .onConflictDoUpdate({
      target: subscribersTable.email,
      set: { unsubscribedAt: null, ...(preferredCategory ? { preferredCategory } : {}) },
      // Re-activate a prior opt-out, BUT never resurrect a hard-suppressed address
      // (bounce / complaint / manual removal): a suppressed row is left untouched,
      // so RETURNING is empty and no welcome email fires. This blocks silent
      // re-subscribe of addresses we know are bad or that complained.
      setWhere: sql`${subscribersTable.unsubscribedAt} IS NOT NULL AND ${subscribersTable.suppressedAt} IS NULL`,
    })
    .returning({ email: subscribersTable.email, unsubscribeToken: subscribersTable.unsubscribeToken });
  const alreadySubscribed = inserted.length === 0;

  // An already-active subscriber who resubmits with a (valid) preference gets it
  // updated in place — the upsert above intentionally leaves active rows
  // untouched, so apply the preference change here without re-triggering the
  // welcome email.
  if (alreadySubscribed && preferredCategory) {
    await db
      .update(subscribersTable)
      .set({ preferredCategory })
      .where(and(eq(subscribersTable.email, email), isNull(subscribersTable.unsubscribedAt)));
  }

  // Fire-and-forget the welcome email so a slow/failed delivery never blocks or
  // breaks the signup response. Only sent for genuinely new (or re-activated)
  // subscribers.
  if (!alreadySubscribed && inserted[0]) {
    const token = inserted[0].unsubscribeToken;
    void sendWelcomeEmail(email, token)
      .then((result) => {
        if (result.delivered) {
          req.log.info({ emailHash: hashEmail(email), provider: result.provider, id: result.id }, "Welcome email sent");
        } else {
          req.log.warn({ emailHash: hashEmail(email), provider: result.provider, skipped: result.skipped }, "Welcome email not delivered");
        }
      })
      .catch((err) => req.log.error({ err, emailHash: hashEmail(email) }, "Welcome email threw unexpectedly"));
  }

  res.json({ ok: true, alreadySubscribed });
  return;
});

// Token-based opt-out. The token comes from the unsubscribe link embedded in
// outbound emails, so no authentication is required and the reader's email is
// never exposed in the URL. Idempotent: unsubscribing an already-opted-out
// address still returns 200 (with alreadyUnsubscribed=true) so a reader who
// clicks the link twice never sees an error.
// RFC 8058 one-click unsubscribe. Mailbox providers (Gmail, Yahoo) POST
// `List-Unsubscribe=One-Click` to the List-Unsubscribe URL with NO cookies and
// no user interaction, so this endpoint is keyed only by the per-subscriber
// token in the query string and must respond 2xx on success. Idempotent: an
// already-unsubscribed token still returns ok.
router.post("/unsubscribe-oneclick", async (req, res) => {
  const raw = req.query["token"];
  const token = typeof raw === "string" ? raw.trim() : "";
  if (!token) {
    res.status(400).json({ error: "Missing unsubscribe token." });
    return;
  }
  const [existing] = await db
    .select({ email: subscribersTable.email, unsubscribedAt: subscribersTable.unsubscribedAt })
    .from(subscribersTable)
    .where(eq(subscribersTable.unsubscribeToken, token))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Invalid unsubscribe token." });
    return;
  }
  if (!existing.unsubscribedAt) {
    await db
      .update(subscribersTable)
      .set({ unsubscribedAt: new Date() })
      .where(eq(subscribersTable.unsubscribeToken, token));
    req.log.info({ emailHash: hashEmail(existing.email) }, "Subscriber unsubscribed (one-click)");
  }
  res.json({ ok: true });
  return;
});

router.post("/unsubscribe", async (req, res) => {
  const parsed = UnsubscribeNewsletterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid unsubscribe token." });
    return;
  }

  const token = parsed.data.token.trim();
  const [existing] = await db
    .select({ email: subscribersTable.email, unsubscribedAt: subscribersTable.unsubscribedAt })
    .from(subscribersTable)
    .where(eq(subscribersTable.unsubscribeToken, token))
    .limit(1);

  if (!existing) {
    res.status(404).json({ error: "This unsubscribe link is invalid or has expired." });
    return;
  }

  if (existing.unsubscribedAt) {
    res.json({ ok: true, alreadyUnsubscribed: true, email: existing.email });
    return;
  }

  await db
    .update(subscribersTable)
    .set({ unsubscribedAt: new Date() })
    .where(eq(subscribersTable.unsubscribeToken, token));

  req.log.info({ emailHash: hashEmail(existing.email) }, "Subscriber unsubscribed");
  res.json({ ok: true, alreadyUnsubscribed: false, email: existing.email });
  return;
});

// Record a single click on an article Share button. Best-effort: the client
// fires this and does not wait, so failures never block the actual share. We
// still validate and rate-limit so the share counters can't be trivially
// flooded.
router.post("/share", async (req, res) => {
  if (!recordShareAttempt(clientKey(req))) {
    res.status(429).json({ error: "Too many requests." });
    return;
  }

  const parsed = RecordShareEventBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid share payload." });
    return;
  }

  // Never trust the client-supplied slug/title: a share counter must only count
  // real, live articles. Resolve the slug to a published, non-quarantined
  // article and snapshot the *DB* title (the client title is ignored). An
  // unknown slug is silently dropped so spoofed events can't inflate counters.
  const [article] = await db
    .select({ title: articlesTable.title })
    .from(articlesTable)
    .where(
      and(
        eq(articlesTable.slug, parsed.data.slug),
        eq(articlesTable.status, "published"),
        isNull(articlesTable.quarantinedAt),
      ),
    )
    .limit(1);
  if (!article) {
    res.json({ ok: true });
    return;
  }

  await db.insert(shareEventsTable).values({
    articleSlug: parsed.data.slug,
    articleTitle: article.title,
    platform: parsed.data.platform,
  });

  res.json({ ok: true });
  return;
});

// Record a single article page view. Best-effort: the client fires this on
// article load and does not wait, so failures never block rendering. Same
// validate-and-rate-limit discipline as the share endpoint — the slug is
// resolved against a published, non-quarantined article and the DB title is
// snapshotted; unknown slugs are silently dropped so counters can't be spoofed.
router.post("/view", async (req, res) => {
  if (!recordViewAttempt(clientKey(req))) {
    res.status(429).json({ error: "Too many requests." });
    return;
  }

  // Admin sessions are excluded from the internal page-view counter so they
  // don't skew reader analytics. GA4 is client-side and unaffected.
  if (isAdminEmail((req.session as { adminEmail?: string }).adminEmail)) {
    res.json({ ok: true });
    return;
  }

  const parsed = RecordPageViewBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid view payload." });
    return;
  }

  const [article] = await db
    .select({ title: articlesTable.title })
    .from(articlesTable)
    .where(
      and(
        eq(articlesTable.slug, parsed.data.slug),
        eq(articlesTable.status, "published"),
        isNull(articlesTable.quarantinedAt),
      ),
    )
    .limit(1);
  if (!article) {
    res.json({ ok: true });
    return;
  }

  // Defensive normalization — trim and cap each attribution field; empty becomes
  // null so legacy/unattributed rows stay NULL rather than "".
  const norm = (v: string | undefined, max: number): string | null => {
    const t = (v ?? "").trim();
    return t ? t.slice(0, max) : null;
  };

  const seq = parsed.data.viewSequence;
  await db.insert(pageViewsTable).values({
    articleSlug: parsed.data.slug,
    articleTitle: article.title,
    source: norm(parsed.data.source, 200),
    medium: norm(parsed.data.medium, 200),
    campaign: norm(parsed.data.campaign, 200),
    content: norm(parsed.data.content, 200),
    referrerHost: norm(parsed.data.referrerHost, 255),
    // Anonymous reader-journey identity + path position (all nullable).
    visitorId: norm(parsed.data.visitorId, 64),
    sessionId: norm(parsed.data.sessionId, 64),
    previousSlug: norm(parsed.data.previousSlug, 300),
    entrySlug: norm(parsed.data.entrySlug, 300),
    viewSequence: typeof seq === "number" && Number.isFinite(seq) && seq >= 1 ? Math.floor(seq) : null,
  });

  res.json({ ok: true });
  return;
});

// Record a single click on an INTERNAL recommendation/navigation surface (a link
// to another article). Best-effort: the client fires this via sendBeacon on
// navigation and never waits. Same validate-and-rate-limit discipline as /view —
// the destination slug is resolved to a published, non-quarantined article and
// the DB title is snapshotted; unknown slugs are silently dropped. No PII.
router.post("/internal-click", async (req, res) => {
  if (!recordViewAttempt(clientKey(req))) {
    res.status(429).json({ error: "Too many requests." });
    return;
  }

  const parsed = RecordInternalClickBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid click payload." });
    return;
  }

  const [article] = await db
    .select({ title: articlesTable.title })
    .from(articlesTable)
    .where(
      and(
        eq(articlesTable.slug, parsed.data.toSlug),
        eq(articlesTable.status, "published"),
        isNull(articlesTable.quarantinedAt),
      ),
    )
    .limit(1);
  if (!article) {
    res.json({ ok: true });
    return;
  }

  const norm = (v: string | undefined, max: number): string | null => {
    const t = (v ?? "").trim();
    return t ? t.slice(0, max) : null;
  };
  const rank = parsed.data.recommendationRank;

  await db.insert(internalClicksTable).values({
    toSlug: parsed.data.toSlug,
    toTitle: article.title,
    fromSlug: norm(parsed.data.fromSlug, 300),
    placement: parsed.data.placement,
    recommendationRank: typeof rank === "number" && Number.isFinite(rank) && rank >= 1 ? Math.floor(rank) : null,
    interactionType: parsed.data.interactionType ?? "click",
    visitorId: norm(parsed.data.visitorId, 64),
    sessionId: norm(parsed.data.sessionId, 64),
  });

  res.json({ ok: true });
  return;
});

// Record a swipe-next prompt lifecycle event (impression / activation /
// dismissal). Best-effort via sendBeacon. Rate-limited per IP. Slugs are
// validated against published, non-quarantined articles (mirroring the view and
// internal-click flows) so the analytics only contain real content; invalid
// rows are dropped quietly. No PII.
router.post("/swipe-event", async (req, res) => {
  if (!recordViewAttempt(clientKey(req))) {
    res.status(429).json({ error: "Too many requests." });
    return;
  }

  const parsed = RecordSwipeEventBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid swipe payload." });
    return;
  }

  const norm = (v: string | undefined, max: number): string | null => {
    const t = (v ?? "").trim();
    return t ? t.slice(0, max) : null;
  };

  const isPublishedSlug = async (slug: string): Promise<boolean> => {
    const [row] = await db
      .select({ id: articlesTable.id })
      .from(articlesTable)
      .where(
        and(
          eq(articlesTable.slug, slug),
          eq(articlesTable.status, "published"),
          isNull(articlesTable.quarantinedAt),
        ),
      )
      .limit(1);
    return Boolean(row);
  };

  const articleSlug = parsed.data.articleSlug.trim();
  if (!articleSlug || !(await isPublishedSlug(articleSlug))) {
    res.json({ ok: true });
    return;
  }

  // targetSlug is optional (only present on activations); drop it if it no
  // longer resolves but still keep the lifecycle event.
  let targetSlug = norm(parsed.data.targetSlug, 300);
  if (targetSlug && !(await isPublishedSlug(targetSlug))) {
    targetSlug = null;
  }

  await db.insert(swipeEventsTable).values({
    articleSlug: articleSlug.slice(0, 300),
    targetSlug,
    eventType: parsed.data.eventType,
    method: parsed.data.eventType === "activation" ? (parsed.data.method ?? null) : null,
    visitorId: norm(parsed.data.visitorId, 64),
    sessionId: norm(parsed.data.sessionId, 64),
  });

  res.json({ ok: true });
  return;
});

// ---------------------------------------------------------------------------
// Concept Explainer & Glossary — public read routes (Task #284)
// ---------------------------------------------------------------------------
// These are purely GET/read endpoints (no AI calls, no state mutation) so they
// carry no additional cost and do not need admin auth.

// GET /public/concepts
// List all live concepts, paginated. Used by the /glossary index page.
// Query: limit, offset, q (search term)
router.get("/concepts", async (req, res) => {
  // Reader-facing kill-switch: when Concept Explainers are disabled the whole
  // glossary disappears immediately (the SSR server renders empty/noindex).
  const settings = await getSiteSettings();
  if (!settings.conceptExplainersEnabled) {
    res.json({ concepts: [], total: 0 });
    return;
  }
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const q = (req.query.q as string)?.trim() ?? "";
  const sort = (req.query.sort as string) || "alpha";
  // letter: single A-Z character — filters terms starting with that letter.
  // Ignored when q is also provided (search takes precedence).
  const rawLetter = (req.query.letter as string)?.trim().toUpperCase().slice(0, 1) ?? "";
  const letter = !q && /^[A-Z]$/.test(rawLetter) ? rawLetter : "";

  const cond = and(
    eq(conceptsTable.status, "live"),
    // Hidden terms (termOfDayBlocked) never appear in the public glossary
    // index, search, or anywhere else on the site — hover tooltips only.
    eq(conceptsTable.termOfDayBlocked, false),
    q ? ilike(conceptsTable.term, `%${q}%`) : undefined,
    letter ? ilike(conceptsTable.term, `${letter}%`) : undefined,
  );

  // alpha (default) = A–Z; popular = most linked articles first;
  // recent = newest concepts first. Ties always break deterministically.
  const ordering =
    sort === "popular"
      ? [desc(conceptsTable.articleCount), asc(conceptsTable.term), asc(conceptsTable.id)]
      : sort === "recent"
        ? [desc(conceptsTable.createdAt), asc(conceptsTable.id)]
        : [asc(conceptsTable.term), asc(conceptsTable.id)];

  const [rows, [countRow]] = await Promise.all([
    db
      .select({
        id: conceptsTable.id,
        slug: conceptsTable.slug,
        term: conceptsTable.term,
        hoverDefinition: conceptsTable.hoverDefinition,
        definition: conceptsTable.definition,
        articleCount: conceptsTable.articleCount,
        wikiUrl: conceptsTable.wikiUrl,
      })
      .from(conceptsTable)
      .where(cond)
      .orderBy(...ordering)
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(conceptsTable)
      .where(cond),
  ]);

  res.json({ concepts: rows, total: Number(countRow?.count ?? 0) });
});

/** Query-param names that look like credentials/signed-URL material. */
const SECRET_PARAM_RE = /(token|secret|signature|password|passwd|auth|session|apikey|api_key)/i;

/**
 * Sanitizer for URLs surfaced on public glossary pages. Returns a cleaned URL
 * or null when the URL must not be shown. Only plain http(s) URLs with a real
 * public-looking hostname pass — file paths, internal hosts, IP literals,
 * localhost, and URLs carrying embedded credentials are dropped rather than
 * leaked; secret-looking query params are stripped from otherwise-safe URLs.
 */
function sanitizePublicSourceUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    // Embedded credentials (https://user:pass@host/…) must never be emitted.
    if (u.username || u.password) return null;
    const host = u.hostname.toLowerCase();
    if (!host.includes(".")) return null; // bare hostnames (localhost, internal)
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return null;
    // IPv4 literal or bracketed IPv6
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) return null;
    // Strip secret-bearing query params (signed URLs, access tokens…)
    const toDelete: string[] = [];
    u.searchParams.forEach((_v, k) => {
      if (SECRET_PARAM_RE.test(k) || k.toLowerCase() === "sig" || k.toLowerCase() === "key" || k.toLowerCase().startsWith("x-amz-")) {
        toDelete.push(k);
      }
    });
    for (const k of toDelete) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return null;
  }
}

// GET /public/concepts/:slug
// Full concept detail including aliases and article list, used by the /glossary/:slug page.
router.get("/concepts/:slug", async (req, res) => {
  // Reader-facing kill-switch (glossary detail pages 404 → SSR emits noindex)
  const settings = await getSiteSettings();
  if (!settings.conceptExplainersEnabled) {
    res.status(404).json({ error: "concept_not_found" });
    return;
  }
  let [concept] = await db
    .select()
    .from(conceptsTable)
    .where(
      and(
        eq(conceptsTable.slug, req.params.slug as string),
        eq(conceptsTable.status, "live"),
        // Hidden terms have no public page — 404 (SSR then emits noindex).
        eq(conceptsTable.termOfDayBlocked, false),
      ),
    )
    .limit(1);

  // Merged-slug fallback: when a concept is merged away, its term (and
  // aliases) become aliases of the survivor. Old /glossary/<loser-slug> links
  // resolve to the canonical entry by slugifying stored aliases in SQL and
  // matching the requested slug. The response carries the survivor's own slug,
  // so the client canonicalises the URL and SSR emits the canonical meta.
  if (!concept) {
    [concept] = await db
      .select({ concept: conceptsTable })
      .from(conceptAliasesTable)
      .innerJoin(conceptsTable, eq(conceptsTable.id, conceptAliasesTable.conceptId))
      .where(
        and(
          eq(conceptsTable.status, "live"),
          eq(conceptsTable.termOfDayBlocked, false),
          sql`trim(both '-' from regexp_replace(lower(${conceptAliasesTable.alias}), '[^a-z0-9]+', '-', 'g')) = ${req.params.slug as string}`,
        ),
      )
      // Deterministic pick when several aliases slugify identically:
      // oldest surviving concept wins, id as final tiebreak.
      .orderBy(asc(conceptsTable.createdAt), asc(conceptsTable.id))
      .limit(1)
      .then((rows) => rows.map((r) => r.concept));
  }

  if (!concept) {
    res.status(404).json({ error: "concept_not_found" });
    return;
  }

  const [aliases, articleRows, relatedConcepts, seenInBrainHook, relationshipRows] = await Promise.all([
    db
      .select({ id: conceptAliasesTable.id, alias: conceptAliasesTable.alias, isPrimary: conceptAliasesTable.isPrimary })
      .from(conceptAliasesTable)
      .where(eq(conceptAliasesTable.conceptId, concept.id)),
    db
      .selectDistinctOn([articlesTable.id], {
        slug: articlesTable.slug,
        title: articlesTable.title,
        publishedAt: articlesTable.publishedAt,
      })
      .from(articleConceptMentionsTable)
      .innerJoin(articlesTable, eq(articlesTable.id, articleConceptMentionsTable.articleId))
      .where(
        and(
          eq(articleConceptMentionsTable.conceptId, concept.id),
          eq(articlesTable.status, "published"),
          isNull(articlesTable.quarantinedAt),
        ),
      )
      .orderBy(articlesTable.id, desc(articlesTable.publishedAt)),
    // For each alias, find if there is another live concept whose term or
    // aliases match it. Returns { matchedAlias, slug, term } rows.
    db
      .select({
        matchedAlias: conceptAliasesTable.alias,
        slug: conceptsTable.slug,
        term: conceptsTable.term,
      })
      .from(conceptAliasesTable)
      .innerJoin(conceptsTable, eq(conceptsTable.id, conceptAliasesTable.conceptId))
      .where(
        and(
          inArray(
            conceptAliasesTable.alias,
            db
              .select({ alias: conceptAliasesTable.alias })
              .from(conceptAliasesTable)
              .where(eq(conceptAliasesTable.conceptId, concept.id)),
          ),
          eq(conceptsTable.status, "live"),
          // Hidden terms never surface as related-concept links.
          eq(conceptsTable.termOfDayBlocked, false),
          // exclude the current concept itself
          sql`${conceptsTable.id} != ${concept.id}`,
        ),
      ),
    // "Seen in BrainHook" — per-article context snippets showing how this term appears
    db
      .select({
        articleSlug: articlesTable.slug,
        articleTitle: articlesTable.title,
        contextSnippet: articleConceptMentionsTable.contextSnippet,
        paragraphIndex: articleConceptMentionsTable.paragraphIndex,
        matchedTerm: articleConceptMentionsTable.matchedTerm,
      })
      .from(articleConceptMentionsTable)
      .innerJoin(articlesTable, eq(articlesTable.id, articleConceptMentionsTable.articleId))
      .where(
        and(
          eq(articleConceptMentionsTable.conceptId, concept.id),
          eq(articlesTable.status, "published"),
          isNull(articlesTable.quarantinedAt),
          // Only include rows that have a real context snippet
          sql`${articleConceptMentionsTable.contextSnippet} IS NOT NULL`,
        ),
      )
      .orderBy(articlesTable.publishedAt)
      .limit(30),
    // Curated relationships — both directions, other endpoint resolved to a
    // live concept only (draft/hidden targets never leak to readers).
    db
      .select({
        fromConceptId: conceptRelationshipsTable.fromConceptId,
        toConceptId: conceptRelationshipsTable.toConceptId,
        relationType: conceptRelationshipsTable.relationType,
      })
      .from(conceptRelationshipsTable)
      .where(
        sql`${conceptRelationshipsTable.fromConceptId} = ${concept.id} OR ${conceptRelationshipsTable.toConceptId} = ${concept.id}`,
      ),
  ]);

  // Resolve relationship endpoints and normalize direction. Directional types
  // are inverted when this concept is the target: an incoming parent_of means
  // this concept is a subtype_of the other, and vice versa. All other types
  // are symmetric.
  const relOtherIds = [
    ...new Set(
      relationshipRows.map((r) => (r.fromConceptId === concept.id ? r.toConceptId : r.fromConceptId)),
    ),
  ];
  const relOthers = relOtherIds.length
    ? await db
        .select({ id: conceptsTable.id, term: conceptsTable.term, slug: conceptsTable.slug })
        .from(conceptsTable)
        .where(
          and(
            inArray(conceptsTable.id, relOtherIds),
            eq(conceptsTable.status, "live"),
            eq(conceptsTable.termOfDayBlocked, false),
          ),
        )
    : [];
  const relById = new Map(relOthers.map((c) => [c.id, c]));
  const INVERT: Record<string, string> = { parent_of: "subtype_of", subtype_of: "parent_of" };
  const seenRel = new Set<string>();
  const relationships: Array<{ relationType: string; term: string; slug: string }> = [];
  for (const r of relationshipRows) {
    const outgoing = r.fromConceptId === concept.id;
    const other = relById.get(outgoing ? r.toConceptId : r.fromConceptId);
    if (!other) continue;
    const relationType = outgoing ? r.relationType : (INVERT[r.relationType] ?? r.relationType);
    const key = `${relationType}:${other.slug}`;
    if (seenRel.has(key)) continue;
    seenRel.add(key);
    relationships.push({ relationType, term: other.term, slug: other.slug });
  }

  // Shared-alias "related concepts" must not repeat concepts that already have
  // a curated relationship (e.g. a distinct_from pair would otherwise ALSO show
  // under "Related concepts", visually re-conflating what the relationship
  // explicitly separates).
  const relationshipSlugs = new Set(relationships.map((r) => r.slug));
  const filteredRelatedConcepts = relatedConcepts.filter((rc) => !relationshipSlugs.has(rc.slug));

  // Transparent source trail — visible editorial advantage. Enriched from the
  // Source Vault so the public payload carries real metadata (title, publisher,
  // authority tier, publication date) instead of raw URLs + internal labels.
  const sourceTrailRows = await db
    .select({
      sourceUrl: conceptSourcesTable.sourceUrl,
      sourceType: conceptSourcesTable.sourceType,
      relevanceScore: conceptSourcesTable.relevanceScore,
      recordedAt: conceptSourcesTable.createdAt,
      claimRelevant: conceptSourcesTable.claimRelevant,
    })
    .from(conceptSourcesTable)
    .where(
      and(
        eq(conceptSourcesTable.conceptId, concept.id),
        // claim_relevant IS NOT FALSE: null (legacy/unverified) AND true both pass;
        // only explicitly false (post-filter rejected) rows are excluded.
        sql`${conceptSourcesTable.claimRelevant} IS NOT FALSE`,
      ),
    )
    .orderBy(desc(conceptSourcesTable.relevanceScore));

  // Defensive guard: warn when unverified (NULL claim_relevant) sources reach
  // the public source trail. The source-relevance backfill should clear these —
  // this log is the signal that it hasn't run to completion yet.
  const nullCount = sourceTrailRows.filter((r) => r.claimRelevant === null).length;
  if (nullCount > 0) {
    req.log.warn(
      { conceptSlug: concept.slug, nullCount, total: sourceTrailRows.length },
      "public/glossary: source trail contains unverified (NULL claim_relevant) rows — run the source-relevance backfill",
    );
  }

  // Deterministic two-step vault lookup (instead of an OR-join, which can
  // row-explode and pick an arbitrary doc among multi-matches): exact-URL
  // match wins, canonical-URL match is the fallback; within each map the
  // earliest-created doc wins.
  type TrailDoc = {
    url: string;
    canonicalUrl: string | null;
    title: string | null;
    author: string | null;
    domain: string;
    publishedAt: Date | null;
    authorityTier: string;
  };
  const docsByUrl = new Map<string, TrailDoc>();
  const docsByCanonical = new Map<string, TrailDoc>();
  if (sourceTrailRows.length > 0) {
    const trailUrls = [...new Set(sourceTrailRows.map((r) => r.sourceUrl))];
    const docs = await db
      .select({
        url: sourceDocumentsTable.url,
        canonicalUrl: sourceDocumentsTable.canonicalUrl,
        title: sourceDocumentsTable.title,
        author: sourceDocumentsTable.author,
        domain: sourceDocumentsTable.domain,
        publishedAt: sourceDocumentsTable.publishedAt,
        authorityTier: sourceDocumentsTable.authorityTier,
      })
      .from(sourceDocumentsTable)
      .where(
        sql`${inArray(sourceDocumentsTable.url, trailUrls)} OR ${inArray(sourceDocumentsTable.canonicalUrl, trailUrls)}`,
      )
      .orderBy(asc(sourceDocumentsTable.createdAt), asc(sourceDocumentsTable.id));
    for (const d of docs) {
      if (!docsByUrl.has(d.url)) docsByUrl.set(d.url, d);
      if (d.canonicalUrl && !docsByCanonical.has(d.canonicalUrl)) docsByCanonical.set(d.canonicalUrl, d);
    }
  }

  // Dedupe by URL and drop anything that is not a safe public web URL — a
  // vault record from an internal/private location must never leak onto a
  // public glossary page.
  const seenTrailUrls = new Set<string>();
  const sourceTrail: Array<{
    sourceUrl: string;
    sourceType: "wikipedia" | "vault";
    relevanceScore: number;
    title: string | null;
    author: string | null;
    publisher: string | null;
    publishedAt: string | null;
    verifiedAt: string | null;
    authorityTier: string;
  }> = [];
  for (const s of sourceTrailRows) {
    const doc = docsByUrl.get(s.sourceUrl) ?? docsByCanonical.get(s.sourceUrl) ?? null;
    // Prefer the vault's canonical URL when it sanitizes cleanly, else fall
    // back to the recorded source URL; drop the entry entirely if neither is
    // a safe public web URL.
    const publicUrl =
      (doc?.canonicalUrl ? sanitizePublicSourceUrl(doc.canonicalUrl) : null) ??
      sanitizePublicSourceUrl(s.sourceUrl);
    if (!publicUrl) continue;
    if (seenTrailUrls.has(publicUrl)) continue;
    seenTrailUrls.add(publicUrl);
    let publisher: string | null = doc?.domain ?? null;
    if (!publisher) {
      try {
        publisher = new URL(publicUrl).hostname.replace(/^www\./, "");
      } catch {
        publisher = null;
      }
    }
    sourceTrail.push({
      sourceUrl: publicUrl,
      sourceType: s.sourceType,
      relevanceScore: s.relevanceScore,
      title: doc?.title ?? null,
      author: doc?.author ?? null,
      publisher,
      publishedAt: doc?.publishedAt ? doc.publishedAt.toISOString() : null,
      verifiedAt: s.recordedAt ? s.recordedAt.toISOString() : null,
      authorityTier: doc?.authorityTier ?? (s.sourceType === "wikipedia" ? "reference" : "unknown"),
    });
  }

  res.json({
    // Explicit public projection — the previous `...concept` spread leaked
    // internal pipeline fields (confidence scores, status, wiki revision ids).
    id: concept.id,
    slug: concept.slug,
    term: concept.term,
    hoverDefinition: concept.hoverDefinition,
    definition: concept.definition,
    wikiUrl: concept.wikiUrl,
    wikiTitle: concept.wikiTitle,
    wikiExtract: concept.wikiExtract,
    articleCount: concept.articleCount,
    externalUrl: concept.externalUrl,
    externalTitle: concept.externalTitle,
    realLifeExample: concept.realLifeExample,
    whatItIsnt: concept.whatItIsnt,
    commonlyMisusedOnline: concept.commonlyMisusedOnline,
    moduleType: concept.moduleType,
    updatedAt: concept.updatedAt ? concept.updatedAt.toISOString() : null,
    lastProcessedAt: concept.lastProcessedAt ? concept.lastProcessedAt.toISOString() : null,
    shareImage: concept.shareImage,
    cardImageUrl: concept.cardImageUrl,
    aliases,
    articles: articleRows,
    relatedConcepts: filteredRelatedConcepts,
    relationships,
    seenInBrainHook: seenInBrainHook.map((r) => ({
      articleSlug: r.articleSlug,
      articleTitle: r.articleTitle,
      contextSnippet: r.contextSnippet,
      paragraphIndex: r.paragraphIndex,
      matchedTerm: r.matchedTerm,
    })),
    sourceTrail,
  });
});

// POST /public/glossary/:slug/ensure-share-card
// Returns the stored CSS card URL (cardImageUrl) for a concept, if available.
// Satori PNG generation has been retired — CSS cards are captured client-side
// from /admin/media-library/glossary. This endpoint is idempotent and safe
// to call fire-and-forget from share buttons.
router.post("/glossary/:slug/ensure-share-card", async (req, res) => {
  const slug = req.params.slug as string;
  const [concept] = await db
    .select({ id: conceptsTable.id, cardImageUrl: conceptsTable.cardImageUrl })
    .from(conceptsTable)
    .where(
      and(
        eq(conceptsTable.slug, slug),
        eq(conceptsTable.status, "live"),
        eq(conceptsTable.termOfDayBlocked, false),
      ),
    )
    .limit(1);

  if (!concept) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  res.json({ url: concept.cardImageUrl ?? null });
});

// POST /public/concepts/:slug/next
// Returns the next concept for swipe-to-navigate. Prefers related concepts
// (unseen first), then alphabetical walk (unseen first, then wraps).
// Visited slugs (including the current) are posted in the request body.
router.post("/concepts/:slug/next", async (req, res) => {
  if (!recordNextAttempt(clientKey(req))) {
    res.status(429).json({ error: "Too many requests" });
    return;
  }
  const slug = req.params.slug as string;
  const rawVisited = req.body?.visited;
  const VISITED_CAP = 200;
  const visited = new Set<string>(
    Array.isArray(rawVisited)
      ? rawVisited.filter((s: unknown): s is string => typeof s === "string").slice(0, VISITED_CAP)
      : [],
  );
  visited.add(slug);

  const [current] = await db
    .select({ id: conceptsTable.id, term: conceptsTable.term, slug: conceptsTable.slug })
    .from(conceptsTable)
    .where(
      and(
        eq(conceptsTable.slug, slug),
        eq(conceptsTable.status, "live"),
        eq(conceptsTable.termOfDayBlocked, false),
      ),
    )
    .limit(1);

  if (!current) {
    res.json({ next: null });
    return;
  }

  // 1. Related concepts from the relationship table (both directions), unseen first.
  const [r1, r2] = await Promise.all([
    db
      .select({ slug: conceptsTable.slug, term: conceptsTable.term })
      .from(conceptRelationshipsTable)
      .innerJoin(conceptsTable, eq(conceptsTable.id, conceptRelationshipsTable.toConceptId))
      .where(
        and(
          eq(conceptRelationshipsTable.fromConceptId, current.id),
          eq(conceptsTable.status, "live"),
          eq(conceptsTable.termOfDayBlocked, false),
        ),
      ),
    db
      .select({ slug: conceptsTable.slug, term: conceptsTable.term })
      .from(conceptRelationshipsTable)
      .innerJoin(conceptsTable, eq(conceptsTable.id, conceptRelationshipsTable.fromConceptId))
      .where(
        and(
          eq(conceptRelationshipsTable.toConceptId, current.id),
          eq(conceptsTable.status, "live"),
          eq(conceptsTable.termOfDayBlocked, false),
        ),
      ),
  ]);
  const unseenRelated = [...r1, ...r2].filter((c) => !visited.has(c.slug));
  if (unseenRelated.length > 0) {
    const pick = [...unseenRelated].sort((a, b) => a.term.localeCompare(b.term))[0];
    res.json({ next: pick });
    return;
  }

  // 2. Alphabetical walk — prefer unseen & after current term, then broaden.
  const pickOne = async (...conds: (SQL | undefined)[]): Promise<{ slug: string; term: string } | undefined> => {
    const active = conds.filter((c): c is SQL => c !== undefined);
    const [row] = await db
      .select({ slug: conceptsTable.slug, term: conceptsTable.term })
      .from(conceptsTable)
      .where(
        and(
          eq(conceptsTable.status, "live"),
          eq(conceptsTable.termOfDayBlocked, false),
          ne(conceptsTable.id, current.id),
          ...active,
        ),
      )
      .orderBy(asc(conceptsTable.term))
      .limit(1);
    return row;
  };

  const afterCurrent = gt(conceptsTable.term, current.term);
  const notVisited = visited.size > 0 ? notInArray(conceptsTable.slug, [...visited]) : undefined;

  const next =
    (await pickOne(afterCurrent, notVisited)) ??
    (await pickOne(notVisited)) ??
    (await pickOne(afterCurrent)) ??
    (await pickOne());

  res.json({ next: next ?? null });
});

// GET /public/articles/:slug/concepts
// Live concept mentions for a given article (used by the article concept overlay).
router.get("/articles/:slug/concepts", async (req, res) => {
  // Look up the article id from the slug
  const [article] = await db
    .select({
      id: articlesTable.id,
      status: articlesTable.status,
      conceptExplainersDisabled: articlesTable.conceptExplainersDisabled,
    })
    .from(articlesTable)
    .where(and(eq(articlesTable.slug, req.params.slug as string), eq(articlesTable.status, "published")))
    .limit(1);

  if (!article) {
    res.status(404).json({ error: "article_not_found" });
    return;
  }

  // Kill-switches: global feature toggle + per-article disable both suppress
  // annotations immediately (client and SSR read this same endpoint).
  const settings = await getSiteSettings();
  if (!settings.conceptExplainersEnabled || article.conceptExplainersDisabled) {
    res.json({ concepts: [] });
    return;
  }

  const raw = await getArticleConceptMentions(article.id);
  const concepts = raw.map((r) => ({
    conceptId: r.concept.id,
    slug: r.concept.slug,
    term: r.concept.term,
    hoverDefinition: r.concept.hoverDefinition,
    surfaceForm: r.matchedTerm,
    paragraphIndex: r.paragraphIndex,
    wikiUrl: r.concept.wikiUrl,
    // Hidden terms still power the hover tooltip, but the client/SSR must not
    // link to their (404ing, noindexed) glossary page.
    hidden: r.concept.termOfDayBlocked,
  }));
  res.json({ concepts });
});

export default router;

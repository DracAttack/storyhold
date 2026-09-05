import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import {
  db,
  articlesTable,
  authorsTable,
  socialQueueTable,
  socialPostsTable,
  memesTable,
  SOCIAL_QUEUE_ACTIVE_STATUSES,
  type SocialQueueItem,
  type SocialQueueStatus,
  type ArticleBlock,
  type Meme,
} from "@workspace/db";
import { siteUrl, withUtm, ARTICLE_FB_UTM } from "./emailShared";
import { getSiteSettings } from "./siteSettings";
import { generateArticleSocialPost, AiFunctionDisabledError } from "./llm";
import { isZernioConfigured, isZernioPostingAllowed } from "./social";
import { enqueueMemeReposts } from "./memeQueue";
import { getArticleSocialBudget, absolutePublicImageUrl } from "./socialBudget";
import { ensureArticleSocialCard } from "./shareImage";
import { logger } from "../lib/logger";
import { phoenixDaypartFromUtcHour, pickArticleOpener } from "./postOpeners";

// Statuses eligible to be picked up by the slot scheduler / backfill. `ready` is
// the unified "approved, waiting for a slot" status; `queued` is its legacy
// synonym (pre-existing rows). `scheduled` is pinned to a time.
const ELIGIBLE_STATUSES = ["ready", "queued", "scheduled"] as const;

// =============================================================================
// Facebook back-catalogue posting QUEUE.
//
// This is a SEPARATE system from `social.ts` (instant post-on-publish + the
// manual "Post to Facebook" button). The queue drips OLDER published articles to
// Facebook one per scheduled slot, with category rotation and an AI caption
// grounded in the article body. Success here ALSO upserts a `social_posts` row
// so the instant path can never double-post a queued article (and vice-versa).
//
// Everything here is defensive: postQueueItem never throws; the slot runner and
// caption backfill are guarded so a social problem can never affect publishing.
// =============================================================================

const ZERNIO_BASE = "https://zernio.com/api/v1";
const CREATE_TIMEOUT_MS = 20_000;
const POLL_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
// Per slot, walk at most this many candidates so a run of un-postable items can
// never starve the queue, while still bounding work (and caption AI calls) per tick.
const MAX_SLOT_CANDIDATES = 8;
// Zernio account "status" values that count as a live, usable connection. Other
// values (e.g. "disconnected", "expired", "error") must block activation.
const CONNECTED_STATUSES = new Set(["connected", "active", "enabled", "ok", "ready"]);
const POLL_TRIES = 3;
const POLL_DELAY_MS = 1_500;

/** Terminal/explicit statuses the slot runner never auto-posts. */
const SLOT_SKIP_STATUSES = ["posted", "posting", "skipped", "paused", "failed"] as const;
// Phoenix posting slots mapped to UTC (Arizona is UTC−7 year-round, no DST):
// 8am/2pm/8pm → 15, 21, 3. THREE article slots per day (the daily article cap is
// 3). Kept sorted for slot math. Must stay in sync with SOCIAL_QUEUE_SLOTS_UTC in
// cronTick.ts and the dev node-cron gate in index.ts.
const SLOT_HOURS_UTC = [3, 15, 21] as const;

function zernioKey(): string {
  return process.env["ZERNIO_API_KEY"] ?? "";
}
function zernioAccountId(): string {
  return process.env["ZERNIO_FACEBOOK_ACCOUNT_ID"] ?? "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Flatten an article body into plain text for caption grounding. */
function blocksToText(body: ArticleBlock[]): string {
  return body
    .filter((b) => b.type === "paragraph" || b.type === "heading" || b.type === "pullquote")
    .map((b) => b.content)
    .join("\n\n")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The n-th (0-based) upcoming Phoenix posting slot strictly after `from`. Used at
 * enqueue time to give every back-catalogue item a concrete initial scheduled
 * slot (one item per slot) so the admin sees real scheduled times and the drip is
 * deterministic. Admins can still reorder/reschedule afterwards.
 */
function nthUpcomingSlot(from: Date, n: number): Date {
  const hours = [...SLOT_HOURS_UTC].sort((a, b) => a - b);
  let count = 0;
  // Walk forward day by day, slot by slot, until we've passed `n` future slots.
  for (let dayOffset = 0; dayOffset < 3650; dayOffset++) {
    for (const h of hours) {
      const slot = new Date(
        Date.UTC(
          from.getUTCFullYear(),
          from.getUTCMonth(),
          from.getUTCDate() + dayOffset,
          h,
          0,
          0,
          0,
        ),
      );
      if (slot.getTime() <= from.getTime()) continue;
      if (count === n) return slot;
      count++;
    }
  }
  // Unreachable in practice; fall back to a far-future time.
  return new Date(from.getTime() + n * 3 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

export interface EnqueueResult {
  added: number;
  skippedExisting: number;
  total: number;
  // Reposts of already-posted memes queued in the same run (recirculated
  // alongside the article back-catalogue, each with a freshly generated caption).
  memeReposts: number;
  memeRepostsSkipped: number;
}

/** Fisher-Yates in-place shuffle (returns the same array for chaining). */
function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i] as T;
    arr[i] = arr[j] as T;
    arr[j] = tmp;
  }
  return arr;
}

/**
 * Enqueue every published, non-quarantined article that is NOT already in the
 * queue and has NOT already been posted to Facebook (instant path). The drip
 * order is RANDOMIZED on every run (Fisher-Yates) so the back catalogue posts in
 * a fresh, non-chronological sequence each time the admin re-enqueues — the
 * assigned slot times and sortKeys mirror that shuffle. Idempotent — re-running
 * only adds newly-eligible articles (unique(article_id) plus a guard).
 */
export async function enqueueBackCatalog(): Promise<EnqueueResult> {
  // Articles the instant path has ALREADY ATTEMPTED — never re-queue. A row is
  // claimed ("pending") before the provider call, then flipped to "posted" or
  // "failed". A "failed" row can still mean the post went LIVE (Zernio published
  // but our client errored/timed out), so excluding only "posted" rows let those
  // slip back into the drip and double-post. Match the post-time guard: any row
  // at all (any status) means hands-off for auto-posting.
  const posted = await db
    .select({ articleId: socialPostsTable.articleId })
    .from(socialPostsTable)
    .where(eq(socialPostsTable.platform, "facebook"));
  const postedIds = new Set(posted.map((p) => p.articleId));

  const existing = await db.select({ articleId: socialQueueTable.articleId }).from(socialQueueTable);
  const existingIds = new Set(existing.map((e) => e.articleId));

  const articles = await db
    .select({
      id: articlesTable.id,
      slug: articlesTable.slug,
      title: articlesTable.title,
      categorySlug: articlesTable.categorySlug,
      heroImage: articlesTable.heroImage,
      body: articlesTable.body,
      publishedAt: articlesTable.publishedAt,
    })
    .from(articlesTable)
    .where(and(eq(articlesTable.status, "published"), isNull(articlesTable.quarantinedAt)));

  // RANDOMIZE the drip order on every enqueue so the back catalogue posts in a
  // fresh, non-chronological sequence each time the admin re-enqueues.
  const shuffled = shuffleInPlace([...articles]);

  // New items must sort AFTER everything already queued, and their sortKey order
  // must mirror the randomized schedule so the slot runner drains them in that
  // shuffled order (it orders eligible items by sortKey).
  const [{ maxKey } = { maxKey: null }] = await db
    .select({ maxKey: sql<number | null>`max(${socialQueueTable.sortKey})` })
    .from(socialQueueTable);
  const sortBase = Math.max(Number(maxKey ?? 0), Date.now());

  // Continue the slot timeline after anything already scheduled, so re-running
  // enqueue appends new items to the END of the drip rather than colliding with
  // existing scheduled slots.
  // NB: a raw `sql\`max(...)\`` aggregate comes back as a timestamp STRING (the
  // Drizzle Date mapping only applies to real columns, not raw SQL), so coerce
  // before doing any Date math.
  const [{ last } = { last: null }] = await db
    .select({ last: sql<string | null>`max(${socialQueueTable.scheduledAt})` })
    .from(socialQueueTable);
  const lastScheduled = last ? new Date(last) : null;
  const slotAnchor =
    lastScheduled && lastScheduled.getTime() > Date.now() ? lastScheduled : new Date();

  let added = 0;
  let skippedExisting = 0;
  for (const a of shuffled) {
    if (existingIds.has(a.id) || postedIds.has(a.id)) {
      skippedExisting++;
      continue;
    }
    // sortKey increases in shuffled order (and after existing rows) so the slot
    // runner drains this batch in the randomized sequence.
    const sortKey = sortBase + added + 1;
    // One item per upcoming slot, in randomized order.
    const scheduledAt = nthUpcomingSlot(slotAnchor, added);
    const [row] = await db
      .insert(socialQueueTable)
      .values({
        articleId: a.id,
        articleUrl: siteUrl(`/article/${a.slug}`),
        articleTitle: a.title,
        category: a.categorySlug,
        mediaType: "article",
        sourceType: "article_hero",
        platform: "facebook",
        imageUrl: a.heroImage ?? null,
        // True snapshot: capture the body text now so deferred caption generation
        // reads enqueue-time content, never the (possibly later-edited) live article.
        sourceSnapshot: blocksToText(a.body),
        sortKey,
        scheduledAt,
        queueStatus: "scheduled",
      })
      .returning({ id: socialQueueTable.id });
    if (row) added++;
    else skippedExisting++;
  }
  // Recirculate the meme back-catalogue in the SAME enqueue action: queue a
  // fresh repost (new caption at post time) of every already-posted meme. Memes
  // drip via their own cadence/queue, so this never touches social_queue rows.
  const memes = await enqueueMemeReposts();
  logger.info(
    { added, skippedExisting, memeReposts: memes.added, memeRepostsSkipped: memes.skipped },
    "social queue: enqueued back catalogue",
  );
  return {
    added,
    skippedExisting,
    total: added + skippedExisting,
    memeReposts: memes.added,
    memeRepostsSkipped: memes.skipped,
  };
}

// ---------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------

/**
 * Generate the full, ready-to-post social pack (hook, summary, CTA, caption,
 * hashtags) for an article, grounded strictly in its body. Returns null when the
 * article is missing or `social_caption` AI is paused. Snapshot fields are NOT
 * persisted here — the caller decides whether to store them (enqueue) or insert
 * them directly.
 */
interface SocialPack {
  socialHook: string;
  articleSummary: string;
  callToAction: string;
  caption: string;
  hashtags: string[];
}

/** Core LLM call: generate the pack from already-resolved source text. Never
 *  throws — returns null when AI is paused or generation fails. */
async function generatePackFromSource(src: {
  title: string;
  dek: string | null;
  category: string;
  bodyText: string;
  articleId?: string;
}): Promise<SocialPack | null> {
  try {
    const pack = await generateArticleSocialPost({
      title: src.title,
      dek: src.dek,
      category: src.category,
      bodyText: src.bodyText,
    });
    return {
      socialHook: pack.socialHook,
      articleSummary: pack.articleSummary,
      callToAction: pack.callToAction,
      caption: pack.caption,
      hashtags: pack.hashtags,
    };
  } catch (err) {
    if (err instanceof AiFunctionDisabledError) {
      logger.warn({ articleId: src.articleId }, "social queue: social-pack generation disabled (AI paused)");
      return null;
    }
    logger.error({ err, articleId: src.articleId }, "social queue: social-pack generation failed");
    return null;
  }
}

/** Read the live article and return its plain-text body + meta for snapshotting. */
async function readArticleSource(
  articleId: string,
): Promise<{ title: string; dek: string | null; category: string; bodyText: string } | null> {
  const [article] = await db
    .select({ title: articlesTable.title, dek: articlesTable.dek, category: articlesTable.categorySlug, body: articlesTable.body })
    .from(articlesTable)
    .where(eq(articlesTable.id, articleId))
    .limit(1);
  if (!article) return null;
  return {
    title: article.title,
    dek: article.dek,
    category: article.category,
    bodyText: blocksToText(article.body),
  };
}

/** Generate a pack from the LIVE article (legacy/fallback path for rows without
 *  a source snapshot). Returns null when missing or AI is paused. Also reused by
 *  the instant article auto-post path (social.ts) so both posting surfaces share
 *  one caption generator. */
export async function buildArticleSocialPack(articleId: string): Promise<SocialPack | null> {
  const src = await readArticleSource(articleId);
  if (!src) return null;
  return generatePackFromSource({ ...src, articleId });
}

/**
 * Ensure a queue item has its caption + social pack, generating and storing the
 * snapshot copy if missing. Returns the caption, or null when generation is
 * paused/failed (the caller then leaves the item without copy rather than posting
 * a bare link). The article body is read ONLY to generate copy that is then
 * snapshotted — posting itself never re-reads the live article.
 */
export async function ensureSocialPack(queueId: string): Promise<string | null> {
  const [item] = await db.select().from(socialQueueTable).where(eq(socialQueueTable.id, queueId)).limit(1);
  if (!item) return null;
  if (item.caption && item.caption.trim()) return item.caption;

  // Snapshot fidelity: generate from the body text captured AT ENQUEUE TIME
  // when available, so edits to the live article since enqueue can't rewrite the
  // queued copy. Legacy rows (no snapshot) fall back to the live article.
  const pack = item.sourceSnapshot
    ? await generatePackFromSource({
        title: item.articleTitle,
        dek: null,
        category: item.category,
        bodyText: item.sourceSnapshot,
        articleId: item.articleId,
      })
    : await buildArticleSocialPack(item.articleId);
  if (!pack) return null;
  await db
    .update(socialQueueTable)
    .set({
      socialHook: pack.socialHook,
      articleSummary: pack.articleSummary,
      callToAction: pack.callToAction,
      caption: pack.caption,
      hashtags: pack.hashtags,
      updatedAt: new Date(),
    })
    .where(eq(socialQueueTable.id, queueId));
  return pack.caption;
}

/**
 * Bounded backfill of the social pack for queued items that don't yet have a
 * caption. Runs automatically alongside the slot scheduler so back-catalogue
 * items become post-ready without any manual per-item action. Never throws.
 */
/**
 * Clear captions (and associated social-pack fields) for all pending/scheduled
 * queue items so they are regenerated with the current prompt on the next
 * `generateMissingSocialPacks` run. Only touches non-terminal items — posted,
 * skipped, paused, and posting rows are left untouched.
 * Returns the number of rows cleared.
 */
export async function clearPendingCaptionsForRegen(): Promise<number> {
  const res = await db
    .update(socialQueueTable)
    .set({
      caption: null,
      socialHook: null,
      articleSummary: null,
      callToAction: null,
      hashtags: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(socialQueueTable.queueStatus, [...ELIGIBLE_STATUSES]),
        isNotNull(socialQueueTable.caption),
      ),
    );
  return Number(res.rowCount ?? 0);
}

export async function generateMissingSocialPacks(limit = 3): Promise<number> {
  let made = 0;
  try {
    const items = await db
      .select({ id: socialQueueTable.id })
      .from(socialQueueTable)
      .where(
        and(
          inArray(socialQueueTable.queueStatus, [...ELIGIBLE_STATUSES]),
          or(isNull(socialQueueTable.caption), eq(socialQueueTable.caption, "")),
        ),
      )
      .orderBy(asc(socialQueueTable.sortKey))
      .limit(limit);
    for (const it of items) {
      const caption = await ensureSocialPack(it.id);
      if (caption) made++;
    }
  } catch (err) {
    logger.error({ err }, "social queue: social-pack backfill failed");
  }
  return made;
}

// ---------------------------------------------------------------------------
// Single-article enqueue (full snapshot + auto caption)
// ---------------------------------------------------------------------------

export interface EnqueueArticleResult {
  status: "added" | "duplicate" | "not_found" | "not_publishable";
  id?: string;
}

/**
 * Enqueue ONE article as a complete snapshot with the full auto-generated social
 * pack (hook/summary/CTA/caption/hashtags) ready to post — no manual caption
 * step. Blocks a duplicate ACTIVE item for the same (articleId, mediaType,
 * platform); pass `allowDuplicate` to deliberately queue a repost.
 */
export async function enqueueArticle(
  articleId: string,
  opts: { allowDuplicate?: boolean; platform?: string } = {},
): Promise<EnqueueArticleResult> {
  const platform = opts.platform ?? "facebook";
  const [article] = await db
    .select({
      id: articlesTable.id,
      slug: articlesTable.slug,
      title: articlesTable.title,
      dek: articlesTable.dek,
      categorySlug: articlesTable.categorySlug,
      heroImage: articlesTable.heroImage,
      body: articlesTable.body,
      status: articlesTable.status,
      quarantinedAt: articlesTable.quarantinedAt,
    })
    .from(articlesTable)
    .where(eq(articlesTable.id, articleId))
    .limit(1);
  if (!article) return { status: "not_found" };
  if (article.status !== "published" || article.quarantinedAt) {
    return { status: "not_publishable" };
  }

  if (!opts.allowDuplicate) {
    const [dupe] = await db
      .select({ id: socialQueueTable.id })
      .from(socialQueueTable)
      .where(
        and(
          eq(socialQueueTable.articleId, articleId),
          eq(socialQueueTable.mediaType, "article"),
          eq(socialQueueTable.platform, platform),
          inArray(socialQueueTable.queueStatus, [...SOCIAL_QUEUE_ACTIVE_STATUSES]),
        ),
      )
      .limit(1);
    if (dupe) return { status: "duplicate", id: dupe.id };
  }

  // Snapshot the body once, then generate the pack from that exact text — so the
  // stored snapshot and the generated copy describe the same enqueue-time content.
  const sourceSnapshot = blocksToText(article.body);
  const pack = await generatePackFromSource({
    title: article.title,
    dek: article.dek,
    category: article.categorySlug,
    bodyText: sourceSnapshot,
    articleId,
  });
  // A freshly enqueued (new / trending) article jumps to the TOP of the queue so
  // it posts ahead of the back-catalog, which then drains slowly behind it. Two
  // levers, both required (the slot runner orders by sortKey among DUE items):
  //  1. scheduledAt = the next upcoming slot from NOW (due soon), NOT anchored to
  //     the end of the timeline — otherwise it would wait out the whole backlog.
  //  2. sortKey = below every existing item (min - 1), so when its slot arrives it
  //     wins over any backlog item that is also due. Each newer enqueue gets a
  //     still-lower key, so the freshest article sits at the very top.
  const scheduledAt = nthUpcomingSlot(new Date(), 0);
  // sort_key is double precision → node-postgres returns the aggregate as a number.
  const [{ minKey } = { minKey: null }] = await db
    .select({ minKey: sql<number | null>`min(${socialQueueTable.sortKey})` })
    .from(socialQueueTable);
  const sortKey = (minKey ?? Date.now()) - 1;

  let row: { id: string } | undefined;
  try {
    [row] = await db
      .insert(socialQueueTable)
      .values({
        articleId: article.id,
        articleUrl: siteUrl(`/article/${article.slug}`),
        articleTitle: article.title,
        category: article.categorySlug,
        mediaType: "article",
        sourceType: "article_hero",
        platform,
        imageUrl: article.heroImage ?? null,
        sourceSnapshot,
        socialHook: pack?.socialHook ?? null,
        articleSummary: pack?.articleSummary ?? null,
        callToAction: pack?.callToAction ?? null,
        caption: pack?.caption ?? null,
        hashtags: pack?.hashtags ?? null,
        sortKey,
        scheduledAt,
        // No caption yet (AI paused) → leave as draft so it isn't auto-posted bare.
        queueStatus: pack ? "scheduled" : "draft",
      })
      .returning({ id: socialQueueTable.id });
  } catch (err) {
    // The partial unique index (social_queue_active_dedup_uniq) is the DB-level
    // seat belt behind the app-level dedup check above: if a concurrent enqueue
    // slipped past that check and inserted an active row first, this insert hits
    // a 23505 unique violation. Treat it exactly like the dedup hit — surface
    // the existing active row instead of erroring or double-enqueuing.
    const code =
      (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
    if (code === "23505") {
      const [existing] = await db
        .select({ id: socialQueueTable.id })
        .from(socialQueueTable)
        .where(
          and(
            eq(socialQueueTable.articleId, articleId),
            eq(socialQueueTable.mediaType, "article"),
            eq(socialQueueTable.platform, platform),
            inArray(socialQueueTable.queueStatus, [...SOCIAL_QUEUE_ACTIVE_STATUSES]),
          ),
        )
        .limit(1);
      return { status: "duplicate", ...(existing ? { id: existing.id } : {}) };
    }
    throw err;
  }
  return { status: "added", ...(row ? { id: row.id } : {}) };
}

// ---------------------------------------------------------------------------
// Posting a single item
// ---------------------------------------------------------------------------

export type QueuePostStatus = "posted" | "skipped" | "failed" | "disabled" | "needs_caption";

export interface QueuePostResult {
  status: QueuePostStatus;
  reason?: string;
  facebookPostUrl?: string;
  zernioPostId?: string;
  error?: string;
}

interface ZernioCreateResponse {
  post?: { _id?: string; metadata?: { articleId?: string } };
}
interface ZernioGetResponse {
  post?: { _id?: string; postUrl?: string; permalink?: string; results?: Array<{ url?: string; postUrl?: string }> };
}

/** Whether an HTTP failure is worth retrying (network/timeouts handled separately). */
function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Best-effort extraction of a Facebook permalink from a Zernio GET /posts/{id}. */
function extractFacebookUrl(data: ZernioGetResponse | null): string | null {
  const post = data?.post;
  if (!post) return null;
  if (post.postUrl) return post.postUrl;
  if (post.permalink) return post.permalink;
  const fromResults = post.results?.map((r) => r.url ?? r.postUrl).find(Boolean);
  return fromResults ?? null;
}

async function pollForFacebookUrl(zernioPostId: string): Promise<string | null> {
  for (let i = 0; i < POLL_TRIES; i++) {
    if (i > 0) await sleep(POLL_DELAY_MS);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
    try {
      const resp = await fetch(`${ZERNIO_BASE}/posts/${encodeURIComponent(zernioPostId)}`, {
        headers: { Authorization: `Bearer ${zernioKey()}` },
        signal: controller.signal,
      });
      if (resp.ok) {
        const data = (await resp.json().catch(() => null)) as ZernioGetResponse | null;
        const url = extractFacebookUrl(data);
        if (url) return url;
      }
    } catch {
      // best-effort; the post still succeeded even if we can't resolve the URL
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
}

/** Record success in `social_posts` so the instant path never double-posts. */
async function recordSocialPost(articleId: string, externalId: string | null): Promise<void> {
  try {
    await db
      .insert(socialPostsTable)
      .values({ articleId, platform: "facebook", status: "posted", externalId, postedAt: new Date() })
      .onConflictDoUpdate({
        target: [socialPostsTable.articleId, socialPostsTable.platform],
        set: { status: "posted", externalId, error: null, postedAt: new Date(), updatedAt: new Date() },
      });
  } catch (err) {
    logger.error({ err, articleId }, "social queue: failed to mirror into social_posts");
  }
}

/**
 * Post a single queue item to Facebook via Zernio. NEVER throws.
 *
 * - Skips items in a terminal/explicit state unless `force`.
 * - Generates the caption on demand (grounded in the body); if caption AI is
 *   paused, returns `needs_caption` without posting a bare link.
 * - Uses the row's stored `zernioRequestId` as the create idempotency key
 *   (x-request-id) so a retried create cannot double-post. A 409 is treated as
 *   an already-accepted duplicate (success).
 * - Polls GET /posts/{id} for the Facebook permalink (best-effort).
 * - Retries transient failures (429/5xx/network) up to MAX_ATTEMPTS with
 *   backoff, tracking attemptCount; permanent failures mark the item `failed`.
 */
export async function postQueueItem(
  queueId: string,
  opts: { force?: boolean } = {},
): Promise<QueuePostResult> {
  try {
    return await postQueueItemImpl(queueId, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, queueId }, "social queue: unexpected error posting item");
    try {
      await db
        .update(socialQueueTable)
        .set({ queueStatus: "failed", lastError: msg.slice(0, 500), updatedAt: new Date() })
        .where(eq(socialQueueTable.id, queueId));
    } catch {
      // swallow — never throw
    }
    return { status: "failed", error: msg };
  }
}

async function postQueueItemImpl(
  queueId: string,
  opts: { force?: boolean },
): Promise<QueuePostResult> {
  const force = opts.force ?? false;
  if (!isZernioPostingAllowed()) return { status: "disabled" };

  const [item] = await db.select().from(socialQueueTable).where(eq(socialQueueTable.id, queueId)).limit(1);
  if (!item) return { status: "skipped", reason: "not_found" };
  if (item.queueStatus === "posted") return { status: "skipped", reason: "already_posted" };
  if (!force && (item.queueStatus === "skipped" || item.queueStatus === "paused")) {
    return { status: "skipped", reason: item.queueStatus };
  }

  // Article must still be publishable. Join the author so we can sign the post.
  const [article] = await db
    .select({
      status: articlesTable.status,
      quarantinedAt: articlesTable.quarantinedAt,
      authorName: authorsTable.name,
    })
    .from(articlesTable)
    .innerJoin(authorsTable, eq(articlesTable.authorId, authorsTable.id))
    .where(eq(articlesTable.id, item.articleId))
    .limit(1);
  if (!article) return { status: "skipped", reason: "article_not_found" };
  if (article.status !== "published" || article.quarantinedAt) {
    return { status: "skipped", reason: "not_publishable" };
  }

  // Cross-system "already posted" guard: `social_posts` is the shared source of
  // truth. If the article was posted by ANY path (instant publish, manual button,
  // or an earlier queue run) we must never auto-repost it — reconcile this queue
  // row to `posted` and skip. The ONLY exception is when an admin has explicitly
  // reset the item for reposting (`repostApproved`), which is the controlled
  // override that lets a previously-posted article go out again.
  if (!item.repostApproved) {
    // `social_posts` records EVERY instant-path attempt: a row is claimed
    // (status "pending") BEFORE the provider call and flipped to "posted" or
    // "failed" after. Zernio can publish a post and STILL error/time out our
    // client, leaving a "failed" row for a post that is actually LIVE — so a
    // non-"posted" row is NOT proof the post never went out. Treat ANY existing
    // row (any status) as "already attempted" and never auto-repost; this mirrors
    // the instant path's own idempotency contract and is what stops the drip
    // queue from double-posting. A genuine retry is an explicit admin action
    // (the force button / `repostApproved`).
    const [already] = await db
      .select({
        status: socialPostsTable.status,
        externalId: socialPostsTable.externalId,
        postedAt: socialPostsTable.postedAt,
      })
      .from(socialPostsTable)
      .where(
        and(
          eq(socialPostsTable.articleId, item.articleId),
          eq(socialPostsTable.platform, "facebook"),
        ),
      )
      .limit(1);
    if (already) {
      if (already.status === "posted") {
        // Confirmed posted elsewhere: reconcile this queue row to posted.
        await db
          .update(socialQueueTable)
          .set({
            queueStatus: "posted",
            zernioPostId: item.zernioPostId ?? already.externalId ?? null,
            postedAt: item.postedAt ?? already.postedAt ?? new Date(),
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(socialQueueTable.id, queueId));
        return { status: "skipped", reason: "already_posted" };
      }
      // Pending/failed instant attempt: the post may already be live. Stand down
      // (skip) rather than risk a duplicate; an admin can force a real retry.
      await db
        .update(socialQueueTable)
        .set({
          queueStatus: "skipped",
          lastError: "Skipped: article already attempted by the instant path",
          updatedAt: new Date(),
        })
        .where(eq(socialQueueTable.id, queueId));
      return { status: "skipped", reason: "already_attempted" };
    }
  }

  // Snapshot-only posting: post EXACTLY what was captured when the item was
  // enqueued/edited. Prefer a platform-specific override, else the base caption.
  // NEVER regenerate at post time — the snapshot is the source of truth.
  const caption = (item.selectedPlatformCaption?.trim() || item.caption?.trim()) ?? "";
  if (!caption) return { status: "needs_caption" };

  await db
    .update(socialQueueTable)
    .set({ queueStatus: "posting", updatedAt: new Date() })
    .where(eq(socialQueueTable.id, queueId));

  const hashtagLine =
    Array.isArray(item.hashtags) && item.hashtags.length > 0
      ? `\n\n${item.hashtags.join(" ")}`
      : "";
  // Sign every post with the author's name on its own line at the very end.
  const authorName = article.authorName?.trim();
  const authorLine = authorName ? `\n\n- ${authorName}` : "";
  // Attribute the link with the canonical article UTM campaign (FBA). The link
  // no longer rides in the post body — it goes to the FIRST COMMENT so the post
  // stays group-shareable (Facebook throttles reach on link-in-body posts, and
  // groups often strip them). The body is caption + hashtags + author signature.
  const articleUrl = withUtm(item.articleUrl, ARTICLE_FB_UTM);
  // Prepend a time-of-day-aware, BrainHook-branded opener at POST time (the
  // stored caption snapshot is never mutated). Keyed on the actual posting
  // hour so morning/lunch/bedtime slots each get fitting language, and picked
  // deterministically per article so retries produce the same body.
  const opener = pickArticleOpener(
    phoenixDaypartFromUtcHour(new Date().getUTCHours()),
    item.articleId,
  );
  const content = `${opener}\n\n${caption}${hashtagLine}${authorLine}`;
  // Attached photo: the branded 1:1 feed card, composing+persisting it on demand
  // from the stored hero when missing (articles drafted before the feed-card
  // feature have none), falling back to the 1.91:1 share card, then whatever
  // image was snapshotted at enqueue (hero/default card).
  const imageUrl = absolutePublicImageUrl(
    (await ensureArticleSocialCard(item.articleId)) ?? item.imageUrl,
  );
  let lastError = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await db
      .update(socialQueueTable)
      .set({ attemptCount: sql`${socialQueueTable.attemptCount} + 1`, updatedAt: new Date() })
      .where(eq(socialQueueTable.id, queueId));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CREATE_TIMEOUT_MS);
    try {
      const resp = await fetch(`${ZERNIO_BASE}/posts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${zernioKey()}`,
          "Content-Type": "application/json",
          "x-request-id": item.zernioRequestId,
        },
        body: JSON.stringify({
          content,
          ...(imageUrl ? { mediaItems: [{ url: imageUrl, type: "image" }] } : {}),
          // Link in the first comment (group-shareable), not the post body.
          // `platformSpecificData` MUST be nested inside the per-platform entry —
          // a top-level one is silently ignored and the link vanishes.
          platforms: [
            {
              platform: "facebook",
              accountId: zernioAccountId(),
              platformSpecificData: { firstComment: articleUrl },
            },
          ],
          publishNow: true,
          metadata: { articleId: item.articleId, source: "queue" },
        }),
        signal: controller.signal,
      });

      // 409 = idempotency-key duplicate: the post was already accepted by a
      // previous attempt (same x-request-id). Trust it as success — the post
      // IS live on Facebook. Extract the post id when Zernio returns it;
      // when it doesn't, mark posted without an id rather than falsely fail.
      if (resp.status === 409) {
        const data = (await resp.json().catch(() => null)) as ZernioCreateResponse | null;
        const zernioPostId = data?.post?._id ?? item.zernioPostId ?? null;
        if (zernioPostId && zernioPostId.trim()) {
          const fbUrl = await pollForFacebookUrl(zernioPostId);
          await finalizePosted(queueId, item.articleId, zernioPostId, fbUrl, force);
          return { status: "posted", zernioPostId, ...(fbUrl ? { facebookPostUrl: fbUrl } : {}) };
        }
        // No post id in the 409 body, but the post is definitely live — mark
        // posted without an external id rather than falsely recording failure.
        await finalizePosted(queueId, item.articleId, null, null, force);
        return { status: "posted" };
      }

      if (!resp.ok) {
        // Never surface the raw provider body — it can echo submitted fields
        // (including the Facebook account id). Status code only.
        await resp.body?.cancel().catch(() => {});
        lastError = `Zernio responded ${resp.status}`;
        if (isTransientStatus(resp.status) && attempt < MAX_ATTEMPTS) {
          await sleep(attempt * 1000 + Math.floor(Math.random() * 500));
          continue;
        }
        await markItemFailed(queueId, lastError);
        return { status: "failed", error: lastError };
      }

      const data = (await resp.json().catch(() => null)) as ZernioCreateResponse | null;
      const zernioPostId = data?.post?._id ?? null;
      // A 2xx with no post id means the provider didn't actually create a post we
      // can record/verify. Don't mark it posted — treat as retryable (then a
      // permanent failure once attempts are exhausted) so it never leaves the
      // active queue as a false success.
      if (!zernioPostId || !zernioPostId.trim()) {
        lastError = "Zernio accepted the request but returned no post id";
        if (attempt < MAX_ATTEMPTS) {
          await sleep(attempt * 1000 + Math.floor(Math.random() * 500));
          continue;
        }
        await markItemFailed(queueId, lastError);
        return { status: "failed", error: lastError };
      }
      const fbUrl = await pollForFacebookUrl(zernioPostId);
      await finalizePosted(queueId, item.articleId, zernioPostId, fbUrl, force);
      logger.info({ queueId, articleId: item.articleId, zernioPostId }, "social queue: posted item");
      return {
        status: "posted",
        zernioPostId,
        ...(fbUrl ? { facebookPostUrl: fbUrl } : {}),
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(attempt * 1000 + Math.floor(Math.random() * 500));
        continue;
      }
      await markItemFailed(queueId, lastError);
      return { status: "failed", error: lastError };
    } finally {
      clearTimeout(timeout);
    }
  }
  await markItemFailed(queueId, lastError || "exhausted retries");
  return { status: "failed", error: lastError };
}

async function finalizePosted(
  queueId: string,
  articleId: string,
  zernioPostId: string | null,
  facebookPostUrl: string | null = null,
  viaOverride = false,
): Promise<void> {
  await db
    .update(socialQueueTable)
    .set({
      queueStatus: "posted",
      zernioPostId,
      facebookPostUrl,
      postedAt: new Date(),
      // Record manual "Post now" overrides so an article that skipped the normal
      // slot/claim flow is auditable rather than silently posted.
      postedViaOverride: viaOverride,
      lastError: null,
      // Consume any one-shot repost approval so the article can't loop.
      repostApproved: false,
      updatedAt: new Date(),
    })
    .where(eq(socialQueueTable.id, queueId));
  await recordSocialPost(articleId, zernioPostId);
}

async function markItemFailed(queueId: string, error: string): Promise<void> {
  await db
    .update(socialQueueTable)
    .set({ queueStatus: "failed", lastError: error.slice(0, 500), updatedAt: new Date() })
    .where(eq(socialQueueTable.id, queueId));
  logger.error({ queueId, error }, "social queue: item failed");
}

// ---------------------------------------------------------------------------
// Slot scheduler — post the next due item
// ---------------------------------------------------------------------------

export interface SlotRunResult {
  status: "posted" | "idle" | "disabled" | "paused" | "needs_caption" | "failed";
  queueId?: string;
  reason?: string;
}

/**
 * Post the single next-due queue item for the current slot. Eligible items are
 * `queued`/`scheduled` whose scheduledAt is null or in the past, ordered by
 * sortKey (oldest first). Applies category rotation: prefers an item whose
 * category differs from the most recently posted item's category, falling back
 * to the oldest eligible item if every candidate shares that category.
 *
 * Gated by activation + pause + Zernio config. Never throws.
 */
export async function postNextDueSlot(now: Date = new Date()): Promise<SlotRunResult> {
  try {
    if (!isZernioPostingAllowed()) return { status: "disabled" };
    const settings = await getSiteSettings();
    if (!settings.socialQueueActivated) return { status: "disabled", reason: "not_activated" };
    if (settings.socialQueuePaused) return { status: "paused" };

    // Daily article cap + spacing (shared with the instant publish path via
    // `social_posts`). If today's ceiling is reached the queue stands down until
    // the next UTC day; if the last post was within MIN_ARTICLE_GAP_MINUTES it
    // stands down until the gap clears — so the two paths never collectively
    // exceed the cap, nor fire within minutes of each other.
    const budget = await getArticleSocialBudget(now);
    if (!budget.canPostNow) {
      return { status: "idle", reason: budget.atCap ? "daily_cap_reached" : "min_gap" };
    }

    const eligible = await db
      .select()
      .from(socialQueueTable)
      .where(
        and(
          inArray(socialQueueTable.queueStatus, [...ELIGIBLE_STATUSES]),
          or(isNull(socialQueueTable.scheduledAt), lte(socialQueueTable.scheduledAt, now)),
        ),
      )
      .orderBy(asc(socialQueueTable.sortKey), asc(socialQueueTable.createdAt));
    if (eligible.length === 0) return { status: "idle" };

    const [lastPosted] = await db
      .select({ category: socialQueueTable.category })
      .from(socialQueueTable)
      .where(eq(socialQueueTable.queueStatus, "posted"))
      .orderBy(desc(socialQueueTable.postedAt))
      .limit(1);
    const lastCategory = lastPosted?.category ?? null;

    // Rotate away from the last posted category, but fall back to same-category
    // items when that's all that's left.
    const ordered = lastCategory
      ? [
          ...eligible.filter((e) => e.category !== lastCategory),
          ...eligible.filter((e) => e.category === lastCategory),
        ]
      : eligible;

    // Walk candidates until one posts. A single un-postable item must never
    // starve the rest of the queue, but a transient outage must never burn the
    // whole backlog into `failed` either — so we self-heal only permanent
    // conditions and stop on the first real failure.
    let sawNeedsCaption = false;
    for (const candidate of ordered.slice(0, MAX_SLOT_CANDIDATES)) {
      const result = await postQueueItem(candidate.id, { force: false });
      if (result.status === "posted") return { status: "posted", queueId: candidate.id };
      if (result.status === "disabled") return { status: "disabled" };
      if (result.status === "failed") {
        // Likely a transient Zernio/network problem — stop so an outage can't
        // turn the whole backlog into `failed`. Retried next slot or via reset.
        return { status: "failed", queueId: candidate.id, ...(result.error ? { reason: result.error } : {}) };
      }
      if (result.status === "needs_caption") {
        // Caption not ready yet — leave the item queued for a future slot/backfill
        // and move on so it can't block the queue.
        sawNeedsCaption = true;
        continue;
      }
      // skipped: article no longer publishable / not found — drop it from the
      // queue so it never blocks a slot again.
      await db
        .update(socialQueueTable)
        .set({ queueStatus: "skipped", lastError: result.reason ?? null, updatedAt: new Date() })
        .where(eq(socialQueueTable.id, candidate.id));
    }
    return sawNeedsCaption ? { status: "needs_caption" } : { status: "idle" };
  } catch (err) {
    logger.error({ err }, "social queue: slot run failed");
    return { status: "failed", ...(err instanceof Error ? { reason: err.message } : {}) };
  }
}

// ---------------------------------------------------------------------------
// Connection test (no secret values leak)
// ---------------------------------------------------------------------------

export interface ConnectionTestResult {
  configured: boolean;
  found: boolean;
  accountName?: string;
  platform?: string;
  status?: string;
  error?: string;
}

/**
 * Verify the Zernio connection by listing accounts and confirming the configured
 * Facebook account id is present. NEVER returns the api key or account id — only
 * the human-readable account name / platform / status.
 */
export async function testConnection(): Promise<ConnectionTestResult> {
  if (!isZernioConfigured()) return { configured: false, found: false };
  const wantId = zernioAccountId();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
  try {
    const resp = await fetch(`${ZERNIO_BASE}/accounts`, {
      headers: { Authorization: `Bearer ${zernioKey()}` },
      signal: controller.signal,
    });
    if (!resp.ok) {
      // Status code only — never echo the provider body (may contain the account id).
      await resp.body?.cancel().catch(() => {});
      return { configured: true, found: false, error: `Zernio responded ${resp.status}` };
    }
    // Zernio's account object names these fields `platformStatus` (e.g. "active")
    // and `displayName`/`username` — NOT `status`/`name`. We read the real fields
    // (keeping the legacy names as fallbacks) so a healthy account isn't reported
    // as disconnected.
    const data = (await resp.json().catch(() => null)) as {
      accounts?: Array<{
        _id?: string;
        id?: string;
        name?: string;
        displayName?: string;
        username?: string;
        platform?: string;
        status?: string;
        platformStatus?: string;
        isActive?: boolean;
        enabled?: boolean;
      }>;
    } | null;
    const list = data?.accounts ?? [];
    const match = list.find((a) => a._id === wantId || a.id === wantId);
    if (!match) return { configured: true, found: false };
    // `found` (which gates activation) requires the matched account to actually be
    // a CONNECTED FACEBOOK account — a different platform or a disconnected
    // account must not let the queue go live. The status string is still returned
    // so the admin can see why it failed.
    const isFacebook = (match.platform ?? "").toLowerCase() === "facebook";
    const statusStr = (match.platformStatus ?? match.status ?? "").toLowerCase();
    // Prefer the explicit status when present (so "expired"/"disconnected" still
    // blocks); otherwise fall back to the active/enabled booleans.
    const isConnected = statusStr
      ? CONNECTED_STATUSES.has(statusStr)
      : match.isActive === true && match.enabled === true;
    const accountName = match.displayName ?? match.username ?? match.name;
    const statusLabel = match.platformStatus ?? match.status;
    return {
      configured: true,
      found: isFacebook && isConnected,
      ...(accountName ? { accountName } : {}),
      ...(match.platform ? { platform: match.platform } : {}),
      ...(statusLabel ? { status: statusLabel } : {}),
    };
  } catch (err) {
    return { configured: true, found: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Admin operations
// ---------------------------------------------------------------------------

async function getItemOrThrow(queueId: string): Promise<SocialQueueItem> {
  const [item] = await db.select().from(socialQueueTable).where(eq(socialQueueTable.id, queueId)).limit(1);
  if (!item) throw new Error("queue item not found");
  return item;
}

/** Mark an item as skipped (the slot runner will never auto-post it). */
export async function skipItem(queueId: string): Promise<SocialQueueItem> {
  await getItemOrThrow(queueId);
  const [row] = await db
    .update(socialQueueTable)
    .set({ queueStatus: "skipped", updatedAt: new Date() })
    .where(eq(socialQueueTable.id, queueId))
    .returning();
  return row!;
}

/** Per-item pause (distinct from the global queue pause). */
export async function pauseItem(queueId: string): Promise<SocialQueueItem> {
  await getItemOrThrow(queueId);
  const [row] = await db
    .update(socialQueueTable)
    .set({ queueStatus: "paused", updatedAt: new Date() })
    .where(eq(socialQueueTable.id, queueId))
    .returning();
  return row!;
}

/**
 * Reset an item back to `queued` so it becomes eligible again. Covers retry of a
 * failed item, un-skip / un-pause, AND "reset an already-posted article for
 * reposting": it clears the posted markers (status/postedAt/links), the last
 * error and scheduledAt, mints a fresh idempotency key, and sets `repostApproved`
 * so the pre-post guard will deliberately allow this article to post once more.
 */
export async function resetItem(queueId: string): Promise<SocialQueueItem> {
  const current = await getItemOrThrow(queueId);
  // Only grant the one-shot repost override when this row was actually posted —
  // i.e. an explicit "reset for reposting". A retry/unpause/un-skip reset of a
  // never-posted item must NOT bypass the cross-system already-posted guard, or
  // an article posted by the instant path could be double-posted.
  const wasPosted = current.queueStatus === "posted" || current.postedAt != null;
  const [row] = await db
    .update(socialQueueTable)
    .set({
      queueStatus: "queued",
      lastError: null,
      scheduledAt: null,
      postedAt: null,
      facebookPostUrl: null,
      repostApproved: wasPosted,
      zernioRequestId: sql`gen_random_uuid()`,
      updatedAt: new Date(),
    })
    .where(eq(socialQueueTable.id, queueId))
    .returning();
  return row!;
}

/** Pin (or clear) an explicit scheduled time; sets status to `scheduled`. */
export async function rescheduleItem(queueId: string, when: Date | null): Promise<SocialQueueItem> {
  await getItemOrThrow(queueId);
  const [row] = await db
    .update(socialQueueTable)
    .set({
      scheduledAt: when,
      queueStatus: when ? "scheduled" : "queued",
      updatedAt: new Date(),
    })
    .where(eq(socialQueueTable.id, queueId))
    .returning();
  return row!;
}

/** Set the manual ordering key (smaller = sooner). */
export async function reorderItem(queueId: string, sortKey: number): Promise<SocialQueueItem> {
  await getItemOrThrow(queueId);
  const [row] = await db
    .update(socialQueueTable)
    .set({ sortKey, updatedAt: new Date() })
    .where(eq(socialQueueTable.id, queueId))
    .returning();
  return row!;
}

/** Manually set/override the caption. */
export async function editCaption(queueId: string, caption: string): Promise<SocialQueueItem> {
  await getItemOrThrow(queueId);
  const [row] = await db
    .update(socialQueueTable)
    .set({ caption, updatedAt: new Date() })
    .where(eq(socialQueueTable.id, queueId))
    .returning();
  return row!;
}

/**
 * Edit the snapshot social-post fields of a queue item. Only the provided keys
 * are changed; passing `null` clears a field. These are the captured snapshot the
 * item will post verbatim — editing never re-reads the live article.
 */
export interface EditQueueFields {
  socialHook?: string | null;
  articleSummary?: string | null;
  callToAction?: string | null;
  caption?: string | null;
  selectedPlatformCaption?: string | null;
  hashtags?: string[] | null;
  platform?: string;
}

export async function editFields(queueId: string, fields: EditQueueFields): Promise<SocialQueueItem> {
  await getItemOrThrow(queueId);
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if ("socialHook" in fields) patch.socialHook = fields.socialHook ?? null;
  if ("articleSummary" in fields) patch.articleSummary = fields.articleSummary ?? null;
  if ("callToAction" in fields) patch.callToAction = fields.callToAction ?? null;
  if ("caption" in fields) patch.caption = fields.caption ?? null;
  if ("selectedPlatformCaption" in fields)
    patch.selectedPlatformCaption = fields.selectedPlatformCaption ?? null;
  if ("hashtags" in fields) patch.hashtags = fields.hashtags ?? null;
  if (fields.platform) patch.platform = fields.platform;
  const [row] = await db
    .update(socialQueueTable)
    .set(patch)
    .where(eq(socialQueueTable.id, queueId))
    .returning();
  return row!;
}

/**
 * Wipe the queue: delete every item that has NOT been posted. Posted items are
 * preserved as History (the cross-system already-posted ledger). Returns the
 * number of rows removed.
 */
export async function wipeQueue(): Promise<{ deleted: number }> {
  const deleted = await db
    .delete(socialQueueTable)
    .where(ne(socialQueueTable.queueStatus, "posted"))
    .returning({ id: socialQueueTable.id });
  logger.info({ deleted: deleted.length }, "social queue: wiped non-posted items");
  return { deleted: deleted.length };
}

// ---------------------------------------------------------------------------
// Activation / pause (global)
// ---------------------------------------------------------------------------

/**
 * Activate the queue. Guarded: the queue may only be activated once the Zernio
 * connection is verified AND at least one approved test post exists (a queue
 * item already posted OR a manual instant post recorded). This protects against
 * blasting the entire back catalogue on first deploy.
 */
export async function activateQueue(): Promise<{ activated: boolean; reason?: string }> {
  if (!isZernioConfigured()) return { activated: false, reason: "not_configured" };

  // A queue item that ALREADY posted through this queue ("Post now" succeeded) is
  // itself proof of a working connection AND a deliberate test — so it alone is
  // sufficient to activate. This is the key fix: the live GET /accounts probe is
  // flaky and was wrongly blocking activation even though posting demonstrably
  // worked. Only fall back to the probe when no test post exists yet.
  const [postedQueueItem] = await db
    .select({ id: socialQueueTable.id })
    .from(socialQueueTable)
    .where(eq(socialQueueTable.queueStatus, "posted"))
    .limit(1);
  if (postedQueueItem) {
    await updateQueueFlags({ socialQueueActivated: true, socialQueuePaused: false });
    return { activated: true };
  }

  // No test post yet — require a verified connection before allowing activation,
  // so the back catalogue can't blast out on an unverified account.
  const test = await testConnection();
  if (!test.found) return { activated: false, reason: "connection_unverified" };
  return { activated: false, reason: "no_approved_test_post" };
}

export async function pauseQueue(): Promise<void> {
  await updateQueueFlags({ socialQueuePaused: true });
}

export async function resumeQueue(): Promise<void> {
  await updateQueueFlags({ socialQueuePaused: false });
}

async function updateQueueFlags(patch: {
  socialQueueActivated?: boolean;
  socialQueuePaused?: boolean;
}): Promise<void> {
  const { updateSiteSettings } = await import("./siteSettings");
  await updateSiteSettings(patch);
}

// ---------------------------------------------------------------------------
// Listing / status (for the admin dashboard)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Meme projection — read-time unification with the meme system
//
// Memes are a SEPARATE system (the `memes` row IS its own queue item, posted by
// its own cadence in memeQueue.ts). We do NOT copy memes into `social_queue` —
// that would create a second source of truth and a double-post hazard. Instead
// the admin Social Queue VIEW reads meme rows live and PROJECTS them into the
// shared SocialQueueItem shape so a single screen shows every Facebook post
// (articles + memes), its schedule, history, and failures. Posting still flows
// through each system's own path, so nothing is ever posted twice.
// ---------------------------------------------------------------------------

// Meme rows that belong in the unified queue view (its own lifecycle uses these
// three states; "generated"/"draft" memes haven't been approved/queued yet).
const MEME_QUEUE_STATUSES = ["queued", "posting", "posted", "failed"] as const;

// Project a meme's native source type onto the shared queue vocabulary so the
// unified view tells the truth about where each image came from — it used to
// hardcode "ai_generated" for every meme. `sourceType` is a free-form string on
// SocialQueueItem, so this is a display mapping only.
const MEME_SOURCE_TO_QUEUE: Record<string, string> = {
  mainstream_template: "meme_template",
  ai_generated: "ai_generated",
  admin_uploaded: "admin_uploaded",
  article_hero_image: "article_hero",
};

/**
 * Map a meme's native status onto the shared social-queue vocabulary so filters,
 * status badges and counts behave uniformly across articles and memes. A queued
 * meme is "scheduled" when it has a future pinned time, else "ready".
 */
function memeDisplayStatus(meme: Meme, now: Date): SocialQueueStatus {
  if (meme.status === "posted") return "posted";
  if (meme.status === "posting") return "posting";
  if (meme.status === "failed") return "failed";
  if (meme.scheduledAt && meme.scheduledAt.getTime() > now.getTime()) return "scheduled";
  return "ready";
}

/** Project a meme row into the shared SocialQueueItem shape for the unified view. */
function memeToQueueItem(meme: Meme, now: Date): SocialQueueItem {
  return {
    id: meme.id,
    articleId: meme.articleId,
    articleUrl: (meme.canonicalUrl || meme.articleUrl) ?? "",
    articleTitle: meme.articleTitle || "(meme)",
    category: meme.category,
    mediaType: "meme",
    sourceType: MEME_SOURCE_TO_QUEUE[meme.sourceType] ?? meme.sourceType,
    memeId: meme.id,
    platform: "facebook",
    imageUrl: meme.composedImageUrl,
    socialHook: meme.socialHook || null,
    articleSummary: meme.socialSummary || null,
    callToAction: meme.socialCta || null,
    caption: meme.caption || null,
    selectedPlatformCaption: null,
    hashtags: meme.hashtags ?? [],
    sourceSnapshot: null,
    queueStatus: memeDisplayStatus(meme, now),
    attemptCount: meme.postAttemptCount,
    scheduledAt: meme.scheduledAt,
    scheduledTimezone: "America/Phoenix",
    zernioRequestId: meme.zernioRequestId,
    zernioPostId: meme.zernioPostId,
    facebookPostUrl: meme.facebookPostUrl,
    postedAt: meme.postedAt,
    postedViaOverride: meme.postedViaOverride,
    lastError: meme.lastError,
    repostApproved: false,
    sortKey: 0,
    createdAt: meme.createdAt,
    updatedAt: meme.updatedAt,
  };
}

/**
 * Fetch the queued/posted/failed memes projected into SocialQueueItem rows,
 * filtered to match the same `status` semantics the article query uses.
 */
async function listMemeQueueItems(opts: ListQueueOptions, now: Date): Promise<SocialQueueItem[]> {
  const memes = await db
    .select()
    .from(memesTable)
    .where(inArray(memesTable.status, [...MEME_QUEUE_STATUSES]))
    .orderBy(desc(memesTable.updatedAt));
  const projected = memes.map((m) => memeToQueueItem(m, now));
  if (opts.status === "history" || opts.status === "posted") {
    return projected.filter((i) => i.queueStatus === "posted");
  }
  if (opts.status && opts.status !== "all" && opts.status !== "active") {
    return projected.filter((i) => i.queueStatus === opts.status);
  }
  // default / all / active → everything except posted
  return projected.filter((i) => i.queueStatus !== "posted");
}

export interface QueueStatusCounts {
  draft: number;
  ready: number;
  queued: number;
  scheduled: number;
  posting: number;
  posted: number;
  skipped: number;
  paused: number;
  failed: number;
  missingCaption: number;
  total: number;
}

export async function getQueueStatus(): Promise<{
  activated: boolean;
  paused: boolean;
  configured: boolean;
  counts: QueueStatusCounts;
}> {
  const settings = await getSiteSettings();
  const rows = await db
    .select({ queueStatus: socialQueueTable.queueStatus, count: sql<number>`count(*)::int` })
    .from(socialQueueTable)
    .groupBy(socialQueueTable.queueStatus);
  const [{ missing } = { missing: 0 }] = await db
    .select({ missing: sql<number>`count(*)::int` })
    .from(socialQueueTable)
    .where(
      and(
        inArray(socialQueueTable.queueStatus, [...ELIGIBLE_STATUSES]),
        or(isNull(socialQueueTable.caption), eq(socialQueueTable.caption, "")),
      ),
    );

  const counts: QueueStatusCounts = {
    draft: 0,
    ready: 0,
    queued: 0,
    scheduled: 0,
    posting: 0,
    posted: 0,
    skipped: 0,
    paused: 0,
    failed: 0,
    missingCaption: Number(missing),
    total: 0,
  };
  for (const r of rows) {
    const key = r.queueStatus as keyof QueueStatusCounts;
    if (key in counts && key !== "missingCaption" && key !== "total") {
      counts[key] = Number(r.count);
    }
    counts.total += Number(r.count);
  }

  // Fold in projected meme counts so the unified header reflects every Facebook
  // post (articles + memes), not just the article queue.
  const now = new Date();
  const memes = await db
    .select({ status: memesTable.status, scheduledAt: memesTable.scheduledAt })
    .from(memesTable)
    .where(inArray(memesTable.status, [...MEME_QUEUE_STATUSES]));
  for (const m of memes) {
    const display = memeDisplayStatus(m as Meme, now);
    if (display in counts) {
      counts[display as keyof QueueStatusCounts] += 1;
    }
    counts.total += 1;
  }

  return {
    activated: settings.socialQueueActivated,
    paused: settings.socialQueuePaused,
    configured: isZernioConfigured(),
    counts,
  };
}

export interface ListQueueOptions {
  status?: string;
  limit?: number;
  offset?: number;
}

export async function listQueueItems(
  opts: ListQueueOptions = {},
): Promise<{ items: SocialQueueItem[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  // Posted items leave the active list entirely — they live in History only.
  // - a specific status filter (incl. "posted") matches exactly that status
  // - "history" → posted items only
  // - default / "all" / "active" → everything EXCEPT posted
  let where;
  if (opts.status === "history") {
    where = eq(socialQueueTable.queueStatus, "posted");
  } else if (opts.status && opts.status !== "all" && opts.status !== "active") {
    where = eq(socialQueueTable.queueStatus, opts.status);
  } else {
    where = ne(socialQueueTable.queueStatus, "posted");
  }

  const articleItems = await db
    .select()
    .from(socialQueueTable)
    .where(where)
    .orderBy(asc(socialQueueTable.sortKey), asc(socialQueueTable.createdAt))
    .limit(limit)
    .offset(offset);

  const [{ total } = { total: 0 }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(socialQueueTable)
    .where(where);

  // Unified view: project queued/posted/failed memes into the same shape and
  // merge them in. Memes keep their own table + posting cadence (no double-post);
  // this only makes them VISIBLE on the one Social Queue screen.
  //
  // Memes are a small set with no real queue position, so rather than trying to
  // page them we attach the whole batch on the FIRST page only (offset 0). Later
  // pages stay pure article continuation — no duplication, and memes are never
  // dropped by the article limit. The article queue keeps its manual sort order;
  // memes are appended (by post time for History, by scheduled time otherwise).
  const now = new Date();
  const memeItems = offset === 0 ? await listMemeQueueItems(opts, now) : [];

  let items: SocialQueueItem[];
  if (opts.status === "history" || opts.status === "posted") {
    items = [...articleItems, ...memeItems].sort(
      (a, b) => (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0),
    );
  } else {
    // Unified "soonest first" ordering across articles + memes so the things going
    // out next sit at the TOP. Three tiers:
    //   0 posting     — in flight right now.
    //   1 due/imminent — anything eligible to post at the next slot: "ready"/"queued"
    //                    items (no pinned time) AND OVERDUE scheduled items (pinned
    //                    time already in the past). Ordered by effective send time, so
    //                    the most-overdue come first, then ready (≈ now).
    //   2 upcoming     — future-scheduled items, soonest pinned time first.
    //   3 inactive     — paused / skipped / draft / failed: not going out, sink to bottom.
    // A "ready" item posts at the next open slot, so it ranks ABOVE a future-scheduled
    // one — the previous sort treated its null time as +Infinity and wrongly sank
    // freshly approved memes to the bottom. Array.sort is stable, so beyond the tier +
    // time keys the source order is preserved: articles keep their manual sortKey order
    // (DB returns them sortKey-asc) and memes stay newest-approval-first (DB returns
    // them updatedAt-desc), floating a just-approved meme to the top of its tier.
    const nowMs = now.getTime();
    const dueScheduled = (it: SocialQueueItem): boolean =>
      it.queueStatus === "scheduled" && it.scheduledAt != null && it.scheduledAt.getTime() <= nowMs;
    const tierOf = (it: SocialQueueItem): number => {
      if (it.queueStatus === "posting") return 0;
      if (it.queueStatus === "ready" || it.queueStatus === "queued") return 1;
      if (it.queueStatus === "scheduled") return dueScheduled(it) ? 1 : 2;
      return 3;
    };
    // Effective send time: scheduled items use their pinned time (past = overdue =
    // sooner); everything else posts at the next slot ≈ now. Equal keys fall through
    // to the stable source order described above.
    const timeKeyOf = (it: SocialQueueItem): number =>
      it.queueStatus === "scheduled" && it.scheduledAt != null ? it.scheduledAt.getTime() : nowMs;
    items = [...articleItems, ...memeItems].sort((a, b) => {
      const ta = tierOf(a);
      const tb = tierOf(b);
      if (ta !== tb) return ta - tb;
      return timeKeyOf(a) - timeKeyOf(b);
    });
  }

  // total reflects the full unified universe (all matching articles + memes),
  // independent of which page the memes are attached to.
  const memeTotal =
    offset === 0 ? memeItems.length : (await listMemeQueueItems(opts, now)).length;
  return { items, total: Number(total) + memeTotal };
}

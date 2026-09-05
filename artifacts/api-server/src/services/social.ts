import { eq } from "drizzle-orm";
import {
  db,
  articlesTable,
  authorsTable,
  socialPostsTable,
  type HookVariant,
  type HookAssignments,
} from "@workspace/db";
import { siteUrl, withUtm, ARTICLE_FB_UTM } from "./emailShared";
import { getSiteSettings } from "./siteSettings";
import { enqueueArticle, buildArticleSocialPack } from "./socialQueue";
import { ensureArticleSocialCard } from "./shareImage";
import {
  getArticleSocialBudget,
  absolutePublicImageUrl,
  MAX_ARTICLE_POSTS_PER_DAY,
} from "./socialBudget";
import { logger } from "../lib/logger";

const ZERNIO_BASE = "https://zernio.com/api/v1";
// 60 s: Zernio must download our image then call the Facebook Graph API,
// which can take 30–45 s for media-heavy posts. 20 s was too tight.
const POST_TIMEOUT_MS = 60_000;

/**
 * Zernio is configured only when both the API key and the target Facebook
 * account id are present. Reading them lazily (per call) keeps the module
 * import-safe even when the secrets are absent, and lets the operator add the
 * secrets without a code change — only a restart.
 */
export function isZernioConfigured(): boolean {
  return Boolean(process.env["ZERNIO_API_KEY"] && process.env["ZERNIO_FACEBOOK_ACCOUNT_ID"]);
}

/**
 * Posting to the LIVE Facebook page is only allowed outside the dev workspace.
 * The development environment shares the same `ZERNIO_*` secrets AND runs the
 * in-process node-cron scheduler, so without this guard the dev server would
 * auto-post articles (with dev-domain `*.replit.dev` links) to the real Page.
 * We block `NODE_ENV === "development"` specifically (not "everything except
 * production") so the test runner — which mocks `fetch` and runs as
 * `NODE_ENV=test` — can still exercise the real POST path.
 */
export function isZernioPostingAllowed(): boolean {
  return isZernioConfigured() && process.env["NODE_ENV"] !== "development";
}

/**
 * Resolve the headline to post to social: the text of the hook mode assigned to
 * the "social" surface, else the full article title. Mirrors the newsletter-
 * title resolution in emailShared.ts (the api-server can't import the site's
 * seoText.ts, so the small resolution is duplicated).
 */
function resolveSocialTitle(
  title: string,
  variants: HookVariant[] | null | undefined,
  assignments: HookAssignments | null | undefined,
): string {
  if (!variants || variants.length === 0 || !assignments) return title;
  const mode = assignments.social;
  if (!mode) return title;
  const text = variants.find((v) => v.mode === mode)?.text?.replace(/\s+/g, " ").trim();
  return text || title;
}

export type SocialPostStatus = "posted" | "skipped" | "failed" | "disabled";

export interface SocialPostResult {
  status: SocialPostStatus;
  /** Why the attempt was skipped (only set when status === "skipped"). */
  reason?: string;
  /** Provider post id on success. */
  externalId?: string;
  /** Short failure message on failure. */
  error?: string;
}

const ARTICLE_COLS = {
  id: articlesTable.id,
  slug: articlesTable.slug,
  title: articlesTable.title,
  status: articlesTable.status,
  quarantinedAt: articlesTable.quarantinedAt,
  hookVariants: articlesTable.hookVariants,
  hookAssignments: articlesTable.hookAssignments,
  // Image candidates for the attached Facebook photo, best → fallback:
  // the 1:1 feed card, then the 1.91:1 share card, then the raw hero.
  feedImage: articlesTable.feedImage,
  shareImage: articlesTable.shareImage,
  heroImage: articlesTable.heroImage,
  authorName: authorsTable.name,
} as const;

async function markPosted(rowId: string, externalId: string | null): Promise<void> {
  await db
    .update(socialPostsTable)
    .set({ status: "posted", externalId, error: null, postedAt: new Date(), updatedAt: new Date() })
    .where(eq(socialPostsTable.id, rowId));
}

async function markFailed(rowId: string, error: string): Promise<void> {
  await db
    .update(socialPostsTable)
    .set({ status: "failed", error: error.slice(0, 500), updatedAt: new Date() })
    .where(eq(socialPostsTable.id, rowId));
}

/**
 * Post a single published article to the connected Facebook Page via Zernio.
 *
 * Idempotent via the `social_posts` table (unique per article+platform):
 * - Automated path (`force: false`): atomically claims the (article, facebook)
 *   row; if a row already exists (any status) the article was already attempted
 *   and we skip — so republish/unpublish cycles never double-post.
 * - Manual path (`force: true`): upserts the row back to "pending" and always
 *   (re)posts, so an admin can retry a failure or post an older article.
 *
 * Never throws — callers (the publish hook) fire-and-forget; the admin route
 * inspects the returned status. The post body is the resolved headline plus the
 * author signature; a branded card is attached as a PHOTO (feed → share → hero)
 * and the article link goes to the FIRST COMMENT so the post stays
 * group-shareable. (Daily cap + spacing are enforced by the caller for the
 * automated path; `force: true` bypasses them.)
 */
export async function postArticleToFacebook(
  articleId: string,
  opts: { force?: boolean } = {},
): Promise<SocialPostResult> {
  try {
    return await postArticleToFacebookImpl(articleId, opts);
  } catch (err) {
    // Truly never throw: even an unexpected DB error in the claim/select path
    // resolves to a "failed" result so the fire-and-forget auto-post loop and
    // the admin route both stay well-behaved.
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, articleId }, "Facebook post: unexpected error");
    return { status: "failed", error: msg };
  }
}

async function postArticleToFacebookImpl(
  articleId: string,
  opts: { force?: boolean } = {},
): Promise<SocialPostResult> {
  const force = opts.force ?? false;
  if (!isZernioPostingAllowed()) return { status: "disabled" };

  const [article] = await db
    .select(ARTICLE_COLS)
    .from(articlesTable)
    .innerJoin(authorsTable, eq(articlesTable.authorId, authorsTable.id))
    .where(eq(articlesTable.id, articleId))
    .limit(1);
  if (!article) return { status: "skipped", reason: "not_found" };
  if (article.status !== "published" || article.quarantinedAt) {
    return { status: "skipped", reason: "not_publishable" };
  }

  let rowId: string;
  if (force) {
    const [row] = await db
      .insert(socialPostsTable)
      .values({ articleId, platform: "facebook", status: "pending" })
      .onConflictDoUpdate({
        target: [socialPostsTable.articleId, socialPostsTable.platform],
        set: { status: "pending", error: null, updatedAt: new Date() },
      })
      .returning({ id: socialPostsTable.id });
    rowId = row!.id;
  } else {
    const [claimed] = await db
      .insert(socialPostsTable)
      .values({ articleId, platform: "facebook", status: "pending" })
      .onConflictDoNothing()
      .returning({ id: socialPostsTable.id });
    if (!claimed) return { status: "skipped", reason: "already_attempted" };
    rowId = claimed.id;
  }

  const headline = resolveSocialTitle(article.title, article.hookVariants, article.hookAssignments);
  // Attribute the link with the canonical article UTM campaign (FBA).
  const url = withUtm(siteUrl(`/article/${article.slug}`), ARTICLE_FB_UTM);
  // Sign every post with the author's name on its own line at the very end.
  const authorName = article.authorName?.trim();
  const authorLine = authorName ? `\n\n- ${authorName}` : "";
  // The link no longer rides in the post body — it goes to the FIRST COMMENT so
  // the post stays group-shareable (Facebook throttles reach on posts whose body
  // carries an outbound link, and groups often strip them). An image is attached
  // so the post isn't bare.
  //
  // Generate the SAME rich caption (hook + multi-paragraph summary + CTA +
  // hashtags) the drip queue uses, so instant auto-posts read as real editorial
  // copy instead of a bare title + author signature. Never throws — when the AI
  // is paused or generation fails it returns null and we fall back to the
  // headline so the post still goes out.
  const pack = await buildArticleSocialPack(articleId);
  const captionBody = pack?.caption.trim() || headline;
  const hashtagLine =
    pack && pack.hashtags.length > 0 ? `\n\n${pack.hashtags.join(" ")}` : "";
  const content = `${captionBody}${hashtagLine}${authorLine}`;
  const firstComment = url;
  // Attached photo: the branded 1:1 feed card, composing+persisting it on demand
  // from the stored hero when missing (articles drafted before the feed-card
  // feature have none), falling back to the 1.91:1 share card, then the raw hero.
  // og:image is untouched (still the share card). The already-loaded columns are
  // the floor if the helper returns null during a transient DB blip.
  // Pass a 1200-px-wide derivative to Zernio so it downloads a CDN-served
  // JPEG rather than a potentially large raw file. Only applied to our own
  // storage paths (not the branded default card or external URLs).
  const rawCardPath =
    (await ensureArticleSocialCard(articleId)) ??
    article.feedImage ??
    article.shareImage ??
    article.heroImage;
  const sizedCardPath =
    rawCardPath &&
    rawCardPath.includes("/api/storage/public-objects/") &&
    !rawCardPath.includes("_derived/")
      ? `${rawCardPath}?w=1200`
      : rawCardPath;
  const imageUrl = absolutePublicImageUrl(sizedCardPath);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    const resp = await fetch(`${ZERNIO_BASE}/posts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env["ZERNIO_API_KEY"]}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content,
        ...(imageUrl ? { mediaItems: [{ url: imageUrl, type: "image" }] } : {}),
        // Link in the first comment (group-shareable). Zernio publishes this as a
        // comment on the new post — `platformSpecificData` MUST be nested inside
        // the per-platform entry, not at the payload top level (a top-level
        // `platformSpecificData` is silently ignored and the link vanishes).
        platforms: [
          {
            platform: "facebook",
            accountId: process.env["ZERNIO_FACEBOOK_ACCOUNT_ID"],
            platformSpecificData: { firstComment },
          },
        ],
        publishNow: true,
        metadata: { articleId, source: "article" },
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      // NEVER echo the provider response body — it can contain the Facebook
      // account id and other provider internals. Status code only.
      await resp.body?.cancel().catch(() => {});
      const msg = `Zernio responded ${resp.status}`;
      await markFailed(rowId, msg);
      logger.error({ articleId, slug: article.slug, status: resp.status }, "Facebook post failed");
      return { status: "failed", error: msg };
    }
    const data = (await resp.json().catch(() => null)) as { post?: { _id?: string } } | null;
    const externalId = data?.post?._id ?? null;
    await markPosted(rowId, externalId);
    logger.info({ articleId, slug: article.slug, externalId }, "Posted article to Facebook");
    return { status: "posted", ...(externalId ? { externalId } : {}) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markFailed(rowId, msg);
    logger.error({ err, articleId, slug: article.slug }, "Facebook post errored");
    return { status: "failed", error: msg };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Auto-post a batch of just-published articles to Facebook. Gated by the
 * `socialAutoPostEnabled` site setting AND Zernio being configured. Fire-and-
 * forget and fully guarded — a social-posting problem must never affect the
 * publish that already succeeded.
 *
 * Cap-aware: article posts are limited to {@link MAX_ARTICLE_POSTS_PER_DAY} per
 * UTC day (memes are separate). To keep the page from flooding when several
 * articles publish in one run, AT MOST ONE article is posted instantly per run
 * (and only while under the daily cap); every other freshly-published article is
 * pushed to the FRONT of the drip queue, which posts them at its spaced slots —
 * the queue's own cap check ensures the instant + queue paths never collectively
 * exceed the daily ceiling. Each instant post is claimed atomically via
 * `social_posts`, so only the first publish of an article ever posts.
 */
export async function autoPostPublished(articleIds: string[]): Promise<void> {
  if (articleIds.length === 0) return;
  if (!isZernioPostingAllowed()) return;
  try {
    const settings = await getSiteSettings();
    if (!settings.socialAutoPostEnabled) return;
  } catch (e) {
    logger.error({ err: e }, "auto-post: failed to read site settings; skipping");
    return;
  }

  let canPostInstantly = false;
  try {
    const budget = await getArticleSocialBudget();
    // Instant only when under the daily cap AND past the minimum spacing — else
    // drip via the queue so two posts never fire within minutes of each other.
    canPostInstantly = budget.canPostNow;
  } catch (e) {
    // If the budget read fails, fall back to drip-only (never risk over-posting).
    logger.error({ err: e }, "auto-post: failed to read posting budget; dripping all");
  }

  let postedThisRun = false;
  for (const id of articleIds) {
    try {
      if (canPostInstantly && !postedThisRun) {
        const result = await postArticleToFacebook(id, { force: false });
        if (result.status === "posted") {
          postedThisRun = true;
          continue;
        }
        // Any completed instant ATTEMPT (skipped = row already claimed, or
        // failed) must NOT be re-queued. A "failed" result is ambiguous: Zernio
        // can publish the post and STILL error/time out our client, so dripping
        // it would double-post a post that is already live. The claimed
        // `social_posts` row also makes the drip guard skip it. Genuine retries
        // are an explicit admin action (the force button). Only fall through to
        // enqueue when we never made an instant attempt this run.
        continue;
      }
      // We did NOT attempt an instant post (over the per-run instant limit or at
      // the daily cap): drip via the queue (jumps to the front of the backlog).
      await enqueueArticle(id);
    } catch (e) {
      // Neither helper throws, but guard the loop regardless.
      logger.error({ err: e, articleId: id }, "auto-post: unexpected error");
    }
  }
}

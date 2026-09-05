import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { db, memesTable, type Meme, type MemeStatus } from "@workspace/db";
import { siteUrl, withUtm, MEME_FB_UTM } from "./emailShared";
import { getSiteSettings } from "./siteSettings";
import { isZernioConfigured, isZernioPostingAllowed } from "./social";
import { ensureMemeSocialPack } from "./memes";
import { logger } from "../lib/logger";

// =============================================================================
// Manual MEME posting cadence.
//
// Memes an admin builds + approves are their OWN queue: the `memes` row doubles
// as the queue item (status "queued" → "posted"). This is a SEPARATE system
// from the article-link drip in socialQueue.ts — distinct slots and distinct
// cron-claim keys so the two cadences never collide. Unlike article links, a
// meme post carries the composed IMAGE (Zernio `mediaItems`) plus a caption.
//
// Everything here is defensive: postMeme never throws; the slot runner is
// guarded so a social problem can never affect publishing or hero images.
// =============================================================================

const ZERNIO_BASE = "https://zernio.com/api/v1";
const CREATE_TIMEOUT_MS = 20_000;
const POLL_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
// Per slot, walk at most this many candidates so a run of un-postable memes can
// never starve the cadence while still bounding work per tick.
const MAX_SLOT_CANDIDATES = 8;
const POLL_TRIES = 3;
const POLL_DELAY_MS = 1_500;

function zernioKey(): string {
  return process.env["ZERNIO_API_KEY"] ?? "";
}
function zernioAccountId(): string {
  return process.env["ZERNIO_FACEBOOK_ACCOUNT_ID"] ?? "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether an HTTP failure is worth retrying (network/timeouts handled separately). */
function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

interface ZernioCreateResponse {
  post?: { _id?: string; metadata?: { memeId?: string } };
}
interface ZernioGetResponse {
  post?: {
    _id?: string;
    postUrl?: string;
    permalink?: string;
    results?: Array<{ url?: string; postUrl?: string }>;
  };
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
      } else {
        await resp.body?.cancel().catch(() => {});
      }
    } catch {
      // best-effort; the post still succeeded even if we can't resolve the URL
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Caption + media assembly
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute, publicly-fetchable HTTPS URL of the composed meme image
 * for Zernio's `mediaItems`. Object-storage public objects are served by this
 * api-server at `/api/storage/public-objects/...`; siteUrl() makes it absolute
 * on the production domain (or the dev domain), which the shared proxy routes
 * back to this service. Already-absolute URLs are returned unchanged.
 */
function absoluteImageUrl(composedImageUrl: string): string {
  if (/^https?:\/\//i.test(composedImageUrl)) return composedImageUrl;
  return siteUrl(composedImageUrl);
}

/**
 * Build the post caption from the meme's social pack: hook + summary + CTA +
 * canonical article URL + hashtags. Each non-empty part on its own paragraph so
 * the post reads as a few short paragraphs. Hashtags are normalized to a single
 * `#tag` line.
 */
export function buildMemeCaption(meme: Meme): string {
  const parts: string[] = [];
  // Lead with the structured parts on SEPARATE paragraphs — hook, then summary —
  // rather than the model's single-block caption, so the post reads as a few
  // short paragraphs. Fall back to the assembled caption only when both parts are
  // missing (older memes) so we never post an empty lead.
  const hook = meme.socialHook.trim();
  const summary = meme.socialSummary.trim();
  if (hook) parts.push(hook);
  if (summary) parts.push(summary);
  if (!hook && !summary) {
    const lead = meme.caption.trim();
    if (lead) parts.push(lead);
  }
  const cta = meme.socialCta.trim();
  if (cta) parts.push(cta);
  // The link no longer rides in the caption — it goes to the FIRST COMMENT (see
  // buildMemeFirstComment) so the post stays group-shareable.
  const tags = (meme.hashtags ?? [])
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (t.startsWith("#") ? t : `#${t.replace(/^#+/, "")}`));
  if (tags.length) parts.push(tags.join(" "));
  return parts.join("\n\n");
}

/**
 * Build the FIRST COMMENT for a meme post: the canonical article URL attributed
 * with the meme UTM campaign (FBM). Kept out of the caption body so the post
 * stays group-shareable. Returns null when the meme has no URL.
 */
export function buildMemeFirstComment(meme: Meme): string | null {
  const rawUrl = (meme.canonicalUrl || meme.articleUrl).trim();
  if (!rawUrl) return null;
  return withUtm(rawUrl, MEME_FB_UTM);
}

// ---------------------------------------------------------------------------
// Approval → enqueue
// ---------------------------------------------------------------------------

export interface ApproveMemeResult {
  status: "queued" | "rejected" | "already_queued";
  reason?: string;
  meme?: Meme;
}

/**
 * Approve a meme and IMMEDIATELY enqueue it for the meme cadence (there is no
 * separate "send to Zernio" step). The meme row IS the queue item, so this just
 * flips status to "queued", stamps approvedAt, and (optionally) a picked time.
 *
 * - Refuses unless the meme is in "generated" state with a composed image —
 *   never enqueue an unapproved/unbuilt meme.
 * - Idempotent: a meme already queued/posted is left as-is unless `duplicate`
 *   is set (an explicit admin re-queue, which mints a fresh idempotency key so
 *   it posts as a distinct item).
 */
export async function approveMeme(
  memeId: string,
  opts: { scheduledAt?: Date | null; duplicate?: boolean } = {},
): Promise<ApproveMemeResult> {
  const [meme] = await db.select().from(memesTable).where(eq(memesTable.id, memeId)).limit(1);
  if (!meme) return { status: "rejected", reason: "not_found" };

  if (!opts.duplicate && (meme.status === "queued" || meme.status === "posted")) {
    return { status: "already_queued", meme };
  }
  if (!meme.composedImageUrl) {
    return { status: "rejected", reason: "no_composed_image" };
  }
  if (!opts.duplicate && meme.status !== "generated") {
    return { status: "rejected", reason: "not_ready" };
  }

  const set: Record<string, unknown> = {
    status: "queued",
    approvedAt: new Date(),
    scheduledAt: opts.scheduledAt ?? null,
    lastError: null,
    updatedAt: new Date(),
  };
  // An explicit duplicate re-queue (or re-approval after a prior post) needs a
  // fresh idempotency key, else Zernio would 409 it as the same post.
  if (opts.duplicate || meme.status === "posted") {
    set["zernioRequestId"] = sql`gen_random_uuid()`;
    set["zernioPostId"] = null;
    set["facebookPostUrl"] = null;
    set["postedAt"] = null;
  }
  const [updated] = await db
    .update(memesTable)
    .set(set)
    .where(eq(memesTable.id, memeId))
    .returning();
  logger.info({ memeId, scheduledAt: opts.scheduledAt ?? null }, "meme: approved + queued");
  return { status: "queued", meme: updated! };
}

// ---------------------------------------------------------------------------
// Posting a single meme to Facebook via Zernio (image + caption)
// ---------------------------------------------------------------------------

export interface PostMemeResult {
  status: "posted" | "disabled" | "skipped" | "failed";
  reason?: string;
  zernioPostId?: string;
  facebookPostUrl?: string;
}

async function markMemeFailed(memeId: string, error: string): Promise<void> {
  await db
    .update(memesTable)
    .set({ status: "failed", lastError: error.slice(0, 500), updatedAt: new Date() })
    .where(eq(memesTable.id, memeId));
  logger.error({ memeId, error }, "meme: post failed");
}

async function finalizeMemePosted(
  memeId: string,
  zernioPostId: string | null,
  facebookPostUrl: string | null,
  viaOverride: boolean,
): Promise<void> {
  await db
    .update(memesTable)
    .set({
      status: "posted",
      zernioPostId,
      facebookPostUrl,
      postedAt: new Date(),
      // Record manual "Post now" overrides so a meme that skipped the normal
      // approval transition is auditable rather than silently posted.
      postedViaOverride: viaOverride,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(memesTable.id, memeId));
}

/**
 * Post a single meme to the connected Facebook Page via Zernio, attaching the
 * composed meme IMAGE (Zernio `mediaItems`) plus the assembled caption. NEVER
 * throws.
 *
 * - Only posts memes in "queued" state (unless `force`).
 * - Uses the row's stored `zernioRequestId` as the create idempotency key
 *   (x-request-id) so a retried create cannot double-post. A 409 is treated as
 *   an already-accepted duplicate only after confirming metadata.memeId.
 * - Retries transient failures (429/5xx/network) with backoff; permanent
 *   failures mark the meme "failed". Polls GET /posts/{id} for the permalink.
 */
export async function postMeme(memeId: string, opts: { force?: boolean } = {}): Promise<PostMemeResult> {
  try {
    return await postMemeImpl(memeId, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, memeId }, "meme: unexpected post error");
    try {
      await markMemeFailed(memeId, msg);
    } catch {
      /* ignore */
    }
    return { status: "failed", reason: msg };
  }
}

async function postMemeImpl(memeId: string, opts: { force?: boolean }): Promise<PostMemeResult> {
  const force = opts.force ?? false;
  if (!isZernioPostingAllowed()) return { status: "disabled" };

  const [meme] = await db.select().from(memesTable).where(eq(memesTable.id, memeId)).limit(1);
  if (!meme) return { status: "skipped", reason: "not_found" };
  if (meme.status === "posted") return { status: "skipped", reason: "already_posted" };
  if (!meme.composedImageUrl) return { status: "skipped", reason: "no_composed_image" };
  if (!force && meme.status !== "queued") return { status: "skipped", reason: "not_queued" };

  // Atomic claim: flip to "posting" ONLY from an eligible state, in one
  // conditional UPDATE, so two slot runs / a double-click / cron-meets-manual
  // can never both reach Zernio for the same meme. The slot runner only posts a
  // "queued" meme; a forced manual "Post now" may also rescue one stuck in
  // generated/approved/failed. Whoever the UPDATE returns owns the post; any
  // other caller is told it is already claimed (mirrors the article queue).
  const claimable: MemeStatus[] = force
    ? ["queued", "generated", "approved", "failed"]
    : ["queued"];
  const [claim] = await db
    .update(memesTable)
    .set({ status: "posting", updatedAt: new Date() })
    .where(and(eq(memesTable.id, memeId), inArray(memesTable.status, claimable)))
    .returning({ id: memesTable.id });
  if (!claim) return { status: "skipped", reason: "already_claimed" };

  // Fire the AI to (re)create the hook + summary + CTA right before sending if
  // any is missing, so the post never goes out with a bare/empty caption.
  const ready = await ensureMemeSocialPack(meme);
  const caption = buildMemeCaption(ready);
  const firstComment = buildMemeFirstComment(ready);
  const imageUrl = absoluteImageUrl(ready.composedImageUrl ?? meme.composedImageUrl);

  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Track POSTING attempts in their own counter — never touch `attemptCount`,
    // which is the AI artwork cap budget. A run of posting retries must not
    // burn an admin's artwork attempts.
    await db
      .update(memesTable)
      .set({ postAttemptCount: sql`${memesTable.postAttemptCount} + 1`, updatedAt: new Date() })
      .where(eq(memesTable.id, memeId));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CREATE_TIMEOUT_MS);
    try {
      const resp = await fetch(`${ZERNIO_BASE}/posts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${zernioKey()}`,
          "Content-Type": "application/json",
          "x-request-id": meme.zernioRequestId,
        },
        body: JSON.stringify({
          content: caption,
          mediaItems: [{ url: imageUrl, type: "image" }],
          // Link in the first comment (group-shareable), not the caption body.
          // `platformSpecificData` MUST be nested inside the per-platform entry —
          // a top-level one is silently ignored and the link vanishes.
          platforms: [
            {
              platform: "facebook",
              accountId: zernioAccountId(),
              ...(firstComment ? { platformSpecificData: { firstComment } } : {}),
            },
          ],
          publishNow: true,
          metadata: { memeId: meme.id, articleId: meme.articleId, source: "meme" },
        }),
        signal: controller.signal,
      });

      // 409 = idempotency-key duplicate: the post was already accepted by a
      // previous attempt (same x-request-id). The post IS live — claim success
      // when Zernio returns a post id; when it doesn't, mark posted without one
      // rather than falsely recording failure.
      if (resp.status === 409) {
        const data = (await resp.json().catch(() => null)) as ZernioCreateResponse | null;
        const zernioPostId = data?.post?._id ?? meme.zernioPostId ?? null;
        if (zernioPostId && zernioPostId.trim()) {
          const fbUrl = await pollForFacebookUrl(zernioPostId);
          await finalizeMemePosted(memeId, zernioPostId, fbUrl, force);
          return { status: "posted", zernioPostId, ...(fbUrl ? { facebookPostUrl: fbUrl } : {}) };
        }
        // No post id in the 409 body, but the post is definitely live — mark
        // posted without an external id rather than falsely recording failure.
        await finalizeMemePosted(memeId, null, null, force);
        return { status: "posted" };
      }

      if (!resp.ok) {
        // Never surface the raw provider body — it can echo the account id.
        await resp.body?.cancel().catch(() => {});
        lastError = `Zernio responded ${resp.status}`;
        if (isTransientStatus(resp.status) && attempt < MAX_ATTEMPTS) {
          await sleep(attempt * 1000 + Math.floor(Math.random() * 500));
          continue;
        }
        await markMemeFailed(memeId, lastError);
        return { status: "failed", reason: lastError };
      }

      const data = (await resp.json().catch(() => null)) as ZernioCreateResponse | null;
      const zernioPostId = data?.post?._id ?? null;
      // Refuse to declare success without a provider post ID — otherwise we'd
      // claim "posted" with no external identifier proving anything shipped.
      if (!zernioPostId) {
        const err = "Zernio accepted the post but returned no ID";
        await markMemeFailed(memeId, err);
        return { status: "failed", reason: err };
      }
      const fbUrl = await pollForFacebookUrl(zernioPostId);
      await finalizeMemePosted(memeId, zernioPostId, fbUrl, force);
      logger.info({ memeId, zernioPostId }, "meme: posted to Facebook");
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
      await markMemeFailed(memeId, lastError);
      return { status: "failed", reason: lastError };
    } finally {
      clearTimeout(timeout);
    }
  }
  await markMemeFailed(memeId, lastError || "exhausted retries");
  return { status: "failed", reason: lastError };
}

// Thrown when a meme can't be reposted because it has no composed image to
// re-send (nothing was ever generated). Mapped to a 422 at the route boundary.
export class MemeNotPostableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemeNotPostableError";
  }
}

export interface RepostMemeResult {
  memeId: string;
  result: PostMemeResult;
}

/**
 * Repost an existing meme to Facebook by DUPLICATING it and posting the copy.
 *
 * A meme row carries a fixed Zernio idempotency key (`zernioRequestId`) and the
 * poster hard-refuses any meme already in "posted" state, so the same row can
 * never produce a second Facebook post. To recirculate a meme we therefore copy
 * its artwork + caption into a brand-new row (fresh idempotency key, cleared
 * lifecycle/cost fields) and force-post that. The original meme — and its first
 * Facebook post URL — is preserved untouched for history. No AI is re-run: the
 * composed image and social pack are reused as-is, so a repost is free.
 */
export async function repostMeme(memeId: string): Promise<RepostMemeResult> {
  const [src] = await db.select().from(memesTable).where(eq(memesTable.id, memeId)).limit(1);
  if (!src) throw new MemeNotPostableError("Meme not found.");
  if (!src.composedImageUrl) {
    throw new MemeNotPostableError("This meme has no finished image to repost.");
  }
  // Ready to post immediately; force-post claims "approved". The caption is
  // reused as-is (no AI re-run) for a one-click manual repost.
  const copyId = await duplicateMemeRow(src, { status: "approved", approvedAt: new Date() });
  const result = await postMeme(copyId, { force: true });
  return { memeId: copyId, result };
}

/**
 * Duplicate a meme's CONTENT + composition into a brand-new row, letting every
 * lifecycle, cost, and idempotency column fall back to its schema default (fresh
 * zernioRequestId, null posted fields, zero attempt counts, cost 0). The caller
 * supplies the lifecycle state. With `freshCaption`, the social pack is CLEARED
 * so `ensureMemeSocialPack` regenerates a brand-new caption at post time;
 * otherwise the original copy is reused verbatim. The composed image is always
 * reused, so artwork is never re-billed. Returns the new meme id.
 */
async function duplicateMemeRow(
  src: Meme,
  opts: {
    status: MemeStatus;
    approvedAt?: Date | null;
    scheduledAt?: Date | null;
    freshCaption?: boolean;
  },
): Promise<string> {
  const pack = opts.freshCaption
    ? { socialHook: "", socialSummary: "", socialCta: "", caption: "", hashtags: [] as string[] }
    : {
        socialHook: src.socialHook,
        socialSummary: src.socialSummary,
        socialCta: src.socialCta,
        caption: src.caption,
        hashtags: src.hashtags,
      };
  const [copy] = await db
    .insert(memesTable)
    .values({
      articleId: src.articleId,
      articleTitle: src.articleTitle,
      articleUrl: src.articleUrl,
      category: src.category,
      sourceSnapshot: src.sourceSnapshot,
      concepts: src.concepts,
      selectedConceptIndex: src.selectedConceptIndex,
      jokeDescription: src.jokeDescription,
      sourceType: src.sourceType,
      templateId: src.templateId,
      layout: src.layout,
      topText: src.topText,
      bottomText: src.bottomText,
      extraText: src.extraText,
      extraTextPosition: src.extraTextPosition,
      artStyle: src.artStyle,
      visualPrompt: src.visualPrompt,
      textPlacement: src.textPlacement,
      originalImageUrl: src.originalImageUrl,
      composedImageUrl: src.composedImageUrl,
      canonicalUrl: src.canonicalUrl,
      allowPublicFigures: src.allowPublicFigures,
      ...pack,
      status: opts.status,
      approvedAt: opts.approvedAt ?? null,
      scheduledAt: opts.scheduledAt ?? null,
    })
    .returning({ id: memesTable.id });
  if (!copy) throw new Error("failed to duplicate meme row");
  return copy.id;
}

export interface MemeRepostEnqueueResult {
  added: number;
  skipped: number;
}

/**
 * Queue a fresh repost of every meme that has ALREADY been posted to Facebook,
 * so the meme back-catalogue recirculates alongside the article drip. Each repost
 * is a NEW "queued" meme row that reuses the original's composed image (no artwork
 * re-bill) but CLEARS the social pack, so the meme slot runner generates a brand-
 * new caption at post time. The originals — and their first Facebook posts — are
 * left untouched.
 *
 * Idempotent: a meme is skipped when an ACTIVE (queued/posting) repost already
 * waits for it. Reposts are keyed off the shared composed image, so re-running
 * never double-queues a meme whose prior repost is still un-posted, and two
 * posted memes that share an image only ever seed one new copy per run.
 */
export async function enqueueMemeReposts(): Promise<MemeRepostEnqueueResult> {
  // Memes actually posted to Facebook, with a finished image to recirculate.
  const posted = await db
    .select()
    .from(memesTable)
    .where(and(eq(memesTable.status, "posted"), isNotNull(memesTable.composedImageUrl)))
    .orderBy(asc(memesTable.createdAt));

  // Composed images that already have a pending repost queued — never
  // double-queue the same meme while its prior repost is still un-posted.
  const pending = await db
    .select({ url: memesTable.composedImageUrl })
    .from(memesTable)
    .where(inArray(memesTable.status, ["queued", "posting"]));
  const activeImages = new Set(pending.map((p) => p.url).filter((u): u is string => !!u));

  let added = 0;
  let skipped = 0;
  for (const src of posted) {
    const img = src.composedImageUrl;
    if (!img || activeImages.has(img)) {
      skipped++;
      continue;
    }
    await duplicateMemeRow(src, { status: "queued", freshCaption: true });
    activeImages.add(img);
    added++;
  }
  logger.info({ added, skipped }, "meme queue: enqueued reposts of posted memes");
  return { added, skipped };
}

// ---------------------------------------------------------------------------
// Slot scheduler — post the next due meme
// ---------------------------------------------------------------------------

export interface MemeSlotRunResult {
  status: "posted" | "idle" | "disabled" | "paused" | "failed";
  memeId?: string;
  reason?: string;
}

/**
 * Post the single next-due meme for the current slot. Eligible memes are
 * "queued" whose scheduledAt is null (ready) or in the past (due), preferring
 * a meme whose admin-picked time is due, then the oldest ready meme.
 *
 * Gated by meme-cadence activation + pause + Zernio config. Never throws.
 */
export async function postNextDueMeme(now: Date = new Date()): Promise<MemeSlotRunResult> {
  try {
    if (!isZernioPostingAllowed()) return { status: "disabled" };
    const settings = await getSiteSettings();
    if (!settings.memeQueueActivated) return { status: "disabled", reason: "not_activated" };
    if (settings.memeQueuePaused) return { status: "paused" };

    const eligible = await db
      .select()
      .from(memesTable)
      .where(
        and(
          eq(memesTable.status, "queued"),
          or(isNull(memesTable.scheduledAt), lte(memesTable.scheduledAt, now)),
        ),
      )
      // Due-scheduled memes first (earliest admin-picked time wins), THEN the
      // ready (null scheduledAt) memes NEWEST-APPROVAL-FIRST so a freshly approved
      // meme posts ahead of the back-catalog, which drains slowly behind it.
      // Postgres sorts NULLs FIRST under plain ASC, which would wrongly let ready
      // memes jump ahead of due ones — so force scheduledAt NULLS LAST, then order
      // by newest approvedAt (also NULLS LAST so legacy rows without an approval
      // timestamp fall to the bottom), tie-broken by newest createdAt.
      .orderBy(
        sql`${memesTable.scheduledAt} ASC NULLS LAST`,
        sql`${memesTable.approvedAt} DESC NULLS LAST`,
        desc(memesTable.createdAt),
      );
    if (eligible.length === 0) return { status: "idle" };

    for (const candidate of eligible.slice(0, MAX_SLOT_CANDIDATES)) {
      const result = await postMeme(candidate.id, { force: false });
      if (result.status === "posted") return { status: "posted", memeId: candidate.id };
      if (result.status === "disabled") return { status: "disabled" };
      if (result.status === "failed") {
        // Likely transient — stop so an outage can't burn the whole backlog.
        return {
          status: "failed",
          memeId: candidate.id,
          ...(result.reason ? { reason: result.reason } : {}),
        };
      }
      // skipped: no composed image / not queued — leave it and try the next.
    }
    return { status: "idle" };
  } catch (err) {
    logger.error({ err }, "meme: slot run failed");
    return { status: "failed", ...(err instanceof Error ? { reason: err.message } : {}) };
  }
}

// ---------------------------------------------------------------------------
// Queue listing / admin ops
// ---------------------------------------------------------------------------

/** List queued/posted memes (the meme cadence), newest activity first. */
export async function listMemeQueue(limit = 100): Promise<Meme[]> {
  return db
    .select()
    .from(memesTable)
    .where(inArray(memesTable.status, ["queued", "posting", "posted", "failed"]))
    .orderBy(desc(memesTable.updatedAt))
    .limit(limit);
}

/** Reschedule a queued meme (or clear the time to make it "ready"). */
export async function rescheduleMeme(memeId: string, when: Date | null): Promise<Meme | null> {
  const [row] = await db
    .update(memesTable)
    .set({ scheduledAt: when, updatedAt: new Date() })
    .where(and(eq(memesTable.id, memeId), eq(memesTable.status, "queued")))
    .returning();
  return row ?? null;
}

/**
 * Pull a meme back OUT of the posting queue: a queued meme reverts to "generated"
 * (it still has its composed image, so it can be edited or re-approved later),
 * clearing the schedule + approval stamps. Only acts on a "queued" meme — an
 * already-posted meme can't be un-posted. Returns null if the meme wasn't queued.
 */
export async function unqueueMeme(memeId: string): Promise<Meme | null> {
  const [row] = await db
    .update(memesTable)
    .set({
      status: "generated",
      scheduledAt: null,
      approvedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(memesTable.id, memeId), eq(memesTable.status, "queued")))
    .returning();
  return row ?? null;
}

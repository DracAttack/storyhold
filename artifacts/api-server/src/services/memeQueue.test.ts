import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import {
  db,
  memesTable,
  articlesTable,
  authorsTable,
  socialQueueTable,
  aiSettingsTable,
  SOCIAL_QUEUE_ACTIVE_STATUSES,
  type ArticleBlock,
  type Meme,
  type MemeStatus,
} from "@workspace/db";
import { postMeme } from "./memeQueue";
import { buildMemePreview } from "./memes";
import { enqueueArticle, listQueueItems } from "./socialQueue";

// =============================================================================
// Safety regressions for the MEME posting queue. The meme cadence recently had
// four concurrency/billing bugs fixed by mirroring the article-queue patterns.
// These tests lock those invariants so a future edit can't silently bring back
// duplicate posts, double-charges, or false "posted" rows:
//
//  1. A post that returns 2xx (or a confirmed 409) but carries NO provider post
//     id must be marked `failed` for admin review — never `posted`.
//  2. The atomic claim must have exactly one winner: a second concurrent
//     postMeme gets `already_claimed`, and a second buildMemePreview throws
//     "already being generated" without running (re-billing) the paid artwork.
//  3. enqueueArticle must treat a pg 23505 from the partial unique index exactly
//     like the app-level dedup hit — return {status:"duplicate"} with the
//     existing active row id, never error or double-enqueue.
//  4. The partial-index predicate and SOCIAL_QUEUE_ACTIVE_STATUSES must stay in
//     lockstep, or active-dedup silently stops covering some statuses.
//
// Runs against the dev/test Postgres pointed to by DATABASE_URL. All rows are
// throwaway (zz-test- prefixes / tracked ids) so production data is untouched.
// =============================================================================

const SLUG_PREFIX = "zz-test-memeq";
const ZERNIO_BASE = "https://zernio.com/api/v1";

// Track everything we create so cleanup is exact (memes/social_queue have FKs to
// articles, which have an FK to authors — delete children first).
const createdArticleIds: string[] = [];
const createdAuthorIds: string[] = [];

const realFetch = globalThis.fetch;
let savedZernioKey: string | undefined;
let savedZernioAccount: string | undefined;
// Original ai_settings row for social_caption (if any) so we can restore it and
// never clobber a real admin override.
let savedSocialCaption: { existed: boolean; enabled: boolean; directiveOverride: string | null } = {
  existed: false,
  enabled: true,
  directiveOverride: null,
};

async function createArticle(): Promise<string> {
  const [author] = await db
    .insert(authorsTable)
    .values({
      slug: `${SLUG_PREFIX}-author-${randomUUID()}`,
      name: "ZZ Test Author",
      bio: "throwaway",
      avatarUrl: "https://example.com/a.png",
      category: "Science",
      categorySlug: "science",
      voicePrompt: "throwaway",
    })
    .returning({ id: authorsTable.id });
  createdAuthorIds.push(author!.id);

  const body: ArticleBlock[] = [{ type: "paragraph", content: "Throwaway test body." }];
  const [article] = await db
    .insert(articlesTable)
    .values({
      slug: `${SLUG_PREFIX}-article-${randomUUID()}`,
      authorId: author!.id,
      title: "ZZ Test Article",
      dek: "throwaway dek",
      category: "Science",
      categorySlug: "science",
      body,
      heroImage: "https://example.com/hero.png",
      readingTimeMinutes: 3,
      status: "published",
    })
    .returning({ id: articlesTable.id });
  createdArticleIds.push(article!.id);
  return article!.id;
}

async function insertMeme(articleId: string, overrides: Partial<Meme> = {}): Promise<Meme> {
  const [meme] = await db
    .insert(memesTable)
    .values({
      articleId,
      status: "queued",
      composedImageUrl: "https://example.com/meme.png",
      // Pre-fill the social pack so postMeme's ensureMemeSocialPack is a no-op
      // (no AI call) — these tests exercise the posting/claim logic, not copy gen.
      socialHook: "Test hook",
      socialSummary: "Test summary.",
      socialCta: "Read more.",
      canonicalUrl: "https://brainhook.net/article/zz-test",
      ...overrides,
    })
    .returning();
  return meme!;
}

async function getMemeRow(id: string): Promise<Meme | undefined> {
  const [row] = await db.select().from(memesTable).where(eq(memesTable.id, id)).limit(1);
  return row;
}

before(async () => {
  // Zernio must look "configured" so postMeme reaches the claim/POST path
  // instead of short-circuiting to {status:"disabled"}.
  savedZernioKey = process.env["ZERNIO_API_KEY"];
  savedZernioAccount = process.env["ZERNIO_FACEBOOK_ACCOUNT_ID"];
  process.env["ZERNIO_API_KEY"] = "zz-test-key";
  process.env["ZERNIO_FACEBOOK_ACCOUNT_ID"] = "zz-test-account";

  // Disable the social-caption AI function so enqueueArticle's pack generation
  // degrades to null (no real model call) — its 23505 path is what we test.
  const [existing] = await db
    .select()
    .from(aiSettingsTable)
    .where(eq(aiSettingsTable.key, "social_caption"))
    .limit(1);
  if (existing) {
    savedSocialCaption = {
      existed: true,
      enabled: existing.enabled,
      directiveOverride: existing.directiveOverride,
    };
  }
  await db
    .insert(aiSettingsTable)
    .values({ key: "social_caption", enabled: false })
    .onConflictDoUpdate({ target: aiSettingsTable.key, set: { enabled: false } });
});

after(async () => {
  if (createdArticleIds.length) {
    await db.delete(memesTable).where(inArray(memesTable.articleId, createdArticleIds));
    await db.delete(socialQueueTable).where(inArray(socialQueueTable.articleId, createdArticleIds));
    await db.delete(articlesTable).where(inArray(articlesTable.id, createdArticleIds));
  }
  if (createdAuthorIds.length) {
    await db.delete(authorsTable).where(inArray(authorsTable.id, createdAuthorIds));
  }

  // Restore ai_settings exactly as we found it.
  if (savedSocialCaption.existed) {
    await db
      .update(aiSettingsTable)
      .set({
        enabled: savedSocialCaption.enabled,
        directiveOverride: savedSocialCaption.directiveOverride,
      })
      .where(eq(aiSettingsTable.key, "social_caption"));
  } else {
    await db.delete(aiSettingsTable).where(eq(aiSettingsTable.key, "social_caption"));
  }

  if (savedZernioKey === undefined) delete process.env["ZERNIO_API_KEY"];
  else process.env["ZERNIO_API_KEY"] = savedZernioKey;
  if (savedZernioAccount === undefined) delete process.env["ZERNIO_FACEBOOK_ACCOUNT_ID"];
  else process.env["ZERNIO_FACEBOOK_ACCOUNT_ID"] = savedZernioAccount;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// 1. No provider post id => failed (never a false "posted")
// ---------------------------------------------------------------------------

test("a 2xx create with no provider post id is marked failed, never posted", async () => {
  const articleId = await createArticle();
  const meme = await insertMeme(articleId);

  // Zernio "accepts" the post but returns no _id. Without a provider id we have
  // no proof anything shipped, so the meme must fail for admin review.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ post: {} }), { status: 200 })) as typeof fetch;

  const result = await postMeme(meme.id);
  assert.equal(result.status, "failed", "no post id must fail, not post");

  const row = await getMemeRow(meme.id);
  assert.equal(row?.status, "failed");
  assert.equal(row?.zernioPostId, null, "must not record a post id it never got");
  assert.equal(row?.postedAt, null, "must not stamp postedAt on a failure");
});

test("a 409 duplicate with no provider post id is marked posted (never failed → reposted)", async () => {
  const articleId = await createArticle();
  const meme = await insertMeme(articleId);

  // 409 = OUR idempotency key already accepted by a previous attempt, so the
  // post IS live on Facebook even when the duplicate response omits _id.
  // Marking it failed here caused real double-posts (a "failed" row invites a
  // retry that publishes a second copy), so the queue now finalizes posted
  // without an external id instead.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ post: { metadata: { memeId: meme.id } } }), {
      status: 409,
    })) as typeof fetch;

  const result = await postMeme(meme.id);
  assert.equal(result.status, "posted");

  const row = await getMemeRow(meme.id);
  assert.equal(row?.status, "posted");
  assert.equal(row?.zernioPostId, null, "no fabricated post id — none was returned");
  assert.notEqual(row?.postedAt, null, "postedAt stamps the finalization");
});

// ---------------------------------------------------------------------------
// 2. Atomic claim has exactly one winner
// ---------------------------------------------------------------------------

test("a queued meme that gets a provider post id is finalized as posted (the winner's path)", async () => {
  const articleId = await createArticle();
  const meme = await insertMeme(articleId);

  const zernioPostId = "zz-zernio-post-id";
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `${ZERNIO_BASE}/posts` && init?.method === "POST") {
      return new Response(
        JSON.stringify({ post: { _id: zernioPostId, metadata: { memeId: meme.id } } }),
        { status: 200 },
      );
    }
    // GET /posts/{id} permalink poll.
    return new Response(JSON.stringify({ post: { postUrl: "https://facebook.com/post/1" } }), {
      status: 200,
    });
  }) as typeof fetch;

  const result = await postMeme(meme.id);
  assert.equal(result.status, "posted");
  assert.equal(result.zernioPostId, zernioPostId);

  const row = await getMemeRow(meme.id);
  assert.equal(row?.status, "posted");
  assert.equal(row?.zernioPostId, zernioPostId, "the provider id must be persisted on the row");
  assert.ok(row?.postedAt, "postedAt must be stamped on a real post");
});

test("a force-posted meme stamps posted_via_override and surfaces it in the queue projection", async () => {
  const articleId = await createArticle();
  // A non-queued meme that only a forced "Post now" can rescue: forcing the post
  // is exactly the override the audit flag is meant to record.
  const meme = await insertMeme(articleId, { status: "failed" });

  const zernioPostId = "zz-zernio-override-id";
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `${ZERNIO_BASE}/posts` && init?.method === "POST") {
      return new Response(
        JSON.stringify({ post: { _id: zernioPostId, metadata: { memeId: meme.id } } }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ post: { postUrl: "https://facebook.com/post/2" } }), {
      status: 200,
    });
  }) as typeof fetch;

  const result = await postMeme(meme.id, { force: true });
  assert.equal(result.status, "posted");

  const row = await getMemeRow(meme.id);
  assert.equal(row?.postedViaOverride, true, "a forced post must record the override flag");

  // The unified admin queue projection must carry the flag so the UI can show
  // the "forced" indicator.
  const { items } = await listQueueItems({ status: "posted", limit: 200 });
  const projected = items.find((i) => i.memeId === meme.id);
  assert.ok(projected, "the force-posted meme must appear in the posted queue projection");
  assert.equal(projected?.postedViaOverride, true, "projection must surface postedViaOverride");
});

test("a normally-posted meme is not flagged as an override", async () => {
  const articleId = await createArticle();
  const meme = await insertMeme(articleId);

  const zernioPostId = "zz-zernio-normal-id";
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `${ZERNIO_BASE}/posts` && init?.method === "POST") {
      return new Response(
        JSON.stringify({ post: { _id: zernioPostId, metadata: { memeId: meme.id } } }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ post: { postUrl: "https://facebook.com/post/3" } }), {
      status: 200,
    });
  }) as typeof fetch;

  const result = await postMeme(meme.id);
  assert.equal(result.status, "posted");

  const row = await getMemeRow(meme.id);
  assert.equal(row?.postedViaOverride, false, "a normal post must not be flagged as an override");
});

test("postMeme loses the atomic claim when the meme is already in flight (already_claimed)", async () => {
  const articleId = await createArticle();
  // Simulate a winner having already claimed this meme: status is "posting".
  // Even a forced "Post now" must NOT re-claim an in-flight meme — the atomic
  // UPDATE matches no claimable row, so the caller is told already_claimed and
  // never reaches the provider (no double post).
  const meme = await insertMeme(articleId, { status: "posting" });

  globalThis.fetch = (async () => {
    throw new Error("a losing claim must never reach the provider");
  }) as typeof fetch;

  const result = await postMeme(meme.id, { force: true });
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "already_claimed");

  const row = await getMemeRow(meme.id);
  assert.equal(row?.status, "posting", "the loser must leave the in-flight state untouched");
});

test("buildMemePreview on an already-claimed (generating) meme throws without re-billing", async () => {
  const articleId = await createArticle();
  // Simulate the winner having claimed the build: status is "generating". A
  // second build must lose the atomic claim and throw BEFORE any paid artwork.
  const meme = await insertMeme(articleId, {
    status: "generating",
    sourceType: "ai_generated",
    composedImageUrl: null,
    attemptCount: 0,
  });

  // Fail loudly if any network call is attempted — a correct loser never bills.
  globalThis.fetch = (async () => {
    throw new Error("buildMemePreview loser must not make any network/AI call");
  }) as typeof fetch;

  await assert.rejects(buildMemePreview(meme.id), /already being generated/);

  const row = await getMemeRow(meme.id);
  assert.equal(row?.attemptCount, 0, "the loser must not consume a paid artwork attempt");
  assert.equal(row?.status, "generating", "the loser must not flip the winner's state");
});

// ---------------------------------------------------------------------------
// 3. enqueueArticle treats a 23505 unique violation as a duplicate
// ---------------------------------------------------------------------------

test("enqueueArticle returns duplicate (with existing id) when the partial unique index raises 23505", async () => {
  const articleId = await createArticle();

  // Pre-insert an ACTIVE queue row for this (article, article-media, facebook).
  const [existing] = await db
    .insert(socialQueueTable)
    .values({
      articleId,
      articleUrl: "https://brainhook.net/article/zz-test",
      articleTitle: "ZZ Test Article",
      mediaType: "article",
      platform: "facebook",
      queueStatus: "ready",
    })
    .returning({ id: socialQueueTable.id });

  // allowDuplicate skips the app-level dedup SELECT, so the insert reaches the DB
  // and trips the partial unique index (23505) — which must be caught and
  // surfaced as the existing active row, not thrown or double-enqueued.
  const result = await enqueueArticle(articleId, { allowDuplicate: true });
  assert.equal(result.status, "duplicate");
  assert.equal(result.id, existing!.id, "must surface the existing active row id");

  // And exactly one active row still exists — nothing was double-enqueued.
  const rows = await db
    .select({ id: socialQueueTable.id })
    .from(socialQueueTable)
    .where(eq(socialQueueTable.articleId, articleId));
  assert.equal(rows.length, 1, "no duplicate row may be inserted");
});

// ---------------------------------------------------------------------------
// 4. Partial-index predicate <-> SOCIAL_QUEUE_ACTIVE_STATUSES lockstep
// ---------------------------------------------------------------------------

test("the active-dedup partial index predicate matches SOCIAL_QUEUE_ACTIVE_STATUSES", async () => {
  // Pin the constant itself so it can't change without a deliberate edit here
  // (which forces a look at the index/boot DDL too).
  assert.deepEqual(
    [...SOCIAL_QUEUE_ACTIVE_STATUSES].sort(),
    ["draft", "failed", "paused", "posting", "queued", "ready", "scheduled"],
    "SOCIAL_QUEUE_ACTIVE_STATUSES changed — update the partial index predicate in schema + seed too",
  );

  // The live index (created by the running server from the real schema/seed DDL)
  // must carry exactly the same status set in its WHERE predicate.
  const res = await db.execute<{ indexdef: string }>(
    sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'social_queue_active_dedup_uniq'`,
  );
  const rows = (res as unknown as { rows?: Array<{ indexdef: string }> }).rows ??
    (res as unknown as Array<{ indexdef: string }>);
  assert.ok(rows.length > 0, "social_queue_active_dedup_uniq index must exist");
  const indexdef = rows[0]!.indexdef;

  const whereIdx = indexdef.toUpperCase().indexOf("WHERE");
  assert.ok(whereIdx >= 0, "the dedup index must be a partial index with a WHERE predicate");
  const whereClause = indexdef.slice(whereIdx);
  // Postgres renders `in (...)` as `= ANY (ARRAY['x'::text, ...])`; pull the
  // quoted status literals out of the predicate.
  const predicateStatuses = [...whereClause.matchAll(/'([a-z_]+)'(?:::text)?/g)]
    .map((m) => m[1]!)
    .sort();

  assert.deepEqual(
    predicateStatuses,
    [...SOCIAL_QUEUE_ACTIVE_STATUSES].sort(),
    "the partial index predicate drifted from SOCIAL_QUEUE_ACTIVE_STATUSES",
  );
});

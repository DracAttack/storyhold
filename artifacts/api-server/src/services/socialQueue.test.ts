import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  articlesTable,
  authorsTable,
  socialQueueTable,
  socialPostsTable,
  aiSettingsTable,
  type ArticleBlock,
  type SocialQueueItem,
} from "@workspace/db";
import { enqueueArticle, postQueueItem, listQueueItems } from "./socialQueue";

// =============================================================================
// Audit-flag regression for the ARTICLE posting queue. A meme that an admin
// force-posts (the manual "Post now" button, bypassing the normal slot/claim
// flow) records `posted_via_override` so the admin Social Queue can show a
// "forced" badge. Articles ride the SAME unified queue and can be force-posted
// too — these tests lock the parity so a future edit can't drop the article
// audit flag while leaving the meme one in place:
//
//  1. A force-posted article stamps posted_via_override and the unified queue
//     projection surfaces it (so the UI shows the same "forced" badge).
//  2. A normally-posted article (no force) is NOT flagged as an override.
//
// Runs against the dev/test Postgres pointed to by DATABASE_URL. All rows are
// throwaway (zz-test- prefixes / tracked ids) so production data is untouched.
// =============================================================================

const SLUG_PREFIX = "zz-test-socialq";
const ZERNIO_BASE = "https://zernio.com/api/v1";

const createdArticleIds: string[] = [];
const createdAuthorIds: string[] = [];

const realFetch = globalThis.fetch;
let savedZernioKey: string | undefined;
let savedZernioAccount: string | undefined;
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

// Enqueue an article and pre-fill a caption so postQueueItem has a snapshot to
// post (no AI call) — these tests exercise the override-audit logic, not copy.
async function enqueueWithCaption(articleId: string): Promise<string> {
  const result = await enqueueArticle(articleId, { allowDuplicate: true });
  assert.ok(result.status === "added" || result.status === "duplicate", "must enqueue");
  const id = result.id!;
  await db
    .update(socialQueueTable)
    .set({ caption: "Test caption.", queueStatus: "ready" })
    .where(eq(socialQueueTable.id, id));
  return id;
}

async function getQueueRow(id: string): Promise<SocialQueueItem | undefined> {
  const [row] = await db.select().from(socialQueueTable).where(eq(socialQueueTable.id, id)).limit(1);
  return row;
}

before(async () => {
  savedZernioKey = process.env["ZERNIO_API_KEY"];
  savedZernioAccount = process.env["ZERNIO_FACEBOOK_ACCOUNT_ID"];
  process.env["ZERNIO_API_KEY"] = "zz-test-key";
  process.env["ZERNIO_FACEBOOK_ACCOUNT_ID"] = "zz-test-account";

  // Disable social-caption AI so enqueueArticle degrades to null (no model call).
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
    await db.delete(socialQueueTable).where(inArray(socialQueueTable.articleId, createdArticleIds));
    await db.delete(socialPostsTable).where(inArray(socialPostsTable.articleId, createdArticleIds));
    await db.delete(articlesTable).where(inArray(articlesTable.id, createdArticleIds));
  }
  if (createdAuthorIds.length) {
    await db.delete(authorsTable).where(inArray(authorsTable.id, createdAuthorIds));
  }

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

function mockZernio(articleId: string, zernioPostId: string): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `${ZERNIO_BASE}/posts` && init?.method === "POST") {
      return new Response(
        JSON.stringify({ post: { _id: zernioPostId, metadata: { articleId } } }),
        { status: 200 },
      );
    }
    // GET /posts/{id} permalink poll.
    return new Response(JSON.stringify({ post: { postUrl: "https://facebook.com/post/1" } }), {
      status: 200,
    });
  }) as typeof fetch;
}

test("a force-posted article stamps posted_via_override and surfaces it in the queue projection", async () => {
  const articleId = await createArticle();
  const queueId = await enqueueWithCaption(articleId);
  // A paused item that only a forced "Post now" can post: forcing it is exactly
  // the override the audit flag is meant to record.
  await db
    .update(socialQueueTable)
    .set({ queueStatus: "paused" })
    .where(eq(socialQueueTable.id, queueId));

  const zernioPostId = "zz-zernio-article-override-id";
  mockZernio(articleId, zernioPostId);

  const result = await postQueueItem(queueId, { force: true });
  assert.equal(result.status, "posted");

  const row = await getQueueRow(queueId);
  assert.equal(row?.postedViaOverride, true, "a forced post must record the override flag");

  // The unified admin queue projection must carry the flag so the UI can show
  // the "forced" indicator for articles too.
  const { items } = await listQueueItems({ status: "posted", limit: 200 });
  const projected = items.find((i) => i.id === queueId);
  assert.ok(projected, "the force-posted article must appear in the posted queue projection");
  assert.equal(projected?.postedViaOverride, true, "projection must surface postedViaOverride");
});

test("the drip queue never reposts an article the instant path already attempted (even a 'failed' row)", async () => {
  const articleId = await createArticle();
  const queueId = await enqueueWithCaption(articleId);
  // Simulate the instant path having ALREADY attempted this article and ended in
  // a "failed" social_posts row. A "failed" row is ambiguous: Zernio can publish
  // the post and STILL error/time out our client, so the post may be LIVE. The
  // drip queue must NOT post it again — that was the double-post bug.
  await db
    .insert(socialPostsTable)
    .values({ articleId, platform: "facebook", status: "failed", error: "client timeout" })
    .onConflictDoUpdate({
      target: [socialPostsTable.articleId, socialPostsTable.platform],
      set: { status: "failed" },
    });

  // Fail loudly if Zernio is ever called — a provider call here is a double post.
  let calledZernio = false;
  globalThis.fetch = (async () => {
    calledZernio = true;
    throw new Error("the drip queue must not call Zernio for an already-attempted article");
  }) as typeof fetch;

  const result = await postQueueItem(queueId);
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "already_attempted");
  assert.equal(calledZernio, false, "no provider call for an already-attempted article");

  const row = await getQueueRow(queueId);
  assert.equal(row?.queueStatus, "skipped", "the queue row must stand down to skipped");
});

test("a normally-posted article is not flagged as an override", async () => {
  const articleId = await createArticle();
  const queueId = await enqueueWithCaption(articleId);

  const zernioPostId = "zz-zernio-article-normal-id";
  mockZernio(articleId, zernioPostId);

  const result = await postQueueItem(queueId);
  assert.equal(result.status, "posted");

  const row = await getQueueRow(queueId);
  assert.equal(row?.postedViaOverride, false, "a normal post must not be flagged as an override");
});

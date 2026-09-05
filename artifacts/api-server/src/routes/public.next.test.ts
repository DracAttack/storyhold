import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { and, eq, isNull, like } from "drizzle-orm";
import { db, articlesTable, authorsTable, type ArticleBlock } from "@workspace/db";
import publicRouter from "./public";

// Only the slug of the returned article summary matters to these assertions.
type NextResponse = { next: { slug: string } | null };

// =============================================================================
// Regression lock for the swipe-to-next gesture (POST /public/articles/:slug/next):
// "never re-suggest a just-read article."
//
// The correctness of "swiping never loops back to what you just read" depends on
// TWO things working together:
//   1. the client posting the session's visited slugs in the request body, and
//   2. the endpoint excluding those slugs (plus the current article) from both
//      the relevance-first pick AND the exhaustive catalog-walk fallback,
//      while still ALWAYS advancing to something (never dead-ending).
// This file exercises the real route handler over HTTP against the dev/test
// Postgres pointed to by DATABASE_URL, mirroring the browsing walk the client
// drives (open A → swipe to B → swipe on → return to A) and asserting the target
// is never an already-seen article while unseen alternatives remain.
//
// Test rows use a recognizable zz-test slug prefix and are wiped in after().
// Heroes are plain https URLs (not object-storage prefixed) so resolveSummaryHero
// short-circuits without a storage lookup. The endpoint ranks against the WHOLE
// published catalog, so a returned "next" may be a real article — that is fine:
// the assertions only check the visited-exclusion / never-dead-end invariants,
// which hold regardless of which article is picked.
// =============================================================================

const SLUG_PREFIX = "zz-test-swipe-next";
const TEST_ARTICLE_COUNT = 4;

let server: Server;
let baseUrl: string;
let authorId: string;
const testSlugs: string[] = [];

async function cleanup(): Promise<void> {
  await db.delete(articlesTable).where(like(articlesTable.slug, `${SLUG_PREFIX}%`));
  await db.delete(authorsTable).where(like(authorsTable.slug, `${SLUG_PREFIX}%`));
}

async function next(slug: string, visited: string[]): Promise<NextResponse> {
  const res = await fetch(`${baseUrl}/public/articles/${slug}/next`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ visited }),
  });
  assert.equal(res.status, 200, `swipe-next must respond 200 for ${slug}`);
  return (await res.json()) as NextResponse;
}

before(async () => {
  await cleanup();

  const [author] = await db
    .insert(authorsTable)
    .values({
      slug: `${SLUG_PREFIX}-author-${randomUUID()}`,
      name: "ZZ Swipe Next Author",
      bio: "throwaway test author for the swipe-to-next regression",
      avatarUrl: "https://example.com/a.png",
      category: "Science",
      categorySlug: "science",
      voicePrompt: "throwaway",
      active: false, // keep the automated pipeline away from this author
    })
    .returning({ id: authorsTable.id });
  authorId = author!.id;

  // A handful of published test articles so the walk has a deterministic origin
  // that definitely exists. Distinct bodies keep the corpus tokenizer honest;
  // same category clusters them so at least some rank as related neighbors.
  for (let i = 0; i < TEST_ARTICLE_COUNT; i++) {
    const slug = `${SLUG_PREFIX}-${i}-${randomUUID()}`;
    const body: ArticleBlock[] = [
      {
        type: "paragraph",
        content: `Throwaway swipe-next test article number ${i} about quantum widgets and gravitational sprockets.`,
      },
    ];
    await db.insert(articlesTable).values({
      slug,
      authorId,
      title: `ZZ Swipe Next Article ${i}`,
      dek: `throwaway dek ${i}`,
      category: "Science",
      categorySlug: "science",
      body,
      heroImage: `https://example.com/hero-${i}.png`,
      readingTimeMinutes: 3,
      status: "published",
    });
    testSlugs.push(slug);
  }

  // Mount the REAL public router exactly as production does (routes/index.ts
  // mounts it at /public). Auth/CSRF live at other mount points, not on public.
  const app = express();
  app.use(express.json());
  app.use("/public", publicRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("No test server port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  server?.close();
  await cleanup();
});

test("swipe-next: never returns the current article, even with an empty visited set", async () => {
  const origin = testSlugs[0]!;
  const res = await next(origin, []);
  assert.ok(res.next, "a swipe from a real article must always advance to something");
  assert.notEqual(
    res.next.slug,
    origin,
    "the current article must never be suggested as its own next (it is always treated as visited)",
  );
});

test("swipe-next: growing visited set is never re-suggested (open A → swipe on → back to A)", async () => {
  const origin = testSlugs[0]!;
  // Simulates the client's session bookkeeping: the origin is recorded as seen
  // the moment it is opened, then every swipe target is appended before the next
  // request — exactly what article.tsx posts via getVisitedArticles().
  const visited = new Set<string>([origin]);
  let current = origin;

  // Walk several swipes. Each target must be unseen — a re-suggested article
  // here is precisely the ping-pong / loop-back regression this test guards.
  for (let step = 0; step < 8; step++) {
    const res = await next(current, [...visited]);
    assert.ok(res.next, `swipe #${step + 1} must advance to an article, not dead-end`);
    const slug = res.next.slug;
    assert.ok(
      !visited.has(slug),
      `swipe #${step + 1} returned already-seen "${slug}" while unseen articles remained (visited=${visited.size})`,
    );
    visited.add(slug);
    current = slug;
  }

  // The specific regression the staleTime-0 refetch protects: navigating BACK to
  // the origin re-runs the lookup with the CURRENT visited set, so it must not
  // re-suggest anything read since (which a stale cached pick would have done).
  const back = await next(origin, [...visited]);
  assert.ok(back.next, "returning to the origin must still advance");
  assert.ok(
    !visited.has(back.next.slug),
    `returning to origin re-suggested already-seen "${back.next.slug}"`,
  );
});

test("swipe-next: always advances (never dead-ends) even when a large visited set is posted", async () => {
  const origin = testSlugs[0]!;
  // Every published slug currently in the catalog, posted as visited. The server
  // caps the visited list (VISITED_CAP) and always adds the current slug, so on a
  // catalog larger than the cap it advances to an unseen article; on a smaller
  // catalog the exhaustive fallback walks the total order ignoring visited. Either
  // way a swipe must return SOMETHING — it must never dead-end.
  const rows = await db
    .select({ slug: articlesTable.slug })
    .from(articlesTable)
    .where(and(eq(articlesTable.status, "published"), isNull(articlesTable.quarantinedAt)));
  const allSlugs = rows.map((r) => r.slug);
  assert.ok(allSlugs.length >= TEST_ARTICLE_COUNT, "sanity: test articles are published");

  const res = await next(origin, allSlugs);
  assert.ok(
    res.next && typeof res.next.slug === "string" && res.next.slug.length > 0,
    "a swipe must always advance to a valid article, even after everything (up to the cap) is seen",
  );
});

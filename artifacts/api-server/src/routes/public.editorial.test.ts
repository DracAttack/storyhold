import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { like } from "drizzle-orm";
import { db, articlesTable, authorsTable, articleSourcesTable, type ArticleBlock } from "@workspace/db";
import publicRouter from "./public";

// =============================================================================
// Regression lock for the EditorialTrustBox "Background reference" badge.
//
// The EditorialTrustBox renders an amber badge labelled "Background reference"
// whenever a reference in the References list has tier === "reference" (Wikipedia,
// encyclopedias, etc.). The badge is intentionally absent for primary, firsthand,
// wire, reported, commentary, and all other tiers.
//
// The correctness of this badge depends on TWO things:
//   1. The API including the `tier` field in every PublicArticleReference item
//      in the GET /public/articles/:slug response.
//   2. The client rendering the badge only for tier === "reference".
//
// This test locks in point 1 — the API contract side — by exercising the real
// route handler against the dev Postgres DB and asserting that:
//   • the `references` array is present in the response.
//   • every entry carries a `tier` field.
//   • a reference-tier source (Wikipedia) surfaces with tier === "reference".
//   • a reported-tier source (BBC) surfaces with tier === "reported" (never "reference").
//
// If `tier` is ever dropped from the serialization path (e.g. the field is
// removed from buildArticleReferences or the OpenAPI schema is pruned), this
// test will fail before any reader sees a broken trust box.
// =============================================================================

const SLUG_PREFIX = "zz-test-editorial-badge";

let server: Server;
let baseUrl: string;
let articleSlug: string;

const WIKI_URL = "https://en.wikipedia.org/wiki/ZZ_Test_Background_Ref_Badge_Smoke";
const BBC_URL = "https://www.bbc.com/news/zz-test-no-badge-smoke";

async function cleanup(): Promise<void> {
  await db.delete(articleSourcesTable).where(
    like(articleSourcesTable.url, `%ZZ_Test_Background_Ref_Badge_Smoke%`),
  );
  await db.delete(articleSourcesTable).where(
    like(articleSourcesTable.url, `%zz-test-no-badge-smoke%`),
  );
  await db.delete(articlesTable).where(like(articlesTable.slug, `${SLUG_PREFIX}%`));
  await db.delete(authorsTable).where(like(authorsTable.slug, `${SLUG_PREFIX}%`));
}

before(async () => {
  await cleanup();

  const [author] = await db
    .insert(authorsTable)
    .values({
      slug: `${SLUG_PREFIX}-author-${randomUUID()}`,
      name: "ZZ Editorial Badge Author",
      bio: "Throwaway test author for editorial badge regression.",
      avatarUrl: "https://example.com/avatar.png",
      category: "Science",
      categorySlug: "science",
      voicePrompt: "throwaway",
      active: false,
    })
    .returning({ id: authorsTable.id });
  const authorId = author!.id;

  const body: ArticleBlock[] = [
    {
      type: "paragraph",
      content: "Throwaway article body for the Background reference badge smoke test.",
    },
  ];
  articleSlug = `${SLUG_PREFIX}-${randomUUID()}`;

  const [article] = await db
    .insert(articlesTable)
    .values({
      slug: articleSlug,
      authorId,
      title: "ZZ Editorial Badge Smoke Test Article",
      dek: "Throwaway dek.",
      category: "Science",
      categorySlug: "science",
      body,
      heroImage: "https://example.com/hero.png",
      readingTimeMinutes: 2,
      status: "published",
    })
    .returning({ id: articlesTable.id });
  const articleId = article!.id;

  // Reference-tier source (Wikipedia). The badge renders for this tier.
  await db.insert(articleSourcesTable).values({
    articleId,
    url: WIKI_URL,
    domain: "en.wikipedia.org",
    role: "evidence",
    tier: "reference",
    status: "ingested",
    sourceTitle: "ZZ Test Wikipedia Background Ref (Smoke)",
  });

  // Reported-tier source (BBC). The badge must NOT render for this tier.
  await db.insert(articleSourcesTable).values({
    articleId,
    url: BBC_URL,
    domain: "bbc.com",
    role: "evidence",
    tier: "reported",
    status: "ingested",
    sourceTitle: "ZZ Test BBC No-Badge (Smoke)",
  });

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

test("GET /public/articles/:slug includes the `tier` field on every reference entry", async () => {
  const res = await fetch(`${baseUrl}/public/articles/${articleSlug}`);
  assert.equal(res.status, 200, "article endpoint must respond 200 for published article");

  const body = (await res.json()) as {
    references: Array<{ url: string; tier: string; name: string }>;
  };

  assert.ok(Array.isArray(body.references), "response must include a `references` array");
  assert.ok(
    body.references.length >= 2,
    `expected at least 2 references, got ${body.references.length}`,
  );

  for (const ref of body.references) {
    assert.ok(
      typeof ref.tier === "string" && ref.tier.length > 0,
      `every reference must carry a non-empty string tier field; got ${JSON.stringify(ref.tier)} on "${ref.url}"`,
    );
  }
});

test("reference-tier source (Wikipedia) appears with tier === 'reference' — badge renders", async () => {
  const res = await fetch(`${baseUrl}/public/articles/${articleSlug}`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as {
    references: Array<{ url: string; tier: string }>;
  };

  const wikiRef = body.references.find((r) => r.url === WIKI_URL);
  assert.ok(
    wikiRef !== undefined,
    "the reference-tier Wikipedia source must appear in the references list",
  );
  assert.equal(
    wikiRef.tier,
    "reference",
    `Wikipedia source must have tier="reference" so the amber badge renders; got "${wikiRef.tier}"`,
  );
});

test("reported-tier source (BBC) appears with tier !== 'reference' — badge is absent", async () => {
  const res = await fetch(`${baseUrl}/public/articles/${articleSlug}`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as {
    references: Array<{ url: string; tier: string }>;
  };

  const bbcRef = body.references.find((r) => r.url === BBC_URL);
  assert.ok(
    bbcRef !== undefined,
    "the reported-tier BBC source must appear in the references list",
  );
  assert.notEqual(
    bbcRef.tier,
    "reference",
    `BBC source must NOT have tier="reference" (badge would incorrectly render); got "${bbcRef.tier}"`,
  );
  assert.equal(
    bbcRef.tier,
    "reported",
    `BBC source must have tier="reported"; got "${bbcRef.tier}"`,
  );
});

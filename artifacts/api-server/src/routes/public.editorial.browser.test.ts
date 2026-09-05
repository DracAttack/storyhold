import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { like } from "drizzle-orm";
import { db, articlesTable, authorsTable, articleSourcesTable, type ArticleBlock } from "@workspace/db";

// =============================================================================
// Playwright smoke test: EditorialTrustBox "Background reference" badge
//
// This test exercises the full rendering path — API → React component → DOM —
// to confirm:
//   1. The amber "Background reference" badge is visible for reference-tier
//      sources (Wikipedia / encyclopedias), where ref.tier === "reference".
//   2. The badge is absent for reported-tier sources in the same article.
//
// The test seeds two article_sources rows on a throwaway published article,
// opens the page in a real Chromium browser, scrolls to the References section
// inside the EditorialTrustBox, and asserts badge presence/absence in the DOM.
//
// Requires the dev proxy (localhost:80) to be running. The test is skipped
// gracefully when the server is unreachable so it never blocks the offline
// unit-test suite.
//
// Regression this guards:
//   • tier field dropped from buildArticleReferences → badge never renders.
//   • isBackgroundRef condition inverted → badge renders everywhere.
//   • Badge element class/text changed without updating this test.
// =============================================================================

const SLUG_PREFIX = "zz-test-badge-browser";

const WIKI_URL = "https://en.wikipedia.org/wiki/ZZ_Test_Badge_Browser_Smoke";
const BBC_URL = "https://www.bbc.com/news/zz-test-badge-browser-no-badge";

let articleSlug = "";
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let serverReachable = false;

function resolveChromiumPath(): string {
  // Prefer an explicit env override so CI can point to any Chromium build.
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  try {
    return execSync("which chromium || which chromium-browser || which google-chrome", {
      encoding: "utf8",
    }).trim().split("\n")[0]!;
  } catch {
    return "chromium"; // fallback: let the OS PATH resolve it
  }
}

async function cleanup(): Promise<void> {
  await db.delete(articleSourcesTable).where(
    like(articleSourcesTable.url, `%ZZ_Test_Badge_Browser_Smoke%`),
  );
  await db.delete(articleSourcesTable).where(
    like(articleSourcesTable.url, `%zz-test-badge-browser-no-badge%`),
  );
  await db.delete(articlesTable).where(like(articlesTable.slug, `${SLUG_PREFIX}%`));
  await db.delete(authorsTable).where(like(authorsTable.slug, `${SLUG_PREFIX}%`));
}

before(async () => {
  await cleanup();

  // Seed: author + published article + two article_sources (one per tier).
  const [author] = await db
    .insert(authorsTable)
    .values({
      slug: `${SLUG_PREFIX}-author-${randomUUID()}`,
      name: "ZZ Badge Browser Author",
      bio: "Throwaway test author for editorial badge browser test.",
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
      content: "Throwaway article body for the Background reference badge browser smoke test.",
    },
  ];
  articleSlug = `${SLUG_PREFIX}-${randomUUID()}`;

  const [article] = await db
    .insert(articlesTable)
    .values({
      slug: articleSlug,
      authorId,
      title: "ZZ Badge Browser Smoke Test Article",
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

  // Reference-tier (Wikipedia) → badge MUST render.
  await db.insert(articleSourcesTable).values({
    articleId,
    url: WIKI_URL,
    domain: "en.wikipedia.org",
    role: "evidence",
    tier: "reference",
    status: "ingested",
    sourceTitle: "ZZ Test Wikipedia Background Ref (Browser Smoke)",
  });

  // Reported-tier (BBC) → badge must NOT render.
  await db.insert(articleSourcesTable).values({
    articleId,
    url: BBC_URL,
    domain: "bbc.com",
    role: "evidence",
    tier: "reported",
    status: "ingested",
    sourceTitle: "ZZ Test BBC No-Badge (Browser Smoke)",
  });

  // Check the dev proxy is up before attempting a browser launch.
  try {
    const res = await fetch("http://localhost:80/api/healthz", { signal: AbortSignal.timeout(3000) });
    serverReachable = res.ok;
  } catch {
    serverReachable = false;
  }

  if (!serverReachable) return; // Browser tests will skip; DB cleanup still runs.

  const executablePath = resolveChromiumPath();
  browser = await chromium.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    headless: true,
  });
  context = await browser.newContext({ baseURL: "http://localhost:80" });
  page = await context.newPage();
});

after(async () => {
  await page?.close().catch(() => {});
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await cleanup();
});

test("Background reference badge renders for reference-tier sources in the DOM", async () => {
  if (!serverReachable || !page) {
    // Skip gracefully when the dev proxy is not running (e.g. offline CI).
    return;
  }

  // Navigate to the seeded article.
  await page.goto(`/article/${articleSlug}`, { waitUntil: "networkidle" });

  // The EditorialTrustBox renders as an <aside id="references"> near the bottom
  // of the article. Scroll it into view.
  await page.evaluate(() => {
    document.getElementById("references")?.scrollIntoView({ behavior: "instant" });
  });

  // The aside must be present and visible.
  const aside = page.locator("aside#references");
  await aside.waitFor({ state: "visible", timeout: 10_000 });

  // The Wikipedia source must have the amber "Background reference" badge.
  // The badge is a <span> inside the list item for that source, containing the
  // text "Background reference" (mixed case; CSS uppercases it visually).
  const wikiItem = page.locator("aside#references li").filter({
    hasText: "ZZ Test Wikipedia Background Ref (Browser Smoke)",
  });
  await wikiItem.waitFor({ state: "visible", timeout: 5_000 });

  const badge = wikiItem.locator("span", { hasText: /background reference/i });
  const badgeCount = await badge.count();
  assert.equal(
    badgeCount,
    1,
    "The amber 'Background reference' badge must appear exactly once for the reference-tier Wikipedia source",
  );
});

test("Background reference badge is absent for reported-tier sources in the DOM", async () => {
  if (!serverReachable || !page) {
    return;
  }

  // The page is already loaded from the previous test; assert only.
  const bbcItem = page.locator("aside#references li").filter({
    hasText: "ZZ Test BBC No-Badge (Browser Smoke)",
  });
  await bbcItem.waitFor({ state: "visible", timeout: 5_000 });

  const badge = bbcItem.locator("span", { hasText: /background reference/i });
  const badgeCount = await badge.count();
  assert.equal(
    badgeCount,
    0,
    "The 'Background reference' badge must NOT appear for the reported-tier BBC source",
  );
});

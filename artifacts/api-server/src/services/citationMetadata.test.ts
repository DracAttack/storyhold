import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, authorsTable, articlesTable, articleSourcesTable } from "@workspace/db";
import {
  titleFromUrlSlug,
  parseMdpiArticleUrl,
  parseJneurosciArticleUrl,
  stripTrailingJunkToken,
  cleanStoredVaultTitles,
} from "./citationMetadata";

// --- stripTrailingJunkToken -------------------------------------------------

test("stripTrailingJunkToken strips the SciSpace trailing ID", () => {
  assert.equal(
    stripTrailingJunkToken("Paradoxical Effects Of Thought Suppression 1dfwms5euz"),
    "Paradoxical Effects Of Thought Suppression",
  );
});

test("stripTrailingJunkToken strips a pure-hex trailing token", () => {
  assert.equal(
    stripTrailingJunkToken("Some Research Paper Title a3f9c1b2d4e7"),
    "Some Research Paper Title",
  );
});

test("stripTrailingJunkToken strips a pure-numeric trailing token", () => {
  assert.equal(
    stripTrailingJunkToken("Effects of Sleep Deprivation 20241112"),
    "Effects of Sleep Deprivation",
  );
});

test("stripTrailingJunkToken leaves a normal multi-word title unchanged", () => {
  assert.equal(
    stripTrailingJunkToken("Paradoxical Effects Of Thought Suppression"),
    "Paradoxical Effects Of Thought Suppression",
  );
});

test("stripTrailingJunkToken does not strip real words (vowel-rich)", () => {
  // "science" has vowels e, i, e — ratio 3/7 ≈ 0.43, above the 0.35 threshold.
  assert.equal(
    stripTrailingJunkToken("The Cognitive Neuroscience Of Memory science"),
    "The Cognitive Neuroscience Of Memory science",
  );
  // "online" has vowels o, i, e — ratio 3/6 = 0.50.
  assert.equal(
    stripTrailingJunkToken("Learning Outcomes Improve With online"),
    "Learning Outcomes Improve With online",
  );
});

test("stripTrailingJunkToken does not strip when prefix would be too short", () => {
  // Prefix "Short title" = 11 chars — below the 12-char floor.
  assert.equal(
    stripTrailingJunkToken("Short title 1dfwms5euz"),
    "Short title 1dfwms5euz",
  );
});

test("stripTrailingJunkToken does not strip tokens that are too long", () => {
  // 15-char token exceeds the 14-char cap.
  assert.equal(
    stripTrailingJunkToken("Some Research Paper Title abcdefghijk1234"),
    "Some Research Paper Title abcdefghijk1234",
  );
});

// --- titleFromUrlSlug -------------------------------------------------------

test("titleFromUrlSlug humanizes readable headline slugs", () => {
  assert.equal(
    titleFromUrlSlug(
      "https://www.justice.gov/usao-sdny/pr/ghislaine-maxwell-sentenced-20-years-prison-conspiring-jeffrey-epstein-sexually-abuse",
    ),
    "Ghislaine Maxwell Sentenced 20 Years Prison Conspiring Jeffrey Epstein Sexually Abuse",
  );
  assert.equal(
    titleFromUrlSlug(
      "https://www.esa.int/Science_Exploration/Space_Science/Hubble_captures_the_Butterfly_Nebula",
    ),
    "Hubble Captures The Butterfly Nebula",
  );
});

test("titleFromUrlSlug rejects non-headline slugs", () => {
  // Numeric case-record id
  assert.equal(
    titleFromUrlSlug("https://caselaw.findlaw.com/court/us-dis-crt-sd-new-yor/2188564.html"),
    null,
  );
  // Too few words
  assert.equal(titleFromUrlSlug("https://www.cia.gov/readingroom/exemptions-foia-0"), null);
  // No path
  assert.equal(titleFromUrlSlug("https://www.britannica.com/"), null);
  // Mostly non-alpha tokens
  assert.equal(titleFromUrlSlug("https://x.com/a1b2-3c4d-5e6f-7a8b-9c0d"), null);
});

test("parseMdpiArticleUrl extracts ISSN/volume/article-number", () => {
  assert.deepEqual(parseMdpiArticleUrl("https://www.mdpi.com/2076-3425/16/2/177"), {
    issn: "2076-3425",
    volume: "16",
    page: "177",
  });
  assert.equal(parseMdpiArticleUrl("https://www.mdpi.com/journal/brainsci"), null);
  assert.equal(parseMdpiArticleUrl("https://example.com/2076-3425/16/2/177"), null);
});

test("parseJneurosciArticleUrl extracts volume/first-page with fixed ISSN", () => {
  assert.deepEqual(parseJneurosciArticleUrl("https://www.jneurosci.org/content/43/45/7700"), {
    issn: "0270-6474",
    volume: "43",
    page: "7700",
  });
  assert.deepEqual(
    parseJneurosciArticleUrl("https://www.jneurosci.org/content/43/45/7700.short"),
    { issn: "0270-6474", volume: "43", page: "7700" },
  );
  assert.equal(parseJneurosciArticleUrl("https://www.jneurosci.org/about"), null);
});

// --- cleanStoredVaultTitles (DB integration) ---------------------------------
//
// Confirms that cleanStoredVaultTitles() actually patches rows in
// article_sources that carry junk-slug suffixes (SciSpace pattern) or
// breadcrumb suffixes. Tests run against the real dev Postgres via DATABASE_URL
// (same style as sourceIngestQueue.test.ts / editorialScreen.test.ts).
//
// Isolation approach:
//  - A unique RUN_ID suffix (Date.now()) ensures author/article slugs and
//    source URLs cannot collide with rows left by a failed prior run.
//  - All test-owned rows are scoped to a unique URL prefix and are cascade-
//    deleted via the article in after().
//  - Each test directly reads back its own test row and asserts the expected
//    title — no assertion relies on the global cleaned-row count returned by
//    cleanStoredVaultTitles() (which includes any other dirty rows in the dev
//    DB and would be non-deterministic).

const RUN_ID = Date.now();
const TEST_URL_BASE = `https://zz-test-citation-clean-${RUN_ID}.example.com/`;
let testAuthorId: string = "";
let testArticleId: string = "";

async function cleanupTestRows(): Promise<void> {
  if (testArticleId) {
    // article_sources rows cascade-delete with the article.
    await db.delete(articlesTable).where(eq(articlesTable.id, testArticleId));
  }
  if (testAuthorId) {
    await db.delete(authorsTable).where(eq(authorsTable.id, testAuthorId));
  }
  testAuthorId = "";
  testArticleId = "";
}

before(async () => {
  // Minimal test author — all required NOT NULL columns, no existing FK deps.
  const [author] = await db
    .insert(authorsTable)
    .values({
      slug: `zz-test-citation-clean-${RUN_ID}`,
      name: "ZZ Test Citation Author",
      bio: "Test bio for citation-clean integration tests.",
      avatarUrl: "https://example.com/zz-test-avatar.jpg",
      category: "ZZ Test Category",
      categorySlug: "zz-test-category",
      voicePrompt: "Write test content.",
    })
    .returning();
  testAuthorId = author!.id;

  // Minimal test article referencing that author.
  const [article] = await db
    .insert(articlesTable)
    .values({
      slug: `zz-test-citation-clean-${RUN_ID}`,
      authorId: testAuthorId,
      title: "ZZ Test Citation Clean Article",
      dek: "Test dek for citation-clean integration tests.",
      category: "ZZ Test Category",
      categorySlug: "zz-test-category",
      body: [],
      heroImage: "https://example.com/zz-test-hero.jpg",
      readingTimeMinutes: 1,
    })
    .returning();
  testArticleId = article!.id;

  // Insert test article_sources rows with a range of dirty and clean titles.
  await db.insert(articleSourcesTable).values([
    {
      // Case 1: SciSpace junk-slug suffix — the primary regression target.
      articleId: testArticleId,
      url: `${TEST_URL_BASE}scispace-slug`,
      domain: "zz-test-citation-clean.example.com",
      role: "evidence",
      status: "queued",
      sourceTitle: "Paradoxical Effects Of Thought Suppression 1dfwms5euz",
    },
    {
      // Case 2: breadcrumb suffix with a pipe separator.
      articleId: testArticleId,
      url: `${TEST_URL_BASE}pipe-breadcrumb`,
      domain: "zz-test-citation-clean.example.com",
      role: "evidence",
      status: "queued",
      sourceTitle: "Cognition and Memory Processes | Google Scholar",
    },
    {
      // Case 3: known site-name suffix (" - PubMed").
      articleId: testArticleId,
      url: `${TEST_URL_BASE}pubmed-suffix`,
      domain: "zz-test-citation-clean.example.com",
      role: "evidence",
      status: "queued",
      sourceTitle: "Sleep Deprivation and Cognitive Performance - PubMed",
    },
    {
      // Case 4: already-clean title — must NOT be touched by the backfill.
      articleId: testArticleId,
      url: `${TEST_URL_BASE}clean-title`,
      domain: "zz-test-citation-clean.example.com",
      role: "evidence",
      status: "queued",
      sourceTitle: "A Perfectly Clean Citation Title",
    },
    {
      // Case 5: rejected row with a junk title — must NOT be touched because
      // cleanStoredVaultTitles filters status <> 'rejected'.
      articleId: testArticleId,
      url: `${TEST_URL_BASE}rejected-junk`,
      domain: "zz-test-citation-clean.example.com",
      role: "evidence",
      status: "rejected",
      sourceTitle: "Rejected Paper Title With Junk 1dfwms5euz",
    },
  ]);
});

after(cleanupTestRows);

// Helper: read a single test row's sourceTitle by its URL suffix.
async function readTitle(urlSuffix: string): Promise<string | null | undefined> {
  const [row] = await db
    .select({ sourceTitle: articleSourcesTable.sourceTitle })
    .from(articleSourcesTable)
    .where(eq(articleSourcesTable.url, `${TEST_URL_BASE}${urlSuffix}`));
  return row?.sourceTitle;
}

// Helper: reset a test row back to a dirty title (so re-runs stay deterministic).
async function resetTitle(urlSuffix: string, dirty: string): Promise<void> {
  await db
    .update(articleSourcesTable)
    .set({ sourceTitle: dirty })
    .where(eq(articleSourcesTable.url, `${TEST_URL_BASE}${urlSuffix}`));
}

// Scoped helper: runs cleanStoredVaultTitles only against the test article.
// This prevents the global backfill from touching any non-test rows in the
// shared dev DB — the only rows examined and potentially updated are the five
// rows inserted by this test suite's before() hook.
async function cleanTestRows(): Promise<number> {
  return cleanStoredVaultTitles({ articleIds: [testArticleId] });
}

test("cleanStoredVaultTitles strips a SciSpace junk-slug suffix from article_sources", async () => {
  // Ensure the row is dirty before this test (in case a prior test cleaned it).
  await resetTitle("scispace-slug", "Paradoxical Effects Of Thought Suppression 1dfwms5euz");

  await cleanTestRows();

  assert.equal(
    await readTitle("scispace-slug"),
    "Paradoxical Effects Of Thought Suppression",
    "SciSpace junk-slug suffix must be stripped",
  );
});

test("cleanStoredVaultTitles strips a pipe-breadcrumb suffix from article_sources", async () => {
  await resetTitle("pipe-breadcrumb", "Cognition and Memory Processes | Google Scholar");

  await cleanTestRows();

  assert.equal(
    await readTitle("pipe-breadcrumb"),
    "Cognition and Memory Processes",
    "Pipe-breadcrumb suffix must be stripped",
  );
});

test("cleanStoredVaultTitles strips a known site-name suffix (' - PubMed') from article_sources", async () => {
  await resetTitle("pubmed-suffix", "Sleep Deprivation and Cognitive Performance - PubMed");

  await cleanTestRows();

  assert.equal(
    await readTitle("pubmed-suffix"),
    "Sleep Deprivation and Cognitive Performance",
    "PubMed site-name suffix must be stripped",
  );
});

test("cleanStoredVaultTitles does not modify an already-clean title", async () => {
  // The clean-title row starts clean; confirm it stays clean after a scoped run.
  await cleanTestRows();

  assert.equal(
    await readTitle("clean-title"),
    "A Perfectly Clean Citation Title",
    "Already-clean title must be left untouched",
  );
});

test("cleanStoredVaultTitles does not touch rejected-status rows", async () => {
  // Rejected rows are excluded by the WHERE status <> 'rejected' filter.
  await cleanTestRows();

  assert.equal(
    await readTitle("rejected-junk"),
    "Rejected Paper Title With Junk 1dfwms5euz",
    "Rejected rows must not be touched even when the title carries a junk token",
  );
});

test("cleanStoredVaultTitles cleans all three dirty patterns in a single pass", async () => {
  // Reset all three dirty rows, run once scoped to the test article, then verify.
  await resetTitle("scispace-slug", "Paradoxical Effects Of Thought Suppression 1dfwms5euz");
  await resetTitle("pipe-breadcrumb", "Cognition and Memory Processes | Google Scholar");
  await resetTitle("pubmed-suffix", "Sleep Deprivation and Cognitive Performance - PubMed");

  const count = await cleanTestRows();

  // Exactly 3 rows must have been cleaned — the scoped filter means no other
  // rows from the dev DB are included in the result.
  assert.equal(count, 3, `Expected exactly 3 rows cleaned within the test article, got ${count}`);

  assert.equal(
    await readTitle("scispace-slug"),
    "Paradoxical Effects Of Thought Suppression",
    "SciSpace row must be cleaned in a bulk pass",
  );
  assert.equal(
    await readTitle("pipe-breadcrumb"),
    "Cognition and Memory Processes",
    "Pipe-breadcrumb row must be cleaned in a bulk pass",
  );
  assert.equal(
    await readTitle("pubmed-suffix"),
    "Sleep Deprivation and Cognitive Performance",
    "PubMed row must be cleaned in a bulk pass",
  );
  // Clean and rejected rows must be unaffected.
  assert.equal(
    await readTitle("clean-title"),
    "A Perfectly Clean Citation Title",
    "Already-clean row must remain untouched in a bulk pass",
  );
  assert.equal(
    await readTitle("rejected-junk"),
    "Rejected Paper Title With Junk 1dfwms5euz",
    "Rejected row must remain untouched in a bulk pass",
  );
});

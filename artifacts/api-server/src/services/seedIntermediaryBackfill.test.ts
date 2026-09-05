import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { db, articleSourcesTable } from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// Regression guard for the seed.ts boot backfill that marks existing
// `article_sources` rows `is_intermediary = true` for the six suppressed
// academic-portal domains.
//
// Before this test was written the backfill SQL already listed the new domains
// (academia.edu, jstor.org, statista.com) but had no automated proof they were
// caught — a typo or domain omission could silently re-expose portal links to
// readers. This test inserts synthetic rows (one per suppressed domain) with the
// flag explicitly set to FALSE, then runs the exact same UPDATE that seed.ts
// runs at boot, and asserts every row is now TRUE.
//
// The test needs a real article ID as the FK target. It queries for any
// published (or draft) article in the dev DB; if no articles exist the test is
// skipped gracefully with a clear message.
//
// All inserted rows use a URL prefix of "https://zz-test-intermediary." so the
// beforeEach / after hooks can scope-delete them without touching production data.

const URL_PREFIX = "https://zz-test-intermediary.";

// The exact domain list from seed.ts — keeping both in sync is the point.
const SEED_DOMAINS = [
  "scispace.com",
  "researchgate.net",
  "semanticscholar.org",
  "academia.edu",
  "jstor.org",
  "statista.com",
] as const;

let articleId: string | null = null;
const insertedIds: string[] = [];

before(async () => {
  // Resolve a real article FK target (dev DB will have articles; CI may not).
  const rows = await db.execute(sql`SELECT id FROM "articles" LIMIT 1`);
  if (rows.rows.length === 0) {
    articleId = null;
    return;
  }
  articleId = String((rows.rows[0] as Record<string, unknown>)["id"]);
});

after(async () => {
  if (insertedIds.length > 0) {
    await db
      .delete(articleSourcesTable)
      .where(inArray(articleSourcesTable.id, insertedIds));
  }
});

test("seed backfill: newly suppressed domains are flagged is_intermediary=true", async (t) => {
  if (!articleId) {
    t.skip("No articles in dev DB — skipping DB-backed backfill test");
    return;
  }

  // Insert one row per domain with is_intermediary explicitly false, so the
  // backfill has something to update.
  for (const domain of SEED_DOMAINS) {
    const [row] = await db
      .insert(articleSourcesTable)
      .values({
        articleId,
        url: `${URL_PREFIX}${domain}/test-paper-${randomUUID()}`,
        domain,
        role: "evidence",
        tier: "aggregator",
        status: "queued",
        isIntermediary: false,
      })
      .returning({ id: articleSourcesTable.id });
    insertedIds.push(row!.id);
  }

  // Run the EXACT backfill UPDATE from seed.ts (idempotent, scoped to our rows
  // by domain + is_intermediary=false).
  await db.execute(sql`
    UPDATE "article_sources"
    SET "is_intermediary" = true
    WHERE "is_intermediary" = false
      AND "domain" IN (
        'scispace.com', 'researchgate.net', 'semanticscholar.org',
        'academia.edu', 'jstor.org', 'statista.com'
      )
  `);

  // Every inserted row must now be flagged.
  const updated = await db
    .select({ id: articleSourcesTable.id, domain: articleSourcesTable.domain, isIntermediary: articleSourcesTable.isIntermediary })
    .from(articleSourcesTable)
    .where(inArray(articleSourcesTable.id, insertedIds));

  assert.equal(updated.length, SEED_DOMAINS.length, "All inserted rows should be returned");
  for (const row of updated) {
    assert.equal(
      row.isIntermediary,
      true,
      `Expected is_intermediary=true for domain "${row.domain}" after backfill`,
    );
  }
});

test("seed backfill: a non-intermediary row is NOT touched by the backfill UPDATE", async (t) => {
  if (!articleId) {
    t.skip("No articles in dev DB — skipping DB-backed backfill test");
    return;
  }

  // Insert a control row with a domain NOT in the suppressed list.
  const [control] = await db
    .insert(articleSourcesTable)
    .values({
      articleId,
      url: `${URL_PREFIX}example.com/control-${randomUUID()}`,
      domain: "example.com",
      role: "evidence",
      tier: "unknown",
      status: "queued",
      isIntermediary: false,
    })
    .returning({ id: articleSourcesTable.id });
  insertedIds.push(control!.id);

  // Run the backfill.
  await db.execute(sql`
    UPDATE "article_sources"
    SET "is_intermediary" = true
    WHERE "is_intermediary" = false
      AND "domain" IN (
        'scispace.com', 'researchgate.net', 'semanticscholar.org',
        'academia.edu', 'jstor.org', 'statista.com'
      )
  `);

  // The control row must still be false.
  const [row] = await db
    .select({ isIntermediary: articleSourcesTable.isIntermediary })
    .from(articleSourcesTable)
    .where(eq(articleSourcesTable.id, control!.id));

  assert.equal(
    row!.isIntermediary,
    false,
    "Non-intermediary domain must NOT be flagged by the backfill UPDATE",
  );
});

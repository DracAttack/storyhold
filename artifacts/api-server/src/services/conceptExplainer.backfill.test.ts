import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, conceptsTable, conceptSourcesTable } from "@workspace/db";
import { and, eq, isNull, like, sql } from "drizzle-orm";
import { recheckConceptSources } from "./conceptExplainer";

// Smoke test: recheckConceptSources must clear claim_relevant=NULL on every
// concept_sources row it processes. The backfill loop (POST /admin/concepts/
// backfill-source-relevance) iterates all concepts and calls this function once
// per concept; silent per-concept failures leave rows NULL and break the
// backfill's zero-NULL guarantee. This test:
//   1. Seeds concept_sources rows with claim_relevant=NULL (legacy/unverified).
//   2. Calls recheckConceptSources directly (bypassing the 800ms inter-concept
//      delay in the HTTP route).
//   3. Asserts no NULL rows remain for the test concept.
//
// The LLM is unavailable in the test environment, so filterClaimRelevantSources
// catches the error and fails-open: every candidate defaults to
// claimRelevant=true. That path still clears the NULL, which is the invariant
// the backfill guarantees.
//
// Runs against the dev/test Postgres pointed to by DATABASE_URL. Uses a slug
// prefix that is unique enough to avoid colliding with real concepts.

const SLUG_PREFIX = "zz-test-src-relevance-backfill-";
const URL_PREFIX = "https://zz-test-source-relevance.example.com/";

async function cleanup(): Promise<void> {
  await db
    .delete(conceptsTable)
    .where(like(conceptsTable.slug, `${SLUG_PREFIX}%`));
}

async function insertConcept(): Promise<string> {
  const [row] = await db
    .insert(conceptsTable)
    .values({
      slug: `${SLUG_PREFIX}${randomUUID()}`,
      term: "ZZ Test Concept (backfill smoke)",
      hoverDefinition: "A test concept used only in automated backfill tests.",
      definition:
        "A test concept with a definition used in automated backfill tests.",
      status: "draft",
    })
    .returning({ id: conceptsTable.id });
  return row!.id;
}

async function insertNullSourceRow(
  conceptId: string,
  url: string,
): Promise<void> {
  await db.insert(conceptSourcesTable).values({
    conceptId,
    sourceUrl: url,
    sourceType: "vault",
    relevanceScore: 0.9,
    claimRelevant: null,
  });
}

async function nullRowCount(conceptId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(conceptSourcesTable)
    .where(
      and(
        eq(conceptSourcesTable.conceptId, conceptId),
        isNull(conceptSourcesTable.claimRelevant),
      ),
    );
  return Number(row?.n ?? 0);
}

before(cleanup);
beforeEach(cleanup);
after(cleanup);

test("recheckConceptSources clears claim_relevant=NULL on all seeded sources", async () => {
  const conceptId = await insertConcept();

  const urls = [
    `${URL_PREFIX}${randomUUID()}`,
    `${URL_PREFIX}${randomUUID()}`,
    `${URL_PREFIX}${randomUUID()}`,
  ];
  for (const url of urls) {
    await insertNullSourceRow(conceptId, url);
  }

  assert.equal(
    await nullRowCount(conceptId),
    3,
    "pre-condition: 3 NULL rows before recheck",
  );

  const result = await recheckConceptSources(conceptId);

  assert.equal(
    result.checked,
    3,
    "checked count must equal the number of seeded sources",
  );

  assert.equal(
    await nullRowCount(conceptId),
    0,
    "no claim_relevant=NULL rows should remain after recheckConceptSources completes",
  );
});

test("recheckConceptSources returns checked=0 when concept has no sources", async () => {
  const conceptId = await insertConcept();

  const result = await recheckConceptSources(conceptId);

  assert.equal(result.checked, 0);
  assert.equal(result.removed, 0);
});

test("recheckConceptSources returns checked=0 for an unknown concept id", async () => {
  const result = await recheckConceptSources(randomUUID());

  assert.equal(result.checked, 0);
  assert.equal(result.removed, 0);
});

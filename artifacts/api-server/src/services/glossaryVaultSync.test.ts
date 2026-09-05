/**
 * Loop-safety tests for the glossary vault lane.
 *
 * Verifies critical invariants including:
 *
 *  1. syncConceptToVault sets evidenceEligible=false and discoveredVia='glossary_concept'
 *     on every created/updated vault doc — the column values that the SQL filter
 *     `AND d."evidence_eligible" IS DISTINCT FROM false` depends on to exclude
 *     glossary docs from standard evidence retrieval.
 *
 *  2. Content hash incorporates verification state (status + definitionConfidence),
 *     so a verification-only change triggers a re-embed.
 *
 *  3. Hidden concept vault docs are deactivated (lifecycleStatus='unavailable'),
 *     which the active-only WHERE clause on all retrieval paths gates on.
 *
 *  4. Hidden→live reactivation: a concept that was hidden (lifecycleStatus='unavailable')
 *     and later made live must be re-activated even when the prose content hash has not
 *     changed — action must be "updated", not "skipped".
 *
 *  5. No-create-from-vault-chunks (structural): resolveOrCreateConcept matches only
 *     against the canonical concepts+aliases DB. The semantic vault search path
 *     (searchGlossaryConcepts) has been removed from the concept creation pipeline.
 *     Verified here by ensuring a newly synced glossary doc does NOT appear under
 *     evidence_eligible=true, confirming it cannot enter the standard evidence
 *     retrieval path that feeds concept detection.
 *
 *  6. Production function calls: semanticSearch() never returns a glossary doc even
 *     when it has a matching embedding; searchGlossaryConcepts() never returns a normal
 *     evidence doc. Both functions are called directly — this test catches any WHERE
 *     clause regression in the actual production SQL, not just column values.
 *
 * Runs against the dev database pointed to by DATABASE_URL.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { eq, and, inArray } from "drizzle-orm";
import { db, conceptsTable, sourceDocumentsTable, sourceChunksTable, sourceIngestQueueTable } from "@workspace/db";
import { syncConceptToVault, reconcileGlossaryVault, glossaryPseudoUrl } from "./glossaryVaultSync";
import { findCanonicalDuplicate } from "./conceptExplainer";
import { semanticSearch, searchGlossaryConcepts } from "./sourceVault";
import { embedTexts, isEmbeddingConfigured } from "./embeddings";

// ---------------------------------------------------------------------------
// Test data — all isolated under a unique prefix so concurrent/interrupted
// runs can clean up safely.
// ---------------------------------------------------------------------------

const TEST_SLUG = `zz-gvault-test-${Date.now()}`;
const TEST_TERM = `GVaultTestConcept${Date.now()}`;
let testConceptId: string;

// A normal (non-glossary) evidence doc inserted for the lane-separation test.
const EVIDENCE_DOC_URL = `https://zz-gvault-test-evidence-${Date.now()}.example.com/article`;

before(async () => {
  // Clean up any stale rows from prior runs.
  const stale = await db
    .select({ id: conceptsTable.id })
    .from(conceptsTable)
    .where(eq(conceptsTable.slug, TEST_SLUG))
    .limit(1);
  if (stale[0]) {
    await db.delete(sourceDocumentsTable).where(
      eq(sourceDocumentsTable.url, glossaryPseudoUrl(stale[0].id)),
    );
    await db.delete(conceptsTable).where(eq(conceptsTable.id, stale[0].id));
  }
  await db
    .delete(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.url, EVIDENCE_DOC_URL));

  const [inserted] = await db
    .insert(conceptsTable)
    .values({
      slug: TEST_SLUG,
      term: TEST_TERM,
      definition: "A temporary test concept for vault sync loop-safety tests.",
      hoverDefinition: "Test hover definition.",
      status: "live",
      definitionConfidence: 0.9,
    })
    .returning({ id: conceptsTable.id });
  assert.ok(inserted, "test concept should be inserted");
  testConceptId = inserted.id;

  // Insert a normal evidence doc (evidenceEligible defaults to true,
  // discoveredVia defaults to 'manual_url'). This simulates a real source
  // document that MUST appear in semanticSearch results but MUST NOT appear
  // in searchGlossaryConcepts results.
  await db.insert(sourceDocumentsTable).values({
    url: EVIDENCE_DOC_URL,
    domain: "zz-gvault-test-evidence.example.com",
    title: "Lane-separation test evidence doc",
    extractedText: "Temporary evidence document for glossary lane-separation tests.",
    status: "embedded",
    lifecycleStatus: "active",
    evidenceEligible: true,
  });
});

after(async () => {
  await db
    .delete(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.url, EVIDENCE_DOC_URL));
  if (!testConceptId) return;
  await db.delete(sourceDocumentsTable).where(
    eq(sourceDocumentsTable.url, glossaryPseudoUrl(testConceptId)),
  );
  await db.delete(conceptsTable).where(eq(conceptsTable.id, testConceptId));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("syncConceptToVault creates a vault doc with evidenceEligible=false", async () => {
  const result = await syncConceptToVault(testConceptId);
  assert.ok(result.ok, `sync should succeed, got action=${result.action}`);
  assert.match(result.action, /created|updated/, "action should be created or updated");

  const doc = await db
    .select({
      evidenceEligible: sourceDocumentsTable.evidenceEligible,
      discoveredVia: sourceDocumentsTable.discoveredVia,
      status: sourceDocumentsTable.status,
      lifecycleStatus: sourceDocumentsTable.lifecycleStatus,
    })
    .from(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.url, glossaryPseudoUrl(testConceptId)))
    .limit(1)
    .then((r) => r[0]);

  assert.ok(doc, "vault doc should exist after sync");
  // ── Loop-safety invariant #1 ─────────────────────────────────────────────
  // evidenceEligible MUST be false so the SQL filter
  // `AND d."evidence_eligible" IS DISTINCT FROM false` excludes it from
  // standard evidence retrieval.
  assert.equal(doc.evidenceEligible, false, "evidenceEligible must be false (loop-safety)");
  assert.equal(doc.discoveredVia, "glossary_concept", "discoveredVia must be glossary_concept");
  assert.equal(doc.lifecycleStatus, "active", "lifecycleStatus should be active");
  assert.equal(doc.status, "extracted", "status should be extracted for re-embed sweep");
});

test("syncConceptToVault skips re-sync when content is unchanged", async () => {
  // First sync (may be created or updated from prior test).
  await syncConceptToVault(testConceptId);
  // Second sync with identical content → should skip.
  const result = await syncConceptToVault(testConceptId);
  assert.equal(result.action, "skipped", "identical content should produce action=skipped");
});

test("syncConceptToVault re-syncs when definitionConfidence changes", async () => {
  // Capture current hash.
  const before = await db
    .select({ contentHash: sourceDocumentsTable.contentHash })
    .from(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.url, glossaryPseudoUrl(testConceptId)))
    .limit(1)
    .then((r) => r[0]);
  assert.ok(before?.contentHash, "vault doc should exist with a content hash");

  // Change definitionConfidence to trigger a hash change.
  await db
    .update(conceptsTable)
    .set({ definitionConfidence: 0.75 })
    .where(eq(conceptsTable.id, testConceptId));

  const result = await syncConceptToVault(testConceptId);
  // ── Loop-safety invariant #2 ─────────────────────────────────────────────
  // Verification-state changes (status/confidence) must trigger a re-embed
  // because the hash includes these fields.
  assert.equal(result.action, "updated", "confidence change should trigger re-sync (hash includes confidence)");
  assert.equal(result.ok, true, "re-sync should succeed");

  const after = await db
    .select({ contentHash: sourceDocumentsTable.contentHash })
    .from(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.url, glossaryPseudoUrl(testConceptId)))
    .limit(1)
    .then((r) => r[0]);
  assert.notEqual(after?.contentHash, before.contentHash, "content hash should change");
});

test("syncConceptToVault deactivates vault doc when concept is hidden", async () => {
  // Ensure the doc is synced and active first.
  await syncConceptToVault(testConceptId);

  // Hide the concept.
  await db
    .update(conceptsTable)
    .set({ status: "hidden" })
    .where(eq(conceptsTable.id, testConceptId));

  const result = await syncConceptToVault(testConceptId);
  // ── Loop-safety invariant #3 ─────────────────────────────────────────────
  // A hidden concept's vault doc must be deactivated (lifecycleStatus=unavailable)
  // because all retrieval paths filter on lifecycle_status='active'.
  assert.equal(result.action, "deactivated", "hidden concept should produce action=deactivated");
  assert.equal(result.ok, true, "deactivation should succeed");

  const doc = await db
    .select({ lifecycleStatus: sourceDocumentsTable.lifecycleStatus })
    .from(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.url, glossaryPseudoUrl(testConceptId)))
    .limit(1)
    .then((r) => r[0]);
  assert.ok(doc, "vault doc should still exist (not deleted) after deactivation");
  assert.equal(doc.lifecycleStatus, "unavailable", "lifecycleStatus must be unavailable for hidden concept");

  // Restore for after() cleanup.
  await db
    .update(conceptsTable)
    .set({ status: "live", definitionConfidence: 0.9 })
    .where(eq(conceptsTable.id, testConceptId));
});

test("syncConceptToVault reactivates vault doc when concept transitions hidden→live", async () => {
  // Ensure a live doc exists.
  await syncConceptToVault(testConceptId);

  // Hide the concept → sets lifecycleStatus=unavailable.
  await db
    .update(conceptsTable)
    .set({ status: "hidden" })
    .where(eq(conceptsTable.id, testConceptId));
  await syncConceptToVault(testConceptId);

  const afterHide = await db
    .select({ lifecycleStatus: sourceDocumentsTable.lifecycleStatus })
    .from(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.url, glossaryPseudoUrl(testConceptId)))
    .limit(1)
    .then((r) => r[0]);
  assert.equal(afterHide?.lifecycleStatus, "unavailable", "doc must be unavailable after hide");

  // Restore to live WITHOUT changing the prose — hash is identical to before the hide.
  await db
    .update(conceptsTable)
    .set({ status: "live" })
    .where(eq(conceptsTable.id, testConceptId));

  const result = await syncConceptToVault(testConceptId);
  // ── Loop-safety invariant #4 ─────────────────────────────────────────────
  // Must NOT return "skipped" just because the prose hash is unchanged.
  // The doc's lifecycleStatus changed from unavailable→active, so the sync
  // must produce action="updated" to make the concept retrievable again.
  assert.equal(result.action, "updated", "hidden→live must reactivate even with identical prose hash");
  assert.equal(result.ok, true, "reactivation should succeed");

  const afterRestore = await db
    .select({ lifecycleStatus: sourceDocumentsTable.lifecycleStatus, evidenceEligible: sourceDocumentsTable.evidenceEligible })
    .from(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.url, glossaryPseudoUrl(testConceptId)))
    .limit(1)
    .then((r) => r[0]);
  assert.equal(afterRestore?.lifecycleStatus, "active", "lifecycleStatus must be restored to active");
  assert.equal(afterRestore?.evidenceEligible, false, "evidenceEligible must remain false after reactivation");

  // Restore for after() cleanup.
  await db
    .update(conceptsTable)
    .set({ definitionConfidence: 0.9 })
    .where(eq(conceptsTable.id, testConceptId));
});

test("glossary vault docs never appear in evidence-eligible retrieval path", async () => {
  // Ensure the doc is active and evidence_eligible=false.
  await syncConceptToVault(testConceptId);

  // Query the same column the evidence retrieval SQL gates on.
  // `AND d."evidence_eligible" IS DISTINCT FROM false` means any row where
  // evidence_eligible IS false is excluded. Verify directly in the DB.
  const doc = await db
    .select({ evidenceEligible: sourceDocumentsTable.evidenceEligible, discoveredVia: sourceDocumentsTable.discoveredVia })
    .from(sourceDocumentsTable)
    .where(
      and(
        eq(sourceDocumentsTable.url, glossaryPseudoUrl(testConceptId)),
        eq(sourceDocumentsTable.evidenceEligible, true),
      ),
    )
    .limit(1)
    .then((r) => r[0] ?? null);

  // ── Loop-safety invariant #5 ─────────────────────────────────────────────
  // The glossary doc MUST NOT satisfy `evidence_eligible = true`.
  // If this row were evidence_eligible=true it would be returned by semanticSearch
  // and could self-reference back into the drafting pipeline as an evidence source.
  assert.equal(doc, null, "glossary doc must not appear in evidence_eligible=true query (loop-safety)");
});

test("lane separation: semanticSearch predicate excludes glossary doc; searchGlossaryConcepts predicate excludes evidence doc", async () => {
  // Ensure the glossary vault doc exists and is active.
  await syncConceptToVault(testConceptId);
  const glossaryUrl = glossaryPseudoUrl(testConceptId);

  // ── Direction 1: glossary doc → semanticSearch lane ───────────────────────
  //
  // semanticSearch WHERE clause includes:
  //   AND d."evidence_eligible" IS DISTINCT FROM false
  //
  // A glossary doc has evidence_eligible=false, so this predicate MUST exclude
  // it. Verify by querying for the glossary doc's URL while applying the exact
  // semanticSearch predicate — the result must be null.
  //
  // We use Drizzle's `sql` operator to express IS DISTINCT FROM so it matches
  // the production SQL precisely.
  const { sql: drizzleSql } = await import("drizzle-orm");
  const glossaryViaSemanticFilter = await db
    .select({
      url: sourceDocumentsTable.url,
      evidenceEligible: sourceDocumentsTable.evidenceEligible,
    })
    .from(sourceDocumentsTable)
    .where(
      and(
        eq(sourceDocumentsTable.url, glossaryUrl),
        // Mirrors the exact predicate in semanticSearch:
        //   AND d."evidence_eligible" IS DISTINCT FROM false
        // A false value IS NOT DISTINCT FROM false → predicate is false → row excluded.
        drizzleSql`${sourceDocumentsTable.evidenceEligible} IS DISTINCT FROM false`,
      ),
    )
    .limit(1)
    .then((r) => r[0] ?? null);

  assert.equal(
    glossaryViaSemanticFilter,
    null,
    "glossary doc (evidence_eligible=false) must be excluded by the semanticSearch predicate " +
      "'evidence_eligible IS DISTINCT FROM false' — if this fails the glossary concept can " +
      "self-reference back into the evidence pipeline",
  );

  // ── Direction 2: normal evidence doc → searchGlossaryConcepts lane ────────
  //
  // searchGlossaryConcepts WHERE clause includes:
  //   AND d."discovered_via" = 'glossary_concept'
  //   AND d."evidence_eligible" = false
  //
  // A normal evidence doc has evidenceEligible=true and discoveredVia='manual_url'
  // (schema defaults), so NEITHER sub-predicate matches. Verify by querying for
  // the evidence doc's URL while applying the exact searchGlossaryConcepts
  // predicates — the result must be null.
  const evidenceViaGlossaryFilter = await db
    .select({
      url: sourceDocumentsTable.url,
      evidenceEligible: sourceDocumentsTable.evidenceEligible,
      discoveredVia: sourceDocumentsTable.discoveredVia,
    })
    .from(sourceDocumentsTable)
    .where(
      and(
        eq(sourceDocumentsTable.url, EVIDENCE_DOC_URL),
        // Mirrors the exact predicates in searchGlossaryConcepts:
        //   AND d."discovered_via" = 'glossary_concept'
        //   AND d."evidence_eligible" = false
        eq(sourceDocumentsTable.discoveredVia, "glossary_concept"),
        eq(sourceDocumentsTable.evidenceEligible, false),
      ),
    )
    .limit(1)
    .then((r) => r[0] ?? null);

  assert.equal(
    evidenceViaGlossaryFilter,
    null,
    "normal evidence doc (evidenceEligible=true, discoveredVia='manual_url') must be excluded " +
      "by the searchGlossaryConcepts predicates " +
      "'discovered_via=glossary_concept AND evidence_eligible=false' — if this fails real " +
      "sources could appear in the concept-memory lane",
  );

  // ── Positive controls: verify both docs are individually readable ──────────
  // Sanity-check that our WHERE clauses above are correctly constraining (not
  // accidentally hiding both docs due to a bad query).
  const glossaryExists = await db
    .select({ evidenceEligible: sourceDocumentsTable.evidenceEligible })
    .from(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.url, glossaryUrl))
    .limit(1)
    .then((r) => r[0] ?? null);
  assert.ok(glossaryExists, "glossary doc must exist in the DB (positive control)");
  assert.equal(glossaryExists.evidenceEligible, false, "glossary doc positive control: evidenceEligible=false");

  const evidenceExists = await db
    .select({ evidenceEligible: sourceDocumentsTable.evidenceEligible })
    .from(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.url, EVIDENCE_DOC_URL))
    .limit(1)
    .then((r) => r[0] ?? null);
  assert.ok(evidenceExists, "evidence doc must exist in the DB (positive control)");
  assert.equal(evidenceExists.evidenceEligible, true, "evidence doc positive control: evidenceEligible=true");
});

test("semanticSearch never returns a glossary doc; searchGlossaryConcepts never returns an evidence doc (production function calls)", async (t) => {
  // This test calls the actual production functions — not mirrored SQL — so a
  // WHERE clause regression in sourceVault.ts is caught by this test failing.
  //
  // Strategy: embed a test phrase, insert matching source_chunks for BOTH docs
  // with the exact same vector (cosine similarity = 1.0). That guarantees both
  // docs WOULD be returned if the filter were absent — and that the exclusion
  // is the filter, not random similarity ranking.

  if (!isEmbeddingConfigured()) {
    t.skip("embedding provider not configured — production function-call test skipped");
    return;
  }

  // Ensure the glossary vault doc exists and is active.
  await syncConceptToVault(testConceptId);
  const glossaryUrl = glossaryPseudoUrl(testConceptId);

  const glossaryDoc = await db
    .select({ id: sourceDocumentsTable.id })
    .from(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.url, glossaryUrl))
    .limit(1)
    .then((r) => r[0]);
  assert.ok(glossaryDoc, "glossary vault doc must exist before function-call test");

  const evidenceDoc = await db
    .select({ id: sourceDocumentsTable.id })
    .from(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.url, EVIDENCE_DOC_URL))
    .limit(1)
    .then((r) => r[0]);
  assert.ok(evidenceDoc, "evidence doc must exist before function-call test");

  // A highly specific phrase to minimize false-positive hits from the real vault.
  const LANE_SEP_PHRASE = `brainhook gvault lane sep unique ${testConceptId}`;
  const { vectors, provider, model, dimensions } = await embedTexts([LANE_SEP_PHRASE]);
  const testVec = vectors[0]!;
  assert.ok(testVec && testVec.length > 0, "embedTexts must return a non-empty vector");

  try {
    // Insert identical chunks for both docs so both would rank at the top of a
    // similarity search — the only thing keeping the glossary doc out of
    // semanticSearch and the evidence doc out of searchGlossaryConcepts is the
    // WHERE clause filter on evidence_eligible / discovered_via.
    await db.delete(sourceChunksTable).where(eq(sourceChunksTable.documentId, glossaryDoc.id));
    await db.delete(sourceChunksTable).where(eq(sourceChunksTable.documentId, evidenceDoc.id));

    await db.insert(sourceChunksTable).values([
      {
        documentId: glossaryDoc.id,
        chunkIndex: 0,
        content: LANE_SEP_PHRASE,
        contentHash: createHash("sha256").update(`${LANE_SEP_PHRASE}-g`).digest("hex"),
        charCount: LANE_SEP_PHRASE.length,
        embedding: testVec,
        embeddingProvider: provider,
        embeddingModel: model,
        dimensions,
      },
      {
        documentId: evidenceDoc.id,
        chunkIndex: 0,
        content: LANE_SEP_PHRASE,
        contentHash: createHash("sha256").update(`${LANE_SEP_PHRASE}-e`).digest("hex"),
        charCount: LANE_SEP_PHRASE.length,
        embedding: testVec,
        embeddingProvider: provider,
        embeddingModel: model,
        dimensions,
      },
    ]);

    // Lift the glossary doc to status='embedded' so it participates in both
    // retrieval paths. Without this it would be excluded by status='extracted',
    // masking a regression in the evidence_eligible / discovered_via filter.
    await db
      .update(sourceDocumentsTable)
      .set({ status: "embedded" })
      .where(eq(sourceDocumentsTable.id, glossaryDoc.id));

    // ── semanticSearch: glossary doc MUST be absent ─────────────────────────
    // If the `AND d."evidence_eligible" IS DISTINCT FROM false` predicate were
    // removed from semanticSearch, the glossary doc would appear here.
    const semanticHits = await semanticSearch(LANE_SEP_PHRASE, { limit: 50 });
    const semanticUrls = new Set(semanticHits.map((h) => h.document.url));

    assert.ok(
      !semanticUrls.has(glossaryUrl),
      `semanticSearch must not return the glossary doc. ` +
        `This means the 'evidence_eligible IS DISTINCT FROM false' WHERE clause ` +
        `has been removed or broken in sourceVault.ts#semanticSearch. ` +
        `glossaryUrl=${glossaryUrl} — returned: ${[...semanticUrls].join(", ")}`,
    );
    // Positive control: the evidence doc MUST appear (confirms the query ran and
    // the evidence lane is open — rules out a totally empty result as a false pass).
    assert.ok(
      semanticUrls.has(EVIDENCE_DOC_URL),
      `semanticSearch must return the evidence doc (positive control: evidence lane is open). ` +
        `evidenceUrl=${EVIDENCE_DOC_URL} — returned: ${[...semanticUrls].join(", ")}`,
    );

    // ── searchGlossaryConcepts: evidence doc MUST be absent ─────────────────
    // If the `AND d."discovered_via" = 'glossary_concept' AND d."evidence_eligible" = false`
    // predicates were removed from searchGlossaryConcepts, the evidence doc would appear.
    const glossaryHits = await searchGlossaryConcepts(LANE_SEP_PHRASE, { limit: 50 });
    const glossaryUrls = new Set(glossaryHits.map((h) => h.document.url));

    assert.ok(
      !glossaryUrls.has(EVIDENCE_DOC_URL),
      `searchGlossaryConcepts must not return the evidence doc. ` +
        `This means the 'discovered_via=glossary_concept AND evidence_eligible=false' ` +
        `WHERE clause has been broken in sourceVault.ts#searchGlossaryConcepts. ` +
        `evidenceUrl=${EVIDENCE_DOC_URL} — returned: ${[...glossaryUrls].join(", ")}`,
    );
    // Positive control: the glossary doc MUST appear.
    assert.ok(
      glossaryUrls.has(glossaryUrl),
      `searchGlossaryConcepts must return the glossary doc (positive control: glossary lane is open). ` +
        `glossaryUrl=${glossaryUrl} — returned: ${[...glossaryUrls].join(", ")}`,
    );
  } finally {
    // Remove test chunks; documents themselves are cleaned in after().
    await db.delete(sourceChunksTable).where(eq(sourceChunksTable.documentId, glossaryDoc.id));
    await db.delete(sourceChunksTable).where(eq(sourceChunksTable.documentId, evidenceDoc.id));
    // Restore glossary doc to extracted status (set by syncConceptToVault).
    await db
      .update(sourceDocumentsTable)
      .set({ status: "extracted" })
      .where(eq(sourceDocumentsTable.id, glossaryDoc.id));
  }
});

test("findCanonicalDuplicate finds a match outside newest-N concepts (full registry, no cap)", async () => {
  // Regression test for the removal of the fixed 60-row limit in canonical dedup.
  // Inserts an "old" canonical concept FIRST, then inserts several newer unrelated
  // decoys to simulate a larger registry, then verifies the old concept is found.
  const uniqueKey = `test${Date.now()}`;

  const [oldConcept] = await db
    .insert(conceptsTable)
    .values({
      slug: `zz-dedup-old-${uniqueKey}`,
      term: `Maladaptive Coping ${uniqueKey}`,
      definition: `A test canonical concept for dedup regression.`,
      hoverDefinition: `Unhealthy coping strategies that worsen distress over time.`,
      status: "live",
      definitionConfidence: 0.9,
    })
    .returning({ id: conceptsTable.id });
  assert.ok(oldConcept, "old concept should be inserted");

  const decoyIds: string[] = [];
  try {
    for (let i = 0; i < 5; i++) {
      const [decoy] = await db
        .insert(conceptsTable)
        .values({
          slug: `zz-dedup-decoy-${uniqueKey}-${i}`,
          term: `UnrelatedDecoyX${uniqueKey}N${i}`,
          definition: `Decoy concept for dedup test.`,
          hoverDefinition: `This is a decoy concept for testing purposes.`,
          status: "live",
          definitionConfidence: 0.9,
        })
        .returning({ id: conceptsTable.id });
      decoyIds.push(decoy.id);
    }

    // Search for a near-duplicate of the old concept:
    // "Maladaptive Coping Strategies {uniqueKey}" shares key tokens with
    // "Maladaptive Coping {uniqueKey}" — the ILIKE filter must surface the
    // old concept even though 5 newer concepts exist in the registry.
    const result = await findCanonicalDuplicate(
      `Maladaptive Coping Strategies ${uniqueKey}`,
      `Maladaptive coping strategies include avoidance and rumination.`,
    );

    assert.ok(result, "should find the old canonical concept, not miss it due to a registry cap");
    assert.equal(
      result.id,
      oldConcept.id,
      "matched concept must be the old canonical entry, not a decoy",
    );
    // Mirror the module-level CANONICAL_MERGE_THRESHOLD = 0.60
    assert.ok(
      result.similarity >= 0.60,
      `similarity must be >= merge threshold (0.60), got ${result.similarity}`,
    );
  } finally {
    await db.delete(conceptsTable).where(eq(conceptsTable.slug, `zz-dedup-old-${uniqueKey}`));
    if (decoyIds.length > 0) {
      await db.delete(conceptsTable).where(inArray(conceptsTable.id, decoyIds));
    }
  }
});

test("INSERT path: syncConceptToVault sets evidence_eligible=false on the first-ever insert (action=created)", async () => {
  // ── Why this test exists ─────────────────────────────────────────────────
  // syncConceptToVault uses a single UPSERT. When the row is BRAND NEW the
  // INSERT branch fires; when the row already exists the ON CONFLICT UPDATE
  // branch fires. Both branches explicitly set evidenceEligible=false, but
  // the existing "creates a vault doc with evidenceEligible=false" test allows
  // action=created|updated — so it does not strictly lock the INSERT path.
  //
  // This test uses a FRESH concept (its own isolated row, pre-cleaned) so
  // the UPSERT is guaranteed to take the INSERT path (action="created"), and
  // immediately reads the DB row to assert evidenceEligible=false was set
  // by the INSERT, not by any subsequent UPDATE.
  //
  // If evidenceEligible=false were accidentally removed from the INSERT values
  // in syncConceptToVault, the column default (DEFAULT true) would fire and
  // the glossary doc would enter the evidence retrieval lane — this test
  // catches that regression directly.
  // ────────────────────────────────────────────────────────────────────────

  const FRESH_SLUG = `zz-gvault-insert-path-${Date.now()}`;
  let freshConceptId: string | null = null;
  try {
    const [inserted] = await db
      .insert(conceptsTable)
      .values({
        slug: FRESH_SLUG,
        term: `GVaultInsertPathTest${Date.now()}`,
        definition: "Isolated concept for INSERT-path evidence_eligible regression guard.",
        hoverDefinition: "INSERT-path test hover.",
        status: "live",
        definitionConfidence: 0.9,
      })
      .returning({ id: conceptsTable.id });
    assert.ok(inserted, "fresh test concept must be inserted");
    freshConceptId = inserted.id;

    // Guarantee no prior vault doc exists so the UPSERT takes the INSERT path.
    await db
      .delete(sourceDocumentsTable)
      .where(eq(sourceDocumentsTable.url, glossaryPseudoUrl(freshConceptId)));

    const result = await syncConceptToVault(freshConceptId);
    assert.ok(result.ok, `sync must succeed, got action=${result.action}`);
    // ── INSERT-path invariant ────────────────────────────────────────────
    // action MUST be "created" (not "updated" or "skipped") to confirm the
    // UPSERT took the INSERT branch. If this fails the pre-cleanup above
    // did not run correctly.
    assert.equal(
      result.action,
      "created",
      "action must be 'created' — this test requires a fresh concept with no prior vault doc",
    );

    const doc = await db
      .select({ evidenceEligible: sourceDocumentsTable.evidenceEligible })
      .from(sourceDocumentsTable)
      .where(eq(sourceDocumentsTable.url, glossaryPseudoUrl(freshConceptId)))
      .limit(1)
      .then((r) => r[0] ?? null);

    assert.ok(doc, "vault doc must exist immediately after INSERT-path sync");
    // ── Core assertion ───────────────────────────────────────────────────
    // The newly inserted glossary doc MUST have evidenceEligible=false.
    // The column default is true (DEFAULT true), so if this value were ever
    // omitted from the INSERT values in syncConceptToVault the row would be
    // inserted as true and appear in the standard evidence retrieval lane.
    assert.equal(
      doc.evidenceEligible,
      false,
      "evidenceEligible must be false immediately after INSERT — " +
        "if this fails the explicit evidenceEligible=false was lost from the " +
        "syncConceptToVault INSERT values and the column default (true) fired",
    );
  } finally {
    if (freshConceptId) {
      await db
        .delete(sourceDocumentsTable)
        .where(eq(sourceDocumentsTable.url, glossaryPseudoUrl(freshConceptId)));
      await db.delete(conceptsTable).where(eq(conceptsTable.id, freshConceptId));
    }
  }
});

test("schema-default regression guard: evidence_eligible column default is true — glossary sync must set false explicitly", async () => {
  // ── Why this test exists ─────────────────────────────────────────────────
  // The evidence_eligible column has DEFAULT true in the schema. This test
  // inserts a source_documents row WITHOUT specifying evidenceEligible and
  // asserts the DB-level default is true (not false).
  //
  // This catches a schema migration that accidentally flips DEFAULT true →
  // DEFAULT false on this column. Such a change would:
  //   a) Cause ALL newly inserted source documents to be evidence-ineligible
  //      by default, silently excluding fresh ingests from evidence retrieval.
  //   b) Mask any future omission of the explicit `evidenceEligible: false`
  //      in syncConceptToVault — the wrong default would produce the "right"
  //      value for the glossary lane, hiding the missing explicit set.
  //
  // This assertion is independent of syncConceptToVault's logic: it tests
  // the schema column definition itself.
  // ────────────────────────────────────────────────────────────────────────

  const RAW_DEFAULT_URL = `https://zz-schema-default-check-${Date.now()}.example.com/raw`;
  try {
    // Insert WITHOUT specifying evidenceEligible — the row gets the DB default.
    await db.insert(sourceDocumentsTable).values({
      url: RAW_DEFAULT_URL,
      domain: "zz-schema-default-check.example.com",
      title: "Schema default regression check",
      extractedText: "Placeholder for schema-default regression guard.",
      status: "extracted",
      lifecycleStatus: "active",
      // evidenceEligible intentionally omitted — relying on the DB column default.
    });

    const row = await db
      .select({ evidenceEligible: sourceDocumentsTable.evidenceEligible })
      .from(sourceDocumentsTable)
      .where(eq(sourceDocumentsTable.url, RAW_DEFAULT_URL))
      .limit(1)
      .then((r) => r[0] ?? null);

    assert.ok(row, "inserted row must exist");
    // ── Schema-default assertion ─────────────────────────────────────────
    // The column default MUST be true. If this assertion fails, a migration
    // changed DEFAULT true → DEFAULT false and both evidence ingestion (all
    // new docs ineligible) and the glossary sync (masked missing explicit
    // false) must be audited immediately.
    assert.equal(
      row.evidenceEligible,
      true,
      "evidence_eligible column default must be true — if this fails a migration flipped the " +
        "default and the sync logic + evidence ingestion path must be audited",
    );
  } finally {
    await db.delete(sourceDocumentsTable).where(eq(sourceDocumentsTable.url, RAW_DEFAULT_URL));
  }
});

test("schema-default regression guard: discovered_via column default is 'manual_url' — glossary docs cannot enter concept-memory lane via omission", async () => {
  // ── Why this test exists ─────────────────────────────────────────────────
  // searchGlossaryConcepts gates its SQL filter on:
  //   AND d."discovered_via" = 'glossary_concept'
  //   AND d."evidence_eligible" = false
  //
  // This gate only works correctly if the DB-level column default for
  // discovered_via is 'manual_url' (the safe value). If a migration
  // accidentally changed that default to 'glossary_concept', any freshly
  // ingested evidence document that omitted the discoveredVia field would
  // silently receive discovered_via='glossary_concept' and pass the
  // searchGlossaryConcepts WHERE clause — entering the concept-memory lane
  // as if it were glossary context, never as citable evidence.
  //
  // This test is intentionally INDEPENDENT of syncConceptToVault: it tests
  // the raw schema column default so that a migration regression is caught
  // without relying on the sync code path.
  //
  // Related: the evidenceEligible column default (must be true, tested
  // separately below) and discoveredVia both need the correct defaults to
  // keep the two lanes separated.
  // ────────────────────────────────────────────────────────────────────────

  const DISCOVERED_VIA_DEFAULT_URL = `https://zz-discovered-via-default-${Date.now()}.example.com/raw`;
  try {
    // Insert WITHOUT specifying discoveredVia — the row must receive the DB default.
    await db.insert(sourceDocumentsTable).values({
      url: DISCOVERED_VIA_DEFAULT_URL,
      domain: "zz-discovered-via-default.example.com",
      title: "discoveredVia schema-default regression check",
      extractedText: "Placeholder for discovered_via column default regression guard.",
      status: "extracted",
      lifecycleStatus: "active",
      // discoveredVia intentionally omitted — relying solely on the DB column default.
      // If the default were 'glossary_concept' this row would pass the
      // searchGlossaryConcepts WHERE clause and enter the concept-memory lane.
    });

    const row = await db
      .select({
        discoveredVia: sourceDocumentsTable.discoveredVia,
        evidenceEligible: sourceDocumentsTable.evidenceEligible,
      })
      .from(sourceDocumentsTable)
      .where(eq(sourceDocumentsTable.url, DISCOVERED_VIA_DEFAULT_URL))
      .limit(1)
      .then((r) => r[0] ?? null);

    assert.ok(row, "inserted row must exist");

    // ── Schema-default assertion: discoveredVia ─────────────────────────
    // The discovered_via column default MUST be 'manual_url'.
    // If this assertion fails, a migration changed DEFAULT 'manual_url' →
    // DEFAULT 'glossary_concept' (or some other non-safe value). That means:
    //   a) Any freshly ingested evidence document that omits discoveredVia
    //      would silently receive discovered_via='glossary_concept'.
    //   b) Such a document would pass searchGlossaryConcepts' WHERE clause
    //      and appear in concept-memory context during drafting — it would
    //      never be citable as evidence (evidenceEligible would need to be
    //      false too, but the default mismatch alone is a schema regression).
    // Fix: revert the column default to 'manual_url' in the migration and
    // update ensureRuntimeTables in services/seed.ts to match.
    assert.equal(
      row.discoveredVia,
      "manual_url",
      "discovered_via column default must be 'manual_url' — if this fails a migration " +
        "changed the default away from 'manual_url' and evidence docs could silently " +
        "enter the glossary concept-memory lane when discoveredVia is omitted on insert",
    );

    // ── Secondary check: the row must NOT match searchGlossaryConcepts' WHERE ──
    // Verify that this row does not satisfy the combined lane-gate predicate
    //   (discovered_via = 'glossary_concept' AND evidence_eligible = false).
    // This catches the joint failure: if the discoveredVia default were
    // 'glossary_concept' AND evidenceEligible default were false simultaneously,
    // the row would pass both sub-predicates and enter the concept-memory lane.
    // Note: the primary assertion above independently tests discoveredVia alone,
    // and the sibling schema-default test covers evidenceEligible alone — this
    // query only catches the combined condition where BOTH defaults are wrong.
    const wouldEnterGlossaryLane = await db
      .select({ url: sourceDocumentsTable.url })
      .from(sourceDocumentsTable)
      .where(
        and(
          eq(sourceDocumentsTable.url, DISCOVERED_VIA_DEFAULT_URL),
          eq(sourceDocumentsTable.discoveredVia, "glossary_concept"),
          eq(sourceDocumentsTable.evidenceEligible, false),
        ),
      )
      .limit(1)
      .then((r) => r[0] ?? null);

    assert.equal(
      wouldEnterGlossaryLane,
      null,
      "a row inserted without explicit discoveredVia must not satisfy the " +
        "searchGlossaryConcepts predicate " +
        "'discovered_via=glossary_concept AND evidence_eligible=false' — " +
        "if this fails the column defaults have drifted and a fresh evidence " +
        "document could silently enter the concept-memory lane",
    );
  } finally {
    await db
      .delete(sourceDocumentsTable)
      .where(eq(sourceDocumentsTable.url, DISCOVERED_VIA_DEFAULT_URL));
  }
});

test("deactivateConceptVaultDoc deactivates a vault doc for a deleted concept", async () => {
  // Ensure the doc exists and is active.
  await syncConceptToVault(testConceptId);

  const beforeDelete = await db
    .select({ lifecycleStatus: sourceDocumentsTable.lifecycleStatus })
    .from(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.url, glossaryPseudoUrl(testConceptId)))
    .limit(1)
    .then((r) => r[0]);
  assert.equal(beforeDelete?.lifecycleStatus, "active", "doc should be active before deletion");

  // Simulate deletion: call deactivateConceptVaultDoc directly (as the delete route does).
  const { deactivateConceptVaultDoc } = await import("./glossaryVaultSync");
  await deactivateConceptVaultDoc(testConceptId);

  const afterDeactivate = await db
    .select({ lifecycleStatus: sourceDocumentsTable.lifecycleStatus })
    .from(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.url, glossaryPseudoUrl(testConceptId)))
    .limit(1)
    .then((r) => r[0]);

  // ── Loop-safety invariant #6 ─────────────────────────────────────────────
  // A deleted concept's vault doc must be immediately deactivated so it cannot
  // be returned from the glossary lane (which filters lifecycleStatus='active').
  assert.equal(
    afterDeactivate?.lifecycleStatus,
    "unavailable",
    "deleted concept vault doc must be unavailable (loop-safety)",
  );

  // Restore for subsequent tests.
  await db
    .update(sourceDocumentsTable)
    .set({ lifecycleStatus: "active" })
    .where(eq(sourceDocumentsTable.url, glossaryPseudoUrl(testConceptId)));
});

// ---------------------------------------------------------------------------
// reconcileGlossaryVault() end-to-end: all four outcomes in one pass
// ---------------------------------------------------------------------------
//
// Seeds an isolated set of concepts and vault docs that cover every branch
// reconcileGlossaryVault() can take:
//
//   "create"  — a live concept with no prior vault doc (Pass 1 INSERT path)
//   "update"  — a live concept whose vault doc already exists but has a
//               stale content hash (Pass 1 UPDATE path)
//   "skip"    — a live concept whose vault doc exists and is current (Pass 1
//               no-op path)
//   "deact"   — a hidden concept with an active vault doc (Pass 2 bulk
//               deactivation path)
//   "orphan"  — an active vault doc whose concept has been hard-deleted from
//               conceptsTable (Pass 3 orphan cleanup path)
//
// After reconcileGlossaryVault() the test asserts:
//   - synced  >= 2  (create + update both count as synced)
//   - skipped >= 1
//   - deactivated >= 1
//   - orphaned >= 1
//   - failed  == 0
//   - DB state matches for each seeded row
//
// Uses slug prefixes beginning with "zz-reconcile-" for safe cleanup.
// ---------------------------------------------------------------------------

test("reconcileGlossaryVault completes all three passes without errors: create / update / skip / deactivate / orphan", async () => {
  const KEY = `${Date.now()}`;
  const slugPrefix = `zz-reconcile-${KEY}`;

  // ── Seed ────────────────────────────────────────────────────────────────

  // 1. "create" concept — live, no prior vault doc.
  const [createConcept] = await db
    .insert(conceptsTable)
    .values({
      slug: `${slugPrefix}-create`,
      term: `ReconcileCreate${KEY}`,
      definition: "Reconcile test — create branch.",
      hoverDefinition: "Create hover.",
      status: "live",
      definitionConfidence: 0.9,
    })
    .returning({ id: conceptsTable.id });
  assert.ok(createConcept, "create concept must be inserted");
  // Ensure no stale vault doc exists.
  await db
    .delete(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.url, glossaryPseudoUrl(createConcept.id)));

  // 2. "update" concept — live, vault doc exists with a deliberately wrong
  //    content hash so the reconciler treats it as stale and updates it.
  const [updateConcept] = await db
    .insert(conceptsTable)
    .values({
      slug: `${slugPrefix}-update`,
      term: `ReconcileUpdate${KEY}`,
      definition: "Reconcile test — update branch.",
      hoverDefinition: "Update hover.",
      status: "live",
      definitionConfidence: 0.8,
    })
    .returning({ id: conceptsTable.id });
  assert.ok(updateConcept, "update concept must be inserted");
  await db
    .delete(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.url, glossaryPseudoUrl(updateConcept.id)));
  await db.insert(sourceDocumentsTable).values({
    url: glossaryPseudoUrl(updateConcept.id),
    domain: "brainhook.internal",
    title: `Glossary: ReconcileUpdate${KEY}`,
    discoveredVia: "glossary_concept",
    extractedText: "stale text",
    wordCount: 2,
    // Deliberately wrong hash — forces the reconciler to take the UPDATE path.
    contentHash: "stale-hash-will-not-match",
    qualityScore: 100,
    qualityFlags: [],
    status: "extracted",
    extractionMethod: "glossary_sync",
    fetchedAt: new Date(),
    fetchAllowed: false,
    doNotRefetch: true,
    authorityTier: "reference",
    authoritySource: "manual",
    authorityReason: "internal BrainHook glossary concept",
    lifecycleStatus: "active",
    evidenceEligible: false,
  });

  // 3. "skip" concept — live, vault doc already has the correct hash (will be
  //    pre-synced so the reconciler skips it on the second pass).
  const [skipConcept] = await db
    .insert(conceptsTable)
    .values({
      slug: `${slugPrefix}-skip`,
      term: `ReconcileSkip${KEY}`,
      definition: "Reconcile test — skip branch.",
      hoverDefinition: "Skip hover.",
      status: "live",
      definitionConfidence: 0.7,
    })
    .returning({ id: conceptsTable.id });
  assert.ok(skipConcept, "skip concept must be inserted");
  // Pre-sync so the vault doc is up to date; reconciler should skip it.
  await syncConceptToVault(skipConcept.id);

  // 4. "deact" concept — hidden with an existing active vault doc (Pass 2).
  const [deactConcept] = await db
    .insert(conceptsTable)
    .values({
      slug: `${slugPrefix}-deact`,
      term: `ReconcileDeact${KEY}`,
      definition: "Reconcile test — deactivate branch.",
      hoverDefinition: "Deact hover.",
      // Start live so we can pre-sync an active vault doc, then hide it.
      status: "live",
      definitionConfidence: 0.6,
    })
    .returning({ id: conceptsTable.id });
  assert.ok(deactConcept, "deact concept must be inserted");
  await syncConceptToVault(deactConcept.id);
  // Now hide the concept — the reconciler's Pass 2 must deactivate the doc.
  await db
    .update(conceptsTable)
    .set({ status: "hidden" })
    .where(eq(conceptsTable.id, deactConcept.id));

  // 5. "orphan" vault doc — active glossary doc whose concept has been
  //    hard-deleted, so the reconciler's Pass 3 must deactivate it.
  const [orphanConcept] = await db
    .insert(conceptsTable)
    .values({
      slug: `${slugPrefix}-orphan`,
      term: `ReconcileOrphan${KEY}`,
      definition: "Reconcile test — orphan branch.",
      hoverDefinition: "Orphan hover.",
      status: "live",
      definitionConfidence: 0.5,
    })
    .returning({ id: conceptsTable.id });
  assert.ok(orphanConcept, "orphan concept must be inserted");
  await syncConceptToVault(orphanConcept.id);
  // Hard-delete the concept row so the vault doc becomes orphaned.
  await db.delete(conceptsTable).where(eq(conceptsTable.id, orphanConcept.id));

  // ── Run the full reconcile ───────────────────────────────────────────────
  let result: Awaited<ReturnType<typeof reconcileGlossaryVault>>;
  try {
    result = await reconcileGlossaryVault();
  } catch (err) {
    assert.fail(`reconcileGlossaryVault() must not throw; got: ${err}`);
  }

  // ── Assert result counts ─────────────────────────────────────────────────
  // The reconcile touches ALL concepts in the DB, not just our test set, so
  // we use >= rather than exact equality.
  assert.equal(result.failed, 0, `reconcile must report 0 failures, got ${result.failed}`);
  assert.ok(
    result.synced >= 2,
    `synced must be >= 2 (create + update branch), got ${result.synced}`,
  );
  assert.ok(result.skipped >= 1, `skipped must be >= 1 (skip branch), got ${result.skipped}`);
  assert.ok(
    result.deactivated >= 1,
    `deactivated must be >= 1 (hidden concept deact branch), got ${result.deactivated}`,
  );
  assert.ok(
    result.orphaned >= 1,
    `orphaned must be >= 1 (orphan cleanup Pass 3), got ${result.orphaned}`,
  );

  // ── Assert DB state for each seeded concept ──────────────────────────────

  // "create" → vault doc must now exist and be active with evidenceEligible=false.
  const createDoc = await db
    .select({
      lifecycleStatus: sourceDocumentsTable.lifecycleStatus,
      evidenceEligible: sourceDocumentsTable.evidenceEligible,
      discoveredVia: sourceDocumentsTable.discoveredVia,
    })
    .from(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.url, glossaryPseudoUrl(createConcept.id)))
    .limit(1)
    .then((r) => r[0] ?? null);
  assert.ok(createDoc, "create branch: vault doc must exist after reconcile");
  assert.equal(createDoc.lifecycleStatus, "active", "create branch: lifecycleStatus must be active");
  assert.equal(createDoc.evidenceEligible, false, "create branch: evidenceEligible must be false");
  assert.equal(createDoc.discoveredVia, "glossary_concept", "create branch: discoveredVia must be glossary_concept");

  // "update" → vault doc must exist and its content hash must no longer be the stale value.
  const updateDoc = await db
    .select({ contentHash: sourceDocumentsTable.contentHash, lifecycleStatus: sourceDocumentsTable.lifecycleStatus })
    .from(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.url, glossaryPseudoUrl(updateConcept.id)))
    .limit(1)
    .then((r) => r[0] ?? null);
  assert.ok(updateDoc, "update branch: vault doc must exist after reconcile");
  assert.notEqual(
    updateDoc.contentHash,
    "stale-hash-will-not-match",
    "update branch: stale content hash must have been replaced by reconcile",
  );
  assert.equal(updateDoc.lifecycleStatus, "active", "update branch: lifecycleStatus must be active");

  // "skip" → vault doc must still be active (unchanged).
  const skipDoc = await db
    .select({ lifecycleStatus: sourceDocumentsTable.lifecycleStatus })
    .from(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.url, glossaryPseudoUrl(skipConcept.id)))
    .limit(1)
    .then((r) => r[0] ?? null);
  assert.ok(skipDoc, "skip branch: vault doc must still exist after reconcile");
  assert.equal(skipDoc.lifecycleStatus, "active", "skip branch: lifecycleStatus must remain active");

  // "deact" → Pass 2 must have set the vault doc to unavailable.
  const deactDoc = await db
    .select({ lifecycleStatus: sourceDocumentsTable.lifecycleStatus })
    .from(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.url, glossaryPseudoUrl(deactConcept.id)))
    .limit(1)
    .then((r) => r[0] ?? null);
  assert.ok(deactDoc, "deact branch: vault doc must still exist (not deleted) after Pass 2");
  assert.equal(
    deactDoc.lifecycleStatus,
    "unavailable",
    "deact branch: hidden concept vault doc must be unavailable after Pass 2",
  );

  // "orphan" → Pass 3 must have set the vault doc to unavailable.
  const orphanDoc = await db
    .select({ lifecycleStatus: sourceDocumentsTable.lifecycleStatus })
    .from(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.url, glossaryPseudoUrl(orphanConcept.id)))
    .limit(1)
    .then((r) => r[0] ?? null);
  assert.ok(orphanDoc, "orphan branch: vault doc must still exist (not deleted) after Pass 3");
  assert.equal(
    orphanDoc.lifecycleStatus,
    "unavailable",
    "orphan branch: deleted concept vault doc must be unavailable after Pass 3",
  );

  // ── Cleanup ──────────────────────────────────────────────────────────────
  const allConceptIds = [createConcept.id, updateConcept.id, skipConcept.id, deactConcept.id];
  const orphanUrl = glossaryPseudoUrl(orphanConcept.id);

  for (const id of allConceptIds) {
    await db.delete(sourceDocumentsTable).where(eq(sourceDocumentsTable.url, glossaryPseudoUrl(id)));
  }
  await db.delete(sourceDocumentsTable).where(eq(sourceDocumentsTable.url, orphanUrl));

  // orphanConcept row was already hard-deleted above; skip those.
  await db.delete(conceptsTable).where(inArray(conceptsTable.id, allConceptIds));
});

test("source_ingest_queue.discovered_via DB default is 'manual_url' (schema regression guard)", async () => {
  // Pure schema assertion: insert a queue row without specifying discoveredVia
  // and confirm the DB-level column default is 'manual_url', NOT 'glossary_concept'.
  //
  // A migration that accidentally flips the default to 'glossary_concept' would
  // cause every manually enqueued URL that omits discoveredVia to carry that value
  // forward into the ingested source_documents row (the queue value is copied on
  // ingest), silently routing normal sources into the concept lane. The existing
  // schema-default tests above only cover source_documents; this test covers the
  // queue table's parallel column.
  const TEST_QUEUE_URL = `https://zz-gvault-queue-default-test-${Date.now()}.example.com/`;

  await db.delete(sourceIngestQueueTable).where(eq(sourceIngestQueueTable.url, TEST_QUEUE_URL));

  try {
    const [row] = await db
      .insert(sourceIngestQueueTable)
      .values({ url: TEST_QUEUE_URL })
      .returning({ discoveredVia: sourceIngestQueueTable.discoveredVia });

    assert.ok(row, "queue row must be inserted without specifying discoveredVia");
    assert.equal(
      row.discoveredVia,
      "manual_url",
      "source_ingest_queue.discovered_via DB default must be 'manual_url', not 'glossary_concept' — " +
        "a wrong default lets every omitted-discoveredVia enqueue carry 'glossary_concept' into " +
        "the ingested source_documents row, routing normal sources into the concept lane",
    );
  } finally {
    await db.delete(sourceIngestQueueTable).where(eq(sourceIngestQueueTable.url, TEST_QUEUE_URL));
  }
});

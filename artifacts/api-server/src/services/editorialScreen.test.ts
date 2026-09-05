import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  db,
  storyClustersTable,
  sourceDocumentsTable,
  evidencePacketsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { buildEvidencePacket, shouldQuarantineReport } from "./editorialScreen";
import { stripInternalArticleLinks, isInternalLinkFinding } from "./verificationText";
import type { EditorialScreenResult } from "./llm";

// Concurrency regression for evidence-packet version allocation (Task #211).
//
// Packet versions are NOT gated by a DB lock: buildEvidencePacket reads the
// current max version and inserts (max + 1), relying on the unique(cluster_id,
// version) index (SQLSTATE 23505) plus a recompute-and-retry loop to stay
// correct when two screenings race (manual /screen + cron overlap, or an admin
// double-click). This test fires many concurrent buildEvidencePacket calls for
// ONE cluster and proves the invariants hold: no call throws (no 500s), every
// version is unique + monotonic (1..N), and exactly one packet exists per call.
//
// The editorial-screen model call is INJECTED (opts.screen) so the test is
// deterministic and makes no network/model call — the REAL version-allocation
// and unique-constraint retry loop is what's under test. Runs against the
// dev/test Postgres pointed to by DATABASE_URL (same style as jobState.test.ts).

const CLUSTER_LABEL = "zz-editorial-screen-concurrency-test";
let clusterId: string;

// A fake editorial-screen result that yields a valid, minimal packet. Async so
// concurrent callers interleave (each awaits before the insert race).
const fakeScreen = async (): Promise<EditorialScreenResult> => {
  await new Promise((r) => setTimeout(r, 5));
  return {
    decision: "approve_draft",
    reasons: ["Deterministic test decision."],
    doNotDraftReason: null,
    claims: [],
    contradictions: [],
    quoteCandidates: [],
    model: "test-fake-screen",
  };
};

async function cleanup(): Promise<void> {
  await db.delete(evidencePacketsTable).where(eq(evidencePacketsTable.clusterId, clusterId ?? ""));
  await db.delete(sourceDocumentsTable).where(eq(sourceDocumentsTable.clusterId, clusterId ?? ""));
  if (clusterId) {
    await db.delete(storyClustersTable).where(eq(storyClustersTable.id, clusterId));
  }
}

before(async () => {
  const [cluster] = await db
    .insert(storyClustersTable)
    .values({
      beatSlug: "zz-editorial-screen-beat",
      beat: "ZZ Editorial Screen Beat",
      label: CLUSTER_LABEL,
      keywords: ["concurrency", "packet", "version"],
      status: "active",
      coverageStatus: "open",
      score: 50,
    })
    .returning();
  clusterId = cluster!.id;

  // One qualified source document so buildEvidencePacket clears its 422 gate.
  await db.insert(sourceDocumentsTable).values({
    url: "https://example.com/zz-editorial-screen-source",
    domain: "example.com",
    title: "A test source for the editorial-screen concurrency test.",
    excerpt: "Deterministic body text for the screen input.",
    extractedText: "Deterministic body text for the screen input.",
    authorityTier: "primary",
    lifecycleStatus: "active",
    beatSlug: "zz-editorial-screen-beat",
    clusterId,
  });
});

after(async () => {
  await cleanup();
});

test("concurrent screenings never fail and never duplicate a version", async () => {
  const N = 8;

  // Fire N buildEvidencePacket calls at once for the SAME cluster. None may
  // reject: a duplicate-version collision must be absorbed by the retry loop,
  // not surfaced as an error.
  const results = await Promise.allSettled(
    Array.from({ length: N }, () =>
      buildEvidencePacket(clusterId, { research: "vault_only", screen: fakeScreen }),
    ),
  );

  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(
    rejected.length,
    0,
    `no concurrent screening may throw; got ${rejected.length} rejection(s): ${rejected
      .map((r) => (r as PromiseRejectedResult).reason?.message ?? String((r as PromiseRejectedResult).reason))
      .join(" | ")}`,
  );

  const fulfilled = results.filter(
    (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof buildEvidencePacket>>> =>
      r.status === "fulfilled",
  );
  assert.equal(fulfilled.length, N, "every call must resolve with a packet");

  // Each successful call must have created exactly one fresh version.
  for (const r of fulfilled) {
    assert.equal(r.value.created, true, "each manual screen creates a new version");
  }

  // The versions the calls received must be exactly {1..N}: unique + monotonic,
  // no gaps, no duplicates.
  const returnedVersions = fulfilled.map((r) => r.value.packet.version).sort((a, b) => a - b);
  assert.deepEqual(
    returnedVersions,
    Array.from({ length: N }, (_, i) => i + 1),
    "returned versions must be exactly 1..N with no gaps or duplicates",
  );

  // And the DB must agree: exactly N rows, one per version.
  const persisted = await db
    .select({ version: evidencePacketsTable.version })
    .from(evidencePacketsTable)
    .where(eq(evidencePacketsTable.clusterId, clusterId));
  assert.equal(persisted.length, N, "exactly one packet row per successful call");
  const persistedVersions = persisted.map((p) => p.version).sort((a, b) => a - b);
  assert.deepEqual(
    persistedVersions,
    Array.from({ length: N }, (_, i) => i + 1),
    "persisted versions must be exactly 1..N (unique, monotonic)",
  );
  assert.equal(
    new Set(persistedVersions).size,
    N,
    "no duplicate versions may be persisted under concurrency",
  );
});

// Deterministic authority floor: an approve_draft screen backed only by
// weak-tier (unknown / self-published) sources must be downgraded to
// needs_human_editor so unknown leads can never approve a draft on their own.
test("approve_draft with no trusted-tier source is downgraded to needs_human_editor", async () => {
  const [cluster] = await db
    .insert(storyClustersTable)
    .values({
      beatSlug: "zz-editorial-screen-authority-beat",
      beat: "ZZ Editorial Screen Authority Beat",
      label: "zz-editorial-screen-authority-floor-test",
      keywords: ["authority", "floor", "unknown"],
      status: "active",
      coverageStatus: "open",
      score: 50,
    })
    .returning();
  const authorityClusterId = cluster!.id;

  try {
    // Only an unknown-tier source: allowed as a lead, but not trusted.
    await db.insert(sourceDocumentsTable).values({
      url: "https://niche-unknown.example/zz-authority-floor",
      domain: "niche-unknown.example",
      title: "An unknown-tier niche source with no trusted corroboration.",
      excerpt: "Deterministic body text for the authority-floor screen input.",
      extractedText: "Deterministic body text for the authority-floor screen input.",
      authorityTier: "unknown",
      lifecycleStatus: "active",
      beatSlug: "zz-editorial-screen-authority-beat",
      clusterId: authorityClusterId,
    });

    const { packet } = await buildEvidencePacket(authorityClusterId, {
      research: "vault_only",
      screen: fakeScreen,
    });

    assert.equal(
      packet.decision,
      "needs_human_editor",
      "approve_draft must be downgraded when no trusted-tier source corroborates",
    );
    assert.ok(
      packet.decisionReasons.some((r) => /trusted-tier source/i.test(r)),
      "the downgrade reason must explain the missing trusted-tier corroboration",
    );
  } finally {
    await db
      .delete(evidencePacketsTable)
      .where(eq(evidencePacketsTable.clusterId, authorityClusterId));
    await db
      .delete(sourceDocumentsTable)
      .where(eq(sourceDocumentsTable.clusterId, authorityClusterId));
    await db.delete(storyClustersTable).where(eq(storyClustersTable.id, authorityClusterId));
  }
});

// The floor must not over-hold: an approve_draft backed by an active
// trusted-tier source (primary) is preserved as-is.
test("approve_draft with a trusted-tier source is preserved", async () => {
  const [cluster] = await db
    .insert(storyClustersTable)
    .values({
      beatSlug: "zz-editorial-screen-trusted-beat",
      beat: "ZZ Editorial Screen Trusted Beat",
      label: "zz-editorial-screen-trusted-preserve-test",
      keywords: ["authority", "trusted", "primary"],
      status: "active",
      coverageStatus: "open",
      score: 50,
    })
    .returning();
  const trustedClusterId = cluster!.id;

  try {
    await db.insert(sourceDocumentsTable).values({
      url: "https://journal.example/zz-trusted-preserve",
      domain: "journal.example",
      title: "A primary-tier source that corroborates the story.",
      excerpt: "Deterministic body text for the trusted-preserve screen input.",
      extractedText: "Deterministic body text for the trusted-preserve screen input.",
      authorityTier: "primary",
      lifecycleStatus: "active",
      beatSlug: "zz-editorial-screen-trusted-beat",
      clusterId: trustedClusterId,
    });

    const { packet } = await buildEvidencePacket(trustedClusterId, {
      research: "vault_only",
      screen: fakeScreen,
    });

    assert.equal(
      packet.decision,
      "approve_draft",
      "a trusted-tier source must keep approve_draft (no over-downgrade)",
    );
  } finally {
    await db
      .delete(evidencePacketsTable)
      .where(eq(evidencePacketsTable.clusterId, trustedClusterId));
    await db
      .delete(sourceDocumentsTable)
      .where(eq(sourceDocumentsTable.clusterId, trustedClusterId));
    await db.delete(storyClustersTable).where(eq(storyClustersTable.id, trustedClusterId));
  }
});

// --- Quarantine rule: only HARD failures hide an article ---------------------
// Regression for the operator decision that unsupported-only findings are
// advisory (opinion/analysis pieces are expected to extrapolate) and must NOT
// quarantine; only contradicted claims, invented sources, or a checker error do.
test("shouldQuarantineReport: unsupported-only flagged report does NOT quarantine", () => {
  const f = { claim: "x", detail: "y" };
  assert.equal(
    shouldQuarantineReport({ status: "flagged", contradictedClaims: [], inventedSources: [] }),
    false,
    "advisory-only (unsupported) findings must leave the article visible",
  );
  assert.equal(
    shouldQuarantineReport({ status: "passed", contradictedClaims: [], inventedSources: [] }),
    false,
  );
  assert.equal(
    shouldQuarantineReport({ status: "flagged", contradictedClaims: [f], inventedSources: [] }),
    true,
    "contradicted claims are a hard failure",
  );
  assert.equal(
    shouldQuarantineReport({ status: "flagged", contradictedClaims: [], inventedSources: [f] }),
    true,
    "invented sources are a hard failure",
  );
  assert.equal(
    shouldQuarantineReport({ status: "error", contradictedClaims: [], inventedSources: [] }),
    true,
    "a checker error holds the article for a human",
  );
});

// Internal cross-links ([anchor](/article/slug)) are navigation, not sourcing —
// they must be stripped to anchor text before the draft reaches the verifier,
// which was flagging them as "invented sources" and quarantining clean drafts.
test("stripInternalArticleLinks: reduces internal links to anchor text, keeps external links", () => {
  assert.equal(
    stripInternalArticleLinks(
      "As we saw in [our burnout piece](/article/burnout-doesnt-feel-like-exhaustion), rest matters.",
    ),
    "As we saw in our burnout piece, rest matters.",
  );
  assert.equal(
    stripInternalArticleLinks("One [a](/article/x) and two [b](/article/y-z)."),
    "One a and two b.",
  );
  const external = "See [the study](https://pmc.ncbi.nlm.nih.gov/articles/PMC123/).";
  assert.equal(stripInternalArticleLinks(external), external, "external links must be untouched");
  assert.equal(stripInternalArticleLinks("no links here"), "no links here");
  assert.equal(
    stripInternalArticleLinks('Read [this](/article/some-slug "With a title").'),
    "Read this.",
    "markdown title segment must also be stripped",
  );
});

// The findings filter must drop internal-link findings but NEVER external URLs
// that merely contain "/article/" in their path — those are real sourcing
// claims the verifier has to keep.
test("isInternalLinkFinding: drops internal-link findings, keeps external /article/ URLs", () => {
  assert.equal(
    isInternalLinkFinding({
      claim: "Internal link to '/article/burnout-doesnt-feel-like-exhaustion'",
      detail: "This linked article is not present in the evidence packet.",
    }),
    true,
  );
  assert.equal(
    isInternalLinkFinding({
      claim: "The draft links to /article/loneliness-isnt-waiting-to-be-fixed",
      detail: "",
    }),
    true,
  );
  assert.equal(
    isInternalLinkFinding({
      claim: "Cites brainhook.net/article/some-slug as a source",
      detail: "",
    }),
    true,
  );
  assert.equal(
    isInternalLinkFinding({
      claim: "The draft cites https://example.com/article/12345 as the study",
      detail: "The packet does not contain example.com/article/12345.",
    }),
    false,
    "external URLs containing /article/ must NOT be filtered",
  );
  assert.equal(
    isInternalLinkFinding({
      claim: "The study was published in JMIR Mental Health.",
      detail: "The packet does not identify the journal.",
    }),
    false,
  );
});

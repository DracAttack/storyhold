import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { db, authorsTable, topicIdeasTable } from "@workspace/db";
import { eq, like } from "drizzle-orm";
import adminIdeasRouter from "./ideas";
import { recoverDraftingIdeas } from "../../services/articles";

// E2E regression for the breaking-news intake lane (Task #249): the
// approved → harvesting_sources → drafting → used|needs_sources status machine
// behind POST /admin/ideas/:id/harvest-sources, plus the startup recovery that
// resets orphaned in-progress ideas.
//
// The real route + real service code run against the dev/test Postgres pointed
// to by DATABASE_URL (same style as sourceIngestQueue.test.ts /
// sourceHarvest.test.ts). No paid AI/network work happens because the env is
// pinned in before():
//   - SOURCE_VAULT_EMBED_PROVIDER=perplexity with no PERPLEXITY_API_KEY makes
//     isEmbeddingConfigured() false → buildEvidencePacketForIdea fails
//     instantly ("no embedding provider configured") without a model call,
//   - SOURCE_VAULT_ENABLED=false makes harvestSourcesForIdea a cheap no-op
//     (ran=false) — the harvest RESULT isn't under test, the status machine is,
//   - force=true on the route skips every LLM dedupe gate,
//   - forceHarvest excludes the legacy web-search override, so the flow ends
//     deterministically in `needs_sources` after walking the full
//     drafting → harvesting_sources → drafting → needs_sources transition.
// All env vars are read at call time by the code under test, so setting them in
// before() (after module import) is sufficient.
//
// Test rows use a recognizable zz-test slug/title prefix and are wiped in
// after(). recoverDraftingIdeas() intentionally sweeps the WHOLE table — that
// is its production behavior on server startup — so its test runs exactly the
// same reset a dev-server restart would; the assertions only inspect
// test-owned rows.

const AUTHOR_SLUG = "zz-test-harvest-lane-author";
const TITLE_PREFIX = "zz-test-harvest-lane ";

const savedEnv: Record<string, string | undefined> = {};
let server: Server;
let baseUrl: string;
let authorId: string;

function setEnv(key: string, value: string | undefined): void {
  savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function cleanup(): Promise<void> {
  await db.delete(topicIdeasTable).where(like(topicIdeasTable.title, `${TITLE_PREFIX}%`));
  await db.delete(authorsTable).where(eq(authorsTable.slug, AUTHOR_SLUG));
}

async function insertIdea(
  status: "pending" | "approved" | "drafting" | "harvesting_sources" | "needs_sources" | "used",
  label: string,
): Promise<string> {
  const [row] = await db
    .insert(topicIdeasTable)
    .values({
      authorId,
      title: `${TITLE_PREFIX}${label} ${Date.now()}`,
      angle: "A deliberately obscure test angle about nothing that overlaps no real article.",
      category: "Technology",
      categorySlug: "technology",
      status,
    })
    .returning({ id: topicIdeasTable.id });
  return row!.id;
}

async function getIdea(id: string) {
  const [row] = await db.select().from(topicIdeasTable).where(eq(topicIdeasTable.id, id)).limit(1);
  return row;
}

before(async () => {
  // Cheap-fail grounding + no-op harvest: no paid provider is ever reached.
  setEnv("SOURCE_VAULT_ENABLED", "false");
  setEnv("SOURCE_VAULT_EMBED_PROVIDER", "perplexity");
  setEnv("PERPLEXITY_EMBED_URL", undefined);
  setEnv("PERPLEXITY_API_KEY", undefined);

  await cleanup();
  const [author] = await db
    .insert(authorsTable)
    .values({
      slug: AUTHOR_SLUG,
      name: "ZZ Test Harvest Author",
      bio: "Test-only author for the harvest-sources status machine test.",
      avatarUrl: "https://example.com/zz-test-avatar.png",
      category: "Technology",
      categorySlug: "technology",
      voicePrompt: "test voice",
      active: false, // keep the automated pipeline away from this author
    })
    .returning({ id: authorsTable.id });
  authorId = author!.id;

  // Mount the REAL admin ideas router. Auth/CSRF middleware live at the /admin
  // mount point in routes/index.ts, not inside the router, so this exercises
  // the route handler exactly as production does past the guards.
  const app = express();
  app.use(express.json());
  app.use(adminIdeasRouter);
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
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("harvest-sources: approved idea walks harvesting_sources lane and settles in used or needs_sources", async () => {
  const ideaId = await insertIdea("approved", "e2e");

  const res = await fetch(`${baseUrl}/ideas/${ideaId}/harvest-sources`, { method: "POST" });
  assert.equal(res.status, 202, "route is fire-and-forget and must return 202 immediately");
  const body = (await res.json()) as { status: string };
  // The synchronous part of the flow atomically claims the idea into `drafting`
  // before the background job (which flips it to harvesting_sources) runs.
  assert.equal(body.status, "drafting");

  // The background job walks drafting → harvesting_sources → drafting →
  // used|needs_sources. Poll until it settles in a terminal state.
  const deadline = Date.now() + 30_000;
  let finalStatus = body.status;
  while (Date.now() < deadline) {
    const row = await getIdea(ideaId);
    assert.ok(row, "idea row must not disappear mid-flow");
    finalStatus = row.status;
    if (finalStatus === "used" || finalStatus === "needs_sources") break;
    assert.ok(
      ["drafting", "harvesting_sources"].includes(finalStatus),
      `idea must only pass through in-progress states, saw "${finalStatus}"`,
    );
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(
    finalStatus === "used" || finalStatus === "needs_sources",
    `idea must settle in used or needs_sources, got "${finalStatus}"`,
  );

  // With grounding unavailable and the legacy override excluded from the
  // forceHarvest lane, the deterministic outcome is a held idea.
  const row = await getIdea(ideaId);
  assert.equal(row!.status, "needs_sources");
  assert.equal(row!.draftGroundingOutcome, "held_needs_sources");
  assert.match(row!.notes ?? "", /^Held:/, "held ideas carry an explanatory note, not a generic failure");
});

test("harvest-sources: 409 when the idea is not approved or needs_sources", async () => {
  const ideaId = await insertIdea("pending", "wrong-status");
  const res = await fetch(`${baseUrl}/ideas/${ideaId}/harvest-sources`, { method: "POST" });
  assert.equal(res.status, 409);
});

test("harvest-sources: needs_sources idea is accepted for a retry", async () => {
  const ideaId = await insertIdea("needs_sources", "retry");
  const res = await fetch(`${baseUrl}/ideas/${ideaId}/harvest-sources`, { method: "POST" });
  assert.equal(res.status, 202);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const row = await getIdea(ideaId);
    if (row!.status === "used" || row!.status === "needs_sources") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const row = await getIdea(ideaId);
  assert.equal(row!.status, "needs_sources", "retry with no new evidence must re-hold, not error out");
});

test("recoverDraftingIdeas resets both drafting and harvesting_sources ideas", async () => {
  const draftingId = await insertIdea("drafting", "recover-drafting");
  const harvestingId = await insertIdea("harvesting_sources", "recover-harvesting");
  const usedId = await insertIdea("used", "recover-control");

  const count = await recoverDraftingIdeas();
  assert.ok(count >= 2, `must recover at least the two orphaned test ideas, got ${count}`);

  const drafting = await getIdea(draftingId);
  const harvesting = await getIdea(harvestingId);
  const used = await getIdea(usedId);
  assert.equal(drafting!.status, "approved", "orphaned drafting idea must reset to approved");
  assert.equal(harvesting!.status, "approved", "orphaned harvesting_sources idea must reset to approved");
  assert.match(drafting!.notes ?? "", /Reverted from in-progress state/);
  assert.match(harvesting!.notes ?? "", /Reverted from in-progress state/);
  assert.equal(used!.status, "used", "terminal ideas must be untouched by recovery");
});

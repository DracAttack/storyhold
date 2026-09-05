import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, trendMarkersTable, sourceIngestQueueTable, type TrendMarker } from "@workspace/db";
import { eq, like, sql } from "drizzle-orm";
import type { SearchLead } from "./perplexity";
import type { SiteSettingsValues } from "./siteSettings";
import {
  detectHotTopics,
  harvestTopic,
  investigateMarker,
  type HotTopic,
  type HarvestDeps,
} from "./sourceHarvest";

// Concurrency + cooldown regression for the hot-marker source harvest
// (sourceHarvest.ts). The harvest mines the wider web (paid Perplexity) for
// citable coverage of whatever's buzzing, then flips the triggering trend
// markers to `investigated` with a 72h cooldown. Its whole job is to harvest a
// hot topic AT MOST ONCE — never double-searching / double-spending Perplexity
// under overlapping cron ticks or rapid "Investigate" clicks. These tests
// exercise the REAL detection + claim logic:
//   1. detectHotTopics excludes a topic whose markers were investigated within
//      the cooldown, and surfaces it again once the cooldown lapses,
//   2. two overlapping harvests of the same hot topic only search + enqueue
//      once (the loser aborts at the atomic claim BEFORE spending),
//   3. two overlapping investigateMarker() calls on the same observed marker
//      likewise only search + enqueue once.
//
// The paid vault lookup + Perplexity search + budget guard are INJECTED
// (HarvestDeps) so no network/model call is made and the claim state machine is
// what's under test. Runs against the dev/test Postgres pointed to by
// DATABASE_URL (same style as sourceIngestQueue.test.ts). Every test-owned row
// uses a recognizable URL prefix and is wiped in beforeEach/after so nothing
// else in the dev DB is touched. detectHotTopics reads the whole table, so test
// markers use a very high observation_count to rank ahead of any real markers.

const MARKER_PREFIX = "https://zz-test-hot-harvest.example.com/marker/";
const LEAD_PREFIX = "https://zz-test-hot-harvest.example.com/lead/";
const HUGE_OBS = 1_000_000; // ranks the test topic in the per-run top-N

// detectHotTopics only reads these two thresholds; harvestTopic additionally
// reads the freshness / allowed-domain fields. Everything else is irrelevant to
// the harvest, so a partial cast keeps the fixture small.
const settings = {
  hotMarkerHarvestEnabled: true,
  hotMarkerObservationThreshold: 5,
  hotMarkerPlatformThreshold: 99, // platform trigger off — observation-driven only
  sourceDiscoveryAllowedDomains: [],
  sourceFreshnessByBeat: {},
  sourceFreshnessDefaultDays: 14,
} as unknown as SiteSettingsValues;

async function cleanup(): Promise<void> {
  await db.delete(trendMarkersTable).where(like(trendMarkersTable.url, `${MARKER_PREFIX}%`));
  await db.delete(sourceIngestQueueTable).where(like(sourceIngestQueueTable.url, `${LEAD_PREFIX}%`));
}

async function insertMarker(opts: {
  clusterId?: string | null;
  status?: TrendMarker["status"];
  observationCount?: number;
  investigatedAt?: Date | null;
}): Promise<TrendMarker> {
  const [row] = await db
    .insert(trendMarkersTable)
    .values({
      url: `${MARKER_PREFIX}${randomUUID()}`,
      domain: "zz-test-hot-harvest.example.com",
      platform: "reddit",
      title: "Mysterious deep-sea signal baffles researchers",
      snippet: "A repeating low-frequency pulse from the Mariana Trench has scientists puzzled.",
      beatSlug: null,
      clusterId: opts.clusterId ?? null,
      status: opts.status ?? "observed",
      observationCount: opts.observationCount ?? HUGE_OBS,
      ...(opts.investigatedAt !== undefined ? { investigatedAt: opts.investigatedAt } : {}),
    })
    .returning();
  return row!;
}

function topicFrom(marker: TrendMarker): HotTopic {
  return {
    key: marker.clusterId ?? `manual:${marker.id}`,
    clusterId: marker.clusterId,
    beatSlug: null,
    markers: [marker],
    triggerMarkerIds: [marker.id],
    reason: "observation_count",
    platformCount: 1,
    maxObservations: marker.observationCount,
    queryText: "mysterious deep-sea signal baffles researchers",
  };
}

// A fake search that counts its invocations and returns `count` evidence leads
// with unique, recognizable URLs. Injecting it (a) avoids the real paid call and
// (b) lets a test assert the search ran exactly once across concurrent runs.
function fakeSearch(counter: { calls: number }, count: number): HarvestDeps["search"] {
  return async () => {
    counter.calls += 1;
    // Small delay so concurrent runs interleave their claim windows.
    await new Promise((r) => setTimeout(r, 10));
    const leads: SearchLead[] = [];
    for (let i = 0; i < count; i++) {
      leads.push({
        title: `Deep-sea coverage ${i}`,
        url: `${LEAD_PREFIX}${i}`,
        snippet: "independent reporting on the signal",
        date: null,
        domain: "zz-test-hot-harvest.example.com",
        role: "evidence",
        tier: "wire",
        roleReason: "test",
        platform: null,
      });
    }
    return leads;
  };
}

// Deps that reach the paid search path for free: vault miss, no-op budget guard.
function harvestDeps(counter: { calls: number }, leadCount: number): HarvestDeps {
  return {
    vaultLookup: async () => [],
    startGuard: async () => ({ check: async () => {} }),
    search: fakeSearch(counter, leadCount),
  };
}

async function countLeadRows(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sourceIngestQueueTable)
    .where(like(sourceIngestQueueTable.url, `${LEAD_PREFIX}%`));
  return Number(row?.n ?? 0);
}

before(async () => {
  // ensureRuntimeTables creates this at boot, but the test runner may run before
  // any server boot, so create it idempotently here too (mirrors seed.ts).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "trend_markers" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "url" text NOT NULL,
      "domain" text NOT NULL,
      "platform" text NOT NULL DEFAULT 'other',
      "title" text,
      "snippet" text,
      "beat_slug" text,
      "cluster_id" uuid,
      "status" text NOT NULL DEFAULT 'observed',
      "discovered_via" text NOT NULL DEFAULT 'perplexity_search',
      "observation_count" integer NOT NULL DEFAULT 1,
      "investigated_at" timestamp with time zone,
      "harvest_summary" text,
      "first_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
      "last_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
      "escalated_at" timestamp with time zone,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT "trend_markers_url_unique" UNIQUE ("url")
    )
  `);
  await cleanup();
});

beforeEach(cleanup);
after(cleanup);

test("detectHotTopics excludes markers investigated within the cooldown", async () => {
  const now = new Date();
  const clusterId = randomUUID();
  const marker = await insertMarker({ clusterId, status: "observed" });

  // 1. Freshly observed → the topic is hot and detected.
  const before = await detectHotTopics(settings, now);
  const seenBefore = before.find((t) => t.clusterId === clusterId);
  assert.ok(seenBefore, "an observed hot marker should be detected as a topic");
  assert.ok(
    seenBefore!.triggerMarkerIds.includes(marker.id),
    "the observed marker should be a trigger for its topic",
  );

  // 2. Investigated just now → in cooldown → excluded.
  await db
    .update(trendMarkersTable)
    .set({ status: "investigated", investigatedAt: now })
    .where(eq(trendMarkersTable.id, marker.id));
  const during = await detectHotTopics(settings, now);
  assert.equal(
    during.find((t) => t.clusterId === clusterId),
    undefined,
    "a topic investigated within the cooldown must not be re-detected",
  );

  // 3. Cooldown lapsed (investigated >72h ago) and re-observed → detected again.
  const stale = new Date(now.getTime() - 100 * 3600_000);
  await db
    .update(trendMarkersTable)
    .set({ status: "observed", investigatedAt: stale })
    .where(eq(trendMarkersTable.id, marker.id));
  const after2 = await detectHotTopics(settings, now);
  assert.ok(
    after2.find((t) => t.clusterId === clusterId),
    "once the cooldown lapses the topic should be detectable again",
  );
});

test("overlapping harvests of the same hot topic search + enqueue only once", async () => {
  const now = new Date();
  const marker = await insertMarker({ status: "observed" });
  const topic = topicFrom(marker);
  const counter = { calls: 0 };
  const leadCount = 3;
  const deps = harvestDeps(counter, leadCount);

  const [a, b] = await Promise.all([
    harvestTopic(topic, settings, now, { requireClaim: true, deps }),
    harvestTopic(topic, settings, now, { requireClaim: true, deps }),
  ]);

  // Exactly one run wins the atomic claim and does the paid search.
  assert.equal(counter.calls, 1, "the paid search must run exactly once across concurrent harvests");

  const winners = [a, b].filter((o) => o.perplexityUsed);
  const losers = [a, b].filter((o) => !o.perplexityUsed);
  assert.equal(winners.length, 1, "exactly one harvest should perform the search");
  assert.equal(losers.length, 1, "exactly one harvest should be skipped");

  assert.equal(winners[0]!.leadsEnqueued, leadCount, "the winner enqueues every lead");
  assert.equal(winners[0]!.markersInvestigated, 1, "the winner claims the trigger marker");
  assert.equal(losers[0]!.leadsEnqueued, 0, "the loser enqueues nothing");
  assert.equal(losers[0]!.markersInvestigated, 0, "the loser claims nothing");
  assert.equal(losers[0]!.stoppedBy, "done", "the loser stops cleanly (already harvested)");

  // The ingest queue holds each lead exactly once — no duplicate rows.
  assert.equal(await countLeadRows(), leadCount, "no duplicate leads are enqueued");

  const [after2] = await db
    .select()
    .from(trendMarkersTable)
    .where(eq(trendMarkersTable.id, marker.id));
  assert.equal(after2!.status, "investigated", "the marker ends up investigated");
});

test("overlapping investigateMarker calls on one marker search + enqueue only once", async () => {
  const now = new Date();
  const marker = await insertMarker({ status: "observed" });
  const counter = { calls: 0 };
  const leadCount = 2;
  const deps = harvestDeps(counter, leadCount);

  const [a, b] = await Promise.all([
    investigateMarker(marker.id, now, deps),
    investigateMarker(marker.id, now, deps),
  ]);

  // Rapid double-click / click-racing-cron: the paid search still runs once.
  assert.equal(counter.calls, 1, "two concurrent investigations must search only once");

  const outcomes = [a.outcome, b.outcome];
  const winners = outcomes.filter((o) => o.perplexityUsed);
  const losers = outcomes.filter((o) => !o.perplexityUsed);
  assert.equal(winners.length, 1, "exactly one investigation performs the search");
  assert.equal(losers.length, 1, "exactly one investigation is skipped");
  assert.equal(winners[0]!.leadsEnqueued, leadCount, "the winner enqueues every lead");
  assert.equal(losers[0]!.leadsEnqueued, 0, "the loser enqueues nothing");

  assert.equal(await countLeadRows(), leadCount, "no duplicate leads are enqueued");
});

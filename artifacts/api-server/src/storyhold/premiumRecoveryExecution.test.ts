import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { canonPayloadFingerprint } from "./analysisVerificationContracts";
import { premiumReviewJournalSchemaSql } from "./premiumReviewJournal";
import { claimPausedPremiumReview, runWorldAnalysis } from "./worldStudio";

const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const scope = { runId: uuid(1), worldId: uuid(2), editionId: uuid(3), playerId: uuid(4) };

/** Only the real worker's initial read and durable terminal guard need a schema. */
async function database(status: string, finalized = false) {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.worlds (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.world_analysis_runs (
      id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
      requested_by_player_id uuid NOT NULL, status text NOT NULL,
      pause_requested boolean NOT NULL DEFAULT false,
      analysis_kind text NOT NULL DEFAULT 'ai_enrichment',
      trigger_kind text NOT NULL DEFAULT 'manual', incremental boolean NOT NULL DEFAULT false,
      source_ids jsonb NOT NULL DEFAULT '[]', review_source_ids jsonb NOT NULL DEFAULT '[]',
      user_guidance text NOT NULL DEFAULT '', intake_product_fingerprint text NOT NULL DEFAULT '',
      intake_product_source_ids jsonb NOT NULL DEFAULT '[]',
      intake_product_price_credits integer NOT NULL DEFAULT 0,
      intake_product_charge_status text NOT NULL DEFAULT 'not_applicable',
      local_checkpoint jsonb NOT NULL DEFAULT '{"savedBatch":2}',
      parent_local_run_id uuid, corpus_fingerprint text NOT NULL DEFAULT 'saved-corpus',
      evidence_graph_fingerprint text NOT NULL DEFAULT 'saved-evidence',
      constraint_snapshot_fingerprint text NOT NULL DEFAULT 'saved-constraints',
      verification_context_snapshot jsonb NOT NULL DEFAULT '{}',
      verification_context_fingerprint text NOT NULL DEFAULT 'saved-context',
      verification_packet_version integer NOT NULL DEFAULT 1,
      stage text NOT NULL DEFAULT 'Saved review boundary', error text,
      paused_at timestamptz, completed_at timestamptz
    );
    CREATE TABLE storyhold.players (id uuid PRIMARY KEY, credits integer NOT NULL);
    CREATE TABLE storyhold.credit_reservations (id uuid PRIMARY KEY, status text NOT NULL, reserved_credits integer NOT NULL);
    CREATE TABLE storyhold.credit_ledger (id uuid PRIMARY KEY, credits_delta integer NOT NULL);
    CREATE TABLE storyhold.world_analysis_chunk_coverage (analysis_run_id uuid PRIMARY KEY, status text NOT NULL);
  `);
  await db.exec(premiumReviewJournalSchemaSql);
  await db.query("INSERT INTO storyhold.worlds VALUES ($1)", [scope.worldId]);
  await db.query(
    `INSERT INTO storyhold.world_analysis_runs
      (id, world_id, canon_edition_id, requested_by_player_id, status, pause_requested)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [scope.runId, scope.worldId, scope.editionId, scope.playerId, status, status === "paused"],
  );
  await db.query("INSERT INTO storyhold.players VALUES ($1, 77)", [scope.playerId]);
  await db.query("INSERT INTO storyhold.credit_reservations VALUES ($1, 'settled', 23)", [uuid(5)]);
  await db.query("INSERT INTO storyhold.credit_ledger VALUES ($1, -23)", [uuid(6)]);
  await db.query("INSERT INTO storyhold.world_analysis_chunk_coverage VALUES ($1, 'analyzed')", [scope.runId]);
  const request = { provider: "fixture", model: "saved-model", request: { prompt: "Synthetic saved response only" } };
  await db.query(
    `INSERT INTO storyhold.world_analysis_ai_calls
      (run_id, step_key, request_snapshot, request_fingerprint)
     VALUES ($1, 'verification:0', $2::jsonb, $3)`,
    [scope.runId, JSON.stringify(request), canonPayloadFingerprint(request)],
  );
  if (finalized) {
    // Presence alone must prohibit execution, even when other persisted run
    // fields were subsequently corrupted. This is not a fabricated completion.
    await db.query(
      `INSERT INTO storyhold.world_analysis_premium_reconciliations
        (run_id, id, journal_fingerprint, request_fingerprint, receipt)
       VALUES ($1, $2, 'saved-journal', 'saved-operator-decision', '{"fixture":true}')`,
      [scope.runId, uuid(7)],
    );
  }
  return db;
}

async function snapshot(db: PGlite) {
  const tables = [
    "worlds", "world_analysis_runs", "world_analysis_ai_calls", "world_analysis_premium_reconciliations",
    "players", "credit_reservations", "credit_ledger", "world_analysis_chunk_coverage",
  ];
  return Promise.all(tables.map(async (table) => (await db.query(`SELECT * FROM storyhold.${table}`)).rows));
}

async function assertInertWorker(t: TestContext, db: PGlite, supplied = scope) {
  const before = await snapshot(db);
  const queries: string[] = [];
  let mutations = 0;
  let networkCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    networkCalls += 1;
    throw new Error("Network access is forbidden in worker recovery fixtures.");
  });
  const observed = {
    query: (async (sql: string, values?: unknown[]) => {
      queries.push(sql);
      if (!/^\s*SELECT\b/iu.test(sql)) {
        mutations += 1;
        throw new Error("A terminal worker callback attempted a database mutation.");
      }
      return db.query(sql, values);
    }) as PGlite["query"],
    exec: (async () => {
      mutations += 1;
      throw new Error("A terminal worker callback attempted exec.");
    }) as PGlite["exec"],
    transaction: (async () => {
      mutations += 1;
      throw new Error("A terminal worker callback attempted a transaction.");
    }) as PGlite["transaction"],
  };
  await runWorldAnalysis(observed, supplied);
  assert.equal(networkCalls, 0);
  assert.equal(mutations, 0, "terminal callbacks must not even attempt billing or run-state writes");
  assert.ok(queries.length > 0, "the actual production worker must inspect persisted state");
  assert.ok(queries.every((sql) => /FROM storyhold\.world_analysis_(?:runs|premium_reconciliations)\b/iu.test(sql)),
    "a terminal callback must stop before reading plans, manuscript text, or billing");
  assert.deepEqual(await snapshot(db), before, "saved work, journal, receipts, holds, and balance remain unchanged");
}

test("production worker does not resurrect completed or failed premium reviews", async (t) => {
  for (const status of ["completed", "failed"]) {
    await t.test(status, async (t) => {
      const db = await database(status);
      try { await assertInertWorker(t, db); }
      finally { await db.close(); }
    });
  }
});

test("production worker ignores missing and mismatched run scopes without writes", async (t) => {
  for (const field of ["runId", "worldId", "editionId", "playerId"] as const) {
    await t.test(field, async (t) => {
      const db = await database("queued");
      try { await assertInertWorker(t, db, { ...scope, [field]: uuid(99) }); }
      finally { await db.close(); }
    });
  }
});

test("immutable finalization blocks production worker even if run state is changed back to active", async (t) => {
  for (const status of ["queued", "running", "paused"]) {
    await t.test(status, async (t) => {
      const db = await database(status, true);
      try { await assertInertWorker(t, db); }
      finally { await db.close(); }
    });
  }
});

test("production resume claim rejects a finalized paused review and preserves every saved row", async () => {
  const db = await database("paused", true);
  try {
    const before = await snapshot(db);
    assert.equal(await claimPausedPremiumReview(db, scope, false), false,
      "a restart cannot reclaim an operator-finalized review");
    assert.deepEqual(await snapshot(db), before);
    assert.equal(await claimPausedPremiumReview(db, scope, true), false,
      "the live-worker branch cannot bypass immutable finalization either");
    assert.deepEqual(await snapshot(db), before,
      "the paused flag, terminal receipt, provider journal, saved coverage, and billing stay unchanged");
  } finally { await db.close(); }
});

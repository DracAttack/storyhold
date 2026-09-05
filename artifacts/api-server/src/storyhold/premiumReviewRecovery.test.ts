import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { canonPayloadFingerprint, type JsonObject } from "./analysisVerificationContracts";
import { creditEconomySchemaSql, reserveCredits } from "./creditEconomy";
import { PremiumReviewPlanError } from "./premiumReviewPlan";
import { premiumReviewJournalSchemaSql, readPremiumJournalAccounting } from "./premiumReviewJournal";
import {
  claimPausedPremiumReview,
  frozenPremiumChunksMatch,
  pauseInterruptedPremiumReviews,
  seedChunkCoverage,
  worldIntakePipelineState,
} from "./worldStudio";

const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const WORLD = uuid(1);
const OTHER_WORLD = uuid(2);
const EDITION = uuid(3);
const PLAYER = uuid(4);
type Scope = Parameters<typeof claimPausedPremiumReview>[1];
type Chunk = Parameters<typeof frozenPremiumChunksMatch>[1][number];

function chunks(): Chunk[] {
  return [1, 2].map((index) => ({
    id: `chunk-${index}`,
    sourceId: "source-one",
    sourceTitle: "Saved Manuscript",
    index,
    content: `Exact saved passage ${index}.`,
    sectionKey: `section-${index}`,
    sectionTitle: `Chapter ${index}`,
    sectionIndex: index,
    coverageAuthoritative: false,
    reviewedChunkCount: 0,
  }));
}

test("frozen premium passages ignore live ordering and coverage-only counters", () => {
  const frozen = chunks();
  const current = chunks().reverse().map((chunk) => ({
    ...chunk,
    coverageAuthoritative: true,
    reviewedChunkCount: 73,
  }));
  assert.equal(frozenPremiumChunksMatch(frozen, current), true);
  assert.equal(frozenPremiumChunksMatch(frozen, [...current, {
    ...current[0]!, id: "unselected-live-passage",
  }]), true);
  assert.deepEqual(frozen, chunks());
});

test("frozen premium passages fail closed on any prompt-field drift or missing passage", () => {
  const frozen = chunks();
  const changes: Partial<Chunk>[] = [
    { id: "replacement-chunk" },
    { sourceId: "replacement-source" },
    { sourceTitle: "Changed Manuscript Title" },
    { index: 99 },
    { content: "Changed source text." },
    { sectionKey: "replacement-section" },
    { sectionTitle: "Changed Chapter Title" },
    { sectionIndex: 99 },
  ];
  for (const change of changes) {
    const current = chunks();
    current[0] = { ...current[0]!, ...change };
    assert.equal(frozenPremiumChunksMatch(frozen, current), false, JSON.stringify(change));
  }
  assert.equal(frozenPremiumChunksMatch(frozen, chunks().slice(1)), false);
  assert.equal(frozenPremiumChunksMatch(frozen, []), false);
});

async function database() {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.worlds (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.world_analysis_runs (
      id uuid PRIMARY KEY, world_id uuid NOT NULL REFERENCES storyhold.worlds(id),
      canon_edition_id uuid NOT NULL, requested_by_player_id uuid NOT NULL,
      analysis_kind text NOT NULL, status text NOT NULL,
      premium_resume_status text NOT NULL DEFAULT 'not_available',
      progress integer NOT NULL, source_count integer NOT NULL DEFAULT 2,
      chunk_count integer NOT NULL DEFAULT 80,
      provider text NOT NULL DEFAULT 'openrouter', model text NOT NULL DEFAULT 'frozen-model',
      local_checkpoint jsonb NOT NULL DEFAULT '{}',
      intake_preview jsonb NOT NULL DEFAULT '{}', intake_activity jsonb NOT NULL DEFAULT '[]',
      stage text NOT NULL DEFAULT 'Saved Review Boundary', error text,
      pause_requested boolean NOT NULL DEFAULT true,
      paused_at timestamptz, completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE storyhold.world_analysis_chunk_coverage (
      analysis_run_id uuid NOT NULL REFERENCES storyhold.world_analysis_runs(id),
      chunk_id uuid NOT NULL, status text NOT NULL, finding_count integer NOT NULL,
      content_hash text NOT NULL, PRIMARY KEY (analysis_run_id, chunk_id)
    );
  `);
  await db.exec(premiumReviewJournalSchemaSql);
  await db.query("INSERT INTO storyhold.worlds VALUES ($1), ($2)", [WORLD, OTHER_WORLD]);
  return db;
}

async function insertRun(db: PGlite, number: number, status: string, analysisKind = "ai_enrichment", worldId = WORLD, withSavedCall = true) {
  const id = uuid(number);
  await db.query(
    `INSERT INTO storyhold.world_analysis_runs
      (id, world_id, canon_edition_id, requested_by_player_id, analysis_kind, status,
       progress, local_checkpoint, intake_preview, intake_activity)
     VALUES ($1, $2, $3, $4, $5, $6, 43,
       '{"savedBatch":2}'::jsonb, '{"reviewedChunks":27}'::jsonb,
       '[{"message":"Saved work"}]'::jsonb)`,
    [id, worldId, EDITION, PLAYER, analysisKind, status],
  );
  await db.query(
    "INSERT INTO storyhold.world_analysis_chunk_coverage VALUES ($1, $2, 'analyzed', 3, 'frozen-content-hash')",
    [id, uuid(number + 1_000)],
  );
  if (withSavedCall) await insertJournalCall(db, id, "completed");
  return { runId: id, worldId, editionId: EDITION, playerId: PLAYER } satisfies Scope;
}

async function insertJournalCall(db: PGlite, runId: string, status: "dispatched" | "uncertain" | "completed" | "rejected") {
  const request: JsonObject = { task: "canon_review", allowProviderFallback: false };
  const result: JsonObject | null = status === "completed"
    ? { text: "Already paid and saved", usage: { inputUnits: 10, outputUnits: 2 }, runtime: { stage: "verification" } }
    : null;
  const fingerprint = status === "dispatched" ? null : canonPayloadFingerprint({
    version: "storyhold:premium-review-outcome:v1", status, result, billableAttempts: [],
  });
  await db.query(
    `INSERT INTO storyhold.world_analysis_ai_calls
      (run_id, step_key, request_fingerprint, request_snapshot, status, result_snapshot, result_fingerprint)
     VALUES ($1, 'verification:0', $2, $3::jsonb, $4, $5::jsonb, $6)`,
    [runId, canonPayloadFingerprint(request), JSON.stringify(request), status,
      result === null ? null : JSON.stringify(result), fingerprint],
  );
}

async function databaseWithCredits() {
  const db = await database();
  await db.exec(`
    CREATE TABLE storyhold.players (
      id uuid PRIMARY KEY, role text NOT NULL, credits integer NOT NULL CHECK (credits >= 0),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE storyhold.campaigns (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.ai_usage_ledger (id uuid PRIMARY KEY);
  `);
  await db.exec(creditEconomySchemaSql);
  await db.query("INSERT INTO storyhold.players (id, role, credits) VALUES ($1, 'player', 100), ($2, 'player', 30)", [PLAYER, uuid(5)]);
  return db;
}

async function creditRows(db: PGlite) {
  return {
    players: (await db.query<Record<string, unknown>>("SELECT * FROM storyhold.players ORDER BY id")).rows,
    holds: (await db.query<Record<string, unknown>>("SELECT * FROM storyhold.credit_reservations ORDER BY id")).rows,
    ledger: (await db.query<Record<string, unknown>>("SELECT * FROM storyhold.credit_ledger ORDER BY id")).rows,
  };
}

async function rows(db: PGlite) {
  return (await db.query<Record<string, unknown>>("SELECT * FROM storyhold.world_analysis_runs ORDER BY id")).rows;
}

async function savedWork(db: PGlite) {
  return {
    runs: (await db.query(`SELECT id, world_id, canon_edition_id, requested_by_player_id,
      analysis_kind, provider, model, progress, source_count, chunk_count,
      local_checkpoint, intake_preview, intake_activity, created_at
      FROM storyhold.world_analysis_runs ORDER BY id`)).rows,
    coverage: (await db.query("SELECT * FROM storyhold.world_analysis_chunk_coverage ORDER BY analysis_run_id, chunk_id")).rows,
    calls: (await db.query("SELECT * FROM storyhold.world_analysis_ai_calls ORDER BY run_id, step_key")).rows,
  };
}

async function withoutProviderCalls(run: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("Recovery must not send a provider request.");
  };
  try {
    await run();
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("startup pauses eligible premium runs without dispatch or changing saved progress", async () => {
  const db = await database();
  try {
    const eligible = await Promise.all([
      insertRun(db, 10, "queued"), insertRun(db, 11, "running"), insertRun(db, 12, "paused"),
    ]);
    const blocked = await insertRun(db, 13, "running");
    const skipped = await Promise.all([
      insertRun(db, 14, "queued", "local_scan"),
      insertRun(db, 15, "running", "local_scan"),
      insertRun(db, 16, "paused", "local_scan"),
      insertRun(db, 17, "completed"), insertRun(db, 18, "failed"),
    ]);
    const before = await savedWork(db);
    const skippedBefore = (await rows(db)).filter((row) => skipped.some((scope) => scope.runId === row.id));
    const validated: Scope[] = [];
    let canRecoverBlocked = false;
    const validate = async (scope: Scope) => {
      validated.push(scope);
      if (scope.runId === blocked.runId && !canRecoverBlocked) throw new Error("Reconnect the same premium model.");
      return { validated: true };
    };
    await withoutProviderCalls(async () => {
      for (let startup = 0; startup < 2; startup += 1) {
        await pauseInterruptedPremiumReviews(db, validate);
        const current = await rows(db);
        for (const scope of [...eligible, blocked]) {
          const row = current.find((item) => item.id === scope.runId)!;
          assert.equal(row.status, "paused");
          assert.equal(row.premium_resume_status, scope.runId === blocked.runId ? "blocked" : "ready");
          assert.equal(row.pause_requested, false);
          assert.equal(row.progress, 43);
          assert.equal(row.completed_at, null);
          assert.ok(row.paused_at);
          assert.equal(row.error, scope.runId === blocked.runId ? "Reconnect the same premium model." : null);
        }
        assert.deepEqual(current.filter((row) => skipped.some((scope) => scope.runId === row.id)), skippedBefore);
        assert.deepEqual(await savedWork(db), before);
      }
      assert.equal(validated.length, 8);
      for (const scope of [...eligible, blocked]) {
        assert.deepEqual(validated.filter((item) => item.runId === scope.runId), [scope, scope]);
      }
      // Fixing a transient connection problem makes Resume ready, not running.
      canRecoverBlocked = true;
      await pauseInterruptedPremiumReviews(db, validate);
      const recovered = (await rows(db)).find((row) => row.id === blocked.runId)!;
      assert.equal(recovered.status, "paused");
      assert.equal(recovered.premium_resume_status, "ready");
      assert.equal(recovered.error, null);
      assert.deepEqual(await savedWork(db), before);
    });
  } finally {
    await db.close();
  }
});

test("planless no-call recovery refunds only the new scoped unused hold and only once", async () => {
  const db = await databaseWithCredits();
  try {
    const marked = await insertRun(db, 40, "queued", "ai_enrichment", WORLD, false);
    const legacy = await insertRun(db, 41, "running", "ai_enrichment", WORLD, false);
    const wrongWorld = await insertRun(db, 42, "paused", "ai_enrichment", WORLD, false);
    const wrongPlayer = await insertRun(db, 43, "queued", "ai_enrichment", WORLD, false);
    const wrongOperation = await insertRun(db, 44, "queued", "ai_enrichment", WORLD, false);
    const protectedMarker = { premiumResumeVersion: 1, retainUntilReconciled: true };
    const reserve = (scope: Scope, requiredCredits: number, overrides: Partial<Parameters<typeof reserveCredits>[1]> = {}) => reserveCredits(db, {
      playerId: scope.playerId, worldId: scope.worldId, requestId: scope.runId,
      operation: "world_analysis", requiredCredits, metadata: protectedMarker, ...overrides,
    });
    const markedHold = await reserve(marked, 10);
    const retained = await Promise.all([
      reserve(legacy, 7, { metadata: { retainUntilReconciled: true } }),
      reserve(wrongWorld, 3, { worldId: OTHER_WORLD }),
      reserve(wrongPlayer, 4, { playerId: uuid(5) }),
      reserve(wrongOperation, 5, { operation: "campaign_turn" }),
    ]);
    const beforeWork = await savedWork(db);
    const beforeCredits = await creditRows(db);
    const retainedBefore = beforeCredits.holds.filter((row) => retained.some((hold) => hold.id === row.id));
    let validations = 0;
    const missingPlan = async () => {
      validations += 1;
      throw new PremiumReviewPlanError("PLAN_MISSING", "No mandatory execution plan was saved.");
    };
    await withoutProviderCalls(async () => {
      await pauseInterruptedPremiumReviews(db, missingPlan);
      const firstRows = await rows(db);
      for (const row of firstRows) {
        assert.equal(row.status, "failed");
        assert.equal(row.premium_resume_status, "not_available");
        assert.equal(row.progress, 43);
        assert.ok(row.completed_at);
      }
      const afterCredits = await creditRows(db);
      assert.equal(afterCredits.players.find((player) => player.id === PLAYER)?.credits, 85);
      assert.equal(afterCredits.players.find((player) => player.id === uuid(5))?.credits, 26);
      assert.equal(afterCredits.holds.find((hold) => hold.id === markedHold.id)?.status, "released");
      assert.deepEqual(afterCredits.holds.filter((row) => retained.some((hold) => hold.id === row.id)), retainedBefore);
      assert.equal(afterCredits.ledger.length, beforeCredits.ledger.length + 1);
      const releases = afterCredits.ledger.filter((entry) => entry.entry_kind === "release");
      assert.equal(releases.length, 1);
      assert.equal(releases[0]?.reservation_id, markedHold.id);
      assert.equal(releases[0]?.credits_delta, 10);
      assert.deepEqual(await savedWork(db), beforeWork);
      assert.equal(validations, 5);

      await pauseInterruptedPremiumReviews(db, missingPlan);
      assert.equal(validations, 5);
      assert.deepEqual(await rows(db), firstRows);
      assert.deepEqual(await creditRows(db), afterCredits);
      assert.deepEqual(await savedWork(db), beforeWork);
    });
  } finally {
    await db.close();
  }
});

test("existing or uncertain journal work never receives the planless no-call exception", async () => {
  const db = await databaseWithCredits();
  try {
    const scopes: Scope[] = [];
    for (const [index, status] of (["dispatched", "uncertain", "completed", "rejected"] as const).entries()) {
      const scope = await insertRun(db, 50 + index, "running", "ai_enrichment", WORLD, false);
      scopes.push(scope);
      await insertJournalCall(db, scope.runId, status);
      const accounting = await readPremiumJournalAccounting(db, scope.runId);
      assert.equal(accounting.callCount, 1);
      assert.equal(accounting.hasUncertain, status === "dispatched" || status === "uncertain");
    }
    const invalidPlan = await insertRun(db, 54, "queued", "ai_enrichment", WORLD, false);
    scopes.push(invalidPlan);
    for (const scope of scopes) {
      await reserveCredits(db, {
        playerId: scope.playerId, worldId: scope.worldId, operation: "world_analysis",
        requestId: scope.runId, requiredCredits: 5,
        metadata: { premiumResumeVersion: 1, retainUntilReconciled: true },
      });
    }
    const beforeCredits = await creditRows(db);
    const beforeWork = await savedWork(db);
    const validate = async (scope: Scope) => {
      throw new PremiumReviewPlanError(scope.runId === invalidPlan.runId ? "PLAN_INVALID" : "PLAN_MISSING", "Saved review requires reconciliation.");
    };
    await withoutProviderCalls(async () => {
      for (let startup = 0; startup < 2; startup += 1) {
        await pauseInterruptedPremiumReviews(db, validate);
        for (const row of await rows(db)) {
          assert.equal(row.status, "paused");
          assert.equal(row.premium_resume_status, "blocked");
          assert.equal(row.completed_at, null);
        }
        assert.deepEqual(await creditRows(db), beforeCredits);
        assert.deepEqual(await savedWork(db), beforeWork);
      }
    });
  } finally {
    await db.close();
  }
});

for (const liveWorker of [false, true]) {
  test(`concurrent resume claims the original paused run once (live worker: ${liveWorker})`, async () => {
    const db = await database();
    try {
      const scope = await insertRun(db, 20, "paused");
      const before = await savedWork(db);
      await withoutProviderCalls(async () => {
        const claims = await Promise.all([
          claimPausedPremiumReview(db, scope, liveWorker),
          claimPausedPremiumReview(db, scope, liveWorker),
        ]);
        assert.equal(claims.filter(Boolean).length, 1);
        assert.equal(claims.filter((claimed) => !claimed).length, 1);
        const current = await rows(db);
        assert.equal(current.length, 1);
        assert.equal(current[0]?.id, scope.runId);
        assert.equal(current[0]?.status, liveWorker ? "running" : "queued");
        assert.equal(current[0]?.progress, 43);
        assert.equal(current[0]?.pause_requested, false);
        assert.equal(current[0]?.paused_at, null);
        assert.deepEqual(await savedWork(db), before);
      });
    } finally {
      await db.close();
    }
  });
}

test("resume refuses competing active work and mismatched ownership scope without writes", async () => {
  const db = await database();
  try {
    const scope = await insertRun(db, 30, "paused");
    const competing = await insertRun(db, 31, "queued");
    await withoutProviderCalls(async () => {
      for (const status of ["queued", "running", "paused"]) {
        await db.query("UPDATE storyhold.world_analysis_runs SET status = $2 WHERE id = $1", [competing.runId, status]);
        const beforeRows = await rows(db);
        const beforeWork = await savedWork(db);
        assert.equal(await claimPausedPremiumReview(db, scope, false), false);
        assert.deepEqual(await rows(db), beforeRows);
        assert.deepEqual(await savedWork(db), beforeWork);
      }
      await db.query("UPDATE storyhold.world_analysis_runs SET status = 'completed' WHERE id = $1", [competing.runId]);
      const beforeRows = await rows(db);
      const beforeWork = await savedWork(db);
      for (const wrongScope of [
        { ...scope, runId: uuid(999) },
        { ...scope, playerId: uuid(998) },
        { ...scope, editionId: uuid(997) },
        { ...scope, worldId: OTHER_WORLD },
      ]) {
        assert.equal(await claimPausedPremiumReview(db, wrongScope, false), false);
        assert.deepEqual(await rows(db), beforeRows);
        assert.deepEqual(await savedWork(db), beforeWork);
      }
    });
  } finally {
    await db.close();
  }
});

test("resume coverage seeding preserves completed rows exactly and adds only missing placeholders", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.world_analysis_chunk_coverage (
        analysis_run_id uuid NOT NULL, chunk_id uuid NOT NULL, source_id uuid NOT NULL,
        chunk_index integer NOT NULL, content_hash text NOT NULL, status text NOT NULL,
        finding_count integer NOT NULL, error text, completed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (analysis_run_id, chunk_id)
      );
    `);
    const runId = uuid(70);
    const planned: Chunk[] = [0, 1, 2].map((index) => ({
      id: uuid(700 + index), sourceId: uuid(800), sourceTitle: "Frozen Source",
      index, content: `Frozen review passage ${index}.`,
    }));
    for (const [index, status] of ["analyzed", "no_findings"].entries()) {
      await db.query(
        `INSERT INTO storyhold.world_analysis_chunk_coverage
          (analysis_run_id, chunk_id, source_id, chunk_index, content_hash, status,
           finding_count, error, completed_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
           '2026-01-02T03:04:05Z', '2026-01-01T00:00:00Z', '2026-01-02T03:04:05Z')`,
        [runId, planned[index]!.id, planned[index]!.sourceId, index, `persisted-hash-${index}`,
          status, index === 0 ? 3 : 0, `Retained audit note ${index}`],
      );
    }
    const coverageRows = async () => (await db.query<Record<string, unknown>>(
      "SELECT * FROM storyhold.world_analysis_chunk_coverage ORDER BY chunk_id",
    )).rows;
    const completedBefore = await coverageRows();
    await withoutProviderCalls(async () => {
      await seedChunkCoverage(db, runId, planned);
      const seeded = await coverageRows();
      assert.equal(seeded.length, 3);
      assert.deepEqual(seeded.filter((row) => row.chunk_id !== planned[2]!.id), completedBefore);
      const missing = seeded.find((row) => row.chunk_id === planned[2]!.id)!;
      assert.equal(missing.analysis_run_id, runId);
      assert.equal(missing.source_id, planned[2]!.sourceId);
      assert.equal(missing.chunk_index, 2);
      assert.equal(missing.content_hash, createHash("sha256").update(planned[2]!.content).digest("hex"));
      assert.equal(missing.status, "failed");
      assert.equal(missing.finding_count, 0);
      assert.equal(missing.error, "The review did not reach this passage.");
      assert.equal(missing.completed_at, null);
      await seedChunkCoverage(db, runId, planned);
      assert.deepEqual(await coverageRows(), seeded);
    });
  } finally {
    await db.close();
  }
});

test("reviewed sources keep a failed blocked premium run from offering a fresh review", () => {
  const state = worldIntakePipelineState({
    sources: [{
      processingStatus: "ready", chunkCount: 80,
      localScanStatus: "completed", aiReviewStatus: "reviewed",
    }],
    latestRun: {
      status: "failed", analysisKind: "ai_enrichment", progress: 43,
      premiumResumeStatus: "blocked", error: "Saved review requires reconciliation.",
    },
    browserAudit: { status: "completed", progress: 100 },
    aiConfigured: true,
  });
  assert.equal(state.status, "ready");
  assert.equal(state.stage, "complete");
  assert.equal(state.canOpenWorld, true);
  assert.equal(state.canStartPremiumReview, false);
  assert.equal(state.canRetryLocal, false);
  assert.equal(state.requiresOpenPage, false);
});

test("blocked premium recovery keeps the local world open without offering fresh premium work", () => {
  for (const aiReviewStatus of ["waiting", "failed", "reviewed"]) {
    const state = worldIntakePipelineState({
      sources: [{ processingStatus: "ready", chunkCount: 80, localScanStatus: "completed", aiReviewStatus }],
      latestRun: {
        status: "paused", analysisKind: "ai_enrichment", progress: 43,
        premiumResumeStatus: "blocked", error: "Reconnect the same premium model.",
      },
      browserAudit: { status: "completed", progress: 100 },
      aiConfigured: true,
    });
    assert.equal(state.status, "paused");
    assert.equal(state.canOpenWorld, true);
    assert.equal(state.canStartPremiumReview, false);
    assert.equal(state.canRetryLocal, false);
    assert.equal(state.requiresOpenPage, false);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { AiGatewayUnavailableError, getAiRuntimeStatus, type AiBillableAttempt, type AiTextResult, type GenerateAiTextInput } from "./aiGateway";
import { ensureEntityReviewJournal, EntityReviewJournalError, executeJournaledEntityReviewCall, finalizeEntityReviewCall,
  findPendingEntityReviewCall, lockEntityReviewCallForFinalization, readEntityReviewCall, type EntityReviewCallScope } from "./entityReviewJournal";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope: EntityReviewCallScope = { reviewId: uuid(1), playerId: uuid(2), worldId: uuid(3), editionId: uuid(4), entityId: uuid(5) };
const reservationId = uuid(6);
const MODEL = "synthetic-dossier-model";
const code = (name: string) => (error: unknown) => error instanceof EntityReviewJournalError && error.code === name;
async function database() {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.players (id uuid PRIMARY KEY, role text NOT NULL DEFAULT 'player');
    CREATE TABLE storyhold.world_entities (id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL);
    CREATE TABLE storyhold.credit_reservations (id uuid PRIMARY KEY, player_id uuid NOT NULL, world_id uuid NOT NULL,
      operation text NOT NULL, request_id text NOT NULL, status text DEFAULT 'reserved', reserved_credits integer DEFAULT 30,
      usage jsonb DEFAULT '{}');`);
  await ensureEntityReviewJournal(db);
  await db.query("INSERT INTO storyhold.players (id) VALUES ($1)", [scope.playerId]);
  await db.query("INSERT INTO storyhold.world_entities VALUES ($1, $2, $3)", [scope.entityId, scope.worldId, scope.editionId]);
  await db.query(`INSERT INTO storyhold.credit_reservations (id, player_id, world_id, operation, request_id)
    VALUES ($1, $2, $3, 'entity_review', $4)`, [reservationId, scope.playerId, scope.worldId, scope.reviewId]);
  return db;
}
function request(): GenerateAiTextInput {
  return { task: "canon_review", stage: "dossier", reasoning: "high", maxOutputTokens: 1200, temperature: 0,
    system: "Review only supplied evidence.", messages: [{ role: "user", content: "Mira held the beam." }],
    providerFailurePolicy: "stop", allowProviderFallback: false };
}
function result(): AiTextResult {
  return { text: '{"summary":"Mira protects her companions."}', provider: "openrouter", model: MODEL, reasoning: "high",
    usage: { inputUnits: 1000, outputUnits: 100, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 10,
      estimatedCostMicros: 1500, pricingKnown: true, pricingVersion: "fixture", costEstimated: false },
    runtime: { ...getAiRuntimeStatus("canon_review", "standard", "dossier"), configured: true, mode: "connected", provider: "openrouter",
      model: MODEL, stage: "dossier", billable: true, sendsSourceTextOffDevice: true,
      execution: { connectionId: "managed:openrouter", credentialSource: "environment", connectionSource: "storyhold_managed",
        billingSource: "storyhold_credits", requestedModel: MODEL, resolvedModel: "resolved-fixture", upstreamProvider: "fixture", privacyMode: "zero-data-retention" } },
  };
}
function attempt(): AiBillableAttempt {
  const value = result();
  return { provider: value.provider, model: value.model, resolvedModel: "resolved-fixture", upstreamProvider: "fixture", stage: "dossier",
    reasoning: value.reasoning, usage: { ...value.usage, estimatedCostMicros: 500 } };
}
function params(changes: Partial<Parameters<typeof executeJournaledEntityReviewCall>[1]> = {}) {
  return { scope, reservationId, contextSnapshot: { input: { entity: { id: scope.entityId, name: "Mira" } }, targetFingerprint: "frozen-target" },
    request: request(), provider: "openrouter", model: MODEL, invoke: async () => result(), ...changes };
}

test("paid dossier dispatch commits its retained scoped hold before invocation and replays the exact result once", async () => {
  const db = await database(); let calls = 0;
  try {
    const run = params({ invoke: async () => {
      calls += 1;
      const row = await readEntityReviewCall(db, scope); assert.equal(row?.status, "dispatched");
      const hold = (await db.query<{ usage: Record<string, unknown> }>("SELECT usage FROM storyhold.credit_reservations WHERE id = $1", [reservationId])).rows[0]!;
      assert.equal(hold.usage.retainUntilReconciled, true); assert.equal(hold.usage.entityReviewJournalId, scope.reviewId);
      return { ...result(), priorBillableAttempts: [attempt()] };
    } });
    const first = await executeJournaledEntityReviewCall(db, run);
    const second = await executeJournaledEntityReviewCall(db, run);
    assert.equal(calls, 1); assert.deepEqual(second, first); assert.ok(first.journalCompletedAt);
    const row = await readEntityReviewCall(db, scope);
    assert.equal(row?.billable_attempts.length, 2); assert.equal(row?.reserved_credits, 30); assert.equal(row?.unlimited, false);
  } finally { await db.close(); }
});

test("completed dossier replay rejects changed frozen context, provider, request and funding", async () => {
  const db = await database(); let calls = 0;
  try {
    const invoke = async () => { calls += 1; return result(); };
    await executeJournaledEntityReviewCall(db, params({ invoke }));
    for (const changes of [
      { contextSnapshot: { input: { changed: true } } }, { model: "other-model" }, { provider: "anthropic" },
      { request: { ...request(), maxOutputTokens: 1400 } }, { reservationId: null },
    ]) await assert.rejects(executeJournaledEntityReviewCall(db, params({ invoke, ...changes })), code("REQUEST_MISMATCH"));
    assert.equal(calls, 1);
    await assert.rejects(readEntityReviewCall(db, { ...scope, playerId: uuid(99) }), code("SCOPE_MISMATCH"));
  } finally { await db.close(); }
});

test("a new review ID cannot bypass an existing unfinalized dossier call", async () => {
  const db = await database(); let calls = 0;
  try {
    const invoke = async () => { calls += 1; return result(); };
    await executeJournaledEntityReviewCall(db, params({ invoke }));
    await assert.rejects(executeJournaledEntityReviewCall(db, params({ scope: { ...scope, reviewId: uuid(10) }, invoke })), code("ENTITY_REVIEW_PENDING"));
    const pending = await findPendingEntityReviewCall(db, scope);
    assert.equal(pending?.review_id, scope.reviewId); assert.equal(pending?.status, "completed"); assert.equal(calls, 1);
  } finally { await db.close(); }
});

test("simultaneous same-ID and new-ID callers cannot dispatch while the original provider call is pending", async () => {
  const db = await database(); let calls = 0;
  let entered!: () => void; let finish!: () => void;
  const invoked = new Promise<void>((resolve) => { entered = resolve; });
  const finishProvider = new Promise<void>((resolve) => { finish = resolve; });
  const run = params({ invoke: async () => { calls += 1; entered(); await finishProvider; return result(); } });
  let first: Promise<AiTextResult> | undefined;
  try {
    first = executeJournaledEntityReviewCall(db, run); await invoked;
    assert.equal((await findPendingEntityReviewCall(db, scope))?.status, "dispatched");
    await assert.rejects(executeJournaledEntityReviewCall(db, run), code("OUTCOME_UNRESOLVED"));
    await assert.rejects(executeJournaledEntityReviewCall(db, { ...run, scope: { ...scope, reviewId: uuid(51) } }), code("ENTITY_REVIEW_PENDING"));
    assert.equal(calls, 1); finish(); await first;
  } finally { finish(); if (first) await first.catch(() => {}); await db.close(); }
});

test("journaled dossiers reject provider fallback policies that could conceal an unknown prior attempt", async () => {
  const db = await database(); let calls = 0;
  try {
    for (const unsafe of [{ ...request(), allowProviderFallback: true }, { ...request(), providerFailurePolicy: undefined }]) {
      await assert.rejects(executeJournaledEntityReviewCall(db, params({ request: unsafe, invoke: async () => { calls += 1; return result(); } })), code("REQUEST_INVALID"));
    }
    assert.equal(calls, 0); assert.equal(await readEntityReviewCall(db, scope), null);
  } finally { await db.close(); }
});

test("known rejected provider output is retained with exact billable usage and never automatically retried", async () => {
  const db = await database(); let calls = 0;
  try {
    const failure = new AiGatewayUnavailableError("Full private validation explanation", ["openrouter: invalid response"], [attempt()], false);
    const run = params({ invoke: async () => { calls += 1; throw failure; } });
    await assert.rejects(executeJournaledEntityReviewCall(db, run), (error) => error === failure);
    const row = await readEntityReviewCall(db, scope);
    assert.equal(row?.status, "rejected"); assert.deepEqual(row?.billable_attempts, [attempt()]);
    assert.match(row!.error!, /Full private validation explanation/);
    await assert.rejects(executeJournaledEntityReviewCall(db, run), code("PREVIOUSLY_REJECTED")); assert.equal(calls, 1);
    assert.equal((await db.transaction((tx) => lockEntityReviewCallForFinalization(tx, scope))).status, "rejected");
  } finally { await db.close(); }
});

for (const uncertainFlag of [undefined, true] as const) {
  test(`legacy or uncertain gateway metadata (${String(uncertainFlag)}) retains known attempts but blocks finalization`, async () => {
    const db = await database(); let calls = 0;
    try {
      const run = params({ invoke: async () => { calls += 1; throw new AiGatewayUnavailableError("A later outcome may be unknown", ["provider failure"], [attempt()], uncertainFlag); } });
      await assert.rejects(executeJournaledEntityReviewCall(db, run), code("OUTCOME_UNRESOLVED"));
      const row = await readEntityReviewCall(db, scope); assert.equal(row?.status, "uncertain"); assert.equal(row?.billable_attempts.length, 1);
      await assert.rejects(executeJournaledEntityReviewCall(db, run), code("OUTCOME_UNRESOLVED")); assert.equal(calls, 1);
      await assert.rejects(db.transaction((tx) => finalizeEntityReviewCall(tx, scope, { outcome: "not_applied" })), code("OUTCOME_UNRESOLVED"));
    } finally { await db.close(); }
  });
}

test("unknown failures are journaled without returning credits or dispatching another call", async () => {
  const db = await database();
  try {
    await assert.rejects(executeJournaledEntityReviewCall(db, params({ invoke: async () => { throw new Error("connection lost"); } })), code("OUTCOME_UNRESOLVED"));
    const row = await readEntityReviewCall(db, scope); assert.equal(row?.status, "uncertain"); assert.deepEqual(row?.billable_attempts, []);
    assert.equal((await db.query("SELECT status FROM storyhold.credit_reservations")).rows[0]?.status, "reserved");
  } finally { await db.close(); }
});

test("dossier finalization is immutable, idempotent and removes the pending review", async () => {
  const db = await database();
  try {
    await executeJournaledEntityReviewCall(db, params());
    const outcome = { outcome: "applied", response: { success: true } };
    await db.transaction((tx) => finalizeEntityReviewCall(tx, scope, outcome));
    await db.transaction((tx) => finalizeEntityReviewCall(tx, scope, outcome));
    assert.deepEqual((await readEntityReviewCall(db, scope))?.finalization_snapshot, outcome);
    assert.equal(await findPendingEntityReviewCall(db, scope), null);
    await assert.rejects(executeJournaledEntityReviewCall(db, params()), code("REVIEW_FINALIZED"));
    await assert.rejects(db.transaction((tx) => finalizeEntityReviewCall(tx, scope, { outcome: "not_applied" })), code("FINALIZATION_MISMATCH"));
    await assert.rejects(db.query("UPDATE storyhold.entity_review_ai_calls SET finalization_snapshot = '{}'"), /immutable/);
  } finally { await db.close(); }
});

test("only verified administrators may omit dossier credit reservations", async () => {
  const db = await database(); let calls = 0;
  try {
    const run = params({ scope: { ...scope, reviewId: uuid(50) }, reservationId: null, invoke: async () => { calls += 1; return result(); } });
    await assert.rejects(executeJournaledEntityReviewCall(db, run), code("RESERVATION_UNAVAILABLE")); assert.equal(calls, 0);
    await db.query("UPDATE storyhold.players SET role = 'admin'");
    await executeJournaledEntityReviewCall(db, run);
    const row = await readEntityReviewCall(db, run.scope); assert.equal(row?.unlimited, true); assert.equal(row?.reserved_credits, 0);
  } finally { await db.close(); }
});

test("wrong player, wrong operation, released holds and conflicting hold markers block before dispatch", async () => {
  for (const mutation of ["player_id = '00000000-0000-4000-8000-000000000099'", "operation = 'world_analysis'", "status = 'released'",
    "usage = '{\"entityReviewJournalId\":\"different\"}'"]) {
    const db = await database(); let calls = 0;
    try {
      await db.query(`UPDATE storyhold.credit_reservations SET ${mutation}`);
      await assert.rejects(executeJournaledEntityReviewCall(db, params({ invoke: async () => { calls += 1; return result(); } })), code("RESERVATION_UNAVAILABLE"));
      assert.equal(calls, 0); assert.equal(await readEntityReviewCall(db, scope), null);
    } finally { await db.close(); }
  }
});

test("malformed non-JSON frozen context is rejected before provider dispatch", async () => {
  const db = await database(); let calls = 0;
  try {
    await assert.rejects(executeJournaledEntityReviewCall(db, params({ contextSnapshot: { map: new Map() } as never,
      invoke: async () => { calls += 1; return result(); } })), code("REQUEST_INVALID"));
    assert.equal(calls, 0); assert.equal(await readEntityReviewCall(db, scope), null);
  } finally { await db.close(); }
});

test("paid-result persistence failure leaves dispatch unresolved and blocks a duplicate provider charge", async () => {
  const db = await database(); let calls = 0;
  try {
    const failing = { transaction: db.transaction.bind(db), query: (async (sql: string, values?: unknown[]) => {
      if (sql.includes("SET status = $3")) throw new Error("simulated storage loss");
      return db.query(sql, values);
    }) as PGlite["query"] };
    const run = params({ invoke: async () => { calls += 1; return result(); } });
    await assert.rejects(executeJournaledEntityReviewCall(failing, run), code("JOURNAL_PERSISTENCE"));
    assert.equal((await readEntityReviewCall(db, scope))?.status, "dispatched");
    await assert.rejects(executeJournaledEntityReviewCall(db, run), code("OUTCOME_UNRESOLVED")); assert.equal(calls, 1);
  } finally { await db.close(); }
});

test("journal triggers reject request/outcome mutation and reads detect corrupted fingerprints", async () => {
  const db = await database();
  try {
    await executeJournaledEntityReviewCall(db, params());
    await assert.rejects(db.query("UPDATE storyhold.entity_review_ai_calls SET context_snapshot = '{}'"), /immutable/);
    await assert.rejects(db.query("UPDATE storyhold.entity_review_ai_calls SET billable_attempts = '[]'"), /immutable/);
    await db.exec("ALTER TABLE storyhold.entity_review_ai_calls DISABLE TRIGGER entity_review_call_guard");
    await db.query("UPDATE storyhold.entity_review_ai_calls SET result_fingerprint = 'tampered'");
    await assert.rejects(readEntityReviewCall(db, scope), code("JOURNAL_INTEGRITY"));
    await assert.rejects(findPendingEntityReviewCall(db, scope), code("JOURNAL_INTEGRITY"));
  } finally { await db.close(); }
});

test("post-journal semantic failure reuses stored provider output rather than paying again", async () => {
  const db = await database(); let calls = 0;
  try {
    const run = params({ request: { ...request(), validate: () => { throw new Error("specific semantic gate failed"); } },
      invoke: async () => { calls += 1; return result(); } });
    await assert.rejects(executeJournaledEntityReviewCall(db, run), /specific semantic gate failed/);
    assert.equal((await readEntityReviewCall(db, scope))?.status, "completed");
    await assert.rejects(executeJournaledEntityReviewCall(db, run), /specific semantic gate failed/);
    assert.equal(calls, 1);
  } finally { await db.close(); }
});

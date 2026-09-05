import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  AiGatewayUnavailableError,
  type AiBillableAttempt,
  type AiTextResult,
  type GenerateAiTextInput,
} from "./aiGateway";
import {
  executeJournaledPremiumCall,
  PremiumJournalError,
  premiumReviewJournalSchemaSql,
  premiumReviewReconciliationPending,
  readPremiumJournalAccounting,
} from "./premiumReviewJournal";

const RUN_ID = "00000000-0000-4000-8000-000000000101";
const WORLD_ID = "00000000-0000-4000-8000-000000000102";
const PLAYER_ID = "00000000-0000-4000-8000-000000000103";
const RESERVATION_ID = "00000000-0000-4000-8000-000000000104";
const MODEL = "openai/gpt-5.6-luna-pro";

async function createDatabase() {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.world_analysis_runs (
      id uuid PRIMARY KEY, world_id uuid NOT NULL,
      requested_by_player_id uuid NOT NULL,
      status text NOT NULL DEFAULT 'running'
    );
    CREATE TABLE storyhold.credit_reservations (
      id uuid PRIMARY KEY, world_id uuid NOT NULL, player_id uuid NOT NULL,
      operation text NOT NULL, request_id text NOT NULL,
      status text NOT NULL DEFAULT 'reserved',
      usage jsonb NOT NULL DEFAULT '{}'::jsonb
    );
  `);
  await db.exec(premiumReviewJournalSchemaSql);
  await db.query(
    "INSERT INTO storyhold.world_analysis_runs (id, world_id, requested_by_player_id) VALUES ($1, $2, $3)",
    [RUN_ID, WORLD_ID, PLAYER_ID],
  );
  return db;
}

function request(): GenerateAiTextInput {
  return {
    task: "canon_review",
    stage: "verification",
    system: "Verify only the pinned manuscript evidence.",
    messages: [{ role: "user", content: "The keep stands on the eastern shore." }],
    reasoning: "high",
    maxOutputTokens: 1200,
    temperature: 0,
  };
}

function providerResult(): AiTextResult {
  return {
    text: '{"verified":true}',
    provider: "openrouter",
    model: MODEL,
    reasoning: "high",
    usage: {
      inputUnits: 1000,
      outputUnits: 100,
      cachedInputUnits: 100,
      cacheWriteInputUnits: 0,
      reasoningUnits: 30,
      estimatedCostMicros: 1500,
      pricingKnown: true,
      pricingVersion: "test-pricing-v1",
      costEstimated: true,
    },
    runtime: {
      configured: true,
      mode: "connected",
      provider: "openrouter",
      model: MODEL,
      billable: true,
      sendsSourceTextOffDevice: true,
      explanation: "Stubbed provider; no network or API keys.",
      stage: "verification",
      execution: {
        connectionId: "managed:openrouter",
        credentialSource: "environment",
        connectionSource: "storyhold_managed",
        billingSource: "storyhold_credits",
        requestedModel: MODEL,
        resolvedModel: `${MODEL}-resolved`,
        upstreamProvider: "test-upstream",
        privacyMode: "zero-data-retention",
      },
      localExtraction: {
        enabled: false,
        configured: false,
        provider: "gliner2",
        model: "test-local-model",
        endpoint: null,
        endpointKind: null,
        sendsSourceTextOffDevice: false,
        explanation: "Disabled in journal unit tests.",
      },
      providers: [],
      routing: {
        director: null, narration: null, adultNarration: null,
        analysis: null, canonReview: "openrouter",
      },
      stageRouting: {
        extraction: null, verification: "openrouter", dossier: null,
        chronology: null, director: null, narration: null, adaptation: null,
      },
    },
  };
}

function billableAttempt(): AiBillableAttempt {
  const result = providerResult();
  return {
    provider: result.provider,
    model: result.model,
    resolvedModel: `${MODEL}-resolved`,
    upstreamProvider: "test-upstream",
    stage: "verification",
    reasoning: result.reasoning,
    usage: { ...result.usage, estimatedCostMicros: 400 },
  };
}

function callParams(overrides: Partial<Parameters<typeof executeJournaledPremiumCall>[1]> = {}) {
  return {
    runId: RUN_ID,
    stepKey: "verify:batch:1",
    request: request(),
    provider: "openrouter",
    model: MODEL,
    invoke: async () => providerResult(),
    ...overrides,
  };
}

function journalError(code: PremiumJournalError["code"]) {
  return (error: unknown) => error instanceof PremiumJournalError && error.code === code;
}

test("exact replay validates the saved response and returns full usage without repeating the provider", async () => {
  const db = await createDatabase();
  try {
    let calls = 0;
    let validations = 0;
    const input = request();
    input.validate = (text) => {
      validations += 1;
      assert.deepEqual(JSON.parse(text), { verified: true });
    };
    const result = providerResult();
    result.priorBillableAttempts = [billableAttempt()];
    const params = callParams({
      request: input,
      invoke: async () => {
        calls += 1;
        input.validate?.(result.text);
        return result;
      },
    });
    const first = await executeJournaledPremiumCall(db, params);
    const second = await executeJournaledPremiumCall(db, params);
    assert.equal(calls, 1);
    assert.equal(validations, 2);
    assert.ok(first.journalCompletedAt);
    assert.ok(Number.isFinite(Date.parse(first.journalCompletedAt)));
    assert.deepEqual(first, { ...result, journalCompletedAt: first.journalCompletedAt });
    assert.deepEqual(second, first, "replay retains the original server timestamp");
    const accounting = await readPremiumJournalAccounting(db, RUN_ID);
    assert.equal(accounting.hasUncertain, false);
    assert.equal(accounting.callCount, 1);
    assert.equal(accounting.attempts.length, 2);
    assert.equal(accounting.attempts[0]?.usage.estimatedCostMicros, 400);
    assert.equal(accounting.attempts[1]?.usage.estimatedCostMicros, 1500);
    assert.equal(accounting.attempts[1]?.resolvedModel, `${MODEL}-resolved`);
    assert.equal(accounting.attempts[1]?.upstreamProvider, "test-upstream");
    const snapshot = await db.query<{ request_snapshot: Record<string, unknown> }>(
      "SELECT request_snapshot FROM storyhold.world_analysis_ai_calls",
    );
    assert.equal(JSON.stringify(snapshot.rows[0]).includes("validate"), false);
  } finally {
    await db.close();
  }
});

test("changed prompt, model, provider, or pinned scope blocks replay; callback and key order do not", async () => {
  const db = await createDatabase();
  try {
    let calls = 0;
    const params = callParams({
      scopeFingerprint: "scope-original",
      invoke: async () => { calls += 1; return providerResult(); },
    });
    await executeJournaledPremiumCall(db, params);
    for (const changed of [
      { request: { ...request(), system: "Changed prompt" } },
      { model: "different/model" },
      { provider: "openai" },
      { scopeFingerprint: "different-owner-constraint-snapshot" },
    ]) {
      await assert.rejects(executeJournaledPremiumCall(db, { ...params, ...changed }), journalError("REQUEST_MISMATCH"));
    }
    await executeJournaledPremiumCall(db, {
      ...params,
      request: { ...request(), messages: [{ content: request().messages[0]!.content, role: "user" }], validate: () => {} },
    });
    assert.equal(calls, 1);
  } finally {
    await db.close();
  }
});

test("a concurrent duplicate sees committed dispatch and cannot start a second call", async () => {
  const db = await createDatabase();
  try {
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    let releaseProvider!: (result: AiTextResult) => void;
    const provider = new Promise<AiTextResult>((resolve) => { releaseProvider = resolve; });
    let calls = 0;
    const params = callParams({ invoke: async () => {
      calls += 1;
      announceStarted();
      return provider;
    } });
    const first = executeJournaledPremiumCall(db, params);
    await started;
    assert.equal(await premiumReviewReconciliationPending(db, WORLD_ID), true);
    await assert.rejects(executeJournaledPremiumCall(db, params), journalError("OUTCOME_UNRESOLVED"));
    assert.deepEqual(await readPremiumJournalAccounting(db, RUN_ID), {
      attempts: [], hasUncertain: true, callCount: 1,
    });
    releaseProvider(providerResult());
    await first;
    assert.equal(await premiumReviewReconciliationPending(db, WORLD_ID), false);
    await executeJournaledPremiumCall(db, params);
    assert.equal(calls, 1);
  } finally {
    await db.close();
  }
});

test("unknown provider outcomes are durable, explicitly terminal, and never redispatched", async () => {
  const db = await createDatabase();
  try {
    let calls = 0;
    const params = callParams({ invoke: async () => {
      calls += 1;
      throw new Error("Connection disappeared after dispatch");
    } });
    await assert.rejects(executeJournaledPremiumCall(db, params), journalError("OUTCOME_UNRESOLVED"));
    await assert.rejects(executeJournaledPremiumCall(db, params), journalError("OUTCOME_UNRESOLVED"));
    assert.equal(calls, 1);
    assert.deepEqual(await readPremiumJournalAccounting(db, RUN_ID), {
      attempts: [], hasUncertain: true, callCount: 1,
    });
    const state = await db.query<{ status: string }>("SELECT status FROM storyhold.world_analysis_ai_calls");
    assert.equal(state.rows[0]?.status, "uncertain");
  } finally {
    await db.close();
  }
});

test("gateway validation rejection keeps billable attempts and blocks another dispatch", async () => {
  const db = await createDatabase();
  try {
    const failure = new AiGatewayUnavailableError("Invalid response", ["schema validation failed"], [billableAttempt()], false);
    let calls = 0;
    const params = callParams({ invoke: async () => { calls += 1; throw failure; } });
    await assert.rejects(executeJournaledPremiumCall(db, params), (error) => error === failure);
    await assert.rejects(executeJournaledPremiumCall(db, params), journalError("PREVIOUSLY_REJECTED"));
    assert.equal(calls, 1);
    assert.deepEqual(await readPremiumJournalAccounting(db, RUN_ID), {
      attempts: [billableAttempt()], hasUncertain: false, callCount: 1,
    });
    await db.query("UPDATE storyhold.world_analysis_ai_calls SET billable_attempts = '[]'::jsonb");
    await assert.rejects(readPremiumJournalAccounting(db, RUN_ID), journalError("JOURNAL_INTEGRITY"));
  } finally {
    await db.close();
  }
});

test("known billable attempts do not erase an uncertain provider outcome", async () => {
  for (const uncertainty of [true, undefined] as const) {
    const db = await createDatabase();
    try {
      const failure = new AiGatewayUnavailableError(
        "A billable response was followed by an outcome that could not be confirmed",
        ["first response rejected", "second response disappeared"],
        [billableAttempt()],
        uncertainty,
      );
      let calls = 0;
      const params = callParams({
        invoke: async () => {
          calls += 1;
          throw failure;
        },
      });
      await assert.rejects(executeJournaledPremiumCall(db, params), journalError("OUTCOME_UNRESOLVED"));
      await assert.rejects(executeJournaledPremiumCall(db, params), journalError("OUTCOME_UNRESOLVED"));
      assert.equal(calls, 1);
      assert.deepEqual(await readPremiumJournalAccounting(db, RUN_ID), {
        attempts: [billableAttempt()], hasUncertain: true, callCount: 1,
      });
      const state = await db.query<{ status: string }>("SELECT status FROM storyhold.world_analysis_ai_calls");
      assert.equal(state.rows[0]?.status, "uncertain");
    } finally {
      await db.close();
    }
  }
});

test("successful usage survives a downstream callback interruption and failing replay validation", async () => {
  const db = await createDatabase();
  try {
    let calls = 0;
    const params = callParams({ invoke: async () => { calls += 1; return providerResult(); } });
    await assert.rejects(async () => {
      await executeJournaledPremiumCall(db, params);
      throw new Error("Progress callback interrupted");
    }, /Progress callback interrupted/);
    await assert.rejects(executeJournaledPremiumCall(db, {
      ...params,
      request: { ...params.request, validate: () => { throw new Error("New validation rejected"); } },
    }), /New validation rejected/);
    const accounting = await readPremiumJournalAccounting(db, RUN_ID);
    assert.equal(accounting.attempts[0]?.usage.estimatedCostMicros, 1500);
    assert.equal(accounting.hasUncertain, false);
    const replayed = await executeJournaledPremiumCall(db, params);
    assert.ok(replayed.journalCompletedAt);
    assert.deepEqual(replayed, { ...providerResult(), journalCompletedAt: replayed.journalCompletedAt });
    assert.equal(calls, 1);
  } finally {
    await db.close();
  }
});

test("a failed result write leaves dispatch unresolved and prevents paid retries", async () => {
  const db = await createDatabase();
  try {
    await db.exec(`
      CREATE FUNCTION storyhold.fail_journal_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Simulated persistence outage'; END;
      $$;
      CREATE TRIGGER fail_journal_write BEFORE UPDATE ON storyhold.world_analysis_ai_calls
      FOR EACH ROW EXECUTE FUNCTION storyhold.fail_journal_write();
    `);
    let calls = 0;
    const params = callParams({ invoke: async () => { calls += 1; return providerResult(); } });
    await assert.rejects(executeJournaledPremiumCall(db, params), journalError("JOURNAL_PERSISTENCE"));
    await assert.rejects(executeJournaledPremiumCall(db, params), journalError("OUTCOME_UNRESOLVED"));
    assert.equal(calls, 1);
    assert.deepEqual(await readPremiumJournalAccounting(db, RUN_ID), {
      attempts: [], hasUncertain: true, callCount: 1,
    });
  } finally {
    await db.close();
  }
});

test("the matching credit hold is retained atomically before provider dispatch", async () => {
  const db = await createDatabase();
  try {
    await db.query(
      `INSERT INTO storyhold.credit_reservations
        (id, world_id, player_id, operation, request_id, usage)
       VALUES ($1, $2, $3, 'world_analysis', $4, '{"existing":"metadata"}'::jsonb)`,
      [RESERVATION_ID, WORLD_ID, PLAYER_ID, RUN_ID],
    );
    await executeJournaledPremiumCall(db, callParams({ reservationId: RESERVATION_ID, invoke: async () => {
      const held = await db.query<{ usage: Record<string, unknown> }>(
        "SELECT usage FROM storyhold.credit_reservations WHERE id = $1", [RESERVATION_ID],
      );
      assert.deepEqual(held.rows[0]?.usage, { existing: "metadata", retainUntilReconciled: true });
      assert.equal((await readPremiumJournalAccounting(db, RUN_ID)).hasUncertain, true);
      return providerResult();
    } }));
    await db.query("DELETE FROM storyhold.world_analysis_runs WHERE id = $1", [RUN_ID]);
    assert.deepEqual(await readPremiumJournalAccounting(db, RUN_ID), { attempts: [], hasUncertain: false, callCount: 0 });
  } finally {
    await db.close();
  }
});

test("a missing, finalized, or wrong-scope reservation prevents dispatch and rolls back the journal insert", async () => {
  const db = await createDatabase();
  try {
    let calls = 0;
    const params = callParams({ reservationId: RESERVATION_ID, invoke: async () => { calls += 1; return providerResult(); } });
    await assert.rejects(executeJournaledPremiumCall(db, params), journalError("RESERVATION_UNAVAILABLE"));
    await db.query(
      `INSERT INTO storyhold.credit_reservations
        (id, world_id, player_id, operation, request_id, status)
       VALUES ($1, $2, $3, 'world_analysis', $4, 'settled')`,
      [RESERVATION_ID, WORLD_ID, PLAYER_ID, RUN_ID],
    );
    await assert.rejects(executeJournaledPremiumCall(db, params), journalError("RESERVATION_UNAVAILABLE"));
    await db.query("UPDATE storyhold.credit_reservations SET status = 'reserved', request_id = 'another-run'");
    await assert.rejects(executeJournaledPremiumCall(db, params), journalError("RESERVATION_UNAVAILABLE"));
    await db.query("UPDATE storyhold.credit_reservations SET request_id = $1, world_id = $2", [RUN_ID, PLAYER_ID]);
    await assert.rejects(executeJournaledPremiumCall(db, params), journalError("RESERVATION_UNAVAILABLE"));
    await db.query("UPDATE storyhold.credit_reservations SET world_id = $1, player_id = $2", [WORLD_ID, WORLD_ID]);
    await assert.rejects(executeJournaledPremiumCall(db, params), journalError("RESERVATION_UNAVAILABLE"));
    assert.equal(calls, 0);
    assert.equal((await readPremiumJournalAccounting(db, RUN_ID)).callCount, 0);
    const held = await db.query<{ usage: Record<string, unknown> }>("SELECT usage FROM storyhold.credit_reservations");
    assert.deepEqual(held.rows[0]?.usage, {});
  } finally {
    await db.close();
  }
});

test("tampered completed result or request is rejected on both replay and accounting", async () => {
  const db = await createDatabase();
  try {
    let calls = 0;
    const params = callParams({ invoke: async () => { calls += 1; return providerResult(); } });
    await executeJournaledPremiumCall(db, params);
    await db.query(
      `UPDATE storyhold.world_analysis_ai_calls
          SET result_snapshot = jsonb_set(result_snapshot, '{text}', '"tampered"'::jsonb)`,
    );
    await assert.rejects(executeJournaledPremiumCall(db, params), journalError("JOURNAL_INTEGRITY"));
    await assert.rejects(readPremiumJournalAccounting(db, RUN_ID), journalError("JOURNAL_INTEGRITY"));
    await executeJournaledPremiumCall(db, { ...params, stepKey: "verify:batch:2" });
    await db.query(
      `UPDATE storyhold.world_analysis_ai_calls SET request_snapshot = '{}'::jsonb
        WHERE step_key = 'verify:batch:2'`,
    );
    await assert.rejects(executeJournaledPremiumCall(db, { ...params, stepKey: "verify:batch:2" }), journalError("JOURNAL_INTEGRITY"));
    assert.equal(calls, 2);
  } finally {
    await db.close();
  }
});

test("world reconciliation guard isolates worlds and includes terminal runs with retained holds", async () => {
  const db = await createDatabase();
  const otherWorld = "00000000-0000-4000-8000-000000000201";
  const otherRun = "00000000-0000-4000-8000-000000000202";
  try {
    await db.query(
      "INSERT INTO storyhold.world_analysis_runs (id, world_id, requested_by_player_id) VALUES ($1, $2, $3)",
      [otherRun, otherWorld, PLAYER_ID],
    );
    assert.equal(await premiumReviewReconciliationPending(db, WORLD_ID), false);
    assert.equal(await premiumReviewReconciliationPending(db, otherWorld), false);
    await executeJournaledPremiumCall(db, callParams());
    await db.query("UPDATE storyhold.world_analysis_runs SET status = 'completed' WHERE id = $1", [RUN_ID]);
    await db.query(
      `INSERT INTO storyhold.credit_reservations
        (id, world_id, player_id, operation, request_id, usage)
       VALUES ($1, $2, $3, 'world_analysis', $4, '{"retainUntilReconciled":true}'::jsonb)`,
      [RESERVATION_ID, WORLD_ID, PLAYER_ID, RUN_ID],
    );
    assert.equal(await premiumReviewReconciliationPending(db, WORLD_ID), true);
    assert.equal(await premiumReviewReconciliationPending(db, otherWorld), false);
    await db.query("UPDATE storyhold.credit_reservations SET status = 'settled'");
    assert.equal(await premiumReviewReconciliationPending(db, WORLD_ID), false);
    await assert.rejects(executeJournaledPremiumCall(db, callParams({
      runId: otherRun,
      invoke: async () => { throw new Error("Unknown charge outcome"); },
    })), journalError("OUTCOME_UNRESOLVED"));
    await db.query("UPDATE storyhold.world_analysis_runs SET status = 'failed' WHERE id = $1", [otherRun]);
    assert.equal(await premiumReviewReconciliationPending(db, otherWorld), true);
    assert.equal(await premiumReviewReconciliationPending(db, WORLD_ID), false);
  } finally {
    await db.close();
  }
});

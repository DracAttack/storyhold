import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { AiGatewayUnavailableError, type AiBillableAttempt, type AiTextResult, type AiUsage, type GenerateAiTextInput } from "./aiGateway";
import { creditEconomySchemaSql, creditsForProviderCost, reserveCredits, releaseCreditReservation, type CreditReservation } from "./creditEconomy";
import {
  savedEntityReviewFundingStatus,
  settleEntityReviewAccountingInTransaction,
} from "./entityReviewAccounting";
import { entityReviewJournalSchemaSql, executeJournaledEntityReviewCall, readEntityReviewCall, type EntityReviewCallScope } from "./entityReviewJournal";

const scope: EntityReviewCallScope = {
  reviewId: "00000000-0000-4000-8000-000000000981", playerId: "00000000-0000-4000-8000-000000000982",
  worldId: "00000000-0000-4000-8000-000000000983", editionId: "00000000-0000-4000-8000-000000000984",
  entityId: "00000000-0000-4000-8000-000000000985",
};
const request: GenerateAiTextInput = { task: "canon_review", stage: "dossier", system: "Review the exact supplied dossier.", messages: [{ role: "user", content: "Mara lifted the gate." }], reasoning: "high", maxOutputTokens: 6000, temperature: 0, allowProviderFallback: false, providerFailurePolicy: "stop" };
const contextSnapshot = { entityId: scope.entityId, depth: "focused", source: "Mara lifted the gate." };
function usage(cost = 24_000): AiUsage {
  return { inputUnits: 1000, outputUnits: 200, cachedInputUnits: 100, cacheWriteInputUnits: 20, reasoningUnits: 50,
    estimatedCostMicros: cost, pricingKnown: true, pricingVersion: "test-price-v1", costEstimated: true };
}
function attempt(cost = 6000, model = "earlier-resolved-model"): AiBillableAttempt {
  return { provider: "openrouter", model: "earlier-requested-model", resolvedModel: model, upstreamProvider: "earlier-upstream", stage: "dossier", reasoning: "medium", usage: usage(cost) };
}
function providerResult(cost = 24_000, priorBillableAttempts: AiBillableAttempt[] = []): AiTextResult {
  return { text: '{"summary":"Mara lifted the gate."}', provider: "openrouter", model: "requested-model", reasoning: "high", usage: usage(cost), priorBillableAttempts,
    runtime: { configured: true, mode: "connected", provider: "openrouter", model: "requested-model", billable: true, sendsSourceTextOffDevice: true,
      explanation: "Synthetic accounting test; no provider is contacted.", stage: "dossier",
      execution: { connectionId: "managed:openrouter", credentialSource: "environment", connectionSource: "storyhold_managed", billingSource: "storyhold_credits",
        requestedModel: "requested-model", resolvedModel: "actual-resolved-model", upstreamProvider: "actual-upstream", privacyMode: "zero-data-retention" },
      localExtraction: { enabled: false, configured: false, provider: "gliner2", model: "disabled", endpoint: null, endpointKind: null, sendsSourceTextOffDevice: false, explanation: "Disabled." },
      providers: [], routing: { director: null, narration: null, adultNarration: null, analysis: null, canonReview: "openrouter" },
      stageRouting: { extraction: null, verification: null, dossier: "openrouter", chronology: null, director: null, narration: null, adaptation: null } } };
}
async function fixture(role = "player", credits = 100, reserved = 20): Promise<{ db: PGlite; hold: CreditReservation }> {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.players (id uuid PRIMARY KEY, role text NOT NULL, credits integer NOT NULL CHECK(credits>=0), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE storyhold.worlds (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.campaigns (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.world_entities (id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL, name text NOT NULL);
    CREATE TABLE storyhold.ai_usage_ledger (id uuid PRIMARY KEY, player_id uuid, world_id uuid, campaign_id uuid, operation text,
      provider text, model text, input_units integer, output_units integer, cost_micros bigint, cache_hit boolean,
      metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());`);
  await db.exec(creditEconomySchemaSql);
  await db.exec(entityReviewJournalSchemaSql);
  await db.query("INSERT INTO storyhold.players (id, role, credits) VALUES ($1,$2,$3)", [scope.playerId, role, credits]);
  await db.query("INSERT INTO storyhold.worlds VALUES ($1)", [scope.worldId]);
  await db.query("INSERT INTO storyhold.world_entities VALUES ($1,$2,$3,'Mara')", [scope.entityId, scope.worldId, scope.editionId]);
  const hold = await reserveCredits(db, { playerId: scope.playerId, worldId: scope.worldId, operation: "entity_review", requestId: scope.reviewId, requiredCredits: reserved, metadata: { entityId: scope.entityId } });
  return { db, hold };
}
async function dispatch(db: PGlite, hold: CreditReservation, invoke: () => Promise<AiTextResult> = async () => providerResult()) {
  return executeJournaledEntityReviewCall(db, { scope, reservationId: hold.id, contextSnapshot,
    request, provider: "openrouter", model: "requested-model", invoke });
}
async function settle(db: PGlite, outcome: "applied" | "not_applied" = "applied", response = {}) {
  return db.transaction((tx) => settleEntityReviewAccountingInTransaction(tx, { scope, outcome, response }));
}
async function state(db: PGlite) {
  return {
    credits: (await db.query("SELECT credits FROM storyhold.players WHERE id = $1", [scope.playerId])).rows,
    holds: (await db.query("SELECT * FROM storyhold.credit_reservations ORDER BY id")).rows,
    ledger: (await db.query("SELECT * FROM storyhold.credit_ledger ORDER BY id")).rows,
    usage: (await db.query("SELECT * FROM storyhold.ai_usage_ledger ORDER BY id")).rows,
    journal: await readEntityReviewCall(db, scope),
  };
}
async function economy(run: () => Promise<void>) {
  const names = ["STORYHOLD_RETAIL_MICROS_PER_CREDIT", "STORYHOLD_TARGET_GROSS_MARGIN_BPS"] as const;
  const previous = names.map((name) => process.env[name]);
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  try {
    process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT = "20000"; process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS = "4000";
    globalThis.fetch = async () => { fetches += 1; throw new Error("Network is forbidden in accounting tests."); };
    await run(); assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
  }
}

test("successful dossier settlement charges prior failed responses and success once at actual routed models", async () => {
  await economy(async () => {
    const { db, hold } = await fixture();
    try {
      const prior = [attempt(6000), { ...attempt(12_000, "second-resolved"), provider: "xai" as const }];
      await dispatch(db, hold, async () => providerResult(24_000, prior));
      const finalized = await settle(db, "applied", { depth: "full", passageCount: 9, reviewed: false, creditsUsed: 999, model: "spoof" });
      assert.deepEqual(finalized, { depth: "full", passageCount: 9, reviewed: true, entityId: scope.entityId, creditsUsed: 4, creditsRemaining: 96, unlimited: false });
      const rows = (await db.query<Record<string, unknown>>("SELECT * FROM storyhold.ai_usage_ledger ORDER BY (metadata->>'attemptIndex')::integer")).rows;
      assert.equal(rows.length, 3);
      assert.deepEqual(rows.map((row) => row.provider), ["openrouter", "xai", "openrouter"]);
      assert.deepEqual(rows.map((row) => row.model), ["earlier-resolved-model", "second-resolved", "actual-resolved-model"]);
      assert.equal(rows.reduce((sum, row) => sum + Number(row.cost_micros), 0), 42_000);
      assert.equal(rows.reduce((sum, row) => sum + Number(row.credits_charged), 0), 4);
      assert.ok(rows.every((row) => row.request_id === scope.reviewId && row.player_id === scope.playerId && row.world_id === scope.worldId));
      assert.deepEqual(rows.map((row) => [row.input_units, row.output_units, row.cached_input_units, row.cache_write_input_units, row.reasoning_units]), Array.from({ length: 3 }, () => [1000, 200, 100, 20, 50]));
      const reserved = (await db.query<Record<string, unknown>>("SELECT * FROM storyhold.credit_reservations WHERE id = $1", [hold.id])).rows[0]!;
      assert.equal(reserved.status, "settled"); assert.equal(Number(reserved.cost_micros), 42_000); assert.equal(reserved.actual_credits, 4);
      assert.equal((reserved.usage as Record<string, unknown>).accountingSource, "entity_review_journal");
      assert.equal((reserved.usage as { billableAttempts: unknown[] }).billableAttempts.length, 3);
      assert.deepEqual((await readEntityReviewCall(db, scope))!.finalization_snapshot, finalized);
      const after = await state(db);
      assert.deepEqual(await settle(db, "not_applied", { depth: "changed", creditsUsed: 900 }), finalized);
      assert.deepEqual(await state(db), after, "repeated settlement reuses the exact response without ledger or balance mutations");
    } finally { await db.close(); }
  });
});

test("known rejected provider outputs are charged without claiming dossier application", async () => {
  await economy(async () => {
    const { db, hold } = await fixture();
    try {
      const attempts = [attempt(6000), attempt(7000, "second-rejected-model")];
      await assert.rejects(dispatch(db, hold, async () => { throw new AiGatewayUnavailableError("Responses did not validate.", ["first", "second"], attempts, false); }), /did not validate/);
      assert.equal((await readEntityReviewCall(db, scope))!.status, "rejected");
      const before = await state(db);
      await assert.rejects(settle(db, "applied"), /rejected.*applied/);
      assert.deepEqual(await state(db), before);
      const outcome = await settle(db, "not_applied");
      assert.equal(outcome.reviewed, false); assert.equal(outcome.creditsUsed, creditsForProviderCost(13_000));
      assert.equal(Object.hasOwn(outcome, "model"), false);
      assert.equal(Object.hasOwn(outcome, "provider"), false);
      assert.equal((await db.query("SELECT id FROM storyhold.ai_usage_ledger")).rows.length, 2);
      assert.equal((await db.query<{ name: string }>("SELECT name FROM storyhold.world_entities WHERE id = $1", [scope.entityId])).rows[0]!.name, "Mara");
    } finally { await db.close(); }
  });
});

test("completed but stale dossier work can settle known cost without writing canon", async () => {
  await economy(async () => {
    const { db, hold } = await fixture();
    try {
      await dispatch(db, hold);
      await db.query("UPDATE storyhold.world_entities SET name = 'Owner renamed Mara' WHERE id = $1", [scope.entityId]);
      const outcome = await settle(db, "not_applied", { reason: "The owner changed this dossier during review." });
      assert.equal(outcome.reviewed, false); assert.equal(outcome.creditsUsed, 2);
      assert.equal((await db.query<{ name: string }>("SELECT name FROM storyhold.world_entities WHERE id = $1", [scope.entityId])).rows[0]!.name, "Owner renamed Mara");
    } finally { await db.close(); }
  });
});

test("canonical save, usage, credits, and finalization roll back together then retry once", async () => {
  await economy(async () => {
    const { db, hold } = await fixture();
    try {
      await dispatch(db, hold);
      const before = await state(db);
      await assert.rejects(db.transaction(async (tx) => {
        await tx.query("UPDATE storyhold.world_entities SET name = 'New canonical value' WHERE id = $1", [scope.entityId]);
        await settleEntityReviewAccountingInTransaction(tx, { scope, outcome: "applied" });
        throw new Error("Synthetic canonical transaction failure");
      }), /Synthetic/);
      assert.deepEqual(await state(db), before);
      assert.equal((await db.query<{ name: string }>("SELECT name FROM storyhold.world_entities WHERE id = $1", [scope.entityId])).rows[0]!.name, "Mara");
      const outcome = await db.transaction(async (tx) => {
        await tx.query("UPDATE storyhold.world_entities SET name = 'New canonical value' WHERE id = $1", [scope.entityId]);
        return settleEntityReviewAccountingInTransaction(tx, { scope, outcome: "applied" });
      });
      assert.equal(outcome.creditsUsed, 2);
      assert.equal((await db.query("SELECT id FROM storyhold.ai_usage_ledger")).rows.length, 1);
    } finally { await db.close(); }
  });
});

test("unlimited administrator reviews retain actual usage without any credits or reservation", async () => {
  await economy(async () => {
    const { db, hold } = await fixture("admin");
    try {
      assert.equal(hold.id, null); assert.equal(hold.unlimited, true);
      await dispatch(db, hold, async () => providerResult(24_000, [attempt(6000)]));
      const outcome = await settle(db);
      assert.equal(outcome.unlimited, true); assert.equal(outcome.creditsUsed, 0); assert.equal(outcome.creditsRemaining, 100);
      const rows = (await db.query<Record<string, unknown>>("SELECT * FROM storyhold.ai_usage_ledger")).rows;
      assert.equal(rows.length, 2); assert.equal(rows.reduce((sum, row) => sum + Number(row.cost_micros), 0), 30_000);
      assert.ok(rows.every((row) => row.credits_charged === 0));
      assert.equal((await db.query("SELECT id FROM storyhold.credit_reservations")).rows.length, 0);
      assert.equal((await db.query("SELECT id FROM storyhold.credit_ledger")).rows.length, 0);
    } finally { await db.close(); }
  });
});

test("unknown outcomes keep protected holds and cannot be charged or refunded by catch handlers", async () => {
  await economy(async () => {
    const { db, hold } = await fixture();
    try {
      await assert.rejects(dispatch(db, hold, async () => { throw new AiGatewayUnavailableError("Unknown timeout", ["first", "timeout"], [attempt(6000)], true); }), /uncertain/);
      assert.equal((await readEntityReviewCall(db, scope))!.status, "uncertain");
      const before = await state(db);
      await assert.rejects(settle(db, "not_applied"), /unknown|unresolved/);
      await releaseCreditReservation(db, hold.id, "automatic error cleanup");
      assert.deepEqual(await state(db), before);
    } finally { await db.close(); }
  });
});

test("in-flight dispatched work cannot settle or refund before its actual provider outcome", async () => {
  await economy(async () => {
    const { db, hold } = await fixture();
    let release: (() => void) | undefined;
    let markEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = dispatch(db, hold, async () => { markEntered!(); await gate; return providerResult(); });
    try {
      await entered;
      assert.equal((await readEntityReviewCall(db, scope))!.status, "dispatched");
      const before = await state(db);
      await assert.rejects(settle(db, "not_applied"), /unknown|unresolved/);
      await releaseCreditReservation(db, hold.id, "provider still running");
      assert.deepEqual(await state(db), before);
      release!(); await running;
      assert.equal((await settle(db)).creditsUsed, 2);
    } finally { release!(); await running; await db.close(); }
  });
});

test("unknown pricing or invalid counters never become a zero-cost settlement", async () => {
  await economy(async () => {
    for (const override of [{ pricingKnown: false }, { inputUnits: -1 }, { estimatedCostMicros: 0.5 }]) {
      const { db, hold } = await fixture();
      try {
        await dispatch(db, hold, async () => { const output = providerResult(); Object.assign(output.usage, override); return output; });
        const before = await state(db);
        await assert.rejects(settle(db, "not_applied"), /unknown|incomplete/);
        assert.deepEqual(await state(db), before);
      } finally { await db.close(); }
    }
  });
});

test("dossier settlement waits for a top-up instead of finalizing with uncovered usage", async () => {
  await economy(async () => {
    const { db, hold } = await fixture("player", 5, 2);
    try {
      await dispatch(db, hold, async () => providerResult(120_000));
      let providerInvocations = 0;
      const savedBeforeFunding = (await readEntityReviewCall(db, scope))!;
      assert.deepEqual(savedEntityReviewFundingStatus(savedBeforeFunding, 3), {
        settlementReady: false,
        topUpCreditsNeeded: 5,
        additionalCreditsDue: 8,
      });
      const before = await state(db);
      await assert.rejects(settle(db), /remaining balance cannot cover/i);
      assert.deepEqual(await state(db), before);

      // Reopening the exact call proves the saved provider result is reused;
      // the callback is never invoked a second time.
      const replay = await executeJournaledEntityReviewCall(db, {
        scope,
        reservationId: hold.id,
        contextSnapshot,
        request,
        provider: "openrouter",
        model: "requested-model",
        invoke: async () => {
          providerInvocations += 1;
          return providerResult(120_000);
        },
      });
      assert.equal(providerInvocations, 0);
      assert.equal(replay.text, '{"summary":"Mara lifted the gate."}');

      // The completed provider response remains journaled. After a top-up the
      // exact same response settles without another dispatch or duplicate row.
      await db.query("UPDATE storyhold.players SET credits = 8 WHERE id = $1", [scope.playerId]);
      assert.deepEqual(savedEntityReviewFundingStatus((await readEntityReviewCall(db, scope))!, 8), {
        settlementReady: true,
        topUpCreditsNeeded: 0,
        additionalCreditsDue: 8,
      });
      const outcome = await settle(db);
      assert.equal(outcome.creditsUsed, 10); assert.equal(outcome.creditsRemaining, 0);
      const row = (await db.query<{ usage: { uncoveredCredits: number } }>("SELECT usage FROM storyhold.credit_reservations WHERE id = $1", [hold.id])).rows[0]!;
      assert.equal(row.usage.uncoveredCredits, 0);
      const ledger = (await db.query<{ credits_charged: number }>("SELECT credits_charged FROM storyhold.ai_usage_ledger")).rows;
      assert.deepEqual(ledger, [{ credits_charged: 10 }]);
      assert.deepEqual(await settle(db), outcome, "replay applies and bills exactly once");
      assert.equal((await db.query("SELECT id FROM storyhold.ai_usage_ledger")).rows.length, 1);
    } finally { await db.close(); }
  });
});

test("wrong scope and altered funding fail without mutating the original account", async () => {
  await economy(async () => {
    const { db, hold } = await fixture();
    try {
      await dispatch(db, hold);
      const before = await state(db);
      await assert.rejects(db.transaction((tx) => settleEntityReviewAccountingInTransaction(tx, { scope: { ...scope, playerId: "00000000-0000-4000-8000-000000000999" }, outcome: "not_applied" })), /scope/);
      assert.deepEqual(await state(db), before);
      await db.query("UPDATE storyhold.credit_reservations SET request_id = 'wrong-review' WHERE id = $1", [hold.id]);
      const altered = await state(db);
      await assert.rejects(settle(db, "not_applied"), /credit reservation/);
      assert.deepEqual(await state(db), altered);
    } finally { await db.close(); }
  });
});

test("stray preexisting usage without finalization triggers investigation instead of duplicate billing", async () => {
  await economy(async () => {
    const { db, hold } = await fixture();
    try {
      await dispatch(db, hold);
      await db.query("INSERT INTO storyhold.ai_usage_ledger (id, operation, request_id) VALUES ('00000000-0000-4000-8000-000000000988','entity_review',$1)", [scope.reviewId]);
      const before = await state(db);
      await assert.rejects(settle(db), /Usage exists/);
      assert.deepEqual(await state(db), before);
    } finally { await db.close(); }
  });
});

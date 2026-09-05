import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  priceReportedAiUsage,
  quoteAiCostReservation,
  type AiUsage,
} from "./aiGateway";
import {
  CreditEconomyError,
  creditEconomySchemaSql,
  creditsForProviderCost,
  creditsForReservationQuote,
  creditsForUsage,
  reserveCredits,
  restorePremiumCreditReservation,
  releaseCreditReservation,
  releaseExpiredCreditReservations,
  settleCreditReservationInTransaction,
  settleFixedCreditReservationInTransaction,
} from "./creditEconomy";

function withEconomyEnvironment(run: () => void) {
  const names = [
    "STORYHOLD_RETAIL_MICROS_PER_CREDIT",
    "STORYHOLD_TARGET_GROSS_MARGIN_BPS",
    "STORYHOLD_ANTHROPIC_API_KEY",
    "ANTHROPIC_API_KEY",
    "STORYHOLD_OPENAI_API_KEY",
    "OPENAI_API_KEY",
    "STORYHOLD_XAI_API_KEY",
    "XAI_API_KEY",
    "STORYHOLD_KIMI_API_KEY",
    "KIMI_API_KEY",
    "MOONSHOT_API_KEY",
    "STORYHOLD_OPENAI_MODEL",
  ] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT = "20000";
    process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS = "4000";
    run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function createCreditEconomyDatabase() {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.players (
      id uuid PRIMARY KEY,
      role text NOT NULL,
      credits integer NOT NULL CHECK (credits >= 0),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE storyhold.worlds (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.campaigns (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.ai_usage_ledger (id uuid PRIMARY KEY);
  `);
  await db.exec(creditEconomySchemaSql);
  return db;
}

test("expiry cannot refund a paid request awaiting reconciliation", async () => {
  const db = await createCreditEconomyDatabase();
  const playerId = "00000000-0000-4000-8000-000000000104";
  try {
    await db.query("INSERT INTO storyhold.players (id, role, credits) VALUES ($1, 'player', 20)", [playerId]);
    const protectedHold = await reserveCredits(db, {
      playerId, operation: "world_analysis", requestId: "uncertain-review", requiredCredits: 5,
    });
    const unusedHold = await reserveCredits(db, {
      playerId, operation: "world_analysis", requestId: "unused-review", requiredCredits: 3,
    });
    await db.query(`UPDATE storyhold.credit_reservations SET expires_at = now() - interval '1 hour'`);
    await db.query(`UPDATE storyhold.credit_reservations SET usage = '{"retainUntilReconciled":true}'::jsonb WHERE id = $1`, [protectedHold.id]);
    assert.equal(await releaseExpiredCreditReservations(db, playerId), 1);
    await releaseCreditReservation(db, protectedHold.id, "expired before settlement");
    const rows = await db.query<{ id: string; status: string }>("SELECT id, status FROM storyhold.credit_reservations");
    assert.equal(rows.rows.find((row) => row.id === protectedHold.id)?.status, "reserved");
    assert.equal(rows.rows.find((row) => row.id === unusedHold.id)?.status, "released");
    assert.equal((await db.query<{ credits: number }>("SELECT credits FROM storyhold.players WHERE id = $1", [playerId])).rows[0]?.credits, 15);
    await releaseCreditReservation(db, protectedHold.id, "provider reconciliation confirmed no charge");
    assert.equal((await db.query<{ credits: number }>("SELECT credits FROM storyhold.players WHERE id = $1", [playerId])).rows[0]?.credits, 20);
  } finally {
    await db.close();
  }
});

async function createPremiumRestoreFixture() {
  const db = await createCreditEconomyDatabase();
  const playerId = "00000000-0000-4000-8000-000000000105";
  const worldId = "00000000-0000-4000-8000-000000000205";
  await db.query(
    "INSERT INTO storyhold.players (id, role, credits) VALUES ($1, 'player', 12)",
    [playerId],
  );
  await db.query("INSERT INTO storyhold.worlds (id) VALUES ($1)", [worldId]);
  const original = await reserveCredits(db, {
    playerId,
    worldId,
    operation: "world_analysis",
    requestId: "frozen-premium-run",
    requiredCredits: 10,
    metadata: { retainUntilReconciled: true },
  });
  // A restore must not sweep unrelated expired holds to recompute affordability.
  await reserveCredits(db, {
    playerId,
    worldId,
    operation: "world_analysis",
    requestId: "unrelated-unused-run",
    requiredCredits: 2,
  });
  await db.query(
    "UPDATE storyhold.credit_reservations SET expires_at = now() - interval '1 hour'",
  );
  assert.ok(original.id);
  return {
    db,
    params: {
      reservationId: original.id,
      playerId,
      worldId,
      runId: "frozen-premium-run",
      reservedCredits: 10,
    },
  };
}

async function creditState(db: PGlite) {
  return {
    players: (await db.query("SELECT * FROM storyhold.players ORDER BY id")).rows,
    reservations: (await db.query("SELECT * FROM storyhold.credit_reservations ORDER BY id")).rows,
    ledger: (await db.query("SELECT * FROM storyhold.credit_ledger ORDER BY id")).rows,
  };
}

test("premium restore reuses an expired protected hold twice with zero spendable credits", async () => {
  const { db, params } = await createPremiumRestoreFixture();
  try {
    const before = await creditState(db);
    const [first, second] = await Promise.all([
      restorePremiumCreditReservation(db, params),
      restorePremiumCreditReservation(db, params),
    ]);
    assert.deepEqual(first, {
      id: params.reservationId,
      playerId: params.playerId,
      reservedCredits: 10,
      creditsRemaining: 0,
      unlimited: false,
    });
    assert.deepEqual(second, first);
    assert.deepEqual(await creditState(db), before);
    assert.equal(before.reservations.length, 2);
    assert.equal(before.ledger.length, 2);

    for (const role of ["admin", "owner"]) {
      await db.query("UPDATE storyhold.players SET role = $2, credits = 3 WHERE id = $1", [params.playerId, role]);
      const promotedState = await creditState(db);
      const restored = await restorePremiumCreditReservation(db, params);
      assert.deepEqual(restored, { ...first, creditsRemaining: 3 });
      assert.deepEqual(await creditState(db), promotedState);
    }
  } finally {
    await db.close();
  }
});

test("premium restore rejects missing or mismatched frozen reservation scope without writes", async () => {
  const { db, params } = await createPremiumRestoreFixture();
  try {
    const before = await creditState(db);
    const invalidRequests = [
      { ...params, reservationId: "" },
      { ...params, reservationId: "invalid-reservation-id" },
      { ...params, reservationId: "00000000-0000-4000-8000-000000000999" },
      { ...params, playerId: "00000000-0000-4000-8000-000000000998" },
      { ...params, worldId: "00000000-0000-4000-8000-000000000997" },
      { ...params, runId: "different-run" },
      { ...params, reservedCredits: 9 },
      { ...params, reservedCredits: 11 },
      { ...params, reservedCredits: 10.1 },
      { ...params, reservedCredits: Number.NaN },
    ];
    for (const request of invalidRequests) {
      await assert.rejects(
        restorePremiumCreditReservation(db, request),
        (error: unknown) => error instanceof CreditEconomyError &&
          error.code === "CREDIT_RESERVATION_RESTORE_INVALID",
      );
      assert.deepEqual(await creditState(db), before);
    }
    await db.query("UPDATE storyhold.credit_reservations SET operation = 'campaign_turn' WHERE id = $1", [params.reservationId]);
    const changedOperation = await creditState(db);
    await assert.rejects(
      restorePremiumCreditReservation(db, params),
      (error: unknown) => error instanceof CreditEconomyError &&
        error.code === "CREDIT_RESERVATION_RESTORE_INVALID",
    );
    assert.deepEqual(await creditState(db), changedOperation);
  } finally {
    await db.close();
  }
});

test("premium restore requires an exact boolean reconciliation marker", async () => {
  const { db, params } = await createPremiumRestoreFixture();
  try {
    for (const usage of [{}, { retainUntilReconciled: false }, { retainUntilReconciled: "true" }]) {
      await db.query("UPDATE storyhold.credit_reservations SET usage = $2::jsonb WHERE id = $1", [params.reservationId, JSON.stringify(usage)]);
      const before = await creditState(db);
      await assert.rejects(
        restorePremiumCreditReservation(db, params),
        (error: unknown) => error instanceof CreditEconomyError &&
          error.code === "CREDIT_RESERVATION_RESTORE_INVALID",
      );
      assert.deepEqual(await creditState(db), before);
    }
  } finally {
    await db.close();
  }
});

for (const status of ["settled", "released"] as const) {
  test(`premium restore fails closed after the original reservation is ${status}`, async () => {
    const { db, params } = await createPremiumRestoreFixture();
    try {
      if (status === "settled") {
        await db.transaction((tx) => settleFixedCreditReservationInTransaction(tx, {
          reservationId: params.reservationId,
          fixedCredits: params.reservedCredits,
          provider: "storyhold",
          model: "premium-test",
        }));
      } else {
        await releaseCreditReservation(db, params.reservationId, "provider reconciliation confirmed no charge");
      }
      const before = await creditState(db);
      await assert.rejects(
        restorePremiumCreditReservation(db, params),
        (error: unknown) => error instanceof CreditEconomyError &&
          error.code === "CREDIT_RESERVATION_RESTORE_INVALID",
      );
      assert.deepEqual(await creditState(db), before);
    } finally {
      await db.close();
    }
  });
}

test("concurrent duplicate reservations debit once under native transaction isolation", async () => {
  const db = await createCreditEconomyDatabase();
  const playerId = "00000000-0000-4000-8000-000000000101";
  try {
    await db.query(
      "INSERT INTO storyhold.players (id, role, credits) VALUES ($1, 'player', 10)",
      [playerId],
    );
    const request = {
      playerId,
      operation: "campaign_turn",
      requestId: "same-request",
      requiredCredits: 4,
    };

    const [first, second] = await Promise.all([
      reserveCredits(db, request),
      reserveCredits(db, request),
    ]);

    assert.equal(first.id, second.id);
    assert.equal(first.creditsRemaining, 6);
    assert.equal(second.creditsRemaining, 6);
    const player = await db.query<{ credits: number }>(
      "SELECT credits FROM storyhold.players WHERE id = $1",
      [playerId],
    );
    const reservations = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM storyhold.credit_reservations",
    );
    const ledger = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM storyhold.credit_ledger",
    );
    assert.equal(player.rows[0]?.credits, 6);
    assert.equal(reservations.rows[0]?.count, 1);
    assert.equal(ledger.rows[0]?.count, 1);
  } finally {
    await db.close();
  }
});

test("reservation retries cannot change the original amount or scope, including after an owner promotion", async () => {
  const db = await createCreditEconomyDatabase();
  const playerId = "00000000-0000-4000-8000-000000000106";
  const worldId = "00000000-0000-4000-8000-000000000206";
  try {
    await db.query("INSERT INTO storyhold.players (id, role, credits) VALUES ($1, 'player', 10)", [playerId]);
    await db.query("INSERT INTO storyhold.worlds (id) VALUES ($1)", [worldId]);
    const request = {
      playerId,
      worldId,
      operation: "world_analysis",
      requestId: "same-funded-work",
      requiredCredits: 4,
    };
    const original = await reserveCredits(db, request);
    await db.query("UPDATE storyhold.players SET role = 'owner' WHERE id = $1", [playerId]);
    const before = await creditState(db);
    const replay = await reserveCredits(db, request);
    assert.deepEqual(replay, { ...original, creditsRemaining: 6 });
    assert.equal(replay.unlimited, false, "a later exemption cannot orphan an already-debited hold");
    assert.deepEqual(await creditState(db), before);

    for (const changed of [
      { ...request, requiredCredits: 3 },
      { ...request, worldId: null },
      { ...request, campaignId: "00000000-0000-4000-8000-000000000306" },
    ]) {
      await assert.rejects(
        reserveCredits(db, changed),
        (error: unknown) => error instanceof CreditEconomyError && error.code === "CREDIT_REQUEST_FINALIZED",
      );
      assert.deepEqual(await creditState(db), before);
    }
  } finally {
    await db.close();
  }
});

test("metered settlement replay requires the exact original accounting and never writes twice", async () => {
  await (async () => {
    const previousRetail = process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT;
    const previousMargin = process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS;
    process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT = "20000";
    process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS = "4000";
    const db = await createCreditEconomyDatabase();
    const playerId = "00000000-0000-4000-8000-000000000107";
    try {
      await db.query("INSERT INTO storyhold.players (id, role, credits) VALUES ($1, 'player', 10)", [playerId]);
      const hold = await reserveCredits(db, {
        playerId, operation: "world_analysis", requestId: "exact-settlement", requiredCredits: 4,
      });
      assert.ok(hold.id);
      const meteredUsage: AiUsage = {
        inputUnits: 100, outputUnits: 20, cachedInputUnits: 5,
        cacheWriteInputUnits: 0, reasoningUnits: 3,
        estimatedCostMicros: 24_000, pricingKnown: true,
        pricingVersion: "test:exact", costEstimated: false,
      };
      const settle = (override: Partial<typeof meteredUsage> = {}, provider = "openrouter", model = "test/model") =>
        db.transaction((tx) => settleCreditReservationInTransaction(tx, {
          reservationId: hold.id!, usage: { ...meteredUsage, ...override },
          provider, model, reasoning: "high",
        }));
      const first = await settle();
      const after = await creditState(db);
      assert.deepEqual(first, { creditsUsed: 2, creditsRemaining: 8, uncoveredCredits: 0 });
      assert.deepEqual(await settle(), first);
      assert.deepEqual(await creditState(db), after);

      for (const changed of [
        () => settle({ estimatedCostMicros: 12_000 }),
        () => settle({ inputUnits: 101 }),
        () => settle({ pricingKnown: false }),
        () => settle({}, "openai"),
        () => settle({}, "openrouter", "other/model"),
      ]) {
        await assert.rejects(changed(), (error: unknown) => error instanceof CreditEconomyError);
        assert.deepEqual(await creditState(db), after);
      }
    } finally {
      await db.close();
      if (previousRetail === undefined) delete process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT;
      else process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT = previousRetail;
      if (previousMargin === undefined) delete process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS;
      else process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS = previousMargin;
    }
  })();
});

test("metered settlement replay preserves the original uncovered debt instead of reporting zero", async () => {
  const previousRetail = process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT;
  const previousMargin = process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS;
  process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT = "20000";
  process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS = "4000";
  const db = await createCreditEconomyDatabase();
  const playerId = "00000000-0000-4000-8000-000000000108";
  try {
    await db.query("INSERT INTO storyhold.players (id, role, credits) VALUES ($1, 'player', 5)", [playerId]);
    const hold = await reserveCredits(db, {
      playerId, operation: "world_analysis", requestId: "underfunded-settlement", requiredCredits: 2,
    });
    const usage = {
      inputUnits: 100, outputUnits: 20, cachedInputUnits: 0, cacheWriteInputUnits: 0,
      reasoningUnits: 0, estimatedCostMicros: 120_000, pricingKnown: true,
      pricingVersion: "test:exact", costEstimated: false,
    };
    const settle = () => db.transaction((tx) => settleCreditReservationInTransaction(tx, {
      reservationId: hold.id!, usage, provider: "openrouter", model: "test/model", reasoning: "high",
    }));
    const first = await settle();
    const after = await creditState(db);
    assert.deepEqual(first, { creditsUsed: 5, creditsRemaining: 0, uncoveredCredits: 5 });
    assert.deepEqual(await settle(), first);
    assert.deepEqual(await creditState(db), after);
  } finally {
    await db.close();
    if (previousRetail === undefined) delete process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT;
    else process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT = previousRetail;
    if (previousMargin === undefined) delete process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS;
    else process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS = previousMargin;
  }
});

test("strict premium settlement debits a funded overage once and replays idempotently", async () => {
  const previousRetail = process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT;
  const previousMargin = process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS;
  process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT = "20000";
  process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS = "4000";
  const db = await createCreditEconomyDatabase();
  const playerId = "00000000-0000-4000-8000-000000000109";
  try {
    await db.query("INSERT INTO storyhold.players (id, role, credits) VALUES ($1, 'player', 10)", [playerId]);
    const hold = await reserveCredits(db, {
      playerId, operation: "world_analysis", requestId: "funded-overage", requiredCredits: 4,
    });
    const usage: AiUsage = {
      inputUnits: 100, outputUnits: 20, cachedInputUnits: 0,
      cacheWriteInputUnits: 0, reasoningUnits: 0,
      estimatedCostMicros: 72_000, pricingKnown: true,
      pricingVersion: "test:strict", costEstimated: false,
    };
    const settle = () => db.transaction((tx) => settleCreditReservationInTransaction(tx, {
      reservationId: hold.id!, usage, provider: "openrouter",
      model: "test/model", reasoning: "high", requireFullPayment: true,
    }));
    const first = await settle();
    assert.deepEqual(first, { creditsUsed: 6, creditsRemaining: 4, uncoveredCredits: 0 });
    const after = await creditState(db);
    assert.deepEqual(await settle(), first);
    assert.deepEqual(await creditState(db), after);
    const adjustment = (await db.query<{ credits_delta: number }>(
      "SELECT credits_delta FROM storyhold.credit_ledger WHERE reservation_id = $1 AND entry_kind = 'settle_adjustment'",
      [hold.id],
    )).rows[0]?.credits_delta;
    assert.equal(adjustment, -2);
  } finally {
    await db.close();
    if (previousRetail === undefined) delete process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT;
    else process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT = previousRetail;
    if (previousMargin === undefined) delete process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS;
    else process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS = previousMargin;
  }
});

test("strict premium settlement automatically returns the unused estimate", async () => {
  const previousRetail = process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT;
  const previousMargin = process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS;
  process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT = "20000";
  process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS = "4000";
  const db = await createCreditEconomyDatabase();
  const playerId = "00000000-0000-4000-8000-000000000111";
  try {
    await db.query("INSERT INTO storyhold.players (id, role, credits) VALUES ($1, 'player', 10)", [playerId]);
    const hold = await reserveCredits(db, {
      playerId, operation: "world_analysis", requestId: "unused-estimate", requiredCredits: 6,
    });
    const usage: AiUsage = {
      inputUnits: 100, outputUnits: 20, cachedInputUnits: 0,
      cacheWriteInputUnits: 0, reasoningUnits: 0,
      estimatedCostMicros: 24_000, pricingKnown: true,
      pricingVersion: "test:strict", costEstimated: false,
    };
    const settle = () => db.transaction((tx) => settleCreditReservationInTransaction(tx, {
      reservationId: hold.id!, usage, provider: "openrouter",
      model: "test/model", reasoning: "high", requireFullPayment: true,
    }));
    const first = await settle();
    assert.deepEqual(first, { creditsUsed: 2, creditsRemaining: 8, uncoveredCredits: 0 });
    const after = await creditState(db);
    assert.deepEqual(await settle(), first);
    assert.deepEqual(await creditState(db), after);
    const adjustment = (await db.query<{ credits_delta: number }>(
      "SELECT credits_delta FROM storyhold.credit_ledger WHERE reservation_id = $1 AND entry_kind = 'settle_adjustment'",
      [hold.id],
    )).rows[0]?.credits_delta;
    assert.equal(adjustment, 4);
  } finally {
    await db.close();
    if (previousRetail === undefined) delete process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT;
    else process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT = previousRetail;
    if (previousMargin === undefined) delete process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS;
    else process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS = previousMargin;
  }
});

test("strict premium settlement preserves its hold until an overage can be fully covered", async () => {
  const previousRetail = process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT;
  const previousMargin = process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS;
  process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT = "20000";
  process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS = "4000";
  const db = await createCreditEconomyDatabase();
  const playerId = "00000000-0000-4000-8000-000000000110";
  try {
    await db.query("INSERT INTO storyhold.players (id, role, credits) VALUES ($1, 'player', 5)", [playerId]);
    const hold = await reserveCredits(db, {
      playerId, operation: "world_analysis", requestId: "unfunded-overage", requiredCredits: 4,
    });
    const usage: AiUsage = {
      inputUnits: 100, outputUnits: 20, cachedInputUnits: 0,
      cacheWriteInputUnits: 0, reasoningUnits: 0,
      estimatedCostMicros: 72_000, pricingKnown: true,
      pricingVersion: "test:strict", costEstimated: false,
    };
    const settle = () => db.transaction((tx) => settleCreditReservationInTransaction(tx, {
      reservationId: hold.id!, usage, provider: "openrouter",
      model: "test/model", reasoning: "high", requireFullPayment: true,
    }));
    const before = await creditState(db);
    await assert.rejects(settle(), (error: unknown) =>
      error instanceof CreditEconomyError && error.code === "INSUFFICIENT_CREDITS" &&
      error.requiredCredits === 6 && error.availableCredits === 5);
    assert.deepEqual(await creditState(db), before);

    await db.query("UPDATE storyhold.players SET credits = 3 WHERE id = $1", [playerId]);
    assert.deepEqual(await settle(), { creditsUsed: 6, creditsRemaining: 1, uncoveredCredits: 0 });
  } finally {
    await db.close();
    if (previousRetail === undefined) delete process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT;
    else process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT = previousRetail;
    if (previousMargin === undefined) delete process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS;
    else process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS = previousMargin;
  }
});

test("a failed reserve ledger write rolls back the entire native transaction", async () => {
  const db = await createCreditEconomyDatabase();
  const playerId = "00000000-0000-4000-8000-000000000102";
  try {
    await db.query(
      "INSERT INTO storyhold.players (id, role, credits) VALUES ($1, 'player', 10)",
      [playerId],
    );
    await db.exec(`
      ALTER TABLE storyhold.credit_ledger
        ADD CONSTRAINT reject_test_reserve CHECK (entry_kind <> 'reserve');
    `);

    await assert.rejects(
      reserveCredits(db, {
        playerId,
        operation: "campaign_turn",
        requestId: "rollback-request",
        requiredCredits: 4,
      }),
    );

    const player = await db.query<{ credits: number }>(
      "SELECT credits FROM storyhold.players WHERE id = $1",
      [playerId],
    );
    const reservations = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM storyhold.credit_reservations",
    );
    const ledger = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM storyhold.credit_ledger",
    );
    assert.equal(player.rows[0]?.credits, 10);
    assert.equal(reservations.rows[0]?.count, 0);
    assert.equal(ledger.rows[0]?.count, 0);
  } finally {
    await db.close();
  }
});

test("fixed-price products charge the advertised amount exactly once", async () => {
  const db = await createCreditEconomyDatabase();
  const playerId = "00000000-0000-4000-8000-000000000103";
  try {
    await db.query(
      "INSERT INTO storyhold.players (id, role, credits) VALUES ($1, 'player', 1000)",
      [playerId],
    );
    const reservation = await reserveCredits(db, {
      playerId,
      operation: "campaign_branch",
      requestId: "branch-fixed-price",
      requiredCredits: 500,
    });
    assert.ok(reservation.id);
    const first = await db.transaction((tx) =>
      settleFixedCreditReservationInTransaction(tx, {
        reservationId: String(reservation.id),
        fixedCredits: 500,
        provider: "storyhold",
        model: "timeline-branch",
      }),
    );
    const duplicate = await db.transaction((tx) =>
      settleFixedCreditReservationInTransaction(tx, {
        reservationId: String(reservation.id),
        fixedCredits: 500,
        provider: "storyhold",
        model: "timeline-branch",
      }),
    );

    assert.deepEqual(first, {
      creditsUsed: 500,
      creditsRemaining: 500,
      uncoveredCredits: 0,
    });
    assert.deepEqual(duplicate, first);
    const player = await db.query<{ credits: number }>(
      "SELECT credits FROM storyhold.players WHERE id = $1",
      [playerId],
    );
    const reservationRow = await db.query<{
      status: string;
      actual_credits: number;
    }>(
      "SELECT status, actual_credits FROM storyhold.credit_reservations WHERE id = $1",
      [reservation.id],
    );
    const ledger = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM storyhold.credit_ledger",
    );
    assert.equal(player.rows[0]?.credits, 500);
    assert.equal(reservationRow.rows[0]?.status, "settled");
    assert.equal(reservationRow.rows[0]?.actual_credits, 500);
    assert.equal(ledger.rows[0]?.count, 2);
  } finally {
    await db.close();
  }
});

test("credit conversion keeps the configured 40% premium-work margin", () => {
  withEconomyEnvironment(() => {
    assert.equal(creditsForProviderCost(0), 0);
    assert.equal(creditsForProviderCost(12_000), 1);
    assert.equal(creditsForProviderCost(12_001), 2);
    assert.equal(creditsForProviderCost(60_000), 5);
  });
});

test("invalid or unsupported provider accounting never converts into a charge", () => {
  withEconomyEnvironment(() => {
    for (const cost of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => creditsForProviderCost(cost),
        (error: unknown) => error instanceof CreditEconomyError && error.code === "UNKNOWN_MODEL_PRICING",
      );
    }
    const valid = priceReportedAiUsage({
      provider: "openai", model: "gpt-5.6-luna", inputUnits: 100, outputUnits: 10,
    });
    for (const usage of [
      { ...valid, inputUnits: -1 },
      { ...valid, outputUnits: 0.5 },
      { ...valid, estimatedCostMicros: Number.NaN },
      { ...valid, pricingKnown: false },
      { ...valid, pricingVersion: "" },
    ]) {
      assert.throws(
        () => creditsForUsage(usage),
        (error: unknown) => error instanceof CreditEconomyError && error.code === "UNKNOWN_MODEL_PRICING",
      );
    }
  });
});

test("configured margins below 40% are clamped to the commercial floor", () => {
  withEconomyEnvironment(() => {
    process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS = "3000";
    assert.equal(creditsForProviderCost(12_000), 1);
    assert.equal(creditsForProviderCost(12_001), 2);
  });
});

test("model, output, cache, and long-context rates change the private credit result", () => {
  withEconomyEnvironment(() => {
    const luna = priceReportedAiUsage({
      provider: "openai",
      model: "gpt-5.6-luna",
      inputUnits: 10_000,
      outputUnits: 2_000,
    });
    const kimi = priceReportedAiUsage({
      provider: "kimi",
      model: "kimi-k3",
      inputUnits: 10_000,
      outputUnits: 2_000,
    });
    const sonnet = priceReportedAiUsage({
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputUnits: 10_000,
      outputUnits: 2_000,
    });
    const cachedLuna = priceReportedAiUsage({
      provider: "openai",
      model: "gpt-5.6-luna",
      inputUnits: 10_000,
      cachedInputUnits: 8_000,
      outputUnits: 2_000,
    });
    const shortGrok = priceReportedAiUsage({
      provider: "xai",
      model: "grok-4.5",
      inputUnits: 199_999,
      outputUnits: 1_000,
    });
    const longGrok = priceReportedAiUsage({
      provider: "xai",
      model: "grok-4.5",
      inputUnits: 200_000,
      outputUnits: 1_000,
    });

    assert.ok(kimi.estimatedCostMicros > luna.estimatedCostMicros);
    assert.equal(sonnet.pricingKnown, true);
    assert.equal(sonnet.estimatedCostMicros, 60_000);
    assert.ok(cachedLuna.estimatedCostMicros < luna.estimatedCostMicros);
    assert.ok(longGrok.estimatedCostMicros > shortGrok.estimatedCostMicros);
    assert.ok(creditsForUsage(kimi) > creditsForUsage(luna));
  });
});

test("reasoning telemetry is not charged twice when it is included in output usage", () => {
  withEconomyEnvironment(() => {
    const withoutDetail = priceReportedAiUsage({
      provider: "kimi",
      model: "kimi-k3",
      inputUnits: 5_000,
      outputUnits: 2_000,
      reasoningUnits: 0,
    });
    const withDetail = priceReportedAiUsage({
      provider: "kimi",
      model: "kimi-k3",
      inputUnits: 5_000,
      outputUnits: 2_000,
      reasoningUnits: 1_500,
    });
    assert.equal(
      withDetail.estimatedCostMicros,
      withoutDetail.estimatedCostMicros,
    );
  });
});

test("pre-call holds cover the configured fallback and refund can use actual usage", () => {
  withEconomyEnvironment(() => {
    process.env.STORYHOLD_OPENAI_API_KEY = "test-only";
    process.env.STORYHOLD_OPENAI_MODEL = "gpt-5.6-luna";
    const short = quoteAiCostReservation({
      task: "campaign_turn",
      system: "Keep canon consistent.",
      messages: [{ role: "user", content: "I open the door." }],
      reasoning: "low",
      maxOutputTokens: 500,
    });
    const expansive = quoteAiCostReservation({
      task: "campaign_turn",
      system: "Keep canon consistent.",
      messages: [{ role: "user", content: "I open the door." }],
      reasoning: "high",
      maxOutputTokens: 3_500,
    });
    assert.equal(short.pricingKnown, true);
    assert.equal(short.candidates.length, 1);
    assert.ok(
      creditsForReservationQuote(expansive) >
        creditsForReservationQuote(short),
    );
  });
});

test("unknown custom model pricing fails closed for credit-based work", () => {
  withEconomyEnvironment(() => {
    const usage = priceReportedAiUsage({
      provider: "openai",
      model: "private-custom-model",
      inputUnits: 1_000,
      outputUnits: 1_000,
    });
    assert.equal(usage.pricingKnown, false);
    assert.throws(
      () => creditsForUsage(usage),
      (error) =>
        error instanceof CreditEconomyError &&
        error.code === "UNKNOWN_MODEL_PRICING",
    );
  });
});

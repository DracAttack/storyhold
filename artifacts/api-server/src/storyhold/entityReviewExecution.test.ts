import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  AiGatewayUnavailableError, getAiRuntimeStatus,
  type AiBillableAttempt, type AiTextResult, type GenerateAiTextInput,
} from "./aiGateway";
import { creditEconomySchemaSql, reserveCredits } from "./creditEconomy";
import {
  ensureEntityReviewJournal, executeJournaledEntityReviewCall, readEntityReviewCall,
  type EntityReviewCallScope,
} from "./entityReviewJournal";
import { EntityReviewStaleCanonError, finishJournaledEntityReview } from "./entityReviewExecution";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope: EntityReviewCallScope = {
  reviewId: uuid(1), playerId: uuid(2), worldId: uuid(3), editionId: uuid(4), entityId: uuid(5),
};
const model = "synthetic-dossier-model";
const context = { targetVersion: "fixture-v1", input: { entity: { id: scope.entityId, name: "Mira" } } };
const request: GenerateAiTextInput = {
  task: "canon_review", stage: "dossier", reasoning: "high", maxOutputTokens: 1200,
  system: "Review supplied evidence.", messages: [{ role: "user", content: "Mira held the beam." }],
  allowProviderFallback: false, providerFailurePolicy: "stop",
};

function result(): AiTextResult {
  return {
    text: '{"summary":"Mira protects her companions."}', provider: "openrouter", model, reasoning: "high",
    usage: {
      inputUnits: 1000, outputUnits: 100, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 10,
      estimatedCostMicros: 1500, pricingKnown: true, pricingVersion: "fixture", costEstimated: false,
    },
    runtime: {
      ...getAiRuntimeStatus("canon_review", "standard", "dossier"), configured: true, mode: "connected",
      provider: "openrouter", model, stage: "dossier", billable: true, sendsSourceTextOffDevice: true,
      execution: {
        connectionId: "managed:openrouter", credentialSource: "environment", connectionSource: "storyhold_managed",
        billingSource: "storyhold_credits", requestedModel: model, resolvedModel: "resolved-fixture",
        upstreamProvider: "fixture", privacyMode: "zero-data-retention",
      },
    },
  };
}

function attempt(): AiBillableAttempt {
  const value = result();
  return {
    provider: value.provider, model: value.model, resolvedModel: "resolved-fixture", upstreamProvider: "fixture",
    stage: "dossier", reasoning: value.reasoning, usage: value.usage,
  };
}

async function fixture() {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.players (id uuid PRIMARY KEY, role text NOT NULL, credits integer NOT NULL CHECK (credits >= 0), updated_at timestamptz DEFAULT now());
    CREATE TABLE storyhold.worlds (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.campaigns (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.world_entities (id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL, summary text NOT NULL DEFAULT 'Original dossier');
    CREATE TABLE storyhold.ai_usage_ledger (
      id uuid PRIMARY KEY, player_id uuid, world_id uuid, campaign_id uuid, operation text, provider text, model text,
      input_units integer, output_units integer, cost_micros bigint, cache_hit boolean, pricing_version text,
      credits_charged integer, request_id text, metadata jsonb, created_at timestamptz DEFAULT now()
    );`);
  await db.exec(creditEconomySchemaSql);
  await ensureEntityReviewJournal(db);
  await db.query("INSERT INTO storyhold.players (id, role, credits) VALUES ($1, 'player', 1000)", [scope.playerId]);
  await db.query("INSERT INTO storyhold.worlds VALUES ($1)", [scope.worldId]);
  await db.query("INSERT INTO storyhold.world_entities (id, world_id, canon_edition_id) VALUES ($1, $2, $3)",
    [scope.entityId, scope.worldId, scope.editionId]);
  const hold = await reserveCredits(db, {
    playerId: scope.playerId, worldId: scope.worldId, operation: "entity_review", requestId: scope.reviewId, requiredCredits: 30,
  });
  let providerCalls = 0;
  const dispatch = (invoke: () => Promise<AiTextResult> = async () => result()) => executeJournaledEntityReviewCall(db, {
    scope, reservationId: hold.id, contextSnapshot: context, request, provider: "openrouter", model,
    invoke: async () => { providerCalls += 1; return invoke(); },
  });
  return { db, dispatch, providerCalls: () => providerCalls };
}

async function state(db: PGlite) {
  return {
    summary: (await db.query<{ summary: string }>("SELECT summary FROM storyhold.world_entities")).rows[0]!.summary,
    balance: (await db.query<{ credits: number }>("SELECT credits FROM storyhold.players")).rows[0]!.credits,
    hold: (await db.query<Record<string, unknown>>("SELECT status, actual_credits, usage FROM storyhold.credit_reservations")).rows[0]!,
    creditEntries: (await db.query("SELECT * FROM storyhold.credit_ledger ORDER BY created_at, id")).rows,
    usageEntries: (await db.query("SELECT * FROM storyhold.ai_usage_ledger ORDER BY created_at, id")).rows,
    finalization: (await readEntityReviewCall(db, scope))?.finalization_snapshot ?? null,
  };
}

const writeDossier: Parameters<typeof finishJournaledEntityReview>[1]["apply"] = async (tx, frozen, response) => {
  assert.deepEqual(frozen, context);
  assert.ok(response.journalCompletedAt);
  const summary = JSON.parse(response.text).summary as string;
  await tx.query("UPDATE storyhold.world_entities SET summary = $1 WHERE id = $2", [summary, scope.entityId]);
  return { summary, verification: "passed" };
};

test("completed paid dossier applies and settles once; replay returns the immutable finalization", async () => {
  const f = await fixture(); let applications = 0;
  try {
    await f.dispatch();
    const apply: typeof writeDossier = async (...args) => { applications += 1; return writeDossier(...args); };
    const first = await finishJournaledEntityReview(f.db, { scope, apply });
    const saved = await state(f.db);
    const second = await finishJournaledEntityReview(f.db, { scope, apply });
    assert.deepEqual(second, first);
    assert.deepEqual(await state(f.db), saved);
    assert.equal(applications, 1); assert.equal(f.providerCalls(), 1);
    assert.equal(first.reviewed, true);
    assert.equal(first.summary, "Mira protects her companions.");
    assert.equal(saved.summary, first.summary);
    assert.equal(saved.hold.status, "settled");
    assert.equal(saved.usageEntries.length, 1); assert.equal(saved.creditEntries.length, 2);
    assert.equal(saved.balance, 1000 - Number(first.creditsUsed));
    assert.equal(saved.hold.actual_credits, first.creditsUsed);
    assert.deepEqual(saved.finalization, first);
  } finally { await f.db.close(); }
});

test("transient application failure rolls back canon and accounting; resume uses the saved result", async () => {
  const f = await fixture();
  try {
    await f.dispatch();
    const before = await state(f.db);
    await assert.rejects(finishJournaledEntityReview(f.db, { scope, apply: async (...args) => {
      await writeDossier(...args);
      throw new Error("Transient canonical storage failure.");
    } }), /Transient canonical storage failure/);
    assert.deepEqual(await state(f.db), before);
    assert.equal((await readEntityReviewCall(f.db, scope))?.status, "completed");
    const saved = await finishJournaledEntityReview(f.db, { scope, apply: writeDossier });
    assert.equal(saved.reviewed, true); assert.equal(f.providerCalls(), 1);
    assert.equal((await state(f.db)).usageEntries.length, 1);
  } finally { await f.db.close(); }
});

test("a late ledger failure rolls back the dossier and earlier credit settlement together", async () => {
  const f = await fixture();
  try {
    await f.dispatch();
    const before = await state(f.db);
    await f.db.exec(`CREATE FUNCTION storyhold.fail_usage_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Transient usage storage failure'; END; $$;
      CREATE TRIGGER fail_usage BEFORE INSERT ON storyhold.ai_usage_ledger FOR EACH ROW EXECUTE FUNCTION storyhold.fail_usage_insert();`);
    await assert.rejects(finishJournaledEntityReview(f.db, { scope, apply: writeDossier }), /Transient usage storage failure/);
    assert.deepEqual(await state(f.db), before);
    await f.db.exec("DROP TRIGGER fail_usage ON storyhold.ai_usage_ledger");
    const saved = await finishJournaledEntityReview(f.db, { scope, apply: writeDossier });
    assert.equal(saved.reviewed, true); assert.equal(f.providerCalls(), 1);
    assert.equal((await state(f.db)).creditEntries.length, 2);
  } finally { await f.db.close(); }
});

test("proven stale canon rolls back generated changes but settles the known paid work exactly once", async () => {
  const f = await fixture(); let applications = 0;
  try {
    await f.dispatch();
    const apply: typeof writeDossier = async (...args) => {
      applications += 1;
      await writeDossier(...args);
      throw new EntityReviewStaleCanonError();
    };
    const first = await finishJournaledEntityReview(f.db, { scope, apply });
    assert.equal(first.reviewed, false); assert.match(String(first.error), /canon or source material changed/);
    const saved = await state(f.db);
    assert.equal(saved.summary, "Original dossier");
    assert.equal(saved.hold.status, "settled");
    assert.equal(saved.usageEntries.length, 1); assert.equal(saved.creditEntries.length, 2);
    assert.equal((saved.usageEntries[0] as { cost_micros: number } | undefined)?.cost_micros, 1500);
    assert.deepEqual(await finishJournaledEntityReview(f.db, { scope, apply }), first);
    assert.equal(applications, 1); assert.equal(f.providerCalls(), 1);
  } finally { await f.db.close(); }
});

test("known rejected output settles its recorded usage once and never calls canonical application", async () => {
  const f = await fixture(); let applications = 0;
  try {
    const failure = new AiGatewayUnavailableError("Invalid model response", ["openrouter: invalid"], [attempt()], false);
    await assert.rejects(f.dispatch(async () => { throw failure; }), (error) => error === failure);
    const apply: typeof writeDossier = async (...args) => { applications += 1; return writeDossier(...args); };
    const first = await finishJournaledEntityReview(f.db, { scope, apply });
    const saved = await state(f.db);
    assert.equal(first.reviewed, false); assert.match(String(first.error), /evidence checks/);
    assert.match(String(first.error), /credits were used.*resuming will not charge them again/);
    assert.equal(saved.summary, "Original dossier"); assert.equal(saved.hold.status, "settled");
    assert.equal(saved.usageEntries.length, 1); assert.equal(saved.creditEntries.length, 2);
    assert.deepEqual(await finishJournaledEntityReview(f.db, { scope, apply }), first);
    assert.deepEqual(await state(f.db), saved);
    assert.equal(applications, 0); assert.equal(f.providerCalls(), 1);
  } finally { await f.db.close(); }
});

test("uncertain paid outcome blocks application and settlement while retaining the original hold", async () => {
  const f = await fixture(); let applications = 0;
  try {
    await assert.rejects(f.dispatch(async () => {
      throw new AiGatewayUnavailableError("Later provider outcome unknown", ["openrouter: response lost"], [attempt()], true);
    }), /uncertain/);
    const before = await state(f.db);
    assert.equal(before.hold.status, "reserved");
    assert.equal((before.hold.usage as Record<string, unknown>).retainUntilReconciled, true);
    assert.equal(before.creditEntries.length, 1); assert.equal(before.usageEntries.length, 0);
    const apply: typeof writeDossier = async (...args) => { applications += 1; return writeDossier(...args); };
    await assert.rejects(finishJournaledEntityReview(f.db, { scope, apply }), /unknown|reconciliation/);
    assert.deepEqual(await state(f.db), before);
    assert.equal(applications, 0); assert.equal(f.providerCalls(), 1);
  } finally { await f.db.close(); }
});

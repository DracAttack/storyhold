import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { AiGatewayUnavailableError, getAiRuntimeStatus, type AiBillableAttempt, type AiTextResult, type GenerateAiTextInput } from "./aiGateway";
import { creditEconomySchemaSql, reserveCredits } from "./creditEconomy";
import { ensureEntityReviewJournal, EntityReviewJournalError, executeJournaledEntityReviewPages, readEntityReviewCall,
  readEntityReviewPageProgress, type EntityReviewCallScope, type EntityReviewJournalPage } from "./entityReviewJournal";
import { finishJournaledEntityReview } from "./entityReviewExecution";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope: EntityReviewCallScope = { reviewId: uuid(1), playerId: uuid(2), worldId: uuid(3), editionId: uuid(4), entityId: uuid(5) };
const model = "synthetic-paged-dossier-model";
const context = { version: 1, targetFingerprint: "unchanged-source", input: { entity: { id: scope.entityId, name: "Mira" } } };
const code = (expected: string) => (error: unknown) => error instanceof EntityReviewJournalError && error.code === expected;
function pages(count = 3): EntityReviewJournalPage[] {
  return Array.from({ length: count }, (_, index) => ({ stepKey: `dossier_graph:${index}`, provider: "openrouter", model,
    request: { task: "canon_review", stage: "dossier", reasoning: "high", maxOutputTokens: 1200, temperature: 0,
      system: "Review only supplied evidence.", messages: [{ role: "user", content: `Mira evidence page ${index}.` }],
      providerFailurePolicy: "stop", allowProviderFallback: false } satisfies GenerateAiTextInput }));
}
function result(index: number): AiTextResult {
  return { text: JSON.stringify({ summary: `Verified page ${index}` }), provider: "openrouter", model, reasoning: "high",
    usage: { inputUnits: 1000 + index, outputUnits: 100, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 10,
      estimatedCostMicros: 1500 + index, pricingKnown: true, pricingVersion: "fixture", costEstimated: false },
    runtime: { ...getAiRuntimeStatus("canon_review", "standard", "dossier"), configured: true, mode: "connected", provider: "openrouter",
      model, stage: "dossier", billable: true, sendsSourceTextOffDevice: true,
      execution: { connectionId: "managed:openrouter", credentialSource: "environment", connectionSource: "storyhold_managed",
        billingSource: "storyhold_credits", requestedModel: model, resolvedModel: "resolved-fixture", upstreamProvider: "fixture", privacyMode: "zero-data-retention" } } };
}
function attempt(index = 0): AiBillableAttempt {
  const value = result(index);
  return { provider: value.provider, model, resolvedModel: "resolved-fixture", upstreamProvider: "fixture", stage: "dossier", reasoning: value.reasoning, usage: value.usage };
}
async function fixture() {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.players (id uuid PRIMARY KEY, role text NOT NULL, credits integer NOT NULL CHECK (credits >= 0), updated_at timestamptz DEFAULT now());
    CREATE TABLE storyhold.worlds (id uuid PRIMARY KEY); CREATE TABLE storyhold.campaigns (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.world_entities (id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL, summary text NOT NULL DEFAULT 'Original dossier');
    CREATE TABLE storyhold.ai_usage_ledger (id uuid PRIMARY KEY, player_id uuid, world_id uuid, campaign_id uuid, operation text, provider text, model text,
      input_units integer, output_units integer, cost_micros bigint, cache_hit boolean, pricing_version text,
      credits_charged integer, request_id text, metadata jsonb, created_at timestamptz DEFAULT now());`);
  await db.exec(creditEconomySchemaSql); await ensureEntityReviewJournal(db); await ensureEntityReviewJournal(db);
  await db.query("INSERT INTO storyhold.players (id,role,credits) VALUES ($1,'player',1000)", [scope.playerId]);
  await db.query("INSERT INTO storyhold.worlds VALUES ($1)", [scope.worldId]);
  await db.query("INSERT INTO storyhold.world_entities (id,world_id,canon_edition_id) VALUES ($1,$2,$3)", [scope.entityId, scope.worldId, scope.editionId]);
  const hold = await reserveCredits(db, { playerId: scope.playerId, worldId: scope.worldId, operation: "entity_review", requestId: scope.reviewId, requiredCredits: 30 });
  const calls: number[] = [];
  const params = { scope, reservationId: hold.id, contextSnapshot: context, pages: pages(), invoke: async (_page: EntityReviewJournalPage, index: number) => { calls.push(index); return result(index); } };
  return { db, hold, calls, params, run: (changes: Partial<typeof params> & { beforePage?: (page: EntityReviewJournalPage, index: number) => Promise<void> } = {}) => executeJournaledEntityReviewPages(db, { ...params, ...changes }) };
}

test("paged dossier freezes one hold, records every actual result, and settles its complete usage once", async () => {
  const f = await fixture(); let applied = 0;
  try {
    const saved = await f.run(); const replay = await f.run();
    assert.deepEqual(f.calls, [0, 1, 2]); assert.deepEqual(saved, replay);
    assert.equal(saved.entityReviewPages.length, 3); assert.equal(saved.priorBillableAttempts?.length, 2);
    assert.equal(saved.usage.estimatedCostMicros, 1502); // Last actual usage is not an invented aggregate.
    const call = await readEntityReviewCall(f.db, scope);
    assert.equal(call?.billable_attempts.length, 3); assert.equal(call?.request_snapshot.provider, "openrouter");
    assert.equal(call?.request_snapshot.model, model);
    const apply = async () => { applied++; return { summary: "Complete dossier" }; };
    const final = await finishJournaledEntityReview(f.db, { scope, apply });
    assert.deepEqual(await finishJournaledEntityReview(f.db, { scope, apply }), final); assert.equal(applied, 1);
    const entries = (await f.db.query<{ cost_micros: number }>("SELECT cost_micros FROM storyhold.ai_usage_ledger")).rows;
    assert.equal(entries.length, 3); assert.equal(entries.reduce((sum, item) => sum + Number(item.cost_micros), 0), 4503);
    assert.equal((await f.db.query("SELECT * FROM storyhold.credit_reservations")).rows.length, 1);
    assert.equal((await readEntityReviewPageProgress(f.db, scope)).canResume, false);
  } finally { await f.db.close(); }
});

test("a pause before the next page resumes only the missing suffix, not the paid prefix", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.run({ beforePage: async (_page, index) => { if (index === 1) throw new Error("Provider configuration unavailable before dispatch"); } }), /configuration unavailable/);
    assert.deepEqual(f.calls, [0]);
    assert.deepEqual(await readEntityReviewPageProgress(f.db, scope), { completedPages: 1, totalPages: 3, canResume: true, blockedStatus: null, nextStepKey: "dossier_graph:1" });
    assert.equal((await readEntityReviewCall(f.db, scope))?.status, "dispatched");
    await f.run(); assert.deepEqual(f.calls, [0, 1, 2]);
  } finally { await f.db.close(); }
});

test("earlier billable attempts on several pages are accumulated once without inventing a provider total", async () => {
  const f = await fixture();
  try {
    const saved = await f.run({ invoke: async (_page, index) => ({ ...result(index), priorBillableAttempts: [attempt(10 + index)] }) });
    assert.equal(saved.priorBillableAttempts?.length, 5);
    assert.deepEqual(saved.entityReviewPages.map((page) => page.result.priorBillableAttempts?.length), [1, 1, 1]);
    assert.equal((await readEntityReviewCall(f.db, scope))?.billable_attempts.length, 6);
    await finishJournaledEntityReview(f.db, { scope, apply: async () => ({ summary: "Complete dossier" }) });
    const entries = (await f.db.query<{ cost_micros: number }>("SELECT cost_micros FROM storyhold.ai_usage_ledger")).rows;
    assert.equal(entries.length, 6); assert.equal(entries.reduce((sum, entry) => sum + Number(entry.cost_micros), 0), 9036);
  } finally { await f.db.close(); }
});

test("a pre-first-page interruption is resumable without a provider charge", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.run({ beforePage: async () => { throw new Error("Stale canon before dispatch"); } }), /Stale canon/);
    assert.deepEqual(f.calls, []); assert.equal((await readEntityReviewPageProgress(f.db, scope)).canResume, true);
    assert.equal((await f.db.query("SELECT * FROM storyhold.entity_review_ai_pages")).rows.length, 0);
    await f.run(); assert.deepEqual(f.calls, [0, 1, 2]);
  } finally { await f.db.close(); }
});

test("all completed pages can finish aggregation offline after a local persistence interruption", async () => {
  const f = await fixture();
  try {
    await f.db.exec(`CREATE FUNCTION storyhold.fixture_fail_parent_complete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.status='completed' THEN RAISE EXCEPTION 'Simulated final aggregation interruption'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER fixture_parent_failure BEFORE UPDATE ON storyhold.entity_review_ai_calls FOR EACH ROW EXECUTE FUNCTION storyhold.fixture_fail_parent_complete();`);
    await assert.rejects(f.run(), code("JOURNAL_PERSISTENCE")); assert.deepEqual(f.calls, [0, 1, 2]);
    assert.deepEqual(await readEntityReviewPageProgress(f.db, scope), { completedPages: 3, totalPages: 3, canResume: true, blockedStatus: null, nextStepKey: null });
    await f.db.exec("DROP TRIGGER fixture_parent_failure ON storyhold.entity_review_ai_calls");
    await f.run({ invoke: async () => { throw new Error("No provider should be called"); }, beforePage: async () => { throw new Error("No provider config required"); } });
    assert.equal((await readEntityReviewCall(f.db, scope))?.status, "completed");
  } finally { await f.db.close(); }
});

test("known rejected later page retains and charges all completed prefix usage without applying canon", async () => {
  const f = await fixture(); let applications = 0;
  try {
    await assert.rejects(f.run({ invoke: async (_page, index) => {
      f.calls.push(index); if (index === 1) throw new AiGatewayUnavailableError("Invalid verified response", [], [attempt(1)], false); return result(index);
    } }), /Invalid verified response/);
    assert.deepEqual(f.calls, [0, 1]); assert.equal((await readEntityReviewCall(f.db, scope))?.billable_attempts.length, 2);
    await assert.rejects(f.run(), code("PREVIOUSLY_REJECTED"));
    const final = await finishJournaledEntityReview(f.db, { scope, apply: async () => { applications++; return {}; } });
    assert.equal(final.reviewed, false); assert.equal(applications, 0);
    assert.equal((await f.db.query("SELECT * FROM storyhold.ai_usage_ledger")).rows.length, 2);
  } finally { await f.db.close(); }
});

test("a later uncertain outcome freezes every remaining page and retains the single hold", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.run({ invoke: async (_page, index) => {
      f.calls.push(index); if (index === 1) throw new AiGatewayUnavailableError("Network outcome unknown", [], [attempt(1)], true); return result(index);
    } }), code("OUTCOME_UNRESOLVED"));
    const call = await readEntityReviewCall(f.db, scope);
    assert.equal(call?.status, "uncertain"); assert.equal(call?.billable_attempts.length, 2);
    await assert.rejects(f.run(), code("OUTCOME_UNRESOLVED")); assert.deepEqual(f.calls, [0, 1]);
    await assert.rejects(finishJournaledEntityReview(f.db, { scope, apply: async () => { throw new Error("Must not apply"); } }), code("OUTCOME_UNRESOLVED"));
    assert.equal((await readEntityReviewPageProgress(f.db, scope)).blockedStatus, "uncertain");
    assert.equal((await f.db.query<{ status: string }>("SELECT status FROM storyhold.credit_reservations")).rows[0]?.status, "reserved");
    assert.equal((await f.db.query("SELECT * FROM storyhold.ai_usage_ledger")).rows.length, 0);
  } finally { await f.db.close(); }
});

test("a dispatched child blocks competing same-review and new-review calls", async () => {
  const f = await fixture(); let entered!: () => void; let release!: () => void;
  const invoked = new Promise<void>((resolve) => { entered = resolve; }); const done = new Promise<void>((resolve) => { release = resolve; });
  let pending: ReturnType<typeof f.run> | undefined;
  try {
    pending = f.run({ invoke: async (_page, index) => { f.calls.push(index); if (index === 0) { entered(); await done; } return result(index); } });
    await invoked;
    await assert.rejects(f.run(), code("OUTCOME_UNRESOLVED"));
    await assert.rejects(f.run({ scope: { ...scope, reviewId: uuid(99) } }), code("ENTITY_REVIEW_PENDING"));
    assert.equal((await readEntityReviewPageProgress(f.db, scope)).canResume, false); assert.deepEqual(f.calls, [0]);
    release(); await pending; assert.deepEqual(f.calls, [0, 1, 2]);
  } finally { release(); await pending?.catch(() => {}); await f.db.close(); }
});

test("resuming rejects changed plan, sources, model, or released funding before another page is paid", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.run({ beforePage: async (_page, index) => { if (index === 1) throw new Error("pause"); } }), /pause/);
    await assert.rejects(f.run({ pages: pages(2) }), code("REQUEST_MISMATCH"));
    await assert.rejects(f.run({ pages: pages().map((page) => ({ ...page, model: "changed-model" })) }), code("REQUEST_MISMATCH"));
    await assert.rejects(f.run({ contextSnapshot: { ...context, targetFingerprint: "changed-source" } }), code("REQUEST_MISMATCH"));
    await f.db.query("UPDATE storyhold.credit_reservations SET status='released' WHERE id=$1", [f.hold.id]);
    await assert.rejects(f.run(), code("RESERVATION_UNAVAILABLE")); assert.deepEqual(f.calls, [0]);
  } finally { await f.db.close(); }
});

test("completed child rows are immutable and missing or tampered page evidence invalidates the parent", async () => {
  const f = await fixture();
  try {
    await f.run();
    await assert.rejects(f.db.query("UPDATE storyhold.entity_review_ai_pages SET error='changed' WHERE page_index=0"), /immutable/);
    await assert.rejects(f.db.query("UPDATE storyhold.entity_review_ai_pages SET page_index=20 WHERE page_index=0"), /immutable/);
    await f.db.query("DELETE FROM storyhold.entity_review_ai_pages WHERE page_index=1");
    await assert.rejects(readEntityReviewCall(f.db, scope), code("JOURNAL_INTEGRITY"));
    await assert.rejects(f.run(), code("JOURNAL_INTEGRITY")); assert.deepEqual(f.calls, [0, 1, 2]);
  } finally { await f.db.close(); }
});

test("captured output failing page validation is a known billable rejection, never a free retry", async () => {
  const f = await fixture();
  try {
    const requested = pages(); requested[1]!.request.validate = () => { throw new Error("Invalid graph coverage"); };
    await assert.rejects(f.run({ pages: requested }), /Invalid graph coverage/);
    const call = await readEntityReviewCall(f.db, scope); assert.equal(call?.status, "rejected"); assert.equal(call?.billable_attempts.length, 2);
    await assert.rejects(f.run({ pages: requested }), code("PREVIOUSLY_REJECTED")); assert.deepEqual(f.calls, [0, 1]);
  } finally { await f.db.close(); }
});

test("a paid child whose result cannot be saved remains unresolved instead of invoking again", async () => {
  const f = await fixture();
  try {
    await f.db.exec(`CREATE FUNCTION storyhold.fixture_fail_page_complete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.status='completed' THEN RAISE EXCEPTION 'Disk failure after paid response'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER fixture_page_failure BEFORE UPDATE ON storyhold.entity_review_ai_pages FOR EACH ROW EXECUTE FUNCTION storyhold.fixture_fail_page_complete();`);
    await assert.rejects(f.run(), code("JOURNAL_PERSISTENCE")); assert.deepEqual(f.calls, [0]);
    await f.db.exec("DROP TRIGGER fixture_page_failure ON storyhold.entity_review_ai_pages");
    await assert.rejects(f.run(), code("OUTCOME_UNRESOLVED")); assert.deepEqual(f.calls, [0]);
    assert.equal((await readEntityReviewPageProgress(f.db, scope)).blockedStatus, "dispatched");
  } finally { await f.db.close(); }
});

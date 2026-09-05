import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { AiGatewayUnavailableError, combineAiUsage, type AiTextResult, type AiUsage } from "./aiGateway";
import { creditEconomySchemaSql, reserveCredits, settleCreditReservationInTransaction } from "./creditEconomy";
import {
  executeJournaledPremiumCall,
  LEGACY_PREMIUM_RECOVERY_MODEL,
  LEGACY_PREMIUM_RECOVERY_PROVIDER,
  LEGACY_PREMIUM_RECOVERY_TOTAL_STEP_KEY,
  plannedJournalScopeMatches,
  premiumReviewJournalSchemaSql,
  premiumReviewReconciliationPending,
  premiumReviewFinalizationMatches,
  readPremiumJournalSnapshot,
} from "./premiumReviewJournal";
import { freezePremiumClockManifest, premiumReviewPlanSchemaSql, savePremiumReviewPlan, type PremiumReviewPlan } from "./premiumReviewPlan";
import { finalizePremiumRecovery, inspectPremiumRecovery, listPremiumRecoveries, PremiumRecoveryError } from "./premiumReviewReconciliation";
import { lorekeeperSnapshotFingerprint } from "./worldStudio";
import { canonPayloadFingerprint, type JsonObject } from "./analysisVerificationContracts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const WORLD = uuid(1), RUN = uuid(2), PLAYER = uuid(3), ACTOR = uuid(4), EDITION = uuid(5);
const SECRET = "MANUSCRIPT_AND_PROVIDER_SECRET_DO_NOT_EXPOSE";
const usage = (cost: number, pricingKnown = true): AiUsage => ({
  inputUnits: 10, outputUnits: 4, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 0,
  estimatedCostMicros: cost, pricingKnown, pricingVersion: "test:verified", costEstimated: true,
});
function providerResult(cost: number, pricingKnown = true): AiTextResult {
  return {
    text: SECRET, provider: "openrouter", model: "test/model", reasoning: "high", usage: usage(cost, pricingKnown),
    runtime: { stage: "verification", execution: { resolvedModel: "test/model", upstreamProvider: "test" } },
  } as AiTextResult;
}

async function fixture(exempt = false, reservedCredits = 10, planVersion: 1 | 2 | 3 = 1) {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.players (id uuid PRIMARY KEY, role text NOT NULL, credits integer NOT NULL CHECK (credits >= 0), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE storyhold.worlds (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE storyhold.campaigns (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.ai_usage_ledger (
      id uuid PRIMARY KEY, player_id uuid, world_id uuid, campaign_id uuid,
      operation text, provider text, model text, input_units integer NOT NULL DEFAULT 0,
      output_units integer NOT NULL DEFAULT 0, cost_micros bigint NOT NULL DEFAULT 0,
      cache_hit boolean NOT NULL DEFAULT false, metadata jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE storyhold.world_analysis_runs (
      id uuid PRIMARY KEY, world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
      canon_edition_id uuid NOT NULL, requested_by_player_id uuid NOT NULL,
      analysis_kind text NOT NULL DEFAULT 'ai_enrichment', status text NOT NULL DEFAULT 'paused',
      stage text NOT NULL DEFAULT 'Saved boundary', progress integer NOT NULL DEFAULT 43,
      provider text NOT NULL DEFAULT 'openrouter', model text NOT NULL DEFAULT 'test/model',
      premium_resume_status text NOT NULL DEFAULT 'blocked', premium_ai_credits_charged integer NOT NULL DEFAULT 0,
      pause_requested boolean NOT NULL DEFAULT false, completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), error text,
      local_checkpoint jsonb NOT NULL DEFAULT '{}', intake_preview jsonb NOT NULL DEFAULT '{}',
      parent_local_run_id uuid, corpus_fingerprint text, evidence_graph_fingerprint text,
      constraint_snapshot_fingerprint text, verification_context_fingerprint text,
      verification_context_snapshot jsonb, verification_packet_version integer
    );
    CREATE TABLE storyhold.world_analysis_claim_reviews (run_id uuid);
    CREATE TABLE storyhold.world_analysis_graph_reviews (run_id uuid);
    CREATE TABLE storyhold.world_analysis_stat_reviews (run_id uuid);
    CREATE TABLE storyhold.world_analysis_clock_reviews (run_id uuid);
  `);
  await db.exec(creditEconomySchemaSql);
  await db.exec(premiumReviewJournalSchemaSql);
  await db.exec(premiumReviewPlanSchemaSql);
  await db.query("INSERT INTO storyhold.players (id, role, credits) VALUES ($1, $3, 100), ($2, 'owner', 300)", [PLAYER, ACTOR, exempt ? "owner" : "player"]);
  await db.query("INSERT INTO storyhold.worlds VALUES ($1, 'Test world')", [WORLD]);
  const context = { canon: SECRET };
  const evidence = {
    parentLocalRunId: uuid(99), corpusFingerprint: "corpus-fingerprint", evidenceGraphFingerprint: "evidence-fingerprint",
    constraintSnapshotFingerprint: "constraint-fingerprint", verificationContextFingerprint: lorekeeperSnapshotFingerprint(context), verificationPacketVersion: 1,
  };
  await db.query(`INSERT INTO storyhold.world_analysis_runs
    (id, world_id, canon_edition_id, requested_by_player_id, parent_local_run_id, corpus_fingerprint,
     evidence_graph_fingerprint, constraint_snapshot_fingerprint, verification_context_fingerprint,
     verification_context_snapshot, verification_packet_version, error, local_checkpoint, intake_preview)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 1, $11, $12::jsonb, $12::jsonb)`,
  [RUN, WORLD, EDITION, PLAYER, evidence.parentLocalRunId, evidence.corpusFingerprint,
    evidence.evidenceGraphFingerprint, evidence.constraintSnapshotFingerprint, evidence.verificationContextFingerprint,
    JSON.stringify(context), SECRET, JSON.stringify({ saved: SECRET })]);
  const reservation = await reserveCredits(db, {
    playerId: PLAYER, worldId: WORLD, operation: "world_analysis", requestId: RUN, requiredCredits: reservedCredits,
    metadata: { premiumResumeVersion: 1, retainUntilReconciled: true },
  });
  const legacyPlan: Extract<PremiumReviewPlan, { version: 1 }> = {
    version: 1, runId: RUN, worldId: WORLD, editionId: EDITION, playerId: PLAYER,
    executionVersion: "test-execution-v1", scopeFingerprint: lorekeeperSnapshotFingerprint(evidence),
    provider: "openrouter", model: "test/model", worldContext: { worldName: "Test world", premise: SECRET, genre: "fantasy", userGuidance: SECRET },
    chunks: [
      { id: "chunk-1", sourceId: "source-1", sourceTitle: SECRET, index: 0, content: SECRET },
      { id: "chunk-2", sourceId: "source-1", sourceTitle: SECRET, index: 1, content: SECRET },
      { id: "chunk-3", sourceId: "source-1", sourceTitle: SECRET, index: 2, content: SECRET },
    ],
    verificationBatches: [["chunk-1"], ["chunk-2"], ["chunk-3"]], incremental: false, partialDueToCredits: false,
    reservationId: reservation.id, reservedCredits: reservation.reservedCredits, unlimited: reservation.unlimited,
  };
  const paginatedPlan: Extract<PremiumReviewPlan, { version: 2 }> = {
    ...legacyPlan,
    version: 2,
    verificationPages: legacyPlan.verificationBatches.map((_batch, batchIndex) => ({
      stepKey: `verification:${batchIndex}`, batchIndex, pageIndex: 0, pageCount: 1,
      candidateKeys: [], packetFingerprint: `premium_packet_${String(batchIndex + 1).repeat(64)}`,
    })),
  };
  const plan: PremiumReviewPlan = planVersion === 1
    ? legacyPlan
    : planVersion === 2
      ? paginatedPlan
      : {
        ...paginatedPlan,
        version: 3,
        clockReviewVersion: 1,
        clockEntityRegistry: [],
        clockOwnerConstraints: [],
      };
  await savePremiumReviewPlan(db, plan);
  const callParams = (stepKey: string, invoke: () => Promise<AiTextResult>) => ({
    runId: RUN, stepKey, provider: "openrouter", model: "test/model", reservationId: reservation.id,
    scopeFingerprint: lorekeeperSnapshotFingerprint({ evidence, plan }),
    request: { task: "canon_review" as const, stage: "verification" as const, system: SECRET, messages: [{ role: "user" as const, content: SECRET }], maxOutputTokens: 100 },
    invoke,
  });
  const completed = async (key: string, cost: number, known = true) => {
    await executeJournaledPremiumCall(db, callParams(key, async () => providerResult(cost, known)));
  };
  const uncertain = async (key = "verification:0") => {
    await assert.rejects(executeJournaledPremiumCall(db, callParams(key, async () => { throw new Error(SECRET); })));
  };
  return { db, plan, reservation, callParams, completed, uncertain };
}
const inspect = (db: PGlite) => inspectPremiumRecovery(db, { actorId: ACTOR, runId: RUN });
const noCharge = (stepKey = "verification:0") => ({ stepKey, outcome: "no_charge" as const, costMicros: 0, providerReference: "provider dashboard receipt #zero" });
async function input(db: PGlite) {
  return { actorId: ACTOR, runId: RUN, expectedFingerprint: (await inspect(db)).fingerprint, note: "Checked provider billing and request records.", confirmProviderChecked: true, decisions: [noCharge()] };
}
function errorCode(code: string) { return (error: unknown) => error instanceof PremiumRecoveryError && error.code === code; }
async function accounting(db: PGlite) {
  return {
    players: (await db.query("SELECT * FROM storyhold.players ORDER BY id")).rows,
    holds: (await db.query("SELECT * FROM storyhold.credit_reservations ORDER BY id")).rows,
    ledger: (await db.query("SELECT * FROM storyhold.credit_ledger ORDER BY id")).rows,
    receipts: (await db.query("SELECT * FROM storyhold.world_analysis_premium_reconciliations ORDER BY id")).rows,
  };
}

async function commitSettledCrashBoundary(f: Awaited<ReturnType<typeof fixture>>) {
  const rows = (await f.db.query<{ billable_attempts: Array<{ provider: string; model: string; usage: AiUsage }> }>(
    "SELECT billable_attempts FROM storyhold.world_analysis_ai_calls WHERE run_id = $1 ORDER BY created_at, step_key",
    [RUN],
  )).rows;
  const attempts = rows.flatMap((row) => row.billable_attempts);
  const combined = combineAiUsage(attempts.map((attempt) => attempt.usage));
  const provider = [...new Set(attempts.map((attempt) => attempt.provider))].join(",") || "mixed";
  const model = [...new Set(attempts.map((attempt) => attempt.model))].join(",") || "mixed";
  await f.db.transaction(async (tx) => {
    const settlement = await settleCreditReservationInTransaction(tx, {
      reservationId: f.reservation.id!, usage: combined, provider, model, reasoning: "high",
    });
    await tx.query(
      "UPDATE storyhold.world_analysis_runs SET premium_ai_credits_charged = $2 WHERE id = $1",
      [RUN, settlement.creditsUsed],
    );
    await tx.query(
      `INSERT INTO storyhold.ai_usage_ledger
        (id, player_id, world_id, campaign_id, operation, provider, model,
         input_units, output_units, cached_input_units, cache_write_input_units,
         reasoning_units, cost_micros, cache_hit, pricing_version,
         credits_charged, request_id, metadata)
       VALUES ($1, $2, $3, NULL, 'world_analysis_rejected_output', $4, $5,
         $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)`,
      [uuid(600), PLAYER, WORLD, provider, model,
        combined.inputUnits, combined.outputUnits, combined.cachedInputUnits,
        combined.cacheWriteInputUnits, combined.reasoningUnits,
        combined.estimatedCostMicros, combined.cachedInputUnits > 0,
        combined.pricingVersion, settlement.creditsUsed, RUN,
        JSON.stringify({ canonPromoted: false, attemptCount: attempts.length, pricingKnown: true, failure: "test failure" })],
    );
  });
  return { combined, attempts, provider, model };
}

test("production-shaped scope is inspectable; operator DTOs expose no manuscript, raw errors, or credentials", async () => {
  const f = await fixture();
  try {
    await f.completed("verification:0", 12_000);
    await f.uncertain("verification:1");
    const detail = await inspect(f.db);
    assert.equal(detail.canFinalize, true, detail.blockReason ?? "");
    assert.equal(detail.knownCostMicros, 12_000);
    assert.equal(detail.steps[0]?.needsDecision, false);
    assert.equal(detail.steps[1]?.knownCostMicros, null);
    assert.equal(detail.steps[1]?.needsDecision, true);
    assert.equal(JSON.stringify(detail).includes(SECRET), false);
    assert.deepEqual(await listPremiumRecoveries(f.db, ACTOR), [detail]);
    await assert.rejects(inspectPremiumRecovery(f.db, { actorId: PLAYER, runId: RUN }), errorCode("FORBIDDEN"));
    await assert.rejects(listPremiumRecoveries(f.db, PLAYER), errorCode("FORBIDDEN"));
    await assert.rejects(finalizePremiumRecovery(f.db, { ...await input(f.db), actorId: PLAYER }), errorCode("FORBIDDEN"));
  } finally { await f.db.close(); }
});

test("legacy v1/v2 plans accept their bounded chronology history while v3 keeps terminal rejection strict", async () => {
  for (const planVersion of [1, 2, 3] as const) {
    const f = await fixture(false, 10, planVersion);
    try {
      const verificationStepCount = f.plan.version === 1
        ? f.plan.verificationBatches.length
        : f.plan.verificationPages.length;
      for (let index = 0; index < verificationStepCount; index += 1) {
        await f.completed(`verification:${index}`, 12_000);
      }
      if (planVersion === 3) {
        await freezePremiumClockManifest(f.db, f.plan, {
          version: 1,
          runId: RUN,
          worldId: WORLD,
          editionId: EDITION,
          pageCount: 2,
          pageManifestFingerprint: `clock_page_manifest_${"b".repeat(64)}`,
          inputFingerprint: `clock_inventory_${"c".repeat(64)}`,
          requestManifestFingerprint: `canon_payload_${"d".repeat(64)}`,
        });
      }
      const failedAttempt = {
        provider: "openrouter" as const,
        model: "test/model",
        resolvedModel: "test/model",
        upstreamProvider: null,
        stage: "verification" as const,
        reasoning: "high" as const,
        usage: usage(12_000),
      };
      await assert.rejects(executeJournaledPremiumCall(
        f.db,
        f.callParams("chronology:0", async () => {
          throw new AiGatewayUnavailableError("rejected", [], [failedAttempt], false);
        }),
      ));
      await f.completed("chronology:1", 12_000);

      const journal = await readPremiumJournalSnapshot(f.db, RUN);
      assert.deepEqual(
        journal.rows.filter((row) => row.step_key.startsWith("chronology:"))
          .map((row) => [row.step_key, row.status]),
        [["chronology:0", "rejected"], ["chronology:1", "completed"]],
      );
      const run = (await f.db.query<Record<string, unknown>>(
        "SELECT * FROM storyhold.world_analysis_runs WHERE id = $1",
        [RUN],
      )).rows[0]!;
      const expectedToMatch = planVersion !== 3;
      assert.equal(
        await plannedJournalScopeMatches(
          f.db,
          f.plan as unknown as Record<string, unknown>,
          run,
          journal.rows,
        ),
        expectedToMatch,
        planVersion === 3
          ? "v3 must treat a rejected chronology step as terminal"
          : `legacy plan v${planVersion} must retain its historical bounded chronology behavior`,
      );
      const detail = await inspect(f.db);
      assert.equal(detail.canFinalize, expectedToMatch, `plan v${planVersion}`);
      if (!expectedToMatch) assert.match(detail.blockReason ?? "", /execution order and scope/iu);

      // Exercise the independent settled-accounting adoption validator too.
      // A pre-crash v1/v2 run may already have settled this exact legitimate
      // history; v3 must continue to reject the impossible post-rejection call.
      await commitSettledCrashBoundary(f);
      const settledDetail = await inspect(f.db);
      assert.equal(settledDetail.canFinalize, expectedToMatch, `settled plan v${planVersion}`);
      if (expectedToMatch) {
        assert.equal(settledDetail.recoveryMode, "settled_accounting_adoption");
      }
    } finally { await f.db.close(); }
  }
});

test("legacy best-effort chronology never permits unresolved work to be bypassed", async () => {
  for (const unresolvedStatus of ["uncertain", "dispatched"] as const) {
    const f = await fixture(false, 10, 1);
    try {
      for (let index = 0; index < f.plan.verificationBatches.length; index += 1) {
        await f.completed(`verification:${index}`, 12_000);
      }
      if (unresolvedStatus === "uncertain") {
        await f.uncertain("chronology:0");
      } else {
        await f.db.exec(`
          CREATE FUNCTION storyhold.fixture_reject_journal_update() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture update failure'; END $$;
          CREATE TRIGGER fixture_reject_journal_update
          BEFORE UPDATE ON storyhold.world_analysis_ai_calls
          FOR EACH ROW EXECUTE FUNCTION storyhold.fixture_reject_journal_update();
        `);
        await assert.rejects(executeJournaledPremiumCall(
          f.db,
          f.callParams("chronology:0", async () => providerResult(12_000)),
        ));
        await f.db.exec("DROP TRIGGER fixture_reject_journal_update ON storyhold.world_analysis_ai_calls");
      }
      await f.completed("chronology:1", 12_000);

      const journal = await readPremiumJournalSnapshot(f.db, RUN);
      assert.deepEqual(
        journal.rows.filter((row) => row.step_key.startsWith("chronology:"))
          .map((row) => [row.step_key, row.status]),
        [["chronology:0", unresolvedStatus], ["chronology:1", "completed"]],
      );
      const run = (await f.db.query<Record<string, unknown>>(
        "SELECT * FROM storyhold.world_analysis_runs WHERE id = $1",
        [RUN],
      )).rows[0]!;
      assert.equal(
        await plannedJournalScopeMatches(
          f.db,
          f.plan as unknown as Record<string, unknown>,
          run,
          journal.rows,
        ),
        false,
        `${unresolvedStatus} chronology work must block every later step`,
      );
      const detail = await inspect(f.db);
      assert.equal(detail.canFinalize, false);
      assert.match(detail.blockReason ?? "", /execution order and scope/iu);
    } finally { await f.db.close(); }
  }
});

test("no-charge finalization fully refunds once, preserves journal and saved results, and blocks all replay", async () => {
  const f = await fixture();
  try {
    await f.uncertain();
    const beforeJournal = (await f.db.query("SELECT * FROM storyhold.world_analysis_ai_calls")).rows;
    const beforeSaved = (await f.db.query("SELECT local_checkpoint, intake_preview, progress FROM storyhold.world_analysis_runs")).rows;
    assert.equal(await premiumReviewReconciliationPending(f.db, WORLD), true);
    const request = await input(f.db);
    const [first, concurrent] = await Promise.all([finalizePremiumRecovery(f.db, request), finalizePremiumRecovery(f.db, request)]);
    assert.deepEqual(first, concurrent);
    assert.equal(first.receipt?.creditsUsed, 0);
    assert.equal(first.receipt?.creditsRefunded, 10);
    assert.equal(first.status, "failed");
    assert.equal(first.canFinalize, false);
    const sealed = (await f.db.query<{ receipt: Record<string, unknown> }>(
      "SELECT receipt FROM storyhold.world_analysis_premium_reconciliations WHERE run_id = $1", [RUN],
    )).rows[0]!.receipt;
    assert.equal(sealed.version, 6);
    assert.equal(typeof sealed.receiptFingerprint, "string");
    assert.equal((await f.db.query<{ credits: number }>("SELECT credits FROM storyhold.players WHERE id = $1", [PLAYER])).rows[0]?.credits, 100);
    assert.deepEqual((await f.db.query("SELECT * FROM storyhold.world_analysis_ai_calls")).rows, beforeJournal);
    assert.deepEqual((await f.db.query("SELECT local_checkpoint, intake_preview, progress FROM storyhold.world_analysis_runs")).rows, beforeSaved);
    assert.equal(await premiumReviewReconciliationPending(f.db, WORLD), false);
    const after = await accounting(f.db);
    assert.deepEqual(await finalizePremiumRecovery(f.db, request), first);
    assert.deepEqual(await accounting(f.db), after);
    await f.db.query(`INSERT INTO storyhold.world_analysis_runs (id, world_id, canon_edition_id, requested_by_player_id, status)
      VALUES ($1, $2, $3, $4, 'running')`, [uuid(123), WORLD, EDITION, PLAYER]);
    assert.deepEqual(await finalizePremiumRecovery(f.db, request, { isWorldWorkerActive: () => true }), first);
    await assert.rejects(finalizePremiumRecovery(f.db, { ...request, note: "Different finalization request note." }), errorCode("ALREADY_FINALIZED"));
    await assert.rejects(executeJournaledPremiumCall(f.db, f.callParams("verification:0", async () => { assert.fail("must not call provider"); })), { code: "REVIEW_FINALIZED" });
    await assert.rejects(executeJournaledPremiumCall(f.db, f.callParams("verification:1", async () => { assert.fail("must not call provider"); })), { code: "REVIEW_FINALIZED" });
    await assert.rejects(f.db.query("UPDATE storyhold.world_analysis_premium_reconciliations SET receipt = '{}'"), /append-only/);
    await assert.rejects(f.db.query("DELETE FROM storyhold.world_analysis_premium_reconciliations"), /append-only/);
    // The last sealed pre-overage planned receipt remains valid. This guards
    // compatibility separately from the older unsealed v1 format below.
    const { receiptFingerprint: _currentReceiptSeal, ...v4ReceiptFields } = sealed;
    const v4UnsignedReceipt = { ...v4ReceiptFields, version: 4 };
    const v4Receipt = {
      ...v4UnsignedReceipt,
      receiptFingerprint: canonPayloadFingerprint({
        namespace: "storyhold:premium-reconciliation-receipt:v1",
        receipt: v4UnsignedReceipt,
      } as JsonObject),
    };
    const v4RequestFingerprint = canonPayloadFingerprint({
      namespace: "storyhold:premium-reconciliation-request:v2",
      receiptVersion: 4,
      recoveryMode: "planned_attestation",
      actorId: request.actorId, runId: request.runId,
      expectedFingerprint: request.expectedFingerprint,
      note: request.note, decisions: request.decisions,
    } as JsonObject);
    await f.db.exec("ALTER TABLE storyhold.world_analysis_premium_reconciliations DISABLE TRIGGER premium_reconciliation_append_only");
    await f.db.query(
      `UPDATE storyhold.world_analysis_premium_reconciliations
          SET receipt = $2::jsonb, request_fingerprint = $3
        WHERE run_id = $1`,
      [RUN, JSON.stringify(v4Receipt), v4RequestFingerprint],
    );
    assert.equal(await premiumReviewFinalizationMatches(f.db, RUN), true);
    // Existing v1 receipts predate receipt seals and cannot be rewritten in
    // production. Their strict semantic/ledger validation remains compatible.
    const legacyRequestFingerprint = canonPayloadFingerprint({
      actorId: request.actorId, runId: request.runId,
      expectedFingerprint: request.expectedFingerprint,
      note: request.note, decisions: request.decisions,
    } as JsonObject);
    await f.db.query(
      `UPDATE storyhold.world_analysis_premium_reconciliations
          SET receipt = jsonb_set(receipt - 'receiptFingerprint', '{version}', '1'::jsonb),
              request_fingerprint = $2
        WHERE run_id = $1`,
      [RUN, legacyRequestFingerprint],
    );
    assert.equal(await premiumReviewFinalizationMatches(f.db, RUN), true);
    assert.equal(await premiumReviewReconciliationPending(f.db, WORLD), false);
    const creditLedgerCount = (await f.db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM storyhold.credit_ledger WHERE reservation_id = $1", [f.reservation.id],
    )).rows[0]!.count;
    await assert.rejects(
      f.db.query("UPDATE storyhold.credit_ledger SET credits_delta = credits_delta + 1 WHERE reservation_id = $1", [f.reservation.id]),
      /append-only/,
    );
    await f.db.query("DELETE FROM storyhold.worlds WHERE id = $1", [WORLD]);
    assert.equal((await f.db.query("SELECT id FROM storyhold.world_analysis_runs WHERE id = $1", [RUN])).rows.length, 0);
    assert.equal((await f.db.query("SELECT run_id FROM storyhold.world_analysis_premium_reconciliations WHERE run_id = $1", [RUN])).rows.length, 1);
    assert.equal((await f.db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM storyhold.credit_ledger WHERE reservation_id = $1", [f.reservation.id],
    )).rows[0]!.count, creditLedgerCount);
  } finally { await f.db.close(); }
});

test("known completed costs plus operator-attested costs settle within the original hold", async () => {
  const f = await fixture();
  try {
    await f.completed("verification:0", 12_000);
    await f.completed("verification:1", 12_000);
    await f.uncertain("verification:2");
    const request = { ...await input(f.db), decisions: [{ stepKey: "verification:2", outcome: "charged" as const, costMicros: 12_000, providerReference: "provider request #paid" }] };
    const detail = await finalizePremiumRecovery(f.db, request);
    assert.equal(detail.receipt?.costMicros, 36_000);
    assert.equal(detail.receipt?.creditsUsed, 3);
    assert.equal(detail.receipt?.creditsRefunded, 7);
    const run = (await f.db.query<{ premium_ai_credits_charged: number; error: unknown }>("SELECT premium_ai_credits_charged, error FROM storyhold.world_analysis_runs")).rows[0];
    assert.equal(run?.premium_ai_credits_charged, 3);
    assert.equal(run?.error, null);
    const hold = (await f.db.query<{ usage: Record<string, unknown> }>("SELECT usage FROM storyhold.credit_reservations")).rows[0];
    assert.equal(hold?.usage.accountingSource, "operator_reconciliation");
    assert.equal(hold?.usage.tokenCountersUnavailable, true);
  } finally { await f.db.close(); }
});

test("invalid, duplicate, extra, missing, unsafe, and unconfirmed provider decisions never alter accounting", async () => {
  const f = await fixture();
  try {
    await f.uncertain();
    const request = await input(f.db);
    const before = await accounting(f.db);
    const invalid = [
      { decisions: [] }, { decisions: [noCharge(), noCharge()] }, { decisions: [noCharge("not-a-step")] },
      { decisions: [{ ...noCharge(), providerReference: "x" }] }, { decisions: [{ ...noCharge(), costMicros: -1 }] },
      { decisions: [{ ...noCharge(), costMicros: NaN }] }, { decisions: [{ ...noCharge(), costMicros: 1.5 }] },
      { decisions: [{ ...noCharge(), costMicros: Number.MAX_SAFE_INTEGER + 1 }] },
      { decisions: [{ ...noCharge(), outcome: "charged" as const }] },
      { decisions: [{ ...noCharge(), providerReference: "sk-or-v1-1234567890abcdefghijklmnop" }] },
      { decisions: [{ ...noCharge(), providerReference: "Bearer abcdefghijklmnopqrstuvwxyz" }] },
      { confirmProviderChecked: false }, { note: "short" },
      { note: "OPENROUTER_API_KEY=abcdefghijklmnop123456" },
      { note: "-----BEGIN OPENSSH PRIVATE KEY-----" },
    ];
    for (const change of invalid) {
      await assert.rejects(finalizePremiumRecovery(f.db, { ...request, ...change }));
      assert.deepEqual(await accounting(f.db), before);
    }
  } finally { await f.db.close(); }
});

test("completed unknown-cost results require attestation and cannot silently default to zero", async () => {
  const f = await fixture();
  try {
    await f.completed("verification:0", 500, false);
    const detail = await inspect(f.db);
    assert.equal(detail.steps[0]?.needsDecision, true);
    const request = await input(f.db);
    await assert.rejects(finalizePremiumRecovery(f.db, { ...request, decisions: [] }), errorCode("DECISIONS_REQUIRED"));
    assert.equal((await finalizePremiumRecovery(f.db, request)).receipt?.costMicros, 0);
  } finally { await f.db.close(); }
});

test("operator totals cannot omit known prior billable attempts", async () => {
  const f = await fixture();
  try {
    const result = providerResult(100, false);
    result.priorBillableAttempts = [{ provider: "openrouter", model: "test/model", resolvedModel: "test/model", upstreamProvider: null, stage: "verification", reasoning: "high", usage: usage(12_000) }];
    await executeJournaledPremiumCall(f.db, f.callParams("verification:0", async () => result));
    const detail = await inspect(f.db);
    assert.equal(detail.steps[0]?.knownCostMicros, 12_000);
    await assert.rejects(finalizePremiumRecovery(f.db, await input(f.db)), errorCode("KNOWN_COST_CONFLICT"));
  } finally { await f.db.close(); }
});

test("an incomplete attempt inventory cannot erase a trusted completed result charge", async () => {
  const f = await fixture();
  try {
    await f.completed("verification:0", 12_000);
    const result = (await f.db.query<{ result_snapshot: JsonObject }>("SELECT result_snapshot FROM storyhold.world_analysis_ai_calls")).rows[0]!.result_snapshot;
    await f.db.query("UPDATE storyhold.world_analysis_ai_calls SET billable_attempts = '[]'::jsonb, result_fingerprint = $1", [
      canonPayloadFingerprint({ version: "storyhold:premium-review-outcome:v1", status: "completed", result, billableAttempts: [] }),
    ]);
    const detail = await inspect(f.db);
    assert.equal(detail.steps[0]?.needsDecision, true);
    assert.equal(detail.steps[0]?.knownCostMicros, 12_000);
    await assert.rejects(finalizePremiumRecovery(f.db, await input(f.db)), errorCode("KNOWN_COST_CONFLICT"));
  } finally { await f.db.close(); }
});

test("funded over-hold verified charges debit the remaining balance and refund zero", async () => {
  const f = await fixture(false, 1);
  try {
    await f.uncertain();
    const request = { ...await input(f.db), decisions: [{ ...noCharge(), outcome: "charged" as const, costMicros: 24_000 }] };
    const done = await finalizePremiumRecovery(f.db, request);
    assert.equal(done.receipt?.creditsUsed, 2);
    assert.equal(done.receipt?.creditsRefunded, 0);
    assert.equal((await f.db.query<{ credits: number }>(
      "SELECT credits FROM storyhold.players WHERE id = $1", [PLAYER],
    )).rows[0]?.credits, 98);
    const hold = (await f.db.query<{ reserved_credits: number; actual_credits: number; status: string }>(
      "SELECT reserved_credits, actual_credits, status FROM storyhold.credit_reservations WHERE id = $1", [f.reservation.id],
    )).rows[0]!;
    assert.deepEqual(hold, { reserved_credits: 1, actual_credits: 2, status: "settled" });
    assert.equal((await f.db.query<{ credits_delta: number }>(
      "SELECT credits_delta FROM storyhold.credit_ledger WHERE reservation_id = $1 AND entry_kind = 'settle_adjustment'", [f.reservation.id],
    )).rows[0]?.credits_delta, -1);
    const stored = (await f.db.query<{ receipt: { version: number } }>(
      "SELECT receipt FROM storyhold.world_analysis_premium_reconciliations WHERE run_id = $1", [RUN],
    )).rows[0]!.receipt;
    assert.equal(stored.version, 6);
    assert.equal(await premiumReviewFinalizationMatches(f.db, RUN), true);
  } finally { await f.db.close(); }
});

test("an unfunded overage rolls back every recovery mutation and preserves the original hold", async () => {
  const f = await fixture(false, 1);
  try {
    await f.uncertain();
    await f.db.query("UPDATE storyhold.players SET credits = 0 WHERE id = $1", [PLAYER]);
    const request = { ...await input(f.db), decisions: [{ ...noCharge(), outcome: "charged" as const, costMicros: 24_000 }] };
    const before = await accounting(f.db);
    const runBefore = (await f.db.query("SELECT * FROM storyhold.world_analysis_runs WHERE id = $1", [RUN])).rows;
    await assert.rejects(finalizePremiumRecovery(f.db, request), errorCode("INSUFFICIENT_CREDITS"));
    assert.deepEqual(await accounting(f.db), before);
    assert.deepEqual((await f.db.query("SELECT * FROM storyhold.world_analysis_runs WHERE id = $1", [RUN])).rows, runBefore);
    const hold = (await f.db.query<{ status: string; actual_credits: number | null }>(
      "SELECT status, actual_credits FROM storyhold.credit_reservations WHERE id = $1", [f.reservation.id],
    )).rows[0]!;
    assert.deepEqual(hold, { status: "reserved", actual_credits: null });
  } finally { await f.db.close(); }
});

test("stale fingerprints and live workers fail closed, including the in-transaction worker recheck", async () => {
  const f = await fixture();
  try {
    await f.uncertain();
    const stale = await input(f.db);
    await f.db.query("UPDATE storyhold.world_analysis_runs SET progress = 44 WHERE id = $1", [RUN]);
    await assert.rejects(finalizePremiumRecovery(f.db, stale), errorCode("STALE_FINGERPRINT"));
    const request = await input(f.db);
    const before = await accounting(f.db);
    let checks = 0;
    await assert.rejects(finalizePremiumRecovery(f.db, request, { isWorldWorkerActive: () => ++checks >= 2 }), errorCode("ACTIVE_WORKER"));
    assert.equal(checks, 2);
    assert.deepEqual(await accounting(f.db), before);
    assert.equal((await inspectPremiumRecovery(f.db, { actorId: ACTOR, runId: RUN }, { isWorldWorkerActive: () => true })).canFinalize, false);
    await f.db.query("UPDATE storyhold.players SET role = 'player' WHERE id = $1", [ACTOR]);
    await assert.rejects(finalizePremiumRecovery(f.db, request), errorCode("FORBIDDEN"));
  } finally { await f.db.close(); }
});

test("finalized, foreign, unprotected and legacy funding never obtains a fabricated exemption", async () => {
  const f = await fixture();
  try {
    await f.uncertain();
    for (const mutation of [
      "UPDATE storyhold.credit_reservations SET status = 'settled'",
      "UPDATE storyhold.credit_reservations SET status = 'released'",
      `UPDATE storyhold.credit_reservations SET status = 'reserved', player_id = '${ACTOR}'`,
      `UPDATE storyhold.credit_reservations SET player_id = '${PLAYER}', usage = '{}'`,
    ]) {
      await f.db.exec(mutation);
      assert.equal((await inspect(f.db)).canFinalize, false);
      await assert.rejects(finalizePremiumRecovery(f.db, await input(f.db)), errorCode("NOT_FINALIZABLE"));
    }
    await f.db.query("DELETE FROM storyhold.world_analysis_premium_plans WHERE run_id = $1", [RUN]);
    assert.match((await inspect(f.db)).blockReason!, /protected credit hold|legacy/);
  } finally { await f.db.close(); }
});

test("receipt insertion failure rolls back credit settlement, terminal state, and ledger together", async () => {
  const f = await fixture();
  try {
    await f.uncertain();
    await f.db.exec(`CREATE FUNCTION storyhold.fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt storage unavailable'; END; $$;
      CREATE TRIGGER fail_receipt BEFORE INSERT ON storyhold.world_analysis_premium_reconciliations FOR EACH ROW EXECUTE FUNCTION storyhold.fail_receipt();`);
    const before = await accounting(f.db);
    const runs = (await f.db.query("SELECT * FROM storyhold.world_analysis_runs")).rows;
    await assert.rejects(finalizePremiumRecovery(f.db, await input(f.db)), /receipt storage unavailable/);
    assert.deepEqual(await accounting(f.db), before);
    assert.deepEqual((await f.db.query("SELECT * FROM storyhold.world_analysis_runs")).rows, runs);
  } finally { await f.db.close(); }
});

test("pending guard accepts only the exact finalized journal; tampering and new calls remain blocking", async () => {
  const f = await fixture();
  try {
    await f.uncertain();
    const request = await input(f.db);
    await finalizePremiumRecovery(f.db, request);
    assert.equal(await premiumReviewReconciliationPending(f.db, WORLD), false);
    await f.db.query("UPDATE storyhold.world_analysis_ai_calls SET error = 'changed audit bytes' WHERE run_id = $1", [RUN]);
    assert.equal(await premiumReviewReconciliationPending(f.db, WORLD), true);
    await assert.rejects(finalizePremiumRecovery(f.db, request), errorCode("RECEIPT_MISMATCH"));
    await f.db.query("UPDATE storyhold.world_analysis_ai_calls SET error = $1 WHERE run_id = $2", [SECRET, RUN]);
    assert.equal(await premiumReviewReconciliationPending(f.db, WORLD), false);
    await f.db.query(`INSERT INTO storyhold.world_analysis_ai_calls (run_id, step_key, request_fingerprint, request_snapshot)
      SELECT run_id, 'verification:1', request_fingerprint, request_snapshot FROM storyhold.world_analysis_ai_calls WHERE run_id = $1`, [RUN]);
    assert.equal(await premiumReviewReconciliationPending(f.db, WORLD), true);
  } finally { await f.db.close(); }
});

test("malformed stored receipts never crash inspection or clear the pending guard", async () => {
  const f = await fixture();
  try {
    await f.uncertain();
    await finalizePremiumRecovery(f.db, await input(f.db));
    const original = (await f.db.query<{ receipt: unknown }>(
      "SELECT receipt FROM storyhold.world_analysis_premium_reconciliations WHERE run_id = $1", [RUN],
    )).rows[0]!.receipt;
    await f.db.exec("ALTER TABLE storyhold.world_analysis_premium_reconciliations DISABLE TRIGGER premium_reconciliation_append_only");
    for (const malformed of [null, [], "broken", { decisions: "not-an-array" }]) {
      await f.db.query(
        "UPDATE storyhold.world_analysis_premium_reconciliations SET receipt = $2::jsonb WHERE run_id = $1",
        [RUN, JSON.stringify(malformed)],
      );
      assert.equal(await premiumReviewFinalizationMatches(f.db, RUN), false);
      assert.equal(await premiumReviewReconciliationPending(f.db, WORLD), true);
      const detail = await inspect(f.db);
      assert.equal(detail.receipt, null);
      assert.equal(detail.canFinalize, false);
      assert.equal((await listPremiumRecoveries(f.db, ACTOR)).length, 1);
    }
    await f.db.query(
      "UPDATE storyhold.world_analysis_premium_reconciliations SET receipt = $2::jsonb WHERE run_id = $1",
      [RUN, JSON.stringify(original)],
    );
    assert.equal(await premiumReviewFinalizationMatches(f.db, RUN), true);
  } finally { await f.db.close(); }
});

test("final-state run or reservation drift blocks both inspection and new-review guards", async () => {
  const f = await fixture();
  try {
    await f.uncertain();
    await finalizePremiumRecovery(f.db, await input(f.db));
    assert.equal(await premiumReviewReconciliationPending(f.db, WORLD), false);
    const hold = (await f.db.query<{ usage: unknown }>("SELECT usage FROM storyhold.credit_reservations")).rows[0]!;
    await f.db.query("UPDATE storyhold.credit_reservations SET usage = usage || '{\"tampered\":true}'::jsonb");
    assert.match((await inspect(f.db)).blockReason!, /receipt no longer matches/);
    assert.equal(await premiumReviewReconciliationPending(f.db, WORLD), true);
    await f.db.query("UPDATE storyhold.credit_reservations SET usage = $1::jsonb", [JSON.stringify(hold.usage)]);
    assert.equal(await premiumReviewReconciliationPending(f.db, WORLD), false);
    await f.db.query("UPDATE storyhold.world_analysis_runs SET progress = 99 WHERE id = $1", [RUN]);
    assert.match((await inspect(f.db)).blockReason!, /receipt no longer matches/);
    assert.equal(await premiumReviewReconciliationPending(f.db, WORLD), true);
  } finally { await f.db.close(); }
});

test("operator role is re-read inside finalization after initial authorization", async () => {
  const f = await fixture();
  try {
    await f.uncertain();
    const request = await input(f.db);
    const pending = finalizePremiumRecovery(f.db, request);
    // PGlite queues this real DB mutation after the initial authorization SELECT
    // and before the transaction starts. No mocked query/transaction behavior.
    const revoked = f.db.query("UPDATE storyhold.players SET role = 'player' WHERE id = $1", [ACTOR]);
    await assert.rejects(pending, errorCode("FORBIDDEN"));
    await revoked;
    assert.equal((await f.db.query("SELECT * FROM storyhold.world_analysis_premium_reconciliations")).rows.length, 0);
    assert.equal((await f.db.query<{ status: string }>("SELECT status FROM storyhold.credit_reservations")).rows[0]?.status, "reserved");
  } finally { await f.db.close(); }
});

test("operator lists omit harmless finalized failures and cap results at 100", async () => {
  const f = await fixture();
  try {
    await f.db.exec(`INSERT INTO storyhold.world_analysis_runs
      (id, world_id, canon_edition_id, requested_by_player_id, status)
      SELECT md5(number::text)::uuid, '${WORLD}', '${EDITION}', '${PLAYER}', 'failed'
      FROM generate_series(1000, 1005) AS number;`);
    assert.equal((await listPremiumRecoveries(f.db, ACTOR)).length, 1);
    await f.db.exec(`INSERT INTO storyhold.world_analysis_runs
      (id, world_id, canon_edition_id, requested_by_player_id, status)
      SELECT md5(number::text)::uuid, '${WORLD}', '${EDITION}', '${PLAYER}', 'paused'
      FROM generate_series(2000, 2110) AS number;`);
    assert.equal((await listPremiumRecoveries(f.db, ACTOR)).length, 100);
  } finally { await f.db.close(); }
});

test("trusted originally exempt reviews finalize without a credit hold, but current exemption is required", async () => {
  const f = await fixture(true);
  try {
    await f.uncertain();
    const detail = await inspect(f.db);
    assert.equal(detail.canFinalize, true, detail.blockReason ?? "");
    await f.db.query("UPDATE storyhold.players SET role = 'player' WHERE id = $1", [PLAYER]);
    assert.equal((await inspect(f.db)).canFinalize, false);
    await f.db.query("UPDATE storyhold.players SET role = 'owner' WHERE id = $1", [PLAYER]);
    const done = await finalizePremiumRecovery(f.db, { ...await input(f.db), decisions: [{ ...noCharge(), outcome: "charged", costMicros: 12_000 }] });
    assert.equal(done.receipt?.costMicros, 12_000);
    assert.equal(done.receipt?.creditsUsed, 0);
    assert.equal((await f.db.query("SELECT * FROM storyhold.credit_ledger")).rows.length, 0);
    assert.equal(await premiumReviewReconciliationPending(f.db, WORLD), false);
    await f.db.query("UPDATE storyhold.players SET role = 'player' WHERE id = $1", [PLAYER]);
    assert.equal(await premiumReviewFinalizationMatches(f.db, RUN), true, "later payer demotion cannot rewrite historical receipt truth");
    assert.equal(await premiumReviewReconciliationPending(f.db, WORLD), false);
    await f.db.query("DELETE FROM storyhold.worlds WHERE id = $1", [WORLD]);
    assert.equal((await f.db.query("SELECT * FROM storyhold.world_analysis_premium_reconciliations")).rows.length, 1);
  } finally { await f.db.close(); }
});

test("a planless legacy retained hold with no journal requires one aggregate attestation and finalizes idempotently", async () => {
  const f = await fixture();
  try {
    await f.db.query("DELETE FROM storyhold.world_analysis_premium_plans WHERE run_id = $1", [RUN]);
    await f.db.query(
      `UPDATE storyhold.credit_reservations
          SET usage = '{"retainUntilReconciled":true,"legacyRecovery":true}'::jsonb
        WHERE id = $1`,
      [f.reservation.id],
    );
    const detail = await inspect(f.db);
    assert.equal(detail.canFinalize, true, detail.blockReason ?? "");
    assert.equal(detail.knownCostMicros, 0);
    assert.deepEqual(detail.steps, [{
      stepKey: LEGACY_PREMIUM_RECOVERY_TOTAL_STEP_KEY,
      status: "legacy_review_total",
      provider: LEGACY_PREMIUM_RECOVERY_PROVIDER,
      model: LEGACY_PREMIUM_RECOVERY_MODEL,
      knownCostMicros: null,
      needsDecision: true,
      dispatchedAt: null,
      lastRecordedAt: null,
    }]);
    const request = {
      actorId: ACTOR, runId: RUN, expectedFingerprint: detail.fingerprint,
      note: "Checked the complete legacy review against provider records.",
      confirmProviderChecked: true,
      decisions: [{
        stepKey: LEGACY_PREMIUM_RECOVERY_TOTAL_STEP_KEY,
        outcome: "no_charge" as const, costMicros: 0,
        providerReference: "provider account history checked: no charge",
      }],
    };
    const first = await finalizePremiumRecovery(f.db, request);
    assert.equal(first.recoveryMode, "legacy_total_attestation");
    assert.equal(first.receipt?.creditsUsed, 0);
    assert.equal(first.receipt?.creditsRefunded, 10);
    assert.equal(await premiumReviewReconciliationPending(f.db, WORLD), false);
    const stored = (await f.db.query<{ receipt: Record<string, unknown> }>(
      "SELECT receipt FROM storyhold.world_analysis_premium_reconciliations WHERE run_id = $1", [RUN],
    )).rows[0]!.receipt;
    assert.equal(stored.version, 7);
    assert.equal(stored.reconciliationMode, "legacy_retained_hold");
    assert.equal(stored.syntheticStepKey, LEGACY_PREMIUM_RECOVERY_TOTAL_STEP_KEY);
    const after = await accounting(f.db);
    assert.deepEqual(await finalizePremiumRecovery(f.db, request), first);
    assert.deepEqual(await accounting(f.db), after);
    await assert.rejects(executeJournaledPremiumCall(
      f.db,
      f.callParams("verification:0", async () => { assert.fail("must not dispatch"); }),
    ), { code: "REVIEW_FINALIZED" });
    // Likewise, sealed legacy-total v5 receipts remain valid after v7 adds
    // explicit funded-overage semantics.
    const { receiptFingerprint: _currentReceiptSeal, ...v5ReceiptFields } = stored;
    const v5UnsignedReceipt = { ...v5ReceiptFields, version: 5 };
    const v5Receipt = {
      ...v5UnsignedReceipt,
      receiptFingerprint: canonPayloadFingerprint({
        namespace: "storyhold:premium-reconciliation-receipt:v1",
        receipt: v5UnsignedReceipt,
      } as JsonObject),
    };
    const v5RequestFingerprint = canonPayloadFingerprint({
      namespace: "storyhold:premium-reconciliation-request:v2",
      receiptVersion: 5,
      recoveryMode: "legacy_total_attestation",
      actorId: request.actorId, runId: request.runId,
      expectedFingerprint: request.expectedFingerprint,
      note: request.note, decisions: request.decisions,
    } as JsonObject);
    await f.db.exec("ALTER TABLE storyhold.world_analysis_premium_reconciliations DISABLE TRIGGER premium_reconciliation_append_only");
    await f.db.query(
      `UPDATE storyhold.world_analysis_premium_reconciliations
          SET receipt = $2::jsonb, request_fingerprint = $3
        WHERE run_id = $1`,
      [RUN, JSON.stringify(v5Receipt), v5RequestFingerprint],
    );
    assert.equal(await premiumReviewFinalizationMatches(f.db, RUN), true);
    const legacyRequestFingerprint = canonPayloadFingerprint({
      actorId: request.actorId, runId: request.runId,
      expectedFingerprint: request.expectedFingerprint,
      note: request.note, decisions: request.decisions,
    } as JsonObject);
    await f.db.query(
      `UPDATE storyhold.world_analysis_premium_reconciliations
          SET receipt = jsonb_set(receipt - 'receiptFingerprint', '{version}', '2'::jsonb),
              request_fingerprint = $2
        WHERE run_id = $1`,
      [RUN, legacyRequestFingerprint],
    );
    assert.equal(await premiumReviewFinalizationMatches(f.db, RUN), true);
    assert.equal(await premiumReviewReconciliationPending(f.db, WORLD), false);
  } finally { await f.db.close(); }
});

test("a planless legacy retained hold can collect a funded verified overage", async () => {
  const f = await fixture(false, 1);
  try {
    await f.db.query("DELETE FROM storyhold.world_analysis_premium_plans WHERE run_id = $1", [RUN]);
    await f.db.query(
      `UPDATE storyhold.credit_reservations
          SET usage = '{"retainUntilReconciled":true,"legacyRecovery":true}'::jsonb
        WHERE id = $1`,
      [f.reservation.id],
    );
    const detail = await inspect(f.db);
    const request = {
      actorId: ACTOR, runId: RUN, expectedFingerprint: detail.fingerprint,
      note: "Checked the complete legacy review against provider records.",
      confirmProviderChecked: true,
      decisions: [{
        stepKey: LEGACY_PREMIUM_RECOVERY_TOTAL_STEP_KEY,
        outcome: "charged" as const,
        costMicros: 24_000,
        providerReference: "provider account history total",
      }],
    };
    const done = await finalizePremiumRecovery(f.db, request);
    assert.equal(done.receipt?.creditsUsed, 2);
    assert.equal(done.receipt?.creditsRefunded, 0);
    const stored = (await f.db.query<{ receipt: { version: number } }>(
      "SELECT receipt FROM storyhold.world_analysis_premium_reconciliations WHERE run_id = $1", [RUN],
    )).rows[0]!.receipt;
    assert.equal(stored.version, 7);
    assert.equal(await premiumReviewFinalizationMatches(f.db, RUN), true);
  } finally { await f.db.close(); }
});

test("legacy reconciliation attests the entire review total and treats authenticated journal cost only as a lower bound", async () => {
  const f = await fixture();
  try {
    await f.completed("verification:0", 12_000);
    await f.uncertain("verification:1");
    await f.db.query("DELETE FROM storyhold.world_analysis_premium_plans WHERE run_id = $1", [RUN]);
    const detail = await inspect(f.db);
    assert.equal(detail.canFinalize, true, detail.blockReason ?? "");
    assert.equal(detail.knownCostMicros, 12_000);
    assert.equal(detail.steps.filter((step) => step.needsDecision).length, 1);
    assert.equal(detail.steps.at(-1)?.stepKey, LEGACY_PREMIUM_RECOVERY_TOTAL_STEP_KEY);
    const base = {
      actorId: ACTOR, runId: RUN, expectedFingerprint: detail.fingerprint,
      note: "Checked the complete legacy review against provider records.",
      confirmProviderChecked: true,
    };
    await assert.rejects(finalizePremiumRecovery(f.db, {
      ...base,
      decisions: [{
        stepKey: LEGACY_PREMIUM_RECOVERY_TOTAL_STEP_KEY,
        outcome: "charged" as const, costMicros: 11_999,
        providerReference: "provider aggregate below known journal",
      }],
    }), errorCode("KNOWN_COST_CONFLICT"));
    const done = await finalizePremiumRecovery(f.db, {
      ...base,
      decisions: [{
        stepKey: LEGACY_PREMIUM_RECOVERY_TOTAL_STEP_KEY,
        outcome: "charged" as const, costMicros: 24_000,
        providerReference: "provider complete review total #24000",
      }],
    });
    assert.equal(done.receipt?.costMicros, 24_000, "known rows are not added on top of the attested aggregate");
    assert.equal(done.receipt?.creditsUsed, 2);
    const hold = (await f.db.query<Record<string, unknown>>(
      "SELECT provider, model, usage FROM storyhold.credit_reservations WHERE id = $1", [f.reservation.id],
    )).rows[0]!;
    assert.equal(hold.provider, LEGACY_PREMIUM_RECOVERY_PROVIDER);
    assert.equal(hold.model, LEGACY_PREMIUM_RECOVERY_MODEL);
    assert.equal((hold.usage as Record<string, unknown>).accountingSource, "operator_reconciliation_legacy_total");
  } finally { await f.db.close(); }
});

test("planless recovery distinguishes provably unused modern holds from legacy ambiguity and rejects conflicting funding", async () => {
  const f = await fixture();
  try {
    await f.db.query("DELETE FROM storyhold.world_analysis_premium_plans WHERE run_id = $1", [RUN]);
    const modern = await inspect(f.db);
    assert.equal(modern.canFinalize, false);
    assert.match(modern.blockReason!, /automatic refund path/);
    assert.equal(modern.steps.length, 0);

    await f.db.query(
      `UPDATE storyhold.credit_reservations
          SET usage = '{"retainUntilReconciled":true,"legacyRecovery":true}'::jsonb
        WHERE id = $1`,
      [f.reservation.id],
    );
    await f.db.query(
      `INSERT INTO storyhold.credit_reservations
        (id, player_id, world_id, operation, request_id, reserved_credits, status, usage, expires_at)
       VALUES ($1, $2, $3, 'world_analysis', $4, 1, 'reserved',
         '{"retainUntilReconciled":true}'::jsonb, now() + interval '1 hour')`,
      [uuid(777), ACTOR, WORLD, RUN],
    );
    const conflicting = await inspect(f.db);
    assert.equal(conflicting.canFinalize, false);
    assert.match(conflicting.blockReason!, /exactly one original retained credit hold/);
  } finally { await f.db.close(); }
});

test("legacy sentinel collisions fail closed and legacy receipt output redacts credential-like stored text", async () => {
  const collision = await fixture();
  try {
    await collision.uncertain(LEGACY_PREMIUM_RECOVERY_TOTAL_STEP_KEY);
    await collision.db.query("DELETE FROM storyhold.world_analysis_premium_plans WHERE run_id = $1", [RUN]);
    const detail = await inspect(collision.db);
    assert.equal(detail.canFinalize, false);
    assert.match(detail.blockReason!, /collides.*aggregate recovery boundary/);
    assert.equal(detail.steps.filter((step) => step.stepKey === LEGACY_PREMIUM_RECOVERY_TOTAL_STEP_KEY).length, 1);
  } finally { await collision.db.close(); }

  const legacy = await fixture();
  try {
    await legacy.db.query("DELETE FROM storyhold.world_analysis_premium_plans WHERE run_id = $1", [RUN]);
    await legacy.db.query(
      `UPDATE storyhold.credit_reservations
          SET usage = '{"retainUntilReconciled":true,"legacyRecovery":true}'::jsonb
        WHERE id = $1`,
      [legacy.reservation.id],
    );
    const detail = await inspect(legacy.db);
    await finalizePremiumRecovery(legacy.db, {
      actorId: ACTOR, runId: RUN, expectedFingerprint: detail.fingerprint,
      note: "Checked complete legacy provider account history.", confirmProviderChecked: true,
      decisions: [{
        stepKey: LEGACY_PREMIUM_RECOVERY_TOTAL_STEP_KEY,
        outcome: "no_charge", costMicros: 0,
        providerReference: "provider account history checked",
      }],
    });
    await legacy.db.exec("ALTER TABLE storyhold.world_analysis_premium_reconciliations DISABLE TRIGGER premium_reconciliation_append_only");
    const emptyRequestFingerprint = canonPayloadFingerprint({} as JsonObject);
    await legacy.db.query(
      `INSERT INTO storyhold.world_analysis_ai_calls
        (run_id, step_key, request_fingerprint, request_snapshot)
       VALUES ($1, $2, $3, '{}'::jsonb)`,
      [RUN, LEGACY_PREMIUM_RECOVERY_TOTAL_STEP_KEY, emptyRequestFingerprint],
    );
    assert.equal(await premiumReviewFinalizationMatches(legacy.db, RUN), false);
    assert.equal(await premiumReviewReconciliationPending(legacy.db, WORLD), true);
    assert.equal((await inspect(legacy.db)).receipt, null);
    await legacy.db.query(
      "DELETE FROM storyhold.world_analysis_ai_calls WHERE run_id = $1 AND step_key = $2",
      [RUN, LEGACY_PREMIUM_RECOVERY_TOTAL_STEP_KEY],
    );
    assert.equal(await premiumReviewFinalizationMatches(legacy.db, RUN), true);
    const leaked = "sk-or-v1-1234567890abcdefghijklmnop";
    await legacy.db.query(
      `UPDATE storyhold.world_analysis_premium_reconciliations
          SET receipt = jsonb_set(
            jsonb_set(receipt, '{note}', to_jsonb($1::text)),
            '{decisions,0,providerReference}', to_jsonb($1::text)
          ) WHERE run_id = $2`,
      [leaked, RUN],
    );
    const publicDetail = await inspect(legacy.db);
    assert.equal(JSON.stringify(publicDetail).includes(leaked), false);
    assert.equal(publicDetail.receipt, null, "a mutated sealed receipt must never be projected as valid");
    assert.equal(publicDetail.canFinalize, false);
    assert.match(publicDetail.blockReason ?? "", /receipt no longer matches/iu);
  } finally { await legacy.db.close(); }
});

test("a fully authenticated already-settled crash boundary is adopted without moving credits or calling a provider", async () => {
  const f = await fixture();
  try {
    let providerCalls = 0;
    await f.completed("verification:0", 24_000);
    const committed = await commitSettledCrashBoundary(f);
    assert.equal(await premiumReviewReconciliationPending(f.db, WORLD), true);
    const detail = await inspect(f.db);
    assert.equal(detail.recoveryMode, "settled_accounting_adoption");
    assert.equal(detail.canFinalize, true, detail.blockReason ?? "");
    assert.equal(detail.knownCostMicros, committed.combined.estimatedCostMicros);
    assert.equal(detail.steps.every((step) => !step.needsDecision), true);
    const beforePlayer = (await f.db.query("SELECT * FROM storyhold.players ORDER BY id")).rows;
    const beforeHold = (await f.db.query("SELECT * FROM storyhold.credit_reservations")).rows;
    const beforeCreditLedger = (await f.db.query("SELECT * FROM storyhold.credit_ledger ORDER BY id")).rows;
    const beforeUsageLedger = (await f.db.query("SELECT * FROM storyhold.ai_usage_ledger ORDER BY id")).rows;
    const request = {
      actorId: ACTOR, runId: RUN, expectedFingerprint: detail.fingerprint,
      note: "Verified the already-settled accounting crash boundary.",
      confirmProviderChecked: true, decisions: [],
    };
    const done = await finalizePremiumRecovery(f.db, request);
    assert.equal(done.recoveryMode, "settled_accounting_adoption");
    assert.equal(done.receipt?.costMicros, 24_000);
    assert.equal(done.receipt?.creditsUsed, 2);
    assert.equal(done.receipt?.creditsRefunded, 8);
    assert.deepEqual((await f.db.query("SELECT * FROM storyhold.players ORDER BY id")).rows, beforePlayer);
    assert.deepEqual((await f.db.query("SELECT * FROM storyhold.credit_reservations")).rows, beforeHold);
    assert.deepEqual((await f.db.query("SELECT * FROM storyhold.credit_ledger ORDER BY id")).rows, beforeCreditLedger);
    assert.deepEqual((await f.db.query("SELECT * FROM storyhold.ai_usage_ledger ORDER BY id")).rows, beforeUsageLedger);
    const stored = (await f.db.query<{ receipt: Record<string, unknown> }>(
      "SELECT receipt FROM storyhold.world_analysis_premium_reconciliations WHERE run_id = $1", [RUN],
    )).rows[0]!.receipt;
    assert.equal(stored.version, 3);
    assert.equal(stored.reconciliationMode, "settled_accounting_adoption");
    assert.equal(typeof stored.receiptFingerprint, "string");
    assert.equal(await premiumReviewFinalizationMatches(f.db, RUN), true);
    assert.equal(await premiumReviewReconciliationPending(f.db, WORLD), false);
    const after = await accounting(f.db);
    assert.deepEqual(await finalizePremiumRecovery(f.db, request), done);
    assert.deepEqual(await accounting(f.db), after);
    await assert.rejects(executeJournaledPremiumCall(
      f.db,
      f.callParams("verification:1", async () => { providerCalls += 1; return providerResult(1); }),
    ), { code: "REVIEW_FINALIZED" });
    assert.equal(providerCalls, 0);
  } finally { await f.db.close(); }
});

test("a fully authenticated funded overage crash boundary is adopted with an explicit sealed receipt", async () => {
  const f = await fixture(false, 1);
  try {
    await f.completed("verification:0", 24_000);
    await commitSettledCrashBoundary(f);
    const detail = await inspect(f.db);
    assert.equal(detail.recoveryMode, "settled_accounting_adoption");
    assert.equal(detail.canFinalize, true, detail.blockReason ?? "");
    const before = await accounting(f.db);
    const beforeUsageLedger = (await f.db.query("SELECT * FROM storyhold.ai_usage_ledger ORDER BY id")).rows;
    const done = await finalizePremiumRecovery(f.db, {
      actorId: ACTOR, runId: RUN, expectedFingerprint: detail.fingerprint,
      note: "Verified the funded overage crash-boundary accounting state.",
      confirmProviderChecked: true, decisions: [],
    });
    assert.equal(done.recoveryMode, "settled_accounting_adoption");
    assert.equal(done.receipt?.creditsUsed, 2);
    assert.equal(done.receipt?.creditsRefunded, 0);
    assert.deepEqual((await f.db.query("SELECT * FROM storyhold.credit_reservations ORDER BY id")).rows, before.holds);
    assert.deepEqual((await f.db.query("SELECT * FROM storyhold.credit_ledger ORDER BY id")).rows, before.ledger);
    assert.deepEqual((await f.db.query("SELECT * FROM storyhold.ai_usage_ledger ORDER BY id")).rows, beforeUsageLedger);
    const stored = (await f.db.query<{ receipt: Record<string, unknown> }>(
      "SELECT receipt FROM storyhold.world_analysis_premium_reconciliations WHERE run_id = $1", [RUN],
    )).rows[0]!.receipt;
    assert.equal(stored.version, 8);
    assert.equal(typeof stored.receiptFingerprint, "string");
    assert.equal(await premiumReviewFinalizationMatches(f.db, RUN), true);
    assert.equal(await premiumReviewReconciliationPending(f.db, WORLD), false);
  } finally { await f.db.close(); }
});

test("settled adoption fails closed on ambiguous accounting, unresolved calls, or prior canon-promotion receipts", async () => {
  const mutations: Array<{ name: string; mutate: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void> }> = [
    { name: "run charge drift", mutate: async (f) => { await f.db.query("UPDATE storyhold.world_analysis_runs SET premium_ai_credits_charged = premium_ai_credits_charged + 1 WHERE id = $1", [RUN]); } },
    { name: "extra settlement ledger row", mutate: async (f) => { await f.db.query(
      `INSERT INTO storyhold.credit_ledger
        (id, player_id, world_id, campaign_id, reservation_id, operation, request_id,
         entry_kind, credits_delta, balance_after, provider, model, cost_micros, metadata)
       SELECT $2, player_id, world_id, campaign_id, reservation_id, operation, request_id,
              entry_kind, credits_delta, balance_after, provider, model, cost_micros, metadata
         FROM storyhold.credit_ledger
        WHERE reservation_id = $1 AND entry_kind = 'settle_adjustment'`,
      [f.reservation.id, uuid(602)],
    ); } },
    { name: "journal provider drift", mutate: async (f) => {
      const row = (await f.db.query<{ request_snapshot: Record<string, unknown> }>(
        "SELECT request_snapshot FROM storyhold.world_analysis_ai_calls WHERE run_id = $1 AND step_key = 'verification:0'", [RUN],
      )).rows[0]!;
      const requestSnapshot = { ...row.request_snapshot, provider: "wrong-provider" };
      await f.db.query(
        `UPDATE storyhold.world_analysis_ai_calls
            SET request_snapshot = $2::jsonb, request_fingerprint = $3
          WHERE run_id = $1 AND step_key = 'verification:0'`,
        [RUN, JSON.stringify(requestSnapshot), canonPayloadFingerprint(requestSnapshot as JsonObject)],
      );
    } },
    { name: "extra usage row", mutate: async (f) => { await f.db.query(`INSERT INTO storyhold.ai_usage_ledger
      (id, player_id, world_id, operation, provider, model, request_id)
      VALUES ($1, $2, $3, 'other', 'other', 'other', $4)`, [uuid(601), PLAYER, WORLD, RUN]); } },
    { name: "usage ledger canon flag", mutate: async (f) => { await f.db.query("UPDATE storyhold.ai_usage_ledger SET metadata = jsonb_set(metadata, '{canonPromoted}', 'true'::jsonb) WHERE request_id = $1", [RUN]); } },
    { name: "canon promotion", mutate: async (f) => { await f.db.query("INSERT INTO storyhold.world_analysis_claim_reviews (run_id) VALUES ($1)", [RUN]); } },
    { name: "unresolved call", mutate: async (f) => {
      const row = (await f.db.query<{ billable_attempts: unknown[] }>(
        "SELECT billable_attempts FROM storyhold.world_analysis_ai_calls WHERE run_id = $1 AND step_key = 'verification:0'",
        [RUN],
      )).rows[0]!;
      const resultFingerprint = canonPayloadFingerprint({
        version: "storyhold:premium-review-outcome:v1",
        status: "uncertain",
        result: null,
        billableAttempts: row.billable_attempts,
      } as JsonObject);
      await f.db.query(
        `UPDATE storyhold.world_analysis_ai_calls
            SET status = 'uncertain', result_snapshot = NULL, result_fingerprint = $2
          WHERE run_id = $1 AND step_key = 'verification:0'`,
        [RUN, resultFingerprint],
      );
    } },
  ];
  for (const { name, mutate } of mutations) {
    const f = await fixture();
    try {
      await f.completed("verification:0", 12_000);
      await commitSettledCrashBoundary(f);
      await mutate(f);
      const detail = await inspect(f.db);
      assert.equal(detail.canFinalize, false, name);
      assert.match(detail.blockReason ?? "", /already-settled|original protected credit hold|integrity|manual investigation|original execution scope/iu);
    } finally { await f.db.close(); }
  }
});

test("receipt insertion failure leaves an adopted settlement untouched and the run recoverable", async () => {
  const f = await fixture();
  try {
    await f.completed("verification:0", 12_000);
    await commitSettledCrashBoundary(f);
    const detail = await inspect(f.db);
    await f.db.exec(`CREATE FUNCTION storyhold.fail_adoption_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt unavailable'; END; $$;
      CREATE TRIGGER fail_adoption_receipt BEFORE INSERT ON storyhold.world_analysis_premium_reconciliations FOR EACH ROW EXECUTE FUNCTION storyhold.fail_adoption_receipt();`);
    const beforeAccounting = await accounting(f.db);
    const beforeRun = (await f.db.query("SELECT * FROM storyhold.world_analysis_runs WHERE id = $1", [RUN])).rows;
    await assert.rejects(finalizePremiumRecovery(f.db, {
      actorId: ACTOR, runId: RUN, expectedFingerprint: detail.fingerprint,
      note: "Verified the settled crash-boundary accounting state.",
      confirmProviderChecked: true, decisions: [],
    }), /receipt unavailable/);
    assert.deepEqual(await accounting(f.db), beforeAccounting);
    assert.deepEqual((await f.db.query("SELECT * FROM storyhold.world_analysis_runs WHERE id = $1", [RUN])).rows, beforeRun);
  } finally { await f.db.close(); }
});

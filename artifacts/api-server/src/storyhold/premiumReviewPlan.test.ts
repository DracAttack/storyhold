import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { AiGatewayUnavailableError, type AiTextResult, type AiBillableAttempt } from "./aiGateway";
import { canonPayloadFingerprint, type JsonObject } from "./analysisVerificationContracts";
import {
  executeJournaledPremiumCall,
  premiumReviewJournalSchemaSql,
} from "./premiumReviewJournal";
import {
  assertPremiumChronologyJournalPrefix,
  freezePremiumClockManifest,
  PREMIUM_CLOCK_PAGES_PER_VERIFICATION_BATCH_LIMIT,
  type PremiumClockManifest,
  type PremiumReviewPlan,
  PremiumReviewPlanError,
  premiumReviewPlanSchemaSql,
  premiumReviewMaximumClockPageCount,
  premiumReviewVerificationStepKeys,
  readPremiumReviewPlan,
  readPremiumClockManifest,
  savePremiumReviewPlan,
  validatePremiumReviewResume,
} from "./premiumReviewPlan";

const RUN = "00000000-0000-4000-8000-000000000301";
const WORLD = "00000000-0000-4000-8000-000000000302";
const EDITION = "00000000-0000-4000-8000-000000000303";
const PLAYER = "00000000-0000-4000-8000-000000000304";
const RESERVATION = "00000000-0000-4000-8000-000000000305";

function plan(): Extract<PremiumReviewPlan, { version: 1 }> {
  return {
    version: 1,
    runId: RUN,
    worldId: WORLD,
    editionId: EDITION,
    playerId: PLAYER,
    executionVersion: "premium-v1",
    scopeFingerprint: "pinned-corpus-owner-context-v1",
    provider: "openrouter",
    model: "openai/gpt-5.6-luna-pro",
    worldContext: { worldName: "Frozen world", premise: "An eastern keep", genre: "Fantasy", userGuidance: "Use only pinned evidence." },
    chunks: [1, 2, 3].map((index) => ({ id: `chunk-${index}`, sourceId: "source-1", sourceTitle: "Frozen manuscript", index, content: `Exact source text ${index}.`, sectionTitle: `Section ${index}` })),
    verificationBatches: [["chunk-1", "chunk-2"], ["chunk-3"]],
    incremental: true,
    partialDueToCredits: false,
    reservationId: RESERVATION,
    reservedCredits: 10,
    unlimited: false,
  };
}

function paginatedPlan(): Extract<PremiumReviewPlan, { version: 2 }> {
  return {
    ...plan(),
    version: 2,
    executionVersion: "premium-v2",
    verificationPages: [
      { stepKey: "verification:0", batchIndex: 0, pageIndex: 0, pageCount: 2, candidateKeys: Array.from({ length: 6 }, (_, index) => `claim:${String(index + 1).repeat(64)}`), packetFingerprint: `premium_packet_${"1".repeat(64)}` },
      { stepKey: "verification:1", batchIndex: 0, pageIndex: 1, pageCount: 2, candidateKeys: [`relation:${"b".repeat(64)}`], packetFingerprint: `premium_packet_${"1".repeat(64)}` },
      { stepKey: "verification:2", batchIndex: 1, pageIndex: 0, pageCount: 1, candidateKeys: [`rule:${"c".repeat(64)}`], packetFingerprint: `premium_packet_${"2".repeat(64)}` },
    ],
  };
}

function clockPlan(): Extract<PremiumReviewPlan, { version: 3 }> {
  return {
    ...paginatedPlan(),
    version: 3,
    executionVersion: "premium-v3",
    clockReviewVersion: 1,
    clockEntityRegistry: [{
      id: "00000000-0000-4000-8000-000000000340",
      name: "Mara",
      aliases: ["Captain Mara"],
      entityType: "character",
    }],
    clockOwnerConstraints: [{
      id: "00000000-0000-4000-8000-000000000341",
      kind: "timeline",
      instruction: "The evacuation happens after the alarm.",
      scopeEntityId: null,
    }],
  };
}

function resumeParams(saved: PremiumReviewPlan = plan()) {
  return {
    runId: saved.runId, worldId: saved.worldId, editionId: saved.editionId,
    playerId: saved.playerId, executionVersion: saved.executionVersion,
    scopeFingerprint: saved.scopeFingerprint, provider: saved.provider, model: saved.model,
  };
}

function clockManifest(pageCount: number, marker = "a"): PremiumClockManifest {
  return {
    version: 1,
    runId: RUN,
    worldId: WORLD,
    editionId: EDITION,
    pageCount,
    pageManifestFingerprint: `clock_page_manifest_${marker.repeat(64)}`,
    inputFingerprint: `clock_inventory_${marker.repeat(64)}`,
    requestManifestFingerprint: `canon_payload_${marker.repeat(64)}`,
  };
}

async function database() {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.players (id uuid PRIMARY KEY, role text NOT NULL);
    CREATE TABLE storyhold.world_analysis_runs (
      id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
      requested_by_player_id uuid NOT NULL, status text NOT NULL DEFAULT 'paused'
    );
    CREATE TABLE storyhold.credit_reservations (
      id uuid PRIMARY KEY, world_id uuid NOT NULL, player_id uuid NOT NULL,
      operation text NOT NULL, request_id text NOT NULL, reserved_credits integer NOT NULL,
      status text NOT NULL DEFAULT 'reserved', usage jsonb NOT NULL DEFAULT '{"original":"metadata"}'::jsonb
    );
  `);
  await db.exec(premiumReviewJournalSchemaSql);
  await db.exec(premiumReviewPlanSchemaSql);
  await db.query("INSERT INTO storyhold.players VALUES ($1, 'player')", [PLAYER]);
  await db.query("INSERT INTO storyhold.world_analysis_runs (id, world_id, canon_edition_id, requested_by_player_id) VALUES ($1, $2, $3, $4)", [RUN, WORLD, EDITION, PLAYER]);
  await db.query("INSERT INTO storyhold.credit_reservations (id, world_id, player_id, operation, request_id, reserved_credits) VALUES ($1, $2, $3, 'world_analysis', $4, 10)", [RESERVATION, WORLD, PLAYER, RUN]);
  return db;
}

function planError(code: string) {
  return (error: unknown) => error instanceof PremiumReviewPlanError && error.code === code;
}

function aiResult(): AiTextResult {
  return {
    text: '{"verified":true}', provider: "openrouter", model: plan().model, reasoning: "high",
    usage: { inputUnits: 10, outputUnits: 3, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 1, estimatedCostMicros: 50, pricingKnown: true, pricingVersion: "test", costEstimated: true },
    runtime: {
      configured: true, mode: "connected", provider: "openrouter", model: plan().model,
      billable: true, sendsSourceTextOffDevice: true, explanation: "Stub result without network.",
      stage: "verification", execution: null,
      localExtraction: { enabled: false, configured: false, provider: "gliner2", model: "local", endpoint: null, endpointKind: null, sendsSourceTextOffDevice: false, explanation: "Disabled" },
      providers: [],
      routing: { director: null, narration: null, adultNarration: null, analysis: null, canonReview: "openrouter" },
      stageRouting: { extraction: null, verification: "openrouter", dossier: null, chronology: null, director: null, narration: null, adaptation: null },
    },
  };
}

async function completeCall(db: PGlite, stepKey = "verification:0", result = aiResult()) {
  return executeJournaledPremiumCall(db, {
    runId: RUN, stepKey, provider: plan().provider, model: plan().model,
    request: { task: "canon_review", stage: "verification", system: "Frozen prompt", messages: [{ role: "user", content: "Pinned source text" }] },
    invoke: async () => result,
  });
}

test("saving freezes exact text, context, batches, and original hold once without replacing them", async () => {
  const db = await database();
  try {
    assert.equal(await readPremiumReviewPlan(db, RUN), null);
    const supplied = plan();
    const saved = await savePremiumReviewPlan(db, supplied);
    assert.deepEqual(saved, plan());
    assert.deepEqual(await savePremiumReviewPlan(db, plan()), plan());
    supplied.chunks[0]!.content = "Caller mutation after saving";
    supplied.worldContext.worldName = "Mutable current name";
    assert.deepEqual(await readPremiumReviewPlan(db, RUN), plan());
    await assert.rejects(savePremiumReviewPlan(db, supplied), planError("PLAN_MISMATCH"));
    const held = await db.query<{ usage: Record<string, unknown> }>("SELECT usage FROM storyhold.credit_reservations WHERE id = $1", [RESERVATION]);
    assert.deepEqual(held.rows[0]?.usage, { original: "metadata", retainUntilReconciled: true });
    await assert.rejects(db.query("UPDATE storyhold.world_analysis_premium_plans SET snapshot = '{}'::jsonb"), /immutable/);
  } finally {
    await db.close();
  }
});

test("new clock plans are additive and older frozen plans cannot silently acquire their contract", async () => {
  const db = await database();
  try {
    const supplied = clockPlan();
    await savePremiumReviewPlan(db, supplied);
    assert.deepEqual(await readPremiumReviewPlan(db, RUN), supplied);
    assert.deepEqual(premiumReviewVerificationStepKeys(supplied), supplied.verificationPages.map((page) => page.stepKey));
    assert.equal(PREMIUM_CLOCK_PAGES_PER_VERIFICATION_BATCH_LIMIT, 4);
    assert.equal(premiumReviewMaximumClockPageCount(supplied), 8);
    await assert.rejects(savePremiumReviewPlan(db, { ...supplied, clockReviewVersion: 2 } as unknown as PremiumReviewPlan), planError("PLAN_INVALID"));
    await assert.rejects(savePremiumReviewPlan(db, {
      ...supplied,
      clockEntityRegistry: [...supplied.clockEntityRegistry, supplied.clockEntityRegistry[0]!],
    } as unknown as PremiumReviewPlan), planError("PLAN_INVALID"));
    const missingScope = structuredClone(supplied) as unknown as Record<string, unknown>;
    delete ((missingScope.clockOwnerConstraints as Array<Record<string, unknown>>)[0]!).scopeEntityId;
    await assert.rejects(savePremiumReviewPlan(db, missingScope as unknown as PremiumReviewPlan), planError("PLAN_INVALID"));
    await assert.rejects(savePremiumReviewPlan(db, {
      ...supplied,
      clockOwnerConstraints: [{ ...supplied.clockOwnerConstraints[0]!, scopeEntityId: "00000000-0000-4000-8000-000000000999" }],
    }), planError("PLAN_INVALID"));
  } finally { await db.close(); }
  const old = paginatedPlan();
  const other = await database();
  try {
    await assert.rejects(savePremiumReviewPlan(other, { ...old, clockReviewVersion: 1 } as unknown as PremiumReviewPlan), planError("PLAN_INVALID"));
  } finally { await other.close(); }
});

test("v3 clock journal guard accepts only the funded exact prefix after every verification page", async () => {
  const db = await database();
  try {
    const frozen = clockPlan();
    await savePremiumReviewPlan(db, frozen);
    await assert.rejects(
      assertPremiumChronologyJournalPrefix(db, frozen, clockManifest(2)),
      planError("CLOCK_MANIFEST_MISSING"),
    );
    await assert.rejects(
      freezePremiumClockManifest(db, frozen, clockManifest(2)),
      planError("CLOCK_JOURNAL_MISMATCH"),
    );
    for (const stepKey of premiumReviewVerificationStepKeys(frozen)) await completeCall(db, stepKey);
    assert.deepEqual(await freezePremiumClockManifest(db, frozen, clockManifest(3)), clockManifest(3));
    assert.deepEqual(await readPremiumClockManifest(db, frozen), clockManifest(3));
    await assertPremiumChronologyJournalPrefix(db, frozen, clockManifest(3));
    await assert.rejects(
      freezePremiumClockManifest(db, frozen, {
        ...clockManifest(3),
        requestManifestFingerprint: `canon_payload_${"b".repeat(64)}`,
      }),
      planError("CLOCK_MANIFEST_MISMATCH"),
    );
    await assert.rejects(
      freezePremiumClockManifest(db, frozen, clockManifest(2, "b")),
      planError("CLOCK_MANIFEST_MISMATCH"),
    );
    await completeCall(db, "chronology:0");
    await assertPremiumChronologyJournalPrefix(db, frozen, clockManifest(3));
    await assert.rejects(
      assertPremiumChronologyJournalPrefix(db, frozen, clockManifest(3), { requireComplete: true }),
      planError("CLOCK_JOURNAL_MISMATCH"),
    );
    await completeCall(db, "chronology:2");
    await assert.rejects(
      assertPremiumChronologyJournalPrefix(db, frozen, clockManifest(3)),
      planError("CLOCK_JOURNAL_MISMATCH"),
    );
    await completeCall(db, "chronology:1");
    await assertPremiumChronologyJournalPrefix(db, frozen, clockManifest(3), { requireComplete: true });
  } finally { await db.close(); }
});

test("v3 clock journal guard rejects unreserved, unfinished, and legacy clock boundaries", async () => {
  const db = await database();
  try {
    const frozen = clockPlan();
    await savePremiumReviewPlan(db, frozen);
    for (const stepKey of premiumReviewVerificationStepKeys(frozen)) await completeCall(db, stepKey);
    await assert.rejects(
      freezePremiumClockManifest(db, frozen, clockManifest(premiumReviewMaximumClockPageCount(frozen) + 1)),
      planError("CLOCK_MANIFEST_INVALID"),
    );
    await assert.rejects(
      assertPremiumChronologyJournalPrefix(db, paginatedPlan(), clockManifest(0)),
      planError("PLAN_INVALID"),
    );
    await freezePremiumClockManifest(db, frozen, clockManifest(1));
    await db.query(
      `INSERT INTO storyhold.world_analysis_ai_calls
        (run_id, step_key, request_fingerprint, request_snapshot, status)
       VALUES ($1, 'chronology:0', 'not-authentic', '{}'::jsonb, 'dispatched')`,
      [RUN],
    );
    await assert.rejects(
      assertPremiumChronologyJournalPrefix(db, frozen, clockManifest(1)),
      planError("CLOCK_JOURNAL_MISMATCH"),
    );
  } finally { await db.close(); }
});

test("v3 resume rejects a contiguous clock prefix beyond its immutable reserved maximum", async () => {
  const db = await database();
  try {
    const frozen = clockPlan();
    await savePremiumReviewPlan(db, frozen);
    for (const stepKey of premiumReviewVerificationStepKeys(frozen)) await completeCall(db, stepKey);
    const maximum = premiumReviewMaximumClockPageCount(frozen);
    await freezePremiumClockManifest(db, frozen, clockManifest(maximum));
    for (let index = 0; index < maximum; index += 1) await completeCall(db, `chronology:${index}`);
    assert.deepEqual(await validatePremiumReviewResume(db, resumeParams(frozen)), frozen);
    await completeCall(db, `chronology:${maximum}`);
    await assert.rejects(
      validatePremiumReviewResume(db, resumeParams(frozen)),
      planError("JOURNAL_NOT_RESUMABLE"),
    );
  } finally { await db.close(); }
});

test("v3 freezes an empty clock inventory and cannot later expand it on resume", async () => {
  const db = await database();
  try {
    const frozen = clockPlan();
    await savePremiumReviewPlan(db, frozen);
    for (const stepKey of premiumReviewVerificationStepKeys(frozen)) await completeCall(db, stepKey);
    const empty = clockManifest(0);
    assert.deepEqual(await freezePremiumClockManifest(db, frozen, empty), empty);
    await assertPremiumChronologyJournalPrefix(db, frozen, empty, { requireComplete: true });
    assert.deepEqual(await validatePremiumReviewResume(db, resumeParams(frozen)), frozen);
    await assert.rejects(
      freezePremiumClockManifest(db, frozen, clockManifest(1, "b")),
      planError("CLOCK_MANIFEST_MISMATCH"),
    );
    await completeCall(db, "chronology:0");
    await assert.rejects(
      validatePremiumReviewResume(db, resumeParams(frozen)),
      planError("CLOCK_JOURNAL_MISMATCH"),
    );
  } finally { await db.close(); }
});

test("legacy plans retain their exact v1 fingerprint namespace and step inventory", async () => {
  const db = await database();
  try {
    await savePremiumReviewPlan(db, plan());
    const saved = await db.query<{ fingerprint: string }>("SELECT fingerprint FROM storyhold.world_analysis_premium_plans WHERE run_id = $1", [RUN]);
    assert.equal(saved.rows[0]?.fingerprint, canonPayloadFingerprint({ namespace: "storyhold:premium-review-plan:v1", plan: plan() as unknown as JsonObject }));
    assert.deepEqual(premiumReviewVerificationStepKeys(plan()), ["verification:0", "verification:1"]);
    assert.deepEqual(await validatePremiumReviewResume(db, resumeParams()), plan());
    await assert.rejects(savePremiumReviewPlan(db, { ...plan(), verificationPages: [] } as unknown as PremiumReviewPlan), planError("PLAN_INVALID"));
  } finally {
    await db.close();
  }
});

test("v2 freezes candidate page identities and source groups with an independent fingerprint namespace", async () => {
  const db = await database();
  try {
    const supplied = paginatedPlan();
    const saved = await savePremiumReviewPlan(db, supplied);
    assert.deepEqual(saved, paginatedPlan());
    assert.deepEqual(premiumReviewVerificationStepKeys(saved), ["verification:0", "verification:1", "verification:2"]);
    assert.deepEqual(await savePremiumReviewPlan(db, paginatedPlan()), saved);
    const stored = await db.query<{ fingerprint: string }>("SELECT fingerprint FROM storyhold.world_analysis_premium_plans WHERE run_id = $1", [RUN]);
    assert.equal(stored.rows[0]?.fingerprint, canonPayloadFingerprint({ namespace: "storyhold:premium-review-plan:v2", plan: paginatedPlan() as unknown as JsonObject }));
    supplied.verificationPages[0]!.candidateKeys[0] = `claim:${"d".repeat(64)}`;
    assert.deepEqual(await readPremiumReviewPlan(db, RUN), paginatedPlan());
    await assert.rejects(savePremiumReviewPlan(db, supplied), planError("PLAN_MISMATCH"));
    await assert.rejects(savePremiumReviewPlan(db, plan()), planError("PLAN_MISMATCH"));
    await assert.rejects(validatePremiumReviewResume(db, resumeParams()), planError("RESUME_SCOPE_MISMATCH"));
    assert.deepEqual(await validatePremiumReviewResume(db, resumeParams(paginatedPlan())), paginatedPlan());
  } finally {
    await db.close();
  }
});

test("v2 rejects missing, oversized, incomplete, reordered, or mismatched candidate page groups before retaining credits", async () => {
  const db = await database();
  try {
    const pages = paginatedPlan().verificationPages;
    const invalidPages: unknown[] = [
      undefined, [],
      Array.from({ length: 100_001 }, () => pages[0]),
      [pages[0]],
      [pages[1], pages[0], pages[2]],
      [pages[0], { ...pages[1], stepKey: "verification:2" }, { ...pages[2], stepKey: "verification:3" }],
      [pages[0], { ...pages[1], batchIndex: 1 }, pages[2]],
      [pages[0], { ...pages[1], pageCount: 3 }, pages[2]],
      [pages[0], { ...pages[1], packetFingerprint: `premium_packet_${"3".repeat(64)}` }, pages[2]],
      [pages[0], { ...pages[1], candidateKeys: pages[0]!.candidateKeys }, pages[2]],
      [pages[0], pages[1], { ...pages[2], batchIndex: 2 }],
    ];
    for (const verificationPages of invalidPages) {
      await assert.rejects(savePremiumReviewPlan(db, { ...paginatedPlan(), verificationPages } as PremiumReviewPlan), planError("PLAN_INVALID"));
    }
    assert.equal(await readPremiumReviewPlan(db, RUN), null);
    const held = await db.query<{ usage: Record<string, unknown> }>("SELECT usage FROM storyhold.credit_reservations");
    assert.equal(held.rows[0]?.usage.retainUntilReconciled, undefined);
  } finally {
    await db.close();
  }
});

test("v2 resume follows a contiguous candidate-page prefix and replays saved pages without invoking another provider call", async () => {
  const db = await database();
  try {
    const frozen = paginatedPlan();
    await savePremiumReviewPlan(db, frozen);
    await completeCall(db, "verification:1");
    await assert.rejects(validatePremiumReviewResume(db, resumeParams(frozen)), planError("JOURNAL_NOT_RESUMABLE"));
    await db.query("UPDATE storyhold.world_analysis_ai_calls SET step_key = 'verification:0'");
    assert.deepEqual(await validatePremiumReviewResume(db, resumeParams(frozen)), frozen);
    const replay = await executeJournaledPremiumCall(db, {
      runId: RUN, stepKey: "verification:0", provider: frozen.provider, model: frozen.model,
      request: { task: "canon_review", stage: "verification", system: "Frozen prompt", messages: [{ role: "user", content: "Pinned source text" }] },
      invoke: async () => { throw new Error("A completed page must not be charged or dispatched twice"); },
    });
    assert.equal(replay.text, aiResult().text);
    await completeCall(db, "verification:1");
    assert.deepEqual(await validatePremiumReviewResume(db, resumeParams(frozen)), frozen);
    await completeCall(db, "verification:2");
    await completeCall(db, "chronology:0");
    assert.deepEqual(await validatePremiumReviewResume(db, resumeParams(frozen)), frozen);
    await completeCall(db, "verification:3");
    await assert.rejects(validatePremiumReviewResume(db, resumeParams(frozen)), planError("JOURNAL_NOT_RESUMABLE"));
  } finally {
    await db.close();
  }
});

test("v2 chronology is blocked until every page is complete, not merely one call per source batch", async () => {
  const db = await database();
  try {
    const frozen = paginatedPlan();
    await savePremiumReviewPlan(db, frozen);
    await completeCall(db, "verification:0");
    await completeCall(db, "chronology:0");
    await assert.rejects(validatePremiumReviewResume(db, resumeParams(frozen)), planError("JOURNAL_NOT_RESUMABLE"));
    await completeCall(db, "verification:1");
    // There are now two verification calls and two source batches, but a third
    // mandatory candidate page remains. Legacy source-batch counting is unsafe.
    await assert.rejects(validatePremiumReviewResume(db, resumeParams(frozen)), planError("JOURNAL_NOT_RESUMABLE"));
  } finally {
    await db.close();
  }
});

test("stored v2 page identities, packet fingerprints, and source group tampering fail integrity checks", async () => {
  const db = await database();
  try {
    const frozen = paginatedPlan();
    await savePremiumReviewPlan(db, frozen);
    await db.exec("ALTER TABLE storyhold.world_analysis_premium_plans DISABLE TRIGGER premium_plan_immutable");
    for (const mutate of [
      (value: typeof frozen) => { value.verificationPages[0]!.candidateKeys[0] = `claim:${"f".repeat(64)}`; },
      (value: typeof frozen) => { value.verificationPages[0]!.packetFingerprint = `premium_packet_${"f".repeat(64)}`; },
      (value: typeof frozen) => { value.verificationPages[0]!.batchIndex = 1; },
      (value: typeof frozen) => { value.verificationPages[0]!.stepKey = "verification:7"; },
    ]) {
      const tampered = paginatedPlan();
      mutate(tampered);
      await db.query("UPDATE storyhold.world_analysis_premium_plans SET snapshot = $1::jsonb", [JSON.stringify(tampered)]);
      await assert.rejects(readPremiumReviewPlan(db, RUN), planError("PLAN_INTEGRITY"));
      await assert.rejects(validatePremiumReviewResume(db, resumeParams(frozen)), planError("PLAN_INTEGRITY"));
    }
  } finally {
    await db.close();
  }
});

test("plan validation rejects malformed versions, duplicate chunks, and non-exact ordered partitions before writes", async () => {
  const db = await database();
  try {
    const bad: unknown[] = [
      { ...plan(), version: 2 },
      { ...plan(), incremental: undefined },
      { ...plan(), chunks: [] },
      { ...plan(), chunks: [plan().chunks[0], plan().chunks[0]] },
      { ...plan(), verificationBatches: [["chunk-1", "chunk-2"]] },
      { ...plan(), verificationBatches: [["chunk-2", "chunk-1"], ["chunk-3"]] },
      { ...plan(), verificationBatches: [["chunk-1"], ["chunk-1", "chunk-2", "chunk-3"]] },
      { ...plan(), verificationBatches: [[], ["chunk-1", "chunk-2", "chunk-3"]] },
      { ...plan(), reservationId: null },
      { ...plan(), reservedCredits: -1 },
      { ...plan(), reservedCredits: 1.5 },
      { ...plan(), unlimited: true },
      { ...plan(), worldContext: { ...plan().worldContext, worldName: "" } },
      { ...plan(), chunks: [{ ...plan().chunks[0], index: Number.NaN }] },
    ];
    for (const invalid of bad) {
      await assert.rejects(savePremiumReviewPlan(db, invalid as PremiumReviewPlan), planError("PLAN_INVALID"));
    }
    assert.equal(await readPremiumReviewPlan(db, RUN), null);
    const held = await db.query<{ usage: Record<string, unknown> }>("SELECT usage FROM storyhold.credit_reservations");
    assert.equal(held.rows[0]?.usage.retainUntilReconciled, undefined);
  } finally {
    await db.close();
  }
});

test("legacy journal calls cannot acquire a plan after dispatch or resume without one", async () => {
  const db = await database();
  try {
    await assert.rejects(validatePremiumReviewResume(db, resumeParams()), planError("PLAN_MISSING"));
    await completeCall(db);
    await assert.rejects(savePremiumReviewPlan(db, plan()), planError("JOURNAL_WITHOUT_PLAN"));
    await assert.rejects(validatePremiumReviewResume(db, resumeParams()), planError("JOURNAL_WITHOUT_PLAN"));
    assert.equal(await readPremiumReviewPlan(db, RUN), null);
  } finally {
    await db.close();
  }
});

test("saving requires the exact original reserved amount, player, world, operation, and run", async () => {
  const db = await database();
  try {
    const mutations = [
      "reserved_credits = 9", "player_id = world_id", "world_id = player_id",
      "operation = 'entity_review'", "request_id = 'different-run'", "status = 'released'",
    ];
    for (const mutation of mutations) {
      await db.exec(`UPDATE storyhold.credit_reservations SET ${mutation}`);
      await assert.rejects(savePremiumReviewPlan(db, plan()), planError("RESERVATION_UNAVAILABLE"));
      assert.equal(await readPremiumReviewPlan(db, RUN), null);
      await db.query("UPDATE storyhold.credit_reservations SET reserved_credits = 10, player_id = $1, world_id = $2, operation = 'world_analysis', request_id = $3, status = 'reserved'", [PLAYER, WORLD, RUN]);
    }
    await savePremiumReviewPlan(db, plan());
    await db.query("UPDATE storyhold.credit_reservations SET reserved_credits = 11");
    await assert.rejects(validatePremiumReviewResume(db, resumeParams()), planError("RESERVATION_UNAVAILABLE"));
  } finally {
    await db.close();
  }
});

test("saving rolls back retained credit marker if the immutable plan insert fails", async () => {
  const db = await database();
  try {
    await db.exec(`
      CREATE FUNCTION storyhold.fail_plan_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Simulated insert failure'; END;
      $$;
      CREATE TRIGGER fail_plan_insert BEFORE INSERT ON storyhold.world_analysis_premium_plans
      FOR EACH ROW EXECUTE FUNCTION storyhold.fail_plan_insert();
    `);
    await assert.rejects(savePremiumReviewPlan(db, plan()), /Simulated insert failure/);
    assert.equal(await readPremiumReviewPlan(db, RUN), null);
    const held = await db.query<{ usage: Record<string, unknown> }>("SELECT usage FROM storyhold.credit_reservations");
    assert.deepEqual(held.rows[0]?.usage, { original: "metadata" });
  } finally {
    await db.close();
  }
});

test("explicit exempt plans require current owner or admin role on save and deliberate resume", async () => {
  const db = await database();
  try {
    const exempt = { ...plan(), unlimited: true, reservationId: null, reservedCredits: 0 };
    await assert.rejects(savePremiumReviewPlan(db, exempt), planError("EXEMPTION_UNAVAILABLE"));
    await db.query("UPDATE storyhold.players SET role = 'owner' WHERE id = $1", [PLAYER]);
    await savePremiumReviewPlan(db, exempt);
    assert.deepEqual(await validatePremiumReviewResume(db, resumeParams()), exempt);
    await db.query("UPDATE storyhold.players SET role = 'admin' WHERE id = $1", [PLAYER]);
    assert.deepEqual(await validatePremiumReviewResume(db, resumeParams()), exempt);
    await db.query("UPDATE storyhold.players SET role = 'player' WHERE id = $1", [PLAYER]);
    await assert.rejects(savePremiumReviewPlan(db, exempt), planError("EXEMPTION_UNAVAILABLE"));
    await assert.rejects(validatePremiumReviewResume(db, resumeParams()), planError("EXEMPTION_UNAVAILABLE"));
  } finally {
    await db.close();
  }
});

test("resume returns exact frozen plan only for matching scope, execution version, runtime and retained hold", async () => {
  const db = await database();
  try {
    await savePremiumReviewPlan(db, plan());
    await completeCall(db);
    assert.deepEqual(await validatePremiumReviewResume(db, resumeParams()), plan());
    for (const key of ["worldId", "editionId", "playerId", "executionVersion", "scopeFingerprint", "provider", "model"] as const) {
      await assert.rejects(validatePremiumReviewResume(db, { ...resumeParams(), [key]: "changed" }), planError("RESUME_SCOPE_MISMATCH"));
    }
    await db.query("UPDATE storyhold.credit_reservations SET usage = '{}'::jsonb");
    await assert.rejects(validatePremiumReviewResume(db, resumeParams()), planError("RESERVATION_UNAVAILABLE"));
    await db.query("UPDATE storyhold.credit_reservations SET usage = '{\"retainUntilReconciled\":true}'::jsonb, status = 'settled'");
    await assert.rejects(validatePremiumReviewResume(db, resumeParams()), planError("RESERVATION_UNAVAILABLE"));
  } finally {
    await db.close();
  }
});

test("resume rejects journal gaps, unknown keys, and chronology ahead of frozen verification", async () => {
  const db = await database();
  try {
    await savePremiumReviewPlan(db, plan());
    await completeCall(db, "verification:1");
    await assert.rejects(validatePremiumReviewResume(db, resumeParams()), planError("JOURNAL_NOT_RESUMABLE"));
    for (const key of ["verification:01", "verification:-1", "verification:no", "other:0", "chronology:0"]) {
      await db.query("UPDATE storyhold.world_analysis_ai_calls SET step_key = $1", [key]);
      await assert.rejects(validatePremiumReviewResume(db, resumeParams()), planError("JOURNAL_NOT_RESUMABLE"));
    }
    await db.query("UPDATE storyhold.world_analysis_ai_calls SET step_key = 'verification:0'");
    await completeCall(db, "verification:1");
    await completeCall(db, "chronology:0");
    assert.deepEqual(await validatePremiumReviewResume(db, resumeParams()), plan());
    await db.query("UPDATE storyhold.world_analysis_ai_calls SET step_key = 'chronology:2' WHERE step_key = 'chronology:0'");
    await assert.rejects(validatePremiumReviewResume(db, resumeParams()), planError("JOURNAL_NOT_RESUMABLE"));
  } finally {
    await db.close();
  }
});

for (const outcome of ["dispatched", "uncertain", "rejected"] as const) {
  test(`resume blocks ${outcome} calls even when known usage is present`, async () => {
    const db = await database();
    try {
      await savePremiumReviewPlan(db, plan());
      if (outcome === "dispatched") {
        await completeCall(db);
        await db.query("UPDATE storyhold.world_analysis_ai_calls SET status = 'dispatched', result_snapshot = NULL, result_fingerprint = NULL, billable_attempts = '[]'::jsonb");
      } else {
        const attempt: AiBillableAttempt = { provider: "openrouter", model: plan().model, resolvedModel: plan().model, upstreamProvider: null, stage: "verification", reasoning: "high", usage: aiResult().usage };
        await assert.rejects(executeJournaledPremiumCall(db, {
          runId: RUN, stepKey: "verification:0", provider: plan().provider, model: plan().model,
          request: { task: "canon_review", system: "Frozen", messages: [] },
          invoke: async () => { throw outcome === "rejected" ? new AiGatewayUnavailableError("Invalid", [], [attempt]) : new Error("Unknown outcome"); },
        }));
      }
      await assert.rejects(validatePremiumReviewResume(db, resumeParams()), planError("JOURNAL_NOT_RESUMABLE"));
    } finally {
      await db.close();
    }
  });
}

test("tampered plan or completed journal contents cannot pass deliberate resume", async () => {
  const db = await database();
  try {
    await savePremiumReviewPlan(db, plan());
    await completeCall(db);
    await db.query("UPDATE storyhold.world_analysis_ai_calls SET result_snapshot = jsonb_set(result_snapshot, '{text}', '\"tampered\"'::jsonb)");
    await assert.rejects(validatePremiumReviewResume(db, resumeParams()), /integrity/);
    await db.exec("ALTER TABLE storyhold.world_analysis_premium_plans DISABLE TRIGGER premium_plan_immutable");
    await db.query("UPDATE storyhold.world_analysis_premium_plans SET snapshot = jsonb_set(snapshot, '{chunks,0,content}', '\"tampered source\"'::jsonb)");
    await assert.rejects(readPremiumReviewPlan(db, RUN), planError("PLAN_INTEGRITY"));
    await assert.rejects(savePremiumReviewPlan(db, plan()), planError("PLAN_INTEGRITY"));
    await assert.rejects(validatePremiumReviewResume(db, resumeParams()), planError("PLAN_INTEGRITY"));
  } finally {
    await db.close();
  }
});

test("completed journal calls with unknown pricing or invalid costs and counters cannot resume", async () => {
  for (const usageOverride of [
    { pricingKnown: false },
    { estimatedCostMicros: -1 },
    { estimatedCostMicros: Number.NaN },
    { estimatedCostMicros: Number.POSITIVE_INFINITY },
    { inputUnits: -1 },
    { outputUnits: Number.POSITIVE_INFINITY },
    { cachedInputUnits: -1 },
    { cacheWriteInputUnits: Number.NaN },
    { reasoningUnits: -1 },
  ]) {
    const db = await database();
    try {
      await savePremiumReviewPlan(db, plan());
      const result = aiResult();
      result.usage = { ...result.usage, ...usageOverride };
      await completeCall(db, "verification:0", result);
      await assert.rejects(validatePremiumReviewResume(db, resumeParams()), planError("JOURNAL_USAGE_UNVERIFIED"));
    } finally {
      await db.close();
    }
  }
});

test("unknown pricing in a completed call's prior billable attempt also blocks resume", async () => {
  const db = await database();
  try {
    await savePremiumReviewPlan(db, plan());
    const result = aiResult();
    result.priorBillableAttempts = [{
      provider: "openrouter", model: plan().model, resolvedModel: plan().model,
      upstreamProvider: null, stage: "verification", reasoning: "high",
      usage: { ...result.usage, pricingKnown: false },
    }];
    await completeCall(db, "verification:0", result);
    await assert.rejects(validatePremiumReviewResume(db, resumeParams()), planError("JOURNAL_USAGE_UNVERIFIED"));
  } finally {
    await db.close();
  }
});

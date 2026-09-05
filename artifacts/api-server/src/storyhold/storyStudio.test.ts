import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { AiBillableAttempt, AiTextResult, AiUsage } from "./aiGateway";
import { meteredAiInputSha256, shouldPreserveMeteredResult } from "./campaignPlay";
import {
  assertContiguousTurnSelection,
  parseStoryAdaptation,
  registerStoryStudioRoutes,
  serializeStoryStudioAiResult,
  storyStudioAiResultFromJournal,
  storyStudioBillableUsage,
  storyStudioDraftMatchesRequest,
  storyStudioInputFromSavedRequest,
  storyStudioInsufficientCreditPayload,
  storyStudioSchemaSql,
} from "./storyStudio";

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";

function usage(costMicros: number, inputUnits = 100): AiUsage {
  return {
    inputUnits,
    outputUnits: 20,
    cachedInputUnits: 5,
    cacheWriteInputUnits: 0,
    reasoningUnits: 3,
    estimatedCostMicros: costMicros,
    pricingKnown: true,
    pricingVersion: "test-v1",
    costEstimated: true,
  };
}

function priorAttempt(): AiBillableAttempt {
  return {
    provider: "openrouter",
    model: "test/first",
    resolvedModel: "test/first-2026-09-01",
    upstreamProvider: "Test Provider",
    stage: "adaptation",
    reasoning: "medium",
    usage: usage(12_000, 60),
  };
}

function aiResult(): AiTextResult {
  return {
    text: JSON.stringify({ ok: true }),
    runtime: {
      configured: true,
      mode: "connected",
      provider: "openrouter",
      model: "test/final",
      billable: true,
      sendsSourceTextOffDevice: true,
      explanation: "test",
      localExtraction: {
        available: false,
        mode: "unavailable",
        implementation: "none",
        model: null,
        explanation: "test",
      },
      providers: [],
      routing: {
        director: null,
        narration: null,
        adultNarration: null,
        analysis: null,
        canonReview: null,
      },
      stageRouting: {
        extraction: null,
        verification: null,
        dossier: null,
        chronology: null,
        director: null,
        narration: null,
        adaptation: null,
      },
      stage: "adaptation",
      execution: null,
    },
    provider: "openrouter",
    model: "test/final",
    reasoning: "medium",
    usage: usage(24_000, 140),
    priorBillableAttempts: [priorAttempt()],
  };
}

test("Story Studio accepts only one ordered continuous range", () => {
  const turns = [
    { id: FIRST, turn_number: 4 },
    { id: SECOND, turn_number: 5 },
    { id: THIRD, turn_number: 6 },
  ];
  assert.doesNotThrow(() => assertContiguousTurnSelection([FIRST, SECOND, THIRD], turns));
  assert.throws(
    () => assertContiguousTurnSelection([FIRST, THIRD], turns),
    /continuous run/,
  );
  assert.throws(
    () => assertContiguousTurnSelection([SECOND, FIRST], turns),
    /continuous run/,
  );
});

test("Story Studio rejects adaptations that drop or invent source scenes", () => {
  const valid = JSON.stringify({
    sourceTurnIds: [FIRST, SECOND],
    title: "The Door Beneath the Rain",
    chapterSummary:
      "The party reaches the sealed structure and chooses to proceed despite an uncertain reading from its equipment.",
    outline: [
      { turnId: FIRST, heading: "Approach", purpose: "Carry the accepted approach into prose." },
      { turnId: SECOND, heading: "Decision", purpose: "Preserve the accepted decision and its uncertainty." },
    ],
    prose: "The rain found every seam in Addison's suit. ".repeat(20),
    adaptationNotes: ["The sensor uncertainty remains unresolved."],
  });
  const parsed = parseStoryAdaptation(valid, [FIRST, SECOND]);
  assert.equal(parsed.outline.length, 2);
  assert.equal(parsed.sourceTurnIds[1], SECOND);

  const invented = JSON.stringify({
    ...JSON.parse(valid),
    sourceTurnIds: [FIRST, THIRD],
  });
  assert.throws(
    () => parseStoryAdaptation(invented, [FIRST, SECOND]),
    /frozen scene range/,
  );
});

test("Story Studio journals prior billable attempts and charges their aggregate usage", () => {
  const generated = aiResult();
  const replayed = storyStudioAiResultFromJournal(
    serializeStoryStudioAiResult(generated),
  );

  assert.deepEqual(replayed.priorBillableAttempts, generated.priorBillableAttempts);
  const combined = storyStudioBillableUsage(replayed);
  assert.equal(combined.inputUnits, 200);
  assert.equal(combined.outputUnits, 40);
  assert.equal(combined.estimatedCostMicros, 36_000);
  assert.equal(combined.pricingVersion, "test-v1");
});

test("Story Studio saved-result serialization and replay fail closed", () => {
  assert.throws(
    () => storyStudioAiResultFromJournal("{not-json"),
    /METERED_AI_SAVED_RESULT_INVALID/,
  );
  const malformed = JSON.parse(serializeStoryStudioAiResult(aiResult()));
  delete malformed.priorBillableAttempts[0].stage;
  assert.throws(
    () => storyStudioAiResultFromJournal(JSON.stringify(malformed)),
    /METERED_AI_SAVED_RESULT_INVALID/,
  );
  const invalid = aiResult();
  invalid.usage = { ...invalid.usage, inputUnits: Number.NaN };
  let serializationError: unknown;
  try {
    serializeStoryStudioAiResult(invalid);
  } catch (error) {
    serializationError = error;
  }
  assert.match(
    serializationError instanceof Error ? serializationError.message : "",
    /METERED_AI_JOURNAL_COMPLETION_FAILED/,
  );
  assert.equal(shouldPreserveMeteredResult(serializationError, false), true);
});

test("Story Studio duplicate requests must match every frozen input", () => {
  const settings = {
    pov: "third_limited" as const,
    tense: "past" as const,
    length: "chapter" as const,
    fidelity: "strict" as const,
    voiceNotes: "Spare and observant.",
  };
  const request = {
    campaignId: FIRST,
    selectedTurnIds: [SECOND, THIRD],
    settings,
    requestedTitle: "The Long Door",
    sourceHash: "source-hash",
    inputFingerprint: "input-fingerprint",
  };
  const row: Record<string, unknown> = {
    campaign_id: FIRST,
    source_turn_ids: [SECOND, THIRD],
    settings,
    requested_title: "The Long Door",
    source_hash: "source-hash",
    input_fingerprint: "input-fingerprint",
  };
  assert.equal(storyStudioDraftMatchesRequest(row, request), true);

  const mutations: Array<Record<string, unknown>> = [
    { campaign_id: SECOND },
    { source_turn_ids: [THIRD, SECOND] },
    { settings: { ...settings, fidelity: "novelistic" } },
    { requested_title: "A Different Title" },
    { source_hash: "different-source" },
    { input_fingerprint: "different-input" },
  ];
  for (const mutation of mutations) {
    assert.equal(
      storyStudioDraftMatchesRequest({ ...row, ...mutation }, request),
      false,
    );
  }
  assert.equal(
    storyStudioDraftMatchesRequest({ ...row, input_fingerprint: "" }, request),
    false,
  );
});

test("Story Studio restores only the exact privately frozen provider input", () => {
  const input = {
    task: "story_adaptation" as const,
    system: "Preserve the accepted story ledger exactly.",
    messages: [{ role: "user" as const, content: "Private frozen scene evidence." }],
    reasoning: "medium" as const,
    contentMode: "standard" as const,
    maxOutputTokens: 4_000,
    temperature: 0.65,
  };
  const inputFingerprint = meteredAiInputSha256({ version: 2, input });
  assert.deepEqual(
    storyStudioInputFromSavedRequest({
      input_payload: input,
      input_fingerprint: inputFingerprint,
    }),
    input,
  );
  assert.throws(
    () => storyStudioInputFromSavedRequest({
      input_payload: { ...input, temperature: 1.2 },
      input_fingerprint: inputFingerprint,
    }),
    /SAVED_REQUEST_INVALID/,
  );
  assert.throws(
    () => storyStudioInputFromSavedRequest({
      input_payload: input,
      input_fingerprint: "0".repeat(64),
    }),
    /SAVED_REQUEST_INVALID/,
  );
});

test("Story Studio schema durably permits one unfinished adaptation per campaign", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.players (id uuid PRIMARY KEY);
      CREATE TABLE storyhold.worlds (id uuid PRIMARY KEY);
      CREATE TABLE storyhold.campaigns (id uuid PRIMARY KEY);
    `);
    await db.exec(storyStudioSchemaSql);
    await db.query("INSERT INTO storyhold.players (id) VALUES ($1)", [FIRST]);
    await db.query("INSERT INTO storyhold.worlds (id) VALUES ($1)", [SECOND]);
    await db.query("INSERT INTO storyhold.campaigns (id) VALUES ($1)", [THIRD]);
    const insert = (id: string, requestId: string) => db.query(
      `INSERT INTO storyhold.campaign_story_requests
        (id, campaign_id, world_id, created_by_player_id, request_id,
         source_turn_ids, source_hash, input_fingerprint, input_payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'source', $7, $8::jsonb)`,
      [id, THIRD, SECOND, FIRST, requestId, JSON.stringify([SECOND]), "a".repeat(64), "{}"],
    );
    await insert("44444444-4444-4444-8444-444444444444", "request_first");
    await assert.rejects(
      insert("55555555-5555-4555-8555-555555555555", "request_second"),
      /campaign_story_requests_one_pending/,
    );
    await db.query(
      "UPDATE storyhold.campaign_story_requests SET status = 'completed' WHERE request_id = 'request_first'",
    );
    await insert("55555555-5555-4555-8555-555555555555", "request_second");
    const pending = await db.query<{ request_id: string }>(
      "SELECT request_id FROM storyhold.campaign_story_requests WHERE status = 'prepared'",
    );
    assert.deepEqual(pending.rows.map((row) => row.request_id), ["request_second"]);
  } finally {
    await db.close();
  }
});

test("Story Studio hides pre-run estimates but gives an exact completed-work top-up", () => {
  const before = storyStudioInsufficientCreditPayload(
    { requiredCredits: 40, availableCredits: 12 },
    false,
  );
  assert.deepEqual(before, {
    error: "Your balance is too low to start this adaptation. Add credits and try again.",
    retrySameRequest: false,
  });
  assert.equal(JSON.stringify(before).includes("40"), false);
  assert.equal(JSON.stringify(before).includes("12"), false);
  assert.equal("requiredCredits" in before, false);
  assert.equal("creditsAvailable" in before, false);

  const after = storyStudioInsufficientCreditPayload(
    { requiredCredits: 40, availableCredits: 32 },
    true,
  );
  assert.equal(after.additionalCreditsRequired, 8);
  assert.equal(after.retrySameRequest, true);
  assert.match(String(after.error), /8 more credits/);
  assert.equal("requiredCredits" in after, false);
  assert.equal("creditsAvailable" in after, false);
});

test("Story Studio returns 409 when a duplicate request id belongs to different input", async () => {
  let postHandler: ((req: unknown, res: unknown) => Promise<void>) | null = null;
  const app = {
    get: () => undefined,
    patch: () => undefined,
    post: (_path: string, ...handlers: unknown[]) => {
      postHandler = handlers.at(-1) as (req: unknown, res: unknown) => Promise<void>;
    },
  };
  const db = {
    exec: async () => undefined,
    transaction: async () => {
      throw new Error("A conflicting duplicate must not begin paid work.");
    },
    query: async (sql: string) => {
      if (sql.includes("FROM storyhold.campaigns campaign")) {
        return {
          rows: [{
            id: FIRST,
            world_id: THIRD,
            world_name: "Test World",
            name: "Test Campaign",
            character_name: "Mara",
            state_version: 7,
            start_contract: {},
            player_role: "player",
            player_credits: 100,
          }],
        };
      }
      if (sql.includes("FROM storyhold.campaign_turns")) {
        return {
          rows: [
            {
              id: SECOND,
              turn_number: 1,
              player_action: "Open the door.",
              narration: "Mara opens the door.",
              scene_summary: "Mara opens a door.",
              outcome: "The door opens.",
              world_time_label: "Dawn",
              resolution: {},
            },
            {
              id: THIRD,
              turn_number: 2,
              player_action: "Step inside.",
              narration: "Mara steps inside.",
              scene_summary: "Mara enters.",
              outcome: "Mara is inside.",
              world_time_label: "Dawn",
              resolution: {},
            },
          ],
        };
      }
      if (sql.includes("FROM storyhold.campaign_story_drafts")) {
        return {
          rows: [{
            campaign_id: "44444444-4444-4444-8444-444444444444",
            source_turn_ids: [SECOND, THIRD],
            settings: {},
            requested_title: "Old title",
            source_hash: "old-source",
            input_fingerprint: "old-input",
          }],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const requireUser = (_req: unknown, _res: unknown, next: () => void) => next();
  registerStoryStudioRoutes({
    app: app as never,
    db: db as never,
    requireUser: requireUser as never,
  });
  assert.ok(postHandler);

  let status = 200;
  let body: Record<string, unknown> | null = null;
  const response = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: Record<string, unknown>) {
      body = value;
      return this;
    },
  };
  await postHandler!({
    params: { campaignId: FIRST },
    body: {
      requestId: "request_1234",
      turnIds: [SECOND, THIRD],
      title: "New title",
      settings: {},
    },
    localUser: { id: FIRST, email: "reader@example.com", role: "player" },
  }, response);

  assert.equal(status, 409);
  assert.match(String(body?.error), /different adaptation/);
  assert.equal("draft" in (body ?? {}), false);
});

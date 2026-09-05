import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { AiGatewayUnavailableError, chooseReasoningLevel } from "./aiGateway";
import {
  clockTriggerIsSatisfied,
  deriveTurnProgressionContract,
  MAX_TIME_ADVANCE_MINUTES,
  normalizeCampaignProposition,
} from "./causalEngine";
import {
  assertCampaignResolutionCausality,
  aggregateAiUsage,
  assertResolutionAgainstCanonicalContext,
  assertStrictCampaignCanonSnapshotIntegrity,
  combineDirectionAndNarration,
  campaignProductPricing,
  deterministicTimeAdvance,
  campaignProposalJournalIdentity,
  campaignScenePacketQueryHash,
  assertTurnProgressionContract,
  effectiveClockPropositions,
  explicitSceneRequested,
  filterVisibleClockEventIds,
  feedbackProfileFromRows,
  feedbackInfluenceForCampaign,
  generatedTurnFromJournal,
  insertWorldStateEventAndLinkMaturedClocks,
  inspectCampaignTurnLocally,
  isCampaignScenePacketCacheHit,
  lorekeeperFeedbackPatternKeys,
  loadCampaignContext,
  lockedSourceSnapshot,
  lockedReferenceSnapshot,
  lockedCanonTimeline,
  lockedWorldModel,
  markMeteredAiResultApplied,
  MeteredAiKnownBillableFailureError,
  MeteredAiUncertainOutcomeError,
  meteredAiInputSha256,
  meteredAiResultJournalSchemaSql,
  normalizeCampaignResolution,
  normalizeCampaignDirection,
  normalizeCampaignNarration,
  publicDirectionForNarrator,
  propositionKey,
  releaseAbandonedTurnReservations,
  runOrResumeMeteredAiResult,
  scheduledClockEventIsDue,
  serializeUnfinishedTurnRequest,
  serializeTurnProposal,
  strictAnchoredCampaignCanonScope,
  loadVerifiedStrictCampaignCanonContext,
} from "./campaignPlay";
import { stableCanonSha256 } from "./campaignCanonScope";
import { campaignExecutionPolicy, unrequestedCampaignSpecialistInspection } from "./campaignExecutionPolicy";
import {
  CreditEconomyError,
  creditEconomySchemaSql,
  reserveCredits,
  settleCreditReservationInTransaction,
} from "./creditEconomy";

test("quick actions do not receive the generic five-minute clock advance", () => {
  assert.equal(
    deterministicTimeAdvance("action", "I steal the customer's phone and run out the front door."),
    1,
  );
  assert.equal(deterministicTimeAdvance("action", "I ask Mara what happened."), 1);
  assert.equal(deterministicTimeAdvance("action", "I travel to the harbor."), 60);
  assert.equal(deterministicTimeAdvance("action", "I consider my options."), 2);
});

test("campaign postcheck reuses the narration evidence without calling any model", (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("A second extraction is forbidden."); });
  const direction = normalizeCampaignDirection({
    sceneSummary: "Mara waits at the harbor.", outcome: "success", worldTimeLabel: "Dawn",
    timeAdvanceMinutes: 1, stateChanges: [], propositions: [], clockEvents: [], memories: [],
  });
  const resolution = combineDirectionAndNarration(direction, { narration: "Mara nods to Echo." });
  const inspection = {
    status: "failed" as const, candidateClaimCount: 1, testedPairCount: 1, violations: [],
    nli: { status: "failed" as const, model: "test-nli", pairCount: 1, elapsedMilliseconds: 12, error: "NLI deadline" },
    glinerStatus: "partial", elapsedMilliseconds: 20, errors: ["NLI deadline"],
    localRead: {
      model: "test-gliner", passageKinds: ["dialogue"],
      relations: [{ subject: "Mara", relationType: "knows", target: "Echo" }],
      receipt: { status: "partial" as const, attemptedSegments: 2, completedSegments: 1, failedSegments: 1,
        relationCount: 1, signalCount: 1, classificationCount: 1, mentionCount: 2, elapsedMilliseconds: 8,
        errors: ["GLiNER deadline"], unprocessedSegments: 1 },
    },
  };
  const postcheck = inspectCampaignTurnLocally(resolution, direction, inspection);
  assert.equal(postcheck.status, "failed");
  assert.equal(postcheck.model, "test-gliner");
  assert.equal(postcheck.relationCount, 1);
  assert.equal(postcheck.unmodeledRelationshipLeads[0]?.target, "Echo");
  assert.equal(postcheck.canonInspection, inspection);
  assert.deepEqual(postcheck.errors, ["NLI deadline"]);
  assert.equal(postcheck.unprocessedSegments, 1);
});

test("AI-led live play records specialist checks as not requested, never passed", () => {
  assert.deepEqual(campaignExecutionPolicy(), { mode: "ai_led", browserAssist: false, localInference: false });
  assert.deepEqual(campaignExecutionPolicy(true), { mode: "manual", browserAssist: false, localInference: false });
  const direction = normalizeCampaignDirection({ sceneSummary: "Mara waits.", outcome: "success", timeAdvanceMinutes: 1 });
  const resolution = combineDirectionAndNarration(direction, { narration: "Mara waits at the harbor." });
  const inspection = unrequestedCampaignSpecialistInspection();
  const postcheck = inspectCampaignTurnLocally(resolution, direction, inspection);
  assert.equal(inspection.status, "skipped");
  assert.equal(inspection.reason, "ai_led_live_play");
  assert.equal(postcheck.status, "not_run");
  assert.equal(postcheck.model, "not_requested");
  assert.deepEqual(postcheck.errors, []);
});

const journalTestIds = {
  playerId: "00000000-0000-4000-8000-000000000221",
  worldId: "00000000-0000-4000-8000-000000000222",
  campaignId: "00000000-0000-4000-8000-000000000223",
};

test("unfinished campaign choices expose only the player's resumable input", () => {
  assert.deepEqual(
    serializeUnfinishedTurnRequest({
      request_id: "turn_request_12345678",
      intent_kind: "question",
      player_input: "Can I hear anyone beyond the door?",
      created_at: "2026-09-04T12:00:00.000Z",
      status: "generating",
      mechanics: { percentile: 1, envelope: { secret: "private" } },
      last_error: "private process detail",
    }),
    {
      requestId: "turn_request_12345678",
      action: "Can I hear anyone beyond the door?",
      inputMode: "question",
      createdAt: "2026-09-04T12:00:00.000Z",
    },
  );
  assert.equal(
    serializeUnfinishedTurnRequest({
      request_id: "bad",
      intent_kind: "action",
      player_input: "Open the door.",
    }),
    null,
  );
});

async function createMeteredJournalTestDb(credits: number) {
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
  await db.exec(meteredAiResultJournalSchemaSql);
  // Production runs schema guards at every startup. Re-running this must not
  // rewrite constraints or fail after the first instance has initialized it.
  await db.exec(meteredAiResultJournalSchemaSql);
  await db.query(
    "INSERT INTO storyhold.players (id, role, credits) VALUES ($1, 'player', $2)",
    [journalTestIds.playerId, credits],
  );
  await db.query("INSERT INTO storyhold.worlds (id) VALUES ($1)", [
    journalTestIds.worldId,
  ]);
  await db.query("INSERT INTO storyhold.campaigns (id) VALUES ($1)", [
    journalTestIds.campaignId,
  ]);
  return db;
}

test("AI-led routing replays an already-saved browser Director journal without generating again", async (t) => {
  const db = await createMeteredJournalTestDb(10);
  t.after(() => db.close());
  const binding = {
    campaignId: journalTestIds.campaignId, playerId: journalTestIds.playerId,
    requestId: "legacy-browser-request", expectedStateVersion: 3,
    intent: "question" as const, inputHash: "frozen-player-input", engineCommitment: "frozen-engine",
  };
  const legacyInputHash = meteredAiInputSha256({ version: 1, kind: "proposal", preferBrowserNarration: true, ...binding });
  const hold = await reserveCredits(db, {
    ...journalTestIds, operation: "campaign_turn", requestId: "legacy-browser-request-attempt-1",
    requiredCredits: 4, metadata: { retainUntilReconciled: true },
  });
  const scope = { db, ...journalTestIds, reservationId: hold.id, operation: "campaign_turn",
    requestId: "legacy-browser-request-attempt-1" };
  const savedDraft = { direction: { sceneSummary: "Mara waits." }, narratorAi: { model: "browser-pending" } };
  await runOrResumeMeteredAiResult({ ...scope, inputSha256: legacyInputHash,
    generate: async () => savedDraft, serialize: JSON.stringify, deserialize: JSON.parse });
  const recovered = campaignProposalJournalIdentity({ ...binding, savedInputSha256: legacyInputHash });
  assert.equal(recovered.preferBrowserNarration, true);
  let redispatches = 0;
  const replay = await runOrResumeMeteredAiResult({ ...scope, inputSha256: recovered.inputSha256,
    generate: async () => { redispatches += 1; throw new Error("A saved browser draft must never regenerate."); },
    serialize: JSON.stringify, deserialize: JSON.parse });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.value, savedDraft);
  assert.equal(redispatches, 0);
  assert.equal(campaignProposalJournalIdentity(binding).preferBrowserNarration, false);
  assert.throws(() => campaignProposalJournalIdentity({ ...binding, requestId: "another-request", savedInputSha256: legacyInputHash }), /METERED_AI_REQUEST_CONFLICT/);
});

const knownBillableUsage = {
  inputUnits: 100,
  outputUnits: 20,
  cachedInputUnits: 0,
  cacheWriteInputUnits: 0,
  reasoningUnits: 0,
  estimatedCostMicros: 72_000,
  pricingKnown: true,
  pricingVersion: "test:metered-journal",
  costEstimated: false,
};

function knownBillableAttempt(cost = knownBillableUsage.estimatedCostMicros) {
  return {
    provider: "openrouter" as const,
    model: "test/model",
    resolvedModel: "test/model",
    upstreamProvider: "test-upstream",
    stage: "director" as const,
    reasoning: "medium" as const,
    usage: { ...knownBillableUsage, estimatedCostMicros: cost },
  };
}

test("Lorekeeper feedback produces reversible personal preference weights", () => {
  assert.deepEqual(
    feedbackProfileFromRows([
      { rating: 1, tags: ["pacing", "canon"] },
      { rating: -1, tags: ["pacing"] },
      { rating: 1, tags: ["character_voice", "not_a_real_tag"] },
    ]),
    {
      weights: {
        overall: 0.333,
        pacing: 0,
        canon: 1,
        character_voice: 1,
      },
      positiveCount: 2,
      negativeCount: 1,
    },
  );
});

test("anonymous Lorekeeper patterns contain structure but no prose or canon names", () => {
  const keys = lorekeeperFeedbackPatternKeys({
    tags: ["pacing", "canon"],
    features: {
      resolutionMode: "story_first",
      actionClass: "exploration",
      outcome: "mixed",
      objectiveImpact: "clue",
      narrationLength: "medium",
      narration: "Addison Gray retrieves the xenomorph egg",
    },
  });
  assert.deepEqual(keys, [
    "v1:pacing:story_first:exploration:mixed:clue:medium",
    "v1:canon:story_first:exploration:mixed:clue:medium",
  ]);
  assert.equal(keys.join(" ").includes("addison"), false);
  assert.equal(keys.join(" ").includes("xenomorph"), false);
});

test("solo feedback preserves continuity guidance but does not turn disliked consequences into instructions", () => {
  assert.deepEqual(
    feedbackInfluenceForCampaign({
      experienceMode: "solo",
      rating: -1,
      tags: ["challenge", "consequences"],
      note: "That death was unfair; undo it.",
    }),
    {
      rating: "disliked",
      tags: ["challenge", "consequences"],
      privateNote: "",
      influence: "sentiment_only",
    },
  );
  assert.equal(
    feedbackInfluenceForCampaign({
      experienceMode: "solo",
      rating: -1,
      tags: ["continuity"],
      note: "Driver should know the Cold Forge report, but Addison should not.",
    }).privateNote,
    "Driver should know the Cold Forge report, but Addison should not.",
  );
});

test("rerolls and branches are paid in solo play and free in author mode", () => {
  assert.deepEqual(
    campaignProductPricing({ start_contract: { experienceMode: "solo" } }),
    { rerollCredits: 250, branchCredits: 500 },
  );
  assert.deepEqual(
    campaignProductPricing({ start_contract: { experienceMode: "author" } }),
    { rerollCredits: 0, branchCredits: 0 },
  );
});

test("campaign snapshots distinguish legacy campaigns from deliberately empty locks", () => {
  assert.equal(lockedSourceSnapshot({ version: 1 }), null);
  assert.deepEqual(
    lockedSourceSnapshot({
      version: 2,
      sourceSnapshot: [
        {
          id: "5fd1d7c4-1bb0-4fc4-a36d-b4d4909a6098",
          content_hash: "source-hash-one",
        },
        { id: "not-a-uuid", content_hash: "ignored" },
      ],
    }),
    [
      {
        id: "5fd1d7c4-1bb0-4fc4-a36d-b4d4909a6098",
        content_hash: "source-hash-one",
      },
    ],
  );
  assert.deepEqual(
    lockedSourceSnapshot({ version: 2, sourceSnapshot: [] }),
    [],
  );

  assert.deepEqual(lockedWorldModel({ version: 1 }), {
    locked: false,
    id: null,
  });
  assert.deepEqual(lockedWorldModel({ version: 2, worldModelSnapshot: null }), {
    locked: true,
    id: null,
  });
  assert.deepEqual(
    lockedWorldModel({
      version: 2,
      worldModelSnapshot: {
        id: "67371d93-df0a-4eca-8247-862e3122b82e",
      },
    }),
    { locked: true, id: "67371d93-df0a-4eca-8247-862e3122b82e" },
  );
});

test("reference snapshots preserve website and upload identities without accepting invalid IDs", () => {
  assert.equal(lockedReferenceSnapshot({ version: 4 }), null);
  assert.deepEqual(
    lockedReferenceSnapshot({
      version: 5,
      referenceSnapshot: [
        {
          id: "5fd1d7c4-1bb0-4fc4-a36d-b4d4909a6098",
          kind: "website",
          content_hash: "web-hash",
        },
        {
          id: "023cd64b-c529-4be5-af2f-1fc45a6d021b",
          kind: "upload",
          content_hash: "upload-hash",
        },
        { id: "invalid", kind: "website", content_hash: "ignored" },
      ],
    }),
    [
      {
        id: "5fd1d7c4-1bb0-4fc4-a36d-b4d4909a6098",
        kind: "website",
        content_hash: "web-hash",
      },
      {
        id: "023cd64b-c529-4be5-af2f-1fc45a6d021b",
        kind: "upload",
        content_hash: "upload-hash",
      },
    ],
  );
});

test("canon timeline snapshots fail closed when their anchor or cutoff is absent", () => {
  assert.deepEqual(lockedCanonTimeline({ version: 5 }), {
    locked: false,
    anchorEventId: null,
    anchorMode: null,
    maximumChronologyOrder: null,
  });
  assert.deepEqual(lockedCanonTimeline({ version: 6, canonTimelineSnapshot: null }), {
    locked: true,
    anchorEventId: null,
    anchorMode: null,
    maximumChronologyOrder: null,
  });
  assert.deepEqual(lockedCanonTimeline({
    version: 6,
    canonTimelineSnapshot: {
      anchorEventId: "5fd1d7c4-1bb0-4fc4-a36d-b4d4909a6098",
      anchorMode: "before",
      maximumChronologyOrder: 1999,
    },
  }), {
    locked: true,
    anchorEventId: "5fd1d7c4-1bb0-4fc4-a36d-b4d4909a6098",
    anchorMode: "before",
    maximumChronologyOrder: 1999,
  });
  assert.deepEqual(lockedCanonTimeline({
    canonTimelineSnapshot: {
      anchorEventId: "not-an-event",
      anchorMode: "sideways",
      maximumChronologyOrder: "unknown",
    },
  }), {
    locked: true,
    anchorEventId: null,
    anchorMode: null,
    maximumChronologyOrder: null,
  });
});

const strictCanonIds = {
  world: "30000000-0000-4000-8000-000000000001",
  edition: "30000000-0000-4000-8000-000000000002",
  campaign: "30000000-0000-4000-8000-000000000003",
  source: "30000000-0000-4000-8000-000000000004",
  chunk: "30000000-0000-4000-8000-000000000005",
  event: "30000000-0000-4000-8000-000000000006",
  entity: "30000000-0000-4000-8000-000000000007",
  claim: "30000000-0000-4000-8000-000000000008",
};

function strictCanonFixture() {
  const quote = "Mara guards the western gate before the eclipse.";
  const evidence = {
    evidence_key: "e".repeat(64),
    world_id: strictCanonIds.world,
    canon_edition_id: strictCanonIds.edition,
    source_id: strictCanonIds.source,
    chunk_id: strictCanonIds.chunk,
    source_content_hash: "a".repeat(64),
    chunk_content_hash: "b".repeat(64),
    source_title: "Chapter One",
    source_kind: "manuscript",
    chronology_label: "Before the eclipse",
    excerpt: quote,
    excerpt_hash: createHash("sha256").update(quote).digest("hex"),
    event_ids: [strictCanonIds.event],
    chronology_orders: [10],
  };
  const entity = {
    entity_id: strictCanonIds.entity,
    dossier_id: null,
    canonical_character_id: null,
    canonical_key: "mara",
    entity_type: "character",
    name: "Mara",
    aliases: [],
    role: "",
    summary: "",
    profile: {},
    details: [],
    relationships: [],
    socio_political_axis: {},
    faction_memberships: [],
    entity_links: [],
    entity_rules: [],
    mention_count: 0,
    confidence: 0.95,
  };
  const claimWithoutHash = {
    claim_id: strictCanonIds.claim,
    world_id: strictCanonIds.world,
    canon_edition_id: strictCanonIds.edition,
    fingerprint: "mara-guards-western-gate",
    supersedes_claim_id: null,
    subject_entity_id: strictCanonIds.entity,
    predicate: "guards",
    polarity: "positive" as const,
    object_entity_id: null,
    object_text: "the western gate",
    epistemic_holder_entity_id: null,
    truth_status: "fact",
    valid_from_label: "",
    valid_until_label: "",
    summary: "Mara guards the western gate.",
    evidence: [{
      evidenceKey: evidence.evidence_key,
      sourceId: strictCanonIds.source,
      chunkId: strictCanonIds.chunk,
      quote,
    }],
    confidence: 0.95,
    claim_status: "active",
    assignment_source: "user",
    source_updated_at: null,
  };
  const claim = {
    ...claimWithoutHash,
    snapshot_hash: stableCanonSha256(claimWithoutHash),
  };
  const timelineEvent = {
    id: strictCanonIds.event,
    canonical_key: "gate-watch",
    title: "The gate watch",
    summary: "Mara holds the western gate.",
    world_time_label: "Before the eclipse",
    chronology_order: 10,
    temporal_status: "fixed",
    importance: "major",
    source_chapter_keys: ["chapter-one"],
    evidence: [{
      sourceId: strictCanonIds.source,
      chunkId: strictCanonIds.chunk,
      quote,
    }],
    causal_links: [],
    participant_entity_ids: [strictCanonIds.entity],
  };
  const event = { ...timelineEvent, event_id: timelineEvent.id };
  delete (event as { id?: string }).id;
  const canonScopeSnapshot = {
    version: 1,
    policy: "event_evidence_v1",
    mode: "anchored_strict",
    anchorEventId: strictCanonIds.event,
    anchorMode: "after",
    maximumChronologyOrder: 10,
    evidenceCount: 1,
    claimCount: 1,
    entityCount: 1,
    evidenceSha256: stableCanonSha256([evidence]),
    claimsSha256: stableCanonSha256([claim]),
    entitiesSha256: stableCanonSha256([entity]),
  };
  const startContract = {
    version: 7,
    worldId: strictCanonIds.world,
    canonEditionId: strictCanonIds.edition,
    world: {
      name: "Locked World",
      premise: "Only the pre-eclipse era is known.",
      genre: "fantasy",
      worldClockName: "The Eclipse",
    },
    worldContract: { magic: "costly" },
    contentSettings: {},
    character: { name: "Locked Hero", concept: "A gate courier." },
    canonTimelineSnapshot: {
      anchorEventId: strictCanonIds.event,
      anchorMode: "after",
      maximumChronologyOrder: 10,
      eventCount: 1,
      sha256: createHash("sha256")
        .update(JSON.stringify([timelineEvent]))
        .digest("hex"),
    },
    canonScopeSnapshot,
    entitySnapshot: {
      version: 3,
      identitySafe: true,
      count: 1,
      sha256: canonScopeSnapshot.entitiesSha256,
    },
  };
  const scope = strictAnchoredCampaignCanonScope(startContract);
  assert.ok(scope);
  return { quote, evidence, entity, claim, event, timelineEvent, startContract, scope };
}

test("strict anchored campaigns require a complete version-7 or version-8 start contract", () => {
  const fixture = strictCanonFixture();
  assert.equal(fixture.scope.mode, "anchored_strict");
  const versionEight = strictAnchoredCampaignCanonScope({
    ...fixture.startContract,
    version: 8,
    rpgSeed: {
      schemaVersion: 1,
      seedId: "locked-rpg-seed",
      seedSha256: "a".repeat(64),
      origin: "imported",
      initialStateVersion: 0,
      baselineCampaignStateVersion: 1,
    },
  });
  assert.ok(versionEight);
  assert.equal(versionEight.eventsSha256, fixture.scope.eventsSha256);
  assert.equal(
    strictAnchoredCampaignCanonScope({
      version: 6,
      canonTimelineSnapshot: null,
    }),
    null,
  );
  assert.throws(
    () => strictAnchoredCampaignCanonScope({
      version: 6,
      canonTimelineSnapshot: fixture.startContract.canonTimelineSnapshot,
    }),
    /CAMPAIGN_CANON_SCOPE_INTEGRITY_FAILED/,
  );
  assert.throws(
    () => strictAnchoredCampaignCanonScope({
      version: 6,
      canonTimelineSnapshot: {},
    }),
    /CAMPAIGN_CANON_SCOPE_INTEGRITY_FAILED/,
  );
  assert.throws(
    () => strictAnchoredCampaignCanonScope({
      ...fixture.startContract,
      canonScopeSnapshot: {
        ...fixture.startContract.canonScopeSnapshot,
        evidenceSha256: "malformed",
      },
    }),
    /CAMPAIGN_CANON_SCOPE_INTEGRITY_FAILED/,
  );
});

test("strict canon snapshot integrity rejects missing or changed rows", () => {
  const fixture = strictCanonFixture();
  assert.doesNotThrow(() => assertStrictCampaignCanonSnapshotIntegrity({
    scope: fixture.scope,
    worldId: strictCanonIds.world,
    editionId: strictCanonIds.edition,
    evidence: [fixture.evidence],
    claims: [fixture.claim],
    entities: [fixture.entity],
    events: [fixture.event],
  }));
  assert.throws(() => assertStrictCampaignCanonSnapshotIntegrity({
    scope: fixture.scope,
    worldId: strictCanonIds.world,
    editionId: strictCanonIds.edition,
    evidence: [{ ...fixture.evidence, excerpt: "A future revelation leaked in." }],
    claims: [fixture.claim],
    entities: [fixture.entity],
    events: [fixture.event],
  }), /evidence snapshot count or hash changed/);
});

test("strict canon loading never consults live world lore surfaces", async () => {
  const fixture = strictCanonFixture();
  const calls: string[] = [];
  const db = {
    async query(sql: string) {
      calls.push(sql);
      if (sql.includes("campaign_canon_evidence_snapshots")) {
        return { rows: [{ ...fixture.evidence, id: fixture.evidence.evidence_key, content: fixture.quote }] };
      }
      if (sql.includes("count(*)") && sql.includes("campaign_canon_claim_snapshots")) {
        return { rows: [{ count: 1 }] };
      }
      if (sql.includes("campaign_canon_claim_snapshots")) {
        return { rows: [{ ...fixture.claim, id: fixture.claim.claim_id, subject_name: "Mara" }] };
      }
      if (sql.includes("campaign_entity_snapshots")) {
        return { rows: [fixture.entity] };
      }
      if (sql.includes("campaign_canon_event_snapshots")) {
        return { rows: [fixture.event] };
      }
      throw new Error(`Unexpected strict canon query: ${sql}`);
    },
  };
  const loaded = await loadVerifiedStrictCampaignCanonContext({
    db: db as never,
    campaignId: strictCanonIds.campaign,
    worldId: strictCanonIds.world,
    editionId: strictCanonIds.edition,
    action: "Ask Mara about the gate.",
    scope: fixture.scope,
  });
  assert.deepEqual(loaded.evidence.map((row) => row.content), [fixture.quote]);
  assert.deepEqual(loaded.claims.map((row) => row.id), [strictCanonIds.claim]);
  assert.equal((loaded.entities[0] as unknown as { summary: string } | undefined)?.summary, "");
  assert.equal(loaded.events[0]?.evidence instanceof Array, true);
  const forbidden = /world_source_chunks|world_knowledge_claims|world_entities|character_dossiers|world_breakdowns|world_reference_sources/;
  assert.equal(calls.some((sql) => forbidden.test(sql)), false);
});

test("strict campaign context cannot reuse future live lore or a stale scene packet", async (t) => {
  const previous = { ...process.env };
  t.after(() => { process.env = previous; });
  const specialistRequests: string[] = [];
  const server = createServer((request, response) => {
    specialistRequests.push(request.url ?? "");
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "No specialist may run during live play." }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  for (const name of ["GLINER2", "NER", "NLI", "MINILM", "RERANKER", "QWEN"]) {
    process.env[`STORYHOLD_LOCAL_${name}_ENABLED`] = "true";
    process.env[`STORYHOLD_LOCAL_${name}_URL`] = `http://127.0.0.1:${address.port}/${name.toLowerCase()}`;
  }
  process.env.SOURCE_VAULT_EMBED_PROVIDER = "perplexity";
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
    specialistRequests.push(String(url));
    throw new Error("Live context must not call an embedding or specialist provider.");
  });
  const fixture = strictCanonFixture();
  const calls: string[] = [];
  const future = "FUTURE_ECLIPSE_SPOILER";
  const db = {
    async query(sql: string) {
      calls.push(sql);
      if (sql.includes("FROM storyhold.campaigns c")) {
        return { rows: [{
          id: strictCanonIds.campaign,
          world_id: strictCanonIds.world,
          canon_edition_id: strictCanonIds.edition,
          start_contract: fixture.startContract,
          state_version: 1,
          current_time_label: "Before the eclipse",
          acting_character_id: null,
          character_name: future,
          character_profile: { future },
          world_name: future,
          world_premise: future,
          world_genre: future,
          world_contract: { future },
          content_settings: { future },
          world_clock_name: future,
        }] };
      }
      if (sql.includes("campaign_canon_evidence_snapshots")) {
        return { rows: [{ ...fixture.evidence, id: fixture.evidence.evidence_key, content: fixture.quote }] };
      }
      if (sql.includes("count(*)") && sql.includes("campaign_canon_claim_snapshots")) {
        return { rows: [{ count: 1 }] };
      }
      if (sql.includes("campaign_canon_claim_snapshots")) {
        return { rows: [{ ...fixture.claim, id: fixture.claim.claim_id, subject_name: "Mara" }] };
      }
      if (sql.includes("campaign_entity_snapshots")) return { rows: [fixture.entity] };
      if (sql.includes("campaign_canon_event_snapshots")) return { rows: [fixture.event] };
      if (sql.includes("FROM storyhold.lorekeeper_scene_packets")) {
        return { rows: [{ payload: {
          packetVersion: 3,
          sourceChunks: [{ content: future }],
          worldClaims: [{ summary: future }],
          referenceLore: [{ content: future }],
        } }] };
      }
      if (sql.includes("FROM storyhold.players WHERE")) {
        return { rows: [{ id: journalTestIds.playerId, role: "player", credits: 1000 }] };
      }
      return { rows: [] };
    },
  };
  const context = await loadCampaignContext(
    db as never,
    strictCanonIds.campaign,
    journalTestIds.playerId,
    "Ask Mara about the gate.",
    { model: "client-qwen", intent: "POISON_HINT", entities: ["POISON_HINT"], unresolvedReferences: [], canonQueries: [], possibleStateChanges: [] },
  );
  assert.ok(context);
  assert.deepEqual(specialistRequests, []);
  assert.equal(context.retrievalDiagnostics.localPrecheck.status, "not_run");
  assert.deepEqual(context.retrievalDiagnostics.localPrecheck.errors, []);
  assert.equal(context.retrievalDiagnostics.browserAssist, null);
  assert.equal(JSON.stringify(context).includes("POISON_HINT"), false);
  assert.equal(context.retrievalDiagnostics.cacheHit, false);
  assert.deepEqual(context.sourceChunks.map((row) => row.content), [fixture.quote]);
  assert.deepEqual(context.worldClaims.map((row) => row.id), [strictCanonIds.claim]);
  assert.equal(context.characterDossiers[0]?.summary, "");
  assert.equal(context.breakdown, null);
  assert.deepEqual(context.referenceLore, []);
  assert.equal(JSON.stringify(context).includes(future), false);
  const forbiddenLive = /world_source_chunks|world_knowledge_claims|world_entities|character_dossiers|world_breakdowns|world_reference_sources/;
  assert.equal(calls.some((sql) => forbiddenLive.test(sql)), false);
  const memoryQueries = calls.filter((sql) => sql.includes("vault_memory_chunks"));
  assert.equal(memoryQueries.every((sql) => !sql.includes("campaign_id IS NULL")), true);
  const amendmentQueries = calls.filter((sql) => sql.includes("canon_amendments"));
  assert.equal(amendmentQueries.every((sql) => !sql.includes("campaign_id IS NULL")), true);

  await t.test("fresh adventures use the same no-specialist policy and retain saved memory", async () => {
    const freshDb = {
      async query(sql: string) {
        if (sql.includes("FROM storyhold.campaigns c")) return { rows: [{
          id: strictCanonIds.campaign, world_id: strictCanonIds.world,
          canon_edition_id: strictCanonIds.edition, state_version: 0, status: "active",
          world_creation_mode: "adventure", start_contract: {}, world_name: "Harbor",
          current_time_label: "Dawn", acting_character_id: null,
        }] };
        if (sql.includes("FROM storyhold.players WHERE")) return { rows: [{ id: journalTestIds.playerId, role: "owner", credits: 1000 }] };
        if (sql.includes("FROM storyhold.vault_memory_chunks")) return { rows: [{ id: "memory-one", content: "Mara guards the harbor gate.", compact_summary: "Mara guards the gate." }] };
        return { rows: [] };
      },
    };
    const fresh = await loadCampaignContext(freshDb as never, strictCanonIds.campaign, journalTestIds.playerId, "Ask Mara about the gate.");
    assert.ok(fresh);
    assert.equal(fresh.memories[0]?.id, "memory-one");
    assert.equal(fresh.retrievalDiagnostics.localPrecheck.status, "not_run");
    assert.equal(fresh.retrievalDiagnostics.reranker.model, "not_requested");
    assert.deepEqual(specialistRequests, []);
  });
});

test("scene packet v4 binds cache identity to canon scope and rejects strict v3 packets", () => {
  const fixture = strictCanonFixture();
  const baseline = campaignScenePacketQueryHash({
    retrievalQuery: "Ask Mara about the gate.",
    rerankerIdentity: "deterministic-reranker",
    canonScope: fixture.scope,
  });
  const changed = campaignScenePacketQueryHash({
    retrievalQuery: "Ask Mara about the gate.",
    rerankerIdentity: "deterministic-reranker",
    canonScope: { ...fixture.scope, evidenceSha256: "f".repeat(64) },
  });
  assert.notEqual(baseline, changed);
  assert.equal(isCampaignScenePacketCacheHit({ packetVersion: 3 }, true), false);
  assert.equal(isCampaignScenePacketCacheHit({ packetVersion: 4 }, true), true);
});

test("campaign resolution rejects an imported canon contradiction and accepts its exact supersession", () => {
  const fixture = strictCanonFixture();
  const context = {
    facts: [],
    entityIndex: [{ id: strictCanonIds.entity, name: "Mara", aliases: [] }],
    characterDossiers: [],
    campaign: { acting_character_id: null, character_name: "" },
    importedCanonClaims: [{
      id: strictCanonIds.claim,
      subject_entity_id: strictCanonIds.entity,
      subject_name: "Mara",
      predicate: "guards",
      object_text: "the western gate",
      polarity: "positive",
      truth_status: "fact",
      claim_status: "active",
    }],
  };
  const resolution = (supersedesPropositionId: string | null) =>
    normalizeCampaignResolution({
      narration: "Mara has abandoned the western gate, leaving it undefended.",
      sceneSummary: "Mara is no longer guarding the western gate.",
      outcome: "success",
      stateChanges: [],
      propositions: [{
        layer: "reality",
        subjectEntityId: strictCanonIds.entity,
        subject: "Mara",
        predicate: "guards",
        object: "the western gate",
        stance: "denied",
        causalBasis: ["Mara followed the player away from the gate."],
        supersedesPropositionId,
      }],
    });
  const envelope = { resolution: { certainty: "possible" } };
  assert.throws(
    () => assertResolutionAgainstCanonicalContext(
      context as never,
      resolution(null),
      envelope as never,
    ),
    /DIRECTOR_IMPORTED_CANON_VALIDATION_FAILED/,
  );
  assert.doesNotThrow(() => assertResolutionAgainstCanonicalContext(
    context as never,
    resolution(strictCanonIds.claim),
    envelope as never,
  ));
  const importedSupersession = resolution(strictCanonIds.claim);
  const campaignFactId = "30000000-0000-4000-8000-000000000009";
  assert.throws(() => assertResolutionAgainstCanonicalContext(
    {
      ...context,
      facts: [{
        id: campaignFactId,
        fact_key: propositionKey(importedSupersession.propositions[0]!),
        subject_entity_id: strictCanonIds.entity,
        subject: "Mara",
        predicate: "guards",
        object_value: "the inner gate",
        stance: "affirmed",
      }],
    } as never,
    importedSupersession,
    envelope as never,
  ), /must explicitly supersede the current fact/);
});

test("reasoning routing keeps routine play low and escalates uncertain play", () => {
  assert.equal(
    chooseReasoningLevel("campaign_turn", {
      playerAction: "I ask the cashier how her morning is going.",
      resolutionMode: "story_first",
    }),
    "low",
  );
  assert.equal(
    chooseReasoningLevel("campaign_turn", {
      playerAction: "I try to pick the lock before the guard comes back.",
      resolutionMode: "light_rules",
    }),
    "medium",
  );
  assert.equal(
    chooseReasoningLevel("campaign_turn", {
      playerAction:
        "I suddenly have super strength and tear the vault door away.",
      resolutionMode: "story_first",
    }),
    "medium",
  );
  assert.equal(chooseReasoningLevel("world_analysis"), "high");
  assert.equal(chooseReasoningLevel("canon_review"), "high");
});

test("campaign resolution accepts only bounded append-only proposal fields", () => {
  const result = normalizeCampaignResolution({
    narration:
      "The latch resists, then gives with a click loud enough to turn the guard's head.",
    sceneSummary: "The player opened the latch but alerted the guard.",
    outcome: "mixed",
    timeAdvanceMinutes: 7.6,
    rewriteStartContract: { powers: ["everything"] },
    stateChanges: [
      {
        subject: "Service corridor",
        summary: "The maintenance door is now open.",
        entityType: "location",
        facts: ["The maintenance door is open."],
        relatedEntities: ["Guard"],
        visibility: "campaign",
        causalBasis: ["The player picked the lock."],
      },
    ],
    clockEvents: [
      {
        eventKind: "scheduled_effect",
        title: "Guard approaching",
        summary: "The guard will reach the corridor shortly.",
        visibility: "system",
        knowledgeStatus: "observed",
        knownEffects: ["This must not leak"],
        internalEffects: ["Escalate if the player remains."],
        scheduledForLabel: "In a few moments",
        maturesAfterMinutes: 3,
        causalParentId: "not-a-real-id",
        triggerDefinition: {
          kind: "proposition",
          layer: "reality",
          subject: "Guard",
          predicate: "location",
          object: "service corridor",
          objectMatch: "equals",
          stance: "affirmed",
        },
        causalBasis: ["The latch made a loud click."],
        clueOpportunities: ["Footsteps grow louder."],
      },
    ],
    propositions: [
      {
        layer: "reality",
        subject: "Maintenance door",
        predicate: "state",
        object: "open",
        stance: "affirmed",
        visibility: "system",
        causalBasis: ["The lock was picked."],
      },
      {
        layer: "belief",
        holder: "Guard",
        subject: "Corridor noise",
        predicate: "cause",
        object: "an intruder",
        stance: "affirmed",
        confidence: 0.6,
      },
    ],
    storyMoves: [
      {
        device: "Success With Cost",
        structure: "Discovery Then Pressure",
        summary: "The door opens, but the guard is alerted.",
      },
    ],
    memories: [
      {
        memoryKind: "fact",
        summary: "The maintenance door sticks before opening.",
        visibility: "campaign",
        salience: 99,
      },
    ],
    acknowledgedMaturedClockEventIds: [
      "5fd1d7c4-1bb0-4fc4-a36d-b4d4909a6098",
      "not-an-id",
    ],
  });

  assert.equal(result.outcome, "mixed");
  assert.equal(result.stateChanges.length, 1);
  assert.equal(result.stateChanges[0]?.entityType, "location");
  assert.equal(result.timeAdvanceMinutes, 8);
  assert.equal(result.clockEvents[0]?.visibility, "system");
  assert.equal(result.clockEvents[0]?.knowledgeStatus, "secret");
  assert.deepEqual(result.clockEvents[0]?.knownEffects, []);
  assert.equal(result.clockEvents[0]?.causalParentId, null);
  assert.equal(result.clockEvents[0]?.maturesAfterMinutes, 3);
  assert.equal(result.clockEvents[0]?.triggerDefinition.kind, "proposition");
  assert.deepEqual(result.clockEvents[0]?.causalBasis, [
    "The latch made a loud click.",
  ]);
  assert.equal(result.memories[0]?.salience, 5);
  assert.equal(result.propositions.length, 2);
  assert.equal(result.propositions[1]?.layer, "belief");
  assert.equal(result.storyMoves[0]?.device, "success_with_cost");
  assert.deepEqual(result.acknowledgedMaturedClockEventIds, [
    "5fd1d7c4-1bb0-4fc4-a36d-b4d4909a6098",
  ]);
  assert.equal("rewriteStartContract" in result, false);
});

test("world-clock maturity is a deterministic time-or-turn threshold", () => {
  const event = {
    status: "scheduled",
    due_world_time_minutes: 120,
    due_turn_number: 8,
  };
  assert.equal(scheduledClockEventIsDue(event, 119, 7), false);
  assert.equal(scheduledClockEventIsDue(event, 120, 7), true);
  assert.equal(scheduledClockEventIsDue(event, 0, 8), true);
  assert.equal(
    scheduledClockEventIsDue({ ...event, status: "committed" }, 999, 999),
    false,
  );
});

test("conditional clocks evaluate only the replacement for a proposition key", () => {
  const prior = normalizeCampaignProposition({
    layer: "reality",
    subject: "Archive door",
    predicate: "state",
    object: "sealed",
    stance: "affirmed",
  });
  const replacement = normalizeCampaignProposition({
    layer: "reality",
    subject: "Archive door",
    predicate: "state",
    object: "open",
    stance: "affirmed",
  });
  assert.ok(prior);
  assert.ok(replacement);
  assert.equal(propositionKey(prior), propositionKey(replacement));

  const effective = effectiveClockPropositions(
    [
      {
        fact_key: propositionKey(prior),
        layer: prior.layer,
        subject: prior.subject,
        predicate: prior.predicate,
        object_value: prior.object,
        stance: prior.stance,
      },
    ],
    [],
    [replacement],
  );

  assert.equal(effective.length, 1);
  assert.equal(
    clockTriggerIsSatisfied(
      {
        kind: "all",
        conditions: [
          {
            kind: "proposition",
            layer: "reality",
            subject: "Archive door",
            predicate: "state",
            object: "sealed",
          },
          {
            kind: "proposition",
            layer: "reality",
            subject: "Archive door",
            predicate: "state",
            object: "open",
          },
        ],
      },
      effective,
    ),
    false,
  );
  assert.equal(
    clockTriggerIsSatisfied(
      {
        kind: "proposition",
        layer: "reality",
        subject: "Archive door",
        predicate: "state",
        object: "open",
      },
      effective,
    ),
    true,
  );
});

test("failed turn requests durably release holds after a cleanup-process crash", async () => {
  const db = new PGlite();
  const playerId = "00000000-0000-4000-8000-000000000201";
  const worldId = "00000000-0000-4000-8000-000000000204";
  const campaignId = "00000000-0000-4000-8000-000000000202";
  const turnRequestId = "00000000-0000-4000-8000-000000000203";
  try {
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
    await db.exec(meteredAiResultJournalSchemaSql);
    await db.exec(`
      CREATE TABLE storyhold.campaign_turn_requests (
        id uuid PRIMARY KEY,
        campaign_id uuid NOT NULL REFERENCES storyhold.campaigns(id),
        status text NOT NULL
      );
    `);
    await db.query(
      "INSERT INTO storyhold.players (id, role, credits) VALUES ($1, 'player', 10)",
      [playerId],
    );
    await db.query("INSERT INTO storyhold.campaigns (id) VALUES ($1)", [
      campaignId,
    ]);
    await db.query("INSERT INTO storyhold.worlds (id) VALUES ($1)", [worldId]);
    await db.query(
      `INSERT INTO storyhold.campaign_turn_requests (id, campaign_id, status)
       VALUES ($1, $2, 'failed')`,
      [turnRequestId, campaignId],
    );
    await reserveCredits(db, {
      playerId,
      campaignId,
      operation: "campaign_turn",
      requestId: "crashed-attempt-1",
      requiredCredits: 4,
      metadata: { turnRequestId },
    });

    await releaseAbandonedTurnReservations({
      db,
      campaignId,
      turnRequestIds: [],
      clientRequestIds: [],
    });

    const player = await db.query<{ credits: number }>(
      "SELECT credits FROM storyhold.players WHERE id = $1",
      [playerId],
    );
    const reservation = await db.query<{ status: string }>(
      "SELECT status FROM storyhold.credit_reservations WHERE campaign_id = $1",
      [campaignId],
    );
    assert.equal(player.rows[0]?.credits, 10);
    assert.equal(reservation.rows[0]?.status, "released");

    const protectedHold = await reserveCredits(db, {
      playerId,
      worldId,
      campaignId,
      operation: "campaign_turn",
      requestId: "protected-attempt-1",
      requiredCredits: 4,
      metadata: { turnRequestId, retainUntilReconciled: true },
    });
    await runOrResumeMeteredAiResult({
      db,
      playerId,
      worldId,
      campaignId,
      reservationId: protectedHold.id,
      operation: "campaign_turn",
      requestId: "protected-attempt-1",
      inputSha256: meteredAiInputSha256({ action: "protected" }),
      generate: async () => ({ prose: "Paid work awaiting settlement." }),
      serialize: JSON.stringify,
      deserialize: JSON.parse,
    });
    await releaseAbandonedTurnReservations({
      db,
      campaignId,
      turnRequestIds: [turnRequestId],
      clientRequestIds: ["protected"],
    });
    const protectedReservation = await db.query<{ status: string }>(
      "SELECT status FROM storyhold.credit_reservations WHERE id = $1",
      [protectedHold.id],
    );
    assert.equal(protectedReservation.rows[0]?.status, "reserved");
  } finally {
    await db.close();
  }
});

test("metered campaign and Story Studio work waits for an overage top-up and reuses the saved provider result", async () => {
  const previousRetail = process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT;
  const previousMargin = process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS;
  process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT = "20000";
  process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS = "4000";
  const db = new PGlite();
  const playerId = "00000000-0000-4000-8000-000000000211";
  const worldId = "00000000-0000-4000-8000-000000000212";
  const campaignId = "00000000-0000-4000-8000-000000000213";
  try {
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
      CREATE TABLE storyhold.test_paid_output (
        id uuid PRIMARY KEY,
        prose text NOT NULL
      );
    `);
    await db.exec(creditEconomySchemaSql);
    await db.exec(meteredAiResultJournalSchemaSql);
    await db.query(
      "INSERT INTO storyhold.players (id, role, credits) VALUES ($1, 'player', 5)",
      [playerId],
    );
    await db.query("INSERT INTO storyhold.worlds (id) VALUES ($1)", [worldId]);
    await db.query("INSERT INTO storyhold.campaigns (id) VALUES ($1)", [
      campaignId,
    ]);
    const hold = await reserveCredits(db, {
      playerId,
      worldId,
      campaignId,
      operation: "campaign_story_adaptation",
      requestId: "saved-adaptation",
      requiredCredits: 4,
      metadata: { retainUntilReconciled: true },
    });
    const scope = {
      db,
      playerId,
      worldId,
      campaignId,
      reservationId: hold.id,
      operation: "campaign_story_adaptation",
      requestId: "saved-adaptation",
      inputSha256: meteredAiInputSha256({ source: "frozen scenes" }),
    };
    let providerCalls = 0;
    const first = await runOrResumeMeteredAiResult({
      ...scope,
      generate: async () => {
        providerCalls += 1;
        return { prose: "The exact paid provider result." };
      },
      serialize: JSON.stringify,
      deserialize: JSON.parse,
    });
    await assert.rejects(
      markMeteredAiResultApplied(db, first.journalId),
      /METERED_AI_JOURNAL_NOT_COMPLETED/,
    );
    const usage = {
      inputUnits: 100,
      outputUnits: 20,
      cachedInputUnits: 0,
      cacheWriteInputUnits: 0,
      reasoningUnits: 0,
      estimatedCostMicros: 72_000,
      pricingKnown: true,
      pricingVersion: "test:metered-journal",
      costEstimated: false,
    };
    await assert.rejects(
      db.transaction(async (tx) => {
        await settleCreditReservationInTransaction(tx, {
          reservationId: hold.id!,
          usage,
          provider: "openrouter",
          model: "test/model",
          reasoning: "medium",
          requireFullPayment: true,
        });
        await tx.query(
          "INSERT INTO storyhold.test_paid_output (id, prose) VALUES ($1, $2)",
          ["00000000-0000-4000-8000-000000000214", first.value.prose],
        );
        await markMeteredAiResultApplied(tx, first.journalId);
      }),
      (error: unknown) =>
        error instanceof CreditEconomyError &&
        error.code === "INSUFFICIENT_CREDITS",
    );
    assert.equal(
      (
        await db.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM storyhold.test_paid_output",
        )
      ).rows[0]?.count,
      0,
    );
    assert.equal(
      (
        await db.query<{ status: string }>(
          "SELECT status FROM storyhold.credit_reservations WHERE id = $1",
          [hold.id],
        )
      ).rows[0]?.status,
      "reserved",
    );

    const replay = await runOrResumeMeteredAiResult({
      ...scope,
      generate: async () => {
        providerCalls += 1;
        return { prose: "This must never be called." };
      },
      serialize: JSON.stringify,
      deserialize: JSON.parse,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.value.prose, first.value.prose);
    assert.equal(providerCalls, 1);

    await db.query("UPDATE storyhold.players SET credits = 3 WHERE id = $1", [
      playerId,
    ]);
    const settled = await db.transaction(async (tx) => {
      const result = await settleCreditReservationInTransaction(tx, {
        reservationId: hold.id!,
        usage,
        provider: "openrouter",
        model: "test/model",
        reasoning: "medium",
        requireFullPayment: true,
      });
      await tx.query(
        "INSERT INTO storyhold.test_paid_output (id, prose) VALUES ($1, $2)",
        ["00000000-0000-4000-8000-000000000214", replay.value.prose],
      );
      await markMeteredAiResultApplied(tx, replay.journalId);
      return result;
    });
    assert.deepEqual(settled, {
      creditsUsed: 6,
      creditsRemaining: 1,
      uncoveredCredits: 0,
    });
    assert.equal(providerCalls, 1);
    assert.equal(
      (
        await db.query<{ status: string }>(
          "SELECT status FROM storyhold.metered_ai_result_journal WHERE id = $1",
          [replay.journalId],
        )
      ).rows[0]?.status,
      "applied",
    );
  } finally {
    await db.close();
    if (previousRetail === undefined) {
      delete process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT;
    } else {
      process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT = previousRetail;
    }
    if (previousMargin === undefined) {
      delete process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS;
    } else {
      process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS = previousMargin;
    }
  }
});

test("known billable provider failure waits for top-up, charges exact usage, and never redispatches", async () => {
  const previousRetail = process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT;
  const previousMargin = process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS;
  process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT = "20000";
  process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS = "4000";
  const db = await createMeteredJournalTestDb(5);
  try {
    const hold = await reserveCredits(db, {
      ...journalTestIds,
      operation: "campaign_turn",
      requestId: "known-billable-failure",
      requiredCredits: 4,
      metadata: { retainUntilReconciled: true },
    });
    const scope = {
      db,
      ...journalTestIds,
      reservationId: hold.id,
      operation: "campaign_turn",
      requestId: "known-billable-failure",
      inputSha256: meteredAiInputSha256({ action: "Open the door." }),
    };
    let providerCalls = 0;
    let delivered = false;
    const invoke = async () => {
      const result = await runOrResumeMeteredAiResult({
        ...scope,
        generate: async () => {
          providerCalls += 1;
          throw new AiGatewayUnavailableError(
            "The provider response was billable but invalid.",
            ["openrouter: invalid response"],
            [knownBillableAttempt()],
            false,
          );
        },
        serialize: JSON.stringify,
        deserialize: JSON.parse,
      });
      delivered = Boolean(result.value);
    };

    await assert.rejects(
      invoke(),
      (error: unknown) =>
        error instanceof CreditEconomyError &&
        error.code === "INSUFFICIENT_CREDITS" &&
        (error as Error & { meteredResultRetained?: boolean })
          .meteredResultRetained === true,
    );
    assert.equal(providerCalls, 1);
    assert.equal(delivered, false);
    assert.equal(
      (
        await db.query<{ status: string }>(
          "SELECT status FROM storyhold.metered_ai_result_journal WHERE request_id = $1",
          [scope.requestId],
        )
      ).rows[0]?.status,
      "billable_failed",
    );
    assert.equal(
      (
        await db.query<{ status: string }>(
          "SELECT status FROM storyhold.credit_reservations WHERE id = $1",
          [hold.id],
        )
      ).rows[0]?.status,
      "reserved",
    );

    await db.query("UPDATE storyhold.players SET credits = 3 WHERE id = $1", [
      journalTestIds.playerId,
    ]);
    await assert.rejects(invoke(), MeteredAiKnownBillableFailureError);
    assert.equal(providerCalls, 1);
    assert.equal(delivered, false);
    const settled = await db.query<{
      status: string;
      actual_credits: number;
    }>(
      "SELECT status, actual_credits FROM storyhold.credit_reservations WHERE id = $1",
      [hold.id],
    );
    assert.equal(settled.rows[0]?.status, "settled");
    assert.equal(Number(settled.rows[0]?.actual_credits), 6);
    assert.equal(
      (
        await db.query<{ status: string }>(
          "SELECT status FROM storyhold.metered_ai_result_journal WHERE request_id = $1",
          [scope.requestId],
        )
      ).rows[0]?.status,
      "applied",
    );
    await assert.rejects(invoke(), /METERED_AI_RESERVATION_SCOPE_INVALID/);
    assert.equal(providerCalls, 1);
    assert.equal(delivered, false);
  } finally {
    await db.close();
    if (previousRetail === undefined) {
      delete process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT;
    } else {
      process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT = previousRetail;
    }
    if (previousMargin === undefined) {
      delete process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS;
    } else {
      process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS = previousMargin;
    }
  }
});

test("unknown provider outcome retains its hold and never redispatches", async () => {
  const db = await createMeteredJournalTestDb(10);
  try {
    const hold = await reserveCredits(db, {
      ...journalTestIds,
      operation: "campaign_turn",
      requestId: "uncertain-provider-outcome",
      requiredCredits: 4,
      metadata: { retainUntilReconciled: true },
    });
    const scope = {
      db,
      ...journalTestIds,
      reservationId: hold.id,
      operation: "campaign_turn",
      requestId: "uncertain-provider-outcome",
      inputSha256: meteredAiInputSha256({ action: "Search the archive." }),
    };
    let providerCalls = 0;
    const invoke = () => runOrResumeMeteredAiResult({
      ...scope,
      generate: async () => {
        providerCalls += 1;
        throw new AiGatewayUnavailableError(
          "The connection ended after dispatch.",
          ["openrouter: outcome unknown"],
          [knownBillableAttempt()],
          true,
        );
      },
      serialize: JSON.stringify,
      deserialize: JSON.parse,
    });

    await assert.rejects(invoke(), MeteredAiUncertainOutcomeError);
    await assert.rejects(invoke(), MeteredAiUncertainOutcomeError);
    assert.equal(providerCalls, 1);
    assert.equal(
      (
        await db.query<{ status: string }>(
          "SELECT status FROM storyhold.credit_reservations WHERE id = $1",
          [hold.id],
        )
      ).rows[0]?.status,
      "reserved",
    );
    assert.equal(
      (
        await db.query<{ status: string }>(
          "SELECT status FROM storyhold.metered_ai_result_journal WHERE request_id = $1",
          [scope.requestId],
        )
      ).rows[0]?.status,
      "uncertain",
    );
  } finally {
    await db.close();
  }
});

test("serialization failure after a paid result stays fail-closed and cannot redispatch", async () => {
  const db = await createMeteredJournalTestDb(10);
  try {
    const hold = await reserveCredits(db, {
      ...journalTestIds,
      operation: "campaign_turn",
      requestId: "serialization-failure",
      requiredCredits: 4,
      metadata: { retainUntilReconciled: true },
    });
    const scope = {
      db,
      ...journalTestIds,
      reservationId: hold.id,
      operation: "campaign_turn",
      requestId: "serialization-failure",
      inputSha256: meteredAiInputSha256({ action: "Wait." }),
    };
    let providerCalls = 0;
    await assert.rejects(
      runOrResumeMeteredAiResult({
        ...scope,
        generate: async () => {
          providerCalls += 1;
          return { paid: true };
        },
        serialize: () => {
          throw new Error("cannot serialize");
        },
        deserialize: JSON.parse,
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "METERED_AI_JOURNAL_SERIALIZATION_FAILED" &&
        (error as Error & { meteredResultRetained?: boolean })
          .meteredResultRetained === true,
    );
    await assert.rejects(
      runOrResumeMeteredAiResult({
        ...scope,
        generate: async () => {
          providerCalls += 1;
          return { paid: true };
        },
        serialize: JSON.stringify,
        deserialize: JSON.parse,
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "METERED_AI_RECONCILIATION_REQUIRED" &&
        (error as Error & { meteredResultRetained?: boolean })
          .meteredResultRetained === true,
    );
    assert.equal(providerCalls, 1);
    assert.equal(
      (
        await db.query<{ status: string }>(
          "SELECT status FROM storyhold.credit_reservations WHERE id = $1",
          [hold.id],
        )
      ).rows[0]?.status,
      "reserved",
    );
  } finally {
    await db.close();
  }
});

test("campaign journal replay rejects malformed provider accounting instead of normalizing it", () => {
  const direction = normalizeCampaignDirection({
    sceneSummary: "The archive door opens after the player enters the code.",
    outcome: "success",
    timeAdvanceMinutes: 1,
    stateChanges: [],
    clockEvents: [],
    memories: [],
    propositions: [],
    storyMoves: [],
  });
  const narration = normalizeCampaignNarration({
    narration:
      "The keypad chirps once, and the archive door slides into the wall to reveal the darkened records room beyond.",
  });
  const resolution = combineDirectionAndNarration(direction, narration);
  const directorUsage = { ...knownBillableUsage };
  const narratorUsage = {
    ...knownBillableUsage,
    inputUnits: 80,
    outputUnits: 30,
    estimatedCostMicros: 36_000,
  };
  const failedFallback = knownBillableAttempt(12_000);
  const payload = {
    version: 1,
    resolution,
    direction,
    directorAi: {
      text: JSON.stringify(direction),
      provider: "openrouter",
      model: "test/director",
      stage: "director",
      reasoning: "medium",
      usage: directorUsage,
      priorBillableAttempts: [failedFallback],
    },
    narratorAi: {
      text: JSON.stringify(narration),
      provider: "openrouter",
      model: "test/narrator",
      stage: "narration",
      reasoning: "low",
      usage: narratorUsage,
      priorBillableAttempts: [],
    },
    ai: {
      text: JSON.stringify(narration),
      provider: "openrouter",
      model: "test/narrator",
      stage: "narration",
      reasoning: "medium",
      usage: aggregateAiUsage([
        failedFallback.usage,
        directorUsage,
        narratorUsage,
      ]),
      priorBillableAttempts: [failedFallback],
    },
    reasoning: "medium",
    directorReasoning: "medium",
    narratorReasoning: "low",
    contentMode: "standard",
    localPostcheck: {
      status: "stored",
      model: "not recorded",
      relationCount: 0,
      signalCount: 0,
      passageKinds: [],
      unmodeledRelationshipLeads: [],
      elapsedMilliseconds: 0,
    },
  };
  assert.doesNotThrow(() => generatedTurnFromJournal(JSON.stringify(payload)));

  const undercounted = structuredClone(payload);
  undercounted.ai.usage = { ...directorUsage };
  assert.throws(
    () => generatedTurnFromJournal(JSON.stringify(undercounted)),
    /METERED_AI_SAVED_RESULT_INVALID/,
  );

  const invalidProvider = structuredClone(payload);
  invalidProvider.directorAi.provider = "mystery-provider";
  assert.throws(
    () => generatedTurnFromJournal(JSON.stringify(invalidProvider)),
    /METERED_AI_SAVED_RESULT_INVALID/,
  );

  const invalidUsage = structuredClone(payload);
  invalidUsage.narratorAi.usage.outputUnits = -1;
  assert.throws(
    () => generatedTurnFromJournal(JSON.stringify(invalidUsage)),
    /METERED_AI_SAVED_RESULT_INVALID/,
  );

  const invalidAttempt = structuredClone(payload) as typeof payload & {
    directorAi: { priorBillableAttempts: Array<Record<string, unknown>> };
  };
  delete (invalidAttempt.directorAi.priorBillableAttempts[0] as { stage?: string }).stage;
  assert.throws(
    () => generatedTurnFromJournal(JSON.stringify(invalidAttempt)),
    /METERED_AI_SAVED_RESULT_INVALID/,
  );
});

test("fixed-price failed rerolls journal provider work but charge exactly 250 credits", async () => {
  const db = await createMeteredJournalTestDb(300);
  try {
    const hold = await reserveCredits(db, {
      ...journalTestIds,
      operation: "campaign_turn_reroll",
      requestId: "fixed-reroll",
      requiredCredits: 250,
      metadata: { retainUntilReconciled: true },
    });
    let providerCalls = 0;
    await assert.rejects(
      runOrResumeMeteredAiResult({
        db,
        ...journalTestIds,
        reservationId: hold.id,
        operation: "campaign_turn_reroll",
        requestId: "fixed-reroll",
        inputSha256: meteredAiInputSha256({ reroll: "draft-id" }),
        fixedChargeCredits: 250,
        generate: async () => {
          providerCalls += 1;
          throw new AiGatewayUnavailableError(
            "The billable reroll response was invalid.",
            ["openrouter: invalid response"],
            [knownBillableAttempt(10_000_000)],
            false,
          );
        },
        serialize: JSON.stringify,
        deserialize: JSON.parse,
      }),
      MeteredAiKnownBillableFailureError,
    );
    assert.equal(providerCalls, 1);
    const reservation = await db.query<{
      status: string;
      actual_credits: number;
    }>(
      "SELECT status, actual_credits FROM storyhold.credit_reservations WHERE id = $1",
      [hold.id],
    );
    assert.equal(reservation.rows[0]?.status, "settled");
    assert.equal(Number(reservation.rows[0]?.actual_credits), 250);
    assert.equal(
      (
        await db.query<{ credits: number }>(
          "SELECT credits FROM storyhold.players WHERE id = $1",
          [journalTestIds.playerId],
        )
      ).rows[0]?.credits,
      50,
    );
  } finally {
    await db.close();
  }
});

test("scheduled clocks preserve null delays and share the engine time bound", () => {
  const result = normalizeCampaignResolution({
    narration:
      "The warning lamp stays dark while the dormant mechanism waits for a real trigger.",
    sceneSummary: "A dormant mechanism remains unscheduled.",
    outcome: "none",
    timeAdvanceMinutes: MAX_TIME_ADVANCE_MINUTES + 1,
    clockEvents: [
      {
        eventKind: "scheduled_effect",
        title: "Dormant mechanism",
        summary: "The mechanism has no numeric maturity threshold yet.",
        maturesAfterMinutes: null,
        maturesAfterTurns: null,
      },
      {
        eventKind: "scheduled_effect",
        title: "Trigger-only mechanism",
        summary: "This mechanism also has no numeric maturity threshold.",
      },
    ],
  });

  assert.equal(result.timeAdvanceMinutes, MAX_TIME_ADVANCE_MINUTES);
  assert.equal(result.clockEvents[0]?.maturesAfterMinutes, null);
  assert.equal(result.clockEvents[0]?.maturesAfterTurns, null);
  assert.equal(result.clockEvents[1]?.maturesAfterMinutes, null);
  assert.equal(result.clockEvents[1]?.maturesAfterTurns, null);
});

test("a turn event exists before matured clocks link to its foreign key", async () => {
  const worldEventId = "5fd1d7c4-1bb0-4fc4-a36d-b4d4909a6098";
  const campaignId = "67371d93-df0a-4eca-8247-862e3122b82e";
  const playerId = "24c8fc0b-bb49-4645-a87c-150e49a09195";
  const maturedClockId = "8390738f-479a-4bd1-ab49-9d0d4206760b";
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return { rows: [] };
    },
  } as unknown as Parameters<
    typeof insertWorldStateEventAndLinkMaturedClocks
  >[0]["db"];
  const payload = {
    schemaVersion: 2,
    domainEvents: { maturedClockIds: [maturedClockId] },
  };

  await insertWorldStateEventAndLinkMaturedClocks({
    db,
    worldEventId,
    campaignId,
    stateVersion: 7,
    payload,
    playerId,
    maturedClockIds: [maturedClockId],
  });

  assert.equal(calls.length, 2);
  assert.match(
    calls[0]?.sql ?? "",
    /INSERT INTO storyhold\.world_state_events/,
  );
  assert.deepEqual(JSON.parse(String(calls[0]?.values[3])), payload);
  assert.match(calls[1]?.sql ?? "", /SET matured_by_event_id/);
  assert.deepEqual(calls[1]?.values, [
    campaignId,
    [maturedClockId],
    worldEventId,
  ]);
});

test("turn clock metadata includes only customer-visible event IDs", () => {
  const visibleCampaignClockId = "5fd1d7c4-1bb0-4fc4-a36d-b4d4909a6098";
  const visibleCharacterClockId = "67371d93-df0a-4eca-8247-862e3122b82e";
  const hiddenSystemClockId = "24c8fc0b-bb49-4645-a87c-150e49a09195";
  const secretClockId = "8390738f-479a-4bd1-ab49-9d0d4206760b";
  const visibleEvents = [
    { id: visibleCampaignClockId },
    { id: visibleCharacterClockId },
  ];

  assert.deepEqual(
    filterVisibleClockEventIds(
      [hiddenSystemClockId, visibleCampaignClockId, secretClockId],
      visibleEvents,
    ),
    [visibleCampaignClockId],
  );
  assert.deepEqual(
    filterVisibleClockEventIds(
      [secretClockId, visibleCharacterClockId, hiddenSystemClockId],
      visibleEvents,
    ),
    [visibleCharacterClockId],
  );
});

test("campaign resolution refuses an unusable narration", () => {
  assert.throws(
    () => normalizeCampaignResolution({ narration: "Too short" }),
    /no usable narration/i,
  );
});

test("campaign resolution requires causes and fair hidden clock clues", () => {
  const base = normalizeCampaignResolution({
    narration:
      "The light above the sealed door turns amber, and somewhere behind it a relay begins to count down.",
    sceneSummary: "A hidden countdown began after the relay was activated.",
    outcome: "none",
    stateChanges: [],
    clockEvents: [
      {
        eventKind: "scheduled_effect",
        title: "Sealed door cycle",
        summary: "The door will unlock when the relay cycle completes.",
        visibility: "system",
        maturesAfterTurns: 3,
        causalBasis: ["The relay was activated."],
        clueOpportunities: ["The amber light pulses once per turn."],
      },
    ],
    propositions: [],
    storyMoves: [],
  });
  assert.doesNotThrow(() => assertCampaignResolutionCausality(base));
  assert.throws(
    () =>
      assertCampaignResolutionCausality({
        ...base,
        clockEvents: base.clockEvents.map((event) => ({
          ...event,
          clueOpportunities: [],
        })),
      }),
    /fair clue/i,
  );
});

test("turn progression rejects immediate objective placement from a movement action", () => {
  const contract = deriveTurnProgressionContract({
    intent: "action",
    playerInput: "Let's proceed forward. Fan out.",
    startingPoint:
      "Addison leads her team into the Engineer structure to retrieve their first egg.",
  });
  const safe = normalizeCampaignResolution({
    narration:
      "The formation advances into the first descending passage while the tracker return remains spatially uncertain.",
    sceneSummary:
      "The team advances in formation and learns that the structure distorts tracker direction.",
    outcome: "success",
    timeAdvanceMinutes: 5,
    stateChanges: [],
    clockEvents: [],
    memories: [],
    propositions: [],
    storyMoves: [],
    progression: {
      actionScope: "movement",
      resolvedAction: "The team proceeds forward and fans out.",
      objectiveImpact: "clue",
      objectiveTargetsAdvanced: ["egg"],
      advancementSource: "player_action",
      causalSteps: [
        "Addison orders the formation forward.",
        "The team enters the next passage without reaching the retrieval target.",
      ],
    },
  });
  assert.doesNotThrow(() => assertTurnProgressionContract(contract, safe));

  const instantEgg = normalizeCampaignResolution({
    ...safe,
    narration:
      "The passage opens into a chamber where the team immediately finds the egg waiting in a stone cradle.",
    sceneSummary: "The team advances and finds the first egg.",
  });
  assert.throws(
    () => assertTurnProgressionContract(contract, instantEgg),
    /claims progress|objective distance/i,
  );

  const disguisedAsProgress = normalizeCampaignResolution({
    ...instantEgg,
    progression: {
      ...instantEgg.progression,
      objectiveImpact: "progress",
    },
  });
  assert.throws(
    () => assertTurnProgressionContract(contract, disguisedAsProgress),
    /may advance.*only through clue/i,
  );

  const negativeFinding = normalizeCampaignResolution({
    ...safe,
    narration:
      "The team checks the chamber methodically, but no egg is found and the passage continues downward.",
    sceneSummary: "No egg is found in the first chamber.",
    progression: {
      ...safe.progression,
      objectiveImpact: "none",
      objectiveTargetsAdvanced: [],
      advancementSource: "none",
    },
  });
  assert.doesNotThrow(() =>
    assertTurnProgressionContract(contract, negativeFinding),
  );

  const dueClockId = "67371d93-df0a-4eca-8247-862e3122b82e";
  const clockCompletion = normalizeCampaignResolution({
    ...safe,
    narration:
      "A previously triggered retrieval arm completes its cycle and secures the egg as the team advances.",
    sceneSummary: "The matured retrieval cycle secures the egg.",
    progression: {
      ...safe.progression,
      objectiveImpact: "completion",
      objectiveTargetsAdvanced: ["egg"],
      advancementSource: "matured_clock",
    },
    acknowledgedMaturedClockEventIds: [dueClockId],
  });
  assert.doesNotThrow(() =>
    assertTurnProgressionContract(
      { ...contract, clockDrivenOverrideAllowed: true },
      clockCompletion,
    ),
  );
});

test("turn progression does not mistake an incidental verb near an objective target for progress", () => {
  const contract = deriveTurnProgressionContract({
    intent: "action",
    playerInput: "I toss the meal onto the counter.",
    startingPoint:
      "A waiting customer wants their meal while the player works a restaurant shift.",
  });
  const resolution = normalizeCampaignResolution({
    narration:
      "The customer jerks their hands back before the loose food reaches them, leaving a mess on the counter.",
    sceneSummary: "A careless delivery leaves spilled food on the counter.",
    outcome: "failure",
    timeAdvanceMinutes: 5,
    stateChanges: [],
    clockEvents: [],
    memories: [],
    propositions: [],
    storyMoves: [],
    progression: {
      actionScope: contract.actionScope,
      resolvedAction: "The player makes a careless counter delivery.",
      objectiveImpact: "none",
      objectiveTargetsAdvanced: [],
      advancementSource: "none",
      causalSteps: ["A careless delivery leaves food on the counter."],
    },
  });
  assert.doesNotThrow(() => assertTurnProgressionContract(contract, resolution));
});

test("turn progression does not mistake a separate observation for a later named objective", () => {
  const contract = deriveTurnProgressionContract({
    intent: "action",
    playerInput: "I head for the restroom.",
    startingPoint: "Mara is supervising a restaurant shift.",
  });
  const resolution = normalizeCampaignResolution({
    narration: "An occupied sign blocks the door, and Mara calls the player back toward the counter.",
    sceneSummary: "The attempted restroom break is stopped by an occupied sign and Mara's call.",
    outcome: "failure", timeAdvanceMinutes: 5, stateChanges: [], clockEvents: [], memories: [], propositions: [], storyMoves: [],
    progression: { actionScope: contract.actionScope, resolvedAction: "The player attempts a restroom break.", objectiveImpact: "none", objectiveTargetsAdvanced: [], advancementSource: "none", causalSteps: ["An occupied sign blocks the door."] },
  });
  assert.doesNotThrow(() => assertTurnProgressionContract(contract, resolution));
});

test("explicit scene routing is narrow and does not flag ordinary romance", () => {
  assert.equal(explicitSceneRequested("I kiss her goodnight."), false);
  assert.equal(
    explicitSceneRequested("I ask whether she wants to have sex."),
    true,
  );
});

test("the narrator receives no system-only causal state", () => {
  const direction = normalizeCampaignDirection({
    sceneSummary: "The visible door opened while an unseen pursuit advanced.",
    outcome: "mixed",
    timeAdvanceMinutes: 2,
    stateChanges: [
      {
        entityType: "location",
        subject: "Visible door",
        summary: "The door is open.",
        visibility: "campaign",
        causalBasis: ["The player opened it."],
      },
      {
        entityType: "plot",
        subject: "Hidden pursuit",
        summary: "The pursuer is now closer.",
        visibility: "system",
        causalBasis: ["Time passed."],
      },
    ],
    clockEvents: [
      {
        eventKind: "discovery",
        title: "Open door",
        summary: "The door visibly opened.",
        visibility: "campaign",
        knowledgeStatus: "observed",
        knownEffects: ["The passage is accessible."],
        internalEffects: ["A silent alarm was sent."],
        revealCondition: "The alarm panel is inspected.",
        triggerDefinition: {
          kind: "proposition",
          layer: "reality",
          subject: "alarm",
          predicate: "active",
          object: "yes",
        },
        causalBasis: ["The latch moved."],
      },
      {
        eventKind: "scheduled_effect",
        title: "Hidden response team",
        summary: "A response team will arrive.",
        visibility: "system",
        maturesAfterTurns: 3,
        causalBasis: ["The silent alarm was sent."],
        clueOpportunities: ["A panel light can be noticed."],
      },
    ],
    memories: [
      {
        memoryKind: "discovery",
        summary: "The door opened.",
        visibility: "campaign",
        salience: 3,
      },
      {
        memoryKind: "fact",
        summary: "The response team is moving.",
        visibility: "system",
        salience: 4,
      },
    ],
    propositions: [
      {
        layer: "reality",
        subject: "door",
        predicate: "state",
        object: "open",
        stance: "affirmed",
        visibility: "campaign",
        confidence: 1,
        causalBasis: ["The latch moved."],
      },
      {
        layer: "reality",
        subject: "alarm",
        predicate: "state",
        object: "active",
        stance: "affirmed",
        visibility: "system",
        confidence: 1,
        causalBasis: ["The door opened."],
      },
    ],
    storyMoves: [],
    resolveClockEventIds: ["5fd1d7c4-1bb0-4fc4-a36d-b4d4909a6098"],
    acknowledgedMaturedClockEventIds: ["67371d93-df0a-4eca-8247-862e3122b82e"],
  });

  const visible = publicDirectionForNarrator(direction);
  assert.equal(visible.stateChanges.length, 1);
  assert.equal(visible.clockEvents.length, 1);
  assert.deepEqual(visible.clockEvents[0]?.internalEffects, []);
  assert.deepEqual(visible.clockEvents[0]?.triggerDefinition, { kind: "none" });
  assert.equal(visible.memories.length, 1);
  assert.equal(visible.propositions.length, 1);
  assert.deepEqual(visible.resolveClockEventIds, []);
  assert.deepEqual(visible.acknowledgedMaturedClockEventIds, []);
  assert.equal(direction.clockEvents.length, 2);
});

test("narration can change without changing the Director resolution", () => {
  const direction = normalizeCampaignDirection({
    sceneSummary: "The lock opened after a difficult attempt.",
    outcome: "mixed",
    timeAdvanceMinutes: 3,
    stateChanges: [],
    clockEvents: [],
    memories: [],
    propositions: [],
    storyMoves: [],
  });
  const first = combineDirectionAndNarration(
    direction,
    normalizeCampaignNarration({
      narration:
        "The final tumbler catches, then yields with a reluctant metallic click.",
    }),
  );
  const second = combineDirectionAndNarration(
    direction,
    normalizeCampaignNarration({
      narration:
        "Metal whispers beneath the pick before the lock finally gives way.",
    }),
  );
  assert.notEqual(first.narration, second.narration);
  assert.deepEqual({ ...first, narration: "" }, { ...second, narration: "" });
});

test("a browser-pending proposal exposes only the public locked narration task", () => {
  const proposal = serializeTurnProposal({
    id: "proposal-1",
    request_id: "request-1",
    player_input: "I search the corridor.",
    intent_kind: "action",
    narration: "Director resolution only; player-facing prose is generated separately.",
    direction: {
      sceneSummary: "The search finds a partial clue.",
      outcome: "mixed",
      worldTimeLabel: "Moments later",
      timeAdvanceMinutes: 3,
      stateChanges: [],
      clockEvents: [{
        title: "Hidden danger",
        summary: "Secret",
        visibility: "system",
      }],
      memories: [{ summary: "Secret", visibility: "system", salience: 5 }],
      propositions: [{ visibility: "system" }],
      storyMoves: [],
      progression: {
        actionScope: "bounded",
        resolvedAction: "The corridor is searched.",
        objectiveImpact: "clue",
        objectiveTargetsAdvanced: [],
        advancementSource: "player_action",
        causalSteps: ["The search reveals a clue."],
      },
      resolveClockEventIds: [],
      acknowledgedMaturedClockEventIds: [],
    },
    engine_envelope: { fortune: { percentile: 40, d20: 8 } },
    revision: 1,
    status: "pending",
    base_state_version: 0,
    credits_used: 0,
    rerolled_from_proposal_id: null,
    director_provider: "openai",
    director_model: "director",
    director_reasoning: "low",
    narrator_provider: "storyhold-browser",
    narrator_model: "browser-pending",
    narrator_reasoning: "low",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  });
  assert.equal(proposal.narration, "");
  assert.equal(proposal.browserNarrationTask?.direction.sceneSummary, "The search finds a partial clue.");
  assert.deepEqual(proposal.browserNarrationTask?.direction.clockEvents, []);
  assert.deepEqual(proposal.browserNarrationTask?.direction.memories, []);
  assert.deepEqual(proposal.browserNarrationTask?.direction.propositions, []);
});

test("two-stage usage is charged as one combined provider cost", () => {
  const combined = aggregateAiUsage([
    {
      inputUnits: 100,
      outputUnits: 20,
      cachedInputUnits: 5,
      cacheWriteInputUnits: 0,
      reasoningUnits: 10,
      estimatedCostMicros: 120,
      pricingKnown: true,
      pricingVersion: "v1",
      costEstimated: true,
    },
    {
      inputUnits: 40,
      outputUnits: 80,
      cachedInputUnits: 0,
      cacheWriteInputUnits: 2,
      reasoningUnits: 0,
      estimatedCostMicros: 90,
      pricingKnown: true,
      pricingVersion: "v1",
      costEstimated: true,
    },
  ]);
  assert.equal(combined.inputUnits, 140);
  assert.equal(combined.outputUnits, 100);
  assert.equal(combined.estimatedCostMicros, 210);
  assert.equal(combined.pricingKnown, true);
});

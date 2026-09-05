import assert from "node:assert/strict";
import test from "node:test";
import {
  NarratorSemanticValidationError,
  assertNarratorSemantics,
  clockTriggerIsSatisfied,
  conditionalClockEventIsDue,
  classifyTurnActionScope,
  createDeterministicEngineEnvelope,
  deriveTurnProgressionContract,
  deriveStableFortune,
  intentInstructions,
  MAX_TIME_ADVANCE_MINUTES,
  normalizeCampaignProposition,
  normalizeClockTrigger,
  normalizeStoryMove,
  normalizeTurnIntent,
  objectiveTargetsFromStartingPoint,
  resolveDeterministicOutcome,
  validateNarratorSemantics,
} from "./causalEngine";

const PRIVATE_TEST_SECRET =
  "a-private-test-secret-that-never-leaves-the-server";
const CAMPAIGN_ID = "5fd1d7c4-1bb0-4fc4-a36d-b4d4909a6098";
const RESOLVABLE_CLOCK_ID = "67371d93-df0a-4eca-8247-862e3122b82e";
const ACKNOWLEDGEABLE_CLOCK_ID = "88bce8d2-589b-4c91-9c5c-8d3b9cfa47c7";
const SECOND_ACKNOWLEDGEABLE_CLOCK_ID = "8390738f-479a-4bd1-ab49-9d0d4206760b";
const INELIGIBLE_CLOCK_ID = "23b46e83-cb7b-415f-b948-fa785251952d";

test("turn intents are explicit and unknown values cannot create a new mode", () => {
  assert.equal(normalizeTurnIntent("question"), "question");
  assert.equal(normalizeTurnIntent("event"), "event");
  assert.equal(normalizeTurnIntent("rewrite-canon"), "action");
  assert.match(intentInstructions("action"), /attempt/i);
  assert.match(intentInstructions("question"), /knowledge/i);
});

test("local movement cannot cash out the campaign objective", () => {
  const startingPoint =
    "Addison Gray leads her team into the Engineer structure to retrieve their first egg.";
  assert.deepEqual(objectiveTargetsFromStartingPoint(startingPoint), ["egg"]);
  assert.equal(
    classifyTurnActionScope("action", "Let's proceed forward. Fan out."),
    "movement",
  );
  assert.deepEqual(
    deriveTurnProgressionContract({
      intent: "action",
      playerInput: "Let's proceed forward. Fan out.",
      startingPoint,
    }),
    {
      actionScope: "movement",
      objectiveTargets: ["egg"],
      explicitObjectiveAttempt: false,
      maximumObjectiveImpact: "clue",
      clockDrivenOverrideAllowed: false,
      priorObjectiveClues: 0,
      priorObjectiveMilestones: 0,
      objectiveImmediatelyAccessible: false,
    },
  );
  assert.deepEqual(
    deriveTurnProgressionContract({
      intent: "action",
      playerInput: "I order the Joe to retrieve the egg.",
      startingPoint,
      priorObjectiveMilestones: 1,
    }),
    {
      actionScope: "manipulation",
      objectiveTargets: ["egg"],
      explicitObjectiveAttempt: true,
      maximumObjectiveImpact: "completion",
      clockDrivenOverrideAllowed: false,
      priorObjectiveClues: 0,
      priorObjectiveMilestones: 1,
      objectiveImmediatelyAccessible: false,
    },
  );
  assert.equal(
    deriveTurnProgressionContract({
      intent: "action",
      playerInput: "We proceed deeper through the mapped passage.",
      startingPoint,
      priorObjectiveClues: 2,
    }).maximumObjectiveImpact,
    "progress",
  );
});

test("typed active-objective hints guide quickstart progression without making unrelated action explicit", () => {
  assert.equal(
    classifyTurnActionScope("action", "I move to the Inner Airlock."),
    "movement",
  );
  const unrelated = deriveTurnProgressionContract({
    intent: "action",
    playerInput: "I inspect the empty supply locker.",
    startingPoint: "Mara wakes at Dock Nine.",
    objectiveTargetHints: [
      "Reach the Inner Airlock. Escape before the station collapses.",
    ],
  });
  assert.ok(unrelated.objectiveTargets.includes("inner"));
  assert.ok(unrelated.objectiveTargets.includes("airlock"));
  assert.equal(unrelated.explicitObjectiveAttempt, false);

  const directed = deriveTurnProgressionContract({
    intent: "action",
    playerInput: "I move to the Inner Airlock.",
    startingPoint: "Mara wakes at Dock Nine.",
    objectiveTargetHints: [
      "Reach the Inner Airlock. Escape before the station collapses.",
    ],
  });
  assert.equal(directed.explicitObjectiveAttempt, true);
});

test("reality is distinct from a character belief or spoken claim", () => {
  const reality = normalizeCampaignProposition({
    layer: "reality",
    subject: "The Empress",
    predicate: "life status",
    object: "dead",
    stance: "affirmed",
  });
  const belief = normalizeCampaignProposition({
    layer: "belief",
    holder: "Echo",
    subject: "The Empress",
    predicate: "life status",
    object: "alive",
    stance: "affirmed",
  });
  assert.equal(reality?.visibility, "system");
  assert.equal(belief?.visibility, "character");
  assert.equal(
    normalizeCampaignProposition({
      layer: "belief",
      subject: "The Empress",
      predicate: "life status",
      object: "alive",
    }),
    null,
  );
});

test("conditional clocks mature from safe proposition predicates", () => {
  const trigger = normalizeClockTrigger({
    kind: "all",
    conditions: [
      {
        kind: "proposition",
        layer: "reality",
        subject: "Workshop lever",
        predicate: "position",
        object: "pulled",
      },
      {
        kind: "proposition",
        layer: "reality",
        subject: "Hidden door",
        predicate: "delay elapsed",
        object: "three days",
      },
    ],
  });
  const propositions = [
    {
      layer: "reality",
      subject: "Workshop lever",
      predicate: "position",
      object_value: "pulled",
      stance: "affirmed",
    },
    {
      layer: "reality",
      subject: "Hidden door",
      predicate: "delay elapsed",
      object_value: "three days",
      stance: "affirmed",
    },
  ];
  assert.equal(clockTriggerIsSatisfied(trigger, propositions), true);
  assert.equal(
    conditionalClockEventIsDue(
      { status: "scheduled", trigger_definition: trigger },
      propositions,
    ),
    true,
  );
  assert.equal(
    conditionalClockEventIsDue(
      { status: "committed", trigger_definition: trigger },
      propositions,
    ),
    false,
  );
});

test("story-move tags remain descriptive metadata rather than executable rules", () => {
  assert.deepEqual(
    normalizeStoryMove({
      device: "Interrupted conversation",
      structure: "Escalation / denial",
      summary: "The warning is cut short by a trusted ally.",
      intentionalMotif: false,
      executableCode: "delete everything",
    }),
    {
      device: "interrupted_conversation",
      structure: "escalation_denial",
      summary: "The warning is cut short by a trusted ally.",
      intentionalMotif: false,
    },
  );
});

test("stable fortune is idempotent, input-bound, and never exposes its private key", () => {
  const input = {
    campaignId: CAMPAIGN_ID,
    requestId: "turn_request_0001",
    playerInput: "I try to open the sealed door.",
    serverSecret: PRIVATE_TEST_SECRET,
    baseStateVersion: 17,
  };
  const first = deriveStableFortune(input);
  const retry = deriveStableFortune(input);
  const differentRequest = deriveStableFortune({
    ...input,
    requestId: "turn_request_0002",
  });
  const differentAction = deriveStableFortune({
    ...input,
    playerInput: "I leave the sealed door alone.",
  });

  assert.deepEqual(retry, first);
  assert.ok(first.percentile >= 1 && first.percentile <= 100);
  assert.ok(first.d20 !== null && first.d20 >= 1 && first.d20 <= 20);
  assert.equal(first.seedCommitment.length, 64);
  assert.notDeepEqual(differentRequest, first);
  assert.notDeepEqual(differentAction, first);
  assert.doesNotMatch(JSON.stringify(first), /private-test-secret/);
  assert.equal(deriveStableFortune({ ...input, includeD20: false }).d20, null);
  assert.throws(
    () => deriveStableFortune({ ...input, serverSecret: "too-short" }),
    /at least 16 bytes/i,
  );
});

test("certainty outranks luck and only check-required outcomes use bands", () => {
  assert.deepEqual(
    resolveDeterministicOutcome({
      certainty: "automatic_success",
      fortune: { percentile: 1 },
    }),
    {
      certainty: "automatic_success",
      band: "success",
      outcome: "success",
      percentile: null,
      modifier: 0,
      effectivePercentile: null,
    },
  );
  assert.equal(
    resolveDeterministicOutcome({
      certainty: "automatic_failure",
      fortune: { percentile: 100 },
    }).outcome,
    "failure",
  );
  assert.equal(
    resolveDeterministicOutcome({ certainty: "unresolved" }).outcome,
    "uncertain",
  );
  assert.equal(
    resolveDeterministicOutcome({ certainty: "not_applicable" }).outcome,
    "none",
  );

  const criticalFailure = resolveDeterministicOutcome({
    certainty: "check_required",
    fortune: { percentile: 5 },
  });
  const mixed = resolveDeterministicOutcome({
    certainty: "check_required",
    fortune: { percentile: 40 },
  });
  const modifiedSuccess = resolveDeterministicOutcome({
    certainty: "check_required",
    fortune: { percentile: 60 },
    modifier: 10,
  });
  const criticalSuccess = resolveDeterministicOutcome({
    certainty: "check_required",
    fortune: { percentile: 96 },
  });
  assert.equal(criticalFailure.band, "critical_failure");
  assert.equal(criticalFailure.outcome, "failure");
  assert.equal(mixed.band, "mixed");
  assert.equal(modifiedSuccess.effectivePercentile, 70);
  assert.equal(modifiedSuccess.outcome, "success");
  assert.equal(criticalSuccess.band, "critical_success");
  assert.throws(
    () =>
      resolveDeterministicOutcome({
        certainty: "check_required",
        fortune: { percentile: 0 },
      }),
    /percentile/i,
  );
});

test("engine envelopes bind stable semantics without retaining player text or secrets", () => {
  const envelope = createDeterministicEngineEnvelope({
    campaignId: CAMPAIGN_ID,
    requestId: "turn_request_0003",
    playerInput: "I use the key I earned to open the archive.",
    serverSecret: PRIVATE_TEST_SECRET,
    baseStateVersion: 22,
    intent: "action",
    certainty: "check_required",
    modifier: 8,
    timeAdvanceMinutes: 4,
    eligibleResolveClockEventIds: [RESOLVABLE_CLOCK_ID, RESOLVABLE_CLOCK_ID],
    eligibleAcknowledgeClockEventIds: [ACKNOWLEDGEABLE_CLOCK_ID],
  });

  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.baseStateVersion, 22);
  assert.equal(envelope.resolution.timeAdvanceMinutes, 4);
  assert.deepEqual(envelope.clockEligibility.resolve, [RESOLVABLE_CLOCK_ID]);
  assert.deepEqual(envelope.clockEligibility.acknowledgeMatured, [
    ACKNOWLEDGEABLE_CLOCK_ID,
  ]);
  assert.equal(envelope.inputCommitment.length, 64);
  const serialized = JSON.stringify(envelope);
  assert.doesNotMatch(serialized, /key I earned/);
  assert.doesNotMatch(serialized, /private-test-secret/);
  assert.deepEqual(
    envelope,
    createDeterministicEngineEnvelope({
      campaignId: CAMPAIGN_ID,
      requestId: "turn_request_0003",
      playerInput: "I use the key I earned to open the archive.",
      serverSecret: PRIVATE_TEST_SECRET,
      baseStateVersion: 22,
      intent: "action",
      certainty: "check_required",
      modifier: 8,
      timeAdvanceMinutes: 4,
      eligibleResolveClockEventIds: [RESOLVABLE_CLOCK_ID, RESOLVABLE_CLOCK_ID],
      eligibleAcknowledgeClockEventIds: [ACKNOWLEDGEABLE_CLOCK_ID],
    }),
  );
  assert.throws(
    () =>
      createDeterministicEngineEnvelope({
        campaignId: CAMPAIGN_ID,
        requestId: "turn_request_0004",
        playerInput: "I wait.",
        serverSecret: PRIVATE_TEST_SECRET,
        baseStateVersion: 22,
        intent: "action",
        certainty: "not_applicable",
        eligibleResolveClockEventIds: ["not-a-clock-id"],
      }),
    /invalid clock ID/i,
  );
});

test("engine and narrator share one maximum time advance", () => {
  const base = {
    campaignId: CAMPAIGN_ID,
    requestId: "turn_request_time_bound",
    playerInput: "I wait for the long voyage to end.",
    serverSecret: PRIVATE_TEST_SECRET,
    baseStateVersion: 23,
    intent: "action" as const,
    certainty: "automatic_success" as const,
  };
  assert.equal(
    createDeterministicEngineEnvelope({
      ...base,
      timeAdvanceMinutes: MAX_TIME_ADVANCE_MINUTES,
    }).resolution.timeAdvanceMinutes,
    MAX_TIME_ADVANCE_MINUTES,
  );
  assert.throws(
    () =>
      createDeterministicEngineEnvelope({
        ...base,
        timeAdvanceMinutes: MAX_TIME_ADVANCE_MINUTES + 1,
      }),
    /timeAdvanceMinutes/i,
  );
});

test("narrators may describe but cannot rewrite engine outcomes or clock eligibility", () => {
  const envelope = createDeterministicEngineEnvelope({
    campaignId: CAMPAIGN_ID,
    requestId: "turn_request_0005",
    playerInput: "I pull the lever and wait.",
    serverSecret: PRIVATE_TEST_SECRET,
    baseStateVersion: 30,
    intent: "action",
    certainty: "automatic_success",
    timeAdvanceMinutes: 2,
    eligibleResolveClockEventIds: [RESOLVABLE_CLOCK_ID],
    eligibleAcknowledgeClockEventIds: [
      ACKNOWLEDGEABLE_CLOCK_ID,
      SECOND_ACKNOWLEDGEABLE_CLOCK_ID,
    ],
  });
  const accepted = assertNarratorSemantics(envelope, {
    narration: "The lever settles into place.",
    outcome: "success",
    timeAdvanceMinutes: 2,
    resolveClockEventIds: [RESOLVABLE_CLOCK_ID, RESOLVABLE_CLOCK_ID],
    acknowledgedMaturedClockEventIds: [
      ACKNOWLEDGEABLE_CLOCK_ID,
      SECOND_ACKNOWLEDGEABLE_CLOCK_ID,
    ],
  });
  assert.deepEqual(accepted, {
    outcome: "success",
    timeAdvanceMinutes: 2,
    resolveClockEventIds: [RESOLVABLE_CLOCK_ID],
    acknowledgedMaturedClockEventIds: [
      ACKNOWLEDGEABLE_CLOCK_ID,
      SECOND_ACKNOWLEDGEABLE_CLOCK_ID,
    ],
  });
  const acceptedWithoutResolution = assertNarratorSemantics(envelope, {
    outcome: "success",
    timeAdvanceMinutes: 2,
    resolveClockEventIds: [],
    acknowledgedMaturedClockEventIds: [
      ACKNOWLEDGEABLE_CLOCK_ID,
      SECOND_ACKNOWLEDGEABLE_CLOCK_ID,
    ],
  });
  assert.deepEqual(acceptedWithoutResolution.resolveClockEventIds, []);

  const missingAcknowledgement = validateNarratorSemantics(envelope, {
    outcome: "success",
    timeAdvanceMinutes: 2,
    resolveClockEventIds: [RESOLVABLE_CLOCK_ID],
    acknowledgedMaturedClockEventIds: [ACKNOWLEDGEABLE_CLOCK_ID],
  });
  assert.equal(missingAcknowledgement.ok, false);
  if (!missingAcknowledgement.ok) {
    assert.deepEqual(
      missingAcknowledgement.issues.map((issue) => [issue.code, issue.value]),
      [
        [
          "MISSING_REQUIRED_CLOCK_ACKNOWLEDGEMENT",
          SECOND_ACKNOWLEDGEABLE_CLOCK_ID,
        ],
      ],
    );
  }

  const rejected = validateNarratorSemantics(envelope, {
    outcome: "failure",
    timeAdvanceMinutes: 12,
    resolveClockEventIds: [INELIGIBLE_CLOCK_ID],
    acknowledgedMaturedClockEventIds: [
      ACKNOWLEDGEABLE_CLOCK_ID,
      SECOND_ACKNOWLEDGEABLE_CLOCK_ID,
      INELIGIBLE_CLOCK_ID,
    ],
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.deepEqual(
      new Set(rejected.issues.map((issue) => issue.code)),
      new Set([
        "OUTCOME_MISMATCH",
        "TIME_ADVANCE_MISMATCH",
        "INELIGIBLE_CLOCK_RESOLUTION",
        "INELIGIBLE_CLOCK_ACKNOWLEDGEMENT",
      ]),
    );
  }
  assert.throws(
    () =>
      assertNarratorSemantics(envelope, {
        outcome: "success",
        timeAdvanceMinutes: 2,
        resolveClockEventIds: [INELIGIBLE_CLOCK_ID],
      }),
    NarratorSemanticValidationError,
  );
});

test("semantic validation rejects malformed clock lists instead of silently dropping them", () => {
  const envelope = createDeterministicEngineEnvelope({
    campaignId: CAMPAIGN_ID,
    requestId: "turn_request_0006",
    playerInput: "I listen.",
    serverSecret: PRIVATE_TEST_SECRET,
    baseStateVersion: 31,
    intent: "question",
    certainty: "not_applicable",
  });
  const result = validateNarratorSemantics(envelope, {
    outcome: "none",
    timeAdvanceMinutes: 0,
    resolveClockEventIds: "none",
    acknowledgedMaturedClockEventIds: ["bad-id"],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(
      result.issues.map((issue) => issue.code),
      ["MALFORMED_CLOCK_LIST", "INVALID_CLOCK_ID"],
    );
  }
});

import { createHash, createHmac } from "node:crypto";

export const MAX_TIME_ADVANCE_MINUTES = 5_256_000;

export type TurnIntent = "action" | "question" | "event";

export type TurnActionScope =
  | "communication"
  | "observation"
  | "movement"
  | "manipulation"
  | "conflict"
  | "extended"
  | "external_event"
  | "other";

export type ObjectiveImpact = "none" | "clue" | "progress" | "completion";

/**
 * A server-owned pacing boundary for one turn. Outcome answers whether the
 * attempted action succeeds; this contract prevents that success from being
 * silently promoted into success at the whole campaign objective.
 */
export type TurnProgressionContract = {
  actionScope: TurnActionScope;
  objectiveTargets: string[];
  explicitObjectiveAttempt: boolean;
  maximumObjectiveImpact: ObjectiveImpact;
  clockDrivenOverrideAllowed: boolean;
  priorObjectiveClues: number;
  priorObjectiveMilestones: number;
  objectiveImmediatelyAccessible: boolean;
};

export type CampaignOutcome =
  | "success"
  | "mixed"
  | "failure"
  | "uncertain"
  | "none";

/**
 * Certainty is decided from canonical state before luck is consulted.
 * `check_required` is the only value which permits fortune to affect outcome.
 */
export type OutcomeCertainty =
  | "automatic_success"
  | "automatic_failure"
  | "check_required"
  | "unresolved"
  | "not_applicable";

export type OutcomeBand =
  | "critical_failure"
  | "failure"
  | "mixed"
  | "success"
  | "critical_success"
  | "uncertain"
  | "none";

export type OutcomeThresholds = {
  criticalFailureMax: number;
  failureMax: number;
  mixedMax: number;
  successMax: number;
};

export type StableFortune = {
  /** Safe to persist or show while the private HMAC key remains server-side. */
  seedCommitment: string;
  percentile: number;
  d20: number | null;
};

export type DeterministicOutcome = {
  certainty: OutcomeCertainty;
  band: OutcomeBand;
  outcome: CampaignOutcome;
  percentile: number | null;
  modifier: number;
  effectivePercentile: number | null;
};

export type DeterministicEngineEnvelope = {
  schemaVersion: 1;
  campaignId: string;
  requestId: string;
  baseStateVersion: number;
  intent: TurnIntent;
  /** A keyed commitment binds the envelope to input without storing the input. */
  inputCommitment: string;
  fortune: StableFortune;
  resolution: DeterministicOutcome & {
    timeAdvanceMinutes: number;
  };
  clockEligibility: {
    resolve: string[];
    /** Every due or already-matured ID here must be acknowledged this turn. */
    acknowledgeMatured: string[];
  };
  progression: TurnProgressionContract;
};

export type SemanticValidationIssueCode =
  | "OUTCOME_MISMATCH"
  | "TIME_ADVANCE_MISMATCH"
  | "MALFORMED_CLOCK_LIST"
  | "INVALID_CLOCK_ID"
  | "INELIGIBLE_CLOCK_RESOLUTION"
  | "INELIGIBLE_CLOCK_ACKNOWLEDGEMENT"
  | "MISSING_REQUIRED_CLOCK_ACKNOWLEDGEMENT";

export type SemanticValidationIssue = {
  code: SemanticValidationIssueCode;
  path: string;
  message: string;
  value?: unknown;
};

export type AcceptedNarratorSemantics = {
  outcome: CampaignOutcome;
  timeAdvanceMinutes: number;
  resolveClockEventIds: string[];
  acknowledgedMaturedClockEventIds: string[];
};

export type SemanticValidationResult =
  | { ok: true; value: AcceptedNarratorSemantics }
  | { ok: false; issues: SemanticValidationIssue[] };

export type PropositionLayer = "reality" | "knowledge" | "belief" | "claim";
export type PropositionStance =
  | "affirmed"
  | "denied"
  | "uncertain"
  | "disputed";
export type PropositionVisibility =
  | "campaign"
  | "character"
  | "system"
  | "studio";

export type CampaignProposition = {
  layer: PropositionLayer;
  subjectEntityId: string | null;
  subject: string;
  predicate: string;
  object: string;
  holderEntityId: string | null;
  holder: string;
  stance: PropositionStance;
  visibility: PropositionVisibility;
  confidence: number;
  causalBasis: string[];
  supersedesPropositionId: string | null;
};

export type StoryMove = {
  device: string;
  structure: string;
  summary: string;
  intentionalMotif: boolean;
};

export type PropositionClockTrigger = {
  kind: "proposition";
  layer: PropositionLayer;
  subjectEntityId: string | null;
  subject: string;
  predicate: string;
  object: string;
  objectMatch: "equals" | "contains";
  holderEntityId: string | null;
  holder: string;
  stance: PropositionStance;
};

export type ClockTriggerDefinition =
  | { kind: "none" }
  | PropositionClockTrigger
  | {
      kind: "all" | "any";
      conditions: PropositionClockTrigger[];
    };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function text(value: unknown, maximum: number): string {
  return typeof value === "string"
    ? value
        .replace(/\u0000/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maximum)
    : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function allowed<T extends string>(
  value: unknown,
  values: readonly T[],
  fallback: T,
): T {
  return values.includes(value as T) ? (value as T) : fallback;
}

function uuid(value: unknown): string | null {
  const candidate = text(value, 60);
  return UUID_PATTERN.test(candidate) ? candidate : null;
}

function stringList(
  value: unknown,
  maximumItems: number,
  maximumLength: number,
) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => text(item, maximumLength))
    .filter(Boolean)
    .slice(0, maximumItems);
}

const DEFAULT_OUTCOME_THRESHOLDS: OutcomeThresholds = {
  criticalFailureMax: 5,
  failureMax: 35,
  mixedMax: 65,
  successMax: 95,
};

function requiredText(value: unknown, name: string, maximum: number): string {
  const result = text(value, maximum);
  if (!result) throw new Error(`${name} is required.`);
  return result;
}

function normalizedFortuneInput(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .normalize("NFKC")
    .trim()
    .slice(0, 20_000);
}

function hmac(
  secret: string,
  material: string,
  purpose: string,
  counter = 0,
): Buffer {
  return createHmac("sha256", secret)
    .update("storyhold-causal-engine-v1\u0000", "utf8")
    .update(purpose, "utf8")
    .update("\u0000", "utf8")
    .update(material, "utf8")
    .update("\u0000", "utf8")
    .update(String(counter), "utf8")
    .digest();
}

/** Produce an unbiased deterministic integer without exposing the HMAC key. */
function hmacInteger(
  secret: string,
  material: string,
  purpose: string,
  minimum: number,
  maximum: number,
): number {
  const width = maximum - minimum + 1;
  const integerSpace = 0x1_0000_0000;
  const acceptedLimit = Math.floor(integerSpace / width) * width;
  for (let counter = 0; counter < 1_024; counter += 1) {
    const candidate = hmac(secret, material, purpose, counter).readUInt32BE(0);
    if (candidate < acceptedLimit) return minimum + (candidate % width);
  }
  throw new Error("Unable to derive deterministic fortune.");
}

function fortuneMaterial(input: {
  campaignId: string;
  requestId: string;
  playerInput: string;
  baseStateVersion?: number;
}): { material: string; normalizedInput: string; stateVersion: number } {
  const campaignId = requiredText(input.campaignId, "campaignId", 160);
  const requestId = requiredText(input.requestId, "requestId", 160);
  const normalizedInput = normalizedFortuneInput(input.playerInput);
  if (!normalizedInput) throw new Error("playerInput is required.");
  const rawVersion = input.baseStateVersion ?? 0;
  if (!Number.isSafeInteger(rawVersion) || rawVersion < 0) {
    throw new Error("baseStateVersion must be a non-negative safe integer.");
  }
  return {
    material: [
      campaignId.toLocaleLowerCase(),
      requestId,
      rawVersion,
      normalizedInput,
    ].join("\u0000"),
    normalizedInput,
    stateVersion: rawVersion,
  };
}

/**
 * Generate repeatable server fortune for an idempotent turn request.
 *
 * The private key is accepted explicitly to keep this helper pure and testable;
 * it is never returned or included in either persisted commitment. A production
 * caller should pass a dedicated random server secret, not an API key.
 */
export function deriveStableFortune(input: {
  campaignId: string;
  requestId: string;
  playerInput: string;
  serverSecret: string;
  baseStateVersion?: number;
  includeD20?: boolean;
}): StableFortune {
  const serverSecret = requiredText(input.serverSecret, "serverSecret", 4_096);
  if (Buffer.byteLength(serverSecret, "utf8") < 16) {
    throw new Error("serverSecret must contain at least 16 bytes.");
  }
  const { material } = fortuneMaterial(input);
  const seed = hmac(serverSecret, material, "seed");
  return {
    seedCommitment: createHash("sha256").update(seed).digest("hex"),
    percentile: hmacInteger(serverSecret, material, "percentile", 1, 100),
    d20:
      input.includeD20 === false
        ? null
        : hmacInteger(serverSecret, material, "d20", 1, 20),
  };
}

function normalizedThresholds(
  value: Partial<OutcomeThresholds> | undefined,
): OutcomeThresholds {
  const result = {
    ...DEFAULT_OUTCOME_THRESHOLDS,
    ...(value ?? {}),
  };
  const ordered = [
    result.criticalFailureMax,
    result.failureMax,
    result.mixedMax,
    result.successMax,
  ];
  if (
    ordered.some((item) => !Number.isInteger(item) || item < 1 || item > 100) ||
    ordered.some((item, index) => index > 0 && item <= ordered[index - 1]!)
  ) {
    throw new Error(
      "Outcome thresholds must be strictly increasing integers between 1 and 100.",
    );
  }
  return result;
}

function boundedModifier(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(-99, Math.min(99, Math.round(parsed)));
}

export function resolveDeterministicOutcome(input: {
  certainty: OutcomeCertainty;
  fortune?: Pick<StableFortune, "percentile"> | null;
  modifier?: number;
  thresholds?: Partial<OutcomeThresholds>;
}): DeterministicOutcome {
  const modifier = boundedModifier(input.modifier);
  if (input.certainty === "automatic_success") {
    return {
      certainty: input.certainty,
      band: "success",
      outcome: "success",
      percentile: null,
      modifier,
      effectivePercentile: null,
    };
  }
  if (input.certainty === "automatic_failure") {
    return {
      certainty: input.certainty,
      band: "failure",
      outcome: "failure",
      percentile: null,
      modifier,
      effectivePercentile: null,
    };
  }
  if (input.certainty === "not_applicable") {
    return {
      certainty: input.certainty,
      band: "none",
      outcome: "none",
      percentile: null,
      modifier,
      effectivePercentile: null,
    };
  }
  if (input.certainty === "unresolved") {
    return {
      certainty: input.certainty,
      band: "uncertain",
      outcome: "uncertain",
      percentile: null,
      modifier,
      effectivePercentile: null,
    };
  }

  const percentile = Number(input.fortune?.percentile);
  if (!Number.isInteger(percentile) || percentile < 1 || percentile > 100) {
    throw new Error(
      "check_required outcomes need a percentile from 1 through 100.",
    );
  }
  const thresholds = normalizedThresholds(input.thresholds);
  const effectivePercentile = Math.max(1, Math.min(100, percentile + modifier));
  let band: OutcomeBand;
  let outcome: CampaignOutcome;
  if (effectivePercentile <= thresholds.criticalFailureMax) {
    band = "critical_failure";
    outcome = "failure";
  } else if (effectivePercentile <= thresholds.failureMax) {
    band = "failure";
    outcome = "failure";
  } else if (effectivePercentile <= thresholds.mixedMax) {
    band = "mixed";
    outcome = "mixed";
  } else if (effectivePercentile <= thresholds.successMax) {
    band = "success";
    outcome = "success";
  } else {
    band = "critical_success";
    outcome = "success";
  }
  return {
    certainty: input.certainty,
    band,
    outcome,
    percentile,
    modifier,
    effectivePercentile,
  };
}

function uniqueClockIds(
  values: readonly string[] | undefined,
  name: string,
): string[] {
  const result: string[] = [];
  for (const value of values ?? []) {
    if (!UUID_PATTERN.test(value))
      throw new Error(`${name} contains an invalid clock ID.`);
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

const OBJECTIVE_WORDS_TO_IGNORE = new Set([
  "the",
  "and",
  "but",
  "for",
  "nor",
  "yet",
  "you",
  "your",
  "yours",
  "our",
  "ours",
  "its",
  "his",
  "her",
  "hers",
  "who",
  "whom",
  "whose",
  "what",
  "when",
  "where",
  "which",
  "while",
  "that",
  "than",
  "then",
  "because",
  "although",
  "though",
  "has",
  "had",
  "was",
  "were",
  "are",
  "can",
  "could",
  "will",
  "shall",
  "should",
  "must",
  "may",
  "might",
  "not",
  "any",
  "all",
  "each",
  "some",
  "other",
  "another",
  "out",
  "off",
  "over",
  "onto",
  "upon",
  "about",
  "after",
  "again",
  "against",
  "before",
  "being",
  "first",
  "from",
  "have",
  "into",
  "their",
  "there",
  "these",
  "they",
  "this",
  "through",
  "under",
  "until",
  "with",
  "would",
  "retrieve",
  "find",
  "locate",
  "reach",
  "obtain",
  "secure",
  "capture",
  "rescue",
  "defeat",
  "destroy",
  "escape",
  "complete",
  "finish",
  "recover",
  "investigate",
]);

function objectiveWords(value: string): string[] {
  return [
    ...new Set(
      value
        .normalize("NFKC")
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}][\p{L}\p{N}'-]{2,}/gu) ?? [],
    ),
  ]
    .filter((word) => !OBJECTIVE_WORDS_TO_IGNORE.has(word))
    .slice(0, 8);
}

/**
 * Pull the target of the final purpose clause from a locked starting point.
 * This is intentionally conservative: if Storyhold cannot identify a target,
 * it does not pretend that a generic premise is a machine-readable objective.
 */
export function objectiveTargetsFromStartingPoint(
  startingPoint: unknown,
): string[] {
  const value = text(startingPoint, 3_000);
  if (!value) return [];
  const clauses = [
    ...value.matchAll(
      /\b(?:in order to|so (?:i|we|you|they) can|must|needs? to|goal(?: is)? to|objective(?: is)? to|trying to|attempting to|to)\s+([^.!?;\n]{3,240})/giu,
    ),
  ];
  const lastClause = clauses.at(-1)?.[1] ?? "";
  return objectiveWords(lastClause);
}

export function classifyTurnActionScope(
  intentValue: unknown,
  playerInputValue: unknown,
): TurnActionScope {
  const intent = normalizeTurnIntent(intentValue);
  if (intent === "event") return "external_event";
  if (intent === "question") return "observation";
  const input = text(playerInputValue, 20_000).toLocaleLowerCase();
  if (
    /\b(?:attack|fight|shoot|stab|strike|punch|kick|grapple|dodge|chase|kill|defeat)\b/u.test(
      input,
    )
  )
    return "conflict";
  if (
    /\b(?:take|pick up|retrieve|secure|touch|use|activate|deactivate|open|close|unlock|cut|break|repair|move the|push|pull|press)\b/u.test(
      input,
    )
  )
    return "manipulation";
  if (
    /\b(?:go|proceed|advance|walk|run|move (?:forward|to|toward|towards|through|into|across)|fan out|enter|leave|retreat|descend|ascend|climb|follow|cross|travel|journey|drive|fly|sail|hike)\b/u.test(
      input,
    )
  )
    return "movement";
  if (
    /\b(?:look|search|examine|inspect|scan|listen|watch|check|study|observe|track|investigate)\b/u.test(
      input,
    )
  )
    return "observation";
  if (
    /\b(?:say|tell|ask|reply|answer|order|command|persuade|threaten|promise|explain|shout|whisper)\b/u.test(
      input,
    )
  )
    return "communication";
  if (
    /\b(?:wait|rest|sleep|work|craft|build|research|train|practice|spend (?:the|a|an|\d))\b/u.test(
      input,
    )
  )
    return "extended";
  return "other";
}

function explicitlyAttemptsObjective(
  input: string,
  targets: readonly string[],
) {
  const inputWords = new Set(objectiveWords(input));
  return targets.some((target) => inputWords.has(target));
}

function requestsObjectiveCompletion(input: string) {
  return /\b(?:retrieve|take|secure|obtain|capture|rescue|defeat|destroy|kill|escape|complete|finish|recover|claim)\b/iu.test(
    input,
  );
}

function startingPointMakesObjectiveAccessible(
  startingPoint: unknown,
  targets: readonly string[],
) {
  const value = text(startingPoint, 3_000)
    .normalize("NFKC")
    .toLocaleLowerCase();
  return targets.some((target) => {
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const targetPattern = `\\b${escaped}(?:s|es)?\\b`;
    return new RegExp(
      `(?:standing|stands?|waiting|begins?|starts?)?[^.!?]{0,40}(?:before|beside|next to|within reach of|holding|facing|face to face with|in front of)[^.!?]{0,30}${targetPattern}|${targetPattern}[^.!?]{0,30}(?:is |are )?(?:visible|within reach|in hand|directly ahead)`,
      "u",
    ).test(value);
  });
}

function boundedProgressCount(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(0, Math.min(10_000, Math.round(parsed)))
    : 0;
}

export function deriveTurnProgressionContract(input: {
  intent: TurnIntent;
  playerInput: string;
  startingPoint?: unknown;
  /** Trusted active-objective prose from the typed RPG state. */
  objectiveTargetHints?: readonly string[];
  clockDrivenOverrideAllowed?: boolean;
  priorObjectiveClues?: number;
  priorObjectiveMilestones?: number;
}): TurnProgressionContract {
  const actionScope = classifyTurnActionScope(input.intent, input.playerInput);
  const objectiveTargets = [
    ...new Set([
      ...objectiveTargetsFromStartingPoint(input.startingPoint),
      ...(input.objectiveTargetHints ?? []).flatMap((hint) =>
        objectiveWords(text(hint, 480)),
      ),
    ]),
  ].slice(0, 8);
  const explicitObjectiveAttempt = explicitlyAttemptsObjective(
    input.playerInput,
    objectiveTargets,
  );
  const priorObjectiveClues = boundedProgressCount(input.priorObjectiveClues);
  const priorObjectiveMilestones = boundedProgressCount(
    input.priorObjectiveMilestones,
  );
  const objectiveImmediatelyAccessible = startingPointMakesObjectiveAccessible(
    input.startingPoint,
    objectiveTargets,
  );
  const enoughScaffolding =
    objectiveImmediatelyAccessible ||
    priorObjectiveMilestones > 0 ||
    priorObjectiveClues >= 2;
  let maximumObjectiveImpact: ObjectiveImpact =
    objectiveTargets.length === 0 ? "progress" : "clue";
  if (actionScope === "extended" && !explicitObjectiveAttempt) {
    maximumObjectiveImpact = "none";
  } else if (explicitObjectiveAttempt) {
    maximumObjectiveImpact =
      requestsObjectiveCompletion(input.playerInput) &&
      (actionScope === "manipulation" ||
        actionScope === "conflict" ||
        actionScope === "extended") &&
      (objectiveImmediatelyAccessible || priorObjectiveMilestones > 0)
        ? "completion"
        : enoughScaffolding ||
            actionScope === "manipulation" ||
            actionScope === "conflict"
          ? "progress"
          : "clue";
  } else if (
    enoughScaffolding &&
    (actionScope === "movement" ||
      actionScope === "observation" ||
      actionScope === "manipulation" ||
      actionScope === "conflict")
  ) {
    maximumObjectiveImpact = "progress";
  }
  return {
    actionScope,
    objectiveTargets,
    explicitObjectiveAttempt,
    maximumObjectiveImpact,
    clockDrivenOverrideAllowed: input.clockDrivenOverrideAllowed === true,
    priorObjectiveClues,
    priorObjectiveMilestones,
    objectiveImmediatelyAccessible,
  };
}

function normalizeProgressionContract(
  value: TurnProgressionContract | undefined,
): TurnProgressionContract {
  const input = record(value);
  return {
    actionScope: allowed(
      input.actionScope,
      [
        "communication",
        "observation",
        "movement",
        "manipulation",
        "conflict",
        "extended",
        "external_event",
        "other",
      ] as const,
      "other",
    ),
    objectiveTargets: stringList(input.objectiveTargets, 8, 80),
    explicitObjectiveAttempt: input.explicitObjectiveAttempt === true,
    maximumObjectiveImpact: allowed(
      input.maximumObjectiveImpact,
      ["none", "clue", "progress", "completion"] as const,
      "clue",
    ),
    clockDrivenOverrideAllowed: input.clockDrivenOverrideAllowed === true,
    priorObjectiveClues: boundedProgressCount(input.priorObjectiveClues),
    priorObjectiveMilestones: boundedProgressCount(
      input.priorObjectiveMilestones,
    ),
    objectiveImmediatelyAccessible:
      input.objectiveImmediatelyAccessible === true,
  };
}

/** Build the semantic record that narration must not be allowed to rewrite. */
export function createDeterministicEngineEnvelope(input: {
  campaignId: string;
  requestId: string;
  playerInput: string;
  serverSecret: string;
  baseStateVersion: number;
  intent: TurnIntent;
  certainty: OutcomeCertainty;
  modifier?: number;
  thresholds?: Partial<OutcomeThresholds>;
  includeD20?: boolean;
  timeAdvanceMinutes?: number;
  eligibleResolveClockEventIds?: readonly string[];
  eligibleAcknowledgeClockEventIds?: readonly string[];
  progression?: TurnProgressionContract;
}): DeterministicEngineEnvelope {
  const campaignId = requiredText(input.campaignId, "campaignId", 160);
  const requestId = requiredText(input.requestId, "requestId", 160);
  const material = fortuneMaterial(input);
  const fortune = deriveStableFortune(input);
  const serverSecret = requiredText(input.serverSecret, "serverSecret", 4_096);
  const timeAdvanceMinutes = Number(input.timeAdvanceMinutes ?? 0);
  if (
    !Number.isSafeInteger(timeAdvanceMinutes) ||
    timeAdvanceMinutes < 0 ||
    timeAdvanceMinutes > MAX_TIME_ADVANCE_MINUTES
  ) {
    throw new Error(
      "timeAdvanceMinutes must be a non-negative safe integer no greater than ten years.",
    );
  }
  const eligibleResolveClockEventIds = uniqueClockIds(
    input.eligibleResolveClockEventIds,
    "eligibleResolveClockEventIds",
  );
  const eligibleAcknowledgeClockEventIds = uniqueClockIds(
    input.eligibleAcknowledgeClockEventIds,
    "eligibleAcknowledgeClockEventIds",
  );
  return {
    schemaVersion: 1,
    campaignId,
    requestId,
    baseStateVersion: material.stateVersion,
    intent: normalizeTurnIntent(input.intent),
    inputCommitment: createHmac("sha256", serverSecret)
      .update("storyhold-causal-input-v1\u0000", "utf8")
      .update(material.normalizedInput, "utf8")
      .digest("hex"),
    fortune,
    resolution: {
      ...resolveDeterministicOutcome({
        certainty: input.certainty,
        fortune,
        modifier: input.modifier,
        thresholds: input.thresholds,
      }),
      timeAdvanceMinutes,
    },
    clockEligibility: {
      resolve: eligibleResolveClockEventIds,
      acknowledgeMatured: eligibleAcknowledgeClockEventIds,
    },
    progression: normalizeProgressionContract(input.progression),
  };
}

function narratorClockList(
  input: Record<string, unknown>,
  property: string,
  issues: SemanticValidationIssue[],
): string[] {
  const value = input[property];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    issues.push({
      code: "MALFORMED_CLOCK_LIST",
      path: property,
      message: `${property} must be an array of clock IDs.`,
      value,
    });
    return [];
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !UUID_PATTERN.test(item)) {
      issues.push({
        code: "INVALID_CLOCK_ID",
        path: property,
        message: `${property} contains an invalid clock ID.`,
        value: item,
      });
      continue;
    }
    if (!result.includes(item)) result.push(item);
  }
  return result;
}

/**
 * Check only frozen server semantics. Prose quality remains a separate concern.
 * Call this on the normalized narrator result immediately before any commit.
 */
export function validateNarratorSemantics(
  envelope: DeterministicEngineEnvelope,
  narratorValue: unknown,
): SemanticValidationResult {
  const narrator = record(narratorValue);
  const issues: SemanticValidationIssue[] = [];
  if (narrator.outcome !== envelope.resolution.outcome) {
    issues.push({
      code: "OUTCOME_MISMATCH",
      path: "outcome",
      message: `Narrator outcome must remain ${envelope.resolution.outcome}.`,
      value: narrator.outcome,
    });
  }
  const reportedTime = Number(narrator.timeAdvanceMinutes);
  if (
    !Number.isSafeInteger(reportedTime) ||
    reportedTime !== envelope.resolution.timeAdvanceMinutes
  ) {
    issues.push({
      code: "TIME_ADVANCE_MISMATCH",
      path: "timeAdvanceMinutes",
      message: `Narrator time advance must remain ${envelope.resolution.timeAdvanceMinutes}.`,
      value: narrator.timeAdvanceMinutes,
    });
  }
  const resolveClockEventIds = narratorClockList(
    narrator,
    "resolveClockEventIds",
    issues,
  );
  const acknowledgedMaturedClockEventIds = narratorClockList(
    narrator,
    "acknowledgedMaturedClockEventIds",
    issues,
  );
  const eligibleResolve = new Set(envelope.clockEligibility.resolve);
  const eligibleAcknowledge = new Set(
    envelope.clockEligibility.acknowledgeMatured,
  );
  for (const clockId of resolveClockEventIds) {
    if (!eligibleResolve.has(clockId)) {
      issues.push({
        code: "INELIGIBLE_CLOCK_RESOLUTION",
        path: "resolveClockEventIds",
        message:
          "Narrator attempted to resolve a clock the engine did not authorize.",
        value: clockId,
      });
    }
  }
  for (const clockId of acknowledgedMaturedClockEventIds) {
    if (!eligibleAcknowledge.has(clockId)) {
      issues.push({
        code: "INELIGIBLE_CLOCK_ACKNOWLEDGEMENT",
        path: "acknowledgedMaturedClockEventIds",
        message:
          "Narrator attempted to acknowledge a matured clock the engine did not authorize.",
        value: clockId,
      });
    }
  }
  const acknowledgedMatured = new Set(acknowledgedMaturedClockEventIds);
  for (const clockId of eligibleAcknowledge) {
    if (!acknowledgedMatured.has(clockId)) {
      issues.push({
        code: "MISSING_REQUIRED_CLOCK_ACKNOWLEDGEMENT",
        path: "acknowledgedMaturedClockEventIds",
        message:
          "Narrator must acknowledge every clock that is already matured or due.",
        value: clockId,
      });
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      outcome: envelope.resolution.outcome,
      timeAdvanceMinutes: envelope.resolution.timeAdvanceMinutes,
      resolveClockEventIds,
      acknowledgedMaturedClockEventIds,
    },
  };
}

export class NarratorSemanticValidationError extends Error {
  constructor(public readonly issues: SemanticValidationIssue[]) {
    super(
      issues.map((issue) => `${issue.code} at ${issue.path}`).join("; ") ||
        "Narrator semantics were rejected.",
    );
    this.name = "NarratorSemanticValidationError";
  }
}

export function assertNarratorSemantics(
  envelope: DeterministicEngineEnvelope,
  narratorValue: unknown,
): AcceptedNarratorSemantics {
  const result = validateNarratorSemantics(envelope, narratorValue);
  if (result.ok === false)
    throw new NarratorSemanticValidationError(result.issues);
  return result.value;
}

export function normalizeTurnIntent(value: unknown): TurnIntent {
  return allowed(value, ["action", "question", "event"] as const, "action");
}

export function normalizeCampaignProposition(
  value: unknown,
): CampaignProposition | null {
  const input = record(value);
  const subject = text(input.subject, 220);
  const predicate = text(input.predicate, 160);
  const object = text(input.object, 1_000);
  if (!subject || !predicate || !object) return null;
  const layer = allowed(
    input.layer,
    ["reality", "knowledge", "belief", "claim"] as const,
    "reality",
  );
  const holder = text(input.holder, 220);
  const holderEntityId = uuid(input.holderEntityId);
  if (layer !== "reality" && !holder && !holderEntityId) return null;
  const confidence = Number(input.confidence);
  return {
    layer,
    subjectEntityId: uuid(input.subjectEntityId),
    subject,
    predicate,
    object,
    holderEntityId,
    holder,
    stance: allowed(
      input.stance,
      ["affirmed", "denied", "uncertain", "disputed"] as const,
      "affirmed",
    ),
    visibility:
      layer === "reality"
        ? allowed(
            input.visibility,
            ["campaign", "character", "system", "studio"] as const,
            "system",
          )
        : allowed(
            input.visibility,
            ["campaign", "character", "system", "studio"] as const,
            "character",
          ),
    confidence: Number.isFinite(confidence)
      ? Math.max(0, Math.min(1, confidence))
      : 0.75,
    causalBasis: stringList(input.causalBasis, 12, 500),
    supersedesPropositionId: uuid(input.supersedesPropositionId),
  };
}

function slug(value: unknown, fallback: string): string {
  const normalized = text(value, 120)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 72);
  return normalized || fallback;
}

export function normalizeStoryMove(value: unknown): StoryMove | null {
  const input = record(value);
  const summary = text(input.summary, 500);
  if (!summary) return null;
  return {
    device: slug(input.device, "unclassified_device"),
    structure: slug(input.structure, "unclassified_structure"),
    summary,
    intentionalMotif: input.intentionalMotif === true,
  };
}

function normalizePropositionTrigger(
  value: unknown,
): PropositionClockTrigger | null {
  const input = record(value);
  if (input.kind !== "proposition") return null;
  const subject = text(input.subject, 220);
  const subjectEntityId = uuid(input.subjectEntityId);
  const predicate = text(input.predicate, 160);
  if ((!subject && !subjectEntityId) || !predicate) return null;
  const layer = allowed(
    input.layer,
    ["reality", "knowledge", "belief", "claim"] as const,
    "reality",
  );
  const holderEntityId = uuid(input.holderEntityId);
  const holder = text(input.holder, 220);
  if (layer !== "reality" && !holderEntityId && !holder) return null;
  return {
    kind: "proposition",
    layer,
    subjectEntityId,
    subject,
    predicate,
    object: text(input.object, 1_000),
    objectMatch: allowed(
      input.objectMatch,
      ["equals", "contains"] as const,
      "equals",
    ),
    holderEntityId,
    holder,
    stance: allowed(
      input.stance,
      ["affirmed", "denied", "uncertain", "disputed"] as const,
      "affirmed",
    ),
  };
}

export function normalizeClockTrigger(value: unknown): ClockTriggerDefinition {
  const input = record(value);
  if (input.kind === "proposition") {
    return normalizePropositionTrigger(input) ?? { kind: "none" };
  }
  if (input.kind === "all" || input.kind === "any") {
    const conditions = (Array.isArray(input.conditions) ? input.conditions : [])
      .map(normalizePropositionTrigger)
      .filter((item): item is PropositionClockTrigger => item !== null)
      .slice(0, 8);
    return conditions.length > 0
      ? { kind: input.kind, conditions }
      : { kind: "none" };
  }
  return { kind: "none" };
}

function comparable(value: unknown): string {
  return text(value, 1_200).toLocaleLowerCase();
}

function rowValue(
  row: Record<string, unknown>,
  camel: string,
  snake: string,
): unknown {
  return row[camel] ?? row[snake];
}

function propositionSatisfies(
  trigger: PropositionClockTrigger,
  proposition: Record<string, unknown>,
): boolean {
  if (rowValue(proposition, "layer", "layer") !== trigger.layer) return false;
  if (rowValue(proposition, "stance", "stance") !== trigger.stance)
    return false;
  const subjectEntityId = rowValue(
    proposition,
    "subjectEntityId",
    "subject_entity_id",
  );
  if (
    trigger.subjectEntityId &&
    String(subjectEntityId ?? "") !== trigger.subjectEntityId
  )
    return false;
  if (
    !trigger.subjectEntityId &&
    trigger.subject &&
    comparable(rowValue(proposition, "subject", "subject")) !==
      comparable(trigger.subject)
  )
    return false;
  if (
    comparable(rowValue(proposition, "predicate", "predicate")) !==
    comparable(trigger.predicate)
  )
    return false;
  const holderEntityId = rowValue(
    proposition,
    "holderEntityId",
    "holder_entity_id",
  );
  if (
    trigger.holderEntityId &&
    String(holderEntityId ?? "") !== trigger.holderEntityId
  )
    return false;
  if (
    !trigger.holderEntityId &&
    trigger.holder &&
    comparable(rowValue(proposition, "holder", "holder")) !==
      comparable(trigger.holder)
  )
    return false;
  if (!trigger.object) return true;
  const propositionObject = comparable(
    rowValue(proposition, "object", "object_value"),
  );
  const triggerObject = comparable(trigger.object);
  return trigger.objectMatch === "contains"
    ? propositionObject.includes(triggerObject)
    : propositionObject === triggerObject;
}

export function clockTriggerIsSatisfied(
  triggerValue: unknown,
  propositions: Record<string, unknown>[],
): boolean {
  const trigger = normalizeClockTrigger(triggerValue);
  if (trigger.kind === "none") return false;
  if (trigger.kind === "proposition") {
    return propositions.some((proposition) =>
      propositionSatisfies(trigger, proposition),
    );
  }
  const matches = trigger.conditions.map((condition) =>
    propositions.some((proposition) =>
      propositionSatisfies(condition, proposition),
    ),
  );
  return trigger.kind === "all"
    ? matches.every(Boolean)
    : matches.some(Boolean);
}

export function conditionalClockEventIsDue(
  event: Record<string, unknown>,
  propositions: Record<string, unknown>[],
): boolean {
  if (event.status !== "scheduled") return false;
  return clockTriggerIsSatisfied(
    rowValue(event, "triggerDefinition", "trigger_definition"),
    propositions,
  );
}

export function intentInstructions(intent: TurnIntent): string {
  if (intent === "question") {
    return "The player is asking what their character can determine. Answer from that character's knowledge and perception; do not reveal system-only reality merely because the player asked.";
  }
  if (intent === "event") {
    return "The player is proposing a direction or external event. Treat it as requested story pressure, not as an accomplished fact. Accept only the parts compatible with locked canon and causal state.";
  }
  return "The player is declaring an attempt. Their wording describes intent, not automatic success or a newly established world fact.";
}

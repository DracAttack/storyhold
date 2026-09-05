import { createHash } from "node:crypto";
import type {
  CampaignRpgState,
  CampaignRpgStateDelta,
  RpgCapability,
  RpgCompanion,
  RpgInventoryItem,
  RpgPool,
  RpgReputation,
} from "./campaignRpgState";
import {
  classifyTurnActionScope,
  type DeterministicEngineEnvelope,
} from "./causalEngine";

type JsonRecord = Record<string, unknown>;

export type CampaignRpgRewardSource =
  | { readonly kind: "player_action" }
  | { readonly kind: "campaign_rule"; readonly authorizationId: string }
  | { readonly kind: "matured_clock"; readonly clockEventId: string };

type GrantBase = {
  readonly grantId: string;
  readonly source: CampaignRpgRewardSource;
};

/**
 * Positive mutations are deliberately enumerated. A Director never creates
 * one of these grants; the server builds and keeps the budget beside the
 * frozen engine envelope, then validates the Director's proposal against it.
 */
export type CampaignRpgRewardGrant =
  | (GrantBase & {
      readonly kind: "objective_progress";
      readonly objectiveId: string;
      readonly maximumAmount: number;
    })
  | (GrantBase & {
      readonly kind: "vitality_recovery";
      readonly characterId: string;
      readonly maximumAmount: number;
    })
  | (GrantBase & {
      readonly kind: "stress_relief";
      readonly characterId: string;
      readonly maximumAmount: number;
    })
  | (GrantBase & {
      readonly kind: "harm_removal";
      readonly characterId: string;
      readonly harmIds: readonly string[];
    })
  | (GrantBase & {
      readonly kind: "condition_removal";
      readonly characterId: string;
      readonly conditionIds: readonly string[];
    })
  | (GrantBase & {
      readonly kind: "character_resource";
      readonly characterId: string;
      readonly poolId: string;
      readonly maximumAmount: number;
    })
  | (GrantBase & {
      readonly kind: "character_resource_add";
      readonly characterId: string;
      readonly pool: RpgPool;
    })
  | (GrantBase & {
      readonly kind: "shared_resource";
      readonly poolId: string;
      readonly maximumAmount: number;
    })
  | (GrantBase & {
      readonly kind: "shared_resource_add";
      readonly pool: RpgPool;
    })
  | (GrantBase & {
      readonly kind: "inventory_quantity";
      readonly characterId: string;
      readonly itemId: string;
      readonly maximumAmount: number;
    })
  | (GrantBase & {
      readonly kind: "inventory_item";
      readonly characterId: string;
      readonly item: RpgInventoryItem;
    })
  | (GrantBase & {
      readonly kind: "capability_rank";
      readonly characterId: string;
      readonly capabilityId: string;
      readonly maximumAmount: number;
    })
  | (GrantBase & {
      readonly kind: "capability";
      readonly characterId: string;
      readonly capability: RpgCapability;
    })
  | (GrantBase & {
      readonly kind: "reputation";
      readonly targetId: string;
      readonly maximumAmount: number;
    })
  | (GrantBase & {
      readonly kind: "reputation_add";
      readonly reputation: RpgReputation;
    })
  | (GrantBase & {
      readonly kind: "companion_loyalty";
      readonly companionId: string;
      readonly maximumAmount: number;
    })
  | (GrantBase & {
      readonly kind: "companion";
      readonly companion: RpgCompanion;
    });

export type CampaignRpgRewardBudget = {
  readonly schemaVersion: 1;
  readonly seedId: string;
  readonly stateVersion: number;
  /** Prevents replay across branches which happen to share a version number. */
  readonly stateCommitment: string;
  readonly requestId: string;
  readonly engineInputCommitment: string;
  readonly outcomePolicy:
    | "no_player_reward"
    | "partial_objective_progress"
    | "objective_progress"
    | "objective_completion";
  readonly grants: readonly CampaignRpgRewardGrant[];
};

export type CampaignRpgRewardProposal = Readonly<
  Omit<
    CampaignRpgStateDelta,
    "expectedStateVersion" | "reason" | "turnAccepted"
  > & {
    readonly causalBasis?: readonly string[];
  }
>;

export type CampaignRpgRewardAuthorization = CampaignRpgRewardGrant & {
  readonly source:
    | { readonly kind: "campaign_rule"; readonly authorizationId: string }
    | { readonly kind: "matured_clock"; readonly clockEventId: string };
};

export class CampaignRpgRewardBudgetError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "CampaignRpgRewardBudgetError";
  }
}

function fail(code: string, message: string): never {
  throw new CampaignRpgRewardBudgetError(code, message);
}

function record(value: unknown, path: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_RPG_REWARD_PROPOSAL", `${path} must be an object.`);
  }
  return value as JsonRecord;
}

function records(value: unknown, path: string): JsonRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail("INVALID_RPG_REWARD_PROPOSAL", `${path} must be an array.`);
  }
  return value.map((entry, index) => record(entry, `${path}[${index}]`));
}

function cleanId(value: unknown, path: string): string {
  if (typeof value !== "string") {
    fail("INVALID_RPG_REWARD_AUTHORIZATION", `${path} must be a string.`);
  }
  const result = value.normalize("NFKC").replace(/\u0000/gu, "").trim();
  if (!result || result.length > 160) {
    fail("INVALID_RPG_REWARD_AUTHORIZATION", `${path} must contain 1-160 characters.`);
  }
  return result;
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 1_000_000) {
    fail("INVALID_RPG_REWARD_AUTHORIZATION", `${path} must be a positive integer.`);
  }
  return Number(value);
}

function proposedInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value)) {
    fail("INVALID_RPG_REWARD_PROPOSAL", `${path} must be an integer.`);
  }
  return Number(value);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as JsonRecord)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function cloneJson<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return fail("INVALID_RPG_REWARD_PROPOSAL", "The RPG proposal must be JSON-safe.");
  }
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function normalizedWords(value: string): Set<string> {
  return new Set(
    value
      .normalize("NFKC")
      .toLocaleLowerCase("en-US")
      .match(/[\p{L}\p{N}][\p{L}\p{N}'-]{2,}/gu) ?? [],
  );
}

function objectiveTargetScore(
  objective: CampaignRpgState["objectives"][number],
  targets: readonly string[],
): number {
  const objectiveWords = normalizedWords(`${objective.title} ${objective.description}`);
  return targets.filter((target) => objectiveWords.has(
    target.normalize("NFKC").toLocaleLowerCase("en-US"),
  )).length;
}

function playerObjectiveAllowance(input: {
  state: CampaignRpgState;
  envelope: DeterministicEngineEnvelope;
}): { objectiveId: string; maximumAmount: number } | null {
  const { outcome, band } = input.envelope.resolution;
  if (!(["success", "mixed"] as const).includes(outcome as "success" | "mixed")) return null;
  if (input.envelope.intent === "event") return null;
  if (input.envelope.progression.maximumObjectiveImpact === "none") return null;
  if (input.envelope.progression.objectiveTargets.length === 0) return null;
  const hasEstablishedScaffolding =
    input.envelope.progression.objectiveImmediatelyAccessible ||
    input.envelope.progression.priorObjectiveClues > 0 ||
    input.envelope.progression.priorObjectiveMilestones > 0;
  if (
    !input.envelope.progression.explicitObjectiveAttempt &&
    !hasEstablishedScaffolding
  ) return null;

  const ranked = input.state.objectives
    .filter((objective) => objective.status === "active")
    .map((objective) => ({
      objective,
      score: objectiveTargetScore(
        objective,
        input.envelope.progression.objectiveTargets,
      ),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) =>
      right.score - left.score || left.objective.id.localeCompare(right.objective.id),
    );
  if (ranked.length === 0) return null;
  // An ambiguous name match is not enough authority to advance either goal.
  if (ranked.length > 1 && ranked[0]!.score === ranked[1]!.score) return null;

  const objective = ranked[0]!.objective;
  const remaining = objective.target - objective.progress;
  if (remaining <= 0) return null;
  const impact = input.envelope.progression.maximumObjectiveImpact;
  let maximumAmount = 0;
  if (outcome === "mixed") {
    // A mixed result can still accomplish a one-step objective; its cost or
    // complication belongs in the separately guarded negative mutations.
    maximumAmount = Math.min(1, remaining);
  } else if (impact === "completion") {
    maximumAmount = remaining;
  } else {
    const ordinaryMaximum = band === "critical_success" && impact === "progress" ? 2 : 1;
    maximumAmount = Math.min(ordinaryMaximum, Math.max(0, remaining - 1));
  }
  return maximumAmount > 0 ? { objectiveId: objective.id, maximumAmount } : null;
}

function outcomePolicy(
  envelope: DeterministicEngineEnvelope,
  allowance: { maximumAmount: number } | null,
): CampaignRpgRewardBudget["outcomePolicy"] {
  if (!allowance) return "no_player_reward";
  if (envelope.resolution.outcome === "mixed") return "partial_objective_progress";
  return envelope.progression.maximumObjectiveImpact === "completion"
    ? "objective_completion"
    : "objective_progress";
}

function assertSourceAuthorized(input: {
  source: CampaignRpgRewardAuthorization["source"];
  envelope: DeterministicEngineEnvelope;
  acknowledgedMaturedClockEventIds: ReadonlySet<string>;
}) {
  if (input.source.kind === "campaign_rule") {
    cleanId(input.source.authorizationId, "authorization.source.authorizationId");
    return;
  }
  const clockEventId = cleanId(input.source.clockEventId, "authorization.source.clockEventId");
  if (
    !input.envelope.clockEligibility.acknowledgeMatured.includes(clockEventId) ||
    !input.acknowledgedMaturedClockEventIds.has(clockEventId)
  ) {
    fail(
      "INELIGIBLE_RPG_REWARD_SOURCE",
      `Clock ${clockEventId} is not an acknowledged matured clock in the frozen turn.`,
    );
  }
}

function assertTargetExists(
  state: CampaignRpgState,
  authorization: CampaignRpgRewardAuthorization,
  targets: readonly string[],
) {
  const character = "characterId" in authorization
    ? state.characters.find((entry) => entry.characterId === authorization.characterId)
    : null;
  if ("characterId" in authorization && !character) {
    fail("UNKNOWN_RPG_REWARD_TARGET", `Character ${authorization.characterId} does not exist.`);
  }

  switch (authorization.kind) {
    case "objective_progress": {
      const objective = state.objectives.find((entry) => entry.id === authorization.objectiveId);
      if (!objective || objective.status !== "active" || objectiveTargetScore(objective, targets) === 0) {
        fail(
          "UNKNOWN_RPG_REWARD_TARGET",
          `Objective ${authorization.objectiveId} is not an active objective tied to the turn target.`,
        );
      }
      if (positiveInteger(authorization.maximumAmount, "authorization.maximumAmount") > objective.target - objective.progress) {
        fail("INVALID_RPG_REWARD_AUTHORIZATION", "Objective progress exceeds its remaining progress.");
      }
      break;
    }
    case "vitality_recovery":
      if (positiveInteger(authorization.maximumAmount, "authorization.maximumAmount") > character!.vitality.maximum - character!.vitality.current) {
        fail("INVALID_RPG_REWARD_AUTHORIZATION", "Vitality recovery exceeds missing vitality.");
      }
      break;
    case "stress_relief":
      if (positiveInteger(authorization.maximumAmount, "authorization.maximumAmount") > character!.stress.current) {
        fail("INVALID_RPG_REWARD_AUTHORIZATION", "Stress relief exceeds current stress.");
      }
      break;
    case "harm_removal": {
      const known = new Set(character!.harms.map((entry) => entry.id));
      if (authorization.harmIds.length === 0 || authorization.harmIds.some((id) => !known.has(id))) {
        fail("UNKNOWN_RPG_REWARD_TARGET", "A harm-removal grant references unknown harm.");
      }
      break;
    }
    case "condition_removal": {
      const known = new Set(character!.conditions.map((entry) => entry.id));
      if (authorization.conditionIds.length === 0 || authorization.conditionIds.some((id) => !known.has(id))) {
        fail("UNKNOWN_RPG_REWARD_TARGET", "A condition-removal grant references an unknown condition.");
      }
      break;
    }
    case "character_resource": {
      const pool = character!.resources.find((entry) => entry.id === authorization.poolId);
      if (!pool) fail("UNKNOWN_RPG_REWARD_TARGET", `Character resource ${authorization.poolId} does not exist.`);
      const maximum = positiveInteger(authorization.maximumAmount, "authorization.maximumAmount");
      if (pool.maximum !== null && maximum > pool.maximum - pool.current) {
        fail("INVALID_RPG_REWARD_AUTHORIZATION", "Resource grant exceeds pool capacity.");
      }
      break;
    }
    case "character_resource_add":
      if (character!.resources.some((entry) => entry.id === authorization.pool.id)) {
        fail("INVALID_RPG_REWARD_AUTHORIZATION", `Character resource ${authorization.pool.id} already exists.`);
      }
      break;
    case "shared_resource": {
      const pool = state.sharedResources.find((entry) => entry.id === authorization.poolId);
      if (!pool) fail("UNKNOWN_RPG_REWARD_TARGET", `Shared resource ${authorization.poolId} does not exist.`);
      const maximum = positiveInteger(authorization.maximumAmount, "authorization.maximumAmount");
      if (pool.maximum !== null && maximum > pool.maximum - pool.current) {
        fail("INVALID_RPG_REWARD_AUTHORIZATION", "Shared-resource grant exceeds pool capacity.");
      }
      break;
    }
    case "shared_resource_add":
      if (state.sharedResources.some((entry) => entry.id === authorization.pool.id)) {
        fail("INVALID_RPG_REWARD_AUTHORIZATION", `Shared resource ${authorization.pool.id} already exists.`);
      }
      break;
    case "inventory_quantity": {
      const item = character!.inventory.find((entry) => entry.id === authorization.itemId);
      if (!item) fail("UNKNOWN_RPG_REWARD_TARGET", `Inventory item ${authorization.itemId} does not exist.`);
      positiveInteger(authorization.maximumAmount, "authorization.maximumAmount");
      break;
    }
    case "inventory_item":
      if (character!.inventory.some((entry) => entry.id === authorization.item.id)) {
        fail("INVALID_RPG_REWARD_AUTHORIZATION", `Inventory item ${authorization.item.id} already exists.`);
      }
      break;
    case "capability_rank": {
      const capability = character!.capabilities.find((entry) => entry.id === authorization.capabilityId);
      if (!capability) fail("UNKNOWN_RPG_REWARD_TARGET", `Capability ${authorization.capabilityId} does not exist.`);
      if (positiveInteger(authorization.maximumAmount, "authorization.maximumAmount") > 5 - capability.rank) {
        fail("INVALID_RPG_REWARD_AUTHORIZATION", "Capability grant exceeds maximum rank.");
      }
      break;
    }
    case "capability":
      if (character!.capabilities.some((entry) => entry.id === authorization.capability.id)) {
        fail("INVALID_RPG_REWARD_AUTHORIZATION", `Capability ${authorization.capability.id} already exists.`);
      }
      break;
    case "reputation": {
      const reputation = state.reputations.find((entry) => entry.targetId === authorization.targetId);
      if (!reputation) fail("UNKNOWN_RPG_REWARD_TARGET", `Reputation ${authorization.targetId} does not exist.`);
      if (positiveInteger(authorization.maximumAmount, "authorization.maximumAmount") > 100 - reputation.score) {
        fail("INVALID_RPG_REWARD_AUTHORIZATION", "Reputation grant exceeds maximum reputation.");
      }
      break;
    }
    case "reputation_add":
      if (state.reputations.some((entry) => entry.targetId === authorization.reputation.targetId)) {
        fail("INVALID_RPG_REWARD_AUTHORIZATION", `Reputation ${authorization.reputation.targetId} already exists.`);
      }
      break;
    case "companion_loyalty": {
      const companion = state.companions.find((entry) => entry.id === authorization.companionId);
      if (!companion) fail("UNKNOWN_RPG_REWARD_TARGET", `Companion ${authorization.companionId} does not exist.`);
      if (positiveInteger(authorization.maximumAmount, "authorization.maximumAmount") > 100 - companion.loyalty) {
        fail("INVALID_RPG_REWARD_AUTHORIZATION", "Loyalty grant exceeds maximum loyalty.");
      }
      break;
    }
    case "companion":
      if (state.companions.some((entry) => entry.id === authorization.companion.id)) {
        fail("INVALID_RPG_REWARD_AUTHORIZATION", `Companion ${authorization.companion.id} already exists.`);
      }
      break;
  }
}

/**
 * Create the immutable positive-mutation budget for one frozen turn.
 * `independentAuthorizations` must come from trusted persisted rules or
 * structured clock effects. Model output must never be passed into that slot.
 */
export function buildCampaignRpgRewardBudget(input: {
  state: CampaignRpgState;
  engineEnvelope: DeterministicEngineEnvelope;
  playerAction: string;
  acknowledgedMaturedClockEventIds?: readonly string[];
  independentAuthorizations?: readonly CampaignRpgRewardAuthorization[];
}): CampaignRpgRewardBudget {
  const playerAction = input.playerAction
    .normalize("NFKC")
    .replace(/\u0000/gu, "")
    .trim();
  if (
    !playerAction ||
    classifyTurnActionScope(input.engineEnvelope.intent, playerAction) !==
      input.engineEnvelope.progression.actionScope
  ) {
    fail(
      "RPG_REWARD_INPUT_MISMATCH",
      "The player action does not match the frozen turn progression contract.",
    );
  }
  const allowance = playerObjectiveAllowance({
    state: input.state,
    envelope: input.engineEnvelope,
  });
  const grants: CampaignRpgRewardGrant[] = allowance
    ? [{
        grantId: `player-objective:${input.engineEnvelope.requestId}:${allowance.objectiveId}`,
        source: { kind: "player_action" },
        kind: "objective_progress",
        objectiveId: allowance.objectiveId,
        maximumAmount: allowance.maximumAmount,
      }]
    : [];
  const acknowledged = new Set(input.acknowledgedMaturedClockEventIds ?? []);
  for (const authorization of input.independentAuthorizations ?? []) {
    assertSourceAuthorized({
      source: authorization.source,
      envelope: input.engineEnvelope,
      acknowledgedMaturedClockEventIds: acknowledged,
    });
    cleanId(authorization.grantId, "authorization.grantId");
    assertTargetExists(
      input.state,
      authorization,
      input.engineEnvelope.progression.objectiveTargets,
    );
    grants.push(cloneJson(authorization));
  }
  const seen = new Set<string>();
  for (const grant of grants) {
    if (seen.has(grant.grantId)) {
      fail("DUPLICATE_RPG_REWARD_GRANT", `Reward grant ${grant.grantId} is duplicated.`);
    }
    seen.add(grant.grantId);
  }
  return deepFreeze({
    schemaVersion: 1,
    seedId: input.state.seedId,
    stateVersion: input.state.stateVersion,
    stateCommitment: sha256(input.state),
    requestId: input.engineEnvelope.requestId,
    engineInputCommitment: input.engineEnvelope.inputCommitment,
    outcomePolicy: outcomePolicy(input.engineEnvelope, allowance),
    grants,
  });
}

type GrantLedger = Map<string, { remaining: number; maximum: number }>;

function amountGrantKey(
  kind: CampaignRpgRewardGrant["kind"],
  firstId: string,
  secondId = "",
) {
  return `${kind}\u0000${firstId}\u0000${secondId}`;
}

function grantAmount(grant: CampaignRpgRewardGrant): number {
  if ("maximumAmount" in grant) return grant.maximumAmount;
  if (grant.kind === "harm_removal") return grant.harmIds.length;
  if (grant.kind === "condition_removal") return grant.conditionIds.length;
  return 1;
}

function grantKey(grant: CampaignRpgRewardGrant): string {
  switch (grant.kind) {
    case "objective_progress": return amountGrantKey(grant.kind, grant.objectiveId);
    case "vitality_recovery":
    case "stress_relief": return amountGrantKey(grant.kind, grant.characterId);
    case "character_resource": return amountGrantKey(grant.kind, grant.characterId, grant.poolId);
    case "shared_resource": return amountGrantKey(grant.kind, grant.poolId);
    case "inventory_quantity": return amountGrantKey(grant.kind, grant.characterId, grant.itemId);
    case "capability_rank": return amountGrantKey(grant.kind, grant.characterId, grant.capabilityId);
    case "reputation": return amountGrantKey(grant.kind, grant.targetId);
    case "companion_loyalty": return amountGrantKey(grant.kind, grant.companionId);
    case "harm_removal": return amountGrantKey(grant.kind, grant.characterId);
    case "condition_removal": return amountGrantKey(grant.kind, grant.characterId);
    case "character_resource_add": return amountGrantKey(grant.kind, grant.characterId, grant.pool.id);
    case "shared_resource_add": return amountGrantKey(grant.kind, grant.pool.id);
    case "inventory_item": return amountGrantKey(grant.kind, grant.characterId, grant.item.id);
    case "capability": return amountGrantKey(grant.kind, grant.characterId, grant.capability.id);
    case "reputation_add": return amountGrantKey(grant.kind, grant.reputation.targetId);
    case "companion": return amountGrantKey(grant.kind, grant.companion.id);
  }
}

function createLedger(budget: CampaignRpgRewardBudget): GrantLedger {
  const ledger: GrantLedger = new Map();
  for (const grant of budget.grants) {
    const key = grantKey(grant);
    const maximum = (ledger.get(key)?.maximum ?? 0) + grantAmount(grant);
    ledger.set(key, { remaining: maximum, maximum });
  }
  return ledger;
}

function consume(
  ledger: GrantLedger,
  key: string,
  amount: number,
  path: string,
) {
  const entry = ledger.get(key);
  if (!entry || entry.remaining < amount) {
    fail(
      entry
        ? "CAMPAIGN_RPG_REWARD_BUDGET_EXCEEDED"
        : "CAMPAIGN_RPG_REWARD_NOT_AUTHORIZED",
      `${path} is not within the server-issued reward budget.`,
    );
  }
  ledger.set(key, { ...entry, remaining: entry.remaining - amount });
}

function exactGrant(
  budget: CampaignRpgRewardBudget,
  key: string,
  proposed: unknown,
  select: (grant: CampaignRpgRewardGrant) => unknown,
  path: string,
) {
  const grant = budget.grants.find((candidate) =>
    grantKey(candidate) === key && canonicalJson(select(candidate)) === canonicalJson(proposed),
  );
  if (!grant) fail("CAMPAIGN_RPG_REWARD_NOT_AUTHORIZED", `${path} is not an exact server-issued reward.`);
}

function positiveConditionEffects(value: unknown, path: string): boolean {
  const condition = record(value, path);
  return records(condition.checkEffects, `${path}.checkEffects`).some((effect, index) => {
    const modifier = proposedInteger(effect.modifier, `${path}.checkEffects[${index}].modifier`);
    return modifier > 0;
  });
}

/**
 * Reject positive state minted by the Director and return a detached JSON-safe
 * proposal for the ordinary consequence and RPG-state validators. Numeric
 * grants are cumulative, so splitting one reward across several changes does
 * not bypass its cap.
 */
export function normalizeCampaignRpgProposalAgainstRewardBudget(input: {
  state: CampaignRpgState;
  budget: CampaignRpgRewardBudget;
  proposed: unknown;
}): CampaignRpgRewardProposal | null {
  if (input.proposed === null || input.proposed === undefined) return null;
  if (
    input.budget.schemaVersion !== 1 ||
    input.budget.seedId !== input.state.seedId ||
    input.budget.stateVersion !== input.state.stateVersion ||
    input.budget.stateCommitment !== sha256(input.state)
  ) {
    fail("RPG_REWARD_BUDGET_STATE_MISMATCH", "The reward budget does not bind to the current RPG state.");
  }
  const proposal = record(input.proposed, "proposed");
  const ledger = createLedger(input.budget);
  const characterById = new Map(input.state.characters.map((entry) => [entry.characterId, entry]));

  for (const [characterIndex, change] of records(proposal.characterChanges, "proposed.characterChanges").entries()) {
    const prefix = `proposed.characterChanges[${characterIndex}]`;
    const characterId = typeof change.characterId === "string" ? change.characterId : "";
    const character = characterById.get(characterId);
    if (!character) fail("UNKNOWN_RPG_REWARD_TARGET", `${prefix}.characterId is not a current character.`);
    if (change.vitalityChange !== undefined) {
      const amount = proposedInteger(change.vitalityChange, `${prefix}.vitalityChange`);
      if (amount > 0) consume(ledger, amountGrantKey("vitality_recovery", characterId), amount, `${prefix}.vitalityChange`);
    }
    if (change.stressChange !== undefined) {
      const amount = proposedInteger(change.stressChange, `${prefix}.stressChange`);
      if (amount < 0) consume(ledger, amountGrantKey("stress_relief", characterId), -amount, `${prefix}.stressChange`);
    }
    for (const [index, idValue] of (Array.isArray(change.removeHarmIds) ? change.removeHarmIds : []).entries()) {
      const id = String(idValue);
      const grants = input.budget.grants.filter((grant): grant is Extract<CampaignRpgRewardGrant, { kind: "harm_removal" }> =>
        grant.kind === "harm_removal" && grant.characterId === characterId && grant.harmIds.includes(id),
      );
      if (grants.length === 0) fail("CAMPAIGN_RPG_REWARD_NOT_AUTHORIZED", `${prefix}.removeHarmIds[${index}] is not authorized.`);
      consume(ledger, amountGrantKey("harm_removal", characterId), 1, `${prefix}.removeHarmIds[${index}]`);
    }
    for (const [index, idValue] of (Array.isArray(change.removeConditionIds) ? change.removeConditionIds : []).entries()) {
      const id = String(idValue);
      const grants = input.budget.grants.filter((grant): grant is Extract<CampaignRpgRewardGrant, { kind: "condition_removal" }> =>
        grant.kind === "condition_removal" && grant.characterId === characterId && grant.conditionIds.includes(id),
      );
      if (grants.length === 0) fail("CAMPAIGN_RPG_REWARD_NOT_AUTHORIZED", `${prefix}.removeConditionIds[${index}] is not authorized.`);
      consume(ledger, amountGrantKey("condition_removal", characterId), 1, `${prefix}.removeConditionIds[${index}]`);
    }
    for (const [index, condition] of records(change.addConditions, `${prefix}.addConditions`).entries()) {
      if (positiveConditionEffects(condition, `${prefix}.addConditions[${index}]`)) {
        fail("CAMPAIGN_RPG_REWARD_NOT_AUTHORIZED", `${prefix}.addConditions[${index}] contains an unauthorized positive effect.`);
      }
    }
    for (const [index, resource] of records(change.resourceChanges, `${prefix}.resourceChanges`).entries()) {
      const path = `${prefix}.resourceChanges[${index}]`;
      if (resource.kind === "add") {
        const pool = record(resource.pool, `${path}.pool`);
        const poolId = String(pool.id ?? "");
        const key = amountGrantKey("character_resource_add", characterId, poolId);
        exactGrant(input.budget, key, resource.pool, (grant) =>
          grant.kind === "character_resource_add" ? grant.pool : undefined,
        path);
        consume(ledger, key, 1, path);
      } else if (resource.kind === "adjust") {
        const amount = proposedInteger(resource.amount, `${path}.amount`);
        if (amount > 0) consume(
          ledger,
          amountGrantKey("character_resource", characterId, String(resource.poolId ?? "")),
          amount,
          path,
        );
      }
    }
    for (const [index, inventory] of records(change.inventoryChanges, `${prefix}.inventoryChanges`).entries()) {
      const path = `${prefix}.inventoryChanges[${index}]`;
      if (inventory.kind === "add") {
        const item = record(inventory.item, `${path}.item`);
        const itemId = String(item.id ?? "");
        const key = amountGrantKey("inventory_item", characterId, itemId);
        exactGrant(input.budget, key, inventory.item, (grant) =>
          grant.kind === "inventory_item" ? grant.item : undefined,
        path);
        consume(ledger, key, 1, path);
      } else if (inventory.kind === "quantity") {
        const amount = proposedInteger(inventory.amount, `${path}.amount`);
        if (amount > 0) consume(
          ledger,
          amountGrantKey("inventory_quantity", characterId, String(inventory.itemId ?? "")),
          amount,
          path,
        );
      } else if (inventory.kind === "equip" || inventory.kind === "unequip") {
        fail("CAMPAIGN_RPG_REWARD_NOT_AUTHORIZED", `${path} cannot be used to obtain an unbudgeted mechanical advantage.`);
      }
    }
    for (const [index, capability] of records(change.capabilityChanges, `${prefix}.capabilityChanges`).entries()) {
      const path = `${prefix}.capabilityChanges[${index}]`;
      if (capability.kind === "add") {
        const value = record(capability.capability, `${path}.capability`);
        const capabilityId = String(value.id ?? "");
        const key = amountGrantKey("capability", characterId, capabilityId);
        exactGrant(input.budget, key, capability.capability, (grant) =>
          grant.kind === "capability" ? grant.capability : undefined,
        path);
        consume(ledger, key, 1, path);
      } else if (capability.kind === "adjust_rank") {
        const amount = proposedInteger(capability.amount, `${path}.amount`);
        if (amount > 0) consume(
          ledger,
          amountGrantKey("capability_rank", characterId, String(capability.capabilityId ?? "")),
          amount,
          path,
        );
      }
    }
  }

  for (const [index, resource] of records(proposal.sharedResourceChanges, "proposed.sharedResourceChanges").entries()) {
    const path = `proposed.sharedResourceChanges[${index}]`;
    if (resource.kind === "add") {
      const pool = record(resource.pool, `${path}.pool`);
      const key = amountGrantKey("shared_resource_add", String(pool.id ?? ""));
      exactGrant(input.budget, key, resource.pool, (grant) =>
        grant.kind === "shared_resource_add" ? grant.pool : undefined,
      path);
      consume(ledger, key, 1, path);
    } else if (resource.kind === "adjust") {
      const amount = proposedInteger(resource.amount, `${path}.amount`);
      if (amount > 0) consume(
        ledger,
        amountGrantKey("shared_resource", String(resource.poolId ?? "")),
        amount,
        path,
      );
    }
  }

  for (const [index, companion] of records(proposal.companionChanges, "proposed.companionChanges").entries()) {
    const path = `proposed.companionChanges[${index}]`;
    if (companion.kind === "add") {
      const value = record(companion.companion, `${path}.companion`);
      const key = amountGrantKey("companion", String(value.id ?? ""));
      exactGrant(input.budget, key, companion.companion, (grant) =>
        grant.kind === "companion" ? grant.companion : undefined,
      path);
      consume(ledger, key, 1, path);
    } else if (companion.kind === "update") {
      if (companion.loyaltyChange !== undefined) {
        const amount = proposedInteger(companion.loyaltyChange, `${path}.loyaltyChange`);
        if (amount > 0) consume(
          ledger,
          amountGrantKey("companion_loyalty", String(companion.companionId ?? "")),
          amount,
          path,
        );
      }
      const existing = input.state.companions.find((entry) => entry.id === companion.companionId);
      if (companion.status === "present" && existing?.status !== "present") {
        fail("CAMPAIGN_RPG_REWARD_NOT_AUTHORIZED", `${path}.status cannot restore a companion without an exact server grant.`);
      }
    }
  }

  for (const [index, reputation] of records(proposal.reputationChanges, "proposed.reputationChanges").entries()) {
    const path = `proposed.reputationChanges[${index}]`;
    if (reputation.kind === "add") {
      const value = record(reputation.reputation, `${path}.reputation`);
      const targetId = String(value.targetId ?? "");
      if (Number(value.score) > 0) {
        const key = amountGrantKey("reputation_add", targetId);
        exactGrant(input.budget, key, reputation.reputation, (grant) =>
          grant.kind === "reputation_add" ? grant.reputation : undefined,
        path);
        consume(ledger, key, 1, path);
      }
    } else if (reputation.kind === "adjust") {
      const amount = proposedInteger(reputation.amount, `${path}.amount`);
      if (amount > 0) consume(
        ledger,
        amountGrantKey("reputation", String(reputation.targetId ?? "")),
        amount,
        path,
      );
    } else if (reputation.kind === "remove") {
      const existing = input.state.reputations.find((entry) => entry.targetId === reputation.targetId);
      if (existing && existing.score < 0) {
        fail("CAMPAIGN_RPG_REWARD_NOT_AUTHORIZED", `${path} cannot erase negative reputation as an alternate reward.`);
      }
    }
  }

  for (const [index, objective] of records(proposal.objectiveChanges, "proposed.objectiveChanges").entries()) {
    const path = `proposed.objectiveChanges[${index}]`;
    if (objective.kind === "progress") {
      const amount = proposedInteger(objective.amount, `${path}.amount`);
      if (amount > 0) consume(
        ledger,
        amountGrantKey("objective_progress", String(objective.objectiveId ?? "")),
        amount,
        path,
      );
    } else if (objective.kind === "add") {
      fail("CAMPAIGN_RPG_REWARD_NOT_AUTHORIZED", `${path} cannot create an objective through a reward proposal.`);
    } else if (objective.kind === "status") {
      const current = input.state.objectives.find((entry) => entry.id === objective.objectiveId);
      const reopensClosed =
        current && ["failed", "abandoned", "completed"].includes(current.status) &&
        ["pending", "active"].includes(String(objective.status));
      if (objective.status === "completed" || reopensClosed) {
        fail(
          "CAMPAIGN_RPG_REWARD_NOT_AUTHORIZED",
          `${path} cannot bypass measured objective progress with a status change.`,
        );
      }
    }
  }

  return deepFreeze(cloneJson(proposal) as CampaignRpgRewardProposal);
}

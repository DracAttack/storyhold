import {
  applyCampaignRpgStateDelta,
  type CampaignRpgState,
  type CampaignRpgStateDelta,
} from "./campaignRpgState";
import type { CampaignOutcome } from "./causalEngine";

type JsonRecord = Record<string, unknown>;

const PROPOSAL_KEYS = new Set([
  "causalBasis",
  "activeCharacterId",
  "location",
  "characterChanges",
  "sharedResourceChanges",
  "companionChanges",
  "reputationChanges",
  "objectiveChanges",
]);

export class CampaignRpgTurnDeltaError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CampaignRpgTurnDeltaError";
  }
}

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CampaignRpgTurnDeltaError(
      "INVALID_RPG_STATE_CHANGE",
      "The proposed RPG state change must be an object.",
    );
  }
  return value as JsonRecord;
}

function normalizedText(value: unknown, maximum = 1_000): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\u0000/gu, "").replace(/\s+/gu, " ").trim().slice(0, maximum)
    : "";
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => normalizedText(entry)).filter(Boolean).slice(0, 24);
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is JsonRecord =>
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
}

function hasSubstantiveChange(proposal: JsonRecord): boolean {
  if (proposal.activeCharacterId !== undefined || proposal.location !== undefined) return true;
  return [
    "characterChanges",
    "sharedResourceChanges",
    "companionChanges",
    "reputationChanges",
    "objectiveChanges",
  ].some((key) => Array.isArray(proposal[key]) && proposal[key].length > 0);
}

function failureRewardPaths(proposal: JsonRecord): string[] {
  const paths: string[] = [];
  for (const [characterIndex, character] of records(proposal.characterChanges).entries()) {
    if (Number(character.vitalityChange) > 0) paths.push(`characterChanges[${characterIndex}].vitalityChange`);
    if (Number(character.stressChange) < 0) paths.push(`characterChanges[${characterIndex}].stressChange`);
    if (Array.isArray(character.removeHarmIds) && character.removeHarmIds.length) {
      paths.push(`characterChanges[${characterIndex}].removeHarmIds`);
    }
    if (Array.isArray(character.removeConditionIds) && character.removeConditionIds.length) {
      paths.push(`characterChanges[${characterIndex}].removeConditionIds`);
    }
    for (const [index, change] of records(character.inventoryChanges).entries()) {
      if (change.kind === "add" || (change.kind === "quantity" && Number(change.amount) > 0)) {
        paths.push(`characterChanges[${characterIndex}].inventoryChanges[${index}]`);
      }
    }
    for (const [index, change] of records(character.capabilityChanges).entries()) {
      if (change.kind === "add" || (change.kind === "adjust_rank" && Number(change.amount) > 0)) {
        paths.push(`characterChanges[${characterIndex}].capabilityChanges[${index}]`);
      }
    }
    for (const [index, change] of records(character.resourceChanges).entries()) {
      if (change.kind === "add" || (change.kind === "adjust" && Number(change.amount) > 0)) {
        paths.push(`characterChanges[${characterIndex}].resourceChanges[${index}]`);
      }
    }
  }
  for (const [index, change] of records(proposal.sharedResourceChanges).entries()) {
    if (change.kind === "add" || (change.kind === "adjust" && Number(change.amount) > 0)) {
      paths.push(`sharedResourceChanges[${index}]`);
    }
  }
  for (const [index, change] of records(proposal.companionChanges).entries()) {
    if (change.kind === "add" || (change.kind === "update" && Number(change.loyaltyChange) > 0)) {
      paths.push(`companionChanges[${index}]`);
    }
  }
  for (const [index, change] of records(proposal.reputationChanges).entries()) {
    if (
      (change.kind === "add" && Number(record(change.reputation).score) > 0) ||
      (change.kind === "adjust" && Number(change.amount) > 0)
    ) {
      paths.push(`reputationChanges[${index}]`);
    }
  }
  for (const [index, change] of records(proposal.objectiveChanges).entries()) {
    if (
      (change.kind === "progress" && Number(change.amount) > 0) ||
      (change.kind === "status" && change.status === "completed")
    ) {
      paths.push(`objectiveChanges[${index}]`);
    }
  }
  return paths;
}

function proposedDeltaFields(proposal: JsonRecord): Partial<CampaignRpgStateDelta> {
  return {
    ...(proposal.activeCharacterId !== undefined
      ? { activeCharacterId: proposal.activeCharacterId as string }
      : {}),
    ...(proposal.location !== undefined
      ? { location: proposal.location as CampaignRpgStateDelta["location"] }
      : {}),
    ...(proposal.characterChanges !== undefined
      ? { characterChanges: proposal.characterChanges as CampaignRpgStateDelta["characterChanges"] }
      : {}),
    ...(proposal.sharedResourceChanges !== undefined
      ? { sharedResourceChanges: proposal.sharedResourceChanges as CampaignRpgStateDelta["sharedResourceChanges"] }
      : {}),
    ...(proposal.companionChanges !== undefined
      ? { companionChanges: proposal.companionChanges as CampaignRpgStateDelta["companionChanges"] }
      : {}),
    ...(proposal.reputationChanges !== undefined
      ? { reputationChanges: proposal.reputationChanges as CampaignRpgStateDelta["reputationChanges"] }
      : {}),
    ...(proposal.objectiveChanges !== undefined
      ? { objectiveChanges: proposal.objectiveChanges as CampaignRpgStateDelta["objectiveChanges"] }
      : {}),
  };
}

/**
 * Bind a Director proposal to the authoritative state and accepted turn. The
 * Director can propose typed consequences, but cannot choose state versions,
 * fortune, check modifiers, or whether a turn is accepted.
 */
export function buildAcceptedCampaignRpgDelta(input: {
  state: CampaignRpgState;
  proposed: unknown;
  outcome: CampaignOutcome;
  advancementSource?: "none" | "player_action" | "matured_clock" | "established_state";
  reason: string;
  allowedCausalBasis: readonly string[];
}): CampaignRpgStateDelta {
  const reason = normalizedText(input.reason);
  if (!reason) {
    throw new CampaignRpgTurnDeltaError("MISSING_RPG_DELTA_REASON", "An accepted turn needs a state reason.");
  }

  if (input.proposed === null || input.proposed === undefined) {
    return {
      expectedStateVersion: input.state.stateVersion,
      reason,
      turnAccepted: true,
    };
  }

  const proposal = record(input.proposed);
  const unexpected = Object.keys(proposal).find((key) => !PROPOSAL_KEYS.has(key));
  if (unexpected) {
    throw new CampaignRpgTurnDeltaError(
      "FORBIDDEN_RPG_STATE_FIELD",
      `The Director cannot set RPG state field ${unexpected}.`,
    );
  }
  const substantive = hasSubstantiveChange(proposal);
  const causalBasis = textList(proposal.causalBasis);
  if (substantive && causalBasis.length === 0) {
    throw new CampaignRpgTurnDeltaError(
      "MISSING_RPG_CAUSAL_BASIS",
      "A tracked RPG state change requires a stated cause.",
    );
  }
  const allowed = new Set(input.allowedCausalBasis.map((entry) => normalizedText(entry)).filter(Boolean));
  const unsupportedCause = causalBasis.find((entry) => !allowed.has(entry));
  if (unsupportedCause) {
    throw new CampaignRpgTurnDeltaError(
      "UNSUPPORTED_RPG_CAUSAL_BASIS",
      "A tracked RPG state change cites a cause that is not part of the accepted resolution.",
    );
  }

  const independentWorldCause =
    input.advancementSource === "matured_clock" ||
    input.advancementSource === "established_state";
  if (["failure", "none", "uncertain"].includes(input.outcome) && !independentWorldCause) {
    const rewards = failureRewardPaths(proposal);
    if (rewards.length) {
      throw new CampaignRpgTurnDeltaError(
        "OUTCOME_RPG_STATE_MISMATCH",
        `The failed or unresolved action cannot grant: ${rewards.join(", ")}.`,
      );
    }
  }

  const delta: CampaignRpgStateDelta = {
    expectedStateVersion: input.state.stateVersion,
    reason,
    turnAccepted: true,
    ...proposedDeltaFields(proposal),
  };
  // Dry-run the same authoritative validator persistence uses. No partially
  // valid proposal reaches the accepted-turn transaction.
  applyCampaignRpgStateDelta(input.state, delta);
  return delta;
}

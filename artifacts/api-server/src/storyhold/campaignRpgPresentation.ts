import type {
  CampaignResolutionMode,
  CampaignRpgState,
  CampaignSeed,
  CharacterRpgState,
  RpgInventoryItem,
} from "./campaignRpgState";

export type CampaignRpgPresentationMode =
  | "story-first"
  | "light-rules"
  | "tactical"
  | "custom";

export type CampaignRpgStateViewModel = {
  mode: CampaignRpgPresentationMode;
  visibility: {
    showNumbers: boolean;
    showBreakdowns: boolean;
  };
  objectives: Array<{
    id: string;
    title: string;
    status?: "current" | "at-risk";
    summary?: string;
    progress?: { current: number; maximum: number } | null;
  }>;
  location: { name: string; summary?: string } | null;
  vitality: {
    state: string;
    current?: number;
    maximum?: number;
    note?: string;
  } | null;
  stress: {
    state: string;
    current?: number;
    maximum?: number;
    note?: string;
  } | null;
  conditions: Array<{
    id: string;
    name: string;
    summary?: string;
    severity?: string;
  }>;
  capabilities: Array<{
    id: string;
    name: string;
    summary?: string;
    rating?: number;
  }>;
  equippedItems: Array<{
    id: string;
    name: string;
    summary?: string;
    quantity?: number;
  }>;
  inventory: Array<{
    id: string;
    name: string;
    summary?: string;
    quantity?: number;
  }>;
  companions: Array<{
    id: string;
    name: string;
    state?: string;
    note?: string;
  }>;
  reputation: Array<{
    id: string;
    name: string;
    standing: string;
    score?: number;
  }>;
};

function modeName(mode: CampaignResolutionMode): CampaignRpgPresentationMode {
  if (mode === "story_first") return "story-first";
  if (mode === "light_rules") return "light-rules";
  return mode;
}

function ratio(current: number, maximum: number): number {
  return maximum > 0 ? current / maximum : 0;
}

function vitalityState(character: CharacterRpgState): string {
  const value = ratio(character.vitality.current, character.vitality.maximum);
  if (character.vitality.current <= 0) return "Down";
  if (value <= 0.25) return "Critical";
  if (value <= 0.6) return "Hurt";
  return "Steady";
}

function stressState(character: CharacterRpgState): string {
  const value = ratio(character.stress.current, character.stress.maximum);
  if (value >= 0.8) return "Overwhelmed";
  if (value >= 0.45) return "Strained";
  return "Composed";
}

function reputationStanding(score: number): string {
  if (score <= -75) return "Hostile";
  if (score <= -25) return "Unfriendly";
  if (score < 25) return "Uncertain";
  if (score < 75) return "Favorable";
  return "Trusted";
}

function severityLabel(modifier: number): string | undefined {
  const magnitude = Math.abs(modifier);
  if (magnitude >= 8) return "Severe";
  if (magnitude >= 4) return "Significant";
  if (magnitude > 0) return "Minor";
  return undefined;
}

function itemView(item: RpgInventoryItem, showNumbers: boolean) {
  return {
    id: item.id,
    name: item.name,
    ...(item.description ? { summary: item.description } : {}),
    ...(showNumbers ? { quantity: item.quantity } : {}),
  };
}

/**
 * Convert the authoritative runtime state into a deliberately player-safe
 * payload. The browser never receives seed facts, hidden checks, stat blocks,
 * or mechanical numbers that the locked presentation mode does not show.
 */
export function projectCampaignRpgStateForPlayer(input: {
  seed: CampaignSeed;
  state: CampaignRpgState;
}): CampaignRpgStateViewModel {
  const { seed, state } = input;
  if (state.seedId !== seed.seedId) {
    throw new Error("Campaign RPG state does not belong to its locked seed.");
  }
  const character = state.characters.find(
    (candidate) => candidate.characterId === state.activeCharacterId,
  );
  if (!character) {
    throw new Error("Campaign RPG state has no active player character.");
  }

  const mode = modeName(seed.rules.resolutionMode);
  const showNumbers =
    mode === "light-rules" ||
    mode === "tactical" ||
    (mode === "custom" && seed.rules.customCheckVisibility.showNumbers);
  const showBreakdowns =
    showNumbers &&
    (mode === "tactical" ||
      (mode === "custom" && seed.rules.customCheckVisibility.showBreakdown));
  const equippedIds = new Set(character.equipment.map((entry) => entry.itemId));
  const itemById = new Map(character.inventory.map((item) => [item.id, item]));

  return {
    mode,
    visibility: { showNumbers, showBreakdowns },
    objectives: state.objectives
      .filter((objective) => objective.status === "active" || objective.status === "pending")
      .map((objective) => ({
        id: objective.id,
        title: objective.title,
        status: objective.status === "active" ? "current" : undefined,
        ...(objective.description ? { summary: objective.description } : {}),
        ...(showNumbers
          ? { progress: { current: objective.progress, maximum: objective.target } }
          : {}),
      })),
    location: state.location.name
      ? {
          name: state.location.name,
          ...(state.location.zone ? { summary: state.location.zone } : {}),
        }
      : null,
    vitality: {
      state: vitalityState(character),
      ...(showNumbers
        ? {
            current: character.vitality.current,
            maximum: character.vitality.maximum,
          }
        : {}),
      ...(showNumbers && character.harms.length
        ? { note: `${character.harms.length} active ${character.harms.length === 1 ? "injury" : "injuries"}` }
        : {}),
    },
    stress: {
      state: stressState(character),
      ...(showNumbers
        ? { current: character.stress.current, maximum: character.stress.maximum }
        : {}),
    },
    conditions: [
      ...character.harms.map((harm) => ({
        id: harm.id,
        name: harm.name,
        ...(harm.description ? { summary: harm.description } : {}),
        severity: ["Minor", "Moderate", "Serious", "Severe", "Critical"][harm.severity - 1],
      })),
      ...character.conditions.map((condition) => {
        const strongestEffect = condition.checkEffects.reduce(
          (strongest, effect) =>
            Math.abs(effect.modifier) > Math.abs(strongest) ? effect.modifier : strongest,
          0,
        );
        return {
          id: condition.id,
          name: condition.name,
          ...(condition.description ? { summary: condition.description } : {}),
          ...(severityLabel(strongestEffect)
            ? { severity: severityLabel(strongestEffect) }
            : {}),
        };
      }),
    ],
    capabilities: character.capabilities.map((capability) => ({
      id: capability.id,
      name: capability.name,
      ...(capability.description ? { summary: capability.description } : {}),
      ...(showNumbers ? { rating: capability.rank } : {}),
    })),
    equippedItems: character.equipment.flatMap((assignment) => {
      const item = itemById.get(assignment.itemId);
      return item ? [itemView(item, showNumbers)] : [];
    }),
    inventory: character.inventory
      .filter((item) => !equippedIds.has(item.id))
      .map((item) => itemView(item, showNumbers)),
    companions: state.companions.map((companion) => ({
      id: companion.id,
      name: companion.name,
      state: companion.status,
      ...(companion.status === "present" ? {} : { note: "Not currently with you" }),
    })),
    reputation: state.reputations.map((reputation) => ({
      id: reputation.targetId,
      name: reputation.targetName,
      standing: reputationStanding(reputation.score),
      ...(showNumbers ? { score: reputation.score } : {}),
    })),
  };
}

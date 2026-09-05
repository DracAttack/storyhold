import {
  resolveDeterministicOutcome,
  type DeterministicOutcome,
  type OutcomeCertainty,
  type StableFortune,
} from "./causalEngine";
import { PREMIUM_STAT_NAMES } from "./premiumStatCandidates";

/**
 * The same seven ability names used by Storyhold dossiers. A campaign can copy
 * reviewed dossier estimates into a seed without translating to a second stat
 * vocabulary.
 */
export const STORYHOLD_STAT_NAMES = PREMIUM_STAT_NAMES;
export type StoryholdStatName = (typeof STORYHOLD_STAT_NAMES)[number];

export type CampaignOrigin =
  | {
      readonly kind: "imported";
      readonly worldId: string;
      readonly editionId: string;
      /** The manuscript/timeline boundary that the campaign is allowed to know. */
      readonly canonAnchor: string | null;
    }
  | {
      readonly kind: "original";
      readonly worldId: string | null;
      readonly generatorVersion: string | null;
    };

export type CampaignResolutionMode =
  | "story_first"
  | "light_rules"
  | "tactical"
  | "custom";

export type CustomCheckVisibility = {
  readonly showOutcome: boolean;
  readonly showBand: boolean;
  readonly showDifficulty: boolean;
  readonly showFactors: boolean;
  readonly showNumbers: boolean;
  readonly showBreakdown: boolean;
  readonly showD20: boolean;
};

export type CampaignRules = {
  readonly resolutionMode: CampaignResolutionMode;
  readonly customCheckVisibility: CustomCheckVisibility;
};

export type CampaignSeedFact = {
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly provenance: "manuscript" | "owner" | "generated";
  /** Seed facts are a frozen starting boundary, never mutable campaign state. */
  readonly locked: true;
};

export type StoryholdStatBlock = Readonly<Record<StoryholdStatName, number>>;

export type RpgPool = {
  readonly id: string;
  readonly name: string;
  readonly current: number;
  readonly maximum: number | null;
};

export type RpgCheckEffect = {
  readonly id: string;
  readonly label: string;
  readonly modifier: number;
  /** An empty list means the effect is not restricted by this dimension. */
  readonly abilities: readonly StoryholdStatName[];
  /** Capability IDs, not display names. */
  readonly capabilities: readonly string[];
};

export type RpgHarm = {
  readonly id: string;
  readonly name: string;
  readonly severity: 1 | 2 | 3 | 4 | 5;
  readonly description: string;
};

export type RpgCondition = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly checkEffects: readonly RpgCheckEffect[];
};

export type RpgCapability = {
  readonly id: string;
  readonly name: string;
  /** Zero is familiarity; five is extraordinary mastery. */
  readonly rank: 0 | 1 | 2 | 3 | 4 | 5;
  readonly description: string;
};

export type RpgInventoryItem = {
  readonly id: string;
  readonly name: string;
  readonly quantity: number;
  readonly description: string;
  readonly tags: readonly string[];
  readonly checkEffects: readonly RpgCheckEffect[];
};

export type RpgEquipmentAssignment = {
  readonly slot: string;
  readonly itemId: string;
};

export type RpgLocation = {
  readonly entityId: string | null;
  readonly name: string;
  readonly zone: string | null;
};

export type CharacterRpgState = {
  readonly characterId: string;
  readonly name: string;
  readonly stats: StoryholdStatBlock;
  readonly vitality: {
    readonly current: number;
    readonly maximum: number;
  };
  readonly harms: readonly RpgHarm[];
  readonly stress: {
    readonly current: number;
    readonly maximum: number;
  };
  readonly conditions: readonly RpgCondition[];
  readonly resources: readonly RpgPool[];
  readonly inventory: readonly RpgInventoryItem[];
  readonly equipment: readonly RpgEquipmentAssignment[];
  readonly capabilities: readonly RpgCapability[];
};

export type RpgCompanion = {
  readonly id: string;
  readonly entityId: string | null;
  readonly name: string;
  readonly status: "present" | "separated" | "missing" | "departed";
  readonly loyalty: number;
};

export type RpgReputation = {
  readonly targetId: string;
  readonly targetName: string;
  /** -100 is sworn hostility; 100 is unwavering trust. */
  readonly score: number;
};

export type RpgObjective = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: "pending" | "active" | "completed" | "failed" | "abandoned";
  readonly progress: number;
  readonly target: number;
};

export type CampaignRpgInitialState = {
  readonly activeCharacterId: string;
  readonly characters: readonly CharacterRpgState[];
  readonly location: RpgLocation;
  readonly companions: readonly RpgCompanion[];
  readonly reputations: readonly RpgReputation[];
  readonly objectives: readonly RpgObjective[];
  readonly sharedResources: readonly RpgPool[];
};

/**
 * One launch contract for both Storyhold entrances. Imported worlds identify a
 * manuscript boundary; original adventures identify the generator that made
 * their starting canon. Everything in this value is immutable after launch.
 */
export type CampaignSeed = {
  readonly schemaVersion: 1;
  readonly seedId: string;
  readonly origin: CampaignOrigin;
  readonly world: {
    readonly name: string;
    readonly premise: string;
    readonly facts: readonly CampaignSeedFact[];
  };
  readonly rules: CampaignRules;
  readonly initialState: CampaignRpgInitialState;
};

export type CampaignSeedDraft = {
  seedId: string;
  origin:
    | {
        kind: "imported";
        worldId: string;
        editionId: string;
        canonAnchor?: string | null;
      }
    | {
        kind: "original";
        worldId?: string | null;
        generatorVersion?: string | null;
      };
  world: {
    name: string;
    premise?: string;
    facts?: ReadonlyArray<{
      id: string;
      subject: string;
      predicate: string;
      object: string;
      provenance: CampaignSeedFact["provenance"];
      locked?: boolean;
    }>;
  };
  rules?: {
    resolutionMode?: CampaignResolutionMode;
    customCheckVisibility?: Partial<CustomCheckVisibility>;
  };
  initialState: {
    activeCharacterId: string;
    characters: ReadonlyArray<{
      characterId: string;
      name: string;
      stats?: Partial<Record<StoryholdStatName, number>>;
      vitality?: { current: number; maximum: number };
      harms?: readonly RpgHarm[];
      stress?: { current: number; maximum: number };
      conditions?: readonly RpgCondition[];
      resources?: readonly RpgPool[];
      inventory?: readonly RpgInventoryItem[];
      equipment?: readonly RpgEquipmentAssignment[];
      capabilities?: readonly RpgCapability[];
    }>;
    location: RpgLocation;
    companions?: readonly RpgCompanion[];
    reputations?: readonly RpgReputation[];
    objectives?: readonly RpgObjective[];
    sharedResources?: readonly RpgPool[];
  };
};

/** Runtime state changes over time, but every transition returns a new value. */
export type CampaignRpgState = CampaignRpgInitialState & {
  readonly schemaVersion: 1;
  readonly seedId: string;
  readonly stateVersion: number;
};

export type RpgPoolChange =
  | { readonly kind: "add"; readonly pool: RpgPool }
  | { readonly kind: "adjust"; readonly poolId: string; readonly amount: number }
  | { readonly kind: "remove"; readonly poolId: string };

export type RpgInventoryChange =
  | { readonly kind: "add"; readonly item: RpgInventoryItem }
  | { readonly kind: "quantity"; readonly itemId: string; readonly amount: number }
  | { readonly kind: "remove"; readonly itemId: string }
  | { readonly kind: "equip"; readonly itemId: string; readonly slot: string }
  | { readonly kind: "unequip"; readonly slot: string };

export type RpgCapabilityChange =
  | { readonly kind: "add"; readonly capability: RpgCapability }
  | { readonly kind: "adjust_rank"; readonly capabilityId: string; readonly amount: number }
  | { readonly kind: "remove"; readonly capabilityId: string };

export type CharacterRpgStateDelta = {
  readonly characterId: string;
  readonly vitalityChange?: number;
  readonly stressChange?: number;
  readonly addHarms?: readonly RpgHarm[];
  readonly removeHarmIds?: readonly string[];
  readonly addConditions?: readonly RpgCondition[];
  readonly removeConditionIds?: readonly string[];
  readonly resourceChanges?: readonly RpgPoolChange[];
  readonly inventoryChanges?: readonly RpgInventoryChange[];
  readonly capabilityChanges?: readonly RpgCapabilityChange[];
};

export type RpgCompanionChange =
  | { readonly kind: "add"; readonly companion: RpgCompanion }
  | {
      readonly kind: "update";
      readonly companionId: string;
      readonly status?: RpgCompanion["status"];
      readonly loyaltyChange?: number;
    }
  | { readonly kind: "remove"; readonly companionId: string };

export type RpgReputationChange =
  | { readonly kind: "add"; readonly reputation: RpgReputation }
  | { readonly kind: "adjust"; readonly targetId: string; readonly amount: number }
  | { readonly kind: "remove"; readonly targetId: string };

export type RpgObjectiveChange =
  | { readonly kind: "add"; readonly objective: RpgObjective }
  | { readonly kind: "progress"; readonly objectiveId: string; readonly amount: number }
  | {
      readonly kind: "status";
      readonly objectiveId: string;
      readonly status: RpgObjective["status"];
    };

export type CampaignRpgStateDelta = {
  readonly expectedStateVersion: number;
  readonly reason: string;
  /**
   * Server-owned turn boundary. It keeps branchable RPG history aligned with
   * accepted campaign turns even when no tracked value changed.
   */
  readonly turnAccepted?: true;
  readonly activeCharacterId?: string;
  readonly location?: RpgLocation;
  readonly characterChanges?: readonly CharacterRpgStateDelta[];
  readonly sharedResourceChanges?: readonly RpgPoolChange[];
  readonly companionChanges?: readonly RpgCompanionChange[];
  readonly reputationChanges?: readonly RpgReputationChange[];
  readonly objectiveChanges?: readonly RpgObjectiveChange[];
};

export type CampaignRpgValidationIssue = {
  readonly code:
    | "INVALID_VALUE"
    | "DUPLICATE_ID"
    | "MISSING_REFERENCE"
    | "STATE_VERSION_MISMATCH"
    | "INVARIANT_VIOLATION"
    | "UNKNOWN_FIELD"
    | "EMPTY_DELTA";
  readonly path: string;
  readonly message: string;
};

export class CampaignRpgValidationError extends Error {
  readonly issues: readonly CampaignRpgValidationIssue[];

  constructor(issue: CampaignRpgValidationIssue | readonly CampaignRpgValidationIssue[]) {
    const issues: readonly CampaignRpgValidationIssue[] = Array.isArray(issue)
      ? issue
      : [issue as CampaignRpgValidationIssue];
    super(issues.map((item) => `${item.path}: ${item.message}`).join("; "));
    this.name = "CampaignRpgValidationError";
    this.issues = issues;
  }
}

function fail(
  code: CampaignRpgValidationIssue["code"],
  path: string,
  message: string,
): never {
  throw new CampaignRpgValidationError({ code, path, message });
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_VALUE", path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function onlyKeys(
  value: Record<string, unknown>,
  permitted: readonly string[],
  path: string,
): void {
  const unknown = Object.keys(value).find((key) => !permitted.includes(key));
  if (unknown) fail("UNKNOWN_FIELD", `${path}.${unknown}`, "is not permitted");
}

function stringValue(
  value: unknown,
  path: string,
  maximum: number,
  options: { optional?: boolean; lowercase?: boolean } = {},
): string {
  if (value === undefined && options.optional) return "";
  if (typeof value !== "string") fail("INVALID_VALUE", path, "must be a string");
  let result = value.normalize("NFKC").replace(/\u0000/gu, "").replace(/\s+/gu, " ").trim();
  if (options.lowercase) result = result.toLocaleLowerCase("en-US");
  if ((!result && !options.optional) || result.length > maximum) {
    fail("INVALID_VALUE", path, `must contain 1-${maximum} characters`);
  }
  return result;
}

function nullableString(value: unknown, path: string, maximum: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  return stringValue(value, path, maximum);
}

function integer(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
  fallback?: number,
): number {
  const candidate = value === undefined ? fallback : value;
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    fail("INVALID_VALUE", path, `must be an integer from ${minimum} through ${maximum}`);
  }
  return candidate;
}

function unique<T extends { readonly id: string }>(values: readonly T[], path: string): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value.id)) fail("DUPLICATE_ID", `${path}[${index}].id`, `duplicates ${value.id}`);
    seen.add(value.id);
  });
}

function uniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string,
  path: string,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const id = key(value);
    if (seen.has(id)) fail("DUPLICATE_ID", `${path}[${index}]`, `duplicates ${id}`);
    seen.add(id);
  });
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function statName(value: unknown, path: string): StoryholdStatName {
  if (!STORYHOLD_STAT_NAMES.includes(value as StoryholdStatName)) {
    fail("INVALID_VALUE", path, "must be a Storyhold stat name");
  }
  return value as StoryholdStatName;
}

function normalizeStats(value: unknown, path: string): StoryholdStatBlock {
  const input = value === undefined ? {} : object(value, path);
  onlyKeys(input, STORYHOLD_STAT_NAMES, path);
  return Object.fromEntries(
    STORYHOLD_STAT_NAMES.map((name) => [
      name,
      integer(input[name], `${path}.${name}`, 1, 20, 10),
    ]),
  ) as Record<StoryholdStatName, number>;
}

function normalizePool(value: unknown, path: string): RpgPool {
  const input = object(value, path);
  onlyKeys(input, ["id", "name", "current", "maximum"], path);
  const maximum = input.maximum === null || input.maximum === undefined
    ? null
    : integer(input.maximum, `${path}.maximum`, 0, 1_000_000);
  const current = integer(input.current, `${path}.current`, 0, 1_000_000, 0);
  if (maximum !== null && current > maximum) {
    fail("INVARIANT_VIOLATION", `${path}.current`, "cannot exceed maximum");
  }
  return {
    id: stringValue(input.id, `${path}.id`, 160),
    name: stringValue(input.name, `${path}.name`, 160),
    current,
    maximum,
  };
}

function normalizeCheckEffect(value: unknown, path: string): RpgCheckEffect {
  const input = object(value, path);
  onlyKeys(input, ["id", "label", "modifier", "abilities", "capabilities"], path);
  const abilities = Array.isArray(input.abilities)
    ? input.abilities.map((ability, index) => statName(ability, `${path}.abilities[${index}]`))
    : [];
  const capabilities = Array.isArray(input.capabilities)
    ? input.capabilities.map((capability, index) =>
        stringValue(capability, `${path}.capabilities[${index}]`, 160),
      )
    : [];
  if (new Set(abilities).size !== abilities.length) {
    fail("DUPLICATE_ID", `${path}.abilities`, "contains duplicate abilities");
  }
  if (new Set(capabilities).size !== capabilities.length) {
    fail("DUPLICATE_ID", `${path}.capabilities`, "contains duplicate capability IDs");
  }
  return {
    id: stringValue(input.id, `${path}.id`, 160),
    label: stringValue(input.label, `${path}.label`, 240),
    modifier: integer(input.modifier, `${path}.modifier`, -20, 20),
    abilities,
    capabilities,
  };
}

function normalizeEffects(value: unknown, path: string): readonly RpgCheckEffect[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("INVALID_VALUE", path, "must be an array");
  const effects = value.map((effect, index) => normalizeCheckEffect(effect, `${path}[${index}]`));
  unique(effects, path);
  return effects;
}

function normalizeHarm(value: unknown, path: string): RpgHarm {
  const input = object(value, path);
  onlyKeys(input, ["id", "name", "severity", "description"], path);
  return {
    id: stringValue(input.id, `${path}.id`, 160),
    name: stringValue(input.name, `${path}.name`, 160),
    severity: integer(input.severity, `${path}.severity`, 1, 5) as RpgHarm["severity"],
    description: stringValue(input.description, `${path}.description`, 1_000, { optional: true }),
  };
}

function normalizeCondition(value: unknown, path: string): RpgCondition {
  const input = object(value, path);
  onlyKeys(input, ["id", "name", "description", "checkEffects"], path);
  return {
    id: stringValue(input.id, `${path}.id`, 160),
    name: stringValue(input.name, `${path}.name`, 160),
    description: stringValue(input.description, `${path}.description`, 1_000, { optional: true }),
    checkEffects: normalizeEffects(input.checkEffects, `${path}.checkEffects`),
  };
}

function normalizeCapability(value: unknown, path: string): RpgCapability {
  const input = object(value, path);
  onlyKeys(input, ["id", "name", "rank", "description"], path);
  return {
    id: stringValue(input.id, `${path}.id`, 160),
    name: stringValue(input.name, `${path}.name`, 160),
    rank: integer(input.rank, `${path}.rank`, 0, 5, 0) as RpgCapability["rank"],
    description: stringValue(input.description, `${path}.description`, 1_000, { optional: true }),
  };
}

function normalizeItem(value: unknown, path: string): RpgInventoryItem {
  const input = object(value, path);
  onlyKeys(input, ["id", "name", "quantity", "description", "tags", "checkEffects"], path);
  const tags = Array.isArray(input.tags)
    ? input.tags.map((tag, index) => stringValue(tag, `${path}.tags[${index}]`, 80, { lowercase: true }))
    : [];
  if (new Set(tags).size !== tags.length) fail("DUPLICATE_ID", `${path}.tags`, "contains duplicates");
  return {
    id: stringValue(input.id, `${path}.id`, 160),
    name: stringValue(input.name, `${path}.name`, 160),
    quantity: integer(input.quantity, `${path}.quantity`, 1, 1_000_000, 1),
    description: stringValue(input.description, `${path}.description`, 1_000, { optional: true }),
    tags,
    checkEffects: normalizeEffects(input.checkEffects, `${path}.checkEffects`),
  };
}

function normalizeEquipment(value: unknown, path: string): RpgEquipmentAssignment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("INVALID_VALUE", path, "must be an array");
  const equipment = value.map((entry, index) => {
    const input = object(entry, `${path}[${index}]`);
    onlyKeys(input, ["slot", "itemId"], `${path}[${index}]`);
    return {
      slot: stringValue(input.slot, `${path}[${index}].slot`, 80, { lowercase: true }),
      itemId: stringValue(input.itemId, `${path}[${index}].itemId`, 160),
    };
  });
  uniqueBy(equipment, (entry) => entry.slot, path);
  uniqueBy(equipment, (entry) => entry.itemId, path);
  return equipment;
}

function normalizeLocation(value: unknown, path: string): RpgLocation {
  const input = object(value, path);
  onlyKeys(input, ["entityId", "name", "zone"], path);
  return {
    entityId: nullableString(input.entityId, `${path}.entityId`, 160),
    name: stringValue(input.name, `${path}.name`, 240),
    zone: nullableString(input.zone, `${path}.zone`, 240),
  };
}

function arrayOf<T>(
  value: unknown,
  path: string,
  normalize: (entry: unknown, path: string) => T,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("INVALID_VALUE", path, "must be an array");
  return value.map((entry, index) => normalize(entry, `${path}[${index}]`));
}

function normalizeCharacter(value: unknown, path: string): CharacterRpgState {
  const input = object(value, path);
  onlyKeys(
    input,
    [
      "characterId", "name", "stats", "vitality", "harms", "stress",
      "conditions", "resources", "inventory", "equipment", "capabilities",
    ],
    path,
  );
  const vitalityInput = input.vitality === undefined ? {} : object(input.vitality, `${path}.vitality`);
  onlyKeys(vitalityInput, ["current", "maximum"], `${path}.vitality`);
  const vitalityMaximum = integer(vitalityInput.maximum, `${path}.vitality.maximum`, 1, 1_000_000, 10);
  const vitalityCurrent = integer(
    vitalityInput.current,
    `${path}.vitality.current`,
    0,
    vitalityMaximum,
    vitalityMaximum,
  );
  const stressInput = input.stress === undefined ? {} : object(input.stress, `${path}.stress`);
  onlyKeys(stressInput, ["current", "maximum"], `${path}.stress`);
  const stressMaximum = integer(stressInput.maximum, `${path}.stress.maximum`, 1, 1_000_000, 10);
  const harms = arrayOf(input.harms, `${path}.harms`, normalizeHarm);
  const conditions = arrayOf(input.conditions, `${path}.conditions`, normalizeCondition);
  const resources = arrayOf(input.resources, `${path}.resources`, normalizePool);
  const inventory = arrayOf(input.inventory, `${path}.inventory`, normalizeItem);
  const equipment = normalizeEquipment(input.equipment, `${path}.equipment`);
  const capabilities = arrayOf(input.capabilities, `${path}.capabilities`, normalizeCapability);
  unique(harms, `${path}.harms`);
  unique(conditions, `${path}.conditions`);
  unique(resources, `${path}.resources`);
  unique(inventory, `${path}.inventory`);
  unique(capabilities, `${path}.capabilities`);
  const itemIds = new Set(inventory.map((item) => item.id));
  equipment.forEach((assignment, index) => {
    if (!itemIds.has(assignment.itemId)) {
      fail("MISSING_REFERENCE", `${path}.equipment[${index}].itemId`, "must reference owned inventory");
    }
  });
  return {
    characterId: stringValue(input.characterId, `${path}.characterId`, 160),
    name: stringValue(input.name, `${path}.name`, 160),
    stats: normalizeStats(input.stats, `${path}.stats`),
    vitality: { current: vitalityCurrent, maximum: vitalityMaximum },
    harms,
    stress: {
      current: integer(stressInput.current, `${path}.stress.current`, 0, stressMaximum, 0),
      maximum: stressMaximum,
    },
    conditions,
    resources,
    inventory,
    equipment,
    capabilities,
  };
}

function normalizeCompanion(value: unknown, path: string): RpgCompanion {
  const input = object(value, path);
  onlyKeys(input, ["id", "entityId", "name", "status", "loyalty"], path);
  const statuses = ["present", "separated", "missing", "departed"] as const;
  if (!statuses.includes(input.status as (typeof statuses)[number])) {
    fail("INVALID_VALUE", `${path}.status`, "is not a companion status");
  }
  return {
    id: stringValue(input.id, `${path}.id`, 160),
    entityId: nullableString(input.entityId, `${path}.entityId`, 160),
    name: stringValue(input.name, `${path}.name`, 160),
    status: input.status as RpgCompanion["status"],
    loyalty: integer(input.loyalty, `${path}.loyalty`, 0, 100, 50),
  };
}

function normalizeReputation(value: unknown, path: string): RpgReputation {
  const input = object(value, path);
  onlyKeys(input, ["targetId", "targetName", "score"], path);
  return {
    targetId: stringValue(input.targetId, `${path}.targetId`, 160),
    targetName: stringValue(input.targetName, `${path}.targetName`, 160),
    score: integer(input.score, `${path}.score`, -100, 100, 0),
  };
}

function normalizeObjective(value: unknown, path: string): RpgObjective {
  const input = object(value, path);
  onlyKeys(input, ["id", "title", "description", "status", "progress", "target"], path);
  const statuses = ["pending", "active", "completed", "failed", "abandoned"] as const;
  if (!statuses.includes(input.status as (typeof statuses)[number])) {
    fail("INVALID_VALUE", `${path}.status`, "is not an objective status");
  }
  const target = integer(input.target, `${path}.target`, 1, 1_000_000, 1);
  const progress = integer(input.progress, `${path}.progress`, 0, target, 0);
  const status = input.status as RpgObjective["status"];
  if (status === "completed" && progress !== target) {
    fail("INVARIANT_VIOLATION", `${path}.progress`, "must equal target when completed");
  }
  return {
    id: stringValue(input.id, `${path}.id`, 160),
    title: stringValue(input.title, `${path}.title`, 240),
    description: stringValue(input.description, `${path}.description`, 2_000, { optional: true }),
    status,
    progress,
    target,
  };
}

const DEFAULT_CUSTOM_VISIBILITY: CustomCheckVisibility = {
  showOutcome: true,
  showBand: true,
  showDifficulty: true,
  showFactors: true,
  showNumbers: false,
  showBreakdown: false,
  showD20: false,
};

function normalizeRules(value: unknown, path: string): CampaignRules {
  const input = value === undefined ? {} : object(value, path);
  onlyKeys(input, ["resolutionMode", "customCheckVisibility"], path);
  const modes = ["story_first", "light_rules", "tactical", "custom"] as const;
  const resolutionMode = input.resolutionMode ?? "story_first";
  if (!modes.includes(resolutionMode as CampaignResolutionMode)) {
    fail("INVALID_VALUE", `${path}.resolutionMode`, "is not a supported resolution mode");
  }
  const visibilityInput = input.customCheckVisibility === undefined
    ? {}
    : object(input.customCheckVisibility, `${path}.customCheckVisibility`);
  onlyKeys(visibilityInput, Object.keys(DEFAULT_CUSTOM_VISIBILITY), `${path}.customCheckVisibility`);
  const visibility = Object.fromEntries(
    Object.entries(DEFAULT_CUSTOM_VISIBILITY).map(([key, fallback]) => {
      const raw = visibilityInput[key];
      if (raw !== undefined && typeof raw !== "boolean") {
        fail("INVALID_VALUE", `${path}.customCheckVisibility.${key}`, "must be boolean");
      }
      return [key, raw ?? fallback];
    }),
  ) as CustomCheckVisibility;
  return { resolutionMode: resolutionMode as CampaignResolutionMode, customCheckVisibility: visibility };
}

function normalizeOrigin(value: unknown, path: string): CampaignOrigin {
  const input = object(value, path);
  const kind = input.kind;
  if (kind === "imported") {
    onlyKeys(input, ["kind", "worldId", "editionId", "canonAnchor"], path);
    return {
      kind,
      worldId: stringValue(input.worldId, `${path}.worldId`, 160),
      editionId: stringValue(input.editionId, `${path}.editionId`, 160),
      canonAnchor: nullableString(input.canonAnchor, `${path}.canonAnchor`, 240),
    };
  }
  if (kind === "original") {
    onlyKeys(input, ["kind", "worldId", "generatorVersion"], path);
    return {
      kind,
      worldId: nullableString(input.worldId, `${path}.worldId`, 160),
      generatorVersion: nullableString(input.generatorVersion, `${path}.generatorVersion`, 160),
    };
  }
  fail("INVALID_VALUE", `${path}.kind`, "must be imported or original");
}

function normalizeSeedFact(value: unknown, path: string): CampaignSeedFact {
  const input = object(value, path);
  onlyKeys(input, ["id", "subject", "predicate", "object", "provenance", "locked"], path);
  const provenances = ["manuscript", "owner", "generated"] as const;
  if (!provenances.includes(input.provenance as CampaignSeedFact["provenance"])) {
    fail("INVALID_VALUE", `${path}.provenance`, "is not a seed-fact provenance");
  }
  if (input.locked !== undefined && input.locked !== true) {
    fail("INVARIANT_VIOLATION", `${path}.locked`, "seed facts are always locked");
  }
  return {
    id: stringValue(input.id, `${path}.id`, 160),
    subject: stringValue(input.subject, `${path}.subject`, 500),
    predicate: stringValue(input.predicate, `${path}.predicate`, 240),
    object: stringValue(input.object, `${path}.object`, 1_000),
    provenance: input.provenance as CampaignSeedFact["provenance"],
    locked: true,
  };
}

function normalizeInitialState(value: unknown, path: string): CampaignRpgInitialState {
  const input = object(value, path);
  onlyKeys(
    input,
    ["activeCharacterId", "characters", "location", "companions", "reputations", "objectives", "sharedResources"],
    path,
  );
  const characters = arrayOf(input.characters, `${path}.characters`, normalizeCharacter);
  if (characters.length === 0) fail("INVALID_VALUE", `${path}.characters`, "must contain a character");
  uniqueBy(characters, (character) => character.characterId, `${path}.characters`);
  const activeCharacterId = stringValue(input.activeCharacterId, `${path}.activeCharacterId`, 160);
  if (!characters.some((character) => character.characterId === activeCharacterId)) {
    fail("MISSING_REFERENCE", `${path}.activeCharacterId`, "must reference a seeded character");
  }
  const companions = arrayOf(input.companions, `${path}.companions`, normalizeCompanion);
  const reputations = arrayOf(input.reputations, `${path}.reputations`, normalizeReputation);
  const objectives = arrayOf(input.objectives, `${path}.objectives`, normalizeObjective);
  const sharedResources = arrayOf(input.sharedResources, `${path}.sharedResources`, normalizePool);
  unique(companions, `${path}.companions`);
  uniqueBy(reputations, (item) => item.targetId, `${path}.reputations`);
  unique(objectives, `${path}.objectives`);
  unique(sharedResources, `${path}.sharedResources`);
  return {
    activeCharacterId,
    characters,
    location: normalizeLocation(input.location, `${path}.location`),
    companions,
    reputations,
    objectives,
    sharedResources,
  };
}

/** Validate, clone, normalize, and recursively freeze a campaign launch seed. */
export function normalizeCampaignSeed(value: unknown): CampaignSeed {
  const input = object(value, "seed");
  onlyKeys(input, ["schemaVersion", "seedId", "origin", "world", "rules", "initialState"], "seed");
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) {
    fail("INVALID_VALUE", "seed.schemaVersion", "must be 1");
  }
  const worldInput = object(input.world, "seed.world");
  onlyKeys(worldInput, ["name", "premise", "facts"], "seed.world");
  const facts = arrayOf(worldInput.facts, "seed.world.facts", normalizeSeedFact);
  unique(facts, "seed.world.facts");
  return deepFreeze({
    schemaVersion: 1,
    seedId: stringValue(input.seedId, "seed.seedId", 160),
    origin: normalizeOrigin(input.origin, "seed.origin"),
    world: {
      name: stringValue(worldInput.name, "seed.world.name", 240),
      premise: stringValue(worldInput.premise, "seed.world.premise", 4_000, { optional: true }),
      facts,
    },
    rules: normalizeRules(input.rules, "seed.rules"),
    initialState: normalizeInitialState(input.initialState, "seed.initialState"),
  });
}

/** Copy the seed's starting template into an independently evolving state. */
export function createInitialCampaignRpgState(seed: CampaignSeed): CampaignRpgState {
  const normalized = normalizeCampaignSeed(seed);
  return deepFreeze({
    schemaVersion: 1,
    seedId: normalized.seedId,
    stateVersion: 0,
    ...normalizeInitialState(normalized.initialState, "seed.initialState"),
  });
}

/** Normalize state loaded from persistence before resolving or applying a turn. */
export function normalizeCampaignRpgState(value: unknown): CampaignRpgState {
  const input = object(value, "state");
  onlyKeys(
    input,
    [
      "schemaVersion", "seedId", "stateVersion", "activeCharacterId", "characters",
      "location", "companions", "reputations", "objectives", "sharedResources",
    ],
    "state",
  );
  if (input.schemaVersion !== 1) fail("INVALID_VALUE", "state.schemaVersion", "must be 1");
  return deepFreeze({
    schemaVersion: 1,
    seedId: stringValue(input.seedId, "state.seedId", 160),
    stateVersion: integer(input.stateVersion, "state.stateVersion", 0, Number.MAX_SAFE_INTEGER),
    ...normalizeInitialState({
      activeCharacterId: input.activeCharacterId,
      characters: input.characters,
      location: input.location,
      companions: input.companions,
      reputations: input.reputations,
      objectives: input.objectives,
      sharedResources: input.sharedResources,
    }, "state"),
  });
}

function replaceAt<T>(values: readonly T[], index: number, value: T): T[] {
  return values.map((entry, entryIndex) => (entryIndex === index ? value : entry));
}

function applyPoolChanges(
  pools: readonly RpgPool[],
  changes: readonly RpgPoolChange[] | undefined,
  path: string,
): RpgPool[] {
  let result = [...pools];
  for (const [index, raw] of (changes ?? []).entries()) {
    const change = object(raw, `${path}[${index}]`);
    const kind = change.kind;
    if (kind === "add") {
      onlyKeys(change, ["kind", "pool"], `${path}[${index}]`);
      const pool = normalizePool(change.pool, `${path}[${index}].pool`);
      if (result.some((item) => item.id === pool.id)) fail("DUPLICATE_ID", `${path}[${index}].pool.id`, "already exists");
      result.push(pool);
    } else if (kind === "adjust") {
      onlyKeys(change, ["kind", "poolId", "amount"], `${path}[${index}]`);
      const poolId = stringValue(change.poolId, `${path}[${index}].poolId`, 160);
      const poolIndex = result.findIndex((item) => item.id === poolId);
      if (poolIndex < 0) fail("MISSING_REFERENCE", `${path}[${index}].poolId`, "does not exist");
      const amount = integer(change.amount, `${path}[${index}].amount`, -1_000_000, 1_000_000);
      const pool = result[poolIndex]!;
      const current = pool.current + amount;
      if (current < 0 || (pool.maximum !== null && current > pool.maximum)) {
        fail("INVARIANT_VIOLATION", `${path}[${index}].amount`, "would move the pool outside its bounds");
      }
      result = replaceAt(result, poolIndex, { ...pool, current });
    } else if (kind === "remove") {
      onlyKeys(change, ["kind", "poolId"], `${path}[${index}]`);
      const poolId = stringValue(change.poolId, `${path}[${index}].poolId`, 160);
      if (!result.some((item) => item.id === poolId)) fail("MISSING_REFERENCE", `${path}[${index}].poolId`, "does not exist");
      result = result.filter((item) => item.id !== poolId);
    } else {
      fail("INVALID_VALUE", `${path}[${index}].kind`, "is not a pool change");
    }
  }
  return result;
}

function applyInventoryChanges(
  character: CharacterRpgState,
  changes: readonly RpgInventoryChange[] | undefined,
  path: string,
): Pick<CharacterRpgState, "inventory" | "equipment"> {
  let inventory = [...character.inventory];
  let equipment = [...character.equipment];
  for (const [index, raw] of (changes ?? []).entries()) {
    const change = object(raw, `${path}[${index}]`);
    const kind = change.kind;
    if (kind === "add") {
      onlyKeys(change, ["kind", "item"], `${path}[${index}]`);
      const item = normalizeItem(change.item, `${path}[${index}].item`);
      if (inventory.some((entry) => entry.id === item.id)) fail("DUPLICATE_ID", `${path}[${index}].item.id`, "already exists");
      inventory.push(item);
    } else if (kind === "quantity") {
      onlyKeys(change, ["kind", "itemId", "amount"], `${path}[${index}]`);
      const itemId = stringValue(change.itemId, `${path}[${index}].itemId`, 160);
      const itemIndex = inventory.findIndex((item) => item.id === itemId);
      if (itemIndex < 0) fail("MISSING_REFERENCE", `${path}[${index}].itemId`, "does not exist");
      const amount = integer(change.amount, `${path}[${index}].amount`, -1_000_000, 1_000_000);
      const item = inventory[itemIndex]!;
      const quantity = item.quantity + amount;
      if (quantity < 1 || quantity > 1_000_000) {
        fail("INVARIANT_VIOLATION", `${path}[${index}].amount`, "would make quantity invalid; use remove at zero");
      }
      inventory = replaceAt(inventory, itemIndex, { ...item, quantity });
    } else if (kind === "remove") {
      onlyKeys(change, ["kind", "itemId"], `${path}[${index}]`);
      const itemId = stringValue(change.itemId, `${path}[${index}].itemId`, 160);
      if (!inventory.some((item) => item.id === itemId)) fail("MISSING_REFERENCE", `${path}[${index}].itemId`, "does not exist");
      if (equipment.some((entry) => entry.itemId === itemId)) {
        fail("INVARIANT_VIOLATION", `${path}[${index}].itemId`, "cannot remove an equipped item; unequip it first");
      }
      inventory = inventory.filter((item) => item.id !== itemId);
    } else if (kind === "equip") {
      onlyKeys(change, ["kind", "itemId", "slot"], `${path}[${index}]`);
      const itemId = stringValue(change.itemId, `${path}[${index}].itemId`, 160);
      const slot = stringValue(change.slot, `${path}[${index}].slot`, 80, { lowercase: true });
      if (!inventory.some((item) => item.id === itemId)) fail("MISSING_REFERENCE", `${path}[${index}].itemId`, "does not exist");
      if (equipment.some((entry) => entry.itemId === itemId && entry.slot !== slot)) {
        fail("INVARIANT_VIOLATION", `${path}[${index}].itemId`, "is already equipped in another slot");
      }
      equipment = [...equipment.filter((entry) => entry.slot !== slot && entry.itemId !== itemId), { slot, itemId }];
    } else if (kind === "unequip") {
      onlyKeys(change, ["kind", "slot"], `${path}[${index}]`);
      const slot = stringValue(change.slot, `${path}[${index}].slot`, 80, { lowercase: true });
      if (!equipment.some((entry) => entry.slot === slot)) fail("MISSING_REFERENCE", `${path}[${index}].slot`, "is not equipped");
      equipment = equipment.filter((entry) => entry.slot !== slot);
    } else {
      fail("INVALID_VALUE", `${path}[${index}].kind`, "is not an inventory change");
    }
  }
  return { inventory, equipment };
}

function applyCapabilityChanges(
  capabilities: readonly RpgCapability[],
  changes: readonly RpgCapabilityChange[] | undefined,
  path: string,
): RpgCapability[] {
  let result = [...capabilities];
  for (const [index, raw] of (changes ?? []).entries()) {
    const change = object(raw, `${path}[${index}]`);
    const kind = change.kind;
    if (kind === "add") {
      onlyKeys(change, ["kind", "capability"], `${path}[${index}]`);
      const capability = normalizeCapability(change.capability, `${path}[${index}].capability`);
      if (result.some((entry) => entry.id === capability.id)) fail("DUPLICATE_ID", `${path}[${index}].capability.id`, "already exists");
      result.push(capability);
    } else if (kind === "adjust_rank") {
      onlyKeys(change, ["kind", "capabilityId", "amount"], `${path}[${index}]`);
      const capabilityId = stringValue(change.capabilityId, `${path}[${index}].capabilityId`, 160);
      const capabilityIndex = result.findIndex((entry) => entry.id === capabilityId);
      if (capabilityIndex < 0) fail("MISSING_REFERENCE", `${path}[${index}].capabilityId`, "does not exist");
      const amount = integer(change.amount, `${path}[${index}].amount`, -5, 5);
      const capability = result[capabilityIndex]!;
      const rank = capability.rank + amount;
      if (rank < 0 || rank > 5) fail("INVARIANT_VIOLATION", `${path}[${index}].amount`, "would move rank outside 0-5");
      result = replaceAt(result, capabilityIndex, { ...capability, rank: rank as RpgCapability["rank"] });
    } else if (kind === "remove") {
      onlyKeys(change, ["kind", "capabilityId"], `${path}[${index}]`);
      const capabilityId = stringValue(change.capabilityId, `${path}[${index}].capabilityId`, 160);
      if (!result.some((entry) => entry.id === capabilityId)) fail("MISSING_REFERENCE", `${path}[${index}].capabilityId`, "does not exist");
      result = result.filter((entry) => entry.id !== capabilityId);
    } else {
      fail("INVALID_VALUE", `${path}[${index}].kind`, "is not a capability change");
    }
  }
  return result;
}

function applyCharacterChange(
  character: CharacterRpgState,
  raw: CharacterRpgStateDelta,
  path: string,
): CharacterRpgState {
  const change = object(raw, path);
  onlyKeys(
    change,
    [
      "characterId", "vitalityChange", "stressChange", "addHarms", "removeHarmIds",
      "addConditions", "removeConditionIds", "resourceChanges", "inventoryChanges",
      "capabilityChanges",
    ],
    path,
  );
  const vitalityChange = integer(change.vitalityChange, `${path}.vitalityChange`, -1_000_000, 1_000_000, 0);
  const stressChange = integer(change.stressChange, `${path}.stressChange`, -1_000_000, 1_000_000, 0);
  const vitalityCurrent = character.vitality.current + vitalityChange;
  const stressCurrent = character.stress.current + stressChange;
  if (vitalityCurrent < 0 || vitalityCurrent > character.vitality.maximum) {
    fail("INVARIANT_VIOLATION", `${path}.vitalityChange`, "would move vitality outside its bounds");
  }
  if (stressCurrent < 0 || stressCurrent > character.stress.maximum) {
    fail("INVARIANT_VIOLATION", `${path}.stressChange`, "would move stress outside its bounds");
  }

  let harms = [...character.harms];
  const removeHarmIds = Array.isArray(change.removeHarmIds)
    ? change.removeHarmIds.map((id, index) => stringValue(id, `${path}.removeHarmIds[${index}]`, 160))
    : [];
  for (const id of removeHarmIds) {
    if (!harms.some((harm) => harm.id === id)) fail("MISSING_REFERENCE", `${path}.removeHarmIds`, `${id} does not exist`);
    harms = harms.filter((harm) => harm.id !== id);
  }
  const addedHarms = arrayOf(change.addHarms, `${path}.addHarms`, normalizeHarm);
  for (const harm of addedHarms) {
    if (harms.some((entry) => entry.id === harm.id)) fail("DUPLICATE_ID", `${path}.addHarms`, `${harm.id} already exists`);
    harms.push(harm);
  }

  let conditions = [...character.conditions];
  const removeConditionIds = Array.isArray(change.removeConditionIds)
    ? change.removeConditionIds.map((id, index) => stringValue(id, `${path}.removeConditionIds[${index}]`, 160))
    : [];
  for (const id of removeConditionIds) {
    if (!conditions.some((condition) => condition.id === id)) fail("MISSING_REFERENCE", `${path}.removeConditionIds`, `${id} does not exist`);
    conditions = conditions.filter((condition) => condition.id !== id);
  }
  const addedConditions = arrayOf(change.addConditions, `${path}.addConditions`, normalizeCondition);
  for (const condition of addedConditions) {
    if (conditions.some((entry) => entry.id === condition.id)) fail("DUPLICATE_ID", `${path}.addConditions`, `${condition.id} already exists`);
    conditions.push(condition);
  }

  const inventory = applyInventoryChanges(
    character,
    change.inventoryChanges as readonly RpgInventoryChange[] | undefined,
    `${path}.inventoryChanges`,
  );
  return {
    ...character,
    vitality: { ...character.vitality, current: vitalityCurrent },
    stress: { ...character.stress, current: stressCurrent },
    harms,
    conditions,
    resources: applyPoolChanges(
      character.resources,
      change.resourceChanges as readonly RpgPoolChange[] | undefined,
      `${path}.resourceChanges`,
    ),
    ...inventory,
    capabilities: applyCapabilityChanges(
      character.capabilities,
      change.capabilityChanges as readonly RpgCapabilityChange[] | undefined,
      `${path}.capabilityChanges`,
    ),
  };
}

function applyCompanionChanges(
  companions: readonly RpgCompanion[],
  changes: readonly RpgCompanionChange[] | undefined,
  path: string,
): RpgCompanion[] {
  let result = [...companions];
  for (const [index, raw] of (changes ?? []).entries()) {
    const change = object(raw, `${path}[${index}]`);
    if (change.kind === "add") {
      onlyKeys(change, ["kind", "companion"], `${path}[${index}]`);
      const companion = normalizeCompanion(change.companion, `${path}[${index}].companion`);
      if (result.some((entry) => entry.id === companion.id)) fail("DUPLICATE_ID", `${path}[${index}].companion.id`, "already exists");
      result.push(companion);
    } else if (change.kind === "update") {
      onlyKeys(change, ["kind", "companionId", "status", "loyaltyChange"], `${path}[${index}]`);
      const companionId = stringValue(change.companionId, `${path}[${index}].companionId`, 160);
      const companionIndex = result.findIndex((entry) => entry.id === companionId);
      if (companionIndex < 0) fail("MISSING_REFERENCE", `${path}[${index}].companionId`, "does not exist");
      const companion = result[companionIndex]!;
      const status = change.status ?? companion.status;
      if (!["present", "separated", "missing", "departed"].includes(String(status))) {
        fail("INVALID_VALUE", `${path}[${index}].status`, "is not a companion status");
      }
      const loyalty = companion.loyalty + integer(
        change.loyaltyChange,
        `${path}[${index}].loyaltyChange`,
        -100,
        100,
        0,
      );
      if (loyalty < 0 || loyalty > 100) fail("INVARIANT_VIOLATION", `${path}[${index}].loyaltyChange`, "would move loyalty outside 0-100");
      result = replaceAt(result, companionIndex, { ...companion, status: status as RpgCompanion["status"], loyalty });
    } else if (change.kind === "remove") {
      onlyKeys(change, ["kind", "companionId"], `${path}[${index}]`);
      const companionId = stringValue(change.companionId, `${path}[${index}].companionId`, 160);
      if (!result.some((entry) => entry.id === companionId)) fail("MISSING_REFERENCE", `${path}[${index}].companionId`, "does not exist");
      result = result.filter((entry) => entry.id !== companionId);
    } else {
      fail("INVALID_VALUE", `${path}[${index}].kind`, "is not a companion change");
    }
  }
  return result;
}

function applyReputationChanges(
  reputations: readonly RpgReputation[],
  changes: readonly RpgReputationChange[] | undefined,
  path: string,
): RpgReputation[] {
  let result = [...reputations];
  for (const [index, raw] of (changes ?? []).entries()) {
    const change = object(raw, `${path}[${index}]`);
    if (change.kind === "add") {
      onlyKeys(change, ["kind", "reputation"], `${path}[${index}]`);
      const reputation = normalizeReputation(change.reputation, `${path}[${index}].reputation`);
      if (result.some((entry) => entry.targetId === reputation.targetId)) fail("DUPLICATE_ID", `${path}[${index}].reputation.targetId`, "already exists");
      result.push(reputation);
    } else if (change.kind === "adjust") {
      onlyKeys(change, ["kind", "targetId", "amount"], `${path}[${index}]`);
      const targetId = stringValue(change.targetId, `${path}[${index}].targetId`, 160);
      const reputationIndex = result.findIndex((entry) => entry.targetId === targetId);
      if (reputationIndex < 0) fail("MISSING_REFERENCE", `${path}[${index}].targetId`, "does not exist");
      const reputation = result[reputationIndex]!;
      const score = reputation.score + integer(change.amount, `${path}[${index}].amount`, -200, 200);
      if (score < -100 || score > 100) fail("INVARIANT_VIOLATION", `${path}[${index}].amount`, "would move reputation outside -100 through 100");
      result = replaceAt(result, reputationIndex, { ...reputation, score });
    } else if (change.kind === "remove") {
      onlyKeys(change, ["kind", "targetId"], `${path}[${index}]`);
      const targetId = stringValue(change.targetId, `${path}[${index}].targetId`, 160);
      if (!result.some((entry) => entry.targetId === targetId)) fail("MISSING_REFERENCE", `${path}[${index}].targetId`, "does not exist");
      result = result.filter((entry) => entry.targetId !== targetId);
    } else {
      fail("INVALID_VALUE", `${path}[${index}].kind`, "is not a reputation change");
    }
  }
  return result;
}

function applyObjectiveChanges(
  objectives: readonly RpgObjective[],
  changes: readonly RpgObjectiveChange[] | undefined,
  path: string,
): RpgObjective[] {
  let result = [...objectives];
  for (const [index, raw] of (changes ?? []).entries()) {
    const change = object(raw, `${path}[${index}]`);
    if (change.kind === "add") {
      onlyKeys(change, ["kind", "objective"], `${path}[${index}]`);
      const objective = normalizeObjective(change.objective, `${path}[${index}].objective`);
      if (result.some((entry) => entry.id === objective.id)) fail("DUPLICATE_ID", `${path}[${index}].objective.id`, "already exists");
      result.push(objective);
    } else if (change.kind === "progress") {
      onlyKeys(change, ["kind", "objectiveId", "amount"], `${path}[${index}]`);
      const objectiveId = stringValue(change.objectiveId, `${path}[${index}].objectiveId`, 160);
      const objectiveIndex = result.findIndex((entry) => entry.id === objectiveId);
      if (objectiveIndex < 0) fail("MISSING_REFERENCE", `${path}[${index}].objectiveId`, "does not exist");
      const objective = result[objectiveIndex]!;
      if (["completed", "failed", "abandoned"].includes(objective.status)) {
        fail("INVARIANT_VIOLATION", `${path}[${index}].objectiveId`, "cannot progress a closed objective");
      }
      const progress = objective.progress + integer(change.amount, `${path}[${index}].amount`, -1_000_000, 1_000_000);
      if (progress < 0 || progress > objective.target) fail("INVARIANT_VIOLATION", `${path}[${index}].amount`, "would move progress outside its bounds");
      result = replaceAt(result, objectiveIndex, {
        ...objective,
        progress,
        status: progress === objective.target ? "completed" : objective.status,
      });
    } else if (change.kind === "status") {
      onlyKeys(change, ["kind", "objectiveId", "status"], `${path}[${index}]`);
      const objectiveId = stringValue(change.objectiveId, `${path}[${index}].objectiveId`, 160);
      const objectiveIndex = result.findIndex((entry) => entry.id === objectiveId);
      if (objectiveIndex < 0) fail("MISSING_REFERENCE", `${path}[${index}].objectiveId`, "does not exist");
      const statuses = ["pending", "active", "completed", "failed", "abandoned"];
      if (!statuses.includes(String(change.status))) fail("INVALID_VALUE", `${path}[${index}].status`, "is not an objective status");
      const objective = result[objectiveIndex]!;
      result = replaceAt(result, objectiveIndex, {
        ...objective,
        status: change.status as RpgObjective["status"],
        progress: change.status === "completed" ? objective.target : objective.progress,
      });
    } else {
      fail("INVALID_VALUE", `${path}[${index}].kind`, "is not an objective change");
    }
  }
  return result;
}

function deltaHasChanges(input: Record<string, unknown>): boolean {
  if (input.turnAccepted === true) return true;
  if (input.activeCharacterId !== undefined || input.location !== undefined) return true;
  return [
    "characterChanges", "sharedResourceChanges", "companionChanges",
    "reputationChanges", "objectiveChanges",
  ].some((key) => Array.isArray(input[key]) && input[key].length > 0);
}

function applyStateDelta(
  rawState: CampaignRpgState,
  rawDelta: CampaignRpgStateDelta,
): CampaignRpgState {
  const state = normalizeCampaignRpgState(rawState);
  const delta = object(rawDelta, "delta");
  onlyKeys(
    delta,
    [
      "expectedStateVersion", "reason", "turnAccepted", "activeCharacterId", "location", "characterChanges",
      "sharedResourceChanges", "companionChanges", "reputationChanges", "objectiveChanges",
    ],
    "delta",
  );
  const expected = integer(
    delta.expectedStateVersion,
    "delta.expectedStateVersion",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (expected !== state.stateVersion) {
    fail("STATE_VERSION_MISMATCH", "delta.expectedStateVersion", `expected ${state.stateVersion}, received ${expected}`);
  }
  stringValue(delta.reason, "delta.reason", 1_000);
  if (delta.turnAccepted !== undefined && delta.turnAccepted !== true) {
    fail("INVALID_VALUE", "delta.turnAccepted", "must be true when supplied");
  }
  if (!deltaHasChanges(delta)) fail("EMPTY_DELTA", "delta", "must contain at least one state change");

  let characters = [...state.characters];
  if (delta.characterChanges !== undefined && !Array.isArray(delta.characterChanges)) {
    fail("INVALID_VALUE", "delta.characterChanges", "must be an array");
  }
  const characterChanges = (delta.characterChanges ?? []) as readonly CharacterRpgStateDelta[];
  for (const [index, raw] of characterChanges.entries()) {
    const change = object(raw, `delta.characterChanges[${index}]`);
    const characterId = stringValue(
      change.characterId,
      `delta.characterChanges[${index}].characterId`,
      160,
    );
    const characterIndex = characters.findIndex((entry) => entry.characterId === characterId);
    if (characterIndex < 0) fail("MISSING_REFERENCE", `delta.characterChanges[${index}].characterId`, "does not exist");
    characters = replaceAt(
      characters,
      characterIndex,
      applyCharacterChange(
        characters[characterIndex]!,
        raw as CharacterRpgStateDelta,
        `delta.characterChanges[${index}]`,
      ),
    );
  }

  const activeCharacterId = delta.activeCharacterId === undefined
    ? state.activeCharacterId
    : stringValue(delta.activeCharacterId, "delta.activeCharacterId", 160);
  if (!characters.some((character) => character.characterId === activeCharacterId)) {
    fail("MISSING_REFERENCE", "delta.activeCharacterId", "must reference a campaign character");
  }
  return normalizeCampaignRpgState({
    ...state,
    stateVersion: state.stateVersion + 1,
    activeCharacterId,
    characters,
    location: delta.location === undefined
      ? state.location
      : normalizeLocation(delta.location, "delta.location"),
    sharedResources: applyPoolChanges(
      state.sharedResources,
      delta.sharedResourceChanges as readonly RpgPoolChange[] | undefined,
      "delta.sharedResourceChanges",
    ),
    companions: applyCompanionChanges(
      state.companions,
      delta.companionChanges as readonly RpgCompanionChange[] | undefined,
      "delta.companionChanges",
    ),
    reputations: applyReputationChanges(
      state.reputations,
      delta.reputationChanges as readonly RpgReputationChange[] | undefined,
      "delta.reputationChanges",
    ),
    objectives: applyObjectiveChanges(
      state.objectives,
      delta.objectiveChanges as readonly RpgObjectiveChange[] | undefined,
      "delta.objectiveChanges",
    ),
  });
}

/** Apply a validated state transition without mutating either input value. */
export function applyCampaignRpgStateDelta(
  state: CampaignRpgState,
  delta: CampaignRpgStateDelta,
): CampaignRpgState {
  return deepFreeze(applyStateDelta(state, delta));
}

export type CampaignRpgDeltaValidation =
  | { readonly ok: true; readonly state: CampaignRpgState }
  | { readonly ok: false; readonly issues: readonly CampaignRpgValidationIssue[] };

export function validateCampaignRpgStateDelta(
  state: CampaignRpgState,
  delta: CampaignRpgStateDelta,
): CampaignRpgDeltaValidation {
  try {
    return { ok: true, state: applyCampaignRpgStateDelta(state, delta) };
  } catch (error) {
    if (error instanceof CampaignRpgValidationError) return { ok: false, issues: error.issues };
    throw error;
  }
}

export const CAMPAIGN_CHECK_DIFFICULTIES = [
  "trivial", "easy", "standard", "hard", "severe", "extreme",
] as const;
export type CampaignCheckDifficulty = (typeof CAMPAIGN_CHECK_DIFFICULTIES)[number];

const DIFFICULTY_MODIFIERS: Readonly<Record<CampaignCheckDifficulty, number>> = {
  trivial: 20,
  easy: 10,
  standard: 0,
  hard: -10,
  severe: -20,
  extreme: -30,
};

export type CampaignCheckRequest = {
  readonly actorId: string;
  readonly ability: StoryholdStatName;
  readonly capabilityId?: string | null;
  readonly difficulty: CampaignCheckDifficulty;
  readonly assistingCharacterIds?: readonly string[];
  readonly opposition?: {
    readonly characterId: string;
    readonly ability?: StoryholdStatName;
    readonly capabilityId?: string | null;
  } | null;
  readonly certainty?: OutcomeCertainty;
};

export type CampaignCheckContribution = {
  readonly source:
    | "ability"
    | "capability"
    | "equipment"
    | "assistance"
    | "difficulty"
    | "opposition"
    | "condition";
  readonly sourceId: string;
  readonly label: string;
  readonly value: number;
};

export type CampaignRelevantCheck = {
  readonly schemaVersion: 1;
  readonly seedId: string;
  readonly stateVersion: number;
  readonly actorId: string;
  readonly ability: StoryholdStatName;
  readonly capabilityId: string | null;
  readonly difficulty: CampaignCheckDifficulty;
  readonly certainty: OutcomeCertainty;
  readonly contributions: readonly CampaignCheckContribution[];
  readonly rawModifier: number;
  /** Server-owned percentile modifier, deliberately capped to avoid guarantees. */
  readonly modifier: number;
};

function abilityModifier(score: number): number {
  return (score - 10) * 2;
}

function capabilityModifier(rank: number): number {
  return rank * 4;
}

function effectApplies(
  effect: RpgCheckEffect,
  ability: StoryholdStatName,
  capabilityId: string | null,
): boolean {
  if (effect.abilities.length > 0 && !effect.abilities.includes(ability)) return false;
  if (
    effect.capabilities.length > 0 &&
    (capabilityId === null || !effect.capabilities.includes(capabilityId))
  ) return false;
  return true;
}

function getCharacter(state: CampaignRpgState, id: string, path: string): CharacterRpgState {
  const character = state.characters.find((entry) => entry.characterId === id);
  if (!character) fail("MISSING_REFERENCE", path, "does not reference a campaign character");
  return character;
}

function getCapability(
  character: CharacterRpgState,
  id: string | null,
  path: string,
): RpgCapability | null {
  if (id === null) return null;
  const capability = character.capabilities.find((entry) => entry.id === id);
  if (!capability) fail("MISSING_REFERENCE", path, `does not reference a capability owned by ${character.name}`);
  return capability;
}

function checkRequest(value: CampaignCheckRequest): CampaignCheckRequest & {
  capabilityId: string | null;
  assistingCharacterIds: readonly string[];
  opposition: NonNullable<CampaignCheckRequest["opposition"]> | null;
  certainty: OutcomeCertainty;
} {
  const input = object(value, "checkRequest");
  onlyKeys(
    input,
    ["actorId", "ability", "capabilityId", "difficulty", "assistingCharacterIds", "opposition", "certainty"],
    "checkRequest",
  );
  if (!CAMPAIGN_CHECK_DIFFICULTIES.includes(input.difficulty as CampaignCheckDifficulty)) {
    fail("INVALID_VALUE", "checkRequest.difficulty", "is not a check difficulty");
  }
  const certainties: OutcomeCertainty[] = [
    "automatic_success", "automatic_failure", "check_required", "unresolved", "not_applicable",
  ];
  const certainty = (input.certainty ?? "check_required") as OutcomeCertainty;
  if (!certainties.includes(certainty)) fail("INVALID_VALUE", "checkRequest.certainty", "is not an outcome certainty");
  const assistants = Array.isArray(input.assistingCharacterIds)
    ? input.assistingCharacterIds.map((id, index) =>
        stringValue(id, `checkRequest.assistingCharacterIds[${index}]`, 160),
      )
    : [];
  if (assistants.length > 3) fail("INVARIANT_VIOLATION", "checkRequest.assistingCharacterIds", "cannot include more than three assistants");
  if (new Set(assistants).size !== assistants.length) fail("DUPLICATE_ID", "checkRequest.assistingCharacterIds", "contains duplicates");
  let opposition: NonNullable<CampaignCheckRequest["opposition"]> | null = null;
  if (input.opposition !== null && input.opposition !== undefined) {
    const raw = object(input.opposition, "checkRequest.opposition");
    onlyKeys(raw, ["characterId", "ability", "capabilityId"], "checkRequest.opposition");
    opposition = {
      characterId: stringValue(raw.characterId, "checkRequest.opposition.characterId", 160),
      ability: raw.ability === undefined ? undefined : statName(raw.ability, "checkRequest.opposition.ability"),
      capabilityId: nullableString(raw.capabilityId, "checkRequest.opposition.capabilityId", 160),
    };
  }
  return {
    actorId: stringValue(input.actorId, "checkRequest.actorId", 160),
    ability: statName(input.ability, "checkRequest.ability"),
    capabilityId: nullableString(input.capabilityId, "checkRequest.capabilityId", 160),
    difficulty: input.difficulty as CampaignCheckDifficulty,
    assistingCharacterIds: assistants,
    opposition,
    certainty,
  };
}

/**
 * Construct a check exclusively from validated campaign state and categorical
 * choices. The request contains no roll, outcome, or free-form numeric bonus;
 * those remain outside model control.
 */
export function buildCampaignRelevantCheck(
  rawState: CampaignRpgState,
  rawRequest: CampaignCheckRequest,
): CampaignRelevantCheck {
  const state = normalizeCampaignRpgState(rawState);
  const request = checkRequest(rawRequest);
  const actor = getCharacter(state, request.actorId, "checkRequest.actorId");
  if (request.assistingCharacterIds.includes(actor.characterId)) {
    fail("INVARIANT_VIOLATION", "checkRequest.assistingCharacterIds", "the actor cannot assist themself");
  }
  if (request.opposition?.characterId === actor.characterId) {
    fail("INVARIANT_VIOLATION", "checkRequest.opposition.characterId", "the actor cannot oppose themself");
  }

  const capability = getCapability(actor, request.capabilityId, "checkRequest.capabilityId");
  const contributions: CampaignCheckContribution[] = [{
    source: "ability",
    sourceId: request.ability,
    label: `${request.ability} ${actor.stats[request.ability]}`,
    value: abilityModifier(actor.stats[request.ability]),
  }];
  if (capability) {
    contributions.push({
      source: "capability",
      sourceId: capability.id,
      label: `${capability.name} Rank ${capability.rank}`,
      value: capabilityModifier(capability.rank),
    });
  }

  const equippedIds = new Set(actor.equipment.map((entry) => entry.itemId));
  const equipped = actor.inventory
    .filter((item) => equippedIds.has(item.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const item of equipped) {
    for (const effect of item.checkEffects
      .filter((entry) => effectApplies(entry, request.ability, request.capabilityId))
      .sort((left, right) => left.id.localeCompare(right.id))) {
      contributions.push({
        source: "equipment",
        sourceId: `${item.id}:${effect.id}`,
        label: `${item.name}: ${effect.label}`,
        value: effect.modifier,
      });
    }
  }

  for (const assistantId of [...request.assistingCharacterIds].sort()) {
    const assistant = getCharacter(state, assistantId, "checkRequest.assistingCharacterIds");
    const assistantCapability = request.capabilityId === null
      ? null
      : assistant.capabilities.find((entry) => entry.id === request.capabilityId) ?? null;
    const help = Math.max(
      1,
      Math.min(
        8,
        2 + Math.floor((assistant.stats[request.ability] - 10) / 2) + (assistantCapability?.rank ?? 0),
      ),
    );
    contributions.push({
      source: "assistance",
      sourceId: assistant.characterId,
      label: `Assisted by ${assistant.name}`,
      value: help,
    });
  }

  contributions.push({
    source: "difficulty",
    sourceId: request.difficulty,
    label: `${request.difficulty.replace(/_/gu, " ")} difficulty`,
    value: DIFFICULTY_MODIFIERS[request.difficulty],
  });

  if (request.opposition) {
    const opponent = getCharacter(state, request.opposition.characterId, "checkRequest.opposition.characterId");
    const opposingAbility = request.opposition.ability ?? request.ability;
    const opposingCapabilityId = request.opposition.capabilityId ?? request.capabilityId;
    const opposingCapability = getCapability(
      opponent,
      opposingCapabilityId,
      "checkRequest.opposition.capabilityId",
    );
    const pressure = 5 + Math.max(0, abilityModifier(opponent.stats[opposingAbility])) +
      capabilityModifier(opposingCapability?.rank ?? 0);
    contributions.push({
      source: "opposition",
      sourceId: opponent.characterId,
      label: `Opposed by ${opponent.name}`,
      value: -Math.min(30, pressure),
    });
  }

  for (const condition of [...actor.conditions].sort((left, right) => left.id.localeCompare(right.id))) {
    for (const effect of condition.checkEffects
      .filter((entry) => effectApplies(entry, request.ability, request.capabilityId))
      .sort((left, right) => left.id.localeCompare(right.id))) {
      contributions.push({
        source: "condition",
        sourceId: `${condition.id}:${effect.id}`,
        label: `${condition.name}: ${effect.label}`,
        value: effect.modifier,
      });
    }
  }

  const rawModifier = contributions.reduce((sum, contribution) => sum + contribution.value, 0);
  return deepFreeze({
    schemaVersion: 1,
    seedId: state.seedId,
    stateVersion: state.stateVersion,
    actorId: actor.characterId,
    ability: request.ability,
    capabilityId: request.capabilityId,
    difficulty: request.difficulty,
    certainty: request.certainty,
    contributions,
    rawModifier,
    modifier: Math.max(-40, Math.min(40, rawModifier)),
  });
}

export type CampaignCheckResolution = {
  readonly check: CampaignRelevantCheck;
  readonly fortune: StableFortune | null;
  readonly result: DeterministicOutcome;
};

/** Resolve from server-derived fortune. There is deliberately no outcome input. */
export function resolveCampaignRelevantCheck(
  check: CampaignRelevantCheck,
  fortune: StableFortune | null,
): CampaignCheckResolution {
  const result = resolveDeterministicOutcome({
    certainty: check.certainty,
    fortune,
    modifier: check.modifier,
  });
  return deepFreeze({ check, fortune, result });
}

export type CampaignCheckProjection = {
  readonly mode: CampaignResolutionMode;
  readonly result?: {
    readonly outcome: DeterministicOutcome["outcome"];
    readonly band?: DeterministicOutcome["band"];
    readonly certainty?: DeterministicOutcome["certainty"];
  };
  readonly difficulty?: CampaignCheckDifficulty;
  readonly factors?: readonly {
    readonly label: string;
    readonly influence: "helps" | "hinders" | "neutral";
  }[];
  readonly numbers?: {
    readonly modifier: number;
    readonly percentile: number | null;
    readonly effectivePercentile: number | null;
    readonly d20?: number | null;
  };
  readonly breakdown?: readonly CampaignCheckContribution[];
};

function visibilityForRules(rules: CampaignRules): CustomCheckVisibility {
  if (rules.resolutionMode === "story_first") {
    return {
      showOutcome: true,
      showBand: false,
      showDifficulty: false,
      showFactors: false,
      showNumbers: false,
      showBreakdown: false,
      showD20: false,
    };
  }
  if (rules.resolutionMode === "light_rules") {
    return {
      showOutcome: true,
      showBand: true,
      showDifficulty: true,
      showFactors: true,
      showNumbers: false,
      showBreakdown: false,
      showD20: false,
    };
  }
  if (rules.resolutionMode === "tactical") {
    return {
      showOutcome: true,
      showBand: true,
      showDifficulty: true,
      showFactors: true,
      showNumbers: true,
      showBreakdown: true,
      showD20: true,
    };
  }
  return rules.customCheckVisibility;
}

function titleCaseIdentifier(value: string): string {
  return value
    .replace(/[_-]+/gu, " ")
    .replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase());
}

/**
 * Light-rules factors explain what mattered without smuggling scores or ranks
 * into an otherwise number-free view. Tactical/custom breakdowns retain the
 * exact contribution labels and values when their rules explicitly allow it.
 */
function qualitativeContributionLabel(contribution: CampaignCheckContribution): string {
  if (contribution.source === "ability") {
    return titleCaseIdentifier(contribution.sourceId);
  }
  if (contribution.source === "capability") {
    return contribution.label.replace(/\s+Rank\s+\d+\s*$/iu, "").trim();
  }
  if (contribution.source === "difficulty") {
    return `${titleCaseIdentifier(contribution.sourceId)} Difficulty`;
  }
  return contribution.label
    .replace(/\s*\([+-]?\d+\)\s*$/u, "")
    .replace(/\s+[+-]\d+\s*$/u, "")
    .trim();
}

/** Project only the mechanical detail allowed by the campaign's presentation mode. */
export function projectCampaignCheckResolution(
  resolution: CampaignCheckResolution,
  rules: CampaignRules,
): CampaignCheckProjection {
  const visibility = visibilityForRules(rules);
  const result: CampaignCheckProjection = {
    mode: rules.resolutionMode,
    ...(visibility.showOutcome
      ? {
          result: {
            outcome: resolution.result.outcome,
            ...(visibility.showBand ? { band: resolution.result.band } : {}),
            ...(visibility.showBreakdown ? { certainty: resolution.result.certainty } : {}),
          },
        }
      : {}),
    ...(visibility.showDifficulty ? { difficulty: resolution.check.difficulty } : {}),
    ...(visibility.showFactors
      ? {
          factors: resolution.check.contributions.map((contribution) => ({
            label: visibility.showNumbers
              ? contribution.label
              : qualitativeContributionLabel(contribution),
            influence: contribution.value > 0
              ? "helps" as const
              : contribution.value < 0
                ? "hinders" as const
                : "neutral" as const,
          })),
        }
      : {}),
    ...(visibility.showNumbers
      ? {
          numbers: {
            modifier: resolution.result.modifier,
            percentile: resolution.result.percentile,
            effectivePercentile: resolution.result.effectivePercentile,
            ...(visibility.showD20 ? { d20: resolution.fortune?.d20 ?? null } : {}),
          },
        }
      : {}),
    ...(visibility.showBreakdown ? { breakdown: resolution.check.contributions } : {}),
  };
  return deepFreeze(result);
}

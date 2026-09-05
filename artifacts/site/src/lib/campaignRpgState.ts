export type CampaignRpgPresentationMode =
  | "story-first"
  | "light-rules"
  | "tactical"
  | "custom";

export type CampaignRpgSectionId =
  | "objectives"
  | "location"
  | "vitality"
  | "stress"
  | "conditions"
  | "capabilities"
  | "equipment"
  | "inventory"
  | "companions"
  | "reputation";

export type CampaignRpgDetail = "hidden" | "summary" | "detailed";

export type CampaignRpgVisibility = {
  sections?: Partial<Record<CampaignRpgSectionId, CampaignRpgDetail>>;
  showNumbers?: boolean;
  showBreakdowns?: boolean;
};

export type CampaignRpgBreakdown = {
  label: string;
  value: number;
};

export type CampaignRpgMeter = {
  state: string;
  current?: number | null;
  maximum?: number | null;
  temporary?: number | null;
  note?: string;
  breakdown?: readonly CampaignRpgBreakdown[];
};

export type CampaignRpgObjective = {
  id: string;
  title: string;
  status?: "current" | "at-risk";
  summary?: string;
  nextStep?: string;
  stakes?: string;
  progress?: { current: number; maximum: number } | null;
};

export type CampaignRpgLocation = {
  name: string;
  summary?: string;
  nearby?: readonly string[];
};

export type CampaignRpgCondition = {
  id: string;
  name: string;
  summary?: string;
  severity?: string;
  duration?: string;
};

export type CampaignRpgCapability = {
  id: string;
  name: string;
  summary?: string;
  rating?: number | null;
  modifier?: number | null;
  breakdown?: readonly CampaignRpgBreakdown[];
};

export type CampaignRpgItem = {
  id: string;
  name: string;
  summary?: string;
  quantity?: number | null;
  rules?: readonly { label: string; value: string }[];
};

export type CampaignRpgCompanion = {
  id: string;
  name: string;
  role?: string;
  state?: string;
  note?: string;
  vitality?: { current: number; maximum: number } | null;
};

export type CampaignRpgReputation = {
  id: string;
  name: string;
  standing: string;
  note?: string;
  score?: number | null;
  breakdown?: readonly CampaignRpgBreakdown[];
};

/**
 * Player-safe data only. Callers decide which facts may enter this model;
 * presentation then enforces the requested amount of rules detail.
 */
export type CampaignRpgStateViewModel = {
  mode: CampaignRpgPresentationMode;
  visibility?: CampaignRpgVisibility;
  objectives?: readonly CampaignRpgObjective[];
  location?: CampaignRpgLocation | null;
  vitality?: CampaignRpgMeter | null;
  stress?: CampaignRpgMeter | null;
  conditions?: readonly CampaignRpgCondition[];
  capabilities?: readonly CampaignRpgCapability[];
  equippedItems?: readonly CampaignRpgItem[];
  inventory?: readonly CampaignRpgItem[];
  companions?: readonly CampaignRpgCompanion[];
  reputation?: readonly CampaignRpgReputation[];
};

export const CAMPAIGN_RPG_MODE_LABELS: Record<
  CampaignRpgPresentationMode,
  string
> = {
  "story-first": "Story Focus",
  "light-rules": "Light Rules",
  tactical: "Tactical Detail",
  custom: "Custom View",
};

export const CAMPAIGN_RPG_SECTION_LABELS: Record<CampaignRpgSectionId, string> = {
  objectives: "Current Objectives",
  location: "Where You Are",
  vitality: "Vitality",
  stress: "Stress",
  conditions: "Conditions",
  capabilities: "Capabilities",
  equipment: "Equipped Items",
  inventory: "Inventory",
  companions: "Companions",
  reputation: "Reputation",
};

export const CAMPAIGN_RPG_COMPACT_LIMIT = 4;

export type CampaignRpgPresentedBreakdown = {
  label: string;
  value: string;
};

export type CampaignRpgPresentedItem = {
  id: string;
  title: string;
  summary?: string;
  detail?: string;
  value?: string;
  tags: string[];
  breakdown: CampaignRpgPresentedBreakdown[];
};

export type CampaignRpgPresentedSection = {
  id: Exclude<
    CampaignRpgSectionId,
    "location" | "vitality" | "stress"
  >;
  label: string;
  items: CampaignRpgPresentedItem[];
  overflowCount: number;
};

export type CampaignRpgPresentedOverview = {
  id: "objective" | "location" | "vitality" | "stress";
  label: string;
  value: string;
  summary?: string;
  number?: string;
  breakdown: CampaignRpgPresentedBreakdown[];
};

export type CampaignRpgStatePresentation = {
  heading: "Story State";
  modeLabel: string;
  showNumbers: boolean;
  showBreakdowns: boolean;
  overview: CampaignRpgPresentedOverview[];
  sections: CampaignRpgPresentedSection[];
};

/**
 * The campaign's locked story-first choice is an independent safety ceiling.
 * A mismatched payload may become less detailed, never more detailed.
 */
export function enforceStoryFirstRpgState(
  state: CampaignRpgStateViewModel,
  resolutionMode: "story_first" | "light_rules" | "tactical" | "custom",
): CampaignRpgStateViewModel {
  return resolutionMode === "story_first" && state.mode !== "story-first"
    ? { ...state, mode: "story-first" }
    : state;
}

const DEFAULT_DETAIL: Record<CampaignRpgPresentationMode, CampaignRpgDetail> = {
  "story-first": "summary",
  "light-rules": "summary",
  tactical: "detailed",
  custom: "hidden",
};

function clean(value: unknown, maximum = 500): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function detailFor(
  state: CampaignRpgStateViewModel,
  section: CampaignRpgSectionId,
): CampaignRpgDetail {
  return state.visibility?.sections?.[section] ?? DEFAULT_DETAIL[state.mode];
}

function visibilityFor(state: CampaignRpgStateViewModel) {
  const showNumbers =
    state.mode === "story-first"
      ? false
      : state.visibility?.showNumbers ??
        (state.mode === "light-rules" || state.mode === "tactical");
  const showBreakdowns =
    showNumbers &&
    (state.mode === "tactical"
      ? state.visibility?.showBreakdowns ?? true
      : state.mode === "custom"
        ? state.visibility?.showBreakdowns === true
        : false);
  return { showNumbers, showBreakdowns };
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function meterValue(meter: CampaignRpgMeter): string | undefined {
  if (typeof meter.current !== "number") return undefined;
  if (typeof meter.maximum === "number") {
    return `${meter.current} / ${meter.maximum}`;
  }
  return String(meter.current);
}

function progressValue(
  progress: CampaignRpgObjective["progress"],
): string | undefined {
  return progress
    ? `${progress.current} / ${progress.maximum}`
    : undefined;
}

function presentedBreakdown(
  values: readonly CampaignRpgBreakdown[] | undefined,
  visible: boolean,
): CampaignRpgPresentedBreakdown[] {
  if (!visible) return [];
  return (values ?? []).flatMap((entry) => {
    const label = clean(entry.label, 80);
    return label && Number.isFinite(entry.value)
      ? [{ label, value: signed(entry.value) }]
      : [];
  });
}

function compact<T>(values: readonly T[]) {
  return {
    values: values.slice(0, CAMPAIGN_RPG_COMPACT_LIMIT),
    overflowCount: Math.max(0, values.length - CAMPAIGN_RPG_COMPACT_LIMIT),
  };
}

function nonEmptyTitle<T extends { id: string }>(
  values: readonly T[] | undefined,
  title: (value: T) => string,
): T[] {
  return (values ?? []).filter((value) => clean(value.id, 160) && clean(title(value)));
}

export function presentCampaignRpgState(
  state: CampaignRpgStateViewModel,
): CampaignRpgStatePresentation {
  const { showNumbers, showBreakdowns } = visibilityFor(state);
  const overview: CampaignRpgPresentedOverview[] = [];
  const sections: CampaignRpgPresentedSection[] = [];
  const objectives = nonEmptyTitle(state.objectives, (item) => item.title);

  const objectiveDetail = detailFor(state, "objectives");
  if (objectiveDetail !== "hidden" && objectives[0]) {
    const primary = objectives[0];
    overview.push({
      id: "objective",
      label: "Current Objective",
      value: clean(primary.title),
      summary: clean(primary.nextStep || primary.summary) || undefined,
      number: showNumbers ? progressValue(primary.progress) : undefined,
      breakdown: [],
    });
    const limited = compact(objectives);
    sections.push({
      id: "objectives",
      label: CAMPAIGN_RPG_SECTION_LABELS.objectives,
      overflowCount: limited.overflowCount,
      items: limited.values.map((objective) => ({
        id: objective.id,
        title: clean(objective.title),
        summary: clean(objective.summary || objective.nextStep) || undefined,
        detail:
          objectiveDetail === "detailed"
            ? clean(objective.stakes) || undefined
            : undefined,
        value: showNumbers ? progressValue(objective.progress) : undefined,
        tags: objective.status === "at-risk" ? ["At Risk"] : [],
        breakdown: [],
      })),
    });
  }

  const locationDetail = detailFor(state, "location");
  if (locationDetail !== "hidden" && clean(state.location?.name)) {
    const nearby =
      locationDetail === "detailed"
        ? (state.location?.nearby ?? []).map((item) => clean(item, 120)).filter(Boolean)
        : [];
    overview.push({
      id: "location",
      label: CAMPAIGN_RPG_SECTION_LABELS.location,
      value: clean(state.location?.name),
      summary:
        [clean(state.location?.summary), nearby.length ? `Nearby: ${nearby.join(", ")}` : ""]
          .filter(Boolean)
          .join(" · ") || undefined,
      breakdown: [],
    });
  }

  for (const [id, meter] of [
    ["vitality", state.vitality],
    ["stress", state.stress],
  ] as const) {
    const detail = detailFor(state, id);
    if (detail === "hidden" || !meter || !clean(meter.state)) continue;
    const temporary =
      showNumbers && detail === "detailed" && typeof meter.temporary === "number"
        ? `Temporary ${signed(meter.temporary)}`
        : "";
    overview.push({
      id,
      label: CAMPAIGN_RPG_SECTION_LABELS[id],
      value: clean(meter.state),
      summary: [clean(meter.note), temporary].filter(Boolean).join(" · ") || undefined,
      number: showNumbers ? meterValue(meter) : undefined,
      breakdown: presentedBreakdown(
        meter.breakdown,
        showBreakdowns && detail === "detailed",
      ),
    });
  }

  const conditionDetail = detailFor(state, "conditions");
  const conditions = nonEmptyTitle(state.conditions, (item) => item.name);
  if (conditionDetail !== "hidden" && conditions.length) {
    const limited = compact(conditions);
    sections.push({
      id: "conditions",
      label: CAMPAIGN_RPG_SECTION_LABELS.conditions,
      overflowCount: limited.overflowCount,
      items: limited.values.map((condition) => ({
        id: condition.id,
        title: clean(condition.name),
        summary: clean(condition.summary) || undefined,
        detail: undefined,
        tags:
          conditionDetail === "detailed"
            ? [clean(condition.severity, 80), clean(condition.duration, 120)].filter(Boolean)
            : [],
        breakdown: [],
      })),
    });
  }

  const capabilityDetail = detailFor(state, "capabilities");
  const capabilities = nonEmptyTitle(state.capabilities, (item) => item.name);
  if (capabilityDetail !== "hidden" && capabilities.length) {
    const limited = compact(capabilities);
    sections.push({
      id: "capabilities",
      label: CAMPAIGN_RPG_SECTION_LABELS.capabilities,
      overflowCount: limited.overflowCount,
      items: limited.values.map((capability) => ({
        id: capability.id,
        title: clean(capability.name),
        summary: clean(capability.summary) || undefined,
        value:
          showNumbers && typeof capability.modifier === "number"
            ? signed(capability.modifier)
            : showNumbers && typeof capability.rating === "number"
              ? String(capability.rating)
              : undefined,
        tags:
          showNumbers &&
          capabilityDetail === "detailed" &&
          typeof capability.rating === "number" &&
          typeof capability.modifier === "number"
            ? [`Rating ${capability.rating}`]
            : [],
        breakdown: presentedBreakdown(
          capability.breakdown,
          showBreakdowns && capabilityDetail === "detailed",
        ),
      })),
    });
  }

  const itemSections = [
    ["equipment", state.equippedItems],
    ["inventory", state.inventory],
  ] as const;
  for (const [id, rawItems] of itemSections) {
    const detail = detailFor(state, id);
    const items = nonEmptyTitle(rawItems, (item) => item.name);
    if (detail === "hidden" || !items.length) continue;
    const limited = compact(items);
    sections.push({
      id,
      label: CAMPAIGN_RPG_SECTION_LABELS[id],
      overflowCount: limited.overflowCount,
      items: limited.values.map((item) => ({
        id: item.id,
        title: clean(item.name),
        summary: clean(item.summary) || undefined,
        value:
          showNumbers && typeof item.quantity === "number"
            ? `×${item.quantity}`
            : undefined,
        tags: [],
        breakdown:
          showBreakdowns && detail === "detailed"
            ? (item.rules ?? []).flatMap((rule) => {
                const label = clean(rule.label, 80);
                const value = clean(rule.value, 80);
                return label && value ? [{ label, value }] : [];
              })
            : [],
      })),
    });
  }

  const companionDetail = detailFor(state, "companions");
  const companions = nonEmptyTitle(state.companions, (item) => item.name);
  if (companionDetail !== "hidden" && companions.length) {
    const limited = compact(companions);
    sections.push({
      id: "companions",
      label: CAMPAIGN_RPG_SECTION_LABELS.companions,
      overflowCount: limited.overflowCount,
      items: limited.values.map((companion) => ({
        id: companion.id,
        title: clean(companion.name),
        summary: [clean(companion.role), clean(companion.state)].filter(Boolean).join(" · ") || undefined,
        detail:
          companionDetail === "detailed"
            ? clean(companion.note) || undefined
            : undefined,
        value:
          showNumbers && companion.vitality
            ? `${companion.vitality.current} / ${companion.vitality.maximum}`
            : undefined,
        tags: [],
        breakdown: [],
      })),
    });
  }

  const reputationDetail = detailFor(state, "reputation");
  const reputation = nonEmptyTitle(state.reputation, (item) => item.name);
  if (reputationDetail !== "hidden" && reputation.length) {
    const limited = compact(reputation);
    sections.push({
      id: "reputation",
      label: CAMPAIGN_RPG_SECTION_LABELS.reputation,
      overflowCount: limited.overflowCount,
      items: limited.values.map((standing) => ({
        id: standing.id,
        title: clean(standing.name),
        summary: clean(standing.standing) || undefined,
        detail:
          reputationDetail === "detailed"
            ? clean(standing.note) || undefined
            : undefined,
        value:
          showNumbers && typeof standing.score === "number"
            ? signed(standing.score)
            : undefined,
        tags: [],
        breakdown: presentedBreakdown(
          standing.breakdown,
          showBreakdowns && reputationDetail === "detailed",
        ),
      })),
    });
  }

  return {
    heading: "Story State",
    modeLabel: CAMPAIGN_RPG_MODE_LABELS[state.mode],
    showNumbers,
    showBreakdowns,
    overview,
    sections,
  };
}

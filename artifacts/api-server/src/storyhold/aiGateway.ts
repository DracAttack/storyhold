import Anthropic from "@anthropic-ai/sdk";
import {
  getLocalEntityExtractionStatus,
  type LocalEntityExtractionStatus,
} from "./localEntityExtraction";
import type { AiBillingSource, AiConnectionSource } from "./aiExecutionPolicy";

export type StoryholdProviderId =
  | "anthropic"
  | "openai"
  | "xai"
  | "kimi"
  | "openrouter";
export type StoryholdAiTask =
  | "demo_scene"
  | "campaign_turn"
  | "campaign_direction"
  | "campaign_narration"
  | "story_adaptation"
  | "world_analysis"
  | "canon_review"
  | "memory_maintenance";
export type StoryholdInferenceStage =
  | "extraction"
  | "verification"
  | "dossier"
  | "chronology"
  | "director"
  | "narration"
  | "adaptation";
export type ReasoningLevel = "low" | "medium" | "high";
export type ContentMode = "standard" | "adult";

export type AiProviderStatus = {
  id: StoryholdProviderId;
  label: string;
  configured: boolean;
  model: string;
  supportsReasoningControl: boolean;
  eligibleForAdultNarration: boolean;
};

export type AiRuntimeStatus = {
  configured: boolean;
  mode: "development" | "connected";
  provider: "storyhold-development" | StoryholdProviderId;
  model: string;
  billable: boolean;
  sendsSourceTextOffDevice: boolean;
  explanation: string;
  stage: StoryholdInferenceStage;
  execution: {
    connectionId: string;
    credentialSource: "environment";
    connectionSource: AiConnectionSource | null;
    billingSource: AiBillingSource | null;
    requestedModel: string;
    resolvedModel: string | null;
    upstreamProvider: string | null;
    privacyMode: "zero-data-retention" | null;
  } | null;
  localExtraction: LocalEntityExtractionStatus;
  providers: AiProviderStatus[];
  routing: {
    director: StoryholdProviderId | null;
    narration: StoryholdProviderId | null;
    adultNarration: StoryholdProviderId | null;
    analysis: StoryholdProviderId | null;
    canonReview: StoryholdProviderId | null;
  };
  stageRouting: Record<StoryholdInferenceStage, StoryholdProviderId | null>;
};

export type AiUsage = {
  inputUnits: number;
  outputUnits: number;
  cachedInputUnits: number;
  cacheWriteInputUnits: number;
  reasoningUnits: number;
  estimatedCostMicros: number;
  pricingKnown: boolean;
  pricingVersion: string;
  /** @deprecated Use pricingKnown. Retained for stored-usage compatibility. */
  costEstimated: boolean;
};

export type AiCostReservationQuote = {
  inputUnits: number;
  maxOutputUnits: number;
  maximumCostMicros: number;
  pricingKnown: boolean;
  candidates: Array<{
    provider: StoryholdProviderId;
    model: string;
    maximumCostMicros: number;
    pricingKnown: boolean;
  }>;
};

export type AiTextResult = {
  text: string;
  /** Server-stamped durable completion time; retained unchanged on paid-call replay. */
  journalCompletedAt?: string;
  runtime: AiRuntimeStatus;
  provider: StoryholdProviderId;
  model: string;
  reasoning: ReasoningLevel;
  usage: AiUsage;
  /** Earlier provider responses that were billable but failed validation. */
  priorBillableAttempts?: AiBillableAttempt[];
};

export type AiBillableAttempt = {
  provider: StoryholdProviderId;
  model: string;
  resolvedModel: string;
  upstreamProvider: string | null;
  stage: StoryholdInferenceStage;
  reasoning: ReasoningLevel;
  usage: AiUsage;
};

export function combineAiUsage(usages: AiUsage[]): AiUsage {
  if (!usages.length) {
    return {
      inputUnits: 0,
      outputUnits: 0,
      cachedInputUnits: 0,
      cacheWriteInputUnits: 0,
      reasoningUnits: 0,
      estimatedCostMicros: 0,
      pricingKnown: true,
      pricingVersion: "none",
      costEstimated: true,
    };
  }
  const pricingVersions = [...new Set(usages.map((usage) => usage.pricingVersion))];
  return {
    inputUnits: usages.reduce((total, usage) => total + usage.inputUnits, 0),
    outputUnits: usages.reduce((total, usage) => total + usage.outputUnits, 0),
    cachedInputUnits: usages.reduce(
      (total, usage) => total + usage.cachedInputUnits,
      0,
    ),
    cacheWriteInputUnits: usages.reduce(
      (total, usage) => total + usage.cacheWriteInputUnits,
      0,
    ),
    reasoningUnits: usages.reduce(
      (total, usage) => total + usage.reasoningUnits,
      0,
    ),
    estimatedCostMicros: usages.reduce(
      (total, usage) => total + usage.estimatedCostMicros,
      0,
    ),
    pricingKnown: usages.every((usage) => usage.pricingKnown),
    pricingVersion:
      pricingVersions.length === 1 ? pricingVersions[0]! : "mixed",
    costEstimated: usages.every((usage) => usage.costEstimated),
  };
}

type ProviderConfiguration = {
  id: StoryholdProviderId;
  label: string;
  apiKey: string;
  model: string;
  chatUrl?: string;
  baseURL?: string;
  supportsReasoningControl: boolean;
  eligibleForAdultNarration: boolean;
  stage: StoryholdInferenceStage;
  extraHeaders?: Record<string, string>;
};

type GatewayMessage = {
  role: "user" | "assistant";
  content: string;
};

export type GenerateAiTextInput = {
  task: StoryholdAiTask;
  stage?: StoryholdInferenceStage;
  system: string;
  messages: GatewayMessage[];
  reasoning?: ReasoningLevel;
  contentMode?: ContentMode;
  maxOutputTokens?: number;
  temperature?: number;
  /** False limits execution to one provider request, including SDK retries. */
  allowProviderFallback?: boolean;
  /** Server-only paid-call policy: preserve the first failed attempt for recovery. */
  providerFailurePolicy?: "stop";
  validate?: (text: string) => void;
};

const DEFAULT_MODELS: Record<StoryholdProviderId, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.6-luna",
  xai: "grok-4.5",
  kimi: "kimi-k3",
  openrouter: "mistralai/mistral-small-2603",
};

const OPENROUTER_STAGE_MODELS: Record<StoryholdInferenceStage, string> = {
  extraction: "mistralai/mistral-small-2603",
  // Premium Canon Review is intentionally pinned in code. Changing the model
  // is an audited deployment change, not a mutable production environment
  // switch or an OpenRouter auto/latest alias.
  verification: "openai/gpt-5.6-luna-pro",
  dossier: "anthropic/claude-sonnet-4.6",
  chronology: "qwen/qwen3.5-397b-a17b-20260216",
  director: "qwen/qwen3.5-397b-a17b-20260216",
  narration: "anthropic/claude-sonnet-4.6",
  adaptation: "anthropic/claude-sonnet-4.6",
};

const PRICING_VERSION = "2026-08-28";

const PROVIDER_LABELS: Record<StoryholdProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  xai: "xAI / Grok",
  kimi: "Moonshot / Kimi",
  openrouter: "OpenRouter",
};

const ALL_PROVIDER_IDS: StoryholdProviderId[] = [
  "anthropic",
  "openai",
  "xai",
  "kimi",
  "openrouter",
];

const STANDARD_DEFAULT_ORDER: Record<StoryholdAiTask, StoryholdProviderId[]> = {
  demo_scene: ["openai", "anthropic", "xai", "kimi"],
  campaign_turn: ["openai", "anthropic", "xai", "kimi"],
  campaign_direction: ["openai", "anthropic", "kimi", "xai"],
  campaign_narration: ["openai", "anthropic", "xai", "kimi"],
  story_adaptation: ["openai", "anthropic", "xai", "kimi"],
  world_analysis: ["openai", "anthropic", "xai", "kimi"],
  canon_review: ["openai", "anthropic", "xai", "kimi"],
  memory_maintenance: ["openai", "kimi", "anthropic", "xai"],
};

const STAGE_PROVIDER_ENV: Record<StoryholdInferenceStage, string> = {
  extraction: "STORYHOLD_EXTRACTION_PROVIDER",
  verification: "STORYHOLD_VERIFICATION_PROVIDER",
  dossier: "STORYHOLD_DOSSIER_PROVIDER",
  chronology: "STORYHOLD_CHRONOLOGY_PROVIDER",
  director: "STORYHOLD_DIRECTOR_PROVIDER",
  narration: "STORYHOLD_NARRATOR_PROVIDER",
  adaptation: "STORYHOLD_ADAPTATION_PROVIDER",
};

const TASK_STAGE: Record<StoryholdAiTask, StoryholdInferenceStage> = {
  demo_scene: "narration",
  campaign_turn: "narration",
  campaign_direction: "director",
  campaign_narration: "narration",
  story_adaptation: "adaptation",
  world_analysis: "extraction",
  canon_review: "verification",
  memory_maintenance: "extraction",
};

const TASK_FOR_STAGE: Record<StoryholdInferenceStage, StoryholdAiTask> = {
  extraction: "world_analysis",
  verification: "canon_review",
  dossier: "canon_review",
  chronology: "canon_review",
  director: "campaign_direction",
  narration: "campaign_narration",
  adaptation: "story_adaptation",
};

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_ATTRIBUTION_HEADERS = {
  "HTTP-Referer": "https://storyhold.com",
  "X-Title": "Storyhold",
  "X-OpenRouter-Metadata": "enabled",
};
const OPENROUTER_PROVIDER_REQUIREMENTS = {
  require_parameters: true,
  data_collection: "deny",
  zdr: true,
} as const;

function envText(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return "";
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function compatibleChatUrl(
  id: Exclude<StoryholdProviderId, "anthropic">,
): string {
  if (id === "openai") {
    const explicit = envText("STORYHOLD_OPENAI_CHAT_URL");
    if (explicit) return explicit;
    const base =
      envText("STORYHOLD_OPENAI_BASE_URL", "OPENAI_BASE_URL") ||
      "https://api.openai.com/v1";
    return `${withoutTrailingSlash(base)}/chat/completions`;
  }
  if (id === "xai") {
    const explicit = envText("STORYHOLD_XAI_CHAT_URL");
    if (explicit) return explicit;
    const base =
      envText("STORYHOLD_XAI_BASE_URL", "XAI_BASE_URL") ||
      "https://api.x.ai/v1";
    return `${withoutTrailingSlash(base)}/chat/completions`;
  }
  if (id === "openrouter") return OPENROUTER_CHAT_URL;
  const explicit = envText("STORYHOLD_KIMI_CHAT_URL");
  if (explicit) return explicit;
  const base =
    envText("STORYHOLD_KIMI_BASE_URL", "KIMI_BASE_URL") ||
    "https://api.moonshot.ai/v1";
  return `${withoutTrailingSlash(base)}/chat/completions`;
}

function stageModelEnv(
  id: StoryholdProviderId,
  stage: StoryholdInferenceStage,
) {
  return `STORYHOLD_${id.toUpperCase()}_${stage.toUpperCase()}_MODEL`;
}

function inferenceStageFor(
  task: StoryholdAiTask,
  stage?: StoryholdInferenceStage,
): StoryholdInferenceStage {
  return stage ?? TASK_STAGE[task];
}

function openRouterAdultApproved(): boolean {
  return (
    envText("STORYHOLD_OPENROUTER_ADULT_ENABLED").toLocaleLowerCase() ===
      "true" && Boolean(envText("STORYHOLD_OPENROUTER_ADULT_MODEL"))
  );
}

function isPinnedOpenRouterModel(model: string): boolean {
  // Route aliases and modifiers can silently change the model or service lane.
  // Managed canonical work accepts only an exact `author/model` slug.
  const normalized = model.toLocaleLowerCase();
  return (
    /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/u.test(normalized) &&
    !/(?:^|[\/._-])(auto|latest)(?:$|[\/._-])/u.test(normalized)
  );
}

function openRouterModelFor(
  stage: StoryholdInferenceStage,
  contentMode: ContentMode,
): string | null {
  const model =
    contentMode === "adult"
      ? envText("STORYHOLD_OPENROUTER_ADULT_MODEL")
      : stage === "verification"
        ? OPENROUTER_STAGE_MODELS.verification
        : envText(
            stageModelEnv("openrouter", stage),
            "STORYHOLD_OPENROUTER_MODEL",
          ) || OPENROUTER_STAGE_MODELS[stage];
  return isPinnedOpenRouterModel(model) ? model : null;
}

function supportsReasoningControlFor(
  id: StoryholdProviderId,
  model: string,
): boolean {
  return (
    id === "openai" ||
    id === "xai" ||
    (id === "kimi" && model.startsWith("kimi-k3")) ||
    (id === "openrouter" && model === OPENROUTER_STAGE_MODELS.verification)
  );
}

function configurationFor(
  id: StoryholdProviderId,
  stage: StoryholdInferenceStage,
  contentMode: ContentMode = "standard",
): ProviderConfiguration | null {
  if (id === "anthropic") {
    const apiKey = envText(
      "STORYHOLD_ANTHROPIC_API_KEY",
      "ANTHROPIC_API_KEY",
      "AI_INTEGRATIONS_ANTHROPIC_API_KEY",
    );
    if (!apiKey) return null;
    return {
      id,
      label: PROVIDER_LABELS[id],
      apiKey,
      model:
        envText(
          stageModelEnv(id, stage),
          "STORYHOLD_ANTHROPIC_MODEL",
          "STORYHOLD_AI_MODEL",
        ) || DEFAULT_MODELS[id],
      baseURL:
        envText(
          "STORYHOLD_ANTHROPIC_BASE_URL",
          "AI_INTEGRATIONS_ANTHROPIC_BASE_URL",
        ) || undefined,
      supportsReasoningControl: false,
      eligibleForAdultNarration: false,
      stage,
    };
  }

  const keyNames: Record<
    Exclude<StoryholdProviderId, "anthropic">,
    string[]
  > = {
    openai: ["STORYHOLD_OPENAI_API_KEY", "OPENAI_API_KEY"],
    xai: ["STORYHOLD_XAI_API_KEY", "XAI_API_KEY"],
    kimi: ["STORYHOLD_KIMI_API_KEY", "KIMI_API_KEY", "MOONSHOT_API_KEY"],
    // Managed billing must use the deployment's explicit Storyhold secret. An
    // ambient developer-shell OPENROUTER_API_KEY must never activate this lane.
    openrouter: ["STORYHOLD_OPENROUTER_API_KEY"],
  };
  const modelNames: Record<
    Exclude<StoryholdProviderId, "anthropic">,
    string
  > = {
    openai: "STORYHOLD_OPENAI_MODEL",
    xai: "STORYHOLD_XAI_MODEL",
    kimi: "STORYHOLD_KIMI_MODEL",
    openrouter: "STORYHOLD_OPENROUTER_MODEL",
  };
  const apiKey = envText(...keyNames[id]);
  if (!apiKey) return null;
  const approvedOpenRouterAdult =
    id === "openrouter" && contentMode === "adult" && openRouterAdultApproved();
  const openRouterModel =
    id === "openrouter" ? openRouterModelFor(stage, contentMode) : null;
  if (id === "openrouter" && !openRouterModel) return null;
  const configuredModel =
    id === "openrouter"
      ? openRouterModel!
      : envText(stageModelEnv(id, stage), modelNames[id]) || DEFAULT_MODELS[id];
  return {
    id,
    label: PROVIDER_LABELS[id],
    apiKey,
    model: configuredModel,
    chatUrl: compatibleChatUrl(id),
    supportsReasoningControl: supportsReasoningControlFor(id, configuredModel),
    // Storyhold deliberately does not send explicit scenes through an automatic
    // multi-provider fallback. The owner must name the adult provider, and xAI
    // is the only built-in default for that lane.
    eligibleForAdultNarration: id === "xai" || approvedOpenRouterAdult,
    stage,
    ...(id === "openrouter"
      ? { extraHeaders: OPENROUTER_ATTRIBUTION_HEADERS }
      : {}),
  };
}

function providerStatus(
  id: StoryholdProviderId,
  stage: StoryholdInferenceStage,
  contentMode: ContentMode,
): AiProviderStatus {
  const configured = configurationFor(id, stage, contentMode);
  const model =
    configured?.model ||
    (id === "openrouter"
      ? openRouterModelFor(stage, contentMode) || OPENROUTER_STAGE_MODELS[stage]
      : envText(stageModelEnv(id, stage)) ||
        envText(`STORYHOLD_${id.toUpperCase()}_MODEL`) ||
        DEFAULT_MODELS[id]);
  return {
    id,
    label: PROVIDER_LABELS[id],
    configured: Boolean(configured),
    model,
    supportsReasoningControl: supportsReasoningControlFor(id, model),
    eligibleForAdultNarration:
      id === "xai" || (id === "openrouter" && openRouterAdultApproved()),
  };
}

function providerId(value: string): StoryholdProviderId | null {
  return ALL_PROVIDER_IDS.includes(value as StoryholdProviderId)
    ? (value as StoryholdProviderId)
    : null;
}

function preferenceFor(
  task: StoryholdAiTask,
  contentMode: ContentMode,
  stage: StoryholdInferenceStage,
) {
  if (contentMode === "adult") {
    return providerId(envText("STORYHOLD_ADULT_PROVIDER").toLocaleLowerCase());
  }
  const stageSpecific = providerId(
    envText(STAGE_PROVIDER_ENV[stage]).toLocaleLowerCase(),
  );
  if (stageSpecific) return stageSpecific;
  const taskSpecific =
    task === "campaign_direction"
      ? envText("STORYHOLD_DIRECTOR_PROVIDER")
      : task === "demo_scene" ||
          task === "campaign_turn" ||
          task === "campaign_narration" ||
          task === "story_adaptation"
        ? envText("STORYHOLD_NARRATOR_PROVIDER")
        : task === "world_analysis" || task === "memory_maintenance"
          ? envText("STORYHOLD_ANALYSIS_PROVIDER")
          : envText("STORYHOLD_CANON_PROVIDER");
  return providerId(
    (taskSpecific || envText("STORYHOLD_AI_PROVIDER")).toLocaleLowerCase(),
  );
}

function configuredOrder(
  task: StoryholdAiTask,
  contentMode: ContentMode,
  requestedStage?: StoryholdInferenceStage,
): ProviderConfiguration[] {
  const stage = inferenceStageFor(task, requestedStage);
  const preferred = preferenceFor(task, contentMode, stage);
  if (contentMode === "adult") {
    // Adult narration has no implicit provider. A connection must be selected
    // deliberately for this isolated lane before it is considered.
    const allowed = preferred ? [preferred] : [];
    return allowed
      .map((id) => configurationFor(id, stage, contentMode))
      .filter((item): item is ProviderConfiguration =>
        Boolean(item?.eligibleForAdultNarration),
      );
  }

  // Explicit OpenRouter selection is an isolated managed lane. A missing key,
  // invalid model, privacy-ineligible endpoint, or failed call must not silently
  // spill manuscript evidence into an unrelated direct-provider fallback.
  if (preferred === "openrouter") {
    const selected = configurationFor("openrouter", stage, contentMode);
    return selected ? [selected] : [];
  }

  const fallbackEnv = envText("STORYHOLD_AI_FALLBACKS")
    .split(",")
    .map((item) => providerId(item.trim().toLocaleLowerCase()))
    .filter(
      (item): item is StoryholdProviderId =>
        Boolean(item) && item !== "openrouter",
    );
  const order = [
    ...(preferred ? [preferred] : []),
    ...fallbackEnv,
    ...STANDARD_DEFAULT_ORDER[task],
  ];
  const seen = new Set<StoryholdProviderId>();
  return order
    .filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((id) => configurationFor(id, stage, contentMode))
    .filter((item): item is ProviderConfiguration => Boolean(item));
}

function configurationsForInput(input: GenerateAiTextInput): ProviderConfiguration[] {
  const configurations = configuredOrder(
    input.task,
    input.contentMode ?? "standard",
    input.stage,
  );
  return input.allowProviderFallback === false
    ? configurations.slice(0, 1)
    : configurations;
}

function selectedProvider(
  task: StoryholdAiTask,
  contentMode: ContentMode = "standard",
  stage?: StoryholdInferenceStage,
): ProviderConfiguration | null {
  return configuredOrder(task, contentMode, stage)[0] ?? null;
}

function routeProvider(
  task: StoryholdAiTask,
  contentMode: ContentMode = "standard",
  stage?: StoryholdInferenceStage,
): StoryholdProviderId | null {
  return selectedProvider(task, contentMode, stage)?.id ?? null;
}

export function getAiRuntimeStatus(
  task: StoryholdAiTask = "world_analysis",
  contentMode: ContentMode = "standard",
  requestedStage?: StoryholdInferenceStage,
): AiRuntimeStatus {
  const stage = inferenceStageFor(task, requestedStage);
  const providers = ALL_PROVIDER_IDS.map((id) =>
    providerStatus(id, stage, contentMode),
  );
  const localExtraction = getLocalEntityExtractionStatus();
  const selected = selectedProvider(task, contentMode, stage);
  const routing = {
    director: routeProvider("campaign_direction"),
    narration: routeProvider("campaign_narration"),
    adultNarration: routeProvider("campaign_narration", "adult"),
    analysis: routeProvider("world_analysis"),
    canonReview: routeProvider("canon_review"),
  };
  const stageRouting: Record<
    StoryholdInferenceStage,
    StoryholdProviderId | null
  > = {
    extraction: routeProvider(
      TASK_FOR_STAGE.extraction,
      "standard",
      "extraction",
    ),
    verification: routeProvider(
      TASK_FOR_STAGE.verification,
      "standard",
      "verification",
    ),
    dossier: routeProvider(TASK_FOR_STAGE.dossier, "standard", "dossier"),
    chronology: routeProvider(
      TASK_FOR_STAGE.chronology,
      "standard",
      "chronology",
    ),
    director: routeProvider(TASK_FOR_STAGE.director, "standard", "director"),
    narration: routeProvider(TASK_FOR_STAGE.narration, "standard", "narration"),
    adaptation: routeProvider(
      TASK_FOR_STAGE.adaptation,
      "standard",
      "adaptation",
    ),
  };
  if (!selected) {
    const adultMessage =
      contentMode === "adult"
        ? " No explicitly eligible adult-fiction provider is connected for this world."
        : "";
    return {
      configured: false,
      mode: "development",
      provider: "storyhold-development",
      model: "deterministic local services",
      billable: false,
      sendsSourceTextOffDevice: false,
      explanation: `No eligible model connection is configured for this operation.${adultMessage} Storyhold keeps uploads and canonical state local until a provider is available.`,
      stage,
      execution: null,
      localExtraction,
      providers,
      routing,
      stageRouting,
    };
  }
  const connectedCount = providers.filter((item) => item.configured).length;
  return {
    configured: true,
    mode: "connected",
    provider: selected.id,
    model: selected.model,
    billable: true,
    sendsSourceTextOffDevice: true,
    explanation: `${selected.label} is selected for this operation. ${connectedCount} model connection${connectedCount === 1 ? " is" : "s are"} available; Storyhold still validates every canonical write on the server.`,
    stage,
    execution: {
      connectionId: `managed:${selected.id}`,
      credentialSource: "environment",
      // Environment credentials remain the existing Storyhold-funded server
      // path. BYO stays disabled until caller scope, secure key resolution,
      // and external-provider billing are wired end to end.
      connectionSource: "storyhold_managed",
      billingSource: "storyhold_credits",
      requestedModel: selected.model,
      resolvedModel: null,
      upstreamProvider: null,
      privacyMode: selected.id === "openrouter" ? "zero-data-retention" : null,
    },
    localExtraction,
    providers,
    routing,
    stageRouting,
  };
}

function reasoningForProvider(
  configuration: ProviderConfiguration,
  reasoning: ReasoningLevel,
): ReasoningLevel {
  return configuration.supportsReasoningControl ? reasoning : "low";
}

function numeric(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function reportedUsdCostMicros(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const dollars = Number(value);
  return Number.isFinite(dollars) && dollars >= 0
    ? Math.round(dollars * 1_000_000)
    : null;
}

type ModelRates = {
  input: number;
  cachedInput: number;
  cacheWriteInput: number;
  output: number;
  known: boolean;
};

function modelRates(
  configuration: ProviderConfiguration,
  inputUnits = 0,
): ModelRates {
  const prefix = `STORYHOLD_${configuration.id.toUpperCase()}`;
  const stagePrefix = `${prefix}_${configuration.stage.toUpperCase()}`;
  const inputOverride = Number(
    envText(`${stagePrefix}_INPUT_USD_PER_M`, `${prefix}_INPUT_USD_PER_M`),
  );
  const outputOverride = Number(
    envText(`${stagePrefix}_OUTPUT_USD_PER_M`, `${prefix}_OUTPUT_USD_PER_M`),
  );
  if (inputOverride > 0 && outputOverride > 0) {
    const cachedText = envText(
      `${stagePrefix}_CACHED_INPUT_USD_PER_M`,
      `${prefix}_CACHED_INPUT_USD_PER_M`,
    );
    const cacheWriteText = envText(
      `${stagePrefix}_CACHE_WRITE_INPUT_USD_PER_M`,
      `${prefix}_CACHE_WRITE_INPUT_USD_PER_M`,
    );
    const cachedOverride = Number(cachedText);
    const cacheWriteOverride = Number(cacheWriteText);
    return {
      input: inputOverride,
      cachedInput:
        cachedText && cachedOverride >= 0 ? cachedOverride : inputOverride,
      cacheWriteInput:
        cacheWriteText && cacheWriteOverride >= 0
          ? cacheWriteOverride
          : inputOverride,
      output: outputOverride,
      known: true,
    };
  }
  if (configuration.id === "openrouter") {
    if (configuration.model === "openai/gpt-5.6-luna-pro") {
      // OpenAI applies long-context rates to the entire request above 272K
      // input tokens. OpenRouter-reported usage remains authoritative after the
      // call; these rates provide a conservative pre-call credit reservation.
      return inputUnits > 272_000
        ? {
            input: 0.4,
            cachedInput: 0.04,
            cacheWriteInput: 0.5,
            output: 1.8,
            known: true,
          }
        : {
            input: 0.2,
            cachedInput: 0.02,
            cacheWriteInput: 0.25,
            output: 1.2,
            known: true,
          };
    }
    if (configuration.model === "mistralai/mistral-small-2603") {
      return {
        input: 0.15,
        cachedInput: 0.15,
        cacheWriteInput: 0.15,
        output: 0.6,
        known: true,
      };
    }
    if (configuration.model === "qwen/qwen3.5-397b-a17b-20260216") {
      return {
        input: 0.385,
        cachedInput: 0.385,
        cacheWriteInput: 0.385,
        output: 2.45,
        known: true,
      };
    }
    if (configuration.model === "anthropic/claude-sonnet-4.6") {
      return {
        input: 3,
        cachedInput: 0.3,
        cacheWriteInput: 3.75,
        output: 15,
        known: true,
      };
    }
    if (configuration.model === "x-ai/grok-4.5") {
      return inputUnits >= 200_000
        ? {
            input: 4,
            cachedInput: 0.6,
            cacheWriteInput: 4,
            output: 12,
            known: true,
          }
        : {
            input: 2,
            cachedInput: 0.3,
            cacheWriteInput: 2,
            output: 6,
            known: true,
          };
    }
  }
  if (
    configuration.id === "xai" &&
    configuration.model.startsWith("grok-4.5")
  ) {
    return inputUnits >= 200_000
      ? {
          input: 4,
          cachedInput: 0.6,
          cacheWriteInput: 4,
          output: 12,
          known: true,
        }
      : {
          input: 2,
          cachedInput: 0.3,
          cacheWriteInput: 2,
          output: 6,
          known: true,
        };
  }
  if (configuration.id === "openai") {
    if (configuration.model.includes("luna"))
      return {
        input: 1,
        cachedInput: 0.1,
        cacheWriteInput: 1.25,
        output: 6,
        known: true,
      };
    if (configuration.model.includes("terra"))
      return {
        input: 2.5,
        cachedInput: 0.25,
        cacheWriteInput: 3.125,
        output: 15,
        known: true,
      };
    if (
      configuration.model === "gpt-5.6" ||
      configuration.model.includes("sol")
    )
      return {
        input: 5,
        cachedInput: 0.5,
        cacheWriteInput: 6.25,
        output: 30,
        known: true,
      };
  }
  if (
    configuration.id === "anthropic" &&
    configuration.model.startsWith("claude-haiku-4-5")
  ) {
    return {
      input: 1,
      cachedInput: 0.1,
      cacheWriteInput: 1.25,
      output: 5,
      known: true,
    };
  }
  if (configuration.id === "kimi") {
    if (configuration.model.startsWith("kimi-k3")) {
      return {
        input: 3,
        cachedInput: 0.3,
        cacheWriteInput: 3,
        output: 15,
        known: true,
      };
    }
    if (configuration.model.startsWith("kimi-k2.6")) {
      return {
        input: 0.95,
        cachedInput: 0.16,
        cacheWriteInput: 0.95,
        output: 4,
        known: true,
      };
    }
  }
  return {
    input: 0,
    cachedInput: 0,
    cacheWriteInput: 0,
    output: 0,
    known: false,
  };
}

function usageWithCost(
  configuration: ProviderConfiguration,
  inputUnits: number,
  outputUnits: number,
  cachedInputUnits = 0,
  cacheWriteInputUnits = 0,
  reasoningUnits = 0,
  reportedCostMicros: number | null = null,
): AiUsage {
  const normalizedInputUnits = Math.max(
    inputUnits,
    cachedInputUnits + cacheWriteInputUnits,
  );
  const rates = modelRates(configuration, normalizedInputUnits);
  const uncachedInputUnits = Math.max(
    0,
    normalizedInputUnits - cachedInputUnits - cacheWriteInputUnits,
  );
  // At per-million-token pricing, tokens * USD-per-million equals microdollars.
  const estimatedCostMicros =
    reportedCostMicros === null
      ? Math.max(
          0,
          Math.round(
            uncachedInputUnits * rates.input +
              cachedInputUnits * rates.cachedInput +
              cacheWriteInputUnits * rates.cacheWriteInput +
              outputUnits * rates.output,
          ),
        )
      : Math.max(0, Math.round(reportedCostMicros));
  return {
    inputUnits: normalizedInputUnits,
    outputUnits,
    cachedInputUnits,
    cacheWriteInputUnits,
    reasoningUnits,
    estimatedCostMicros,
    pricingKnown: reportedCostMicros !== null || rates.known,
    pricingVersion:
      reportedCostMicros === null
        ? PRICING_VERSION
        : `openrouter-reported-${PRICING_VERSION}`,
    costEstimated: reportedCostMicros === null && rates.known,
  };
}

/** Reprice stored provider usage with the same private rate table used live. */
export function priceReportedAiUsage(input: {
  provider: StoryholdProviderId;
  model: string;
  inputUnits: number;
  outputUnits: number;
  cachedInputUnits?: number;
  cacheWriteInputUnits?: number;
  reasoningUnits?: number;
  stage?: StoryholdInferenceStage;
}): AiUsage {
  return usageWithCost(
    {
      id: input.provider,
      label: PROVIDER_LABELS[input.provider],
      apiKey: "",
      model: input.model,
      supportsReasoningControl: false,
      eligibleForAdultNarration: false,
      stage: input.stage ?? "extraction",
    },
    input.inputUnits,
    input.outputUnits,
    input.cachedInputUnits,
    input.cacheWriteInputUnits,
    input.reasoningUnits,
  );
}

function estimatedInputUnits(input: GenerateAiTextInput): number {
  const text = [
    input.system,
    ...input.messages.map((message) => `${message.role}:${message.content}`),
  ].join("\n");
  // Provider tokenizers differ. This is deliberately conservative for the
  // pre-call hold; settlement always uses the provider's reported usage.
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 2.2) + 256);
}

/**
 * Maximum pre-call provider cost across every eligible request candidate.
 * This is an internal hold quote, never a customer-facing dollar amount.
 */
export function quoteAiCostReservation(
  input: GenerateAiTextInput,
): AiCostReservationQuote {
  const inputUnits = estimatedInputUnits(input);
  const maxOutputUnits = Math.max(1, input.maxOutputTokens ?? 2_000);
  const candidates = configurationsForInput(input).map((configuration) => {
    const rates = modelRates(configuration, inputUnits);
    const maximumCostMicros = rates.known
      ? Math.ceil(
          inputUnits * Math.max(rates.input, rates.cacheWriteInput) +
            maxOutputUnits * rates.output,
        )
      : 0;
    return {
      provider: configuration.id,
      model: configuration.model,
      maximumCostMicros,
      pricingKnown: rates.known,
    };
  });
  return {
    inputUnits,
    maxOutputUnits,
    maximumCostMicros: Math.max(
      0,
      ...candidates.map((candidate) => candidate.maximumCostMicros),
    ),
    pricingKnown:
      candidates.length > 0 &&
      candidates.every((candidate) => candidate.pricingKnown),
    candidates,
  };
}

function textFromCompatibleContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      if (
        (record.type === "text" || record.type === "output_text") &&
        typeof record.text === "string"
      )
        return record.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

type ProviderCallResult = {
  text: string;
  usage: AiUsage;
  resolvedModel: string;
  upstreamProvider: string | null;
};

class BillableProviderResponseError extends Error {
  constructor(
    message: string,
    public readonly result: ProviderCallResult,
  ) {
    super(message);
    this.name = "BillableProviderResponseError";
  }
}

async function callAnthropic(
  configuration: ProviderConfiguration,
  input: GenerateAiTextInput,
): Promise<ProviderCallResult> {
  const usesReplitManagedAnthropic =
    configuration.baseURL ===
    process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL?.trim();
  const omitsSamplingControls =
    /^(?:claude-(?:opus|sonnet)-5|claude-opus-4-(?:7|8))$/u.test(
      configuration.model,
    );
  const client = new Anthropic({
    apiKey: configuration.apiKey,
    ...(configuration.baseURL ? { baseURL: configuration.baseURL } : {}),
    ...(input.allowProviderFallback === false ? { maxRetries: 0 } : {}),
  });
  const result = await client.messages.create({
    model: configuration.model,
    max_tokens: usesReplitManagedAnthropic
      ? Math.max(input.maxOutputTokens ?? 8_192, 8_192)
      : input.maxOutputTokens ?? 2_000,
    ...(typeof input.temperature === "number" && !omitsSamplingControls
      ? { temperature: input.temperature }
      : {}),
    system: input.system,
    messages: input.messages,
  });
  const text = result.content
    .filter(
      (block): block is Anthropic.Messages.TextBlock => block.type === "text",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
  const usage = result.usage as unknown as Record<string, unknown>;
  const cacheReadInputUnits = numeric(usage.cache_read_input_tokens);
  const cacheWriteInputUnits = numeric(usage.cache_creation_input_tokens);
  const directInputUnits = numeric(usage.input_tokens);
  return {
    text,
    resolvedModel: configuration.model,
    upstreamProvider: configuration.label,
    usage: usageWithCost(
      configuration,
      directInputUnits + cacheReadInputUnits + cacheWriteInputUnits,
      numeric(usage.output_tokens),
      cacheReadInputUnits,
      cacheWriteInputUnits,
    ),
  };
}

async function callCompatible(
  configuration: ProviderConfiguration,
  input: GenerateAiTextInput,
  reasoning: ReasoningLevel,
): Promise<ProviderCallResult> {
  if (!configuration.chatUrl)
    throw new Error(`${configuration.label} has no chat endpoint.`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const body: Record<string, unknown> = {
      model: configuration.model,
      messages: [{ role: "system", content: input.system }, ...input.messages],
    };
    if (configuration.id === "openrouter") {
      body.provider = {
        ...OPENROUTER_PROVIDER_REQUIREMENTS,
        ...(input.allowProviderFallback === false ? { allow_fallbacks: false } : {}),
      };
      if (configuration.stage === "verification") {
        body.response_format = { type: "json_object" };
      }
      if (configuration.supportsReasoningControl) {
        body.reasoning = { effort: reasoning };
      }
    }
    if (configuration.id === "openai") {
      body.max_completion_tokens = input.maxOutputTokens ?? 2_000;
      body.reasoning_effort = reasoning;
    } else if (
      configuration.id === "kimi" &&
      configuration.model.startsWith("kimi-k3")
    ) {
      body.max_completion_tokens = input.maxOutputTokens ?? 2_000;
      body.reasoning_effort =
        reasoning === "low" ? "low" : reasoning === "medium" ? "high" : "max";
    } else {
      body.max_tokens = input.maxOutputTokens ?? 2_000;
      if (configuration.id === "xai") body.reasoning_effort = reasoning;
      if (configuration.id === "kimi" && typeof input.temperature === "number")
        body.temperature = input.temperature;
      if (
        configuration.id === "openrouter" &&
        typeof input.temperature === "number"
      )
        body.temperature = input.temperature;
    }
    const response = await fetch(configuration.chatUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${configuration.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
        ...configuration.extraHeaders,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      const requestId =
        response.headers.get("x-request-id") ||
        response.headers.get("request-id") ||
        response.headers.get("cf-ray");
      throw new Error(
        `${configuration.label} returned ${response.status}${
          requestId
            ? ` (request ${requestId.replace(/[^a-zA-Z0-9._:-]/gu, "").slice(0, 120)})`
            : ""
        }.`,
      );
    }
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const first = choices[0] as Record<string, unknown> | undefined;
    const message =
      first?.message && typeof first.message === "object"
        ? (first.message as Record<string, unknown>)
        : {};
    const text = textFromCompatibleContent(message.content);
    const reportedModel =
      typeof payload.model === "string" && payload.model.trim()
        ? payload.model.trim()
        : configuration.model;
    const routeMetadata =
      payload.metadata && typeof payload.metadata === "object"
        ? (payload.metadata as Record<string, unknown>)
        : {};
    const reportedUpstreamProvider =
      typeof payload.provider === "string"
        ? payload.provider
        : typeof routeMetadata.selected_provider === "string"
          ? routeMetadata.selected_provider
          : typeof routeMetadata.provider === "string"
            ? routeMetadata.provider
            : "";
    const upstreamProvider =
      configuration.id === "openrouter"
        ? reportedUpstreamProvider.trim()
          ? reportedUpstreamProvider.trim().slice(0, 160)
          : null
        : configuration.label;
    const usage =
      payload.usage && typeof payload.usage === "object"
        ? (payload.usage as Record<string, unknown>)
        : {};
    const promptDetails =
      usage.prompt_tokens_details &&
      typeof usage.prompt_tokens_details === "object"
        ? (usage.prompt_tokens_details as Record<string, unknown>)
        : {};
    const completionDetails =
      usage.completion_tokens_details &&
      typeof usage.completion_tokens_details === "object"
        ? (usage.completion_tokens_details as Record<string, unknown>)
        : {};
    const cachedInputUnits = numeric(
      promptDetails.cached_tokens ?? usage.cached_tokens,
    );
    const cacheWriteInputUnits = numeric(
      promptDetails.cache_creation_tokens ?? usage.cache_creation_input_tokens,
    );
    const reportedCostMicros =
      configuration.id === "openrouter"
        ? reportedUsdCostMicros(usage.cost)
        : null;
    const providerResult: ProviderCallResult = {
      text,
      resolvedModel: reportedModel,
      upstreamProvider,
      usage: usageWithCost(
        configuration,
        numeric(usage.prompt_tokens ?? usage.input_tokens),
        numeric(usage.completion_tokens ?? usage.output_tokens),
        cachedInputUnits,
        cacheWriteInputUnits,
        numeric(completionDetails.reasoning_tokens ?? usage.reasoning_tokens),
        reportedCostMicros,
      ),
    };
    if (
      configuration.id === "openrouter" &&
      reportedModel !== configuration.model
    ) {
      throw new BillableProviderResponseError(
        `OpenRouter resolved an unexpected model (${reportedModel.slice(0, 160)}).`,
        providerResult,
      );
    }
    return providerResult;
  } finally {
    clearTimeout(timeout);
  }
}

export class AiGatewayUnavailableError extends Error {
  constructor(
    message: string,
    public readonly attempts: string[] = [],
    public readonly billableAttempts: AiBillableAttempt[] = [],
    /** Undefined is intentionally not proof that every attempted charge is known. */
    public readonly hasUncertainOutcome?: boolean,
  ) {
    super(message);
    this.name = "AiGatewayUnavailableError";
  }
}

export async function generateAiText(
  input: GenerateAiTextInput,
): Promise<AiTextResult> {
  const contentMode = input.contentMode ?? "standard";
  const stage = inferenceStageFor(input.task, input.stage);
  const configurations = configurationsForInput(input);
  if (configurations.length === 0) {
    throw new AiGatewayUnavailableError(
      contentMode === "adult"
        ? "No eligible adult-fiction model provider is configured."
        : "No model provider is configured.",
    );
  }
  const reasoning = input.reasoning ?? chooseReasoningLevel(input.task);
  const attempts: string[] = [];
  const billableAttempts: AiBillableAttempt[] = [];
  let hasUncertainOutcome = false;
  for (const configuration of configurations) {
    const effectiveReasoning = reasoningForProvider(configuration, reasoning);
    let returnedResult: ProviderCallResult | null = null;
    try {
      const result =
        configuration.id === "anthropic"
          ? await callAnthropic(configuration, input)
          : await callCompatible(configuration, input, effectiveReasoning);
      returnedResult = result;
      if (!result.text)
        throw new Error("The provider returned an empty response.");
      input.validate?.(result.text);
      const runtime = getAiRuntimeStatus(input.task, contentMode, stage);
      return {
        text: result.text,
        runtime: {
          ...runtime,
          configured: true,
          mode: "connected",
          provider: configuration.id,
          model: configuration.model,
          billable: true,
          sendsSourceTextOffDevice: true,
          explanation: `${configuration.label} completed this operation. Storyhold validated the response before allowing any canonical write.`,
          stage,
          execution: {
            connectionId: `managed:${configuration.id}`,
            credentialSource: "environment",
            connectionSource: "storyhold_managed",
            billingSource: "storyhold_credits",
            requestedModel: configuration.model,
            resolvedModel: result.resolvedModel,
            upstreamProvider: result.upstreamProvider,
            privacyMode:
              configuration.id === "openrouter" ? "zero-data-retention" : null,
          },
        },
        provider: configuration.id,
        model: configuration.model,
        reasoning,
        usage: result.usage,
        priorBillableAttempts: [...billableAttempts],
      };
    } catch (error) {
      const billedResult = error instanceof BillableProviderResponseError
        ? error.result
        : returnedResult;
      if (billedResult) {
        billableAttempts.push({
          provider: configuration.id,
          model: configuration.model,
          resolvedModel: billedResult.resolvedModel,
          upstreamProvider: billedResult.upstreamProvider,
          stage,
          reasoning: effectiveReasoning,
          usage: billedResult.usage,
        });
      } else {
        // A dispatched request may have consumed tokens even if its response was
        // lost, unreadable, or rejected before usage could be captured.
        hasUncertainOutcome = true;
      }
      const message = error instanceof Error ? error.message : String(error);
      attempts.push(`${configuration.id}: ${message.slice(0, 500)}`);
      if (input.providerFailurePolicy === "stop") {
        throw new AiGatewayUnavailableError(
          "The Storyhold model connection failed or returned an invalid response. Automatic fallback is disabled for this operation.",
          attempts,
          billableAttempts,
          hasUncertainOutcome,
        );
      }
    }
  }
  throw new AiGatewayUnavailableError(
    "Every eligible Storyhold model connection failed or returned an invalid response.",
    attempts,
    billableAttempts,
    hasUncertainOutcome,
  );
}

export function chooseReasoningLevel(
  task: StoryholdAiTask,
  input: {
    playerAction?: string;
    resolutionMode?: string;
    activeActors?: number;
    hiddenEventCount?: number;
  } = {},
): ReasoningLevel {
  if (task === "world_analysis" || task === "canon_review") return "high";
  if (task === "memory_maintenance") return "medium";
  if (task === "demo_scene" || task === "campaign_narration") return "low";
  if (task === "story_adaptation") return "medium";

  const action = (input.playerAction ?? "").toLocaleLowerCase();
  const mechanicallyUncertain =
    /\b(attack|fight|shoot|stab|cast|hack|steal|sneak|escape|chase|persuade|deceive|intimidate|roll|gamble|risk|disarm|break in|pick the lock)\b/.test(
      action,
    );
  const triesToRewriteState =
    /\b(i (?:now |suddenly )?(?:have|am|get|gain)|retcon|rewrite|change canon|was always|give myself)\b/.test(
      action,
    );
  const complexScene =
    (input.activeActors ?? 0) >= 4 ||
    (input.hiddenEventCount ?? 0) >= 3 ||
    action.length > 700 ||
    (action.match(/\b(?:and|then|while|before|after)\b/g)?.length ?? 0) >= 4;
  if (
    input.resolutionMode === "tactical" ||
    mechanicallyUncertain ||
    triesToRewriteState ||
    complexScene
  )
    return "medium";
  return "low";
}

import { db, aiSettingsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import {
  AI_FUNCTIONS,
  AI_FUNCTION_GROUPS,
  ALLOWED_MODEL_IDS,
  type AiFunctionGroup,
  type AiFunctionKey,
  type CostTier,
  getAiFunctionMeta,
  getAiFunctionRouting,
  getDefaultDirective,
  isAiFunctionKey,
} from "./aiRegistry";

// Resolved view of a single AI function: registry metadata merged with the DB
// override row (if any). `directive` is what actually gets injected into the
// prompt; `directiveOverride` is the raw admin edit (null = using the default).
export interface ResolvedAiFunction {
  key: AiFunctionKey;
  label: string;
  description: string;
  group: AiFunctionGroup;
  degrade: string;
  placeholders: string[];
  enabled: boolean;
  defaultDirective: string;
  directiveOverride: string | null;
  directive: string;
  isOverridden: boolean;
  // Routing (from the registry, overlaid with the admin model override).
  defaultModel: string;
  modelOverride: string | null;
  model: string;
  costTier: CostTier;
  bulkEligible: boolean;
  usesWebSearch: boolean;
  usesImages: boolean;
  perAuthorModel: boolean;
}

interface CacheEntry {
  enabled: boolean;
  directiveOverride: string | null;
  modelOverride: string | null;
}

// In-memory cache of the ai_settings rows, keyed by function key. This is read
// on every LLM/image call (resolveDirective / isAiFunctionEnabled), so we avoid
// a DB round-trip per call. Single-server assumption (same as the rest of the
// pipeline) — a multi-instance deploy would see up to CACHE_TTL_MS of staleness
// after an edit on another instance. Writes on THIS instance invalidate
// immediately.
const CACHE_TTL_MS = 30_000;
let cache: Map<AiFunctionKey, CacheEntry> | null = null;
let cacheExpiresAt = 0;

function invalidateCache(): void {
  cache = null;
  cacheExpiresAt = 0;
}

async function loadCache(): Promise<Map<AiFunctionKey, CacheEntry>> {
  const now = Date.now();
  if (cache && now < cacheExpiresAt) return cache;
  const rows = await db.select().from(aiSettingsTable);
  const next = new Map<AiFunctionKey, CacheEntry>();
  for (const row of rows) {
    if (!isAiFunctionKey(row.key)) continue; // ignore stale/unknown keys
    next.set(row.key, {
      enabled: row.enabled,
      directiveOverride: row.directiveOverride,
      modelOverride: row.modelOverride ?? null,
    });
  }
  cache = next;
  cacheExpiresAt = now + CACHE_TTL_MS;
  return next;
}

function resolveOne(key: AiFunctionKey, entry: CacheEntry | undefined): ResolvedAiFunction {
  const meta = getAiFunctionMeta(key);
  const routing = getAiFunctionRouting(key);
  const override = entry?.directiveOverride ?? null;
  const trimmedOverride = override && override.trim().length > 0 ? override : null;
  // A model override only applies to text (routable) functions and must be a
  // known model id; anything else falls back to the registry default model.
  const rawModelOverride = entry?.modelOverride ?? null;
  const modelOverride =
    !routing.usesImages && rawModelOverride && ALLOWED_MODEL_IDS.has(rawModelOverride) ? rawModelOverride : null;
  return {
    key,
    label: meta.label,
    description: meta.description,
    group: meta.group,
    degrade: meta.degrade,
    placeholders: meta.placeholders ?? [],
    enabled: entry?.enabled ?? true,
    defaultDirective: meta.defaultDirective,
    directiveOverride: trimmedOverride,
    directive: trimmedOverride ?? meta.defaultDirective,
    isOverridden: trimmedOverride !== null,
    defaultModel: routing.defaultModel,
    modelOverride,
    model: modelOverride ?? routing.defaultModel,
    costTier: routing.costTier,
    bulkEligible: routing.bulkEligible,
    usesWebSearch: routing.usesWebSearch,
    usesImages: routing.usesImages,
    perAuthorModel: routing.perAuthorModel ?? false,
  };
}

export interface AiSettingsView {
  groups: { id: AiFunctionGroup; label: string; description: string }[];
  functions: ResolvedAiFunction[];
}

// Full merged view for the admin UI: every registry function in declaration
// order, with its current enabled flag + resolved directive.
export async function getAiSettings(): Promise<AiSettingsView> {
  const entries = await loadCache();
  return {
    groups: AI_FUNCTION_GROUPS,
    functions: AI_FUNCTIONS.map((f) => resolveOne(f.key, entries.get(f.key))),
  };
}

export async function getAiFunction(key: AiFunctionKey): Promise<ResolvedAiFunction> {
  const entries = await loadCache();
  return resolveOne(key, entries.get(key));
}

export interface UpdateAiSettingPatch {
  enabled?: boolean;
  // Directive override. A non-empty string sets the override; an empty/whitespace
  // string OR null clears it (revert to the registry default).
  directive?: string | null;
  // Model override. A known text-model id routes this function to that model; an
  // empty string, null, an unknown id, or an id set on an image function clears
  // it (revert to the registry default model).
  model?: string | null;
}

// Upsert the row for `key`, touching only the provided fields. Returns the new
// resolved view and invalidates the cache so subsequent reads are fresh.
export async function updateAiSetting(
  key: AiFunctionKey,
  patch: UpdateAiSettingPatch,
): Promise<ResolvedAiFunction> {
  const insert: {
    key: AiFunctionKey;
    enabled?: boolean;
    directiveOverride?: string | null;
    modelOverride?: string | null;
  } = { key };
  const set: Record<string, unknown> = { updatedAt: sql`now()` };
  if (patch.enabled !== undefined) {
    insert.enabled = patch.enabled;
    set.enabled = patch.enabled;
  }
  if (patch.directive !== undefined) {
    const normalized = patch.directive && patch.directive.trim().length > 0 ? patch.directive : null;
    insert.directiveOverride = normalized;
    set.directiveOverride = normalized;
  }
  if (patch.model !== undefined) {
    const routing = getAiFunctionRouting(key);
    const trimmed = typeof patch.model === "string" ? patch.model.trim() : null;
    // Reject overrides for image functions or unknown model ids — store null.
    const normalized = !routing.usesImages && trimmed && ALLOWED_MODEL_IDS.has(trimmed) ? trimmed : null;
    insert.modelOverride = normalized;
    set.modelOverride = normalized;
  }
  await db
    .insert(aiSettingsTable)
    .values(insert)
    .onConflictDoUpdate({ target: aiSettingsTable.key, set });
  invalidateCache();
  return getAiFunction(key);
}

// Clear the directive override (revert to registry default) without touching the
// enabled flag.
export async function resetAiSetting(key: AiFunctionKey): Promise<ResolvedAiFunction> {
  return updateAiSetting(key, { directive: null });
}

// Hot-path helpers used by llm.ts / heroImage.ts. These must never throw on a
// missing row — a fresh DB simply yields "enabled, default directive".

export async function resolveDirective(key: AiFunctionKey): Promise<string> {
  try {
    const entries = await loadCache();
    const override = entries.get(key)?.directiveOverride;
    if (override && override.trim().length > 0) return override;
  } catch {
    // On any read failure, fall back to the registry default so generation
    // never breaks because the settings table is unavailable.
  }
  return getDefaultDirective(key);
}

export async function isAiFunctionEnabled(key: AiFunctionKey): Promise<boolean> {
  try {
    const entries = await loadCache();
    return entries.get(key)?.enabled ?? true;
  } catch {
    // Fail open: if we can't read the table, keep the function running.
    return true;
  }
}

// Resolve the model a text function should call: the admin override when set to a
// known text-model id, otherwise the registry default. Never throws — on any
// read failure it falls back to the registry default so generation never breaks
// because the settings table is unavailable. NOTE: draft_generation and
// block_regeneration pick their model per-author (authorModel) and do NOT call
// this; the override here is ignored for them by design.
export async function resolveModel(key: AiFunctionKey): Promise<string> {
  const routing = getAiFunctionRouting(key);
  try {
    const entries = await loadCache();
    const override = entries.get(key)?.modelOverride;
    if (!routing.usesImages && override && ALLOWED_MODEL_IDS.has(override)) return override;
  } catch {
    // fall through to default
  }
  return routing.defaultModel;
}

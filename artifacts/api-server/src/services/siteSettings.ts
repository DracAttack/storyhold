import {
  db,
  siteSettingsTable,
  type SourceLinkInsertionMode,
  type DraftResearchMode,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";

const GLOBAL_ID = "global";

export interface SiteSettingsValues {
  adsEnabled: boolean;
  pipelineEnabled: boolean;
  dedupeScanEnabled: boolean;
  weeklyNewsletterEnabled: boolean;
  dailyDigestEnabled: boolean;
  socialAutoPostEnabled: boolean;
  socialQueueActivated: boolean;
  socialQueuePaused: boolean;
  memeQueueActivated: boolean;
  memeQueuePaused: boolean;
  // Content-generation timing / triggers
  contentActiveStartHour: number;
  contentActiveEndHour: number;
  approvedIdeaCap: number;
  // Publishing / maintenance loop
  publishCheckMinutes: number;
  autoApproveEnabled: boolean;
  autoApproveHours: number;
  autoLockEnabled: boolean;
  autoLockHours: number;
  // Weekly newsletter schedule (UTC)
  weeklyNewsletterWeekday: number;
  weeklyNewsletterHour: number;
  // Dedup scan schedule (UTC)
  dedupeScanHour: number;
  dedupeScanFrequency: string;
  dedupeScanWeekday: number;
  // Source Vault automatic observer (discovery + clustering freshness)
  sourceDiscoveryEnabled: boolean;
  sourceFreshnessDefaultDays: number;
  // Per-beat/sub-beat freshness overrides (slug → days). Empty = use default.
  sourceFreshnessByBeat: Record<string, number>;
  // Domain allowlist for Perplexity-based lead discovery (bare hostnames, e.g.
  // "reuters.com"). Empty = no filter — Perplexity searches the open web.
  // Applies to both the scheduled automatic discovery pass and the manual
  // "Discover leads" search in the admin UI.
  sourceDiscoveryAllowedDomains: string[];
  // Hot-marker source harvest (Task #236). Master on/off (default off), plus the
  // buzz thresholds that make a marker/topic "hot": a single marker at
  // observationCount >= hotMarkerObservationThreshold, or a topic seen across
  // >= hotMarkerPlatformThreshold distinct platforms.
  hotMarkerHarvestEnabled: boolean;
  hotMarkerObservationThreshold: number;
  hotMarkerPlatformThreshold: number;
  // Source-link insertion strategy (Task #226): off / vault_only /
  // vault_first_with_capped_search / legacy_web_search.
  sourceLinkInsertionMode: SourceLinkInsertionMode;
  // Draft research mode (Task #233): vault_required /
  // vault_first_harvest_if_needed / legacy_web_search.
  draftResearchMode: DraftResearchMode;
  // Concept Explainer & Glossary (Task #284).
  conceptExplainersEnabled: boolean;
  // LLM detection confidence gate — concepts below this score are discarded.
  conceptDetectionThreshold: number;
  // Definition + verification confidence gate — concepts below this score
  // stay in 'draft' status and are never shown to readers.
  conceptDefinitionThreshold: number;
  // Density caps: max annotated concepts per article (normal vs >2500-word long).
  conceptDensityMaxDefault: number;
  conceptDensityMaxLong: number;
  // Term of the Day — daily glossary post to Facebook via Zernio.
  termOfDayEnabled: boolean;
  termOfDayDraftOnly: boolean;
  termOfDayHourUtc: number;
  /** Optional second daily posting hour (UTC); null disables the second slot. */
  termOfDayHour2Utc: number | null;
  termOfDayCooldownDays: number;
  termOfDayMinArticles: number;
  termOfDayMaxHashtags: number;
  termOfDayIncludedBeats: string[];
  termOfDayExcludedBeats: string[];
  termOfDayExcludedModuleTypes: string[];
  termOfDayImageEnabled: boolean;
  termOfDayGeneralInterestStrength: number;
  termOfDayTechnicalPenaltyStrength: number;
  termOfDayBeatWindow: number;
  termOfDayEngagementWeighting: boolean;
  // Semantic cluster reconciler (Task #330)
  semanticClusterReconcileEnabled: boolean;
  reconcileJaccardLow: number;
  reconcileJaccardHigh: number;
  // Trend auto-injection
  trendAutoInjectEnabled: boolean;
  trendAutoInjectMinUrgency: number;
  // Publish-gate dedupe
  publishGateDedupeEnabled: boolean;
}

type SettingsRow = typeof siteSettingsTable.$inferSelect;

function rowToValues(r: SettingsRow): SiteSettingsValues {
  return {
    adsEnabled: r.adsEnabled,
    pipelineEnabled: r.pipelineEnabled,
    dedupeScanEnabled: r.dedupeScanEnabled,
    weeklyNewsletterEnabled: r.weeklyNewsletterEnabled,
    dailyDigestEnabled: r.dailyDigestEnabled,
    socialAutoPostEnabled: r.socialAutoPostEnabled,
    socialQueueActivated: r.socialQueueActivated,
    socialQueuePaused: r.socialQueuePaused,
    memeQueueActivated: r.memeQueueActivated,
    memeQueuePaused: r.memeQueuePaused,
    contentActiveStartHour: r.contentActiveStartHour,
    contentActiveEndHour: r.contentActiveEndHour,
    approvedIdeaCap: r.approvedIdeaCap,
    publishCheckMinutes: r.publishCheckMinutes,
    autoApproveEnabled: r.autoApproveEnabled,
    autoApproveHours: r.autoApproveHours,
    autoLockEnabled: r.autoLockEnabled,
    autoLockHours: r.autoLockHours,
    weeklyNewsletterWeekday: r.weeklyNewsletterWeekday,
    weeklyNewsletterHour: r.weeklyNewsletterHour,
    dedupeScanHour: r.dedupeScanHour,
    dedupeScanFrequency: r.dedupeScanFrequency,
    dedupeScanWeekday: r.dedupeScanWeekday,
    sourceDiscoveryEnabled: r.sourceDiscoveryEnabled,
    sourceFreshnessDefaultDays: r.sourceFreshnessDefaultDays,
    sourceFreshnessByBeat: (r.sourceFreshnessByBeat ?? {}) as Record<string, number>,
    sourceDiscoveryAllowedDomains: (r.sourceDiscoveryAllowedDomains ?? []) as string[],
    hotMarkerHarvestEnabled: r.hotMarkerHarvestEnabled,
    hotMarkerObservationThreshold: r.hotMarkerObservationThreshold,
    hotMarkerPlatformThreshold: r.hotMarkerPlatformThreshold,
    sourceLinkInsertionMode: r.sourceLinkInsertionMode,
    draftResearchMode: r.draftResearchMode,
    conceptExplainersEnabled: r.conceptExplainersEnabled,
    conceptDetectionThreshold: r.conceptDetectionThreshold,
    conceptDefinitionThreshold: r.conceptDefinitionThreshold,
    conceptDensityMaxDefault: r.conceptDensityMaxDefault,
    conceptDensityMaxLong: r.conceptDensityMaxLong,
    termOfDayEnabled: r.termOfDayEnabled,
    termOfDayDraftOnly: r.termOfDayDraftOnly,
    termOfDayHourUtc: r.termOfDayHourUtc,
    termOfDayHour2Utc: r.termOfDayHour2Utc ?? null,
    termOfDayCooldownDays: r.termOfDayCooldownDays,
    termOfDayMinArticles: r.termOfDayMinArticles,
    termOfDayMaxHashtags: r.termOfDayMaxHashtags,
    termOfDayIncludedBeats: (r.termOfDayIncludedBeats ?? []) as string[],
    termOfDayExcludedBeats: (r.termOfDayExcludedBeats ?? []) as string[],
    termOfDayExcludedModuleTypes: (r.termOfDayExcludedModuleTypes ?? []) as string[],
    termOfDayImageEnabled: r.termOfDayImageEnabled,
    termOfDayGeneralInterestStrength: r.termOfDayGeneralInterestStrength,
    termOfDayTechnicalPenaltyStrength: r.termOfDayTechnicalPenaltyStrength,
    termOfDayBeatWindow: r.termOfDayBeatWindow,
    termOfDayEngagementWeighting: r.termOfDayEngagementWeighting,
    semanticClusterReconcileEnabled: r.semanticClusterReconcileEnabled,
    reconcileJaccardLow: r.reconcileJaccardLow,
    reconcileJaccardHigh: r.reconcileJaccardHigh,
    trendAutoInjectEnabled: r.trendAutoInjectEnabled,
    trendAutoInjectMinUrgency: r.trendAutoInjectMinUrgency,
    publishGateDedupeEnabled: r.publishGateDedupeEnabled,
  };
}

// Defaults mirror the schema/seed defaults and the previously-hardcoded behavior.
const DEFAULTS: SiteSettingsValues = {
  adsEnabled: true,
  pipelineEnabled: true,
  dedupeScanEnabled: true,
  weeklyNewsletterEnabled: true,
  dailyDigestEnabled: true,
  socialAutoPostEnabled: true,
  socialQueueActivated: false,
  socialQueuePaused: false,
  memeQueueActivated: false,
  memeQueuePaused: false,
  contentActiveStartHour: 0,
  contentActiveEndHour: 23,
  approvedIdeaCap: 20,
  publishCheckMinutes: 2,
  autoApproveEnabled: true,
  autoApproveHours: 48,
  autoLockEnabled: true,
  autoLockHours: 48,
  weeklyNewsletterWeekday: 0,
  weeklyNewsletterHour: 13,
  dedupeScanHour: 9,
  dedupeScanFrequency: "daily",
  dedupeScanWeekday: 1,
  sourceDiscoveryEnabled: false,
  sourceFreshnessDefaultDays: 7,
  sourceFreshnessByBeat: {},
  sourceDiscoveryAllowedDomains: [],
  hotMarkerHarvestEnabled: false,
  hotMarkerObservationThreshold: 3,
  hotMarkerPlatformThreshold: 2,
  sourceLinkInsertionMode: "vault_first_with_capped_search",
  draftResearchMode: "vault_first_harvest_if_needed",
  conceptExplainersEnabled: true,
  conceptDetectionThreshold: 0.72,
  conceptDefinitionThreshold: 0.78,
  conceptDensityMaxDefault: 8,
  conceptDensityMaxLong: 12,
  termOfDayEnabled: false,
  termOfDayDraftOnly: false,
  termOfDayHourUtc: 15,
  termOfDayHour2Utc: 1,
  termOfDayCooldownDays: 365,
  termOfDayMinArticles: 1,
  termOfDayMaxHashtags: 7,
  termOfDayIncludedBeats: [],
  termOfDayExcludedBeats: [],
  termOfDayExcludedModuleTypes: [],
  termOfDayImageEnabled: true,
  termOfDayGeneralInterestStrength: 1,
  termOfDayTechnicalPenaltyStrength: 1,
  termOfDayBeatWindow: 14,
  termOfDayEngagementWeighting: true,
  semanticClusterReconcileEnabled: false,
  reconcileJaccardLow: 0.08,
  reconcileJaccardHigh: 0.18,
  trendAutoInjectEnabled: false,
  trendAutoInjectMinUrgency: 5,
  publishGateDedupeEnabled: true,
};

// Read the single global settings row, creating it (everything enabled by
// default) on first access so behavior is unchanged on a fresh database.
export async function getSiteSettings(): Promise<SiteSettingsValues> {
  const [existing] = await db
    .select()
    .from(siteSettingsTable)
    .where(eq(siteSettingsTable.id, GLOBAL_ID))
    .limit(1);
  if (existing) return rowToValues(existing);
  const [created] = await db
    .insert(siteSettingsTable)
    .values({ id: GLOBAL_ID })
    .onConflictDoNothing()
    .returning();
  return created ? rowToValues(created) : { ...DEFAULTS };
}

// Upsert only the provided fields, leaving any omitted setting untouched.
export async function updateSiteSettings(
  patch: Partial<SiteSettingsValues>,
): Promise<SiteSettingsValues> {
  const set: Record<string, unknown> = { updatedAt: sql`now()` };
  for (const key of Object.keys(patch) as (keyof SiteSettingsValues)[]) {
    if (patch[key] !== undefined) set[key] = patch[key];
  }
  const [row] = await db
    .insert(siteSettingsTable)
    .values({ id: GLOBAL_ID, ...patch })
    .onConflictDoUpdate({ target: siteSettingsTable.id, set })
    .returning();
  return rowToValues(row!);
}

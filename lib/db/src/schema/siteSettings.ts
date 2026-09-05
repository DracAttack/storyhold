import { pgTable, text, boolean, timestamp, integer, jsonb, real } from "drizzle-orm/pg-core";

// Source-link insertion strategy (Task #226). Controls how external SOURCE
// citations are chosen for BOTH draft-time linking and admin/backfill linking
// (one shared, mode-aware path). off = add no source links; vault_only = only
// packet sources / Source Vault / existing BrainHook sources, never web_search;
// vault_first_with_capped_search = packet → vault → existing → capped web_search
// for still-unsupported claims; legacy_web_search = preserve the original
// web-search-first behavior for rollback.
export const SOURCE_LINK_INSERTION_MODES = [
  "off",
  "vault_only",
  "vault_first_with_capped_search",
  "legacy_web_search",
] as const;
export type SourceLinkInsertionMode = (typeof SOURCE_LINK_INSERTION_MODES)[number];

// Draft research mode (Task #233). Controls how EVERY draft gets its grounding.
// vault_required = always auto-build an evidence packet from the Source Vault and
// draft from it; if the vault is too weak, HOLD the idea as needs_sources (never
// live web search). vault_first_harvest_if_needed (prod default) = same, but on a
// weak vault run a controlled Source Harvest first and retry grounding once, then
// hold if still weak. legacy_web_search = emergency override only: fall back to
// the old web-search-grounded draft path for a non-packet idea.
export const DRAFT_RESEARCH_MODES = [
  "vault_required",
  "vault_first_harvest_if_needed",
  "legacy_web_search",
] as const;
export type DraftResearchMode = (typeof DRAFT_RESEARCH_MODES)[number];

// Global, site-wide settings. A single row (id = "global") holds flags that
// apply to every visitor — not per-admin like `admin_settings`. Currently just
// a master on/off switch for all ad spots on the public site.
export const siteSettingsTable = pgTable("site_settings", {
  id: text("id").primaryKey().default("global"),
  adsEnabled: boolean("ads_enabled").notNull().default(true),
  // Master on/off switch for the automated content pipeline (idea generation +
  // drafting). When false, the hourly cron run is skipped; manual "Run pipeline
  // now" and publishing of already-scheduled articles are unaffected.
  pipelineEnabled: boolean("pipeline_enabled").notNull().default(true),
  // Master on/off switch for the daily AI dedup scan. When false, the daily
  // 09:00 UTC cron is skipped (saves the per-pair LLM compute); the manual
  // "Scan now" button on /admin/duplicates still works.
  dedupeScanEnabled: boolean("dedupe_scan_enabled").notNull().default(true),
  // Master on/off switch for the automated weekly newsletter blast. When false,
  // the Saturday 15:00 UTC cron is skipped; manual test sends are unaffected.
  weeklyNewsletterEnabled: boolean("weekly_newsletter_enabled").notNull().default(true),
  // Master on/off switch for the post-pipeline admin editorial digest. When
  // false, the digest is not generated/stored after the daily pipeline run.
  dailyDigestEnabled: boolean("daily_digest_enabled").notNull().default(true),
  // Master on/off switch for auto-posting newly-published articles to Facebook
  // (via Zernio). When true AND Zernio is configured (ZERNIO_API_KEY +
  // ZERNIO_FACEBOOK_ACCOUNT_ID secrets), each article published by the automated
  // cadence is posted to the connected Facebook Page. The manual admin
  // "Post to Facebook" button is unaffected by this flag.
  socialAutoPostEnabled: boolean("social_auto_post_enabled").notNull().default(true),
  // --- Facebook back-catalogue posting QUEUE (separate from the instant
  // auto-post above). The queue drips OLDER published articles to Facebook one
  // per scheduled slot. It stays DORMANT until an admin tests the Zernio
  // connection and approves it by flipping this flag on — protecting against an
  // accidental blast of the entire back catalogue on first deploy.
  socialQueueActivated: boolean("social_queue_activated").notNull().default(false),
  // Operator pause for the queue: when true the slot scheduler skips posting
  // (instant auto-post + manual button are unaffected). Distinct from per-item
  // "paused" status. Defaults off (running) so resuming is the no-op state.
  socialQueuePaused: boolean("social_queue_paused").notNull().default(false),

  // --- Manual MEME posting cadence (separate from the article-link queue
  // above). Memes an admin builds + approves are posted to Facebook on their own
  // daily slots. Stays DORMANT until an admin activates it, guarding against an
  // accidental blast on first deploy. Distinct flags so the two cadences are
  // controlled independently and never collide.
  memeQueueActivated: boolean("meme_queue_activated").notNull().default(false),
  // Operator pause for the meme cadence: when true the meme slot scheduler skips
  // posting. Defaults off (running) so resuming is the no-op state.
  memeQueuePaused: boolean("meme_queue_paused").notNull().default(false),

  // --- Content-generation pipeline timing / triggers ---
  // Active-hours window (UTC, inclusive) during which the automated content
  // pipeline may generate ideas/drafts. Authors whose runHourUtc falls outside
  // the window are skipped that hour. Default 0–23 = all day (current behavior).
  // The window may wrap (start > end), e.g. 22→6 for overnight-only generation.
  contentActiveStartHour: integer("content_active_start_hour").notNull().default(0),
  contentActiveEndHour: integer("content_active_end_hour").notNull().default(23),
  // Per-author bank cap of `approved` (ready-to-draft) ideas; generation stops
  // for an author once they hit this. Mirrors MAX_APPROVED_IDEAS default.
  approvedIdeaCap: integer("approved_idea_cap").notNull().default(20),

  // --- Publishing / maintenance loop timing / triggers ---
  // How often (minutes) the maintenance loop runs (auto-approve stale ideas,
  // auto-lock stale drafts, publish due articles). Default 2 = current behavior.
  publishCheckMinutes: integer("publish_check_minutes").notNull().default(2),
  // Auto-approve unattended pending ideas after this many hours (and a toggle).
  autoApproveEnabled: boolean("auto_approve_enabled").notNull().default(true),
  autoApproveHours: integer("auto_approve_hours").notNull().default(48),
  // Auto-lock unattended drafts into their slot after this many hours (+ toggle).
  autoLockEnabled: boolean("auto_lock_enabled").notNull().default(true),
  autoLockHours: integer("auto_lock_hours").notNull().default(48),

  // --- Weekly newsletter schedule (UTC) ---
  // Day-of-week (0=Sun … 6=Sat) and hour the weekly blast fires.
  // Default Sun 13:00 UTC = 6:00 AM Phoenix/MST (Arizona, no DST).
  weeklyNewsletterWeekday: integer("weekly_newsletter_weekday").notNull().default(0),
  weeklyNewsletterHour: integer("weekly_newsletter_hour").notNull().default(13),

  // --- Daily/weekly dedup scan schedule (UTC) ---
  // Hour the dedup scan fires, its frequency ("daily" | "weekly"), and the
  // weekday used when frequency is "weekly". Default 09:00 daily.
  dedupeScanHour: integer("dedupe_scan_hour").notNull().default(9),
  dedupeScanFrequency: text("dedupe_scan_frequency").notNull().default("daily"),
  dedupeScanWeekday: integer("dedupe_scan_weekday").notNull().default(1),

  // --- Source Vault automatic observer (Task #199) ---
  // Master on/off switch for scheduled source discovery (per-beat lead
  // gathering → vault ingest → clustering). When false the discovery + cluster
  // cron steps are skipped; the vault stays purely manually-fed.
  sourceDiscoveryEnabled: boolean("source_discovery_enabled").notNull().default(false),
  // Default freshness window (days) after which an ingested source no longer
  // counts as "fresh" for clustering/recency, used when a beat has no override.
  sourceFreshnessDefaultDays: integer("source_freshness_default_days").notNull().default(7),
  // Per-beat / sub-beat freshness overrides, keyed by beat/sub-beat slug →
  // window in days. Empty map = every beat uses the default above.
  sourceFreshnessByBeat: jsonb("source_freshness_by_beat")
    .$type<Record<string, number>>()
    .notNull()
    .default({}),
  // Allowlist of domains the discovery Perplexity search is restricted to.
  // Each entry is a bare hostname (e.g. "reuters.com"). Empty = no filter —
  // Perplexity searches the open web. Applies to both the scheduled automatic
  // discovery pass and the manual "Discover leads" search in the admin UI.
  sourceDiscoveryAllowedDomains: jsonb("source_discovery_allowed_domains")
    .$type<string[]>()
    .notNull()
    .default([]),

  // --- Hot-marker source harvest (Task #236) ---
  // When true, the cron tick turns HOT trend-marker topics (buzz that crosses
  // the thresholds below) into cheap, bounded, topic-scoped source harvests:
  // Source Vault first (free), then Perplexity restricted to
  // sourceDiscoveryAllowedDomains (budget-gated), querying by the marker's
  // TOPIC (title/snippet/beat) — never the social URL. Default OFF (fail-closed).
  hotMarkerHarvestEnabled: boolean("hot_marker_harvest_enabled").notNull().default(false),
  // A single marker whose observationCount reaches this is "hot" on its own.
  hotMarkerObservationThreshold: integer("hot_marker_observation_threshold").notNull().default(3),
  // A topic seen across this many DISTINCT social platforms is "hot" as a group.
  hotMarkerPlatformThreshold: integer("hot_marker_platform_threshold").notNull().default(2),

  // --- Source-link insertion strategy (Task #226) ---
  // How external SOURCE citations are chosen for both draft-time and admin
  // backfill linking (one shared, mode-aware, vault-first path). Prod default
  // is vault_first_with_capped_search; the resolver additionally downgrades any
  // web-search-capable mode to vault_only in dev unless explicitly enabled, so
  // dev cron never spends on paid source-link web search.
  sourceLinkInsertionMode: text("source_link_insertion_mode", {
    enum: SOURCE_LINK_INSERTION_MODES,
  })
    .notNull()
    .default("vault_first_with_capped_search"),

  // --- Draft research mode (Task #233) ---
  // How every draft is grounded. vault_required / vault_first_harvest_if_needed
  // (prod default) auto-build an evidence packet from the Source Vault and never
  // let the drafter web-search; legacy_web_search is an emergency override that
  // restores the old web-search-grounded draft path for non-packet ideas. The
  // resolver additionally downgrades legacy_web_search to vault_required in dev
  // unless explicitly opted in, so dev never spends on live draft-time search.
  draftResearchMode: text("draft_research_mode", {
    enum: DRAFT_RESEARCH_MODES,
  })
    .notNull()
    .default("vault_first_harvest_if_needed"),

  // --- Concept Explainer & Glossary (Task #284) ---
  // Master on/off switch for the concept explainer feature. When false, no
  // annotations are shown on the site and the pipeline does not run. The admin
  // backfill and manual process triggers are unaffected.
  conceptExplainersEnabled: boolean("concept_explainers_enabled").notNull().default(true),
  // Minimum LLM detection confidence (0–1) for a term to be stored as a mention.
  // Terms below this threshold are silently discarded.
  conceptDetectionThreshold: real("concept_detection_threshold").notNull().default(0.72),
  // Minimum definition-generation confidence (0–1) for a concept to be auto-published
  // (status = "live"). Below this the concept stays in "draft" for admin review.
  conceptDefinitionThreshold: real("concept_definition_threshold").notNull().default(0.78),
  // Density caps — max annotated concepts per article (first occurrence only).
  // Default cap applies to normal-length articles; the long cap kicks in above
  // ~2500 words.
  conceptDensityMaxDefault: integer("concept_density_max_default").notNull().default(8),
  conceptDensityMaxLong: integer("concept_density_max_long").notNull().default(12),

  // --- Term of the Day (daily glossary post to Facebook via Zernio) ---------
  // Master on/off switch. Dormant by default so first deploy never surprises.
  termOfDayEnabled: boolean("term_of_day_enabled").notNull().default(false),
  // When true, the daily run stops at a "draft" history row (caption + card
  // built, nothing sent to Zernio) for admin review; when false posts go out
  // automatically.
  termOfDayDraftOnly: boolean("term_of_day_draft_only").notNull().default(false),
  // Hour of the day (UTC) the daily post fires. Default 18:00 UTC = 11:00 AM
  // Phoenix (America/Phoenix, no DST) — the publication's configured timezone.
  termOfDayHourUtc: integer("term_of_day_hour_utc").notNull().default(18),
  // Optional SECOND daily posting hour (UTC); NULL disables the second slot.
  // Default 1:00 UTC = 6:00 PM Phoenix — a free evening gap between the meme
  // slots (23/2 UTC) and the last drip slot (3 UTC).
  termOfDayHour2Utc: integer("term_of_day_hour2_utc").default(1),
  // A term is ineligible for this many days after being posted.
  termOfDayCooldownDays: integer("term_of_day_cooldown_days").notNull().default(365),
  // Minimum connected published BrainHook articles for eligibility.
  termOfDayMinArticles: integer("term_of_day_min_articles").notNull().default(1),
  // Cap on hashtags per post (spec max 7, always includes the 2 brand tags).
  termOfDayMaxHashtags: integer("term_of_day_max_hashtags").notNull().default(7),
  // Optional beat allowlist (category slugs). Empty = all beats eligible.
  termOfDayIncludedBeats: jsonb("term_of_day_included_beats")
    .$type<string[]>()
    .notNull()
    .default([]),
  // Beat denylist (category slugs). Applied after the allowlist.
  termOfDayExcludedBeats: jsonb("term_of_day_excluded_beats")
    .$type<string[]>()
    .notNull()
    .default([]),
  // Concept module types (behavioral/medical/technical/general) excluded outright.
  termOfDayExcludedModuleTypes: jsonb("term_of_day_excluded_module_types")
    .$type<string[]>()
    .notNull()
    .default([]),
  // Attach the branded (template, non-AI) glossary card image to the post.
  termOfDayImageEnabled: boolean("term_of_day_image_enabled").notNull().default(true),
  // Multiplier on the general-interest additive bonuses (1 = spec defaults).
  termOfDayGeneralInterestStrength: real("term_of_day_general_interest_strength")
    .notNull()
    .default(1),
  // Strength of the technical/administrative penalties: 1 = spec multipliers,
  // 0 = penalties disabled (each multiplier is blended toward 1 by this factor).
  termOfDayTechnicalPenaltyStrength: real("term_of_day_technical_penalty_strength")
    .notNull()
    .default(1),
  // How many recent posts the beat-balancing window looks at.
  termOfDayBeatWindow: integer("term_of_day_beat_window").notNull().default(14),
  // Include the capped engagement-history bonus in weighting.
  termOfDayEngagementWeighting: boolean("term_of_day_engagement_weighting")
    .notNull()
    .default(true),

  // --- Semantic cluster reconciler (Task #330) ---------------------------
  // When true, after each lexical clustering pass an LLM judge evaluates
  // borderline cluster pairs (Jaccard 0.08–0.18) within the same beat and
  // merges confirmed same-story duplicates. Default OFF to control LLM spend.
  semanticClusterReconcileEnabled: boolean("semantic_cluster_reconcile_enabled")
    .notNull()
    .default(false),
  // Configurable borderline Jaccard window [low, high] for the reconciler.
  // Pair scores below low are "clearly distinct" (skipped); above high are
  // "clearly same" (merged lexically without LLM). Window [0.08, 0.18] default.
  reconcileJaccardLow: real("reconcile_jaccard_low").notNull().default(0.08),
  reconcileJaccardHigh: real("reconcile_jaccard_high").notNull().default(0.18),

  // --- Trend auto-injection ---
  // When true, the daily cron automatically sends qualifying "new" trend signals
  // (urgencyScore >= trendAutoInjectMinUrgency) into the approved-ideas queue
  // without requiring an editor to click "Send to ideas". Signals that fail
  // (author-cap hit, no covering author, already processed) are silently skipped
  // and remain "new" for the editor to handle manually.
  trendAutoInjectEnabled: boolean("trend_auto_inject_enabled").notNull().default(false),
  trendAutoInjectMinUrgency: integer("trend_auto_inject_min_urgency").notNull().default(5),

  // --- Story Watch (Task #348) ---
  // When the editor last viewed the "Watched Stories" section in the Editor
  // Cockpit. Used to compute "new documents since last viewed" badges.
  watchedLastViewedAt: timestamp("watched_last_viewed_at", { withTimezone: true }),

  // --- Publish-gate dedupe ---
  // When true, each article scheduled for publication is checked against the
  // existing catalog before it goes live. Near-duplicates are quarantined and a
  // reassignment-redraft job is started automatically (new author, adjacent
  // sub-beat, re-drafted from scratch). Disable only for emergency publishing.
  publishGateDedupeEnabled: boolean("publish_gate_dedupe_enabled").notNull().default(true),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SiteSettings = typeof siteSettingsTable.$inferSelect;

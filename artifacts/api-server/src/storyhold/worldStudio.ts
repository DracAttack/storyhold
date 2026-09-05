import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StoryholdDb } from "./postgresAdapter";
import express, {
  type Express,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { toChicagoTitleCase } from "@workspace/content-utils";
import { chunkText } from "../services/sourceChunk";
import {
  detectDocumentType,
  DocumentExtractionError,
  extractDocumentText,
  type DocumentType,
} from "../services/documentExtract";
import { checkRobots, fetchAndExtract } from "../services/sourceFetch";
import {
  discoverStoryholdLore,
  isStoryholdLoreSearchConfigured,
} from "./referenceDiscovery";
import {
  AiGatewayUnavailableError,
  combineAiUsage,
  generateAiText,
  type AiUsage,
} from "./aiGateway";
import {
  executeJournaledPremiumCall,
  PremiumJournalError,
  readPremiumJournalAccounting,
  premiumReviewReconciliationPending,
  premiumReviewHasFinalization,
  premiumReviewJournalSchemaSql,
} from "./premiumReviewJournal";
import {
  premiumReviewPlanSchemaSql,
  PremiumReviewPlanError,
  readPremiumReviewPlan,
  savePremiumReviewPlan,
  validatePremiumReviewResume,
  premiumReviewVerificationStepKeys,
  assertPremiumChronologyJournalPrefix,
  freezePremiumClockManifest,
  type PremiumClockEntityRegistryEntry,
  type PremiumClockOwnerConstraint,
  type PremiumReviewPlan,
} from "./premiumReviewPlan";
import { assertPremiumVerificationPages, type PremiumVerificationPage } from "./premiumVerificationPages";
import {
  ensurePremiumStatJournal, savePremiumStatReview, assertExpectedPremiumStatReviews,
  assertPremiumStatProjection, linkPremiumStatReviewsToCanon, preparePremiumEntityStatProjection,
} from "./premiumStatJournal";
import { assertPremiumStatReceipt, type PremiumStatReviewReceipt } from "./premiumStatVerification";
import { PREMIUM_STAT_FAMILIES, isNeutralPremiumStatEstimate } from "./premiumStatCandidates";
import { projectEntityReviewedStats } from "./entityStatVerification";
import { assertEntityGraphReview, projectEntityReviewedGraph, assertEntityGraphReviews, projectEntityReviewedGraphs, type EntityGraphContext } from "./entityGraphVerification";
import {
  ensureEntityStatJournal, saveEntityStatReviews, linkEntityStatReviewsToCanon,
  currentEntityPremiumStatNames,
} from "./entityStatJournal";
import { registerPremiumRecoveryRoutes } from "./premiumRecoveryRoutes";
import {
  ensureEntityReviewJournal, executeJournaledEntityReviewCall, readEntityReviewCall,
  findPendingEntityReviewCall, EntityReviewJournalError, type EntityReviewCallScope,
  saveEntityReviewVerificationBundle, ensureEntityReviewGraphLinks,
  executeJournaledEntityReviewPages, readEntityReviewPageProgress,
  type EntityReviewJournalPage,
} from "./entityReviewJournal";
import { finishJournaledEntityReview, EntityReviewStaleCanonError } from "./entityReviewExecution";
import { entityReviewCanonFingerprint } from "./entityReviewCanon";
import { assertEntityProseReview, entityProseFields, projectEntityReviewedProse,
  type EntityProseReviewReceipt } from "./entityProseVerification";
import { ensureEntityReviewClaimLinks, syncEntityVerifiedProse } from "./entityProseJournal";
import { appendDossierStrings, dossierConnections, dossierStrings } from "./dossierContent";
import { readEntityProseStatus } from "./entityProseStatus";
import { assertEntityCompassReview, type EntityCompassReviewReceipt } from "./entityCompassVerification";
import { readEntityCompassStatus, syncEntityVerifiedCompass } from "./entityCompassPersistence";
import { buildExistingProseInventory } from "./entityExistingProseReview";
import { loadEntityProseRetrievalLeads } from "./entityProseRetrieval";
import { planEntityProseRetrieval } from "./entityProseRetrievalPlan";
import { loadEntityReviewManuscriptChunks, type EntityReviewSourceChunk } from "./entityReviewSources";
import { retrievalTokens } from "./lorekeeperRetrieval";
import {
  EntityReviewAccountingError,
  savedEntityReviewFundingStatus,
} from "./entityReviewAccounting";
import type { JsonObject } from "./analysisVerificationContracts";
import {
  assertExpectedPremiumClaimReviews,
  ensurePremiumClaimJournal,
  linkPremiumClaimReviewsToCanon,
  savePremiumClaimReview,
} from "./premiumClaimJournal";
import { claimsFromPremiumClaimReceipts } from "./premiumClaimVerification";
import {
  applyVerifiedWorldClockProjection,
  ensureWorldClockPersistence,
} from "./worldClockPersistence";
import {
  approvedWorldClockProjection,
} from "./worldClockVerification";
import { canProjectCurrentFactionMembership, graphFromPremiumReceipts, type PremiumGraphReviewReceipt } from "./premiumGraphVerification";
import {
  assertExpectedPremiumGraphReviews,
  ensurePremiumGraphJournal,
  savePremiumGraphReview,
  syncPremiumVerifiedGraph,
  syncEntityVerifiedGraph, type PremiumGraphSyncResult,
} from "./premiumGraphJournal";
import {
  ambiguousFindingIsEntityLabel,
  analyzeWorld,
  assertPremiumRelationSemantics,
  buildWorldPremiumVerificationPages,
  chapterPerspectiveFromSectionTitle,
  normalizeNarrativePerspective,
  enrichLocalCharacterFindings,
  enrichPrincipalCharactersWithLocalQwen,
  getAiRuntimeStatus,
  guardLocalQwenDossierProjection,
  localEvidenceBehavesLikeCharacter,
  localContextCardFromEvidence,
  localEntityCategoryFromEvidence,
  localEntityEvidenceIsNonEntity,
  localPublicEntitySummaryFromEvidence,
  mergeWorldFindings,
  normalizeLocalDossierRelationshipProjection,
  normalizeLocalRelationshipMentions,
  projectLocalDossierProfilesAgainstNormalizedGraph,
  quoteWorldAnalysisReservation,
  premiumVerificationBatchChunkIds,
  relationHasDirectPredicateSupport,
  reviewCanonDiscrepancy,
  type AnalysisChunk,
  type AnalysisSource,
  type CharacterFinding,
  type CohesionFinding,
  type DiscrepancyAmendment,
  type DiscrepancyReview,
  type EvidenceReference,
  type EntityRelationFinding,
  type EntityRelationType,
  type EntityRuleFinding,
  type NamedFinding,
  type WorldAnalysisCoverage,
  type WorldAnalysisIntakePreview,
  type WorldAnalysisLocalCheckpoint,
  type WorldFindings,
} from "./worldAnalysis";
import {
  campaignPlaySchemaSql,
  registerCampaignPlayRoutes,
} from "./campaignPlay";
import { adventureSetupSchemaSql } from "./adventureSetupPersistence";
import { registerAdventureSetupRoutes } from "./adventureSetupRuntime";
import {
  campaignRpgSha256,
  ensureCampaignRpgPersistence,
  initializeCampaignRpgStateInTransaction,
} from "./campaignRpgPersistence";
import {
  buildCampaignSeed,
  campaignRulesFromTemporalEvidence,
  campaignStatsFromDossier,
  campaignStatsFromTemporalEvidence,
  type CampaignSeedClaim,
  type CampaignSeedEntityRule,
} from "./campaignRpgSeed";
import type {
  CampaignResolutionMode,
  CampaignSeed,
  StoryholdStatName,
} from "./campaignRpgState";
import {
  allowedCanonEntityIds,
  claimsWithCompleteEntityReferences,
  campaignCanonScopeSchemaSql,
  createCampaignCanonScopeSnapshot,
  identitySafeEntityProjection,
  observedEntityNamesFromEvidence,
  observedEntitySurfacesFromEvidence,
  persistCampaignCanonScopeSnapshots,
  projectAnchoredCanonClaims,
  projectAnchoredCanonEvidence,
  projectEditionLockedCanonClaims,
  projectEditionLockedCanonEvidence,
  referencedCanonEvidenceChunks,
  stableCanonSha256,
  type CampaignCanonClaimSnapshot,
  type CampaignCanonEvidenceSnapshot,
  type IdentitySafeCampaignEntity,
  type LockedSourceIdentity,
} from "./campaignCanonScope";
import {
  registerStoryStudioRoutes,
  storyStudioSchemaSql,
} from "./storyStudio";
import {
  ensureStoryholdVectorIndexes,
  scheduleStoryholdEmbeddingBackfill,
} from "./holdMemory";
import {
  CreditEconomyError,
  creditEconomySchemaSql,
  creditsForReservationQuote,
  creditsForUsage,
  releaseCreditReservation,
  releaseExpiredCreditReservations,
  reserveCredits,
  restorePremiumCreditReservation,
  settleCreditReservationInTransaction,
  settleFixedCreditReservationInTransaction,
  type CreditReservation,
} from "./creditEconomy";
import {
  BROWSER_QWEN_PRICING_VERSION,
  browserQwenUsageCredits,
  CANON_INTAKE_PRICING_VERSION,
  canonIntakeContentFingerprint,
  canonIntakeNeedsLargeWarning,
  canonIntakePricingFromEnvironment,
  incrementalLocalIntakeCredits,
  estimatedTokensFromCharacters,
} from "./canonIntakePricing";
import {
  parseNarrativeSections,
  summarizeNarrativeSection,
} from "./sourceChapters";
import {
  AUTHOR_STORY_DRAFT_MIN_TURNS,
  AUTHOR_STORY_DRAFT_MIN_WORDS,
  storyDraftUnlocksAuthorMode,
  summarizeAuthorManuscripts,
} from "./narrativeQualification";
import {
  quoteEntityReviewReservation,
  premiumEntityReviewPages,
  entityReviewPublicError,
  hasEntityReviewProse,
  reviewEntity,
  reviewEntityFromSavedResult,
  reviewEntityFromBrowser,
  reviewEntityLocally,
  type EntityReviewDepth,
  type EntityReviewInput,
} from "./entityReview";
import { largestAffordablePrefix } from "./creditBatching";
import {
  loadWorldEntityNameResolution,
  syncWorldCoreferenceSpans,
  syncWorldEntityMentions,
  syncWorldEventRelations,
  syncWorldEventParticipants,
  syncWorldKnowledgeClaims,
  worldKnowledgeSchemaSql,
  type PersistableWorldEventParticipant,
  type PersistableWorldEventRelation,
  type WorldReferenceIssue,
} from "./worldKnowledge";
import {
  refreshWorldQualityFindings,
  worldQualitySchemaSql,
} from "./worldQuality";
import {
  CONCEPT_RESOLUTION_VERSION,
  conceptResolutionContext,
  conceptResolutionSchemaSql,
  enforceOwnerCanonConstraints,
  loadOwnerCanonConstraints,
  saveOwnerCanonConstraint,
  serializeOwnerConstraint,
  serializeStoryConceptCluster,
  serializeStoryRelationHypothesis,
  syncWorldConceptGraph,
  type OwnerCanonConstraint,
} from "./conceptResolution";
import {
  applyPendingCompletedBrowserAudits,
  browserLocalAuditContext,
  browserLocalAuditPricingSchemaSql,
  browserLocalAuditSchemaSql,
  createBrowserLocalAudit,
  generatedAliasIsCustomerVisible,
  latestBrowserAudit,
  registerBrowserLocalAuditRoutes,
  resumePausedBrowserLocalAudit,
} from "./browserLocalAudit";
import {
  normalizeCharacterAliasAttribution,
  repairGeneratedCharacterIdentities,
} from "./characterIdentity";
import { releaseLorekeeperStage } from "./localLorekeeperModels";
import {
  localCharacterNameIsUseful,
  localEntityTextIsUseful,
  type LocalStorySignal,
} from "./localEntityExtraction";

type StudioUser = { id: string; email: string; role: string };
type StudioRequest = Request & { localUser?: StudioUser };
type StudioDb = Pick<StoryholdDb, "exec" | "query">;
type StudioRootDb = StudioDb & Pick<StoryholdDb, "transaction">;

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const WORLD_ANALYSIS_VERSION = 5;
// Increment when deterministic extraction semantics change so existing worlds
// are rescanned and stale generated entities are retired automatically.
export const LOCAL_ANALYSIS_VERSION = 25;
export const PREMIUM_VERIFICATION_PACKET_VERSION = 6;
// Bump whenever prompt construction, validation, or synthesis algorithms change.
export const PREMIUM_EXECUTION_VERSION =
  `world:${WORLD_ANALYSIS_VERSION}:packet:${PREMIUM_VERIFICATION_PACKET_VERSION}:resume:1`;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_CLASSES = new Set([
  "original_author",
  "user_created",
  "licensed",
  "public_domain",
  "reference",
  "fan_created",
]);
const CANON_STATUSES = new Set(["candidate", "canon", "reference", "excluded"]);
const SOURCE_KINDS = new Set([
  "manuscript",
  "character_sheet",
  "setting_guide",
  "ruleset",
  "timeline",
  "notes",
  "reference",
  "other",
]);
const CHRONOLOGY_RELATIONS = new Set([
  "origin",
  "continues",
  "precedes",
  "parallel",
  "overlaps",
  "alternate",
  "reference",
  "unspecified",
]);
const RESOLUTION_MODES = new Set([
  "story_first",
  "light_rules",
  "tactical",
  "custom",
]);
const REFERENCE_KNOWLEDGE_SCOPES = new Set([
  "director_only",
  "common",
  "selected",
  "discoverable",
]);
const REFERENCE_LORE_STATUSES = new Set([
  "official",
  "licensed",
  "supplemental",
  "homebrew",
  "disputed",
]);
const CAMPAIGN_EXPERIENCE_MODES = new Set(["author", "solo"]);
export const AUTHOR_MODE_MIN_MANUSCRIPT_WORDS = 10_000;
export function authorModeIsEligible(
  manuscriptWordCount: number,
  hasStoryDraft: boolean,
) {
  return (
    Math.max(0, Number(manuscriptWordCount) || 0) >=
      AUTHOR_MODE_MIN_MANUSCRIPT_WORDS || hasStoryDraft
  );
}

/**
 * Canonical characters belong to a world. A hero typed while launching one
 * campaign is deliberately campaign-scoped so it can satisfy existing
 * campaign foreign keys without silently becoming canon for every later game.
 * The originating campaign may be deleted while branches still use this hero;
 * its pointer is then cleared, but the character remains campaign-scoped until
 * its world is deleted.
 */
export const campaignCharacterScopeSchemaSql = String.raw`
  ALTER TABLE storyhold.characters
    ADD COLUMN IF NOT EXISTS scope_kind text NOT NULL DEFAULT 'world'
      CHECK (scope_kind IN ('world', 'campaign'));
  ALTER TABLE storyhold.characters
    ADD COLUMN IF NOT EXISTS scope_campaign_id uuid;
  -- Upgrade the earlier cascading pointer: removing a parent campaign must
  -- not delete its hero out from under a surviving branch's locked start.
  ALTER TABLE storyhold.characters
    DROP CONSTRAINT IF EXISTS characters_scope_shape_check;
  ALTER TABLE storyhold.characters
    ADD CONSTRAINT characters_scope_shape_check CHECK (
      scope_kind = 'campaign' OR
      (scope_kind = 'world' AND scope_campaign_id IS NULL)
    );
  ALTER TABLE storyhold.characters
    DROP CONSTRAINT IF EXISTS characters_scope_campaign_fk;
  ALTER TABLE storyhold.characters
    ADD CONSTRAINT characters_scope_campaign_fk
    FOREIGN KEY (scope_campaign_id) REFERENCES storyhold.campaigns(id)
    ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
  CREATE UNIQUE INDEX IF NOT EXISTS characters_one_campaign_identity
    ON storyhold.characters (scope_campaign_id)
    WHERE scope_kind = 'campaign';
  CREATE INDEX IF NOT EXISTS characters_world_canon_scope
    ON storyhold.characters (world_id, name)
    WHERE scope_kind = 'world';
`;

export async function loadWorldAuthorStoryDraftAccess(
  db: StudioDb,
  params: { playerId: string; worldId: string },
) {
  return db.query<Record<string, unknown>>(
    `SELECT draft.status, draft.source_turn_ids, version.prose
       FROM storyhold.campaign_story_drafts draft
       JOIN storyhold.campaigns campaign
         ON campaign.id = draft.campaign_id AND campaign.world_id = draft.world_id
       JOIN storyhold.campaign_story_draft_versions version
         ON version.draft_id = draft.id AND version.revision_source = 'ai'
      WHERE draft.created_by_player_id = $1
        AND draft.world_id = $2
        AND campaign.world_id = $2
        AND draft.status <> 'archived'`,
    [params.playerId, params.worldId],
  );
}
const CREATION_MODES = new Set(["import", "quickstart", "manual"]);
const ENTITY_TYPES = new Set([
  "character",
  "creature",
  "species",
  "place",
  "faction",
  "institution",
  "government",
  "power_structure",
  "technology",
  "vehicle",
  "device",
  "weapon",
  "power",
  "title",
  "cultural_reference",
  "term",
  "ambiguous",
]);
type EntityType =
  | "character"
  | "creature"
  | "species"
  | "place"
  | "faction"
  | "institution"
  | "government"
  | "power_structure"
  | "technology"
  | "vehicle"
  | "device"
  | "weapon"
  | "power"
  | "title"
  | "cultural_reference"
  | "term"
  | "ambiguous";

export function relationEntityTypesAreCompatible(
  relationType: EntityRelationType,
  sourceType: EntityType,
  targetType: EntityType,
): boolean {
  const personLike = new Set<EntityType>(["character", "creature"]);
  const organizationLike = new Set<EntityType>([
    "faction", "institution", "government", "power_structure",
  ]);
  const concreteLike = new Set<EntityType>([
    "character", "creature", "place", "faction", "institution", "government",
    "power_structure", "technology", "vehicle", "device", "weapon",
  ]);
  const contextOnly = new Set<EntityType>(["cultural_reference", "term"]);
  switch (relationType) {
    case "child_of":
    case "sibling_of":
    case "spouse_of":
    case "friend_of":
    case "best_friend_of":
      return sourceType === "character" && targetType === "character";
    case "species_of":
      return personLike.has(sourceType) && targetType === "species";
    case "subspecies_of":
      return sourceType === "species" && targetType === "species";
    case "subtype_of":
    case "lifecycle_stage_of":
      return sourceType === "creature" && ["creature", "species"].includes(targetType);
    case "has_power":
      return personLike.has(sourceType) && targetType === "power";
    case "has_form":
      return personLike.has(sourceType) && ["character", "creature", "species"].includes(targetType);
    case "holds_title":
      return personLike.has(sourceType) && targetType === "title";
    case "member_of":
      return personLike.has(sourceType) && organizationLike.has(targetType);
    case "leads":
      return sourceType === "character" && organizationLike.has(targetType);
    case "governs":
      return ["character", "government"].includes(sourceType) &&
        new Set<EntityType>([...organizationLike, "place"]).has(targetType);
    case "controlled_by":
      return ["ambiguous", ...personLike].includes(sourceType) &&
        new Set<EntityType>(["ambiguous", ...personLike, ...organizationLike]).has(targetType);
    case "located_in":
      return concreteLike.has(sourceType) && targetType === "place";
    case "created_by":
      return concreteLike.has(sourceType) &&
        new Set<EntityType>(["character", ...organizationLike]).has(targetType);
    case "part_of":
      return concreteLike.has(sourceType) && concreteLike.has(targetType);
    case "allied_with":
    case "opposed_to":
      return new Set<EntityType>(["ambiguous", "character", ...organizationLike]).has(sourceType) &&
        new Set<EntityType>(["ambiguous", "character", ...organizationLike]).has(targetType);
    case "participates_in":
      return new Set<EntityType>([...personLike, ...organizationLike]).has(sourceType) &&
        organizationLike.has(targetType);
    case "related_to":
      return !contextOnly.has(sourceType) && !contextOnly.has(targetType);
  }
}
const ENTITY_RELATION_TYPES = new Set<EntityRelationType>([
  "member_of", "participates_in", "species_of", "subspecies_of", "subtype_of",
  "lifecycle_stage_of", "has_power", "has_form", "holds_title", "allied_with",
  "child_of", "sibling_of", "spouse_of", "friend_of", "best_friend_of",
  "leads", "governs", "controlled_by", "opposed_to", "located_in",
  "part_of", "created_by", "related_to",
]);
const ENTITY_RELATION_STATUSES = new Set([
  "active", "former", "conditional", "disputed", "unknown",
]);
const ENTITY_RULE_KINDS = new Set([
  "trait", "ability", "constraint", "biological", "social", "gameplay",
]);
const COHESION_CLASSIFICATIONS = new Set([
  "canon_correction",
  "intentional_contradiction",
  "unreliable_narration",
  "alternate_edition",
  "needs_research",
]);

type AnalysisKind = "local_scan" | "ai_enrichment";
type AnalysisTrigger = "upload" | "backfill" | "manual";

export function nextAutomaticAnalysisKind(params: {
  completedKind: AnalysisKind;
  trigger: AnalysisTrigger;
  runtimeConfigured: boolean;
  partialDueToCredits: boolean;
  completedSuccessfully: boolean;
}): AnalysisKind | null {
  if (!params.completedSuccessfully) return null;
  // Local intake always stops at the customer decision boundary.  Once the
  // owner explicitly starts premium verification, an affordable partial AI
  // run may continue its own remaining batches, but it never starts another
  // local/premium cycle after completion.
  if (params.completedKind === "local_scan") return null;
  return params.runtimeConfigured && params.partialDueToCredits
    ? "ai_enrichment"
    : null;
}

export function deferredBacklogAnalysisKind(params: {
  needsLocal: boolean;
  needsAi: boolean;
}): AnalysisKind | null {
  // Server startup may repair the free local inventory, but paid review always
  // remains attached to an upload or an explicit manual request.
  return params.needsLocal ? "local_scan" : null;
}

/** The generic Review action can never become a paid-provider shortcut. */
export function generalWorldAnalysisKind(): AnalysisKind {
  return "local_scan";
}

export const worldStudioSchemaSql = String.raw`
  ${campaignCharacterScopeSchemaSql}

  ALTER TABLE storyhold.worlds ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
  ALTER TABLE storyhold.worlds ADD COLUMN IF NOT EXISTS genre text NOT NULL DEFAULT '';
  ALTER TABLE storyhold.worlds ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
  ALTER TABLE storyhold.worlds
    ADD COLUMN IF NOT EXISTS creation_mode text NOT NULL DEFAULT 'import'
      CHECK (creation_mode IN ('import', 'quickstart', 'manual'));
  ALTER TABLE storyhold.worlds ADD COLUMN IF NOT EXISTS world_contract jsonb NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE storyhold.worlds
    ADD COLUMN IF NOT EXISTS contract_status text NOT NULL DEFAULT 'draft'
      CHECK (contract_status IN ('draft', 'locked'));
  ALTER TABLE storyhold.worlds ADD COLUMN IF NOT EXISTS world_clock_name text NOT NULL DEFAULT 'World Clock';
  ALTER TABLE storyhold.worlds
    ADD COLUMN IF NOT EXISTS resolution_mode text NOT NULL DEFAULT 'story_first'
      CHECK (resolution_mode IN ('story_first', 'light_rules', 'tactical', 'custom'));
  ALTER TABLE storyhold.worlds ADD COLUMN IF NOT EXISTS content_settings jsonb NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE storyhold.worlds
    ADD COLUMN IF NOT EXISTS metadata_inference_status text NOT NULL DEFAULT 'manual'
      CHECK (metadata_inference_status IN ('manual', 'requested', 'generated'));

  CREATE TABLE IF NOT EXISTS storyhold.player_story_preferences (
    player_id uuid PRIMARY KEY REFERENCES storyhold.players(id) ON DELETE CASCADE,
    adult_enabled boolean NOT NULL DEFAULT false,
    age_attested_at timestamptz,
    age_attestation_version text,
    sexual_content_level text NOT NULL DEFAULT 'off'
      CHECK (sexual_content_level IN ('off', 'fade_to_black', 'explicit')),
    violence_level text NOT NULL DEFAULT 'standard'
      CHECK (violence_level IN ('standard', 'graphic')),
    narrative_length text NOT NULL DEFAULT 'balanced'
      CHECK (narrative_length IN ('concise', 'balanced', 'expansive')),
    anonymous_learning_enabled boolean NOT NULL DEFAULT false,
    local_model_training_enabled boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  ALTER TABLE storyhold.player_story_preferences
    ADD COLUMN IF NOT EXISTS anonymous_learning_enabled boolean NOT NULL DEFAULT false;
  ALTER TABLE storyhold.player_story_preferences
    ADD COLUMN IF NOT EXISTS local_model_training_enabled boolean NOT NULL DEFAULT false;

  CREATE TABLE IF NOT EXISTS storyhold.canon_editions (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    created_by_player_id uuid NOT NULL REFERENCES storyhold.players(id) ON DELETE RESTRICT,
    canonical_key text NOT NULL,
    name text NOT NULL,
    timeline_anchor text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'locked', 'archived')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (world_id, canonical_key)
  );

  ALTER TABLE storyhold.canon_editions
    ADD COLUMN IF NOT EXISTS chronology_status text NOT NULL DEFAULT 'draft'
      CHECK (chronology_status IN ('draft', 'reviewed'));
  ALTER TABLE storyhold.canon_editions ADD COLUMN IF NOT EXISTS chronology_summary text NOT NULL DEFAULT '';
  ALTER TABLE storyhold.canon_editions ADD COLUMN IF NOT EXISTS chronology_reviewed_at timestamptz;

  CREATE TABLE IF NOT EXISTS storyhold.world_sources (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    uploaded_by_player_id uuid NOT NULL REFERENCES storyhold.players(id) ON DELETE RESTRICT,
    canonical_key text NOT NULL,
    title text NOT NULL,
    original_filename text NOT NULL,
    media_type text NOT NULL,
    document_type text NOT NULL,
    source_class text NOT NULL CHECK (source_class IN ('original_author', 'user_created', 'licensed', 'public_domain', 'reference', 'fan_created')),
    canon_status text NOT NULL DEFAULT 'candidate' CHECK (canon_status IN ('candidate', 'canon', 'reference', 'excluded')),
    raw_file_path text NOT NULL,
    content_hash text NOT NULL,
    extracted_text text NOT NULL DEFAULT '',
    extraction_method text,
    page_count integer,
    byte_size bigint NOT NULL CHECK (byte_size >= 0),
    word_count integer NOT NULL DEFAULT 0 CHECK (word_count >= 0),
    char_count integer NOT NULL DEFAULT 0 CHECK (char_count >= 0),
    chunk_count integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
    sort_order integer NOT NULL DEFAULT 0,
    processing_status text NOT NULL DEFAULT 'ready' CHECK (processing_status IN ('ready', 'failed')),
    processing_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (canon_edition_id, content_hash),
    UNIQUE (world_id, canonical_key)
  );

  ALTER TABLE storyhold.world_sources
    ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'manuscript'
      CHECK (source_kind IN ('manuscript', 'character_sheet', 'setting_guide', 'ruleset', 'timeline', 'notes', 'reference', 'other'));
  ALTER TABLE storyhold.world_sources ADD COLUMN IF NOT EXISTS chronology_order integer NOT NULL DEFAULT 0;
  ALTER TABLE storyhold.world_sources
    ADD COLUMN IF NOT EXISTS chronology_relation text NOT NULL DEFAULT 'unspecified'
      CHECK (chronology_relation IN ('origin', 'continues', 'precedes', 'parallel', 'overlaps', 'alternate', 'reference', 'unspecified'));
  ALTER TABLE storyhold.world_sources ADD COLUMN IF NOT EXISTS chronology_label text NOT NULL DEFAULT '';
  ALTER TABLE storyhold.world_sources ADD COLUMN IF NOT EXISTS chronology_notes text NOT NULL DEFAULT '';
  ALTER TABLE storyhold.world_sources ADD COLUMN IF NOT EXISTS file_as_chapter boolean NOT NULL DEFAULT false;
  ALTER TABLE storyhold.world_sources ADD COLUMN IF NOT EXISTS relative_path text NOT NULL DEFAULT '';
  ALTER TABLE storyhold.world_sources ADD COLUMN IF NOT EXISTS import_batch_id text;
  ALTER TABLE storyhold.world_sources ADD COLUMN IF NOT EXISTS import_batch_position integer;
  ALTER TABLE storyhold.world_sources ADD COLUMN IF NOT EXISTS import_batch_size integer;
  ALTER TABLE storyhold.world_sources
    ADD COLUMN IF NOT EXISTS extraction_quality_severity text NOT NULL DEFAULT 'ok'
      CHECK (extraction_quality_severity IN ('ok', 'warning', 'critical'));
  ALTER TABLE storyhold.world_sources ADD COLUMN IF NOT EXISTS extraction_diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE storyhold.world_sources
    ADD COLUMN IF NOT EXISTS chronology_review_status text NOT NULL DEFAULT 'unreviewed'
      CHECK (chronology_review_status IN ('unreviewed', 'reviewed'));

  CREATE TABLE IF NOT EXISTS storyhold.world_source_chunks (
    id uuid PRIMARY KEY,
    source_id uuid NOT NULL REFERENCES storyhold.world_sources(id) ON DELETE CASCADE,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    chunk_index integer NOT NULL CHECK (chunk_index >= 0),
    content text NOT NULL,
    content_hash text NOT NULL,
    char_count integer NOT NULL CHECK (char_count >= 0),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    embedding vector(384),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_id, chunk_index)
  );

  ALTER TABLE storyhold.world_source_chunks ADD COLUMN IF NOT EXISTS embedding_provider text;
  ALTER TABLE storyhold.world_source_chunks ADD COLUMN IF NOT EXISTS embedding_model text;
  ALTER TABLE storyhold.world_source_chunks ADD COLUMN IF NOT EXISTS embedding_updated_at timestamptz;

  CREATE INDEX IF NOT EXISTS world_source_chunks_canonical_scope
    ON storyhold.world_source_chunks (world_id, canon_edition_id, source_id, chunk_index);

  CREATE INDEX IF NOT EXISTS world_source_chunks_text_search
    ON storyhold.world_source_chunks
    USING GIN (to_tsvector('simple', content));

  CREATE TABLE IF NOT EXISTS storyhold.world_source_pages (
    id uuid PRIMARY KEY,
    source_id uuid NOT NULL REFERENCES storyhold.world_sources(id) ON DELETE CASCADE,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    page_index integer NOT NULL CHECK (page_index >= 0),
    start_offset integer NOT NULL CHECK (start_offset >= 0),
    end_offset integer NOT NULL CHECK (end_offset >= start_offset),
    char_count integer NOT NULL CHECK (char_count >= 0),
    content_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_id, page_index)
  );

  CREATE INDEX IF NOT EXISTS world_source_pages_scope
    ON storyhold.world_source_pages (world_id, canon_edition_id, source_id, page_index);

  CREATE INDEX IF NOT EXISTS world_sources_chronology_scope
    ON storyhold.world_sources (world_id, canon_edition_id, chronology_order, sort_order);

  CREATE TABLE IF NOT EXISTS storyhold.world_reference_sources (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    query text NOT NULL DEFAULT '',
    title text NOT NULL,
    url text NOT NULL,
    publisher text NOT NULL DEFAULT '',
    summary text NOT NULL DEFAULT '',
    keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
    discovered_by text NOT NULL DEFAULT 'user'
      CHECK (discovered_by IN ('user', 'codex', 'perplexity')),
    review_status text NOT NULL DEFAULT 'candidate'
      CHECK (review_status IN ('candidate', 'approved', 'rejected')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (world_id, canon_edition_id, url)
  );

  ALTER TABLE storyhold.world_reference_sources
    ADD COLUMN IF NOT EXISTS content_text text NOT NULL DEFAULT '';
  ALTER TABLE storyhold.world_reference_sources
    ADD COLUMN IF NOT EXISTS content_hash text;
  ALTER TABLE storyhold.world_reference_sources
    ADD COLUMN IF NOT EXISTS extraction_status text NOT NULL DEFAULT 'pending'
      CHECK (extraction_status IN ('pending', 'ready', 'failed'));
  ALTER TABLE storyhold.world_reference_sources
    ADD COLUMN IF NOT EXISTS extraction_method text;
  ALTER TABLE storyhold.world_reference_sources
    ADD COLUMN IF NOT EXISTS quality_score integer;
  ALTER TABLE storyhold.world_reference_sources
    ADD COLUMN IF NOT EXISTS quality_flags jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE storyhold.world_reference_sources
    ADD COLUMN IF NOT EXISTS word_count integer NOT NULL DEFAULT 0;
  ALTER TABLE storyhold.world_reference_sources
    ADD COLUMN IF NOT EXISTS use_policy text NOT NULL DEFAULT 'background_only'
      CHECK (use_policy = 'background_only');
  ALTER TABLE storyhold.world_reference_sources
    ADD COLUMN IF NOT EXISTS processing_error text;
  ALTER TABLE storyhold.world_reference_sources
    ADD COLUMN IF NOT EXISTS knowledge_scope text NOT NULL DEFAULT 'director_only'
      CHECK (knowledge_scope IN ('director_only', 'common', 'selected', 'discoverable'));
  ALTER TABLE storyhold.world_reference_sources
    ADD COLUMN IF NOT EXISTS known_by jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE storyhold.world_reference_sources
    ADD COLUMN IF NOT EXISTS lore_status text NOT NULL DEFAULT 'supplemental'
      CHECK (lore_status IN ('official', 'licensed', 'supplemental', 'homebrew', 'disputed'));

  ALTER TABLE storyhold.world_sources
    ADD COLUMN IF NOT EXISTS reference_knowledge_scope text NOT NULL DEFAULT 'director_only'
      CHECK (reference_knowledge_scope IN ('director_only', 'common', 'selected', 'discoverable'));
  ALTER TABLE storyhold.world_sources
    ADD COLUMN IF NOT EXISTS reference_known_by jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE storyhold.world_sources
    ADD COLUMN IF NOT EXISTS reference_lore_status text NOT NULL DEFAULT 'supplemental'
      CHECK (reference_lore_status IN ('official', 'licensed', 'supplemental', 'homebrew', 'disputed'));

  CREATE INDEX IF NOT EXISTS world_reference_sources_scope
    ON storyhold.world_reference_sources
      (world_id, canon_edition_id, review_status, created_at DESC);

  ALTER TABLE storyhold.world_sources
    ADD COLUMN IF NOT EXISTS local_scan_status text NOT NULL DEFAULT 'pending'
      CHECK (local_scan_status IN ('pending', 'queued', 'running', 'completed', 'failed', 'not_applicable'));
  ALTER TABLE storyhold.world_sources ADD COLUMN IF NOT EXISTS local_scanned_content_hash text;
  ALTER TABLE storyhold.world_sources ADD COLUMN IF NOT EXISTS local_scanned_at timestamptz;
  ALTER TABLE storyhold.world_sources ADD COLUMN IF NOT EXISTS local_analysis_version integer NOT NULL DEFAULT 0;
  ALTER TABLE storyhold.world_sources
    ADD COLUMN IF NOT EXISTS ai_review_status text NOT NULL DEFAULT 'waiting'
      CHECK (ai_review_status IN ('waiting', 'queued', 'running', 'reviewed', 'failed', 'not_applicable'));
  ALTER TABLE storyhold.world_sources ADD COLUMN IF NOT EXISTS ai_reviewed_content_hash text;
  ALTER TABLE storyhold.world_sources ADD COLUMN IF NOT EXISTS ai_analysis_version integer NOT NULL DEFAULT 0;
  ALTER TABLE storyhold.world_sources ADD COLUMN IF NOT EXISTS ai_review_provider text;
  ALTER TABLE storyhold.world_sources ADD COLUMN IF NOT EXISTS ai_review_model text;
  ALTER TABLE storyhold.world_sources ADD COLUMN IF NOT EXISTS ai_reviewed_at timestamptz;
  ALTER TABLE storyhold.world_sources
    ADD COLUMN IF NOT EXISTS ai_reviewed_chunk_count integer NOT NULL DEFAULT 0
      CHECK (ai_reviewed_chunk_count >= 0);
  ALTER TABLE storyhold.world_sources
    ADD COLUMN IF NOT EXISTS ai_coverage_authoritative boolean NOT NULL DEFAULT false;
  ALTER TABLE storyhold.world_sources
    ADD COLUMN IF NOT EXISTS intake_payment_required boolean NOT NULL DEFAULT false;

  CREATE INDEX IF NOT EXISTS world_sources_review_backlog
    ON storyhold.world_sources (world_id, canon_edition_id, ai_review_status, local_scan_status);

  CREATE TABLE IF NOT EXISTS storyhold.world_analysis_runs (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    requested_by_player_id uuid NOT NULL REFERENCES storyhold.players(id) ON DELETE RESTRICT,
    provider text NOT NULL,
    model text NOT NULL,
    status text NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed')),
    stage text NOT NULL DEFAULT 'queued',
    progress integer NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
    source_count integer NOT NULL DEFAULT 0,
    chunk_count integer NOT NULL DEFAULT 0,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    completed_at timestamptz
  );

  CREATE INDEX IF NOT EXISTS world_analysis_runs_scope
    ON storyhold.world_analysis_runs (world_id, canon_edition_id, created_at DESC);

  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS pause_requested boolean NOT NULL DEFAULT false;
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS paused_at timestamptz;

  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS analysis_kind text NOT NULL DEFAULT 'local_scan'
      CHECK (analysis_kind IN ('local_scan', 'ai_enrichment'));
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS trigger_kind text NOT NULL DEFAULT 'manual'
      CHECK (trigger_kind IN ('upload', 'backfill', 'manual'));
  ALTER TABLE storyhold.world_analysis_runs ADD COLUMN IF NOT EXISTS incremental boolean NOT NULL DEFAULT false;
  ALTER TABLE storyhold.world_analysis_runs ADD COLUMN IF NOT EXISTS analysis_version integer NOT NULL DEFAULT 1;
  ALTER TABLE storyhold.world_analysis_runs ADD COLUMN IF NOT EXISTS input_fingerprint text NOT NULL DEFAULT '';
  ALTER TABLE storyhold.world_analysis_runs ADD COLUMN IF NOT EXISTS source_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE storyhold.world_analysis_runs ADD COLUMN IF NOT EXISTS review_source_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE storyhold.world_analysis_runs ADD COLUMN IF NOT EXISTS user_guidance text NOT NULL DEFAULT '';
  ALTER TABLE storyhold.world_analysis_runs ADD COLUMN IF NOT EXISTS intake_preview jsonb NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE storyhold.world_analysis_runs ADD COLUMN IF NOT EXISTS intake_activity jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE storyhold.world_analysis_runs ADD COLUMN IF NOT EXISTS local_checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE storyhold.world_analysis_runs ADD COLUMN IF NOT EXISTS local_checkpoint_saved_at timestamptz;
  ALTER TABLE storyhold.world_analysis_runs ADD COLUMN IF NOT EXISTS premium_resume_status text NOT NULL DEFAULT 'not_available';
  ALTER TABLE storyhold.world_analysis_runs ADD COLUMN IF NOT EXISTS intake_product_fingerprint text NOT NULL DEFAULT '';
  ALTER TABLE storyhold.world_analysis_runs ADD COLUMN IF NOT EXISTS intake_product_source_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS intake_product_price_credits integer NOT NULL DEFAULT 0
      CHECK (intake_product_price_credits >= 0);
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS intake_product_credits_charged integer NOT NULL DEFAULT 0
      CHECK (intake_product_credits_charged >= 0);
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS premium_ai_credits_charged integer NOT NULL DEFAULT 0
      CHECK (premium_ai_credits_charged >= 0);
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS intake_product_charge_status text NOT NULL DEFAULT 'not_applicable'
      CHECK (intake_product_charge_status IN ('not_applicable', 'pending', 'covered', 'settled', 'unlimited'));
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS synthesis_status text NOT NULL DEFAULT 'not_applicable'
      CHECK (synthesis_status IN ('not_applicable', 'pending', 'completed', 'failed'));
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS synthesis_attempt_count integer NOT NULL DEFAULT 0
      CHECK (synthesis_attempt_count >= 0);
  ALTER TABLE storyhold.world_analysis_runs ADD COLUMN IF NOT EXISTS synthesis_completed_at timestamptz;
  ALTER TABLE storyhold.world_analysis_runs ADD COLUMN IF NOT EXISTS synthesis_error text;
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS synthesis_group_count integer NOT NULL DEFAULT 0
      CHECK (synthesis_group_count >= 0);
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS synthesis_completed_group_count integer NOT NULL DEFAULT 0
      CHECK (synthesis_completed_group_count >= 0);
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS unresolved_reference_count integer NOT NULL DEFAULT 0
      CHECK (unresolved_reference_count >= 0);
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS unresolved_references jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS local_ner_status text NOT NULL DEFAULT 'disabled'
      CHECK (local_ner_status IN ('disabled', 'not_run', 'completed', 'partial', 'failed'));
  ALTER TABLE storyhold.world_analysis_runs ADD COLUMN IF NOT EXISTS local_ner_provider text;
  ALTER TABLE storyhold.world_analysis_runs ADD COLUMN IF NOT EXISTS local_ner_model text;
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS local_ner_attempted_segments integer NOT NULL DEFAULT 0
      CHECK (local_ner_attempted_segments >= 0);
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS local_ner_completed_segments integer NOT NULL DEFAULT 0
      CHECK (local_ner_completed_segments >= 0);
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS local_ner_failed_segments integer NOT NULL DEFAULT 0
      CHECK (local_ner_failed_segments >= 0);
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS local_ner_mention_count integer NOT NULL DEFAULT 0
      CHECK (local_ner_mention_count >= 0);
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS local_ner_relation_count integer NOT NULL DEFAULT 0
      CHECK (local_ner_relation_count >= 0);
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS local_ner_classification_count integer NOT NULL DEFAULT 0
      CHECK (local_ner_classification_count >= 0);
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS local_ner_signal_count integer NOT NULL DEFAULT 0
      CHECK (local_ner_signal_count >= 0);
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS local_ner_elapsed_ms integer NOT NULL DEFAULT 0
      CHECK (local_ner_elapsed_ms >= 0);
  ALTER TABLE storyhold.world_analysis_runs ADD COLUMN IF NOT EXISTS local_ner_error text;
  -- A premium review is an audit of one immutable local Lorekeeper result, not
  -- a fresh interpretation of whichever breakdown happens to be newest when a
  -- worker wakes up. These anchors make source, evidence, and owner-constraint
  -- drift fail closed before any paid request is reserved or sent.
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS parent_local_run_id uuid
      REFERENCES storyhold.world_analysis_runs(id) ON DELETE CASCADE;
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS corpus_fingerprint text NOT NULL DEFAULT '';
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS evidence_graph_fingerprint text NOT NULL DEFAULT '';
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS constraint_snapshot_fingerprint text NOT NULL DEFAULT '';
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS verification_context_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS verification_context_fingerprint text NOT NULL DEFAULT '';
  ALTER TABLE storyhold.world_analysis_runs
    ADD COLUMN IF NOT EXISTS verification_packet_version integer NOT NULL DEFAULT 1
      CHECK (verification_packet_version > 0);

  CREATE INDEX IF NOT EXISTS world_analysis_runs_parent_local
    ON storyhold.world_analysis_runs (parent_local_run_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS storyhold.world_intake_entitlements (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    player_id uuid NOT NULL REFERENCES storyhold.players(id) ON DELETE RESTRICT,
    content_fingerprint text NOT NULL,
    pricing_version text NOT NULL,
    source_count integer NOT NULL CHECK (source_count > 0),
    word_count integer NOT NULL CHECK (word_count > 0),
    credits_charged integer NOT NULL CHECK (credits_charged >= 0),
    reservation_id uuid,
    analysis_run_id uuid REFERENCES storyhold.world_analysis_runs(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (world_id, canon_edition_id, content_fingerprint)
  );

  CREATE INDEX IF NOT EXISTS world_intake_entitlements_player
    ON storyhold.world_intake_entitlements (player_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS storyhold.world_analysis_chunk_coverage (
    analysis_run_id uuid NOT NULL REFERENCES storyhold.world_analysis_runs(id) ON DELETE CASCADE,
    chunk_id uuid NOT NULL REFERENCES storyhold.world_source_chunks(id) ON DELETE CASCADE,
    source_id uuid NOT NULL REFERENCES storyhold.world_sources(id) ON DELETE CASCADE,
    chunk_index integer NOT NULL CHECK (chunk_index >= 0),
    content_hash text NOT NULL,
    status text NOT NULL CHECK (status IN ('analyzed', 'no_findings', 'failed')),
    finding_count integer NOT NULL DEFAULT 0 CHECK (finding_count >= 0),
    error text,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (analysis_run_id, chunk_id)
  );

  CREATE INDEX IF NOT EXISTS world_analysis_chunk_coverage_source
    ON storyhold.world_analysis_chunk_coverage
      (source_id, chunk_index, created_at DESC);

  CREATE TABLE IF NOT EXISTS storyhold.world_breakdowns (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    analysis_run_id uuid NOT NULL REFERENCES storyhold.world_analysis_runs(id) ON DELETE CASCADE,
    version integer NOT NULL CHECK (version > 0),
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'superseded')),
    provider text NOT NULL,
    model text NOT NULL,
    summary text NOT NULL DEFAULT '',
    genres jsonb NOT NULL DEFAULT '[]'::jsonb,
    atmosphere jsonb NOT NULL DEFAULT '[]'::jsonb,
    themes jsonb NOT NULL DEFAULT '[]'::jsonb,
    world_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
    locations jsonb NOT NULL DEFAULT '[]'::jsonb,
    factions jsonb NOT NULL DEFAULT '[]'::jsonb,
    institutions jsonb NOT NULL DEFAULT '[]'::jsonb,
    governments jsonb NOT NULL DEFAULT '[]'::jsonb,
    power_structures jsonb NOT NULL DEFAULT '[]'::jsonb,
    technologies jsonb NOT NULL DEFAULT '[]'::jsonb,
    vehicles jsonb NOT NULL DEFAULT '[]'::jsonb,
    devices jsonb NOT NULL DEFAULT '[]'::jsonb,
    weapons jsonb NOT NULL DEFAULT '[]'::jsonb,
    chronology jsonb NOT NULL DEFAULT '[]'::jsonb,
    open_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
    recurring_terms jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (world_id, canon_edition_id, version)
  );

  ALTER TABLE storyhold.world_breakdowns ADD COLUMN IF NOT EXISTS atmosphere jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE storyhold.world_breakdowns ADD COLUMN IF NOT EXISTS creatures jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE storyhold.world_breakdowns ADD COLUMN IF NOT EXISTS species jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE storyhold.world_breakdowns ADD COLUMN IF NOT EXISTS powers jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE storyhold.world_breakdowns ADD COLUMN IF NOT EXISTS titles jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE storyhold.world_breakdowns ADD COLUMN IF NOT EXISTS institutions jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE storyhold.world_breakdowns ADD COLUMN IF NOT EXISTS governments jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE storyhold.world_breakdowns ADD COLUMN IF NOT EXISTS power_structures jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE storyhold.world_breakdowns ADD COLUMN IF NOT EXISTS technologies jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE storyhold.world_breakdowns ADD COLUMN IF NOT EXISTS vehicles jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE storyhold.world_breakdowns ADD COLUMN IF NOT EXISTS devices jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE storyhold.world_breakdowns ADD COLUMN IF NOT EXISTS weapons jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE storyhold.world_breakdowns ADD COLUMN IF NOT EXISTS entity_relations jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE storyhold.world_breakdowns ADD COLUMN IF NOT EXISTS entity_rules jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE storyhold.world_breakdowns ADD COLUMN IF NOT EXISTS ambiguous_labels jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE storyhold.world_breakdowns ADD COLUMN IF NOT EXISTS claims jsonb NOT NULL DEFAULT '[]'::jsonb;
  -- Preserve the complete, typed local evidence graph as the handoff into an
  -- optional premium review.  The older projection columns intentionally
  -- omit characters and chapter summaries, so reconstructing the next phase
  -- from them would throw away the strongest local work.
  ALTER TABLE storyhold.world_breakdowns ADD COLUMN IF NOT EXISTS evidence_graph jsonb NOT NULL DEFAULT '{}'::jsonb;

  CREATE TABLE IF NOT EXISTS storyhold.character_drafts (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    analysis_run_id uuid NOT NULL REFERENCES storyhold.world_analysis_runs(id) ON DELETE CASCADE,
    canonical_key text NOT NULL,
    name text NOT NULL,
    aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
    role text NOT NULL DEFAULT '',
    summary text NOT NULL DEFAULT '',
    profile jsonb NOT NULL DEFAULT '{}'::jsonb,
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    confidence real NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
    review_status text NOT NULL DEFAULT 'draft' CHECK (review_status IN ('draft', 'approved', 'rejected')),
    canonical_character_id uuid REFERENCES storyhold.characters(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    reviewed_at timestamptz
  );

  CREATE INDEX IF NOT EXISTS character_drafts_scope
    ON storyhold.character_drafts (world_id, canon_edition_id, analysis_run_id, review_status);

  CREATE TABLE IF NOT EXISTS storyhold.character_dossiers (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    canonical_character_id uuid REFERENCES storyhold.characters(id) ON DELETE SET NULL,
    source_analysis_run_id uuid REFERENCES storyhold.world_analysis_runs(id) ON DELETE SET NULL,
    canonical_key text NOT NULL,
    normalized_name text NOT NULL,
    name text NOT NULL,
    aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
    role text NOT NULL DEFAULT '',
    summary text NOT NULL DEFAULT '',
    profile jsonb NOT NULL DEFAULT '{}'::jsonb,
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    confidence real NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
    dossier_status text NOT NULL DEFAULT 'active'
      CHECK (dossier_status IN ('active', 'suppressed')),
    axis_estimate jsonb NOT NULL DEFAULT '{}'::jsonb,
    axis_user_override jsonb,
    axis_user_changed_at timestamptz,
    user_edited_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (world_id, canon_edition_id, normalized_name),
    UNIQUE (world_id, canonical_key)
  );

  ALTER TABLE storyhold.character_dossiers
    ADD COLUMN IF NOT EXISTS dossier_status text NOT NULL DEFAULT 'active'
      CHECK (dossier_status IN ('active', 'suppressed'));
  ALTER TABLE storyhold.character_dossiers ADD COLUMN IF NOT EXISTS mention_count integer NOT NULL DEFAULT 0 CHECK (mention_count >= 0);
  ALTER TABLE storyhold.character_dossiers ADD COLUMN IF NOT EXISTS mention_source_count integer NOT NULL DEFAULT 0 CHECK (mention_source_count >= 0);
  ALTER TABLE storyhold.character_dossiers ADD COLUMN IF NOT EXISTS user_edited_at timestamptz;
  ALTER TABLE storyhold.character_dossiers ADD COLUMN IF NOT EXISTS alias_attributions jsonb NOT NULL DEFAULT '[]'::jsonb;

  CREATE TABLE IF NOT EXISTS storyhold.character_dossier_source_contributions (
    id uuid PRIMARY KEY,
    dossier_id uuid NOT NULL REFERENCES storyhold.character_dossiers(id) ON DELETE CASCADE,
    source_id uuid NOT NULL REFERENCES storyhold.world_sources(id) ON DELETE CASCADE,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    last_analysis_run_id uuid REFERENCES storyhold.world_analysis_runs(id) ON DELETE SET NULL,
    aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
    role text NOT NULL DEFAULT '',
    summary text NOT NULL DEFAULT '',
    profile jsonb NOT NULL DEFAULT '{}'::jsonb,
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    confidence real NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
    axis_estimate jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (dossier_id, source_id)
  );

  CREATE INDEX IF NOT EXISTS character_dossier_source_contributions_scope
    ON storyhold.character_dossier_source_contributions
      (world_id, canon_edition_id, source_id, dossier_id);

  CREATE INDEX IF NOT EXISTS character_dossiers_scope
    ON storyhold.character_dossiers (world_id, canon_edition_id, normalized_name);

  CREATE INDEX IF NOT EXISTS character_dossiers_text_search
    ON storyhold.character_dossiers
    USING GIN (to_tsvector('simple', coalesce(name, '') || ' ' ||
      coalesce(role, '') || ' ' || coalesce(summary, '')));

  CREATE TABLE IF NOT EXISTS storyhold.world_entities (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    dossier_id uuid REFERENCES storyhold.character_dossiers(id) ON DELETE SET NULL,
    source_analysis_run_id uuid REFERENCES storyhold.world_analysis_runs(id) ON DELETE SET NULL,
    canonical_key text NOT NULL,
    normalized_name text NOT NULL,
    name text NOT NULL,
    entity_type text NOT NULL DEFAULT 'ambiguous'
      CHECK (entity_type IN ('character', 'creature', 'species', 'place', 'faction', 'institution', 'government', 'power_structure', 'technology', 'vehicle', 'device', 'weapon', 'power', 'title', 'cultural_reference', 'term', 'ambiguous')),
    aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
    summary text NOT NULL DEFAULT '',
    details jsonb NOT NULL DEFAULT '[]'::jsonb,
    relationships jsonb NOT NULL DEFAULT '[]'::jsonb,
    estimated_stats jsonb NOT NULL DEFAULT '{}'::jsonb,
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    mention_count integer NOT NULL DEFAULT 0 CHECK (mention_count >= 0),
    mention_source_count integer NOT NULL DEFAULT 0 CHECK (mention_source_count >= 0),
    confidence real NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
    classification_source text NOT NULL DEFAULT 'local'
      CHECK (classification_source IN ('local', 'ai', 'user')),
    review_status text NOT NULL DEFAULT 'candidate'
      CHECK (review_status IN ('candidate', 'verified', 'user_confirmed')),
    pull_status text NOT NULL DEFAULT 'active'
      CHECK (pull_status IN ('active', 'do_not_pull', 'merged', 'deleted')),
    scanner_present boolean NOT NULL DEFAULT true,
    merged_into_entity_id uuid REFERENCES storyhold.world_entities(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (world_id, canon_edition_id, normalized_name),
    UNIQUE (world_id, canonical_key),
    UNIQUE (dossier_id)
  );

  ALTER TABLE storyhold.world_entities
    ADD COLUMN IF NOT EXISTS scanner_present boolean NOT NULL DEFAULT true;
  ALTER TABLE storyhold.world_entities
    ADD COLUMN IF NOT EXISTS estimated_stats jsonb NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE storyhold.world_entities
    ADD COLUMN IF NOT EXISTS alias_attributions jsonb NOT NULL DEFAULT '[]'::jsonb;
  -- Older Storyhold builds did not record dossier-edit ownership separately.
  -- A dossier already attached to a customer-confirmed/classified card must be
  -- treated as customer canon during the compatibility upgrade.
  UPDATE storyhold.character_dossiers dossier
     SET user_edited_at = COALESCE(entity.updated_at, dossier.updated_at, now())
    FROM storyhold.world_entities entity
   WHERE entity.dossier_id = dossier.id
     AND dossier.user_edited_at IS NULL
     AND (entity.classification_source = 'user'
       OR entity.review_status = 'user_confirmed'
       OR entity.pull_status <> 'active');

  CREATE INDEX IF NOT EXISTS world_entities_scope
    ON storyhold.world_entities (world_id, canon_edition_id, pull_status, entity_type, mention_count DESC);

  CREATE TABLE IF NOT EXISTS storyhold.world_entity_faction_memberships (
    entity_id uuid NOT NULL REFERENCES storyhold.world_entities(id) ON DELETE CASCADE,
    faction_entity_id uuid NOT NULL REFERENCES storyhold.world_entities(id) ON DELETE CASCADE,
    assignment_source text NOT NULL DEFAULT 'local'
      CHECK (assignment_source IN ('local', 'ai', 'user')),
    confidence real NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (entity_id, faction_entity_id),
    CHECK (entity_id <> faction_entity_id)
  );

  CREATE TABLE IF NOT EXISTS storyhold.world_entity_relations (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    source_entity_id uuid NOT NULL REFERENCES storyhold.world_entities(id) ON DELETE CASCADE,
    relation_type text NOT NULL CHECK (relation_type IN (
      'member_of', 'participates_in', 'species_of', 'subspecies_of', 'subtype_of',
      'lifecycle_stage_of', 'has_power', 'has_form', 'holds_title', 'allied_with',
      'child_of', 'sibling_of', 'spouse_of', 'friend_of', 'best_friend_of',
      'leads', 'governs', 'controlled_by', 'opposed_to', 'located_in',
      'part_of', 'created_by', 'related_to'
    )),
    target_entity_id uuid NOT NULL REFERENCES storyhold.world_entities(id) ON DELETE CASCADE,
    relation_status text NOT NULL DEFAULT 'active'
      CHECK (relation_status IN ('active', 'former', 'conditional', 'disputed', 'unknown')),
    summary text NOT NULL DEFAULT '',
    valid_from_label text NOT NULL DEFAULT '',
    valid_until_label text NOT NULL DEFAULT '',
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    assignment_source text NOT NULL DEFAULT 'local'
      CHECK (assignment_source IN ('local', 'ai', 'user')),
    confidence real NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (source_entity_id <> target_entity_id),
    UNIQUE (world_id, canon_edition_id, source_entity_id, relation_type,
            target_entity_id, relation_status, valid_from_label, valid_until_label)
  );

  CREATE INDEX IF NOT EXISTS world_entity_relations_scope
    ON storyhold.world_entity_relations
      (world_id, canon_edition_id, source_entity_id, target_entity_id, relation_type);

  CREATE TABLE IF NOT EXISTS storyhold.world_entity_rules (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    entity_id uuid NOT NULL REFERENCES storyhold.world_entities(id) ON DELETE CASCADE,
    canonical_key text NOT NULL,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    rule_kind text NOT NULL DEFAULT 'trait'
      CHECK (rule_kind IN ('trait', 'ability', 'constraint', 'biological', 'social', 'gameplay')),
    trigger_text text NOT NULL DEFAULT '',
    effect_text text NOT NULL DEFAULT '',
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    assignment_source text NOT NULL DEFAULT 'local'
      CHECK (assignment_source IN ('local', 'ai', 'user')),
    confidence real NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
    rule_status text NOT NULL DEFAULT 'active'
      CHECK (rule_status IN ('active', 'disputed', 'retired')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (world_id, canon_edition_id, entity_id, canonical_key)
  );

  CREATE INDEX IF NOT EXISTS world_entity_rules_scope
    ON storyhold.world_entity_rules (world_id, canon_edition_id, entity_id, rule_status);

  CREATE TABLE IF NOT EXISTS storyhold.world_entity_actions (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    performed_by_player_id uuid NOT NULL REFERENCES storyhold.players(id) ON DELETE RESTRICT,
    action_type text NOT NULL CHECK (action_type IN ('merge')),
    summary text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    undone_at timestamptz,
    undone_by_player_id uuid REFERENCES storyhold.players(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS world_entity_actions_scope
    ON storyhold.world_entity_actions (world_id, canon_edition_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS storyhold.cohesion_proposals (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    analysis_run_id uuid NOT NULL REFERENCES storyhold.world_analysis_runs(id) ON DELETE CASCADE,
    fingerprint text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('contradiction', 'duplicate', 'timeline', 'identity', 'continuity', 'ambiguity')),
    subject text NOT NULL,
    summary text NOT NULL,
    severity text NOT NULL CHECK (severity IN ('info', 'warning', 'conflict')),
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'dismissed')),
    classification text CHECK (classification IS NULL OR classification IN ('canon_correction', 'intentional_contradiction', 'unreliable_narration', 'alternate_edition', 'needs_research')),
    reviewed_by_player_id uuid REFERENCES storyhold.players(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    reviewed_at timestamptz,
    UNIQUE (world_id, canon_edition_id, fingerprint)
  );

  CREATE INDEX IF NOT EXISTS cohesion_proposals_review_scope
    ON storyhold.cohesion_proposals (world_id, canon_edition_id, review_status, created_at DESC);

  CREATE TABLE IF NOT EXISTS storyhold.player_canon_integrity (
    id uuid PRIMARY KEY,
    player_id uuid NOT NULL REFERENCES storyhold.players(id) ON DELETE CASCADE,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    campaign_id uuid REFERENCES storyhold.campaigns(id) ON DELETE CASCADE,
    scope_key text NOT NULL,
    unsupported_attempts integer NOT NULL DEFAULT 0 CHECK (unsupported_attempts >= 0),
    suspected_manipulation_attempts integer NOT NULL DEFAULT 0 CHECK (suspected_manipulation_attempts >= 0),
    strictness_level integer NOT NULL DEFAULT 0 CHECK (strictness_level >= 0 AND strictness_level <= 4),
    last_signal_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (player_id, world_id, scope_key)
  );

  CREATE TABLE IF NOT EXISTS storyhold.canon_discrepancy_reports (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    campaign_id uuid REFERENCES storyhold.campaigns(id) ON DELETE CASCADE,
    reported_by_player_id uuid NOT NULL REFERENCES storyhold.players(id) ON DELETE RESTRICT,
    canonical_key text NOT NULL,
    claim text NOT NULL,
    reasoning text NOT NULL DEFAULT '',
    status text NOT NULL CHECK (status IN ('needs_reason', 'correction_offered', 'applied', 'rejected')),
    review_explanation text NOT NULL DEFAULT '',
    review_confidence real NOT NULL DEFAULT 0 CHECK (review_confidence >= 0 AND review_confidence <= 1),
    review_provider text NOT NULL,
    review_model text NOT NULL,
    strictness_level integer NOT NULL DEFAULT 0,
    proposed_amendment jsonb,
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    integrity_risk text NOT NULL DEFAULT 'none' CHECK (integrity_risk IN ('none', 'unsupported_override', 'suspected_manipulation')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    UNIQUE (world_id, canonical_key)
  );

  CREATE INDEX IF NOT EXISTS discrepancy_reports_player_scope
    ON storyhold.canon_discrepancy_reports (reported_by_player_id, world_id, campaign_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS storyhold.canon_amendments (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    campaign_id uuid REFERENCES storyhold.campaigns(id) ON DELETE CASCADE,
    discrepancy_report_id uuid NOT NULL UNIQUE REFERENCES storyhold.canon_discrepancy_reports(id) ON DELETE RESTRICT,
    created_by_player_id uuid NOT NULL REFERENCES storyhold.players(id) ON DELETE RESTRICT,
    canonical_key text NOT NULL,
    subject text NOT NULL,
    operation text NOT NULL CHECK (operation IN ('clarify', 'correct', 'invalidate', 'supersede')),
    statement text NOT NULL,
    previous_statement text NOT NULL DEFAULT '',
    rationale text NOT NULL,
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    decision_source text NOT NULL CHECK (decision_source IN ('source_evidence', 'reasoned_consistency')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (world_id, canonical_key)
  );

  CREATE INDEX IF NOT EXISTS canon_amendments_retrieval_scope
    ON storyhold.canon_amendments (world_id, canon_edition_id, campaign_id, created_at ASC);

  CREATE TABLE IF NOT EXISTS storyhold.canon_integrity_signals (
    id uuid PRIMARY KEY,
    integrity_id uuid NOT NULL REFERENCES storyhold.player_canon_integrity(id) ON DELETE CASCADE,
    discrepancy_report_id uuid NOT NULL REFERENCES storyhold.canon_discrepancy_reports(id) ON DELETE CASCADE,
    player_id uuid NOT NULL REFERENCES storyhold.players(id) ON DELETE CASCADE,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    campaign_id uuid REFERENCES storyhold.campaigns(id) ON DELETE CASCADE,
    signal_type text NOT NULL CHECK (signal_type IN ('unsupported_override_attempt', 'suspected_manipulation_attempt')),
    internal_note text NOT NULL,
    strictness_before integer NOT NULL,
    strictness_after integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS canon_integrity_signal_scope
    ON storyhold.canon_integrity_signals (player_id, world_id, campaign_id, created_at DESC);

  ALTER TABLE storyhold.campaigns
    ADD COLUMN IF NOT EXISTS canon_edition_id uuid REFERENCES storyhold.canon_editions(id) ON DELETE RESTRICT;
  ALTER TABLE storyhold.campaigns
    ADD COLUMN IF NOT EXISTS perspective_character_id uuid REFERENCES storyhold.characters(id) ON DELETE SET NULL;
  -- World cards and campaign lists exclude branches before campaignPlay's
  -- migrations run, including on new or restored pre-branch databases.
  ALTER TABLE storyhold.campaigns
    ADD COLUMN IF NOT EXISTS parent_campaign_id uuid
      REFERENCES storyhold.campaigns(id) ON DELETE CASCADE;
  ALTER TABLE storyhold.campaigns ADD COLUMN IF NOT EXISTS current_time_label text NOT NULL DEFAULT 'The beginning';
  ALTER TABLE storyhold.campaigns ADD COLUMN IF NOT EXISTS world_time_minutes bigint NOT NULL DEFAULT 0;
  ALTER TABLE storyhold.campaigns
    ADD COLUMN IF NOT EXISTS resolution_mode text NOT NULL DEFAULT 'story_first'
      CHECK (resolution_mode IN ('story_first', 'light_rules', 'tactical', 'custom'));
  ALTER TABLE storyhold.campaigns
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'paused', 'completed', 'archived'));

  -- Reinstall the complete campaign-start lock after all world-studio campaign
  -- columns exist. This upgrades established local databases as well as new ones.
  CREATE OR REPLACE FUNCTION storyhold.reject_locked_start_change()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF OLD.start_locked_at IS NOT NULL AND (
      NEW.world_id IS DISTINCT FROM OLD.world_id OR
      NEW.canon_edition_id IS DISTINCT FROM OLD.canon_edition_id OR
      NEW.ruleset_id IS DISTINCT FROM OLD.ruleset_id OR
      NEW.owner_player_id IS DISTINCT FROM OLD.owner_player_id OR
      NEW.perspective_character_id IS DISTINCT FROM OLD.perspective_character_id OR
      NEW.resolution_mode IS DISTINCT FROM OLD.resolution_mode OR
      NEW.start_contract IS DISTINCT FROM OLD.start_contract OR
      NEW.start_locked_at IS DISTINCT FROM OLD.start_locked_at
    ) THEN
      RAISE EXCEPTION 'A locked campaign start cannot be changed';
    END IF;
    RETURN NEW;
  END;
  $$;

  DROP TRIGGER IF EXISTS campaigns_lock_start_contract ON storyhold.campaigns;
  CREATE TRIGGER campaigns_lock_start_contract
    BEFORE UPDATE ON storyhold.campaigns
    FOR EACH ROW EXECUTE FUNCTION storyhold.reject_locked_start_change();

  CREATE TABLE IF NOT EXISTS storyhold.world_chapter_summaries (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    source_id uuid NOT NULL REFERENCES storyhold.world_sources(id) ON DELETE CASCADE,
    canonical_key text NOT NULL,
    chapter_title text NOT NULL,
    perspective text NOT NULL DEFAULT '',
    source_order integer NOT NULL DEFAULT 0,
    summary text NOT NULL DEFAULT '',
    major_events jsonb NOT NULL DEFAULT '[]'::jsonb,
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    summary_source text NOT NULL DEFAULT 'local'
      CHECK (summary_source IN ('local', 'ai', 'user')),
    confidence real NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (world_id, canonical_key)
  );

  CREATE INDEX IF NOT EXISTS world_chapter_summary_source_order
    ON storyhold.world_chapter_summaries (world_id, source_id, source_order);

  CREATE TABLE IF NOT EXISTS storyhold.world_clock_events (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    campaign_id uuid REFERENCES storyhold.campaigns(id) ON DELETE CASCADE,
    source_id uuid REFERENCES storyhold.world_sources(id) ON DELETE SET NULL,
    created_by_player_id uuid REFERENCES storyhold.players(id) ON DELETE SET NULL,
    visible_to_character_id uuid REFERENCES storyhold.characters(id) ON DELETE CASCADE,
    causal_parent_id uuid REFERENCES storyhold.world_clock_events(id) ON DELETE SET NULL,
    canonical_key text NOT NULL,
    event_kind text NOT NULL
      CHECK (event_kind IN ('canon', 'scene', 'commitment', 'reminder', 'discovery', 'state_change', 'scheduled_effect', 'ruling')),
    title text NOT NULL,
    summary text NOT NULL DEFAULT '',
    world_time_label text NOT NULL DEFAULT '',
    chronology_order bigint NOT NULL DEFAULT 0,
    visibility text NOT NULL DEFAULT 'world'
      CHECK (visibility IN ('world', 'campaign', 'character', 'system', 'studio')),
    knowledge_status text NOT NULL DEFAULT 'observed'
      CHECK (knowledge_status IN ('observed', 'told', 'inferred', 'disputed', 'secret', 'revealed')),
    known_effects jsonb NOT NULL DEFAULT '[]'::jsonb,
    internal_effects jsonb NOT NULL DEFAULT '[]'::jsonb,
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    scheduled_for_label text NOT NULL DEFAULT '',
    reveal_rule jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'committed'
      CHECK (status IN ('committed', 'scheduled', 'resolved', 'cancelled', 'superseded')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (world_id, canonical_key)
  );

  ALTER TABLE storyhold.world_clock_events ADD COLUMN IF NOT EXISTS due_world_time_minutes bigint;
  ALTER TABLE storyhold.world_clock_events ADD COLUMN IF NOT EXISTS due_turn_number bigint;
  ALTER TABLE storyhold.world_clock_events ADD COLUMN IF NOT EXISTS matured_at timestamptz;
  ALTER TABLE storyhold.world_clock_events ADD COLUMN IF NOT EXISTS matured_state_version bigint;
  ALTER TABLE storyhold.world_clock_events ADD COLUMN IF NOT EXISTS maturation_narrated_at timestamptz;
  ALTER TABLE storyhold.world_clock_events
    ADD COLUMN IF NOT EXISTS temporal_status text NOT NULL DEFAULT 'relative'
      CHECK (temporal_status IN ('exact', 'relative', 'uncertain', 'parallel'));
  ALTER TABLE storyhold.world_clock_events
    ADD COLUMN IF NOT EXISTS importance text NOT NULL DEFAULT 'major'
      CHECK (importance IN ('major', 'turning_point'));
  ALTER TABLE storyhold.world_clock_events ADD COLUMN IF NOT EXISTS source_chapter_keys jsonb NOT NULL DEFAULT '[]'::jsonb;

  CREATE INDEX IF NOT EXISTS world_clock_world_scope
    ON storyhold.world_clock_events (world_id, campaign_id, visibility, chronology_order, created_at);
  CREATE INDEX IF NOT EXISTS world_clock_character_scope
    ON storyhold.world_clock_events (visible_to_character_id, campaign_id, chronology_order);
  CREATE INDEX IF NOT EXISTS world_clock_due_scope
    ON storyhold.world_clock_events (campaign_id, status, due_world_time_minutes, due_turn_number);

  CREATE TABLE IF NOT EXISTS storyhold.campaign_runtime_rules (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    campaign_id uuid NOT NULL REFERENCES storyhold.campaigns(id) ON DELETE CASCADE,
    canonical_key text NOT NULL,
    name text NOT NULL,
    rule_kind text NOT NULL
      CHECK (rule_kind IN ('world_rule', 'trigger', 'clock', 'ad_hoc_ruling', 'safety_boundary')),
    trigger_definition jsonb NOT NULL DEFAULT '{}'::jsonb,
    requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
    effects jsonb NOT NULL DEFAULT '[]'::jsonb,
    visibility text NOT NULL DEFAULT 'system'
      CHECK (visibility IN ('player', 'system', 'studio')),
    authored_by text NOT NULL DEFAULT 'storyhold'
      CHECK (authored_by IN ('source', 'player', 'storyhold', 'imported_ruleset')),
    status text NOT NULL DEFAULT 'active'
      CHECK (status IN ('draft', 'active', 'resolved', 'retired')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (campaign_id, canonical_key)
  );

  CREATE INDEX IF NOT EXISTS campaign_runtime_rules_scope
    ON storyhold.campaign_runtime_rules (campaign_id, status, rule_kind);

  CREATE TABLE IF NOT EXISTS storyhold.ai_usage_ledger (
    id uuid PRIMARY KEY,
    player_id uuid NOT NULL REFERENCES storyhold.players(id) ON DELETE RESTRICT,
    world_id uuid REFERENCES storyhold.worlds(id) ON DELETE SET NULL,
    campaign_id uuid REFERENCES storyhold.campaigns(id) ON DELETE SET NULL,
    operation text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    input_units integer NOT NULL DEFAULT 0 CHECK (input_units >= 0),
    output_units integer NOT NULL DEFAULT 0 CHECK (output_units >= 0),
    cost_micros bigint NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
    cache_hit boolean NOT NULL DEFAULT false,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS ai_usage_storyhold_scope
    ON storyhold.ai_usage_ledger (player_id, world_id, campaign_id, created_at DESC);

  CREATE OR REPLACE FUNCTION storyhold.reject_canon_audit_mutation()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'Canon amendments and integrity signals are append-only';
  END;
  $$;

  DROP TRIGGER IF EXISTS canon_amendments_append_only ON storyhold.canon_amendments;
  CREATE TRIGGER canon_amendments_append_only
    BEFORE UPDATE OR DELETE ON storyhold.canon_amendments
    FOR EACH ROW EXECUTE FUNCTION storyhold.reject_canon_audit_mutation();

  DROP TRIGGER IF EXISTS canon_integrity_signals_append_only ON storyhold.canon_integrity_signals;
  CREATE TRIGGER canon_integrity_signals_append_only
    BEFORE UPDATE OR DELETE ON storyhold.canon_integrity_signals
    FOR EACH ROW EXECUTE FUNCTION storyhold.reject_canon_audit_mutation();

  -- One canonical source for every customer-facing world summary card. Raw
  -- character drafts remain useful to the analysis workflow, but "people
  -- found" means deduplicated active Hold dossiers in the current edition.
  CREATE OR REPLACE VIEW storyhold.world_card_stats AS
  SELECT w.id AS world_id,
         (SELECT count(*)::int
            FROM storyhold.world_sources source
           WHERE source.world_id = w.id
             AND source.canon_edition_id = edition.id) AS source_count,
         (SELECT COALESCE(sum(source.word_count), 0)::bigint
            FROM storyhold.world_sources source
           WHERE source.world_id = w.id
             AND source.canon_edition_id = edition.id
             AND source.processing_status = 'ready') AS word_count,
         (SELECT COALESCE(sum(source.chunk_count), 0)::bigint
            FROM storyhold.world_sources source
           WHERE source.world_id = w.id
             AND source.canon_edition_id = edition.id
             AND source.processing_status = 'ready') AS chunk_count,
         (SELECT count(*)::int
            FROM storyhold.world_entities entity
           WHERE entity.world_id = w.id
             AND entity.canon_edition_id = edition.id
             AND entity.pull_status = 'active'
             AND entity.scanner_present = true
             AND entity.entity_type = 'character') AS people_count,
         (SELECT count(*)::int
            FROM storyhold.campaigns campaign
           WHERE campaign.world_id = w.id
             AND campaign.parent_campaign_id IS NULL) AS campaign_count
    FROM storyhold.worlds w
    LEFT JOIN LATERAL (
      SELECT canon.id
        FROM storyhold.canon_editions canon
       WHERE canon.world_id = w.id
       ORDER BY canon.created_at ASC
       LIMIT 1
    ) edition ON true;
`;

function slug(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "world"
  );
}

function textBody(value: unknown, maximum: number): string {
  return typeof value === "string"
    ? value.replace(/\r\n/g, "\n").trim().slice(0, maximum)
    : "";
}

function recordBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringList(value: unknown, maximumItems = 20, maximumLength = 400) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => textBody(item, maximumLength))
    .filter(Boolean)
    .slice(0, maximumItems);
}

function cleanWorldContract(value: unknown) {
  const input = recordBody(value);
  return {
    identity: textBody(input.identity, 2_000),
    premise: textBody(input.premise, 6_000),
    tone: textBody(input.tone, 1_000),
    startingPoint: textBody(input.startingPoint, 2_000),
    constraints: stringList(input.constraints),
    exclusions: stringList(input.exclusions),
    worldRules: stringList(input.worldRules),
    playerPriorities: stringList(input.playerPriorities),
  };
}

function cleanContentSettings(value: unknown) {
  const input = recordBody(value);
  const sexualContent = ["off", "fade_to_black", "explicit"].includes(
    String(input.sexualContent),
  )
    ? String(input.sexualContent)
    : "off";
  const violence = ["standard", "graphic"].includes(String(input.violence))
    ? String(input.violence)
    : "standard";
  return { sexualContent, violence };
}

function contractForNewWorld(params: {
  value: unknown;
  premise: string;
  genre: string;
}) {
  const contract = cleanWorldContract(params.value);
  return {
    ...contract,
    premise: contract.premise || params.premise,
    tone: contract.tone || params.genre,
  };
}

function headerText(req: Request, name: string, maximum: number): string {
  const raw = req.header(name) ?? "";
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  return decoded
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, maximum);
}

function extensionFor(filename: string, type: DocumentType): string {
  const extension = path
    .extname(filename)
    .toLocaleLowerCase()
    .replace(/[^.a-z0-9]/g, "");
  return extension && extension.length <= 12 ? extension : `.${type}`;
}

function wordCount(text: string): number {
  return text.trim() ? (text.match(/\S+/g) ?? []).length : 0;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "null" : serialized;
}

/** Stable across JSONB key reordering, so the paid audit can pin one snapshot. */
export function lorekeeperSnapshotFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export type LorekeeperCorpusFingerprintSource = {
  id: string;
  contentHash: string;
  wordCount: number;
  chunkCount: number;
  chronologyOrder: number;
  sortOrder: number;
  createdAt: string;
};

export function lorekeeperCorpusFingerprint(
  sources: LorekeeperCorpusFingerprintSource[],
): string {
  return lorekeeperSnapshotFingerprint({
    fingerprintVersion: 1,
    localAnalysisVersion: LOCAL_ANALYSIS_VERSION,
    sources: [...sources]
      .sort((left, right) =>
        Number(left.chronologyOrder) - Number(right.chronologyOrder) ||
        Number(left.sortOrder) - Number(right.sortOrder) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id)
      )
      .map((source) => ({
        id: source.id,
        contentHash: source.contentHash,
        wordCount: Math.max(0, Number(source.wordCount) || 0),
        chunkCount: Math.max(0, Number(source.chunkCount) || 0),
        chronologyOrder: Number(source.chronologyOrder) || 0,
        sortOrder: Number(source.sortOrder) || 0,
        createdAt: source.createdAt,
      })),
  });
}

export function lorekeeperConstraintSnapshotFingerprint(
  constraints: Array<{ fingerprint: string }>,
): string {
  return lorekeeperSnapshotFingerprint(
    constraints
      .map((constraint) => constraint.fingerprint.trim())
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right)),
  );
}

export type WorldIntakeActivityKind =
  | "source"
  | "discovery"
  | "classification"
  | "verification"
  | "relationship"
  | "dossier"
  | "stat"
  | "chronology"
  | "complete"
  | "warning";

export type WorldIntakeActivity = {
  id: string;
  dedupeKey: string;
  kind: WorldIntakeActivityKind;
  label: string;
  detail: string;
  entityName: string | null;
  entityType: string | null;
  occurredAt: string;
};

type WorldIntakeActivityDraft = Omit<WorldIntakeActivity, "id" | "occurredAt">;

const MAX_INTAKE_ACTIVITY = 320;

const intakeCategoryLabels: Record<string, string> = {
  character: "person",
  place: "place",
  faction: "faction",
  institution: "institution",
  government: "government",
  power_structure: "power structure",
  creature: "creature",
  species: "species",
  technology: "technology",
  vehicle: "vehicle",
  device: "device",
  weapon: "weapon",
  power: "power",
  title: "title",
  cultural_reference: "cultural reference",
  term: "term or moniker",
  ambiguous: "Unknown for Now",
};

export const intakeActivityPhraseInventory = {
  discovery: [
    "Research",
    "Discovering",
    "Looking Deeper into",
    "Better Understanding",
    "Attempting to Identify",
    "Investigating",
    "Tracing Mentions of",
    "Examining Evidence for",
    "Mapping References to",
    "Following References to",
    "Gathering Context for",
    "Comparing Mentions of",
    "Building Context for",
    "Studying",
    "Resolving References to",
    "Connecting Clues around",
  ],
  classification: [
    "Classifying",
    "Structuring",
    "Organizing",
    "Recognizing",
    "Interpreting",
    "Sorting",
    "Reframing",
    "Distinguishing",
    "Establishing",
    "Cataloging",
    "Positioning",
    "Understanding",
  ],
  verification: [
    "Verifying",
    "Confirming Evidence for",
    "Cross-Checking",
    "Validating Source Support for",
    "Reconciling Mentions of",
    "Checking Continuity around",
    "Testing Interpretations of",
    "Reviewing Evidence for",
  ],
} as const;

function intakePhrase(seed: string, phrases: readonly string[]): string {
  let hash = 2_166_136_261;
  for (const character of seed) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return phrases[(hash >>> 0) % phrases.length]!;
}

function intakeEntityActivityLabel(params: {
  action: keyof typeof intakeActivityPhraseInventory;
  name: string;
  category: string;
}) {
  const phrase = intakePhrase(
    `${params.action}:${params.category}:${params.name.toLocaleLowerCase()}`,
    intakeActivityPhraseInventory[params.action],
  );
  const displayName = toChicagoTitleCase(params.name);
  if (params.action === "classification") {
    const category = params.category === "ambiguous"
      ? "Unknown for Now"
      : intakeCategoryLabels[params.category] ?? params.category.replaceAll("_", " ");
    return `${phrase} ${displayName} as ${toChicagoTitleCase(category)}`;
  }
  return `${phrase} ${displayName}`;
}

function intakeActivityRows(value: unknown): WorldIntakeActivity[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = recordBody(item);
    const kind = textBody(row.kind, 40) as WorldIntakeActivityKind;
    const storedLabel = textBody(row.label, 240);
    const dedupeKey = textBody(row.dedupeKey, 320);
    if (!storedLabel || !dedupeKey || ![
      "source", "discovery", "classification", "verification", "relationship",
      "dossier", "stat", "chronology", "complete", "warning",
    ].includes(kind)) return [];
    const entityName = textBody(row.entityName, 200) || null;
    const entityType = textBody(row.entityType, 80) || null;
    const label = entityName && entityType && kind === "discovery" && /^finding\s/iu.test(storedLabel)
      ? intakeEntityActivityLabel({ action: "discovery", name: entityName, category: entityType })
      : entityName && entityType && kind === "classification" && /^(?:clarifying|classifying)\s/iu.test(storedLabel)
        ? intakeEntityActivityLabel({ action: "classification", name: entityName, category: entityType })
        : toChicagoTitleCase(storedLabel);
    return [{
      id: textBody(row.id, 80) || randomUUID(),
      dedupeKey,
      kind,
      label,
      detail: textBody(row.detail, 500),
      entityName,
      entityType,
      occurredAt: textBody(row.occurredAt, 80) || new Date(0).toISOString(),
    }];
  });
}

const CUSTOMER_UNSAFE_INTAKE_ACTIVITY_LANGUAGE = /(?:\b(?:Qwen|GLiNER|MiniLM|BGE)(?:[-_. ]?[\dA-Za-z]+)*\b|\bllama\s*\.?\s*cpp\b|\b(?:WebGPU|CUDA|ONNX|transformers?|Python)\b|\b(?:backend|provider|runtime|worker|pipeline|process(?:ing)?|stage|checkpoint|fallback|batch|pass|scan|extract(?:ion|or|ed|ing)|semantic|deterministic|coreference|inference|embeddings?|vectorization|browser|server|local(?:ly)?)\b|\b(?:NER|NLI|LLM)\b|\b(?:AI|language)\s+model\b)/iu;
const CONNECTED_VERIFICATION_COMPLETE = /\bconnected\s+(?:AI\s+)?verification\s+complete(?:d)?\b/iu;

type CustomerIntakeActivityContext = {
  runId?: unknown;
  analysisKind?: unknown;
  status?: unknown;
  stage?: unknown;
  synthesisStatus?: unknown;
};

function customerSafeActivityCopy(
  event: WorldIntakeActivity,
  field: "label" | "detail",
): string {
  const entityName = event.entityName &&
      !CUSTOMER_UNSAFE_INTAKE_ACTIVITY_LANGUAGE.test(event.entityName)
    ? toChicagoTitleCase(event.entityName)
    : "";
  const copy: Record<WorldIntakeActivityKind, { label: string; detail: string }> = {
    source: {
      label: "Reading Canon Sources",
      detail: "The uploaded writing is being read and organized into durable story evidence.",
    },
    discovery: {
      label: entityName ? `Researching ${entityName}` : "Discovering Story Concepts",
      detail: "Names, places, objects, groups, and other story concepts are being connected to their source passages.",
    },
    classification: {
      label: entityName ? `Better Understanding ${entityName}` : "Organizing Story Concepts",
      detail: "The available source passages are being used to distinguish what each story concept represents.",
    },
    verification: {
      label: entityName ? `Reviewing Evidence for ${entityName}` : "Reviewing Canon Evidence",
      detail: "Proposed facts and interpretations are being checked against cited story evidence.",
    },
    relationship: {
      label: "Mapping Story Relationships",
      detail: "Character ties and other directed connections are being organized from source evidence.",
    },
    dossier: {
      label: entityName ? `Developing ${entityName}'s Dossier` : "Developing Character Dossiers",
      detail: "Source-backed traits, actions, and defining facts are being organized into readable dossiers.",
    },
    stat: {
      label: entityName ? `Assessing ${entityName}'s Abilities` : "Assessing Story Abilities",
      detail: "Abilities and limitations are being assessed from cited actions and outcomes.",
    },
    chronology: {
      label: "Arranging Canonical Events",
      detail: "Events are being arranged in story order from source evidence.",
    },
    complete: {
      label: "Story Understanding Ready",
      detail: "The current story understanding is saved and ready to explore.",
    },
    warning: {
      label: "Canon Intake Needs Attention",
      detail: "Completed work remains saved. Canon Intake can continue from the latest durable point.",
    },
  };
  return copy[event.kind][field];
}

/**
 * Historical activity is intentionally retained verbatim in the database for
 * debugging and resumability. This projection is the compatibility boundary
 * for customer responses: it removes implementation names and old processing
 * copy without rewriting the durable intake receipt.
 */
export function customerSafeIntakeActivityRows(
  value: unknown,
  context: CustomerIntakeActivityContext = {},
): WorldIntakeActivity[] {
  const runId = textBody(context.runId, 80);
  const analysisKind = textBody(context.analysisKind, 40);
  const status = textBody(context.status, 40);
  const stage = textBody(context.stage, 500);
  const synthesisStatus = textBody(context.synthesisStatus, 40);
  const canClaimConnectedCompletion = analysisKind === "ai_enrichment" &&
    status === "completed" &&
    synthesisStatus === "completed" &&
    !/\b(?:partial|remaining|retry|failed|needs attention|affordable portion)\b/iu.test(stage);

  return intakeActivityRows(value).map((event) => {
    const belongsToCurrentRun = Boolean(runId) &&
      event.dedupeKey.startsWith(`${runId}:`);
    const connectedCompletion = CONNECTED_VERIFICATION_COMPLETE.test(event.label) ||
      CONNECTED_VERIFICATION_COMPLETE.test(event.detail);
    const falseConnectedCompletion = connectedCompletion &&
      !(canClaimConnectedCompletion && belongsToCurrentRun);
    const unsafeLabel = falseConnectedCompletion ||
      CUSTOMER_UNSAFE_INTAKE_ACTIVITY_LANGUAGE.test(event.label);
    const unsafeDetail = falseConnectedCompletion ||
      CUSTOMER_UNSAFE_INTAKE_ACTIVITY_LANGUAGE.test(event.detail);

    return {
      ...event,
      // Dedupe keys can contain an extractor/model name in older receipts. The
      // public key only needs to be stable; the original remains stored.
      dedupeKey: `activity:${createHash("sha256").update(event.dedupeKey).digest("hex").slice(0, 24)}`,
      label: unsafeLabel ? customerSafeActivityCopy(event, "label") : event.label,
      detail: unsafeDetail ? customerSafeActivityCopy(event, "detail") : event.detail,
    };
  });
}

export function intakeActivityFromPreview(
  previous: WorldAnalysisIntakePreview | null | undefined,
  current: WorldAnalysisIntakePreview,
): WorldIntakeActivityDraft[] {
  const previousByName = new Map(
    (previous?.terms ?? []).map((term) => [
      term.name.trim().toLocaleLowerCase(),
      term,
    ]),
  );
  const events: WorldIntakeActivityDraft[] = [];
  for (const term of current.terms) {
    const name = textBody(term.name, 200);
    if (!name) continue;
    const folded = name.toLocaleLowerCase();
    const prior = previousByName.get(folded);
    const categoryLabel = intakeCategoryLabels[term.category] ?? term.category;
    const mentions = Math.max(0, Number(term.mentionCount ?? 0));
    const detail = `${categoryLabel}${mentions ? ` · ${mentions.toLocaleString()} source mention${mentions === 1 ? "" : "s"}` : ""}`;
    if (!prior) {
      events.push({
        dedupeKey: `found:${term.category}:${folded}`,
        kind: "discovery",
        label: intakeEntityActivityLabel({
          action: "discovery",
          name,
          category: term.category,
        }),
        detail,
        entityName: name,
        entityType: term.category,
      });
      events.push({
        dedupeKey: `classified:${term.category}:${folded}`,
        kind: "classification",
        label: intakeEntityActivityLabel({
          action: "classification",
          name,
          category: term.category,
        }),
        detail: term.category === "ambiguous"
          ? "The evidence is preserved without forcing a premature identity."
          : `${categoryLabel} · organized from source evidence`,
        entityName: name,
        entityType: term.category,
      });
    } else if (prior.category !== term.category) {
      events.push({
        dedupeKey: `classified:${term.category}:${folded}`,
        kind: "classification",
        label: intakeEntityActivityLabel({
          action: "classification",
          name,
          category: term.category,
        }),
        detail: prior.category === "ambiguous"
          ? "A tentative label gained enough context to sort."
          : `Reconsidered from ${intakeCategoryLabels[prior.category] ?? prior.category}.`,
        entityName: name,
        entityType: term.category,
      });
    }
    if (term.reviewStatus === "verified" && prior?.reviewStatus !== "verified") {
      events.push({
        dedupeKey: `verified:${term.category}:${folded}`,
        kind: "verification",
        label: intakeEntityActivityLabel({
          action: "verification",
          name,
          category: term.category,
        }),
        detail: `${categoryLabel} · checked against source evidence`,
        entityName: name,
        entityType: term.category,
      });
    }
  }
  const phaseCopy: Record<WorldAnalysisIntakePreview["phase"], [WorldIntakeActivityKind, string]> = {
    deterministic: ["source", "Private Term Scan Assembled"],
    semantic: ["classification", "Classifying Names and Story Concepts"],
    fallback: ["warning", "Preserving the Local Term Inventory"],
    complete: ["complete", current.extractor.includes("Storyhold rules")
      ? "Private Source Reading Complete"
      : /(?:Lorekeeper|local\s+sequence)/iu.test(current.extractor)
        ? "Story Understanding Ready"
        : "Connected Verification Complete"],
  };
  const [kind, label] = phaseCopy[current.phase];
  events.push({
    dedupeKey: `phase:${current.phase}:${current.extractor}`,
    kind,
    label,
    detail: current.message,
    entityName: null,
    entityType: null,
  });
  return events;
}

export function intakePersistenceActivity(
  findings: WorldFindings,
): WorldIntakeActivityDraft[] {
  const events: WorldIntakeActivityDraft[] = [];
  for (const character of findings.characters.slice(0, 100)) {
    const evidenceCount = character.evidence.length;
    events.push({
      dedupeKey: `dossier:${character.name.toLocaleLowerCase()}`,
      kind: "dossier",
      label: toChicagoTitleCase(`Developing ${character.name}'s dossier`),
      detail: `${evidenceCount.toLocaleString()} cited passage${evidenceCount === 1 ? "" : "s"} · ${character.relationshipWeb.length.toLocaleString()} mapped relationship${character.relationshipWeb.length === 1 ? "" : "s"}`,
      entityName: character.name,
      entityType: "character",
    });
    const supportedStats = Object.entries(character.estimatedStats)
      .filter(([, estimate]) => estimate.evidence.length > 0 && estimate.confidence > 0)
      .map(([name]) => name);
    if (supportedStats.length) {
      events.push({
        dedupeKey: `stats:${character.name.toLocaleLowerCase()}`,
        kind: "stat",
        label: toChicagoTitleCase(`Estimating ${character.name}'s supported stats`),
        detail: `${supportedStats.length.toLocaleString()} estimate${supportedStats.length === 1 ? "" : "s"} supported by source evidence`,
        entityName: character.name,
        entityType: "character",
      });
    }
  }
  if (findings.entityRelations.length) {
    events.push({
      dedupeKey: `relationships:${findings.entityRelations.length}`,
      kind: "relationship",
      label: toChicagoTitleCase(`Connecting ${findings.entityRelations.length.toLocaleString()} relationships`),
      detail: "Memberships, identities, titles, family ties, and other directed connections.",
      entityName: null,
      entityType: null,
    });
  }
  if ((findings.claims?.length ?? 0) > 0) {
    events.push({
      dedupeKey: `claims:${findings.claims!.length}`,
      kind: "verification",
      label: toChicagoTitleCase(`Separating ${findings.claims!.length.toLocaleString()} facts, beliefs, and disputed claims`),
      detail: "Literal canon is kept distinct from rumor, metaphor, mistaken belief, and unresolved interpretation.",
      entityName: null,
      entityType: null,
    });
  }
  if (findings.chronology.length || findings.chapterSummaries.length) {
    events.push({
      dedupeKey: `chronology:${findings.chapterSummaries.length}:${findings.chronology.length}`,
      kind: "chronology",
      label: toChicagoTitleCase(`Arranging ${findings.chronology.length.toLocaleString()} canonical events`),
      detail: `${findings.chapterSummaries.length.toLocaleString()} chapter summar${findings.chapterSummaries.length === 1 ? "y" : "ies"} checked in story-time order`,
      entityName: null,
      entityType: null,
    });
  }
  return events;
}

async function appendIntakeActivity(
  db: StudioDb,
  runId: string,
  drafts: WorldIntakeActivityDraft[],
) {
  if (!drafts.length) return;
  const result = await db.query<{ intake_activity: unknown }>(
    `SELECT intake_activity FROM storyhold.world_analysis_runs WHERE id = $1 LIMIT 1`,
    [runId],
  );
  const current = intakeActivityRows(result.rows[0]?.intake_activity);
  const seen = new Set(current.map((event) => event.dedupeKey));
  const occurredAt = new Date().toISOString();
  for (const draft of drafts) {
    if (seen.has(draft.dedupeKey)) continue;
    seen.add(draft.dedupeKey);
    current.push({
      ...draft,
      id: randomUUID(),
      occurredAt,
    });
  }
  await db.query(
    `UPDATE storyhold.world_analysis_runs SET intake_activity = $2::jsonb WHERE id = $1`,
    [runId, json(current.slice(-MAX_INTAKE_ACTIVITY))],
  );
}

function currentUser(req: StudioRequest): StudioUser {
  if (!req.localUser)
    throw new Error("Authenticated user was not attached to the request.");
  return req.localUser;
}

function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function assertUuid(value: string, res: Response): boolean {
  if (UUID_PATTERN.test(value)) return true;
  res.status(404).json({ error: "World not found." });
  return false;
}

export function worldUploadDirectoryForDeletion(
  storageRoot: string,
  worldId: string,
): string {
  if (!UUID_PATTERN.test(worldId)) throw new Error("Invalid world identifier.");
  const uploadsRoot = path.resolve(storageRoot, "uploads");
  const target = path.resolve(uploadsRoot, worldId);
  if (path.dirname(target) !== uploadsRoot) {
    throw new Error("The world upload directory escaped the storage root.");
  }
  return target;
}

async function ownedWorld(db: StudioDb, worldId: string, playerId: string) {
  const result = await db.query<{
    id: string;
    owner_player_id: string;
    canonical_key: string;
    name: string;
    premise: string;
    description: string;
    genre: string;
    creation_mode: string;
    world_contract: Record<string, unknown>;
    contract_status: string;
    world_clock_name: string;
    resolution_mode: string;
    content_settings: Record<string, unknown>;
    metadata_inference_status: "manual" | "requested" | "generated";
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, owner_player_id, canonical_key, name, premise, description, genre,
            creation_mode, world_contract, contract_status, world_clock_name,
            resolution_mode, content_settings, metadata_inference_status,
            created_at, updated_at
       FROM storyhold.worlds
      WHERE id = $1 AND owner_player_id = $2
      LIMIT 1`,
    [worldId, playerId],
  );
  return result.rows[0] ?? null;
}

async function defaultEdition(db: StudioDb, worldId: string) {
  const result = await db.query<{
    id: string;
    canonical_key: string;
    name: string;
    timeline_anchor: string;
    status: string;
    chronology_status: string;
    chronology_summary: string;
    chronology_reviewed_at: string | null;
    created_at: string;
  }>(
    `SELECT id, canonical_key, name, timeline_anchor, status, chronology_status,
            chronology_summary, chronology_reviewed_at, created_at
       FROM storyhold.canon_editions
      WHERE world_id = $1
      ORDER BY created_at ASC
      LIMIT 1`,
    [worldId],
  );
  return result.rows[0] ?? null;
}

async function ownedCampaign(
  db: StudioDb,
  campaignId: string,
  playerId: string,
) {
  const result = await db.query<Record<string, unknown>>(
    `SELECT c.*, w.name AS world_name, w.world_clock_name, ch.name AS character_name
       FROM storyhold.campaigns c
       JOIN storyhold.worlds w ON w.id = c.world_id
       LEFT JOIN storyhold.characters ch ON ch.id = c.perspective_character_id
      WHERE c.id = $1 AND c.owner_player_id = $2
      LIMIT 1`,
    [campaignId, playerId],
  );
  return result.rows[0] ?? null;
}

async function insertChunks(params: {
  db: StudioDb;
  chunks: ReturnType<typeof chunkText>;
  sourceId: string;
  worldId: string;
  editionId: string;
  sourceTitle: string;
}) {
  const batchSize = 75;
  for (let offset = 0; offset < params.chunks.length; offset += batchSize) {
    const batch = params.chunks.slice(offset, offset + batchSize);
    const values: unknown[] = [];
    const tuples = batch.map((chunk) => {
      const start = values.length;
      values.push(
        randomUUID(),
        params.sourceId,
        params.worldId,
        params.editionId,
        chunk.index,
        chunk.content,
        chunk.contentHash,
        chunk.charCount,
        json({ sourceTitle: params.sourceTitle, ...chunk.metadata }),
      );
      return `($${start + 1}, $${start + 2}, $${start + 3}, $${start + 4}, $${start + 5}, $${start + 6}, $${start + 7}, $${start + 8}, $${start + 9}::jsonb)`;
    });
    await params.db.query(
      `INSERT INTO storyhold.world_source_chunks
        (id, source_id, world_id, canon_edition_id, chunk_index, content, content_hash, char_count, metadata)
       VALUES ${tuples.join(",")}`,
      values,
    );
  }
  scheduleStoryholdEmbeddingBackfill(params.db, 100);
}

type SourcePageSpan = {
  pageIndex: number;
  startOffset: number;
  endOffset: number;
  content: string;
};

export function sourcePageSpans(pages: string[]): SourcePageSpan[] {
  const delimiter = "\n\n\f\n\n";
  let cursor = 0;
  return pages.map((content, pageIndex) => {
    const startOffset = cursor;
    const endOffset = startOffset + content.length;
    cursor = endOffset + (pageIndex < pages.length - 1 ? delimiter.length : 0);
    return { pageIndex, startOffset, endOffset, content };
  });
}

async function insertSourcePages(params: {
  db: StudioDb;
  sourceId: string;
  worldId: string;
  editionId: string;
  pages: string[];
}) {
  const spans = sourcePageSpans(params.pages);
  const batchSize = 250;
  for (let offset = 0; offset < spans.length; offset += batchSize) {
    const batch = spans.slice(offset, offset + batchSize);
    const values: unknown[] = [];
    const tuples = batch.map((page) => {
      const start = values.length;
      values.push(
        randomUUID(),
        params.sourceId,
        params.worldId,
        params.editionId,
        page.pageIndex,
        page.startOffset,
        page.endOffset,
        page.content.length,
        createHash("sha256").update(page.content).digest("hex"),
      );
      return `($${start + 1}, $${start + 2}, $${start + 3}, $${start + 4},
               $${start + 5}, $${start + 6}, $${start + 7}, $${start + 8},
               $${start + 9})`;
    });
    await params.db.query(
      `INSERT INTO storyhold.world_source_pages
        (id, source_id, world_id, canon_edition_id, page_index, start_offset,
         end_offset, char_count, content_hash)
       VALUES ${tuples.join(",")}`,
      values,
    );
  }
  return spans;
}

function serializeWorld(row: Record<string, unknown>) {
  return {
    id: row.id,
    canonicalKey: row.canonical_key,
    name: row.name,
    premise: row.premise,
    description: row.description,
    genre: row.genre,
    metadataInferenceStatus: row.metadata_inference_status ?? "manual",
    creationMode: row.creation_mode ?? "import",
    worldContract: row.world_contract ?? {},
    contractStatus: row.contract_status ?? "draft",
    worldClockName: row.world_clock_name ?? "World Clock",
    resolutionMode: row.resolution_mode ?? "story_first",
    contentSettings: row.content_settings ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceCount: Number(row.source_count ?? 0),
    wordCount: Number(row.word_count ?? 0),
    chunkCount: Number(row.chunk_count ?? 0),
    peopleCount: Number(row.people_count ?? 0),
    characterDraftCount: Number(row.character_draft_count ?? 0),
    approvedCharacterCount: Number(row.approved_character_count ?? 0),
    waitingAiReviewCount: Number(row.waiting_ai_review_count ?? 0),
    pendingCohesionCount: Number(row.pending_cohesion_count ?? 0),
    unresolvedDiscrepancyCount: Number(
      row.unresolved_discrepancy_count ?? 0,
    ),
    canonAmendmentCount: Number(row.canon_amendment_count ?? 0),
    campaignCount: Number(row.campaign_count ?? 0),
    visibleClockEventCount: Number(row.visible_clock_event_count ?? 0),
    latestAnalysisStatus: row.latest_analysis_status ?? null,
  };
}

function serializeSource(row: Record<string, unknown>) {
  return {
    id: row.id,
    canonicalKey: row.canonical_key,
    title: row.title,
    originalFilename: row.original_filename,
    mediaType: row.media_type,
    documentType: row.document_type,
    sourceClass: row.source_class,
    canonStatus: row.canon_status,
    sourceKind: row.source_kind ?? "manuscript",
    chronologyOrder: Number(row.chronology_order ?? row.sort_order ?? 0),
    chronologyRelation: row.chronology_relation ?? "unspecified",
    chronologyLabel: row.chronology_label ?? "",
    chronologyNotes: row.chronology_notes ?? "",
    referenceKnowledgeScope:
      row.reference_knowledge_scope ?? "director_only",
    referenceKnownBy: stringList(row.reference_known_by, 50, 180),
    referenceLoreStatus: row.reference_lore_status ?? "supplemental",
    chronologyReviewStatus: row.chronology_review_status ?? "unreviewed",
    fileAsChapter: Boolean(row.file_as_chapter),
    relativePath: row.relative_path ?? "",
    importBatchId: row.import_batch_id ?? null,
    importBatchPosition:
      row.import_batch_position === null || row.import_batch_position === undefined
        ? null
        : Number(row.import_batch_position),
    importBatchSize:
      row.import_batch_size === null || row.import_batch_size === undefined
        ? null
        : Number(row.import_batch_size),
    extractionQualitySeverity: row.extraction_quality_severity ?? "ok",
    extractionDiagnostics: row.extraction_diagnostics ?? {},
    byteSize: Number(row.byte_size ?? 0),
    wordCount: Number(row.word_count ?? 0),
    charCount: Number(row.char_count ?? 0),
    chunkCount: Number(row.chunk_count ?? 0),
    pageCount: row.page_count === null ? null : Number(row.page_count),
    extractionMethod: row.extraction_method,
    processingStatus: row.processing_status,
    processingError: row.processing_error,
    localScanStatus: row.local_scan_status ?? "pending",
    localScannedAt: row.local_scanned_at ?? null,
    aiReviewStatus: row.ai_review_status ?? "waiting",
    aiAnalysisVersion: Number(row.ai_analysis_version ?? 0),
    aiReviewProvider: row.ai_review_provider ?? null,
    aiReviewModel: row.ai_review_model ?? null,
    aiReviewedAt: row.ai_reviewed_at ?? null,
    aiReviewedChunkCount: Number(row.ai_reviewed_chunk_count ?? 0),
    createdAt: row.created_at,
  };
}

const CLOCK_TRUTH_STATUSES = new Set([
  "fact",
  "belief",
  "rumor",
  "lie",
  "disputed",
  "unknown",
]);

export function serializeClockEvent(
  row: Record<string, unknown>,
  relationRows: Record<string, unknown>[] = [],
) {
  const eventId = String(row.id ?? "");
  // The persistence migration gives every older row truth_status='unknown'.
  // That default is not evidence that the event received a truth-aware
  // review. Only an immutable event-verification link enables the new truth
  // projection; migrated rows retain their older knowledge label.
  const hasTruthProjection = row.has_verified_truth === true;
  const storedTruthStatus = String(row.truth_status ?? "unknown");
  const truthStatus = CLOCK_TRUTH_STATUSES.has(storedTruthStatus)
    ? storedTruthStatus
    : "unknown";
  const holderEntityId =
    typeof row.resolved_epistemic_holder_entity_id === "string" &&
    row.resolved_epistemic_holder_entity_id.trim()
      ? row.resolved_epistemic_holder_entity_id
      : null;
  const holderName =
    typeof row.epistemic_holder_name === "string" &&
    row.epistemic_holder_name.trim()
      ? row.epistemic_holder_name.trim()
      : null;
  return {
    id: row.id,
    canonicalKey: row.canonical_key,
    campaignId: row.campaign_id ?? null,
    sourceId: row.source_id ?? null,
    causalParentId: row.causal_parent_id ?? null,
    eventKind: row.event_kind,
    title: row.title,
    summary: row.summary,
    worldTimeLabel: row.world_time_label,
    chronologyOrder: Number(row.chronology_order ?? 0),
    temporalStatus: row.temporal_status ?? "relative",
    importance: row.importance ?? "major",
    sourceChapterKeys: row.source_chapter_keys ?? [],
    causalLinks: relationRows.flatMap((relation) => {
      const outgoing = String(relation.source_event_id ?? "") === eventId;
      const incoming = String(relation.target_event_id ?? "") === eventId;
      if (!outgoing && !incoming) return [];
      return [{
        id: relation.id,
        direction: outgoing ? "outgoing" : "incoming",
        relationType: relation.relation_type,
        otherEventId: outgoing ? relation.target_event_id : relation.source_event_id,
        otherEventTitle: outgoing ? relation.target_title : relation.source_title,
        summary: relation.summary ?? "",
        evidence: relation.evidence ?? [],
        confidence: Number(relation.confidence ?? 0),
      }];
    }),
    visibility: row.visibility,
    ...(hasTruthProjection
      ? {
          truthStatus,
          epistemicHolderEntityId: holderEntityId,
          epistemicHolderName: holderName,
        }
      : {}),
    knowledgeStatus: row.knowledge_status,
    knownEffects: row.known_effects ?? [],
    evidence: row.evidence ?? [],
    scheduledForLabel: row.scheduled_for_label,
    dueWorldTimeMinutes:
      row.due_world_time_minutes === null || row.due_world_time_minutes === undefined
        ? null
        : Number(row.due_world_time_minutes),
    dueTurnNumber:
      row.due_turn_number === null || row.due_turn_number === undefined
        ? null
        : Number(row.due_turn_number),
    maturedAt: row.matured_at ?? null,
    status: row.status,
    createdAt: row.created_at,
  };
}

export async function readWorldClockEventsForEdition(
  db: Pick<StoryholdDb, "query">,
  params: { worldId: string; editionId: string },
) {
  return db.query<Record<string, unknown>>(
    `SELECT event.*,
            EXISTS (
              SELECT 1
                FROM storyhold.world_clock_event_verifications verification
               WHERE verification.event_id = event.id
                 AND verification.world_id = event.world_id
                 AND verification.edition_id = event.canon_edition_id
            ) AS has_verified_truth,
            holder.id AS resolved_epistemic_holder_entity_id,
            holder.name AS epistemic_holder_name
       FROM storyhold.world_clock_events event
       LEFT JOIN storyhold.world_entities holder
         ON holder.id = event.epistemic_holder_entity_id
        AND holder.world_id = event.world_id
        AND holder.canon_edition_id = event.canon_edition_id
      WHERE event.world_id = $1 AND event.canon_edition_id = $2
        AND event.campaign_id IS NULL AND event.visibility = 'world'
        AND event.knowledge_status <> 'secret'
      ORDER BY event.chronology_order ASC, event.created_at ASC
      LIMIT 5000`,
    [params.worldId, params.editionId],
  );
}

export async function readWorldClockRelationsForEdition(
  db: Pick<StoryholdDb, "query">,
  params: { worldId: string; editionId: string },
) {
  return db.query<Record<string, unknown>>(
    `SELECT relation.*, source.title AS source_title,
            target.title AS target_title
       FROM storyhold.world_event_relations relation
       JOIN storyhold.world_clock_events source
         ON source.id = relation.source_event_id
       JOIN storyhold.world_clock_events target
         ON target.id = relation.target_event_id
      WHERE relation.world_id = $1 AND relation.canon_edition_id = $2
        AND source.world_id = $1 AND source.canon_edition_id = $2
        AND target.world_id = $1 AND target.canon_edition_id = $2
        AND source.campaign_id IS NULL AND target.campaign_id IS NULL
        AND source.visibility = 'world' AND target.visibility = 'world'
        AND source.knowledge_status <> 'secret'
        AND target.knowledge_status <> 'secret'
      ORDER BY source.chronology_order, target.chronology_order,
               relation.relation_type`,
    [params.worldId, params.editionId],
  );
}

export async function readCampaignClockEventsForEdition(
  db: Pick<StoryholdDb, "query">,
  params: {
    worldId: string;
    editionId: string;
    campaignId: string;
    characterId: string | null;
  },
) {
  return db.query<Record<string, unknown>>(
    `SELECT event.*,
            EXISTS (
              SELECT 1
                FROM storyhold.world_clock_event_verifications verification
               WHERE verification.event_id = event.id
                 AND verification.world_id = event.world_id
                 AND verification.edition_id = $4
            ) AS has_verified_truth,
            holder.id AS resolved_epistemic_holder_entity_id,
            holder.name AS epistemic_holder_name
       FROM storyhold.world_clock_events event
       LEFT JOIN storyhold.world_entities holder
         ON holder.id = event.epistemic_holder_entity_id
        AND holder.world_id = event.world_id
        AND holder.canon_edition_id = $4
      WHERE event.world_id = $1
        AND event.knowledge_status <> 'secret'
        AND (
          (event.campaign_id IS NULL AND event.canon_edition_id = $4
            AND event.visibility = 'world') OR
          (event.campaign_id = $2
            AND (event.canon_edition_id = $4 OR event.canon_edition_id IS NULL)
            AND (
              event.visibility = 'campaign' OR
              (event.visibility = 'character' AND event.visible_to_character_id = $3)
            ))
        )
      ORDER BY event.chronology_order ASC, event.created_at ASC
      LIMIT 500`,
    [params.worldId, params.campaignId, params.characterId, params.editionId],
  );
}

function reminderDeadline(
  dueLabel: string,
  currentWorldMinutes: number,
  lastTurnNumber: number,
) {
  if (!dueLabel) {
    return {
      dueWorldTimeMinutes: null as number | null,
      dueTurnNumber: null as number | null,
    };
  }
  const normalized = dueLabel.toLocaleLowerCase();
  const relative = normalized.match(
    /\b(?:in\s+)?(\d{1,4})\s*(minute|minutes|hour|hours|day|days|week|weeks|turn|turns)\b/,
  );
  if (relative) {
    const amount = Math.max(1, Number(relative[1]));
    const unit = relative[2] ?? "turns";
    if (unit.startsWith("turn")) {
      return {
        dueWorldTimeMinutes: null,
        dueTurnNumber: lastTurnNumber + amount,
      };
    }
    const multiplier = unit.startsWith("week")
      ? 10_080
      : unit.startsWith("day")
        ? 1_440
        : unit.startsWith("hour")
          ? 60
          : 1;
    return {
      dueWorldTimeMinutes:
        currentWorldMinutes + Math.min(5_256_000, amount * multiplier),
      dueTurnNumber: null,
    };
  }
  if (/\btomorrow\b/.test(normalized)) {
    return {
      dueWorldTimeMinutes: currentWorldMinutes + 1_440,
      dueTurnNumber: null,
    };
  }
  if (/\bnext week\b/.test(normalized)) {
    return {
      dueWorldTimeMinutes: currentWorldMinutes + 10_080,
      dueTurnNumber: null,
    };
  }
  // A human-readable reminder must never remain scheduled forever merely
  // because the label was poetic instead of machine-readable.
  return {
    dueWorldTimeMinutes: null,
    dueTurnNumber: lastTurnNumber + 1,
  };
}

function serializeChapterSummary(row: Record<string, unknown>) {
  return {
    id: row.id,
    canonicalKey: row.canonical_key,
    sourceId: row.source_id,
    chapterTitle: row.chapter_title,
    perspective: row.perspective ?? "",
    sourceOrder: Number(row.source_order ?? 0),
    summary: row.summary ?? "",
    majorEvents: row.major_events ?? [],
    evidence: row.evidence ?? [],
    summarySource: row.summary_source ?? "local",
    confidence: Number(row.confidence ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeCampaign(row: Record<string, unknown>) {
  return {
    id: row.id,
    canonicalKey: row.canonical_key,
    name: row.name,
    characterId: row.perspective_character_id ?? null,
    characterName: row.character_name ?? null,
    startContract: row.start_contract ?? {},
    startLockedAt: row.start_locked_at,
    currentTimeLabel: row.current_time_label ?? "The beginning",
    worldTimeMinutes: Number(row.world_time_minutes ?? 0),
    resolutionMode: row.resolution_mode ?? "story_first",
    status: row.status ?? "active",
    eventCount: Number(row.event_count ?? 0),
    createdAt: row.created_at,
  };
}

type CampaignEntitySnapshot = Record<string, unknown> & {
  entity_id: string;
  canonical_key: string;
  entity_type: string;
  name: string;
};

export async function createCampaignScopedCharacter(
  db: StudioDb,
  params: {
    characterId: string;
    campaignId: string;
    worldId: string;
    playerId: string;
    name: string;
    concept?: string;
  },
) {
  await db.query(
    `INSERT INTO storyhold.characters
      (id, world_id, created_by_player_id, canonical_key, name,
       initial_profile, scope_kind, scope_campaign_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'campaign', $7)`,
    [
      params.characterId,
      params.worldId,
      params.playerId,
      `campaign-character-${params.characterId.slice(0, 12)}`,
      params.name,
      json({
        concept: params.concept ?? "",
        source: "campaign_start_contract",
        scope: "campaign",
        campaignId: params.campaignId,
      }),
      params.campaignId,
    ],
  );
}

export async function findWorldCanonicalCharacter(
  db: StudioDb,
  params: { characterId: string; worldId: string },
) {
  const result = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM storyhold.characters
      WHERE id = $1 AND world_id = $2 AND scope_kind = 'world'
      LIMIT 1`,
    [params.characterId, params.worldId],
  );
  return result.rows[0] ?? null;
}

export function campaignScopedPlayerEntitySnapshot(params: {
  characterId: string;
  name: string;
}): CampaignEntitySnapshot {
  return {
    entity_id: params.characterId,
    dossier_id: null,
    canonical_character_id: params.characterId,
    canonical_key: `campaign-player-${params.characterId.slice(0, 12)}`,
    entity_type: "character",
    name: params.name,
    aliases: [],
    role: "",
    summary: "",
    profile: {},
    details: [],
    relationships: [],
    socio_political_axis: {},
    faction_memberships: [],
    entity_links: [],
    entity_rules: [],
    mention_count: 0,
    confidence: 1,
  };
}

export function withCampaignScopedPlayerSnapshot(
  snapshot: {
    rows: CampaignEntitySnapshot[];
    metadata: Record<string, unknown>;
  },
  player: CampaignEntitySnapshot | null,
) {
  if (!player) return snapshot;
  const rows = [...snapshot.rows.filter((row) => row.entity_id !== player.entity_id), player]
    .sort((left, right) =>
      `${left.entity_type}\n${left.name}\n${left.entity_id}`.localeCompare(
        `${right.entity_type}\n${right.name}\n${right.entity_id}`,
      )
    );
  return {
    rows,
    metadata: {
      ...snapshot.metadata,
      count: rows.length,
      sha256: stableCanonSha256(rows),
    },
  };
}

export function buildAnchoredCampaignStartPresentation(input: {
  worldName: string;
  genre: string;
  requestedStartingPoint: string;
  anchorMode: "before" | "after";
  anchorTitle: string;
  timelineRows: readonly Record<string, unknown>[];
  playerEntityId: string;
  entitySnapshotRows: readonly CampaignEntitySnapshot[];
  claims: readonly CampaignCanonClaimSnapshot[];
}) {
  const worldName = textBody(input.worldName, 240) || "This World";
  const playerEntity = input.entitySnapshotRows.find((entity) =>
    entity.entity_id === input.playerEntityId
  );
  const characterName = textBody(playerEntity?.name, 240) || "The Player Character";
  const entityNames = new Map(
    input.entitySnapshotRows.map((entity) => [entity.entity_id, entity.name] as const),
  );
  const characterFacts = input.claims.flatMap((claim): string[] => {
    if (
      claim.subject_entity_id !== input.playerEntityId ||
      claim.truth_status !== "fact" ||
      claim.claim_status !== "active"
    ) return [];
    const predicate = textBody(claim.predicate, 160);
    const object = claim.object_entity_id
      ? textBody(entityNames.get(claim.object_entity_id), 240)
      : textBody(claim.object_text, 500);
    if (!predicate || !object) return [];
    return [`${characterName} ${claim.polarity === "negative" ? "does not " : ""}${predicate} ${object}.`];
  }).filter((fact, index, all) => all.indexOf(fact) === index).slice(0, 8);
  const priorEvent = [...input.timelineRows]
    .sort((left, right) => Number(left.chronology_order ?? 0) - Number(right.chronology_order ?? 0))
    .at(-1);
  const requestedStartingPoint = textBody(input.requestedStartingPoint, 3_000);
  const startingPoint = requestedStartingPoint || (
    input.anchorMode === "after" && textBody(input.anchorTitle, 240)
      ? `The story resumes just after ${textBody(input.anchorTitle, 240)}.`
      : priorEvent && textBody(priorEvent.title, 240)
        ? `The story resumes after ${textBody(priorEvent.title, 240)}, before the next recorded event.`
        : "The story begins before the first recorded event."
  );
  const premise = `The story continues within ${worldName} from the chosen moment in its established history.`;
  return {
    worldPremise: premise,
    worldContract: {
      identity: worldName,
      premise,
      tone: textBody(input.genre, 1_000),
      startingPoint,
      constraints: [
        "Only events and facts already established by this starting point may be assumed.",
      ],
      exclusions: [],
      worldRules: [],
      playerPriorities: [
        "Let new choices create consequences without silently importing later canon.",
      ],
    },
    characterName,
    characterConcept: characterFacts.length
      ? characterFacts.join(" ")
      : `${characterName} enters with only the identity and history established by this point.`,
    startingPoint,
  };
}

export type WorldStudioCampaignRpgSeedInput = {
  campaignId: string;
  worldId: string;
  editionId: string;
  worldName: string;
  worldPremise: string;
  startingPoint: string;
  initialObjective: string;
  resolutionMode: CampaignResolutionMode;
  characterId: string;
  characterEntityId: string;
  characterName: string;
  hasManuscriptCanonSources: boolean;
  entitySnapshotRows: readonly CampaignEntitySnapshot[];
  /** Null means edition-locked; an array, including an empty one, is strict. */
  anchoredCanonClaims: readonly CampaignCanonClaimSnapshot[] | null;
  /** Mechanics independently projected against the same strict evidence. */
  strictCharacterMechanics?: {
    projectedStats: Partial<Record<StoryholdStatName, number>>;
    rules: readonly CampaignSeedEntityRule[];
  } | null;
  canonAnchor?: {
    eventId: string;
    mode: "before" | "after";
  } | null;
};

function campaignStartingLocation(
  rows: readonly CampaignEntitySnapshot[],
  startingPoint: string,
) {
  const searchable = (value: unknown, maximum: number) =>
    textBody(value, maximum)
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
  const normalizedStart = searchable(startingPoint, 3_000);
  const place = rows
    .filter((entity) => entity.entity_type === "place")
    .filter((entity) => {
      const name = searchable(entity.name, 240);
      return name.length >= 2 && ` ${normalizedStart} `.includes(` ${name} `);
    })
    .sort((left, right) => right.name.length - left.name.length)[0];
  if (place) {
    return { entityId: place.entity_id, name: place.name, zone: null };
  }
  return {
    entityId: null,
    name: "Opening Scene",
    zone: textBody(startingPoint, 240) || null,
  };
}

function campaignSeedRules(value: unknown): CampaignSeedEntityRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): CampaignSeedEntityRule[] => {
    const rule = recordBody(entry);
    const name = textBody(rule.name, 160);
    if (!name) return [];
    return [{
      id: textBody(rule.id, 160) || undefined,
      canonicalKey: textBody(rule.canonicalKey ?? rule.canonical_key, 160) || undefined,
      name,
      description: textBody(rule.description, 1_000),
      ruleKind: textBody(rule.ruleKind ?? rule.rule_kind, 40) || "trait",
      confidence: Number.isFinite(Number(rule.confidence))
        ? Number(rule.confidence)
        : undefined,
      status: textBody(rule.status ?? rule.rule_status, 40) || "active",
      evidence: Array.isArray(rule.evidence) ? rule.evidence : [],
      assignmentSource: textBody(
        rule.assignmentSource ?? rule.assignment_source,
        40,
      ),
      reviewStatus: textBody(rule.reviewStatus ?? rule.review_status, 60),
      premiumVerified:
        rule.premiumVerified === true || rule.premium_verified === true,
      temporalEvidenceVerified: rule.temporalEvidenceVerified === true,
    }];
  });
}

/**
 * Translate only launch-frozen data into the immutable RPG boundary. Anchored
 * games deliberately receive identity labels and retained claims, never live
 * dossier prose, estimates, or rules that may describe post-anchor canon.
 */
export function buildWorldStudioCampaignRpgSeed(
  input: WorldStudioCampaignRpgSeedInput,
): CampaignSeed {
  const strict = input.anchoredCanonClaims !== null;
  const entityNames = new Map(
    input.entitySnapshotRows.map((entity) => [entity.entity_id, entity.name] as const),
  );
  const facts: CampaignSeedClaim[] = strict
    ? input.anchoredCanonClaims!.flatMap((claim): CampaignSeedClaim[] => {
        if (claim.truth_status !== "fact" || claim.claim_status !== "active") return [];
        const subject = entityNames.get(claim.subject_entity_id);
        if (!subject) return [];
        const object = claim.object_entity_id
          ? entityNames.get(claim.object_entity_id)
          : textBody(claim.object_text, 1_000);
        if (!object) return [];
        return [{
          id: claim.claim_id,
          subject,
          predicate: claim.polarity === "negative"
            ? `does not ${claim.predicate}`
            : claim.predicate,
          object,
          provenance: claim.assignment_source === "user" ? "owner" : "manuscript",
        }];
      })
    : [];
  const actor = strict
    ? undefined
    : input.entitySnapshotRows.find(
        (entity) => entity.entity_id === input.characterEntityId,
      );
  const profile = recordBody(actor?.profile);
  const strictRules = strict ? [...(input.strictCharacterMechanics?.rules ?? [])] : [];
  if (strict) {
    const abilityLanguage = /\b(?:ability|able\s+to|bonded|can|capable\s+of|hosts?|power|symbio|transform|wields?)\b/iu;
    for (const claim of input.anchoredCanonClaims ?? []) {
      if (
        claim.subject_entity_id !== input.characterEntityId ||
        claim.truth_status !== "fact" || claim.claim_status !== "active" ||
        claim.polarity !== "positive"
      ) continue;
      const object = claim.object_entity_id
        ? entityNames.get(claim.object_entity_id)
        : textBody(claim.object_text, 500);
      const description = `${input.characterName} ${claim.predicate} ${object ?? ""}`.trim();
      if (!object || !abilityLanguage.test(description)) continue;
      strictRules.push({
        id: `strict-claim-${claim.claim_id}`,
        name: toChicagoTitleCase(`${claim.predicate} ${object}`.slice(0, 160)),
        description: `${description}.`,
        ruleKind: /\b(?:bonded|hosts?|symbio)\b/iu.test(description)
          ? "biological"
          : "ability",
        confidence: claim.confidence,
        status: "active",
        evidence: claim.evidence,
        assignmentSource: "local",
        temporalEvidenceVerified: true,
      });
    }
  }
  return buildCampaignSeed({
    campaignId: input.campaignId,
    worldId: input.worldId,
    editionId: input.editionId,
    worldName: input.worldName,
    // Original-world premise is world canon; it must never be replaced by the
    // player's separate character concept.
    worldPremise: input.worldPremise,
    origin: input.hasManuscriptCanonSources ? "imported" : "original",
    canonAnchor: strict && input.canonAnchor
      ? `${input.canonAnchor.mode}:${input.canonAnchor.eventId}`
      : null,
    generatorVersion: input.hasManuscriptCanonSources
      ? null
      : "storyhold:original-adventure:v1",
    resolutionMode: input.resolutionMode,
    character: {
      id: input.characterId,
      name: input.characterName,
      estimatedStats: strict ? undefined : profile.estimatedStats,
      projectedStats: strict
        ? input.strictCharacterMechanics?.projectedStats
        : undefined,
      rules: strict ? strictRules : campaignSeedRules(actor?.entity_rules),
    },
    location: campaignStartingLocation(input.entitySnapshotRows, input.startingPoint),
    initialObjective: input.initialObjective,
    facts,
  });
}

/** Small immutable pointer kept in startContract for replay/branch inspection. */
export function campaignRpgSeedLineage(seed: CampaignSeed) {
  return Object.freeze({
    schemaVersion: seed.schemaVersion,
    seedId: seed.seedId,
    seedSha256: campaignRpgSha256(seed),
    origin: seed.origin.kind,
    initialStateVersion: 0,
    baselineCampaignStateVersion: 1,
  });
}

async function prepareCampaignEntitySnapshot(
  db: StudioDb,
  worldId: string,
  editionId: string,
) {
  const result = await db.query<CampaignEntitySnapshot>(
    `SELECT entity.id AS entity_id, entity.dossier_id,
            dossier.canonical_character_id, entity.canonical_key,
            entity.entity_type, entity.name, entity.aliases,
            COALESCE(dossier.role, '') AS role,
            COALESCE(NULLIF(dossier.summary, ''), entity.summary, '') AS summary,
            COALESCE(dossier.profile, '{}'::jsonb) AS profile,
            entity.details, entity.relationships,
            COALESCE(dossier.axis_user_override, dossier.axis_estimate, '{}'::jsonb)
              AS socio_political_axis,
            COALESCE((
              SELECT jsonb_agg(
                jsonb_build_object(
                  'id', faction.id,
                  'canonicalKey', faction.canonical_key,
                  'name', faction.name,
                  'aliases', faction.aliases,
                  'assignmentSource', membership.assignment_source,
                  'confidence', membership.confidence
                ) ORDER BY faction.name
              )
                FROM storyhold.world_entity_faction_memberships membership
                JOIN storyhold.world_entities faction
                  ON faction.id = membership.faction_entity_id
               WHERE membership.entity_id = entity.id
                 AND faction.pull_status = 'active'
            ), '[]'::jsonb) AS faction_memberships,
            COALESCE((
              SELECT jsonb_agg(
                jsonb_build_object(
                  'id', relation.id,
                  'direction', CASE WHEN relation.source_entity_id = entity.id THEN 'outgoing' ELSE 'incoming' END,
                  'relationType', relation.relation_type,
                  'status', relation.relation_status,
                  'otherEntityId', CASE WHEN relation.source_entity_id = entity.id THEN target.id ELSE source.id END,
                  'otherCanonicalKey', CASE WHEN relation.source_entity_id = entity.id THEN target.canonical_key ELSE source.canonical_key END,
                  'otherName', CASE WHEN relation.source_entity_id = entity.id THEN target.name ELSE source.name END,
                  'otherType', CASE WHEN relation.source_entity_id = entity.id THEN target.entity_type ELSE source.entity_type END,
                  'summary', relation.summary,
                  'validFromLabel', relation.valid_from_label,
                  'validUntilLabel', relation.valid_until_label
                ) ORDER BY relation.relation_type,
                           CASE WHEN relation.source_entity_id = entity.id THEN target.name ELSE source.name END
              )
                FROM storyhold.world_entity_relations relation
                JOIN storyhold.world_entities source ON source.id = relation.source_entity_id
                JOIN storyhold.world_entities target ON target.id = relation.target_entity_id
               WHERE relation.source_entity_id = entity.id OR relation.target_entity_id = entity.id
            ), '[]'::jsonb) AS entity_links,
            COALESCE((
              SELECT jsonb_agg(
                jsonb_build_object(
                  'id', rule.id,
                  'canonicalKey', rule.canonical_key,
                  'name', rule.name,
                  'description', rule.description,
                  'ruleKind', rule.rule_kind,
                  'trigger', rule.trigger_text,
                  'effect', rule.effect_text,
                  'evidence', rule.evidence,
                  'assignmentSource', rule.assignment_source,
                  'confidence', rule.confidence,
                  'status', rule.rule_status,
                  'premiumVerified', EXISTS (
                    SELECT 1
                      FROM storyhold.world_entity_rule_verifications verification
                     WHERE verification.rule_id = rule.id
                  )
                ) ORDER BY rule.name
              )
                FROM storyhold.world_entity_rules rule
               WHERE rule.entity_id = entity.id AND rule.rule_status = 'active'
            ), '[]'::jsonb) AS entity_rules,
            entity.mention_count, entity.confidence
       FROM storyhold.world_entities entity
       LEFT JOIN storyhold.character_dossiers dossier
         ON dossier.id = entity.dossier_id AND dossier.dossier_status = 'active'
      WHERE entity.world_id = $1 AND entity.canon_edition_id = $2
        AND entity.pull_status = 'active'
      ORDER BY entity.entity_type ASC, entity.name ASC, entity.id ASC`,
    [worldId, editionId],
  );
  return {
    rows: result.rows,
    metadata: {
      version: 2,
      count: result.rows.length,
      sha256: stableCanonSha256(result.rows),
    },
  };
}

async function persistCampaignEntitySnapshot(
  db: StudioDb,
  campaignId: string,
  rows: CampaignEntitySnapshot[],
) {
  for (const row of rows) {
    await db.query(
      `INSERT INTO storyhold.campaign_entity_snapshots
        (campaign_id, entity_id, dossier_id, canonical_character_id,
         canonical_key, entity_type, name, aliases, role, summary, profile,
         details, relationships, socio_political_axis, faction_memberships,
         entity_links, entity_rules, mention_count, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10,
               $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb,
               $16::jsonb, $17::jsonb, $18, $19)`,
      [
        campaignId,
        row.entity_id,
        row.dossier_id ?? null,
        row.canonical_character_id ?? null,
        row.canonical_key,
        row.entity_type,
        row.name,
        json(row.aliases ?? []),
        row.role ?? "",
        row.summary ?? "",
        json(row.profile ?? {}),
        json(row.details ?? []),
        json(row.relationships ?? []),
        json(row.socio_political_axis ?? {}),
        json(row.faction_memberships ?? []),
        json(row.entity_links ?? []),
        json(row.entity_rules ?? []),
        Number(row.mention_count ?? 0),
        Number(row.confidence ?? 0),
      ],
    );
  }
}

const CAMPAIGN_SNAPSHOT_ENTITY_TYPES = [
  "character", "creature", "species", "place", "faction", "institution",
  "government", "power_structure", "technology", "vehicle", "device",
  "weapon", "power", "title", "term", "cultural_reference", "ambiguous",
] as const;

async function prepareAnchoredCampaignCanonScope(
  db: StudioDb,
  params: {
    worldId: string;
    editionId: string;
    maximumChronologyOrder: number;
    timelineRows: Record<string, unknown>[];
    lockedSources: LockedSourceIdentity[];
    selectedPlayerEntityId: string;
  },
): Promise<{
  evidence: CampaignCanonEvidenceSnapshot[];
  claims: CampaignCanonClaimSnapshot[];
  actorMechanics: {
    projectedStats: Partial<Record<StoryholdStatName, number>>;
    rules: CampaignSeedEntityRule[];
  };
  entitySnapshot: {
    rows: Array<CampaignEntitySnapshot & IdentitySafeCampaignEntity>;
    metadata: Record<string, unknown>;
  };
  sourceSnapshot: LockedSourceIdentity[];
}> {
  const evidenceReferences = referencedCanonEvidenceChunks({
    timelineRows: params.timelineRows,
    maximumChronologyOrder: params.maximumChronologyOrder,
  });
  const chunkIds = evidenceReferences.map((reference) => reference.chunkId);
  const chunkResult = chunkIds.length > 0
    ? await db.query<{
        id: string;
        source_id: string;
        world_id: string;
        canon_edition_id: string;
        content: string;
        content_hash: string;
        source_content_hash: string;
        source_title: string;
        source_kind: string;
        chronology_label: string;
      }>(
        `SELECT chunk.id, chunk.source_id, chunk.world_id,
                chunk.canon_edition_id, chunk.content, chunk.content_hash,
                source.content_hash AS source_content_hash,
                source.title AS source_title, source.source_kind,
                source.chronology_label
           FROM storyhold.world_source_chunks chunk
           JOIN storyhold.world_sources source ON source.id = chunk.source_id
          WHERE chunk.world_id = $1 AND chunk.canon_edition_id = $2
            AND source.world_id = $1 AND source.canon_edition_id = $2
            AND chunk.id = ANY($3::uuid[])`,
        [params.worldId, params.editionId, chunkIds],
      )
    : { rows: [] };
  const evidenceProjection = projectAnchoredCanonEvidence({
    worldId: params.worldId,
    editionId: params.editionId,
    maximumChronologyOrder: params.maximumChronologyOrder,
    timelineRows: params.timelineRows,
    chunks: chunkResult.rows,
    lockedSources: params.lockedSources,
  });
  const retainedChunkIds = [
    ...new Set(evidenceProjection.rows.map((row) => row.chunk_id)),
  ];
  const claimResult = retainedChunkIds.length > 0
    ? await db.query<Record<string, unknown>>(
        `SELECT claim.*
           FROM storyhold.world_knowledge_claims claim
          WHERE claim.world_id = $1 AND claim.canon_edition_id = $2
            AND claim.claim_status <> 'rejected'
            AND EXISTS (
              SELECT 1
                FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(claim.evidence) = 'array'
                       THEN claim.evidence ELSE '[]'::jsonb END
                ) evidence
               WHERE coalesce(evidence->>'chunkId', evidence->>'chunk_id')
                     = ANY($3::text[])
            )
          ORDER BY claim.id ASC`,
        [params.worldId, params.editionId, retainedChunkIds],
      )
    : { rows: [] };
  // Load possible identities only to prove which literal surfaces were
  // present. A candidate does not enter the immutable snapshot unless the
  // cutoff-local reconstruction below actually retains it.
  const candidateEntityIds = new Set<string>([params.selectedPlayerEntityId]);
  for (const event of params.timelineRows) {
    const participants = Array.isArray(event.participant_entity_ids)
      ? event.participant_entity_ids
      : [];
    for (const value of participants) {
      if (typeof value === "string" && UUID_PATTERN.test(value)) {
        candidateEntityIds.add(value);
      }
    }
  }
  for (const rawClaim of claimResult.rows) {
    for (const key of [
      "subject_entity_id", "object_entity_id", "epistemic_holder_entity_id",
    ] as const) {
      const value = rawClaim[key];
      if (typeof value === "string" && UUID_PATTERN.test(value)) {
        candidateEntityIds.add(value);
      }
    }
  }
  const candidateIds = [...candidateEntityIds].sort();
  const entityResult = candidateIds.length > 0
    ? await db.query<Record<string, unknown>>(
        `SELECT entity.id AS entity_id, entity.dossier_id,
                dossier.canonical_character_id, entity.canonical_key,
                entity.entity_type, entity.name, entity.confidence,
                entity.estimated_stats, entity.classification_source,
                entity.review_status, dossier.profile AS dossier_profile
           FROM storyhold.world_entities entity
           LEFT JOIN storyhold.character_dossiers dossier
             ON dossier.id = entity.dossier_id
            AND dossier.dossier_status = 'active'
          WHERE entity.world_id = $1 AND entity.canon_edition_id = $2
            AND entity.id = ANY($3::uuid[])
            AND entity.entity_type = ANY($4::text[])
          ORDER BY entity.entity_type, entity.normalized_name, entity.id`,
        [
          params.worldId,
          params.editionId,
          candidateIds,
          [...CAMPAIGN_SNAPSHOT_ENTITY_TYPES],
        ],
      )
    : { rows: [] };
  const mentionResult = candidateIds.length > 0 && retainedChunkIds.length > 0
    ? await db.query<Record<string, unknown>>(
        `SELECT mention.entity_id, mention.chunk_id, mention.surface_form,
                mention.confidence
           FROM storyhold.world_entity_mentions mention
          WHERE mention.world_id = $1 AND mention.canon_edition_id = $2
            AND mention.entity_id = ANY($3::uuid[])
            AND mention.chunk_id = ANY($4::uuid[])
            AND mention.resolution_status = 'resolved'
            AND mention.mention_kind = 'literal'
          ORDER BY mention.entity_id, mention.chunk_id, mention.start_offset`,
        [params.worldId, params.editionId, candidateIds, retainedChunkIds],
      )
    : { rows: [] };
  const observedSurfacesByEntityId = observedEntitySurfacesFromEvidence({
    evidence: evidenceProjection.rows,
    mentions: mentionResult.rows,
  });
  const claimProjection = projectAnchoredCanonClaims({
    worldId: params.worldId,
    editionId: params.editionId,
    claims: claimResult.rows,
    evidence: evidenceProjection.rows,
    entitySurfacesById: observedSurfacesByEntityId,
  });
  const allowedEntityIds = allowedCanonEntityIds({
    timelineRows: params.timelineRows,
    claims: claimProjection.rows,
    selectedPlayerEntityId: params.selectedPlayerEntityId,
  });
  const observedNamesByEntityId = observedEntityNamesFromEvidence({
    evidence: evidenceProjection.rows,
    mentions: mentionResult.rows,
  });
  const entityProjection = identitySafeEntityProjection({
    entities: entityResult.rows,
    allowedEntityIds,
    selectedPlayerEntityId: params.selectedPlayerEntityId,
    observedNamesByEntityId,
    preserveUnobservedIdentity: false,
  });
  const retainedEntityIds = new Set(
    entityProjection.rows.map((entity) => entity.entity_id),
  );
  const claims = claimsWithCompleteEntityReferences(
    claimProjection.rows,
    retainedEntityIds,
  );
  const actor = entityResult.rows.find((entity) =>
    entity.entity_id === params.selectedPlayerEntityId
  );
  const dossierProfile = recordBody(actor?.dossier_profile);
  const estimatedStats = dossierProfile.estimatedStats ?? actor?.estimated_stats ?? {};
  const premiumVerifiedStatNames = actor && Object.keys(recordBody(estimatedStats)).length
    ? await currentEntityPremiumStatNames(db, {
        worldId: params.worldId,
        editionId: params.editionId,
        entityId: params.selectedPlayerEntityId,
        entityType: textBody(actor.entity_type, 80) || "character",
        name: textBody(actor.name, 240),
        stats: estimatedStats,
      })
    : [];
  const ruleResult = await db.query<Record<string, unknown>>(
    `SELECT rule.*,
            EXISTS (
              SELECT 1
                FROM storyhold.world_entity_rule_verifications verification
               WHERE verification.rule_id = rule.id
            ) AS premium_verified
       FROM storyhold.world_entity_rules rule
      WHERE rule.world_id = $1 AND rule.canon_edition_id = $2
        AND rule.entity_id = $3 AND rule.rule_status = 'active'
      ORDER BY rule.id`,
    [params.worldId, params.editionId, params.selectedPlayerEntityId],
  );
  const actorMechanics = {
    projectedStats: campaignStatsFromTemporalEvidence({
      estimatedStats,
      retainedEvidence: evidenceProjection.rows,
      premiumVerifiedStatNames,
    }),
    rules: campaignRulesFromTemporalEvidence({
      rules: campaignSeedRules(ruleResult.rows),
      retainedEvidence: evidenceProjection.rows,
    }),
  };
  const contributingSourceIds = new Set(
    evidenceProjection.rows.map((row) => row.source_id),
  );
  return {
    evidence: evidenceProjection.rows,
    claims,
    actorMechanics,
    entitySnapshot: {
      rows: entityProjection.rows as Array<
        CampaignEntitySnapshot & IdentitySafeCampaignEntity
      >,
      metadata: {
        version: 3,
        identitySafe: true,
        count: entityProjection.rows.length,
        sha256: entityProjection.sha256,
      },
    },
    sourceSnapshot: params.lockedSources.filter((source) =>
      contributingSourceIds.has(source.id)
    ),
  };
}

export async function prepareEditionLockedCampaignCanonScope(
  db: StudioDb,
  params: {
    worldId: string;
    editionId: string;
    lockedSources: LockedSourceIdentity[];
    selectedPlayerEntityId: string;
  },
) {
  const sourceIds = params.lockedSources.map((source) => source.id);
  const chunkResult = sourceIds.length > 0
    ? await db.query<{
        id: string;
        source_id: string;
        world_id: string;
        canon_edition_id: string;
        content: string;
        content_hash: string;
        source_content_hash: string;
        source_title: string;
        source_kind: string;
        chronology_label: string;
      }>(
        `SELECT chunk.id, chunk.source_id, chunk.world_id,
                chunk.canon_edition_id, chunk.content, chunk.content_hash,
                source.content_hash AS source_content_hash,
                source.title AS source_title, source.source_kind,
                source.chronology_label
           FROM storyhold.world_source_chunks chunk
           JOIN storyhold.world_sources source ON source.id = chunk.source_id
          WHERE chunk.world_id = $1 AND chunk.canon_edition_id = $2
            AND source.world_id = $1 AND source.canon_edition_id = $2
            AND source.id = ANY($3::uuid[])
          ORDER BY source.chronology_order, source.sort_order,
                   chunk.chunk_index, chunk.id`,
        [params.worldId, params.editionId, sourceIds],
      )
    : { rows: [] };
  const evidenceProjection = projectEditionLockedCanonEvidence({
    worldId: params.worldId,
    editionId: params.editionId,
    chunks: chunkResult.rows,
    lockedSources: params.lockedSources,
  });
  const claimResult = await db.query<Record<string, unknown>>(
    `SELECT claim.*
       FROM storyhold.world_knowledge_claims claim
      WHERE claim.world_id = $1 AND claim.canon_edition_id = $2
        AND claim.claim_status <> 'rejected'
      ORDER BY claim.id ASC`,
    [params.worldId, params.editionId],
  );
  const entitySnapshot = await prepareCampaignEntitySnapshot(
    db,
    params.worldId,
    params.editionId,
  );
  const retainedEntityIds = new Set(
    entitySnapshot.rows.map((entity) => entity.entity_id),
  );
  const claimProjection = projectEditionLockedCanonClaims({
    worldId: params.worldId,
    editionId: params.editionId,
    claims: claimResult.rows,
    evidence: evidenceProjection.rows,
  });
  const claims = claimsWithCompleteEntityReferences(
    claimProjection.rows,
    retainedEntityIds,
  );
  const actor = entitySnapshot.rows.find((entity) =>
    entity.entity_id === params.selectedPlayerEntityId
  );
  const profile = recordBody(actor?.profile);
  return {
    evidence: evidenceProjection.rows,
    claims,
    actorMechanics: {
      projectedStats: campaignStatsFromDossier(profile.estimatedStats),
      rules: campaignSeedRules(actor?.entity_rules),
    },
    entitySnapshot,
    sourceSnapshot: params.lockedSources,
  };
}

function serializePreferences(row: Record<string, unknown> | undefined) {
  return {
    adultEnabled: Boolean(row?.adult_enabled),
    ageAttestedAt: row?.age_attested_at ?? null,
    ageAttestationVersion: row?.age_attestation_version ?? null,
    sexualContentLevel: row?.sexual_content_level ?? "off",
    violenceLevel: row?.violence_level ?? "standard",
    narrativeLength: row?.narrative_length ?? "balanced",
    anonymousLearningEnabled: Boolean(row?.anonymous_learning_enabled),
    localModelTrainingEnabled: Boolean(row?.local_model_training_enabled),
    updatedAt: row?.updated_at ?? null,
  };
}

/**
 * Provider routing is an operator diagnostic, not part of the customer
 * product. Customers still receive the facts needed to make an informed
 * privacy and billing decision, while concrete provider/model/endpoint names
 * remain available to owner and admin testing accounts.
 */
export function customerAiRuntimeStatus(
  runtime: ReturnType<typeof getAiRuntimeStatus>,
  role: string,
) {
  if (role === "owner" || role === "admin") return runtime;
  const emptyRouting = {
    director: null,
    narration: null,
    adultNarration: null,
    analysis: null,
    canonReview: null,
  };
  const emptyStageRouting = {
    extraction: null,
    verification: null,
    dossier: null,
    chronology: null,
    director: null,
    narration: null,
    adaptation: null,
  };
  return {
    ...runtime,
    provider: "storyhold-development" as const,
    model: "",
    explanation: runtime.configured
      ? "Storyhold Intelligence is ready for this operation."
      : "Premium Story Intelligence is not connected for this operation.",
    execution: null,
    localExtraction: {
      ...runtime.localExtraction,
      provider: "storyhold-local" as const,
      model: "",
      endpoint: null,
      endpointKind: null,
      explanation: runtime.localExtraction.enabled
        ? "Storyhold's private local reader is ready."
        : "Storyhold's private local reader is not currently available.",
    },
    providers: [],
    routing: emptyRouting,
    stageRouting: emptyStageRouting,
  };
}

const CUSTOMER_UNSAFE_RUN_LANGUAGE = new RegExp(
  `${CUSTOMER_UNSAFE_INTAKE_ACTIVITY_LANGUAGE.source}|\\b(?:accounting|reconciliation|usage record|receipt|extractor|reservation id|journal)\\b`,
  "iu",
);

function customerRunStage(row: Record<string, unknown>): string {
  const premium = row.analysis_kind === "ai_enrichment";
  const status = String(row.status ?? "");
  const topUpCreditsNeeded = Math.max(0, Number(row.customer_top_up_credits_needed ?? 0));
  if (status === "paused" && topUpCreditsNeeded > 0) {
    return "Premium Deep Reading Saved — Add Credits to Finish";
  }
  const stored = textBody(row.stage, 500);
  const curatedStoredStage = /^(?:Researching|Discovering|Looking Deeper Into|Better Understanding|Attempting to Identify|Classifying|Structuring|Reviewing Canon Evidence|Mapping Story Relationships|Developing Character Dossiers|Assessing Story Abilities|Arranging Canonical Events|Reading Canon Sources|Preparing Uploaded Sources|Your Storyhold Is Ready)\b/iu.test(stored);
  if (stored && curatedStoredStage && !CUSTOMER_UNSAFE_RUN_LANGUAGE.test(stored)) return stored;
  if (status === "queued") return premium ? "Preparing Premium Deep Reading" : "Preparing Canon Intake";
  if (status === "running") return premium ? "Reviewing Canon Evidence" : "Reading Your Sources";
  if (status === "paused") return premium ? "Premium Deep Reading Saved" : "Canon Intake Saved";
  if (status === "completed") return premium ? "Premium Deep Reading Complete" : "Canon Intake Complete";
  return premium ? "Premium Deep Reading Needs Attention" : "Canon Intake Needs Attention";
}

function customerRunError(row: Record<string, unknown>): string | null {
  const stored = textBody(row.error, 4_000);
  if (!stored) return null;
  if (Math.max(0, Number(row.customer_top_up_credits_needed ?? 0)) > 0) {
    return "The completed review is saved. Add credits, then resume to finish without repeating the reading.";
  }
  // Stored failures are diagnostic data and may contain arbitrary upstream
  // text even when they do not name a provider. Customer responses are always
  // synthesized from safe state rather than trying to redact unknown prose.
  return "The reading stopped before it finished. Everything already completed remains saved.";
}

export function serializeRun(row: Record<string, unknown> | undefined) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    stage: customerRunStage(row),
    progress: Number(row.progress ?? 0),
    sourceCount: Number(row.source_count ?? 0),
    chunkCount: Number(row.chunk_count ?? 0),
    error: customerRunError(row),
    analysisKind: row.analysis_kind ?? "local_scan",
    trigger: row.trigger_kind ?? "manual",
    incremental: Boolean(row.incremental),
    synthesisStatus: row.synthesis_status ?? "not_applicable",
    synthesisGroupCount: Number(row.synthesis_group_count ?? 0),
    synthesisCompletedGroups: Number(
      row.synthesis_completed_group_count ?? 0,
    ),
    intakePreview:
      row.intake_preview && typeof row.intake_preview === "object"
        ? row.intake_preview
        : null,
    intakeActivity: customerSafeIntakeActivityRows(row.intake_activity, {
      runId: row.id,
      analysisKind: row.analysis_kind ?? "local_scan",
      status: row.status,
      stage: row.stage,
      synthesisStatus: row.synthesis_status ?? "not_applicable",
    }),
    localCheckpointStage:
      row.local_checkpoint && typeof row.local_checkpoint === "object"
        ? textBody((row.local_checkpoint as Record<string, unknown>).completedStage, 40) ? "saved" : null
        : null,
    premiumResumeStatus: row.premium_resume_status ?? "not_available",
    topUpCreditsNeeded: Math.max(0, Number(row.customer_top_up_credits_needed ?? 0)),
    localCheckpointSavedAt: row.local_checkpoint_saved_at ?? null,
    pauseRequested: Boolean(row.pause_requested),
    pausedAt: row.paused_at ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export type WorldIntakePipeline = {
  status: "running" | "paused" | "awaiting_device" | "local_ready" | "ready" | "failed";
  stage: "extracting" | "local_read" | "browser_audit" | "premium_optional" | "ai_verification" | "complete";
  progress: number;
  message: string;
  requiresOpenPage: boolean;
  canOpenWorld: boolean;
  canRetryLocal: boolean;
  canStartPremiumReview: boolean;
};

type IntakeProjectionSource = {
  processingStatus: string;
  chunkCount: number;
  localScanStatus: string;
  aiReviewStatus: string;
};

type IntakeProjectionRun = {
  status: string;
  analysisKind: string;
  progress: number;
  stage?: string | null;
  error?: string | null;
  localCheckpointStage?: string | null;
  premiumResumeStatus?: string | null;
} | null;

export function localReaderInterruptionIsResumable(message: string) {
  return /(?:fetch failed|econnrefused|econnreset|und_err_socket|socket hang up|local (?:entity|coreference|lorekeeper) service returned http 5\d\d|the local lorekeeper service (?:stopped|is unavailable))/iu.test(
    message,
  );
}

type IntakeProjectionBrowserAudit = {
  status: string;
  progress: number;
  stage?: string | null;
  error?: string | null;
} | null;

export function worldIntakePipelineState(params: {
  sources: IntakeProjectionSource[];
  latestRun: IntakeProjectionRun;
  browserAudit: IntakeProjectionBrowserAudit;
  aiConfigured: boolean;
}): WorldIntakePipeline {
  const eligible = params.sources.filter((source) =>
    source.processingStatus === "ready" && Number(source.chunkCount) > 0,
  );
  const extractionFailed = params.sources.some((source) =>
    source.processingStatus === "failed",
  );
  const runActive = params.latestRun?.status === "queued" ||
    params.latestRun?.status === "running";
  const runPaused = params.latestRun?.status === "paused";
  const runFailed = params.latestRun?.status === "failed";
  const localComplete = eligible.length > 0 && eligible.every((source) =>
    source.localScanStatus === "completed" || source.localScanStatus === "not_applicable",
  );
  const localFailed = eligible.some((source) => source.localScanStatus === "failed");
  const aiComplete = eligible.length > 0 && eligible.every((source) =>
    source.aiReviewStatus === "reviewed" || source.aiReviewStatus === "not_applicable",
  );
  const aiFailed = eligible.some((source) => source.aiReviewStatus === "failed");
  const browserStatus = params.browserAudit?.status ?? "not_applicable";
  const browserActive = browserStatus === "pending" || browserStatus === "running";
  const browserPaused = browserStatus === "paused";
  const browserFailed = browserStatus === "failed";
  const browserResolved = !params.browserAudit || browserStatus === "completed" || browserStatus === "skipped";

  if (runPaused || browserPaused) {
    const aiRun = params.latestRun?.analysisKind === "ai_enrichment";
    return {
      status: "paused",
      stage: browserPaused
        ? "browser_audit"
        : aiRun ? "ai_verification" : "local_read",
      progress: browserPaused
        ? Math.max(92, Math.min(99, 92 + Math.round(
            (Number(params.browserAudit?.progress ?? 0) / 100) * 7,
          )))
        : aiRun
          ? Math.max(66, Math.min(99, 66 + Math.round(
              (Number(params.latestRun?.progress ?? 0) / 100) * 33,
            )))
          : Math.max(2, Math.min(91, Math.round(
              Number(params.latestRun?.progress ?? 2),
            ))),
      message: browserPaused
        ? "Canon Intake is paused after saving the latest private-reading work."
        : aiRun
          ? params.latestRun?.premiumResumeStatus === "blocked"
            ? "Your world remains available. Premium Deep Reading needs attention before resuming; no further credits will be used until the saved review can safely continue."
            : "Premium Deep Reading is saved. Resume when ready; your locally built world remains usable."
          : "Canon Intake is paused at a safe processing boundary.",
      requiresOpenPage: false,
      canOpenWorld: Boolean(aiRun && localComplete && browserResolved),
      canRetryLocal: false,
      canStartPremiumReview: false,
    };
  }

  if (
    eligible.length > 0 && localComplete && browserResolved && aiComplete && !runActive
  ) {
    return {
      status: "ready",
      stage: "complete",
      progress: 100,
      message: "Finished. Every uploaded passage has been indexed and the saved world review is ready.",
      requiresOpenPage: false,
      canOpenWorld: true,
      canRetryLocal: false,
      canStartPremiumReview: params.aiConfigured && params.latestRun?.premiumResumeStatus !== "blocked",
    };
  }

  if (browserActive) {
    return {
      status: "awaiting_device",
      stage: "browser_audit",
      progress: Math.max(92, Math.min(99, 92 + Math.round(
        (Number(params.browserAudit?.progress ?? 0) / 100) * 7,
      ))),
      message: params.browserAudit?.stage || "Privately checking discovered concepts and relationships…",
      requiresOpenPage: true,
      canOpenWorld: false,
      canRetryLocal: false,
      canStartPremiumReview: false,
    };
  }

  if (runActive) {
    const aiRun = params.latestRun?.analysisKind === "ai_enrichment";
    return {
      status: "running",
      stage: aiRun ? "ai_verification" : "local_read",
      progress: aiRun
        ? Math.max(66, Math.min(99, 66 + Math.round(
            (Number(params.latestRun?.progress ?? 0) / 100) * 33,
          )))
        : Math.max(2, Math.min(91, Math.round(
            Number(params.latestRun?.progress ?? 2),
          ))),
      message: params.latestRun?.stage || (aiRun
        ? "Checking every promoted finding against source evidence…"
        : "Reading the uploaded sources…"),
      requiresOpenPage: false,
      canOpenWorld: aiRun && localComplete && browserResolved,
      canRetryLocal: false,
      canStartPremiumReview: false,
    };
  }

  if (localComplete && browserResolved && (aiFailed || (
    runFailed && params.latestRun?.analysisKind === "ai_enrichment"
  ))) {
    return {
      status: "local_ready",
      stage: "premium_optional",
      progress: 100,
      message: params.latestRun?.premiumResumeStatus === "blocked"
        ? "Your world remains available. Premium Deep Reading needs attention before it can continue; saved work has been preserved."
        : "Your Storyhold world is ready. Premium Deep Reading stopped early, but you can open the world now or retry it when you choose.",
      requiresOpenPage: false,
      canOpenWorld: true,
      canRetryLocal: false,
      canStartPremiumReview: params.aiConfigured && params.latestRun?.premiumResumeStatus !== "blocked",
    };
  }

  if (extractionFailed || runFailed || localFailed || aiFailed || browserFailed) {
    const retryLocal = !localComplete && (runFailed || localFailed);
    return {
      status: "failed",
      stage: !localComplete
        ? eligible.length > 0 ? "local_read" : "extracting"
        : browserFailed ? "browser_audit" : "ai_verification",
      progress: Math.max(0, Math.min(99, Number(params.latestRun?.progress ?? 0))),
      message: retryLocal
        ? params.latestRun?.localCheckpointStage
          ? "The previous story reading stopped early. Its completed work is saved and can resume from the same point."
          : "The previous story reading stopped before resumable progress was available. Restart Canon Intake once; future interruptions will resume from saved work."
        : params.browserAudit?.error || params.latestRun?.error ||
          "The last pass stopped before the world was ready. Everything already saved remains intact.",
      requiresOpenPage: false,
      canOpenWorld: false,
      canRetryLocal: retryLocal,
      canStartPremiumReview: false,
    };
  }

  if (!localComplete) {
    return {
      status: "running",
      stage: eligible.length > 0 ? "local_read" : "extracting",
      progress: eligible.length > 0 ? 2 : 0,
      message: eligible.length > 0
        ? "Storyhold is queued to examine the uploaded passages."
        : "Preparing the uploaded sources…",
      requiresOpenPage: false,
      canOpenWorld: false,
      canRetryLocal: eligible.length > 0,
      canStartPremiumReview: false,
    };
  }

  return {
    status: "local_ready",
    stage: "premium_optional",
    progress: 100,
    message: params.aiConfigured
      ? "Your Storyhold world is ready. Open it now, or choose Premium Deep Reading for a more detailed, evidence-checked understanding."
      : "Your Storyhold world is ready. You can open and use it now; Premium Deep Reading becomes available when an AI provider is connected.",
    requiresOpenPage: false,
    canOpenWorld: true,
    canRetryLocal: false,
    canStartPremiumReview: params.aiConfigured,
  };
}

function serializeQualityFinding(row: Record<string, unknown>) {
  return {
    id: row.id,
    category: row.category,
    severity: row.severity,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id ?? null,
    label: row.label,
    explanation: row.explanation,
    recommendedTask: row.recommended_task,
    metadata: row.metadata ?? {},
    status: row.finding_status ?? "open",
    firstDetectedAt: row.first_detected_at,
    lastDetectedAt: row.last_detected_at,
    resolvedAt: row.resolved_at ?? null,
  };
}

function serializeReferenceSource(row: Record<string, unknown>) {
  return {
    id: row.id,
    query: row.query ?? "",
    title: row.title,
    url: row.url,
    publisher: row.publisher ?? "",
    summary: row.summary ?? "",
    keywords: stringList(row.keywords, 30, 120),
    discoveredBy: row.discovered_by ?? "user",
    reviewStatus: row.review_status ?? "candidate",
    extractionStatus: row.extraction_status ?? "pending",
    extractionMethod: row.extraction_method ?? null,
    qualityScore:
      row.quality_score === null || row.quality_score === undefined
        ? null
        : Number(row.quality_score),
    qualityFlags: stringList(row.quality_flags, 30, 160),
    wordCount: Number(row.word_count ?? 0),
    usePolicy: "background_only",
    knowledgeScope: row.knowledge_scope ?? "director_only",
    knownBy: stringList(row.known_by, 50, 180),
    loreStatus: row.lore_status ?? "supplemental",
    processingError: row.processing_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeCohesionProposal(row: Record<string, unknown>) {
  return {
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    summary: row.summary,
    severity: row.severity,
    evidence: row.evidence ?? [],
    reviewStatus: row.review_status,
    classification: row.classification,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  };
}

function serializeDiscrepancyReport(row: Record<string, unknown>) {
  return {
    id: row.id,
    canonicalKey: row.canonical_key,
    campaignId: row.campaign_id,
    claim: row.claim,
    reasoning: row.reasoning,
    status: row.status,
    explanation: row.review_explanation,
    confidence: Number(row.review_confidence ?? 0),
    proposedAmendment: row.proposed_amendment ?? null,
    evidence: row.evidence ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

function serializeCanonAmendment(row: Record<string, unknown>) {
  return {
    id: row.id,
    canonicalKey: row.canonical_key,
    campaignId: row.campaign_id,
    subject: row.subject,
    operation: row.operation,
    statement: row.statement,
    previousStatement: row.previous_statement,
    rationale: row.rationale,
    evidence: row.evidence ?? [],
    decisionSource: row.decision_source,
    createdAt: row.created_at,
  };
}

function storedStringList(value: unknown, maximum = 40): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const values: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const clean = entry.replace(/\s+/g, " ").trim();
    const key = clean.toLocaleLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    values.push(clean);
    if (values.length >= maximum) break;
  }
  return values;
}

function storedEvidence(value: unknown): NamedFinding["evidence"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const chunkId = typeof record.chunkId === "string" ? record.chunkId.trim() : "";
    const quote = typeof record.quote === "string" ? record.quote.trim() : "";
    if (!chunkId || !quote) return [];
    return [{
      chunkId,
      sourceId: typeof record.sourceId === "string" ? record.sourceId.trim() : "",
      quote,
    }];
  });
}

/**
 * Breakdown rows outlive the parser version that created them. Normalize the
 * small set of fields used by incremental merging so one malformed legacy row
 * cannot discard the rest of a completed scan. String-only legacy labels are
 * retained; only entries without any recoverable name are ignored.
 */
function namedFindingsFromStored(value: unknown): NamedFinding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): NamedFinding[] => {
    if (typeof entry === "string") {
      const name = entry.replace(/\s+/g, " ").trim();
      return name ? [{ name, summary: "", evidence: [] }] : [];
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const rawName = record.name ?? record.statement;
    const name = typeof rawName === "string"
      ? rawName.replace(/\s+/g, " ").trim()
      : "";
    if (!name) return [];
    const confidence = Number(record.confidence);
    const mentionCount = Number(record.mentionCount);
    const mentionSourceCount = Number(record.mentionSourceCount);
    const reviewStatus = record.reviewStatus === "candidate" || record.reviewStatus === "verified"
      ? record.reviewStatus
      : undefined;
    return [{
      ...record,
      name,
      summary: typeof record.summary === "string" ? record.summary.trim() : "",
      evidence: storedEvidence(record.evidence),
      aliases: storedStringList(record.aliases, 30),
      details: storedStringList(record.details, 60),
      relationships: storedStringList(record.relationships, 60),
      factionMemberships: storedStringList(record.factionMemberships, 30),
      confidence: Number.isFinite(confidence)
        ? Math.max(0, Math.min(1, confidence))
        : undefined,
      mentionCount: Number.isFinite(mentionCount) && mentionCount >= 0
        ? Math.floor(mentionCount)
        : undefined,
      mentionSourceCount: Number.isFinite(mentionSourceCount) && mentionSourceCount >= 0
        ? Math.floor(mentionSourceCount)
        : undefined,
      reviewStatus,
    } as NamedFinding];
  });
}

function chronologyFromStored(value: unknown): WorldFindings["chronology"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    if (typeof entry === "string") {
      const summary = entry.trim();
      if (!summary) return [];
      const colonTitle = summary.match(/^([^:]{2,80}):\s+/)?.[1];
      const bookTitle = summary.match(/^(Book\s+(?:One|Two|Three|Four|Five|\d+))/i)?.[1];
      return [{
        name: colonTitle ?? bookTitle ?? `Imported event ${index + 1}`,
        summary,
        evidence: [],
        aliases: [],
        details: [],
        relationships: [],
        confidence: 0.7,
        reviewStatus: "verified" as const,
      }];
    }
    if (!entry || typeof entry !== "object") return [];
    const finding = entry as Record<string, unknown>;
    if (typeof finding.name !== "string" || !finding.name.trim()) return [];
    return [{
      ...finding,
      name: finding.name.trim(),
      summary: typeof finding.summary === "string" ? finding.summary : "",
      evidence: storedEvidence(finding.evidence),
      aliases: storedStringList(finding.aliases, 30),
      details: storedStringList(finding.details, 60),
      relationships: storedStringList(finding.relationships, 60),
      sourceChapterKeys: storedStringList(finding.sourceChapterKeys, 60),
      actors: storedStringList(finding.actors, 60),
      targets: storedStringList(finding.targets, 60),
      witnesses: storedStringList(finding.witnesses, 60),
      locations: storedStringList(finding.locations, 60),
    } as WorldFindings["chronology"][number]];
  });
}

export function findingsFromBreakdown(
  row: Record<string, unknown> | undefined,
): WorldFindings | null {
  if (!row) return null;
  const evidenceGraph = row.evidence_graph;
  if (
    evidenceGraph &&
    typeof evidenceGraph === "object" &&
    !Array.isArray(evidenceGraph)
  ) {
    const graph = evidenceGraph as Partial<WorldFindings>;
    const requiredArrays: Array<keyof WorldFindings> = [
      "genres", "atmosphere", "themes", "worldRules", "locations",
      "factions", "institutions", "governments", "powerStructures",
      "creatures", "species", "technologies", "vehicles", "devices",
      "weapons", "powers", "titles", "ambiguous", "chapterSummaries",
      "chronology", "openQuestions", "recurringTerms", "characters",
      "entityRelations", "entityRules", "cohesionProposals",
    ];
    if (
      typeof graph.summary === "string" &&
      requiredArrays.every((key) => Array.isArray(graph[key]))
    ) {
      return structuredClone(graph) as WorldFindings;
    }
  }
  return {
    summary: typeof row.summary === "string" ? row.summary : "",
    genres: Array.isArray(row.genres) ? (row.genres as string[]) : [],
    atmosphere: Array.isArray(row.atmosphere)
      ? (row.atmosphere as string[])
      : [],
    themes: Array.isArray(row.themes) ? (row.themes as string[]) : [],
    worldRules: namedFindingsFromStored(row.world_rules),
    locations: namedFindingsFromStored(row.locations),
    factions: namedFindingsFromStored(row.factions),
    institutions: namedFindingsFromStored(row.institutions),
    governments: namedFindingsFromStored(row.governments),
    powerStructures: namedFindingsFromStored(row.power_structures),
    creatures: namedFindingsFromStored(row.creatures),
    species: namedFindingsFromStored(row.species),
    technologies: namedFindingsFromStored(row.technologies),
    vehicles: namedFindingsFromStored(row.vehicles),
    devices: namedFindingsFromStored(row.devices),
    weapons: namedFindingsFromStored(row.weapons),
    powers: namedFindingsFromStored(row.powers),
    titles: namedFindingsFromStored(row.titles),
    ambiguous: namedFindingsFromStored(row.ambiguous_labels),
    chapterSummaries: [],
    chronology: chronologyFromStored(row.chronology),
    openQuestions: Array.isArray(row.open_questions)
      ? (row.open_questions as string[])
      : [],
    recurringTerms: Array.isArray(row.recurring_terms)
      ? (row.recurring_terms as string[])
      : [],
    characters: [],
    entityRelations: Array.isArray(row.entity_relations)
      ? (row.entity_relations as WorldFindings["entityRelations"])
      : [],
    entityRules: Array.isArray(row.entity_rules)
      ? (row.entity_rules as WorldFindings["entityRules"])
      : [],
    claims: Array.isArray(row.claims)
      ? (row.claims as NonNullable<WorldFindings["claims"]>)
      : [],
    cohesionProposals: [],
  };
}

type PersistedLocalEntityFindingKey =
  | "locations"
  | "factions"
  | "institutions"
  | "governments"
  | "powerStructures"
  | "creatures"
  | "species"
  | "technologies"
  | "vehicles"
  | "devices"
  | "weapons"
  | "powers"
  | "titles"
  | "ambiguous";

const PERSISTED_LOCAL_ENTITY_FINDING_KEYS: Partial<Record<EntityType, PersistedLocalEntityFindingKey>> = {
  place: "locations",
  faction: "factions",
  institution: "institutions",
  government: "governments",
  power_structure: "powerStructures",
  creature: "creatures",
  species: "species",
  technology: "technologies",
  vehicle: "vehicles",
  device: "devices",
  weapon: "weapons",
  power: "powers",
  title: "titles",
  ambiguous: "ambiguous",
};

function persistedLocalEntityIdentity(value: unknown): string {
  return textBody(value, 240)
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase()
    .replace(/^(?:a|an|the)\s+/u, "");
}

/**
 * Generated scanner rows are usable only while the current scan still owns
 * them. Customer-created/confirmed rows may participate without a scanner
 * hit, but a deliberate pull decision always wins.
 */
export function persistedLocalEntityIsConnectionEligible(
  row: Record<string, unknown>,
): boolean {
  const pullStatus = textBody(row.pull_status, 30);
  if (pullStatus !== "active") return false;
  const customerOwned = row.classification_source === "user" ||
    row.review_status === "user_confirmed";
  return customerOwned || row.scanner_present === true;
}

type PersistedLocalEntityAdjudicationUpdate = {
  id: string;
  entityType: EntityType;
  previousEntityType: EntityType;
  summary: string;
  details: string[];
  dossierId: string;
  activateDossier: boolean;
};

export function adjudicatePersistedLocalEntityRows(
  rows: Record<string, unknown>[],
  dossiers: Record<string, unknown>[] = [],
): {
  rows: Record<string, unknown>[];
  updates: PersistedLocalEntityAdjudicationUpdate[];
} {
  const updates: PersistedLocalEntityAdjudicationUpdate[] = [];
  const dossierById = new Map(dossiers.map((row) => [textBody(row.id, 100), row]));
  const dossierByName = new Map(dossiers.map((row) => [
    persistedLocalEntityIdentity(row.normalized_name || row.name),
    row,
  ]));
  const presentationCategory = (summary: string, details: string[]): EntityType | null => {
    const presentation = `${summary}\n${details.join("\n")}`;
    if (/\b(?:presented as an? |within the story as an? )?creature or nonhuman form\b|^Creature$/imu.test(presentation)) return "creature";
    if (/\b(?:presented as an? |within the story as an? )?location within the story\b|^Place$/imu.test(presentation)) return "place";
    if (/\btechnology or technical system\b|^Technology$/imu.test(presentation)) return "technology";
    if (/\bphysical device\b|^Device$/imu.test(presentation)) return "device";
    if (/\bpeople, species, or biological lineage\b|^Species$/imu.test(presentation)) return "species";
    if (/\b(?:outside media reference|outside cultural or religious reference|cultural reference)\b|^Cultural Reference$/imu.test(presentation)) return "cultural_reference";
    if (/\bstory concept whose exact nature remains unresolved\b|^Needs Sorting$/imu.test(presentation)) return "ambiguous";
    return null;
  };
  const adjudicatedRows = rows.map((row) => {
    const previousEntityType = textBody(row.entity_type, 80) as EntityType;
    if (
      row.classification_source !== "local" ||
      entityIsScannerProtected(row) ||
      row.scanner_present !== true
    ) return row;
    const name = textBody(row.name, 240);
    if (!name) return row;
    const dossier = dossierById.get(textBody(row.dossier_id, 100)) ??
      dossierByName.get(persistedLocalEntityIdentity(row.normalized_name || name));
    const dossierEvidence = storedEvidence(dossier?.evidence);
    const evidence = storedEvidence(mergeEntityEvidence(row.evidence, dossier?.evidence));
    const dossierSupportsCharacter = Boolean(dossier) &&
      ["active", "suppressed"].includes(textBody(dossier?.dossier_status, 30)) &&
      localCharacterNameIsUseful(name) && (
        Boolean(dossier?.user_edited_at) ||
        localEvidenceBehavesLikeCharacter(name, dossierEvidence) ||
        generatedCharacterDossierIsSubstantive({
          name: dossier?.name ?? name,
          summary: dossier?.summary,
          role: dossier?.role,
          profile: dossier?.profile,
          evidence: dossierEvidence,
          canonicalCharacterId: dossier?.canonical_character_id,
          mentionCount: dossier?.mention_count,
          mentionSourceCount: dossier?.mention_source_count,
        })
      );
    const evidenceCategory = localEntityCategoryFromEvidence(
      name,
      evidence,
      previousEntityType,
    ) as EntityType;
    const neutralEvidenceCategory = localEntityCategoryFromEvidence(
      name,
      evidence,
      "ambiguous",
    ) as EntityType;
    // A generated dossier is corroboration only while the manuscript evidence
    // remains ambiguous. Explicit form, creature, species, place, object, or
    // collective evidence outranks a stale POV/character boilerplate dossier.
    // A customer-edited dossier remains customer authority.
    const entityType = dossierSupportsCharacter && (
      Boolean(dossier?.user_edited_at) ||
      neutralEvidenceCategory === "character" ||
      neutralEvidenceCategory === "ambiguous"
    )
      ? "character"
      : neutralEvidenceCategory !== "ambiguous"
        ? neutralEvidenceCategory
        : evidenceCategory;
    if (!ENTITY_TYPES.has(entityType)) return row;
    const currentSummary = textBody(row.summary, 4_000);
    const currentDetails = stringList(row.details, 80, 500);
    const categoryMismatch = presentationCategory(currentSummary, currentDetails);
    const presentationNeedsRefresh = Boolean(categoryMismatch && categoryMismatch !== entityType) ||
      generatedEntityPresentationNeedsRefresh(currentSummary);
    let summary = currentSummary;
    let details = currentDetails;
    if (entityType !== previousEntityType || presentationNeedsRefresh) {
      const dossierSummary = textBody(dossier?.summary, 4_000);
      const dossierPresentationCategory = presentationCategory(
        dossierSummary,
        stringList(recordBody(dossier?.profile).details, 80, 500),
      );
      if (
        entityType === "character" && currentSummary && !presentationNeedsRefresh &&
        !generatedEntityPresentationNeedsRefresh(currentSummary)
      ) {
        summary = currentSummary;
      } else if (
        entityType === "character" && dossierSummary &&
        (!dossierPresentationCategory || dossierPresentationCategory === "character") &&
        !generatedEntityPresentationNeedsRefresh(dossierSummary)
      ) {
        summary = dossierSummary;
      } else {
        summary = localPublicEntitySummaryFromEvidence(entityType, name, evidence).summary;
      }
      if ((categoryMismatch && categoryMismatch !== entityType) || !currentDetails.length) {
        const profile = normalizedDossierProfile(dossier?.profile);
        const dossierDetails = entityType === "character"
          ? mergeEntityStrings(
              profile.traits,
              profile.capabilities,
              profile.powers,
              profile.physicalCharacteristics,
            )
          : [];
        details = dossierDetails.length
          ? dossierDetails
          : localPublicEntitySummaryFromEvidence(entityType, name, evidence).details;
      }
    }
    const categoryChanged = entityType !== previousEntityType;
    const presentationChanged = summary !== currentSummary ||
      JSON.stringify(details) !== JSON.stringify(currentDetails);
    const dossierId = textBody(dossier?.id, 100);
    const linkChanged = dossierSupportsCharacter && dossierId &&
      dossierId !== textBody(row.dossier_id, 100);
    if (!categoryChanged && !presentationChanged && !linkChanged) return row;
    const id = textBody(row.id, 100);
    if (id) updates.push({
      id,
      entityType,
      previousEntityType,
      summary,
      details,
      dossierId,
      activateDossier: dossierSupportsCharacter && !dossier?.user_edited_at,
    });
    return { ...row, entity_type: entityType, summary, details };
  });
  return { rows: adjudicatedRows, updates };
}

/**
 * Persist one generated entity-boundary repair without stealing a dossier
 * already attached to another entity. A stale concept can share a normalized
 * name with a valid dossier, but `world_entities.dossier_id` is intentionally
 * one-to-one. Its category and public copy may still be repaired while the
 * established dossier owner remains untouched.
 */
export async function persistAdjudicatedLocalEntityUpdate(
  db: StudioDb,
  update: PersistedLocalEntityAdjudicationUpdate,
): Promise<string> {
  const result = await db.query<{ dossier_id: string | null }>(
    `UPDATE storyhold.world_entities AS entity
        SET entity_type = $2, summary = $3, details = $4::jsonb,
            dossier_id = CASE
              WHEN $5::uuid IS NULL OR entity.dossier_id = $5::uuid
                THEN entity.dossier_id
              WHEN NOT EXISTS (
                SELECT 1
                  FROM storyhold.world_entities AS dossier_owner
                 WHERE dossier_owner.dossier_id = $5::uuid
                   AND dossier_owner.id <> entity.id
              ) THEN $5::uuid
              ELSE entity.dossier_id
            END,
            updated_at = now()
      WHERE entity.id = $1 AND entity.classification_source = 'local'
        AND COALESCE(entity.review_status, 'candidate') <> 'user_confirmed'
        AND entity.pull_status = 'active' AND entity.scanner_present = true
      RETURNING entity.dossier_id::text AS dossier_id`,
    [update.id, update.entityType, update.summary, json(update.details), update.dossierId || null],
  );
  return textBody(result.rows[0]?.dossier_id, 100);
}

export function generatedLocalContextLeadShouldRemainVisible(
  row: Record<string, unknown>,
): boolean {
  if (row.classification_source !== "local" || row.review_status === "user_confirmed") return true;
  if (!entityIsCustomerVisible({ ...row, scanner_present: true })) return false;
  const name = textBody(row.name, 240);
  const evidence = storedEvidence(row.evidence);
  if (localEntityEvidenceIsNonEntity(name, evidence)) return false;
  if (row.entity_type !== "cultural_reference") return true;
  const singleToken = /^\p{Lu}[\p{L}\p{M}'’.-]*$/u.test(name);
  const sparse = Number(row.mention_count ?? evidence.length) <= 2;
  const extractedFromMediaComparison = evidence.some((entry) =>
    /\b(?:movie|film|show|series|book|novel|song|game|television|TV|watched?)\b/iu.test(entry.quote)
  ) && !localEvidenceBehavesLikeCharacter(name, evidence);
  // A one-word figure extracted only from a comparison to a separately named
  // work remains useful retrieval context, but is not a standalone world page.
  // Multi-word works and independently recurring references remain visible.
  return !(singleToken && sparse && extractedFromMediaComparison);
}

/** Remove projections whose generated entity was retired after the breakdown. */
export function removeRetiredLocalEntityRelationships(
  findings: WorldFindings,
  rows: Record<string, unknown>[],
): WorldFindings {
  const eligible = new Set<string>();
  const retired = new Set<string>();
  for (const row of rows) {
    const destination = persistedLocalEntityIsConnectionEligible(row) ? eligible : retired;
    for (const value of [row.name, ...stringList(row.aliases, 80, 240)]) {
      const identity = persistedLocalEntityIdentity(value);
      if (identity) destination.add(identity);
    }
  }
  for (const identity of eligible) retired.delete(identity);
  if (!retired.size) return findings;
  const compactTargetIsRetired = (relationship: string) => {
    const separator = relationship.indexOf(":");
    if (separator < 1) return false;
    return retired.has(persistedLocalEntityIdentity(relationship.slice(0, separator)));
  };
  const scrubNamed = (finding: NamedFinding): NamedFinding => ({
    ...finding,
    relationships: (finding.relationships ?? []).filter((entry) => !compactTargetIsRetired(entry)),
  });
  return {
    ...findings,
    characters: findings.characters.map((character) => ({
      ...character,
      relationshipWeb: character.relationshipWeb.filter((entry) =>
        !retired.has(persistedLocalEntityIdentity(entry.name))
      ),
      relationships: character.relationships.filter((entry) => !compactTargetIsRetired(entry)),
    })),
    locations: findings.locations.map(scrubNamed),
    factions: findings.factions.map(scrubNamed),
    institutions: findings.institutions.map(scrubNamed),
    governments: findings.governments.map(scrubNamed),
    powerStructures: findings.powerStructures.map(scrubNamed),
    creatures: findings.creatures.map(scrubNamed),
    species: findings.species.map(scrubNamed),
    technologies: findings.technologies.map(scrubNamed),
    vehicles: findings.vehicles.map(scrubNamed),
    devices: findings.devices.map(scrubNamed),
    weapons: findings.weapons.map(scrubNamed),
    powers: findings.powers.map(scrubNamed),
    titles: findings.titles.map(scrubNamed),
    ambiguous: findings.ambiguous.map(scrubNamed),
    entityRelations: findings.entityRelations.filter((relation) =>
      !retired.has(persistedLocalEntityIdentity(relation.subject)) &&
      !retired.has(persistedLocalEntityIdentity(relation.target))
    ),
  };
}

/**
 * A dossier-only replay reads its narrative graph from the last breakdown, but
 * entity adjudication can happen after that breakdown was saved. Restore the
 * current generated entity category into the in-memory findings before any
 * relationship synthesis. Otherwise a species that was correctly repaired in
 * `world_entities` can still look ambiguous (or person-like) to the replay and
 * acquire character-only relationships such as a symbiotic bond.
 *
 * `world_entities` is the current generated classification boundary here. A
 * same-surface row in an older breakdown category is replaced, while all
 * unrelated findings remain untouched.
 */
export function restorePersistedLocalEntityCategories(
  findings: WorldFindings,
  rows: Record<string, unknown>[],
): WorldFindings {
  const restored: WorldFindings = {
    ...findings,
    locations: [...findings.locations],
    factions: [...findings.factions],
    institutions: [...findings.institutions],
    governments: [...findings.governments],
    powerStructures: [...findings.powerStructures],
    creatures: [...findings.creatures],
    species: [...findings.species],
    technologies: [...findings.technologies],
    vehicles: [...findings.vehicles],
    devices: [...findings.devices],
    weapons: [...findings.weapons],
    powers: [...findings.powers],
    titles: [...findings.titles],
    ambiguous: [...findings.ambiguous],
  };
  const categoryKeys = Object.values(PERSISTED_LOCAL_ENTITY_FINDING_KEYS)
    .filter((value): value is PersistedLocalEntityFindingKey => Boolean(value));

  // First retire every old same-surface breakdown projection. This must also
  // happen for character/term rows and for scanner leads that are no longer
  // present; neither has a named-finding destination to add below.
  const rowIdentities = new Set(rows.map((row) => persistedLocalEntityIdentity(row.name)).filter(Boolean));
  for (const key of categoryKeys) {
    restored[key] = restored[key].filter((finding) =>
      !rowIdentities.has(persistedLocalEntityIdentity(finding.name))
    );
  }
  const preferredRows = new Map<string, Record<string, unknown>>();
  const categoryAuthority = (row: Record<string, unknown>) => {
    if (row.classification_source === "user") return 4;
    if (row.review_status === "user_confirmed") return 3;
    if (row.classification_source === "ai") return 2;
    return 1;
  };
  for (const row of rows) {
    if (!persistedLocalEntityIsConnectionEligible(row)) continue;
    const identity = persistedLocalEntityIdentity(row.name);
    if (!identity) continue;
    const previous = preferredRows.get(identity);
    if (
      !previous || categoryAuthority(row) > categoryAuthority(previous) ||
      (categoryAuthority(row) === categoryAuthority(previous) &&
        Number(row.confidence ?? 0) > Number(previous.confidence ?? 0))
    ) preferredRows.set(identity, row);
  }
  for (const row of preferredRows.values()) {
    const entityType = textBody(row.entity_type, 80) as EntityType;
    const targetKey = PERSISTED_LOCAL_ENTITY_FINDING_KEYS[entityType];
    const name = textBody(row.name, 240);
    const normalizedName = persistedLocalEntityIdentity(name);
    if (
      !targetKey || !normalizedName
    ) continue;
    restored[targetKey].push({
      name,
      aliases: stringList(row.aliases, 80, 240),
      summary: textBody(row.summary, 4_000),
      details: stringList(row.details, 80, 500),
      relationships: stringList(row.relationships, 80, 500),
      evidence: storedEvidence(row.evidence),
      confidence: Math.max(0, Math.min(1, Number(row.confidence ?? 0.35))),
      mentionCount: Math.max(0, Number(row.mention_count ?? 0)),
      mentionSourceCount: Math.max(0, Number(row.mention_source_count ?? 0)),
      reviewStatus: row.review_status === "verified" || row.review_status === "user_confirmed"
        ? "verified"
        : "candidate",
    });
  }
  return restored;
}

function isDeterministicCandidate(finding: NamedFinding): boolean {
  return (
    finding.reviewStatus === "candidate" ||
    /^Storyhold found [\d,]+ exact mentions? of /iu.test(finding.summary)
  );
}

function withoutSupersededCandidates(
  findings: WorldFindings,
  legacyLocalBreakdown = false,
): WorldFindings {
  const shouldDiscard = (finding: NamedFinding) =>
    legacyLocalBreakdown || isDeterministicCandidate(finding);
  return {
    ...findings,
    locations: findings.locations.filter(
      (finding) => !shouldDiscard(finding),
    ).map((finding) => ({
      ...finding,
      reviewStatus: finding.reviewStatus ?? "verified",
    })),
    factions: findings.factions.filter(
      (finding) => !shouldDiscard(finding),
    ).map((finding) => ({
      ...finding,
      reviewStatus: finding.reviewStatus ?? "verified",
    })),
    institutions: findings.institutions.filter(
      (finding) => !shouldDiscard(finding),
    ).map((finding) => ({
      ...finding,
      reviewStatus: finding.reviewStatus ?? "verified",
    })),
    governments: findings.governments.filter(
      (finding) => !shouldDiscard(finding),
    ).map((finding) => ({
      ...finding,
      reviewStatus: finding.reviewStatus ?? "verified",
    })),
    powerStructures: findings.powerStructures.filter(
      (finding) => !shouldDiscard(finding),
    ).map((finding) => ({
      ...finding,
      reviewStatus: finding.reviewStatus ?? "verified",
    })),
    creatures: findings.creatures.filter(
      (finding) => !shouldDiscard(finding),
    ).map((finding) => ({
      ...finding,
      reviewStatus: finding.reviewStatus ?? "verified",
    })),
    species: findings.species.filter(
      (finding) => !shouldDiscard(finding),
    ).map((finding) => ({
      ...finding,
      reviewStatus: finding.reviewStatus ?? "verified",
    })),
    technologies: findings.technologies.filter(
      (finding) => !shouldDiscard(finding),
    ).map((finding) => ({
      ...finding,
      reviewStatus: finding.reviewStatus ?? "verified",
    })),
    vehicles: findings.vehicles.filter(
      (finding) => !shouldDiscard(finding),
    ).map((finding) => ({
      ...finding,
      reviewStatus: finding.reviewStatus ?? "verified",
    })),
    devices: findings.devices.filter(
      (finding) => !shouldDiscard(finding),
    ).map((finding) => ({
      ...finding,
      reviewStatus: finding.reviewStatus ?? "verified",
    })),
    weapons: findings.weapons.filter(
      (finding) => !shouldDiscard(finding),
    ).map((finding) => ({
      ...finding,
      reviewStatus: finding.reviewStatus ?? "verified",
    })),
    powers: findings.powers.filter(
      (finding) => !shouldDiscard(finding),
    ).map((finding) => ({
      ...finding,
      reviewStatus: finding.reviewStatus ?? "verified",
    })),
    titles: findings.titles.filter(
      (finding) => !shouldDiscard(finding),
    ).map((finding) => ({
      ...finding,
      reviewStatus: finding.reviewStatus ?? "verified",
    })),
    ambiguous: findings.ambiguous.filter(
      (finding) => !shouldDiscard(finding),
    ).map((finding) => ({
      ...finding,
      reviewStatus: finding.reviewStatus ?? "verified",
    })),
  };
}

function carryCandidateCounts(
  findings: NamedFinding[],
  candidates: NamedFinding[],
): NamedFinding[] {
  const byName = new Map(
    candidates.map((candidate) => [candidate.name.toLocaleLowerCase(), candidate]),
  );
  return findings.map((finding) => {
    const candidate = byName.get(finding.name.toLocaleLowerCase());
    return candidate
      ? {
          ...finding,
          mentionCount: candidate.mentionCount,
          mentionSourceCount: candidate.mentionSourceCount,
        }
      : finding;
  });
}

function serializeBreakdown(row: Record<string, unknown> | undefined) {
  if (!row) return null;
  return {
    id: row.id,
    version: Number(row.version),
    status: row.status,
    provider: row.provider,
    model: row.model,
    summary: row.summary,
    genres: row.genres ?? [],
    atmosphere: row.atmosphere ?? [],
    themes: row.themes ?? [],
    worldRules: row.world_rules ?? [],
    locations: row.locations ?? [],
    factions: row.factions ?? [],
    institutions: row.institutions ?? [],
    governments: row.governments ?? [],
    powerStructures: row.power_structures ?? [],
    creatures: row.creatures ?? [],
    species: row.species ?? [],
    technologies: row.technologies ?? [],
    vehicles: row.vehicles ?? [],
    devices: row.devices ?? [],
    weapons: row.weapons ?? [],
    powers: row.powers ?? [],
    titles: row.titles ?? [],
    entityRelations: row.entity_relations ?? [],
    entityRules: row.entity_rules ?? [],
    claims: row.claims ?? [],
    ambiguous: row.ambiguous_labels ?? [],
    chronology: chronologyFromStored(row.chronology),
    openQuestions: row.open_questions ?? [],
    recurringTerms: row.recurring_terms ?? [],
    createdAt: row.created_at,
  };
}

function serializeDraft(row: Record<string, unknown>) {
  return {
    id: row.id,
    canonicalKey: row.canonical_key,
    name: row.name,
    aliases: row.aliases ?? [],
    role: row.role,
    summary: row.summary,
    profile: row.profile ?? {},
    evidence: row.evidence ?? [],
    confidence: Number(row.confidence ?? 0),
    reviewStatus: row.review_status,
    canonicalCharacterId: row.canonical_character_id,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  };
}

const DOSSIER_STATS = [
  "strength",
  "dexterity",
  "constitution",
  "intelligence",
  "wisdom",
  "charisma",
  "acrobatics",
] as const;

function dossierStatBlock(value: unknown) {
  const input = recordBody(value);
  return Object.fromEntries(
    DOSSIER_STATS.map((stat) => {
      const raw = recordBody(input[stat]);
      const score = Number(raw.score);
      const confidence = Number(raw.confidence);
      return [
        stat,
        {
          score: Number.isFinite(score) ? Math.max(1, Math.min(20, Math.round(score))) : 10,
          confidence: Number.isFinite(confidence)
            ? Math.max(0, Math.min(1, confidence))
            : 0.1,
          rationale:
            textBody(raw.rationale, 500) ||
            "Neutral estimate pending stronger source evidence.",
          evidence: storedEvidence(raw.evidence).slice(0, 5),
        },
      ];
    }),
  );
}

/** Reviewed replacements win over confidence; an omitted estimate erases nothing. */
export function mergeReviewedStatEstimates(previous: unknown, incoming: unknown) {
  const prior = dossierStatBlock(previous);
  const next = dossierStatBlock(incoming);
  return Object.fromEntries(DOSSIER_STATS.map((stat) => [stat,
    isNeutralPremiumStatEstimate(next[stat]) ? prior[stat] : next[stat],
  ]));
}

function dossierAxis(value: unknown) {
  const input = recordBody(value);
  const economic = Number(input.economic);
  const authority = Number(input.authority);
  const confidence = Number(input.confidence);
  return {
    economic: Number.isFinite(economic)
      ? Math.max(-100, Math.min(100, Math.round(economic)))
      : 0,
    authority: Number.isFinite(authority)
      ? Math.max(-100, Math.min(100, Math.round(authority)))
      : 0,
    label: textBody(input.label, 120) || "Undetermined",
    rationale:
      textBody(input.rationale, 1_000) ||
      "Insufficient evidence for a confident political estimate.",
    confidence: Number.isFinite(confidence)
      ? Math.max(0, Math.min(1, confidence))
      : 0.05,
  };
}

function normalizedDossierProfile(value: unknown) {
  const profile = recordBody(value);
  const list = (key: string) => dossierStrings(profile[key]);
  const relationshipWeb = Array.isArray(profile.relationshipWeb)
    ? profile.relationshipWeb
        .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
        .map((entry) => {
          const item = entry as Record<string, unknown>;
          return {
            name: typeof item.name === "string" ? item.name : "",
            relationship: typeof item.relationship === "string" ? item.relationship : "",
            summary: typeof item.summary === "string" ? item.summary : "",
            sentiment: typeof item.sentiment === "string" && item.sentiment ? item.sentiment : "unknown",
            evidence: Array.isArray(item.evidence) ? item.evidence : [],
          };
        })
        .filter((entry) => entry.name)
    : [];
  return {
    traits: list("traits"),
    motivations: list("motivations"),
    fears: list("fears"),
    capabilities: list("capabilities"),
    history: list("history"),
    origins: list("origins"),
    powers: list("powers"),
    moralSystem: list("moralSystem"),
    physicalCharacteristics: list("physicalCharacteristics"),
    relationships: list("relationships"),
    relationshipWeb,
    knowledge: list("knowledge"),
    secrets: list("secrets"),
    estimatedStats: dossierStatBlock(profile.estimatedStats),
  };
}

export function mergeDossierProfiles(previous: unknown, incoming: unknown) {
  const left = normalizedDossierProfile(previous);
  const right = normalizedDossierProfile(incoming);
  const relationshipWeb = left.relationshipWeb.map((entry) => ({
    ...entry,
    evidence: [...entry.evidence],
  }));
  for (const candidate of right.relationshipWeb) {
    const existing = relationshipWeb.find(
      (entry) =>
        entry.name.toLocaleLowerCase() === candidate.name.toLocaleLowerCase() &&
        entry.relationship.toLocaleLowerCase() ===
          candidate.relationship.toLocaleLowerCase(),
    );
    if (!existing) {
      relationshipWeb.push({ ...candidate, evidence: [...candidate.evidence] });
      continue;
    }
    if (candidate.summary.length > existing.summary.length) {
      existing.summary = candidate.summary;
    }
    if (existing.sentiment === "unknown" && candidate.sentiment !== "unknown") {
      existing.sentiment = candidate.sentiment;
    }
    existing.evidence = [...new Map([...existing.evidence, ...candidate.evidence]
      .map((anchor) => [lorekeeperSnapshotFingerprint(anchor), anchor])).values()];
  }
  const estimatedStats = { ...left.estimatedStats };
  for (const stat of DOSSIER_STATS) {
    const prior = left.estimatedStats[stat];
    const next = right.estimatedStats[stat];
    estimatedStats[stat] =
      Number(next.confidence) > Number(prior.confidence) ||
      (Number(next.confidence) === Number(prior.confidence) &&
        next.evidence.length > prior.evidence.length)
        ? next
        : prior;
  }
  return normalizedDossierProfile({
    traits: dossierStrings(left.traits, right.traits),
    motivations: dossierStrings(left.motivations, right.motivations),
    fears: dossierStrings(left.fears, right.fears),
    capabilities: dossierStrings(left.capabilities, right.capabilities),
    history: dossierStrings(left.history, right.history),
    origins: dossierStrings(left.origins, right.origins),
    powers: dossierStrings(left.powers, right.powers),
    moralSystem: dossierStrings(left.moralSystem, right.moralSystem),
    physicalCharacteristics: dossierStrings(
      left.physicalCharacteristics,
      right.physicalCharacteristics,
    ),
    relationships: dossierStrings(
      left.relationships,
      right.relationships,
    ),
    relationshipWeb,
    knowledge: dossierStrings(left.knowledge, right.knowledge),
    secrets: dossierStrings(left.secrets, right.secrets),
    estimatedStats,
  });
}

function richerDossierText(previous: unknown, incoming: unknown, maximum: number) {
  const left = textBody(previous, maximum);
  const right = textBody(incoming, maximum);
  return right.length > left.length ? right : left;
}

const DOSSIER_FALSE_POSITIVES = new Set([
  "aye",
  "just",
  "maybe",
  "perhaps",
  "really",
  "still",
  "shit",
  "that",
  "then",
  "there",
  "this",
  "turned",
  "well",
  "yeah",
]);

function plausibleCharacterName(value: unknown) {
  const name = textBody(value, 240).trim();
  if (!name || DOSSIER_FALSE_POSITIVES.has(name.toLocaleLowerCase())) return false;
  if (/(?:'s|\u2019s)$/iu.test(name)) return false;
  return !/^(?:i|it|that|there|they|we|you|he|she|what|who|where|when|why|how)[\u2019'][a-z]+$/iu.test(
    name,
  );
}

export function dossierIsCustomerEdited(
  row: Record<string, unknown> | undefined,
): boolean {
  return Boolean(row?.user_edited_at);
}

export function serializeDossier(row: Record<string, unknown>) {
  const profile = normalizedDossierProfile(row.profile);
  const estimate = dossierAxis(row.axis_estimate);
  const override = row.axis_user_override
    ? dossierAxis(row.axis_user_override)
    : null;
  const evidence = Array.isArray(row.evidence) ? row.evidence as EvidenceReference[] : [];
  const rawSummary = textBody(row.summary, 4_000);
  const summary = !dossierIsCustomerEdited(row) && generatedEntityPresentationNeedsRefresh(rawSummary)
    ? localPublicEntitySummaryFromEvidence(
        "character",
        textBody(row.name, 240),
        evidence,
      ).summary
    : rawSummary;
  return {
    id: row.id,
    canonicalKey: row.canonical_key,
    canonicalCharacterId: row.canonical_character_id ?? null,
    name: row.name,
    aliases: Array.isArray(row.aliases) ? row.aliases : [],
    aliasAttributions: Array.isArray(row.alias_attributions)
      ? row.alias_attributions.flatMap((entry) => {
          const normalized = normalizeCharacterAliasAttribution(entry);
          return normalized ? [normalized] : [];
        })
      : [],
    role: row.role ?? "",
    summary,
    profile,
    evidence,
    confidence: Number(row.confidence ?? 0),
    // When a dossier is linked to the active Hold entity, the entity owns the
    // composite alias count. Identity repairs can add aliases after an older
    // dossier snapshot was written, so prefer that current aggregate whenever
    // the route supplied it instead of showing two different totals.
    mentionCount: Number(row.hold_mention_count ?? row.mention_count ?? 0),
    mentionSourceCount: Number(row.hold_mention_source_count ?? row.mention_source_count ?? 0),
    socioPoliticalAxis: override ?? estimate,
    socioPoliticalAxisEstimate: estimate,
    socioPoliticalAxisChanged: Boolean(row.axis_user_changed_at),
    socioPoliticalAxisChangedAt: row.axis_user_changed_at ?? null,
    userEditedAt: row.user_edited_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function selectLocalDossierEnrichmentCharacters(params: {
  findingsCharacters: CharacterFinding[];
  repairCharacters: CharacterFinding[];
  targetCharacterNames?: string[];
}): CharacterFinding[] {
  const targetedNames = new Set(
    (params.targetCharacterNames ?? [])
      .map((name) => name.trim().toLocaleLowerCase())
      .filter(Boolean),
  );
  const repairByName = new Map(
    params.repairCharacters.map((character) => [
      character.name.toLocaleLowerCase(),
      character,
    ]),
  );

  // Targeted maintenance is deliberately a deep-reader scope, not a world
  // scope. Structural identity/category repair has already run across the
  // world, and every non-target dossier is supplied separately as connection
  // context. Sending the old breakdown cast through here would make every
  // target repair rescan the corpus for every other character as well.
  if (targetedNames.size > 0) {
    const retained = new Set<string>();
    return params.repairCharacters.filter((character) => {
      const name = character.name.toLocaleLowerCase();
      // repairCharacters has already been scoped against the durable identity
      // surface set after identity repair. Do not exact-name filter it again:
      // `Alec` may now be `Alec Sumner`, and `Raider Dave` may now survive as
      // `David` even though neither canonical name equals the requested text.
      if (retained.has(name)) return false;
      retained.add(name);
      return true;
    });
  }

  // Normal intake has no explicit target scope and retains its existing
  // whole-cast behavior, replacing only rows selected for repair.
  const retainedNames = new Set<string>();
  const characters = params.findingsCharacters.map((character) => {
    const name = character.name.toLocaleLowerCase();
    const replacement = repairByName.get(name);
    if (!replacement) return character;
    retainedNames.add(name);
    return replacement;
  });
  for (const character of params.repairCharacters) {
    const name = character.name.toLocaleLowerCase();
    if (!retainedNames.has(name)) {
      characters.push(character);
      retainedNames.add(name);
    }
  }
  return characters;
}

export type LocalDossierMigrationPhase =
  | "identity_repair"
  | "global_profile_revalidation"
  | "target_assembly"
  | "relationship_projection"
  | "deterministic_enrichment"
  | "qwen_ready"
  | "qwen_synthesis";

export type LocalDossierMigrationPhaseEvent = {
  phase: LocalDossierMigrationPhase;
  status: "start" | "complete" | "ready";
  elapsedMs: number;
  totalElapsedMs: number;
  counts: Record<string, number>;
};

export async function migrateLocalDossierUnderstanding(
  db: StudioRootDb,
  worldId: string,
  editionId: string,
  options: {
    force?: boolean;
    maximumCharacters?: number;
    targetCharacterNames?: string[];
    localProjectionOnly?: boolean;
    repairIdentities?: boolean;
    rebuildConnections?: boolean;
    onProgress?: (completed: number, total: number, characterName: string) => void;
    // Phase observation is diagnostic-only. Async observers are allowed, but
    // are deliberately not awaited and cannot delay or fail the migration.
    onPhase?: (event: LocalDossierMigrationPhaseEvent) => void | Promise<void>;
  } = {},
) {
  const migrationStartedAt = Date.now();
  let targetIdentitySurfaces = (options.targetCharacterNames ?? [])
    .map((name) => name.trim())
    .filter(Boolean);
  const phaseStartedAt = new Map<LocalDossierMigrationPhase, number>();
  const reportPhase = (
    phase: LocalDossierMigrationPhase,
    status: LocalDossierMigrationPhaseEvent["status"],
    counts: Record<string, number> = {},
  ) => {
    const now = Date.now();
    if (status === "start") phaseStartedAt.set(phase, now);
    try {
      const observed = options.onPhase?.({
        phase,
        status,
        elapsedMs: status === "complete"
          ? Math.max(0, now - (phaseStartedAt.get(phase) ?? now))
          : 0,
        totalElapsedMs: Math.max(0, now - migrationStartedAt),
        counts,
      });
      if (observed && typeof observed.then === "function") {
        void observed.catch(() => undefined);
      }
    } catch {
      // Diagnostics must never turn a successful migration into a failed one.
    }
  };
  // Synchronize the persisted entity/dossier boundary before identity repair.
  // Identity repair intentionally considers characters only; if an older
  // scanner row still calls a POV character a place/ambiguous concept, aliases
  // and merges cannot be discovered until the two tables agree.
  const [boundaryEntityResult, boundaryDossierResult] = await Promise.all([
    db.query<Record<string, unknown>>(
      `SELECT * FROM storyhold.world_entities
        WHERE world_id = $1 AND canon_edition_id = $2
          AND classification_source = 'local'
          AND review_status <> 'user_confirmed'
          AND pull_status = 'active'`,
      [worldId, editionId],
    ),
    db.query<Record<string, unknown>>(
      `SELECT * FROM storyhold.character_dossiers
        WHERE world_id = $1 AND canon_edition_id = $2
          AND dossier_status IN ('active', 'suppressed')`,
      [worldId, editionId],
    ),
  ]);
  const boundary = adjudicatePersistedLocalEntityRows(
    boundaryEntityResult.rows,
    boundaryDossierResult.rows,
  );
  const boundaryPromotedEntityIds = new Set(boundary.updates
    .filter((update) => update.entityType === "character" && update.previousEntityType !== "character")
    .map((update) => update.id));
  for (const update of boundary.updates) {
    const linkedDossierId = await persistAdjudicatedLocalEntityUpdate(db, update);
    const ownsRequestedDossier = Boolean(update.dossierId) &&
      linkedDossierId === update.dossierId;
    if (update.activateDossier && ownsRequestedDossier && update.entityType === "character") {
      await db.query(
        `UPDATE storyhold.character_dossiers
            SET dossier_status = 'active', updated_at = now()
          WHERE id = $1 AND user_edited_at IS NULL`,
        [update.dossierId],
      );
    } else if (ownsRequestedDossier && update.entityType !== "character") {
      await db.query(
        `UPDATE storyhold.character_dossiers
            SET dossier_status = 'suppressed', updated_at = now()
          WHERE id = $1 AND user_edited_at IS NULL`,
        [update.dossierId],
      );
    }
  }
  const staleContextIds = boundary.rows
    .filter((row) => row.scanner_present === true)
    .filter((row) => !generatedLocalContextLeadShouldRemainVisible(row))
    .map((row) => textBody(row.id, 100))
    .filter(Boolean);
  if (staleContextIds.length) {
    await db.query(
      `UPDATE storyhold.world_entities
          SET scanner_present = false, updated_at = now()
        WHERE id = ANY($1::uuid[]) AND classification_source = 'local'
          AND COALESCE(review_status, 'candidate') <> 'user_confirmed'
          AND pull_status = 'active'`,
      [staleContextIds],
    );
    await db.query(
      `UPDATE storyhold.character_dossiers dossier
          SET dossier_status = 'suppressed', updated_at = now()
        WHERE dossier.user_edited_at IS NULL AND EXISTS (
          SELECT 1 FROM storyhold.world_entities entity
           WHERE entity.dossier_id = dossier.id AND entity.id = ANY($1::uuid[])
        )`,
      [staleContextIds],
    );
  }
  if (options.repairIdentities !== false) {
    reportPhase("identity_repair", "start", {
      requestedTargets: options.targetCharacterNames?.length ?? 0,
    });
    const identityRepair = await repairGeneratedCharacterIdentities({
      db,
      worldId,
      editionId,
      targetCharacterNames: options.targetCharacterNames,
    });
    if (targetIdentitySurfaces.length > 0) {
      targetIdentitySurfaces = identityRepair.targetIdentitySurfaces.length > 0
        ? identityRepair.targetIdentitySurfaces
        : targetIdentitySurfaces;
    }
    reportPhase("identity_repair", "complete", {
      requestedTargets: options.targetCharacterNames?.length ?? 0,
      resolvedTargetSurfaces: targetIdentitySurfaces.length,
    });
  }
  const [
    runResult,
    dossierResult,
    contextDossierResult,
    generatedLinkedDossierResult,
    breakdownResult,
    chunkResult,
    chapterResult,
    candidateResult,
  ] = await Promise.all([
    db.query<Record<string, unknown>>(
      `SELECT id, local_checkpoint
         FROM storyhold.world_analysis_runs
        WHERE world_id = $1 AND canon_edition_id = $2
          AND analysis_kind = 'local_scan' AND status = 'completed'
        ORDER BY completed_at DESC NULLS LAST, created_at DESC
        LIMIT 1`,
      [worldId, editionId],
    ),
    db.query<Record<string, unknown>>(
      `SELECT dossier.*
         FROM storyhold.character_dossiers dossier
         LEFT JOIN storyhold.world_analysis_runs run
           ON run.id = dossier.source_analysis_run_id
        WHERE dossier.world_id = $1 AND dossier.canon_edition_id = $2
          AND dossier.dossier_status IN ('active', 'suppressed') AND dossier.user_edited_at IS NULL
          AND COALESCE(run.analysis_kind, 'local_scan') = 'local_scan'
          AND EXISTS (
            SELECT 1 FROM storyhold.world_entities entity
             WHERE entity.dossier_id = dossier.id
               AND entity.world_id = $1 AND entity.canon_edition_id = $2
               AND entity.entity_type = 'character' AND entity.pull_status = 'active'
               AND entity.scanner_present = true
          )`,
      [worldId, editionId],
    ),
    db.query<Record<string, unknown>>(
      `SELECT dossier.*
         FROM storyhold.character_dossiers dossier
        WHERE dossier.world_id = $1 AND dossier.canon_edition_id = $2
          AND dossier.dossier_status IN ('active', 'suppressed')
          AND EXISTS (
            SELECT 1
              FROM storyhold.world_entities entity
             WHERE entity.dossier_id = dossier.id
               AND entity.world_id = $1 AND entity.canon_edition_id = $2
               AND entity.pull_status = 'active'
               AND entity.entity_type = 'character'
               AND (
                 entity.scanner_present = true OR
                 entity.classification_source = 'user' OR
                 entity.review_status = 'user_confirmed'
               )
          )
        ORDER BY dossier.mention_count DESC, dossier.name ASC`,
      [worldId, editionId],
    ),
    // Generated dossiers remain useful as evidence-bearing profiles even when
    // their linked concept was later repaired from character to species,
    // place, or another category. Include those suppressed/non-character rows
    // in a separate cleanup set; they must not be fed into CharacterFinding's
    // character-only connection context.
    db.query<Record<string, unknown>>(
      `SELECT dossier.*,
              (SELECT entity.entity_type
                 FROM storyhold.world_entities entity
                WHERE entity.dossier_id = dossier.id
                  AND entity.world_id = $1 AND entity.canon_edition_id = $2
                  AND entity.pull_status = 'active'
                ORDER BY entity.scanner_present DESC, entity.updated_at DESC
                LIMIT 1) AS linked_entity_type
         FROM storyhold.character_dossiers dossier
        WHERE dossier.world_id = $1 AND dossier.canon_edition_id = $2
          AND dossier.dossier_status IN ('active', 'suppressed')
          AND dossier.user_edited_at IS NULL
          AND EXISTS (
            SELECT 1
              FROM storyhold.world_entities entity
             WHERE entity.dossier_id = dossier.id
               AND entity.world_id = $1 AND entity.canon_edition_id = $2
               AND entity.pull_status = 'active'
               AND entity.classification_source = 'local'
               AND COALESCE(entity.review_status, 'candidate') <> 'user_confirmed'
          )
        ORDER BY dossier.mention_count DESC, dossier.name ASC`,
      [worldId, editionId],
    ),
    db.query<Record<string, unknown>>(
      `SELECT * FROM storyhold.world_breakdowns
        WHERE world_id = $1 AND canon_edition_id = $2
        ORDER BY version DESC LIMIT 1`,
      [worldId, editionId],
    ),
    db.query<Record<string, unknown>>(
      `SELECT chunk.id, chunk.source_id, source.title AS source_title,
              chunk.chunk_index, chunk.content, chunk.metadata
         FROM storyhold.world_source_chunks chunk
         JOIN storyhold.world_sources source ON source.id = chunk.source_id
        WHERE chunk.world_id = $1 AND chunk.canon_edition_id = $2
          AND source.processing_status = 'ready'
          AND source.canon_status IN ('candidate', 'canon')
        ORDER BY source.chronology_order, source.sort_order, chunk.chunk_index`,
      [worldId, editionId],
    ),
    db.query<Record<string, unknown>>(
      `SELECT chapter.*, source.title AS source_title
         FROM storyhold.world_chapter_summaries chapter
         JOIN storyhold.world_sources source ON source.id = chapter.source_id
        WHERE chapter.world_id = $1 AND chapter.canon_edition_id = $2
        ORDER BY source.chronology_order, source.sort_order, chapter.source_order`,
      [worldId, editionId],
    ),
    db.query<Record<string, unknown>>(
      `SELECT * FROM storyhold.world_entities
        WHERE world_id = $1 AND canon_edition_id = $2
        ORDER BY mention_count DESC, name ASC`,
      [worldId, editionId],
    ),
  ]);
  // A dossier replay must adjudicate the current scanner row before it
  // restores categories from that row. Otherwise the first replay writes the
  // corrected evidence into memory but still synthesizes relationships from
  // yesterday's category, requiring a second replay to become correct.
  const adjudicatedCandidates = adjudicatePersistedLocalEntityRows(
    candidateResult.rows,
    [...dossierResult.rows, ...contextDossierResult.rows],
  );
  for (const update of adjudicatedCandidates.updates) {
    await persistAdjudicatedLocalEntityUpdate(db, update);
  }
  const candidateRows = adjudicatedCandidates.rows;
  const checkpoint = recordBody(runResult.rows[0]?.local_checkpoint);
  const gliner2 = recordBody(checkpoint.gliner2);
  const signals = Array.isArray(gliner2.signals)
    ? gliner2.signals as LocalStorySignal[]
    : [];
  const targetedCharacterNames = new Set(
    targetIdentitySurfaces.map((name) => name.trim().toLocaleLowerCase()).filter(Boolean),
  );
  const rowMatchesTargetIdentity = (row: Record<string, unknown>) => {
    if (targetedCharacterNames.size === 0) return true;
    return [textBody(row.name, 240), ...stringList(row.aliases, 80, 240)]
      .some((surface) => targetedCharacterNames.has(surface.toLocaleLowerCase()));
  };
  const repairable = dossierResult.rows.filter((row) => {
    if (!rowMatchesTargetIdentity(row)) return false;
    if (options.force || options.localProjectionOnly) return true;
    const role = textBody(row.role, 240).toLocaleLowerCase();
    const profile = normalizedDossierProfile(row.profile);
    const establishedCount = [
      profile.traits, profile.motivations, profile.fears, profile.capabilities,
      profile.history, profile.origins, profile.powers, profile.moralSystem,
      profile.physicalCharacteristics, profile.knowledge, profile.secrets,
    ].reduce((sum, values) => sum + values.length, 0);
    return establishedCount === 0 ||
      textBody(recordBody(row.axis_estimate).rationale, 1_000).includes("No political estimate was requested") ||
      textBody(row.summary, 4_000).startsWith("Across the imported manuscript") ||
      textBody(row.summary, 4_000).startsWith("The manuscript directly attributes") ||
      textBody(row.summary, 4_000).includes("Storyhold connects") || [
      "detected character candidate",
      "locally detected character candidate",
      "unreviewed character or named-entity candidate",
      "character under review",
    ].includes(role);
  });
  const promotedEntityIds = new Set(adjudicatedCandidates.updates
    .filter((update) => update.entityType === "character")
    .map((update) => update.id));
  for (const id of boundaryPromotedEntityIds) promotedEntityIds.add(id);
  const repairableNames = new Set(repairable.map((row) =>
    textBody(row.name, 240).toLocaleLowerCase()
  ));
  const promotedEntities = candidateRows.filter((row) => {
    const name = textBody(row.name, 240);
    return (
      promotedEntityIds.has(textBody(row.id, 100)) &&
      persistedLocalEntityIsConnectionEligible(row) &&
      textBody(row.entity_type, 40) === "character" &&
      !repairableNames.has(name.toLocaleLowerCase()) &&
      rowMatchesTargetIdentity(row)
    );
  });
  let findings = findingsFromBreakdown(breakdownResult.rows[0]);
  if (!findings) return;
  findings = restorePersistedLocalEntityCategories(findings, candidateRows);

  // Revalidate every generated linked dossier, including suppressed rows whose
  // linked entity is no longer a character. This deterministic pass is cheap,
  // uses the current category graph, and never includes customer-edited rows.
  // It prevents an old local snapshot from preserving false species bonds or
  // category-derived labels merely because that dossier was not selected for
  // today's Qwen synthesis.
  reportPhase("global_profile_revalidation", "start", {
    generatedProfiles: generatedLinkedDossierResult.rows.length,
    connectionCharacters: contextDossierResult.rows.length,
  });
  const generatedLinkedProfiles = generatedLinkedDossierResult.rows.map((row) => ({
    dossierId: textBody(row.id, 100),
    linkedEntityType: textBody(row.linked_entity_type, 80),
    finding: generatedDossierFinding(row),
    source: row,
  })).filter((entry) => entry.dossierId && entry.finding.name);
  const globalConnectionCharacters = contextDossierResult.rows.map(generatedDossierFinding);
  const globallyRevalidated = revalidateGeneratedLocalDossierProfiles({
    findings,
    profiles: generatedLinkedProfiles.map(({ linkedEntityType, finding }) => ({
      linkedEntityType,
      finding,
    })),
    connectionCharacters: globalConnectionCharacters,
  });
  const globallyRevalidatedByDossierId = new Map<string, CharacterFinding>();
  const revalidatedProfilesToPersist: Array<{
    dossierId: string;
    finding: CharacterFinding;
  }> = [];
  for (let index = 0; index < generatedLinkedProfiles.length; index += 1) {
    const stored = generatedLinkedProfiles[index]!;
    const finding = globallyRevalidated[index];
    if (!finding) continue;
    globallyRevalidatedByDossierId.set(stored.dossierId, finding);
    revalidatedProfilesToPersist.push({
      dossierId: stored.dossierId,
      finding,
    });
  }
  await persistRevalidatedGeneratedDossierProfiles(db, revalidatedProfilesToPersist);
  reportPhase("global_profile_revalidation", "complete", {
    generatedProfiles: generatedLinkedProfiles.length,
    persistedProfiles: globallyRevalidatedByDossierId.size,
    connectionCharacters: globalConnectionCharacters.length,
  });

  if (repairable.length === 0 && promotedEntities.length === 0) return;
  reportPhase("target_assembly", "start", {
    requestedTargets: targetedCharacterNames.size,
    repairableDossiers: repairable.length,
    promotedCharacters: promotedEntities.length,
  });
  findings.chapterSummaries = chapterResult.rows.map((row) => ({
    sourceId: String(row.source_id),
    sourceTitle: textBody(row.source_title, 500),
    chapterKey: textBody(row.canonical_key, 500),
    chapterTitle: textBody(row.chapter_title, 500),
    perspective: textBody(row.perspective, 240),
    sourceOrder: Number(row.source_order ?? 0),
    summary: textBody(row.summary, 4_000),
    majorEvents: stringList(row.major_events, 20, 1_000),
    evidence: storedEvidence(row.evidence),
    confidence: Number(row.confidence ?? 0),
    reviewStatus: row.summary_source === "ai" || row.summary_source === "user"
      ? "verified"
      : "candidate",
  }));
  const repairCharacters = repairable.map((row): CharacterFinding => {
    // `dossierResult` was read before the world-wide relationship cleanup.
    // Starting the targeted Qwen repair from that stale row immediately
    // overwrote any form Power/web the cleanup had just persisted. Carry the
    // in-memory revalidated finding across the persistence boundary instead;
    // the database write above and the targeted synthesis now share one
    // canonical input snapshot.
    const revalidated = globallyRevalidatedByDossierId.get(textBody(row.id, 100)) ??
      generatedDossierFinding(row);
    const originalSummary = textBody(row.summary, 4_000);
    const generatedSummary = revalidated.summary;
    const generatedAxis = recordBody(row.axis_estimate);
    // `force` means "run this maintenance synthesis again". It must not mean
    // "discard the evidence-grounded dossier first"; doing that allowed a
    // shorter Qwen response to erase defining facts the deterministic reader
    // had already established. Only genuinely legacy presentation language is
    // replaced wholesale.
    const legacyNarrativeProjection = originalSummary.startsWith("Across the imported manuscript") ||
      originalSummary.startsWith("The manuscript directly attributes") ||
      originalSummary.includes("Storyhold connects");
    const legacyAxisProjection = textBody(generatedAxis.rationale, 1_000)
      .includes("No political estimate was requested");
    const staleSummary = generatedEntityPresentationNeedsRefresh(originalSummary);
    // Legacy presentation language invalidates the prose, not the evidence-
    // validated structured record. The world-wide revalidator above has
    // already removed unsupported relationships and derived claims. Clearing
    // every array here erased its grounded Powers/web/history immediately
    // before Qwen and forced a later pass to rediscover facts it had just
    // proved.
    const retained = <T>(values: T[]): T[] => values;
    return {
      name: revalidated.name || textBody(row.name, 240),
      aliases: revalidated.aliases,
      role: revalidated.role,
      summary: legacyNarrativeProjection || staleSummary ? "" : generatedSummary,
      traits: retained(revalidated.traits),
      motivations: retained(revalidated.motivations),
      fears: retained(revalidated.fears),
      capabilities: retained(revalidated.capabilities),
      history: retained(revalidated.history),
      origins: retained(revalidated.origins),
      powers: retained(revalidated.powers),
      moralSystem: retained(revalidated.moralSystem),
      physicalCharacteristics: retained(revalidated.physicalCharacteristics),
      relationships: retained(revalidated.relationships),
      relationshipWeb: retained(revalidated.relationshipWeb),
      estimatedStats: revalidated.estimatedStats,
      socioPoliticalAxis: legacyAxisProjection ? {
        economic: 0,
        authority: 0,
        label: "Undetermined",
        rationale: "Insufficient evidence for a confident political estimate.",
        confidence: 0.05,
      } : dossierAxis(row.axis_estimate),
      knowledge: retained(revalidated.knowledge),
      secrets: retained(revalidated.secrets),
      factionMemberships: [],
      evidence: revalidated.evidence,
      confidence: revalidated.confidence,
      mentionCount: revalidated.mentionCount,
      mentionSourceCount: revalidated.mentionSourceCount,
      reviewStatus: "candidate",
    };
  });
  for (const row of promotedEntities) {
    const profile = normalizedDossierProfile({});
    repairCharacters.push({
      name: textBody(row.name, 240),
      aliases: stringList(row.aliases, 40, 240),
      role: "Character Under Review",
      summary: "",
      traits: [], motivations: [], fears: [], capabilities: [], history: [], origins: [], powers: [],
      moralSystem: [], physicalCharacteristics: [], relationships: [], relationshipWeb: [],
      estimatedStats: profile.estimatedStats as CharacterFinding["estimatedStats"],
      socioPoliticalAxis: dossierAxis({}),
      knowledge: [], secrets: [], factionMemberships: [],
      evidence: storedEvidence(row.evidence),
      confidence: Math.max(0.72, Number(row.confidence ?? 0)),
      mentionCount: Number(row.mention_count ?? 0),
      mentionSourceCount: Number(row.mention_source_count ?? 0),
      reviewStatus: "candidate",
    });
  }
  const repairByName = new Map(
    repairCharacters.map((character) => [character.name.toLocaleLowerCase(), character]),
  );
  const connectionCharacterContext = options.rebuildConnections === false
    ? []
    : contextDossierResult.rows
    .filter((row) => !repairByName.has(textBody(row.name, 240).toLocaleLowerCase()))
    .map((row): CharacterFinding => {
      const profile = normalizedDossierProfile(row.profile);
      return {
        name: textBody(row.name, 240),
        aliases: stringList(row.aliases, 40, 240),
        role: textBody(row.role, 240),
        summary: textBody(row.summary, 4_000),
        traits: profile.traits,
        motivations: profile.motivations,
        fears: profile.fears,
        capabilities: profile.capabilities,
        history: profile.history,
        origins: profile.origins,
        powers: profile.powers,
        moralSystem: profile.moralSystem,
        physicalCharacteristics: profile.physicalCharacteristics,
        relationships: profile.relationships,
        relationshipWeb: profile.relationshipWeb as CharacterFinding["relationshipWeb"],
        estimatedStats: profile.estimatedStats as CharacterFinding["estimatedStats"],
        socioPoliticalAxis: dossierAxis(row.axis_estimate),
        knowledge: profile.knowledge,
        secrets: profile.secrets,
        factionMemberships: [],
        evidence: storedEvidence(row.evidence),
        confidence: Number(row.confidence ?? 0),
        mentionCount: Number(row.mention_count ?? 0),
        mentionSourceCount: Number(row.mention_source_count ?? 0),
        reviewStatus: "candidate",
      };
    });
  findings.characters = selectLocalDossierEnrichmentCharacters({
    findingsCharacters: findings.characters,
    repairCharacters,
    targetCharacterNames: targetIdentitySurfaces,
  });
  const promotedNames = new Set(promotedEntities.map((row) => textBody(row.name, 240).toLocaleLowerCase()));
  findings.technologies = findings.technologies.filter((row) => !promotedNames.has(row.name.toLocaleLowerCase()));
  findings.devices = findings.devices.filter((row) => !promotedNames.has(row.name.toLocaleLowerCase()));
  findings.creatures = findings.creatures.filter((row) => !promotedNames.has(row.name.toLocaleLowerCase()));
  findings.species = findings.species.filter((row) => !promotedNames.has(row.name.toLocaleLowerCase()));
  findings.powers = findings.powers.filter((row) => !promotedNames.has(row.name.toLocaleLowerCase()));
  findings.ambiguous = findings.ambiguous.filter((row) => !promotedNames.has(row.name.toLocaleLowerCase()));
  findings = removeRetiredLocalEntityRelationships(findings, candidateRows);
  const chunks: AnalysisChunk[] = chunkResult.rows.map((row) => ({
    id: String(row.id),
    sourceId: String(row.source_id),
    sourceTitle: String(row.source_title),
    index: Number(row.chunk_index),
    content: String(row.content),
    sectionTitle: textBody(recordBody(row.metadata).sectionTitle, 240) || null,
  }));
  reportPhase("target_assembly", "complete", {
    requestedTargets: targetedCharacterNames.size,
    deterministicCharacters: findings.characters.length,
    connectionCharacters: connectionCharacterContext.length,
    chunks: chunks.length,
    signals: signals.length,
  });
  reportPhase("relationship_projection", "start", {
    deterministicCharacters: findings.characters.length,
    connectionCharacters: connectionCharacterContext.length,
  });
  const checkpointAcceptedRelations = checkpoint.acceptedRelations;
  const normalizedCheckpointRelations = Array.isArray(checkpointAcceptedRelations)
    ? normalizeLocalRelationshipMentions(
        {
          ...findings,
          characters: [...findings.characters, ...connectionCharacterContext],
        },
        checkpointAcceptedRelations as NonNullable<Parameters<typeof enrichLocalCharacterFindings>[3]>,
      )
    : [];
  findings = normalizeLocalDossierRelationshipProjection(
    findings,
    normalizedCheckpointRelations,
    connectionCharacterContext,
  );
  const aliasesForRelationName = (name: string) => {
    const normalized = name.toLocaleLowerCase();
    const character = [...findings.characters, ...connectionCharacterContext].find((candidate) =>
      candidate.name.toLocaleLowerCase() === normalized ||
      candidate.aliases.some((alias) => alias.toLocaleLowerCase() === normalized)
    );
    return [...new Set([name, character?.name ?? "", ...(character?.aliases ?? [])]
      .map((value) => value.trim()).filter(Boolean))].slice(0, 40);
  };
  const acceptedRelations = options.rebuildConnections !== false
    ? normalizedCheckpointRelations
      .filter((relation) => aliasesForRelationName(relation.subject).some((subject) =>
        aliasesForRelationName(relation.target).some((target) =>
          relationHasDirectPredicateSupport({ ...relation, subject, target })
        )
      ))
    : [];
  reportPhase("relationship_projection", "complete", {
    normalizedRelations: normalizedCheckpointRelations.length,
    acceptedRelations: acceptedRelations.length,
    deterministicCharacters: findings.characters.length,
    connectionCharacters: connectionCharacterContext.length,
  });
  reportPhase("deterministic_enrichment", "start", {
    deterministicCharacters: findings.characters.length,
    connectionCharacters: connectionCharacterContext.length,
    chunks: chunks.length,
    signals: signals.length,
    acceptedRelations: acceptedRelations.length,
  });
  let deterministicBatchCount = 0;
  const locallyEnriched = enrichLocalDossierProjection({
    findings,
    signals,
    chunks,
    acceptedRelations,
    connectionCharacters: connectionCharacterContext,
    rebuildConnections: options.rebuildConnections,
    onDeterministicBatch: () => {
      deterministicBatchCount += 1;
    },
  });
  reportPhase("deterministic_enrichment", "complete", {
    deterministicCharacters: locallyEnriched.characters.length,
    connectionCharacters: connectionCharacterContext.length,
    deterministicBatches: deterministicBatchCount,
    chunks: chunks.length,
  });
  if (!options.localProjectionOnly) {
    reportPhase("qwen_ready", "ready", {
      deterministicCharacters: locallyEnriched.characters.length,
      requestedTargets: targetedCharacterNames.size,
      chunks: chunks.length,
      signals: signals.length,
    });
  }
  let synthesized = locallyEnriched;
  if (!options.localProjectionOnly) {
    reportPhase("qwen_synthesis", "start", {
      deterministicCharacters: locallyEnriched.characters.length,
      requestedTargets: targetedCharacterNames.size,
      chunks: chunks.length,
      signals: signals.length,
    });
    synthesized = (await enrichPrincipalCharactersWithLocalQwen({
        findings: locallyEnriched,
        chunks,
        signals,
        maximumCharacters: options.maximumCharacters,
        // `locallyEnriched.characters` is already the authoritative target
        // scope. Re-filtering here by the original text can drop a canonical
        // survivor when identity repair is intentionally disabled and the
        // request used one of its stored aliases (for example, Buzz -> Alec
        // Sumner). Qwen may rank within this array, but it must not reinterpret
        // or widen/narrow the migration scope.
        onProgress: (completed, total, characters) => {
          options.onProgress?.(completed, total, characters.at(-1)?.name ?? "Character");
        },
      })).findings;
    reportPhase("qwen_synthesis", "complete", {
      synthesizedCharacters: synthesized.characters.length,
      requestedTargets: targetedCharacterNames.size,
      chunks: chunks.length,
      signals: signals.length,
    });
  }
  // Dossier-only migration starts from persisted profile JSON and Qwen may add
  // a later proposal. Revalidate the final structured web at the one boundary
  // immediately before it is serialized back to either dossier or overview.
  const enriched = removeRetiredLocalEntityRelationships(
    normalizeLocalDossierRelationshipProjection(
      synthesized,
      acceptedRelations,
      connectionCharacterContext,
    ),
    candidateRows,
  );
  for (const finding of enriched.characters) {
    const source = repairable.find((row) =>
      textBody(row.name, 240).toLocaleLowerCase() === finding.name.toLocaleLowerCase(),
    );
    if (!source) {
      const promoted = promotedEntities.find((row) =>
        textBody(row.name, 240).toLocaleLowerCase() === finding.name.toLocaleLowerCase(),
      );
      if (!promoted) continue;
      await saveCharacterDossier(db, {
        worldId,
        editionId,
        runId: textBody(runResult.rows[0]?.id, 80),
        analysisKind: "local_scan",
        replaceGeneratedSnapshot: true,
        finding,
      });
      const dossier = await db.query<{ id: string }>(
        `SELECT id FROM storyhold.character_dossiers
          WHERE world_id = $1 AND canon_edition_id = $2 AND normalized_name = $3
          LIMIT 1`,
        [worldId, editionId, finding.name.toLocaleLowerCase()],
      );
      if (dossier.rows[0]?.id) {
        await db.query(
          `UPDATE storyhold.character_dossiers
              SET dossier_status = 'active', updated_at = now()
            WHERE id = $1 AND user_edited_at IS NULL`,
          [dossier.rows[0].id],
        );
        await db.query(
          `UPDATE storyhold.world_entities
              SET dossier_id = $2, entity_type = 'character',
                  aliases = $3::jsonb, summary = $4, details = $5::jsonb,
                  relationships = $6::jsonb,
                  confidence = GREATEST(confidence, $7), updated_at = now()
            WHERE id = $1 AND classification_source = 'local'`,
          [
            promoted.id,
            dossier.rows[0].id,
            json(finding.aliases),
            finding.summary,
            json(finding.capabilities),
            json(finding.relationships),
            finding.confidence,
          ],
        );
      }
      continue;
    }
    // Qualified compass metadata must survive ordinary narrative maintenance.
    // This retention guard grants no evidence status; that still needs its receipt.
    await db.query(
      `UPDATE storyhold.character_dossiers
          SET aliases = $2::jsonb, role = $3, summary = $4, profile = $5::jsonb,
              evidence = $6::jsonb, confidence = GREATEST(confidence, $7),
              axis_estimate = CASE WHEN axis_estimate ? 'perspective' THEN axis_estimate ELSE $8::jsonb END,
              mention_count = COALESCE((
                SELECT MAX(entity.mention_count)
                  FROM storyhold.world_entities entity
                 WHERE entity.world_id = $9 AND entity.canon_edition_id = $10
                   AND entity.normalized_name = $11
                   AND entity.classification_source = 'local'
                   AND entity.pull_status <> 'deleted'
              ), mention_count),
              mention_source_count = COALESCE((
                SELECT MAX(entity.mention_source_count)
                  FROM storyhold.world_entities entity
                 WHERE entity.world_id = $9 AND entity.canon_edition_id = $10
                   AND entity.normalized_name = $11
                   AND entity.classification_source = 'local'
                   AND entity.pull_status <> 'deleted'
              ), mention_source_count),
              updated_at = now()
        WHERE id = $1 AND user_edited_at IS NULL`,
      [
        source.id,
        json(finding.aliases),
        finding.role,
        finding.summary,
        json(profileFromCharacterFinding(finding)),
        json(finding.evidence),
        finding.confidence,
        json(finding.socioPoliticalAxis),
        worldId,
        editionId,
        textBody(source.normalized_name, 240),
      ],
    );
    // Keep the world overview and the full dossier on the same customer-facing
    // portrait. Previously only newly promoted rows were synchronized, so an
    // ordinary local dossier repair could succeed while the overview kept old
    // extraction or cultural-reference prose.
    await db.query(
      `UPDATE storyhold.world_entities
          SET aliases = $4::jsonb, dossier_id = $5, summary = $6, details = $7::jsonb,
              relationships = $8::jsonb,
              confidence = GREATEST(confidence, $9), updated_at = now()
        WHERE world_id = $1 AND canon_edition_id = $2
          AND normalized_name = $3 AND entity_type = 'character'
          AND classification_source = 'local'
          AND review_status <> 'user_confirmed'`,
      [
        worldId,
        editionId,
        textBody(source.normalized_name, 240),
        json(finding.aliases),
        source.id,
        finding.summary,
        json(finding.capabilities),
        json(finding.relationships),
        finding.confidence,
      ],
    );
    const promoted = promotedEntities.find((row) =>
      textBody(row.name, 240).toLocaleLowerCase() === finding.name.toLocaleLowerCase(),
    );
    if (promoted) {
      await db.query(
        `UPDATE storyhold.character_dossiers
            SET dossier_status = 'active', updated_at = now()
          WHERE id = $1 AND user_edited_at IS NULL`,
        [source.id],
      );
      await db.query(
        `UPDATE storyhold.world_entities
            SET dossier_id = $2, entity_type = 'character',
                aliases = $3::jsonb, summary = $4, details = $5::jsonb,
                relationships = $6::jsonb,
                confidence = GREATEST(confidence, $7), updated_at = now()
          WHERE id = $1 AND classification_source = 'local'`,
        [
          promoted.id,
          source.id,
          json(finding.aliases),
          finding.summary,
          json(finding.capabilities),
          json(finding.relationships),
          finding.confidence,
        ],
      );
    }
  }

  // A dossier migration deliberately avoids the full world snapshot writer:
  // that path retires and recreates generated cards outside this repair's
  // target scope. The final targeted graph can nevertheless discover a new,
  // durable structural edge (for example, Michael manifests as Thrall). Save
  // only those evidence-grounded, target-incident edges against entities that
  // already exist. This is additive/upsert-only and a conflicting owner row
  // remains untouched at the database boundary.
  const relationPersistence = await persistEvidenceGroundedMigrationEntityRelations({
    db,
    worldId,
    editionId,
    targetCharacters: enriched.characters,
    relations: enriched.entityRelations,
  });

  // Global profile revalidation happens before the targeted reader. When the
  // targeted reader is the stage that first proves a form relationship, its
  // non-character endpoint has already crossed that earlier boundary. Refresh
  // only the generated endpoint dossiers actually touched by the newly
  // stabilized target graph so the creature receives the reciprocal
  // `Manifested By` projection without resnapshotting unrelated concepts.
  const impactedNonCharacterProfiles = generatedLinkedProfiles.filter((entry) =>
    relationPersistence.impactedNonCharacterDossierIds.has(entry.dossierId)
  );
  if (impactedNonCharacterProfiles.length > 0) {
    const characterProfileCount = enriched.characters.length;
    const refreshedProfiles = revalidateGeneratedLocalDossierProfiles({
      findings: enriched,
      profiles: [
        ...enriched.characters.map((finding) => ({
          linkedEntityType: "character",
          finding,
        })),
        ...impactedNonCharacterProfiles.map((entry) => ({
          linkedEntityType: entry.linkedEntityType,
          finding: globallyRevalidatedByDossierId.get(entry.dossierId) ?? entry.finding,
        })),
      ],
      connectionCharacters: connectionCharacterContext,
    });
    await persistRevalidatedGeneratedDossierProfiles(
      db,
      impactedNonCharacterProfiles.flatMap((entry, index) => {
        const finding = refreshedProfiles[characterProfileCount + index];
        return finding ? [{ dossierId: entry.dossierId, finding }] : [];
      }),
    );
  }
}

/**
 * A startup presentation repair only needs to replace stale customer-facing
 * prose. Re-running identity discovery and the all-character relationship web
 * for that job turns a small repair into a manuscript-wide quadratic scan.
 * Process one target at a time without connection candidates, then restore the
 * already-saved profile. Normal intake and explicit migrations keep the full
 * enrichment path by default.
 */
function generatedSelfIdentificationProjection(value: string, characterName: string): boolean {
  const escapedName = characterName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `^${escapedName}\\s+identifies\\s+(?:himself|herself|themself|themselves)\\s+as\\b`,
    "iu",
  ).test(value.normalize("NFKC").replace(/\s+/gu, " ").trim());
}

function withoutGeneratedSelfIdentificationProjection(character: CharacterFinding): CharacterFinding {
  const summary = character.summary
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !generatedSelfIdentificationProjection(sentence, character.name))
    .join(" ");
  return {
    ...character,
    summary,
    history: character.history.filter((entry) => !generatedSelfIdentificationProjection(entry, character.name)),
    origins: character.origins.filter((entry) => !generatedSelfIdentificationProjection(entry, character.name)),
  };
}

export function enrichLocalDossierProjection(params: {
  findings: WorldFindings;
  signals: LocalStorySignal[];
  chunks: AnalysisChunk[];
  acceptedRelations?: NonNullable<Parameters<typeof enrichLocalCharacterFindings>[3]>;
  connectionCharacters?: CharacterFinding[];
  rebuildConnections?: boolean;
  onDeterministicBatch?: (batch: {
    characterNames: string[];
    connectionCharacterNames: string[];
  }) => void;
}): WorldFindings {
  // These migrations operate only on generated dossiers. Sanitize their saved
  // projection before deterministic enrichment so a forced rerun cannot use
  // yesterday's incidental scene fragments as trusted input and then restore
  // them after the manuscript reader has done better work.
  const sanitizedFindings: WorldFindings = {
    ...params.findings,
    characters: params.findings.characters.map((character) => {
      // This projection is called only for generated dossier rows (the
      // migration query explicitly excludes user_edited_at). Rebuild our own
      // deterministic self-identification sentence from the current manuscript
      // instead of allowing an older, over-broad title window to survive every
      // forced replay. Owner prose never enters this reset path.
      const reset = withoutGeneratedSelfIdentificationProjection(character);
      const sanitized = guardLocalQwenDossierProjection(reset, reset);
      // An empty generated summary is a signal for deterministic synthesis,
      // not a reason to seed that synthesis with the guard's emergency UI
      // fallback sentence.
      return reset.summary.trim() ? sanitized : { ...sanitized, summary: "" };
    }),
  };
  const findings = normalizeLocalDossierRelationshipProjection(
    sanitizedFindings,
    params.acceptedRelations ?? [],
    params.connectionCharacters ?? [],
  );
  if (params.rebuildConnections !== false) {
    params.onDeterministicBatch?.({
      characterNames: findings.characters.map((character) => character.name),
      connectionCharacterNames: (params.connectionCharacters ?? [])
        .map((character) => character.name),
    });
    const enriched = enrichLocalCharacterFindings(
      findings,
      params.signals,
      params.chunks,
      params.acceptedRelations ?? [],
      params.connectionCharacters ?? [],
    );
    return {
      ...enriched,
      characters: enriched.characters.map((character) =>
        guardLocalQwenDossierProjection(character, character)
      ),
    };
  }

  const characters = findings.characters.map((character) => {
    params.onDeterministicBatch?.({
      characterNames: [character.name],
      connectionCharacterNames: [],
    });
    const projected = enrichLocalCharacterFindings(
      {
        ...findings,
        characters: [character],
        locations: [],
        factions: [],
        institutions: [],
        governments: [],
        powerStructures: [],
        creatures: [],
        species: [],
        technologies: [],
        vehicles: [],
        devices: [],
        weapons: [],
        powers: [],
        titles: [],
        ambiguous: [],
        entityRelations: [],
      },
      params.signals,
      params.chunks,
      [],
      [],
    ).characters[0] ?? character;

    const restored = {
      ...projected,
      traits: character.traits,
      motivations: character.motivations,
      fears: character.fears,
      capabilities: character.capabilities,
      // Projection-only maintenance preserves established profile fields, but
      // this one deterministic field was deliberately reset above. Carry the
      // freshly speaker-bound replacement back into history rather than either
      // restoring the stale title or dropping the identity history entirely.
      history: [...new Set([
        ...projected.history.filter((entry) =>
          generatedSelfIdentificationProjection(entry, projected.name)
        ),
        ...character.history,
      ])].slice(0, 16),
      origins: character.origins,
      powers: character.powers,
      moralSystem: character.moralSystem,
      physicalCharacteristics: character.physicalCharacteristics,
      relationships: character.relationships,
      relationshipWeb: character.relationshipWeb,
      estimatedStats: character.estimatedStats,
      socioPoliticalAxis: character.socioPoliticalAxis,
      knowledge: character.knowledge,
      secrets: character.secrets,
      factionMemberships: character.factionMemberships,
    };
    // Projection-only mode deliberately keeps the established profile, but it
    // must keep the sanitized profile—not the stale generated strings that
    // prompted this repair. The refreshed summary still comes from the
    // deterministic manuscript projection above.
    return guardLocalQwenDossierProjection(restored, restored);
  });

  return { ...findings, characters };
}

function profileFromCharacterFinding(finding: CharacterFinding) {
  return normalizedDossierProfile({
    traits: finding.traits,
    motivations: finding.motivations,
    fears: finding.fears,
    capabilities: finding.capabilities,
    history: finding.history,
    origins: finding.origins,
    powers: finding.powers,
    moralSystem: finding.moralSystem,
    physicalCharacteristics: finding.physicalCharacteristics,
    relationships: finding.relationships,
    relationshipWeb: finding.relationshipWeb,
    knowledge: finding.knowledge,
    secrets: finding.secrets,
    estimatedStats: finding.estimatedStats,
  });
}

/**
 * Keep the generated dossier and its generated overview entity in one atomic,
 * retryable write. Both statements are idempotent: a retry still evaluates the
 * entity row even when the dossier already matches, preventing a split state
 * after an interrupted earlier attempt.
 */
export async function persistRevalidatedGeneratedDossierProfiles(
  db: StudioRootDb,
  params: Array<{
    dossierId: string;
    finding: CharacterFinding;
  }>,
) {
  const uniqueByDossierId = new Map(
    params
      .filter((entry) => entry.dossierId)
      .map((entry) => [entry.dossierId, entry]),
  );
  const payload = [...uniqueByDossierId.values()].map((entry) => ({
    dossier_id: entry.dossierId,
    summary: entry.finding.summary,
    profile: profileFromCharacterFinding(entry.finding),
    relationships: entry.finding.relationships,
    capabilities: entry.finding.capabilities,
  }));
  if (!payload.length) return;
  await db.transaction(async (tx) => {
    // Lock and re-check every owner boundary inside the same transaction that
    // writes the generated projections. Bulk graph cleanup must never turn a
    // customer edit made after the replay's initial SELECT into collateral.
    const eligible = await tx.query<{ id: string }>(
      `SELECT id::text AS id
         FROM storyhold.character_dossiers
        WHERE id::text = ANY($1::text[]) AND user_edited_at IS NULL
         FOR UPDATE`,
      [payload.map((entry) => entry.dossier_id)],
    );
    const eligibleIds = new Set(eligible.rows.map((row) => String(row.id)));
    const eligiblePayload = payload.filter((entry) => eligibleIds.has(entry.dossier_id));
    if (!eligiblePayload.length) return;
    const serialized = json(eligiblePayload);
    await tx.query(
      `WITH incoming AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS entry(
           dossier_id text, summary text, profile jsonb,
           relationships jsonb, capabilities jsonb
         )
       )
       UPDATE storyhold.character_dossiers dossier
          SET summary = incoming.summary,
              profile = incoming.profile,
              updated_at = now()
         FROM incoming
        WHERE dossier.id::text = incoming.dossier_id
          AND dossier.user_edited_at IS NULL
          AND (
            dossier.summary IS DISTINCT FROM incoming.summary OR
            dossier.profile IS DISTINCT FROM incoming.profile
          )`,
      [serialized],
    );
    await tx.query(
      `WITH incoming AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS entry(
           dossier_id text, summary text, profile jsonb,
           relationships jsonb, capabilities jsonb
         )
       )
       UPDATE storyhold.world_entities entity
          SET relationships = incoming.relationships,
              summary = CASE WHEN entity.entity_type = 'character' THEN incoming.summary ELSE entity.summary END,
              details = CASE WHEN entity.entity_type = 'character' THEN incoming.capabilities ELSE entity.details END,
              updated_at = now()
         FROM incoming
        WHERE entity.dossier_id::text = incoming.dossier_id
          AND entity.classification_source = 'local'
          AND COALESCE(entity.review_status, 'candidate') <> 'user_confirmed'
          AND entity.pull_status = 'active'
          AND EXISTS (
            SELECT 1 FROM storyhold.character_dossiers dossier
             WHERE dossier.id = entity.dossier_id AND dossier.user_edited_at IS NULL
          )
          AND (
            entity.relationships IS DISTINCT FROM incoming.relationships OR
            (entity.entity_type = 'character' AND (
              entity.summary IS DISTINCT FROM incoming.summary OR
              entity.details IS DISTINCT FROM incoming.capabilities
            ))
          )`,
      [serialized],
    );
  });
}

export async function persistRevalidatedGeneratedDossierProfile(
  db: StudioRootDb,
  params: {
    dossierId: string;
    finding: CharacterFinding;
  },
) {
  await persistRevalidatedGeneratedDossierProfiles(db, [params]);
}

function generatedDossierFinding(row: Record<string, unknown>): CharacterFinding {
  const profile = normalizedDossierProfile(row.profile);
  return {
    name: textBody(row.name, 240),
    aliases: stringList(row.aliases, 40, 240),
    role: textBody(row.role, 240),
    summary: textBody(row.summary, 4_000),
    traits: profile.traits,
    motivations: profile.motivations,
    fears: profile.fears,
    capabilities: profile.capabilities,
    history: profile.history,
    origins: profile.origins,
    powers: profile.powers,
    moralSystem: profile.moralSystem,
    physicalCharacteristics: profile.physicalCharacteristics,
    relationships: profile.relationships,
    relationshipWeb: profile.relationshipWeb as CharacterFinding["relationshipWeb"],
    estimatedStats: profile.estimatedStats as CharacterFinding["estimatedStats"],
    socioPoliticalAxis: dossierAxis(row.axis_estimate),
    knowledge: profile.knowledge,
    secrets: profile.secrets,
    factionMemberships: [],
    evidence: storedEvidence(row.evidence),
    confidence: Number(row.confidence ?? 0),
    mentionCount: Number(row.mention_count ?? 0),
    mentionSourceCount: Number(row.mention_source_count ?? 0),
    reviewStatus: "candidate",
  };
}

async function persistEvidenceGroundedMigrationEntityRelations(params: {
  db: StudioRootDb;
  worldId: string;
  editionId: string;
  targetCharacters: CharacterFinding[];
  relations: EntityRelationFinding[];
}): Promise<{
  persistedRelationCount: number;
  impactedNonCharacterDossierIds: Set<string>;
}> {
  const empty = () => ({
    persistedRelationCount: 0,
    impactedNonCharacterDossierIds: new Set<string>(),
  });
  if (params.targetCharacters.length === 0 || params.relations.length === 0) {
    return empty();
  }

  const [resolution, entityResult] = await Promise.all([
    loadWorldEntityNameResolution({
      db: params.db,
      worldId: params.worldId,
      editionId: params.editionId,
    }),
    params.db.query<{
      id: string;
      dossier_id: string | null;
      name: string;
      aliases: unknown;
      entity_type: EntityType;
    }>(
      `SELECT id, dossier_id, name, aliases, entity_type
         FROM storyhold.world_entities
        WHERE world_id = $1 AND canon_edition_id = $2
          AND pull_status = 'active' AND scanner_present = true`,
      [params.worldId, params.editionId],
    ),
  ]);
  const entityById = new Map(entityResult.rows.map((row) => [row.id, row]));
  const surfacesByEntityId = new Map<string, string[]>();
  for (const row of entityResult.rows) {
    surfacesByEntityId.set(row.id, [
      ...new Set([row.name, ...stringList(row.aliases, 80, 240)]
        .map((value) => value.trim())
        .filter(Boolean)),
    ]);
  }
  const resolveEntityId = (surface: string) =>
    resolution.idsByName.get(entityReferenceKey(surface)) ?? null;
  const targetEntityIds = new Set<string>();
  for (const character of params.targetCharacters) {
    for (const surface of [character.name, ...character.aliases]) {
      const id = resolveEntityId(surface);
      if (id) targetEntityIds.add(id);
    }
  }
  if (targetEntityIds.size === 0) return empty();

  type RelationPayload = {
    id: string;
    source_entity_id: string;
    relation_type: EntityRelationType;
    target_entity_id: string;
    relation_status: EntityRelationFinding["status"];
    summary: string;
    valid_from_label: string;
    valid_until_label: string;
    evidence: EvidenceReference[];
    assignment_source: "local" | "ai";
    confidence: number;
  };
  const payloadByKey = new Map<string, RelationPayload>();
  const impactedNonCharacterDossierIds = new Set<string>();
  for (const relation of params.relations) {
    if (
      !localEntityTextIsUseful(relation.subject) ||
      !localEntityTextIsUseful(relation.target)
    ) continue;
    const sourceEntityId = resolveEntityId(relation.subject);
    const targetEntityId = resolveEntityId(relation.target);
    if (
      !sourceEntityId || !targetEntityId || sourceEntityId === targetEntityId ||
      (!targetEntityIds.has(sourceEntityId) && !targetEntityIds.has(targetEntityId))
    ) continue;
    const sourceEntity = entityById.get(sourceEntityId);
    const targetEntity = entityById.get(targetEntityId);
    if (
      !sourceEntity || !targetEntity ||
      !relationEntityTypesAreCompatible(
        relation.relationType,
        sourceEntity.entity_type,
        targetEntity.entity_type,
      )
    ) continue;
    const sourceSurfaces = surfacesByEntityId.get(sourceEntityId) ?? [relation.subject];
    const targetSurfaces = surfacesByEntityId.get(targetEntityId) ?? [relation.target];
    const evidence = relation.evidence.filter((reference) =>
      Boolean(reference.chunkId && reference.quote.trim()) &&
      sourceSurfaces.some((subject) => targetSurfaces.some((target) =>
        relationHasDirectPredicateSupport({
          subject,
          target,
          relationType: relation.relationType,
          quote: reference.quote,
        })
      ))
    );
    if (evidence.length === 0) continue;

    const key = [
      sourceEntityId,
      relation.relationType,
      targetEntityId,
      relation.status,
      relation.validFromLabel,
      relation.validUntilLabel,
    ].join("\u0000");
    const current = payloadByKey.get(key);
    if (current) {
      current.evidence = (mergeEntityEvidence(
        current.evidence,
        evidence,
      ) as EvidenceReference[]).slice(0, 12);
      current.confidence = Math.max(current.confidence, relation.confidence);
      if (relation.summary.length > current.summary.length) current.summary = relation.summary;
      if (relation.reviewStatus === "verified") current.assignment_source = "ai";
    } else {
      payloadByKey.set(key, {
        id: randomUUID(),
        source_entity_id: sourceEntityId,
        relation_type: relation.relationType,
        target_entity_id: targetEntityId,
        relation_status: relation.status,
        summary: relation.summary,
        valid_from_label: relation.validFromLabel,
        valid_until_label: relation.validUntilLabel,
        evidence: evidence.slice(0, 12),
        assignment_source: relation.reviewStatus === "verified" ? "ai" : "local",
        confidence: Math.max(0, Math.min(1, Number(relation.confidence ?? 0.5))),
      });
    }

    if (
      targetEntityIds.has(sourceEntityId) &&
      targetEntity.entity_type !== "character" &&
      targetEntity.dossier_id
    ) impactedNonCharacterDossierIds.add(targetEntity.dossier_id);
    if (
      targetEntityIds.has(targetEntityId) &&
      sourceEntity.entity_type !== "character" &&
      sourceEntity.dossier_id
    ) impactedNonCharacterDossierIds.add(sourceEntity.dossier_id);
  }
  const payload = [...payloadByKey.values()];
  if (payload.length === 0) return empty();
  const saved = await params.db.query<{ id: string }>(
    `INSERT INTO storyhold.world_entity_relations
      (id, world_id, canon_edition_id, source_entity_id, relation_type,
       target_entity_id, relation_status, summary, valid_from_label,
       valid_until_label, evidence, assignment_source, confidence)
     SELECT entry.id::uuid, $1::uuid, $2::uuid, entry.source_entity_id::uuid,
            entry.relation_type, entry.target_entity_id::uuid,
            entry.relation_status, entry.summary, entry.valid_from_label,
            entry.valid_until_label, entry.evidence, entry.assignment_source,
            entry.confidence
       FROM jsonb_to_recordset($3::jsonb) AS entry(
         id text, source_entity_id text, relation_type text,
         target_entity_id text, relation_status text, summary text,
         valid_from_label text, valid_until_label text, evidence jsonb,
         assignment_source text, confidence real
       )
     ON CONFLICT (world_id, canon_edition_id, source_entity_id, relation_type,
                  target_entity_id, relation_status, valid_from_label, valid_until_label)
     DO UPDATE SET
       summary = CASE
         WHEN length(EXCLUDED.summary) > length(storyhold.world_entity_relations.summary)
         THEN EXCLUDED.summary ELSE storyhold.world_entity_relations.summary
       END,
       evidence = (
         SELECT COALESCE(jsonb_agg(evidence_item.value), '[]'::jsonb)
           FROM (
             SELECT DISTINCT value
               FROM jsonb_array_elements(
                 storyhold.world_entity_relations.evidence || EXCLUDED.evidence
               ) AS combined(value)
           ) AS evidence_item
       ),
       assignment_source = CASE
         WHEN storyhold.world_entity_relations.assignment_source = 'ai'
           OR EXCLUDED.assignment_source = 'ai'
         THEN 'ai' ELSE 'local'
       END,
       confidence = GREATEST(
         storyhold.world_entity_relations.confidence,
         EXCLUDED.confidence
       ),
       updated_at = now()
     WHERE storyhold.world_entity_relations.assignment_source <> 'user'
     RETURNING id`,
    [params.worldId, params.editionId, json(payload)],
  );
  return {
    persistedRelationCount: saved.rows.length,
    impactedNonCharacterDossierIds,
  };
}

/**
 * Revalidate generated dossier profiles against the current concept taxonomy
 * without pretending every historical dossier row is still a character. Real
 * character dossiers are normalized together so pair evidence remains
 * symmetric; suppressed/non-character profiles are normalized one at a time
 * with the real cast supplied only as connection context.
 */
export function revalidateGeneratedLocalDossierProfiles(params: {
  findings: WorldFindings;
  profiles: Array<{
    linkedEntityType: string;
    finding: CharacterFinding;
  }>;
  connectionCharacters?: CharacterFinding[];
  onGraphNormalization?: (event: {
    phase: "character_graph";
    profileCount: number;
    contextCharacterCount: number;
  }) => void;
  onProfileProjectionPrepared?: (event: {
    profileCount: number;
    candidateCount: number;
    storedRelationCount: number;
    acceptedRelationCount: number;
  }) => void;
  onProfileProjectionAccess?: (event: {
    profileCount: number;
    candidateCount: number;
    storedRelationCount: number;
    candidateSurfaceLookups: number;
    candidateBucketRowsExamined: number;
    maxCandidateBucketSize: number;
    candidateTextScans: number;
    candidateTextMatches: number;
    storedRelationEndpointLookups: number;
    storedRelationRowsExamined: number;
    speciesCandidateChecks: number;
    formCandidateChecks: number;
    symbioticCandidateChecks: number;
    fullCandidateScans: number;
    acceptedNormalizationCandidateIndexBuilds: number;
    acceptedNormalizationCandidateSurfaceLookups: number;
    acceptedNormalizationCandidateBucketRowsExamined: number;
    acceptedNormalizationMaxCandidateBucketSize: number;
    acceptedNormalizationFullCandidateScans: number;
    promotionCandidateIndexBuilds: number;
    promotionCandidateSurfaceLookups: number;
    promotionCandidateBucketRowsExamined: number;
    promotionMaxCandidateBucketSize: number;
    promotionCandidateTextScans: number;
    promotionCandidateTextMatches: number;
    promotionFormCandidateChecks: number;
    promotionFullCandidateScans: number;
    acceptedCandidateIndexBuilds: number;
    acceptedCandidateSurfaceLookups: number;
    acceptedCandidateBucketRowsExamined: number;
    acceptedMaxCandidateBucketSize: number;
    acceptedFullCandidateScans: number;
    characterProjectionProfileCount: number;
    characterProjectionStoredRelationCount: number;
    characterProjectionCandidateSurfaceLookups: number;
    characterProjectionCandidateBucketRowsExamined: number;
    characterProjectionMaxCandidateBucketSize: number;
    characterProjectionCandidateTextScans: number;
    characterProjectionStoredRelationEndpointLookups: number;
    characterProjectionStoredRelationRowsExamined: number;
    characterProjectionSpeciesCandidateChecks: number;
    characterProjectionFormCandidateChecks: number;
    characterProjectionSymbioticCandidateChecks: number;
    characterProjectionFullCandidateScans: number;
    taxonomyIndexBuilds: number;
    taxonomyFindingRowsIndexed: number;
    taxonomyExactTypeLookups: number;
    taxonomyExactBucketRowsExamined: number;
    taxonomySurfaceTypeLookups: number;
    taxonomySurfaceBucketRowsExamined: number;
    taxonomyMaxSurfaceBucketSize: number;
    taxonomyFallbackFindingLookups: number;
    taxonomyFallbackBucketRowsExamined: number;
    taxonomyFullFindingScans: number;
  }) => void;
}): CharacterFinding[] {
  const identity = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
  const currentTaxonomy: Array<[string, NamedFinding[]]> = [
    ["place", params.findings.locations],
    ["faction", params.findings.factions],
    ["institution", params.findings.institutions],
    ["government", params.findings.governments],
    ["power_structure", params.findings.powerStructures],
    ["creature", params.findings.creatures],
    ["species", params.findings.species],
    ["technology", params.findings.technologies],
    ["vehicle", params.findings.vehicles],
    ["device", params.findings.devices],
    ["weapon", params.findings.weapons],
    ["power", params.findings.powers],
    ["title", params.findings.titles],
    ["ambiguous", params.findings.ambiguous],
  ];
  type TaxonomyIndexRow = { entityType: string; finding: NamedFinding };
  const taxonomyAccess = {
    taxonomyIndexBuilds: 1,
    taxonomyFindingRowsIndexed: 0,
    taxonomyExactTypeLookups: 0,
    taxonomyExactBucketRowsExamined: 0,
    taxonomySurfaceTypeLookups: 0,
    taxonomySurfaceBucketRowsExamined: 0,
    taxonomyMaxSurfaceBucketSize: 0,
    taxonomyFallbackFindingLookups: 0,
    taxonomyFallbackBucketRowsExamined: 0,
    taxonomyFullFindingScans: 0,
  };
  const taxonomyTypes = currentTaxonomy.map(([entityType]) => entityType);
  const exactTaxonomyRowsByIdentity = new Map<string, TaxonomyIndexRow[]>();
  const surfaceTaxonomyRowsByIdentity = new Map<string, TaxonomyIndexRow[]>();
  const firstTaxonomyFindingByTypeAndSurface = new Map<string, NamedFinding>();
  const taxonomyFindingKey = (entityType: string, surfaceIdentity: string) =>
    `${entityType}\u0000${surfaceIdentity}`;
  for (const [entityType, findings] of currentTaxonomy) {
    for (const finding of findings) {
      taxonomyAccess.taxonomyFindingRowsIndexed += 1;
      const row = { entityType, finding };
      const canonicalIdentity = identity(finding.name);
      const exactRows = exactTaxonomyRowsByIdentity.get(canonicalIdentity) ?? [];
      exactRows.push(row);
      exactTaxonomyRowsByIdentity.set(canonicalIdentity, exactRows);
      for (const surfaceIdentity of new Set(
        [finding.name, ...(finding.aliases ?? [])].map(identity),
      )) {
        const surfaceRows = surfaceTaxonomyRowsByIdentity.get(surfaceIdentity) ?? [];
        surfaceRows.push(row);
        surfaceTaxonomyRowsByIdentity.set(surfaceIdentity, surfaceRows);
        const fallbackKey = taxonomyFindingKey(entityType, surfaceIdentity);
        if (!firstTaxonomyFindingByTypeAndSurface.has(fallbackKey)) {
          // Preserve the old Array.find behavior: the first finding in category
          // order wins whether this surface is canonical or an alias.
          firstTaxonomyFindingByTypeAndSurface.set(fallbackKey, finding);
        }
      }
    }
  }
  const effectiveProfiles = params.profiles.map((profile) => {
    const canonicalIdentity = identity(profile.finding.name);
    const findingIdentities = new Set(
      [profile.finding.name, ...profile.finding.aliases].map(identity),
    );
    taxonomyAccess.taxonomyExactTypeLookups += 1;
    const exactRows = exactTaxonomyRowsByIdentity.get(canonicalIdentity) ?? [];
    taxonomyAccess.taxonomyExactBucketRowsExamined += exactRows.length;
    const exactTypeOwners = new Set(exactRows.map((row) => row.entityType));
    const aliasTypeOwners = new Set<string>();
    for (const findingIdentity of findingIdentities) {
      taxonomyAccess.taxonomySurfaceTypeLookups += 1;
      const surfaceRows = surfaceTaxonomyRowsByIdentity.get(findingIdentity) ?? [];
      taxonomyAccess.taxonomySurfaceBucketRowsExamined += surfaceRows.length;
      taxonomyAccess.taxonomyMaxSurfaceBucketSize = Math.max(
        taxonomyAccess.taxonomyMaxSurfaceBucketSize,
        surfaceRows.length,
      );
      for (const row of surfaceRows) aliasTypeOwners.add(row.entityType);
    }
    const exactTypes = taxonomyTypes.filter((entityType) => exactTypeOwners.has(entityType));
    const aliasTypes = taxonomyTypes.filter((entityType) => aliasTypeOwners.has(entityType));
    const currentType = exactTypes.length === 1
      ? exactTypes[0]
      : exactTypes.length === 0 && aliasTypes.length === 1
        ? aliasTypes[0]
        : undefined;
    const linkedEntityType = currentType ?? profile.linkedEntityType;
    const taxonomyFinding = linkedEntityType === "character"
      ? undefined
      : (() => {
          taxonomyAccess.taxonomyFallbackFindingLookups += 1;
          const matched = firstTaxonomyFindingByTypeAndSurface.get(
            taxonomyFindingKey(linkedEntityType, canonicalIdentity),
          );
          if (matched) taxonomyAccess.taxonomyFallbackBucketRowsExamined += 1;
          return matched;
        })();
    return {
      ...profile,
      // The linked-type subquery and taxonomy restoration are separate reads.
      // When a replay repairs a stale category between them, the current
      // restored graph is the authority for projection semantics.
      linkedEntityType,
      taxonomyFinding,
    };
  });
  const characterProfiles = effectiveProfiles
    .filter((profile) => profile.linkedEntityType === "character")
    .map((profile) => profile.finding);
  const generatedCharacterNames = new Set(characterProfiles.map((character) => identity(character.name)));
  const contextByName = new Map<string, CharacterFinding>();
  for (const character of [
    ...(params.connectionCharacters ?? []),
    ...params.findings.characters,
  ]) {
    const key = identity(character.name);
    if (!key || generatedCharacterNames.has(key) || contextByName.has(key)) continue;
    contextByName.set(key, character);
  }
  const contextCharacters = [...contextByName.values()];
  params.onGraphNormalization?.({
    phase: "character_graph",
    profileCount: characterProfiles.length,
    contextCharacterCount: contextCharacters.length,
  });
  let normalizationAccess = {
    promotionCandidateIndexBuilds: 0,
    promotionCandidateSurfaceLookups: 0,
    promotionCandidateBucketRowsExamined: 0,
    promotionMaxCandidateBucketSize: 0,
    promotionCandidateTextScans: 0,
    promotionCandidateTextMatches: 0,
    promotionFormCandidateChecks: 0,
    promotionFullCandidateScans: 0,
    acceptedCandidateIndexBuilds: 0,
    acceptedCandidateSurfaceLookups: 0,
    acceptedCandidateBucketRowsExamined: 0,
    acceptedMaxCandidateBucketSize: 0,
    acceptedFullCandidateScans: 0,
    characterProjectionProfileCount: 0,
    characterProjectionStoredRelationCount: 0,
    characterProjectionCandidateSurfaceLookups: 0,
    characterProjectionCandidateBucketRowsExamined: 0,
    characterProjectionMaxCandidateBucketSize: 0,
    characterProjectionCandidateTextScans: 0,
    characterProjectionStoredRelationEndpointLookups: 0,
    characterProjectionStoredRelationRowsExamined: 0,
    characterProjectionSpeciesCandidateChecks: 0,
    characterProjectionFormCandidateChecks: 0,
    characterProjectionSymbioticCandidateChecks: 0,
    characterProjectionFullCandidateScans: 0,
  };
  const normalizedCharacterGraph = normalizeLocalDossierRelationshipProjection(
    { ...params.findings, characters: characterProfiles },
    [],
    contextCharacters,
    (event) => { normalizationAccess = event; },
  );
  const normalizedCharacters = normalizedCharacterGraph.characters;
  // Use the exact guarded character projections that this function returns as
  // the authority for reciprocal non-character rows. Deriving the reverse
  // side from the earlier intermediate graph allowed the saved Michael row to
  // contain `Manifests As` while the following Thrall projection saw the
  // pre-guard snapshot and saved no `Manifested By` row.
  const validatedCharacters = normalizedCharacters.map((character) =>
    guardLocalQwenDossierProjection(character, character)
  );
  const validatedCharacterByName = new Map(
    validatedCharacters.map((character) => [identity(character.name), character]),
  );
  const nonCharacterProfiles = effectiveProfiles.flatMap((profile, index) =>
    profile.linkedEntityType === "character"
      ? []
      : [{ index, finding: profile.finding }]
  );
  const projectedNonCharacters = projectLocalDossierProfilesAgainstNormalizedGraph({
    findings: {
      ...normalizedCharacterGraph,
      // Use the exact guarded profiles returned for real characters as the
      // shared source graph for every historical non-character projection.
      characters: validatedCharacters,
    },
    profiles: nonCharacterProfiles.map((profile) => profile.finding),
    connectionCharacters: contextCharacters,
    onPrepared: params.onProfileProjectionPrepared,
    onAccess: (event) => params.onProfileProjectionAccess?.({
      ...event,
      ...normalizationAccess,
      ...taxonomyAccess,
    }),
  });
  const projectedNonCharacterByIndex = new Map(
    nonCharacterProfiles.map((profile, index) => [
      profile.index,
      projectedNonCharacters[index] ?? profile.finding,
    ]),
  );
  const entityTypeLabel = (entityType: string) => ({
    place: "place",
    faction: "faction",
    institution: "institution",
    government: "government",
    power_structure: "power structure",
    creature: "creature",
    species: "species",
    technology: "technology",
    vehicle: "vehicle",
    device: "device",
    weapon: "weapon",
    power: "power",
    title: "title",
    ambiguous: "unresolved concept",
  }[entityType] ?? "world concept");

  // Prepare grounded form endpoints and reciprocal rows once for the whole
  // world. The previous per-profile scan walked every validated character and
  // every relationship for every generated non-character dossier.
  const formEndpointIdentities = new Set(
    [...params.findings.creatures, ...params.findings.species]
      .flatMap((candidate) => [candidate.name, ...(candidate.aliases ?? [])])
      .map(identity)
      .filter(Boolean),
  );
  type ReciprocalFormSource = {
    sequence: number;
    name: string;
    evidence: CharacterFinding["relationshipWeb"][number]["evidence"];
  };
  const reciprocalFormSourcesByTargetIdentity = new Map<string, ReciprocalFormSource[]>();
  let reciprocalFormSequence = 0;
  for (const source of validatedCharacters) {
    for (const relationship of source.relationshipWeb) {
      const sequence = reciprocalFormSequence;
      reciprocalFormSequence += 1;
      if (relationship.relationship !== "Manifests As" || !relationship.evidence.length) continue;
      const targetIdentity = identity(relationship.name);
      if (!targetIdentity) continue;
      const rows = reciprocalFormSourcesByTargetIdentity.get(targetIdentity) ?? [];
      rows.push({ sequence, name: source.name, evidence: relationship.evidence });
      reciprocalFormSourcesByTargetIdentity.set(targetIdentity, rows);
    }
  }

  return effectiveProfiles.map(({ linkedEntityType, finding, taxonomyFinding }, profileIndex) => {
    if (linkedEntityType === "character") {
      return validatedCharacterByName.get(identity(finding.name)) ?? finding;
    }
    const normalized = projectedNonCharacterByIndex.get(profileIndex) ?? finding;
    const guarded = guardLocalQwenDossierProjection(normalized, normalized);
    // The non-character profile is deliberately projected separately from
    // the cast, and its guard can therefore omit the reciprocal even though
    // the character graph has already validated the durable `has_form` edge.
    // Rebuild that display row directly from the validated graph—not from
    // co-occurrence or profile prose—and only for category-compatible form
    // endpoints.
    const findingIdentities = new Set([finding.name, ...finding.aliases].map(identity));
    const categoryCompatibleFormEndpoint = ["creature", "species"].includes(linkedEntityType) ||
      [...findingIdentities].some((candidateIdentity) => formEndpointIdentities.has(candidateIdentity));
    const reciprocalFormRows = categoryCompatibleFormEndpoint
      ? [...findingIdentities]
          .flatMap((targetIdentity) => reciprocalFormSourcesByTargetIdentity.get(targetIdentity) ?? [])
          .sort((left, right) => left.sequence - right.sequence)
          .map((source) => ({
            name: source.name,
            relationship: "Manifested By",
            summary: `${finding.name} is manifested by ${source.name}.`,
            sentiment: "unknown" as const,
            evidence: source.evidence,
          }))
      : [];
    const reciprocalSourceIds = new Set(reciprocalFormRows.map((row) => identity(row.name)));
    const projected = reciprocalFormRows.length
      ? {
          ...guarded,
          relationships: [...new Set([
            ...guarded.relationships.filter((value) => {
              const target = value.slice(0, value.indexOf(":"));
              return !target || !reciprocalSourceIds.has(identity(target));
            }),
            ...reciprocalFormRows.map((row) => `${row.name}: Manifested By`),
          ])].slice(0, 40),
          relationshipWeb: [
            ...guarded.relationshipWeb.filter((row) =>
              !reciprocalSourceIds.has(identity(row.name))
            ),
            ...reciprocalFormRows,
          ].slice(0, 40),
        }
      : guarded;
    const guardedSummaryKey = identity(projected.summary).replace(/[.!?]+$/u, "");
    const nameKey = identity(finding.name);
    const genericCharacterFallback = guardedSummaryKey.startsWith(`${nameKey} `) &&
      /^is\s+an?\s+(?:(?:central\s+point-of-view|point-of-view|major|recurring|supporting)\s+)?character(?:\s+in\s+the\s+story)?$/u.test(
        guardedSummaryKey.slice(nameKey.length).trim(),
      );
    if (!genericCharacterFallback) return projected;
    const label = entityTypeLabel(linkedEntityType);
    const summary = textBody(taxonomyFinding?.summary, 4_000) ||
      `${finding.name} is ${/^[aeiou]/iu.test(label) ? "an" : "a"} ${label} in this world.`;
    return {
      ...projected,
      role: label.replace(/\b\w/gu, (letter) => letter.toLocaleUpperCase()),
      summary,
    };
  });
}

/**
 * Final generated-local boundary before a finding is serialized. Checkpoints
 * and earlier analysis snapshots may have been written by an older local
 * model or an older durability policy, so they cannot be treated as trusted
 * profile prose merely because they already exist. Customer edits are guarded
 * separately at the database boundary and never enter this projection.
 */
export function generatedLocalFindingsForPersistence(
  findings: WorldFindings,
): WorldFindings {
  // A completed intake can carry generated relationship rows forward from an
  // earlier checkpoint even when no individual dossier is selected for a
  // rerun. Revalidate the complete generated graph at the final persistence
  // boundary so unsupported co-occurrence edges and labels made stale by a
  // category repair cannot become the new saved baseline.
  const normalized = normalizeLocalDossierRelationshipProjection(findings);
  return {
    ...normalized,
    characters: normalized.characters.map((character) =>
      guardLocalQwenDossierProjection(character, character)
    ),
  };
}

function evidenceReferencesFrom(value: unknown): Array<{
  chunkId: string;
  sourceId: string;
  quote: string;
}> {
  const output: Array<{ chunkId: string; sourceId: string; quote: string }> = [];
  const seen = new Set<string>();
  const visit = (candidate: unknown) => {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    const row = candidate as Record<string, unknown>;
    const chunkId = textBody(row.chunkId, 80);
    const sourceId = textBody(row.sourceId, 80);
    const quote = textBody(row.quote, 1_000);
    if (chunkId && sourceId) {
      const key = `${chunkId}:${quote}`;
      if (!seen.has(key)) {
        seen.add(key);
        output.push({ chunkId, sourceId, quote });
      }
    }
    for (const nested of Object.values(row)) visit(nested);
  };
  visit(value);
  return output;
}

async function saveCharacterSourceContributions(
  db: StudioDb,
  params: {
    dossierId: string;
    worldId: string;
    editionId: string;
    runId: string;
    finding: CharacterFinding;
  },
) {
  const incomingProfile = profileFromCharacterFinding(params.finding);
  const allEvidence = evidenceReferencesFrom(params.finding);
  const sourceIds = [...new Set(allEvidence.map((entry) => entry.sourceId))];
  for (const sourceId of sourceIds) {
    const sourceEvidence = allEvidence.filter(
      (entry) => entry.sourceId === sourceId,
    );
    const existingResult = await db.query<Record<string, unknown>>(
      `SELECT * FROM storyhold.character_dossier_source_contributions
        WHERE dossier_id = $1 AND source_id = $2
        LIMIT 1`,
      [params.dossierId, sourceId],
    );
    const existing = existingResult.rows[0];
    const profile = existing
      ? mergeDossierProfiles(existing.profile, incomingProfile)
      : incomingProfile;
    profile.estimatedStats = mergeReviewedStatEstimates(recordBody(existing?.profile).estimatedStats, incomingProfile.estimatedStats);
    const aliases = mergeEntityStrings(
      existing?.aliases,
      params.finding.aliases,
    );
    const role = richerDossierText(existing?.role, params.finding.role, 240);
    const summary = richerDossierText(
      existing?.summary,
      params.finding.summary,
      4_000,
    );
    const evidence = mergeEntityEvidence(existing?.evidence, sourceEvidence);
    const priorAxis = dossierAxis(existing?.axis_estimate);
    const nextAxis = dossierAxis(params.finding.socioPoliticalAxis);
    const axis =
      nextAxis.confidence > priorAxis.confidence ? nextAxis : priorAxis;
    await db.query(
      `INSERT INTO storyhold.character_dossier_source_contributions
        (id, dossier_id, source_id, world_id, canon_edition_id,
         last_analysis_run_id, aliases, role, summary, profile, evidence,
         confidence, axis_estimate)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb,
               $11::jsonb, $12, $13::jsonb)
       ON CONFLICT (dossier_id, source_id) DO UPDATE
         SET last_analysis_run_id = EXCLUDED.last_analysis_run_id,
             aliases = EXCLUDED.aliases,
             role = EXCLUDED.role,
             summary = EXCLUDED.summary,
             profile = EXCLUDED.profile,
             evidence = EXCLUDED.evidence,
             confidence = EXCLUDED.confidence,
             axis_estimate = EXCLUDED.axis_estimate,
             updated_at = now()`,
      [
        existing?.id ?? randomUUID(),
        params.dossierId,
        sourceId,
        params.worldId,
        params.editionId,
        params.runId,
        json(aliases),
        role,
        summary,
        json(profile),
        json(evidence),
        Math.max(Number(existing?.confidence ?? 0), params.finding.confidence),
        json(axis),
      ],
    );
  }
}

async function saveCharacterDossier(
  db: StudioDb,
  params: {
    worldId: string;
    editionId: string;
    runId: string;
    analysisKind: AnalysisKind;
    replaceGeneratedSnapshot?: boolean;
    finding: CharacterFinding;
  },
) {
  const normalizedName = params.finding.name.trim().toLocaleLowerCase();
  if (!normalizedName) return;
  const existingResult = await db.query<Record<string, unknown>>(
    `SELECT * FROM storyhold.character_dossiers
      WHERE world_id = $1 AND canon_edition_id = $2 AND normalized_name = $3
      LIMIT 1`,
    [params.worldId, params.editionId, normalizedName],
  );
  const existing = existingResult.rows[0];
  const canonical = await db.query<{ id: string; canonical_key: string }>(
    `SELECT id, canonical_key
       FROM storyhold.characters
      WHERE world_id = $1 AND scope_kind = 'world' AND lower(name) = $2
      LIMIT 1`,
    [params.worldId, normalizedName],
  );
  const dossierStatus =
    canonical.rows[0] || plausibleCharacterName(params.finding.name)
      ? "active"
      : "suppressed";
  const id = typeof existing?.id === "string" ? existing.id : randomUUID();
  if (dossierIsCustomerEdited(existing)) {
    // A dossier the customer edited is authoritative. Automatic local and AI
    // reviews may still retain source-scoped proposals, but must not rewrite
    // the customer's name, prose, profile, evidence, status, or estimates.
    if (params.analysisKind === "ai_enrichment") {
      await saveCharacterSourceContributions(db, {
        dossierId: id,
        worldId: params.worldId,
        editionId: params.editionId,
        runId: params.runId,
        finding: params.finding,
      });
    }
    return;
  }
  const replaceLocalSnapshot = params.analysisKind === "local_scan";
  const incomingProfile = profileFromCharacterFinding(params.finding);
  const replaceGenerated = params.replaceGeneratedSnapshot === true;
  const profile = replaceLocalSnapshot
    ? incomingProfile
    : existing && !replaceGenerated
      ? mergeDossierProfiles(existing.profile, incomingProfile)
      : incomingProfile;
  if (params.analysisKind === "ai_enrichment") {
    profile.estimatedStats = mergeReviewedStatEstimates(recordBody(existing?.profile).estimatedStats, incomingProfile.estimatedStats);
  }
  const aliases = replaceLocalSnapshot || replaceGenerated
      ? mergeEntityStrings(params.finding.aliases)
      : mergeEntityStrings(existing?.aliases, params.finding.aliases);
  const role = replaceLocalSnapshot || replaceGenerated
      ? textBody(params.finding.role, 240)
      : richerDossierText(existing?.role, params.finding.role, 240);
  const summary = replaceLocalSnapshot || replaceGenerated
      ? textBody(params.finding.summary, 4_000)
      : richerDossierText(existing?.summary, params.finding.summary, 4_000);
  const evidence = replaceLocalSnapshot || replaceGenerated
      ? mergeEntityEvidence(params.finding.evidence)
      : mergeEntityEvidence(existing?.evidence, params.finding.evidence);
  const priorAxis = dossierAxis(existing?.axis_estimate);
  const nextAxis = dossierAxis(params.finding.socioPoliticalAxis);
  // The UPSERT below preserves a previously qualified compass verbatim; local
  // readers and old world-review contracts cannot replace it by confidence.
  const axisEstimate = replaceLocalSnapshot || replaceGenerated
      ? nextAxis
      : priorAxis.confidence >= nextAxis.confidence
    ? priorAxis
    : nextAxis;
  const saved = await db.query<{ id: string }>(
    `INSERT INTO storyhold.character_dossiers
      (id, world_id, canon_edition_id, canonical_character_id,
       source_analysis_run_id, canonical_key, normalized_name, name, aliases,
       role, summary, profile, evidence, confidence, dossier_status, axis_estimate,
       mention_count, mention_source_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11,
             $12::jsonb, $13::jsonb, $14, $15, $16::jsonb, $17, $18)
     ON CONFLICT (world_id, canon_edition_id, normalized_name) DO UPDATE
       SET canonical_character_id = COALESCE(EXCLUDED.canonical_character_id,
                                             storyhold.character_dossiers.canonical_character_id),
           source_analysis_run_id = EXCLUDED.source_analysis_run_id,
           name = EXCLUDED.name,
           aliases = EXCLUDED.aliases,
           role = EXCLUDED.role,
           summary = EXCLUDED.summary,
           profile = EXCLUDED.profile,
           evidence = EXCLUDED.evidence,
           confidence = EXCLUDED.confidence,
           dossier_status = EXCLUDED.dossier_status,
           axis_estimate = CASE WHEN storyhold.character_dossiers.axis_estimate ? 'perspective'
             THEN storyhold.character_dossiers.axis_estimate ELSE EXCLUDED.axis_estimate END,
           mention_count = EXCLUDED.mention_count,
           mention_source_count = EXCLUDED.mention_source_count,
           updated_at = now()
     RETURNING id`,
    [
      id,
      params.worldId,
      params.editionId,
      canonical.rows[0]?.id ?? null,
      params.runId,
      canonical.rows[0]?.canonical_key ??
        (textBody(existing?.canonical_key, 240) ||
          `${slug(params.finding.name)}-${id.slice(0, 8)}`),
      normalizedName,
      params.finding.name,
      json(aliases),
      role,
      summary,
      json(profile),
      json(evidence),
      replaceGenerated
        ? params.finding.confidence
        : Math.max(Number(existing?.confidence ?? 0), params.finding.confidence),
      dossierStatus,
      json(axisEstimate),
      params.analysisKind === "local_scan" || replaceGenerated
        ? Math.max(0, Math.round(params.finding.mentionCount ?? 0))
        : Math.max(
            Number(existing?.mention_count ?? 0),
            Math.round(params.finding.mentionCount ?? 0),
          ),
      params.analysisKind === "local_scan" || replaceGenerated
        ? Math.max(0, Math.round(params.finding.mentionSourceCount ?? 0))
        : Math.max(
            Number(existing?.mention_source_count ?? 0),
            Math.round(params.finding.mentionSourceCount ?? 0),
          ),
    ],
  );
  if (params.analysisKind === "ai_enrichment" && saved.rows[0]?.id) {
    await saveCharacterSourceContributions(db, {
      dossierId: saved.rows[0].id,
      worldId: params.worldId,
      editionId: params.editionId,
      runId: params.runId,
      finding: params.finding,
    });
  }
}

async function ensureCharacterDossiersForWorld(
  db: StudioDb,
  worldId: string,
  editionId: string,
) {
  const [drafts, characters] = await Promise.all([
    db.query<Record<string, unknown>>(
      `SELECT id, analysis_run_id, canonical_key, name, aliases, role, summary,
              profile, evidence, confidence
         FROM storyhold.character_drafts
        WHERE world_id = $1 AND canon_edition_id = $2
          AND review_status <> 'rejected'
        ORDER BY created_at ASC`,
      [worldId, editionId],
    ),
    db.query<Record<string, unknown>>(
      `SELECT id, canonical_key, name, initial_profile, created_at
         FROM storyhold.characters
        WHERE world_id = $1 AND scope_kind = 'world'
        ORDER BY created_at ASC`,
      [worldId],
    ),
  ]);

  for (const row of [...drafts.rows, ...characters.rows]) {
    const name = textBody(row.name, 240);
    const normalizedName = name.trim().toLocaleLowerCase();
    if (!normalizedName) continue;
    const canonicalCharacterId = row.initial_profile ? row.id : null;
    const dossierStatus =
      canonicalCharacterId || plausibleCharacterName(name) ? "active" : "suppressed";
    const rawProfile = row.initial_profile ?? row.profile;
    const profile = normalizedDossierProfile(rawProfile);
    const rawProfileRecord = recordBody(rawProfile);
    const id = randomUUID();
    await db.query(
      `INSERT INTO storyhold.character_dossiers
        (id, world_id, canon_edition_id, canonical_character_id,
         source_analysis_run_id, canonical_key, normalized_name, name, aliases,
         role, summary, profile, evidence, confidence, dossier_status, axis_estimate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11,
               $12::jsonb, $13::jsonb, $14, $15, $16::jsonb)
       ON CONFLICT (world_id, canon_edition_id, normalized_name) DO UPDATE
         SET canonical_character_id = COALESCE(storyhold.character_dossiers.canonical_character_id,
                                               EXCLUDED.canonical_character_id),
             dossier_status = CASE
               WHEN storyhold.character_dossiers.canonical_character_id IS NULL
                AND storyhold.character_dossiers.role = 'Unreviewed character or named-entity candidate'
                AND EXCLUDED.dossier_status = 'suppressed'
               THEN 'suppressed'
               ELSE storyhold.character_dossiers.dossier_status
             END,
             updated_at = now()`,
      [
        id,
        worldId,
        editionId,
        canonicalCharacterId,
        row.analysis_run_id ?? null,
        textBody(row.canonical_key, 240) || `${slug(name)}-${id.slice(0, 8)}`,
        normalizedName,
        name,
        json(Array.isArray(row.aliases) ? row.aliases : []),
        textBody(row.role, 240),
        textBody(row.summary, 4_000),
        json(profile),
        json(Array.isArray(row.evidence) ? row.evidence : []),
        Number(row.confidence ?? (canonicalCharacterId ? 1 : 0.25)),
        dossierStatus,
        json(dossierAxis(rawProfileRecord.socioPoliticalAxis)),
      ],
    );
  }
}

function mergeEntityStrings(...groups: unknown[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const value of group) {
      const clean = textBody(value, 500);
      const key = clean.toLocaleLowerCase();
      if (!clean || seen.has(key)) continue;
      seen.add(key);
      output.push(clean);
      if (output.length >= 80) return output;
    }
  }
  return output;
}

function mergeEntityEvidence(...groups: unknown[]): unknown[] {
  const seen = new Set<string>();
  const output: unknown[] = [];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const value of group) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const row = value as Record<string, unknown>;
      const key = `${textBody(row.chunkId, 80)}:${textBody(row.quote, 500)}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      output.push(value);
      if (output.length >= 12) return output;
    }
  }
  return output;
}

type GeneratedEntityHypothesis = {
  entityType: EntityType;
  finding: NamedFinding;
};

const GENERATED_PRESENTATION_LANGUAGE = /\b(?:GLiNER|MiniLM|BGE|Qwen|local\s+(?:semantic\s+)?(?:pass|model|reader|scan)|connected\s+AI|backend|extraction|provisional|mention\s+count\s+pending)\b/iu;

function generatedEntityPresentationNeedsRefresh(summary: unknown): boolean {
  const text = textBody(summary, 4_000);
  return !text ||
    GENERATED_PRESENTATION_LANGUAGE.test(text) ||
    /\bactions\s+recur\s+across\s+the\s+story\b/iu.test(text) ||
    /\b(?:appears?\s+in\s+religious\s+discussion|is\s+used\s+as\s+an\s+exclamation|is\s+invoked\s+in\s+discussion\s+of\s+religion)\b/iu.test(text);
}

export function generatedLocalEntityNeedsPresentationRepair(params: {
  categoryChanged: boolean;
  category: EntityType;
  entitySummary: unknown;
  dossierSummary: unknown;
}): boolean {
  return params.categoryChanged ||
    generatedEntityPresentationNeedsRefresh(params.entitySummary) ||
    (params.category === "character" &&
      generatedEntityPresentationNeedsRefresh(params.dossierSummary));
}

export function generatedCategoryRepairShouldRestoreVisibility(params: {
  categoryChanged: boolean;
  category: EntityType;
  evidenceCount: number;
}): boolean {
  // A rejected machine lead stays hidden unless the manuscript now supports a
  // concrete corrected category. This lets startup restore a previously
  // hidden team/species/place after better adjudication without reviving
  // unresolved noise or overriding an owner's pull decision.
  return params.categoryChanged &&
    params.category !== "ambiguous" &&
    params.evidenceCount > 0;
}

export function generatedCharacterDossierIsSubstantive(params: {
  name: unknown;
  summary?: unknown;
  role?: unknown;
  profile?: unknown;
  evidence?: unknown;
  canonicalCharacterId?: unknown;
  mentionCount?: unknown;
  mentionSourceCount?: unknown;
}): boolean {
  if (typeof params.canonicalCharacterId === "string" && params.canonicalCharacterId.trim()) return true;
  const name = textBody(params.name, 240);
  const evidence = Array.isArray(params.evidence) ? params.evidence as EvidenceReference[] : [];
  const evidenceCategory = localEntityCategoryFromEvidence(name, evidence, "character");
  if (evidenceCategory === "character") return true;
  // A dossier never overrules direct evidence that the surface is a place,
  // object, creature, collective, cultural reference, or generic moniker.
  if (evidenceCategory !== "ambiguous" || !localCharacterNameIsUseful(name)) return false;
  const role = textBody(params.role, 240);
  const summary = textBody(params.summary, 4_000);
  if (/\bcentral\s+point-of-view\s+character\b/iu.test(role) &&
    /\bchoices?\s+and\s+perspective\s+anchor\b/iu.test(summary) &&
    !generatedEntityPresentationNeedsRefresh(summary)) return true;
  const mentionCount = Math.max(0, Number(params.mentionCount ?? 0));
  const mentionSourceCount = Math.max(0, Number(params.mentionSourceCount ?? 0));
  const profile = normalizedDossierProfile(params.profile);
  const groundedPortraitClaims = [
    ...profile.traits,
    ...profile.motivations,
    ...profile.fears,
    ...profile.capabilities,
    ...profile.history,
    ...profile.origins,
    ...profile.powers,
    ...profile.moralSystem,
    ...profile.physicalCharacteristics,
    ...profile.knowledge,
    ...profile.secrets,
  ].length;
  // Roles are generated from manuscript-wide POV and recurrence signals. They
  // are useful corroboration when the saved excerpt is inconclusive, but only
  // at thresholds that exclude one-off named references.
  if (/^(?:Major|Recurring) Character$/iu.test(role)) {
    return mentionCount >= 10 && evidence.length >= 2;
  }
  if (/^Central Point-of-View Character$/iu.test(role)) {
    return mentionCount >= 10 && evidence.length >= 2;
  }
  return /^Supporting Character$/iu.test(role) &&
    mentionCount >= 3 &&
    evidence.length >= 2 &&
    (groundedPortraitClaims >= 1 || mentionSourceCount >= 2);
}

/**
 * GLiNER and the deterministic readers are allowed to disagree, but their
 * buckets must not take turns overwriting the same saved entity. Combine the
 * evidence first, then make one category decision for that surface.
 */
export function adjudicateGeneratedEntityHypotheses(params: {
  hypotheses: GeneratedEntityHypothesis[];
  hasSubstantiveCharacterDossier?: boolean;
}): {
  entityType: EntityType;
  finding: NamedFinding;
  classificationSource: "local" | "ai";
} | null {
  const first = params.hypotheses[0];
  if (!first) return null;
  const name = textBody(first.finding.name, 240);
  const evidence = mergeEntityEvidence(
    ...params.hypotheses.map((hypothesis) => hypothesis.finding.evidence),
  ) as EvidenceReference[];
  const scores = new Map<EntityType, number>();
  const resolved = params.hypotheses.map((hypothesis) => {
    const entityType = localEntityCategoryFromEvidence(
      name,
      evidence,
      hypothesis.entityType,
    ) as EntityType;
    const weight = hypothesis.finding.reviewStatus === "verified" ? 3 : 1;
    scores.set(entityType, (scores.get(entityType) ?? 0) + weight);
    return { ...hypothesis, resolvedType: entityType };
  });
  const characterVerdict = localEntityCategoryFromEvidence(name, evidence, "character") as EntityType;
  if (characterVerdict !== "ambiguous") {
    scores.set(characterVerdict, (scores.get(characterVerdict) ?? 0) + 4);
  } else if (params.hasSubstantiveCharacterDossier) {
    // A detailed, active character portrait is stronger than an ungrounded
    // object/type guess. Explicit evidence can still reclassify it above.
    scores.set("character", (scores.get("character") ?? 0) + 4);
  }
  const tiePriority: Record<EntityType, number> = {
    term: 170,
    cultural_reference: 160,
    character: 150,
    creature: 140,
    species: 130,
    place: 120,
    faction: 110,
    institution: 105,
    government: 100,
    power_structure: 95,
    vehicle: 90,
    device: 85,
    weapon: 80,
    technology: 75,
    power: 70,
    title: 65,
    ambiguous: 0,
  };
  const entityType = [...scores.entries()].sort((left, right) =>
    right[1] - left[1] || tiePriority[right[0]] - tiePriority[left[0]]
  )[0]?.[0] ?? "ambiguous";
  const matching = resolved.filter((hypothesis) => hypothesis.resolvedType === entityType);
  const candidates = matching.length > 0 ? matching : resolved;
  const richest = [...candidates].sort((left, right) =>
    textBody(right.finding.summary, 4_000).length - textBody(left.finding.summary, 4_000).length ||
    Number(right.finding.confidence ?? 0) - Number(left.finding.confidence ?? 0)
  )[0] ?? resolved[0]!;
  const classificationSource = matching.some(
    (hypothesis) => hypothesis.finding.reviewStatus === "verified",
  ) ? "ai" : "local";
  const localPresentation = classificationSource === "local" && entityType !== "character" && (
    richest.resolvedType !== richest.entityType ||
    generatedEntityPresentationNeedsRefresh(richest.finding.summary)
  )
    ? localPublicEntitySummaryFromEvidence(entityType, name, evidence)
    : null;
  return {
    entityType,
    classificationSource,
    finding: {
      ...richest.finding,
      name,
      ...(localPresentation ?? {}),
      aliases: mergeEntityStrings(...params.hypotheses.map((hypothesis) => hypothesis.finding.aliases)),
      details: mergeEntityStrings(...params.hypotheses.map((hypothesis) => hypothesis.finding.details)),
      relationships: mergeEntityStrings(...params.hypotheses.map((hypothesis) => hypothesis.finding.relationships)),
      factionMemberships: mergeEntityStrings(...params.hypotheses.map((hypothesis) => hypothesis.finding.factionMemberships)),
      evidence,
      confidence: Math.max(...params.hypotheses.map((hypothesis) => Number(hypothesis.finding.confidence ?? 0.35))),
      mentionCount: Math.max(...params.hypotheses.map((hypothesis) => Number(hypothesis.finding.mentionCount ?? 0))),
      mentionSourceCount: Math.max(...params.hypotheses.map((hypothesis) => Number(hypothesis.finding.mentionSourceCount ?? 0))),
      reviewStatus: classificationSource === "ai" ? "verified" : "candidate",
    },
  };
}

export function entityIsScannerProtected(
  row: Record<string, unknown> | undefined,
): boolean {
  if (!row) return false;
  return (
    row.classification_source === "user" ||
    row.review_status === "user_confirmed" ||
    row.pull_status !== "active"
  );
}

export function entityIsCustomerVisible(row: Record<string, unknown>): boolean {
  const source = textBody(row.classification_source, 20);
  const review = textBody(row.review_status, 30);
  const pull = textBody(row.pull_status, 30);
  const name = textBody(row.name, 240).toLocaleLowerCase();
  const entityType = textBody(row.entity_type, 40);
  const scannerPresent = row.scanner_present === true;
  const customerOwned = source === "user" || review === "user_confirmed";
  if (pull === "deleted" || pull === "merged") return false;
  // Hidden is a customer decision.  A discarded rules/GLiNER lead is an
  // internal negative result and must not masquerade as something the owner
  // chose to hide.
  if (pull === "do_not_pull") return customerOwned;
  if (!scannerPresent && !customerOwned) return false;
  // Familiar forms of address and generic religious invocations are useful
  // retrieval context, but they are not standalone lore subjects. Keep them
  // in the vault while preventing scanner-generated Dad/Dude/Jesus cards from
  // cluttering the world. An owner can still promote one deliberately.
  if (!customerOwned && source === "local" && (
    (entityType === "term" && /^(?:boss|cap|captain|chief|dad|daddy|doc|doctor|dude|father|mama|mayday|mom|momma|mother)$/u.test(name)) ||
    /^(?:allah|buddha|christ|god|jehovah|jesus|jesus christ|mohammed|muhammad|satan|the virgin mary|virgin mary|yahweh)$/u.test(name) ||
    (["character", "ambiguous"].includes(entityType) &&
      /\b\p{Lu}[\p{L}\p{M}'’.-]*\s+(?:and|or|&)\s+\p{Lu}[\p{L}\p{M}'’.-]*\b/u.test(textBody(row.name, 240)))
  )) return false;
  if (
    entityType === "ambiguous" &&
    !customerOwned &&
    !ambiguousFindingIsEntityLabel({
      name: textBody(row.name, 240),
      summary: textBody(row.summary, 1_200),
    })
  ) return false;
  return true;
}

export function generatedEntityType(params: {
  existingType: EntityType | "";
  existingSource: string;
  incomingType: EntityType;
  incomingSource: "local" | "ai";
}): EntityType {
  // A cheap pass may correct its own older classification, but it may never
  // replace a completed connected-AI classification. The AI result remains
  // authoritative until another AI review or an owner changes it.
  if (
    params.incomingSource === "local" &&
    params.existingSource === "ai" &&
    params.existingType
  )
    return params.existingType;
  return params.incomingType;
}

async function upsertWorldEntity(
  db: StudioDb,
  params: {
    worldId: string;
    editionId: string;
    runId?: string | null;
    dossierId?: string | null;
    entityType: EntityType;
    finding: NamedFinding;
    classificationSource: "local" | "ai";
    replaceGeneratedSnapshot?: boolean;
    preserveExisting?: boolean;
  },
): Promise<string | null> {
  const name = textBody(params.finding.name, 240);
  const normalizedName = name.toLocaleLowerCase();
  if (!normalizedName) return null;
  const existingResult = await db.query<Record<string, unknown>>(
    `SELECT * FROM storyhold.world_entities
      WHERE world_id = $1 AND canon_edition_id = $2 AND normalized_name = $3
      LIMIT 1`,
    [params.worldId, params.editionId, normalizedName],
  );
  const existing = existingResult.rows[0];
  // Customer-created records are preserved below, but generated scans and AI
  // proposals may never create durable cards for pronouns, descriptive
  // references, sound effects, or generic prose nouns.
  if (!localEntityTextIsUseful(name)) {
    if (
      existing &&
      existing.classification_source !== "user" &&
      existing.review_status !== "user_confirmed"
    ) {
      await db.query(
        `UPDATE storyhold.world_entities
            SET scanner_present = false, updated_at = now()
          WHERE id = $1`,
        [existing.id],
      );
    }
    return null;
  }
  const id = typeof existing?.id === "string" ? existing.id : randomUUID();
  if (existing && params.preserveExisting) return id;
  const existingType = textBody(existing?.entity_type, 40) as EntityType;
  const existingSource = textBody(existing?.classification_source, 20);
  const customerConfirmed =
    existingSource === "user" || existing?.review_status === "user_confirmed";
  if (entityIsScannerProtected(existing)) {
    // A scanner may discover more evidence, but it may not rewrite a card the
    // customer classified or a merge/delete/do-not-pull decision. Those
    // records are intentionally left byte-for-byte stable; evidence can be
    // proposed separately through the review workflow.
    return id;
  }
  const nextType = customerConfirmed
    ? existingType
    : generatedEntityType({
        existingType,
        existingSource,
        incomingType: params.entityType,
        incomingSource: params.classificationSource,
      });
  const nextSource = customerConfirmed ? "user" : params.classificationSource;
  const nextReview =
    customerConfirmed
      ? "user_confirmed"
      : params.classificationSource === "ai" || params.finding.reviewStatus === "verified"
        ? "verified"
        : "candidate";
  const replaceGenerated = params.replaceGeneratedSnapshot === true;
  const aliases = replaceGenerated
    ? mergeEntityStrings(params.finding.aliases)
    : mergeEntityStrings(existing?.aliases, params.finding.aliases);
  const details = replaceGenerated
    ? mergeEntityStrings(params.finding.details)
    : mergeEntityStrings(existing?.details, params.finding.details);
  const relationships = replaceGenerated
    ? mergeEntityStrings(params.finding.relationships)
    : mergeEntityStrings(existing?.relationships, params.finding.relationships);
  const evidence = replaceGenerated
    ? mergeEntityEvidence(params.finding.evidence)
    : mergeEntityEvidence(existing?.evidence, params.finding.evidence);
  const estimatedStats = params.classificationSource === "ai"
    ? mergeReviewedStatEstimates(existing?.estimated_stats, params.finding.estimatedStats)
    : params.finding.estimatedStats
    ? dossierStatBlock(params.finding.estimatedStats)
    : replaceGenerated
      ? {}
      : existing?.estimated_stats ?? {};
  const summary = replaceGenerated
    ? textBody(params.finding.summary, 4_000)
    : existingSource === "ai" && params.classificationSource === "local"
    ? textBody(existing?.summary, 4_000)
    : params.finding.summary || textBody(existing?.summary, 4_000);
  if (existing) {
    await db.query(
      `UPDATE storyhold.world_entities
          SET dossier_id = COALESCE(dossier_id, $4),
              source_analysis_run_id = COALESCE($5, source_analysis_run_id),
              name = CASE
                WHEN classification_source = 'user' OR review_status = 'user_confirmed'
                THEN name ELSE $6 END,
              entity_type = $7,
              aliases = $8::jsonb,
              summary = $9,
              details = $10::jsonb,
              relationships = $11::jsonb,
              evidence = $12::jsonb,
              mention_count = CASE WHEN classification_source = 'user' OR review_status = 'user_confirmed'
                THEN GREATEST(mention_count, $13) ELSE $13 END,
              mention_source_count = CASE WHEN classification_source = 'user' OR review_status = 'user_confirmed'
                THEN GREATEST(mention_source_count, $14) ELSE $14 END,
              confidence = CASE WHEN $18 THEN $15 ELSE GREATEST(confidence, $15) END,
              classification_source = $16,
              review_status = $17,
              estimated_stats = $19::jsonb,
              scanner_present = true,
              updated_at = now()
        WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3`,
      [
        id,
        params.worldId,
        params.editionId,
        params.dossierId ?? null,
        params.runId ?? null,
        name,
        nextType,
        json(aliases),
        summary,
        json(details),
        json(relationships),
        json(evidence),
        Math.max(0, Math.round(params.finding.mentionCount ?? 0)),
        Math.max(0, Math.round(params.finding.mentionSourceCount ?? 0)),
        Math.max(0, Math.min(1, Number(params.finding.confidence ?? 0.35))),
        nextSource,
        nextReview,
        replaceGenerated,
        json(estimatedStats),
      ],
    );
    return id;
  }
  await db.query(
    `INSERT INTO storyhold.world_entities
      (id, world_id, canon_edition_id, dossier_id, source_analysis_run_id,
       canonical_key, normalized_name, name, entity_type, aliases, summary,
       details, relationships, evidence, mention_count, mention_source_count,
       confidence, classification_source, review_status, estimated_stats)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11,
             $12::jsonb, $13::jsonb, $14::jsonb, $15, $16, $17, $18, $19, $20::jsonb)`,
    [
      id,
      params.worldId,
      params.editionId,
      params.dossierId ?? null,
      params.runId ?? null,
      `${slug(name)}-${id.slice(0, 8)}`,
      normalizedName,
      name,
      nextType,
      json(aliases),
      summary,
      json(details),
      json(relationships),
      json(evidence),
      Math.max(0, Math.round(params.finding.mentionCount ?? 0)),
      Math.max(0, Math.round(params.finding.mentionSourceCount ?? 0)),
      Math.max(0, Math.min(1, Number(params.finding.confidence ?? 0.35))),
      nextSource,
      nextReview,
      json(estimatedStats),
    ],
  );
  return id;
}

function entityReferenceKey(value: unknown): string {
  return textBody(value, 240)
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

function groundedEvidenceReferences(...groups: unknown[]): EvidenceReference[] {
  const output: EvidenceReference[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const value of group) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const row = value as Record<string, unknown>;
      if (
        typeof row.chunkId !== "string" ||
        typeof row.sourceId !== "string" ||
        typeof row.quote !== "string" ||
        !UUID_PATTERN.test(row.chunkId) ||
        !UUID_PATTERN.test(row.sourceId) ||
        !row.quote.trim()
      ) continue;
      const key = `${row.chunkId}\u0000${row.quote}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({
        chunkId: row.chunkId,
        sourceId: row.sourceId,
        quote: row.quote,
      });
      if (output.length >= 12) return output;
    }
  }
  return output;
}

export function factionMembershipEvidence(params: {
  entityId: string;
  factionId: string;
  relations: EntityRelationFinding[];
  fallbackEvidence?: unknown;
  resolveEntityId: (name: string) => string | null | undefined;
  resolveFactionId: (name: string) => string | null | undefined;
}): EvidenceReference[] {
  const relationEvidence = groundedEvidenceReferences(
    ...params.relations
      .filter((relation) =>
        relation.relationType === "member_of" &&
        params.resolveEntityId(relation.subject) === params.entityId &&
        params.resolveFactionId(relation.target) === params.factionId
      )
      .map((relation) => relation.evidence),
  );
  // A cited member_of edge is the narrowest support for the normalized row.
  // Older/model outputs may only attach exact evidence to the parent finding;
  // that remains a grounded fallback, while an empty array stays empty rather
  // than manufacturing a citation.
  return relationEvidence.length > 0
    ? relationEvidence
    : groundedEvidenceReferences(params.fallbackEvidence);
}

export async function persistGeneratedFactionMembership(params: {
  db: Pick<StoryholdDb, "query">;
  entityId: string;
  factionId: string;
  assignmentSource: "local" | "ai";
  confidence: number;
  evidence: EvidenceReference[];
}): Promise<void> {
  await params.db.query(
    `INSERT INTO storyhold.world_entity_faction_memberships
      (entity_id, faction_entity_id, assignment_source, confidence, evidence)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (entity_id, faction_entity_id) DO UPDATE
       SET assignment_source = EXCLUDED.assignment_source,
           confidence = GREATEST(storyhold.world_entity_faction_memberships.confidence,
                                 EXCLUDED.confidence),
           evidence = CASE
             WHEN jsonb_array_length(EXCLUDED.evidence) > 0
             THEN EXCLUDED.evidence
             ELSE storyhold.world_entity_faction_memberships.evidence
           END,
           updated_at = now()
     WHERE storyhold.world_entity_faction_memberships.assignment_source <> 'user'`,
    [
      params.entityId,
      params.factionId,
      params.assignmentSource,
      Math.max(0, Math.min(1, Number(params.confidence ?? 0.5))),
      json(groundedEvidenceReferences(params.evidence)),
    ],
  );
}

export function resolveEntityRuleReference(
  rule: Pick<EntityRuleFinding, "entity" | "name" | "ruleKind">,
  idsByName: Map<string, string | null>,
): { entityId: string | null; issue: WorldReferenceIssue | null } {
  const key = entityReferenceKey(rule.entity);
  const entityId = idsByName.get(key);
  if (entityId) return { entityId, issue: null };
  return {
    entityId: null,
    issue: {
      kind: "entity_rule",
      label: rule.entity,
      resolution: idsByName.has(key) ? "ambiguous" : "missing",
      context: rule.name,
      metadata: { ruleName: rule.name, ruleKind: rule.ruleKind },
    },
  };
}

export async function cleanupCharacterReviewProjections(params: {
  db: StudioDb;
  worldId: string;
  editionId: string;
  analysisKind: AnalysisKind;
  replaceGeneratedSnapshot?: boolean;
}): Promise<void> {
  // Graph decisions do not retract omitted characters. Premium Review must
  // preserve their dossiers and source contributions so existing graph links
  // remain usable; only generated draft proposals are replaced here.
  if (params.analysisKind === "ai_enrichment" && params.replaceGeneratedSnapshot) {
    await params.db.query(
      `UPDATE storyhold.character_drafts
          SET review_status = 'rejected', reviewed_at = now()
        WHERE world_id = $1 AND canon_edition_id = $2
          AND review_status = 'draft'`,
      [params.worldId, params.editionId],
    );
  }
  if (params.analysisKind !== "local_scan") return;
  // Local scans still rebuild inexpensive character leads. Deliberate owner
  // decisions and established enriched dossiers retain their existing guards.
  await params.db.query(
    `UPDATE storyhold.character_dossiers dossier
        SET dossier_status = 'suppressed', updated_at = now()
      WHERE dossier.world_id = $1 AND dossier.canon_edition_id = $2
        AND dossier.canonical_character_id IS NULL
        AND dossier.user_edited_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM storyhold.world_entities entity
           WHERE entity.dossier_id = dossier.id
             AND (entity.classification_source = 'user'
               OR entity.review_status = 'user_confirmed'
               OR entity.pull_status <> 'active')
        )
        AND dossier.role IN ('Unreviewed character or named-entity candidate', 'Detected character candidate')`,
    [params.worldId, params.editionId],
  );
  await params.db.query(
    `UPDATE storyhold.character_drafts draft
        SET review_status = 'rejected', reviewed_at = now()
       FROM storyhold.world_analysis_runs prior_run
      WHERE draft.analysis_run_id = prior_run.id
        AND draft.world_id = $1 AND draft.canon_edition_id = $2
        AND draft.review_status = 'draft'
        AND prior_run.analysis_kind = 'local_scan'`,
    [params.worldId, params.editionId],
  );
}

export async function syncWorldEntities(params: {
  db: StudioDb;
  worldId: string;
  editionId: string;
  findings?: WorldFindings | null;
  runId?: string | null;
  analysisKind?: AnalysisKind;
  replaceGeneratedSnapshot?: boolean;
  premiumGraphReviews?: PremiumGraphReviewReceipt[];
  premiumStatReviews?: PremiumStatReviewReceipt[];
}): Promise<{ referenceIssues: WorldReferenceIssue[]; conflicts?: CohesionFinding[] }> {
  const referenceIssues: WorldReferenceIssue[] = [];
  let findings = params.findings ?? null;
  const premiumGraph = params.analysisKind === "ai_enrichment";
  if (premiumGraph) {
    if (!findings || !params.runId || !params.premiumGraphReviews?.length) {
      throw new Error("Premium graph persistence requires its exact reviewed findings and decision receipts.");
    }
    assertExpectedPremiumGraphReviews(params.premiumGraphReviews, {
      scope: { worldId: params.worldId, editionId: params.editionId, analysisRunId: params.runId },
      expectedStepKeys: params.premiumGraphReviews.map((receipt) => receipt.request.stepKey),
    });
    const reviewed = graphFromPremiumReceipts(params.premiumGraphReviews);
    assertPremiumStatProjection(findings, params.premiumStatReviews ?? []);
    findings = { ...findings, entityRelations: reviewed.entityRelations, entityRules: reviewed.entityRules };
  }
  if (!findings) {
    const breakdown = await params.db.query<Record<string, unknown>>(
      `SELECT * FROM storyhold.world_breakdowns
        WHERE world_id = $1 AND canon_edition_id = $2
        ORDER BY version DESC LIMIT 1`,
      [params.worldId, params.editionId],
    );
    findings = findingsFromBreakdown(breakdown.rows[0]);
  }
  if (!premiumGraph && findings && (params.replaceGeneratedSnapshot || params.analysisKind === "local_scan")) {
    // Premium graph receipts do not authorize hiding omitted or deferred
    // endpoints. Keep them available for verified edges and owner review.
    // A full scan is a snapshot. Retire generated records that disappear from
    // the new snapshot without conflating that with a customer's persistent
    // "do not pull" decision. User-confirmed records are never retired here.
    await params.db.query(
      `UPDATE storyhold.world_entities
          SET scanner_present = false, pull_status = 'do_not_pull', updated_at = now()
        WHERE world_id = $1 AND canon_edition_id = $2
          AND classification_source <> 'user'
          AND review_status <> 'user_confirmed'
          AND pull_status = 'active'
          AND ($3::boolean OR classification_source = 'local')`,
      [params.worldId, params.editionId, params.replaceGeneratedSnapshot === true],
    );
  }
  const membershipLeads = new Map<
    string,
    { names: string[]; source: "local" | "ai"; evidence: unknown[] }
  >();
  const premiumEntityStats = premiumGraph
    ? preparePremiumEntityStatProjection(params.premiumStatReviews ?? [])
    : undefined;
  const syncNamedGroup = async (
    type: EntityType,
    group: NamedFinding[],
  ) => {
    for (const finding of group) {
      const source = premiumGraph || finding.reviewStatus === "verified" ? "ai" : "local";
      const resolvedType = localEntityCategoryFromEvidence(finding.name, finding.evidence, type) as EntityType;
      const contextCard = resolvedType === "cultural_reference" || resolvedType === "term"
        ? localContextCardFromEvidence(resolvedType, finding.name, finding.evidence)
        : null;
      const localPresentation = source === "local" && resolvedType !== "character" && (
        resolvedType !== type || generatedEntityPresentationNeedsRefresh(finding.summary)
      )
        ? localPublicEntitySummaryFromEvidence(resolvedType, finding.name, finding.evidence)
        : null;
      let resolvedFinding: NamedFinding = contextCard || localPresentation
        ? { ...finding, ...(contextCard ?? localPresentation!) }
        : finding;
      if (premiumGraph) {
        // Hypothesis merging/category heuristics may change the target after
        // the original findings gate. Re-project for this exact final family
        // and name; a creature decision cannot authorize a weapon's score.
        resolvedFinding = { ...resolvedFinding, estimatedStats: premiumEntityStats!(
          resolvedType, resolvedFinding.name,
        ) };
      }
      const id = await upsertWorldEntity(params.db, {
        worldId: params.worldId,
        editionId: params.editionId,
        runId: params.runId,
        entityType: resolvedType,
        finding: resolvedFinding,
        classificationSource: source,
        replaceGeneratedSnapshot: params.replaceGeneratedSnapshot,
      });
      if (id && resolvedType !== "character") {
        await params.db.query(
          `UPDATE storyhold.character_dossiers SET dossier_status = 'suppressed', updated_at = now()
            WHERE world_id = $1 AND canon_edition_id = $2 AND normalized_name = $3
              AND user_edited_at IS NULL`,
          [params.worldId, params.editionId, finding.name.trim().toLocaleLowerCase()],
        );
      }
      if (id && finding.factionMemberships?.length) {
        membershipLeads.set(id, {
          names: finding.factionMemberships,
          source,
          evidence: finding.evidence,
        });
      }
    }
  };

  const dossiers = await params.db.query<Record<string, unknown>>(
    `SELECT dossier.*, run.analysis_kind
       FROM storyhold.character_dossiers dossier
       LEFT JOIN storyhold.world_analysis_runs run ON run.id = dossier.source_analysis_run_id
      WHERE dossier.world_id = $1 AND dossier.canon_edition_id = $2
        AND dossier.dossier_status = 'active'`,
    [params.worldId, params.editionId],
  );
  for (const dossier of dossiers.rows) {
    const profile = normalizedDossierProfile(dossier.profile);
    const dossierSource =
      dossier.analysis_kind === "ai_enrichment" ? "ai" : "local";
    const id = await upsertWorldEntity(params.db, {
      worldId: params.worldId,
      editionId: params.editionId,
      runId:
        typeof dossier.source_analysis_run_id === "string"
          ? dossier.source_analysis_run_id
          : params.runId,
      dossierId: String(dossier.id),
      entityType: "character",
      classificationSource: dossierSource,
      replaceGeneratedSnapshot: params.replaceGeneratedSnapshot,
      finding: {
        name: String(dossier.name),
        aliases: Array.isArray(dossier.aliases) ? dossier.aliases as string[] : [],
        summary: textBody(dossier.summary, 4_000),
        details: [
          ...profile.traits,
          ...profile.physicalCharacteristics,
          ...profile.capabilities,
        ],
        relationships: profile.relationships,
        evidence: Array.isArray(dossier.evidence)
          ? dossier.evidence as NamedFinding["evidence"]
          : [],
        confidence: Number(dossier.confidence ?? 0),
        mentionCount: Number(dossier.mention_count ?? 0),
        mentionSourceCount: Number(dossier.mention_source_count ?? 0),
        reviewStatus:
          dossier.analysis_kind === "ai_enrichment" ? "verified" : "candidate",
      },
    });
    const storedFinding = findings?.characters.find(
      (candidate) => candidate.name.toLocaleLowerCase() === String(dossier.name).toLocaleLowerCase(),
    );
    if (id && storedFinding?.factionMemberships.length) {
      membershipLeads.set(id, {
        names: storedFinding.factionMemberships,
        source: dossierSource,
        evidence: storedFinding.evidence,
      });
    }
  }
  if (findings) {
    const primaryFindingNames = new Set(
      [
        ...findings.characters,
        ...findings.ambiguous,
        ...findings.creatures,
        ...findings.species,
        ...findings.locations,
        ...findings.factions,
        ...findings.institutions,
        ...findings.governments,
        ...findings.powerStructures,
        ...findings.technologies,
        ...findings.vehicles,
        ...findings.devices,
        ...findings.weapons,
        ...findings.powers,
        ...findings.titles,
      ].map((finding) => finding.name.trim().toLocaleLowerCase()),
    );
    const hypothesesByName = new Map<string, GeneratedEntityHypothesis[]>();
    const addHypotheses = (entityType: EntityType, group: NamedFinding[]) => {
      for (const finding of group) {
        const key = finding.name.trim().toLocaleLowerCase();
        if (!key) continue;
        const bucket = hypothesesByName.get(key) ?? [];
        bucket.push({ entityType, finding });
        hypothesesByName.set(key, bucket);
      }
    };
    addHypotheses("character", findings.characters);
    addHypotheses("ambiguous", findings.ambiguous);
    addHypotheses("creature", findings.creatures);
    addHypotheses("species", findings.species);
    addHypotheses("place", findings.locations);
    addHypotheses("faction", findings.factions);
    addHypotheses("institution", findings.institutions);
    addHypotheses("government", findings.governments);
    addHypotheses("power_structure", findings.powerStructures);
    addHypotheses("technology", findings.technologies);
    addHypotheses("vehicle", findings.vehicles);
    addHypotheses("device", findings.devices);
    addHypotheses("weapon", findings.weapons);
    addHypotheses("power", findings.powers);
    addHypotheses("title", findings.titles);
    const substantiveDossierNames = new Set(
      dossiers.rows
        .filter((dossier) => generatedCharacterDossierIsSubstantive({
          name: dossier.name,
          summary: dossier.summary,
          role: dossier.role,
          profile: dossier.profile,
          evidence: dossier.evidence,
          canonicalCharacterId: dossier.canonical_character_id,
          mentionCount: dossier.mention_count,
          mentionSourceCount: dossier.mention_source_count,
        }))
        .map((dossier) => textBody(dossier.name, 240).trim().toLocaleLowerCase()),
    );
    for (const [key, hypotheses] of hypothesesByName) {
      const decision = adjudicateGeneratedEntityHypotheses({
        hypotheses,
        hasSubstantiveCharacterDossier: substantiveDossierNames.has(key),
      });
      if (!decision) continue;
      const hasActiveDossier = dossiers.rows.some(
        (dossier) => textBody(dossier.name, 240).trim().toLocaleLowerCase() === key,
      );
      if (decision.entityType === "character" && hasActiveDossier) continue;
      await syncNamedGroup(decision.entityType, [decision.finding]);
    }
    const endpointType = (
      relation: EntityRelationFinding,
      endpoint: "subject" | "target",
    ): EntityType => {
      if (["child_of", "sibling_of", "spouse_of", "friend_of", "best_friend_of"].includes(relation.relationType)) {
        return "character";
      }
      if (endpoint === "subject" && relation.relationType === "leads") return "character";
      if (endpoint === "target") {
        if (["species_of", "subspecies_of", "lifecycle_stage_of"].includes(relation.relationType)) return "species";
        if (relation.relationType === "subtype_of") return "creature";
        if (relation.relationType === "has_power") return "power";
        if (relation.relationType === "holds_title") return "title";
        if (relation.relationType === "located_in") return "place";
      }
      if (relation.relationType === "subspecies_of") return "species";
      if (["subtype_of", "lifecycle_stage_of"].includes(relation.relationType)) return "creature";
      return "ambiguous";
    };
    for (const relation of findings.entityRelations) {
      if (
        !localEntityTextIsUseful(relation.subject) ||
        !localEntityTextIsUseful(relation.target)
      ) continue;
      for (const endpoint of ["subject", "target"] as const) {
        const name = relation[endpoint];
        await upsertWorldEntity(params.db, {
          worldId: params.worldId,
          editionId: params.editionId,
          runId: params.runId,
          entityType: endpointType(relation, endpoint),
          classificationSource: relation.reviewStatus === "verified" ? "ai" : "local",
          // A relation may introduce a genuinely missing endpoint, but it must
          // not flatten an existing paid-review endpoint or a rich primary
          // card that was already written above.
          preserveExisting: premiumGraph || primaryFindingNames.has(
            name.trim().toLocaleLowerCase(),
          ),
          replaceGeneratedSnapshot:
            !premiumGraph && params.replaceGeneratedSnapshot === true &&
            !primaryFindingNames.has(name.trim().toLocaleLowerCase()),
          finding: {
            name,
            summary: relation.summary,
            evidence: relation.evidence,
            aliases: [],
            details: [],
            relationships: [],
            confidence: relation.confidence,
            reviewStatus: relation.reviewStatus,
          },
        });
      }
    }
  }

  if (!premiumGraph && (params.replaceGeneratedSnapshot || params.analysisKind === "local_scan")) {
    await params.db.query(
      `DELETE FROM storyhold.world_entity_faction_memberships membership
        USING storyhold.world_entities entity
        WHERE membership.entity_id = entity.id
          AND entity.world_id = $1 AND entity.canon_edition_id = $2
          AND membership.assignment_source <> 'user'
          AND ($3::boolean OR membership.assignment_source = 'local')`,
      [params.worldId, params.editionId, params.replaceGeneratedSnapshot === true],
    );
  }
  const entities = await params.db.query<Record<string, unknown>>(
    `SELECT id, name, aliases, entity_type, pull_status, scanner_present
       FROM storyhold.world_entities
      WHERE world_id = $1 AND canon_edition_id = $2`,
    [params.worldId, params.editionId],
  );
  const entityResolution = await loadWorldEntityNameResolution({
    db: params.db,
    worldId: params.worldId,
    editionId: params.editionId,
  });
  const factionResolution = await loadWorldEntityNameResolution({
    db: params.db,
    worldId: params.worldId,
    editionId: params.editionId,
    targetEntityTypes: ["faction"],
  });
  const entityByName = entityResolution.idsByName;
  const factionByName = factionResolution.idsByName;
  const entityTypeById = new Map(
    entities.rows.map((entity) => [String(entity.id), String(entity.entity_type) as EntityType]),
  );
  for (const [entityId, membershipLead] of premiumGraph ? [] : membershipLeads) {
    const canonicalEntityId = entityResolution.canonicalIdByEntityId.get(entityId);
    const entity = entities.rows.find(
      (candidate) => candidate.id === canonicalEntityId,
    );
    if (
      !canonicalEntityId ||
      !entity ||
      entity.pull_status !== "active" ||
      entity.scanner_present !== true ||
      !["character", "creature"].includes(String(entity.entity_type))
    ) continue;
    for (const factionName of membershipLead.names) {
      const factionKey = entityReferenceKey(factionName);
      const factionId = factionByName.get(factionKey);
      if (!factionId) {
        referenceIssues.push({
          kind: "faction_membership",
          label: factionName,
          resolution: factionByName.has(factionKey) ? "ambiguous" : "missing",
          context: String(entity.name),
          metadata: {
            entityId: canonicalEntityId,
            entityName: String(entity.name),
          },
        });
        continue;
      }
      if (factionId === canonicalEntityId) continue;
      const evidence = factionMembershipEvidence({
        entityId: canonicalEntityId,
        factionId,
        relations: findings?.entityRelations ?? [],
        fallbackEvidence: membershipLead.evidence,
        resolveEntityId: (name) => entityByName.get(entityReferenceKey(name)),
        resolveFactionId: (name) => factionByName.get(entityReferenceKey(name)),
      });
      await persistGeneratedFactionMembership({
        db: params.db,
        entityId: canonicalEntityId,
        factionId,
        assignmentSource: membershipLead.source,
        confidence: 0.65,
        evidence,
      });
    }
  }

  if (!premiumGraph && (params.replaceGeneratedSnapshot || params.analysisKind === "local_scan")) {
    await params.db.query(
      `DELETE FROM storyhold.world_entity_relations
        WHERE world_id = $1 AND canon_edition_id = $2
          AND assignment_source <> 'user'
          AND ($3::boolean OR assignment_source = 'local')`,
      [params.worldId, params.editionId, params.replaceGeneratedSnapshot === true],
    );
    await params.db.query(
      `DELETE FROM storyhold.world_entity_rules
        WHERE world_id = $1 AND canon_edition_id = $2
          AND assignment_source <> 'user'
          AND ($3::boolean OR assignment_source = 'local')`,
      [params.worldId, params.editionId, params.replaceGeneratedSnapshot === true],
    );
  }
  if (!findings) return { referenceIssues };
  if (premiumGraph) {
    const saved = await syncPremiumVerifiedGraph(params.db, params.premiumGraphReviews!, {
      canPassRelation: relationEntityTypesAreCompatible,
      assertRelationSemantics: assertPremiumRelationSemantics,
    });
    return { referenceIssues: [...referenceIssues, ...saved.referenceIssues], conflicts: saved.conflicts };
  }

  // Faction assignments already live in the normalized membership table and
  // power both sides of the dossier UI. Do not manufacture a second
  // `member_of` relation with empty evidence. A relationship row is written
  // only when the analysis supplied a separately cited relationship finding.
  for (const relation of findings.entityRelations) {
    if (
      !localEntityTextIsUseful(relation.subject) ||
      !localEntityTextIsUseful(relation.target)
    ) continue;
    const sourceKey = entityReferenceKey(relation.subject);
    const targetKey = entityReferenceKey(relation.target);
    const sourceEntityId = entityByName.get(sourceKey);
    const targetEntityId = entityByName.get(targetKey);
    if (!sourceEntityId) {
      referenceIssues.push({
        kind: "relation_subject",
        label: relation.subject,
        resolution: entityByName.has(sourceKey) ? "ambiguous" : "missing",
        context: `${relation.subject} ${relation.relationType} ${relation.target}`,
      });
    }
    if (!targetEntityId) {
      referenceIssues.push({
        kind: "relation_target",
        label: relation.target,
        resolution: entityByName.has(targetKey) ? "ambiguous" : "missing",
        context: `${relation.subject} ${relation.relationType} ${relation.target}`,
      });
    }
    if (!sourceEntityId || !targetEntityId || sourceEntityId === targetEntityId) continue;
    if (
      relation.reviewStatus !== "verified" &&
      !relation.evidence.some((evidence) => relationHasDirectPredicateSupport({
        subject: relation.subject,
        target: relation.target,
        relationType: relation.relationType,
        quote: evidence.quote,
      }))
    ) continue;
    const sourceType = entityTypeById.get(sourceEntityId);
    const targetType = entityTypeById.get(targetEntityId);
    if (
      !sourceType || !targetType ||
      !relationEntityTypesAreCompatible(relation.relationType, sourceType, targetType)
    ) {
      referenceIssues.push({
        kind: "relation_target",
        label: `${relation.subject} ${relation.relationType} ${relation.target}`,
        resolution: "ambiguous",
        context: `Rejected category mismatch: ${sourceType ?? "unknown"} cannot use ${relation.relationType} with ${targetType ?? "unknown"}`,
      });
      continue;
    }
    const assignmentSource = relation.reviewStatus === "verified" ? "ai" : "local";
    await params.db.query(
      `INSERT INTO storyhold.world_entity_relations
        (id, world_id, canon_edition_id, source_entity_id, relation_type,
         target_entity_id, relation_status, summary, valid_from_label,
         valid_until_label, evidence, assignment_source, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
       ON CONFLICT (world_id, canon_edition_id, source_entity_id, relation_type,
                    target_entity_id, relation_status, valid_from_label, valid_until_label)
       DO UPDATE SET summary = EXCLUDED.summary,
                     evidence = CASE
                       WHEN jsonb_array_length(EXCLUDED.evidence) > 0
                       THEN EXCLUDED.evidence
                       ELSE storyhold.world_entity_relations.evidence
                     END,
                     confidence = GREATEST(storyhold.world_entity_relations.confidence,
                                           EXCLUDED.confidence),
                     updated_at = now()
       WHERE storyhold.world_entity_relations.assignment_source <> 'user'`,
      [
        randomUUID(), params.worldId, params.editionId, sourceEntityId,
        relation.relationType, targetEntityId, relation.status,
        relation.summary, relation.validFromLabel, relation.validUntilLabel,
        json(relation.evidence), assignmentSource,
        Math.max(0, Math.min(1, Number(relation.confidence ?? 0.5))),
      ],
    );
  }
  for (const rule of findings.entityRules) {
    const ruleReference = resolveEntityRuleReference(rule, entityByName);
    if (ruleReference.issue) {
      referenceIssues.push(ruleReference.issue);
      continue;
    }
    const entityId = ruleReference.entityId!;
    const fingerprint = createHash("sha256")
      .update(`${rule.entity}\n${rule.ruleKind}\n${rule.name}`.toLocaleLowerCase())
      .digest("hex")
      .slice(0, 20);
    const assignmentSource = rule.reviewStatus === "verified" ? "ai" : "local";
    await params.db.query(
      `INSERT INTO storyhold.world_entity_rules
        (id, world_id, canon_edition_id, entity_id, canonical_key, name,
         description, rule_kind, trigger_text, effect_text, evidence,
         assignment_source, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
       ON CONFLICT (world_id, canon_edition_id, entity_id, canonical_key)
       DO UPDATE SET name = EXCLUDED.name,
                     description = EXCLUDED.description,
                     trigger_text = EXCLUDED.trigger_text,
                     effect_text = EXCLUDED.effect_text,
                     evidence = EXCLUDED.evidence,
                     confidence = GREATEST(storyhold.world_entity_rules.confidence,
                                           EXCLUDED.confidence),
                     updated_at = now()
       WHERE storyhold.world_entity_rules.assignment_source <> 'user'`,
      [
        randomUUID(), params.worldId, params.editionId, entityId,
        `rule-${fingerprint}`, rule.name, rule.description, rule.ruleKind,
        rule.trigger, rule.effect, json(rule.evidence), assignmentSource,
        Math.max(0, Math.min(1, Number(rule.confidence ?? 0.5))),
      ],
    );
  }
  return { referenceIssues };
}

export async function replayGeneratedWorldEntityGraph(
  db: StudioDb,
  worldId: string,
  editionId: string,
) {
  return syncWorldEntities({
    db,
    worldId,
    editionId,
    analysisKind: "local_scan",
    replaceGeneratedSnapshot: true,
  });
}

async function ensureWorldEntities(
  db: StudioDb,
  worldId: string,
  editionId: string,
) {
  const existing = await db.query<{ found: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM storyhold.world_entities
        WHERE world_id = $1 AND canon_edition_id = $2
     ) AS found`,
    [worldId, editionId],
  );
  if (!existing.rows[0]?.found) {
    await ensureCharacterDossiersForWorld(db, worldId, editionId);
    await syncWorldEntities({ db, worldId, editionId });
  }
}

async function ensureEntityCharacterDossier(
  db: StudioDb,
  params: {
    worldId: string;
    editionId: string;
    entity: Record<string, unknown>;
    canonicalCharacterId?: string | null;
  },
): Promise<string> {
  if (typeof params.entity.dossier_id === "string") {
    await db.query(
      `UPDATE storyhold.character_dossiers
          SET canonical_character_id = COALESCE(canonical_character_id, $2),
              dossier_status = 'active', updated_at = now()
        WHERE id = $1`,
      [params.entity.dossier_id, params.canonicalCharacterId ?? null],
    );
    return params.entity.dossier_id;
  }
  const dossierId = randomUUID();
  const normalizedDossierName = params.canonicalCharacterId
    ? campaignCharacterNormalizedName(
        String(params.entity.name),
        params.canonicalCharacterId,
      )
    : params.entity.normalized_name;
  const dossier = await db.query<{ id: string }>(
    `INSERT INTO storyhold.character_dossiers
      (id, world_id, canon_edition_id, canonical_character_id,
       source_analysis_run_id,
       canonical_key, normalized_name, name, aliases, role, summary,
       profile, evidence, confidence, dossier_status, axis_estimate,
       mention_count, mention_source_count, user_edited_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
              CASE WHEN $17 THEN 'User-confirmed character' ELSE 'Character Under Review' END,
              $10, $11::jsonb, $12::jsonb,
             $13, 'active', $14::jsonb, $15, $16,
             CASE WHEN $17 THEN now() ELSE NULL END)
     ON CONFLICT (world_id, canon_edition_id, normalized_name) DO UPDATE
       SET canonical_character_id = COALESCE(
             storyhold.character_dossiers.canonical_character_id,
             EXCLUDED.canonical_character_id),
           dossier_status = 'active', name = EXCLUDED.name,
           aliases = EXCLUDED.aliases, summary = CASE
             WHEN EXCLUDED.summary <> '' THEN EXCLUDED.summary
             ELSE storyhold.character_dossiers.summary END,
           user_edited_at = CASE WHEN $17
             THEN COALESCE(storyhold.character_dossiers.user_edited_at, now())
             ELSE storyhold.character_dossiers.user_edited_at END,
           updated_at = now()
     RETURNING id`,
    [
      dossierId,
      params.worldId,
      params.editionId,
      params.canonicalCharacterId ?? null,
      params.entity.source_analysis_run_id ?? null,
      `${slug(String(params.entity.name))}-${dossierId.slice(0, 8)}`,
      normalizedDossierName,
      params.entity.name,
      json(params.entity.aliases ?? []),
      params.entity.summary ?? "",
      json(normalizedDossierProfile({})),
      json(params.entity.evidence ?? []),
      Number(params.entity.confidence ?? 1),
      json(dossierAxis({})),
      Number(params.entity.mention_count ?? 0),
      Number(params.entity.mention_source_count ?? 0),
      params.entity.classification_source === "user" ||
        params.entity.review_status === "user_confirmed",
    ],
  );
  const id = dossier.rows[0]?.id ?? dossierId;
  params.entity.dossier_id = id;
  await db.query(
    `UPDATE storyhold.world_entities SET dossier_id = $2, updated_at = now()
      WHERE id = $1`,
    [params.entity.id, id],
  );
  return id;
}

export function campaignCharacterNormalizedName(
  name: string,
  characterId: string,
) {
  return `${name.trim().toLocaleLowerCase()}--campaign-character-${characterId.toLocaleLowerCase()}`;
}

async function ensureCanonicalCharacterEntity(
  db: StudioDb,
  params: {
    worldId: string;
    editionId: string;
    characterId: string;
    name: string;
    concept?: string;
    preferredEntityId?: string | null;
  },
) {
  let entity: Record<string, unknown> | undefined;
  if (params.preferredEntityId) {
    const selected = await db.query<Record<string, unknown>>(
      `SELECT entity.*, dossier.canonical_character_id AS bound_character_id
         FROM storyhold.world_entities entity
         LEFT JOIN storyhold.character_dossiers dossier ON dossier.id = entity.dossier_id
        WHERE entity.id = $1 AND entity.world_id = $2
          AND entity.canon_edition_id = $3 AND entity.entity_type = 'character'
        LIMIT 1`,
      [params.preferredEntityId, params.worldId, params.editionId],
    );
    entity = selected.rows[0];
    if (!entity) {
      throw new Error("The selected Hold entity is not a character in this world.");
    }
    if (
      typeof entity.bound_character_id === "string" &&
      entity.bound_character_id !== params.characterId
    ) {
      throw new Error("The selected Hold character is already bound to another character.");
    }
  } else {
    const existing = await db.query<Record<string, unknown>>(
      `SELECT entity.*, dossier.canonical_character_id AS bound_character_id
         FROM storyhold.world_entities entity
         JOIN storyhold.character_dossiers dossier ON dossier.id = entity.dossier_id
        WHERE entity.world_id = $1 AND entity.canon_edition_id = $2
          AND entity.entity_type = 'character'
          AND dossier.canonical_character_id = $3
        ORDER BY CASE WHEN entity.pull_status = 'active' THEN 0 ELSE 1 END,
                 entity.updated_at DESC
        LIMIT 1`,
      [params.worldId, params.editionId, params.characterId],
    );
    entity = existing.rows[0];
  }
  if (entity) {
    const updated = await db.query<Record<string, unknown>>(
      `UPDATE storyhold.world_entities
          SET name = $4,
              summary = CASE WHEN summary = '' THEN $5 ELSE summary END,
              classification_source = 'user', review_status = 'user_confirmed',
              pull_status = 'active', scanner_present = true,
              merged_into_entity_id = NULL, updated_at = now()
        WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3
        RETURNING *`,
      [
        entity.id,
        params.worldId,
        params.editionId,
        params.name,
        params.concept ?? "",
      ],
    );
    entity = updated.rows[0] ?? entity;
  } else {
    const entityId = randomUUID();
    const normalizedName = campaignCharacterNormalizedName(
      params.name,
      params.characterId,
    );
    const inserted = await db.query<Record<string, unknown>>(
      `INSERT INTO storyhold.world_entities
        (id, world_id, canon_edition_id, canonical_key, normalized_name,
         name, entity_type, summary, confidence, classification_source,
         review_status, pull_status, scanner_present)
       VALUES ($1, $2, $3, $4, $5, $6, 'character', $7, 1,
               'user', 'user_confirmed', 'active', true)
       RETURNING *`,
      [
        entityId,
        params.worldId,
        params.editionId,
        `${slug(params.name)}-${entityId.slice(0, 8)}`,
        normalizedName,
        params.name,
        params.concept ?? "",
      ],
    );
    entity = inserted.rows[0];
  }
  if (!entity) throw new Error("The campaign character could not be added to the Hold.");
  const dossierId = await ensureEntityCharacterDossier(db, {
    worldId: params.worldId,
    editionId: params.editionId,
    entity,
    canonicalCharacterId: params.characterId,
  });
  return { entityId: String(entity.id), dossierId };
}

export function serializeWorldEntity(
  row: Record<string, unknown>,
  memberships: Array<Record<string, unknown>>,
) {
  const rawStats = row.estimated_stats;
  const estimatedStats = rawStats && typeof rawStats === "object" && !Array.isArray(rawStats) && Object.keys(rawStats).length
    ? dossierStatBlock(rawStats)
    : null;
  const evidence = Array.isArray(row.evidence) ? row.evidence : [];
  const entityType = textBody(row.entity_type, 40) as EntityType;
  const safePresentation = generatedEntityPresentationNeedsRefresh(row.summary) &&
    row.classification_source !== "user" && row.review_status !== "user_confirmed"
    ? localPublicEntitySummaryFromEvidence(
        entityType,
        textBody(row.name, 240),
        evidence as EvidenceReference[],
      )
    : null;
  const mentionCount = Math.max(0, Number(row.mention_count ?? 0));
  const mentionSourceCount = Math.max(0, Number(row.mention_source_count ?? 0));
  const mentionCountStatus = mentionCount > 0
    ? "exact"
    : String(row.classification_source) === "user" && evidence.length === 0
      ? "manual"
      : evidence.length > 0
        ? "derived"
        : "no_exact_mentions";
  return {
    id: row.id,
    canonicalKey: row.canonical_key,
    dossierId: row.dossier_id ?? null,
    name: row.name,
    entityType,
    aliases: Array.isArray(row.aliases) ? row.aliases : [],
    summary: safePresentation?.summary ?? row.summary ?? "",
    details: safePresentation?.details ?? (Array.isArray(row.details) ? row.details : []),
    relationships: Array.isArray(row.relationships) ? row.relationships : [],
    estimatedStats,
    evidence,
    mentionCount,
    mentionSourceCount,
    mentionCountStatus,
    confidence: Number(row.confidence ?? 0),
    reviewStatus: row.review_status,
    pullStatus: row.pull_status,
    mergedIntoEntityId: row.merged_into_entity_id ?? null,
    factions: memberships.map((membership) => ({
      id: membership.faction_entity_id,
      name: membership.faction_name,
      confidence: Number(membership.confidence ?? 0),
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function serializeEntityRelation(row: Record<string, unknown>) {
  const storedSummary = textBody(row.summary, 1_000);
  const sourceName = textBody(row.source_name, 240);
  const targetName = textBody(row.target_name, 240);
  const summary = /\b(?:GLiNER|MiniLM|BGE|Qwen|local\s+(?:pass|model|reader)|connected\s+AI|backend|extraction)\b/iu.test(storedSummary)
    ? sourceName && targetName
      ? `${sourceName} and ${targetName} are connected in the cited manuscript passage; the exact nature or timeframe remains uncertain.`
      : "The cited manuscript passage supports this connection, though its exact nature or timeframe remains uncertain."
    : storedSummary;
  return {
    id: row.id,
    sourceEntityId: row.source_entity_id,
    sourceName: row.source_name,
    sourceType: row.source_type,
    relationType: row.relation_type,
    targetEntityId: row.target_entity_id,
    targetName: row.target_name,
    targetType: row.target_type,
    status: row.relation_status,
    summary,
    validFromLabel: row.valid_from_label ?? "",
    validUntilLabel: row.valid_until_label ?? "",
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    confidence: Number(row.confidence ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function serializeEntityRule(row: Record<string, unknown>) {
  return {
    id: row.id,
    entityId: row.entity_id,
    canonicalKey: row.canonical_key,
    name: row.name,
    description: row.description ?? "",
    ruleKind: row.rule_kind,
    trigger: row.trigger_text ?? "",
    effect: row.effect_text ?? "",
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    confidence: Number(row.confidence ?? 0),
    status: row.rule_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeEntityAction(row: Record<string, unknown>) {
  return {
    id: row.id,
    actionType: row.action_type,
    summary: row.summary,
    createdAt: row.created_at,
    undoneAt: row.undone_at ?? null,
  };
}

function exactEntityMentionPattern(names: string[]) {
  const escaped = names
    .map((name) => name.trim())
    .filter((name) => name.length >= 2)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((left, right) => right.length - left.length);
  if (!escaped.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join("|")})(?![\\p{L}\\p{N}])`, "giu");
}

type EntityReviewRetrievalExpansion = {
  summary: { searchedItems: number; addedPassages: number; noMatchItems: number;
    budgetDeferredItems: number; alreadyCoveredItems: number; skippedReviews: number };
  items: ReturnType<typeof planEntityProseRetrieval>["items"];
  sourceReviewIds: string[];
  searchedChunkCount: number;
};

async function entityReviewContext(params: {
  db: StudioDb;
  playerId: string;
  world: { id: string; name: string; premise: string; genre: string };
  editionId: string;
  entityId: string;
  depth: EntityReviewDepth;
  userGuidance?: string;
  reviewId?: string;
  includeGraphReview?: boolean;
}): Promise<{
  entityRow: Record<string, unknown>;
  input: EntityReviewInput;
  mentionCount: number;
  mentionSourceCount: number;
  entityIdsByName: Map<string, string>;
  retrievalExpansion?: EntityReviewRetrievalExpansion;
  selectedPassages: Array<{
    chunkId: string;
    sourceId: string;
    sourceTitle: string;
    passageNumber: number;
    excerpt: string;
    nameMatches: number;
    guidanceTerms: string[];
  }>;
}> {
  const entityResult = await params.db.query<Record<string, unknown>>(
    `SELECT * FROM storyhold.world_entities
      WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3
        AND pull_status = 'active'
      LIMIT 1`,
    [params.entityId, params.world.id, params.editionId],
  );
  const entityRow = entityResult.rows[0];
  if (!entityRow) throw new Error("This Storyhold dossier is not available.");
  if (params.includeGraphReview && (!persistedLocalEntityIsConnectionEligible(entityRow) || entityRow.merged_into_entity_id != null)) {
    throw new Error("This dossier is no longer available for a connected review. Reopen its current record before continuing.");
  }
  const currentDossierResult = typeof entityRow.dossier_id === "string"
    ? await params.db.query<Record<string, unknown>>(
        "SELECT * FROM storyhold.character_dossiers WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3 LIMIT 1",
        [entityRow.dossier_id, params.world.id, params.editionId],
      )
    : { rows: [] as Record<string, unknown>[] };
  const currentDossier = currentDossierResult.rows[0];
  // Keep raw slots before presentation/prompt normalization. Saved reviews
  // restore their original inventory; only fresh preparation searches again.
  const existingProseReview = params.includeGraphReview ? buildExistingProseInventory({
    aliases: entityRow.aliases, summary: entityRow.summary, details: entityRow.details, relationships: entityRow.relationships,
  }, currentDossier ? {
    aliases: currentDossier.aliases, summary: currentDossier.summary, role: currentDossier.role, profile: currentDossier.profile,
  } : undefined) : undefined;
  const currentProfile = normalizedDossierProfile(currentDossier?.profile);
  const currentCharacter: CharacterFinding | undefined = currentDossier
    ? {
        name: textBody(currentDossier.name, 240),
        aliases: stringList(currentDossier.aliases, 40, 240),
        role: textBody(currentDossier.role, 240),
        summary: textBody(currentDossier.summary, 4_000),
        traits: currentProfile.traits,
        motivations: currentProfile.motivations,
        fears: currentProfile.fears,
        capabilities: currentProfile.capabilities,
        history: currentProfile.history,
        origins: currentProfile.origins,
        powers: currentProfile.powers,
        moralSystem: currentProfile.moralSystem,
        physicalCharacteristics: currentProfile.physicalCharacteristics,
        relationships: currentProfile.relationships,
        relationshipWeb: currentProfile.relationshipWeb as CharacterFinding["relationshipWeb"],
        estimatedStats: currentProfile.estimatedStats as CharacterFinding["estimatedStats"],
        socioPoliticalAxis: dossierAxis(currentDossier.axis_estimate),
        knowledge: currentProfile.knowledge,
        secrets: currentProfile.secrets,
        factionMemberships: [],
        evidence: storedEvidence(currentDossier.evidence),
        confidence: Number(currentDossier.confidence ?? 0),
        mentionCount: Number(currentDossier.mention_count ?? 0),
        mentionSourceCount: Number(currentDossier.mention_source_count ?? 0),
        reviewStatus: "candidate",
      }
    : undefined;
  const knownResult = await params.db.query<Record<string, unknown>>(
    `SELECT id, name, entity_type, aliases
       FROM storyhold.world_entities
      WHERE world_id = $1 AND canon_edition_id = $2 AND pull_status = 'active'
        ${params.includeGraphReview ? "AND merged_into_entity_id IS NULL AND (scanner_present = true OR classification_source = 'user' OR review_status = 'user_confirmed')" : ""}
      ORDER BY mention_count DESC, name ASC`,
    [params.world.id, params.editionId],
  );
  const [conceptContext, ownerConstraints] = await Promise.all([
    conceptResolutionContext({
      db: params.db,
      worldId: params.world.id,
      editionId: params.editionId,
      entityId: params.entityId,
    }),
    loadOwnerCanonConstraints({
      db: params.db,
      worldId: params.world.id,
      editionId: params.editionId,
      entityId: params.entityId,
      includeWorld: true,
    }),
  ]);
  const aliases = Array.isArray(entityRow.aliases)
    ? entityRow.aliases.filter((value): value is string => typeof value === "string")
    : [];
  const pattern = exactEntityMentionPattern([String(entityRow.name), ...aliases]);
  const chunkResult = params.includeGraphReview
    ? { rows: await loadEntityReviewManuscriptChunks(params.db, {
      playerId: params.playerId, worldId: params.world.id, editionId: params.editionId,
    }) }
    : await params.db.query<EntityReviewSourceChunk>(
    `SELECT chunk.id, chunk.source_id, source.title AS source_title,
            chunk.chunk_index, chunk.content, chunk.metadata
       FROM storyhold.world_source_chunks chunk
       JOIN storyhold.world_sources source ON source.id = chunk.source_id
      WHERE chunk.world_id = $1 AND chunk.canon_edition_id = $2
        AND source.processing_status = 'ready'
        AND source.canon_status IN ('candidate', 'canon')
      ORDER BY source.chronology_order ASC, source.sort_order ASC,
               source.created_at ASC, chunk.chunk_index ASC`,
    [params.world.id, params.editionId],
  );
  const guidance = textBody(params.userGuidance, 2_000);
  const guidanceTerms = [...new Set(
    guidance
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}][\p{L}\p{N}'’-]{2,}/gu) ?? [],
  )].filter((term) => ![
    "about", "actually", "after", "again", "also", "because", "being",
    "does", "from", "have", "into", "just", "not", "over", "part",
    "should", "that", "their", "them", "this", "through", "what", "when",
    "where", "which", "with", "would",
  ].includes(term)).slice(0, 24);
  let mentionCount = 0;
  const mentionSources = new Set<string>();
  const pointOfViewPattern = exactEntityMentionPattern([String(entityRow.name), ...aliases]);
  const ranked = chunkResult.rows.flatMap((row) => {
    let matches = 0;
    let firstNameMatch = -1;
    if (pattern) {
      pattern.lastIndex = 0;
      const nameMatches = [...row.content.matchAll(pattern)];
      matches = nameMatches.length;
      firstNameMatch = nameMatches[0]?.index ?? -1;
    }
    mentionCount += matches;
    if (matches) mentionSources.add(row.source_id);
    const lower = row.content.toLocaleLowerCase();
    const matchedGuidanceTerms = guidanceTerms.filter((term) => lower.includes(term));
    const guidanceHits = matchedGuidanceTerms.length;
    const sectionTitle = textBody(recordBody(row.metadata).sectionTitle, 240);
    if (pointOfViewPattern) pointOfViewPattern.lastIndex = 0;
    const pointOfView = String(entityRow.entity_type) === "character" &&
      Boolean(sectionTitle) &&
      Boolean(pointOfViewPattern?.test(sectionTitle)) &&
      /\b(?:chapter|part|present|past|pov|point\s+of\s+view)\b/iu.test(sectionTitle);
    if (!matches && !guidanceHits && !(params.depth === "full" && pointOfView)) return [];
    const chapterMarkers = row.content.match(/\bchapter\s+\d+\b/giu)?.length ?? 0;
    const tableOfContentsLike = chapterMarkers >= 5;
    const firstGuidanceMatch = matchedGuidanceTerms.reduce((first, term) => {
      const index = lower.indexOf(term);
      return index >= 0 && (first < 0 || index < first) ? index : first;
    }, -1);
    return [{
      row,
      matches,
      guidanceHits,
      matchedGuidanceTerms,
      pointOfView,
      tableOfContentsLike,
      firstMatch: firstNameMatch >= 0 ? firstNameMatch : firstGuidanceMatch,
      score: matches * 8 + guidanceHits * 3 + (pointOfView ? 4 : 0) - (tableOfContentsLike ? 100 : 0),
    }];
  }).sort((left, right) =>
    right.score - left.score ||
    right.guidanceHits - left.guidanceHits ||
    left.row.chunk_index - right.row.chunk_index
  );
  const passageLimit = params.depth === "full" ? (guidance ? 36 : 28) : (guidance ? 16 : 12);
  const selected: typeof ranked = [];
  const selectedIds = new Set<string>();
  const add = (candidate: typeof ranked[number] | undefined) => {
    if (!candidate || selectedIds.has(candidate.row.id) || selected.length >= passageLimit) return;
    selectedIds.add(candidate.row.id);
    selected.push(candidate);
  };
  const meaningfulMentions = ranked.filter((candidate) =>
    !candidate.tableOfContentsLike && (candidate.matches > 0 || candidate.guidanceHits > 0),
  );
  for (const candidate of meaningfulMentions.slice(0, params.depth === "full" ? 16 : passageLimit)) add(candidate);
  if (params.depth === "full") {
    const pointOfViewRows = ranked
      .filter((candidate) => candidate.pointOfView && !candidate.tableOfContentsLike && !selectedIds.has(candidate.row.id))
      .sort((left, right) => left.row.chunk_index - right.row.chunk_index);
    const pointOfViewQuota = Math.min(10, pointOfViewRows.length);
    for (let index = 0; index < pointOfViewQuota; index += 1) {
      const sourceIndex = pointOfViewQuota === 1
        ? 0
        : Math.round(index * (pointOfViewRows.length - 1) / (pointOfViewQuota - 1));
      add(pointOfViewRows[sourceIndex]);
    }
  }
  for (const candidate of ranked.filter((candidate) => !candidate.tableOfContentsLike)) add(candidate);
  for (const candidate of ranked) add(candidate);
  const chunks: AnalysisChunk[] = selected.map(({ row }) => ({
    id: row.id,
    sourceId: row.source_id,
    sourceTitle: row.source_title,
    index: Number(row.chunk_index),
    content: row.content,
  }));
  let retrievalExpansion: EntityReviewRetrievalExpansion | undefined;
  if (existingProseReview) {
    const pending = await loadEntityProseRetrievalLeads(params.db, {
      playerId: params.playerId, worldId: params.world.id, editionId: params.editionId, entityId: params.entityId,
    }, existingProseReview);
    if (pending.leads.length || pending.skippedReviews) {
      const plan = planEntityProseRetrieval({ leads: pending.leads, selectedChunks: chunks,
        chunks: chunkResult.rows.map((row) => ({ id: row.id, sourceId: row.source_id,
          sourceTitle: row.source_title, index: Number(row.chunk_index), content: row.content })),
        target: { name: String(entityRow.name), aliases }, depth: params.depth,
      });
      const rowsById = new Map(chunkResult.rows.map((row) => [row.id, row]));
      for (const chunk of plan.chunks) {
        const row = rowsById.get(chunk.id);
        if (!row || row.content !== chunk.content || row.source_id !== chunk.sourceId) {
          throw new Error("The additional manuscript passages changed while this review was being prepared. Reopen the review to try again.");
        }
        if (selectedIds.has(row.id)) continue;
        const leads = pending.leads.filter((lead) => plan.items.some((item) => item.itemId === lead.item.itemId
          && item.selectedChunkIds.includes(row.id)));
        const terms = [...new Set(leads.flatMap((lead) => retrievalTokens([lead.item.text, ...lead.requests].join(" "))))];
        const lower = row.content.toLocaleLowerCase();
        const matchedTerms = terms.filter((term) => lower.includes(term));
        const firstMatch = matchedTerms.reduce((first, term) => Math.min(first, lower.indexOf(term)), row.content.length);
        selectedIds.add(row.id);
        selected.push({ row, matches: 0, guidanceHits: 0, matchedGuidanceTerms: [], pointOfView: false,
          tableOfContentsLike: false, firstMatch: firstMatch === row.content.length ? 0 : firstMatch, score: 0 });
        chunks.push(chunk);
      }
      retrievalExpansion = { summary: {
        searchedItems: plan.items.length, addedPassages: plan.chunks.length,
        noMatchItems: plan.items.filter((item) => item.status === "no_match").length,
        budgetDeferredItems: plan.budgetDeferredItems,
        alreadyCoveredItems: plan.items.filter((item) => item.status === "already_selected").length,
        skippedReviews: pending.skippedReviews,
      }, items: plan.items, searchedChunkCount: plan.searchedChunkCount,
        sourceReviewIds: [...new Set(pending.leads.map((lead) => lead.reviewId))] };
    }
  }
  const entityIdsByName = new Map<string, string>();
  const knownEntities = knownResult.rows.map((row) => {
    const knownAliases = Array.isArray(row.aliases)
      ? row.aliases.filter((value): value is string => typeof value === "string")
      : [];
    entityIdsByName.set(String(row.name).toLocaleLowerCase(), String(row.id));
    knownAliases.forEach((alias) => entityIdsByName.set(alias.toLocaleLowerCase(), String(row.id)));
    return {
      name: String(row.name),
      entityType: String(row.entity_type),
      aliases: knownAliases,
    };
  });
  let graphReview: EntityGraphContext | undefined;
  if (params.includeGraphReview) {
    // No LIMIT: an oversized inventory must be detected before dispatch, not
    // silently made to look fully reviewed. Hidden/merged identities are not
    // eligible new endpoints, but their existing records remain untouched.
    const relations = await params.db.query<Record<string, unknown>>(
      `SELECT relation.*, subject.name AS subject_name, target.name AS target_name
       FROM storyhold.world_entity_relations relation
       JOIN storyhold.world_entities subject ON subject.id = relation.source_entity_id
       JOIN storyhold.world_entities target ON target.id = relation.target_entity_id
       WHERE relation.world_id = $1 AND relation.canon_edition_id = $2
         AND (relation.source_entity_id = $3 OR relation.target_entity_id = $3)
         AND subject.world_id = $1 AND target.world_id = $1
         AND subject.canon_edition_id = $2 AND target.canon_edition_id = $2
         AND subject.pull_status = 'active' AND target.pull_status = 'active'
         AND subject.merged_into_entity_id IS NULL AND target.merged_into_entity_id IS NULL
         AND (subject.scanner_present = true OR subject.classification_source = 'user' OR subject.review_status = 'user_confirmed')
         AND (target.scanner_present = true OR target.classification_source = 'user' OR target.review_status = 'user_confirmed')
       ORDER BY relation.id`, [params.world.id, params.editionId, params.entityId],
    );
    const rules = await params.db.query<Record<string, unknown>>(
      `SELECT * FROM storyhold.world_entity_rules
       WHERE world_id = $1 AND canon_edition_id = $2 AND entity_id = $3 AND rule_status = 'active'
       ORDER BY id`, [params.world.id, params.editionId, params.entityId],
    );
    graphReview = {
      version: 2,
      entities: knownResult.rows.map((row, index) => ({ id: String(row.id), ...knownEntities[index]! })),
      relations: relations.rows.map((row) => ({
        subject: String(row.subject_name), target: String(row.target_name),
        relationType: row.relation_type as EntityRelationFinding["relationType"],
        status: row.relation_status as EntityRelationFinding["status"],
        summary: String(row.summary ?? ""), validFromLabel: String(row.valid_from_label ?? ""),
        validUntilLabel: String(row.valid_until_label ?? ""), evidence: storedEvidence(row.evidence),
        confidence: Number(row.confidence ?? 0),
      })),
      rules: rules.rows.map((row) => ({
        entity: String(entityRow.name), name: String(row.name), description: String(row.description ?? ""),
        ruleKind: row.rule_kind as EntityRuleFinding["ruleKind"], trigger: String(row.trigger_text ?? ""),
        effect: String(row.effect_text ?? ""), evidence: storedEvidence(row.evidence), confidence: Number(row.confidence ?? 0),
      })),
    };
  }
  return {
    entityRow,
    mentionCount,
    mentionSourceCount: mentionSources.size,
    entityIdsByName,
    ...(retrievalExpansion ? { retrievalExpansion } : {}),
    selectedPassages: selected.map(({ row, matches, matchedGuidanceTerms, firstMatch }) => {
      const excerptStart = Math.max(0, firstMatch - 100);
      const rawExcerpt = row.content.slice(excerptStart, excerptStart + 360);
      return {
        chunkId: row.id,
        sourceId: row.source_id,
        sourceTitle: row.source_title,
        passageNumber: Number(row.chunk_index) + 1,
        excerpt: `${excerptStart > 0 ? "\u2026" : ""}${rawExcerpt.replace(/\s+/g, " ").trim()}${excerptStart + 360 < row.content.length ? "\u2026" : ""}`,
        nameMatches: matches,
        guidanceTerms: matchedGuidanceTerms,
      };
    }),
    input: {
      worldName: String(params.world.name),
      worldPremise: textBody(params.world.premise, 6_000),
      worldGenre: textBody(params.world.genre, 240),
      entity: {
        id: String(entityRow.id),
        name: String(entityRow.name),
        entityType: String(entityRow.entity_type),
        aliases,
        summary: textBody(entityRow.summary, 4_000),
        details: stringList(entityRow.details, 80, 600),
        relationships: stringList(entityRow.relationships, 80, 600),
        estimatedStats: recordBody(entityRow.estimated_stats) as Partial<CharacterFinding["estimatedStats"]>,
      },
      chunks,
      knownEntities,
      currentCharacter,
      depth: params.depth,
      userGuidance: guidance,
      ownerCanonConstraints: ownerConstraints.map(({ id, kind, instruction }) => ({
        id, kind, instruction,
      })),
      conceptResolutionContext: conceptContext,
      ...(graphReview ? { graphReview, proseReview: { version: 1 as const }, existingProseReview,
        ...(entityRow.entity_type === "character" && currentDossier ? { compassReview: {
          version: 1 as const, currentEstimate: currentDossier.axis_estimate ?? {}, ownerOverride: currentDossier.axis_user_override ?? null,
        } } : {}),
      } : {}),
      ...(params.reviewId ? { premiumStatScope: {
        worldId: params.world.id, editionId: params.editionId, analysisRunId: params.reviewId,
      } } : {}),
    },
  };
}

type PreparedEntityReviewContext = Awaited<ReturnType<typeof entityReviewContext>>;

async function entityReviewEdition(db: StudioDb, worldId: string, entityId: string): Promise<{ id: string } | null> {
  // The canonical target owns its edition. Changing the world's default must
  // not strand an earlier paid response or silently move it into another edition.
  return (await db.query<{ id: string }>(
    "SELECT canon_edition_id AS id FROM storyhold.world_entities WHERE id = $1 AND world_id = $2",
    [entityId, worldId],
  )).rows[0] ?? null;
}

function frozenEntityReviewContext(context: PreparedEntityReviewContext, canonFingerprint: string): JsonObject {
  return JSON.parse(JSON.stringify({ version: 1, canonFingerprint, ...context,
    entityIdsByName: [...context.entityIdsByName.entries()],
  })) as JsonObject;
}

function restoreEntityReviewContext(snapshot: JsonObject): PreparedEntityReviewContext {
  if (snapshot.version !== 1 || typeof snapshot.canonFingerprint !== "string"
    || !snapshot.input || !snapshot.entityRow || !Array.isArray(snapshot.entityIdsByName)
    || !Array.isArray(snapshot.selectedPassages)) {
    throw new EntityReviewJournalError("CONTEXT_INVALID", "The saved dossier context cannot be restored.");
  }
  return { ...snapshot, entityIdsByName: new Map(snapshot.entityIdsByName as [string, string][]) } as unknown as PreparedEntityReviewContext;
}

/** Resume only unstarted pages. Completed pages and their provider usage stay
 * in the original journal; changed source/model settings never widen the job. */
export async function continueSavedEntityReviewPages(db: StudioRootDb, scope: EntityReviewCallScope): Promise<void> {
  const call = await readEntityReviewCall(db, scope);
  if (!call || call.finalization_snapshot || call.status !== "dispatched") return;
  const context = restoreEntityReviewContext(call.context_snapshot);
  if (context.input.graphReview?.version !== 2) return;
  const prepared = premiumEntityReviewPages(context.input);
  const frozen = call.request_snapshot.pages as unknown as EntityReviewJournalPage[];
  if (!Array.isArray(frozen) || frozen.length !== prepared.length || frozen.some((page, index) => page.stepKey !== prepared[index]!.stepKey)) {
    throw new EntityReviewJournalError("REQUEST_MISMATCH", "The saved dossier page plan cannot be restored.");
  }
  const pages = frozen.map((page, index) => ({ ...page, request: { ...page.request, validate: prepared[index]!.request.validate } }));
  await executeJournaledEntityReviewPages(db, {
    scope, reservationId: call.reservation_id, contextSnapshot: call.context_snapshot, pages,
    beforePage: async (page) => {
      const runtime = getAiRuntimeStatus("canon_review", "standard", "dossier");
      if (!runtime.configured || runtime.provider !== page.provider || runtime.model !== page.model) {
        throw new Error("Restore this review's original AI connection before continuing. Completed work is saved and will not be repeated.");
      }
      if (!call.unlimited) {
        const currentEstimate = creditsForReservationQuote(
          quoteEntityReviewReservation(context.input),
        );
        if (currentEstimate > call.reserved_credits) {
          const account = await db.query<{ credits: number }>(
            "SELECT credits FROM storyhold.players WHERE id = $1 LIMIT 1",
            [scope.playerId],
          );
          const availableForSettlement = Number(call.reserved_credits) +
            Number(account.rows[0]?.credits ?? 0);
          if (currentEstimate > availableForSettlement) {
            throw new CreditEconomyError(
              "INSUFFICIENT_CREDITS",
              "The dossier review estimate increased and the remaining balance cannot cover it yet.",
              currentEstimate,
              availableForSettlement,
            );
          }
        }
      }
      const current = await entityReviewCanonFingerprint(db, scope, context.input.chunks.map((chunk) => chunk.id), false, context.input.proseReview ? 2 : 1);
      if (current !== call.context_snapshot.canonFingerprint) {
        throw new Error("Your canon or manuscript changed while this review was paused. Completed work is saved, but further paid reading is stopped pending review.");
      }
    },
    invoke: (page) => generateAiText(page.request),
  });
}

/** No provider dependency: this resumes the saved response even after a key or
 * configured model changes. Only the exact frozen source/context is used. */
export async function finishSavedEntityReview(db: StudioRootDb, scope: EntityReviewCallScope): Promise<JsonObject> {
  return finishJournaledEntityReview(db, { scope, apply: async (tx, snapshot, result) => {
    const context = restoreEntityReviewContext(snapshot);
    const currentFingerprint = await entityReviewCanonFingerprint(tx, scope, context.input.chunks.map((chunk) => chunk.id), true, context.input.proseReview ? 2 : 1);
    if (currentFingerprint !== snapshot.canonFingerprint) throw new EntityReviewStaleCanonError();
    const reviewed = reviewEntityFromSavedResult(context.input, result);
    if (reviewed.graphReview) await saveEntityReviewVerificationBundle(tx, scope, { version: 1, graph: reviewed.graphReview });
    if (reviewed.graphReviews) await saveEntityReviewVerificationBundle(tx, scope, reviewed.proseReview
      ? reviewed.existingProseReviews
        ? reviewed.compassReview
          ? { version: 5, graphs: reviewed.graphReviews, prose: reviewed.proseReview, existingProse: reviewed.existingProseReviews, compass: reviewed.compassReview }
          : { version: 4, graphs: reviewed.graphReviews, prose: reviewed.proseReview, existingProse: reviewed.existingProseReviews }
        : { version: 3, graphs: reviewed.graphReviews, prose: reviewed.proseReview }
      : { version: 2, graphs: reviewed.graphReviews });
    const saved = await saveEntityReview({ db: tx, worldId: scope.worldId, editionId: scope.editionId, context,
      finding: reviewed.finding, reviewMode: "premium", statReviews: reviewed.statReviews,
      graphReview: reviewed.graphReview, graphReviews: reviewed.graphReviews, proseReview: reviewed.proseReview, compassReview: reviewed.compassReview, graphScope: scope });
    await refreshCanonicalMentionCounts({ db: tx, worldId: scope.worldId, editionId: scope.editionId });
    const existingDecisions = reviewed.existingProseReviews?.flatMap((receipt) => receipt.decisions);
    const attentionCount = existingDecisions?.filter((decision) => decision.verdict === "contradicted").length ?? 0;
    const missingCount = existingDecisions?.filter((decision) => decision.verdict === "needs_more_evidence").length ?? 0;
    return { reviewId: scope.reviewId, depth: context.input.depth, passageCount: context.input.chunks.length,
      ...(context.retrievalExpansion ? { retrievalExpansion: context.retrievalExpansion.summary } : {}),
      ...(existingDecisions ? { existingProseAudit: { reviewedItems: existingDecisions.length,
        supportedItems: existingDecisions.filter((decision) => decision.verdict === "supported").length,
        needsAttentionItems: attentionCount, needsEvidenceItems: missingCount } } : {}),
      warnings: [...saved.warnings,
        ...(attentionCount ? [`${attentionCount} existing dossier ${attentionCount === 1 ? "detail needs" : "details need"} attention. See Evidence by Section; existing text was not automatically deleted.`] : []),
        ...(missingCount ? [`${missingCount} existing dossier ${missingCount === 1 ? "detail needs" : "details need"} more evidence. Unresolved interpretations were preserved.`] : []),
      ] };
  } });
}

function browserEntityReviewUsage(
  context: Awaited<ReturnType<typeof entityReviewContext>>,
  reported?: { inputTokens?: unknown; outputTokens?: unknown; reviewJson?: string },
) {
  const promptCharacters =
    JSON.stringify(context.selectedPassages).length +
    JSON.stringify(context.input.entity).length +
    textBody(context.input.userGuidance, 2_000).length +
    4_000;
  const minimumInputTokens = estimatedTokensFromCharacters(promptCharacters);
  const minimumOutputTokens = reported?.reviewJson
    ? estimatedTokensFromCharacters(reported.reviewJson.length)
    : 0;
  return {
    inputTokens: Math.max(
      minimumInputTokens,
      Math.max(0, Math.ceil(Number(reported?.inputTokens) || 0)),
    ),
    outputTokens: reported
      ? Math.max(
          minimumOutputTokens,
          Math.max(0, Math.ceil(Number(reported.outputTokens) || 0)),
        )
      : context.input.depth === "full" ? 3_500 : 1_800,
  };
}

export async function saveEntityReview(params: {
  db: StudioDb;
  worldId: string;
  editionId: string;
  context: Awaited<ReturnType<typeof entityReviewContext>>;
  finding: Awaited<ReturnType<typeof reviewEntity>>["finding"];
  reviewMode: "premium" | "local";
  statReviews?: PremiumStatReviewReceipt[];
  graphReview?: PremiumGraphReviewReceipt;
  graphReviews?: PremiumGraphReviewReceipt[];
  proseReview?: EntityProseReviewReceipt;
  compassReview?: EntityCompassReviewReceipt;
  graphScope?: EntityReviewCallScope;
}) {
  const { entityIdsByName } = params.context;
  const input = params.context.input;
  if (params.reviewMode !== "premium" && params.reviewMode !== "local") {
    throw new Error("Dossier persistence requires an explicit review mode.");
  }
  const premium = params.reviewMode === "premium";
  const entityRow = (await params.db.query<Record<string, unknown>>(
    `SELECT * FROM storyhold.world_entities
      WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3 FOR UPDATE`,
    [input.entity.id, params.worldId, params.editionId],
  )).rows[0];
  if (!entityRow || entityRow.name !== input.entity.name || entityRow.entity_type !== input.entity.entityType
    || entityRow.pull_status !== "active" || entityRow.merged_into_entity_id != null
    || (entityRow.dossier_id ?? null) !== (params.context.entityRow.dossier_id ?? null)) {
    throw new Error("This dossier changed while its review was running. Reopen the dossier before reviewing it again.");
  }
  // A previously paid legacy response keeps its supported prose/stat work,
  // but cannot acquire new graph authority merely by being replayed today.
  const legacyGraphHeld = premium && !input.graphReview && (
    params.finding.relations.length > 0 || params.finding.rules.length > 0 || params.finding.relationships.length > 0
    || Boolean(params.finding.character?.relationships.length || params.finding.character?.relationshipWeb.length
      || params.finding.character?.factionMemberships.length));
  let finding = premium && !input.graphReview ? {
    ...params.finding, relations: [], rules: [], relationships: [],
    character: params.finding.character ? { ...params.finding.character, relationships: [], relationshipWeb: [], factionMemberships: [] } : null,
  } : params.finding;
  let graphSaved: PremiumGraphSyncResult | undefined;
  let proseSaved: Awaited<ReturnType<typeof syncEntityVerifiedProse>> | undefined;
  let compassSaved: Awaited<ReturnType<typeof syncEntityVerifiedCompass>> | undefined;
  if (premium) {
    if (input.premiumStatScope?.worldId !== params.worldId || input.premiumStatScope.editionId !== params.editionId) {
      throw new Error("The dossier review belongs to a different world or edition.");
    }
    const projected = projectEntityReviewedStats(input, finding, params.statReviews ?? []);
    const statFields = (value: typeof finding) => ({ estimatedStats: value.estimatedStats,
      characterStats: value.character?.estimatedStats ?? null });
    if (lorekeeperSnapshotFingerprint(statFields(projected)) !== lorekeeperSnapshotFingerprint(statFields(finding))) {
      throw new Error("The dossier's new stat estimates do not match their exact verified decisions.");
    }
    // A source can be replaced, excluded, or deleted while the provider is
    // working. Lock/recheck the actual submitted text before saving authority.
    const rows = (await params.db.query<{ id: string; source_id: string; content: string }>(
      `SELECT chunk.id, chunk.source_id, chunk.content FROM storyhold.world_source_chunks chunk
        JOIN storyhold.world_sources source ON source.id = chunk.source_id
        WHERE chunk.world_id = $1 AND chunk.canon_edition_id = $2
          AND source.world_id = $1 AND source.canon_edition_id = $2
          AND chunk.id = ANY($3::uuid[]) AND source.processing_status = 'ready'
          AND source.canon_status IN ('candidate', 'canon') FOR SHARE OF chunk, source`,
      [params.worldId, params.editionId, input.chunks.map((chunk) => chunk.id)],
    )).rows;
    const byId = new Map(rows.map((row) => [row.id, row]));
    if (!input.chunks.length || byId.size !== input.chunks.length || input.chunks.some((chunk) => {
      const row = byId.get(chunk.id);
      return !row || row.source_id !== chunk.sourceId || row.content !== chunk.content;
    })) throw new Error("The manuscript changed during this review. No dossier changes were saved.");
    await saveEntityStatReviews(params.db, { input, receipts: params.statReviews ?? [] });
    if (input.graphReview) {
      const pagedGraph = input.graphReview.version === 2 && !input.graphReview.page;
      if (pagedGraph) assertEntityGraphReviews(input, params.graphReviews ?? []);
      else assertEntityGraphReview(input, params.graphReview);
      if (!(pagedGraph ? params.graphReviews?.length : params.graphReview) || !params.graphScope || params.graphScope.entityId !== input.entity.id
        || params.graphScope.worldId !== params.worldId || params.graphScope.editionId !== params.editionId
        || params.graphScope.reviewId !== input.premiumStatScope.analysisRunId) {
        throw new Error("Dossier graph verification: the saved review scope is missing or changed.");
      }
      const projectedGraph = pagedGraph ? projectEntityReviewedGraphs(input, finding, params.graphReviews!)
        : projectEntityReviewedGraph(input, finding, params.graphReview);
      const graphFields = (value: typeof finding) => ({ relations: value.relations, rules: value.rules,
        relationships: value.relationships, characterRelationships: value.character?.relationships ?? [],
        relationshipWeb: value.character?.relationshipWeb ?? [], factionMemberships: value.character?.factionMemberships ?? [] });
      if (lorekeeperSnapshotFingerprint(graphFields(projectedGraph)) !== lorekeeperSnapshotFingerprint(graphFields(finding))) {
        throw new Error("Dossier graph verification: the proposed updates differ from their verified decisions.");
      }
      // Resolve the frozen identity map before this same transaction adds aliases.
      graphSaved = await syncEntityVerifiedGraph(params.db, params.graphScope, pagedGraph ? params.graphReviews! : params.graphReview!, {
        canPassRelation: relationEntityTypesAreCompatible, assertRelationSemantics: assertPremiumRelationSemantics,
      });
      // Evidence approval is not permission to overwrite an owner record or
      // ignore category checks. Display only relations actually linked to canon.
      const relationKey = (relation: EntityRelationFinding) => lorekeeperSnapshotFingerprint({
        subject: relation.subject, target: relation.target, relationType: relation.relationType,
        status: relation.status, validFromLabel: relation.validFromLabel, validUntilLabel: relation.validUntilLabel,
        summary: relation.summary,
      });
      const applied = new Set((graphSaved.appliedRelations ?? []).map(relationKey));
      const keep = finding.relations.map((relation) => applied.has(relationKey(relation)));
      const relations = finding.relations.filter((_, index) => keep[index]);
      const graphNameKey = (name: string) => name.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
      // All used endpoints already passed the adapter's ambiguity check.
      const graphIdentity = (name: string) => input.graphReview!.entities.find((entity) =>
        [entity.name, ...entity.aliases].some((alias) => graphNameKey(alias) === graphNameKey(name)))?.id;
      const currentFactions = new Set(relations.filter((relation) => graphIdentity(relation.subject) === input.entity.id)
        .filter((relation) => relation.relationType === "member_of"
        && relation.status === "active" && !relation.validFromLabel.trim() && !relation.validUntilLabel.trim())
        .map((relation) => graphIdentity(relation.target)));
      finding = { ...finding, relations, relationships: finding.relationships.filter((_, index) => keep[index]),
        character: finding.character ? { ...finding.character,
          relationships: finding.character.relationships.filter((_, index) => keep[index]),
          relationshipWeb: finding.character.relationshipWeb.filter((_, index) => keep[index]),
          factionMemberships: finding.character.factionMemberships.filter((name) => currentFactions.has(graphIdentity(name))),
        } : null };
    } else if (params.graphReview || params.graphReviews) {
      throw new Error("Dossier graph verification: an older saved review cannot gain a new proof.");
    }
    if (input.proseReview) {
      assertEntityProseReview(input, params.proseReview);
      if (!params.proseReview || !params.graphScope) throw new Error("Dossier prose verification: the paid review proof is missing.");
      const projectedProse = projectEntityReviewedProse(input, finding, params.proseReview);
      if (lorekeeperSnapshotFingerprint(entityProseFields(projectedProse)) !== lorekeeperSnapshotFingerprint(entityProseFields(finding))) {
        throw new Error("Dossier prose verification: display fields differ from their exact reviewed items.");
      }
      proseSaved = await syncEntityVerifiedProse(params.db, params.graphScope, params.proseReview);
      // Evidence acceptance cannot override owner-controlled fields. Use only
      // items the canonical writer actually applied, preserving all graph/stat
      // outputs and retaining withheld decisions in the private audit.
      finding = projectEntityReviewedProse(input, finding, params.proseReview, { includedProposalIds: proseSaved.appliedProposalIds });
    } else if (params.proseReview) {
      throw new Error("Dossier prose verification: an older saved review cannot gain a new proof.");
    }
    assertEntityCompassReview(input, params.compassReview);
    if (input.compassReview) {
      if (!params.compassReview || !params.graphScope) throw new Error("Dossier compass verification: the saved review scope is missing.");
      compassSaved = await syncEntityVerifiedCompass(params.db, params.graphScope, params.compassReview);
    }
  }
  const warnings = [
    ...(legacyGraphHeld ? ["This saved review predates the current connection and rule checks. Its supported dossier and ability updates were kept; connection and rule changes were not applied."] : []),
    ...(graphSaved?.conflicts.map((conflict) => conflict.summary) ?? []),
    ...(graphSaved?.referenceIssues.length ? ["Some connections could not be matched safely to existing records and were left unchanged."] : []),
    ...(proseSaved?.warnings ?? []),
    ...(compassSaved?.warnings ?? []),
  ];
  const hasReviewedStats = Object.values(finding.character?.estimatedStats ?? finding.estimatedStats ?? {})
    .some((value) => value && !isNeutralPremiumStatEstimate(value));
  if (premium && input.graphReview?.version === 2 && !hasEntityReviewProse(finding)
    && !hasReviewedStats && !graphSaved?.relationsSaved && !graphSaved?.rulesSaved) {
    // Rejections/unresolved decisions are valid, billable review work. Keep
    // their private audit without upgrading an untouched local dossier or
    // manufacturing a blank character profile. Finalization still settles it.
    return { warnings: [...warnings, ...(input.existingProseReview?.items.length || input.compassReview ? []
      : ["This review did not establish any supported dossier changes. Your existing dossier and its review status were left unchanged."])] };
  }
  const ownerEntity = entityRow.classification_source === "user" || entityRow.review_status === "user_confirmed";
  const preserveStatNames = async (stats: unknown): Promise<Set<string>> => new Set(premium ? [] : await currentEntityPremiumStatNames(params.db, {
    worldId: params.worldId, editionId: params.editionId, entityId: input.entity.id,
    entityType: input.entity.entityType, name: input.entity.name, stats,
  }));
  const protectedEntityStats = await preserveStatNames(entityRow.estimated_stats);
  const incomingEntityStats = Object.fromEntries(Object.entries(finding.estimatedStats ?? {}).filter(
    ([name, value]) => !ownerEntity && !protectedEntityStats.has(name) && !isNeutralPremiumStatEstimate(value),
  ));
  const mergeStoredStrings = premium ? appendDossierStrings : dossierStrings;
  const aliases = mergeStoredStrings(entityRow.aliases, finding.aliases);
  const details = mergeStoredStrings(entityRow.details, finding.details);
  const relationships = mergeStoredStrings(entityRow.relationships, finding.relationships);
  const evidence = mergeEntityEvidence(entityRow.evidence, finding.evidence);
  if (!ownerEntity) await params.db.query(
    `UPDATE storyhold.world_entities
        SET aliases = $4::jsonb,
            summary = CASE WHEN $5 <> '' THEN $5 ELSE summary END,
            details = $6::jsonb, relationships = $7::jsonb, evidence = $8::jsonb,
            mention_count = GREATEST(mention_count, $9),
            mention_source_count = GREATEST(mention_source_count, $10),
            confidence = GREATEST(confidence, $11),
            estimated_stats = CASE
              WHEN $12::jsonb <> '{}'::jsonb THEN estimated_stats || $12::jsonb
              ELSE estimated_stats
            END,
            classification_source = CASE WHEN $13 OR classification_source = 'ai' THEN 'ai' ELSE 'local' END,
            review_status = CASE WHEN $13 OR review_status = 'verified' THEN 'verified' ELSE 'candidate' END,
            updated_at = now()
      WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3`,
    [
      entityRow.id, params.worldId, params.editionId, json(aliases), finding.summary,
      json(details), json(relationships), json(evidence), params.context.mentionCount,
      params.context.mentionSourceCount, finding.confidence,
      json(incomingEntityStats), premium,
    ],
  );
  if (finding.character && entityRow.entity_type === "character") {
    const dossierId = await ensureEntityCharacterDossier(params.db, {
      worldId: params.worldId,
      editionId: params.editionId,
      entity: entityRow,
    });
    const currentResult = await params.db.query<Record<string, unknown>>(
      "SELECT * FROM storyhold.character_dossiers WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3 FOR UPDATE",
      [dossierId, params.worldId, params.editionId],
    );
    const current = currentResult.rows[0];
    if (!current || current.normalized_name !== input.entity.name.trim().toLocaleLowerCase()) {
      throw new Error("The character dossier no longer matches the reviewed identity.");
    }
    const currentProfile = normalizedDossierProfile(current.profile);
    const incomingProfile = profileFromCharacterFinding(finding.character);
    const storedProfile = premium ? recordBody(current.profile) : currentProfile;
    const mergedProfile = {
      ...normalizedDossierProfile({
        ...currentProfile,
        relationshipWeb: dossierConnections(currentProfile.relationshipWeb, incomingProfile.relationshipWeb),
        estimatedStats: mergeReviewedStatEstimates(currentProfile.estimatedStats, incomingProfile.estimatedStats),
      }),
      // Restore raw stored prose after normalization; deduplicating it would
      // shift exact audit slots even when only an ability/connection changed.
      traits: mergeStoredStrings(storedProfile.traits, incomingProfile.traits),
      motivations: mergeStoredStrings(storedProfile.motivations, incomingProfile.motivations),
      fears: mergeStoredStrings(storedProfile.fears, incomingProfile.fears),
      capabilities: mergeStoredStrings(storedProfile.capabilities, incomingProfile.capabilities),
      history: mergeStoredStrings(storedProfile.history, incomingProfile.history),
      origins: mergeStoredStrings(storedProfile.origins, incomingProfile.origins),
      powers: mergeStoredStrings(storedProfile.powers, incomingProfile.powers),
      moralSystem: mergeStoredStrings(storedProfile.moralSystem, incomingProfile.moralSystem),
      physicalCharacteristics: mergeStoredStrings(storedProfile.physicalCharacteristics, incomingProfile.physicalCharacteristics),
      relationships: mergeStoredStrings(storedProfile.relationships, incomingProfile.relationships),
      knowledge: mergeStoredStrings(storedProfile.knowledge, incomingProfile.knowledge),
      secrets: mergeStoredStrings(storedProfile.secrets, incomingProfile.secrets),
    };
    const protectedCharacterStats = await preserveStatNames(currentProfile.estimatedStats);
    for (const name of protectedCharacterStats) {
      const stat = name as keyof CharacterFinding["estimatedStats"];
      mergedProfile.estimatedStats[stat] = currentProfile.estimatedStats[stat];
    }
    if (!ownerEntity && !dossierIsCustomerEdited(current)) await params.db.query(
      `UPDATE storyhold.character_dossiers
          SET aliases = $2::jsonb,
              role = CASE WHEN $3 <> '' THEN $3 ELSE role END,
              summary = CASE WHEN $4 <> '' THEN $4 ELSE summary END,
              profile = $5::jsonb, evidence = $6::jsonb,
              confidence = GREATEST(confidence, $7),
              axis_estimate = CASE WHEN $11 OR axis_estimate ? 'perspective' THEN axis_estimate ELSE $8::jsonb END,
              mention_count = GREATEST(mention_count, $9),
              mention_source_count = GREATEST(mention_source_count, $10),
              dossier_status = 'active', updated_at = now()
        WHERE id = $1`,
      [
        dossierId,
        json(mergeStoredStrings(current.aliases, finding.character.aliases, aliases)),
        finding.character.role,
        finding.character.summary || finding.summary,
        json(mergedProfile),
        json(mergeEntityEvidence(current.evidence, finding.character.evidence, finding.evidence)),
        Math.max(finding.confidence, finding.character.confidence),
        json(dossierAxis(finding.character.socioPoliticalAxis)),
        params.context.mentionCount,
        params.context.mentionSourceCount,
        Boolean(input.compassReview),
      ],
    );
  }
  if (proseSaved?.appliedProposalIds.size && params.proseReview) {
    // Keep the exact-display invariant even though persisted lists no longer
    // share extraction limits. Any future lossy transformation must roll back,
    // leaving the paid response recoverable rather than dropping verified text.
    const storedEntity = (await params.db.query<Record<string, unknown>>(
      "SELECT * FROM storyhold.world_entities WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3",
      [input.entity.id, params.worldId, params.editionId],
    )).rows[0]!;
    const storedDossier = storedEntity.dossier_id ? (await params.db.query<Record<string, unknown>>(
      "SELECT * FROM storyhold.character_dossiers WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3",
      [storedEntity.dossier_id, params.worldId, params.editionId],
    )).rows[0] : undefined;
    const storedProfile = normalizedDossierProfile(storedDossier?.profile);
    const exactItem = (value: unknown, expected: string) => Array.isArray(value) && value.includes(expected);
    for (const item of params.proseReview.projection.filter((item) => proseSaved!.appliedProposalIds.has(item.proposalId))) {
      let persisted: boolean;
      if (item.field === "summary") persisted = storedEntity.summary === finding.summary
        && (input.entity.entityType !== "character" || storedDossier?.summary === finding.character?.summary);
      else if (item.field === "aliases") persisted = exactItem(storedEntity.aliases, item.text)
        && (input.entity.entityType !== "character" || exactItem(storedDossier?.aliases, item.text));
      else if (item.field === "details") persisted = exactItem(storedEntity.details, item.text);
      else if (item.field === "role") persisted = storedDossier?.role === item.text;
      else persisted = exactItem(storedProfile[item.field], item.text);
      if (!persisted) throw new Error(`Dossier prose verification: saved ${item.field} could not retain its complete verified display. No partial dossier update was applied.`);
    }
  }
  if (premium) await linkEntityStatReviewsToCanon(params.db, { input, receipts: params.statReviews ?? [] });
  for (const relation of premium ? [] : finding.relations) {
    const sourceId = entityIdsByName.get(relation.subject.toLocaleLowerCase());
    const targetId = entityIdsByName.get(relation.target.toLocaleLowerCase());
    if (!sourceId || !targetId || sourceId === targetId ||
        (sourceId !== entityRow.id && targetId !== entityRow.id)) continue;
    await params.db.query(
      `INSERT INTO storyhold.world_entity_relations
        (id, world_id, canon_edition_id, source_entity_id, relation_type,
         target_entity_id, relation_status, summary, valid_from_label,
         valid_until_label, evidence, assignment_source, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'ai', $12)
       ON CONFLICT (world_id, canon_edition_id, source_entity_id, relation_type,
                    target_entity_id, relation_status, valid_from_label, valid_until_label)
       DO UPDATE SET
         summary = EXCLUDED.summary,
         evidence = EXCLUDED.evidence,
         assignment_source = 'ai',
         confidence = GREATEST(storyhold.world_entity_relations.confidence, EXCLUDED.confidence),
         updated_at = now()
       WHERE storyhold.world_entity_relations.assignment_source <> 'user'`,
      [
        randomUUID(), params.worldId, params.editionId, sourceId, relation.relationType,
        targetId, relation.status, relation.summary, relation.validFromLabel,
        relation.validUntilLabel, json(relation.evidence), relation.confidence,
      ],
    );
    if (relation.relationType === "member_of") {
      const targetType = params.context.input.knownEntities.find((entry) =>
        entityIdsByName.get(entry.name.toLocaleLowerCase()) === targetId
      )?.entityType;
      const sourceType = params.context.input.knownEntities.find((entry) =>
        entityIdsByName.get(entry.name.toLocaleLowerCase()) === sourceId
      )?.entityType;
      if (canProjectCurrentFactionMembership(relation, targetType, sourceType)) {
        await params.db.query(
          `INSERT INTO storyhold.world_entity_faction_memberships
            (entity_id, faction_entity_id, assignment_source, confidence, evidence)
           VALUES ($1, $2, 'ai', $3, $4::jsonb)
           ON CONFLICT (entity_id, faction_entity_id) DO UPDATE
             SET assignment_source = 'ai',
                 confidence = GREATEST(storyhold.world_entity_faction_memberships.confidence, EXCLUDED.confidence),
                 evidence = EXCLUDED.evidence,
                 updated_at = now()
           WHERE storyhold.world_entity_faction_memberships.assignment_source <> 'user'`,
          [sourceId, targetId, relation.confidence, json(relation.evidence)],
        );
      }
    }
  }
  for (const rule of premium ? [] : finding.rules) {
    await params.db.query(
      `INSERT INTO storyhold.world_entity_rules
        (id, world_id, canon_edition_id, entity_id, canonical_key, name,
         description, rule_kind, trigger_text, effect_text, evidence,
         assignment_source, confidence, rule_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               $11::jsonb, 'ai', $12, 'active')
       ON CONFLICT (world_id, canon_edition_id, entity_id, canonical_key) DO UPDATE
         SET description = EXCLUDED.description,
             trigger_text = EXCLUDED.trigger_text,
             effect_text = EXCLUDED.effect_text,
             evidence = EXCLUDED.evidence,
             assignment_source = 'ai',
             confidence = GREATEST(storyhold.world_entity_rules.confidence, EXCLUDED.confidence),
             updated_at = now()
       WHERE storyhold.world_entity_rules.assignment_source <> 'user'`,
      [
        randomUUID(), params.worldId, params.editionId, entityRow.id,
        `${slug(rule.name)}-${createHash("sha256").update(rule.name.toLocaleLowerCase()).digest("hex").slice(0, 10)}`,
        rule.name, rule.description, rule.ruleKind, rule.trigger, rule.effect,
        json(rule.evidence), rule.confidence,
      ],
    );
  }
  await params.db.query("UPDATE storyhold.worlds SET updated_at = now() WHERE id = $1", [params.worldId]);
  return { warnings };
}

async function saveBreakdown(params: {
  db: StudioDb;
  worldId: string;
  editionId: string;
  runId: string;
  provider: string;
  model: string;
  findings: WorldFindings;
}) {
  const versionResult = await params.db.query<{ version: number }>(
    `SELECT COALESCE(max(version), 0)::int + 1 AS version
       FROM storyhold.world_breakdowns
      WHERE world_id = $1 AND canon_edition_id = $2`,
    [params.worldId, params.editionId],
  );
  const version = Number(versionResult.rows[0]?.version ?? 1);
  await params.db.query(
    `INSERT INTO storyhold.world_breakdowns
      (id, world_id, canon_edition_id, analysis_run_id, version, provider, model, summary,
       genres, atmosphere, themes, world_rules, locations, factions, institutions,
       governments, power_structures, creatures, species, technologies, vehicles,
       devices, weapons, powers, titles,
       entity_relations, entity_rules, ambiguous_labels, claims, chronology,
       open_questions, recurring_terms, evidence_graph)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb,
             $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb,
             $18::jsonb, $19::jsonb, $20::jsonb, $21::jsonb, $22::jsonb, $23::jsonb,
             $24::jsonb, $25::jsonb, $26::jsonb, $27::jsonb, $28::jsonb, $29::jsonb,
             $30::jsonb, $31::jsonb, $32::jsonb, $33::jsonb)`,
    [
      randomUUID(),
      params.worldId,
      params.editionId,
      params.runId,
      version,
      params.provider,
      params.model,
      params.findings.summary,
      json(params.findings.genres),
      json(params.findings.atmosphere),
      json(params.findings.themes),
      json(params.findings.worldRules),
      json(params.findings.locations),
      json(params.findings.factions),
      json(params.findings.institutions),
      json(params.findings.governments),
      json(params.findings.powerStructures),
      json(params.findings.creatures),
      json(params.findings.species),
      json(params.findings.technologies),
      json(params.findings.vehicles),
      json(params.findings.devices),
      json(params.findings.weapons),
      json(params.findings.powers),
      json(params.findings.titles),
      json(params.findings.entityRelations),
      json(params.findings.entityRules),
      json(params.findings.ambiguous),
      json(params.findings.claims ?? []),
      json(params.findings.chronology),
      json(params.findings.openQuestions),
      json(params.findings.recurringTerms),
      json(params.findings),
    ],
  );
  await params.db.query(
    `UPDATE storyhold.world_analysis_runs
        SET evidence_graph_fingerprint = $2
      WHERE id = $1`,
    [params.runId, lorekeeperSnapshotFingerprint(params.findings)],
  );
}

async function syncCanonClockEvents(params: {
  db: StudioDb;
  worldId: string;
  editionId: string;
  findings: WorldFindings;
  replaceSnapshot?: boolean;
}) {
  const participants: PersistableWorldEventParticipant[] = [];
  const relations: PersistableWorldEventRelation[] = [];
  const activeEventIds: string[] = [];
  await params.db.query(
    `UPDATE storyhold.world_clock_events event
        SET visibility = 'studio', knowledge_status = 'inferred'
      WHERE event.world_id = $1 AND event.canon_edition_id = $2
        AND event.campaign_id IS NULL
        AND event.created_by_player_id IS NULL
        AND event.assignment_source = 'local'
        AND event.canonical_key LIKE 'source-chapter-v1-%'
        AND NOT EXISTS (
          SELECT 1 FROM storyhold.world_clock_event_verifications verified
           WHERE verified.event_id = event.id
        )`,
    [params.worldId, params.editionId],
  );
  if (params.replaceSnapshot) {
    // Older Codex-assisted imports used a separate, evidence-free key space.
    // Retire only those generated legacy rows during a complete replacement;
    // customer-authored and campaign events remain untouched.
    await params.db.query(
      `UPDATE storyhold.world_clock_events event
          SET visibility = 'studio', knowledge_status = 'inferred'
        WHERE event.world_id = $1 AND event.canon_edition_id = $2
          AND event.campaign_id IS NULL
          AND event.created_by_player_id IS NULL
          AND event.assignment_source = 'local'
          AND event.canonical_key LIKE 'codex-canon-%'
          AND NOT EXISTS (
            SELECT 1 FROM storyhold.world_clock_event_verifications verified
             WHERE verified.event_id = event.id
          )`,
      [params.worldId, params.editionId],
    );
  }
  for (let index = 0; index < params.findings.chronology.length; index += 1) {
    const finding = params.findings.chronology[index]!;
    const fingerprint = createHash("sha256")
      .update(`${params.editionId}\n${finding.name}\n${finding.summary}`)
      .digest("hex")
      .slice(0, 24);
    const sourceId = finding.evidence[0]?.sourceId ?? null;
    const canonicalKey = `canon-event-${fingerprint}`;
    const event = await params.db.query<{ id: string }>(
      `INSERT INTO storyhold.world_clock_events
        (id, world_id, canon_edition_id, source_id, canonical_key, event_kind,
         title, summary, world_time_label, chronology_order, temporal_status,
         importance, source_chapter_keys, visibility, knowledge_status, evidence)
       VALUES ($1, $2, $3, $4, $5, 'canon', $6, $7, $8, $9, $10, $11,
               $12::jsonb, 'world', 'inferred', $13::jsonb)
       ON CONFLICT (world_id, canonical_key) DO UPDATE
         SET title = EXCLUDED.title,
             summary = EXCLUDED.summary,
             world_time_label = EXCLUDED.world_time_label,
             chronology_order = EXCLUDED.chronology_order,
             temporal_status = EXCLUDED.temporal_status,
             importance = EXCLUDED.importance,
             source_chapter_keys = EXCLUDED.source_chapter_keys,
             source_id = EXCLUDED.source_id,
             evidence = EXCLUDED.evidence,
             visibility = 'world'
       WHERE world_clock_events.canon_edition_id = EXCLUDED.canon_edition_id
         AND world_clock_events.campaign_id IS NULL
         AND world_clock_events.created_by_player_id IS NULL
         AND world_clock_events.assignment_source = 'local'
         AND world_clock_events.canonical_key LIKE 'canon-event-%'
         AND NOT EXISTS (
           SELECT 1 FROM storyhold.world_clock_event_verifications verified
            WHERE verified.event_id = world_clock_events.id
         )
       RETURNING id`,
      [
        randomUUID(),
        params.worldId,
        params.editionId,
        sourceId,
        canonicalKey,
        finding.name,
        finding.summary,
        finding.worldTimeLabel ?? "Imported chronology",
        index * 1_000,
        finding.temporalStatus ?? "relative",
        finding.importance ?? "major",
        json(finding.sourceChapterKeys ?? []),
        json(finding.evidence),
      ],
    );
    const eventId = event.rows[0]?.id;
    if (!eventId) continue;
    activeEventIds.push(eventId);
    const participantGroups: Array<{
      role: PersistableWorldEventParticipant["role"];
      names: string[] | undefined;
    }> = [
      { role: "actor", names: finding.actors },
      { role: "target", names: finding.targets },
      { role: "witness", names: finding.witnesses },
      { role: "location", names: finding.locations },
    ];
    for (const group of participantGroups) {
      for (const entity of [...new Set(group.names ?? [])]) {
        participants.push({
          eventId,
          eventName: finding.name,
          entity,
          role: group.role,
          evidence: finding.evidence,
          confidence: Number(finding.confidence ?? 0.75),
        });
      }
    }
    for (const relation of finding.eventRelations ?? []) {
      relations.push({
        sourceEventId: eventId,
        sourceEventName: finding.name,
        targetEvent: relation.targetEvent,
        relationType: relation.relationType,
        summary: relation.summary,
        evidence: relation.evidence,
        confidence: relation.confidence,
      });
    }
  }
  // Deliberately no omission cleanup. A missing result—partial or complete—is
  // not an instruction to hide/delete an earlier event or its owner links.
  return { participants, relations, eventIds: activeEventIds };
}

export async function reconcileAuthoritativeAiChapterMap(params: {
  db: Pick<StoryholdDb, "query">;
  worldId: string;
  editionId: string;
  sourceId: string;
}): Promise<{ authoritative: boolean; removedLocalRows: number }> {
  const result = await params.db.query<{
    authoritative: boolean;
    removed_local_rows: number;
  }>(
    `WITH authoritative_source AS (
       SELECT source_row.id
         FROM storyhold.world_sources source_row
        WHERE source_row.id = $1
          AND source_row.world_id = $2
          AND source_row.canon_edition_id = $3
          AND source_row.ai_review_status = 'reviewed'
          AND source_row.ai_coverage_authoritative = true
          AND source_row.ai_analysis_version >= ${WORLD_ANALYSIS_VERSION}
          AND source_row.ai_reviewed_content_hash IS NOT DISTINCT FROM source_row.content_hash
          AND source_row.ai_reviewed_chunk_count >= source_row.chunk_count
          AND EXISTS (
            SELECT 1
              FROM storyhold.world_chapter_summaries ai_chapter
             WHERE ai_chapter.world_id = source_row.world_id
               AND ai_chapter.canon_edition_id = source_row.canon_edition_id
               AND ai_chapter.source_id = source_row.id
               AND ai_chapter.summary_source = 'ai'
          )
     ), removed_local AS (
       DELETE FROM storyhold.world_chapter_summaries local_chapter
        USING authoritative_source
        WHERE local_chapter.world_id = $2
          AND local_chapter.canon_edition_id = $3
          AND local_chapter.source_id = authoritative_source.id
          AND local_chapter.summary_source = 'local'
       RETURNING local_chapter.id
     )
     SELECT EXISTS (SELECT 1 FROM authoritative_source) AS authoritative,
            (SELECT count(*)::int FROM removed_local) AS removed_local_rows`,
    [params.sourceId, params.worldId, params.editionId],
  );
  return {
    authoritative: Boolean(result.rows[0]?.authoritative),
    removedLocalRows: Number(result.rows[0]?.removed_local_rows ?? 0),
  };
}

async function syncLocalChapterClockForSource(params: {
  db: StudioDb;
  worldId: string;
  editionId: string;
  sourceId: string;
  sourceTitle: string;
  chronologyLabel: string;
  chronologyOrder: number;
}) {
  const chapters = await params.db.query<{
    canonical_key: string;
    chapter_title: string;
    perspective: string;
    source_order: number;
    summary: string;
    evidence: unknown;
  }>(
    `SELECT canonical_key, chapter_title, perspective, source_order, summary, evidence
       FROM storyhold.world_chapter_summaries
      WHERE world_id = $1 AND canon_edition_id = $2 AND source_id = $3
      ORDER BY source_order, created_at`,
    [params.worldId, params.editionId, params.sourceId],
  );
  const activeCanonicalKeys: string[] = [];
  for (const chapter of chapters.rows) {
    const title = chapter.chapter_title
      .replace(/\s*\([^()]+?\s*-\s*(?:Past|Present)\)\s*$/iu, "")
      .trim() || "Imported Chapter";
    const labelParts = [params.chronologyLabel || params.sourceTitle, chapter.perspective]
      .map((part) => part.trim())
      .filter(Boolean);
    const canonicalKey = `source-chapter-v2-${createHash("sha256")
      .update(`${params.sourceId}:${chapter.canonical_key}`)
      .digest("hex")
      .slice(0, 24)}`;
    activeCanonicalKeys.push(canonicalKey);
    await params.db.query(
      `INSERT INTO storyhold.world_clock_events
        (id, world_id, canon_edition_id, source_id, canonical_key, event_kind,
         title, summary, world_time_label, chronology_order, temporal_status,
         importance, source_chapter_keys, visibility, knowledge_status, evidence)
       VALUES ($1, $2, $3, $4, $5, 'canon', $6, $7, $8, $9, 'relative',
               'major', $10::jsonb, 'world', 'inferred', $11::jsonb)
       ON CONFLICT (world_id, canonical_key) DO UPDATE
         SET title = EXCLUDED.title, summary = EXCLUDED.summary,
             world_time_label = EXCLUDED.world_time_label,
             chronology_order = EXCLUDED.chronology_order,
             source_chapter_keys = EXCLUDED.source_chapter_keys,
             evidence = EXCLUDED.evidence,
             visibility = 'world', knowledge_status = 'inferred'
       WHERE world_clock_events.canon_edition_id = EXCLUDED.canon_edition_id
         AND world_clock_events.campaign_id IS NULL
         AND world_clock_events.created_by_player_id IS NULL
         AND world_clock_events.assignment_source = 'local'
         AND world_clock_events.canonical_key LIKE 'source-chapter-v2-%'
         AND NOT EXISTS (
           SELECT 1 FROM storyhold.world_clock_event_verifications verified
            WHERE verified.event_id = world_clock_events.id
         )`,
      [
        randomUUID(), params.worldId, params.editionId, params.sourceId,
        canonicalKey, title, chapter.summary,
        labelParts.join(" · ") || "Imported chronology",
        (params.chronologyOrder * 1_000_000) + (chapter.source_order * 1_000),
        json([chapter.canonical_key]), json(chapter.evidence),
      ],
    );
  }
  // A parser omission is not authority to destroy a World Clock row or any
  // owner-created edge attached to it. Retain obsolete generated chapter
  // guides privately instead of cascading a delete; a later parse can safely
  // reactivate the exact key.
  await params.db.query(
    `UPDATE storyhold.world_clock_events event
        SET visibility = 'studio', knowledge_status = 'inferred'
      WHERE event.world_id = $1 AND event.canon_edition_id = $2 AND event.source_id = $3
        AND event.campaign_id IS NULL
        AND event.created_by_player_id IS NULL
        AND event.assignment_source = 'local'
        AND event.canonical_key LIKE 'source-chapter-v2-%'
        AND NOT (event.canonical_key = ANY($4::text[]))
        AND NOT EXISTS (
          SELECT 1 FROM storyhold.world_clock_event_verifications verified
           WHERE verified.event_id = event.id
        )`,
    [params.worldId, params.editionId, params.sourceId, activeCanonicalKeys],
  );
}

export async function syncSourceChapterSummaries(params: {
  db: StudioDb;
  worldId: string;
  editionId: string;
  sourceId: string;
  sourceTitle: string;
  chronologyLabel: string;
  chronologyOrder: number;
  extractedText: string;
  fileAsChapter?: boolean;
}) {
  // A completed, current connected review owns the generated chapter map.
  // Startup still invokes this inexpensive parser for every ready source, so
  // reconcile any parser remnants and return before they can be reinserted.
  // Sources without proven current AI coverage continue through local parsing.
  const aiChapterMap = await reconcileAuthoritativeAiChapterMap(params);
  if (aiChapterMap.authoritative) {
    // Chapter summaries are useful navigation, but their prose is not an
    // independently verified event/participant/time decision. Once a current
    // connected chapter map exists, keep old parser guides recoverable in the
    // studio while the receipt-backed World Clock owns the public timeline.
    await params.db.query(
      `UPDATE storyhold.world_clock_events event
          SET visibility = 'studio', knowledge_status = 'inferred'
        WHERE event.world_id = $1 AND event.canon_edition_id = $2 AND event.source_id = $3
          AND event.campaign_id IS NULL
          AND event.created_by_player_id IS NULL
          AND event.assignment_source = 'local'
          AND event.canonical_key LIKE 'source-chapter-v2-%'
          AND NOT EXISTS (
            SELECT 1 FROM storyhold.world_clock_event_verifications verified
             WHERE verified.event_id = event.id
          )`,
      [params.worldId, params.editionId, params.sourceId],
    );
    return;
  }

  const sections = parseNarrativeSections(params.extractedText, {
    sourceTitle: params.sourceTitle,
    sourceKey: params.sourceId,
    fallbackToSource: params.fileAsChapter === true,
  });
  const sourceChunks = await params.db.query<{
    id: string;
    content: string;
    metadata: Record<string, unknown>;
  }>(
    `SELECT id, content, metadata FROM storyhold.world_source_chunks
      WHERE source_id = $1 ORDER BY chunk_index`,
    [params.sourceId],
  );
  for (const section of sections) {
    const canonicalKey = `${params.sourceId}:${section.key}`;
    const summary = summarizeNarrativeSection(section.body);
    const normalizedBody = section.body.replace(/\s+/g, " ").trim();
    const evidenceChunk = sourceChunks.rows.find((chunk) => {
      const normalizedChunk = chunk.content.replace(/\s+/g, " ").trim();
      return normalizedChunk.includes(normalizedBody.slice(0, 160));
    }) ?? sourceChunks.rows.find((chunk) => {
      const start = Number(chunk.metadata?.sourceStartOffset ?? -1);
      const end = Number(chunk.metadata?.sourceEndOffset ?? -1);
      return start <= section.sourceOffset && end >= section.sourceOffset;
    });
    const evidenceQuote = evidenceChunk
      ? normalizedBody.slice(0, Math.min(320, normalizedBody.length))
      : "";
    const evidence = evidenceChunk && evidenceQuote
      ? [{
          sourceId: params.sourceId,
          chunkId: evidenceChunk.id,
          quote: evidenceQuote,
        }]
      : [];
    await params.db.query(
      `INSERT INTO storyhold.world_chapter_summaries
        (id, world_id, canon_edition_id, source_id, canonical_key, chapter_title,
         perspective, source_order, summary, major_events, evidence, summary_source, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '[]'::jsonb, $10::jsonb, 'local', 0.45)
       ON CONFLICT (world_id, canonical_key) DO UPDATE
         SET chapter_title = EXCLUDED.chapter_title,
             perspective = EXCLUDED.perspective,
             source_order = EXCLUDED.source_order,
             summary = CASE WHEN world_chapter_summaries.summary_source = 'local' THEN EXCLUDED.summary ELSE world_chapter_summaries.summary END,
             source_id = EXCLUDED.source_id,
             evidence = CASE WHEN world_chapter_summaries.summary_source = 'local' THEN EXCLUDED.evidence ELSE world_chapter_summaries.evidence END,
             updated_at = now()
       WHERE world_chapter_summaries.summary_source = 'local'`,
      [
        randomUUID(),
        params.worldId,
        params.editionId,
        params.sourceId,
        canonicalKey,
        section.title,
        section.perspective,
        section.order,
        summary,
        json(evidence),
      ],
    );
  }
  await syncLocalChapterClockForSource(params);
}

async function syncAiChapterSummaries(params: {
  db: StudioDb;
  worldId: string;
  editionId: string;
  findings: WorldFindings;
  replaceSnapshot?: boolean;
}) {
  if (params.replaceSnapshot) {
    // A complete connected review owns the generated chapter map. Removing
    // only local/AI rows prevents stale parser duplicates and malformed titles
    // from surviving while preserving every customer-authored chapter note.
    await params.db.query(
      `DELETE FROM storyhold.world_chapter_summaries
        WHERE world_id = $1 AND canon_edition_id = $2
          AND summary_source IN ('local', 'ai')`,
      [params.worldId, params.editionId],
    );
  }
  for (const chapter of params.findings.chapterSummaries) {
    const sourceId = chapter.sourceId || chapter.evidence[0]?.sourceId;
    if (!sourceId) continue;
    const source = await params.db.query<{ found: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM storyhold.world_sources WHERE id = $1 AND world_id = $2) AS found`,
      [sourceId, params.worldId],
    );
    if (!source.rows[0]?.found) continue;
    await params.db.query(
      `INSERT INTO storyhold.world_chapter_summaries
        (id, world_id, canon_edition_id, source_id, canonical_key, chapter_title,
         perspective, source_order, summary, major_events, evidence, summary_source, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, 'ai', $12)
       ON CONFLICT (world_id, canonical_key) DO UPDATE
         SET chapter_title = EXCLUDED.chapter_title, perspective = EXCLUDED.perspective,
             source_order = EXCLUDED.source_order, summary = EXCLUDED.summary,
             major_events = EXCLUDED.major_events, evidence = EXCLUDED.evidence,
             summary_source = 'ai', confidence = EXCLUDED.confidence, updated_at = now()
       WHERE storyhold.world_chapter_summaries.summary_source <> 'user'`,
      [randomUUID(), params.worldId, params.editionId, sourceId, chapter.chapterKey,
       chapter.chapterTitle, chapter.perspective, chapter.sourceOrder, chapter.summary,
       json(chapter.majorEvents), json(chapter.evidence), chapter.confidence],
    );
  }
}

async function saveCharacterDraft(
  db: StudioDb,
  params: {
    worldId: string;
    editionId: string;
    runId: string;
    analysisKind: AnalysisKind;
    finding: CharacterFinding;
  },
) {
  const profile = profileFromCharacterFinding(params.finding);
  const existingCanonical = await db.query<{ id: string }>(
    `SELECT id FROM storyhold.characters
      WHERE world_id = $1 AND scope_kind = 'world' AND lower(name) = lower($2)
      LIMIT 1`,
    [params.worldId, params.finding.name],
  );
  if (existingCanonical.rows[0]) return;
  const existingDraft = await db.query<Record<string, unknown>>(
    `SELECT * FROM storyhold.character_drafts
      WHERE world_id = $1 AND canon_edition_id = $2 AND lower(name) = lower($3)
        AND review_status = 'draft'
      ORDER BY created_at DESC
      LIMIT 1`,
    [params.worldId, params.editionId, params.finding.name],
  );
  if (existingDraft.rows[0]) {
    const current = existingDraft.rows[0];
    const replaceLocalSnapshot = params.analysisKind === "local_scan";
    const mergedProfile = replaceLocalSnapshot ? profile : mergeDossierProfiles(current.profile, profile);
    if (params.analysisKind === "ai_enrichment") {
      mergedProfile.estimatedStats = mergeReviewedStatEstimates(recordBody(current.profile).estimatedStats, profile.estimatedStats);
    }
    await db.query(
      `UPDATE storyhold.character_drafts
          SET analysis_run_id = $2, aliases = $3::jsonb, role = $4, summary = $5,
              profile = $6::jsonb, evidence = $7::jsonb, confidence = $8
        WHERE id = $1`,
      [
        current.id,
        params.runId,
        json(replaceLocalSnapshot
          ? mergeEntityStrings(params.finding.aliases)
          : mergeEntityStrings(current.aliases, params.finding.aliases)),
        replaceLocalSnapshot
          ? textBody(params.finding.role, 240)
          : richerDossierText(current.role, params.finding.role, 240),
        replaceLocalSnapshot
          ? textBody(params.finding.summary, 4_000)
          : richerDossierText(current.summary, params.finding.summary, 4_000),
        json(mergedProfile),
        json(replaceLocalSnapshot
          ? mergeEntityEvidence(params.finding.evidence)
          : mergeEntityEvidence(current.evidence, params.finding.evidence)),
        Math.max(Number(current.confidence ?? 0), params.finding.confidence),
      ],
    );
    return;
  }
  const id = randomUUID();
  await db.query(
    `INSERT INTO storyhold.character_drafts
      (id, world_id, canon_edition_id, analysis_run_id, canonical_key, name, aliases, role, summary, profile, evidence, confidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11::jsonb, $12)`,
    [
      id,
      params.worldId,
      params.editionId,
      params.runId,
      `${slug(params.finding.name)}-${id.slice(0, 8)}`,
      params.finding.name,
      json(params.finding.aliases),
      params.finding.role,
      params.finding.summary,
      json(profile),
      json(params.finding.evidence),
      params.finding.confidence,
    ],
  );
}

async function saveCohesionProposals(params: {
  db: StudioDb;
  worldId: string;
  editionId: string;
  runId: string;
  findings: CohesionFinding[];
}) {
  for (const finding of params.findings) {
    const fingerprint = createHash("sha256")
      .update(
        `${finding.kind}\n${finding.subject.toLocaleLowerCase()}\n${finding.summary.toLocaleLowerCase()}`,
      )
      .digest("hex");
    await params.db.query(
      `INSERT INTO storyhold.cohesion_proposals
        (id, world_id, canon_edition_id, analysis_run_id, fingerprint, kind, subject, summary, severity, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (world_id, canon_edition_id, fingerprint) DO NOTHING`,
      [
        randomUUID(),
        params.worldId,
        params.editionId,
        params.runId,
        fingerprint,
        finding.kind,
        finding.subject,
        finding.summary,
        finding.severity,
        json(finding.evidence),
      ],
    );
  }
}

async function canonContext(
  db: StudioDb,
  worldId: string,
  editionId: string,
  breakdown: Record<string, unknown> | undefined,
  campaignId: string | null = null,
): Promise<string> {
  const [characters, characterCandidates, amendments, conceptGraph] = await Promise.all([
    db.query<Record<string, unknown>>(
      `SELECT name, initial_profile
         FROM storyhold.characters
        WHERE world_id = $1 AND scope_kind = 'world'
        ORDER BY name ASC
        LIMIT 200`,
      [worldId],
    ),
    db.query<Record<string, unknown>>(
      `SELECT name, aliases, role, summary, mention_count, mention_source_count,
              confidence, evidence, profile, axis_estimate
         FROM storyhold.character_dossiers
        WHERE world_id = $1 AND canon_edition_id = $2 AND dossier_status = 'active'
        ORDER BY mention_count DESC, confidence DESC, name ASC
        LIMIT 120`,
      [worldId, editionId],
    ),
    campaignId
      ? db.query<Record<string, unknown>>(
          `SELECT subject, operation, statement, previous_statement, rationale, evidence, created_at
             FROM storyhold.canon_amendments
            WHERE world_id = $1 AND canon_edition_id = $2
              AND (campaign_id IS NULL OR campaign_id = $3)
            ORDER BY created_at ASC
            LIMIT 300`,
          [worldId, editionId, campaignId],
        )
      : db.query<Record<string, unknown>>(
          `SELECT subject, operation, statement, previous_statement, rationale, evidence, created_at
             FROM storyhold.canon_amendments
            WHERE world_id = $1 AND canon_edition_id = $2 AND campaign_id IS NULL
            ORDER BY created_at ASC
            LIMIT 300`,
          [worldId, editionId],
        ),
    conceptResolutionContext({ db, worldId, editionId }),
  ]);
  const richCharacterContext = characterCandidates.rows.map((row) => {
    const profile = normalizedDossierProfile(row.profile);
    const compactList = (values: string[]) => values.slice(0, 12);
    return {
      name: row.name,
      aliases: Array.isArray(row.aliases) ? row.aliases.slice(0, 12) : [],
      role: row.role,
      summary: row.summary,
      profile: {
        traits: compactList(profile.traits),
        motivations: compactList(profile.motivations),
        fears: compactList(profile.fears),
        capabilities: compactList(profile.capabilities),
        history: compactList(profile.history),
        origins: compactList(profile.origins),
        powers: compactList(profile.powers),
        moralSystem: compactList(profile.moralSystem),
        physicalCharacteristics: compactList(profile.physicalCharacteristics),
        relationships: compactList(profile.relationships),
        relationshipWeb: profile.relationshipWeb.slice(0, 12),
        knowledge: compactList(profile.knowledge),
        secrets: compactList(profile.secrets),
        estimatedStats: profile.estimatedStats,
      },
      socioPoliticalAxis: dossierAxis(row.axis_estimate),
      mentionCount: Number(row.mention_count ?? 0),
      mentionSourceCount: Number(row.mention_source_count ?? 0),
      confidence: Number(row.confidence ?? 0),
      evidence: Array.isArray(row.evidence) ? row.evidence.slice(0, 4) : [],
    };
  });
  const compact = {
    notice:
      "The world breakdown and detected candidates are inexpensive pre-pass leads, not source evidence. ApprovedCharacters are locked canon origins.",
    approvedCharacters: characters.rows,
    detectedCharacterDossiers: richCharacterContext,
    appendOnlyAmendments: amendments.rows,
    worldBreakdown: breakdown
      ? {
          summary: breakdown.summary,
          genres: breakdown.genres,
          atmosphere: breakdown.atmosphere,
          themes: breakdown.themes,
          worldRules: breakdown.world_rules,
          locations: breakdown.locations,
          factions: breakdown.factions,
          institutions: breakdown.institutions,
          governments: breakdown.governments,
          powerStructures: breakdown.power_structures,
          technologies: breakdown.technologies,
          vehicles: breakdown.vehicles,
          devices: breakdown.devices,
          weapons: breakdown.weapons,
          chronology: breakdown.chronology,
          openQuestions: breakdown.open_questions,
        }
      : null,
    canonEditionId: editionId,
    campaignId,
  };
  return `${JSON.stringify(compact).slice(0, 40_000)}\n\n` +
    `<STORY_CONCEPT_RESOLUTION trust="unverified-leads-and-owner-constraints">\n${conceptGraph}\n</STORY_CONCEPT_RESOLUTION>\n` +
    "Owner canon constraints are binding review rules. Concept clusters and relationship hypotheses are not canon or evidence: verify each proposed item against SOURCE passages, preserve contradictory alternatives, and promote only evidence-backed findings.";
}

async function premiumExternalReferenceContext(
  db: StudioDb,
  worldId: string,
  editionId: string,
): Promise<string> {
  const [websiteReferences, uploadedReferences] = await Promise.all([
    db.query<Record<string, unknown>>(
      `SELECT title, url, publisher, summary, keywords, content_text,
              quality_score, quality_flags, knowledge_scope, known_by,
              lore_status
         FROM storyhold.world_reference_sources
        WHERE world_id = $1 AND canon_edition_id = $2
          AND review_status = 'approved'
          AND extraction_status <> 'failed'
        ORDER BY updated_at DESC
        LIMIT 20`,
      [worldId, editionId],
    ),
    db.query<Record<string, unknown>>(
      `SELECT title, original_filename, extracted_text, word_count,
              extraction_quality_severity, reference_knowledge_scope,
              reference_known_by, reference_lore_status
         FROM storyhold.world_sources
        WHERE world_id = $1 AND canon_edition_id = $2
          AND processing_status = 'ready'
          AND (source_kind = 'reference' OR canon_status = 'reference')
        ORDER BY chronology_order, sort_order, created_at
        LIMIT 30`,
      [worldId, editionId],
    ),
  ]);
  const websitePackets = websiteReferences.rows.map((reference) =>
    JSON.stringify({
      kind: "website_reference",
      title: textBody(reference.title, 300),
      publisher: textBody(reference.publisher, 200),
      url: textBody(reference.url, 2_000),
      summary: textBody(reference.summary, 1_200),
      keywords: stringList(reference.keywords, 30, 120),
      qualityScore: Number(reference.quality_score ?? 0),
      qualityFlags: stringList(reference.quality_flags, 20, 120),
      knowledgeScope: reference.knowledge_scope ?? "director_only",
      knownBy: stringList(reference.known_by, 50, 180),
      loreStatus: reference.lore_status ?? "supplemental",
      backgroundExcerpt: textBody(reference.content_text, 4_000),
    }),
  );
  const uploadPackets = uploadedReferences.rows.map((reference) =>
    JSON.stringify({
      kind: "uploaded_reference",
      title: textBody(reference.title, 300),
      filename: textBody(reference.original_filename, 300),
      wordCount: Number(reference.word_count ?? 0),
      extractionQuality:
        textBody(reference.extraction_quality_severity, 40) || "unknown",
      knowledgeScope:
        reference.reference_knowledge_scope ?? "director_only",
      knownBy: stringList(reference.reference_known_by, 50, 180),
      loreStatus: reference.reference_lore_status ?? "supplemental",
      backgroundExcerpt: textBody(reference.extracted_text, 4_000),
    }),
  );
  return [...websitePackets, ...uploadPackets].join("\n").slice(0, 12_000);
}

async function discrepancyWorldAccess(
  db: StudioDb,
  worldId: string,
  playerId: string,
  campaignId: string | null,
) {
  if (!campaignId) {
    const owned = await ownedWorld(db, worldId, playerId);
    return owned ? { world: owned, isOwner: true } : null;
  }
  if (!UUID_PATTERN.test(campaignId)) return null;
  const result = await db.query<{
    id: string;
    owner_player_id: string;
    canonical_key: string;
    name: string;
    premise: string;
    description: string;
    genre: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT w.id, w.owner_player_id, w.canonical_key, w.name, w.premise,
            w.description, w.genre, w.created_at, w.updated_at
       FROM storyhold.worlds w
       JOIN storyhold.campaigns c ON c.world_id = w.id AND c.id = $3
       LEFT JOIN storyhold.campaign_members m ON m.campaign_id = c.id AND m.player_id = $2
      WHERE w.id = $1 AND (w.owner_player_id = $2 OR m.player_id = $2)
      LIMIT 1`,
    [worldId, playerId, campaignId],
  );
  const world = result.rows[0] ?? null;
  return world
    ? { world, isOwner: world.owner_player_id === playerId }
    : null;
}

const DISCREPANCY_SEARCH_STOP = new Set([
  "canon",
  "storyhold",
  "wrong",
  "incorrect",
  "should",
  "would",
  "could",
  "because",
  "noticed",
  "discrepancy",
  "change",
  "source",
  "story",
  "this",
  "that",
  "with",
  "from",
  "have",
  "been",
]);

function discrepancySearchTerms(value: string): string[] {
  return [
    ...new Set(
      (value.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(
        (term) => !DISCREPANCY_SEARCH_STOP.has(term),
      ),
    ),
  ].slice(0, 12);
}

async function relevantDiscrepancyChunks(params: {
  db: StudioDb;
  worldId: string;
  editionId: string;
  claim: string;
  reasoning: string;
}): Promise<AnalysisChunk[]> {
  const terms = discrepancySearchTerms(
    `${params.claim} ${params.reasoning}`,
  );
  if (terms.length === 0) return [];
  const tsQuery = terms.join(" | ");
  const result = await params.db.query<{
    id: string;
    source_id: string;
    source_title: string;
    chunk_index: number;
    content: string;
  }>(
    `SELECT c.id, c.source_id, s.title AS source_title, c.chunk_index, c.content
       FROM storyhold.world_source_chunks c
       JOIN storyhold.world_sources s ON s.id = c.source_id
      WHERE c.world_id = $1 AND c.canon_edition_id = $2
        AND s.processing_status = 'ready' AND s.canon_status IN ('candidate', 'canon')
        AND to_tsvector('simple', c.content) @@ to_tsquery('simple', $3)
      ORDER BY ts_rank_cd(to_tsvector('simple', c.content), to_tsquery('simple', $3)) DESC,
               s.sort_order ASC, c.chunk_index ASC
      LIMIT 14`,
    [params.worldId, params.editionId, tsQuery],
  );
  return result.rows.map((row) => ({
    id: row.id,
    sourceId: row.source_id,
    sourceTitle: row.source_title,
    index: Number(row.chunk_index),
    content: row.content,
  }));
}

async function integrityState(params: {
  db: StudioDb;
  playerId: string;
  worldId: string;
  campaignId: string | null;
}) {
  const scopeKey = params.campaignId ?? "world";
  const existing = await params.db.query<{
    id: string;
    unsupported_attempts: number;
    suspected_manipulation_attempts: number;
    strictness_level: number;
  }>(
    `SELECT id, unsupported_attempts, suspected_manipulation_attempts, strictness_level
       FROM storyhold.player_canon_integrity
      WHERE player_id = $1 AND world_id = $2 AND scope_key = $3
      LIMIT 1`,
    [params.playerId, params.worldId, scopeKey],
  );
  if (existing.rows[0]) return existing.rows[0];
  const id = randomUUID();
  await params.db.query(
    `INSERT INTO storyhold.player_canon_integrity
      (id, player_id, world_id, campaign_id, scope_key)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, params.playerId, params.worldId, params.campaignId, scopeKey],
  );
  return {
    id,
    unsupported_attempts: 0,
    suspected_manipulation_attempts: 0,
    strictness_level: 0,
  };
}

async function recordIntegritySignal(params: {
  db: StudioDb;
  reportId: string;
  playerId: string;
  worldId: string;
  campaignId: string | null;
  risk: "unsupported_override" | "suspected_manipulation";
  explanation: string;
}) {
  const state = await integrityState(params);
  const increase = params.risk === "suspected_manipulation" ? 2 : 1;
  const strictnessAfter = Math.min(
    4,
    Number(state.strictness_level) + increase,
  );
  await params.db.query(
    `UPDATE storyhold.player_canon_integrity
        SET unsupported_attempts = unsupported_attempts + 1,
            suspected_manipulation_attempts = suspected_manipulation_attempts + $2,
            strictness_level = $3, last_signal_at = now(), updated_at = now()
      WHERE id = $1`,
    [
      state.id,
      params.risk === "suspected_manipulation" ? 1 : 0,
      strictnessAfter,
    ],
  );
  await params.db.query(
    `INSERT INTO storyhold.canon_integrity_signals
      (id, integrity_id, discrepancy_report_id, player_id, world_id, campaign_id,
       signal_type, internal_note, strictness_before, strictness_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      randomUUID(),
      state.id,
      params.reportId,
      params.playerId,
      params.worldId,
      params.campaignId,
      params.risk === "suspected_manipulation"
        ? "suspected_manipulation_attempt"
        : "unsupported_override_attempt",
      `Rejected canon override after evidence and reasoning review. ${params.explanation}`.slice(
        0,
        2_000,
      ),
      Number(state.strictness_level),
      strictnessAfter,
    ],
  );
}

function amendmentFrom(value: unknown): DiscrepancyAmendment | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const subject = textBody(row.subject, 180);
  const statement = textBody(row.statement, 2_000);
  const previousStatement = textBody(row.previousStatement, 1_200);
  const operation = row.operation;
  if (
    !subject ||
    !statement ||
    (operation !== "clarify" &&
      operation !== "correct" &&
      operation !== "invalidate" &&
      operation !== "supersede")
  )
    return null;
  return { subject, statement, previousStatement, operation };
}

async function applyCanonAmendment(params: {
  db: StudioRootDb;
  report: Record<string, unknown>;
  playerId: string;
  decisionSource: "source_evidence" | "reasoned_consistency";
}) {
  const amendment = amendmentFrom(params.report.proposed_amendment);
  if (!amendment)
    throw new Error("The discrepancy does not contain a valid amendment.");
  const amendmentId = randomUUID();
  const campaignId =
    typeof params.report.campaign_id === "string"
      ? params.report.campaign_id
      : null;
  await params.db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO storyhold.canon_amendments
        (id, world_id, canon_edition_id, campaign_id, discrepancy_report_id,
         created_by_player_id, canonical_key, subject, operation, statement,
         previous_statement, rationale, evidence, decision_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)`,
      [
        amendmentId,
        params.report.world_id,
        params.report.canon_edition_id,
        campaignId,
        params.report.id,
        params.playerId,
        `${slug(amendment.subject)}-${amendmentId.slice(0, 8)}`,
        amendment.subject,
        amendment.operation,
        amendment.statement,
        amendment.previousStatement,
        params.report.review_explanation,
        json(params.report.evidence ?? []),
        params.decisionSource,
      ],
    );
    if (campaignId) {
      const sequence = await tx.query<{ next_sequence: number }>(
        `SELECT COALESCE(max(sequence_number), 0)::int + 1 AS next_sequence
           FROM storyhold.world_state_events
          WHERE campaign_id = $1`,
        [campaignId],
      );
      const nextSequence = Number(sequence.rows[0]?.next_sequence ?? 1);
      await tx.query(
        `INSERT INTO storyhold.world_state_events
          (id, campaign_id, sequence_number, event_type, payload, caused_by_player_id)
         VALUES ($1, $2, $3, 'canon_correction', $4::jsonb, $5)`,
        [
          randomUUID(),
          campaignId,
          nextSequence,
          json({
            amendmentId,
            discrepancyReportId: params.report.id,
            subject: amendment.subject,
            operation: amendment.operation,
            statement: amendment.statement,
            previousStatement: amendment.previousStatement,
          }),
          params.playerId,
        ],
      );
      await tx.query(
        `UPDATE storyhold.campaigns SET state_version = $2 WHERE id = $1`,
        [campaignId, nextSequence],
      );
    }
    await tx.query(
      `UPDATE storyhold.canon_discrepancy_reports
          SET status = 'applied', resolved_at = now(), updated_at = now()
        WHERE id = $1`,
      [params.report.id],
    );
    await tx.query(
      `UPDATE storyhold.worlds SET updated_at = now() WHERE id = $1`,
      [params.report.world_id],
    );
  });
  return amendmentId;
}

async function evaluateDiscrepancy(params: {
  db: StudioDb;
  world: {
    id: string;
    name: string;
  };
  editionId: string;
  campaignId: string | null;
  playerId: string;
  claim: string;
  reasoning: string;
}): Promise<{
  review: DiscrepancyReview;
  provider: string;
  model: string;
  strictnessLevel: number;
}> {
  const [state, breakdownResult, chunks, recentSignals] = await Promise.all([
    integrityState({
      db: params.db,
      playerId: params.playerId,
      worldId: params.world.id,
      campaignId: params.campaignId,
    }),
    params.db.query<Record<string, unknown>>(
      `SELECT * FROM storyhold.world_breakdowns
        WHERE world_id = $1 AND canon_edition_id = $2
        ORDER BY version DESC
        LIMIT 1`,
      [params.world.id, params.editionId],
    ),
    relevantDiscrepancyChunks({
      db: params.db,
      worldId: params.world.id,
      editionId: params.editionId,
      claim: params.claim,
      reasoning: params.reasoning,
    }),
    params.campaignId
      ? params.db.query<Record<string, unknown>>(
          `SELECT signal_type, internal_note, strictness_after, created_at
             FROM storyhold.canon_integrity_signals
            WHERE player_id = $1 AND world_id = $2 AND campaign_id = $3
            ORDER BY created_at DESC
            LIMIT 12`,
          [params.playerId, params.world.id, params.campaignId],
        )
      : params.db.query<Record<string, unknown>>(
          `SELECT signal_type, internal_note, strictness_after, created_at
             FROM storyhold.canon_integrity_signals
            WHERE player_id = $1 AND world_id = $2 AND campaign_id IS NULL
            ORDER BY created_at DESC
            LIMIT 12`,
          [params.playerId, params.world.id],
        ),
  ]);
  const scopedContext = await canonContext(
    params.db,
    params.world.id,
    params.editionId,
    breakdownResult.rows[0],
    params.campaignId,
  );
  const reviewed = await reviewCanonDiscrepancy({
    worldName: params.world.name,
    claim: params.claim,
    reasoning: params.reasoning,
    currentCanonContext: `INTERNAL PRIOR OVERRIDE SIGNALS (never display to the player):\n${JSON.stringify(recentSignals.rows)}\nSCOPED CANON:\n${scopedContext}`,
    chunks,
    strictnessLevel: Number(state.strictness_level),
  });
  let review = reviewed.review;
  if (!params.reasoning.trim() && review.verdict === "unsupported") {
    review = {
      ...review,
      verdict: "needs_reason",
      proposedAmendment: null,
      integrityRisk: "none",
      explanation:
        "Storyhold could not find enough source evidence to justify changing canon. Explain why the current fact cannot be correct, and it will review the logic as well as the source material.",
    };
  }
  return {
    review,
    provider: reviewed.runtime.provider,
    model: reviewed.runtime.model,
    strictnessLevel: Number(state.strictness_level),
  };
}

function discrepancyStatus(
  verdict: DiscrepancyReview["verdict"],
): "needs_reason" | "correction_offered" | "rejected" {
  if (verdict === "source_supported" || verdict === "reasoned_correction")
    return "correction_offered";
  return verdict === "unsupported" ? "rejected" : "needs_reason";
}

type SourceReviewRow = {
  id: string;
  content_hash: string;
  word_count: number;
  chunk_count: number;
  chronology_order: number;
  sort_order: number;
  created_at: string;
  intake_payment_required: boolean;
  local_scan_status: string;
  local_scanned_content_hash: string | null;
  local_analysis_version: number;
  ai_review_status: string;
  ai_reviewed_content_hash: string | null;
  ai_analysis_version: number;
  ai_reviewed_chunk_count: number;
  ai_coverage_authoritative: boolean;
};

export type PremiumEvidencePin = {
  parentLocalRunId: string;
  corpusFingerprint: string;
  evidenceGraphFingerprint: string;
  constraintSnapshotFingerprint: string;
  verificationContextFingerprint: string;
  verificationPacketVersion: number;
};

export function premiumUsageNeedsReconciliation(usage: AiUsage | null | undefined): boolean {
  return Boolean(usage && (
    !usage.pricingKnown ||
    !Number.isFinite(usage.estimatedCostMicros) ||
    usage.estimatedCostMicros < 0
  ));
}

/**
 * Finish a premium review whose provider outcome and billable usage are known,
 * but whose returned material failed verification. The run row, credit hold,
 * credit ledger, and rejected-output usage receipt form one commit boundary so
 * a process exit cannot leave a settled hold attached to an apparently active
 * review.
 */
export async function finalizeKnownPremiumFailureAtomically(
  db: StudioRootDb,
  params: {
    runId: string;
    worldId: string;
    playerId: string;
    reservationId: string;
    failureMessage: string;
    failedUsage: {
      usage: AiUsage;
      provider: string;
      model: string;
      attemptCount: number;
    };
  },
) {
  return db.transaction(async (tx) => {
    // All premium execution/recovery paths acquire the run before its hold.
    // Keep that order here so settlement cannot deadlock operator recovery.
    const lockedRun = await tx.query<{ id: string }>(
      `SELECT id
         FROM storyhold.world_analysis_runs
        WHERE id = $1 AND world_id = $2 AND requested_by_player_id = $3
          AND analysis_kind = 'ai_enrichment'
          AND status IN ('queued', 'running', 'paused')
        FOR UPDATE`,
      [params.runId, params.worldId, params.playerId],
    );
    if (lockedRun.rows.length !== 1) {
      throw new Error("The premium review is no longer eligible for automatic failure settlement.");
    }
    const lockedReservation = await tx.query<{ id: string; reserved_credits: number }>(
      `SELECT id, reserved_credits
         FROM storyhold.credit_reservations
        WHERE id = $1 AND player_id = $2 AND world_id = $3
          AND campaign_id IS NULL AND operation = 'world_analysis'
          AND request_id = $4 AND status = 'reserved'
        FOR UPDATE`,
      [params.reservationId, params.playerId, params.worldId, params.runId],
    );
    if (lockedReservation.rows.length !== 1) {
      throw new Error("The premium review credit hold is unavailable for automatic failure settlement.");
    }
    const reservedCredits = Number(lockedReservation.rows[0]?.reserved_credits);
    if (!Number.isSafeInteger(reservedCredits) || reservedCredits < 0) {
      throw new Error("The premium review credit hold has invalid accounting data.");
    }

    const settlement = await settleCreditReservationInTransaction(tx, {
      reservationId: params.reservationId,
      usage: params.failedUsage.usage,
      provider: params.failedUsage.provider,
      model: params.failedUsage.model,
      reasoning: "high",
      requireFullPayment: true,
    });
    if (settlement.uncoveredCredits > 0) {
      // Strict premium settlement should make this unreachable. Keep the
      // defensive check inside the same transaction so neither accounting nor
      // the terminal run state can commit if the invariant ever regresses.
      throw new Error("The verified provider usage could not be fully settled.");
    }

    const terminalized = await tx.query<{ id: string }>(
      `UPDATE storyhold.world_analysis_runs
          SET premium_ai_credits_charged = $2,
              status = 'failed',
              stage = 'Premium Deep Reading stopped; verified usage saved',
              error = $3,
              premium_resume_status = 'not_available',
              pause_requested = false,
              paused_at = NULL,
              completed_at = now()
        WHERE id = $1 AND world_id = $4 AND requested_by_player_id = $5
          AND analysis_kind = 'ai_enrichment'
          AND status IN ('queued', 'running', 'paused')
        RETURNING id`,
      [
        params.runId,
        settlement.creditsUsed,
        params.failureMessage.slice(0, 4_000),
        params.worldId,
        params.playerId,
      ],
    );
    if (terminalized.rows.length !== 1) {
      throw new Error("The premium review changed before failure settlement could be finalized.");
    }

    await tx.query(
      `INSERT INTO storyhold.ai_usage_ledger
        (id, player_id, world_id, campaign_id, operation, provider, model,
         input_units, output_units, cached_input_units, cache_write_input_units,
         reasoning_units, cost_micros, cache_hit, pricing_version,
         credits_charged, request_id, metadata)
       VALUES ($1, $2, $3, NULL, 'world_analysis_rejected_output', $4, $5,
               $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)`,
      [
        randomUUID(),
        params.playerId,
        params.worldId,
        params.failedUsage.provider,
        params.failedUsage.model,
        params.failedUsage.usage.inputUnits,
        params.failedUsage.usage.outputUnits,
        params.failedUsage.usage.cachedInputUnits,
        params.failedUsage.usage.cacheWriteInputUnits,
        params.failedUsage.usage.reasoningUnits,
        params.failedUsage.usage.estimatedCostMicros,
        params.failedUsage.usage.cachedInputUnits > 0,
        params.failedUsage.usage.pricingVersion,
        settlement.creditsUsed,
        params.runId,
        json({
          canonPromoted: false,
          attemptCount: params.failedUsage.attemptCount,
          pricingKnown: params.failedUsage.usage.pricingKnown,
          failure: params.failureMessage.slice(0, 500),
          failureSettlementVersion: 1,
          runTerminalizedAtomically: true,
        }),
      ],
    );
    return settlement;
  });
}

/** Exact known usage may exceed an estimate. Keep the original hold and saved
 * provider outcome available to the owner instead of converting a simple
 * funding shortfall into an operator-only recovery case. */
export async function pausePremiumReviewForTopUp(
  db: StudioDb,
  params: { runId: string; worldId: string; playerId: string; privateError?: string },
): Promise<boolean> {
  const updated = await db.query(
    `UPDATE storyhold.world_analysis_runs
        SET status = 'paused', premium_resume_status = 'ready',
            stage = 'Premium Deep Reading Saved — Add Credits to Finish',
            error = $4, pause_requested = false, paused_at = now(),
            completed_at = NULL
      WHERE id = $1 AND world_id = $2 AND requested_by_player_id = $3
        AND analysis_kind = 'ai_enrichment'
        AND status IN ('queued', 'running', 'paused')
      RETURNING id`,
    [params.runId, params.worldId, params.playerId, params.privateError?.slice(0, 4_000) ?? null],
  );
  return updated.rows.length === 1;
}

export function premiumEvidencePinError(params: {
  expected: PremiumEvidencePin;
  parent: {
    id: string;
    status: string;
    analysisKind: string;
    analysisVersion: number;
    corpusFingerprint: string;
    evidenceGraphFingerprint: string;
  } | null;
  currentCorpusFingerprint: string;
  currentConstraintSnapshotFingerprint: string;
  currentVerificationContextFingerprint: string;
}): string | null {
  const { expected, parent } = params;
  if (
    !expected.parentLocalRunId ||
    expected.verificationPacketVersion !== PREMIUM_VERIFICATION_PACKET_VERSION
  ) {
    return "This premium review does not have a current Lorekeeper evidence receipt.";
  }
  if (
    !parent ||
    parent.id !== expected.parentLocalRunId ||
    parent.status !== "completed" ||
    parent.analysisKind !== "local_scan" ||
    parent.analysisVersion < LOCAL_ANALYSIS_VERSION
  ) {
    return "The Canon Intake result selected for this premium review is no longer available.";
  }
  if (
    !expected.corpusFingerprint ||
    parent.corpusFingerprint !== expected.corpusFingerprint ||
    params.currentCorpusFingerprint !== expected.corpusFingerprint
  ) {
    return "The manuscript set changed after this premium review was started.";
  }
  if (
    !expected.evidenceGraphFingerprint ||
    parent.evidenceGraphFingerprint !== expected.evidenceGraphFingerprint
  ) {
    return "The Lorekeeper evidence snapshot changed after this premium review was started.";
  }
  if (
    !expected.constraintSnapshotFingerprint ||
    params.currentConstraintSnapshotFingerprint !==
      expected.constraintSnapshotFingerprint
  ) {
    return "The owner's canon guidance changed after this premium review was started.";
  }
  if (
    !expected.verificationContextFingerprint ||
    params.currentVerificationContextFingerprint !==
      expected.verificationContextFingerprint
  ) {
    return "The premium review context no longer matches its saved receipt.";
  }
  return null;
}

async function assertPremiumEvidencePin(
  db: StudioDb,
  params: {
    worldId: string;
    editionId: string;
    pin: PremiumEvidencePin;
  },
) {
  const [parentResult, sourceResult, constraintResult] = await Promise.all([
    db.query<{
      id: string;
      status: string;
      analysis_kind: string;
      analysis_version: number;
      corpus_fingerprint: string;
      evidence_graph_fingerprint: string;
    }>(
      `SELECT id, status, analysis_kind, analysis_version,
              corpus_fingerprint, evidence_graph_fingerprint
         FROM storyhold.world_analysis_runs
        WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3
        LIMIT 1`,
      [params.pin.parentLocalRunId, params.worldId, params.editionId],
    ),
    db.query<{
      id: string;
      content_hash: string;
      word_count: number;
      chunk_count: number;
      chronology_order: number;
      sort_order: number;
      created_at: string;
    }>(
      `SELECT id, content_hash, word_count, chunk_count,
              chronology_order, sort_order, created_at
         FROM storyhold.world_sources
        WHERE world_id = $1 AND canon_edition_id = $2
          AND processing_status = 'ready'
          AND canon_status IN ('candidate', 'canon')
          AND chunk_count > 0
        ORDER BY chronology_order ASC, sort_order ASC, created_at ASC`,
      [params.worldId, params.editionId],
    ),
    db.query<{ fingerprint: string }>(
      `SELECT fingerprint
         FROM storyhold.world_owner_canon_constraints
        WHERE world_id = $1 AND canon_edition_id = $2 AND status = 'active'
        ORDER BY fingerprint ASC`,
      [params.worldId, params.editionId],
    ),
  ]);
  const parentRow = parentResult.rows[0];
  const error = premiumEvidencePinError({
    expected: params.pin,
    parent: parentRow
      ? {
          id: parentRow.id,
          status: parentRow.status,
          analysisKind: parentRow.analysis_kind,
          analysisVersion: Number(parentRow.analysis_version),
          corpusFingerprint: parentRow.corpus_fingerprint,
          evidenceGraphFingerprint: parentRow.evidence_graph_fingerprint,
        }
      : null,
    currentCorpusFingerprint: lorekeeperCorpusFingerprint(
      sourceResult.rows.map((source) => ({
        id: source.id,
        contentHash: source.content_hash,
        wordCount: Number(source.word_count),
        chunkCount: Number(source.chunk_count),
        chronologyOrder: Number(source.chronology_order),
        sortOrder: Number(source.sort_order),
        createdAt: String(source.created_at),
      })),
    ),
    currentConstraintSnapshotFingerprint:
      lorekeeperConstraintSnapshotFingerprint(constraintResult.rows),
    currentVerificationContextFingerprint:
      params.pin.verificationContextFingerprint,
  });
  if (error) {
    throw new Error(
      `${error} No further premium requests were sent and no stale conclusions were promoted. The saved review needs attention before another premium review can begin.`,
    );
  }
}

type PremiumRunScope = { runId: string; worldId: string; editionId: string; playerId: string };

export function premiumTopUpCreditsNeeded(params: {
  actualCredits: number;
  reservedCredits: number;
  availableCredits: number;
}): number {
  const actual = Math.max(0, Math.ceil(Number(params.actualCredits) || 0));
  const held = Math.max(0, Math.floor(Number(params.reservedCredits) || 0));
  const spendable = Math.max(0, Math.floor(Number(params.availableCredits) || 0));
  return Math.max(0, actual - held - spendable);
}

/** Shared atomic boundary for the successful premium-world projection. The
 * caller writes canon in the same transaction, so an unfunded actual total
 * rolls those writes back while the completed provider journal stays saved. */
export async function settlePremiumWorldReservationInTransaction(
  db: StudioDb,
  params: {
    reservationId: string;
    usage: AiUsage;
    provider: string;
    model: string;
  },
) {
  const settlement = await settleCreditReservationInTransaction(db, {
    reservationId: params.reservationId,
    usage: params.usage,
    provider: params.provider,
    model: params.model,
    reasoning: "high",
    requireFullPayment: true,
  });
  if (settlement.uncoveredCredits > 0) {
    throw new Error("Premium Deep Reading could not be fully settled.");
  }
  return settlement;
}

async function customerPremiumRunFunding(
  db: StudioDb,
  run: Record<string, unknown> | undefined,
  playerId: string,
): Promise<{ topUpCreditsNeeded: number } | null> {
  if (!run || run.analysis_kind !== "ai_enrichment" || run.status !== "paused") return null;
  try {
    const accounting = await readPremiumJournalAccounting(db, String(run.id));
    if (accounting.hasUncertain || accounting.attempts.length === 0) return null;
    const usage = combineAiUsage(accounting.attempts.map((attempt) => attempt.usage));
    const actualCredits = creditsForUsage(usage);
    const funding = await db.query<{
      reserved_credits: number;
      status: string;
      credits: number;
    }>(
      `SELECT reservation.reserved_credits, reservation.status, player.credits
         FROM storyhold.credit_reservations reservation
         JOIN storyhold.players player ON player.id = reservation.player_id
        WHERE reservation.request_id = $1 AND reservation.player_id = $2
          AND reservation.operation = 'world_analysis'
        LIMIT 1`,
      [run.id, playerId],
    );
    const row = funding.rows[0];
    if (!row || row.status !== "reserved") return null;
    const topUpCreditsNeeded = premiumTopUpCreditsNeeded({
      actualCredits,
      reservedCredits: Number(row.reserved_credits),
      availableCredits: Number(row.credits),
    });
    return topUpCreditsNeeded > 0 ? { topUpCreditsNeeded } : null;
  } catch {
    // Unknown or contradictory accounting remains private operator territory.
    // Never turn it into a guessed customer charge.
    return null;
  }
}

export async function recoverKnownRejectedPremiumReview(
  db: StudioRootDb,
  scope: PremiumRunScope,
): Promise<
  | { status: "needs_top_up"; topUpCreditsNeeded: number }
  | { status: "settled"; creditsUsed: number; creditsRemaining: number }
  | null
> {
  const statuses = await db.query<{ status: string }>(
    "SELECT status FROM storyhold.world_analysis_ai_calls WHERE run_id = $1 ORDER BY created_at, step_key",
    [scope.runId],
  );
  if (!statuses.rows.some((row) => row.status === "rejected") ||
      statuses.rows.some((row) => !["completed", "rejected"].includes(row.status))) return null;
  const accounting = await readPremiumJournalAccounting(db, scope.runId);
  if (accounting.hasUncertain || accounting.attempts.length === 0) return null;
  const usage = combineAiUsage(accounting.attempts.map((attempt) => attempt.usage));
  if (premiumUsageNeedsReconciliation(usage) || usage.estimatedCostMicros <= 0) return null;
  const funding = await db.query<{
    id: string;
    reserved_credits: number;
    credits: number;
    private_error: string | null;
  }>(
    `SELECT reservation.id, reservation.reserved_credits, player.credits,
            run.error AS private_error
       FROM storyhold.credit_reservations reservation
       JOIN storyhold.players player ON player.id = reservation.player_id
       JOIN storyhold.world_analysis_runs run ON run.id::text = reservation.request_id
      WHERE reservation.request_id = $1 AND reservation.player_id = $2
        AND reservation.world_id = $3 AND reservation.operation = 'world_analysis'
        AND reservation.status = 'reserved'
      LIMIT 1`,
    [scope.runId, scope.playerId, scope.worldId],
  );
  const held = funding.rows[0];
  if (!held) return null;
  const topUpCreditsNeeded = premiumTopUpCreditsNeeded({
    actualCredits: creditsForUsage(usage),
    reservedCredits: Number(held.reserved_credits),
    availableCredits: Number(held.credits),
  });
  if (topUpCreditsNeeded > 0) return { status: "needs_top_up", topUpCreditsNeeded };
  const settlement = await finalizeKnownPremiumFailureAtomically(db, {
    runId: scope.runId,
    worldId: scope.worldId,
    playerId: scope.playerId,
    reservationId: held.id,
    failureMessage: held.private_error || "The saved review did not pass Storyhold's evidence checks.",
    failedUsage: {
      usage,
      provider: [...new Set(accounting.attempts.map((attempt) => attempt.provider))].join(",") || "mixed",
      model: [...new Set(accounting.attempts.map((attempt) => attempt.model))].join(",") || "mixed",
      attemptCount: accounting.attempts.length,
    },
  });
  return {
    status: "settled",
    creditsUsed: settlement.creditsUsed,
    creditsRemaining: settlement.creditsRemaining,
  };
}

export function frozenPremiumChunksMatch(
  frozen: AnalysisChunk[],
  current: StructuredAnalysisChunk[],
): boolean {
  const byId = new Map(current.map((chunk) => [chunk.id, chunk]));
  const promptFields = (chunk: StructuredAnalysisChunk) => ({
    id: chunk.id, sourceId: chunk.sourceId, sourceTitle: chunk.sourceTitle,
    index: chunk.index, content: chunk.content,
    sectionKey: chunk.sectionKey || null, sectionTitle: chunk.sectionTitle || null,
    sectionIndex: chunk.sectionIndex ?? 0,
  });
  return frozen.every((chunk) => {
    const live = byId.get(chunk.id);
    return live && lorekeeperSnapshotFingerprint(promptFields(chunk)) ===
      lorekeeperSnapshotFingerprint(promptFields(live));
  });
}

async function validatedPremiumResumePlan(db: StudioRootDb, scope: PremiumRunScope) {
  if (await premiumReviewHasFinalization(db, scope.runId)) {
    throw new PremiumReviewPlanError("PREMIUM_FINALIZED", "This premium review has been closed. It cannot be resumed.");
  }
  if (!await readPremiumReviewPlan(db, scope.runId)) {
    throw new PremiumReviewPlanError("PLAN_MISSING", "This review stopped before a resumable plan was saved.");
  }
  const result = await db.query<Record<string, unknown>>(
    `SELECT * FROM storyhold.world_analysis_runs
      WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3
        AND requested_by_player_id = $4 AND analysis_kind = 'ai_enrichment'`,
    [scope.runId, scope.worldId, scope.editionId, scope.playerId],
  );
  const run = result.rows[0];
  if (!run) throw new PremiumReviewPlanError("PREMIUM_RUN_MISSING", "The saved premium review is unavailable.");
  const pin: PremiumEvidencePin = {
    parentLocalRunId: textBody(run.parent_local_run_id, 64),
    corpusFingerprint: textBody(run.corpus_fingerprint, 128),
    evidenceGraphFingerprint: textBody(run.evidence_graph_fingerprint, 128),
    constraintSnapshotFingerprint: textBody(run.constraint_snapshot_fingerprint, 128),
    verificationContextFingerprint: textBody(run.verification_context_fingerprint, 128),
    verificationPacketVersion: Number(run.verification_packet_version ?? 0),
  };
  if (lorekeeperSnapshotFingerprint(recordBody(run.verification_context_snapshot)) !==
      pin.verificationContextFingerprint) {
    throw new PremiumReviewPlanError("PREMIUM_CONTEXT_CHANGED", "The saved review context failed its integrity check.");
  }
  await assertPremiumEvidencePin(db, { worldId: scope.worldId, editionId: scope.editionId, pin });
  const runtime = getAiRuntimeStatus("canon_review", "standard", "verification");
  if (!runtime.configured) throw new PremiumReviewPlanError("PREMIUM_CONNECTION_REQUIRED", "Reconnect the same premium model before resuming.");
  const plan = await validatePremiumReviewResume(db, {
    ...scope,
    executionVersion: PREMIUM_EXECUTION_VERSION,
    scopeFingerprint: lorekeeperSnapshotFingerprint(pin),
    provider: runtime.provider,
    model: runtime.model,
  });
  const chunks = await db.query<{
    id: string; source_id: string; source_title: string; chunk_index: number;
    content: string; metadata: Record<string, unknown> | null;
  }>(
    `SELECT c.id, c.source_id, s.title AS source_title, c.chunk_index, c.content, c.metadata
       FROM storyhold.world_source_chunks c
       JOIN storyhold.world_sources s ON s.id = c.source_id
      WHERE c.world_id = $1 AND c.canon_edition_id = $2 AND c.id = ANY($3::uuid[])
        AND s.processing_status = 'ready' AND s.canon_status IN ('candidate', 'canon')`,
    [scope.worldId, scope.editionId, plan.chunks.map((chunk) => chunk.id)],
  );
  if (!frozenPremiumChunksMatch(plan.chunks, chunks.rows.map((chunk) => ({
    id: chunk.id, sourceId: chunk.source_id, sourceTitle: chunk.source_title,
    index: Number(chunk.chunk_index), content: chunk.content,
    sectionKey: textBody(chunk.metadata?.sectionKey, 240) || null,
    sectionTitle: textBody(chunk.metadata?.sectionTitle, 240) || null,
    sectionIndex: Number(chunk.metadata?.sectionIndex ?? 0),
  })))) {
    throw new PremiumReviewPlanError("PREMIUM_PASSAGES_CHANGED", "The saved review passages changed or are missing. No request was sent.");
  }
  return plan;
}

/** Restart only records recovery state; an explicit authenticated Resume starts work. */
export async function pauseInterruptedPremiumReviews(
  db: StudioRootDb,
  validate: (scope: PremiumRunScope) => Promise<unknown> = (scope) => validatedPremiumResumePlan(db, scope),
) {
  const runs = await db.query<{
    id: string; world_id: string; canon_edition_id: string; requested_by_player_id: string;
  }>(
    `SELECT id, world_id, canon_edition_id, requested_by_player_id
       FROM storyhold.world_analysis_runs
      WHERE analysis_kind = 'ai_enrichment' AND status IN ('queued', 'running', 'paused')`,
  );
  for (const run of runs.rows) {
    let error: string | null = null;
    let planlessWithoutCalls = false;
    try {
      await validate({ runId: run.id, worldId: run.world_id, editionId: run.canon_edition_id, playerId: run.requested_by_player_id });
    } catch (reason) {
      error = reason instanceof Error ? reason.message : "The saved premium review needs attention.";
      if (reason instanceof PremiumReviewPlanError && reason.code === "PLAN_MISSING") {
        try {
          planlessWithoutCalls = (await readPremiumJournalAccounting(db, run.id)).callCount === 0;
          if (planlessWithoutCalls) {
            // Only new mandatory-plan reservations prove no paid work could
            // have happened without a plan. Legacy holds need reconciliation.
            const unused = await db.query<{ id: string }>(
              `SELECT id FROM storyhold.credit_reservations
                WHERE world_id = $1 AND player_id = $2 AND request_id = $3
                  AND operation = 'world_analysis' AND status = 'reserved'
                  AND usage->>'premiumResumeVersion' = '1'`,
              [run.world_id, run.requested_by_player_id, run.id],
            );
            for (const hold of unused.rows) {
              await releaseCreditReservation(db, hold.id, "Review stopped before its mandatory plan and first provider request.");
            }
          }
        } catch {
          planlessWithoutCalls = false;
        }
      }
    }
    await db.query(
      `UPDATE storyhold.world_analysis_runs
          SET status = $2, premium_resume_status = $3, stage = $4, error = $5,
              pause_requested = false, paused_at = CASE WHEN $2 = 'paused' THEN now() ELSE paused_at END,
              completed_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END
        WHERE id = $1 AND status IN ('queued', 'running', 'paused')`,
      [run.id, planlessWithoutCalls ? "failed" : "paused",
        planlessWithoutCalls ? "not_available" : error ? "blocked" : "ready",
        error ? "Premium Deep Reading Needs Attention" : "Premium Deep Reading Saved — Resume When Ready",
        error?.slice(0, 4000) ?? null],
    );
  }
}

export async function claimPausedPremiumReview(db: StudioRootDb, scope: PremiumRunScope, liveWorker: boolean) {
  return db.transaction(async (tx) => {
    await tx.query("SELECT id FROM storyhold.worlds WHERE id = $1 FOR UPDATE", [scope.worldId]);
    if (await premiumReviewHasFinalization(tx, scope.runId)) return false;
    const competing = await tx.query(
      `SELECT id FROM storyhold.world_analysis_runs
        WHERE world_id = $1 AND id <> $2 AND status IN ('queued', 'running', 'paused') LIMIT 1`,
      [scope.worldId, scope.runId],
    );
    if (competing.rows.length) return false;
    const claimed = await tx.query(
      `UPDATE storyhold.world_analysis_runs
          SET status = $5, pause_requested = false, paused_at = NULL,
              stage = 'Restoring Saved Premium Deep Reading', error = NULL, completed_at = NULL
        WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3
          AND requested_by_player_id = $4 AND analysis_kind = 'ai_enrichment' AND status = 'paused'
        RETURNING id`,
      [scope.runId, scope.worldId, scope.editionId, scope.playerId, liveWorker ? "running" : "queued"],
    );
    return claimed.rows.length === 1;
  });
}

type AiReviewState = Pick<
  SourceReviewRow,
  "content_hash" | "chunk_count" | "ai_review_status" |
  "ai_reviewed_content_hash" | "ai_analysis_version" |
  "ai_reviewed_chunk_count" | "ai_coverage_authoritative"
>;

export function sourceNeedsAiReview(
  source: AiReviewState,
): boolean {
  if (source.ai_review_status === "failed") return true;
  const stale =
    source.ai_reviewed_content_hash !== source.content_hash ||
    Number(source.ai_analysis_version) < WORLD_ANALYSIS_VERSION;
  const incomplete =
    !source.ai_coverage_authoritative ||
    Number(source.ai_reviewed_chunk_count) < Number(source.chunk_count);
  if (source.ai_review_status === "reviewed") return stale || incomplete;
  if (source.ai_review_status !== "waiting") return false;
  return incomplete || stale;
}

function sourceRequiresFullAiReview(source: AiReviewState): boolean {
  if (source.ai_review_status === "failed") return true;
  const hasPriorReviewState =
    Number(source.ai_reviewed_chunk_count) > 0 ||
    source.ai_reviewed_content_hash !== null ||
    Number(source.ai_analysis_version) > 0;
  if (!hasPriorReviewState) return false;
  return !source.ai_coverage_authoritative ||
    source.ai_reviewed_content_hash !== source.content_hash ||
    Number(source.ai_analysis_version) < WORLD_ANALYSIS_VERSION;
}

export function aiReviewQueuePlan<T extends AiReviewState>(params: {
  eligible: T[];
  forceFull?: boolean;
}): {
  sources: T[];
  incremental: boolean;
} {
  const requested = params.forceFull
    ? params.eligible
    : params.eligible.filter((source) => sourceNeedsAiReview(source));
  if (requested.length === 0) return { sources: [], incremental: false };

  // A pristine, newly uploaded source can safely extend an already coherent
  // snapshot. Any source that claims prior review without authoritative,
  // current-version coverage cannot: reread the complete edition so replacing
  // generated state never drops facts from sources outside the retry set.
  const fullReview = Boolean(params.forceFull) ||
    requested.some((source) => sourceRequiresFullAiReview(source));
  const sources = fullReview ? params.eligible : requested;
  return {
    sources,
    incremental:
      !fullReview &&
      sources.every((source) => source.ai_review_status === "waiting"),
  };
}

const activeRuns = new Set<string>();
const automaticAnalysisTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();

const pausePollDelay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function localCheckpointProgress(checkpoint: WorldAnalysisLocalCheckpoint): {
  progress: number;
  stage: string;
} {
  if (checkpoint.bge) {
    const ratio = checkpoint.bge.completedGroups /
      Math.max(1, checkpoint.bge.totalGroups);
    return {
      progress: checkpoint.completedStage === "bge"
        ? 86
        : 78 + Math.round(Math.min(1, ratio) * 8),
      stage: "ranking the strongest evidence passages",
    };
  }
  if (checkpoint.minilm) {
    const ratio = checkpoint.minilm.completedGroups /
      Math.max(1, checkpoint.minilm.totalGroups);
    return {
      progress: checkpoint.completedStage === "minilm"
        ? 78
        : 68 + Math.round(Math.min(1, ratio) * 10),
      stage: "building the evidence shortlist",
    };
  }
  if (checkpoint.nliResults) {
    return {
      progress: checkpoint.completedStage === "nli" ? 68 : 58,
      stage: "checking relationship claims against the manuscript",
    };
  }
  if (checkpoint.coreference) {
    const receipt = checkpoint.coreference.receipt;
    return {
      progress: checkpoint.completedStage === "coreference"
        ? 58
        : 46 + Math.round(
            (receipt.completedChunkIds.length / Math.max(1, receipt.attemptedChunks)) * 12,
          ),
      stage: "linking pronouns and aliases to their story identities",
    };
  }
  const gliner2 = checkpoint.gliner2;
  if (gliner2) {
    return {
      progress: checkpoint.completedStage === "gliner2"
        ? 46
        : 10 + Math.round(
            (gliner2.completedSegments / Math.max(1, gliner2.totalSegments)) * 36,
          ),
      stage: "discovering and structuring story concepts",
    };
  }
  return { progress: 10, stage: "deterministic source inventory saved" };
}

async function waitWhileWorldAnalysisPaused(
  db: StudioRootDb,
  params: { runId: string; worldId: string },
) {
  let announced = false;
  let lastReservationExtension = 0;
  for (;;) {
    const state = await db.query<{
      status: string;
      pause_requested: boolean;
    }>(
      `SELECT status, pause_requested
         FROM storyhold.world_analysis_runs
        WHERE id = $1 AND world_id = $2
        LIMIT 1`,
      [params.runId, params.worldId],
    );
    const row = state.rows[0];
    if (!row) throw new Error("The active Canon Intake run no longer exists.");
    if (!row.pause_requested && row.status !== "paused") return;

    if (!announced) {
      // The current inference request has reached a safe boundary. Every local
      // batch persists its output before reaching this gate, so releasing the
      // specialist cannot erase Resume state even if Node later restarts.
      await releaseLorekeeperStage().catch(() => undefined);
      await db.query(
        `UPDATE storyhold.world_analysis_runs
            SET status = 'paused', stage = 'Paused by you', paused_at = now()
          WHERE id = $1 AND status IN ('queued', 'running', 'paused')`,
        [params.runId],
      );
      await appendIntakeActivity(db, params.runId, [{
        dedupeKey: `${params.runId}:manually-paused`,
        kind: "warning",
        label: "Canon Intake paused",
        detail: "Completed work is saved at a durable processing boundary. Resume when this device is ready.",
        entityName: null,
        entityType: null,
      }]);
      announced = true;
    }

    if (Date.now() - lastReservationExtension >= 5 * 60_000) {
      await db.query(
        `UPDATE storyhold.credit_reservations
            SET expires_at = GREATEST(expires_at, now() + interval '24 hours')
          WHERE request_id = $1 AND status = 'reserved'`,
        [params.runId],
      );
      lastReservationExtension = Date.now();
    }
    await pausePollDelay(500);
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export async function frozenPremiumClockContext(db: StudioDb, params: {
  worldId: string;
  editionId: string;
}): Promise<{
  entities: PremiumClockEntityRegistryEntry[];
  ownerConstraints: PremiumClockOwnerConstraint[];
}> {
  const [entityRows, constraintRows] = await Promise.all([
    db.query<{ id: string; name: string; aliases: unknown; entity_type: string }>(
      `SELECT id, name, aliases, entity_type
         FROM storyhold.world_entities
        WHERE world_id = $1 AND canon_edition_id = $2
          AND pull_status = 'active' AND merged_into_entity_id IS NULL
        ORDER BY id ASC`,
      [params.worldId, params.editionId],
    ),
    db.query<Record<string, unknown>>(
      `SELECT id, scope_entity_id, constraint_kind, instruction, status, created_at
         FROM storyhold.world_owner_canon_constraints
        WHERE world_id = $1 AND canon_edition_id = $2 AND status = 'active'
        ORDER BY id ASC
        LIMIT 501`,
      [params.worldId, params.editionId],
    ),
  ]);
  const entities = entityRows.rows.map((row) => {
    if (!Array.isArray(row.aliases)
      || row.aliases.some((alias) => typeof alias !== "string" || !alias.trim())) {
      throw new Error(
        "The canonical identity registry contains malformed aliases. Repair the affected dossier before starting Premium Deep Reading.",
      );
    }
    return {
      id: row.id,
      name: row.name,
      aliases: [...row.aliases] as string[],
      entityType: row.entity_type,
    };
  });
  if (constraintRows.rows.length > 500) {
    throw new Error(
      "Premium Deep Reading cannot start while this world has more than 500 active owner corrections. Consolidate or dismiss older corrections first; no credits were reserved.",
    );
  }
  const constraints = constraintRows.rows.map(serializeOwnerConstraint);
  return {
    entities,
    ownerConstraints: constraints.map((constraint) => ({
      id: constraint.id,
      kind: ({
        identity: "identity",
        relationship: "relation",
        category: "categorization",
        chronology: "timeline",
        fact: "canon",
        focus: "other",
      } as const)[constraint.kind],
      instruction: constraint.instruction,
      scopeEntityId: constraint.entityId,
    })).sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function shouldReviewAnalysisChunk(params: {
  kind: "local_scan" | "ai_enrichment";
  incremental: boolean;
  chunkIndex: number;
  reviewedChunkCount: number;
  coverageAuthoritative?: boolean;
  durablyCovered?: boolean;
}) {
  if (params.kind !== "ai_enrichment" || !params.incremental) return true;
  if (params.coverageAuthoritative) return !params.durablyCovered;
  return params.chunkIndex >= params.reviewedChunkCount;
}

export function analysisChunkCoverageBatches(
  chunks: AnalysisChunk[],
  maximumCharacters = 48_000,
) {
  const batches: AnalysisChunk[][] = [];
  let current: AnalysisChunk[] = [];
  let currentCharacters = 0;
  for (const chunk of chunks) {
    if (
      current.length > 0 &&
      currentCharacters + chunk.content.length > maximumCharacters
    ) {
      batches.push(current);
      current = [];
      currentCharacters = 0;
    }
    current.push(chunk);
    currentCharacters += chunk.content.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

type StructuredAnalysisChunk = AnalysisChunk & {
  sectionKey?: string | null;
  sectionTitle?: string | null;
  sectionIndex?: number;
  coverageAuthoritative?: boolean;
  reviewedChunkCount?: number;
};

export function breadthFirstAnalysisChunks<T extends StructuredAnalysisChunk>(
  chunks: T[],
) {
  const buckets = new Map<string, T[]>();
  for (const chunk of chunks) {
    const sectionKey = textBody(chunk.sectionKey, 240);
    // Older imports did not persist chapter metadata. Four-passage windows
    // still spread a credit-limited review through the whole manuscript
    // instead of spending the entire allowance on its opening chapters.
    const fallbackWindow = Math.floor(Math.max(0, chunk.index) / 4);
    const usesLegacyCursor =
      chunk.coverageAuthoritative === false &&
      Number(chunk.reviewedChunkCount ?? 0) > 0;
    const key = usesLegacyCursor
      ? `${chunk.sourceId}:legacy-sequential-tail`
      : `${chunk.sourceId}:${sectionKey || `window-${fallbackWindow}`}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(chunk);
    buckets.set(key, bucket);
  }
  const ordered: T[] = [];
  let depth = 0;
  while (ordered.length < chunks.length) {
    let added = false;
    for (const bucket of buckets.values()) {
      const chunk = bucket[depth];
      if (!chunk) continue;
      ordered.push(chunk);
      added = true;
    }
    if (!added) break;
    depth += 1;
  }
  return ordered;
}

export function selectBreadthFirstAffordableChunks<
  T extends StructuredAnalysisChunk,
>(params: {
  chunks: T[];
  availableCredits: number;
  creditsForChunks: (chunks: T[]) => number;
}) {
  const breadthOrder = breadthFirstAnalysisChunks(params.chunks);
  let affordableCount = largestAffordablePrefix(
    breadthOrder.length,
    params.availableCredits,
    (count) => params.creditsForChunks(breadthOrder.slice(0, count)),
  );
  while (affordableCount > 0) {
    const selectedIds = new Set(
      breadthOrder.slice(0, affordableCount).map((chunk) => chunk.id),
    );
    const chronological = params.chunks.filter((chunk) =>
      selectedIds.has(chunk.id),
    );
    if (params.creditsForChunks(chronological) <= params.availableCredits) {
      return chronological;
    }
    affordableCount -= 1;
  }
  return [];
}

export function findingCountsByChunk(value: unknown, graphReviews?: readonly PremiumGraphReviewReceipt[], statReviews?: readonly PremiumStatReviewReceipt[]) {
  const counts = new Map<string, number>();
  if (graphReviews !== undefined) graphFromPremiumReceipts(graphReviews);
  // A selected canonical paraphrase is not the whole reviewed graph. Count
  // ordinary findings as before, and replace only typed graph arrays with the
  // exact verified proposal inventory below to avoid counting them twice.
  let ordinaryFindings = graphReviews !== undefined && value && typeof value === "object" && !Array.isArray(value)
    ? { ...value as Record<string, unknown>, entityRelations: [], entityRules: [] }
    : value;
  if (statReviews !== undefined && ordinaryFindings && typeof ordinaryFindings === "object" && !Array.isArray(ordinaryFindings)) {
    const copy = { ...ordinaryFindings as Record<string, unknown> };
    for (const family of PREMIUM_STAT_FAMILIES) {
      if (!Array.isArray(copy[family])) continue;
      copy[family] = (copy[family] as unknown[]).map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
        const { estimatedStats: _stats, ...rest } = entry as Record<string, unknown>;
        return rest;
      });
    }
    ordinaryFindings = copy;
  }
  for (const evidence of evidenceReferencesFrom(ordinaryFindings)) {
    counts.set(evidence.chunkId, (counts.get(evidence.chunkId) ?? 0) + 1);
  }
  const countedGraphPayloadChunks = new Set<string>();
  for (const receipt of statReviews ?? []) assertPremiumStatReceipt(receipt);
  for (const receipt of [...graphReviews ?? [], ...statReviews ?? []]) {
    const proposals = new Map(receipt.packet.proposals.map((proposal) => [proposal.id, proposal]));
    const anchors = new Map(receipt.packet.evidence.map((anchor) => [anchor.id, anchor]));
    for (const decision of receipt.decisions) {
      if (decision.verdict !== "verified") continue;
      const proposal = proposals.get(decision.proposalId)!;
      const payloadFingerprint = lorekeeperSnapshotFingerprint({ kind: proposal.kind, payload: proposal.payload });
      for (const evidenceId of decision.supportingEvidenceIds) {
        const anchor = anchors.get(evidenceId)!;
        const key = `${payloadFingerprint}\u0000${anchor.chunkId}`;
        if (countedGraphPayloadChunks.has(key)) continue;
        countedGraphPayloadChunks.add(key);
        counts.set(anchor.chunkId, (counts.get(anchor.chunkId) ?? 0) + 1);
      }
    }
  }
  return counts;
}

export async function seedChunkCoverage(
  db: StudioDb,
  runId: string,
  chunks: AnalysisChunk[],
) {
  for (const chunk of chunks) {
    await db.query(
      `INSERT INTO storyhold.world_analysis_chunk_coverage
        (analysis_run_id, chunk_id, source_id, chunk_index, content_hash,
         status, finding_count, error)
       VALUES ($1, $2, $3, $4, $5, 'failed', 0,
               'The review did not reach this passage.')
       ON CONFLICT (analysis_run_id, chunk_id) DO NOTHING`,
      [
        runId,
        chunk.id,
        chunk.sourceId,
        chunk.index,
        createHash("sha256").update(chunk.content).digest("hex"),
      ],
    );
  }
}

async function persistWorldAnalysisCoverage(
  db: StudioDb,
  runId: string,
  coverage: WorldAnalysisCoverage,
  fromBatchIndex = 0,
) {
  for (const batch of coverage.batches.slice(fromBatchIndex)) {
    for (const chunk of batch.chunks) {
      await db.query(
        `UPDATE storyhold.world_analysis_chunk_coverage
            SET status = $3, finding_count = $4, error = NULL,
                completed_at = now(), updated_at = now()
          WHERE analysis_run_id = $1 AND chunk_id = $2`,
        [
          runId,
          chunk.chunkId,
          chunk.status === "findings" ? "analyzed" : "no_findings",
          chunk.status === "findings" ? 1 : 0,
        ],
      );
    }
  }
  const synthesis = coverage.finalSynthesis;
  await db.query(
    `UPDATE storyhold.world_analysis_runs
        SET synthesis_status = $2,
            synthesis_group_count = $3,
            synthesis_completed_group_count = $4,
            synthesis_error = $5,
            synthesis_completed_at = CASE
              WHEN $2 IN ('completed', 'not_applicable') THEN now()
              ELSE NULL END
      WHERE id = $1`,
    [
      runId,
      synthesis.status,
      Math.max(0, Number(synthesis.groupCount ?? 0)),
      Math.max(0, Number(synthesis.completedGroups ?? 0)),
      synthesis.error?.slice(0, 4_000) ?? null,
    ],
  );
  return coverage.batches.length;
}

export async function finalizeChunkCoverage(
  db: StudioDb,
  runId: string,
  chunks: AnalysisChunk[],
  findings: WorldFindings,
  graphCoverage?: {
    scope: { worldId: string; editionId: string; analysisRunId: string };
    reviews: PremiumGraphReviewReceipt[];
    expectedStepKeys: string[];
    verificationPages?: PremiumVerificationPage[];
    verificationBatches?: string[][];
    statReviews?: PremiumStatReviewReceipt[];
  },
) {
  if (graphCoverage) {
    if (graphCoverage.scope.analysisRunId !== runId) {
      throw new Error("Graph coverage scope does not match the analysis run being finalized.");
    }
    assertExpectedPremiumGraphReviews(graphCoverage.reviews, {
      scope: graphCoverage.scope, expectedStepKeys: graphCoverage.expectedStepKeys,
    });
    const receiptsByStep = new Map(graphCoverage.reviews.map((receipt) => [receipt.request.stepKey, receipt]));
    if (graphCoverage.statReviews !== undefined) {
      assertExpectedPremiumStatReviews(graphCoverage.statReviews, {
        scope: graphCoverage.scope, expectedStepKeys: graphCoverage.expectedStepKeys,
      });
      assertPremiumStatProjection(findings, graphCoverage.statReviews);
      for (const receipt of graphCoverage.statReviews) {
        const graph = receiptsByStep.get(receipt.request.stepKey)!;
        if (lorekeeperSnapshotFingerprint(receipt.request.chunks) !== lorekeeperSnapshotFingerprint(graph.request.chunks)) {
          throw new Error("Stat coverage does not match its exact frozen source batch.");
        }
      }
    }
    let reviewedChunks = graphCoverage.expectedStepKeys.flatMap((stepKey) => receiptsByStep.get(stepKey)!.request.chunks);
    if (graphCoverage.verificationPages !== undefined || graphCoverage.verificationBatches !== undefined) {
      if (!graphCoverage.verificationPages || !graphCoverage.verificationBatches) {
        throw new Error("Paged graph coverage requires both frozen candidate pages and source batches.");
      }
      assertPremiumVerificationPages(graphCoverage.verificationPages, graphCoverage.verificationBatches.length);
      if (graphCoverage.verificationPages.length !== graphCoverage.expectedStepKeys.length ||
          graphCoverage.verificationPages.some((page, index) => page.stepKey !== graphCoverage.expectedStepKeys[index])) {
        throw new Error("Graph coverage page steps differ from the frozen review inventory.");
      }
      const submittedById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
      const sourceIds = graphCoverage.verificationBatches.flat();
      if (sourceIds.length !== chunks.length || sourceIds.some((id, index) => id !== chunks[index]?.id) ||
          graphCoverage.verificationBatches.some((batch) => batch.length === 0)) {
        throw new Error("Graph coverage source batches do not match the exact submitted source chunk partition.");
      }
      for (const page of graphCoverage.verificationPages) {
        const actual = receiptsByStep.get(page.stepKey)!.request.chunks;
        const expected = graphCoverage.verificationBatches[page.batchIndex]!;
        if (actual.length !== expected.length || actual.some((item, index) => {
          const supplied = submittedById.get(expected[index]!);
          return !supplied || item.id !== supplied.id || item.sourceId !== supplied.sourceId || item.text !== supplied.content;
        })) throw new Error("Graph coverage page does not match its exact frozen source batch.");
      }
      // Repeated source context on candidate pages is intentional. Validate
      // every copy above, then finalize each original source chunk only once.
      reviewedChunks = chunks.map((chunk) => ({ id: chunk.id, sourceId: chunk.sourceId, text: chunk.content }));
    }
    if (new Set(chunks.map((chunk) => chunk.id)).size !== chunks.length
      || reviewedChunks.length !== chunks.length
      || reviewedChunks.some((reviewed, index) => {
        const submitted = chunks[index];
        return !submitted || reviewed.id !== submitted.id || reviewed.sourceId !== submitted.sourceId || reviewed.text !== submitted.content;
      })) {
      throw new Error("Graph coverage receipts do not match the exact submitted source chunk partition.");
    }
  }
  // All receipt, scope, and source checks finish before the first coverage write.
  const findingCounts = findingCountsByChunk(findings, graphCoverage?.reviews, graphCoverage?.statReviews);
  for (const chunk of chunks) {
    const findingCount = findingCounts.get(chunk.id) ?? 0;
    await db.query(
      `UPDATE storyhold.world_analysis_chunk_coverage
          SET status = $3, finding_count = $4, error = NULL,
              completed_at = now(), updated_at = now()
        WHERE analysis_run_id = $1 AND chunk_id = $2
          AND status <> 'failed'`,
      [
        runId,
        chunk.id,
        findingCount > 0 ? "analyzed" : "no_findings",
        findingCount,
      ],
    );
  }
}

async function setReviewStatus(
  db: StudioDb,
  kind: AnalysisKind,
  sourceIds: string[],
  status: "queued" | "running" | "failed",
) {
  if (sourceIds.length === 0) return;
  const placeholders = sourceIds.map((_, index) => `$${index + 2}`).join(",");
  const column = kind === "ai_enrichment" ? "ai_review_status" : "local_scan_status";
  await db.query(
    `UPDATE storyhold.world_sources SET ${column} = $1 WHERE id IN (${placeholders})`,
    [status, ...sourceIds],
  );
}

async function completeSourceReviews(params: {
  db: StudioDb;
  kind: AnalysisKind;
  incremental: boolean;
  sourceIds: string[];
  provider: string;
  model: string;
  reviewedChunkCounts?: Map<string, number>;
}) {
  if (params.sourceIds.length === 0) return;
  if (params.kind === "ai_enrichment") {
    for (const sourceId of params.sourceIds) {
      const reviewedChunks = Math.max(0, params.reviewedChunkCounts?.get(sourceId) ?? 0);
      if (!reviewedChunks) continue;
      await params.db.query(
        `UPDATE storyhold.world_sources
            SET ai_reviewed_chunk_count = CASE
                  WHEN ai_coverage_authoritative
                  THEN LEAST(chunk_count, $2)
                  WHEN $5::boolean
                  THEN LEAST(chunk_count, ai_reviewed_chunk_count + $2)
                  ELSE LEAST(chunk_count, $2)
                END,
                ai_review_status = CASE
                  WHEN (CASE
                         WHEN ai_coverage_authoritative THEN $2
                         WHEN $5::boolean THEN ai_reviewed_chunk_count + $2
                         ELSE $2 END) >= chunk_count
                  THEN 'reviewed'
                  ELSE 'waiting'
                END,
                ai_reviewed_content_hash = content_hash,
                ai_analysis_version = ${WORLD_ANALYSIS_VERSION},
                ai_review_provider = $3, ai_review_model = $4, ai_reviewed_at = now()
          WHERE id = $1`,
        [
          sourceId,
          reviewedChunks,
          params.provider,
          params.model,
          params.incremental,
        ],
      );
    }
  } else {
    const placeholders = params.sourceIds
      .map((_, index) => `$${index + 1}`)
      .join(",");
    await params.db.query(
      `UPDATE storyhold.world_sources
          SET local_scan_status = 'completed', local_scanned_content_hash = content_hash,
              local_scanned_at = now(), local_analysis_version = ${LOCAL_ANALYSIS_VERSION}
        WHERE id IN (${placeholders})`,
      params.sourceIds,
    );
  }
}

type CanonIntakePreflight = {
  wordCount: number;
  sourceCount: number;
  passageCount: number;
  unpaidWordCount: number;
  unpaidSourceCount: number;
  priorCreditsCharged: number;
  requiredCredits: number;
  wordLimit: number;
  largeWarningWordCount: number;
  largeIntake: boolean;
  overLimit: boolean;
};

export async function canonIntakePreflight(
  db: StudioRootDb,
  params: { worldId: string; editionId: string },
): Promise<CanonIntakePreflight> {
  const [sourceResult, entitlementResult] = await Promise.all([
    db.query<{
      source_count: number;
      word_count: number;
      passage_count: number;
      unpaid_source_count: number;
      unpaid_word_count: number;
    }>(
      `SELECT count(*)::int AS source_count,
              COALESCE(sum(word_count), 0)::int AS word_count,
              COALESCE(sum(chunk_count), 0)::int AS passage_count,
              count(*) FILTER (WHERE intake_payment_required = true)::int AS unpaid_source_count,
              COALESCE(sum(word_count) FILTER (WHERE intake_payment_required = true), 0)::int AS unpaid_word_count
         FROM storyhold.world_sources
        WHERE world_id = $1 AND canon_edition_id = $2
          AND processing_status = 'ready'
          AND canon_status IN ('candidate', 'canon')
          AND source_kind <> 'reference'`,
      [params.worldId, params.editionId],
    ),
    db.query<{ paid_word_count: number; credits_charged: number }>(
      `SELECT COALESCE(sum(word_count), 0)::int AS paid_word_count,
              COALESCE(sum(credits_charged), 0)::int AS credits_charged
         FROM storyhold.world_intake_entitlements
        WHERE world_id = $1 AND canon_edition_id = $2`,
      [params.worldId, params.editionId],
    ),
  ]);
  const source = sourceResult.rows[0];
  const entitlement = entitlementResult.rows[0];
  const currentWordCount = Number(source?.word_count ?? 0);
  const unpaidWordCount = Number(source?.unpaid_word_count ?? 0);
  const historicWordCount =
    Number(entitlement?.paid_word_count ?? 0) + unpaidWordCount;
  const wordCount = Math.max(currentWordCount, historicWordCount);
  const sourceCount = Number(source?.source_count ?? 0);
  const passageCount = Number(source?.passage_count ?? 0);
  const unpaidSourceCount = Number(source?.unpaid_source_count ?? 0);
  const priorCreditsCharged = Number(entitlement?.credits_charged ?? 0);
  const pricing = canonIntakePricingFromEnvironment();
  const requiredCredits = unpaidSourceCount > 0
    ? incrementalLocalIntakeCredits(
        {
          cumulativeWordCount: wordCount,
          priorCreditsCharged,
          sourceCount,
          passageCount,
        },
        pricing,
      )
    : 0;
  return {
    wordCount,
    sourceCount,
    passageCount,
    unpaidWordCount,
    unpaidSourceCount,
    priorCreditsCharged,
    requiredCredits,
    wordLimit: pricing.localWorldWordLimit,
    largeWarningWordCount: pricing.localLargeIntakeWarningWords,
    largeIntake: canonIntakeNeedsLargeWarning(wordCount, pricing),
    overLimit: wordCount > pricing.localWorldWordLimit,
  };
}

async function queueWorldAnalysis(
  db: StudioRootDb,
  params: {
    worldId: string;
    editionId: string;
    playerId: string;
    kind: AnalysisKind;
    trigger: AnalysisTrigger;
    forceFull?: boolean;
    userGuidance?: string;
  },
): Promise<{
  id: string;
  status: "queued";
  provider: string;
  model: string;
  analysisKind: AnalysisKind;
} | null> {
  const alreadyRunning = await db.query<{ id: string }>(
    `SELECT id FROM storyhold.world_analysis_runs
      WHERE world_id = $1 AND status IN ('queued', 'running', 'paused')
      LIMIT 1`,
    [params.worldId],
  );
  if (alreadyRunning.rows[0] || activeRuns.has(params.worldId)) return null;
  if (params.kind === "ai_enrichment" &&
      await premiumReviewReconciliationPending(db, params.worldId)) return null;

  const runtime = params.kind === "ai_enrichment"
    ? getAiRuntimeStatus("canon_review", "standard", "verification")
    : getAiRuntimeStatus("world_analysis", "standard", "extraction");
  if (params.kind === "ai_enrichment" && !runtime.configured) return null;
  const sourceResult = await db.query<SourceReviewRow>(
    `SELECT id, content_hash, word_count, chunk_count, chronology_order, sort_order,
            created_at,
            intake_payment_required,
            local_scan_status, local_scanned_content_hash,
            local_analysis_version, ai_review_status, ai_reviewed_content_hash, ai_analysis_version,
            ai_reviewed_chunk_count, ai_coverage_authoritative
       FROM storyhold.world_sources
      WHERE world_id = $1 AND canon_edition_id = $2
        AND processing_status = 'ready' AND canon_status IN ('candidate', 'canon')
        AND chunk_count > 0
      ORDER BY chronology_order ASC, sort_order ASC, created_at ASC`,
    [params.worldId, params.editionId],
  );
  // Startup maintenance must never become a free path through a customer-paid
  // intake. A newly uploaded source remains waiting for the customer-triggered
  // run that owns its product charge.
  const eligible =
    params.kind === "local_scan" && params.trigger === "backfill"
      ? sourceResult.rows.filter((source) => !source.intake_payment_required)
      : sourceResult.rows;
  const aiPlan = params.kind === "ai_enrichment"
    ? aiReviewQueuePlan({ eligible, forceFull: params.forceFull })
    : null;
  const reviewTargets = aiPlan?.sources ?? (params.forceFull
    ? eligible
    : eligible.filter((source) =>
        source.local_scan_status === "failed" ||
        source.local_scan_status === "pending" ||
        (source.local_scan_status === "completed" &&
          (source.local_scanned_content_hash !== source.content_hash ||
            Number(source.local_analysis_version) < LOCAL_ANALYSIS_VERSION)),
      ));
  if (reviewTargets.length === 0) return null;
  const incrementalReview = aiPlan?.incremental ?? false;
  const userGuidance = textBody(params.userGuidance, 4_000);

  const corpusFingerprint = lorekeeperCorpusFingerprint(
    eligible.map((source) => ({
      id: source.id,
      contentHash: source.content_hash,
      wordCount: Number(source.word_count),
      chunkCount: Number(source.chunk_count),
      chronologyOrder: Number(source.chronology_order),
      sortOrder: Number(source.sort_order),
      createdAt: String(source.created_at),
    })),
  );
  const constraintRows = await db.query<{ fingerprint: string }>(
    `SELECT fingerprint
       FROM storyhold.world_owner_canon_constraints
      WHERE world_id = $1 AND canon_edition_id = $2 AND status = 'active'
      ORDER BY fingerprint ASC`,
    [params.worldId, params.editionId],
  );
  const constraintSnapshotFingerprint =
    lorekeeperConstraintSnapshotFingerprint(constraintRows.rows);
  let parentLocalRunId: string | null = null;
  let evidenceGraphFingerprint = "";
  let verificationContextSnapshot: Record<string, unknown> = {};
  let verificationContextFingerprint = "";
  if (params.kind === "ai_enrichment") {
    const localSourcesReady = eligible.every((source) =>
      source.local_scan_status === "completed" &&
      source.local_scanned_content_hash === source.content_hash &&
      Number(source.local_analysis_version) >= LOCAL_ANALYSIS_VERSION
    );
    if (!localSourcesReady) {
      throw new Error(
        "Finish Canon Intake for every current manuscript before starting Premium Deep Reading.",
      );
    }
    const localAnchorResult = await db.query<{
      run_id: string;
      evidence_graph: unknown;
      evidence_graph_fingerprint: string;
    }>(
      `SELECT local_run.id AS run_id, breakdown.evidence_graph,
              local_run.evidence_graph_fingerprint
         FROM storyhold.world_analysis_runs local_run
         JOIN storyhold.world_breakdowns breakdown
           ON breakdown.analysis_run_id = local_run.id
        WHERE local_run.world_id = $1
          AND local_run.canon_edition_id = $2
          AND local_run.analysis_kind = 'local_scan'
          AND local_run.status = 'completed'
          AND local_run.analysis_version >= ${LOCAL_ANALYSIS_VERSION}
          AND local_run.corpus_fingerprint = $3
        ORDER BY local_run.completed_at DESC NULLS LAST,
                 breakdown.version DESC
        LIMIT 1`,
      [params.worldId, params.editionId, corpusFingerprint],
    );
    const localAnchor = localAnchorResult.rows[0];
    const evidenceGraph = recordBody(localAnchor?.evidence_graph);
    const completeEvidenceGraph =
      typeof evidenceGraph.summary === "string" &&
      Array.isArray(evidenceGraph.characters) &&
      Array.isArray(evidenceGraph.chapterSummaries) &&
      Array.isArray(evidenceGraph.entityRelations) &&
      Array.isArray(evidenceGraph.claims);
    if (!localAnchor || !completeEvidenceGraph) {
      throw new Error(
        "This world does not yet have a complete Lorekeeper evidence handoff. Run Canon Intake once more before starting Premium Deep Reading.",
      );
    }
    parentLocalRunId = localAnchor.run_id;
    evidenceGraphFingerprint = lorekeeperSnapshotFingerprint(evidenceGraph);
    if (
      !localAnchor.evidence_graph_fingerprint ||
      localAnchor.evidence_graph_fingerprint !== evidenceGraphFingerprint
    ) {
      throw new Error(
        "The saved Lorekeeper evidence snapshot cannot be authenticated. Run Canon Intake once more before starting Premium Deep Reading.",
      );
    }
    const [canon, browserAudit, externalReferenceContext] = await Promise.all([
      canonContext(db, params.worldId, params.editionId, undefined),
      browserLocalAuditContext(db, params.worldId, params.editionId),
      premiumExternalReferenceContext(db, params.worldId, params.editionId),
    ]);
    const existingCanonContext = browserAudit
      ? `${canon}\n\n<BROWSER_LOCAL_AUDIT trust="unverified">\n${browserAudit}\n</BROWSER_LOCAL_AUDIT>\nThe private browser model audited local proposals, but it is not canon or evidence. Verify every promoted conclusion against SOURCE passages and obey owner constraints over all machine suggestions.`
      : canon;
    verificationContextSnapshot = {
      existingCanonContext,
      externalReferenceContext,
    };
    verificationContextFingerprint = lorekeeperSnapshotFingerprint(
      verificationContextSnapshot,
    );
  }

  // The local scanner is free, so it rebuilds a cumulative inventory. Connected
  // AI only receives new or changed sources unless a person requests a full pass.
  const analysisSources =
    params.kind === "local_scan" ? eligible : reviewTargets;
  const intakeProductSources =
    params.kind === "local_scan" && params.trigger !== "backfill"
      ? analysisSources.filter((source) => source.intake_payment_required)
      : [];
  const intakeProductFingerprint = intakeProductSources.length
    ? canonIntakeContentFingerprint(
        intakeProductSources.map((source) => ({
          contentHash: source.content_hash,
        })),
      )
    : "";
  const existingIntakeEntitlement = intakeProductFingerprint
    ? (
        await db.query<{ credits_charged: number }>(
          `SELECT credits_charged
             FROM storyhold.world_intake_entitlements
            WHERE world_id = $1 AND canon_edition_id = $2
              AND content_fingerprint = $3
            LIMIT 1`,
          [params.worldId, params.editionId, intakeProductFingerprint],
        )
      ).rows[0]
    : null;
  const intakePreflight = intakeProductSources.length
    ? await canonIntakePreflight(db, {
        worldId: params.worldId,
        editionId: params.editionId,
      })
    : null;
  if (intakePreflight?.overLimit) {
    throw new Error(
      `Canon Intake supports up to ${intakePreflight.wordLimit.toLocaleString()} cumulative words in one world intake.`,
    );
  }
  const intakeProductPriceCredits = intakePreflight?.requiredCredits ?? 0;
  const intakeProductChargeStatus = !intakeProductSources.length
    ? "not_applicable"
    : existingIntakeEntitlement || intakeProductPriceCredits === 0
      ? "covered"
      : "pending";
  const inputFingerprint = createHash("sha256")
    .update(
      [
        String(
          params.kind === "local_scan"
            ? LOCAL_ANALYSIS_VERSION
            : WORLD_ANALYSIS_VERSION,
        ),
         params.kind,
         params.kind === "ai_enrichment" ? runtime.model : "local",
         parentLocalRunId ?? "local-root",
         corpusFingerprint,
         evidenceGraphFingerprint,
         constraintSnapshotFingerprint,
         verificationContextFingerprint,
         String(PREMIUM_VERIFICATION_PACKET_VERSION),
         userGuidance,
         ...analysisSources.map((source) => `${source.id}:${source.content_hash}:${source.ai_reviewed_chunk_count}`),
      ].join("|"),
    )
    .digest("hex");
  const provider =
    params.kind === "ai_enrichment"
      ? runtime.provider
      : "storyhold-development";
  const model =
    params.kind === "ai_enrichment"
      ? runtime.model
      : "deterministic source scanner";
  const runId = randomUUID();
  await db.query(
    `INSERT INTO storyhold.world_analysis_runs
      (id, world_id, canon_edition_id, requested_by_player_id, provider, model, status,
       source_count, chunk_count, analysis_kind, trigger_kind, incremental, analysis_version,
       input_fingerprint, source_ids, review_source_ids, synthesis_status, user_guidance,
       intake_product_fingerprint, intake_product_source_ids,
       intake_product_price_credits, intake_product_charge_status,
       parent_local_run_id, corpus_fingerprint, evidence_graph_fingerprint,
       constraint_snapshot_fingerprint, verification_context_snapshot,
       verification_context_fingerprint, verification_packet_version)
     VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, $9, $10, $11, $12, $13,
             $14::jsonb, $15::jsonb, $16, $17, $18, $19::jsonb, $20, $21,
             $22, $23, $24, $25, $26::jsonb, $27, $28)`,
    [
      runId,
      params.worldId,
      params.editionId,
      params.playerId,
      provider,
      model,
      analysisSources.length,
      analysisSources.reduce(
        (total, source) => total + Number(source.chunk_count),
        0,
      ),
      params.kind,
      params.trigger,
      incrementalReview,
      params.kind === "local_scan"
        ? LOCAL_ANALYSIS_VERSION
        : WORLD_ANALYSIS_VERSION,
      inputFingerprint,
      json(analysisSources.map((source) => source.id)),
      json(reviewTargets.map((source) => source.id)),
      params.kind === "ai_enrichment" ? "pending" : "not_applicable",
      userGuidance,
      intakeProductFingerprint,
      json(intakeProductSources.map((source) => source.id)),
      intakeProductPriceCredits,
      intakeProductChargeStatus,
      parentLocalRunId,
      corpusFingerprint,
      evidenceGraphFingerprint,
      constraintSnapshotFingerprint,
      json(verificationContextSnapshot),
      verificationContextFingerprint,
      PREMIUM_VERIFICATION_PACKET_VERSION,
    ],
  );
  await db.query(
    `UPDATE storyhold.world_analysis_runs current_run
        SET intake_preview = COALESCE((
          SELECT prior.intake_preview
            FROM storyhold.world_analysis_runs prior
           WHERE prior.world_id = current_run.world_id
             AND prior.canon_edition_id = current_run.canon_edition_id
             AND prior.id <> current_run.id
             AND jsonb_typeof(prior.intake_preview) = 'object'
             AND jsonb_array_length(COALESCE(prior.intake_preview->'terms', '[]'::jsonb)) > 0
           ORDER BY prior.created_at DESC
           LIMIT 1
        ), '{}'::jsonb),
            intake_activity = COALESCE((
          SELECT prior.intake_activity
            FROM storyhold.world_analysis_runs prior
           WHERE prior.world_id = current_run.world_id
             AND prior.canon_edition_id = current_run.canon_edition_id
             AND prior.id <> current_run.id
             AND jsonb_typeof(prior.intake_activity) = 'array'
             AND jsonb_array_length(prior.intake_activity) > 0
           ORDER BY prior.created_at DESC
           LIMIT 1
        ), '[]'::jsonb)
      WHERE current_run.id = $1`,
    [runId],
  );
  await appendIntakeActivity(db, runId, [{
    dedupeKey: `${runId}:queued:${params.kind}:${inputFingerprint}`,
    kind: "source",
    label: params.kind === "ai_enrichment"
      ? "Queuing evidence verification"
      : "Opening the uploaded sources",
    detail: `${analysisSources.length.toLocaleString()} source${analysisSources.length === 1 ? "" : "s"} · ${analysisSources.reduce((total, source) => total + Number(source.chunk_count), 0).toLocaleString()} passages`,
    entityName: null,
    entityType: null,
  }]);
  if (params.kind === "ai_enrichment") {
    const ids = reviewTargets.map((source) => source.id);
    const placeholders = ids.map((_, index) => `$${index + 1}`).join(",");
    await db.query(
      `UPDATE storyhold.world_sources
          SET ai_reviewed_chunk_count = CASE
                WHEN ${incrementalReview ? "false" : "true"}
                THEN 0 ELSE ai_reviewed_chunk_count
              END,
              ai_coverage_authoritative = CASE
                WHEN ${incrementalReview ? "false" : "true"}
                  OR ai_reviewed_chunk_count = 0
                THEN true ELSE ai_coverage_authoritative
              END
        WHERE id IN (${placeholders})`,
      ids,
    );
  }
  await setReviewStatus(
    db,
    params.kind,
    reviewTargets.map((source) => source.id),
    "queued",
  );
  setTimeout(() => {
    void runWorldAnalysis(db, {
      runId,
      worldId: params.worldId,
      editionId: params.editionId,
      playerId: params.playerId,
    });
  }, 0);
  return {
    id: runId,
    status: "queued",
    provider,
    model,
    analysisKind: params.kind,
  };
}

function scheduleAutomaticAnalysis(
  db: StudioRootDb,
  params: {
    worldId: string;
    editionId: string;
    playerId: string;
    trigger: AnalysisTrigger;
    kind?: AnalysisKind;
    delay?: number;
    forceFull?: boolean;
    userGuidance?: string;
  },
) {
  const current = automaticAnalysisTimers.get(params.worldId);
  if (current) clearTimeout(current);
  const timer = setTimeout(() => {
    automaticAnalysisTimers.delete(params.worldId);
    void queueWorldAnalysis(db, {
      worldId: params.worldId,
      editionId: params.editionId,
      playerId: params.playerId,
      kind: params.kind ?? "local_scan",
      trigger: params.trigger,
      forceFull: params.forceFull,
      userGuidance: params.userGuidance,
    });
  }, params.delay ?? 1_200);
  automaticAnalysisTimers.set(params.worldId, timer);
}

export async function runWorldAnalysis(
  db: StudioRootDb,
  params: {
    runId: string;
    worldId: string;
    editionId: string;
    playerId: string;
  },
) {
  if (activeRuns.has(params.worldId)) return;
  activeRuns.add(params.worldId);
  let kind: AnalysisKind = "local_scan";
  let trigger: AnalysisTrigger = "backfill";
  let incremental = false;
  let inputSourceIds: string[] = [];
  let reviewSourceIds: string[] = [];
  let processedReviewSourceIds: string[] = [];
  let reviewedChunkCounts = new Map<string, number>();
  let partialDueToCredits = false;
  let reservation: CreditReservation | null = null;
  let intakeProductReservation: CreditReservation | null = null;
  let intakeProductFingerprint = "";
  let intakeProductSourceIds: string[] = [];
  let intakeProductPriceCredits = 0;
  let intakeProductWordCount = 0;
  let intakeProductChargeStatus = "not_applicable";
  let scheduleBackfill = true;
  let completedSuccessfully = false;
  let persistedCoverageBatchCount = 0;
  let synthesisCompleted: boolean | null = null;
  let userGuidance = "";
  let localCheckpoint: unknown = null;
  let browserAuditQueued = false;
  let premiumEvidencePin: PremiumEvidencePin | null = null;
  let verificationContextSnapshot: Record<string, unknown> = {};
  let frozenPremiumPlan: PremiumReviewPlan | null = null;
  let premiumFundingQuoteChecked = false;
  let premiumUsageForFailedRun: {
    usage: AiUsage;
    provider: string;
    model: string;
    attemptCount: number;
  } | null = null;
  try {
    const runResult = await db.query<Record<string, unknown>>(
      `SELECT status, pause_requested, analysis_kind, trigger_kind, incremental, source_ids, review_source_ids, user_guidance,
              intake_product_fingerprint, intake_product_source_ids,
              intake_product_price_credits, intake_product_charge_status,
              local_checkpoint, parent_local_run_id, corpus_fingerprint,
              evidence_graph_fingerprint, constraint_snapshot_fingerprint,
              verification_context_snapshot, verification_context_fingerprint,
              verification_packet_version
         FROM storyhold.world_analysis_runs
        WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3
          AND requested_by_player_id = $4
        LIMIT 1`,
      [params.runId, params.worldId, params.editionId, params.playerId],
    );
    const run = runResult.rows[0];
    if (!run || !["queued", "running", "paused"].includes(String(run.status))) {
      // A previously scheduled callback must never resurrect a finalized review.
      scheduleBackfill = false;
      return;
    }
    if (run.analysis_kind === "ai_enrichment" && await premiumReviewHasFinalization(db, params.runId)) {
      scheduleBackfill = false;
      return;
    }
    if (run.pause_requested || run.status === "paused") {
      await waitWhileWorldAnalysisPaused(db, {
        runId: params.runId,
        worldId: params.worldId,
      });
    }
    kind = run.analysis_kind === "ai_enrichment" ? "ai_enrichment" : "local_scan";
    trigger =
      run.trigger_kind === "upload" || run.trigger_kind === "manual"
        ? run.trigger_kind
        : "backfill";
    incremental = Boolean(run.incremental);
    inputSourceIds = stringArray(run.source_ids);
    reviewSourceIds = stringArray(run.review_source_ids);
    userGuidance = textBody(run.user_guidance, 4_000);
    localCheckpoint = run.local_checkpoint;
    if (kind === "ai_enrichment") {
      frozenPremiumPlan = await readPremiumReviewPlan(db, params.runId);
      verificationContextSnapshot = recordBody(
        run.verification_context_snapshot,
      );
      premiumEvidencePin = {
        parentLocalRunId: textBody(run.parent_local_run_id, 64),
        corpusFingerprint: textBody(run.corpus_fingerprint, 128),
        evidenceGraphFingerprint: textBody(
          run.evidence_graph_fingerprint,
          128,
        ),
        constraintSnapshotFingerprint: textBody(
          run.constraint_snapshot_fingerprint,
          128,
        ),
        verificationContextFingerprint: textBody(
          run.verification_context_fingerprint,
          128,
        ),
        verificationPacketVersion: Number(
          run.verification_packet_version ?? 0,
        ),
      };
      if (
        lorekeeperSnapshotFingerprint(verificationContextSnapshot) !==
        premiumEvidencePin.verificationContextFingerprint
      ) {
        throw new Error(
          "The premium review context cannot be authenticated. No new provider request was sent; the saved review needs attention before continuing.",
        );
      }
      await assertPremiumEvidencePin(db, {
        worldId: params.worldId,
        editionId: params.editionId,
        pin: premiumEvidencePin,
      });
      if (frozenPremiumPlan) {
        frozenPremiumPlan = await validatedPremiumResumePlan(db, params);
        incremental = frozenPremiumPlan.incremental;
        partialDueToCredits = frozenPremiumPlan.partialDueToCredits;
        userGuidance = frozenPremiumPlan.worldContext.userGuidance;
        reservation = frozenPremiumPlan.unlimited
          ? {
              id: null, playerId: params.playerId, reservedCredits: 0,
              creditsRemaining: 0, unlimited: true,
            }
          : await restorePremiumCreditReservation(db, {
              reservationId: frozenPremiumPlan.reservationId!,
              playerId: params.playerId,
              worldId: params.worldId,
              runId: params.runId,
              reservedCredits: frozenPremiumPlan.reservedCredits,
            });
      } else if ((await readPremiumJournalAccounting(db, params.runId)).callCount > 0) {
        throw new PremiumReviewPlanError(
          "PREMIUM_PLAN_REQUIRED",
          "This premium review has saved requests but no resumable plan. It needs reconciliation before continuing.",
        );
      }
    }
    intakeProductFingerprint = textBody(
      run.intake_product_fingerprint,
      128,
    );
    intakeProductSourceIds = stringArray(run.intake_product_source_ids);
    intakeProductPriceCredits = Number(
      run.intake_product_price_credits ?? 0,
    );
    intakeProductChargeStatus = textBody(
      run.intake_product_charge_status,
      40,
    ) || "not_applicable";
    await setReviewStatus(db, kind, reviewSourceIds, "running");
    await db.query(
      `UPDATE storyhold.world_analysis_runs
          SET status = 'running', stage = 'loading canonical source chunks',
              progress = GREATEST(progress, 2), started_at = COALESCE(started_at, now())
        WHERE id = $1`,
      [params.runId],
    );
    const world = await ownedWorld(db, params.worldId, params.playerId);
    if (!world)
      throw new Error("The world is no longer available to this player.");
    if (
      kind === "local_scan" &&
      trigger !== "backfill" &&
      intakeProductChargeStatus === "pending" &&
      intakeProductPriceCredits > 0 &&
      intakeProductFingerprint &&
      intakeProductSourceIds.length > 0
    ) {
      const priorEntitlement = await db.query<{ credits_charged: number }>(
        `SELECT credits_charged
           FROM storyhold.world_intake_entitlements
          WHERE world_id = $1 AND canon_edition_id = $2
            AND content_fingerprint = $3
          LIMIT 1`,
        [params.worldId, params.editionId, intakeProductFingerprint],
      );
      if (priorEntitlement.rows[0]) {
        intakeProductChargeStatus = "covered";
        await db.query(
          `UPDATE storyhold.world_analysis_runs
              SET intake_product_charge_status = 'covered'
            WHERE id = $1`,
          [params.runId],
        );
      } else {
        const intakeSourceTotals = await db.query<{
          source_count: number;
          word_count: number;
        }>(
          `SELECT count(*)::int AS source_count,
                  COALESCE(sum(word_count), 0)::int AS word_count
             FROM storyhold.world_sources
            WHERE world_id = $1 AND canon_edition_id = $2
              AND id = ANY($3::uuid[])
              AND intake_payment_required = true`,
          [params.worldId, params.editionId, intakeProductSourceIds],
        );
        const intakeSourceCount = Number(
          intakeSourceTotals.rows[0]?.source_count ?? 0,
        );
        intakeProductWordCount = Number(
          intakeSourceTotals.rows[0]?.word_count ?? 0,
        );
        if (
          intakeSourceCount !== intakeProductSourceIds.length ||
          intakeProductWordCount <= 0
        ) {
          throw new Error(
            "The premium Canon Intake source set changed before processing began. Start the intake again so it can be priced safely.",
          );
        }
        intakeProductReservation = await reserveCredits(db, {
          playerId: params.playerId,
          worldId: params.worldId,
          operation: "canon_intake",
          requestId: params.runId,
          requiredCredits: intakeProductPriceCredits,
          expiresInMinutes: 6 * 60,
          metadata: {
            pricingMode: "metered_local_compute",
            pricingVersion: CANON_INTAKE_PRICING_VERSION,
            intakeTermsVersion: "2026-08-23",
            contentFingerprint: intakeProductFingerprint,
            sourceCount: intakeSourceCount,
            wordCount: intakeProductWordCount,
          },
        });
        if (intakeProductReservation.unlimited) {
          intakeProductChargeStatus = "unlimited";
          await db.query(
            `UPDATE storyhold.world_analysis_runs
                SET intake_product_charge_status = 'unlimited'
              WHERE id = $1`,
            [params.runId],
          );
        }
      }
    }
    const chunkResult = await db.query<{
      id: string;
      source_id: string;
      source_title: string;
      chunk_index: number;
      content: string;
      metadata: Record<string, unknown> | null;
      reviewed_chunk_count: number;
      coverage_authoritative: boolean;
      durably_covered: boolean;
    }>(
      `SELECT c.id, c.source_id, s.title AS source_title, c.chunk_index, c.content,
              c.metadata, s.ai_coverage_authoritative AS coverage_authoritative,
              CASE
                WHEN s.ai_reviewed_content_hash IS NOT DISTINCT FROM s.content_hash
                 AND s.ai_analysis_version >= ${WORLD_ANALYSIS_VERSION}
                THEN s.ai_reviewed_chunk_count ELSE 0
              END AS reviewed_chunk_count,
              EXISTS (
                SELECT 1
                  FROM storyhold.world_analysis_chunk_coverage coverage
                  JOIN storyhold.world_analysis_runs coverage_run
                    ON coverage_run.id = coverage.analysis_run_id
                 WHERE coverage.chunk_id = c.id
                   AND coverage.content_hash = c.content_hash
                   AND coverage.status IN ('analyzed', 'no_findings')
                   AND coverage_run.analysis_kind = 'ai_enrichment'
                   AND coverage_run.analysis_version >= ${WORLD_ANALYSIS_VERSION}
                   AND coverage_run.status = 'completed'
              ) AS durably_covered
         FROM storyhold.world_source_chunks c
         JOIN storyhold.world_sources s ON s.id = c.source_id
        WHERE c.world_id = $1 AND c.canon_edition_id = $2
          AND s.processing_status = 'ready' AND s.canon_status IN ('candidate', 'canon')
        ORDER BY s.chronology_order ASC, s.sort_order ASC, c.chunk_index ASC`,
      [params.worldId, params.editionId],
    );
    const allowedSourceIds = new Set(inputSourceIds);
    let chunks: StructuredAnalysisChunk[] = frozenPremiumPlan
      ? structuredClone(frozenPremiumPlan.chunks)
      : chunkResult.rows
      .filter((row) => allowedSourceIds.has(row.source_id) &&
        shouldReviewAnalysisChunk({
          kind,
          incremental,
          chunkIndex: Number(row.chunk_index),
          reviewedChunkCount: Number(row.reviewed_chunk_count),
          coverageAuthoritative: Boolean(row.coverage_authoritative),
          durablyCovered: Boolean(row.durably_covered),
        }))
      .map((row) => ({
        id: row.id,
        sourceId: row.source_id,
        sourceTitle: row.source_title,
        index: Number(row.chunk_index),
        content: row.content,
        sectionKey: textBody(row.metadata?.sectionKey, 240) || null,
        sectionTitle: textBody(row.metadata?.sectionTitle, 240) || null,
        sectionIndex: Number(row.metadata?.sectionIndex ?? 0),
        coverageAuthoritative: Boolean(row.coverage_authoritative),
        reviewedChunkCount: Number(row.reviewed_chunk_count),
      }));
    const sourceTextResult = await db.query<{
      id: string;
      title: string;
      extracted_text: string;
    }>(
      `SELECT id, title, extracted_text
         FROM storyhold.world_sources
        WHERE world_id = $1 AND canon_edition_id = $2
          AND processing_status = 'ready' AND canon_status IN ('candidate', 'canon')
        ORDER BY chronology_order ASC, sort_order ASC, created_at ASC`,
      [params.worldId, params.editionId],
    );
    const sources: AnalysisSource[] = sourceTextResult.rows
      .filter(
        (row) =>
          allowedSourceIds.has(row.id) && row.extracted_text.trim().length > 0,
      )
      .map((row) => ({
        id: row.id,
        title: row.title,
        content: row.extracted_text,
      }));
    if (chunks.length === 0)
      throw new Error("No extractable passages remained in this review queue.");
    const sourceCount = new Set(chunks.map((chunk) => chunk.sourceId)).size;
    await db.query(
      `UPDATE storyhold.world_analysis_runs
          SET source_count = $2, chunk_count = $3, stage = $4,
              progress = GREATEST(progress, 5)
        WHERE id = $1`,
      [
        params.runId,
        sourceCount,
        chunks.length,
        kind === "ai_enrichment"
          ? "reviewing new evidence for world cohesion"
          : "building private local source inventory",
      ],
    );
    await appendIntakeActivity(db, params.runId, [{
      dedupeKey: `${params.runId}:reading:${kind}:${sourceCount}:${chunks.length}`,
      kind: "source",
      label: `Reading ${chunks.length.toLocaleString()} source passages`,
      detail: `${sourceCount.toLocaleString()} source${sourceCount === 1 ? "" : "s"} · preserved in canonical reading order`,
      entityName: null,
      entityType: null,
    }]);

    const previousBreakdownResult = await db.query<Record<string, unknown>>(
      `SELECT * FROM storyhold.world_breakdowns
        WHERE world_id = $1 AND canon_edition_id = $2
        ORDER BY version DESC
        LIMIT 1`,
      [params.worldId, params.editionId],
    );
    const previousBreakdown = previousBreakdownResult.rows[0];
    const localEvidenceBreakdownResult = kind === "ai_enrichment"
      ? await db.query<Record<string, unknown>>(
          `SELECT breakdown.*
             FROM storyhold.world_breakdowns breakdown
             JOIN storyhold.world_analysis_runs local_run
               ON local_run.id = breakdown.analysis_run_id
            WHERE breakdown.world_id = $1
              AND breakdown.canon_edition_id = $2
              AND local_run.id = $3
              AND breakdown.analysis_run_id = $3
              AND local_run.analysis_kind = 'local_scan'
              AND local_run.status = 'completed'
            LIMIT 1`,
          [params.worldId, params.editionId, premiumEvidencePin?.parentLocalRunId],
        )
      : null;
    const localEvidenceBreakdown = localEvidenceBreakdownResult?.rows[0];
    const localEvidenceGraph = recordBody(localEvidenceBreakdown?.evidence_graph);
    const hasCompleteLocalEvidenceGraph =
      typeof localEvidenceGraph.summary === "string" &&
      Array.isArray(localEvidenceGraph.characters) &&
      Array.isArray(localEvidenceGraph.chapterSummaries) &&
      Array.isArray(localEvidenceGraph.entityRelations) &&
      Array.isArray(localEvidenceGraph.claims);
    const persistedLocalFindings = kind === "ai_enrichment" && hasCompleteLocalEvidenceGraph
      ? findingsFromBreakdown(localEvidenceBreakdown)
      : null;
    if (kind === "ai_enrichment" && !persistedLocalFindings) {
      throw new Error(
        "This world predates the complete Lorekeeper evidence handoff. Run Canon Intake once more before starting its premium review.",
      );
    }
    if (
      kind === "ai_enrichment" &&
      lorekeeperSnapshotFingerprint(localEvidenceGraph) !==
        premiumEvidencePin?.evidenceGraphFingerprint
    ) {
      throw new Error(
        "The pinned Lorekeeper evidence snapshot no longer matches this review. No premium request was sent; start Premium Deep Reading again from the saved world.",
      );
    }
    const completedAiResult = await db.query<{ found: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM storyhold.world_analysis_runs
          WHERE world_id = $1 AND canon_edition_id = $2
            AND analysis_kind = 'ai_enrichment' AND status = 'completed'
       ) AS found`,
      [params.worldId, params.editionId],
    );
    const hasCompletedAiReview = Boolean(completedAiResult.rows[0]?.found);
    const existingCanonContext = kind === "ai_enrichment"
      ? textBody(verificationContextSnapshot.existingCanonContext, 80_000)
      : undefined;
    const externalReferenceContext = kind === "ai_enrichment"
      ? textBody(verificationContextSnapshot.externalReferenceContext, 12_000)
      : undefined;
    const premiumClockContext = kind !== "ai_enrichment"
      ? null
      : frozenPremiumPlan?.version === 3
        ? {
            entities: structuredClone(frozenPremiumPlan.clockEntityRegistry),
            ownerConstraints: structuredClone(frozenPremiumPlan.clockOwnerConstraints),
          }
        : frozenPremiumPlan
          ? null
          : await frozenPremiumClockContext(db, {
              worldId: params.worldId,
              editionId: params.editionId,
            });
    if (kind === "ai_enrichment") {
      if (!premiumEvidencePin) {
        throw new Error(
          "Premium Deep Reading is missing its Lorekeeper evidence receipt.",
        );
      }
      await assertPremiumEvidencePin(db, {
        worldId: params.worldId,
        editionId: params.editionId,
        pin: premiumEvidencePin,
      });
      if (!frozenPremiumPlan) {
        const account = await db.query<{ role: string; credits: number }>(
          "SELECT role, credits FROM storyhold.players WHERE id = $1 LIMIT 1",
          [params.playerId],
        );
        const unlimited = ["owner", "admin"].includes(account.rows[0]?.role ?? "");
        const availableCredits = Number(account.rows[0]?.credits ?? 0);
        let quote = quoteWorldAnalysisReservation({
          worldName: world.name,
          premise: world.premise,
          genre: world.genre,
          chunks,
          sources,
          existingCanonContext,
          externalReferenceContext,
          userGuidance,
          persistedLocalFindings: persistedLocalFindings ?? undefined,
          premiumClockReviewVersion: 1,
          premiumClockEntityRegistry: premiumClockContext?.entities,
          premiumClockOwnerConstraints: premiumClockContext?.ownerConstraints,
          premiumClaimScope: {
            worldId: params.worldId,
            editionId: params.editionId,
            analysisRunId: params.runId,
          },
        });
        let requiredCredits = creditsForReservationQuote(quote);
        if (!unlimited && requiredCredits > availableCredits) {
          const creditsForChunks = (candidateChunks: StructuredAnalysisChunk[]) =>
            creditsForReservationQuote(quoteWorldAnalysisReservation({
              worldName: world.name,
              premise: world.premise,
              genre: world.genre,
              chunks: candidateChunks,
              sources,
              existingCanonContext,
              externalReferenceContext,
              userGuidance,
              persistedLocalFindings: persistedLocalFindings ?? undefined,
              premiumClockReviewVersion: 1,
              premiumClockEntityRegistry: premiumClockContext?.entities,
              premiumClockOwnerConstraints: premiumClockContext?.ownerConstraints,
              premiumClaimScope: {
                worldId: params.worldId,
                editionId: params.editionId,
                analysisRunId: params.runId,
              },
            }));
          const affordableChunks = selectBreadthFirstAffordableChunks({
            chunks,
            availableCredits,
            creditsForChunks,
          });
          if (!affordableChunks.length) {
            const nextChunk = breadthFirstAnalysisChunks(chunks).slice(0, 1);
            throw new CreditEconomyError(
              "INSUFFICIENT_CREDITS",
              "There are not enough credits for the next source-review batch.",
              creditsForChunks(nextChunk),
              availableCredits,
            );
          }
          chunks = affordableChunks;
          quote = quoteWorldAnalysisReservation({
            worldName: world.name,
            premise: world.premise,
            genre: world.genre,
            chunks,
            sources,
            existingCanonContext,
            externalReferenceContext,
            userGuidance,
            persistedLocalFindings: persistedLocalFindings ?? undefined,
            premiumClockReviewVersion: 1,
            premiumClockEntityRegistry: premiumClockContext?.entities,
            premiumClockOwnerConstraints: premiumClockContext?.ownerConstraints,
            premiumClaimScope: {
              worldId: params.worldId,
              editionId: params.editionId,
              analysisRunId: params.runId,
            },
          });
          requiredCredits = creditsForReservationQuote(quote);
          partialDueToCredits = true;
        }
        reservation = await reserveCredits(db, {
          playerId: params.playerId,
          worldId: params.worldId,
          operation: "world_analysis",
          requestId: params.runId,
          requiredCredits,
          expiresInMinutes: 6 * 60,
          metadata: {
            premiumResumeVersion: 1,
            batchCount: quote.batchCount,
            sourceCount: new Set(chunks.map((chunk) => chunk.sourceId)).size,
            chunkCount: chunks.length,
            partialDueToCredits,
            guidancePresent: Boolean(userGuidance),
          },
        });
        const planRuntime = getAiRuntimeStatus("canon_review", "standard", "verification");
        frozenPremiumPlan = await savePremiumReviewPlan(db, {
          version: 3,
          clockReviewVersion: 1,
          runId: params.runId,
          worldId: params.worldId,
          editionId: params.editionId,
          playerId: params.playerId,
          executionVersion: PREMIUM_EXECUTION_VERSION,
          scopeFingerprint: lorekeeperSnapshotFingerprint(premiumEvidencePin),
          provider: planRuntime.provider,
          model: planRuntime.model,
          worldContext: { worldName: world.name, premise: world.premise, genre: world.genre, userGuidance },
          chunks,
          verificationBatches: premiumVerificationBatchChunkIds(chunks),
          verificationPages: buildWorldPremiumVerificationPages({
            chunks, persistedLocalFindings: persistedLocalFindings ?? undefined,
          }),
          clockEntityRegistry: premiumClockContext?.entities ?? [],
          clockOwnerConstraints: premiumClockContext?.ownerConstraints ?? [],
          partialDueToCredits,
          incremental,
          reservationId: reservation.id,
          reservedCredits: reservation.reservedCredits,
          unlimited: reservation.unlimited,
        });
        await db.query(
          "UPDATE storyhold.world_analysis_runs SET premium_resume_status = 'ready' WHERE id = $1",
          [params.runId],
        );
      }
      reviewedChunkCounts = chunks.reduce((counts, chunk) => {
        counts.set(chunk.sourceId, (counts.get(chunk.sourceId) ?? 0) + 1);
        return counts;
      }, new Map<string, number>());
      processedReviewSourceIds = [...reviewedChunkCounts.keys()];
      const deferredSourceIds = reviewSourceIds.filter((sourceId) => !reviewedChunkCounts.has(sourceId));
      if (deferredSourceIds.length) {
        const placeholders = deferredSourceIds.map((_, index) => `$${index + 1}`).join(",");
        await db.query(
          `UPDATE storyhold.world_sources SET ai_review_status = 'waiting'
            WHERE id IN (${placeholders})`,
          deferredSourceIds,
        );
      }
      await db.query(
        `UPDATE storyhold.world_analysis_runs
            SET source_count = $2, chunk_count = $3,
                stage = $4
          WHERE id = $1`,
        [
          params.runId,
          processedReviewSourceIds.length,
          chunks.length,
          partialDueToCredits
            ? "reviewing the portion covered by available credits"
            : "reviewing new evidence for world cohesion",
        ],
      );
    } else {
      processedReviewSourceIds = inputSourceIds;
    }
    if (kind === "ai_enrichment") {
      await seedChunkCoverage(db, params.runId, chunks);
      await db.query(
        `UPDATE storyhold.world_analysis_runs
            SET synthesis_status = 'pending',
                synthesis_attempt_count = synthesis_attempt_count + 1,
                synthesis_error = NULL
          WHERE id = $1`,
        [params.runId],
      );
    }
    const result = await analyzeWorld({
      worldName: frozenPremiumPlan?.worldContext.worldName ?? world.name,
      premise: frozenPremiumPlan?.worldContext.premise ?? world.premise,
      genre: frozenPremiumPlan?.worldContext.genre ?? world.genre,
      chunks,
      sources,
      analysisMode: kind === "ai_enrichment" ? "connected" : "development",
      existingCanonContext,
      externalReferenceContext,
      userGuidance,
      persistedLocalFindings: persistedLocalFindings ?? undefined,
      localCheckpoint,
      premiumVerificationBatches: frozenPremiumPlan?.verificationBatches,
      premiumVerificationPages: frozenPremiumPlan && frozenPremiumPlan.version >= 2 ? frozenPremiumPlan.verificationPages : undefined,
      premiumClockReviewVersion: frozenPremiumPlan?.version === 3 ? frozenPremiumPlan.clockReviewVersion : undefined,
      premiumClockEntityRegistry: frozenPremiumPlan?.version === 3 ? frozenPremiumPlan.clockEntityRegistry : undefined,
      premiumClockOwnerConstraints: frozenPremiumPlan?.version === 3 ? frozenPremiumPlan.clockOwnerConstraints : undefined,
      assertPremiumChronologyPrefix: frozenPremiumPlan?.version === 3
        ? (manifest) => freezePremiumClockManifest(db, frozenPremiumPlan!, manifest).then(() => undefined)
        : undefined,
      premiumClaimScope: kind === "ai_enrichment"
        ? { worldId: params.worldId, editionId: params.editionId, analysisRunId: params.runId }
        : undefined,
      executePremiumCall: kind === "ai_enrichment"
        ? async (stepKey, request) => {
            if (!premiumEvidencePin) throw new Error("The premium evidence receipt is missing.");
            try {
              await assertPremiumEvidencePin(db, {
                worldId: params.worldId,
                editionId: params.editionId,
                pin: premiumEvidencePin,
              });
            } catch (error) {
              throw new PremiumJournalError("REQUEST_MISMATCH",
                error instanceof Error ? error.message : "The saved evidence changed.");
            }
            const callRuntime = getAiRuntimeStatus(request.task, request.contentMode, request.stage);
            if (!frozenPremiumPlan || !callRuntime.configured ||
                frozenPremiumPlan.provider !== callRuntime.provider ||
                frozenPremiumPlan.model !== callRuntime.model) {
              throw new PremiumJournalError(
                "REQUEST_MISMATCH",
                "The model connection changed after this review began. No new request was sent.",
              );
            }
            const journalRequest = { ...request, allowProviderFallback: false };
            if (!premiumFundingQuoteChecked && !frozenPremiumPlan.unlimited) {
              const savedCall = await db.query(
                "SELECT step_key FROM storyhold.world_analysis_ai_calls WHERE run_id = $1 AND step_key = $2",
                [params.runId, stepKey],
              );
              if (savedCall.rows.length === 0) {
                const currentCredits = creditsForReservationQuote(quoteWorldAnalysisReservation({
                  ...frozenPremiumPlan.worldContext,
                  chunks,
                  sources,
                  existingCanonContext,
                  externalReferenceContext,
                  persistedLocalFindings: persistedLocalFindings ?? undefined,
                  premiumVerificationBatches: frozenPremiumPlan.verificationBatches,
                  premiumVerificationPages: frozenPremiumPlan.version >= 2 ? frozenPremiumPlan.verificationPages : undefined,
                  premiumClockReviewVersion: frozenPremiumPlan.version === 3 ? frozenPremiumPlan.clockReviewVersion : undefined,
                  premiumClockEntityRegistry: frozenPremiumPlan.version === 3 ? frozenPremiumPlan.clockEntityRegistry : undefined,
                  premiumClockOwnerConstraints: frozenPremiumPlan.version === 3 ? frozenPremiumPlan.clockOwnerConstraints : undefined,
                  premiumClaimScope: {
                    worldId: params.worldId,
                    editionId: params.editionId,
                    analysisRunId: params.runId,
                  },
                }));
                if (currentCredits > frozenPremiumPlan.reservedCredits) {
                  const account = await db.query<{ credits: number }>(
                    "SELECT credits FROM storyhold.players WHERE id = $1 LIMIT 1",
                    [params.playerId],
                  );
                  const availableForSettlement = frozenPremiumPlan.reservedCredits +
                    Number(account.rows[0]?.credits ?? 0);
                  if (currentCredits > availableForSettlement) {
                    throw new CreditEconomyError(
                      "INSUFFICIENT_CREDITS",
                      "The premium review estimate increased and the remaining balance cannot cover it yet.",
                      currentCredits,
                      availableForSettlement,
                    );
                  }
                }
                premiumFundingQuoteChecked = true;
              }
            }
            return executeJournaledPremiumCall(db, {
              runId: params.runId,
              stepKey,
              request: journalRequest,
              provider: callRuntime.provider,
              model: callRuntime.model,
              scopeFingerprint: lorekeeperSnapshotFingerprint({
                evidence: premiumEvidencePin,
                plan: frozenPremiumPlan,
              }),
              reservationId: reservation?.id,
              invoke: () => generateAiText(journalRequest),
            });
          }
        : undefined,
      onLocalCheckpoint: async (checkpoint) => {
        localCheckpoint = checkpoint;
        const saved = localCheckpointProgress(checkpoint);
        await db.query(
          `UPDATE storyhold.world_analysis_runs
              SET local_checkpoint = $2::jsonb,
                  local_checkpoint_saved_at = now(),
                  progress = GREATEST(progress, $3),
                  stage = $4
            WHERE id = $1`,
          [params.runId, json(checkpoint), saved.progress, saved.stage],
        );
      },
      onCheckpoint: async () => {
        await waitWhileWorldAnalysisPaused(db, {
          runId: params.runId,
          worldId: params.worldId,
        });
        if (kind === "ai_enrichment") {
          if (!premiumEvidencePin) {
            throw new Error(
              "Premium Deep Reading is missing its Lorekeeper evidence receipt.",
            );
          }
          await assertPremiumEvidencePin(db, {
            worldId: params.worldId,
            editionId: params.editionId,
            pin: premiumEvidencePin,
          });
        }
      },
      onIntakePreview: async (preview) => {
        const previousResult = await db.query<{ intake_preview: unknown }>(
          `SELECT intake_preview FROM storyhold.world_analysis_runs WHERE id = $1 LIMIT 1`,
          [params.runId],
        );
        const previousRecord = recordBody(previousResult.rows[0]?.intake_preview);
        const previousPreview = Array.isArray(previousRecord.terms)
          ? previousRecord as unknown as WorldAnalysisIntakePreview
          : null;
        await appendIntakeActivity(
          db,
          params.runId,
          intakeActivityFromPreview(previousPreview, preview).map((event) => ({
            ...event,
            dedupeKey: `${params.runId}:${event.dedupeKey}`,
          })),
        );
        const previewProgress = Number.isFinite(preview.overallProgress)
          ? Math.max(0, Math.min(88, Math.round(preview.overallProgress!)))
          : preview.phase === "semantic"
          ? Math.min(
              86,
              30 + Math.round(
                (preview.completedPassages / Math.max(1, preview.totalPassages)) * 56,
              ),
            )
          : preview.phase === "complete"
            ? 88
            : 28;
        await db.query(
          `UPDATE storyhold.world_analysis_runs
              SET intake_preview = $2::jsonb,
                  progress = GREATEST(progress, $3),
                  stage = CASE
                    WHEN $4 = 'semantic' THEN 'classifying discovered story terms'
                    WHEN $4 = 'deterministic' THEN 'candidate terms found; checking their meaning'
                    WHEN $4 = 'fallback' THEN 'local term inventory complete'
                    ELSE stage
                  END
            WHERE id = $1`,
          [params.runId, json(preview), previewProgress, preview.phase],
        );
      },
      onCoverage: async (coverage) => {
        if (kind !== "ai_enrichment") return;
        persistedCoverageBatchCount = await persistWorldAnalysisCoverage(
          db,
          params.runId,
          coverage,
          persistedCoverageBatchCount,
        );
      },
      onProgress: async (completed, total) => {
        const progress = Math.min(
          88,
          5 + Math.round((completed / Math.max(1, total)) * 83),
        );
        if (kind === "ai_enrichment") {
          await appendIntakeActivity(db, params.runId, [{
            dedupeKey: `${params.runId}:verification-batch:${completed}:${total}`,
            kind: "verification",
            label: `Verifying evidence batch ${completed} of ${total}`,
            detail: "Checking proposed identities, relationships, facts, and chronology against quoted passages.",
            entityName: null,
            entityType: null,
          }]);
        }
        await db.query(
          `UPDATE storyhold.world_analysis_runs
              SET progress = GREATEST(progress, $2), stage = $3
            WHERE id = $1`,
          [
            params.runId,
            progress,
            kind === "ai_enrichment"
              ? `reviewing evidence batch ${completed} of ${total}`
              : "private local source scan complete",
          ],
        );
      },
    });
    if (kind === "ai_enrichment") {
      premiumUsageForFailedRun = {
        usage: result.usage,
        provider: result.runtime.provider,
        model: result.runtime.model,
        attemptCount: result.usageRecords.length,
      };
    }
    await waitWhileWorldAnalysisPaused(db, {
      runId: params.runId,
      worldId: params.worldId,
    });
    if (kind === "ai_enrichment") {
      if (!premiumEvidencePin) {
        throw new Error(
          "Premium Deep Reading is missing its Lorekeeper evidence receipt.",
        );
      }
      await assertPremiumEvidencePin(db, {
        worldId: params.worldId,
        editionId: params.editionId,
        pin: premiumEvidencePin,
      });
    }
    if (kind === "ai_enrichment") {
      if (!result.coverage) {
        throw new Error(
          "The connected world review returned no durable passage coverage receipt.",
        );
      }
      persistedCoverageBatchCount = await persistWorldAnalysisCoverage(
        db,
        params.runId,
        result.coverage,
        persistedCoverageBatchCount,
      );
      await finalizeChunkCoverage(
        db,
        params.runId,
        chunks,
        result.findings,
        {
          scope: { worldId: params.worldId, editionId: params.editionId, analysisRunId: params.runId },
          reviews: result.graphReviews ?? [],
          statReviews: result.statReviews ?? [],
          expectedStepKeys: frozenPremiumPlan ? premiumReviewVerificationStepKeys(frozenPremiumPlan) : [],
          ...(frozenPremiumPlan && frozenPremiumPlan.version >= 2 ? {
            verificationPages: frozenPremiumPlan.verificationPages,
            verificationBatches: frozenPremiumPlan.verificationBatches,
          } : {}),
        },
      );
      const currentCoverage = await db.query<{
        source_id: string;
      }>(
        `SELECT DISTINCT source_id
           FROM storyhold.world_analysis_chunk_coverage
          WHERE analysis_run_id = $1
            AND status IN ('analyzed', 'no_findings')`,
        [params.runId],
      );
      processedReviewSourceIds = currentCoverage.rows.map(
        (row) => row.source_id,
      );
      const durableCoverage = await db.query<{
        source_id: string;
        reviewed_count: number;
      }>(
        `SELECT coverage.source_id,
                count(DISTINCT coverage.chunk_id)::int AS reviewed_count
           FROM storyhold.world_analysis_chunk_coverage coverage
           JOIN storyhold.world_analysis_runs coverage_run
             ON coverage_run.id = coverage.analysis_run_id
           JOIN storyhold.world_source_chunks source_chunk
             ON source_chunk.id = coverage.chunk_id
            AND source_chunk.content_hash = coverage.content_hash
          WHERE coverage.status IN ('analyzed', 'no_findings')
            AND coverage_run.world_id = $2
            AND coverage_run.canon_edition_id = $3
            AND coverage_run.analysis_kind = 'ai_enrichment'
            AND coverage_run.analysis_version >= ${WORLD_ANALYSIS_VERSION}
            AND (coverage_run.status = 'completed' OR coverage_run.id = $1)
          GROUP BY coverage.source_id`,
        [params.runId, params.worldId, params.editionId],
      );
      reviewedChunkCounts = new Map(
        durableCoverage.rows.map((row) => [
          row.source_id,
          Number(row.reviewed_count),
        ]),
      );
      const uncoveredSourceIds = reviewSourceIds.filter(
        (sourceId) => !processedReviewSourceIds.includes(sourceId),
      );
      if (uncoveredSourceIds.length) {
        const placeholders = uncoveredSourceIds
          .map((_, index) => `$${index + 1}`)
          .join(",");
        await db.query(
          `UPDATE storyhold.world_sources SET ai_review_status = 'waiting'
            WHERE id IN (${placeholders})`,
          uncoveredSourceIds,
        );
      }
      synthesisCompleted = ["completed", "not_applicable"].includes(
        result.coverage.finalSynthesis.status,
      );
    }

    const previousFindings = findingsFromBreakdown(previousBreakdown);
    const isLegacyLocalBreakdown =
      previousBreakdown?.provider === "storyhold-development" &&
      !hasCompletedAiReview;
    const preservedFindings = previousFindings
      ? withoutSupersededCandidates(previousFindings, isLegacyLocalBreakdown)
      : null;
    const incomingFindings =
      kind === "ai_enrichment" && previousFindings
        ? {
            ...result.findings,
            locations: carryCandidateCounts(
              result.findings.locations,
              previousFindings.locations,
            ),
            factions: carryCandidateCounts(
              result.findings.factions,
              previousFindings.factions,
            ),
            institutions: carryCandidateCounts(
              result.findings.institutions,
              previousFindings.institutions,
            ),
            governments: carryCandidateCounts(
              result.findings.governments,
              previousFindings.governments,
            ),
            powerStructures: carryCandidateCounts(
              result.findings.powerStructures,
              previousFindings.powerStructures,
            ),
            creatures: carryCandidateCounts(
              result.findings.creatures,
              previousFindings.creatures,
            ),
            species: carryCandidateCounts(
              result.findings.species,
              previousFindings.species,
            ),
            technologies: carryCandidateCounts(
              result.findings.technologies,
              previousFindings.technologies,
            ),
            vehicles: carryCandidateCounts(
              result.findings.vehicles,
              previousFindings.vehicles,
            ),
            devices: carryCandidateCounts(
              result.findings.devices,
              previousFindings.devices,
            ),
            weapons: carryCandidateCounts(
              result.findings.weapons,
              previousFindings.weapons,
            ),
            powers: carryCandidateCounts(
              result.findings.powers,
              previousFindings.powers,
            ),
            titles: carryCandidateCounts(
              result.findings.titles,
              previousFindings.titles,
            ),
            ambiguous: carryCandidateCounts(
              result.findings.ambiguous,
              previousFindings.ambiguous,
            ),
          }
        : result.findings;
    const replaceAiSnapshot =
      kind === "ai_enrichment" &&
      !incremental &&
      !partialDueToCredits &&
      result.coverage?.complete === true;
    const mergedFindings = preservedFindings && !replaceAiSnapshot
      ? mergeWorldFindings(preservedFindings, incomingFindings, {
          preferIncomingSummary: kind === "ai_enrichment",
          retainAllSecondaryEntries: kind === "ai_enrichment",
        })
      : incomingFindings;
    // A local rerun must be able to repair stale generated prose from both an
    // older checkpoint and the previously persisted breakdown. Apply the same
    // durability boundary after that merge, immediately before every dossier,
    // draft, overview, and breakdown write consumes the result.
    const findings = kind === "local_scan"
      ? generatedLocalFindingsForPersistence(mergedFindings)
      : mergedFindings;
    // The combined breakdown may retain useful local cards during a partial
    // paid review. Canon projections, however, may consume only this run's
    // independently verified response—not local candidates carried forward
    // for customer visibility.
    const findingsEligibleForCanonPromotion = kind === "ai_enrichment"
      ? {
          ...result.findings,
          claims: claimsFromPremiumClaimReceipts(result.claimReviews ?? []),
          entityRelations: graphFromPremiumReceipts(result.graphReviews ?? []).entityRelations,
          entityRules: graphFromPremiumReceipts(result.graphReviews ?? []).entityRules,
        }
      : findings;
    await db.query(
      `UPDATE storyhold.world_analysis_runs
          SET progress = GREATEST(progress, 91), stage = 'saving reviewable proposals'
        WHERE id = $1`,
      [params.runId],
    );
    await db.transaction(async (tx) => {
      if (kind === "ai_enrichment") {
        if (!premiumEvidencePin) {
          throw new Error(
            "Premium Deep Reading is missing its Lorekeeper evidence receipt.",
          );
        }
        await assertPremiumEvidencePin(tx, {
          worldId: params.worldId,
          editionId: params.editionId,
          pin: premiumEvidencePin,
        });
        if (!frozenPremiumPlan) throw new Error("The premium execution plan is missing.");
        assertExpectedPremiumClaimReviews(result.claimReviews ?? [], {
          scope: { worldId: params.worldId, editionId: params.editionId, analysisRunId: params.runId },
          expectedStepKeys: premiumReviewVerificationStepKeys(frozenPremiumPlan),
        });
        for (const receipt of result.claimReviews ?? []) {
          await savePremiumClaimReview(tx, receipt);
        }
        assertExpectedPremiumGraphReviews(result.graphReviews ?? [], {
          scope: { worldId: params.worldId, editionId: params.editionId, analysisRunId: params.runId },
          expectedStepKeys: premiumReviewVerificationStepKeys(frozenPremiumPlan),
        });
        for (const receipt of result.graphReviews ?? []) {
          await savePremiumGraphReview(tx, receipt);
        }
        assertExpectedPremiumStatReviews(result.statReviews ?? [], {
          scope: { worldId: params.worldId, editionId: params.editionId, analysisRunId: params.runId },
          expectedStepKeys: premiumReviewVerificationStepKeys(frozenPremiumPlan),
        });
        assertPremiumStatProjection(result.findings, result.statReviews ?? []);
        for (const receipt of result.statReviews ?? []) await savePremiumStatReview(tx, receipt);
      }
      await tx.query(
        `UPDATE storyhold.world_analysis_runs
            SET local_ner_status = $2,
                local_ner_provider = $3,
                local_ner_model = $4,
                local_ner_attempted_segments = $5,
                local_ner_completed_segments = $6,
                local_ner_failed_segments = $7,
                local_ner_mention_count = $8,
                local_ner_relation_count = $9,
                local_ner_classification_count = $10,
                local_ner_signal_count = $11,
                local_ner_elapsed_ms = $12,
                local_ner_error = $13
          WHERE id = $1`,
        [
          params.runId,
          result.localExtraction.status,
          result.localExtraction.provider,
          result.localExtraction.model,
          result.localExtraction.attemptedSegments,
          result.localExtraction.completedSegments,
          result.localExtraction.failedSegments,
          result.localExtraction.mentionCount,
          result.localExtraction.relationCount,
          result.localExtraction.classificationCount,
          result.localExtraction.signalCount,
          result.localExtraction.elapsedMilliseconds,
          result.localExtraction.errors.join(" | ").slice(0, 4_000) || null,
        ],
      );
      await saveBreakdown({
        db: tx,
        worldId: params.worldId,
        editionId: params.editionId,
        runId: params.runId,
        provider: result.runtime.provider,
        model: result.runtime.model,
        findings,
      });
      if (
        kind === "ai_enrichment" &&
        world.metadata_inference_status === "requested"
      ) {
        const inferredPremise = textBody(findings.summary, 6_000);
        const inferredGenre = textBody(findings.genres.slice(0, 4).join(" / "), 160);
        const inferredAtmosphere = textBody(
          findings.atmosphere.slice(0, 6).join(", "),
          1_000,
        );
        const currentContract = cleanWorldContract(world.world_contract);
        const nextPremise = world.premise || inferredPremise;
        const nextGenre = world.genre || inferredGenre;
        const nextContract = {
          ...currentContract,
          premise: currentContract.premise || nextPremise,
          tone:
            currentContract.tone || inferredAtmosphere || inferredGenre,
        };
        if (nextPremise || nextGenre || nextContract.tone) {
          await tx.query(
            `UPDATE storyhold.worlds
                SET premise = $2,
                    description = CASE WHEN description = '' THEN $2 ELSE description END,
                    genre = $3,
                    world_contract = $4::jsonb,
                    metadata_inference_status = 'generated',
                    updated_at = now()
              WHERE id = $1`,
            [
              params.worldId,
              nextPremise,
              nextGenre,
              json(nextContract),
            ],
          );
        }
      }
      let eventParticipantProjection: Awaited<ReturnType<typeof syncCanonClockEvents>>;
      if (kind === "ai_enrichment" && frozenPremiumPlan?.version === 3) {
        if (!result.clockInput || !result.clockReviews || !result.clockManifest) {
          throw new Error("The completed premium review is missing its World Clock verification receipts.");
        }
        const clockManifest = result.clockManifest;
        const expectedClockPageCount = clockManifest.pageCount;
        await assertPremiumChronologyJournalPrefix(tx, frozenPremiumPlan, clockManifest, {
          requireComplete: true,
        });
        const approvedClock = approvedWorldClockProjection(result.clockInput, result.clockReviews);
        if (expectedClockPageCount > 0) {
          await applyVerifiedWorldClockProjection(tx, {
            reviews: [{ input: result.clockInput, receipts: result.clockReviews }],
          });
        } else if (result.clockReviews.length !== 0 || approvedClock.events.length !== 0) {
          throw new Error("An empty World Clock inventory acquired unexpected paid receipts or events.");
        }
        eventParticipantProjection = { participants: [], relations: [], eventIds: [] };
      } else {
        eventParticipantProjection = await syncCanonClockEvents({
          db: tx,
          worldId: params.worldId,
          editionId: params.editionId,
          findings: findingsEligibleForCanonPromotion,
          replaceSnapshot: replaceAiSnapshot,
        });
      }
      await syncAiChapterSummaries({
        db: tx,
        worldId: params.worldId,
        editionId: params.editionId,
        findings: findingsEligibleForCanonPromotion,
        replaceSnapshot: replaceAiSnapshot,
      });
      await cleanupCharacterReviewProjections({
        db: tx,
        worldId: params.worldId,
        editionId: params.editionId,
        analysisKind: kind,
        replaceGeneratedSnapshot: replaceAiSnapshot,
      });
      const characterFindingsForPersistence = kind === "local_scan"
        ? findings.characters
        : result.findings.characters;
      for (const finding of characterFindingsForPersistence) {
        await saveCharacterDossier(tx, {
          worldId: params.worldId,
          editionId: params.editionId,
          runId: params.runId,
          analysisKind: kind,
          replaceGeneratedSnapshot: replaceAiSnapshot,
          finding,
        });
        await saveCharacterDraft(tx, {
          worldId: params.worldId,
          editionId: params.editionId,
          runId: params.runId,
          analysisKind: kind,
          finding,
        });
      }
      const entitySync = await syncWorldEntities({
        db: tx,
        worldId: params.worldId,
        editionId: params.editionId,
        findings: findingsEligibleForCanonPromotion,
        runId: params.runId,
        analysisKind: kind,
        replaceGeneratedSnapshot: replaceAiSnapshot,
        premiumGraphReviews: result.graphReviews,
        premiumStatReviews: result.statReviews,
      });
      const claimSync = await syncWorldKnowledgeClaims({
        db: tx,
        worldId: params.worldId,
        editionId: params.editionId,
        runId: params.runId,
        claims: (findingsEligibleForCanonPromotion.claims ?? []).map((claim) => ({
          subject: claim.subject,
          predicate: claim.predicate,
          object: claim.value,
          polarity: claim.polarity ?? "positive",
          objectEntity: claim.value,
          epistemicHolder: claim.epistemicHolder || undefined,
          truthStatus: claim.truthStatus,
          validFromLabel: claim.validFromLabel,
          validUntilLabel: claim.validUntilLabel,
          summary: `${claim.subject} ${claim.polarity === "negative" ? "does not " : ""}${claim.predicate} ${claim.value}`,
          evidence: claim.evidence,
          confidence: claim.confidence,
          ...(claim.supersedes ? {
            supersedes: {
              subject: claim.supersedes.subject,
              predicate: claim.supersedes.predicate,
              object: claim.supersedes.value,
              polarity: claim.supersedes.polarity,
              objectEntity: claim.supersedes.value,
              epistemicHolder: claim.supersedes.epistemicHolder || undefined,
              truthStatus: claim.supersedes.truthStatus,
              validFromLabel: claim.supersedes.validFromLabel,
              validUntilLabel: claim.supersedes.validUntilLabel,
            },
          } : {}),
        })),
        assignmentSource: kind === "ai_enrichment" ? "ai" : "local",
        replaceAiSnapshot,
        // Explicitly verified supersedes can still end a prior claim. A
        // missing, rejected, or uncertain proposal cannot retract it by omission.
        preserveUnreviewedAiClaims: kind === "ai_enrichment",
      });
      if (kind === "ai_enrichment") {
        await linkPremiumClaimReviewsToCanon(tx, result.claimReviews ?? []);
        await linkPremiumStatReviewsToCanon(tx, result.statReviews ?? []);
      }
      const receiptBackedClock = kind === "ai_enrichment" && frozenPremiumPlan?.version === 3;
      const participantSync = receiptBackedClock
        ? { saved: 0, unresolved: 0, referenceIssues: [] as WorldReferenceIssue[] }
        : await syncWorldEventParticipants({
            db: tx,
            worldId: params.worldId,
            editionId: params.editionId,
            participants: eventParticipantProjection.participants,
            eventIds: eventParticipantProjection.eventIds,
            assignmentSource: kind === "ai_enrichment" ? "ai" : "local",
          });
      const eventRelationSync = receiptBackedClock
        ? { saved: 0, unresolved: 0, referenceIssues: [] as WorldReferenceIssue[] }
        : await syncWorldEventRelations({
            db: tx,
            worldId: params.worldId,
            editionId: params.editionId,
            relations: eventParticipantProjection.relations,
            eventIds: eventParticipantProjection.eventIds,
            assignmentSource: kind === "ai_enrichment" ? "ai" : "local",
          });
      const unresolvedReferences = [
        ...entitySync.referenceIssues,
        ...claimSync.referenceIssues,
        ...participantSync.referenceIssues,
        ...eventRelationSync.referenceIssues,
      ];
      await tx.query(
        `UPDATE storyhold.world_analysis_runs
            SET unresolved_reference_count = $2,
                unresolved_references = $3::jsonb
          WHERE id = $1`,
        [params.runId, unresolvedReferences.length, json(unresolvedReferences)],
      );
      await syncWorldCoreferenceSpans({
        db: tx,
        worldId: params.worldId,
        editionId: params.editionId,
        result: result.coreference,
      });
      await syncWorldEntityMentions({
        db: tx,
        worldId: params.worldId,
        editionId: params.editionId,
      });
      await enforceOwnerCanonConstraints({
        db: tx,
        worldId: params.worldId,
        editionId: params.editionId,
      });
      await syncWorldConceptGraph({
        db: tx,
        worldId: params.worldId,
        editionId: params.editionId,
        runId: params.runId,
      });
      await saveCohesionProposals({
        db: tx,
        worldId: params.worldId,
        editionId: params.editionId,
        runId: params.runId,
        findings: [...result.findings.cohesionProposals, ...(entitySync.conflicts ?? [])],
      });
      await completeSourceReviews({
        db: tx,
        kind,
        incremental,
        sourceIds: processedReviewSourceIds,
        provider: result.runtime.provider,
        model: result.runtime.model,
        reviewedChunkCounts,
      });
      await refreshWorldQualityFindings({
        db: tx,
        worldId: params.worldId,
        editionId: params.editionId,
        runId: params.runId,
      });
      if (kind === "local_scan" && trigger !== "backfill") {
        const browserAudit = await createBrowserLocalAudit({
          db: tx,
          worldId: params.worldId,
          editionId: params.editionId,
          playerId: params.playerId,
          localAnalysisRunId: params.runId,
          findings,
          trigger,
          forceFull: trigger === "manual",
          userGuidance,
        });
        browserAuditQueued = browserAudit.queued;
      }
      if (
        kind === "local_scan" &&
        trigger !== "backfill" &&
        intakeProductSourceIds.length > 0
      ) {
        if (intakeProductWordCount <= 0) {
          const currentIntakeWords = await tx.query<{ word_count: number }>(
            `SELECT COALESCE(sum(word_count), 0)::int AS word_count
               FROM storyhold.world_sources
              WHERE world_id = $1 AND canon_edition_id = $2
                AND id = ANY($3::uuid[])
                AND intake_payment_required = true`,
            [params.worldId, params.editionId, intakeProductSourceIds],
          );
          intakeProductWordCount = Number(
            currentIntakeWords.rows[0]?.word_count ?? 0,
          );
        }
        if (intakeProductWordCount <= 0) {
          throw new Error(
            "The Canon Intake source set changed before completion. Retry the saved intake; no additional credits will be used.",
          );
        }
        let intakeCreditsCharged = 0;
        if (intakeProductReservation?.id) {
          const intakeSettlement =
            await settleFixedCreditReservationInTransaction(tx, {
              reservationId: intakeProductReservation.id,
              fixedCredits: intakeProductPriceCredits,
              provider: "storyhold-local-compute",
              model: CANON_INTAKE_PRICING_VERSION,
              metadata: {
                product: "Canon Intake local processing",
                intakeTermsVersion: "2026-08-23",
                contentFingerprint: intakeProductFingerprint,
                sourceCount: intakeProductSourceIds.length,
                wordCount: intakeProductWordCount,
              },
            });
          intakeCreditsCharged = intakeSettlement.creditsUsed;
          intakeProductChargeStatus = "settled";
        }
        if (
          intakeProductChargeStatus === "settled" ||
          intakeProductChargeStatus === "unlimited" ||
          intakeProductChargeStatus === "covered"
        ) {
          await tx.query(
            `INSERT INTO storyhold.world_intake_entitlements
              (id, world_id, canon_edition_id, player_id, content_fingerprint,
               pricing_version, source_count, word_count, credits_charged,
               reservation_id, analysis_run_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (world_id, canon_edition_id, content_fingerprint)
             DO NOTHING`,
            [
              randomUUID(),
              params.worldId,
              params.editionId,
              params.playerId,
              intakeProductFingerprint,
              CANON_INTAKE_PRICING_VERSION,
              intakeProductSourceIds.length,
              intakeProductWordCount,
              intakeCreditsCharged,
              intakeProductReservation?.id ?? null,
              params.runId,
            ],
          );
        }
        await tx.query(
          `UPDATE storyhold.world_sources
              SET intake_payment_required = false
            WHERE world_id = $1 AND canon_edition_id = $2
              AND id = ANY($3::uuid[])`,
          [params.worldId, params.editionId, intakeProductSourceIds],
        );
        await tx.query(
          `UPDATE storyhold.world_analysis_runs
              SET intake_product_credits_charged = $2,
                  intake_product_charge_status = $3
            WHERE id = $1`,
          [
            params.runId,
            intakeCreditsCharged,
            intakeProductChargeStatus,
          ],
        );
      }
      let creditsUsed = 0;
      if (reservation?.id) {
        const settlement = await settlePremiumWorldReservationInTransaction(tx, {
          reservationId: reservation.id,
          usage: result.usage,
          provider: result.runtime.provider,
          model: result.runtime.model,
        });
        creditsUsed = settlement.creditsUsed;
      }
      if (kind === "ai_enrichment") {
        await tx.query(
          `UPDATE storyhold.world_analysis_runs
              SET premium_ai_credits_charged = $2
            WHERE id = $1`,
          [params.runId, creditsUsed],
        );
        const providers = [
          ...new Set(result.usageRecords.map((entry) => entry.provider)),
        ];
        const models = [
          ...new Set(result.usageRecords.map((entry) => entry.model)),
        ];
        await tx.query(
          `INSERT INTO storyhold.ai_usage_ledger
            (id, player_id, world_id, campaign_id, operation, provider, model,
             input_units, output_units, cached_input_units, cache_write_input_units,
             reasoning_units, cost_micros, cache_hit, pricing_version,
             credits_charged, request_id, metadata)
           VALUES ($1, $2, $3, NULL, 'world_analysis', $4, $5, $6, $7, $8,
                   $9, $10, $11, $12, $13, $14, $15, $16::jsonb)`,
          [
            randomUUID(),
            params.playerId,
            params.worldId,
            providers.length === 1 ? providers[0] : "mixed",
            models.length === 1 ? models[0] : "mixed",
            result.usage.inputUnits,
            result.usage.outputUnits,
            result.usage.cachedInputUnits,
            result.usage.cacheWriteInputUnits,
            result.usage.reasoningUnits,
            result.usage.estimatedCostMicros,
            result.usage.cachedInputUnits > 0,
            result.usage.pricingVersion,
            creditsUsed,
            params.runId,
            json({
              pricingKnown: result.usage.pricingKnown,
              batchCount: result.usageRecords.length,
              partialDueToCredits,
              reviewedChunkCount: chunks.length,
              synthesisCompleted,
              providerMix: result.usageRecords.map((entry) => ({
                stage: entry.stage,
                provider: entry.provider,
                model: entry.model,
                inputUnits: entry.usage.inputUnits,
                outputUnits: entry.usage.outputUnits,
                costMicros: entry.usage.estimatedCostMicros,
              })),
              localExtraction: {
                status: result.localExtraction.status,
                provider: result.localExtraction.provider,
                model: result.localExtraction.model,
                attemptedSegments: result.localExtraction.attemptedSegments,
                completedSegments: result.localExtraction.completedSegments,
                failedSegments: result.localExtraction.failedSegments,
                mentionCount: result.localExtraction.mentionCount,
                relationCount: result.localExtraction.relationCount,
                classificationCount: result.localExtraction.classificationCount,
                signalCount: result.localExtraction.signalCount,
                elapsedMilliseconds: result.localExtraction.elapsedMilliseconds,
                errors: result.localExtraction.errors,
              },
            }),
          ],
        );
      }
      await appendIntakeActivity(tx, params.runId, [
        ...(kind === "ai_enrichment" ? intakePersistenceActivity(findings).map((event) => ({
          ...event,
          dedupeKey: `${params.runId}:${event.dedupeKey}`,
        })) : []),
        {
          dedupeKey: `${params.runId}:${kind === "ai_enrichment" ? "world-ready:verified" : "world-ready:local"}`,
          kind: "complete",
          label: kind === "ai_enrichment"
            ? "Your Storyhold is ready"
            : "Private source inventory complete",
          detail: kind === "ai_enrichment"
            ? "Dossiers, relationships, indexed lore, and canonical chronology have been saved."
            : browserAuditQueued
              ? "The discovered story concepts are saved. Private Story Intelligence will review them before the world pauses for the owner's Premium Deep Reading decision."
              : "The discovered story concepts are saved. Premium Deep Reading remains an optional owner decision.",
          entityName: null,
          entityType: null,
        },
      ]);
      await tx.query(
        `UPDATE storyhold.world_analysis_runs
            SET status = 'completed', stage = $2, progress = 100,
                pause_requested = false, paused_at = NULL, completed_at = now(),
                premium_resume_status = 'not_available',
                local_checkpoint_saved_at = COALESCE(local_checkpoint_saved_at, now())
          WHERE id = $1`,
        [
          params.runId,
          kind === "ai_enrichment"
            ? partialDueToCredits
              ? "Affordable AI portion saved; remaining passages are queued"
              : synthesisCompleted === false
                ? "Passage review saved; global chronology synthesis needs retry"
                : "AI review complete; world model refreshed"
            : browserAuditQueued
              ? "Source Understanding Complete; Private Story Reading Ready"
              : "Storyhold World Ready; Premium Deep Reading Optional",
        ],
      );
      await tx.query(
        "UPDATE storyhold.worlds SET updated_at = now() WHERE id = $1",
        [params.worldId],
      );
    });
    completedSuccessfully = true;
  } catch (error) {
    const rawFailureMessage =
      error instanceof Error ? error.message : String(error);
    const creditError = error instanceof CreditEconomyError ? error : null;
    await releaseCreditReservation(
      db,
      intakeProductReservation?.id ?? null,
      rawFailureMessage || "Canon Intake failed",
    ).catch(() => undefined);
    let journalAccounting: Awaited<ReturnType<typeof readPremiumJournalAccounting>> | null = null;
    let journalUnreadable = false;
    if (kind === "ai_enrichment") {
      try {
        journalAccounting = await readPremiumJournalAccounting(db, params.runId);
      } catch {
        // Unknown accounting must not become a refund or permission to resend.
        journalUnreadable = true;
      }
    }
    const rejectedBillableAttempts = journalAccounting?.callCount
      ? journalAccounting.attempts
      :
      error instanceof AiGatewayUnavailableError
        ? error.billableAttempts
        : [];
    const rejectedUsage = rejectedBillableAttempts.length
      ? combineAiUsage(rejectedBillableAttempts.map((attempt) => attempt.usage))
      : null;
    // The durable journal includes earlier successful batches even when a later
    // batch fails before analyzeWorld can return its aggregate result.
    const failedPremiumUsage = rejectedUsage
      ? {
          usage: rejectedUsage,
          provider: [
            ...new Set(rejectedBillableAttempts.map((attempt) => attempt.provider)),
          ].join(",") || "mixed",
          model: [
            ...new Set(rejectedBillableAttempts.map((attempt) => attempt.model)),
          ].join(",") || "mixed",
          attemptCount: rejectedBillableAttempts.length,
        }
      : premiumUsageForFailedRun;
    let failedUsageSettled = false;
    let knownFailureFundingStop: CreditEconomyError | null = null;
    const recoverablePremiumFundingStop = kind === "ai_enrichment" &&
      creditError?.code === "INSUFFICIENT_CREDITS" &&
      Boolean(frozenPremiumPlan) &&
      Boolean(reservation?.id);
    const recoverablePremiumControlStop = kind === "ai_enrichment" &&
      Boolean(frozenPremiumPlan) &&
      (error instanceof PremiumReviewPlanError ||
        (error instanceof PremiumJournalError && error.code === "REQUEST_MISMATCH") ||
        recoverablePremiumFundingStop);
    const requiresBillingReconciliation =
      journalUnreadable ||
      Boolean(journalAccounting?.hasUncertain) ||
      premiumUsageNeedsReconciliation(failedPremiumUsage?.usage) ||
      recoverablePremiumControlStop ||
      (kind === "ai_enrichment" && Boolean(frozenPremiumPlan) && !reservation);
    let preserveFailedUsageReservation = requiresBillingReconciliation;
    if (
      kind === "ai_enrichment" &&
      !requiresBillingReconciliation &&
      !recoverablePremiumFundingStop &&
      reservation?.id &&
      failedPremiumUsage &&
      failedPremiumUsage.usage.pricingKnown &&
      failedPremiumUsage.usage.estimatedCostMicros > 0
    ) {
      preserveFailedUsageReservation = true;
      const failedReservationId = reservation.id;
      try {
        await finalizeKnownPremiumFailureAtomically(db, {
          runId: params.runId,
          worldId: params.worldId,
          playerId: params.playerId,
          reservationId: failedReservationId,
          failureMessage: rawFailureMessage,
          failedUsage: failedPremiumUsage,
        });
        failedUsageSettled = true;
        preserveFailedUsageReservation = false;
      } catch (settlementError) {
        if (settlementError instanceof CreditEconomyError &&
            settlementError.code === "INSUFFICIENT_CREDITS") {
          knownFailureFundingStop = settlementError;
        }
        // Leave the reservation held instead of issuing a false refund after
        // Storyhold has evidence that the upstream response was billable.
      }
    }
    if (knownFailureFundingStop) {
      scheduleBackfill = false;
      await setReviewStatus(db, kind, reviewSourceIds, "queued");
      await pausePremiumReviewForTopUp(db, {
        runId: params.runId,
        worldId: params.worldId,
        playerId: params.playerId,
        privateError: rawFailureMessage,
      });
      await appendIntakeActivity(db, params.runId, [{
        dedupeKey: `${params.runId}:saved-review-awaiting-top-up`,
        kind: "warning",
        label: "Premium Deep Reading Saved",
        detail: "The completed review is saved. Add credits, then resume to finish without repeating the reading.",
        entityName: null,
        entityType: null,
      }]).catch(() => undefined);
      return;
    }
    if (!failedUsageSettled && !preserveFailedUsageReservation) {
      await releaseCreditReservation(
        db,
        reservation?.id ?? null,
        rawFailureMessage || "analysis failed",
      ).catch(() => undefined);
    }
    const message = preserveFailedUsageReservation
      ? "Premium Deep Reading stopped while its usage record needs checking. Saved responses are preserved. Billing must be reconciled before another premium review; Storyhold will not automatically resend it."
      : creditError
      ? creditError.code === "INSUFFICIENT_CREDITS"
        ? kind === "local_scan" && intakeProductPriceCredits > 0
          ? "Canon Intake paused because this account ran out of credits. Add credits to continue from the saved work."
          : "The AI review paused because this account ran out of credits. Add credits to continue from the saved work."
        : "The connected model cannot be metered yet, so the review was paused without using credits."
      : error instanceof Error
        ? error.message
        : String(error);
    const durableCheckpoint = recordBody(localCheckpoint);
    if (recoverablePremiumControlStop) {
      scheduleBackfill = false;
      await setReviewStatus(db, kind, reviewSourceIds, "queued");
      await db.query(
        `UPDATE storyhold.world_analysis_runs
            SET status = 'paused', premium_resume_status = $3,
                stage = $4,
                error = $2, pause_requested = false, paused_at = now(), completed_at = NULL
          WHERE id = $1`,
        [
          params.runId,
          rawFailureMessage.slice(0, 4000),
          recoverablePremiumFundingStop ? "ready" : "blocked",
          recoverablePremiumFundingStop
            ? "Premium Deep Reading Paused — Add Credits to Continue"
            : "Premium Deep Reading Needs Attention",
        ],
      );
      return;
    }
    const recoverableLocalInterruption =
      kind === "local_scan" &&
      !creditError &&
      Boolean(textBody(durableCheckpoint.completedStage, 40)) &&
      localReaderInterruptionIsResumable(message);
    if (recoverableLocalInterruption) {
      scheduleBackfill = false;
      await setReviewStatus(db, kind, reviewSourceIds, "queued");
      await db.query(
        `UPDATE storyhold.world_analysis_runs
            SET status = 'paused',
                stage = 'Source Reading Interrupted — Ready to Resume',
                error = $2,
                pause_requested = false,
                paused_at = now(),
                completed_at = NULL
          WHERE id = $1`,
        [params.runId, message.slice(0, 4_000)],
      );
      await appendIntakeActivity(db, params.runId, [{
        dedupeKey: `${params.runId}:local-reader-paused:${createHash("sha256").update(message).digest("hex").slice(0, 16)}`,
        kind: "warning",
        label: "Source Reading Paused",
        detail: "Storyhold stopped responding while reading the sources. Completed work remains saved; restart Storyhold, then resume this same intake.",
        entityName: null,
        entityType: null,
      }]).catch(() => undefined);
      return;
    }
    if (kind === "ai_enrichment") {
      await db.query(
        `UPDATE storyhold.world_analysis_chunk_coverage
            SET error = $2, updated_at = now()
          WHERE analysis_run_id = $1 AND status = 'failed'`,
        [params.runId, message.slice(0, 4_000)],
      ).catch(() => undefined);
      await db.query(
        `UPDATE storyhold.world_analysis_runs
            SET synthesis_status = CASE
                  WHEN synthesis_status = 'pending' THEN 'failed'
                  ELSE synthesis_status
                END,
                synthesis_error = CASE
                  WHEN synthesis_status = 'pending' THEN $2
                  ELSE synthesis_error
                END
          WHERE id = $1`,
        [params.runId, message.slice(0, 4_000)],
      ).catch(() => undefined);
    }
    if (creditError && kind === "ai_enrichment" && reviewSourceIds.length > 0) {
      scheduleBackfill = false;
      const placeholders = reviewSourceIds
        .map((_, index) => `$${index + 1}`)
        .join(",");
      await db.query(
        `UPDATE storyhold.world_sources
            SET ai_review_status = 'waiting'
          WHERE id IN (${placeholders})`,
        reviewSourceIds,
      );
    } else if (kind === "ai_enrichment") {
      const activeIds = processedReviewSourceIds.length ? processedReviewSourceIds : reviewSourceIds;
      await setReviewStatus(db, kind, activeIds, "failed");
      const deferredIds = reviewSourceIds.filter((sourceId) => !activeIds.includes(sourceId));
      if (deferredIds.length) {
        const placeholders = deferredIds.map((_, index) => `$${index + 1}`).join(",");
        await db.query(
          `UPDATE storyhold.world_sources SET ai_review_status = 'waiting'
            WHERE id IN (${placeholders})`,
          deferredIds,
        );
      }
    } else {
      await setReviewStatus(db, kind, reviewSourceIds, "failed");
    }
    if (!failedUsageSettled) {
      await db.query(
        `UPDATE storyhold.world_analysis_runs
            SET status = 'failed', stage = $2, error = $3, completed_at = now(),
                premium_resume_status = $4
          WHERE id = $1`,
        [
          params.runId,
          creditError ? "waiting for available credits" : "analysis failed",
          message.slice(0, 4_000),
          kind === "ai_enrichment" && preserveFailedUsageReservation ? "blocked" : "not_available",
        ],
      );
    }
    await appendIntakeActivity(db, params.runId, [{
      dedupeKey: `${params.runId}:failed:${createHash("sha256").update(message).digest("hex").slice(0, 16)}`,
      kind: "warning",
      label: creditError ? "Waiting for available credits" : "The reading stopped",
      detail: message.slice(0, 500),
      entityName: null,
      entityType: null,
    }]).catch(() => undefined);
  } finally {
    activeRuns.delete(params.worldId);
    if (scheduleBackfill && !browserAuditQueued) {
      const runtime = getAiRuntimeStatus(
        "canon_review",
        "standard",
        "verification",
      );
      const nextKind = nextAutomaticAnalysisKind({
        completedKind: kind,
        trigger,
        runtimeConfigured: runtime.configured,
        partialDueToCredits,
        completedSuccessfully,
      });
      if (nextKind) {
        scheduleAutomaticAnalysis(db, {
          worldId: params.worldId,
          editionId: params.editionId,
          playerId: params.playerId,
          trigger,
          kind: nextKind,
          delay: 500,
          forceFull: kind === "local_scan" && trigger === "manual",
          userGuidance,
        });
      }
    }
  }
}

export const scheduledClockDeadlineBackfillSql = `
  UPDATE storyhold.world_clock_events event
      SET due_turn_number = COALESCE(
        (SELECT max(turn_number) + 1
           FROM storyhold.campaign_turns turn_row
          WHERE turn_row.campaign_id = event.campaign_id),
        1
      )
    WHERE event.status = 'scheduled'
      AND event.event_kind = 'scheduled_effect'
      AND event.due_world_time_minutes IS NULL
      AND event.due_turn_number IS NULL
      AND COALESCE(event.trigger_definition->>'kind', 'none') NOT IN
        ('proposition', 'all', 'any')
`;

async function ensureTextValueConstraint(
  db: StudioDb,
  params: {
    tableName: string;
    columnName: string;
    constraintName: string;
    allowedValues: string[];
  },
) {
  for (const identifier of [params.tableName, params.columnName, params.constraintName]) {
    if (!/^[a-z][a-z0-9_]*$/u.test(identifier)) {
      throw new Error(`Unsafe Storyhold constraint identifier: ${identifier}`);
    }
  }
  if (params.allowedValues.some((value) => !/^[a-z][a-z0-9_]*$/u.test(value))) {
    throw new Error(`Unsafe Storyhold constraint value for ${params.constraintName}.`);
  }
  const existing = await db.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(constraint_row.oid) AS definition
       FROM pg_catalog.pg_constraint constraint_row
       JOIN pg_catalog.pg_class relation_row ON relation_row.oid = constraint_row.conrelid
       JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
      WHERE namespace_row.nspname = 'storyhold'
        AND relation_row.relname = $1
        AND constraint_row.conname = $2
      LIMIT 1`,
    [params.tableName, params.constraintName],
  );
  const definition = existing.rows[0]?.definition ?? "";
  const currentValues = [...definition.matchAll(/'([^']+)'(?:::text)?/gu)]
    .map((match) => match[1]!)
    .sort();
  const expectedValues = [...params.allowedValues].sort();
  if (
    currentValues.length === expectedValues.length &&
    currentValues.every((value, index) => value === expectedValues[index])
  ) return;
  const allowed = params.allowedValues.map((value) => `'${value}'`).join(", ");
  await db.exec(
    `ALTER TABLE storyhold.${params.tableName}
       DROP CONSTRAINT IF EXISTS ${params.constraintName};
     ALTER TABLE storyhold.${params.tableName}
       ADD CONSTRAINT ${params.constraintName}
       CHECK (${params.columnName} IN (${allowed}));`,
  );
}

export async function initializeWorldStudio(
  db: StudioRootDb,
  storageRoot: string,
) {
  await db.exec(worldStudioSchemaSql);
  // campaign_rpg_* tables reference campaigns, so they must follow the core
  // world schema and precede every route that can launch a campaign.
  await ensureCampaignRpgPersistence(db);
  await db.exec(creditEconomySchemaSql);
  await db.exec(premiumReviewJournalSchemaSql);
  await db.exec(premiumReviewPlanSchemaSql);
  await db.exec(campaignPlaySchemaSql);
  await db.exec(adventureSetupSchemaSql);
  await db.exec(storyStudioSchemaSql);
  await db.exec(worldKnowledgeSchemaSql);
  await db.exec(campaignCanonScopeSchemaSql);
  await ensureWorldClockPersistence(db);
  await ensurePremiumClaimJournal(db);
  await ensurePremiumGraphJournal(db);
  await ensurePremiumStatJournal(db);
  await ensureEntityStatJournal(db);
  await ensureEntityReviewJournal(db);
  await ensureEntityReviewGraphLinks(db);
  await ensureEntityReviewClaimLinks(db);
  await db.exec(conceptResolutionSchemaSql);
  await db.exec(worldQualitySchemaSql);
  await db.exec(browserLocalAuditSchemaSql);
  await db.exec(browserLocalAuditPricingSchemaSql);
  for (const constraint of [
    {
      tableName: "world_analysis_runs",
      columnName: "status",
      constraintName: "world_analysis_runs_status_check",
      allowedValues: ["queued", "running", "paused", "completed", "failed"],
    },
    {
      tableName: "world_entities",
      columnName: "pull_status",
      constraintName: "world_entities_pull_status_check",
      allowedValues: ["active", "do_not_pull", "merged", "deleted"],
    },
    {
      tableName: "world_entities",
      columnName: "entity_type",
      constraintName: "world_entities_entity_type_check",
      allowedValues: [
        "character", "creature", "species", "place", "faction", "institution",
        "government", "power_structure", "technology", "vehicle", "device",
        "weapon", "power", "title", "cultural_reference", "term", "ambiguous",
      ],
    },
    {
      tableName: "world_entity_relations",
      columnName: "relation_type",
      constraintName: "world_entity_relations_relation_type_check",
      allowedValues: [
        "member_of", "participates_in", "species_of", "subspecies_of", "subtype_of",
        "lifecycle_stage_of", "has_power", "has_form", "holds_title", "allied_with",
        "child_of", "sibling_of", "spouse_of", "friend_of", "best_friend_of",
        "leads", "governs", "controlled_by", "opposed_to", "located_in", "part_of",
        "created_by", "related_to",
      ],
    },
    {
      tableName: "campaign_entity_snapshots",
      columnName: "entity_type",
      constraintName: "campaign_entity_snapshots_entity_type_check",
      allowedValues: [
        "character", "creature", "species", "place", "faction", "institution",
        "government", "power_structure", "technology", "vehicle", "device",
        "weapon", "power", "title", "ambiguous",
      ],
    },
    {
      tableName: "browser_local_audits",
      columnName: "status",
      constraintName: "browser_local_audits_status_check",
      allowedValues: ["pending", "running", "paused", "completed", "skipped", "failed"],
    },
  ]) {
    await ensureTextValueConstraint(db, constraint);
  }
  await ensureStoryholdVectorIndexes(db);
  scheduleStoryholdEmbeddingBackfill(db, 1_500);
  await db.query(
    `UPDATE storyhold.vault_memory_chunks
        SET player_id = NULL
      WHERE player_id IS NOT NULL
        AND metadata->>'visibility' IN ('campaign', 'system')`,
  );
  await db.query(scheduledClockDeadlineBackfillSql);
  await releaseExpiredCreditReservations(db);
  // An obsolete manual enrichment helper used do_not_pull for machine leads
  // that a later review rejected.  That status is now reserved for an owner
  // action.  Return those legacy rows to the ordinary inactive scanner pool;
  // scanner_present=false keeps them out of retrieval and the customer UI.
  await db.query(
    `UPDATE storyhold.world_entities
        SET pull_status = 'active', updated_at = now()
      WHERE classification_source = 'local'
        AND review_status = 'candidate'
        AND pull_status = 'do_not_pull'
        AND scanner_present = false`,
  );
  const generatedAmbiguous = await db.query<Record<string, unknown>>(
    `SELECT id, name, summary FROM storyhold.world_entities
      WHERE entity_type = 'ambiguous' AND scanner_present = true
        AND classification_source <> 'user'
        AND review_status <> 'user_confirmed'
        AND pull_status = 'active'`,
  );
  const nonEntityAmbiguousIds = generatedAmbiguous.rows
    .filter((row) => !ambiguousFindingIsEntityLabel({
      name: textBody(row.name, 240),
      summary: textBody(row.summary, 1_200),
    }))
    .map((row) => String(row.id));
  if (nonEntityAmbiguousIds.length > 0) {
    await db.query(
      `UPDATE storyhold.world_entities
          SET scanner_present = false, updated_at = now()
        WHERE id = ANY($1::uuid[])`,
      [nonEntityAmbiguousIds],
    );
  }
  const generatedCharacterLeads = await db.query<Record<string, unknown>>(
    `SELECT id, name FROM storyhold.world_entities
      WHERE entity_type = 'character' AND scanner_present = true
        AND classification_source <> 'user'
        AND review_status <> 'user_confirmed'
        AND pull_status = 'active'`,
  );
  const nonCharacterLeadIds = generatedCharacterLeads.rows
    .filter((row) => !localCharacterNameIsUseful(textBody(row.name, 240)))
    .map((row) => String(row.id));
  if (nonCharacterLeadIds.length > 0) {
    await db.query(
      `UPDATE storyhold.world_entities
          SET scanner_present = false, updated_at = now()
        WHERE id = ANY($1::uuid[])`,
      [nonCharacterLeadIds],
    );
  }
  const generatedEntityLeads = await db.query<Record<string, unknown>>(
    `SELECT id, name FROM storyhold.world_entities
      WHERE classification_source <> 'user'
        AND review_status <> 'user_confirmed'
        AND pull_status = 'active'`,
  );
  const nonEntityLeadIds = generatedEntityLeads.rows
    .filter((row) => !localEntityTextIsUseful(textBody(row.name, 240)))
    .map((row) => String(row.id));
  if (nonEntityLeadIds.length > 0) {
    await db.query(
      `UPDATE storyhold.world_entities
          SET scanner_present = false, pull_status = 'do_not_pull', updated_at = now()
        WHERE id = ANY($1::uuid[])`,
      [nonEntityLeadIds],
    );
    await db.query(
      `DELETE FROM storyhold.world_entity_relations relation
        WHERE relation.assignment_source <> 'user'
          AND (relation.source_entity_id = ANY($1::uuid[])
            OR relation.target_entity_id = ANY($1::uuid[]))`,
      [nonEntityLeadIds],
    );
  }
  const generatedRelations = await db.query<Record<string, unknown>>(
    `SELECT relation.id, relation.relation_type, relation.assignment_source,
            relation.evidence, source.name AS source_name, source.aliases AS source_aliases,
            source.entity_type AS source_type, target.name AS target_name,
            target.aliases AS target_aliases, target.entity_type AS target_type
       FROM storyhold.world_entity_relations relation
       JOIN storyhold.world_entities source ON source.id = relation.source_entity_id
       JOIN storyhold.world_entities target ON target.id = relation.target_entity_id
      WHERE relation.assignment_source <> 'user'`,
  );
  const invalidGeneratedRelationIds = generatedRelations.rows
    .filter((row) => {
      const relationType = String(row.relation_type) as EntityRelationType;
      const sourceType = String(row.source_type) as EntityType;
      const targetType = String(row.target_type) as EntityType;
      if (!relationEntityTypesAreCompatible(relationType, sourceType, targetType)) return true;
      if (String(row.assignment_source) !== "local") return false;
      const evidence = Array.isArray(row.evidence) ? row.evidence : [];
      const sourceNames = [
        textBody(row.source_name, 240),
        ...stringList(row.source_aliases, 40, 240),
      ].filter(localEntityTextIsUseful);
      const targetNames = [
        textBody(row.target_name, 240),
        ...stringList(row.target_aliases, 40, 240),
      ].filter(localEntityTextIsUseful);
      return !evidence.some((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
        const quote = textBody((entry as Record<string, unknown>).quote, 8_000);
        return quote.length > 0 && sourceNames.some((subject) =>
          targetNames.some((target) => relationHasDirectPredicateSupport({
            subject, target, relationType, quote,
          }))
        );
      });
    })
    .map((row) => String(row.id));
  if (invalidGeneratedRelationIds.length > 0) {
    await db.query(
      `DELETE FROM storyhold.world_entity_relations
        WHERE id = ANY($1::uuid[]) AND assignment_source <> 'user'`,
      [invalidGeneratedRelationIds],
    );
  }
  const generatedDossierLeads = await db.query<Record<string, unknown>>(
    `SELECT id, name FROM storyhold.character_dossiers
      WHERE dossier_status = 'active' AND user_edited_at IS NULL`,
  );
  const nonCharacterDossierIds = generatedDossierLeads.rows
    .filter((row) => !localCharacterNameIsUseful(textBody(row.name, 240)))
    .map((row) => String(row.id));
  if (nonCharacterDossierIds.length > 0) {
    await db.query(
      `UPDATE storyhold.character_dossiers
          SET dossier_status = 'suppressed', updated_at = now()
        WHERE id = ANY($1::uuid[]) AND user_edited_at IS NULL`,
      [nonCharacterDossierIds],
    );
  }
  const generatedCharacterCategoryRows = await db.query<Record<string, unknown>>(
    `SELECT entity.id, dossier.name, dossier.summary, dossier.evidence
       FROM storyhold.character_dossiers dossier
       JOIN storyhold.world_entities entity
         ON entity.world_id = dossier.world_id
        AND entity.canon_edition_id = dossier.canon_edition_id
        AND entity.normalized_name = dossier.normalized_name
      WHERE dossier.dossier_status = 'active'
        AND entity.entity_type <> 'character'
        AND entity.classification_source = 'local'
        AND entity.review_status <> 'user_confirmed'
        AND entity.pull_status = 'active'`,
  );
  const misclassifiedCharacterIds = generatedCharacterCategoryRows.rows
    .filter((row) =>
      /\b(?:central|major)\s+point-of-view\s+character\b/iu.test(textBody(row.summary, 4_000)) ||
      localEvidenceBehavesLikeCharacter(
        textBody(row.name, 240),
        Array.isArray(row.evidence) ? row.evidence as EvidenceReference[] : [],
      )
    )
    .map((row) => String(row.id));
  if (misclassifiedCharacterIds.length > 0) {
    await db.query(
      `UPDATE storyhold.world_entities
          SET entity_type = 'character', updated_at = now()
        WHERE id = ANY($1::uuid[])
          AND classification_source = 'local'
          AND review_status <> 'user_confirmed'`,
      [misclassifiedCharacterIds],
    );
  }
  // Older local-Qwen results may be marked `ai` because they completed a
  // verification stage, but they are still generated projections rather than
  // owner canon. Decisive manuscript evidence may repair any generated row;
  // customer-created, customer-confirmed, and customer-edited records remain
  // authoritative and are excluded here and again in the update below.
  const generatedCategoryReviewRows = await db.query<Record<string, unknown>>(
    `SELECT entity.*,
            dossier.summary AS dossier_summary,
            dossier.role AS dossier_role,
            dossier.profile AS dossier_profile,
            dossier.evidence AS dossier_evidence,
            dossier.canonical_character_id AS dossier_canonical_character_id,
            dossier.mention_count AS dossier_mention_count,
            dossier.mention_source_count AS dossier_mention_source_count,
            dossier.user_edited_at AS dossier_user_edited_at
      FROM storyhold.world_entities entity
      LEFT JOIN storyhold.character_dossiers dossier ON dossier.id = entity.dossier_id
      WHERE entity.pull_status = 'active'
        AND entity.classification_source <> 'user'
        AND entity.review_status <> 'user_confirmed'`,
  );
  const restoredCharacterTargets = new Map<string, {
    worldId: string;
    editionId: string;
    names: Set<string>;
  }>();
  for (const row of generatedCategoryReviewRows.rows) {
    if (row.dossier_user_edited_at) continue;
    const evidence = Array.isArray(row.evidence) ? row.evidence as EvidenceReference[] : [];
    const currentType = String(row.entity_type) as EntityType;
    const dossierEvidence = Array.isArray(row.dossier_evidence) ? row.dossier_evidence : [];
    const hasSubstantiveCharacterDossier = Boolean(row.dossier_id) &&
      generatedCharacterDossierIsSubstantive({
        name: row.name,
        summary: row.dossier_summary,
        role: row.dossier_role,
        profile: row.dossier_profile,
        evidence: dossierEvidence,
        canonicalCharacterId: row.dossier_canonical_character_id,
        mentionCount: row.dossier_mention_count,
        mentionSourceCount: row.dossier_mention_source_count,
      });
    const decision = adjudicateGeneratedEntityHypotheses({
      hasSubstantiveCharacterDossier,
      hypotheses: [{
        entityType: currentType,
        finding: {
          name: textBody(row.name, 240),
          aliases: stringList(row.aliases, 80, 240),
          summary: textBody(row.summary, 4_000),
          details: stringList(row.details, 80, 500),
          relationships: stringList(row.relationships, 80, 500),
          evidence,
          confidence: Number(row.confidence ?? 0.35),
          mentionCount: Number(row.mention_count ?? 0),
          mentionSourceCount: Number(row.mention_source_count ?? 0),
          reviewStatus: "candidate",
        },
      }],
    });
    const category = decision?.entityType ?? currentType;
    const categoryChanged = category !== currentType;
    const restoreVisibility = generatedCategoryRepairShouldRestoreVisibility({
      categoryChanged,
      category,
      evidenceCount: evidence.length,
    });
    const staleDossierPresentation = category === "character" &&
      generatedEntityPresentationNeedsRefresh(row.dossier_summary);
    if (!generatedLocalEntityNeedsPresentationRepair({
      categoryChanged,
      category,
      entitySummary: row.summary,
      dossierSummary: row.dossier_summary,
    })) continue;
    const entityName = textBody(row.name, 240);
    const presentation = category === "character"
      ? (() => {
          const dossierSummary = textBody(row.dossier_summary, 4_000);
          if (dossierSummary && !generatedEntityPresentationNeedsRefresh(dossierSummary)) {
            return { summary: dossierSummary, details: stringList(row.details, 80, 500) };
          }
          return localPublicEntitySummaryFromEvidence("character", entityName, evidence);
        })()
      : localPublicEntitySummaryFromEvidence(category, entityName, evidence);
    await db.query(
      `UPDATE storyhold.world_entities
          SET entity_type = $2,
              summary = $3,
              details = $4::jsonb,
              scanner_present = CASE WHEN $5 THEN true ELSE scanner_present END,
              updated_at = now()
        WHERE id = $1 AND classification_source <> 'user'
          AND review_status <> 'user_confirmed'`,
      [row.id, category, presentation.summary, JSON.stringify(presentation.details), restoreVisibility],
    );
    if (category === "character") {
      await ensureEntityCharacterDossier(db, {
        worldId: String(row.world_id),
        editionId: String(row.canon_edition_id),
        entity: {
          ...row,
          entity_type: "character",
          summary: presentation.summary,
          details: presentation.details,
        },
      });
      if (categoryChanged || staleDossierPresentation) {
        const worldId = String(row.world_id);
        const editionId = String(row.canon_edition_id);
        const key = `${worldId}:${editionId}`;
        const target = restoredCharacterTargets.get(key) ?? {
          worldId,
          editionId,
          names: new Set<string>(),
        };
        target.names.add(entityName);
        restoredCharacterTargets.set(key, target);
      }
    } else if (categoryChanged && row.dossier_id) {
      await db.query(
        `UPDATE storyhold.character_dossiers
            SET dossier_status = 'suppressed', updated_at = now()
          WHERE id = $1 AND user_edited_at IS NULL`,
        [row.dossier_id],
      );
    }
  }
  for (const target of restoredCharacterTargets.values()) {
    try {
      await migrateLocalDossierUnderstanding(db, target.worldId, target.editionId, {
        force: true,
        localProjectionOnly: true,
        repairIdentities: false,
        rebuildConnections: false,
        targetCharacterNames: [...target.names],
      });
    } catch (error) {
      // Category repair remains valid even if an old world lacks enough saved
      // local-read context for a portrait refresh. Intake can safely retry the
      // projection later without blocking the server from opening.
      console.warn("Could not refresh restored local character dossiers:", error);
    }
  }
  const generatedCharacterAliases = await db.query<Record<string, unknown>>(
    `SELECT entity.id, entity.name, entity.aliases, entity.dossier_id,
            dossier.alias_attributions, dossier.user_edited_at
       FROM storyhold.world_entities entity
       LEFT JOIN storyhold.character_dossiers dossier ON dossier.id = entity.dossier_id
      WHERE entity.entity_type = 'character' AND entity.pull_status = 'active'
        AND entity.scanner_present = true AND entity.classification_source = 'local'
        AND entity.review_status <> 'user_confirmed'`,
  );
  const generatedCharacterIds = generatedCharacterAliases.rows.map((row) => String(row.id));
  const generatedAliasMentions = generatedCharacterIds.length > 0
    ? await db.query<Record<string, unknown>>(
        `SELECT entity_id, normalized_surface, count(*)::int AS mention_count
           FROM storyhold.world_entity_mentions
          WHERE entity_id = ANY($1::uuid[]) AND mention_kind = 'literal'
          GROUP BY entity_id, normalized_surface`,
        [generatedCharacterIds],
      )
    : { rows: [] as Record<string, unknown>[] };
  const aliasCounts = new Map<string, Map<string, number>>();
  for (const mention of generatedAliasMentions.rows) {
    const entityId = String(mention.entity_id);
    const counts = aliasCounts.get(entityId) ?? new Map<string, number>();
    counts.set(textBody(mention.normalized_surface, 240), Number(mention.mention_count ?? 0));
    aliasCounts.set(entityId, counts);
  }
  for (const row of generatedCharacterAliases.rows) {
    if (row.user_edited_at) continue;
    const aliases = stringList(row.aliases, 80, 240);
    if (!aliases.length) continue;
    const name = textBody(row.name, 240);
    const counts = aliasCounts.get(String(row.id)) ?? new Map<string, number>();
    const attributed = new Set(
      (Array.isArray(row.alias_attributions) ? row.alias_attributions : [])
        .flatMap((entry) => {
          const parsed = normalizeCharacterAliasAttribution(entry);
          return parsed ? [parsed.alias.trim().toLocaleLowerCase()] : [];
        }),
    );
    const visible = aliases.filter((alias) => generatedAliasIsCustomerVisible({
      alias,
      canonicalName: name,
      aliasMentions: counts.get(alias.trim().toLocaleLowerCase()) ?? 0,
      canonicalMentions: counts.get(name.trim().toLocaleLowerCase()) ?? 0,
      explicitlyAttributed: attributed.has(alias.trim().toLocaleLowerCase()),
    }));
    if (visible.length === aliases.length) continue;
    await db.query(
      `UPDATE storyhold.world_entities SET aliases = $2::jsonb, updated_at = now()
        WHERE id = $1 AND classification_source = 'local'
          AND review_status <> 'user_confirmed'`,
      [row.id, json(visible)],
    );
    if (row.dossier_id) {
      await db.query(
        `UPDATE storyhold.character_dossiers SET aliases = $2::jsonb, updated_at = now()
          WHERE id = $1 AND user_edited_at IS NULL`,
        [row.dossier_id, json(visible)],
      );
    }
  }
  const generatedContextRows = await db.query<Record<string, unknown>>(
    `SELECT entity.id, entity.name, entity.entity_type, entity.evidence
       FROM storyhold.world_entities entity
      WHERE entity.entity_type IN ('cultural_reference', 'term')
        AND entity.pull_status = 'active'
        AND entity.classification_source = 'local'
        AND entity.review_status <> 'user_confirmed'`,
  );
  for (const row of generatedContextRows.rows) {
    const entityType = row.entity_type === "cultural_reference" ? "cultural_reference" : "term";
    const storedEvidence = Array.isArray(row.evidence) ? row.evidence as EvidenceReference[] : [];
    const evidenceChunkIds = [...new Set(storedEvidence.map((entry) => entry.chunkId).filter(Boolean))];
    const evidenceChunks = evidenceChunkIds.length > 0
      ? await db.query<Record<string, unknown>>(
        `SELECT id, metadata FROM storyhold.world_source_chunks WHERE id = ANY($1::uuid[])`,
        [evidenceChunkIds],
      )
      : { rows: [] as Record<string, unknown>[] };
    const sectionByChunkId = new Map(evidenceChunks.rows.map((chunk) => [
      String(chunk.id),
      textBody(recordBody(chunk.metadata).sectionTitle, 240),
    ]));
    const enrichedEvidence = storedEvidence.map((entry) => {
      const sectionTitle = entry.sectionTitle?.trim() || sectionByChunkId.get(entry.chunkId) || "";
      const perspective = normalizeNarrativePerspective(entry.perspective) ||
        chapterPerspectiveFromSectionTitle(sectionTitle);
      return {
        ...entry,
        ...(sectionTitle ? { sectionTitle } : {}),
        ...(perspective ? { perspective } : {}),
      };
    });
    const contextCard = localContextCardFromEvidence(
      entityType,
      textBody(row.name, 240),
      enrichedEvidence,
    );
    await db.query(
      `UPDATE storyhold.world_entities
          SET summary = $2, details = $3::jsonb, evidence = $4::jsonb, updated_at = now()
        WHERE id = $1 AND classification_source = 'local'
          AND review_status <> 'user_confirmed'`,
      [row.id, contextCard.summary, JSON.stringify(contextCard.details), JSON.stringify(enrichedEvidence)],
    );
  }
  await db.query(
    `UPDATE storyhold.world_sources
        SET ai_reviewed_chunk_count = chunk_count,
            ai_reviewed_content_hash = COALESCE(ai_reviewed_content_hash, content_hash)
      WHERE ai_review_status = 'reviewed' AND ai_reviewed_chunk_count = 0`,
  );
  await mkdir(path.join(storageRoot, "uploads"), { recursive: true });
  await db.query(
    `UPDATE storyhold.world_sources
        SET local_scan_status = 'not_applicable', ai_review_status = 'not_applicable'
      WHERE processing_status <> 'ready' OR canon_status NOT IN ('candidate', 'canon') OR chunk_count = 0`,
  );
  await db.query(
    `UPDATE storyhold.world_sources
        SET local_scan_status = 'pending'
      WHERE processing_status = 'ready' AND canon_status IN ('candidate', 'canon') AND chunk_count > 0
        AND local_scan_status IN ('queued', 'running')`,
  );
  await db.query(
    `UPDATE storyhold.world_sources
        SET ai_review_status = 'waiting'
      WHERE processing_status = 'ready' AND canon_status IN ('candidate', 'canon') AND chunk_count > 0
        AND ai_review_status IN ('queued', 'running')`,
  );
  await db.query(
    `UPDATE storyhold.world_analysis_runs
        SET status = 'failed', stage = 'interrupted by server restart', error = 'The local server restarted before this analysis completed.', completed_at = now()
      WHERE status IN ('queued', 'running') AND analysis_kind <> 'ai_enrichment'`,
  );
  await pauseInterruptedPremiumReviews(db);
  const entityBackfill = await db.query<{
    world_id: string;
    canon_edition_id: string;
  }>(
    `SELECT world_id, id AS canon_edition_id FROM storyhold.canon_editions
      WHERE status <> 'archived'`,
  );
  for (const row of entityBackfill.rows) {
    await ensureWorldEntities(db, row.world_id, row.canon_edition_id);
  }
  await applyPendingCompletedBrowserAudits(db);
  const chapterBackfill = await db.query<{
    id: string;
    world_id: string;
    canon_edition_id: string;
    title: string;
    chronology_label: string;
    chronology_order: number;
    extracted_text: string;
    file_as_chapter: boolean;
  }>(
    `SELECT id, world_id, canon_edition_id, title, chronology_label,
            chronology_order, extracted_text, file_as_chapter
       FROM storyhold.world_sources
      WHERE processing_status = 'ready'
        AND canon_status IN ('candidate', 'canon')
        AND extracted_text <> ''`,
  );
  for (const source of chapterBackfill.rows) {
    await syncSourceChapterSummaries({
      db,
      worldId: source.world_id,
      editionId: source.canon_edition_id,
      sourceId: source.id,
      sourceTitle: source.title,
      chronologyLabel: source.chronology_label,
      chronologyOrder: Number(source.chronology_order),
      extractedText: source.extracted_text,
      fileAsChapter: source.file_as_chapter,
    });
  }
  // Keep obsolete parser rows recoverable. This startup migration used to
  // delete every matching row globally, which could cascade immutable receipt
  // links or remove an owner-created event that happened to reuse the key.
  await db.query(
    `UPDATE storyhold.world_clock_events event
        SET visibility = 'studio', knowledge_status = 'inferred'
      WHERE event.campaign_id IS NULL
        AND event.created_by_player_id IS NULL
        AND event.assignment_source = 'local'
        AND event.canonical_key LIKE 'source-chapter-v1-%'
        AND NOT EXISTS (
          SELECT 1 FROM storyhold.world_clock_event_verifications verified
           WHERE verified.event_id = event.id
        )`,
  );
  for (const row of entityBackfill.rows) {
    await refreshWorldQualityFindings({
      db,
      worldId: row.world_id,
      editionId: row.canon_edition_id,
    });
  }
}

async function scheduleDeferredBacklog(db: StudioRootDb) {
  await db.query(
    `UPDATE storyhold.world_sources
        SET ai_review_status = 'waiting'
      WHERE processing_status = 'ready'
        AND canon_status IN ('candidate', 'canon')
        AND chunk_count > 0
        AND ai_review_status = 'reviewed'
        AND (ai_reviewed_content_hash IS DISTINCT FROM content_hash
          OR ai_analysis_version < ${WORLD_ANALYSIS_VERSION})`,
  );
  const result = await db.query<{
    world_id: string;
    canon_edition_id: string;
    owner_player_id: string;
    needs_local: boolean;
    needs_ai: boolean;
  }>(
    `SELECT w.id AS world_id, s.canon_edition_id, w.owner_player_id,
            bool_or(s.local_scan_status = 'pending' OR
              (s.local_scan_status = 'completed' AND
               (s.local_scanned_content_hash IS DISTINCT FROM s.content_hash OR
                s.local_analysis_version < ${LOCAL_ANALYSIS_VERSION}))) AS needs_local,
            bool_or(s.ai_review_status = 'waiting' OR
              (s.ai_review_status = 'reviewed' AND
               (s.ai_reviewed_content_hash IS DISTINCT FROM s.content_hash OR
                s.ai_analysis_version < ${WORLD_ANALYSIS_VERSION}))) AS needs_ai
       FROM storyhold.worlds w
       JOIN storyhold.world_sources s ON s.world_id = w.id
      WHERE s.processing_status = 'ready' AND s.canon_status IN ('candidate', 'canon') AND s.chunk_count > 0
        AND NOT EXISTS (
          SELECT 1
            FROM storyhold.world_sources unpaid_intake
           WHERE unpaid_intake.world_id = w.id
             AND unpaid_intake.canon_edition_id = s.canon_edition_id
             AND unpaid_intake.intake_payment_required = true
        )
      GROUP BY w.id, s.canon_edition_id, w.owner_player_id
      HAVING bool_or(s.local_scan_status = 'pending' OR
               (s.local_scan_status = 'completed' AND
                (s.local_scanned_content_hash IS DISTINCT FROM s.content_hash OR
                 s.local_analysis_version < ${LOCAL_ANALYSIS_VERSION})))
          OR bool_or(s.ai_review_status = 'waiting' OR
                (s.ai_review_status = 'reviewed' AND
                 (s.ai_reviewed_content_hash IS DISTINCT FROM s.content_hash OR
                  s.ai_analysis_version < ${WORLD_ANALYSIS_VERSION})))
      ORDER BY w.id`,
  );
  result.rows.forEach((row, index) => {
    const kind = deferredBacklogAnalysisKind({
      needsLocal: row.needs_local,
      needsAi: row.needs_ai,
    });
    if (!kind) return;
    scheduleAutomaticAnalysis(db, {
      worldId: row.world_id,
      editionId: row.canon_edition_id,
      playerId: row.owner_player_id,
      trigger: "backfill",
      kind,
      delay: 300 + index * 200,
    });
  });
}

async function backfillMissingConceptGraphs(db: StudioRootDb) {
  const missing = await db.query<{ world_id: string; canon_edition_id: string }>(
    `SELECT edition.world_id, edition.id AS canon_edition_id
       FROM storyhold.canon_editions edition
      WHERE edition.status <> 'archived'
        AND EXISTS (
          SELECT 1 FROM storyhold.world_entities entity
           WHERE entity.world_id = edition.world_id
             AND entity.canon_edition_id = edition.id
             AND entity.pull_status = 'active' AND entity.scanner_present = true
        )
        AND NOT EXISTS (
          SELECT 1 FROM storyhold.world_concept_clusters cluster
           WHERE cluster.world_id = edition.world_id
             AND cluster.canon_edition_id = edition.id
             AND cluster.resolution_version >= $1
        )
        AND NOT EXISTS (
          SELECT 1 FROM storyhold.world_analysis_runs run
           WHERE run.world_id = edition.world_id
             AND run.canon_edition_id = edition.id
             AND run.status IN ('queued', 'running', 'paused')
        )
      ORDER BY edition.world_id`,
    [CONCEPT_RESOLUTION_VERSION],
  );
  for (const row of missing.rows) {
    await db.transaction(async (tx) => {
      await syncWorldEntityMentions({
        db: tx,
        worldId: row.world_id,
        editionId: row.canon_edition_id,
      });
      await syncWorldConceptGraph({
        db: tx,
        worldId: row.world_id,
        editionId: row.canon_edition_id,
      });
    });
  }
}

async function refreshCanonicalMentionCounts(params: {
  db: StudioDb;
  worldId: string;
  editionId: string;
}) {
  // Mention totals are a projection of the current canonical identity graph,
  // not a counter attached to the spelling that happened to create a card.
  // Rebuild first so aliases, merges, restores, and renamed cards are all
  // reflected before the customer-facing concept totals are calculated.
  await syncWorldEntityMentions(params);
  await syncWorldConceptGraph(params);
}

export function registerWorldStudioRoutes(params: {
  app: Express;
  db: StudioRootDb;
  requireUser: RequestHandler;
  storageRoot: string;
}) {
  const { app, db, requireUser, storageRoot } = params;

  registerAdventureSetupRoutes({ app, db, requireUser });
  registerCampaignPlayRoutes({ app, db, requireUser });
  registerStoryStudioRoutes({ app, db, requireUser });
  registerPremiumRecoveryRoutes({
    app, db, requireUser, isWorldWorkerActive: (worldId) => activeRuns.has(worldId),
  });
  registerBrowserLocalAuditRoutes({
    app,
    db,
    requireUser,
  });
  setTimeout(() => void scheduleDeferredBacklog(db), 100);
  setTimeout(() => void backfillMissingConceptGraphs(db).catch((error) => {
    console.error("Storyhold concept graph backfill failed:", error);
  }), 2_500);

  app.get("/api/storyhold/ai/status", requireUser, (req: StudioRequest, res) => {
    const user = currentUser(req);
    res.json(customerAiRuntimeStatus(getAiRuntimeStatus(), user.role));
  });

  app.get(
    "/api/storyhold/preferences",
    requireUser,
    async (req: StudioRequest, res) => {
      const user = currentUser(req);
      const result = await db.query<Record<string, unknown>>(
        "SELECT * FROM storyhold.player_story_preferences WHERE player_id = $1 LIMIT 1",
        [user.id],
      );
      res.json({ preferences: serializePreferences(result.rows[0]) });
    },
  );

  app.put(
    "/api/storyhold/preferences",
    requireUser,
    async (req: StudioRequest, res) => {
      const user = currentUser(req);
      const adultEnabled = req.body?.adultEnabled === true;
      const sexualContentLevel = ["off", "fade_to_black", "explicit"].includes(
        String(req.body?.sexualContentLevel),
      )
        ? String(req.body.sexualContentLevel)
        : "off";
      const violenceLevel = ["standard", "graphic"].includes(
        String(req.body?.violenceLevel),
      )
        ? String(req.body.violenceLevel)
        : "standard";
      const narrativeLength = ["concise", "balanced", "expansive"].includes(
        String(req.body?.narrativeLength),
      )
        ? String(req.body.narrativeLength)
        : "balanced";
      const anonymousLearningEnabled = req.body?.anonymousLearningEnabled === true;
      const localModelTrainingEnabled = req.body?.localModelTrainingEnabled === true;
      if (sexualContentLevel === "explicit" && !adultEnabled) {
        res.status(400).json({
          error: "Explicit sexual content can only be enabled with adult mode.",
        });
        return;
      }
      if (adultEnabled && req.body?.ageConfirmed !== true) {
        res.status(400).json({
          error: "Confirm that you are at least 18 years old to enable adult mode.",
        });
        return;
      }
      await db.query(
        `INSERT INTO storyhold.player_story_preferences
          (player_id, adult_enabled, age_attested_at, age_attestation_version,
           sexual_content_level, violence_level, narrative_length,
           anonymous_learning_enabled, local_model_training_enabled)
         VALUES ($1, $2, CASE WHEN $2 THEN now() ELSE NULL END,
                 CASE WHEN $2 THEN '2026-08-01' ELSE NULL END, $3, $4, $5, $6, $7)
         ON CONFLICT (player_id) DO UPDATE
           SET adult_enabled = EXCLUDED.adult_enabled,
               age_attested_at = CASE
                 WHEN EXCLUDED.adult_enabled AND player_story_preferences.age_attested_at IS NULL
                 THEN now()
                 ELSE player_story_preferences.age_attested_at
               END,
               age_attestation_version = CASE
                 WHEN EXCLUDED.adult_enabled THEN '2026-08-01'
                 ELSE player_story_preferences.age_attestation_version
               END,
               sexual_content_level = EXCLUDED.sexual_content_level,
               violence_level = EXCLUDED.violence_level,
               narrative_length = EXCLUDED.narrative_length,
               anonymous_learning_enabled = EXCLUDED.anonymous_learning_enabled,
               local_model_training_enabled = EXCLUDED.local_model_training_enabled,
               updated_at = now()`,
        [
          user.id,
          adultEnabled,
          adultEnabled ? sexualContentLevel : "off",
          violenceLevel,
          narrativeLength,
          anonymousLearningEnabled,
          localModelTrainingEnabled,
        ],
      );
      if (!localModelTrainingEnabled) {
        // Revoking this separate consent removes held examples immediately.
        // Shared anonymous pattern counts are governed by their own setting.
        await db.query(
          `DELETE FROM storyhold.lorekeeper_local_training_examples
            WHERE player_id = $1 AND review_status = 'held'`,
          [user.id],
        ).catch(() => undefined);
      }
      const result = await db.query<Record<string, unknown>>(
        "SELECT * FROM storyhold.player_story_preferences WHERE player_id = $1 LIMIT 1",
        [user.id],
      );
      res.json({ preferences: serializePreferences(result.rows[0]) });
    },
  );

  app.get(
    "/api/storyhold/worlds",
    requireUser,
    async (req: StudioRequest, res) => {
      const user = currentUser(req);
      const result = await db.query<Record<string, unknown>>(
        `SELECT w.*,
              stats.source_count, stats.word_count, stats.chunk_count,
              stats.people_count, stats.campaign_count,
              (SELECT count(*)::int FROM storyhold.character_drafts d WHERE d.world_id = w.id AND d.review_status = 'draft') AS character_draft_count,
              (SELECT count(*)::int FROM storyhold.characters c WHERE c.world_id = w.id AND c.scope_kind = 'world') AS approved_character_count,
              (SELECT count(*)::int FROM storyhold.world_sources s WHERE s.world_id = w.id AND s.ai_review_status IN ('waiting', 'queued', 'running')) AS waiting_ai_review_count,
              (SELECT count(*)::int FROM storyhold.cohesion_proposals p WHERE p.world_id = w.id AND p.review_status = 'pending') AS pending_cohesion_count,
              (SELECT count(*)::int FROM storyhold.canon_discrepancy_reports d WHERE d.world_id = w.id AND d.status IN ('needs_reason', 'correction_offered')) AS unresolved_discrepancy_count,
              (SELECT count(*)::int FROM storyhold.canon_amendments a WHERE a.world_id = w.id) AS canon_amendment_count,
              (SELECT count(*)::int FROM storyhold.world_clock_events e WHERE e.world_id = w.id AND e.visibility IN ('world', 'campaign', 'character')) AS visible_clock_event_count,
              (SELECT r.status FROM storyhold.world_analysis_runs r WHERE r.world_id = w.id ORDER BY r.created_at DESC LIMIT 1) AS latest_analysis_status
         FROM storyhold.worlds w
         JOIN storyhold.world_card_stats stats ON stats.world_id = w.id
        WHERE w.owner_player_id = $1
        ORDER BY w.updated_at DESC, w.created_at DESC`,
        [user.id],
      );
      res.json({
        worlds: result.rows.map(serializeWorld),
        ai: customerAiRuntimeStatus(getAiRuntimeStatus(), user.role),
      });
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/canon-constraints",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      if (!assertUuid(worldId, res)) return;
      const user = currentUser(req);
      if (!(await ownedWorld(db, worldId, user.id))) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await defaultEdition(db, worldId);
      if (!edition) {
        res.status(409).json({ error: "This world does not have a canon edition." });
        return;
      }
      const instruction = textBody(req.body?.instruction, 4_000);
      const entityId = textBody(req.body?.entityId, 80) || null;
      const requestedKind = textBody(req.body?.kind, 40) as OwnerCanonConstraint["kind"];
      const allowedKinds = new Set<OwnerCanonConstraint["kind"]>([
        "identity", "relationship", "category", "chronology", "fact", "focus",
      ]);
      if (instruction.length < 8) {
        res.status(400).json({ error: "Describe the canon correction in a complete sentence." });
        return;
      }
      if (entityId && !UUID_PATTERN.test(entityId)) {
        res.status(400).json({ error: "That Hold record ID is not valid." });
        return;
      }
      if (entityId) {
        const entity = await db.query<{ found: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM storyhold.world_entities
              WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3
           ) AS found`,
          [entityId, worldId, edition.id],
        );
        if (!entity.rows[0]?.found) {
          res.status(404).json({ error: "That Hold record was not found in this world." });
          return;
        }
      }
      const constraint = await saveOwnerCanonConstraint({
        db,
        worldId,
        editionId: edition.id,
        playerId: user.id,
        entityId,
        instruction,
        forceKind: allowedKinds.has(requestedKind) ? requestedKind : "fact",
      });
      if (!constraint) {
        res.status(400).json({ error: "That canon correction could not be saved." });
        return;
      }
      await enforceOwnerCanonConstraints({ db, worldId, editionId: edition.id });
      await syncWorldConceptGraph({ db, worldId, editionId: edition.id });
      res.status(201).json({ constraint });
    },
  );

  app.post(
    "/api/storyhold/worlds",
    requireUser,
    async (req: StudioRequest, res) => {
      const user = currentUser(req);
      const name = textBody(req.body?.name, 140);
      const premise = textBody(req.body?.premise, 6_000);
      const genre = textBody(req.body?.genre, 160);
      const inferMetadata = req.body?.inferMetadata === true;
      const creationMode = CREATION_MODES.has(String(req.body?.creationMode))
        ? String(req.body.creationMode)
        : "import";
      const resolutionMode = RESOLUTION_MODES.has(
        String(req.body?.resolutionMode),
      )
        ? String(req.body.resolutionMode)
        : "story_first";
      const worldContract = contractForNewWorld({
        value: req.body?.worldContract,
        premise,
        genre,
      });
      const contentSettings = cleanContentSettings(req.body?.contentSettings);
      if (name.length < 2) {
        res
          .status(400)
          .json({ error: "Give the world a name of at least two characters." });
        return;
      }
      const worldId = randomUUID();
      const editionId = randomUUID();
      await db.query(
        `INSERT INTO storyhold.worlds
        (id, owner_player_id, canonical_key, name, premise, description, genre,
         creation_mode, world_contract, resolution_mode, content_settings,
         metadata_inference_status)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11)`,
        [
          worldId,
          user.id,
          `${slug(name)}-${worldId.slice(0, 8)}`,
          name,
          premise,
          genre,
          creationMode,
          json(worldContract),
          resolutionMode,
          json(contentSettings),
          inferMetadata ? "requested" : "manual",
        ],
      );
      try {
        await db.query(
          `INSERT INTO storyhold.canon_editions
          (id, world_id, created_by_player_id, canonical_key, name)
         VALUES ($1, $2, $3, 'working-canon', 'Working canon')`,
          [editionId, worldId, user.id],
        );
      } catch (error) {
        await db.query("DELETE FROM storyhold.worlds WHERE id = $1", [worldId]);
        throw error;
      }
      res.status(201).json({
        id: worldId,
        editionId,
        name,
        worldContract,
        contractStatus: "draft",
      });
    },
  );

  app.get(
    "/api/storyhold/worlds/:worldId",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      if (!assertUuid(worldId, res)) return;
      const user = currentUser(req);
      const world = await ownedWorld(db, worldId, user.id);
      if (!world) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await defaultEdition(db, worldId);
      if (!edition) {
        res
          .status(409)
          .json({ error: "This world does not have a canon edition." });
        return;
      }
      res.setHeader("Cache-Control", "private, no-store");
      await ensureWorldEntities(db, worldId, edition.id);
      const [
        sources,
        breakdowns,
        runs,
        drafts,
        dossiers,
        characters,
        proposals,
        discrepancyReports,
        amendments,
        campaigns,
        worldEvents,
        worldEventRelations,
        chapterSummaries,
        worldStats,
        entities,
        entityMemberships,
        entityRelations,
        entityRules,
        entityActions,
        qualityFindings,
        referenceSources,
        conceptClusters,
        relationHypotheses,
        canonConstraints,
        authorDraftAccess,
        browserAudit,
      ] = await Promise.all(
        [
          db.query<Record<string, unknown>>(
            "SELECT * FROM storyhold.world_sources WHERE world_id = $1 AND canon_edition_id = $2 ORDER BY chronology_order ASC, sort_order ASC, created_at ASC",
            [worldId, edition.id],
          ),
          db.query<Record<string, unknown>>(
            "SELECT * FROM storyhold.world_breakdowns WHERE world_id = $1 AND canon_edition_id = $2 ORDER BY version DESC LIMIT 1",
            [worldId, edition.id],
          ),
          db.query<Record<string, unknown>>(
            `SELECT run.*
               FROM storyhold.world_analysis_runs run
              WHERE run.world_id = $1 AND run.canon_edition_id = $2
              ORDER BY run.created_at DESC, run.id DESC LIMIT 1`,
            [worldId, edition.id],
          ),
          db.query<Record<string, unknown>>(
            `SELECT d.* FROM storyhold.character_drafts d
          WHERE d.world_id = $1 AND d.canon_edition_id = $2
            AND d.review_status = 'draft'
          ORDER BY d.confidence DESC, d.name ASC`,
            [worldId, edition.id],
          ),
          db.query<Record<string, unknown>>(
            `SELECT dossier.*,
                    entity.mention_count AS hold_mention_count,
                    entity.mention_source_count AS hold_mention_source_count
               FROM storyhold.character_dossiers dossier
              JOIN storyhold.world_entities entity ON entity.dossier_id = dossier.id
             WHERE dossier.world_id = $1 AND dossier.canon_edition_id = $2
               AND dossier.dossier_status = 'active'
               AND entity.pull_status = 'active' AND entity.scanner_present = true
               AND entity.entity_type = 'character'
              ORDER BY CASE WHEN dossier.mention_count > 0 THEN 0 ELSE 1 END,
                       dossier.mention_count DESC, dossier.confidence DESC, dossier.name ASC`,
            [worldId, edition.id],
          ),
          db.query<Record<string, unknown>>(
            "SELECT id, canonical_key, name, initial_profile, profile_locked_at, created_at FROM storyhold.characters WHERE world_id = $1 AND scope_kind = 'world' ORDER BY name ASC",
            [worldId],
          ),
          db.query<Record<string, unknown>>(
            `SELECT * FROM storyhold.cohesion_proposals
              WHERE world_id = $1 AND canon_edition_id = $2
              ORDER BY CASE review_status WHEN 'pending' THEN 0 ELSE 1 END,
                       created_at DESC
              LIMIT 100`,
            [worldId, edition.id],
          ),
          db.query<Record<string, unknown>>(
            `SELECT * FROM storyhold.canon_discrepancy_reports
              WHERE world_id = $1 AND canon_edition_id = $2 AND campaign_id IS NULL
              ORDER BY created_at DESC
              LIMIT 50`,
            [worldId, edition.id],
          ),
          db.query<Record<string, unknown>>(
            `SELECT * FROM storyhold.canon_amendments
              WHERE world_id = $1 AND canon_edition_id = $2 AND campaign_id IS NULL
              ORDER BY created_at DESC
              LIMIT 100`,
            [worldId, edition.id],
          ),
          db.query<Record<string, unknown>>(
            `SELECT c.*, ch.name AS character_name,
                    (SELECT count(*)::int FROM storyhold.world_clock_events e
                      WHERE e.campaign_id = c.id AND e.visibility IN ('campaign', 'character')) AS event_count
               FROM storyhold.campaigns c
               LEFT JOIN storyhold.characters ch ON ch.id = c.perspective_character_id
              WHERE c.world_id = $1 AND c.parent_campaign_id IS NULL
              ORDER BY c.created_at DESC`,
            [worldId],
          ),
          readWorldClockEventsForEdition(db, {
            worldId,
            editionId: edition.id,
          }),
          readWorldClockRelationsForEdition(db, {
            worldId,
            editionId: edition.id,
          }),
          db.query<Record<string, unknown>>(
            `SELECT chapter.*, source.title AS source_title,
                    source.chronology_label AS source_chronology_label,
                    source.chronology_order AS source_chronology_order
               FROM storyhold.world_chapter_summaries chapter
               JOIN storyhold.world_sources source ON source.id = chapter.source_id
              WHERE chapter.world_id = $1 AND chapter.canon_edition_id = $2
              ORDER BY source.chronology_order ASC, chapter.source_order ASC`,
            [worldId, edition.id],
          ),
          db.query<Record<string, unknown>>(
            `SELECT * FROM storyhold.world_card_stats WHERE world_id = $1 LIMIT 1`,
            [worldId],
          ),
          db.query<Record<string, unknown>>(
            `SELECT * FROM storyhold.world_entities
              WHERE world_id = $1 AND canon_edition_id = $2
                AND pull_status <> 'deleted'
                AND (scanner_present = true OR classification_source = 'user'
                  OR review_status = 'user_confirmed')
              ORDER BY CASE pull_status WHEN 'active' THEN 0 WHEN 'do_not_pull' THEN 1 ELSE 2 END,
                       CASE entity_type WHEN 'ambiguous' THEN 0 WHEN 'character' THEN 1
                         WHEN 'creature' THEN 2 WHEN 'place' THEN 3 ELSE 4 END,
                       mention_count DESC, name ASC`,
            [worldId, edition.id],
          ),
          db.query<Record<string, unknown>>(
            `SELECT membership.*, faction.name AS faction_name
               FROM storyhold.world_entity_faction_memberships membership
               JOIN storyhold.world_entities entity ON entity.id = membership.entity_id
               JOIN storyhold.world_entities faction ON faction.id = membership.faction_entity_id
              WHERE entity.world_id = $1 AND entity.canon_edition_id = $2
                AND entity.scanner_present = true AND faction.scanner_present = true
                AND faction.pull_status = 'active'`,
            [worldId, edition.id],
          ),
          db.query<Record<string, unknown>>(
            `SELECT relation.*,
                    source.name AS source_name, source.entity_type AS source_type,
                    target.name AS target_name, target.entity_type AS target_type
               FROM storyhold.world_entity_relations relation
               JOIN storyhold.world_entities source ON source.id = relation.source_entity_id
               JOIN storyhold.world_entities target ON target.id = relation.target_entity_id
              WHERE relation.world_id = $1 AND relation.canon_edition_id = $2
                AND relation.assignment_source <> 'local'
                AND source.pull_status = 'active' AND target.pull_status = 'active'
              ORDER BY relation.relation_type, source.name, target.name`,
            [worldId, edition.id],
          ),
          db.query<Record<string, unknown>>(
            `SELECT rule.* FROM storyhold.world_entity_rules rule
              JOIN storyhold.world_entities entity ON entity.id = rule.entity_id
             WHERE rule.world_id = $1 AND rule.canon_edition_id = $2
               AND rule.rule_status = 'active' AND entity.pull_status = 'active'
             ORDER BY entity.name, rule.name`,
            [worldId, edition.id],
          ),
          db.query<Record<string, unknown>>(
            `SELECT id, action_type, summary, created_at, undone_at
               FROM storyhold.world_entity_actions
              WHERE world_id = $1 AND canon_edition_id = $2
              ORDER BY created_at DESC LIMIT 20`,
            [worldId, edition.id],
          ),
          db.query<Record<string, unknown>>(
            `SELECT * FROM storyhold.world_quality_findings
              WHERE world_id = $1 AND canon_edition_id = $2
                AND finding_status = 'open'
              ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                       category, last_detected_at DESC
              LIMIT 500`,
            [worldId, edition.id],
          ),
          db.query<Record<string, unknown>>(
            `SELECT * FROM storyhold.world_reference_sources
              WHERE world_id = $1 AND canon_edition_id = $2
                AND review_status <> 'rejected'
              ORDER BY CASE review_status WHEN 'approved' THEN 0 ELSE 1 END,
                       created_at DESC`,
            [worldId, edition.id],
          ),
          db.query<Record<string, unknown>>(
            `SELECT * FROM storyhold.world_concept_clusters
              WHERE world_id = $1 AND canon_edition_id = $2
              ORDER BY CASE resolution_status WHEN 'ambiguous' THEN 0 WHEN 'proposed' THEN 1
                         WHEN 'candidate' THEN 2 ELSE 3 END,
                       score DESC, preferred_label
              LIMIT 1000`,
            [worldId, edition.id],
          ),
          db.query<Record<string, unknown>>(
            `SELECT hypothesis.*, source.name AS subject_name, target.name AS target_name
               FROM storyhold.world_relation_hypotheses hypothesis
               JOIN storyhold.world_entities source ON source.id = hypothesis.subject_entity_id
               JOIN storyhold.world_entities target ON target.id = hypothesis.target_entity_id
              WHERE hypothesis.world_id = $1 AND hypothesis.canon_edition_id = $2
              ORDER BY CASE hypothesis_status WHEN 'candidate' THEN 0 ELSE 1 END,
                       score DESC, source.name, target.name
              LIMIT 2000`,
            [worldId, edition.id],
          ),
          db.query<Record<string, unknown>>(
            `SELECT * FROM storyhold.world_owner_canon_constraints
              WHERE world_id = $1 AND canon_edition_id = $2 AND status = 'active'
              ORDER BY created_at ASC`,
            [worldId, edition.id],
          ),
          loadWorldAuthorStoryDraftAccess(db, {
            playerId: user.id,
            worldId,
          }),
          latestBrowserAudit(db, worldId, user.id),
        ],
      );
      const manuscriptAccess = summarizeAuthorManuscripts(sources.rows);
      const manuscriptWordCount =
        manuscriptAccess.qualifiedManuscriptWordCount;
      const hasStoryDraft = authorDraftAccess.rows.some(
        storyDraftUnlocksAuthorMode,
      );
      const serializedSources = sources.rows.map(serializeSource);
      const customerFunding = await customerPremiumRunFunding(
        db,
        runs.rows[0],
        user.id,
      );
      const serializedRun = serializeRun(runs.rows[0]
        ? {
            ...runs.rows[0],
            customer_top_up_credits_needed:
              customerFunding?.topUpCreditsNeeded ?? 0,
          }
        : undefined);
      const aiRuntime = getAiRuntimeStatus();
      const premiumAiRuntime = getAiRuntimeStatus(
        "canon_review",
        "standard",
        "verification",
      );
      res.json({
        world: serializeWorld({
          ...(world as unknown as Record<string, unknown>),
          ...(worldStats.rows[0] ?? {}),
        }),
        edition: {
          id: edition.id,
          canonicalKey: edition.canonical_key,
          name: edition.name,
          timelineAnchor: edition.timeline_anchor,
          status: edition.status,
          chronologyStatus: edition.chronology_status,
          chronologySummary: edition.chronology_summary,
          chronologyReviewedAt: edition.chronology_reviewed_at,
          createdAt: edition.created_at,
        },
        sources: serializedSources,
        breakdown: serializeBreakdown(breakdowns.rows[0]),
        latestRun: serializedRun,
        latestBrowserAudit: browserAudit,
        intakePipeline: worldIntakePipelineState({
          sources: serializedSources.map((source) => ({
            processingStatus: String(source.processingStatus ?? ""),
            chunkCount: Number(source.chunkCount ?? 0),
            localScanStatus: String(source.localScanStatus ?? "pending"),
            aiReviewStatus: String(source.aiReviewStatus ?? "waiting"),
          })),
          latestRun: serializedRun ? {
            status: String(serializedRun.status ?? ""),
            analysisKind: String(serializedRun.analysisKind ?? "local_scan"),
            progress: Number(serializedRun.progress ?? 0),
            stage: serializedRun.stage ? String(serializedRun.stage) : null,
            error: serializedRun.error ? String(serializedRun.error) : null,
            localCheckpointStage: serializedRun.localCheckpointStage
              ? String(serializedRun.localCheckpointStage)
              : null,
            premiumResumeStatus: String(serializedRun.premiumResumeStatus),
          } : null,
          browserAudit,
          aiConfigured: premiumAiRuntime.configured,
        }),
        characterDrafts: drafts.rows.map(serializeDraft),
        characterDossiers: dossiers.rows.map(serializeDossier),
        entities: entities.rows.filter(entityIsCustomerVisible).map((row) =>
          serializeWorldEntity(
            row,
            entityMemberships.rows.filter(
              (membership) => membership.entity_id === row.id,
            ),
          ),
        ),
        entityRelations: entityRelations.rows.map(serializeEntityRelation),
        entityRules: entityRules.rows.map(serializeEntityRule),
        entityActions: entityActions.rows.map(serializeEntityAction),
        conceptClusters: conceptClusters.rows.map(serializeStoryConceptCluster),
        relationshipHypotheses: relationHypotheses.rows.map(serializeStoryRelationHypothesis),
        canonConstraints: canonConstraints.rows.map(serializeOwnerConstraint),
        qualityFindings: qualityFindings.rows.map(serializeQualityFinding),
        externalReferences: referenceSources.rows.map(serializeReferenceSource),
        referenceResearch: {
          configured: isStoryholdLoreSearchConfigured(),
          provider: user.role === "owner" || user.role === "admin"
            ? isStoryholdLoreSearchConfigured() ? "perplexity" : null
            : null,
        },
        authorModeAccess: {
          eligible: authorModeIsEligible(manuscriptWordCount, hasStoryDraft),
          manuscriptWordCount,
          uploadedManuscriptWordCount:
            manuscriptAccess.uploadedManuscriptWordCount,
          qualifiedSourceCount: manuscriptAccess.qualifiedSourceCount,
          rejectedSourceCount: manuscriptAccess.rejectedSourceCount,
          sourceAssessments: manuscriptAccess.assessments,
          requiredManuscriptWords: AUTHOR_MODE_MIN_MANUSCRIPT_WORDS,
          requiredStoryDraftWords: AUTHOR_STORY_DRAFT_MIN_WORDS,
          requiredStoryDraftTurns: AUTHOR_STORY_DRAFT_MIN_TURNS,
          unlockedBy:
            manuscriptWordCount >= AUTHOR_MODE_MIN_MANUSCRIPT_WORDS
              ? "manuscript"
              : hasStoryDraft
                ? "story_draft"
                : null,
        },
        cohesionProposals: proposals.rows.map(serializeCohesionProposal),
        discrepancyReports: discrepancyReports.rows.map(
          serializeDiscrepancyReport,
        ),
        canonAmendments: amendments.rows.map(serializeCanonAmendment),
        campaigns: campaigns.rows.map(serializeCampaign),
        worldClockEvents: worldEvents.rows.map((event) =>
          serializeClockEvent(event, worldEventRelations.rows)),
        chapterSummaries: chapterSummaries.rows.map((row) => ({
          ...serializeChapterSummary(row),
          sourceTitle: row.source_title,
          sourceChronologyLabel: row.source_chronology_label ?? "",
          sourceChronologyOrder: Number(row.source_chronology_order ?? 0),
        })),
        canonicalCharacters: characters.rows.map((row) => ({
          id: row.id,
          canonicalKey: row.canonical_key,
          name: row.name,
          initialProfile: row.initial_profile,
          lockedAt: row.profile_locked_at,
          createdAt: row.created_at,
        })),
        ai: customerAiRuntimeStatus(aiRuntime, user.role),
        premiumAi: customerAiRuntimeStatus(premiumAiRuntime, user.role),
      });
    },
  );

  app.delete(
    "/api/storyhold/worlds/:worldId",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      if (!assertUuid(worldId, res)) return;
      const user = currentUser(req);
      const confirmationName = textBody(req.body?.confirmationName, 240);
      const world = await ownedWorld(db, worldId, user.id);
      if (!world) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      if (confirmationName !== world.name) {
        res.status(400).json({ error: "Type the world name exactly to confirm deletion." });
        return;
      }
      const busy = await db.query<{ busy: boolean }>(
        `SELECT (
          EXISTS (
            SELECT 1 FROM storyhold.world_analysis_runs
             WHERE world_id = $1 AND status IN ('queued', 'running', 'paused')
          ) OR EXISTS (
            SELECT 1 FROM storyhold.campaign_turn_requests request
            JOIN storyhold.campaigns campaign ON campaign.id = request.campaign_id
             WHERE campaign.world_id = $1 AND request.status IN ('prepared', 'generating')
          ) OR EXISTS (
            SELECT 1 FROM storyhold.credit_reservations
             WHERE world_id = $1 AND status = 'reserved'
          )
        ) AS busy`,
        [worldId],
      );
      if (activeRuns.has(worldId) || busy.rows[0]?.busy || await premiumReviewReconciliationPending(db, worldId)) {
        res.status(409).json({
          error: "Storyhold is still processing this world. Wait for the active reading or turn to finish, then delete it.",
        });
        return;
      }
      const scheduled = automaticAnalysisTimers.get(worldId);
      if (scheduled) {
        clearTimeout(scheduled);
        automaticAnalysisTimers.delete(worldId);
      }
      const deleted = await db.transaction(async (tx) => {
        const locked = await tx.query<{ id: string; name: string }>(
          `SELECT id, name FROM storyhold.worlds
            WHERE id = $1 AND owner_player_id = $2
            FOR UPDATE`,
          [worldId, user.id],
        );
        if (!locked.rows[0] || locked.rows[0].name !== confirmationName) return null;
        // Resume and operator finalization also take this world lock. Recheck
        // after acquiring it so a stale preflight cannot delete active billing.
        const stillBusy = await tx.query<{ busy: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM storyhold.world_analysis_runs
              WHERE world_id = $1 AND status IN ('queued', 'running', 'paused')
           ) OR EXISTS (
             SELECT 1 FROM storyhold.credit_reservations
              WHERE world_id = $1 AND status = 'reserved'
           ) OR EXISTS (
             SELECT 1 FROM storyhold.campaign_turn_requests request
             JOIN storyhold.campaigns campaign ON campaign.id = request.campaign_id
              WHERE campaign.world_id = $1 AND request.status IN ('prepared', 'generating')
           ) AS busy`,
          [worldId],
        );
        if (activeRuns.has(worldId) || stillBusy.rows[0]?.busy || await premiumReviewReconciliationPending(tx, worldId)) {
          return { busy: true as const };
        }
        await tx.query(
          "DELETE FROM storyhold.worlds WHERE id = $1 AND owner_player_id = $2",
          [worldId, user.id],
        );
        return locked.rows[0];
      });
      if (!deleted) {
        res.status(409).json({ error: "The world changed before deletion could be confirmed." });
        return;
      }
      if ("busy" in deleted) {
        res.status(409).json({ error: "This world has active or interrupted work. Finish that work or contact support before deleting the world." });
        return;
      }
      let filesRemoved = true;
      try {
        const uploadDirectory = worldUploadDirectoryForDeletion(storageRoot, worldId);
        await rm(uploadDirectory, { recursive: true, force: true });
      } catch (error) {
        filesRemoved = false;
        process.stderr.write(
          `Storyhold deleted world ${worldId}, but could not remove its upload directory: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      res.json({ deleted: true, worldId, name: deleted.name, filesRemoved });
    },
  );

  app.get(
    "/api/storyhold/worlds/:worldId/characters/:characterId",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      const characterId = routeParam(req, "characterId");
      if (!assertUuid(worldId, res) || !assertUuid(characterId, res)) return;
      const user = currentUser(req);
      const world = await ownedWorld(db, worldId, user.id);
      if (!world) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await defaultEdition(db, worldId);
      if (!edition) {
        res.status(409).json({ error: "This world does not have a canon edition." });
        return;
      }
      await ensureWorldEntities(db, worldId, edition.id);
      const [dossierResult, allDossiers, availableEntities, entityRelations] = await Promise.all([
        db.query<Record<string, unknown>>(
          `SELECT dossier.*,
                  (SELECT entity.id
                     FROM storyhold.world_entities entity
                    WHERE entity.dossier_id = dossier.id
                      AND entity.world_id = dossier.world_id
                      AND entity.canon_edition_id = dossier.canon_edition_id
                    ORDER BY (entity.pull_status = 'active') DESC,
                             entity.scanner_present DESC,
                             entity.updated_at DESC
                    LIMIT 1) AS hold_entity_id,
                  (SELECT entity.mention_count
                     FROM storyhold.world_entities entity
                    WHERE entity.dossier_id = dossier.id
                      AND entity.world_id = dossier.world_id
                      AND entity.canon_edition_id = dossier.canon_edition_id
                    ORDER BY (entity.pull_status = 'active') DESC,
                             entity.scanner_present DESC,
                             entity.updated_at DESC
                    LIMIT 1) AS hold_mention_count,
                  (SELECT entity.mention_source_count
                     FROM storyhold.world_entities entity
                    WHERE entity.dossier_id = dossier.id
                      AND entity.world_id = dossier.world_id
                      AND entity.canon_edition_id = dossier.canon_edition_id
                    ORDER BY (entity.pull_status = 'active') DESC,
                             entity.scanner_present DESC,
                             entity.updated_at DESC
                    LIMIT 1) AS hold_mention_source_count
             FROM storyhold.character_dossiers dossier
           WHERE dossier.id = $1 AND dossier.world_id = $2 AND dossier.canon_edition_id = $3
              AND dossier.dossier_status = 'active'
            LIMIT 1`,
          [characterId, worldId, edition.id],
        ),
        db.query<Record<string, unknown>>(
          `SELECT dossier.id, dossier.name, dossier.aliases
             FROM storyhold.character_dossiers dossier
            WHERE dossier.world_id = $1 AND dossier.canon_edition_id = $2
              AND dossier.dossier_status = 'active'`,
          [worldId, edition.id],
        ),
        db.query<Record<string, unknown>>(
          `SELECT * FROM storyhold.world_entities
            WHERE world_id = $1 AND canon_edition_id = $2
              AND pull_status = 'active'
              AND (scanner_present = true OR classification_source = 'user')
            ORDER BY entity_type, name`,
          [worldId, edition.id],
        ),
        db.query<Record<string, unknown>>(
          `SELECT relation.*,
                  source.name AS source_name, source.entity_type AS source_type,
                  target.name AS target_name, target.entity_type AS target_type
             FROM storyhold.world_entity_relations relation
             JOIN storyhold.world_entities source ON source.id = relation.source_entity_id
             JOIN storyhold.world_entities target ON target.id = relation.target_entity_id
            WHERE relation.world_id = $1 AND relation.canon_edition_id = $2
              AND relation.assignment_source <> 'local'
              AND source.pull_status = 'active' AND target.pull_status = 'active'
              AND (relation.source_entity_id = (
                    SELECT id FROM storyhold.world_entities WHERE dossier_id = $3 LIMIT 1
                  ) OR relation.target_entity_id = (
                    SELECT id FROM storyhold.world_entities WHERE dossier_id = $3 LIMIT 1
                  ))
            ORDER BY relation.relation_type, source.name, target.name`,
          [worldId, edition.id, characterId],
        ),
      ]);
      const row = dossierResult.rows[0];
      if (!row) {
        res.status(404).json({ error: "Character not found in this Hold." });
        return;
      }
      const serialized = serializeDossier(row);
      const names = new Map<string, string>();
      for (const candidate of allDossiers.rows) {
        const candidateId = String(candidate.id);
        const candidateNames = [candidate.name, ...(Array.isArray(candidate.aliases) ? candidate.aliases : [])];
        for (const candidateName of candidateNames) {
          const normalized = textBody(candidateName, 240).toLocaleLowerCase();
          if (normalized) names.set(normalized, candidateId);
        }
      }
      const relationshipWeb = serialized.profile.relationshipWeb.map((relationship) => ({
        ...relationship,
        relatedCharacterId: names.get(relationship.name.toLocaleLowerCase()) ?? null,
      }));
      const proseReview = typeof row.hold_entity_id === "string"
        ? await readEntityProseStatus(db, {
            playerId: user.id, worldId, editionId: edition.id, entityId: row.hold_entity_id,
          }, {
            aliases: serialized.aliases, summary: serialized.summary, details: [],
            character: { aliases: serialized.aliases, summary: serialized.summary,
              role: serialized.role, profile: serialized.profile },
            authorControlled: dossierIsCustomerEdited(row),
          }, {
            details: [], character: { aliases: row.aliases, summary: row.summary,
              role: row.role, profile: row.profile },
          })
        : { fields: [] };
      const compassReview = typeof row.hold_entity_id === "string"
        ? await readEntityCompassStatus(db, { playerId: user.id, worldId, editionId: edition.id, entityId: row.hold_entity_id })
        : { status: "not_reviewed" as const, evidence: [] };
      res.json({
        world: { id: world.id, name: world.name },
        compassReview,
        proseReview,
        character: {
          ...serialized,
          profile: { ...serialized.profile, relationshipWeb },
        },
        hold: {
          entityId: String(row.hold_entity_id),
          entities: availableEntities.rows.map((entity) => serializeWorldEntity(entity, [])),
          relations: entityRelations.rows.map(serializeEntityRelation),
        },
      });
    },
  );

  app.patch(
    "/api/storyhold/worlds/:worldId/characters/:characterId",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      const characterId = routeParam(req, "characterId");
      if (!assertUuid(worldId, res) || !assertUuid(characterId, res)) return;
      const user = currentUser(req);
      if (!(await ownedWorld(db, worldId, user.id))) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await defaultEdition(db, worldId);
      if (!edition) {
        res.status(409).json({ error: "This world does not have a canon edition." });
        return;
      }
      await ensureCharacterDossiersForWorld(db, worldId, edition.id);
      const body = recordBody(req.body);
      const currentResult = await db.query<Record<string, unknown>>(
        `SELECT * FROM storyhold.character_dossiers
          WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3
            AND dossier_status = 'active'
          LIMIT 1`,
        [characterId, worldId, edition.id],
      );
      const current = currentResult.rows[0];
      if (!current) {
        res.status(404).json({ error: "Character not found in this Storyhold." });
        return;
      }
      const aliases = dossierStrings(Object.hasOwn(body, "aliases") ? body.aliases : current.aliases);
      const role = Object.hasOwn(body, "role") ? textBody(body.role, 240) : current.role;
      const summary = Object.hasOwn(body, "summary") ? textBody(body.summary, 4_000) : current.summary;
      // PATCH replaces supplied fields only. Opening/saving a short edit must
      // not erase omitted sections, nor compact a complete existing profile.
      const profile = normalizedDossierProfile({ ...recordBody(current.profile), ...recordBody(body.profile) });
      const updated = await db.query<Record<string, unknown>>(
      `UPDATE storyhold.character_dossiers
            SET aliases = $4::jsonb, role = $5, summary = $6,
                profile = $7::jsonb, user_edited_at = now(), updated_at = now()
          WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3
          RETURNING *`,
        [characterId, worldId, edition.id, json(aliases), role, summary, json(profile)],
      );
      await db.query(
        `UPDATE storyhold.world_entities
            SET aliases = $2::jsonb, summary = $3,
                details = $4::jsonb, relationships = $5::jsonb,
                classification_source = 'user', review_status = 'user_confirmed',
                updated_at = now()
          WHERE dossier_id = $1 AND world_id = $6 AND canon_edition_id = $7`,
        [
          characterId, json(aliases), summary,
          json([...profile.traits, ...profile.physicalCharacteristics, ...profile.capabilities]),
          json(profile.relationships), worldId, edition.id,
        ],
      );
      await refreshCanonicalMentionCounts({
        db,
        worldId,
        editionId: edition.id,
      });
      await db.query("UPDATE storyhold.worlds SET updated_at = now() WHERE id = $1", [worldId]);
      res.json({ character: serializeDossier(updated.rows[0] ?? current) });
    },
  );

  app.put(
    "/api/storyhold/worlds/:worldId/characters/:characterId/socio-political-axis",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      const characterId = routeParam(req, "characterId");
      if (!assertUuid(worldId, res) || !assertUuid(characterId, res)) return;
      const user = currentUser(req);
      const world = await ownedWorld(db, worldId, user.id);
      if (!world) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await defaultEdition(db, worldId);
      if (!edition) {
        res.status(409).json({ error: "This world does not have a canon edition." });
        return;
      }
      await ensureCharacterDossiersForWorld(db, worldId, edition.id);
      const body = recordBody(req.body);
      const economic = Number(body.economic);
      const authority = Number(body.authority);
      if (!Number.isFinite(economic) || !Number.isFinite(authority)) {
        res.status(400).json({ error: "Both axis positions are required." });
        return;
      }
      const override = dossierAxis({
        economic,
        authority,
        label: textBody(body.label, 120) || "Player-corrected position",
        rationale:
          textBody(body.rationale, 1_000) ||
          "Confirmed by the world owner.",
        confidence: 1,
      });
      const updated = await db.query<Record<string, unknown>>(
        `UPDATE storyhold.character_dossiers
            SET axis_user_override = $4::jsonb,
                axis_user_changed_at = now(),
                updated_at = now()
          WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3
            AND dossier_status = 'active'
          RETURNING *`,
        [characterId, worldId, edition.id, json(override)],
      );
      if (!updated.rows[0]) {
        res.status(404).json({ error: "Character not found in this Hold." });
        return;
      }
      res.json({ character: serializeDossier(updated.rows[0]) });
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/entities",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      if (!assertUuid(worldId, res)) return;
      const user = currentUser(req);
      if (!(await ownedWorld(db, worldId, user.id))) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await defaultEdition(db, worldId);
      if (!edition) {
        res.status(409).json({ error: "This world does not have a canon edition." });
        return;
      }
      const body = recordBody(req.body);
      const name = textBody(body.name, 240);
      const entityType = textBody(body.entityType, 30) as EntityType;
      const summary = textBody(body.summary, 4_000);
      const aliases = stringList(body.aliases, 30, 240)
        .filter((alias) => alias.toLocaleLowerCase() !== name.toLocaleLowerCase());
      if (!name) {
        res.status(400).json({ error: "Give this Hold record a name." });
        return;
      }
      if (!ENTITY_TYPES.has(entityType) || entityType === "ambiguous") {
        res.status(400).json({
          error: "Choose a valid Storyhold category.",
        });
        return;
      }
      const normalizedName = name.toLocaleLowerCase();
      const existing = await db.query<Record<string, unknown>>(
        `SELECT * FROM storyhold.world_entities
          WHERE world_id = $1 AND canon_edition_id = $2 AND normalized_name = $3
          LIMIT 1`,
        [worldId, edition.id, normalizedName],
      );
      if (existing.rows[0]) {
        res.status(409).json({
          error: `${name} is already in this Hold. Open that record to edit, merge, restore, or reclassify it.`,
        });
        return;
      }
      const entityId = randomUUID();
      const inserted = await db.query<Record<string, unknown>>(
        `INSERT INTO storyhold.world_entities
          (id, world_id, canon_edition_id, canonical_key, normalized_name,
           name, entity_type, aliases, summary, confidence,
           classification_source, review_status, pull_status, scanner_present)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 1,
                 'user', 'user_confirmed', 'active', true)
         RETURNING *`,
        [
          entityId,
          worldId,
          edition.id,
          `${slug(name)}-${entityId.slice(0, 8)}`,
          normalizedName,
          name,
          entityType,
          json(aliases),
          summary,
        ],
      );
      const entity = inserted.rows[0];
      if (!entity) {
        res.status(500).json({ error: "The Hold record could not be created." });
        return;
      }
      if (entityType === "character") {
        await ensureEntityCharacterDossier(db, {
          worldId,
          editionId: edition.id,
          entity,
        });
      }
      await refreshCanonicalMentionCounts({
        db,
        worldId,
        editionId: edition.id,
      });
      await db.query(
        "UPDATE storyhold.worlds SET updated_at = now() WHERE id = $1",
        [worldId],
      );
      res.status(201).json({ entity: serializeWorldEntity(entity, []) });
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/entities/:entityId/ai-review/quote",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      const entityId = routeParam(req, "entityId");
      if (!assertUuid(worldId, res) || !assertUuid(entityId, res)) return;
      const user = currentUser(req);
      const world = await ownedWorld(db, worldId, user.id);
      if (!world) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await entityReviewEdition(db, worldId, entityId);
      if (!edition) {
        res.status(409).json({ error: "This world does not have a canon edition." });
        return;
      }
      const depth: EntityReviewDepth = req.body?.depth === "full" ? "full" : "focused";
      const userGuidance = textBody(req.body?.guidance, 2_000);
      const quoteId = randomUUID();
      try {
        const pending = await findPendingEntityReviewCall(db, {
          playerId: user.id, worldId, editionId: edition.id, entityId,
        });
        if (pending) {
          const saved = restoreEntityReviewContext(pending.context_snapshot);
          const pageProgress = saved.input.graphReview?.version === 2 && pending.status === "dispatched"
            ? await readEntityReviewPageProgress(db, { reviewId: pending.review_id, playerId: user.id, worldId, editionId: edition.id, entityId }) : null;
          if (!pageProgress?.canResume && (!["completed", "rejected"].includes(pending.status)
            || !pending.billable_attempts.length || pending.billable_attempts.some((attempt) => attempt.usage.pricingKnown !== true))) {
            res.status(409).json({ error: "Your earlier review is still running or its outcome needs to be checked. Another paid review will not start until that is resolved." });
            return;
          }
          const account = await db.query<{ credits: number }>("SELECT credits FROM storyhold.players WHERE id = $1", [user.id]);
          const availableCredits = Number(account.rows[0]?.credits ?? 0);
          const funding = savedEntityReviewFundingStatus(pending, availableCredits);
          res.json({ quoteId: pending.review_id, depth: saved.input.depth, guidance: saved.input.userGuidance ?? "",
            resume: true,
            // The original hold is already paid for. For a completed response,
            // this is only the additional post-run amount due beyond that hold.
            requiredCredits: funding?.additionalCreditsDue ?? 0,
            availableCredits,
            unlimited: pending.unlimited,
            settlementReady: funding?.settlementReady ?? true,
            topUpCreditsNeeded: funding?.topUpCreditsNeeded ?? 0,
            remainingPages: pageProgress ? pageProgress.totalPages - pageProgress.completedPages : 0,
            passageCount: saved.input.chunks.length, sourceCount: new Set(saved.input.chunks.map((chunk) => chunk.sourceId)).size,
            executionMode: "connected", entityType: saved.input.entity.entityType, selectedPassages: saved.selectedPassages,
            ...(saved.retrievalExpansion ? { retrievalExpansion: saved.retrievalExpansion.summary } : {}) });
          return;
        }
        const runtime = getAiRuntimeStatus("canon_review", "standard", "dossier");
        const context = await entityReviewContext({
          db, playerId: user.id, world, editionId: edition.id, entityId, depth, userGuidance, reviewId: quoteId, includeGraphReview: runtime.configured,
        });
        if (!context.input.chunks.length) {
          res.status(409).json({
            error: `Storyhold could not find a source passage that mentions ${context.input.entity.name}. Add source material or fill this dossier manually instead.`,
          });
          return;
        }
        const executionMode = runtime.configured ? "connected" : "local_qwen";
        const requiredCredits = runtime.configured
          ? creditsForReservationQuote(quoteEntityReviewReservation(context.input))
          : browserQwenUsageCredits(browserEntityReviewUsage(context));
        const account = await db.query<{ role: string; credits: number }>(
          "SELECT role, credits FROM storyhold.players WHERE id = $1 LIMIT 1",
          [user.id],
        );
        const role = account.rows[0]?.role ?? user.role;
        const unlimited = role === "owner" || role === "admin";
        res.json({
          quoteId,
          depth,
          requiredCredits: unlimited ? 0 : requiredCredits,
          availableCredits: Number(account.rows[0]?.credits ?? 0),
          unlimited,
          passageCount: context.input.chunks.length,
          sourceCount: new Set(context.input.chunks.map((chunk) => chunk.sourceId)).size,
          executionMode,
          entityType: context.input.entity.entityType,
          selectedPassages: context.selectedPassages,
          ...(context.retrievalExpansion ? { retrievalExpansion: context.retrievalExpansion.summary } : {}),
        });
      } catch (error) {
        const message = entityReviewPublicError(error);
        res.status(error instanceof CreditEconomyError || error instanceof EntityReviewJournalError ? 409 : 500).json({ error: message });
      }
    },
  );

  app.get(
    "/api/storyhold/worlds/:worldId/canon-constraints",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      if (!assertUuid(worldId, res)) return;
      const user = currentUser(req);
      if (!(await ownedWorld(db, worldId, user.id))) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await defaultEdition(db, worldId);
      if (!edition) {
        res.status(409).json({ error: "This world does not have a canon edition." });
        return;
      }
      const entityId = typeof req.query.entityId === "string" && UUID_PATTERN.test(req.query.entityId)
        ? req.query.entityId : null;
      const constraints = await loadOwnerCanonConstraints({
        db,
        worldId,
        editionId: edition.id,
        entityId,
        includeWorld: true,
      });
      res.json({ constraints });
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/canon-constraints/:constraintId/dismiss",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      const constraintId = routeParam(req, "constraintId");
      if (!assertUuid(worldId, res) || !assertUuid(constraintId, res)) return;
      const user = currentUser(req);
      if (!(await ownedWorld(db, worldId, user.id))) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await defaultEdition(db, worldId);
      if (!edition) {
        res.status(409).json({ error: "This world does not have a canon edition." });
        return;
      }
      const dismissed = await db.query<Record<string, unknown>>(
        `UPDATE storyhold.world_owner_canon_constraints
            SET status = 'dismissed', updated_at = now()
          WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3
            AND status = 'active'
          RETURNING *`,
        [constraintId, worldId, edition.id],
      );
      if (!dismissed.rows[0]) {
        res.status(404).json({ error: "Canon direction not found." });
        return;
      }
      await syncWorldConceptGraph({ db, worldId, editionId: edition.id });
      res.json({ constraint: serializeOwnerConstraint(dismissed.rows[0]) });
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/entities/:entityId/ai-review",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      const entityId = routeParam(req, "entityId");
      if (!assertUuid(worldId, res) || !assertUuid(entityId, res)) return;
      const quoteId = textBody(req.body?.quoteId, 80);
      if (!UUID_PATTERN.test(quoteId)) {
        res.status(400).json({ error: "Open the credit confirmation before starting this review." });
        return;
      }
      const approvedCredits = Number(req.body?.approvedCredits);
      if (!Number.isFinite(approvedCredits) || approvedCredits < 0) {
        res.status(400).json({ error: "The approved Storyhold credit amount is missing." });
        return;
      }
      const depth: EntityReviewDepth = req.body?.depth === "full" ? "full" : "focused";
      const userGuidance = textBody(req.body?.guidance, 2_000);
      const user = currentUser(req);
      const world = await ownedWorld(db, worldId, user.id);
      if (!world) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await entityReviewEdition(db, worldId, entityId);
      if (!edition) {
        res.status(409).json({ error: "This world does not have a canon edition." });
        return;
      }
      let reservation: CreditReservation | null = null;
      const callScope: EntityReviewCallScope = { reviewId: quoteId, playerId: user.id, worldId, editionId: edition.id, entityId };
      let paidDispatchPossible = false;
      try {
        const previous = await readEntityReviewCall(db, callScope);
        if (previous) {
          paidDispatchPossible = true;
          if (previous.finalization_snapshot) {
            res.status(previous.finalization_snapshot.reviewed ? 200 : 409).json(previous.finalization_snapshot);
            return;
          }
          const frozen = restoreEntityReviewContext(previous.context_snapshot);
          if (frozen.input.depth !== depth || (frozen.input.userGuidance ?? "") !== userGuidance) {
            res.status(409).json({ error: "This saved review uses its original directions. Reopen Review This Dossier to resume it before starting a different review." });
            return;
          }
          await continueSavedEntityReviewPages(db, callScope);
          const outcome = await finishSavedEntityReview(db, callScope);
          res.status(outcome.reviewed ? 200 : 409).json(outcome);
          return;
        }
        if (await findPendingEntityReviewCall(db, callScope)) {
          res.status(409).json({ error: "An earlier paid review needs to finish first. Reopen Review This Dossier to continue it." });
          return;
        }
        const runtime = getAiRuntimeStatus("canon_review", "standard", "dossier");
        let context = await entityReviewContext({
          db, playerId: user.id, world, editionId: edition.id, entityId, depth, userGuidance, reviewId: quoteId, includeGraphReview: runtime.configured,
        });
        const suppliedBrowserAudit = recordBody(req.body?.browserAssist);
        const browserReviewJson = textBody(suppliedBrowserAudit.reviewJson, 120_000);
        const browserModel = textBody(suppliedBrowserAudit.model, 200) || "Qwen browser dossier reviewer";
        context.input.browserAuditContext = Object.keys(suppliedBrowserAudit).length
          ? json({
              model: textBody(suppliedBrowserAudit.model, 160),
              identityChecks: stringList(suppliedBrowserAudit.identityChecks, 20, 320),
              aliasCandidates: stringList(suppliedBrowserAudit.aliasCandidates, 20, 320),
              relationshipChecks: stringList(suppliedBrowserAudit.relationshipChecks, 20, 320),
              abilityChecks: stringList(suppliedBrowserAudit.abilityChecks, 20, 320),
              chronologyChecks: stringList(suppliedBrowserAudit.chronologyChecks, 20, 320),
              contradictions: stringList(suppliedBrowserAudit.contradictions, 20, 320),
              missingQueries: stringList(suppliedBrowserAudit.missingQueries, 20, 320),
            })
          : "";
        if (!context.input.chunks.length) {
          res.status(409).json({ error: "No matching source passages remain available for this dossier review." });
          return;
        }
        const browserUsage = browserEntityReviewUsage(context, {
          inputTokens: suppliedBrowserAudit.inputTokens,
          outputTokens: suppliedBrowserAudit.outputTokens,
          reviewJson: browserReviewJson,
        });
        const requiredCredits = runtime.configured
          ? creditsForReservationQuote(quoteEntityReviewReservation(context.input))
          : browserQwenUsageCredits(browserEntityReviewUsage(context));
        const account = await db.query<{ role: string; credits: number }>(
          "SELECT role, credits FROM storyhold.players WHERE id = $1 LIMIT 1",
          [user.id],
        );
        const unlimited = ["owner", "admin"].includes(account.rows[0]?.role ?? user.role);
        if (!unlimited && requiredCredits > Math.floor(approvedCredits)) {
          res.status(409).json({
            error: "The source context changed and this review now needs a new credit confirmation.",
            requiredCredits,
          });
          return;
        }
        reservation = await reserveCredits(db, {
          playerId: user.id,
          worldId,
          operation: "entity_review",
          requestId: quoteId,
          requiredCredits,
          expiresInMinutes: 60,
          metadata: {
            entityId,
            entityName: context.input.entity.name,
            depth,
            passageCount: context.input.chunks.length,
            guidancePresent: Boolean(userGuidance),
            executionMode: runtime.configured ? "connected" : "local_qwen",
          },
        });
        await saveOwnerCanonConstraint({
          db,
          worldId,
          editionId: edition.id,
          playerId: user.id,
          entityId,
          instruction: userGuidance,
        });
        await enforceOwnerCanonConstraints({
          db,
          worldId,
          editionId: edition.id,
          entityId,
        });
        if (runtime.configured) {
          // Guidance may alter canonical classifications. Freeze the actual
          // post-guidance input and story state together, not the older quote.
          const browserAuditContext = context.input.browserAuditContext;
          const snapshot = await db.transaction(async (tx) => {
            const currentWorld = (await tx.query<{ id: string; name: string; premise: string; genre: string }>(
              "SELECT id, name, premise, genre FROM storyhold.worlds WHERE id = $1 FOR SHARE", [worldId],
            )).rows[0];
            if (!currentWorld) throw new Error("This world is no longer available.");
            context = await entityReviewContext({ db: tx, playerId: user.id, world: currentWorld, editionId: edition.id, entityId,
              depth, userGuidance, reviewId: quoteId, includeGraphReview: true });
            context.input.browserAuditContext = browserAuditContext;
            const fingerprint = await entityReviewCanonFingerprint(tx, callScope, context.input.chunks.map((chunk) => chunk.id), false, context.input.proseReview ? 2 : 1);
            return frozenEntityReviewContext(context, fingerprint);
          });
          const finalRequiredCredits = creditsForReservationQuote(quoteEntityReviewReservation(context.input));
          if (!unlimited && finalRequiredCredits > requiredCredits) {
            const accountAfterReservation = await db.query<{ credits: number }>(
              "SELECT credits FROM storyhold.players WHERE id = $1 LIMIT 1",
              [user.id],
            );
            const availableForSettlement = requiredCredits +
              Number(accountAfterReservation.rows[0]?.credits ?? 0);
            if (finalRequiredCredits > availableForSettlement) {
              throw new CreditEconomyError(
                "INSUFFICIENT_CREDITS",
                "The final dossier review estimate exceeds the held credits and remaining balance.",
                finalRequiredCredits,
                availableForSettlement,
              );
            }
          }
          await reviewEntity(context.input, { executePages: (preparedPages) => executeJournaledEntityReviewPages(db, {
            scope: callScope, reservationId: reservation?.id ?? null, contextSnapshot: snapshot,
            pages: preparedPages.map((page) => ({ stepKey: page.stepKey, request: page.request, provider: runtime.provider, model: runtime.model })),
            beforePage: async (page, index) => {
              const currentRuntime = getAiRuntimeStatus("canon_review", "standard", "dossier");
              if (!currentRuntime.configured || currentRuntime.provider !== page.provider || currentRuntime.model !== page.model) {
                throw new Error("The original AI connection is unavailable. Completed review pages are saved for resume.");
              }
              if (index > 0 && await entityReviewCanonFingerprint(db, callScope, context.input.chunks.map((chunk) => chunk.id), false, context.input.proseReview ? 2 : 1) !== snapshot.canonFingerprint) {
                throw new Error("Your canon or manuscript changed during this review. Further paid reading is stopped; completed work is saved.");
              }
            },
            invoke: (page) => { paidDispatchPossible = true; return generateAiText(page.request); },
          }), execute: (request) => executeJournaledEntityReviewCall(db, {
            scope: callScope, reservationId: reservation?.id ?? null, contextSnapshot: snapshot,
            request, provider: runtime.provider, model: runtime.model, invoke: () => {
              paidDispatchPossible = true;
              return generateAiText(request);
            },
          }) });
          const outcome = await finishSavedEntityReview(db, callScope);
          res.status(outcome.reviewed ? 200 : 409).json(outcome);
          return;
        }
        const activeReservation = reservation;
        const reviewed = browserReviewJson
            ? reviewEntityFromBrowser(context.input, {
                text: browserReviewJson,
                model: browserModel,
                inputTokens: browserUsage.inputTokens,
                outputTokens: browserUsage.outputTokens,
              })
            : await reviewEntityLocally(context.input);
        const fixedBrowserCredits = Math.min(requiredCredits, browserQwenUsageCredits(browserUsage));
        let creditsUsed = 0;
        let creditsRemaining = Number(account.rows[0]?.credits ?? 0);
        await db.transaction(async (tx) => {
          await saveEntityReview({
            db: tx,
            worldId,
            editionId: edition.id,
            context,
            finding: reviewed.finding,
            reviewMode: "local",
          });
          await refreshCanonicalMentionCounts({
            db: tx,
            worldId,
            editionId: edition.id,
          });
          if (activeReservation.id) {
            const settlement = await settleFixedCreditReservationInTransaction(tx, {
                  reservationId: activeReservation.id,
                  fixedCredits: fixedBrowserCredits,
                  usage: reviewed.result.usage,
                  provider: reviewed.result.provider,
                  model: reviewed.result.model,
                  reasoning: reviewed.result.reasoning,
                  metadata: { pricingVersion: BROWSER_QWEN_PRICING_VERSION },
                });
            creditsUsed = settlement.creditsUsed;
            creditsRemaining = settlement.creditsRemaining;
          }
          await tx.query(
            `INSERT INTO storyhold.ai_usage_ledger
              (id, player_id, world_id, campaign_id, operation, provider, model,
               input_units, output_units, cached_input_units, cache_write_input_units,
               reasoning_units, cost_micros, cache_hit, pricing_version,
               credits_charged, request_id, metadata)
             VALUES ($1, $2, $3, NULL, 'entity_review', $4, $5, $6, $7, $8,
                     $9, $10, $11, $12, $13, $14, $15, $16::jsonb)`,
            [
              randomUUID(), user.id, worldId, reviewed.result.provider,
              reviewed.result.model, reviewed.result.usage.inputUnits,
              reviewed.result.usage.outputUnits, reviewed.result.usage.cachedInputUnits,
              reviewed.result.usage.cacheWriteInputUnits,
              reviewed.result.usage.reasoningUnits,
              reviewed.result.usage.estimatedCostMicros,
              reviewed.result.usage.cachedInputUnits > 0,
              reviewed.result.usage.pricingVersion, creditsUsed, quoteId,
              json({ entityId, depth, passageCount: context.input.chunks.length }),
            ],
          );
        });
        res.json({
          reviewed: true,
          entityId,
          depth,
          creditsUsed,
          creditsRemaining,
          unlimited: reservation.unlimited,
          passageCount: context.input.chunks.length,
        });
      } catch (error) {
        console.error("Storyhold entity dossier review failed", {
          worldId,
          entityId,
          depth,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        // A saved paid call owns its hold. Never turn a transport timeout, save
        // failure, or failed journal read into an automatic refund/re-dispatch.
        try {
          const saved = await readEntityReviewCall(db, callScope);
          if (saved) {
            if (saved.finalization_snapshot) {
              res.status(saved.finalization_snapshot.reviewed ? 200 : 409).json(saved.finalization_snapshot);
              return;
            }
            if (["completed", "rejected"].includes(saved.status)) {
              const account = await db.query<{ credits: number }>(
                "SELECT credits FROM storyhold.players WHERE id = $1 LIMIT 1",
                [user.id],
              );
              const funding = savedEntityReviewFundingStatus(
                saved,
                Number(account.rows[0]?.credits ?? 0),
              );
              if (funding && !funding.settlementReady) {
                res.status(402).json({
                  code: "CREDITS_NEEDED_TO_FINISH",
                  error: `The review is finished and saved. Add ${funding.topUpCreditsNeeded.toLocaleString("en-US")} more credit${funding.topUpCreditsNeeded === 1 ? "" : "s"}, then resume to apply it without another AI request.`,
                  resume: true,
                  settlementReady: false,
                  topUpCreditsNeeded: funding.topUpCreditsNeeded,
                });
                return;
              }
            }
            if (saved.status === "rejected") {
              const outcome = await finishSavedEntityReview(db, callScope);
              res.status(409).json(outcome);
              return;
            }
            res.status(409).json({ error: error instanceof EntityReviewAccountingError
              ? "Your review response is saved, but it needs a final safety check before it can finish. Your held credits remain protected, and no new paid request will start automatically."
              : saved.status === "completed"
              ? "Your review response is saved, but its update could not be completed. Reopen Review This Dossier to resume it without another AI request."
              : "Your review is still running or its outcome needs to be checked. Any reserved credits are being held; another paid request will not be sent automatically." });
            return;
          }
          if (paidDispatchPossible) {
            res.status(409).json({ error: "Storyhold could not locate this review's saved outcome. Any reserved credits remain held while it is checked; no new paid request will start automatically." });
            return;
          }
        } catch (recoveryError) {
          if (paidDispatchPossible || recoveryError instanceof EntityReviewJournalError) {
            res.status(409).json({ error: "Storyhold could not confirm this review's saved outcome. Any reserved credits remain held while it is checked; no new paid request will start automatically." });
            return;
          }
        }
        await releaseCreditReservation(
          db,
          reservation?.id ?? null,
          error instanceof Error ? error.message : "entity review failed",
        ).catch(() => undefined);
        if (error instanceof CreditEconomyError) {
          res.status(error.code === "INSUFFICIENT_CREDITS" ? 402 : 409).json({
            error: error.code === "INSUFFICIENT_CREDITS"
              ? "This review needs more credits before it can start. No credits were used."
              : error.message,
          });
          return;
        }
        res.status(500).json({ error: entityReviewPublicError(error) });
      }
    },
  );

  app.get(
    "/api/storyhold/worlds/:worldId/entities/:entityId/prose-review",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      const entityId = routeParam(req, "entityId");
      if (!assertUuid(worldId, res) || !assertUuid(entityId, res)) return;
      const user = currentUser(req);
      if (!(await ownedWorld(db, worldId, user.id))) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await defaultEdition(db, worldId);
      if (!edition) {
        res.status(409).json({ error: "This world does not have a canon edition." });
        return;
      }
      const row = (await db.query<Record<string, unknown>>(
        `SELECT * FROM storyhold.world_entities
          WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3
            AND pull_status = 'active' AND merged_into_entity_id IS NULL`,
        [entityId, worldId, edition.id],
      )).rows[0];
      if (!row) {
        res.status(404).json({ error: "This dossier is not available." });
        return;
      }
      const serialized = serializeWorldEntity(row, []);
      const proseReview = await readEntityProseStatus(db, {
        playerId: user.id, worldId, editionId: edition.id, entityId,
      }, {
        aliases: serialized.aliases, summary: serialized.summary, details: serialized.details, relationships: serialized.relationships,
        authorControlled: row.classification_source === "user" || row.review_status === "user_confirmed",
      }, {
        aliases: row.aliases, summary: row.summary, details: row.details, relationships: row.relationships,
      });
      res.json(proseReview);
    },
  );

  app.patch(
    "/api/storyhold/worlds/:worldId/entities/:entityId",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      const entityId = routeParam(req, "entityId");
      if (!assertUuid(worldId, res) || !assertUuid(entityId, res)) return;
      const user = currentUser(req);
      const world = await ownedWorld(db, worldId, user.id);
      if (!world) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await defaultEdition(db, worldId);
      if (!edition) {
        res.status(409).json({ error: "This world does not have a canon edition." });
        return;
      }
      const body = recordBody(req.body);
      const requestedType = textBody(body.entityType, 30);
      const requestedPull = textBody(body.pullStatus, 30);
      const hasName = Object.prototype.hasOwnProperty.call(body, "name");
      const hasAliases = Object.prototype.hasOwnProperty.call(body, "aliases");
      const hasSummary = Object.prototype.hasOwnProperty.call(body, "summary");
      const hasDetails = Object.prototype.hasOwnProperty.call(body, "details");
      const requestedName = textBody(body.name, 240);
      const requestedAliases = dossierStrings(body.aliases)
        .filter((alias) => alias.toLocaleLowerCase() !== requestedName.toLocaleLowerCase());
      const requestedSummary = textBody(body.summary, 4_000);
      const requestedDetails = dossierStrings(body.details);
      if (requestedType && !ENTITY_TYPES.has(requestedType)) {
        res.status(400).json({ error: "Choose a valid Hold category." });
        return;
      }
      if (requestedPull && !["active", "do_not_pull"].includes(requestedPull)) {
        res.status(400).json({ error: "Choose a valid visibility state." });
        return;
      }
      if (hasName && !requestedName) {
        res.status(400).json({ error: "A Hold card cannot have an empty name." });
        return;
      }
      if (!requestedType && !requestedPull && !hasName && !hasAliases && !hasSummary && !hasDetails) {
        res.status(400).json({ error: "No entity change was supplied." });
        return;
      }
      if (hasName) {
        const duplicate = await db.query<{ found: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM storyhold.world_entities
              WHERE world_id = $1 AND canon_edition_id = $2 AND id <> $3
                AND normalized_name = $4
           ) AS found`,
          [worldId, edition.id, entityId, requestedName.toLocaleLowerCase()],
        );
        if (duplicate.rows[0]?.found) {
          res.status(409).json({ error: `${requestedName} already has a Hold card. Merge the records instead.` });
          return;
        }
      }
      const updated = await db.query<Record<string, unknown>>(
        `UPDATE storyhold.world_entities
            SET entity_type = CASE WHEN $4 <> '' THEN $4 ELSE entity_type END,
                classification_source = 'user',
                review_status = 'user_confirmed',
                pull_status = CASE WHEN $5 <> '' THEN $5 ELSE pull_status END,
                scanner_present = CASE WHEN $5 = 'active' THEN true ELSE scanner_present END,
                merged_into_entity_id = CASE WHEN $5 = 'active' THEN NULL ELSE merged_into_entity_id END,
                name = CASE WHEN $6 THEN $7 ELSE name END,
                normalized_name = CASE WHEN $6 THEN $8 ELSE normalized_name END,
                aliases = CASE WHEN $9 THEN $10::jsonb ELSE aliases END,
                summary = CASE WHEN $11 THEN $12 ELSE summary END,
                details = CASE WHEN $13 THEN $14::jsonb ELSE details END,
                updated_at = now()
          WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3
            AND pull_status <> 'merged'
          RETURNING *`,
        [
          entityId, worldId, edition.id, requestedType, requestedPull,
          hasName, requestedName, requestedName.toLocaleLowerCase(),
          hasAliases, json(requestedAliases), hasSummary, requestedSummary,
          hasDetails, json(requestedDetails),
        ],
      );
      if (!updated.rows[0]) {
        res.status(404).json({ error: "Entity not found in this Hold." });
        return;
      }
      const updatedEntity = updated.rows[0];
      const nextType = String(updatedEntity.entity_type);
      if (nextType === "character") {
        await ensureEntityCharacterDossier(db, {
          worldId,
          editionId: edition.id,
          entity: updatedEntity,
        });
      } else if (updatedEntity.dossier_id) {
        // A customer reclassification is authoritative. Keep the old dossier
        // data recoverable, but do not leave a character page active for a
        // term, reference, place, object, or other non-character entry.
        await db.query(
          `UPDATE storyhold.character_dossiers
              SET dossier_status = 'suppressed', updated_at = now()
            WHERE id = $1`,
          [updatedEntity.dossier_id],
        );
      }
      if (updatedEntity.dossier_id && (hasName || hasAliases || hasSummary)) {
        await db.query(
          `UPDATE storyhold.character_dossiers
              SET name = CASE WHEN $2 THEN $3 ELSE name END,
                  normalized_name = CASE WHEN $2 THEN $4 ELSE normalized_name END,
                  aliases = CASE WHEN $5 THEN $6::jsonb ELSE aliases END,
                  summary = CASE WHEN $7 THEN $8 ELSE summary END,
                  user_edited_at = now(),
                  updated_at = now()
            WHERE id = $1`,
          [
            updatedEntity.dossier_id, hasName, requestedName,
            requestedName.toLocaleLowerCase(), hasAliases, json(requestedAliases),
            hasSummary, requestedSummary,
          ],
        );
      }
      if (!new Set(["character", "creature"]).has(nextType)) {
        await db.query(
          `DELETE FROM storyhold.world_entity_faction_memberships WHERE entity_id = $1`,
          [entityId],
        );
      }
      if (nextType !== "faction") {
        await db.query(
          `DELETE FROM storyhold.world_entity_faction_memberships WHERE faction_entity_id = $1`,
          [entityId],
        );
      }
      await refreshCanonicalMentionCounts({
        db,
        worldId,
        editionId: edition.id,
      });
      await db.query("UPDATE storyhold.worlds SET updated_at = now() WHERE id = $1", [worldId]);
      res.json({ entity: serializeWorldEntity(updatedEntity, []) });
    },
  );

  app.delete(
    "/api/storyhold/worlds/:worldId/entities/:entityId",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      const entityId = routeParam(req, "entityId");
      if (!assertUuid(worldId, res) || !assertUuid(entityId, res)) return;
      const user = currentUser(req);
      const world = await ownedWorld(db, worldId, user.id);
      if (!world) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await defaultEdition(db, worldId);
      if (!edition) {
        res.status(409).json({ error: "This world does not have a canon edition." });
        return;
      }
      const deleted = await db.query<{ name: string; dossier_id: string | null }>(
        `UPDATE storyhold.world_entities
            SET pull_status = 'deleted', scanner_present = false,
                merged_into_entity_id = NULL, updated_at = now()
          WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3
            AND pull_status IN ('active', 'do_not_pull')
          RETURNING name, dossier_id`,
        [entityId, worldId, edition.id],
      );
      const entity = deleted.rows[0];
      if (!entity) {
        res.status(404).json({ error: "Hold card not found or already deleted." });
        return;
      }
      await Promise.all([
        db.query(
          `DELETE FROM storyhold.world_entity_relations
            WHERE world_id = $1 AND canon_edition_id = $2
              AND (source_entity_id = $3 OR target_entity_id = $3)`,
          [worldId, edition.id, entityId],
        ),
        db.query(
          `DELETE FROM storyhold.world_entity_rules
            WHERE world_id = $1 AND canon_edition_id = $2 AND entity_id = $3`,
          [worldId, edition.id, entityId],
        ),
        db.query(
          `DELETE FROM storyhold.world_entity_faction_memberships
            WHERE entity_id = $1 OR faction_entity_id = $1`,
          [entityId],
        ),
      ]);
      if (entity.dossier_id) {
        await db.query(
          `UPDATE storyhold.character_dossiers
              SET dossier_status = 'suppressed', updated_at = now()
            WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3`,
          [entity.dossier_id, worldId, edition.id],
        );
      }
      await refreshCanonicalMentionCounts({
        db,
        worldId,
        editionId: edition.id,
      });
      await db.query("UPDATE storyhold.worlds SET updated_at = now() WHERE id = $1", [worldId]);
      res.json({ deleted: true, name: entity.name });
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/entities/:entityId/factions/:factionId",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      const entityId = routeParam(req, "entityId");
      const factionId = routeParam(req, "factionId");
      if (
        !assertUuid(worldId, res) ||
        !assertUuid(entityId, res) ||
        !assertUuid(factionId, res)
      ) return;
      const user = currentUser(req);
      if (!(await ownedWorld(db, worldId, user.id))) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await defaultEdition(db, worldId);
      if (!edition) {
        res.status(409).json({ error: "This world does not have a canon edition." });
        return;
      }
      const rows = await db.query<Record<string, unknown>>(
        `SELECT id, entity_type, pull_status FROM storyhold.world_entities
          WHERE world_id = $1 AND canon_edition_id = $2 AND id IN ($3, $4)`,
        [worldId, edition.id, entityId, factionId],
      );
      const entity = rows.rows.find((row) => row.id === entityId);
      const faction = rows.rows.find((row) => row.id === factionId);
      if (
        !entity || !faction ||
        !["character", "creature"].includes(String(entity.entity_type)) ||
        faction.entity_type !== "faction" ||
        entity.pull_status !== "active" || faction.pull_status !== "active"
      ) {
        res.status(400).json({ error: "Only active characters or creatures can join an active faction." });
        return;
      }
      await db.query(
        `INSERT INTO storyhold.world_entity_faction_memberships
          (entity_id, faction_entity_id, assignment_source, confidence)
         VALUES ($1, $2, 'user', 1)
         ON CONFLICT (entity_id, faction_entity_id) DO UPDATE
           SET assignment_source = 'user', confidence = 1, updated_at = now()`,
        [entityId, factionId],
      );
      await db.query(
        `INSERT INTO storyhold.world_entity_relations
          (id, world_id, canon_edition_id, source_entity_id, relation_type,
           target_entity_id, relation_status, summary, assignment_source, confidence)
         VALUES ($1, $2, $3, $4, 'member_of', $5, 'active', '', 'user', 1)
         ON CONFLICT (world_id, canon_edition_id, source_entity_id, relation_type,
                      target_entity_id, relation_status, valid_from_label, valid_until_label)
         DO UPDATE SET assignment_source = 'user', confidence = 1, updated_at = now()`,
        [randomUUID(), worldId, edition.id, entityId, factionId],
      );
      res.status(201).json({ assigned: true });
    },
  );

  app.delete(
    "/api/storyhold/worlds/:worldId/entities/:entityId/factions/:factionId",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      const entityId = routeParam(req, "entityId");
      const factionId = routeParam(req, "factionId");
      if (
        !assertUuid(worldId, res) ||
        !assertUuid(entityId, res) ||
        !assertUuid(factionId, res)
      ) return;
      const user = currentUser(req);
      if (!(await ownedWorld(db, worldId, user.id))) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await defaultEdition(db, worldId);
      if (!edition) {
        res.status(409).json({ error: "This world does not have a canon edition." });
        return;
      }
      await db.query(
        `DELETE FROM storyhold.world_entity_faction_memberships membership
          USING storyhold.world_entities entity
          WHERE membership.entity_id = $1 AND membership.faction_entity_id = $2
            AND entity.id = membership.entity_id
            AND entity.world_id = $3 AND entity.canon_edition_id = $4`,
        [entityId, factionId, worldId, edition.id],
      );
      await db.query(
        `DELETE FROM storyhold.world_entity_relations
          WHERE world_id = $1 AND canon_edition_id = $2
            AND source_entity_id = $3 AND target_entity_id = $4
            AND relation_type = 'member_of'`,
        [worldId, edition.id, entityId, factionId],
      );
      res.status(204).end();
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/entities/:entityId/relations",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      const entityId = routeParam(req, "entityId");
      if (!assertUuid(worldId, res) || !assertUuid(entityId, res)) return;
      const user = currentUser(req);
      if (!(await ownedWorld(db, worldId, user.id))) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await defaultEdition(db, worldId);
      if (!edition) {
        res.status(409).json({ error: "This world does not have a canon edition." });
        return;
      }
      const body = recordBody(req.body);
      const targetEntityId = textBody(body.targetEntityId, 80);
      const relationType = textBody(body.relationType, 40) as EntityRelationType;
      const status = textBody(body.status, 30) || "active";
      if (!assertUuid(targetEntityId, res) || targetEntityId === entityId) return;
      if (!ENTITY_RELATION_TYPES.has(relationType) || !ENTITY_RELATION_STATUSES.has(status)) {
        res.status(400).json({ error: "Choose a valid relationship and status." });
        return;
      }
      const endpoints = await db.query<{ id: string }>(
        `SELECT id FROM storyhold.world_entities
          WHERE world_id = $1 AND canon_edition_id = $2
            AND pull_status = 'active' AND id IN ($3, $4)`,
        [worldId, edition.id, entityId, targetEntityId],
      );
      if (endpoints.rows.length !== 2) {
        res.status(400).json({ error: "Both Hold records must be active." });
        return;
      }
      const relationId = randomUUID();
      const inserted = await db.query<Record<string, unknown>>(
        `INSERT INTO storyhold.world_entity_relations
          (id, world_id, canon_edition_id, source_entity_id, relation_type,
           target_entity_id, relation_status, summary, valid_from_label,
           valid_until_label, assignment_source, confidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'user', 1)
         ON CONFLICT (world_id, canon_edition_id, source_entity_id, relation_type,
                      target_entity_id, relation_status, valid_from_label, valid_until_label)
         DO UPDATE SET summary = EXCLUDED.summary, assignment_source = 'user',
                       confidence = 1, updated_at = now()
         RETURNING *`,
        [
          relationId, worldId, edition.id, entityId, relationType, targetEntityId,
          status, textBody(body.summary, 1_200), textBody(body.validFromLabel, 240),
          textBody(body.validUntilLabel, 240),
        ],
      );
      res.status(201).json({ relation: serializeEntityRelation(inserted.rows[0] ?? {}) });
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/entity-relations/batch",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      if (!assertUuid(worldId, res)) return;
      const user = currentUser(req);
      const world = await ownedWorld(db, worldId, user.id);
      if (!world) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await defaultEdition(db, worldId);
      if (!edition) {
        res.status(409).json({ error: "This world does not have a canon edition." });
        return;
      }
      const body = recordBody(req.body);
      const rawConnections = Array.isArray(body.connections) ? body.connections : [];
      if (!rawConnections.length || rawConnections.length > 250) {
        res.status(400).json({ error: "Choose between 1 and 250 canonical connections." });
        return;
      }
      const connections = rawConnections.map((raw) => {
        const connection = recordBody(raw);
        return {
          id: randomUUID(),
          sourceEntityId: textBody(connection.sourceEntityId, 80),
          targetEntityId: textBody(connection.targetEntityId, 80),
          relationType: textBody(connection.relationType, 40) as EntityRelationType,
          status: textBody(connection.status, 30) || "active",
          summary: textBody(connection.summary, 1_200),
          validFromLabel: textBody(connection.validFromLabel, 240),
          validUntilLabel: textBody(connection.validUntilLabel, 240),
        };
      });
      for (const connection of connections) {
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(connection.sourceEntityId) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(connection.targetEntityId) ||
          connection.sourceEntityId === connection.targetEntityId ||
          !ENTITY_RELATION_TYPES.has(connection.relationType) ||
          !ENTITY_RELATION_STATUSES.has(connection.status)
        ) {
          res.status(400).json({ error: "One or more selected connections are invalid." });
          return;
        }
      }
      const endpointIds = [...new Set(connections.flatMap((connection) => [connection.sourceEntityId, connection.targetEntityId]))];
      const endpoints = await db.query<{ id: string }>(
        `SELECT id FROM storyhold.world_entities
          WHERE world_id = $1 AND canon_edition_id = $2
            AND pull_status = 'active' AND id = ANY($3::uuid[])`,
        [worldId, edition.id, endpointIds],
      );
      if (endpoints.rows.length !== endpointIds.length) {
        res.status(400).json({ error: "One or more selected Hold cards are unavailable." });
        return;
      }
      const inserted = await db.query<{ count: number }>(
        `WITH input AS (
           SELECT * FROM jsonb_to_recordset($3::jsonb) AS item(
             id uuid, "sourceEntityId" uuid, "relationType" text,
             "targetEntityId" uuid, status text, summary text,
             "validFromLabel" text, "validUntilLabel" text
           )
         ), changed AS (
           INSERT INTO storyhold.world_entity_relations
             (id, world_id, canon_edition_id, source_entity_id, relation_type,
              target_entity_id, relation_status, summary, valid_from_label,
              valid_until_label, evidence, assignment_source, confidence)
           SELECT id, $1, $2, "sourceEntityId", "relationType",
                  "targetEntityId", status, summary, "validFromLabel",
                  "validUntilLabel", '[]'::jsonb, 'user', 1
             FROM input
           ON CONFLICT (world_id, canon_edition_id, source_entity_id, relation_type,
                        target_entity_id, relation_status, valid_from_label, valid_until_label)
           DO UPDATE SET summary = EXCLUDED.summary, assignment_source = 'user',
                         confidence = 1, updated_at = now()
           RETURNING id
         )
         SELECT count(*)::int AS count FROM changed`,
        [worldId, edition.id, JSON.stringify(connections)],
      );
      res.status(201).json({ created: Number(inserted.rows[0]?.count ?? 0) });
    },
  );

  app.delete(
    "/api/storyhold/worlds/:worldId/entity-relations/:relationId",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      const relationId = routeParam(req, "relationId");
      if (!assertUuid(worldId, res) || !assertUuid(relationId, res)) return;
      const user = currentUser(req);
      if (!(await ownedWorld(db, worldId, user.id))) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      await db.query(
        `DELETE FROM storyhold.world_entity_relations WHERE id = $1 AND world_id = $2`,
        [relationId, worldId],
      );
      res.status(204).end();
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/entities/:entityId/rules",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      const entityId = routeParam(req, "entityId");
      if (!assertUuid(worldId, res) || !assertUuid(entityId, res)) return;
      const user = currentUser(req);
      if (!(await ownedWorld(db, worldId, user.id))) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await defaultEdition(db, worldId);
      if (!edition) {
        res.status(409).json({ error: "This world does not have a canon edition." });
        return;
      }
      const body = recordBody(req.body);
      const name = textBody(body.name, 240);
      const ruleKind = textBody(body.ruleKind, 30) || "trait";
      if (!name || !ENTITY_RULE_KINDS.has(ruleKind)) {
        res.status(400).json({ error: "Give this rule a name and valid kind." });
        return;
      }
      const entity = await db.query<{ id: string }>(
        `SELECT id FROM storyhold.world_entities
          WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3
            AND pull_status = 'active'`,
        [entityId, worldId, edition.id],
      );
      if (!entity.rows[0]) {
        res.status(404).json({ error: "Hold record not found." });
        return;
      }
      const ruleId = randomUUID();
      const inserted = await db.query<Record<string, unknown>>(
        `INSERT INTO storyhold.world_entity_rules
          (id, world_id, canon_edition_id, entity_id, canonical_key, name,
           description, rule_kind, trigger_text, effect_text,
           assignment_source, confidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'user', 1)
         RETURNING *`,
        [
          ruleId, worldId, edition.id, entityId,
          `rule-${slug(name)}-${ruleId.slice(0, 8)}`, name,
          textBody(body.description, 1_800), ruleKind,
          textBody(body.trigger, 800), textBody(body.effect, 800),
        ],
      );
      res.status(201).json({ rule: serializeEntityRule(inserted.rows[0] ?? {}) });
    },
  );

  app.delete(
    "/api/storyhold/worlds/:worldId/entity-rules/:ruleId",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      const ruleId = routeParam(req, "ruleId");
      if (!assertUuid(worldId, res) || !assertUuid(ruleId, res)) return;
      const user = currentUser(req);
      if (!(await ownedWorld(db, worldId, user.id))) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      await db.query(
        `DELETE FROM storyhold.world_entity_rules WHERE id = $1 AND world_id = $2`,
        [ruleId, worldId],
      );
      res.status(204).end();
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/entities/:entityId/merge",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      const sourceId = routeParam(req, "entityId");
      const targetId = textBody(req.body?.targetEntityId, 80);
      if (
        !assertUuid(worldId, res) ||
        !assertUuid(sourceId, res) ||
        !assertUuid(targetId, res)
      ) return;
      if (sourceId === targetId) {
        res.status(400).json({ error: "Choose a different entity to merge into." });
        return;
      }
      const user = currentUser(req);
      if (!(await ownedWorld(db, worldId, user.id))) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await defaultEdition(db, worldId);
      if (!edition) {
        res.status(409).json({ error: "This world does not have a canon edition." });
        return;
      }
      const entityRows = await db.query<Record<string, unknown>>(
        `SELECT * FROM storyhold.world_entities
          WHERE world_id = $1 AND canon_edition_id = $2 AND id IN ($3, $4)`,
        [worldId, edition.id, sourceId, targetId],
      );
      const source = entityRows.rows.find((row) => row.id === sourceId);
      const target = entityRows.rows.find((row) => row.id === targetId);
      if (!source || !target || source.pull_status === "merged" || target.pull_status === "merged") {
        res.status(404).json({ error: "Both merge records must still be active in this Hold." });
        return;
      }
      const membershipRows = await db.query<Record<string, unknown>>(
        `SELECT * FROM storyhold.world_entity_faction_memberships
          WHERE entity_id IN ($1, $2) OR faction_entity_id IN ($1, $2)`,
        [sourceId, targetId],
      );
      const relationRows = await db.query<Record<string, unknown>>(
        `SELECT * FROM storyhold.world_entity_relations
          WHERE source_entity_id IN ($1, $2) OR target_entity_id IN ($1, $2)`,
        [sourceId, targetId],
      );
      const ruleRows = await db.query<Record<string, unknown>>(
        `SELECT * FROM storyhold.world_entity_rules WHERE entity_id IN ($1, $2)`,
        [sourceId, targetId],
      );
      const actionId = randomUUID();
      const aliases = mergeEntityStrings(target.aliases, [source.name], source.aliases);
      const details = mergeEntityStrings(target.details, source.details);
      const relationships = mergeEntityStrings(target.relationships, source.relationships);
      const evidence = mergeEntityEvidence(target.evidence, source.evidence);
      const summary = textBody(target.summary, 4_000) || textBody(source.summary, 4_000);
      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO storyhold.world_entity_actions
            (id, world_id, canon_edition_id, performed_by_player_id, action_type, summary, payload)
           VALUES ($1, $2, $3, $4, 'merge', $5, $6::jsonb)`,
          [
            actionId,
            worldId,
            edition.id,
            user.id,
            `Merged ${String(source.name)} into ${String(target.name)}`,
            json({
              source,
              target,
              memberships: membershipRows.rows,
              relations: relationRows.rows,
              rules: ruleRows.rows,
            }),
          ],
        );
        await tx.query(
          `UPDATE storyhold.world_entities
              SET aliases = $2::jsonb, summary = $3, details = $4::jsonb,
                  relationships = $5::jsonb, evidence = $6::jsonb,
                  mention_count = mention_count + $7,
                  mention_source_count = GREATEST(mention_source_count, $8),
                  confidence = GREATEST(confidence, $9),
                  classification_source = 'user', review_status = 'user_confirmed',
                  scanner_present = true, updated_at = now()
            WHERE id = $1`,
          [
            targetId,
            json(aliases),
            summary,
            json(details),
            json(relationships),
            json(evidence),
            Number(source.mention_count ?? 0),
            Number(source.mention_source_count ?? 0),
            Number(source.confidence ?? 0),
          ],
        );
        await tx.query(
          `UPDATE storyhold.world_entities
              SET pull_status = 'merged', merged_into_entity_id = $2, updated_at = now()
            WHERE id = $1`,
          [sourceId, targetId],
        );
        if (["character", "creature"].includes(String(target.entity_type))) {
          await tx.query(
            `INSERT INTO storyhold.world_entity_faction_memberships
              (entity_id, faction_entity_id, assignment_source, confidence, evidence)
             SELECT $2, faction_entity_id, assignment_source, confidence, evidence
               FROM storyhold.world_entity_faction_memberships
              WHERE entity_id = $1 AND faction_entity_id <> $2
             ON CONFLICT (entity_id, faction_entity_id) DO NOTHING`,
            [sourceId, targetId],
          );
        }
        if (target.entity_type === "faction") {
          await tx.query(
            `INSERT INTO storyhold.world_entity_faction_memberships
              (entity_id, faction_entity_id, assignment_source, confidence, evidence)
             SELECT entity_id, $2, assignment_source, confidence, evidence
               FROM storyhold.world_entity_faction_memberships
              WHERE faction_entity_id = $1 AND entity_id <> $2
             ON CONFLICT (entity_id, faction_entity_id) DO NOTHING`,
            [sourceId, targetId],
          );
        }
        await tx.query(
          `DELETE FROM storyhold.world_entity_faction_memberships
            WHERE entity_id = $1 OR faction_entity_id = $1`,
          [sourceId],
        );
        for (const relation of relationRows.rows) {
          if (relation.source_entity_id !== sourceId && relation.target_entity_id !== sourceId) continue;
          const nextSourceId = relation.source_entity_id === sourceId ? targetId : relation.source_entity_id;
          const nextTargetId = relation.target_entity_id === sourceId ? targetId : relation.target_entity_id;
          if (nextSourceId !== nextTargetId) {
            await tx.query(
              `INSERT INTO storyhold.world_entity_relations
                (id, world_id, canon_edition_id, source_entity_id, relation_type,
                 target_entity_id, relation_status, summary, valid_from_label,
                 valid_until_label, evidence, assignment_source, confidence)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
               ON CONFLICT (world_id, canon_edition_id, source_entity_id, relation_type,
                            target_entity_id, relation_status, valid_from_label, valid_until_label)
               DO NOTHING`,
              [
                randomUUID(), worldId, edition.id, nextSourceId,
                relation.relation_type, nextTargetId, relation.relation_status,
                relation.summary ?? "", relation.valid_from_label ?? "",
                relation.valid_until_label ?? "", json(relation.evidence ?? []),
                relation.assignment_source, Number(relation.confidence ?? 0.5),
              ],
            );
          }
        }
        await tx.query(
          `DELETE FROM storyhold.world_entity_relations
            WHERE source_entity_id = $1 OR target_entity_id = $1`,
          [sourceId],
        );
        for (const rule of ruleRows.rows.filter((candidate) => candidate.entity_id === sourceId)) {
          await tx.query(
            `INSERT INTO storyhold.world_entity_rules
              (id, world_id, canon_edition_id, entity_id, canonical_key, name,
               description, rule_kind, trigger_text, effect_text, evidence,
               assignment_source, confidence, rule_status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14)
             ON CONFLICT (world_id, canon_edition_id, entity_id, canonical_key) DO NOTHING`,
            [
              randomUUID(), worldId, edition.id, targetId, rule.canonical_key,
              rule.name, rule.description ?? "", rule.rule_kind,
              rule.trigger_text ?? "", rule.effect_text ?? "",
              json(rule.evidence ?? []), rule.assignment_source,
              Number(rule.confidence ?? 0.5), rule.rule_status,
            ],
          );
        }
        await tx.query("DELETE FROM storyhold.world_entity_rules WHERE entity_id = $1", [sourceId]);
        if (typeof target.dossier_id === "string") {
          await tx.query(
            `UPDATE storyhold.character_dossiers SET aliases = $2::jsonb, updated_at = now() WHERE id = $1`,
            [target.dossier_id, json(aliases)],
          );
        }
        await refreshCanonicalMentionCounts({
          db: tx,
          worldId,
          editionId: edition.id,
        });
        await tx.query("UPDATE storyhold.worlds SET updated_at = now() WHERE id = $1", [worldId]);
      });
      res.status(201).json({ actionId, summary: `Merged ${String(source.name)} into ${String(target.name)}.` });
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/entity-actions/:actionId/undo",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      const actionId = routeParam(req, "actionId");
      if (!assertUuid(worldId, res) || !assertUuid(actionId, res)) return;
      const user = currentUser(req);
      if (!(await ownedWorld(db, worldId, user.id))) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await defaultEdition(db, worldId);
      if (!edition) {
        res.status(409).json({ error: "This world does not have a canon edition." });
        return;
      }
      const actionResult = await db.query<Record<string, unknown>>(
        `SELECT * FROM storyhold.world_entity_actions
          WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3
            AND action_type = 'merge' AND undone_at IS NULL LIMIT 1`,
        [actionId, worldId, edition.id],
      );
      const action = actionResult.rows[0];
      if (!action) {
        res.status(404).json({ error: "That merge is no longer available to undo." });
        return;
      }
      const payload = recordBody(action.payload);
      const source = recordBody(payload.source);
      const target = recordBody(payload.target);
      const sourceId = textBody(source.id, 80);
      const targetId = textBody(target.id, 80);
      if (!UUID_PATTERN.test(sourceId) || !UUID_PATTERN.test(targetId)) {
        res.status(409).json({ error: "The saved merge history is incomplete." });
        return;
      }
      const newer = await db.query<{ found: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM storyhold.world_entity_actions
            WHERE world_id = $1 AND canon_edition_id = $2 AND undone_at IS NULL
              AND created_at > $3
              AND (payload->'source'->>'id' IN ($4, $5)
                OR payload->'target'->>'id' IN ($4, $5))
         ) AS found`,
        [worldId, edition.id, action.created_at, sourceId, targetId],
      );
      if (newer.rows[0]?.found) {
        res.status(409).json({ error: "Undo the newer merge involving these records first." });
        return;
      }
      const restoreEntity = async (
        transactionDb: StudioDb,
        row: Record<string, unknown>,
      ) => {
        await transactionDb.query(
          `UPDATE storyhold.world_entities
              SET dossier_id = $2, source_analysis_run_id = $3, canonical_key = $4,
                  normalized_name = $5, name = $6, entity_type = $7, aliases = $8::jsonb,
                  summary = $9, details = $10::jsonb, relationships = $11::jsonb,
                  evidence = $12::jsonb, mention_count = $13, mention_source_count = $14,
                  confidence = $15, classification_source = $16, review_status = $17,
                  pull_status = $18, merged_into_entity_id = $19,
                  scanner_present = $20, updated_at = now()
            WHERE id = $1`,
          [
            row.id, row.dossier_id ?? null, row.source_analysis_run_id ?? null,
            row.canonical_key, row.normalized_name, row.name, row.entity_type,
            json(row.aliases ?? []), row.summary ?? "", json(row.details ?? []),
            json(row.relationships ?? []), json(row.evidence ?? []),
            Number(row.mention_count ?? 0), Number(row.mention_source_count ?? 0),
            Number(row.confidence ?? 0), row.classification_source, row.review_status,
            row.pull_status, row.merged_into_entity_id ?? null,
            row.scanner_present !== false,
          ],
        );
      };
      await db.transaction(async (tx) => {
        await restoreEntity(tx, source);
        await restoreEntity(tx, target);
        await tx.query(
          `DELETE FROM storyhold.world_entity_faction_memberships
            WHERE entity_id IN ($1, $2) OR faction_entity_id IN ($1, $2)`,
          [sourceId, targetId],
        );
        await tx.query(
          `DELETE FROM storyhold.world_entity_relations
            WHERE source_entity_id IN ($1, $2) OR target_entity_id IN ($1, $2)`,
          [sourceId, targetId],
        );
        await tx.query(
          `DELETE FROM storyhold.world_entity_rules WHERE entity_id IN ($1, $2)`,
          [sourceId, targetId],
        );
        if (Array.isArray(payload.memberships)) {
          for (const rawMembership of payload.memberships) {
            const membership = recordBody(rawMembership);
            await tx.query(
              `INSERT INTO storyhold.world_entity_faction_memberships
                (entity_id, faction_entity_id, assignment_source, confidence, evidence)
               VALUES ($1, $2, $3, $4, $5::jsonb)
               ON CONFLICT (entity_id, faction_entity_id) DO UPDATE
                 SET assignment_source = EXCLUDED.assignment_source,
                     confidence = EXCLUDED.confidence, evidence = EXCLUDED.evidence,
                     updated_at = now()`,
              [
                membership.entity_id,
                membership.faction_entity_id,
                membership.assignment_source,
                Number(membership.confidence ?? 0.5),
                json(membership.evidence ?? []),
              ],
            );
          }
        }
        if (Array.isArray(payload.relations)) {
          for (const rawRelation of payload.relations) {
            const relation = recordBody(rawRelation);
            await tx.query(
              `INSERT INTO storyhold.world_entity_relations
                (id, world_id, canon_edition_id, source_entity_id, relation_type,
                 target_entity_id, relation_status, summary, valid_from_label,
                 valid_until_label, evidence, assignment_source, confidence)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)`,
              [
                relation.id, worldId, edition.id, relation.source_entity_id,
                relation.relation_type, relation.target_entity_id,
                relation.relation_status, relation.summary ?? "",
                relation.valid_from_label ?? "", relation.valid_until_label ?? "",
                json(relation.evidence ?? []), relation.assignment_source,
                Number(relation.confidence ?? 0.5),
              ],
            );
          }
        }
        if (Array.isArray(payload.rules)) {
          for (const rawRule of payload.rules) {
            const rule = recordBody(rawRule);
            await tx.query(
              `INSERT INTO storyhold.world_entity_rules
                (id, world_id, canon_edition_id, entity_id, canonical_key, name,
                 description, rule_kind, trigger_text, effect_text, evidence,
                 assignment_source, confidence, rule_status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14)`,
              [
                rule.id, worldId, edition.id, rule.entity_id, rule.canonical_key,
                rule.name, rule.description ?? "", rule.rule_kind,
                rule.trigger_text ?? "", rule.effect_text ?? "",
                json(rule.evidence ?? []), rule.assignment_source,
                Number(rule.confidence ?? 0.5), rule.rule_status,
              ],
            );
          }
        }
        if (typeof target.dossier_id === "string") {
          await tx.query(
            `UPDATE storyhold.character_dossiers SET aliases = $2::jsonb, updated_at = now() WHERE id = $1`,
            [target.dossier_id, json(target.aliases ?? [])],
          );
        }
        await refreshCanonicalMentionCounts({
          db: tx,
          worldId,
          editionId: edition.id,
        });
        await tx.query(
          `UPDATE storyhold.world_entity_actions
              SET undone_at = now(), undone_by_player_id = $2 WHERE id = $1`,
          [actionId, user.id],
        );
        await tx.query("UPDATE storyhold.worlds SET updated_at = now() WHERE id = $1", [worldId]);
      });
      res.json({ undone: true });
    },
  );

  app.put(
    "/api/storyhold/worlds/:worldId/contract",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      if (!assertUuid(worldId, res)) return;
      const user = currentUser(req);
      const world = await ownedWorld(db, worldId, user.id);
      if (!world) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const contract = contractForNewWorld({
        value: req.body?.worldContract,
        premise: world.premise,
        genre: world.genre,
      });
      const resolutionMode = RESOLUTION_MODES.has(
        String(req.body?.resolutionMode),
      )
        ? String(req.body.resolutionMode)
        : world.resolution_mode;
      const contentSettings = cleanContentSettings(
        req.body?.contentSettings ?? world.content_settings,
      );
      if (contentSettings.sexualContent === "explicit") {
        const preferences = await db.query<{ adult_enabled: boolean }>(
          "SELECT adult_enabled FROM storyhold.player_story_preferences WHERE player_id = $1 LIMIT 1",
          [user.id],
        );
        if (!preferences.rows[0]?.adult_enabled) {
          res.status(400).json({
            error: "Enable adult mode in your profile before using explicit content in a world.",
          });
          return;
        }
      }
      const clockName =
        textBody(req.body?.worldClockName, 80) || world.world_clock_name;
      const contractStatus = req.body?.lock === true ? "locked" : "draft";
      await db.query(
        `UPDATE storyhold.worlds
            SET world_contract = $2::jsonb,
                resolution_mode = $3,
                content_settings = $4::jsonb,
                world_clock_name = $5,
                contract_status = $6,
                updated_at = now()
          WHERE id = $1`,
        [
          worldId,
          json(contract),
          resolutionMode,
          json(contentSettings),
          clockName,
          contractStatus,
        ],
      );
      res.json({
        worldContract: contract,
        contractStatus,
        resolutionMode,
        contentSettings,
        worldClockName: clockName,
      });
    },
  );

  app.put(
    "/api/storyhold/worlds/:worldId/chronology",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      if (!assertUuid(worldId, res)) return;
      const user = currentUser(req);
      const world = await ownedWorld(db, worldId, user.id);
      if (!world) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await defaultEdition(db, worldId);
      if (!edition) {
        res.status(409).json({ error: "This world has no working canon." });
        return;
      }
      const requested: unknown[] = Array.isArray(req.body?.sources)
        ? (req.body.sources as unknown[])
        : [];
      if (requested.length === 0) {
        res.status(400).json({ error: "Include at least one source in the chronology." });
        return;
      }
      if (requested.length > 5_000) {
        res.status(413).json({
          error:
            "A single chronology update can contain up to 5,000 sources. Split a larger library into separate worlds or editions.",
        });
        return;
      }
      const items = requested.map((value: unknown, index: number) => {
        const item = recordBody(value);
        const sourceId = textBody(item.sourceId, 60);
        const sourceKind = SOURCE_KINDS.has(String(item.sourceKind))
          ? String(item.sourceKind)
          : "manuscript";
        const relation = CHRONOLOGY_RELATIONS.has(String(item.relation))
          ? String(item.relation)
          : index === 0
            ? "origin"
            : "continues";
        return {
          sourceId,
          sourceKind,
          relation,
          order: index,
          label: textBody(item.label, 240),
          notes: textBody(item.notes, 1_000),
        };
      });
      if (items.some((item) => !UUID_PATTERN.test(item.sourceId))) {
        res.status(400).json({ error: "One of the source IDs is invalid." });
        return;
      }
      const existing = await db.query<{ id: string }>(
        `SELECT id FROM storyhold.world_sources
          WHERE world_id = $1 AND canon_edition_id = $2`,
        [worldId, edition.id],
      );
      const allowed = new Set(existing.rows.map((row) => row.id));
      if (items.some((item) => !allowed.has(item.sourceId))) {
        res.status(400).json({
          error: "The chronology contains a source that does not belong to this world.",
        });
        return;
      }
      const summary = textBody(req.body?.summary, 2_000);
      await db.transaction(async (tx) => {
        for (const item of items) {
          await tx.query(
            `UPDATE storyhold.world_sources
                SET chronology_order = $2, chronology_relation = $3,
                    chronology_label = $4, chronology_notes = $5,
                    source_kind = $6, chronology_review_status = 'reviewed'
              WHERE id = $1`,
            [
              item.sourceId,
              item.order,
              item.relation,
              item.label,
              item.notes,
              item.sourceKind,
            ],
          );
        }
        await tx.query(
          `UPDATE storyhold.canon_editions
              SET chronology_status = 'reviewed', chronology_summary = $2,
                  chronology_reviewed_at = now()
            WHERE id = $1`,
          [edition.id, summary],
        );
        await tx.query(
          "UPDATE storyhold.worlds SET updated_at = now() WHERE id = $1",
          [worldId],
        );
      });
      const saved = await db.query<Record<string, unknown>>(
        `SELECT * FROM storyhold.world_sources
          WHERE world_id = $1 AND canon_edition_id = $2
          ORDER BY chronology_order ASC, sort_order ASC`,
        [worldId, edition.id],
      );
      res.json({
        chronologyStatus: "reviewed",
        chronologySummary: summary,
        sources: saved.rows.map(serializeSource),
      });
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/campaigns",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      if (!assertUuid(worldId, res)) return;
      const user = currentUser(req);
      const world = await ownedWorld(db, worldId, user.id);
      if (!world) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await defaultEdition(db, worldId);
      if (!edition) {
        res.status(409).json({ error: "This world has no working canon." });
        return;
      }
      const [manuscriptSources, storyDraftAccess] = await Promise.all([
        db.query<Record<string, unknown>>(
          `SELECT id, title, extracted_text, word_count, processing_status,
                  source_kind, canon_status
             FROM storyhold.world_sources
            WHERE world_id = $1 AND canon_edition_id = $2
              AND processing_status = 'ready' AND source_kind = 'manuscript'
              AND canon_status <> 'reference'`,
          [worldId, edition.id],
        ),
        loadWorldAuthorStoryDraftAccess(db, {
          playerId: user.id,
          worldId,
        }),
      ]);
      const manuscriptAccess = summarizeAuthorManuscripts(
        manuscriptSources.rows,
      );
      const hasManuscriptCanonSources = manuscriptSources.rows.some((source) =>
        source.processing_status === "ready" &&
        source.source_kind === "manuscript" &&
        (source.canon_status === "candidate" || source.canon_status === "canon")
      );
      const manuscriptWordCount =
        manuscriptAccess.qualifiedManuscriptWordCount;
      const authorModeEligible = authorModeIsEligible(
        manuscriptWordCount,
        storyDraftAccess.rows.some(storyDraftUnlocksAuthorMode),
      );
      const campaignId = randomUUID();
      const campaignName =
        textBody(req.body?.name, 140) || `${world.name} - New story`;
      let characterName = textBody(req.body?.characterName, 140);
      let characterConcept = textBody(req.body?.characterConcept, 3_000);
      const initialObjective = textBody(req.body?.initialObjective, 240);
      const requestedStartingPoint = textBody(req.body?.startingPoint, 3_000);
      const startingPoint =
        requestedStartingPoint ||
        textBody(recordBody(world.world_contract).startingPoint, 3_000) ||
        world.premise ||
        "The story begins.";
      const resolutionMode = RESOLUTION_MODES.has(
        String(req.body?.resolutionMode),
      )
        ? String(req.body.resolutionMode)
        : world.resolution_mode;
      const requestedExperienceMode = String(req.body?.experienceMode ?? "");
      const experienceMode = CAMPAIGN_EXPERIENCE_MODES.has(
        requestedExperienceMode,
      )
        ? requestedExperienceMode
        : world.creation_mode === "quickstart"
          ? "solo"
          : authorModeEligible
            ? "author"
            : "solo";
      if (experienceMode === "author" && !authorModeEligible) {
        res.status(403).json({
          error:
            "Author mode unlocks after Storyhold verifies at least 10,000 words of continuous story prose, or after you adapt a played campaign into prose.",
          code: "AUTHOR_MODE_LOCKED",
          manuscriptWordCount,
          uploadedManuscriptWordCount:
            manuscriptAccess.uploadedManuscriptWordCount,
          rejectedSources: manuscriptAccess.assessments.filter(
            (assessment) => !assessment.qualifies,
          ),
          requiredManuscriptWords: AUTHOR_MODE_MIN_MANUSCRIPT_WORDS,
          requiredStoryDraftWords: AUTHOR_STORY_DRAFT_MIN_WORDS,
          requiredStoryDraftTurns: AUTHOR_STORY_DRAFT_MIN_TURNS,
        });
        return;
      }
      const requestedCharacterId = textBody(req.body?.characterId, 60);
      const requestedWorldEntityId = textBody(req.body?.worldEntityId, 60);
      const createsFreeformCampaignCharacter =
        !requestedCharacterId && !requestedWorldEntityId;
      let characterId = requestedCharacterId;
      let characterAlreadyExists = false;
      let preferredEntityId: string | null = null;
      if (requestedWorldEntityId) {
        if (!UUID_PATTERN.test(requestedWorldEntityId)) {
          res.status(400).json({ error: "That Hold character ID is invalid." });
          return;
        }
        const selectedEntity = await db.query<Record<string, unknown>>(
          `SELECT entity.*, dossier.canonical_character_id
             FROM storyhold.world_entities entity
             LEFT JOIN storyhold.character_dossiers dossier ON dossier.id = entity.dossier_id
            WHERE entity.id = $1 AND entity.world_id = $2
              AND entity.canon_edition_id = $3 AND entity.entity_type = 'character'
              AND entity.pull_status = 'active'
            LIMIT 1`,
          [requestedWorldEntityId, worldId, edition.id],
        );
        const selected = selectedEntity.rows[0];
        if (!selected) {
          res.status(400).json({ error: "That character is not active in this Hold." });
          return;
        }
        preferredEntityId = requestedWorldEntityId;
        characterName = textBody(selected.name, 140) || characterName;
        characterConcept = characterConcept || textBody(selected.summary, 3_000);
        if (typeof selected.canonical_character_id === "string") {
          characterId = selected.canonical_character_id;
          characterAlreadyExists = true;
        }
      }
      if (characterId) {
        if (!UUID_PATTERN.test(characterId)) {
          res.status(400).json({ error: "That character ID is invalid." });
          return;
        }
        const existingCharacter = await findWorldCanonicalCharacter(db, {
          characterId,
          worldId,
        });
        if (!existingCharacter) {
          res.status(400).json({ error: "That character does not belong to this world." });
          return;
        }
        characterAlreadyExists = true;
        characterName = characterName || existingCharacter.name;
      } else {
        characterId = randomUUID();
      }
      characterName = characterName || `Unnamed character ${campaignId.slice(0, 4).toUpperCase()}`;
      const [sources, referenceWebsites, referenceUploads, worldModel, storyPreferences] = await Promise.all([
        db.query<{ id: string; content_hash: string }>(
          `SELECT id, content_hash FROM storyhold.world_sources
            WHERE world_id = $1 AND canon_edition_id = $2
              AND canon_status IN ('candidate', 'canon')
            ORDER BY chronology_order ASC, sort_order ASC`,
          [worldId, edition.id],
        ),
        db.query<{ id: string; content_hash: string | null }>(
          `SELECT id, content_hash
             FROM storyhold.world_reference_sources
            WHERE world_id = $1 AND canon_edition_id = $2
              AND review_status = 'approved' AND extraction_status <> 'failed'
            ORDER BY created_at ASC`,
          [worldId, edition.id],
        ),
        db.query<{ id: string; content_hash: string }>(
          `SELECT id, content_hash
             FROM storyhold.world_sources
            WHERE world_id = $1 AND canon_edition_id = $2
              AND processing_status = 'ready'
              AND (source_kind = 'reference' OR canon_status = 'reference')
            ORDER BY created_at ASC`,
          [worldId, edition.id],
        ),
        db.query<{ id: string; version: number }>(
          `SELECT id, version FROM storyhold.world_breakdowns
            WHERE world_id = $1 AND canon_edition_id = $2
            ORDER BY version DESC LIMIT 1`,
          [worldId, edition.id],
        ),
        db.query<Record<string, unknown>>(
          `SELECT adult_enabled, sexual_content_level, violence_level,
                  narrative_length
             FROM storyhold.player_story_preferences
            WHERE player_id = $1 LIMIT 1`,
          [user.id],
        ),
      ]);
      const requestedCanonAnchorEventId = textBody(req.body?.canonAnchorEventId, 60);
      const requestedCanonAnchorMode = req.body?.canonAnchorMode === "after"
        ? "after"
        : "before";
      let canonTimelineSnapshot: {
        anchorEventId: string;
        anchorEventTitle: string;
        anchorMode: "before" | "after";
        maximumChronologyOrder: number;
        eventCount: number;
        sha256: string;
      } | null = null;
      let canonTimelineRows: Record<string, unknown>[] = [];
      if (requestedCanonAnchorEventId) {
        if (!UUID_PATTERN.test(requestedCanonAnchorEventId)) {
          res.status(400).json({ error: "That canonical starting event is invalid." });
          return;
        }
        const anchorResult = await db.query<Record<string, unknown>>(
          `SELECT id, title, chronology_order
             FROM storyhold.world_clock_events
            WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3
              AND campaign_id IS NULL AND event_kind = 'canon'
              AND visibility = 'world'
            LIMIT 1`,
          [requestedCanonAnchorEventId, worldId, edition.id],
        );
        const anchor = anchorResult.rows[0];
        if (!anchor) {
          res.status(400).json({ error: "That canonical starting event is not part of this Hold." });
          return;
        }
        const anchorOrder = Number(anchor.chronology_order ?? 0);
        const maximumChronologyOrder =
          requestedCanonAnchorMode === "before" ? anchorOrder - 1 : anchorOrder;
        const timelineResult = await db.query<Record<string, unknown>>(
          `SELECT event.id, event.canonical_key, event.title, event.summary,
                  event.world_time_label, event.chronology_order,
                  event.temporal_status, event.importance,
                  event.source_chapter_keys, event.evidence,
                  COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', relation.id,
                      'direction', CASE WHEN relation.source_event_id = event.id
                                        THEN 'outgoing' ELSE 'incoming' END,
                      'relationType', relation.relation_type,
                      'otherEventId', CASE WHEN relation.source_event_id = event.id
                                           THEN target.id ELSE source.id END,
                      'otherEventTitle', CASE WHEN relation.source_event_id = event.id
                                              THEN target.title ELSE source.title END,
                      'summary', relation.summary,
                      'confidence', relation.confidence
                    ) ORDER BY relation.relation_type)
                      FROM storyhold.world_event_relations relation
                      JOIN storyhold.world_clock_events source
                        ON source.id = relation.source_event_id
                      JOIN storyhold.world_clock_events target
                        ON target.id = relation.target_event_id
                     WHERE (relation.source_event_id = event.id OR relation.target_event_id = event.id)
                       AND source.chronology_order <= $3
                       AND target.chronology_order <= $3
                  ), '[]'::jsonb) AS causal_links,
                  COALESCE((
                    SELECT jsonb_agg(DISTINCT participant.entity_id)
                      FROM storyhold.world_event_participants participant
                     WHERE participant.event_id = event.id
                  ), '[]'::jsonb) AS participant_entity_ids
             FROM storyhold.world_clock_events event
            WHERE event.world_id = $1 AND event.canon_edition_id = $2
              AND event.campaign_id IS NULL AND event.event_kind = 'canon'
              AND event.visibility = 'world' AND event.chronology_order <= $3
            ORDER BY event.chronology_order ASC, event.id ASC
            LIMIT 5000`,
          [worldId, edition.id, maximumChronologyOrder],
        );
        canonTimelineRows = timelineResult.rows;
        canonTimelineSnapshot = {
          anchorEventId: requestedCanonAnchorEventId,
          anchorEventTitle: textBody(anchor.title, 240),
          anchorMode: requestedCanonAnchorMode,
          maximumChronologyOrder,
          eventCount: canonTimelineRows.length,
          sha256: createHash("sha256").update(json(canonTimelineRows)).digest("hex"),
        };
      }
      const eventId = randomUUID();
      const campaignKey = `campaign-${campaignId.slice(0, 12)}`;
      let startContract: Record<string, unknown> | null = null;
      let committedStartingPoint = startingPoint;
      await db.transaction(async (tx) => {
        if (!characterAlreadyExists) {
          if (createsFreeformCampaignCharacter) {
            await createCampaignScopedCharacter(tx, {
              characterId,
              campaignId,
              worldId,
              playerId: user.id,
              name: characterName,
              concept: characterConcept,
            });
          } else {
            await tx.query(
              `INSERT INTO storyhold.characters
                (id, world_id, created_by_player_id, canonical_key, name,
                 initial_profile, scope_kind, scope_campaign_id)
               VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'world', NULL)`,
              [
                characterId,
                worldId,
                user.id,
                `player-character-${characterId.slice(0, 12)}`,
                characterName,
                json({
                  concept: characterConcept,
                  source: "campaign_start_contract",
                  scope: "world",
                }),
              ],
            );
          }
        }
        const holdIdentity = createsFreeformCampaignCharacter
          ? { entityId: characterId, dossierId: null }
          : await ensureCanonicalCharacterEntity(tx, {
              worldId,
              editionId: edition.id,
              characterId,
              name: characterName,
              concept: characterConcept,
              preferredEntityId,
            });
        const anchoredCanonScope = canonTimelineSnapshot
          ? await prepareAnchoredCampaignCanonScope(tx, {
              worldId,
              editionId: edition.id,
              maximumChronologyOrder:
                canonTimelineSnapshot.maximumChronologyOrder,
              timelineRows: canonTimelineRows,
              lockedSources: sources.rows,
              selectedPlayerEntityId: holdIdentity.entityId,
            })
          : null;
        const editionLockedCanonScope = !anchoredCanonScope && hasManuscriptCanonSources
          ? await prepareEditionLockedCampaignCanonScope(tx, {
              worldId,
              editionId: edition.id,
              lockedSources: sources.rows,
              selectedPlayerEntityId: holdIdentity.entityId,
            })
          : null;
        const preparedCanonScope = anchoredCanonScope ?? editionLockedCanonScope;
        const baseEntitySnapshot = preparedCanonScope?.entitySnapshot ??
          await prepareCampaignEntitySnapshot(tx, worldId, edition.id);
        const entitySnapshot = withCampaignScopedPlayerSnapshot(
          baseEntitySnapshot,
          createsFreeformCampaignCharacter
            ? campaignScopedPlayerEntitySnapshot({ characterId, name: characterName })
            : null,
        );
        const frozenCanonScope = preparedCanonScope
          ? { ...preparedCanonScope, entitySnapshot }
          : null;
        const canonScopeSnapshot = frozenCanonScope
          ? createCampaignCanonScopeSnapshot({
              mode: anchoredCanonScope ? "anchored_strict" : "edition_locked",
              anchorEventId: canonTimelineSnapshot?.anchorEventId ?? null,
              anchorMode: canonTimelineSnapshot?.anchorMode ?? null,
              maximumChronologyOrder:
                canonTimelineSnapshot?.maximumChronologyOrder ?? null,
              evidence: frozenCanonScope.evidence,
              claims: frozenCanonScope.claims,
              entities: entitySnapshot.rows,
            })
          : null;
        const anchoredStart = anchoredCanonScope
          ? buildAnchoredCampaignStartPresentation({
              worldName: world.name,
              genre: world.genre,
              requestedStartingPoint,
              anchorMode: canonTimelineSnapshot!.anchorMode,
              anchorTitle: canonTimelineSnapshot!.anchorEventTitle,
              timelineRows: canonTimelineRows,
              playerEntityId: holdIdentity.entityId,
              entitySnapshotRows: entitySnapshot.rows,
              claims: frozenCanonScope?.claims ?? [],
            })
          : null;
        committedStartingPoint = anchoredStart?.startingPoint ?? startingPoint;
        const lockedWorldPremise = anchoredStart?.worldPremise ?? world.premise;
        const lockedWorldContract = anchoredStart?.worldContract ?? world.world_contract;
        const lockedCharacterName = anchoredStart?.characterName ?? characterName;
        const lockedCharacterConcept = anchoredStart?.characterConcept ?? characterConcept;
        const rpgSeed = buildWorldStudioCampaignRpgSeed({
          campaignId,
          worldId,
          editionId: edition.id,
          worldName: world.name,
          worldPremise: lockedWorldPremise,
          startingPoint: committedStartingPoint,
          initialObjective,
          resolutionMode: resolutionMode as CampaignResolutionMode,
          characterId,
          characterEntityId: holdIdentity.entityId,
          characterName: lockedCharacterName,
          hasManuscriptCanonSources,
          entitySnapshotRows: entitySnapshot.rows,
          anchoredCanonClaims: frozenCanonScope?.claims ?? null,
          strictCharacterMechanics: frozenCanonScope?.actorMechanics ?? null,
          canonAnchor: canonTimelineSnapshot
            ? {
                eventId: canonTimelineSnapshot.anchorEventId,
                mode: canonTimelineSnapshot.anchorMode,
              }
            : null,
        });
        const rpgSeedReference = campaignRpgSeedLineage(rpgSeed);
        startContract = {
          version: frozenCanonScope ? 8 : 7,
          worldId,
          canonEditionId: edition.id,
          world: {
            name: world.name,
            premise: lockedWorldPremise,
            genre: world.genre,
            worldClockName: world.world_clock_name,
          },
          worldContract: lockedWorldContract,
          contentSettings: world.content_settings,
          storyPreferences: {
            adultEnabled: storyPreferences.rows[0]?.adult_enabled === true,
            sexualContentLevel:
              storyPreferences.rows[0]?.sexual_content_level ?? "off",
            violenceLevel:
              storyPreferences.rows[0]?.violence_level ?? "standard",
            narrativeLength:
              storyPreferences.rows[0]?.narrative_length ?? "balanced",
          },
          character: {
            id: characterId,
            entityId: holdIdentity.entityId,
            dossierId: holdIdentity.dossierId,
            name: lockedCharacterName,
            concept: lockedCharacterConcept,
          },
          startingPoint: committedStartingPoint,
          initialObjective,
          resolutionMode,
          experienceMode,
          sourceSnapshot: frozenCanonScope?.sourceSnapshot ?? sources.rows,
          referenceSnapshot: frozenCanonScope
            ? []
            : [
                ...referenceWebsites.rows.map((reference) => ({
                  ...reference,
                  kind: "website",
                })),
                ...referenceUploads.rows.map((reference) => ({
                  ...reference,
                  kind: "upload",
                })),
              ],
          worldModelSnapshot: frozenCanonScope
            ? null
            : worldModel.rows[0] ?? null,
          canonTimelineSnapshot,
          ...(canonScopeSnapshot ? { canonScopeSnapshot } : {}),
          entitySnapshot: entitySnapshot.metadata,
          rpgSeed: rpgSeedReference,
          lockedAt: new Date().toISOString(),
        };
        await tx.query(
          `INSERT INTO storyhold.campaigns
            (id, world_id, canon_edition_id, owner_player_id, canonical_key, name,
             start_contract, perspective_character_id, current_time_label, resolution_mode,
             state_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'The beginning', $9, 1)`,
          [
            campaignId,
            worldId,
            edition.id,
            user.id,
            campaignKey,
            campaignName,
            json(startContract),
            characterId,
            resolutionMode,
          ],
        );
        await initializeCampaignRpgStateInTransaction({
          db: tx,
          campaignId,
          seed: rpgSeed,
        });
        await persistCampaignEntitySnapshot(tx, campaignId, entitySnapshot.rows);
        if (frozenCanonScope) {
          await persistCampaignCanonScopeSnapshots({
            db: tx,
            campaignId,
            evidence: frozenCanonScope.evidence,
            claims: frozenCanonScope.claims,
          });
        }
        for (const event of canonTimelineRows) {
          await tx.query(
            `INSERT INTO storyhold.campaign_canon_event_snapshots
              (campaign_id, event_id, canonical_key, title, summary,
               world_time_label, chronology_order, temporal_status, importance,
               source_chapter_keys, evidence, causal_links, participant_entity_ids)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                     $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb)`,
            [
              campaignId,
              event.id,
              event.canonical_key,
              event.title,
              event.summary,
              event.world_time_label,
              Number(event.chronology_order ?? 0),
              event.temporal_status ?? "relative",
              event.importance ?? "major",
              json(event.source_chapter_keys ?? []),
              json(event.evidence ?? []),
              json(event.causal_links ?? []),
              json(event.participant_entity_ids ?? []),
            ],
          );
        }
        await tx.query(
          `INSERT INTO storyhold.campaign_members (campaign_id, player_id, character_id)
           VALUES ($1, $2, $3)`,
          [campaignId, user.id, characterId],
        );
        await tx.query(
          `INSERT INTO storyhold.world_state_events
            (id, campaign_id, sequence_number, event_type, payload, caused_by_player_id)
           VALUES ($1, $2, 1, 'campaign_started', $3::jsonb, $4)`,
          [randomUUID(), campaignId, json(startContract), user.id],
        );
        await tx.query(
          `INSERT INTO storyhold.world_clock_events
            (id, world_id, canon_edition_id, campaign_id, created_by_player_id,
             visible_to_character_id, canonical_key, event_kind, title, summary,
             world_time_label, chronology_order, visibility, knowledge_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'scene', 'The story begins', $8,
                   'The beginning', 0, 'campaign', 'observed')`,
          [
            eventId,
            worldId,
            edition.id,
            campaignId,
            user.id,
            characterId,
            `campaign-start-${campaignId.slice(0, 12)}`,
            committedStartingPoint,
          ],
        );
        await tx.query(
          `INSERT INTO storyhold.vault_memory_chunks
            (id, world_id, canon_edition_id, campaign_id, player_id, character_id, memory_kind,
             content, compact_summary, metadata, state_version)
           VALUES ($1, $2, $3, $4, $5, $6, 'campaign_start', $7, $7,
                   $8::jsonb, 1)`,
          [
            randomUUID(),
            worldId,
            edition.id,
            campaignId,
            null,
            characterId,
            committedStartingPoint,
            json({
              visibility: "campaign",
              worldClockEventId: eventId,
              startContractVersion: frozenCanonScope ? 8 : 7,
              rpgSeedSha256: rpgSeedReference.seedSha256,
            }),
          ],
        );
        await tx.query(
          `INSERT INTO storyhold.campaign_runtime_rules
            (id, world_id, campaign_id, canonical_key, name, rule_kind,
             trigger_definition, requirements, effects, visibility, authored_by)
           VALUES ($1, $2, $3, $4, 'Commit before resolution', 'safety_boundary',
                   $5::jsonb, $6::jsonb, $7::jsonb, 'system', 'storyhold')`,
          [
            randomUUID(),
            worldId,
            campaignId,
            `commit-before-resolve-${campaignId.slice(0, 12)}`,
            json({ when: "an improvised action has uncertain consequences" }),
            json(["establish possibility", "lock stakes", "record odds"]),
            json(["perform the roll", "commit resulting state", "narrate only visible effects"]),
          ],
        );
        await tx.query("UPDATE storyhold.worlds SET updated_at = now() WHERE id = $1", [worldId]);
      });
      const campaign = await ownedCampaign(db, campaignId, user.id);
      res.status(201).json({
        campaign: serializeCampaign(campaign!),
        startContract: startContract ?? {},
        firstEvent: serializeClockEvent({
          id: eventId,
          canonical_key: `campaign-start-${campaignId.slice(0, 12)}`,
          campaign_id: campaignId,
          source_id: null,
          causal_parent_id: null,
          event_kind: "scene",
          title: "The story begins",
          summary: committedStartingPoint,
          world_time_label: "The beginning",
          chronology_order: 0,
          visibility: "campaign",
          knowledge_status: "observed",
          known_effects: [],
          evidence: [],
          scheduled_for_label: "",
          status: "committed",
          created_at: new Date().toISOString(),
        }),
      });
    },
  );

  app.get(
    "/api/storyhold/campaigns/:campaignId/clock",
    requireUser,
    async (req: StudioRequest, res) => {
      const campaignId = routeParam(req, "campaignId");
      if (!UUID_PATTERN.test(campaignId)) {
        res.status(404).json({ error: "Campaign not found." });
        return;
      }
      const user = currentUser(req);
      const campaign = await ownedCampaign(db, campaignId, user.id);
      if (!campaign) {
        res.status(404).json({ error: "Campaign not found." });
        return;
      }
      const campaignWorldId = String(campaign.world_id ?? "");
      const storedEditionId = String(campaign.canon_edition_id ?? "");
      const campaignEditionId = UUID_PATTERN.test(storedEditionId)
        ? storedEditionId
        : (await defaultEdition(db, campaignWorldId))?.id;
      if (!campaignEditionId) {
        res.status(409).json({ error: "This campaign does not have a canon edition." });
        return;
      }
      const characterId = typeof campaign.perspective_character_id === "string"
        ? campaign.perspective_character_id
        : null;
      const events = await readCampaignClockEventsForEdition(db, {
        worldId: campaignWorldId,
        editionId: campaignEditionId,
        campaignId,
        characterId,
      });
      res.json({
        campaign: serializeCampaign(campaign),
        worldClockName: campaign.world_clock_name ?? "World Clock",
        events: events.rows.map((event) => serializeClockEvent(event)),
      });
    },
  );

  app.post(
    "/api/storyhold/campaigns/:campaignId/reminders",
    requireUser,
    async (req: StudioRequest, res) => {
      const campaignId = routeParam(req, "campaignId");
      if (!UUID_PATTERN.test(campaignId)) {
        res.status(404).json({ error: "Campaign not found." });
        return;
      }
      const user = currentUser(req);
      const campaign = await ownedCampaign(db, campaignId, user.id);
      if (!campaign) {
        res.status(404).json({ error: "Campaign not found." });
        return;
      }
      const title = textBody(req.body?.title, 180);
      const summary = textBody(req.body?.summary, 1_500);
      const dueLabel = textBody(req.body?.dueLabel, 180);
      const eventKind = req.body?.kind === "commitment" ? "commitment" : "reminder";
      if (title.length < 2) {
        res.status(400).json({ error: "Give the reminder a short title." });
        return;
      }
      const eventId = randomUUID();
      const canonicalKey = `${eventKind}-${eventId.slice(0, 12)}`;
      try {
        await db.transaction(async (tx) => {
          const lockedResult = await tx.query<Record<string, unknown>>(
            `SELECT state_version, world_time_minutes, status
               FROM storyhold.campaigns WHERE id = $1 FOR UPDATE`,
            [campaignId],
          );
          const locked = lockedResult.rows[0];
          if (!locked || locked.status !== "active") {
            throw new Error("CAMPAIGN_NOT_ACTIVE");
          }
          const [order, sequence, turn] = await Promise.all([
            tx.query<{ next_order: number }>(
              `SELECT COALESCE(max(chronology_order), 0)::bigint + 1000 AS next_order
                 FROM storyhold.world_clock_events WHERE campaign_id = $1`,
              [campaignId],
            ),
            tx.query<{ sequence: number }>(
              `SELECT COALESCE(max(sequence_number), 0)::int + 1 AS sequence
                 FROM storyhold.world_state_events WHERE campaign_id = $1`,
              [campaignId],
            ),
            tx.query<{ turn: number }>(
              `SELECT COALESCE(max(turn_number), 0)::int AS turn
                 FROM storyhold.campaign_turns WHERE campaign_id = $1`,
              [campaignId],
            ),
          ]);
          const stateVersion = Number(sequence.rows[0]?.sequence ?? 1);
          const deadline = reminderDeadline(
            dueLabel,
            Number(locked.world_time_minutes ?? 0),
            Number(turn.rows[0]?.turn ?? 0),
          );
          await tx.query(
            `INSERT INTO storyhold.world_clock_events
              (id, world_id, canon_edition_id, campaign_id, created_by_player_id,
               visible_to_character_id, canonical_key, event_kind, title, summary,
               world_time_label, chronology_order, visibility, knowledge_status,
               scheduled_for_label, status, due_world_time_minutes,
               due_turn_number, causal_basis)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                     'campaign', 'observed', $13, $14, $15, $16, $17::jsonb)`,
            [
              eventId,
              campaign.world_id,
              campaign.canon_edition_id,
              campaignId,
              user.id,
              campaign.perspective_character_id,
              canonicalKey,
              eventKind,
              title,
              summary,
              campaign.current_time_label,
              Number(order.rows[0]?.next_order ?? 1000),
              dueLabel,
              dueLabel ? "scheduled" : "committed",
              deadline.dueWorldTimeMinutes,
              deadline.dueTurnNumber,
              json(["Player-created reminder."]),
            ],
          );
          await tx.query(
            `INSERT INTO storyhold.world_state_events
              (id, campaign_id, sequence_number, event_type, payload,
               caused_by_player_id)
             VALUES ($1, $2, $3, 'reminder_created', $4::jsonb, $5)`,
            [
              randomUUID(),
              campaignId,
              stateVersion,
              json({
                clockEventId: eventId,
                eventKind,
                title,
                summary,
                dueLabel,
                dueWorldTimeMinutes: deadline.dueWorldTimeMinutes,
                dueTurnNumber: deadline.dueTurnNumber,
              }),
              user.id,
            ],
          );
          await tx.query(
            `INSERT INTO storyhold.vault_memory_chunks
              (id, world_id, canon_edition_id, campaign_id, player_id,
               character_id, memory_kind, content, compact_summary, metadata,
               state_version)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
            [
              randomUUID(),
              campaign.world_id,
              campaign.canon_edition_id,
              campaignId,
              null,
              campaign.perspective_character_id,
              eventKind,
              `${title}${summary ? `: ${summary}` : ""}`,
              title,
              json({
                visibility: "campaign",
                dueLabel,
                worldClockEventId: eventId,
              }),
              stateVersion,
            ],
          );
          await tx.query(
            `UPDATE storyhold.campaigns SET state_version = $2 WHERE id = $1`,
            [campaignId, stateVersion],
          );
        });
      } catch (error) {
        if (error instanceof Error && error.message === "CAMPAIGN_NOT_ACTIVE") {
          res.status(409).json({ error: "This campaign is not currently active." });
          return;
        }
        throw error;
      }
      const stored = await db.query<Record<string, unknown>>(
        "SELECT * FROM storyhold.world_clock_events WHERE id = $1 LIMIT 1",
        [eventId],
      );
      res.status(201).json({ event: serializeClockEvent(stored.rows[0]!) });
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/discrepancies",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      if (!assertUuid(worldId, res)) return;
      const user = currentUser(req);
      const campaignId =
        typeof req.body?.campaignId === "string" && req.body.campaignId
          ? req.body.campaignId
          : null;
      if (campaignId && !UUID_PATTERN.test(campaignId)) {
        res.status(400).json({ error: "That campaign ID is not valid." });
        return;
      }
      const access = await discrepancyWorldAccess(
        db,
        worldId,
        user.id,
        campaignId,
      );
      if (!access) {
        res.status(404).json({ error: "World or campaign not found." });
        return;
      }
      const edition = await defaultEdition(db, worldId);
      if (!edition) {
        res
          .status(409)
          .json({ error: "This world does not have a canon edition." });
        return;
      }
      const claim = textBody(req.body?.claim, 3_000);
      if (claim.length < 8) {
        res.status(400).json({
          error: "Describe the discrepancy in at least a short sentence.",
        });
        return;
      }
      const evaluated = await evaluateDiscrepancy({
        db,
        world: access.world,
        editionId: edition.id,
        campaignId,
        playerId: user.id,
        claim,
        reasoning: "",
      });
      const reportId = randomUUID();
      await db.query(
        `INSERT INTO storyhold.canon_discrepancy_reports
          (id, world_id, canon_edition_id, campaign_id, reported_by_player_id,
           canonical_key, claim, status, review_explanation, review_confidence,
           review_provider, review_model, strictness_level, proposed_amendment,
           evidence, integrity_risk)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 $14::jsonb, $15::jsonb, $16)`,
        [
          reportId,
          worldId,
          edition.id,
          campaignId,
          user.id,
          `discrepancy-${reportId.slice(0, 12)}`,
          claim,
          discrepancyStatus(evaluated.review.verdict),
          evaluated.review.explanation,
          evaluated.review.confidence,
          evaluated.provider,
          evaluated.model,
          evaluated.strictnessLevel,
          evaluated.review.proposedAmendment
            ? json(evaluated.review.proposedAmendment)
            : null,
          json(evaluated.review.evidence),
          evaluated.review.integrityRisk,
        ],
      );
      let amendmentId: string | null = null;
      if (evaluated.review.verdict === "reasoned_correction") {
        const stored = await db.query<Record<string, unknown>>(
          `SELECT * FROM storyhold.canon_discrepancy_reports WHERE id = $1 LIMIT 1`,
          [reportId],
        );
        amendmentId = await applyCanonAmendment({
          db,
          report: stored.rows[0]!,
          playerId: user.id,
          decisionSource: "reasoned_consistency",
        });
      }
      const final = await db.query<Record<string, unknown>>(
        `SELECT * FROM storyhold.canon_discrepancy_reports WHERE id = $1 LIMIT 1`,
        [reportId],
      );
      res.status(201).json({
        report: serializeDiscrepancyReport(final.rows[0]!),
        amendmentId,
        canonChanged: amendmentId !== null,
      });
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/discrepancies/:reportId/reason",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      const reportId = routeParam(req, "reportId");
      if (!assertUuid(worldId, res) || !UUID_PATTERN.test(reportId)) return;
      const user = currentUser(req);
      const reportResult = await db.query<Record<string, unknown>>(
        `SELECT * FROM storyhold.canon_discrepancy_reports
          WHERE id = $1 AND world_id = $2 AND reported_by_player_id = $3
          LIMIT 1`,
        [reportId, worldId, user.id],
      );
      const report = reportResult.rows[0];
      if (!report) {
        res.status(404).json({ error: "Discrepancy report not found." });
        return;
      }
      if (report.status !== "needs_reason") {
        res.status(409).json({
          error: "That discrepancy is not waiting for more reasoning.",
        });
        return;
      }
      const campaignId =
        typeof report.campaign_id === "string" ? report.campaign_id : null;
      const access = await discrepancyWorldAccess(
        db,
        worldId,
        user.id,
        campaignId,
      );
      if (!access) {
        res.status(404).json({ error: "World or campaign not found." });
        return;
      }
      const reasoning = textBody(req.body?.reasoning, 4_000);
      if (reasoning.length < 20) {
        res.status(400).json({
          error: "Explain why the current fact cannot be right.",
        });
        return;
      }
      const evaluated = await evaluateDiscrepancy({
        db,
        world: access.world,
        editionId: String(report.canon_edition_id),
        campaignId,
        playerId: user.id,
        claim: String(report.claim),
        reasoning,
      });
      await db.query(
        `UPDATE storyhold.canon_discrepancy_reports
            SET reasoning = $2, status = $3, review_explanation = $4,
                review_confidence = $5, review_provider = $6, review_model = $7,
                strictness_level = $8, proposed_amendment = $9::jsonb,
                evidence = $10::jsonb, integrity_risk = $11, updated_at = now(),
                resolved_at = CASE WHEN $3 = 'rejected' THEN now() ELSE NULL END
          WHERE id = $1`,
        [
          reportId,
          reasoning,
          discrepancyStatus(evaluated.review.verdict),
          evaluated.review.explanation,
          evaluated.review.confidence,
          evaluated.provider,
          evaluated.model,
          evaluated.strictnessLevel,
          evaluated.review.proposedAmendment
            ? json(evaluated.review.proposedAmendment)
            : null,
          json(evaluated.review.evidence),
          evaluated.review.integrityRisk,
        ],
      );
      let amendmentId: string | null = null;
      if (evaluated.review.verdict === "reasoned_correction") {
        const updated = await db.query<Record<string, unknown>>(
          `SELECT * FROM storyhold.canon_discrepancy_reports WHERE id = $1 LIMIT 1`,
          [reportId],
        );
        amendmentId = await applyCanonAmendment({
          db,
          report: updated.rows[0]!,
          playerId: user.id,
          decisionSource: "reasoned_consistency",
        });
      } else if (
        evaluated.review.verdict === "unsupported" &&
        evaluated.review.integrityRisk !== "none"
      ) {
        await recordIntegritySignal({
          db,
          reportId,
          playerId: user.id,
          worldId,
          campaignId,
          risk: evaluated.review.integrityRisk,
          explanation: evaluated.review.explanation,
        });
      }
      const final = await db.query<Record<string, unknown>>(
        `SELECT * FROM storyhold.canon_discrepancy_reports WHERE id = $1 LIMIT 1`,
        [reportId],
      );
      res.json({
        report: serializeDiscrepancyReport(final.rows[0]!),
        amendmentId,
        canonChanged: amendmentId !== null,
      });
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/discrepancies/:reportId/apply",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      const reportId = routeParam(req, "reportId");
      if (!assertUuid(worldId, res) || !UUID_PATTERN.test(reportId)) return;
      const user = currentUser(req);
      const reportResult = await db.query<Record<string, unknown>>(
        `SELECT * FROM storyhold.canon_discrepancy_reports
          WHERE id = $1 AND world_id = $2 AND reported_by_player_id = $3
          LIMIT 1`,
        [reportId, worldId, user.id],
      );
      const report = reportResult.rows[0];
      if (!report) {
        res.status(404).json({ error: "Discrepancy report not found." });
        return;
      }
      if (report.status !== "correction_offered") {
        res.status(409).json({
          error: "That discrepancy does not have an unapplied correction.",
        });
        return;
      }
      const campaignId =
        typeof report.campaign_id === "string" ? report.campaign_id : null;
      const access = await discrepancyWorldAccess(
        db,
        worldId,
        user.id,
        campaignId,
      );
      if (!access) {
        res.status(404).json({ error: "World or campaign not found." });
        return;
      }
      const amendmentId = await applyCanonAmendment({
        db,
        report,
        playerId: user.id,
        decisionSource: "source_evidence",
      });
      const final = await db.query<Record<string, unknown>>(
        `SELECT * FROM storyhold.canon_discrepancy_reports WHERE id = $1 LIMIT 1`,
        [reportId],
      );
      res.json({
        report: serializeDiscrepancyReport(final.rows[0]!),
        amendmentId,
        canonChanged: true,
      });
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/sources",
    requireUser,
    express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      if (!assertUuid(worldId, res)) return;
      const user = currentUser(req);
      const world = await ownedWorld(db, worldId, user.id);
      if (!world) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await defaultEdition(db, worldId);
      if (!edition) {
        res
          .status(409)
          .json({ error: "This world does not have a canon edition." });
        return;
      }
      const bytes = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(req.body ?? []);
      const filename =
        headerText(req, "x-storyhold-filename", 260) || "uploaded-source";
      const requestedTitle = headerText(req, "x-storyhold-title", 260);
      const mediaType = (
        req.header("content-type") || "application/octet-stream"
      )
        .split(";")[0]!
        .trim();
      const sourceClassHeader = headerText(req, "x-storyhold-source-class", 40);
      const canonStatusHeader = headerText(req, "x-storyhold-canon-status", 40);
      const sourceKindHeader = headerText(req, "x-storyhold-source-kind", 40);
      const chronologyRelationHeader = headerText(
        req,
        "x-storyhold-chronology-relation",
        40,
      );
      const chronologyLabel = headerText(
        req,
        "x-storyhold-chronology-label",
        240,
      );
      const chronologyNotes = headerText(
        req,
        "x-storyhold-chronology-notes",
        1_000,
      );
      const fileAsChapter =
        headerText(req, "x-storyhold-file-as-chapter", 8) === "true";
      const relativePath = headerText(
        req,
        "x-storyhold-relative-path",
        1_000,
      );
      const importBatchId =
        headerText(req, "x-storyhold-import-batch-id", 120) || null;
      const importBatchPositionValue = Number(
        headerText(req, "x-storyhold-import-batch-position", 12),
      );
      const importBatchSizeValue = Number(
        headerText(req, "x-storyhold-import-batch-size", 12),
      );
      const importBatchPosition = Number.isSafeInteger(importBatchPositionValue)
        ? Math.max(0, importBatchPositionValue)
        : null;
      const importBatchSize = Number.isSafeInteger(importBatchSizeValue)
        ? Math.max(1, importBatchSizeValue)
        : null;
      const deferAnalysis =
        headerText(req, "x-storyhold-defer-analysis", 8) === "true";
      const requestedReferenceKnowledgeScope = headerText(
        req,
        "x-storyhold-reference-knowledge-scope",
        40,
      );
      const referenceKnowledgeScope = REFERENCE_KNOWLEDGE_SCOPES.has(
        requestedReferenceKnowledgeScope,
      )
        ? requestedReferenceKnowledgeScope
        : "director_only";
      const referenceKnownBy = headerText(
        req,
        "x-storyhold-reference-known-by",
        2_000,
      )
        .split(/[,;\n]/u)
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 50);
      const requestedReferenceLoreStatus = headerText(
        req,
        "x-storyhold-reference-lore-status",
        40,
      );
      const referenceLoreStatus = REFERENCE_LORE_STATUSES.has(
        requestedReferenceLoreStatus,
      )
        ? requestedReferenceLoreStatus
        : "supplemental";
      const sourceClass = SOURCE_CLASSES.has(sourceClassHeader)
        ? sourceClassHeader
        : "original_author";
      const canonStatus = CANON_STATUSES.has(canonStatusHeader)
        ? canonStatusHeader
        : "candidate";
      const sourceKind = SOURCE_KINDS.has(sourceKindHeader)
        ? sourceKindHeader
        : "manuscript";
      if (bytes.length === 0) {
        res.status(400).json({ error: "The uploaded file is empty." });
        return;
      }
      const documentType = detectDocumentType({
        contentType: mediaType,
        url: filename,
        bytes,
      });
      if (!documentType) {
        res.status(415).json({
          error:
            "Unsupported file. Use PDF, EPUB, DOCX, TXT, Markdown, PPTX, XLSX, ODT, ODP, or ODS.",
        });
        return;
      }
      const contentHash = createHash("sha256").update(bytes).digest("hex");
      const duplicate = await db.query<{ id: string; title: string }>(
        "SELECT id, title FROM storyhold.world_sources WHERE canon_edition_id = $1 AND content_hash = $2 LIMIT 1",
        [edition.id, contentHash],
      );
      if (duplicate.rows[0]) {
        res.status(409).json({
          error: `That exact file is already stored as “${duplicate.rows[0].title}”.`,
          sourceId: duplicate.rows[0].id,
        });
        return;
      }

      const sourceId = randomUUID();
      const worldUploadDir = path.join(storageRoot, "uploads", worldId);
      await mkdir(worldUploadDir, { recursive: true });
      const rawFilePath = path.join(
        worldUploadDir,
        `${sourceId}${extensionFor(filename, documentType)}`,
      );
      await writeFile(rawFilePath, bytes, { flag: "wx" });

      let extraction: Awaited<ReturnType<typeof extractDocumentText>> | null =
        null;
      let processingError: string | null = null;
      try {
        extraction = await extractDocumentText(bytes, documentType);
        if (!extraction.text.trim()) {
          processingError =
            documentType === "pdf"
              ? "No selectable text was found. This may be a scanned PDF that needs OCR."
              : "The document contained no extractable text.";
        }
      } catch (error) {
        processingError =
          error instanceof DocumentExtractionError
            ? error.message
            : `Document extraction failed: ${error instanceof Error ? error.message : String(error)}`;
      }

      const extractedPages = extraction?.pages?.map((page) =>
        page.replace(/\u0000/g, "").trim(),
      );
      const extractedText = extractedPages
        ? extractedPages.join("\n\n\f\n\n")
        : extraction?.text.replace(/\u0000/g, "").trim() ?? "";
      const pageSpans = extractedPages ? sourcePageSpans(extractedPages) : [];
      const rawChunks = processingError ? [] : chunkText(extractedText);
      const chunks = rawChunks.map((chunk) => {
        const sourceOffset = Number(chunk.metadata.sourceStartOffset ?? 0);
        const page = pageSpans.find(
          (candidate, index) =>
            sourceOffset >= candidate.startOffset &&
            (sourceOffset <= candidate.endOffset || index === pageSpans.length - 1),
        );
        return page
          ? {
              ...chunk,
              metadata: {
                ...chunk.metadata,
                pageIndex: page.pageIndex,
                pageNumber: page.pageIndex + 1,
              },
            }
          : chunk;
      });
      const title =
        requestedTitle ||
        extraction?.title ||
        filename.replace(/\.[^.]+$/, "") ||
        "Untitled source";
      const order = await db.query<{ next_order: number }>(
        "SELECT COALESCE(max(sort_order), -1)::int + 1 AS next_order FROM storyhold.world_sources WHERE world_id = $1",
        [worldId],
      );
      const defaultOrder = Number(order.rows[0]?.next_order ?? 0);
      const chronologyOrderHeader = Number(
        headerText(req, "x-storyhold-chronology-order", 12),
      );
      const chronologyOrder = Number.isSafeInteger(chronologyOrderHeader)
        ? Math.max(0, chronologyOrderHeader)
        : defaultOrder;
      const chronologyRelation = CHRONOLOGY_RELATIONS.has(
        chronologyRelationHeader,
      )
        ? chronologyRelationHeader
        : sourceKind === "reference" || sourceKind === "ruleset"
          ? "reference"
          : defaultOrder === 0
            ? "origin"
            : "continues";
      const reviewApplicable =
        !processingError &&
        chunks.length > 0 &&
        (canonStatus === "candidate" || canonStatus === "canon");
      const launchesCanonIntake =
        reviewApplicable && sourceKind !== "reference";
      const extractedWordCount = wordCount(extractedText);
      if (launchesCanonIntake) {
        const currentIntake = await canonIntakePreflight(db, {
          worldId,
          editionId: edition.id,
        });
        const projectedWordCount = currentIntake.wordCount + extractedWordCount;
        if (projectedWordCount > currentIntake.wordLimit) {
          await unlink(rawFilePath).catch(() => undefined);
          res.status(413).json({
            code: "CANON_INTAKE_WORD_LIMIT",
            error: `Adding this source would bring the world to ${projectedWordCount.toLocaleString()} intake words. Canon Intake accepts up to ${currentIntake.wordLimit.toLocaleString()} words in one world, so this file was not added and no credits were used.`,
            currentWordCount: currentIntake.wordCount,
            sourceWordCount: extractedWordCount,
            projectedWordCount,
            wordLimit: currentIntake.wordLimit,
          });
          return;
        }
      }
      const localScanStatus = reviewApplicable ? "pending" : "not_applicable";
      const aiReviewStatus = reviewApplicable ? "waiting" : "not_applicable";
      try {
        await db.query(
          `INSERT INTO storyhold.world_sources
            (id, world_id, canon_edition_id, uploaded_by_player_id, canonical_key, title, original_filename,
             media_type, document_type, source_class, canon_status, raw_file_path, content_hash, extracted_text,
             extraction_method, page_count, byte_size, word_count, char_count, chunk_count, sort_order,
             processing_status, processing_error, local_scan_status, ai_review_status,
             source_kind, chronology_order, chronology_relation, chronology_label, chronology_notes,
             file_as_chapter, relative_path, import_batch_id, import_batch_position,
             import_batch_size, extraction_quality_severity, extraction_diagnostics,
             reference_knowledge_scope, reference_known_by, reference_lore_status,
             intake_payment_required)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
                   $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
                   $31, $32, $33, $34, $35, $36, $37::jsonb, $38, $39::jsonb, $40, $41)`,
          [
            sourceId,
            worldId,
            edition.id,
            user.id,
            `${slug(title)}-${sourceId.slice(0, 8)}`,
            title,
            filename,
            mediaType,
            documentType,
            sourceClass,
            canonStatus,
            rawFilePath,
            contentHash,
            extractedText,
            extraction?.extractionMethod ?? null,
            extraction?.pageCount ?? null,
            bytes.length,
            extractedWordCount,
            extractedText.length,
            chunks.length,
            defaultOrder,
            processingError ? "failed" : "ready",
            processingError,
            localScanStatus,
            aiReviewStatus,
            sourceKind,
            chronologyOrder,
            chronologyRelation,
            chronologyLabel,
            chronologyNotes,
            fileAsChapter,
            relativePath,
            importBatchId,
            importBatchPosition,
            importBatchSize,
            extraction?.diagnostics?.severity ?? "critical",
            json(extraction?.diagnostics ?? {}),
            referenceKnowledgeScope,
            json(referenceKnownBy),
            referenceLoreStatus,
            launchesCanonIntake,
          ],
        );
        if (extractedPages?.length) {
          await insertSourcePages({
            db,
            sourceId,
            worldId,
            editionId: edition.id,
            pages: extractedPages,
          });
        }
        if (chunks.length > 0) {
          await insertChunks({
            db,
            chunks,
            sourceId,
            worldId,
            editionId: edition.id,
            sourceTitle: title,
          });
          await syncSourceChapterSummaries({
            db,
            worldId,
            editionId: edition.id,
            sourceId,
            sourceTitle: title,
            chronologyLabel,
            chronologyOrder,
            extractedText,
            fileAsChapter,
          });
        }
        await db.query(
          "UPDATE storyhold.worlds SET updated_at = now() WHERE id = $1",
          [worldId],
        );
        if (launchesCanonIntake && !deferAnalysis) {
          scheduleAutomaticAnalysis(db, {
            worldId,
            editionId: edition.id,
            playerId: user.id,
            trigger: "upload",
          });
        }
      } catch (error) {
        await db.query("DELETE FROM storyhold.world_sources WHERE id = $1", [
          sourceId,
        ]);
        await unlink(rawFilePath).catch(() => undefined);
        throw error;
      }
      res.status(processingError ? 422 : 201).json({
        source: serializeSource({
          id: sourceId,
          canonical_key: `${slug(title)}-${sourceId.slice(0, 8)}`,
          title,
          original_filename: filename,
          media_type: mediaType,
          document_type: documentType,
          source_class: sourceClass,
          canon_status: canonStatus,
          source_kind: sourceKind,
          chronology_order: chronologyOrder,
          chronology_relation: chronologyRelation,
          chronology_label: chronologyLabel,
          chronology_notes: chronologyNotes,
          reference_knowledge_scope: referenceKnowledgeScope,
          reference_known_by: referenceKnownBy,
          reference_lore_status: referenceLoreStatus,
          chronology_review_status: "unreviewed",
          file_as_chapter: fileAsChapter,
          relative_path: relativePath,
          import_batch_id: importBatchId,
          import_batch_position: importBatchPosition,
          import_batch_size: importBatchSize,
          extraction_quality_severity:
            extraction?.diagnostics?.severity ?? "critical",
          extraction_diagnostics: extraction?.diagnostics ?? {},
          byte_size: bytes.length,
          word_count: extractedWordCount,
          char_count: extractedText.length,
          chunk_count: chunks.length,
          page_count: extraction?.pageCount ?? null,
          extraction_method: extraction?.extractionMethod ?? null,
          processing_status: processingError ? "failed" : "ready",
          processing_error: processingError,
          local_scan_status: localScanStatus,
          local_scanned_at: null,
          ai_review_status: aiReviewStatus,
          ai_analysis_version: 0,
          ai_review_provider: null,
          ai_review_model: null,
          ai_reviewed_at: null,
          created_at: new Date().toISOString(),
        }),
      });
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/reference-sources",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      if (!assertUuid(worldId, res)) return;
      const user = currentUser(req);
      const world = await ownedWorld(db, worldId, user.id);
      if (!world) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await defaultEdition(db, worldId);
      if (!edition) {
        res.status(409).json({ error: "This world does not have a canon edition." });
        return;
      }
      const requestedTitle = textBody(req.body?.title, 300);
      const rawUrl = textBody(req.body?.url, 2_000);
      let url: URL;
      try {
        url = new URL(rawUrl);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error("invalid protocol");
      } catch {
        res.status(400).json({ error: "Add a valid public reference URL." });
        return;
      }
      let extracted: Awaited<ReturnType<typeof fetchAndExtract>> | null = null;
      let processingError = "";
      try {
        const robots = await checkRobots(url.toString());
        if (!robots.allowed) {
          res.status(403).json({
            error: "That website does not permit automated reference reading.",
          });
          return;
        }
        extracted = await fetchAndExtract(url.toString());
      } catch (error) {
        processingError =
          error instanceof Error ? error.message : "This website could not be read.";
      }
      const savedUrl = extracted?.canonicalUrl || extracted?.finalUrl || url.toString();
      const title =
        requestedTitle || extracted?.title || url.hostname.replace(/^www\./i, "");
      const contentText = textBody(extracted?.text, 250_000);
      const suppliedSummary = textBody(req.body?.summary, 3_000);
      const summary =
        suppliedSummary ||
        textBody(extracted?.excerpt, 3_000) ||
        textBody(contentText.replace(/\s+/g, " "), 900);
      const qualityFlags = [
        ...(extracted?.qualityFlags ?? []),
        ...(extracted?.paywallDetected ? ["paywall_detected"] : []),
        ...(extracted?.excerptOnly ? ["excerpt_only"] : []),
        ...(extracted?.policyNotes ? [extracted.policyNotes] : []),
      ];
      const requestedDiscovery = String(req.body?.discoveredBy ?? "user");
      const privileged = ["owner", "admin"].includes(user.role);
      const discoveredBy = privileged && ["codex", "perplexity"].includes(requestedDiscovery)
        ? requestedDiscovery
        : "user";
      const reviewStatus =
        extracted && req.body?.reviewStatus === "approved" ? "approved" : "candidate";
      const requestedKnowledgeScope = String(
        req.body?.knowledgeScope ?? "director_only",
      );
      const knowledgeScope = REFERENCE_KNOWLEDGE_SCOPES.has(
        requestedKnowledgeScope,
      )
        ? requestedKnowledgeScope
        : "director_only";
      const knownBy = stringList(req.body?.knownBy, 50, 180);
      const requestedLoreStatus = String(
        req.body?.loreStatus ?? "supplemental",
      );
      const loreStatus = REFERENCE_LORE_STATUSES.has(requestedLoreStatus)
        ? requestedLoreStatus
        : "supplemental";
      const saved = await db.query<Record<string, unknown>>(
        `INSERT INTO storyhold.world_reference_sources
          (id, world_id, canon_edition_id, query, title, url, publisher, summary,
           keywords, discovered_by, review_status, content_text, content_hash,
           extraction_status, extraction_method, quality_score, quality_flags,
           word_count, use_policy, processing_error, knowledge_scope, known_by,
           lore_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11,
                 $12, $13, $14, $15, $16, $17::jsonb, $18,
                 'background_only', $19, $20, $21::jsonb, $22)
         ON CONFLICT (world_id, canon_edition_id, url) DO UPDATE SET
           query = EXCLUDED.query,
           title = EXCLUDED.title,
           publisher = EXCLUDED.publisher,
           summary = EXCLUDED.summary,
           keywords = EXCLUDED.keywords,
           discovered_by = EXCLUDED.discovered_by,
           review_status = EXCLUDED.review_status,
           content_text = EXCLUDED.content_text,
           content_hash = EXCLUDED.content_hash,
           extraction_status = EXCLUDED.extraction_status,
           extraction_method = EXCLUDED.extraction_method,
           quality_score = EXCLUDED.quality_score,
           quality_flags = EXCLUDED.quality_flags,
           word_count = EXCLUDED.word_count,
           use_policy = 'background_only',
           processing_error = EXCLUDED.processing_error,
           knowledge_scope = EXCLUDED.knowledge_scope,
           known_by = EXCLUDED.known_by,
           lore_status = EXCLUDED.lore_status,
           updated_at = now()
         RETURNING *`,
        [
          randomUUID(),
          worldId,
          edition.id,
          textBody(req.body?.query, 500),
          title,
          savedUrl,
          textBody(req.body?.publisher, 240) || extracted?.domain || "",
          summary,
          json(stringList(req.body?.keywords, 30, 120)),
          discoveredBy,
          reviewStatus,
          contentText,
          contentText ? createHash("sha256").update(contentText).digest("hex") : null,
          extracted ? "ready" : "failed",
          extracted?.extractionMethod ?? null,
          extracted?.qualityScore ?? null,
          json(qualityFlags),
          extracted?.wordCount ?? 0,
          processingError || null,
          knowledgeScope,
          json(knownBy),
          loreStatus,
        ],
      );
      res.status(201).json({ reference: serializeReferenceSource(saved.rows[0]!) });
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/reference-sources/discover",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      if (!assertUuid(worldId, res)) return;
      const user = currentUser(req);
      const world = await ownedWorld(db, worldId, user.id);
      if (!world) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      if (!isStoryholdLoreSearchConfigured()) {
        res.status(503).json({
          error:
            "Lore discovery is not connected yet. Add a Perplexity API key or paste a reference address directly.",
        });
        return;
      }
      const query =
        textBody(req.body?.query, 800) ||
        [world.name, world.genre, world.premise, "official lore setting guide"]
          .filter(Boolean)
          .join(" ");
      const leads = await discoverStoryholdLore(query, 10);
      res.json({
        query,
        leads: leads
          .slice(0, 10)
          .map((lead) => ({
            title: lead.title,
            url: lead.url,
            summary: lead.snippet,
            publisher: lead.domain,
            date: lead.date,
            sourceRole: "reference_candidate",
          })),
      });
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/quality-findings/:findingId/dismiss",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      const findingId = routeParam(req, "findingId");
      if (!assertUuid(worldId, res) || !assertUuid(findingId, res)) return;
      const user = currentUser(req);
      const world = await ownedWorld(db, worldId, user.id);
      if (!world) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await defaultEdition(db, worldId);
      if (!edition) {
        res.status(409).json({ error: "This world does not have a canon edition." });
        return;
      }
      const dismissed = await db.query<Record<string, unknown>>(
        `UPDATE storyhold.world_quality_findings
            SET finding_status = 'ignored', resolved_at = now()
          WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3
          RETURNING *`,
        [findingId, worldId, edition.id],
      );
      const finding = dismissed.rows[0];
      if (!finding) {
        res.status(404).json({ error: "Source-review notice not found." });
        return;
      }
      res.json({ finding: serializeQualityFinding(finding) });
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/intake/pause",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      if (!assertUuid(worldId, res)) return;
      const user = currentUser(req);
      const world = await ownedWorld(db, worldId, user.id);
      if (!world) {
        res.status(404).json({ error: "World not found." });
        return;
      }

      const activeRun = await db.query<{
        id: string;
        status: string;
        analysis_kind: AnalysisKind;
      }>(
        `SELECT id, status, analysis_kind
           FROM storyhold.world_analysis_runs
          WHERE world_id = $1 AND status IN ('queued', 'running')
          ORDER BY created_at DESC
          LIMIT 1`,
        [worldId],
      );
      if (activeRun.rows[0]) {
        const run = activeRun.rows[0];
        const premiumReview = run.analysis_kind === "ai_enrichment";
        const pauseStage = run.status === "queued"
          ? premiumReview
            ? "Pause requested before Premium Deep Reading starts"
            : "Pause requested before Canon Intake starts"
          : premiumReview
            ? "Pause requested — finishing the current premium review step"
            : "Pause requested — finishing the current intake step";
        await db.query(
          `UPDATE storyhold.world_analysis_runs
              SET pause_requested = true,
                  stage = $2
            WHERE id = $1`,
          [run.id, pauseStage],
        );
        await appendIntakeActivity(db, run.id, [{
          dedupeKey: `${run.id}:manual-pause-requested`,
          kind: "warning",
          label: premiumReview ? "Premium Deep Reading pause requested" : "Canon Intake pause requested",
          detail: premiumReview
            ? "Storyhold will pause after the current safe premium review step. Your locally built world remains usable."
            : "Storyhold will stop after the current safe intake step and save its progress.",
          entityName: null,
          entityType: null,
        }]);
        res.status(202).json({ status: "pausing", runId: run.id });
        return;
      }

      const browserAudit = await db.query<{ id: string }>(
        `SELECT audit.id
           FROM storyhold.browser_local_audits audit
           JOIN storyhold.worlds world ON world.id = audit.world_id
          WHERE audit.world_id = $1 AND world.owner_player_id = $2
            AND audit.status IN ('pending', 'running')
          ORDER BY audit.created_at DESC
          LIMIT 1`,
        [worldId, user.id],
      );
      if (browserAudit.rows[0]) {
        await db.query(
          `UPDATE storyhold.browser_local_audits
              SET status = 'paused', error = NULL
            WHERE id = $1 AND status IN ('pending', 'running')`,
          [browserAudit.rows[0].id],
        );
        res.json({ status: "paused", auditId: browserAudit.rows[0].id });
        return;
      }

      const alreadyPaused = await db.query<{ run_id: string | null; audit_id: string | null }>(
        `SELECT
            (SELECT id::text FROM storyhold.world_analysis_runs
              WHERE world_id = $1 AND status = 'paused'
              ORDER BY created_at DESC LIMIT 1) AS run_id,
            (SELECT id::text FROM storyhold.browser_local_audits
              WHERE world_id = $1 AND status = 'paused'
              ORDER BY created_at DESC LIMIT 1) AS audit_id`,
        [worldId],
      );
      if (alreadyPaused.rows[0]?.run_id || alreadyPaused.rows[0]?.audit_id) {
        res.json({
          status: "paused",
          runId: alreadyPaused.rows[0].run_id ?? undefined,
          auditId: alreadyPaused.rows[0].audit_id ?? undefined,
        });
        return;
      }
      res.status(409).json({ error: "This world does not have an intake in progress." });
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/intake/resume",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      if (!assertUuid(worldId, res)) return;
      const user = currentUser(req);
      const world = await ownedWorld(db, worldId, user.id);
      if (!world) {
        res.status(404).json({ error: "World not found." });
        return;
      }

      const pausedRun = await db.query<{
        id: string;
        canon_edition_id: string;
        requested_by_player_id: string;
        analysis_kind: AnalysisKind;
        review_source_ids: unknown;
        progress: number;
        local_checkpoint: unknown;
      }>(
        `SELECT id, canon_edition_id, requested_by_player_id,
                analysis_kind, review_source_ids, progress, local_checkpoint
           FROM storyhold.world_analysis_runs
          WHERE world_id = $1 AND status = 'paused'
          ORDER BY created_at DESC
          LIMIT 1`,
        [worldId],
      );
      if (pausedRun.rows[0]) {
        const run = pausedRun.rows[0];
        const premiumReview = run.analysis_kind === "ai_enrichment";
        const liveWorkerIsWaiting = activeRuns.has(worldId);
        if (premiumReview) {
          const scope = {
            runId: run.id, worldId, editionId: run.canon_edition_id,
            playerId: user.id,
          };
          try {
            const rejectedRecovery = await recoverKnownRejectedPremiumReview(db, scope);
            if (rejectedRecovery?.status === "needs_top_up") {
              res.status(402).json({
                code: "CREDITS_NEEDED_TO_FINISH",
                error: `The completed review is saved. Add ${rejectedRecovery.topUpCreditsNeeded.toLocaleString("en-US")} more credit${rejectedRecovery.topUpCreditsNeeded === 1 ? "" : "s"}, then resume again. No AI request will be repeated.`,
                topUpCreditsNeeded: rejectedRecovery.topUpCreditsNeeded,
              });
              return;
            }
            if (rejectedRecovery?.status === "settled") {
              res.json({
                status: "finished",
                reviewed: false,
                creditsUsed: rejectedRecovery.creditsUsed,
                creditsRemaining: rejectedRecovery.creditsRemaining,
                message: "The saved review has been closed without repeating any AI request. It did not pass Storyhold's evidence checks, so no canon changes were applied.",
              });
              return;
            }
            // Only a still-live worker may continue from before its first plan.
            if (!liveWorkerIsWaiting || await readPremiumReviewPlan(db, run.id)) {
              await validatedPremiumResumePlan(db, scope);
            }
            if (!await claimPausedPremiumReview(db, scope, liveWorkerIsWaiting)) {
              res.status(409).json({ error: "This review was already resumed or another review is active." });
              return;
            }
          } catch (error) {
            res.status(409).json({
              code: error instanceof PremiumReviewPlanError ? error.code : "PREMIUM_RESUME_BLOCKED",
              error: error instanceof Error ? error.message : "This premium review needs attention before resuming.",
            });
            return;
          }
          await setReviewStatus(db, "ai_enrichment", stringArray(run.review_source_ids), liveWorkerIsWaiting ? "running" : "queued");
          await appendIntakeActivity(db, run.id, [{
            dedupeKey: `${run.id}:premium-resume:${Date.now()}`,
            kind: "source",
            label: "Premium Deep Reading Resumed",
            detail: "Continuing the same review. Completed reading and its reserved credits are preserved.",
            entityName: null,
            entityType: null,
          }]);
          if (!liveWorkerIsWaiting) {
            setTimeout(() => { void runWorldAnalysis(db, scope); }, 0);
          }
          res.status(202).json({ status: "resuming", runId: run.id });
          return;
        }
        const savedCheckpoint = recordBody(run.local_checkpoint);
        const hasDurableCheckpoint = Boolean(
          textBody(savedCheckpoint.completedStage, 40),
        );
        if (
          !liveWorkerIsWaiting &&
          !hasDurableCheckpoint &&
          Number(run.progress) > 5
        ) {
          res.status(409).json({
            error: premiumReview
              ? "This Premium Deep Reading was paused before resumable review progress was available. Storyhold did not silently replay it from the beginning. Its saved passage coverage remains intact; start a deliberate new Premium Deep Reading if you want to rebuild it."
              : "This intake was paused before resumable reading progress was available. Storyhold did not silently replay it from the beginning. Its saved discoveries remain intact; start a deliberate new Canon Intake if you want to rebuild it.",
          });
          return;
        }
        const reviewSourceIds = stringArray(run.review_source_ids);
        if (reviewSourceIds.length > 0) {
          await setReviewStatus(
            db,
            run.analysis_kind === "ai_enrichment" ? "ai_enrichment" : "local_scan",
            reviewSourceIds,
            liveWorkerIsWaiting ? "running" : "queued",
          );
        }
        await db.query(
          `UPDATE storyhold.world_analysis_runs
              SET status = $2, pause_requested = false, paused_at = NULL,
                  stage = $3, error = NULL, completed_at = NULL
            WHERE id = $1`,
          [
            run.id,
            liveWorkerIsWaiting ? "running" : "queued",
            premiumReview
              ? liveWorkerIsWaiting
                ? "Resuming Premium Deep Reading"
                : "Restoring saved Premium Deep Reading after restart"
              : liveWorkerIsWaiting
                ? "Resuming Canon Intake"
                : "Restoring saved Canon Intake after restart",
          ],
        );
        await appendIntakeActivity(db, run.id, [{
          dedupeKey: `${run.id}:manual-resume`,
          kind: "source",
          label: premiumReview ? "Premium Deep Reading resumed" : "Canon Intake resumed",
          detail: liveWorkerIsWaiting
            ? premiumReview
              ? "Continuing the optional premium review from its safe processing boundary."
              : "Continuing Canon Intake from the saved processing boundary."
            : hasDurableCheckpoint
              ? premiumReview
                ? "Storyhold restarted while paused. Continuing from the latest saved premium review progress."
                : "Storyhold restarted while paused. Continuing from the latest saved intake progress."
              : premiumReview
                ? "Beginning the premium review that was paused before its first saved step."
                : "Beginning the intake that was paused before its first saved reading step.",
          entityName: null,
          entityType: null,
        }]);
        if (!liveWorkerIsWaiting) {
          setTimeout(() => {
            void runWorldAnalysis(db, {
              runId: run.id,
              worldId,
              editionId: run.canon_edition_id,
              playerId: run.requested_by_player_id,
            });
          }, 0);
        }
        res.status(202).json({ status: "resuming", runId: run.id });
        return;
      }

      const failedRun = await db.query<{
        id: string;
        canon_edition_id: string;
        requested_by_player_id: string;
        review_source_ids: unknown;
        local_checkpoint: unknown;
      }>(
        `SELECT id, canon_edition_id, requested_by_player_id,
                review_source_ids, local_checkpoint
           FROM storyhold.world_analysis_runs
          WHERE world_id = $1 AND status = 'failed'
            AND analysis_kind = 'local_scan'
            AND NOT EXISTS (
              SELECT 1 FROM storyhold.browser_local_audits audit
               WHERE audit.world_id = $1 AND audit.status = 'paused'
            )
          ORDER BY created_at DESC
          LIMIT 1`,
        [worldId],
      );
      if (failedRun.rows[0]) {
        const run = failedRun.rows[0];
        const savedCheckpoint = recordBody(run.local_checkpoint);
        if (!textBody(savedCheckpoint.completedStage, 40)) {
          res.status(409).json({
            code: "INTAKE_CHECKPOINT_UNAVAILABLE",
            error: "This interrupted intake predates resumable progress, so it cannot honestly resume from its displayed percentage. Start a new Canon Intake once; subsequent interruptions will resume from saved work.",
          });
          return;
        }
        const reviewSourceIds = stringArray(run.review_source_ids);
        if (reviewSourceIds.length > 0) {
          await setReviewStatus(db, "local_scan", reviewSourceIds, "queued");
        }
        await db.query(
          `UPDATE storyhold.world_analysis_runs
              SET status = 'queued', pause_requested = false, paused_at = NULL,
                  stage = 'Restoring saved Canon Intake', error = NULL,
                  completed_at = NULL
            WHERE id = $1`,
          [run.id],
        );
        await appendIntakeActivity(db, run.id, [{
          dedupeKey: `${run.id}:failed-run-resume`,
          kind: "source",
          label: "Restoring Saved Canon Intake",
          detail: "Continuing the interrupted source reading from its latest saved progress without creating another intake charge.",
          entityName: null,
          entityType: null,
        }]);
        setTimeout(() => {
          void runWorldAnalysis(db, {
            runId: run.id,
            worldId,
            editionId: run.canon_edition_id,
            playerId: run.requested_by_player_id,
          });
        }, 0);
        res.status(202).json({ status: "resuming", runId: run.id });
        return;
      }

      const pausedAudit = await db.query<{ id: string; charge_status: string }>(
        `SELECT audit.id, audit.charge_status
           FROM storyhold.browser_local_audits audit
           JOIN storyhold.worlds world ON world.id = audit.world_id
          WHERE audit.world_id = $1 AND world.owner_player_id = $2
            AND audit.status = 'paused'
          ORDER BY audit.created_at DESC
          LIMIT 1`,
        [worldId, user.id],
      );
      if (pausedAudit.rows[0]) {
        const audit = pausedAudit.rows[0];
        await resumePausedBrowserLocalAudit(db, audit.id, audit.charge_status);
        res.status(202).json({ status: "resuming", auditId: audit.id });
        return;
      }

      res.status(409).json({ error: "This world does not have a paused intake." });
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/premium-review",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      if (!assertUuid(worldId, res)) return;
      const user = currentUser(req);
      const world = await ownedWorld(db, worldId, user.id);
      if (!world) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await defaultEdition(db, worldId);
      if (!edition) {
        res.status(409).json({ error: "This world does not have a canon edition." });
        return;
      }
      const runtime = getAiRuntimeStatus(
        "canon_review",
        "standard",
        "verification",
      );
      if (!runtime.configured) {
        res.status(503).json({
          error: "Premium AI verification is not connected on this installation.",
        });
        return;
      }
      const running = await db.query<{ id: string }>(
        `SELECT id FROM storyhold.world_analysis_runs
          WHERE world_id = $1 AND status IN ('queued', 'running', 'paused')
          LIMIT 1`,
        [worldId],
      );
      if (running.rows[0]) {
        res.status(409).json({
          error: "This world already has a review in progress.",
          runId: running.rows[0].id,
        });
        return;
      }
      if (await premiumReviewReconciliationPending(db, worldId)) {
        res.status(409).json({
          code: "PREMIUM_RECONCILIATION_REQUIRED",
          error: "A previous premium review was interrupted and is still being checked. Its saved work is preserved, and another premium review cannot start yet.",
        });
        return;
      }
      const local = await db.query<{
        source_count: number;
        chunk_count: number;
        local_ready: boolean;
      }>(
        `SELECT count(DISTINCT s.id)::int AS source_count,
                count(c.id)::int AS chunk_count,
                COALESCE(bool_and(
                  s.local_scan_status IN ('completed', 'not_applicable') AND
                  (s.local_scan_status = 'not_applicable' OR (
                    s.local_scanned_content_hash IS NOT DISTINCT FROM s.content_hash AND
                    s.local_analysis_version >= ${LOCAL_ANALYSIS_VERSION}
                  ))
                ), false) AS local_ready
           FROM storyhold.world_sources s
           LEFT JOIN storyhold.world_source_chunks c ON c.source_id = s.id
          WHERE s.world_id = $1 AND s.canon_edition_id = $2
            AND s.processing_status = 'ready'
            AND s.canon_status IN ('candidate', 'canon')
            AND s.chunk_count > 0`,
        [worldId, edition.id],
      );
      if (
        Number(local.rows[0]?.source_count ?? 0) === 0 ||
        Number(local.rows[0]?.chunk_count ?? 0) === 0
      ) {
        res.status(400).json({
          error: "Upload at least one source with extractable text before premium verification.",
        });
        return;
      }
      if (!local.rows[0]?.local_ready) {
        res.status(409).json({
          error: "Finish Canon Intake before starting Premium Deep Reading.",
        });
        return;
      }
      const browserAudit = await latestBrowserAudit(db, worldId, user.id);
      if (browserAudit && !["completed", "skipped"].includes(browserAudit.status)) {
        res.status(409).json({
          error: browserAudit.status === "failed"
            ? "Resolve or skip the private story review before starting Premium Deep Reading."
            : "The private story review is still running. Let it finish before starting Premium Deep Reading.",
        });
        return;
      }
      const userGuidance = textBody(req.body?.guidance, 4_000);
      await saveOwnerCanonConstraint({
        db,
        worldId,
        editionId: edition.id,
        playerId: user.id,
        instruction: userGuidance,
      });
      await enforceOwnerCanonConstraints({
        db,
        worldId,
        editionId: edition.id,
      });
      const run = await queueWorldAnalysis(db, {
        worldId,
        editionId: edition.id,
        playerId: user.id,
        kind: "ai_enrichment",
        trigger: "manual",
        forceFull: true,
        userGuidance,
      });
      if (!run) {
        res.status(409).json({
          error: "Storyhold could not place the premium review in the queue.",
        });
        return;
      }
      res.status(202).json({ run });
    },
  );

  app.get(
    "/api/storyhold/worlds/:worldId/intake-preflight",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      if (!assertUuid(worldId, res)) return;
      const user = currentUser(req);
      const world = await ownedWorld(db, worldId, user.id);
      if (!world) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await defaultEdition(db, worldId);
      if (!edition) {
        res.status(409).json({ error: "This world does not have a canon edition." });
        return;
      }
      const [preflight, accountResult] = await Promise.all([
        canonIntakePreflight(db, { worldId, editionId: edition.id }),
        db.query<{ role: string; credits: number }>(
          "SELECT role, credits FROM storyhold.players WHERE id = $1 LIMIT 1",
          [user.id],
        ),
      ]);
      const account = accountResult.rows[0];
      const unlimited = account?.role === "owner" || account?.role === "admin";
      const availableCredits = Math.max(0, Number(account?.credits ?? 0));
      res.json({
        ...preflight,
        availableCredits,
        unlimited,
        canStart:
          !preflight.overLimit &&
          (unlimited || availableCredits >= preflight.requiredCredits),
        termsVersion: "2026-08-23",
      });
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/analyze",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      if (!assertUuid(worldId, res)) return;
      const user = currentUser(req);
      const world = await ownedWorld(db, worldId, user.id);
      if (!world) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const edition = await defaultEdition(db, worldId);
      if (!edition) {
        res
          .status(409)
          .json({ error: "This world does not have a canon edition." });
        return;
      }
      const running = await db.query<{ id: string }>(
        "SELECT id FROM storyhold.world_analysis_runs WHERE world_id = $1 AND status IN ('queued', 'running', 'paused') LIMIT 1",
        [worldId],
      );
      if (running.rows[0]) {
        res.status(409).json({
          error: "This world already has an analysis in progress.",
          runId: running.rows[0].id,
        });
        return;
      }
      const available = await db.query<{
        source_count: number;
        chunk_count: number;
        needs_local: boolean;
      }>(
        `SELECT count(DISTINCT s.id)::int AS source_count, count(c.id)::int AS chunk_count,
                bool_or(s.local_scan_status IN ('pending', 'failed') OR
                  (s.local_scan_status = 'completed' AND
                   (s.local_scanned_content_hash IS DISTINCT FROM s.content_hash OR
                    s.local_analysis_version < ${LOCAL_ANALYSIS_VERSION}))) AS needs_local
         FROM storyhold.world_sources s
         LEFT JOIN storyhold.world_source_chunks c ON c.source_id = s.id
        WHERE s.world_id = $1 AND s.canon_edition_id = $2
          AND s.processing_status = 'ready' AND s.canon_status IN ('candidate', 'canon')`,
        [worldId, edition.id],
      );
      if (Number(available.rows[0]?.chunk_count ?? 0) === 0) {
        res.status(400).json({
          error:
            "Upload at least one source with extractable text before analysis.",
        });
        return;
      }
      // This general action is intentionally local-only. Premium review has a
      // separate owner action and must never begin merely because a managed
      // provider became configured between two page loads.
      const userGuidance = textBody(req.body?.guidance, 4_000);
      await saveOwnerCanonConstraint({
        db,
        worldId,
        editionId: edition.id,
        playerId: user.id,
        instruction: userGuidance,
      });
      await enforceOwnerCanonConstraints({
        db,
        worldId,
        editionId: edition.id,
      });
      const kind = generalWorldAnalysisKind();
      if (kind === "local_scan") {
        const [preflight, accountResult] = await Promise.all([
          canonIntakePreflight(db, { worldId, editionId: edition.id }),
          db.query<{ role: string; credits: number }>(
            "SELECT role, credits FROM storyhold.players WHERE id = $1 LIMIT 1",
            [user.id],
          ),
        ]);
        const account = accountResult.rows[0];
        const unlimited = account?.role === "owner" || account?.role === "admin";
        const availableCredits = Math.max(0, Number(account?.credits ?? 0));
        const intakeTermsVersion = textBody(
          req.body?.intakeTermsVersion,
          40,
        );
        if (
          preflight.unpaidSourceCount > 0 &&
          intakeTermsVersion !== "2026-08-23"
        ) {
          res.status(428).json({
            code: "CANON_INTAKE_TERMS_REQUIRED",
            error:
              "Review the current Credits and Canon Intake Policy before starting this paid intake.",
            termsVersion: "2026-08-23",
          });
          return;
        }
        if (preflight.overLimit) {
          res.status(413).json({
            code: "CANON_INTAKE_WORD_LIMIT",
            error: `This world contains ${preflight.wordCount.toLocaleString()} intake words. Canon Intake accepts up to ${preflight.wordLimit.toLocaleString()} words in one world. No credits were used.`,
            ...preflight,
            availableCredits,
          });
          return;
        }
        if (!unlimited && availableCredits < preflight.requiredCredits) {
          res.status(402).json({
            code: "INSUFFICIENT_CANON_INTAKE_CREDITS",
            error: `This Canon Intake needs ${preflight.requiredCredits.toLocaleString()} credits; ${availableCredits.toLocaleString()} are available. The sources are saved, but the reading did not start and no credits were used.`,
            ...preflight,
            availableCredits,
          });
          return;
        }
      }
      const run = await queueWorldAnalysis(db, {
        worldId,
        editionId: edition.id,
        playerId: user.id,
        kind,
        trigger: "manual",
        forceFull: true,
        userGuidance,
      });
      if (!run) {
        res.status(409).json({
          error: "Storyhold could not place this review in the queue.",
        });
        return;
      }
      res.status(202).json({ run });
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/character-drafts/:draftId/review",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      const draftId = routeParam(req, "draftId");
      if (!assertUuid(worldId, res) || !UUID_PATTERN.test(draftId)) return;
      const user = currentUser(req);
      const world = await ownedWorld(db, worldId, user.id);
      if (!world) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const decision = req.body?.decision;
      if (decision !== "approve" && decision !== "reject") {
        res.status(400).json({ error: "Decision must be approve or reject." });
        return;
      }
      const result = await db.query<Record<string, unknown>>(
        "SELECT * FROM storyhold.character_drafts WHERE id = $1 AND world_id = $2 LIMIT 1",
        [draftId, worldId],
      );
      const draft = result.rows[0];
      if (!draft) {
        res.status(404).json({ error: "Character draft not found." });
        return;
      }
      if (draft.review_status !== "draft") {
        res
          .status(409)
          .json({ error: `This draft was already ${draft.review_status}.` });
        return;
      }
      let characterId: string | null = null;
      if (decision === "approve") {
        characterId = randomUUID();
        const initialProfile = {
          source: "approved_world_analysis_draft",
          canonEditionId: draft.canon_edition_id,
          analysisRunId: draft.analysis_run_id,
          role: draft.role,
          summary: draft.summary,
          aliases: draft.aliases,
          ...(draft.profile && typeof draft.profile === "object"
            ? (draft.profile as object)
            : {}),
          evidence: draft.evidence,
        };
        await db.query(
          `INSERT INTO storyhold.characters
            (id, world_id, created_by_player_id, canonical_key, name, initial_profile)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [
            characterId,
            worldId,
            user.id,
            `${slug(String(draft.name))}-${characterId.slice(0, 8)}`,
            draft.name,
            json(initialProfile),
          ],
        );
      }
      await db.query(
        `UPDATE storyhold.character_drafts
            SET review_status = $2, canonical_character_id = $3, reviewed_at = now()
          WHERE id = $1`,
        [
          draftId,
          decision === "approve" ? "approved" : "rejected",
          characterId,
        ],
      );
      res.json({
        status: decision === "approve" ? "approved" : "rejected",
        characterId,
      });
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/cohesion-proposals/:proposalId/review",
    requireUser,
    async (req: StudioRequest, res) => {
      const worldId = routeParam(req, "worldId");
      const proposalId = routeParam(req, "proposalId");
      if (!assertUuid(worldId, res) || !UUID_PATTERN.test(proposalId)) return;
      const user = currentUser(req);
      const world = await ownedWorld(db, worldId, user.id);
      if (!world) {
        res.status(404).json({ error: "World not found." });
        return;
      }
      const decision = req.body?.decision;
      const classification = textBody(req.body?.classification, 80);
      if (decision !== "approve" && decision !== "dismiss") {
        res
          .status(400)
          .json({ error: "Decision must be approve or dismiss." });
        return;
      }
      if (
        decision === "approve" &&
        !COHESION_CLASSIFICATIONS.has(classification)
      ) {
        res.status(400).json({
          error: "Choose how this continuity issue should be classified.",
        });
        return;
      }
      const proposal = await db.query<{ review_status: string }>(
        `SELECT review_status FROM storyhold.cohesion_proposals
          WHERE id = $1 AND world_id = $2
          LIMIT 1`,
        [proposalId, worldId],
      );
      if (!proposal.rows[0]) {
        res.status(404).json({ error: "Cohesion proposal not found." });
        return;
      }
      if (proposal.rows[0].review_status !== "pending") {
        res.status(409).json({ error: "That proposal was already reviewed." });
        return;
      }
      await db.query(
        `UPDATE storyhold.cohesion_proposals
            SET review_status = $2, classification = $3,
                reviewed_by_player_id = $4, reviewed_at = now()
          WHERE id = $1`,
        [
          proposalId,
          decision === "approve" ? "approved" : "dismissed",
          decision === "approve" ? classification : null,
          user.id,
        ],
      );
      res.json({
        status: decision === "approve" ? "approved" : "dismissed",
        classification: decision === "approve" ? classification : null,
        canonChanged: false,
      });
    },
  );
}

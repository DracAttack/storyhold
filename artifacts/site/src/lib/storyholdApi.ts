import type { CampaignRpgStateViewModel } from "./campaignRpgState";

const apiBase = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/storyhold`;

export type StoryholdProviderId =
  | "anthropic"
  | "openai"
  | "xai"
  | "kimi"
  | "openrouter";

export type StoryholdInferenceStage =
  | "extraction"
  | "verification"
  | "dossier"
  | "chronology"
  | "director"
  | "narration"
  | "adaptation";

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
    connectionSource:
      | "storyhold_managed"
      | "installation_byo"
      | "player_byo"
      | null;
    billingSource: "storyhold_credits" | "external_provider" | null;
  } | null;
  localExtraction: {
    enabled: boolean;
    configured: boolean;
    provider: "storyhold-local" | "gliner1" | "gliner2";
    model: string;
    endpoint: string | null;
    endpointKind: "loopback" | "remote" | null;
    sendsSourceTextOffDevice: boolean;
    explanation: string;
  };
  providers: Array<{
    id: StoryholdProviderId;
    label: string;
    configured: boolean;
    model: string;
    supportsReasoningControl: boolean;
    eligibleForAdultNarration: boolean;
  }>;
  routing: {
    director: StoryholdProviderId | null;
    narration: StoryholdProviderId | null;
    adultNarration: StoryholdProviderId | null;
    analysis: StoryholdProviderId | null;
    canonReview: StoryholdProviderId | null;
  };
  stageRouting: Record<StoryholdInferenceStage, StoryholdProviderId | null>;
};

export type ResolutionMode =
  | "story_first"
  | "light_rules"
  | "tactical"
  | "custom";

export type WorldContract = {
  identity: string;
  premise: string;
  tone: string;
  startingPoint: string;
  constraints: string[];
  exclusions: string[];
  worldRules: string[];
  playerPriorities: string[];
};

export type ContentSettings = {
  sexualContent: "off" | "fade_to_black" | "explicit";
  violence: "standard" | "graphic";
};

export type WorldSummary = {
  id: string;
  canonicalKey: string;
  name: string;
  premise: string;
  description: string;
  genre: string;
  metadataInferenceStatus: "manual" | "requested" | "generated";
  creationMode: "import" | "quickstart" | "manual";
  worldContract: WorldContract;
  contractStatus: "draft" | "locked";
  worldClockName: string;
  resolutionMode: ResolutionMode;
  contentSettings: ContentSettings;
  createdAt: string;
  updatedAt: string;
  sourceCount: number;
  wordCount: number;
  chunkCount: number;
  peopleCount: number;
  characterDraftCount: number;
  approvedCharacterCount: number;
  waitingAiReviewCount: number;
  pendingCohesionCount: number;
  unresolvedDiscrepancyCount: number;
  canonAmendmentCount: number;
  campaignCount: number;
  visibleClockEventCount: number;
  latestAnalysisStatus: string | null;
};

export type WorldSource = {
  id: string;
  canonicalKey: string;
  title: string;
  originalFilename: string;
  mediaType: string;
  documentType: string;
  sourceClass: string;
  canonStatus: string;
  sourceKind:
    | "manuscript"
    | "character_sheet"
    | "setting_guide"
    | "ruleset"
    | "timeline"
    | "notes"
    | "reference"
    | "other";
  chronologyOrder: number;
  chronologyRelation:
    | "origin"
    | "continues"
    | "precedes"
    | "parallel"
    | "overlaps"
    | "alternate"
    | "reference"
    | "unspecified";
  chronologyLabel: string;
  chronologyNotes: string;
  referenceKnowledgeScope?: ReferenceKnowledgeScope;
  referenceKnownBy?: string[];
  referenceLoreStatus?: ReferenceLoreStatus;
  fileAsChapter?: boolean;
  relativePath?: string;
  importBatchId?: string | null;
  importBatchPosition?: number | null;
  importBatchSize?: number | null;
  extractionQualitySeverity?: "ok" | "warning" | "critical";
  extractionDiagnostics?: {
    severity?: "ok" | "warning" | "critical";
    messages?: string[];
    metrics?: Record<string, number>;
  };
  chronologyReviewStatus: "unreviewed" | "reviewed";
  byteSize: number;
  wordCount: number;
  charCount: number;
  chunkCount: number;
  pageCount: number | null;
  extractionMethod: string | null;
  processingStatus: "ready" | "failed";
  processingError: string | null;
  localScanStatus:
    | "pending"
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "not_applicable";
  localScannedAt: string | null;
  aiReviewStatus:
    | "waiting"
    | "queued"
    | "running"
    | "reviewed"
    | "failed"
    | "not_applicable";
  aiAnalysisVersion: number;
  aiReviewProvider: string | null;
  aiReviewModel: string | null;
  aiReviewedAt: string | null;
  aiReviewedChunkCount: number;
  createdAt: string;
};

export type EvidenceReference = {
  chunkId: string;
  sourceId: string;
  quote: string;
  sectionTitle?: string | null;
  perspective?: string | null;
};
export type NamedFinding = {
  name: string;
  summary: string;
  evidence: EvidenceReference[];
  aliases?: string[];
  details?: string[];
  relationships?: string[];
  factionMemberships?: string[];
  estimatedStats?: Record<CharacterStatName, CharacterStatEstimate>;
  confidence?: number;
  mentionCount?: number;
  mentionSourceCount?: number;
  reviewStatus?: "candidate" | "verified";
};

export type WorldBreakdown = {
  id: string;
  version: number;
  status: string;
  provider: string;
  model: string;
  summary: string;
  genres: string[];
  atmosphere: string[];
  themes: string[];
  worldRules: NamedFinding[];
  locations: NamedFinding[];
  factions: NamedFinding[];
  institutions: NamedFinding[];
  governments: NamedFinding[];
  powerStructures: NamedFinding[];
  creatures: NamedFinding[];
  species: NamedFinding[];
  technologies: NamedFinding[];
  vehicles: NamedFinding[];
  devices: NamedFinding[];
  weapons: NamedFinding[];
  powers: NamedFinding[];
  titles: NamedFinding[];
  ambiguous: NamedFinding[];
  chronology: NamedFinding[];
  openQuestions: string[];
  recurringTerms: string[];
  createdAt: string;
};

export type CharacterDraft = {
  id: string;
  canonicalKey: string;
  name: string;
  aliases: string[];
  role: string;
  summary: string;
  profile: {
    traits?: string[];
    motivations?: string[];
    fears?: string[];
    capabilities?: string[];
    relationships?: string[];
    knowledge?: string[];
    secrets?: string[];
  };
  evidence: EvidenceReference[];
  confidence: number;
  reviewStatus: "draft" | "approved" | "rejected";
  canonicalCharacterId: string | null;
  createdAt: string;
  reviewedAt: string | null;
};

export type CharacterStatName =
  | "strength"
  | "dexterity"
  | "constitution"
  | "intelligence"
  | "wisdom"
  | "charisma"
  | "acrobatics";

export type CharacterStatEstimate = {
  score: number;
  confidence: number;
  rationale: string;
  evidence: EvidenceReference[];
};

export type SocioPoliticalAxis = {
  economic: number;
  authority: number;
  label: string;
  rationale: string;
  confidence: number;
};

export type DossierCompassPerspective = "demonstrated_behavior" | "self_description" | "others_interpretation" | "mixed";
export type DossierCompassReview = {
  status: "supported" | "needs_evidence" | "needs_attention" | "not_reviewed" | "author_controlled";
  estimate?: {
    economic: number; authority: number; label: string; rationale: string;
    validFromLabel: string; validUntilLabel: string;
    perspective: DossierCompassPerspective; epistemicHolderId: string | null; epistemicHolderName?: string;
  };
  explanation?: string;
  evidence: Array<{ chunkId: string; sourceId: string; quote: string; axes?: string[]; perspective?: DossierCompassPerspective }>;
  retrievalRequests?: string[];
};

export type CharacterRelationship = {
  name: string;
  relationship: string;
  summary: string;
  sentiment:
    | "allied"
    | "hostile"
    | "mixed"
    | "familial"
    | "romantic"
    | "professional"
    | "unknown";
  evidence: EvidenceReference[];
  relatedCharacterId?: string | null;
};

export type DossierProseReview = {
  fields: Array<{
    field: string;
    status: "verified" | "supported" | "needs_attention" | "needs_evidence" | "partial" | "not_reviewed" | "author_controlled";
    verifiedItems: number;
    totalItems: number;
    reviewedItems?: number;
    sourceCheckedItems?: number;
    items: Array<{
      text: string;
      status: "verified" | "supported" | "needs_attention" | "needs_evidence" | "not_reviewed" | "author_controlled";
      evidence: Array<{ chunkId: string; sourceId: string; quote: string }>;
      confidence?: number;
      reviewBasis?: "canonical_claim" | "existing_text_audit";
      explanation?: string;
      retrievalRequests?: string[];
    }>;
  }>;
};

export type CharacterDossier = {
  id: string;
  canonicalKey: string;
  canonicalCharacterId: string | null;
  name: string;
  aliases: string[];
  aliasAttributions: CharacterAliasAttribution[];
  role: string;
  summary: string;
  profile: {
    traits: string[];
    motivations: string[];
    fears: string[];
    capabilities: string[];
    history: string[];
    origins: string[];
    powers: string[];
    moralSystem: string[];
    physicalCharacteristics: string[];
    relationships: string[];
    relationshipWeb: CharacterRelationship[];
    knowledge: string[];
    secrets: string[];
    estimatedStats: Record<CharacterStatName, CharacterStatEstimate>;
  };
  evidence: EvidenceReference[];
  confidence: number;
  mentionCount: number;
  mentionSourceCount: number;
  socioPoliticalAxis: SocioPoliticalAxis;
  socioPoliticalAxisEstimate: SocioPoliticalAxis;
  socioPoliticalAxisChanged: boolean;
  socioPoliticalAxisChangedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CharacterAliasAttribution = {
  alias: string;
  kind:
    | "familiar_name"
    | "formal_address"
    | "honorific"
    | "nickname"
    | "descriptive_reference"
    | "owner_canon";
  attributedBy: string | null;
  explanation: string;
  temporalScope: "single_scene" | "ongoing" | "unknown";
  semanticLimits: string[];
  quote: string;
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  chapterTitle: string;
  confidence: number;
};

export type WorldEntityType =
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

export type WorldEntityRelationType =
  | "member_of"
  | "participates_in"
  | "species_of"
  | "subspecies_of"
  | "subtype_of"
  | "lifecycle_stage_of"
  | "has_power"
  | "has_form"
  | "holds_title"
  | "child_of"
  | "sibling_of"
  | "spouse_of"
  | "friend_of"
  | "best_friend_of"
  | "leads"
  | "governs"
  | "controlled_by"
  | "allied_with"
  | "opposed_to"
  | "located_in"
  | "part_of"
  | "created_by"
  | "related_to";

export type WorldEntity = {
  id: string;
  canonicalKey: string;
  dossierId: string | null;
  name: string;
  entityType: WorldEntityType;
  aliases: string[];
  summary: string;
  details: string[];
  relationships: string[];
  estimatedStats: Record<CharacterStatName, CharacterStatEstimate> | null;
  evidence: EvidenceReference[];
  mentionCount: number;
  mentionSourceCount: number;
  mentionCountStatus: "exact" | "derived" | "manual" | "no_exact_mentions";
  confidence: number;
  classificationSource: "local" | "ai" | "user";
  reviewStatus: "candidate" | "verified" | "user_confirmed";
  pullStatus: "active" | "do_not_pull" | "merged" | "deleted";
  mergedIntoEntityId: string | null;
  factions: Array<{
    id: string;
    name: string;
    assignmentSource: "local" | "ai" | "user";
    confidence: number;
  }>;
  createdAt: string;
  updatedAt: string;
};

export type WorldEntityAction = {
  id: string;
  actionType: "merge";
  summary: string;
  createdAt: string;
  undoneAt: string | null;
};

export type WorldEntityRelation = {
  id: string;
  sourceEntityId: string;
  sourceName: string;
  sourceType: WorldEntityType;
  relationType: WorldEntityRelationType;
  targetEntityId: string;
  targetName: string;
  targetType: WorldEntityType;
  status: "active" | "former" | "conditional" | "disputed" | "unknown";
  summary: string;
  validFromLabel: string;
  validUntilLabel: string;
  evidence: EvidenceReference[];
  assignmentSource: "local" | "ai" | "user";
  confidence: number;
  createdAt: string;
  updatedAt: string;
};

export type WorldEntityRule = {
  id: string;
  entityId: string;
  canonicalKey: string;
  name: string;
  description: string;
  ruleKind: "trait" | "ability" | "constraint" | "biological" | "social" | "gameplay";
  trigger: string;
  effect: string;
  evidence: EvidenceReference[];
  assignmentSource: "local" | "ai" | "user";
  confidence: number;
  status: "active" | "disputed" | "retired";
  createdAt: string;
  updatedAt: string;
};

export type StoryConceptCluster = {
  id: string;
  entityId: string | null;
  preferredLabel: string;
  entityType: WorldEntityType;
  labels: string[];
  mentionCount: number;
  sourceCount: number;
  chapterCount: number;
  score: number;
  scoreBreakdown: {
    explicitWording: number;
    chapterSpread: number;
    sourceSpread: number;
    evidenceDensity: number;
    categoryConsistency: number;
    relationshipSupport: number;
    contradictionPenalty: number;
    total: number;
  };
  resolutionStatus: "candidate" | "proposed" | "verified" | "ambiguous" | "rejected" | "merged";
  resolutionSource: "local" | "ai" | "user";
  alternatives: Array<{ entityId: string; name: string; entityType: string; sharedLabels: string[] }>;
  evidence: EvidenceReference[];
  updatedAt?: string;
};

export type StoryRelationHypothesis = {
  id: string;
  subjectEntityId: string;
  subjectName: string;
  relationType: string;
  targetEntityId: string;
  targetName: string;
  interpretation: "literal" | "figurative" | "belief" | "rumor" | "mistaken" | "disputed" | "former";
  status: "candidate" | "verified" | "rejected";
  score: number;
  evidence: EvidenceReference[];
  explanation: string;
  constraintIds: string[];
};

export type OwnerCanonConstraint = {
  id: string;
  entityId: string | null;
  kind: "identity" | "relationship" | "category" | "chronology" | "fact" | "focus";
  instruction: string;
  status: "active" | "superseded" | "dismissed";
  createdAt?: string;
};

export type EntityAiReviewDepth = "focused" | "full";

export type EntityReviewRetrievalExpansion = {
  searchedItems: number;
  addedPassages: number;
  noMatchItems: number;
  budgetDeferredItems: number;
  alreadyCoveredItems: number;
  skippedReviews: number;
};

export type EntityAiReviewQuote = {
  quoteId: string;
  depth: EntityAiReviewDepth;
  /** Continue the original review without repeating completed model requests. */
  resume?: boolean;
  /** Missing parts of a paged review; zero means apply already saved output only. */
  remainingPages?: number;
  /** Original review directions, frozen when resuming a saved review. */
  guidance?: string;
  requiredCredits: number;
  availableCredits: number;
  unlimited: boolean;
  passageCount: number;
  sourceCount: number;
  provider: string;
  model: string;
  executionMode: "connected" | "browser_qwen" | "local_qwen";
  /** Read-only source-search results, not conclusions about dossier accuracy. */
  retrievalExpansion?: EntityReviewRetrievalExpansion;
  entityType: string;
  selectedPassages: Array<{
    chunkId: string;
    sourceId: string;
    sourceTitle: string;
    passageNumber: number;
    excerpt: string;
    nameMatches: number;
    guidanceTerms: string[];
  }>;
};

export type AnalysisRun = {
  id: string;
  provider: string;
  model: string;
  status: "queued" | "running" | "paused" | "completed" | "failed";
  stage: string;
  progress: number;
  sourceCount: number;
  chunkCount: number;
  error: string | null;
  analysisKind: "local_scan" | "ai_enrichment";
  trigger: "upload" | "backfill" | "manual";
  incremental: boolean;
  analysisVersion: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  synthesisStatus?: "not_applicable" | "pending" | "completed" | "failed";
  synthesisError?: string | null;
  synthesisGroupCount?: number;
  synthesisCompletedGroups?: number;
  localExtractionStatus?: "disabled" | "not_run" | "completed" | "partial" | "failed";
  localExtractionProvider?: string | null;
  localExtractionModel?: string | null;
  localExtractionAttemptedSegments?: number;
  localExtractionCompletedSegments?: number;
  localExtractionFailedSegments?: number;
  localExtractionMentionCount?: number;
  localExtractionRelationCount?: number;
  localExtractionClassificationCount?: number;
  localExtractionSignalCount?: number;
  localExtractionElapsedMilliseconds?: number;
  localExtractionError?: string | null;
  localCheckpointStage?: string | null;
  premiumResumeStatus?: "not_available" | "ready" | "blocked";
  localCheckpointSavedAt?: string | null;
  pauseRequested?: boolean;
  pausedAt?: string | null;
  intakePreview?: {
    phase: "deterministic" | "semantic" | "complete" | "fallback";
    extractor: string;
    completedPassages: number;
    totalPassages: number;
    message: string;
    terms: Array<{
      name: string;
      category: WorldEntityType;
      confidence: number;
      mentionCount: number;
      sourceCount: number;
      reviewStatus: "candidate" | "verified";
    }>;
  } | null;
  intakeActivity?: Array<{
    id: string;
    dedupeKey: string;
    kind:
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
    label: string;
    detail: string;
    entityName: string | null;
    entityType: WorldEntityType | null;
    occurredAt: string;
  }>;
};

export type CanonIntakePreflight = {
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
  availableCredits: number;
  unlimited: boolean;
  canStart: boolean;
  termsVersion: string;
};

export type BrowserAuditCandidate = {
  candidateKey: string;
  kind: "concept" | "character" | "relationship" | "claim" | "event" | "rule";
  category: string;
  name: string;
  summary: string;
  aliases: string[];
  evidence: EvidenceReference[];
};

export type BrowserAuditBatch = {
  auditId: string;
  batchIndex: number;
  totalBatches: number;
  candidates: BrowserAuditCandidate[];
};

export type BrowserLocalAudit = {
  id: string;
  status: "pending" | "running" | "paused" | "completed" | "skipped" | "failed";
  model: string;
  totalCandidates: number;
  totalBatches: number;
  completedBatches: number;
  progress: number;
  stage: string;
  error: string | null;
  chargeStatus: "pending" | "reserved" | "settled" | "unlimited" | "released";
  missingQueries: string[];
  nextBatch: BrowserAuditBatch | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

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

export type BrowserAuditResult = {
  audits: Array<{
    candidateKey: string;
    verdict: "confirm" | "reclassify" | "merge" | "reject" | "uncertain";
    correctedName: string;
    correctedCategory: string;
    aliases: string[];
    interpretation: string;
    concerns: string[];
    confidence: number;
  }>;
  missingQueries: string[];
};

export type WorldQualityFinding = {
  id: string;
  category:
    | "coverage"
    | "evidence"
    | "character"
    | "chronology"
    | "relationship"
    | "contradiction";
  severity: "info" | "warning" | "critical";
  subjectKind: string;
  subjectId: string | null;
  label: string;
  explanation: string;
  recommendedTask: string;
  metadata: Record<string, unknown>;
  status: "open" | "resolved" | "ignored";
  firstDetectedAt: string;
  lastDetectedAt: string;
  resolvedAt: string | null;
};

export type WorldExternalReference = {
  id: string;
  query: string;
  title: string;
  url: string;
  publisher: string;
  summary: string;
  keywords: string[];
  discoveredBy: "user" | "codex" | "perplexity";
  reviewStatus: "candidate" | "approved" | "rejected";
  extractionStatus: "pending" | "ready" | "failed";
  extractionMethod: string | null;
  qualityScore: number | null;
  qualityFlags: string[];
  wordCount: number;
  usePolicy: "background_only";
  knowledgeScope: ReferenceKnowledgeScope;
  knownBy: string[];
  loreStatus: ReferenceLoreStatus;
  processingError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ReferenceKnowledgeScope =
  | "director_only"
  | "common"
  | "selected"
  | "discoverable";

export type ReferenceLoreStatus =
  | "official"
  | "licensed"
  | "supplemental"
  | "homebrew"
  | "disputed";

export type CohesionProposal = {
  id: string;
  kind:
    | "contradiction"
    | "duplicate"
    | "timeline"
    | "identity"
    | "continuity"
    | "ambiguity";
  subject: string;
  summary: string;
  severity: "info" | "warning" | "conflict";
  evidence: EvidenceReference[];
  reviewStatus: "pending" | "approved" | "dismissed";
  classification: string | null;
  createdAt: string;
  reviewedAt: string | null;
};

export type DiscrepancyAmendment = {
  subject: string;
  statement: string;
  operation: "clarify" | "correct" | "invalidate" | "supersede";
  previousStatement: string;
};

export type CanonDiscrepancyReport = {
  id: string;
  canonicalKey: string;
  campaignId: string | null;
  claim: string;
  reasoning: string;
  status: "needs_reason" | "correction_offered" | "applied" | "rejected";
  explanation: string;
  confidence: number;
  proposedAmendment: DiscrepancyAmendment | null;
  evidence: EvidenceReference[];
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
};

export type CanonAmendment = {
  id: string;
  canonicalKey: string;
  campaignId: string | null;
  subject: string;
  operation: "clarify" | "correct" | "invalidate" | "supersede";
  statement: string;
  previousStatement: string;
  rationale: string;
  evidence: EvidenceReference[];
  decisionSource: "source_evidence" | "reasoned_consistency";
  createdAt: string;
};

export type WorldClockEvent = {
  id: string;
  canonicalKey: string;
  campaignId: string | null;
  sourceId: string | null;
  causalParentId: string | null;
  eventKind:
    | "canon"
    | "scene"
    | "commitment"
    | "reminder"
    | "discovery"
    | "state_change"
    | "scheduled_effect"
    | "ruling";
  title: string;
  summary: string;
  worldTimeLabel: string;
  chronologyOrder: number;
  temporalStatus?: "exact" | "relative" | "uncertain" | "parallel";
  importance?: "major" | "turning_point";
  sourceChapterKeys?: string[];
  causalLinks?: Array<{
    id: string;
    direction: "incoming" | "outgoing";
    relationType:
      | "causes"
      | "enables"
      | "prevents"
      | "parallel_with"
      | "contradicts"
      | "supersedes"
      | "retells";
    otherEventId: string;
    otherEventTitle: string;
    summary: string;
    evidence: EvidenceReference[];
    confidence: number;
  }>;
  visibility: "world" | "campaign" | "character";
  /**
   * The event's canon standing. These fields are optional so worlds saved
   * before truth-aware clock reviews remain readable.
   */
  truthStatus?: "fact" | "belief" | "rumor" | "lie" | "disputed" | "unknown";
  epistemicHolderEntityId?: string | null;
  epistemicHolderName?: string | null;
  knowledgeStatus:
    | "observed"
    | "told"
    | "inferred"
    | "disputed"
    | "revealed";
  knownEffects: string[];
  evidence: EvidenceReference[];
  scheduledForLabel: string;
  dueWorldTimeMinutes?: number | null;
  dueTurnNumber?: number | null;
  maturedAt?: string | null;
  status: "committed" | "scheduled" | "resolved" | "cancelled" | "superseded";
  createdAt: string;
};

export type WorldChapterSummary = {
  id: string;
  canonicalKey: string;
  sourceId: string;
  sourceTitle: string;
  sourceChronologyLabel: string;
  sourceChronologyOrder: number;
  chapterTitle: string;
  perspective: string;
  sourceOrder: number;
  summary: string;
  majorEvents: string[];
  evidence: EvidenceReference[];
  summarySource: "local" | "ai" | "user";
  confidence: number;
  createdAt: string;
  updatedAt: string;
};

export type CampaignSummary = {
  id: string;
  canonicalKey: string;
  name: string;
  characterId: string | null;
  characterName: string | null;
  startContract: Record<string, unknown>;
  startLockedAt: string;
  currentTimeLabel: string;
  worldTimeMinutes: number;
  resolutionMode: ResolutionMode;
  status: "active" | "paused" | "completed" | "archived";
  eventCount: number;
  createdAt: string;
};

export type CampaignInputMode = "action" | "question" | "event";
export type LorekeeperFeedbackTag =
  | "pacing"
  | "canon"
  | "continuity"
  | "lore"
  | "character_voice"
  | "challenge"
  | "creativity"
  | "description"
  | "prose"
  | "consequences";

export type CampaignExperienceMode = "author" | "solo";

export type CampaignTurnFeedback = {
  rating: -1 | 1;
  tags: LorekeeperFeedbackTag[];
  note: string;
  updatedAt: string | null;
};

export type CampaignCheckProjection = {
  mode: ResolutionMode;
  result?: {
    outcome: "success" | "mixed" | "failure" | "uncertain" | "none";
    band?: string;
    certainty?: string;
  };
  difficulty?: "trivial" | "easy" | "standard" | "hard" | "severe" | "extreme";
  factors?: Array<{
    label: string;
    influence: "helps" | "hinders" | "neutral";
  }>;
  numbers?: {
    modifier: number;
    percentile: number | null;
    effectivePercentile: number | null;
    d20?: number | null;
  };
  breakdown?: Array<{
    source: string;
    sourceId: string;
    label: string;
    value: number;
  }>;
};

export type CampaignTurn = {
  id: string;
  turnNumber: number;
  playerId?: string;
  playerName?: string | null;
  characterId?: string | null;
  characterName?: string | null;
  inputMode?: CampaignInputMode;
  playerAction: string;
  narration: string;
  sceneSummary: string;
  outcome: "success" | "mixed" | "failure" | "uncertain" | "none";
  worldTimeLabel: string;
  reasoning: "low" | "medium" | "high";
  provider: string;
  model: string;
  roll: { percentile: number; d20: number | null } | null;
  check?: CampaignCheckProjection | null;
  feedback: CampaignTurnFeedback | null;
  createdAt: string;
};

export type CampaignTurnProposal = {
  id: string;
  requestId: string;
  playerAction: string;
  inputMode: CampaignInputMode;
  narration: string;
  sceneSummary: string;
  outcome: CampaignTurn["outcome"];
  worldTimeLabel: string;
  timeAdvanceMinutes: number;
  revision: number;
  status: "pending" | "accepted" | "discarded" | "superseded" | "expired";
  baseStateVersion: number;
  creditsUsed: number;
  rerolledFromProposalId: string | null;
  browserNarrationTask: {
    proposalId: string;
    playerInput: string;
    inputMode: CampaignInputMode;
    direction: Record<string, unknown>;
  } | null;
  director: { provider: string; model: string; reasoning: string };
  narrator: { provider: string; model: string; reasoning: string };
  roll: { percentile: number; d20: number | null } | null;
  check?: CampaignCheckProjection | null;
  createdAt: string;
  updatedAt: string;
};

export type CampaignCheckpoint = {
  id: string;
  name: string;
  note: string;
  turnId: string | null;
  stateVersion: number;
  worldTimeMinutes: number;
  worldTimeLabel: string;
  createdAt: string;
};

export type CampaignBranch = {
  id: string;
  checkpointId: string;
  parentBranchId: string | null;
  name: string;
  mode: "writer" | "alternate";
  status: "draft" | "archived";
  requestId: string;
  creditsCharged: number;
  playableCampaignId: string | null;
  activatedAt: string | null;
  checkpointName: string;
  checkpointNote: string;
  stateVersion: number;
  worldTimeLabel: string;
  lastSceneSummary: string;
  createdAt: string;
  updatedAt: string;
};

export type CampaignBranchLineageNode = {
  branchId: string;
  branchName: string;
  mode: "writer" | "alternate";
  sourceCampaignId: string;
  sourceCampaignName: string;
  checkpointId: string;
  checkpointName: string;
  checkpointNote: string;
  stateVersion: number;
  worldTimeLabel: string;
  createdAt: string;
};

export type CampaignPlaySession = {
  /** Approved opening and progress only; private preparation stays on the server. */
  adventureSetup?: import("./adventureSetupApi").AdventureSetupStatus;
  /** Server-owned live-play policy; intake/browser preferences cannot override it. */
  executionPolicy?: {
    mode: "ai_led" | "manual";
    browserAssist: false;
    localInference: false;
  };
  /** Set by the server only for authorized local test sessions. */
  manualStorytellerEnabled?: boolean;
  pendingManualTurn?: import("./manualStorytellerApi").ManualTurnSummary | null;
  campaign: {
    id: string;
    worldId: string;
    worldName: string;
    name: string;
    characterId: string | null;
    characterName: string | null;
    currentTimeLabel: string;
    worldTimeMinutes: number;
    resolutionMode: ResolutionMode;
    experienceMode: CampaignExperienceMode;
    status: "active" | "paused" | "completed" | "archived";
    stateVersion: number;
    startLockedAt: string;
    lockedSettings: {
      worldContract: Record<string, unknown>;
      contentSettings: Record<string, unknown>;
      storyPreferences: Record<string, unknown>;
      character: Record<string, unknown>;
      startingPoint: string;
      resolutionMode: ResolutionMode;
      experienceMode: CampaignExperienceMode;
    };
  };
  turns: CampaignTurn[];
  clockEvents: WorldClockEvent[];
  knownState: Array<{
    id: string;
    kind: string;
    subject: string;
    summary: string;
    layer: string;
    stance?: string;
    confidence?: number;
    stateVersion: number;
  }>;
  /** Present only for campaigns with a player-safe RPG projection. */
  rpgState?: CampaignRpgStateViewModel;
  pendingProposal: CampaignTurnProposal | null;
  pendingTurnRequest: {
    requestId: string;
    action: string;
    inputMode: CampaignInputMode;
    createdAt: string;
  } | null;
  checkpoints: CampaignCheckpoint[];
  branches: CampaignBranch[];
  lineage: CampaignBranchLineageNode[];
  credits: number;
  unlimitedCredits: boolean;
  productPricing: {
    rerollCredits: number;
    branchCredits: number;
  };
  runtime: AiRuntimeStatus;
};

export type CampaignStoryBeat = {
  id: string;
  turnNumber: number;
  playerAction: string;
  narration: string;
  sceneSummary: string;
  outcome: CampaignTurn["outcome"];
  worldTimeLabel: string;
  consequences: Array<{ kind: string; subject: string; summary: string }>;
  storyMoves: Array<{ kind: string; summary: string }>;
  createdAt: string;
};

export type CampaignStoryDraft = {
  id: string;
  campaignId: string;
  title: string;
  status: "draft" | "complete" | "archived";
  sourceTurnIds: string[];
  sourceStateVersion: number;
  sourceHash: string;
  settings: {
    pov?: "first_person" | "third_limited" | "third_omniscient";
    tense?: "past" | "present";
    length?: "scene" | "chapter";
    fidelity?: "strict" | "novelistic";
    voiceNotes?: string;
  };
  chapterSummary: string;
  outline: Array<{ turnId: string; heading: string; purpose: string }>;
  prose: string;
  adaptationNotes: string[];
  provider: string;
  model: string;
  creditsCharged: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type CampaignStoryPendingAdaptation = {
  requestId: string;
  turnIds: string[];
  title: string;
  settings: {
    pov: "first_person" | "third_limited" | "third_omniscient";
    tense: "past" | "present";
    length: "scene" | "chapter";
    fidelity: "strict" | "novelistic";
    voiceNotes: string;
  };
  createdAt: string;
};

export type CampaignStorySession = {
  campaign: {
    id: string;
    worldId: string;
    worldName: string;
    name: string;
    characterName: string | null;
    stateVersion: number;
  };
  storyBeats: CampaignStoryBeat[];
  drafts: CampaignStoryDraft[];
  pendingAdaptation: CampaignStoryPendingAdaptation | null;
  limits: { maxSelectedTurns: number };
  credits: number;
  unlimitedCredits: boolean;
  runtime: AiRuntimeStatus;
};

export type StoryPreferences = {
  adultEnabled: boolean;
  ageAttestedAt: string | null;
  ageAttestationVersion: string | null;
  sexualContentLevel: "off" | "fade_to_black" | "explicit";
  violenceLevel: "standard" | "graphic";
  narrativeLength: "concise" | "balanced" | "expansive";
  anonymousLearningEnabled: boolean;
  localModelTrainingEnabled: boolean;
  updatedAt: string | null;
};

export type WorldDetail = {
  world: WorldSummary;
  edition: {
    id: string;
    canonicalKey: string;
    name: string;
    timelineAnchor: string;
    status: string;
    chronologyStatus: "draft" | "reviewed";
    chronologySummary: string;
    chronologyReviewedAt: string | null;
    createdAt: string;
  };
  sources: WorldSource[];
  breakdown: WorldBreakdown | null;
  latestRun: AnalysisRun | null;
  latestBrowserAudit?: BrowserLocalAudit | null;
  intakePipeline: WorldIntakePipeline;
  qualityFindings?: WorldQualityFinding[];
  externalReferences?: WorldExternalReference[];
  referenceResearch?: { configured: boolean; provider: "perplexity" | null };
  authorModeAccess: {
    eligible: boolean;
    manuscriptWordCount: number;
    uploadedManuscriptWordCount: number;
    qualifiedSourceCount: number;
    rejectedSourceCount: number;
    sourceAssessments: Array<{
      sourceId: string;
      title: string;
      wordCount: number;
      qualifyingWordCount: number;
      qualifies: boolean;
      score: number;
      reasons: string[];
      explanation: string;
    }>;
    requiredManuscriptWords: number;
    requiredStoryDraftWords: number;
    requiredStoryDraftTurns: number;
    unlockedBy: "manuscript" | "story_draft" | null;
  };
  characterDrafts: CharacterDraft[];
  characterDossiers: CharacterDossier[];
  entities: WorldEntity[];
  entityRelations: WorldEntityRelation[];
  entityRules: WorldEntityRule[];
  entityActions: WorldEntityAction[];
  conceptClusters?: StoryConceptCluster[];
  relationshipHypotheses?: StoryRelationHypothesis[];
  canonConstraints?: OwnerCanonConstraint[];
  cohesionProposals: CohesionProposal[];
  discrepancyReports: CanonDiscrepancyReport[];
  canonAmendments: CanonAmendment[];
  campaigns: CampaignSummary[];
  worldClockEvents: WorldClockEvent[];
  chapterSummaries: WorldChapterSummary[];
  canonicalCharacters: Array<{
    id: string;
    canonicalKey: string;
    name: string;
    initialProfile: Record<string, unknown>;
    lockedAt: string;
    createdAt: string;
  }>;
  ai: AiRuntimeStatus;
  /** Dedicated managed verifier used by owner-started Premium Deep Reading. */
  premiumAi?: AiRuntimeStatus;
};

export class StoryholdApiError extends Error {
  status: number;
  payload: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    payload: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "StoryholdApiError";
    this.status = status;
    this.payload = payload;
  }
}

async function responseJson<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    throw new StoryholdApiError(
      typeof payload.error === "string"
        ? payload.error
        : `Storyhold request failed (${response.status}).`,
      response.status,
      payload,
    );
  }
  return payload as T;
}

export async function listWorlds(): Promise<{
  worlds: WorldSummary[];
  ai: AiRuntimeStatus;
}> {
  return responseJson(
    await fetch(`${apiBase}/worlds`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function createWorld(input: {
  name: string;
  premise: string;
  genre: string;
  inferMetadata?: boolean;
  creationMode?: "import" | "quickstart" | "manual";
  resolutionMode?: ResolutionMode;
  worldContract?: Partial<WorldContract>;
  contentSettings?: Partial<ContentSettings>;
}): Promise<{
  id: string;
  editionId: string;
  name: string;
  worldContract: WorldContract;
  contractStatus: "draft";
}> {
  return responseJson(
    await fetch(`${apiBase}/worlds`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(input),
    }),
  );
}

export async function getWorld(worldId: string): Promise<WorldDetail> {
  return responseJson(
    await fetch(`${apiBase}/worlds/${encodeURIComponent(worldId)}`, {
      cache: "no-store",
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function getBrowserLocalAudit(
  worldId: string,
): Promise<{ audit: BrowserLocalAudit | null }> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(worldId)}/browser-audit`,
      {
        cache: "no-store",
        credentials: "include",
        headers: { Accept: "application/json" },
      },
    ),
  );
}

export async function submitBrowserLocalAuditBatch(input: {
  worldId: string;
  auditId: string;
  batchIndex: number;
  result: BrowserAuditResult;
  model: string;
  elapsedMilliseconds: number;
  deviceProfile: Record<string, unknown>;
  usage: { inputTokens: number; outputTokens: number };
}): Promise<{ audit: BrowserLocalAudit }> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/browser-audit/${encodeURIComponent(input.auditId)}/batches/${input.batchIndex}`,
      {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          result: input.result,
          model: input.model,
          elapsedMilliseconds: input.elapsedMilliseconds,
          deviceProfile: input.deviceProfile,
          usage: input.usage,
        }),
      },
    ),
  );
}

export async function accelerateBrowserLocalAuditBatch(input: {
  worldId: string;
  auditId: string;
  batchIndex: number;
}): Promise<{
  result: BrowserAuditResult;
  model: string;
  elapsedMilliseconds: number;
  deviceProfile: Record<string, unknown>;
  usage: { inputTokens: number; outputTokens: number };
}> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/browser-audit/${encodeURIComponent(input.auditId)}/batches/${input.batchIndex}/accelerate`,
      {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      },
    ),
  );
}

export async function startBrowserLocalAudit(input: {
  worldId: string;
  auditId: string;
}): Promise<{ audit: BrowserLocalAudit }> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/browser-audit/${encodeURIComponent(input.auditId)}/start`,
      {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      },
    ),
  );
}

export async function skipBrowserLocalAudit(input: {
  worldId: string;
  auditId: string;
  reason: string;
}): Promise<{ audit: BrowserLocalAudit }> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/browser-audit/${encodeURIComponent(input.auditId)}/skip`,
      {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ reason: input.reason }),
      },
    ),
  );
}

export async function pauseBrowserLocalAudit(input: {
  worldId: string;
  auditId: string;
  reason: string;
}): Promise<{ audit: BrowserLocalAudit }> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/browser-audit/${encodeURIComponent(input.auditId)}/pause`,
      {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ reason: input.reason }),
      },
    ),
  );
}

export async function retryBrowserLocalAudit(input: {
  worldId: string;
  auditId: string;
}): Promise<{ audit: BrowserLocalAudit }> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/browser-audit/${encodeURIComponent(input.auditId)}/retry`,
      {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      },
    ),
  );
}

export async function getStoryholdAiRuntime(): Promise<AiRuntimeStatus> {
  return responseJson(
    await fetch(`${apiBase}/ai/status`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function getCharacterDossier(
  worldId: string,
  characterId: string,
): Promise<{
  world: { id: string; name: string };
  character: CharacterDossier;
  proseReview?: DossierProseReview;
  compassReview?: DossierCompassReview;
  hold: {
    entityId: string;
    entities: WorldEntity[];
    relations: WorldEntityRelation[];
  };
}> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(worldId)}/characters/${encodeURIComponent(characterId)}`,
      {
        credentials: "include",
        headers: { Accept: "application/json" },
      },
    ),
  );
}

export async function updateCharacterDossier(input: {
  worldId: string;
  characterId: string;
  aliases: string[];
  role: string;
  summary: string;
  profile: CharacterDossier["profile"];
}): Promise<{ character: CharacterDossier }> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/characters/${encodeURIComponent(input.characterId)}`,
      {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
      },
    ),
  );
}

export async function updateCharacterSocioPoliticalAxis(input: {
  worldId: string;
  characterId: string;
  economic: number;
  authority: number;
  label: string;
  rationale: string;
}): Promise<{ character: CharacterDossier }> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/characters/${encodeURIComponent(input.characterId)}/socio-political-axis`,
      {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
      },
    ),
  );
}

export async function getWorldEntityProseReview(
  worldId: string,
  entityId: string,
): Promise<DossierProseReview> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(worldId)}/entities/${encodeURIComponent(entityId)}/prose-review`,
      { credentials: "include", headers: { Accept: "application/json" } },
    ),
  );
}

export async function updateWorldEntity(input: {
  worldId: string;
  entityId: string;
  entityType?: WorldEntityType;
  pullStatus?: "active" | "do_not_pull";
  name?: string;
  aliases?: string[];
  summary?: string;
  details?: string[];
}): Promise<{ entity: WorldEntity }> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/entities/${encodeURIComponent(input.entityId)}`,
      {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          entityType: input.entityType,
          pullStatus: input.pullStatus,
          name: input.name,
          aliases: input.aliases,
          summary: input.summary,
          details: input.details,
        }),
      },
    ),
  );
}

export async function deleteWorldEntity(input: {
  worldId: string;
  entityId: string;
}): Promise<{ deleted: true; name: string }> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/entities/${encodeURIComponent(input.entityId)}`,
      {
        method: "DELETE",
        credentials: "include",
        headers: { Accept: "application/json" },
      },
    ),
  );
}

export async function createWorldEntity(input: {
  worldId: string;
  name: string;
  entityType: Exclude<WorldEntityType, "ambiguous">;
  aliases?: string[];
  summary?: string;
}): Promise<{ entity: WorldEntity }> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/entities`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          name: input.name,
          entityType: input.entityType,
          aliases: input.aliases ?? [],
          summary: input.summary ?? "",
        }),
      },
    ),
  );
}

export async function quoteWorldEntityAiReview(input: {
  worldId: string;
  entityId: string;
  depth: EntityAiReviewDepth;
  guidance?: string;
}): Promise<EntityAiReviewQuote> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/entities/${encodeURIComponent(input.entityId)}/ai-review/quote`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ depth: input.depth, guidance: input.guidance ?? "" }),
      },
    ),
  );
}

export async function runWorldEntityAiReview(input: {
  worldId: string;
  entityId: string;
  depth: EntityAiReviewDepth;
  guidance?: string;
  quoteId: string;
  approvedCredits: number;
  browserAssist?: {
    model: string;
    identityChecks: string[];
    aliasCandidates: string[];
    relationshipChecks: string[];
    abilityChecks: string[];
    chronologyChecks: string[];
    contradictions: string[];
    missingQueries: string[];
    reviewJson?: string;
    inputTokens?: number;
    outputTokens?: number;
  };
}): Promise<{
  reviewed: true;
  warnings?: string[];
  existingProseAudit?: {
    reviewedItems: number;
    supportedItems: number;
    needsAttentionItems: number;
    needsEvidenceItems: number;
  };
  retrievalExpansion?: EntityReviewRetrievalExpansion;
  entityId: string;
  depth: EntityAiReviewDepth;
  creditsUsed: number;
  creditsRemaining: number;
  unlimited: boolean;
  provider: string;
  model: string;
  passageCount: number;
}> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/entities/${encodeURIComponent(input.entityId)}/ai-review`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
      },
    ),
  );
}

export async function getWorldCanonConstraints(input: {
  worldId: string;
  entityId?: string;
}): Promise<{ constraints: OwnerCanonConstraint[] }> {
  const query = input.entityId ? `?entityId=${encodeURIComponent(input.entityId)}` : "";
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/canon-constraints${query}`,
      { credentials: "include", headers: { Accept: "application/json" } },
    ),
  );
}

export async function addWorldCanonConstraint(input: {
  worldId: string;
  instruction: string;
  entityId?: string | null;
  kind?: OwnerCanonConstraint["kind"];
}): Promise<{ constraint: OwnerCanonConstraint }> {
  return responseJson(
    await fetch(`${apiBase}/worlds/${encodeURIComponent(input.worldId)}/canon-constraints`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        instruction: input.instruction,
        entityId: input.entityId ?? null,
        kind: input.kind,
      }),
    }),
  );
}

export async function dismissWorldCanonConstraint(input: {
  worldId: string;
  constraintId: string;
}): Promise<{ constraint: OwnerCanonConstraint }> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/canon-constraints/${encodeURIComponent(input.constraintId)}/dismiss`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: "{}",
      },
    ),
  );
}

export async function mergeWorldEntities(input: {
  worldId: string;
  sourceEntityId: string;
  targetEntityId: string;
}): Promise<{ actionId: string; summary: string }> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/entities/${encodeURIComponent(input.sourceEntityId)}/merge`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ targetEntityId: input.targetEntityId }),
      },
    ),
  );
}

export async function undoWorldEntityMerge(input: {
  worldId: string;
  actionId: string;
}): Promise<{ undone: true }> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/entity-actions/${encodeURIComponent(input.actionId)}/undo`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: "{}",
      },
    ),
  );
}

export async function assignWorldEntityFaction(input: {
  worldId: string;
  entityId: string;
  factionId: string;
}): Promise<{ assigned: true }> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/entities/${encodeURIComponent(input.entityId)}/factions/${encodeURIComponent(input.factionId)}`,
      {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      },
    ),
  );
}

export async function removeWorldEntityFaction(input: {
  worldId: string;
  entityId: string;
  factionId: string;
}): Promise<void> {
  const response = await fetch(
    `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/entities/${encodeURIComponent(input.entityId)}/factions/${encodeURIComponent(input.factionId)}`,
    {
      method: "DELETE",
      credentials: "include",
      headers: { Accept: "application/json" },
    },
  );
  if (!response.ok) await responseJson(response);
}

export async function createWorldEntityRelation(input: {
  worldId: string;
  entityId: string;
  targetEntityId: string;
  relationType: WorldEntityRelationType;
  status: WorldEntityRelation["status"];
  summary?: string;
  validFromLabel?: string;
  validUntilLabel?: string;
}) {
  return responseJson<{ relation: WorldEntityRelation }>(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/entities/${encodeURIComponent(input.entityId)}/relations`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
      },
    ),
  );
}

export async function createWorldEntityRelations(input: {
  worldId: string;
  connections: Array<{
    sourceEntityId: string;
    targetEntityId: string;
    relationType: WorldEntityRelationType;
    status: WorldEntityRelation["status"];
    summary?: string;
    validFromLabel?: string;
    validUntilLabel?: string;
  }>;
}): Promise<{ created: number }> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/entity-relations/batch`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ connections: input.connections }),
      },
    ),
  );
}

export async function deleteWorldEntityRelation(input: {
  worldId: string;
  relationId: string;
}): Promise<void> {
  const response = await fetch(
    `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/entity-relations/${encodeURIComponent(input.relationId)}`,
    { method: "DELETE", credentials: "include", headers: { Accept: "application/json" } },
  );
  if (!response.ok) await responseJson(response);
}

export async function createWorldEntityRule(input: {
  worldId: string;
  entityId: string;
  name: string;
  description?: string;
  ruleKind: WorldEntityRule["ruleKind"];
  trigger?: string;
  effect?: string;
}) {
  return responseJson<{ rule: WorldEntityRule }>(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/entities/${encodeURIComponent(input.entityId)}/rules`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
      },
    ),
  );
}

export async function deleteWorldEntityRule(input: {
  worldId: string;
  ruleId: string;
}): Promise<void> {
  const response = await fetch(
    `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/entity-rules/${encodeURIComponent(input.ruleId)}`,
    { method: "DELETE", credentials: "include", headers: { Accept: "application/json" } },
  );
  if (!response.ok) await responseJson(response);
}

export async function uploadWorldSource(input: {
  worldId: string;
  file: File;
  sourceClass: string;
  canonStatus: string;
  sourceKind?: WorldSource["sourceKind"];
  chronologyOrder?: number;
  chronologyRelation?: WorldSource["chronologyRelation"];
  chronologyLabel?: string;
  chronologyNotes?: string;
  fileAsChapter?: boolean;
  relativePath?: string;
  importBatchId?: string;
  importBatchPosition?: number;
  importBatchSize?: number;
  deferAnalysis?: boolean;
  referenceKnowledgeScope?: ReferenceKnowledgeScope;
  referenceKnownBy?: string[];
  referenceLoreStatus?: ReferenceLoreStatus;
}): Promise<{ source: WorldSource }> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/sources`,
      {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": input.file.type || "application/octet-stream",
          Accept: "application/json",
          "X-Storyhold-Filename": encodeURIComponent(input.file.name),
          "X-Storyhold-Source-Class": input.sourceClass,
          "X-Storyhold-Canon-Status": input.canonStatus,
          "X-Storyhold-Source-Kind": input.sourceKind ?? "manuscript",
          "X-Storyhold-Chronology-Order": String(input.chronologyOrder ?? 0),
          "X-Storyhold-Chronology-Relation":
            input.chronologyRelation ?? "unspecified",
          "X-Storyhold-Chronology-Label": encodeURIComponent(
            input.chronologyLabel ?? "",
          ),
          "X-Storyhold-Chronology-Notes": encodeURIComponent(
            input.chronologyNotes ?? "",
          ),
          "X-Storyhold-File-As-Chapter": input.fileAsChapter ? "true" : "false",
          "X-Storyhold-Relative-Path": encodeURIComponent(input.relativePath ?? input.file.name),
          "X-Storyhold-Import-Batch-Id": input.importBatchId ?? "",
          "X-Storyhold-Import-Batch-Position": String(input.importBatchPosition ?? 0),
          "X-Storyhold-Import-Batch-Size": String(input.importBatchSize ?? 1),
          "X-Storyhold-Defer-Analysis": input.deferAnalysis ? "true" : "false",
          "X-Storyhold-Reference-Knowledge-Scope":
            input.referenceKnowledgeScope ?? "director_only",
          "X-Storyhold-Reference-Known-By": encodeURIComponent(
            (input.referenceKnownBy ?? []).join(", "),
          ),
          "X-Storyhold-Reference-Lore-Status":
            input.referenceLoreStatus ?? "supplemental",
        },
        body: input.file,
      },
    ),
  );
}

export async function updateWorldContract(input: {
  worldId: string;
  worldContract: WorldContract;
  resolutionMode: ResolutionMode;
  contentSettings: ContentSettings;
  worldClockName?: string;
  lock?: boolean;
}) {
  return responseJson<{
    worldContract: WorldContract;
    contractStatus: "draft" | "locked";
    resolutionMode: ResolutionMode;
    contentSettings: ContentSettings;
    worldClockName: string;
  }>(
    await fetch(`${apiBase}/worlds/${encodeURIComponent(input.worldId)}/contract`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function deleteWorld(input: {
  worldId: string;
  confirmationName: string;
}) {
  return responseJson<{
    deleted: true;
    worldId: string;
    name: string;
    filesRemoved: boolean;
  }>(
    await fetch(`${apiBase}/worlds/${encodeURIComponent(input.worldId)}`, {
      method: "DELETE",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ confirmationName: input.confirmationName }),
    }),
  );
}

export async function updateWorldChronology(input: {
  worldId: string;
  summary?: string;
  sources: Array<{
    sourceId: string;
    sourceKind: WorldSource["sourceKind"];
    relation: WorldSource["chronologyRelation"];
    label: string;
    notes: string;
  }>;
}) {
  return responseJson<{
    chronologyStatus: "reviewed";
    chronologySummary: string;
    sources: WorldSource[];
  }>(
    await fetch(`${apiBase}/worlds/${encodeURIComponent(input.worldId)}/chronology`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function createCampaign(input: {
  worldId: string;
  name?: string;
  characterId?: string;
  worldEntityId?: string;
  characterName?: string;
  characterConcept?: string;
  startingPoint?: string;
  initialObjective?: string;
  canonAnchorEventId?: string;
  canonAnchorMode?: "before" | "after";
  resolutionMode?: ResolutionMode;
  experienceMode?: CampaignExperienceMode;
}) {
  return responseJson<{
    campaign: CampaignSummary;
    startContract: Record<string, unknown>;
    firstEvent: WorldClockEvent;
  }>(
    await fetch(`${apiBase}/worlds/${encodeURIComponent(input.worldId)}/campaigns`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function getCampaignClock(campaignId: string) {
  return responseJson<{
    campaign: CampaignSummary;
    worldClockName: string;
    events: WorldClockEvent[];
  }>(
    await fetch(`${apiBase}/campaigns/${encodeURIComponent(campaignId)}/clock`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function addCampaignReminder(input: {
  campaignId: string;
  kind: "reminder" | "commitment";
  title: string;
  summary?: string;
  dueLabel?: string;
}) {
  return responseJson<{ event: WorldClockEvent }>(
    await fetch(`${apiBase}/campaigns/${encodeURIComponent(input.campaignId)}/reminders`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function getCampaignPlay(
  campaignId: string,
  signal?: AbortSignal,
): Promise<CampaignPlaySession> {
  return responseJson(
    await fetch(`${apiBase}/campaigns/${encodeURIComponent(campaignId)}/play`, {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal,
    }),
  );
}

export async function updateCampaignTurnFeedback(input: {
  campaignId: string;
  turnId: string;
  rating: -1 | 1;
  tags?: LorekeeperFeedbackTag[];
  note?: string;
}) {
  return responseJson<{
    feedback: CampaignTurnFeedback;
    preferenceProfile: {
      weights: Record<string, number>;
      positiveCount: number;
      negativeCount: number;
    };
    anonymousContribution: boolean;
  }>(
    await fetch(
      `${apiBase}/campaigns/${encodeURIComponent(input.campaignId)}/turns/${encodeURIComponent(input.turnId)}/feedback`,
      {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
      },
    ),
  );
}

export async function getCampaignStory(
  campaignId: string,
): Promise<CampaignStorySession> {
  return responseJson(
    await fetch(`${apiBase}/campaigns/${encodeURIComponent(campaignId)}/story`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function createCampaignStoryDraft(input: {
  campaignId: string;
  turnIds: string[];
  requestId: string;
  title?: string;
  settings: {
    pov: "first_person" | "third_limited" | "third_omniscient";
    tense: "past" | "present";
    length: "scene" | "chapter";
    fidelity: "strict" | "novelistic";
    voiceNotes?: string;
  };
}) {
  return responseJson<{
    draft: CampaignStoryDraft;
    creditsUsed?: number;
    creditsRemaining?: number;
    unlimitedCredits?: boolean;
    duplicate?: boolean;
  }>(
    await fetch(
      `${apiBase}/campaigns/${encodeURIComponent(input.campaignId)}/story/drafts`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
      },
    ),
  );
}

export async function updateCampaignStoryDraft(input: {
  campaignId: string;
  draftId: string;
  revision: number;
  title: string;
  prose: string;
}) {
  return responseJson<{ draft: CampaignStoryDraft }>(
    await fetch(
      `${apiBase}/campaigns/${encodeURIComponent(input.campaignId)}/story/drafts/${encodeURIComponent(input.draftId)}`,
      {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
      },
    ),
  );
}

export type ProposalMutationResponse = {
  proposal: CampaignTurnProposal;
  creditsUsed?: number;
  creditsRemaining?: number;
  unlimitedCredits?: boolean;
  runtime?: AiRuntimeStatus;
  duplicate?: boolean;
  fixedPriceCredits?: number;
};

export async function createCampaignTurnProposal(input: {
  campaignId: string;
  action: string;
  inputMode?: CampaignInputMode;
  requestId: string;
}): Promise<ProposalMutationResponse | import("./manualStorytellerApi").ManualQueuedResponse> {
  return responseJson(
    await fetch(`${apiBase}/campaigns/${encodeURIComponent(input.campaignId)}/proposals`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        action: input.action,
        inputMode: input.inputMode ?? "action",
        requestId: input.requestId,
      }),
    }),
  );
}

export async function submitCampaignBrowserNarration(input: {
  campaignId: string;
  proposalId: string;
  narration: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}): Promise<ProposalMutationResponse> {
  return responseJson(
    await fetch(
      `${apiBase}/campaigns/${encodeURIComponent(input.campaignId)}/proposals/${encodeURIComponent(input.proposalId)}/browser-narration`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          narration: input.narration,
          model: input.model,
          usage: input.usage,
        }),
      },
    ),
  );
}

export async function regenerateCampaignTurnProposal(input: {
  campaignId: string;
  proposalId: string;
}): Promise<ProposalMutationResponse> {
  return responseJson(
    await fetch(
      `${apiBase}/campaigns/${encodeURIComponent(input.campaignId)}/proposals/${encodeURIComponent(input.proposalId)}/regenerate`,
      {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      },
    ),
  );
}

export async function rerollCampaignTurnProposal(input: {
  campaignId: string;
  proposalId: string;
}): Promise<ProposalMutationResponse> {
  return responseJson(
    await fetch(
      `${apiBase}/campaigns/${encodeURIComponent(input.campaignId)}/proposals/${encodeURIComponent(input.proposalId)}/reroll`,
      {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      },
    ),
  );
}

export async function acceptCampaignTurnProposal(input: {
  campaignId: string;
  proposalId: string;
}): Promise<Awaited<ReturnType<typeof submitCampaignTurn>>> {
  return responseJson(
    await fetch(
      `${apiBase}/campaigns/${encodeURIComponent(input.campaignId)}/proposals/${encodeURIComponent(input.proposalId)}/accept`,
      {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      },
    ),
  );
}

export async function discardCampaignTurnProposal(input: {
  campaignId: string;
  proposalId: string;
}) {
  return responseJson<{ discarded: true; proposalId: string }>(
    await fetch(
      `${apiBase}/campaigns/${encodeURIComponent(input.campaignId)}/proposals/${encodeURIComponent(input.proposalId)}/discard`,
      {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      },
    ),
  );
}

export async function createCampaignCheckpoint(input: {
  campaignId: string;
  name?: string;
  note?: string;
}) {
  return responseJson<{ checkpoint: CampaignCheckpoint }>(
    await fetch(`${apiBase}/campaigns/${encodeURIComponent(input.campaignId)}/checkpoints`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ name: input.name ?? "", note: input.note ?? "" }),
    }),
  );
}

export async function createCampaignBranch(input: {
  campaignId: string;
  checkpointId: string;
  requestId: string;
  name?: string;
  mode?: "writer" | "alternate";
}) {
  return responseJson<{
    branch: CampaignBranch;
    creditsUsed: number;
    creditsRemaining: number;
    unlimitedCredits: boolean;
    fixedPriceCredits: number;
    duplicate?: boolean;
  }>(
    await fetch(
      `${apiBase}/campaigns/${encodeURIComponent(input.campaignId)}/checkpoints/${encodeURIComponent(input.checkpointId)}/branches`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          name: input.name ?? "",
          mode: input.mode ?? "writer",
          requestId: input.requestId,
        }),
      },
    ),
  );
}

export async function updateCampaignBranch(input: {
  campaignId: string;
  branchId: string;
  status: "draft" | "archived";
}) {
  return responseJson<{ branch: CampaignBranch }>(
    await fetch(
      `${apiBase}/campaigns/${encodeURIComponent(input.campaignId)}/branches/${encodeURIComponent(input.branchId)}`,
      {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ status: input.status }),
      },
    ),
  );
}

export async function activateCampaignBranch(input: {
  campaignId: string;
  branchId: string;
}) {
  return responseJson<{
    branch: CampaignBranch;
    campaignId: string;
    created: boolean;
    creditsUsed: 0;
  }>(
    await fetch(
      `${apiBase}/campaigns/${encodeURIComponent(input.campaignId)}/branches/${encodeURIComponent(input.branchId)}/activate`,
      {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      },
    ),
  );
}

export async function submitCampaignTurn(input: {
  campaignId: string;
  action: string;
  inputMode?: CampaignInputMode;
  requestId: string;
}): Promise<{
  turn: CampaignTurn;
  currentTimeLabel?: string;
  worldTimeMinutes?: number;
  stateVersion?: number;
  creditsUsed?: number;
  creditsRemaining?: number;
  unlimitedCredits?: boolean;
  clockEvents?: WorldClockEvent[];
  knownState?: CampaignPlaySession["knownState"];
  rpgState?: CampaignPlaySession["rpgState"];
  maturedClockEventIds?: string[];
  runtime?: AiRuntimeStatus;
  duplicate?: boolean;
}> {
  return responseJson(
    await fetch(`${apiBase}/campaigns/${encodeURIComponent(input.campaignId)}/turns`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        action: input.action,
        inputMode: input.inputMode ?? "action",
        requestId: input.requestId,
      }),
    }),
  );
}

export async function getStoryPreferences() {
  return responseJson<{ preferences: StoryPreferences }>(
    await fetch(`${apiBase}/preferences`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function updateStoryPreferences(input: {
  adultEnabled: boolean;
  ageConfirmed: boolean;
  sexualContentLevel: StoryPreferences["sexualContentLevel"];
  violenceLevel: StoryPreferences["violenceLevel"];
  narrativeLength: StoryPreferences["narrativeLength"];
  anonymousLearningEnabled: boolean;
  localModelTrainingEnabled: boolean;
}) {
  return responseJson<{ preferences: StoryPreferences }>(
    await fetch(`${apiBase}/preferences`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function analyzeWorldSources(worldId: string, options?: { guidance?: string; intakeTermsVersion?: string }): Promise<{
  run: {
    id: string;
    status: string;
    provider: string;
    model: string;
  };
}> {
  return responseJson(
    await fetch(`${apiBase}/worlds/${encodeURIComponent(worldId)}/analyze`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        guidance: options?.guidance ?? "",
        intakeTermsVersion: options?.intakeTermsVersion ?? "2026-08-23",
      }),
    }),
  );
}

export async function pauseWorldIntake(worldId: string): Promise<{
  status: "pausing" | "paused";
  runId?: string;
  auditId?: string;
}> {
  return responseJson(
    await fetch(`${apiBase}/worlds/${encodeURIComponent(worldId)}/intake/pause`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: "{}",
    }),
  );
}

export async function resumeWorldIntake(worldId: string): Promise<{
  status: "resuming";
  runId?: string;
  auditId?: string;
}> {
  return responseJson(
    await fetch(`${apiBase}/worlds/${encodeURIComponent(worldId)}/intake/resume`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: "{}",
    }),
  );
}

export async function getCanonIntakePreflight(
  worldId: string,
): Promise<CanonIntakePreflight> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(worldId)}/intake-preflight`,
      {
        credentials: "include",
        headers: { Accept: "application/json" },
      },
    ),
  );
}

export async function runPremiumWorldReview(worldId: string, options?: { guidance?: string }): Promise<{
  run: {
    id: string;
    status: string;
    provider: string;
    model: string;
  };
}> {
  return responseJson(
    await fetch(`${apiBase}/worlds/${encodeURIComponent(worldId)}/premium-review`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ guidance: options?.guidance ?? "" }),
    }),
  );
}

export async function dismissWorldQualityFinding(input: {
  worldId: string;
  findingId: string;
}): Promise<{ finding: WorldQualityFinding }> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/quality-findings/${encodeURIComponent(input.findingId)}/dismiss`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: "{}",
      },
    ),
  );
}

export async function addWorldExternalReference(input: {
  worldId: string;
  query?: string;
  title?: string;
  url: string;
  publisher?: string;
  summary?: string;
  keywords?: string[];
  reviewStatus?: "candidate" | "approved";
  knowledgeScope?: ReferenceKnowledgeScope;
  knownBy?: string[];
  loreStatus?: ReferenceLoreStatus;
}): Promise<{ reference: WorldExternalReference }> {
  return responseJson(
    await fetch(`${apiBase}/worlds/${encodeURIComponent(input.worldId)}/reference-sources`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export type WorldReferenceLead = {
  title: string;
  url: string;
  summary: string;
  publisher: string;
  date: string | null;
  sourceRole: string;
};

export async function discoverWorldExternalReferences(input: {
  worldId: string;
  query?: string;
}): Promise<{ query: string; leads: WorldReferenceLead[] }> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/reference-sources/discover`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: input.query ?? "" }),
      },
    ),
  );
}

export async function reviewCharacterDraft(input: {
  worldId: string;
  draftId: string;
  decision: "approve" | "reject";
}): Promise<{ status: "approved" | "rejected"; characterId: string | null }> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/character-drafts/${encodeURIComponent(input.draftId)}/review`,
      {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ decision: input.decision }),
      },
    ),
  );
}

export async function reviewCohesionProposal(input: {
  worldId: string;
  proposalId: string;
  decision: "approve" | "dismiss";
  classification?: string;
}): Promise<{
  status: "approved" | "dismissed";
  classification: string | null;
  canonChanged: false;
}> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/cohesion-proposals/${encodeURIComponent(input.proposalId)}/review`,
      {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          decision: input.decision,
          classification: input.classification,
        }),
      },
    ),
  );
}

type DiscrepancyResponse = {
  report: CanonDiscrepancyReport;
  amendmentId: string | null;
  canonChanged: boolean;
};

export async function reportCanonDiscrepancy(input: {
  worldId: string;
  claim: string;
  campaignId?: string;
}): Promise<DiscrepancyResponse> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/discrepancies`,
      {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          claim: input.claim,
          campaignId: input.campaignId,
        }),
      },
    ),
  );
}

export async function explainCanonDiscrepancy(input: {
  worldId: string;
  reportId: string;
  reasoning: string;
}): Promise<DiscrepancyResponse> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/discrepancies/${encodeURIComponent(input.reportId)}/reason`,
      {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ reasoning: input.reasoning }),
      },
    ),
  );
}

export async function applyCanonDiscrepancy(input: {
  worldId: string;
  reportId: string;
}): Promise<DiscrepancyResponse> {
  return responseJson(
    await fetch(
      `${apiBase}/worlds/${encodeURIComponent(input.worldId)}/discrepancies/${encodeURIComponent(input.reportId)}/apply`,
      {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: "{}",
      },
    ),
  );
}

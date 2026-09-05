import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  mergeWorldFindings,
  relationHasDirectPredicateSupport,
  type CharacterFinding,
  type NamedFinding,
  type WorldFindings,
} from "./worldAnalysis";
import {
  resolveExplicitCharacterIdentities,
  resolveGeneratedTaxonomyPluralIdentities,
  type ExplicitCharacterIdentityEntity,
} from "./characterIdentity";
import {
  aiReviewQueuePlan,
  analysisChunkCoverageBatches,
  adjudicatePersistedLocalEntityRows,
  adjudicateGeneratedEntityHypotheses,
  authorModeIsEligible,
  breadthFirstAnalysisChunks,
  campaignCharacterNormalizedName,
  canonIntakePreflight,
  customerAiRuntimeStatus,
  customerSafeIntakeActivityRows,
  deferredBacklogAnalysisKind,
  dossierIsCustomerEdited,
  entityIsCustomerVisible,
  entityIsScannerProtected,
  enrichLocalDossierProjection,
  finalizeKnownPremiumFailureAtomically,
  generatedEntityType,
  generatedCategoryRepairShouldRestoreVisibility,
  generatedCharacterDossierIsSubstantive,
  generatedLocalFindingsForPersistence,
  generatedLocalContextLeadShouldRemainVisible,
  generalWorldAnalysisKind,
  generatedLocalEntityNeedsPresentationRepair,
  intakeActivityFromPreview,
  intakeActivityPhraseInventory,
  lorekeeperConstraintSnapshotFingerprint,
  lorekeeperCorpusFingerprint,
  lorekeeperSnapshotFingerprint,
  localReaderInterruptionIsResumable,
  migrateLocalDossierUnderstanding,
  pausePremiumReviewForTopUp,
  factionMembershipEvidence,
  findingsFromBreakdown,
  findingCountsByChunk,
  frozenPremiumClockContext,
  mergeDossierProfiles,
  nextAutomaticAnalysisKind,
  persistGeneratedFactionMembership,
  persistAdjudicatedLocalEntityUpdate,
  persistedLocalEntityIsConnectionEligible,
  persistRevalidatedGeneratedDossierProfile,
  persistRevalidatedGeneratedDossierProfiles,
  premiumEvidencePinError,
  premiumTopUpCreditsNeeded,
  recoverKnownRejectedPremiumReview,
  premiumUsageNeedsReconciliation,
  reconcileAuthoritativeAiChapterMap,
  restorePersistedLocalEntityCategories,
  removeRetiredLocalEntityRelationships,
  revalidateGeneratedLocalDossierProfiles,
  resolveEntityRuleReference,
  relationEntityTypesAreCompatible,
  scheduledClockDeadlineBackfillSql,
  selectBreadthFirstAffordableChunks,
  selectLocalDossierEnrichmentCharacters,
  serializeDossier,
  serializeEntityRelation,
  serializeEntityRule,
  serializeRun,
  serializeWorldEntity,
  settlePremiumWorldReservationInTransaction,
  shouldReviewAnalysisChunk,
  sourceNeedsAiReview,
  sourcePageSpans,
  syncSourceChapterSummaries,
  syncWorldEntities,
  worldIntakePipelineState,
  worldUploadDirectoryForDeletion,
  WORLD_ANALYSIS_VERSION,
  LOCAL_ANALYSIS_VERSION,
  PREMIUM_VERIFICATION_PACKET_VERSION,
} from "./worldStudio";
import { AiGatewayUnavailableError, priceReportedAiUsage } from "./aiGateway";
import { CreditEconomyError, creditEconomySchemaSql, reserveCredits } from "./creditEconomy";
import {
  executeJournaledPremiumCall,
  premiumReviewJournalSchemaSql,
} from "./premiumReviewJournal";

test("paid entity persistence cannot accept a verified flag without graph decision receipts", async () => {
  let databaseCalls = 0;
  const db = { query: async () => { databaseCalls += 1; throw new Error("No database operation should occur."); } };
  await assert.rejects(syncWorldEntities({
    db: db as never,
    worldId: "10000000-0000-4000-8000-000000000001",
    editionId: "10000000-0000-4000-8000-000000000002",
    runId: "10000000-0000-4000-8000-000000000003",
    analysisKind: "ai_enrichment",
    replaceGeneratedSnapshot: true,
    findings: { entityRelations: [{ reviewStatus: "verified" }], entityRules: [] } as never,
  }), /requires its exact reviewed findings and decision receipts/);
  assert.equal(databaseCalls, 0);
});

test("premium clock admission never truncates active owner corrections", async () => {
  const db = new PGlite();
  const worldId = "10000000-0000-4000-8000-000000000001";
  const editionId = "10000000-0000-4000-8000-000000000002";
  try {
    await db.exec(`
      CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.world_entities (
        id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
        name text NOT NULL, aliases jsonb NOT NULL, entity_type text NOT NULL,
        pull_status text NOT NULL, merged_into_entity_id uuid
      );
      CREATE TABLE storyhold.world_owner_canon_constraints (
        id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
        scope_entity_id uuid, constraint_kind text NOT NULL, instruction text NOT NULL,
        status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await db.query(
      `INSERT INTO storyhold.world_entities
        (id, world_id, canon_edition_id, name, aliases, entity_type, pull_status)
       VALUES ('20000000-0000-4000-8000-000000000001', $1, $2, 'Mara', '[]'::jsonb, 'character', 'active')`,
      [worldId, editionId],
    );
    await db.query(
      `INSERT INTO storyhold.world_owner_canon_constraints
        (id, world_id, canon_edition_id, constraint_kind, instruction, status)
       SELECT ('30000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
              $1::uuid, $2::uuid, 'chronology', 'Owner correction ' || item, 'active'
         FROM generate_series(1, 501) item`,
      [worldId, editionId],
    );
    await assert.rejects(
      frozenPremiumClockContext(db as never, { worldId, editionId }),
      /more than 500 active owner corrections.*no credits were reserved/i,
    );
    await db.query(
      "DELETE FROM storyhold.world_owner_canon_constraints WHERE id = '30000000-0000-4000-8000-000000000501'",
    );
    const admitted = await frozenPremiumClockContext(db as never, { worldId, editionId });
    assert.equal(admitted.ownerConstraints.length, 500);
  } finally {
    await db.close();
  }
});

test("premium usage with unknown or invalid cost requires reconciliation, not a refund", () => {
  const usage = priceReportedAiUsage({
    provider: "openai",
    model: "unknown-test-model",
    inputUnits: 100,
    outputUnits: 10,
  });
  assert.equal(premiumUsageNeedsReconciliation(usage), true);
  assert.equal(premiumUsageNeedsReconciliation({ ...usage, pricingKnown: true, estimatedCostMicros: 20 }), false);
  assert.equal(premiumUsageNeedsReconciliation({ ...usage, pricingKnown: true, estimatedCostMicros: 0 }), false);
  for (const cost of [NaN, Infinity, -1]) {
    assert.equal(premiumUsageNeedsReconciliation({ ...usage, pricingKnown: true, estimatedCostMicros: cost }), true);
  }
  assert.equal(premiumUsageNeedsReconciliation(null), false);
});

test("relationship categories reject structurally impossible graph claims", () => {
  assert.equal(relationEntityTypesAreCompatible("has_power", "character", "weapon"), false);
  assert.equal(relationEntityTypesAreCompatible("has_power", "character", "power"), true);
  assert.equal(relationEntityTypesAreCompatible("spouse_of", "character", "technology"), false);
  assert.equal(relationEntityTypesAreCompatible("spouse_of", "character", "character"), true);
  assert.equal(relationEntityTypesAreCompatible("located_in", "character", "place"), true);
  assert.equal(relationEntityTypesAreCompatible("located_in", "character", "character"), false);
  assert.equal(relationEntityTypesAreCompatible("member_of", "character", "faction"), true);
  assert.equal(relationEntityTypesAreCompatible("member_of", "character", "weapon"), false);
  assert.equal(relationEntityTypesAreCompatible("controlled_by", "ambiguous", "character"), true);
  assert.equal(relationEntityTypesAreCompatible("holds_title", "character", "ambiguous"), false);
  assert.equal(relationEntityTypesAreCompatible("related_to", "character", "cultural_reference"), false);
  assert.equal(relationEntityTypesAreCompatible("related_to", "term", "character"), false);
  assert.equal(relationEntityTypesAreCompatible("related_to", "character", "technology"), true);
  assert.equal(relationEntityTypesAreCompatible("participates_in", "character", "power_structure"), true);
  assert.equal(relationEntityTypesAreCompatible("participates_in", "term", "government"), false);
});

test("local reader transport failures remain resumable instead of becoming terminal", () => {
  assert.equal(localReaderInterruptionIsResumable("fetch failed"), true);
  assert.equal(
    localReaderInterruptionIsResumable("GLiNER 1 stopped before every passage was processed: passage-4: fetch failed"),
    true,
  );
  assert.equal(localReaderInterruptionIsResumable("The model returned malformed entity data."), false);
});

test("Canon Intake prices cumulative world words instead of charging each upload a new base", async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.world_sources (
      id uuid PRIMARY KEY,
      world_id uuid NOT NULL,
      canon_edition_id uuid NOT NULL,
      processing_status text NOT NULL,
      canon_status text NOT NULL,
      source_kind text NOT NULL,
      word_count integer NOT NULL,
      chunk_count integer NOT NULL,
      intake_payment_required boolean NOT NULL
    );
    CREATE TABLE storyhold.world_intake_entitlements (
      id uuid PRIMARY KEY,
      world_id uuid NOT NULL,
      canon_edition_id uuid NOT NULL,
      word_count integer NOT NULL,
      credits_charged integer NOT NULL
    );
  `);
  const worldId = "11111111-1111-4111-8111-111111111111";
  const editionId = "22222222-2222-4222-8222-222222222222";
  await db.query(
    `INSERT INTO storyhold.world_sources
      (id, world_id, canon_edition_id, processing_status, canon_status,
       source_kind, word_count, chunk_count, intake_payment_required)
     VALUES
      ('33333333-3333-4333-8333-333333333333', $1, $2, 'ready', 'canon', 'manuscript', 100000, 320, false),
      ('44444444-4444-4444-8444-444444444444', $1, $2, 'ready', 'candidate', 'manuscript', 50000, 160, true),
      ('55555555-5555-4555-8555-555555555555', $1, $2, 'ready', 'reference', 'reference', 900000, 1, false)`,
    [worldId, editionId],
  );
  await db.query(
    `INSERT INTO storyhold.world_intake_entitlements
      (id, world_id, canon_edition_id, word_count, credits_charged)
     VALUES ('66666666-6666-4666-8666-666666666666', $1, $2, 100000, 200)`,
    [worldId, editionId],
  );
  const preflight = await canonIntakePreflight(db, { worldId, editionId });
  assert.equal(preflight.wordCount, 150_000);
  assert.equal(preflight.unpaidWordCount, 50_000);
  assert.equal(preflight.requiredCredits, 50);
  assert.equal(preflight.largeIntake, false);
  assert.equal(preflight.overLimit, false);
  await db.close();
});

test("world deletion resolves only the exact UUID directory inside uploads", () => {
  const root = "C:\\Storyhold Data";
  const worldId = "5fd1d7c4-1bb0-4fc4-a36d-b4d4909a6098";
  assert.equal(
    worldUploadDirectoryForDeletion(root, worldId),
    `${root}\\uploads\\${worldId}`,
  );
  assert.throws(
    () => worldUploadDirectoryForDeletion(root, "..\\another-folder"),
    /Invalid world identifier/,
  );
});

test("intake pipeline stops after local and browser work until premium is chosen", () => {
  const source = {
    processingStatus: "ready",
    chunkCount: 80,
    localScanStatus: "completed",
    aiReviewStatus: "waiting",
  };
  const browser = worldIntakePipelineState({
    sources: [source],
    latestRun: {
      status: "completed",
      analysisKind: "local_scan",
      progress: 100,
      stage: "local inventory complete",
    },
    browserAudit: {
      status: "running",
      progress: 50,
      stage: "Checking story concepts 2 of 4",
    },
    aiConfigured: true,
  });
  assert.equal(browser.status, "awaiting_device");
  assert.equal(browser.stage, "browser_audit");
  assert.equal(browser.requiresOpenPage, true);
  assert.equal(browser.canOpenWorld, false);
  assert.ok(browser.progress >= 92 && browser.progress <= 99);

  const verifier = worldIntakePipelineState({
    sources: [source],
    latestRun: {
      status: "completed",
      analysisKind: "local_scan",
      progress: 100,
    },
    browserAudit: { status: "skipped", progress: 100 },
    aiConfigured: true,
  });
  assert.equal(verifier.status, "local_ready");
  assert.equal(verifier.stage, "premium_optional");
  assert.equal(verifier.progress, 100);
  assert.equal(verifier.canOpenWorld, true);
  assert.equal(verifier.canStartPremiumReview, true);

  const ready = worldIntakePipelineState({
    sources: [{ ...source, aiReviewStatus: "reviewed" }],
    latestRun: {
      status: "completed",
      analysisKind: "ai_enrichment",
      progress: 100,
    },
    browserAudit: { status: "completed", progress: 100 },
    aiConfigured: true,
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.progress, 100);
  assert.equal(ready.canOpenWorld, true);
  assert.equal(ready.canStartPremiumReview, true);
});

test("intake pipeline keeps failures resumable without pretending the world is ready", () => {
  const failed = worldIntakePipelineState({
    sources: [{
      processingStatus: "ready",
      chunkCount: 12,
      localScanStatus: "failed",
      aiReviewStatus: "waiting",
    }],
    latestRun: {
      status: "failed",
      analysisKind: "local_scan",
      progress: 42,
      error: "reader interrupted",
    },
    browserAudit: null,
    aiConfigured: false,
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.stage, "local_read");
  assert.equal(failed.canRetryLocal, true);
  assert.equal(failed.canOpenWorld, false);
  assert.match(failed.message, /Restart Canon Intake once/);

  const checkpointed = worldIntakePipelineState({
    sources: [{
      processingStatus: "ready",
      chunkCount: 12,
      localScanStatus: "failed",
      aiReviewStatus: "waiting",
    }],
    latestRun: {
      status: "failed",
      analysisKind: "local_scan",
      progress: 42,
      error: "reader interrupted",
      localCheckpointStage: "gliner2",
    },
    browserAudit: null,
    aiConfigured: false,
  });
  assert.match(checkpointed.message, /completed work is saved/);
});

test("intake pipeline exposes cooperative pause states without losing saved progress", () => {
  const source = {
    processingStatus: "ready",
    chunkCount: 80,
    localScanStatus: "running",
    aiReviewStatus: "waiting",
  };
  const localPause = worldIntakePipelineState({
    sources: [source],
    latestRun: {
      status: "paused",
      analysisKind: "local_scan",
      progress: 47,
      stage: "Paused by you",
    },
    browserAudit: null,
    aiConfigured: true,
  });
  assert.equal(localPause.status, "paused");
  assert.equal(localPause.stage, "local_read");
  assert.equal(localPause.progress, 47);
  assert.equal(localPause.canOpenWorld, false);

  const browserPause = worldIntakePipelineState({
    sources: [{ ...source, localScanStatus: "completed" }],
    latestRun: {
      status: "completed",
      analysisKind: "local_scan",
      progress: 100,
    },
    browserAudit: { status: "paused", progress: 50 },
    aiConfigured: true,
  });
  assert.equal(browserPause.status, "paused");
  assert.equal(browserPause.stage, "browser_audit");
  assert.equal(browserPause.progress, 96);

  const premiumPause = worldIntakePipelineState({
    sources: [{
      ...source,
      localScanStatus: "completed",
      aiReviewStatus: "running",
    }],
    latestRun: {
      status: "paused",
      analysisKind: "ai_enrichment",
      progress: 35,
    },
    browserAudit: { status: "completed", progress: 100 },
    aiConfigured: true,
  });
  assert.equal(premiumPause.status, "paused");
  assert.equal(premiumPause.stage, "ai_verification");
  assert.equal(premiumPause.progress, 78);
  assert.equal(premiumPause.canOpenWorld, true);
});

test("customer Hidden contains owner decisions, not rejected scanner leads", () => {
  assert.equal(entityIsCustomerVisible({
    name: "Shit",
    entity_type: "ambiguous",
    classification_source: "local",
    review_status: "candidate",
    pull_status: "do_not_pull",
    scanner_present: false,
  }), false);
  assert.equal(entityIsCustomerVisible({
    name: "Deliberately hidden card",
    entity_type: "ambiguous",
    classification_source: "user",
    review_status: "user_confirmed",
    pull_status: "do_not_pull",
    scanner_present: true,
  }), true);
});

test("generic address and invocation context does not create standalone lore pages", () => {
  for (const [name, entityType] of [
    ["Dad", "term"],
    ["Dude", "term"],
    ["Mom", "term"],
    ["Jesus", "cultural_reference"],
    ["God", "species"],
  ] as const) {
    assert.equal(entityIsCustomerVisible({
      name,
      entity_type: entityType,
      classification_source: "local",
      review_status: "candidate",
      pull_status: "active",
      scanner_present: true,
    }), false);
  }
  assert.equal(entityIsCustomerVisible({
    name: "Gilgamesh",
    entity_type: "cultural_reference",
    classification_source: "local",
    review_status: "candidate",
    pull_status: "active",
    scanner_present: true,
  }), true);
  assert.equal(entityIsCustomerVisible({
    name: "Turncoats and Changelings",
    entity_type: "character",
    classification_source: "local",
    review_status: "candidate",
    pull_status: "active",
    scanner_present: true,
  }), false);
  assert.equal(entityIsCustomerVisible({
    name: "Research and Development",
    entity_type: "institution",
    classification_source: "local",
    review_status: "candidate",
    pull_status: "active",
    scanner_present: true,
  }), true);
  assert.equal(entityIsCustomerVisible({
    name: "Jesus",
    entity_type: "character",
    classification_source: "user",
    review_status: "user_confirmed",
    pull_status: "active",
    scanner_present: true,
  }), true);
});

test("non-entity questions never appear as Needs sorting cards", () => {
  assert.equal(entityIsCustomerVisible({
    name: "Esther's fate",
    summary: "The source does not establish whether she died.",
    entity_type: "ambiguous",
    classification_source: "ai",
    review_status: "verified",
    pull_status: "active",
    scanner_present: true,
  }), false);
  assert.equal(entityIsCustomerVisible({
    name: "Drayna",
    summary: "A named referent whose category is unresolved.",
    entity_type: "ambiguous",
    classification_source: "ai",
    review_status: "verified",
    pull_status: "active",
    scanner_present: true,
  }), true);
});

test("intake activity reports real discoveries, reclassification, and verification", () => {
  assert.equal(
    Object.values(intakeActivityPhraseInventory).flat().length,
    36,
  );
  assert.equal(
    new Set(Object.values(intakeActivityPhraseInventory).flat()).size,
    36,
  );
  const first = {
    phase: "deterministic" as const,
    extractor: "Storyhold rules",
    completedPassages: 12,
    totalPassages: 12,
    message: "Candidate terms found.",
    terms: [{
      name: "Echo",
      category: "ambiguous" as const,
      confidence: 0.51,
      mentionCount: 8,
      sourceCount: 1,
      reviewStatus: "candidate" as const,
    }],
  };
  const initial = intakeActivityFromPreview(null, first);
  assert.equal(initial.some((event) => event.entityName === "Echo" && event.label.includes("Echo")), true);
  assert.equal(initial.some((event) => event.label.endsWith("Echo as Unknown for Now")), true);
  assert.equal(initial.some((event) => event.label === "Private Term Scan Assembled"), true);

  const verified = intakeActivityFromPreview(first, {
    ...first,
    phase: "complete",
    extractor: "openai / test-model",
    message: "Connected verification complete.",
    terms: [{
      ...first.terms[0]!,
      category: "character",
      confidence: 0.96,
      reviewStatus: "verified",
    }],
  });
  assert.equal(verified.some((event) => event.kind === "classification" && event.label.endsWith("Echo as Person")), true);
  assert.equal(verified.some((event) => event.kind === "verification" && event.label.includes("Echo")), true);
  assert.equal(verified.some((event) => event.label === "Connected Verification Complete"), true);

  const localComplete = intakeActivityFromPreview(first, {
    ...first,
    phase: "complete",
    extractor: "Lorekeeper local sequence",
    message: "The world understanding is ready.",
  });
  assert.equal(localComplete.some((event) => event.label === "Story Understanding Ready"), true);
  assert.equal(localComplete.some((event) => event.label === "Connected Verification Complete"), false);
});

test("ambiguous intake classifications say Unknown for Now", () => {
  const previous = {
    phase: "deterministic" as const,
    extractor: "Storyhold rules",
    completedPassages: 1,
    totalPassages: 1,
    message: "",
    terms: [{
      name: "The Glass",
      category: "technology" as const,
      confidence: 0.4,
      mentionCount: 2,
      sourceCount: 1,
      reviewStatus: "candidate" as const,
    }],
  };
  const events = intakeActivityFromPreview(previous, {
    ...previous,
    phase: "semantic",
    terms: [{ ...previous.terms[0]!, category: "ambiguous" as const }],
  });
  assert.equal(
    events.some((event) => event.label.endsWith("The Glass as Unknown for Now")),
    true,
  );
});

test("intake activity title-cases extracted entity labels without capitalizing trailing prepositions", () => {
  const events = intakeActivityFromPreview(null, {
    phase: "semantic",
    extractor: "GLiNER 1",
    completedPassages: 1,
    totalPassages: 2,
    message: "",
    terms: [{
      name: "the glass",
      category: "ambiguous",
      confidence: 0.4,
      mentionCount: 2,
      sourceCount: 1,
      reviewStatus: "candidate",
    }],
  });
  const labels = events.map((event) => event.label);
  assert.equal(labels.some((label) => label.includes("The Glass")), true);
  assert.equal(labels.some((label) => /\b(?:To|For|Into|Around) The Glass$/u.test(label)), false);
});

test("customer intake activity scrubs historical local implementation copy without rewriting it", () => {
  const storedActivity = [{
    id: "activity-one",
    dedupeKey: "local-run:phase:complete:Qwen 4B / GLiNER2",
    kind: "discovery",
    label: "GLiNER2 Found Alec",
    detail: "MiniLM sent the semantic pass to the Qwen backend before BGE extraction.",
    entityName: "Alec",
    entityType: "character",
    occurredAt: "2026-08-01T00:00:00.000Z",
  }, {
    id: "activity-two",
    dedupeKey: "local-run:phase:complete:local sequence",
    kind: "complete",
    label: "Connected Verification Complete",
    detail: "Connected verification completed by the local model.",
    entityName: null,
    entityType: null,
    occurredAt: "2026-08-01T00:01:00.000Z",
  }];
  const original = structuredClone(storedActivity);

  const projected = customerSafeIntakeActivityRows(storedActivity, {
    runId: "local-run",
    analysisKind: "local_scan",
    status: "completed",
    stage: "complete",
    synthesisStatus: "not_applicable",
  });

  assert.deepEqual(storedActivity, original);
  assert.equal(projected[0]?.label.includes("Alec"), true);
  assert.equal(projected[1]?.label, "Story Understanding Ready");
  assert.doesNotMatch(
    JSON.stringify(projected),
    /Qwen|GLiNER|MiniLM|BGE|backend|semantic pass|local model|Connected Verification Complete/iu,
  );
  assert.equal(projected.every((event) => event.dedupeKey.startsWith("activity:")), true);
});

test("customer intake activity preserves only the current completed premium verification claim", () => {
  const projected = customerSafeIntakeActivityRows([{
    id: "old-local-event",
    dedupeKey: "old-local-run:phase:complete:legacy",
    kind: "complete",
    label: "Connected Verification Complete",
    detail: "The story evidence was checked.",
    entityName: null,
    entityType: null,
    occurredAt: "2026-08-01T00:00:00.000Z",
  }, {
    id: "current-premium-event",
    dedupeKey: "premium-run:phase:complete:connected",
    kind: "complete",
    label: "Connected Verification Complete",
    detail: "The story evidence was checked against cited passages.",
    entityName: null,
    entityType: null,
    occurredAt: "2026-08-01T00:02:00.000Z",
  }], {
    runId: "premium-run",
    analysisKind: "ai_enrichment",
    status: "completed",
    stage: "AI review complete; world model refreshed",
    synthesisStatus: "completed",
  });

  assert.equal(projected[0]?.label, "Story Understanding Ready");
  assert.equal(projected[1]?.label, "Connected Verification Complete");
});

test("customer run and entity projections do not expose private implementation routing", () => {
  const run = serializeRun({
    id: "run-1",
    provider: "openrouter",
    model: "private-model-name",
    status: "paused",
    stage: "GLiNER2 provider accounting reconciliation",
    error: "Python worker provider receipt failed",
    progress: 91,
    analysis_kind: "ai_enrichment",
    synthesis_status: "pending",
    local_ner_status: "completed",
    local_ner_provider: "gliner2",
    local_ner_model: "private-extractor",
    local_checkpoint: { completedStage: "semantic_embeddings" },
    premium_resume_status: "ready",
    customer_top_up_credits_needed: 3,
  })!;
  assert.equal(run.stage, "Premium Deep Reading Saved — Add Credits to Finish");
  assert.match(String(run.error), /completed review is saved/iu);
  assert.equal(run.localCheckpointStage, "saved");
  for (const privateField of [
    "provider", "model", "analysisVersion", "synthesisError",
    "localExtractionStatus", "localExtractionProvider", "localExtractionModel",
    "localExtractionError",
  ]) assert.equal(Object.hasOwn(run, privateField), false, privateField);

  const entity = serializeWorldEntity({
    id: "entity-1", canonical_key: "mara", name: "Mara", entity_type: "character",
    aliases: [], summary: "Mara guards the eastern gate.", details: [], relationships: [],
    evidence: [], mention_count: 4, mention_source_count: 1, confidence: 0.9,
    classification_source: "ai", review_status: "verified", pull_status: "active",
  }, [{ faction_entity_id: "faction-1", faction_name: "Wardens", assignment_source: "ai", confidence: 0.8 }]);
  assert.equal(Object.hasOwn(entity, "classificationSource"), false);
  assert.equal(Object.hasOwn(entity.factions[0]!, "assignmentSource"), false);
  const relation = serializeEntityRelation({
    id: "relation-1", source_entity_id: "entity-1", source_name: "Mara", source_type: "character",
    relation_type: "member_of", target_entity_id: "faction-1", target_name: "Wardens", target_type: "faction",
    relation_status: "active", summary: "Mara serves the Wardens.", evidence: [], assignment_source: "ai",
  });
  const rule = serializeEntityRule({
    id: "rule-1", entity_id: "entity-1", canonical_key: "gate-oath", name: "Gate Oath",
    description: "Mara cannot abandon her post.", rule_kind: "constraint", evidence: [], assignment_source: "ai",
    rule_status: "active",
  });
  assert.equal(Object.hasOwn(relation, "assignmentSource"), false);
  assert.equal(Object.hasOwn(rule, "assignmentSource"), false);
});

test("customer AI status hides provider routing while operator status retains it", () => {
  const runtime = {
    configured: true,
    mode: "connected",
    provider: "openrouter",
    model: "private/model-name",
    billable: true,
    sendsSourceTextOffDevice: true,
    explanation: "Private provider routing explanation.",
    stage: "verification",
    execution: {
      connectionId: "managed:openrouter",
      credentialSource: "environment",
      connectionSource: "storyhold_managed",
      billingSource: "storyhold_credits",
      requestedModel: "private/model-name",
      resolvedModel: null,
      upstreamProvider: null,
      privacyMode: "zero-data-retention",
    },
    localExtraction: {
      enabled: true,
      configured: true,
      provider: "gliner2",
      model: "private/local-model",
      endpoint: "http://127.0.0.1:8765/extract",
      endpointKind: "loopback",
      sendsSourceTextOffDevice: false,
      explanation: "Private local routing explanation.",
    },
    providers: [{
      id: "openrouter", label: "OpenRouter", configured: true,
      model: "private/model-name", supportsReasoningControl: true,
      eligibleForAdultNarration: true,
    }],
    routing: {
      director: "openrouter", narration: "openrouter",
      adultNarration: "openrouter", analysis: "openrouter",
      canonReview: "openrouter",
    },
    stageRouting: {
      extraction: "openrouter", verification: "openrouter",
      dossier: "openrouter", chronology: "openrouter",
      director: "openrouter", narration: "openrouter",
      adaptation: "openrouter",
    },
  } as const;
  const customer = customerAiRuntimeStatus(runtime, "player");
  assert.equal(customer.configured, true);
  assert.equal(customer.billable, true);
  assert.equal(customer.sendsSourceTextOffDevice, true);
  assert.equal(customer.model, "");
  assert.equal(customer.execution, null);
  assert.deepEqual(customer.providers, []);
  assert.equal(customer.localExtraction.model, "");
  assert.equal(customer.localExtraction.endpoint, null);
  assert.doesNotMatch(JSON.stringify(customer), /OpenRouter|GLiNER|private\/model|127\.0\.0\.1/iu);
  assert.equal(customerAiRuntimeStatus(runtime, "owner"), runtime);
  assert.equal(customerAiRuntimeStatus(runtime, "admin"), runtime);
});

test("post-run premium top-up calculation counts the existing hold before asking for more", () => {
  assert.equal(premiumTopUpCreditsNeeded({ actualCredits: 11, reservedCredits: 10, availableCredits: 0 }), 1);
  assert.equal(premiumTopUpCreditsNeeded({ actualCredits: 11, reservedCredits: 10, availableCredits: 4 }), 0);
  assert.equal(premiumTopUpCreditsNeeded({ actualCredits: 7, reservedCredits: 10, availableCredits: 0 }), 0);
});

test("author mode requires substantial manuscript material or a prose adaptation", () => {
  assert.equal(authorModeIsEligible(9_999, false), false);
  assert.equal(authorModeIsEligible(10_000, false), true);
  assert.equal(authorModeIsEligible(0, true), true);
});

test("a new local scan can correct an older local category but cannot erase an AI classification", () => {
  assert.equal(generatedEntityType({
    existingType: "character",
    existingSource: "local",
    incomingType: "ambiguous",
    incomingSource: "local",
  }), "ambiguous");
  assert.equal(generatedEntityType({
    existingType: "creature",
    existingSource: "ai",
    incomingType: "ambiguous",
    incomingSource: "local",
  }), "creature");
  assert.equal(generatedEntityType({
    existingType: "character",
    existingSource: "ai",
    incomingType: "cultural_reference",
    incomingSource: "local",
  }), "character");
  assert.equal(generatedEntityType({
    existingType: "place",
    existingSource: "ai",
    incomingType: "term",
    incomingSource: "local",
  }), "place");
  assert.equal(generatedEntityType({
    existingType: "creature",
    existingSource: "local",
    incomingType: "ambiguous",
    incomingSource: "ai",
  }), "ambiguous");
});

test("entity hypotheses are adjudicated once instead of overwriting a character by bucket order", () => {
  const evidence = (quote: string, index: number) => [{
    sourceId: "00000000-0000-4000-8000-000000000201",
    chunkId: `00000000-0000-4000-8000-${String(300 + index).padStart(12, "0")}`,
    quote,
  }];
  const kendall = adjudicateGeneratedEntityHypotheses({
    hypotheses: [{
      entityType: "character",
      finding: { name: "Kendall", summary: "A survivor and builder.", evidence: evidence("Kendall said they needed stronger walls.", 1) },
    }, {
      entityType: "technology",
      finding: { name: "Kendall", summary: "A mislabeled extraction candidate.", evidence: evidence("Kendall repaired the gate before nightfall.", 2) },
    }],
  });
  assert.equal(kendall?.entityType, "character");

  const sarah = adjudicateGeneratedEntityHypotheses({
    hasSubstantiveCharacterDossier: true,
    hypotheses: [{
      entityType: "character",
      finding: { name: "Sarah", summary: "A developed supporting character with a durable dossier.", evidence: [] },
    }, {
      entityType: "weapon",
      finding: { name: "Sarah", summary: "An unsupported weapon label.", evidence: [] },
    }],
  });
  assert.equal(sarah?.entityType, "character");

  const dad = adjudicateGeneratedEntityHypotheses({
    hasSubstantiveCharacterDossier: true,
    hypotheses: [{
      entityType: "character",
      finding: { name: "Dad", summary: "A familiar address.", evidence: [
        ...evidence('Dad said, "Stay here."', 3),
        ...evidence("Dad warned Alec about the road.", 4),
      ] },
    }],
  });
  assert.equal(dad?.entityType, "term");
});

test("explicit manuscript categories overrule stale generated dossiers during startup adjudication", () => {
  const evidence = (quote: string, index: number) => [{
    sourceId: "00000000-0000-4000-8000-000000000211",
    chunkId: `00000000-0000-4000-8000-${String(400 + index).padStart(12, "0")}`,
    quote,
  }];
  const staleCharacter = (name: string, quote: string, index: number) =>
    adjudicateGeneratedEntityHypotheses({
      hasSubstantiveCharacterDossier: true,
      hypotheses: [{
        entityType: "character",
        finding: {
          name,
          summary: `${name} has an older automatically generated character dossier.`,
          evidence: evidence(quote, index),
        },
      }],
    });

  assert.equal(staleCharacter(
    "Orona",
    "Orona was a moon whose orbit carried it around the outer planet.",
    1,
  )?.entityType, "place");
  assert.equal(staleCharacter(
    "Kethari",
    "The Kethari are a people whose descendants evolved on the desert homeworld.",
    2,
  )?.entityType, "species");
  assert.equal(staleCharacter(
    "Delta",
    "Delta team crossed the bridge and secured the landing zone.",
    3,
  )?.entityType, "faction");
  assert.equal(staleCharacter(
    "Red",
    "Command ordered Red and Blue teams prepped for the eastern approach.",
    6,
  )?.entityType, "faction");

  assert.equal(staleCharacter(
    "Elian",
    'Elian, a former teacher, said, "Stay together."',
    4,
  )?.entityType, "character");
  assert.equal(staleCharacter(
    "Rook",
    'My buddy Rook replied, "I will cover the door."',
    5,
  )?.entityType, "character");

  assert.equal(entityIsScannerProtected({
    classification_source: "user",
    review_status: "user_confirmed",
    pull_status: "active",
  }), true, "customer classifications remain outside automatic startup repair");
  assert.equal(generatedCategoryRepairShouldRestoreVisibility({
    categoryChanged: true,
    category: "faction",
    evidenceCount: 4,
  }), true, "a corrected generated team can return from the rejected scanner pool");
  assert.equal(generatedCategoryRepairShouldRestoreVisibility({
    categoryChanged: true,
    category: "ambiguous",
    evidenceCount: 4,
  }), false);
  assert.equal(generatedCategoryRepairShouldRestoreVisibility({
    categoryChanged: false,
    category: "faction",
    evidenceCount: 4,
  }), false);
});

test("generated dossier authority comes from character evidence, not boilerplate length", () => {
  assert.equal(generatedCharacterDossierIsSubstantive({
    name: "TV",
    role: "Locally Detected Character Candidate",
    summary: "This is a deliberately long generated paragraph that easily exceeds eighty characters but does not establish a person at all.",
    evidence: [
      { sourceId: "book", chunkId: "one", quote: "The TV showed only static." },
      { sourceId: "book", chunkId: "two", quote: "They left the TV running." },
    ],
  }), false);
  assert.equal(generatedCharacterDossierIsSubstantive({
    name: "Mathis",
    role: "Supporting Character",
    summary: "Mathis helps build and defend the settlement.",
    evidence: [{ sourceId: "book", chunkId: "one", quote: 'Mathis said, "I will take first watch."' }],
  }), true);
  assert.equal(generatedCharacterDossierIsSubstantive({
    name: "Alec",
    role: "Central Point-of-View Character",
    summary: "As a central point-of-view character, Alec's choices and perspective anchor much of the story.",
    evidence: [],
  }), true);
  assert.equal(generatedCharacterDossierIsSubstantive({
    name: "Michael",
    role: "Major Character",
    summary: "Michael has a substantial recurring role.",
    profile: { history: ["Michael supports his friend through a family crisis."] },
    mentionCount: 153,
    mentionSourceCount: 2,
    evidence: [
      { sourceId: "book-one", chunkId: "one", quote: "Michael jogged up beside Alec." },
      { sourceId: "book-two", chunkId: "two", quote: "Alec searched for Michael after the attack." },
    ],
  }), true);
  assert.equal(generatedCharacterDossierIsSubstantive({
    name: "Prowler",
    role: "Recurring Character",
    summary: "An earlier pass wrote a long portrait.",
    profile: { traits: ["Aggressive"] },
    mentionCount: 24,
    evidence: [
      { sourceId: "book", chunkId: "one", quote: "The Prowler hissed and raised its claws." },
      { sourceId: "book", chunkId: "two", quote: "A Prowler lunged from the dark." },
    ],
  }), false);
});

const membershipEntityId = "00000000-0000-4000-8000-000000000101";
const membershipFactionId = "00000000-0000-4000-8000-000000000102";
const membershipChunkId = "00000000-0000-4000-8000-000000000103";
const membershipSourceId = "00000000-0000-4000-8000-000000000104";

test("legacy full counters cannot suppress a non-authoritative AI review", () => {
  const source = {
    content_hash: "current-hash",
    chunk_count: 298,
    ai_review_status: "waiting",
    ai_reviewed_content_hash: "current-hash",
    ai_analysis_version: WORLD_ANALYSIS_VERSION,
    ai_reviewed_chunk_count: 298,
    ai_coverage_authoritative: false,
  };
  assert.equal(sourceNeedsAiReview(source), true);
  assert.equal(sourceNeedsAiReview({
    ...source,
    ai_review_status: "reviewed",
  }), true);
  assert.equal(sourceNeedsAiReview({
    ...source,
    ai_review_status: "reviewed",
    ai_coverage_authoritative: true,
  }), false);
});

test("legacy non-authoritative coverage forces a complete replacement review", () => {
  const current = {
    id: "current-source",
    content_hash: "current-hash",
    chunk_count: 298,
    ai_review_status: "waiting",
    ai_reviewed_content_hash: "current-hash",
    ai_analysis_version: WORLD_ANALYSIS_VERSION,
    ai_reviewed_chunk_count: 298,
    ai_coverage_authoritative: false,
  };
  const alreadyCovered = {
    ...current,
    id: "covered-source",
    chunk_count: 224,
    ai_review_status: "reviewed",
    ai_reviewed_chunk_count: 224,
    ai_coverage_authoritative: true,
  };

  const plan = aiReviewQueuePlan({
    eligible: [alreadyCovered, current],
  });
  assert.equal(plan.incremental, false);
  assert.deepEqual(
    plan.sources.map((source) => source.id),
    ["covered-source", "current-source"],
    "a replacement review must reread the complete edition",
  );
});

test("manual full review intent and stale coverage replace the complete snapshot", () => {
  const pristine = {
    id: "new-source",
    content_hash: "new-hash",
    chunk_count: 12,
    ai_review_status: "waiting",
    ai_reviewed_content_hash: null,
    ai_analysis_version: 0,
    ai_reviewed_chunk_count: 0,
    ai_coverage_authoritative: false,
  };
  const covered = {
    ...pristine,
    id: "covered-source",
    content_hash: "covered-hash",
    ai_review_status: "reviewed",
    ai_reviewed_content_hash: "covered-hash",
    ai_analysis_version: WORLD_ANALYSIS_VERSION,
    ai_reviewed_chunk_count: 12,
    ai_coverage_authoritative: true,
  };
  const stale = {
    ...covered,
    id: "stale-source",
    content_hash: "changed-hash",
  };

  const manualPlan = aiReviewQueuePlan({
    eligible: [covered, pristine],
    forceFull: true,
  });
  assert.equal(manualPlan.incremental, false);
  assert.deepEqual(
    manualPlan.sources.map((source) => source.id),
    ["covered-source", "new-source"],
  );

  const stalePlan = aiReviewQueuePlan({ eligible: [covered, stale] });
  assert.equal(stalePlan.incremental, false);
  assert.deepEqual(
    stalePlan.sources.map((source) => source.id),
    ["covered-source", "stale-source"],
  );
});

test("new uploads and authoritative partial reviews remain incremental", () => {
  const covered = {
    id: "covered-source",
    content_hash: "covered-hash",
    chunk_count: 20,
    ai_review_status: "reviewed",
    ai_reviewed_content_hash: "covered-hash",
    ai_analysis_version: WORLD_ANALYSIS_VERSION,
    ai_reviewed_chunk_count: 20,
    ai_coverage_authoritative: true,
  };
  const pristine = {
    ...covered,
    id: "new-source",
    content_hash: "new-hash",
    ai_review_status: "waiting",
    ai_reviewed_content_hash: null,
    ai_analysis_version: 0,
    ai_reviewed_chunk_count: 0,
    ai_coverage_authoritative: false,
  };
  const partial = {
    ...covered,
    id: "partial-source",
    ai_review_status: "waiting",
    ai_reviewed_chunk_count: 7,
  };

  const uploadPlan = aiReviewQueuePlan({ eligible: [covered, pristine] });
  assert.equal(uploadPlan.incremental, true);
  assert.deepEqual(
    uploadPlan.sources.map((source) => source.id),
    ["new-source"],
  );

  const resumePlan = aiReviewQueuePlan({ eligible: [covered, partial] });
  assert.equal(resumePlan.incremental, true);
  assert.deepEqual(
    resumePlan.sources.map((source) => source.id),
    ["partial-source"],
  );
});

test("restart chapter sync preserves a current authoritative AI map", async () => {
  const db = new PGlite();
  const worldId = "10000000-0000-4000-8000-000000000001";
  const editionId = "10000000-0000-4000-8000-000000000002";
  const sourceId = "10000000-0000-4000-8000-000000000003";
  const unreviewedSourceId = "10000000-0000-4000-8000-000000000004";
  try {
    await db.exec(`
      CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.world_sources (
        id uuid PRIMARY KEY,
        world_id uuid NOT NULL,
        canon_edition_id uuid NOT NULL,
        content_hash text NOT NULL,
        chunk_count integer NOT NULL,
        ai_review_status text NOT NULL,
        ai_reviewed_content_hash text,
        ai_analysis_version integer NOT NULL,
        ai_reviewed_chunk_count integer NOT NULL,
        ai_coverage_authoritative boolean NOT NULL
      );
      CREATE TABLE storyhold.world_chapter_summaries (
        id uuid PRIMARY KEY,
        world_id uuid NOT NULL,
        canon_edition_id uuid NOT NULL,
        source_id uuid NOT NULL,
        canonical_key text NOT NULL,
        chapter_title text NOT NULL,
        perspective text NOT NULL DEFAULT '',
        source_order integer NOT NULL DEFAULT 0,
        summary text NOT NULL DEFAULT '',
        major_events jsonb NOT NULL DEFAULT '[]'::jsonb,
        evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
        summary_source text NOT NULL,
        confidence real NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (world_id, canonical_key)
      );
      CREATE TABLE storyhold.world_source_chunks (
        id uuid PRIMARY KEY,
        source_id uuid NOT NULL,
        chunk_index integer NOT NULL,
        content text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE TABLE storyhold.world_clock_events (
        id uuid PRIMARY KEY,
        world_id uuid NOT NULL,
        canon_edition_id uuid,
        campaign_id uuid,
        source_id uuid,
        created_by_player_id uuid,
        assignment_source text NOT NULL DEFAULT 'local',
        canonical_key text NOT NULL,
        event_kind text NOT NULL,
        title text NOT NULL,
        summary text NOT NULL DEFAULT '',
        world_time_label text NOT NULL DEFAULT '',
        chronology_order bigint NOT NULL DEFAULT 0,
        temporal_status text NOT NULL DEFAULT 'relative',
        importance text NOT NULL DEFAULT 'major',
        source_chapter_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
        visibility text NOT NULL DEFAULT 'world',
        knowledge_status text NOT NULL DEFAULT 'observed',
        evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (world_id, canonical_key)
      );
      CREATE TABLE storyhold.world_clock_event_verifications (
        event_id uuid NOT NULL
      );
    `);
    await db.query(
      `INSERT INTO storyhold.world_sources
        (id, world_id, canon_edition_id, content_hash, chunk_count,
         ai_review_status, ai_reviewed_content_hash, ai_analysis_version,
         ai_reviewed_chunk_count, ai_coverage_authoritative)
       VALUES
        ($1, $2, $3, 'current-hash', 298, 'reviewed', 'current-hash', $5, 298, true),
        ($4, $2, $3, 'new-hash', 12, 'waiting', NULL, 0, 0, false)`,
      [sourceId, worldId, editionId, unreviewedSourceId, WORLD_ANALYSIS_VERSION],
    );
    await db.query(
      `INSERT INTO storyhold.world_clock_events
        (id, world_id, canon_edition_id, source_id, canonical_key, event_kind,
         title, summary, visibility, knowledge_status)
       VALUES ('10000000-0000-4000-8000-000000000099', $1, $2, $3,
               'source-chapter-v2-old-guide', 'canon', 'Old chapter guide',
               'An inexpensive parser summary.', 'world', 'observed')`,
      [worldId, editionId, sourceId],
    );
    await db.query(
      `INSERT INTO storyhold.world_chapter_summaries
        (id, world_id, canon_edition_id, source_id, canonical_key,
         chapter_title, source_order, summary, major_events, summary_source, confidence)
       SELECT ('20000000-0000-4000-8000-' || lpad(chapter_number::text, 12, '0'))::uuid,
              $1::uuid, $2::uuid, $3::uuid, $4::text || ':ai-chapter-' || chapter_number,
              'Canonical chapter ' || chapter_number, chapter_number,
              'Authoritative summary ' || chapter_number,
              jsonb_build_array('Canonical event ' || chapter_number), 'ai', 0.94
         FROM generate_series(1, 46) AS chapter_number`,
      [worldId, editionId, sourceId, sourceId],
    );
    await db.query(
      `INSERT INTO storyhold.world_chapter_summaries
        (id, world_id, canon_edition_id, source_id, canonical_key,
         chapter_title, perspective, source_order, summary, major_events,
         evidence, summary_source, confidence, created_at, updated_at)
       VALUES
        ('20000000-0000-4000-8000-000000000100', $1, $2, $3,
         $4::text || ':prologue', 'Canonical Prologue', 'Canonical POV', 88,
         'The connected review owns this summary.', '["Canonical event"]'::jsonb,
         '[{"sourceId":"canonical","chunkId":"canonical","quote":"Canonical evidence."}]'::jsonb,
         'ai', 0.91, '2025-01-02T03:04:05Z', '2025-01-02T03:04:05Z')`,
      [worldId, editionId, unreviewedSourceId, unreviewedSourceId],
    );
    await db.query(
      `INSERT INTO storyhold.world_chapter_summaries
        (id, world_id, canon_edition_id, source_id, canonical_key,
         chapter_title, source_order, summary, summary_source, confidence)
       VALUES
        ('30000000-0000-4000-8000-000000000001', $1, $2, $3,
         $5::text || ':prologue-2', 'Prologue — An Old Dog''s Tale A', 47,
         'Stale parser summary', 'local', 0.45),
        ('30000000-0000-4000-8000-000000000002', $1, $2, $4,
         $6::text || ':local-chapter', 'New local chapter', 1,
         'Useful local summary', 'local', 0.45)`,
      [worldId, editionId, sourceId, unreviewedSourceId, sourceId, unreviewedSourceId],
    );

    const before = await db.query<Record<string, unknown>>(
      `SELECT *
         FROM storyhold.world_chapter_summaries
        WHERE source_id = $1 AND summary_source = 'ai'
        ORDER BY source_order`,
      [sourceId],
    );
    assert.equal(before.rows.length, 46);

    await syncSourceChapterSummaries({
      db,
      worldId,
      editionId,
      sourceId,
      sourceTitle: "ASHES Book One",
      chronologyLabel: "Book One",
      chronologyOrder: 1,
      extractedText: "Prologue — An Old Dog's Tale A\n\nA stale local parse.",
    });

    const after = await db.query<Record<string, unknown>>(
      `SELECT *
         FROM storyhold.world_chapter_summaries
        WHERE source_id = $1 AND summary_source = 'ai'
        ORDER BY source_order`,
      [sourceId],
    );
    assert.deepEqual(after.rows, before.rows, "all 46 AI chapter rows must remain byte-for-byte equivalent");
    const staleLocal = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM storyhold.world_chapter_summaries
        WHERE source_id = $1 AND summary_source = 'local'`,
      [sourceId],
    );
    assert.equal(staleLocal.rows[0]?.count, 0);
    const oldGuide = await db.query<{
      visibility: string;
      knowledge_status: string;
    }>(
      `SELECT visibility, knowledge_status
         FROM storyhold.world_clock_events
        WHERE canonical_key = 'source-chapter-v2-old-guide'`,
    );
    assert.deepEqual(oldGuide.rows[0], {
      visibility: "studio",
      knowledge_status: "inferred",
    }, "an authoritative chapter map must not promote ordinary chapter prose as verified canon events");

    const unreviewed = await reconcileAuthoritativeAiChapterMap({
      db,
      worldId,
      editionId,
      sourceId: unreviewedSourceId,
    });
    assert.deepEqual(unreviewed, { authoritative: false, removedLocalRows: 0 });
    const collidingAiBefore = await db.query<Record<string, unknown>>(
      `SELECT * FROM storyhold.world_chapter_summaries
        WHERE source_id = $1 AND canonical_key = $2`,
      [unreviewedSourceId, `${unreviewedSourceId}:prologue`],
    );
    assert.equal(collidingAiBefore.rows.length, 1);
    await syncSourceChapterSummaries({
      db,
      worldId,
      editionId,
      sourceId: unreviewedSourceId,
      sourceTitle: "Unreviewed manuscript",
      chronologyLabel: "New material",
      chronologyOrder: 2,
      extractedText:
        "Prologue\nThe local parser discovers a chapter that deliberately collides with an existing AI key.\n\nChapter 2\nA genuinely new chapter still receives its inexpensive local index.",
    });
    const collidingAiAfter = await db.query<Record<string, unknown>>(
      `SELECT * FROM storyhold.world_chapter_summaries
        WHERE source_id = $1 AND canonical_key = $2`,
      [unreviewedSourceId, `${unreviewedSourceId}:prologue`],
    );
    assert.deepEqual(
      collidingAiAfter.rows,
      collidingAiBefore.rows,
      "a local scan must never modify any column of an AI-owned collision",
    );
    const usefulLocal = await db.query<{ canonical_key: string }>(
      `SELECT canonical_key
         FROM storyhold.world_chapter_summaries
        WHERE source_id = $1 AND summary_source = 'local'
        ORDER BY canonical_key`,
      [unreviewedSourceId],
    );
    assert.deepEqual(
      usefulLocal.rows.map((row) => row.canonical_key),
      [
        `${unreviewedSourceId}:chapter-2`,
        `${unreviewedSourceId}:local-chapter`,
      ],
      "unreviewed sources retain local indexing around protected AI collisions",
    );
  } finally {
    await db.close();
  }
});

test("normalized faction memberships prefer the matching cited member_of edge", () => {
  const relationEvidence = {
    chunkId: membershipChunkId,
    sourceId: membershipSourceId,
    quote: "Ragger stood with the Turncoats.",
  };
  const fallbackEvidence = {
    chunkId: "00000000-0000-4000-8000-000000000105",
    sourceId: membershipSourceId,
    quote: "Ragger crossed the ruined road.",
  };
  const evidence = factionMembershipEvidence({
    entityId: membershipEntityId,
    factionId: membershipFactionId,
    relations: [{
      subject: "Ragger",
      relationType: "member_of",
      target: "Turncoats",
      status: "active",
      summary: "Ragger joined the Turncoats.",
      validFromLabel: "",
      validUntilLabel: "",
      evidence: [relationEvidence],
      confidence: 0.95,
      reviewStatus: "verified",
    }],
    fallbackEvidence: [fallbackEvidence],
    resolveEntityId: (name) => name === "Ragger" ? membershipEntityId : null,
    resolveFactionId: (name) => name === "Turncoats" ? membershipFactionId : null,
  });

  assert.deepEqual(evidence, [relationEvidence]);
});

test("normalized faction memberships reuse grounded parent evidence but never invent it", () => {
  const fallbackEvidence = {
    chunkId: membershipChunkId,
    sourceId: membershipSourceId,
    quote: "Together, humanity and Turncoat, with the Destroyer at our head.",
  };
  const common = {
    entityId: membershipEntityId,
    factionId: membershipFactionId,
    relations: [],
    resolveEntityId: () => null,
    resolveFactionId: () => null,
  };
  assert.deepEqual(
    factionMembershipEvidence({ ...common, fallbackEvidence: [fallbackEvidence] }),
    [fallbackEvidence],
  );
  assert.deepEqual(
    factionMembershipEvidence({
      ...common,
      fallbackEvidence: [{ chunkId: "made-up", quote: "unsupported" }],
    }),
    [],
  );
});

test("generated membership evidence updates generated rows without overwriting user canon", async () => {
  const db = new PGlite();
  const secondEntityId = "00000000-0000-4000-8000-000000000106";
  const generatedEvidence = [{
    chunkId: membershipChunkId,
    sourceId: membershipSourceId,
    quote: "Ragger stood with the Turncoats.",
  }];
  try {
    await db.exec(`
      CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.world_entity_faction_memberships (
        entity_id uuid NOT NULL,
        faction_entity_id uuid NOT NULL,
        assignment_source text NOT NULL,
        confidence real NOT NULL,
        evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (entity_id, faction_entity_id)
      );
    `);
    await db.query(
      `INSERT INTO storyhold.world_entity_faction_memberships
        (entity_id, faction_entity_id, assignment_source, confidence, evidence)
       VALUES ($1, $2, 'ai', 0.4, '[]'::jsonb),
              ($3, $2, 'user', 1, '[{"quote":"customer decision"}]'::jsonb)`,
      [membershipEntityId, membershipFactionId, secondEntityId],
    );

    await persistGeneratedFactionMembership({
      db,
      entityId: membershipEntityId,
      factionId: membershipFactionId,
      assignmentSource: "ai",
      confidence: 0.9,
      evidence: generatedEvidence,
    });
    await persistGeneratedFactionMembership({
      db,
      entityId: membershipEntityId,
      factionId: membershipFactionId,
      assignmentSource: "ai",
      confidence: 0.5,
      evidence: [],
    });
    await persistGeneratedFactionMembership({
      db,
      entityId: secondEntityId,
      factionId: membershipFactionId,
      assignmentSource: "ai",
      confidence: 0.9,
      evidence: generatedEvidence,
    });

    const rows = await db.query<{
      entity_id: string;
      assignment_source: string;
      confidence: number;
      evidence: unknown[];
    }>(
      `SELECT entity_id, assignment_source, confidence, evidence
         FROM storyhold.world_entity_faction_memberships
        ORDER BY entity_id`,
    );
    assert.deepEqual(rows.rows[0], {
      entity_id: membershipEntityId,
      assignment_source: "ai",
      confidence: 0.9,
      evidence: generatedEvidence,
    });
    assert.deepEqual(rows.rows[1], {
      entity_id: secondEntityId,
      assignment_source: "user",
      confidence: 1,
      evidence: [{ quote: "customer decision" }],
    });
  } finally {
    await db.close();
  }
});

test("entity-rule references report missing and ambiguous owners", () => {
  const rule = {
    entity: "Visharath",
    name: "Hive obedience",
    ruleKind: "biological" as const,
  };
  assert.deepEqual(
    resolveEntityRuleReference(rule, new Map()),
    {
      entityId: null,
      issue: {
        kind: "entity_rule",
        label: "Visharath",
        resolution: "missing",
        context: "Hive obedience",
        metadata: {
          ruleName: "Hive obedience",
          ruleKind: "biological",
        },
      },
    },
  );
  assert.equal(
    resolveEntityRuleReference(
      rule,
      new Map([["visharath", null]]),
    ).issue?.resolution,
    "ambiguous",
  );
  assert.deepEqual(
    resolveEntityRuleReference(
      rule,
      new Map([["visharath", "canonical-visharath"]]),
    ),
    { entityId: "canonical-visharath", issue: null },
  );
});

test("automatic dossier writes recognize the customer-edit ownership marker", () => {
  assert.equal(dossierIsCustomerEdited(undefined), false);
  assert.equal(dossierIsCustomerEdited({}), false);
  assert.equal(dossierIsCustomerEdited({ user_edited_at: null }), false);
  assert.equal(dossierIsCustomerEdited({ user_edited_at: "" }), false);
  assert.equal(
    dossierIsCustomerEdited({ user_edited_at: "2026-08-15T22:00:00.000Z" }),
    true,
  );
  assert.equal(dossierIsCustomerEdited({ user_edited_at: new Date(0) }), true);
});

test("stale linked dossiers are repaired even after the overview card is safe", () => {
  assert.equal(generatedLocalEntityNeedsPresentationRepair({
    categoryChanged: false,
    category: "character",
    entitySummary: "Raider Dave is a recurring survivor whose actions affect the settlement.",
    dossierSummary: "Raider Dave appears in 60 grounded passages. Storyhold is assembling the evidence into a provisional dossier.",
  }), true);
  assert.equal(generatedLocalEntityNeedsPresentationRepair({
    categoryChanged: false,
    category: "character",
    entitySummary: "Raider Dave is a recurring survivor whose actions affect the settlement.",
    dossierSummary: "Raider Dave is a tense, capable survivor whose choices repeatedly put him at odds with Alec.",
  }), false);
  assert.equal(generatedLocalEntityNeedsPresentationRepair({
    categoryChanged: false,
    category: "character",
    entitySummary: "Esther is remembered by the survivors.",
    dossierSummary: "Esther's actions recur across the story.",
  }), true);
});

test("generated dossier serialization hides process prose but preserves customer edits", () => {
  const generated = serializeDossier({
    id: "dossier",
    name: "Alicia",
    summary: "Alicia appears in 15 grounded passages. Storyhold is assembling the evidence into a provisional dossier.",
    evidence: [{ sourceId: "book", chunkId: "chapter", quote: 'Alicia said, "We should leave now."' }],
  });
  assert.doesNotMatch(generated.summary, /Storyhold|provisional|grounded passages|backend|GLiNER|Qwen|BGE/iu);
  assert.match(generated.summary, /^Alicia\b/u);

  const customer = serializeDossier({
    id: "edited",
    name: "Alicia",
    summary: "My deliberately provisional wording is authoritative.",
    user_edited_at: "2026-08-27T12:00:00.000Z",
  });
  assert.equal(customer.summary, "My deliberately provisional wording is authoritative.");
});

test("dossier serialization uses the active Hold entity's composite alias count", () => {
  const serialized = serializeDossier({
    id: "dossier",
    name: "Ari Vale",
    summary: "Ari Vale anchors the story.",
    profile: {},
    evidence: [],
    mention_count: 5,
    mention_source_count: 1,
    hold_mention_count: 47,
    hold_mention_source_count: 3,
  });

  assert.equal(serialized.mentionCount, 47);
  assert.equal(serialized.mentionSourceCount, 3);
});

test("targeted dossier migration enriches only repaired targets while retaining the cast as context", () => {
  const unsetStat = () => ({
    score: 10,
    confidence: 0.1,
    rationale: "Not yet established.",
    evidence: [],
  });
  const character = (name: string, summary = `${name} appears in the story.`): CharacterFinding => ({
    name,
    aliases: [],
    role: "Character",
    summary,
    traits: [],
    motivations: [],
    fears: [],
    capabilities: [],
    history: [],
    origins: [],
    powers: [],
    moralSystem: [],
    physicalCharacteristics: [],
    relationships: [],
    relationshipWeb: [],
    estimatedStats: {
      strength: unsetStat(),
      dexterity: unsetStat(),
      constitution: unsetStat(),
      intelligence: unsetStat(),
      wisdom: unsetStat(),
      charisma: unsetStat(),
      acrobatics: unsetStat(),
    },
    socioPoliticalAxis: {
      economic: 0,
      authority: 0,
      label: "Undetermined",
      rationale: "Insufficient evidence.",
      confidence: 0.1,
    },
    knowledge: [],
    secrets: [],
    factionMemberships: [],
    evidence: [],
    confidence: 0.75,
  });
  const cast = ["Alec", "Echo", "Lilly", "Michael", "David"].map((name) =>
    character(name)
  );
  const repairs = [
    character("Alec", "Alec's repaired dossier."),
    character("Echo", "Echo's repaired dossier."),
  ];
  const targets = ["Alec", "Echo", "Absent Character"];
  const deterministicCharacters = selectLocalDossierEnrichmentCharacters({
    findingsCharacters: cast,
    repairCharacters: repairs,
    targetCharacterNames: targets,
  });
  const connectionCharacters = cast.filter((candidate) =>
    !new Set(deterministicCharacters.map((target) => target.name)).has(candidate.name)
  );

  assert.deepEqual(
    deterministicCharacters.map((candidate) => candidate.name),
    ["Alec", "Echo"],
  );
  assert.deepEqual(
    selectLocalDossierEnrichmentCharacters({
      findingsCharacters: cast,
      repairCharacters: [
        character("Alec Sumner", "Alec's renamed dossier."),
        character("David", "David's surviving merged dossier."),
      ],
      targetCharacterNames: ["Alec", "Raider Dave"],
    }).map((candidate) => candidate.name),
    ["Alec Sumner", "David"],
    "already-scoped repair rows must survive canonical rename and member merge",
  );
  assert.deepEqual(
    connectionCharacters.map((candidate) => candidate.name),
    ["Lilly", "Michael", "David"],
  );
  assert.deepEqual(
    selectLocalDossierEnrichmentCharacters({
      findingsCharacters: cast,
      repairCharacters: repairs,
      targetCharacterNames: [],
    }).map((candidate) => [candidate.name, candidate.summary]),
    [
      ["Alec", "Alec's repaired dossier."],
      ["Echo", "Echo's repaired dossier."],
      ["Lilly", "Lilly appears in the story."],
      ["Michael", "Michael appears in the story."],
      ["David", "David appears in the story."],
    ],
  );

  const findings: WorldFindings = {
    summary: "",
    genres: [],
    atmosphere: [],
    themes: [],
    worldRules: [],
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
    chapterSummaries: [],
    chronology: [],
    openQuestions: [],
    recurringTerms: [],
    characters: deterministicCharacters,
    entityRelations: [],
    entityRules: [],
    cohesionProposals: [],
  };
  const batchCalls: Array<{
    characterNames: string[];
    connectionCharacterNames: string[];
  }> = [];
  const projected = enrichLocalDossierProjection({
    findings,
    signals: [],
    chunks: [{
      id: "alec-and-david",
      sourceId: "book",
      sourceTitle: "Book One",
      index: 0,
      sectionTitle: "Chapter One (Alec - Present)",
      content: "Alec and David are trusted friends.",
    }, {
      id: "echo-and-alec",
      sourceId: "book",
      sourceTitle: "Book One",
      index: 1,
      sectionTitle: "Chapter Two (Alec - Present)",
      content: "Echo lives inside Alec's mind and speaks to him there.",
    }, {
      id: "lilly-and-michael",
      sourceId: "book",
      sourceTitle: "Book One",
      index: 2,
      sectionTitle: "Chapter Three (Lilly - Present)",
      content: "Lilly warned Michael before the gates closed.",
    }],
    connectionCharacters,
    onDeterministicBatch: (batch) => batchCalls.push(batch),
  });

  assert.equal(batchCalls.length, 1);
  assert.deepEqual(batchCalls[0], {
    characterNames: ["Alec", "Echo"],
    connectionCharacterNames: ["Lilly", "Michael", "David"],
  });
  assert.deepEqual(projected.characters.map((candidate) => candidate.name), ["Alec", "Echo"]);
});

test("startup and final persistence projections preserve durable profile facts while removing generated scene beats", () => {
  const unsetStat = () => ({
    score: 10,
    confidence: 0.1,
    rationale: "Not yet established.",
    evidence: [],
  });
  const character: CharacterFinding = {
    name: "Alec",
    aliases: [],
    role: "Supporting Character",
    summary: "",
    traits: ["Protective"],
    motivations: ["Keep the settlement alive"],
    fears: ["Losing his family"],
    capabilities: ["Repairs damaged equipment"],
    history: ["Survived the first attack"],
    origins: ["Came from Utah"],
    powers: ["Transforms with Echo"],
    moralSystem: ["Accepts responsibility for others"],
    physicalCharacteristics: ["Carries old scars"],
    relationships: ["Lilly: Partner"],
    relationshipWeb: [{
      name: "Lilly",
      relationship: "Partner",
      summary: "Alec and Lilly are partners.",
      sentiment: "romantic",
      evidence: [{ chunkId: "one", sourceId: "book", quote: "Alec took Lilly's hand." }],
    }],
    estimatedStats: {
      strength: unsetStat(),
      dexterity: unsetStat(),
      constitution: unsetStat(),
      intelligence: unsetStat(),
      wisdom: unsetStat(),
      charisma: unsetStat(),
      acrobatics: unsetStat(),
    },
    socioPoliticalAxis: {
      economic: 0,
      authority: 0,
      label: "Undetermined",
      rationale: "Insufficient evidence.",
      confidence: 0.1,
    },
    knowledge: ["Knows the access codes"],
    secrets: ["Hides Echo's presence"],
    factionMemberships: ["Sanctuary"],
    evidence: [],
    confidence: 0.7,
    mentionCount: 40,
    mentionSourceCount: 1,
  };
  const findings: WorldFindings = {
    summary: "",
    genres: [],
    atmosphere: [],
    themes: [],
    worldRules: [],
    locations: [{
      name: "Sanctuary",
      summary: "A settlement.",
      evidence: [],
      mentionCount: 20,
      confidence: 0.9,
    }],
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
    chapterSummaries: [],
    chronology: [],
    openQuestions: [],
    recurringTerms: [],
    characters: [character],
    entityRelations: [],
    entityRules: [],
    cohesionProposals: [],
  };

  const projected = enrichLocalDossierProjection({
    findings,
    signals: [],
    chunks: [
      {
        id: "one",
        sourceId: "book",
        sourceTitle: "ASHES",
        index: 0,
        sectionTitle: "Chapter One (Alec - Present)",
        content: "Alec took Lilly's hand and watched the walls.",
      },
      {
        id: "two",
        sourceId: "book",
        sourceTitle: "ASHES",
        index: 1,
        sectionTitle: "Chapter One (Alec - Present)",
        content: "Alec warned the others before the attack.",
      },
    ],
    rebuildConnections: false,
  }).characters[0]!;

  assert.match(projected.summary, /^Alec\b/u);
  assert.equal(projected.role, "Point-of-View Character");
  assert.doesNotMatch(projected.summary, /central point-of-view character/iu);
  for (const field of [
    "traits", "motivations", "fears", "capabilities", "history", "origins",
    "powers", "moralSystem", "physicalCharacteristics", "relationships",
    "relationshipWeb", "estimatedStats", "socioPoliticalAxis", "knowledge",
    "secrets", "factionMemberships",
  ] as const) {
    assert.deepEqual(projected[field], character[field], `${field} must remain unchanged`);
  }

  const staleGeneratedCharacter: CharacterFinding = {
    ...character,
    aliases: ["Alec Alec"],
    summary: "A seasoned settlement engineer, Alec is protective and practical under pressure. Alec suddenly became aware that Dave was waving a hand in front of their face. Alec raised an eyebrow at the damaged plumbing. Alec's fingers transformed into spears and punctured his torso.",
    history: [
      "Alec survived the first attack and returned home.",
      "Alec suddenly became aware that Dave was waving a hand in front of their face.",
      "Alec's fingers transformed into spears and punctured his torso.",
    ],
    origins: [
      "Alec came from a remote coastal settlement.",
      "Alec raised an eyebrow and considered hiring a plumber.",
    ],
    knowledge: ["Knows Savior of the world.", "Knows the access codes."],
  };
  const sanitized = enrichLocalDossierProjection({
    findings: { ...findings, characters: [staleGeneratedCharacter] },
    signals: [],
    chunks: [],
    rebuildConnections: false,
  }).characters[0]!;
  assert.deepEqual(sanitized.aliases, []);
  assert.match(sanitized.summary, /seasoned settlement engineer/iu);
  assert.doesNotMatch(sanitized.summary, /became aware|waving a hand|raised an eyebrow|punctured his torso/iu);
  assert.deepEqual(sanitized.history, ["Alec survived the first attack and returned home."]);
  assert.deepEqual(sanitized.origins, ["Alec came from a remote coastal settlement."]);
  assert.deepEqual(sanitized.knowledge, ["Knows the access codes."]);

  const staleSelfIdentification: CharacterFinding = {
    ...character,
    name: "Tarin",
    aliases: ["Kaelor Venn", "Warden"],
    role: "Point-of-View Character",
    summary: "Tarin is a seasoned expedition guide who protects the people in his care. Tarin identifies themself as Kaelor Venn, queen.",
    history: [
      "Tarin survived the destruction of the old empire.",
      "Tarin identifies themself as Kaelor Venn, queen.",
    ],
  };
  const correctedSelfIdentification = enrichLocalDossierProjection({
    findings: { ...findings, characters: [staleSelfIdentification] },
    signals: [],
    chunks: [{
      id: "first-introduction",
      sourceId: "book",
      sourceTitle: "Volume Two",
      index: 40,
      sectionTitle: "Chapter Six (Tarin - Present)",
      content: '"I am Kaelor Venn, loyal son and regent to the Queen," Tarin said.',
    }, {
      id: "full-introduction",
      sourceId: "book",
      sourceTitle: "Volume Two",
      index: 80,
      sectionTitle: "Chapter Twelve (Mara - Present)",
      content: '"I am Kaelor Venn. The fallen high regent of the old empire, once second only to the Queen herself. First Kaelor, the Protector, ruler and General of the flagship Iron Skies, and known to your kind as \'the Warden\' - the Ancient God of Death."',
    }],
    rebuildConnections: false,
  }).characters[0]!;
  assert.equal(correctedSelfIdentification.role, "Point-of-View Character");
  assert.match(correctedSelfIdentification.summary, /identifies themself as Kaelor Venn/iu);
  assert.match(correctedSelfIdentification.summary, /high regent/iu);
  assert.match(correctedSelfIdentification.summary, /protector, ruler, and general/iu);
  assert.match(correctedSelfIdentification.summary, /also known as Warden/iu);
  assert.doesNotMatch(correctedSelfIdentification.summary, /identifies themself[^.]*\bqueen\b/iu);
  assert.equal(
    correctedSelfIdentification.history.some((entry) => /identifies themself[^.]*\bqueen\b/iu.test(entry)),
    false,
  );
  assert.equal(
    correctedSelfIdentification.history.filter((entry) => /identifies themself as Kaelor Venn/iu.test(entry)).length,
    1,
    JSON.stringify(correctedSelfIdentification.history),
  );

  const symbioticEvidence = {
    chunkId: "saved-symbiotic-bond",
    sourceId: "book",
    quote: "The transformed form was proof of the symbiotic bond I shared with Nyx.",
    sectionTitle: "Chapter Seven (Calder - Present)",
  };
  const sharedMindEvidence = {
    chunkId: "saved-shared-mind-host-pov",
    sourceId: "book",
    quote: "Nyx called out within my mind. Nyx was an alien symbiont, and I was Nyx's human host.",
    sectionTitle: "Chapter Eight (Calder - Present)",
  };
  const sharedFormEvidence = {
    chunkId: "saved-shared-form-host-pov",
    sourceId: "book",
    quote: "I opened my mind to Nyx and our transformation began. Together, Nyx and I became a nine-foot, six-eyed nonhuman form with immense strength and new senses.",
    sectionTitle: "Chapter Nine (Calder - Present)",
  };
  const savedSymbiont: CharacterFinding = {
    ...character,
    name: "Nyx",
    aliases: [],
    role: "Symbiotic Companion",
    summary: "Nyx shares a living symbiotic bond with Calder Vale.",
    traits: [],
    capabilities: [],
    history: [],
    origins: [],
    powers: [],
    physicalCharacteristics: [],
    relationships: ["Calder Vale: Symbiotic Bond"],
    relationshipWeb: [{
      name: "Calder Vale",
      relationship: "Symbiotic Bond",
      summary: "Nyx and Calder Vale share a symbiotic bond.",
      sentiment: "allied",
      evidence: [symbioticEvidence],
    }],
    evidence: [symbioticEvidence, sharedMindEvidence, sharedFormEvidence],
  };
  const savedHost: CharacterFinding = {
    ...character,
    name: "Calder Vale",
    aliases: ["Calder"],
    role: "Point-of-View Character",
    summary: "Calder Vale protects the people who depend on him.",
    relationships: ["Nyx: Symbiotic Bond"],
    relationshipWeb: [{
      name: "Nyx",
      relationship: "Symbiotic Bond",
      summary: "Calder Vale and Nyx share a symbiotic bond.",
      sentiment: "allied",
      evidence: [symbioticEvidence],
    }],
    evidence: [symbioticEvidence, sharedMindEvidence, sharedFormEvidence],
  };
  const savedSymbiontFindings = enrichLocalDossierProjection({
    findings: { ...findings, characters: [savedSymbiont, savedHost] },
    signals: [],
    chunks: [{
      id: symbioticEvidence.chunkId,
      sourceId: symbioticEvidence.sourceId,
      sourceTitle: "Volume One",
      index: 70,
      sectionTitle: symbioticEvidence.sectionTitle,
      content: symbioticEvidence.quote,
    }, {
      id: "saved-shared-mind-host-pov",
      sourceId: "book",
      sourceTitle: "Volume One",
      index: 80,
      sectionTitle: "Chapter Eight (Calder - Present)",
      content: sharedMindEvidence.quote,
    }, {
      id: "saved-shared-form-host-pov",
      sourceId: "book",
      sourceTitle: "Volume One",
      index: 90,
      sectionTitle: "Chapter Nine (Calder - Present)",
      content: sharedFormEvidence.quote,
    }],
    rebuildConnections: true,
  });
  const savedSymbiontProjection = savedSymbiontFindings.characters.find((entry) => entry.name === "Nyx")!;
  assert.match(savedSymbiontProjection.summary, /Nyx is an alien symbiont living within Calder Vale's mind/iu);
  assert.doesNotMatch(savedSymbiontProjection.summary, /^Nyx shares a living symbiotic bond with Calder Vale\.$/iu);
  assert.ok(savedSymbiontProjection.powers.some((power) =>
    /Nyx and Calder Vale can transform together into a nine-foot, six-eyed nonhuman form/iu.test(power)
  ), JSON.stringify(savedSymbiontProjection.powers));
  const savedHostProjection = savedSymbiontFindings.characters.find((entry) => entry.name === "Calder Vale")!;
  assert.ok(savedHostProjection.powers.some((power) =>
    /Calder Vale and Nyx can transform together into a nine-foot, six-eyed nonhuman form/iu.test(power)
  ), JSON.stringify({
    powers: savedHostProjection.powers,
    physicalCharacteristics: savedHostProjection.physicalCharacteristics,
    evidence: savedHostProjection.evidence,
  }));
  const persistedSymbioticPair = generatedLocalFindingsForPersistence(savedSymbiontFindings);
  for (const member of persistedSymbioticPair.characters) {
    assert.match(member.summary, /living within Calder Vale's mind/iu);
    assert.match(member.summary, /transform together into a nine-foot, six-eyed nonhuman form/iu);
    assert.ok(member.powers.some((power) =>
      /transform together into a nine-foot, six-eyed nonhuman form/iu.test(power)
    ), `${member.name}: ${JSON.stringify(member.powers)}`);
  }

  const persistedShapeCharacter: CharacterFinding = {
    ...character,
    name: "Mara Vale",
    summary: "Mara Vale is a veteran rescue pilot committed to protecting displaced families. Mara Vale hung up, the weight of responsibility pressing down on her like a physical force. Mara Vale's voice was measured but determined as she spoke.",
    traits: [
      "Mara Vale is patient and resourceful under pressure.",
      "Mara Vale's voice was measured but determined as she spoke.",
    ],
    motivations: [
      "Mara Vale vowed to protect the settlement's children.",
      "Mara Vale hung up, the weight of responsibility pressing down on her like a physical force.",
      "Mara Vale lunged forward, determined to claim the prize.",
      "Mara Vale is processing her grief after the funeral.",
      "Mara Vale wanted to scream and rage.",
      "Mara Vale just needed to fuck someone, anyone.",
      "Mara Vale seeks a lasting romantic relationship with Nera.",
    ],
    history: [
      "Mara Vale survived the station collapse and returned home.",
      "Mara Vale wrapped her companion in an embrace.",
      "Mara Vale's expression changed from anger to genuine concern.",
      "Mara Vale nearly choked on the word survived.",
      "Mara Vale hesitated, torn, then fled toward the ruins.",
      "Mara Vale barely escaped with their life.",
      "Mara Vale frowned and returned to their seat.",
      "Mara Vale spoke of how we mourned his loss.",
    ],
    secrets: [
      "Mara Vale takes deliberate care not to reveal their true nature.",
      "Mara Vale secretly conceals her membership in the forbidden order.",
    ],
  };
  const persistenceReady = generatedLocalFindingsForPersistence({
    ...findings,
    characters: [persistedShapeCharacter],
  }).characters[0]!;
  const persistedProfileText = JSON.stringify({
    summary: persistenceReady.summary,
    traits: persistenceReady.traits,
    motivations: persistenceReady.motivations,
    history: persistenceReady.history,
    secrets: persistenceReady.secrets,
  });
  assert.match(persistenceReady.summary, /veteran rescue pilot/iu);
  assert.ok(persistenceReady.motivations.some((entry) => /vowed to protect/iu.test(entry)));
  assert.ok(persistenceReady.motivations.some((entry) => /lasting romantic relationship/iu.test(entry)));
  assert.ok(persistenceReady.history.some((entry) => /survived the station collapse/iu.test(entry)));
  assert.ok(persistenceReady.secrets.some((entry) => /membership in the forbidden order/iu.test(entry)));
  assert.doesNotMatch(
    persistedProfileText,
    /hung up|weight of responsibility|voice was measured|lunged forward|processing her grief|wanted to scream|needed to fuck|wrapped her companion|expression changed|choked on the word|hesitated, torn|barely escaped|returned to their seat|spoke of how we mourned|takes deliberate care/iu,
  );

  const staleRelationshipCharacter: CharacterFinding = {
    ...character,
    name: "Nera",
    aliases: ["Neri"],
    summary: "Nera is identified as Valari, a manifested identity that can overlap with their ordinary body. Nera protects the archive.",
    capabilities: ["Nera's demonstrated abilities include those of the Valari form."],
    powers: ["Nera can manifest as Valari."],
    relationships: [
      "Valari: Manifests As",
      "Awakened: Symbiotic Bond",
      "Neri: Friend",
    ],
    relationshipWeb: [{
      name: "Valari",
      relationship: "Manifests As",
      summary: "Nera manifests as Valari.",
      sentiment: "unknown",
      evidence: [{ chunkId: "three", sourceId: "book", quote: "Nera is a Valari symbiont." }],
    }, {
      name: "Awakened",
      relationship: "Symbiotic Bond",
      summary: "Nera and the Awakened share a symbiotic bond.",
      sentiment: "allied",
      evidence: [{ chunkId: "three", sourceId: "book", quote: "Nera watched while the Awakened crossed the gate." }],
    }, {
      name: "Neri",
      relationship: "Friend",
      summary: "Nera is a friend of Neri.",
      sentiment: "allied",
      evidence: [{ chunkId: "three", sourceId: "book", quote: "Nera is also called Neri." }],
    }],
  };
  const relationshipProjection = enrichLocalDossierProjection({
    findings: {
      ...findings,
      characters: [staleRelationshipCharacter],
      species: [{
        name: "Valari",
        summary: "A named species.",
        evidence: [{ chunkId: "three", sourceId: "book", quote: "Nera is a Valari symbiont." }],
      }, {
        name: "Awakened",
        summary: "A named collective species.",
        evidence: [{ chunkId: "three", sourceId: "book", quote: "Nera watched while the Awakened crossed the gate." }],
      }],
      entityRelations: [{
        subject: "Nera",
        relationType: "has_form",
        target: "Valari",
        status: "active",
        summary: "Nera manifests as Valari.",
        validFromLabel: "",
        validUntilLabel: "",
        evidence: [{ chunkId: "three", sourceId: "book", quote: "Nera is a Valari symbiont." }],
        confidence: 0.94,
      }],
    },
    signals: [],
    chunks: [{
      id: "three",
      sourceId: "book",
      sourceTitle: "Volume One",
      index: 2,
      sectionTitle: "Chapter Two (Nera - Present)",
      content: "Nera is a Valari symbiont. Nera watched while the Awakened crossed the gate. Nera is also called Neri.",
    }],
    rebuildConnections: false,
  }).characters[0]!;
  assert.equal(
    relationshipProjection.relationshipWeb.find((entry) => entry.name === "Valari")?.relationship,
    "Member Of Species",
  );
  assert.equal(relationshipProjection.relationshipWeb.some((entry) => entry.name === "Awakened"), false);
  assert.equal(relationshipProjection.relationshipWeb.some((entry) => entry.name === "Neri"), false);
  assert.doesNotMatch(relationshipProjection.summary, /manifested (?:form|identity)/iu);
  assert.ok(relationshipProjection.powers.every((entry) => !/manifest as Valari/iu.test(entry)));

  // Reproduce the saved shape from a dossier-only replay: the breakdown still
  // calls the taxonomic concepts ambiguous, the current entity table has
  // already adjudicated them as species, and a previous synthesis omitted the
  // Valari structured row while retaining its stale prose.
  const savedReplayCharacter: CharacterFinding = {
    ...staleRelationshipCharacter,
    relationshipWeb: staleRelationshipCharacter.relationshipWeb.filter((entry) =>
      entry.name !== "Valari"
    ),
    relationships: staleRelationshipCharacter.relationships.filter((entry) =>
      !entry.startsWith("Valari:")
    ),
  };
  const savedBreakdownShape: WorldFindings = {
    ...findings,
    characters: [savedReplayCharacter, {
      ...character,
      name: "Valari",
      role: "Recurring Character",
    }, {
      ...character,
      name: "Awakened",
      role: "Character Under Review",
    }],
    ambiguous: [{
      name: "Valari",
      summary: "An unresolved concept in the old breakdown.",
      evidence: [{ chunkId: "three", sourceId: "book", quote: "Nera is a Valari symbiont." }],
    }, {
      name: "Awakened",
      summary: "An unresolved concept in the old breakdown.",
      evidence: [{ chunkId: "three", sourceId: "book", quote: "The Awakened crossed the gate." }],
    }],
    entityRelations: [{
      subject: "Nera",
      relationType: "has_form",
      target: "Valari",
      status: "active",
      summary: "Nera manifests as Valari.",
      validFromLabel: "",
      validUntilLabel: "",
      evidence: [{ chunkId: "three", sourceId: "book", quote: "Nera is a Valari symbiont." }],
      confidence: 0.94,
    }],
  };
  const replayFindings = restorePersistedLocalEntityCategories(savedBreakdownShape, [{
    name: "Valari",
    entity_type: "species",
    classification_source: "local",
    pull_status: "active",
    scanner_present: true,
    aliases: [],
    summary: "A named species.",
    evidence: [{ chunkId: "three", sourceId: "book", quote: "Nera is a Valari symbiont." }],
    confidence: 0.9,
    mention_count: 12,
    mention_source_count: 1,
    review_status: "candidate",
  }, {
    name: "Awakened",
    entity_type: "species",
    classification_source: "local",
    pull_status: "active",
    scanner_present: true,
    aliases: [],
    summary: "A named collective species.",
    evidence: [{ chunkId: "three", sourceId: "book", quote: "The Awakened crossed the gate." }],
    confidence: 0.9,
    mention_count: 9,
    mention_source_count: 1,
    review_status: "candidate",
  }]);
  const savedReplayProjection = enrichLocalDossierProjection({
    findings: replayFindings,
    signals: [],
    chunks: [{
      id: "three",
      sourceId: "book",
      sourceTitle: "Volume One",
      index: 2,
      sectionTitle: "Chapter Two (Nera - Present)",
      content: "Nera is a Valari symbiont. The Awakened crossed the gate. Nera is also called Neri.",
    }],
    rebuildConnections: false,
  }).characters.find((entry) => entry.name === "Nera")!;
  assert.deepEqual(replayFindings.species.map((entry) => entry.name).sort(), ["Awakened", "Valari"]);
  assert.equal(replayFindings.ambiguous.some((entry) => /^(?:Awakened|Valari)$/u.test(entry.name)), false);
  assert.equal(
    savedReplayProjection.relationshipWeb.find((entry) => entry.name === "Valari")?.relationship,
    "Member Of Species",
  );
  assert.equal(savedReplayProjection.relationshipWeb.some((entry) => entry.name === "Awakened"), false);
  assert.doesNotMatch(savedReplayProjection.summary, /manifested form/iu);
  assert.ok(savedReplayProjection.powers.every((entry) => !/manifest as Valari/iu.test(entry)));

  // Persisted replay ordering: re-adjudicate live generated rows first, then
  // restore the saved breakdown and remove scanner leads retired since that
  // breakdown. This must be correct on the first replay.
  const persistedRows: Record<string, unknown>[] = [{
    id: "martin-entity",
    name: "Martin",
    entity_type: "creature",
    classification_source: "local",
    review_status: "candidate",
    pull_status: "active",
    scanner_present: true,
    aliases: [],
    evidence: [{ chunkId: "m1", sourceId: "book", quote: 'Martin appeared beside the table and nodded. "Good to see you," he said.' }, {
      chunkId: "m2", sourceId: "book", quote: "Martin eagerly grabbed the tray and carried it away.",
    }],
  }, {
    id: "geela-entity",
    name: "Geela",
    entity_type: "creature",
    classification_source: "local",
    review_status: "candidate",
    pull_status: "active",
    scanner_present: true,
    aliases: [],
    evidence: [{ chunkId: "g1", sourceId: "book", quote: "Geela growled, her luminous crest flaring above four muscled arms." }],
  }, {
    id: "firelight-entity",
    name: "firelight",
    entity_type: "creature",
    classification_source: "local",
    review_status: "candidate",
    pull_status: "active",
    scanner_present: false,
    aliases: [],
    evidence: [{ chunkId: "f1", sourceId: "book", quote: 'Ragger swung toward her, his eyes glinting in the firelight. "No," he snapped.' }],
  }, {
    id: "screen-entity",
    name: "screen",
    entity_type: "creature",
    classification_source: "local",
    review_status: "candidate",
    pull_status: "merged",
    scanner_present: false,
    aliases: [],
    evidence: [],
  }];
  const adjudicated = adjudicatePersistedLocalEntityRows(persistedRows);
  assert.equal(adjudicated.rows.find((row) => row.name === "Martin")?.entity_type, "character");
  assert.equal(adjudicated.rows.find((row) => row.name === "Geela")?.entity_type, "creature");
  assert.deepEqual(
    adjudicated.updates.find((update) => update.id === "martin-entity"),
    {
      id: "martin-entity",
      entityType: "character",
      previousEntityType: "creature",
      summary: "Martin is presented as a character within the story. Its cited passages preserve the context needed to understand its role and meaning.",
      details: ["Character", "Grounded in the Manuscript"],
      dossierId: "",
      activateDossier: false,
    },
  );
  assert.equal(persistedLocalEntityIsConnectionEligible(persistedRows[0]!), true);
  assert.equal(persistedLocalEntityIsConnectionEligible(persistedRows[2]!), false);
  const persistedReplayShape: WorldFindings = {
    ...savedBreakdownShape,
    characters: [{
      ...savedReplayCharacter,
      name: "Michael",
      relationships: ["Martin: Friend", "firelight: Creature Connection", "screen: Creature Connection"],
      relationshipWeb: [{
        name: "Martin", relationship: "Friend", summary: "Martin spoke with Michael.", sentiment: "allied", evidence: [],
      }, {
        name: "firelight", relationship: "Creature Connection", summary: "A stale lead.", sentiment: "unknown", evidence: [],
      }, {
        name: "screen", relationship: "Creature Connection", summary: "A stale lead.", sentiment: "unknown", evidence: [],
      }],
    }],
    creatures: ["Martin", "Geela", "firelight", "screen"].map((name) => ({
      name, summary: "Saved creature proposal.", evidence: [],
    })),
  };
  const restoredReplay = removeRetiredLocalEntityRelationships(
    restorePersistedLocalEntityCategories(persistedReplayShape, adjudicated.rows),
    adjudicated.rows,
  );
  assert.deepEqual(restoredReplay.creatures.map((entry) => entry.name), ["Geela"]);
  assert.deepEqual(restoredReplay.characters[0]?.relationships, ["Martin: Friend"]);
  assert.deepEqual(restoredReplay.characters[0]?.relationshipWeb.map((entry) => entry.name), ["Martin"]);

  const scarProjection = generatedLocalFindingsForPersistence({
    ...findings,
    characters: [{
      ...character,
      name: "Orin",
      summary: "Orin is a veteran scout.",
      history: ["Orin thrust out a hand, the skin mottled with scars - jagged reminders of battles fought and survived."],
      physicalCharacteristics: [],
      relationships: [],
      relationshipWeb: [],
    }],
  }).characters[0]!;
  assert.equal(scarProjection.history.some((entry) => /thrust out a hand/iu.test(entry)), false);
  assert.ok(scarProjection.physicalCharacteristics.some((entry) =>
    /skin mottled with scars.+battles fought and survived/iu.test(entry)
  ), JSON.stringify(scarProjection.physicalCharacteristics));
  const otherPersonsScars = generatedLocalFindingsForPersistence({
    ...findings,
    characters: [{
      ...character,
      name: "Martin Hale",
      summary: "Martin Hale is a veteran scout.",
      history: ["Martin Hale looked at Ada; Ada's skin was mottled with scars from old battles."],
      physicalCharacteristics: [],
      relationships: [],
      relationshipWeb: [],
    }],
  }).characters[0]!;
  assert.equal(
    otherPersonsScars.physicalCharacteristics.some((entry) => /scar/iu.test(entry)),
    false,
  );
  const falseTransformation = generatedLocalFindingsForPersistence({
    ...findings,
    characters: [{
      ...character,
      name: "Mara Quill",
      summary: "Mara Quill is an observant field medic.",
      capabilities: ["Mara Quill can transform into a powerful nonhuman form."],
      powers: [],
      physicalCharacteristics: ["Mara Quill's transformed body is nine feet tall."],
      relationships: [],
      relationshipWeb: [],
      evidence: [{
        chunkId: "wrong-transformation-subject",
        sourceId: "book",
        quote: "Mara Quill watched Oren transform into a towering nonhuman form.",
      }],
    }],
  }).characters[0]!;
  assert.equal(falseTransformation.powers.some((entry) => /transform/iu.test(entry)), false);
  assert.equal(falseTransformation.capabilities.some((entry) => /transform/iu.test(entry)), false);
  assert.doesNotMatch(falseTransformation.summary, /Mara Quill can transform/iu);

  const relationshipEvidence = (quote: string) => [{ chunkId: "global", sourceId: "book", quote }];
  const generatedProfile = (
    name: string,
    overrides: Partial<CharacterFinding> = {},
  ): CharacterFinding => ({
    ...character,
    name,
    aliases: [],
    summary: `${name} appears in the story.`,
    traits: [], motivations: [], fears: [], capabilities: [], history: [], origins: [], powers: [],
    moralSystem: [], physicalCharacteristics: [], relationships: [], relationshipWeb: [],
    knowledge: [], secrets: [], factionMemberships: [], evidence: [],
    ...overrides,
  });
  const leader = generatedProfile("Commander Hale");
  const repairedPerson = generatedProfile("David North");
  const echoUnit = generatedProfile("Echo Unit");
  const falseLead = generatedProfile("Whiskey Angel", {
    summary: "Whiskey Angel leads Commander Hale.",
    relationships: ["Commander Hale: Leads"],
    relationshipWeb: [{
      name: "Commander Hale",
      relationship: "Leads",
      summary: "Whiskey Angel leads Commander Hale.",
      sentiment: "professional",
      evidence: relationshipEvidence('"Good morning, Commander Hale," Whiskey Angel said.'),
    }],
  });
  const falseSpeciesBond = generatedProfile("The Changed", {
    summary: "The Changed and Echo Unit share a symbiotic bond.",
    relationships: ["Echo Unit: Symbiotic Bond"],
    relationshipWeb: [{
      name: "Echo Unit",
      relationship: "Symbiotic Bond",
      summary: "The Changed and Echo Unit share a symbiotic bond.",
      sentiment: "allied",
      evidence: relationshipEvidence("Echo Unit watched as the Changed crossed the gate."),
    }],
  });
  const staleSpeciesEdge = generatedProfile("Archivist", {
    relationships: [
      "Awakened: Recurring Connection",
      "Banshee: Creature Connection",
      "David North: Associated Location",
    ],
    relationshipWeb: [{
      name: "Awakened",
      relationship: "Recurring Connection",
      summary: "Awakened recurs near Archivist.",
      sentiment: "unknown",
      evidence: relationshipEvidence("Archivist watched while the Awakened crossed the gate."),
    }, {
      name: "Banshee",
      relationship: "Creature Connection",
      summary: "A Banshee recurs near Archivist.",
      sentiment: "unknown",
      evidence: relationshipEvidence("Archivist entered the room while a Banshee slept in the far corner."),
    }, {
      name: "David North",
      relationship: "Associated Location",
      summary: "David North recurs near Archivist.",
      sentiment: "unknown",
      evidence: relationshipEvidence("Archivist spoke to David North in the archive."),
    }],
  });
  const groundedCreatureEdge = generatedProfile("Hunter Vale", {
    relationships: ["Banshee: Creature Connection"],
    relationshipWeb: [{
      name: "Banshee",
      relationship: "Creature Connection",
      summary: "Hunter Vale fought a Banshee.",
      sentiment: "hostile",
      evidence: relationshipEvidence("Hunter Vale fought the Banshee through the ruined station."),
    }],
  });
  const falseTransformer = generatedProfile("Mara Quill", {
    summary: "Mara Quill can transform into a powerful nonhuman form.",
    capabilities: ["Mara Quill can transform into a powerful nonhuman form."],
    powers: ["Mara Quill can transform into a powerful nonhuman form."],
    physicalCharacteristics: ["Mara Quill's transformed body is nine feet tall."],
    evidence: relationshipEvidence("Mara Quill watched Oren transform into a towering nonhuman form."),
  });
  const orphanLead = generatedProfile("Lone Scout", {
    summary: "Lone Scout leads Retired Commander.",
    relationships: ["Retired Commander: Leads"],
    relationshipWeb: [{
      name: "Retired Commander",
      relationship: "Leads",
      summary: "Lone Scout leads Retired Commander.",
      sentiment: "professional",
      evidence: relationshipEvidence('"Good morning, Retired Commander," Lone Scout said.'),
    }],
  });
  const orphanBond = generatedProfile("Dormant Form", {
    summary: "Dormant Form and Ghost Unit share a symbiotic bond.",
    relationships: ["Ghost Unit: Symbiotic Bond"],
    relationshipWeb: [{
      name: "Ghost Unit",
      relationship: "Symbiotic Bond",
      summary: "Dormant Form and Ghost Unit share a symbiotic bond.",
      sentiment: "allied",
      evidence: relationshipEvidence("Dormant Form lay beside the inactive Ghost Unit."),
    }],
  });

  // Persisted V5 shape: local synthesis already understood the identity reveal
  // and grounded the derived Strength score, but an older projection had no
  // durable form edge and therefore lost both the power and reciprocal web.
  const thrallRevealEvidence = [{
    chunkId: "af8906f8-525c-4f7a-bd40-aa35592b82e9",
    sourceId: "embers",
    quote: "Beneath the surface, I could see the same constellation-like patterns that adorned my own changed flesh, pulsing in time with his heartbeat. It was as if he was partially stuck between being himself, and being the Thrall, caught in an eternal limbo. \"Michael, I...\" My words faltered as I shifted on the metal floor of the cell.",
  }];
  const michael = generatedProfile("Michael", {
    summary: "Michael is identified as the Thrall, a transformed identity whose changed body carries immense strength.",
    capabilities: ["Michael's Thrall form possesses immense physical strength."],
    powers: [],
    evidence: thrallRevealEvidence,
    estimatedStats: {
      ...character.estimatedStats,
      strength: {
        score: 17,
        confidence: 0.91,
        rationale: "Michael's changed Thrall body demonstrates immense physical strength.",
        evidence: thrallRevealEvidence,
      },
    },
  });
  const thrallFinding: NamedFinding = {
    name: "Thrall",
    aliases: [],
    summary: "The Thrall is a manifested nonhuman body.",
    evidence: thrallRevealEvidence,
    confidence: 0.93,
  };
  const thrallProfile = generatedProfile("Thrall", {
    role: "Creature",
    summary: thrallFinding.summary,
    evidence: thrallRevealEvidence,
  });
  const persistedThrallGraph = generatedLocalFindingsForPersistence({
    ...findings,
    characters: [michael],
    creatures: [thrallFinding],
  });
  const persistedMichael = persistedThrallGraph.characters[0]!;
  assert.ok(persistedThrallGraph.entityRelations.some((relation) =>
    relation.subject === "Michael" &&
    relation.relationType === "has_form" &&
    relation.target === "Thrall" &&
    relation.evidence.some((evidence) => evidence.chunkId === thrallRevealEvidence[0]!.chunkId)
  ), JSON.stringify(persistedThrallGraph.entityRelations));
  assert.equal(
    persistedMichael.relationshipWeb.find((entry) => entry.name === "Thrall")?.relationship,
    "Manifests As",
  );
  assert.ok(
    persistedMichael.powers.some((power) => /^Michael can manifest as Thrall\.$/u.test(power)),
    JSON.stringify(persistedMichael.powers),
  );
  assert.equal(persistedMichael.estimatedStats.strength.score, 17);

  const replayedThrallProfiles = revalidateGeneratedLocalDossierProfiles({
    findings: {
      ...findings,
      characters: [michael],
      creatures: [thrallFinding],
      entityRelations: [],
    },
    profiles: [
      { linkedEntityType: "character", finding: michael },
      { linkedEntityType: "creature", finding: thrallProfile },
    ],
  });
  const replayedMichael = replayedThrallProfiles.find((entry) => entry.name === "Michael")!;
  const replayedThrall = replayedThrallProfiles.find((entry) => entry.name === "Thrall")!;
  assert.equal(
    replayedMichael.relationshipWeb.find((entry) => entry.name === "Thrall")?.relationship,
    "Manifests As",
  );
  assert.equal(
    replayedThrall.relationshipWeb.find((entry) => entry.name === "Michael")?.relationship,
    "Manifested By",
  );
  assert.ok(replayedMichael.powers.some((power) => /manifest as Thrall/iu.test(power)));

  // The canonical creature has already absorbed its retired plural scanner
  // lead. Customer prose and graph labels must follow that canonical identity.
  const prowlerFormEvidence = [{
    chunkId: "eff34862-86fe-4cc0-aea3-a70367e25df8",
    sourceId: "embers",
    quote: "Ragger looked at me. \"Kendall, it is time for you to leave.\" As he spoke, I noticed his legs swelling and his tail stretching. His jaw split wider and he began to take on the familiar form of the Prowlers I had encountered. Ragger twisted and stretched, towering above me.",
  }];
  const ragger = generatedProfile("Ragger", {
    summary: "Ragger can take on the familiar form of the Prowlers.",
    capabilities: ["Ragger can assume the form of the Prowlers."],
    powers: ["Ragger can manifest as the Prowlers."],
    evidence: prowlerFormEvidence,
  });
  assert.equal(relationHasDirectPredicateSupport({
    subject: "Ragger",
    target: "Prowler",
    relationType: "has_form",
    quote: prowlerFormEvidence[0]!.quote,
  }), true);
  const persistedProwlerGraph = generatedLocalFindingsForPersistence({
    ...findings,
    characters: [ragger],
    creatures: [{
      name: "Prowler",
      aliases: ["Prowlers"],
      summary: "A dangerous transformed body.",
      evidence: prowlerFormEvidence,
      confidence: 0.94,
    }],
    entityRelations: [{
      subject: "Ragger",
      relationType: "has_form",
      target: "Prowlers",
      status: "active",
      summary: "Ragger manifests as Prowlers.",
      validFromLabel: "",
      validUntilLabel: "",
      evidence: prowlerFormEvidence,
      confidence: 0.94,
    }],
  });
  const persistedRagger = persistedProwlerGraph.characters[0]!;
  assert.equal(persistedProwlerGraph.entityRelations.some((relation) =>
    relation.relationType === "has_form" && relation.target === "Prowlers"
  ), false);
  assert.equal(persistedProwlerGraph.entityRelations.some((relation) =>
    relation.subject === "Ragger" &&
    relation.relationType === "has_form" &&
    relation.target === "Prowler" &&
    relation.summary === "Ragger manifests as Prowler."
  ), true);
  assert.equal(
    persistedRagger.relationshipWeb.find((entry) => entry.name === "Prowler")?.relationship,
    "Manifests As",
  );
  assert.ok(
    persistedRagger.powers.some((power) => /manifest as Prowler/iu.test(power)),
    JSON.stringify(persistedRagger.powers),
  );
  assert.doesNotMatch(JSON.stringify({
    summary: persistedRagger.summary,
    capabilities: persistedRagger.capabilities,
    powers: persistedRagger.powers,
    relationshipWeb: persistedRagger.relationshipWeb.map((relationship) => ({
      name: relationship.name,
      relationship: relationship.relationship,
      summary: relationship.summary,
    })),
  }), /Prowlers/iu);

  // A named observer and a named form in the same sentence are still not an
  // identity edge when the grammar assigns the transformation to somebody
  // else.
  const observer = generatedProfile("Mara Quill", {
    summary: "Mara Quill is an observant field medic.",
    evidence: relationshipEvidence("Mara Quill watched Oren transform into the Wolf before her eyes."),
  });
  const observerProjection = generatedLocalFindingsForPersistence({
    ...findings,
    characters: [observer],
    creatures: [{
      name: "Wolf",
      summary: "A manifested creature form.",
      evidence: observer.evidence,
    }],
  });
  assert.equal(observerProjection.entityRelations.some((relation) =>
    relation.subject === "Mara Quill" && relation.relationType === "has_form"
  ), false);
  assert.equal(observerProjection.characters[0]?.relationshipWeb.some((entry) =>
    entry.relationship === "Manifests As"
  ), false);
  assert.equal(observerProjection.characters[0]?.powers.some((power) => /Wolf/iu.test(power)), false);

  const graphNormalizationEvents: Array<{
    phase: string;
    profileCount: number;
    contextCharacterCount: number;
  }> = [];
  const globallyCleaned = revalidateGeneratedLocalDossierProfiles({
    findings: {
      ...findings,
      characters: [
        leader, repairedPerson, echoUnit, falseLead, staleSpeciesEdge,
        groundedCreatureEdge, falseTransformer,
      ],
      locations: findings.locations.filter((entry) => entry.name !== "David North"),
      species: [{
        name: "The Changed",
        summary: "A changed population.",
        evidence: falseSpeciesBond.evidence,
      }, {
        name: "Awakened",
        summary: "A named species.",
        evidence: relationshipEvidence("The Awakened crossed the gate."),
      }],
      creatures: [{
        name: "Banshee",
        summary: "A dangerous creature.",
        evidence: relationshipEvidence("A Banshee stalked the station."),
      }],
    },
    profiles: [
      { linkedEntityType: "character", finding: leader },
      { linkedEntityType: "character", finding: repairedPerson },
      { linkedEntityType: "character", finding: falseLead },
      { linkedEntityType: "species", finding: falseSpeciesBond },
      { linkedEntityType: "character", finding: staleSpeciesEdge },
      { linkedEntityType: "character", finding: groundedCreatureEdge },
      { linkedEntityType: "character", finding: falseTransformer },
      { linkedEntityType: "character", finding: orphanLead },
      { linkedEntityType: "species", finding: orphanBond },
    ],
    onGraphNormalization: (event) => graphNormalizationEvents.push(event),
  });
  assert.deepEqual(graphNormalizationEvents, [{
    phase: "character_graph",
    profileCount: 7,
    contextCharacterCount: 1,
  }], "generated profiles share one normalized character graph regardless of profile count");
  const cleanedLead = globallyCleaned.find((entry) => entry.name === "Whiskey Angel")!;
  const cleanedSpecies = globallyCleaned.find((entry) => entry.name === "The Changed")!;
  const cleanedArchivist = globallyCleaned.find((entry) => entry.name === "Archivist")!;
  const cleanedHunter = globallyCleaned.find((entry) => entry.name === "Hunter Vale")!;
  const cleanedTransformer = globallyCleaned.find((entry) => entry.name === "Mara Quill")!;
  const cleanedOrphanLead = globallyCleaned.find((entry) => entry.name === "Lone Scout")!;
  const cleanedOrphanBond = globallyCleaned.find((entry) => entry.name === "Dormant Form")!;
  assert.equal(cleanedLead.relationshipWeb.some((entry) => entry.relationship === "Leads"), false);
  assert.equal(cleanedLead.relationships.some((entry) => /:\s*Leads$/iu.test(entry)), false);
  assert.doesNotMatch(cleanedLead.summary, /leads?\s+Commander Hale/iu);
  assert.equal(cleanedSpecies.relationshipWeb.some((entry) => entry.name === "Echo Unit"), false);
  assert.equal(cleanedSpecies.relationships.some((entry) => /^Echo Unit:/iu.test(entry)), false);
  assert.doesNotMatch(cleanedSpecies.summary, /symbiotic\s+bond/iu);
  assert.equal(cleanedSpecies.summary, "A changed population.");
  assert.equal(cleanedSpecies.role, "Species");
  assert.equal(cleanedArchivist.relationshipWeb.some((entry) => entry.name === "Awakened"), false);
  assert.equal(cleanedArchivist.relationshipWeb.some((entry) => entry.name === "Banshee"), false);
  assert.equal(
    cleanedHunter.relationshipWeb.find((entry) => entry.name === "Banshee")?.relationship,
    "Creature Connection",
  );
  assert.equal(cleanedArchivist.relationshipWeb.some((entry) => entry.name === "David North"), false);
  assert.equal(cleanedTransformer.capabilities.some((entry) => /transform/iu.test(entry)), false);
  assert.equal(cleanedTransformer.powers.some((entry) => /transform/iu.test(entry)), false);
  assert.equal(cleanedTransformer.physicalCharacteristics.some((entry) => /transform/iu.test(entry)), false);
  assert.doesNotMatch(cleanedTransformer.summary, /transform/iu);
  assert.equal(cleanedOrphanLead.relationshipWeb.length, 0);
  assert.doesNotMatch(cleanedOrphanLead.summary, /leads?\s+Retired Commander/iu);
  assert.equal(cleanedOrphanBond.relationshipWeb.length, 0);
  assert.doesNotMatch(cleanedOrphanBond.summary, /symbiotic\s+bond/iu);
  assert.equal(cleanedOrphanBond.role, "Species");
});

test("global profile revalidation indexes a 200-profile mixed world without unrelated edge scans", () => {
  const unsetStat = () => ({
    score: 10,
    confidence: 0.1,
    rationale: "Not established.",
    evidence: [],
  });
  const profile = (
    name: string,
    overrides: Partial<CharacterFinding> = {},
  ): CharacterFinding => ({
    name,
    aliases: [],
    role: "Place",
    summary: `${name} is a documented archive.`,
    traits: [], motivations: [], fears: [], capabilities: [], history: [], origins: [],
    powers: [], moralSystem: [], physicalCharacteristics: [], relationships: [], relationshipWeb: [],
    estimatedStats: {
      strength: unsetStat(), dexterity: unsetStat(), constitution: unsetStat(),
      intelligence: unsetStat(), wisdom: unsetStat(), charisma: unsetStat(), acrobatics: unsetStat(),
    },
    socioPoliticalAxis: {
      economic: 0,
      authority: 0,
      label: "Undetermined",
      rationale: "Insufficient evidence.",
      confidence: 0.1,
    },
    knowledge: [], secrets: [], factionMemberships: [], evidence: [], confidence: 0.8,
    ...overrides,
  });
  const keeperEvidence = [{
    chunkId: "archive-keeper-link",
    sourceId: "book",
    quote: "Archive 0 and Keeper 0 are trusted friends.",
  }];
  const keepers = Array.from({ length: 77 }, (_, index) => profile(`Keeper ${index}`, {
    role: "Supporting Character",
    summary: `Keeper ${index} protects part of the archive collection.`,
    evidence: index === 0 ? keeperEvidence : [],
  }));
  const thrallEvidence = [{
    chunkId: "michael-thrall-form",
    sourceId: "book",
    quote: "Michael transformed into the Thrall.",
  }];
  const michael = profile("Michael", {
    role: "Supporting Character",
    summary: "Michael survives a forced transformation.",
    evidence: thrallEvidence,
  });
  const thrall = profile("Thrall", {
    role: "Creature",
    summary: "The Thrall is Michael's manifested nonhuman body.",
    evidence: thrallEvidence,
  });
  const archiveProfiles = Array.from({ length: 198 }, (_, index) => profile(`Archive ${index}`,
    index === 0
      ? {
          relationships: ["Keeper 0: Friend"],
          relationshipWeb: [{
            name: "Keeper 0",
            relationship: "Friend",
            summary: "Archive 0 and Keeper 0 are trusted friends.",
            sentiment: "allied",
            evidence: keeperEvidence,
          }],
          evidence: keeperEvidence,
        }
      : {},
  ));
  const profileRows = [
    { linkedEntityType: "character", finding: michael },
    ...archiveProfiles.map((finding) => ({ linkedEntityType: "place", finding })),
    { linkedEntityType: "creature", finding: thrall },
  ];
  const profiles = profileRows.map((row) => row.finding);
  const locations: NamedFinding[] = archiveProfiles.map((entry) => ({
    name: entry.name,
    aliases: [],
    summary: entry.summary,
    evidence: entry.evidence,
    confidence: entry.confidence,
  }));
  const findings: WorldFindings = {
    summary: "",
    genres: [], atmosphere: [], themes: [], worldRules: [], locations,
    factions: [], institutions: [], governments: [], powerStructures: [],
    creatures: [{
      name: "Thrall",
      aliases: [],
      summary: "The Thrall is Michael's manifested nonhuman body.",
      evidence: thrallEvidence,
      confidence: 0.95,
    }, ...Array.from({ length: 100 }, (_, index) => ({
      name: `Form ${index}`,
      aliases: [],
      summary: `Form ${index} is an unrelated manifested body.`,
      evidence: [{
        chunkId: `unrelated-form-${index}`,
        sourceId: "book",
        quote: `Keeper ${index % keepers.length} transformed into Form ${index}.`,
      }],
      confidence: 0.85,
    }))],
    species: Array.from({ length: 100 }, (_, index) => ({
      name: `Species ${index}`,
      aliases: [],
      summary: `Species ${index} is an unrelated species.`,
      evidence: [{
        chunkId: `unrelated-species-${index}`,
        sourceId: "book",
        quote: `Keeper ${index % keepers.length} is a Species ${index}.`,
      }],
      confidence: 0.85,
    })), technologies: [], vehicles: [], devices: [], weapons: [],
    powers: [], titles: [], ambiguous: [], chapterSummaries: [], chronology: [], openQuestions: [],
    recurringTerms: [], characters: [], entityRelations: [{
      subject: "Michael",
      relationType: "has_form" as const,
      target: "Thrall",
      status: "active" as const,
      summary: "Michael manifests as Thrall.",
      validFromLabel: "",
      validUntilLabel: "",
      evidence: thrallEvidence,
      confidence: 0.95,
    }, ...Array.from({ length: 100 }, (_, index) => ({
        subject: `Keeper ${index % keepers.length}`,
        relationType: "has_form" as const,
        target: `Form ${index}`,
        status: "active" as const,
        summary: `Keeper ${index % keepers.length} manifests as Form ${index}.`,
        validFromLabel: "",
        validUntilLabel: "",
        evidence: [{
          chunkId: `unrelated-form-${index}`,
          sourceId: "book",
          quote: `Keeper ${index % keepers.length} transformed into Form ${index}.`,
        }],
        confidence: 0.9,
      })), ...Array.from({ length: 100 }, (_, index) => ({
        subject: `Keeper ${index % keepers.length}`,
        relationType: "species_of" as const,
        target: `Species ${index}`,
        status: "active" as const,
        summary: `Keeper ${index % keepers.length} is a member of Species ${index}.`,
        validFromLabel: "",
        validUntilLabel: "",
        evidence: [{
          chunkId: `unrelated-species-${index}`,
          sourceId: "book",
          quote: `Keeper ${index % keepers.length} is a Species ${index}.`,
        }],
        confidence: 0.9,
      }))], entityRules: [], cohesionProposals: [],
  };
  const graphEvents: Array<{
    phase: string;
    profileCount: number;
    contextCharacterCount: number;
  }> = [];
  const preparationEvents: Array<{
    profileCount: number;
    candidateCount: number;
    storedRelationCount: number;
    acceptedRelationCount: number;
  }> = [];
  const accessEvents: Array<{
    profileCount: number;
    candidateCount: number;
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
  }> = [];

  const revalidated = revalidateGeneratedLocalDossierProfiles({
    findings,
    profiles: profileRows,
    connectionCharacters: keepers,
    onGraphNormalization: (event) => graphEvents.push(event),
    onProfileProjectionPrepared: (event) => preparationEvents.push(event),
    onProfileProjectionAccess: (event) => accessEvents.push(event),
  });

  assert.deepEqual(graphEvents, [{
    phase: "character_graph",
    profileCount: 1,
    contextCharacterCount: 77,
  }]);
  assert.deepEqual(preparationEvents, [{
    profileCount: 199,
    candidateCount: 477,
    storedRelationCount: 201,
    acceptedRelationCount: 0,
  }], "candidate and relation indexes must be prepared once for the complete profile set");
  assert.equal(accessEvents.length, 1, "shared index access is reported once after the complete projection");
  const access = accessEvents[0]!;
  assert.equal(access.profileCount, 199);
  assert.equal(access.candidateCount, 477);
  assert.equal(access.storedRelationCount, 201);
  assert.equal(access.taxonomyIndexBuilds, 1);
  assert.equal(access.taxonomyFindingRowsIndexed, 399);
  assert.equal(access.taxonomyExactTypeLookups, 200);
  assert.equal(access.taxonomyExactBucketRowsExamined, 199);
  assert.equal(access.taxonomySurfaceTypeLookups, 200);
  assert.equal(access.taxonomySurfaceBucketRowsExamined, 199);
  assert.equal(access.taxonomyMaxSurfaceBucketSize, 1);
  assert.equal(access.taxonomyFallbackFindingLookups, 199);
  assert.equal(access.taxonomyFallbackBucketRowsExamined, 199);
  assert.equal(access.taxonomyFullFindingScans, 0);
  assert.equal(access.fullCandidateScans, 0, "normal profiles must never fall back to a full candidate scan");
  assert.ok(
    access.candidateBucketRowsExamined < profiles.length * 8,
    `candidate buckets must remain proportional to addressed profile surfaces: ${JSON.stringify(access)}`,
  );
  assert.ok(access.maxCandidateBucketSize <= 2, JSON.stringify(access));
  assert.ok(
    access.storedRelationRowsExamined <= 3,
    `199 non-character profiles must examine only the incident Michael/Thrall edge: ${JSON.stringify(access)}`,
  );
  assert.equal(access.speciesCandidateChecks, 0);
  assert.equal(access.formCandidateChecks, 1);
  assert.ok(access.symbioticCandidateChecks <= 3, JSON.stringify(access));
  assert.equal(access.promotionCandidateIndexBuilds, 1);
  assert.equal(access.promotionFullCandidateScans, 0);
  assert.equal(access.promotionFormCandidateChecks, 1);
  assert.ok(
    access.promotionCandidateBucketRowsExamined <= findings.entityRelations.length + 8,
    `promotion may canonicalize each stored form endpoint once, but must not cross-product relations and candidates: ${JSON.stringify(access)}`,
  );
  assert.equal(access.acceptedCandidateIndexBuilds, 0);
  assert.equal(access.acceptedFullCandidateScans, 0);
  assert.equal(access.characterProjectionProfileCount, 1);
  assert.equal(access.characterProjectionStoredRelationCount, 201);
  assert.equal(access.characterProjectionFullCandidateScans, 0);
  assert.equal(access.characterProjectionFormCandidateChecks, 1);
  assert.ok(
    access.characterProjectionCandidateBucketRowsExamined < 32,
    `real-character projection must stay on Michael/Thrall buckets: ${JSON.stringify(access)}`,
  );
  assert.ok(
    access.characterProjectionStoredRelationRowsExamined <= 3,
    `real-character normalization must inspect only Michael's incident edge: ${JSON.stringify(access)}`,
  );
  assert.ok(
    access.candidateSurfaceLookups < profiles.length * 4,
    `surface lookups must scale with profile endpoints, not all 477 candidates: ${JSON.stringify(access)}`,
  );
  assert.ok(
    access.storedRelationEndpointLookups <= profiles.length * 4,
    `stored-relation work must remain endpoint indexed: ${JSON.stringify(access)}`,
  );
  assert.equal(revalidated.length, 200);
  assert.deepEqual(
    revalidated.map((entry) => entry.name),
    profiles.map((entry) => entry.name),
    "bulk projection must preserve input order and cardinality",
  );
  const revalidatedArchive = revalidated.find((entry) => entry.name === "Archive 0")!;
  const revalidatedMichael = revalidated.find((entry) => entry.name === "Michael")!;
  const revalidatedThrall = revalidated.find((entry) => entry.name === "Thrall")!;
  assert.equal(
    revalidatedArchive.relationshipWeb.some((entry) => entry.name === "Keeper 0"),
    true,
    "the one grounded source relationship remains attached to its source profile",
  );
  assert.equal(
    revalidated.filter((entry) => entry.name !== "Archive 0").some((entry) =>
      entry.relationshipWeb.some((relationship) => relationship.name === "Keeper 0")
    ),
    false,
    "shared indexes must not leak one profile's relationships into another profile",
  );
  assert.equal(
    revalidatedMichael.relationshipWeb.find((entry) => entry.name === "Thrall")?.relationship,
    "Manifests As",
  );
  assert.equal(
    revalidatedThrall.relationshipWeb.find((entry) => entry.name === "Michael")?.relationship,
    "Manifested By",
  );

  const taxonomyEvidence = [{
    chunkId: "taxonomy-index-order",
    sourceId: "book",
    quote: "Old Harbor, Shared, and Beacon were catalogued.",
  }];
  const taxonomyFinding = (
    name: string,
    aliases: string[],
    summary: string,
  ): NamedFinding => ({
    name,
    aliases,
    summary,
    evidence: taxonomyEvidence,
    confidence: 0.9,
  });
  const genericProfile = (name: string) => profile(name, {
    role: "Character",
    summary: `${name} is a character in the story.`,
  });
  let taxonomyObservation: Record<string, number> | undefined;
  const taxonomyRevalidated = revalidateGeneratedLocalDossierProfiles({
    findings: {
      ...findings,
      characters: [],
      locations: [
        taxonomyFinding("First Harbor", ["Old Harbor"], "The first alias owner remains authoritative."),
        taxonomyFinding("Old Harbor", [], "A later exact-name row."),
        taxonomyFinding("Beacon Place", ["Beacon"], "A place that shares the Beacon surface."),
        taxonomyFinding("Shared Place", ["Shared"], "One ambiguous alias owner."),
      ],
      creatures: [taxonomyFinding("Shared Beast", ["Shared"], "The other ambiguous alias owner.")],
      species: [],
      devices: [taxonomyFinding("Beacon", [], "Beacon is the exact device dossier.")],
      entityRelations: [],
    },
    profiles: [
      { linkedEntityType: "weapon", finding: genericProfile("Old Harbor") },
      { linkedEntityType: "weapon", finding: genericProfile("Shared") },
      { linkedEntityType: "weapon", finding: genericProfile("Beacon") },
    ],
    onProfileProjectionAccess: (event) => {
      taxonomyObservation = {
        taxonomyIndexBuilds: event.taxonomyIndexBuilds,
        taxonomyFindingRowsIndexed: event.taxonomyFindingRowsIndexed,
        taxonomyExactTypeLookups: event.taxonomyExactTypeLookups,
        taxonomyExactBucketRowsExamined: event.taxonomyExactBucketRowsExamined,
        taxonomySurfaceTypeLookups: event.taxonomySurfaceTypeLookups,
        taxonomySurfaceBucketRowsExamined: event.taxonomySurfaceBucketRowsExamined,
        taxonomyMaxSurfaceBucketSize: event.taxonomyMaxSurfaceBucketSize,
        taxonomyFallbackFindingLookups: event.taxonomyFallbackFindingLookups,
        taxonomyFallbackBucketRowsExamined: event.taxonomyFallbackBucketRowsExamined,
        taxonomyFullFindingScans: event.taxonomyFullFindingScans,
      };
    },
  });
  assert.deepEqual(taxonomyObservation, {
    taxonomyIndexBuilds: 1,
    taxonomyFindingRowsIndexed: 6,
    taxonomyExactTypeLookups: 3,
    taxonomyExactBucketRowsExamined: 2,
    taxonomySurfaceTypeLookups: 3,
    taxonomySurfaceBucketRowsExamined: 6,
    taxonomyMaxSurfaceBucketSize: 2,
    taxonomyFallbackFindingLookups: 3,
    taxonomyFallbackBucketRowsExamined: 2,
    taxonomyFullFindingScans: 0,
  });
  assert.deepEqual(taxonomyRevalidated.map((entry) => entry.name), ["Old Harbor", "Shared", "Beacon"]);
  assert.equal(taxonomyRevalidated[0]?.role, "Place");
  assert.equal(
    taxonomyRevalidated[0]?.summary,
    "The first alias owner remains authoritative.",
    "fallback finding selection must preserve the former first-candidate Array.find order",
  );
  assert.equal(taxonomyRevalidated[1]?.role, "Weapon");
  assert.equal(
    taxonomyRevalidated[1]?.summary,
    "Shared is a weapon in this world.",
    "an alias owned by multiple taxonomy types must not silently reclassify the profile",
  );
  assert.equal(taxonomyRevalidated[2]?.role, "Device");
  assert.equal(taxonomyRevalidated[2]?.summary, "Beacon is the exact device dossier.");
});

test("global generated dossier persistence is atomic and repairs a split state on retry", async () => {
  const db = new PGlite();
  const unsetStat = () => ({ score: 10, confidence: 0.1, rationale: "Not established.", evidence: [] });
  const finding: CharacterFinding = {
    name: "Mara Vale",
    aliases: [],
    role: "Supporting Character",
    summary: "Mara Vale is a resourceful station engineer.",
    traits: ["resourceful"], motivations: [], fears: [],
    capabilities: ["Mara Vale repairs damaged station systems."],
    history: [], origins: [], powers: [], moralSystem: [], physicalCharacteristics: [],
    relationships: ["Nera: Friend"], relationshipWeb: [],
    estimatedStats: {
      strength: unsetStat(), dexterity: unsetStat(), constitution: unsetStat(),
      intelligence: unsetStat(), wisdom: unsetStat(), charisma: unsetStat(), acrobatics: unsetStat(),
    },
    socioPoliticalAxis: {
      economic: 0, authority: 0, label: "Undetermined", rationale: "Insufficient evidence.", confidence: 0.1,
    },
    knowledge: [], secrets: [], factionMemberships: [], evidence: [],
    confidence: 0.8, mentionCount: 12, mentionSourceCount: 1,
  };
  try {
    await db.exec(`
      CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.character_dossiers (
        id text PRIMARY KEY, summary text NOT NULL, profile jsonb NOT NULL,
        user_edited_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE storyhold.world_entities (
        dossier_id text NOT NULL, classification_source text NOT NULL,
        review_status text, pull_status text NOT NULL, entity_type text NOT NULL,
        summary text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO storyhold.character_dossiers (id, summary, profile)
      VALUES ('dossier-one', 'Old dossier summary.', '{}'::jsonb);
      INSERT INTO storyhold.world_entities
        (dossier_id, classification_source, review_status, pull_status, entity_type, summary)
      VALUES ('dossier-one', 'local', 'candidate', 'active', 'character', 'Old entity summary.');
    `);
    await assert.rejects(() => persistRevalidatedGeneratedDossierProfile(db, {
      dossierId: "dossier-one",
      finding,
    }));
    const rolledBack = await db.query<{ summary: string }>(
      "SELECT summary FROM storyhold.character_dossiers WHERE id = 'dossier-one'",
    );
    assert.equal(rolledBack.rows[0]?.summary, "Old dossier summary.");

    await db.exec(`
      ALTER TABLE storyhold.world_entities ADD COLUMN relationships jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE storyhold.world_entities ADD COLUMN details jsonb NOT NULL DEFAULT '[]'::jsonb;
    `);
    await persistRevalidatedGeneratedDossierProfile(db, {
      dossierId: "dossier-one",
      finding,
    });
    const repaired = await db.query<{ dossier_summary: string; entity_summary: string; relationships: unknown }>(
      `SELECT dossier.summary AS dossier_summary, entity.summary AS entity_summary, entity.relationships
         FROM storyhold.character_dossiers dossier
         JOIN storyhold.world_entities entity ON entity.dossier_id = dossier.id
        WHERE dossier.id = 'dossier-one'`,
    );
    assert.equal(repaired.rows[0]?.dossier_summary, finding.summary);
    assert.equal(repaired.rows[0]?.entity_summary, finding.summary);
    assert.deepEqual(repaired.rows[0]?.relationships, finding.relationships);

    // A second run is a no-op for the dossier but must still be safe and leave
    // the overview synchronized.
    await persistRevalidatedGeneratedDossierProfile(db, {
      dossierId: "dossier-one",
      finding,
    });

    // Ownership is re-checked under a row lock inside the transaction. A
    // customer edit made after the replay selected this row protects both the
    // dossier and its linked overview projection.
    await db.exec(`
      UPDATE storyhold.character_dossiers
         SET summary = 'Customer-authored dossier.',
             profile = '{"traits":["customer-authored"]}'::jsonb,
             user_edited_at = now();
      UPDATE storyhold.world_entities
         SET summary = 'Customer-authored overview.',
             details = '["Customer-authored detail"]'::jsonb,
             relationships = '["Customer Link"]'::jsonb;
    `);
    await persistRevalidatedGeneratedDossierProfile(db, {
      dossierId: "dossier-one",
      finding: { ...finding, summary: "A later generated replay." },
    });
    const protectedRows = await db.query<{
      dossier_summary: string;
      entity_summary: string;
      relationships: unknown;
    }>(
      `SELECT dossier.summary AS dossier_summary, entity.summary AS entity_summary, entity.relationships
         FROM storyhold.character_dossiers dossier
         JOIN storyhold.world_entities entity ON entity.dossier_id = dossier.id
        WHERE dossier.id = 'dossier-one'`,
    );
    assert.equal(protectedRows.rows[0]?.dossier_summary, "Customer-authored dossier.");
    assert.equal(protectedRows.rows[0]?.entity_summary, "Customer-authored overview.");
    assert.deepEqual(protectedRows.rows[0]?.relationships, ["Customer Link"]);
  } finally {
    await db.close();
  }
});

test("bulk generated dossier persistence uses one ownership lock and two set-based writes", async () => {
  const unsetStat = () => ({ score: 10, confidence: 0.1, rationale: "Not established.", evidence: [] });
  const baseFinding: CharacterFinding = {
    name: "Profile 0", aliases: [], role: "Supporting Character",
    summary: "A generated profile.", traits: [], motivations: [], fears: [],
    capabilities: [], history: [], origins: [], powers: [], moralSystem: [],
    physicalCharacteristics: [], relationships: [], relationshipWeb: [],
    estimatedStats: {
      strength: unsetStat(), dexterity: unsetStat(), constitution: unsetStat(),
      intelligence: unsetStat(), wisdom: unsetStat(), charisma: unsetStat(), acrobatics: unsetStat(),
    },
    socioPoliticalAxis: {
      economic: 0, authority: 0, label: "Undetermined",
      rationale: "Insufficient evidence.", confidence: 0.1,
    },
    knowledge: [], secrets: [], factionMemberships: [], evidence: [], confidence: 0.8,
  };
  const profiles = Array.from({ length: 50 }, (_, index) => ({
    dossierId: `dossier-${index}`,
    finding: { ...baseFinding, name: `Profile ${index}` },
  }));
  const queryCalls: Array<{ sql: string; params: unknown[] }> = [];
  let transactionCalls = 0;
  const db = {
    async transaction<T>(callback: (tx: {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ id: string }> }>;
    }) => Promise<T>) {
      transactionCalls += 1;
      return callback({
        async query(sql: string, params: unknown[] = []) {
          queryCalls.push({ sql, params });
          if (/SELECT id::text AS id/iu.test(sql)) {
            return { rows: (params[0] as string[]).map((id) => ({ id })) };
          }
          return { rows: [] };
        },
      });
    },
  };

  await persistRevalidatedGeneratedDossierProfiles(db as never, profiles);

  assert.equal(transactionCalls, 1);
  assert.equal(queryCalls.length, 3, "profile count must not multiply database statements");
  assert.equal((queryCalls[0]?.params[0] as string[]).length, 50);
  assert.equal((JSON.parse(String(queryCalls[1]?.params[0])) as unknown[]).length, 50);
  assert.equal((JSON.parse(String(queryCalls[2]?.params[0])) as unknown[]).length, 50);
});

test("scanner writes cannot alter customer classifications or pull decisions", () => {
  assert.equal(entityIsScannerProtected(undefined), false);
  assert.equal(entityIsScannerProtected({
    classification_source: "user",
    review_status: "verified",
    pull_status: "active",
  }), true);
  assert.equal(entityIsScannerProtected({
    classification_source: "ai",
    review_status: "user_confirmed",
    pull_status: "active",
  }), true, "legacy confirmations remain customer-owned even before source repair");
  for (const pullStatus of ["do_not_pull", "merged", "deleted"]) {
    assert.equal(entityIsScannerProtected({
      classification_source: "local",
      review_status: "candidate",
      pull_status: pullStatus,
    }), true);
  }
  assert.equal(entityIsScannerProtected({
    classification_source: "local",
    review_status: "candidate",
    pull_status: "active",
  }), false);
});

test("dossier replay synchronizes generated categories, public copy, and stale context visibility", () => {
  const povSummary = "Rowan is observant and deliberate. As a central point-of-view character, Rowan's choices and perspective anchor the story.";
  const synchronized = adjudicatePersistedLocalEntityRows([{
    id: "rowan-entity",
    dossier_id: null,
    name: "Rowan",
    normalized_name: "rowan",
    entity_type: "place",
    classification_source: "local",
    review_status: "candidate",
    pull_status: "active",
    scanner_present: true,
    summary: "Rowan is presented as a location within the story.",
    details: ["Place", "Grounded in the Manuscript"],
    evidence: [{ chunkId: "heading", sourceId: "book", quote: "Chapter 4 - Crossroads (Rowan - Present)" }],
  }, {
    id: "oren-entity",
    dossier_id: "oren-dossier",
    name: "Oren",
    normalized_name: "oren",
    entity_type: "character",
    classification_source: "local",
    review_status: "candidate",
    pull_status: "active",
    scanner_present: true,
    summary: "Oren is presented as a creature or nonhuman form within the story.",
    details: ["Creature", "Grounded in the Manuscript"],
    evidence: [{ chunkId: "o1", sourceId: "book", quote: 'Oren nodded. "I will go," he said.' }],
  }, {
    id: "owner-entity",
    name: "Owner Place",
    normalized_name: "owner place",
    entity_type: "place",
    classification_source: "local",
    review_status: "user_confirmed",
    pull_status: "active",
    scanner_present: true,
    summary: "Owner classification.",
    details: [],
    evidence: [{ chunkId: "owner", sourceId: "book", quote: 'Owner Place said, "Hello."' }],
  }], [{
    id: "rowan-dossier",
    name: "Rowan",
    normalized_name: "rowan",
    role: "Central Point-of-View Character",
    summary: povSummary,
    dossier_status: "active",
    profile: {},
    evidence: [{ chunkId: "heading", sourceId: "book", quote: "Chapter 4 - Crossroads (Rowan - Present)" }],
    mention_count: 30,
    mention_source_count: 1,
  }, {
    id: "oren-dossier",
    name: "Oren",
    normalized_name: "oren",
    role: "Recurring Character",
    summary: "Oren is a patient mediator who protects the people around him.",
    dossier_status: "active",
    profile: { traits: ["Patient mediator"] },
    evidence: [{ chunkId: "o1", sourceId: "book", quote: 'Oren nodded. "I will go," he said.' }],
    mention_count: 12,
    mention_source_count: 1,
  }]);
  const rowan = synchronized.rows.find((row) => row.id === "rowan-entity")!;
  assert.equal(rowan.entity_type, "character");
  assert.equal(rowan.summary, povSummary);
  assert.equal(synchronized.updates.find((update) => update.id === "rowan-entity")?.dossierId, "rowan-dossier");
  assert.equal(synchronized.updates.find((update) => update.id === "rowan-entity")?.activateDossier, true);
  const oren = synchronized.rows.find((row) => row.id === "oren-entity")!;
  assert.equal(oren.entity_type, "character");
  assert.equal(oren.summary, "Oren is a patient mediator who protects the people around him.");
  assert.doesNotMatch(JSON.stringify(oren.details), /Creature/iu);
  assert.equal(synchronized.updates.some((update) => update.id === "owner-entity"), false);

  const localLead = {
    classification_source: "local",
    review_status: "candidate",
    pull_status: "active",
    scanner_present: true,
  };
  assert.equal(generatedLocalContextLeadShouldRemainVisible({ ...localLead, name: "Dad", entity_type: "term" }), false);
  assert.equal(generatedLocalContextLeadShouldRemainVisible({ ...localLead, name: "Dude", entity_type: "term" }), false);
  assert.equal(generatedLocalContextLeadShouldRemainVisible({
    ...localLead,
    name: "Jesus",
    entity_type: "cultural_reference",
    evidence: [{ chunkId: "j", sourceId: "book", quote: '"Jesus!" she shouted.' }],
  }), false);
  assert.equal(generatedLocalContextLeadShouldRemainVisible({
    ...localLead,
    name: "Roger",
    entity_type: "cultural_reference",
    mention_count: 2,
    evidence: [{ chunkId: "r1", sourceId: "book", quote: '"From American Dad? You know, the alien Roger? I never watched that show."' }, {
      chunkId: "r2", sourceId: "book", quote: '"Roger that, team leader."',
    }],
  }), false);
  assert.equal(generatedLocalContextLeadShouldRemainVisible({
    ...localLead,
    name: "American Dad",
    entity_type: "cultural_reference",
    mention_count: 1,
    evidence: [{ chunkId: "r1", sourceId: "book", quote: '"From American Dad? I watched that show."' }],
  }), true);
  assert.equal(generatedLocalContextLeadShouldRemainVisible({
    ...localLead,
    classification_source: "user",
    name: "Roger",
    entity_type: "cultural_reference",
    mention_count: 1,
    evidence: [],
  }), true);
  for (const [name, quote] of [
    ["EMBERS", "BOOK TWO, EMBERS"],
    ["Requiem", "Chapter 22 - Requiem (Kendall - Past)"],
    ["Soldier Spy", "Chapter 14 - Tinker Tailor Soldier Spy"],
  ] as const) {
    assert.equal(generatedLocalContextLeadShouldRemainVisible({
      ...localLead,
      name,
      entity_type: "ambiguous",
      evidence: [{ chunkId: `heading-${name}`, sourceId: "book", quote }],
    }), false, `${name} is document structure, not a lore page`);
  }
});

test("persisted boundary repairs a stale card without stealing an owned dossier", async () => {
  const db = new PGlite();
  const ownerId = "00000000-0000-4000-8000-000000000291";
  const staleId = "00000000-0000-4000-8000-000000000292";
  const dossierId = "00000000-0000-4000-8000-000000000293";
  try {
    await db.exec(`
      CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.world_entities (
        id uuid PRIMARY KEY,
        dossier_id uuid UNIQUE,
        entity_type text NOT NULL,
        summary text NOT NULL DEFAULT '',
        details jsonb NOT NULL DEFAULT '[]',
        classification_source text NOT NULL DEFAULT 'local',
        review_status text NOT NULL DEFAULT 'candidate',
        pull_status text NOT NULL DEFAULT 'active',
        scanner_present boolean NOT NULL DEFAULT true,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO storyhold.world_entities
        (id, dossier_id, entity_type, summary)
      VALUES
        ('${ownerId}', '${dossierId}', 'character', 'The established dossier owner.'),
        ('${staleId}', NULL, 'place', 'Stale generated category.');
    `);

    const update = {
      id: staleId,
      entityType: "character" as const,
      previousEntityType: "place" as const,
      summary: "The stale card is now correctly presented as a character.",
      details: ["Character", "Grounded in the Manuscript"],
      dossierId,
      activateDossier: true,
    };
    const linkedDossierId = await persistAdjudicatedLocalEntityUpdate(db, update);
    assert.equal(linkedDossierId, "", "the occupied dossier remains unavailable to the stale card");
    const conflictRows = await db.query<Record<string, unknown>>(
      `SELECT id::text AS id, dossier_id::text AS dossier_id, entity_type, summary
         FROM storyhold.world_entities ORDER BY id`,
    );
    assert.equal(conflictRows.rows.find((row) => row.id === ownerId)?.dossier_id, dossierId);
    assert.equal(conflictRows.rows.find((row) => row.id === staleId)?.dossier_id, null);
    assert.equal(conflictRows.rows.find((row) => row.id === staleId)?.entity_type, "character");
    assert.equal(
      conflictRows.rows.find((row) => row.id === staleId)?.summary,
      update.summary,
      "ownership conflict must not block the independent category/copy repair",
    );

    await db.query(
      `UPDATE storyhold.world_entities SET dossier_id = NULL WHERE id = $1`,
      [ownerId],
    );
    const newlyLinkedDossierId = await persistAdjudicatedLocalEntityUpdate(db, update);
    assert.equal(newlyLinkedDossierId, dossierId, "an actually unowned dossier can still be linked");
  } finally {
    await db.close();
  }
});

test("first replay re-adjudicates a stale place before bridging an explicit familiar-name POV identity", () => {
  const rows: Record<string, unknown>[] = [{
    id: "david",
    dossier_id: "david-dossier",
    name: "David",
    normalized_name: "david",
    aliases: [],
    entity_type: "place",
    classification_source: "local",
    review_status: "candidate",
    pull_status: "active",
    scanner_present: true,
    mention_count: 87,
    evidence: [{ sourceId: "book-one", chunkId: "d1", quote: "David sneered again, the corners of his lips curling with malice. His voice was smooth." }, {
      sourceId: "book-one", chunkId: "d2", quote: 'Mrs. Whitaker asked, "David, what events in your past led you down this path of violence?"',
    }, {
      sourceId: "book-two", chunkId: "d3", quote: 'David appeared lost in thought before answering. "Regret? There is no space for it."',
    }, {
      sourceId: "book-two", chunkId: "d4", quote: "David defiantly straightened in his chair, straining against the chains that bound him.",
    }],
  }, {
    id: "raider-dave",
    dossier_id: "raider-dave-dossier",
    name: "Raider Dave",
    normalized_name: "raider dave",
    aliases: ["Dave"],
    entity_type: "character",
    classification_source: "local",
    review_status: "candidate",
    pull_status: "active",
    scanner_present: true,
    mention_count: 60,
    evidence: [{ sourceId: "book-two", chunkId: "rd1", quote: "Raider Dave checked the perimeter before the others woke." }],
  }];
  const dossiers = [{
    id: "david-dossier",
    name: "David",
    normalized_name: "david",
    dossier_status: "suppressed",
    role: "Supporting Character",
    summary: "David is calculating, verbally cruel, and openly defiant under pressure.",
    profile: { traits: ["Calculating", "Defiant"] },
    evidence: rows[0]!.evidence,
    mention_count: 87,
    mention_source_count: 2,
  }, {
    id: "raider-dave-dossier",
    name: "Raider Dave",
    normalized_name: "raider dave",
    dossier_status: "active",
    role: "Point-of-View Character",
    summary: "Raider Dave narrates his own chapters.",
    profile: {},
    evidence: rows[1]!.evidence,
    mention_count: 60,
    mention_source_count: 2,
  }];
  const asIdentityRows = (input: Record<string, unknown>[]): ExplicitCharacterIdentityEntity[] => input.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    aliases: Array.isArray(row.aliases) ? row.aliases.map(String) : [],
    entityType: String(row.entity_type),
    pullStatus: String(row.pull_status),
    scannerPresent: row.scanner_present === true,
    dossierId: row.dossier_id ? String(row.dossier_id) : null,
    mentionCount: Number(row.mention_count) || 0,
  }));
  const identityChunks = [{
    id: "declaration",
    sourceId: "book-one",
    sourceTitle: "Novel",
    content: 'David smiled. "Mr. Aldrin! What an honor to see you again!" He exclaimed. "Call me Dave, please."',
    metadata: { sectionTitle: "Chapter 3 (Alec - Present)" },
  }, {
    id: "pov",
    sourceId: "book-two",
    sourceTitle: "Novel",
    content: "I checked the perimeter before the others woke.",
    metadata: { sectionTitle: "Chapter 9 (Raider Dave - Present)" },
  }];
  assert.deepEqual(resolveExplicitCharacterIdentities({
    entities: asIdentityRows(rows),
    chunks: identityChunks,
  }), [], "the stale place category cannot ground a speaker before boundary adjudication");
  const boundary = adjudicatePersistedLocalEntityRows(rows, dossiers);
  assert.equal(boundary.rows.find((row) => row.id === "david")?.entity_type, "character");
  assert.equal(boundary.updates.find((update) => update.id === "david")?.activateDossier, true);
  const [resolution] = resolveExplicitCharacterIdentities({
    entities: asIdentityRows(boundary.rows),
    chunks: identityChunks,
  });
  assert.equal(resolution?.survivorId, "david");
  assert.deepEqual(resolution?.memberIds, ["david", "raider-dave"]);
  assert.ok(resolution?.aliases.includes("Dave"));
  assert.ok(resolution?.aliases.includes("Raider Dave"));
});

test("normal persisted migration repairs stale identities and restores the surviving taxonomy dossier", async () => {
  const db = new PGlite();
  const worldId = "00000000-0000-4000-8000-000000000301";
  const editionId = "00000000-0000-4000-8000-000000000302";
  const bookOneId = "00000000-0000-4000-8000-000000000303";
  const bookTwoId = "00000000-0000-4000-8000-000000000304";
  const davidId = "00000000-0000-4000-8000-000000000305";
  const raiderDaveId = "00000000-0000-4000-8000-000000000306";
  const prowlerId = "00000000-0000-4000-8000-000000000307";
  const prowlersId = "00000000-0000-4000-8000-000000000308";
  const protectedId = "00000000-0000-4000-8000-000000000309";
  const davidDossierId = "00000000-0000-4000-8000-000000000310";
  const raiderDaveDossierId = "00000000-0000-4000-8000-000000000311";
  const prowlerDossierId = "00000000-0000-4000-8000-000000000312";
  const protectedDossierId = "00000000-0000-4000-8000-000000000313";
  const runId = "00000000-0000-4000-8000-000000000318";
  const michaelId = "00000000-0000-4000-8000-000000000319";
  const thrallId = "00000000-0000-4000-8000-000000000320";
  const michaelDossierId = "00000000-0000-4000-8000-000000000321";
  const thrallDossierId = "00000000-0000-4000-8000-000000000322";
  const thrallRevealChunkId = "00000000-0000-4000-8000-000000000323";
  try {
    // These are the production columns touched by the normal migration,
    // identity merge, and mention-index rebuild. The test intentionally uses
    // persisted rows instead of calling the arbitration helpers in isolation.
    await db.exec(`
      CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.world_analysis_runs (
        id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
        analysis_kind text NOT NULL, status text NOT NULL,
        local_checkpoint jsonb NOT NULL DEFAULT '{}',
        completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE storyhold.character_dossiers (
        id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
        canonical_character_id uuid, source_analysis_run_id uuid,
        canonical_key text NOT NULL, normalized_name text NOT NULL, name text NOT NULL,
        aliases jsonb NOT NULL DEFAULT '[]', alias_attributions jsonb NOT NULL DEFAULT '[]',
        role text NOT NULL DEFAULT '', summary text NOT NULL DEFAULT '',
        profile jsonb NOT NULL DEFAULT '{}', evidence jsonb NOT NULL DEFAULT '[]',
        confidence real NOT NULL DEFAULT 0, dossier_status text NOT NULL DEFAULT 'active',
        axis_estimate jsonb NOT NULL DEFAULT '{}', axis_user_override jsonb,
        axis_user_changed_at timestamptz, user_edited_at timestamptz,
        mention_count integer NOT NULL DEFAULT 0,
        mention_source_count integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE storyhold.world_entities (
        id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
        dossier_id uuid, source_analysis_run_id uuid, canonical_key text NOT NULL,
        normalized_name text NOT NULL, name text NOT NULL, entity_type text NOT NULL,
        aliases jsonb NOT NULL DEFAULT '[]', alias_attributions jsonb NOT NULL DEFAULT '[]',
        summary text NOT NULL DEFAULT '', details jsonb NOT NULL DEFAULT '[]',
        relationships jsonb NOT NULL DEFAULT '[]', estimated_stats jsonb NOT NULL DEFAULT '{}',
        evidence jsonb NOT NULL DEFAULT '[]', mention_count integer NOT NULL DEFAULT 0,
        mention_source_count integer NOT NULL DEFAULT 0, confidence real NOT NULL DEFAULT 0,
        classification_source text NOT NULL DEFAULT 'local',
        review_status text NOT NULL DEFAULT 'candidate',
        pull_status text NOT NULL DEFAULT 'active', scanner_present boolean NOT NULL DEFAULT true,
        merged_into_entity_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE storyhold.world_entity_relations (
        id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
        source_entity_id uuid NOT NULL, relation_type text NOT NULL,
        target_entity_id uuid NOT NULL, relation_status text NOT NULL DEFAULT 'active',
        summary text NOT NULL DEFAULT '', valid_from_label text NOT NULL DEFAULT '',
        valid_until_label text NOT NULL DEFAULT '', evidence jsonb NOT NULL DEFAULT '[]',
        assignment_source text NOT NULL DEFAULT 'local', confidence real NOT NULL DEFAULT 0.5,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (world_id, canon_edition_id, source_entity_id, relation_type,
                target_entity_id, relation_status, valid_from_label, valid_until_label)
      );
      CREATE TABLE storyhold.character_dossier_source_contributions (
        id uuid PRIMARY KEY, dossier_id uuid NOT NULL, source_id uuid NOT NULL,
        world_id uuid NOT NULL, canon_edition_id uuid NOT NULL, last_analysis_run_id uuid,
        aliases jsonb NOT NULL DEFAULT '[]', role text NOT NULL DEFAULT '',
        summary text NOT NULL DEFAULT '', profile jsonb NOT NULL DEFAULT '{}',
        evidence jsonb NOT NULL DEFAULT '[]', confidence real NOT NULL DEFAULT 0,
        axis_estimate jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (dossier_id, source_id)
      );
      CREATE TABLE storyhold.world_sources (
        id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
        title text NOT NULL, processing_status text NOT NULL, canon_status text NOT NULL,
        chronology_order integer NOT NULL DEFAULT 0, sort_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE storyhold.world_source_chunks (
        id uuid PRIMARY KEY, source_id uuid NOT NULL, world_id uuid NOT NULL,
        canon_edition_id uuid NOT NULL, chunk_index integer NOT NULL,
        content text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'
      );
      CREATE TABLE storyhold.world_coreference_mentions (
        id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
        source_id uuid NOT NULL, chunk_id uuid NOT NULL, cluster_key text NOT NULL,
        surface_form text NOT NULL, normalized_surface text NOT NULL,
        start_offset integer NOT NULL, end_offset integer NOT NULL,
        context text NOT NULL DEFAULT '', cluster_mentions jsonb NOT NULL DEFAULT '[]',
        model text NOT NULL DEFAULT 'fixture', extraction_version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE storyhold.world_entity_mentions (
        id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
        source_id uuid NOT NULL, chunk_id uuid NOT NULL, entity_id uuid,
        surface_form text NOT NULL, normalized_surface text NOT NULL,
        start_offset integer NOT NULL, end_offset integer NOT NULL,
        context text NOT NULL DEFAULT '', resolution_status text NOT NULL,
        confidence real NOT NULL DEFAULT 0, mention_kind text NOT NULL DEFAULT 'literal',
        antecedent_surface text, cluster_key text,
        extraction_version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE storyhold.world_breakdowns (
        world_id uuid NOT NULL, canon_edition_id uuid NOT NULL, version integer NOT NULL,
        summary text NOT NULL DEFAULT '', creatures jsonb NOT NULL DEFAULT '[]',
        entity_relations jsonb NOT NULL DEFAULT '[]'
      );
      CREATE TABLE storyhold.world_chapter_summaries (
        source_id uuid NOT NULL, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
        source_order integer NOT NULL DEFAULT 0
      );
    `);
    await db.query(
      `INSERT INTO storyhold.world_sources
        (id, world_id, canon_edition_id, title, processing_status, canon_status,
         chronology_order, sort_order)
       VALUES ($1, $3, $4, 'Book One', 'ready', 'canon', 0, 0),
              ($2, $3, $4, 'Book Two', 'ready', 'canon', 1, 0)`,
      [bookOneId, bookTwoId, worldId, editionId],
    );
    await db.query(
      `INSERT INTO storyhold.world_analysis_runs
        (id, world_id, canon_edition_id, analysis_kind, status, local_checkpoint, completed_at)
       VALUES ($1, $2, $3, 'local_scan', 'completed', '{}', now())`,
      [runId, worldId, editionId],
    );
    await db.query(
      `INSERT INTO storyhold.world_source_chunks
        (id, source_id, world_id, canon_edition_id, chunk_index, content, metadata)
       VALUES
        ('00000000-0000-4000-8000-000000000314', $1, $3, $4, 0,
         'David smiled. "Mr. Aldrin! What an honor to see you again!" He exclaimed. "Call me Dave, please."',
         '{"sectionTitle":"Chapter 3 (Alec - Present)"}'),
        ('00000000-0000-4000-8000-000000000315', $2, $3, $4, 0,
         'I checked the perimeter before the others woke.',
         '{"sectionTitle":"Chapter 17 (Raider Dave - Present)"}'),
        ('00000000-0000-4000-8000-000000000316', $1, $3, $4, 1,
         'The crowd filled the space, its anger directed towards David. Later, a message arrived from Dave.',
         '{"sectionTitle":"Chapter 4 (Alec - Present)"}'),
        ('00000000-0000-4000-8000-000000000317', $1, $3, $4, 2,
         'A Prowler snarled, its claws scraping stone. The Prowlers snarled as the pack advanced.',
         '{"sectionTitle":"Chapter 5"}')`,
      [bookOneId, bookTwoId, worldId, editionId],
    );
    const thrallReveal = "Michael was the Thrall.";
    const thrallRevealEvidence = [{
      sourceId: bookTwoId,
      chunkId: thrallRevealChunkId,
      quote: thrallReveal,
    }];
    const thrallCreatureEvidence = [...thrallRevealEvidence, {
      sourceId: bookTwoId,
      chunkId: thrallRevealChunkId,
      quote: "The Thrall roared, opened its multifaceted eyes, and raised its claws.",
    }];
    const michaelCharacterEvidence = [{
      sourceId: bookOneId,
      chunkId: "michael-speaker",
      quote: 'Michael laughed and said, "We should go." Michael walked beside Alec.',
    }];
    await db.query(
      `INSERT INTO storyhold.world_source_chunks
        (id, source_id, world_id, canon_edition_id, chunk_index, content, metadata)
       VALUES ($1, $2, $3, $4, 1, $5, '{"sectionTitle":"Chapter 18 (Alec - Present)"}')`,
      [thrallRevealChunkId, bookTwoId, worldId, editionId, `${thrallReveal} The Thrall roared, opened its multifaceted eyes, raised its claws, and lifted Alec with one arm.`],
    );
    await db.query(
      `INSERT INTO storyhold.world_breakdowns
        (world_id, canon_edition_id, version, summary, creatures)
       VALUES ($1, $2, 1, 'A persisted world fixture.', $3::jsonb)`,
      [worldId, editionId, JSON.stringify([{
        name: "Thrall",
        aliases: [],
        summary: "The Thrall is a manifested nonhuman body.",
        evidence: thrallCreatureEvidence,
        confidence: 0.93,
      }])],
    );
    const davidEvidence = [{
      sourceId: bookOneId,
      chunkId: "00000000-0000-4000-8000-000000000316",
      quote: "The crowd filled the space, its anger directed towards David.",
    }, {
      sourceId: bookOneId,
      chunkId: "david-sneer",
      quote: "David sneered again, the corners of his lips curling with malice. His voice was smooth.",
    }, {
      sourceId: bookTwoId,
      chunkId: "david-answer",
      quote: 'David appeared lost in thought before answering. "Regret? There is no space for it."',
    }, {
      sourceId: bookTwoId,
      chunkId: "david-chair",
      quote: "David defiantly straightened in his chair, straining against the chains that bound him.",
    }];
    const raiderEvidence = [{
      sourceId: bookTwoId,
      chunkId: "00000000-0000-4000-8000-000000000315",
      quote: "Raider Dave checked the perimeter before the others woke.",
    }, {
      sourceId: bookTwoId,
      chunkId: "raider-dave-answer",
      quote: 'Raider Dave tightened his grip and answered, "I will take the eastern watch."',
    }];
    const prowlerEvidence = [{
      sourceId: bookOneId,
      chunkId: "00000000-0000-4000-8000-000000000317",
      quote: "A Prowler snarled, its claws scraping stone.",
    }];
    const prowlersEvidence = [{
      sourceId: bookOneId,
      chunkId: "00000000-0000-4000-8000-000000000317",
      quote: "The Prowlers snarled as the pack advanced.",
    }];
    await db.query(
      `INSERT INTO storyhold.character_dossiers
        (id, world_id, canon_edition_id, canonical_key, normalized_name, name,
         aliases, role, summary, profile, evidence, confidence, dossier_status,
         mention_count, mention_source_count, user_edited_at)
       VALUES
        ($1, $5, $6, 'character-david', 'david', 'David', '[]',
         'Recurring Character', 'David is calculating and openly defiant under pressure.',
         '{"traits":["Calculating","Defiant"]}', $7::jsonb, 0.86, 'suppressed', 87, 2, NULL),
        ($2, $5, $6, 'character-raider-dave', 'raider dave', 'Raider Dave', '["Dave"]',
         'Major Character', 'Raider Dave narrates his own chapters.',
         '{"traits":["Watchful"]}', $8::jsonb, 0.82, 'active', 60, 2, NULL),
        ($3, $5, $6, 'creature-prowler', 'prowler', 'Prowler', '[]',
         'Creature', 'Prowlers are taloned pack predators.', '{}',
         $9::jsonb, 0.78, 'suppressed', 24, 1, NULL),
        ($4, $5, $6, 'protected-owner', 'owner place', 'Owner Place', '[]',
         'Owner Canon', 'The owner controls this row.', '{"traits":["Owner Authored"]}',
         $10::jsonb, 1, 'active', 4, 1, now())`,
      [
        davidDossierId, raiderDaveDossierId, prowlerDossierId, protectedDossierId,
        worldId, editionId, JSON.stringify(davidEvidence), JSON.stringify(raiderEvidence),
        JSON.stringify(prowlerEvidence),
        JSON.stringify([{ sourceId: bookOneId, chunkId: "owner", quote: "Owner Place answered clearly." }]),
      ],
    );
    await db.query(
      `INSERT INTO storyhold.world_entities
        (id, world_id, canon_edition_id, dossier_id, canonical_key, normalized_name,
         name, entity_type, aliases, summary, evidence, mention_count,
         mention_source_count, confidence, classification_source, review_status,
         pull_status, scanner_present)
       VALUES
        ($1, $6, $7, $8, 'entity-david', 'david', 'David', 'place', '[]',
         'David is a recurring figure.', $12::jsonb, 87, 2, 0.86, 'local', 'candidate', 'active', true),
        ($2, $6, $7, $9, 'entity-raider-dave', 'raider dave', 'Raider Dave',
         'place', '["Dave"]', 'Raider Dave narrates his own chapters.',
         $13::jsonb, 60, 2, 0.82, 'local', 'candidate', 'active', true),
        ($3, $6, $7, $10, 'entity-prowler', 'prowler', 'Prowler', 'creature', '[]',
         'A taloned pack predator.', $14::jsonb, 24, 1, 0.78, 'local', 'candidate', 'active', true),
        ($4, $6, $7, NULL, 'entity-prowlers', 'prowlers', 'Prowlers', 'creature', '[]',
         'Taloned pack predators.', $15::jsonb, 12, 1, 0.74, 'local', 'candidate', 'active', true),
        ($5, $6, $7, $11, 'entity-protected-owner', 'owner place', 'Owner Place',
         'place', '[]', 'The owner controls this row.', $16::jsonb, 4, 1, 1,
         'local', 'user_confirmed', 'active', true)`,
      [
        davidId, raiderDaveId, prowlerId, prowlersId, protectedId, worldId, editionId,
        davidDossierId, raiderDaveDossierId, prowlerDossierId, protectedDossierId,
        JSON.stringify(davidEvidence), JSON.stringify(raiderEvidence),
        JSON.stringify(prowlerEvidence), JSON.stringify(prowlersEvidence),
        JSON.stringify([{ sourceId: bookOneId, chunkId: "owner", quote: "Owner Place answered clearly." }]),
      ],
    );

    // Real rejected-proof shape: the generated summary and Power already know
    // Michael's reveal, but neither endpoint has a saved relationship web and
    // the normalized relation table is empty. The targeted reader must prove
    // and persist both sides from the cited manuscript evidence in one pass.
    const michaelProfile = {
      powers: ["Michael can manifest as Thrall."],
      capabilities: ["Michael's Thrall form possesses immense physical strength."],
      estimatedStats: {
        strength: {
          score: 17,
          confidence: 0.82,
          rationale: "Michael's Thrall form directly demonstrates enhanced physical strength.",
          evidence: thrallRevealEvidence,
        },
      },
    };
    await db.query(
      `INSERT INTO storyhold.character_dossiers
        (id, world_id, canon_edition_id, source_analysis_run_id, canonical_key,
         normalized_name, name, aliases, role, summary, profile, evidence,
         confidence, dossier_status, mention_count, mention_source_count)
       VALUES
        ($1, $3, $4, $5, 'character-michael', 'michael', 'Michael', '["Mike"]',
         'Major Character', 'The manuscript directly attributes events and actions to Michael.',
         $6::jsonb, $7::jsonb, 0.91, 'active', 155, 2),
        ($2, $3, $4, $5, 'creature-thrall', 'thrall', 'Thrall', '[]',
         'Creature', 'The Thrall is a manifested nonhuman body.',
         $8::jsonb, $9::jsonb, 0.93, 'suppressed', 41, 1)`,
      [
        michaelDossierId, thrallDossierId, worldId, editionId, runId,
        JSON.stringify(michaelProfile),
        JSON.stringify(michaelCharacterEvidence),
        JSON.stringify({}),
        JSON.stringify(thrallCreatureEvidence),
      ],
    );
    await db.query(
      `INSERT INTO storyhold.world_entities
        (id, world_id, canon_edition_id, dossier_id, source_analysis_run_id,
         canonical_key, normalized_name, name, entity_type, aliases, summary,
         evidence, mention_count, mention_source_count, confidence,
         classification_source, review_status, pull_status, scanner_present)
       VALUES
        ($1, $3, $4, $5, $7, 'entity-michael', 'michael', 'Michael', 'character', '["Mike"]',
         'Michael is a major character.', $8::jsonb, 155, 2, 0.91,
         'local', 'candidate', 'active', true),
        ($2, $3, $4, $6, $7, 'entity-thrall', 'thrall', 'Thrall', 'creature', '[]',
         'The Thrall is a manifested nonhuman body.', $9::jsonb, 41, 1, 0.93,
         'local', 'candidate', 'active', true)`,
      [
        michaelId, thrallId, worldId, editionId, michaelDossierId, thrallDossierId, runId,
        JSON.stringify(michaelCharacterEvidence),
        JSON.stringify(thrallCreatureEvidence),
      ],
    );
    const seededMichael = await db.query<{ profile: Record<string, unknown> }>(
      `SELECT profile FROM storyhold.character_dossiers WHERE id = $1`,
      [michaelDossierId],
    );
    assert.ok(Array.isArray(seededMichael.rows[0]?.profile.powers));
    assert.equal(seededMichael.rows[0]?.profile.relationshipWeb, undefined,
      "the persisted fixture begins before reciprocal form projection");

    const phaseEvents: Array<{ phase: string; status: string; counts: Record<string, number> }> = [];
    await migrateLocalDossierUnderstanding(db, worldId, editionId, {
      force: true,
      localProjectionOnly: true,
      // Mirrors the rejected replay: expensive portrait synthesis is scoped
      // to principals, while structural repair must still cover the world.
      targetCharacterNames: ["Alec", "Ragger", "Michael", "Echo", "Lilly", "Kendall", "David"],
      onPhase: async (event) => {
        phaseEvents.push(event);
      },
    });
    assert.deepEqual(
      phaseEvents
        .filter((event) => event.phase === "deterministic_enrichment")
        .map((event) => event.status),
      ["start", "complete"],
    );
    assert.equal(
      phaseEvents.find((event) =>
        event.phase === "deterministic_enrichment" && event.status === "complete"
      )?.counts.deterministicCharacters,
      2,
      "only the surviving Michael and David dossiers are matched repair targets",
    );
    const targetAssembly = phaseEvents.find((event) =>
      event.phase === "target_assembly" && event.status === "start"
    );
    assert.equal(targetAssembly?.counts.promotedCharacters, 0,
      "a boundary-promoted alias merged during identity repair cannot become an extra synthesis target");
    assert.equal(targetAssembly?.counts.repairableDossiers, 2,
      "target assembly contains only the two surviving generated dossiers");
    assert.ok(!phaseEvents.some((event) => event.phase === "qwen_synthesis"),
      "projection-only maintenance never reports an unlabeled Qwen run");

    const entities = await db.query<Record<string, unknown>>(
      `SELECT * FROM storyhold.world_entities
        WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[davidId, raiderDaveId, prowlerId, prowlersId, protectedId]],
    );
    const byId = new Map(entities.rows.map((row) => [String(row.id), row]));
    assert.equal(byId.get(davidId)?.entity_type, "character",
      "the ordinary word space cannot preserve a stale place category");
    assert.equal(byId.get(davidId)?.pull_status, "active");
    assert.equal(byId.get(davidId)?.mention_count, 147, JSON.stringify([
      byId.get(davidId),
      byId.get(raiderDaveId),
    ]));
    assert.ok((byId.get(davidId)?.aliases as string[]).includes("Dave"));
    assert.ok((byId.get(davidId)?.aliases as string[]).includes("Raider Dave"));
    assert.equal(byId.get(raiderDaveId)?.pull_status, "merged");
    assert.equal(byId.get(raiderDaveId)?.merged_into_entity_id, davidId);
    assert.equal(byId.get(prowlerId)?.mention_count, 36);
    assert.ok((byId.get(prowlerId)?.aliases as string[]).includes("Prowlers"));
    assert.equal(byId.get(prowlersId)?.pull_status, "merged");
    assert.equal(byId.get(prowlersId)?.merged_into_entity_id, prowlerId);
    assert.equal(byId.get(protectedId)?.entity_type, "place");
    assert.equal(byId.get(protectedId)?.review_status, "user_confirmed");
    assert.equal(byId.get(protectedId)?.summary, "The owner controls this row.");

    const dossiers = await db.query<{
      id: string;
      aliases: unknown;
      dossier_status: string;
      mention_count: number;
      mention_source_count: number;
      user_edited_at: Date | null;
    }>(
      `SELECT id, aliases, dossier_status, mention_count, mention_source_count, user_edited_at
         FROM storyhold.character_dossiers
        WHERE id = ANY($1::uuid[])`,
      [[davidDossierId, raiderDaveDossierId, prowlerDossierId, protectedDossierId]],
    );
    const dossierById = new Map(dossiers.rows.map((row) => [row.id, row]));
    assert.equal(dossierById.get(davidDossierId)?.dossier_status, "active");
    assert.equal(dossierById.get(davidDossierId)?.mention_count, 147);
    assert.equal(dossierById.get(raiderDaveDossierId)?.dossier_status, "suppressed");
    assert.equal(dossierById.get(prowlerDossierId)?.dossier_status, "active",
      "the surviving visible taxonomy card must not retain a suppressed dossier");
    assert.deepEqual(dossierById.get(prowlerDossierId)?.aliases, ["Prowlers"]);
    assert.equal(dossierById.get(prowlerDossierId)?.mention_count, 36);
    assert.equal(dossierById.get(prowlerDossierId)?.mention_source_count, 1);
    assert.equal(dossierById.get(protectedDossierId)?.dossier_status, "active");
    assert.equal(dossierById.get(protectedDossierId)?.mention_count, 4);
    assert.ok(dossierById.get(protectedDossierId)?.user_edited_at);

    const assertPersistedMichaelThrallProjection = async (phase: string) => {
      const thrallEntity = await db.query<{ entity_type: string }>(
        `SELECT entity_type FROM storyhold.world_entities WHERE id = $1`,
        [thrallId],
      );
      assert.equal(thrallEntity.rows[0]?.entity_type, "creature", phase);
      const rows = await db.query<{ id: string; profile: Record<string, unknown> }>(
        `SELECT id, profile FROM storyhold.character_dossiers
          WHERE id = ANY($1::uuid[])`,
        [[michaelDossierId, thrallDossierId]],
      );
      const profiles = new Map(rows.rows.map((row) => [row.id, row.profile]));
      const michaelSaved = profiles.get(michaelDossierId) ?? {};
      const thrallSaved = profiles.get(thrallDossierId) ?? {};
      assert.ok(
        Array.isArray(michaelSaved.powers) && michaelSaved.powers.some((power) =>
          typeof power === "string" && /manifest as Thrall/iu.test(power)
        ),
        `${phase} Michael Power: ${JSON.stringify(michaelSaved)}`,
      );
      assert.ok(
        Array.isArray(michaelSaved.relationshipWeb) && michaelSaved.relationshipWeb.some((row) =>
          row && typeof row === "object" &&
          (row as { name?: unknown }).name === "Thrall" &&
          (row as { relationship?: unknown }).relationship === "Manifests As"
        ),
        `${phase} Michael form web: ${JSON.stringify(michaelSaved)}`,
      );
      assert.ok(
        Array.isArray(thrallSaved.relationshipWeb) && thrallSaved.relationshipWeb.some((row) =>
          row && typeof row === "object" &&
          (row as { name?: unknown }).name === "Michael" &&
          (row as { relationship?: unknown }).relationship === "Manifested By"
        ),
        `${phase} Thrall reciprocal web: ${JSON.stringify(thrallSaved)}`,
      );
      const relations = await db.query<{
        source_name: string;
        target_name: string;
        relation_type: string;
        evidence: Array<{ chunkId?: unknown; quote?: unknown }>;
        assignment_source: string;
      }>(
        `SELECT source.name AS source_name, target.name AS target_name,
                relation.relation_type, relation.evidence,
                relation.assignment_source
           FROM storyhold.world_entity_relations relation
           JOIN storyhold.world_entities source ON source.id = relation.source_entity_id
           JOIN storyhold.world_entities target ON target.id = relation.target_entity_id
          WHERE relation.world_id = $1 AND relation.canon_edition_id = $2
            AND relation.relation_type = 'has_form'`,
        [worldId, editionId],
      );
      assert.equal(relations.rows.length, 1, `${phase} normalized form row`);
      assert.equal(relations.rows[0]?.source_name, "Michael", phase);
      assert.equal(relations.rows[0]?.target_name, "Thrall", phase);
      assert.ok(relations.rows[0]?.evidence.some((entry) =>
        entry.chunkId === thrallRevealChunkId &&
        typeof entry.quote === "string" && /Michael was the Thrall/iu.test(entry.quote)
      ), `${phase} normalized evidence: ${JSON.stringify(relations.rows[0])}`);
      assert.notEqual(relations.rows[0]?.assignment_source, "user", phase);
    };
    await assertPersistedMichaelThrallProjection("after targeted final save");

    // Run the same world-wide generated-profile cleanup later, with no
    // matching targeted portrait. This proves the saved reciprocal graph is
    // stable after both sides cross their real persistence boundary.
    await migrateLocalDossierUnderstanding(db, worldId, editionId, {
      force: true,
      repairIdentities: false,
      targetCharacterNames: ["Absent Fixture Character"],
    });
    await assertPersistedMichaelThrallProjection("after later global cleanup");

    // Once an owner adopts the normalized edge, a later targeted replay may
    // rediscover the same evidence but must not rewrite the owner's wording,
    // evidence, or provenance.
    const ownerEvidence = [{
      sourceId: bookTwoId,
      chunkId: thrallRevealChunkId,
      quote: "Owner-confirmed Michael and Thrall identity.",
    }];
    await db.query(
      `UPDATE storyhold.world_entity_relations
          SET assignment_source = 'user', summary = 'Owner-confirmed form identity.',
              evidence = $3::jsonb
        WHERE world_id = $1 AND canon_edition_id = $2
          AND relation_type = 'has_form'`,
      [worldId, editionId, JSON.stringify(ownerEvidence)],
    );
    await migrateLocalDossierUnderstanding(db, worldId, editionId, {
      force: true,
      localProjectionOnly: true,
      repairIdentities: false,
      targetCharacterNames: ["Michael"],
    });
    const ownerRelation = await db.query<{
      summary: string;
      evidence: unknown;
      assignment_source: string;
    }>(
      `SELECT summary, evidence, assignment_source
         FROM storyhold.world_entity_relations
        WHERE world_id = $1 AND canon_edition_id = $2
          AND relation_type = 'has_form'`,
      [worldId, editionId],
    );
    assert.equal(ownerRelation.rows[0]?.assignment_source, "user");
    assert.equal(ownerRelation.rows[0]?.summary, "Owner-confirmed form identity.");
    assert.deepEqual(ownerRelation.rows[0]?.evidence, ownerEvidence);
  } finally {
    await db.close();
  }
});

test("legacy malformed breakdown labels cannot abort the completed-scan merge", () => {
  const categories = [
    ["world_rules", "worldRules"],
    ["locations", "locations"],
    ["factions", "factions"],
    ["institutions", "institutions"],
    ["governments", "governments"],
    ["power_structures", "powerStructures"],
    ["creatures", "creatures"],
    ["species", "species"],
    ["technologies", "technologies"],
    ["vehicles", "vehicles"],
    ["devices", "devices"],
    ["weapons", "weapons"],
    ["powers", "powers"],
    ["titles", "titles"],
    ["ambiguous_labels", "ambiguous"],
  ] as const;
  const stored: Record<string, unknown> = { summary: "Established world" };
  for (const [column, property] of categories) {
    stored[column] = [
      null,
      {},
      { summary: "legacy entry with no name" },
      `Legacy ${property}`,
      {
        name: `Grounded ${property}`,
        summary: `Established ${property} detail`,
        evidence: [
          null,
          {},
          { chunkId: "chunk-one", sourceId: "source-one", quote: "Grounded detail." },
        ],
      },
    ];
  }
  stored.chronology = [
    null,
    {},
    "Book One: The old sequence remains available.",
    {
      name: "The grounded sequence",
      summary: "A supported event.",
      evidence: [null, { chunkId: "chunk-one", sourceId: "source-one", quote: "A supported event." }],
    },
  ];

  const previous = findingsFromBreakdown(stored);
  const incoming = findingsFromBreakdown({ summary: "Fresh scan" });
  assert.ok(previous);
  assert.ok(incoming);
  const merged = mergeWorldFindings(previous, incoming);

  for (const [, property] of categories) {
    const findings = merged[property] as NamedFinding[];
    assert.deepEqual(
      findings.map((finding) => finding.name),
      [`Legacy ${property}`, `Grounded ${property}`],
      `${property} should retain every recoverable legacy entity`,
    );
    assert.equal(findings[1]?.evidence.length, 1);
  }
  assert.deepEqual(
    merged.chronology.map((finding) => finding.name),
    ["Book One", "The grounded sequence"],
  );
  assert.equal(merged.chronology[1]?.evidence.length, 1);
});

test("startup backlog never selects paid AI work", () => {
  assert.equal(
    deferredBacklogAnalysisKind({ needsLocal: false, needsAi: true }),
    null,
  );
  assert.equal(
    deferredBacklogAnalysisKind({ needsLocal: true, needsAi: true }),
    "local_scan",
  );
});

test("a complete Lorekeeper breakdown restores characters and chapter evidence", () => {
  const graph: WorldFindings = {
    summary: "A complete saved local graph.",
    genres: ["Fantasy"],
    atmosphere: [],
    themes: [],
    worldRules: [],
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
    chapterSummaries: [{
      sourceId: "book-one",
      sourceTitle: "Book One",
      chapterKey: "book-one:chapter-1",
      chapterTitle: "Chapter One",
      perspective: "Mara",
      sourceOrder: 0,
      summary: "Mara enters the eastern gate.",
      majorEvents: ["Mara enters the gate"],
      evidence: [{
        chunkId: "chapter-one",
        sourceId: "book-one",
        quote: "Mara entered the eastern gate.",
      }],
      confidence: 0.9,
      reviewStatus: "candidate",
    }],
    chronology: [],
    openQuestions: [],
    recurringTerms: [],
    characters: [{
      name: "Mara",
      aliases: [],
    } as CharacterFinding],
    entityRelations: [],
    entityRules: [],
    claims: [],
    cohesionProposals: [],
  };

  const restored = findingsFromBreakdown({ evidence_graph: graph });

  assert.equal(restored?.characters[0]?.name, "Mara");
  assert.equal(restored?.chapterSummaries[0]?.chapterKey, "book-one:chapter-1");
  assert.notEqual(restored, graph, "the database snapshot must be cloned before use");
});

test("Lorekeeper premium fingerprints pin ordered sources and owner guidance", () => {
  assert.equal(
    lorekeeperSnapshotFingerprint({ b: 2, a: { d: 4, c: 3 } }),
    lorekeeperSnapshotFingerprint({ a: { c: 3, d: 4 }, b: 2 }),
    "JSONB key ordering must not change a saved evidence receipt",
  );
  const sources = [{
    id: "source-a",
    contentHash: "hash-a",
    wordCount: 10,
    chunkCount: 2,
    chronologyOrder: 0,
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
  }, {
    id: "source-b",
    contentHash: "hash-b",
    wordCount: 20,
    chunkCount: 3,
    chronologyOrder: 1,
    sortOrder: 0,
    createdAt: "2026-01-02T00:00:00.000Z",
  }];
  const corpus = lorekeeperCorpusFingerprint(sources);
  assert.equal(
    corpus,
    lorekeeperCorpusFingerprint([...sources].reverse()),
    "query return order alone must not change the canonical reading order",
  );
  assert.notEqual(
    corpus,
    lorekeeperCorpusFingerprint([
      { ...sources[0]!, chronologyOrder: 2 },
      sources[1]!,
    ]),
    "changing book order must invalidate the premium receipt",
  );
  assert.notEqual(
    corpus,
    lorekeeperCorpusFingerprint([
      { ...sources[0]!, contentHash: "changed" },
      sources[1]!,
    ]),
  );
  const constraints = lorekeeperConstraintSnapshotFingerprint([
    { fingerprint: "owner-b" },
    { fingerprint: "owner-a" },
  ]);
  assert.equal(
    constraints,
    lorekeeperConstraintSnapshotFingerprint([
      { fingerprint: "owner-a" },
      { fingerprint: "owner-b" },
    ]),
  );
  assert.notEqual(
    constraints,
    lorekeeperConstraintSnapshotFingerprint([{ fingerprint: "owner-a" }]),
  );
});

test("premium evidence receipts fail closed on parent, corpus, or guidance drift", () => {
  const pin = {
    parentLocalRunId: "local-run",
    corpusFingerprint: "corpus-a",
    evidenceGraphFingerprint: "graph-a",
    constraintSnapshotFingerprint: "constraints-a",
    verificationContextFingerprint: "context-a",
    verificationPacketVersion: PREMIUM_VERIFICATION_PACKET_VERSION,
  };
  const parent = {
    id: "local-run",
    status: "completed",
    analysisKind: "local_scan",
    analysisVersion: LOCAL_ANALYSIS_VERSION,
    corpusFingerprint: "corpus-a",
    evidenceGraphFingerprint: "graph-a",
  };
  assert.equal(premiumEvidencePinError({
    expected: pin,
    parent,
    currentCorpusFingerprint: "corpus-a",
    currentConstraintSnapshotFingerprint: "constraints-a",
    currentVerificationContextFingerprint: "context-a",
  }), null);
  assert.match(premiumEvidencePinError({
    expected: pin,
    parent,
    currentCorpusFingerprint: "corpus-b",
    currentConstraintSnapshotFingerprint: "constraints-a",
    currentVerificationContextFingerprint: "context-a",
  }) ?? "", /manuscript set changed/i);
  assert.match(premiumEvidencePinError({
    expected: pin,
    parent,
    currentCorpusFingerprint: "corpus-a",
    currentConstraintSnapshotFingerprint: "constraints-b",
    currentVerificationContextFingerprint: "context-a",
  }) ?? "", /canon guidance changed/i);
  assert.match(premiumEvidencePinError({
    expected: pin,
    parent: { ...parent, evidenceGraphFingerprint: "graph-b" },
    currentCorpusFingerprint: "corpus-a",
    currentConstraintSnapshotFingerprint: "constraints-a",
    currentVerificationContextFingerprint: "context-a",
  }) ?? "", /evidence snapshot changed/i);
});

test("the generic world review action is always local-only", () => {
  assert.equal(generalWorldAnalysisKind(), "local_scan");
});

test("local intake never chains into paid AI without a new owner action", () => {
  const common = {
    completedKind: "local_scan" as const,
    runtimeConfigured: true,
    partialDueToCredits: false,
    completedSuccessfully: true,
  };
  assert.equal(
    nextAutomaticAnalysisKind({ ...common, trigger: "upload" }),
    null,
  );
  assert.equal(
    nextAutomaticAnalysisKind({ ...common, trigger: "manual" }),
    null,
  );
  assert.equal(
    nextAutomaticAnalysisKind({ ...common, trigger: "backfill" }),
    null,
  );
  assert.equal(
    nextAutomaticAnalysisKind({
      ...common,
      trigger: "upload",
      runtimeConfigured: false,
    }),
    null,
  );
  assert.equal(
    nextAutomaticAnalysisKind({
      ...common,
      trigger: "upload",
      completedSuccessfully: false,
    }),
    null,
  );
});

test("an owner-started partial AI review can continue without reopening local intake", () => {
  assert.equal(
    nextAutomaticAnalysisKind({
      completedKind: "ai_enrichment",
      trigger: "upload",
      runtimeConfigured: true,
      partialDueToCredits: true,
      completedSuccessfully: true,
    }),
    "ai_enrichment",
  );
  assert.equal(
    nextAutomaticAnalysisKind({
      completedKind: "ai_enrichment",
      trigger: "manual",
      runtimeConfigured: true,
      partialDueToCredits: false,
      completedSuccessfully: true,
    }),
    null,
  );
});

test("source page spans preserve empty pages and exact form-feed offsets", () => {
  assert.deepEqual(sourcePageSpans(["first", "", "third"]), [
    { pageIndex: 0, startOffset: 0, endOffset: 5, content: "first" },
    { pageIndex: 1, startOffset: 10, endOffset: 10, content: "" },
    { pageIndex: 2, startOffset: 15, endOffset: 20, content: "third" },
  ]);
});

test("a forced AI review rereads chunks that an incremental review skips", () => {
  assert.equal(
    shouldReviewAnalysisChunk({
      kind: "ai_enrichment",
      incremental: true,
      chunkIndex: 4,
      reviewedChunkCount: 5,
    }),
    false,
  );
  assert.equal(
    shouldReviewAnalysisChunk({
      kind: "ai_enrichment",
      incremental: false,
      chunkIndex: 4,
      reviewedChunkCount: 5,
    }),
    true,
  );
  assert.equal(
    shouldReviewAnalysisChunk({
      kind: "ai_enrichment",
      incremental: true,
      chunkIndex: 5,
      reviewedChunkCount: 5,
    }),
    true,
  );
  assert.equal(
    shouldReviewAnalysisChunk({
      kind: "ai_enrichment",
      incremental: true,
      chunkIndex: 1,
      reviewedChunkCount: 10,
      coverageAuthoritative: true,
      durablyCovered: false,
    }),
    true,
  );
  assert.equal(
    shouldReviewAnalysisChunk({
      kind: "ai_enrichment",
      incremental: true,
      chunkIndex: 99,
      reviewedChunkCount: 0,
      coverageAuthoritative: true,
      durablyCovered: true,
    }),
    false,
  );
});

test("incremental dossier profiles preserve prior source knowledge", () => {
  const merged = mergeDossierProfiles(
    {
      traits: ["Methodical"],
      history: ["Survived the fall of the Co-op"],
      knowledge: ["Knows the old access codes"],
      relationshipWeb: [
        {
          name: "Geela",
          relationship: "ally",
          summary: "They escaped together.",
          sentiment: "allied",
          evidence: [],
        },
      ],
      estimatedStats: {
        strength: { score: 15, confidence: 0.9, rationale: "Source supported" },
      },
    },
    {
      traits: ["Protective"],
      motivations: ["Reach Sanctuary"],
      knowledge: [],
      estimatedStats: {
        strength: { score: 10, confidence: 0.2, rationale: "Weak estimate" },
      },
    },
  );

  assert.deepEqual(merged.traits, ["Methodical", "Protective"]);
  assert.deepEqual(merged.history, ["Survived the fall of the Co-op"]);
  assert.deepEqual(merged.knowledge, ["Knows the old access codes"]);
  assert.deepEqual(merged.motivations, ["Reach Sanctuary"]);
  assert.equal(merged.relationshipWeb[0]?.name, "Geela");
  assert.equal(merged.estimatedStats.strength.score, 15);
});

test("coverage batches and finding counts preserve passage-level auditability", () => {
  const chunks = [
    { id: "chunk-a", sourceId: "source-a", sourceTitle: "One", index: 0, content: "a".repeat(30) },
    { id: "chunk-b", sourceId: "source-a", sourceTitle: "One", index: 1, content: "b".repeat(30) },
    { id: "chunk-c", sourceId: "source-b", sourceTitle: "Two", index: 0, content: "c".repeat(10) },
  ];
  assert.deepEqual(
    analysisChunkCoverageBatches(chunks, 50).map((batch) =>
      batch.map((chunk) => chunk.id),
    ),
    [["chunk-a"], ["chunk-b", "chunk-c"]],
  );

  const counts = findingCountsByChunk({
    characters: [
      {
        evidence: [
          { chunkId: "chunk-a", sourceId: "source-a", quote: "first" },
          { chunkId: "chunk-a", sourceId: "source-a", quote: "second" },
        ],
      },
    ],
  });
  assert.equal(counts.get("chunk-a"), 2);
  assert.equal(counts.get("chunk-b"), undefined);
});

test("credit-limited selection samples every chapter before deepening one", () => {
  const chunks = [
    { id: "one-a", sourceId: "book", sourceTitle: "Book", index: 0, content: "a", sectionKey: "one" },
    { id: "one-b", sourceId: "book", sourceTitle: "Book", index: 1, content: "b", sectionKey: "one" },
    { id: "two-a", sourceId: "book", sourceTitle: "Book", index: 2, content: "c", sectionKey: "two" },
    { id: "two-b", sourceId: "book", sourceTitle: "Book", index: 3, content: "d", sectionKey: "two" },
    { id: "three-a", sourceId: "book", sourceTitle: "Book", index: 4, content: "e", sectionKey: "three" },
  ];
  assert.deepEqual(
    breadthFirstAnalysisChunks(chunks).map((chunk) => chunk.id),
    ["one-a", "two-a", "three-a", "one-b", "two-b"],
  );
  assert.deepEqual(
    selectBreadthFirstAffordableChunks({
      chunks,
      availableCredits: 3,
      creditsForChunks: (selected) => selected.length,
    }).map((chunk) => chunk.id),
    ["one-a", "two-a", "three-a"],
  );
});

test("campaign character names stay distinct for same-name records", () => {
  const firstCharacterId = "00000000-0000-4000-8000-000000000001";
  const secondCharacterId = "00000000-0000-4000-8000-000000000002";

  assert.equal(
    campaignCharacterNormalizedName("  Alex Vale  ", firstCharacterId),
    `alex vale--campaign-character-${firstCharacterId}`,
  );
  assert.notEqual(
    campaignCharacterNormalizedName("Alex Vale", firstCharacterId),
    campaignCharacterNormalizedName("Alex Vale", secondCharacterId),
  );
});

test("startup clock backfill leaves structured triggers deadline-free", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.campaign_turns (
        campaign_id uuid NOT NULL,
        turn_number integer NOT NULL
      );
      CREATE TABLE storyhold.world_clock_events (
        id uuid PRIMARY KEY,
        campaign_id uuid NOT NULL,
        status text NOT NULL,
        event_kind text NOT NULL,
        due_world_time_minutes bigint,
        due_turn_number bigint,
        trigger_definition jsonb
      );
    `);
    const campaignId = "00000000-0000-4000-8000-000000000010";
    await db.query(
      "INSERT INTO storyhold.campaign_turns (campaign_id, turn_number) VALUES ($1, 4)",
      [campaignId],
    );
    await db.query(
      `INSERT INTO storyhold.world_clock_events
        (id, campaign_id, status, event_kind, due_world_time_minutes,
         due_turn_number, trigger_definition)
       VALUES
        ('00000000-0000-4000-8000-000000000011', $1, 'scheduled',
         'scheduled_effect', NULL, NULL, '{"kind":"proposition"}'::jsonb),
        ('00000000-0000-4000-8000-000000000012', $1, 'scheduled',
         'scheduled_effect', NULL, NULL, '{"kind":"all"}'::jsonb),
        ('00000000-0000-4000-8000-000000000013', $1, 'scheduled',
         'scheduled_effect', NULL, NULL, '{}'::jsonb),
        ('00000000-0000-4000-8000-000000000014', $1, 'scheduled',
         'scheduled_effect', NULL, 99, '{}'::jsonb)`,
      [campaignId],
    );

    await db.query(scheduledClockDeadlineBackfillSql);
    await db.query(scheduledClockDeadlineBackfillSql);

    const result = await db.query<{
      id: string;
      due_turn_number: number | null;
    }>(
      `SELECT id, due_turn_number
         FROM storyhold.world_clock_events
        ORDER BY id`,
    );
    assert.deepEqual(
      result.rows.map((row) => [row.id, row.due_turn_number]),
      [
        ["00000000-0000-4000-8000-000000000011", null],
        ["00000000-0000-4000-8000-000000000012", null],
        ["00000000-0000-4000-8000-000000000013", 5],
        ["00000000-0000-4000-8000-000000000014", 99],
      ],
    );
  } finally {
    await db.close();
  }
});

const KNOWN_FAILURE_PLAYER_ID = "00000000-0000-4000-8000-000000000701";
const KNOWN_FAILURE_WORLD_ID = "00000000-0000-4000-8000-000000000702";
const KNOWN_FAILURE_RUN_ID = "00000000-0000-4000-8000-000000000703";

async function createKnownPremiumFailureFixture(
  rejectUsageReceipt = false,
  playerCredits = 100,
) {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.players (
      id uuid PRIMARY KEY,
      role text NOT NULL,
      credits integer NOT NULL CHECK (credits >= 0),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE storyhold.worlds (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.campaigns (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.ai_usage_ledger (
      id uuid PRIMARY KEY,
      player_id uuid NOT NULL,
      world_id uuid NOT NULL,
      campaign_id uuid,
      operation text NOT NULL ${rejectUsageReceipt ? "CHECK (operation <> 'world_analysis_rejected_output')" : ""},
      provider text NOT NULL,
      model text NOT NULL,
      input_units integer NOT NULL,
      output_units integer NOT NULL,
      cost_micros bigint NOT NULL,
      cache_hit boolean NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE storyhold.world_analysis_runs (
      id uuid PRIMARY KEY,
      world_id uuid NOT NULL,
      requested_by_player_id uuid NOT NULL,
      analysis_kind text NOT NULL,
      status text NOT NULL,
      stage text NOT NULL,
      error text,
      premium_resume_status text NOT NULL,
      premium_ai_credits_charged integer NOT NULL DEFAULT 0,
      pause_requested boolean NOT NULL DEFAULT false,
      paused_at timestamptz,
      completed_at timestamptz
    );
  `);
  await db.exec(creditEconomySchemaSql);
  await db.query(
    "INSERT INTO storyhold.players (id, role, credits) VALUES ($1, 'player', $2)",
    [KNOWN_FAILURE_PLAYER_ID, playerCredits],
  );
  await db.query("INSERT INTO storyhold.worlds (id) VALUES ($1)", [KNOWN_FAILURE_WORLD_ID]);
  await db.query(
    `INSERT INTO storyhold.world_analysis_runs
      (id, world_id, requested_by_player_id, analysis_kind, status, stage,
       premium_resume_status, pause_requested, paused_at)
     VALUES ($1, $2, $3, 'ai_enrichment', 'running', 'verifying evidence',
             'ready', true, now())`,
    [KNOWN_FAILURE_RUN_ID, KNOWN_FAILURE_WORLD_ID, KNOWN_FAILURE_PLAYER_ID],
  );
  const reservation = await reserveCredits(db, {
    playerId: KNOWN_FAILURE_PLAYER_ID,
    worldId: KNOWN_FAILURE_WORLD_ID,
    operation: "world_analysis",
    requestId: KNOWN_FAILURE_RUN_ID,
    requiredCredits: 10,
    metadata: { retainUntilReconciled: true },
  });
  assert.ok(reservation.id);
  return { db, reservationId: reservation.id };
}

const knownRejectedUsage = {
  usage: {
    inputUnits: 100,
    outputUnits: 20,
    cachedInputUnits: 10,
    cacheWriteInputUnits: 0,
    reasoningUnits: 5,
    estimatedCostMicros: 12_000,
    pricingKnown: true,
    pricingVersion: "test-known-pricing:v1",
    costEstimated: false,
  },
  provider: "test-provider",
  model: "test-model",
  attemptCount: 1,
};

test("known premium failure atomically settles usage and terminalizes its run", async () => {
  const { db, reservationId } = await createKnownPremiumFailureFixture();
  try {
    const settlement = await finalizeKnownPremiumFailureAtomically(db, {
      runId: KNOWN_FAILURE_RUN_ID,
      worldId: KNOWN_FAILURE_WORLD_ID,
      playerId: KNOWN_FAILURE_PLAYER_ID,
      reservationId,
      failureMessage: "The provider returned a billable response that failed verification.",
      failedUsage: knownRejectedUsage,
    });
    assert.equal(settlement.creditsUsed, 1);
    assert.equal(settlement.uncoveredCredits, 0);

    const run = (await db.query<Record<string, unknown>>(
      "SELECT * FROM storyhold.world_analysis_runs WHERE id = $1",
      [KNOWN_FAILURE_RUN_ID],
    )).rows[0]!;
    assert.equal(run.status, "failed");
    assert.equal(run.premium_resume_status, "not_available");
    assert.equal(run.premium_ai_credits_charged, 1);
    assert.equal(run.pause_requested, false);
    assert.equal(run.paused_at, null);
    assert.ok(run.completed_at);
    assert.equal(run.stage, "Premium Deep Reading stopped; verified usage saved");

    const hold = (await db.query<Record<string, unknown>>(
      "SELECT * FROM storyhold.credit_reservations WHERE id = $1",
      [reservationId],
    )).rows[0]!;
    assert.equal(hold.status, "settled");
    assert.equal(hold.actual_credits, 1);
    assert.equal(
      (await db.query<{ credits: number }>(
        "SELECT credits FROM storyhold.players WHERE id = $1",
        [KNOWN_FAILURE_PLAYER_ID],
      )).rows[0]?.credits,
      99,
    );
    assert.equal(
      (await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM storyhold.credit_ledger WHERE reservation_id = $1",
        [reservationId],
      )).rows[0]?.count,
      2,
    );
    const usageReceipt = (await db.query<Record<string, unknown>>(
      "SELECT * FROM storyhold.ai_usage_ledger WHERE request_id = $1",
      [KNOWN_FAILURE_RUN_ID],
    )).rows[0]!;
    assert.equal(usageReceipt.operation, "world_analysis_rejected_output");
    assert.equal(usageReceipt.credits_charged, 1);
    assert.deepEqual(usageReceipt.metadata, {
      canonPromoted: false,
      attemptCount: 1,
      pricingKnown: true,
      failure: "The provider returned a billable response that failed verification.",
      failureSettlementVersion: 1,
      runTerminalizedAtomically: true,
    });
  } finally {
    await db.close();
  }
});

test("known premium failure rolls back settlement and terminalization when its usage receipt cannot commit", async () => {
  const { db, reservationId } = await createKnownPremiumFailureFixture(true);
  try {
    await assert.rejects(finalizeKnownPremiumFailureAtomically(db, {
      runId: KNOWN_FAILURE_RUN_ID,
      worldId: KNOWN_FAILURE_WORLD_ID,
      playerId: KNOWN_FAILURE_PLAYER_ID,
      reservationId,
      failureMessage: "Rejected output",
      failedUsage: knownRejectedUsage,
    }));

    const run = (await db.query<Record<string, unknown>>(
      "SELECT * FROM storyhold.world_analysis_runs WHERE id = $1",
      [KNOWN_FAILURE_RUN_ID],
    )).rows[0]!;
    assert.equal(run.status, "running");
    assert.equal(run.stage, "verifying evidence");
    assert.equal(run.premium_resume_status, "ready");
    assert.equal(run.premium_ai_credits_charged, 0);
    assert.equal(run.pause_requested, true);
    assert.ok(run.paused_at);
    assert.equal(run.completed_at, null);

    const hold = (await db.query<Record<string, unknown>>(
      "SELECT * FROM storyhold.credit_reservations WHERE id = $1",
      [reservationId],
    )).rows[0]!;
    assert.equal(hold.status, "reserved");
    assert.equal(hold.actual_credits, null);
    assert.equal(
      (await db.query<{ credits: number }>(
        "SELECT credits FROM storyhold.players WHERE id = $1",
        [KNOWN_FAILURE_PLAYER_ID],
      )).rows[0]?.credits,
      90,
    );
    assert.equal(
      (await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM storyhold.credit_ledger WHERE reservation_id = $1",
        [reservationId],
      )).rows[0]?.count,
      1,
    );
    assert.equal(
      (await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM storyhold.ai_usage_ledger WHERE request_id = $1",
        [KNOWN_FAILURE_RUN_ID],
      )).rows[0]?.count,
      0,
    );
  } finally {
    await db.close();
  }
});

test("known premium failure charges a funded overage beyond its original estimate", async () => {
  const { db, reservationId } = await createKnownPremiumFailureFixture();
  try {
    const overHoldUsage = {
      ...knownRejectedUsage,
      usage: {
        ...knownRejectedUsage.usage,
        estimatedCostMicros: 132_000,
      },
    };
    const settlement = await finalizeKnownPremiumFailureAtomically(db, {
      runId: KNOWN_FAILURE_RUN_ID,
      worldId: KNOWN_FAILURE_WORLD_ID,
      playerId: KNOWN_FAILURE_PLAYER_ID,
      reservationId,
      failureMessage: "Rejected output exceeded its original estimate",
      failedUsage: overHoldUsage,
    });
    assert.deepEqual(settlement, {
      creditsUsed: 11,
      creditsRemaining: 89,
      uncoveredCredits: 0,
    });

    const run = (await db.query<Record<string, unknown>>(
      "SELECT * FROM storyhold.world_analysis_runs WHERE id = $1",
      [KNOWN_FAILURE_RUN_ID],
    )).rows[0]!;
    assert.equal(run.status, "failed");
    assert.equal(run.stage, "Premium Deep Reading stopped; verified usage saved");
    assert.equal(run.premium_resume_status, "not_available");
    assert.equal(run.premium_ai_credits_charged, 11);
    assert.equal(run.pause_requested, false);
    assert.equal(run.paused_at, null);
    assert.ok(run.completed_at);

    const hold = (await db.query<Record<string, unknown>>(
      "SELECT * FROM storyhold.credit_reservations WHERE id = $1",
      [reservationId],
    )).rows[0]!;
    assert.equal(hold.status, "settled");
    assert.equal(hold.actual_credits, 11);
    assert.equal(
      (await db.query<{ credits: number }>(
        "SELECT credits FROM storyhold.players WHERE id = $1",
        [KNOWN_FAILURE_PLAYER_ID],
      )).rows[0]?.credits,
      89,
    );
    assert.equal(
      (await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM storyhold.credit_ledger WHERE reservation_id = $1",
        [reservationId],
      )).rows[0]?.count,
      2,
    );
    assert.equal(
      (await db.query<{ credits_charged: number }>(
        "SELECT credits_charged FROM storyhold.ai_usage_ledger WHERE request_id = $1",
        [KNOWN_FAILURE_RUN_ID],
      )).rows[0]?.credits_charged,
      11,
    );
  } finally {
    await db.close();
  }
});

test("known premium failure preserves its original hold when an overage cannot be funded", async () => {
  const { db, reservationId } = await createKnownPremiumFailureFixture(false, 10);
  try {
    const overHoldUsage = {
      ...knownRejectedUsage,
      usage: { ...knownRejectedUsage.usage, estimatedCostMicros: 132_000 },
    };
    await assert.rejects(
      finalizeKnownPremiumFailureAtomically(db, {
        runId: KNOWN_FAILURE_RUN_ID,
        worldId: KNOWN_FAILURE_WORLD_ID,
        playerId: KNOWN_FAILURE_PLAYER_ID,
        reservationId,
        failureMessage: "Rejected output exceeded the funded estimate",
        failedUsage: overHoldUsage,
      }),
      (error: unknown) => error instanceof CreditEconomyError &&
        error.code === "INSUFFICIENT_CREDITS" && error.requiredCredits === 11 &&
        error.availableCredits === 10,
    );

    const run = (await db.query<Record<string, unknown>>(
      "SELECT * FROM storyhold.world_analysis_runs WHERE id = $1",
      [KNOWN_FAILURE_RUN_ID],
    )).rows[0]!;
    assert.equal(run.status, "running");
    assert.equal(run.premium_ai_credits_charged, 0);
    const hold = (await db.query<Record<string, unknown>>(
      "SELECT * FROM storyhold.credit_reservations WHERE id = $1",
      [reservationId],
    )).rows[0]!;
    assert.equal(hold.status, "reserved");
    assert.equal(hold.actual_credits, null);
    assert.equal((await db.query("SELECT id FROM storyhold.ai_usage_ledger")).rows.length, 0);

    assert.equal(await pausePremiumReviewForTopUp(db, {
      runId: KNOWN_FAILURE_RUN_ID,
      worldId: KNOWN_FAILURE_WORLD_ID,
      playerId: KNOWN_FAILURE_PLAYER_ID,
      privateError: "Rejected provider response; exact usage is saved.",
    }), true);
    const paused = (await db.query<Record<string, unknown>>(
      "SELECT * FROM storyhold.world_analysis_runs WHERE id = $1",
      [KNOWN_FAILURE_RUN_ID],
    )).rows[0]!;
    assert.equal(paused.status, "paused");
    assert.equal(paused.premium_resume_status, "ready");
    assert.equal(paused.stage, "Premium Deep Reading Saved — Add Credits to Finish");

    // A one-credit top-up settles the exact saved usage. No new provider work
    // is involved in this recovery path and all receipts commit once.
    await db.query("UPDATE storyhold.players SET credits = 1 WHERE id = $1", [KNOWN_FAILURE_PLAYER_ID]);
    const settled = await finalizeKnownPremiumFailureAtomically(db, {
      runId: KNOWN_FAILURE_RUN_ID,
      worldId: KNOWN_FAILURE_WORLD_ID,
      playerId: KNOWN_FAILURE_PLAYER_ID,
      reservationId,
      failureMessage: "Rejected output exceeded the funded estimate",
      failedUsage: overHoldUsage,
    });
    assert.deepEqual(settled, { creditsUsed: 11, creditsRemaining: 0, uncoveredCredits: 0 });
    assert.equal((await db.query("SELECT id FROM storyhold.ai_usage_ledger WHERE request_id = $1", [KNOWN_FAILURE_RUN_ID])).rows.length, 1);
    assert.equal((await db.query("SELECT id FROM storyhold.credit_ledger WHERE reservation_id = $1", [reservationId])).rows.length, 2);
  } finally {
    await db.close();
  }
});

test("saved successful premium world output waits for top-up, then projects and settles exactly once", async () => {
  const { db, reservationId } = await createKnownPremiumFailureFixture(false, 10);
  let providerInvocations = 0;
  try {
    await db.exec(premiumReviewJournalSchemaSql);
    await db.exec(`CREATE TABLE storyhold.test_canon_projection (
      run_id uuid PRIMARY KEY,
      summary text NOT NULL
    );`);
    const request = {
      task: "canon_review",
      stage: "verification",
      system: "Verify the supplied canon evidence.",
      messages: [{ role: "user", content: "Mara guards the gate." }],
      reasoning: "high",
      maxOutputTokens: 1000,
      temperature: 0,
      allowProviderFallback: false,
      providerFailurePolicy: "stop",
    } as never;
    const invoke = async () => {
      providerInvocations += 1;
      return {
        text: '{"verified":true}',
        provider: "test-provider",
        model: "test-model",
        reasoning: "high",
        usage: { ...knownRejectedUsage.usage, estimatedCostMicros: 132_000 },
        priorBillableAttempts: [],
        runtime: {
          configured: true,
          mode: "connected",
          provider: "test-provider",
          model: "test-model",
          billable: true,
          sendsSourceTextOffDevice: true,
          explanation: "test",
          stage: "verification",
          execution: { resolvedModel: "test-model", upstreamProvider: null },
          localExtraction: {}, providers: [], routing: {}, stageRouting: {},
        },
      } as never;
    };
    await executeJournaledPremiumCall(db, {
      runId: KNOWN_FAILURE_RUN_ID,
      stepKey: "verification:0",
      request,
      provider: "test-provider",
      model: "test-model",
      reservationId,
      invoke,
    });
    assert.equal(providerInvocations, 1);

    const projectSavedResult = async () => {
      const saved = await executeJournaledPremiumCall(db, {
        runId: KNOWN_FAILURE_RUN_ID,
        stepKey: "verification:0",
        request,
        provider: "test-provider",
        model: "test-model",
        reservationId,
        invoke,
      });
      return db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO storyhold.test_canon_projection (run_id, summary)
           VALUES ($1, 'Verified world') ON CONFLICT (run_id) DO NOTHING`,
          [KNOWN_FAILURE_RUN_ID],
        );
        return settlePremiumWorldReservationInTransaction(tx, {
          reservationId,
          usage: saved.usage,
          provider: saved.provider,
          model: saved.model,
        });
      });
    };

    await assert.rejects(projectSavedResult(), (error: unknown) =>
      error instanceof CreditEconomyError && error.code === "INSUFFICIENT_CREDITS");
    assert.equal(providerInvocations, 1, "the saved response was reused during failed settlement");
    assert.equal((await db.query("SELECT run_id FROM storyhold.test_canon_projection")).rows.length, 0,
      "canon rolls back with an unfunded actual total");

    await pausePremiumReviewForTopUp(db, {
      runId: KNOWN_FAILURE_RUN_ID,
      worldId: KNOWN_FAILURE_WORLD_ID,
      playerId: KNOWN_FAILURE_PLAYER_ID,
    });
    await db.query("UPDATE storyhold.players SET credits = 1 WHERE id = $1", [KNOWN_FAILURE_PLAYER_ID]);
    const settled = await projectSavedResult();
    assert.deepEqual(settled, { creditsUsed: 11, creditsRemaining: 0, uncoveredCredits: 0 });
    assert.equal(providerInvocations, 1, "top-up recovery never invokes the provider again");
    assert.equal((await db.query("SELECT run_id FROM storyhold.test_canon_projection")).rows.length, 1);
    assert.equal((await db.query("SELECT id FROM storyhold.credit_ledger WHERE reservation_id = $1", [reservationId])).rows.length, 2);

    assert.deepEqual(await projectSavedResult(), settled);
    assert.equal(providerInvocations, 1);
    assert.equal((await db.query("SELECT run_id FROM storyhold.test_canon_projection")).rows.length, 1);
    assert.equal((await db.query("SELECT id FROM storyhold.credit_ledger WHERE reservation_id = $1", [reservationId])).rows.length, 2,
      "settlement replay is idempotent");
  } finally {
    await db.close();
  }
});

test("known rejected premium output is a self-service top-up recovery without redispatch", async () => {
  const { db, reservationId } = await createKnownPremiumFailureFixture(false, 10);
  let providerInvocations = 0;
  try {
    await db.exec(premiumReviewJournalSchemaSql);
    const usage = { ...knownRejectedUsage.usage, estimatedCostMicros: 132_000 };
    const attempt = {
      provider: "test-provider",
      model: "test-model",
      resolvedModel: "test-model",
      upstreamProvider: null,
      stage: "verification",
      reasoning: "high",
      usage,
    } as const;
    await assert.rejects(executeJournaledPremiumCall(db, {
      runId: KNOWN_FAILURE_RUN_ID,
      stepKey: "verification:0",
      request: {
        task: "canon_review", stage: "verification", system: "Verify evidence.",
        messages: [{ role: "user", content: "Evidence" }], reasoning: "high",
        maxOutputTokens: 1000, temperature: 0, allowProviderFallback: false,
        providerFailurePolicy: "stop",
      },
      provider: "test-provider",
      model: "test-model",
      reservationId,
      invoke: async () => {
        providerInvocations += 1;
        throw new AiGatewayUnavailableError(
          "The response did not pass evidence validation.",
          ["rejected"],
          [attempt],
          false,
        );
      },
    }), /evidence validation/iu);
    assert.equal(providerInvocations, 1);
    await pausePremiumReviewForTopUp(db, {
      runId: KNOWN_FAILURE_RUN_ID,
      worldId: KNOWN_FAILURE_WORLD_ID,
      playerId: KNOWN_FAILURE_PLAYER_ID,
    });
    const scope = {
      runId: KNOWN_FAILURE_RUN_ID,
      worldId: KNOWN_FAILURE_WORLD_ID,
      editionId: "00000000-0000-4000-8000-000000000704",
      playerId: KNOWN_FAILURE_PLAYER_ID,
    };
    assert.deepEqual(await recoverKnownRejectedPremiumReview(db, scope), {
      status: "needs_top_up",
      topUpCreditsNeeded: 1,
    });
    await db.query("UPDATE storyhold.players SET credits = 1 WHERE id = $1", [KNOWN_FAILURE_PLAYER_ID]);
    assert.deepEqual(await recoverKnownRejectedPremiumReview(db, scope), {
      status: "settled",
      creditsUsed: 11,
      creditsRemaining: 0,
    });
    assert.equal(providerInvocations, 1);
    assert.equal((await db.query("SELECT id FROM storyhold.ai_usage_ledger WHERE request_id = $1", [KNOWN_FAILURE_RUN_ID])).rows.length, 1);
    assert.equal((await db.query("SELECT id FROM storyhold.credit_ledger WHERE reservation_id = $1", [reservationId])).rows.length, 2);
  } finally {
    await db.close();
  }
});

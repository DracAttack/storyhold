import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { getAiRuntimeStatus, type AiTextResult } from "./aiGateway";
import { buildEntityGraphRequest } from "./entityGraphVerification";
import { buildEntityProseRequest } from "./entityProseVerification";
import { buildExistingProseInventory, prepareEntityExistingProsePages } from "./entityExistingProseReview";
import { ensureEntityReviewClaimLinks } from "./entityProseJournal";
import { premiumEntityReviewPages, reviewEntityFromSavedResult, type EntityReviewInput } from "./entityReview";
import { ensureEntityReviewGraphLinks, ensureEntityReviewJournal, executeJournaledEntityReviewPages,
  readEntityReviewCall, saveEntityReviewVerificationBundle, type EntityReviewCallScope } from "./entityReviewJournal";
import { ensureEntityStatJournal } from "./entityStatJournal";
import { settleEntityReviewAccountingInTransaction } from "./entityReviewAccounting";
import { finishJournaledEntityReview } from "./entityReviewExecution";
import { buildEntityStatRequests } from "./entityStatVerification";
import { ensurePremiumGraphJournal } from "./premiumGraphJournal";
import { ensurePremiumClaimJournal } from "./premiumClaimJournal";
import { premiumNeutralStats } from "./premiumStatCandidates";
import { ensurePremiumStatJournal } from "./premiumStatJournal";
import { saveEntityReview, serializeDossier } from "./worldStudio";
import type { CharacterFinding } from "./worldAnalysis";

const uuid = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const WORLD = uuid(1201), EDITION = uuid(1202), ENTITY = uuid(1203), REVIEW = uuid(1204), DOSSIER = uuid(1205);
const CHUNK = uuid(1206), SOURCE = uuid(1207), FACTION = uuid(1208), PLAYER = uuid(1209);
const STAT_QUOTE = "Mira held the heavy beam until her companions escaped.";
const GRAPH_QUOTE = "Mira joined the Ash Guild. Mira can glow when she sings, casting blue light.";
const TEXT = `${STAT_QUOTE} ${GRAPH_QUOTE}`;
const statEvidence = [{ chunkId: CHUNK, sourceId: SOURCE, quote: STAT_QUOTE }];
const graphEvidence = [{ chunkId: CHUNK, sourceId: SOURCE, quote: GRAPH_QUOTE }];
const scope: EntityReviewCallScope = { reviewId: REVIEW, playerId: PLAYER, worldId: WORLD, editionId: EDITION, entityId: ENTITY };
type SaveArgs = Parameters<typeof saveEntityReview>[0];

function character(): CharacterFinding {
  return { name: "Mira", aliases: [], role: "Scout", summary: "Mira refuses to abandon her companions.",
    traits: ["Loyal"], motivations: [], fears: [], capabilities: [], history: [], origins: [], powers: [], moralSystem: [],
    physicalCharacteristics: [], relationships: [], relationshipWeb: [], estimatedStats: premiumNeutralStats(),
    socioPoliticalAxis: { economic: 0, authority: 0, label: "Undetermined", rationale: "", confidence: 0 },
    knowledge: [], secrets: [], factionMemberships: [], evidence: statEvidence, confidence: 0.8 };
}
function input(): EntityReviewInput {
  return { worldName: "The Ash Guild", worldPremise: "An expedition", worldGenre: "Fantasy", depth: "full",
    premiumStatScope: { worldId: WORLD, editionId: EDITION, analysisRunId: REVIEW },
    entity: { id: ENTITY, name: "Mira", entityType: "character", aliases: [], summary: "An established scout.", details: [], relationships: [] },
    currentCharacter: character(), ownerCanonConstraints: [{ id: uuid(1210), kind: "identity", instruction: "Mira and the Ash Guild are separate identities." }],
    chunks: [{ id: CHUNK, sourceId: SOURCE, content: TEXT, sourceTitle: "Chapter One", index: 0 }],
    knownEntities: [{ name: "Mira", entityType: "character", aliases: [] }, { name: "Ash Guild", entityType: "faction", aliases: [] }],
    graphReview: { version: 2,
      entities: [{ id: ENTITY, name: "Mira", entityType: "character", aliases: [] }, { id: FACTION, name: "Ash Guild", entityType: "faction", aliases: [] }],
      relations: Array.from({ length: 13 }, (_, index) => ({ subject: "Mira", relationType: "member_of", target: "Ash Guild",
        status: "active", summary: "Mira is a guild member.", validFromLabel: index ? `Period ${index}` : "", validUntilLabel: "",
        evidence: graphEvidence, confidence: 0.9 })),
      rules: [{ entity: "Mira", name: "Singing Glow", description: "Mira glows when she sings.", ruleKind: "ability",
        trigger: "Mira sings", effect: "Blue light", evidence: graphEvidence, confidence: 0.9 }],
    },
  };
}

async function database() {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.worlds (id uuid PRIMARY KEY, updated_at timestamptz DEFAULT now());
    CREATE TABLE storyhold.world_analysis_runs (id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
      analysis_kind text DEFAULT 'ai_enrichment');
    CREATE TABLE storyhold.character_dossiers (id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
      canonical_character_id uuid, normalized_name text, name text, aliases jsonb DEFAULT '[]', role text DEFAULT '', summary text DEFAULT '',
      profile jsonb DEFAULT '{}', evidence jsonb DEFAULT '[]', confidence real DEFAULT 0.5, axis_estimate jsonb DEFAULT '{}',
      mention_count integer DEFAULT 0, mention_source_count integer DEFAULT 0, user_edited_at timestamptz,
      dossier_status text DEFAULT 'active', updated_at timestamptz DEFAULT now());
    CREATE TABLE storyhold.world_entities (id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
      dossier_id uuid REFERENCES storyhold.character_dossiers(id), canonical_key text DEFAULT 'mira', normalized_name text NOT NULL,
      name text NOT NULL, entity_type text NOT NULL, aliases jsonb DEFAULT '[]', summary text DEFAULT '', details jsonb DEFAULT '[]',
      relationships jsonb DEFAULT '[]', evidence jsonb DEFAULT '[]', mention_count integer DEFAULT 0, mention_source_count integer DEFAULT 0,
      confidence real DEFAULT 0.5, classification_source text DEFAULT 'local', review_status text DEFAULT 'candidate', estimated_stats jsonb DEFAULT '{}',
      pull_status text DEFAULT 'active', scanner_present boolean DEFAULT true, merged_into_entity_id uuid, updated_at timestamptz DEFAULT now());
    CREATE TABLE storyhold.world_sources (id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
      processing_status text DEFAULT 'ready', canon_status text DEFAULT 'canon');
    CREATE TABLE storyhold.world_source_chunks (id uuid PRIMARY KEY, source_id uuid NOT NULL, world_id uuid NOT NULL,
      canon_edition_id uuid NOT NULL, content text NOT NULL);
    CREATE TABLE storyhold.world_entity_relations (id uuid PRIMARY KEY, world_id uuid, canon_edition_id uuid, source_entity_id uuid,
      relation_type text, target_entity_id uuid, relation_status text, summary text, valid_from_label text, valid_until_label text,
      evidence jsonb, assignment_source text, confidence real, updated_at timestamptz DEFAULT now(),
      UNIQUE(world_id,canon_edition_id,source_entity_id,relation_type,target_entity_id,relation_status,valid_from_label,valid_until_label));
    CREATE TABLE storyhold.world_entity_rules (id uuid PRIMARY KEY, world_id uuid, canon_edition_id uuid, entity_id uuid, canonical_key text,
      name text, description text DEFAULT '', rule_kind text, trigger_text text DEFAULT '', effect_text text DEFAULT '', evidence jsonb DEFAULT '[]',
      assignment_source text DEFAULT 'local', confidence real DEFAULT 0.5, rule_status text DEFAULT 'active', updated_at timestamptz DEFAULT now(),
      UNIQUE(world_id,canon_edition_id,entity_id,canonical_key));
    CREATE TABLE storyhold.world_entity_faction_memberships (entity_id uuid, faction_entity_id uuid, assignment_source text,
      confidence real, evidence jsonb, updated_at timestamptz DEFAULT now(), PRIMARY KEY(entity_id,faction_entity_id));
    CREATE TABLE storyhold.players (id uuid PRIMARY KEY, role text DEFAULT 'admin', credits integer DEFAULT 100);
    CREATE TABLE storyhold.credit_reservations (id uuid PRIMARY KEY, operation text, request_id text);
    CREATE TABLE storyhold.ai_usage_ledger (id uuid PRIMARY KEY, player_id uuid, world_id uuid, campaign_id uuid, operation text,
      provider text, model text, input_units integer, output_units integer, cached_input_units integer, cache_write_input_units integer,
      reasoning_units integer, cost_micros bigint, cache_hit boolean, pricing_version text, credits_charged integer,
      request_id text, metadata jsonb);
    CREATE TABLE storyhold.world_knowledge_claims(id uuid PRIMARY KEY,world_id uuid,canon_edition_id uuid,
      source_analysis_run_id uuid REFERENCES storyhold.world_analysis_runs(id),supersedes_claim_id uuid,
      fingerprint text,subject_entity_id uuid,predicate text,polarity text DEFAULT 'positive',object_entity_id uuid,object_text text,
      epistemic_holder_entity_id uuid,truth_status text,valid_from_label text DEFAULT '',valid_until_label text DEFAULT '',summary text DEFAULT '',
      evidence jsonb DEFAULT '[]',confidence real DEFAULT 0,claim_status text DEFAULT 'active',assignment_source text DEFAULT 'ai',
      created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),UNIQUE(world_id,canon_edition_id,fingerprint));`);
  await ensureEntityStatJournal(db); await ensurePremiumStatJournal(db);
  await ensureEntityReviewJournal(db); await ensurePremiumGraphJournal(db); await ensureEntityReviewGraphLinks(db);
  await ensurePremiumClaimJournal(db); await ensureEntityReviewClaimLinks(db);
  await db.query("INSERT INTO storyhold.worlds (id) VALUES ($1)", [WORLD]);
  await db.query("INSERT INTO storyhold.players(id) VALUES ($1)", [PLAYER]);
  await db.query("INSERT INTO storyhold.character_dossiers(id,world_id,canon_edition_id,name,normalized_name,profile) VALUES($1,$2,$3,'Mira','mira',$4::jsonb)",
    [DOSSIER, WORLD, EDITION, JSON.stringify(character())]);
  await db.query(`INSERT INTO storyhold.world_entities(id,world_id,canon_edition_id,dossier_id,name,normalized_name,entity_type) VALUES
    ($1,$3,$4,$5,'Mira','mira','character'),($2,$3,$4,NULL,'Ash Guild','ash guild','faction')`, [ENTITY, FACTION, WORLD, EDITION, DOSSIER]);
  await db.query("INSERT INTO storyhold.world_sources(id,world_id,canon_edition_id) VALUES($1,$2,$3)", [SOURCE, WORLD, EDITION]);
  await db.query("INSERT INTO storyhold.world_source_chunks(id,source_id,world_id,canon_edition_id,content) VALUES($1,$2,$3,$4,$5)",
    [CHUNK, SOURCE, WORLD, EDITION, TEXT]);
  return db;
}

test("complete v2 dossier pages save through the root path with same-review stats, graph proofs and atomic replay", async () => {
  const db = await database(); const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("No live network is permitted in this persistence fixture."); };
  try {
    const reviewInput = input();
    const pages = premiumEntityReviewPages(reviewInput);
    assert.equal(pages.length, 2);
    const results: AiTextResult[] = pages.map((page, index) => {
      const graph = buildEntityGraphRequest(page.input)!;
      const raw = { relations: [], rules: [], entityRelations: [], entityRules: [], graphVerification: {
        requestFingerprint: graph.fingerprint, newFindings: [], decisions: graph.proposals.map((proposal) => ({
          proposalId: proposal.id, verdict: "verified", explanation: "The supplied passage supports this.", confidence: 0.9,
          supportingEvidence: [{ chunkId: CHUNK, quote: GRAPH_QUOTE }], contradictingEvidence: [], retrievalRequests: [],
        })),
      }, ...(index === 0 ? {
        aliases: [], summary: "Mira protects her companions by holding the heavy beam.", details: [], relationships: [],
        evidence: statEvidence, confidence: 0.9, estimatedStats: null, character: { ...character(), estimatedStats: null },
        statVerifications: buildEntityStatRequests(page.input).map((request, group) => ({ requestFingerprint: request.fingerprint,
          decisions: [], newStats: group === 0 ? [{ payload: { family: "characters", entity: "Mira", stat: "strength", score: 16,
            rationale: "Held the heavy beam while her companions escaped." }, verdict: "verified", explanation: "The passage states the lifting action.",
          confidence: 0.8, supportingEvidence: [{ chunkId: CHUNK, quote: STAT_QUOTE }], contradictingEvidence: [], retrievalRequests: [] }] : [],
        })),
      } : {}) };
      page.request.validate?.(JSON.stringify(raw));
      const model = `offline-page-${index}`;
      return { text: JSON.stringify(raw), provider: "openrouter", model, reasoning: "high",
        usage: { inputUnits: 100, outputUnits: 50, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 0,
          estimatedCostMicros: 100, pricingKnown: true, pricingVersion: "fixture", costEstimated: false },
        runtime: { ...getAiRuntimeStatus("canon_review", "standard", "dossier"), provider: "openrouter", model,
          execution: { connectionId: "managed:openrouter", credentialSource: "environment", connectionSource: "storyhold_managed",
            billingSource: "storyhold_credits", requestedModel: model, resolvedModel: model, upstreamProvider: "fixture", privacyMode: "zero-data-retention" } },
      };
    });
    const context: SaveArgs["context"] = { input: reviewInput,
      entityRow: (await db.query<Record<string, unknown>>("SELECT * FROM storyhold.world_entities WHERE id=$1", [ENTITY])).rows[0]!,
      mentionCount: 1, mentionSourceCount: 1, selectedPassages: [], entityIdsByName: new Map([["mira", ENTITY], ["ash guild", FACTION]]) };
    let invokes = 0;
    const savedResult = await executeJournaledEntityReviewPages(db, { scope, reservationId: null,
      contextSnapshot: JSON.parse(JSON.stringify({ version: 1, input: reviewInput })),
      pages: pages.map((page, index) => ({ stepKey: page.stepKey, request: page.request, provider: results[index]!.provider, model: results[index]!.model })),
      invoke: async (_, index) => { invokes += 1; return results[index]!; },
    });
    const reviewed = reviewEntityFromSavedResult(reviewInput, savedResult);
    assert.equal(reviewed.graphReviews!.length, 2); assert.equal(reviewed.statReviews.length, 2);
    assert.equal(reviewed.finding.relations.length, 13); assert.equal(reviewed.finding.rules.length, 1);
    const apply = () => db.transaction(async (tx) => {
      await saveEntityReviewVerificationBundle(tx, scope, { version: 2, graphs: reviewed.graphReviews! });
      return saveEntityReview({ db: tx as unknown as SaveArgs["db"], worldId: WORLD, editionId: EDITION, context,
        finding: reviewed.finding, reviewMode: "premium", statReviews: reviewed.statReviews, graphReviews: reviewed.graphReviews, graphScope: scope });
    });
    await db.exec(`CREATE FUNCTION storyhold.fail_paged_dossier_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Late paged dossier failure'; END; $$;
      CREATE TRIGGER fail_paged_dossier BEFORE UPDATE ON storyhold.character_dossiers FOR EACH ROW EXECUTE FUNCTION storyhold.fail_paged_dossier_update();`);
    await assert.rejects(apply(), /Late paged dossier failure/);
    for (const table of ["world_entity_relations", "world_entity_rules", "entity_review_stat_reviews", "entity_review_stat_verifications",
      "world_entity_relation_verifications", "world_entity_rule_verifications"]) {
      assert.equal((await db.query(`SELECT * FROM storyhold.${table}`)).rows.length, 0, `${table} rolled back`);
    }
    assert.equal((await readEntityReviewCall(db, scope))!.verification_snapshot, null);
    assert.equal((await readEntityReviewCall(db, scope))!.status, "completed");
    await db.exec("DROP TRIGGER fail_paged_dossier ON storyhold.character_dossiers");
    await apply();
    assert.equal(invokes, 2, "saving the retained result never redispatches a paid page");
    const relationLinks = (await db.query<{ run_id: string | null; entity_review_id: string; step_key: string }>("SELECT * FROM storyhold.world_entity_relation_verifications")).rows;
    const ruleLinks = (await db.query<{ run_id: string | null; entity_review_id: string; step_key: string }>("SELECT * FROM storyhold.world_entity_rule_verifications")).rows;
    assert.equal(relationLinks.length, 13); assert.equal(ruleLinks.length, 1);
    assert.ok([...relationLinks, ...ruleLinks].every((link) => link.run_id === null && link.entity_review_id === REVIEW));
    assert.deepEqual(new Set([...relationLinks, ...ruleLinks].map((link) => link.step_key)), new Set(pages.map((page) => page.stepKey)));
    const stats = (await db.query<{ review_id: string; snapshot: { verifier: { model: string; completedAt: string } } }>("SELECT * FROM storyhold.entity_review_stat_reviews")).rows;
    assert.equal(stats.length, 2); assert.ok(stats.every((row) => row.review_id === REVIEW));
    assert.ok(stats.every((row) => row.snapshot.verifier.model === "offline-page-0"
      && row.snapshot.verifier.completedAt === savedResult.entityReviewPages[0]!.result.journalCompletedAt));
    const statLinks = (await db.query<{ review_id: string; entity_id: string; stat_name: string }>("SELECT * FROM storyhold.entity_review_stat_verifications")).rows;
    assert.deepEqual(statLinks.map(({ review_id, entity_id, stat_name }) => ({ review_id, entity_id, stat_name })),
      [{ review_id: REVIEW, entity_id: ENTITY, stat_name: "strength" }]);
    const profile = (await db.query<{ profile: { relationshipWeb: unknown[]; estimatedStats: { strength: { score: number; evidence: unknown[] } } } }>(
      "SELECT profile FROM storyhold.character_dossiers WHERE id=$1", [DOSSIER])).rows[0]!.profile;
    assert.equal(profile.relationshipWeb.length, 13); assert.equal(profile.estimatedStats.strength.score, 16);
    assert.deepEqual(profile.estimatedStats.strength.evidence, statEvidence);
    assert.equal((await db.query("SELECT * FROM storyhold.world_entity_faction_memberships")).rows.length, 1);
    assert.equal((await db.query("SELECT * FROM storyhold.world_analysis_runs")).rows.length, 0);
    const bundle = (await readEntityReviewCall(db, scope))!.verification_snapshot!;
    assert.equal(bundle.version, 2); if (bundle.version === 2) assert.deepEqual(bundle.graphs, reviewed.graphReviews);
  } finally { globalThis.fetch = originalFetch; await db.close(); }
});

test("all-rejected v2 dossier pages save audit and settle once without upgrading or rewriting the dossier", async () => {
  const db = await database(); const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("No live network is permitted in this persistence fixture."); };
  try {
    const reviewInput = input();
    reviewInput.currentCharacter!.estimatedStats.strength = { score: 12, confidence: 0.5,
      rationale: "A provisional estimate of the lifting action.", evidence: statEvidence };
    const pages = premiumEntityReviewPages(reviewInput);
    assert.equal(pages.length, 2);
    const rejected = { verdict: "rejected", explanation: "The candidate is not established by the supplied passage.", confidence: 0.8,
      supportingEvidence: [], contradictingEvidence: [], retrievalRequests: [] };
    const results: AiTextResult[] = pages.map((page, index) => {
      const graph = buildEntityGraphRequest(page.input)!;
      const raw = { relations: [], rules: [], entityRelations: [], entityRules: [], graphVerification: {
        requestFingerprint: graph.fingerprint, newFindings: [], decisions: graph.proposals.map((proposal) => ({ proposalId: proposal.id, ...rejected })),
      }, ...(index === 0 ? { aliases: [], summary: "", details: [], relationships: [], evidence: [], confidence: 0,
        estimatedStats: null, character: null,
        statVerifications: buildEntityStatRequests(page.input).map((request) => ({ requestFingerprint: request.fingerprint,
          decisions: request.proposals.map((proposal) => ({ proposalId: proposal.id, ...rejected })), newStats: [] })),
      } : {}) };
      page.request.validate?.(JSON.stringify(raw));
      const model = `rejected-page-${index}`;
      return { text: JSON.stringify(raw), provider: "openrouter", model, reasoning: "high",
        usage: { inputUnits: 100, outputUnits: 50, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 0,
          estimatedCostMicros: 100, pricingKnown: true, pricingVersion: "fixture", costEstimated: false },
        runtime: { ...getAiRuntimeStatus("canon_review", "standard", "dossier"), provider: "openrouter", model,
          execution: { connectionId: "managed:openrouter", credentialSource: "environment", connectionSource: "storyhold_managed",
            billingSource: "storyhold_credits", requestedModel: model, resolvedModel: model, upstreamProvider: "fixture", privacyMode: "zero-data-retention" } },
      };
    });
    const context: SaveArgs["context"] = { input: reviewInput,
      entityRow: (await db.query<Record<string, unknown>>("SELECT * FROM storyhold.world_entities WHERE id=$1", [ENTITY])).rows[0]!,
      mentionCount: 1, mentionSourceCount: 1, selectedPassages: [], entityIdsByName: new Map([["mira", ENTITY], ["ash guild", FACTION]]) };
    const beforeEntities = (await db.query("SELECT * FROM storyhold.world_entities ORDER BY id")).rows;
    const beforeDossiers = (await db.query("SELECT * FROM storyhold.character_dossiers ORDER BY id")).rows;
    let invokes = 0;
    const savedResult = await executeJournaledEntityReviewPages(db, { scope, reservationId: null,
      contextSnapshot: JSON.parse(JSON.stringify({ version: 1, input: reviewInput })),
      pages: pages.map((page, index) => ({ stepKey: page.stepKey, request: page.request, provider: results[index]!.provider, model: results[index]!.model })),
      invoke: async (_, index) => { invokes += 1; return results[index]!; },
    });
    const reviewed = reviewEntityFromSavedResult(reviewInput, savedResult);
    assert.equal(reviewed.finding.relations.length, 0); assert.equal(reviewed.finding.rules.length, 0);
    const finalized = await db.transaction(async (tx) => {
      await saveEntityReviewVerificationBundle(tx, scope, { version: 2, graphs: reviewed.graphReviews! });
      const outcome = await saveEntityReview({ db: tx as unknown as SaveArgs["db"], worldId: WORLD, editionId: EDITION, context,
        finding: reviewed.finding, reviewMode: "premium", statReviews: reviewed.statReviews, graphReviews: reviewed.graphReviews, graphScope: scope });
      assert.ok(outcome.warnings.length > 0);
      return settleEntityReviewAccountingInTransaction(tx, { scope, outcome: "applied", response: { warnings: outcome.warnings } });
    });
    assert.deepEqual((await db.query("SELECT * FROM storyhold.world_entities ORDER BY id")).rows, beforeEntities);
    assert.deepEqual((await db.query("SELECT * FROM storyhold.character_dossiers ORDER BY id")).rows, beforeDossiers);
    assert.equal((await db.query("SELECT * FROM storyhold.entity_review_stat_reviews")).rows.length, 2);
    for (const table of ["world_entity_relations", "world_entity_rules", "world_entity_faction_memberships", "entity_review_stat_verifications",
      "world_entity_relation_verifications", "world_entity_rule_verifications"]) {
      assert.equal((await db.query(`SELECT * FROM storyhold.${table}`)).rows.length, 0);
    }
    const call = (await readEntityReviewCall(db, scope))!;
    assert.equal(call.status, "completed"); assert.equal(call.verification_snapshot!.version, 2); assert.ok(call.finalization_snapshot);
    assert.equal(finalized.reviewed, true); assert.equal(finalized.creditsUsed, 0, "administrator is exempt but real usage remains accounted");
    assert.deepEqual(await db.transaction((tx) => settleEntityReviewAccountingInTransaction(tx, { scope, outcome: "applied" })), finalized);
    const usage = (await db.query<{ model: string; cost_micros: string | number }>("SELECT model,cost_micros FROM storyhold.ai_usage_ledger ORDER BY model")).rows;
    assert.deepEqual(usage.map((entry) => entry.model), ["rejected-page-0", "rejected-page-1"]);
    assert.equal(usage.reduce((total, entry) => total + Number(entry.cost_micros), 0), 200);
    assert.equal(invokes, 2);
  } finally { globalThis.fetch = originalFetch; await db.close(); }
});

const VERIFIED_SUMMARY = "Mira holds a heavy beam so her companions can escape.";
const VERIFIED_TRAIT = "Protective of her companions.";
const V3_WRITE_TABLES = ["world_knowledge_claims", "world_knowledge_claim_verifications", "world_entity_relations", "world_entity_rules",
  "world_entity_faction_memberships", "entity_review_stat_reviews", "entity_review_stat_verifications",
  "world_entity_relation_verifications", "world_entity_rule_verifications", "ai_usage_ledger"];

async function v3Review(db: PGlite, allRejected = false, extraProse: Array<{ predicate: string; value: string }> = [], existingAudit = false) {
  const reviewInput = input(); reviewInput.proseReview = { version: 1 };
  const entityRow = (await db.query<Record<string, unknown>>("SELECT * FROM storyhold.world_entities WHERE id=$1", [ENTITY])).rows[0]!;
  const dossier = (await db.query<{ profile: CharacterFinding; summary: string }>("SELECT profile,summary FROM storyhold.character_dossiers WHERE id=$1", [DOSSIER])).rows[0]!;
  reviewInput.entity.summary = String(entityRow.summary ?? "");
  reviewInput.entity.details = structuredClone(entityRow.details as string[]);
  reviewInput.currentCharacter = structuredClone(dossier.profile);
  reviewInput.currentCharacter.summary = dossier.summary;
  if (existingAudit) reviewInput.existingProseReview = buildExistingProseInventory(entityRow, {
    aliases: reviewInput.currentCharacter.aliases, summary: dossier.summary, role: reviewInput.currentCharacter.role, profile: dossier.profile,
  });
  const auditPages = prepareEntityExistingProsePages(reviewInput);
  const pages = premiumEntityReviewPages(reviewInput);
  assert.equal(pages.length, 2 + auditPages.length);
  const verdict = allRejected ? "rejected" : "verified";
  const decision = (quote: string) => ({ verdict, explanation: allRejected ? "The passage does not establish this candidate." : "The passage supports this exact account.",
    confidence: 0.9, supportingEvidence: allRejected ? [] : [{ chunkId: CHUNK, quote }], contradictingEvidence: [], retrievalRequests: [] });
  const results: AiTextResult[] = pages.map((page, index) => {
    const auditPage = auditPages[index - 2];
    const graph = index < 2 ? buildEntityGraphRequest(page.input)! : undefined;
    const prose = index === 0 ? buildEntityProseRequest(page.input)! : undefined;
    const raw = auditPage ? { existingProseVerification: { requestFingerprint: auditPage.requestFingerprint,
      decisions: auditPage.items.map((item) => ({ itemId: item.itemId, verdict: "needs_more_evidence",
        explanation: "This earlier detail requires its own source passage.", confidence: 0.2,
        supportingEvidence: [], contradictingEvidence: [], retrievalRequests: ["Find the earlier expedition passage."] })),
    } } : { relations: [], rules: [], entityRelations: [], entityRules: [], graphVerification: {
      requestFingerprint: graph!.fingerprint, newFindings: [], decisions: graph!.proposals.map((proposal) => ({ proposalId: proposal.id, ...decision(GRAPH_QUOTE) })),
    }, ...(index === 0 ? { aliases: [], summary: "", details: [], relationships: [], evidence: [], confidence: 0,
      estimatedStats: null, character: null, claims: [],
      claimVerification: { requestFingerprint: prose!.fingerprint, decisions: [], newClaims: [
        { predicate: "dossier.summary", value: VERIFIED_SUMMARY }, { predicate: "dossier.traits", value: VERIFIED_TRAIT },
        ...extraProse,
      ].map((claim) => ({ claim: { subject: "Mira", ...claim, polarity: "positive", epistemicHolder: "", truthStatus: "fact", validFromLabel: "", validUntilLabel: "" },
        ...decision(STAT_QUOTE) })) }, prosePresentation: { displayOrder: allRejected ? [] : Array.from({ length: 2 + extraProse.length }, (_item, itemIndex) => itemIndex) },
      statVerifications: buildEntityStatRequests(page.input).map((request, group) => ({ requestFingerprint: request.fingerprint,
        decisions: request.proposals.map((proposal) => ({ proposalId: proposal.id, ...decision(STAT_QUOTE) })),
        newStats: !allRejected && group === 0 ? [{ payload: { family: "characters", entity: "Mira", stat: "strength", score: 16,
          rationale: "Held the heavy beam while her companions escaped." }, ...decision(STAT_QUOTE) }] : [],
      })),
    } : {}) };
    page.request.validate?.(JSON.stringify(raw));
    const model = `v3-offline-page-${index}`;
    return { text: JSON.stringify(raw), provider: "openrouter", model, reasoning: "high",
      usage: { inputUnits: 100, outputUnits: 50, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 0,
        estimatedCostMicros: 100, pricingKnown: true, pricingVersion: "fixture", costEstimated: false },
      runtime: { ...getAiRuntimeStatus("canon_review", "standard", "dossier"), provider: "openrouter", model,
        execution: { connectionId: "managed:openrouter", credentialSource: "environment", connectionSource: "storyhold_managed",
          billingSource: "storyhold_credits", requestedModel: model, resolvedModel: model, upstreamProvider: "fixture", privacyMode: "zero-data-retention" } } };
  });
  const context: SaveArgs["context"] = { input: reviewInput, entityRow, mentionCount: 1, mentionSourceCount: 1, selectedPassages: [],
    entityIdsByName: new Map([["mira", ENTITY], ["ash guild", FACTION]]) };
  let invokes = 0;
  const saved = await executeJournaledEntityReviewPages(db, { scope, reservationId: null,
    contextSnapshot: JSON.parse(JSON.stringify({ version: 1, input: reviewInput })),
    pages: pages.map((page, index) => ({ stepKey: page.stepKey, request: page.request, provider: results[index]!.provider, model: results[index]!.model })),
    invoke: async (_page, index) => { invokes++; return results[index]!; } });
  const reviewed = reviewEntityFromSavedResult(reviewInput, saved);
  assert.ok(reviewed.proseReview); assert.equal(reviewed.graphReviews!.length, 2); assert.equal(reviewed.statReviews.length, 2);
  const apply = () => finishJournaledEntityReview(db, { scope, apply: async (tx, frozen, result) => {
    assert.deepEqual(frozen.input, reviewInput);
    const stored = reviewEntityFromSavedResult(reviewInput, result);
    await saveEntityReviewVerificationBundle(tx, scope, stored.existingProseReviews
      ? { version: 4, graphs: stored.graphReviews!, prose: stored.proseReview!, existingProse: stored.existingProseReviews }
      : { version: 3, graphs: stored.graphReviews!, prose: stored.proseReview! });
    const outcome = await saveEntityReview({ db: tx as unknown as SaveArgs["db"], worldId: WORLD, editionId: EDITION, context,
      finding: stored.finding, reviewMode: "premium", statReviews: stored.statReviews, graphReviews: stored.graphReviews,
      proseReview: stored.proseReview, graphScope: scope });
    return { warnings: outcome.warnings };
  } });
  return { saved, reviewed, apply, invokes: () => invokes };
}

test("v4 root save preserves unresolved old prose while promoting only separately verified new claims", async () => {
  const db = await database();
  try {
    const original = Array.from({ length: 54 }, (_item, index) => `Earlier character detail ${index}.`);
    await db.query("UPDATE storyhold.character_dossiers SET profile=$1::jsonb WHERE id=$2", [JSON.stringify({ ...character(), traits: original }), DOSSIER]);
    const review = await v3Review(db, false, [], true);
    const audits = review.reviewed.existingProseReviews!;
    assert.ok(audits.length >= 6);
    const final = await review.apply();
    const saved = (await db.query<{ profile: CharacterFinding }>("SELECT profile FROM storyhold.character_dossiers WHERE id=$1", [DOSSIER])).rows[0]!.profile;
    assert.deepEqual(saved.traits, [...original, VERIFIED_TRAIT]);
    assert.equal(saved.estimatedStats.strength.score, 16);
    assert.equal((await db.query("SELECT * FROM storyhold.world_knowledge_claims")).rows.length, 2,
      "Old-text audits must not fabricate canonical claims");
    assert.equal((await db.query("SELECT * FROM storyhold.world_knowledge_claim_verifications")).rows.length, 2);
    const call = (await readEntityReviewCall(db, scope))!;
    assert.equal(call.verification_snapshot!.version, 4);
    if (call.verification_snapshot!.version !== 4) throw new Error("Expected exhaustive audit proof");
    assert.equal(call.verification_snapshot!.existingProse.flatMap((receipt) => receipt.decisions).length,
      audits.flatMap((receipt) => receipt.decisions).length);
    assert.equal((await db.query("SELECT * FROM storyhold.ai_usage_ledger")).rows.length, 2 + audits.length);
    assert.deepEqual(await review.apply(), final);
    assert.equal(review.invokes(), 2 + audits.length);
  } finally { await db.close(); }
});

test("v4 root all-rejected update retains every existing row and saves the complete old-text audit once", async () => {
  const db = await database();
  try {
    const beforeEntity = (await db.query("SELECT * FROM storyhold.world_entities ORDER BY id")).rows;
    const beforeDossier = (await db.query("SELECT * FROM storyhold.character_dossiers ORDER BY id")).rows;
    const review = await v3Review(db, true, [], true);
    const final = await review.apply();
    assert.equal(final.reviewed, true, "A complete audit remains reviewable even without new canon to promote");
    assert.deepEqual((await db.query("SELECT * FROM storyhold.world_entities ORDER BY id")).rows, beforeEntity);
    assert.deepEqual((await db.query("SELECT * FROM storyhold.character_dossiers ORDER BY id")).rows, beforeDossier);
    assert.equal((await db.query("SELECT * FROM storyhold.world_knowledge_claims")).rows.length, 0);
    assert.equal((await readEntityReviewCall(db, scope))!.verification_snapshot!.version, 4);
    assert.deepEqual(await review.apply(), final);
    assert.equal(review.invokes(), 2 + review.reviewed.existingProseReviews!.length);
  } finally { await db.close(); }
});

test("v4 successful save preserves repeated old prose slots and suppresses only duplicate incoming additions", async () => {
  const db = await database();
  try {
    const profile = character();
    const keys = ["traits", "motivations", "fears", "capabilities", "history", "origins", "powers", "moralSystem",
      "physicalCharacteristics", "relationships", "knowledge", "secrets"] as const;
    for (const key of keys) profile[key] = [`Old ${key} wording.`, `Old ${key} wording.`, ` Last ${key} line.\nIts qualifier remains. `];
    profile.traits = [VERIFIED_TRAIT, VERIFIED_TRAIT, "A later trait retains its old slot."];
    profile.aliases = ["Miri", "Miri"];
    const detail = "Mira holds the beam as her companions escape.";
    const details = [detail, detail, `A long old account. ${"The original wording remains complete. ".repeat(50)}\nFinal qualifier.`];
    const relationships = ["Mira formerly trusted Dara.", "Mira formerly trusted Dara.", "Their later relationship remains uncertain."];
    await db.query("UPDATE storyhold.character_dossiers SET profile=$1::jsonb,aliases=$2::jsonb WHERE id=$3",
      [JSON.stringify(profile), JSON.stringify(profile.aliases), DOSSIER]);
    await db.query("UPDATE storyhold.world_entities SET details=$1::jsonb,relationships=$2::jsonb WHERE id=$3",
      [JSON.stringify(details), JSON.stringify(relationships), ENTITY]);
    const review = await v3Review(db, false, [{ predicate: "dossier.details", value: detail }], true);
    const oldSlots = review.reviewed.existingProseReviews!.flatMap((receipt) => receipt.page.items)
      .filter((item) => item.field !== "summary" && item.field !== "role");
    const final = await review.apply();
    const savedEntity = (await db.query<{ aliases: string[]; summary: string; details: string[]; relationships: string[] }>(
      "SELECT aliases,summary,details,relationships FROM storyhold.world_entities WHERE id=$1", [ENTITY])).rows[0]!;
    const savedDossier = (await db.query<{ aliases: string[]; summary: string; role: string; profile: CharacterFinding }>(
      "SELECT aliases,summary,role,profile FROM storyhold.character_dossiers WHERE id=$1", [DOSSIER])).rows[0]!;
    assert.deepEqual(savedEntity.details, details, "Two old copies remain two copies, not one or three");
    assert.deepEqual(savedEntity.relationships.slice(0, relationships.length), relationships);
    assert.deepEqual(savedDossier.aliases, profile.aliases);
    for (const key of keys) assert.deepEqual(savedDossier.profile[key].slice(0, profile[key].length), profile[key], `${key} slots retain their exact indexes`);
    assert.deepEqual(savedDossier.profile.traits, profile.traits, "Reapproved old wording must not append another duplicate");
    const currentSlots = new Set(buildExistingProseInventory(savedEntity, savedDossier).items.map((item) => item.itemId));
    for (const slot of oldSlots) assert.ok(currentSlots.has(slot.itemId), `Old ${slot.origin}.${slot.field}[${slot.index}] remains addressable`);
    assert.equal(savedDossier.profile.estimatedStats.strength.score, 16, "Preservation does not disable independently reviewed updates");
    assert.deepEqual(await review.apply(), final);
    assert.deepEqual((await db.query<{ profile: CharacterFinding }>("SELECT profile FROM storyhold.character_dossiers WHERE id=$1", [DOSSIER])).rows[0]!.profile, savedDossier.profile);
    assert.equal(review.invokes(), 2 + review.reviewed.existingProseReviews!.length);
  } finally { await db.close(); }
});

for (const existingAudit of [false, true]) test(`v${existingAudit ? 4 : 3} root persistence atomically writes exact prose claims, graph and stats and reuses paid pages after late rollback`, async () => {
  const db = await database(); const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("No live network is permitted in this persistence fixture."); };
  try {
    const beforeEntities = (await db.query("SELECT * FROM storyhold.world_entities ORDER BY id")).rows;
    const beforeDossiers = (await db.query("SELECT * FROM storyhold.character_dossiers ORDER BY id")).rows;
    const review = await v3Review(db, false, [], existingAudit);
    const paidPages = 2 + (review.reviewed.existingProseReviews?.length ?? 0);
    assert.equal(review.reviewed.finding.summary, VERIFIED_SUMMARY);
    assert.deepEqual(review.reviewed.finding.character?.traits, [VERIFIED_TRAIT]);
    await db.exec(`CREATE FUNCTION storyhold.fail_v3_dossier_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Late v3 dossier failure'; END; $$;
      CREATE TRIGGER fail_v3_dossier BEFORE UPDATE ON storyhold.character_dossiers FOR EACH ROW EXECUTE FUNCTION storyhold.fail_v3_dossier_update();`);
    await assert.rejects(review.apply(), /Late v3 dossier failure/);
    for (const table of V3_WRITE_TABLES) assert.equal((await db.query(`SELECT * FROM storyhold.${table}`)).rows.length, 0, `${table} rolled back`);
    assert.deepEqual((await db.query("SELECT * FROM storyhold.world_entities ORDER BY id")).rows, beforeEntities);
    assert.deepEqual((await db.query("SELECT * FROM storyhold.character_dossiers ORDER BY id")).rows, beforeDossiers);
    assert.equal((await readEntityReviewCall(db, scope))!.status, "completed");
    assert.equal((await readEntityReviewCall(db, scope))!.verification_snapshot, null);
    await db.exec("DROP TRIGGER fail_v3_dossier ON storyhold.character_dossiers");
    const final = await review.apply(); assert.deepEqual(await review.apply(), final); assert.equal(review.invokes(), paidPages);
    const entity = (await db.query<{ summary: string }>("SELECT summary FROM storyhold.world_entities WHERE id=$1", [ENTITY])).rows[0]!;
    const dossier = (await db.query<{ summary: string; profile: CharacterFinding }>("SELECT summary,profile FROM storyhold.character_dossiers WHERE id=$1", [DOSSIER])).rows[0]!;
    assert.equal(entity.summary, VERIFIED_SUMMARY); assert.equal(dossier.summary, VERIFIED_SUMMARY);
    assert.deepEqual(dossier.profile.traits, ["Loyal", VERIFIED_TRAIT]);
    assert.equal(dossier.profile.estimatedStats.strength.score, 16); assert.deepEqual(dossier.profile.estimatedStats.strength.evidence, statEvidence);
    assert.equal(dossier.profile.relationshipWeb.length, 13);
    const claims = (await db.query<{ id: string; predicate: string; object_text: string; evidence: unknown; source_analysis_run_id: string | null }>(
      "SELECT * FROM storyhold.world_knowledge_claims ORDER BY predicate")).rows;
    assert.deepEqual(claims.map((claim) => [claim.predicate, claim.object_text]), [["dossier.summary", VERIFIED_SUMMARY], ["dossier.traits", VERIFIED_TRAIT]]);
    assert.ok(claims.every((claim) => claim.source_analysis_run_id === null));
    for (const claim of claims) assert.deepEqual(claim.evidence, statEvidence);
    const links = (await db.query<{ claim_id: string; entity_review_id: string; run_id: string | null; step_key: string }>(
      "SELECT * FROM storyhold.world_knowledge_claim_verifications")).rows;
    assert.equal(links.length, 2); assert.deepEqual(new Set(links.map((link) => link.claim_id)), new Set(claims.map((claim) => claim.id)));
    assert.ok(links.every((link) => link.run_id === null && link.entity_review_id === REVIEW && link.step_key === "dossier_prose:0"));
    assert.equal((await db.query("SELECT * FROM storyhold.entity_review_stat_verifications")).rows.length, 1);
    assert.equal((await db.query("SELECT * FROM storyhold.world_entity_relation_verifications")).rows.length, 13);
    assert.equal((await db.query("SELECT * FROM storyhold.world_entity_rule_verifications")).rows.length, 1);
    const call = (await readEntityReviewCall(db, scope))!;
    assert.equal(call.verification_snapshot!.version, existingAudit ? 4 : 3); assert.equal(call.finalization_snapshot!.reviewed, true);
    const usage = (await db.query<{ cost_micros: number | string }>("SELECT cost_micros FROM storyhold.ai_usage_ledger")).rows;
    assert.equal(usage.length, paidPages); assert.equal(usage.reduce((total, entry) => total + Number(entry.cost_micros), 0), paidPages * 100);
    assert.equal((await db.query("SELECT * FROM storyhold.world_analysis_runs")).rows.length, 0);
  } finally { globalThis.fetch = originalFetch; await db.close(); }
});

test("v3 root persistence withholds author-owned summary claims and displays only actually applied prose", async () => {
  const db = await database();
  try {
    const ownerSummary = "The author controls Mira's identity and purpose.";
    await db.query("UPDATE storyhold.world_entities SET summary=$1 WHERE id=$2", [ownerSummary, ENTITY]);
    await db.query("UPDATE storyhold.character_dossiers SET summary=$1 WHERE id=$2", [ownerSummary, DOSSIER]);
    await db.query(`INSERT INTO storyhold.world_knowledge_claims(id,world_id,canon_edition_id,fingerprint,subject_entity_id,predicate,object_text,truth_status,assignment_source)
      VALUES($1,$2,$3,'owner-summary',$4,'dossier.summary',$5,'fact','user')`, [uuid(1250), WORLD, EDITION, ENTITY, ownerSummary]);
    const beforeOwner = (await db.query("SELECT * FROM storyhold.world_knowledge_claims WHERE assignment_source='user'")).rows;
    const review = await v3Review(db); const final = await review.apply();
    assert.ok((final.warnings as string[]).some((warning) => warning.includes("summary")));
    assert.deepEqual((await db.query("SELECT * FROM storyhold.world_knowledge_claims WHERE assignment_source='user'")).rows, beforeOwner);
    assert.equal((await db.query<{ summary: string }>("SELECT summary FROM storyhold.world_entities WHERE id=$1", [ENTITY])).rows[0]!.summary, ownerSummary);
    const dossier = (await db.query<{ summary: string; profile: CharacterFinding }>("SELECT summary,profile FROM storyhold.character_dossiers WHERE id=$1", [DOSSIER])).rows[0]!;
    assert.equal(dossier.summary, ownerSummary); assert.ok(dossier.profile.traits.includes(VERIFIED_TRAIT));
    assert.equal((await db.query("SELECT * FROM storyhold.world_knowledge_claims WHERE assignment_source='ai' AND predicate='dossier.summary'")).rows.length, 0);
    assert.equal((await db.query("SELECT * FROM storyhold.world_knowledge_claim_verifications")).rows.length, 1);
    assert.equal(review.invokes(), 2);
  } finally { await db.close(); }
});

test("all-rejected v3 root review keeps the entire original dossier while retaining its proof and exact usage", async () => {
  const db = await database();
  try {
    const beforeEntities = (await db.query("SELECT * FROM storyhold.world_entities ORDER BY id")).rows;
    const beforeDossiers = (await db.query("SELECT * FROM storyhold.character_dossiers ORDER BY id")).rows;
    const review = await v3Review(db, true); const final = await review.apply();
    assert.deepEqual((await db.query("SELECT * FROM storyhold.world_entities ORDER BY id")).rows, beforeEntities);
    assert.deepEqual((await db.query("SELECT * FROM storyhold.character_dossiers ORDER BY id")).rows, beforeDossiers);
    for (const table of V3_WRITE_TABLES.filter((table) => !["entity_review_stat_reviews", "ai_usage_ledger"].includes(table))) {
      assert.equal((await db.query(`SELECT * FROM storyhold.${table}`)).rows.length, 0, `${table} has no promoted rows`);
    }
    assert.ok((final.warnings as string[]).some((warning) => warning.includes("left unchanged")));
    assert.equal((await readEntityReviewCall(db, scope))!.verification_snapshot!.version, 3);
    assert.equal((await db.query("SELECT * FROM storyhold.ai_usage_ledger")).rows.length, 2);
    assert.deepEqual(await review.apply(), final); assert.equal(review.invokes(), 2);
  } finally { await db.close(); }
});

test("more than forty existing traits and the new verified trait persist completely in original order", async () => {
  const db = await database();
  try {
    const full = { ...character(), traits: Array.from({ length: 52 }, (_value, index) => `Existing Trait ${index}`) };
    await db.query("UPDATE storyhold.character_dossiers SET profile=$1::jsonb WHERE id=$2", [JSON.stringify(full), DOSSIER]);
    const review = await v3Review(db);
    const final = await review.apply();
    const saved = (await db.query<{ profile: CharacterFinding }>("SELECT profile FROM storyhold.character_dossiers WHERE id=$1", [DOSSIER])).rows[0]!.profile;
    assert.deepEqual(saved.traits, [...full.traits, VERIFIED_TRAIT]);
    assert.deepEqual(serializeDossier({ profile: saved }).profile.traits, [...full.traits, VERIFIED_TRAIT]);
    assert.equal(saved.estimatedStats.strength.score, 16);
    assert.equal((await db.query("SELECT * FROM storyhold.world_knowledge_claims")).rows.length, 2);
    assert.equal((await db.query("SELECT * FROM storyhold.world_knowledge_claim_verifications")).rows.length, 2);
    const call = (await readEntityReviewCall(db, scope))!;
    assert.equal(call.status, "completed"); assert.equal(call.verification_snapshot!.version, 3); assert.equal(call.finalization_snapshot!.reviewed, true);
    assert.deepEqual(await review.apply(), final); assert.equal(review.invokes(), 2);
    assert.deepEqual((await db.query<{ profile: CharacterFinding }>("SELECT profile FROM storyhold.character_dossiers WHERE id=$1", [DOSSIER])).rows[0]!.profile, saved);
  } finally { await db.close(); }
});

test("premium prose save preserves full-length existing history beyond both old string limits", async () => {
  const db = await database();
  try {
    const longHistory = `Mira's earlier journey began before she joined the guild.\n${"She remembered each village and the people who had sheltered her along the road. ".repeat(24)}The final promise remained unbroken.`;
    assert.ok(longHistory.length > 1_000);
    const original = { ...character(), history: [longHistory, "She later joined the Ash Guild."] };
    await db.query("UPDATE storyhold.character_dossiers SET profile=$1::jsonb WHERE id=$2", [JSON.stringify(original), DOSSIER]);
    const incomingHistory = "Mira held the heavy beam until her companions escaped.";
    const review = await v3Review(db, false, [{ predicate: "dossier.history", value: incomingHistory }]);
    const final = await review.apply();
    const saved = (await db.query<{ profile: CharacterFinding }>("SELECT profile FROM storyhold.character_dossiers WHERE id=$1", [DOSSIER])).rows[0]!.profile;
    assert.deepEqual(saved.history, [...original.history, incomingHistory]);
    assert.deepEqual(serializeDossier({ profile: saved }).profile.history, [...original.history, incomingHistory]);
    assert.equal(saved.history[0]!.length, longHistory.length); assert.ok(saved.history[0]!.endsWith("The final promise remained unbroken."));
    assert.ok(saved.traits.includes(VERIFIED_TRAIT));
    assert.deepEqual(await review.apply(), final); assert.equal(review.invokes(), 2);
    assert.deepEqual((await db.query<{ profile: CharacterFinding }>("SELECT profile FROM storyhold.character_dossiers WHERE id=$1", [DOSSIER])).rows[0]!.profile.history, saved.history);
  } finally { await db.close(); }
});

test("more than eighty entity details including long prior text survive with the new verified detail", async () => {
  const db = await database();
  try {
    const longDetail = `A retained account of the earlier expedition. ${"Every remembered landmark remained distinct and important to the expedition. ".repeat(12)}Its final destination was the old watchtower.`;
    assert.ok(longDetail.length > 500);
    const original = [longDetail, ...Array.from({ length: 86 }, (_value, index) => `Existing Detail ${index}`)];
    await db.query("UPDATE storyhold.world_entities SET details=$1::jsonb WHERE id=$2", [JSON.stringify(original), ENTITY]);
    const incomingDetail = "Mira holds the beam as her companions escape.";
    const review = await v3Review(db, false, [{ predicate: "dossier.details", value: incomingDetail }]);
    const final = await review.apply();
    const saved = (await db.query<{ details: string[] }>("SELECT details FROM storyhold.world_entities WHERE id=$1", [ENTITY])).rows[0]!.details;
    assert.deepEqual(saved, [...original, incomingDetail]); assert.equal(saved.length, 88); assert.equal(saved[0], longDetail);
    assert.equal((await db.query("SELECT * FROM storyhold.world_knowledge_claims WHERE predicate='dossier.details'")).rows.length, 1);
    assert.deepEqual(await review.apply(), final); assert.equal(review.invokes(), 2);
    assert.deepEqual((await db.query<{ details: string[] }>("SELECT details FROM storyhold.world_entities WHERE id=$1", [ENTITY])).rows[0]!.details, saved);
  } finally { await db.close(); }
});

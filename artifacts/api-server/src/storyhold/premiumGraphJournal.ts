import { createHash, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { buildVerifiedPromotionPlan, canonPayloadFingerprint, type JsonObject, type VerifiedPromotionEntry } from "./analysisVerificationContracts";
import { assertPremiumGraphReceipt, canProjectCurrentFactionMembership, type PremiumGraphReviewReceipt } from "./premiumGraphVerification";
import { localEntityTextIsUseful } from "./localEntityExtraction";
import { loadWorldEntityNameResolution, type WorldReferenceIssue } from "./worldKnowledge";
import type { CohesionFinding, EntityRelationFinding, EntityRelationType, EntityRuleFinding, EvidenceReference } from "./worldAnalysis";
import { readEntityReviewCall, type EntityReviewCallScope } from "./entityReviewJournal";
import type { EntityReviewInput } from "./entityReview";
import { assertEntityGraphReview, assertEntityGraphReviews, dossierGraphConflicts } from "./entityGraphVerification";

type QueryDb = Pick<PGlite, "query">;
export type PremiumGraphScope = { worldId: string; editionId: string; analysisRunId: string };
type StoredReview = {
  run_id: string; world_id: string; edition_id: string; step_key: string;
  receipt_fingerprint: string; snapshot_fingerprint: string; snapshot: PremiumGraphReviewReceipt;
};
type RelationPayload = Omit<EntityRelationFinding, "evidence" | "confidence" | "reviewStatus">;
type RulePayload = Omit<EntityRuleFinding, "evidence" | "confidence" | "reviewStatus">;
type Planned = { receipt: PremiumGraphReviewReceipt; entry: VerifiedPromotionEntry; evidence: EvidenceReference[] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const premiumGraphJournalSchemaSql = String.raw`
  CREATE TABLE IF NOT EXISTS storyhold.world_analysis_graph_reviews (
    run_id uuid NOT NULL REFERENCES storyhold.world_analysis_runs(id) ON DELETE CASCADE,
    world_id uuid NOT NULL, edition_id uuid NOT NULL,
    step_key text NOT NULL CHECK (length(step_key) BETWEEN 1 AND 200),
    receipt_fingerprint text NOT NULL, snapshot_fingerprint text NOT NULL, snapshot jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (run_id, step_key)
  );
  CREATE OR REPLACE FUNCTION storyhold.reject_premium_graph_review_update()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RAISE EXCEPTION 'Premium graph verification receipts and links are immutable'; END;
  $$;
  DROP TRIGGER IF EXISTS premium_graph_review_immutable ON storyhold.world_analysis_graph_reviews;
  CREATE TRIGGER premium_graph_review_immutable BEFORE UPDATE ON storyhold.world_analysis_graph_reviews
    FOR EACH ROW EXECUTE FUNCTION storyhold.reject_premium_graph_review_update();
  ALTER TABLE storyhold.world_entity_relations ADD COLUMN IF NOT EXISTS source_analysis_run_id uuid
    REFERENCES storyhold.world_analysis_runs(id) ON DELETE SET NULL;
  ALTER TABLE storyhold.world_entity_rules ADD COLUMN IF NOT EXISTS source_analysis_run_id uuid
    REFERENCES storyhold.world_analysis_runs(id) ON DELETE SET NULL;
  CREATE TABLE IF NOT EXISTS storyhold.world_entity_relation_verifications (
    relation_id uuid NOT NULL REFERENCES storyhold.world_entity_relations(id) ON DELETE CASCADE,
    run_id uuid NOT NULL, step_key text NOT NULL, proposal_id text NOT NULL,
    decision_id text NOT NULL, payload_fingerprint text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (run_id, step_key, proposal_id),
    FOREIGN KEY (run_id, step_key) REFERENCES storyhold.world_analysis_graph_reviews(run_id, step_key) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS storyhold.world_entity_rule_verifications (
    rule_id uuid NOT NULL REFERENCES storyhold.world_entity_rules(id) ON DELETE CASCADE,
    run_id uuid NOT NULL, step_key text NOT NULL, proposal_id text NOT NULL,
    decision_id text NOT NULL, payload_fingerprint text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (run_id, step_key, proposal_id),
    FOREIGN KEY (run_id, step_key) REFERENCES storyhold.world_analysis_graph_reviews(run_id, step_key) ON DELETE CASCADE
  );
  DROP TRIGGER IF EXISTS premium_relation_link_immutable ON storyhold.world_entity_relation_verifications;
  CREATE TRIGGER premium_relation_link_immutable BEFORE UPDATE ON storyhold.world_entity_relation_verifications
    FOR EACH ROW EXECUTE FUNCTION storyhold.reject_premium_graph_review_update();
  DROP TRIGGER IF EXISTS premium_rule_link_immutable ON storyhold.world_entity_rule_verifications;
  CREATE TRIGGER premium_rule_link_immutable BEFORE UPDATE ON storyhold.world_entity_rule_verifications
    FOR EACH ROW EXECUTE FUNCTION storyhold.reject_premium_graph_review_update();
`;

export class PremiumGraphJournalError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "PremiumGraphJournalError"; }
}
function fail(code: string, message: string): never { throw new PremiumGraphJournalError(code, message); }
function fullHash(value: unknown): string { return canonPayloadFingerprint(value as JsonObject); }
function validateScope(scope: PremiumGraphScope): void {
  if (!scope || [scope.worldId, scope.editionId, scope.analysisRunId].some((value) => typeof value !== "string" || !UUID.test(value))) {
    fail("GRAPH_SCOPE_INVALID", "Graph verification requires an exact world, edition, and analysis run.");
  }
}
function stepKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("GRAPH_STEP_INVALID", "Graph verification requires a bounded nonblank step identifier.");
  }
}
function sameScope(left: PremiumGraphScope, right: PremiumGraphScope): boolean {
  return left.worldId === right.worldId && left.editionId === right.editionId && left.analysisRunId === right.analysisRunId;
}
function snapshot(value: PremiumGraphReviewReceipt): PremiumGraphReviewReceipt {
  try {
    assertPremiumGraphReceipt(value);
    validateScope(value.request.scope);
    stepKey(value.request.stepKey);
    const before = fullHash(value);
    const copy = JSON.parse(JSON.stringify(value)) as PremiumGraphReviewReceipt;
    assertPremiumGraphReceipt(copy);
    if (fullHash(copy) !== before) throw new Error("Non-JSON receipt");
    return copy;
  } catch (error) {
    if (error instanceof PremiumGraphJournalError) throw error;
    fail("GRAPH_RECEIPT_INVALID", "The graph review receipt failed validation.");
  }
}
async function assertRun(db: QueryDb, scope: PremiumGraphScope, lock: boolean): Promise<void> {
  validateScope(scope);
  const run = await db.query(
    `SELECT id FROM storyhold.world_analysis_runs WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3
      AND analysis_kind = 'ai_enrichment'${lock ? " FOR UPDATE" : ""}`,
    [scope.analysisRunId, scope.worldId, scope.editionId],
  );
  if (run.rows.length !== 1) fail("GRAPH_SCOPE_MISMATCH", "The premium graph review does not match the current analysis run scope.");
}
function checkedStored(row: StoredReview, scope: PremiumGraphScope): PremiumGraphReviewReceipt {
  try {
    const receipt = snapshot(row.snapshot);
    if (row.run_id !== scope.analysisRunId || row.world_id !== scope.worldId || row.edition_id !== scope.editionId
      || !sameScope(receipt.request.scope, scope) || row.step_key !== receipt.request.stepKey
      || row.receipt_fingerprint !== receipt.fingerprint || row.snapshot_fingerprint !== fullHash(receipt)) throw new Error("Scope or hash mismatch");
    return receipt;
  } catch { fail("GRAPH_JOURNAL_INTEGRITY", "The stored graph review failed its scope or integrity check."); }
}
export async function ensurePremiumGraphJournal(db: Pick<PGlite, "exec">): Promise<void> { await db.exec(premiumGraphJournalSchemaSql); }
/** Save inside the same caller-owned transaction as all canonical graph writes. */
export async function savePremiumGraphReview(db: QueryDb, value: PremiumGraphReviewReceipt): Promise<PremiumGraphReviewReceipt> {
  const receipt = snapshot(value);
  const scope = receipt.request.scope;
  await assertRun(db, scope, true);
  await db.query(`INSERT INTO storyhold.world_analysis_graph_reviews
    (run_id, world_id, edition_id, step_key, receipt_fingerprint, snapshot_fingerprint, snapshot)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) ON CONFLICT (run_id, step_key) DO NOTHING`,
  [scope.analysisRunId, scope.worldId, scope.editionId, receipt.request.stepKey, receipt.fingerprint, fullHash(receipt), JSON.stringify(receipt)]);
  const stored = (await db.query<StoredReview>("SELECT * FROM storyhold.world_analysis_graph_reviews WHERE run_id = $1 AND step_key = $2", [scope.analysisRunId, receipt.request.stepKey])).rows[0];
  if (!stored) fail("GRAPH_JOURNAL_PERSISTENCE", "The graph review receipt was not durably stored.");
  const existing = checkedStored(stored, scope);
  if (fullHash(existing) !== fullHash(receipt)) fail("GRAPH_RECEIPT_MISMATCH", "A different immutable graph review already exists for this step.");
  return existing;
}
export async function readPremiumGraphReviews(db: QueryDb, scope: PremiumGraphScope): Promise<PremiumGraphReviewReceipt[]> {
  await assertRun(db, scope, false);
  const rows = await db.query<StoredReview>("SELECT * FROM storyhold.world_analysis_graph_reviews WHERE run_id = $1 ORDER BY step_key", [scope.analysisRunId]);
  return rows.rows.map((row) => checkedStored(row, scope));
}
export function assertExpectedPremiumGraphReviews(receipts: PremiumGraphReviewReceipt[], params: { scope: PremiumGraphScope; expectedStepKeys: string[] }): void {
  validateScope(params.scope);
  if (!Array.isArray(receipts) || !Array.isArray(params.expectedStepKeys)) fail("GRAPH_RECEIPTS_INCOMPLETE", "Graph review batch inventories must be explicit arrays.");
  const expected = new Set<string>();
  for (const key of params.expectedStepKeys) {
    stepKey(key);
    if (expected.has(key)) fail("GRAPH_RECEIPTS_INCOMPLETE", "Expected graph review steps must be unique.");
    expected.add(key);
  }
  if (receipts.length !== expected.size) fail("GRAPH_RECEIPTS_INCOMPLETE", "Every premium batch requires exactly one graph review receipt.");
  for (const value of receipts) {
    const receipt = snapshot(value);
    if (!sameScope(receipt.request.scope, params.scope)) fail("GRAPH_SCOPE_MISMATCH", "Graph review receipt belongs to a different analysis scope.");
    if (!expected.delete(receipt.request.stepKey)) fail("GRAPH_RECEIPTS_INCOMPLETE", "Graph review inventory contains an extra or duplicate step.");
  }
}

export type SyncOptions = {
  canPassRelation: (type: EntityRelationType, sourceType: string, targetType: string) => boolean;
  assertRelationSemantics: (relation: EntityRelationFinding, chunks: Array<{ id: string; sourceId: string; text: string }>) => void;
};
export type PremiumGraphSyncResult = {
  referenceIssues: WorldReferenceIssue[]; conflicts: CohesionFinding[];
  relationsSaved: number; rulesSaved: number; membershipsSaved: number; linksCreated: number;
  /** Exact relation payloads actually written and linked, for dossier display. */
  appliedRelations?: EntityRelationFinding[];
};
const normalized = (value: string) => value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
const order = (left: Planned, right: Planned) => left.entry.payloadFingerprint.localeCompare(right.entry.payloadFingerprint)
  || left.receipt.fingerprint.localeCompare(right.receipt.fingerprint) || left.entry.decision.id.localeCompare(right.entry.decision.id);
function competingRuleText(versions: Array<{ description: string; trigger: string; effect: string }>): string {
  const unique = [...new Set(versions.map((version) =>
    `when ${version.trigger || "no specific condition is stated"}, ${version.effect || "no effect is specified"}; described as ${version.description || "no description is supplied"}`,
  ))];
  return unique.slice(0, 3).map((version, index) => `${index === 0 ? "One account says" : "Another says"} ${version.slice(0, 420)}.`).join(" ").slice(0, 1_300);
}

type GraphWriteAuthority = {
  analysisRunId: string | null;
  entityReviewId?: string;
  targetEntityId?: string;
  frozenResolution?: { idsByName: Map<string, string | null>; types: Map<string, string> };
  blockedPayloadFingerprints?: Set<string>;
  conflicts?: CohesionFinding[];
};

async function saveLink(db: QueryDb, kind: "relation" | "rule", id: string, plan: Planned, authority: GraphWriteAuthority): Promise<number> {
  const table = kind === "relation" ? "world_entity_relation_verifications" : "world_entity_rule_verifications";
  const column = kind === "relation" ? "relation_id" : "rule_id";
  const sourceColumn = authority.entityReviewId ? "entity_review_id" : "run_id";
  const sourceId = authority.entityReviewId ?? authority.analysisRunId;
  const values = [id, sourceId, plan.receipt.request.stepKey, plan.entry.proposal.id, plan.entry.decision.id, plan.entry.payloadFingerprint];
  const saved = await db.query(`INSERT INTO storyhold.${table} (${column}, ${sourceColumn}, step_key, proposal_id, decision_id, payload_fingerprint)
    VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (${sourceColumn}, step_key, proposal_id) DO NOTHING RETURNING ${column}`, values);
  if (saved.rows.length) return 1;
  const existing = (await db.query<{ target_id: string; decision_id: string; payload_fingerprint: string }>(
    `SELECT ${column} AS target_id, decision_id, payload_fingerprint FROM storyhold.${table} WHERE ${sourceColumn} = $1 AND step_key = $2 AND proposal_id = $3`, values.slice(1, 4),
  )).rows[0];
  if (!existing || existing.target_id !== id || existing.decision_id !== plan.entry.decision.id || existing.payload_fingerprint !== plan.entry.payloadFingerprint) {
    fail("GRAPH_LINK_MISMATCH", "An immutable graph decision link conflicts with the materialized canonical record.");
  }
  return 0;
}

/** This is the sole typed graph writer for the current paid intake path. It
 * never derives edges from dossier strings, changes local extraction, deletes
 * omissions, or edits owner records. Receipts and canon share the caller TX.
 */
export async function syncPremiumVerifiedGraph(db: QueryDb, values: PremiumGraphReviewReceipt[], options: SyncOptions): Promise<PremiumGraphSyncResult> {
  const output: PremiumGraphSyncResult = { referenceIssues: [], conflicts: [], relationsSaved: 0, rulesSaved: 0, membershipsSaved: 0, linksCreated: 0 };
  if (!Array.isArray(values) || typeof options?.canPassRelation !== "function" || typeof options?.assertRelationSemantics !== "function") {
    fail("GRAPH_SYNC_INVALID", "An explicit graph receipt inventory, category compatibility policy, and relationship meaning check are required.");
  }
  if (!values.length) return output;
  const receipts = values.map(snapshot);
  const scope = receipts[0]!.request.scope;
  assertExpectedPremiumGraphReviews(receipts, { scope, expectedStepKeys: receipts.map((receipt) => receipt.request.stepKey) });
  const stored = new Map((await readPremiumGraphReviews(db, scope)).map((receipt) => [receipt.request.stepKey, receipt]));
  for (const receipt of receipts) {
    const saved = stored.get(receipt.request.stepKey);
    if (!saved || fullHash(saved) !== fullHash(receipt)) fail("GRAPH_RECEIPT_MISMATCH", "Canonical graph writes require the exact durably stored review receipt.");
  }
  return syncVerifiedGraph(db, receipts, options, { analysisRunId: scope.analysisRunId });
}

/** A dossier uses its real paid-call journal, never a synthetic analysis run.
 * The caller owns the canon + billing transaction and has already checked the
 * frozen world-context fingerprint. This gate additionally binds the exact
 * receipt and every graph endpoint to that call's frozen entity inventory. */
export async function syncEntityVerifiedGraph(
  db: QueryDb, scope: EntityReviewCallScope, value: PremiumGraphReviewReceipt | readonly PremiumGraphReviewReceipt[], options: SyncOptions,
): Promise<PremiumGraphSyncResult> {
  if (typeof options?.canPassRelation !== "function" || typeof options?.assertRelationSemantics !== "function") {
    fail("GRAPH_SYNC_INVALID", "Dossier graph writes require category and relationship meaning policies.");
  }
  const receipts = (Array.isArray(value) ? value : [value]).map(snapshot);
  if (!receipts.length) fail("GRAPH_RECEIPTS_INCOMPLETE", "Dossier graph writes require the complete nonempty page inventory.");
  const call = await readEntityReviewCall(db, scope);
  if (!call || call.status !== "completed" || call.finalization_snapshot !== null) {
    fail("ENTITY_GRAPH_CALL_UNAVAILABLE", "Dossier graph writes require an unfinalized completed paid call.");
  }
  const bundle = call.verification_snapshot;
  const stored = bundle?.version === 1 ? [bundle.graph] : bundle && (bundle.version === 2 || bundle.version === 3 || bundle.version === 4 || bundle.version === 5) ? bundle.graphs : undefined;
  if (!stored || fullHash(stored) !== fullHash(receipts)) {
    fail("GRAPH_RECEIPT_MISMATCH", "Dossier graph writes require the exact durably saved private verification bundle.");
  }
  assertExpectedPremiumGraphReviews(receipts, {
    scope: { worldId: scope.worldId, editionId: scope.editionId, analysisRunId: scope.reviewId },
    expectedStepKeys: receipts.map((receipt) => receipt.request.stepKey),
  });
  const input = call.context_snapshot.input as EntityReviewInput | undefined;
  if (call.context_snapshot.version !== 1 || !input || input.entity?.id !== scope.entityId
    || input.premiumStatScope?.worldId !== scope.worldId || input.premiumStatScope.editionId !== scope.editionId
    || input.premiumStatScope.analysisRunId !== scope.reviewId) {
    fail("ENTITY_GRAPH_CONTEXT_INVALID", "The dossier graph receipt must match its frozen review context.");
  }
  if (bundle!.version === 1) {
    if (input.graphReview?.version !== 1 || receipts.length !== 1) fail("GRAPH_RECEIPT_MISMATCH", "A legacy dossier proof cannot acquire a new page plan.");
    assertEntityGraphReview(input, receipts[0]!);
  } else {
    if (input.graphReview?.version !== 2) fail("GRAPH_RECEIPT_MISMATCH", "A paginated dossier proof requires its original frozen page plan.");
    assertEntityGraphReviews(input, receipts);
  }
  const frozen = input.graphReview!.entities;
  const current = (await db.query<{ id: string; name: string; entity_type: string; aliases: unknown;
    pull_status: string; scanner_present: boolean; merged_into_entity_id: string | null;
    classification_source: string; review_status: string }>(
    `SELECT id, name, entity_type, aliases, pull_status, scanner_present, merged_into_entity_id, classification_source, review_status
       FROM storyhold.world_entities WHERE world_id = $1 AND canon_edition_id = $2 FOR SHARE`,
    [scope.worldId, scope.editionId],
  )).rows;
  const byId = new Map(current.map((row) => [row.id, row]));
  const idsByName = new Map<string, string | null>();
  const types = new Map<string, string>();
  const dossierName = (name: string) => normalized(name.normalize("NFKC"));
  const add = (name: string, id: string) => {
    const key = dossierName(name); const previous = idsByName.get(key);
    idsByName.set(key, previous === undefined || previous === id ? id : null);
  };
  for (const entity of frozen) {
    const row = byId.get(entity.id);
    if (!row || row.name !== entity.name || row.entity_type !== entity.entityType || row.pull_status !== "active"
      || (row.scanner_present !== true && row.classification_source !== "user" && row.review_status !== "user_confirmed")
      || row.merged_into_entity_id !== null
      || fullHash(row.aliases) !== fullHash(entity.aliases)) {
      fail("ENTITY_GRAPH_CONTEXT_STALE", "A frozen dossier graph identity changed, disappeared, or is no longer active.");
    }
    types.set(entity.id, entity.entityType);
    add(entity.name, entity.id);
  }
  if (!types.has(scope.entityId)) fail("ENTITY_GRAPH_TARGET_MISMATCH", "The reviewed identity is missing from the frozen graph inventory.");
  for (const entity of frozen) for (const alias of entity.aliases) add(alias, entity.id);
  const conflicts = bundle!.version !== 1 ? dossierGraphConflicts(receipts) : undefined;
  return syncVerifiedGraph(db, receipts, options, { analysisRunId: null, entityReviewId: scope.reviewId,
    targetEntityId: scope.entityId, frozenResolution: { idsByName, types }, ...conflicts });
}

/** Both paid entry points use this exact planner, conflict policy, and writer. */
async function syncVerifiedGraph(db: QueryDb, receipts: PremiumGraphReviewReceipt[], options: SyncOptions, authority: GraphWriteAuthority): Promise<PremiumGraphSyncResult> {
  const output: PremiumGraphSyncResult = { referenceIssues: [], conflicts: structuredClone(authority.conflicts ?? []), relationsSaved: 0, rulesSaved: 0, membershipsSaved: 0, linksCreated: 0,
    ...(authority.entityReviewId ? { appliedRelations: [] } : {}) };
  const scope = receipts[0]!.request.scope;
  const nameKey = authority.frozenResolution ? (name: string) => normalized(name.normalize("NFKC")) : normalized;
  const resolution = authority.frozenResolution ?? await loadWorldEntityNameResolution({ db, worldId: scope.worldId, editionId: scope.editionId });
  const types = authority.frozenResolution?.types ?? new Map((await db.query<{ id: string; entity_type: string }>(
    "SELECT id, name, entity_type FROM storyhold.world_entities WHERE world_id = $1 AND canon_edition_id = $2", [scope.worldId, scope.editionId],
  )).rows.map((row) => [row.id, row.entity_type]));
  const relations = new Map<string, Array<Planned & { subjectId: string; targetId: string }>>();
  const rules = new Map<string, Array<Planned & { entityId: string }>>();
  const missing = (kind: WorldReferenceIssue["kind"], name: string, context: string) => output.referenceIssues.push({
    kind, label: name, context, resolution: resolution.idsByName.get(nameKey(name)) === null ? "ambiguous" : "missing",
  });
  const conflict = (subject: string, summary: string, plans: Planned[]) => output.conflicts.push({
    kind: "contradiction", subject, summary, severity: "conflict", evidence: plans.flatMap((plan) => plan.evidence).slice(0, 12),
  });
  for (const receipt of receipts) {
    const anchors = new Map(receipt.packet.evidence.map((anchor) => [anchor.id, anchor]));
    for (const entry of buildVerifiedPromotionPlan(receipt.packet, receipt.decisions, receipt.batch)) {
      const evidence = entry.decision.supportingEvidenceIds.map((id) => anchors.get(id)).filter((anchor) => anchor !== undefined)
        .map((anchor) => ({ chunkId: anchor.chunkId, sourceId: anchor.sourceId, quote: anchor.quote }));
      if (!evidence.length) fail("GRAPH_RECEIPT_INVALID", "Verified graph decisions require supporting manuscript evidence.");
      const plan: Planned = { receipt, entry, evidence };
      if (entry.proposal.kind === "relation") {
        const relation = entry.payload as unknown as RelationPayload;
        // Check every authorized candidate before selecting a representative. A
        // semantically invalid alternative cannot hide behind a valid alias or
        // paraphrase, and the checked meaning must never be silently rewritten.
        options.assertRelationSemantics({ ...relation, evidence, confidence: entry.decision.confidence, reviewStatus: "verified" }, receipt.request.chunks);
        const subjectId = localEntityTextIsUseful(relation.subject) ? resolution.idsByName.get(nameKey(relation.subject)) : undefined;
        const targetId = localEntityTextIsUseful(relation.target) ? resolution.idsByName.get(nameKey(relation.target)) : undefined;
        if (authority.targetEntityId && (!subjectId || !targetId || subjectId === targetId
          || (subjectId !== authority.targetEntityId && targetId !== authority.targetEntityId))) {
          fail("ENTITY_GRAPH_TARGET_MISMATCH", "Dossier relationships must resolve to the reviewed identity and its frozen counterparts.");
        }
        if (!subjectId) missing("relation_subject", relation.subject, `${relation.subject} ${relation.relationType} ${relation.target}`);
        if (!targetId) missing("relation_target", relation.target, `${relation.subject} ${relation.relationType} ${relation.target}`);
        if (!subjectId || !targetId || subjectId === targetId) continue;
        if (!options.canPassRelation(relation.relationType, types.get(subjectId) ?? "", types.get(targetId) ?? "")) {
          output.referenceIssues.push({ kind: "relation_target", label: relation.target, resolution: "ambiguous", context: `Relation ${relation.relationType} is incompatible with the resolved endpoint categories.` });
          continue;
        }
        if (authority.blockedPayloadFingerprints?.has(entry.payloadFingerprint)) continue;
        const key = JSON.stringify([subjectId, relation.relationType, targetId, relation.status, relation.validFromLabel, relation.validUntilLabel]);
        const group = relations.get(key) ?? []; group.push({ ...plan, subjectId, targetId }); relations.set(key, group);
      } else if (entry.proposal.kind === "rule") {
        const rule = entry.payload as unknown as RulePayload;
        const entityId = localEntityTextIsUseful(rule.entity) ? resolution.idsByName.get(nameKey(rule.entity)) : undefined;
        if (authority.targetEntityId && entityId !== authority.targetEntityId) {
          fail("ENTITY_GRAPH_TARGET_MISMATCH", "Dossier rules must belong to the exact reviewed identity.");
        }
        if (!entityId) { missing("entity_rule", rule.entity, rule.name); continue; }
        if (authority.blockedPayloadFingerprints?.has(entry.payloadFingerprint)) continue;
        const key = JSON.stringify([entityId, rule.ruleKind, normalized(rule.name)]);
        const group = rules.get(key) ?? []; group.push({ ...plan, entityId }); rules.set(key, group);
      } else fail("GRAPH_RECEIPT_INVALID", "Only verified relation and rule decisions may enter the graph writer.");
    }
  }
  for (const key of [...relations.keys()].sort()) {
    const plan = relations.get(key)!.sort(order)[0]!;
    const relation = plan.entry.payload as unknown as RelationPayload;
    const saved = await db.query<{ id: string }>(`INSERT INTO storyhold.world_entity_relations
      (id, world_id, canon_edition_id, source_entity_id, relation_type, target_entity_id, relation_status,
       summary, valid_from_label, valid_until_label, evidence, assignment_source, confidence, source_analysis_run_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'ai', $12, $13)
      ON CONFLICT (world_id, canon_edition_id, source_entity_id, relation_type, target_entity_id, relation_status, valid_from_label, valid_until_label)
      DO UPDATE SET summary = EXCLUDED.summary, evidence = EXCLUDED.evidence, confidence = EXCLUDED.confidence,
        assignment_source = 'ai', source_analysis_run_id = EXCLUDED.source_analysis_run_id, updated_at = now()
      WHERE storyhold.world_entity_relations.assignment_source <> 'user' RETURNING id`,
    [randomUUID(), scope.worldId, scope.editionId, plan.subjectId, relation.relationType, plan.targetId, relation.status,
      relation.summary, relation.validFromLabel, relation.validUntilLabel, JSON.stringify(plan.evidence), plan.entry.decision.confidence, authority.analysisRunId]);
    const id = saved.rows[0]?.id;
    if (!id) continue;
    output.relationsSaved += 1;
    output.linksCreated += await saveLink(db, "relation", id, plan, authority);
    output.appliedRelations?.push({ ...relation, evidence: plan.evidence, confidence: plan.entry.decision.confidence, reviewStatus: "verified" });
    if (canProjectCurrentFactionMembership(relation, types.get(plan.targetId), types.get(plan.subjectId))) {
      const membership = await db.query(`INSERT INTO storyhold.world_entity_faction_memberships (entity_id, faction_entity_id, assignment_source, confidence, evidence)
        VALUES ($1, $2, 'ai', $3, $4::jsonb) ON CONFLICT (entity_id, faction_entity_id) DO UPDATE SET assignment_source = 'ai',
        confidence = EXCLUDED.confidence, evidence = EXCLUDED.evidence, updated_at = now()
        WHERE storyhold.world_entity_faction_memberships.assignment_source <> 'user' RETURNING entity_id`,
      [plan.subjectId, plan.targetId, plan.entry.decision.confidence, JSON.stringify(plan.evidence)]);
      output.membershipsSaved += membership.rows.length;
    }
  }
  for (const key of [...rules.keys()].sort()) {
    const group = rules.get(key)!.sort(order);
    const plan = group[0]!;
    const rule = plan.entry.payload as unknown as RulePayload;
    const semantics = (value: RulePayload) => fullHash({ name: normalized(value.name), ruleKind: value.ruleKind, description: value.description, trigger: value.trigger, effect: value.effect });
    if (new Set(group.map((item) => semantics(item.entry.payload as unknown as RulePayload))).size !== 1) {
      conflict(`${rule.entity}: ${rule.name}`, `The passages disagree about ${rule.name}. ${competingRuleText(group.map((item) => item.entry.payload as unknown as RulePayload))} Clarify which description, conditions, and effects apply before treating this as a settled rule.`, group);
      continue;
    }
    const existing = await db.query<{ id: string; canonical_key: string; name: string; rule_kind: string; description: string; trigger_text: string; effect_text: string; assignment_source: string; rule_status: string }>(
      "SELECT * FROM storyhold.world_entity_rules WHERE world_id = $1 AND canon_edition_id = $2 AND entity_id = $3 FOR UPDATE", [scope.worldId, scope.editionId, plan.entityId],
    );
    const matches = existing.rows.filter((row) => row.rule_kind === rule.ruleKind && normalized(row.name) === normalized(rule.name)).sort((a, b) => a.id.localeCompare(b.id));
    if (matches.some((row) => row.assignment_source === "user")) continue;
    const comparedBehaviors = [...matches.map((row) => ({ description: row.description, trigger: row.trigger_text, effect: row.effect_text })),
      { description: rule.description, trigger: rule.trigger, effect: rule.effect }];
    // An unedited local rule is a baseline proposal, so one unambiguous active
    // match may be corrected by this exact verified result. Previously verified
    // or owner-managed canon has no implicit supersession contract.
    const upgradesLocalBaseline = matches.length === 1 && matches[0]!.assignment_source === "local" && matches[0]!.rule_status === "active";
    if (matches.some((row) => row.rule_status !== "active") || (!upgradesLocalBaseline && new Set(comparedBehaviors.map(fullHash)).size > 1)) {
      const previousStatuses = [...new Set(matches.filter((row) => row.rule_status !== "active").map((row) => row.rule_status))];
      const reason = previousStatuses.length
        ? `${rule.name} was previously marked ${previousStatuses.join(" or ")}.`
        : `The saved rule and the new passage disagree about ${rule.name}.`;
      conflict(`${rule.entity}: ${rule.name}`, `${reason} ${competingRuleText(comparedBehaviors)} The saved rule is unchanged. Resolve these differences${previousStatuses.length ? " and its status" : ""} before treating it as settled.`, group);
      continue;
    }
    const canonicalKey = matches[0]?.canonical_key ?? `premium-rule-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
    const saved = await db.query<{ id: string }>(`INSERT INTO storyhold.world_entity_rules
      (id, world_id, canon_edition_id, entity_id, canonical_key, name, description, rule_kind, trigger_text, effect_text,
       evidence, assignment_source, confidence, source_analysis_run_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'ai', $12, $13)
      ON CONFLICT (world_id, canon_edition_id, entity_id, canonical_key) DO UPDATE SET name = EXCLUDED.name,
        description = EXCLUDED.description, rule_kind = EXCLUDED.rule_kind, trigger_text = EXCLUDED.trigger_text,
        effect_text = EXCLUDED.effect_text, evidence = EXCLUDED.evidence, confidence = EXCLUDED.confidence,
        assignment_source = 'ai', source_analysis_run_id = EXCLUDED.source_analysis_run_id, updated_at = now()
      WHERE storyhold.world_entity_rules.assignment_source <> 'user' RETURNING id`,
    [matches[0]?.id ?? randomUUID(), scope.worldId, scope.editionId, plan.entityId, canonicalKey, rule.name, rule.description,
      rule.ruleKind, rule.trigger, rule.effect, JSON.stringify(plan.evidence), plan.entry.decision.confidence, authority.analysisRunId]);
    const id = saved.rows[0]?.id;
    if (!id) continue;
    output.rulesSaved += 1;
    output.linksCreated += await saveLink(db, "rule", id, plan, authority);
  }
  return output;
}

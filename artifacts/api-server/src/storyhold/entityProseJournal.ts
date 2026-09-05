import type { PGlite } from "@electric-sql/pglite";
import { buildVerifiedPromotionPlan, canonPayloadFingerprint, type JsonObject } from "./analysisVerificationContracts";
import { assertEntityProseReview, type EntityProseReviewReceipt } from "./entityProseVerification";
import type { EntityReviewInput } from "./entityReview";
import { readEntityReviewCall, type EntityReviewCallScope } from "./entityReviewJournal";
import { knowledgeClaimFingerprint, syncWorldKnowledgeClaims, type KnowledgeEvidence, type WorldReferenceIssue } from "./worldKnowledge";

type QueryDb = Pick<PGlite, "query">;
const hash = (value: unknown) => canonPayloadFingerprint(value as JsonObject);
const label = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
const evidenceKey = (value: KnowledgeEvidence) => `${value.chunkId}\u0000${value.sourceId}\u0000${label(value.quote)}`;
const fieldLabel = (field: string) => field === "moralSystem" ? "moral outlook" : field === "physicalCharacteristics"
  ? "physical description" : field.replace(/([a-z])([A-Z])/g, "$1 $2").toLocaleLowerCase();

export type EntityProseSyncResult = {
  claimsSaved: number;
  linksCreated: number;
  appliedClaimIds: string[];
  appliedProposalIds: Set<string>;
  referenceIssues: WorldReferenceIssue[];
  warnings: string[];
};
export class EntityProseJournalError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "EntityProseJournalError"; }
}
function fail(code: string, message: string): never { throw new EntityProseJournalError(code, message); }

/** Add dossier provenance without rewriting historical intake receipts/links.
 * Run after both the claim ledger and paid dossier journal schemas exist. */
export async function ensureEntityReviewClaimLinks(db: Pick<PGlite, "exec">): Promise<void> {
  await db.exec(`
    ALTER TABLE storyhold.world_knowledge_claim_verifications ADD COLUMN IF NOT EXISTS entity_review_id uuid;
    ALTER TABLE storyhold.world_knowledge_claim_verifications DROP CONSTRAINT IF EXISTS world_knowledge_claim_verifications_pkey;
    ALTER TABLE storyhold.world_knowledge_claim_verifications ALTER COLUMN run_id DROP NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS world_knowledge_claim_verifications_run_proposal
      ON storyhold.world_knowledge_claim_verifications(run_id, step_key, proposal_id);
    CREATE UNIQUE INDEX IF NOT EXISTS world_knowledge_claim_verifications_entity_proposal
      ON storyhold.world_knowledge_claim_verifications(entity_review_id, step_key, proposal_id);
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'world_knowledge_claim_verifications_entity_review_fk'
        AND conrelid = 'storyhold.world_knowledge_claim_verifications'::regclass) THEN
        ALTER TABLE storyhold.world_knowledge_claim_verifications ADD CONSTRAINT world_knowledge_claim_verifications_entity_review_fk
          FOREIGN KEY (entity_review_id) REFERENCES storyhold.entity_review_ai_calls(review_id) ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'world_knowledge_claim_verifications_exact_source'
        AND conrelid = 'storyhold.world_knowledge_claim_verifications'::regclass) THEN
        ALTER TABLE storyhold.world_knowledge_claim_verifications ADD CONSTRAINT world_knowledge_claim_verifications_exact_source
          CHECK ((run_id IS NULL) <> (entity_review_id IS NULL));
      END IF;
    END $$;
  `);
}

/** This is a caller-owned canon + accounting transaction. A receipt's validity
 * is not sufficient: the same receipt must be the private proof of the actual
 * completed paid response, and only actual successful canonical writes may be
 * projected into the customer dossier. */
export async function syncEntityVerifiedProse(db: QueryDb, scope: EntityReviewCallScope,
  receipt: EntityProseReviewReceipt): Promise<EntityProseSyncResult> {
  const result: EntityProseSyncResult = { claimsSaved: 0, linksCreated: 0, appliedClaimIds: [],
    appliedProposalIds: new Set(), referenceIssues: [], warnings: [] };
  const call = await readEntityReviewCall(db, scope);
  if (!call || call.status !== "completed" || call.finalization_snapshot !== null) {
    fail("ENTITY_PROSE_CALL_UNAVAILABLE", "Dossier prose requires an unfinalized completed paid review.");
  }
  if ((call.verification_snapshot?.version !== 3 && call.verification_snapshot?.version !== 4 && call.verification_snapshot?.version !== 5)
    || hash(call.verification_snapshot.prose) !== hash(receipt)) {
    fail("ENTITY_PROSE_RECEIPT_MISMATCH", "Dossier prose requires the exact saved private claim proof.");
  }
  const input = call.context_snapshot.input as unknown as EntityReviewInput;
  if (call.context_snapshot.version !== 1 || !input || input.entity?.id !== scope.entityId
    || input.premiumStatScope?.worldId !== scope.worldId || input.premiumStatScope.editionId !== scope.editionId
    || input.premiumStatScope.analysisRunId !== scope.reviewId || input.proseReview?.version !== 1 || !input.graphReview) {
    fail("ENTITY_PROSE_CONTEXT_INVALID", "The prose review does not match the paid dossier's frozen target and scope.");
  }
  assertEntityProseReview(input, receipt);
  const request = receipt.claimReceipt.request;
  if (request.scope.worldId !== scope.worldId || request.scope.editionId !== scope.editionId
    || request.scope.analysisRunId !== scope.reviewId) fail("ENTITY_PROSE_SCOPE_MISMATCH", "The prose claim scope changed.");

  const current = (await db.query<{ id: string; name: string; entity_type: string; aliases: unknown;
    pull_status: string; scanner_present: boolean; merged_into_entity_id: string | null;
    classification_source: string; review_status: string; dossier_id: string | null }>(
    `SELECT id, name, entity_type, aliases, pull_status, scanner_present, merged_into_entity_id,
       classification_source, review_status, dossier_id FROM storyhold.world_entities
       WHERE world_id = $1 AND canon_edition_id = $2 FOR SHARE`, [scope.worldId, scope.editionId],
  )).rows;
  const byId = new Map(current.map((entity) => [entity.id, entity]));
  const names = new Map<string, string | null>();
  const add = (name: string, id: string) => {
    const key = label(name); const previous = names.get(key);
    names.set(key, previous === undefined || previous === id ? id : null);
  };
  for (const entity of input.graphReview.entities) {
    const row = byId.get(entity.id);
    if (!row || row.name !== entity.name || row.entity_type !== entity.entityType || hash(row.aliases) !== hash(entity.aliases)
      || row.pull_status !== "active" || row.merged_into_entity_id !== null
      || (row.scanner_present !== true && row.classification_source !== "user" && row.review_status !== "user_confirmed")) {
      fail("ENTITY_PROSE_CONTEXT_STALE", "A frozen prose-review identity changed or is no longer eligible.");
    }
    add(entity.name, entity.id);
    for (const alias of entity.aliases) add(alias, entity.id);
  }
  const target = byId.get(scope.entityId);
  if (!target || !input.graphReview.entities.some((entity) => entity.id === scope.entityId)
    || names.get(label(input.entity.name)) !== scope.entityId) {
    fail("ENTITY_PROSE_TARGET_MISMATCH", "The prose subject cannot resolve to its exact frozen identity.");
  }
  // Owner changes retain their authority even when a verified model statement
  // is plausible. Audit receipts remain saved, but no AI field is installed.
  if (target.classification_source === "user" || target.review_status === "user_confirmed") {
    result.warnings.push("Author-controlled dossier prose was preserved; the AI review did not replace it.");
    return result;
  }
  if (target.dossier_id) {
    const dossier = (await db.query<{ user_edited_at: unknown }>(`SELECT user_edited_at FROM storyhold.character_dossiers
      WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3 FOR SHARE`,
    [target.dossier_id, scope.worldId, scope.editionId])).rows[0];
    if (!dossier) fail("ENTITY_PROSE_TARGET_MISMATCH", "The reviewed character dossier no longer matches its world.");
    if (dossier.user_edited_at != null) {
      result.warnings.push("Your edited dossier was preserved; the AI review did not replace its prose.");
      return result;
    }
  }
  const ownerFields = new Set((await db.query<{ predicate: string }>(`SELECT predicate FROM storyhold.world_knowledge_claims
    WHERE world_id = $1 AND canon_edition_id = $2 AND subject_entity_id = $3 AND assignment_source = 'user' FOR SHARE`,
  [scope.worldId, scope.editionId, scope.entityId])).rows.map((claim) => label(claim.predicate)));
  const warned = new Set<string>();
  const anchors = new Map(receipt.claimReceipt.packet.evidence.map((anchor) => [anchor.id, anchor]));
  for (const entry of buildVerifiedPromotionPlan(receipt.claimReceipt.packet, receipt.claimReceipt.decisions, receipt.claimReceipt.batch)) {
    const item = receipt.projection.find((value) => value.proposalId === entry.proposal.id);
    if (!item) fail("ENTITY_PROSE_PROJECTION_INVALID", "An approved claim is absent from its verified display projection.");
    const claim = item.claim;
    if (claim.supersedes || names.get(label(claim.subject)) !== scope.entityId) {
      fail("ENTITY_PROSE_TARGET_MISMATCH", "Dossier prose cannot supersede other canon or write another subject.");
    }
    if (ownerFields.has(label(claim.predicate))) {
      if (!warned.has(item.field)) result.warnings.push(`Your author-controlled ${fieldLabel(item.field)} field was preserved.`);
      warned.add(item.field); continue;
    }
    if (claim.epistemicHolder && !names.get(label(claim.epistemicHolder))) {
      result.referenceIssues.push({ kind: "claim_epistemic_holder", label: claim.epistemicHolder,
        resolution: names.get(label(claim.epistemicHolder)) === null ? "ambiguous" : "missing", context: item.text });
      continue;
    }
    const evidence = entry.decision.supportingEvidenceIds.map((id) => {
      const anchor = anchors.get(id);
      if (!anchor) fail("ENTITY_PROSE_EVIDENCE_INVALID", "A verified prose claim has lost its evidence.");
      return { chunkId: anchor.chunkId, sourceId: anchor.sourceId, quote: anchor.quote };
    });
    let applied: { claimId: string; fingerprint: string } | undefined;
    const synced = await syncWorldKnowledgeClaims({ db, worldId: scope.worldId, editionId: scope.editionId, runId: null,
      resolvedEntityIdsByName: names, assignmentSource: "ai", preserveUnreviewedAiClaims: true,
      claims: [{ subject: claim.subject, predicate: claim.predicate, object: claim.value, polarity: claim.polarity,
        epistemicHolder: claim.epistemicHolder || undefined, truthStatus: claim.truthStatus,
        validFromLabel: claim.validFromLabel, validUntilLabel: claim.validUntilLabel,
        summary: item.text, evidence, confidence: entry.decision.confidence }],
      onClaimApplied: (value) => { applied = value; },
    });
    result.referenceIssues.push(...synced.referenceIssues);
    if (!applied) continue;
    const actual = (await db.query<{ id: string; fingerprint: string; subject_entity_id: string; predicate: string;
      polarity: "positive" | "negative"; object_entity_id: string | null; object_text: string;
      epistemic_holder_entity_id: string | null; truth_status: typeof claim.truthStatus; valid_from_label: string;
      valid_until_label: string; evidence: KnowledgeEvidence[]; assignment_source: string }>(
      `SELECT * FROM storyhold.world_knowledge_claims WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3 FOR UPDATE`,
      [applied.claimId, scope.worldId, scope.editionId],
    )).rows[0];
    if (!actual || actual.assignment_source === "user" || actual.fingerprint !== applied.fingerprint
      || actual.subject_entity_id !== scope.entityId || actual.predicate !== claim.predicate || actual.object_entity_id !== null
      || actual.object_text !== claim.value || actual.polarity !== claim.polarity || actual.truth_status !== claim.truthStatus
      || actual.epistemic_holder_entity_id !== (claim.epistemicHolder ? names.get(label(claim.epistemicHolder)) : null)
      || actual.valid_from_label !== claim.validFromLabel || actual.valid_until_label !== claim.validUntilLabel
      || knowledgeClaimFingerprint({ subjectEntityId: actual.subject_entity_id, predicate: actual.predicate,
        polarity: actual.polarity, objectEntityId: actual.object_entity_id, objectText: actual.object_text,
        epistemicHolderEntityId: actual.epistemic_holder_entity_id, truthStatus: actual.truth_status,
        validFromLabel: actual.valid_from_label, validUntilLabel: actual.valid_until_label }) !== applied.fingerprint) {
      fail("ENTITY_PROSE_CANON_MISMATCH", "The saved claim no longer matches the verified prose identity.");
    }
    const retained = new Set(Array.isArray(actual.evidence) ? actual.evidence.map(evidenceKey) : []);
    if (!evidence.length || evidence.some((anchor) => !retained.has(evidenceKey(anchor)))) {
      fail("ENTITY_PROSE_EVIDENCE_INVALID", `The ${fieldLabel(item.field)} update could not retain all of its supporting passages; no changes were applied.`);
    }
    const values = [actual.id, scope.reviewId, request.stepKey, entry.proposal.id, entry.decision.id, entry.payloadFingerprint];
    const inserted = await db.query(`INSERT INTO storyhold.world_knowledge_claim_verifications
      (claim_id, entity_review_id, step_key, proposal_id, decision_id, payload_fingerprint)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (entity_review_id,step_key,proposal_id) DO NOTHING RETURNING claim_id`, values);
    if (inserted.rows.length) result.linksCreated += 1;
    else {
      const saved = (await db.query<{ claim_id: string; decision_id: string; payload_fingerprint: string }>(
        `SELECT claim_id,decision_id,payload_fingerprint FROM storyhold.world_knowledge_claim_verifications
          WHERE entity_review_id=$1 AND step_key=$2 AND proposal_id=$3`, values.slice(1, 4))).rows[0];
      if (!saved || saved.claim_id !== actual.id || saved.decision_id !== entry.decision.id || saved.payload_fingerprint !== entry.payloadFingerprint) {
        fail("ENTITY_PROSE_LINK_MISMATCH", "A different immutable prose application link already exists.");
      }
    }
    result.claimsSaved += 1;
    result.appliedClaimIds.push(actual.id);
    result.appliedProposalIds.add(entry.proposal.id);
  }
  result.appliedClaimIds = [...new Set(result.appliedClaimIds)];
  return result;
}

import type { PGlite } from "@electric-sql/pglite";
import { canonPayloadFingerprint, type JsonObject } from "./analysisVerificationContracts";
import { approvedEntityCompassEstimate, assertEntityCompassReview,
  type EntityCompassApprovedEstimate, type EntityCompassReviewReceipt } from "./entityCompassVerification";
import type { EntityReviewInput } from "./entityReview";
import { EntityReviewJournalError, readEntityReviewCall, type EntityReviewCallScope } from "./entityReviewJournal";

type QueryDb = Pick<PGlite, "query">;
export type EntityCompassStatusScope = Omit<EntityReviewCallScope, "reviewId">;
export type EntityCompassSyncResult = { saved: boolean; dossierId: string | null; warnings: string[] };
export type EntityCompassStatus = {
  status: "supported" | "needs_attention" | "needs_evidence" | "not_reviewed" | "author_controlled";
  estimate?: EntityCompassApprovedEstimate & { epistemicHolderName?: string };
  evidence: EntityCompassReviewReceipt["decision"]["supportingEvidence"];
  explanation?: string;
  retrievalRequests?: string[];
};
type Target = {
  id: string; name: string; entity_type: string; dossier_id: string; dossier_name: string;
  classification_source: string; review_status: string; scanner_present: boolean;
  user_edited_at: unknown; axis_user_override: unknown; axis_estimate: unknown;
};
const hash = (value: unknown) => canonPayloadFingerprint(value as JsonObject);
export class EntityCompassPersistenceError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "EntityCompassPersistenceError"; }
}
function fail(code: string, message: string): never { throw new EntityCompassPersistenceError(code, message); }

async function targetFor(db: QueryDb, scope: EntityCompassStatusScope, lock = false): Promise<Target | undefined> {
  return (await db.query<Target>(`SELECT entity.id,entity.name,entity.entity_type,entity.dossier_id,
      entity.classification_source,entity.review_status,entity.scanner_present,dossier.name AS dossier_name,
      dossier.user_edited_at,dossier.axis_user_override,dossier.axis_estimate
    FROM storyhold.world_entities entity JOIN storyhold.worlds world ON world.id=entity.world_id
    JOIN storyhold.character_dossiers dossier ON dossier.id=entity.dossier_id
      AND dossier.world_id=entity.world_id AND dossier.canon_edition_id=entity.canon_edition_id
    WHERE entity.id=$1 AND entity.world_id=$2 AND entity.canon_edition_id=$3 AND world.owner_player_id=$4
      AND entity.entity_type='character' AND entity.pull_status='active' AND entity.merged_into_entity_id IS NULL
      AND dossier.dossier_status='active'${lock ? " FOR SHARE OF entity,world,dossier" : ""}`,
  [scope.entityId, scope.worldId, scope.editionId, scope.playerId])).rows[0];
}
function ownerControlled(target: Target): boolean {
  return target.classification_source === "user" || target.review_status === "user_confirmed"
    || target.user_edited_at != null || target.axis_user_override != null;
}
function sameTarget(target: Target, input: EntityReviewInput, snapshot: JsonObject): boolean {
  const frozenEntity = snapshot.entityRow;
  const dossierId = frozenEntity && typeof frozenEntity === "object" && !Array.isArray(frozenEntity) ? frozenEntity.dossier_id : undefined;
  return target.id === input.entity.id && target.name === input.entity.name && target.entity_type === input.entity.entityType
    && target.dossier_id === dossierId
    && target.dossier_name === (input.currentCharacter?.name ?? input.entity.name)
    && (target.scanner_present === true || ownerControlled(target));
}
async function currentSourcesMatch(db: QueryDb, scope: EntityCompassStatusScope, input: EntityReviewInput, lock: boolean): Promise<boolean> {
  const chunks = (await db.query<{ id: string; source_id: string; content: string }>(`SELECT chunk.id,chunk.source_id,chunk.content
    FROM storyhold.world_source_chunks chunk JOIN storyhold.world_sources source ON source.id=chunk.source_id
    WHERE chunk.id=ANY($1::uuid[]) AND chunk.world_id=$2 AND chunk.canon_edition_id=$3
      AND source.world_id=$2 AND source.canon_edition_id=$3 AND source.processing_status='ready'
      AND source.canon_status IN ('candidate','canon') AND source.source_kind='manuscript'${lock ? " FOR SHARE OF chunk,source" : ""}`,
  [input.chunks.map((chunk) => chunk.id), scope.worldId, scope.editionId])).rows;
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  return input.chunks.length > 0 && input.chunks.every((chunk) => byId.get(chunk.id)?.source_id === chunk.sourceId
    && byId.get(chunk.id)?.content === chunk.content);
}

/** Caller owns the canon/accounting transaction. Only the exact supported
 * tuple from this completed paid response may update the compass; an audit
 * that finds insufficient evidence never resets or replaces the old estimate. */
export async function syncEntityVerifiedCompass(db: QueryDb, scope: EntityReviewCallScope,
  receipt: EntityCompassReviewReceipt): Promise<EntityCompassSyncResult> {
  const result: EntityCompassSyncResult = { saved: false, dossierId: null, warnings: [] };
  const call = await readEntityReviewCall(db, scope);
  if (!call || call.status !== "completed" || call.finalization_snapshot !== null) {
    fail("COMPASS_CALL_UNAVAILABLE", "Dossier compass requires an unfinalized completed paid review.");
  }
  if (call.verification_snapshot?.version !== 5 || hash(call.verification_snapshot.compass) !== hash(receipt)) {
    fail("COMPASS_RECEIPT_MISMATCH", "Dossier compass requires the exact saved private interpretation proof.");
  }
  const input = call.context_snapshot.input as unknown as EntityReviewInput;
  assertEntityCompassReview(input, receipt);
  const target = await targetFor(db, scope, true);
  if (!target || !sameTarget(target, input, call.context_snapshot)) fail("COMPASS_TARGET_STALE", "The compass target no longer matches its frozen dossier.");
  result.dossierId = target.dossier_id;
  if (ownerControlled(target) || input.compassReview?.ownerOverride != null) {
    result.warnings.push("Your author-controlled compass was preserved; the AI did not replace it.");
    return result;
  }
  if (!await currentSourcesMatch(db, scope, input, true)) fail("COMPASS_SOURCE_STALE", "The compass source passages changed after this review began.");
  const estimate = approvedEntityCompassEstimate(input, receipt);
  if (!estimate) {
    result.warnings.push(receipt.decision.verdict === "needs_more_evidence"
      ? "The compass needs more evidence. Your existing estimate was preserved."
      : "The compass interpretation needs attention. Your existing estimate was preserved.");
    return result;
  }
  if (hash(target.axis_estimate) !== hash(input.compassReview!.currentEstimate)) {
    fail("COMPASS_ESTIMATE_STALE", "The stored compass changed after this review began.");
  }
  const saved = await db.query<{ id: string }>(`UPDATE storyhold.character_dossiers SET axis_estimate=$4::jsonb,updated_at=now()
    WHERE id=$1 AND world_id=$2 AND canon_edition_id=$3 AND dossier_status='active'
      AND user_edited_at IS NULL AND axis_user_override IS NULL AND axis_estimate=$5::jsonb RETURNING id`,
  [target.dossier_id, scope.worldId, scope.editionId, JSON.stringify(estimate), JSON.stringify(target.axis_estimate)]);
  if (saved.rows.length !== 1) fail("COMPASS_ESTIMATE_STALE", "The stored compass changed before its verified interpretation could be saved.");
  result.saved = true;
  return result;
}

/** An interpretation is shown as supported only while the exact applied tuple
 * and its manuscript context remain unchanged. A newer applicable unresolved
 * judgment takes precedence over an older reassuring green status. */
export async function readEntityCompassStatus(db: QueryDb, scope: EntityCompassStatusScope): Promise<EntityCompassStatus> {
  const empty: EntityCompassStatus = { status: "not_reviewed", evidence: [] };
  const target = await targetFor(db, scope);
  if (!target) return empty;
  if (ownerControlled(target)) return { status: "author_controlled", evidence: [], explanation: "The world author controls this compass." };
  const finalized = (await db.query<{ review_id: string }>(`SELECT review_id FROM storyhold.entity_review_ai_calls
    WHERE world_id=$1 AND edition_id=$2 AND entity_id=$3 AND player_id=$4
      AND status='completed' AND finalization_snapshot IS NOT NULL
    ORDER BY finalized_at DESC NULLS LAST,review_id DESC`,
  [scope.worldId, scope.editionId, scope.entityId, scope.playerId])).rows;
  for (const saved of finalized) {
    let call;
    try { call = await readEntityReviewCall(db, { ...scope, reviewId: saved.review_id }); }
    catch (error) { if (!(error instanceof EntityReviewJournalError)) throw error; continue; }
    if (!call || call.verification_snapshot?.version !== 5 || call.finalization_snapshot?.reviewed !== true
      || call.finalization_snapshot.entityId !== scope.entityId) continue;
    const input = call.context_snapshot.input as unknown as EntityReviewInput;
    if (!sameTarget(target, input, call.context_snapshot) || input.compassReview?.ownerOverride != null) continue;
    const receipt = call.verification_snapshot.compass;
    const estimate = approvedEntityCompassEstimate(input, receipt);
    const applicableEstimate = estimate ?? input.compassReview!.currentEstimate;
    if (hash(target.axis_estimate) !== hash(applicableEstimate)) continue;
    if (!await currentSourcesMatch(db, scope, input, false)) return { ...empty,
      explanation: "The passages used to review this compass changed or are unavailable. It needs a fresh review." };
    const decision = receipt.decision;
    if (!estimate) return {
      status: decision.verdict === "needs_more_evidence" ? "needs_evidence" : "needs_attention",
      explanation: decision.explanation,
      evidence: structuredClone([...decision.supportingEvidence, ...decision.contradictingEvidence]),
      retrievalRequests: [...decision.retrievalRequests],
    };
    const holder = estimate.epistemicHolderId ? input.graphReview!.entities.find((entity) => entity.id === estimate.epistemicHolderId) : undefined;
    return { status: "supported", estimate: { ...structuredClone(estimate), ...(holder ? { epistemicHolderName: holder.name } : {}) },
      explanation: decision.explanation, evidence: structuredClone(decision.supportingEvidence), retrievalRequests: [...decision.retrievalRequests] };
  }
  return empty;
}

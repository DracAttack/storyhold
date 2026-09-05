import type { PGlite } from "@electric-sql/pglite";
import { canonPayloadFingerprint, type JsonObject } from "./analysisVerificationContracts";
import type { EntityExistingProseItem, EntityExistingProseReviewContext } from "./entityExistingProseReview";
import { EntityReviewJournalError, readEntityReviewCall } from "./entityReviewJournal";
import type { EntityReviewInput } from "./entityReview";
import type { AnalysisChunk } from "./worldAnalysis";

type QueryDb = Pick<PGlite, "query">;
export type EntityProseRetrievalScope = { worldId: string; editionId: string; entityId: string; playerId: string };
export type EntityProseRetrievalLead = {
  item: EntityExistingProseItem;
  reviewId: string;
  requests: string[];
  previousChunks: AnalysisChunk[];
};
const hash = (value: unknown) => canonPayloadFingerprint(value as JsonObject);
const fieldKey = (item: EntityExistingProseItem) => `${item.origin}\u0000${item.field}`;
function fields(items: readonly EntityExistingProseItem[]): Map<string, EntityExistingProseItem[]> {
  const grouped = new Map<string, EntityExistingProseItem[]>();
  for (const item of items) {
    const key = fieldKey(item), entries = grouped.get(key) ?? [];
    entries.push(item); grouped.set(key, entries);
  }
  return grouped;
}

/** Previous audits supply search leads, never proof. Read the full scoped
 * history so an older unresolved item cannot override a newer judgment. Do
 * not inspect current sources here: the caller may deliberately search newly
 * added or edited text, comparing it with the exact previous chunks below. */
export async function loadEntityProseRetrievalLeads(db: QueryDb, scope: EntityProseRetrievalScope,
  currentInventory: EntityExistingProseReviewContext): Promise<{ leads: EntityProseRetrievalLead[]; skippedReviews: number }> {
  const target = (await db.query<{ id: string }>(`SELECT entity.id
    FROM storyhold.world_entities entity JOIN storyhold.worlds world ON world.id=entity.world_id
    WHERE entity.id=$1 AND entity.world_id=$2 AND entity.canon_edition_id=$3 AND world.owner_player_id=$4
      AND entity.pull_status='active' AND entity.merged_into_entity_id IS NULL`,
  [scope.entityId, scope.worldId, scope.editionId, scope.playerId])).rows[0];
  if (!target) return { leads: [], skippedReviews: 0 };
  if (currentInventory.version !== 1 || !Array.isArray(currentInventory.items)) {
    throw new Error("Dossier existing prose retrieval: a complete current text inventory is required.");
  }
  if (!currentInventory.items.length) return { leads: [], skippedReviews: 0 };
  const currentFields = fields(currentInventory.items);
  const finalized = (await db.query<{ review_id: string }>(`SELECT review_id FROM storyhold.entity_review_ai_calls
    WHERE world_id=$1 AND edition_id=$2 AND entity_id=$3 AND player_id=$4
      AND status='completed' AND finalization_snapshot IS NOT NULL
    ORDER BY finalized_at DESC NULLS LAST,review_id DESC`,
  [scope.worldId, scope.editionId, scope.entityId, scope.playerId])).rows;
  const decided = new Set<string>();
  const leads = new Map<string, EntityProseRetrievalLead>();
  const histories = new Map<string, Map<string, AnalysisChunk>>();
  let skippedReviews = 0;
  for (const saved of finalized) {
    let call;
    try { call = await readEntityReviewCall(db, { ...scope, reviewId: saved.review_id }); }
    catch (error) {
      // Invalid immutable evidence is skippable history. A failed database
      // query is an operational failure, not evidence that nothing was found.
      if (!(error instanceof EntityReviewJournalError)) throw error;
      skippedReviews++; continue;
    }
    if (!call || call.status !== "completed" || (call.verification_snapshot?.version !== 4 && call.verification_snapshot?.version !== 5)
      || call.finalization_snapshot?.reviewed !== true || call.finalization_snapshot.entityId !== scope.entityId) continue;
    const input = call.context_snapshot.input as unknown as EntityReviewInput;
    const applicable = new Set<string>();
    for (const [key, oldSlots] of fields(input.existingProseReview!.items)) {
      const current = currentFields.get(key);
      // Every original position must be intact. Matching text elsewhere or a
      // convenient surviving duplicate cannot borrow this slot's judgment.
      if (!current || hash(oldSlots) !== hash(current.slice(0, oldSlots.length))) continue;
      for (const item of oldSlots) applicable.add(item.itemId);
    }
    const oldItems = new Map(input.existingProseReview!.items.map((item) => [item.itemId, item]));
    const previousChunks = input.chunks.map((chunk) => ({ key: hash(chunk), chunk }));
    for (const receipt of call.verification_snapshot.existingProse) for (const decision of receipt.decisions) {
      if (!applicable.has(decision.itemId)) continue;
      if (!decided.has(decision.itemId)) {
        decided.add(decision.itemId);
        if (decision.verdict === "needs_more_evidence") {
          const item = oldItems.get(decision.itemId)!;
          leads.set(item.itemId, { item: structuredClone(item), reviewId: saved.review_id,
            requests: decision.retrievalRequests.length ? [...decision.retrievalRequests] : [item.text], previousChunks: [] });
          histories.set(item.itemId, new Map());
        }
      }
      // Only the newest judgment chooses the lead. Every applicable earlier
      // audit contributes read history, even when its judgment was different.
      // Key complete chunks, not IDs: both historical text versions must stay
      // excluded if an edited manuscript later returns to either version.
      const history = histories.get(decision.itemId);
      if (history) for (const { key, chunk } of previousChunks) if (!history.has(key)) history.set(key, structuredClone(chunk));
    }
  }
  return { leads: currentInventory.items.flatMap((item) => {
    const lead = leads.get(item.itemId);
    return lead ? [{ ...lead, previousChunks: [...histories.get(item.itemId)!.values()] }] : [];
  }), skippedReviews };
}

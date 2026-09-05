import type { PGlite } from "@electric-sql/pglite";
import { buildVerifiedPromotionPlan, canonPayloadFingerprint, type JsonObject } from "./analysisVerificationContracts";
import { ENTITY_PROSE_FIELDS, type EntityProseField, type EntityProseItem, type EntityProseReviewReceipt } from "./entityProseVerification";
import { buildExistingProseInventory, type EntityExistingProseField } from "./entityExistingProseReview";
import { readEntityReviewCall, type EntityReviewCallRow } from "./entityReviewJournal";
import type { EntityReviewInput } from "./entityReview";
import { knowledgeClaimFingerprint, type KnowledgeEvidence, type WorldKnowledgeClaim } from "./worldKnowledge";

type QueryDb = Pick<PGlite, "query">;
export type EntityProseStatusScope = { playerId: string; worldId: string; editionId: string; entityId: string };
export type EntityProseVisible = { aliases?: unknown; summary?: unknown; details?: unknown; relationships?: unknown;
  character?: { aliases?: unknown; summary?: unknown; role?: unknown; profile?: unknown } | null; authorControlled: boolean };
export type EntityProseItemStatus = "verified" | "supported" | "needs_attention" | "needs_evidence" | "not_reviewed" | "author_controlled";
export type EntityProseFieldStatus = EntityProseItemStatus | "partial";
export type EntityProseStatusItem = { text: string; status: EntityProseItemStatus; evidence: KnowledgeEvidence[]; confidence?: number;
  reviewBasis?: "canonical_claim" | "existing_text_audit"; explanation?: string; retrievalRequests?: string[] };
export type EntityProseFieldReview = { field: EntityExistingProseField; status: EntityProseFieldStatus; verifiedItems: number; totalItems: number;
  reviewedItems?: number; sourceCheckedItems?: number; items: EntityProseStatusItem[] };
export type EntityProseStatus = { fields: EntityProseFieldReview[] };
const normalized = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
const nameKey = (value: string) => normalized(value).toLocaleLowerCase();
const hash = (value: unknown) => canonPayloadFingerprint(value as JsonObject);
const text = (value: unknown) => typeof value === "string" ? value : "";
const texts = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const citeKey = (value: KnowledgeEvidence) => `${value.chunkId}\u0000${value.sourceId}\u0000${value.quote}`;
function cites(value: unknown): KnowledgeEvidence[] {
  return Array.isArray(value) ? value.filter((item): item is KnowledgeEvidence => Boolean(item) && typeof item === "object"
    && typeof item.chunkId === "string" && typeof item.sourceId === "string" && typeof item.quote === "string") : [];
}
function visibleFields(visible: EntityProseVisible): Map<EntityExistingProseField, string[]> {
  const fields = new Map<EntityExistingProseField, string[]>();
  const character = visible.character;
  fields.set("aliases", texts(character ? character.aliases : visible.aliases));
  const summary = text(character ? character.summary : visible.summary);
  fields.set("summary", summary.trim() ? [summary] : []);
  fields.set("details", texts(visible.details));
  if (!character) fields.set("relationships", texts(visible.relationships));
  if (character) {
    const profile = object(character.profile);
    const role = text(character.role); fields.set("role", role.trim() ? [role] : []);
    for (const field of ENTITY_PROSE_FIELDS) if (!["aliases", "summary", "details", "role"].includes(field)) fields.set(field, texts(profile[field]));
    fields.set("relationships", texts(profile.relationships));
  }
  return new Map([...fields].filter(([_field, values]) => values.length));
}
type LinkedClaim = {
  entity_review_id: string; step_key: string; proposal_id: string; decision_id: string; payload_fingerprint: string;
  id: string; fingerprint: string; subject_entity_id: string; predicate: string; polarity: "positive" | "negative";
  object_entity_id: string | null; object_text: string; epistemic_holder_entity_id: string | null;
  truth_status: WorldKnowledgeClaim["truthStatus"]; valid_from_label: string; valid_until_label: string;
  evidence: unknown; assignment_source: string; claim_status: string;
};
type Support = { evidence: KnowledgeEvidence[]; confidence: number; rank: number };
type Audit = Omit<EntityProseStatusItem, "text"> & { rank: number };

/** Read-only, owner-scoped current-text proof. A missing/corrupt historical
 * receipt contributes no authority; it never prevents reading the dossier or
 * calls an AI. Private request context and verifier details never leave here. */
export async function readEntityProseStatus(db: QueryDb, scope: EntityProseStatusScope,
  visible: EntityProseVisible, stored?: Omit<EntityProseVisible, "authorControlled">): Promise<EntityProseStatus> {
  const fields = visibleFields(visible);
  const output = (authorFields = new Set<EntityExistingProseField>(), support = new Map<string, Support>(), audits = new Map<string, Audit>()): EntityProseStatus => ({
    fields: [...fields].map(([field, values]) => {
      const items = values.map((value, index): EntityProseStatusItem => {
        if (authorFields.has(field)) return { text: value, status: "author_controlled", evidence: [] };
        const proof = support.get(`${field}\u0000${value}`);
        const audit = audits.get(`${field}\u0000${index}`);
        if (audit && (!proof || audit.rank < proof.rank || (audit.rank === proof.rank && audit.status !== "supported"))) {
          const { rank: _rank, ...publicAudit } = audit; return { text: value, ...publicAudit };
        }
        return proof ? { text: value, status: "verified", evidence: proof.evidence, confidence: proof.confidence, reviewBasis: "canonical_claim" }
          : { text: value, status: "not_reviewed", evidence: [] };
      });
      const verifiedItems = items.filter((item) => item.status === "verified").length;
      const reviewedItems = items.filter((item) => ["verified", "supported", "needs_attention", "needs_evidence"].includes(item.status)).length;
      const sourceCheckedItems = items.filter((item) => item.status === "verified" || item.status === "supported").length;
      return { field, status: authorFields.has(field) ? "author_controlled" : items.some((item) => item.status === "needs_attention") ? "needs_attention"
        : items.some((item) => item.status === "needs_evidence") ? "needs_evidence" : verifiedItems === items.length ? "verified"
        : sourceCheckedItems === items.length ? "supported" : reviewedItems ? "partial" : "not_reviewed",
        verifiedItems, totalItems: items.length, reviewedItems, sourceCheckedItems, items };
    }),
  });
  let target: { classification_source: string; review_status: string; user_edited_at: unknown } | undefined;
  try {
    target = (await db.query<{ classification_source: string; review_status: string; user_edited_at: unknown }>(
      `SELECT entity.classification_source, entity.review_status, dossier.user_edited_at
       FROM storyhold.world_entities entity JOIN storyhold.worlds world ON world.id=entity.world_id
       LEFT JOIN storyhold.character_dossiers dossier ON dossier.id=entity.dossier_id
         AND dossier.world_id=entity.world_id AND dossier.canon_edition_id=entity.canon_edition_id
       WHERE entity.id=$1 AND entity.world_id=$2 AND entity.canon_edition_id=$3 AND world.owner_player_id=$4
         AND entity.pull_status='active' AND entity.merged_into_entity_id IS NULL`,
      [scope.entityId, scope.worldId, scope.editionId, scope.playerId],
    )).rows[0];
  } catch { return { fields: [] }; }
  if (!target) return { fields: [] };
  const authorFields = new Set<EntityExistingProseField>();
  if (target.classification_source === "user" || target.review_status === "user_confirmed" || target.user_edited_at != null) {
    for (const field of fields.keys()) authorFields.add(field);
    return output(authorFields);
  }
  try {
    const owners = (await db.query<{ predicate: string }>(`SELECT predicate FROM storyhold.world_knowledge_claims
      WHERE world_id=$1 AND canon_edition_id=$2 AND subject_entity_id=$3 AND assignment_source='user'`,
    [scope.worldId, scope.editionId, scope.entityId])).rows;
    for (const row of owners) {
      const field = ([...ENTITY_PROSE_FIELDS,"relationships"] as EntityExistingProseField[]).find((candidate) => nameKey(row.predicate) === nameKey(`dossier.${candidate}`));
      if (field && fields.has(field)) authorFields.add(field);
    }
    const links = (await db.query<LinkedClaim>(`SELECT claim.*, link.entity_review_id,link.step_key,link.proposal_id,link.decision_id,link.payload_fingerprint
      FROM storyhold.world_knowledge_claim_verifications link JOIN storyhold.world_knowledge_claims claim ON claim.id=link.claim_id
      JOIN storyhold.entity_review_ai_calls call ON call.review_id=link.entity_review_id
      WHERE claim.world_id=$1 AND claim.canon_edition_id=$2 AND claim.subject_entity_id=$3
        AND claim.predicate=ANY($5::text[]) AND claim.claim_status='active' AND claim.assignment_source<>'user'
        AND link.run_id IS NULL AND call.world_id=$1 AND call.edition_id=$2 AND call.entity_id=$3 AND call.player_id=$4
        AND call.status='completed' AND call.finalization_snapshot IS NOT NULL
      ORDER BY link.created_at DESC,link.entity_review_id,link.proposal_id`,
    [scope.worldId, scope.editionId, scope.entityId, scope.playerId, [...fields.keys()].map((field) => `dossier.${field}`)])).rows;
    const calls = new Map<string, EntityReviewCallRow | null>();
    const finalized = (await db.query<{ review_id: string }>(`SELECT review_id FROM storyhold.entity_review_ai_calls
      WHERE world_id=$1 AND edition_id=$2 AND entity_id=$3 AND player_id=$4 AND status='completed' AND finalization_snapshot IS NOT NULL
      ORDER BY finalized_at DESC NULLS LAST,review_id DESC`, [scope.worldId,scope.editionId,scope.entityId,scope.playerId])).rows;
    const ranks = new Map(finalized.map((row, index) => [row.review_id, index]));
    const sourceChecks = new Map<string, boolean>();
    const supportedByReview = new Map<string, Map<string, Support>>();
    const receipts = new Map<string, EntityProseReviewReceipt>();
    for (const link of links) {
      try {
        if (!calls.has(link.entity_review_id)) {
          let call: EntityReviewCallRow | null = null;
          try { call = await readEntityReviewCall(db, { ...scope, reviewId: link.entity_review_id }); } catch { /* Historical corruption is not current proof. */ }
          calls.set(link.entity_review_id, call);
        }
        const call = calls.get(link.entity_review_id);
        if (!call || call.status !== "completed" || (call.verification_snapshot?.version !== 3 && call.verification_snapshot?.version !== 4 && call.verification_snapshot?.version !== 5)
          || call.finalization_snapshot?.reviewed !== true || call.finalization_snapshot.entityId !== scope.entityId) continue;
        const receipt = call.verification_snapshot.prose;
        const entry = buildVerifiedPromotionPlan(receipt.claimReceipt.packet, receipt.claimReceipt.decisions, receipt.claimReceipt.batch)
          .find((value) => value.proposal.id === link.proposal_id && value.decision.id === link.decision_id && value.payloadFingerprint === link.payload_fingerprint);
        const item = receipt.projection.find((value) => value.proposalId === link.proposal_id);
        if (!entry || !item || link.step_key !== receipt.claimReceipt.request.stepKey || hash(entry.payload) !== link.payload_fingerprint) continue;
        const input = call.context_snapshot.input as unknown as EntityReviewInput;
        const claim = item.claim;
        const holders = claim.epistemicHolder ? input.graphReview!.entities.filter((entity) => [entity.name, ...entity.aliases]
          .some((alias) => nameKey(alias) === nameKey(claim.epistemicHolder))) : [];
        if ((claim.epistemicHolder && holders.length !== 1) || link.subject_entity_id !== scope.entityId || link.predicate !== claim.predicate
          || link.object_entity_id !== null || link.object_text !== claim.value || link.polarity !== claim.polarity
          || link.truth_status !== claim.truthStatus || link.epistemic_holder_entity_id !== (holders[0]?.id ?? null)
          || link.valid_from_label !== claim.validFromLabel || link.valid_until_label !== claim.validUntilLabel) continue;
        if (knowledgeClaimFingerprint({ subjectEntityId: link.subject_entity_id, predicate: link.predicate, polarity: link.polarity,
          objectEntityId: link.object_entity_id, objectText: link.object_text, epistemicHolderEntityId: link.epistemic_holder_entity_id,
          truthStatus: link.truth_status, validFromLabel: link.valid_from_label, validUntilLabel: link.valid_until_label }) !== link.fingerprint) continue;
        const retained = new Set(cites(link.evidence).map(citeKey));
        if (!item.evidence.length || item.evidence.some((anchor) => !retained.has(citeKey(anchor)))) continue;
        let validSources = true;
        for (const anchor of item.evidence) {
          const requestChunk = receipt.claimReceipt.request.chunks.find((chunk) => chunk.id === anchor.chunkId && chunk.sourceId === anchor.sourceId);
          if (!requestChunk || !normalized(requestChunk.text).includes(anchor.quote)) { validSources = false; break; }
          const key = hash({ chunk: requestChunk, evidence: anchor });
          if (!sourceChecks.has(key)) {
            const current = (await db.query<{ content: string; source_id: string }>(`SELECT chunk.content,chunk.source_id
              FROM storyhold.world_source_chunks chunk JOIN storyhold.world_sources source ON source.id=chunk.source_id
              WHERE chunk.id=$1 AND chunk.source_id=$2 AND chunk.world_id=$3 AND chunk.canon_edition_id=$4
                AND source.world_id=$3 AND source.canon_edition_id=$4 AND source.processing_status='ready'
                AND source.canon_status IN ('candidate','canon') AND source.source_kind='manuscript'`,
            [anchor.chunkId, anchor.sourceId, scope.worldId, scope.editionId])).rows[0];
            sourceChecks.set(key, Boolean(current && current.content === requestChunk.text && current.source_id === anchor.sourceId));
          }
          if (!sourceChecks.get(key)) { validSources = false; break; }
        }
        if (!validSources) continue;
        const supported = supportedByReview.get(link.entity_review_id) ?? new Map<string, Support>();
        supported.set(item.proposalId, { evidence: structuredClone(item.evidence), confidence: item.confidence,
          rank: ranks.get(link.entity_review_id) ?? Number.MAX_SAFE_INTEGER });
        supportedByReview.set(link.entity_review_id, supported); receipts.set(link.entity_review_id, receipt);
      } catch { /* One malformed or obsolete proof must never break dossier reading. */ }
    }
    const support = new Map<string, Support>();
    const add = (field: EntityProseField, value: string, proof: Support) => {
      if (!fields.get(field)?.includes(value) || authorFields.has(field)) return;
      const key = `${field}\u0000${value}`; if (!support.has(key) || support.get(key)!.rank > proof.rank) support.set(key, proof);
    };
    for (const [reviewId, supported] of supportedByReview) {
      const receipt = receipts.get(reviewId)!;
      for (const item of receipt.projection) if (item.field !== "summary" && supported.has(item.proposalId)) add(item.field, item.text, supported.get(item.proposalId)!);
      const summary = receipt.projection.filter((item: EntityProseItem) => item.field === "summary");
      if (summary.length && summary.every((item) => supported.has(item.proposalId))) {
        add("summary", summary.map((item) => item.text).join(" "), {
          evidence: [...new Map(summary.flatMap((item) => supported.get(item.proposalId)!.evidence).map((anchor) => [citeKey(anchor), anchor])).values()],
          confidence: Math.min(...summary.map((item) => supported.get(item.proposalId)!.confidence)),
          rank: ranks.get(reviewId) ?? Number.MAX_SAFE_INTEGER,
        });
      }
    }
    const audits = new Map<string, Audit>();
    let inventory: ReturnType<typeof buildExistingProseInventory>;
    try { const raw = stored ?? visible; inventory = buildExistingProseInventory(raw, raw.character ?? undefined); }
    catch { return output(authorFields, support); }
    // Storage slots and display rows are different identities. A serializer may
    // collapse exact duplicates, but it cannot choose which duplicate's verdict
    // survives. Only an exact or exact-deduplicated field projection is allowed.
    const projectedSlots = new Map<string, { slots: typeof inventory.items; fieldSlots: typeof inventory.items }>();
    for (const [field, values] of fields) {
      const origin = visible.character && field !== "details" ? "character" : "entity";
      const slots = inventory.items.filter((item) => item.field === field && item.origin === origin);
      if (hash(values) === hash(slots.map((slot) => slot.text))) {
        for (const [index, slot] of slots.entries()) projectedSlots.set(`${field}\u0000${index}`, { slots: [slot], fieldSlots: slots });
      } else if (stored && hash(values) === hash([...new Set(slots.map((slot) => slot.text))])) {
        for (const [index, value] of values.entries()) projectedSlots.set(`${field}\u0000${index}`, {
          slots: slots.filter((slot) => slot.text === value), fieldSlots: slots,
        });
      }
    }
    const auditSourceChecks = new Map<string, boolean>();
    for (const [rank, saved] of finalized.entries()) {
      try {
        if (!calls.has(saved.review_id)) {
          let call: EntityReviewCallRow | null = null;
          try { call = await readEntityReviewCall(db, { ...scope, reviewId: saved.review_id }); } catch { /* Bad private journals confer no audit authority. */ }
          calls.set(saved.review_id, call);
        }
        const call = calls.get(saved.review_id);
        if (!call || (call.verification_snapshot?.version !== 4 && call.verification_snapshot?.version !== 5) || call.finalization_snapshot?.reviewed !== true
          || call.finalization_snapshot.entityId !== scope.entityId) continue;
        const input = call.context_snapshot.input as unknown as EntityReviewInput;
        const sourceKey = hash(input.chunks);
        if (!auditSourceChecks.has(sourceKey)) {
          const chunks = (await db.query<{ id: string; source_id: string; content: string }>(`SELECT chunk.id,chunk.source_id,chunk.content
            FROM storyhold.world_source_chunks chunk JOIN storyhold.world_sources source ON source.id=chunk.source_id
            WHERE chunk.id=ANY($1::uuid[]) AND chunk.world_id=$2 AND chunk.canon_edition_id=$3
              AND source.world_id=$2 AND source.canon_edition_id=$3 AND source.processing_status='ready'
              AND source.canon_status IN ('candidate','canon') AND source.source_kind='manuscript'`,
          [input.chunks.map((chunk) => chunk.id),scope.worldId,scope.editionId])).rows;
          const current = new Map(chunks.map((chunk) => [chunk.id,chunk]));
          auditSourceChecks.set(sourceKey, input.chunks.length > 0 && input.chunks.every((chunk) => current.get(chunk.id)?.content === chunk.content
            && current.get(chunk.id)?.source_id === chunk.sourceId));
        }
        const decisions = new Map(call.verification_snapshot.existingProse.flatMap((receipt) => receipt.decisions).map((decision) => [decision.itemId,decision]));
        for (const [position, projection] of projectedSlots) {
            if (audits.has(position)) continue;
            const first = projection.slots[0]!;
            const oldSlots = input.existingProseReview!.items.filter((item) => item.origin === first.origin && item.field === first.field);
            if (!oldSlots.some((slot) => slot.text === first.text)) continue;
            // New trailing entries may be added by the same review. Existing
            // slots must still be the exact original prefix, never reordered,
            // removed or shifted; every collapsed occurrence needs a decision.
            if (hash(oldSlots) !== hash(projection.fieldSlots.slice(0,oldSlots.length))
              || projection.slots.some((slot) => !decisions.has(slot.itemId))) {
              audits.set(position, { rank, status: "not_reviewed", evidence: [],
                explanation: "The stored positions of this wording have changed or include an unchecked occurrence. It needs a fresh review." });
              continue;
            }
            if (!auditSourceChecks.get(sourceKey)) {
              audits.set(position, { rank, status: "not_reviewed", evidence: [],
                explanation: "The passages used to review this wording have changed or are unavailable. It needs a fresh review." });
              continue;
            }
            const reviewed = projection.slots.map((slot) => decisions.get(slot.itemId)!);
            const verdict = reviewed.some((decision) => decision.verdict === "contradicted") ? "contradicted"
              : reviewed.some((decision) => decision.verdict === "needs_more_evidence") ? "needs_more_evidence" : "supported";
            const selected = reviewed.filter((decision) => decision.verdict === verdict);
            const status = verdict === "supported" ? "supported" : verdict === "contradicted" ? "needs_attention" : "needs_evidence";
            const evidence = selected.flatMap((decision) => verdict === "supported" ? decision.supportingEvidence : verdict === "contradicted"
              ? decision.contradictingEvidence : [...decision.supportingEvidence,...decision.contradictingEvidence]);
            const mixed = new Set(reviewed.map((decision) => decision.verdict)).size > 1;
            audits.set(position, { rank, status, evidence: structuredClone([...new Map(evidence.map((anchor) => [citeKey(anchor),anchor])).values()]),
              confidence: Math.min(...selected.map((decision) => decision.confidence)), reviewBasis: "existing_text_audit",
              explanation: `${mixed ? "This wording occurs more than once, and the reviews differ. The concern is shown here.\n" : ""}${[...new Set(reviewed.map((decision) => decision.explanation))].join("\n")}`,
              retrievalRequests: [...new Set(reviewed.flatMap((decision) => decision.retrievalRequests))] });
        }
      } catch { /* A single obsolete audit cannot break the dossier or confer support. */ }
    }
    return output(authorFields, support, audits);
  } catch { return output(authorFields); }
}

import type { PGlite } from "@electric-sql/pglite";
import { canonPayloadFingerprint, type JsonObject } from "./analysisVerificationContracts";
import type { EntityReviewCallScope } from "./entityReviewJournal";

/** Capture only durable story state, not billing, provider status or UI activity.
 * The caller captures this together with its input in a transaction, then checks
 * it again in the transaction that applies a saved paid response. */
export async function entityReviewCanonFingerprint(db: Pick<PGlite, "query">, scope: EntityReviewCallScope,
  chunkIds: string[], lock = false, version: 1 | 2 = 1): Promise<string> {
  if (version !== 1 && version !== 2) throw new Error("Unsupported dossier canon fingerprint version.");
  const share = lock ? " FOR SHARE" : "";
  const query = async (sql: string, values: unknown[]) => (await db.query(sql, values)).rows;
  const pair = [scope.worldId, scope.editionId];
  const target = await query(`SELECT * FROM storyhold.world_entities
    WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3${lock ? " FOR UPDATE" : ""}`,
  [scope.entityId, ...pair]);
  const dossier = await query(`SELECT dossier.* FROM storyhold.character_dossiers dossier
    JOIN storyhold.world_entities entity ON entity.dossier_id = dossier.id
    WHERE entity.id = $1 AND entity.world_id = $2 AND entity.canon_edition_id = $3
      AND dossier.world_id = $2 AND dossier.canon_edition_id = $3${lock ? " FOR SHARE OF dossier" : ""}`,
  [scope.entityId, ...pair]);
  const identities = await query(`SELECT id, name, aliases, entity_type, pull_status, merged_into_entity_id
    FROM storyhold.world_entities WHERE world_id = $1 AND canon_edition_id = $2 ORDER BY id${share}`, pair);
  const constraints = await query(`SELECT * FROM storyhold.world_owner_canon_constraints
    WHERE world_id = $1 AND canon_edition_id = $2 ORDER BY id${share}`, pair);
  const relations = await query(`SELECT * FROM storyhold.world_entity_relations
    WHERE world_id = $1 AND canon_edition_id = $2 AND (source_entity_id = $3 OR target_entity_id = $3)
    ORDER BY id${share}`, [...pair, scope.entityId]);
  const rules = await query(`SELECT * FROM storyhold.world_entity_rules
    WHERE world_id = $1 AND canon_edition_id = $2 AND entity_id = $3 ORDER BY id${share}`, [...pair, scope.entityId]);
  const memberships = await query(`SELECT * FROM storyhold.world_entity_faction_memberships
    WHERE entity_id = $1 OR faction_entity_id = $1 ORDER BY entity_id, faction_entity_id${share}`, [scope.entityId]);
  // Newly added books and chronology changes invalidate the old reading too,
  // even when its originally selected passages remain unchanged.
  const sources = await query(`SELECT id, title, content_hash, processing_status, canon_status, source_kind,
    chronology_order, chronology_relation, chronology_label, chronology_notes, sort_order
    FROM storyhold.world_sources WHERE world_id = $1 AND canon_edition_id = $2 ORDER BY id${share}`, pair);
  const chunks = await query(`SELECT id, source_id, chunk_index, content FROM storyhold.world_source_chunks
    WHERE world_id = $1 AND canon_edition_id = $2 AND id = ANY($3::uuid[]) ORDER BY id${share}`, [...pair, chunkIds]);
  const world = await query(`SELECT id, name, premise, genre FROM storyhold.worlds WHERE id = $1${share}`, [scope.worldId]);
  const claims = version === 2 ? await query(`SELECT * FROM storyhold.world_knowledge_claims
    WHERE world_id = $1 AND canon_edition_id = $2
      AND (subject_entity_id = $3 OR object_entity_id = $3 OR epistemic_holder_entity_id = $3)
    ORDER BY id${share}`, [...pair, scope.entityId]) : undefined;
  return canonPayloadFingerprint(JSON.parse(JSON.stringify({ version, target, dossier, identities,
    constraints, relations, rules, memberships, sources, chunks, world, ...(version === 2 ? { claims } : {}) })) as JsonObject);
}

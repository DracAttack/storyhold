import type { PGlite } from "@electric-sql/pglite";

export type EntityReviewSourceChunk = {
  id: string;
  source_id: string;
  source_title: string;
  chunk_index: number;
  content: string;
  metadata: unknown;
};

/** All eligible manuscript text, not just name-bearing hits. The caller ranks
 * this corpus locally; reference uploads, another edition, or another owner's
 * work cannot enter a dossier's source-backed evidence packet. No models run. */
export async function loadEntityReviewManuscriptChunks(db: Pick<PGlite, "query">,
  scope: { playerId: string; worldId: string; editionId: string }): Promise<EntityReviewSourceChunk[]> {
  return (await db.query<EntityReviewSourceChunk>(
    `SELECT chunk.id, chunk.source_id, source.title AS source_title,
            chunk.chunk_index, chunk.content, chunk.metadata
       FROM storyhold.world_source_chunks chunk
       JOIN storyhold.world_sources source ON source.id = chunk.source_id
       JOIN storyhold.worlds world ON world.id = chunk.world_id
      WHERE chunk.world_id = $1 AND chunk.canon_edition_id = $2
        AND source.world_id = $1 AND source.canon_edition_id = $2
        AND world.owner_player_id = $3
        AND source.processing_status = 'ready'
        AND source.canon_status IN ('candidate', 'canon')
        AND source.source_kind = 'manuscript'
      ORDER BY source.chronology_order ASC, source.sort_order ASC,
               source.created_at ASC, source.id ASC, chunk.chunk_index ASC, chunk.id ASC`,
    [scope.worldId, scope.editionId, scope.playerId],
  )).rows;
}

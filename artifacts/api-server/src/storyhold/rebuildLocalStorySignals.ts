import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { extractLocalStoryEntities } from "./localEntityExtraction";
import { releaseLorekeeperStage } from "./localLorekeeperModels";
import type { AnalysisChunk } from "./worldAnalysis";

const [dataDirectory, worldId] = process.argv.slice(2);
if (!dataDirectory || !worldId) throw new Error("Pass the local vault directory and world ID.");
const resolvedDataDirectory = path.resolve(dataDirectory);

async function openDb() {
  return PGlite.create({ dataDir: resolvedDataDirectory, extensions: { vector } });
}

let db = await openDb();
const runResult = await db.query<Record<string, unknown>>(
  `SELECT id FROM storyhold.world_analysis_runs
    WHERE world_id = $1 AND analysis_kind = 'local_scan' AND status = 'completed'
    ORDER BY completed_at DESC NULLS LAST, created_at DESC LIMIT 1`,
  [worldId],
);
const runId = String(runResult.rows[0]?.id ?? "");
if (!runId) throw new Error("No completed local intake was found for this world.");
const chunkResult = await db.query<Record<string, unknown>>(
  `SELECT chunk.id, chunk.source_id, source.title AS source_title,
          chunk.chunk_index, chunk.content, chunk.metadata
     FROM storyhold.world_source_chunks chunk
     JOIN storyhold.world_sources source ON source.id = chunk.source_id
    WHERE chunk.world_id = $1 AND source.processing_status = 'ready'
      AND source.canon_status IN ('candidate', 'canon')
    ORDER BY source.chronology_order, source.sort_order, chunk.chunk_index`,
  [worldId],
);
const chunks: AnalysisChunk[] = chunkResult.rows.map((row) => {
  const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown>
    : {};
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    sourceTitle: String(row.source_title),
    index: Number(row.chunk_index),
    content: String(row.content),
    sectionTitle: typeof metadata.sectionTitle === "string" ? metadata.sectionTitle : null,
  };
});
await db.close();

console.log(`Restoring structured story signals across ${chunks.length.toLocaleString()} passages…`);
const result = await extractLocalStoryEntities({
  chunks,
  stage: "gliner2",
  stopOnFailure: true,
  onProgress: async (completed, total) => {
    if (completed === total || completed % 25 === 0) {
      console.log(`Structured reading ${completed.toLocaleString()} of ${total.toLocaleString()} passages…`);
    }
  },
});
try {
  if (result.receipt.status !== "completed") {
    throw new Error(result.receipt.errors.join(" | ") || "Structured reading stopped before completion.");
  }
  const checkpoint = {
    version: 1,
    chunkIds: chunks.map((chunk) => chunk.id),
    completedStage: "gliner2",
    localStages: [{
      stage: "gliner2",
      status: "completed",
      model: result.status.model,
      processed: result.receipt.completedSegments,
      elapsedMilliseconds: result.receipt.elapsedMilliseconds,
    }],
    gliner2: {
      completedSegments: result.receipt.completedSegments,
      totalSegments: result.receipt.attemptedSegments,
      mentions: result.mentions,
      relations: result.relations,
      classifications: result.classifications,
      signals: result.signals,
    },
  };
  db = await openDb();
  await db.query(
    `UPDATE storyhold.world_analysis_runs
        SET local_checkpoint = $2::jsonb, local_checkpoint_saved_at = now()
      WHERE id = $1`,
    [runId, JSON.stringify(checkpoint)],
  );
  await db.close();
  console.log(JSON.stringify({
    runId,
    passages: chunks.length,
    mentions: result.mentions.length,
    relationships: result.relations.length,
    classifications: result.classifications.length,
    storySignals: result.signals.length,
    elapsedMilliseconds: result.receipt.elapsedMilliseconds,
  }, null, 2));
} finally {
  await releaseLorekeeperStage().catch(() => undefined);
}

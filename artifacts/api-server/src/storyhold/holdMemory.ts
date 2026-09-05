import type { PGlite } from "@electric-sql/pglite";
import {
  embedTexts,
  embeddingModelName,
  embeddingProvider,
} from "../services/embeddings";

type HoldDb = Pick<PGlite, "query">;

export type HoldEmbedding = {
  vector: number[];
  literal: string;
  provider: string;
  model: string;
};

const STORYHOLD_EMBEDDING_DIMENSIONS = 384;
const EMBED_BATCH_SIZE = 16;
const queryCache = new Map<string, HoldEmbedding>();
let backfillRunning = false;
let backfillTimer: ReturnType<typeof setTimeout> | null = null;
let embeddingUnavailableUntil = 0;

function vectorLiteral(values: number[]): string {
  if (
    values.length !== STORYHOLD_EMBEDDING_DIMENSIONS ||
    values.some((value) => !Number.isFinite(value))
  ) {
    throw new Error(
      `Storyhold requires ${STORYHOLD_EMBEDDING_DIMENSIONS}-dimensional embeddings.`,
    );
  }
  return `[${values.join(",")}]`;
}

async function embedBatch(texts: string[]) {
  const result = await embedTexts(texts.map((value) => value.slice(0, 12_000)));
  if (result.dimensions !== STORYHOLD_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding model ${result.provider}/${result.model} returned ${result.dimensions} dimensions; Storyhold stores ${STORYHOLD_EMBEDDING_DIMENSIONS}.`,
    );
  }
  return result;
}

export async function embedHoldQuery(value: string): Promise<HoldEmbedding | null> {
  const normalized = value.replace(/\s+/g, " ").trim().slice(0, 4_000);
  if (!normalized) return null;
  const cached = queryCache.get(normalized);
  if (cached) return cached;
  if (Date.now() < embeddingUnavailableUntil) return null;
  try {
    const result = await embedBatch([normalized]);
    const embedding = {
      vector: result.vectors[0]!,
      literal: vectorLiteral(result.vectors[0]!),
      provider: result.provider,
      model: result.model,
    };
    queryCache.set(normalized, embedding);
    if (queryCache.size > 128) {
      const oldest = queryCache.keys().next().value as string | undefined;
      if (oldest) queryCache.delete(oldest);
    }
    return embedding;
  } catch (error) {
    embeddingUnavailableUntil = Date.now() + 60_000;
    process.stderr.write(
      `Storyhold semantic query unavailable; using lexical retrieval: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return null;
  }
}

async function embedSourceBatch(db: HoldDb, sourceId?: string): Promise<number> {
  const result = await db.query<{ id: string; content: string }>(
    `SELECT id, content
       FROM storyhold.world_source_chunks
      WHERE ($1::uuid IS NULL OR source_id = $1)
        AND (
          embedding IS NULL OR embedding_provider IS DISTINCT FROM $3 OR
          embedding_model IS DISTINCT FROM $4
        )
      ORDER BY created_at ASC, chunk_index ASC
      LIMIT $2`,
    [
      sourceId ?? null,
      EMBED_BATCH_SIZE,
      embeddingProvider(),
      embeddingModelName(),
    ],
  );
  if (result.rows.length === 0) return 0;
  const embedded = await embedBatch(result.rows.map((row) => row.content));
  for (let index = 0; index < result.rows.length; index += 1) {
    await db.query(
      `UPDATE storyhold.world_source_chunks
          SET embedding = $2::vector(384), embedding_provider = $3,
              embedding_model = $4, embedding_updated_at = now()
        WHERE id = $1`,
      [
        result.rows[index]!.id,
        vectorLiteral(embedded.vectors[index]!),
        embedded.provider,
        embedded.model,
      ],
    );
  }
  return result.rows.length;
}

async function embedMemoryBatch(db: HoldDb, ids?: string[]): Promise<number> {
  const result = await db.query<{ id: string; content: string; compact_summary: string | null }>(
    `SELECT id, content, compact_summary
       FROM storyhold.vault_memory_chunks
      WHERE ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))
        AND (
          embedding IS NULL OR embedding_provider IS DISTINCT FROM $3 OR
          embedding_model IS DISTINCT FROM $4
        )
      ORDER BY created_at ASC
      LIMIT $2`,
    [
      ids && ids.length > 0 ? ids : null,
      EMBED_BATCH_SIZE,
      embeddingProvider(),
      embeddingModelName(),
    ],
  );
  if (result.rows.length === 0) return 0;
  const embedded = await embedBatch(
    result.rows.map((row) => row.compact_summary || row.content),
  );
  for (let index = 0; index < result.rows.length; index += 1) {
    await db.query(
      `UPDATE storyhold.vault_memory_chunks
          SET embedding = $2::vector(384), embedding_provider = $3,
              embedding_model = $4, embedding_updated_at = now()
        WHERE id = $1`,
      [
        result.rows[index]!.id,
        vectorLiteral(embedded.vectors[index]!),
        embedded.provider,
        embedded.model,
      ],
    );
  }
  return result.rows.length;
}

async function embedSummaryBatch(db: HoldDb): Promise<number> {
  const result = await db.query<{ id: string; display_name: string; summary: string }>(
    `SELECT id, display_name, summary
       FROM storyhold.campaign_state_summaries
      WHERE embedding IS NULL OR embedding_provider IS DISTINCT FROM $2 OR
            embedding_model IS DISTINCT FROM $3
      ORDER BY updated_at ASC
      LIMIT $1`,
    [EMBED_BATCH_SIZE, embeddingProvider(), embeddingModelName()],
  );
  if (result.rows.length === 0) return 0;
  const embedded = await embedBatch(
    result.rows.map((row) => `${row.display_name}\n${row.summary}`),
  );
  for (let index = 0; index < result.rows.length; index += 1) {
    await db.query(
      `UPDATE storyhold.campaign_state_summaries
          SET embedding = $2::vector(384), embedding_provider = $3,
              embedding_model = $4, embedding_updated_at = now()
        WHERE id = $1`,
      [
        result.rows[index]!.id,
        vectorLiteral(embedded.vectors[index]!),
        embedded.provider,
        embedded.model,
      ],
    );
  }
  return result.rows.length;
}

async function runBackfill(db: HoldDb) {
  if (backfillRunning) return;
  backfillRunning = true;
  try {
    // A bounded pass keeps uploads and live turns responsive. More work is
    // rescheduled until every eligible Hold record has a vector.
    let remaining = false;
    for (let pass = 0; pass < 4; pass += 1) {
      const [sources, memories, summaries] = await Promise.all([
        embedSourceBatch(db),
        embedMemoryBatch(db),
        embedSummaryBatch(db),
      ]);
      remaining = sources + memories + summaries > 0;
      if (!remaining) break;
    }
    if (remaining) scheduleStoryholdEmbeddingBackfill(db, 250);
  } catch (error) {
    process.stderr.write(
      `Storyhold embedding backfill paused: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    scheduleStoryholdEmbeddingBackfill(db, 5 * 60_000);
  } finally {
    backfillRunning = false;
  }
}

export function scheduleStoryholdEmbeddingBackfill(db: HoldDb, delay = 1_000) {
  if (backfillTimer) return;
  backfillTimer = setTimeout(() => {
    backfillTimer = null;
    void runBackfill(db);
  }, delay);
}

export async function ensureStoryholdVectorIndexes(db: HoldDb) {
  if (process.env.STORYHOLD_PGLITE_RUNTIME === "true") {
    // PGlite 0.5.x can reopen an HNSW index with a zero-dimensional internal
    // graph even though the underlying column and rows are vector(384). The
    // next valid insert then fails with "different vector dimensions 384 and
    // 0". These are derivative acceleration structures, so local desktop mode
    // deliberately uses exact cosine scans and removes any stale HNSW indexes.
    // Managed PostgreSQL deployments keep the indexes below.
    for (const indexName of [
      "world_source_chunks_semantic",
      "vault_memory_semantic",
      "campaign_state_summary_semantic",
    ]) {
      await db.query(`DROP INDEX IF EXISTS storyhold.${indexName}`);
    }
    return;
  }
  const statements = [
    `CREATE INDEX IF NOT EXISTS world_source_chunks_semantic
       ON storyhold.world_source_chunks USING hnsw (embedding vector_cosine_ops)
       WHERE embedding IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS vault_memory_semantic
       ON storyhold.vault_memory_chunks USING hnsw (embedding vector_cosine_ops)
       WHERE embedding IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS campaign_state_summary_semantic
       ON storyhold.campaign_state_summaries USING hnsw (embedding vector_cosine_ops)
       WHERE embedding IS NOT NULL`,
  ];
  for (const statement of statements) {
    try {
      await db.query(statement);
    } catch (error) {
      // Exact cosine search remains correct if this runtime lacks HNSW. The
      // failure is operational, not a reason to prevent Storyhold from booting.
      process.stderr.write(
        `Storyhold vector acceleration unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}

export async function embedNewMemoryIds(db: HoldDb, ids: string[]) {
  if (ids.length === 0) return;
  try {
    while ((await embedMemoryBatch(db, ids)) > 0) {
      // Continue until all IDs from this small turn-sized batch are embedded.
    }
  } catch (error) {
    process.stderr.write(
      `Storyhold deferred new memory embeddings: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    scheduleStoryholdEmbeddingBackfill(db, 10_000);
  }
}

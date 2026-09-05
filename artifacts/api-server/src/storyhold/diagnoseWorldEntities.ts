import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

const dataDir = process.argv[2];
if (!dataDir) throw new Error("Pass a PGlite data directory.");

const db = await PGlite.create({ dataDir, extensions: { vector } });
try {
  const indexedDuplicates = await db.query(
    "SELECT id::text, count(*)::int AS count FROM storyhold.world_entities GROUP BY id HAVING count(*) > 1",
  );
  await db.exec("SET enable_indexscan = off; SET enable_bitmapscan = off; SET enable_indexonlyscan = off;");
  const sequentialDuplicates = await db.query(
    "SELECT id::text, count(*)::int AS count FROM storyhold.world_entities GROUP BY id HAVING count(*) > 1",
  );
  const target = await db.query(
    "SELECT ctid::text, xmin::text, xmax::text, id::text, world_id::text, canonical_key, normalized_name, name, entity_type, pull_status, scanner_present FROM storyhold.world_entities WHERE id = $1::uuid",
    ["ca0e5cfa-7900-4bdb-8bd7-3f819d5b361c"],
  );
  const duplicateVariants = await db.query(
    `WITH duplicate_ids AS (
       SELECT id FROM storyhold.world_entities GROUP BY id HAVING count(*) > 1
     )
     SELECT entity.id::text,
            count(*)::int AS copies,
            count(DISTINCT md5(to_jsonb(entity)::text))::int AS distinct_rows,
            array_agg(entity.ctid::text ORDER BY entity.ctid::text) AS physical_rows
       FROM storyhold.world_entities entity
       JOIN duplicate_ids USING (id)
      GROUP BY entity.id
      ORDER BY entity.id::text`,
  );
  const duplicateRows = await db.query(
    `WITH duplicate_ids AS (
       SELECT id FROM storyhold.world_entities GROUP BY id HAVING count(*) > 1
     )
     SELECT entity.id::text, entity.ctid::text, entity.xmin::text,
            entity.world_id::text, entity.name, entity.entity_type,
            entity.classification_source, entity.review_status,
            entity.pull_status, entity.scanner_present,
            entity.dossier_id::text, entity.mention_count,
            jsonb_array_length(entity.evidence) AS evidence_count,
            length(entity.summary) AS summary_length,
            entity.created_at::text, entity.updated_at::text
       FROM storyhold.world_entities entity
       JOIN duplicate_ids USING (id)
      ORDER BY entity.id::text, entity.updated_at DESC, entity.ctid::text`,
  );
  const indexes = await db.query(
    "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'storyhold' AND tablename = 'world_entities' ORDER BY indexname",
  );
  console.log(JSON.stringify({ indexedDuplicates: indexedDuplicates.rows, sequentialDuplicates: sequentialDuplicates.rows, duplicateVariants: duplicateVariants.rows, duplicateRows: duplicateRows.rows, target: target.rows, indexes: indexes.rows }, null, 2));
} finally {
  await db.close();
}

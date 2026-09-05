import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

const dataDir = process.argv[2];
if (!dataDir) throw new Error("Pass a closed PGlite data directory.");

const db = await PGlite.create({ dataDir, extensions: { vector } });
try {
  await db.exec("SET enable_indexscan = off; SET enable_bitmapscan = off; SET enable_indexonlyscan = off;");
  const rows = await db.query(
    `WITH duplicate_keys AS (
       SELECT world_id, canonical_key
         FROM storyhold.world_clock_events
        GROUP BY world_id, canonical_key
       HAVING count(*) > 1
     )
     SELECT event.world_id::text, event.canonical_key,
            event.id::text, event.ctid::text, event.xmin::text,
            event.event_kind, event.title, length(event.summary) AS summary_length,
            jsonb_array_length(event.evidence) AS evidence_count,
            event.chronology_order::text, event.created_at::text,
            event.causal_parent_id::text
       FROM storyhold.world_clock_events event
       JOIN duplicate_keys USING (world_id, canonical_key)
      ORDER BY event.world_id::text, event.canonical_key,
               event.created_at DESC, event.xmin::text::bigint DESC`,
  );
  const referenced = await db.query(
    `SELECT conrelid::regclass::text AS table_name, conname,
            pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE confrelid = 'storyhold.world_clock_events'::regclass
      ORDER BY conrelid::regclass::text, conname`,
  );
  const loserReferences = await db.query(
    `WITH ranked AS (
       SELECT id,
              row_number() OVER (
                PARTITION BY world_id, canonical_key
                ORDER BY created_at DESC, xmin::text::bigint DESC, ctid::text DESC
              ) AS duplicate_number
         FROM storyhold.world_clock_events
     ), losers AS (
       SELECT id FROM ranked WHERE duplicate_number > 1
     )
     SELECT
       (SELECT count(*)::int FROM storyhold.world_clock_events event JOIN losers ON losers.id = event.causal_parent_id) AS causal_children,
       (SELECT count(*)::int FROM storyhold.world_event_participants participant JOIN losers ON losers.id = participant.event_id) AS participants,
       (SELECT count(*)::int FROM storyhold.world_event_relations relation JOIN losers ON losers.id = relation.source_event_id) AS source_relations,
       (SELECT count(*)::int FROM storyhold.world_event_relations relation JOIN losers ON losers.id = relation.target_event_id) AS target_relations`,
  );
  console.log(JSON.stringify({ duplicateRows: rows.rows, loserReferences: loserReferences.rows[0], referencingConstraints: referenced.rows }, null, 2));
} finally {
  await db.close();
}

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

const dataDir = process.argv[2];
if (!dataDir) throw new Error("Pass a closed PGlite data directory.");

type ConstraintRow = {
  table_name: string;
  constraint_name: string;
  definition: string;
};

type IndexRow = { index_name: string; definition: string };

function quotedIdentifier(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

function qualifiedTable(value: string): string {
  return value.split(".").map(quotedIdentifier).join(".");
}

/** The repair is allowed to discard only a truly generated, unreferenced
 * duplicate. An owner-created event or an event carrying an immutable paid
 * verification link always wins its duplicate group. If two protected rows
 * collide, the repair must stop rather than choose between canon records. */
function rankedClockRowsSql(receiptLinksAvailable: boolean, assignmentSourceAvailable: boolean): string {
  const protectedRow = `(event.created_by_player_id IS NOT NULL${assignmentSourceAvailable
    ? " OR event.assignment_source = 'user'"
    : ""}${receiptLinksAvailable
    ? ` OR EXISTS (
          SELECT 1
            FROM storyhold.world_clock_event_verifications verification
           WHERE verification.event_id = event.id
        )`
    : ""})`;
  return `SELECT event.ctid AS duplicate_row,
                 event.id,
                 ${protectedRow} AS is_protected,
                 row_number() OVER (
                   PARTITION BY event.world_id, event.canonical_key
                   ORDER BY CASE WHEN ${protectedRow} THEN 1 ELSE 0 END DESC,
                            event.created_at DESC,
                            event.xmin::text::bigint DESC,
                            event.ctid::text DESC
                 ) AS duplicate_number
            FROM storyhold.world_clock_events event`;
}

const db = await PGlite.create({ dataDir, extensions: { vector } });
try {
  await db.exec("SET enable_indexscan = off; SET enable_bitmapscan = off; SET enable_indexonlyscan = off;");
  const duplicateCount = await db.query<{ duplicate_ids: number }>(
    `SELECT count(*)::int AS duplicate_ids
       FROM (
         SELECT id FROM storyhold.world_entities GROUP BY id HAVING count(*) > 1
       ) duplicate_ids`,
  );
  const duplicateIds = duplicateCount.rows[0]?.duplicate_ids ?? 0;

  const referencingForeignKeys = await db.query<ConstraintRow>(
    `SELECT conrelid::regclass::text AS table_name,
            conname AS constraint_name,
            pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE confrelid = 'storyhold.world_entities'::regclass
        AND contype = 'f'
      ORDER BY conrelid::regclass::text, conname`,
  );
  const ownedUniqueConstraints = await db.query<ConstraintRow>(
    `SELECT conrelid::regclass::text AS table_name,
            conname AS constraint_name,
            pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid = 'storyhold.world_entities'::regclass
        AND contype IN ('p', 'u')
      ORDER BY CASE contype WHEN 'p' THEN 0 ELSE 1 END, conname`,
  );
  const standaloneIndexes = await db.query<IndexRow>(
    `SELECT indexname AS index_name, indexdef AS definition
       FROM pg_indexes
      WHERE schemaname = 'storyhold'
        AND tablename = 'world_entities'
        AND indexname NOT IN (
          SELECT conname FROM pg_constraint
           WHERE conrelid = 'storyhold.world_entities'::regclass
             AND contype IN ('p', 'u')
        )
      ORDER BY indexname`,
  );

  let removedCopies = 0;
  await db.transaction(async (tx) => {
    for (const constraint of referencingForeignKeys.rows) {
      await tx.exec(
        `ALTER TABLE ${qualifiedTable(constraint.table_name)} DROP CONSTRAINT ${quotedIdentifier(constraint.constraint_name)}`,
      );
    }
    for (const constraint of ownedUniqueConstraints.rows) {
      await tx.exec(
        `ALTER TABLE ${qualifiedTable(constraint.table_name)} DROP CONSTRAINT ${quotedIdentifier(constraint.constraint_name)}`,
      );
    }
    for (const index of standaloneIndexes.rows) {
      await tx.exec(`DROP INDEX IF EXISTS storyhold.${quotedIdentifier(index.index_name)}`);
    }

    const deleted = await tx.query<{ id: string }>(
      `DELETE FROM storyhold.world_entities
        WHERE ctid IN (
          SELECT duplicate_row
            FROM (
              SELECT ctid AS duplicate_row,
                     row_number() OVER (
                       PARTITION BY id
                       ORDER BY updated_at DESC, xmin::text::bigint DESC, ctid::text DESC
                     ) AS duplicate_number
                FROM storyhold.world_entities
            ) ranked
           WHERE duplicate_number > 1
        )
      RETURNING id::text`,
    );
    removedCopies = deleted.rows.length;

    for (const constraint of ownedUniqueConstraints.rows) {
      await tx.exec(
        `ALTER TABLE ${qualifiedTable(constraint.table_name)} ADD CONSTRAINT ${quotedIdentifier(constraint.constraint_name)} ${constraint.definition}`,
      );
    }
    for (const constraint of referencingForeignKeys.rows) {
      await tx.exec(
        `ALTER TABLE ${qualifiedTable(constraint.table_name)} ADD CONSTRAINT ${quotedIdentifier(constraint.constraint_name)} ${constraint.definition}`,
      );
    }
    for (const index of standaloneIndexes.rows) await tx.exec(index.definition);
  });

  const remaining = await db.query(
    "SELECT id::text, count(*)::int AS count FROM storyhold.world_entities GROUP BY id HAVING count(*) > 1",
  );
  if (remaining.rows.length > 0) {
    throw new Error(`Duplicate repair left ${remaining.rows.length} duplicate IDs.`);
  }

  const duplicateClockKeyCount = await db.query<{ duplicate_keys: number }>(
    `SELECT count(*)::int AS duplicate_keys
       FROM (
         SELECT world_id, canonical_key
           FROM storyhold.world_clock_events
          GROUP BY world_id, canonical_key
         HAVING count(*) > 1
       ) duplicate_keys`,
  );
  const duplicateClockKeys = duplicateClockKeyCount.rows[0]?.duplicate_keys ?? 0;
  let removedClockCopies = 0;
  if (duplicateClockKeys > 0) {
    const protectionSchema = await db.query<{
      receipt_links_available: boolean;
      assignment_source_available: boolean;
    }>(
      `SELECT to_regclass('storyhold.world_clock_event_verifications') IS NOT NULL AS receipt_links_available,
              EXISTS (
                SELECT 1 FROM pg_attribute
                 WHERE attrelid = 'storyhold.world_clock_events'::regclass
                   AND attname = 'assignment_source' AND NOT attisdropped
              ) AS assignment_source_available`,
    );
    const clockRanking = rankedClockRowsSql(
      Boolean(protectionSchema.rows[0]?.receipt_links_available),
      Boolean(protectionSchema.rows[0]?.assignment_source_available),
    );

    const clockForeignKeys = await db.query<ConstraintRow>(
      `SELECT conrelid::regclass::text AS table_name,
              conname AS constraint_name,
              pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE confrelid = 'storyhold.world_clock_events'::regclass
          AND contype = 'f'
        ORDER BY conrelid::regclass::text, conname`,
    );
    const clockUniqueConstraints = await db.query<ConstraintRow>(
      `SELECT conrelid::regclass::text AS table_name,
              conname AS constraint_name,
              pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'storyhold.world_clock_events'::regclass
          AND contype IN ('p', 'u')
        ORDER BY CASE contype WHEN 'p' THEN 0 ELSE 1 END, conname`,
    );
    const clockStandaloneIndexes = await db.query<IndexRow>(
      `SELECT indexname AS index_name, indexdef AS definition
         FROM pg_indexes
        WHERE schemaname = 'storyhold'
          AND tablename = 'world_clock_events'
          AND indexname NOT IN (
            SELECT conname FROM pg_constraint
             WHERE conrelid = 'storyhold.world_clock_events'::regclass
               AND contype IN ('p', 'u')
          )
        ORDER BY indexname`,
    );

    await db.transaction(async (tx) => {
      const loserReferences = await tx.query<{
        protected_losers: number;
        causal_children: number;
        participants: number;
        source_relations: number;
        target_relations: number;
      }>(
        `WITH ranked AS (${clockRanking}),
         losers AS (
           SELECT id, is_protected FROM ranked WHERE duplicate_number > 1
         )
         SELECT
           (SELECT count(*)::int FROM losers WHERE is_protected) AS protected_losers,
           (SELECT count(*)::int FROM storyhold.world_clock_events event JOIN losers ON losers.id = event.causal_parent_id) AS causal_children,
           (SELECT count(*)::int FROM storyhold.world_event_participants participant JOIN losers ON losers.id = participant.event_id) AS participants,
           (SELECT count(*)::int FROM storyhold.world_event_relations relation JOIN losers ON losers.id = relation.source_event_id) AS source_relations,
           (SELECT count(*)::int FROM storyhold.world_event_relations relation JOIN losers ON losers.id = relation.target_event_id) AS target_relations`,
      );
      const referenceCounts = loserReferences.rows[0];
      if (!referenceCounts || referenceCounts.protected_losers > 0) {
        throw new Error(
          "Refusing to remove duplicate World Clock rows because an owner-created or receipt-backed canon record would lose.",
        );
      }
      if (referenceCounts.causal_children > 0 || referenceCounts.participants > 0
        || referenceCounts.source_relations > 0 || referenceCounts.target_relations > 0) {
        throw new Error(
          "Refusing to remove duplicate World Clock rows because a redundant copy still has dependent canon records.",
        );
      }

      for (const constraint of clockForeignKeys.rows) {
        await tx.exec(
          `ALTER TABLE ${qualifiedTable(constraint.table_name)} DROP CONSTRAINT ${quotedIdentifier(constraint.constraint_name)}`,
        );
      }
      for (const constraint of clockUniqueConstraints.rows) {
        await tx.exec(
          `ALTER TABLE ${qualifiedTable(constraint.table_name)} DROP CONSTRAINT ${quotedIdentifier(constraint.constraint_name)}`,
        );
      }
      for (const index of clockStandaloneIndexes.rows) {
        await tx.exec(`DROP INDEX IF EXISTS storyhold.${quotedIdentifier(index.index_name)}`);
      }

      const deleted = await tx.query<{ id: string }>(
        `DELETE FROM storyhold.world_clock_events
          WHERE ctid IN (
            SELECT duplicate_row
              FROM (${clockRanking}) ranked
             WHERE duplicate_number > 1 AND is_protected = false
          )
        RETURNING id::text`,
      );
      removedClockCopies = deleted.rows.length;

      for (const constraint of clockUniqueConstraints.rows) {
        await tx.exec(
          `ALTER TABLE ${qualifiedTable(constraint.table_name)} ADD CONSTRAINT ${quotedIdentifier(constraint.constraint_name)} ${constraint.definition}`,
        );
      }
      for (const constraint of clockForeignKeys.rows) {
        await tx.exec(
          `ALTER TABLE ${qualifiedTable(constraint.table_name)} ADD CONSTRAINT ${quotedIdentifier(constraint.constraint_name)} ${constraint.definition}`,
        );
      }
      for (const index of clockStandaloneIndexes.rows) await tx.exec(index.definition);
    });
  }

  await db.exec("REINDEX SCHEMA storyhold");
  console.log(JSON.stringify({
    duplicateEntityIds: duplicateIds,
    removedEntityCopies: removedCopies,
    duplicateClockKeys,
    removedClockCopies,
    remaining: 0,
    reindexedSchema: "storyhold",
  }));
} finally {
  await db.close();
}

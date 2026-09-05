import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

const [dataDirArgument] = process.argv.slice(2);
if (!dataDirArgument) {
  throw new Error("Usage: repairPgliteIndexes <data-dir>");
}

const dataDir = path.resolve(dataDirArgument);
const db = await PGlite.create({ dataDir, extensions: { vector } });

try {
  // Repair the two non-unique dependency indexes first. A damaged dependency
  // index can make ordinary idempotent schema checks fail before the app opens.
  await db.exec("REINDEX INDEX pg_catalog.pg_depend_depender_index");
  await db.exec("REINDEX INDEX pg_catalog.pg_depend_reference_index");
  const duplicateConstraints = await db.query<{
    conrelid: string;
    contypid: string;
    conname: string;
    count: number;
  }>(
    `SELECT conrelid::text, contypid::text, conname, count(*)::int AS count
       FROM pg_catalog.pg_constraint
      GROUP BY conrelid, contypid, conname
     HAVING count(*) > 1
      ORDER BY count(*) DESC, conrelid, conname`,
  );
  if (duplicateConstraints.rows.length > 0) {
    const duplicateDetails = await db.query<{
      oid: string;
      relation_name: string;
      conname: string;
      contype: string;
      convalidated: boolean;
      conislocal: boolean;
      coninhcount: number;
      definition: string;
    }>(
      `SELECT constraint_row.oid::text,
              constraint_row.conrelid::regclass::text AS relation_name,
              constraint_row.conname,
              constraint_row.contype,
              constraint_row.convalidated,
              constraint_row.conislocal,
              constraint_row.coninhcount,
              pg_get_constraintdef(constraint_row.oid) AS definition
         FROM pg_catalog.pg_constraint constraint_row
         JOIN (
           SELECT conrelid, contypid, conname
             FROM pg_catalog.pg_constraint
            GROUP BY conrelid, contypid, conname
           HAVING count(*) > 1
         ) duplicate
           ON duplicate.conrelid = constraint_row.conrelid
          AND duplicate.contypid = constraint_row.contypid
          AND duplicate.conname = constraint_row.conname
        ORDER BY relation_name, constraint_row.conname, constraint_row.oid`,
    );
    const groups = new Map<string, typeof duplicateDetails.rows>();
    for (const row of duplicateDetails.rows) {
      const key = `${row.relation_name}:${row.conname}`;
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    const safeDuplicateOids: string[] = [];
    for (const [key, group] of groups) {
      const definitions = new Set(group.map((row) => row.definition));
      if (
        group.length !== 2 ||
        definitions.size !== 1 ||
        group.some((row) =>
          !row.relation_name.startsWith("storyhold.") ||
          row.contype !== "c" ||
          !row.convalidated ||
          !row.conislocal ||
          row.coninhcount !== 0
        )
      ) {
        throw new Error(`Unsafe duplicate constraint group ${key}; manual review is required.`);
      }
      group.sort((left, right) => Number(left.oid) - Number(right.oid));
      safeDuplicateOids.push(group[1]!.oid);
    }
    process.stdout.write(
      `Removing ${safeDuplicateOids.length} byte-for-byte duplicate Storyhold CHECK constraints.\n`,
    );
    await db.exec("SET allow_system_table_mods = on");
    await db.exec("BEGIN");
    try {
      await db.query(
        `DELETE FROM pg_catalog.pg_depend
          WHERE classid = 'pg_catalog.pg_constraint'::regclass
            AND objid = ANY($1::oid[])`,
        [safeDuplicateOids],
      );
      await db.query(
        `DELETE FROM pg_catalog.pg_description
          WHERE classoid = 'pg_catalog.pg_constraint'::regclass
            AND objoid = ANY($1::oid[])`,
        [safeDuplicateOids],
      );
      await db.query(
        "DELETE FROM pg_catalog.pg_constraint WHERE oid = ANY($1::oid[])",
        [safeDuplicateOids],
      );
      await db.exec("COMMIT");
    } catch (error) {
      await db.exec("ROLLBACK");
      throw error;
    }
  }
  const current = await db.query<{ database_name: string }>("SELECT current_database() AS database_name");
  const databaseName = current.rows[0]?.database_name;
  if (!databaseName || !/^[a-zA-Z0-9_]+$/u.test(databaseName)) throw new Error("Unsafe database name.");
  await db.exec(`REINDEX SYSTEM ${databaseName}`);
  await db.exec("REINDEX SCHEMA storyhold");
  await db.query("SELECT count(*)::int AS world_count FROM storyhold.worlds");
  process.stdout.write(`Rebuilt PGlite system and Storyhold indexes in ${dataDir}.\n`);
} finally {
  await db.close();
}

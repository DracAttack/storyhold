import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

const dataDir = process.argv[2];
if (!dataDir) throw new Error("Pass a closed PGlite data directory.");

type ConstraintRow = {
  table_schema: string;
  table_name: string;
  constraint_name: string;
  column_names: string[];
};

function identifier(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

const db = await PGlite.create({ dataDir, extensions: { vector } });
try {
  await db.exec("SET enable_indexscan = off; SET enable_bitmapscan = off; SET enable_indexonlyscan = off;");
  const constraints = await db.query<ConstraintRow>(
    `SELECT namespace.nspname AS table_schema,
            relation.relname AS table_name,
            constraint_row.conname AS constraint_name,
            array_agg(attribute.attname ORDER BY key_column.ordinality) AS column_names
       FROM pg_constraint constraint_row
       JOIN pg_class relation ON relation.oid = constraint_row.conrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, ordinality) ON true
       JOIN pg_attribute attribute
         ON attribute.attrelid = constraint_row.conrelid
        AND attribute.attnum = key_column.attnum
      WHERE namespace.nspname = 'storyhold'
        AND constraint_row.contype IN ('p', 'u')
      GROUP BY namespace.nspname, relation.relname, constraint_row.conname
      ORDER BY relation.relname, constraint_row.conname`,
  );

  const violations: Array<Record<string, unknown>> = [];
  for (const constraint of constraints.rows) {
    const table = `${identifier(constraint.table_schema)}.${identifier(constraint.table_name)}`;
    const columns = constraint.column_names.map(identifier);
    const nonNull = columns.map((column) => `${column} IS NOT NULL`).join(" AND ");
    const result = await db.query<{ duplicate_groups: number; extra_rows: number }>(
      `SELECT count(*)::int AS duplicate_groups,
              COALESCE(sum(copies - 1), 0)::int AS extra_rows
         FROM (
           SELECT count(*)::int AS copies
             FROM ${table}
            WHERE ${nonNull}
            GROUP BY ${columns.join(", ")}
           HAVING count(*) > 1
         ) duplicates`,
    );
    const row = result.rows[0];
    if ((row?.duplicate_groups ?? 0) > 0) {
      violations.push({
        table: `${constraint.table_schema}.${constraint.table_name}`,
        constraint: constraint.constraint_name,
        columns: constraint.column_names,
        duplicateGroups: row?.duplicate_groups ?? 0,
        extraRows: row?.extra_rows ?? 0,
      });
    }
  }
  console.log(JSON.stringify({ constraintsChecked: constraints.rows.length, violations }, null, 2));
} finally {
  await db.close();
}

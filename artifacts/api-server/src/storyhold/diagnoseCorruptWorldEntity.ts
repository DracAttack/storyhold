import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

const [dataDirArgument, worldId] = process.argv.slice(2);
if (!dataDirArgument || !worldId) {
  throw new Error("Usage: diagnoseCorruptWorldEntity <data-dir> <world-id>");
}

const db = await PGlite.create({
  dataDir: path.resolve(dataDirArgument),
  extensions: { vector },
});

const inspectedColumns = [
  "canonical_key",
  "normalized_name",
  "name",
  "aliases",
  "alias_attributions",
  "summary",
  "details",
  "relationships",
  "estimated_stats",
  "evidence",
] as const;

try {
  const entities = await db.query<{ id: string; name: string }>(
    "SELECT id, name FROM storyhold.world_entities WHERE world_id = $1 ORDER BY id",
    [worldId],
  );
  const damaged: Array<{ id: string; name: string; column: string; error: string }> = [];
  for (const column of inspectedColumns) {
    try {
      await db.query(
        `SELECT id, ${column} FROM storyhold.world_entities WHERE world_id = $1`,
        [worldId],
      );
      continue;
    } catch {
      // Narrow only the failing column to the exact row. Column names are from
      // the fixed allowlist above and never come from command-line input.
    }
    for (const entity of entities.rows) {
      try {
        await db.query(`SELECT ${column} FROM storyhold.world_entities WHERE id = $1`, [entity.id]);
      } catch (error) {
        damaged.push({
          id: entity.id,
          name: entity.name,
          column,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  process.stdout.write(`${JSON.stringify(damaged, null, 2)}\n`);
  if (damaged.length === 0) process.stdout.write("No damaged world-entity fields found.\n");
} finally {
  await db.close();
}

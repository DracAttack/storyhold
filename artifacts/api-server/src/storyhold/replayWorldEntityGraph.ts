import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { replayGeneratedWorldEntityGraph } from "./worldStudio";

const [dataDirArgument, worldId] = process.argv.slice(2);
if (!dataDirArgument || !worldId) {
  throw new Error("Usage: replayWorldEntityGraph <data-dir> <world-id>");
}

const db = await PGlite.create({
  dataDir: path.resolve(dataDirArgument),
  extensions: { vector },
});

try {
  const edition = await db.query<{ id: string }>(
    `SELECT id FROM storyhold.canon_editions
      WHERE world_id = $1 ORDER BY created_at ASC LIMIT 1`,
    [worldId],
  );
  if (!edition.rows[0]) throw new Error(`World ${worldId} was not found.`);
  const result = await replayGeneratedWorldEntityGraph(
    db,
    worldId,
    edition.rows[0].id,
  );
  process.stdout.write(
    `Rebuilt the generated entity graph with ${result.referenceIssues.length} rejected or unresolved references.\n`,
  );
} finally {
  await db.close();
}

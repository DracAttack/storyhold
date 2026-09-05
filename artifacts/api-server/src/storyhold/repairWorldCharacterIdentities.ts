import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { repairGeneratedCharacterIdentities } from "./characterIdentity";

const [dataDirArgument, worldId, rawTargetNames] = process.argv.slice(2);
if (!dataDirArgument || !worldId) {
  throw new Error("Usage: repairWorldCharacterIdentities <data-dir> <world-id> [comma-separated names]");
}
const db = await PGlite.create({ dataDir: path.resolve(dataDirArgument), extensions: { vector } });
try {
  const edition = await db.query<{ id: string }>(
    `SELECT id FROM storyhold.canon_editions WHERE world_id = $1 ORDER BY created_at ASC LIMIT 1`,
    [worldId],
  );
  if (!edition.rows[0]) throw new Error(`World ${worldId} was not found.`);
  const result = await repairGeneratedCharacterIdentities({
    db,
    worldId,
    editionId: edition.rows[0].id,
    targetCharacterNames: rawTargetNames?.split(",").map((name) => name.trim()).filter(Boolean),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await db.close();
}

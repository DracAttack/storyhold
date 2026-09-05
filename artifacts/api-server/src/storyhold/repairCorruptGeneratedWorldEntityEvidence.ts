import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { localEntityTextIsUseful } from "./localEntityExtraction";

const [dataDirArgument, ...entityIds] = process.argv.slice(2);
if (!dataDirArgument || entityIds.length === 0) {
  throw new Error("Usage: repairCorruptGeneratedWorldEntityEvidence <data-dir> <entity-id> [...entity-id]");
}

const db = await PGlite.create({
  dataDir: path.resolve(dataDirArgument),
  extensions: { vector },
});

try {
  const rows = await db.query<{
    id: string;
    name: string;
    classification_source: string;
    review_status: string;
  }>(
    `SELECT id, name, classification_source, review_status
       FROM storyhold.world_entities
      WHERE id = ANY($1::uuid[])
      ORDER BY id`,
    [entityIds],
  );
  if (rows.rows.length !== entityIds.length) throw new Error("One or more requested entities were not found.");
  for (const row of rows.rows) {
    if (
      row.classification_source !== "local" ||
      row.review_status === "user_confirmed" ||
      localEntityTextIsUseful(row.name)
    ) {
      throw new Error(`Refusing to replace evidence for protected or meaningful entity ${row.name} (${row.id}).`);
    }
  }
  await db.query(
    `UPDATE storyhold.world_entities
        SET evidence = '[]'::jsonb,
            scanner_present = false,
            pull_status = 'do_not_pull',
            updated_at = now()
      WHERE id = ANY($1::uuid[])
        AND classification_source = 'local'
        AND review_status <> 'user_confirmed'`,
    [entityIds],
  );
  process.stdout.write(
    `Replaced unreadable generated evidence for: ${rows.rows.map((row) => row.name).join(", ")}.\n`,
  );
} finally {
  await db.close();
}

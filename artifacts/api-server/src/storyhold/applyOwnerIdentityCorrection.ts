import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import {
  applyOwnerCharacterNameCorrection,
  repairGeneratedCharacterIdentities,
} from "./characterIdentity";
import { saveOwnerCanonConstraint } from "./conceptResolution";

const [
  dataDirArgument,
  worldId,
  currentName,
  correctedName,
  instruction,
  suppliedQuote = "",
] = process.argv.slice(2);

if (!dataDirArgument || !worldId || !currentName || !correctedName || !instruction) {
  throw new Error(
    "Usage: applyOwnerIdentityCorrection <data-dir> <world-id> <current-name> <corrected-name> <instruction> [supplied-quote]",
  );
}

const db = await PGlite.create({
  dataDir: path.resolve(dataDirArgument),
  extensions: { vector },
});

try {
  await db.exec(`
    ALTER TABLE storyhold.character_dossiers
      ADD COLUMN IF NOT EXISTS alias_attributions jsonb NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE storyhold.world_entities
      ADD COLUMN IF NOT EXISTS alias_attributions jsonb NOT NULL DEFAULT '[]'::jsonb;
  `);
  const scope = await db.query<{
    edition_id: string;
    owner_player_id: string;
  }>(
    `SELECT edition.id AS edition_id, world.owner_player_id
       FROM storyhold.worlds world
       JOIN storyhold.canon_editions edition ON edition.world_id = world.id
      WHERE world.id = $1
      ORDER BY edition.created_at ASC
      LIMIT 1`,
    [worldId],
  );
  const row = scope.rows[0];
  if (!row) throw new Error(`World ${worldId} was not found.`);
  const repaired = await repairGeneratedCharacterIdentities({
    db,
    worldId,
    editionId: row.edition_id,
  });
  const corrected = await applyOwnerCharacterNameCorrection({
    db,
    worldId,
    editionId: row.edition_id,
    currentName,
    correctedName,
    instruction,
    suppliedQuote,
  });
  if (!corrected) {
    const active = await db.query<{ name: string; aliases: string[] }>(
      `SELECT name, aliases FROM storyhold.world_entities
        WHERE world_id = $1 AND canon_edition_id = $2
          AND entity_type = 'character' AND pull_status = 'active'
          AND scanner_present = true
        ORDER BY mention_count DESC, name
        LIMIT 80`,
      [worldId, row.edition_id],
    );
    throw new Error(
      `The active character ${currentName} was not found. Active identities: ${active.rows.map((entry) => entry.name).join(", ")}`,
    );
  }
  await saveOwnerCanonConstraint({
    db,
    worldId,
    editionId: row.edition_id,
    playerId: row.owner_player_id,
    entityId: corrected.entityId,
    instruction,
    forceKind: "identity",
  });
  process.stdout.write(`${JSON.stringify({ repaired, corrected })}\n`);
} finally {
  await db.close();
}

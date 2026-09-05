import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { syncWorldEntityMentions } from "./worldKnowledge";

const [dataDirArgument, worldId, snapshotArgument] = process.argv.slice(2);
if (!dataDirArgument || !worldId || !snapshotArgument) {
  throw new Error("Usage: restoreIdentitySnapshot <data-dir> <world-id> <snapshot-json>");
}

const snapshot = JSON.parse(await readFile(path.resolve(snapshotArgument), "utf8")) as {
  world?: { id?: string; canon_edition_id?: string };
  entities?: Array<Record<string, unknown>>;
  dossiers?: Array<Record<string, unknown>>;
};
if (snapshot.world?.id !== worldId || !snapshot.world.canon_edition_id) {
  throw new Error("The snapshot does not belong to the requested world.");
}

const db = await PGlite.create({
  dataDir: path.resolve(dataDirArgument),
  extensions: { vector },
});

try {
  await db.transaction(async (tx) => {
    for (const entity of snapshot.entities ?? []) {
      if (!entity.id) continue;
      const priorStatus = String(entity.pull_status ?? "active");
      await tx.query(
        `UPDATE storyhold.world_entities
            SET name = $2, normalized_name = $3, aliases = $4::jsonb,
                pull_status = $5, scanner_present = $6,
                merged_into_entity_id = CASE
                  WHEN $5 IN ('active', 'do_not_pull') THEN NULL
                  ELSE merged_into_entity_id END,
                alias_attributions = '[]'::jsonb, updated_at = now()
          WHERE id = $1 AND world_id = $7 AND canon_edition_id = $8`,
        [
          entity.id,
          entity.name,
          entity.normalized_name,
          JSON.stringify(Array.isArray(entity.aliases) ? entity.aliases : []),
          priorStatus,
          entity.scanner_present === true,
          worldId,
          snapshot.world!.canon_edition_id,
        ],
      );
    }
    for (const dossier of snapshot.dossiers ?? []) {
      if (!dossier.id) continue;
      await tx.query(
        `UPDATE storyhold.character_dossiers
            SET name = $2, normalized_name = $3, aliases = $4::jsonb,
                dossier_status = $5, alias_attributions = '[]'::jsonb,
                updated_at = now()
          WHERE id = $1 AND world_id = $6 AND canon_edition_id = $7`,
        [
          dossier.id,
          dossier.name,
          dossier.normalized_name,
          JSON.stringify(Array.isArray(dossier.aliases) ? dossier.aliases : []),
          dossier.dossier_status ?? "active",
          worldId,
          snapshot.world!.canon_edition_id,
        ],
      );
    }
  });
  await syncWorldEntityMentions({
    db,
    worldId,
    editionId: snapshot.world.canon_edition_id,
  });
  process.stdout.write(
    `Restored ${(snapshot.entities ?? []).length} entity identities and ${(snapshot.dossiers ?? []).length} dossier identities.\n`,
  );
} finally {
  await db.close();
}

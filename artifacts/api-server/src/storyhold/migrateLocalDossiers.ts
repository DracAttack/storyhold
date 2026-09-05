import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { migrateLocalDossierUnderstanding } from "./worldStudio";
import { releaseLorekeeperStage } from "./localLorekeeperModels";

// This is an explicit local-maintenance entry point, so it must use the same
// loopback Lorekeeper service as normal intake even when it is launched outside
// the Storyhold server process. Individual stage URLs are derived from this one.
process.env.STORYHOLD_LOCAL_NER_URL ||= "http://127.0.0.1:8765/gliner2";
process.env.STORYHOLD_LOCAL_QWEN_ENABLED ||= "true";

const [dataDirArgument, worldId, maximumCharactersArgument, rawTargetNamesArgument, rawModeArgument] = process.argv.slice(2);
const modeArgument = rawTargetNamesArgument === "local-projection-only"
  ? rawTargetNamesArgument
  : rawModeArgument;
const targetNamesArgument = rawTargetNamesArgument === "local-projection-only"
  ? undefined
  : rawTargetNamesArgument;
if (!dataDirArgument || !worldId) {
  throw new Error(
    "Usage: migrateLocalDossiers <data-dir> <world-id> [maximum-characters]",
  );
}

const maximumCharacters = Math.max(
  1,
  Math.min(20, Math.round(Number(maximumCharactersArgument) || 6)),
);
const phaseLabels = {
  identity_repair: "Identity Repair",
  global_profile_revalidation: "Global Profile Revalidation",
  target_assembly: "Target Assembly",
  relationship_projection: "Relationship Projection",
  deterministic_enrichment: "Deterministic Enrichment",
  qwen_ready: "Qwen Ready",
  qwen_synthesis: "Qwen Synthesis",
} as const;
const db = await PGlite.create({
  dataDir: path.resolve(dataDirArgument),
  extensions: { vector },
});

try {
  const edition = await db.query<{ id: string; name: string }>(
    `SELECT id, name
       FROM storyhold.canon_editions
      WHERE world_id = $1
      ORDER BY created_at ASC
      LIMIT 1`,
    [worldId],
  );
  if (!edition.rows[0]) throw new Error(`World ${worldId} was not found.`);
  process.stdout.write(
    modeArgument === "local-projection-only"
      ? "Refreshing evidence-grounded local dossier projections…\n"
      : `Migrating ${maximumCharacters} principal dossiers with the stronger local synthesis…\n`,
  );
  await migrateLocalDossierUnderstanding(db, worldId, edition.rows[0].id, {
    force: true,
    localProjectionOnly: modeArgument === "local-projection-only",
    // A projection-only refresh must never revisit identity merges or replace a
    // relationship web that has already survived intake and owner review. This
    // mode is for regenerating customer-facing prose from saved evidence only.
    // `dossier-only` is the safe maintenance mode after identity repair has
    // already been reviewed. It rebuilds the evidence web and runs the stronger
    // synthesis without allowing a second identity discovery pass to merge
    // unrelated speakers merely because they share a POV chapter.
    repairIdentities: ["local-projection-only", "dossier-only"].includes(modeArgument ?? "")
      ? false
      : undefined,
    rebuildConnections: modeArgument === "local-projection-only" ? false : undefined,
    maximumCharacters,
    targetCharacterNames: targetNamesArgument
      ? targetNamesArgument.split(",").map((name) => name.trim()).filter(Boolean)
      : undefined,
    onProgress: (completed, total, characterName) => {
      process.stdout.write(
        `Synthesized ${characterName} (${completed.toLocaleString()} of ${total.toLocaleString()}).\n`,
      );
    },
    onPhase: (event) => {
      const duration = event.status === "complete"
        ? ` in ${(event.elapsedMs / 1_000).toFixed(1)}s`
        : "";
      const counts = Object.entries(event.counts)
        .map(([key, value]) => `${key}=${value.toLocaleString()}`)
        .join(", ");
      process.stdout.write(
        `${phaseLabels[event.phase]} ${event.status}${duration}` +
        ` (total ${(event.totalElapsedMs / 1_000).toFixed(1)}s` +
        `${counts ? `; ${counts}` : ""}).\n`,
      );
    },
  });
  process.stdout.write("Local dossier migration completed.\n");
} finally {
  await releaseLorekeeperStage().catch(() => undefined);
  await db.close();
}

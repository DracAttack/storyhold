import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "../artifacts/api-server/node_modules/@electric-sql/pglite/dist/index.js";
import { vector } from "../artifacts/api-server/node_modules/@electric-sql/pglite-pgvector/dist/index.js";
import { premiumReviewReconciliationPending } from "../artifacts/api-server/src/storyhold/premiumReviewJournal";
import { acquireStoryholdVaultOwnership } from "../artifacts/api-server/src/storyhold/vaultOwnership";

// Inventory for the owner-requested local world reset; read-only unless the
// explicit deletion flag is supplied. Stop the site's database process first.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envText = await readFile(path.join(root, ".storyhold.env"), "utf8");
const configured = envText.split(/\r?\n/u).find((line) => line.startsWith("STORYHOLD_LOCAL_DATA_DIR="))?.split("=").slice(1).join("=").trim().replace(/^['"]|['"]$/gu, "");
const dataDir = path.resolve(root, configured || ".storyhold-data/postgres");
let serverResponding = false;
try {
  const response = await fetch("http://127.0.0.1:3000/api/healthz", { signal: AbortSignal.timeout(2000) });
  serverResponding = response.ok;
} catch { /* The configured local HTTP listener is stopped. */ }
if (serverResponding) throw new Error("Stop Storyhold through its orderly shutdown endpoint before opening its embedded vault.");
const ownership = await acquireStoryholdVaultOwnership(dataDir, { purpose: "world-reset maintenance" });
const db = await PGlite.create({ dataDir: ownership.dataDir, extensions: { vector }, debug: process.argv.includes("--diagnose-open") ? 1 : 0 })
  .catch((error) => { console.error("Vault could not open:", error instanceof Error ? error.message : String(error)); process.exit(1); });
try {
  const worlds = await db.query(`SELECT w.id, w.name, p.email AS owner_email,
    (SELECT count(*)::int FROM storyhold.world_sources s WHERE s.world_id=w.id) AS sources,
    (SELECT count(*)::int FROM storyhold.campaigns c WHERE c.world_id=w.id) AS campaigns,
    (SELECT count(*)::int FROM storyhold.world_entities e WHERE e.world_id=w.id) AS entities
    FROM storyhold.worlds w JOIN storyhold.players p ON p.id=w.owner_player_id ORDER BY w.created_at`);
  const active = await db.query(`SELECT world_id, status, count(*)::int AS count FROM storyhold.world_analysis_runs
    WHERE status IN ('queued','running','paused') GROUP BY world_id,status`);
  const held = await db.query(`SELECT world_id, status, count(*)::int AS count FROM storyhold.credit_reservations
    WHERE status='reserved' GROUP BY world_id,status`);
  const samples = await db.query(`SELECT world_id, name, entity_type, pull_status, review_status,
    summary, evidence FROM storyhold.world_entities
    WHERE lower(name) IN ('beast','the beast','toilet','sanctuary') ORDER BY world_id,name`);
  const dependencies = await db.query(`SELECT c.conrelid::regclass::text AS child_table,
    c.confrelid::regclass::text AS parent_table, c.conname, pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c WHERE c.contype='f' AND c.confrelid IN
      ('storyhold.worlds'::regclass,'storyhold.campaigns'::regclass,'storyhold.characters'::regclass)
    ORDER BY parent_table,child_table`);
  const triggers = await db.query(`SELECT t.tgrelid::regclass::text AS table_name,
    pg_get_triggerdef(t.oid) AS definition, pg_get_functiondef(t.tgfoid) AS function
    FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid IN
      ('storyhold.worlds'::regclass,'storyhold.campaigns'::regclass,'storyhold.world_state_events'::regclass)`);
  if (process.argv.includes("--delete-confirmed-worlds")) {
    const expected = new Map([
      ["4b1d618d-b9d1-4427-920c-cea85b5e6d9e", "ALIEN: A NEW BREED"],
      ["1aa51688-6111-4fa6-9127-4a079dd0036e", "Ironbound"],
      ["5e0bebbc-06fd-414b-be7a-bb02732f7808", "ASHES"],
    ]);
    const deleted = await db.transaction(async (tx) => {
      const locked = await tx.query<{id:string;name:string}>("SELECT id,name FROM storyhold.worlds ORDER BY id FOR UPDATE");
      if (locked.rows.length !== expected.size || locked.rows.some((w) => expected.get(w.id) !== w.name)) {
        throw new Error("The world inventory changed; deletion aborted.");
      }
      const busy = await tx.query<{busy:boolean}>(`SELECT EXISTS (SELECT 1 FROM storyhold.campaigns)
        OR EXISTS (SELECT 1 FROM storyhold.world_analysis_runs WHERE status IN ('queued','running','paused'))
        OR EXISTS (SELECT 1 FROM storyhold.credit_reservations WHERE status='reserved') AS busy`);
      if (busy.rows[0]?.busy) throw new Error("Active work or campaigns require the normal deletion workflow.");
      for (const world of locked.rows) {
        if (await premiumReviewReconciliationPending(tx, world.id)) throw new Error(`Unsettled review in ${world.name}; deletion aborted.`);
      }
      for (const world of locked.rows) {
        await tx.query("DELETE FROM storyhold.worlds WHERE id=$1 AND name=$2", [world.id, world.name]);
      }
      return locked.rows;
    });
    const remaining = await db.query("SELECT count(*)::int AS worlds FROM storyhold.worlds");
    console.log(JSON.stringify({deleted, remaining:remaining.rows}));
    // PostgreSQL can reuse the freed pages. Physical compaction is a separate
    // maintenance decision, not a reason to recreate the entire database.
  } else if (process.argv.includes("--summary")) {
    console.log(JSON.stringify({ worlds: worlds.rows, active: active.rows, held: held.rows }));
  } else {
    console.log(JSON.stringify({ dataDir, worlds: worlds.rows, active: active.rows, held: held.rows,
    reportedRegressionSamples: samples.rows, dependencies: dependencies.rows, triggers: triggers.rows }, null, 2));
  }
} finally { await db.close(); await ownership.release(); }

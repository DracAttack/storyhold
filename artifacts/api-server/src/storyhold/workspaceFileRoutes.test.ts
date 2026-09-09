import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { once } from "node:events";
import { Readable } from "node:stream";
import { registerWorldStudioRoutes } from "./worldStudio";

const world = "10000000-0000-4000-8000-000000000001";
const edition = "10000000-0000-4000-8000-000000000002";
const dossier = "10000000-0000-4000-8000-000000000003";
const item = "10000000-0000-4000-8000-000000000004";

test("private preview/download routes preserve authentication, owner scope and scan gating", async () => {
  process.env.NODE_ENV = "test";
  let scanState = "pending"; let contentType = "image/png"; let storageReads = 0;
  const app = express();
  const db = {
    async exec() {},
    async query(sql: string, args: unknown[] = []) {
      if (sql.includes("FROM storyhold.worlds") && sql.includes("owner_player_id = $2")) {
        return { rows: args[0] === world && args[1] === "owner" ? [{ id: world, owner_player_id: "owner" }] : [] };
      }
      if (sql.includes("FROM storyhold.canon_editions")) return { rows: [{ id: edition }] };
      if (sql.includes("FROM storyhold.character_dossiers") && sql.includes("LIMIT 1")) {
        return { rows: args[0] === dossier && args[1] === world && args[2] === edition ? [{ id: dossier }] : [] };
      }
      if (sql.includes("FROM storyhold.character_workspace_items")) {
        assert.ok(sql.includes("world_id=$2") && sql.includes("canon_edition_id=$3") && sql.includes("dossier_id=$4"));
        return { rows: args[0] === item && args[1] === world && args[2] === edition && args[3] === dossier
          ? [{ file_object_key: "private-object-key", file_name: "private-reference.png", file_content_type: contentType, file_scan_state: scanState }] : [] };
      }
      if (sql.includes("FROM storyhold.private_file_jobs")) {
        assert.ok(!sql.includes("object_key") && !sql.includes("item_id"));
        return { rows: [{ id: "job", operation: "cleanup", status: "failed", attempts: 6, error_code: "storage_delete_failed" }] };
      }
      return { rows: [] };
    },
  };
  const routes = registerWorldStudioRoutes({ app, db: db as never,
    requireUser: (req, res, next) => {
      const id = req.header("x-test-user");
      if (!id) { res.status(401).json({ error: "Sign in required." }); return; }
      (req as unknown as { localUser: unknown }).localUser = { id, email: "test@example.invalid", role: req.header("x-test-role") || "player" };
      next();
    },
    sourceVaultStorage: {
      async uploadSource() { throw new Error("no upload expected"); }, async deleteSource() {}, async deleteWorldSources() {},
      async downloadSource() { storageReads++; return Readable.from([Buffer.from("private image")]); },
    },
  });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const prefix = `/api/storyhold/worlds/${world}/characters/${dossier}/workspace/${item}`;
  const request = (path: string, user = "owner", role = "player") => fetch(`${base}${path}`, {
    headers: user ? { "x-test-user": user, "x-test-role": role } : {},
  });
  try {
    assert.equal((await request(`${prefix}/preview`, "")).status, 401);
    assert.equal((await request(`${prefix}/preview`, "stranger")).status, 404);
    assert.equal((await request(`${prefix}/preview`)).status, 423);
    assert.equal((await request(`${prefix}/download`)).status, 423);
    scanState = "quarantined";
    assert.equal((await request(`${prefix}/preview`)).status, 423);
    assert.equal(storageReads, 0);
    scanState = "clean";
    const preview = await request(`${prefix}/preview`);
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get("content-disposition")!, /^inline;/);
    assert.equal(preview.headers.get("cache-control"), "private, no-store");
    assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await preview.text(), "private image");
    contentType = "application/pdf";
    assert.equal((await request(`${prefix}/preview`)).status, 415);
    const download = await request(`${prefix}/download`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition")!, /^attachment;/);
    assert.equal((await request(`${prefix.replace(item, edition)}/download`)).status, 404);
    const admin = "/api/storyhold/admin/private-file-jobs";
    assert.equal((await request(admin, "")).status, 401);
    assert.equal((await request(admin)).status, 403);
    const report = await request(admin, "owner", "admin");
    assert.equal(report.status, 200);
    assert.doesNotMatch(await report.text(), /private-object-key|private-reference/);
  } finally {
    await routes.stopPrivateFileWorker();
    server.close(); server.closeAllConnections(); await once(server, "close");
  }
});

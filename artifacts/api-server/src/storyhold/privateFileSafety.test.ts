import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Readable } from "node:stream";
import { createServer } from "node:net";
import { once } from "node:events";
import {
  privateFileSafetySchemaSql, createPrivateFileWorker, workspaceFileScan,
  privateFileJobReport, privateFileRetrySeconds, stagePrivateFileUpload, commitPrivateFileUpload, abandonPrivateFileUpload,
} from "./privateFileSafety";
import { createPrivateFileScanner, scanWithClamd } from "./privateFileScanner";
import type { StoryholdSourceVaultStorage } from "./sourceVaultStorage";

async function fixture() {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.character_workspace_items(id uuid PRIMARY KEY, kind text,
      file_object_key text,file_size bigint,updated_at timestamptz NOT NULL DEFAULT now());`);
  await db.exec(privateFileSafetySchemaSql);
  const deleted: string[] = [];
  const storage: StoryholdSourceVaultStorage = {
    async uploadSource() { return "unused"; }, async deleteWorldSources() {},
    async deleteSource(key) { deleted.push(key); },
    async downloadSource() { return Readable.from([Buffer.from("reference")]); },
  };
  async function add() {
    const id = randomUUID(); const key = `private-${id}`;
    await db.query(`INSERT INTO storyhold.character_workspace_items(id,kind,file_object_key,file_size) VALUES ($1,'file',$2,9)`, [id, key]);
    return { id, key };
  }
  async function due() { await db.exec(`UPDATE storyhold.private_file_jobs SET next_attempt_at=now()-interval '1 second',lease_until=now()-interval '1 second'`); }
  return { db, storage, deleted, add, due };
}

test("pending uploads only become clean following scanner verdict; migration is idempotent", async () => {
  const f = await fixture();
  try {
    const item = await f.add();
    const row = (await f.db.query(`SELECT * FROM storyhold.character_workspace_items WHERE id=$1`, [item.id])).rows[0]!;
    assert.equal(workspaceFileScan(row).state, "pending");
    assert.equal(workspaceFileScan({}).state, "pending");
    await f.db.exec(privateFileSafetySchemaSql);
    let calls = 0;
    await createPrivateFileWorker(f.db, f.storage, async (bytes) => {
      calls++; assert.equal(bytes.toString(), "reference"); return "clean";
    }).tick();
    assert.equal(calls, 1);
    const checked = (await f.db.query(`SELECT * FROM storyhold.character_workspace_items`)).rows[0]!;
    assert.equal(workspaceFileScan(checked).state, "clean");
    assert.ok(workspaceFileScan(checked).checkedAt);
    assert.equal((await privateFileJobReport(f.db)).jobs.length, 0);
  } finally { await f.db.close(); }
});

test("suspicious files quarantine; scanner outage quarantines and can recover on a later durable retry", async () => {
  const f = await fixture();
  try {
    await f.add();
    await createPrivateFileWorker(f.db, f.storage, async () => "suspicious").tick();
    let row = (await f.db.query(`SELECT * FROM storyhold.character_workspace_items`)).rows[0]!;
    assert.deepEqual(workspaceFileScan(row).reason, "suspicious");
    await f.db.exec(`DELETE FROM storyhold.character_workspace_items; DELETE FROM storyhold.private_file_jobs`);
    await f.add();
    await createPrivateFileWorker(f.db, f.storage, createPrivateFileScanner({})).tick();
    row = (await f.db.query(`SELECT * FROM storyhold.character_workspace_items`)).rows[0]!;
    assert.equal(workspaceFileScan(row).state, "quarantined");
    assert.equal(workspaceFileScan(row).reason, "scan_failed");
    assert.equal((await privateFileJobReport(f.db)).jobs.length, 1);
    await f.due();
    await createPrivateFileWorker(f.db, f.storage, async () => "clean").tick();
    assert.equal((await f.db.query(`SELECT file_scan_state FROM storyhold.character_workspace_items`)).rows[0]!.file_scan_state, "clean");
  } finally { await f.db.close(); }
});

test("deletion atomically queues cleanup, survives storage failure/restart, and never restores items", async () => {
  const f = await fixture();
  try {
    const item = await f.add();
    await f.db.query(`DELETE FROM storyhold.character_workspace_items WHERE id=$1`, [item.id]);
    const failing = { ...f.storage, async deleteSource() { throw new Error(`sensitive-filename ${item.key}`); } };
    await createPrivateFileWorker(f.db, failing).tick();
    const report = await privateFileJobReport(f.db);
    assert.equal(report.jobs.length, 1);
    assert.equal((report.jobs[0] as { attempts: number }).attempts, 1);
    assert.ok(!JSON.stringify(report).includes(item.key));
    assert.ok(!JSON.stringify(report).includes("sensitive-filename"));
    assert.equal((await f.db.query(`SELECT * FROM storyhold.character_workspace_items`)).rows.length, 0);
    await f.due();
    await createPrivateFileWorker(f.db, f.storage).tick();
    assert.deepEqual(f.deleted, [item.key]);
    assert.equal((await privateFileJobReport(f.db)).jobs.length, 0);
  } finally { await f.db.close(); }
});

test("cleanup failures have bounded retries and expired leases recover after process interruption", async () => {
  const f = await fixture();
  try {
    const item = await f.add();
    await f.db.query(`DELETE FROM storyhold.character_workspace_items WHERE id=$1`, [item.id]);
    const fail = createPrivateFileWorker(f.db, { ...f.storage, async deleteSource() { throw new Error("storage down"); } });
    for (let n = 0; n < 6; n++) { await f.due(); await fail.tick(); }
    assert.equal((await privateFileJobReport(f.db)).jobs[0]!.status, "failed");
    assert.equal((await privateFileJobReport(f.db)).jobs[0]!.attempts, 6);
    await f.due(); await fail.tick();
    assert.equal((await privateFileJobReport(f.db)).jobs[0]!.attempts, 6);
    assert.ok(privateFileRetrySeconds(999) <= 3600);
    await f.db.exec(`UPDATE storyhold.private_file_jobs SET status='running',attempts=1,lease_until=now()-interval '1 second',lease_token=gen_random_uuid()`);
    await createPrivateFileWorker(f.db, f.storage).tick();
    assert.equal((await privateFileJobReport(f.db)).jobs.length, 0);
  } finally { await f.db.close(); }
});

test("upload orphan guard is durable before upload; committed uploads retain only their scan job", async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    await stagePrivateFileUpload(f.db, "orphan", id);
    await createPrivateFileWorker(f.db, f.storage).tick();
    assert.equal(f.deleted.length, 0);
    await f.due();
    await createPrivateFileWorker(f.db, f.storage).tick();
    assert.deepEqual(f.deleted, ["orphan"]);
    await assert.rejects(f.db.transaction((tx) => commitPrivateFileUpload(tx, "orphan")), /upload expired/);
    await stagePrivateFileUpload(f.db, "saved", id);
    await f.db.transaction(async (tx) => {
      await commitPrivateFileUpload(tx, "saved");
      await tx.query(`INSERT INTO storyhold.character_workspace_items(id,kind,file_object_key,file_size) VALUES ($1,'file','saved',9)`, [id]);
    });
    assert.equal((await privateFileJobReport(f.db)).jobs.length, 1);
    assert.equal((await privateFileJobReport(f.db)).jobs[0]!.operation, "scan");
  } finally { await f.db.close(); }
});

test("scan completion cannot resurrect a deleted file or acknowledge another worker lease", async () => {
  const f = await fixture();
  try {
    const item = await f.add();
    await createPrivateFileWorker(f.db, f.storage, async () => {
      await f.db.query(`DELETE FROM storyhold.character_workspace_items WHERE id=$1`, [item.id]);
      return "clean";
    }).tick();
    assert.equal((await f.db.query(`SELECT * FROM storyhold.character_workspace_items`)).rows.length, 0);
    assert.equal((await privateFileJobReport(f.db)).jobs.length, 0);
    await f.add();
    await createPrivateFileWorker(f.db, f.storage, async () => {
      await f.db.exec(`UPDATE storyhold.private_file_jobs SET lease_token=gen_random_uuid()`);
      return "clean";
    }).tick();
    assert.equal((await f.db.query(`SELECT file_scan_state FROM storyhold.character_workspace_items`)).rows[0]!.file_scan_state, "pending");
  } finally { await f.db.close(); }
});

test("ClamAV streaming framing accepts exact clean reply, detects threats and rejects malformed replies", async () => {
  for (const reply of ["stream: OK\0", "stream: test-signature FOUND\0", "stream: ERROR\0", "stream: OK\0extra\0"]) {
    let received = Buffer.alloc(0);
    const server = createServer((socket) => {
      socket.on("data", (bytes) => {
        received = Buffer.concat([received, bytes]);
        if (received.length >= 27) socket.end(reply);
      });
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const address = server.address() as { port: number };
      const result = scanWithClamd(Buffer.from("reference"), { host: "127.0.0.1", port: address.port }, 1000);
      if (reply === "stream: OK\0") assert.equal(await result, "clean");
      else if (reply.includes("FOUND")) assert.equal(await result, "suspicious");
      else await assert.rejects(result, /scanner_invalid_response/);
      assert.equal(received.subarray(0, 10).toString(), "zINSTREAM\0");
      assert.equal(received.readUInt32BE(10), 9);
      assert.equal(received.subarray(14, 23).toString(), "reference");
      assert.equal(received.readUInt32BE(23), 0);
    } finally { server.close(); await once(server, "close"); }
  }
});

test("an abandoned late upload fences the old cleanup completion and is cleaned again", async () => {
  const f = await fixture();
  try {
    const item = await f.add();
    await f.db.query(`DELETE FROM storyhold.character_workspace_items WHERE id=$1`, [item.id]);
    let deletions = 0;
    await createPrivateFileWorker(f.db, { ...f.storage, async deleteSource(key) {
      deletions++;
      if (deletions === 1) await abandonPrivateFileUpload(f.db, key);
    } }).tick();
    assert.equal(deletions, 2, "old completion must not clear a newly queued cleanup obligation");
    assert.equal((await privateFileJobReport(f.db)).jobs.length, 0);
    await stagePrivateFileUpload(f.db, "old-attempt", randomUUID());
    await f.db.exec(`UPDATE storyhold.private_file_jobs SET attempts=1`);
    await assert.rejects(f.db.transaction((tx) => commitPrivateFileUpload(tx, "old-attempt")), /upload expired/);
  } finally { await f.db.close(); }
});

test("an exhausted expired scan cannot publish a late clean verdict", async () => {
  const f = await fixture();
  try {
    await f.add();
    await createPrivateFileWorker(f.db, f.storage, async () => {
      await f.db.exec(`UPDATE storyhold.private_file_jobs SET attempts=6,lease_until=now()-interval '1 second'`);
      await createPrivateFileWorker(f.db, f.storage).tick();
      return "clean";
    }).tick();
    const row = (await f.db.query(`SELECT * FROM storyhold.character_workspace_items`)).rows[0]!;
    assert.equal(workspaceFileScan(row).state, "quarantined");
    assert.equal(workspaceFileScan(row).retryPending, false);
    const report = await privateFileJobReport(f.db);
    assert.equal(report.jobs[0]!.status, "failed");
  } finally { await f.db.close(); }
});

test("workspace deletion and its cleanup outbox roll back together", async () => {
  const f = await fixture();
  try {
    const item = await f.add();
    await assert.rejects(f.db.transaction(async (tx) => {
      await tx.query(`DELETE FROM storyhold.character_workspace_items WHERE id=$1`, [item.id]);
      throw new Error("transaction aborted");
    }), /transaction aborted/);
    assert.equal((await f.db.query(`SELECT * FROM storyhold.character_workspace_items`)).rows.length, 1);
    assert.equal((await privateFileJobReport(f.db)).jobs.length, 1);
    assert.equal((await privateFileJobReport(f.db)).jobs[0]!.operation, "scan");
  } finally { await f.db.close(); }
});

test("scanner rejects remote insecure configuration, missing service and stalled scans", async () => {
  await assert.rejects(createPrivateFileScanner({ STORYHOLD_CLAMD_HOST: "example.com", STORYHOLD_CLAMD_PORT: "3310" })(Buffer.from("x")), /scanner_unavailable/);
  const server = createServer((socket) => { socket.resume(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    await assert.rejects(scanWithClamd(Buffer.from("x"), { host: "127.0.0.1", port: (server.address() as { port: number }).port }, 30), /scanner_timeout/);
  } finally { server.close(); await once(server, "close"); }
});

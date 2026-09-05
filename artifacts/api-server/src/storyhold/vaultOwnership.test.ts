import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireStoryholdVaultOwnership, VaultOwnershipError } from "./vaultOwnership";

async function temporaryVault(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "storyhold-ownership-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return path.join(root, "postgres");
}

async function childOwner(t: TestContext, dataDir: string, crash: boolean) {
  const moduleUrl = new URL("./vaultOwnership.ts", import.meta.url).href;
  const source = `
    const { acquireStoryholdVaultOwnership } = await import(${JSON.stringify(moduleUrl)});
    const owner = await acquireStoryholdVaultOwnership(${JSON.stringify(dataDir)}, { purpose: 'test process without an HTTP listener' });
    console.log('READY');
    ${crash ? "process.exit(0);" : "process.stdin.resume(); process.stdin.once('data', async () => { await owner.release(); process.exit(0); });"}
  `;
  const child = spawn(process.execPath, [...process.execArgv, "--input-type=module", "-e", source], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const exit = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  t.after(async () => {
    if (child.exitCode === null) { child.stdin.end("release"); await exit; }
  });
  const ready = await Promise.race([
    once(child.stdout, "data").then(([chunk]) => String(chunk).includes("READY")),
    exit.then(() => false),
  ]);
  assert.equal(ready, true, `Child could not acquire test lease: ${stderr}`);
  return { child, exit };
}

test("same canonical vault refuses a second owner until the first releases", async (t) => {
  const dataDir = await temporaryVault(t);
  const lease = await acquireStoryholdVaultOwnership(dataDir, { purpose: "server starting up" });
  await assert.rejects(
    acquireStoryholdVaultOwnership(path.join(dataDir, "..", "postgres"), { purpose: "offline repair" }),
    (error: unknown) => error instanceof VaultOwnershipError && error.owner?.pid === process.pid,
  );
  await lease.release();
  await lease.release();
  const second = await acquireStoryholdVaultOwnership(dataDir, { purpose: "offline repair" });
  assert.notEqual(second.owner.token, lease.owner.token);
  await second.release();
});

test("racing acquisitions produce only one owner", async (t) => {
  const dataDir = await temporaryVault(t);
  const results = await Promise.allSettled([
    acquireStoryholdVaultOwnership(dataDir, { purpose: "first" }),
    acquireStoryholdVaultOwnership(dataDir, { purpose: "second" }),
  ]);
  const owners = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  assert.equal(owners.length, 1);
  await owners[0]!.release();
});

test("a separate live owner blocks maintenance even with no HTTP listener", async (t) => {
  const dataDir = await temporaryVault(t);
  const running = await childOwner(t, dataDir, false);
  await assert.rejects(acquireStoryholdVaultOwnership(dataDir, { purpose: "maintenance" }),
    (error: unknown) => error instanceof VaultOwnershipError && error.owner?.pid === running.child.pid);
  running.child.stdin.end("release");
  assert.equal((await running.exit)[0], 0);
  const lease = await acquireStoryholdVaultOwnership(dataDir, { purpose: "maintenance" });
  await lease.release();
});

test("an exited process's lease is reclaimed without touching vault contents", async (t) => {
  const dataDir = await temporaryVault(t);
  const crashed = await childOwner(t, dataDir, true);
  await crashed.exit;
  await writeFile(path.join(dataDir, "preserve.txt"), "vault bytes");
  const lease = await acquireStoryholdVaultOwnership(dataDir, { purpose: "restart" });
  assert.equal(lease.owner.pid, process.pid);
  assert.equal(await readFile(path.join(dataDir, "preserve.txt"), "utf8"), "vault bytes");
  await lease.release();
});

test("unreadable ownership metadata and interrupted acquisition gates fail closed", async (t) => {
  const dataDir = await temporaryVault(t);
  await mkdir(dataDir);
  const lockDirectory = path.join(path.dirname(dataDir), ".postgres.storyhold-owner");
  await mkdir(lockDirectory);
  await writeFile(path.join(lockDirectory, "owner.json"), "truncated");
  await assert.rejects(acquireStoryholdVaultOwnership(dataDir, { purpose: "inspection" }), /missing or unreadable/);
  assert.equal(await readFile(path.join(lockDirectory, "owner.json"), "utf8"), "truncated");
  await mkdir(`${lockDirectory}.acquiring`);
  await assert.rejects(acquireStoryholdVaultOwnership(dataDir, { purpose: "inspection" }), /acquisition was interrupted/);
});

test("releasing a lease cannot remove an altered ownership record", async (t) => {
  const dataDir = await temporaryVault(t);
  const lease = await acquireStoryholdVaultOwnership(dataDir, { purpose: "original owner" });
  const replacement = { ...lease.owner, token: "another-owner-token" };
  await writeFile(path.join(lease.lockDirectory, "owner.json"), JSON.stringify(replacement));
  await assert.rejects(lease.release(), /refusing to remove/);
  assert.equal(JSON.parse(await readFile(path.join(lease.lockDirectory, "owner.json"), "utf8")).token, replacement.token);
});

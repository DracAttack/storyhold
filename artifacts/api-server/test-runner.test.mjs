import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const localRequire = createRequire(import.meta.url);
const requiredAssets = ["pglite.data", "pglite.wasm", "initdb.wasm", "vector.tar.gz"];

function checkRuntime(extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["test.mjs", "--pglite-runtime-check", ...extraArgs], {
      cwd: artifactDir,
      env: { ...process.env, NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, output }));
  });
}

test("bundled PGlite executes vector queries from separate nested output directories", async () => {
  const result = await checkRuntime();
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /PGlite and vector queries passed from 2 emitted test directories/);
});

for (const [asset, packageName] of [
  ["pglite.wasm", "@electric-sql/pglite"],
  ["vector.tar.gz", "@electric-sql/pglite-pgvector"],
]) {
  test(`missing ${asset} produces the actionable runtime diagnostic without altering dependencies`, async () => {
    const installedAsset = path.join(path.dirname(localRequire.resolve(packageName)), asset);
    const digest = async () => createHash("sha256").update(await readFile(installedAsset)).digest("hex");
    const before = await digest();
    const result = await checkRuntime([`--simulate-missing-pglite-asset=${asset}`]);
    assert.equal(result.code, 1, result.output);
    assert.equal(result.signal, null, "the runner must report failure, not be killed by the timeout");
    assert.match(result.output, /PGlite runtime check failed/);
    assert.match(result.output, /beside every emitted test bundle/);
    for (const name of requiredAssets) assert.ok(result.output.includes(name), `diagnostic must name ${name}`);
    assert.ok(result.output.includes(`${asset} (${packageName})`), "diagnostic identifies the missing asset's package");
    assert.equal(await digest(), before, "installed runtime assets must remain unchanged");
  });
}

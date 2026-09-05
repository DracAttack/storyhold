import path from "node:path";
import { once } from "node:events";
import { createRequire } from "node:module";
import { run as runNodeTests } from "node:test";
import { spec } from "node:test/reporters";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";
import { rm, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";

// Use Node's built-in test runner. The normal path bundles TypeScript and path
// aliases with esbuild; Windows uses tsx's per-module transform hook to avoid
// esbuild's native resolver traversing unreadable ancestor directories.

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const localRequire = createRequire(import.meta.url);

async function findFilesBySuffix(dir, suffix) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await findFilesBySuffix(full, suffix)));
    else if (entry.name.endsWith(suffix)) out.push(full);
  }
  return out;
}

async function runWindowsTestsWithoutBundling(entryPoints) {
  // `files` accepts exact Windows paths rather than CLI glob patterns. A file
  // URL is also required for the tsx import hook on Windows (not a C:\\ path).
  // Pin the site's aliases even when invoked from the repository root; older
  // Node versions do not apply the test API's `cwd` option to child processes.
  process.env.TSX_TSCONFIG_PATH = path.join(artifactDir, "tsconfig.json");
  const testStream = runNodeTests({
    cwd: artifactDir,
    files: entryPoints,
    isolation: "process",
    concurrency: false,
    execArgv: ["--import", pathToFileURL(localRequire.resolve("tsx")).href],
  });
  let failed = false;
  testStream.on("test:fail", () => {
    failed = true;
  });
  const reportStream = testStream.compose(spec());
  reportStream.pipe(process.stdout);
  await once(reportStream, "end");
  if (failed) process.exitCode = 1;
}

async function run() {
  const srcDir = path.resolve(artifactDir, "src");
  const outDir = path.resolve(artifactDir, "dist-test");

  const entryPoints = await findFilesBySuffix(srcDir, ".test.ts");
  entryPoints.sort((left, right) => left.localeCompare(right));
  if (entryPoints.length === 0) {
    console.log("No test files found.");
    return;
  }

  process.env.NODE_ENV = "test";
  if (process.platform === "win32") {
    await runWindowsTestsWithoutBundling(entryPoints);
    return;
  }

  await rm(outDir, { recursive: true, force: true });

  await esbuild({
    entryPoints,
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: outDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "warning",
  });

  const bundled = await findFilesBySuffix(outDir, ".test.mjs");
  const child = spawn(process.execPath, ["--test", ...bundled], {
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "test" },
  });
  const [code] = await once(child, "exit");
  process.exitCode = code ?? 1;
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

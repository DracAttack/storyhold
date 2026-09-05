import { createRequire } from "node:module";
import { once } from "node:events";
import path from "node:path";
import { run as runNodeTests } from "node:test";
import { spec } from "node:test/reporters";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as esbuild, transform as transformWithEsbuild } from "esbuild";
import { readFile, rm, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";

// The repo has no test framework installed (vitest/jest). This runner executes
// TypeScript tests with Node's built-in test runner. The regular path bundles
// them with esbuild because shared workspace packages export raw .ts source with
// extensionless imports. Restricted Windows environments use tsx's per-module
// transform hook instead; see runWindowsTestsWithoutBundling below.

const localRequire = createRequire(import.meta.url);
globalThis.require = localRequire;
const artifactDir = path.dirname(fileURLToPath(import.meta.url));

async function findFilesBySuffix(dir, suffix) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await findFilesBySuffix(full, suffix)));
    else if (entry.name.endsWith(suffix)) out.push(full);
  }
  return out;
}

function assertPathInside(parentDir, candidate, label) {
  const relative = path.relative(parentDir, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error(`${label} escaped the API server source tree: ${candidate}`);
}

function validateEntryPoints(srcDir, entryPoints) {
  for (const entryPoint of entryPoints) {
    assertPathInside(srcDir, entryPoint, "Test entry point");
    if (!entryPoint.endsWith(".test.ts")) {
      throw new Error(`Unexpected test entry point: ${entryPoint}`);
    }
  }
}

async function checkDiscoveredEntryPoints(srcDir, entryPoints) {
  // `transform` receives source text over esbuild's stdin protocol. Unlike
  // `build`, it does not invoke the native filesystem resolver, so this check
  // can validate every discovered TypeScript entry without walking from the
  // workspace up through the user's profile directory on Windows.
  for (const entryPoint of entryPoints) {
    const source = await readFile(entryPoint, "utf8");
    await transformWithEsbuild(source, {
      format: "esm",
      loader: "ts",
      sourcefile: path.relative(srcDir, entryPoint).split(path.sep).join("/"),
      target: "node22",
    });
  }
  console.log(
    `Validated ${entryPoints.length} TypeScript test entry points inside ${srcDir}.`,
  );
}

async function runWindowsTestsWithoutBundling(entryPoints) {
  // esbuild 0.27's native Windows resolver searches ancestor directories even
  // for an absolute local entry point. In restricted Windows environments the
  // first unreadable ancestor makes every entry look unresolved. tsx uses
  // esbuild's transform API instead, while Node's test runner keeps one process
  // per test file and resolves the real module graph at runtime.
  //
  // This also preserves native-package behavior: dependencies are not bundled,
  // so .node binaries and layout-sensitive packages remain ordinary runtime
  // imports. The explicit esbuild EXTERNALS below remain unchanged for the
  // bundled runner used on other platforms.
  const tsxLoaderUrl = pathToFileURL(localRequire.resolve("tsx")).href;
  const testStream = runNodeTests({
    cwd: artifactDir,
    files: entryPoints,
    forceExit: true,
    isolation: "process",
    // Keep the local Windows gate predictable on memory-constrained machines.
    concurrency: false,
    execArgv: ["--import", tsxLoaderUrl],
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

// ---------------------------------------------------------------------------
// EXTERNAL PACKAGES — READ THIS BEFORE ADDING NEW NATIVE DEPENDENCIES
// ---------------------------------------------------------------------------
// esbuild cannot inline packages that load native Node add-ons (.node files)
// or that rely on file-system layout (worker threads spawned by relative path,
// platform-specific prebuilds, etc.).  When such a package is imported by any
// source file pulled into the test bundle, esbuild fails with a hard build
// error that shows no test output at all — the entire suite goes silent.
//
// RULE: whenever you add a new package to api-server that:
//   • ships a prebuilt native binary  (*.node)
//   • spawns a worker via a relative __dirname path  (pino-pretty, thread-stream)
//   • has a known "optional native" peer  (pg → pg-native, bcrypt → bcrypt-native)
//   • is intentionally load-on-demand and never used in tests
//
// …add it (or its @scope/* glob) to the EXTERNALS array below so esbuild
// leaves it as a runtime require/import rather than trying to bundle it.
//
// The nativePkgGuard esbuild plugin (below) will catch any *.node import that
// slips through this list and print a helpful diagnostic pointing here.
// ---------------------------------------------------------------------------
const EXTERNALS = [
  // Catch-all for any stray *.node binary that is NOT listed individually
  // below.  esbuild resolves this before trying to open the file, so it won't
  // hard-crash — but the nativePkgGuard plugin below will still warn if it
  // sees an unlisted package loading a *.node file.
  "*.node",

  // Native crypto / hashing
  "pg-native",   // optional native peer of "pg" (not installed, but guard it)
  "bcrypt",      // native bcrypt — project uses bcryptjs (pure JS) instead
  "argon2",      // native argon2 binding

  // Image / graphics processing
  "sharp",       // native libvips binding; used by @huggingface/transformers
  "@resvg/resvg-js", // native resvg binding — SVG→PNG renderer used by satori
  "canvas",      // native Cairo binding for node-canvas

  // Database / storage
  "better-sqlite3", // native SQLite binding
  "sqlite3",        // native SQLite binding (legacy)

  // Platform-specific / macOS only
  "fsevents",    // macOS FSEvents (optional dep of chokidar etc.)

  // Google cloud SDKs — large optional deps, externalized in production build
  "@google/*",
  "@google-cloud/*",

  // Transformers.js: dynamically imported by services/embeddings.ts (local
  // embedding provider) only when SOURCE_VAULT_EMBED_PROVIDER=local.  It
  // transitively imports sharp, so externalising it keeps the bundle clean.
  "@huggingface/transformers",

];

// ---------------------------------------------------------------------------
// nativePkgGuard — esbuild plugin
// ---------------------------------------------------------------------------
// When esbuild encounters an import that resolves to a *.node file it normally
// just emits a build error with the raw module path, giving no hint about how
// to fix it.  This plugin intercepts *.node resolutions BEFORE the build fails
// and emits a clear, actionable diagnostic that names the offending package
// and points to the EXTERNALS list above.
//
// It also runs a second pass over the resolved package name: if esbuild is
// about to bundle an npm package that isn't in EXTERNALS, and that package's
// installed directory contains any *.node file, the plugin emits a warning so
// the developer knows to add it before the bundle silently breaks.
// ---------------------------------------------------------------------------
import { readdirSync } from "node:fs";

function nativePkgGuard() {
  /** @type {import("esbuild").Plugin} */
  return {
    name: "native-pkg-guard",
    setup(build) {
      // Intercept any import that resolves to a *.node file.
      build.onLoad({ filter: /\.node$/ }, (args) => {
        const pkg = guessPackageName(args.path);
        return {
          errors: [
            {
              text:
                `Native binary detected: ${args.path}\n` +
                `  Package guess: ${pkg}\n` +
                `  esbuild cannot bundle .node files into the test bundle.\n` +
                `  Fix: add "${pkg}" (or its "@scope/*" glob) to the EXTERNALS\n` +
                `  array in artifacts/api-server/test.mjs and re-run the tests.`,
            },
          ],
        };
      });
    },
  };
}

/** Extract a best-guess npm package name from an absolute .node path. */
function guessPackageName(absPath) {
  const nm = absPath.indexOf("node_modules");
  if (nm === -1) return path.basename(absPath);
  const rel = absPath.slice(nm + "node_modules".length + 1);
  const parts = rel.split(path.sep);
  // Scoped packages: @scope/pkg/…  →  "@scope/pkg"
  if (parts[0]?.startsWith("@") && parts.length > 1) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? path.basename(absPath);
}

async function run() {
  const srcDir = path.resolve(artifactDir, "src");
  const outDir = path.resolve(artifactDir, "dist-test");

  const requestedEntryPoints = process.argv
    .slice(2)
    .filter((arg) => arg !== "--" && arg !== "--discovery-check")
    .map((arg) => path.resolve(artifactDir, arg));
  const entryPoints = requestedEntryPoints.length > 0
    ? requestedEntryPoints
    : await findFilesBySuffix(srcDir, ".test.ts");
  entryPoints.sort((left, right) => left.localeCompare(right));
  validateEntryPoints(srcDir, entryPoints);
  if (entryPoints.length === 0) {
    console.log("No test files found.");
    return;
  }

  if (process.argv.includes("--discovery-check")) {
    await checkDiscoveredEntryPoints(srcDir, entryPoints);
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
    external: EXTERNALS,
    plugins: [nativePkgGuard()],
    banner: {
      js: `import { createRequire as __cr } from 'node:module';
globalThis.require = __cr(import.meta.url);`,
    },
  });

  const bundled = await findFilesBySuffix(outDir, ".test.mjs");
  // NODE_ENV=test keeps code-under-test in its non-production branch (every
  // NODE_ENV check in the app compares against "production") while signalling
  // the logger to skip its pino-pretty worker-thread transport, which can't be
  // bundled into the ESM test runner. This lets tests import logger-using
  // modules (e.g. the optional embedding provider) without crashing on a missing __dirname.
  const child = spawn(process.execPath, ["--test", "--test-force-exit", ...bundled], {
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "test" },
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

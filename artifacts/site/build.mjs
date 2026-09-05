import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

// Plugins or bundled CJS deps may use `require` to resolve dependencies.
globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

async function buildAll() {
  // Bundle the production server into dist/index.mjs. Do NOT clear dist — the
  // Vite client build already wrote dist/public and we must preserve it.
  await esbuild({
    entryPoints: [path.resolve(artifactDir, "server/index.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: path.resolve(artifactDir, "dist"),
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    external: ["*.node", "fsevents", "lightningcss"],
    sourcemap: "linked",
    // Make sure CJS-only deps (e.g. express) keep working in the ESM output.
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
    },
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});

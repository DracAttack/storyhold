# BrainHook Dependency Cleanup

## Scope and Recovery

This cleanup applies to `DracAttack/storyhold`, based on Git revision
`fcb13fb26df6098bb1935891cb14702a7fae0975`. Work was performed in the separate
`C:\Users\animu\Documents\Codex\storyhold-remote-audit` checkout.

Before committing, upstream revision `9ed101ef83fb009d8163f7777e20611ccc3c94a5`
(Replit's premium campaign setup fix) was fast-forwarded into this checkout.
Its six updated files were preserved and the affected paths were rechecked.

The existing Windows application installation at
`C:\Users\animu\Documents\Codex\2026-07-31\github-plugin-github-openai-curated-remote\work\storyhold\storyhold-main`
was not edited, replaced, updated, or deleted. No database migration, table
deletion, world intake, model training, or paid provider call was performed.

The cleanup removes 525 tracked files (26,773,156 bytes before Git compression),
reduces resolved dependency entries from 733 to 561, and reduces workspace
projects from 12 to 7. These are checkout/dependency reductions, not a claim
that historical Git objects have been purged or a measurement of Replit charges.

`brainhook-dependency-cleanup.json` records every removed tracked file, its Git
blob identifier and byte size, the reason, and package dependency changes. The
originals remain in Git history; for example:

```sh
git show fcb13fb:artifacts/api-server/src/services/storyClusters.ts
```

Restore an individual file into a separate historical checkout when reviewing
old implementations; restoring dormant modules into the active app also requires
their historical dependencies. This commit does not rewrite earlier Git history.

## Removed Application

- The dormant BrainHook magazine server entry, routes, editorial pipeline,
  newsletter/email delivery, social publishing, feeds, article analytics,
  magazine concepts, memes, screenshots, and their tests/assets.
- Magazine frontend routes, article/glossary layouts, editorial controls,
  advertisement components, unused SSR server, old author/category images,
  BrainHook graphics, and magazine-only frontend dependencies.
- The magazine OpenAPI specification, generated React API endpoints and Zod
  contracts, and unused Anthropic/Gemini workspace wrappers.
- Unused magazine Drizzle schema modules and magazine schema-push commands.
  Removing schema source files does not remove any existing database tables.
- The separate BrainHook mockup application, old magazine design screenshot,
  and BrainHook SEO strategy document.
- Chromium and ImageMagick Nix requirements, whose consumers were the removed
  magazine capture and image-generation services.

The generic root build now validates and builds Storyhold. API start/build
commands refer to Storyhold's existing source entry rather than the removed
magazine bundle. Site build produces Vite assets, and site start delegates to the
existing Storyhold server. Replit's production build/start commands are preserved.

## Shared Functionality Retained

The removal decision was based on actual imports and entry points, including
dynamic imports, workers, tests, and local tooling, rather than the word
"BrainHook" in a filename or comment.

- All `src/storyhold` modules: canonical IDs, evidence, intake, synthesis,
  dossiers, world clock, source storage, RPG play, author play, credits,
  recovery, manual storyteller testing, and provider routing.
- Document extraction and fixtures for PDF, DOCX, text, presentations,
  spreadsheets, EPUB, and OpenDocument formats.
- Source chunking, MiniLM/offline embedding behavior, optional Perplexity
  embeddings, and browser/local model support.
- Source web fetching, robots.txt rules, private-address/SSRF checks, and their
  regression tests. The address check moved from the retired citation service
  into a standalone `networkSafety.ts` helper without changing its behavior.
- The original Perplexity embedding request, errors, cost calculation, and
  usage-recording destination. Only unused Perplexity search/chat functions were
  removed from the inherited service; Storyhold's own research/provider gateway
  remains intact.
- `lib/db` retains its PostgreSQL/Drizzle client and `aiUsageEventsTable` because
  that optional embedding path still uses them. The table definition is retained
  unchanged, including historical columns. Storyhold's main SQL schema remains
  under its own runtime and PostgreSQL adapter.
- `lib/content-utils` retains shared title capitalization. `lib/api-client-react`
  retains the generic fetch/error helper used by Storyhold's query client.
- All Storyhold Windows launch/install/GPU scripts, local PGlite support,
  training code/data, scenario catalog, Replit storage and auth integration,
  reusable UI controls, and Storyhold art.

## Current Dependency Requirements

The adjacent JSON inventory contains every retained direct package with its
declared version and workspace. `pnpm-lock.yaml` records exact resolved versions.

| Area | Required Components |
| --- | --- |
| Replit runtime | Node 20, Python 3.12, web, PostgreSQL 16 modules from `.replit`; pnpm |
| Server | Express, cookie-parser, bcryptjs, pg, PGlite and pgvector, Google Cloud Storage SDK |
| Intake/retrieval | Hugging Face Transformers, Readability, jsdom, fflate, mammoth, unpdf |
| Provider/usage support | Anthropic SDK; direct HTTP gateway providers; Pino and retained Drizzle ledger adapter |
| Browser | React, Vite, Tailwind, React Query, Wouter, Radix/reusable UI dependencies, WebLLM |
| Validation/build | TypeScript, tsx, esbuild, Prettier, Replit Vite plugins and appropriate type packages |
| Optional Windows model tools | Existing Python/model installers and llama.cpp/GPU configuration under `scripts/`; model downloads are not part of pnpm installation |

Published Storyhold requires a provisioned PostgreSQL database with the Storyhold
schema, private App Storage (`PRIVATE_OBJECT_DIR`), and a sufficiently long
session/causal secret. Provider credentials enable the selected AI services; they
are not needed for compilation or mocked tests. This cleanup does not provision
Replit infrastructure or claim the deployment database problem is resolved.

## Existing Followups Outside This Cleanup

- Replit's Run workflow still calls the Windows-only `storyhold:local` launcher.
  Add a hosted-development launcher separately; production publish already uses
  distinct build/start commands. Windows scripts were intentionally preserved.
- The root file `ziJOMV2V` is an unreferenced Git LFS pointer to a 169,134,985-byte
  object. Its content was not identifiable from this checkout, so it was retained
  rather than classified as unused BrainHook material without evidence.
- The optional inherited Perplexity embedding ledger should eventually be
  reviewed alongside Storyhold's current accounting. Its behavior was preserved
  here, including the existing best-effort handling of ledger write failures.
- Existing dependency deprecation notices and Vite source-map/large-chunk warnings
  are recorded as followups; this cleanup does not change model capability or
  upgrade unrelated packages to suppress warnings.

## Validation

- Workspace typechecking, the production build, and the 126-opening scenario
  catalog pass. These checks were repeated after incorporating Replit's update.
- All 140 frontend tests pass. Four initial failures came from three unchanged
  stale fixtures; their context/expectations were aligned with existing behavior.
- All 49 retained document, embedding, chunking, robots, and URL-policy tests pass.
- The full 119-file Storyhold backend run exercised 1,428 tests: 1,425 passed and
  three failed on stale assertions in two unchanged test files. Those fixtures
  were corrected and all 24 tests in the affected suites then passed. They were
  checked again with the upstream setup/gateway/accounting changes.
- AST import checks found no missing imports across 232 retained backend and
  152 retained frontend TypeScript files. Shared Perplexity embedding/usage
  definitions match the originals; live Storyhold production modules are unchanged
  by the cleanup.
- Existing Vite source-map and large-chunk warnings remain non-fatal.

The adjacent JSON inventory records the final focused rerun totals. No live
provider testing was performed by this removal.

# Website Maintenance — September 9, 2026

Base: `DracAttack/storyhold`, `main`, `451204f`.
Work stayed in the existing `storyhold-remote-audit` checkout. The separate
laptop-running installation, its database, manuscripts, credentials and model
files were not modified. No new checkout or model/dependency download was made.

## Implemented

1. Bundled PGlite runner resolves core runtime assets and pgvector's
   `vector.tar.gz` from their owning installed packages. Two nested emitted
   smoke bundles create/query real vectors. Missing-WASM and missing-vector
   regressions exercise temporary copies and verify installed assets unchanged.
2. Private workspace files start pending; real ClamAV verdicts control access.
   Suspicious and failed scans quarantine. Failed scans retry with bounded
   backoff, without AI, credits or public storage URLs.
3. Transactional cleanup outbox covers workspace deletion/cascades and
   interrupted uploads. Expiring leases, fencing and retry limits protect
   against stale workers, late uploads and repeated storage failure.
4. Clean raster-image attachments have authenticated thumbnails and an expanded
   preview. Documents retain downloads. Status polling preserves current edits
   and continues while a quarantined scan is scheduled to retry.
5. Runner diagnostics name all required runtime assets and the offending package.
6. Owner/admin CSV export shares the existing report's applied date/operation
   filters and account scope, preserves microdollar precision, splits successful
   and failed billable requests, and guards spreadsheet formula injection.

## Regressions Found During Verification

- A pre-existing import cycle prevented unbundled manual-storyteller/accounting
  tests from starting. Shared journal SQL moved unchanged to a dependency-free
  module, retaining its previous export.
- Legacy manual narration replays were incorrectly gaining a newer viewpoint
  directive. The legacy policy now preserves its exact frozen request; current
  narration remains unchanged.
- A pre-existing token-array inference error surfaced in full API typecheck.
  An explicit string-array annotation preserves the filtering behavior.

## Verification

- Full frontend suite: **159 passed** (includes workspace and export UI/API tests).
- File safety, authenticated file routes, storage, CSV formatter: **18 passed**.
- Manual storyteller, campaign launch scope, Story Studio: **41 passed**.
- Filtered provider CSV/database aggregation and authorization: **2 passed**.
- Missing-runtime-asset fault injection: **2 passed**.
- API and frontend typechecks: passed.
- Production frontend build: passed using the repository's configured
  `vite build --config vite.config.ts --configLoader runner` command.
- Existing sourcemap/large-chunk build warnings remain; no suppression added.
- No paid provider calls, live database migrations, real uploads or customer
  credit operations were used for verification.

## Remaining Before Deployment

Antivirus follow-up: added a Linux-only configuration generator and explicit
`storyhold:antivirus:check` command using the production streaming adapter with
in-memory harmless text/EICAR probes. Replit hookup, supervision, schema ordering,
signature updates and failed-scan recovery are documented in the safety guide.
Nothing auto-installs or starts, and `.replit` remains unchanged. The protocol
fixture now waits for all 27 bytes rather than responding at byte 24.

Follow-up verification: **5** configuration-helper tests and **21** private-file
scanner/safety/route/storage tests passed, with no skipped tests. API typecheck
passed again; the new check/CLI/tests also passed a separate strict TypeScript
check. Pure configuration rendering and Windows no-install guards were tested
here. The helper test's Linux filesystem branch (creation, rerun, permissions,
symlinks), actual Linux daemon setup and real signature detection still belong
to Replit's deployment verification, not this Windows test result.

- Configure and smoke-test the actual antivirus daemon. The implementation was
  tested with an isolated ClamAV protocol fixture, not a production antivirus
  instance. See [private file safety](private-workspace-file-safety.md).
- Apply the new development schema through the existing guarded workflow and
  include it when publishing. Existing unscanned workspace files become pending.
- Run `node --test test-runner.test.mjs` from `artifacts/api-server` on Replit/Linux
  or an unrestricted user terminal. The real emitted-bundle smoke test remains
  blocked here by native esbuild's attempt to inspect an inaccessible Windows
  ancestor directory. It is not skipped or reported as passed.
- Review, commit and push the source changes. This session's source-edit grant
  does not remove the protected Git metadata restriction.
- On Autoscale, cleanup resumes when an instance starts; guaranteed work while
  scaled to zero requires deployment scheduling, not an in-process timer.

The changes do not install ClamAV, create external hosting, or alter permanent
Windows/Codex permission policy.

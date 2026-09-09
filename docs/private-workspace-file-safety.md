# Private Workspace Files: Safety and Cleanup

## Deployment Requirements

Configure a real ClamAV daemon before offering file attachments. This change
does **not** install or start antivirus software, download its signature database,
send manuscripts to an external scanning provider, or invoke Storyhold AI.

- Unix socket: `STORYHOLD_CLAMD_SOCKET=/run/clamav/clamd.ctl`
- Or local TCP: `STORYHOLD_CLAMD_PORT=3310`, optionally
  `STORYHOLD_CLAMD_HOST=127.0.0.1` (only loopback IPs accepted).
- Keep signatures updated with `freshclam` and monitor daemon health.
- Set `StreamMaxLength` and `MaxFileSize` to at least 25 MiB. Configure bounded
  archive expansion and enable `AlertExceedsMax`, `AlertEncryptedArchive` and
  `AlertEncryptedDoc` so uninspectable content cannot silently pass as clean.
- Do not expose clamd's unauthenticated TCP listener to the public Internet.

Protocol reference: [ClamAV INSTREAM](https://docs.clamav.net/manual/Usage/ClamdProtocol.html).
Configuration guidance: [ClamAV scanning](https://docs.clamav.net/manual/Usage/Scanning.html).

## Replit Handoff: Connect the Prepared Scanner

These are **deployment instructions**, not instructions to change the owner's
Windows installation. The website checkout includes the adapter, queue, scan
gate, configuration generator and diagnostic command. It does not change
`.replit`, install system packages, create a paid service, or start processes
automatically. Replit should wire the following into its actual Linux runtime.

1. Supply a supported ClamAV package containing `clamd`, `freshclam` and
   `clamconf`, plus CA certificates. With Nix, add `pkgs.clamav` and
   `pkgs.cacert` to the deployment's dependency configuration. Confirm they
   exist in the **published runtime**, not only the development shell. No new
   JavaScript dependency or AI provider is needed.
2. Select a short, dedicated directory owned by the non-root account that runs
   both Storyhold and ClamAV. Keep it outside public assets and Git (for example
   the project's ignored `.cache/storyhold-antivirus`). This holds scanner
   signatures and private scan scratch space, **not durable customer uploads**.
3. Run the preparation command with its absolute Linux path. It writes
   `clamd.conf`, `freshclam.conf` and `storyhold-antivirus.env`; it never installs
   or launches anything. Existing differing files are not overwritten. Private
   directories require mode `0700`, configs `0600`. Paths with spaces are
   deliberately rejected to avoid ambiguous daemon configuration.

```sh
pnpm storyhold:antivirus:prepare /absolute/project/.cache/storyhold-antivirus
```

4. Set `STORYHOLD_CLAMD_SOCKET` in the API environment to the generated socket
   path. The generated environment file is a convenience, not auto-loaded.
   Run an initial signature update using `freshclam --config-file=<absolute
   state directory>/freshclam.conf`. Do not keep retrying CDN/rate-limit
   failures in a tight loop. Validate the generated files using
   `clamconf --config-dir=<absolute state directory>` with the installed version.
5. Supervise **two foreground processes** alongside the API:
   `clamd --config-file=<absolute state directory>/clamd.conf` and
   `freshclam --daemon --config-file=<absolute state directory>/freshclam.conf`.
   Replit supplies process supervision, shutdown and restart policy. Both
   configs keep the process in the foreground; no `nohup`, runaway background
   shell jobs or Windows launcher edits are required. Run one updater per
   signature directory; do not concurrently share it between replicas.
6. Wait for ClamAV to load its signatures, then run the check **in the API's
   runtime and with its environment**, before starting its upload worker:

```sh
pnpm storyhold:antivirus:check
```

The check uses the exact production streaming adapter. It must accept harmless
text **and** detect the standard harmless EICAR pattern. The client assembles it
in memory and creates no test file, private object, database row, AI request or
credit charge. ClamAV may use its private temporary scan directory for the stream.
Exit `0` means both probes passed; exit `1` means do not release the
upload feature. It does not prove the complete upload/ownership/storage flow or
future signature freshness. See [ClamAV's official configuration guidance](https://docs.clamav.net/manual/Usage/Configuration.html).

7. Once the real check passes, apply `pnpm storyhold:schema:development` against
   the Replit-managed **development** database and include those changes in
   Publish. Never override its guard to run against production. Production
   checks for the private-file queue and scan columns before reporting healthy.
   Restart the API after configuring or changing the scanner connection: the
   worker captures the connection at startup.
8. Verify a real private clean image/document becomes available only after its
   scan, unauthorized users remain blocked, and a scanner outage keeps files
   unavailable. Do not push an antivirus test pattern through manuscript intake
   or any AI route. Re-run the diagnostic against each published revision.

### Capacity and Startup

ClamAV is CPU/RAM software, not another language model. Budget for the scanner,
API and signature-update peaks together; confirm capacity before enabling it.
ClamAV recommends multiple GiB for its signature database, so this is not a
promise of zero hosting cost. No hosting tier is selected here.
[ClamAV system requirements](https://docs.clamav.net/Introduction.html).

Generated settings limit simultaneous scans to two, uploaded streams to 25 MiB
and expanded content to 100 MiB. `MaxScanTime` is set to 20 seconds, but its
coverage depends on ClamAV's format support; it is not a universal execution
deadline. The adapter stops waiting after 30 seconds, independently of the
daemon. Limit/encryption alerts quarantine content, not
silently approve it. Sequential database reloads reduce reload memory peaks but
may temporarily delay scans. Freshclam still validates new signature databases;
budget for that memory rather than disabling the check.

Keep signatures updated. The seven-day age guard applies at daemon startup;
monitor updater failures and age while it stays running, too. Initial downloads
and loading can delay cold starts. Replit should arrange cached signatures and
startup readiness to suit its deployment limits; do not make the upload worker
burn through retries while the first database downloads. A remote ClamAV service
would need a separate authenticated, encrypted transport; never expose raw
clamd TCP publicly or remove the adapter's loopback restriction.

### Recovering After an Outage

Six failed attempts leave a scan job stopped, even after the scanner recovers.
Inspect opaque IDs via the existing admin job report. An authorized database
operator may requeue a reviewed **failed scan** job after the real smoke check
passes: in one transaction, match its item and object key, require the item's
reason to be `scan_failed` (not `suspicious`), set the job to `pending`, reset its
attempts to zero, clear the old lease/token/error, make it due now, and set the
item's retry-pending flag. The item must remain quarantined until a real clean
verdict. Do this only for selected failed IDs; do not reset all jobs, reset active
leases, restore deleted items, or mark files clean by hand. No customer bypass or
automatic unbounded retry is supplied.

## What Users See

Uploads are pending and private immediately. Only an exact successful scan
unlocks authenticated downloads and raster-image previews. Suspicious files
remain quarantined. Unavailable scanners, invalid replies, oversized data,
incomplete reads and timeouts quarantine the file as a failed scan; they do not
approve it. Transient errors retry automatically, up to six attempts. This work
has no connection to AI routes, metering, or customer credits.

Existing workspace attachments are backfilled as pending; they are **not**
grandfathered as scanned. Without a configured scanner, their preview/download
will stay blocked. Do not deploy this gate without preparing the scanner.

Antivirus reduces risk; it is not a guarantee against every malicious file.
File-type/signature limits, private ownership checks and download headers remain
in force. Only JPEG, PNG, GIF and WebP may be served inline. Documents remain
attachments. Responses are private/no-store and never expose storage keys or
public/signed object URLs.

## Durable Cleanup

A database trigger records object cleanup in the same transaction that deletes
a workspace item, including cascades. Deleting an item does not depend on object
storage being online and never restores the removed item on failure. Uploads
also record an orphan guard before storage write; committing the workspace item
cancels that guard atomically. Interrupted uploads expire after one hour.

Workers claim jobs with database row locks and expiring leases. Each process
handles a bounded batch sequentially, with capped retry delays and six attempts.
Success removes the job. Persistent failure leaves an operator-visible record.
Raw scanner responses, private filenames and object keys are not logged or
returned by the operator report.

Authenticated owners/admins can inspect `GET /api/storyhold/admin/private-file-jobs`.
The report contains opaque job IDs, operation, attempts, status, generic error
codes and timestamps, capped at 200 records with persistent failures first.
There is no customer endpoint for releasing quarantine or declaring files clean.

The worker starts with Storyhold and checks every five seconds while the process
is alive. On an Autoscale instance scaled to zero, jobs remain durable but wait
for the next instance startup. Guaranteed no-traffic cleanup requires an
always-running or scheduled worker; no new paid hosting service is enabled here.

## Verification

Run from `artifacts/api-server`:

```
node test.mjs src/storyhold/privateFileSafety.test.ts src/storyhold/workspaceFileRoutes.test.ts src/storyhold/sourceVaultStorage.test.ts
node test.mjs src/storyhold/privateFileScannerCheck.test.ts
```

Configuration/helper regressions from the repository root:

```
node --test scripts/prepare-storyhold-antivirus.test.mjs
```

Tests use isolated in-memory databases, fake private storage and a loopback
ClamAV protocol fixture. They do not call a paid AI provider, mutate live worlds,
or prove that a deployment has a functioning antivirus daemon. Deployment still
needs a real clean-file and standard antivirus-test-file smoke check.

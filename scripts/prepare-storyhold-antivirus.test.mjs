import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, writeFile, lstat, chmod, symlink, mkdir, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { antivirusConfiguration, prepareAntivirus } from "./prepare-storyhold-antivirus.mjs";

test("antivirus configuration binds only a private socket and matches the upload limit", () => {
  const files = antivirusConfiguration("/srv/storyhold/antivirus", "runner");
  assert.equal(Object.keys(files).length, 3);
  assert.match(files["clamd.conf"], /^LocalSocket \/srv\/storyhold\/antivirus\/clamd.sock$/m);
  assert.match(files["clamd.conf"], /^LocalSocketMode 600$/m);
  assert.doesNotMatch(files["clamd.conf"], /^TCP/m);
  assert.match(files["clamd.conf"], /^StreamMaxLength 25M$/m);
  assert.match(files["clamd.conf"], /^MaxFileSize 25M$/m);
  for (const directive of ["ScanArchive", "ScanPDF", "ScanOLE2", "ScanXMLDOCS", "HeuristicAlerts", "AlertExceedsMax", "AlertEncryptedArchive", "AlertEncryptedDoc"]) {
    assert.match(files["clamd.conf"], new RegExp(`^${directive} yes$`, "m"));
  }
  assert.match(files["clamd.conf"], /^MaxScanTime 20000$/m);
  assert.match(files["clamd.conf"], /^ConcurrentDatabaseReload no$/m);
  assert.match(files["freshclam.conf"], /^DatabaseOwner runner$/m);
  assert.match(files["freshclam.conf"], /^DatabaseMirror database.clamav.net$/m);
  assert.match(files["freshclam.conf"], /^Checks 12$/m);
  assert.match(files["freshclam.conf"], /^NotifyClamd \/srv\/storyhold\/antivirus\/clamd.conf$/m);
  assert.match(files["storyhold-antivirus.env"], /^STORYHOLD_CLAMD_SOCKET=\/srv\/storyhold\/antivirus\/clamd.sock$/m);
});

test("configuration preparation rejects ambiguous paths and configuration injection", () => {
  for (const directory of ["/", "/tmp", "./av", "/srv/../av", "/srv/av/", "/srv//av", "/srv/av\nTCPSocket 3310", "/srv/av files", "/srv/" + "x".repeat(100)]) {
    assert.throws(() => antivirusConfiguration(directory, "runner"));
  }
  for (const account of ["", "runner\nDatabaseMirror evil", "$(whoami)"]) {
    assert.throws(() => antivirusConfiguration("/srv/storyhold/av", account));
  }
});

test("preparation help starts no daemon and requires an explicit directory", () => {
  const script = fileURLToPath(new URL("./prepare-storyhold-antivirus.mjs", import.meta.url));
  const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /does not install, start, or download/);
  const missing = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /Usage:/);
});

test("preparation refuses Windows without creating antivirus files", async () => {
  if (process.platform === "linux") {
    // An invalid dedicated directory fails before any filesystem operation.
    await assert.rejects(prepareAntivirus("/"), /dedicated Linux/);
  } else {
    await assert.rejects(prepareAntivirus("/srv/storyhold/av"), /Linux-only/);
  }
});

test("filesystem preparation is idempotent and refuses unsafe existing targets where supported", async () => {
  if (process.platform !== "linux") {
    await assert.rejects(prepareAntivirus("/srv/storyhold/av"), /Linux-only/);
    return;
  }
  if (userInfo().uid === 0) {
    await assert.rejects(prepareAntivirus("/srv/storyhold/av"), /non-root/);
    return;
  }
  const temporary = await mkdtemp(join(tmpdir(), "storyhold-av-prepare-"));
  const state = join(temporary, "scanner");
  try {
    await prepareAntivirus(state);
    const original = await readFile(join(state, "clamd.conf"), "utf8");
    await prepareAntivirus(state);
    assert.equal(await readFile(join(state, "clamd.conf"), "utf8"), original);
    assert.equal((await lstat(state)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(state, "clamd.conf"))).mode & 0o777, 0o600);
    await writeFile(join(state, "clamd.conf"), "operator configuration");
    await assert.rejects(prepareAntivirus(state), /not overwritten/);
    assert.equal(await readFile(join(state, "clamd.conf"), "utf8"), "operator configuration");
    await mkdir(join(temporary, "public"), { mode: 0o700 });
    await chmod(join(temporary, "public"), 0o755);
    await assert.rejects(prepareAntivirus(join(temporary, "public")), /0700/);
    await symlink(state, join(temporary, "link"));
    await assert.rejects(prepareAntivirus(join(temporary, "link")), /real directory/);
    await mkdir(join(temporary, "linked-config"), { mode: 0o700 });
    await symlink(join(state, "clamd.conf"), join(temporary, "linked-config", "clamd.conf"));
    await assert.rejects(prepareAntivirus(join(temporary, "linked-config")), /not overwritten/);
  } finally {
    // Only this test's dedicated mkdtemp tree; no installed dependencies touched.
    await rm(temporary, { recursive: true, force: true });
  }
});

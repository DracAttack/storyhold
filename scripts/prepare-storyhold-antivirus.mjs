import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { userInfo } from "node:os";
import { pathToFileURL } from "node:url";

// Deployment preparation only: no installation, downloads or child processes.
export function antivirusConfiguration(stateDirectory, account) {
  if (typeof stateDirectory !== "string" || !/^\/[A-Za-z0-9_./-]+$/u.test(stateDirectory)
    || stateDirectory.endsWith("/") || stateDirectory !== posix.normalize(stateDirectory) || posix.dirname(stateDirectory) === "/") {
    throw new Error("Use an absolute, dedicated Linux state directory without spaces or traversal.");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*[$]?$/u.test(account)) throw new Error("Use a valid Linux service account.");
  const socket = `${stateDirectory}/clamd.sock`;
  if (Buffer.byteLength(socket) > 100) throw new Error("Choose a shorter directory for the Unix socket.");
  return {
    "clamd.conf": `# Generated Storyhold private-upload scanner configuration.
DatabaseDirectory ${stateDirectory}/signatures
TemporaryDirectory ${stateDirectory}/temporary
LocalSocket ${socket}
LocalSocketMode 600
FixStaleSocket yes
Foreground yes
User ${account}
StreamMaxLength 25M
MaxFileSize 25M
MaxScanSize 100M
MaxFiles 1000
MaxRecursion 12
MaxScanTime 20000
MaxThreads 2
MaxQueue 4
ReadTimeout 10
CommandReadTimeout 5
SelfCheck 600
ConcurrentDatabaseReload no
FailIfCvdOlderThan 7
ScanArchive yes
ScanPDF yes
ScanOLE2 yes
ScanXMLDOCS yes
HeuristicAlerts yes
AlertExceedsMax yes
AlertEncryptedArchive yes
AlertEncryptedDoc yes
LogClean no
LogVerbose no
ExtendedDetectionInfo no
LeaveTemporaryFiles no
`,
    "freshclam.conf": `# Run one initial update, then supervise freshclam --daemon.
DatabaseDirectory ${stateDirectory}/signatures
DatabaseOwner ${account}
DatabaseMirror database.clamav.net
DNSDatabaseInfo current.cvd.clamav.net
Checks 12
Foreground yes
ConnectTimeout 10
ReceiveTimeout 30
MaxAttempts 3
NotifyClamd ${stateDirectory}/clamd.conf
`,
    "storyhold-antivirus.env": `# Load into the API process before starting it; not a secret.
STORYHOLD_CLAMD_SOCKET=${socket}
`,
  };
}

export async function prepareAntivirus(stateDirectory) {
  if (process.platform !== "linux") throw new Error("Antivirus preparation is Linux-only. No Windows installation is changed.");
  const account = userInfo();
  const files = antivirusConfiguration(stateDirectory, account.username);
  if (account.uid === 0) throw new Error("Run preparation as the non-root account that runs Storyhold and ClamAV.");
  // Reject links/foreign-owned parents before creating anything beneath them.
  for (let path = stateDirectory; path !== "/"; path = posix.dirname(path)) {
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== process.getuid() && stat.uid !== 0)) {
        throw new Error("Use a real directory owned by this service account or root.");
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  for (const directory of [stateDirectory, `${stateDirectory}/signatures`, `${stateDirectory}/temporary`]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
      throw new Error("Antivirus directories must be owned by the current account with mode 0700; existing permissions are not changed.");
    }
  }
  for (const [name, content] of Object.entries(files)) {
    const target = `${stateDirectory}/${name}`;
    try { await writeFile(target, content, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)
        || await readFile(target, "utf8") !== content) {
        throw new Error("Existing antivirus configuration differs or has unsafe permissions; it was not overwritten.");
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === "--help") {
    console.log("Usage: pnpm storyhold:antivirus:prepare /absolute/private/state-directory\nLinux only. Writes configuration; does not install, start, or download anything.");
    process.exitCode = args[0] === "--help" ? 0 : 1;
  } else {
    try {
      await prepareAntivirus(args[0]);
      console.log("Antivirus configuration prepared. Follow docs/private-workspace-file-safety.md before enabling uploads.");
    } catch (error) {
      console.error(error.code ? "Antivirus preparation could not access its dedicated directory; no services were started." : error.message);
      process.exitCode = 1;
    }
  }
}

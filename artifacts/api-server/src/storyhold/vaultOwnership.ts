import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

type VaultOwner = {
  version: 1;
  token: string;
  pid: number;
  hostname: string;
  purpose: string;
  startedAt: string;
  dataDir: string;
};

export class VaultOwnershipError extends Error {
  constructor(message: string, readonly lockDirectory: string, readonly owner: VaultOwner | null = null) {
    super(message);
    this.name = "VaultOwnershipError";
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

async function readOwner(lockDirectory: string): Promise<VaultOwner> {
  try {
    const value = JSON.parse(await readFile(path.join(lockDirectory, "owner.json"), "utf8"));
    if (value.version !== 1 || typeof value.token !== "string" || !value.token ||
      !Number.isSafeInteger(value.pid) || value.pid < 1 ||
      typeof value.hostname !== "string" || !value.hostname ||
      typeof value.dataDir !== "string" || !path.isAbsolute(value.dataDir)) {
      throw new Error("Invalid ownership record");
    }
    return value;
  } catch {
    throw new VaultOwnershipError(
      "Storyhold cannot establish who owns this vault because its ownership record is missing or unreadable. The vault has not been opened.",
      lockDirectory,
    );
  }
}

function processIsDefinitelyGone(owner: VaultOwner): boolean {
  if (owner.hostname !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    // Permission failures and unknown platforms never prove the owner exited.
    // A reused live PID is conservatively treated as an owner as well.
    return errorCode(error) === "ESRCH";
  }
}

/**
 * Every process opening a persistent Storyhold PGlite vault must acquire this
 * lease first, and release it only AFTER database.close() completes. This is
 * process ownership, independent of HTTP readiness, ports, or worker state.
 *
 * The short acquisition gate serializes stale-owner reclamation. An interrupted
 * gate is never automatically removed: guessing could delete a new owner's
 * lease. Ordinary crashes after acquisition are recovered using a dead PID.
 */
export async function acquireStoryholdVaultOwnership(
  requestedDataDir: string,
  options: { purpose: string },
) {
  const absoluteDataDir = path.resolve(requestedDataDir);
  await mkdir(absoluteDataDir, { recursive: true });
  const dataDir = await realpath(absoluteDataDir);
  const lockDirectory = path.join(path.dirname(dataDir), `.${path.basename(dataDir)}.storyhold-owner`);
  const gateDirectory = `${lockDirectory}.acquiring`;
  try {
    await mkdir(gateDirectory);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    throw new VaultOwnershipError(
      "Another process is acquiring this Storyhold vault, or an earlier acquisition was interrupted. The vault has not been opened. Retry after the other process exits; a persistent acquisition marker requires inspection.",
      gateDirectory,
    );
  }
  const owner: VaultOwner = {
    version: 1, token: randomUUID(), pid: process.pid, hostname: hostname(),
    purpose: options.purpose.slice(0, 200), startedAt: new Date().toISOString(), dataDir,
  };
  try {
    try {
      await mkdir(lockDirectory);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const previous = await readOwner(lockDirectory);
      if (!processIsDefinitelyGone(previous)) {
        throw new VaultOwnershipError(
          `This Storyhold vault is already owned by process ${previous.pid} (${previous.purpose || "another Storyhold task"}). Stop that process cleanly before opening the vault elsewhere.`,
          lockDirectory, previous,
        );
      }
      // The gate prevents two dead-owner reclaimers from deleting one another's
      // replacement lease. Only these two exact metadata paths are removed.
      await unlink(path.join(lockDirectory, "owner.json"));
      await rmdir(lockDirectory);
      await mkdir(lockDirectory);
    }
    await writeFile(path.join(lockDirectory, "owner.json"), JSON.stringify(owner), { encoding: "utf8", flag: "wx", mode: 0o600 });
  } finally {
    await rmdir(gateDirectory);
  }
  let released = false;
  return {
    dataDir,
    lockDirectory,
    owner,
    async release() {
      if (released) return;
      const current = await readOwner(lockDirectory);
      if (current.token !== owner.token || current.pid !== owner.pid) {
        throw new VaultOwnershipError("The vault ownership record changed; refusing to remove another process's lease.", lockDirectory, current);
      }
      await unlink(path.join(lockDirectory, "owner.json"));
      await rmdir(lockDirectory);
      released = true;
    },
  };
}

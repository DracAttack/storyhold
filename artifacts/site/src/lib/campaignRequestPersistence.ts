import type { CampaignInputMode } from "./storyholdApi";

type SessionStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type PendingCampaignTurnRequest = {
  version: 1;
  kind: "turn";
  playerId: string;
  campaignId: string;
  requestId: string;
  inputFingerprint: string;
};

export type PendingCampaignRerollRequest = {
  version: 1;
  kind: "reroll";
  playerId: string;
  campaignId: string;
  // The API derives the fixed-price reroll request ID from this proposal ID.
  // Retaining the source therefore retains the exact paid attempt.
  sourceProposalId: string;
};

export type PendingCampaignBranchRequest = {
  version: 1;
  kind: "branch";
  playerId: string;
  campaignId: string;
  checkpointId: string;
  requestId: string;
  name: string;
  mode: "writer" | "alternate";
};

const SAFE_ID = /^[a-zA-Z0-9_-]{8,100}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;

function availableSessionStorage(
  supplied?: SessionStorageLike | null,
): SessionStorageLike | null {
  if (supplied !== undefined) return supplied;
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function turnStorageKey(playerId: string, campaignId: string) {
  return `storyhold:pending-campaign-turn:${playerId}:${campaignId}`;
}

function rerollStorageKey(playerId: string, campaignId: string) {
  return `storyhold:pending-campaign-reroll:${playerId}:${campaignId}`;
}

function branchStorageKey(playerId: string, campaignId: string) {
  return `storyhold:pending-campaign-branch:${playerId}:${campaignId}`;
}

function removeSafely(storage: SessionStorageLike | null, key: string) {
  try {
    storage?.removeItem(key);
  } catch {
    // Storage can be blocked in private or hardened browser sessions. The
    // caller still retains its in-memory identity for the current page load.
  }
}

function writeSafely(
  storage: SessionStorageLike | null,
  key: string,
  value:
    | PendingCampaignTurnRequest
    | PendingCampaignRerollRequest
    | PendingCampaignBranchRequest,
) {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // See removeSafely. Paid work must remain usable when storage is blocked.
  }
}

function readJson(
  storage: SessionStorageLike | null,
  key: string,
): Record<string, unknown> | null {
  try {
    const value = JSON.parse(storage?.getItem(key) || "null") as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    removeSafely(storage, key);
    return null;
  }
}

function fallbackFingerprint(value: string): string {
  // Modern browsers use SHA-256 below. This deterministic fallback keeps
  // retries functional in restricted WebViews without ever storing the text.
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ (code + index), 0x85ebca6b);
  }
  const seed = `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0).toString(16).padStart(8, "0")}`;
  return seed.repeat(4);
}

export async function campaignTurnInputFingerprint(input: {
  action: string;
  inputMode: CampaignInputMode;
}): Promise<string> {
  const value = JSON.stringify([input.inputMode, input.action]);
  try {
    if (typeof crypto !== "undefined" && crypto.subtle) {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(value),
      );
      return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
    }
  } catch {
    // Fall through to the compatibility fingerprint.
  }
  return fallbackFingerprint(value);
}

export function readPendingCampaignTurnRequest(input: {
  playerId: string;
  campaignId: string;
  storage?: SessionStorageLike | null;
}): PendingCampaignTurnRequest | null {
  const storage = availableSessionStorage(input.storage);
  const key = turnStorageKey(input.playerId, input.campaignId);
  const parsed = readJson(storage, key);
  if (
    parsed?.version !== 1 || parsed.kind !== "turn" ||
    parsed.playerId !== input.playerId || parsed.campaignId !== input.campaignId ||
    typeof parsed.requestId !== "string" || !SAFE_ID.test(parsed.requestId) ||
    typeof parsed.inputFingerprint !== "string" || !FINGERPRINT.test(parsed.inputFingerprint)
  ) {
    removeSafely(storage, key);
    return null;
  }
  return parsed as PendingCampaignTurnRequest;
}

export async function acquireCampaignTurnRequest(input: {
  playerId: string;
  campaignId: string;
  action: string;
  inputMode: CampaignInputMode;
  createRequestId: () => string;
  pendingRequest?: PendingCampaignTurnRequest | null;
  storage?: SessionStorageLike | null;
}): Promise<PendingCampaignTurnRequest> {
  const storage = availableSessionStorage(input.storage);
  const inputFingerprint = await campaignTurnInputFingerprint(input);
  const inMemory = input.pendingRequest;
  const existing = inMemory?.playerId === input.playerId &&
    inMemory.campaignId === input.campaignId &&
    SAFE_ID.test(inMemory.requestId) && FINGERPRINT.test(inMemory.inputFingerprint)
    ? inMemory
    : readPendingCampaignTurnRequest({
        playerId: input.playerId,
        campaignId: input.campaignId,
        storage,
      });
  if (existing?.inputFingerprint === inputFingerprint) return existing;
  const requestId = input.createRequestId();
  if (!SAFE_ID.test(requestId)) {
    throw new Error("Storyhold could not create a safe request identifier.");
  }
  const pending: PendingCampaignTurnRequest = {
    version: 1,
    kind: "turn",
    playerId: input.playerId,
    campaignId: input.campaignId,
    requestId,
    inputFingerprint,
  };
  writeSafely(storage, turnStorageKey(input.playerId, input.campaignId), pending);
  return pending;
}

export function clearPendingCampaignTurnRequest(input: {
  playerId: string;
  campaignId: string;
  requestId?: string;
  storage?: SessionStorageLike | null;
}) {
  const storage = availableSessionStorage(input.storage);
  if (input.requestId) {
    const existing = readPendingCampaignTurnRequest({ ...input, storage });
    if (existing?.requestId !== input.requestId) return;
  }
  removeSafely(storage, turnStorageKey(input.playerId, input.campaignId));
}

export function readPendingCampaignRerollRequest(input: {
  playerId: string;
  campaignId: string;
  storage?: SessionStorageLike | null;
}): PendingCampaignRerollRequest | null {
  const storage = availableSessionStorage(input.storage);
  const key = rerollStorageKey(input.playerId, input.campaignId);
  const parsed = readJson(storage, key);
  if (
    parsed?.version !== 1 || parsed.kind !== "reroll" ||
    parsed.playerId !== input.playerId || parsed.campaignId !== input.campaignId ||
    typeof parsed.sourceProposalId !== "string" || !SAFE_ID.test(parsed.sourceProposalId)
  ) {
    removeSafely(storage, key);
    return null;
  }
  return parsed as PendingCampaignRerollRequest;
}

export function acquireCampaignRerollRequest(input: {
  playerId: string;
  campaignId: string;
  currentProposalId: string;
  currentRerolledFromProposalId?: string | null;
  pendingRequest?: PendingCampaignRerollRequest | null;
  storage?: SessionStorageLike | null;
}): PendingCampaignRerollRequest {
  const storage = availableSessionStorage(input.storage);
  const inMemory = input.pendingRequest;
  const existing = inMemory?.playerId === input.playerId &&
    inMemory.campaignId === input.campaignId && SAFE_ID.test(inMemory.sourceProposalId)
    ? inMemory
    : readPendingCampaignRerollRequest({ ...input, storage });
  const existingStillMatchesLoadedChain = existing && (
    existing.sourceProposalId === input.currentProposalId ||
    existing.sourceProposalId === input.currentRerolledFromProposalId
  );
  if (existingStillMatchesLoadedChain) return existing;
  if (!SAFE_ID.test(input.currentProposalId)) {
    throw new Error("Storyhold could not create a safe reroll identifier.");
  }
  const pending: PendingCampaignRerollRequest = {
    version: 1,
    kind: "reroll",
    playerId: input.playerId,
    campaignId: input.campaignId,
    sourceProposalId: input.currentProposalId,
  };
  writeSafely(storage, rerollStorageKey(input.playerId, input.campaignId), pending);
  return pending;
}

export function clearPendingCampaignRerollRequest(input: {
  playerId: string;
  campaignId: string;
  sourceProposalId?: string;
  storage?: SessionStorageLike | null;
}) {
  const storage = availableSessionStorage(input.storage);
  if (input.sourceProposalId) {
    const existing = readPendingCampaignRerollRequest({ ...input, storage });
    if (existing?.sourceProposalId !== input.sourceProposalId) return;
  }
  removeSafely(storage, rerollStorageKey(input.playerId, input.campaignId));
}

export function readPendingCampaignBranchRequest(input: {
  playerId: string;
  campaignId: string;
  storage?: SessionStorageLike | null;
}): PendingCampaignBranchRequest | null {
  const storage = availableSessionStorage(input.storage);
  const key = branchStorageKey(input.playerId, input.campaignId);
  const parsed = readJson(storage, key);
  if (
    parsed?.version !== 1 ||
    parsed.kind !== "branch" ||
    parsed.playerId !== input.playerId ||
    parsed.campaignId !== input.campaignId ||
    typeof parsed.checkpointId !== "string" ||
    !SAFE_ID.test(parsed.checkpointId) ||
    typeof parsed.requestId !== "string" ||
    !SAFE_ID.test(parsed.requestId) ||
    typeof parsed.name !== "string" ||
    parsed.name.length < 1 ||
    parsed.name.length > 120 ||
    (parsed.mode !== "writer" && parsed.mode !== "alternate")
  ) {
    removeSafely(storage, key);
    return null;
  }
  return parsed as PendingCampaignBranchRequest;
}

export function acquireCampaignBranchRequest(input: {
  playerId: string;
  campaignId: string;
  checkpointId: string;
  name: string;
  mode: "writer" | "alternate";
  createRequestId: () => string;
  pendingRequest?: PendingCampaignBranchRequest | null;
  storage?: SessionStorageLike | null;
}): PendingCampaignBranchRequest {
  const storage = availableSessionStorage(input.storage);
  const inMemory = input.pendingRequest;
  const existing =
    inMemory?.playerId === input.playerId &&
    inMemory.campaignId === input.campaignId &&
    SAFE_ID.test(inMemory.checkpointId) &&
    SAFE_ID.test(inMemory.requestId)
      ? inMemory
      : readPendingCampaignBranchRequest({ ...input, storage });
  // A reload can change the displayed branch ordinal. The stored name and mode
  // are authoritative for the same paid checkpoint attempt so the API sees an
  // identical idempotency payload rather than a new chargeable request.
  if (existing?.checkpointId === input.checkpointId) return existing;
  if (!SAFE_ID.test(input.checkpointId)) {
    throw new Error("Storyhold could not identify the saved checkpoint safely.");
  }
  const requestId = input.createRequestId();
  if (!SAFE_ID.test(requestId)) {
    throw new Error("Storyhold could not create a safe branch request identifier.");
  }
  const pending: PendingCampaignBranchRequest = {
    version: 1,
    kind: "branch",
    playerId: input.playerId,
    campaignId: input.campaignId,
    checkpointId: input.checkpointId,
    requestId,
    name: input.name.slice(0, 120),
    mode: input.mode,
  };
  writeSafely(storage, branchStorageKey(input.playerId, input.campaignId), pending);
  return pending;
}

export function clearPendingCampaignBranchRequest(input: {
  playerId: string;
  campaignId: string;
  requestId?: string;
  storage?: SessionStorageLike | null;
}) {
  const storage = availableSessionStorage(input.storage);
  if (input.requestId) {
    const existing = readPendingCampaignBranchRequest({ ...input, storage });
    if (existing?.requestId !== input.requestId) return;
  }
  removeSafely(storage, branchStorageKey(input.playerId, input.campaignId));
}

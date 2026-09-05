/** Private development workflow; this module never contacts an AI provider. */
export type ManualTurnSummary = {
  id: string;
  campaignId: string;
  requestId: string;
  status: "awaiting_direction" | "awaiting_narration" | "completed" | "stale";
  createdAt: string;
  updatedAt: string;
  error: string | null;
  turnId: string | null;
};

export type ManualQueueRow = ManualTurnSummary & {
  campaignName: string;
  worldName: string;
  playerInput: string;
};

export type ManualStorytellerEntry = ManualTurnSummary & {
  playerInput: string;
  intent: string;
  expectedStateVersion: number;
  inputSha256: string;
  directorRequest: unknown;
  narratorRequest: unknown | null;
  direction: Record<string, unknown> | null;
  attempts: Array<{
    stage: string;
    accepted: boolean;
    error: string | null;
    notes: string;
    response?: unknown;
    createdAt: string;
  }>;
};

export type ManualQueuedResponse = { manualTurn: ManualTurnSummary; creditsUsed: 0 };

export function isManualQueuedResponse(value: unknown): value is ManualQueuedResponse {
  if (!value || typeof value !== "object") return false;
  const summary = (value as Partial<ManualQueuedResponse>).manualTurn;
  return Boolean(summary && typeof summary.id === "string" && typeof summary.requestId === "string");
}

export function manualTurnIsPending(turn: ManualTurnSummary | null | undefined): boolean {
  return turn?.status === "awaiting_direction" || turn?.status === "awaiting_narration";
}

export function manualTurnStatusLabel(status: ManualTurnSummary["status"]): string {
  return {
    awaiting_direction: "Awaiting Review",
    awaiting_narration: "Awaiting Story Response",
    completed: "Complete",
    stale: "Context Changed",
  }[status];
}

type ManualResponseInput = {
  entryId: string;
  inputSha256: string;
  direction?: Record<string, unknown>;
  narration?: string;
  notes?: string;
};

export function manualResponseTemplate(entry: ManualStorytellerEntry): ManualResponseInput {
  return {
    entryId: entry.id,
    inputSha256: entry.inputSha256,
    ...(entry.status === "awaiting_narration" ? { narration: "" } : { direction: {} }),
    notes: "",
  };
}

/** Bind imported answers to the exact entry, so switching rows cannot misapply an answer. */
export function parseManualResponse(entry: ManualStorytellerEntry, text: string): ManualResponseInput {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Paste a valid JSON response or import a JSON file."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The response must be a JSON object.");
  const input = value as Partial<ManualResponseInput>;
  if (input.entryId !== entry.id || input.inputSha256 !== entry.inputSha256) {
    throw new Error("This response belongs to another saved input. Export this entry and use its response template.");
  }
  if (!manualTurnIsPending(entry)) throw new Error("This entry is no longer awaiting an answer. Refresh the queue.");
  if (input.notes !== undefined && (typeof input.notes !== "string" || input.notes.length > 8_000)) {
    throw new Error("Keep audit notes under 8,000 characters.");
  }
  if (entry.status === "awaiting_direction") {
    if (!input.direction || typeof input.direction !== "object" || Array.isArray(input.direction) || !Object.keys(input.direction).length) {
      throw new Error("Include the Director's structured decision in the direction field.");
    }
    if (input.narration !== undefined) throw new Error("Validate the Director decision first, then export the prepared narration request.");
    return { entryId: entry.id, inputSha256: entry.inputSha256, direction: input.direction, notes: input.notes ?? "" };
  }
  if (typeof input.narration !== "string" || !input.narration.trim()) throw new Error("Include the story response in the narration field.");
  if (input.narration.length > 12_000) throw new Error("Keep this turn's narration within 12,000 characters so the exact response can be checked and saved.");
  if (input.direction !== undefined) throw new Error("The Director decision is already saved. This stage accepts narration only.");
  return { entryId: entry.id, inputSha256: entry.inputSha256, narration: input.narration, notes: input.notes ?? "" };
}

export function manualEntryExport(entry: ManualStorytellerEntry) {
  return { format: "storyhold-manual-storyteller-v1", entry, responseTemplate: manualResponseTemplate(entry) };
}

export class ManualStorytellerError extends Error {
  constructor(message: string, public status: number, public entry: ManualStorytellerEntry | null = null) {
    super(message);
    this.name = "ManualStorytellerError";
  }
}

function apiBase() {
  return `${(import.meta.env?.BASE_URL ?? "/").replace(/\/$/, "")}/api/storyhold/admin/manual-storyteller`;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      ...options,
      credentials: "include",
      headers: { "Content-Type": "application/json", ...options?.headers },
    });
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    throw new ManualStorytellerError("Storyhold could not be reached. Refresh this entry before retrying; the saved answer may already have been accepted.", 0);
  }
  if (!response.ok) {
    let payload: { error?: string; entry?: ManualStorytellerEntry } = {};
    try { payload = await response.json(); } catch { /* Use the status explanation. */ }
    const messages: Record<number, string> = {
      401: "Sign in again to open the private test queue.",
      403: "This queue is available to the owner and administrators only.",
      404: "Manual Storyteller is disabled, or this entry no longer exists.",
      409: "This entry changed. Refresh it before submitting an answer.",
      422: "Storyhold rejected the answer. Inspect the recorded validation result before correcting it.",
    };
    throw new ManualStorytellerError(messages[response.status] ?? "The test queue could not complete that request.", response.status, payload.entry ?? null);
  }
  return response.json() as Promise<T>;
}

export function listManualStorytellerEntries(signal?: AbortSignal) {
  return request<{ enabled: boolean; entries: ManualQueueRow[] }>("", { signal });
}

export function getManualStorytellerEntry(id: string, signal?: AbortSignal) {
  return request<{ entry: ManualStorytellerEntry }>(`/${encodeURIComponent(id)}`, { signal });
}

export function submitManualDirection(id: string, input: { inputSha256: string; direction: Record<string, unknown>; notes?: string }) {
  return request<{ entry: ManualStorytellerEntry }>(`/${encodeURIComponent(id)}/direction`, { method: "POST", body: JSON.stringify(input) });
}

export function completeManualStorytellerEntry(id: string, input: { inputSha256: string; narration: string; notes?: string }) {
  return request<{ entry: ManualStorytellerEntry; duplicate: boolean }>(`/${encodeURIComponent(id)}/complete`, { method: "POST", body: JSON.stringify(input) });
}

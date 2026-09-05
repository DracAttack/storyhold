/** Player-facing setup progress contains only the approved opening, never a plan. */
export type AdventureSetupStatus = {
  required: boolean;
  status: "not_required" | "required" | "awaiting_response" | "generating" | "ready" | "failed";
  opening: string | null;
};

export function adventureSetupBlocksPlay(setup: AdventureSetupStatus | null | undefined): boolean {
  return Boolean(setup?.required && setup.status !== "ready");
}

export function adventureSetupIsPending(setup: AdventureSetupStatus | null | undefined): boolean {
  return setup?.status === "awaiting_response" || setup?.status === "generating";
}

export function adventureSetupOpening(setup: AdventureSetupStatus | null | undefined): string | null {
  return setup?.status === "ready" && setup.opening?.trim() ? setup.opening : null;
}

function apiBase() {
  return `${(import.meta.env?.BASE_URL ?? "/").replace(/\/$/, "")}/api/storyhold`;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      ...options,
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...options?.headers },
    });
  } catch (reason) {
    if (options?.signal?.aborted) throw reason;
    throw new Error("Your adventure is saved. Storyhold could not be reached; try again in a moment.");
  }
  if (!response.ok) {
    // Never forward provider errors or private planning details into player UI.
    const messages: Record<number, string> = {
      401: "Sign in again to continue your adventure.",
      403: "This adventure is not available to this account.",
      409: "This adventure changed. Refresh before trying again.",
      422: "That answer could not be accepted. Review it and try again.",
    };
    throw new Error(messages[response.status] ?? "Your adventure is saved, but preparation could not finish. Try again in a moment.");
  }
  return response.json() as Promise<T>;
}

/** An explicit, campaign-bound action; rendering and progress checks never call this. */
export function prepareAdventureSetup(campaignId: string) {
  return request<{ adventureSetup: AdventureSetupStatus; creditsUsed: number }>(
    `/campaigns/${encodeURIComponent(campaignId)}/setup`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

/** The following types and helpers belong exclusively to the authenticated admin queue. */
export type AdventureSetupQueueRow = {
  id: string;
  campaignId: string;
  campaignName: string;
  status: AdventureSetupStatus["status"];
  createdAt: string;
  updatedAt: string;
  error: string | null;
};

export type AdventureSetupEntry = AdventureSetupQueueRow & {
  inputSha256: string;
  request: unknown;
  plan: unknown | null;
  notes: string;
};

export function adventureSetupResponseTemplate(entry: AdventureSetupEntry) {
  return { entryId: entry.id, inputSha256: entry.inputSha256, plan: {}, notes: "" };
}

export function adventureSetupEntryExport(entry: AdventureSetupEntry) {
  return { format: "storyhold-adventure-setup-v1", entry, responseTemplate: adventureSetupResponseTemplate(entry) };
}

export function parseAdventureSetupResponse(entry: AdventureSetupEntry, text: string) {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Paste valid JSON or import a JSON response file."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The response must be a JSON object.");
  const input = value as Record<string, unknown>;
  if (input.entryId !== entry.id || input.inputSha256 !== entry.inputSha256) {
    throw new Error("This response belongs to another saved input. Use this entry's exported response template.");
  }
  if (entry.status !== "awaiting_response" && entry.status !== "failed") {
    throw new Error("This entry is no longer awaiting an answer. Refresh the queue.");
  }
  if (!input.plan || typeof input.plan !== "object" || Array.isArray(input.plan) || !Object.keys(input.plan).length) {
    throw new Error("Include the structured adventure setup in the plan field.");
  }
  if (input.notes !== undefined && (typeof input.notes !== "string" || input.notes.length > 8_000)) {
    throw new Error("Keep audit notes under 8,000 characters.");
  }
  return { inputSha256: entry.inputSha256, plan: input.plan, notes: (input.notes as string | undefined) ?? "" };
}

export function listAdventureSetupEntries(signal?: AbortSignal) {
  return request<{ enabled: boolean; entries: AdventureSetupQueueRow[] }>("/admin/adventure-setups", { signal });
}

export function getAdventureSetupEntry(id: string, signal?: AbortSignal) {
  return request<{ entry: AdventureSetupEntry }>(`/admin/adventure-setups/${encodeURIComponent(id)}`, { signal });
}

export function completeAdventureSetupEntry(id: string, input: { inputSha256: string; plan: unknown; notes?: string }) {
  return request<{ entry: AdventureSetupEntry; duplicate: boolean }>(`/admin/adventure-setups/${encodeURIComponent(id)}/complete`, {
    method: "POST", body: JSON.stringify(input),
  });
}

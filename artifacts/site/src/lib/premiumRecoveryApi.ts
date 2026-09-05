// This API is exclusively consumed by the owner/admin route, never customer UI.
export type PremiumRecoveryDecision = {
  stepKey: string;
  outcome: "no_charge" | "charged";
  costMicros: number;
  providerReference: string;
};

export type PremiumRecoveryReceipt = {
  id: string;
  actorId: string;
  note: string;
  decisions: PremiumRecoveryDecision[];
  costMicros: number;
  creditsUsed: number;
  creditsRefunded: number;
  createdAt: string;
};

export type PremiumRecoveryReview = {
  id: string;
  runId: string;
  worldId: string;
  worldName: string;
  status: string;
  stage: string;
  progress: number;
  createdAt: string | null;
  fingerprint: string;
  recoveryMode: "planned_attestation" | "legacy_total_attestation" | "settled_accounting_adoption";
  canFinalize: boolean;
  blockReason: string | null;
  reservedCredits: number;
  knownCostMicros: number;
  steps: Array<{
    stepKey: string;
    status: string;
    provider: string;
    model: string;
    knownCostMicros: number | null;
    needsDecision: boolean;
    dispatchedAt: string | null;
    lastRecordedAt: string | null;
  }>;
  receipt: PremiumRecoveryReceipt | null;
};

export type PremiumRecoveryDraft = {
  outcome: "" | PremiumRecoveryDecision["outcome"];
  usd: string;
  providerReference: string;
};

export type PremiumRecoveryFinalizeInput = {
  expectedFingerprint: string;
  note: string;
  confirmProviderChecked: true;
  decisions: PremiumRecoveryDecision[];
};

export function isPremiumRecoveryOperator(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** Prevent operator-entered credentials from becoming durable audit-log content. */
export function containsRecoveryCredential(value: string): boolean {
  return [
    /\bbearer\s+[a-z0-9._~+/=-]{12,}/iu,
    /\bsk-(?:or-v1-|ant-(?:api\d{2}-)?)?[a-z0-9_-]{16,}/iu,
    /\b(?:openai|openrouter|anthropic|xai|mistral|google|gemini|groq|together|fireworks|perplexity)[_-]?api[_-]?key\s*[:=]\s*\S+/iu,
    /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/iu,
    /-----BEGIN OPENSSH PRIVATE KEY-----/iu,
  ].some((pattern) => pattern.test(value));
}

/** Parse decimal USD exactly: no float rounding, exponent notation, or truncation. */
export function usdToMicros(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  return micros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micros) : null;
}

export function formatRecoveryCost(value: number | null): string {
  if (value === null || !Number.isSafeInteger(value) || value < 0) return "Unknown";
  const micros = BigInt(value);
  return `$${micros / 1_000_000n}.${String(micros % 1_000_000n).padStart(6, "0")}`;
}

export function formatRecoveryTimestamp(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not Recorded";
  return new Date(value).toLocaleString();
}

export function recoverySettlementCost(
  review: PremiumRecoveryReview,
  decisions: PremiumRecoveryDecision[],
): number | null {
  if (!Number.isSafeInteger(review.knownCostMicros) || review.knownCostMicros < 0) return null;
  let total = BigInt(review.knownCostMicros);
  for (const decision of decisions) {
    const recorded = review.steps.find((step) => step.stepKey === decision.stepKey)?.knownCostMicros ?? 0;
    if (!Number.isSafeInteger(decision.costMicros) || !Number.isSafeInteger(recorded)) return null;
    total += BigInt(decision.costMicros) - BigInt(recorded);
  }
  return total >= 0n && total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null;
}

export function buildRecoveryInput(
  review: PremiumRecoveryReview,
  drafts: Record<string, PremiumRecoveryDraft>,
  note: string,
  confirmProviderChecked: boolean,
): { input: PremiumRecoveryFinalizeInput; error: null } | { input: null; error: string } {
  const invalid = (error: string) => ({ input: null, error } as const);
  if (!review.canFinalize || review.status === "running" || review.receipt) {
    return invalid("This run cannot be finalized in its current state.");
  }
  if (!review.fingerprint) return invalid("Refresh this run before continuing.");
  const trimmedNote = note.trim();
  if (trimmedNote.length < 12 || trimmedNote.length > 2000) {
    return invalid("Add an audit note of 12–2,000 characters.");
  }
  if (containsRecoveryCredential(trimmedNote)) {
    return invalid("Remove API keys, authorization tokens, and private keys from the audit note.");
  }
  if (!confirmProviderChecked) return invalid("Confirm that you checked the provider records.");
  const decisions: PremiumRecoveryDecision[] = [];
  for (const step of review.steps.filter((item) => item.needsDecision)) {
    const draft = drafts[step.stepKey];
    if (!draft?.outcome) return invalid("Choose an outcome for every step requiring a decision.");
    const reference = draft.providerReference.trim();
    if (reference.length < 4 || reference.length > 300) {
      return invalid("Add a provider reference of 4–300 characters for each decision.");
    }
    if (containsRecoveryCredential(reference)) {
      return invalid("Use only a request or invoice ID as provider evidence; remove credentials and authorization tokens.");
    }
    const costMicros = draft.outcome === "no_charge" ? 0 : usdToMicros(draft.usd);
    if (costMicros === null) return invalid("Enter a nonnegative USD amount with at most six decimal places.");
    if (draft.outcome === "charged" && costMicros === 0) {
      return invalid("A charged outcome must have a positive USD amount. Choose No Charge only when verified.");
    }
    if (costMicros < (step.knownCostMicros ?? 0)) {
      return invalid("A step total cannot be lower than its already recorded usage.");
    }
    decisions.push({ stepKey: step.stepKey, outcome: draft.outcome, costMicros, providerReference: reference });
  }
  if (recoverySettlementCost(review, decisions) === null) return invalid("The verified usage total exceeds the supported amount.");
  return {
    input: { expectedFingerprint: review.fingerprint, note: trimmedNote, confirmProviderChecked: true, decisions },
    error: null,
  };
}

function recoveryApiBase(): string {
  return `${(import.meta.env?.BASE_URL ?? "/").replace(/\/$/, "")}/api/storyhold/admin/premium-recovery`;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${recoveryApiBase()}${path}`, {
      ...options,
      credentials: "include",
      headers: { "Content-Type": "application/json", ...options?.headers },
    });
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    throw new Error("The recovery service could not be reached. Refresh the run before trying again.");
  }
  if (!response.ok) {
    // Read only an allowlisted machine code. Never surface a response message,
    // which might contain an internal exception, provider error, or credential.
    let code = "";
    try {
      const payload = await response.json() as unknown;
      if (payload && typeof payload === "object" && typeof (payload as { code?: unknown }).code === "string") {
        code = (payload as { code: string }).code;
      }
    } catch { /* A status-only response still receives a safe generic message. */ }
    const codedMessages: Record<string, string> = {
      ACTIVE_WORKER: "A worker is still active for this world. Stop it safely or wait for it to finish, then refresh. No billing changes were made.",
      ALREADY_FINALIZED: "This run was already closed with a different audit request. Refresh it to view the saved receipt.",
      COST_EXCEEDS_HOLD: "Verified provider usage exceeds the original reserved credits. No additional credits were charged; leave this run unchanged for manual accounting.",
      DECISIONS_REQUIRED: "Every unresolved provider request needs exactly one verified outcome. Refresh and review each decision.",
      INVALID_COST: "The verified provider total exceeds the supported accounting range. Leave this run unchanged for manual accounting.",
      INVALID_DECISION: "A provider decision is incomplete or invalid. Refresh and verify each outcome, total, and reference.",
      INVALID_REQUEST: "The recovery details were not accepted. Refresh and review the confirmation, note, and provider decisions.",
      KNOWN_COST_CONFLICT: "A verified amount is lower than usage already recorded. Refresh and verify the total charge for that provider request.",
      NOT_FINALIZABLE: "This run is not eligible for automatic closure. Refresh it to see the current blocking reason.",
      RECEIPT_MISMATCH: "The saved receipt no longer matches this run. Do not retry or change billing; manual investigation is required.",
      SETTLEMENT_MISMATCH: "The credit settlement did not match the original hold. No settlement was completed; leave this run unchanged for manual investigation.",
      STALE_FINGERPRINT: "This run changed after you inspected it. Refresh and verify the provider records again before closing it.",
      STATE_CHANGED: "This run changed before closure could be recorded. No settlement was completed; refresh and verify the provider records again.",
    };
    if (codedMessages[code]) throw new Error(codedMessages[code]);
    const messages: Record<number, string> = {
      400: "The recovery details were not accepted. Review the decisions and refresh the run.",
      401: "Your session has expired. Sign in again to use Premium Recovery.",
      403: "Premium Recovery is available only to owners and administrators.",
      404: "This saved run is no longer available. Refresh the run list.",
      409: "This run changed or is blocked. Refresh it and review the latest state before continuing.",
      422: "The usage decisions could not be validated. Review each amount and provider reference.",
    };
    throw new Error(messages[response.status] ?? "Recovery could not be completed. Refresh the run to check whether a receipt was saved.");
  }
  try {
    return await response.json() as T;
  } catch {
    throw new Error("The recovery response could not be read. Refresh the run to check its saved state.");
  }
}

export function listPremiumRecoveryRuns(signal?: AbortSignal): Promise<{ runs: PremiumRecoveryReview[] }> {
  return request("", { signal });
}

export function getPremiumRecoveryRun(runId: string, signal?: AbortSignal): Promise<{ review: PremiumRecoveryReview }> {
  return request(`/${encodeURIComponent(runId)}`, { signal });
}

export function finalizePremiumRecoveryRun(
  runId: string,
  input: PremiumRecoveryFinalizeInput,
): Promise<{ receipt: PremiumRecoveryReceipt; review: PremiumRecoveryReview }> {
  return request(`/${encodeURIComponent(runId)}/finalize`, { method: "POST", body: JSON.stringify(input) });
}

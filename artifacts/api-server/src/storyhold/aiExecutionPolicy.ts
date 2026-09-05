/** Provider-neutral operation names understood by the execution boundary. */
export const AI_EXECUTION_TASKS = [
  "demo_scene",
  "campaign_turn",
  "campaign_direction",
  "campaign_narration",
  "story_adaptation",
  "world_analysis",
  "canon_review",
  "memory_maintenance",
] as const;
export type AiExecutionTask = (typeof AI_EXECUTION_TASKS)[number];

export const AI_EXECUTION_CONTENT_MODES = ["standard", "adult"] as const;
export type AiExecutionContentMode =
  (typeof AI_EXECUTION_CONTENT_MODES)[number];

/** Who supplied the model connection. This never identifies a provider. */
export type AiConnectionSource =
  | "storyhold_managed"
  | "installation_byo"
  | "player_byo";

/** Who pays the upstream model provider for this execution. */
export type AiBillingSource = "storyhold_credits" | "external_provider";

/** The trust boundary of the caller asking to use a connection. */
export type AiCallerScope =
  | "anonymous_demo"
  | "authenticated_player"
  | "installation_owner";

export type AiExecutionConnectionPolicy = Readonly<{
  /** Stable, non-secret identifier for audit and routing receipts. */
  connectionId: string;
  connectionSource: AiConnectionSource;
  billingSource: AiBillingSource;
  allowedTasks: readonly AiExecutionTask[];
  /** Adult mode must be listed explicitly; it is never inferred from provider. */
  contentModes: readonly AiExecutionContentMode[];
}>;

export type AiExecutionRequestPolicy = Readonly<{
  task: AiExecutionTask;
  contentMode: AiExecutionContentMode;
  callerScope: AiCallerScope;
  /** Locks the complete fallback chain to one funding boundary. */
  billingSource: AiBillingSource;
}>;

export type AiExecutionPolicyFailureCode =
  | "INVALID_POLICY"
  | "CALLER_SCOPE_NOT_ALLOWED"
  | "TASK_NOT_ALLOWED"
  | "CONTENT_MODE_NOT_ALLOWED"
  | "CROSS_FUNDING_FALLBACK";

export type AiExecutionPolicyDecision =
  | Readonly<{ allowed: true; code: null; reason: "allowed" }>
  | Readonly<{
      allowed: false;
      code: AiExecutionPolicyFailureCode;
      reason: string;
    }>;

export type AiExecutionPolicyProblem = Readonly<{
  field: "connectionId" | "billingSource" | "allowedTasks" | "contentModes";
  reason: string;
}>;

const STANDARD_ONLY = [
  "standard",
] as const satisfies readonly AiExecutionContentMode[];
const KNOWN_TASKS = new Set<string>(AI_EXECUTION_TASKS);
const KNOWN_CONTENT_MODES = new Set<string>(AI_EXECUTION_CONTENT_MODES);

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

/**
 * Validates invariants that must remain true regardless of the selected model
 * provider. Credential ownership is resolved elsewhere; no key is accepted by
 * this contract.
 */
export function validateAiExecutionConnectionPolicy(
  policy: AiExecutionConnectionPolicy,
): readonly AiExecutionPolicyProblem[] {
  const problems: AiExecutionPolicyProblem[] = [];
  if (typeof policy.connectionId !== "string" || !policy.connectionId.trim()) {
    problems.push({
      field: "connectionId",
      reason: "A non-secret connection identifier is required.",
    });
  }

  const expectedBillingSource: AiBillingSource =
    policy.connectionSource === "storyhold_managed"
      ? "storyhold_credits"
      : "external_provider";
  if (policy.billingSource !== expectedBillingSource) {
    problems.push({
      field: "billingSource",
      reason:
        policy.connectionSource === "storyhold_managed"
          ? "Storyhold-managed connections must use Storyhold credits."
          : "Bring-your-own connections must be billed by the external provider.",
    });
  }

  if (!Array.isArray(policy.allowedTasks) || !policy.allowedTasks.length) {
    problems.push({
      field: "allowedTasks",
      reason: "At least one allowed AI task is required.",
    });
  } else if (hasDuplicates(policy.allowedTasks)) {
    problems.push({
      field: "allowedTasks",
      reason: "Allowed AI tasks must not contain duplicates.",
    });
  } else if (policy.allowedTasks.some((task) => !KNOWN_TASKS.has(task))) {
    problems.push({
      field: "allowedTasks",
      reason: "Allowed AI tasks contain an unsupported operation.",
    });
  }

  if (!Array.isArray(policy.contentModes) || !policy.contentModes.length) {
    problems.push({
      field: "contentModes",
      reason: "At least one allowed content mode is required.",
    });
  } else if (hasDuplicates(policy.contentModes)) {
    problems.push({
      field: "contentModes",
      reason: "Allowed content modes must not contain duplicates.",
    });
  } else if (
    policy.contentModes.some((mode) => !KNOWN_CONTENT_MODES.has(mode))
  ) {
    problems.push({
      field: "contentModes",
      reason: "Content modes contain an unsupported value.",
    });
  }

  return problems;
}

export class AiExecutionPolicyError extends Error {
  constructor(
    public readonly code: AiExecutionPolicyFailureCode,
    message: string,
    public readonly connectionId: string,
  ) {
    super(message);
    this.name = "AiExecutionPolicyError";
  }
}

/**
 * Defines a validated policy. Omitting content modes deliberately produces a
 * standard-only connection: no provider or BYO source becomes adult-eligible
 * merely by being configured.
 */
export function defineAiExecutionConnectionPolicy(
  input: Omit<AiExecutionConnectionPolicy, "contentModes"> & {
    contentModes?: readonly AiExecutionContentMode[];
  },
): AiExecutionConnectionPolicy {
  const policy: AiExecutionConnectionPolicy = Object.freeze({
    ...input,
    allowedTasks: Object.freeze([...input.allowedTasks]),
    contentModes: Object.freeze([...(input.contentModes ?? STANDARD_ONLY)]),
  });
  const problems = validateAiExecutionConnectionPolicy(policy);
  if (problems.length) {
    throw new AiExecutionPolicyError(
      "INVALID_POLICY",
      problems
        .map((problem) => `${problem.field}: ${problem.reason}`)
        .join(" "),
      policy.connectionId,
    );
  }
  return policy;
}

function callerCanUseConnectionSource(
  connectionSource: AiConnectionSource,
  callerScope: AiCallerScope,
): boolean {
  if (connectionSource === "installation_byo") {
    return callerScope === "installation_owner";
  }
  if (connectionSource === "player_byo") {
    // The credential resolver must additionally prove that the authenticated
    // player owns this connection. This policy only rejects anonymous access.
    return callerScope !== "anonymous_demo";
  }
  return true;
}

/** Pure guard for one connection candidate. It never resolves a credential. */
export function evaluateAiExecutionPolicy(
  connection: AiExecutionConnectionPolicy,
  request: AiExecutionRequestPolicy,
): AiExecutionPolicyDecision {
  const problems = validateAiExecutionConnectionPolicy(connection);
  if (problems.length) {
    return {
      allowed: false,
      code: "INVALID_POLICY",
      reason: problems.map((problem) => problem.reason).join(" "),
    };
  }
  if (connection.billingSource !== request.billingSource) {
    return {
      allowed: false,
      code: "CROSS_FUNDING_FALLBACK",
      reason:
        "A fallback candidate cannot cross the request's funding boundary.",
    };
  }
  if (
    !callerCanUseConnectionSource(
      connection.connectionSource,
      request.callerScope,
    )
  ) {
    return {
      allowed: false,
      code: "CALLER_SCOPE_NOT_ALLOWED",
      reason:
        connection.connectionSource === "installation_byo"
          ? "An installation BYO connection is available only to the installation owner."
          : "A player BYO connection requires an authenticated owner.",
    };
  }
  if (!connection.allowedTasks.includes(request.task)) {
    return {
      allowed: false,
      code: "TASK_NOT_ALLOWED",
      reason: "This connection is not approved for the requested AI task.",
    };
  }
  if (!connection.contentModes.includes(request.contentMode)) {
    return {
      allowed: false,
      code: "CONTENT_MODE_NOT_ALLOWED",
      reason:
        request.contentMode === "adult"
          ? "Adult content requires an explicitly approved connection policy."
          : "This connection is not approved for the requested content mode.",
    };
  }
  return { allowed: true, code: null, reason: "allowed" };
}

export function assertAiExecutionAllowed(
  connection: AiExecutionConnectionPolicy,
  request: AiExecutionRequestPolicy,
): void {
  const decision = evaluateAiExecutionPolicy(connection, request);
  if (!decision.allowed) {
    throw new AiExecutionPolicyError(
      decision.code,
      decision.reason,
      connection.connectionId,
    );
  }
}

export type AiExecutionFallbackPlan = Readonly<{
  eligible: readonly AiExecutionConnectionPolicy[];
  rejected: readonly Readonly<{
    connection: AiExecutionConnectionPolicy;
    decision: Exclude<AiExecutionPolicyDecision, { allowed: true }>;
  }>[];
}>;

/**
 * Builds an ordered fallback chain without ever crossing the request's billing
 * source, task, caller, or content boundary.
 */
export function buildAiExecutionFallbackPlan(
  connections: readonly AiExecutionConnectionPolicy[],
  request: AiExecutionRequestPolicy,
): AiExecutionFallbackPlan {
  const eligible: AiExecutionConnectionPolicy[] = [];
  const rejected: Array<{
    connection: AiExecutionConnectionPolicy;
    decision: Exclude<AiExecutionPolicyDecision, { allowed: true }>;
  }> = [];
  for (const connection of connections) {
    const decision = evaluateAiExecutionPolicy(connection, request);
    if (decision.allowed) eligible.push(connection);
    else rejected.push({ connection, decision });
  }
  return Object.freeze({
    eligible: Object.freeze(eligible),
    rejected: Object.freeze(rejected),
  });
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  AiExecutionPolicyError,
  assertAiExecutionAllowed,
  buildAiExecutionFallbackPlan,
  defineAiExecutionConnectionPolicy,
  evaluateAiExecutionPolicy,
  validateAiExecutionConnectionPolicy,
  type AiExecutionConnectionPolicy,
  type AiExecutionRequestPolicy,
} from "./aiExecutionPolicy";

const managed = defineAiExecutionConnectionPolicy({
  connectionId: "storyhold-primary",
  connectionSource: "storyhold_managed",
  billingSource: "storyhold_credits",
  allowedTasks: ["demo_scene", "campaign_turn", "world_analysis"],
});

const installationByo = defineAiExecutionConnectionPolicy({
  connectionId: "desktop-openrouter",
  connectionSource: "installation_byo",
  billingSource: "external_provider",
  allowedTasks: ["campaign_turn", "world_analysis", "canon_review"],
});

const playerByo = defineAiExecutionConnectionPolicy({
  connectionId: "player-openrouter",
  connectionSource: "player_byo",
  billingSource: "external_provider",
  allowedTasks: ["campaign_turn"],
});

function request(
  input: Partial<AiExecutionRequestPolicy> = {},
): AiExecutionRequestPolicy {
  return {
    task: "campaign_turn",
    contentMode: "standard",
    callerScope: "authenticated_player",
    billingSource: "external_provider",
    ...input,
  };
}

test("managed and BYO connections require opposite billing ownership", () => {
  assert.throws(
    () =>
      defineAiExecutionConnectionPolicy({
        connectionId: "bad-managed",
        connectionSource: "storyhold_managed",
        billingSource: "external_provider",
        allowedTasks: ["campaign_turn"],
      }),
    (error) =>
      error instanceof AiExecutionPolicyError &&
      error.code === "INVALID_POLICY" &&
      /Storyhold-managed connections must use Storyhold credits/.test(
        error.message,
      ),
  );
  for (const connectionSource of ["installation_byo", "player_byo"] as const) {
    assert.throws(
      () =>
        defineAiExecutionConnectionPolicy({
          connectionId: `bad-${connectionSource}`,
          connectionSource,
          billingSource: "storyhold_credits",
          allowedTasks: ["campaign_turn"],
        }),
      (error) =>
        error instanceof AiExecutionPolicyError &&
        error.code === "INVALID_POLICY" &&
        /external provider/.test(error.message),
    );
  }
});

test("installation BYO is restricted to the installation owner", () => {
  for (const callerScope of [
    "anonymous_demo",
    "authenticated_player",
  ] as const) {
    const decision = evaluateAiExecutionPolicy(
      installationByo,
      request({ callerScope }),
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed)
      assert.equal(decision.code, "CALLER_SCOPE_NOT_ALLOWED");
  }
  assert.equal(
    evaluateAiExecutionPolicy(
      installationByo,
      request({ callerScope: "installation_owner" }),
    ).allowed,
    true,
  );
});

test("player BYO rejects anonymous use while leaving identity ownership to the resolver", () => {
  const anonymous = evaluateAiExecutionPolicy(
    playerByo,
    request({ callerScope: "anonymous_demo" }),
  );
  assert.equal(anonymous.allowed, false);
  if (!anonymous.allowed)
    assert.equal(anonymous.code, "CALLER_SCOPE_NOT_ALLOWED");
  assert.equal(evaluateAiExecutionPolicy(playerByo, request()).allowed, true);
});

test("content mode defaults to standard and adult use requires explicit approval", () => {
  assert.deepEqual(installationByo.contentModes, ["standard"]);
  const denied = evaluateAiExecutionPolicy(
    installationByo,
    request({
      callerScope: "installation_owner",
      contentMode: "adult",
    }),
  );
  assert.equal(denied.allowed, false);
  if (!denied.allowed) assert.equal(denied.code, "CONTENT_MODE_NOT_ALLOWED");

  const explicitlyAdult = defineAiExecutionConnectionPolicy({
    connectionId: "explicit-adult-connection",
    connectionSource: "installation_byo",
    billingSource: "external_provider",
    allowedTasks: ["campaign_turn"],
    contentModes: ["standard", "adult"],
  });
  assert.equal(
    evaluateAiExecutionPolicy(
      explicitlyAdult,
      request({ callerScope: "installation_owner", contentMode: "adult" }),
    ).allowed,
    true,
  );
});

test("task allowlists are enforced independently of provider and funding", () => {
  const decision = evaluateAiExecutionPolicy(
    installationByo,
    request({
      callerScope: "installation_owner",
      task: "demo_scene",
    }),
  );
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.code, "TASK_NOT_ALLOWED");
});

test("fallback planning never crosses the requested funding boundary", () => {
  const external = buildAiExecutionFallbackPlan(
    [managed, installationByo, playerByo],
    request({ callerScope: "installation_owner" }),
  );
  assert.deepEqual(
    external.eligible.map((connection) => connection.connectionId),
    ["desktop-openrouter", "player-openrouter"],
  );
  assert.equal(external.rejected.length, 1);
  assert.equal(
    external.rejected[0]?.connection.connectionId,
    "storyhold-primary",
  );
  assert.equal(external.rejected[0]?.decision.code, "CROSS_FUNDING_FALLBACK");

  const managedOnly = buildAiExecutionFallbackPlan(
    [installationByo, managed],
    request({
      callerScope: "anonymous_demo",
      task: "demo_scene",
      billingSource: "storyhold_credits",
    }),
  );
  assert.deepEqual(
    managedOnly.eligible.map((connection) => connection.connectionId),
    ["storyhold-primary"],
  );
  assert.equal(
    managedOnly.rejected[0]?.decision.code,
    "CROSS_FUNDING_FALLBACK",
  );
});

test("assert guard reports a stable failure code and non-secret connection id", () => {
  assert.throws(
    () =>
      assertAiExecutionAllowed(
        installationByo,
        request({ callerScope: "authenticated_player" }),
      ),
    (error) =>
      error instanceof AiExecutionPolicyError &&
      error.code === "CALLER_SCOPE_NOT_ALLOWED" &&
      error.connectionId === "desktop-openrouter",
  );
});

test("invalid policies fail closed even when callers bypass the defining helper", () => {
  const invalid = {
    connectionId: "",
    connectionSource: "player_byo",
    billingSource: "external_provider",
    allowedTasks: [],
    contentModes: [],
  } as AiExecutionConnectionPolicy;
  assert.deepEqual(
    validateAiExecutionConnectionPolicy(invalid).map(
      (problem) => problem.field,
    ),
    ["connectionId", "allowedTasks", "contentModes"],
  );
  const decision = evaluateAiExecutionPolicy(invalid, request());
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.code, "INVALID_POLICY");

  const unsupported = {
    ...playerByo,
    allowedTasks: ["unbounded_model_call"],
    contentModes: ["provider_default"],
  } as unknown as AiExecutionConnectionPolicy;
  assert.deepEqual(
    validateAiExecutionConnectionPolicy(unsupported).map(
      (problem) => problem.field,
    ),
    ["allowedTasks", "contentModes"],
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  AiGatewayUnavailableError,
  generateAiText,
  getAiRuntimeStatus,
  quoteAiCostReservation,
  type GenerateAiTextInput,
} from "./aiGateway";

const GATEWAY_ENV_NAMES = [
  "STORYHOLD_AI_PROVIDER",
  "STORYHOLD_AI_FALLBACKS",
  "STORYHOLD_ADULT_PROVIDER",
  "STORYHOLD_EXTRACTION_PROVIDER",
  "STORYHOLD_VERIFICATION_PROVIDER",
  "STORYHOLD_DOSSIER_PROVIDER",
  "STORYHOLD_CHRONOLOGY_PROVIDER",
  "STORYHOLD_DIRECTOR_PROVIDER",
  "STORYHOLD_NARRATOR_PROVIDER",
  "STORYHOLD_ADAPTATION_PROVIDER",
  "STORYHOLD_ANALYSIS_PROVIDER",
  "STORYHOLD_CANON_PROVIDER",
  "STORYHOLD_ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY",
  "AI_INTEGRATIONS_ANTHROPIC_API_KEY",
  "STORYHOLD_ANTHROPIC_BASE_URL",
  "AI_INTEGRATIONS_ANTHROPIC_BASE_URL",
  "STORYHOLD_OPENAI_API_KEY",
  "STORYHOLD_OPENAI_CHAT_URL",
  "OPENAI_API_KEY",
  "STORYHOLD_XAI_API_KEY",
  "STORYHOLD_XAI_CHAT_URL",
  "XAI_API_KEY",
  "STORYHOLD_KIMI_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "STORYHOLD_OPENROUTER_API_KEY",
  "OPENROUTER_API_KEY",
  "STORYHOLD_OPENROUTER_CHAT_URL",
  "STORYHOLD_OPENROUTER_MODEL",
  "STORYHOLD_OPENROUTER_EXTRACTION_MODEL",
  "STORYHOLD_OPENROUTER_VERIFICATION_MODEL",
  "STORYHOLD_OPENROUTER_DOSSIER_MODEL",
  "STORYHOLD_OPENROUTER_CHRONOLOGY_MODEL",
  "STORYHOLD_OPENROUTER_DIRECTOR_MODEL",
  "STORYHOLD_OPENROUTER_NARRATION_MODEL",
  "STORYHOLD_OPENROUTER_ADAPTATION_MODEL",
  "STORYHOLD_OPENROUTER_ADULT_ENABLED",
  "STORYHOLD_OPENROUTER_ADULT_MODEL",
] as const;

async function withGatewayEnvironment(run: () => Promise<void> | void) {
  const previous = new Map(
    GATEWAY_ENV_NAMES.map((name) => [name, process.env[name]]),
  );
  try {
    for (const name of GATEWAY_ENV_NAMES) delete process.env[name];
    await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const singleAttemptInput: GenerateAiTextInput = {
  task: "canon_review",
  stage: "verification",
  system: "Verify evidence.",
  messages: [{ role: "user", content: "A claim and its citations." }],
  allowProviderFallback: false,
};

function configureDirectFallbacks() {
  process.env.STORYHOLD_VERIFICATION_PROVIDER = "openai";
  process.env.STORYHOLD_AI_FALLBACKS = "xai";
  process.env.STORYHOLD_OPENAI_API_KEY = "test-openai-key";
  process.env.STORYHOLD_XAI_API_KEY = "test-xai-key";
  process.env.STORYHOLD_OPENAI_CHAT_URL = "https://openai.invalid/chat";
  process.env.STORYHOLD_XAI_CHAT_URL = "https://xai.invalid/chat";
}

function compatibleSuccess(text = "Verified evidence") {
  return new Response(JSON.stringify({
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

for (const failure of [
  "transport error",
  "non-Error transport failure",
  "HTTP error",
  "invalid JSON",
  "empty response",
  "validation failure",
] as const) {
  test(`single-attempt direct execution does not retry or fall back after ${failure}`, async () => {
    await withGatewayEnvironment(async () => {
      configureDirectFallbacks();
      const originalFetch = globalThis.fetch;
      const urls: string[] = [];
      globalThis.fetch = async (input) => {
        urls.push(String(input));
        if (failure === "transport error") throw new TypeError("fetch failed");
        if (failure === "non-Error transport failure") throw "unknown completion status";
        if (failure === "HTTP error") return new Response("unavailable", { status: 503 });
        if (failure === "invalid JSON") return new Response("not JSON", { status: 200 });
        return compatibleSuccess(failure === "empty response" ? "" : "Verified evidence");
      };
      try {
        const quote = quoteAiCostReservation(singleAttemptInput);
        assert.deepEqual(quote.candidates.map((candidate) => candidate.provider), ["openai"]);
        await assert.rejects(
          generateAiText({
            ...singleAttemptInput,
            validate: failure === "validation failure"
              ? () => { throw new Error("Schema validation failed."); }
              : undefined,
          }),
          (error: unknown) => {
            assert.ok(error instanceof AiGatewayUnavailableError);
            assert.equal(error.attempts.length, 1);
            assert.match(error.attempts[0] ?? "", /^openai:/u);
            const billable = failure === "empty response" || failure === "validation failure";
            assert.equal(error.billableAttempts.length, billable ? 1 : 0);
            if (billable) {
              assert.equal(error.billableAttempts[0]?.provider, "openai");
              assert.equal(error.billableAttempts[0]?.usage.inputUnits, 10);
              assert.equal(error.billableAttempts[0]?.usage.outputUnits, 2);
            }
            return true;
          },
        );
        assert.deepEqual(urls, ["https://openai.invalid/chat"]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
}

for (const failure of ["HTTP error", "transport error"] as const) {
  test(`single-attempt Anthropic execution disables SDK retries after ${failure}`, async () => {
    await withGatewayEnvironment(async () => {
      configureDirectFallbacks();
      process.env.STORYHOLD_VERIFICATION_PROVIDER = "anthropic";
      process.env.STORYHOLD_ANTHROPIC_API_KEY = "test-anthropic-key";
      process.env.STORYHOLD_ANTHROPIC_BASE_URL = "https://anthropic.invalid";
      const originalFetch = globalThis.fetch;
      const urls: string[] = [];
      globalThis.fetch = async (input) => {
        urls.push(String(input));
        if (failure === "transport error") throw new TypeError("fetch failed");
        return new Response(JSON.stringify({
          type: "error", error: { type: "overloaded_error", message: "unavailable" },
        }), {
          status: 503,
          headers: { "content-type": "application/json", "retry-after": "0" },
        });
      };
      try {
        await assert.rejects(generateAiText(singleAttemptInput), (error: unknown) => {
          assert.ok(error instanceof AiGatewayUnavailableError);
          assert.equal(error.attempts.length, 1);
          assert.match(error.attempts[0] ?? "", /^anthropic:/u);
          assert.deepEqual(error.billableAttempts, []);
          return true;
        });
        assert.deepEqual(urls, ["https://anthropic.invalid/v1/messages"]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
}

for (const allowProviderFallback of [undefined, true]) {
  test(`direct-provider fallback remains enabled when the option is ${String(allowProviderFallback)}`, async () => {
    await withGatewayEnvironment(async () => {
      configureDirectFallbacks();
      const originalFetch = globalThis.fetch;
      const urls: string[] = [];
      globalThis.fetch = async (input) => {
        urls.push(String(input));
        return urls.length === 1
          ? new Response("unavailable", { status: 503 })
          : compatibleSuccess();
      };
      try {
        const input = { ...singleAttemptInput, allowProviderFallback };
        assert.deepEqual(
          quoteAiCostReservation(input).candidates.map((candidate) => candidate.provider),
          ["openai", "xai"],
        );
        const result = await generateAiText(input);
        assert.equal(result.provider, "xai");
        assert.equal(result.text, "Verified evidence");
        assert.deepEqual(urls, ["https://openai.invalid/chat", "https://xai.invalid/chat"]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
}

test("single-attempt execution uses the first configured provider when a preferred provider is missing", async () => {
  await withGatewayEnvironment(async () => {
    configureDirectFallbacks();
    delete process.env.STORYHOLD_OPENAI_API_KEY;
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = async (input) => {
      urls.push(String(input));
      return compatibleSuccess();
    };
    try {
      const result = await generateAiText(singleAttemptInput);
      assert.equal(result.provider, "xai");
      assert.deepEqual(result.priorBillableAttempts, []);
      assert.deepEqual(urls, ["https://xai.invalid/chat"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("managed Anthropic reservation and execution use the same required output cap", async () => {
  await withGatewayEnvironment(async () => {
    process.env.STORYHOLD_VERIFICATION_PROVIDER = "anthropic";
    process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY = "managed-test-key";
    process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL = "https://anthropic-managed.invalid";
    const input: GenerateAiTextInput = {
      ...singleAttemptInput,
      maxOutputTokens: 200,
    };
    const quote = quoteAiCostReservation(input);
    assert.equal(quote.maxOutputUnits, 8_192);
    assert.equal(quote.candidates[0]?.provider, "anthropic");
    assert.equal(quote.pricingKnown, true);
    assert.ok(quote.maximumCostMicros > 0);

    const originalFetch = globalThis.fetch;
    let executionCap = 0;
    globalThis.fetch = async (request, init) => {
      const body = request instanceof Request
        ? await request.clone().json() as { max_tokens?: number }
        : JSON.parse(String(init?.body)) as { max_tokens?: number };
      executionCap = Number(body.max_tokens);
      return new Response(JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "Verified evidence" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const result = await generateAiText(input);
      assert.equal(executionCap, quote.maxOutputUnits);
      assert.equal(result.usage.pricingKnown, true);
      assert.ok(result.usage.estimatedCostMicros > 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("an OpenRouter key alone does not enter automatic or demo routing", async () => {
  await withGatewayEnvironment(() => {
    process.env.STORYHOLD_OPENROUTER_API_KEY = "test-openrouter-key";
    process.env.STORYHOLD_AI_FALLBACKS = "openrouter";

    const analysis = getAiRuntimeStatus("world_analysis");
    const demo = getAiRuntimeStatus("demo_scene");

    assert.equal(analysis.configured, false);
    assert.equal(analysis.stage, "extraction");
    assert.equal(analysis.stageRouting.extraction, null);
    assert.equal(demo.configured, false);
    assert.equal(demo.stageRouting.narration, null);
    assert.equal(
      analysis.providers.find((provider) => provider.id === "openrouter")
        ?.configured,
      true,
    );
  });
});

test("an explicitly managed verifier stays inert without its OpenRouter key", async () => {
  await withGatewayEnvironment(async () => {
    process.env.STORYHOLD_VERIFICATION_PROVIDER = "openrouter";
    process.env.STORYHOLD_OPENROUTER_VERIFICATION_MODEL = "openrouter/auto";
    process.env.OPENROUTER_API_KEY = "ambient-developer-key";
    // Even another direct provider must not inherit this private manuscript lane.
    process.env.STORYHOLD_OPENAI_API_KEY = "unrelated-direct-key";

    const runtime = getAiRuntimeStatus("canon_review");
    assert.equal(runtime.configured, false);
    assert.equal(runtime.stage, "verification");
    assert.equal(runtime.stageRouting.verification, null);
    assert.equal(runtime.execution, null);

    const quote = quoteAiCostReservation({
      task: "canon_review",
      stage: "verification",
      system: "Verify evidence.",
      messages: [{ role: "user", content: "A claim and its citations." }],
    });
    assert.deepEqual(quote.candidates, []);
    await assert.rejects(
      generateAiText({
        task: "canon_review",
        stage: "verification",
        system: "Verify evidence.",
        messages: [{ role: "user", content: "A claim and its citations." }],
      }),
      (error: unknown) => {
        assert.ok(error instanceof AiGatewayUnavailableError);
        assert.match(error.message, /No model provider is configured/u);
        assert.deepEqual(error.attempts, []);
        return true;
      },
    );
  });
});

test("OpenRouter rejects auto and latest aliases before routing", async () => {
  await withGatewayEnvironment(() => {
    process.env.STORYHOLD_OPENROUTER_API_KEY = "test-openrouter-key";
    process.env.STORYHOLD_EXTRACTION_PROVIDER = "openrouter";

    process.env.STORYHOLD_OPENROUTER_EXTRACTION_MODEL = "openrouter/auto";
    assert.equal(getAiRuntimeStatus("world_analysis").configured, false);

    process.env.STORYHOLD_OPENROUTER_EXTRACTION_MODEL =
      "anthropic/claude-sonnet-latest";
    assert.equal(getAiRuntimeStatus("world_analysis").configured, false);
  });
});

test("explicit stages select fixed, auditable OpenRouter models", async () => {
  await withGatewayEnvironment(() => {
    process.env.STORYHOLD_OPENROUTER_API_KEY = "test-openrouter-key";
    process.env.STORYHOLD_EXTRACTION_PROVIDER = "openrouter";
    process.env.STORYHOLD_VERIFICATION_PROVIDER = "openrouter";
    process.env.STORYHOLD_OPENROUTER_VERIFICATION_MODEL = "openrouter/auto";
    process.env.STORYHOLD_DOSSIER_PROVIDER = "openrouter";
    process.env.STORYHOLD_CHRONOLOGY_PROVIDER = "openrouter";

    const extraction = getAiRuntimeStatus("world_analysis");
    const verification = getAiRuntimeStatus("canon_review");
    const dossier = getAiRuntimeStatus("canon_review", "standard", "dossier");

    assert.equal(extraction.provider, "openrouter");
    assert.equal(extraction.stage, "extraction");
    assert.equal(extraction.model, "mistralai/mistral-small-2603");
    assert.equal(verification.stage, "verification");
    assert.equal(verification.model, "openai/gpt-5.6-luna-pro");
    assert.equal(
      verification.providers.find((provider) => provider.id === "openrouter")
        ?.supportsReasoningControl,
      true,
    );
    assert.equal(dossier.stage, "dossier");
    assert.equal(dossier.model, "anthropic/claude-sonnet-4.6");
    assert.equal(extraction.stageRouting.chronology, "openrouter");
    assert.equal(
      getAiRuntimeStatus("canon_review", "standard", "chronology").model,
      "qwen/qwen3.5-397b-a17b-20260216",
    );
    assert.deepEqual(extraction.execution, {
      connectionId: "managed:openrouter",
      credentialSource: "environment",
      connectionSource: "storyhold_managed",
      billingSource: "storyhold_credits",
      requestedModel: "mistralai/mistral-small-2603",
      resolvedModel: null,
      upstreamProvider: null,
      privacyMode: "zero-data-retention",
    });

    const quote = quoteAiCostReservation({
      task: "world_analysis",
      stage: "extraction",
      system: "Extract evidence.",
      messages: [{ role: "user", content: "A short manuscript passage." }],
      maxOutputTokens: 100,
    });
    assert.equal(quote.candidates[0]?.provider, "openrouter");
    assert.equal(quote.candidates[0]?.model, "mistralai/mistral-small-2603");
    assert.equal(quote.pricingKnown, true);
    assert.ok(quote.maximumCostMicros > 0);
  });
});

test("managed verification enforces OpenRouter privacy routing and reports execution", async () => {
  await withGatewayEnvironment(async () => {
    process.env.STORYHOLD_OPENROUTER_API_KEY = "test-openrouter-key";
    process.env.STORYHOLD_VERIFICATION_PROVIDER = "openrouter";
    process.env.STORYHOLD_OPENROUTER_CHAT_URL =
      "https://untrusted.invalid/chat/completions";
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(
        JSON.stringify({
          model: "openai/gpt-5.6-luna-pro",
          provider: "OpenAI",
          choices: [{ message: { content: "Verified evidence" } }],
          usage: {
            prompt_tokens: 1_000,
            completion_tokens: 100,
            cost: "0.00125",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    try {
      const result = await generateAiText({
        task: "canon_review",
        stage: "verification",
        system: "Verify evidence.",
        messages: [{ role: "user", content: "Claims and cited evidence" }],
        maxOutputTokens: 200,
      });

      assert.equal(
        capturedUrl,
        "https://openrouter.ai/api/v1/chat/completions",
      );
      const headers = new Headers(capturedInit?.headers);
      assert.equal(headers.get("authorization"), "Bearer test-openrouter-key");
      assert.equal(headers.get("http-referer"), "https://storyhold.com");
      assert.equal(headers.get("x-title"), "Storyhold");
      assert.equal(headers.get("x-openrouter-metadata"), "enabled");
      const body = JSON.parse(String(capturedInit?.body)) as {
        model: string;
        max_tokens: number;
        provider: {
          require_parameters: boolean;
          data_collection: string;
          zdr: boolean;
        };
        response_format: { type: string };
        reasoning: { effort: string };
      };
      assert.equal(body.model, "openai/gpt-5.6-luna-pro");
      assert.equal(body.max_tokens, 200);
      assert.deepEqual(body.provider, {
        require_parameters: true,
        data_collection: "deny",
        zdr: true,
      });
      assert.deepEqual(body.response_format, { type: "json_object" });
      assert.deepEqual(body.reasoning, { effort: "high" });
      assert.equal(result.runtime.model, "openai/gpt-5.6-luna-pro");
      assert.deepEqual(result.runtime.execution, {
        connectionId: "managed:openrouter",
        credentialSource: "environment",
        connectionSource: "storyhold_managed",
        billingSource: "storyhold_credits",
        requestedModel: "openai/gpt-5.6-luna-pro",
        resolvedModel: "openai/gpt-5.6-luna-pro",
        upstreamProvider: "OpenAI",
        privacyMode: "zero-data-retention",
      });
      assert.equal(result.usage.estimatedCostMicros, 1_250);
      assert.equal(result.usage.pricingKnown, true);
      assert.equal(result.usage.costEstimated, false);
      assert.equal(
        result.usage.pricingVersion,
        "openrouter-reported-2026-09-05",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("single-attempt OpenRouter execution also disables upstream routing fallbacks", async () => {
  await withGatewayEnvironment(async () => {
    process.env.STORYHOLD_OPENROUTER_API_KEY = "test-openrouter-key";
    process.env.STORYHOLD_VERIFICATION_PROVIDER = "openrouter";
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({
        model: "openai/gpt-5.6-luna-pro",
        provider: "OpenAI",
        choices: [{ message: { content: "Verified evidence" } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.00001 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const result = await generateAiText(singleAttemptInput);
      assert.equal(result.provider, "openrouter");
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.url, "https://openrouter.ai/api/v1/chat/completions");
      assert.deepEqual(requests[0]?.body.provider, {
        require_parameters: true,
        data_collection: "deny",
        zdr: true,
        allow_fallbacks: false,
      });
      assert.equal(requests[0]?.body.model, "openai/gpt-5.6-luna-pro");
      assert.deepEqual(requests[0]?.body.response_format, { type: "json_object" });
      assert.deepEqual(requests[0]?.body.reasoning, { effort: "high" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("managed verification fails closed when OpenRouter reports model drift", async () => {
  await withGatewayEnvironment(async () => {
    process.env.STORYHOLD_OPENROUTER_API_KEY = "test-openrouter-key";
    process.env.STORYHOLD_VERIFICATION_PROVIDER = "openrouter";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          model: "openrouter/auto",
          provider: "Unexpected Provider",
          choices: [{ message: { content: "{}" } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.00001 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    try {
      await assert.rejects(
        generateAiText({
          task: "canon_review",
          stage: "verification",
          system: "Verify evidence.",
          messages: [{ role: "user", content: "Claim and evidence." }],
        }),
        (error: unknown) => {
          assert.ok(error instanceof AiGatewayUnavailableError);
          assert.equal(error.attempts.length, 1);
          assert.match(error.attempts[0] ?? "", /unexpected model/u);
          assert.equal(error.billableAttempts.length, 1);
          assert.equal(
            error.billableAttempts[0]?.resolvedModel,
            "openrouter/auto",
          );
          assert.equal(
            error.billableAttempts[0]?.usage.estimatedCostMicros,
            10,
          );
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("billable responses rejected by Storyhold retain their reported usage", async () => {
  await withGatewayEnvironment(async () => {
    process.env.STORYHOLD_OPENROUTER_API_KEY = "test-openrouter-key";
    process.env.STORYHOLD_VERIFICATION_PROVIDER = "openrouter";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          model: "openai/gpt-5.6-luna-pro",
          provider: "OpenAI",
          choices: [{ message: { content: "not the required object" } }],
          usage: {
            prompt_tokens: 2_000,
            completion_tokens: 50,
            cost: "0.00046",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    try {
      await assert.rejects(
        generateAiText({
          task: "canon_review",
          stage: "verification",
          system: "Verify evidence.",
          messages: [{ role: "user", content: "Claim and evidence." }],
          validate: () => {
            throw new Error("Schema validation failed.");
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof AiGatewayUnavailableError);
          assert.match(error.attempts[0] ?? "", /schema validation failed/i);
          assert.equal(error.billableAttempts.length, 1);
          assert.equal(error.billableAttempts[0]?.provider, "openrouter");
          assert.equal(
            error.billableAttempts[0]?.usage.estimatedCostMicros,
            460,
          );
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("OpenRouter adult routing is approved explicitly and never falls back", async () => {
  await withGatewayEnvironment(async () => {
    process.env.STORYHOLD_OPENROUTER_API_KEY = "test-openrouter-key";
    process.env.STORYHOLD_XAI_API_KEY = "test-xai-key";
    process.env.STORYHOLD_ADULT_PROVIDER = "openrouter";
    process.env.STORYHOLD_OPENROUTER_ADULT_MODEL = "x-ai/grok-4.5";

    assert.equal(
      getAiRuntimeStatus("campaign_narration", "adult").configured,
      false,
    );

    delete process.env.STORYHOLD_OPENROUTER_ADULT_MODEL;
    process.env.STORYHOLD_OPENROUTER_ADULT_ENABLED = "true";
    assert.equal(
      getAiRuntimeStatus("campaign_narration", "adult").configured,
      false,
    );

    process.env.STORYHOLD_OPENROUTER_ADULT_MODEL = "x-ai/grok-4.5";
    assert.equal(
      getAiRuntimeStatus("campaign_narration", "adult").provider,
      "openrouter",
    );

    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response("provider unavailable", { status: 503 });
    };
    try {
      await assert.rejects(
        generateAiText({
          task: "campaign_narration",
          system: "Narrate.",
          messages: [{ role: "user", content: "Continue." }],
          contentMode: "adult",
        }),
        (error: unknown) => {
          assert.ok(error instanceof AiGatewayUnavailableError);
          assert.equal(error.attempts.length, 1);
          assert.match(error.attempts[0] ?? "", /^openrouter:/);
          return true;
        },
      );
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("adult narration has no implicit provider even when xAI is connected", async () => {
  await withGatewayEnvironment(() => {
    process.env.STORYHOLD_XAI_API_KEY = "test-xai-key";
    const runtime = getAiRuntimeStatus("campaign_narration", "adult");
    assert.equal(runtime.configured, false);
    assert.equal(runtime.routing.adultNarration, null);
  });
});

test("provider failures do not echo an upstream response body", async () => {
  await withGatewayEnvironment(async () => {
    process.env.STORYHOLD_OPENROUTER_API_KEY = "test-openrouter-key";
    process.env.STORYHOLD_EXTRACTION_PROVIDER = "openrouter";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("account detail that must not be retained", {
        status: 429,
        headers: { "x-request-id": "request-safe-123" },
      });
    try {
      await assert.rejects(
        generateAiText({
          task: "world_analysis",
          stage: "extraction",
          system: "Extract.",
          messages: [{ role: "user", content: "Evidence." }],
        }),
        (error: unknown) => {
          assert.ok(error instanceof AiGatewayUnavailableError);
          assert.match(error.attempts[0] ?? "", /request-safe-123/u);
          assert.doesNotMatch(
            error.attempts.join("\n"),
            /account detail that must not be retained/u,
          );
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

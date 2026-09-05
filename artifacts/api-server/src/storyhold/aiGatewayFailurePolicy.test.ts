import assert from "node:assert/strict";
import test from "node:test";
import {
  AiGatewayUnavailableError,
  generateAiText,
  type GenerateAiTextInput,
} from "./aiGateway";

const input: GenerateAiTextInput = {
  task: "canon_review",
  stage: "dossier",
  system: "Review a fictional character using cited evidence.",
  messages: [{ role: "user", content: "A character and supporting passages." }],
  providerFailurePolicy: "stop",
};

function completedResponse(text = "Reviewed character") {
  return new Response(JSON.stringify({
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 15, completion_tokens: 5 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

async function withFakeProviders(
  response: (attempt: number) => Response | Promise<Response>,
  run: (urls: string[]) => Promise<void>,
) {
  const environmentKeys = Object.keys(process.env).filter((name) =>
    /^(?:STORYHOLD_|AI_INTEGRATIONS_|ANTHROPIC_API_KEY$|OPENAI_API_KEY$|XAI_API_KEY$|KIMI_API_KEY$|MOONSHOT_API_KEY$|OPENROUTER_API_KEY$)/u.test(name),
  );
  const configuredKeys = [
    "STORYHOLD_DOSSIER_PROVIDER", "STORYHOLD_AI_FALLBACKS",
    "STORYHOLD_OPENAI_API_KEY", "STORYHOLD_XAI_API_KEY",
    "STORYHOLD_OPENAI_CHAT_URL", "STORYHOLD_XAI_CHAT_URL",
  ];
  const previous = new Map([...new Set([...environmentKeys, ...configuredKeys])]
    .map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  try {
    for (const name of previous.keys()) delete process.env[name];
    process.env.STORYHOLD_DOSSIER_PROVIDER = "openai";
    process.env.STORYHOLD_AI_FALLBACKS = "xai";
    process.env.STORYHOLD_OPENAI_API_KEY = "fake-test-key";
    process.env.STORYHOLD_XAI_API_KEY = "fake-test-key";
    process.env.STORYHOLD_OPENAI_CHAT_URL = "https://primary.invalid/chat";
    process.env.STORYHOLD_XAI_CHAT_URL = "https://fallback.invalid/chat";
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return response(urls.length);
    };
    await run(urls);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

for (const failure of ["invalid content", "empty content"] as const) {
  test(`stop policy retains known billable ${failure} without a fallback call`, async () => {
    await withFakeProviders(
      () => completedResponse(failure === "empty content" ? "" : "invalid"),
      async (urls) => {
        await assert.rejects(generateAiText({
          ...input,
          validate: () => { throw new Error("Invalid dossier result."); },
        }), (error: unknown) => {
          assert.ok(error instanceof AiGatewayUnavailableError);
          assert.equal(error.hasUncertainOutcome, false);
          assert.equal(error.attempts.length, 1);
          assert.equal(error.billableAttempts.length, 1);
          assert.equal(error.billableAttempts[0]?.provider, "openai");
          assert.equal(error.billableAttempts[0]?.usage.inputUnits, 15);
          assert.equal(error.billableAttempts[0]?.usage.outputUnits, 5);
          return true;
        });
        assert.deepEqual(urls, ["https://primary.invalid/chat"]);
      },
    );
  });
}

for (const failure of ["network", "HTTP", "JSON", "response body"] as const) {
  test(`stop policy marks a ${failure} failure as uncertain and does not fall back`, async () => {
    await withFakeProviders(() => {
      if (failure === "network") throw new TypeError("Request outcome unknown.");
      if (failure === "HTTP") return new Response("unavailable", { status: 503 });
      if (failure === "JSON") return new Response("invalid JSON", { status: 200 });
      const response = completedResponse();
      response.text = async () => { throw new TypeError("Response body interrupted."); };
      return response;
    }, async (urls) => {
      await assert.rejects(generateAiText(input), (error: unknown) => {
        assert.ok(error instanceof AiGatewayUnavailableError);
        assert.equal(error.hasUncertainOutcome, true);
        assert.equal(error.attempts.length, 1);
        assert.deepEqual(error.billableAttempts, []);
        return true;
      });
      assert.deepEqual(urls, ["https://primary.invalid/chat"]);
    });
  });
}

test("default fallback preserves known failed usage but marks a later lost outcome uncertain", async () => {
  await withFakeProviders((attempt) => {
    if (attempt === 2) throw new TypeError("Fallback response lost.");
    return completedResponse("invalid");
  }, async (urls) => {
    await assert.rejects(generateAiText({
      ...input,
      providerFailurePolicy: undefined,
      validate: () => { throw new Error("Invalid dossier result."); },
    }), (error: unknown) => {
      assert.ok(error instanceof AiGatewayUnavailableError);
      assert.equal(error.hasUncertainOutcome, true);
      assert.equal(error.attempts.length, 2);
      assert.equal(error.billableAttempts.length, 1);
      assert.equal(error.billableAttempts[0]?.provider, "openai");
      return true;
    });
    assert.deepEqual(urls, ["https://primary.invalid/chat", "https://fallback.invalid/chat"]);
  });
});

test("default fallback reports all completed invalid results without inventing an unknown outcome", async () => {
  await withFakeProviders(() => completedResponse("invalid"), async (urls) => {
    await assert.rejects(generateAiText({
      ...input,
      providerFailurePolicy: undefined,
      validate: () => { throw new Error("Invalid dossier result."); },
    }), (error: unknown) => {
      assert.ok(error instanceof AiGatewayUnavailableError);
      assert.equal(error.hasUncertainOutcome, false);
      assert.equal(error.attempts.length, 2);
      assert.equal(error.billableAttempts.length, 2);
      return true;
    });
    assert.equal(urls.length, 2);
  });
});

test("default fallback can still succeed after a failed first provider", async () => {
  await withFakeProviders((attempt) => attempt === 1
    ? new Response("unavailable", { status: 503 })
    : completedResponse(), async (urls) => {
    const result = await generateAiText({ ...input, providerFailurePolicy: undefined });
    assert.equal(result.provider, "xai");
    assert.equal(result.text, "Reviewed character");
    assert.equal(urls.length, 2);
  });
});

test("stop policy preserves a successful first result", async () => {
  await withFakeProviders(() => completedResponse(), async (urls) => {
    const result = await generateAiText(input);
    assert.equal(result.provider, "openai");
    assert.equal(result.text, "Reviewed character");
    assert.equal(result.usage.inputUnits, 15);
    assert.equal(urls.length, 1);
  });
});

test("legacy gateway errors do not assert that every possible charge is known", () => {
  const error = new AiGatewayUnavailableError("Historical failure", [], []);
  assert.equal(error.hasUncertainOutcome, undefined);
});

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import {
  searchWithFallback,
  researchWithFallback,
  structuredChatWithFallback,
  isResearchCapabilityAvailable,
  extractBalancedJson,
  _resetResearchFallbackState,
  _getResearchFallbackState,
  type ResearchFallbackDeps,
} from "./researchFallback";
import {
  PerplexityApiError,
  PerplexityNotConfiguredError,
  type SearchLead,
} from "./perplexity";

// --- Helpers -----------------------------------------------------------------

function fakeMessage(opts: {
  text?: string;
  searches?: number;
  resultUrls?: string[];
}): Anthropic.Messages.Message {
  const content: unknown[] = [];
  for (let i = 0; i < (opts.searches ?? 0); i++) {
    content.push({ type: "server_tool_use", id: `t${i}`, name: "web_search", input: {} });
    content.push({
      type: "web_search_tool_result",
      tool_use_id: `t${i}`,
      content: (opts.resultUrls ?? []).map((url) => ({
        type: "web_search_result",
        url,
        title: "r",
        encrypted_content: "",
        page_age: null,
      })),
    });
  }
  if (opts.text !== undefined) content.push({ type: "text", text: opts.text });
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  } as unknown as Anthropic.Messages.Message;
}

const LEAD: SearchLead = {
  title: "t",
  url: "https://example.gov/a",
  snippet: "s",
  date: null,
  domain: "example.gov",
  role: "evidence",
  tier: "primary",
  roleReason: "gov",
  platform: null,
};

function baseDeps(overrides?: Partial<ResearchFallbackDeps>): Partial<ResearchFallbackDeps> {
  return {
    perplexitySearch: async () => [LEAD],
    perplexitySonarResearch: async () => ({ content: "px", citations: ["https://a.gov"], model: "sonar" }),
    perplexityStructuredChat: (async () => ({ ok: true })) as ResearchFallbackDeps["perplexityStructuredChat"],
    createMessage: async () =>
      fakeMessage({
        text: '[{"title":"F","url":"https://fallback.gov/x","snippet":"fb","date":"2026-07-01"}]',
        searches: 1,
        resultUrls: ["https://fallback.gov/x"],
      }),
    resolveModel: async () => "claude-haiku-4-5",
    resolveDirective: async () => "directive",
    isFallbackEnabled: async () => true,
    isPerplexityConfigured: () => true,
    isAnthropicConfigured: () => true,
    recordUsage: () => {},
    now: () => 1_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  _resetResearchFallbackState();
});

// --- extractBalancedJson ------------------------------------------------------

test("extractBalancedJson: plain object", () => {
  assert.deepEqual(extractBalancedJson('{"a":1}'), { a: 1 });
});

test("extractBalancedJson: JSON wrapped in prose and fences", () => {
  const out = extractBalancedJson<{ a: number[] }>(
    'Sure! Here is the JSON:\n```json\n{"a":[1,2,{"b":"}"}]}\n```\nHope that helps.',
  );
  assert.deepEqual(out, { a: [1, 2, { b: "}" }] });
});

test("extractBalancedJson: array with nested objects and bracket-in-string", () => {
  const out = extractBalancedJson<unknown[]>('noise [ {"u":"https://x.y/[1]"} , [2] ] tail');
  assert.deepEqual(out, [{ u: "https://x.y/[1]" }, [2]]);
});

test("extractBalancedJson: throws on no JSON and on unbalanced", () => {
  assert.throws(() => extractBalancedJson("no json here"));
  assert.throws(() => extractBalancedJson('{"a": [1, 2'));
});

// --- Perplexity-healthy passthrough ------------------------------------------

test("search: healthy Perplexity result passes through untouched, fallback never called", async () => {
  let fallbackCalled = false;
  const leads = await searchWithFallback("q", {
    deps: baseDeps({
      createMessage: async () => {
        fallbackCalled = true;
        return fakeMessage({ text: "[]" });
      },
    }),
  });
  assert.deepEqual(leads, [LEAD]);
  assert.equal(fallbackCalled, false);
  assert.equal(_getResearchFallbackState().consecutiveFailures, 0);
});

// --- Fallback on not-configured / API error ----------------------------------

test("search: falls back on PerplexityNotConfiguredError and adapts leads", async () => {
  const leads = await searchWithFallback("q", {
    deps: baseDeps({ isPerplexityConfigured: () => false }),
  });
  assert.equal(leads.length, 1);
  assert.equal(leads[0]!.url, "https://fallback.gov/x");
  assert.equal(leads[0]!.domain, "fallback.gov");
  assert.equal(leads[0]!.date, "2026-07-01");
  assert.ok(["evidence", "trend_marker", "rejected_junk"].includes(leads[0]!.role));
});

test("search: falls back on PerplexityApiError (transient failure counted)", async () => {
  const leads = await searchWithFallback("q", {
    deps: baseDeps({
      perplexitySearch: async () => {
        throw new PerplexityApiError("HTTP 500");
      },
    }),
  });
  assert.equal(leads.length, 1);
  assert.equal(_getResearchFallbackState().consecutiveFailures, 1);
});

test("non-Perplexity errors are rethrown, never trigger fallback", async () => {
  await assert.rejects(
    searchWithFallback("q", {
      deps: baseDeps({
        perplexitySearch: async () => {
          throw new TypeError("bug in caller");
        },
      }),
    }),
    TypeError,
  );
});

// --- Fail-closed: no web search performed ------------------------------------

test("search: fails CLOSED (rethrows original error) when fallback model skipped web search", async () => {
  await assert.rejects(
    searchWithFallback("q", {
      deps: baseDeps({
        isPerplexityConfigured: () => false,
        createMessage: async () =>
          fakeMessage({ text: '[{"title":"m","url":"https://memory.com/x","snippet":""}]', searches: 0 }),
      }),
    }),
    PerplexityNotConfiguredError,
  );
});

test("research: fails closed without a search; succeeds with one", async () => {
  const deps = baseDeps({
    perplexitySonarResearch: async () => {
      throw new PerplexityApiError("timeout");
    },
    createMessage: async () =>
      fakeMessage({ text: "briefing", searches: 1, resultUrls: ["https://cited.gov/a"] }),
  });
  const res = await researchWithFallback("sys", "user", { deps });
  assert.equal(res.content, "briefing");
  assert.deepEqual(res.citations, ["https://cited.gov/a"]);
  assert.equal(res.model, "claude-haiku-4-5");

  _resetResearchFallbackState();
  await assert.rejects(
    researchWithFallback("sys", "user", {
      deps: baseDeps({
        perplexitySonarResearch: async () => {
          throw new PerplexityApiError("timeout");
        },
        createMessage: async () => fakeMessage({ text: "memory-only briefing", searches: 0 }),
      }),
    }),
    PerplexityApiError,
  );
});

// --- Structured chat -----------------------------------------------------------

test("structured chat: fallback parses JSON out of prose; searchMode stays off by default", async () => {
  let sawTools: unknown = "unset";
  const out = await structuredChatWithFallback<{ v: number }>(
    "sys",
    "user",
    { type: "object", properties: { v: { type: "number" } }, required: ["v"], additionalProperties: false },
    {
      deps: baseDeps({
        isPerplexityConfigured: () => false,
        createMessage: async (req) => {
          sawTools = (req as { tools?: unknown }).tools;
          return fakeMessage({ text: 'Here you go: {"v": 7} — done.' });
        },
      }),
    },
  );
  assert.deepEqual(out, { v: 7 });
  assert.equal(sawTools, undefined);
});

test("structured chat: rethrows ORIGINAL Perplexity error when fallback output is not JSON", async () => {
  const original = new PerplexityApiError("HTTP 429");
  await assert.rejects(
    structuredChatWithFallback(
      "sys",
      "user",
      { type: "object", properties: {}, required: [], additionalProperties: false },
      {
        deps: baseDeps({
          perplexityStructuredChat: (async () => {
            throw original;
          }) as ResearchFallbackDeps["perplexityStructuredChat"],
          createMessage: async () => fakeMessage({ text: "I cannot answer that." }),
        }),
      },
    ),
    (err: unknown) => err === original,
  );
});

// --- Fallback gating -----------------------------------------------------------

test("fallback disabled in AI Controls → original Perplexity error rethrown", async () => {
  const original = new PerplexityNotConfiguredError();
  await assert.rejects(
    searchWithFallback("q", {
      deps: baseDeps({
        isPerplexityConfigured: () => false,
        perplexitySearch: async () => {
          throw original;
        },
        isFallbackEnabled: async () => false,
      }),
    }),
    PerplexityNotConfiguredError,
  );
});

test("Anthropic env absent → original Perplexity error rethrown", async () => {
  await assert.rejects(
    searchWithFallback("q", {
      deps: baseDeps({
        isPerplexityConfigured: () => false,
        isAnthropicConfigured: () => false,
      }),
    }),
    PerplexityNotConfiguredError,
  );
});

test("both fail → ORIGINAL PerplexityApiError rethrown, not the fallback error", async () => {
  const original = new PerplexityApiError("HTTP 503");
  await assert.rejects(
    searchWithFallback("q", {
      deps: baseDeps({
        perplexitySearch: async () => {
          throw original;
        },
        createMessage: async () => {
          throw new Error("anthropic exploded");
        },
      }),
    }),
    (err: unknown) => err === original,
  );
});

// --- Cooldown breaker ------------------------------------------------------------

test("cooldown engages after 2 consecutive API failures, skips Perplexity, then expires", async () => {
  let clock = 1_000_000;
  let perplexityCalls = 0;
  const deps = baseDeps({
    now: () => clock,
    perplexitySearch: async () => {
      perplexityCalls += 1;
      throw new PerplexityApiError("HTTP 500");
    },
  });

  await searchWithFallback("q", { deps });
  await searchWithFallback("q", { deps });
  assert.equal(perplexityCalls, 2);
  assert.equal(_getResearchFallbackState().consecutiveFailures, 2);
  assert.ok(_getResearchFallbackState().cooldownUntil > clock);

  // Within the cooldown window: Perplexity is skipped entirely.
  clock += 30_000;
  await searchWithFallback("q", { deps });
  assert.equal(perplexityCalls, 2);

  // After the TTL expires: Perplexity is tried again.
  clock += 31_000;
  await searchWithFallback("q", { deps });
  assert.equal(perplexityCalls, 3);
});

test("a Perplexity success resets the breaker completely", async () => {
  let clock = 1_000_000;
  let fail = true;
  const deps = baseDeps({
    now: () => clock,
    perplexitySearch: async () => {
      if (fail) throw new PerplexityApiError("HTTP 500");
      return [LEAD];
    },
  });
  await searchWithFallback("q", { deps });
  fail = false;
  const leads = await searchWithFallback("q", { deps });
  assert.deepEqual(leads, [LEAD]);
  const state = _getResearchFallbackState();
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.cooldownUntil, 0);
  assert.equal(state.usedFallbackSinceLastSuccess, false);
});

test("NotConfigured does NOT count toward the cooldown", async () => {
  const deps = baseDeps({ isPerplexityConfigured: () => false });
  await searchWithFallback("q", { deps });
  await searchWithFallback("q", { deps });
  await searchWithFallback("q", { deps });
  assert.equal(_getResearchFallbackState().consecutiveFailures, 0);
  assert.equal(_getResearchFallbackState().cooldownUntil, 0);
});

// --- Search lead hygiene -----------------------------------------------------------

test("search fallback: drops non-http URLs and enforces the domain filter", async () => {
  const leads = await searchWithFallback("q", {
    domains: ["allowed.gov"],
    deps: baseDeps({
      isPerplexityConfigured: () => false,
      createMessage: async () =>
        fakeMessage({
          text: JSON.stringify([
            { title: "ok", url: "https://sub.allowed.gov/a", snippet: "s" },
            { title: "other", url: "https://other.com/b", snippet: "s" },
            { title: "junk", url: "not-a-url", snippet: "s" },
          ]),
          searches: 1,
          resultUrls: ["https://sub.allowed.gov/a"],
        }),
    }),
  });
  assert.equal(leads.length, 1);
  assert.equal(leads[0]!.url, "https://sub.allowed.gov/a");
});

test("search fallback: URL provenance — a lead absent from the live search results is dropped", async () => {
  const leads = await searchWithFallback("q", {
    deps: baseDeps({
      isPerplexityConfigured: () => false,
      createMessage: async () =>
        fakeMessage({
          text: JSON.stringify([
            { title: "real", url: "https://searched.gov/a", snippet: "s" },
            { title: "invented", url: "https://memory.com/never-searched", snippet: "s" },
          ]),
          searches: 1,
          resultUrls: ["https://searched.gov/a"],
        }),
    }),
  });
  assert.equal(leads.length, 1);
  assert.equal(leads[0]!.url, "https://searched.gov/a");
});

test("search fallback: ALL leads fabricated → fail closed, original Perplexity error rethrown", async () => {
  const original = new PerplexityApiError("HTTP 502");
  await assert.rejects(
    searchWithFallback("q", {
      deps: baseDeps({
        perplexitySearch: async () => {
          throw original;
        },
        createMessage: async () =>
          fakeMessage({
            text: '[{"title":"m","url":"https://memory.com/x","snippet":""}]',
            searches: 1,
            resultUrls: ["https://actually-searched.gov/other"],
          }),
      }),
    }),
    (err: unknown) => err === original,
  );
});

test("search fallback: honest empty result ([]) passes through as no leads", async () => {
  const leads = await searchWithFallback("q", {
    deps: baseDeps({
      isPerplexityConfigured: () => false,
      createMessage: async () =>
        fakeMessage({ text: "[]", searches: 1, resultUrls: ["https://searched.gov/a"] }),
    }),
  });
  assert.deepEqual(leads, []);
});

// --- Availability probe -----------------------------------------------------------

test("isResearchCapabilityAvailable: perplexity OR (anthropic AND enabled)", async () => {
  assert.equal(
    await isResearchCapabilityAvailable(baseDeps({ isPerplexityConfigured: () => true })),
    true,
  );
  assert.equal(
    await isResearchCapabilityAvailable(
      baseDeps({ isPerplexityConfigured: () => false, isAnthropicConfigured: () => true }),
    ),
    true,
  );
  assert.equal(
    await isResearchCapabilityAvailable(
      baseDeps({
        isPerplexityConfigured: () => false,
        isAnthropicConfigured: () => true,
        isFallbackEnabled: async () => false,
      }),
    ),
    false,
  );
  assert.equal(
    await isResearchCapabilityAvailable(
      baseDeps({ isPerplexityConfigured: () => false, isAnthropicConfigured: () => false }),
    ),
    false,
  );
});

import type Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger";
import {
  isPerplexityConfigured,
  perplexitySearch,
  perplexitySonarResearch,
  perplexityStructuredChat,
  PerplexityApiError,
  PerplexityNotConfiguredError,
  type JsonSchemaObject,
  type SearchLead,
  type SonarResearchResult,
} from "./perplexity";
import { classifySourceRole } from "./sourceAuthority";
import { isAiFunctionEnabled, resolveDirective, resolveModel } from "./aiSettings";
import { recordTextUsage } from "./aiUsage";

// --- Perplexity → Claude Haiku fallback (Task #341) -------------------------
//
// Every Perplexity-dependent feature (source discovery, gap scanning, hot-topic
// harvests, Sonar research briefings, concept-explainer structured chat) routes
// through the three wrappers here instead of calling perplexity.ts directly:
//
//   searchWithFallback         — search-shaped (returns SearchLead[])
//   researchWithFallback       — research-shaped (returns cited prose)
//   structuredChatWithFallback — strict-JSON structured output
//
// Semantics:
//   * Perplexity is ALWAYS tried first on every call (unless a short in-memory
//     cooldown is active after consecutive transient failures). With a healthy
//     Perplexity key, behavior is byte-identical to calling perplexity.ts.
//   * On PerplexityNotConfiguredError or PerplexityApiError (HTTP error /
//     timeout), the call falls back to the cheapest allowed Haiku model
//     resolved through the standard model routing (admin override → registry
//     default → allowed-model validation, key: "research_fallback").
//   * Recovery is automatic and per-call. The cooldown is in-memory only with
//     a short TTL that expires on its own — never persisted, never requiring a
//     restart or manual reset. The first Perplexity success resets everything.
//   * If the fallback is unavailable (Anthropic env absent), paused in AI
//     Controls, or itself fails, the ORIGINAL Perplexity error is rethrown so
//     every caller degrades exactly as it did before this feature existed.
//   * Search-shaped fallback FAILS CLOSED when the model answers without
//     actually invoking web search — memory-only "leads" would poison the
//     vault with fabricated URLs (same rule as the Trend Scout).
//   * Every fallback call is billed to the cost meter via recordTextUsage
//     (provider "anthropic", actual model), so admin cost reporting shows
//     which provider produced each result.
//
// Embeddings are explicitly EXCLUDED — Haiku cannot produce embeddings; the
// local transformers.js provider remains the embedding fallback.

/** Consecutive transient Perplexity failures before the cooldown engages. */
const COOLDOWN_FAILURE_THRESHOLD = 2;
/** How long Perplexity is skipped once the cooldown engages (in-memory only). */
const COOLDOWN_MS = 60_000;
/** Web-search tool cap for fallback calls ($0.01/search — keep it tight). */
const FALLBACK_MAX_WEB_SEARCHES = 2;

/** True when the Anthropic AI integration env is present (fallback usable). */
export function isAnthropicFallbackConfigured(): boolean {
  return (
    !!process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY?.trim() &&
    !!process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL?.trim()
  );
}

/** Injectable seams for unit tests. Production callers never pass this. */
export interface ResearchFallbackDeps {
  perplexitySearch: typeof perplexitySearch;
  perplexitySonarResearch: typeof perplexitySonarResearch;
  perplexityStructuredChat: <T>(
    system: string,
    user: string,
    schema: JsonSchemaObject,
    opts?: Parameters<typeof perplexityStructuredChat>[3],
  ) => Promise<T>;
  createMessage: (req: Record<string, unknown>) => Promise<Anthropic.Messages.Message>;
  resolveModel: () => Promise<string>;
  resolveDirective: () => Promise<string>;
  isFallbackEnabled: () => Promise<boolean>;
  isPerplexityConfigured: () => boolean;
  isAnthropicConfigured: () => boolean;
  recordUsage: typeof recordTextUsage;
  now: () => number;
}

async function defaultCreateMessage(
  req: Record<string, unknown>,
): Promise<Anthropic.Messages.Message> {
  // Lazy import: the integrations client throws at import time when the env is
  // absent; deferring keeps this module loadable (and testable) without it.
  const { anthropic } = await import("@workspace/integrations-anthropic-ai");
  return (await anthropic.messages.create(
    req as unknown as Parameters<typeof anthropic.messages.create>[0],
  )) as Anthropic.Messages.Message;
}

function buildDeps(overrides?: Partial<ResearchFallbackDeps>): ResearchFallbackDeps {
  return {
    perplexitySearch,
    perplexitySonarResearch,
    perplexityStructuredChat: perplexityStructuredChat as ResearchFallbackDeps["perplexityStructuredChat"],
    createMessage: defaultCreateMessage,
    resolveModel: () => resolveModel("research_fallback"),
    resolveDirective: () => resolveDirective("research_fallback"),
    isFallbackEnabled: () => isAiFunctionEnabled("research_fallback"),
    isPerplexityConfigured,
    isAnthropicConfigured: isAnthropicFallbackConfigured,
    recordUsage: recordTextUsage,
    now: Date.now,
    ...overrides,
  };
}

/**
 * True when EITHER research provider is usable: Perplexity is configured, or
 * the Anthropic fallback is configured AND not paused in AI Controls. Replaces
 * bare isPerplexityConfigured() availability gates so scheduled/manual work
 * proceeds on Haiku instead of silently not running.
 */
export async function isResearchCapabilityAvailable(
  deps?: Partial<ResearchFallbackDeps>,
): Promise<boolean> {
  const d = buildDeps(deps);
  if (d.isPerplexityConfigured()) return true;
  return d.isAnthropicConfigured() && (await d.isFallbackEnabled());
}

// --- Cooldown breaker (in-memory only, short TTL, self-expiring) -----------

interface BreakerState {
  consecutiveFailures: number;
  cooldownUntil: number;
  usedFallbackSinceLastSuccess: boolean;
}

const breaker: BreakerState = {
  consecutiveFailures: 0,
  cooldownUntil: 0,
  usedFallbackSinceLastSuccess: false,
};

/** Test-only: reset the in-memory breaker to its boot state. */
export function _resetResearchFallbackState(): void {
  breaker.consecutiveFailures = 0;
  breaker.cooldownUntil = 0;
  breaker.usedFallbackSinceLastSuccess = false;
}

/** Test-only: peek at the breaker state. */
export function _getResearchFallbackState(): Readonly<BreakerState> {
  return { ...breaker };
}

/** Internal marker: the FALLBACK path failed (vs the Perplexity path). */
class FallbackFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FallbackFailedError";
  }
}

function onPerplexitySuccess(operation: string): void {
  if (breaker.usedFallbackSinceLastSuccess || breaker.consecutiveFailures > 0) {
    logger.info({ operation }, "researchFallback: Perplexity recovered — back on primary provider");
  }
  breaker.consecutiveFailures = 0;
  breaker.cooldownUntil = 0;
  breaker.usedFallbackSinceLastSuccess = false;
}

function onPerplexityTransientFailure(operation: string, err: unknown, now: number): void {
  breaker.consecutiveFailures += 1;
  if (breaker.consecutiveFailures >= COOLDOWN_FAILURE_THRESHOLD) {
    breaker.cooldownUntil = now + COOLDOWN_MS;
    logger.warn(
      {
        operation,
        consecutiveFailures: breaker.consecutiveFailures,
        cooldownMs: COOLDOWN_MS,
        err: err instanceof Error ? err.message : String(err),
      },
      "researchFallback: Perplexity cooldown engaged (in-memory, self-expiring)",
    );
  }
}

/**
 * Core orchestration: try Perplexity first (unless cooling down), fall back to
 * Haiku on not-configured / API error / timeout. When the fallback is
 * unavailable, paused, or fails, the ORIGINAL Perplexity error is rethrown so
 * callers degrade exactly like a plain Perplexity failure.
 */
async function withFallback<T>(input: {
  operation: string;
  deps: ResearchFallbackDeps;
  tryPerplexity: () => Promise<T>;
  tryFallback: (model: string, directive: string) => Promise<T>;
}): Promise<T> {
  const { operation, deps: d } = input;
  const now = d.now();
  const coolingDown = now < breaker.cooldownUntil;

  let perplexityError: Error;
  if (!d.isPerplexityConfigured()) {
    perplexityError = new PerplexityNotConfiguredError();
  } else if (coolingDown) {
    perplexityError = new PerplexityApiError(
      "Perplexity is cooling down after repeated failures; skipped this call.",
    );
  } else {
    try {
      const result = await input.tryPerplexity();
      onPerplexitySuccess(operation);
      return result;
    } catch (err) {
      if (err instanceof PerplexityNotConfiguredError) {
        // Not a health failure — do not count toward the cooldown.
        perplexityError = err;
      } else if (err instanceof PerplexityApiError) {
        onPerplexityTransientFailure(operation, err, now);
        perplexityError = err;
      } else {
        // Unknown error type: not a Perplexity transport failure — rethrow.
        throw err;
      }
    }
  }

  if (!d.isAnthropicConfigured() || !(await d.isFallbackEnabled())) {
    throw perplexityError;
  }

  try {
    const model = await d.resolveModel();
    const directive = await d.resolveDirective();
    logger.warn(
      {
        operation,
        model,
        reason: coolingDown
          ? "cooldown"
          : perplexityError instanceof PerplexityNotConfiguredError
            ? "not_configured"
            : "perplexity_error",
      },
      "researchFallback: falling back to Claude for this call",
    );
    const result = await input.tryFallback(model, directive);
    breaker.usedFallbackSinceLastSuccess = true;
    return result;
  } catch (fallbackErr) {
    logger.warn(
      {
        operation,
        perplexityErr: perplexityError.message,
        fallbackErr: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
      },
      "researchFallback: fallback also failed — degrading like a Perplexity failure",
    );
    // Preserve the original error type so every caller's existing
    // instanceof-based degrade path behaves exactly as before.
    throw perplexityError;
  }
}

// --- Shared response plumbing -----------------------------------------------

function textOf(message: Anthropic.Messages.Message): string {
  const blocks = message.content.filter(
    (b): b is Anthropic.Messages.TextBlock => b.type === "text",
  );
  return blocks.length > 0 ? blocks[blocks.length - 1]!.text : "";
}

function webSearchUses(message: Anthropic.Messages.Message): number {
  return message.content.filter((b) => b.type === "server_tool_use" || b.type === "tool_use")
    .length;
}

/** URLs the model actually retrieved via web search (result blocks + citations). */
function searchResultUrls(message: Anthropic.Messages.Message): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const push = (u: unknown): void => {
    if (typeof u !== "string") return;
    const t = u.trim();
    if (!t || !/^https?:\/\//i.test(t) || seen.has(t)) return;
    seen.add(t);
    urls.push(t);
  };
  for (const block of message.content as unknown as Array<Record<string, unknown>>) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const item of block.content as Array<Record<string, unknown>>) {
        if (item && item.type === "web_search_result") push(item.url);
      }
    }
    if (block.type === "text" && Array.isArray(block.citations)) {
      for (const c of block.citations as Array<Record<string, unknown>>) {
        if (c) push(c.url);
      }
    }
  }
  return urls;
}

/**
 * Extract the first balanced top-level JSON value (`{…}` or `[…]`) from model
 * output. Never slice-to-end + parse: models wrap JSON in prose/fences.
 */
export function extractBalancedJson<T>(text: string): T {
  const start = text.search(/[[{]/);
  if (start === -1) throw new Error("No JSON value found in model output.");
  const open = text[start]!;
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open || (ch === "{" && open === "[") || (ch === "[" && open === "{")) {
      if (ch === open) depth += 1;
    } else if (ch === close || ch === "}" || ch === "]") {
      if (ch === close) {
        depth -= 1;
        if (depth === 0) return JSON.parse(text.slice(start, i + 1)) as T;
      }
    }
  }
  throw new Error("Unbalanced JSON value in model output.");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function webSearchTool(opts?: { domains?: string[] }): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: FALLBACK_MAX_WEB_SEARCHES,
  };
  if (opts?.domains && opts.domains.length > 0) {
    tool.allowed_domains = opts.domains;
  }
  return tool;
}

// --- 1. Search-shaped calls (SearchLead[]) ----------------------------------

export interface SearchWithFallbackOpts {
  maxResults?: number;
  recencyDays?: number;
  domains?: string[];
  /** Cost-meter operation label (defaults to the Perplexity search label). */
  operation?: string;
  deps?: Partial<ResearchFallbackDeps>;
}

/**
 * Discover fresh source leads: Perplexity Search first, Claude Haiku +
 * web_search fallback. Fallback leads are adapted to the exact SearchLead
 * shape (role/tier classification included) so every downstream consumer is
 * provider-agnostic. Fails closed (throws) when the fallback model answers
 * without performing a live web search.
 */
export async function searchWithFallback(
  query: string,
  opts: SearchWithFallbackOpts = {},
): Promise<SearchLead[]> {
  const d = buildDeps(opts.deps);
  const operation = opts.operation ?? "sourceVaultSearch";
  return withFallback<SearchLead[]>({
    operation,
    deps: d,
    tryPerplexity: () =>
      d.perplexitySearch(query, {
        maxResults: opts.maxResults,
        recencyDays: opts.recencyDays,
        domains: opts.domains,
      }),
    tryFallback: async (model, directive) => {
      const maxResults = Math.min(Math.max(opts.maxResults ?? 10, 1), 25);
      const domains = (opts.domains ?? [])
        .map((x) => x.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
        .filter((x) => x.length > 0);
      const recencyLine =
        opts.recencyDays && opts.recencyDays > 0
          ? `\nOnly report pages published within the last ${opts.recencyDays} days; skip anything older.`
          : "";
      const domainLine =
        domains.length > 0
          ? `\nOnly report pages hosted on these domains: ${domains.join(", ")}.`
          : "";
      const system = `${directive}\n\nYou find real, citable web sources for a query and report them as structured JSON. Report ONLY pages you actually found via the web_search tool in this conversation — never a URL from memory, never a guess, never a search-results or homepage URL when a specific page exists.`;
      const user = `Find up to ${maxResults} relevant web sources for this query:\n\n${query}${recencyLine}${domainLine}\n\nRespond with ONLY a JSON array (no prose, no markdown fence) of objects with this exact shape:\n[\n  { "title": "...", "url": "https://...", "snippet": "1-2 sentence summary of what the page says", "date": "YYYY-MM-DD or null" }\n]\nReturn [] if the search turns up nothing relevant.`;

      const message = await d.createMessage({
        model,
        max_tokens: 2048,
        temperature: 0,
        system,
        messages: [{ role: "user", content: user }],
        tools: [webSearchTool({ domains })],
        // Force the model to actually invoke the search tool rather than
        // answering from parametric memory (which would produce fabricated URLs).
        tool_choice: { type: "any" },
      });
      d.recordUsage({ operation, model, message });

      // FAIL CLOSED: leads that did not come from a live search would be
      // fabricated from parametric memory — worse than no leads at all.
      if (webSearchUses(message) === 0) {
        throw new FallbackFailedError(
          "Fallback search: model answered without performing a web search.",
        );
      }

      let raw: Array<{ title?: string; url?: string; snippet?: string; date?: string | null }>;
      try {
        raw = extractBalancedJson(textOf(message));
      } catch (err) {
        throw new FallbackFailedError(
          `Fallback search: unparseable model output (${err instanceof Error ? err.message : String(err)}).`,
        );
      }
      if (!Array.isArray(raw)) {
        throw new FallbackFailedError("Fallback search: model output was not a JSON array.");
      }
      // Provenance enforcement (fail closed): only accept URLs the model
      // actually retrieved via web search in THIS conversation. A lead the
      // search tool never returned is a fabrication from parametric memory —
      // it must not reach the Source Vault.
      const searchedUrls = new Set(searchResultUrls(message));
      const leads: SearchLead[] = [];
      let fabricated = 0;
      for (const r of raw) {
        const url = typeof r?.url === "string" ? r.url.trim() : "";
        if (!/^https?:\/\//i.test(url)) continue;
        if (!searchedUrls.has(url)) {
          fabricated += 1;
          continue;
        }
        const domain = hostOf(url);
        if (!domain) continue;
        if (
          domains.length > 0 &&
          !domains.some((x) => domain === x || domain.endsWith(`.${x}`))
        ) {
          continue;
        }
        const { role, tier, reason, platform } = classifySourceRole(url);
        leads.push({
          title: (r.title ?? "").trim() || url,
          url,
          snippet: (r.snippet ?? "").trim(),
          date: typeof r.date === "string" && r.date.trim() ? r.date.trim() : null,
          domain,
          role,
          tier,
          roleReason: reason,
          platform,
        });
        if (leads.length >= maxResults) break;
      }
      // A search that reported ONLY fabricated URLs is a failed fallback (the
      // original Perplexity error is rethrown by withFallback). An honest
      // empty result ([] with nothing fabricated) passes through as "no leads".
      if (leads.length === 0 && fabricated > 0) {
        throw new FallbackFailedError(
          `Fallback search: all ${fabricated} reported URLs were absent from the live search results (fabricated).`,
        );
      }
      logger.info(
        { operation, model, leads: leads.length, fabricated, searchedUrls: searchedUrls.size },
        "researchFallback: fallback search produced leads",
      );
      return leads;
    },
  });
}

// --- 2. Research-shaped calls (cited prose) ---------------------------------

export interface ResearchWithFallbackOpts {
  deep?: boolean;
  maxTokens?: number;
  /** Cost-meter operation label (defaults to the Perplexity research label). */
  operation?: string;
  deps?: Partial<ResearchFallbackDeps>;
}

/**
 * Grounded research briefing: Perplexity Sonar first, Claude Haiku +
 * web_search fallback. The fallback returns the same SonarResearchResult
 * shape with citations drawn from the URLs the model actually retrieved via
 * web search. Fails closed when the fallback model answers without searching
 * (a memory-only "briefing" must not masquerade as live research).
 */
export async function researchWithFallback(
  system: string,
  user: string,
  opts: ResearchWithFallbackOpts = {},
): Promise<SonarResearchResult> {
  const d = buildDeps(opts.deps);
  const operation = opts.operation ?? "sourceVaultResearch";
  return withFallback<SonarResearchResult>({
    operation,
    deps: d,
    tryPerplexity: () =>
      d.perplexitySonarResearch(system, user, { deep: opts.deep, maxTokens: opts.maxTokens }),
    tryFallback: async (model, directive) => {
      const message = await d.createMessage({
        model,
        max_tokens: Math.min(Math.max(opts.maxTokens ?? 1200, 256), 4000),
        temperature: 0.2,
        system: `${directive}\n\n${system}`,
        messages: [{ role: "user", content: user }],
        tools: [webSearchTool()],
      });
      d.recordUsage({ operation, model, message });
      if (webSearchUses(message) === 0) {
        throw new FallbackFailedError(
          "Fallback research: model answered without performing a web search.",
        );
      }
      const content = textOf(message).trim();
      const citations = searchResultUrls(message);
      return { content, citations, model };
    },
  });
}

// --- 3. Structured-output chat (strict JSON) --------------------------------

export interface StructuredChatWithFallbackOpts {
  schemaName?: string;
  operation?: string;
  maxTokens?: number;
  searchMode?: boolean;
  deep?: boolean;
  deps?: Partial<ResearchFallbackDeps>;
}

/**
 * Structured JSON chat: Perplexity structured output first, Claude Haiku
 * fallback (the JSON schema is embedded in the prompt and the reply parsed
 * with a balanced-bracket scanner). Shape validation stays the caller's
 * responsibility (Zod), exactly as with the Perplexity path.
 */
export async function structuredChatWithFallback<T>(
  system: string,
  user: string,
  schema: JsonSchemaObject,
  opts: StructuredChatWithFallbackOpts = {},
): Promise<T> {
  const d = buildDeps(opts.deps);
  const operation = opts.operation ?? "conceptExplainer";
  return withFallback<T>({
    operation,
    deps: d,
    tryPerplexity: () =>
      d.perplexityStructuredChat<T>(system, user, schema, {
        schemaName: opts.schemaName,
        operation: opts.operation,
        maxTokens: opts.maxTokens,
        searchMode: opts.searchMode,
        deep: opts.deep,
      }),
    tryFallback: async (model) => {
      // Give Sonnet enough room — it needs more headroom than Haiku when the
      // system prompt is long (directive + JSON schema). Floor at 2048 so the
      // model isn't forced to truncate before the closing brace.
      const maxTokens = Math.min(Math.max(opts.maxTokens ?? 512, 2048), 4096);
      const request: Record<string, unknown> = {
        model,
        max_tokens: maxTokens,
        temperature: 0,
        system: `${system}\n\nRespond with ONLY a single JSON object that conforms exactly to this JSON Schema — no prose, no markdown fences, no explanations:\n${JSON.stringify(schema)}`,
        // Prefill the assistant turn with "{" so the model is forced to
        // continue the JSON object rather than producing a preamble that could
        // prevent a text block from appearing in the response content.
        messages: [
          { role: "user", content: user },
          { role: "assistant", content: "{" },
        ],
      };
      // Perplexity structured calls have search DISABLED by default (all
      // context is in the prompt); mirror that — only attach the tool when the
      // caller explicitly opted into live retrieval.
      if (opts.searchMode) request.tools = [webSearchTool()];
      const message = await d.createMessage(request);
      d.recordUsage({ operation, model, message });
      // Prepend the "{" we used as the assistant-turn prefill — the model's
      // response only contains the continuation, not the opening brace.
      const raw = textOf(message).trim();
      const text = raw.startsWith("{") ? raw : `{${raw}`;
      if (!raw) {
        throw new FallbackFailedError(
          `Fallback structured chat: model returned empty content for operation '${operation}'.`,
        );
      }
      try {
        return extractBalancedJson<T>(text);
      } catch (err) {
        throw new FallbackFailedError(
          `Fallback structured chat: non-JSON content for operation '${operation}' (${err instanceof Error ? err.message : String(err)}).`,
        );
      }
    },
  });
}

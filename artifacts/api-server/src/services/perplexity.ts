import { db, aiUsageEventsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { classifySourceRole, type SourceRole, type SourceRoleClassification } from "./sourceAuthority";
import type { TrendMarkerPlatform } from "@workspace/db";

// --- Perplexity provider (Source Vault Phase 0) --------------------------
// Two capabilities the vault needs from Perplexity:
//   1. Search  — discover fresh source leads for a query (title/url/snippet/date).
//   2. Embed   — turn text chunks into vectors for semantic retrieval.
//
// Both are gated on PERPLEXITY_API_KEY. When the key is absent every entry point
// degrades cleanly: `isPerplexityConfigured()` is false, and the two callables
// throw a typed PerplexityNotConfiguredError that the orchestrator catches and
// turns into a clean "skipped, provider not configured" outcome — never a crash.
//
// Endpoints + models are env-overridable so the exact Perplexity surface can be
// pointed/adjusted without a code change (the search + embeddings API shapes are
// treated as OpenAI-compatible JSON). Defaults target the documented paths.

const SEARCH_URL = () =>
  process.env.PERPLEXITY_SEARCH_URL?.trim() || "https://api.perplexity.ai/search";
const EMBED_URL = () =>
  process.env.PERPLEXITY_EMBED_URL?.trim() || "https://api.perplexity.ai/v1/embeddings";
const EMBED_MODEL = () =>
  process.env.PERPLEXITY_EMBED_MODEL?.trim() || "pplx-embed-v1-0.6b";
const CHAT_URL = () =>
  process.env.PERPLEXITY_CHAT_URL?.trim() || "https://api.perplexity.ai/chat/completions";
const SONAR_MODEL = () => process.env.PERPLEXITY_SONAR_MODEL?.trim() || "sonar";
const SONAR_DEEP_MODEL = () =>
  process.env.PERPLEXITY_SONAR_DEEP_MODEL?.trim() || "sonar-deep-research";

const REQUEST_TIMEOUT_MS = 20000;

/** USD per 1M embedding input tokens (rough; used only for the spend meter). */
const EMBED_USD_PER_M_TOKENS = 0.004;
/** USD per Perplexity search request (rough; used only for the spend meter). */
const SEARCH_USD = 0.005;
/** USD per 1M Sonar chat tokens (input+output combined; ~$1/M actual). */
const SONAR_USD_PER_M = 1.0;
/** Per-request fee for Sonar chat completions (Perplexity adds this on every call). */
const SONAR_REQUEST_USD = 0.005;
/** USD per 1M Sonar Deep Research tokens (input+output combined; ~$5/M actual). */
const SONAR_DEEP_USD_PER_M = 5.0;
/** Per-request fee for Sonar Deep Research completions. */
const SONAR_DEEP_REQUEST_USD = 0.005;

/** True when the Perplexity API key is present in the environment. */
export function isPerplexityConfigured(): boolean {
  const key = process.env.PERPLEXITY_API_KEY;
  return typeof key === "string" && key.trim().length > 0;
}

/** Thrown by search/embed when the provider is not configured. */
export class PerplexityNotConfiguredError extends Error {
  constructor() {
    super("PERPLEXITY_API_KEY is not set; Perplexity search/embeddings are unavailable.");
    this.name = "PerplexityNotConfiguredError";
  }
}

/** Thrown on a non-2xx Perplexity API response or a malformed payload. */
export class PerplexityApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "PerplexityApiError";
  }
}

function apiKey(): string {
  const key = process.env.PERPLEXITY_API_KEY?.trim();
  if (!key) throw new PerplexityNotConfiguredError();
  return key;
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey()}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new PerplexityApiError(
        `Perplexity ${url} returned ${res.status}: ${text.slice(0, 300)}`,
        res.status,
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new PerplexityApiError(`Perplexity ${url} returned non-JSON body.`);
    }
  } catch (err) {
    if (err instanceof PerplexityApiError || err instanceof PerplexityNotConfiguredError) throw err;
    if ((err as Error).name === "AbortError") {
      throw new PerplexityApiError(`Perplexity ${url} timed out after ${REQUEST_TIMEOUT_MS}ms.`);
    }
    throw new PerplexityApiError(`Perplexity ${url} request failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** A normalized search lead, tagged with its three-way source role. */
export interface SearchLead {
  title: string;
  url: string;
  snippet: string;
  date: string | null;
  domain: string;
  // Three-way classification (Task #227): evidence → Source Vault; trend_marker
  // → velocity signal only; rejected_junk → dropped. The caller routes on this.
  role: SourceRole;
  // Underlying authority tier + short reason the role derived from.
  tier: SourceRoleClassification["tier"];
  roleReason: string;
  // Social platform family for markers (else null).
  platform: TrendMarkerPlatform | null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function recordUsage(
  input: {
    operation: string;
    model: string;
    costUsd: number;
    inputTokens?: number;
    outputTokens?: number;
  },
): void {
  void db
    .insert(aiUsageEventsTable)
    .values({
      provider: "perplexity",
      model: input.model,
      operation: input.operation,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      webSearches: 0,
      images: 0,
      costUsd: input.costUsd.toFixed(6),
    })
    .catch((err) =>
      logger.warn({ err, operation: input.operation }, "perplexity: failed to record usage"),
    );
}

/**
 * Discover fresh source leads for a query via the Perplexity Search API. Returns
 * normalized leads (title/url/snippet/date/domain). Throws
 * PerplexityNotConfiguredError when the key is absent (caller degrades cleanly).
 */
export async function perplexitySearch(
  query: string,
  opts: { maxResults?: number; recencyDays?: number; domains?: string[] } = {},
): Promise<SearchLead[]> {
  if (!isPerplexityConfigured()) throw new PerplexityNotConfiguredError();
  const maxResults = Math.min(Math.max(opts.maxResults ?? 10, 1), 25);
  const body: Record<string, unknown> = { query, max_results: maxResults };
  if (opts.recencyDays && opts.recencyDays > 0) body.max_age_days = opts.recencyDays;
  const domains = (opts.domains ?? [])
    .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter((d) => d.length > 0);
  if (domains.length > 0) body.search_domain_filter = domains;

  const json = (await postJson(SEARCH_URL(), body)) as {
    results?: Array<{
      title?: string;
      url?: string;
      snippet?: string;
      date?: string;
      last_updated?: string;
    }>;
  };
  recordUsage({ operation: "sourceVaultSearch", model: "perplexity-search", costUsd: SEARCH_USD });

  const results = Array.isArray(json.results) ? json.results : [];
  const leads: SearchLead[] = [];
  for (const r of results) {
    const url = typeof r.url === "string" ? r.url : "";
    if (!url) continue;
    // Three-way classification (Task #227): every lead is TAGGED with its role
    // (evidence / trend_marker / rejected_junk) rather than silently dropped
    // here. The caller decides where each role goes so social buzz + junk stay
    // visible in Trend Radar instead of vanishing.
    const { role, tier, reason, platform } = classifySourceRole(url);
    leads.push({
      title: (r.title ?? "").trim() || url,
      url,
      snippet: (r.snippet ?? "").trim(),
      date: (r.date ?? r.last_updated ?? "").trim() || null,
      domain: hostOf(url),
      role,
      tier,
      roleReason: reason,
      platform,
    });
  }
  return leads;
}

/** A batch of embeddings plus the provenance to persist alongside each vector. */
export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  dimensions: number;
}

/**
 * Embed one or more texts via the Perplexity Embeddings API (OpenAI-compatible
 * shape). Returns the vectors plus the model + dimensions so the caller records
 * provenance per chunk (the vector size is never hardwired). Throws
 * PerplexityNotConfiguredError when the key is absent.
 */
export async function perplexityEmbed(texts: string[]): Promise<EmbeddingResult> {
  if (!isPerplexityConfigured()) throw new PerplexityNotConfiguredError();
  if (texts.length === 0) return { vectors: [], model: EMBED_MODEL(), dimensions: 0 };

  const model = EMBED_MODEL();
  const json = (await postJson(EMBED_URL(), { model, input: texts })) as {
    data?: Array<{ embedding?: number[] }>;
    model?: string;
    usage?: { total_tokens?: number; prompt_tokens?: number };
  };

  const data = Array.isArray(json.data) ? json.data : [];
  const vectors = data.map((d) => (Array.isArray(d.embedding) ? d.embedding : []));
  if (vectors.length !== texts.length || vectors.some((v) => v.length === 0)) {
    throw new PerplexityApiError(
      `Perplexity embeddings returned ${vectors.length} usable vectors for ${texts.length} inputs.`,
    );
  }
  const dimensions = vectors[0]!.length;
  if (vectors.some((v) => v.length !== dimensions)) {
    throw new PerplexityApiError("Perplexity embeddings returned mixed vector dimensions.");
  }

  const tokens =
    json.usage?.total_tokens ??
    json.usage?.prompt_tokens ??
    Math.ceil(texts.reduce((n, t) => n + t.length, 0) / 4);
  recordUsage({
    operation: "sourceVaultEmbed",
    model: json.model ?? model,
    costUsd: (tokens / 1_000_000) * EMBED_USD_PER_M_TOKENS,
  });

  return { vectors, model: json.model ?? model, dimensions };
}

/** The result of a Sonar research call: the answer text plus its citation URLs. */
export interface SonarResearchResult {
  content: string;
  citations: string[];
  model: string;
}

// ---------------------------------------------------------------------------
// Structured-output chat (Concept Explainer & Glossary)
// ---------------------------------------------------------------------------

/**
 * A JSON Schema object compatible with the OpenAI / Perplexity
 * `response_format.json_schema.schema` field (strict-mode subset).
 */
export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

/**
 * Call the Perplexity Sonar chat API with a strict JSON-schema
 * `response_format` so the model returns well-formed structured output.
 *
 * - `searchMode: false` (default) disables Perplexity web search — the
 *   caller supplies all context in the prompt. Pass `searchMode: true` only
 *   when fresh web retrieval is intentionally desired.
 * - The raw JSON string is parsed and returned as `T`; shape validation is the
 *   caller's responsibility (use Zod).
 * - Throws `PerplexityNotConfiguredError` when the key is absent.
 * - Throws `PerplexityApiError` on non-2xx or malformed/non-JSON responses.
 */
export async function perplexityStructuredChat<T>(
  system: string,
  user: string,
  schema: JsonSchemaObject,
  opts: {
    schemaName?: string;
    operation?: string;
    maxTokens?: number;
    searchMode?: boolean;
    deep?: boolean;
  } = {},
): Promise<T> {
  if (!isPerplexityConfigured()) throw new PerplexityNotConfiguredError();
  const model = opts.deep ? SONAR_DEEP_MODEL() : SONAR_MODEL();

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: Math.min(Math.max(opts.maxTokens ?? 512, 64), 4000),
    temperature: 0.0,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: opts.schemaName ?? "response",
        strict: true,
        schema,
      },
    },
  };
  // Perplexity web search is disabled by default for structured calls so we
  // don't pay for search we don't need (all context is in the prompt).
  // NOTE: `search_mode` only accepts "web" | "academic" | "sec" — the correct
  // way to turn search OFF is the top-level boolean `disable_search`
  // (search_mode: "off" is rejected with 400 "invalid request body").
  if (!opts.searchMode) {
    body.disable_search = true;
  }

  const json = (await postJson(CHAT_URL(), body)) as {
    model?: string;
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };

  const operation = opts.operation ?? "conceptExplainer";
  const tokens = json.usage?.total_tokens ?? 0;
  const costPerM = opts.deep ? SONAR_DEEP_USD_PER_M : SONAR_USD_PER_M;
  const requestFee = opts.deep ? SONAR_DEEP_REQUEST_USD : SONAR_REQUEST_USD;
  const costUsd = requestFee + (tokens / 1_000_000) * costPerM;
  recordUsage({
    operation,
    model: json.model ?? model,
    costUsd,
    inputTokens: json.usage?.prompt_tokens ?? 0,
    outputTokens: json.usage?.completion_tokens ?? 0,
  });

  const raw = (json.choices?.[0]?.message?.content ?? "").trim();
  if (!raw) {
    throw new PerplexityApiError(
      `perplexityStructuredChat: model returned empty content for operation '${operation}'.`,
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new PerplexityApiError(
      `perplexityStructuredChat: model returned non-JSON content for operation '${operation}': ${raw.slice(0, 200)}`,
    );
  }
}

/**
 * Run a grounded research query via the Perplexity Sonar chat API. This is the
 * PAID escalation used only by the evidence-packet builder's vault-first gate —
 * it is never called unless the caller explicitly opts in (Deep Research is off
 * by default) and the vault's budget guard allows the spend. Returns the model's
 * answer plus the citation URLs it grounded on. Throws
 * PerplexityNotConfiguredError when the key is absent (caller degrades cleanly).
 */
export async function perplexitySonarResearch(
  system: string,
  user: string,
  opts: { deep?: boolean; maxTokens?: number } = {},
): Promise<SonarResearchResult> {
  if (!isPerplexityConfigured()) throw new PerplexityNotConfiguredError();
  const model = opts.deep ? SONAR_DEEP_MODEL() : SONAR_MODEL();
  const json = (await postJson(CHAT_URL(), {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: Math.min(Math.max(opts.maxTokens ?? 1200, 256), 4000),
    temperature: 0.2,
  })) as {
    model?: string;
    choices?: Array<{ message?: { content?: string } }>;
    citations?: unknown;
    search_results?: Array<{ url?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };

  const tokens = json.usage?.total_tokens ?? 0;
  const costPerM = opts.deep ? SONAR_DEEP_USD_PER_M : SONAR_USD_PER_M;
  const requestFee = opts.deep ? SONAR_DEEP_REQUEST_USD : SONAR_REQUEST_USD;
  const costUsd = requestFee + (tokens / 1_000_000) * costPerM;
  recordUsage({
    operation: "sourceVaultResearch",
    model: json.model ?? model,
    costUsd,
    inputTokens: json.usage?.prompt_tokens ?? 0,
    outputTokens: json.usage?.completion_tokens ?? 0,
  });

  const content = (json.choices?.[0]?.message?.content ?? "").trim();
  const citations: string[] = [];
  if (Array.isArray(json.citations)) {
    for (const c of json.citations) if (typeof c === "string" && c.trim()) citations.push(c.trim());
  }
  if (citations.length === 0 && Array.isArray(json.search_results)) {
    for (const r of json.search_results) {
      if (r && typeof r.url === "string" && r.url.trim()) citations.push(r.url.trim());
    }
  }
  return { content, citations, model: json.model ?? model };
}

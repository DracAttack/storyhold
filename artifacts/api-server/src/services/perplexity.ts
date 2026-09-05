import { db, aiUsageEventsTable } from "@workspace/db";
import { logger } from "../lib/logger";

// Optional paid embeddings used by Storyhold's semantic memory. Preserve the
// existing provider configuration and usage ledger; magazine search/research
// functions have no Storyhold consumers and were removed in the legacy audit.
const EMBED_URL = () =>
  process.env.PERPLEXITY_EMBED_URL?.trim() || "https://api.perplexity.ai/v1/embeddings";
const EMBED_MODEL = () =>
  process.env.PERPLEXITY_EMBED_MODEL?.trim() || "pplx-embed-v1-0.6b";
const REQUEST_TIMEOUT_MS = 20000;
/** Existing estimate for the usage meter; not a customer credit quote. */
const EMBED_USD_PER_M_TOKENS = 0.004;

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

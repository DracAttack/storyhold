import type Anthropic from "@anthropic-ai/sdk";
import { db, aiUsageEventsTable } from "@workspace/db";
import { logger } from "../lib/logger";

/**
 * Per-model token pricing in USD per 1,000,000 tokens, plus the shared
 * per-call rates for the web-search tool and pro image generation. These are
 * Anthropic / Google list prices (the Replit AI Integrations proxy passes
 * provider rates through). Matched by model-family substring so an exact id
 * bump (e.g. sonnet 4.6 → 4.7) still prices correctly; unknown models fall
 * back to Sonnet rates and are logged.
 *
 * Update here if provider pricing changes — historical rows are unaffected
 * because cost is computed and stored at call time.
 */
const TEXT_PRICING: { match: string; inputPerM: number; outputPerM: number }[] = [
  { match: "opus", inputPerM: 15, outputPerM: 75 },
  { match: "sonnet", inputPerM: 3, outputPerM: 15 },
  { match: "haiku", inputPerM: 1, outputPerM: 5 },
];
const SONNET_FALLBACK = { inputPerM: 3, outputPerM: 15 };

/** USD per Anthropic server-side web search ($10 / 1,000 searches). */
export const WEB_SEARCH_USD = 0.01;
/** USD per generated pro image (Gemini 3 Pro Image / Nano Banana Pro). */
export const IMAGE_USD = 0.13;

/** Gemini text rates in USD per 1M tokens. Batch jobs are billed at 50%. */
const GEMINI_TEXT_PRICING = [
  { match: "flash-lite", inputPerM: 0.1, outputPerM: 0.4 },
  { match: "flash", inputPerM: 0.3, outputPerM: 2.5 },
  { match: "pro", inputPerM: 1.25, outputPerM: 10 },
] as const;

export function computeGeminiTextCost(input: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  batch?: boolean;
}): number {
  const model = input.model.toLowerCase();
  const rates = GEMINI_TEXT_PRICING.find((price) => model.includes(price.match)) ?? GEMINI_TEXT_PRICING[1];
  const standard =
    (input.inputTokens / 1_000_000) * rates.inputPerM +
    (input.outputTokens / 1_000_000) * rates.outputPerM;
  return standard * (input.batch ? 0.5 : 1);
}

function textRates(model: string): { inputPerM: number; outputPerM: number } {
  const m = model.toLowerCase();
  const hit = TEXT_PRICING.find((p) => m.includes(p.match));
  if (!hit) {
    logger.warn({ model }, "aiUsage: unknown model, pricing at Sonnet fallback rate");
    return SONNET_FALLBACK;
  }
  return hit;
}

/**
 * Compute the USD cost of a text call from its token counts + web searches.
 * Exported for unit testing / preview.
 */
export function computeTextCost(input: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  webSearches: number;
}): number {
  const rates = textRates(input.model);
  const tokenCost =
    (input.inputTokens / 1_000_000) * rates.inputPerM +
    (input.outputTokens / 1_000_000) * rates.outputPerM;
  return tokenCost + input.webSearches * WEB_SEARCH_USD;
}

/**
 * Pull the billable web-search count from an Anthropic response. Prefer the
 * authoritative `usage.server_tool_use.web_search_requests`; fall back to
 * counting server_tool_use / tool_use content blocks for older SDK shapes.
 */
function webSearchCount(message: Anthropic.Messages.Message): number {
  const reported = (
    message.usage as { server_tool_use?: { web_search_requests?: number } } | undefined
  )?.server_tool_use?.web_search_requests;
  if (typeof reported === "number") return reported;
  return message.content.filter((b) => b.type === "server_tool_use" || b.type === "tool_use").length;
}

/**
 * Record one billable Anthropic text call to the cost meter. Fire-and-forget:
 * it never throws and never blocks the pipeline — a logging failure must not
 * break content generation. Cost is computed and persisted at call time.
 */
export function recordTextUsage(input: {
  operation: string;
  model: string;
  message: Anthropic.Messages.Message;
  authorSlug?: string | null;
  articleId?: string | null;
  memeId?: string | null;
  clusterId?: string | null;
  packetId?: string | null;
  mode?: string | null;
  reason?: string | null;
}): void {
  const inputTokens = input.message.usage?.input_tokens ?? 0;
  const outputTokens = input.message.usage?.output_tokens ?? 0;
  const webSearches = webSearchCount(input.message);
  const costUsd = computeTextCost({ model: input.model, inputTokens, outputTokens, webSearches });
  void db
    .insert(aiUsageEventsTable)
    .values({
      provider: "anthropic",
      model: input.model,
      operation: input.operation,
      inputTokens,
      outputTokens,
      webSearches,
      images: 0,
      costUsd: costUsd.toFixed(6),
      authorSlug: input.authorSlug ?? null,
      articleId: input.articleId ?? null,
      memeId: input.memeId ?? null,
      clusterId: input.clusterId ?? null,
      packetId: input.packetId ?? null,
      mode: input.mode ?? null,
      reason: input.reason ?? null,
    })
    .catch((err) => logger.warn({ err, operation: input.operation }, "aiUsage: failed to record text usage"));
}

/**
 * Record one generated pro image to the cost meter. Fire-and-forget. Only call
 * on a SUCCESSFUL billed generation — refusals fall back to the branded card
 * and are NOT billed, so they record nothing.
 */
export function recordImageUsage(input: {
  operation: string;
  model?: string;
  authorSlug?: string | null;
  articleId?: string | null;
  memeId?: string | null;
  clusterId?: string | null;
  packetId?: string | null;
}): void {
  void db
    .insert(aiUsageEventsTable)
    .values({
      provider: "gemini",
      model: input.model ?? "gemini-3-pro-image-preview",
      operation: input.operation,
      inputTokens: 0,
      outputTokens: 0,
      webSearches: 0,
      images: 1,
      costUsd: IMAGE_USD.toFixed(6),
      authorSlug: input.authorSlug ?? null,
      articleId: input.articleId ?? null,
      memeId: input.memeId ?? null,
      clusterId: input.clusterId ?? null,
      packetId: input.packetId ?? null,
    })
    .catch((err) => logger.warn({ err, operation: input.operation }, "aiUsage: failed to record image usage"));
}


/**
 * Persist one Gemini text usage event. Unlike the older fire-and-forget helper,
 * this is awaitable so a long batch can re-check the Vault budget against the
 * cost it just incurred before submitting another provider job.
 */
export async function recordGeminiTextUsage(input: {
  operation: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  batch?: boolean;
  reason?: string | null;
}): Promise<number> {
  const costUsd = computeGeminiTextCost(input);
  await db.insert(aiUsageEventsTable).values({
    provider: "gemini",
    model: input.model,
    operation: input.operation,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    webSearches: 0,
    images: 0,
    costUsd: costUsd.toFixed(6),
    mode: input.batch ? "batch" : "standard",
    reason: input.reason ?? null,
  });
  return costUsd;
}

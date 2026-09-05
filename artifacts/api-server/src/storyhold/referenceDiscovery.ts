export type StoryholdReferenceLead = {
  title: string;
  url: string;
  snippet: string;
  date: string | null;
  domain: string;
};

const SEARCH_TIMEOUT_MS = 20_000;

export function isStoryholdLoreSearchConfigured() {
  return Boolean(process.env.PERPLEXITY_API_KEY?.trim());
}

function publicHttpUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

export async function discoverStoryholdLore(
  query: string,
  maximumResults = 10,
): Promise<StoryholdReferenceLead[]> {
  const key = process.env.PERPLEXITY_API_KEY?.trim();
  if (!key) throw new Error("PERPLEXITY_NOT_CONFIGURED");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(
      process.env.PERPLEXITY_SEARCH_URL?.trim() ||
        "https://api.perplexity.ai/search",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: query.slice(0, 800),
          max_results: Math.min(12, Math.max(1, maximumResults)),
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(`Lore search returned ${response.status}.`);
    }
    const payload = (await response.json()) as {
      results?: Array<{
        title?: unknown;
        url?: unknown;
        snippet?: unknown;
        date?: unknown;
        last_updated?: unknown;
      }>;
    };
    const leads: StoryholdReferenceLead[] = [];
    for (const result of Array.isArray(payload.results) ? payload.results : []) {
      const url = publicHttpUrl(result.url);
      if (!url) continue;
      leads.push({
        title:
          typeof result.title === "string" && result.title.trim()
            ? result.title.trim().slice(0, 300)
            : url.hostname,
        url: url.toString(),
        snippet:
          typeof result.snippet === "string"
            ? result.snippet.trim().slice(0, 3_000)
            : "",
        date:
          typeof (result.date ?? result.last_updated) === "string"
            ? String(result.date ?? result.last_updated).slice(0, 80)
            : null,
        domain: url.hostname.replace(/^www\./i, ""),
      });
    }
    return leads;
  } finally {
    clearTimeout(timeout);
  }
}

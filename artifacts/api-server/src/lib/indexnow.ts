import { logger } from "./logger";

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

/** Public IndexNow key. Hosted at /indexnow-key.txt and sent with each ping. */
export function getIndexNowKey(): string | null {
  const key = process.env["INDEXNOW_KEY"];
  return key && key.trim() ? key.trim() : null;
}

/**
 * Resolve the public base URL of the site (no trailing slash). Prefers an
 * explicit SITE_BASE_URL, then the first production REPLIT_DOMAINS entry, then
 * REPLIT_DEV_DOMAIN. Returns null when nothing usable is configured or when the
 * host is localhost — IndexNow rejects non-public hosts, so we skip pinging.
 */
export function getPublicBaseUrl(): string | null {
  const explicit = process.env["SITE_BASE_URL"];
  if (explicit && explicit.trim()) {
    return normalizeBase(explicit.trim());
  }
  const domains = process.env["REPLIT_DOMAINS"];
  if (domains && domains.trim()) {
    const first = domains.split(",")[0]?.trim();
    if (first) return normalizeBase(first);
  }
  const dev = process.env["REPLIT_DEV_DOMAIN"];
  if (dev && dev.trim()) return normalizeBase(dev.trim());
  return null;
}

function normalizeBase(value: string): string | null {
  const withProto = value.startsWith("http") ? value : `https://${value}`;
  let host: string;
  try {
    host = new URL(withProto).hostname;
  } catch {
    return null;
  }
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".local")) {
    return null;
  }
  return withProto.replace(/\/$/, "");
}

/**
 * Notify IndexNow (Bing and partners) that the given site-relative paths were
 * created, updated, or deleted. Best-effort and non-fatal: any missing config
 * or network error is logged and swallowed so it never breaks the request that
 * triggered it.
 */
export async function submitUrlsToIndexNow(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const key = getIndexNowKey();
  const base = getPublicBaseUrl();
  if (!key || !base) {
    logger.debug(
      { hasKey: Boolean(key), hasBase: Boolean(base) },
      "IndexNow ping skipped (missing key or public base url)",
    );
    return;
  }

  const host = new URL(base).hostname;
  const urlList = Array.from(
    new Set(paths.map((p) => `${base}${p.startsWith("/") ? p : `/${p}`}`)),
  );

  try {
    const res = await fetch(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host,
        key,
        keyLocation: `${base}/indexnow-key.txt`,
        urlList,
      }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, count: urlList.length }, "IndexNow ping non-OK response");
    } else {
      logger.info({ count: urlList.length }, "IndexNow ping submitted");
    }
  } catch (err) {
    logger.warn({ err, count: urlList.length }, "IndexNow ping failed");
  }
}

/** Ping IndexNow for one or more article slugs (plus the homepage + sitemap). */
export async function pingArticleSlugs(slugs: string[]): Promise<void> {
  const unique = Array.from(new Set(slugs.filter(Boolean)));
  if (unique.length === 0) return;
  const paths = ["/", "/sitemap.xml", ...unique.map((s) => `/article/${s}`)];
  await submitUrlsToIndexNow(paths);
}

import type { RequestHandler } from "express";

/**
 * Trusted browser origins for CORS and CSRF (Origin/Referer) checks.
 *
 * The site frontend and this API are served from the same host through the
 * Replit reverse proxy (path-based routing), so legitimate browser requests
 * carry the site's own origin. We additionally trust the production custom
 * domains and any Replit-hosted dev/preview/deploy domain.
 */

function normalizeOrigin(value: string | undefined | null): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`).origin;
  } catch {
    return null;
  }
}

const STATIC_TRUSTED_ORIGINS = new Set<string>([
  "https://brainhook.net",
  "https://www.brainhook.net",
]);

// Explicitly configured site base URL.
{
  const o = normalizeOrigin(process.env["SITE_BASE_URL"]);
  if (o) STATIC_TRUSTED_ORIGINS.add(o);
}

// Published Replit domains (comma-separated) and the current dev domain.
for (const d of (process.env["REPLIT_DOMAINS"] ?? "").split(",")) {
  const o = normalizeOrigin(d);
  if (o) STATIC_TRUSTED_ORIGINS.add(o);
}
{
  const o = normalizeOrigin(process.env["REPLIT_DEV_DOMAIN"]);
  if (o) STATIC_TRUSTED_ORIGINS.add(o);
}

// Replit-hosted dev/preview/deploy domains use a rotating hash subdomain. We
// only trust them by pattern OUTSIDE production (the dev preview origin rotates
// and isn't known ahead of time). In production the trust set is strict: only
// the explicit origins above (brainhook.net + www, SITE_BASE_URL, REPLIT_DOMAINS,
// REPLIT_DEV_DOMAIN) are trusted, so an arbitrary attacker-controlled
// *.replit.app/.dev origin is NOT treated as same-site.
const REPLIT_HOST_RE = /^https:\/\/([a-z0-9-]+\.)*(replit\.dev|replit\.app|repl\.co|replit\.com)$/i;
const ALLOW_REPLIT_WILDCARD = process.env["NODE_ENV"] !== "production";

export function isTrustedOrigin(
  origin: string | null | undefined,
  // Exposed for tests so the production (wildcard-off) path can be exercised
  // without mutating process.env. Defaults to the module-level gate.
  { allowReplitWildcard = ALLOW_REPLIT_WILDCARD }: { allowReplitWildcard?: boolean } = {},
): boolean {
  if (!origin) return false;
  if (STATIC_TRUSTED_ORIGINS.has(origin)) return true;
  if (allowReplitWildcard && REPLIT_HOST_RE.test(origin)) return true;
  return false;
}

export function trustedOriginsSnapshot(): string[] {
  return [...STATIC_TRUSTED_ORIGINS];
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF defense-in-depth for state-changing admin routes: require that unsafe
 * methods originate from a trusted site origin (checked via the Origin header,
 * falling back to Referer). Safe methods (GET/HEAD/OPTIONS) pass through.
 *
 * Modern browsers always send an Origin header on cross- and same-origin
 * unsafe requests, so a missing/untrusted origin on a mutation is rejected.
 */
export const requireTrustedOrigin: RequestHandler = (req, res, next) => {
  if (!MUTATING_METHODS.has(req.method)) {
    next();
    return;
  }
  const origin = req.get("origin");
  let candidate: string | null = origin ?? null;
  if (!candidate) {
    const referer = req.get("referer");
    if (referer) {
      try {
        candidate = new URL(referer).origin;
      } catch {
        candidate = null;
      }
    }
  }
  if (isTrustedOrigin(candidate)) {
    next();
    return;
  }
  req.log?.warn(
    { url: req.originalUrl, method: req.method, origin, referer: req.get("referer") },
    "Blocked admin mutation from untrusted origin",
  );
  res.status(403).json({ error: "Forbidden: untrusted origin" });
};

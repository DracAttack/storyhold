import type { RequestHandler } from "express";
import session from "express-session";
import ConnectPgSimple from "connect-pg-simple";
import pg from "pg";
import { logger } from "./logger";

/**
 * Admin gating for the BPD-isms API.
 *
 * This service has no login of its own. Rather than invent a second one, it
 * reuses the main BrainHook admin session: both services share the same
 * Postgres (`DATABASE_URL`), the same `user_sessions` table, the same
 * `SESSION_SECRET`, and the same `cm.sid` cookie name — and both are served
 * from the same public host via path routing, so the cookie set by
 * /admin/login on the main API flows to /bpdisms/api automatically. This
 * middleware only READS sessions (it never creates them; `saveUninitialized:
 * false`, and there is no login route here).
 *
 * Required env (already present in the shared deployment): DATABASE_URL,
 * SESSION_SECRET, ADMIN_EMAILS. If SESSION_SECRET is missing the service fails
 * closed: every non-health request is rejected rather than silently running
 * open. requireAdmin additionally re-checks the ADMIN_EMAILS allowlist (same as
 * artifacts/api-server/src/lib/auth.ts) so removing someone from the allowlist
 * revokes their bpdisms access immediately, not just at session expiry.
 */

function parseEmailList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const ADMIN_EMAILS_SET = new Set([
  ...parseEmailList(process.env["ADMIN_EMAILS"]),
  ...parseEmailList(process.env["ADMIN_EMAIL"]),
]);

const SESSION_SECRET = process.env["SESSION_SECRET"];

declare module "express-session" {
  interface SessionData {
    adminEmail?: string;
  }
}

function buildSessionMiddleware(): RequestHandler | null {
  if (!SESSION_SECRET) return null;
  const PgStore = ConnectPgSimple(session);
  const pgPool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });
  // Same guard as the shared @workspace/db pool: an idle client dropped by the
  // DB server must not surface as an unhandled 'error' event (that would crash
  // the process). Log and let the pool reconnect.
  pgPool.on("error", (err) => {
    logger.error({ err }, "bpdisms session pg pool idle client error (recovered)");
  });
  // Cookie config MUST match artifacts/api-server/src/lib/auth.ts exactly (name,
  // secret, sameSite, secure) or the shared session cookie won't validate here.
  return session({
    store: new PgStore({ pool: pgPool, createTableIfMissing: true, tableName: "user_sessions" }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env["NODE_ENV"] === "production",
      maxAge: 1000 * 60 * 60 * 24 * 30,
    },
    name: "cm.sid",
  });
}

export const sessionMiddleware: RequestHandler | null = buildSessionMiddleware();

if (!sessionMiddleware) {
  logger.error(
    "SESSION_SECRET is not set — bpdisms API will reject all non-health requests (failing closed).",
  );
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS_SET.has(email.trim().toLowerCase());
}

/**
 * A session only carries `adminEmail` after the main API's allowlist-verified
 * login, and the cookie is signed with the shared secret. We still re-check the
 * allowlist here (mirrors the main API's requireAdmin) so revocation is
 * immediate: 401 with no session, 403 for a session whose email is no longer
 * allowlisted.
 */
export const requireAdmin: RequestHandler = (req, res, next) => {
  if (!sessionMiddleware) {
    res.status(503).json({ error: "auth not configured" });
    return;
  }
  const email = req.session?.adminEmail;
  if (!email) {
    res.status(401).json({ error: "Unauthorized — sign in at /admin/login first" });
    return;
  }
  if (!isAdminEmail(email)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
};

// ── Trusted origins (CORS allowlist + CSRF gate on mutations) ────────────────
// Mirrors artifacts/api-server/src/lib/origins.ts: explicit production origins
// plus Replit-hosted dev/preview domains outside production only.

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
{
  const o = normalizeOrigin(process.env["SITE_BASE_URL"]);
  if (o) STATIC_TRUSTED_ORIGINS.add(o);
}
for (const d of (process.env["REPLIT_DOMAINS"] ?? "").split(",")) {
  const o = normalizeOrigin(d);
  if (o) STATIC_TRUSTED_ORIGINS.add(o);
}
{
  const o = normalizeOrigin(process.env["REPLIT_DEV_DOMAIN"]);
  if (o) STATIC_TRUSTED_ORIGINS.add(o);
}

const REPLIT_HOST_RE = /^https:\/\/([a-z0-9-]+\.)*(replit\.dev|replit\.app|repl\.co|replit\.com)$/i;
const ALLOW_REPLIT_WILDCARD = process.env["NODE_ENV"] !== "production";

export function isTrustedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  if (STATIC_TRUSTED_ORIGINS.has(origin)) return true;
  if (ALLOW_REPLIT_WILDCARD && REPLIT_HOST_RE.test(origin)) return true;
  return false;
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF defense-in-depth: with cookie-based auth, state-changing requests must
 * originate from a trusted site origin (Origin header, falling back to
 * Referer). Safe methods pass through.
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
    "bpdisms: blocked mutation from untrusted origin",
  );
  res.status(403).json({ error: "Forbidden: untrusted origin" });
};

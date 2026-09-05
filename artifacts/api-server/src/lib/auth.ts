import type { Request, RequestHandler } from "express";
import session from "express-session";
import ConnectPgSimple from "connect-pg-simple";
import bcrypt from "bcryptjs";
import pg from "pg";
import { createHash, timingSafeEqual } from "node:crypto";
import { logger } from "./logger";
import { hashEmail } from "./pii";

function parseEmailList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const ADMIN_EMAILS_LIST = Array.from(
  new Set([
    ...parseEmailList(process.env["ADMIN_EMAILS"]),
    ...parseEmailList(process.env["ADMIN_EMAIL"]),
  ]),
);
const ADMIN_EMAILS_SET = new Set(ADMIN_EMAILS_LIST);
const ADMIN_PASSWORD_HASH = (process.env["ADMIN_PASSWORD_HASH"] ?? "").trim();
const ADMIN_PASSWORD_IS_HASHED = /^\$2[aby]\$\d{2}\$/.test(ADMIN_PASSWORD_HASH);
const SESSION_SECRET = process.env["SESSION_SECRET"];

if (ADMIN_EMAILS_LIST.length === 0 || !ADMIN_PASSWORD_HASH) {
  throw new Error(
    "Admin allowlist not configured. Set ADMIN_EMAILS (comma-separated) and ADMIN_PASSWORD_HASH before starting the server.",
  );
}
if (!SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set.");
}
if (!ADMIN_PASSWORD_IS_HASHED) {
  logger.warn(
    "ADMIN_PASSWORD_HASH is not a bcrypt hash; comparing the admin password in plaintext. Supported, but a bcrypt hash is recommended.",
  );
}

declare module "express-session" {
  interface SessionData {
    adminEmail?: string;
  }
}

const PgStore = ConnectPgSimple(session);
const pgPool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });

// Same guard as the shared @workspace/db pool: an idle client dropped by the
// DB server must not become an unhandled 'error' event (that kills the whole
// process and crash-looped production). Log and let the pool reconnect.
pgPool.on("error", (err) => {
  logger.error({ err }, "Session-store pg pool idle client error (recovered, pool will reconnect)");
});

export const sessionMiddleware: RequestHandler = session({
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

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS_SET.has(email.trim().toLowerCase());
}

export function getAdminEmails(): string[] {
  return [...ADMIN_EMAILS_LIST];
}

function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export async function verifyCredentials(email: string, password: string): Promise<string | null> {
  const normalized = email.trim().toLowerCase();
  if (!ADMIN_EMAILS_SET.has(normalized)) return null;
  const ok = ADMIN_PASSWORD_IS_HASHED
    ? await bcrypt.compare(password, ADMIN_PASSWORD_HASH)
    : constantTimeEquals(password, ADMIN_PASSWORD_HASH);
  return ok ? normalized : null;
}

export const requireAdmin: RequestHandler = (req, res, next) => {
  const sessionEmail = req.session?.adminEmail;
  if (!sessionEmail) {
    // Log so we can see WHY a request was rejected — most often a stale or
    // missing cookie. Helps diagnose the recurring "401 on author detail"
    // report instead of silently failing.
    req.log?.warn(
      { url: req.originalUrl, hasCookie: Boolean(req.headers.cookie), sessionId: req.sessionID },
      "requireAdmin: no adminEmail in session",
    );
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!isAdminEmail(sessionEmail)) {
    req.log?.warn({ url: req.originalUrl, emailHash: hashEmail(sessionEmail) }, "requireAdmin: email not on allowlist");
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
};

export const requireAuth = requireAdmin;

export async function getRequestAdminEmail(req: Request): Promise<string | null> {
  const email = req.session?.adminEmail?.toLowerCase() ?? null;
  return isAdminEmail(email) ? email : null;
}

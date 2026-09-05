import { Router, type IRouter, type Request } from "express";
import { z } from "zod/v4";
import { isAdminEmail, verifyCredentials } from "../../lib/auth";
import { logger } from "../../lib/logger";
import { hashEmail } from "../../lib/pii";

const router: IRouter = Router();

const loginSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const attempts = new Map<string, { count: number; resetAt: number }>();

// Expired entries are otherwise only evicted when the same key returns, so an
// attacker rotating IPs grows the map without bound until a restart. Sweep
// periodically; `unref()` so the timer never keeps the process alive.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (v.resetAt < now) attempts.delete(k);
}, 10 * 60 * 1000).unref();

function clientKey(req: Request): string {
  return (req.ip ?? req.socket.remoteAddress ?? "unknown");
}

function checkRate(key: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 0, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfterSec: 0 };
  }
  if (entry.count >= MAX_ATTEMPTS) {
    return { allowed: false, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { allowed: true, retryAfterSec: 0 };
}

function recordFailure(key: string): void {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  entry.count += 1;
}

function clearFailures(key: string): void {
  attempts.delete(key);
}

router.post("/login", async (req, res) => {
  const key = clientKey(req);
  const rate = checkRate(key);
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "Too many attempts. Try again later." });
    return;
  }

  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const verifiedEmail = await verifyCredentials(parsed.data.email, parsed.data.password);
  if (!verifiedEmail) {
    recordFailure(key);
    logger.warn({ key, emailHash: hashEmail(parsed.data.email) }, "Failed admin login attempt");
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  // Prevent session fixation: regenerate before storing identity.
  req.session.regenerate((regenErr) => {
    if (regenErr) {
      res.status(500).json({ error: "Session error" });
      return;
    }
    req.session.adminEmail = verifiedEmail;
    req.session.save((saveErr) => {
      if (saveErr) {
        res.status(500).json({ error: "Session error" });
        return;
      }
      clearFailures(key);
      res.json({ email: verifiedEmail });
    });
  });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("cm.sid");
    res.status(204).end();
  });
});

// IMPORTANT: do not gate /me with requireAdmin. We want the unauthenticated
// branch to actively clean up stale session state from before the cm.sid
// rename / allowlist enforcement landed — otherwise the browser holds onto a
// dead cookie and every subsequent admin request 401s until the user manually
// clears cookies. Symptom seen by the editor: clicking into an author shows
// "Unauthorized" even after a fresh login.
router.get("/me", (req, res) => {
  const email = req.session?.adminEmail;
  if (email && isAdminEmail(email)) {
    req.session.touch();
    res.json({ email });
    return;
  }
  // No (or no-longer-valid) identity. Regenerate the session and clear the
  // stale cm.sid cookie so the browser stops sending a dead one.
  req.session.regenerate(() => {
    res.clearCookie("cm.sid");
    res.status(401).json({ error: "Unauthorized" });
  });
});

export default router;

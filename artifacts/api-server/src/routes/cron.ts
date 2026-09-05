import { Router, type IRouter } from "express";
import { timingSafeEqual } from "node:crypto";
import { runCronTick } from "../services/cronTick";

const router: IRouter = Router();

// Constant-time token comparison so a wrong token can't be guessed by timing.
function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Externally-triggered scheduler tick, hit by UptimeRobot (~every 5 min) to
// drive all due scheduled work — replacing in-process node-cron, which is
// unreliable on autoscale (no instance to fire the timer when idle; duplicate
// fires when scaled out). Public (not behind the admin session) so the pinger
// can reach it, but does NOTHING without the valid token. UptimeRobot's free
// tier sends a plain GET and can't reliably set headers, so the token is
// accepted via ?token= over HTTPS (the request logger strips the query string,
// so the token is never logged) — an X-Cron-Token header is also accepted.
// Returns promptly; heavy jobs run fire-and-forget inside runCronTick.
router.all("/cron/tick", async (req, res) => {
  const expected = process.env["CRON_TICK_TOKEN"]?.trim();
  if (!expected) {
    req.log.error("cron tick: CRON_TICK_TOKEN is not configured — refusing");
    res.status(503).json({ error: "cron tick not configured" });
    return;
  }

  const queryToken = typeof req.query["token"] === "string" ? req.query["token"] : undefined;
  const headerToken =
    typeof req.headers["x-cron-token"] === "string" ? req.headers["x-cron-token"] : undefined;
  const provided = (queryToken ?? headerToken)?.trim();

  if (!tokenMatches(provided, expected)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  try {
    const summary = await runCronTick();
    res.json({ ok: true, ...summary });
  } catch (e) {
    req.log.error({ err: e }, "cron tick failed");
    res.status(500).json({ error: "cron tick failed" });
  }
});

export default router;

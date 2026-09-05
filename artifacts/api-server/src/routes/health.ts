import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

// Set to true by the startup sequence once seed + essential initialization
// succeed. The readiness endpoint below returns 503 until this is set so the
// deployment platform never routes real traffic to a still-booting instance.
let ready = false;

/**
 * Called by the startup sequence (index.ts) after runStartupSeed and
 * ensureDefaultShareCard complete successfully.
 */
export function markServerReady(): void {
  ready = true;
}

// Liveness: proves the process is alive and the event loop is running.
// Always returns 200 so the platform knows the process has not crashed.
router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// Readiness: returns 503 until the startup seed + initialization sequence
// finishes. The brief window between app.listen() and seed completion means
// /healthz would otherwise return 200 before the DB is verified and tables
// are confirmed — routing traffic to an incompletely-booted instance.
router.get("/healthz/ready", (_req, res) => {
  if (!ready) {
    res.status(503).json({ status: "starting" });
    return;
  }
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

export default router;

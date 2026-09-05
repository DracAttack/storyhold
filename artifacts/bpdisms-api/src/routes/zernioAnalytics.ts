import { Router, type IRouter } from "express";
import { getAnalytics, getBestTimes, getAccounts } from "../services/zernio";

const router: IRouter = Router();

function proxyRoute(
  path: string,
  fetcher: () => Promise<
    { ok: true; data: unknown } | { ok: false; status: number; message: string }
  >,
  label: string,
): void {
  router.get(path, async (req, res): Promise<void> => {
    try {
      const result = await fetcher();
      if (!result.ok) {
        res.status(502).json({ error: result.message });
        return;
      }
      res.json(result.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      req.log.error({ err }, `Zernio ${label} fetch failed`);
      res.status(502).json({ error: `Could not reach Zernio: ${message}` });
    }
  });
}

proxyRoute("/zernio/analytics", getAnalytics, "analytics");
proxyRoute("/zernio/best-times", getBestTimes, "best-times");
proxyRoute("/zernio/accounts", getAccounts, "accounts");

export default router;

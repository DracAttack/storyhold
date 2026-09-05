import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { getRequestAdminEmail } from "../../lib/auth";
import {
  getOrCreateSettings,
  updateSettings,
  listNotifications,
  getNotification,
  sendDailyDigest,
} from "../../services/notifications";

const router: IRouter = Router();

router.get("/settings", async (req, res) => {
  const email = await getRequestAdminEmail(req);
  if (!email) { res.status(401).json({ error: "Unauthorized" }); return; }
  const s = await getOrCreateSettings(email);
  res.json(s);
});

router.patch("/settings", async (req, res) => {
  const email = await getRequestAdminEmail(req);
  if (!email) { res.status(401).json({ error: "Unauthorized" }); return; }
  const parsed = z.object({ digestEnabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid body" }); return; }
  const s = await updateSettings(email, parsed.data.digestEnabled);
  res.json(s);
});

router.get("/notifications", async (_req, res) => {
  const items = await listNotifications();
  res.json({
    items: items.map((n) => ({
      id: n.id,
      type: n.type,
      subject: n.subject,
      recipients: n.recipients,
      createdAt: n.createdAt,
      payload: n.payload,
    })),
  });
});

router.get("/notifications/:id", async (req, res) => {
  const item = await getNotification(req.params.id);
  if (!item) { res.status(404).json({ error: "Not found" }); return; }
  res.json(item);
});

router.post("/notifications/send-test-digest", async (_req, res) => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const r = await sendDailyDigest({ draftsCreated: 0, articlesPublished: 0, since });
  res.json(r);
});

export default router;

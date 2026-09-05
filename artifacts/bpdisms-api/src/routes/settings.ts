import { Router, type IRouter } from "express";
import { db, bpdismsAppSettingsTable, bpdismsPostingSlotsTable } from "@workspace/db";
import { z } from "zod";
import { isPostingAllowed } from "../services/zernio";

const router: IRouter = Router();

router.get("/settings", async (_req, res): Promise<void> => {
  const [settings] = await db.select().from(bpdismsAppSettingsTable).limit(1);
  const slots = await db
    .select()
    .from(bpdismsPostingSlotsTable)
    .orderBy(bpdismsPostingSlotsTable.timeOfDay);

  const postingEnabled = isPostingAllowed();

  if (!settings) {
    res.json({
      id: null,
      timezone: "America/Phoenix",
      destinationId: null,
      postingEnabled,
      postingSlots: slots,
    });
    return;
  }

  res.json({ ...settings, postingEnabled, postingSlots: slots });
});

const UpdateSettingsSchema = z.object({
  timezone: z.string().optional(),
  destinationId: z.string().nullable().optional(),
});

router.patch("/settings", async (req, res): Promise<void> => {
  const parsed = UpdateSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db.select().from(bpdismsAppSettingsTable).limit(1);

  let settings;
  if (!existing) {
    const [created] = await db
      .insert(bpdismsAppSettingsTable)
      .values({
        timezone: parsed.data.timezone ?? "America/Phoenix",
        destinationId: parsed.data.destinationId ?? null,
      })
      .returning();
    settings = created;
  } else {
    const [updated] = await db
      .update(bpdismsAppSettingsTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .returning();
    settings = updated;
  }

  res.json(settings);
});

export default router;

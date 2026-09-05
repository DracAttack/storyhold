import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, bpdismsPostingSlotsTable } from "@workspace/db";
import { z } from "zod";

const router: IRouter = Router();

router.get("/posting-slots", async (_req, res): Promise<void> => {
  const slots = await db
    .select()
    .from(bpdismsPostingSlotsTable)
    .orderBy(bpdismsPostingSlotsTable.timeOfDay);
  res.json(slots);
});

const CreateSlotSchema = z.object({
  timeOfDay: z.string().regex(/^\d{2}:\d{2}$/),
  daysOfWeekJson: z.string().optional().default('["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]'),
  enabled: z.boolean().optional().default(true),
});

router.post("/posting-slots", async (req, res): Promise<void> => {
  const parsed = CreateSlotSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [slot] = await db
    .insert(bpdismsPostingSlotsTable)
    .values(parsed.data)
    .returning();

  res.status(201).json(slot);
});

const UpdateSlotSchema = z.object({
  timeOfDay: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  daysOfWeekJson: z.string().optional(),
  enabled: z.boolean().optional(),
});

router.patch("/posting-slots/:id", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId ?? "", 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const parsed = UpdateSlotSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [slot] = await db
    .update(bpdismsPostingSlotsTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(bpdismsPostingSlotsTable.id, id))
    .returning();

  if (!slot) {
    res.status(404).json({ error: "Slot not found" });
    return;
  }

  res.json(slot);
});

router.delete("/posting-slots/:id", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId ?? "", 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [slot] = await db
    .delete(bpdismsPostingSlotsTable)
    .where(eq(bpdismsPostingSlotsTable.id, id))
    .returning();

  if (!slot) {
    res.status(404).json({ error: "Slot not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;

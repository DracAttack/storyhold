import { Router, type IRouter } from "express";
import { eq, desc, asc, inArray, and, lt, isNotNull } from "drizzle-orm";
import { db, bpdismsSocialPostsTable, bpdismsPostingSlotsTable, bpdismsAppSettingsTable } from "@workspace/db";
import { z } from "zod";
import { DateTime } from "luxon";
import { findConsecutiveSlots } from "../services/queueScheduler";
import { scheduleFacebookPost, cancelPost, getPostStatus } from "../services/zernio";
import type pino from "pino";

const router: IRouter = Router();

/**
 * Lazily sync overdue "scheduled" posts against Zernio so they transition to
 * posted/failed/cancelled once Zernio has actually published them.
 */
async function syncOverdueScheduledPosts(log: pino.Logger): Promise<void> {
  const overdue = await db
    .select()
    .from(bpdismsSocialPostsTable)
    .where(
      and(
        eq(bpdismsSocialPostsTable.status, "scheduled"),
        isNotNull(bpdismsSocialPostsTable.providerPostId),
        lt(bpdismsSocialPostsTable.scheduledAt, new Date()),
      ),
    )
    .limit(10);

  const syncOne = async (post: (typeof overdue)[number]): Promise<void> => {
    try {
      const result = await getPostStatus(post.providerPostId!);
      if ("unsupported" in result) return;
      const zStatus = result.status.toLowerCase();

      if (zStatus === "published" || zStatus === "posted") {
        await db
          .update(bpdismsSocialPostsTable)
          .set({
            status: "posted",
            postedAt: new Date(),
            providerResponseJson: result.responseJson,
            updatedAt: new Date(),
          })
          .where(and(eq(bpdismsSocialPostsTable.id, post.id), eq(bpdismsSocialPostsTable.status, "scheduled")));
      } else if (zStatus === "failed") {
        await db
          .update(bpdismsSocialPostsTable)
          .set({
            status: "failed",
            errorMessage: "Zernio reported the post failed to publish",
            providerResponseJson: result.responseJson,
            updatedAt: new Date(),
          })
          .where(and(eq(bpdismsSocialPostsTable.id, post.id), eq(bpdismsSocialPostsTable.status, "scheduled")));
      } else if (zStatus === "cancelled" || zStatus === "deleted" || zStatus === "unknown") {
        // "unknown" = 404 on Zernio: the post no longer exists there, so it will never publish
        await db
          .update(bpdismsSocialPostsTable)
          .set({
            status: "cancelled",
            providerResponseJson: result.responseJson,
            updatedAt: new Date(),
          })
          .where(and(eq(bpdismsSocialPostsTable.id, post.id), eq(bpdismsSocialPostsTable.status, "scheduled")));
      }
    } catch (err) {
      log.warn({ err, postId: post.id }, "Failed to sync post status from Zernio");
    }
  };

  await Promise.allSettled(overdue.map(syncOne));
}

router.get("/posts", async (req, res): Promise<void> => {
  await syncOverdueScheduledPosts(req.log).catch((err) => {
    req.log.warn({ err }, "Overdue post status sync failed");
  });

  const statusFilter = req.query.status as string | undefined;

  let query = db.select().from(bpdismsSocialPostsTable).$dynamic();
  if (statusFilter && statusFilter !== "all") {
    if (statusFilter === "upcoming") {
      query = query.where(inArray(bpdismsSocialPostsTable.status, ["draft", "scheduling", "scheduled"]));
    } else if (statusFilter === "posted") {
      query = query.where(eq(bpdismsSocialPostsTable.status, "posted"));
    } else if (statusFilter === "failed") {
      query = query.where(eq(bpdismsSocialPostsTable.status, "failed"));
    } else if (statusFilter === "history") {
      query = query.where(inArray(bpdismsSocialPostsTable.status, ["posted", "cancelled"]));
      const posts = await query.orderBy(desc(bpdismsSocialPostsTable.scheduledAt));
      res.json(posts);
      return;
    }
  }

  const posts = await query.orderBy(asc(bpdismsSocialPostsTable.scheduledAt));
  res.json(posts);
});

const QueueItemSchema = z.object({
  imageUrl: z.string().url(),
  imageStorageKey: z.string(),
  originalFilename: z.string(),
  caption: z.string().default(""),
});

const QueueRequestSchema = z.object({
  items: z.array(QueueItemSchema).min(1),
});

router.post("/posts/queue", async (req, res): Promise<void> => {
  const parsed = QueueRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [settings] = await db.select().from(bpdismsAppSettingsTable).limit(1);
  const timezone = settings?.timezone ?? "America/Phoenix";
  const destinationId = settings?.destinationId;

  if (!destinationId) {
    res.status(400).json({
      error: "Facebook destination is not configured. Go to Settings to add your Facebook Page ID.",
    });
    return;
  }

  const slots = await db
    .select()
    .from(bpdismsPostingSlotsTable)
    .orderBy(bpdismsPostingSlotsTable.timeOfDay);

  const existingPosts = await db
    .select()
    .from(bpdismsSocialPostsTable)
    .where(inArray(bpdismsSocialPostsTable.status, ["draft", "scheduling", "scheduled"]))
    .orderBy(asc(bpdismsSocialPostsTable.scheduledAt));

  const scheduledTimes = findConsecutiveSlots({
    postingSlots: slots,
    existingScheduledPosts: existingPosts,
    timezone,
    after: new Date(),
    count: parsed.data.items.length,
  });

  if (scheduledTimes.length < parsed.data.items.length) {
    res.status(400).json({
      error: "Not enough available posting slots. Please add more slots in Settings.",
    });
    return;
  }

  const results: Array<{ success: boolean; post?: unknown; error?: string }> = [];

  for (let i = 0; i < parsed.data.items.length; i++) {
    const item = parsed.data.items[i]!;
    const scheduledAt = scheduledTimes[i]!;

    const [inserted] = await db
      .insert(bpdismsSocialPostsTable)
      .values({
        imageUrl: item.imageUrl,
        imageStorageKey: item.imageStorageKey,
        originalFilename: item.originalFilename,
        caption: item.caption,
        scheduledAt,
        timezone,
        status: "scheduling",
        provider: "zernio",
      })
      .returning();

    if (!inserted) {
      results.push({ success: false, error: "Failed to create post record" });
      continue;
    }

    try {
      const zernioResult = await scheduleFacebookPost({
        imageUrl: item.imageUrl,
        caption: item.caption,
        scheduledAt,
        timezone,
        destinationId,
      });

      const [updated] = await db
        .update(bpdismsSocialPostsTable)
        .set({
          status: "scheduled",
          providerPostId: zernioResult.providerPostId,
          providerResponseJson: zernioResult.responseJson,
          updatedAt: new Date(),
        })
        .where(eq(bpdismsSocialPostsTable.id, inserted.id))
        .returning();

      if (!updated) {
        // Post was deleted while scheduling was in flight — cancel the Zernio post to avoid an orphan
        await cancelPost(zernioResult.providerPostId).catch((cancelErr) => {
          req.log.error(
            { postId: inserted.id, providerPostId: zernioResult.providerPostId, err: cancelErr },
            "Failed to cancel orphaned Zernio post after concurrent delete",
          );
        });
        results.push({ success: false, error: "Post was deleted while scheduling was in progress" });
        continue;
      }

      results.push({ success: true, post: updated });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      const [updated] = await db
        .update(bpdismsSocialPostsTable)
        .set({
          status: "failed",
          errorMessage,
          updatedAt: new Date(),
        })
        .where(eq(bpdismsSocialPostsTable.id, inserted.id))
        .returning();

      results.push({ success: false, post: updated, error: errorMessage });
    }
  }

  res.status(201).json({ results });
});

router.post("/posts/:id/retry", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId ?? "", 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [post] = await db
    .select()
    .from(bpdismsSocialPostsTable)
    .where(eq(bpdismsSocialPostsTable.id, id));

  if (!post) {
    res.status(404).json({ error: "Post not found" });
    return;
  }

  const [settings] = await db.select().from(bpdismsAppSettingsTable).limit(1);
  const timezone = settings?.timezone ?? "America/Phoenix";
  const destinationId = settings?.destinationId;

  if (!destinationId) {
    res.status(400).json({
      error: "Facebook destination is not configured. Go to Settings to add your Facebook Page ID.",
    });
    return;
  }

  let scheduledAt = post.scheduledAt;
  if (scheduledAt <= new Date()) {
    const slots = await db
      .select()
      .from(bpdismsPostingSlotsTable)
      .orderBy(bpdismsPostingSlotsTable.timeOfDay);

    const existingPosts = await db
      .select()
      .from(bpdismsSocialPostsTable)
      .where(inArray(bpdismsSocialPostsTable.status, ["draft", "scheduling", "scheduled"]))
      .orderBy(asc(bpdismsSocialPostsTable.scheduledAt));

    const [nextSlot] = findConsecutiveSlots({
      postingSlots: slots,
      existingScheduledPosts: existingPosts,
      timezone,
      after: new Date(),
      count: 1,
    });

    if (!nextSlot) {
      res.status(400).json({ error: "No available slots for retry" });
      return;
    }
    scheduledAt = nextSlot;
  }

  await db
    .update(bpdismsSocialPostsTable)
    .set({ status: "scheduling", errorMessage: null, updatedAt: new Date(), scheduledAt })
    .where(eq(bpdismsSocialPostsTable.id, id));

  try {
    const zernioResult = await scheduleFacebookPost({
      imageUrl: post.imageUrl,
      caption: post.caption,
      scheduledAt,
      timezone,
      destinationId,
    });

    const [updated] = await db
      .update(bpdismsSocialPostsTable)
      .set({
        status: "scheduled",
        providerPostId: zernioResult.providerPostId,
        providerResponseJson: zernioResult.responseJson,
        retryCount: post.retryCount + 1,
        scheduledAt,
        updatedAt: new Date(),
      })
      .where(eq(bpdismsSocialPostsTable.id, id))
      .returning();

    if (!updated) {
      // Post was deleted while scheduling was in flight — cancel the Zernio post to avoid an orphan
      await cancelPost(zernioResult.providerPostId).catch((cancelErr) => {
        req.log.error(
          { postId: id, providerPostId: zernioResult.providerPostId, err: cancelErr },
          "Failed to cancel orphaned Zernio post after concurrent delete",
        );
      });
      res.status(409).json({ error: "Post was deleted while scheduling was in progress." });
      return;
    }

    res.json(updated);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    const [updated] = await db
      .update(bpdismsSocialPostsTable)
      .set({
        status: "failed",
        errorMessage,
        retryCount: post.retryCount + 1,
        updatedAt: new Date(),
      })
      .where(eq(bpdismsSocialPostsTable.id, id))
      .returning();

    res.status(502).json({ error: errorMessage, post: updated });
  }
});

const UpdatePostSchema = z
  .object({
    caption: z.string().optional(),
    // Wall-clock time in the post's timezone, e.g. "2026-07-05T14:00"
    scheduledAtLocal: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Expected format YYYY-MM-DDTHH:mm")
      .optional(),
  })
  .refine((d) => d.caption !== undefined || d.scheduledAtLocal !== undefined, {
    message: "Provide a caption or a new scheduled time",
  });

router.patch("/posts/:id", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId ?? "", 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const parsed = UpdatePostSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [post] = await db
    .select()
    .from(bpdismsSocialPostsTable)
    .where(eq(bpdismsSocialPostsTable.id, id));

  if (!post) {
    res.status(404).json({ error: "Post not found" });
    return;
  }

  if (post.status === "posted" || post.status === "cancelled") {
    res.status(400).json({ error: "Cannot edit a post that has already been posted or cancelled." });
    return;
  }

  const newCaption = parsed.data.caption ?? post.caption ?? "";

  let newScheduledAt = post.scheduledAt;
  if (parsed.data.scheduledAtLocal !== undefined) {
    const zone = post.timezone || "America/Phoenix";
    const dt = DateTime.fromISO(parsed.data.scheduledAtLocal, { zone });
    if (!dt.isValid) {
      res.status(400).json({ error: `Invalid date/time: ${dt.invalidReason ?? "unknown"}` });
      return;
    }
    if (dt.toJSDate() <= new Date()) {
      res.status(400).json({ error: "The new posting time must be in the future." });
      return;
    }
    newScheduledAt = dt.toJSDate();
  }

  if (post.status === "scheduled" && post.providerPostId) {
    const [settings] = await db.select().from(bpdismsAppSettingsTable).limit(1);
    const destinationId = settings?.destinationId;

    if (!destinationId) {
      res.status(400).json({
        error: "Facebook destination is not configured. Go to Settings to add your Facebook Page ID.",
      });
      return;
    }

    const cancelResult = await cancelPost(post.providerPostId);
    if (!("cancelled" in cancelResult) || !cancelResult.cancelled) {
      const reason =
        "cancelled" in cancelResult ? cancelResult.message : "Zernio could not be reached";
      res.status(502).json({
        error: `Could not cancel the existing scheduled post on Zernio (${reason}). The post was not changed — please try again.`,
      });
      return;
    }

    try {
      const zernioResult = await scheduleFacebookPost({
        imageUrl: post.imageUrl,
        caption: newCaption,
        scheduledAt: newScheduledAt,
        timezone: post.timezone,
        destinationId,
      });

      const [updated] = await db
        .update(bpdismsSocialPostsTable)
        .set({
          caption: newCaption,
          scheduledAt: newScheduledAt,
          providerPostId: zernioResult.providerPostId,
          providerResponseJson: zernioResult.responseJson,
          updatedAt: new Date(),
        })
        .where(eq(bpdismsSocialPostsTable.id, id))
        .returning();

      res.json(updated);
      return;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      const [updated] = await db
        .update(bpdismsSocialPostsTable)
        .set({
          caption: newCaption,
          scheduledAt: newScheduledAt,
          status: "failed",
          errorMessage: `Post updated locally, but rescheduling on Zernio failed: ${errorMessage}`,
          updatedAt: new Date(),
        })
        .where(eq(bpdismsSocialPostsTable.id, id))
        .returning();

      res.status(502).json({ error: errorMessage, post: updated });
      return;
    }
  }

  const [updated] = await db
    .update(bpdismsSocialPostsTable)
    .set({ caption: newCaption, scheduledAt: newScheduledAt, updatedAt: new Date() })
    .where(eq(bpdismsSocialPostsTable.id, id))
    .returning();

  res.json(updated);
});

router.delete("/posts/:id", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId ?? "", 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [post] = await db
    .select()
    .from(bpdismsSocialPostsTable)
    .where(eq(bpdismsSocialPostsTable.id, id));

  if (!post) {
    res.status(404).json({ error: "Post not found" });
    return;
  }

  if (post.providerPostId && (post.status === "scheduled" || post.status === "scheduling")) {
    const cancelResult = await cancelPost(post.providerPostId);
    if (!("cancelled" in cancelResult) || !cancelResult.cancelled) {
      const reason =
        "cancelled" in cancelResult ? cancelResult.message : "Zernio could not be reached";
      res.status(502).json({
        error: `Could not cancel the scheduled post on Zernio (${reason}). The post was not deleted — please try again.`,
      });
      return;
    }
  }

  await db.delete(bpdismsSocialPostsTable).where(eq(bpdismsSocialPostsTable.id, id));

  res.sendStatus(204);
});

router.get("/posts/stats", async (_req, res): Promise<void> => {
  const posts = await db.select().from(bpdismsSocialPostsTable);
  const stats = {
    drafts: posts.filter((p) => p.status === "draft").length,
    scheduled: posts.filter((p) => ["scheduling", "scheduled"].includes(p.status)).length,
    posted: posts.filter((p) => p.status === "posted").length,
    failed: posts.filter((p) => p.status === "failed").length,
  };
  res.json(stats);
});

export default router;

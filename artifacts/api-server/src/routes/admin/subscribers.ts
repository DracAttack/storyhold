import { Router, type IRouter } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { db, subscribersTable, beatsTable, subscriberEmailEventsTable } from "@workspace/db";
import { desc, isNull, eq, and, isNotNull, inArray, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { sendWeeklyNewsletter, sendCustomBroadcast } from "../../services/weeklyNewsletter";

const router: IRouter = Router();

router.get("/subscribers", async (_req, res) => {
  // Only list active subscribers — readers who opted out (unsubscribedAt) or were
  // hard-suppressed (suppressedAt: bounce/complaint/manual) are excluded so the
  // list (and CSV export) never targets someone who shouldn't be emailed.
  const rows = await db
    .select()
    .from(subscribersTable)
    .where(and(isNull(subscribersTable.unsubscribedAt), isNull(subscribersTable.suppressedAt)))
    .orderBy(desc(subscribersTable.createdAt));
  res.json({
    total: rows.length,
    items: rows.map((r) => ({
      email: r.email,
      createdAt: r.createdAt.toISOString(),
      preferredCategory: r.preferredCategory,
      suppressedAt: null,
      suppressionReason: null,
    })),
  });
  return;
});

// Suppressed addresses (hard bounces, spam complaints, manual removals) for the
// admin dashboard. Records are never deleted, so this is the durable view of who
// was removed and why.
router.get("/subscribers/suppressed", async (_req, res) => {
  const rows = await db
    .select()
    .from(subscribersTable)
    .where(isNotNull(subscribersTable.suppressedAt))
    .orderBy(desc(subscribersTable.suppressedAt));
  res.json({
    total: rows.length,
    items: rows.map((r) => ({
      email: r.email,
      createdAt: r.createdAt.toISOString(),
      suppressedAt: r.suppressedAt ? r.suppressedAt.toISOString() : null,
      suppressionReason: r.suppressionReason,
    })),
  });
  return;
});

const removeSchema = z.object({
  emails: z.array(z.string()).min(1).max(5000),
});

// Manually suppress one or more addresses (a single removal from a row, or a
// pasted list of bad/bounced/false emails). Suppression — not deletion — keeps
// the audit trail and blocks silent re-subscribe. Addresses that aren't already
// subscribers are inserted as suppression-only rows so known-bad addresses are
// pre-blocked from ever subscribing. Registered before `/subscribers/:email`
// (methods differ, so there is no real collision).
router.post("/subscribers/remove", async (req, res) => {
  const parsed = removeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Provide a non-empty list of email addresses." });
    return;
  }
  // Accept either discrete entries or a pasted blob; split on commas/whitespace/
  // semicolons, normalize, and dedupe. A minimal shape check keeps obvious junk
  // out (full RFC validation is unnecessary for a suppression list).
  const emails = [
    ...new Set(
      parsed.data.emails
        .flatMap((e) => e.split(/[\s,;]+/))
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.length > 0 && e.includes("@") && e.includes(".")),
    ),
  ];
  if (emails.length === 0) {
    res.status(400).json({ error: "No valid email addresses provided." });
    return;
  }

  // Which requested addresses already exist (so we can report new vs existing).
  const existingRows = await db
    .select({ email: subscribersTable.email })
    .from(subscribersTable)
    .where(inArray(subscribersTable.email, emails));
  const existing = new Set(existingRows.map((r) => r.email));

  for (const email of emails) {
    await db
      .insert(subscribersTable)
      .values({
        email,
        unsubscribeToken: randomBytes(24).toString("hex"),
        suppressedAt: new Date(),
        suppressionReason: "manual",
        unsubscribedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: subscribersTable.email,
        // COALESCE preserves the earliest suppression timestamp and the original
        // (stronger) reason — re-removing a complained address keeps "complaint".
        set: {
          suppressedAt: sql`COALESCE(${subscribersTable.suppressedAt}, now())`,
          suppressionReason: sql`COALESCE(${subscribersTable.suppressionReason}, 'manual')`,
          unsubscribedAt: sql`COALESCE(${subscribersTable.unsubscribedAt}, now())`,
        },
      });
    // Audit trail entry (unified with webhook events). Synthetic svix id keeps the
    // unique (svix_id, email) index happy and marks this as an admin action.
    await db
      .insert(subscriberEmailEventsTable)
      .values({
        svixId: `manual-${randomUUID()}`,
        email,
        eventType: "manual.removed",
        reason: "manual",
        resendEmailId: null,
      })
      .onConflictDoNothing({
        target: [subscriberEmailEventsTable.svixId, subscriberEmailEventsTable.email],
      });
  }

  res.json({
    requested: emails.length,
    existing: existing.size,
    added: emails.length - existing.size,
  });
  return;
});

// Resolve a requested category slug to either a real beat slug or null
// ("everything"). Returns `{ ok: false }` when a non-empty slug doesn't match
// any beat so the caller can reject a forged/stale value.
async function resolveCategory(
  raw: string | null | undefined,
): Promise<{ ok: true; slug: string | null } | { ok: false }> {
  const requested = raw?.trim().toLowerCase() || null;
  if (!requested) return { ok: true, slug: null };
  const beat = await db
    .select({ slug: beatsTable.slug })
    .from(beatsTable)
    .where(eq(beatsTable.slug, requested))
    .limit(1);
  if (beat.length === 0) return { ok: false };
  return { ok: true, slug: requested };
}

const testSendSchema = z.object({
  email: z.string().email(),
  preferredCategory: z.string().nullable().optional(),
});

// Fire a one-off test of the weekly newsletter to any address so an admin can
// preview it. An unknown category transparently falls back to the general
// digest (the send service does the same), so this never hard-fails on a stale
// slug. Registered before `/subscribers/:email` for clarity (methods differ, so
// there is no actual route collision).
router.post("/subscribers/test-send", async (req, res) => {
  const parsed = testSendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "A valid email address is required." });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const cat = await resolveCategory(parsed.data.preferredCategory);
  const preferredCategory = cat.ok ? cat.slug : null;

  // Use the recipient's real unsubscribe token when they are already a
  // subscriber, otherwise mint a throwaway one so the test's opt-out link is
  // well-formed (it just won't resolve to a row).
  const existing = await db
    .select({ token: subscribersTable.unsubscribeToken })
    .from(subscribersTable)
    .where(eq(subscribersTable.email, email))
    .limit(1);
  const token = existing[0]?.token ?? randomBytes(24).toString("hex");

  const result = await sendWeeklyNewsletter(email, token, preferredCategory);
  res.json({
    delivered: result.delivered,
    provider: result.provider,
    skipped: result.skipped ?? null,
    categoryLabel: result.categoryLabel ?? null,
  });
  return;
});

const updateSchema = z.object({
  preferredCategory: z.string().nullable(),
});

// Change a subscriber's newsletter topic preference. `preferredCategory` is a
// beat slug, or null for the general "everything" digest. A non-empty slug that
// doesn't match a beat is rejected (400) so the stored value is always valid.
router.patch("/subscribers/:email", async (req, res) => {
  // Express already URL-decodes route params, so `req.params.email` is the raw
  // address (e.g. "a@b.com"). Normalize the same way signup does.
  const email = req.params.email.trim().toLowerCase();
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "preferredCategory must be a beat slug or null." });
    return;
  }
  const cat = await resolveCategory(parsed.data.preferredCategory);
  if (!cat.ok) {
    res.status(400).json({ error: "Unknown category." });
    return;
  }

  const updated = await db
    .update(subscribersTable)
    .set({ preferredCategory: cat.slug })
    .where(eq(subscribersTable.email, email))
    .returning();
  if (updated.length === 0) {
    res.status(404).json({ error: "Subscriber not found." });
    return;
  }
  const r = updated[0];
  res.json({
    email: r.email,
    createdAt: r.createdAt.toISOString(),
    preferredCategory: r.preferredCategory,
    suppressedAt: r.suppressedAt ? r.suppressedAt.toISOString() : null,
    suppressionReason: r.suppressionReason,
  });
  return;
});

const broadcastSchema = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10000),
});

/**
 * Fire a one-off custom broadcast to every active subscriber. Used by admins to
 * send an emergency or informational message with the same BrainHook branding as
 * the newsletter but a custom subject and body (e.g. "We had a delivery issue
 * last week, here's what happened"). Overlap-protected by a DB job lock.
 */
router.post("/subscribers/broadcast", async (req, res) => {
  const parsed = broadcastSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Subject and body are required." });
    return;
  }
  const { subject, body } = parsed.data;
  const result = await sendCustomBroadcast(subject.trim(), body.trim());
  if (!result.started && result.alreadyRunning) {
    res.status(409).json({ error: "A broadcast is already in progress." });
    return;
  }
  res.json({
    started: result.started,
    recipients: result.recipients ?? 0,
    sent: result.sent ?? 0,
    failed: result.failed ?? 0,
    skipped: result.skipped ?? null,
  });
  return;
});

export default router;

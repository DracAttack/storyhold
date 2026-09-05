import { Router, type IRouter } from "express";
import { randomBytes } from "node:crypto";
import { db, subscribersTable, subscriberEmailEventsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { verifySvixSignature } from "../lib/svix";

const router: IRouter = Router();

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Inbound Resend webhook (Svix-signed) that drives subscriber suppression.
 *
 * Mounted with `express.raw()` BEFORE the global `express.json()` parser (see
 * app.ts) so `req.body` is the exact bytes Resend sent — re-serializing the body
 * would change its signature and every request would fail verification.
 *
 * Handled events:
 *  - email.bounced    -> suppress (excluded from all sends), reason = bounce subtype
 *  - email.suppressed -> suppress (Resend's own suppression list), reason recorded
 *  - email.complained -> suppress AND unsubscribe (excluded from ALL email)
 *
 * Subscriber rows are never deleted. Every event is recorded in
 * `subscriber_email_events` (audit + idempotency). Idempotency is enforced by the
 * unique (svix_id, email) index: a retried delivery conflicts and is skipped, so
 * the suppression update runs exactly once per address. Always returns 200 on a
 * valid (verified) request so Resend does not retry events we have accepted.
 */
router.post("/resend", async (req, res) => {
  const secret = process.env["RESEND_WEBHOOK_SECRET"];
  if (!secret) {
    req.log.error("RESEND_WEBHOOK_SECRET is not set — cannot verify Resend webhook");
    res.status(500).json({ error: "Webhook not configured" });
    return;
  }

  // With express.raw mounted on this path, req.body is a Buffer. Be defensive in
  // case the mount order ever changes (a parsed body can't be re-verified).
  const raw = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(typeof req.body === "string" ? req.body : "");
  if (raw.length === 0) {
    res.status(400).json({ error: "Empty body" });
    return;
  }

  const svixId = req.header("svix-id");
  const verify = verifySvixSignature(secret, raw, {
    id: svixId,
    timestamp: req.header("svix-timestamp"),
    signature: req.header("svix-signature"),
  });
  if (!verify.ok) {
    req.log.warn({ reason: verify.reason }, "Rejected Resend webhook (signature)");
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  // Past this point the request is verified to be from Resend, so we always ack
  // with 200 — even on a payload we can't use — so Resend marks it delivered and
  // does not retry an event we will never act on differently.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    req.log.warn("Verified Resend webhook had invalid JSON; acknowledging");
    res.status(200).json({ ok: true, ignored: "invalid_json" });
    return;
  }

  const root = asRecord(parsed);
  const eventType = asString(root["type"]) ?? "";
  const data = asRecord(root["data"]);
  const resendEmailId = asString(data["email_id"]);

  // Recipient addresses: Resend uses `data.to` (array, or occasionally a string).
  const toRaw = data["to"];
  const addresses = Array.isArray(toRaw)
    ? toRaw.map((a) => String(a))
    : typeof toRaw === "string"
      ? [toRaw]
      : [];
  const emails = [
    ...new Set(addresses.map((a) => a.trim().toLowerCase()).filter((a) => a.length > 0)),
  ];

  // Map the event to a suppression action + a human-readable reason.
  let action: "bounce" | "complaint" | null = null;
  let reason: string | null = null;
  if (eventType === "email.bounced") {
    action = "bounce";
    const bounce = asRecord(data["bounce"]);
    reason = asString(bounce["type"]) ?? asString(bounce["subType"]) ?? "bounce";
  } else if (eventType === "email.suppressed") {
    action = "bounce";
    reason = asString(data["reason"]) ?? "suppressed";
  } else if (eventType === "email.complained") {
    action = "complaint";
    reason = "complaint";
  }

  // Acknowledge (200) events we don't act on or that carry no recipient, so
  // Resend treats them as delivered and won't retry.
  if (!svixId || action === null || emails.length === 0) {
    res.status(200).json({ ok: true, ignored: eventType || "unknown", addresses: emails.length });
    return;
  }

  // Process atomically per address: record the event (idempotency claim) and, only
  // when we actually inserted it, apply the suppression. A retried delivery hits
  // the unique (svix_id, email) conflict and is skipped, so suppression is applied
  // exactly once. COALESCE keeps the earliest timestamp and never downgrades a
  // stronger complaint suppression to a weaker bounce reason.
  let processed = 0;
  for (const email of emails) {
    const applied = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(subscriberEmailEventsTable)
        .values({ svixId, email, eventType, reason, resendEmailId })
        .onConflictDoNothing({
          target: [subscriberEmailEventsTable.svixId, subscriberEmailEventsTable.email],
        })
        .returning({ id: subscriberEmailEventsTable.id });
      if (inserted.length === 0) return false;

      // Upsert (not update-only): if the bounced/complained address isn't a known
      // subscriber, still record a suppression-only row so it can never sign up
      // later — every `data.to` address ends up suppressed. COALESCE keeps the
      // earliest timestamp and never downgrades a stronger complaint to a bounce.
      if (action === "complaint") {
        await tx
          .insert(subscribersTable)
          .values({
            email,
            unsubscribeToken: randomBytes(24).toString("hex"),
            suppressedAt: new Date(),
            suppressionReason: "complaint",
            unsubscribedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: subscribersTable.email,
            set: {
              suppressedAt: sql`COALESCE(${subscribersTable.suppressedAt}, now())`,
              suppressionReason: "complaint",
              unsubscribedAt: sql`COALESCE(${subscribersTable.unsubscribedAt}, now())`,
            },
          });
      } else {
        await tx
          .insert(subscribersTable)
          .values({
            email,
            unsubscribeToken: randomBytes(24).toString("hex"),
            suppressedAt: new Date(),
            suppressionReason: "bounce",
          })
          .onConflictDoUpdate({
            target: subscribersTable.email,
            set: {
              suppressedAt: sql`COALESCE(${subscribersTable.suppressedAt}, now())`,
              suppressionReason: sql`COALESCE(${subscribersTable.suppressionReason}, 'bounce')`,
            },
          });
      }
      return true;
    });
    if (applied) processed++;
  }

  req.log.info({ eventType, addresses: emails.length, processed }, "Processed Resend suppression webhook");
  res.status(200).json({ ok: true, processed });
});

export default router;

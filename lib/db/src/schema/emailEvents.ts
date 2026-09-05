import { pgTable, text, timestamp, uuid, uniqueIndex, index } from "drizzle-orm/pg-core";

// Audit log + idempotency ledger for inbound Resend (Svix-signed) webhook events
// that drive subscriber suppression: hard bounces, spam complaints, and provider
// suppressions. One row per (svixId, email) — the Svix delivery id makes webhook
// retries idempotent, and an event addressed to several recipients yields one row
// each. Rows are NEVER deleted: they are the durable evidence behind a
// suppression (who, why, which Resend email, when). Keep in sync with the
// ensureRuntimeTables boot DDL in api-server/services/seed.ts.
export const subscriberEmailEventsTable = pgTable(
  "subscriber_email_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Svix message id from the `svix-id` header — stable across delivery retries.
    svixId: text("svix_id").notNull(),
    // Recipient address the event concerns (one row per address in `data.to`).
    email: text("email").notNull(),
    // Resend event type: "email.bounced", "email.complained", "email.suppressed".
    eventType: text("event_type").notNull(),
    // Human-readable reason / subtype (bounce subtype, complaint type, etc.).
    reason: text("reason"),
    // Resend's own email id (`data.email_id`), for cross-referencing in Resend.
    resendEmailId: text("resend_email_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Idempotency: a given Svix delivery is recorded (and therefore processed) at
    // most once per address, even under webhook retries — paired with
    // INSERT ... ON CONFLICT DO NOTHING at the call site.
    uniqueIndex("subscriber_email_events_svix_email_unique").on(t.svixId, t.email),
    index("subscriber_email_events_email_idx").on(t.email),
    index("subscriber_email_events_created_idx").on(t.createdAt),
  ],
);

export type SubscriberEmailEvent = typeof subscriberEmailEventsTable.$inferSelect;

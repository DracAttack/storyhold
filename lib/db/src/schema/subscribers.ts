import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const subscribersTable = pgTable(
  "subscribers",
  {
    email: text("email").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Opaque token embedded in unsubscribe links. Lets a reader opt out without
    // authenticating or exposing their email in the URL. Backfilled for legacy
    // rows by the startup schema guard in api-server/services/seed.ts.
    unsubscribeToken: text("unsubscribe_token").notNull(),
    // Soft opt-out: when set, the address has unsubscribed and is excluded from
    // sends and from the admin list. Null = active subscriber.
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    // Reader-chosen topic preference: the `slug` of a `beats` row the subscriber
    // wants their weekly digest focused on. Null = "everything" (the general
    // most-recent digest). Deliberately NOT a foreign key so renaming or
    // removing a beat never blocks a send — the newsletter just falls back to
    // the general digest when the slug no longer yields articles. Backfilled
    // (as NULL) for legacy rows by the startup schema guard in
    // api-server/services/seed.ts.
    preferredCategory: text("preferred_category"),
    // Hard-suppression marker, distinct from the soft `unsubscribedAt` opt-out.
    // Set when Resend reports a hard bounce or spam complaint (via the signed
    // webhook), or when an admin manually removes a bad/false address. A
    // suppressed address is excluded from ALL sends and can never be silently
    // re-subscribed through the public form. Null = not suppressed. Backfilled
    // (as NULL) for legacy rows by the startup schema guard in
    // api-server/services/seed.ts.
    suppressedAt: timestamp("suppressed_at", { withTimezone: true }),
    // Why the address was suppressed: "bounce", "complaint", or "manual". Null
    // when not suppressed. Surfaced (with status) in the admin dashboard.
    suppressionReason: text("suppression_reason"),
  },
  (t) => [
    // Declared as a unique INDEX (not a column `.unique()` constraint) to match
    // the object the startup schema guard creates (`CREATE UNIQUE INDEX ...
    // subscribers_unsubscribe_token_unique`). A `.unique()` constraint would make
    // drizzle-kit try to add a same-named constraint alongside the existing index
    // on every push — an interactive prompt that blocks deploy.
    uniqueIndex("subscribers_unsubscribe_token_unique").on(t.unsubscribeToken),
  ],
);

export type Subscriber = typeof subscribersTable.$inferSelect;

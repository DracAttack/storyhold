import { pgTable, text, uuid, timestamp } from "drizzle-orm/pg-core";
import { authorsTable } from "./authors";

// Maps a retired author URL slug to the author that now lives at a new slug.
// When an author's `slug` changes (a deliberate rename via the admin UI, or the
// one-time data-fix migration), the OLD slug is recorded here so the per-author
// page can 301-redirect old/crawled URLs to the current canonical slug instead
// of 404ing. Resolution is by `authorId` (not a stored target slug) so chained
// renames always collapse to the author's CURRENT slug with no extra bookkeeping.
export const authorSlugRedirectsTable = pgTable("author_slug_redirects", {
  oldSlug: text("old_slug").primaryKey(),
  authorId: uuid("author_id")
    .notNull()
    .references(() => authorsTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AuthorSlugRedirect = typeof authorSlugRedirectsTable.$inferSelect;

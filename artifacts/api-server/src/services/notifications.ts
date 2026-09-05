import { promises as fs } from "node:fs";
import path from "node:path";
import { db, articlesTable, authorsTable, topicIdeasTable, adminSettingsTable, adminNotificationsTable, type AdminNotification, type DigestPayload } from "@workspace/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getAdminEmails } from "../lib/auth";

const ADMIN_EMAILS = getAdminEmails();

const SITE_BASE_URL = (process.env["SITE_BASE_URL"] ?? process.env["REPLIT_DEV_DOMAIN"] ?? "").replace(/\/$/, "");
const MAILBOX_DIR = process.env["ADMIN_MAILBOX_DIR"] ?? path.resolve(process.cwd(), "data/admin-mailbox");

function siteUrl(p: string): string {
  if (!SITE_BASE_URL) return p;
  const base = SITE_BASE_URL.startsWith("http") ? SITE_BASE_URL : `https://${SITE_BASE_URL}`;
  return `${base}${p}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function getEnabledRecipients(): Promise<string[]> {
  if (ADMIN_EMAILS.length === 0) return [];
  const rows = await db.select().from(adminSettingsTable);
  const settingsByEmail = new Map(rows.map((r) => [r.email.toLowerCase(), r.digestEnabled]));
  return ADMIN_EMAILS.filter((email) => settingsByEmail.get(email) !== false);
}

export async function buildDigestPayload(since: Date): Promise<DigestPayload | null> {
  const drafts = await db
    .select({
      id: articlesTable.id,
      title: articlesTable.title,
      authorId: articlesTable.authorId,
      authorName: authorsTable.name,
      createdAt: articlesTable.createdAt,
    })
    .from(articlesTable)
    .innerJoin(authorsTable, eq(authorsTable.id, articlesTable.authorId))
    .where(and(eq(articlesTable.status, "draft"), gte(articlesTable.createdAt, since)))
    .orderBy(desc(articlesTable.createdAt));

  const pending = await db
    .select({
      id: topicIdeasTable.id,
      title: topicIdeasTable.title,
      authorId: topicIdeasTable.authorId,
      authorName: authorsTable.name,
      authorSlug: authorsTable.slug,
      createdAt: topicIdeasTable.createdAt,
    })
    .from(topicIdeasTable)
    .innerJoin(authorsTable, eq(authorsTable.id, topicIdeasTable.authorId))
    .where(and(eq(topicIdeasTable.status, "pending"), gte(topicIdeasTable.createdAt, since)))
    .orderBy(desc(topicIdeasTable.createdAt));

  return {
    draftsCreated: drafts.length,
    articlesPublished: 0,
    drafts: drafts.map((d) => ({ id: d.id, title: d.title, authorId: d.authorId, authorName: d.authorName })),
    pendingIdeas: pending.map((p) => ({
      id: p.id,
      title: p.title,
      authorId: p.authorId,
      authorSlug: p.authorSlug,
      authorName: p.authorName,
    })),
    recipients: [],
  };
}

function renderHtml(payload: DigestPayload, subject: string): string {
  const draftsBlock = payload.drafts.length === 0
    ? "<p style=\"color:#666\">No new drafts.</p>"
    : `<ul>${payload.drafts.map((d) => `<li><a href="${siteUrl(`/admin/articles/${d.id}`)}">${escapeHtml(d.title)}</a> <span style="color:#888">— ${escapeHtml(d.authorName)}</span></li>`).join("")}</ul>`;

  const ideasByAuthor = new Map<string, { authorId: string; authorName: string; titles: string[] }>();
  for (const p of payload.pendingIdeas) {
    const cur = ideasByAuthor.get(p.authorId) ?? { authorId: p.authorId, authorName: p.authorName, titles: [] };
    cur.titles.push(p.title);
    ideasByAuthor.set(p.authorId, cur);
  }
  const ideasBlock = ideasByAuthor.size === 0
    ? "<p style=\"color:#666\">No new pending ideas.</p>"
    : `<ul>${[...ideasByAuthor.values()].map((g) => `<li><a href="${siteUrl(`/admin/authors/${g.authorId}`)}">${escapeHtml(g.authorName)}</a> — ${g.titles.length} pending<br/><span style="color:#666;font-size:13px">${g.titles.slice(0, 5).map(escapeHtml).join("; ")}${g.titles.length > 5 ? " …" : ""}</span></li>`).join("")}</ul>`;

  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#111">
<h1 style="font-size:20px;margin:0 0 4px">${escapeHtml(subject)}</h1>
<p style="color:#666;margin:0 0 24px">Daily BrainHook editorial digest</p>
<p>${payload.draftsCreated} new draft${payload.draftsCreated === 1 ? "" : "s"} created · ${payload.articlesPublished} article${payload.articlesPublished === 1 ? "" : "s"} published</p>
<h2 style="font-size:16px;margin:24px 0 8px">Drafts awaiting review</h2>
${draftsBlock}
<h2 style="font-size:16px;margin:24px 0 8px">Pending ideas</h2>
${ideasBlock}
<hr style="border:none;border-top:1px solid #eee;margin:32px 0"/>
<p style="color:#888;font-size:12px">Manage delivery from <a href="${siteUrl("/admin/settings")}">Admin → Settings</a>.</p>
</body></html>`;
}

function renderText(payload: DigestPayload, subject: string): string {
  const lines: string[] = [];
  lines.push(subject);
  lines.push("");
  lines.push(`${payload.draftsCreated} new draft(s), ${payload.articlesPublished} published.`);
  lines.push("");
  lines.push("Drafts awaiting review:");
  if (payload.drafts.length === 0) lines.push("  (none)");
  for (const d of payload.drafts) {
    lines.push(`  - ${d.title} — ${d.authorName}`);
    lines.push(`    ${siteUrl(`/admin/articles/${d.id}`)}`);
  }
  lines.push("");
  lines.push("Pending ideas:");
  if (payload.pendingIdeas.length === 0) lines.push("  (none)");
  for (const p of payload.pendingIdeas) {
    lines.push(`  - ${p.title} — ${p.authorName}`);
    lines.push(`    ${siteUrl(`/admin/authors/${p.authorId}`)}`);
  }
  lines.push("");
  lines.push(`Manage delivery: ${siteUrl("/admin/settings")}`);
  return lines.join("\n");
}

async function writeMailbox(notification: AdminNotification): Promise<string | null> {
  try {
    await fs.mkdir(MAILBOX_DIR, { recursive: true });
    const stamp = notification.createdAt.toISOString().replace(/[:.]/g, "-");
    const file = path.join(MAILBOX_DIR, `${stamp}-${notification.id}.html`);
    await fs.writeFile(file, notification.bodyHtml, "utf8");
    return file;
  } catch (e) {
    logger.warn({ err: e }, "Failed to write digest to mailbox dir");
    return null;
  }
}

export async function sendDailyDigest(opts: {
  draftsCreated: number;
  articlesPublished: number;
  since: Date;
}): Promise<{ notificationId: string | null; recipients: string[]; skipped?: string }> {
  const payload = await buildDigestPayload(opts.since);
  if (!payload) return { notificationId: null, recipients: [], skipped: "no_payload" };
  payload.draftsCreated = opts.draftsCreated;
  payload.articlesPublished = opts.articlesPublished;

  if (payload.drafts.length === 0 && payload.pendingIdeas.length === 0 && opts.draftsCreated === 0 && opts.articlesPublished === 0) {
    return { notificationId: null, recipients: [], skipped: "nothing_to_report" };
  }

  const recipients = await getEnabledRecipients();
  payload.recipients = recipients;

  const subject = `BrainHook digest: ${payload.draftsCreated} new draft${payload.draftsCreated === 1 ? "" : "s"}, ${payload.pendingIdeas.length} pending idea${payload.pendingIdeas.length === 1 ? "" : "s"}`;
  const bodyHtml = renderHtml(payload, subject);
  const bodyText = renderText(payload, subject);

  const [inserted] = await db
    .insert(adminNotificationsTable)
    .values({ type: "daily_digest", subject, bodyHtml, bodyText, payload, recipients })
    .returning();

  if (!inserted) return { notificationId: null, recipients, skipped: "insert_failed" };

  const filePath = await writeMailbox(inserted);
  logger.info(
    { notificationId: inserted.id, recipients: recipients.length, filePath, drafts: payload.drafts.length, pending: payload.pendingIdeas.length },
    "Admin digest generated",
  );

  if (recipients.length === 0) {
    logger.warn(
      "Admin digest generated but no recipients — set ADMIN_EMAILS and enable delivery in Admin → Settings",
    );
  }

  return { notificationId: inserted.id, recipients };
}

export async function listNotifications(limit = 50): Promise<AdminNotification[]> {
  return db
    .select()
    .from(adminNotificationsTable)
    .orderBy(desc(adminNotificationsTable.createdAt))
    .limit(limit);
}

export async function getNotification(id: string): Promise<AdminNotification | null> {
  const [item] = await db.select().from(adminNotificationsTable).where(eq(adminNotificationsTable.id, id)).limit(1);
  return item ?? null;
}

export async function getOrCreateSettings(email: string): Promise<{ email: string; digestEnabled: boolean }> {
  const lower = email.toLowerCase();
  const [existing] = await db.select().from(adminSettingsTable).where(eq(adminSettingsTable.email, lower)).limit(1);
  if (existing) return { email: existing.email, digestEnabled: existing.digestEnabled };
  const [created] = await db
    .insert(adminSettingsTable)
    .values({ email: lower, digestEnabled: true })
    .onConflictDoNothing()
    .returning();
  return { email: lower, digestEnabled: created?.digestEnabled ?? true };
}

export async function updateSettings(email: string, digestEnabled: boolean): Promise<{ email: string; digestEnabled: boolean }> {
  const lower = email.toLowerCase();
  const [row] = await db
    .insert(adminSettingsTable)
    .values({ email: lower, digestEnabled })
    .onConflictDoUpdate({
      target: adminSettingsTable.email,
      set: { digestEnabled, updatedAt: sql`now()` },
    })
    .returning();
  return { email: row!.email, digestEnabled: row!.digestEnabled };
}

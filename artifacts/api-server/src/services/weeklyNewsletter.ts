import { isNull, eq, and } from "drizzle-orm";
import { db, subscribersTable, beatsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { sendEmail, type EmailSendResult } from "./email";
import { acquireJobLock, heartbeatJob, finishJob } from "./jobState";
import {
  type FeedArticle,
  type BeatArticleGroup,
  fetchRecentArticles,
  fetchRecentArticlesByCategory,
  fetchRecentArticlesGroupedByBeat,
  siteUrl,
  emailImageSrc,
  unsubscribeUrl,
  oneClickUnsubscribeHeaders,
  htmlEscape,
  INK,
  BODY,
  MUTED,
  TERRACOTTA,
  CREAM_OUTER,
  CARD,
  RULE,
  SERIF,
  SANS,
} from "./emailShared";

// Gentle pacing between individual sends so a large batch doesn't hammer the
// SMTP provider's rate limit. Small enough to stay fast for the current list.
const SEND_GAP_MS = 250;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const WINDOW_DAYS = 7;
const MAX_ARTICLES = 6;

function dateRangeLabel(): string {
  const end = new Date();
  const start = new Date(end.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${fmt(start)} – ${fmt(end)}`;
}

/** The lead story gets a full-width hero treatment. */
function leadStory(a: FeedArticle): string {
  const url = siteUrl(`/article/${a.slug}`);
  const meta = `${htmlEscape(a.category)} &middot; ${a.readingTimeMinutes} min read`;
  return `<tr><td class="px" style="padding:32px 48px 0;">
          <a href="${url}" style="text-decoration:none;">
            <img src="${emailImageSrc(a.heroImage, a.isShareCard, 600)}" width="504" alt="" style="display:block;width:100%;max-width:504px;height:auto;border-radius:11px;border:1px solid ${RULE};" />
          </a>
          <p style="margin:18px 0 6px;font-family:${SANS};font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${TERRACOTTA};font-weight:700;">${meta}</p>
          <a href="${url}" style="font-family:${SERIF};font-size:27px;line-height:1.18;color:${INK};font-weight:800;text-decoration:none;letter-spacing:-0.3px;">${htmlEscape(a.newsletterTitle)}</a>
          ${a.dek ? `<p style="margin:11px 0 0;font-family:${SERIF};font-size:16px;line-height:1.6;color:${BODY};">${htmlEscape(a.dek)}</p>` : ""}
        </td></tr>`;
}

/** Remaining stories render as compact thumbnail rows. */
function storyRow(a: FeedArticle): string {
  const url = siteUrl(`/article/${a.slug}`);
  const meta = `${htmlEscape(a.category)} &middot; ${a.readingTimeMinutes} min read`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">
    <tr>
      <td valign="top" width="120" style="width:120px;padding-right:18px;">
        <a href="${url}" style="text-decoration:none;">
          <img src="${emailImageSrc(a.heroImage, a.isShareCard, 240)}" width="120" height="80" alt="" style="display:block;width:120px;height:80px;object-fit:cover;border-radius:8px;border:1px solid ${RULE};" />
        </a>
      </td>
      <td valign="top">
        <p style="margin:0 0 5px;font-family:${SANS};font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${TERRACOTTA};font-weight:700;">${meta}</p>
        <a href="${url}" style="font-family:${SERIF};font-size:18px;line-height:1.3;color:${INK};font-weight:700;text-decoration:none;">${htmlEscape(a.newsletterTitle)}</a>
        ${a.dek ? `<p style="margin:7px 0 0;font-family:${SERIF};font-size:14px;line-height:1.5;color:${BODY};">${htmlEscape(a.dek)}</p>` : ""}
      </td>
    </tr>
  </table>`;
}

function restSection(articles: FeedArticle[]): string {
  if (articles.length === 0) return "";
  return `<tr><td class="px" style="padding:32px 48px 0;">
          <div style="border-top:1px solid ${RULE};padding-top:26px;">
            <p style="margin:0 0 20px;font-family:${SANS};font-size:12px;letter-spacing:2px;text-transform:uppercase;color:${MUTED};font-weight:700;">Also this week</p>
            ${articles.map(storyRow).join("\n")}
          </div>
        </td></tr>`;
}

function renderHtml(token: string, articles: FeedArticle[], categoryLabel?: string | null): string {
  const home = siteUrl("/");
  const unsub = unsubscribeUrl(token);
  const year = new Date().getFullYear();
  const range = dateRangeLabel();
  const [lead, ...rest] = articles;
  const count = articles.length;
  const heading = categoryLabel ? `This week in ${categoryLabel}` : "This week on BrainHook";
  const intro = categoryLabel
    ? `The most curious ${categoryLabel} stories we published recently — picked for you because it's the subject you asked to hear about.`
    : "The most curious, can't-look-away stories we published this week &mdash; gathered in one place for your weekend reading.";
  const preheader = lead
    ? `${lead.newsletterTitle} — and ${Math.max(count - 1, 0)} more curious stories${categoryLabel ? ` in ${categoryLabel}` : " from this week"}.`
    : "The most curious stories we published this week.";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<title>${htmlEscape(heading)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;800&display=swap');
  body { margin:0; padding:0; }
  @media (max-width:600px) {
    .px { padding-left:26px !important; padding-right:26px !important; }
    .h1 { font-size:30px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${CREAM_OUTER};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${CREAM_OUTER};">${htmlEscape(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CREAM_OUTER};">
  <tr>
    <td align="center" style="padding:34px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:${CARD};border:1px solid ${RULE};border-radius:14px;overflow:hidden;">

        <!-- Masthead -->
        <tr><td class="px" align="center" style="padding:38px 48px 18px;">
          <div style="font-family:${SERIF};font-size:14px;letter-spacing:5px;text-transform:uppercase;color:${TERRACOTTA};font-weight:700;">BrainHook</div>
        </td></tr>
        <tr><td style="padding:0 48px;"><div style="border-top:1px solid ${RULE};font-size:0;line-height:0;">&nbsp;</div></td></tr>

        <!-- Hero -->
        <tr><td class="px" style="padding:36px 48px 0;">
          <p style="margin:0 0 14px;font-family:${SANS};font-size:12px;letter-spacing:2px;text-transform:uppercase;color:${MUTED};font-weight:700;">This week &middot; ${range}</p>
          <h1 class="h1" style="margin:0;font-family:${SERIF};font-size:38px;line-height:1.08;color:${INK};font-weight:800;letter-spacing:-0.5px;">${htmlEscape(heading)}</h1>
          <p style="margin:16px 0 0;font-family:${SERIF};font-size:17px;line-height:1.65;color:${BODY};">
            ${intro}
          </p>
        </td></tr>

        <!-- Lead story -->
        ${lead ? leadStory(lead) : ""}

        <!-- Remaining stories -->
        ${restSection(rest)}

        <!-- CTA -->
        <tr><td class="px" style="padding:34px 48px 0;">
          <div style="border-top:1px solid ${RULE};padding-top:26px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="border-radius:9px;background:${TERRACOTTA};">
                <a href="${home}" style="display:inline-block;padding:14px 28px;font-family:${SANS};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:9px;">Read more on BrainHook &rarr;</a>
              </td>
            </tr></table>
          </div>
        </td></tr>

        <!-- Footer -->
        <tr><td class="px" style="padding:30px 48px 40px;">
          <div style="border-top:1px solid ${RULE};padding-top:20px;">
            <p style="margin:0 0 8px;font-family:${SANS};font-size:12px;line-height:1.6;color:${MUTED};">
              You're receiving this weekly roundup because you subscribed at <a href="${home}" style="color:${MUTED};text-decoration:underline;">BrainHook</a>.
            </p>
            <p style="margin:0;font-family:${SANS};font-size:12px;line-height:1.6;color:${MUTED};">
              Don't want these emails? <a href="${unsub}" style="color:${TERRACOTTA};text-decoration:underline;">Unsubscribe</a> anytime.
            </p>
          </div>
        </td></tr>

      </table>
      <p style="margin:18px 0 0;font-family:${SANS};font-size:11px;color:${MUTED};">&copy; ${year} BrainHook Media</p>
    </td>
  </tr>
</table>
</body></html>`;
}

function renderText(token: string, articles: FeedArticle[], categoryLabel?: string | null): string {
  const heading = categoryLabel ? `This week in ${categoryLabel}` : "This week on BrainHook";
  const intro = categoryLabel
    ? `The most curious ${categoryLabel} stories we published recently — picked for you because it's the subject you asked to hear about.`
    : "The most curious, can't-look-away stories we published this week — gathered in one place for your weekend reading.";
  const lines = [
    "BrainHook",
    "",
    `${heading} (${dateRangeLabel()})`,
    "",
    intro,
    "",
  ];

  for (const a of articles) {
    lines.push(`- ${a.newsletterTitle} (${a.category}, ${a.readingTimeMinutes} min)`);
    if (a.dek) lines.push(`  ${a.dek}`);
    lines.push(`  ${siteUrl(`/article/${a.slug}`)}`);
    lines.push("");
  }

  lines.push(
    `Read more on BrainHook: ${siteUrl("/")}`,
    "",
    "You're receiving this weekly roundup because you subscribed at BrainHook.",
    `Unsubscribe anytime: ${unsubscribeUrl(token)}`,
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Sectioned "Everything" newsletter (one email, a beat section per beat)
// ---------------------------------------------------------------------------

function beatSectionHtml(group: BeatArticleGroup): string {
  if (group.articles.length === 0) return "";
  const [lead, ...rest] = group.articles;
  return `<tr><td class="px" style="padding:32px 48px 0;">
          <div style="border-top:1px solid ${RULE};padding-top:26px;">
            <p style="margin:0 0 18px;font-family:${SANS};font-size:12px;letter-spacing:2px;text-transform:uppercase;color:${MUTED};font-weight:700;">${htmlEscape(group.beatName)}</p>
            ${lead ? leadStory(lead) : ""}
            ${rest.map(storyRow).join("\n")}
          </div>
        </td></tr>`;
}

function renderSectionedHtml(token: string, groups: BeatArticleGroup[]): string {
  const home = siteUrl("/");
  const unsub = unsubscribeUrl(token);
  const year = new Date().getFullYear();
  const range = dateRangeLabel();
  const heading = "This week on BrainHook";
  const totalStories = groups.reduce((n, g) => n + g.articles.length, 0);
  const preheader = totalStories > 0
    ? `${totalStories} stories from ${groups.length} beats this week \u2014 your everything roundup.`
    : "The most curious stories we published this week.";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<title>${htmlEscape(heading)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;800&display=swap');
  body { margin:0; padding:0; }
  @media (max-width:600px) {
    .px { padding-left:26px !important; padding-right:26px !important; }
    .h1 { font-size:30px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${CREAM_OUTER};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${CREAM_OUTER};">${htmlEscape(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CREAM_OUTER};">
  <tr>
    <td align="center" style="padding:34px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:${CARD};border:1px solid ${RULE};border-radius:14px;overflow:hidden;">

        <!-- Masthead -->
        <tr><td class="px" align="center" style="padding:38px 48px 18px;">
          <div style="font-family:${SERIF};font-size:14px;letter-spacing:5px;text-transform:uppercase;color:${TERRACOTTA};font-weight:700;">BrainHook</div>
        </td></tr>
        <tr><td style="padding:0 48px;"><div style="border-top:1px solid ${RULE};font-size:0;line-height:0;">&nbsp;</div></td></tr>

        <!-- Hero -->
        <tr><td class="px" style="padding:36px 48px 0;">
          <p style="margin:0 0 14px;font-family:${SANS};font-size:12px;letter-spacing:2px;text-transform:uppercase;color:${MUTED};font-weight:700;">This week &middot; ${range}</p>
          <h1 class="h1" style="margin:0;font-family:${SERIF};font-size:38px;line-height:1.08;color:${INK};font-weight:800;letter-spacing:-0.5px;">${htmlEscape(heading)}</h1>
          <p style="margin:16px 0 0;font-family:${SERIF};font-size:17px;line-height:1.65;color:${BODY};">
            The most curious, can't-look-away stories we published this week \u2014 gathered in one place for your weekend reading. Here's what's worth your attention across every beat.
          </p>
        </td></tr>

        <!-- Beat sections -->
        ${groups.map(beatSectionHtml).join("\n")}

        <!-- CTA -->
        <tr><td class="px" style="padding:34px 48px 0;">
          <div style="border-top:1px solid ${RULE};padding-top:26px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="border-radius:9px;background:${TERRACOTTA};">
                <a href="${home}" style="display:inline-block;padding:14px 28px;font-family:${SANS};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:9px;">Read more on BrainHook &rarr;</a>
              </td>
            </tr></table>
          </div>
        </td></tr>

        <!-- Footer -->
        <tr><td class="px" style="padding:30px 48px 40px;">
          <div style="border-top:1px solid ${RULE};padding-top:20px;">
            <p style="margin:0 0 8px;font-family:${SANS};font-size:12px;line-height:1.6;color:${MUTED};">
              You're receiving this weekly roundup because you subscribed at <a href="${home}" style="color:${MUTED};text-decoration:underline;">BrainHook</a>.
            </p>
            <p style="margin:0;font-family:${SANS};font-size:12px;line-height:1.6;color:${MUTED};">
              Don't want these emails? <a href="${unsub}" style="color:${TERRACOTTA};text-decoration:underline;">Unsubscribe</a> anytime.
            </p>
          </div>
        </td></tr>

      </table>
      <p style="margin:18px 0 0;font-family:${SANS};font-size:11px;color:${MUTED};">&copy; ${year} BrainHook Media</p>
    </td>
  </tr>
</table>
</body></html>`;
}

function renderSectionedText(token: string, groups: BeatArticleGroup[]): string {
  const lines = [
    "BrainHook",
    "",
    `This week on BrainHook (${dateRangeLabel()})`,
    "",
    "The most curious stories we published this week \u2014 gathered in one place for your weekend reading. Here's what's worth your attention across every beat.",
    "",
  ];
  for (const group of groups) {
    lines.push(`${group.beatName}`);
    lines.push("-".repeat(group.beatName.length));
    for (const a of group.articles) {
      lines.push(`- ${a.newsletterTitle} (${a.readingTimeMinutes} min)`);
      if (a.dek) lines.push(`  ${a.dek}`);
      lines.push(`  ${siteUrl(`/article/${a.slug}`)}`);
    }
    lines.push("");
  }
  lines.push(
    `Read more on BrainHook: ${siteUrl("/")}`,
    "",
    "You're receiving this weekly roundup because you subscribed at BrainHook.",
    `Unsubscribe anytime: ${unsubscribeUrl(token)}`,
  );
  return lines.join("\n");
}

/** A single send carries the resolved category label so callers (e.g. the admin
 * test-fire) can report which issue variant actually went out. */
export type SingleSendResult = EmailSendResult & { categoryLabel?: string | null };

// ---------------------------------------------------------------------------
// Custom broadcast email (one-off admin message to all subscribers)
// ---------------------------------------------------------------------------

/** Simple Markdown-ish → HTML for a broadcast body. Blank lines become
 * paragraph breaks; consecutive non-blank lines stay inside one <p>. */
function broadcastBodyHtml(text: string): string {
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return paras
    .map((p) => `<p style="margin:0 0 18px;font-family:${SERIF};font-size:17px;line-height:1.65;color:${BODY};">${htmlEscape(p).replace(/\n/g, "<br />")}</p>`)
    .join("\n");
}

function renderCustomBroadcastHtml(token: string, subject: string, body: string): string {
  const home = siteUrl("/");
  const unsub = unsubscribeUrl(token);
  const year = new Date().getFullYear();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<title>${htmlEscape(subject)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;800&display=swap');
  body { margin:0; padding:0; }
  @media (max-width:600px) {
    .px { padding-left:26px !important; padding-right:26px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${CREAM_OUTER};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${CREAM_OUTER};">${htmlEscape(subject)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CREAM_OUTER};">
  <tr>
    <td align="center" style="padding:34px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:${CARD};border:1px solid ${RULE};border-radius:14px;overflow:hidden;">

        <!-- Masthead -->
        <tr><td class="px" align="center" style="padding:38px 48px 18px;">
          <div style="font-family:${SERIF};font-size:14px;letter-spacing:5px;text-transform:uppercase;color:${TERRACOTTA};font-weight:700;">BrainHook</div>
        </td></tr>
        <tr><td style="padding:0 48px;"><div style="border-top:1px solid ${RULE};font-size:0;line-height:0;">&nbsp;</div></td></tr>

        <!-- Hero -->
        <tr><td class="px" style="padding:36px 48px 0;">
          <h1 style="margin:0;font-family:${SERIF};font-size:30px;line-height:1.15;color:${INK};font-weight:800;letter-spacing:-0.3px;">${htmlEscape(subject)}</h1>
        </td></tr>

        <!-- Body -->
        <tr><td class="px" style="padding:24px 48px 0;">
          ${broadcastBodyHtml(body)}
        </td></tr>

        <!-- Footer -->
        <tr><td class="px" style="padding:30px 48px 40px;">
          <div style="border-top:1px solid ${RULE};padding-top:20px;">
            <p style="margin:0 0 8px;font-family:${SANS};font-size:12px;line-height:1.6;color:${MUTED};">
              You're receiving this because you subscribed at <a href="${home}" style="color:${MUTED};text-decoration:underline;">BrainHook</a>.
            </p>
            <p style="margin:0;font-family:${SANS};font-size:12px;line-height:1.6;color:${MUTED};">
              Don't want these emails? <a href="${unsub}" style="color:${TERRACOTTA};text-decoration:underline;">Unsubscribe</a> anytime.
            </p>
          </div>
        </td></tr>

      </table>
      <p style="margin:18px 0 0;font-family:${SANS};font-size:11px;color:${MUTED};">&copy; ${year} BrainHook Media</p>
    </td>
  </tr>
</table>
</body></html>`;
}

function renderCustomBroadcastText(token: string, _subject: string, body: string): string {
  const lines = [
    "BrainHook",
    "",
    body,
    "",
    "You're receiving this because you subscribed at BrainHook.",
    `Unsubscribe anytime: ${unsubscribeUrl(token)}`,
  ];
  return lines.join("\n");
}

export type CustomBroadcastResult = {
  started: boolean;
  alreadyRunning?: boolean;
  recipients?: number;
  sent?: number;
  failed?: number;
  skipped?: string;
};

const CUSTOM_BROADCAST_JOB = "custom_broadcast";
const CUSTOM_BROADCAST_TTL_MS = 60 * 60 * 1000;

/**
 * Send a one-off custom broadcast to every active subscriber. Same safety
 * semantics as the weekly newsletter: fire-and-forget per recipient, DB job
 * lock overlap protection, never throws. Returns a summary.
 */
export async function sendCustomBroadcast(subject: string, body: string): Promise<CustomBroadcastResult> {
  const runId = await acquireJobLock(CUSTOM_BROADCAST_JOB, { ttlMs: CUSTOM_BROADCAST_TTL_MS });
  if (!runId) {
    return { started: false, alreadyRunning: true };
  }
  let runError: unknown = null;
  try {
    const subscribers = await db
      .select({
        email: subscribersTable.email,
        token: subscribersTable.unsubscribeToken,
      })
      .from(subscribersTable)
      .where(and(isNull(subscribersTable.unsubscribedAt), isNull(subscribersTable.suppressedAt)));

    if (subscribers.length === 0) {
      return { started: true, recipients: 0, sent: 0, failed: 0, skipped: "no_subscribers" };
    }

    let sent = 0;
    let failed = 0;
    for (const s of subscribers) {
      const res = await sendEmail({
        to: s.email,
        subject,
        html: renderCustomBroadcastHtml(s.token, subject, body),
        text: renderCustomBroadcastText(s.token, subject, body),
        headers: oneClickUnsubscribeHeaders(s.token),
      });
      if (res.delivered) sent++;
      else failed++;
      await heartbeatJob(CUSTOM_BROADCAST_JOB, runId, { recipients: subscribers.length, sent, failed });
      await sleep(SEND_GAP_MS);
    }

    logger.info(
      { recipients: subscribers.length, sent, failed, subject },
      "Custom broadcast batch complete",
    );
    return { started: true, recipients: subscribers.length, sent, failed };
  } catch (e) {
    runError = e;
    throw e;
  } finally {
    await finishJob(CUSTOM_BROADCAST_JOB, runId, runError ? "failed" : "succeeded", {
      error: runError ? (runError instanceof Error ? runError.message : String(runError)) : undefined,
      progress: { subject: subject.slice(0, 200) },
    });
  }
}

/**
 * Send the "This week on BrainHook" weekly roundup to a single recipient. The
 * `unsubscribeToken` powers a one-click opt-out link (CAN-SPAM/GDPR). The body
 * is the articles published in the last 7 days (falling back to the most recent
 * published stories if the window is empty). When `preferredCategory` (a beat
 * slug) is given AND that category has recent articles, the issue is tailored to
 * it exactly as the batch send tailors a real subscriber — otherwise it falls
 * back to the general digest. Returns the send result (plus the resolved
 * category label); never throws (delegates to sendEmail's safe handling). If
 * there are no articles at all, the send is skipped.
 */
export async function sendWeeklyNewsletter(
  email: string,
  unsubscribeToken: string,
  preferredCategory?: string | null,
): Promise<SingleSendResult> {
  // "Everything" subscriber (no preferredCategory) gets a sectioned digest
  // with a small beat section per beat instead of a flat general digest.
  if (!preferredCategory) {
    let groups: BeatArticleGroup[] = [];
    try {
      groups = await fetchRecentArticlesGroupedByBeat(WINDOW_DAYS, 2, 12);
    } catch {
      groups = [];
    }
    if (groups.length === 0) {
      return { provider: "none", delivered: false, skipped: "no_articles", categoryLabel: null };
    }
    const range = dateRangeLabel();
    const res = await sendEmail({
      to: email,
      subject: `This week on BrainHook \u00b7 ${range}`,
      html: renderSectionedHtml(unsubscribeToken, groups),
      text: renderSectionedText(unsubscribeToken, groups),
      headers: oneClickUnsubscribeHeaders(unsubscribeToken),
    });
    return { ...res, categoryLabel: null };
  }

  let set: FeedArticle[] = [];
  try {
    set = await fetchRecentArticles(WINDOW_DAYS, MAX_ARTICLES);
  } catch {
    set = [];
  }

  // Tailor to the chosen category when it actually yields articles
  let label: string | null = null;
  let catSet: FeedArticle[] = [];
  try {
    catSet = await fetchRecentArticlesByCategory(preferredCategory, WINDOW_DAYS, MAX_ARTICLES);
  } catch {
    catSet = [];
  }
  if (catSet.length > 0) {
    set = catSet;
    const beat = await db
      .select({ name: beatsTable.name })
      .from(beatsTable)
      .where(eq(beatsTable.slug, preferredCategory))
      .limit(1);
    label = beat[0]?.name ?? null;
  }

  if (set.length === 0) {
    return { provider: "none", delivered: false, skipped: "no_articles", categoryLabel: null };
  }

  const range = dateRangeLabel();
  const subject = label ? `This week in ${label} \u00b7 ${range}` : `This week on BrainHook \u00b7 ${range}`;
  const res = await sendEmail({
    to: email,
    subject,
    html: renderHtml(unsubscribeToken, set, label),
    text: renderText(unsubscribeToken, set, label),
    headers: oneClickUnsubscribeHeaders(unsubscribeToken),
  });
  return { ...res, categoryLabel: label };
}

export type WeeklyBatchResult = {
  started: boolean;
  alreadyRunning?: boolean;
  recipients?: number;
  sent?: number;
  failed?: number;
  articles?: number;
  skipped?: string;
};

const WEEKLY_NEWSLETTER_JOB = "weekly_newsletter";
// A full blast is one email per subscriber with a 250ms gap — generous TTL so a
// large list doesn't look "crashed"; a stale heartbeat lets a later run take over.
const WEEKLY_NEWSLETTER_TTL_MS = 60 * 60 * 1000;

/**
 * Send the weekly "This week on BrainHook" roundup to every active subscriber.
 * The article set is fetched once and shared across recipients; only the
 * per-recipient unsubscribe link differs. Each send is independent — one
 * failure never aborts the batch (sendEmail never throws). Returns a summary.
 *
 * Overlap protection is DB-backed (table `background_jobs` via jobState.ts): the
 * lock is claimed atomically so a long-running cron tick that outlives its
 * interval — or a second autoscale instance firing the same week — can't start a
 * second blast and double-mail every subscriber. (Period-level dedup is still
 * handled upstream by the cron tick's `cron_job_runs` claim; this lock guards the
 * heavy run itself.) A stale heartbeat from a crashed run can be taken over.
 */
export async function sendWeeklyNewsletterToAll(): Promise<WeeklyBatchResult> {
  const runId = await acquireJobLock(WEEKLY_NEWSLETTER_JOB, { ttlMs: WEEKLY_NEWSLETTER_TTL_MS });
  if (!runId) {
    return { started: false, alreadyRunning: true };
  }
  let runError: unknown = null;
  try {
    let articles: FeedArticle[] = [];
    try {
      articles = await fetchRecentArticles(WINDOW_DAYS, MAX_ARTICLES);
    } catch (e) {
      logger.error({ err: e }, "Weekly newsletter: failed to load articles");
      articles = [];
    }
    if (articles.length === 0) {
      logger.info("Weekly newsletter skipped — no published articles");
      return { started: true, recipients: 0, sent: 0, failed: 0, articles: 0, skipped: "no_articles" };
    }

    const subscribers = await db
      .select({
        email: subscribersTable.email,
        token: subscribersTable.unsubscribeToken,
        preferredCategory: subscribersTable.preferredCategory,
      })
      .from(subscribersTable)
      // Exclude both soft opt-outs (unsubscribedAt) and hard suppressions
      // (suppressedAt — bounces, complaints, manual removals).
      .where(and(isNull(subscribersTable.unsubscribedAt), isNull(subscribersTable.suppressedAt)));

    if (subscribers.length === 0) {
      logger.info("Weekly newsletter skipped — no active subscribers");
      return { started: true, recipients: 0, sent: 0, failed: 0, articles: articles.length, skipped: "no_subscribers" };
    }

    // Map beat slug → display name so a tailored email can say "This week in
    // Astronomy" instead of the raw slug. One cheap query for the whole batch.
    const beats = await db.select({ slug: beatsTable.slug, name: beatsTable.name }).from(beatsTable);
    const beatNameBySlug = new Map(beats.map((b) => [b.slug, b.name]));

    // Per-category article sets are fetched lazily and cached for the batch, so a
    // category shared by many subscribers costs a single query. A category with
    // no published articles falls back to the general set (`articles`).
    const articlesByCategory = new Map<string, FeedArticle[]>();
    async function articlesForCategory(slug: string): Promise<FeedArticle[]> {
      const cached = articlesByCategory.get(slug);
      if (cached) return cached;
      let set: FeedArticle[] = [];
      try {
        set = await fetchRecentArticlesByCategory(slug, WINDOW_DAYS, MAX_ARTICLES);
      } catch (e) {
        logger.warn({ err: e, slug }, "Weekly newsletter: failed to load category articles; using general set");
        set = [];
      }
      articlesByCategory.set(slug, set);
      return set;
    }

    const range = dateRangeLabel();
    const generalSubject = `This week on BrainHook \u00b7 ${range}`;
    let sent = 0;
    let failed = 0;

    // Pre-fetch grouped articles once for all "Everything" subscribers (lazy:
    // only when at least one subscriber has no preferredCategory).
    let everythingGroups: BeatArticleGroup[] | null = null;

    for (const s of subscribers) {
      let subject: string;
      let html: string;
      let text: string;

      if (!s.preferredCategory) {
        // Everything subscriber gets sectioned beat digest
        if (everythingGroups === null) {
          try {
            everythingGroups = await fetchRecentArticlesGroupedByBeat(WINDOW_DAYS, 2, 12);
          } catch {
            everythingGroups = [];
          }
        }
        if (everythingGroups.length === 0) {
          // No articles at all for the sectioned view; use fallback flat digest
          subject = generalSubject;
          html = renderHtml(s.token, articles, null);
          text = renderText(s.token, articles, null);
        } else {
          subject = generalSubject;
          html = renderSectionedHtml(s.token, everythingGroups);
          text = renderSectionedText(s.token, everythingGroups);
        }
      } else {
        // Tailored to the chosen beat
        let set = articles;
        let label: string | null = null;
        const catSet = await articlesForCategory(s.preferredCategory);
        if (catSet.length > 0) {
          set = catSet;
          label = beatNameBySlug.get(s.preferredCategory) ?? null;
        }
        subject = label ? `This week in ${label} \u00b7 ${range}` : generalSubject;
        html = renderHtml(s.token, set, label);
        text = renderText(s.token, set, label);
      }

      const res = await sendEmail({
        to: s.email,
        subject,
        html,
        text,
        headers: oneClickUnsubscribeHeaders(s.token),
      });
      if (res.delivered) sent++;
      else failed++;
      await heartbeatJob(WEEKLY_NEWSLETTER_JOB, runId, { recipients: subscribers.length, sent, failed });
      await sleep(SEND_GAP_MS);
    }

    logger.info(
      { recipients: subscribers.length, sent, failed, articles: articles.length },
      "Weekly newsletter batch complete",
    );
    return { started: true, recipients: subscribers.length, sent, failed, articles: articles.length };
  } catch (e) {
    runError = e;
    throw e;
  } finally {
    await finishJob(WEEKLY_NEWSLETTER_JOB, runId, runError ? "failed" : "succeeded", {
      error: runError ? (runError instanceof Error ? runError.message : String(runError)) : undefined,
    });
  }
}

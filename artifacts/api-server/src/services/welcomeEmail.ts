import { sendEmail, type EmailSendResult } from "./email";
import {
  type FeedArticle,
  fetchRandomArticles,
  siteUrl,
  emailImageSrc,
  unsubscribeUrl,
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

function expectRow(text: string): string {
  return `<tr>
    <td valign="top" style="padding:0 12px 14px 0;width:18px;">
      <div style="width:7px;height:7px;border-radius:50%;background:${TERRACOTTA};margin-top:7px;"></div>
    </td>
    <td valign="top" style="padding:0 0 14px;font-family:${SERIF};font-size:15px;line-height:1.55;color:${BODY};">${text}</td>
  </tr>`;
}

function feedRow(a: FeedArticle): string {
  const url = siteUrl(`/article/${a.slug}`);
  const meta = `${htmlEscape(a.category)} &middot; ${a.readingTimeMinutes} min read`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">
    <tr>
      <td valign="top" width="108" style="width:108px;padding-right:16px;">
        <a href="${url}" style="text-decoration:none;">
          <img src="${emailImageSrc(a.heroImage, a.isShareCard, 240)}" width="108" height="72" alt="" style="display:block;width:108px;height:72px;object-fit:cover;border-radius:8px;border:1px solid ${RULE};" />
        </a>
      </td>
      <td valign="top">
        <p style="margin:0 0 5px;font-family:${SANS};font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${TERRACOTTA};font-weight:700;">${meta}</p>
        <a href="${url}" style="font-family:${SERIF};font-size:17px;line-height:1.3;color:${INK};font-weight:700;text-decoration:none;">${htmlEscape(a.newsletterTitle)}</a>
      </td>
    </tr>
  </table>`;
}

function feedSection(articles: FeedArticle[]): string {
  if (articles.length === 0) return "";
  return `<tr><td class="px" style="padding:34px 48px 0;">
          <div style="border-top:1px solid ${RULE};padding-top:24px;">
            <p style="margin:0 0 18px;font-family:${SANS};font-size:12px;letter-spacing:2px;text-transform:uppercase;color:${MUTED};font-weight:700;">A taste of the magazine</p>
            ${articles.map(feedRow).join("\n")}
          </div>
        </td></tr>`;
}

function renderHtml(token: string, articles: FeedArticle[]): string {
  const home = siteUrl("/");
  const unsub = unsubscribeUrl(token);
  const year = new Date().getFullYear();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<title>Welcome to BrainHook</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;800&display=swap');
  body { margin:0; padding:0; }
  @media (max-width:600px) {
    .px { padding-left:26px !important; padding-right:26px !important; }
    .h1 { font-size:32px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${CREAM_OUTER};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${CREAM_OUTER};">You're on the list — the most curious, can't-look-away stories on the internet are headed to your inbox.</div>
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
          <p style="margin:0 0 16px;font-family:${SANS};font-size:12px;letter-spacing:2px;text-transform:uppercase;color:${MUTED};font-weight:700;">Welcome aboard</p>
          <h1 class="h1" style="margin:0;font-family:${SERIF};font-size:40px;line-height:1.08;color:${INK};font-weight:800;letter-spacing:-0.5px;">You're on the list.</h1>
        </td></tr>
        <tr><td class="px" style="padding:20px 48px 0;">
          <p style="margin:0 0 16px;font-family:${SERIF};font-size:17px;line-height:1.65;color:${BODY};">
            Thanks for subscribing. From here on, the most curious, can't-look-away stories we publish &mdash; the science, the mysteries, the gloriously strange corners of being human &mdash; land straight in your inbox.
          </p>
          <p style="margin:0;font-family:${SERIF};font-size:17px;line-height:1.65;color:${BODY};">
            No BS. Just real research with a hook you'll actually want to follow.
          </p>
        </td></tr>

        <!-- CTA -->
        <tr><td class="px" style="padding:28px 48px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="border-radius:9px;background:${TERRACOTTA};">
              <a href="${home}" style="display:inline-block;padding:14px 28px;font-family:${SANS};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:9px;">Start reading &rarr;</a>
            </td>
          </tr></table>
        </td></tr>

        <!-- Article feed -->
        ${feedSection(articles)}

        <!-- What to expect -->
        <tr><td class="px" style="padding:34px 48px 0;">
          <div style="border-top:1px solid ${RULE};padding-top:24px;">
            <p style="margin:0 0 16px;font-family:${SANS};font-size:12px;letter-spacing:2px;text-transform:uppercase;color:${MUTED};font-weight:700;">What to expect</p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
              ${expectRow("One weekly issue of our best stories &mdash; never daily inbox noise.")}
              ${expectRow("The <em>why</em> behind the headline, reported properly.")}
              ${expectRow("Curiosities from science, space, the mind, and the wonderfully unexplained.")}
            </table>
          </div>
        </td></tr>

        <!-- Footer -->
        <tr><td class="px" style="padding:30px 48px 40px;">
          <div style="border-top:1px solid ${RULE};padding-top:20px;">
            <p style="margin:0 0 8px;font-family:${SANS};font-size:12px;line-height:1.6;color:${MUTED};">
              You're receiving this because someone signed up with this email at <a href="${home}" style="color:${MUTED};text-decoration:underline;">BrainHook</a>. If that wasn't you, you can safely ignore this message.
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

function renderText(token: string, articles: FeedArticle[]): string {
  const lines = [
    "BrainHook",
    "",
    "You're on the list.",
    "",
    "Thanks for subscribing. From here on, the most curious, can't-look-away stories we publish — the science, the mysteries, the gloriously strange corners of being human — land straight in your inbox.",
    "",
    "No BS. Just real research with a hook you'll actually want to follow.",
    "",
    `Start reading: ${siteUrl("/")}`,
  ];

  if (articles.length > 0) {
    lines.push("", "A taste of the magazine:");
    for (const a of articles) {
      lines.push(`- ${a.newsletterTitle} (${a.category}, ${a.readingTimeMinutes} min) — ${siteUrl(`/article/${a.slug}`)}`);
    }
  }

  lines.push(
    "",
    "What to expect:",
    "- One weekly issue of our best stories — never daily inbox noise.",
    "- The why behind the headline, reported properly.",
    "- Curiosities from science, space, the mind, and the wonderfully unexplained.",
    "",
    "You're receiving this because someone signed up with this email at BrainHook.",
    "If that wasn't you, you can safely ignore this message.",
    "",
    `Unsubscribe anytime: ${unsubscribeUrl(token)}`,
  );

  return lines.join("\n");
}

/**
 * Send the welcome/confirmation email to a freshly-subscribed reader. The
 * `unsubscribeToken` is embedded in a one-click opt-out link (CAN-SPAM/GDPR
 * compliance). A small feed of random published articles is included so the
 * email leads with real content. Returns the send result; never throws
 * (delegates to sendEmail's safe handling).
 */
export async function sendWelcomeEmail(email: string, unsubscribeToken: string): Promise<EmailSendResult> {
  let articles: FeedArticle[] = [];
  try {
    articles = await fetchRandomArticles(3);
  } catch {
    articles = [];
  }
  return sendEmail({
    to: email,
    subject: "Welcome to BrainHook",
    html: renderHtml(unsubscribeToken, articles),
    text: renderText(unsubscribeToken, articles),
  });
}

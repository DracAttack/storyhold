import { Router, type IRouter } from "express";
import { db, articlesTable, authorsTable, type ArticleBlock } from "@workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";

const router: IRouter = Router();

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Render an article's structured body into self-contained HTML for the feed's
 * <content:encoded> field. MSN and other syndication partners ingest the full
 * body from here. Internal "relatedArticle" navigation blocks are omitted since
 * they only make sense inside the SPA.
 */
function renderBodyHtml(body: ArticleBlock[], base: string): string {
  const parts: string[] = [];
  for (const block of body) {
    const content = ("content" in block ? block.content : "") ?? "";
    switch (block.type) {
      case "paragraph":
        if (content.trim()) parts.push(`<p>${xmlEscape(content)}</p>`);
        break;
      case "heading":
        if (content.trim()) parts.push(`<h2>${xmlEscape(content)}</h2>`);
        break;
      case "pullquote":
        if (content.trim()) parts.push(`<blockquote>${xmlEscape(content)}</blockquote>`);
        break;
      case "image": {
        if (!content.trim()) break;
        const src = content.startsWith("http") ? content : `${base}${content.startsWith("/") ? "" : "/"}${content}`;
        parts.push(`<figure><img src="${xmlEscape(src)}" alt="" /></figure>`);
        break;
      }
      case "relatedArticle":
      default:
        break;
    }
  }
  return parts.join("\n");
}

function siteBaseUrl(req: { protocol: string; get: (h: string) => string | undefined }): string {
  const env = process.env["SITE_BASE_URL"];
  if (env) return env.replace(/\/$/, "");
  const domains = process.env["REPLIT_DOMAINS"];
  if (domains) return `https://${domains.split(",")[0]!.trim()}`;
  const replit = process.env["REPLIT_DEV_DOMAIN"];
  if (replit) return `https://${replit}`;
  const host = req.get("host") ?? "localhost";
  return `${req.protocol}://${host}`;
}

router.get("/rss.xml", async (req, res) => {
  const base = siteBaseUrl(req);
  const rows = await db
    .select()
    .from(articlesTable)
    .innerJoin(authorsTable, eq(authorsTable.id, articlesTable.authorId))
    .where(and(eq(articlesTable.status, "published"), isNull(articlesTable.quarantinedAt)))
    .orderBy(desc(articlesTable.publishedAt))
    .limit(50);

  const items = rows
    .map((r) => {
      const a = r.articles;
      const author = r.authors;
      const link = `${base}/article/${a.slug}`;
      const pub = (a.publishedAt ?? a.updatedAt ?? a.createdAt) as Date;
      const bodyHtml = renderBodyHtml(a.body ?? [], base);
      return `    <item>
      <title>${xmlEscape(a.title)}</title>
      <link>${xmlEscape(link)}</link>
      <guid isPermaLink="true">${xmlEscape(link)}</guid>
      <pubDate>${new Date(pub).toUTCString()}</pubDate>
      <category>${xmlEscape(a.category)}</category>
      <dc:creator>${xmlEscape(author.name)}</dc:creator>
      <description>${xmlEscape(a.dek ?? "")}</description>
      <content:encoded><![CDATA[${bodyHtml}]]></content:encoded>
    </item>`;
    })
    .join("\n");

  const lastBuild = rows.length > 0
    ? new Date(rows[0]!.articles.publishedAt ?? rows[0]!.articles.updatedAt ?? rows[0]!.articles.createdAt).toUTCString()
    : new Date().toUTCString();

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>BrainHook</title>
    <link>${xmlEscape(base)}</link>
    <atom:link href="${xmlEscape(base + "/rss.xml")}" rel="self" type="application/rss+xml" />
    <description>Exploring the universe within and without. Real research without the clickbait.</description>
    <language>en-us</language>
    <lastBuildDate>${lastBuild}</lastBuildDate>
${items}
  </channel>
</rss>`;

  res.set("Content-Type", "application/rss+xml; charset=utf-8");
  res.set("Cache-Control", "public, max-age=300");
  res.send(xml);
});

export default router;

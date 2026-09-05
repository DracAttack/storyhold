import { Router, type IRouter, type Request, type Response } from "express";
import { db, articlesTable, beatsTable, authorsTable, conceptsTable } from "@workspace/db";
import { and, asc, desc, eq, isNull, max, ne } from "drizzle-orm";
import { getIndexNowKey } from "../lib/indexnow";
import { getSiteSettings } from "../services/siteSettings";
import { buildRobotsTxt } from "../lib/robots";

const router: IRouter = Router();

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function siteBaseUrl(req: Request): string {
  const env = process.env["SITE_BASE_URL"];
  if (env) return env.replace(/\/$/, "");
  const domains = process.env["REPLIT_DOMAINS"];
  const firstDomain = domains?.split(",")[0]?.trim();
  if (firstDomain) return firstDomain.startsWith("http") ? firstDomain.replace(/\/$/, "") : `https://${firstDomain}`;
  const replit = process.env["REPLIT_DEV_DOMAIN"];
  if (replit) return `https://${replit}`;
  const host = req.get("host") ?? "localhost";
  return `${req.protocol}://${host}`;
}

// Static trust/policy pages (besides "/" and "/about") that should appear in
// the sitemap. Keep in sync with the public routes in the site artifact.
const STATIC_PAGES = ["/contact", "/privacy", "/terms", "/editorial-policy", "/corrections"] as const;

type SitemapEntry = { loc: string; lastmod?: Date | null; changefreq: string; priority: string };

function renderUrlSet(entries: SitemapEntry[]): string {
  const urls = entries
    .map((e) => {
      const lastmod = e.lastmod ? `\n    <lastmod>${new Date(e.lastmod).toISOString()}</lastmod>` : "";
      return `  <url>\n    <loc>${xmlEscape(e.loc)}</loc>${lastmod}\n    <changefreq>${e.changefreq}</changefreq>\n    <priority>${e.priority}</priority>\n  </url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
}

function renderSitemapIndex(base: string, maps: Array<{ path: string; lastmod?: Date | null }>): string {
  const entries = maps
    .map((m) => {
      const lastmod = m.lastmod ? `\n    <lastmod>${new Date(m.lastmod).toISOString()}</lastmod>` : "";
      return `  <sitemap>\n    <loc>${xmlEscape(`${base}${m.path}`)}</loc>${lastmod}\n  </sitemap>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>`;
}

// In-memory last-good sitemaps. If a request hits a transient DB error, we serve
// the most recent good XML instead of a 500 — a 500 on /sitemap.xml is what
// makes Google Search Console report "Couldn't fetch".
const lastGood: Record<string, string | null> = {
  index: null,
  articles: null,
  glossary: null,
  categories: null,
  static: null,
};

function sendXml(res: Response, xml: string, maxAge = 300): void {
  res.set("Content-Type", "application/xml; charset=utf-8");
  res.set("Cache-Control", `public, max-age=${maxAge}`);
  res.send(xml);
}

// ── Shared data fetch ──────────────────────────────────────────────────────

async function fetchSitemapData() {
  const settings = await getSiteSettings();
  const conceptsEnabled = settings.conceptExplainersEnabled;

  const [articles, beats, authorRows, conceptRows] = await Promise.all([
    db
      .select({
        slug: articlesTable.slug,
        categorySlug: articlesTable.categorySlug,
        updatedAt: articlesTable.updatedAt,
        publishedAt: articlesTable.publishedAt,
      })
      .from(articlesTable)
      .where(and(eq(articlesTable.status, "published"), isNull(articlesTable.quarantinedAt)))
      .orderBy(desc(articlesTable.publishedAt))
      .limit(5000),
    db
      .select({ slug: beatsTable.slug })
      .from(beatsTable)
      .orderBy(asc(beatsTable.sortOrder), asc(beatsTable.name)),
    db
      .select({
        slug: authorsTable.slug,
        lastPublishedAt: max(articlesTable.publishedAt),
      })
      .from(authorsTable)
      .innerJoin(
        articlesTable,
        and(
          eq(articlesTable.authorId, authorsTable.id),
          eq(articlesTable.status, "published"),
          isNull(articlesTable.quarantinedAt),
        ),
      )
      .groupBy(authorsTable.slug)
      .orderBy(asc(authorsTable.slug)),
    conceptsEnabled
      ? db
          .select({ slug: conceptsTable.slug, updatedAt: conceptsTable.updatedAt })
          .from(conceptsTable)
          .where(
            and(
              eq(conceptsTable.status, "live"),
              // Hidden terms are excluded from the sitemap entirely.
              eq(conceptsTable.termOfDayBlocked, false),
              ne(conceptsTable.definition, ""),
            ),
          )
          .orderBy(asc(conceptsTable.slug))
          .limit(2000)
      : Promise.resolve([]),
  ]);

  const populatedCategorySlugs = new Set(articles.map((a) => a.categorySlug));
  const populatedBeats = beats.filter((b) => populatedCategorySlugs.has(b.slug));

  return { articles, populatedBeats, authorRows, conceptRows, conceptsEnabled };
}

// ── Sitemap index ──────────────────────────────────────────────────────────

router.get("/sitemap.xml", async (req, res) => {
  const base = siteBaseUrl(req);
  try {
    const { articles, populatedBeats, authorRows, conceptRows, conceptsEnabled } = await fetchSitemapData();

    const maps: Array<{ path: string; lastmod?: Date | null }> = [
      { path: "/sitemap-static.xml" },
      { path: "/sitemap-categories.xml" },
      ...(authorRows.length > 0 ? [{ path: "/sitemap-authors.xml" }] : []),
      ...(articles.length > 0 ? [{ path: "/sitemap-articles.xml" }] : []),
      ...(conceptsEnabled && conceptRows.length > 0 ? [{ path: "/sitemap-glossary.xml" }] : []),
    ];

    const xml = renderSitemapIndex(base, maps);
    lastGood.index = xml;
    sendXml(res, xml);
  } catch (err) {
    req.log.error({ err }, "sitemap-index generation failed; serving fallback");
    const fallback =
      lastGood.index ??
      renderSitemapIndex(base, [
        { path: "/sitemap-static.xml" },
        { path: "/sitemap-categories.xml" },
      ]);
    sendXml(res, fallback, 60);
  }
});

// ── Static pages sitemap ───────────────────────────────────────────────────

router.get("/sitemap-static.xml", async (req, res) => {
  const base = siteBaseUrl(req);
  try {
    const settings = await getSiteSettings();
    const conceptsEnabled = settings.conceptExplainersEnabled;

    const entries: SitemapEntry[] = [
      { loc: `${base}/`, changefreq: "hourly", priority: "1.0" },
      { loc: `${base}/about`, changefreq: "monthly", priority: "0.5" },
      ...(conceptsEnabled ? [{ loc: `${base}/glossary`, changefreq: "monthly", priority: "0.4" }] : []),
      ...STATIC_PAGES.map((p) => ({
        loc: `${base}${p}`,
        changefreq: "monthly" as const,
        priority: "0.4",
      })),
    ];

    const xml = renderUrlSet(entries);
    lastGood.static = xml;
    sendXml(res, xml);
  } catch (err) {
    req.log.error({ err }, "sitemap-static generation failed; serving fallback");
    const fallback =
      lastGood.static ?? renderUrlSet([{ loc: `${base}/`, changefreq: "hourly", priority: "1.0" }]);
    sendXml(res, fallback, 60);
  }
});

// ── Categories sitemap ─────────────────────────────────────────────────────

router.get("/sitemap-categories.xml", async (req, res) => {
  const base = siteBaseUrl(req);
  try {
    const { populatedBeats } = await fetchSitemapData();
    const entries: SitemapEntry[] = populatedBeats.map((b) => ({
      loc: `${base}/category/${b.slug}`,
      changefreq: "daily",
      priority: "0.7",
    }));
    const xml = renderUrlSet(entries);
    lastGood.categories = xml;
    sendXml(res, xml);
  } catch (err) {
    req.log.error({ err }, "sitemap-categories generation failed; serving fallback");
    const fallback = lastGood.categories ?? renderUrlSet([]);
    sendXml(res, fallback, 60);
  }
});

// ── Authors sitemap ────────────────────────────────────────────────────────

router.get("/sitemap-authors.xml", async (req, res) => {
  const base = siteBaseUrl(req);
  try {
    const { authorRows } = await fetchSitemapData();
    const entries: SitemapEntry[] = authorRows.map((a) => ({
      loc: `${base}/author/${a.slug}`,
      lastmod: a.lastPublishedAt ? new Date(a.lastPublishedAt) : null,
      changefreq: "weekly",
      priority: "0.6",
    }));
    const xml = renderUrlSet(entries);
    lastGood.authors = xml;
    sendXml(res, xml);
  } catch (err) {
    req.log.error({ err }, "sitemap-authors generation failed; serving fallback");
    const fallback = lastGood.authors ?? renderUrlSet([]);
    sendXml(res, fallback, 60);
  }
});

// ── Articles sitemap ───────────────────────────────────────────────────────

router.get("/sitemap-articles.xml", async (req, res) => {
  const base = siteBaseUrl(req);
  try {
    const { articles } = await fetchSitemapData();
    const entries: SitemapEntry[] = articles.map((a) => ({
      loc: `${base}/article/${a.slug}`,
      lastmod: a.updatedAt ?? a.publishedAt,
      changefreq: "weekly",
      priority: "0.8",
    }));
    const xml = renderUrlSet(entries);
    lastGood.articles = xml;
    sendXml(res, xml);
  } catch (err) {
    req.log.error({ err }, "sitemap-articles generation failed; serving fallback");
    const fallback = lastGood.articles ?? renderUrlSet([]);
    sendXml(res, fallback, 60);
  }
});

// ── Glossary sitemap ───────────────────────────────────────────────────────

router.get("/sitemap-glossary.xml", async (req, res) => {
  const base = siteBaseUrl(req);
  try {
    const { conceptRows, conceptsEnabled } = await fetchSitemapData();
    if (!conceptsEnabled) {
      sendXml(res, renderUrlSet([]));
      return;
    }
    const entries: SitemapEntry[] = conceptRows.map((c) => ({
      loc: `${base}/glossary/${c.slug}`,
      lastmod: c.updatedAt,
      changefreq: "weekly",
      priority: "0.7",
    }));
    const xml = renderUrlSet(entries);
    lastGood.glossary = xml;
    sendXml(res, xml);
  } catch (err) {
    req.log.error({ err }, "sitemap-glossary generation failed; serving fallback");
    const fallback = lastGood.glossary ?? renderUrlSet([]);
    sendXml(res, fallback, 60);
  }
});

// ── robots.txt ────────────────────────────────────────────────────────────

router.get("/robots.txt", (req, res) => {
  const body = buildRobotsTxt(siteBaseUrl(req));
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.set("Cache-Control", "public, max-age=3600");
  res.send(body);
});

// ── ads.txt ────────────────────────────────────────────────────────────────

const DEFAULT_ADSENSE_PUBLISHER_ID = "pub-2106395417721931";

router.get("/ads.txt", (_req, res) => {
  const pubId = process.env["ADSENSE_PUBLISHER_ID"]?.trim() || DEFAULT_ADSENSE_PUBLISHER_ID;
  const normalized = pubId.startsWith("pub-") ? pubId : `pub-${pubId}`;
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.set("Cache-Control", "public, max-age=86400");
  res.send(`google.com, ${normalized}, DIRECT, f08c47fec0942fa0\n`);
});

// ── indexnow-key.txt ──────────────────────────────────────────────────────

router.get("/indexnow-key.txt", (_req, res) => {
  const key = getIndexNowKey();
  if (!key) {
    res.status(404).type("text/plain").send("");
    return;
  }
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.set("Cache-Control", "public, max-age=86400");
  res.send(key);
});

export default router;

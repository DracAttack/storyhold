import { Router, type IRouter } from "express";
import { timingSafeEqual } from "node:crypto";
import { db, articlesTable, beatsTable, authorsTable, sourceDocumentsTable } from "@workspace/db";
import { and, desc, eq, isNull, asc, sql } from "drizzle-orm";
import { checkContains, validateDefinedTermJsonLd, type CheckResult } from "./healthz-seo.checks";

const router: IRouter = Router();

// Constant-time token comparison (same helper as cron.ts).
function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function fetchPage(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "BrainHook-SmokeCheck/1.0 (healthz-seo)" },
      signal: controller.signal,
    });
    if (!res.ok) {
      return "";
    }
    return await res.text();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "BrainHook-SmokeCheck/1.0 (healthz-seo)" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Resolve the site origin to probe. Order: SITE_BASE_URL → REPLIT_DOMAINS → REPLIT_DEV_DOMAIN.
function resolveSiteBase(): string {
  const env = process.env["SITE_BASE_URL"];
  if (env) return env.replace(/\/$/, "");
  const domains = process.env["REPLIT_DOMAINS"];
  const first = domains?.split(",")[0]?.trim();
  if (first) return first.startsWith("http") ? first.replace(/\/$/, "") : `https://${first}`;
  const dev = process.env["REPLIT_DEV_DOMAIN"];
  if (dev) return `https://${dev}`;
  return "https://brainhook.net";
}

// Soft vault-lane check: queries the same aggregate the admin Glossary Vault
// panel uses. Returns a warning (not a hard fail) so a transient embed-sweep
// lag doesn't trigger a 503 / UptimeRobot page. The check fires only when at
// least one live concept exists; it warns when fewer than 10% of available
// (non-unavailable) docs are embedded — catching a stalled mid-sweep, not
// just a total blackout.
async function checkGlossaryVaultLane(): Promise<CheckResult> {
  const name = "glossary vault: embed coverage ≥ 10% of available docs";
  try {
    const rows = await db
      .select({
        lifecycleStatus: sourceDocumentsTable.lifecycleStatus,
        docStatus: sourceDocumentsTable.status,
        count: sql<number>`count(*)::int`,
      })
      .from(sourceDocumentsTable)
      .where(eq(sourceDocumentsTable.discoveredVia, "glossary_concept"))
      .groupBy(sourceDocumentsTable.lifecycleStatus, sourceDocumentsTable.status);

    let embedded = 0;
    let unavailable = 0;
    let total = 0;
    for (const r of rows) {
      const n = Number(r.count);
      total += n;
      if (r.lifecycleStatus === "unavailable") {
        unavailable += n;
      } else if (r.docStatus === "embedded") {
        embedded += n;
      }
    }

    if (total === 0) {
      // No vault docs at all — reconcile hasn't run yet (fresh env). Skip.
      return { name, pass: true, warning: true, detail: "no vault docs found — reconcile may not have run yet" };
    }

    const available = total - unavailable;
    if (available === 0) {
      // All docs are unavailable — nothing to embed, treat as passing.
      return { name, pass: true, warning: true, detail: `${total} concept doc(s) all unavailable — nothing to embed` };
    }

    const ratio = embedded / available;
    if (ratio < 0.10) {
      return {
        name,
        pass: false,
        warning: true,
        detail: `${embedded}/${available} available concept docs embedded (${Math.round(ratio * 100)}%) — embed sweep may be stalled`,
      };
    }
    return { name, pass: true, warning: true, detail: `${embedded}/${available} available concept docs embedded (${Math.round(ratio * 100)}%)` };
  } catch (err) {
    return {
      name,
      pass: false,
      warning: true,
      detail: `vault query failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// GET /api/healthz-seo  (router is mounted at /api so path here is /healthz-seo)
//
// A lightweight bot-readability smoke check that mirrors the manual
// verify-bot-readable.sh script. Designed to be pinged by UptimeRobot (or
// any HTTP monitor) after every prod deploy so SSR regressions surface
// immediately rather than waiting for a crawler or social-share preview to
// fail in production.
//
// Auth: same CRON_TICK_TOKEN already used by UptimeRobot for /api/cron/tick.
//       Pass it as ?token= or X-Cron-Token header (token is never logged).
//
// Returns:
//   200  { status: "ok",       checks: [...], siteBase, slugs }            — all checks passed
//   200  { status: "degraded", checks: [...], warnings: [...], ... }        — soft warns only (e.g. vault embed lag)
//   503  { status: "fail",     checks: [...], siteBase, slugs }            — ≥1 hard check failed
//   401  { error: "unauthorized" }                                          — bad/missing token
//
// UptimeRobot "keyword" monitor config:
//   URL:     https://brainhook.net/api/healthz-seo?token=<CRON_TICK_TOKEN>
//   Keyword: "ok"   (mark DOWN when keyword is missing → catches both 503 + "degraded" bodies)
//   Alert:   Slack / email contact
router.get("/healthz-seo", async (req, res) => {
  const expected = process.env["CRON_TICK_TOKEN"]?.trim();
  if (!expected) {
    req.log.warn("healthz-seo: CRON_TICK_TOKEN is not set — refusing");
    res.status(503).json({ error: "smoke check not configured" });
    return;
  }

  const queryToken = typeof req.query["token"] === "string" ? req.query["token"] : undefined;
  const headerToken =
    typeof req.headers["x-cron-token"] === "string" ? req.headers["x-cron-token"] : undefined;
  const provided = (queryToken ?? headerToken)?.trim();

  if (!tokenMatches(provided, expected)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const siteBase = resolveSiteBase();

  // Auto-discover real slugs from the DB so checks exercise actual content.
  let categorySlug = "";
  let articleSlug = "";
  let authorSlug = "";
  let conceptSlug = "";
  let conceptTerm = "";

  try {
    const [beatRow] = await db
      .select({ slug: beatsTable.slug })
      .from(beatsTable)
      .orderBy(asc(beatsTable.sortOrder), asc(beatsTable.name))
      .limit(1);
    if (beatRow) categorySlug = beatRow.slug;

    const [articleRow] = await db
      .select({ slug: articlesTable.slug })
      .from(articlesTable)
      .where(and(eq(articlesTable.status, "published"), isNull(articlesTable.quarantinedAt)))
      .orderBy(desc(articlesTable.publishedAt))
      .limit(1);
    if (articleRow) articleSlug = articleRow.slug;

    const [authorRow] = await db
      .select({ slug: authorsTable.slug })
      .from(authorsTable)
      .orderBy(asc(authorsTable.slug))
      .limit(1);
    if (authorRow) authorSlug = authorRow.slug;

  } catch (err) {
    req.log.error({ err }, "healthz-seo: DB slug discovery failed");
    res
      .status(503)
      .json({ status: "fail", error: "db_error", siteBase, slugs: { categorySlug, articleSlug, authorSlug, conceptSlug } });
    return;
  }

  // Discover concept slug via the public API (parity with bot-facing behavior).
  // GET /api/public/concepts?limit=1 — skip gracefully when empty or unreachable.
  try {
    const conceptsJson = await fetchJson(`${siteBase}/api/public/concepts?limit=1`);
    if (
      conceptsJson !== null &&
      typeof conceptsJson === "object" &&
      !Array.isArray(conceptsJson)
    ) {
      const concepts = (conceptsJson as Record<string, unknown>)["concepts"];
      if (Array.isArray(concepts) && concepts.length > 0) {
        const first = concepts[0] as Record<string, unknown>;
        if (typeof first["slug"] === "string" && first["slug"]) {
          conceptSlug = first["slug"];
        }
        if (typeof first["term"] === "string" && first["term"]) {
          conceptTerm = first["term"];
        }
      }
    }
  } catch {
    // Non-fatal — glossary checks will simply be skipped.
  }

  const checks: CheckResult[] = [];

  // ── Homepage ──────────────────────────────────────────────────────────────
  const homeHtml = await fetchPage(`${siteBase}/`);
  checks.push(checkContains(homeHtml, 'href="/article/', "homepage: has real article links"));
  checks.push(checkContains(homeHtml, "More stories", "homepage: has 'More stories' heading"));
  checks.push(
    checkContains(homeHtml, "Brilliant ideas, delivered weekly", "homepage: has newsletter block"),
  );
  checks.push(checkContains(homeHtml, 'href="/privacy"', "homepage: footer has policy links"));
  checks.push(checkContains(homeHtml, "<footer", "homepage: has server-rendered footer"));
  if (categorySlug) {
    checks.push(
      checkContains(
        homeHtml,
        `href="/category/${categorySlug}"`,
        `homepage: footer links category '${categorySlug}'`,
      ),
    );
  }

  // ── Category page ─────────────────────────────────────────────────────────
  if (categorySlug) {
    const catHtml = await fetchPage(`${siteBase}/category/${categorySlug}`);
    checks.push(checkContains(catHtml, 'href="/article/', `category/${categorySlug}: has article links`));
    checks.push(checkContains(catHtml, "<time", `category/${categorySlug}: cards show published date`));
    checks.push(checkContains(catHtml, "min</span>", `category/${categorySlug}: cards show reading time`));
  }

  // ── Article page ──────────────────────────────────────────────────────────
  if (articleSlug) {
    const artHtml = await fetchPage(`${siteBase}/article/${articleSlug}`);
    checks.push(
      checkContains(artHtml, "application/ld+json", `article/${articleSlug}: emits Article JSON-LD`),
    );
    checks.push(
      checkContains(artHtml, "More like this", `article/${articleSlug}: has related-articles section`),
    );
    checks.push(
      checkContains(artHtml, 'href="/article/', `article/${articleSlug}: has internal article links`),
    );
    checks.push(
      checkContains(artHtml, 'href="/author/', `article/${articleSlug}: byline links to author page`),
    );
  }

  // ── Author page ───────────────────────────────────────────────────────────
  if (authorSlug) {
    const authorHtml = await fetchPage(`${siteBase}/author/${authorSlug}`);
    checks.push(checkContains(authorHtml, "All stories by", `author/${authorSlug}: has its heading`));
    checks.push(
      checkContains(authorHtml, 'href="/article/', `author/${authorSlug}: lists real article links`),
    );
  }

  // ── Glossary index ────────────────────────────────────────────────────────
  // Only run when at least one live concept exists; skip gracefully otherwise.
  if (conceptSlug) {
    const glossaryHtml = await fetchPage(`${siteBase}/glossary`);
    checks.push(
      checkContains(glossaryHtml, 'href="/glossary/', "glossary index: has crawlable concept links"),
    );
    checks.push(checkContains(glossaryHtml, "Glossary", "glossary index: has a heading"));

    // ── Glossary detail ─────────────────────────────────────────────────────
    const glossaryDetailHtml = await fetchPage(`${siteBase}/glossary/${conceptSlug}`);
    checks.push(
      checkContains(
        glossaryDetailHtml,
        "application/ld+json",
        `glossary/${conceptSlug}: emits JSON-LD`,
      ),
    );
    checks.push(
      checkContains(
        glossaryDetailHtml,
        'href="/glossary"',
        `glossary/${conceptSlug}: links back to index`,
      ),
    );

    // H1 term text is in the initial HTML — verifies renderGlossaryDetailHtml
    // runs server-side and the content is visible to crawlers on first byte,
    // not deferred behind a JS fetch / loading skeleton.
    if (conceptTerm) {
      checks.push(
        checkContains(
          glossaryDetailHtml,
          `<h1`,
          `glossary/${conceptSlug}: page contains an H1 element`,
        ),
      );
      checks.push(
        checkContains(
          glossaryDetailHtml,
          conceptTerm,
          `glossary/${conceptSlug}: H1 term text "${conceptTerm}" present in initial HTML`,
        ),
      );
    }

    // ssr-data-concept-detail script tag — verifies the serializedData path
    // that seeds the React Query cache on client hydration is embedded in the
    // server-rendered shell.  A missing tag means the client falls back to a
    // network fetch, causing the loading-flash this fix was meant to eliminate.
    checks.push(
      checkContains(
        glossaryDetailHtml,
        'id="ssr-data-concept-detail"',
        `glossary/${conceptSlug}: ssr-data-concept-detail hydration script is present`,
      ),
    );

    // Validate DefinedTerm JSON-LD fields — mirrors the Python validator in
    // verify-bot-readable.sh.  Find any ld+json block whose @type is DefinedTerm
    // (the glossary detail page emits a single primary block, not the per-article
    // seo-jsonld-term-N pattern).
    const definedTermResult = validateDefinedTermJsonLd(glossaryDetailHtml, conceptSlug);
    checks.push(definedTermResult);

    // Vault lane health — soft warning only (doesn't drive 503).
    // Catches a broken embed sweep before it silently starves drafts of
    // concept memory. Runs alongside other glossary checks so it's skipped
    // cleanly on environments with no live concepts.
    const vaultCheck = await checkGlossaryVaultLane();
    checks.push(vaultCheck);
  }

  // Warning checks (warning: true) produce a "degraded" status (HTTP 200)
  // rather than "fail" (503) — a transient embed lag shouldn't page at 3am.
  // Hard failures still produce "fail" + 503.
  const hardFailed = checks.filter((c) => !c.pass && !c.warning);
  const warnFailed = checks.filter((c) => !c.pass && c.warning);
  const status =
    hardFailed.length > 0 ? "fail" : warnFailed.length > 0 ? "degraded" : "ok";

  // Collect glossary-specific hard failures into a dedicated key so downstream
  // monitors can identify the exact regression without parsing the full array.
  const glossaryFailed = hardFailed.filter((c) => c.name.startsWith("glossary/"));
  const glossaryDetail =
    glossaryFailed.length > 0
      ? glossaryFailed.map((c) => ({ name: c.name, detail: c.detail ?? "check failed" }))
      : undefined;

  if (hardFailed.length > 0) {
    req.log.warn(
      { failed: hardFailed.map((c) => c.name), siteBase },
      "healthz-seo: smoke check failed",
    );
  } else if (warnFailed.length > 0) {
    req.log.warn(
      { warnings: warnFailed.map((c) => ({ name: c.name, detail: c.detail })), siteBase },
      "healthz-seo: passed with warnings",
    );
  } else {
    req.log.info({ total: checks.length, siteBase }, "healthz-seo: all checks passed");
  }

  res
    .status(hardFailed.length === 0 ? 200 : 503)
    .json({
      status,
      checks,
      siteBase,
      slugs: { categorySlug, articleSlug, authorSlug, conceptSlug, conceptTerm },
      ...(glossaryDetail !== undefined ? { glossary_detail: glossaryDetail } : {}),
      ...(warnFailed.length > 0
        ? { warnings: warnFailed.map((c) => ({ name: c.name, detail: c.detail ?? "check failed" })) }
        : {}),
    });
});

export default router;

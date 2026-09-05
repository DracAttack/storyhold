import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRobotsTxt } from "../lib/robots";

const BASE = "https://brainhook.net";
const robots = buildRobotsTxt(BASE);

// Crawlers that must each have their own `Disallow: /` group (bulk-dataset /
// non-product harvesters we never want crawling the site).
const TRAINING_CRAWLERS = [
  "CCBot",
  "Meta-ExternalAgent",
  "meta-externalagent",
  "Bytespider",
  "Amazonbot",
] as const;

// User-agent groups that must allow the site + hero images but keep admin/API
// private (search-surfacing crawlers, AI product crawlers, and the wildcard default).
const ALLOWED_GROUPS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "anthropic-ai",
  "Google-Extended",
  "Applebot-Extended",
  "Mediapartners-Google",
  "*",
] as const;

/**
 * Returns the lines belonging to a `User-agent: <name>` group: every line after
 * the matching `User-agent:` directive up to (but not including) the next blank
 * line. Returns null when the group is absent.
 */
function groupLines(robotsTxt: string, agent: string): string[] | null {
  const lines = robotsTxt.split("\n");
  const start = lines.findIndex((l) => l.trim() === `User-agent: ${agent}`);
  if (start === -1) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? "";
    if (line === "") break;
    body.push(line);
  }
  return body;
}

for (const agent of TRAINING_CRAWLERS) {
  test(`robots.txt: ${agent} has its own Disallow: / group`, () => {
    const body = groupLines(robots, agent);
    assert.ok(body, `missing User-agent group for ${agent}`);
    assert.deepEqual(body, ["Disallow: /"], `${agent} should fully block crawling`);
  });
}

for (const agent of ALLOWED_GROUPS) {
  test(`robots.txt: ${agent} allows site + hero images but blocks admin/api`, () => {
    const body = groupLines(robots, agent);
    assert.ok(body, `missing User-agent group for ${agent}`);
    assert.ok(body.includes("Allow: /"), `${agent} should allow /`);
    assert.ok(
      body.includes("Allow: /api/storage/public-objects/"),
      `${agent} should allow hero images`,
    );
    assert.ok(body.includes("Disallow: /admin"), `${agent} should disallow /admin`);
    assert.ok(body.includes("Disallow: /api/"), `${agent} should disallow /api/`);
  });
}

test("robots.txt: includes the Sitemap line", () => {
  assert.ok(
    robots.includes(`Sitemap: ${BASE}/sitemap.xml`),
    "robots.txt must advertise the sitemap",
  );
});

test("robots.txt: Mediapartners-Google can crawl glossary for AdSense", () => {
  const body = groupLines(robots, "Mediapartners-Google");
  assert.ok(body, "missing User-agent group for Mediapartners-Google");
  assert.ok(body.includes("Allow: /"), "Mediapartners-Google should allow /");
  assert.ok(body.includes("Allow: /glossary"), "Mediapartners-Google must allow /glossary");
  assert.ok(body.includes("Allow: /glossary/"), "Mediapartners-Google must allow /glossary/");
  assert.ok(body.includes("Disallow: /admin"), "Mediapartners-Google should disallow /admin");
});

test("robots.txt: training crawlers are not accidentally allowed", () => {
  for (const agent of TRAINING_CRAWLERS) {
    const body = groupLines(robots, agent);
    assert.ok(body, `missing group for ${agent}`);
    assert.ok(!body.some((l) => l.startsWith("Allow:")), `${agent} must not have an Allow rule`);
  }
});

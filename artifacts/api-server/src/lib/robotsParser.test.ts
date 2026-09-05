import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRobotsTxt, isPathAllowed } from "./robots";

const SAMPLE = `
# example robots
User-agent: *
Disallow: /private/
Disallow: /tmp/
Allow: /private/public-note

User-agent: BadBot
Disallow: /
`;

test("wildcard group disallows and allows by longest match", () => {
  const p = parseRobotsTxt(SAMPLE);
  assert.equal(isPathAllowed(p, "/articles/foo"), true);
  assert.equal(isPathAllowed(p, "/private/secret"), false);
  // Allow is more specific than the /private/ disallow → allowed.
  assert.equal(isPathAllowed(p, "/private/public-note"), true);
});

test("named user-agent group overrides wildcard", () => {
  const p = parseRobotsTxt(SAMPLE);
  assert.equal(isPathAllowed(p, "/articles/foo", "BadBot/1.0"), false);
  assert.equal(isPathAllowed(p, "/anything", "Mozilla BadBot"), false);
});

test("empty disallow means allow everything", () => {
  const p = parseRobotsTxt("User-agent: *\nDisallow:");
  assert.equal(isPathAllowed(p, "/anything"), true);
});

test("no robots rules → allowed", () => {
  const p = parseRobotsTxt("# just a comment\n\n");
  assert.equal(isPathAllowed(p, "/anything"), true);
});

test("parser never throws on garbage", () => {
  const p = parseRobotsTxt("::::\nnonsense line\nUser-agent\nDisallow");
  assert.ok(p.groups instanceof Map);
});

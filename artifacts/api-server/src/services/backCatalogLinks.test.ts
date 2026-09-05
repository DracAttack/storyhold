import { test } from "node:test";
import assert from "node:assert/strict";
import type { ArticleBlock } from "@workspace/db";
import {
  canonicalizeUrl,
  isInternalUrl,
  domainOf,
  extractOutboundLinks,
} from "./backCatalogLinks";

// --- isInternalUrl -------------------------------------------------------

test("isInternalUrl: relative, anchor, and non-web schemes are internal", () => {
  for (const href of [
    "/article/some-slug",
    "#section",
    "./x",
    "../y",
    "mailto:hi@brainhook.net",
    "tel:+15551234567",
    "javascript:void(0)",
    "data:text/plain;base64,AAAA",
    "not a url",
  ]) {
    assert.equal(isInternalUrl(href), true, href);
  }
});

test("isInternalUrl: our own site is internal, other hosts are outbound", () => {
  assert.equal(isInternalUrl("https://brainhook.net/foo"), true);
  assert.equal(isInternalUrl("https://www.brainhook.net/foo"), true);
  assert.equal(isInternalUrl("https://nytimes.com/story"), false);
  assert.equal(isInternalUrl("http://arxiv.org/abs/1234"), false);
});

// --- canonicalizeUrl -----------------------------------------------------

test("canonicalizeUrl: strips tracking params, keeps real ones sorted", () => {
  assert.equal(
    canonicalizeUrl("https://example.com/a?utm_source=x&b=2&fbclid=z&a=1"),
    "https://example.com/a?a=1&b=2",
  );
});

test("canonicalizeUrl: lowercases host, preserves path case, drops hash", () => {
  assert.equal(
    canonicalizeUrl("https://Example.COM/Path/To?q=1#frag"),
    "https://example.com/Path/To?q=1",
  );
});

test("canonicalizeUrl: collapses root trailing slash, tracking-only query removed", () => {
  assert.equal(canonicalizeUrl("https://example.com/?utm_medium=email"), "https://example.com");
  assert.equal(canonicalizeUrl("https://example.com/"), "https://example.com");
});

test("canonicalizeUrl: two tracked variants of one URL collapse to the same key", () => {
  const a = canonicalizeUrl("https://nytimes.com/story?utm_source=fb&utm_campaign=share");
  const b = canonicalizeUrl("https://nytimes.com/story?fbclid=abc");
  const c = canonicalizeUrl("https://nytimes.com/story");
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(c, "https://nytimes.com/story");
});

test("canonicalizeUrl: rejects non-http(s) and unparseable input", () => {
  assert.equal(canonicalizeUrl("ftp://example.com/x"), null);
  assert.equal(canonicalizeUrl("mailto:a@b.com"), null);
  assert.equal(canonicalizeUrl("   "), null);
  assert.equal(canonicalizeUrl("not a url"), null);
});

// --- domainOf ------------------------------------------------------------

test("domainOf: strips www and lowercases", () => {
  assert.equal(domainOf("https://www.NyTimes.com/x"), "nytimes.com");
  assert.equal(domainOf("garbage"), "");
});

// --- extractOutboundLinks ------------------------------------------------

function body(...contents: string[]): ArticleBlock[] {
  return contents.map((content) => ({ type: "paragraph", content }) as ArticleBlock);
}

test("extractOutboundLinks: pulls outbound markdown links, skips internal", () => {
  const links = extractOutboundLinks(
    body(
      "See the [study](https://arxiv.org/abs/2401.00001) and our [other piece](/article/x).",
      "Also [NYT](https://www.nytimes.com/2024/story?utm_source=x) reported it.",
    ),
  );
  const urls = links.map((l) => l.url).sort();
  assert.deepEqual(urls, [
    "https://arxiv.org/abs/2401.00001",
    "https://www.nytimes.com/2024/story",
  ]);
});

test("extractOutboundLinks: dedupes tracked variants of the same URL (first anchor wins)", () => {
  const links = extractOutboundLinks(
    body(
      "[First](https://example.com/paper?utm_source=a)",
      "[Second](https://example.com/paper?fbclid=b)",
    ),
  );
  assert.equal(links.length, 1);
  assert.equal(links[0]!.url, "https://example.com/paper");
  assert.equal(links[0]!.anchorText, "First");
});

test("extractOutboundLinks: ignores blocks with no links and empty body", () => {
  assert.deepEqual(extractOutboundLinks(body("plain text, no links")), []);
  assert.deepEqual(extractOutboundLinks([]), []);
});

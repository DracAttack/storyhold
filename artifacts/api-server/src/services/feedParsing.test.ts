import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeed, FeedParseError } from "./feedParsing";

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Science</title>
    <link>https://example.com</link>
    <item>
      <title>First discovery</title>
      <link>https://example.com/a</link>
      <guid isPermaLink="false">tag:example.com,2026:1</guid>
      <pubDate>Wed, 01 Jul 2026 12:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Second discovery</title>
      <link>https://example.com/b</link>
      <pubDate>Tue, 30 Jun 2026 08:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Atom</title>
  <entry>
    <title>Atom entry one</title>
    <link rel="alternate" href="https://example.org/one"/>
    <link rel="self" href="https://example.org/self"/>
    <id>urn:uuid:1234</id>
    <published>2026-06-15T10:30:00Z</published>
  </entry>
  <entry>
    <title>Atom entry two</title>
    <link href="https://example.org/two"/>
    <id>urn:uuid:5678</id>
    <updated>2026-06-16T10:30:00Z</updated>
  </entry>
</feed>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel><title>RDF Feed</title></channel>
  <item>
    <title>RDF item</title>
    <link>https://example.net/x</link>
    <dc:date>2026-05-01T00:00:00Z</dc:date>
  </item>
</rdf:RDF>`;

test("parses RSS 2.0 items with guid and pubDate", () => {
  const feed = parseFeed(RSS);
  assert.equal(feed.title, "Example Science");
  assert.equal(feed.items.length, 2);
  const [a, b] = feed.items;
  assert.equal(a!.dedupeKey, "tag:example.com,2026:1");
  assert.equal(a!.url, "https://example.com/a");
  assert.equal(a!.title, "First discovery");
  assert.ok(a!.publishedAt instanceof Date);
  // No guid → dedupeKey falls back to the link.
  assert.equal(b!.dedupeKey, "https://example.com/b");
});

test("parses Atom entries, preferring rel=alternate link and using id", () => {
  const feed = parseFeed(ATOM);
  assert.equal(feed.title, "Example Atom");
  assert.equal(feed.items.length, 2);
  const [a, b] = feed.items;
  assert.equal(a!.dedupeKey, "urn:uuid:1234");
  assert.equal(a!.url, "https://example.org/one");
  assert.equal(b!.url, "https://example.org/two");
  assert.ok(a!.publishedAt instanceof Date);
});

test("parses RDF / RSS 1.0 with dc:date", () => {
  const feed = parseFeed(RDF);
  assert.equal(feed.title, "RDF Feed");
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0]!.url, "https://example.net/x");
  assert.equal(feed.items[0]!.dedupeKey, "https://example.net/x");
  assert.ok(feed.items[0]!.publishedAt instanceof Date);
});

test("skips items with neither guid nor link", () => {
  const xml = `<rss version="2.0"><channel><title>T</title>
    <item><title>no identity</title></item>
    <item><title>ok</title><link>https://ok.com/1</link></item>
  </channel></rss>`;
  const feed = parseFeed(xml);
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0]!.url, "https://ok.com/1");
});

test("invalid date yields null publishedAt, not a crash", () => {
  const xml = `<rss version="2.0"><channel><title>T</title>
    <item><link>https://ok.com/1</link><pubDate>not a date</pubDate></item>
  </channel></rss>`;
  const feed = parseFeed(xml);
  assert.equal(feed.items[0]!.publishedAt, null);
});

test("throws FeedParseError on empty body", () => {
  assert.throws(() => parseFeed(""), FeedParseError);
});

test("throws FeedParseError on non-feed XML", () => {
  assert.throws(() => parseFeed("<html><body>not a feed</body></html>"), FeedParseError);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { isJunkIngestUrl, isHubPage } from "./ingestGuards";

// --- isJunkIngestUrl -------------------------------------------------------

test("rejects CDC media/embed API downloader endpoints", () => {
  assert.equal(
    isJunkIngestUrl(
      "https://tools.cdc.gov/api/embed/downloader/download.asp?m=403372&c=750935",
    ),
    true,
  );
  assert.equal(isJunkIngestUrl("https://tools.cdc.gov/api/v2/resources/media/342778"), true);
});

test("rejects classic download.asp endpoints on any host", () => {
  assert.equal(isJunkIngestUrl("https://example.org/files/download.asp?id=9"), true);
});

test("rejects search-engine result URLs", () => {
  assert.equal(isJunkIngestUrl("https://scholar.google.com/scholar?q=meme+culture"), true);
  assert.equal(isJunkIngestUrl("https://www.google.com/search?q=bbc+strike"), true);
  assert.equal(isJunkIngestUrl("https://bing.com/search?q=x"), true);
  assert.equal(isJunkIngestUrl("https://duckduckgo.com/?q=x"), true);
});

test("rejects SciSpace intermediary URLs at ingest", () => {
  assert.equal(
    isJunkIngestUrl(
      "https://scispace.com/paper/paradoxical-effects-of-thought-suppression-1dfwms5euz",
    ),
    true,
  );
  assert.equal(
    isJunkIngestUrl("https://www.scispace.com/paper/some-other-paper-abc123"),
    true,
  );
  // Google Scholar still rejected (regression guard).
  assert.equal(isJunkIngestUrl("https://scholar.google.com/scholar?q=test"), true);
});

test("rejects raw feed documents", () => {
  assert.equal(isJunkIngestUrl("https://tools.cdc.gov/api/v2/resources/media/342778.rss"), true);
  assert.equal(isJunkIngestUrl("https://example.com/blog/feed/"), true);
  assert.equal(isJunkIngestUrl("https://example.com/rss"), true);
});

test("accepts real article URLs — including CDC's own site", () => {
  assert.equal(isJunkIngestUrl("https://www.cdc.gov/mmwr/volumes/75/wr/mm7527a1.htm"), false);
  assert.equal(isJunkIngestUrl("https://www.bbc.com/news/articles/c4gd0lg1yxpo"), false);
  assert.equal(
    isJunkIngestUrl("https://www.nytimes.com/2026/07/10/arts/music/festival-season.html"),
    false,
  );
  // A page ABOUT downloads/searching is not a search page.
  assert.equal(isJunkIngestUrl("https://example.com/news/google-search-antitrust-ruling"), false);
});

test("blank/null input is not junk", () => {
  assert.equal(isJunkIngestUrl(""), false);
  assert.equal(isJunkIngestUrl(null), false);
  assert.equal(isJunkIngestUrl(undefined), false);
});

// --- isHubPage --------------------------------------------------------------

test("detects BBC-style section fronts by title", () => {
  assert.equal(
    isHubPage({
      url: "https://www.bbc.com/news/entertainment_and_arts",
      title: "Entertainment & Arts | Latest News & Updates | BBC News",
    }),
    true,
  );
});

test("detects LibGuides research-guide hubs by title", () => {
  assert.equal(
    isHubPage({
      url: "https://guides.loc.gov/popular-culture",
      title: "Research Guides: Popular Culture: Introduction",
    }),
    true,
  );
});

test("detects 'News: Updates on …' hub feeds by title", () => {
  assert.equal(
    isHubPage({
      url: "https://example.com/pop-culture",
      title: "Pop Culture News: Updates on Music, Movies, TV and Celebrities",
    }),
    true,
  );
});

test("detects hub titles carried in leadSnippet (feed items without a title)", () => {
  assert.equal(
    isHubPage({
      url: "https://example.com/x",
      title: null,
      leadSnippet: "Culture | Latest News and Updates | Example Times",
    }),
    true,
  );
});

test("detects bare section-front URLs even with a bland title", () => {
  assert.equal(isHubPage({ url: "https://www.bbc.com/news/", title: "BBC" }), true);
  assert.equal(isHubPage({ url: "https://www.example.com/topics", title: "Topics" }), true);
  assert.equal(
    isHubPage({ url: "https://example.com/category/music/", title: "Music" }),
    true,
  );
  assert.equal(
    isHubPage({ url: "https://guides.library.edu/c.php?g=12345", title: "Course guide" }),
    true,
  );
});

test("real article headlines never match — even with site-chrome suffixes", () => {
  assert.equal(
    isHubPage({
      url: "https://www.bbc.com/news/articles/c4gd0lg1yxpo",
      title: "Grammy winners announce surprise reunion tour - BBC News",
    }),
    false,
  );
  assert.equal(
    isHubPage({
      url: "https://www.nytimes.com/2026/07/10/arts/music/festival.html",
      title: "The Latest News From the Festival Circuit Is Grim",
    }),
    false,
  );
  // "updates on" mid-sentence without the "News:" chrome prefix is prose.
  assert.equal(
    isHubPage({
      url: "https://example.com/story/abc",
      title: "Officials give updates on the wildfire response",
    }),
    false,
  );
  // Deep article under a section path is not a section front.
  assert.equal(
    isHubPage({
      url: "https://www.bbc.com/news/entertainment_and_arts-68923001",
      title: "Some real story",
    }),
    false,
  );
});

test("null/blank fields are not a hub page", () => {
  assert.equal(isHubPage({ url: null, title: null }), false);
  assert.equal(isHubPage({ url: "", title: "" }), false);
});

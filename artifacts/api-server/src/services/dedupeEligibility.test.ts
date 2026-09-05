import { test } from "node:test";
import assert from "node:assert/strict";
import {
  screenForDedupe,
  decideDupRepair,
  MIN_DEDUPE_WORDS,
  JUNK_TITLE_MAX_WORDS,
  type RepairDocFacts,
} from "./dedupeEligibility";

// --- Helpers ---------------------------------------------------------------

/** Build a long, distinct-phrase-rich article text of ~`words` words. */
function longText(seed: string, words = 400): string {
  const out: string[] = [];
  let i = 0;
  while (out.length < words) {
    out.push(`${seed}${i}`, `${seed}narrative`, `${seed}detail${i}`, "about", `${seed}topic${i % 17}`, "and");
    i++;
  }
  return out.slice(0, words).join(" ");
}

const wc = (text: string) => text.split(/\s+/).filter(Boolean).length;

function facts(overrides: Partial<RepairDocFacts>): RepairDocFacts {
  return {
    title: "A real article title",
    wordCount: 400,
    extractedText: null,
    contentHash: null,
    url: "https://example.com/a",
    canonicalUrl: null,
    ...overrides,
  };
}

// --- screenForDedupe ---------------------------------------------------------

test("captcha wall title is junk", () => {
  assert.equal(screenForDedupe("Checking your browser - reCAPTCHA", 12), "junk");
  assert.equal(screenForDedupe("Just a moment...", 40), "junk");
  assert.equal(screenForDedupe("Attention Required! | Cloudflare", 25), "junk");
  assert.equal(screenForDedupe("Access to this page has been denied", 10), "junk");
});

test("bare boilerplate titles are junk", () => {
  assert.equal(screenForDedupe("- YouTube", 30), "junk");
  assert.equal(screenForDedupe("Redirecting", 5), "junk");
  assert.equal(screenForDedupe("Redirecting...", 5), "junk");
  assert.equal(screenForDedupe("Untitled", 8), "junk");
  assert.equal(screenForDedupe("404", 3), "junk");
  assert.equal(screenForDedupe("Error", 0), "junk");
});

test("missing title with no text is junk; with real text it is not", () => {
  assert.equal(screenForDedupe(null, 10), "junk");
  assert.equal(screenForDedupe("", 0), "junk");
  assert.equal(screenForDedupe(null, 500), "eligible");
});

test("a real article ABOUT captchas is NOT junk (word cap)", () => {
  assert.equal(
    screenForDedupe("Why CAPTCHAs keep getting harder for humans", JUNK_TITLE_MAX_WORDS + 200),
    "eligible",
  );
});

test("real but short docs are thin, long docs eligible", () => {
  assert.equal(screenForDedupe("A perfectly real headline", MIN_DEDUPE_WORDS - 20), "thin");
  assert.equal(screenForDedupe("A perfectly real headline", MIN_DEDUPE_WORDS + 200), "eligible");
});

test("YouTube video pages with a real title are not junk", () => {
  assert.equal(screenForDedupe("How Rockets Land Themselves - YouTube", 900), "eligible");
});

// --- decideDupRepair ---------------------------------------------------------

test("identical junk boilerplate (hash-equal captcha pages) dissolves as junk", () => {
  const a = facts({
    title: "Checking your browser - reCAPTCHA",
    wordCount: 9,
    contentHash: "deadbeef",
    url: "https://siteA.com/story",
  });
  const b = facts({
    title: "Checking your browser - reCAPTCHA",
    wordCount: 9,
    contentHash: "deadbeef",
    url: "https://siteB.org/other",
  });
  const v = decideDupRepair(a, b);
  assert.equal(v.keep, false);
  if (!v.keep) assert.equal(v.selfJunk, true);
});

test("real doc marked duplicate of a junk representative dissolves (not junk itself)", () => {
  const article = longText("epstein");
  const self = facts({ title: "A real investigation", extractedText: article, wordCount: wc(article) });
  const rep = facts({ title: "- YouTube", wordCount: 20, url: "https://youtube.com/x" });
  const v = decideDupRepair(self, rep);
  assert.equal(v.keep, false);
  if (!v.keep) assert.equal(v.selfJunk, false);
});

test("thin nav-heavy extraction vs real article dissolves (word floor)", () => {
  const article = longText("rodents");
  const thin = "home news sports weather subscribe login menu search contact about privacy terms".repeat(2);
  const self = facts({
    title: "Polyamory parenting study",
    extractedText: thin,
    wordCount: wc(thin),
    url: "https://journalA.org/polyamory-paper",
  });
  const rep = facts({
    title: "Pathogens odors and disgust in rodents",
    extractedText: article,
    wordCount: wc(article),
    url: "https://journalB.org/rodent-disgust",
  });
  const v = decideDupRepair(self, rep);
  assert.equal(v.keep, false);
});

test("unrelated long articles (the poisoned-family case) dissolve on low containment", () => {
  const a = longText("epstein");
  const b = longText("clinton");
  const self = facts({ title: "Epstein: International Moneyman of Mystery", extractedText: a, wordCount: wc(a) });
  const rep = facts({ title: "Clinton impeachment research guide", extractedText: b, wordCount: wc(b), url: "https://loc.gov/guide" });
  const v = decideDupRepair(self, rep);
  assert.equal(v.keep, false);
  if (!v.keep) assert.match(v.reason, /phrase overlap|containment/i);
});

test("legit syndicated copy (same long text) is kept", () => {
  const a = longText("wire");
  const self = facts({ title: "Wire story", extractedText: a, wordCount: wc(a), url: "https://siteA.com/wire" });
  const rep = facts({ title: "Wire story (syndicated)", extractedText: a, wordCount: wc(a), url: "https://siteB.com/wire" });
  assert.equal(decideDupRepair(self, rep).keep, true);
});

test("hash-equal real articles are kept", () => {
  const a = longText("hash");
  const self = facts({ title: "Original", extractedText: a, wordCount: wc(a), contentHash: "abc123" });
  const rep = facts({ title: "Reprint", extractedText: a, wordCount: wc(a), contentHash: "abc123", url: "https://siteB.com/r" });
  assert.equal(decideDupRepair(self, rep).keep, true);
});

test("shared canonical URL keeps even when one side is thin (but never junk)", () => {
  const self = facts({
    title: "Story headline",
    wordCount: 40,
    url: "https://m.example.com/story",
    canonicalUrl: "https://example.com/story",
  });
  const rep = facts({ title: "Story headline", wordCount: 500, url: "https://example.com/story" });
  assert.equal(decideDupRepair(self, rep).keep, true);

  const junkSelf = facts({
    title: "Redirecting",
    wordCount: 4,
    canonicalUrl: "https://example.com/story",
  });
  assert.equal(decideDupRepair(junkSelf, rep).keep, false);
});

test("missing representative or missing text dissolves (unverifiable)", () => {
  const a = longText("solo");
  const self = facts({ title: "Orphaned dup", extractedText: a, wordCount: wc(a) });
  assert.equal(decideDupRepair(self, null).keep, false);
  const repNoText = facts({ title: "Rep without text", extractedText: null, wordCount: 400, url: "https://b.com/x" });
  assert.equal(decideDupRepair(self, repNoText).keep, false);
});

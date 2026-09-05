import { test } from "node:test";
import assert from "node:assert/strict";
import type { ArticleBlock } from "@workspace/db";
import {
  isSearchQueryUrl,
  isPrivateOrReservedIp,
  sanitizeCitations,
  stripCiteTagsFromText,
  stripCitationTags,
  scrubInternalVocabFromText,
  scrubInternalVocabulary,
} from "./citations";

test("scrubInternalVocabFromText: bare 'evidence packet' scrubbed only on packet-grounded drafts", () => {
  const grounded = scrubInternalVocabFromText("According to the evidence packet, 13 children died.", {
    packetGrounded: true,
  });
  assert.equal(grounded.scrubbed, 1);
  assert.equal(grounded.text, "According to the available evidence, 13 children died.");

  const start = scrubInternalVocabFromText("The evidence packet confirms the strike hit a hospital.", {
    packetGrounded: true,
  });
  assert.equal(start.scrubbed, 1);
  assert.equal(start.text, "The available evidence confirms the strike hit a hospital.");

  // Legitimate courtroom prose on a non-packet draft is left alone.
  const legit = scrubInternalVocabFromText("Prosecutors handed the jury an evidence packet with 40 exhibits.");
  assert.equal(legit.scrubbed, 0);
  assert.equal(legit.text, "Prosecutors handed the jury an evidence packet with 40 exhibits.");
});

test("scrubInternalVocabFromText: internal-adjective phrases always scrubbed, plural stays plural", () => {
  const adj = scrubInternalVocabFromText(
    "Our vetted evidence packet shows a pattern; the grounding evidence packets agree.",
  );
  assert.equal(adj.scrubbed, 2);
  assert.equal(adj.text, "The available evidence shows a pattern; the available sources agree.");
});

test("scrubInternalVocabFromText rewrites Source Vault mentions and leaves clean text untouched", () => {
  const vault = scrubInternalVocabFromText("Documents in the Source Vault back this up.");
  assert.equal(vault.scrubbed, 1);
  assert.equal(vault.text, "Documents in the source record back this up.");

  const clean = scrubInternalVocabFromText("A packet of evidence emerged; investigators vaulted into action.", {
    packetGrounded: true,
  });
  assert.equal(clean.scrubbed, 0);
  assert.equal(clean.text, "A packet of evidence emerged; investigators vaulted into action.");
});

test("scrubInternalVocabulary scrubs only string-content blocks", () => {
  const body: ArticleBlock[] = [
    { type: "paragraph", content: "The evidence packet documents each strike." },
    { type: "heading", content: "Clean heading" },
    { type: "relatedArticle", articleId: "abc" } as unknown as ArticleBlock,
  ];
  const { body: cleaned, scrubbed } = scrubInternalVocabulary(body, { packetGrounded: true });
  assert.equal(scrubbed, 1);
  assert.equal((cleaned[0] as { content: string }).content, "The available evidence documents each strike.");
  assert.equal(cleaned[1], body[1]);
  assert.equal(cleaned[2], body[2]);
});

test("stripCiteTagsFromText unwraps <cite> tags, keeps the text", () => {
  const input =
    'On Saturday, <cite index="29-2">Israeli strikes killed at least 16 people.</cite> That was the salvo. It followed <cite index="30-1">airstrikes the day before.</cite>';
  const { text, stripped } = stripCiteTagsFromText(input);
  assert.equal(stripped, 4);
  assert.equal(
    text,
    "On Saturday, Israeli strikes killed at least 16 people. That was the salvo. It followed airstrikes the day before.",
  );
  assert.ok(!text.includes("<cite"));
  assert.ok(!text.includes("</cite>"));
});

test("stripCiteTagsFromText leaves clean text untouched (no allocation churn)", () => {
  const input = "Plain prose with a [real link](https://doi.org/10.1/x) and no tags.";
  const { text, stripped } = stripCiteTagsFromText(input);
  assert.equal(stripped, 0);
  assert.equal(text, input);
});

test("stripCitationTags scrubs only string-content blocks", () => {
  const body: ArticleBlock[] = [
    { type: "paragraph", content: 'A <cite index="1-1">cited claim</cite> here.' },
    { type: "heading", content: "Clean heading" },
    { type: "relatedArticle", articleId: "abc" } as unknown as ArticleBlock,
  ];
  const { body: cleaned, stripped } = stripCitationTags(body);
  assert.equal(stripped, 2);
  assert.equal((cleaned[0] as { content: string }).content, "A cited claim here.");
  assert.equal(cleaned[1], body[1]); // unchanged block returned by reference
  assert.equal(cleaned[2], body[2]); // non-string block passed through
});

test("isSearchQueryUrl flags Scholar / search-engine results pages", () => {
  for (const u of [
    "https://scholar.google.com/scholar?q=2019+loneliness",
    "https://scholar.google.de/scholar?q=x",
    "https://www.google.com/search?q=foo+bar",
    "https://www.bing.com/search?q=foo",
    "https://duckduckgo.com/?q=foo",
    "https://search.brave.com/search?q=foo",
  ]) {
    assert.equal(isSearchQueryUrl(u), true, `expected search-query: ${u}`);
  }
});

test("isSearchQueryUrl keeps specific-source URLs", () => {
  for (const u of [
    "https://doi.org/10.1038/s41586-020-2649-2",
    "https://www.nature.com/articles/s41586-020-2649-2",
    "https://arxiv.org/abs/2103.00001",
    "https://www.nih.gov/news-events/some-report",
    "https://news.google.com/articles/abc", // google news article, not a search
    "https://maps.google.com/", // not a search results page
    "not-a-url",
  ]) {
    assert.equal(isSearchQueryUrl(u), false, `expected NOT search-query: ${u}`);
  }
});

test("isPrivateOrReservedIp blocks SSRF targets, allows public IPs", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.5",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
  ]) {
    assert.equal(isPrivateOrReservedIp(ip), true, `expected blocked: ${ip}`);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateOrReservedIp(ip), false, `expected allowed: ${ip}`);
  }
});

test("sanitizeCitations strips search-query links but keeps the phrase + prose", async () => {
  const body: ArticleBlock[] = [
    {
      type: "paragraph",
      content:
        "A [2019 loneliness study](https://scholar.google.com/scholar?q=2019+loneliness) found this.",
    },
    { type: "heading", content: "A heading is untouched" },
    {
      type: "paragraph",
      content: "See our [other piece](/article/some-slug) for more — internal links survive.",
    },
  ];
  const { body: out, strippedSearch } = await sanitizeCitations(body);
  assert.equal(strippedSearch, 1);
  assert.equal((out[0]! as { content: string }).content, "A 2019 loneliness study found this.");
  assert.equal((out[1]! as { content: string }).content, "A heading is untouched");
  // Internal /article/ links are not external citations, so they're untouched.
  assert.equal(
    (out[2]! as { content: string }).content,
    "See our [other piece](/article/some-slug) for more — internal links survive.",
  );
});

test("sanitizeCitations unlinks confidently-dead URLs and keeps live ones", async () => {
  const realFetch = globalThis.fetch;
  // Stub fetch so the reachability check is deterministic and offline. The DNS
  // pre-resolution still runs against a real public host (example.com).
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const status = url.includes("/dead") ? 404 : 200;
    return new Response("", { status });
  }) as typeof fetch;
  try {
    const body: ArticleBlock[] = [
      {
        type: "paragraph",
        content:
          "Live [here](https://example.com/live) and dead [there](https://example.com/dead).",
      },
    ];
    const { body: out, strippedDead } = await sanitizeCitations(body);
    assert.equal(strippedDead, 1);
    assert.equal(
      (out[0]! as { content: string }).content,
      "Live [here](https://example.com/live) and dead there.",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("sanitizeCitations strips internal/private-target links without fetching them", async () => {
  const realFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = (async () => {
    fetched = true;
    return new Response("", { status: 200 });
  }) as typeof fetch;
  try {
    const body: ArticleBlock[] = [
      {
        type: "paragraph",
        content:
          "Bad [localhost](http://localhost:3000/x), bad [internal](https://api.internal/y), bad [ip](http://10.0.0.1/z).",
      },
    ];
    const { body: out, strippedDead } = await sanitizeCitations(body);
    assert.equal(strippedDead, 3);
    assert.equal((out[0]! as { content: string }).content, "Bad localhost, bad internal, bad ip.");
    // Internal/private targets must be unlinked WITHOUT ever being fetched (SSRF).
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

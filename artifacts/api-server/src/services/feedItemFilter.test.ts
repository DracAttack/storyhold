import { test } from "node:test";
import assert from "node:assert/strict";
import { feedItemPassesFilter } from "./feedItemFilter";

const item = (title: string | null, summary: string | null = null) => ({ title, summary });

test("empty include + empty exclude → allow all", () => {
  assert.equal(feedItemPassesFilter(item("Anything"), {}), true);
  assert.equal(
    feedItemPassesFilter(item("Anything"), { includeTerms: [], excludeTerms: [] }),
    true,
  );
});

test("include: matches when any term is a case-insensitive substring of title", () => {
  assert.equal(
    feedItemPassesFilter(item("Advances in Artificial Intelligence"), {
      includeTerms: ["artificial intelligence", "climate"],
    }),
    true,
  );
});

test("include: dropped when no term matches", () => {
  assert.equal(
    feedItemPassesFilter(item("Notice of committee meeting"), {
      includeTerms: ["artificial intelligence"],
    }),
    false,
  );
});

test("include: matches against the summary too", () => {
  assert.equal(
    feedItemPassesFilter(item("Untitled report", "A study of PFAS contamination"), {
      includeTerms: ["pfas"],
    }),
    true,
  );
});

test("exclude wins over include", () => {
  assert.equal(
    feedItemPassesFilter(item("Artificial intelligence — correction"), {
      includeTerms: ["artificial intelligence"],
      excludeTerms: ["correction"],
    }),
    false,
  );
});

test("exclude only: drops matches, keeps the rest", () => {
  assert.equal(
    feedItemPassesFilter(item("Notice of meeting"), { excludeTerms: ["notice of meeting"] }),
    false,
  );
  assert.equal(
    feedItemPassesFilter(item("Real report"), { excludeTerms: ["notice of meeting"] }),
    true,
  );
});

test("null title + null summary: allowed with empty include, dropped with include", () => {
  assert.equal(feedItemPassesFilter(item(null, null), {}), true);
  assert.equal(feedItemPassesFilter(item(null, null), { includeTerms: ["ai"] }), false);
});

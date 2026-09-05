import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  db,
  authorsTable,
  trendSignalsTable,
  topicIdeasTable,
  type Author,
  type TrendSignal,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  NoSuitableAuthorError,
  classifyTrendScoutError,
  classifyTrendScoutResponse,
  type TrendScoutOutcome,
} from "./llm";
import {
  resolveSignalAuthor,
  consumeTrendSignalIntoIdea,
  scoutTrendsForBeat,
  TrendSignalError,
} from "./trends";

// Regression tests for Trend Radar author assignment. These guard the bug we
// fixed where a signal scouted for one writer could be handed to a writer on a
// different beat (a microbiology hook landing on the climate desk).
//
// The author-assignment logic is exercised directly against the dev database
// (DATABASE_URL) — the same integration-test style as beats.test.ts — but the
// LLM best-fit picker and the background draft launcher are INJECTED so the
// tests are deterministic and never make a network/model call.
//
// "Draft now"  → consumeTrendSignalIntoIdea({ draft: true })  → resolveSignalAuthor lenient:false (strict)
// "Send to ideas" → consumeTrendSignalIntoIdea({ draft: false }) → resolveSignalAuthor lenient:true (always lands a writer)

// A beat slug no real/seeded author covers, so the "covering" pool is exactly
// the authors this test inserts.
const BEAT = "zz-trend-test-beat";
const OTHER_BEAT = "zz-trend-test-other-beat";
const TEST_SLUGS = [
  "zz-trend-covering-a",
  "zz-trend-covering-b",
  "zz-trend-offbeat",
  "zz-trend-inactive",
];

let covering: Author;
let coveringB: Author;
let offBeat: Author;
let inactive: Author;
const createdSignalIds: string[] = [];
const createdAuthorIds: string[] = [];

function authorRow(slug: string, categorySlug: string, overrides: Partial<Author> = {}) {
  return {
    slug,
    name: slug,
    bio: "Test author bio.",
    avatarUrl: "https://example.com/a.png",
    category: categorySlug,
    categorySlug,
    voicePrompt: "Test voice.",
    active: true,
    ...overrides,
  };
}

async function insertSignal(overrides: Partial<TrendSignal> = {}): Promise<TrendSignal> {
  const [row] = await db
    .insert(trendSignalsTable)
    .values({
      beatSlug: BEAT,
      beat: "ZZ Trend Test Beat",
      source: "Test Source",
      sourceUrl: "https://example.com/source",
      event: "A real-world event.",
      headline: "A fresh test headline",
      angle: "A test angle.",
      status: "new",
      ...overrides,
    })
    .returning();
  createdSignalIds.push(row!.id);
  return row!;
}

// A picker that fails the test if it's ever consulted (used to prove the scout's
// covering suggestion is honored without re-rolling).
const failIfCalled: typeof import("./llm").pickBestAuthorForIdea = async () => {
  throw new Error("picker should NOT be called when the suggestion already covers the beat");
};

// A picker that always reports "no clear best fit" (the off-beat / no-fit case).
const pickerNoFit: typeof import("./llm").pickBestAuthorForIdea = async () => {
  throw new NoSuitableAuthorError("No active writer covers this subject.", []);
};

before(async () => {
  await db.delete(authorsTable).where(inArray(authorsTable.slug, TEST_SLUGS));
  const rows = await db
    .insert(authorsTable)
    .values([
      authorRow(TEST_SLUGS[0]!, BEAT),
      authorRow(TEST_SLUGS[1]!, BEAT),
      authorRow(TEST_SLUGS[2]!, OTHER_BEAT),
      authorRow(TEST_SLUGS[3]!, BEAT, { active: false }),
    ])
    .returning();
  const bySlug = new Map(rows.map((r) => [r.slug, r as Author]));
  covering = bySlug.get(TEST_SLUGS[0]!)!;
  coveringB = bySlug.get(TEST_SLUGS[1]!)!;
  offBeat = bySlug.get(TEST_SLUGS[2]!)!;
  inactive = bySlug.get(TEST_SLUGS[3]!)!;
  createdAuthorIds.push(covering.id, coveringB.id, offBeat.id, inactive.id);
});

after(async () => {
  if (createdSignalIds.length > 0) {
    await db.delete(trendSignalsTable).where(inArray(trendSignalsTable.id, createdSignalIds));
  }
  if (createdAuthorIds.length > 0) {
    await db.delete(topicIdeasTable).where(inArray(topicIdeasTable.authorId, createdAuthorIds));
  }
  await db.delete(authorsTable).where(inArray(authorsTable.slug, TEST_SLUGS));
});

// --- A valid, covering suggestion is honored exactly on BOTH paths ---------

test("Draft now: a covering suggested writer is assigned exactly, never re-picked", async () => {
  const signal = await insertSignal({
    suggestedAuthorId: covering.id,
    suggestedAuthorName: covering.name,
  });
  const { author } = await resolveSignalAuthor(signal, { lenient: false, pickAuthor: failIfCalled });
  assert.equal(author.id, covering.id, "must assign the exact suggested covering writer");
});

test("Send to ideas: a covering suggested writer is assigned exactly, never re-picked", async () => {
  const signal = await insertSignal({
    suggestedAuthorId: covering.id,
    suggestedAuthorName: covering.name,
  });
  const { author } = await resolveSignalAuthor(signal, { lenient: true, pickAuthor: failIfCalled });
  assert.equal(author.id, covering.id, "must assign the exact suggested covering writer");
});

// --- Fallback when there is no usable suggestion ---------------------------

test("Send to ideas (lenient): off-beat suggestion + no fit still lands a covering writer", async () => {
  const signal = await insertSignal({
    suggestedAuthorId: offBeat.id,
    suggestedAuthorName: offBeat.name,
  });
  const { author } = await resolveSignalAuthor(signal, { lenient: true, pickAuthor: pickerNoFit });
  assert.notEqual(author.id, offBeat.id, "must NOT assign the off-beat suggested writer");
  assert.ok(
    [covering.id, coveringB.id].includes(author.id),
    "must fall back to a writer who covers the beat",
  );
});

test("Draft now (strict): off-beat suggestion + no fit refuses rather than assigning the wrong desk", async () => {
  const signal = await insertSignal({
    suggestedAuthorId: offBeat.id,
    suggestedAuthorName: offBeat.name,
  });
  await assert.rejects(
    () => resolveSignalAuthor(signal, { lenient: false, pickAuthor: pickerNoFit }),
    (err: unknown) => err instanceof TrendSignalError,
    "strict path must throw instead of force-fitting an author",
  );
});

test("An inactive suggested writer is ignored and a covering active writer is used instead", async () => {
  const signal = await insertSignal({
    suggestedAuthorId: inactive.id,
    suggestedAuthorName: inactive.name,
  });
  // Picker returns no fit, so the lenient fallback should land an ACTIVE
  // covering writer — never the inactive suggestion.
  const { author } = await resolveSignalAuthor(signal, { lenient: true, pickAuthor: pickerNoFit });
  assert.notEqual(author.id, inactive.id, "must NOT assign the inactive suggested writer");
  assert.ok(
    [covering.id, coveringB.id].includes(author.id),
    "must fall back to an active covering writer",
  );
});

// --- End-to-end wiring: the action → lenient mapping in consumeTrendSignalIntoIdea ---

test("consume(draft:true): covering suggestion drafts for the exact writer and launches that author's draft", async () => {
  const signal = await insertSignal({
    suggestedAuthorId: covering.id,
    suggestedAuthorName: covering.name,
  });
  let launchedAuthorId: string | null = null;
  const launchDraft: typeof import("./articles").startDraftArticleFromIdea = async (
    authorId,
    ideaId,
    opts,
  ) => {
    launchedAuthorId = authorId;
    assert.equal(opts?.force, true, "trend drafts force past dedupe");
    const [idea] = await db.select().from(topicIdeasTable).where(eq(topicIdeasTable.id, ideaId)).limit(1);
    return idea!;
  };

  await consumeTrendSignalIntoIdea(signal.id, {
    draft: true,
    pickAuthor: failIfCalled,
    launchDraft,
  });

  assert.equal(launchedAuthorId, covering.id, "the draft must launch for the exact suggested writer");
  const ideas = await db.select().from(topicIdeasTable).where(eq(topicIdeasTable.authorId, covering.id));
  assert.equal(ideas.length, 1, "exactly one idea should be created");
  assert.equal(ideas[0]!.categorySlug, BEAT, "the idea must stay on the signal's beat");
});

test("consume(draft:true): off-beat + no fit refuses, never claims the signal or launches a draft", async () => {
  const signal = await insertSignal({
    suggestedAuthorId: offBeat.id,
    suggestedAuthorName: offBeat.name,
  });
  let launched = false;
  const launchDraft: typeof import("./articles").startDraftArticleFromIdea = async () => {
    launched = true;
    return undefined as never;
  };

  await assert.rejects(
    () =>
      consumeTrendSignalIntoIdea(signal.id, {
        draft: true,
        pickAuthor: pickerNoFit,
        launchDraft,
      }),
    (err: unknown) => err instanceof TrendSignalError,
  );

  assert.equal(launched, false, "no draft should be launched when the strict path refuses");
  const [row] = await db.select().from(trendSignalsTable).where(eq(trendSignalsTable.id, signal.id)).limit(1);
  assert.equal(row!.status, "new", "the signal must remain unclaimed for the editor to reassign");
});

// --- Fail-closed trend scanning -------------------------------------------
// The scout must NEVER fall back to the model's parametric memory when live web
// search fails/unavailable, or answers without actually searching. These prove
// (a) the pure classifiers make the right call and (b) a zero-signal outcome
// never inserts fabricated trend signals into the queue.

test("classifyTrendScoutError: tool-related errors → tool_unavailable, everything else → search_failed", () => {
  assert.equal(
    classifyTrendScoutError(new Error("web_search tool is not supported for this model")).outcome,
    "tool_unavailable",
  );
  assert.equal(classifyTrendScoutError(new Error("connection reset by peer")).outcome, "search_failed");
  assert.equal(classifyTrendScoutError("500 internal error").outcome, "search_failed");
});

test("classifyTrendScoutResponse: an answer with NO web search invocation is refused (no memory fallback)", () => {
  // A perfectly well-formed hook array — but the model never called web_search,
  // so it is memory output we cannot verify as fresh. Must yield zero signals.
  const message = {
    content: [
      {
        type: "text",
        text: JSON.stringify([
          { source: "Memory", sourceUrl: "https://example.com/x", headline: "A plausible but unverified hook" },
        ]),
      },
    ],
  };
  const result = classifyTrendScoutResponse(message as never);
  assert.equal(result.outcome, "skipped_fail_closed");
  assert.equal(result.signals.length, 0, "memory-only output must produce zero signals");
});

test("classifyTrendScoutResponse: a real search with valid hooks → search_success", () => {
  const message = {
    content: [
      { type: "server_tool_use", id: "1", name: "web_search", input: {} },
      {
        type: "text",
        text: JSON.stringify([
          {
            source: "Nature",
            sourceUrl: "https://nature.com/articles/x",
            event: "A discovery",
            headline: "A genuinely fresh hook",
            angle: "The surprising angle",
            urgency: 80,
            risk: 20,
            riskReason: "low",
            suggestedAuthor: "",
          },
        ]),
      },
    ],
  };
  const result = classifyTrendScoutResponse(message as never);
  assert.equal(result.outcome, "search_success");
  assert.equal(result.signals.length, 1);
});

test("classifyTrendScoutResponse: a real search that finds nothing → search_empty", () => {
  const message = {
    content: [
      { type: "server_tool_use", id: "1", name: "web_search", input: {} },
      { type: "text", text: "[]" },
    ],
  };
  const result = classifyTrendScoutResponse(message as never);
  assert.equal(result.outcome, "search_empty");
  assert.equal(result.signals.length, 0);
});

test("scoutTrendsForBeat: every zero-signal outcome inserts nothing and reports the reason", async () => {
  const zeroOutcomes: TrendScoutOutcome[] = [
    "search_failed",
    "tool_unavailable",
    "search_empty",
    "skipped_fail_closed",
  ];
  for (const outcome of zeroOutcomes) {
    const scout: typeof import("./llm").scoutTrendSignalsForBeat = async () => ({
      outcome,
      signals: [],
      detail: "injected",
    });
    const result = await scoutTrendsForBeat(
      { slug: BEAT, name: "ZZ Trend Test Beat" },
      {
        activeAuthors: [covering, coveringB],
        coveringAuthors: [covering, coveringB],
        slugToName: new Map(),
        scout,
      },
    );
    assert.equal(result.outcome, outcome, `outcome must propagate (${outcome})`);
    assert.equal(result.inserted.length, 0, `a ${outcome} scan must never fabricate signals`);
    assert.equal(result.detail, "injected", "the reason must be surfaced to the caller");
  }
});

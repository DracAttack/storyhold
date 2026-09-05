import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import type Anthropic from "@anthropic-ai/sdk";
import type { Author } from "@workspace/db";
import {
  buildAuthorSystemPrompt,
  generateIdeasForBeat,
  generateIdeasForAuthor,
  generateCrossoverIdeasForAuthor,
} from "./llm";

// ---------------------------------------------------------------------------
// Smoke tests: construction-context block reaches the prompt end-to-end
//
// These tests guard against a template refactor silently dropping the
// `constructionCtx` block from the user message that is sent to the model.
// They stub `anthropic.messages.create` so no real network call is made; all
// DB helpers (isAiFunctionEnabled, resolveDirective, resolveModel) run against
// the dev DB exactly as they do in production.
//
// Each test captures the user-message string passed to the stub and asserts:
//   - recentCategoryTitles non-empty  → "construction context" marker present
//   - recentCategoryTitles empty/absent → marker absent (no noise added)
// ---------------------------------------------------------------------------

const CONSTRUCTION_CONTEXT_MARKER = "construction context";

type CreateParams = Parameters<typeof anthropic.messages.create>[0];
let capturedUserPrompt = "";
let originalCreate: typeof anthropic.messages.create;

function makeStubCreate(jsonResponse: object) {
  const responseText = JSON.stringify(jsonResponse);
  return async (params: CreateParams): Promise<Anthropic.Messages.Message> => {
    const messages = (params as { messages: Array<{ role: string; content: unknown }> }).messages;
    const userMsg = messages.find((m) => m.role === "user");
    capturedUserPrompt = typeof userMsg?.content === "string" ? userMsg.content : "";
    return {
      id: "test-msg-stub",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: responseText }],
      model: "claude-stub",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    } as unknown as Anthropic.Messages.Message;
  };
}

const BEAT = {
  name: "Cognitive Science",
  categorySlug: "cognitive-science",
  description: null,
  slant: null,
};

const AUTHOR: Author = {
  id: "00000000-0000-0000-0000-000000000001",
  slug: "test-idea-author",
  name: "Test Author",
  bio: "A test author covering cognitive science.",
  avatarUrl: "https://example.com/avatar.jpg",
  category: "Cognitive Science",
  categorySlug: "cognitive-science",
  voicePrompt: "Write with scientific precision.",
  sampleParagraphs: [],
  wordCountTarget: 2200,
  cadence: "weekly",
  weekday: null,
  secondWeekday: null,
  dayOfMonth: null,
  randomizeSchedule: true,
  bannedTopics: [],
  subBeats: ["neuroscience"],
  active: true,
  model: "claude-haiku-4-5",
  temperature: "1.00",
  maxTokens: 4096,
  economicAxis: "0.0",
  socialAxis: "0.0",
  runHourUtc: 14,
  tone: null,
  sentenceRhythm: null,
  vocabularyQuirks: null,
  signatureMove: null,
  corePromise: null,
  avoid: null,
  technicalExplanationStyle: null,
  createdAt: new Date("2025-01-01T00:00:00Z"),
  updatedAt: new Date("2025-01-01T00:00:00Z"),
};

const ALLOWED_BEATS_WITH_SUB = [
  { category: "Cognitive Science", categorySlug: "cognitive-science", slant: null },
  { category: "Neuroscience", categorySlug: "neuroscience", slant: null },
];

const RECENT_TITLES = [
  "Why Your Brain Lies to You About Risk",
  "The Hidden Cost of Multitasking",
  "Memory Is Not a Tape Recorder",
];

test("author prompt always includes shared technical re-voicing rules", () => {
  const prompt = buildAuthorSystemPrompt(AUTHOR);
  assert.match(prompt, /TECHNICAL RE-VOICING/);
  assert.match(prompt, /Your voice does not clock out when the article becomes technical/);
  assert.match(prompt, /A citation supports your explanation; it does not replace one/);
});

test("author prompt includes the author's custom technical explanation style when present", () => {
  const custom = "Start with the bodily consequence, then trace the mechanism backward.";
  const prompt = buildAuthorSystemPrompt({ ...AUTHOR, technicalExplanationStyle: custom });
  assert.match(prompt, /Your particular instinct for explaining technical material/);
  assert.ok(prompt.includes(custom));
});

before(() => {
  originalCreate = anthropic.messages.create.bind(anthropic);
});

after(() => {
  (anthropic.messages as unknown as Record<string, unknown>)["create"] = originalCreate;
});

// ---------------------------------------------------------------------------
// generateIdeasForBeat
// ---------------------------------------------------------------------------

test("generateIdeasForBeat: construction-context block appears when recentCategoryTitles is non-empty", async () => {
  (anthropic.messages as unknown as Record<string, unknown>)["create"] = makeStubCreate([
    { title: "A Fresh Angle", angle: "The science behind it" },
  ]);

  await generateIdeasForBeat(BEAT, { recentCategoryTitles: RECENT_TITLES });

  assert.ok(
    capturedUserPrompt.includes(CONSTRUCTION_CONTEXT_MARKER),
    `Expected user prompt to contain "${CONSTRUCTION_CONTEXT_MARKER}" but got:\n${capturedUserPrompt}`,
  );
  assert.ok(
    capturedUserPrompt.includes(RECENT_TITLES[0]!),
    `Expected first recent title to appear in prompt but got:\n${capturedUserPrompt}`,
  );
});

test("generateIdeasForBeat: construction-context block is absent when recentCategoryTitles is empty", async () => {
  (anthropic.messages as unknown as Record<string, unknown>)["create"] = makeStubCreate([
    { title: "A Fresh Angle", angle: "The science behind it" },
  ]);

  await generateIdeasForBeat(BEAT, { recentCategoryTitles: [] });

  assert.ok(
    !capturedUserPrompt.includes(CONSTRUCTION_CONTEXT_MARKER),
    `Expected user prompt NOT to contain "${CONSTRUCTION_CONTEXT_MARKER}" when titles are empty but got:\n${capturedUserPrompt}`,
  );
});

test("generateIdeasForBeat: construction-context block is absent when recentCategoryTitles is omitted", async () => {
  (anthropic.messages as unknown as Record<string, unknown>)["create"] = makeStubCreate([
    { title: "A Fresh Angle", angle: "The science behind it" },
  ]);

  await generateIdeasForBeat(BEAT, {});

  assert.ok(
    !capturedUserPrompt.includes(CONSTRUCTION_CONTEXT_MARKER),
    `Expected user prompt NOT to contain "${CONSTRUCTION_CONTEXT_MARKER}" when titles are omitted but got:\n${capturedUserPrompt}`,
  );
});

// ---------------------------------------------------------------------------
// generateIdeasForAuthor
// ---------------------------------------------------------------------------

test("generateIdeasForAuthor: construction-context block appears when recentCategoryTitles is non-empty", async () => {
  (anthropic.messages as unknown as Record<string, unknown>)["create"] = makeStubCreate([
    { title: "A Fresh Angle", angle: "The science behind it", categorySlug: "cognitive-science" },
  ]);

  await generateIdeasForAuthor(AUTHOR, { recentCategoryTitles: RECENT_TITLES });

  assert.ok(
    capturedUserPrompt.includes(CONSTRUCTION_CONTEXT_MARKER),
    `Expected user prompt to contain "${CONSTRUCTION_CONTEXT_MARKER}" but got:\n${capturedUserPrompt}`,
  );
  assert.ok(
    capturedUserPrompt.includes(RECENT_TITLES[1]!),
    `Expected second recent title to appear in prompt but got:\n${capturedUserPrompt}`,
  );
});

test("generateIdeasForAuthor: construction-context block is absent when recentCategoryTitles is empty", async () => {
  (anthropic.messages as unknown as Record<string, unknown>)["create"] = makeStubCreate([
    { title: "A Fresh Angle", angle: "The science behind it", categorySlug: "cognitive-science" },
  ]);

  await generateIdeasForAuthor(AUTHOR, { recentCategoryTitles: [] });

  assert.ok(
    !capturedUserPrompt.includes(CONSTRUCTION_CONTEXT_MARKER),
    `Expected user prompt NOT to contain "${CONSTRUCTION_CONTEXT_MARKER}" when titles are empty but got:\n${capturedUserPrompt}`,
  );
});

// ---------------------------------------------------------------------------
// generateCrossoverIdeasForAuthor
// ---------------------------------------------------------------------------

test("generateCrossoverIdeasForAuthor: construction-context block appears when recentCategoryTitles is non-empty", async () => {
  (anthropic.messages as unknown as Record<string, unknown>)["create"] = makeStubCreate([
    { title: "A Crossover Angle", angle: "Bridging both fields", secondaryBeat: "neuroscience" },
  ]);

  await generateCrossoverIdeasForAuthor(AUTHOR, {
    recentCategoryTitles: RECENT_TITLES,
    allowedBeats: ALLOWED_BEATS_WITH_SUB,
  });

  assert.ok(
    capturedUserPrompt.includes(CONSTRUCTION_CONTEXT_MARKER),
    `Expected user prompt to contain "${CONSTRUCTION_CONTEXT_MARKER}" but got:\n${capturedUserPrompt}`,
  );
  assert.ok(
    capturedUserPrompt.includes(RECENT_TITLES[2]!),
    `Expected third recent title to appear in prompt but got:\n${capturedUserPrompt}`,
  );
});

test("generateCrossoverIdeasForAuthor: construction-context block is absent when recentCategoryTitles is empty", async () => {
  (anthropic.messages as unknown as Record<string, unknown>)["create"] = makeStubCreate([
    { title: "A Crossover Angle", angle: "Bridging both fields", secondaryBeat: "neuroscience" },
  ]);

  await generateCrossoverIdeasForAuthor(AUTHOR, {
    recentCategoryTitles: [],
    allowedBeats: ALLOWED_BEATS_WITH_SUB,
  });

  assert.ok(
    !capturedUserPrompt.includes(CONSTRUCTION_CONTEXT_MARKER),
    `Expected user prompt NOT to contain "${CONSTRUCTION_CONTEXT_MARKER}" when titles are empty but got:\n${capturedUserPrompt}`,
  );
});

// ---------------------------------------------------------------------------
// Slice-cap tests: only the first 15 titles reach the prompt
// ---------------------------------------------------------------------------

const TWENTY_TITLES = Array.from({ length: 20 }, (_, i) => `Unique Title Number ${i + 1} For Slice Test`);
const FIRST_15 = TWENTY_TITLES.slice(0, 15);
const LAST_5 = TWENTY_TITLES.slice(15);

test("generateIdeasForBeat: slice cap — only first 15 of 20 titles appear in prompt", async () => {
  (anthropic.messages as unknown as Record<string, unknown>)["create"] = makeStubCreate([
    { title: "A Fresh Angle", angle: "The science behind it" },
  ]);

  await generateIdeasForBeat(BEAT, { recentCategoryTitles: TWENTY_TITLES });

  for (const title of FIRST_15) {
    assert.ok(
      capturedUserPrompt.includes(title),
      `Expected title "${title}" (within first 15) to appear in prompt`,
    );
  }
  for (const title of LAST_5) {
    assert.ok(
      !capturedUserPrompt.includes(title),
      `Expected title "${title}" (beyond 15-item cap) NOT to appear in prompt`,
    );
  }
});

test("generateIdeasForAuthor: slice cap — only first 15 of 20 titles appear in prompt", async () => {
  (anthropic.messages as unknown as Record<string, unknown>)["create"] = makeStubCreate([
    { title: "A Fresh Angle", angle: "The science behind it", categorySlug: "cognitive-science" },
  ]);

  await generateIdeasForAuthor(AUTHOR, { recentCategoryTitles: TWENTY_TITLES });

  for (const title of FIRST_15) {
    assert.ok(
      capturedUserPrompt.includes(title),
      `Expected title "${title}" (within first 15) to appear in prompt`,
    );
  }
  for (const title of LAST_5) {
    assert.ok(
      !capturedUserPrompt.includes(title),
      `Expected title "${title}" (beyond 15-item cap) NOT to appear in prompt`,
    );
  }
});

test("generateCrossoverIdeasForAuthor: slice cap — only first 15 of 20 titles appear in prompt", async () => {
  (anthropic.messages as unknown as Record<string, unknown>)["create"] = makeStubCreate([
    { title: "A Crossover Angle", angle: "Bridging both fields", secondaryBeat: "neuroscience" },
  ]);

  await generateCrossoverIdeasForAuthor(AUTHOR, {
    recentCategoryTitles: TWENTY_TITLES,
    allowedBeats: ALLOWED_BEATS_WITH_SUB,
  });

  for (const title of FIRST_15) {
    assert.ok(
      capturedUserPrompt.includes(title),
      `Expected title "${title}" (within first 15) to appear in prompt`,
    );
  }
  for (const title of LAST_5) {
    assert.ok(
      !capturedUserPrompt.includes(title),
      `Expected title "${title}" (beyond 15-item cap) NOT to appear in prompt`,
    );
  }
});

test("generateCrossoverIdeasForAuthor: returns empty array without calling model when author has no sub-beats", async () => {
  let createCalled = false;
  (anthropic.messages as unknown as Record<string, unknown>)["create"] = async () => {
    createCalled = true;
    return {} as unknown as Anthropic.Messages.Message;
  };

  const AUTHOR_NO_SUBS: Author = { ...AUTHOR, subBeats: [] };
  const result = await generateCrossoverIdeasForAuthor(AUTHOR_NO_SUBS, {
    recentCategoryTitles: RECENT_TITLES,
    allowedBeats: [{ category: "Cognitive Science", categorySlug: "cognitive-science", slant: null }],
  });

  assert.equal(result.length, 0, "should return empty array when no sub-beats available");
  assert.equal(createCalled, false, "should not call the model when there are no sub-beats");
});

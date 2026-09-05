import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeSynthesizedChronology,
  parseWorldFindingsFromModel,
  persistedLocalVerificationPacket,
  type AnalysisChunk,
  type ChronologyFinding,
  type EvidenceReference,
} from "./worldAnalysis";

function evidence(
  sourceId: string,
  chunkId: string,
  quote: string,
): EvidenceReference {
  return { sourceId, chunkId, quote };
}

function event(params: {
  sourceId: string;
  chunkId: string;
  chapterKey: string;
  quote: string;
  summary: string;
  actor: string;
  worldTimeLabel: string;
}): ChronologyFinding {
  return {
    name: "The Gate Opens",
    summary: params.summary,
    evidence: [evidence(params.sourceId, params.chunkId, params.quote)],
    aliases: [],
    details: [],
    relationships: [],
    factionMemberships: [],
    confidence: 0.9,
    reviewStatus: "verified",
    worldTimeLabel: params.worldTimeLabel,
    temporalStatus: "relative",
    importance: "major",
    sourceChapterKeys: [params.chapterKey],
    actors: [params.actor],
    targets: [],
    witnesses: [],
    locations: ["The Gate"],
  };
}

test("same-named events in different books remain separate occurrences", () => {
  const first = event({
    sourceId: "book-one",
    chunkId: "book-one-chunk",
    chapterKey: "book-one:chapter-4",
    quote: "Mara opened the western gate before sunrise.",
    summary: "Mara opens the western gate before sunrise.",
    actor: "Mara",
    worldTimeLabel: "Before sunrise",
  });
  const second = event({
    sourceId: "book-two",
    chunkId: "book-two-chunk",
    chapterKey: "book-two:chapter-19",
    quote: "Dara opened the eastern gate after the siege.",
    summary: "Dara opens the eastern gate after the siege.",
    actor: "Dara",
    worldTimeLabel: "After the siege",
  });

  const merged = mergeSynthesizedChronology([first], [second]);

  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((item) => item.actors), [["Dara"], ["Mara"]]);
  assert.deepEqual(merged.map((item) => item.sourceChapterKeys), [
    ["book-two:chapter-19"],
    ["book-one:chapter-4"],
  ]);
  assert.deepEqual(merged.map((item) => item.worldTimeLabel), [
    "After the siege",
    "Before sunrise",
  ]);
});

test("an exact shared citation lets duplicate extractions merge once", () => {
  const original = event({
    sourceId: "book-one",
    chunkId: "shared-chunk",
    chapterKey: "book-one:chapter-4",
    quote: "Mara opened the western gate before sunrise.",
    summary: "Mara opens the gate.",
    actor: "Mara",
    worldTimeLabel: "Before sunrise",
  });
  const duplicate = {
    ...event({
      sourceId: "book-one",
      chunkId: "shared-chunk",
      chapterKey: "book-one:chapter-4",
      quote: "Mara opened the western gate before sunrise.",
      summary: "Opening the western gate exposes the road beyond it.",
      actor: "Mara",
      worldTimeLabel: "Before sunrise",
    }),
    witnesses: ["Dara"],
    importance: "turning_point" as const,
  };

  const merged = mergeSynthesizedChronology([original], [duplicate]);

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]?.evidence, original.evidence);
  assert.deepEqual(merged[0]?.actors, ["Mara"]);
  assert.deepEqual(merged[0]?.witnesses, ["Dara"]);
  assert.equal(merged[0]?.importance, "turning_point");
});

test("an explicitly aliased title on the same exact citation is retained, not duplicated", () => {
  const original = event({
    sourceId: "book-one",
    chunkId: "shared-chunk",
    chapterKey: "book-one:chapter-4",
    quote: "Mara opened the western gate before sunrise.",
    summary: "Mara opens the gate.",
    actor: "Mara",
    worldTimeLabel: "Before sunrise",
  });
  const alternate = {
    ...event({
      sourceId: "book-one",
      chunkId: "shared-chunk",
      chapterKey: "book-one:chapter-4",
      quote: "Mara opened the western gate before sunrise.",
      summary: "Mara opens the western gate before sunrise.",
      actor: "Mara",
      worldTimeLabel: "Before sunrise",
    }),
    name: "Mara Opens the Western Gate",
    aliases: ["The Gate Opens"],
  };

  const merged = mergeSynthesizedChronology([original], [alternate]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.name, "Mara Opens the Western Gate");
  assert.deepEqual(merged[0]?.aliases, ["The Gate Opens"]);
});

test("identical quotation text in different chunks is not guessed to be one occurrence", () => {
  const original = event({
    sourceId: "book-one",
    chunkId: "chunk-before-boundary",
    chapterKey: "book-one:chapter-4",
    quote: "The western gate opened before sunrise.",
    summary: "The western gate opens.",
    actor: "Mara",
    worldTimeLabel: "Before sunrise",
  });
  const possibleOverlap = event({
    sourceId: "book-one",
    chunkId: "chunk-after-boundary",
    chapterKey: "book-one:chapter-4",
    quote: "The western gate opened before sunrise.",
    summary: "The western gate opens.",
    actor: "Mara",
    worldTimeLabel: "Before sunrise",
  });

  const merged = mergeSynthesizedChronology([original], [possibleOverlap]);

  // AnalysisChunk does not yet retain canonical absolute source spans. The
  // quote could be copied overlap or deliberately repeated prose, so the safe
  // immediate behavior is to preserve both for verification instead of
  // silently erasing a potentially distinct event.
  assert.equal(merged.length, 2);
});

test("one chunk may support two distinct same-named occurrences without pooling them", () => {
  const first = event({
    sourceId: "book-one",
    chunkId: "shared-chunk",
    chapterKey: "book-one:chapter-4",
    quote: "Mara opened the western gate before sunrise.",
    summary: "Mara opens the western gate.",
    actor: "Mara",
    worldTimeLabel: "Before sunrise",
  });
  const second = event({
    sourceId: "book-one",
    chunkId: "shared-chunk",
    chapterKey: "book-one:chapter-4",
    quote: "Dara opened the eastern gate after sunset.",
    summary: "Dara opens the eastern gate.",
    actor: "Dara",
    worldTimeLabel: "After sunset",
  });

  const merged = mergeSynthesizedChronology([first], [second]);

  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((item) => item.actors), [["Dara"], ["Mara"]]);
});

test("a label mention cannot pull an evidence-outside event into a paid batch", () => {
  const first: AnalysisChunk = {
    id: "first-chunk",
    sourceId: "book-one",
    sourceTitle: "Book One",
    index: 0,
    content: "Mara calls the old ballad The Gate Falls, but no gate falls in this scene.",
  };
  const second: AnalysisChunk = {
    id: "second-chunk",
    sourceId: "book-one",
    sourceTitle: "Book One",
    index: 1,
    content: "At sunset, the eastern gate falls and the army enters the city.",
  };
  const local = parseWorldFindingsFromModel({
    chronology: [{
      name: "The Gate Falls",
      summary: "The eastern gate falls and permits the army to enter.",
      sourceChapterKeys: ["chapter-2"],
      actors: ["The Army"],
      locations: ["The Eastern Gate"],
      evidence: [{
        chunkId: second.id,
        quote: "the eastern gate falls and the army enters the city",
      }],
    }],
  }, [first, second], "candidate");

  const firstBatch = persistedLocalVerificationPacket(local, [first]);
  const secondBatch = persistedLocalVerificationPacket(local, [second]);

  assert.deepEqual(firstBatch.chronology, []);
  assert.equal(secondBatch.chronology.length, 1);
  assert.ok(secondBatch.chronology[0]?.evidence.every((item) => item.chunkId === second.id));
});

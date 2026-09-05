import assert from "node:assert/strict";
import test from "node:test";
import { chunkText } from "./sourceChunk";

test("chunks never cross detected chapter boundaries and carry structural metadata", () => {
  const first = Array.from({ length: 40 }, (_, index) => `Alec searches room ${index}.`).join(" ");
  const second = Array.from({ length: 40 }, (_, index) => `Echo maps tunnel ${index}.`).join(" ");
  const chunks = chunkText(`Chapter One - Arrival\n\n${first}\n\nChapter II: Below\n\n${second}`);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => !(chunk.content.includes("Alec searches") && chunk.content.includes("Echo maps"))));
  assert.ok(chunks.some((chunk) => chunk.metadata.sectionTitle?.includes("Chapter One")));
  assert.ok(chunks.some((chunk) => chunk.metadata.sectionTitle?.includes("Chapter II")));
});

test("long prose is split on sentence boundaries", () => {
  const sentences = Array.from(
    { length: 120 },
    (_, index) => `Sentence ${index} preserves its complete ending.`,
  );
  const chunks = chunkText(sentences.join(" "));
  assert.ok(chunks.length > 2);
  for (const chunk of chunks) {
    assert.ok(chunk.content.length <= 1800);
    assert.match(chunk.content, /\.$/u);
    assert.ok(chunk.metadata.sourceStartOffset >= 0);
    assert.ok(chunk.metadata.sourceEndOffset > chunk.metadata.sourceStartOffset);
  }
});

test("overlap stays within one section and uses complete sentences", () => {
  const prose = Array.from(
    { length: 100 },
    (_, index) => `Mara records observation number ${index} before moving on.`,
  ).join(" ");
  const chunks = chunkText(`Interlude: Field Notes\n\n${prose}`);
  const overlapped = chunks.filter((chunk) => chunk.metadata.overlapCharCount > 0);
  assert.ok(overlapped.length > 0);
  assert.ok(overlapped.every((chunk) => chunk.content.slice(0, chunk.metadata.overlapCharCount).endsWith(".")));
});

test("empty input returns no chunks and hashes are deterministic", () => {
  assert.deepEqual(chunkText(" \n "), []);
  assert.equal(chunkText("One complete sentence.")[0]?.contentHash, chunkText("One complete sentence.")[0]?.contentHash);
});

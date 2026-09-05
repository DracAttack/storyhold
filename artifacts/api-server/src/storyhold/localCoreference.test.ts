import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCoreferenceDocuments,
  coreferenceSpanIsPronoun,
  extractLocalCoreference,
} from "./localCoreference";

test("coreference documents carry only the preceding passage into the current passage", () => {
  const documents = buildCoreferenceDocuments([
    { id: "a2", sourceId: "book-a", sourceTitle: "A", index: 2, content: "She raised the pistol." },
    { id: "b1", sourceId: "book-b", sourceTitle: "B", index: 1, content: "It opened." },
    { id: "a1", sourceId: "book-a", sourceTitle: "A", index: 1, content: "Ragger followed Kendall through the door." },
  ]);
  assert.deepEqual(documents.map((document) => document.id), ["a1", "a2", "b1"]);
  assert.equal(documents[1]?.text, "Ragger followed Kendall through the door.\n\nShe raised the pistol.");
  assert.equal(documents[1]?.currentStart, 43);
  assert.equal(documents[2]?.currentStart, 0);
});

test("coreference indexing accepts pronouns but not descriptive noun phrases", () => {
  assert.equal(coreferenceSpanIsPronoun("She"), true);
  assert.equal(coreferenceSpanIsPronoun("the captain"), false);
  assert.equal(coreferenceSpanIsPronoun("herself."), true);
});

test("coreference extraction fails open when the local specialist is disabled", async () => {
  const previous = process.env.STORYHOLD_LOCAL_COREFERENCE_ENABLED;
  process.env.STORYHOLD_LOCAL_COREFERENCE_ENABLED = "false";
  try {
    const result = await extractLocalCoreference({
      chunks: [{ id: "a", sourceId: "book", sourceTitle: "Book", index: 0, content: "Ragger stopped. He listened." }],
    });
    assert.equal(result.receipt.status, "disabled");
    assert.deepEqual(result.spans, []);
  } finally {
    if (previous === undefined) delete process.env.STORYHOLD_LOCAL_COREFERENCE_ENABLED;
    else process.env.STORYHOLD_LOCAL_COREFERENCE_ENABLED = previous;
  }
});

test("coreference resumes with only documents missing from its durable receipt", async () => {
  const previous = { ...process.env };
  const requestedIds: string[][] = [];
  const server = await import("node:http").then(({ createServer }) => createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (part) => { body += part; });
    request.on("end", () => {
      const payload = JSON.parse(body) as { documents: Array<{ id: string }> };
      requestedIds.push(payload.documents.map((document) => document.id));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        documents: payload.documents.map((document) => ({ id: document.id, clusters: [] })),
      }));
    });
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    process.env.STORYHOLD_LOCAL_COREFERENCE_ENABLED = "true";
    process.env.STORYHOLD_LOCAL_COREFERENCE_URL = `http://127.0.0.1:${address.port}/coreference`;
    const chunks = Array.from({ length: 13 }, (_, index) => ({
      id: `chunk-${index + 1}`,
      sourceId: "book",
      sourceTitle: "Book",
      index,
      content: `Alec entered passage ${index + 1}. He waited.`,
    }));
    const savedIds = chunks.slice(0, 12).map((chunk) => chunk.id);
    const result = await extractLocalCoreference({
      chunks,
      resume: {
        spans: [],
        receipt: {
          status: "partial",
          model: "test-coreference",
          attemptedChunks: chunks.length,
          completedChunkIds: savedIds,
          mentionCount: 0,
          elapsedMilliseconds: 1,
          errors: [],
        },
      },
    });
    assert.deepEqual(requestedIds, [["chunk-13"]]);
    assert.equal(result.receipt.status, "completed");
    assert.equal(result.receipt.completedChunkIds.length, 13);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    process.env = previous;
  }
});

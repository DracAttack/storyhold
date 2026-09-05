import assert from "node:assert/strict";
import test from "node:test";
import { toArticleTitleCase } from "@/lib/utils";

// The spaces and brackets in this filename deliberately exercise literal path
// handling: Node's CLI glob expansion must not reinterpret a discovered file.
test("site runner loads literal test paths and resolves TypeScript aliases", () => {
  const title: string = "a story with ai";
  assert.equal(toArticleTitleCase(title), "A Story with AI");
  assert.equal(process.env.NODE_ENV, "test");
});

import assert from "node:assert/strict";
import test from "node:test";
import { largestAffordablePrefix } from "./creditBatching";

test("credit batching selects the largest affordable saved prefix", () => {
  assert.equal(largestAffordablePrefix(10, 0, (count) => count * 4), 0);
  assert.equal(largestAffordablePrefix(10, 19, (count) => count * 4), 4);
  assert.equal(largestAffordablePrefix(10, 40, (count) => count * 4), 10);
});

test("credit batching handles a fixed per-review overhead", () => {
  assert.equal(largestAffordablePrefix(20, 11, (count) => 10 + count * 2), 0);
  assert.equal(largestAffordablePrefix(20, 20, (count) => 10 + count * 2), 5);
});

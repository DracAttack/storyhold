import assert from "node:assert/strict";
import test from "node:test";
import { offlineSemanticVector } from "./embeddings";

function cosine(left: number[], right: number[]) {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

test("offline semantic vectors are deterministic, normalized, and 384-dimensional", () => {
  const first = offlineSemanticVector("A corporation controls the station.");
  const second = offlineSemanticVector("A corporation controls the station.");
  assert.equal(first.length, 384);
  assert.deepEqual(first, second);
  const magnitude = Math.sqrt(first.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(magnitude - 1) < 0.000_001);
});

test("offline semantic families connect related wording", () => {
  const company = offlineSemanticVector("The corporation concealed its research.");
  const related = offlineSemanticVector("The company kept the experiment secret.");
  const unrelated = offlineSemanticVector("A cheerful village celebrates the harvest.");
  assert.ok(cosine(company, related) > cosine(company, unrelated));
});

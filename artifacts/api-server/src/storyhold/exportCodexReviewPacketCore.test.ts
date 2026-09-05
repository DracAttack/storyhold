import assert from "node:assert/strict";
import test from "node:test";
import {
  bindCodexReviewPacketQueryResults,
  CODEX_REVIEW_PACKET_QUERY_RESULT_KEYS,
  fingerprintedRowSet,
  reviewPacketFingerprint,
  stableReviewPacketJson,
} from "./exportCodexReviewPacketCore";

test("review packet parallel query results retain every named dataset slot", () => {
  const results = CODEX_REVIEW_PACKET_QUERY_RESULT_KEYS.map((key, index) => [{ key, index }]);
  const bound = bindCodexReviewPacketQueryResults(results);

  for (const [index, key] of CODEX_REVIEW_PACKET_QUERY_RESULT_KEYS.entries()) {
    assert.deepEqual(bound[key], [{ key, index }]);
  }
  assert.equal(
    CODEX_REVIEW_PACKET_QUERY_RESULT_KEYS.indexOf("coreferenceMentions"),
    CODEX_REVIEW_PACKET_QUERY_RESULT_KEYS.indexOf("mentions") + 1,
  );
  assert.deepEqual(bound.vaultMemories, [{
    key: "vaultMemories",
    index: CODEX_REVIEW_PACKET_QUERY_RESULT_KEYS.length - 1,
  }]);
  assert.throws(
    () => bindCodexReviewPacketQueryResults(results.slice(0, -1)),
    /query-result drift: expected \d+ datasets, received \d+/iu,
  );
});

test("review packet fingerprints do not depend on object key insertion order", () => {
  const left = { world: { id: "world-1", name: "ASHES" }, count: 2 };
  const right = { count: 2, world: { name: "ASHES", id: "world-1" } };
  assert.equal(stableReviewPacketJson(left), stableReviewPacketJson(right));
  assert.equal(reviewPacketFingerprint(left), reviewPacketFingerprint(right));
});

test("review packet fingerprints retain meaningful row order and content", () => {
  const first = [{ id: "chunk-1", content: "alpha" }, { id: "chunk-2", content: "beta" }];
  const changed = [{ id: "chunk-1", content: "alpha" }, { id: "chunk-2", content: "changed" }];
  const reversed = [...first].reverse();
  assert.notEqual(reviewPacketFingerprint(first), reviewPacketFingerprint(changed));
  assert.notEqual(reviewPacketFingerprint(first), reviewPacketFingerprint(reversed));
  assert.deepEqual(fingerprintedRowSet(first), {
    rowCount: 2,
    fingerprint: reviewPacketFingerprint(first),
  });
});

test("review packet serialization safely normalizes bigint and binary values", () => {
  assert.equal(
    stableReviewPacketJson({ sequence: 12n, bytes: new Uint8Array([1, 2, 3]) }),
    '{"bytes":"AQID","sequence":"12"}',
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createClaimBatchManifest,
  manifestDocumentIds,
  normalizeClaimBatchManifest,
  restoreClaimBatchManifestOrder,
  type ClaimBatchManifestInput,
} from "./claimBatchManifest";

const VERSION = "claims-v1";

function input(
  documentId: string,
  sectionIndex: number,
  contentHash: string,
  chunkIds: string[],
): ClaimBatchManifestInput {
  return {
    document: { id: documentId, contentHash },
    section: { chunkIds },
    sectionIndex,
  };
}

test("restart restores the exact original provider response order", () => {
  const original = [
    input("doc-a", 0, "hash-a", ["chunk-a0"]),
    input("doc-a", 1, "hash-a", ["chunk-a1"]),
    input("doc-b", 0, "hash-b", ["chunk-b0"]),
  ];
  const manifest = createClaimBatchManifest(original, VERSION);
  const rebuiltInDifferentOrder = [original[2]!, original[0]!, original[1]!];

  const restored = restoreClaimBatchManifestOrder(
    manifest,
    rebuiltInDifferentOrder,
    VERSION,
  );
  assert.deepEqual(restored, original);
  assert.deepEqual(manifestDocumentIds(manifest), ["doc-a", "doc-b"]);
});

test("restart refuses a response when source content changed", () => {
  const original = [input("doc-a", 0, "old-hash", ["chunk-a0"])];
  const manifest = createClaimBatchManifest(original, VERSION);
  assert.throws(
    () => restoreClaimBatchManifestOrder(
      manifest,
      [input("doc-a", 0, "new-hash", ["chunk-a0"])],
      VERSION,
    ),
    /Source content changed/,
  );
});

test("restart refuses a response when the supporting chunks changed", () => {
  const original = [input("doc-a", 0, "hash-a", ["chunk-a0"])];
  const manifest = createClaimBatchManifest(original, VERSION);
  assert.throws(
    () => restoreClaimBatchManifestOrder(
      manifest,
      [input("doc-a", 0, "hash-a", ["replacement-chunk"])],
      VERSION,
    ),
    /Source chunks changed/,
  );
});

test("malformed stored progress is rejected instead of partially trusted", () => {
  assert.equal(normalizeClaimBatchManifest([{ documentId: "doc-a" }]), undefined);
  const valid = createClaimBatchManifest(
    [input("doc-a", 0, "hash-a", ["chunk-a0"])],
    VERSION,
  );
  assert.deepEqual(normalizeClaimBatchManifest(valid), valid);
});


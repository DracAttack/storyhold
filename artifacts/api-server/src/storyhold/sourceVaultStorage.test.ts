import assert from "node:assert/strict";
import test from "node:test";
import {
  GcsStoryholdSourceVaultStorage,
  storyholdSourceObjectKey,
  storyholdWorldObjectPrefix,
} from "./sourceVaultStorage";

test("source vault keys use validated UUID namespaces and reject traversal", () => {
  const worldId = "5fd1d7c4-1bb0-4fc4-a36d-b4d4909a6098";
  const sourceId = "a4d1d7c4-1bb0-4fc4-a36d-b4d4909a6098";
  assert.equal(
    storyholdSourceObjectKey(worldId, sourceId, ".PDF"),
    `storyhold/worlds/${worldId}/sources/${sourceId}.pdf`,
  );
  assert.throws(
    () => storyholdSourceObjectKey("../another-world", sourceId, ".pdf"),
    /Invalid Storyhold source identifier/,
  );
  assert.throws(
    () => storyholdSourceObjectKey(worldId, sourceId, "../pdf"),
    /extension/,
  );
});

test("source vault upload is private and refuses overwrite", async () => {
  const saved: Array<{ name: string; options: unknown }> = [];
  const vault = new GcsStoryholdSourceVaultStorage(
    {
      file(name) {
        return {
          async save(_bytes, options) {
            saved.push({ name, options });
          },
          async delete() {},
        };
      },
      async getFiles() {
        return [[]];
      },
    },
    "/private-bucket/application-private",
  );
  const key = await vault.uploadSource({
    worldId: "5fd1d7c4-1bb0-4fc4-a36d-b4d4909a6098",
    sourceId: "a4d1d7c4-1bb0-4fc4-a36d-b4d4909a6098",
    extension: ".txt",
    bytes: Buffer.from("source"),
    contentType: "text/plain",
    documentType: "txt",
  });
  assert.equal(
    key,
    "storyhold/worlds/5fd1d7c4-1bb0-4fc4-a36d-b4d4909a6098/sources/a4d1d7c4-1bb0-4fc4-a36d-b4d4909a6098.txt",
  );
  assert.deepEqual(saved[0]?.options, {
    resumable: false,
    preconditionOpts: { ifGenerationMatch: 0 },
    metadata: {
      contentType: "text/plain",
      metadata: { documentType: "txt" },
    },
  });
});

test("source deletion is idempotent and world deletion uses an exact prefix", async () => {
  const deleted: string[] = [];
  let requestedPrefix = "";
  const missing = Object.assign(new Error("missing"), { code: 404 });
  const vault = new GcsStoryholdSourceVaultStorage(
    {
      file(name) {
        return {
          async save() {},
          async delete() {
            deleted.push(name);
            if (name.endsWith(".txt")) throw missing;
          },
        };
      },
      async getFiles({ prefix }) {
        requestedPrefix = prefix;
        return [
          [
            {
              async save() {},
              async delete() {
                deleted.push("first");
              },
            },
            {
              async save() {},
              async delete() {
                deleted.push("second");
              },
            },
          ],
        ];
      },
    },
    "/private-bucket/app",
  );
  await vault.deleteSource(
    "storyhold/worlds/5fd1d7c4-1bb0-4fc4-a36d-b4d4909a6098/sources/a4d1d7c4-1bb0-4fc4-a36d-b4d4909a6098.txt",
  );
  await vault.deleteWorldSources(
    "5fd1d7c4-1bb0-4fc4-a36d-b4d4909a6098",
  );
  assert.equal(
    requestedPrefix,
    `app/${storyholdWorldObjectPrefix("5fd1d7c4-1bb0-4fc4-a36d-b4d4909a6098")}`,
  );
  assert.deepEqual(deleted, [
    "app/storyhold/worlds/5fd1d7c4-1bb0-4fc4-a36d-b4d4909a6098/sources/a4d1d7c4-1bb0-4fc4-a36d-b4d4909a6098.txt",
    "first",
    "second",
  ]);
});
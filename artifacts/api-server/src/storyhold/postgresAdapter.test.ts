import assert from "node:assert/strict";
import test from "node:test";
import { PostgresStoryholdAdapter } from "./postgresAdapter";

test("PostgresStoryholdAdapter commits and releases one checked-out client", async () => {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      return { rows: [] };
    },
    release: () => calls.push("RELEASE"),
  };
  const adapter = new PostgresStoryholdAdapter({
    connect: async () => client,
  } as never);

  await adapter.transaction(async (tx) => {
    await tx.query("INSERT INTO storyhold.example VALUES (1)");
  });
  assert.deepEqual(calls, ["BEGIN", "INSERT INTO storyhold.example VALUES (1)", "COMMIT", "RELEASE"]);
});

test("PostgresStoryholdAdapter rolls back and releases when its callback fails", async () => {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      return { rows: [] };
    },
    release: () => calls.push("RELEASE"),
  };
  const adapter = new PostgresStoryholdAdapter({
    connect: async () => client,
  } as never);

  await assert.rejects(
    adapter.transaction(async () => {
      throw new Error("write failed");
    }),
    /write failed/,
  );
  assert.deepEqual(calls, ["BEGIN", "ROLLBACK", "RELEASE"]);
});
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { db, beatsTable } from "@workspace/db";
import { asc, inArray } from "drizzle-orm";
import { reorderBeats } from "./beats";

// Integration regression test for the beats reorder path. Guards against the
// "column \"sort_order\" is of type integer but expression is of type text"
// 500 that the CASE-based bulk UPDATE used to throw when the THEN value was
// sent as an untyped (text-resolved) parameter. Runs against the dev database
// pointed to by DATABASE_URL.

const TEST_SLUGS = ["zz-reorder-test-a", "zz-reorder-test-b", "zz-reorder-test-c"];

let snapshot: { id: string; sortOrder: number }[] = [];
let testIds: { a: string; b: string; c: string };

before(async () => {
  // Snapshot the existing display order so we can restore it afterwards.
  snapshot = (
    await db.select({ id: beatsTable.id, sortOrder: beatsTable.sortOrder }).from(beatsTable)
  ).map((r) => ({ id: r.id, sortOrder: r.sortOrder }));

  // Clean up any leftovers from a previous aborted run, then insert 3 beats.
  await db.delete(beatsTable).where(inArray(beatsTable.slug, TEST_SLUGS));
  const inserted = await db
    .insert(beatsTable)
    .values([
      { slug: TEST_SLUGS[0]!, name: "Reorder Test A", sortOrder: 100 },
      { slug: TEST_SLUGS[1]!, name: "Reorder Test B", sortOrder: 101 },
      { slug: TEST_SLUGS[2]!, name: "Reorder Test C", sortOrder: 102 },
    ])
    .returning({ id: beatsTable.id, slug: beatsTable.slug });
  const bySlug = new Map(inserted.map((r) => [r.slug, r.id]));
  testIds = {
    a: bySlug.get(TEST_SLUGS[0]!)!,
    b: bySlug.get(TEST_SLUGS[1]!)!,
    c: bySlug.get(TEST_SLUGS[2]!)!,
  };
});

after(async () => {
  // Remove the test beats, then restore the original sort_order values.
  await db.delete(beatsTable).where(inArray(beatsTable.slug, TEST_SLUGS));
  for (const row of snapshot) {
    await db
      .update(beatsTable)
      .set({ sortOrder: row.sortOrder })
      .where(inArray(beatsTable.id, [row.id]));
  }
});

test("reorders 3+ beats to the requested positions", async () => {
  // Requested order: C, A, B first. reorderBeats puts requested ids at the
  // front (0,1,2,...), so the three test beats must land at 0, 1, 2.
  const result = await reorderBeats([testIds.c, testIds.a, testIds.b]);
  const orderOf = new Map(result.map((r) => [r.id, r.sortOrder]));

  assert.equal(orderOf.get(testIds.c), 0, "C should be first");
  assert.equal(orderOf.get(testIds.a), 1, "A should be second");
  assert.equal(orderOf.get(testIds.b), 2, "B should be third");

  // Every beat must have a unique, contiguous sort_order starting at 0.
  const sorted = [...result].sort((x, y) => x.sortOrder - y.sortOrder);
  sorted.forEach((r, i) => assert.equal(r.sortOrder, i, `position ${i} must be contiguous`));
});

test("reorders a different subset and keeps values contiguous", async () => {
  // Reverse: B, C, A.
  const result = await reorderBeats([testIds.b, testIds.c, testIds.a]);
  const orderOf = new Map(result.map((r) => [r.id, r.sortOrder]));

  assert.equal(orderOf.get(testIds.b), 0, "B should be first");
  assert.equal(orderOf.get(testIds.c), 1, "C should be second");
  assert.equal(orderOf.get(testIds.a), 2, "A should be third");

  // Reading back from the DB must reflect the persisted order.
  const persisted = await db
    .select({ id: beatsTable.id, sortOrder: beatsTable.sortOrder })
    .from(beatsTable)
    .where(inArray(beatsTable.id, [testIds.a, testIds.b, testIds.c]))
    .orderBy(asc(beatsTable.sortOrder));
  assert.deepEqual(
    persisted.map((p) => p.id),
    [testIds.b, testIds.c, testIds.a],
    "persisted order must match requested order",
  );
});

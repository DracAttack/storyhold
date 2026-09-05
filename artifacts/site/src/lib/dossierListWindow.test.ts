import assert from "node:assert/strict";
import test from "node:test";
import { DOSSIER_PREVIEW_ITEMS, dossierListWindow } from "./dossierListWindow";

test("long dossier lists start compact and every complete item remains reachable", () => {
  const values = Array.from({ length: 257 }, (_, index) => `${index}: ${"Full retained dossier text. ".repeat(60)}`);
  const original = [...values];
  let result = dossierListWindow(values);
  assert.equal(result.shownCount, DOSSIER_PREVIEW_ITEMS);
  assert.equal(result.total, values.length);
  while (result.hasMore) result = dossierListWindow(values, result.nextCount);
  assert.deepEqual(result.visibleValues, original);
  assert.deepEqual(values, original);
});

test("show all and show fewer affect presentation only, without changing saved/editable data", () => {
  const values = Array.from({ length: 45 }, (_, index) => `Detail ${index}`);
  assert.deepEqual(dossierListWindow(values, values.length).visibleValues, values);
  assert.equal(dossierListWindow(values, DOSSIER_PREVIEW_ITEMS).shownCount, DOSSIER_PREVIEW_ITEMS);
  assert.equal(values.length, 45);
});

test("empty, short, shrinking and invalid presentation counts stay bounded", () => {
  assert.deepEqual(dossierListWindow([]), { visibleValues: [], shownCount: 0, total: 0, hasMore: false, nextCount: 0 });
  assert.equal(dossierListWindow(["only detail"], 800).shownCount, 1);
  const values = Array.from({ length: 30 }, (_, index) => index);
  for (const count of [NaN, Infinity, -1, 0]) assert.equal(dossierListWindow(values, count).shownCount, DOSSIER_PREVIEW_ITEMS);
  assert.equal(dossierListWindow(values, 12.9).shownCount, 12);
});

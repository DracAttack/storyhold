import assert from "node:assert/strict";
import test from "node:test";
import { dossierListFromEditor } from "./dossierEdits";

test("unchanged multiline facts retain their original item boundaries and whitespace", () => {
  const facts = [" First line.\nSecond line. ", "Another paragraph.\n\nStill the same fact."];
  assert.deepEqual(dossierListFromEditor(facts, facts.join("\n")), facts);
  assert.notEqual(dossierListFromEditor(facts, facts.join("\n")), facts);
});

test("unchanged aliases retain literal commas, semicolons and exact spacing", () => {
  const aliases = ["Mira, Captain of the Watch", " River; Keeper ", "Name\nWith Break"];
  assert.deepEqual(dossierListFromEditor(aliases, aliases.join(", "), ", ", /[,;\n]/), aliases);
  assert.deepEqual(dossierListFromEditor(aliases, aliases.join(", "), ", ", ","), aliases);
});

test("explicit edits retain the existing list editor behavior without item caps", () => {
  assert.deepEqual(dossierListFromEditor(["Old"], "  New One\n\nNew Two  "), ["New One", "New Two"]);
  assert.deepEqual(dossierListFromEditor(["Old"], "River, Captain; Guard", ", ", /[,;\n]/), ["River", "Captain", "Guard"]);
  const all = Array.from({ length: 213 }, (_, i) => `${i}: ${"Long retained text. ".repeat(90)}`.trim());
  assert.deepEqual(dossierListFromEditor([], all.join("\n")), all);
});

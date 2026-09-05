import assert from "node:assert/strict";
import test from "node:test";
import { appendDossierStrings, dossierConnections, dossierStrings } from "./dossierContent";
import { mergeDossierProfiles, serializeDossier } from "./worldStudio";

test("persisted text lists preserve full text, order and distinct case without extraction caps", () => {
  const previous = Array.from({ length: 120 }, (_, index) => `History ${index}`);
  const long = `First paragraph.\n${"Long account. ".repeat(120)}Final qualifier.`;
  assert.deepEqual(dossierStrings(previous, [previous[0], long, "case", "Case", null, 7, "  "]),
    [...previous, long, "case", "Case"]);
});

test("paid review appends without collapsing any existing exact display slots", () => {
  const original = ["Miri", "Miri", "", "  ", " Late account.\nIts final qualifier remains. ", "Later unrelated item"];
  const saved = appendDossierStrings(original, ["Miri", "New nickname", "New nickname", "", "  "], ["New nickname", "new nickname"]);
  assert.deepEqual(saved, [...original, "New nickname", "new nickname"]);
  assert.deepEqual(original, ["Miri", "Miri", "", "  ", " Late account.\nIts final qualifier remains. ", "Later unrelated item"]);
  assert.deepEqual(appendDossierStrings(saved, ["Miri", "New nickname"]), saved);
  assert.deepEqual(dossierStrings(original), ["Miri", " Late account.\nIts final qualifier remains. ", "Later unrelated item"], "Unrelated extraction/read dedup remains unchanged");
});

test("dossier merge and public read retain every list item and connection", () => {
  const traits = Array.from({ length: 90 }, (_, index) => `Trait ${index}`);
  const connections = Array.from({ length: 70 }, (_, index) => ({ name: `Person ${index}`, relationship: "ally",
    summary: "Met in the winter.", sentiment: "positive", evidence: Array.from({ length: 8 }, (_, quote) => ({ chunkId: "chapter", quote: `Line ${quote}` })) }));
  const merged = mergeDossierProfiles({ traits, relationshipWeb: connections }, { traits: ["New trait"], relationshipWeb: [connections[0]] });
  const serialized = serializeDossier({ profile: merged, summary: "Mira shelters travelers." });
  assert.deepEqual(serialized.profile.traits, [...traits, "New trait"]);
  assert.equal(serialized.profile.relationshipWeb.length, 70);
  assert.equal(serialized.profile.relationshipWeb[0]!.evidence.length, 8);
});

test("repeated connections combine exact duplicates without losing late-story qualifiers", () => {
  const ally = { name: "Lilly", relationship: "partner", summary: "They stand together in the first book.", sentiment: "positive", evidence: [{ quote: "First source" }] };
  const former = { ...ally, summary: "They stand opposed toward the end of the second book.", sentiment: "negative" };
  assert.deepEqual(dossierConnections([ally], [{ ...ally, evidence: [{ quote: "Second source" }] }, former]), [
    { ...ally, evidence: [{ quote: "First source" }, { quote: "Second source" }] }, former,
  ]);
  const long = { ...ally, summary: "The qualified account. ".repeat(80) };
  assert.equal(serializeDossier({ profile: { relationshipWeb: [long] } }).profile.relationshipWeb[0]!.summary, long.summary);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  createFileNarrativeSection,
  parseNarrativeSections,
  summarizeNarrativeSection,
} from "./sourceChapters";

test("chapter indexing ignores compact repeated contents but retains narrative bodies", () => {
  const text = `CONTENTS
Chapter 1 - Arrival (Alec - Present) 4
Chapter 2 - Cost (Echo - Past) 30

Chapter 1 - Arrival (Alec - Present)
Alec reaches the ruined station and discovers a warning carved into the door.
${"The group searches the platform for survivors. ".repeat(8)}
They leave before the enemy patrol arrives.

Chapter 2 - Cost (Echo - Past)
Echo remembers the invasion and learns why the city fell.
${"The memory reveals another consequence. ".repeat(8)}
She decides to tell Alec the truth.`;
  const sections = parseNarrativeSections(text);
  assert.deepEqual(sections.map((section) => section.title), [
    "Chapter 1 — Arrival (Alec - Present)",
    "Chapter 2 — Cost (Echo - Past)",
  ]);
  assert.match(sections[0]?.body ?? "", /ruined station/);
  assert.doesNotMatch(sections[0]?.body ?? "", /Chapter 2/);
});

test("chapter indexing accepts Roman, spelled, part, interlude, and POV headings", () => {
  const text = `PART II: The Exile
The city closes its gates.
CHAPTER TWENTY-ONE — No Way Home
Mara learns the road has vanished.
Interlude III: The Queen
The Queen speaks once and the room obeys.
POV: Alec
Alec refuses the order.
ECHO (POV)
Echo remembers why he refused.`;
  const sections = parseNarrativeSections(text);
  assert.deepEqual(sections.map(({ kind }) => kind), ["part", "chapter", "interlude", "pov", "pov"]);
  assert.match(sections[1]?.title ?? "", /^Chapter TWENTY-ONE/u);
  assert.equal(sections[3]?.perspective, "Alec");
  assert.equal(sections[4]?.perspective, "ECHO");
});

test("duplicate chapter labels remain distinct instead of being dropped", () => {
  const text = `Part One
Chapter 1
The first narrator opens the northern door.
Part Two
Chapter 1
The second narrator opens the southern door.`;
  const chapters = parseNarrativeSections(text).filter((section) => section.kind === "chapter");
  assert.equal(chapters.length, 2);
  assert.deepEqual(chapters.map(({ key }) => key), ["chapter-1", "chapter-1-2"]);
  assert.match(chapters[0]!.body, /northern/);
  assert.match(chapters[1]!.body, /southern/);
});

test("short but valid narrative sections are retained", () => {
  const sections = parseNarrativeSections(`Prologue\nShe woke.\nEpilogue\nShe slept.`);
  assert.deepEqual(sections.map(({ body }) => body), ["She woke.", "She slept."]);
});

test("one-chapter files can explicitly fall back to their filename", () => {
  const sections = parseNarrativeSections("Rain crossed the empty platform.", {
    sourceTitle: "Book 2 - Chapter 014 - Homecoming.docx",
    fallbackToSource: true,
  });
  assert.equal(sections.length, 1);
  assert.equal(sections[0]?.kind, "file");
  assert.equal(sections[0]?.title, "Book 2 - Chapter 014 - Homecoming");
  assert.equal(sections[0]?.body, "Rain crossed the empty platform.");

  assert.equal(createFileNarrativeSection("   ", "Empty.txt"), null);
});

test("chapter indexing creates a compact grounded digest", () => {
  const body = `Alec reaches the ruined station and discovers a warning carved into the door. ${"He searches empty rooms while the storm grows louder. ".repeat(8)} Echo reveals that the patrol is already inside. They escape through a maintenance tunnel before the station is destroyed.`;
  const digest = summarizeNarrativeSection(body);
  assert.match(digest, /Alec reaches/);
  assert.ok(digest.length < 900);
});

test("chapter indexing does not absorb the opening sentence into a heading", () => {
  const sections = parseNarrativeSections(
    `Chapter 23 - A Heartfelt Mistake What the fuck just happened? ${"Lilly walks into the forest while Alec follows. ".repeat(12)} They return to camp together.`,
  );
  assert.equal(sections[0]?.title, "Chapter 23 — A Heartfelt Mistake");
  assert.match(sections[0]?.body ?? "", /^What the fuck/u);
});

import type { AnalysisChunk } from "./worldAnalysis";
import type { LocalRelationMention } from "./localEntityExtraction";

/**
 * Small synthetic passages encoding Storyhold's known hard cases. They are
 * deliberately not copied from a manuscript; their job is to keep identity,
 * relationship direction, metaphor, manifested forms, and proper-place names
 * from regressing as the local intake stack changes.
 */
export const ASHES_DIFFICULT_CHUNKS: AnalysisChunk[] = [{
  id: "ashes-alec-echo-one",
  sourceId: "ashes-fixture",
  sourceTitle: "ASHES Regression Fixture",
  index: 0,
  sectionTitle: "Chapter 1 (Alec - Present)",
  content: "In Sanctuary, Alec watched Echo cross the square. Echo was like a daughter to him, a bond of choice rather than blood.",
}, {
  id: "ashes-alec-echo-two",
  sourceId: "ashes-fixture",
  sourceTitle: "ASHES Regression Fixture",
  index: 1,
  sectionTitle: "Chapter 2 (Alec - Present)",
  content: "Alec asked Echo to help defend Sanctuary while Michael guarded the gate.",
}, {
  id: "ashes-michael-thrall",
  sourceId: "ashes-fixture",
  sourceTitle: "ASHES Regression Fixture",
  index: 2,
  sectionTitle: "Chapter 3 (Michael - Present)",
  content: "Michael became the Thrall; the immense manifested body was still Michael, not a separate stranger.",
}, {
  id: "ashes-ragger-identity",
  sourceId: "ashes-fixture",
  sourceTitle: "ASHES Regression Fixture",
  index: 3,
  sectionTitle: "Chapter 4 (Ragger - Past)",
  content: "Ragger, also called Anubis and Anubsika, was the Old Dog who had watched humanity for millennia.",
}, {
  id: "ashes-coop-sanctuary",
  sourceId: "ashes-fixture",
  sourceTitle: "ASHES Regression Fixture",
  index: 4,
  sectionTitle: "Chapter 5 (Kendall - Past)",
  content: "Kendall, Lilly, Mathis, Irene, Amanda, and Ragger built the Co-op. Sanctuary was the separate town where Alec later settled.",
}, {
  id: "ashes-generic-inventory-noise",
  sourceId: "ashes-fixture",
  sourceTitle: "ASHES Regression Fixture",
  index: 5,
  sectionTitle: "Chapter 6 (Alec - Present)",
  content: "Alec checked the alarm in the aisle, carried ammunition, and wondered about the animal's abilities.",
}, {
  id: "ashes-alec-echo-mind",
  sourceId: "ashes-fixture",
  sourceTitle: "ASHES Regression Fixture",
  index: 6,
  sectionTitle: "Chapter 7 (Alec - Present)",
  content: "The voice inside my mind identified itself as one of the Visharath. Echo was a symbiont, and I was Echo's human host.",
}, {
  id: "ashes-alec-echo-transformation",
  sourceId: "ashes-fixture",
  sourceTitle: "ASHES Regression Fixture",
  index: 7,
  sectionTitle: "Chapter 8 (Alec - Present)",
  content: "I opened my mind to Echo and our transformation began. Together, Echo and I became a nine-foot, six-eyed nonhuman form with immense strength and new senses.",
}];

export const ALIEN_DIFFICULT_CHUNKS: AnalysisChunk[] = [{
  id: "alien-addison-one",
  sourceId: "alien-fixture",
  sourceTitle: "ALIEN Regression Fixture",
  index: 0,
  sectionTitle: "Chapter 1 (Addison Gray)",
  content: "Captain Addison Gray led the Rust Raptor crew after a false distress signal drew them to LV-2032. She distrusted Driver but bargained because her crew had no safe alternative.",
}, {
  id: "alien-addison-two",
  sourceId: "alien-fixture",
  sourceTitle: "ALIEN Regression Fixture",
  index: 1,
  sectionTitle: "Chapter 8 (Addison Gray)",
  content: "Addison relied on her closest friend Fariah, studied the danger carefully, and put the crew's survival ahead of her own fear.",
}];

export const DIFFICULT_RELATIONS: LocalRelationMention[] = [{
  subject: "Echo",
  relationType: "child_of",
  target: "Alec",
  score: 0.9,
  chunkId: "ashes-alec-echo-one",
  sourceId: "ashes-fixture",
  quote: ASHES_DIFFICULT_CHUNKS[0]!.content,
}, {
  subject: "Michael",
  relationType: "has_form",
  target: "Thrall",
  score: 0.96,
  chunkId: "ashes-michael-thrall",
  sourceId: "ashes-fixture",
  quote: ASHES_DIFFICULT_CHUNKS[2]!.content,
}, {
  subject: "Addison Gray",
  relationType: "leads",
  target: "Rust Raptor Crew",
  score: 0.95,
  chunkId: "alien-addison-one",
  sourceId: "alien-fixture",
  quote: ALIEN_DIFFICULT_CHUNKS[0]!.content,
}, {
  subject: "Addison Gray",
  relationType: "friend_of",
  target: "Fariah",
  score: 0.94,
  chunkId: "alien-addison-two",
  sourceId: "alien-fixture",
  quote: ALIEN_DIFFICULT_CHUNKS[1]!.content,
}];

export const STORYHOLD_DIFFICULT_EXPECTATIONS = {
  alec: { requiredConnections: ["Echo", "Sanctuary"], forbiddenRelationship: "Child Of" },
  addison: { requiredConnections: ["Fariah", "Driver", "Rust Raptor Crew"] },
  echo: { literalChildOfAlec: false },
  michael: { requiredForm: "Thrall" },
  ragger: { aliases: ["Anubis", "Anubsika", "Old Dog"] },
  sanctuary: { distinctFrom: "Co-op" },
} as const;

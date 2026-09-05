import assert from "node:assert/strict";
import test from "node:test";
import { entityReviewRequest, parseEntityReviewFinding, reviewEntityFromBrowser, type EntityReviewInput } from "./entityReview";

const input: EntityReviewInput = {
  worldName: "Test world",
  worldPremise: "",
  worldGenre: "",
  entity: {
    id: "entity-1",
    name: "Guppie Henderson",
    entityType: "character",
    aliases: [],
    summary: "",
    details: [],
    relationships: [],
  },
  chunks: [{
    id: "chunk-1",
    sourceId: "source-1",
    sourceTitle: "Book One",
    index: 0,
    content: "Guppie Henderson joined Sanctuary after the fall of the old cooperative.",
  }],
  knownEntities: [
    { name: "Guppie Henderson", entityType: "character", aliases: [] },
    { name: "Sanctuary", entityType: "faction", aliases: [] },
  ],
  depth: "focused",
};

test("entity review keeps only source-backed evidence and links to known records", () => {
  const finding = parseEntityReviewFinding(JSON.stringify({
    aliases: ["Guppie"],
    summary: "A member of Sanctuary.",
    details: ["Joined Sanctuary after the cooperative fell."],
    relationships: [],
    evidence: [
      { chunkId: "chunk-1", quote: "joined Sanctuary" },
      { chunkId: "chunk-1", quote: "was secretly immortal" },
    ],
    confidence: 0.9,
    character: {
      role: "Survivor",
      summary: "A member of Sanctuary.",
      traits: [], motivations: [], fears: [], capabilities: [], history: [], origins: [],
      powers: [], moralSystem: [], physicalCharacteristics: [], relationships: [],
      relationshipWeb: [], estimatedStats: {
        strength: {
          score: 13,
          confidence: 0.7,
          rationale: "Guppie survives the fall.",
          evidence: [{ chunkId: "chunk-1", quote: "after the fall" }],
        },
      }, socioPoliticalAxis: {}, knowledge: [],
      secrets: [], factionMemberships: ["Sanctuary"],
      evidence: [{ chunkId: "chunk-1", quote: "Guppie Henderson joined Sanctuary" }],
      confidence: 0.8,
    },
    relations: [
      { subject: "Guppie Henderson", relationType: "member_of", target: "Sanctuary", status: "active", summary: "Joined after the fall.", evidence: [{ chunkId: "chunk-1", quote: "joined Sanctuary" }], confidence: 0.9 },
      { subject: "Guppie Henderson", relationType: "member_of", target: "Unknown Cabal", status: "active", summary: "Invented.", evidence: [{ chunkId: "chunk-1", quote: "joined Sanctuary" }], confidence: 0.9 },
    ],
    rules: [],
  }), input);

  assert.equal(finding.evidence.length, 1);
  assert.equal(finding.evidence[0]?.sourceId, "source-1");
  assert.equal(finding.relations.length, 1);
  assert.equal(finding.relations[0]?.target, "Sanctuary");
  assert.equal(finding.character?.name, "Guppie Henderson");
  assert.equal(finding.character?.estimatedStats.strength.evidence.length, 1);
  assert.equal(finding.character?.estimatedStats.dexterity.evidence.length, 0);
});

test("entity review treats private Qwen dossier leads as untrusted questions", () => {
  const request = entityReviewRequest({
    ...input,
    browserAuditContext: JSON.stringify({
      model: "Qwen browser",
      relationshipChecks: ["Is this daughter language metaphorical rather than literal?"],
    }),
  });
  const prompt = request.messages.map((message) => message.content).join("\n");
  assert.equal(request.task, "canon_review");
  assert.equal(request.stage, "dossier");
  assert.match(request.system, /PRIVATE BROWSER AUDIT LEADS are questions/i);
  assert.match(request.system, /never repeat one as a finding unless an exact supplied quote proves it/i);
  assert.match(prompt, /metaphorical rather than literal/i);
});

test("browser Qwen fallback uses the same evidence and relationship verifier", () => {
  const reviewed = reviewEntityFromBrowser(input, {
    model: "Qwen3.5-2B",
    inputTokens: 900,
    outputTokens: 300,
    text: JSON.stringify({
      aliases: ["Guppie"],
      summary: "Guppie belongs to Sanctuary.",
      details: ["Guppie joined Sanctuary after the old cooperative fell."],
      relationships: [],
      evidence: [{ chunkId: "chunk-1", quote: "Guppie Henderson joined\nSanctuary" }],
      relations: [
        { subject: "Guppie Henderson", relationType: "member_of", target: "Sanctuary", status: "active", evidence: [{ chunkId: "chunk-1", quote: "joined Sanctuary" }] },
        { subject: "Guppie Henderson", relationType: "member_of", target: "Invented place", status: "active", evidence: [{ chunkId: "chunk-1", quote: "joined Sanctuary" }] },
      ],
      rules: [],
    }),
  });
  assert.equal(reviewed.result.provider, "storyhold-browser");
  assert.equal(reviewed.result.usage.inputUnits, 900);
  assert.equal(reviewed.finding.evidence.length, 1);
  assert.equal(reviewed.finding.relations.length, 1);
  assert.equal(reviewed.finding.relations[0]?.target, "Sanctuary");
});

test("entity review rejects empty and uncited provider output instead of marking it verified", () => {
  assert.throws(
    () => parseEntityReviewFinding("{}", input),
    /did not produce any useful dossier claims/i,
  );
  assert.throws(
    () => parseEntityReviewFinding(JSON.stringify({
      summary: "Guppie is secretly immortal.",
      evidence: [{ chunkId: "chunk-1", quote: "secretly immortal" }],
    }), input),
    /did not support its dossier with an exact supplied passage/i,
  );
});

test("entity review preserves existing stats unless each changed score has its own citation", () => {
  const current = parseEntityReviewFinding(JSON.stringify({
    summary: "Guppie joined Sanctuary.",
    evidence: [{ chunkId: "chunk-1", quote: "Guppie Henderson joined Sanctuary" }],
    character: {
      summary: "Guppie joined Sanctuary.",
      estimatedStats: {
        strength: {
          score: 13,
          confidence: 0.7,
          rationale: "Guppie survived the cooperative's fall.",
          evidence: [{ chunkId: "chunk-1", quote: "after the fall" }],
        },
      },
      evidence: [{ chunkId: "chunk-1", quote: "Guppie Henderson joined Sanctuary" }],
    },
  }), input).character!;
  const reviewed = parseEntityReviewFinding(JSON.stringify({
    summary: "Guppie joined Sanctuary after the fall.",
    evidence: [{ chunkId: "chunk-1", quote: "joined Sanctuary after the fall" }],
    character: {
      summary: "Guppie joined Sanctuary after the fall.",
      estimatedStats: {
        strength: {
          score: 2,
          confidence: 0.99,
          rationale: "Unsupported replacement.",
          evidence: [],
        },
        dexterity: {
          score: 12,
          confidence: 0.6,
          rationale: "The passage establishes survival after the fall.",
          evidence: [{ chunkId: "chunk-1", quote: "after the fall" }],
        },
      },
      evidence: [{ chunkId: "chunk-1", quote: "Guppie Henderson joined Sanctuary" }],
    },
  }), { ...input, currentCharacter: current });

  assert.equal(reviewed.character?.estimatedStats.strength.score, 13);
  assert.equal(reviewed.character?.estimatedStats.dexterity.score, 12);
});

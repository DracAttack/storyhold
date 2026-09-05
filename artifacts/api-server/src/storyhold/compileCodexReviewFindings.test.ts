import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeCodexReviewFindings,
  normalizeCompiledChronology,
  normalizeCompiledRelationshipWeb,
  normalizeCompiledRules,
  reconcileCompiledDossierPowers,
  resolveCompiledIdentityReveals,
} from "./compileCodexReviewFindings";
import type { WorldFindings } from "./worldAnalysis";

const sourceId = "356a7b64-37aa-4801-b2a2-fc13097dfe99";
const evidence = (chunkId: string) => ({
  chunkId,
  sourceId,
  quote: `grounded ${chunkId}`,
});

test("compiled multi-source review retains every source summary", () => {
  const first = {
    summary: "Book One establishes the invasion and Alec's apparent death.",
    worldRules: [{
      name: "Grounded rule",
      summary: "A grounded rule survives validation.",
      evidence: [{
        chunkId: "00000000-0000-4000-8000-000000000001",
        quote: "grounded rule",
      }],
    }],
  };
  const second = {
    summary: "Book Two follows the reunion, capture, and unfinished rescue.",
  };
  const chunks = [{
    id: "00000000-0000-4000-8000-000000000001",
    sourceId,
    sourceTitle: "Book Two",
    content: "A quiet passage contains one grounded rule.",
    index: 0,
  }];

  const merged = mergeCodexReviewFindings([first, second], chunks);

  assert.match(merged.summary, /Book One establishes/u);
  assert.match(merged.summary, /Book Two follows/u);
});

function chronologyEvent(name: string, chapterKey: string, chunkId: string) {
  return {
    name,
    summary: `${name} summary`,
    evidence: [evidence(chunkId)],
    aliases: [],
    details: [],
    relationships: [],
    factionMemberships: [],
    confidence: 0.9,
    reviewStatus: "verified" as const,
    worldTimeLabel: "relative",
    temporalStatus: "relative" as const,
    importance: "major" as const,
    sourceChapterKeys: [chapterKey],
    actors: [],
    targets: [],
    witnesses: [],
    locations: [],
  };
}

test("compiled chronology globally orders ancient history and covers connective chapters", () => {
  const reunion = chronologyEvent(
    "Alec meets Ragger while the searchers reach his settlement",
    `${sourceId}:chapter-4`,
    "00000000-0000-4000-8000-000000000004",
  );
  const findings = {
    chapterSummaries: [{
      sourceId,
      sourceTitle: "Book Two",
      chapterKey: `${sourceId}:chapter-5`,
      chapterTitle: "Chapter 5",
      perspective: "Kendall Sumner",
      sourceOrder: 5,
      summary: "The search party confirms Alec's identity and learns about the Turncoats.",
      majorEvents: [],
      evidence: [evidence("00000000-0000-4000-8000-000000000005")],
      confidence: 0.9,
      reviewStatus: "verified" as const,
    }],
    chronology: [
      chronologyEvent("The Old Dog prepares humanity", "book-one:prologue", "00000000-0000-4000-8000-000000000001"),
      reunion,
      chronologyEvent("Anubsika kills the earlier Destroyer and learns the suppressed origin", `${sourceId}:chapter-10`, "00000000-0000-4000-8000-000000000002"),
      chronologyEvent("Ragger's scouting party arrives on ancient Earth and fractures", `${sourceId}:chapter-7`, "00000000-0000-4000-8000-000000000003"),
    ],
  } as Pick<WorldFindings, "chapterSummaries" | "chronology">;

  normalizeCompiledChronology(findings);

  assert.deepEqual(findings.chronology.map((event) => event.name), [
    "Anubsika kills the earlier Destroyer and learns the suppressed origin",
    "Ragger's scouting party arrives on ancient Earth and fractures",
    "The Old Dog prepares humanity",
    "Alec meets Ragger while the searchers reach his settlement",
  ]);
  assert.ok(reunion.sourceChapterKeys.includes(`${sourceId}:chapter-5`));
  assert.equal(reunion.evidence.length, 2);
  assert.match(reunion.summary, /accumulated evidence further confirm/u);
});

test("complete-edition review resolves the Old Dog narrator to Ragger", () => {
  const oldDogEvidence = evidence("00000000-0000-4000-8000-000000000011");
  const revealEvidence = {
    ...evidence("00000000-0000-4000-8000-000000000012"),
    quote: "I am Anubsika",
  };
  const findings = {
    characters: [{
      name: "Ragger",
      aliases: ["Anubsika", "Anubis"],
      summary: "Ragger spent millennia warning humanity through myth.",
      history: [],
      evidence: [revealEvidence],
    }],
    ambiguous: [{
      name: "Old Dog narrator",
      aliases: [],
      summary: "A dog-bodied nonhuman watched humanity for nearly six thousand years and prepared it through myth, scripture, dreams, and war.",
      evidence: [oldDogEvidence],
    }],
    chapterSummaries: [{
      sourceId,
      sourceTitle: "Book One",
      chapterKey: `${sourceId}:prologue`,
      chapterTitle: "Prologue: An Old Dog's Tale",
      perspective: "unnamed ancient doglike narrator",
      sourceOrder: 0,
      summary: "An ancient dog-bodied nonhuman prepares humanity.",
      majorEvents: ["The narrator senses the approaching swarm."],
      evidence: [oldDogEvidence],
      confidence: 0.99,
      reviewStatus: "verified",
    }],
    chronology: [{
      ...chronologyEvent("The Old Dog prepares humanity", `${sourceId}:prologue`, oldDogEvidence.chunkId),
      summary: "For nearly six thousand years, the narrator prepared humanity through myth, scripture, dreams, and war.",
      actors: ["Old Dog narrator"],
    }],
    claims: [{ subject: "Old Dog narrator", epistemicHolder: "" }],
    entityRelations: [],
    entityRules: [],
    openQuestions: ["Who is the unnamed Old Dog narrator?", "Another question"],
    cohesionProposals: [{ kind: "identity", subject: "Old Dog narrator" }],
  } as unknown as WorldFindings;

  resolveCompiledIdentityReveals(findings);

  assert.equal(findings.ambiguous.some((item) => item.name === "Old Dog narrator"), false);
  assert.ok(findings.characters[0]?.aliases.includes("Old Dog narrator"));
  assert.ok(findings.characters[0]?.aliases.includes("Old Dog"));
  assert.equal(findings.characters[0]?.evidence.length, 2);
  assert.match(findings.chapterSummaries[0]?.perspective ?? "", /Ragger \/ Anubsika/u);
  assert.match(findings.chapterSummaries[0]?.summary ?? "", /later identified as Anubsika/u);
  assert.deepEqual(findings.chronology[0]?.actors, ["Ragger"]);
  assert.match(findings.chronology[0]?.summary ?? "", /remembered by humanity as Anubis/u);
  assert.equal(findings.claims?.[0]?.subject, "Ragger");
  assert.deepEqual(findings.openQuestions, ["Another question"]);
  assert.equal(findings.cohesionProposals.length, 0);
});

test("compiled review grounds Changeling mimicry as a dedicated verified power", () => {
  const findings = {
    entityRules: [],
    powers: [{
      name: "Changeling mimicry",
      aliases: [],
      summary: "Observed in Marlene's Changeling successor.",
      details: [],
      relationships: [],
      factionMemberships: [],
      evidence: [evidence("00000000-0000-4000-8000-000000000099")],
      confidence: 0.7,
      reviewStatus: "candidate",
    }],
  } as unknown as WorldFindings;

  normalizeCompiledRules(findings);

  const power = findings.powers.find((candidate) => candidate.name === "Changeling mimicry");
  assert.equal(power?.reviewStatus, "verified");
  assert.match(power?.summary ?? "", /host and Vit may take turns controlling/u);
  assert.deepEqual(power?.evidence.map((item) => item.chunkId), [
    "90c0f0b3-7c9d-4136-8a27-b3bac60c0c76",
    "16b0ded2-597b-43a8-95e2-d97e99505998",
    "132be0e4-801c-4375-9663-5792edb540eb",
    "762d8931-8a42-4bd3-9c84-21a7ecfcde46",
  ]);
});

test("compiled review grounds healing and resuscitation in direct observed passages", () => {
  const findings = {
    entityRules: [],
    powers: [
      {
        name: "Accelerated healing",
        aliases: [],
        summary: "Generic healing summary",
        details: [],
        relationships: [],
        factionMemberships: [],
        evidence: [evidence("00000000-0000-4000-8000-000000000097")],
        confidence: 0.7,
        reviewStatus: "candidate",
      },
      {
        name: "Neural resuscitation",
        aliases: [],
        summary: "Generic resuscitation summary",
        details: [],
        relationships: [],
        factionMemberships: [],
        evidence: [evidence("00000000-0000-4000-8000-000000000098")],
        confidence: 0.7,
        reviewStatus: "candidate",
      },
    ],
  } as unknown as WorldFindings;

  normalizeCompiledRules(findings);

  const healing = findings.powers.find((candidate) => candidate.name === "Accelerated healing");
  assert.match(healing?.summary ?? "", /general Turned baseline|Turned can heal severe damage within hours/u);
  assert.deepEqual(healing?.evidence.map((item) => item.chunkId), [
    "fa08c73c-51a4-4e86-8336-9c35ff0231fd",
  ]);

  const resuscitation = findings.powers.find((candidate) => candidate.name === "Neural resuscitation");
  assert.match(resuscitation?.summary ?? "", /stopped heartbeat resumes/u);
  assert.deepEqual(resuscitation?.evidence.map((item) => item.chunkId), [
    "b4529385-e6e4-4ed6-ab83-ec04c3c56ff4",
    "cb9a70f2-e298-4d40-b9d0-240dcf3eeac9",
    "cb9a70f2-e298-4d40-b9d0-240dcf3eeac9",
  ]);

  const regeneration = findings.powers.find((candidate) => candidate.name === "Rapid regeneration");
  assert.match(regeneration?.details?.join(" ") ?? "", /literal immortality remains Alec's own assessment/u);
  assert.deepEqual(regeneration?.evidence.map((item) => item.chunkId), [
    "d89c40ae-e1ef-464f-b475-2a5477196acd",
    "43c5bf25-bcb5-4e21-8249-93fabc70c682",
    "e53626d1-3d90-4ccd-92d4-6766fad70a6d",
  ]);
});

test("compiled dossier relationship targets use canonical cards", () => {
  const findings = {
    characters: [{
      relationshipWeb: [
        { name: "Molly / Shanta" },
        { name: "Michael's Vit" },
        { name: "Karagorn mentor" },
        { name: "Sanctuary Turncoats" },
        { name: "Alec's town" },
      ],
    }],
  } as unknown as WorldFindings;

  normalizeCompiledRelationshipWeb(findings);

  assert.deepEqual(findings.characters[0]?.relationshipWeb.map((item) => item.name), [
    "Shanta",
    "Michael's replacement Vit",
    "Karagorn",
    "Sanctuary survivors",
    "Alec's town community",
  ]);
});

test("compiled dossiers retain only uniquely resolvable evidence-backed power cards", () => {
  const power = (name: string, aliases: string[] = []) => ({
    name,
    aliases,
    summary: `${name} summary`,
    details: [],
    relationships: [],
    factionMemberships: [],
    evidence: [evidence(`power-${name}`)],
    confidence: 0.9,
    reviewStatus: "verified",
  });
  const character = (name: string, powers: string[], capabilities: string[] = []) => ({
    name,
    powers,
    capabilities,
    relationshipWeb: [],
  });
  const findings = {
    powers: [
      power("Hybrid transformation"),
      power("Telepathy"),
      power("Thermal vision"),
      power("Ultraviolet vision"),
      power("Superhuman strength"),
      power("Accelerated healing"),
      power("Rapid regeneration"),
      power("Partial shapeshifting"),
      power("Stored-host transformation"),
      power("Echo neurochemical control"),
      power("Mind Web"),
      power("Changeling mimicry", ["Changeling transformation"]),
    ],
    characters: [
      character("Alec Sumner", [
        "Accelerated healing",
        "enhanced senses",
        "extreme physical force",
        "constellation-pattern allegiance response",
      ]),
      character("Echo", [
        "Accelerated healing",
        "regeneration",
        "neurochemical modulation",
        "transformation",
        "enhanced perception",
      ]),
      character("Ragger", [
        "multi-host shapeshifting",
        "psychic intrusion",
        "genetic memory",
        "acid projection",
        "rapid growth and combat transformation",
        "enhanced senses",
      ], ["acid projection"]),
      character("Geela", ["Matriarch physiology", "extreme strength"]),
      character("Michael", [
        "Thrall transformation",
        "extreme strength",
        "rapid healing",
        "partial human/alien form",
        "imperial psychic-network access through affiliation",
      ]),
      character("Shanta", ["Telepathy", "neural activity sensing"]),
      character("Marlene's Changeling successor", [
        "Reaver transformation",
        "telepathic sensing",
      ]),
      character("Molly", [
        "Changeling transformation",
        "Changeling transformation through Shanta",
        "Mind Web access through Shanta",
      ]),
      character("Kondura", ["partial transformation"]),
    ],
  } as unknown as WorldFindings;

  reconcileCompiledDossierPowers(findings);

  const powersByCharacter = new Map(
    findings.characters.map((item) => [item.name, item.powers]),
  );
  assert.deepEqual(powersByCharacter.get("Alec Sumner"), [
    "Thermal vision",
    "Ultraviolet vision",
    "Superhuman strength",
  ]);
  assert.deepEqual(powersByCharacter.get("Echo"), [
    "Rapid regeneration",
    "Echo neurochemical control",
    "Hybrid transformation",
    "Thermal vision",
    "Ultraviolet vision",
  ]);
  assert.deepEqual(powersByCharacter.get("Ragger"), ["Stored-host transformation"]);
  assert.deepEqual(powersByCharacter.get("Geela"), []);
  assert.deepEqual(powersByCharacter.get("Michael"), []);
  assert.deepEqual(powersByCharacter.get("Shanta"), ["Mind Web"]);
  assert.deepEqual(
    powersByCharacter.get("Marlene's Changeling successor"),
    ["Changeling mimicry"],
  );
  assert.deepEqual(powersByCharacter.get("Molly"), [
    "Changeling mimicry",
    "Mind Web",
  ]);
  assert.deepEqual(powersByCharacter.get("Kondura"), ["Changeling mimicry"]);
  assert.deepEqual(findings.characters.find((item) => item.name === "Ragger")?.capabilities, [
    "acid projection",
  ]);

  const canonicalNames = new Set(findings.powers.map((item) => item.name));
  assert.equal(
    findings.characters.every((item) => item.powers.every((itemPower) => canonicalNames.has(itemPower))),
    true,
  );
});

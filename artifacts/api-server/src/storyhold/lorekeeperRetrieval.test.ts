import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCanonicalEntityPackets,
  contextualSourceExcerpt,
  resolveSceneEntityFrame,
  selectCanonicalHistory,
  selectDiverseSourceEvidence,
} from "./lorekeeperRetrieval";

test("scene entity resolution prefers canonical aliases and expands bounded graph paths", () => {
  const frame = resolveSceneEntityFrame([
    {
      id: "ragger",
      name: "Ragger",
      aliases: ["Anubis", "Anubsika", "The Old Dog"],
      entity_links: [
        {
          otherEntityId: "sanctuary",
          otherName: "Sanctuary",
          relationType: "member_of",
          status: "current",
        },
        { otherName: "Geela", relationType: "ally_of" },
      ],
    },
    {
      id: "sanctuary",
      name: "Sanctuary",
      aliases: [],
      entity_links: [
        { otherEntityId: "ragger", otherName: "Ragger", relationType: "has_member" },
        { otherEntityId: "council", otherName: "Sanctuary Council", relationType: "governed_by" },
      ],
    },
    {
      id: "council",
      name: "Sanctuary Council",
      aliases: [],
      entity_links: [
        { otherEntityId: "sanctuary", otherName: "Sanctuary", relationType: "governs" },
        { otherEntityId: "remote", otherName: "Remote Outpost", relationType: "oversees" },
      ],
    },
    { id: "remote", name: "Remote Outpost", aliases: [], entity_links: [] },
  ], "I ask Anubis what he remembers about the old war.");
  assert.deepEqual(frame.matchedEntityIds, ["ragger"]);
  assert.deepEqual(frame.matchedNames, ["Ragger"]);
  assert.deepEqual(frame.graphNeighborNames, ["Sanctuary", "Geela"]);
  assert.deepEqual(frame.multiHopNames, ["Sanctuary Council"]);
  assert.equal(frame.multiHopNames.includes("Remote Outpost"), false);
  assert.deepEqual(frame.graphPaths[0], {
    entityId: "sanctuary",
    name: "Sanctuary",
    depth: 1,
    viaEntityId: "ragger",
    viaName: "Ragger",
    relationType: "member_of",
    relationStatus: "current",
  });
  assert.equal(frame.expandedTerms.includes("The Old Dog"), true);
  assert.equal(frame.expandedTerms.includes("Sanctuary Council"), true);
});

test("scene graph expansion can be restricted to direct neighbors", () => {
  const frame = resolveSceneEntityFrame([
    {
      id: "alec",
      name: "Alec Sumner",
      aliases: ["Alec"],
      entity_links: [{ otherEntityId: "sanctuary", otherName: "Sanctuary" }],
    },
    {
      id: "sanctuary",
      name: "Sanctuary",
      aliases: [],
      entity_links: [{ otherEntityId: "council", otherName: "Sanctuary Council" }],
    },
    { id: "council", name: "Sanctuary Council", aliases: [], entity_links: [] },
  ], "Alec checks the gate", { maximumDepth: 1 });
  assert.deepEqual(frame.graphNeighborNames, ["Sanctuary"]);
  assert.deepEqual(frame.multiHopNames, []);
});

test("whole-pool selection preserves canonical coverage and source diversity", () => {
  const rows = [
    ...Array.from({ length: 80 }, (_, index) => ({
      id: `town-${index}`,
      source_title: "Book One",
      content: `Alec walked through Sanctuary. The same repeated town sentence ${index}.`,
    })),
    {
      id: "ragger-proof",
      source_title: "Book Two",
      content: "The Old Dog turned. Ragger admitted that Anubsika was a name he had carried.",
    },
    {
      id: "geela-proof",
      source_title: "Book Two",
      content: "Geela gathered the Turncoats outside Sanctuary and warned Ragger.",
    },
  ];
  const selected = selectDiverseSourceEvidence({
    rows,
    query: "Ask Ragger about Anubsika in Sanctuary",
    entityTerms: ["Ragger", "Anubsika", "Sanctuary", "Geela"],
    maximum: 12,
  });
  assert.equal(selected.candidateCount, 82);
  assert.equal(selected.selected.length, 12);
  assert.equal(selected.selected.some((row) => row.id === "ragger-proof"), true);
  assert.equal(selected.selected.some((row) => row.id === "geela-proof"), true);
  assert.deepEqual(selected.missingCoverageTerms, []);
  assert.equal(selected.selected.every((row) => String(row.retrieval_excerpt).length <= 905), true);
});

test("contextual excerpts center the relevant evidence instead of sending a blind prefix", () => {
  const content = `${"Unrelated opening sentence. ".repeat(80)}Ragger named Sanctuary and explained the old vigil. ${"Unrelated ending. ".repeat(40)}`;
  const excerpt = contextualSourceExcerpt(content, "Ragger vigil", ["Sanctuary"], 500);
  assert.match(excerpt, /Ragger named Sanctuary/);
  assert.equal(excerpt.length < content.length, true);
});

test("canonical packets unify dossier, graph, rules, and temporal claims without duplicate links", () => {
  const packets = buildCanonicalEntityPackets({
    entities: [{
      id: "alec",
      canonical_key: "character-alec",
      entity_type: "character",
      name: "Alec Sumner",
      aliases: ["Alec"],
      summary: "Fallback summary",
      details: ["Lives in Sanctuary"],
      faction_memberships: [{ name: "Sanctuary" }],
      entity_links: [{ relationType: "has_form", otherEntityId: "hybrid", otherName: "Hybrid" }, {
        relationType: "has_form", otherEntityId: "hybrid", otherName: "Hybrid",
      }],
      entity_rules: [{ name: "Rapid regeneration", effect: "Repairs severe wounds" }],
    }],
    dossiers: [{
      id: "alec",
      name: "Alec Sumner",
      role: "Founder of Sanctuary",
      summary: "Canonical dossier summary",
      profile: { powers: ["Rapid regeneration"], relationships: ["Echo — chosen family"] },
    }],
    claims: [{
      id: "current",
      subject_entity_id: "alec",
      subject_name: "Alec Sumner",
      predicate: "lives_in",
      object_text: "Sanctuary",
      truth_status: "fact",
      claim_status: "active",
      valid_until_label: "",
    }, {
      id: "old",
      subject_entity_id: "alec",
      subject_name: "Alec Sumner",
      predicate: "lived_in",
      object_text: "North Carolina",
      truth_status: "fact",
      claim_status: "superseded",
      valid_until_label: "After Starfall",
    }],
    matchedEntityIds: ["alec"],
    graphPaths: [],
    maximumCharacters: 8_000,
  });

  assert.equal(packets.length, 1);
  assert.equal(packets[0]?.priority, "direct");
  assert.equal(packets[0]?.summary, "Canonical dossier summary");
  assert.equal(packets[0]?.links.length, 1);
  assert.deepEqual(packets[0]?.claims.map((claim) => claim.temporalState), [
    "current",
    "historical",
  ]);
});

test("locked canon history prioritizes participant-matched causes without changing chronology", () => {
  const selected = selectCanonicalHistory({
    rows: [
      {
        event_id: "recent-unrelated",
        title: "A recent unrelated celebration",
        summary: "The settlement celebrates.",
        chronology_order: 3000,
        participant_entity_ids: ["someone-else"],
      },
      {
        event_id: "ragger-origin",
        title: "The Old Dog begins his vigil",
        summary: "Ragger prepares humanity through myth and dreams.",
        chronology_order: 1000,
        participant_entity_ids: ["ragger"],
        causal_links: [{ relationType: "enables", targetTitle: "Humanity survives" }],
      },
      {
        event_id: "middle",
        title: "Alec reaches Sanctuary",
        summary: "Alec enters the town.",
        chronology_order: 2000,
        participant_entity_ids: ["alec"],
      },
    ],
    query: "Ask Anubis what he did before the invasion",
    entityIds: ["ragger"],
    maximum: 2,
  });
  assert.equal(selected.some((event) => event.event_id === "ragger-origin"), true);
  assert.deepEqual(
    selected.map((event) => event.chronology_order),
    [...selected.map((event) => event.chronology_order)].sort((a, b) => Number(a) - Number(b)),
  );
});

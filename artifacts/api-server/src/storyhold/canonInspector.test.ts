import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { buildCanonInspectionPairs, inspectGeneratedNarration } from "./canonInspector";

test("a failed local narration read stays failed with private diagnostics and no repeated segments", async (t) => {
  const previous = { ...process.env };
  t.after(() => { process.env = previous; });
  process.env.STORYHOLD_LOCAL_GLINER2_ENABLED = "true";
  process.env.STORYHOLD_LOCAL_GLINER2_URL = "http://127.0.0.1:8765/gliner2";
  process.env.STORYHOLD_LOCAL_NLI_ENABLED = "false";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return Response.json({ error: "GLiNER worker could not load its model." }, { status: 503 });
  });
  const inspection = await inspectGeneratedNarration({
    narration: "Mara watches the harbor. ".repeat(160), sceneSummary: "Mara waits.",
    direction: {}, worldClaims: [], campaignFacts: [], entities: [],
  });
  assert.equal(calls, 1);
  assert.equal(inspection.status, "failed");
  assert.equal(inspection.glinerStatus, "failed");
  assert.ok(inspection.localRead!.receipt.unprocessedSegments! > 0);
  assert.match(inspection.errors!.join(" "), /could not load/);
});

test("one bounded narration read still runs NLI and rejects contradictions or incomplete comparisons", async (t) => {
  const previous = { ...process.env };
  t.after(() => { process.env = previous; });
  let extractionCalls = 0;
  let returnComparison = true;
  const deadlines: number[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      const payload = JSON.parse(body);
      deadlines.push(payload.deadlineUnixMs);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ results: returnComparison
        ? payload.pairs.map((pair: { id: string }) => ({ id: pair.id, contradiction: 0.95, entailment: 0.01, neutral: 0.04 }))
        : [],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  process.env.STORYHOLD_LOCAL_GLINER2_ENABLED = "true";
  process.env.STORYHOLD_LOCAL_GLINER2_URL = "http://127.0.0.1:8765/gliner2";
  process.env.STORYHOLD_LOCAL_NLI_ENABLED = "true";
  process.env.STORYHOLD_LOCAL_NLI_URL = `http://127.0.0.1:${address.port}/nli`;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    extractionCalls += 1;
    const payload = JSON.parse(String(options.body));
    deadlines.push(payload.deadlineUnixMs);
    assert.equal(payload.requireLoaded, undefined, "The full narration check may load its required model.");
    return Response.json({ signals: [{ signalType: "story_claim", fields: {
      subject: ["Mara"], predicate: ["is"], object: ["dead"], truth_mode: ["fact"],
    } }] });
  });
  const params = {
    narration: "Mara is dead.", sceneSummary: "The harbor is silent.", direction: {},
    worldClaims: [{ id: "claim", subject_name: "Mara", predicate: "is", object_text: "alive", truth_status: "fact", claim_status: "active" }],
    campaignFacts: [], entities: [{ name: "Mara", aliases: [] }],
  };
  const inspection = await inspectGeneratedNarration(params);
  assert.equal(extractionCalls, 1);
  assert.equal(inspection.status, "violations");
  assert.equal(inspection.testedPairCount, 1);
  assert.equal(deadlines.length, 2);
  assert.equal(deadlines[0], deadlines[1]);
  returnComparison = false;
  const incomplete = await inspectGeneratedNarration(params);
  assert.equal(incomplete.status, "failed");
  assert.match(incomplete.errors!.join(" "), /every requested comparison/);
});

test("canon inspection compares an objective generated claim to a negative atomic fact", () => {
  const built = buildCanonInspectionPairs({
    generatedClaims: [{
      subject: "Marcus",
      predicate: "is",
      object: "Veyra's father",
      statement: "Marcus is Veyra's father",
    }],
    worldClaims: [{
      id: "claim-one",
      subject_name: "Marcus",
      predicate: "is not",
      object_text: "Veyra's father",
      truth_status: "fact",
      claim_status: "active",
    }],
    campaignFacts: [],
    entities: [{ name: "Marcus", aliases: ["Dad"] }],
  });
  assert.equal(built.pairs.length, 1);
  assert.equal(built.pairs[0]?.premise, "Marcus is not Veyra's father");
  assert.equal(built.pairs[0]?.hypothesis, "Marcus is Veyra's father");
});

test("a vague adjacent Direction state change cannot authorize a canon contradiction", () => {
  const built = buildCanonInspectionPairs({
    generatedClaims: [{
      subject: "Marcus",
      predicate: "is located at",
      object: "the vault",
      statement: "Marcus is located at the vault",
    }],
    worldClaims: [{
      id: "10000000-0000-4000-8000-000000000001",
      subject_name: "Marcus",
      predicate: "is located at",
      object_text: "the harbor",
      truth_status: "fact",
      claim_status: "active",
    }],
    campaignFacts: [],
    entities: [{ name: "Marcus", aliases: [] }],
    direction: {
      stateChanges: [{ subject: "Marcus", facts: ["Marcus reaches the vault"] }],
    },
  });
  assert.equal(built.pairs.length, 1);
});

test("an adjacent Direction proposition cannot authorize a canon contradiction", () => {
  const claimId = "10000000-0000-4000-8000-000000000001";
  const built = buildCanonInspectionPairs({
    generatedClaims: [{
      subject: "Marcus",
      predicate: "is located at",
      object: "the vault",
      statement: "Marcus is located at the vault",
    }],
    worldClaims: [{
      id: claimId,
      subject_name: "Marcus",
      predicate: "is located at",
      object_text: "the harbor",
      truth_status: "fact",
      claim_status: "active",
    }],
    campaignFacts: [],
    entities: [{ name: "Marcus", aliases: [] }],
    direction: {
      propositions: [{
        layer: "reality",
        subject: "Marcus",
        predicate: "travels toward",
        object: "the vault",
        stance: "affirmed",
        supersedesPropositionId: claimId,
        causalBasis: ["Marcus followed the player."],
      }],
    },
  });
  assert.equal(built.pairs.length, 1);
});

test("an exact causal Direction supersession authorizes only its targeted conflict", () => {
  const claimId = "10000000-0000-4000-8000-000000000001";
  const otherClaimId = "10000000-0000-4000-8000-000000000002";
  const built = buildCanonInspectionPairs({
    generatedClaims: [{
      subject: "Marcus",
      predicate: "is located at",
      object: "the vault",
      statement: "Marcus is located at the vault",
    }],
    worldClaims: [{
      id: claimId,
      subject_name: "Marcus",
      predicate: "is located at",
      object_text: "the harbor",
      truth_status: "fact",
      claim_status: "active",
    }, {
      id: otherClaimId,
      subject_name: "Marcus",
      predicate: "serves",
      object_text: "the Harbor Watch",
      truth_status: "fact",
      claim_status: "active",
    }],
    campaignFacts: [],
    entities: [{ name: "Marcus", aliases: [] }],
    direction: {
      propositions: [{
        layer: "reality",
        subject: "Marcus",
        predicate: "is located at",
        object: "the vault",
        stance: "affirmed",
        supersedesPropositionId: claimId,
        causalBasis: ["Marcus followed the player from the harbor to the vault."],
      }],
    },
  });
  assert.equal(built.pairs.length, 1);
  assert.match(built.pairs[0]?.id ?? "", new RegExp(`^${otherClaimId}:`));
});

test("a nominal supersession without causal basis remains subject to canon inspection", () => {
  const claimId = "10000000-0000-4000-8000-000000000001";
  const built = buildCanonInspectionPairs({
    generatedClaims: [{
      subject: "Marcus",
      predicate: "is located at",
      object: "the vault",
      statement: "Marcus is located at the vault",
    }],
    worldClaims: [{
      id: claimId,
      subject_name: "Marcus",
      predicate: "is located at",
      object_text: "the harbor",
      truth_status: "fact",
      claim_status: "active",
    }],
    campaignFacts: [],
    entities: [{ name: "Marcus", aliases: [] }],
    direction: {
      propositions: [{
        layer: "reality",
        subject: "Marcus",
        predicate: "is located at",
        object: "the vault",
        stance: "affirmed",
        supersedesPropositionId: claimId,
        causalBasis: [],
      }],
    },
  });
  assert.equal(built.pairs.length, 1);
});

test("a non-affirmed Direction proposition cannot authorize affirmative narration", () => {
  const claimId = "10000000-0000-4000-8000-000000000001";
  const built = buildCanonInspectionPairs({
    generatedClaims: [{
      subject: "Marcus",
      predicate: "is located at",
      object: "the vault",
      statement: "Marcus is located at the vault",
    }],
    worldClaims: [{
      id: claimId,
      subject_name: "Marcus",
      predicate: "is located at",
      object_text: "the harbor",
      truth_status: "fact",
      claim_status: "active",
    }],
    campaignFacts: [],
    entities: [{ name: "Marcus", aliases: [] }],
    direction: {
      propositions: [{
        layer: "reality",
        subject: "Marcus",
        predicate: "is located at",
        object: "the vault",
        stance: "uncertain",
        supersedesPropositionId: claimId,
        causalBasis: ["Marcus may have followed the player."],
      }],
    },
  });
  assert.equal(built.pairs.length, 1);
});

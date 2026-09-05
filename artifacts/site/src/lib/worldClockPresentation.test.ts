import assert from "node:assert/strict";
import test from "node:test";
import type { WorldClockEvent } from "./storyholdApi";
import {
  worldClockEventsForPresentation,
  worldClockTruthLabel,
} from "./worldClockPresentation";

test("presents truth-aware World Clock states without backend terminology", () => {
  const baseline = { knowledgeStatus: "inferred" as const };

  assert.equal(worldClockTruthLabel({ ...baseline, truthStatus: "fact" }), "Established");
  assert.equal(
    worldClockTruthLabel({ ...baseline, truthStatus: "belief", epistemicHolderName: "Addison Gray" }),
    "Believed by Addison Gray",
  );
  assert.equal(
    worldClockTruthLabel({ ...baseline, truthStatus: "belief", epistemicHolderName: "  " }),
    "Belief",
  );
  assert.equal(worldClockTruthLabel({ ...baseline, truthStatus: "rumor" }), "Rumor");
  assert.equal(worldClockTruthLabel({ ...baseline, truthStatus: "lie" }), "Known Falsehood");
  assert.equal(worldClockTruthLabel({ ...baseline, truthStatus: "disputed" }), "Disputed");
  assert.equal(worldClockTruthLabel({ ...baseline, truthStatus: "unknown" }), "Unresolved");
});

test("presents legacy World Clock states conservatively", () => {
  assert.equal(worldClockTruthLabel({ knowledgeStatus: "observed" }), "Observed");
  assert.equal(worldClockTruthLabel({ knowledgeStatus: "revealed" }), "Revealed");
  assert.equal(worldClockTruthLabel({ knowledgeStatus: "told" }), "Reported");
  assert.equal(worldClockTruthLabel({ knowledgeStatus: "disputed" }), "Disputed");
  assert.equal(worldClockTruthLabel({ knowledgeStatus: "inferred" }), "Unresolved");
});

function event(overrides: Partial<WorldClockEvent> = {}): WorldClockEvent {
  return {
    id: "event-1",
    canonicalKey: "event-1",
    campaignId: null,
    sourceId: null,
    causalParentId: null,
    eventKind: "canon",
    title: "The Gate Opens",
    summary: "The expedition enters the structure.",
    worldTimeLabel: "First descent",
    chronologyOrder: 1000,
    visibility: "world",
    knowledgeStatus: "observed",
    knownEffects: [],
    evidence: [],
    scheduledForLabel: "",
    status: "committed",
    createdAt: "2026-09-04T00:00:00.000Z",
    ...overrides,
  };
}

test("only API-saved clock rows enter the timeline, never breakdown fallbacks", () => {
  const input = {
    worldClockEvents: [event({ id: "later", chronologyOrder: 2000 }), event({ id: "earlier", chronologyOrder: 1000 })],
    breakdown: {
      chronology: [{ name: "Withheld Guess", summary: "Must not reappear through a client fallback." }],
    },
  };

  assert.deepEqual(
    worldClockEventsForPresentation(input).map((item) => item.id),
    ["earlier", "later"],
  );
  assert.doesNotMatch(
    JSON.stringify(worldClockEventsForPresentation({ ...input, worldClockEvents: [] })),
    /Withheld Guess/u,
  );
});

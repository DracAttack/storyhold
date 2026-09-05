import assert from "node:assert/strict";
import test from "node:test";
import {
  campaignStartAnchor,
  campaignStartChoices,
  defaultCampaignStartChoice,
} from "./campaignStarts";
import type { WorldDetail } from "./storyholdApi";

test("campaign starts keep the central objective at earned distance", () => {
  const detail = {
    world: {
      premise: "A survey team enters an ancient structure to recover a specimen.",
      description: "",
      worldContract: { premise: "A survey team enters an ancient structure." },
    },
    worldClockEvents: [
      {
        id: "ancient-clock",
        eventKind: "canon",
        status: "committed",
        importance: "turning_point",
        title: "The ancient origin",
        summary: "An event long before the current story.",
        worldTimeLabel: "Ten thousand years before Book Two present",
        chronologyOrder: 0,
      },
      {
        id: "clock-one",
        eventKind: "canon",
        status: "committed",
        importance: "turning_point",
        title: "The first recovery",
        summary: "The team eventually locates and removes its first viable egg.",
        worldTimeLabel: "Present-day expedition",
        chronologyOrder: 10,
      },
    ],
  } as unknown as WorldDetail;
  const choices = campaignStartChoices(detail);
  assert.ok(choices.length >= 3);
  assert.match(choices.find((choice) => choice.id === "slow-burn")!.value, /central objective distant/i);
  const eve = choices.find((choice) => choice.id.startsWith("eve-"))!;
  assert.match(eve.value, /not at the campaign's solution/i);
  assert.match(eve.value, /no foreknowledge/i);
  assert.doesNotMatch(eve.value, /first recovery|egg|eventually locates/i);
  assert.match(choices.find((choice) => choice.id.startsWith("eve-"))!.label, /first recovery/i);
  assert.equal(choices.find((choice) => choice.id.startsWith("eve-"))!.canonAnchorEventId, "clock-one");
  assert.equal(choices.find((choice) => choice.id.startsWith("eve-"))!.canonAnchorMode, "before");
  assert.equal(defaultCampaignStartChoice(choices)?.id, "canon-frontier");
  assert.deepEqual(campaignStartAnchor(choices, "canon-frontier"), {
    canonAnchorEventId: "clock-one",
    canonAnchorMode: "after",
  });
  for (const choice of choices.filter((choice) => !choice.id.startsWith("eve-"))) {
    assert.equal(choice.canonAnchorEventId, "clock-one");
    assert.equal(choice.canonAnchorMode, "after");
  }
});

test("canon-frontier starts lock history through the latest known event", () => {
  const choices = campaignStartChoices({
    world: { premise: "A frontier story", description: "", worldContract: {} },
    worldClockEvents: [{
      id: "last-event",
      eventKind: "canon",
      status: "committed",
      importance: "major",
      title: "The known frontier",
      summary: "The latest established event.",
      worldTimeLabel: "After the journey",
      chronologyOrder: 42,
    }],
  } as unknown as WorldDetail);
  const frontier = choices.find((choice) => choice.id === "canon-frontier")!;
  assert.equal(frontier.canonAnchorEventId, "last-event");
  assert.equal(frontier.canonAnchorMode, "after");
});

test("launch choices never anchor to a non-canon event", () => {
  const choices = campaignStartChoices({
    world: { premise: "A frontier story", description: "", worldContract: {} },
    worldClockEvents: [
      {
        id: "canon-event",
        campaignId: null,
        eventKind: "canon",
        visibility: "world",
        status: "committed",
        title: "The Last Established Chapter",
        summary: "The source ends here.",
        worldTimeLabel: "Book present",
        chronologyOrder: 20,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "scheduled-effect",
        campaignId: null,
        eventKind: "scheduled_effect",
        visibility: "world",
        status: "scheduled",
        title: "A Future Consequence",
        summary: "This is not established manuscript history.",
        worldTimeLabel: "Later",
        chronologyOrder: 99,
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    ],
  } as unknown as WorldDetail);
  assert.equal(
    defaultCampaignStartChoice(choices)?.canonAnchorEventId,
    "canon-event",
  );
  assert.ok(choices.every((choice) => choice.canonAnchorEventId !== "scheduled-effect"));
});

test("an edited starting frame retains the selected immutable canon anchor", () => {
  const choices = campaignStartChoices({
    world: { premise: "A frontier story", description: "", worldContract: {} },
    worldClockEvents: [{
      id: "locked-event",
      eventKind: "canon",
      status: "committed",
      importance: "major",
      title: "The locked boundary",
      summary: "Knowledge after this point must not leak.",
      worldTimeLabel: "Present-day expedition",
      chronologyOrder: 12,
    }],
  } as unknown as WorldDetail);
  const selected = choices.find((choice) => choice.id === "eve-locked-event")!;

  // The editable prose no longer equals selected.value, but the selection ID
  // remains stable and therefore so does the server-enforced canon boundary.
  const editedProse = "Begin three streets away, with no idea what is coming.";
  assert.notEqual(editedProse, selected.value);
  assert.deepEqual(campaignStartAnchor(choices, selected.id), {
    canonAnchorEventId: "locked-event",
    canonAnchorMode: "before",
  });
  assert.deepEqual(campaignStartAnchor(choices, "character-first"), {
    canonAnchorEventId: "locked-event",
    canonAnchorMode: "after",
  });
});

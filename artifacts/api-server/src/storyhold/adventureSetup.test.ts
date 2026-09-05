import assert from "node:assert/strict";
import test from "node:test";
import {
  AdventureSetupValidationError,
  buildAdventureSetupPrompt,
  buildDeterministicAdventureSetupPlan,
  validateAdventureSetupPlan,
  type AdventureSetupContext,
  type AdventureSetupPlan,
} from "./adventureSetup";

function context(overrides: Partial<AdventureSetupContext> = {}): AdventureSetupContext {
  return {
    campaign: { id: "campaign-original", name: "Lunch Rush", origin: "original", premise: "A comic lunch shift at a struggling taco stand." },
    lockedStart: "The player arrives at the taco stand before its first customer.",
    currentMinute: 0,
    currentTurnNumber: 0,
    existingSummary: "",
    recentTurns: [],
    ...overrides,
  };
}

function plan(): AdventureSetupPlan {
  return {
    publicOpening: "A line forms outside the taco stand. Jo points at a blank specials board as the first customer taps a coin against the counter.",
    locationName: "The taco stand",
    visibleObjective: { key: "serve_lunch", title: "Get lunch service ready", description: "Choose a workable menu and prepare the stand for its waiting customers.", target: 3 },
    cast: [
      { key: "jo", name: "Jo", role: "Shift cook", presence: "present", publicSummary: "Jo checks the nearly empty specials board.", privateMotivation: "Jo hopes a successful shift will earn a transfer to pastry school." },
      { key: "ren", name: "Ren", role: "Delivery rider", presence: "unmet", publicSummary: "Ren waits beside two unmarked supply crates.", privateMotivation: "Ren wants to finish this delivery before a secret amateur juggling audition." },
    ],
    secrets: [{ key: "missing_labels", truth: "The purple receipt hides the mayor's ceremonial pineapple reservation.", clues: ["One receipt has an unusual purple border.", "A reserved tray has a pineapple-shaped outline."], discoverableVia: ["Compare the delivery slips with the tray labels."] }],
    pressures: [
      { key: "queue", title: "The lunch queue", privateSummary: "The waiting lunch crowd may choose another stand unless someone explains the delay.", observableConsequence: "Customers begin comparing the neighboring stand's menu.", clueOpportunities: ["A waiting customer can describe which menu item drew the crowd."], maturesAfterMinutes: 15, objectiveKey: "serve_lunch" },
      { key: "ice", title: "The cooling crates", privateSummary: "The delivery ice is thinning and someone needs to find a suitable cooler.", observableConsequence: "A small puddle starts spreading beneath a supply crate.", clueOpportunities: ["Moving the crate makes its previously obscured delivery sticker accessible."], maturesAfterMinutes: 30, objectiveKey: "choose_supplies" },
    ],
    privateDirection: {
      premise: "Build a comic, low-stakes shift around practical compromises and a mislabeled special order.",
      goalSteps: [
        { key: "choose_supplies", title: "Decide what can be served", condition: "If the player investigates the available stock.", possibleNextStep: "They may simplify the menu, trade ingredients, or negotiate extra time." },
        { key: "special_order", title: "Decide what to do about the special order", condition: "Only if the player earns enough clues to recognize an unusual reservation.", possibleNextStep: "They may honor it, ask for help, or renegotiate it with the customer." },
      ],
      alternatePaths: ["If the player focuses on people, an honest explanation may buy time without solving the labeling puzzle.", "If the player prefers experimentation, a limited menu may support service while leaving the reservation unresolved."],
    },
  };
}

function rejects(proposed: unknown, snapshot = context(), expectedPath?: string): void {
  assert.throws(() => validateAdventureSetupPlan(proposed, snapshot), (error: unknown) => {
    assert.ok(error instanceof AdventureSetupValidationError);
    assert.equal(error.code, "INVALID_ADVENTURE_SETUP");
    if (expectedPath) assert.equal(error.path, expectedPath);
    return true;
  });
}

test("accepts a bounded original comedy setup without forced antagonists or mechanical changes", () => {
  const snapshot = context();
  const proposed = plan();
  const before = structuredClone({ snapshot, proposed });
  const validated = validateAdventureSetupPlan(proposed, snapshot);
  assert.deepEqual(validated, proposed);
  assert.notEqual(validated, proposed);
  assert.notEqual(validated.cast, proposed.cast);
  assert.deepEqual({ snapshot, proposed }, before);
});

test("deterministic recovery remains stable and passes the same strict validator", () => {
  const snapshot = context({
    requiresWorldFoundation: true,
    lockedStart: JSON.stringify({
      currentLocation: { name: "The taco stand" },
      trackedObjectives: [{
        status: "active",
        title: "Keep the lunch shift moving",
        description: "Respond to immediate problems without assuming success.",
        target: 4,
      }],
    }),
  });
  const first = buildDeterministicAdventureSetupPlan(snapshot);
  const second = buildDeterministicAdventureSetupPlan(snapshot);
  assert.deepEqual(first, second);
  assert.deepEqual(validateAdventureSetupPlan(first, snapshot), first);
  assert.equal(first.locationName, "The taco stand");
  assert.equal(first.visibleObjective.title, "Keep the lunch shift moving");
  assert.equal(first.visibleObjective.target, 4);
  assert.equal(first.worldFoundation?.broaderForces.length, 2);
});

test("deterministic recovery never adds opening narration to an existing campaign", () => {
  const snapshot = context({
    requiresWorldFoundation: true,
    currentTurnNumber: 1,
    existingSummary: "The player already made a choice.",
  });
  const recovered = buildDeterministicAdventureSetupPlan(snapshot);
  assert.equal(recovered.publicOpening, "");
});

test("new live foundations require identity secrecy and a world beyond the opening location", () => {
  const snapshot = context({ requiresWorldFoundation: true });
  rejects(plan(), snapshot, "worldFoundation");
  const proposed = plan();
  proposed.worldFoundation = {
    settingBaseline: "The taco stand is one ordinary workplace in a city shaped by work, food, and neighborhood life.",
    identitySecrecy: { status: "secret", truth: "The player character's unusual past is not public knowledge.", knownBy: ["the player character"], exposureStakes: "Evidence may change trust without forcing a fixed response." },
    broaderForces: [
      { key: "city_work", name: "City Work", summary: "Work and money shape daily choices.", relationshipToCampaign: "It can matter outside the lunch shift without taking over every scene." },
      { key: "food_network", name: "Food Network", summary: "Suppliers and customers connect distant neighborhoods.", relationshipToCampaign: "It offers potential routes to new scenes only when the player follows them." },
    ],
    unresolvedBackground: [
      { key: "past_question", question: "What changed before the shift?", currentTruth: "The answer is not established at the opening.", discoveryBoundary: "It needs evidence or a player-authored decision." },
      { key: "future_question", question: "Who else will notice the special order?", currentTruth: "No one is assigned to notice it yet.", discoveryBoundary: "A later interaction must create the connection." },
    ],
  };
  const accepted = validateAdventureSetupPlan(proposed, snapshot);
  assert.equal(accepted.worldFoundation?.identitySecrecy.status, "secret");
  assert.equal(accepted.worldFoundation?.broaderForces.length, 2);
  assert.equal(accepted.worldFoundation?.unresolvedBackground.length, 2);
});

test("an existing game receives private continuation planning but never new opening narration", () => {
  const snapshot = context({
    currentMinute: 12, currentTurnNumber: 1,
    existingSummary: "The player moved a crate into the cooler.",
    recentTurns: [{ turnNumber: 1, playerAction: "I move the crate.", narration: "The crate now sits inside the cooler." }],
    existingCast: [{ subject: "npc:saved-jo", name: "Jo", publicSummary: "The cook at the stand." }],
  });
  const proposed = plan();
  rejects(proposed, snapshot, "publicOpening");
  proposed.publicOpening = "";
  rejects(proposed, snapshot, "cast[0].existingSubject");
  proposed.cast[0]!.existingSubject = "npc:saved-jo";
  rejects(proposed, snapshot, "cast[0].publicSummary");
  proposed.cast[0]!.publicSummary = snapshot.existingCast![0]!.publicSummary;
  assert.equal(validateAdventureSetupPlan(proposed, snapshot).publicOpening, "");
  proposed.cast[0]!.existingSubject = "npc:invented-jo";
  rejects(proposed, snapshot, "cast[0].existingSubject");
});

test("imported campaigns and malformed frozen clocks are refused", () => {
  rejects(plan(), context({ campaign: { ...context().campaign, origin: "imported" } }), "context.campaign.origin");
  rejects(plan(), context({ currentMinute: -1 }), "context.currentMinute");
  rejects(plan(), context({ currentTurnNumber: 1.5 }), "context.currentTurnNumber");
  assert.throws(() => buildAdventureSetupPrompt(context({ campaign: { ...context().campaign, origin: "imported" } })), AdventureSetupValidationError);
});

test("rejects empty goals, empty openings, unusable goal chains, and duplicated clue paths", () => {
  const emptyGoal = plan();
  emptyGoal.visibleObjective.title = " \n ";
  rejects(emptyGoal, context(), "visibleObjective.title");
  const emptyOpening = plan();
  emptyOpening.publicOpening = "";
  rejects(emptyOpening, context(), "publicOpening");
  const shortChain = plan();
  shortChain.privateDirection.goalSteps = [];
  rejects(shortChain, context(), "privateDirection.goalSteps");
  const badClues = plan();
  badClues.secrets[0]!.clues = ["Purple receipt", "purple receipt!"];
  rejects(badClues, context(), "secrets[0].clues");
  const emptyCondition = plan();
  emptyCondition.privateDirection.goalSteps[0]!.condition = "";
  rejects(emptyCondition, context(), "privateDirection.goalSteps[0].condition");
  const menuEnding = plan();
  menuEnding.publicOpening = "The lights flicker above the counter. You may check the freezer, question Jo, or do something less predictable.";
  rejects(menuEnding, context(), "publicOpening");
});

test("pressure delays and objective targets use strict bounded integer numbers", () => {
  for (const delay of [-5, 0, 4, 121, 5.5, Number.NaN, Number.POSITIVE_INFINITY, "15"]) {
    const proposed = plan() as unknown as Record<string, unknown>;
    (proposed.pressures as Record<string, unknown>[])[0]!.maturesAfterMinutes = delay;
    rejects(proposed, context(), "pressures[0].maturesAfterMinutes");
  }
  for (const target of [0, 7, 1.5]) {
    const proposed = plan();
    proposed.visibleObjective.target = target;
    rejects(proposed, context(), "visibleObjective.target");
  }
  const boundary = plan();
  boundary.pressures[0]!.maturesAfterMinutes = 5;
  boundary.pressures[1]!.maturesAfterMinutes = 120;
  assert.equal(validateAdventureSetupPlan(boundary, context()).pressures.length, 2);
});

test("rejects dangling references, cross-kind duplicate keys, excess pressures, and unsupported rewards", () => {
  const dangling = plan();
  dangling.pressures[0]!.objectiveKey = "missing_goal";
  rejects(dangling, context(), "pressures[0].objectiveKey");
  const duplicate = plan();
  duplicate.secrets[0]!.key = duplicate.cast[0]!.key;
  rejects(duplicate, context(), "secrets[0].key");
  const excessive = plan();
  excessive.pressures.push({ ...excessive.pressures[0]!, key: "third" }, { ...excessive.pressures[0]!, key: "fourth" });
  rejects(excessive, context(), "pressures");
  rejects({ ...plan(), rewards: { xp: 50 } }, context(), "plan");
  const nested = plan();
  (nested.visibleObjective as unknown as Record<string, unknown>).completed = true;
  rejects(nested, context(), "visibleObjective");
});

test("literal private-state guard blocks copied secrets in openings and automatically revealing clues", () => {
  const proposed = plan();
  proposed.publicOpening += ` ${proposed.secrets[0]!.truth.toUpperCase()}`;
  rejects(proposed, context(), "publicOpening");
  const clue = plan();
  clue.pressures[0]!.observableConsequence = `Everyone reads the label: ${clue.secrets[0]!.truth}`;
  rejects(clue, context(), "pressures[0].observableConsequence");
  const motivation = plan();
  motivation.cast[0]!.publicSummary += ` ${motivation.cast[0]!.privateMotivation}`;
  rejects(motivation, context(), "cast[0].publicSummary");
  assert.throws(() => validateAdventureSetupPlan(proposed, context()), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /pineapple|mayor|reservation/iu);
    return true;
  });
});

test("prompt separates present private facts from contingent goals and includes authoritative saved evidence", () => {
  const snapshot = context({
    currentMinute: 10, currentTurnNumber: 1,
    existingSummary: "The last lime was traded, not retained.",
    recentTurns: [{ turnNumber: 1, playerAction: "Trade the lime.", narration: "The customer takes the lime and leaves." }],
  });
  const prompt = buildAdventureSetupPrompt(snapshot);
  assert.match(prompt, /CONTINUATION/u);
  assert.match(prompt, /publicOpening MUST be exactly an empty string/u);
  assert.match(prompt, /not future predictions/u);
  assert.match(prompt, /NOT facts that have happened/u);
  assert.match(prompt, /not automatic discovery/u);
  assert.match(prompt, /no required villain/u);
  assert.ok(prompt.includes(snapshot.existingSummary));
  assert.ok(prompt.includes(snapshot.recentTurns[0]!.narration));
  assert.ok(prompt.includes(snapshot.lockedStart));
});

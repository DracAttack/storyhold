import type { WorldDetail } from "./storyholdApi";

export type CampaignStartChoice = {
  id: string;
  eyebrow: string;
  label: string;
  description: string;
  value: string;
  canonAnchorEventId?: string;
  canonAnchorMode?: "before" | "after";
};

export type CampaignStartAnchor = Pick<
  CampaignStartChoice,
  "canonAnchorEventId" | "canonAnchorMode"
>;

export function defaultCampaignStartChoice(
  choices: readonly CampaignStartChoice[],
): CampaignStartChoice | undefined {
  return choices.find((choice) => choice.id === "canon-frontier") ??
    choices.find((choice) => Boolean(choice.canonAnchorEventId)) ??
    choices[0];
}

/**
 * Resolve the immutable canon boundary from the frame the owner selected, not
 * from its editable prose. Owners are explicitly allowed to rewrite a frame;
 * changing that wording must never widen the campaign's canon snapshot.
 */
export function campaignStartAnchor(
  choices: readonly CampaignStartChoice[],
  selectedChoiceId: string,
): CampaignStartAnchor {
  const selected = choices.find((choice) => choice.id === selectedChoiceId);
  return {
    canonAnchorEventId: selected?.canonAnchorEventId,
    canonAnchorMode: selected?.canonAnchorMode,
  };
}

function compact(value: string, max = 240) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1).trim()}…`;
}

/**
 * Owner-facing starting frames derived from existing canon. These cost no AI
 * credits and deliberately describe objective distance so a campaign does not
 * hand the player its central prize in the opening scene.
 */
export function campaignStartChoices(detail: WorldDetail): CampaignStartChoice[] {
  const contract = detail.world.worldContract;
  const choices: CampaignStartChoice[] = [];
  // The world detail route already excludes campaign-private events. Filter
  // the remaining list again by meaning so a reminder or scheduled effect can
  // never become a canon cutoff merely because it sorts last.
  const canonEvents = detail.worldClockEvents
    .filter((event) =>
      event.eventKind === "canon" &&
      event.status !== "scheduled" &&
      event.status !== "cancelled" &&
      event.status !== "superseded"
    )
    .slice()
    .sort((left, right) =>
      left.chronologyOrder - right.chronologyOrder ||
      (left.createdAt ?? "").localeCompare(right.createdAt ?? "")
    );
  const latestCanonEvent = canonEvents.at(-1);
  const currentCanonAnchor = latestCanonEvent
    ? {
        canonAnchorEventId: latestCanonEvent.id,
        canonAnchorMode: "after" as const,
      }
    : {};
  const premise = compact(contract?.premise || detail.world.premise || detail.world.description || "this world", 420);

  if (latestCanonEvent) {
    choices.push({
      id: "canon-frontier",
      eyebrow: "Current canon",
      label: "Continue beyond the known story",
      description: `Begin after ${latestCanonEvent.title}, with the established story preserved as history.`,
      value: `Continue after the latest established event inside this premise: ${premise} Open on a new local pressure, incomplete clue, or relationship complication. Preserve the known story as history, and do not immediately deliver the campaign's central objective, creature, artifact, answer, or antagonist.`,
      ...currentCanonAnchor,
    });
  }

  const presentEvent = canonEvents.find((item) => {
    const label = item.worldTimeLabel || "";
    return (
      /\b(present|current|reunion)\b/i.test(label) &&
      !/\bbefore\b[^.]{0,80}\bpresent\b|\b(?:thousand|millennia|years?)\b[^.]{0,40}\bbefore\b/i.test(label)
    );
  });
  if (presentEvent) {
    choices.push({
      id: `eve-${presentEvent.id}`,
      eyebrow: "Earlier in canon",
      label: `Begin before ${presentEvent.title}`,
      description: `Begin close enough to feel this event approaching, without giving the character knowledge they have not earned.`,
      // The owner can see which event they selected, but the locked prompt must
      // not preload its title or summary into a character who begins before it.
      // The server binds the actual cutoff by immutable event ID.
      value: "Begin at the last established point before the selected canonical event. Put the character near a local pressure, incomplete clue, or warning sign, not at the campaign's solution. Give the character no foreknowledge of the selected event. Let investigation, travel, danger, and relationships create the path forward.",
      canonAnchorEventId: presentEvent.id,
      canonAnchorMode: "before",
    });
  }

  const suggested = compact(contract?.startingPoint || "", 700);
  if (suggested) {
    choices.push({
      id: "suggested",
      eyebrow: "World default",
      label: "Use the suggested beginning",
      description: latestCanonEvent
        ? `${compact(suggested)} This uses everything through ${latestCanonEvent.title} as established history.`
        : compact(suggested),
      value: suggested,
      ...currentCanonAnchor,
    });
  }

  choices.push({
    id: "slow-burn",
    eyebrow: "Slow discovery",
    label: "Start small and let trouble gather",
    description: "Open on a concrete local problem, with room to meet people and understand the place before the larger threat closes in.",
    value: `Begin with a grounded, local problem inside this premise: ${premise} The character should have an immediate human-scale need, incomplete information, and several meaningful ways to proceed. Keep the campaign's central objective distant: do not reveal, locate, obtain, defeat, or resolve it in the opening scene unless the player explicitly earns that progress.`,
    ...currentCanonAnchor,
  });
  if (!latestCanonEvent) {
    choices.push({
      id: "canon-frontier",
      eyebrow: "Canon frontier",
      label: "Begin where the known story leaves room",
      description: "Start inside the established world without replaying ancient history or skipping straight to its largest answer.",
      value: `Begin at the current frontier of this established premise: ${premise} Preserve all known history, but open on a new local pressure, incomplete clue, or relationship complication. Do not replay an ancient turning point as the present, and do not immediately deliver the campaign's central objective, creature, artifact, answer, or antagonist.`,
    });
  }

  choices.push({
    id: "character-first",
    eyebrow: "Character drama",
    label: "Begin with a difficult personal choice",
    description: "Open with a relationship, obligation, or moral compromise that makes the world matter before the main plot accelerates.",
    value: `Begin inside this premise: ${premise} Center the opening on a difficult personal choice, strained relationship, duty, debt, or moral compromise. Let the larger plot emerge through consequences rather than arriving as an immediate quest reward. The central objective must remain several earned scenes away.`,
    ...currentCanonAnchor,
  });

  return choices.slice(0, 5);
}

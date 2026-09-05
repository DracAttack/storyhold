import type { WorldClockEvent } from "@/lib/storyholdApi";

type TruthPresentationEvent = Pick<
  WorldClockEvent,
  "truthStatus" | "epistemicHolderName" | "knowledgeStatus"
>;

/**
 * Translate the Clock's evidence state into language that belongs in a story
 * reference, never internal review or database terminology.
 */
export function worldClockTruthLabel(event: TruthPresentationEvent): string {
  const holderName = event.epistemicHolderName?.trim();

  switch (event.truthStatus) {
    case "fact":
      return "Established";
    case "belief":
      return holderName ? `Believed by ${holderName}` : "Belief";
    case "rumor":
      return "Rumor";
    case "lie":
      return "Known Falsehood";
    case "disputed":
      return "Disputed";
    case "unknown":
      return "Unresolved";
  }

  // Compatibility for worlds saved before truthStatus existed. Conservative
  // mappings preserve what the older record actually says without promoting
  // an observation or reveal into an established fact.
  switch (event.knowledgeStatus) {
    case "observed":
      return "Observed";
    case "revealed":
      return "Revealed";
    case "told":
      return "Reported";
    case "disputed":
      return "Disputed";
    case "inferred":
      return "Unresolved";
  }
}

/**
 * Prepare only saved World Clock rows returned by the API for display. The
 * manuscript breakdown and chapter guide are deliberately not timeline
 * fallbacks: they have not passed the event-by-event clock review, and a
 * withheld proposal must remain withheld rather than reappearing through a
 * looser client-side projection. Owner-authored saved events remain eligible.
 */
export function worldClockEventsForPresentation(input: {
  worldClockEvents?: WorldClockEvent[] | null;
}): WorldClockEvent[] {
  return (input.worldClockEvents ?? [])
    .map((event, index) => ({
      ...event,
      chronologyOrder: Number.isFinite(event.chronologyOrder)
        ? event.chronologyOrder
        : index * 1_000,
      temporalStatus: event.temporalStatus ?? ("relative" as const),
      importance: event.importance ?? ("major" as const),
      sourceChapterKeys: Array.isArray(event.sourceChapterKeys)
        ? event.sourceChapterKeys
        : [],
      knownEffects: Array.isArray(event.knownEffects) ? event.knownEffects : [],
      evidence: Array.isArray(event.evidence) ? event.evidence : [],
      scheduledForLabel: event.scheduledForLabel ?? "",
    }))
    .sort((left, right) => left.chronologyOrder - right.chronologyOrder);
}

import type { CanonInspection } from "./canonInspector";

/** Live play has one Director/narrator pipeline, independent of the intake model stack. */
export function campaignExecutionPolicy(manual = false) {
  return {
    mode: manual ? "manual" as const : "ai_led" as const,
    browserAssist: false as const,
    localInference: false as const,
  };
}

export const CAMPAIGN_RETRIEVAL_POLICY = "ai-led-lexical-canonical-v1";

/** An honest private receipt, not a claim that optional model validation passed. */
export function unrequestedCampaignSpecialistInspection(): CanonInspection & { reason: string } {
  return {
    status: "skipped",
    reason: "ai_led_live_play",
    candidateClaimCount: 0,
    testedPairCount: 0,
    violations: [],
    glinerStatus: "not_run",
    nli: { status: "disabled", model: "not_requested", pairCount: 0, elapsedMilliseconds: 0 },
    elapsedMilliseconds: 0,
    errors: [],
  };
}

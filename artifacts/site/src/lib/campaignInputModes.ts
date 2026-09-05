import type {
  CampaignExperienceMode,
  CampaignInputMode,
} from "./storyholdApi";

export type CampaignInputModeOption = {
  id: CampaignInputMode;
  label: string;
  helper: string;
  placeholder: string;
};

export const CAMPAIGN_INPUT_MODES: readonly CampaignInputModeOption[] = [
  {
    id: "action",
    label: "Action",
    helper: "Do or say something. Storyhold resolves only what is genuinely uncertain.",
    placeholder: "What do you do or say?",
  },
  {
    id: "question",
    label: "Question",
    helper: "Ask what your character notices, knows, or whether something uncertain is true.",
    placeholder: "What are you trying to learn or determine?",
  },
  {
    id: "event",
    label: "Event",
    helper: "Introduce an occurrence. Storyhold tests it against the locked world and current state.",
    placeholder: "What happens, or what event enters the scene?",
  },
];

/**
 * Author play may introduce events directly. Solo play may act and investigate,
 * but cannot author an outcome simply by choosing a different input tab.
 */
export function campaignInputModes(
  experienceMode: CampaignExperienceMode,
): readonly CampaignInputModeOption[] {
  return experienceMode === "author"
    ? CAMPAIGN_INPUT_MODES
    : CAMPAIGN_INPUT_MODES.filter((option) => option.id !== "event");
}

export function safeCampaignInputMode(
  experienceMode: CampaignExperienceMode,
  requested: CampaignInputMode,
): CampaignInputMode {
  return campaignInputModes(experienceMode).some((option) => option.id === requested)
    ? requested
    : "action";
}

import {
  buildCampaignRelevantCheck,
  type CampaignCheckDifficulty,
  type CampaignCheckRequest,
  type CampaignRelevantCheck,
  type CampaignRpgState,
  type StoryholdStatName,
} from "./campaignRpgState";
import type { OutcomeCertainty, TurnActionScope } from "./causalEngine";

const ABILITY_PATTERNS: ReadonlyArray<{
  ability: StoryholdStatName;
  pattern: RegExp;
}> = [
  { ability: "acrobatics", pattern: /\b(?:balance|climb|flip|leap|parkour|roll beneath|swing across|tumble|vault)\b/iu },
  { ability: "strength", pattern: /\b(?:break|carry|drag|force|grapple|haul|hold back|kick|lift|overpower|pry|shove|smash|strike|wrestle)\b/iu },
  { ability: "dexterity", pattern: /\b(?:aim|catch|dodge|draw|drive|hide|pick\b[^.!?]{0,24}\block|shoot|sneak|steal|throw|evade)\b/iu },
  { ability: "constitution", pattern: /\b(?:endure|hold (?:my|their) breath|keep running|push through|resist|survive|withstand)\b/iu },
  { ability: "intelligence", pattern: /\b(?:analy[sz](?:e|ed|ing)|calculat(?:e|ed|ing)|craft(?:ed|ing)?|decod(?:e|ed|ing)|deduc(?:e|ed|ing)|hack(?:ed|ing)?|investigat(?:e|ed|ing)|plan(?:ned|ning)?|recall(?:ed|ing)?|repair(?:ed|ing)?|research(?:ed|ing)?|solv(?:e|ed|ing)|stud(?:y|ied|ying))\b/iu },
  { ability: "wisdom", pattern: /\b(?:assess|discern|examine|feel out|inspect|listen|notice|perceive|read (?:him|her|them|the room)|search|sense|spot|track|watch)\b/iu },
  { ability: "charisma", pattern: /\b(?:bargain|bluff|command|convince|deceive|distract|inspire|intimidate|lie|negotiate|persuade|provoke|reassure|seduce|threaten)\b/iu },
];

const ACTION_SCOPE_ABILITIES: Readonly<
  Partial<Record<TurnActionScope, readonly StoryholdStatName[]>>
> = {
  communication: ["charisma"],
  observation: ["wisdom", "intelligence"],
  movement: ["dexterity", "acrobatics", "strength", "constitution"],
  manipulation: ["dexterity", "intelligence", "strength"],
  conflict: ["strength", "dexterity", "acrobatics", "charisma"],
  extended: ["constitution", "intelligence", "wisdom"],
};

function primaryClauseBonus(action: string, matchIndex: number): number {
  const before = action.slice(0, matchIndex).toLocaleLowerCase();
  const whileIndex = action.toLocaleLowerCase().indexOf(" while ");
  let bonus = whileIndex < 0 || matchIndex < whileIndex ? 4 : 0;
  if (/\b(?:so (?:that|i|we|they)|in order to)\b[^.!?;]*$/iu.test(before)) bonus += 7;
  else if (/\b(?:then|after that|next)\b[^.!?;]*$/iu.test(before)) bonus += 5;
  else if (/\bby\b[^.!?;]*$/iu.test(before)) bonus += 3;
  return bonus;
}

function abilityScores(
  action: string,
  actionScope?: TurnActionScope,
): Map<StoryholdStatName, { score: number; finalMatch: number }> {
  const scores = new Map<StoryholdStatName, { score: number; finalMatch: number }>();
  for (const candidate of ABILITY_PATTERNS) {
    const match = candidate.pattern.exec(action);
    if (!match || match.index === undefined) continue;
    const current = scores.get(candidate.ability) ?? { score: 0, finalMatch: -1 };
    current.score += 10 + primaryClauseBonus(action, match.index);
    current.finalMatch = Math.max(current.finalMatch, match.index);
    scores.set(candidate.ability, current);
  }
  const preferred = actionScope ? ACTION_SCOPE_ABILITIES[actionScope] ?? [] : [];
  preferred.forEach((ability, index) => {
    const current = scores.get(ability) ?? { score: 0, finalMatch: -1 };
    current.score += Math.max(1, 4 - index);
    scores.set(ability, current);
  });
  return scores;
}

function normalizedWords(value: string): Set<string> {
  return new Set(
    value.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]{2,}/gu) ?? [],
  );
}

function overlappingCapability(
  state: CampaignRpgState,
  actorId: string,
  action: string,
): string | null {
  const actor = state.characters.find((character) => character.characterId === actorId);
  if (!actor) return null;
  const actionWords = normalizedWords(action);
  let best: { id: string; overlap: number } | null = null;
  for (const capability of actor.capabilities) {
    const words = normalizedWords(`${capability.name} ${capability.description}`);
    const overlap = [...words].filter((word) => actionWords.has(word)).length;
    if (overlap > 0 && (!best || overlap > best.overlap || (overlap === best.overlap && capability.id < best.id))) {
      best = { id: capability.id, overlap };
    }
  }
  return best?.id ?? null;
}

export function localCampaignCheckAbility(
  action: string,
  actionScope?: TurnActionScope,
): StoryholdStatName {
  const scores = abilityScores(action, actionScope);
  return [...scores.entries()]
    .sort((left, right) =>
      right[1].score - left[1].score ||
      right[1].finalMatch - left[1].finalMatch ||
      STORYHOLD_ABILITY_ORDER.indexOf(left[0]) - STORYHOLD_ABILITY_ORDER.indexOf(right[0])
    )[0]?.[0] ?? (actionScope === "communication" ? "charisma" : "wisdom");
}

const STORYHOLD_ABILITY_ORDER: readonly StoryholdStatName[] = [
  "strength",
  "dexterity",
  "constitution",
  "intelligence",
  "wisdom",
  "charisma",
  "acrobatics",
];

export function localCampaignCheckDifficulty(action: string): CampaignCheckDifficulty {
  // Player-authored adjectives never make a check easier. Until a trusted
  // adjudicator can compare the attempt with scene state, the local fallback
  // is neutral and only recognizes concrete hazard language as added pressure.
  if (/\b(?:against an army|collapse(?:d|ing)? building|destroy (?:a )?(?:city|planet)|kill (?:a )?god|vacuum of space|inside (?:an? )?(?:active )?(?:volcano|reactor)|falling from (?:orbit|an? aircraft))\b/iu.test(action)) return "extreme";
  if (/\b(?:overwhelming force|without oxygen|under heavy fire|while blind(?:ed)?|outnumbered (?:ten|dozens?|hundreds?) to one|during (?:an? )?(?:explosion|avalanche|building collapse)|in hard vacuum)\b/iu.test(action)) return "severe";
  if (/\b(?:while falling|while wounded|under pressure|without being seen|before (?:the )?(?:timer|bomb) (?:ends|explodes)|in total darkness|with one hand|through crossfire|against multiple opponents)\b/iu.test(action)) return "hard";
  return "standard";
}

function escapedPattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function namedCharacterPattern(name: string) {
  const escaped = escapedPattern(name.trim()).replace(/\s+/gu, "\\s+");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "iu");
}

/**
 * Conservative local participant inference. A name alone is not enough:
 * assistance or opposition requires explicit relational wording in the
 * player's action, and every returned ID already exists in locked RPG state.
 */
export function localCampaignCheckParticipants(input: {
  state: CampaignRpgState;
  actorId: string;
  action: string;
  ability: StoryholdStatName;
}): Pick<CampaignCheckRequest, "assistingCharacterIds" | "opposition"> {
  const assistingCharacterIds: string[] = [];
  let opposition: CampaignCheckRequest["opposition"] = null;
  for (const character of input.state.characters) {
    if (character.characterId === input.actorId || !character.name.trim()) continue;
    const name = escapedPattern(character.name.trim()).replace(/\s+/gu, "\\s+");
    const named = namedCharacterPattern(character.name).test(input.action);
    if (!named) continue;
    const assists = new RegExp(
      `(?:with|accepting|using)\\s+(?:the\\s+)?(?:help|aid|cover|assistance)\\s+(?:of|from)\\s+${name}|${name}[^.!?]{0,32}\\b(?:helps?|assists?|aids?|covers?)\\s+(?:me|us)\\b|\\b(?:together|team up)\\b[^.!?]{0,32}${name}`,
      "iu",
    ).test(input.action);
    const opposes = new RegExp(
      `\\b(?:against|attack|fight|shoot|stab|strike|grapple|wrestle|outwit|outmaneuver|deceive|bluff|persuade|convince|intimidate|threaten|escape|evade|chase|pursue)\\b[^.!?]{0,48}${name}|${name}[^.!?]{0,32}\\b(?:opposes?|blocks?|resists?|fights?|attacks?|chases?|pursues?)\\b`,
      "iu",
    ).test(input.action);
    if (opposes && !opposition) {
      opposition = { characterId: character.characterId, ability: input.ability };
    } else if (assists) {
      assistingCharacterIds.push(character.characterId);
    }
  }
  if (opposition) {
    const opponentId = opposition.characterId;
    return {
      assistingCharacterIds: assistingCharacterIds.filter((id) => id !== opponentId),
      opposition,
    };
  }
  return { assistingCharacterIds, opposition: null };
}

/**
 * Offline fallback for computers or deployments without an adjudicator model.
 * It selects categories only. The RPG kernel derives every number and the
 * causal engine owns fortune and outcome.
 */
export function planLocalCampaignCheck(input: {
  state: CampaignRpgState;
  actorId: string;
  action: string;
  certainty: OutcomeCertainty;
  assistingCharacterIds?: readonly string[];
  opposition?: CampaignCheckRequest["opposition"];
  actionScope?: TurnActionScope;
}): CampaignCheckRequest {
  const ability = localCampaignCheckAbility(input.action, input.actionScope);
  const participants = localCampaignCheckParticipants({
    state: input.state,
    actorId: input.actorId,
    action: input.action,
    ability,
  });
  return {
    actorId: input.actorId,
    ability,
    capabilityId: overlappingCapability(input.state, input.actorId, input.action),
    difficulty: localCampaignCheckDifficulty(input.action),
    assistingCharacterIds: input.assistingCharacterIds ?? participants.assistingCharacterIds,
    opposition: input.opposition ?? participants.opposition,
    certainty: input.certainty,
  };
}

export function buildLocalCampaignCheck(input: Parameters<typeof planLocalCampaignCheck>[0]): CampaignRelevantCheck {
  return buildCampaignRelevantCheck(
    input.state,
    planLocalCampaignCheck(input),
  );
}

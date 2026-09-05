import type { PGlite } from "@electric-sql/pglite";
import { syncWorldEntityMentions } from "./worldKnowledge";

type IdentityDb = Pick<PGlite, "query">;

export type CharacterAliasKind =
  | "familiar_name"
  | "formal_address"
  | "honorific"
  | "nickname"
  | "identity_reveal"
  | "descriptive_reference"
  | "owner_canon";

export type CharacterAliasAttribution = {
  alias: string;
  kind: CharacterAliasKind;
  attributedBy: string | null;
  explanation: string;
  temporalScope: "single_scene" | "ongoing" | "unknown";
  semanticLimits: string[];
  quote: string;
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  chapterTitle: string;
  confidence: number;
};

export type IdentityChunk = {
  id: string;
  sourceId: string;
  sourceTitle: string;
  content: string;
  metadata: Record<string, unknown>;
};

export type PairedSurnameReveal = {
  givenNames: [string, string];
  surname: string;
  quote: string;
  occurrenceIndex: number;
};

export type ExplicitCharacterIdentityEntity = {
  id: string;
  name: string;
  aliases?: string[];
  entityType: string;
  pullStatus?: string;
  scannerPresent?: boolean;
  dossierId?: string | null;
  mentionCount?: number;
};

export type ExplicitCharacterIdentityResolution = {
  survivorId: string;
  memberIds: string[];
  aliases: string[];
  attributions: CharacterAliasAttribution[];
};

export type GeneratedTaxonomyIdentityEntity = {
  id: string;
  name: string;
  aliases?: string[];
  entityType: string;
  pullStatus?: string;
  scannerPresent?: boolean;
  dossierId?: string | null;
  mentionCount?: number;
  evidence?: unknown;
  classificationSource?: string;
  reviewStatus?: string;
  userEditedAt?: unknown;
};

export type GeneratedTaxonomyIdentityResolution = {
  survivorId: string;
  memberIds: [string, string];
  aliases: string[];
};

function normalized(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[’]/gu, "'")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}

function cleanText(value: unknown, maximum = 4_000): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, maximum);
}

function cleanStrings(values: unknown[], maximum = 40): string[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const text = cleanText(value, 240);
    const key = normalized(text);
    if (!key || seen.has(key)) return [];
    seen.add(key);
    return [text];
  }).slice(0, maximum);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function normalizeCharacterAliasAttribution(value: unknown): CharacterAliasAttribution | null {
  const row = record(value);
  const alias = cleanText(row.alias, 240);
  const kind = cleanText(row.kind, 80) as CharacterAliasKind;
  if (!alias || ![
    "familiar_name", "formal_address", "honorific", "nickname",
    "identity_reveal", "descriptive_reference", "owner_canon",
  ].includes(kind)) return null;
  const quote = cleanText(row.quote, 620);
  const occurrenceIndex = aliasOccurrence(quote, alias);
  const prefix = occurrenceIndex >= 0 ? quote.slice(Math.max(0, occurrenceIndex - 360), occurrenceIndex) : "";
  const speakerMatches = [...prefix.matchAll(
    /\b([\p{Lu}][\p{L}\p{M}'’\-]{1,60})\b[^.!?"“”]{0,120}\b(?:said|asked|replied|answered|called|shouted|whispered|muttered|grinned|smiled|laughed|chuckled|studied|watched|looked|leaned|waved|pointed|nodded|turned|stared|stepped|peering)\b/gu,
  )];
  const attributedBy = cleanText(row.attributedBy, 240) || speakerMatches.at(-1)?.[1] || null;
  const storedExplanation = cleanText(row.explanation, 1_000);
  const explanation = kind === "descriptive_reference"
    ? storedExplanation
        .replace(
          /uses this while reflecting on ([^.]+) as a child\.?/iu,
          "uses this once while imagining what $1 may have been like as a child; the character is not a child in this scene.",
        )
        .replace(/^The manuscript uses this/iu, `${attributedBy ?? "The manuscript"} uses this`)
    : storedExplanation;
  return {
    alias,
    kind,
    attributedBy,
    explanation,
    temporalScope: ["single_scene", "ongoing", "unknown"].includes(cleanText(row.temporalScope, 40))
      ? cleanText(row.temporalScope, 40) as CharacterAliasAttribution["temporalScope"]
      : kind === "descriptive_reference" ? "single_scene" : "unknown",
    semanticLimits: cleanStrings(
      Array.isArray(row.semanticLimits) ? row.semanticLimits : kind === "descriptive_reference"
        ? [
            "Does not mean the character is a child in this scene.",
            "Does not turn past-timeline chapters into childhood chapters.",
          ]
        : [],
      8,
    ),
    quote,
    chunkId: cleanText(row.chunkId, 100),
    sourceId: cleanText(row.sourceId, 100),
    sourceTitle: cleanText(row.sourceTitle, 500),
    chapterTitle: cleanText(row.chapterTitle, 500),
    confidence: Math.max(0, Math.min(1, Number(row.confidence) || 0)),
  };
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\s+/gu, "\\s+");
}

export function chapterPerspective(metadata: Record<string, unknown>): string {
  const explicit = cleanText(metadata.perspective, 240);
  if (explicit) return cleanText(explicit.split(/\s+[—–-]\s+/u)[0], 240);
  const title = cleanText(metadata.sectionTitle, 500);
  const parenthetical = title.match(/\(([^()]+)\)\s*$/u)?.[1];
  if (parenthetical) return cleanText(parenthetical.split(/\s+[—–-]\s+/u)[0], 240);
  const key = cleanText(metadata.sectionKey, 500);
  const keyMatch = key.match(/-([a-z][a-z'’-]+)-(?:past|present|future)$/iu)?.[1];
  return keyMatch ? keyMatch.replace(/(^|[-_])([a-z])/gu, (_match, boundary, letter) => `${boundary}${letter.toLocaleUpperCase()}`) : "";
}

function quoteBounds(content: string, index: number): { start: number; end: number } | null {
  const openers = ['"', "“", "‘"];
  const closers = ['"', "”", "’"];
  let start = -1;
  for (let cursor = index - 1; cursor >= Math.max(0, index - 700); cursor -= 1) {
    if (openers.includes(content[cursor]!)) {
      start = cursor;
      break;
    }
  }
  if (start < 0) return null;
  let end = -1;
  for (let cursor = index; cursor < Math.min(content.length, index + 700); cursor += 1) {
    if (closers.includes(content[cursor]!) && cursor > index) {
      end = cursor + 1;
      break;
    }
  }
  return end > start ? { start, end } : null;
}

function aliasOccurrences(content: string, alias: string, containingAliases: string[] = []): number[] {
  const aliasPattern = new RegExp(`(?<![\\p{L}\\p{N}_])${regexEscape(alias)}(?![\\p{L}\\p{N}_])`, "giu");
  const containingSpans = containingAliases
    .filter((candidate) => normalized(candidate) !== normalized(alias) && candidate.length > alias.length)
    .flatMap((candidate) => [...content.matchAll(
      new RegExp(`(?<![\\p{L}\\p{N}_])${regexEscape(candidate)}(?![\\p{L}\\p{N}_])`, "giu"),
    )].map((match) => ({ start: match.index ?? -1, end: (match.index ?? -1) + match[0].length })))
    .filter((span) => span.start >= 0);
  const indexes: number[] = [];
  for (const match of content.matchAll(aliasPattern)) {
    const index = match.index ?? -1;
    const end = index + match[0].length;
    if (index < 0) continue;
    if (containingSpans.some((span) => span.start <= index && span.end >= end)) continue;
    indexes.push(index);
  }
  return indexes;
}

function aliasOccurrence(content: string, alias: string, containingAliases: string[] = []): number {
  return aliasOccurrences(content, alias, containingAliases)[0] ?? -1;
}

function excerpt(content: string, index: number, length: number): string {
  const start = Math.max(0, index - 170);
  const end = Math.min(content.length, index + length + 240);
  return cleanText(`${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`, 620);
}

/**
 * Detect the compact reveal used by prose such as "Lilly and James... Potter?".
 * The known-name gate matters: this is an identity clue only when both first
 * names already resolve to characters, not whenever narration happens to list
 * two capitalized words before a comparison.
 */
export function pairedSurnameReveals(input: {
  content: string;
  knownGivenNames: string[];
}): PairedSurnameReveal[] {
  const known = new Map(
    cleanStrings(input.knownGivenNames, 500).map((name) => [
      normalized(name.split(/\s+/u)[0] ?? name),
      name.split(/\s+/u)[0] ?? name,
    ]),
  );
  const output: PairedSurnameReveal[] = [];
  const seen = new Set<string>();
  const pattern = /(?<![\p{L}\p{M}])([\p{Lu}][\p{L}\p{M}'’\-]{1,60})\s+and\s+([\p{Lu}][\p{L}\p{M}'’\-]{1,60})\s*(?:\.{2,}|…+|[—–-])\s*([\p{Lu}][\p{L}\p{M}'’\-]{1,80})\s*\?/gu;
  for (const match of input.content.matchAll(pattern)) {
    const left = known.get(normalized(match[1]));
    const right = known.get(normalized(match[2]));
    const surname = cleanText(match[3], 120);
    const occurrenceIndex = match.index ?? -1;
    if (!left || !right || !surname || occurrenceIndex < 0) continue;
    if ([left, right].some((name) => normalized(name) === normalized(surname))) continue;
    const key = `${normalized(left)}:${normalized(right)}:${normalized(surname)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({
      givenNames: [left, right],
      surname,
      quote: excerpt(input.content, occurrenceIndex, match[0].length),
      occurrenceIndex,
    });
  }
  return output;
}

function nearestNamedSpeaker(input: {
  content: string;
  occurrenceIndex: number;
  knownCharacterNames: string[];
  excludedNames: string[];
}): string | null {
  const excluded = new Set(input.excludedNames.map(normalized));
  const bounds = quoteBounds(input.content, input.occurrenceIndex);
  if (!bounds) return null;

  // Speaker attribution must be local to the quotation. Looking for the last
  // known name in a broad prefix lets an earlier listener steal a quotation
  // whenever the actual speaker has not yet been classified as a character.
  // Begin after the preceding quotation instead, then follow grammatical
  // subjects and speech tags. This also keeps names after the quotation from
  // claiming dialogue that they merely react to.
  const prefixStart = Math.max(0, bounds.start - 480);
  const broadPrefix = input.content.slice(prefixStart, bounds.start);
  const precedingQuote = Math.max(
    broadPrefix.lastIndexOf('"'),
    broadPrefix.lastIndexOf("“"),
    broadPrefix.lastIndexOf("”"),
  );
  const prefix = broadPrefix.slice(precedingQuote + 1);
  const suffix = input.content.slice(bounds.end, Math.min(input.content.length, bounds.end + 150));
  const properName = String.raw`[\p{Lu}][\p{L}\p{M}'’.-]{1,60}(?:\s+[\p{Lu}][\p{L}\p{M}'’.-]{1,60}){0,3}`;
  const speechVerb = String.raw`said|asked|replied|answered|called|shouted|whispered|muttered|exclaimed|added|continued|announced|demanded|snapped|joked|teased|yelled|cried|hissed|growled`;
  const expressiveVerb = String.raw`grinned|smiled|laughed|chuckled`;
  const stagingVerb = String.raw`studied|watched|looked|leaned|waved|pointed|nodded|turned|stared|stepped|peered|approached`;
  const invalidNames = new Set([
    "he", "him", "his", "she", "her", "hers", "they", "them", "their", "theirs", "it", "its",
    "i", "me", "my", "mine", "we", "us", "our", "ours", "you", "your", "yours",
    "the", "a", "an", "this", "that", "these", "those",
    "someone", "somebody", "anyone", "anybody", "everyone", "everybody", "nobody", "no one",
  ]);
  type Cue = { name: string; index: number; strength: number; coordinated: boolean };
  const cues: Cue[] = [];
  const addCue = (nameValue: string, index: number, strength: number) => {
    const name = cleanText(nameValue, 240);
    const key = normalized(name);
    if (!name || invalidNames.has(key) || excluded.has(key)) return;
    const before = prefix.slice(Math.max(0, index - 90), index);
    const coordinated = /(?:\band|&)\s*$/iu.test(before);
    cues.push({ name, index, strength, coordinated });
  };
  const directCue = new RegExp(
    `(?<![\\p{L}\\p{N}_])(${properName})\\s+(${speechVerb}|${expressiveVerb}|${stagingVerb})\\b`,
    "gu",
  );
  for (const match of prefix.matchAll(directCue)) {
    const verb = normalized(match[2]);
    addCue(
      match[1] ?? "",
      match.index ?? 0,
      new RegExp(`^(?:${speechVerb})$`, "iu").test(verb)
        ? 3
        : new RegExp(`^(?:${expressiveVerb})$`, "iu").test(verb) ? 2 : 1,
    );
  }
  const possessiveCue = new RegExp(
    `(?<![\\p{L}\\p{N}_])(${properName})['’]s\\s+(?:gaze|eyes?|face|expression|smirk|voice|attention|focus)\\b`,
    "gu",
  );
  for (const match of prefix.matchAll(possessiveCue)) {
    addCue(match[1] ?? "", match.index ?? 0, 1);
  }

  // An explicit post-quotation name is conclusive and outranks scene staging.
  const namedTag = suffix.match(new RegExp(
    `^\\s*[,;:.!?—–-]*\\s*(${properName})\\s+(?:${speechVerb})\\b`,
    "u",
  ));
  if (namedTag) {
    const name = cleanText(namedTag[1], 240);
    if (name && !invalidNames.has(normalized(name)) && !excluded.has(normalized(name))) return name;
  }

  const usable = cues.filter((cue) => !cue.coordinated).sort((left, right) =>
    left.index - right.index || left.name.length - right.name.length
  );
  const nearest = usable.at(-1);
  if (!nearest) return null;
  const pronounTag = /^\s*[,;:.!?—–-]*\s*(?:he|she|they)\s+(?:said|asked|replied|answered|called|shouted|whispered|muttered|exclaimed|added|continued|announced|demanded|snapped|joked|teased|yelled|cried|hissed|growled)\b/iu.test(suffix);
  if (pronounTag || nearest.strength >= 2) return nearest.name;

  // A weak staging cue ("looked", "stepped", and similar) is usable only
  // when the local bridge to the quotation contains one possible character.
  // This preserves clear constructions while declining genuinely ambiguous
  // ones such as "David looked at Martin. '...'".
  const locallyNamed = new Set<string>();
  for (const name of input.knownCharacterNames) {
    const key = normalized(name);
    if (!name.trim() || excluded.has(key)) continue;
    if (new RegExp(`(?<![\\p{L}\\p{N}_])${regexEscape(name)}(?![\\p{L}\\p{N}_])`, "iu").test(prefix)) {
      locallyNamed.add(key);
    }
  }
  return locallyNamed.size <= 1 ? nearest.name : null;
}

export function directlyAddressedAliasOfEstablishedCharacter(input: {
  canonicalNames: string[];
  alias: string;
  chunks: IdentityChunk[];
}): { chunk: IdentityChunk; quote: string; attributedBy: string | null } | null {
  const canonicalNames = cleanStrings(input.canonicalNames)
    .filter((name) => normalized(name) !== normalized(input.alias));
  const alias = cleanText(input.alias, 100);
  if (!alias || !canonicalNames.length || alias.split(/\s+/u).length > 3) return null;
  const canonical = canonicalNames.map(regexEscape).sort((a, b) => b.length - a.length).join("|");
  const candidate = regexEscape(alias);
  const interruptedReply = new RegExp(
    `\\b(?:${canonical})\\b\\s+(?:(?:opened|parted)\\s+(?:his|her|their)\\s+(?:mouth|lips)(?:\\s+to\\s+(?:respond|answer|reply|speak))?|(?:started|began|was\\s+about)\\s+to\\s+(?:respond|answer|reply|speak))[^.!?\\r\\n]{0,80}\\b(?:but|when)\\s+([\\p{Lu}][\\p{L}\\p{M}'’.-]{1,60})\\s+(?:cut\\s+in|interrupted|spoke\\s+over\\s+(?:him|her|them))\\b`,
    "iu",
  );
  const quotedAddress = new RegExp(
    `[“"][^”"\\r\\n]{0,220}(?<![\\p{L}\\p{N}_])${candidate}(?![\\p{L}\\p{N}_])\\s*[,.!?][^”"\\r\\n]{0,80}[”"]`,
    "iu",
  );
  for (const chunk of input.chunks) {
    const interruption = interruptedReply.exec(chunk.content);
    if (!interruption) continue;
    const addressWindowStart = interruption.index + interruption[0].length;
    const addressWindow = chunk.content.slice(addressWindowStart, addressWindowStart + 340);
    const address = quotedAddress.exec(addressWindow);
    if (!address) continue;
    const matchLength = interruption[0].length + (address.index ?? 0) + address[0].length;
    return {
      chunk,
      quote: excerpt(chunk.content, interruption.index, matchLength),
      attributedBy: cleanText(interruption[1], 100) || null,
    };
  }
  return null;
}

function aliasKind(alias: string, canonicalName: string): CharacterAliasKind {
  const key = normalized(alias);
  const canonical = normalized(canonicalName);
  if (canonical.startsWith(`${key} `) || canonical.endsWith(` ${key}`)) return "familiar_name";
  if (/^(?:mr|mrs|ms|miss|dr|doctor|professor)\.?\s+/iu.test(alias)) return "formal_address";
  if (/^(?:sir|lady|lord|captain|chief|general|commander)\s+/iu.test(alias)) return "honorific";
  if (/^(?:little|young|old)\s+/iu.test(alias)) return "descriptive_reference";
  return "nickname";
}

function abbreviatedGivenName(alias: string, canonicalName: string): boolean {
  const short = normalized(alias).replace(/[^\p{L}\p{N}]/gu, "");
  const canonical = normalized(canonicalName.split(/\s+/u)[0]).replace(/[^\p{L}\p{N}]/gu, "");
  return short.length >= 3 && canonical.length > short.length &&
    canonical.length - short.length <= 3 && canonical.startsWith(short);
}

function aliasExplanation(input: {
  alias: string;
  canonicalName: string;
  attributedBy: string | null;
  content: string;
  kind: CharacterAliasKind;
  occurrenceIndex: number;
}): string {
  const user = input.attributedBy ?? "The manuscript";
  const bounds = quoteBounds(input.content, input.occurrenceIndex);
  const citedContext = bounds
    ? input.content.slice(bounds.start, bounds.end)
    : input.content.slice(Math.max(0, input.occurrenceIndex - 120), input.occurrenceIndex + input.alias.length + 160);
  const explicitReference = /\b(?:a|the|this|that|it's|it\s+is)\s+(?:(?:cultural|literary|historical|mythological|religious|film|movie|television|musical|comic|pop[- ]culture)\s+)?(?:joke|pun|reference|allusion)\b/iu.test(citedContext) ||
    /\b(?:named|name|called|calling)\s+(?:you\s+)?after\b/iu.test(citedContext) ||
    /\b(?:as\s+in|like)\s+(?:the\s+)?(?:character|hero|villain|god|goddess|saint|pilot|astronaut|author|actor|singer|song|book|movie|show)\b/iu.test(citedContext);
  if (explicitReference) {
    return `${user} explicitly uses this as a reference or wordplay while addressing ${input.canonicalName}.`;
  }
  if (input.kind === "descriptive_reference") {
    return `${user} uses this once while imagining what ${input.canonicalName} may have been like as a child; ${input.canonicalName} is not a child in this scene.`;
  }
  if (input.kind === "formal_address") {
    return `${user} uses this formal or teasing form of address for ${input.canonicalName}.`;
  }
  if (input.kind === "honorific") {
    return `${user} uses this honorific for ${input.canonicalName} in the cited scene.`;
  }
  if (input.kind === "familiar_name") {
    return `The manuscript uses this shorter form of ${input.canonicalName}'s name.`;
  }
  return `${user} uses this nickname while addressing ${input.canonicalName}.`;
}

export function nicknameAddressesPerspective(input: {
  alias: string;
  canonicalName: string;
  content: string;
  metadata: Record<string, unknown>;
  occurrenceIndex?: number;
}): boolean {
  const occurrenceIndex = input.occurrenceIndex ?? aliasOccurrence(input.content, input.alias);
  const bounds = occurrenceIndex >= 0 ? quoteBounds(input.content, occurrenceIndex) : null;
  if (occurrenceIndex < 0 || !bounds) return false;
  const perspective = chapterPerspective(input.metadata);
  const givenName = cleanText(input.canonicalName, 240).split(/\s+/u)[0] ?? "";
  if (normalized(perspective) !== normalized(givenName) && normalized(perspective) !== normalized(input.canonicalName)) {
    return false;
  }
  const afterQuote = input.content.slice(bounds.end, Math.min(input.content.length, bounds.end + 260));
  const speaker = nearestNamedSpeaker({
    content: input.content,
    occurrenceIndex,
    knownCharacterNames: [],
    excludedNames: [input.canonicalName, givenName],
  }) ?? "";
  const spokenByAnotherNamedPerson = Boolean(speaker) &&
    normalized(speaker) !== normalized(givenName) &&
    normalized(speaker) !== normalized(input.canonicalName);
  const quote = input.content.slice(bounds.start, bounds.end);
  const aliasPattern = regexEscape(input.alias);
  const openingVocative = new RegExp(
    `^["“‘]?\\s*${aliasPattern}(?:\\s*[,!?.…]|$)`,
    "iu",
  ).test(quote);
  const directedVocative = new RegExp(
    `\\b(?:to|hey|listen|look)\\s+${aliasPattern}(?:\\s*[,!?.…]|$)`,
    "iu",
  ).test(quote);
  const trailingVocative = new RegExp(
    `${aliasPattern}\\s*[,!?.…][^"“”]{0,40}$`,
    "iu",
  ).test(quote) && /^\s*(?:he|she|they|[\p{Lu}][\p{L}\p{M}'’\-]+)\s+(?:said|asked|replied|answered|whispered|muttered|exclaimed)\b/iu.test(afterQuote);
  const vocative = openingVocative || directedVocative || trailingVocative;
  const explicitNicknameResponse = /\bI\s+(?:scowled|grimaced|rolled\s+my\s+eyes|replied|answered|glared|sighed|groaned)\b[\s\S]{0,70}\b(?:nickname|name|joke)\b/iu.test(afterQuote);
  const explicitlyNamedInQuote = new RegExp(
    `${aliasPattern}\\s*[,!?.…]`,
    "iu",
  ).test(quote);
  const aliasAppearsInQuote = new RegExp(
    `(?<![\\p{L}\\p{N}_])${aliasPattern}(?![\\p{L}\\p{N}_])`,
    "iu",
  ).test(quote);
  if (explicitNicknameResponse && explicitlyNamedInQuote) return true;
  const directReaction = /\bI\s+(?:scowled|grimaced|rolled\s+my\s+eyes|replied|answered|glared|sighed|groaned|laughed)\b/iu.test(afterQuote.slice(0, 130));
  const formalOrNamed = new RegExp(`\\b${regexEscape(givenName)}\\b`, "iu").test(input.alias) ||
    /^(?:Mr|Mrs|Ms|Miss|Dr|Doctor|Professor|Sir|Lady|Lord|Captain)\.?\s+/u.test(input.alias);
  const stagedCallAndResponse = directedVocative && new RegExp(
    `\\b[\\p{Lu}][\\p{L}\\p{M}'’.-]{1,60}\\s+to\\s+${aliasPattern}\\b[\\s\\S]{0,160}\\b[Tt]his\\s+is\\s+(?:the\\s+)?[\\p{Lu}][\\p{L}\\p{M}'’.-]{1,60}\\b`,
    "u",
  ).test(quote);
  if (spokenByAnotherNamedPerson && formalOrNamed && aliasAppearsInQuote) return true;
  if (
    spokenByAnotherNamedPerson && vocative &&
    abbreviatedGivenName(input.alias, input.canonicalName)
  ) return true;
  return spokenByAnotherNamedPerson && vocative && (
    explicitNicknameResponse || (stagedCallAndResponse && directReaction)
  );
}

export function composeFormalCharacterName(input: {
  givenName: string;
  content: string;
  metadata: Record<string, unknown>;
}): { name: string; addressedAs: string } | null {
  const givenName = cleanText(input.givenName, 120).split(/\s+/u)[0] ?? "";
  const perspective = chapterPerspective(input.metadata);
  if (!givenName || (normalized(perspective) !== normalized(givenName) && normalized(perspective) !== normalized(input.givenName))) {
    return null;
  }
  const titlePattern = /\b(Mr|Mrs|Ms|Miss|Dr|Doctor|Professor)\.?\s+([\p{Lu}][\p{L}\p{M}'’\-]+)\b/gu;
  for (const match of input.content.matchAll(titlePattern)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    const bounds = quoteBounds(input.content, index);
    if (!bounds) continue;
    const quote = input.content.slice(bounds.start, bounds.end);
    if (!/\b(?:you|your|yourself)\b/iu.test(quote)) continue;
    const surname = match[2]!;
    if (normalized(surname) === normalized(givenName)) continue;
    return {
      name: `${givenName} ${surname}`,
      addressedAs: cleanText(match[0], 120),
    };
  }
  return null;
}

export function characterAliasAttributions(input: {
  canonicalName: string;
  aliases: string[];
  chunks: IdentityChunk[];
  knownCharacterNames: string[];
  canonicalNameByLabel?: Record<string, string>;
}): CharacterAliasAttribution[] {
  const canonicalLabels = cleanStrings([
    input.canonicalName,
    input.canonicalName.split(/\s+/u)[0] ?? "",
  ]);
  return cleanStrings(input.aliases).flatMap((alias) => {
    const matching = input.chunks.flatMap((chunk) => {
      return aliasOccurrences(chunk.content, alias, input.aliases).flatMap((occurrenceIndex) => {
        const kind = aliasKind(alias, input.canonicalName);
        const perspective = chapterPerspective(chunk.metadata);
        const canonicalGiven = input.canonicalName.split(/\s+/u)[0] ?? input.canonicalName;
        const canonicalSurname = input.canonicalName.split(/\s+/u).at(-1) ?? "";
        const addressedSurname = alias.replace(
          /^(?:Mr|Mrs|Ms|Miss|Dr|Doctor|Professor)\.?\s+/iu,
          "",
        );
        const formalSurnameEvidence = kind === "formal_address" &&
          normalized(addressedSurname) === normalized(canonicalSurname) &&
          normalized(perspective) === normalized(canonicalGiven) &&
          Boolean(quoteBounds(chunk.content, occurrenceIndex));
        const direct = formalSurnameEvidence || nicknameAddressesPerspective({
          alias,
          canonicalName: input.canonicalName,
          content: chunk.content,
          metadata: chunk.metadata,
          occurrenceIndex,
        });
        const familiar = kind === "familiar_name";
        if (!direct && !(familiar && normalized(perspective) === normalized(canonicalGiven))) return [];
        const rawAttribution = nearestNamedSpeaker({
          content: chunk.content,
          occurrenceIndex,
          knownCharacterNames: input.knownCharacterNames,
          excludedNames: canonicalLabels,
        });
        const attributedBy = rawAttribution
          ? input.canonicalNameByLabel?.[normalized(rawAttribution)] ?? rawAttribution
          : null;
        return [{
          alias,
          kind,
          attributedBy,
          explanation: aliasExplanation({
            alias,
            canonicalName: input.canonicalName,
            attributedBy,
            content: chunk.content,
            kind,
            occurrenceIndex,
          }),
          temporalScope: kind === "descriptive_reference" ? "single_scene" : "unknown",
          semanticLimits: kind === "descriptive_reference"
            ? [
                "Does not mean the character is a child in this scene.",
                "Does not turn past-timeline chapters into childhood chapters.",
              ]
            : [],
          quote: excerpt(chunk.content, occurrenceIndex, alias.length),
          chunkId: chunk.id,
          sourceId: chunk.sourceId,
          sourceTitle: chunk.sourceTitle,
          chapterTitle: cleanText(chunk.metadata.sectionTitle, 500),
          confidence: direct ? 0.94 : 0.82,
        } satisfies CharacterAliasAttribution];
      });
    });
    return matching.slice(0, 1);
  });
}

/**
 * Preserve a hovercard for a chosen name that is already present on a saved
 * dossier.  Older identity merges could retain `Prometheus` in aliases while
 * losing the cited `I called myself Prometheus` witness once the source row
 * was retired.  First-person prose is accepted only in the named character's
 * own POV chapter, so another speaker's self-introduction cannot leak onto the
 * dossier.
 */
export function selfDeclaredAliasAttributions(input: {
  canonicalName: string;
  aliases: string[];
  chunks: IdentityChunk[];
}): CharacterAliasAttribution[] {
  const canonicalLabels = cleanStrings([
    input.canonicalName,
    input.canonicalName.split(/\s+/u)[0] ?? "",
  ]).map(normalized);
  return cleanStrings(input.aliases).flatMap((alias) => {
    const aliasPattern = regexEscape(alias);
    const declaration = new RegExp(
      `\\bI\\s+(?:called\\s+myself|call\\s+myself|am\\s+called|was\\s+called|` +
      `am\\s+known\\s+as|was\\s+known\\s+as|go\\s+by|went\\s+by|` +
      `use|used)\\s+(?:(?:the|my)\\s+)?(?:(?:call\\s*sign|callsign|handle|name)\\s+)?` +
      `(?:the\\s+)?["'“‘]?${aliasPattern}["'”’]?(?![\\p{L}\\p{N}_])`,
      "giu",
    );
    for (const chunk of input.chunks) {
      if (!canonicalLabels.includes(normalized(chapterPerspective(chunk.metadata)))) continue;
      for (const match of chunk.content.matchAll(declaration)) {
        const occurrenceIndex = match.index ?? -1;
        if (occurrenceIndex < 0 || qualifiedIdentityClaim(
          chunk.content,
          occurrenceIndex,
          match[0].length,
        )) continue;
        return [{
          alias,
          kind: "nickname",
          attributedBy: input.canonicalName,
          explanation: `${input.canonicalName} explicitly chooses this callsign or name in the cited passage.`,
          temporalScope: "ongoing",
          semanticLimits: [],
          quote: excerpt(chunk.content, occurrenceIndex, match[0].length),
          chunkId: chunk.id,
          sourceId: chunk.sourceId,
          sourceTitle: chunk.sourceTitle,
          chapterTitle: cleanText(chunk.metadata.sectionTitle, 500),
          confidence: 0.99,
        } satisfies CharacterAliasAttribution];
      }
    }
    return [];
  });
}

type ExplicitIdentityEdge = {
  sourceId: string;
  targetId: string;
  alias: string;
  mergeTarget: boolean;
  attributedBy: string | null;
  chunk: IdentityChunk;
  occurrenceIndex: number;
  occurrenceLength: number;
};

type QuotedIdentitySpan = {
  content: string;
  start: number;
  end: number;
};

const IDENTITY_ENTITY_TYPES = new Set(["character", "title", "ambiguous", "term"]);
const SPEECH_VERBS = "said|asked|replied|answered|declared|announced|admitted|revealed|explained|told|intoned|whispered|muttered|shouted|exclaimed|called";

// These can be useful concepts in a manuscript, but they are not durable
// identities merely because the words follow "I am". Keeping this guard at
// the identity resolver (rather than relying on an extractor's category) also
// protects old worlds whose generic nouns were previously stored as ambiguous
// or character candidates.
const NON_IDENTITY_SELF_LABELS = new Set([
  "anybody", "anyone", "child", "dad", "daughter", "dude", "family", "father",
  "friend", "girl", "guy", "he", "here", "him", "home", "human", "it", "kid",
  "man", "me", "mom", "mother", "nobody", "no one", "nowhere", "one", "people",
  "person", "she", "somebody", "someone", "somewhere", "son", "that", "that thing",
  "the one", "there", "they", "thing", "this", "this thing", "us", "we", "woman",
  "you",
]);

function durableIdentityTargetLabel(entity: ExplicitCharacterIdentityEntity): boolean {
  const label = normalized(entity.name).replace(/^(?:a|an|the)\s+/u, "");
  if (!label || NON_IDENTITY_SELF_LABELS.has(label)) return false;
  if (/^(?:this|that|these|those|some|any|every|no|my|your|our|their|his|her|its)\s+/u.test(label)) return false;
  return true;
}

function explicitIdentityEntityIsEligible(entity: ExplicitCharacterIdentityEntity): boolean {
  return ["active", "do_not_pull"].includes(entity.pullStatus ?? "active");
}

function directIdentityTargetIsEligible(entity: ExplicitCharacterIdentityEntity): boolean {
  return IDENTITY_ENTITY_TYPES.has(entity.entityType) && durableIdentityTargetLabel(entity);
}

function explicitProperNameTargetIsEligible(entity: ExplicitCharacterIdentityEntity): boolean {
  if (!durableIdentityTargetLabel(entity)) return false;
  if (directIdentityTargetIsEligible(entity)) return true;
  const label = cleanText(entity.name, 100);
  const words = label.split(/\s+/u).filter(Boolean);
  if (!words.length || words.length > 8 || /\b(?:and|or)\b/iu.test(label)) return false;
  const connector = /^(?:a|an|the|of|to|for|from|in|on|with|without|de|del|van|von)$/u;
  return words.some((word) => /^[\p{Lu}]/u.test(word)) && words.every((word) =>
    connector.test(word) || /^[\p{Lu}\p{N}][\p{L}\p{M}\p{N}'’.-]*$/u.test(word));
}

function establishedCharacterDossier(entity: ExplicitCharacterIdentityEntity): boolean {
  return entity.entityType === "character" &&
    (entity.pullStatus ?? "active") === "active" &&
    entity.scannerPresent !== false &&
    Boolean(entity.dossierId);
}

function explicitIdentityLabels(entity: ExplicitCharacterIdentityEntity): string[] {
  return cleanStrings([entity.name, ...(entity.aliases ?? [])], 80)
    .filter((label) => label.length <= 100)
    .filter((label) => label.split(/\s+/u).length <= 8)
    .filter((label) => !/^(?:i|it|me|my|you|we|us|he|him|she|her|they|them|this|that|the|a|an)$/iu.test(label));
}

function quotedIdentitySpans(content: string): QuotedIdentitySpan[] {
  const spans: QuotedIdentitySpan[] = [];
  // Manuscripts commonly keep one speaker's quotation open across paragraph
  // breaks. Excluding newlines makes the closing quote look like a new opener,
  // which shifts every later dialogue pair and can hide an identity reveal.
  // Treat straight/smart double quotes as compatible delimiters because PDF
  // extraction can normalize only one side of a pair.
  const pattern = /["“]([^"“”]+)["”]/gu;
  for (const match of content.matchAll(pattern)) {
    const start = match.index ?? -1;
    if (start < 0) continue;
    spans.push({
      content: match[1] ?? "",
      start,
      end: start + match[0].length,
    });
  }
  return spans;
}

function qualifiedIdentityClaim(content: string, occurrenceIndex: number, occurrenceLength: number): boolean {
  const nearby = content.slice(
    Math.max(0, occurrenceIndex - 80),
    Math.min(content.length, occurrenceIndex + occurrenceLength + 80),
  );
  if (/\b(?:not|never|might|may|could|possibly|perhaps|pretend(?:ed|ing)?|claim(?:ed|s)?\s+to\s+be)\b/iu.test(nearby)) {
    return true;
  }
  const clauseBefore = content.slice(Math.max(0, occurrenceIndex - 120), occurrenceIndex);
  const clauseStart = Math.max(
    clauseBefore.lastIndexOf("."),
    clauseBefore.lastIndexOf("!"),
    clauseBefore.lastIndexOf("?"),
    clauseBefore.lastIndexOf(";"),
  );
  const activePrefix = clauseBefore.slice(clauseStart + 1);
  if (/\b(?:if|whether|suppose|supposing|assuming|imagine|imagining)\b/iu.test(activePrefix)) return true;
  const clauseAfter = content.slice(
    occurrenceIndex + occurrenceLength,
    Math.min(content.length, occurrenceIndex + occurrenceLength + 180),
  );
  const question = clauseAfter.indexOf("?");
  const statement = clauseAfter.search(/[.!]/u);
  return question >= 0 && (statement < 0 || question < statement);
}

function identityLabelOccurrenceIsStandalone(content: string, occurrenceIndex: number, occurrenceLength: number): boolean {
  const matched = content.slice(occurrenceIndex, occurrenceIndex + occurrenceLength);
  const suffix = content.slice(occurrenceIndex + occurrenceLength, occurrenceIndex + occurrenceLength + 8);
  // `I am Shanta's father` describes a relationship; it does not assert that
  // the speaker is Shanta. A permissive optional quote can consume the
  // apostrophe, so handle both possible match endings.
  if (/['’]$/u.test(matched) && /^s\b/iu.test(suffix)) return false;
  if (/^['’]s\b/iu.test(suffix)) return false;
  return true;
}

function competingConcreteSense(input: {
  label: string;
  chunks: IdentityChunk[];
}): boolean {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${regexEscape(input.label)}(?![\\p{L}\\p{N}_])`, "giu");
  for (const chunk of input.chunks) {
    for (const match of chunk.content.matchAll(pattern)) {
      const index = match.index ?? -1;
      if (index < 0) continue;
      const nearby = chunk.content.slice(Math.max(0, index - 150), Math.min(chunk.content.length, index + match[0].length + 150));
      const immediatelyBefore = chunk.content.slice(Math.max(0, index - 130), index);
      const identityUse = /(?:\b(?:known|called|rendered)\b[^.!?]{0,100}\bas|\bI\s+(?:am|was|remain|became)|\bmy\s+(?:birth|true|real)\s+name\s+(?:is|was))\s+(?:the\s+)?["'“‘]?\s*$/iu.test(immediatelyBefore);
      // A preposition alone does not create a concrete sense: people routinely
      // receive messages "from Dave" or have attention directed "towards
      // David". Preserve a same-named physical entity only when the occurrence
      // itself has explicit object/place/celestial grammar. This still keeps a
      // planetary Jupiter separate from a mythic identity while allowing a
      // directly self-declared familiar name to merge two character rows.
      const escapedLabel = regexEscape(input.label);
      const concreteUse = new RegExp(
        `(?:\\b(?:planet|moon|world|city|town|village|settlement|building|station|ship|spacecraft|telescope|projector|image|map)\\s+(?:called|named|known\\s+as|of|showing|depicting)\\s+(?:the\\s+)?${escapedLabel}\\b|` +
        `\\b${escapedLabel}['’]s\\s+(?:orbit|atmosphere|surface|gravity|streets?|walls?|gates?|entrance|interior|exterior)\\b|` +
        `\\b(?:orbit(?:ed|ing)?\\s+(?:around\\s+)?|landed\\s+on\\s+|landing\\s+on\\s+|entered\\s+|stepped\\s+(?:inside|into)\\s+|moved\\s+(?:through|across|into)\\s+|travell?ed\\s+(?:through|across|into)\\s+)(?:the\\s+)?${escapedLabel}\\b|` +
        `\\b${escapedLabel}\\b\\s+and\\s+(?:its|the)\\s+moons?\\b)`,
        "iu",
      ).test(nearby);
      if (concreteUse && !identityUse) return true;
    }
  }
  return false;
}

/**
 * Resolve only identities the manuscript states explicitly. The result is
 * calculated as a graph before any row is changed, so A -> B and B -> C yield
 * the same survivor regardless of row or chapter order. Figurative similarity,
 * spelling resemblance, and ordinary coordination never create an edge.
 */
export function resolveExplicitCharacterIdentities(input: {
  entities: ExplicitCharacterIdentityEntity[];
  chunks: IdentityChunk[];
  targetCharacterNames?: string[];
}): ExplicitCharacterIdentityResolution[] {
  const entities = input.entities.filter(explicitIdentityEntityIsEligible);
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const labelsById = new Map(entities.map((entity) => [entity.id, explicitIdentityLabels(entity)]));
  const idsByLabel = new Map<string, string[]>();
  const canonicalIdsByLabel = new Map<string, string[]>();
  for (const entity of entities) {
    for (const label of labelsById.get(entity.id) ?? []) {
      const key = normalized(label);
      idsByLabel.set(key, [...(idsByLabel.get(key) ?? []), entity.id]);
      if (key === normalized(entity.name)) {
        canonicalIdsByLabel.set(key, [...(canonicalIdsByLabel.get(key) ?? []), entity.id]);
      }
    }
  }
  const labels = [...idsByLabel.keys()]
    .map((key) => labelsById.get((canonicalIdsByLabel.get(key) ?? idsByLabel.get(key) ?? [])[0] ?? "")
      ?.find((label) => normalized(label) === key) ?? "")
    .filter(Boolean)
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  if (labels.length < 2) return [];
  const labelAlternation = labels.map(regexEscape).join("|");
  const labelMatcher = new RegExp(`(?<![\\p{L}\\p{N}_])(${labelAlternation})(?![\\p{L}\\p{N}_])`, "giu");

  const resolveLabelId = (
    label: string,
    targetIsEligible: (entity: ExplicitCharacterIdentityEntity) => boolean = directIdentityTargetIsEligible,
  ): string | null => {
    const key = normalized(label);
    const canonical = (canonicalIdsByLabel.get(key) ?? [])
      .filter((id) => targetIsEligible(entityById.get(id)!));
    if (canonical.length === 1) return canonical[0]!;
    const ids = (idsByLabel.get(key) ?? [])
      .filter((id) => targetIsEligible(entityById.get(id)!));
    if (ids.length === 1) return ids[0]!;
    const established = ids.filter((id) => establishedCharacterDossier(entityById.get(id)!));
    return established.length === 1 ? established[0]! : null;
  };
  const labelsIn = (
    content: string,
    targetIsEligible: (entity: ExplicitCharacterIdentityEntity) => boolean = directIdentityTargetIsEligible,
  ): Array<{ id: string; label: string; index: number; length: number }> => {
    const output: Array<{ id: string; label: string; index: number; length: number }> = [];
    const matcher = new RegExp(labelMatcher.source, labelMatcher.flags);
    for (const match of content.matchAll(matcher)) {
      const id = resolveLabelId(match[1] ?? match[0], targetIsEligible);
      if (!id) continue;
      if (!identityLabelOccurrenceIsStandalone(content, match.index ?? 0, match[0].length)) continue;
      output.push({ id, label: cleanText(match[1] ?? match[0], 100), index: match.index ?? 0, length: match[0].length });
    }
    return output;
  };
  const nearestEntityBefore = (content: string, index: number): string | null => {
    const start = Math.max(0, index - 520);
    return labelsIn(content.slice(start, index)).at(-1)?.id ?? null;
  };
  const entityAtPerspective = (chunk: IdentityChunk): string | null => {
    const perspective = normalized(chapterPerspective(chunk.metadata));
    if (!perspective) return null;
    return resolveLabelId(perspective);
  };
  const entityHasPerspective = (entityId: string): boolean => input.chunks.some((chunk) =>
    entityAtPerspective(chunk) === entityId
  );
  const namedActorBeforeQuote = (chunk: IdentityChunk, span: QuotedIdentitySpan): string | null => {
    const before = chunk.content.slice(Math.max(0, span.start - 260), span.start);
    const pattern = new RegExp(
      `(${labelAlternation})[^.!?"“”]{0,80}\\b(?:smiled|grinned|laughed|chuckled|` +
      `nodded|sighed|shrugged|paused|continued|answered|replied)\\b[^.!?"“”]{0,80}[.!?]\\s*$`,
      "giu",
    );
    const matches = [...before.matchAll(pattern)];
    return matches.at(-1)?.[1] ? resolveLabelId(matches.at(-1)![1]!) : null;
  };
  const speakerForQuote = (chunk: IdentityChunk, span: QuotedIdentitySpan): string | null => {
    const after = chunk.content.slice(span.end, Math.min(chunk.content.length, span.end + 220));
    const afterPattern = new RegExp(
      `^\\s*[,;:—–-]*\\s*(?:(${labelAlternation})|(he|she|they)|(I))\\s+(?:${SPEECH_VERBS})\\b`,
      "iu",
    );
    const afterMatch = afterPattern.exec(after);
    if (afterMatch?.[1]) return resolveLabelId(afterMatch[1]);
    if (afterMatch?.[2]) return nearestEntityBefore(chunk.content, span.start);
    if (afterMatch?.[3]) return entityAtPerspective(chunk);
    const before = chunk.content.slice(Math.max(0, span.start - 300), span.start);
    const beforePattern = new RegExp(`(${labelAlternation})[^.!?"“”]{0,100}\\b(?:${SPEECH_VERBS})\\b[^.!?"“”]{0,30}$`, "giu");
    const beforeMatches = [...before.matchAll(beforePattern)];
    if (beforeMatches.at(-1)?.[1]) return resolveLabelId(beforeMatches.at(-1)![1]!);
    if (new RegExp(`\\bI\\s+(?:${SPEECH_VERBS})\\b[^.!?"“”]{0,50}$`, "iu").test(before)) {
      return entityAtPerspective(chunk);
    }
    return null;
  };
  const adjacentSpeaker = (chunk: IdentityChunk, prior: QuotedIdentitySpan, next: QuotedIdentitySpan, speakerId: string): boolean => {
    const gap = chunk.content.slice(prior.end, next.start);
    if (gap.length > 620 || (gap.match(/\n\s*\n/gu) ?? []).length > 1) return false;
    const namedSpeech = new RegExp(`(${labelAlternation})[^.!?"“”]{0,90}\\b(?:${SPEECH_VERBS})\\b`, "giu");
    for (const match of gap.matchAll(namedSpeech)) {
      const id = resolveLabelId(match[1] ?? "");
      if (id && id !== speakerId) return false;
    }
    return true;
  };

  const concreteSenseCache = new Map<string, boolean>();
  const edges: ExplicitIdentityEdge[] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (candidate: Omit<ExplicitIdentityEdge, "mergeTarget">) => {
    const edge: ExplicitIdentityEdge = { ...candidate, mergeTarget: true };
    if (edge.sourceId === edge.targetId || !entityById.has(edge.sourceId) || !entityById.has(edge.targetId)) return;
    const senseKey = `${edge.targetId}:${normalized(edge.alias)}`;
    let hasConcreteSense = concreteSenseCache.get(senseKey);
    if (hasConcreteSense === undefined) {
      hasConcreteSense = competingConcreteSense({ label: edge.alias, chunks: input.chunks });
      concreteSenseCache.set(senseKey, hasConcreteSense);
    }
    // One surface can legitimately name both a concrete entity and a persona.
    // Keep the explicit, cited alias on the speaker without retiring the
    // independently supported concrete card (for example, the planet Jupiter).
    edge.mergeTarget = !hasConcreteSense;
    const key = `${edge.sourceId}:${edge.targetId}:${normalized(edge.alias)}:${edge.chunk.id}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(edge);
  };

  const directIdentityPatterns = [
    new RegExp(`\\bI\\s+(?:am|was|remain|became)\\s+(?:the\\s+)?["'“‘]?(${labelAlternation})["'”’]?`, "giu"),
  ];
  const directProperNamePatterns = [
    new RegExp(`\\bI\\s+(?:called\\s+myself|am\\s+called|was\\s+called|am\\s+known\\s+as|was\\s+known\\s+as)\\s+(?:the\\s+)?["'“‘]?(${labelAlternation})["'”’]?`, "giu"),
    new RegExp(`\\bmy\\s+(?:birth|true|real)\\s+name\\s+(?:is|was)\\s+(?:the\\s+)?["'“‘]?(${labelAlternation})["'”’]?`, "giu"),
    new RegExp(`\\bcall\\s+me\\s+(?:the\\s+)?["'“‘]?(${labelAlternation})["'”’]?`, "giu"),
  ];
  const continuationPatterns = [
    new RegExp(`\\bknown\\s+to\\s+(?:your\\s+kind|human\\s+kind|humankind|humans|humanity)\\s+as\\s+(?:the\\s+)?["'“‘]?(${labelAlternation})["'”’]?`, "giu"),
    new RegExp(`\\bknown\\s+among\\s+[^,;.!?]{1,90}?\\s+as\\s+(?:the\\s+)?["'“‘]?(${labelAlternation})["'”’]?`, "giu"),
    new RegExp(`\\bcalled\\s+by\\s+[^,;.!?]{1,90}?(?:\\s+as)?\\s+(?:the\\s+)?["'“‘]?(${labelAlternation})["'”’]?`, "giu"),
    new RegExp(`\\brendered\\s+as\\s+(?:the\\s+)?["'“‘]?(${labelAlternation})["'”’]?`, "giu"),
  ];
  for (const chunk of input.chunks) {
    const spans = quotedIdentitySpans(chunk.content);
    let priorIdentity: { span: QuotedIdentitySpan; speakerId: string } | null = null;
    let priorSpoken: { span: QuotedIdentitySpan; speakerId: string } | null = null;
    for (const span of spans) {
      let speakerId = speakerForQuote(chunk, span);
      let inheritedActionSpeaker = false;
      if (!speakerId && priorSpoken) {
        const gap = chunk.content.slice(priorSpoken.span.end, span.start);
        // A dialogue tag after one quotation can introduce a second quotation
        // by the same speaker: `David smiled. "Hello," he exclaimed. "Call me
        // Dave."`  Ground the continuation in the already resolved speaker;
        // do not guess an antecedent from the nearest proper noun inside the
        // first quotation (which may be the person being addressed).
        if (new RegExp(
          `^\\s*[,;:—–-]*\\s*(?:he|she|they)\\s+(?:${SPEECH_VERBS})\\b[^.!?"“”]{0,40}[.!?]\\s*$`,
          "iu",
        ).test(gap)) {
          speakerId = priorSpoken.speakerId;
          inheritedActionSpeaker = true;
        }
      }
      if (!speakerId) {
        // A brief action tag can ground an immediately following self-naming
        // quote (`David smiled. "Call me Dave."`) when the proposed familiar
        // identity also owns explicit POV chapters.  The unique label lookup,
        // named actor, direct declaration, and POV continuity are all required;
        // ordinary co-occurrence or spelling resemblance never creates an edge.
        const actorId = namedActorBeforeQuote(chunk, span);
        const directFamiliarTargets = [...span.content.matchAll(
          new RegExp(
            `\\bcall\\s+me\\s+(?:the\\s+)?["'“‘]?(${labelAlternation})["'”’]?`,
            "giu",
          ),
        )].flatMap((match) => {
          const targetId = resolveLabelId(match[1] ?? "", explicitProperNameTargetIsEligible);
          return targetId ? [targetId] : [];
        });
        if (
          actorId && establishedCharacterDossier(entityById.get(actorId)!) &&
          directFamiliarTargets.length === 1 &&
          directFamiliarTargets[0] !== actorId &&
          entityHasPerspective(directFamiliarTargets[0]!)
        ) speakerId = actorId;
      }
      if (!speakerId && priorIdentity && adjacentSpeaker(chunk, priorIdentity.span, span, priorIdentity.speakerId)) {
        speakerId = priorIdentity.speakerId;
      }
      const directMatches = directIdentityPatterns.flatMap((pattern) =>
        [...span.content.matchAll(new RegExp(pattern.source, pattern.flags))]
          .map((match) => ({ match, targetIsEligible: directIdentityTargetIsEligible })),
      ).concat(directProperNamePatterns.flatMap((pattern) =>
        [...span.content.matchAll(new RegExp(pattern.source, pattern.flags))]
          .map((match) => ({ match, targetIsEligible: explicitProperNameTargetIsEligible })),
      ));
      let suppliedIdentity = false;
      if (speakerId) {
        for (const { match, targetIsEligible } of directMatches) {
          const targetId = resolveLabelId(match[1] ?? "", targetIsEligible);
          const localIndex = match.index ?? 0;
          if (!targetId ||
            (inheritedActionSpeaker && !entityHasPerspective(targetId)) ||
            !identityLabelOccurrenceIsStandalone(span.content, localIndex, match[0].length) ||
            qualifiedIdentityClaim(span.content, localIndex, match[0].length)) continue;
          addEdge({
            sourceId: speakerId,
            targetId,
            alias: cleanText(match[1], 100),
            attributedBy: entityById.get(speakerId)?.name ?? null,
            chunk,
            occurrenceIndex: span.start + 1 + localIndex,
            occurrenceLength: match[0].length,
          });
          suppliedIdentity = true;
        }
        const hasSelfContext = suppliedIdentity || Boolean(priorIdentity && priorIdentity.speakerId === speakerId &&
          adjacentSpeaker(chunk, priorIdentity.span, span, speakerId)) || /\b(?:I|me|my|myself)\b/iu.test(span.content);
        if (hasSelfContext) {
          for (const pattern of continuationPatterns) {
            for (const match of span.content.matchAll(new RegExp(pattern.source, pattern.flags))) {
              const localIndex = match.index ?? 0;
              const prefix = span.content.slice(Math.max(0, localIndex - 55), localIndex);
              if (/\b(?:he|she|they|it|you)\s+(?:is|was|became|remains?)\s*$/iu.test(prefix)) continue;
              const targetId = resolveLabelId(match[1] ?? "", explicitProperNameTargetIsEligible);
              if (!targetId ||
                !identityLabelOccurrenceIsStandalone(span.content, localIndex, match[0].length) ||
                qualifiedIdentityClaim(span.content, localIndex, match[0].length)) continue;
              addEdge({
                sourceId: speakerId,
                targetId,
                alias: cleanText(match[1], 100),
                attributedBy: entityById.get(speakerId)?.name ?? null,
                chunk,
                occurrenceIndex: span.start + 1 + localIndex,
                occurrenceLength: match[0].length,
              });
              suppliedIdentity = true;
            }
          }
        }
      }
      priorIdentity = suppliedIdentity && speakerId ? { span, speakerId } : null;
      priorSpoken = speakerId ? { span, speakerId } : null;
    }

    const addNarrativeMatches = (pattern: RegExp, sourceGroup: number, targetGroup: number) => {
      for (const match of chunk.content.matchAll(pattern)) {
        const sourceId = resolveLabelId(match[sourceGroup] ?? "");
        if (!sourceId || qualifiedIdentityClaim(chunk.content, match.index ?? 0, match[0].length)) continue;
        const rawTargets = (match[targetGroup] ?? "").split(/\b(?:who|which|when|where|while|although|but)\b|[—–-]/iu)[0] ?? "";
        for (const target of labelsIn(rawTargets, explicitProperNameTargetIsEligible)) {
          addEdge({
            sourceId,
            targetId: target.id,
            alias: target.label,
            attributedBy: null,
            chunk,
            occurrenceIndex: (match.index ?? 0) + match[0].indexOf(target.label),
            occurrenceLength: target.length,
          });
        }
      }
    };
    addNarrativeMatches(
      new RegExp(`(${labelAlternation})\\s*,?\\s*(?:who\\s+)?(?:later\\s+)?(?:(?:became|was|is|remains?)\\s+)?(?:also\\s+)?known(?:\\s+to\\s+[^,;.!?]{1,70}|\\s+among\\s+[^,;.!?]{1,70})?\\s+as\\s+([^.!?]{1,180})`, "giu"),
      1,
      2,
    );
    addNarrativeMatches(
      new RegExp(`(${labelAlternation})\\s+(?:was|is)\\s+called\\s+([^.!?]{1,120}?)\\s+by\\s+[^.!?]{1,100}`, "giu"),
      1,
      2,
    );
    addNarrativeMatches(
      new RegExp(`(${labelAlternation})\\s+(?:was|is)\\s+called\\s+by\\s+[^.!?]{1,100}?\\s+(?:as\\s+)?((${labelAlternation}))`, "giu"),
      1,
      2,
    );
    addNarrativeMatches(
      new RegExp(`(${labelAlternation})\\s+(?:was|is)\\s+rendered\\s+as\\s+((${labelAlternation}))`, "giu"),
      1,
      2,
    );
  }

  const parent = new Map(entities.map((entity) => [entity.id, entity.id]));
  const find = (id: string): string => {
    const current = parent.get(id) ?? id;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  for (const edge of edges) {
    if (edge.mergeTarget) union(edge.sourceId, edge.targetId);
  }
  const memberIdsByRoot = new Map<string, string[]>();
  for (const entity of entities) {
    const root = find(entity.id);
    memberIdsByRoot.set(root, [...(memberIdsByRoot.get(root) ?? []), entity.id]);
  }
  const sourceVotes = new Map<string, number>();
  for (const edge of edges) sourceVotes.set(edge.sourceId, (sourceVotes.get(edge.sourceId) ?? 0) + 1);
  const requested = new Set((input.targetCharacterNames ?? []).map(normalized).filter(Boolean));
  const output: ExplicitCharacterIdentityResolution[] = [];
  for (const memberIds of memberIdsByRoot.values()) {
    const componentRoot = find(memberIds[0]!);
    const aliasOnlyEdges = edges.filter((edge) =>
      !edge.mergeTarget && find(edge.sourceId) === componentRoot,
    );
    if (
      (memberIds.length < 2 && aliasOnlyEdges.length === 0) ||
      !memberIds.some((id) => establishedCharacterDossier(entityById.get(id)!))
    ) continue;
    if (requested.size && !memberIds.some((id) =>
      (labelsById.get(id) ?? []).some((label) => requested.has(normalized(label))))) continue;
    const ranked = [...memberIds].sort((leftId, rightId) => {
      const left = entityById.get(leftId)!;
      const right = entityById.get(rightId)!;
      return Number(establishedCharacterDossier(right)) - Number(establishedCharacterDossier(left)) ||
        (sourceVotes.get(rightId) ?? 0) - (sourceVotes.get(leftId) ?? 0) ||
        Number((right.pullStatus ?? "active") === "active" && right.entityType === "character") -
          Number((left.pullStatus ?? "active") === "active" && left.entityType === "character") ||
        (right.mentionCount ?? 0) - (left.mentionCount ?? 0) ||
        left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
    });
    const survivorId = ranked[0]!;
    const stableMemberIds = [...memberIds].sort();
    const aliases = cleanStrings([
      ...stableMemberIds.flatMap((id) => labelsById.get(id) ?? []),
      ...aliasOnlyEdges.map((edge) => edge.alias),
    ], 200)
      .filter((alias) => normalized(alias) !== normalized(entityById.get(survivorId)!.name))
      .sort((left, right) => normalized(left).localeCompare(normalized(right)));
    const attributionFor = (edge: ExplicitIdentityEdge, alias: string): CharacterAliasAttribution => ({
        alias,
        kind: "identity_reveal",
        attributedBy: edge.attributedBy,
        explanation: `The manuscript explicitly identifies ${entityById.get(edge.sourceId)?.name ?? "this character"} as ${edge.alias}.`,
        temporalScope: "ongoing",
        semanticLimits: [],
        quote: excerpt(edge.chunk.content, edge.occurrenceIndex, edge.occurrenceLength),
        chunkId: edge.chunk.id,
        sourceId: edge.chunk.sourceId,
        sourceTitle: edge.chunk.sourceTitle,
        chapterTitle: cleanText(edge.chunk.metadata.sectionTitle, 500),
        confidence: 0.99,
      });
    const mergedAttributions = stableMemberIds.filter((id) => id !== survivorId).flatMap((id) => {
      const edge = edges.find((candidate) =>
        candidate.mergeTarget && (candidate.targetId === id || candidate.sourceId === id),
      );
      if (!edge) return [];
      const member = entityById.get(id)!;
      return [attributionFor(edge, edge.targetId === id ? edge.alias : member.name)];
    });
    const attributions = cleanStrings([
      ...mergedAttributions.map((entry) => entry.alias),
      ...aliasOnlyEdges.map((edge) => edge.alias),
    ], 200).flatMap((alias) => {
      const merged = mergedAttributions.find((entry) => normalized(entry.alias) === normalized(alias));
      if (merged) return [merged];
      const edge = aliasOnlyEdges.find((candidate) => normalized(candidate.alias) === normalized(alias));
      return edge ? [attributionFor(edge, edge.alias)] : [];
    });
    output.push({ survivorId, memberIds: stableMemberIds, aliases, attributions });
  }
  return output.sort((left, right) => left.survivorId.localeCompare(right.survivorId));
}

function candidateAliasSurface(name: string, content: string): string {
  const escaped = regexEscape(name.replace(/^(?:Mr|Mrs|Ms|Miss|Dr|Doctor|Professor)\.?\s+/iu, ""));
  const titled = new RegExp(`\\b(?:Mr|Mrs|Ms|Miss|Dr|Doctor|Professor)\\.?\\s+${escaped}\\b`, "u").exec(content)?.[0];
  return titled || name;
}

function candidateAliasLooksUseful(input: {
  surface: string;
  targetGivenName: string;
  candidateHasActiveDossier: boolean;
}): boolean {
  const words = input.surface.split(/\s+/u).filter(Boolean);
  if (words.length < 1 || words.length > 4 || input.surface.length > 80) return false;
  if (!/^(?:(?:Mr|Mrs|Ms|Miss|Dr|Doctor|Professor|Sir|Lady|Lord|Captain)\.?\s+)?\p{Lu}/u.test(input.surface)) {
    return false;
  }
  if (/^(?:I|It|Me|My|You|We|Us|He|Him|She|Her|They|Them|This|That|The|A|An)$/u.test(input.surface)) {
    return false;
  }
  if (
    input.candidateHasActiveDossier &&
    !/^(?:Mr|Mrs|Ms|Miss|Dr|Doctor|Professor|Sir|Lady|Lord|Captain)\.?\s+/u.test(input.surface) &&
    !new RegExp(`\\b${regexEscape(input.targetGivenName)}\\b`, "iu").test(input.surface) &&
    !abbreviatedGivenName(input.surface, input.targetGivenName)
  ) return false;
  return true;
}

function taxonomyEvidenceQuotes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      const quote = cleanText(entry, 1_200);
      return quote ? [quote] : [];
    }
    const quote = cleanText(record(entry).quote, 1_200);
    return quote ? [quote] : [];
  });
}

function regularTaxonomySingular(pluralName: string): string | null {
  const value = cleanText(pluralName, 240);
  if (!value || value.split(/\s+/u).length > 5) return null;
  if (/[^aeiou]ies$/iu.test(value)) return `${value.slice(0, -3)}y`;
  if (/(?:s|x|z|ch|sh)es$/iu.test(value)) return value.slice(0, -2);
  if (/s$/iu.test(value) && !/(?:ss|us|is)$/iu.test(value)) return value.slice(0, -1);
  return null;
}

function taxonomyEvidenceSupportsLabel(entity: GeneratedTaxonomyIdentityEntity): boolean {
  const label = cleanText(entity.name, 240);
  if (!label) return false;
  const escaped = regexEscape(label);
  const labelPattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu");
  const biologicalCue = "creature|animal|canine|feline|avian|insect|beast|monster|organism|species|subspecies|breed|form|mutation|infected|nonhuman|predator|prey|claws?|fangs?|teeth|wings?|tails?|tentacles?|carapace|hide|fur|scales?|hiss(?:ed|es|ing)?|growl(?:ed|s|ing)?|snarl(?:ed|s|ing)?|roar(?:ed|s|ing)?|lunge(?:d|s|ing)?|crawl(?:ed|s|ing)?|stalk(?:ed|s|ing)?|hunt(?:ed|s|ing)?|bit(?:e|es|ing)?";
  const directSubject = new RegExp(
    `(?:${escaped}['’]s\\s+[^.!?]{0,90}\\b(?:${biologicalCue})\\b|` +
    `${escaped}\\b[^.!?]{0,70}\\b(?:${biologicalCue})\\b|` +
    `\\b(?:${biologicalCue})\\b[^.!?]{0,70}\\b${escaped}\\b)`,
    "iu",
  );
  return taxonomyEvidenceQuotes(entity.evidence).some((quote) =>
    labelPattern.test(quote) && directSubject.test(quote)
  );
}

function generatedTaxonomyIdentityIsEligible(entity: GeneratedTaxonomyIdentityEntity): boolean {
  return ["creature", "species"].includes(entity.entityType) &&
    (entity.pullStatus ?? "active") === "active" &&
    entity.scannerPresent === true &&
    !entity.userEditedAt &&
    entity.classificationSource !== "user" &&
    entity.reviewStatus !== "user_confirmed";
}

/**
 * Fold only exact, regular singular/plural variants of the same generated
 * non-person taxon. Both surfaces must carry their own biological or taxonomy
 * evidence. This is deliberately not a fuzzy-name resolver: people, arbitrary
 * concepts, and merely similar creature names remain separate.
 */
export function resolveGeneratedTaxonomyPluralIdentities(input: {
  entities: GeneratedTaxonomyIdentityEntity[];
}): GeneratedTaxonomyIdentityResolution[] {
  const entities = input.entities.filter(generatedTaxonomyIdentityIsEligible);
  const byCategoryAndName = new Map<string, GeneratedTaxonomyIdentityEntity[]>();
  for (const entity of entities) {
    const key = `${entity.entityType}:${normalized(entity.name)}`;
    byCategoryAndName.set(key, [...(byCategoryAndName.get(key) ?? []), entity]);
  }
  const used = new Set<string>();
  const output: GeneratedTaxonomyIdentityResolution[] = [];
  for (const plural of [...entities].sort((left, right) => left.id.localeCompare(right.id))) {
    if (used.has(plural.id)) continue;
    const singularName = regularTaxonomySingular(plural.name);
    if (!singularName) continue;
    const singulars = byCategoryAndName.get(`${plural.entityType}:${normalized(singularName)}`) ?? [];
    if (singulars.length !== 1) continue;
    const singular = singulars[0]!;
    if (singular.id === plural.id || used.has(singular.id)) continue;
    if (!taxonomyEvidenceSupportsLabel(singular) || !taxonomyEvidenceSupportsLabel(plural)) continue;
    // A taxonomy card names the lexical concept in singular form. Usage count
    // and an older linked dossier are evidence to transfer, not reasons to
    // expose a plural heading as the canonical identity.
    const survivor = singular;
    const memberIds = [singular.id, plural.id].sort() as [string, string];
    const aliases = cleanStrings([
      singular.name,
      ...(singular.aliases ?? []),
      plural.name,
      ...(plural.aliases ?? []),
    ], 80).filter((alias) => normalized(alias) !== normalized(survivor.name));
    output.push({ survivorId: survivor.id, memberIds, aliases });
    used.add(singular.id);
    used.add(plural.id);
  }
  return output.sort((left, right) => left.survivorId.localeCompare(right.survivorId));
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function structuredValueKey(value: unknown): string {
  if (typeof value === "string") return `text:${normalized(value)}`;
  const item = record(value);
  const name = normalized(item.name);
  const relationship = normalized(item.relationship);
  if (name) return `named:${name}:${relationship}`;
  return `json:${JSON.stringify(value)}`;
}

function mergeStructuredGeneratedValue(targetValue: unknown, sourceValue: unknown): unknown {
  if (Array.isArray(targetValue) || Array.isArray(sourceValue)) {
    const values = [
      ...(Array.isArray(targetValue) ? targetValue : []),
      ...(Array.isArray(sourceValue) ? sourceValue : []),
    ];
    const merged = new Map<string, unknown>();
    for (const value of values) {
      const key = structuredValueKey(value);
      const prior = merged.get(key);
      merged.set(key, prior === undefined ? value : mergeStructuredGeneratedValue(prior, value));
    }
    return [...merged.values()];
  }
  const target = record(targetValue);
  const source = record(sourceValue);
  if (Object.keys(target).length || Object.keys(source).length) {
    const targetConfidence = Number(target.confidence);
    const sourceConfidence = Number(source.confidence);
    const sourceIsStronger = Number.isFinite(sourceConfidence) &&
      (!Number.isFinite(targetConfidence) || sourceConfidence > targetConfidence);
    const preferred = sourceIsStronger ? source : target;
    const supporting = sourceIsStronger ? target : source;
    const output: Record<string, unknown> = { ...preferred };
    for (const key of new Set([...Object.keys(preferred), ...Object.keys(supporting)])) {
      const left = preferred[key];
      const right = supporting[key];
      if (Array.isArray(left) || Array.isArray(right) ||
        (Object.keys(record(left)).length || Object.keys(record(right)).length)) {
        output[key] = mergeStructuredGeneratedValue(left, right);
      } else if (left === undefined || left === null || left === "") {
        output[key] = right;
      }
    }
    return output;
  }
  return targetValue === undefined || targetValue === null || targetValue === ""
    ? sourceValue
    : targetValue;
}

/** Preserve the survivor's authored shape while unioning facts found only on a
 * generated split dossier. Stat-like records with confidence prefer the more
 * strongly evidenced value; arrays and relationship rows are deduplicated. */
export function mergeGeneratedIdentityProfiles(targetProfile: unknown, sourceProfile: unknown): Record<string, unknown> {
  return record(mergeStructuredGeneratedValue(record(targetProfile), record(sourceProfile)));
}

function generatedIdentityDossierIsProtected(row: Record<string, unknown>): boolean {
  return Boolean(row.user_edited_at || row.dossier_axis_user_changed_at || row.dossier_axis_user_override);
}

export async function updateGeneratedIdentityPresentationAtomic(params: {
  db: IdentityDb;
  entityId: string;
  dossierId: string;
  name: string;
  aliases: string[];
  attributions: CharacterAliasAttribution[];
}): Promise<boolean> {
  const result = await params.db.query<{ id: string }>(
    `WITH eligible AS (
       SELECT entity.id, entity.dossier_id
         FROM storyhold.world_entities entity
         JOIN storyhold.character_dossiers dossier ON dossier.id = entity.dossier_id
        WHERE entity.id = $1 AND entity.dossier_id = $2::uuid
          AND entity.pull_status = 'active' AND entity.scanner_present = true
          AND entity.classification_source <> 'user'
          AND entity.review_status <> 'user_confirmed'
          AND dossier.user_edited_at IS NULL AND dossier.axis_user_changed_at IS NULL
          AND dossier.axis_user_override IS NULL
        FOR UPDATE OF entity, dossier
     ), entity_update AS (
       UPDATE storyhold.world_entities entity
          SET name = $3, normalized_name = $4, aliases = $5::jsonb,
              alias_attributions = $6::jsonb, updated_at = now()
         FROM eligible
        WHERE entity.id = eligible.id
        RETURNING entity.id
     ), dossier_update AS (
       UPDATE storyhold.character_dossiers dossier
          SET name = $3, normalized_name = $4, aliases = $5::jsonb,
              alias_attributions = $6::jsonb, updated_at = now()
         FROM eligible
        WHERE dossier.id = eligible.dossier_id
          AND dossier.user_edited_at IS NULL AND dossier.axis_user_changed_at IS NULL
          AND dossier.axis_user_override IS NULL
        RETURNING dossier.id
     )
     SELECT id FROM entity_update`,
    [params.entityId, params.dossierId, params.name, normalized(params.name), json(params.aliases), json(params.attributions)],
  );
  return result.rows.length > 0;
}

export async function mergeGeneratedIdentityRowsAtomic(params: {
  db: IdentityDb;
  source: Record<string, unknown>;
  target: Record<string, unknown>;
  aliases: string[];
}): Promise<boolean> {
  const sourceDossierId = params.source.dossier_id ? String(params.source.dossier_id) : null;
  const targetDossierId = params.target.dossier_id ? String(params.target.dossier_id) : null;
  const mergedProfile = mergeGeneratedIdentityProfiles(
    params.target.dossier_profile,
    params.source.dossier_profile,
  );
  const mergedAxis = mergeGeneratedIdentityProfiles(
    params.target.dossier_axis_estimate,
    params.source.dossier_axis_estimate,
  );
  const mergedAttributions = mergeStructuredGeneratedValue(
    Array.isArray(params.target.dossier_alias_attributions) ? params.target.dossier_alias_attributions : [],
    Array.isArray(params.source.dossier_alias_attributions) ? params.source.dossier_alias_attributions : [],
  );
  const targetRole = String(params.target.dossier_role ?? "").trim();
  const sourceRole = String(params.source.dossier_role ?? "").trim();
  const roleRank = (role: string) => /(?:central|primary|point.of.view|protagonist)/iu.test(role) ? 3
    : /supporting/iu.test(role) ? 2 : role ? 1 : 0;
  const mergedRole = roleRank(sourceRole) > roleRank(targetRole) ? sourceRole : targetRole;
  const result = await params.db.query<{ source_entity_id: string }>(
    `WITH locked_dossiers AS (
       SELECT dossier.id, dossier.user_edited_at, dossier.axis_user_changed_at,
              dossier.axis_user_override
         FROM storyhold.character_dossiers dossier
        WHERE dossier.id IN ($7::uuid, $8::uuid)
        FOR UPDATE
     ), eligible AS (
       SELECT source.id AS source_entity_id, target.id AS target_entity_id
         FROM storyhold.world_entities source
         JOIN storyhold.world_entities target ON target.id = $2
        WHERE source.id = $1 AND source.id <> target.id
          AND source.pull_status = 'active' AND source.scanner_present = true
          AND target.pull_status = 'active' AND target.scanner_present = true
          AND source.classification_source <> 'user'
          AND source.review_status <> 'user_confirmed'
          AND target.classification_source <> 'user'
          AND target.review_status <> 'user_confirmed'
          AND (source.dossier_id IS NULL OR EXISTS (
            SELECT 1 FROM locked_dossiers locked WHERE locked.id = source.dossier_id
          ))
          AND (target.dossier_id IS NULL OR EXISTS (
            SELECT 1 FROM locked_dossiers locked WHERE locked.id = target.dossier_id
          ))
          AND NOT EXISTS (
            SELECT 1 FROM locked_dossiers protected
             WHERE protected.id IN (source.dossier_id, target.dossier_id)
               AND (protected.user_edited_at IS NOT NULL
                 OR protected.axis_user_changed_at IS NOT NULL
                 OR protected.axis_user_override IS NOT NULL)
          )
        FOR UPDATE OF source, target
     ), retired AS (
       UPDATE storyhold.world_entities source
          SET pull_status = 'merged', scanner_present = false,
              merged_into_entity_id = eligible.target_entity_id, updated_at = now()
         FROM eligible
        WHERE source.id = eligible.source_entity_id
        RETURNING source.id AS source_entity_id, eligible.target_entity_id
     ), entity_merge AS (
       UPDATE storyhold.world_entities target
          SET aliases = $3::jsonb,
              dossier_id = COALESCE(target.dossier_id, source.dossier_id),
              mention_count = target.mention_count + source.mention_count,
              mention_source_count = GREATEST(target.mention_source_count, source.mention_source_count, COALESCE((
                SELECT count(DISTINCT COALESCE(item->>'sourceId', item->>'source_id'))
                  FROM jsonb_array_elements(COALESCE(target.evidence, '[]'::jsonb) ||
                       COALESCE(source.evidence, '[]'::jsonb)) item
                 WHERE COALESCE(item->>'sourceId', item->>'source_id') IS NOT NULL
              ), 0)),
              summary = CASE
                WHEN trim(source.summary) = '' OR target.summary ILIKE '%' || source.name || '%' THEN target.summary
                ELSE trim(target.summary || ' ' || replace(source.summary, source.name, target.name))
              END,
              evidence = COALESCE(target.evidence, '[]'::jsonb) || COALESCE(source.evidence, '[]'::jsonb),
              details = COALESCE(target.details, '[]'::jsonb) || COALESCE(source.details, '[]'::jsonb),
              updated_at = now()
         FROM storyhold.world_entities source, retired
        WHERE target.id = retired.target_entity_id AND source.id = retired.source_entity_id
        RETURNING target.id, target.mention_count, target.mention_source_count
      ), dossier_merge AS (
        UPDATE storyhold.character_dossiers target
           SET aliases = $3::jsonb,
               alias_attributions = $4::jsonb,
               dossier_status = 'active',
               mention_count = entity_merge.mention_count,
              mention_source_count = entity_merge.mention_source_count,
              summary = CASE
                WHEN trim(source.summary) = '' OR target.summary ILIKE '%' || source.name || '%' THEN target.summary
                ELSE trim(target.summary || ' ' || replace(source.summary, source.name, target.name))
              END,
              profile = $5::jsonb, axis_estimate = $6::jsonb, role = $9,
              evidence = COALESCE(target.evidence, '[]'::jsonb) || COALESCE(source.evidence, '[]'::jsonb),
              confidence = GREATEST(target.confidence, source.confidence), updated_at = now()
         FROM storyhold.character_dossiers source, retired, entity_merge
        WHERE target.id = $7::uuid AND source.id = $8::uuid
          AND target.id <> source.id
          AND target.user_edited_at IS NULL AND source.user_edited_at IS NULL
          AND target.axis_user_changed_at IS NULL AND source.axis_user_changed_at IS NULL
          AND target.axis_user_override IS NULL AND source.axis_user_override IS NULL
        RETURNING target.id
      ), dossier_transfer AS (
        UPDATE storyhold.character_dossiers dossier
           SET name = target.name, normalized_name = target.normalized_name,
               aliases = $3::jsonb, alias_attributions = $4::jsonb,
               dossier_status = 'active',
               mention_count = entity_merge.mention_count,
               mention_source_count = entity_merge.mention_source_count,
               updated_at = now()
         FROM storyhold.world_entities target, retired, entity_merge
        WHERE $7::uuid IS NULL AND dossier.id = $8::uuid
          AND target.id = retired.target_entity_id
          AND dossier.user_edited_at IS NULL AND dossier.axis_user_changed_at IS NULL
          AND dossier.axis_user_override IS NULL
        RETURNING dossier.id
      ), dossier_alias_only AS (
        UPDATE storyhold.character_dossiers dossier
           SET aliases = $3::jsonb, alias_attributions = $4::jsonb,
               dossier_status = 'active',
               mention_count = entity_merge.mention_count,
               mention_source_count = entity_merge.mention_source_count,
               updated_at = now()
         FROM retired, entity_merge
        WHERE dossier.id = $7::uuid AND ($8::uuid IS NULL OR $7::uuid = $8::uuid)
          AND dossier.user_edited_at IS NULL AND dossier.axis_user_changed_at IS NULL
          AND dossier.axis_user_override IS NULL
        RETURNING dossier.id
     ), contribution_move AS (
       UPDATE storyhold.character_dossier_source_contributions contribution
          SET dossier_id = $7::uuid, updated_at = now()
         FROM retired
        WHERE contribution.dossier_id = $8::uuid AND $7::uuid IS NOT NULL AND $7::uuid <> $8::uuid
          AND NOT EXISTS (
            SELECT 1 FROM storyhold.character_dossier_source_contributions target_contribution
             WHERE target_contribution.dossier_id = $7::uuid
               AND target_contribution.source_id = contribution.source_id
          )
       RETURNING contribution.id
     ), dossier_suppress AS (
       UPDATE storyhold.character_dossiers dossier
          SET dossier_status = 'suppressed', updated_at = now()
         FROM retired
        WHERE dossier.id = $8::uuid AND $7::uuid IS NOT NULL AND $7::uuid <> $8::uuid
          AND dossier.user_edited_at IS NULL AND dossier.axis_user_changed_at IS NULL
          AND dossier.axis_user_override IS NULL
        RETURNING dossier.id
     )
     SELECT source_entity_id FROM retired`,
    [
      params.source.id,
      params.target.id,
      json(params.aliases),
      json(mergedAttributions),
      json(mergedProfile),
      json(mergedAxis),
      targetDossierId,
      sourceDossierId,
      mergedRole,
    ],
  );
  return result.rows.length > 0;
}

/**
 * Repair evidence-explicit generated identities without asking a small model to
 * guess. This composes a formal name from a directly addressed surname, folds
 * safely addressed POV nicknames into that person, and records who used each
 * surface so the customer can inspect it.
 */
export async function repairGeneratedCharacterIdentities(params: {
  db: IdentityDb;
  worldId: string;
  editionId: string;
  targetCharacterNames?: string[];
}): Promise<{
  renamed: number;
  merged: number;
  aliasesAdded: number;
  targetIdentitySurfaces: string[];
}> {
  const [entityResult, chunkResult] = await Promise.all([
    params.db.query<Record<string, unknown>>(
      `SELECT entity.*, dossier.user_edited_at,
              dossier.profile AS dossier_profile,
              dossier.role AS dossier_role,
              dossier.axis_estimate AS dossier_axis_estimate,
              dossier.axis_user_override AS dossier_axis_user_override,
              dossier.axis_user_changed_at AS dossier_axis_user_changed_at,
              dossier.alias_attributions AS dossier_alias_attributions
         FROM storyhold.world_entities entity
         LEFT JOIN storyhold.character_dossiers dossier ON dossier.id = entity.dossier_id
        WHERE entity.world_id = $1 AND entity.canon_edition_id = $2
          AND entity.pull_status <> 'deleted'
        ORDER BY entity.mention_count DESC, entity.name`,
      [params.worldId, params.editionId],
    ),
    params.db.query<Record<string, unknown>>(
      `SELECT chunk.id, chunk.source_id, source.title AS source_title,
              chunk.content, chunk.metadata
         FROM storyhold.world_source_chunks chunk
         JOIN storyhold.world_sources source ON source.id = chunk.source_id
        WHERE chunk.world_id = $1 AND chunk.canon_edition_id = $2
          AND source.processing_status = 'ready'
          AND source.canon_status IN ('candidate', 'canon')
        ORDER BY source.chronology_order, source.sort_order, chunk.chunk_index`,
      [params.worldId, params.editionId],
    ),
  ]);
  const rows = entityResult.rows;
  const chunks: IdentityChunk[] = chunkResult.rows.map((row) => ({
    id: String(row.id),
    sourceId: String(row.source_id),
    sourceTitle: cleanText(row.source_title, 500),
    content: String(row.content ?? ""),
    metadata: record(row.metadata),
  }));
  const allActiveCharacters = rows.filter((row) =>
    row.entity_type === "character" && row.dossier_id && row.pull_status === "active" &&
    row.scanner_present === true && !generatedIdentityDossierIsProtected(row) &&
    row.classification_source !== "user" && row.review_status !== "user_confirmed",
  );
  const explicitResolutions = resolveExplicitCharacterIdentities({
    entities: rows.filter((row) =>
      !generatedIdentityDossierIsProtected(row) && row.classification_source !== "user" && row.review_status !== "user_confirmed" &&
      row.pull_status === "active" && row.scanner_present === true
    ).map((row) => ({
      id: String(row.id),
      name: cleanText(row.name, 240),
      aliases: Array.isArray(row.aliases) ? row.aliases.map(String) : [],
      entityType: String(row.entity_type),
      pullStatus: String(row.pull_status),
      scannerPresent: row.scanner_present === true,
      dossierId: row.dossier_id ? String(row.dossier_id) : null,
      mentionCount: Number(row.mention_count) || 0,
    })),
    chunks,
    // Structural identity repair is a whole-world invariant. A replay may
    // target a handful of expensive dossier syntheses, but an explicit
    // self-name or identity reveal elsewhere in the same world must still
    // collapse its split cards before those dossiers use the graph.
  });
  const explicitResolutionBySurvivor = new Map(
    explicitResolutions.map((resolution) => [resolution.survivorId, resolution]),
  );
  const explicitSurvivorByMemberId = new Map<string, string>();
  for (const resolution of explicitResolutions) {
    for (const memberId of resolution.memberIds) {
      explicitSurvivorByMemberId.set(memberId, resolution.survivorId);
    }
  }
  const targetNames = new Set(
    (params.targetCharacterNames ?? [])
      .map((name) => normalized(name))
      .filter(Boolean),
  );
  const eligibleSurvivors = allActiveCharacters.filter((row) => {
    const survivor = explicitSurvivorByMemberId.get(String(row.id));
    return !survivor || survivor === String(row.id);
  });
  const deepDiscoveryCharacters = targetNames.size
    ? eligibleSurvivors.filter((row) => {
        const resolution = explicitResolutionBySurvivor.get(String(row.id));
        const labels = cleanStrings([
          row.name,
          ...(Array.isArray(row.aliases) ? row.aliases : []),
          ...(resolution?.aliases ?? []),
        ]).map(normalized);
        return labels.some((label) => targetNames.has(label));
      })
    : eligibleSurvivors;
  const deepDiscoveryCharacterIds = new Set(
    deepDiscoveryCharacters.map((row) => String(row.id)),
  );
  const structuralProjectionCharacters = eligibleSurvivors.filter((row) =>
    explicitResolutionBySurvivor.has(String(row.id)) &&
    !deepDiscoveryCharacterIds.has(String(row.id))
  );
  const eligibleSurvivorById = new Map(
    eligibleSurvivors.map((row) => [String(row.id), row]),
  );
  const knownGivenNames = allActiveCharacters.map((row) => cleanText(row.name, 240));
  const canonicalNameByLabel: Record<string, string> = {};
  const knownCharacterLabels: string[] = [];
  for (const row of allActiveCharacters) {
    const canonical = cleanText(row.name, 240);
    for (const label of cleanStrings([
      canonical,
      ...(Array.isArray(row.aliases) ? row.aliases : []),
    ])) {
      knownCharacterLabels.push(label);
      canonicalNameByLabel[normalized(label)] = canonical;
    }
  }
  const pairedRevealByGivenName = new Map<string, {
    fullName: string;
    chunk: IdentityChunk;
    reveal: PairedSurnameReveal;
  }>();
  for (const chunk of chunks) {
    for (const reveal of pairedSurnameReveals({
      content: chunk.content,
      knownGivenNames,
    })) {
      for (const givenName of reveal.givenNames) {
        pairedRevealByGivenName.set(normalized(givenName), {
          fullName: `${givenName} ${reveal.surname}`,
          chunk,
          reveal,
        });
      }
    }
  }
  let renamed = 0;
  let merged = 0;
  let aliasesAdded = 0;
  const mergeTargetBySourceId = new Map<string, string>();
  for (const resolution of explicitResolutions) {
    for (const memberId of resolution.memberIds) {
      if (memberId !== resolution.survivorId) {
        mergeTargetBySourceId.set(memberId, resolution.survivorId);
      }
    }
  }

  // Explicit identity statements are a whole-world structural invariant, even
  // when a maintenance replay requests expensive portrait work for only a few
  // principals. Project the cited aliases for every unrequested survivor and
  // leave the broader surname/nickname/perspective search to the requested set.
  // This keeps a non-target identity such as `David -> Raider Dave` mergeable
  // without multiplying corpus-wide discovery by every explicit component.
  for (const target of structuralProjectionCharacters) {
    const identityResolution = explicitResolutionBySurvivor.get(String(target.id));
    if (!identityResolution) continue;
    const existingAliases = cleanStrings(Array.isArray(target.aliases) ? target.aliases : []);
    const cleanedAliases = cleanStrings([
      ...existingAliases,
      ...identityResolution.aliases,
    ])
      .filter((alias) => normalized(alias) !== normalized(target.name))
      .filter((alias) => !/\bfuck(?:in|ing)?\b/iu.test(alias));
    const retainedAttributions = [
      ...(Array.isArray(target.alias_attributions) ? target.alias_attributions : []),
      ...(Array.isArray(target.dossier_alias_attributions) ? target.dossier_alias_attributions : []),
    ].flatMap((entry) => {
      const parsed = normalizeCharacterAliasAttribution(entry);
      return parsed ? [parsed] : [];
    });
    const attributions = cleanStrings([
      ...identityResolution.attributions.map((entry) => entry.alias),
      ...retainedAttributions.map((entry) => entry.alias),
    ]).flatMap((alias) => {
      const explicit = identityResolution.attributions.find((entry) =>
        normalized(entry.alias) === normalized(alias)
      );
      if (explicit) return [explicit];
      return retainedAttributions.filter((entry) =>
        normalized(entry.alias) === normalized(alias)
      ).slice(0, 1);
    });
    const presentationUpdated = await updateGeneratedIdentityPresentationAtomic({
      db: params.db,
      entityId: String(target.id),
      dossierId: String(target.dossier_id),
      name: cleanText(target.name, 240),
      aliases: cleanedAliases,
      attributions,
    });
    if (!presentationUpdated) {
      for (const [sourceId, mergeTargetId] of mergeTargetBySourceId) {
        if (mergeTargetId === String(target.id)) mergeTargetBySourceId.delete(sourceId);
      }
      continue;
    }
    aliasesAdded += cleanedAliases.filter((alias) =>
      !existingAliases.some((prior) => normalized(prior) === normalized(alias))
    ).length;
    target.aliases = cleanedAliases;
    target.alias_attributions = attributions;
    target.dossier_alias_attributions = attributions;
  }

  for (const target of deepDiscoveryCharacters) {
    if (mergeTargetBySourceId.has(String(target.id))) continue;
    const priorName = cleanText(target.name, 240);
    const givenName = priorName.split(/\s+/u)[0] ?? priorName;
    const perspectiveChunks = chunks.filter((chunk) => {
      const perspective = chapterPerspective(chunk.metadata);
      return normalized(perspective) === normalized(givenName) || normalized(perspective) === normalized(priorName);
    });
    let canonicalName = priorName;
    const existingAliases = cleanStrings(Array.isArray(target.aliases) ? target.aliases : []);
    const identityResolution = explicitResolutionBySurvivor.get(String(target.id));
    const aliases = [...existingAliases, ...(identityResolution?.aliases ?? [])];
    const explicitAttributions: CharacterAliasAttribution[] = [...(identityResolution?.attributions ?? [])];
    explicitAttributions.push(...selfDeclaredAliasAttributions({
      canonicalName: priorName,
      aliases,
      chunks: perspectiveChunks,
    }));

    // A short-form name can be established without an explicit "X is Y"
    // sentence when another speaker directly addresses the established person
    // by that form while interrupting their reply. Keep this intentionally
    // narrow: no spelling similarity or nickname dictionary is sufficient.
    const targetMentionCount = Math.max(0, Number(target.mention_count ?? 0));
    for (const candidate of allActiveCharacters) {
      if (
        candidate.id === target.id || mergeTargetBySourceId.has(String(candidate.id)) ||
        targetMentionCount < Math.max(5, Math.max(0, Number(candidate.mention_count ?? 0)) * 3)
      ) continue;
      const candidateLabels = cleanStrings([
        candidate.name,
        ...(Array.isArray(candidate.aliases) ? candidate.aliases : []),
      ]);
      for (const label of candidateLabels) {
        const witness = directlyAddressedAliasOfEstablishedCharacter({
          canonicalNames: [priorName, ...existingAliases],
          alias: label,
          chunks,
        });
        if (!witness) continue;
        aliases.push(label);
        mergeTargetBySourceId.set(String(candidate.id), String(target.id));
        explicitAttributions.push({
          alias: label,
          kind: aliasKind(label, priorName),
          attributedBy: witness.attributedBy,
          explanation: `${witness.attributedBy ?? "Another character"} directly addresses ${priorName} as ${label} in the cited interruption.`,
          temporalScope: "ongoing",
          semanticLimits: [],
          quote: witness.quote,
          chunkId: witness.chunk.id,
          sourceId: witness.chunk.sourceId,
          sourceTitle: witness.chunk.sourceTitle,
          chapterTitle: cleanText(witness.chunk.metadata.sectionTitle, 500),
          confidence: 0.98,
        });
        break;
      }
    }

    if (!priorName.includes(" ")) {
      const paired = pairedRevealByGivenName.get(normalized(givenName));
      const formalMatch = perspectiveChunks
        .map((chunk) => ({
          chunk,
          formal: composeFormalCharacterName({
            givenName,
            content: chunk.content,
            metadata: chunk.metadata,
          }),
        }))
        .find((value): value is {
          chunk: IdentityChunk;
          formal: { name: string; addressedAs: string };
        } => Boolean(value.formal));
      const proposedName = paired?.fullName ?? formalMatch?.formal.name;
      const addressedAs = formalMatch?.formal.addressedAs;
      if (proposedName && !rows.some((row) =>
        row.id !== target.id && row.pull_status === "active" && normalized(row.name) === normalized(proposedName)
      )) {
        canonicalName = proposedName;
        aliases.push(priorName, ...(addressedAs ? [addressedAs] : []));
        if (paired) {
          explicitAttributions.push({
            alias: priorName,
            kind: "familiar_name",
            attributedBy: null,
            explanation: `The manuscript reveals ${canonicalName} through the shared-surname line involving ${paired.reveal.givenNames.join(" and ")}.`,
            temporalScope: "ongoing",
            semanticLimits: [],
            quote: paired.reveal.quote,
            chunkId: paired.chunk.id,
            sourceId: paired.chunk.sourceId,
            sourceTitle: paired.chunk.sourceTitle,
            chapterTitle: cleanText(paired.chunk.metadata.sectionTitle, 500),
            confidence: 0.96,
          });
        } else if (formalMatch && addressedAs) {
          explicitAttributions.push({
            alias: addressedAs,
            kind: "formal_address",
            attributedBy: nearestNamedSpeaker({
              content: formalMatch.chunk.content,
              occurrenceIndex: aliasOccurrence(formalMatch.chunk.content, addressedAs),
              knownCharacterNames: knownGivenNames,
              excludedNames: [priorName, canonicalName],
            }),
            explanation: `This direct form of address supplies ${canonicalName}'s surname.`,
            temporalScope: "ongoing",
            semanticLimits: [],
            quote: excerpt(
              formalMatch.chunk.content,
              aliasOccurrence(formalMatch.chunk.content, addressedAs),
              addressedAs.length,
            ),
            chunkId: formalMatch.chunk.id,
            sourceId: formalMatch.chunk.sourceId,
            sourceTitle: formalMatch.chunk.sourceTitle,
            chapterTitle: cleanText(formalMatch.chunk.metadata.sectionTitle, 500),
            confidence: 0.97,
          });
        }
        const surname = canonicalName.split(/\s+/u).at(-1) ?? "";
        for (const source of rows) {
          if (
            source.id === target.id || source.pull_status !== "active" || source.scanner_present !== true ||
            generatedIdentityDossierIsProtected(source) || source.classification_source === "user" ||
            source.review_status === "user_confirmed"
          ) continue;
          const sourceLabels = cleanStrings([source.name, ...(Array.isArray(source.aliases) ? source.aliases : [])]);
          if (!sourceLabels.some((label) => {
            const bare = label.replace(/^(?:Mr|Mrs|Ms|Miss|Dr|Doctor|Professor)\.?\s+/iu, "");
            return normalized(bare) === normalized(surname);
          })) continue;
          mergeTargetBySourceId.set(String(source.id), String(target.id));
          aliases.push(...sourceLabels);
        }
      }
    }

    const candidateRows = rows.filter((candidate) =>
      candidate.id !== target.id && !generatedIdentityDossierIsProtected(candidate) &&
      candidate.pull_status === "active" && candidate.scanner_present === true &&
      candidate.classification_source !== "user" &&
      candidate.review_status !== "user_confirmed" &&
      ["character", "title", "ambiguous"].includes(String(candidate.entity_type)) &&
      !explicitSurvivorByMemberId.has(String(candidate.id)),
    );
    for (const candidate of candidateRows) {
      const candidateLabels = cleanStrings([candidate.name, ...(Array.isArray(candidate.aliases) ? candidate.aliases : [])]);
      for (const label of candidateLabels) {
        for (const chunk of perspectiveChunks) {
          const surface = candidateAliasSurface(label, chunk.content);
          if (!candidateAliasLooksUseful({
            surface,
            targetGivenName: givenName,
            candidateHasActiveDossier: Boolean(candidate.dossier_id && candidate.scanner_present === true),
          })) continue;
          const addressed = aliasOccurrences(chunk.content, surface).some((occurrenceIndex) =>
            nicknameAddressesPerspective({
              alias: surface,
              canonicalName,
              content: chunk.content,
              metadata: chunk.metadata,
              occurrenceIndex,
            }),
          );
          if (!addressed) continue;
          aliases.push(surface);
          mergeTargetBySourceId.set(String(candidate.id), String(target.id));
          break;
        }
      }
    }

    const cleanedAliases = cleanStrings(aliases)
      .filter((alias) => normalized(alias) !== normalized(canonicalName))
      .filter((alias) => !/\bfuck(?:in|ing)?\b/iu.test(alias));
    const inferredAttributions = characterAliasAttributions({
      canonicalName,
      aliases: cleanedAliases,
      chunks: perspectiveChunks,
      knownCharacterNames: knownCharacterLabels,
      canonicalNameByLabel,
    });
    const retainedAttributions = (Array.isArray(target.alias_attributions)
      ? target.alias_attributions
      : []).flatMap((entry) => {
        const parsed = normalizeCharacterAliasAttribution(entry);
        return parsed ? [parsed] : [];
      });
    const attributions = cleanStrings([
      ...explicitAttributions.map((entry) => entry.alias),
      ...inferredAttributions.map((entry) => entry.alias),
      ...retainedAttributions.map((entry) => entry.alias),
    ]).flatMap((alias) => {
      const explicit = explicitAttributions.find((entry) => normalized(entry.alias) === normalized(alias));
      if (explicit) return [explicit];
      const inferred = inferredAttributions.find((entry) => normalized(entry.alias) === normalized(alias));
      if (inferred) return [inferred];
      return retainedAttributions.filter((entry) => normalized(entry.alias) === normalized(alias)).slice(0, 1);
    });
    const newAliasCount = cleanedAliases.filter((alias) =>
      !existingAliases.some((prior) => normalized(prior) === normalized(alias))
    ).length;
    const presentationUpdated = await updateGeneratedIdentityPresentationAtomic({
      db: params.db,
      entityId: String(target.id),
      dossierId: String(target.dossier_id),
      name: canonicalName,
      aliases: cleanedAliases,
      attributions,
    });
    if (!presentationUpdated) {
      for (const [sourceId, mergeTargetId] of mergeTargetBySourceId) {
        if (mergeTargetId === String(target.id)) mergeTargetBySourceId.delete(sourceId);
      }
      continue;
    }
    if (normalized(canonicalName) !== normalized(priorName)) renamed += 1;
    aliasesAdded += newAliasCount;
    target.name = canonicalName;
    target.aliases = cleanedAliases;
    // The merge immediately below must consume the attribution state that was
    // just persisted, not the stale dossier snapshot loaded before discovery.
    target.alias_attributions = attributions;
    target.dossier_alias_attributions = attributions;
  }

  for (const [entityId, targetId] of mergeTargetBySourceId) {
    const source = rows.find((row) => String(row.id) === entityId);
    if (
      !source || source.pull_status !== "active" || source.scanner_present !== true ||
      generatedIdentityDossierIsProtected(source) || source.classification_source === "user" ||
      source.review_status === "user_confirmed"
    ) continue;
    const target = eligibleSurvivorById.get(targetId);
    if (!target) continue;
    const completed = await mergeGeneratedIdentityRowsAtomic({
      db: params.db,
      source,
      target,
      aliases: Array.isArray(target.aliases) ? target.aliases.map(String) : [],
    });
    if (!completed) continue;
    source.pull_status = "merged";
    source.scanner_present = false;
    merged += 1;
  }

  // Generated scanners can persist the singular and plural surface of one
  // creature/taxon as separate rows. Repair that exact lexical split only
  // after category adjudication and character identity repair have completed;
  // explicit people and customer-owned rows are ineligible by construction.
  const taxonomyResolutions = resolveGeneratedTaxonomyPluralIdentities({
    entities: rows.map((row) => ({
      id: String(row.id),
      name: cleanText(row.name, 240),
      aliases: Array.isArray(row.aliases) ? row.aliases.map(String) : [],
      entityType: String(row.entity_type),
      pullStatus: String(row.pull_status),
      scannerPresent: row.scanner_present === true,
      dossierId: row.dossier_id ? String(row.dossier_id) : null,
      mentionCount: Number(row.mention_count) || 0,
      evidence: row.evidence,
      classificationSource: cleanText(row.classification_source, 40),
      reviewStatus: cleanText(row.review_status, 40),
      userEditedAt: generatedIdentityDossierIsProtected(row) ? true : null,
    })),
  });
  for (const resolution of taxonomyResolutions) {
    const target = rows.find((row) => String(row.id) === resolution.survivorId);
    const sourceId = resolution.memberIds.find((id) => id !== resolution.survivorId);
    const source = rows.find((row) => String(row.id) === sourceId);
    if (!target || !source || target.pull_status !== "active" || source.pull_status !== "active") continue;
    const aliases = cleanStrings([
      ...(Array.isArray(target.aliases) ? target.aliases : []),
      ...resolution.aliases,
    ], 80).filter((alias) => normalized(alias) !== normalized(target.name));
    const priorTargetDossierId = target.dossier_id ? String(target.dossier_id) : "";
    const resultingTargetDossierId = priorTargetDossierId || (source.dossier_id ? String(source.dossier_id) : "");
    const completed = await mergeGeneratedIdentityRowsAtomic({ db: params.db, source, target, aliases });
    if (!completed) continue;
    target.aliases = aliases;
    if (resultingTargetDossierId) target.dossier_id = resultingTargetDossierId;
    source.pull_status = "merged";
    source.scanner_present = false;
    merged += 1;
  }

  if (renamed || merged || aliasesAdded) {
    await syncWorldEntityMentions({ db: params.db, worldId: params.worldId, editionId: params.editionId });
  }
  const targetIdentitySurfaces = targetNames.size > 0
    ? cleanStrings([
        ...(params.targetCharacterNames ?? []),
        ...deepDiscoveryCharacters.flatMap((target) => [
          target.name,
          ...(Array.isArray(target.aliases) ? target.aliases : []),
        ]),
        ...explicitResolutions
          .filter((resolution) => deepDiscoveryCharacterIds.has(resolution.survivorId))
          .flatMap((resolution) => [
            ...resolution.aliases,
            ...resolution.memberIds.flatMap((memberId) => {
              const member = rows.find((row) => String(row.id) === memberId);
              return member
                ? [member.name, ...(Array.isArray(member.aliases) ? member.aliases : [])]
                : [];
            }),
          ]),
        ...[...mergeTargetBySourceId]
          .filter(([, targetId]) => deepDiscoveryCharacterIds.has(targetId))
          .flatMap(([sourceId]) => {
            const source = rows.find((row) => String(row.id) === sourceId);
            return source
              ? [source.name, ...(Array.isArray(source.aliases) ? source.aliases : [])]
              : [];
          }),
      ], 200)
    : [];
  return { renamed, merged, aliasesAdded, targetIdentitySurfaces };
}

/**
 * Project an explicit author correction into the identity card while leaving
 * the rest of the generated dossier eligible for future synthesis. The entity
 * identity is marked owner-confirmed so later machine passes cannot rename it.
 */
export async function applyOwnerCharacterNameCorrection(params: {
  db: IdentityDb;
  worldId: string;
  editionId: string;
  currentName: string;
  correctedName: string;
  instruction: string;
  suppliedQuote?: string;
}): Promise<{ entityId: string; dossierId: string; name: string } | null> {
  const currentKey = normalized(params.currentName);
  const correctedName = cleanText(params.correctedName, 240);
  if (!currentKey || !correctedName || !correctedName.includes(" ")) return null;
  const result = await params.db.query<Record<string, unknown>>(
    `SELECT entity.*, dossier.aliases AS dossier_aliases,
            dossier.alias_attributions AS dossier_alias_attributions
       FROM storyhold.world_entities entity
       JOIN storyhold.character_dossiers dossier ON dossier.id = entity.dossier_id
      WHERE entity.world_id = $1 AND entity.canon_edition_id = $2
        AND entity.entity_type = 'character' AND entity.pull_status = 'active'
        AND entity.scanner_present = true
        AND (entity.normalized_name = $3 OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(entity.aliases) alias
          WHERE lower(alias) = $3
        ))
      ORDER BY CASE WHEN entity.normalized_name = $3 THEN 0 ELSE 1 END
      LIMIT 1`,
    [params.worldId, params.editionId, currentKey],
  );
  const row = result.rows[0];
  if (!row?.dossier_id) return null;
  const collision = await params.db.query<{ id: string }>(
    `SELECT id FROM storyhold.world_entities
      WHERE world_id = $1 AND canon_edition_id = $2 AND normalized_name = $3
        AND id <> $4 AND pull_status = 'active'
      LIMIT 1`,
    [params.worldId, params.editionId, normalized(correctedName), row.id],
  );
  if (collision.rows[0]) {
    throw new Error(`Cannot confirm ${correctedName}; another active identity already uses that name.`);
  }
  const aliases = cleanStrings([
    params.currentName,
    row.name,
    ...(Array.isArray(row.aliases) ? row.aliases : []),
    ...(Array.isArray(row.dossier_aliases) ? row.dossier_aliases : []),
  ]).filter((alias) => normalized(alias) !== normalized(correctedName));
  const priorAttributions = Array.isArray(row.dossier_alias_attributions)
    ? row.dossier_alias_attributions.filter((entry) => entry && typeof entry === "object")
    : [];
  const ownerAttribution: CharacterAliasAttribution = {
    alias: cleanText(params.currentName, 240),
    kind: "owner_canon",
    attributedBy: null,
    explanation: cleanText(params.instruction, 1_000),
    temporalScope: "unknown",
    semanticLimits: [],
    quote: cleanText(params.suppliedQuote, 620),
    chunkId: "",
    sourceId: "",
    sourceTitle: "World Owner Direction",
    chapterTitle: "",
    confidence: 1,
  };
  const attributions = [
    ownerAttribution,
    ...priorAttributions.filter((entry) =>
      normalized(record(entry).alias) !== normalized(ownerAttribution.alias)
    ),
  ].slice(0, 40);
  await params.db.query(
    `UPDATE storyhold.world_entities
        SET name = $2, normalized_name = $3, aliases = $4::jsonb,
            alias_attributions = $5::jsonb,
            classification_source = 'user', review_status = 'user_confirmed',
            updated_at = now()
      WHERE id = $1`,
    [row.id, correctedName, normalized(correctedName), json(aliases), json(attributions)],
  );
  await params.db.query(
    `UPDATE storyhold.character_dossiers
        SET name = $2, normalized_name = $3, aliases = $4::jsonb,
            alias_attributions = $5::jsonb, updated_at = now()
      WHERE id = $1`,
    [row.dossier_id, correctedName, normalized(correctedName), json(aliases), json(attributions)],
  );
  await syncWorldEntityMentions({
    db: params.db,
    worldId: params.worldId,
    editionId: params.editionId,
  });
  return {
    entityId: String(row.id),
    dossierId: String(row.dossier_id),
    name: correctedName,
  };
}

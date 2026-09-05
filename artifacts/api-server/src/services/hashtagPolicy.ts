// ---------------------------------------------------------------------------
// Global hashtag policy — applied to EVERY caption generator (articles, memes,
// Term of the Day). Pure and logger-free so it stays unit-testable.
//
// Rules (per editorial direction):
//  - Self-referential / brand tags are banned: they eat a hashtag slot and do
//    nothing for reach (#BrainHook, #TermOfTheDay, ...). The one exception is
//    the glossary term itself on Term of the Day posts — callers pass it via
//    `keep` so it survives even when it collides with a banned pattern.
//  - Mashed-together multi-topic tags are split into the real tags people
//    actually follow: #RelationshipsCommunication → #Relationships +
//    #Communication. Genuinely popular two-word tags (#MentalHealth,
//    #TrueCrime, #SpaceExploration) are left intact via a length heuristic.
// ---------------------------------------------------------------------------

/** Tags that must never appear — normalized to lowercase alphanumerics. */
const BANNED_TAGS = new Set([
  "brainhook",
  "brainhookmag",
  "brainhookmagazine",
  "brainhooknet",
  "termoftheday",
  "wordoftheday",
  "todaysterm",
  "glossary",
  "dailyterm",
]);

/**
 * Established multi-word tags people genuinely follow — never split, even
 * though the CamelCase heuristic would shred them (#TodayILearned → #Today +
 * #Learned). Normalized like BANNED_TAGS. These are learning/TIL-culture tags,
 * not brand tags, so they're reach-positive.
 */
const ESTABLISHED_TAGS = new Set([
  "todayilearned",
  "todayyearsold",
  "didyouknow",
  "funfact",
  "funfacts",
  "themoreyouknow",
  "nowyouknow",
  "smartereveryday",
  "dailyeducation",
  "learnsomethingnew",
  "learnsomethingneweveryday",
  "mindblown",
  "brainfood",
  "dailyfacts",
]);

/** Connector words dropped when a compound tag is split. */
const SPLIT_STOPWORDS = new Set([
  "and", "the", "of", "in", "on", "for", "a", "an", "to", "vs", "with",
]);

/** Normalize for ban comparison: lowercase, alphanumerics only. */
function norm(tag: string): string {
  return tag.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

/** Decompose a CamelCase/PascalCase token into its words (best effort). */
function camelWords(token: string): string[] {
  const matches = token.match(/[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g);
  return matches ?? [token];
}

/**
 * Split a compound tag into individual topic tags when it is clearly a
 * made-up mashup rather than an established two-word tag:
 *  - 3+ CamelCase words always split (#RelationshipsCommunicationTips)
 *  - 2 words split only when the combined token is long (> 16 chars), which
 *    keeps #MentalHealth / #TrueCrime / #SpaceExploration but splits
 *    #RelationshipsCommunication.
 */
function splitCompound(token: string): string[] {
  if (ESTABLISHED_TAGS.has(norm(token))) return [token];
  const words = camelWords(token);
  if (words.length < 2) return [token];
  const shouldSplit = words.length >= 3 || token.length > 16;
  if (!shouldSplit) return [token];
  return words
    .filter((w) => !SPLIT_STOPWORDS.has(w.toLowerCase()))
    .filter((w) => w.length >= 3)
    .map((w) => w[0]!.toUpperCase() + w.slice(1));
}

/**
 * Apply the global hashtag policy to bare tokens (no leading '#').
 * Returns cleaned, deduped tokens in original order, capped at `maxTags`.
 * Tokens listed in `keep` bypass the ban list (still deduped/capped) —
 * used for the Term of the Day term itself.
 */
export function sanitizeHashtagTokens(
  tokens: string[],
  opts?: { maxTags?: number; keep?: string[] },
): string[] {
  const keepSet = new Set((opts?.keep ?? []).map(norm));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tokens) {
    const token = raw.replace(/^#+/, "").trim();
    if (!token) continue;
    const tokenKey = norm(token);
    const kept = keepSet.has(tokenKey);
    // Ban whole tokens BEFORE splitting so #TermOfTheDay is dropped outright
    // rather than shredded into #Term + #Day.
    if (!kept && BANNED_TAGS.has(tokenKey)) continue;
    const pieces = kept ? [token] : splitCompound(token);
    for (const piece of pieces) {
      const key = norm(piece);
      if (!key || /^\d+$/.test(key)) continue;
      if (!keepSet.has(key) && BANNED_TAGS.has(key)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(piece);
    }
  }
  const max = opts?.maxTags ?? 8;
  return out.slice(0, Math.max(0, max));
}

/**
 * The popular "learned something new" tags Term-of-the-Day posts must ALWAYS
 * carry at least one of (editorial rule). Proper casing — these are emitted
 * as-is when injected. All must also be present in ESTABLISHED_TAGS so the
 * splitter never shreds them.
 */
export const LEARNING_TAGS = [
  "TodayILearned",
  "DidYouKnow",
  "FunFact",
  "TodayYearsOld",
  "TheMoreYouKnow",
  "SmarterEveryDay",
  "DailyEducation",
] as const;

const LEARNING_TAG_KEYS = new Set(LEARNING_TAGS.map(norm));

/**
 * Guarantee at least one popular learning/TIL tag in a sanitized token list.
 * If one is already present, the list is returned unchanged. Otherwise a tag
 * is picked deterministically from LEARNING_TAGS via `seed` (stable across
 * previews/retries) and appended — replacing the LAST tag when the list is
 * already at `maxTags` so the term tag (first) always survives.
 */
export function ensureLearningTag(
  tokens: string[],
  opts: { maxTags: number; seed: string },
): string[] {
  if (tokens.some((t) => LEARNING_TAG_KEYS.has(norm(t)))) return tokens;
  const code = [...opts.seed].reduce((s, ch) => s + ch.charCodeAt(0), 0);
  const tag = LEARNING_TAGS[code % LEARNING_TAGS.length]!;
  const max = Math.max(1, opts.maxTags);
  const out = tokens.slice(0, tokens.length >= max ? max - 1 : tokens.length);
  out.push(tag);
  return out;
}

/** Same policy for '#'-prefixed hashtag strings (the LLM pack shape). */
export function sanitizeHashtags(
  tags: string[],
  opts?: { maxTags?: number; keep?: string[] },
): string[] {
  return sanitizeHashtagTokens(tags, opts).map((t) => `#${t}`);
}

/**
 * Enforce the policy on hashtags embedded INSIDE freeform text (tweets,
 * Threads posts, alt captions). Banned tags are removed outright; mashed-up
 * compounds are split in place (#RelationshipsCommunication → #Relationships
 * #Communication). Leftover doubled spaces are collapsed.
 */
export function sanitizeInlineHashtags(text: string): string {
  return text
    .replace(/#([A-Za-z0-9_]+)/g, (_m, token: string) => {
      const cleaned = sanitizeHashtagTokens([token]);
      return cleaned.map((t) => `#${t}`).join(" ");
    })
    .replace(/[^\S\n]{2,}/g, " ")
    .replace(/[^\S\n]+([.,!?])/g, "$1")
    .trim();
}

/**
 * Shared prompt block describing the hashtag rules, appended to every
 * LLM caption prompt so the model and the deterministic sanitizer agree.
 */
export const HASHTAG_PROMPT_RULES = [
  "HASHTAG RULES (strict):",
  "- NEVER use self-referential or brand hashtags (#BrainHook, #TermOfTheDay,",
  "  or anything naming this publication) — they waste a tag and do nothing",
  "  for reach.",
  "- Prefer SINGLE-WORD tags people actually search and follow (#Relationships,",
  "  #Communication, #Psychology). Never mash two topics into one made-up tag:",
  "  use #Relationships #Communication, NOT #RelationshipsCommunication.",
  "- A two-word tag is allowed ONLY when it is a genuinely popular, established",
  "  tag (#MentalHealth, #TrueCrime, #SpaceExploration).",
  "- Established learning-culture tags are welcome where they fit:",
  "  #TodayILearned, #TodayYearsOld, #DidYouKnow, #FunFact, #TheMoreYouKnow,",
  "  #SmarterEveryDay, #DailyEducation.",
].join("\n");

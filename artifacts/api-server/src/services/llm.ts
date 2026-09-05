import { anthropic } from "@workspace/integrations-anthropic-ai";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  Author,
  ArticleBlock,
  HookMode,
  HookVariant,
  HookAssignments,
  SocialPack,
  MemeLayout,
  MemeArtStyle,
  MemeTextPlacement,
  MemeTextZone,
} from "@workspace/db";
import { MEME_TEXT_ZONES } from "@workspace/db";
import { EVIDENCE_DECISION } from "@workspace/db";
import type { EvidenceDecision } from "@workspace/db";
import { HOOK_MODES, hookModeSchema } from "@workspace/db";
import { z } from "zod/v4";
import { logger } from "../lib/logger";
import { isInternalLinkFinding } from "./verificationText";
import { getDefaultDirective, AI_TEXT_MODELS, ALLOWED_MODEL_IDS, DEFAULT_TEXT_MODEL } from "./aiRegistry";
import { resolveDirective, isAiFunctionEnabled, resolveModel } from "./aiSettings";
import { stripCitationTags, stripCiteTagsFromText, scrubInternalVocabulary, scrubInternalVocabFromText } from "./citations";
import { recordTextUsage } from "./aiUsage";
import { sanitizeHashtags, sanitizeInlineHashtags, HASHTAG_PROMPT_RULES } from "./hashtagPolicy";

// Thrown when an AI function is paused via the AI Control Center and the caller
// must skip cleanly (used by draft/hook generation, which degrade at the
// orchestrator level rather than returning a placeholder).
export class AiFunctionDisabledError extends Error {
  key: string;
  constructor(key: string) {
    super(`AI function "${key}" is disabled`);
    this.name = "AiFunctionDisabledError";
    this.key = key;
  }
}

// LLM draft output is restricted to prose block types only. The
// `relatedArticle` block is editor-only — it must never be invented by
// the model. Validate every draft against this narrower schema.
// The `takeaways` block is the one structured exception: the model may emit
// it with an `items` array (no `content`) for beats that support practical advice.
const DRAFT_BLOCK_TYPES = ["paragraph", "heading", "pullquote"] as const;
const draftProsBlockSchema = z.object({
  type: z.enum(DRAFT_BLOCK_TYPES),
  content: z.string().min(1),
});
const draftBlockSchema = z.union([
  draftProsBlockSchema,
  z.object({
    type: z.literal("takeaways"),
    items: z.array(z.string().min(1)).min(1).max(7),
  }),
]);

// Beats where a "What you can do" action callout doesn't make sense — pure
// spectacle, weirdness, or gross-out content that has no practical takeaway.
const SKIP_TAKEAWAYS_BEATS = new Set(["weird-creepy", "gross-science"]);

// Author-selectable models for the per-author model dropdown (admin authors
// page). The catalog + allow-set live in aiRegistry so aiSettings can validate a
// model override without importing llm.ts.
export const LLM_MODELS: { id: string; label: string }[] = AI_TEXT_MODELS.map((m) => ({
  id: m.id,
  label: m.label,
}));
const DEFAULT_MODEL = DEFAULT_TEXT_MODEL;

function authorModel(author: Author): string {
  return ALLOWED_MODEL_IDS.has(author.model) ? author.model : DEFAULT_MODEL;
}

function authorTemperature(author: Author): number {
  const raw = typeof author.temperature === "string" ? Number(author.temperature) : author.temperature;
  if (!Number.isFinite(raw)) return 1.0;
  return Math.max(0, Math.min(2, raw as number));
}

function authorMaxTokens(author: Author): number {
  const raw = author.maxTokens ?? 8192;
  return Math.max(1024, Math.min(16384, raw));
}

function axisLabel(value: number, leftLabel: string, rightLabel: string): string {
  const v = Math.max(-10, Math.min(10, value));
  if (v <= -7) return `strongly ${leftLabel}`;
  if (v <= -3) return `${leftLabel}-leaning`;
  if (v < 3) return `centrist on this axis`;
  if (v < 7) return `${rightLabel}-leaning`;
  return `strongly ${rightLabel}`;
}

function politicalCompassBlock(author: Author): string {
  const econ = typeof author.economicAxis === "string" ? Number(author.economicAxis) : (author.economicAxis as number | undefined);
  const social = typeof author.socialAxis === "string" ? Number(author.socialAxis) : (author.socialAxis as number | undefined);
  if (econ === undefined || social === undefined || (!Number.isFinite(econ) && !Number.isFinite(social))) return "";
  if ((econ ?? 0) === 0 && (social ?? 0) === 0) return "";
  const econLabel = axisLabel(econ ?? 0, "left", "right");
  const socialLabel = axisLabel(social ?? 0, "libertarian", "authoritarian");
  return `\n\nPolitical & cultural orientation (use as an undertone, not a soapbox — never lecture, never campaign):
- Economic axis: ${(econ ?? 0).toFixed(1)} on a -10 (far left) to +10 (far right) scale → ${econLabel}.
- Social axis: ${(social ?? 0).toFixed(1)} on a -10 (libertarian) to +10 (authoritarian) scale → ${socialLabel}.
This is taste and instinct, not a platform. Let it shape which questions you find interesting and how you frame trade-offs. Don't editorialize unless the topic actually calls for it.`;
}

function voiceCraftBlock(author: Author): string {
  const fields: { label: string; value: string | null | undefined }[] = [
    { label: "Tone", value: author.tone },
    { label: "Sentence rhythm", value: author.sentenceRhythm },
    { label: "Vocabulary quirks", value: author.vocabularyQuirks },
    { label: "Signature move", value: author.signatureMove },
    { label: "Core promise to the reader", value: author.corePromise },
    { label: "Avoid", value: author.avoid },
  ];
  const lines = fields
    .filter((f) => typeof f.value === "string" && f.value.trim().length > 0)
    .map((f) => `- ${f.label}: ${(f.value as string).trim()}`);
  if (lines.length === 0) return "";
  return `\n\nVoice craft (treat these as hard constraints on how the prose should feel):\n${lines.join("\n")}`;
}

function technicalRevoicingBlock(author: Author): string {
  const authorStyle = author.technicalExplanationStyle?.trim();
  return `

TECHNICAL RE-VOICING

Your voice does not clock out when the article becomes technical. Evidence controls what you may claim, how certain you may be, and what must be attributed. It does not control your prose register.

When explaining research, mechanisms, specialist terminology, law, policy, finance, medicine, psychology, history, or any other dense material:
- Digest the source material and reconstruct the explanation in your own established voice. Do not lightly paraphrase the source's syntax, density, or abstract-noun chains.
- Make the causal movement visible: what happens, what changes, what drives it, and why it matters to the reader or the article's argument.
- Prefer concrete verbs and observable consequences. Introduce formal terminology after the underlying idea is understandable when practical, and define specialist language at the point of use.
- Synthesize evidence into a coherent explanation instead of marching through studies one at a time.
- Preserve every important qualification, limitation, attribution, statistic, date, quotation, and degree of uncertainty from the evidence.
- Do not invent facts, examples presented as real, or extra specificity merely to make the passage vivid.
- Analogies, imagery, humor, personal framing, and anecdotes are available tools, not mandatory decorations. Use them only when they clarify the material and genuinely fit your voice.
- Avoid repetitive translation scaffolding such as "put simply," "in other words," and "what this means is." Let the explanation itself be clear.

A citation supports your explanation; it does not replace one. A citation-heavy paragraph should still sound like you understood the material and are walking the reader through it, not like a compressed literature review.${
    authorStyle
      ? `\n\nYour particular instinct for explaining technical material:\n${authorStyle}`
      : ""
  }`;
}

export function buildAuthorSystemPrompt(
  author: Author,
  opts: {
    allowedBeats?: { category: string; categorySlug: string; slant?: string | null }[];
    editorialStandards?: string;
    includeTechnicalRevoicing?: boolean;
  } = {},
): string {
  const editorialStandards = opts.editorialStandards ?? getDefaultDirective("draft_generation");
  const samples = author.sampleParagraphs?.length
    ? `\n\nHere are sample paragraphs in your voice. Match this style closely:\n\n${author.sampleParagraphs.map((p, i) => `Sample ${i + 1}:\n${p}`).join("\n\n")}`
    : "";
  const banned = author.bannedTopics?.length
    ? `\n\nNever write about: ${author.bannedTopics.join(", ")}.`
    : "";
  const bio = author.bio?.trim()
    ? `\n\nPublic bio (this is how readers know you — let it shape what you choose to write about):\n${author.bio.trim()}`
    : "";
  const cadence = author.cadence?.trim()
    ? `\n\nPublishing cadence: ${author.cadence.trim()}.`
    : "";
  const subBeats = (opts.allowedBeats ?? []).filter((b) => b.categorySlug !== author.categorySlug);
  const subBeatBlock = subBeats.length
    ? `\n\nYour primary beat is ${author.category}, and it should anchor roughly half of your work — but your expertise legitimately spills into adjacent areas, and you should range into them regularly for variety and fresher angles. You also write for: ${subBeats.map((b) => b.category).join(", ")}. These are ADDITIONAL beats, and the only reason you can credibly cover them is your ${author.category} expertise — so always come at a sub-beat story THROUGH that primary lens. Write the angle only a ${author.category} writer would take: bring the questions, methods, and obsessions of ${author.category} to the sub-beat subject rather than covering it the way a generalist or a specialist in that other field would. (For example, a Political Science writer covering an adjacent science beat writes about its politics, policy, funding, institutions, and power struggles — never the underlying physics, chemistry, or biology.) Hard rules: no stretching — only write a sub-beat piece when your ${author.category} background genuinely lets you do it justice and you can ground it in the real science; and never drop your lens to write a generic piece in someone else's field. Variety comes from the distinctive angle your expertise gives you, never from hopping onto topics you can't cover believably.`
    : "";
  const slantBlock = (() => {
    const withSlants = (opts.allowedBeats ?? []).filter((b) => b.slant && b.slant.trim().length > 0);
    if (withSlants.length === 0) return "";
    const lines = withSlants.map((b) => `- ${b.category}: ${b.slant!.trim()}`).join("\n");
    return `\n\nEditorial slant for each beat (BrainHook's house take — let it shape both what you write about and how you frame it):\n${lines}`;
  })();
  return `You are ${author.name}, a writer for the magazine "BrainHook". You cover ${author.category}.${subBeatBlock}${bio}

${author.voicePrompt}

${editorialStandards}${voiceCraftBlock(author)}${opts.includeTechnicalRevoicing === false ? "" : technicalRevoicingBlock(author)}${politicalCompassBlock(author)}${slantBlock}${cadence}${banned}${samples}`;
}

export class NoSuitableAuthorError extends Error {
  candidates: { name: string; beats: string[] }[];
  constructor(message: string, candidates: { name: string; beats: string[] }[]) {
    super(message);
    this.name = "NoSuitableAuthorError";
    this.candidates = candidates;
  }
}

/**
 * Deterministic fallback author pick: score each writer by how many keywords
 * their beats + bio share with the idea, and return the best overlap. Used when
 * the LLM picker's answer can't be resolved (garbled id, out-of-range index, no
 * JSON) so a clearly-coverable topic never hard-blocks the editor.
 */
function pickByBeatOverlap(
  idea: { title: string; angle?: string },
  authors: { id: string; name: string; category: string; bio: string; subBeatNames?: string[] }[],
): { id: string; name: string } {
  const stop = new Set([
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "your", "you", "why",
    "how", "its", "is", "are", "that", "this", "still", "okay", "from", "about", "what", "when",
  ]);
  const toks = (s: string) =>
    new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !stop.has(w)));
  const ideaToks = toks(`${idea.title} ${idea.angle ?? ""}`);
  let best = authors[0]!;
  let bestScore = -1;
  for (const a of authors) {
    const hay = toks(`${a.category} ${(a.subBeatNames ?? []).join(" ")} ${a.bio}`);
    let score = 0;
    for (const t of ideaToks) if (hay.has(t)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  return { id: best.id, name: best.name };
}

export async function pickBestAuthorForIdea(
  idea: { title: string; angle?: string },
  authors: {
    id: string;
    name: string;
    category: string;
    bio: string;
    voicePrompt: string;
    subBeatNames?: string[];
    /** Recent assignments (articles + approved-idea bank) — see authorAssignment.ts. */
    recentLoad?: number;
    /** The topic's beat is this writer's PRIMARY beat (vs sub-beat coverage). */
    primaryFit?: boolean;
  }[],
): Promise<{ authorId: string; reason: string }> {
  if (authors.length === 0) throw new Error("No active authors available");
  if (authors.length === 1) return { authorId: authors[0]!.id, reason: "Only one active author." };
  if (!(await isAiFunctionEnabled("author_assignment"))) {
    return { authorId: authors[0]!.id, reason: "AI author assignment is paused; assigned the first active writer." };
  }
  const assignDirective = await resolveDirective("author_assignment");
  const hasLoadInfo = authors.some((a) => a.recentLoad != null);
  const list = authors
    .map((a, i) => {
      const beats = [a.category, ...(a.subBeatNames ?? [])].join(", ");
      const load =
        a.recentLoad != null
          ? `\n   current workload: ${a.recentLoad} recent assignment${a.recentLoad === 1 ? "" : "s"}`
          : "";
      return `${i + 1}. id=${a.id} | ${a.name}\n   beats: ${beats}${load}\n   bio: ${a.bio}\n   voice (excerpt): ${a.voicePrompt.slice(0, 600)}`;
    })
    .join("\n\n");
  // Fixed variety guidance (not part of the editable directive, so it always
  // applies when the caller supplied workload data): the ranked pool lists
  // writers lightest-loaded first, and sub-beat coverage is a genuine
  // qualification — the desk should not funnel every piece to the same
  // primary-beat specialist.
  const varietyBlock = hasLoadInfo
    ? `\nVariety matters: the writers are listed from lightest to heaviest current workload. Sub-beat coverage is a genuine qualification, not a consolation pick — when more than one writer plausibly covers this topic, prefer the lighter-loaded one (including a writer who covers it as a sub-beat) instead of defaulting to the same specialist every time. Only reach for a heavier-loaded writer when the fit gap is clear.\n`
    : "";
  const prompt = `You are the editor at BrainHook assigning a topic to the best-fit writer on staff.

Topic: ${idea.title}${idea.angle ? `\nAngle: ${idea.angle}` : ""}

Active writers:
${list}
${varietyBlock}
${assignDirective}

Respond with ONLY a JSON object:
{ "pick": <the NUMBER (1-${authors.length}) of the best-fit writer from the list above, or 0 ONLY if genuinely no writer could credibly cover this>, "name": "<the EXACT name of the writer you picked, copied verbatim from the list — empty string if pick is 0>", "reason": "one short sentence justifying the pick or refusal" }
The "name" MUST be the writer at that number and MUST be the same writer your reason talks about.`;
  const model = await resolveModel("author_assignment");
  const message = await anthropic.messages.create(
    {
      model,
      max_tokens: 512,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    },
    { timeout: 60_000 },
  );
  recordTextUsage({ operation: "pickBestAuthorForIdea", model, message });
  const block = message.content[0];
  const text = block && block.type === "text" ? block.text : "";
  let parsed: { pick?: number | string; name?: string; authorId?: string; reason?: string } = {};
  try {
    parsed = extractJson<{ pick?: number | string; name?: string; authorId?: string; reason?: string }>(text);
  } catch {
    // No parseable JSON — handled by the deterministic fallback below.
  }
  const reason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : undefined;

  const pickNum = Number(parsed.pick);
  // Explicit refusal (0) is the only case that should block on "no fit".
  if (pickNum === 0) {
    throw new NoSuitableAuthorError(
      reason ?? "No active writer covers this subject.",
      authors.map((a) => ({ name: a.name, beats: [a.category, ...(a.subBeatNames ?? [])] })),
    );
  }
  // Primary path: a 1-based index into the numbered list. A small integer is far
  // more reliable for the model to emit than a verbatim UUID — the old "echo the
  // id" contract frequently came back garbled, surfacing as "unknown author id"
  // even for topics the roster obviously covers.
  const byIndex =
    Number.isInteger(pickNum) && pickNum >= 1 && pickNum <= authors.length
      ? authors[pickNum - 1]!
      : undefined;
  // The model also echoes the EXACT name of the writer it picked, and its `reason`
  // sentence is written about that named writer. When the emitted list NUMBER and
  // the named writer DISAGREE, the name is the trustworthy signal: the model
  // reasons about a writer but miscounts their 1-based position, which otherwise
  // assigns a writer whose own justification names someone else (the reported bug —
  // a cat idea assigned to an astrology author while the reason named a different
  // writer). So prefer the named writer over the number.
  const namedNeedle = typeof parsed.name === "string" ? parsed.name.trim().toLowerCase() : "";
  const byName = namedNeedle
    ? authors.find((a) => a.name.toLowerCase() === namedNeedle)
    : undefined;
  if (byName && byIndex && byName.id !== byIndex.id) {
    logger.warn(
      { pick: parsed.pick, named: parsed.name, byIndexName: byIndex.name },
      "Author picker index/name mismatch — trusting the named writer over the list number",
    );
    return { authorId: byName.id, reason: reason ?? "Best fit by beat and voice." };
  }
  if (byIndex) return { authorId: byIndex.id, reason: reason ?? "Best fit by beat and voice." };
  if (byName) return { authorId: byName.id, reason: reason ?? "Best fit by beat and voice." };
  // Leniency: the model sometimes answers with the raw id instead of the index/name.
  if (parsed.authorId) {
    const needle = String(parsed.authorId).trim().toLowerCase();
    const m =
      authors.find((a) => a.id.toLowerCase() === needle) ??
      authors.find((a) => a.name.toLowerCase() === needle);
    if (m) return { authorId: m.id, reason: reason ?? "Best fit by beat and voice." };
  }
  // The model's answer couldn't be resolved (garbled, out of range, or missing).
  // Don't block the editor on a topic the roster can clearly cover — pick the
  // best beat-overlap writer deterministically instead of erroring out.
  const fallback = pickByBeatOverlap(idea, authors);
  logger.warn(
    { pick: parsed.pick, authorId: parsed.authorId, fallback: fallback.name },
    "Author picker answer unresolved — using beat-overlap fallback",
  );
  return { authorId: fallback.id, reason: "Auto-picked by topic overlap (AI picker was unclear)." };
}

function extractJson<T>(text: string, validate?: (v: unknown) => boolean): T {
  // Prefer the contents of a ```json fence when present, but always fall back to
  // scanning the raw text. The model — especially when the web_search tool is in
  // play — frequently wraps the JSON in a prose preamble or trailing commentary,
  // so a naive "slice from first bracket to end and JSON.parse" throws on the
  // surrounding prose. We instead find the first BALANCED bracket span that
  // actually parses, ignoring anything before or after it.
  //
  // `validate` lets callers reject an incidentally-valid-but-wrong fragment (e.g.
  // a bare `[3]` in the preamble) so the scan keeps going until it finds the span
  // with the expected shape (e.g. an object containing `links`).
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const sources = fenced ? [fenced[1]!, text] : [text];
  for (const src of sources) {
    const value = scanForJson<T>(src, validate);
    if (value !== undefined) return value;
  }
  // Surface a snippet of what the model DID say — a JSON-less reply is almost
  // always a content refusal, and the refusal reason is the diagnosis.
  const snippet = text.replace(/\s+/g, " ").trim();
  // When the text has no JSON brackets at all it's a pure prose reply: the model
  // refused to produce structured output. This is a content/safety refusal or a
  // packet mismatch, not a parse error — surface a clear, actionable message.
  const hasBrackets = text.includes("{") || text.includes("[");
  if (!hasBrackets && snippet) {
    throw new Error(
      `Writer model refused — evidence packet may not have supported this story: "${snippet.slice(0, 200)}${snippet.length > 200 ? "…" : ""}"`,
    );
  }
  // The model may include stray brackets (e.g. markdown formatting, citation markup)
  // in its refusal text, so the bracket check above misses these. Detect refusal
  // language explicitly so the admin sees a clear "model refused" message rather
  // than a cryptic "No JSON" parse error.
  const refusalSignals = [
    "i need to flag",
    "i cannot",
    "i'm unable",
    "i am unable",
    "i can't",
    "i won't",
    "i will not",
    "i'm not able",
    "i'm not comfortable",
    "i cannot fulfill",
    "i cannot comply",
    "refuse to",
    "refusal",
    "unable to",
    "not able to",
    "serious editorial problem",
    "cannot draft",
    "cannot write",
    "will not draft",
    "will not write",
  ];
  const lowerSnippet = snippet.toLowerCase();
  const isRefusal = refusalSignals.some((signal) => lowerSnippet.includes(signal));
  if (isRefusal) {
    throw new Error(
      `Writer model refused this angle — try rephrasing the idea or switching the assigned model: "${snippet.slice(0, 300)}${snippet.length > 300 ? "…" : ""}"`,
    );
  }
  throw new Error(
    snippet
      ? `No JSON found in model response — the model replied: "${snippet.slice(0, 300)}${snippet.length > 300 ? "…" : ""}"`
      : "No JSON found in model response (empty reply)",
  );
}

// Scan a string for the first balanced {...} / [...] span that parses as JSON
// (and, if given, satisfies `validate`), ignoring prose before/after it and
// stray brackets embedded in prose.
function scanForJson<T>(raw: string, validate?: (v: unknown) => boolean): T | undefined {
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== "{" && ch !== "[") continue;
    const end = matchBalancedBracket(raw, i);
    if (end === -1) continue;
    try {
      const parsed = JSON.parse(raw.slice(i, end + 1)) as T;
      if (validate && !validate(parsed)) continue;
      return parsed;
    } catch {
      // Not valid JSON starting here (e.g. a bracket inside prose) — keep scanning.
    }
  }
  return undefined;
}

// Shape guard for the link-insertion passes: an object carrying a `links` key.
function hasLinksShape(v: unknown): boolean {
  return typeof v === "object" && v !== null && "links" in v;
}

// Index of the bracket that closes the one opened at `start`, respecting JSON
// string literals/escapes; -1 if it never closes (e.g. a truncated response).
function matchBalancedBracket(s: string, start: number): number {
  const open = s[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Shared idea-generation guidance (used by both the author- and beat-level
// generators). The model scans for fresh/timely material FIRST and leads with
// it when it is genuinely strong, but is free to fall back to evergreen ideas
// when nothing fresh is worth using — there is no freshness quota. The honesty
// block forbids dressing old material up as new.
// The fresh-scan / honesty / per-beat-hooks steering for idea generation now
// lives in the AI registry (services/aiRegistry.ts) as the default directive for
// the `author_idea_generation` / `beat_idea_generation` keys, resolved per call
// via resolveDirective() so admins can edit it. Trend-scout steering likewise
// lives there under `trend_scout`.

// Shared headline-craft guidance for idea generation (both the beat-anchored and
// author-anchored generators reference this so the two prompts don't drift). The
// goal is VARIETY: a menu of distinct headline archetypes so the feed stops
// filling up with one formula. The "it's not X, it's Y" / "you thought X, really
// Y" reveal in particular was being overused, so it's explicitly capped here.
// Every archetype must still deliver on its promise — no buried lede, no lying
// to earn the click.
const HEADLINE_CRAFT_GUIDE = `Headline craft — vary the SHAPE of your headlines. Across a batch, no two should share the same construction, and don't lean on any single formula. In particular, the negation-reframe family is overused and must be capped: "It's not X, it's Y", "You thought X — it's really Y", "X isn't Y, it's Z", "It's not that you're X, your Y is doing Z", and close variants all belong to the SAME restricted family. At most ONE headline in the entire batch may use ANY form of this negation-reframe construction. Draw from a range of archetypes:
- Investigative: name a hidden or overlooked thing as if surfacing it. ("The Rule Change Buried in Plain Sight")
- Curiosity: a concrete, intriguing noun-image that opens a gap without explaining itself. ("The Bloodstain Clock")
- Narrative: center a person or moment with a vivid, specific action. ("The Scientist Who Treated Loneliness Like an Emergency")
- Practical: an honest how-to / how-to-tell framing for something genuinely useful. ("How to Tell Discomfort From a Broken Agreement")
- Contrarian: challenge a common assumption, defensibly. ("Compersion Was Never the Assignment")
- Series/taxonomy: a labeled entry in a set, often colon-structured. ("Attachment Pairings: Anxious + Anxious")
- Curiosity gap: tease a counterintuitive finding, a hidden mechanism, or a question the reader didn't know they had.
- Second-person, when it earns it. ("Why your…", "What you're actually…", "The reason you can't…")
Craft rules that apply to EVERY archetype:
- Use specifics that pay off: concrete numbers, named phenomena, named eras, vivid nouns. ("The 90-second rule that…", not "A simple trick to…")
- Promise only a payoff the article actually delivers — a mechanism, a reframe, a forecast, a buried fact. Never bury the lede behind vagueness, and never overpromise or mislead to win the click.
- Length: usually 4–14 words. Punchy beats clever; some of the strongest are short noun phrases.
- BANNED: vague abstractions ("On the nature of…"), academic phrasing, "A meditation on…", trailing ellipses, ALL-CAPS shouting, fake stakes ("You won't believe…", "Number 4 will shock you").`;

/**
 * Generate a batch of fresh article ideas anchored to a single BEAT — its
 * name, description, and editorial slant — rather than any individual author's
 * voice. Uses the same fresh-scan-first approach as author idea generation:
 * web-search for genuinely fresh material and lead with it when strong, but
 * fall back to evergreen ideas when nothing fresh is worth using (no freshness
 * quota), and never frame old material as new. Returns title + angle per idea;
 * the caller stamps the beat's category/slug and picks an author for each.
 */
export async function generateIdeasForBeat(
  beat: { name: string; categorySlug: string; description?: string | null; slant?: string | null },
  opts: { count?: number; avoidTitles?: string[]; recentCategoryTitles?: string[] } = {},
): Promise<{ title: string; angle: string }[]> {
  if (!(await isAiFunctionEnabled("beat_idea_generation"))) return [];
  const count = Math.max(1, Math.min(10, opts.count ?? 5));
  const ideaDirective = await resolveDirective("beat_idea_generation");
  const descBlock = beat.description?.trim()
    ? `\n\nWhat this beat covers:\n${beat.description.trim()}`
    : "";
  const slantBlock = beat.slant?.trim()
    ? `\n\nBrainHook's editorial slant on this beat (its house take — let it shape which ideas you propose, not just how you frame them):\n${beat.slant.trim()}`
    : "";
  const sys = `You are a senior commissioning editor for the magazine "BrainHook", brainstorming fresh article ideas for its "${beat.name}" beat. You think across the whole beat at the level of the magazine's editorial vision — not in any single writer's voice. BrainHook is smart clickbait: headlines should be unapologetically irresistible, but every promise must be one a serious magazine could actually deliver.${descBlock}${slantBlock}

Editorial standards:
- Ideas must be substantive and well-grounded for curious adults — real science, real mechanisms, never fabricated studies or fake specificity.
- No tabloid lies, no false "Number 4 will shock you" energy.`;
  const avoid =
    opts.avoidTitles && opts.avoidTitles.length > 0
      ? `\n\nThese have already been written or proposed. Do NOT propose anything that significantly overlaps with them in subject or thesis:\n${opts.avoidTitles.slice(0, 30).map((t) => `- ${t}`).join("\n")}`
      : "";
  const constructionCtx =
    opts.recentCategoryTitles && opts.recentCategoryTitles.length > 0
      ? `\n\nRecent headlines from this category (construction context — these rhetorical shapes have been used recently; avoid the same silhouette even on a different subject):\n${opts.recentCategoryTitles.slice(0, 15).map((t) => `- ${t}`).join("\n")}`
      : "";
  const user = `Generate ${count} fresh article ideas for the "${beat.name}" beat. Every idea must sit squarely inside this beat and reflect its editorial slant.

${ideaDirective}

Ground every idea in the real science and write as someone genuinely versed in it; novelty should come from a fresh, credible angle, never from reaching beyond what the beat can actually support.

${HEADLINE_CRAFT_GUIDE}

Avoid recycled tropes.${constructionCtx}${avoid}

Respond with ONLY a JSON array of objects with this exact shape:
[
  { "title": "...", "angle": "one-sentence editorial angle that hooks the reader" },
  ...${count} items total
]`;

  const model = await resolveModel("beat_idea_generation");
  logger.info({ beat: beat.categorySlug, op: "generateIdeasForBeat", model, count, webSearch: true }, "llm call");
  const baseRequest = {
    model,
    max_tokens: 2048,
    temperature: 1.0,
    system: sys,
    messages: [{ role: "user" as const, content: user }],
  };
  let message: Anthropic.Messages.Message;
  try {
    message = (await anthropic.messages.create({
      ...baseRequest,
      tools: [
        {
          type: "web_search_20250305" as const,
          name: "web_search",
          max_uses: 3,
        },
      ],
    } as Parameters<typeof anthropic.messages.create>[0])) as Anthropic.Messages.Message;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Web search tool unavailable; retrying without tools");
    message = (await anthropic.messages.create(baseRequest)) as Anthropic.Messages.Message;
  }
  const textBlocks = message.content.filter(
    (b): b is Anthropic.Messages.TextBlock => b.type === "text",
  );
  const text = textBlocks.length > 0 ? textBlocks[textBlocks.length - 1]!.text : "";
  const searchUses = message.content.filter((b) => b.type === "server_tool_use" || b.type === "tool_use").length;
  logger.info({ beat: beat.categorySlug, op: "generateIdeasForBeat", searchUses, textBlocks: textBlocks.length }, "llm call returned");
  recordTextUsage({ operation: "generateIdeasForBeat", model, message });
  const raw = extractJson<{ title: string; angle: string }[]>(text);
  return raw
    .filter((r) => typeof r?.title === "string" && r.title.trim().length > 0)
    .map((r) => ({
      title: r.title.trim().replace(/\\'/g, "'").replace(/''/g, "'"),
      angle: typeof r.angle === "string" ? r.angle.trim() : "",
    }));
}

export interface RawTrendSignal {
  source: string;
  sourceUrl: string;
  event: string;
  headline: string;
  angle: string;
  urgency: number;
  risk: number;
  riskReason: string;
  suggestedAuthor?: string;
}

/**
 * Per-beat outcome of a Trend Scout run. The scout FAILS CLOSED: it only ever
 * returns fresh signals it grounded in a live web search. Every non-success
 * outcome yields zero signals with a human-readable reason so a scan can explain
 * why a beat produced nothing instead of silently swallowing it.
 *   - search_success     — live search ran and returned ≥1 usable hook.
 *   - search_empty       — live search ran but nothing fresh/strong turned up.
 *   - search_failed      — the web_search call errored, or search ran but the
 *                          model output was unusable (unparseable).
 *   - tool_unavailable   — the web_search tool itself could not be used.
 *   - skipped_fail_closed — the scout is paused (AI Controls) OR the model
 *                          answered WITHOUT invoking web search; either way we
 *                          refuse to accept memory-only output as "fresh".
 */
export type TrendScoutOutcome =
  | "search_success"
  | "search_empty"
  | "search_failed"
  | "tool_unavailable"
  | "skipped_fail_closed";

export interface TrendScoutResult {
  outcome: TrendScoutOutcome;
  signals: RawTrendSignal[];
  detail?: string;
}

/**
 * Classify a thrown web_search error into a fail-closed outcome. We deliberately
 * do NOT retry the model without tools (that fabricates "fresh" trends from
 * parametric memory) — we only report why the search could not run. Exported for
 * unit testing.
 */
export function classifyTrendScoutError(err: unknown): {
  outcome: "search_failed" | "tool_unavailable";
  detail: string;
} {
  const detail = err instanceof Error ? err.message : String(err);
  const toolUnavailable =
    /web[_\s-]?search|tool|unsupported|not\s+supported|not\s+enabled|no such tool/i.test(detail);
  return { outcome: toolUnavailable ? "tool_unavailable" : "search_failed", detail };
}

/**
 * Turn a completed Trend Scout model response into a fail-closed result. The
 * critical guard: if the model never actually invoked web search (no
 * server_tool_use / tool_use block), any "fresh" hook it emitted came from
 * memory, so we refuse the whole batch (`skipped_fail_closed`) rather than
 * poison the trend queue with fabrications. Exported for unit testing.
 */
export function classifyTrendScoutResponse(
  message: Anthropic.Messages.Message,
): TrendScoutResult {
  const textBlocks = message.content.filter(
    (b): b is Anthropic.Messages.TextBlock => b.type === "text",
  );
  const text = textBlocks.length > 0 ? textBlocks[textBlocks.length - 1]!.text : "";
  const searchUses = message.content.filter(
    (b) => b.type === "server_tool_use" || b.type === "tool_use",
  ).length;

  if (searchUses === 0) {
    return {
      outcome: "skipped_fail_closed",
      signals: [],
      detail: "Model returned an answer without performing a live web search.",
    };
  }

  let raw: RawTrendSignal[];
  try {
    raw = extractJson<RawTrendSignal[]>(text);
  } catch {
    return {
      outcome: "search_failed",
      signals: [],
      detail: "Search ran but the model output was not parseable JSON.",
    };
  }
  if (!Array.isArray(raw)) return { outcome: "search_empty", signals: [] };
  const clamp = (n: unknown): number => {
    const v = typeof n === "number" ? n : Number(n);
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(100, Math.round(v)));
  };
  const signals = raw
    .filter(
      (r) =>
        r &&
        typeof r.headline === "string" &&
        r.headline.trim().length > 0 &&
        typeof r.sourceUrl === "string" &&
        r.sourceUrl.trim().length > 0,
    )
    .map((r) => ({
      source: typeof r.source === "string" ? r.source.trim() : "",
      sourceUrl: r.sourceUrl.trim(),
      event: typeof r.event === "string" ? r.event.trim() : "",
      headline: r.headline.trim(),
      angle: typeof r.angle === "string" ? r.angle.trim() : "",
      urgency: clamp(r.urgency),
      risk: clamp(r.risk),
      riskReason: typeof r.riskReason === "string" ? r.riskReason.trim() : "",
      suggestedAuthor: typeof r.suggestedAuthor === "string" ? r.suggestedAuthor.trim() : "",
    }));
  return { outcome: signals.length > 0 ? "search_success" : "search_empty", signals };
}

/**
 * Trend Radar scout: web-search a single BEAT for genuinely fresh, timely,
 * source-grounded material and return scored, ready-to-judge article hooks —
 * each pairing a real source/event with a BrainHook headline + angle and
 * urgency/risk scores. Unlike generateIdeasForBeat (which is free to fall back
 * to evergreen), this is fresh-ONLY: every signal must be anchored to a real,
 * recent, specific, citable source the model actually found via web_search.
 * Returns the raw signals; the caller verifies each source URL is reachable,
 * validates/clamps scores, picks/validates the author, and dedupes before
 * persisting. Returns [] when nothing fresh and strong turns up.
 */
export async function scoutTrendSignalsForBeat(
  beat: { name: string; categorySlug: string; description?: string | null; slant?: string | null },
  opts: { count?: number; avoidTitles?: string[]; recentCategoryTitles?: string[]; authorNames?: string[] } = {},
): Promise<TrendScoutResult> {
  if (!(await isAiFunctionEnabled("trend_scout"))) {
    return {
      outcome: "skipped_fail_closed",
      signals: [],
      detail: "Trend scout is paused in AI Controls.",
    };
  }
  const count = Math.max(1, Math.min(10, opts.count ?? 6));
  const trendDirective = await resolveDirective("trend_scout");
  const descBlock = beat.description?.trim()
    ? `\n\nWhat this beat covers:\n${beat.description.trim()}`
    : "";
  const slantBlock = beat.slant?.trim()
    ? `\n\nBrainHook's editorial slant on this beat (its house take):\n${beat.slant.trim()}`
    : "";
  const authorBlock =
    opts.authorNames && opts.authorNames.length > 0
      ? `\n\nWriters currently on staff who could cover this beat (suggest the single best fit by name, exactly as written, or leave suggestedAuthor empty if unsure):\n${opts.authorNames.map((n) => `- ${n}`).join("\n")}`
      : "";
  const avoid =
    opts.avoidTitles && opts.avoidTitles.length > 0
      ? `\n\nAlready written or proposed — do NOT propose anything that overlaps these in subject or thesis:\n${opts.avoidTitles.slice(0, 30).map((t) => `- ${t}`).join("\n")}`
      : "";
  const constructionCtx =
    opts.recentCategoryTitles && opts.recentCategoryTitles.length > 0
      ? `\n\nRecent headlines from this category (construction context — these rhetorical shapes have been used recently; avoid the same silhouette even on a different subject):\n${opts.recentCategoryTitles.slice(0, 15).map((t) => `- ${t}`).join("\n")}`
      : "";
  const sys = `You are the Fresh Hook Scout for the magazine "BrainHook", monitoring the "${beat.name}" beat for timely, source-grounded story hooks an editor can grab right now. BrainHook is smart clickbait: headlines must be irresistible, but every promise must be one a serious magazine could actually deliver from the source you found. You report only genuinely FRESH material — never evergreen filler dressed up as news.${descBlock}${slantBlock}`;
  const user = `Scout up to ${count} fresh, timely article hooks for the "${beat.name}" beat.

${trendDirective}

For each hook provide:
- source: the publication/institution name (e.g. "Nature", "Reuters", "NASA JPL").
- sourceUrl: the exact https URL of the specific source page (article/paper/release). Must be a real page you found, not a guess or a search query.
- event: 1-2 sentences on what actually happened / was found, grounded in the source.
- headline: an irresistible BrainHook headline (4-14 words) the article could honestly deliver from this source. Vary the SHAPE — investigative, curiosity (a concrete intriguing noun-image), narrative (a person/moment), practical how-to, contrarian, or series/taxonomy. Avoid the negation-reframe family ("It's not X, it's Y" / "X isn't Y, it's Z" / "You thought X — it's really Y" and close variants) — at most one across all your headlines. Never bury the lede or overpromise to win the click.
- angle: one sentence on the distinctly-BrainHook take — why curious readers should care.
- urgency: integer 0-100. How time-sensitive is this hook? 80-100 = breaking/will be stale in days; 40-70 = topical this week/month; 0-30 = newly-relevant but not perishable.
- risk: integer 0-100. Editorial/reputational risk of running it. 0-20 = well-sourced, settled, low-controversy; 40-60 = some uncertainty, single source, or politically sensitive; 70-100 = speculative, contested, legally sensitive, or thin sourcing.
- riskReason: one short sentence explaining the risk score.
- suggestedAuthor: the best-fit staff writer's name from the list below (exact spelling), or "" if unsure.${authorBlock}${constructionCtx}${avoid}

Respond with ONLY a JSON array of objects with this exact shape (no prose, no markdown fence):
[
  { "source": "...", "sourceUrl": "https://...", "event": "...", "headline": "...", "angle": "...", "urgency": 0, "risk": 0, "riskReason": "...", "suggestedAuthor": "..." }
]
Return [] if nothing fresh and strong turns up.`;

  const model = await resolveModel("trend_scout");
  logger.info({ beat: beat.categorySlug, op: "scoutTrendSignalsForBeat", model, count, webSearch: true }, "llm call");
  const baseRequest = {
    model,
    max_tokens: 3072,
    temperature: 0.7,
    system: sys,
    messages: [{ role: "user" as const, content: user }],
  };
  let message: Anthropic.Messages.Message;
  try {
    message = (await anthropic.messages.create({
      ...baseRequest,
      tools: [
        {
          type: "web_search_20250305" as const,
          name: "web_search",
          max_uses: 3,
        },
      ],
    } as Parameters<typeof anthropic.messages.create>[0])) as Anthropic.Messages.Message;
  } catch (err) {
    // FAIL CLOSED. The web_search call failed or the tool is unavailable. We do
    // NOT retry the model without tools — that would let it fabricate "fresh"
    // trends from parametric memory and poison the queue. Report the outcome so
    // the scan surfaces an honest zero for this beat.
    const { outcome, detail } = classifyTrendScoutError(err);
    logger.warn(
      { beat: beat.categorySlug, outcome, err: detail },
      "Trend scout web search failed — failing closed (no memory fallback)",
    );
    return { outcome, signals: [], detail };
  }
  const searchUses = message.content.filter(
    (b) => b.type === "server_tool_use" || b.type === "tool_use",
  ).length;
  const textBlockCount = message.content.filter((b) => b.type === "text").length;
  logger.info(
    { beat: beat.categorySlug, op: "scoutTrendSignalsForBeat", searchUses, textBlocks: textBlockCount },
    "llm call returned",
  );
  recordTextUsage({ operation: "scoutTrendSignalsForBeat", model, message });
  const result = classifyTrendScoutResponse(message);
  if (result.outcome !== "search_success") {
    logger.warn(
      { beat: beat.categorySlug, outcome: result.outcome, detail: result.detail },
      "Trend scout produced no usable signals",
    );
  }
  return result;
}

export async function generateIdeasForAuthor(
  author: Author,
  opts: { avoidTitles?: string[]; recentCategoryTitles?: string[]; allowedBeats?: { category: string; categorySlug: string; slant?: string | null }[] } = {},
): Promise<{ title: string; angle: string; categorySlug: string }[]> {
  if (!(await isAiFunctionEnabled("author_idea_generation"))) return [];
  const allowedBeats = opts.allowedBeats ?? [{ category: author.category, categorySlug: author.categorySlug }];
  const sys = buildAuthorSystemPrompt(author, { allowedBeats, includeTechnicalRevoicing: false });
  const ideaDirective = await resolveDirective("author_idea_generation");
  const avoid =
    opts.avoidTitles && opts.avoidTitles.length > 0
      ? `\n\nYou have already written or proposed these. Do NOT propose anything that significantly overlaps with them in subject or thesis:\n${opts.avoidTitles.slice(0, 30).map((t) => `- ${t}`).join("\n")}`
      : "";
  const constructionCtx =
    opts.recentCategoryTitles && opts.recentCategoryTitles.length > 0
      ? `\n\nRecent headlines from your primary category (construction context — these rhetorical shapes have been used recently; avoid the same silhouette even on a different subject):\n${opts.recentCategoryTitles.slice(0, 15).map((t) => `- ${t}`).join("\n")}`
      : "";
  const beatList = allowedBeats.map((b) => `  - "${b.categorySlug}" → ${b.category}`).join("\n");
  // Editorial slants per beat — set in the admin Beats page. Surface them so
  // the model angles ideas to match the magazine's stance for each beat.
  const slantBlock = (() => {
    const withSlants = allowedBeats.filter((b) => b.slant && b.slant.trim().length > 0);
    if (withSlants.length === 0) return "";
    const lines = withSlants.map((b) => `- ${b.category}: ${b.slant!.trim()}`).join("\n");
    return `\n\nEditorial slant for each beat (BrainHook's house take — let it shape which ideas you propose, not just how you frame them):\n${lines}`;
  })();
  const subBeatNote = allowedBeats.length > 1
    ? `\n\nFor each idea, choose the single best-fit beat from your allowed list. Aim for roughly an even split: about half of your 5 ideas in your primary beat (${author.categorySlug}) and the rest ranging across your sub-beats — at least 2 of the 5 should explore a sub-beat whenever you can find strong, well-grounded angles there. Only place an idea in a sub-beat when you genuinely have the expertise to cover it credibly and keep it rooted in the real science — never stretch to fill a quota. Every sub-beat idea MUST be framed through your primary-beat lens: the angle should be one a ${author.category} writer would uniquely bring (its politics, economics, history, or psychology as fits your expertise), never a generic take on that other field. Use your range to bring novel, cross-disciplinary spins a single-beat writer couldn't.`
    : "";
  const user = `Generate 5 fresh article ideas. BrainHook is smart clickbait — the headlines should be unapologetically irresistible, but every promise must be one a serious magazine could actually deliver. No tabloid lies, no false specificity, no fake "Number 4 will shock you" energy.

${ideaDirective}

Anchor every idea in YOUR sensibility — the expertise, obsessions, and recurring themes described in your voice and bio above. A reader who knows your byline should immediately think "yes, that's a [your name] piece" from the title alone, whether the topic sits in your primary beat or a sub-beat. Bring your distinctive lens and named interests to bear even when you range into adjacent territory — the through-line is your way of seeing a subject, not any single topic. Ground every idea in the real science and write as someone genuinely versed in it; novelty should come from a fresh, credible angle, never from reaching beyond what you can actually support.

${HEADLINE_CRAFT_GUIDE}

Avoid recycled tropes.${subBeatNote}${slantBlock}${constructionCtx}${avoid}

Allowed beats (use the exact categorySlug string):
${beatList}

Respond with ONLY a JSON array of objects with this exact shape:
[
  { "title": "...", "angle": "one-sentence editorial angle that hooks the reader", "categorySlug": "one of the allowed slugs above" },
  ...5 items total
]`;

  const model = await resolveModel("author_idea_generation");
  const temperature = authorTemperature(author);
  const max_tokens = authorMaxTokens(author);
  logger.info({ author: author.slug, op: "generateIdeas", model, temperature, max_tokens, webSearch: true }, "llm call");
  const baseRequest = {
    model,
    max_tokens,
    temperature,
    system: sys,
    messages: [{ role: "user" as const, content: user }],
  };
  let message: Anthropic.Messages.Message;
  try {
    message = (await anthropic.messages.create({
      ...baseRequest,
      tools: [
        {
          type: "web_search_20250305" as const,
          name: "web_search",
          max_uses: 3,
        },
      ],
    } as Parameters<typeof anthropic.messages.create>[0])) as Anthropic.Messages.Message;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Web search tool unavailable; retrying without tools");
    message = (await anthropic.messages.create(baseRequest)) as Anthropic.Messages.Message;
  }
  // With tool use the response can include tool_use / web_search_tool_result
  // blocks alongside one or more text blocks. The JSON we want is the LAST
  // text block the model emits (its final answer after any searches).
  const textBlocks = message.content.filter(
    (b): b is Anthropic.Messages.TextBlock => b.type === "text",
  );
  const text = textBlocks.length > 0 ? textBlocks[textBlocks.length - 1]!.text : "";
  const searchUses = message.content.filter((b) => b.type === "server_tool_use" || b.type === "tool_use").length;
  logger.info({ author: author.slug, op: "generateIdeas", searchUses, textBlocks: textBlocks.length }, "llm call returned");
  recordTextUsage({ operation: "generateIdeasForAuthor", model, message, authorSlug: author.slug });
  const raw = extractJson<{ title: string; angle: string; categorySlug?: string }[]>(text);
  const allowedSlugs = new Set(allowedBeats.map((b) => b.categorySlug));
  // Defensively coerce: if the model returns an unknown slug or omits one,
  // fall back to the author's primary beat so we never insert garbage.
  return raw.map((r) => ({
    title: r.title,
    angle: r.angle,
    categorySlug: r.categorySlug && allowedSlugs.has(r.categorySlug) ? r.categorySlug : author.categorySlug,
  }));
}

/**
 * Generate deliberate "crossover" ideas (Task #258): each idea keeps the
 * author's PRIMARY beat as its canonical home (`categorySlug`) but is
 * intentionally framed to draw on one of the author's assigned SUB-beats,
 * recorded as a secondary subject. The blend is INTERNAL, admin-only metadata:
 * it never changes the reader-facing beat placement — it just produces
 * cross-disciplinary angles and, later, widens the draft's Source Vault
 * evidence across both beats.
 *
 * Crossovers are ONLY ever generated across the author's own allowed beats
 * (primary + admin-assigned sub-beats). An author with no sub-beats can't
 * produce crossovers, so this returns [] for them.
 */
export async function generateCrossoverIdeasForAuthor(
  author: Author,
  opts: {
    avoidTitles?: string[];
    recentCategoryTitles?: string[];
    allowedBeats?: { category: string; categorySlug: string; slant?: string | null }[];
    count?: number;
  } = {},
): Promise<{ title: string; angle: string; categorySlug: string; secondaryBeats: string[] }[]> {
  if (!(await isAiFunctionEnabled("author_idea_generation"))) return [];
  const allowedBeats =
    opts.allowedBeats ?? [{ category: author.category, categorySlug: author.categorySlug }];
  const primarySlug = author.categorySlug;
  const primary =
    allowedBeats.find((b) => b.categorySlug === primarySlug) ??
    ({ category: author.category, categorySlug: primarySlug, slant: null } as const);
  const subBeats = allowedBeats.filter((b) => b.categorySlug !== primarySlug);
  // No sub-beats → nothing to cross with. Never invent a beat outside the
  // author's assigned lanes.
  if (subBeats.length === 0) return [];
  const subSlugs = new Set(subBeats.map((b) => b.categorySlug));
  const count = Math.min(Math.max(opts.count ?? 3, 1), 5);

  const sys = buildAuthorSystemPrompt(author, { allowedBeats, includeTechnicalRevoicing: false });
  const ideaDirective = await resolveDirective("author_idea_generation");
  const avoid =
    opts.avoidTitles && opts.avoidTitles.length > 0
      ? `\n\nYou have already written or proposed these. Do NOT propose anything that significantly overlaps with them in subject or thesis:\n${opts.avoidTitles.slice(0, 30).map((t) => `- ${t}`).join("\n")}`
      : "";
  const constructionCtx =
    opts.recentCategoryTitles && opts.recentCategoryTitles.length > 0
      ? `\n\nRecent headlines from your primary category (construction context — these rhetorical shapes have been used recently; avoid the same silhouette even on a different subject):\n${opts.recentCategoryTitles.slice(0, 15).map((t) => `- ${t}`).join("\n")}`
      : "";
  const subList = subBeats.map((b) => `  - "${b.categorySlug}" → ${b.category}`).join("\n");
  const slantBlock = (() => {
    const withSlants = allowedBeats.filter((b) => b.slant && b.slant.trim().length > 0);
    if (withSlants.length === 0) return "";
    const lines = withSlants.map((b) => `- ${b.category}: ${b.slant!.trim()}`).join("\n");
    return `\n\nEditorial slant for each beat (BrainHook's house take — let it shape the ideas you propose):\n${lines}`;
  })();

  const user = `Generate ${count} deliberate CROSSOVER article ideas. A crossover is a single story that sits primarily in your home beat, ${primary.category} ("${primarySlug}"), but is genuinely enriched by one of your secondary subjects below. The point is a novel, multi-viewpoint angle a single-beat writer couldn't produce — where the second subject materially changes the thesis, not just the window dressing.

${ideaDirective}

Every idea's canonical home stays ${primary.category}. For each idea, pick exactly ONE secondary subject from this list and name it (use the exact slug):
${subList}

Rules:
- The angle must authentically draw on BOTH beats — the ${primary.category} lens is the spine, the secondary subject is what makes it fresh.
- Stay rooted in the real science of both subjects; novelty comes from a credible cross-disciplinary synthesis, never from stretching beyond what you can support.
- BrainHook is smart clickbait — irresistible headlines, but every promise must be one a serious magazine could deliver. No tabloid lies, no fake specificity.

${HEADLINE_CRAFT_GUIDE}
${slantBlock}${constructionCtx}${avoid}

Respond with ONLY a JSON array of objects with this exact shape:
[
  { "title": "...", "angle": "one-sentence editorial angle that blends both subjects", "secondaryBeat": "one of the secondary slugs above" },
  ...${count} items total
]`;

  const model = await resolveModel("author_idea_generation");
  const temperature = authorTemperature(author);
  const max_tokens = authorMaxTokens(author);
  logger.info(
    { author: author.slug, op: "generateCrossoverIdeas", model, temperature, max_tokens, webSearch: true },
    "llm call",
  );
  const baseRequest = {
    model,
    max_tokens,
    temperature,
    system: sys,
    messages: [{ role: "user" as const, content: user }],
  };
  let message: Anthropic.Messages.Message;
  try {
    message = (await anthropic.messages.create({
      ...baseRequest,
      tools: [{ type: "web_search_20250305" as const, name: "web_search", max_uses: 3 }],
    } as Parameters<typeof anthropic.messages.create>[0])) as Anthropic.Messages.Message;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Web search tool unavailable; retrying without tools",
    );
    message = (await anthropic.messages.create(baseRequest)) as Anthropic.Messages.Message;
  }
  const textBlocks = message.content.filter(
    (b): b is Anthropic.Messages.TextBlock => b.type === "text",
  );
  const text = textBlocks.length > 0 ? textBlocks[textBlocks.length - 1]!.text : "";
  const searchUses = message.content.filter(
    (b) => b.type === "server_tool_use" || b.type === "tool_use",
  ).length;
  logger.info(
    { author: author.slug, op: "generateCrossoverIdeas", searchUses, textBlocks: textBlocks.length },
    "llm call returned",
  );
  recordTextUsage({ operation: "generateCrossoverIdeasForAuthor", model, message, authorSlug: author.slug });
  const raw = extractJson<{ title: string; angle: string; secondaryBeat?: string }[]>(text);
  // The primary is ALWAYS the author's home beat. Coerce the secondary to a
  // real assigned sub-beat; if the model returns an unknown/missing one, fall
  // back to the first sub-beat so we never record a beat the author can't cover.
  const fallbackSub = subBeats[0]!.categorySlug;
  return raw.map((r) => ({
    title: r.title,
    angle: r.angle,
    categorySlug: primarySlug,
    secondaryBeats: [
      r.secondaryBeat && subSlugs.has(r.secondaryBeat) ? r.secondaryBeat : fallbackSub,
    ],
  }));
}

/**
 * Quick LLM-backed concept-similarity check. Used as a backstop after the
 * cheap lexical dedupe to catch conceptual duplicates that use different
 * vocabulary (e.g. "Recalling a memory edits it" vs "Every time you remember,
 * your brain rewrites it"). Returns the index of the matching candidate, or -1.
 */
export async function llmConceptDuplicateCheck(
  candidate: { title: string; angle: string; author?: { name: string; beat: string } },
  existing: { title: string; description: string; author?: { name: string; beat: string } }[],
): Promise<{ duplicateIndex: number; reason: string }> {
  if (existing.length === 0) return { duplicateIndex: -1, reason: "" };
  if (!(await isAiFunctionEnabled("concept_dedupe_judge"))) return { duplicateIndex: -1, reason: "" };
  const conceptDirective = await resolveDirective("concept_dedupe_judge");
  const list = existing
    .map((e, i) => {
      const by = e.author ? ` [by ${e.author.name}, ${e.author.beat}]` : "";
      return `${i}. "${e.title}"${by} — ${e.description}`;
    })
    .join("\n");
  const sys = [
    conceptDirective,
    'Respond ONLY with strict JSON: {"duplicateIndex": number, "reason": string}. Use -1 if the proposal is genuinely distinct from every item.',
  ].join("\n");
  const proposedBy = candidate.author ? `\nAuthor: ${candidate.author.name} (${candidate.author.beat})` : "";
  const user = `PROPOSED IDEA:\nTitle: ${candidate.title}\nAngle: ${candidate.angle}${proposedBy}\n\nEXISTING ITEMS:\n${list}\n\nReturn JSON only.`;
  // Deliberately defaults to the strong model (see AI_FUNCTION_ROUTING) — Haiku
  // over-rejected. Admin can still override via the AI Control Center.
  const model = await resolveModel("concept_dedupe_judge");
  try {
    const message = await anthropic.messages.create({
      model,
      max_tokens: 200,
      temperature: 0,
      system: sys,
      messages: [{ role: "user", content: user }],
    });
    recordTextUsage({ operation: "llmConceptDuplicateCheck", model, message });
    const block = message.content[0];
    const text = block && block.type === "text" ? block.text : "";
    const parsed = extractJson<{ duplicateIndex: number; reason: string }>(text);
    if (typeof parsed?.duplicateIndex === "number") return parsed;
    return { duplicateIndex: -1, reason: "" };
  } catch (err) {
    logger.warn({ err }, "LLM dedupe check failed; allowing through");
    return { duplicateIndex: -1, reason: "" };
  }
}

// --- Semantic cluster reconciler judge (Task #330) ----------------------

export interface ClusterJudgeInput {
  id: string;
  label: string;
  keywords: string[];
  beat: string;
  memberTitles?: string[];
  memberExcerpts?: string[];
}

/**
 * Ask the LLM to determine whether two borderline story clusters (same beat,
 * Jaccard 0.08–0.18) cover the same underlying news story.
 *
 * Returns:
 *   "same_story"  → merge smaller into larger
 *   "distinct"    → cache verdict; never re-judge unless keywords change
 *   "uncertain"   → skip; re-evaluate on the next tick
 */
export async function llmClusterSameStory(
  a: ClusterJudgeInput,
  b: ClusterJudgeInput,
): Promise<{ verdict: "same_story" | "distinct" | "uncertain"; rationale: string }> {
  if (!(await isAiFunctionEnabled("cluster_reconcile_judge"))) {
    return { verdict: "uncertain", rationale: "function disabled" };
  }
  const directive = await resolveDirective("cluster_reconcile_judge");
  const model = await resolveModel("cluster_reconcile_judge");
  const clusterBlock = (c: ClusterJudgeInput) => {
    const lines: (string | null)[] = [
      `Keywords: ${c.keywords.slice(0, 15).join(", ")}`,
    ];
    if (c.memberTitles && c.memberTitles.length > 0) {
      lines.push(`Top sources: ${c.memberTitles.slice(0, 5).map((t) => `"${t}"`).join("; ")}`);
    }
    if (c.memberExcerpts && c.memberExcerpts.length > 0) {
      const excerpt = c.memberExcerpts[0]!.slice(0, 200);
      lines.push(`Lead excerpt: "${excerpt}${excerpt.length === 200 ? "…" : ""}"`);
    }
    return lines.filter(Boolean).join("\n");
  };
  const userMsg = [
    `BEAT: ${a.beat}`,
    `\nCLUSTER A: "${a.label}"`,
    clusterBlock(a),
    `\nCLUSTER B: "${b.label}"`,
    clusterBlock(b),
    `\nDo these two clusters cover the SAME underlying news story or developing event?`,
    `Respond ONLY with strict JSON: {"verdict":"same_story"|"distinct"|"uncertain","rationale":string}`,
  ].join("\n");
  try {
    const message = await anthropic.messages.create(
      {
        model,
        max_tokens: 200,
        temperature: 0,
        system: directive,
        messages: [{ role: "user", content: userMsg }],
      },
      // Hard per-call bound: 30s timeout, at most 1 SDK retry. Without this a
      // hung/slow API call could block the reconciler pass for minutes per pair.
      { timeout: 30_000, maxRetries: 1 },
    );
    recordTextUsage({ operation: "llmClusterSameStory", model, message });
    const block = message.content[0];
    const text = block && block.type === "text" ? block.text : "";
    const parsed = extractJson<{ verdict: string; rationale: string }>(text);
    if (
      parsed?.verdict === "same_story" ||
      parsed?.verdict === "distinct" ||
      parsed?.verdict === "uncertain"
    ) {
      return {
        verdict: parsed.verdict as "same_story" | "distinct" | "uncertain",
        rationale: parsed.rationale ?? "",
      };
    }
    return { verdict: "uncertain", rationale: "parse error" };
  } catch (err) {
    logger.warn({ err }, "llmClusterSameStory: LLM call failed");
    return { verdict: "uncertain", rationale: "llm error" };
  }
}

// --- Glossary alias-conflation audit ------------------------------------
// Batch judge: given several concepts (term + short definition + alias list),
// flag aliases that name a DISTINCT concept rather than a true synonym.
// Concepts are referenced back by 1-based index (never echoed ids). Returns
// null when the function is paused or the call fails so the caller can record
// "LLM pass skipped" instead of silently flagging nothing.

export interface AliasAuditConceptInput {
  index: number; // 1-based
  term: string;
  definition: string;
  aliases: string[];
}

export interface AliasAuditFlag {
  index: number;
  alias: string;
  reason: string;
}

export async function llmAuditConceptAliases(
  concepts: AliasAuditConceptInput[],
): Promise<AliasAuditFlag[] | null> {
  if (concepts.length === 0) return [];
  if (!(await isAiFunctionEnabled("alias_audit"))) return null;
  const directive = await resolveDirective("alias_audit");
  const list = concepts
    .map(
      (c) =>
        `${c.index}. TERM: "${c.term}"\n   DEFINITION: ${c.definition.slice(0, 220)}\n   ALIASES: ${c.aliases.map((a) => `"${a}"`).join(", ")}`,
    )
    .join("\n\n");
  const user = `CONCEPT ENTRIES:\n\n${list}\n\nReturn JSON only.`;
  const model = await resolveModel("alias_audit");
  try {
    const message = await anthropic.messages.create({
      model,
      max_tokens: 800,
      temperature: 0,
      system: directive,
      messages: [{ role: "user", content: user }],
    });
    recordTextUsage({ operation: "llmAuditConceptAliases", model, message });
    const block = message.content[0];
    const text = block && block.type === "text" ? block.text : "";
    const parsed = extractJson<{ flags?: unknown }>(text);
    if (!parsed || !Array.isArray(parsed.flags)) return null;
    const valid = new Map(concepts.map((c) => [c.index, new Set(c.aliases.map((a) => a.toLowerCase()))]));
    const flags: AliasAuditFlag[] = [];
    for (const f of parsed.flags as Array<Record<string, unknown>>) {
      if (typeof f?.index !== "number" || typeof f?.alias !== "string") continue;
      const aliasLower = f.alias.toLowerCase().trim();
      // Only accept flags that reference a real alias on the referenced concept.
      if (!valid.get(f.index)?.has(aliasLower)) continue;
      flags.push({ index: f.index, alias: aliasLower, reason: typeof f.reason === "string" ? f.reason : "" });
    }
    return flags;
  } catch (err) {
    logger.warn({ err }, "alias audit LLM batch failed");
    return null;
  }
}

// --- Glossary merge sweep judge ------------------------------------------
// Batch judge: given pairs of glossary entries (term + definition + aliases),
// decide whether each pair names the SAME underlying concept (merge) or two
// distinct concepts. Pairs are referenced back by 1-based index. Returns null
// when the function is paused or the call fails so the caller records the
// pairs for manual review instead of silently doing nothing.

export interface MergeJudgePairInput {
  index: number; // 1-based
  a: { term: string; definition: string; aliases: string[] };
  b: { term: string; definition: string; aliases: string[] };
}

export interface MergeJudgeVerdict {
  index: number;
  verdict: "merge" | "distinct" | "unsure";
  confidence: number; // 0–1
  reason: string;
}

export async function llmJudgeConceptMergePairs(
  pairs: MergeJudgePairInput[],
): Promise<MergeJudgeVerdict[] | null> {
  if (pairs.length === 0) return [];
  if (!(await isAiFunctionEnabled("merge_sweep"))) return null;
  const directive = await resolveDirective("merge_sweep");
  const fmt = (side: { term: string; definition: string; aliases: string[] }) =>
    `"${side.term}" — ${side.definition || "(no definition)"}${side.aliases.length > 0 ? ` [aliases: ${side.aliases.map((x) => `"${x}"`).join(", ")}]` : ""}`;
  const list = pairs
    .map((p) => `${p.index}. ENTRY A: ${fmt(p.a)}\n   ENTRY B: ${fmt(p.b)}`)
    .join("\n\n");
  const user = `CANDIDATE PAIRS:\n\n${list}\n\nReturn JSON only.`;
  const model = await resolveModel("merge_sweep");
  try {
    const message = await anthropic.messages.create({
      model,
      max_tokens: 1200,
      temperature: 0,
      system: directive,
      messages: [{ role: "user", content: user }],
    });
    recordTextUsage({ operation: "llmJudgeConceptMergePairs", model, message });
    const block = message.content[0];
    const text = block && block.type === "text" ? block.text : "";
    const parsed = extractJson<{ verdicts?: unknown }>(text);
    if (!parsed || !Array.isArray(parsed.verdicts)) return null;
    const validIndexes = new Set(pairs.map((p) => p.index));
    const verdicts: MergeJudgeVerdict[] = [];
    for (const v of parsed.verdicts as Array<Record<string, unknown>>) {
      if (typeof v?.index !== "number" || !validIndexes.has(v.index)) continue;
      const verdict = v.verdict === "merge" || v.verdict === "distinct" ? v.verdict : "unsure";
      const rawConfidence = typeof v.confidence === "number" ? v.confidence : 0;
      verdicts.push({
        index: v.index,
        verdict,
        confidence: Math.max(0, Math.min(1, rawConfidence)),
        reason: typeof v.reason === "string" ? v.reason : "",
      });
    }
    return verdicts;
  } catch (err) {
    logger.warn({ err }, "merge sweep judge LLM batch failed");
    return null;
  }
}

// --- Editorial screen (Task #200) --------------------------------------
// The cheap, forced editorial decision applied to an already-qualified story
// cluster. Sources are passed pre-ordered (strongest authority first) with a
// 1-based `index`; the model refers back to sources by that index so the caller
// can map claims/contradictions/quotes to real source ids without trusting the
// model to echo UUIDs. Throws AiFunctionDisabledError when the function is
// paused so the orchestrator degrades (no packet written) rather than guessing.

export interface EditorialScreenSourceInput {
  index: number;
  authorityTier: string;
  domain: string;
  title: string | null;
  author: string | null;
  publishedAt: string | null;
  lifecycleStatus: string;
  excerpt: string;
}

export interface EditorialScreenInput {
  cluster: { label: string; beat: string; score: number; keywords: string[] };
  sources: EditorialScreenSourceInput[];
  chunks: string[];
  existingArticles: string[];
  prior: { version: number; decision: string } | null;
  research: string | null;
  // Glossary-concept definitions retrieved from the internal concept lane of the
  // Source Vault. Injected as INTERNAL CONCEPT MEMORY — editorial context only.
  // Never cited as evidence, never counted toward source coverage or authority.
  glossaryContext?: string;
  // Cluster this screen is for — recorded on the cost meter so per-cluster AI
  // spend can be attributed. Optional so ad-hoc callers still typecheck.
  clusterId?: string | null;
}

export interface EditorialScreenResult {
  decision: EvidenceDecision;
  reasons: string[];
  doNotDraftReason: string | null;
  claims: Array<{ text: string; sourceIndexes: number[] }>;
  contradictions: Array<{ summary: string; sourceIndexes: number[] }>;
  quoteCandidates: Array<{ text: string; attribution: string; sourceIndex: number | null }>;
  model: string;
}

function truncate(s: string, n: number): string {
  const t = (s ?? "").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * Make the forced editorial decision for a story cluster and extract the
 * evidence (claims, contradictions, quote candidates) in a SINGLE cheap call.
 * Returns a decision that is always one of EVIDENCE_DECISION (coerced to
 * needs_human_editor if the model returns anything off-list) plus the extracted
 * evidence, keyed back to sources by 1-based index.
 */
export async function llmEditorialScreen(
  input: EditorialScreenInput,
): Promise<EditorialScreenResult> {
  if (!(await isAiFunctionEnabled("editorial_screen"))) {
    throw new AiFunctionDisabledError("editorial_screen");
  }
  const directive = await resolveDirective("editorial_screen");
  const sys = [
    directive,
    "",
    "Respond ONLY with strict JSON of this exact shape (no prose, no code fence):",
    "{",
    '  "decision": one of ' + EVIDENCE_DECISION.map((d) => `"${d}"`).join(" | ") + ",",
    '  "reasons": string[],  // 1-4 short reasons for the decision',
    '  "doNotDraftReason": string | null,  // required unless decision is "approve_draft"',
    '  "claims": [{ "text": string, "sourceIndexes": number[] }],',
    '  "contradictions": [{ "summary": string, "sourceIndexes": number[] }],',
    '  "quoteCandidates": [{ "text": string, "attribution": string, "sourceIndex": number|null }]',
    "}",
    "sourceIndexes / sourceIndex refer to the numbered SOURCES list below. Use only verbatim quote text taken from the provided source excerpts; if no clean quote exists, return an empty quoteCandidates array.",
  ].join("\n");

  const sourceList = input.sources
    .map((s) => {
      const meta = [
        `tier=${s.authorityTier}`,
        s.domain,
        s.lifecycleStatus,
        s.publishedAt ? `published ${s.publishedAt}` : "no date",
        s.author ? `by ${s.author}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      const head = truncate(s.title ?? s.domain, 160);
      return `${s.index}. "${head}" [${meta}]\n   <source_text>${truncate(s.excerpt, 600)}</source_text>`;
    })
    .join("\n");

  const chunkBlock =
    input.chunks.length > 0
      ? `\n\nSUPPORTING VAULT PASSAGES:\n${input.chunks.map((c, i) => `(${i + 1}) ${truncate(c, 500)}`).join("\n")}`
      : "";
  const existingBlock =
    input.existingArticles.length > 0
      ? `\n\nEXISTING BRAINHOOK ARTICLES ON RELATED GROUND (for duplicate detection):\n${input.existingArticles.map((t) => `- "${t}"`).join("\n")}`
      : "\n\nEXISTING BRAINHOOK ARTICLES ON RELATED GROUND: none found.";
  const priorBlock = input.prior
    ? `\n\nPRIOR SCREEN OF THIS CLUSTER: v${input.prior.version} decided "${input.prior.decision}". Re-decide from the current evidence; you may keep or change it.`
    : "";
  const researchBlock = input.research
    ? `\n\nADDITIONAL RESEARCH (grounded web summary):\n${truncate(input.research, 1500)}`
    : "";
  const glossaryBlock = input.glossaryContext
    ? `\n\nINTERNAL CONCEPT MEMORY (glossary definitions for terms likely in this article — editorial context only, NOT citable as evidence, NOT a source):\n${truncate(input.glossaryContext, 1200)}`
    : "";

  const user = [
    `STORY CLUSTER`,
    `Beat: ${input.cluster.beat}`,
    `Label: ${input.cluster.label}`,
    `Qualification score: ${input.cluster.score}`,
    input.cluster.keywords.length > 0 ? `Keywords: ${input.cluster.keywords.join(", ")}` : null,
    ``,
    `SOURCES (strongest authority first):`,
    sourceList || "(no sources)",
    chunkBlock,
    existingBlock,
    priorBlock,
    researchBlock,
    glossaryBlock,
    ``,
    `Return JSON only.`,
  ]
    .filter((l) => l !== null)
    .join("\n");

  const model = await resolveModel("editorial_screen");
  const message = await anthropic.messages.create({
    model,
    max_tokens: 1600,
    temperature: 0,
    system: sys,
    messages: [{ role: "user", content: user }],
  });
  recordTextUsage({ operation: "llmEditorialScreen", model, message, clusterId: input.clusterId ?? null });
  const block = message.content[0];
  const text = block && block.type === "text" ? block.text : "";
  const parsed = extractJson<{
    decision?: string;
    reasons?: unknown;
    doNotDraftReason?: unknown;
    claims?: unknown;
    contradictions?: unknown;
    quoteCandidates?: unknown;
  }>(text);

  const decision: EvidenceDecision = EVIDENCE_DECISION.includes(parsed?.decision as EvidenceDecision)
    ? (parsed!.decision as EvidenceDecision)
    : "needs_human_editor";
  const reasons = Array.isArray(parsed?.reasons)
    ? parsed!.reasons.filter((r): r is string => typeof r === "string" && r.trim().length > 0)
    : [];
  const rawReason = typeof parsed?.doNotDraftReason === "string" ? parsed.doNotDraftReason.trim() : "";
  const doNotDraftReason =
    decision === "approve_draft" ? null : rawReason || "No reason provided by the screen.";

  const toIndexes = (v: unknown): number[] =>
    Array.isArray(v)
      ? v.filter((n): n is number => typeof n === "number" && Number.isFinite(n))
      : [];
  const claims = Array.isArray(parsed?.claims)
    ? parsed!.claims
        .map((c) => c as { text?: unknown; sourceIndexes?: unknown })
        .filter((c) => typeof c.text === "string" && (c.text as string).trim().length > 0)
        .map((c) => ({ text: (c.text as string).trim(), sourceIndexes: toIndexes(c.sourceIndexes) }))
    : [];
  const contradictions = Array.isArray(parsed?.contradictions)
    ? parsed!.contradictions
        .map((c) => c as { summary?: unknown; sourceIndexes?: unknown })
        .filter((c) => typeof c.summary === "string" && (c.summary as string).trim().length > 0)
        .map((c) => ({
          summary: (c.summary as string).trim(),
          sourceIndexes: toIndexes(c.sourceIndexes),
        }))
    : [];
  const quoteCandidates = Array.isArray(parsed?.quoteCandidates)
    ? parsed!.quoteCandidates
        .map((q) => q as { text?: unknown; attribution?: unknown; sourceIndex?: unknown })
        .filter((q) => typeof q.text === "string" && (q.text as string).trim().length > 0)
        .map((q) => ({
          text: (q.text as string).trim(),
          attribution: typeof q.attribution === "string" ? q.attribution.trim() : "",
          sourceIndex:
            typeof q.sourceIndex === "number" && Number.isFinite(q.sourceIndex)
              ? q.sourceIndex
              : null,
        }))
    : [];

  return { decision, reasons, doNotDraftReason, claims, contradictions, quoteCandidates, model };
}

// Input for post-draft verification (#201). The draft body is rendered to plain
// text by the caller; the packet is the article's LOCKED evidence packet.
export interface DraftVerificationInput {
  title: string;
  bodyText: string;
  packet: {
    label: string;
    claims: { text: string }[];
    sources: { url: string; domain: string; title: string | null }[];
    quotes: { text: string; attribution: string }[];
    contradictions: { summary: string }[];
  };
  clusterId?: string | null;
  packetId?: string | null;
}

export interface DraftVerificationResult {
  status: "passed" | "flagged" | "error";
  summary: string;
  model: string | null;
  unsupportedClaims: { claim: string; detail: string }[];
  contradictedClaims: { claim: string; detail: string }[];
  inventedSources: { claim: string; detail: string }[];
}

/**
 * Verify a freshly written packet-grounded draft AGAINST its locked evidence
 * packet only — no web search, no outside knowledge. Returns the flagged
 * findings (unsupported / contradicted claims, invented sources). A "flagged"
 * or "error" result tells the caller to quarantine the draft for a human. This
 * function never throws for model/parse failures (it returns status "error");
 * it only throws AiFunctionDisabledError when the function is paused in AI
 * Control, so the caller can distinguish an operator pause from a real failure.
 */
export async function llmVerifyDraftAgainstPacket(
  input: DraftVerificationInput,
): Promise<DraftVerificationResult> {
  if (!(await isAiFunctionEnabled("draft_verification"))) {
    throw new AiFunctionDisabledError("draft_verification");
  }
  const directive = await resolveDirective("draft_verification");
  const sys = [
    directive,
    "",
    "You judge ONLY against the evidence packet provided below. You have NO web access and MUST NOT use outside knowledge to 'rescue' a claim — if the packet does not support a factual assertion, it is unsupported, full stop.",
    "Respond ONLY with strict JSON of this exact shape (no prose, no code fence):",
    "{",
    '  "unsupportedClaims": [{ "claim": string, "detail": string }],   // factual claims in the draft the packet does NOT support',
    '  "contradictedClaims": [{ "claim": string, "detail": string }],  // draft claims that CONTRADICT the packet',
    '  "inventedSources": [{ "claim": string, "detail": string }],     // links/attributions/named sources in the draft not present in the packet',
    '  "summary": string   // one or two sentences on overall fidelity',
    "}",
    "General editorial framing, transitions, and analysis are fine and are NOT violations — only flag concrete FACTUAL assertions (numbers, dates, events, named entities, attributed statements) the packet does not back.",
    "IMPORTANT CONTEXT: these drafts are opinion/analysis magazine pieces, not news reports. The writer is EXPECTED to interpret, characterize, extrapolate, and editorialize around the packet's claims. Do NOT flag: interpretive characterizations of a packet claim, reasonable inferences drawn from packet claims, broadly-known background framing (e.g. that a practice is widely used in a field), hedged statements ('may', 'suggests', 'some researchers'), or the writer's own opinions and predictions. Reserve unsupportedClaims for SPECIFIC checkable factual assertions stated as established fact (a precise statistic, a named study result, a dated event, a direct attribution) that the packet neither contains nor implies.",
    "contradictedClaims and inventedSources are the serious buckets — use them only for genuine conflicts with the packet and genuinely fabricated links/sources/attributions.",
    "Internal links to other articles on our own site (relative URLs like /article/some-slug) are site navigation, NOT source citations — NEVER flag them in any bucket.",
  ].join("\n");

  const sourceLines = input.packet.sources
    .map((s, i) => `  [S${i + 1}] ${s.title ? `${s.title} — ` : ""}${s.domain} → ${s.url}`)
    .join("\n");
  const claimLines = input.packet.claims
    .slice(0, 30)
    .map((c) => `  - ${c.text}`)
    .join("\n");
  const quoteLines = input.packet.quotes
    .slice(0, 12)
    .map((q) => `  - "${q.text}" — ${q.attribution || "unattributed"}`)
    .join("\n");
  const contradictionLines = input.packet.contradictions
    .slice(0, 10)
    .map((c) => `  - ${c.summary}`)
    .join("\n");

  const user = [
    `EVIDENCE PACKET (the ONLY permitted basis for factual support)`,
    `Topic: ${input.packet.label}`,
    ``,
    `Vetted sources:`,
    sourceLines || "  (none)",
    ``,
    `Established claims:`,
    claimLines || "  (none)",
    ``,
    `Cleared quotes:`,
    quoteLines || "  (none)",
    ``,
    `Known contradictions:`,
    contradictionLines || "  (none)",
    ``,
    `DRAFT TO VERIFY`,
    `Title: ${input.title}`,
    ``,
    truncate(input.bodyText, 12000),
    ``,
    `Return JSON only.`,
  ].join("\n");

  const model = await resolveModel("draft_verification");
  let message: Anthropic.Messages.Message;
  try {
    message = await anthropic.messages.create({
      model,
      max_tokens: 1600,
      temperature: 0,
      system: sys,
      messages: [{ role: "user", content: user }],
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), packetId: input.packetId },
      "draft verification model call failed",
    );
    return {
      status: "error",
      summary: "Verifier model call failed.",
      model,
      unsupportedClaims: [],
      contradictedClaims: [],
      inventedSources: [],
    };
  }
  recordTextUsage({
    operation: "llmVerifyDraftAgainstPacket",
    model,
    message,
    clusterId: input.clusterId ?? null,
    packetId: input.packetId ?? null,
  });

  const block = message.content[0];
  const text = block && block.type === "text" ? block.text : "";
  let parsed: {
    unsupportedClaims?: unknown;
    contradictedClaims?: unknown;
    inventedSources?: unknown;
    summary?: unknown;
  };
  try {
    parsed = extractJson(text);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), packetId: input.packetId },
      "draft verification response was unparseable",
    );
    return {
      status: "error",
      summary: "Verifier returned an unparseable response.",
      model,
      unsupportedClaims: [],
      contradictedClaims: [],
      inventedSources: [],
    };
  }

  const clean = (v: unknown): { claim: string; detail: string }[] =>
    Array.isArray(v)
      ? v
          .map((f) => f as { claim?: unknown; detail?: unknown })
          .map((f) => ({
            claim: typeof f.claim === "string" ? f.claim.trim() : "",
            detail: typeof f.detail === "string" ? f.detail.trim() : "",
          }))
          .filter((f) => f.claim.length > 0)
      : [];
  // Safety net: even with the prompt ban, drop any finding that is really
  // about an internal cross-link to our own site (/article/<slug>) — those are
  // navigation, not sourcing, and were quarantining clean drafts. The matcher
  // (verificationText.ts) is deliberately narrow so external URLs that happen
  // to contain "/article/" in their path are NOT filtered.
  const unsupportedClaims = clean(parsed.unsupportedClaims).filter((f) => !isInternalLinkFinding(f));
  const contradictedClaims = clean(parsed.contradictedClaims).filter((f) => !isInternalLinkFinding(f));
  const inventedSources = clean(parsed.inventedSources).filter((f) => !isInternalLinkFinding(f));
  const flagged =
    unsupportedClaims.length > 0 || contradictedClaims.length > 0 || inventedSources.length > 0;
  return {
    status: flagged ? "flagged" : "passed",
    summary: (typeof parsed.summary === "string" && parsed.summary.trim().length > 0
      ? parsed.summary
      : flagged
        ? "Evidence issues found."
        : "Draft is consistent with the evidence packet."
    ).trim(),
    model,
    unsupportedClaims,
    contradictedClaims,
    inventedSources,
  };
}

/**
 * Judge whether a proposed TITLE reads as a near-twin of an existing headline —
 * same phrasing, structure, or hook — even when the two articles are about
 * different subjects. This is purely about how similar the *names* look in a
 * list; it deliberately ignores whether the underlying concepts duplicate
 * (that is handled separately by llmConceptDuplicateCheck). Returns the index
 * of the clashing existing title, or -1 if the proposed title reads as
 * distinctly its own.
 */
export async function llmTitleSimilarityCheck(
  candidateTitle: string,
  existingTitles: string[],
): Promise<{ index: number; reason: string }> {
  if (existingTitles.length === 0) return { index: -1, reason: "" };
  if (!(await isAiFunctionEnabled("title_twin_judge"))) return { index: -1, reason: "" };
  const twinDirective = await resolveDirective("title_twin_judge");
  const list = existingTitles.map((t, i) => `${i}. "${t}"`).join("\n");
  const sys = [
    twinDirective,
    'Respond ONLY with strict JSON: {"index": number, "reason": string}. Use index -1 when the proposed title reads as distinctly its own.',
  ].join("\n");
  const user = `PROPOSED TITLE:\n"${candidateTitle}"\n\nEXISTING TITLES:\n${list}\n\nReturn JSON only.`;
  const model = await resolveModel("title_twin_judge");
  try {
    const message = await anthropic.messages.create({
      model,
      max_tokens: 200,
      temperature: 0,
      system: sys,
      messages: [{ role: "user", content: user }],
    });
    recordTextUsage({ operation: "llmTitleSimilarityCheck", model, message });
    const block = message.content[0];
    const text = block && block.type === "text" ? block.text : "";
    const parsed = extractJson<{ index: number; reason: string }>(text);
    if (typeof parsed?.index === "number") {
      return { index: parsed.index, reason: parsed.reason ?? "" };
    }
    return { index: -1, reason: "" };
  } catch (err) {
    logger.warn({ err }, "LLM title-similarity check failed; allowing through");
    return { index: -1, reason: "" };
  }
}

/**
 * Rewrite a headline that reads as a near-twin of existing ones into a fresh,
 * distinct headline that still describes the SAME article (same subject and
 * angle). Used to fix title clashes by editing the incoming title instead of
 * rejecting an otherwise-novel piece. Returns the new title, or null if the
 * model produced nothing usable (caller then keeps the original).
 */
export async function llmRewriteTitle(
  current: { title: string; angle: string },
  clashingTitles: string[],
): Promise<string | null> {
  if (!(await isAiFunctionEnabled("title_rewrite"))) return null;
  const rewriteDirective = await resolveDirective("title_rewrite");
  const list = clashingTitles.map((t) => `- "${t}"`).join("\n");
  const sys = [
    rewriteDirective,
    "Return ONLY the rewritten headline text, nothing else.",
  ].join("\n");
  const user = `EXISTING HEADLINES TO AVOID SOUNDING LIKE:\n${list}\n\nHEADLINE TO REWRITE:\n"${current.title}"\nARTICLE ANGLE: ${current.angle}\n\nReturn only the new headline.`;
  const model = await resolveModel("title_rewrite");
  try {
    const message = await anthropic.messages.create({
      model,
      max_tokens: 120,
      temperature: 0.8,
      system: sys,
      messages: [{ role: "user", content: user }],
    });
    recordTextUsage({ operation: "llmRewriteTitle", model, message });
    const block = message.content[0];
    const raw = block && block.type === "text" ? block.text : "";
    let text = raw.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
    text = text.replace(/^["'“”]+|["'“”]+$/g, "").trim();
    if (!text || text.length > 200) return null;
    return text;
  } catch (err) {
    logger.warn({ err }, "LLM title rewrite failed; keeping original title");
    return null;
  }
}

/**
 * Write a single Facebook caption for a back-catalogue article being dripped out
 * by the social posting queue. Grounded strictly in the article body (no
 * fabricated facts); the article URL is appended by the caller, never by the
 * model. Returns the caption text. Throws AiFunctionDisabledError when the
 * `social_caption` function is paused so the queue can surface that the item
 * needs a manual caption (rather than silently posting a bare link).
 */
export async function generateFacebookCaption(input: {
  title: string;
  dek?: string | null;
  bodyText: string;
}): Promise<string> {
  if (!(await isAiFunctionEnabled("social_caption"))) {
    throw new AiFunctionDisabledError("social_caption");
  }
  const captionDirective = await resolveDirective("social_caption");
  const sys = [captionDirective, "Return ONLY the caption text, nothing else."].join("\n");
  const body = input.bodyText.replace(/\s+/g, " ").trim().slice(0, 6000);
  const dek = input.dek?.replace(/\s+/g, " ").trim();
  const user = [
    `ARTICLE TITLE: ${input.title}`,
    dek ? `ARTICLE DEK: ${dek}` : "",
    "",
    "ARTICLE BODY (your only source of facts):",
    body,
    "",
    "Tone calibration: match your framing to the article's actual subject. If the article covers trauma, grief, mental health, abuse, loss, religion, politics, or other serious or painful topics, write with quiet respect and genuine curiosity — never cheerful, playful, or trivializing.",
    "",
    "Write the Facebook caption now — keep it to ABOUT THREE short paragraphs total (hook, one to two short summary paragraphs, then the CTA), never more. Do not include any URL. If you include a call to action, point readers to the link in the comments below (e.g. 'full story at the link in the comments below'); NEVER say 'link in bio' or refer to a bio/profile link. End with a warm ask to like, follow, and share (e.g. 'Like, follow, and share — it would mean the world to us!').",
  ]
    .filter((l) => l !== "")
    .join("\n");
  const model = await resolveModel("social_caption");
  const message = await anthropic.messages.create({
    model,
    max_tokens: 300,
    temperature: 0.7,
    system: sys,
    messages: [{ role: "user", content: user }],
  });
  recordTextUsage({ operation: "generateFacebookCaption", model, message });
  const block = message.content[0];
  const raw = block && block.type === "text" ? block.text : "";
  const text = stripCiteTagsFromText(raw)
    .text.replace(/^["'“”]+|["'“”]+$/g, "")
    .trim();
  if (!text) throw new Error("caption generation returned empty text");
  return text.slice(0, 600);
}

// One batched call per article: given the article body and its numbered
// evidence-source list, write the one-sentence "why it's included" note for
// each source the model is CONFIDENT about (evidence map, Task #273). Sources
// the model is unsure about are omitted — a missing note renders nothing on
// the site, which is always better than a guessed one. Returns a map of
// 1-based source index → note (indices, never echoed URLs — see the
// pick-from-list gotcha). Throws AiFunctionDisabledError when paused.
export async function generateCitationNotes(input: {
  title: string;
  dek?: string | null;
  bodyText: string;
  sources: Array<{ name: string; domain: string; anchorText?: string | null; sourceText?: string | null }>;
  articleId?: string | null;
}): Promise<Map<number, string>> {
  if (!(await isAiFunctionEnabled("citation_note"))) {
    throw new AiFunctionDisabledError("citation_note");
  }
  if (input.sources.length === 0) return new Map();
  const directive = await resolveDirective("citation_note");
  const sys = [
    directive,
    "",
    "Respond with ONLY a JSON array, no prose, in this shape:",
    '[{ "index": 1, "note": "one 10–25 word sentence on what this source contributes" }]',
    "Use each source's 1-based INDEX from the list. Omit any source you are not confident about. An empty array [] is a valid answer.",
  ].join("\n");
  const body = input.bodyText.replace(/\s+/g, " ").trim().slice(0, 9000);
  const dek = input.dek?.replace(/\s+/g, " ").trim();
  const sourceLines = input.sources.map((s, i) => {
    const anchor = (s.anchorText ?? "").trim();
    // Ground each note in the source's OWN stored text (Vault excerpt /
    // extracted text), truncated to keep the batched prompt bounded.
    const excerpt = (s.sourceText ?? "").replace(/\s+/g, " ").trim().slice(0, 700);
    const lines = [`${i + 1}. ${s.name} (${s.domain})${anchor ? ` — cited in the article as: "${anchor}"` : ""}`];
    if (excerpt) lines.push(`   SOURCE TEXT: <source_text>${excerpt}</source_text>`);
    return lines.join("\n");
  });
  const user = [
    `ARTICLE TITLE: ${input.title}`,
    dek ? `ARTICLE DEK: ${dek}` : "",
    "",
    "ARTICLE BODY (what the sources support):",
    body,
    "",
    "SOURCES — some include their own stored SOURCE TEXT. When present, base the note on what the SOURCE TEXT contains AND how the article uses it. When absent, base the note on the source's title/publisher and how the article's body uses that citation — write a note only when the contribution is clear:",
    ...sourceLines,
    "",
    "Write the notes now as a single JSON array.",
  ]
    .filter((l) => l !== "")
    .join("\n");
  const model = await resolveModel("citation_note");
  const message = await anthropic.messages.create({
    model,
    max_tokens: 1500,
    temperature: 0.3,
    system: sys,
    messages: [{ role: "user", content: user }],
  });
  recordTextUsage({ operation: "generateCitationNotes", model, message, articleId: input.articleId });
  const block = message.content[0];
  const raw = block && block.type === "text" ? block.text : "";
  const clean = stripCiteTagsFromText(raw).text;
  let parsed: unknown[];
  try {
    parsed = extractJson<unknown[]>(clean, (v) => Array.isArray(v));
  } catch {
    // Malformed/absent JSON degrades to "no notes" — never fail the caller.
    return new Map();
  }
  const out = new Map<number, string>();
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const idx = typeof rec.index === "number" ? Math.trunc(rec.index) : NaN;
    const note =
      typeof rec.note === "string"
        ? scrubInternalVocabFromText(rec.note.replace(/^["'“”]+|["'“”]+$/g, "").trim()).text.trim()
        : "";
    if (!Number.isFinite(idx) || idx < 1 || idx > input.sources.length) continue;
    if (!note) continue;
    const words = note.split(/\s+/).length;
    // Enforce the brief loosely: drop fragments and runaway paragraphs.
    if (words < 4 || words > 40) continue;
    out.set(idx, note.slice(0, 300));
  }
  return out;
}

// The full, ready-to-post social pack for a back-catalogue article share. Mirrors
// the meme system's social pack so both read consistently. The canonical URL and
// hashtags are NOT baked into `caption` — the queue appends the URL at post time
// and stores hashtags separately so they can be edited independently.
export interface GeneratedArticleSocialPost {
  socialHook: string;
  articleSummary: string;
  curiosityDetail: string;
  callToAction: string;
  caption: string;
  hashtags: string[];
}

/**
 * Generate the complete, ready-to-post Facebook copy for a back-catalogue
 * article at enqueue time: a strong scroll-stopping hook, a concise summary of
 * the central idea, one curiosity detail, and a call to action — plus the
 * assembled `caption` (hook → summary → curiosity → CTA, no URL) and relevant
 * hashtags. Grounded STRICTLY in the article body (no invented facts, quotes, or
 * stats). Throws AiFunctionDisabledError when `social_caption` is paused so the
 * caller leaves the item without copy rather than posting a bare link.
 */
export async function generateArticleSocialPost(input: {
  title: string;
  dek?: string | null;
  category?: string | null;
  bodyText: string;
  articleId?: string | null;
}): Promise<GeneratedArticleSocialPost> {
  if (!(await isAiFunctionEnabled("social_caption"))) {
    throw new AiFunctionDisabledError("social_caption");
  }
  const directive = await resolveDirective("social_caption");
  const sys = [
    directive,
    "",
    "Tone calibration: match your framing to the article's actual subject. If the article covers trauma, grief, mental health, abuse, loss, religion, politics, or other serious or painful topics, write with quiet respect and genuine curiosity — never cheerful, playful, or trivializing. The hook must be grounded in a real tension, finding, or detail from the article — never generic marketing copy like 'Here's a fun brain hook to start your day'.",
    "",
    "You write the ready-to-post Facebook copy for an article share. Ground every",
    "claim STRICTLY in the article body — never invent facts, quotes, numbers, or",
    "details. Do not include any URL (the link is appended automatically).",
    "",
    "The summary must read like a real editorial blurb — ONE to TWO short",
    "paragraphs of full, grammatical sentences in an engaging voice. Each paragraph",
    "should be two to three sentences (set up the story, then deliver the key",
    "tension/finding or intriguing wrinkle). Separate paragraphs with a blank line",
    "(\\n\\n). Together with the hook and call to action, the finished caption should",
    "read as ABOUT THREE short paragraphs — never more.",
    "",
    "Hashtags must be REAL, widely-used tags that people actually search and follow",
    "on Facebook — NEVER invent niche, obscure, or made-up multi-word tags. First",
    "prefer currently popular / trending hashtags that genuinely fit this article's",
    "specific topic; if none clearly apply, fall back to well-known, popular",
    "hashtags for the article's overall genre/category. Return 3–6 tags,",
    "ordered most-relevant first.",
    HASHTAG_PROMPT_RULES,
    "",
    "Respond with ONLY a JSON object, no prose, in this shape:",
    "{",
    '  "socialHook": "a short scroll-stopping opening line",',
    '  "articleSummary": "ONE to TWO short paragraphs (full sentences, correct grammar, engaging editorial voice) summarizing the article and weaving in a specific, intriguing detail; separate paragraphs with a blank line",',
    '  "curiosityDetail": "one specific, intriguing detail from the article (also woven into articleSummary)",',
    '  "callToAction": "a short call to action — FIRST tell readers the full story is at the link in the comments below (required every time, e.g. \'The full story is at the link in the comments.\' or \'Read the rest at the link in the comments below.\'), THEN add a warm, VARIED ask for engagement (rotate through different phrasings — e.g. \'Liking, following, and sharing would mean so much to us.\' / \'Your likes, follows, and shares always mean the world.\' / \'If this resonated with you, a like, follow, and share goes a long way.\' / \'We\'d love it if you liked, followed, and shared.\'); NEVER say \'link in bio\' or refer to a bio/profile link",',
    '  "caption": "the full caption: hook, then the summary paragraph(s), then the CTA (no URL, no hashtags) — about three short paragraphs total",',
    '  "hashtags": ["#RealPopularTag", "#GenreTag"]',
    "}",
  ].join("\n");
  const body = input.bodyText.replace(/\s+/g, " ").trim().slice(0, 6000);
  const dek = input.dek?.replace(/\s+/g, " ").trim();
  const user = [
    `ARTICLE TITLE: ${input.title}`,
    dek ? `ARTICLE DEK: ${dek}` : "",
    input.category ? `CATEGORY: ${input.category}` : "",
    "",
    "ARTICLE BODY (your only source of facts):",
    body,
    "",
    "Write the social pack now as a single JSON object.",
  ]
    .filter((l) => l !== "")
    .join("\n");
  const model = await resolveModel("social_caption");
  const message = await anthropic.messages.create({
    model,
    max_tokens: 1600,
    temperature: 0.7,
    system: sys,
    messages: [{ role: "user", content: user }],
  });
  recordTextUsage({ operation: "generateArticleSocialPost", model, message, articleId: input.articleId });
  const block = message.content[0];
  const raw = block && block.type === "text" ? block.text : "";
  const clean = stripCiteTagsFromText(raw).text;
  const parsed = extractJson<Record<string, unknown>>(
    clean,
    (v) => typeof v === "object" && v !== null && !Array.isArray(v),
  );
  const pick = (v: unknown): string =>
    typeof v === "string" ? v.replace(/^["'“”]+|["'“”]+$/g, "").trim() : "";
  const socialHook = pick(parsed.socialHook);
  const articleSummary = pick(parsed.articleSummary);
  const curiosityDetail = pick(parsed.curiosityDetail);
  const callToAction = pick(parsed.callToAction);
  // Assemble the caption from its parts with PARAGRAPH BREAKS — hook, then the
  // summary (itself one to two paragraphs), then the CTA — instead of the model's
  // single-block caption, so the Facebook post reads as real paragraphs rather
  // than one terse line. The summary already weaves in the curiosity detail; fall
  // back to the standalone detail only when the summary came back empty.
  const summaryBody = (articleSummary || curiosityDetail).trim();
  let caption = [socialHook, summaryBody, callToAction].filter(Boolean).join("\n\n");
  if (!caption) caption = pick(parsed.caption);
  if (!caption) throw new Error("social post generation returned empty caption");
  const hashtags = Array.isArray(parsed.hashtags)
    ? sanitizeHashtags(
        parsed.hashtags.map((h) => pick(h)).filter(Boolean),
        { maxTags: 8 },
      )
    : [];
  return {
    socialHook,
    articleSummary,
    curiosityDetail,
    callToAction,
    caption: caption.slice(0, 2500),
    hashtags,
  };
}

/**
 * Content-aware hashtags for the daily Term of the Day post. Reads the term's
 * actual definition/example and returns real, popular tags that fit the
 * subject matter (plus learning-flavored tags where they genuinely fit) —
 * replacing the old deterministic beat-word set that recycled the same generic
 * tags every day. Throws AiFunctionDisabledError when `term_hashtags` is
 * paused; the caller falls back to the deterministic builder.
 */
export async function generateTermOfDayHashtags(input: {
  term: string;
  definition: string;
  realLifeExample?: string | null;
  beatName?: string | null;
  moduleType?: string | null;
  maxTags: number;
  /** The term's own PascalCase token — always kept as the first tag. */
  keepToken?: string;
}): Promise<string[]> {
  if (!(await isAiFunctionEnabled("term_hashtags"))) {
    throw new AiFunctionDisabledError("term_hashtags");
  }
  const directive = await resolveDirective("term_hashtags");
  const max = Math.max(1, Math.min(input.maxTags, 15));
  const sys = [
    directive,
    "",
    `Return between 3 and ${Math.max(3, max - 1)} hashtags, ordered most-relevant first.`,
    "Do NOT include a tag for the term's own name — it is prepended automatically.",
    HASHTAG_PROMPT_RULES,
    "",
    'Respond with ONLY a JSON array of tag strings, e.g. ["#RealPopularTag", "#AnotherTag"] — no prose.',
  ].join("\n");
  const user = [
    `TERM: ${input.term}`,
    `DEFINITION: ${input.definition.replace(/\s+/g, " ").trim().slice(0, 1200)}`,
    input.realLifeExample
      ? `REAL-LIFE EXAMPLE: ${input.realLifeExample.replace(/\s+/g, " ").trim().slice(0, 600)}`
      : "",
    input.beatName ? `SITE CATEGORY: ${input.beatName}` : "",
    input.moduleType ? `MODULE TYPE: ${input.moduleType}` : "",
    "",
    "Pick the hashtags now as a single JSON array.",
  ]
    .filter((l) => l !== "")
    .join("\n");
  const model = await resolveModel("term_hashtags");
  const message = await anthropic.messages.create({
    model,
    max_tokens: 300,
    temperature: 0.8,
    system: sys,
    messages: [{ role: "user", content: user }],
  });
  recordTextUsage({ operation: "generateTermOfDayHashtags", model, message });
  const block = message.content[0];
  const raw = block && block.type === "text" ? block.text : "";
  const parsed = extractJson<unknown[]>(raw, (v) => Array.isArray(v));
  const tags = parsed
    .map((t) => (typeof t === "string" ? t.trim() : ""))
    .filter(Boolean);
  if (tags.length === 0) throw new Error("term hashtag generation returned no tags");
  const ordered = input.keepToken ? [input.keepToken, ...tags] : tags;
  return sanitizeHashtags(ordered, {
    maxTags: max,
    keep: input.keepToken ? [input.keepToken] : undefined,
  }).map((t) => t.replace(/^#/, ""));
}

// One article-grounded meme concept returned by the generator. Mirrors the
// MemeConcept schema type but kept structurally independent so llm.ts has no
// hard dependency on the DB schema beyond the layout vocabulary.
export interface GeneratedMemeConcept {
  jokeDescription: string;
  recommendedLayout: "classic_top_bottom" | "split_panel" | "headline_caption" | "explainer";
  topText: string;
  bottomText: string;
  // Up to three optional short tag-line IDEAS (suggestions the admin may append
  // to the bottom text). Replaces the retired single on-image "extra" caption.
  extraTextIdeas: string[];
  visualScene: string;
  // Advisory caption-placement hint the model designed the scene around.
  textPlacement: MemeTextPlacement | null;
  socialHook: string;
  socialSummary: string;
  socialCta: string;
  caption: string;
  hashtags: string[];
}

const MEME_LAYOUT_IDS = ["classic_top_bottom", "split_panel", "headline_caption", "explainer"] as const;

function coerceMemeLayout(v: unknown): GeneratedMemeConcept["recommendedLayout"] {
  return (MEME_LAYOUT_IDS as readonly string[]).includes(String(v))
    ? (v as GeneratedMemeConcept["recommendedLayout"])
    : "classic_top_bottom";
}

function coerceTextZone(v: unknown): MemeTextZone | null {
  return (MEME_TEXT_ZONES as readonly string[]).includes(String(v))
    ? (v as MemeTextZone)
    : null;
}

/**
 * Coerce a model-supplied placement hint into a clean MemeTextPlacement, or null
 * when it's missing/garbled. The composer treats this as advisory only (its own
 * pixel analysis wins), so an unparseable hint simply degrades to "no hint".
 */
function coerceTextPlacement(v: unknown): MemeTextPlacement | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const clearZones = Array.isArray(o.clearZones)
    ? Array.from(
        new Set(o.clearZones.map(coerceTextZone).filter((z): z is MemeTextZone => z !== null)),
      )
    : [];
  const subjectPosition = coerceTextZone(o.subjectPosition) ?? "center";
  return { clearZones, subjectPosition };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Trim a string to at most `maxWords` whole words (no mid-word cut) and strip any
 * trailing punctuation. Used to keep on-image meme text punchy even if the model
 * overshoots the word limits it was given.
 */
function clampWords(v: string, maxWords: number): string {
  const words = v.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  return words.slice(0, maxWords).join(" ").replace(/[\s.,;:-]+$/u, "");
}

/**
 * Trim a paragraph to a word budget WITHOUT ending mid-sentence. Splits into
 * sentences (keeping their terminators) and keeps whole sentences until adding
 * the next one would blow the budget. The first sentence is always kept whole
 * even if it alone exceeds the budget — the meme renderer shrinks text to fit,
 * so a slightly-long COMPLETE sentence is always better than a mid-sentence cut.
 */
function clampToSentences(p: string, budget: number): string {
  const wc = (s: string) => s.split(/\s+/).filter(Boolean).length;
  const sentences = p.match(/[^.!?]+(?:[.!?]+["'”’)\]]*|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [
    p.trim(),
  ];
  const kept: string[] = [];
  let used = 0;
  for (const s of sentences) {
    const w = wc(s);
    if (kept.length > 0 && used + w > budget) break;
    kept.push(s);
    used += w;
    if (used >= budget) break;
  }
  // Drop a trailing dangling connector if the last kept sentence is incomplete
  // (no terminal punctuation) — avoids stopping on "— not".
  return kept.join(" ").replace(/\s*[—–-]\s*$/u, "").trim();
}

/**
 * Clamp a multi-paragraph block to at most two paragraphs and a total word
 * budget, preserving the single blank-line break between paragraphs (the meme
 * renderer honours `\n\n` as a paragraph gap). Used for the explainer layout's
 * article-summary body — `clampWords` would collapse the break into one blob,
 * and a naive word slice would chop the summary off mid-sentence.
 */
function clampParagraphs(v: string, maxWords: number): string {
  const paras = v
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean)
    .slice(0, 2);
  if (paras.length === 0) return "";
  const kept: string[] = [];
  let budget = maxWords;
  for (const p of paras) {
    if (budget <= 0) break;
    const clamped = clampToSentences(p, budget);
    if (clamped) {
      kept.push(clamped);
      budget -= clamped.split(/\s+/).filter(Boolean).length;
    }
  }
  return kept.join("\n\n");
}

/**
 * Generate three distinct, article-grounded meme concepts for the manual meme
 * builder. Each concept carries the joke, a recommended layout, the meme text
 * fields, a text-free visual scene (for AI artwork), and a social pack
 * (caption + hashtags). Grounded strictly in the article body. Throws
 * AiFunctionDisabledError when `meme_concepts` is paused so the route reports it.
 */
// Admin-chosen render medium, stated for the VISUAL SCENE description (kept
// separate from the ART_STYLE_PROMPTS in memes.ts, which instruct the image
// model at render time — this steers the scene *text* the model writes).
const MEME_ART_STYLE_SCENE: Record<MemeArtStyle, string> = {
  auto: "",
  photographic:
    "ART STYLE (admin-chosen, applies to the visualScene): describe the scene as a realistic, photographic real-world moment — natural lighting and texture, as if shot by a camera. NOT an illustration, cartoon, drawing, or 3D render.",
  cartoon:
    "ART STYLE (admin-chosen, applies to the visualScene): describe the scene as a polished modern digital CARTOON / MEME ILLUSTRATION — thick clean black outlines, expressive exaggerated faces, rounded character design, saturated colors, smooth cel-shaded lighting with soft gradients, crisp social-media illustration quality, high contrast, readable silhouettes, emotional facial acting, slightly glossy highlights, simple clear backgrounds, dramatic mood lighting that matches the meme. Clean finished viral meme aesthetic. NOT photorealistic, NOT anime, NOT sketchy, NOT 3D render, NOT painterly realism, NOT generic furry convention art, NOT overly realistic animal faces. No text of any kind in the image.",
  illustration:
    "ART STYLE (admin-chosen, applies to the visualScene): describe the scene as a clean, modern editorial ILLUSTRATION — deliberate shapes and color, polished digital art. NOT a photograph and NOT a rough cartoon.",
};

export async function generateMemeConcepts(input: {
  title: string;
  dek?: string | null;
  category?: string | null;
  bodyText: string;
  // Admin-chosen BEFORE generation. `preferredLayout` is forced onto all 3
  // concepts; `artStyle` shapes the visualScene's medium.
  preferredLayout?: MemeLayout | null;
  artStyle?: MemeArtStyle | null;
  memeId?: string | null;
}): Promise<GeneratedMemeConcept[]> {
  if (!(await isAiFunctionEnabled("meme_concepts"))) {
    throw new AiFunctionDisabledError("meme_concepts");
  }
  const directive = await resolveDirective("meme_concepts");
  const layoutRule = input.preferredLayout
    ? `LAYOUT (admin-chosen): use recommendedLayout "${input.preferredLayout}" for ALL 3 concepts — build every concept's text and visualScene to fit that one layout. Do NOT pick a different layout.`
    : "";
  const artStyleRule = input.artStyle ? MEME_ART_STYLE_SCENE[input.artStyle] : "";
  const sys = [
    directive,
    "",
    ...(layoutRule ? [layoutRule, ""] : []),
    ...(artStyleRule ? [artStyleRule, ""] : []),
    "MEME TEXT RULES — the on-image text must read like a real meme: punchy, blunt,",
    "and tight — but CLEVER beats short. Write the funniest, sharpest line the joke",
    "needs, not the fewest words possible. A complete sentence is fine when it lands.",
    "Sound like a real, chronically-online person — modern, relatable, a little edgy",
    "(group-chat / TikTok-rant energy), NOT a brand or an AI. ZERO corporate clichés:",
    "no PowerPoint/slide decks/'47-slide PowerPoint of grievances', no spreadsheets,",
    "Excel, charts, KPIs, 'circle back', 'synergy', or office-meeting framing, and don't",
    "run the stiff 'When you... but...' formula on autopilot. If a line sounds like",
    "LinkedIn or a mascot trying to be relatable, rewrite it like a person.",
    "Soft guidance (the renderer auto-fits long text, so don't pad, but don't gut a",
    "good line to hit a word count either):",
    "- topText: the setup — usually up to ~12 words. Land a specific, article-grounded angle.",
    "- bottomText: the punchline — usually up to ~12 words. This is where the joke pays off; make it land.",
    "- extraTextIdeas: up to THREE OPTIONAL short alternative tag lines (each ~6 words) the admin",
    "  could tack onto the bottom text for extra punch. These are SUGGESTIONS only — never rendered",
    "  on their own. Make each a distinct, self-contained kicker. Use [] if none genuinely add value.",
    "A question mark or exclamation is fine when it sharpens the joke; no hashtags in the on-image text.",
    "",
    'LONGER "EXPLAINER" FORMAT (recommendedLayout: "explainer") — for POLITICAL or',
    "SCIENCE stories that land through a substantive, factual play-by-play rather than",
    "a one-line punchline (think the viral 'Really American' political breakdowns or big",
    "science 'here's what actually happened' posts). When you choose explainer:",
    "- topText: a SHORT, punchy headline/kicker, up to ~7 words (or an empty string).",
    "  Keep it tight so it renders BIG and bold above the summary — not a full sentence.",
    "- bottomText: an ARTICLE SUMMARY — ONE or TWO short paragraphs (~70-110 words total)",
    "  that explain what the article actually says, plainly and factually, building to the",
    "  point. This summary IS the format, so write real, complete paragraphs — not a",
    "  one-liner. If you use two paragraphs, separate them with ONE blank line.",
    "- extraTextIdeas: leave it an empty array.",
    "Reserve explainer for political/science pieces where the longer summary genuinely",
    "beats a punchy meme; otherwise prefer the punchy layouts above.",
    "",
    "VISUAL SCENE RULES — the background image must be FUNNY or FLASHY, never a dry,",
    "literal stock photo. The scene is what makes the meme stop a scroll:",
    "- Describe an exaggerated, absurd, surprising, or wildly expressive moment that",
    "  amplifies the joke — comic situations, dramatic reactions, ridiculous contrasts.",
    "- Lean bold and over-the-top: big facial expressions, dynamic action, saturated",
    "  punchy color, a single instantly-readable focal subject.",
    "- Keep it modern, human, and internet-native (a real person mid-reaction, an",
    "  absurd candid moment) — NOT a corporate stock photo. NO PowerPoint/projector",
    "  slides, NO spreadsheets/Excel/charts on screens, NO boardroom meetings, NO",
    "  suited businesspeople pointing at data, NO sterile office backdrops.",
    "- It must be ONE clear scene (not a split or collage) UNLESS you choose the",
    "  split_panel layout (see its exception below), leave clean uncluttered space",
    "  near the top and bottom for caption text, and contain NO text of any kind.",
    "- ALSO report a textPlacement object describing the scene you designed: which",
    "  horizontal zones you left clean and text-safe (\"top\", \"center\", \"bottom\") and",
    "  where the main focal subject sits (subjectPosition). The renderer uses this to",
    "  size and place captions so they don't cover the subject — keep it honest to the",
    "  scene you wrote.",
    "- EXCEPTION for the explainer layout (political/science): the scene must be a",
    "  striking but CLEAR, vividly-lit editorial image of the ACTUAL subject of THIS",
    "  specific article — the real people, place, event, or thing the story is about —",
    "  NOT a generic 'politics' or 'law' or 'science' stock concept. For political and",
    "  human stories strongly prefer real, expressive PEOPLE central to the story and",
    "  their reaction or situation; for science/nature/space depict the actual",
    "  phenomenon accurately. Do NOT fall back on the lazy editorial clichés the model",
    "  defaults to: towering stacks of documents / folders / paperwork, a lone gavel or",
    "  scales of justice, an empty podium or chair, charts or data on a screen, a person",
    "  staring at a monitor, or the dim 'single harsh spotlight in a pitch-dark room' /",
    "  murky warm-tungsten look. Use bright, saturated, well-lit color (dramatic, not",
    "  dark or murky) and ONE instantly-readable focal subject — dramatic but not",
    "  comedic, still a single text-free scene.",
    "- EXCEPTION for the split_panel layout: the visualScene SHOULD describe TWO",
    "  contrasting panels (e.g. before/after, expectation/reality, or setup/payoff)",
    "  that together land the joke — split EITHER into a top half and a bottom half OR",
    "  a left half and a right half, whichever best fits the two moments. Describe",
    "  both panels as one coherent, text-free image with clean space at the very top",
    "  and very bottom edges for the two captions.",
    "",
    "FACEBOOK CAPTION COPY (separate from the on-image meme text above) — the",
    "socialHook/socialSummary/socialCta fields are the words posted in the Facebook",
    "post body alongside the meme image. These are NOT the on-image text and are NOT",
    "subject to the punchy word limits above. The socialSummary must read like a real",
    "editorial blurb: ONE to TWO short paragraphs of full, grammatical sentences",
    "grounded STRICTLY in the article body, each paragraph two to three sentences",
    "adding something new. Separate paragraphs with a blank line (\\n\\n).",
    "Together with the hook and CTA the finished caption should read as ABOUT THREE",
    "short paragraphs — never more. Never collapse it to a single sentence.",
    "",
    "Respond with ONLY a JSON array of EXACTLY 3 objects, no prose, in this shape:",
    "[{",
    '  "jokeDescription": "one sentence describing the joke/angle",',
    '  "recommendedLayout": "classic_top_bottom" | "split_panel" | "headline_caption" | "explainer",',
    '  "topText": "the setup line — clever and specific, ~12 words (or a short ~7-word headline/kicker for explainer)",',
    '  "bottomText": "the punchline line, ~12 words — OR, for explainer, a 1-2 paragraph (~70-110 word) article summary (blank line between paragraphs)",',
    '  "extraTextIdeas": ["up to three optional ~6-word alternative tag lines to tack onto the bottom text (empty array for explainer)"],',
    '  "visualScene": "a funny/flashy, exaggerated, text-free scene for the background image (a single scene, OR two contrasting panels split top/bottom or left/right for split_panel — per the VISUAL SCENE RULES above)",',
    '  "textPlacement": { "clearZones": ["top","bottom"], "subjectPosition": "center" },',
    '  "socialHook": "a short scroll-stopping hook",',
    '  "socialSummary": "ONE to TWO short paragraphs (full sentences, engaging editorial voice) summarizing the article and weaving in a specific intriguing detail; separate paragraphs with a blank line",',
    '  "socialCta": "a short call to action — FIRST tell readers the full story is at the link in the comments below (required every time, e.g. \'The full story is at the link in the comments.\' or \'See the full article at the link in the comments below.\'), THEN add a warm, VARIED ask for engagement (rotate through different phrasings — e.g. \'Liking, following, and sharing would mean so much to us.\' / \'Your likes, follows, and shares always mean the world.\' / \'If this made you think, a like, follow, and share goes a long way.\' / \'We\'d love it if you liked, followed, and shared.\'); NEVER say \'link in bio\' or refer to a bio/profile link",',
    '  "caption": "the full Facebook caption: hook, then the summary paragraph(s), then the CTA (no URL, no hashtags) — about three short paragraphs",',
    '  "hashtags": ["#tag1", "#tag2"]',
    "}]",
    "",
    "Hashtags: this is a MEME post — mix tags for the article's actual subject with",
    "real, widely-followed meme/humor tags that fit the joke's vibe. Every tag must",
    "be a genuinely popular tag people follow on Facebook; vary picks per concept —",
    "never fall back to the same generic set.",
    HASHTAG_PROMPT_RULES,
  ].join("\n");
  // Feed the WHOLE article so the meme can land on any detail, including late ones.
  // The generous cap is only a runaway-input guard (covers essentially every post).
  const body = input.bodyText.replace(/\s+/g, " ").trim().slice(0, 32000);
  const dek = input.dek?.replace(/\s+/g, " ").trim();
  const user = [
    `ARTICLE TITLE: ${input.title}`,
    dek ? `ARTICLE DEK: ${dek}` : "",
    input.category ? `CATEGORY: ${input.category}` : "",
    "",
    "ARTICLE BODY (your only source of facts):",
    body,
    "",
    "Write the 3 meme concepts now as a JSON array.",
  ]
    .filter((l) => l !== "")
    .join("\n");
  const model = await resolveModel("meme_concepts");
  const message = await anthropic.messages.create({
    model,
    max_tokens: 4000,
    temperature: 0.9,
    system: sys,
    messages: [{ role: "user", content: user }],
  });
  recordTextUsage({ operation: "generateMemeConcepts", model, message, memeId: input.memeId });
  const block = message.content[0];
  const raw = block && block.type === "text" ? block.text : "";
  const parsed = extractJson<unknown[]>(raw, (v) => Array.isArray(v));
  const concepts: GeneratedMemeConcept[] = parsed
    .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
    .map((c) => {
      const recommendedLayout = input.preferredLayout ?? coerceMemeLayout(c.recommendedLayout);
      // The explainer layout's bottomText is a 1-2 paragraph article SUMMARY, so
      // it needs a far higher word cap AND must keep its paragraph break (use
      // clampParagraphs, not clampWords). topText is a tight gold kicker so it
      // renders big, so it gets a shorter cap than the punchy setups.
      const isExplainer = recommendedLayout === "explainer";
      return {
      jokeDescription: str(c.jokeDescription),
      recommendedLayout,
      // Generous safety net only: clever, complete lines are the goal, so these
      // caps just stop a runaway response (whole-word trim, no mid-word cut).
      topText: clampWords(str(c.topText), isExplainer ? 9 : 16),
      bottomText: isExplainer
        ? clampParagraphs(str(c.bottomText), 120)
        : clampWords(str(c.bottomText), 16),
      extraTextIdeas: Array.isArray(c.extraTextIdeas)
        ? c.extraTextIdeas
            .map((t) => clampWords(str(t), 8))
            .filter(Boolean)
            .slice(0, 3)
        : [],
      visualScene: str(c.visualScene),
      textPlacement: coerceTextPlacement(c.textPlacement),
      socialHook: str(c.socialHook),
      socialSummary: str(c.socialSummary),
      socialCta: str(c.socialCta),
      caption: str(c.caption),
      hashtags: Array.isArray(c.hashtags)
        ? sanitizeHashtags(c.hashtags.map((h) => str(h)).filter(Boolean), { maxTags: 8 })
        : [],
      };
    })
    .filter((c) => c.jokeDescription || c.topText || c.bottomText || c.caption);
  if (concepts.length === 0) throw new Error("meme concept generation returned no usable concepts");
  return concepts.slice(0, 3);
}

/**
 * Rewrite a meme's bottom text into the explainer layout's ARTICLE SUMMARY — a
 * 1-2 paragraph (~70-110 word) factual breakdown grounded strictly in the
 * article body and kept tied to the chosen concept (its joke/angle + the gold
 * kicker that sits above the summary). Used when an admin switches a meme to the
 * explainer layout and the current bottom text is still a one-line punchline.
 * Throws AiFunctionDisabledError when `meme_concepts` is paused so the caller
 * leaves the text untouched rather than blanking it.
 *
 * (See generateMemeExplainerSummary below for the implementation.)
 */
/**
 * Optional slant for a regenerated visual scene. Shapes WHAT/HOW the scene
 * depicts (its content + medium) without touching the on-image meme text. Not
 * persisted — it's a per-request hint passed by the admin's "Regenerate prompt"
 * direction selector.
 */
const MEME_VISUAL_DIRECTIONS = {
  realistic:
    "DIRECTION: describe a believable, realistic real-world scene as if captured by a real camera — grounded and photographic, not fantastical or illustrated.",
  people:
    "DIRECTION: center the scene on real, expressive PEOPLE — make a person (or people) and their reaction/body language the clear focal subject.",
  objects:
    "DIRECTION: center the scene on objects, props, or a symbolic still-life that represents the angle — keep human faces out of the focal subject.",
  cartoon:
    "DIRECTION: describe the scene as a bold, playful CARTOON / comic illustration — exaggerated and characterful, clearly drawn rather than photographic.",
  political_cartoon:
    "DIRECTION: describe the scene as a classic editorial POLITICAL CARTOON — a satirical caricature with exaggerated figures and symbolic props, in the style of a newspaper op-ed cartoon.",
} as const;
export type MemeVisualDirection = keyof typeof MEME_VISUAL_DIRECTIONS;

/**
 * Regenerate ONLY the meme's visual scene (the text-free background-image
 * prompt), grounded in the article + the meme's joke/angle. An optional
 * `direction` slants the scene's content/medium (realistic, people, objects,
 * cartoon, political cartoon). Returns a single cleaned scene description.
 * Throws AiFunctionDisabledError when `meme_concepts` is paused.
 */
export async function generateMemeVisualScene(input: {
  title: string;
  dek?: string | null;
  category?: string | null;
  bodyText: string;
  jokeDescription?: string | null;
  topText?: string | null;
  bottomText?: string | null;
  direction?: MemeVisualDirection | null;
  layout?: MemeLayout | null;
  artStyle?: MemeArtStyle | null;
  memeId?: string | null;
}): Promise<{ scene: string; textPlacement: MemeTextPlacement | null }> {
  if (!(await isAiFunctionEnabled("meme_concepts"))) {
    throw new AiFunctionDisabledError("meme_concepts");
  }
  const directionRule = input.direction ? MEME_VISUAL_DIRECTIONS[input.direction] : "";
  const artStyleRule = input.artStyle ? MEME_ART_STYLE_SCENE[input.artStyle] : "";
  // The split_panel layout stamps a top AND a bottom caption over a genuine
  // two-panel image, so the scene the model writes must itself describe two
  // stacked panels — otherwise regenerating a split_panel meme's prompt yields a
  // single scene that doesn't match the layout. Mirrors the split_panel exception
  // in generateMemeConcepts.
  const isSplitPanel = input.layout === "split_panel";
  const splitRules = isSplitPanel
    ? [
        "",
        "SPLIT-PANEL LAYOUT: the scene MUST describe TWO contrasting panels (e.g.",
        "before/after, expectation/reality, or setup/payoff) that together land the",
        "joke — split EITHER into a top half and a bottom half OR a left half and a",
        "right half, whichever best fits the two moments. Describe both panels as one",
        "coherent, text-free image with clean, uncluttered space at the very top edge",
        "and the very bottom edge for the two captions. Leave clearZones as",
        '["top","bottom"].',
      ]
    : [];
  const sceneClause = isSplitPanel
    ? '{ "scene": "one or two vivid sentences describing the TWO contrasting panels (split top/bottom or left/right, whichever fits), text-free, no caption/meme text",'
    : '{ "scene": "one or two vivid sentences describing the text-free scene (no caption/meme text)",';
  const sys = [
    isSplitPanel
      ? "You write the VISUAL SCENE for a meme's text-free background image — a SPLIT-PANEL image of two contrasting panels (split top/bottom or left/right, whichever best fits) that makes the meme stop a scroll. It must contain NO text of any kind and leave clean, uncluttered space near the top and bottom for caption text."
      : "You write the VISUAL SCENE for a meme's text-free background image — ONE clear, single scene that makes the meme stop a scroll. It must contain NO text of any kind and leave clean, uncluttered space near the top and bottom for caption text.",
    "Ground the scene in what the article is actually about AND in the meme's joke/angle.",
    "",
    "Keep it vivid and scroll-stopping — an absurd, surprising, or wildly expressive",
    "moment with ONE instantly-readable focal subject and bright, saturated color.",
    "Avoid dry literal stock-photo framing and the lazy editorial clichés (towering",
    "document stacks, a lone gavel or scales, an empty podium, charts/data on a screen,",
    "a person staring at a monitor, or a dim spotlight in a pitch-dark room).",
    ...(artStyleRule ? ["", artStyleRule] : []),
    ...(directionRule ? ["", directionRule] : []),
    ...splitRules,
    "",
    "Respond with ONLY a JSON object (no preamble, no markdown fence) of the form:",
    sceneClause,
    '  "textPlacement": { "clearZones": ["top","bottom"], "subjectPosition": "center" } }',
    'textPlacement reports the scene you designed: which horizontal zones ("top",',
    '"center", "bottom") you left clean and text-safe, and where the focal subject',
    "sits (subjectPosition). The renderer uses it to size and place captions so they",
    "don't cover the subject — keep it honest to the scene you wrote.",
  ].join("\n");
  const body = input.bodyText.replace(/\s+/g, " ").trim().slice(0, 32000);
  const dek = input.dek?.replace(/\s+/g, " ").trim();
  const joke = input.jokeDescription?.replace(/\s+/g, " ").trim();
  const top = input.topText?.replace(/\s+/g, " ").trim();
  const bottom = input.bottomText?.replace(/\s+/g, " ").trim();
  const user = [
    `ARTICLE TITLE: ${input.title}`,
    dek ? `ARTICLE DEK: ${dek}` : "",
    input.category ? `CATEGORY: ${input.category}` : "",
    joke ? `MEME ANGLE (keep the scene tied to this take): ${joke}` : "",
    top ? `TOP TEXT (on the image, do not depict as text): ${top}` : "",
    bottom ? `BOTTOM TEXT (on the image, do not depict as text): ${bottom}` : "",
    "",
    "ARTICLE BODY (your only source of facts):",
    body,
    "",
    "Write the new visual scene now.",
  ]
    .filter((l) => l !== "")
    .join("\n");
  const model = await resolveModel("meme_concepts");
  const message = await anthropic.messages.create({
    model,
    max_tokens: 400,
    temperature: 0.9,
    system: sys,
    messages: [{ role: "user", content: user }],
  });
  recordTextUsage({ operation: "generateMemeVisualScene", model, message, memeId: input.memeId });
  const block = message.content[0];
  const raw = block && block.type === "text" ? block.text : "";
  // The model returns { scene, textPlacement }. Be lenient: if it slips back into
  // plain prose (no JSON), treat the whole reply as the scene and drop the hint.
  let sceneRaw = "";
  let textPlacement: MemeTextPlacement | null = null;
  try {
    const parsed = extractJson<Record<string, unknown>>(
      raw,
      (v) => typeof v === "object" && v !== null && !Array.isArray(v),
    );
    sceneRaw = str(parsed.scene);
    textPlacement = coerceTextPlacement(parsed.textPlacement);
  } catch {
    sceneRaw = raw;
  }
  const clean = stripCiteTagsFromText(sceneRaw)
    .text.replace(/\s+/g, " ")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .trim();
  if (!clean) throw new Error("visual scene generation returned empty text");
  return { scene: clean.slice(0, 1000), textPlacement };
}

export interface MemeAutoPlacement {
  topOffsetAdj: number;
  bottomOffsetAdj: number;
  topSizeAdj: number;
  bottomSizeAdj: number;
  note: string;
}

const AUTO_PLACE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function clampInt(v: unknown, lo: number, hi: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/**
 * Smart "auto-place": look at the meme's TEXT-FREE base image and recommend how
 * to nudge the top/bottom captions off the subject. Returns deltas in the SAME
 * units as the manual fine-tune sliders (caption offset = pixels on a 1080×1080
 * canvas, caption size = percent), so the caller can write them straight into the
 * meme's adjustment columns and recompose for free (no image re-bill). This is a
 * cheap vision text call, NOT image generation.
 */
export async function suggestMemeTextPlacement(input: {
  imageBase64: string;
  mimeType: string;
  layout?: MemeLayout | null;
  topText?: string | null;
  bottomText?: string | null;
  memeId?: string | null;
}): Promise<MemeAutoPlacement> {
  if (!(await isAiFunctionEnabled("meme_auto_place"))) {
    throw new AiFunctionDisabledError("meme_auto_place");
  }
  const directive = (await resolveDirective("meme_auto_place")).trim();
  const mediaType = AUTO_PLACE_MIME.has(input.mimeType) ? input.mimeType : "image/png";
  const top = input.topText?.replace(/\s+/g, " ").trim();
  const bottom = input.bottomText?.replace(/\s+/g, " ").trim();
  const sys = [
    ...(directive ? [directive, ""] : []),
    "You are a meme layout assistant. You are shown the TEXT-FREE background image",
    "for a meme. White caption text will be composited OVER it — a top caption hugs",
    "the TOP edge and a bottom caption hugs the BOTTOM edge. Your job: keep the",
    "captions off the main subject and out of busy/cluttered areas, using the clean",
    "negative space.",
    "",
    "The canvas is 1080×1080 pixels. Recommend nudges as DELTAS from automatic",
    "placement:",
    '- "topOffsetAdj" (pixels, 0..430): push the TOP caption DOWN, away from the top',
    "  edge toward the center. 0 = leave it hugging the top. Increase it when the",
    "  subject or clutter sits high in the frame.",
    '- "bottomOffsetAdj" (pixels, 0..430): push the BOTTOM caption UP, away from the',
    "  bottom edge. 0 = leave it hugging the bottom. Increase it when the subject or",
    "  clutter sits low in the frame.",
    '- "topSizeAdj" / "bottomSizeAdj" (percent, -60..100): shrink (negative) when the',
    "  only clean band is narrow, or grow (positive) when there is lots of clean",
    "  space. 0 = automatic size.",
    "",
    "Only move a caption as much as needed; prefer small nudges. If placement is",
    "already good, return zeros. Captions can never leave the canvas, so stay within",
    "the ranges.",
    "",
    'Respond with ONLY a JSON object (no preamble, no markdown fence): { "topOffsetAdj":',
    '0, "bottomOffsetAdj": 0, "topSizeAdj": 0, "bottomSizeAdj": 0, "note": "one short',
    'sentence explaining the placement" }',
  ].join("\n");
  const userText = [
    input.layout ? `LAYOUT: ${input.layout}` : "",
    top ? `TOP CAPTION: ${top}` : "TOP CAPTION: (none)",
    bottom ? `BOTTOM CAPTION: ${bottom}` : "BOTTOM CAPTION: (none)",
    "",
    "Recommend the caption placement adjustments for this image now.",
  ]
    .filter((l) => l !== "")
    .join("\n");
  const model = await resolveModel("meme_auto_place");
  const message = await anthropic.messages.create({
    model,
    max_tokens: 300,
    temperature: 0.2,
    system: sys,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType as "image/png", data: input.imageBase64 },
          },
          { type: "text", text: userText },
        ],
      },
    ],
  });
  recordTextUsage({ operation: "suggestMemeTextPlacement", model, message, memeId: input.memeId });
  const block = message.content[0];
  const raw = block && block.type === "text" ? block.text : "";
  const parsed = extractJson<Record<string, unknown>>(
    raw,
    (v) => typeof v === "object" && v !== null && !Array.isArray(v),
  );
  const note = str(parsed.note).replace(/\s+/g, " ").trim().slice(0, 200);
  // Only the bottom caption exists when there's no top text (and vice versa); the
  // caller still gets full deltas — the compositor ignores a side with no text.
  return {
    topOffsetAdj: clampInt(parsed.topOffsetAdj, 0, 430),
    bottomOffsetAdj: clampInt(parsed.bottomOffsetAdj, 0, 430),
    topSizeAdj: clampInt(parsed.topSizeAdj, -60, 100),
    bottomSizeAdj: clampInt(parsed.bottomSizeAdj, -60, 100),
    note,
  };
}

export async function generateMemeExplainerSummary(input: {
  title: string;
  dek?: string | null;
  category?: string | null;
  bodyText: string;
  jokeDescription?: string | null;
  kicker?: string | null;
  memeId?: string | null;
}): Promise<string> {
  if (!(await isAiFunctionEnabled("meme_concepts"))) {
    throw new AiFunctionDisabledError("meme_concepts");
  }
  const sys = [
    "You write the on-image ARTICLE SUMMARY for the explainer meme layout — the",
    "longer 'here's what actually happened' format (think viral 'Really American'",
    "political breakdowns or big science explainers). Ground EVERY claim STRICTLY",
    "in the article body — never invent facts, quotes, numbers, or details.",
    "",
    "Write ONE or TWO short paragraphs, ~70-110 words total, that explain what the",
    "article actually says — plainly and factually, building to the point. This",
    "summary IS the format, so write real, complete sentences, not a one-liner or a",
    "punchline. If you use two paragraphs, separate them with ONE blank line. Do NOT",
    "repeat the kicker headline, do NOT add hashtags, labels, or any URL.",
    "",
    "Respond with ONLY the summary text — no preamble, no quotes, no JSON.",
  ].join("\n");
  const body = input.bodyText.replace(/\s+/g, " ").trim().slice(0, 32000);
  const dek = input.dek?.replace(/\s+/g, " ").trim();
  const joke = input.jokeDescription?.replace(/\s+/g, " ").trim();
  const kicker = input.kicker?.replace(/\s+/g, " ").trim();
  const user = [
    `ARTICLE TITLE: ${input.title}`,
    dek ? `ARTICLE DEK: ${dek}` : "",
    input.category ? `CATEGORY: ${input.category}` : "",
    joke ? `MEME ANGLE (keep the summary tied to this take): ${joke}` : "",
    kicker ? `KICKER ABOVE THE SUMMARY (do not repeat it): ${kicker}` : "",
    "",
    "ARTICLE BODY (your only source of facts):",
    body,
    "",
    "Write the explainer summary now.",
  ]
    .filter((l) => l !== "")
    .join("\n");
  const wordCount = (t: string) => t.split(/\s+/).filter(Boolean).length;
  const MIN_WORDS = 55; // floor so we never accept a one-liner masquerading as a summary
  const model = await resolveModel("meme_concepts");
  let summary = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: user }];
    if (attempt > 0) {
      // First pass came back too short — push explicitly for the full length.
      messages.push(
        { role: "assistant", content: summary || "(too short)" },
        {
          role: "user",
          content:
            "That is too short for the explainer layout. Rewrite it as a fuller 1-2 paragraph summary of ~80-110 words, still grounded strictly in the article body. Respond with ONLY the summary text.",
        },
      );
    }
    const message = await anthropic.messages.create({
      model,
      max_tokens: 600,
      temperature: 0.7,
      system: sys,
      messages,
    });
    recordTextUsage({ operation: "generateMemeExplainerSummary", model, message, memeId: input.memeId });
    const block = message.content[0];
    const raw = block && block.type === "text" ? block.text : "";
    const clean = stripCiteTagsFromText(raw).text;
    summary = clampParagraphs(clean.replace(/^["'“”]+|["'“”]+$/g, "").trim(), 120);
    if (summary && wordCount(summary) >= MIN_WORDS) return summary;
  }
  if (!summary) throw new Error("explainer summary generation returned empty text");
  if (wordCount(summary) < MIN_WORDS) {
    throw new Error("explainer summary generation returned text too short for the explainer layout");
  }
  return summary;
}

export interface GeneratedArticle {
  title: string;
  titleCandidates?: string[];
  dek: string;
  body: ArticleBlock[];
}

export async function generateArticleDraft(
  author: Author,
  idea: { title: string; angle: string },
  opts: {
    avoidContext?: string;
    previousArticle?: { title: string; dek: string; firstParagraph: string };
    allowedBeats?: { category: string; categorySlug: string; slant?: string | null }[];
    internalLinkCandidates?: { title: string; slug: string }[];
    articleId?: string | null;
    // Trend-intelligence cost attribution — when the draft is packet-grounded,
    // the packet + cluster it came from, recorded on the cost meter.
    packetId?: string | null;
    clusterId?: string | null;
    // When this draft was promoted from a screened editorial evidence packet,
    // its vetted grounding: sources with real (already-confirmed) URLs,
    // established claims, cleared quotes, and open contradictions. Present only
    // for Editor Cockpit promotions; the normal pipeline leaves it undefined.
    evidencePacket?: {
      label: string;
      claims: { text: string; sourceIds: string[] }[];
      sources: { id: string; url: string; domain: string; title: string | null; authorityTier: string }[];
      quotes: { text: string; attribution: string; sourceId: string | null }[];
      contradictions: { summary: string }[];
      // Verbatim Source Vault excerpts backing the packet (Task #233). When
      // present, the drafter is instructed to build the piece from THESE
      // excerpts rather than re-researching, since draft-time web search is
      // capped (usually 0) for auto-grounded drafts.
      supportingChunks?: { sourceId: string; text: string; similarity?: number }[];
    };
    // Per-draft web_search cap (Task #233). Auto-grounded/packet-backed drafts
    // pass 0 (no draft-time web search); the legacy override reproduces the old
    // nonzero cap. Defaults to the previous behaviour (1 with a packet, else 3).
    maxWebSearches?: number;
    // When an article has an editorial label override set, inject the matching
    // style directive so redrafts adopt the intended angle automatically.
    editorialLabelOverride?: string | null;
  } = {},
): Promise<GeneratedArticle> {
  if (!(await isAiFunctionEnabled("draft_generation"))) {
    throw new AiFunctionDisabledError("draft_generation");
  }
  const sys = buildAuthorSystemPrompt(author, {
    allowedBeats: opts.allowedBeats,
    editorialStandards: await resolveDirective("draft_generation"),
  });
  const target = author.wordCountTarget;
  const floor = Math.min(300, target);
  const followUp = opts.previousArticle
    ? `\n\nThis is a FOLLOW-UP to your earlier article:\nTitle: ${opts.previousArticle.title}\nSubhead: ${opts.previousArticle.dek}\nOpening: ${opts.previousArticle.firstParagraph}\n\nReference what has changed since then. Don't recap the original at length — point readers back to it briefly and focus on what's new.`
    : "";
  const internalLinkTargets = (opts.internalLinkCandidates ?? []).filter(
    (c) => c && typeof c.slug === "string" && c.slug.length > 0 && typeof c.title === "string" && c.title.length > 0,
  );
  const internalLinks = internalLinkTargets.length
    ? `\n- INTERNAL LINKS: Where it genuinely helps the reader, weave in a few contextual links (up to ~4, scaled to length — fewer or none in a short piece) to OTHER existing BrainHook articles, using Markdown link syntax with a RELATIVE path: [natural phrase](/article/<slug>). Pick only targets whose subject truly relates to the surrounding sentence, embed the link naturally inside the running prose (never as a list or a "read more" dump), link each target at most once, and skip linking entirely where nothing fits. Use ONLY slugs from the list below — never invent a slug. These internal links are SEPARATE from citation/source links (which point to external source pages). Linkable BrainHook articles:\n${internalLinkTargets.map((c) => `  - "${c.title}" → /article/${c.slug}`).join("\n")}`
    : "";
  // Vetted-evidence grounding block (Editor Cockpit promotions only). The packet
  // sources have already been confirmed real by the newsroom, so the drafter
  // should cite them directly rather than re-searching from scratch.
  const packet = opts.evidencePacket;
  let hasPacket = false;
  let evidenceBlock = "";
  if (packet && (packet.sources.length > 0 || packet.claims.length > 0)) {
    hasPacket = true;
    const srcIndex = new Map<string, string>();
    packet.sources.forEach((s, i) => srcIndex.set(s.id, `S${i + 1}`));
    const sourceLines = packet.sources
      .map((s, i) => `  [S${i + 1}] ${s.title ? `${s.title} — ` : ""}${s.domain} (${s.authorityTier}) → ${s.url}`)
      .join("\n");
    const claimLines = packet.claims
      .slice(0, 12)
      .map((c) => {
        const cites = c.sourceIds.map((id) => srcIndex.get(id)).filter(Boolean);
        return `  - ${c.text}${cites.length ? ` [${cites.join(", ")}]` : ""}`;
      })
      .join("\n");
    const quoteLines = packet.quotes
      .slice(0, 6)
      .map((q) => {
        const tag = q.sourceId && srcIndex.get(q.sourceId) ? ` [${srcIndex.get(q.sourceId)}]` : "";
        return `  - "${q.text}" — ${q.attribution}${tag}`;
      })
      .join("\n");
    const contradictionLines = packet.contradictions
      .slice(0, 5)
      .map((c) => `  - ${c.summary}`)
      .join("\n");
    // Relevant Vault excerpts (Task #233): verbatim passages pulled from the
    // Source Vault, grouped under their source label, so the drafter can build
    // the piece directly from the retrieved text instead of re-researching.
    const chunks = packet.supportingChunks ?? [];
    let excerptLines = "";
    if (chunks.length > 0) {
      const bySource = new Map<string, { text: string; similarity?: number }[]>();
      for (const c of chunks) {
        const arr = bySource.get(c.sourceId) ?? [];
        if (arr.length < 3) arr.push({ text: c.text, similarity: c.similarity });
        bySource.set(c.sourceId, arr);
      }
      excerptLines = [...bySource.entries()]
        .map(([sourceId, items]) => {
          const label = srcIndex.get(sourceId) ?? "S?";
          const passages = items
            .map((it) => `    · <source_text>${it.text.replace(/\s+/g, " ").trim().slice(0, 600)}</source_text>`)
            .join("\n");
          return `  [${label}]\n${passages}`;
        })
        .join("\n");
    }
    const noWebSearch = Math.max(0, Math.floor(opts.maxWebSearches ?? (hasPacket ? 1 : 3))) === 0;
    evidenceBlock = `

VETTED EVIDENCE PACKET — already screened by the BrainHook newsroom. Treat this as your PRIMARY grounding.
Topic: ${packet.label}${
      sourceLines
        ? `\n\nSources (authority-ordered). These URLs are ALREADY CONFIRMED REAL — cite them directly with Markdown [phrase](url); you should NOT need to search for them:\n${sourceLines}`
        : ""
    }${claimLines ? `\n\nEstablished claims (each followed by the supporting sources):\n${claimLines}` : ""}${
      quoteLines
        ? `\n\nQuotable passages (verified verbatim & clearance-checked — you may quote these directly with attribution):\n${quoteLines}`
        : ""
    }${
      excerptLines
        ? `\n\nRelevant Vault excerpts (verbatim passages from the sources above, grouped by source — build the piece from THESE, do not invent facts beyond them):\n${excerptLines}`
        : ""
    }${
      contradictionLines
        ? `\n\nOpen contradictions between sources (handle carefully — do NOT state a disputed figure/timeline as settled):\n${contradictionLines}`
        : ""
    }

${
      noWebSearch
        ? "Build the piece STRICTLY from the evidence and excerpts above — you have NO web_search tool for this draft. Cite the packet's sources by their real URLs. Do NOT introduce facts, figures, quotes, or claims that aren't supported by this packet; if the packet doesn't cover something, leave it out or state the limitation rather than guessing."
        : "Build the piece on this evidence and cite the packet's sources by their real URLs. Only use web_search to confirm a specific additional detail the packet does not already cover."
    }

CONFIDENTIAL BRIEFING: this packet is internal newsroom material. NEVER mention "the evidence packet", "the Source Vault", this briefing, the screening process, or how you were given these sources anywhere in the article (title, dek, or body). Readers must see normal journalism — attribute facts to the actual named sources ("according to the AP…", with the Markdown link), exactly as if you had done the reporting yourself.`;
  }
  const draftAngleDirective = opts.editorialLabelOverride
    ? (EDITORIAL_ANGLE_DIRECTIVES[opts.editorialLabelOverride] ?? null)
    : null;
  // Takeaways callout: skip for beats where practical advice is absurd
  // (pure spectacle / weirdness / gross-out content). For all other beats,
  // ask the model to include a short actionable block near the top of the body.
  const includeTakeaways = !SKIP_TAKEAWAYS_BEATS.has(author.categorySlug ?? "");
  const takeawaysSpec = includeTakeaways
    ? `\n- TAKEAWAYS BLOCK: Before the first section heading (after your opening paragraph(s)), include exactly one { "type": "takeaways", "items": [...] } block with 3–5 concrete, first-person actionable bullets — short imperative sentences answering "what can I actually do with this?" (e.g. "Try a free light-meter app to measure your plant's real lux", "Move pots off cold floors in winter"). Each bullet is one tight sentence. Do NOT pad with obvious advice. If this article has no practical application for readers, omit the takeaways block entirely.`
    : "";
  const takeawaysExample = includeTakeaways
    ? `\n    { "type": "takeaways", "items": ["Concrete action 1.", "Concrete action 2.", "Concrete action 3."] },`
    : "";
  const user = `Write a magazine piece for BrainHook based on this assignment.

Working title: ${idea.title}
Editorial angle: ${idea.angle}${followUp}${opts.avoidContext ?? ""}${evidenceBlock}${draftAngleDirective ? `\n\n${draftAngleDirective}` : ""}

Specs:
- Length: anywhere from ${floor} to ${target} words — YOU decide, based on how much the topic genuinely supports. Write to the natural length of the idea: go long only when there's real substance, evidence, and distinct points to justify it; stop once the point is made. NEVER pad, repeat, or restate the same idea in different words to hit a number. A tight ${floor}-word piece is far better than a padded one. Most ideas land somewhere in between — only the richest deserve the full ${target}.
- Structure as JSON blocks: paragraph, heading, pullquote.${takeawaysSpec}
- Open with 1–4 paragraphs that hook the reader before the first heading (fewer for a short piece, more for a long one).
- Use headings to divide the piece into thematic sections, scaled to length: a short piece may need only 1–2 (or none, if it's a single tight argument), a full-length feature 4–6. Never add a heading just to look structured.
- Use pullquotes sparingly, only at genuine high-impact moments (a striking single sentence each): typically 0–1 in a short piece, up to 2–3 in a long one. Skip them entirely if nothing earns it.
- End with a paragraph that lands the idea — not a "conclusion" bow-tie.
- Sharpen the title into smart clickbait: 6–14 words, opens a curiosity gap or reframes the obvious, uses concrete specifics over abstractions, and promises a payoff the article actually delivers. Punchy beats clever. Avoid academic phrasing, "A meditation on…", trailing ellipses, and tabloid shouting.
- Write a 1-sentence dek (subhead) that earns the click by sharpening the promise — hint at the mechanism, the twist, or the buried payoff without giving the whole reveal away.
- Provide 3 alternate title candidates in "titleCandidates" — each distinct in framing (e.g. one curiosity-gap, one concrete-promise, one provocative reframe). All must honor the same rules as the title.
- CITATIONS: When you reference a specific study, paper, report, dataset, or piece of research, link it to the ACTUAL source so the reader can verify the claim. Use the web_search tool to FIND and CONFIRM the real page before you cite it, then hyperlink the natural phrase inline with Markdown: [the natural phrase](https://real-source-url). Cite the specific work itself — the journal or publisher article page, its DOI link (https://doi.org/…), the official report or agency/court record, or the preprint (arXiv/bioRxiv/PsyArXiv/medRxiv). Rules: (1) NEVER cite a bare search-query URL — a Google Scholar or Google/Bing results page (e.g. https://scholar.google.com/scholar?q=… or https://www.google.com/search?q=…) is unfalsifiable and is NOT a citation. (2) NEVER invent, guess, or reconstruct a URL, DOI, or identifier from memory — use ONLY a URL you actually obtained from a web_search result that points to the specific work; if you can't find the real source, name the study in the prose (year, lead author/institution, journal) with NO link rather than fabricating one. (3) You MAY add breadth by following a real specific citation with a SECOND, clearly-secondary link (e.g. " ([explore the research](https://…))"), but only as a companion to a real citation, never on its own — and prefer a published review article or meta-analysis over a search page for it too. (4) Only link genuine studies you actually reference, and don't over-link (cite the study mention, not every sentence). Markdown links are allowed ONLY inside "paragraph" content, never in titles, deks, headings, or pullquotes.${internalLinks}

Respond with ONLY a JSON object of this exact shape:
{
  "title": "Final title",
  "titleCandidates": ["Alt 1", "Alt 2", "Alt 3"],
  "dek": "One-sentence subhead.",
  "body": [
    { "type": "paragraph", "content": "..." },${takeawaysExample}
    { "type": "heading", "content": "..." },
    { "type": "pullquote", "content": "..." }
  ]
}`;

  const model = authorModel(author);
  const temperature = authorTemperature(author);
  const max_tokens = authorMaxTokens(author);
  // Per-draft web_search cap (Task #233). Auto-grounded/packet-backed drafts pass
  // 0 → NO draft-time web search at all (the piece is built from the vetted
  // packet + Vault excerpts). Default preserves the old behaviour (1 with a
  // packet, else 3) for callers that don't specify it.
  const resolvedMaxWebSearches = Math.max(0, Math.floor(opts.maxWebSearches ?? (hasPacket ? 1 : 3)));
  const useWebSearch = resolvedMaxWebSearches > 0;
  logger.info(
    { author: author.slug, op: "generateDraft", model, temperature, max_tokens, webSearch: useWebSearch, maxWebSearches: resolvedMaxWebSearches },
    "llm call",
  );
  const started = Date.now();
  // Give the draft model the web_search tool so it can FIND and CONFIRM real
  // source URLs for its citations (see the CITATIONS rule) rather than inventing
  // them. Mirror the idea-generation flow: try with the tool, fall back to a
  // plain call if the tool is unavailable. When the cap is 0 we never attach the
  // tool — the draft is grounded strictly on the packet/excerpts.
  const baseRequest = {
    model,
    max_tokens,
    temperature,
    system: sys,
    messages: [{ role: "user" as const, content: user }],
  };
  let message: Anthropic.Messages.Message;
  if (!useWebSearch) {
    message = (await anthropic.messages.create(baseRequest, { timeout: 180_000 })) as Anthropic.Messages.Message;
  } else {
    try {
      message = (await anthropic.messages.create(
        {
          ...baseRequest,
          tools: [{ type: "web_search_20250305" as const, name: "web_search", max_uses: resolvedMaxWebSearches }],
        } as Parameters<typeof anthropic.messages.create>[0],
        { timeout: 180_000 },
      )) as Anthropic.Messages.Message;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Web search tool unavailable; retrying draft without tools",
      );
      message = (await anthropic.messages.create(baseRequest, { timeout: 180_000 })) as Anthropic.Messages.Message;
    }
  }
  // With tool use the response can include server_tool_use / web_search_tool_result
  // blocks alongside one or more text blocks; the JSON we want is the LAST text
  // block (the model's final answer after any searches).
  const textBlocks = message.content.filter(
    (b): b is Anthropic.Messages.TextBlock => b.type === "text",
  );
  const text = textBlocks.length > 0 ? textBlocks[textBlocks.length - 1]!.text : "";
  const searchUses = message.content.filter((b) => b.type === "server_tool_use" || b.type === "tool_use").length;
  logger.info({ author: author.slug, op: "generateDraft", ms: Date.now() - started, searchUses }, "llm call returned");
  recordTextUsage({
    operation: "generateArticleDraft",
    model,
    message,
    authorSlug: author.slug,
    articleId: opts.articleId,
    clusterId: opts.clusterId ?? null,
    packetId: opts.packetId ?? null,
  });
  const raw = extractJson<GeneratedArticle>(text);
  // Validate the body — the model must only emit prose blocks, never
  // editor-only block types like `relatedArticle`. Drop anything that
  // doesn't pass and log it loudly.
  const cleanBody: ArticleBlock[] = [];
  for (const b of raw.body ?? []) {
    const parsed = draftBlockSchema.safeParse(b);
    if (parsed.success) {
      cleanBody.push(parsed.data);
    } else {
      logger.warn(
        { author: author.slug, op: "generateDraft", rejectedBlock: b, issues: parsed.error.issues },
        "Dropping invalid block from LLM draft output",
      );
    }
  }
  if (cleanBody.length === 0) {
    throw new Error("LLM draft produced no valid prose blocks");
  }
  // The web-search-enabled model sometimes wraps cited spans in raw
  // `<cite index="29-2">…</cite>` markup instead of the instructed Markdown
  // links. Nothing else strips it, so it would render as literal tag soup in
  // the prose — unwrap to plain text (keeping the wrapped words) here.
  const citeScrub = stripCitationTags(cleanBody);
  const dekScrub = typeof raw.dek === "string" ? stripCiteTagsFromText(raw.dek) : { text: raw.dek, stripped: 0 };
  if (citeScrub.stripped > 0 || dekScrub.stripped > 0) {
    logger.warn(
      { author: author.slug, op: "generateDraft", citeTagsRemoved: citeScrub.stripped + dekScrub.stripped },
      "Stripped raw <cite> citation tags from draft body/dek",
    );
  }
  // Internal newsroom vocabulary ("the evidence packet", "the Source Vault")
  // must never reach reader-facing copy — packet-grounded drafts have slipped
  // it into prose. Rewrite to natural equivalents across every surface. Bare
  // "evidence packet" is only treated as a leak when this draft actually HAD a
  // packet briefing (on other drafts it can be legitimate courtroom prose).
  const scrubOpts = { packetGrounded: hasPacket };
  const vocabBody = scrubInternalVocabulary(citeScrub.body, scrubOpts);
  const vocabDek =
    typeof dekScrub.text === "string"
      ? scrubInternalVocabFromText(dekScrub.text, scrubOpts)
      : { text: dekScrub.text, scrubbed: 0 };
  const vocabTitle =
    typeof raw.title === "string" ? scrubInternalVocabFromText(raw.title, scrubOpts) : { text: raw.title, scrubbed: 0 };
  let candidatesScrubbed = 0;
  const titleCandidates = Array.isArray(raw.titleCandidates)
    ? raw.titleCandidates.map((t) => {
        if (typeof t !== "string") return t;
        const r = scrubInternalVocabFromText(t, scrubOpts);
        candidatesScrubbed += r.scrubbed;
        return r.text;
      })
    : raw.titleCandidates;
  const vocabScrubbed = vocabBody.scrubbed + vocabDek.scrubbed + vocabTitle.scrubbed + candidatesScrubbed;
  if (vocabScrubbed > 0) {
    logger.warn(
      { author: author.slug, op: "generateDraft", internalVocabRewritten: vocabScrubbed },
      "Rewrote internal newsroom vocabulary (evidence packet / Source Vault) leaked into draft copy",
    );
  }
  // Apostrophe normalisation: collapse backslash-apostrophe (\') and
  // double-apostrophes ('') that can leak through JSON string escaping from
  // some model backends into a single plain apostrophe.  Applied to every
  // reader-facing string so the DB never stores the raw escape sequences.
  const normaliseApostrophes = (s: string): string =>
    s.replace(/\\'/g, "'").replace(/''/g, "'");

  const cleanTitle =
    typeof vocabTitle.text === "string" ? normaliseApostrophes(vocabTitle.text) : vocabTitle.text;
  const cleanDek =
    typeof vocabDek.text === "string" ? normaliseApostrophes(vocabDek.text) : vocabDek.text;
  const cleanCandidates = Array.isArray(titleCandidates)
    ? titleCandidates.map((t) => (typeof t === "string" ? normaliseApostrophes(t) : t))
    : titleCandidates;

  return { ...raw, title: cleanTitle, titleCandidates: cleanCandidates, dek: cleanDek, body: vocabBody.body };
}

// Human-readable guidance for each hook mode, embedded in the prompt and reused
// as the default surface assignments when the model returns an invalid mapping.
const HOOK_MODE_GUIDE: Record<HookMode, string> = {
  curiosity: "Curiosity — open an intrigue/information gap that makes the reader need the answer, without being vague or cheap.",
  contrarian: "Contrarian — challenge a common assumption or flip the obvious take; provocative but defensible by the article.",
  emotional: "Emotional — lead with the feeling or human stakes (awe, worry, delight, recognition).",
  news_peg: "News peg — frame it against something current/timely or a recognizable trend, even if evergreen underneath.",
  plain_seo: "Plain SEO — literal, keyword-forward, search-friendly; says plainly what the piece is about (no wordplay).",
};

// Defaults applied to the non-H1 surfaces only. The H1 *assignment* stays unset
// (null) so the on-page H1 always resolves to `article.title` and remains freely
// editable. The strongest hook is instead baked directly into the draft's
// `title` at creation time (via `headlineMode` below + draftArticleForAuthor),
// so the punchy headline propagates to every surface that only carries the title
// (listing cards, related rails, share intents), not just the article page.
const DEFAULT_HOOK_ASSIGNMENTS: Required<{ [K in Exclude<keyof HookAssignments, "h1">]: HookMode }> = {
  seoTitle: "plain_seo",
  social: "curiosity",
  newsletter: "emotional",
};

// Fallback headline angle for the on-page title when the model doesn't return a
// usable H1 choice. Curiosity is the safest broadly-applicable hook.
const DEFAULT_HEADLINE_MODE: HookMode = "curiosity";

export interface GeneratedHookKit {
  hookVariants: HookVariant[];
  hookAssignments: HookAssignments;
  socialPack: SocialPack;
  // Which hook mode the model chose as the strongest on-page headline. The
  // draft pipeline uses this to set the article's actual `title`. NOT persisted
  // as `hookAssignments.h1` (that stays null) so the title remains editable.
  headlineMode: HookMode;
}

const hooksResponseSchema = z.object({
  hooks: z.record(hookModeSchema, z.string()),
  assignments: z
    .object({
      h1: hookModeSchema.optional(),
      seoTitle: hookModeSchema.optional(),
      social: hookModeSchema.optional(),
      newsletter: hookModeSchema.optional(),
    })
    .optional(),
  social: z.object({
    twitter: z.string().optional(),
    threads: z.string().optional(),
    pinterestTitle: z.string().optional(),
    pinterestDescription: z.string().optional(),
    reddit: z.string().optional(),
    newsletterBlurb: z.string().optional(),
    quoteCard: z.string().optional(),
    altCaptions: z.array(z.string()).optional(),
  }),
});

function firstParagraphText(body: ArticleBlock[]): string {
  const p = body.find((b) => b.type === "paragraph");
  return (p?.content ?? "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").slice(0, 1200);
}

/**
 * Generate the full headline-hook kit (5 typed hook variants + a default
 * mode→surface assignment) and a ready-to-post per-platform social pack for an
 * article. One structured LLM call. Throws on a hard failure (no parseable
 * output) so callers can decide whether to treat it as fatal — the draft
 * pipeline catches and continues with NULL columns.
 */
export async function generateHooksAndSocialPack(
  author: Author,
  article: { title: string; dek: string; category: string; body: ArticleBlock[] },
  // `operation` lets backfill / regeneration callers label their spend
  // distinctly from the once-per-new-article draft-time call, so the cost
  // meter's per-article average isn't inflated by back-catalog maintenance.
  opts: { operation?: string; articleId?: string | null } = {},
): Promise<GeneratedHookKit> {
  if (!(await isAiFunctionEnabled("hook_social_pack"))) {
    throw new AiFunctionDisabledError("hook_social_pack");
  }
  const modeGuide = HOOK_MODES.map((m) => `- ${m}: ${HOOK_MODE_GUIDE[m]}`).join("\n");
  const sys = await resolveDirective("hook_social_pack");
  const user = `ARTICLE
Headline: ${article.title}
Subhead: ${article.dek}
Category: ${article.category}
Opening: ${firstParagraphText(article.body)}

TASK 1 — Write ONE headline for each of these five hook modes (6–14 words each, distinct from one another):
${modeGuide}

TASK 2 — Choose which mode best drives each surface:
- h1: the ON-PAGE HEADLINE readers actually see. Pick the SINGLE strongest, most distinctive hook for THIS specific article — irresistible but fully honest to the piece. Do NOT default to the same angle every time; choose whatever genuinely fits best so headlines across the magazine stay varied, not formulaic. (plain_seo is rarely the most compelling visible headline — prefer it only when a plain framing truly is the strongest.)
- seoTitle: the <title>/search title (usually plain_seo — literal and keyword-forward, ≤60 chars works best)
- social: the social share title used for Open Graph / X cards (a punchy curiosity/contrarian/emotional hook)
- newsletter: the subject line / title shown in the email (an emotional or curiosity hook tends to win opens)

TASK 3 — Write ready-to-post social copy:
- twitter: an X/Twitter post UNDER 280 characters (the link is appended separately, so don't include a URL). At most 1–2 tasteful hashtags — real, popular single-word tags only; NEVER self-referential/brand tags (no #BrainHook) and never mashed-together multi-topic tags.
- threads: a Threads post, slightly more casual than X, no hard character limit but keep it tight.
- pinterestTitle: a Pin title (≤100 chars), keyword-rich and benefit-driven.
- pinterestDescription: a Pin description (≤500 chars) with natural keywords.
- reddit: a discussion-prompt-style title that would spark replies in a relevant subreddit (no clickbait, no link).
- newsletterBlurb: 1–2 sentences teasing the piece for a roundup email.
- quoteCard: a short, striking pull-quote-style line (≤140 chars) suitable for a quote-card graphic.
- altCaptions: an array of EXACTLY 3 short, interchangeable captions (≤120 chars each) usable on Instagram/Threads/etc. If a caption includes a call to action, point readers to the link in the comments below (e.g. "full story at the link in the comments"); NEVER say "link in bio" or refer to a bio/profile link.

Respond with ONLY a JSON object of this exact shape:
{
  "hooks": {
    "curiosity": "...",
    "contrarian": "...",
    "emotional": "...",
    "news_peg": "...",
    "plain_seo": "..."
  },
  "assignments": { "h1": "curiosity", "seoTitle": "plain_seo", "social": "curiosity", "newsletter": "emotional" },
  "social": {
    "twitter": "...",
    "threads": "...",
    "pinterestTitle": "...",
    "pinterestDescription": "...",
    "reddit": "...",
    "newsletterBlurb": "...",
    "quoteCard": "...",
    "altCaptions": ["...", "...", "..."]
  }
}`;

  const model = await resolveModel("hook_social_pack");
  const max_tokens = 2048;
  logger.info({ author: author.slug, op: "generateHooks", model }, "llm call");
  const started = Date.now();
  const message = (await anthropic.messages.create(
    {
      model,
      max_tokens,
      temperature: 0.8,
      system: sys,
      messages: [{ role: "user" as const, content: user }],
    },
    { timeout: 120_000 },
  )) as Anthropic.Messages.Message;
  recordTextUsage({ operation: opts.operation ?? "generateHooksAndSocialPack", model, message, authorSlug: author.slug, articleId: opts.articleId });
  const block = message.content.find((b): b is Anthropic.Messages.TextBlock => b.type === "text");
  const text = block?.text ?? "";
  logger.info({ author: author.slug, op: "generateHooks", ms: Date.now() - started }, "llm call returned");
  const raw = extractJson<unknown>(text);
  const parsed = hooksResponseSchema.parse(raw);

  // Build one variant per mode; fall back to the headline when a mode is missing
  // so hookVariants always has the full set the UI expects. Hooks are
  // reader-facing (titles, share intents, newsletter) — scrub any leaked
  // internal newsroom vocabulary the same way draft prose is scrubbed.
  const hookVariants: HookVariant[] = HOOK_MODES.map((mode) => ({
    mode,
    text: scrubInternalVocabFromText((parsed.hooks[mode] ?? "").trim() || article.title).text,
  }));

  const a = parsed.assignments ?? {};
  // The model's H1 choice selects which hook becomes the draft's actual `title`
  // (applied by the caller at draft-creation time). The H1 *assignment* itself
  // stays null so the on-page H1 always resolves to `article.title` and remains
  // editable — and so the chosen headline reaches every title-only surface
  // (cards, related, share), not just the article page. The other three surfaces
  // fall back to sensible defaults so meta/social/newsletter are packed.
  const headlineMode: HookMode = a.h1 ?? DEFAULT_HEADLINE_MODE;
  const hookAssignments: HookAssignments = {
    h1: null,
    seoTitle: a.seoTitle ?? DEFAULT_HOOK_ASSIGNMENTS.seoTitle,
    social: a.social ?? DEFAULT_HOOK_ASSIGNMENTS.social,
    newsletter: a.newsletter ?? DEFAULT_HOOK_ASSIGNMENTS.newsletter,
  };

  const s = parsed.social;
  // Defensive enforcement of platform norms in case the model overshoots:
  // X posts must fit in 280 chars (trimmed at a word boundary, no ellipsis so
  // the appended link stays clean), and we keep at most 3 alt captions.
  // Freeform social copy can carry inline hashtags — enforce the global
  // hashtag policy deterministically (drop brand tags, split mashed compounds)
  // rather than trusting prompt compliance alone.
  const scrubText = (t: string): string =>
    sanitizeInlineHashtags(scrubInternalVocabFromText(t).text);
  const altCaptions = (s.altCaptions ?? []).map((c) => scrubText(c.trim())).filter(Boolean).slice(0, 3);
  const clampTweet = (t: string): string => {
    const v = scrubText(t.trim());
    if (v.length <= 280) return v;
    const cut = v.slice(0, 280);
    const lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > 200 ? cut.slice(0, lastSpace) : cut).trim();
  };
  // Social copy is reader-facing — scrub internal vocabulary here too.
  const socialPack: SocialPack = {
    twitter: clampTweet(s.twitter ?? ""),
    threads: scrubText((s.threads ?? "").trim()),
    pinterestTitle: scrubText((s.pinterestTitle ?? "").trim()),
    pinterestDescription: scrubText((s.pinterestDescription ?? "").trim()),
    reddit: scrubText((s.reddit ?? "").trim()),
    newsletterBlurb: scrubText((s.newsletterBlurb ?? "").trim()),
    quoteCard: scrubText((s.quoteCard ?? "").trim()),
    altCaptions,
  };

  return { hookVariants, hookAssignments, socialPack, headlineMode };
}

const EDITORIAL_ANGLE_DIRECTIVES: Record<string, string> = {
  original_reporting:
    "EDITORIAL ANGLE: Write as news reporting. Lead with the most newsworthy fact. Attribute claims to specific named sources. Concrete details: who, what, when, where, why.",
  research_synthesis:
    "EDITORIAL ANGLE: Write as a research synthesis. Weave findings from multiple studies and sources into a unified picture. Surface where sources converge or conflict. Give the reader the big picture that no single source provides alone.",
  analysis:
    "EDITORIAL ANGLE: Write as analytical commentary. Go beyond summarising what happened — interpret what it means and why it matters. Surface implications and insight not obvious from the facts alone.",
  explainer:
    "EDITORIAL ANGLE: Write as an explainer for a smart reader who knows nothing about this subject. Define terms, use analogies, and build understanding from first principles to nuance in a clear progression.",
  commentary:
    "EDITORIAL ANGLE: Write as a direct opinion piece. Take a clear, reasoned position and build the piece as an argument toward that conclusion. Use evidence to support your stance.",
};

export async function regenerateBlock(
  author: Author,
  context: { title: string; dek: string; body: ArticleBlock[]; blockIndex: number; instructions?: string; articleId?: string | null; editorialLabelOverride?: string | null },
): Promise<ArticleBlock> {
  const target = context.body[context.blockIndex];
  if (!target) throw new Error("Block index out of range");
  // Manual editor action: a disabled function must REPORT (so the editor shows a
  // real message), not silently return the block unchanged and claim success.
  if (!(await isAiFunctionEnabled("block_regeneration"))) throw new AiFunctionDisabledError("block_regeneration");
  const sys = buildAuthorSystemPrompt(author);
  const regenDirective = await resolveDirective("block_regeneration");
  const surroundingBefore = context.body.slice(Math.max(0, context.blockIndex - 2), context.blockIndex);
  const surroundingAfter = context.body.slice(context.blockIndex + 1, context.blockIndex + 3);
  const seed = "content" in target && typeof target.content === "string" ? target.content.trim() : "";
  const angleDirective = context.editorialLabelOverride
    ? (EDITORIAL_ANGLE_DIRECTIVES[context.editorialLabelOverride] ?? null)
    : null;
  const user = `You are writing one ${target.type} block for an existing article, in the author's voice.

Article title: ${context.title}
Dek: ${context.dek}

Two blocks BEFORE this one:
${JSON.stringify(surroundingBefore, null, 2)}

${seed
    ? `The editor's draft text for this ${target.type} — treat it as a rough seed/notes to develop into a finished block (expand and sharpen it; don't just echo it):\n${JSON.stringify(seed)}`
    : `This ${target.type} is currently empty — write it from the editor's instructions and the surrounding context.`}

Two blocks AFTER this one:
${JSON.stringify(surroundingAfter, null, 2)}

${context.instructions ? `Editor's instructions: ${context.instructions}\n\n` : ""}${angleDirective ? `${angleDirective}\n\n` : ""}${regenDirective}

Respond with ONLY a JSON object: { "type": "${target.type}", "content": "..." }`;
  const model = authorModel(author);
  const temperature = authorTemperature(author);
  const max_tokens = Math.min(authorMaxTokens(author), 2048);
  logger.info({ author: author.slug, op: "regenerateBlock", model, temperature, max_tokens }, "llm call");
  const message = await anthropic.messages.create({
    model,
    max_tokens,
    temperature,
    system: sys,
    messages: [{ role: "user", content: user }],
  });
  recordTextUsage({ operation: "regenerateBlock", model, message, authorSlug: author.slug, articleId: context.articleId });
  const block = message.content[0];
  const text = block && block.type === "text" ? block.text : "";
  const out = extractJson<ArticleBlock>(text);
  // Defensive: a regenerated block can echo raw <cite> markup from its
  // surrounding context — unwrap it the same way generateArticleDraft does,
  // and rewrite any leaked internal newsroom vocabulary the same way too.
  if ("content" in out && typeof out.content === "string") {
    const { text: cleaned } = stripCiteTagsFromText(out.content);
    const { text: safe } = scrubInternalVocabFromText(cleaned);
    if (safe !== out.content) return { ...out, content: safe } as ArticleBlock;
  }
  return out;
}

/**
 * Lightweight, non-rewriting pass that PICKS a few contextual internal links to
 * add to an EXISTING article. Unlike {@link generateArticleDraft} this never
 * rewrites the article and never re-emits its prose: the model only returns a
 * small list of `{ index, phrase, slug }` insertions, and the caller
 * (services/articles.ts) performs the actual wrapping by exact substring match.
 * That keeps the model output tiny (no token-budget truncation on long articles)
 * and makes prose drift impossible by construction. Used to backfill internal
 * links into older articles that predate the draft-time linking feature.
 *
 * Returns validated insertions only: each `slug` is a real candidate, slugs are
 * de-duplicated, the `index` is in range, and at most 4 are returned.
 */
export type InternalLinkInsertion = { index: number; phrase: string; slug: string };

export async function insertInternalLinks(
  author: Author,
  context: {
    title: string;
    dek: string;
    paragraphs: string[];
    candidates: { title: string; slug: string }[];
    articleId?: string | null;
  },
): Promise<InternalLinkInsertion[]> {
  const targets = context.candidates.filter(
    (c) => c && typeof c.slug === "string" && c.slug.length > 0 && typeof c.title === "string" && c.title.length > 0,
  );
  if (targets.length === 0 || context.paragraphs.length === 0) return [];
  if (!(await isAiFunctionEnabled("internal_link_suggestion"))) return [];
  const sys = buildAuthorSystemPrompt(author, { includeTechnicalRevoicing: false });
  const internalLinkDirective = await resolveDirective("internal_link_suggestion");
  const numbered = context.paragraphs.map((p, i) => `[${i}] ${p}`).join("\n\n");
  // The model only PICKS phrases to link — it never re-emits the prose. The
  // server (services/articles.ts) does the actual wrapping by exact substring
  // match, so prose can never drift and the output stays tiny (no token-budget
  // truncation, which used to break JSON parsing on long articles).
  const user = `You are choosing a few contextual internal links to add to an ALREADY-PUBLISHED BrainHook article. You do NOT rewrite anything — you only point at existing phrases that should become links to other BrainHook articles. A separate program performs the edit, so every phrase you return MUST be copied verbatim from the paragraph.

Article title: ${context.title}
Subhead: ${context.dek}

The article's paragraphs, each prefixed with its index:
${numbered}

Linkable BrainHook articles (use ONLY these slugs — never invent one):
${targets.map((c) => `  - "${c.title}" → /article/${c.slug}`).join("\n")}

${internalLinkDirective}

Respond with ONLY a JSON object of this exact shape:
{ "links": [ { "index": 0, "phrase": "exact existing phrase", "slug": "target-slug" } ] }
If no links fit, respond { "links": [] }.`;
  const model = await resolveModel("internal_link_suggestion");
  logger.info({ author: author.slug, op: "insertInternalLinks", model, paragraphs: context.paragraphs.length }, "llm call");
  const message = await anthropic.messages.create(
    {
      model,
      max_tokens: 1024,
      temperature: 0.2,
      system: sys,
      messages: [{ role: "user", content: user }],
    },
    { timeout: 60_000 },
  );
  recordTextUsage({ operation: "insertInternalLinks", model, message, authorSlug: author.slug, articleId: context.articleId });
  const block = message.content[0];
  const text = block && block.type === "text" ? block.text : "";
  let parsed: { links?: unknown };
  try {
    parsed = extractJson<{ links?: unknown }>(text, hasLinksShape);
  } catch (err) {
    logger.warn(
      { author: author.slug, op: "insertInternalLinks", err: err instanceof Error ? err.message : String(err) },
      "Could not parse internal-link JSON from model; treating as no links",
    );
    return [];
  }
  const rawLinks = Array.isArray(parsed.links) ? parsed.links : [];
  const validSlugs = new Set(targets.map((t) => t.slug));
  const seenSlugs = new Set<string>();
  const out: InternalLinkInsertion[] = [];
  for (const item of rawLinks) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const index = typeof rec.index === "number" ? rec.index : Number(rec.index);
    const phrase = typeof rec.phrase === "string" ? rec.phrase : "";
    const slug = typeof rec.slug === "string" ? rec.slug : "";
    if (!Number.isInteger(index) || index < 0 || index >= context.paragraphs.length) continue;
    if (!phrase.trim() || !slug || !validSlugs.has(slug) || seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    out.push({ index, phrase, slug });
    if (out.length >= 4) break;
  }
  return out;
}

/**
 * Lightweight, non-rewriting pass that PICKS a few external SOURCE/citation
 * links to add to an EXISTING published article — the back-catalog analog of the
 * draft-time CITATIONS rule. Like {@link insertInternalLinks} the model NEVER
 * rewrites prose: it returns a small list of `{ index, phrase, url }` insertions
 * and the caller (services/articles.ts) performs the actual wrapping by exact
 * substring match, so prose drift is impossible by construction.
 *
 * The model is given the web_search tool so it can FIND and CONFIRM a real
 * source page before citing it (mirrors generateArticleDraft's tool wiring with
 * a no-tool fallback). It is forbidden from inventing/guessing URLs or citing
 * bare search-query result pages. Every returned URL is additionally verified
 * server-side (https + reachable + not a search page) before anything is saved,
 * so the LLM output is advisory, not trusted.
 *
 * Returns validated insertions only: `index` in range, `phrase` non-empty, `url`
 * a syntactically-valid https URL that is not a search-query page, de-duplicated
 * by URL, at most 4.
 */
export type SourceLinkInsertion = { index: number; phrase: string; url: string };

// A single vetted source-URL candidate (Task #226) drawn — in priority order —
// from the article's evidence packet, the Source Vault, and existing BrainHook
// citations. When web search is capped to 0 the model may ONLY cite these.
export interface SourceLinkCandidate {
  url: string;
  title: string | null;
  domain: string;
  // Paragraph indexes (into context.paragraphs) where the term that surfaced
  // this candidate appears — produced by the deterministic term-extraction
  // pass so the prompt can steer citations toward mid/late-article claims.
  paragraphHints?: number[];
}

export async function insertSourceLinks(
  author: Author,
  context: {
    title: string;
    dek: string;
    category: string;
    paragraphs: string[];
    articleId?: string | null;
    // Task #226 attribution + strategy.
    evidencePacketId?: string | null;
    clusterId?: string | null;
    // Vetted source pool (packet → vault → existing catalog → Perplexity-
    // discovered + Vault-ingested). The model may cite ONLY these URLs; this is
    // ENFORCED server-side below — a URL not in the pool is dropped, so a
    // model-invented URL can never reach an article. REQUIRED: with an empty
    // pool the pass skips entirely (vault miss = skip, never guess).
    candidateSources?: SourceLinkCandidate[];
    // Source-link insertion mode, for cost/audit logging only.
    mode?: string;
    // True when gatherSourceCandidates successfully completed a Sonar gap-fill
    // call for this article (pool was thin + cap > 0 + Perplexity configured).
    // Drives the `reason` audit field: sonar_gap_fill vs vault_only.
    sonarGapFillRan?: boolean;
  },
): Promise<SourceLinkInsertion[]> {
  if (context.paragraphs.length === 0) return [];
  if (!(await isAiFunctionEnabled("source_citation_suggestion"))) return [];

  const candidateSources = (context.candidateSources ?? []).slice(0, 24);
  const mode = context.mode ?? "vault_first_with_capped_search";

  // Empty pool: skip the model entirely rather than let it invent sources
  // (acceptance: on a Vault miss the pass skips instead of guessing). Any gap
  // discovery happens UPSTREAM via batched Perplexity searches whose results go
  // through Source Vault ingestion — this pass never searches the web itself.
  if (candidateSources.length === 0) {
    logger.info(
      { author: author.slug, op: "insertSourceLinks", mode, articleId: context.articleId },
      "source-link pass skipped: empty vetted source pool",
    );
    return [];
  }

  const sys = buildAuthorSystemPrompt(author, { includeTechnicalRevoicing: false });
  const sourceLinkDirective = await resolveDirective("source_citation_suggestion");
  const numbered = context.paragraphs.map((p, i) => `[${i}] ${p}`).join("\n\n");
  const approvedBlock = `\n\nAPPROVED SOURCES — you may cite ONLY URLs from this list, copied EXACTLY as written; if none fits a claim, leave that claim unlinked (do NOT invent, alter, or search for another URL).\n${candidateSources
          .map((s, i) => {
            const hints =
              s.paragraphHints && s.paragraphHints.length > 0
                ? ` [likely relevant to paragraph${s.paragraphHints.length > 1 ? "s" : ""} ${s.paragraphHints.map((h) => `[${h}]`).join(", ")}]`
                : "";
            return `(${i + 1}) ${s.url}${s.title ? ` — ${s.title}` : ""}${hints}`;
          })
          .join("\n")}`;
  const user = `You are adding external SOURCE citations to an ALREADY-PUBLISHED BrainHook article. You do NOT rewrite anything — you only point at existing phrases that should link out to a real, verifiable source. A separate program performs the edit, so every "phrase" you return MUST be copied character-for-character from the paragraph.

Article title: ${context.title}
Subhead: ${context.dek}
Category: ${context.category}

The article's paragraphs, each prefixed with its index:
${numbered}

${sourceLinkDirective}${approvedBlock}

NEVER pick a phrase that is already part of a Markdown link — i.e. any text inside the [brackets] of an existing [text](url) link in a paragraph is OFF-LIMITS. Choose plain, unlinked prose only; the edit program will reject phrases that overlap an existing link.

DISTRIBUTION REQUIREMENT: spread citations across the ENTIRE article — do NOT cluster them in the opening paragraphs. When a source supports a claim in the middle or final third of the article, cite it THERE. Prefer a well-placed mid- or late-article citation over a third citation in the opening paragraphs. Where a source lists "likely relevant to paragraph" hints, check those paragraphs first for a citable phrase.

Respond with ONLY a JSON object of this exact shape:
{ "links": [ { "index": 0, "phrase": "exact existing phrase", "url": "https://real-source-url" } ] }
If no verifiable sources fit, respond { "links": [] }.`;
  const model = await resolveModel("source_citation_suggestion");
  logger.info(
    {
      author: author.slug,
      op: "insertSourceLinks",
      model,
      paragraphs: context.paragraphs.length,
      mode,
      pool: candidateSources.length,
    },
    "llm call",
  );
  const started = Date.now();
  // No tools, ever: this pass PICKS from the vetted pool only. Web discovery
  // happens upstream (batched Perplexity searches → Source Vault ingestion),
  // so the model has no way to introduce a URL the pipeline hasn't verified.
  const message = (await anthropic.messages.create(
    {
      model,
      // Roomy budget: the model sometimes emits a short preamble before the
      // final JSON, and a tight cap was truncating that answer mid-object.
      max_tokens: 2048,
      temperature: 0.2,
      system: sys,
      messages: [{ role: "user" as const, content: user }],
    },
    { timeout: 120_000 },
  )) as Anthropic.Messages.Message;
  const textBlocks = message.content.filter(
    (b): b is Anthropic.Messages.TextBlock => b.type === "text",
  );
  const text = textBlocks.length > 0 ? textBlocks[textBlocks.length - 1]!.text : "";
  const reason = context.sonarGapFillRan
    ? `sonar_gap_fill; pool=${candidateSources.length}`
    : `vault_only; pool=${candidateSources.length}`;
  logger.info(
    { author: author.slug, op: "insertSourceLinks", ms: Date.now() - started, mode, reason },
    "llm call returned",
  );
  recordTextUsage({
    operation: "insertSourceLinks",
    model,
    message,
    authorSlug: author.slug,
    articleId: context.articleId,
    clusterId: context.clusterId,
    packetId: context.evidencePacketId,
    mode,
    reason,
  });
  let parsed: { links?: unknown };
  try {
    parsed = extractJson<{ links?: unknown }>(text, hasLinksShape);
  } catch (err) {
    logger.warn(
      { author: author.slug, op: "insertSourceLinks", err: err instanceof Error ? err.message : String(err) },
      "Could not parse source-link JSON from model; treating as no links",
    );
    return [];
  }
  const rawLinks = Array.isArray(parsed.links) ? parsed.links : [];
  // HARD pool enforcement: only URLs that appear verbatim in the vetted
  // candidate pool are accepted. The prompt already forbids inventing URLs,
  // but this server-side gate makes it structural — model-generated URLs can
  // never reach an article body regardless of what the model writes.
  const poolUrls = new Set(candidateSources.map((s) => s.url));
  let droppedOffPool = 0;
  const seenUrls = new Set<string>();
  const out: SourceLinkInsertion[] = [];
  for (const item of rawLinks) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const index = typeof rec.index === "number" ? rec.index : Number(rec.index);
    const phrase = typeof rec.phrase === "string" ? rec.phrase : "";
    const url = typeof rec.url === "string" ? rec.url.trim() : "";
    if (!Number.isInteger(index) || index < 0 || index >= context.paragraphs.length) continue;
    if (!phrase.trim() || !url) continue;
    // Syntactic gate only — semantic verification (reachable, not a search page)
    // happens in the caller via sourceUrlIsReachable.
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      continue;
    }
    if (parsedUrl.protocol !== "https:") continue;
    if (!poolUrls.has(url)) {
      droppedOffPool += 1;
      continue;
    }
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);
    out.push({ index, phrase, url });
    if (out.length >= 4) break;
  }
  if (droppedOffPool > 0) {
    logger.warn(
      { author: author.slug, op: "insertSourceLinks", articleId: context.articleId, droppedOffPool },
      "Dropped model-suggested source URLs not present in the vetted pool",
    );
  }
  return out;
}

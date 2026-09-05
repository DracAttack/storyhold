// AI Control Center registry — the single source of truth for every
// admin-controllable AI function. Each entry pairs a stable key with UI
// metadata and the DEFAULT directive text (the steering block that is injected
// into that function's prompt today). The aiSettings service merges these
// defaults with any DB overrides; llm.ts / heroImage.ts read the resolved
// directive via resolveDirective(key) and gate execution via
// isAiFunctionEnabled(key).
//
// IMPORTANT: the defaultDirective strings below are reproduced verbatim from the
// hardcoded prompt blocks so that, with no override set, the prompts are
// byte-identical to before this feature. Image directives use {{TOKEN}}
// placeholders that the builder substitutes with per-call dynamic data.

export const AI_FUNCTION_KEYS = [
  "draft_generation",
  "author_idea_generation",
  "beat_idea_generation",
  "trend_scout",
  "editorial_screen",
  "draft_verification",
  "author_assignment",
  "concept_dedupe_judge",
  "title_twin_judge",
  "title_rewrite",
  "hook_social_pack",
  "social_caption",
  "term_hashtags",
  "internal_link_suggestion",
  "source_citation_suggestion",
  "citation_note",
  "block_regeneration",
  "meme_concepts",
  "meme_auto_place",
  "hero_image",
  "author_avatar",
  "beat_hero_image",
  "meme_artwork",
  // Concept Explainer & Glossary (Task #284) — executed via Perplexity structured chat,
  // not via the standard Claude model picker; defaultModel here is informational only.
  "concept_detection",
  "concept_definition",
  "concept_verification",
  "alias_audit",
  // Glossary merge sweep: LLM judge that confirms whether two glossary entries
  // name the same underlying concept before they are merged into one.
  "merge_sweep",
  // Semantic cluster reconciler (Task #330): LLM judge for borderline story
  // cluster pairs. Determines whether two clusters cover the same story.
  "cluster_reconcile_judge",
  // Research fallback (Task #341): the Claude stand-in used whenever Perplexity
  // is unconfigured, erroring, or timed out. Search-shaped calls run with the
  // web_search tool; the model is routable like any other text function.
  "research_fallback",
  // Cross-Beat Radar (Task #340): one cheap call per radar suggestion that
  // phrases a deterministic bridge-concept candidate into a title + angle.
  // All candidate selection is deterministic; the LLM only writes the pitch.
  "cross_beat_radar",
  // Story Watch update generation (Task #348): generates update-kind articles
  // for watched clusters where the development signal detector has fired.
  // Vault-grounded "story so far"; depth shaped by deterministic depth score.
  "story_update",
  // Vault Claim Layer (#447): grounded section extraction + pair reconciliation.
  "claim_extraction",
  "claim_reconciliation",
] as const;

export type AiFunctionKey = (typeof AI_FUNCTION_KEYS)[number];

export type AiFunctionGroup = "writing" | "editorial" | "imagery";

export type CostTier = "cheap" | "medium" | "expensive";

// The text models an admin may route a function to. Image functions use a fixed
// Gemini model (not selectable here). Kept here (not in llm.ts) so aiSettings can
// validate a model override without importing llm.ts (which imports aiSettings).
export const AI_TEXT_MODELS: { id: string; label: string; tier: CostTier }[] = [
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (balanced)", tier: "expensive" },
  { id: "claude-opus-4-1", label: "Claude Opus 4.1 (richest prose, slower)", tier: "expensive" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (fast, lean)", tier: "cheap" },
];
export const ALLOWED_MODEL_IDS = new Set<string>(AI_TEXT_MODELS.map((m) => m.id));
export const DEFAULT_TEXT_MODEL = "claude-sonnet-4-6";
export const IMAGE_MODEL = "gemini-3-pro-image-preview";

// Per-function routing metadata: which model it uses by default, its rough cost
// tier, and whether it runs inside bulk/back-catalogue loops (used to warn when
// a bulk workflow is pointed at an expensive model or has web search on). The
// resolved model is `modelOverride ?? defaultModel` (see aiSettings.resolveModel).
// `perAuthorModel` marks the two functions whose model is chosen per-author
// (draft + block rewrite) — resolveModel is NOT used for those; the author's
// configured model wins, and defaultModel here is only the display fallback.
export interface AiFunctionRouting {
  defaultModel: string;
  costTier: CostTier;
  bulkEligible: boolean;
  usesWebSearch: boolean;
  usesImages: boolean;
  perAuthorModel?: boolean;
}

export const AI_FUNCTION_ROUTING: Record<AiFunctionKey, AiFunctionRouting> = {
  // Writing / ideation
  draft_generation: { defaultModel: "claude-sonnet-4-6", costTier: "expensive", bulkEligible: false, usesWebSearch: false, usesImages: false, perAuthorModel: true },
  author_idea_generation: { defaultModel: "claude-haiku-4-5", costTier: "cheap", bulkEligible: true, usesWebSearch: true, usesImages: false },
  beat_idea_generation: { defaultModel: "claude-haiku-4-5", costTier: "cheap", bulkEligible: true, usesWebSearch: true, usesImages: false },
  trend_scout: { defaultModel: "claude-haiku-4-5", costTier: "cheap", bulkEligible: true, usesWebSearch: true, usesImages: false },
  hook_social_pack: { defaultModel: "claude-haiku-4-5", costTier: "cheap", bulkEligible: true, usesWebSearch: false, usesImages: false },
  block_regeneration: { defaultModel: "claude-sonnet-4-6", costTier: "expensive", bulkEligible: false, usesWebSearch: false, usesImages: false, perAuthorModel: true },
  social_caption: { defaultModel: "claude-haiku-4-5", costTier: "cheap", bulkEligible: true, usesWebSearch: false, usesImages: false },
  term_hashtags: { defaultModel: "claude-haiku-4-5", costTier: "cheap", bulkEligible: false, usesWebSearch: false, usesImages: false },
  meme_concepts: { defaultModel: "claude-haiku-4-5", costTier: "cheap", bulkEligible: false, usesWebSearch: false, usesImages: false },
  meme_auto_place: { defaultModel: "claude-haiku-4-5", costTier: "cheap", bulkEligible: false, usesWebSearch: false, usesImages: false },
  // Editorial automation
  editorial_screen: { defaultModel: "claude-haiku-4-5", costTier: "cheap", bulkEligible: true, usesWebSearch: false, usesImages: false },
  // Verification is a fidelity judge — kept on the strong model (like the dedupe
  // judge) so it neither over- nor under-flags. Runs once per packet-grounded
  // draft (rare), never in bulk, never with web search.
  draft_verification: { defaultModel: "claude-sonnet-4-6", costTier: "expensive", bulkEligible: false, usesWebSearch: false, usesImages: false },
  author_assignment: { defaultModel: "claude-haiku-4-5", costTier: "cheap", bulkEligible: true, usesWebSearch: false, usesImages: false },
  // Judge deliberately stays on the strong model — Haiku over-rejected novel
  // ideas that merely shared a framework. Not marked bulk so it doesn't warn.
  concept_dedupe_judge: { defaultModel: "claude-sonnet-4-6", costTier: "expensive", bulkEligible: false, usesWebSearch: false, usesImages: false },
  title_twin_judge: { defaultModel: "claude-haiku-4-5", costTier: "cheap", bulkEligible: false, usesWebSearch: false, usesImages: false },
  title_rewrite: { defaultModel: "claude-haiku-4-5", costTier: "cheap", bulkEligible: false, usesWebSearch: false, usesImages: false },
  internal_link_suggestion: { defaultModel: "claude-haiku-4-5", costTier: "cheap", bulkEligible: true, usesWebSearch: false, usesImages: false },
  source_citation_suggestion: { defaultModel: "claude-haiku-4-5", costTier: "cheap", bulkEligible: true, usesWebSearch: true, usesImages: false },
  citation_note: { defaultModel: "claude-haiku-4-5", costTier: "cheap", bulkEligible: true, usesWebSearch: false, usesImages: false },
  // Imagery (fixed Gemini model, not routable)
  hero_image: { defaultModel: IMAGE_MODEL, costTier: "expensive", bulkEligible: false, usesWebSearch: false, usesImages: true },
  author_avatar: { defaultModel: IMAGE_MODEL, costTier: "expensive", bulkEligible: false, usesWebSearch: false, usesImages: true },
  beat_hero_image: { defaultModel: IMAGE_MODEL, costTier: "expensive", bulkEligible: false, usesWebSearch: false, usesImages: true },
  meme_artwork: { defaultModel: IMAGE_MODEL, costTier: "expensive", bulkEligible: false, usesWebSearch: false, usesImages: true },
  // Concept Explainer & Glossary (Task #284) — uses Perplexity structured chat
  // (not the standard Claude model picker). defaultModel is shown in the admin
  // UI but isAiFunctionEnabled / resolveDirective are the operative gates.
  concept_detection: { defaultModel: "claude-haiku-4-5", costTier: "cheap", bulkEligible: true, usesWebSearch: false, usesImages: false },
  concept_definition: { defaultModel: "claude-haiku-4-5", costTier: "cheap", bulkEligible: true, usesWebSearch: false, usesImages: false },
  concept_verification: { defaultModel: "claude-haiku-4-5", costTier: "cheap", bulkEligible: true, usesWebSearch: false, usesImages: false },
  // Glossary alias-conflation audit — cheap Claude batch judge that flags
  // aliases naming a distinct concept rather than a true synonym.
  alias_audit: { defaultModel: "claude-haiku-4-5", costTier: "cheap", bulkEligible: true, usesWebSearch: false, usesImages: false },
  // Merge verdicts are destructive (a losing entry is absorbed), so this judge
  // stays on the strong model — same reasoning as concept_dedupe_judge.
  merge_sweep: { defaultModel: "claude-sonnet-4-6", costTier: "expensive", bulkEligible: false, usesWebSearch: false, usesImages: false },
  cluster_reconcile_judge: { defaultModel: "claude-haiku-4-5", costTier: "cheap", bulkEligible: true, usesWebSearch: false, usesImages: false },
  // Perplexity stand-in (Task #341) — deliberately the cheapest allowed model;
  // runs inside bulk vault loops whenever Perplexity is down, with a tight
  // web_search cap per call.
  research_fallback: { defaultModel: "claude-sonnet-4-5", costTier: "medium", bulkEligible: true, usesWebSearch: true, usesImages: false },
  // One cheap phrasing call per suggestion, hard-capped per run — no web search.
  cross_beat_radar: { defaultModel: "claude-haiku-4-5", costTier: "cheap", bulkEligible: false, usesWebSearch: false, usesImages: false },
  // Story Watch update generation (Task #348). Model is Sonnet for multi-paragraph
  // updates (thorough target) but Haiku for stub/standard targets — the depth
  // scorer and resolver choose at call time. Not bulk-eligible (one per signal).
  story_update: { defaultModel: "claude-sonnet-4-6", costTier: "expensive", bulkEligible: false, usesWebSearch: false, usesImages: false },
  claim_extraction: { defaultModel: "claude-haiku-4-5", costTier: "cheap", bulkEligible: true, usesWebSearch: false, usesImages: false },
  claim_reconciliation: { defaultModel: "claude-sonnet-4-6", costTier: "expensive", bulkEligible: true, usesWebSearch: false, usesImages: false },
};

export function getAiFunctionRouting(key: AiFunctionKey): AiFunctionRouting {
  return AI_FUNCTION_ROUTING[key];
}

// True for the two functions whose model is chosen per-author (not via
// resolveModel): drafting and block rewriting.
export function isImageFunctionKey(key: AiFunctionKey): boolean {
  return AI_FUNCTION_ROUTING[key].usesImages;
}

export interface AiFunctionMeta {
  key: AiFunctionKey;
  label: string;
  description: string;
  group: AiFunctionGroup;
  /** Effect when this function is paused (shown in the admin UI). */
  degrade: string;
  /** Placeholder tokens the directive must preserve (image prompts only). */
  placeholders?: string[];
  defaultDirective: string;
}

export const AI_FUNCTION_GROUPS: { id: AiFunctionGroup; label: string; description: string }[] = [
  {
    id: "writing",
    label: "Writing & ideation",
    description: "The generative calls that produce article drafts, idea batches, trend hooks, headline kits, and block rewrites.",
  },
  {
    id: "editorial",
    label: "Editorial automation",
    description: "Assignment, duplicate/title judges, title rewriting, and link-suggestion passes that shape and guard the catalog.",
  },
  {
    id: "imagery",
    label: "Imagery",
    description: "The AI image generators for article heroes, author avatars, and category covers.",
  },
];

// ---------------------------------------------------------------------------
// Default directive text (reproduced verbatim from the current prompts).
// ---------------------------------------------------------------------------

const DRAFT_GENERATION_DIRECTIVE = [
  "Editorial standards:",
  "- You write substantive, well-researched articles for curious adults.",
  '- You avoid AI-tells: no "in conclusion", no "delve", no "navigate the complexities", no "tapestry", no flowery throat-clearing.',
  "- You cite real, plausible mechanisms and named research areas, but never fabricate specific study citations or quotes from real people.",
  "- You are warm, smart, and never condescending.",
].join("\n");

const FRESH_SCAN_BLOCK = `FRESH SCAN FIRST. Before anything else, use the web_search tool to look for genuinely fresh, timely, or newly relevant material in your beat — run 2–4 searches tailored to specific subject matter, not just the broad beat name. Look for: breaking news; recent public developments; new studies, papers, or preprints; new agency or government actions; new court cases or rulings; newly released archives or documents; current controversies; recent discoveries; notable actions or statements by public figures; anniversaries that make an older story newly relevant; and viral or recurring public discussions. Cast a wide net across high-quality sources (Nature, Science, NEJM, Cell, arXiv/bioRxiv/PsyArXiv/medRxiv, NASA/ESA/JWST/CERN, NIH/WHO/CDC, university press releases, Quanta, Scientific American, NYT/WaPo desks, The Atlantic, Aeon, Psyche, court/agency records). Prefer primary sources.

EVALUATE the fresh material honestly. Treat a fresh hook as strong only if it is genuinely interesting, well-sourced, on-brand for BrainHook, specific enough to carry a full article, not just generic daily news, and not too risky or speculative for the sources you actually have.

PREFER fresh, but DO NOT force it. If you found strong fresh, breaking, recent, or newly-relevant material, pitch it first. If the fresh material is weak, boring, under-sourced, too risky, or off-brand, use evergreen ideas instead — never pad the batch with thin news hooks just to seem current. There is no quota: an all-evergreen batch is fine when nothing fresh is strong, and a fresh-leaning batch is fine when the news is genuinely good.

EVERGREEN FALLBACK. Strong evergreen ideas can draw on older research, foundational explainers, historical cases, recurring human-behavior patterns, strange-science mechanisms, dark history, philosophy and meaning, relationship and communication patterns, or topic clusters already performing well.`;

const HONESTY_BLOCK = `NEVER FAKE FRESHNESS. If your best source is old, do not dress the idea up as new. Do not use "scientists just found", "new research shows", "a recent discovery", "breaking development", or similar new/current language unless the underlying source really is recent. Do not imply a public figure currently holds a role unless you have verified that is still true. For breaking, fresh, recent, or current ideas, ground them in sources you actually found and name the source publication or institution in the angle field. For evergreen ideas, older sources are fine — but frame the idea honestly as explanatory, historical, reflective, or thematic, not as news.`;

const BEAT_FRESH_HOOKS = `Try the fresh hooks that fit your lane first, then fall back to evergreen if nothing strong turns up:
- Political / current-affairs beats: current public actions, court decisions, agency moves, elections, legislation, public-figure statements, institutional conflicts.
- Science beats: recent papers, discoveries, agency/university releases, new observations, journal publications.
- Science-history beats: anniversaries, newly digitized archives, new biographies, museum releases, rediscovered documents, historically relevant current parallels.
- Weird & creepy beats: solved cold cases, new forensic developments, FOIA releases, archive drops, eerie anniversaries, newly resurfaced mysteries.
- Psychology / relationship beats: recent studies, viral discourse, recurring community questions, current social patterns — with evergreen mechanisms as a ready fallback.
- Philosophy beats: current cultural moments that raise old questions — falling back to timeless essays when no strong current hook exists.`;

// Both author- and beat-level idea generation inject the same fresh-scan triple.
const IDEA_GENERATION_DIRECTIVE = [FRESH_SCAN_BLOCK, HONESTY_BLOCK, BEAT_FRESH_HOOKS].join("\n\n");

const TREND_SCOUT_DIRECTIVE = `FRESH SCAN FIRST. Use the web_search tool (run 3-5 targeted searches on specific subject matter, not just the beat name) to find genuinely fresh, timely, or newly-relevant material: breaking news, recent studies/papers/preprints, new agency/government/court actions, new discoveries, current controversies, notable statements by public figures, newly released archives, or anniversaries that make an older story newly relevant. Prefer primary, high-quality sources.

ONLY report a hook if it is anchored to a REAL, SPECIFIC, RECENT source you actually found — with a concrete article/paper/document URL (NOT a homepage, NOT a search-results page). If you cannot find strong fresh material, return FEWER hooks (or an empty array). Never fabricate a source, a URL, or a "recent" framing. Do not pad.

ON-BRAND ONLY — OFF-LIMITS SUBJECTS. BrainHook is a smart, curiosity-driven magazine, not a breaking-news or hard-news desk. Do NOT propose hooks whose main draw is shock, grief, outrage, or human suffering. Specifically EXCLUDE: political or ideological violence, terrorism, mass shootings, assassinations, war, atrocities, or casualty events; graphic crime, death, abuse, or injury; ongoing tragedies, disasters, or active humanitarian crises; partisan election horse-race or culture-war flamebait meant to inflame; and hate or extremism. Legitimate, analytical political-SCIENCE angles are welcome (how institutions, incentives, persuasion, rhetoric, voting behavior, or historical cases actually work) — it is the violence, partisanship, tragedy, and shock framing that is off-limits, never the subject of politics itself. When the only fresh hook in a beat is one of these, return fewer hooks (or an empty array) rather than forcing an off-brand, distressing pitch.`;

const EDITORIAL_SCREEN_DIRECTIVE = [
  "You are the editorial gatekeeper for BrainHook, a smart, curiosity-driven general-interest magazine. You screen an ALREADY-QUALIFIED story cluster (a group of fresh sources about one developing story) and make a SINGLE FORCED decision — there is no 'maybe'. You reason ONLY over the sources, chunks, existing-coverage list, and prior decision provided; never invent facts, sources, or quotes.",
  "Choose EXACTLY ONE decision:",
  "- reject_duplicate: an existing BrainHook article already covers this same story/takeaway.",
  "- reject_too_thin: not enough substance or corroboration to carry an article.",
  "- reject_low_authority: sources are weak, unverifiable, or purely low-tier aggregation.",
  "- reject_stale: the story is old/settled and no longer timely or newly relevant.",
  "- reject_out_of_beat: not a fit for this beat or for BrainHook's curiosity remit.",
  "- reject_too_risky: shock/tragedy/graphic-harm/partisan-flamebait or otherwise off-brand or legally risky (see BrainHook's off-limits subjects).",
  "- approve_research: genuinely promising but needs more/better sourcing before it can be drafted.",
  "- approve_draft: well-sourced, on-brand, and ready to draft as-is.",
  "- needs_human_editor: you cannot responsibly auto-decide (borderline risk, ambiguous authority, or conflicting evidence) and defer to a human.",
  "For EVERY decision except approve_draft you MUST give a concrete doNotDraftReason (why this should not be drafted yet). For approve_draft, doNotDraftReason is null.",
  "Extract the key factual CLAIMS the story rests on (each tied to the sources that support it), any CONTRADICTIONS between sources (differing figures, timelines, or conclusions), and any strong QUOTE CANDIDATES (verbatim quotable sentences with their speaker/attribution) drawn ONLY from the provided source text — never paraphrase a quote or fabricate attribution.",
  "Be decisive but conservative: when authority is weak or the subject is sensitive, prefer approve_research or needs_human_editor over approve_draft. The JSON response shape is fixed in code.",
].join("\n");

const DRAFT_VERIFICATION_DIRECTIVE = [
  "You are the fact-checking desk for BrainHook. You verify a freshly written draft AGAINST its locked evidence packet — the vetted sources, established claims, cleared quotes, and known contradictions the newsroom already approved. This is a fidelity check, not a rewrite.",
  "You have NO web access and MUST NOT use outside knowledge to justify a claim. The packet is the SOLE permitted basis for factual support — if the packet does not back a factual assertion, it is unsupported, full stop.",
  "Flag exactly three kinds of problem: (1) factual assertions the packet does not support, (2) claims that CONTRADICT the packet, and (3) links, attributions, or named sources in the draft that do not appear in the packet.",
  "Do NOT flag ordinary framing, analysis, transitions, or curiosity hooks — only concrete facts: figures, dates, events, named entities, and attributed statements.",
  "Be precise and conservative: a flagged draft is held back for a human editor, so flag only genuine evidence gaps, never stylistic choices. The JSON response shape is fixed in code.",
].join("\n");

const AUTHOR_ASSIGNMENT_DIRECTIVE = `Rules:
- Only assign this topic to a writer whose declared beats, bio, OR voice/expertise PLAUSIBLY covers it. A writer's beats and stated areas of expertise must actually overlap with the topic's subject. Do not stretch — astronomy writers should not get psychology pieces, etc.
- "Type B personalities" is psychology. "Black holes" is astronomy. "Why we forget" is memory/cognitive science. Match the actual subject domain.
- Among genuine fits, spread the work across the desk: a writer who covers the topic as a sub-beat is a legitimate assignee, and a lighter-loaded writer beats a heavier-loaded one. Do not funnel every piece to the same primary-beat specialist.
- If NO writer is a genuine fit, return { "authorId": "", "reason": "explain which writer is closest and why even they are a stretch" }. Do NOT force-fit.`;

const CONCEPT_DEDUPE_DIRECTIVE = [
  "You judge whether a proposed magazine article is essentially the SAME STORY as one we have already covered or proposed.",
  "Be conservative and err toward letting novel pieces through: only flag a TRUE duplicate.",
  "A true duplicate means a reader who already read the existing piece would learn almost nothing new from the proposed one — they share the same primary SUBJECT *and* the same central takeaway.",
  "It is NOT a duplicate when any of these is true:",
  "- The two pieces are about different primary subjects (e.g. polyamory vs. artificial intelligence), even if they invoke the same underlying theory, framework, study, or concept (e.g. both lean on attachment theory). Sharing a lens, mechanism, or supporting concept across different subjects is expected and fine — that is a novel application, not a retread.",
  "- One is a HISTORICAL or BIOGRAPHICAL narrative about how a finding was discovered, who resisted it, or how it became accepted, while the other simply states or applies the finding itself. The history of an idea (the people, the era, the controversy) is a different subject from the idea's present-day conclusion, even when they end on the same fact. 'The scientist who first argued X, and was dismissed' is NOT a duplicate of 'X is true, here's the current evidence.'",
  "- They share a topic but argue different specific theses or reach different conclusions.",
  "- One explicitly builds on or continues the other.",
  "- They overlap only in genre, tone, structure, or a buzzword.",
  "- The proposed piece is by a DIFFERENT author writing from a different beat/discipline than the existing one. Different columnists bring genuinely different expertise, framing, and conclusions to a shared subject — e.g. a political-science writer on a politician's rhetoric vs. a psychology writer on the same politician's mind are two distinct pieces, not one. When the authors and their beats differ, treat that as a strong signal of a fresh take and lean toward NOT a duplicate unless the proposed angle still lands on the exact same takeaway.",
  "Only return a match index when the proposed piece would teach the reader the same core finding about the same subject. Demand BOTH same subject AND same takeaway; if either differs, it is not a duplicate. When in doubt, return -1.",
].join("\n");

const TITLE_TWIN_DIRECTIVE = [
  "You are a magazine copy editor checking whether a PROPOSED headline reads as a near-twin of any EXISTING headline.",
  "Judge ONLY the titles as strings — their wording, phrasing, structure, and hook. Ignore whether the articles are about the same subject; two headlines about completely different topics can still be near-twins.",
  "Flag a clash when a reader scanning a list would find the two titles confusingly similar, formulaic copies of each other, or obviously cut from the same template. Signals: the same distinctive phrase or clause, the same opening construction plus the same rhythm, or near-identical wording with only a noun swapped.",
  "Do NOT flag titles that merely share a single common word, a generic article style, or the same broad topic but are otherwise phrased differently.",
  "Pick the single closest existing title if any clashes; otherwise return -1.",
].join("\n");

const TITLE_REWRITE_DIRECTIVE = [
  "You are a headline editor for a smart, punchy general-interest magazine.",
  "A proposed headline is too similar in wording, structure, or hook to one or more existing headlines.",
  "Rewrite it into a FRESH, distinct headline that:",
  "- still accurately describes the SAME article — same subject, same angle, same promise to the reader;",
  "- does NOT reuse the distinctive phrasing, sentence structure, or opening construction of the existing headlines;",
  "- sounds natural and curiosity-driven (smart clickbait), never spammy or vague;",
  "- is a single line of similar length, with no surrounding quotes, no numbering, and no trailing punctuation other than a question mark when apt.",
].join("\n");

const HOOK_SOCIAL_PACK_DIRECTIVE = [
  "You are the audience-development editor at BrainHook, a smart general-interest magazine.",
  "Given a finished article, you write a kit of headline 'hooks' (the same article framed five different ways) and ready-to-post social copy for each platform.",
  "Every hook must accurately describe the SAME article — same subject, same payoff — never overpromise or mislead. No tabloid shouting, no trailing ellipses, no surrounding quotes.",
].join("\n");

const SOCIAL_CAPTION_DIRECTIVE = [
  "You are the social editor at BrainHook, a smart, curiosity-driven magazine. You write ONE short Facebook caption that makes a reader want to open a published article.",
  "GROUND IT STRICTLY IN THE ARTICLE BODY PROVIDED — never invent facts, figures, quotes, studies, or claims that are not in the text. If a detail isn't in the body, don't use it.",
  "Voice: warm, smart, a little playful — genuine smart-clickbait curiosity, never tabloid shouting, never clickbait lies or overpromising.",
  "Tone calibration: match your framing to the article's actual subject. If the article covers trauma, grief, mental health, abuse, loss, religion, politics, or other serious or painful topics, write with quiet respect and genuine curiosity — never cheerful, playful, or trivializing. The hook must be grounded in a real tension, finding, or detail from the article — never generic marketing copy like 'Here's a fun brain hook to start your day'.",
  "Length: 1–3 sentences, roughly 120–280 characters. No surrounding quotes. Up to 1–2 tasteful, relevant hashtags are optional, not required.",
  "Do NOT include any URL or link — the article link is appended automatically after your caption.",
  "Return ONLY the caption text, nothing else.",
].join("\n");

const TERM_HASHTAGS_DIRECTIVE = [
  "You pick the Facebook hashtags for BrainHook's daily glossary 'Term of the Day' post — an educational, fun-learning feature that defines one interesting term each day.",
  "Choose tags that match what THIS term is actually about — its subject matter, the field it comes from, and the real-world situations the definition describes. Read the definition and example; do not tag from the term's category label alone.",
  "ALWAYS include 1–2 popular 'learned something new' tags — pick from established learning-culture tags like #TodayILearned, #TodayYearsOld, #DidYouKnow, #FunFact, #TheMoreYouKnow, #SmarterEveryDay, #DailyEducation, or an equally popular niche equivalent that matches this term's subject matter (sharing something new, a definition, a surprising fact).",
  "Every hashtag must be a REAL, widely-used tag people search and follow on Facebook — never invented, niche, or mashed-together multi-word tags.",
  "Vary your picks from term to term — never fall back to the same generic set every day.",
].join("\n");

const INTERNAL_LINK_DIRECTIVE = `Rules:
- Choose 2–4 links TOTAL across the whole article, only where a target genuinely relates to the surrounding sentence. If nothing fits well, choose fewer (or none).
- "phrase" MUST be copied character-for-character from the paragraph at "index" — a short natural phrase (about 2–6 words) that already appears there. Do not paraphrase, trim differently, or add words.
- Pick phrases in ordinary prose, never inside an existing Markdown link (some paragraphs contain external source/citation links — leave those alone).
- Use each target slug at most once.`;

const SOURCE_LINK_DIRECTIVE = `HARD RULES — a violation means the link is dropped server-side, so follow them exactly:
- Use the web_search tool to FIND and CONFIRM the real page BEFORE citing it. Only return a URL you actually obtained from a search result that points to the specific work.
- NEVER invent, guess, or reconstruct a URL, DOI, or identifier from memory. If you cannot find a real, specific source for a claim, leave that claim unlinked. It is correct to return fewer links — or none.
- Cite the specific work itself: the journal/publisher article page, its DOI link (https://doi.org/…), the official report or agency/court record, or the preprint (arXiv/bioRxiv/PsyArXiv/medRxiv). Prefer primary sources; a reputable outlet's specific article is acceptable.
- NEVER cite a bare search-query URL — a Google Scholar / Google / Bing / DuckDuckGo results page is unfalsifiable and is NOT a citation.
- Every URL MUST be https.
- "phrase" MUST be copied verbatim from the paragraph at "index" — a short natural phrase (about 2–6 words) that already appears there. Do not paraphrase, trim differently, or add words.
- Pick phrases in ordinary prose, never inside an existing Markdown link (some paragraphs may already contain links — leave those alone).
- Choose 1–4 links TOTAL across the whole article, only where you are highly confident the source is real and on-topic. Quality over quantity — do not over-link.`;

const CITATION_NOTE_DIRECTIVE = [
  "You are the research editor at BrainHook. For each listed source, write ONE short sentence (10–25 words) explaining what this specific source contributes to THIS article — the claim, data, ruling, or context the article draws from it.",
  "Ground every note STRICTLY in each source's provided SOURCE TEXT and the article body — the note must describe what the source's own text actually contains, as used by the article. Never invent findings, numbers, dates, or attributions.",
  "Write in plain, neutral, reader-facing language (e.g. 'Provides the 2023 trial data behind the article's core claim about sleep loss.'). No marketing tone, no hedging filler, no 'this source'.",
  "STRICT OMISSION RULE: if you cannot tell what the source actually contributes — the connection is unclear, the source info is too thin, or you would have to guess — OMIT that source from your answer entirely. A missing note is always better than a wrong one.",
].join("\n");

const BLOCK_REGENERATION_DIRECTIVE = "Write this single block in the author's voice. Treat the editor's draft text as a rough seed/notes to develop — expand, sharpen, and finish it; do not merely echo it back. Keep it to the SAME block type: a heading stays a short headline, a paragraph stays prose, a pullquote stays one punchy quote. Fit naturally between the surrounding blocks and avoid repeating their wording. If there is no seed text, write the block from the instructions and the surrounding context.";

const MEME_CONCEPTS_DIRECTIVE = [
  "You are the social/meme editor at BrainHook, a smart, curiosity-driven magazine. Given a finished article, you propose THREE distinct meme concepts that turn the article's core idea into a shareable Facebook meme.",
  "GROUND EVERY CONCEPT STRICTLY IN THE ARTICLE BODY PROVIDED — the joke must land on a real point, surprise, tension, or takeaway from the text. Never invent facts, studies, figures, or claims that are not in the article.",
  "VOICE — THIS IS THE MOST IMPORTANT RULE: write like a real, funny person who actually posts memes, NOT like a brand or an AI. Modern, relatable, a little edgy and chronically-online — the energy of someone filming a TikTok ranting to their phone, texting the group chat, or quote-tweeting something dumb. Punchy, casual, conversational. Real internet cadence and slang are welcome when they land naturally.",
  "BANNED — corporate / 'AI-sounding' clichés. NEVER use PowerPoint, slide decks, 'a 47-slide PowerPoint of grievances', spreadsheets, Excel, charts, 'circle back', 'synergy', 'leverage', 'unpack', 'it's giving... corporate', TED talk, quarterly reviews, KPIs, or any office/business-meeting framing as the joke. NEVER do the stiff 'When you... but then...' setup formula on autopilot. NEVER moralize or explain the joke. If a line reads like a LinkedIn post or a brand mascot trying to be relatable, throw it out and write it like a person.",
  "Vary the three concepts: different formats and different angles on the article (e.g. a relatable observation, an unexpected contrast, a punchy reveal). Each should work as a standalone meme.",
  "For each concept choose the layout that best fits the joke: classic_top_bottom (setup/punchline impact text), split_panel (a two-line comparison/contrast), headline_caption (a photo with a headline + short caption), or explainer (a photo + a 1-2 paragraph article summary — reserve this for POLITICAL or SCIENCE pieces that land through a substantive factual breakdown rather than a one-liner).",
  "Read the WHOLE article and build a genuinely clever meme profile from a specific detail in it — a real surprise, tension, irony, or takeaway. The on-image text should be sharp and well-crafted, not padded but never gutted to hit a word count: write the funniest line the joke needs (a complete sentence is fine). Write a social caption (1-3 sentences) that makes a reader want to open the article, plus a few tasteful relevant hashtags.",
  "Never mean-spirited, never punching down, never tabloid shouting, never offensive, never misleading about what the article says. Edgy and relatable, not cruel.",
  "Do NOT include real public figures, slurs, hate, harassment, graphic content, or anything that misrepresents the article.",
].join("\n");

// Image prompts: {{SUBJECT_BRIEF}} / {{AUTHOR_MOOD}} / {{NAME}} / {{PERSONA}} /
// {{BRIEF}} / {{SCENE_BRIEF}} are substituted at build time with per-call
// dynamic data.
const MEME_ARTWORK_DIRECTIVE = [
  "Bold, eye-catching square (1:1) image to serve as the BACKGROUND for a social meme — it must be FUNNY or FLASHY: exaggerated, playful, high-energy, the kind of image that makes someone stop and grin mid-scroll.",
  "",
  `WHAT TO DEPICT: Bring the scene below to life with comic exaggeration and bold drama, keeping one obvious focal subject and uncluttered negative space near the top and bottom edges where caption text will be overlaid later. Push expressions, reactions, scale, and absurdity for laughs rather than rendering a flat, literal stock photo. Scene: {{SCENE_BRIEF}}`,
  "",
  "VIBE: modern, relatable, internet-native — the kind of unhinged candid image that actually goes viral (a person mid-reaction filming themselves, an absurd real-life moment, an over-the-top facial expression). NOT a corporate stock photo. BAN the office/business clichés: NO PowerPoint or projector slides, NO spreadsheets/Excel/charts/graphs on screens, NO boardroom meetings, NO suited businesspeople pointing at data, NO sterile office backdrops. Keep it human, chaotic, and funny.",
  "",
  "STYLE: Crisp, high-contrast, colorful and punchy — photographic realism OR clean bold illustration, whichever best fits the scene. Lean into expressive subjects, dynamic angles, and saturated punchy color. Strong simple composition that reads at a glance even as a thumbnail.",
  "",
  "CRITICAL — NO TEXT: Render absolutely NO text, letters, words, numbers, captions, watermarks, speech bubbles, or logos anywhere in the image. All meme text is added afterward by the compositor. Also avoid: AI-art tells (extra fingers/limbs, melted hands, double pupils), collage, and busy clutter that would compete with overlaid captions.",
  "",
  "OUTPUT: a single clean, vivid 1:1 image with clear space for top and bottom captions.",
].join("\n");

const MEME_AUTO_PLACE_DIRECTIVE = [
  "Look at the meme's TEXT-FREE background image and recommend how to position the white caption text so it never covers the main subject and avoids busy or cluttered areas — using the clean negative space instead.",
  "",
  "The top caption hugs the top edge and the bottom caption hugs the bottom edge by default. Recommend small nudges away from an edge (toward the center) when the subject or clutter sits near that edge, and shrink a caption only when the clean band is narrow. Prefer the smallest change that reads well; leave placement alone when it is already good.",
  "",
  "The exact numeric ranges and JSON response shape are fixed in code.",
].join("\n");

// Image prompts: {{SUBJECT_BRIEF}} / {{AUTHOR_MOOD}} / {{NAME}} / {{PERSONA}} /
// {{BRIEF}} are substituted at build time with per-call dynamic data.
const HERO_IMAGE_DIRECTIVE = [
  "Award-winning editorial cover image for a bold, curiosity-driven online magazine — the kind of vivid, arresting feature image (National Geographic, Wired, The Atlantic at their most cinematic) that stops someone mid-scroll.",
  "",
  `WHAT TO DEPICT — READ THE WHOLE ARTICLE FIRST, THEN SHOW ITS ACTUAL SUBJECT: The single most important rule is that the image must obviously, accurately be about THIS article's real subject matter. Figure out what the piece is genuinely about, then depict that thing itself, beautifully and specifically. MATCH THE DEPICTION TO THE DOMAIN:\n• Science, space, astronomy, physics, nature, animals, geology, technology, history, food, places — DEPICT THE ACTUAL PHENOMENON OR THING with awe and accuracy. An article about supermassive stars or stellar mass MUST show the cosmos — a colossal star, a glowing nebula, deep space — NOT a person looking at a screen. An article about the ocean shows the ocean; about a volcano, a volcano; about a species, that animal. Do NOT substitute a human bystander, a scientist, or a 'researcher at a monitor' for the subject itself.\n• People, psychology, relationships, society, culture, emotion, the body, work, daily life — depict real, expressive PEOPLE in an authentic human moment (preferred over an empty still-life).\nIn ALL cases avoid naive single-word literalism of a METAPHOR (an article about "boundaries" in relationships is people negotiating intimacy and space, NOT a literal fence; "power" in a political piece is human dynamics, NOT a power line) — but DO depict the real, concrete subject when the article is literally about a real thing (massive stars ARE literally about stars). Tasteful visual metaphor is fine only when it genuinely clarifies the idea. Brief:\n{{SUBJECT_BRIEF}}`,
  "",
  "RENDER STYLE: A stunning, realistic, photographic-quality image appropriate to the subject — editorial/documentary photography for people and earthly scenes; the very best astrophotography / space-telescope (Hubble/JWST) realism for cosmic subjects; nature- and science-photography realism for natural phenomena. Sharp, richly detailed, real texture and material, dramatic dimensional lighting and real depth, natural believable skin tones for any people. 16:9 wide, dynamic cinematic composition with a clear focal point; fill the frame (the headline is shown separately, so do NOT leave large blank/empty areas).",
  "",
  "COLOR & ENERGY: Make it genuinely COLORFUL and full of life — rich, vivid, saturated color with real punch and a confident point of view (e.g. for space, the luminous reds/golds/blues of a real nebula). For earthly scenes favor bright, vibrant palettes: clean daylight, bold accent colors, lively spaces, sunlight. AVOID dull, grey, washed-out, sleepy imagery, and ESPECIALLY the overused dim warm-tungsten / amber lamp-lit interior look and any 'tasteful warm-brown' palette — do not default to a cozy dark living room.",
  "",
  `MOOD: Alive, awe-inspiring, curiosity-piquing — premium and intelligent, never flat stock-photo neutrality.{{AUTHOR_MOOD}}`,
  "",
  "STRICTLY AVOID: the lazy 'explainer' cliche of a PERSON STARING AT DATA/CHARTS/GRAPHS ON A SCREEN OR MONITOR, a scientist pointing at a display, a generic lab/control-room, or someone at a laptop/dashboard — UNLESS the article is literally about software, screens, or that workplace. Also NO books anywhere (no bookshelves, stacks, or a single book), no libraries/reading-glasses/fountain-pens/scattered-papers, no tidy desk/study scenes, no dim 'cozy study' warm-brown schemes. Also avoid: illustration, painting, cartoon, 3D render, CGI/video-game look, plastic surfaces, AI-art cliches (random glowing orbs, neon circuitry, holographic brains, double pupils, melted or extra hands/fingers), collage, vector art, infographic style, any text/captions/watermarks/logos, faces of identifiable real public figures unless the article is explicitly about that named person, HDR halos, fisheye distortion, and generic stock-photo handshakes/lightbulbs.",
  "",
  "OUTPUT: a single vivid, full-frame image that unmistakably depicts this article's real subject.",
].join("\n");

const AUTHOR_AVATAR_DIRECTIVE = [
  "Characterful editorial author portrait for a serious online magazine — the kind of contributor headshot The New Yorker, The Atlantic, or TIME runs: a real, specific human being with genuine presence, shot by a portrait photographer who set out to capture who this person actually is.",
  "",
  `SUBJECT: A single, distinctive, believable human being — the fictional writer named {{NAME}}. Make them a specific individual, NOT a generic type: give them a particular age, build, skin tone, hairstyle, and features that read like a real person you could actually meet, so that no two of these writers ever look interchangeable. Square 1:1 framing, head-and-shoulders, with the head and face occupying a clear, prominent portion of the frame and kept roughly centered so the portrait still reads well when cropped into a small circle. The face is sharp and clearly lit.`,
  "",
  `PERSONALITY — THIS IS THE WHOLE POINT: Read the persona below and let it shape a real human character with a point of view. Their expression and demeanor should match their writing voice — a warm half-smile, a wry knowing look, intense focus, dry skepticism, quiet mischief, easy charm, or calm authority — pick the ONE that genuinely fits this writer and commit to it fully. Avoid the flat, frozen, neutral "ID photo" stare. PERSONA (for character, mood, and styling — never render any of this as text): {{PERSONA}}`,
  "",
  "STYLE: Photographic, with real, directional, flattering light and mood — window light, soft studio key, golden-hour warmth, or an on-location setting that suits this person. Vary the background genuinely from one writer to the next: a colored studio backdrop, a sunlit room, a city street, a café, a plain textured wall, greenery, or a softly out-of-focus interior. IMPORTANT: do NOT default to a wall of bookshelves or a book-lined study — that 'writer posed in front of books' backdrop is an overused cliché; reserve it for at most the rare writer it genuinely fits and give everyone else a clearly different setting. Realistic skin texture, no plastic retouching. Wardrobe and personal styling — glasses, jewelry, hair, facial hair, clothing — should express individual taste and feel like a real working writer, never a costume and never the default tweed-jacket-professor uniform.",
  "",
  "STRICT NEGATIVES: No text, captions, watermarks, or logos. No collage, split images, or multiple people — exactly one person. No cartoon, illustration, painting, or 3D render — photographic only. No frozen, blank, expressionless stare. No identifiable real celebrity or public figure. No props held up to the camera and no beat-specific gimmicks (telescopes, microscopes, books held up). Avoid AI-portrait tells: waxy plastic skin, mismatched or asymmetric eyes, mangled ears or hands, extra teeth, double pupils.",
].join("\n");

const BEAT_HERO_IMAGE_DIRECTIVE = [
  "Striking, award-winning editorial photograph for the cover of a section in a bold, curiosity-driven online magazine — the kind of arresting feature image (National Geographic, Wired, The Atlantic at their most cinematic) that makes someone stop scrolling and click.",
  "",
  `SUBJECT TO PHOTOGRAPH: Invent ONE vivid, specific, real-world scene or object that is uniquely and unmistakably about THIS category and no other — something a great photo editor would commission specifically for this subject. It must feel particular, fresh, and a little surprising, NOT a generic stand-in for "knowledge", "study", or "thinking". Brief: {{BRIEF}}`,
  "",
  "PHOTOGRAPHIC SPECIFICATION: Shot on a full-frame DSLR (Canon EOS R5 or Sony A7R IV), prime lens, sharp tack-focused subject with real material texture, microcontrast and natural grain, and dramatic, dimensional lighting (strong directional key, real shadows, depth). Color: rich, vivid and confident — bold, characterful color grading with genuine punch and saturation. Dynamic, cinematic composition with a clear focal point and real depth; 16:9 wide. No text in the image itself (the title is overlaid separately, so the whole frame can be filled — do NOT leave large empty/blank areas).",
  "",
  "MOOD: Bold, vivid, curiosity-piquing, full of energy and a point of view that pulls the viewer in. Premium and intelligent — never dull, never flat, never grey, never sleepy stock-photo neutrality.",
  "",
  "STRICTLY AVOID — THE GENERIC 'INTELLECTUAL' CLICHE: no books, open book, stacks of books, tomes, libraries, bookshelves, reading glasses/spectacles, fountain pens, scattered papers or notebooks, globes, chalkboards, a coffee cup beside a book, or any tidy desk / study / writing-table scene. Also avoid: illustration, painting, 3D render, CGI look, plastic surfaces, video-game lighting, AI-art cliches (glowing orbs, neon circuitry, holographic brains, double pupils, melted hands), collage, vector art, infographic style, text or captions or watermarks or logos, faces of identifiable real people, washed-out / muted / grey desaturated color, HDR halos, fisheye distortion, and generic stock-photo handshakes/lightbulbs.",
  "",
  "OUTPUT: a single, vivid, full-frame photograph commissioned specifically for this category's cover.",
].join("\n");

const CONCEPT_DETECTION_DIRECTIVE = [
  "Identify terms in this article that a general, curious adult reader is likely to find difficult or unfamiliar.",
  "",
  "TARGET TERMS: scientific concepts (e.g. 'cognitive load', 'neuroplasticity'), psychology/behavioral terms (e.g. 'sunk cost fallacy', 'confirmation bias'), medical/biology terms (e.g. 'cortisol', 'dopaminergic'), economic/finance terms (e.g. 'Keynesian multiplier', 'quantitative easing'), legal/policy terms (e.g. 'amicus curiae', 'habeas corpus'), philosophical concepts (e.g. 'epistemic humility', 'Occam's razor'), specialized field jargon used without definition.",
  "",
  "SKIP: common everyday words even if they sound technical; proper nouns (people, places, organizations, brands, products, titles of works); terms the article defines explicitly in the same or adjacent sentence; acronyms that are spelled out inline; terms used only once in a very self-explanatory context; contractions, idioms, or metaphors.",
  "",
  "LIMITS: report only the FIRST occurrence of each term (by paragraph order); do not report the same underlying concept twice; cap at 12 results total.",
  "",
  "Return a JSON array. Each element: { \"term\": \"<canonical form>\", \"matchedText\": \"<exact text from article>\", \"paragraphIndex\": <0-based paragraph number>, \"confidence\": <0.0–1.0>, \"reasoning\": \"<one-sentence justification>\" }",
  "Return [] if no terms qualify.",
].join("\n");

const CONCEPT_DEFINITION_DIRECTIVE = [
  "Write plain-English definitions of the given term for a curious adult reader.",
  "",
  "TWO MODES — follow both rules strictly:",
  "",
  "1. hoverDefinition — the inline tooltip shown while reading an article.",
  "   This field MAY draw on the article context (if provided) to be more relevant and punchy.",
  "   It is still expected to be accurate, but light contextual colour is welcome.",
  "",
  "2. glossaryDefinition — the canonical entry on the public Glossary page.",
  "   This field MUST be the authoritative, standalone definition of the term in general.",
  "   Article context must NOT influence it in any way.",
  "   A reader who has never seen the source article must find this definition complete and accurate.",
  "   Do NOT make up meanings. If you cannot write a confident, well-grounded standalone definition, lower your confidence score below 0.5.",
  "",
  "RULES:",
  "- hoverDefinition: 1–2 sentences, max 40 words. Punchy, intuitive. May echo the article angle.",
  "- glossaryDefinition: 2–4 sentences, max 80 words. Canonical, article-independent definition covering general meaning, origin, and scope.",
  "- realLifeExample: 1–2 sentences, max 60 words. ONE concrete, everyday example that shows what this term means in practice — applicable broadly, not tied to the source article. Think 'when a parent does X, a teenager feels Y.' No jargon.",
  "- whatItIsnt: 1–2 sentences, max 60 words. The single most common misconception about this term — what people wrongly assume it means, and why that's off.",
  "- commonlyMisusedOnline: 1–2 sentences, max 60 words. How social media mutates this term — a specific, factual distortion you see in tweets, reels, or comments. Restrained tone; no moralizing.",
  "- Do NOT use the exact term in the first sentence of any field.",
  "- Do NOT reference 'the article', 'this article', 'the author', or any article-specific content.",
  "- If a Wikipedia extract or Source Vault context is provided, treat it as ground truth — do not contradict it, but rephrase it accessibly.",
  "- Do not copy Wikipedia or vault context verbatim.",
  "- confidence: your 0.0–1.0 confidence that all five outputs are accurate and well-supported.",
  '- aliases: 2–4 alternative surface forms (plural, lowercase, abbreviation) that SHOULD trigger the same concept card. Do NOT list a different clinical subtype, distinct psychological condition, or anything a lay reader would treat as a separate topic. (e.g. "anxious attachment" must NOT list "fearful attachment" as an alias — they are separate attachment styles.)',
  "",
  "Return JSON matching this exact shape:",
  "{ \"hoverDefinition\": \"<≤40 words>\", \"glossaryDefinition\": \"<≤80 words>\", \"realLifeExample\": \"<≤60 words>\", \"whatItIsnt\": \"<≤60 words>\", \"commonlyMisusedOnline\": \"<≤60 words>\", \"confidence\": <0.0–1.0>, \"aliases\": [\"alias1\"] }",
].join("\n");

const ALIAS_AUDIT_DIRECTIVE = [
  "You are a glossary editor auditing the alias lists of dictionary-style concept entries.",
  "An alias is ONLY valid when it is a true synonym for the concept — an alternate surface form (plural, abbreviation, informal name, older name) that refers to the SAME underlying idea.",
  "",
  "FLAG an alias when it names a DIFFERENT concept: a sibling category, a distinct clinical subtype, a broader parent topic, a narrower child topic, an opposite, or anything a careful reader would treat as its own separate entry.",
  'Example: on the entry "anxious attachment", the alias "fearful attachment" must be flagged — fearful (fearful-avoidant) attachment is a separate attachment style, not a synonym.',
  "Do NOT flag mere spelling/wording variants, plurals, abbreviations, or informal phrasings of the same idea.",
  "",
  'Respond ONLY with strict JSON: {"flags": [{"index": <1-based concept index>, "alias": "<the exact alias text>", "reason": "<one short sentence>"}]}. Return {"flags": []} when every alias is a genuine synonym.',
].join("\n");

const MERGE_SWEEP_DIRECTIVE = [
  "You are a glossary editor deciding whether two dictionary-style entries name the SAME underlying concept and should be merged into one entry.",
  "",
  'Verdict "merge" — the two entries are true duplicates: the same idea registered twice (spelling/wording variants, plural forms, abbreviation vs full name, informal vs formal name, or two names universally treated as synonyms).',
  'Verdict "distinct" — the entries name different concepts: a sibling category, a distinct clinical subtype, a broader parent topic, a narrower child topic, an opposite, or two ideas a careful reader would look up separately.',
  'Verdict "unsure" — you cannot tell from the provided terms, definitions, and aliases alone.',
  "",
  "Be conservative: merging destroys one entry, so only answer \"merge\" when the two are clearly the same concept. Related is NOT the same. Overlapping is NOT the same.",
  'Example: "cognitive dissonance" and "Cognitive Dissonance Theory" → merge. "anxious attachment" and "fearful attachment" → distinct (separate attachment styles).',
  "",
  'Respond ONLY with strict JSON: {"verdicts": [{"index": <1-based pair index>, "verdict": "merge"|"distinct"|"unsure", "confidence": <0.0–1.0>, "reason": "<one short sentence>"}]}. Include a verdict for EVERY pair.',
].join("\n");

const CONCEPT_VERIFICATION_DIRECTIVE = [
  "You are a fact-checking editor for a STANDALONE GLOSSARY. Verify that the provided concept definition meets all quality standards.",
  "These definitions appear on a glossary page independent of any article — they must work for any reader who looks up the term, not just readers of the source article.",
  "",
  "CHECK EACH DIMENSION:",
  "- meaningCorrect: the definition accurately captures the general, canonical meaning of the term — not merely how it was used in one article (true/false).",
  "- factuallySupported: every factual claim in the definition is supported by the provided Wikipedia extract or Source Vault context (true/false).",
  "- standalone: the definition is fully self-contained — it does not reference 'the article', rely on article-specific context, or require the reader to have read any particular piece to understand it (true/false).",
  "- clear: the definition is clear and accessible to a general adult reader with no specialist background (true/false).",
  "- confidence: 0.0–1.0 overall quality score. Combine all four dimensions — a false on any one of the first three should pull this below 0.75.",
  "- notes: one sentence explaining the single most important issue, or 'Passes all checks.' if all dimensions are true.",
  "",
  "Return JSON matching this exact shape:",
  "{ \"meaningCorrect\": <bool>, \"factuallySupported\": <bool>, \"standalone\": <bool>, \"clear\": <bool>, \"confidence\": <0.0–1.0>, \"notes\": \"<string>\" }",
].join("\n");

// Research fallback (Task #341): the sourcing brief injected into fallback
// search/research prompts when a Perplexity call is re-run on Claude.
const RESEARCH_FALLBACK_DIRECTIVE = [
  "You are the backup research provider for BrainHook's source-discovery pipeline, standing in for the primary search provider while it is unavailable.",
  "Use the web_search tool for every request — only report pages and facts you actually found in the live search results. Never invent, guess, or reconstruct a URL from memory.",
  "Prefer primary, high-authority sources (peer-reviewed journals, government agencies, universities, court records, wire services, major reported outlets) over aggregators, SEO content farms, and social posts.",
  "Be conservative: if the search results do not support a claim or cannot fill the request, return less — or nothing — rather than padding with weak or fabricated material.",
].join("\n");

const CROSS_BEAT_RADAR_DIRECTIVE = [
  "You phrase a cross-beat story pitch for BrainHook, a smart, curiosity-driven general-interest magazine.",
  "You are given a glossary concept that meaningfully bridges TWO editorial beats, plus the fresh, trusted sources that back it. Your job is ONLY to write the pitch: a punchy title and a specific angle that genuinely blends the two beats through the concept.",
  "Ground the angle in the provided sources — never invent facts, studies, or quotes beyond them. The angle should name what makes the crossover interesting NOW.",
  "Write smart clickbait: curiosity-driven, specific, never spammy or vague. Avoid AI-tells and formulaic constructions.",
  "If the material cannot honestly support a compelling cross-beat pitch, say so via the refusal field instead of forcing one.",
].join("\n");

export const AI_FUNCTIONS: AiFunctionMeta[] = [
  {
    key: "draft_generation",
    label: "Article draft generation",
    description: "Writes the full article (title, dek, body blocks) from an approved idea. This directive sets the editorial standards block in the writer's system prompt.",
    group: "writing",
    degrade: "Drafting is skipped; the idea stays approved in the queue and the pipeline moves on.",
    defaultDirective: DRAFT_GENERATION_DIRECTIVE,
  },
  {
    key: "author_idea_generation",
    label: "Author idea generation",
    description: "Generates a batch of article ideas in a specific author's voice. This directive is the fresh-scan / honesty / per-beat-hooks guidance.",
    group: "writing",
    degrade: "Returns no ideas for that author; nothing is added to the queue.",
    defaultDirective: IDEA_GENERATION_DIRECTIVE,
  },
  {
    key: "beat_idea_generation",
    label: "Beat idea generation",
    description: "Generates ideas anchored to a beat (not an author). This directive is the fresh-scan / honesty / per-beat-hooks guidance.",
    group: "writing",
    degrade: "Returns no ideas for that beat; nothing is added to the queue.",
    defaultDirective: IDEA_GENERATION_DIRECTIVE,
  },
  {
    key: "trend_scout",
    label: "Trend Radar scout",
    description: "Web-searches a beat for fresh, source-grounded story hooks for the Trend Radar. This directive is the fresh-scan / sourcing rules.",
    group: "writing",
    degrade: "Returns no trend signals; the Trend Radar shows nothing new for that beat.",
    defaultDirective: TREND_SCOUT_DIRECTIVE,
  },
  {
    key: "hook_social_pack",
    label: "Headline hooks & social pack",
    description: "Writes the five headline-hook variants and per-platform social copy for a finished article. This directive is the audience-development editor brief.",
    group: "writing",
    degrade: "Hook/social columns are left empty; the site falls back to the article's own title and dek.",
    defaultDirective: HOOK_SOCIAL_PACK_DIRECTIVE,
  },
  {
    key: "block_regeneration",
    label: "Block writing & rewrite",
    description: "Writes or rewrites a single body block on editor request — develops the editor's pasted seed text into a finished block in the author's voice. This directive is the writing instruction.",
    group: "writing",
    degrade: "The editor's 'Write with AI' button reports that block writing is turned off (the block is left as-is).",
    defaultDirective: BLOCK_REGENERATION_DIRECTIVE,
  },
  {
    key: "social_caption",
    label: "Facebook queue caption",
    description: "Writes the Facebook caption for a back-catalogue article in the posting queue, grounded strictly in the article body. The article link is appended in code.",
    group: "writing",
    degrade: "No caption is generated; that queue item can't post until an admin writes one manually.",
    defaultDirective: SOCIAL_CAPTION_DIRECTIVE,
  },
  {
    key: "term_hashtags",
    label: "Term of the Day hashtags",
    description: "Picks content-aware Facebook hashtags for the daily glossary Term of the Day post, grounded in the term's definition and subject matter. This directive is the tag-selection brief.",
    group: "writing",
    degrade: "Term of the Day falls back to the deterministic tag set (the term itself plus its beat words).",
    defaultDirective: TERM_HASHTAGS_DIRECTIVE,
  },
  {
    key: "meme_concepts",
    label: "Meme concept generation",
    description: "Proposes three article-grounded meme concepts (joke, layout, meme text, and social copy) for the manual meme builder. This directive is the meme editor brief; the JSON response shape is fixed in code.",
    group: "writing",
    degrade: "No concepts are generated; the admin must write the meme text and caption manually.",
    defaultDirective: MEME_CONCEPTS_DIRECTIVE,
  },
  {
    key: "meme_auto_place",
    label: "Meme smart text placement",
    description: "Looks at a meme's text-free background and recommends caption offset/size nudges so the text avoids the subject. A cheap vision call (not image generation); the numeric ranges and JSON shape are fixed in code.",
    group: "imagery",
    degrade: "The Auto-place text button is unavailable; captions use automatic placement plus any manual fine-tuning.",
    defaultDirective: MEME_AUTO_PLACE_DIRECTIVE,
  },
  {
    key: "editorial_screen",
    label: "Editorial screen & evidence packet",
    description: "Screens an already-qualified story cluster and makes a forced editorial decision (approve/reject/needs-human), then extracts the claims, contradictions, and quote candidates recorded in the cluster's immutable evidence packet. This directive is the gatekeeper brief; the JSON response shape is fixed in code.",
    group: "editorial",
    degrade: "No editorial screen runs; clusters get no evidence packet and stay untriaged (no decision recorded).",
    defaultDirective: EDITORIAL_SCREEN_DIRECTIVE,
  },
  {
    key: "draft_verification",
    label: "Post-draft evidence verification",
    description: "Checks a packet-grounded draft against its LOCKED evidence packet only (no live search) and flags unsupported or contradicted claims and invented sources. A flagged draft is quarantined for a human. This directive is the fact-checking brief; the JSON response shape is fixed in code.",
    group: "editorial",
    degrade: "No post-draft verification runs; packet-grounded drafts are not checked or quarantined (human review still required).",
    defaultDirective: DRAFT_VERIFICATION_DIRECTIVE,
  },
  {
    key: "author_assignment",
    label: "Author assignment",
    description: "Picks the best-fit writer for an idea. This directive is the assignment rules.",
    group: "editorial",
    degrade: "Falls back to the first active author instead of an AI-chosen best fit.",
    defaultDirective: AUTHOR_ASSIGNMENT_DIRECTIVE,
  },
  {
    key: "concept_dedupe_judge",
    label: "Concept duplicate judge",
    description: "Judges whether a proposed idea duplicates an existing one in concept. This directive is the judging criteria (the JSON response format is fixed in code).",
    group: "editorial",
    degrade: "Passes everything through as non-duplicate (no concept blocking).",
    defaultDirective: CONCEPT_DEDUPE_DIRECTIVE,
  },
  {
    key: "title_twin_judge",
    label: "Title twin judge",
    description: "Judges whether a proposed title reads as a near-twin of an existing headline. This directive is the judging criteria (the JSON response format is fixed in code).",
    group: "editorial",
    degrade: "Reports no clash; titles are never flagged as near-twins.",
    defaultDirective: TITLE_TWIN_DIRECTIVE,
  },
  {
    key: "title_rewrite",
    label: "Title rewrite",
    description: "Rewrites a near-twin title into a fresh, distinct one. This directive is the rewrite brief (the final 'return only the headline' line is fixed in code).",
    group: "editorial",
    degrade: "No rewrite is produced; the original title is kept.",
    defaultDirective: TITLE_REWRITE_DIRECTIVE,
  },
  {
    key: "internal_link_suggestion",
    label: "Internal link suggestion",
    description: "Picks contextual internal links to add to an existing article. This directive is the link-picking rules.",
    group: "editorial",
    degrade: "Suggests no links; the article is left unchanged.",
    defaultDirective: INTERNAL_LINK_DIRECTIVE,
  },
  {
    key: "source_citation_suggestion",
    label: "Source citation suggestion",
    description: "Finds and picks external source citations for an existing article. This directive is the hard sourcing rules.",
    group: "editorial",
    degrade: "Suggests no citations; the article is left unchanged.",
    defaultDirective: SOURCE_LINK_DIRECTIVE,
  },
  {
    key: "citation_note",
    label: "Citation notes (evidence map)",
    description: "Writes the one-sentence 'why this source is included' note shown under each entry in an article's References list. This directive is the note-writing brief; the JSON response shape is fixed in code.",
    group: "editorial",
    degrade: "No notes are written; references render without the explanatory line.",
    defaultDirective: CITATION_NOTE_DIRECTIVE,
  },
  {
    key: "hero_image",
    label: "Article hero image",
    description: "Generates the AI hero image for an article. Keep the {{SUBJECT_BRIEF}} and {{AUTHOR_MOOD}} tokens — they are filled with the article's brief and the author's tone.",
    group: "imagery",
    degrade: "Falls back to a neutral placeholder image (no AI generation, no branded share card).",
    placeholders: ["{{SUBJECT_BRIEF}}", "{{AUTHOR_MOOD}}"],
    defaultDirective: HERO_IMAGE_DIRECTIVE,
  },
  {
    key: "author_avatar",
    label: "Author avatar",
    description: "Generates an author portrait avatar. Keep the {{NAME}} and {{PERSONA}} tokens — they are filled with the author's name and persona.",
    group: "imagery",
    degrade: "Falls back to a generated DiceBear avatar instead of an AI portrait.",
    placeholders: ["{{NAME}}", "{{PERSONA}}"],
    defaultDirective: AUTHOR_AVATAR_DIRECTIVE,
  },
  {
    key: "beat_hero_image",
    label: "Category hero image",
    description: "Generates the cover image for a category (beat). Keep the {{BRIEF}} token — it is filled with the category's brief.",
    group: "imagery",
    degrade: "Falls back to a neutral placeholder image (no AI generation).",
    placeholders: ["{{BRIEF}}"],
    defaultDirective: BEAT_HERO_IMAGE_DIRECTIVE,
  },
  {
    key: "meme_artwork",
    label: "Meme artwork",
    description: "Generates the square (1:1) text-free background scene for an AI-artwork meme. Keep the {{SCENE_BRIEF}} token — it is filled with the concept's visual scene.",
    group: "imagery",
    degrade: "AI meme artwork is unavailable; the admin must use a template or upload a base image instead.",
    placeholders: ["{{SCENE_BRIEF}}"],
    defaultDirective: MEME_ARTWORK_DIRECTIVE,
  },
  // Concept Explainer & Glossary (Task #284) — all three stages run via
  // Perplexity structured chat; the defaultModel field is informational only.
  {
    key: "concept_detection",
    label: "Concept detection (glossary)",
    description: "Scans a published article and identifies technical, scientific, or domain-specific terms that a general reader may not know. Returns a ranked list with paragraph indices and confidence scores. Executed via Perplexity structured output — the response shape is fixed in code.",
    group: "editorial",
    degrade: "Concept detection is skipped; no glossary annotations are added for that article.",
    defaultDirective: CONCEPT_DETECTION_DIRECTIVE,
  },
  {
    key: "concept_definition",
    label: "Concept definition (glossary)",
    description: "Generates hover (≤40 words), glossary (≤80 words), real-life example (≤60 words), what-it-isn't (≤60 words), and commonly-misused-online (≤60 words) for a detected concept. Executed via Perplexity structured output — the response shape is fixed in code.",
    group: "editorial",
    degrade: "Concept definition generation is skipped; detected terms remain in 'draft' status without a definition.",
    defaultDirective: CONCEPT_DEFINITION_DIRECTIVE,
  },
  {
    key: "concept_verification",
    label: "Concept definition verification (glossary)",
    description: "A separate Perplexity pass that fact-checks a generated definition across four dimensions: meaning correctness, factual support, contextual relevance, and clarity. Only definitions that pass the configured confidence threshold are published live. The response shape is fixed in code.",
    group: "editorial",
    degrade: "Definition verification is skipped; definitions pass directly with their generation confidence (less stringent quality gate).",
    defaultDirective: CONCEPT_VERIFICATION_DIRECTIVE,
  },
  {
    key: "alias_audit",
    label: "Alias conflation audit (glossary)",
    description:
      "Batch-reviews each concept's alias list and flags aliases that name a distinct concept (sibling subtype, broader/narrower topic, opposite) instead of a true synonym. Flagged aliases are removed and, when the named concept exists in the glossary, a 'distinct from' relationship is recorded.",
    group: "editorial",
    degrade:
      "The LLM pass of the alias audit is skipped; only deterministic collisions (alias matching another concept's canonical term, or an alias shared by two concepts) are handled.",
    defaultDirective: ALIAS_AUDIT_DIRECTIVE,
  },
  {
    key: "merge_sweep",
    label: "Merge sweep judge (glossary)",
    description:
      "Confirms whether two glossary entries flagged by the duplicate-detection sweep (matching terms, shared aliases, same Wikipedia page, reordered wording) name the SAME underlying concept. Confirmed duplicates are merged into one entry (mentions, aliases, sources, and Term-of-the-Day history move to the survivor); 'distinct' verdicts are recorded as relationships so the pair is never re-proposed.",
    group: "editorial",
    degrade:
      "The judge pass is skipped; only provable repeats (identical or pluralized canonical terms) are merged, and all other candidate pairs are listed for manual review.",
    defaultDirective: MERGE_SWEEP_DIRECTIVE,
  },
  {
    key: "cluster_reconcile_judge",
    label: "Semantic cluster reconciler (story clusters)",
    description:
      "After each lexical clustering tick, evaluates borderline same-beat cluster pairs (Jaccard similarity 0.08–0.18) to determine whether they cover the same story. Confirmed same-story pairs are merged (smaller cluster absorbed into the larger). Verdicts are cached by keyword hash to avoid redundant re-judging.",
    group: "editorial",
    degrade:
      "Semantic reconciliation is skipped. Borderline cluster pairs remain distinct until they grow apart or converge lexically.",
    defaultDirective:
      "You are a news-editor assistant tasked with deciding whether two story clusters cover the SAME underlying news event or story thread. Two clusters are the SAME STORY if they are independently tracking the same specific event, announcement, incident, or developing situation — even if they use somewhat different vocabulary. They are DISTINCT if they cover genuinely different angles, topics, time periods, or entities that warrant separate editorial treatment. Mark as UNCERTAIN only when you cannot determine this from the provided keywords alone.",
  },
  {
    key: "research_fallback",
    label: "Research fallback (Perplexity stand-in)",
    description:
      "The backup research provider. Whenever a Perplexity call fails, times out, or Perplexity is not configured, the same request re-runs on this Claude model instead (with live web search for search- and research-shaped calls). Perplexity is always tried first — with a healthy Perplexity key this function never runs. This directive is the sourcing brief injected into fallback search/research prompts.",
    group: "editorial",
    degrade:
      "No fallback: when Perplexity is down or unconfigured, every Perplexity-dependent feature (source discovery, gap scanning, hot-topic harvests, research briefings, glossary generation) skips or fails exactly as it did before the fallback existed.",
    defaultDirective: RESEARCH_FALLBACK_DIRECTIVE,
  },
  {
    key: "cross_beat_radar",
    label: "Cross-Beat Radar pitch",
    description:
      "Phrases a deterministic Cross-Beat Radar candidate (a glossary concept bridging two beats, backed by fresh trusted vault sources) into a story title and angle. Candidate selection, evidence gating, and dedupe are all deterministic — this call only writes the pitch. Hard-capped per run. The JSON response shape is fixed in code.",
    group: "writing",
    degrade:
      "No radar suggestions are generated; qualifying bridge candidates are recorded as skipped and picked up by a later run once re-enabled.",
    defaultDirective: CROSS_BEAT_RADAR_DIRECTIVE,
  },
  {
    key: "story_update",
    label: "Story Watch — update article generation",
    description:
      "Generates update-kind articles ('articleKind=update') for watched story clusters when the development signal detector fires a Track A (corroboration) or Track B (authority override) signal. The 'story so far' block is grounded in Source Vault evidence — not in prior article bodies — so framing errors in earlier updates cannot compound forward. Target depth is shaped by the deterministic Update Depth Score before any LLM call is made. Retraction-impacted chains produce conservative stub updates held for editor review.",
    group: "writing",
    degrade:
      "No update articles are generated for watched clusters. Signals still fire and are recorded, but the generation step is skipped. Clusters stay watched; updates resume when re-enabled.",
    defaultDirective: "You are a precise, factual journalist writing a development update. Prioritize clarity and accuracy over style. Ground every claim in the provided vault sources. Do not extrapolate.",
  },  {
    key: "claim_extraction",
    label: "Vault claim extraction",
    description:
      "Extracts reusable, structured claims from reconstructed Source Vault document sections. The source text is already present, so this function never uses web search.",
    group: "editorial",
    degrade:
      "New and backfilled source documents remain searchable as passages, but no claim rows are created while this function is paused.",
    defaultDirective:
      "Extract only claims explicitly grounded in the supplied source section. Return strict JSON, quote the exact evidence verbatim, preserve qualifications, and never infer facts that are not present.",
  },
  {
    key: "claim_reconciliation",
    label: "Vault claim reconciliation",
    description:
      "Classifies the relationship between embedding-near claim pairs after deterministic family and similarity filtering.",
    group: "editorial",
    degrade:
      "Extracted claims remain available individually, but corroboration, qualification, and contradiction relationships are not refreshed.",
    defaultDirective:
      "Compare only the two supplied claims and evidence spans. Classify their relationship conservatively using the allowed relationship types. Do not add outside facts.",
  },
];

const AI_FUNCTION_MAP = new Map<AiFunctionKey, AiFunctionMeta>(AI_FUNCTIONS.map((f) => [f.key, f]));

export function isAiFunctionKey(key: string): key is AiFunctionKey {
  return AI_FUNCTION_MAP.has(key as AiFunctionKey);
}

export function getAiFunctionMeta(key: AiFunctionKey): AiFunctionMeta {
  const meta = AI_FUNCTION_MAP.get(key);
  if (!meta) throw new Error(`Unknown AI function key: ${key}`);
  return meta;
}

export function getDefaultDirective(key: AiFunctionKey): string {
  return getAiFunctionMeta(key).defaultDirective;
}

/**
 * Required `{{TOKEN}}` placeholders that a directive override for `key` must
 * keep so the per-call builder can substitute its dynamic data (image prompts
 * only — writing/editorial directives take no placeholders). Returns the list of
 * required tokens that are MISSING from `directive`, or `[]` when it is valid.
 * An empty/whitespace-only directive is treated as "no override" (the resolver
 * falls back to the default) and so reports no missing tokens.
 */
export function findMissingPlaceholders(key: AiFunctionKey, directive: string): string[] {
  const required = getAiFunctionMeta(key).placeholders ?? [];
  if (required.length === 0) return [];
  if (directive.trim().length === 0) return [];
  return required.filter((token) => !directive.includes(token));
}

/**
 * Prompt-injection scanner for Source Vault documents.
 *
 * Source text ingested from the web is inherently untrusted. A page can embed
 * instruction-override text (white-on-white, hidden divs, appended blobs) that
 * passes Readability extraction and then sits inside an LLM prompt where it can
 * nudge outputs. This module detects the clearest signal patterns before the
 * text is stored so that flagged documents are held as low_quality and excluded
 * from drafting/embedding.
 *
 * Design goals:
 *   - High precision over recall. A false positive → document held as
 *     low_quality (admin can approve via approveLowQuality). A false negative
 *     (missed injection) is worse than an over-quarantined legitimate source.
 *   - Pure function — no I/O, no imports from other services. Testable standalone.
 *   - Fast — all patterns are pre-compiled regexes applied to a capped slice of
 *     the extracted text.
 *
 * Limitations:
 *   - Regex cannot catch every injection variant (adversarial encoding, paraphrasing,
 *     Unicode homoglyphs, multi-chunk injection spread across embeddings). The multiple
 *     independent pipeline stages (authority evaluation, packet construction, claim
 *     verification, quarantine, editorial screens) provide the remaining defence.
 *   - This scanner operates on the Readability-extracted plain-text, not raw HTML.
 *     Active markup is already stripped upstream; this covers what survives into prose.
 */

export interface InjectionScanResult {
  detected: boolean;
  /** The internal name of the first matched pattern, or null when clean. */
  matchedPattern: string | null;
  /** Short human-readable summary for logging / admin display. */
  summary: string | null;
}

/**
 * Each entry covers a distinct injection vector. Patterns are intentionally
 * tight — common false-positive sources (news articles about AI, academic
 * discussion of prompt injection) should not trigger them.
 */
const PATTERNS: { name: string; re: RegExp }[] = [
  // LLM prompt-format control tokens — these almost never appear in legitimate
  // news or reference prose.
  {
    name: "llm_prompt_format_token",
    re: /\[INST\]|<\|im_start\|>|<\|im_end\|>|<\|system\|>|<\|endoftext\|>|<\|user\|>|<\|assistant\|>/i,
  },

  // Direct instruction-override imperative with tight word proximity.
  // Matches: "ignore your instructions", "disregard all previous instructions",
  // "forget your system instructions", "override the previous instructions".
  // Does NOT match: "ignore your doctor's previous instructions to exercise" (too many
  // words between "ignore" and "instructions").
  {
    name: "instruction_override_imperative",
    re: /\b(ignore|disregard|forget|override|bypass)\s+(all\s+)?(your|previous|prior|system|these)\s+(previous\s+|prior\s+)?(instructions?|directives?|prompts?|rules?)\b/i,
  },

  // Persona/role-switch declaration addressed directly at an AI assistant.
  // Matches: "You are now a different AI", "you are now an unrestricted assistant".
  // Tight: requires "you are now" + article + known AI-role noun.
  {
    name: "ai_persona_switch",
    re: /\byou are now (a |an |the )(different|new|unrestricted|helpful|malicious|evil|unfiltered|uncensored|ai|assistant|model|language model|chatbot|bot|agent|gpt|claude|system|tool)\b/i,
  },

  // Markdown/text heading that mimics a system or instruction block at the start
  // of a section. Requires the heading to start with hash(es) or be standalone on
  // a line, with a colon. Extremely rare in legitimate journalism.
  {
    name: "fake_instruction_section_header",
    re: /^#{1,3}\s*(system\s*prompt|override\s*instructions?|new\s*instructions?|assistant\s*instructions?|hidden\s*instructions?)\s*:/im,
  },

  // "Your real/actual/hidden instructions are" — a reframing attack that tries to
  // convince the model its true directives are something else.
  {
    name: "instruction_reframing",
    re: /\byour (real|actual|true|hidden|secret|underlying)\s+(instructions?|system\s*prompt|prompt|directive|goal|purpose)\b.{0,40}(are|is)\b/i,
  },

  // Role-play / DAN-style jailbreak openers that appear at line-start.
  // "Act as [a/an]..." at the very beginning of a sentence is rare in journalism.
  {
    name: "roleplay_jailbreak_opener",
    re: /(^|\n)\s*act\s+as\s+(a |an )(unrestricted|uncensored|evil|malicious|different|new|helpful|alternate)/i,
  },
];

/** Maximum number of characters scanned (injection is usually front-loaded). */
const SCAN_LIMIT = 15_000;

/**
 * Scan extracted source text for prompt-injection signals.
 *
 * Call this on the plain-text output of Readability/document extraction BEFORE
 * storing the document. A `detected: true` result should force the document to
 * `low_quality` status with `prompt_injection_suspected = true` so it is excluded
 * from drafting and embedding pools.
 */
export function scanForPromptInjection(text: string): InjectionScanResult {
  const slice = text.length > SCAN_LIMIT ? text.slice(0, SCAN_LIMIT) : text;
  for (const { name, re } of PATTERNS) {
    if (re.test(slice)) {
      return {
        detected: true,
        matchedPattern: name,
        summary: `Prompt-injection pattern "${name}" detected in source text.`,
      };
    }
  }
  return { detected: false, matchedPattern: null, summary: null };
}

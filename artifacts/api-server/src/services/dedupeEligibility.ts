// --- Dedupe eligibility screening for the Source Vault -------------------
// Production data showed two ways unrelated documents get falsely folded into
// one duplicate family:
//   1. Junk-extraction boilerplate ("Checking your browser - reCAPTCHA",
//      "- YouTube", "Redirecting") is literally identical across failed
//      fetches, so the exact content-hash layer "correctly" matches it and
//      builds giant fake families out of unrelated URLs.
//   2. Thin / nav-heavy extractions clear the shingle-containment bar
//      (|A∩B| / min(|A|,|B|) ≥ 0.5) against real articles because the smaller
//      side has almost no distinct phrases.
// A doc marked duplicate never embeds → it is invisible to retrieval and
// evidence packets, so a false positive silently deletes a real source. The
// screens here are therefore deliberately conservative: a missed true
// duplicate just embeds twice (benign), a false family is catastrophic.
//
// Deliberately logger-free and DB-free (imports only the pure simhash module)
// so it stays trivially unit-testable in isolation.

import { shingleContainment, countShingles } from "./simhash";

/** Minimum words a doc needs before TEXT-based dedupe signals (content hash,
 * SimHash+containment) are trusted. Below this, there isn't enough real text
 * to distinguish "same article" from "same site chrome". */
export const MIN_DEDUPE_WORDS = 120;

/** Junk-titled docs are only treated as junk when they are also short — a real
 * 1,000-word article ABOUT captchas must not be screened out. Mirrors the
 * ingest captcha guard's word cap. */
export const JUNK_TITLE_MAX_WORDS = 300;

/** Minimum distinct 3-word shingles required on BOTH sides before a
 * shingle-containment score is trusted to confirm a near-duplicate. Containment
 * divides by the smaller side, so a thin extraction (site chrome, link lists)
 * can otherwise clear the 0.5 bar against an unrelated article. */
export const MIN_CONTAINMENT_SHINGLES = 40;

/** Containment threshold for confirming a duplicate (shared with ingest). */
export const REPAIR_MIN_CONTAINMENT = 0.5;

// Boilerplate / failed-fetch title patterns. Substring patterns (captcha and
// bot-check pages) plus whole-title patterns (bare "- YouTube", "Redirecting",
// error pages). Junk classification additionally requires a small word count —
// see JUNK_TITLE_MAX_WORDS.
const JUNK_TITLE_RE = new RegExp(
  [
    // Bot checks / captcha walls (substring match anywhere in the title).
    "checking your browser",
    "are you a robot",
    "recaptcha",
    "captcha",
    "just a moment",
    "cloudflare",
    "please verify you are human",
    "verify you are a human",
    "enable javascript",
    "attention required",
    "bot detection",
    "akamai",
    "access denied",
    "access to this page has been denied",
    "page not found",
    "site maintenance",
    "service unavailable",
    "redirect notice",
    "too many redirects",
    // Whole-title boilerplate (anchored so real titles don't match).
    "^\\s*-?\\s*youtube\\s*-?\\s*$",
    "^\\s*redirecting[.\\s]*$",
    "^\\s*untitled\\s*$",
    "^\\s*error\\s*\\d*\\s*$",
    "^\\s*forbidden\\s*$",
    "^\\s*40[134]\\b[^a-z0-9]*\\w*\\s*$",
    "^\\s*50[023]\\b[^a-z0-9]*\\w*\\s*$",
  ].join("|"),
  "i",
);

/**
 * How a document may participate in dedupe:
 * - `junk`: boilerplate extraction (captcha wall, redirect stub, bare
 *   "- YouTube"…). Never enters dedupe at all — cannot match, cannot be
 *   matched, cannot become or demote a family representative.
 * - `thin`: real-looking but too little text for TEXT-based signals. Only the
 *   canonical-URL layer (pure URL identity, no text involved) may match it.
 * - `eligible`: enough real text for all dedupe layers.
 */
export type DedupeScreen = "junk" | "thin" | "eligible";

/** Screen a document for dedupe participation from its title and word count. */
export function screenForDedupe(title: string | null, wordCount: number | null): DedupeScreen {
  const wc = wordCount ?? 0;
  const t = (title ?? "").trim();
  if (JUNK_TITLE_RE.test(t) && wc < JUNK_TITLE_MAX_WORDS) return "junk";
  if (t === "" && wc < MIN_DEDUPE_WORDS) return "junk"; // no title AND no text = failed extraction
  if (wc < MIN_DEDUPE_WORDS) return "thin";
  return "eligible";
}

/** The document facts the repair pass needs to re-verify a duplicate mark. */
export interface RepairDocFacts {
  title: string | null;
  wordCount: number | null;
  extractedText: string | null;
  contentHash: string | null;
  url: string;
  canonicalUrl: string | null;
}

export type RepairVerdict =
  | { keep: true }
  | { keep: false; reason: string; selfJunk: boolean };

/** Two docs refer to the same page when either's canonical URL equals the
 * other's URL or canonical URL. URL identity is independent of extracted text,
 * so it stays trusted even for thin docs (but never for junk ones). */
function sharesCanonicalUrl(a: RepairDocFacts, b: RepairDocFacts): boolean {
  const pairs: Array<[string | null, string | null]> = [
    [a.canonicalUrl, b.url],
    [a.canonicalUrl, b.canonicalUrl],
    [a.url, b.canonicalUrl],
    [a.url, b.url],
  ];
  return pairs.some(([x, y]) => Boolean(x) && Boolean(y) && x === y);
}

/**
 * Re-verify an existing duplicate/superseded mark with the hardened checks the
 * ingest path now uses. Returns `keep: true` only when the pairing survives:
 * junk on either side dissolves; a shared canonical URL keeps (same page);
 * otherwise both sides need enough text, and either an identical content hash
 * or verified phrase overlap (shingle containment with a distinct-shingle
 * floor on both sides). Anything unverifiable dissolves — better to re-embed a
 * rare true duplicate than to keep hiding a unique source from retrieval.
 */
export function decideDupRepair(
  self: RepairDocFacts,
  rep: RepairDocFacts | null,
): RepairVerdict {
  const selfScreen = screenForDedupe(self.title, self.wordCount);
  const selfJunk = selfScreen === "junk";
  if (!rep) {
    return { keep: false, reason: "representative row missing", selfJunk };
  }
  const repScreen = screenForDedupe(rep.title, rep.wordCount);
  if (selfJunk || repScreen === "junk") {
    return {
      keep: false,
      reason: selfJunk ? "junk extraction marked as duplicate" : "representative is a junk extraction",
      selfJunk,
    };
  }
  if (sharesCanonicalUrl(self, rep)) return { keep: true };
  if (selfScreen !== "eligible" || repScreen !== "eligible") {
    return { keep: false, reason: "too little text on one side to verify duplication", selfJunk };
  }
  if (self.contentHash && rep.contentHash && self.contentHash === rep.contentHash) {
    return { keep: true };
  }
  if (self.extractedText && rep.extractedText) {
    const selfShingles = countShingles(self.extractedText);
    const repShingles = countShingles(rep.extractedText);
    if (selfShingles >= MIN_CONTAINMENT_SHINGLES && repShingles >= MIN_CONTAINMENT_SHINGLES) {
      const containment = shingleContainment(self.extractedText, rep.extractedText);
      if (containment >= REPAIR_MIN_CONTAINMENT) return { keep: true };
      return {
        keep: false,
        reason: `phrase overlap too low (containment ${containment.toFixed(2)})`,
        selfJunk,
      };
    }
    return { keep: false, reason: "too few distinct phrases to verify duplication", selfJunk };
  }
  return { keep: false, reason: "extracted text missing on one side", selfJunk };
}

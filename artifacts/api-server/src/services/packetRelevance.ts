import type { PacketSourceRole } from "@workspace/db";

// --- Packet relevance gate + source roles (pure, logger-free, testable) ------
//
// The evidence-packet sufficiency gate used to count sources without checking
// they were about THIS story: topic-adjacent vault matches (same beat, wrong
// case) could lock a packet before the web source scout ever ran, and the
// draft was then generated — and quarantined — against junk evidence.
//
// This module extracts the story's REQUIRED ENTITIES from the idea, decides
// per source whether it is "on-case" (actually mentions the main entity/event)
// and assigns each source an editorial role. Only on-case sources with a
// core role (core_evidence / primary_record) count toward the packet-locking
// gate; off-case sources are kept only as background_only, capped and never
// counted. Everything here is deterministic — no model calls.

export interface RequiredEntities {
  /** Multi-word proper nouns + quoted phrases — the story's specific actors. */
  strong: string[];
  /** Event/legal terms + acronyms — corroborating vocabulary, weak on their own. */
  weak: string[];
}

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "for", "nor", "so", "yet", "of", "in",
  "on", "at", "to", "by", "with", "from", "as", "into", "over", "after",
  "before", "under", "about", "against", "between", "during", "without",
  "why", "how", "what", "when", "where", "who", "which", "that", "this",
  "these", "those", "his", "her", "their", "its", "our", "your", "my",
  "is", "are", "was", "were", "be", "been", "being", "got", "get", "gets",
  "man", "woman", "men", "women", "person", "people", "year", "years",
  "new", "old", "big", "small", "first", "last", "next", "one", "two",
  "it", "he", "she", "they", "we", "you", "i", "not", "no", "out", "up",
]);

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Fraction of words that start with a capital letter (title-case detector). */
function capitalizedRatio(text: string): number {
  const words = text.split(/\s+/).filter((w) => /[a-zA-Z]/.test(w));
  if (words.length === 0) return 0;
  const caps = words.filter((w) => /^[A-Z]/.test(w)).length;
  return caps / words.length;
}

/**
 * Multi-word proper-noun candidates from prose. Strips leading/trailing
 * stopwords from each capitalized run and keeps runs that still have >= 2
 * words (e.g. "Daniel Sanchez Estrada", "Supreme Court").
 */
function properNounCandidates(text: string): string[] {
  const out: string[] = [];
  const runRe = /\b([A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’-]+)+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = runRe.exec(text)) !== null) {
    const words = m[1]!.split(/\s+/);
    let start = 0;
    let end = words.length;
    while (start < end && STOPWORDS.has(words[start]!.toLowerCase())) start++;
    while (end > start && STOPWORDS.has(words[end - 1]!.toLowerCase())) end--;
    const kept = words.slice(start, end);
    if (kept.length >= 2 && kept.some((w) => !STOPWORDS.has(w.toLowerCase()))) {
      out.push(kept.join(" "));
    }
  }
  return out;
}

const EVENT_TERM_RE =
  /\b(ICE|FBI|DOJ|DHS|CBP|ATF|DEA|IRS|CDC|FDA|EPA|FTC|FCC|SEC|NASA|convicted|sentenced|charged|indicted|acquitted|arraigned|obstruction|conspiracy|racketeering|fraud|manslaughter|homicide|protest|arrested|raided|subpoenaed|deported|deportation|detention|extradition|lawsuit|verdict|plea|felony|misdemeanor|zines?|recall(?:ed)?|outbreak|explosion|derailment|wildfire|hurricane|tornado|earthquake|anti-[a-z]+|[A-Z]{3,})\b/g;

/**
 * Extract the story's required entities from its title + angle/brief.
 *
 * Proper-noun extraction is unreliable on Title Case headlines (every word is
 * capitalized), so the title only contributes proper nouns when it is NOT
 * predominantly title-cased; the angle (prose) is always mined. Quoted phrases
 * and event terms are taken from both.
 */
export function extractRequiredEntities(title: string, angle?: string | null): RequiredEntities {
  const combined = `${title} ${angle ?? ""}`;
  const strong = new Set<string>();
  const weak = new Set<string>();

  const quotedRe = /["“”']([^"“”']{3,60})["“”']/g;
  let m: RegExpExecArray | null;
  while ((m = quotedRe.exec(combined)) !== null) {
    const phrase = m[1]!.trim();
    if (phrase.split(/\s+/).length >= 2) strong.add(phrase);
  }

  if (capitalizedRatio(title) < 0.6) {
    for (const c of properNounCandidates(title)) strong.add(c);
  }
  if (angle) {
    for (const c of properNounCandidates(angle)) strong.add(c);
  }

  while ((m = EVENT_TERM_RE.exec(combined)) !== null) {
    const term = m[0]!;
    // An all-caps token that is also part of a strong entity is redundant.
    weak.add(term.toLowerCase());
  }
  // Don't let a strong entity double as its own weak corroboration.
  for (const s of strong) weak.delete(s.toLowerCase());

  return {
    strong: [...strong].slice(0, 8),
    weak: [...weak].slice(0, 12),
  };
}

function countWeakHits(haystack: string, weak: string[]): number {
  let hits = 0;
  for (const term of weak) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${esc}`, "i").test(haystack)) hits++;
  }
  return hits;
}

/**
 * Is this source about THE story (not just the beat)?
 *
 * - No entities extracted at all → pass (generic ideas — "why your brain loves
 *   lists" — have no entities and must not hold forever).
 * - Strong entities exist → any strong mention passes; otherwise a source can
 *   only be rescued by SUBSTANTIAL event-term overlap (>= 3 distinct terms),
 *   so an article about the same case that omits the full name still counts
 *   but a topic-adjacent piece sharing two generic terms does not.
 * - Weak terms only → needs min(2, |weak|) distinct hits.
 */
export function sourceIsOnCase(sourceText: string, entities: RequiredEntities): boolean {
  const { strong, weak } = entities;
  if (strong.length === 0 && weak.length === 0) return true;
  const haystack = normalize(sourceText);
  if (haystack.length === 0) return false;

  if (strong.length > 0) {
    if (strong.some((e) => haystack.includes(normalize(e)))) return true;
    return weak.length >= 3 && countWeakHits(haystack, weak) >= 3;
  }
  return countWeakHits(haystack, weak) >= Math.min(2, weak.length);
}

const PROSECUTION_SIGNAL_RE =
  /\b(justice\.gov|prosecutor|district attorney|attorney general|attorney's office|indictment|doj|police department|sheriff|press release)\b/i;
const ADVOCACY_SIGNAL_RE =
  /\b(aclu|eff\.org|naacp|hrw\.org|amnesty|splcenter|public defender|defense (?:team|attorney|counsel)|advocacy|advocates?|civil (?:rights|liberties) (?:group|organization|union))\b/i;

export interface RoleInput {
  onCase: boolean;
  authorityTier: string | null;
  domain: string;
  title: string | null;
  url: string;
}

/**
 * Deterministic editorial role for a packet source. Off-case sources are
 * always background_only. On-case roles derive from the authority tier with
 * light framing heuristics for official/advocacy voices.
 */
export function assignSourceRole(input: RoleInput): PacketSourceRole {
  if (!input.onCase) return "background_only";
  const tier = input.authorityTier ?? "unknown";
  const signalText = `${input.domain} ${input.url} ${input.title ?? ""}`;

  if (tier === "primary") {
    return PROSECUTION_SIGNAL_RE.test(signalText) ? "prosecution_framing" : "primary_record";
  }
  if (tier === "firsthand") {
    if (PROSECUTION_SIGNAL_RE.test(signalText)) return "prosecution_framing";
    if (ADVOCACY_SIGNAL_RE.test(signalText)) return "defense_or_advocacy_framing";
    return "core_evidence";
  }
  if (tier === "wire" || tier === "reported") {
    return "core_evidence";
  }
  if (tier === "commentary") {
    return ADVOCACY_SIGNAL_RE.test(signalText) ? "defense_or_advocacy_framing" : "reported_context";
  }
  // social / aggregator / reference / unknown
  return "reported_context";
}

/** Roles that count toward the packet-locking gate. */
export const CORE_PACKET_ROLES: ReadonlySet<PacketSourceRole> = new Set([
  "core_evidence",
  "primary_record",
]);

export function isCorePacketRole(role: PacketSourceRole | null | undefined): boolean {
  return !!role && CORE_PACKET_ROLES.has(role);
}

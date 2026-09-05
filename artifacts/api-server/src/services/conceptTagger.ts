// --- Deterministic source-to-concept tagger (Task #338) --------------------
// Pure, logger-free matcher that scans a document's title + extracted text
// against the glossary's concept terms and aliases and emits concept edges
// with a confidence score and matched snippets. NO LLM involved — matching is
// word-boundary, case-insensitive string matching so it costs nothing per
// document and is fully reproducible. Kept free of DB/logger imports so it can
// be unit-tested as a standalone esbuild bundle.

import type { ConceptEdgeMatchedSection } from "@workspace/db";

/** One concept's matchable vocabulary (canonical term + aliases). */
export interface ConceptLexiconEntry {
  conceptId: string;
  /** Canonical display term, e.g. "Cognitive Dissonance". */
  term: string;
  /** Alternate surface forms (plural, abbreviation, synonym). */
  aliases: string[];
}

/** A concept the tagger matched in a document, ready to persist as an edge. */
export interface ConceptTagMatch {
  conceptId: string;
  /** Deterministic 0–1 score from match density + a title-hit boost. */
  confidence: number;
  matchedSections: ConceptEdgeMatchedSection[];
}

// Surface forms shorter than this are never matched: 2–3 letter aliases
// ("did", "ego") collide with ordinary prose far too often to be a signal.
// Multi-word forms are exempt (each extra word already disambiguates).
export const MIN_SURFACE_FORM_LENGTH = 4;

// Cap on recorded matched sections per concept (admin display, not matching).
const MAX_SECTIONS_PER_CONCEPT = 4;

// Snippet radius around the first occurrence (total ~160 chars).
const SNIPPET_RADIUS = 80;

// Confidence model: a title hit is worth a fixed boost (titles are the
// strongest topical signal), text occurrences saturate at TEXT_SATURATION.
const TITLE_BOOST = 0.4;
const TEXT_WEIGHT = 0.6;
const TEXT_SATURATION = 5;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Build a word-boundary, case-insensitive matcher for a surface form.
 * Inner whitespace/hyphens are flexible (`self esteem` matches `self-esteem`),
 * and the boundaries are alphanumeric lookarounds rather than `\b` so terms
 * ending in a non-word char still anchor correctly. Returns null when the form
 * is below the length floor or empty after trimming.
 */
export function buildSurfaceFormRegex(form: string): RegExp | null {
  const trimmed = form.trim();
  if (!trimmed) return null;
  const words = trimmed.split(/[\s-]+/).filter(Boolean);
  if (words.length === 0) return null;
  if (words.length === 1 && trimmed.length < MIN_SURFACE_FORM_LENGTH) return null;
  const pattern = words.map(escapeRegExp).join("[\\s-]+");
  return new RegExp(`(?<![A-Za-z0-9])${pattern}(?![A-Za-z0-9])`, "gi");
}

interface FieldMatch {
  term: string;
  count: number;
  firstIndex: number;
}

/** Count word-boundary occurrences of each surface form within one field. */
function matchField(text: string, forms: string[]): FieldMatch[] {
  const out: FieldMatch[] = [];
  const seen = new Set<string>();
  for (const form of forms) {
    const key = form.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const re = buildSurfaceFormRegex(form);
    if (!re) continue;
    let count = 0;
    let firstIndex = -1;
    for (const m of text.matchAll(re)) {
      if (firstIndex < 0) firstIndex = m.index ?? 0;
      count += 1;
    }
    if (count > 0) out.push({ term: form.trim(), count, firstIndex });
  }
  return out;
}

/** ~160-char snippet centred on the first occurrence, single-line. */
function snippetAround(text: string, index: number): string {
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + SNIPPET_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

/**
 * Scan a document's title + extracted text against the concept lexicon and
 * return one match per concept found. Deterministic: same inputs, same output
 * (ordering is by descending confidence, then concept id for stability).
 */
export function tagDocumentText(
  doc: { title: string | null | undefined; text: string | null | undefined },
  lexicon: ConceptLexiconEntry[],
): ConceptTagMatch[] {
  const title = (doc.title ?? "").trim();
  const text = (doc.text ?? "").trim();
  if (!title && !text) return [];

  const results: ConceptTagMatch[] = [];
  for (const entry of lexicon) {
    const forms = [entry.term, ...entry.aliases];
    const titleMatches = title ? matchField(title, forms) : [];
    const textMatches = text ? matchField(text, forms) : [];
    if (titleMatches.length === 0 && textMatches.length === 0) continue;

    const textCount = textMatches.reduce((n, m) => n + m.count, 0);
    const confidence = Math.min(
      1,
      (titleMatches.length > 0 ? TITLE_BOOST : 0) +
        TEXT_WEIGHT * Math.min(textCount, TEXT_SATURATION) / TEXT_SATURATION,
    );

    const sections: ConceptEdgeMatchedSection[] = [];
    for (const m of titleMatches) {
      if (sections.length >= MAX_SECTIONS_PER_CONCEPT) break;
      sections.push({ field: "title", term: m.term, snippet: snippetAround(title, m.firstIndex), count: m.count });
    }
    for (const m of textMatches) {
      if (sections.length >= MAX_SECTIONS_PER_CONCEPT) break;
      sections.push({ field: "text", term: m.term, snippet: snippetAround(text, m.firstIndex), count: m.count });
    }

    results.push({ conceptId: entry.conceptId, confidence, matchedSections: sections });
  }

  results.sort((a, b) => b.confidence - a.confidence || a.conceptId.localeCompare(b.conceptId));
  return results;
}

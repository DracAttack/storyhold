// --- Concept-aware retrieval planner (Task #338) — PURE half ----------------
// Deterministic helpers that make evidence retrieval concept-aware:
//  1. find which glossary concepts a query (idea title + angle) mentions,
//  2. expand the semantic query with those concepts' aliases + related terms
//     (never distinct_from — those are explicitly NOT the same concept),
//  3. score edge-linked documents with a modest SYNTHETIC similarity so they
//     can join the candidate pool without ever outranking a real semantic hit
//     or satisfying the relevance floor on their own.
// Purely additive: a query that matches no concept produces an empty plan and
// retrieval behaves exactly as before. Kept free of DB/logger imports so it
// can be unit-tested as a standalone esbuild bundle (DB glue: conceptEdges.ts).

import { buildSurfaceFormRegex, type ConceptLexiconEntry } from "./conceptTagger";

/** Cap on expansion terms appended to the semantic query. */
export const MAX_EXPANSION_TERMS = 8;

/** Cap on edge-linked documents blended into the candidate pool. */
export const MAX_EDGE_LINKED_DOCS = 12;

// Synthetic similarity for edge-linked docs: base + a small confidence bonus,
// capped WELL below strong real hits so edge docs join the pool as weak
// candidates. The cap (0.30) also keeps them from dominating ranking; the
// base (0.12) sits below the grounding relevance floor (0.15) so edges alone
// can never make an off-topic query look grounded.
const SYNTHETIC_BASE = 0.12;
const SYNTHETIC_CONFIDENCE_WEIGHT = 0.18;
export const SYNTHETIC_SIMILARITY_CAP = 0.3;

/** Relation types excluded from expansion ("explicitly not the same concept"). */
export const EXCLUDED_RELATION_TYPES = ["distinct_from"] as const;

/**
 * Which lexicon concepts the query text mentions (word-boundary matching,
 * same rules as the document tagger). Order follows the lexicon.
 */
export function findQueryConcepts(
  queryText: string,
  lexicon: ConceptLexiconEntry[],
): ConceptLexiconEntry[] {
  const text = queryText.trim();
  if (!text) return [];
  const out: ConceptLexiconEntry[] = [];
  for (const entry of lexicon) {
    const forms = [entry.term, ...entry.aliases];
    const hit = forms.some((f) => {
      const re = buildSurfaceFormRegex(f);
      return re ? re.test(text) : false;
    });
    if (hit) out.push(entry);
  }
  return out;
}

/**
 * Build the expansion term list: matched concepts' aliases plus related-concept
 * terms, skipping anything already present in the query (word-boundary check),
 * deduped case-insensitively, capped at MAX_EXPANSION_TERMS. Aliases come
 * before related terms so the closest vocabulary wins the cap.
 */
export function buildExpansionTerms(
  queryText: string,
  matched: ConceptLexiconEntry[],
  relatedTerms: string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const pushIfNew = (term: string) => {
    const trimmed = term.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    const re = buildSurfaceFormRegex(trimmed);
    if (!re) return; // below length floor — would add noise, not signal
    if (re.test(queryText)) {
      seen.add(key);
      return; // already in the query
    }
    seen.add(key);
    if (out.length < MAX_EXPANSION_TERMS) out.push(trimmed);
  };
  for (const m of matched) for (const alias of m.aliases) pushIfNew(alias);
  for (const t of relatedTerms) pushIfNew(t);
  return out;
}

/** Synthetic similarity for an edge-linked document (see constants above). */
export function syntheticEdgeSimilarity(confidence: number): number {
  const c = Math.max(0, Math.min(1, confidence));
  return Math.min(SYNTHETIC_SIMILARITY_CAP, SYNTHETIC_BASE + SYNTHETIC_CONFIDENCE_WEIGHT * c);
}

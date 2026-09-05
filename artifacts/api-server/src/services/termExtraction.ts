// Term-extraction pass for source-link candidate gathering (no LLM).
//
// Scours an article's paragraphs for distinct noun phrases / named entities —
// multi-word capitalized runs ("Federal Reserve", "University of Michigan"),
// acronyms (NASA, fMRI), and quoted phrases — so the Source Vault can be
// queried per-term instead of only by title+dek. Each extracted term remembers
// WHICH paragraphs it appears in, letting the caller build a per-paragraph
// candidate map that counteracts the front-loading bias of headline-only
// retrieval.
//
// PURE MODULE: no logger, no DB, no I/O — keep it unit-testable (mirrors
// sourceLinkPolicy.ts).

export interface ExtractedTerm {
  /** The term exactly as it first appeared in the prose. */
  term: string;
  /** 0-based paragraph indexes (into the caller's paragraph array) where it occurs. */
  paragraphIndexes: number[];
  /** Ranking score — occurrences + word-count bonus + depth bonus. */
  score: number;
}

// Words that may glue capitalized words together inside one proper-noun run.
const CONNECTORS = new Set(["of", "the", "and", "for", "in", "on", "de", "la", "von", "van", "at"]);

// Common sentence-leading words that produce false-positive "proper nouns"
// when a capitalized run starts a sentence.
const STOPWORDS = new Set([
  "the", "a", "an", "this", "that", "these", "those", "it", "its", "but", "and",
  "or", "so", "yet", "if", "when", "while", "after", "before", "because", "as",
  "in", "on", "at", "by", "for", "with", "from", "to", "of", "not", "no", "one",
  "we", "you", "they", "he", "she", "i", "there", "here", "what", "why", "how",
  "who", "which", "then", "now", "even", "still", "just", "most", "more", "some",
  "all", "every", "each", "both", "few", "many", "much", "other", "another",
  "new", "first", "last", "next", "researchers", "scientists", "study", "studies",
  "according", "meanwhile", "however", "instead", "despite", "perhaps", "maybe",
  "yes", "read", "imagine", "consider", "think", "picture", "meet", "enter",
]);

// Acronyms too generic to be useful vault queries.
const ACRONYM_BLOCKLIST = new Set(["TV", "US", "USA", "UK", "EU", "AM", "PM", "OK", "CEO", "PDF", "URL", "FAQ", "DIY", "ASAP", "AKA", "ETC", "IT"]);

/** Strip markdown link syntax down to its anchor text, and remove raw URLs. */
function stripMarkup(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[*_`#>]+/g, " ");
}

const CAP_WORD = /^[A-Z][A-Za-z'’.-]*$/;
const ACRONYM = /^[A-Z]{2,6}s?$/;
// Mixed-case technical tokens like fMRI, mRNA, iPhone-style names.
const MIXED_TECH = /^[a-z]{1,3}[A-Z][A-Za-z]{1,10}$/;

function isCapWord(w: string): boolean {
  return CAP_WORD.test(w);
}

/**
 * Extract distinct terms from article paragraphs. Returns terms ranked by
 * score (desc) — occurrences, multi-word specificity, and a depth bonus for
 * terms whose coverage extends past the opening third of the article (the
 * whole point is to surface mid/late-article link opportunities).
 */
export function extractCandidateTerms(paragraphs: string[], opts: { max?: number } = {}): ExtractedTerm[] {
  const max = Math.min(Math.max(opts.max ?? 8, 1), 24);
  const byKey = new Map<string, { term: string; paragraphIndexes: Set<number>; occurrences: number; words: number }>();

  const record = (term: string, paraIdx: number, words: number) => {
    const cleaned = term.replace(/\s+/g, " ").trim().replace(/[.,;:!?]+$/, "");
    if (cleaned.length < 3 || cleaned.length > 80) return;
    const key = cleaned.toLowerCase();
    if (STOPWORDS.has(key)) return;
    const existing = byKey.get(key);
    if (existing) {
      existing.paragraphIndexes.add(paraIdx);
      existing.occurrences += 1;
    } else {
      byKey.set(key, { term: cleaned, paragraphIndexes: new Set([paraIdx]), occurrences: 1, words });
    }
  };

  paragraphs.forEach((raw, paraIdx) => {
    const text = stripMarkup(raw);

    // 1. Quoted phrases (2–8 words) — often paper titles / coined concepts.
    for (const m of text.matchAll(/[“"]([^”"]{6,80})[”"]/g)) {
      const phrase = m[1]!.trim();
      const wc = phrase.split(/\s+/).length;
      if (wc >= 2 && wc <= 8) record(phrase, paraIdx, wc);
    }

    // 2. Capitalized runs & acronyms, token-walking each sentence.
    const sentences = text.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      const tokens = sentence.split(/\s+/).filter(Boolean);
      let run: string[] = [];
      let runStartsAtSentenceStart = false;

      const flush = () => {
        // Drop trailing connectors ("University of" → "University").
        while (run.length > 0 && CONNECTORS.has(run[run.length - 1]!.toLowerCase())) run.pop();
        if (run.length >= 2) {
          // Multi-word runs are near-certain proper nouns even at sentence start,
          // unless the first word is a stopword artifact ("The Federal Reserve"
          // → drop leading "The").
          while (run.length > 1 && STOPWORDS.has(run[0]!.toLowerCase())) run.shift();
          if (run.length >= 2) record(run.join(" "), paraIdx, run.length);
        } else if (run.length === 1) {
          const w = run[0]!.replace(/[.,;:!?]+$/, "");
          const isAcr = ACRONYM.test(w) && !ACRONYM_BLOCKLIST.has(w.replace(/s$/, ""));
          // Single capitalized words only count mid-sentence (not sentence-start
          // capitalization) and only when reasonably specific.
          if (isAcr || (!runStartsAtSentenceStart && isCapWord(w) && w.length >= 5 && !STOPWORDS.has(w.toLowerCase()))) {
            record(w, paraIdx, 1);
          }
        }
        run = [];
      };

      tokens.forEach((tokRaw, ti) => {
        const tok = tokRaw.replace(/^[("'“‘[]+|[)"'”’\]]+$/g, "");
        if (!tok) { flush(); return; }
        const stripped = tok.replace(/[.,;:!?]+$/, "");
        const capish = isCapWord(stripped) || ACRONYM.test(stripped) || MIXED_TECH.test(stripped);
        const connector = run.length > 0 && CONNECTORS.has(stripped.toLowerCase());
        if (capish) {
          if (run.length === 0) runStartsAtSentenceStart = ti === 0;
          run.push(stripped);
          // Punctuation ends the run even if the token was capitalized.
          if (/[.,;:!?]$/.test(tok)) flush();
        } else if (connector) {
          run.push(stripped);
        } else {
          flush();
        }

        // MIXED_TECH singles (fMRI, mRNA) are worth recording on their own.
        if (MIXED_TECH.test(stripped)) record(stripped, paraIdx, 1);
      });
      flush();
    }
  });

  const total = Math.max(paragraphs.length, 1);
  const scored: ExtractedTerm[] = [];
  for (const { term, paragraphIndexes, occurrences, words } of byKey.values()) {
    const idxs = [...paragraphIndexes].sort((a, b) => a - b);
    const deepest = idxs[idxs.length - 1]! / total;
    // Depth bonus: terms living past the first third of the article are the
    // ones headline-only retrieval misses.
    const depthBonus = deepest > 1 / 3 ? 2 : 0;
    const score = occurrences + Math.min(words, 4) + depthBonus;
    scored.push({ term, paragraphIndexes: idxs, score });
  }

  scored.sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
  return scored.slice(0, max);
}

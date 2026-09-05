import { db, beatsTable, articlesTable, sourceIngestQueueTable } from "@workspace/db";
import { isNotNull, eq } from "drizzle-orm";
import { orderedTokens } from "./dedupe";

// --- Deterministic beat classification (Task #235) ---------------------------
// Assigns a source document to its best-fitting beat by lexical similarity
// between the document and each beat's learned vocabulary. Precision-first: a
// wrong beat mis-routes a document into the wrong newsroom pile, which is worse
// than a null beat (null just means "not clustered yet"), so ambiguous docs stay
// null rather than being force-fit.
//
// The classifier is CORPUS-BACKED, not just seeded from beat descriptions: each
// beat's vocabulary is learned from TRUSTWORTHY already-labeled data — published
// articles (filed under their editor-chosen category = beat) and ingest-queue
// rows discovered for a specific beat — with the beat name/description/slant used
// only as a small seed. Crucially it does NOT train on source_documents.beat_slug:
// that column is largely this classifier's own past output, so training on it is
// circular and lets a single early mislabel snowball into a false attractor (an
// early run filed four fusion-energy docs under "history-memory", which then
// started pulling every fusion story into history). Gold labels only.
//
// What makes it exact (and immune to the "big beat wins everything" trap):
//  1. Clean training signal — beat vocabularies are learned from HIGH-SIGNAL
//     fields only (title, dek/excerpt, lead snippet, domain), NEVER full article
//     bodies. Bodies dump hundreds of generic/noise tokens ("chemistry", "2026",
//     "org", "big") into a beat's profile; the beat with the longest bodies then
//     becomes a lint trap that attracts unrelated documents. Titles/deks are the
//     topical signal.
//  2. Cosine similarity, not a raw sum — scoring by cosine normalizes out
//     vocabulary size, so a beat with more labeled documents can't win purely by
//     matching more terms. Fit, not breadth, decides.
//  3. Beat-balanced IDF — a token's document frequency is the number of distinct
//     BEATS whose vocabulary contains it (not the raw document count), so an
//     overrepresented beat cannot punish its own domain-specific vocabulary.
//     idf(t) = log((numBeats + 1) / (beatsContaining + 1)) + 1
//  4. Field weights — a title word is a far stronger clue than a body word.
//  5. Phrase features — 2- and 3-word phrases ("black hole", "gene editing",
//     "large language model") are far more discriminative than their component
//     words, so bigrams/trigrams are indexed alongside unigrams.
//  6. A strict confidence gate — a beat is assigned only when the top score
//     clears a floor, beats the runner-up by a margin, AND is backed by at least
//     a couple of distinctive (high-IDF) supporting terms.
//
// No AI, no network, fully deterministic given the corpus — safe to run inside a
// boot migration and as an ingest-time fallback. Logger-free so it can be pulled
// into a bundled test harness without the pino worker breaking it.

// Confidence gate. Beat profiles are short, clean title/dek vectors while a
// query document carries a noisy body, so absolute cosine sits structurally low
// (~0.1–0.2 even for obvious matches) — the raw score is a weak signal. The
// MARGIN (winner ÷ runner-up) is the reliable, scale-invariant discriminator:
// unambiguous matches clear the field by ~2×+ while lexically-ambiguous docs
// (e.g. fusion energy sharing "solar/energy" with astronomy) cluster near ~1.1–1.4.
// So the floor is deliberately low and the margin does the real work, backed by a
// distinctive-term count so a match can't ride on a couple of generic words.
/** Minimum cosine similarity (0..1) — a low floor to reject near-zero matches. */
const MIN_SCORE = 0.08;
/** Top must beat the runner-up by at least this ratio — the primary gate. */
const MIN_MARGIN_RATIO = 1.6;
/** Winner must be backed by at least this many distinctive (high-IDF) terms. */
const MIN_SUPPORT = 2;
/** IDF at/above which a matched term counts as "distinctive" support. */
const DISTINCTIVE_IDF = 2.0;

/** Field weights — a title word is a much stronger signal than a body word. */
const FIELD_WEIGHTS = {
  title: 4,
  leadSnippet: 3,
  excerpt: 3,
  domain: 2,
  text: 1,
} as const;
/** Beat name/description/slant contribute as a small seed only. */
const SEED_WEIGHT = 1;
/** Cap the body slice so classification stays memory- and time-bounded. */
const BODY_CAP = 2000;
/** Longest phrase (n-gram) indexed as a feature. */
const NGRAM_MAX = 3;
/** Non-topical tokens that carry no beat signal. */
const NOISE_TOKENS = new Set(["com", "org", "net", "www", "http", "https", "html", "amp"]);

export interface ClassifyParts {
  title?: string | null;
  excerpt?: string | null;
  leadSnippet?: string | null;
  text?: string | null;
  domain?: string | null;
}

export interface BeatSource {
  slug: string;
  name: string;
  description: string | null;
  slant: string | null;
}

/** A document with a known beat, used to learn beat vocabularies. */
export interface LabeledDoc extends ClassifyParts {
  beatSlug: string;
}

export interface BeatIndexEntry {
  slug: string;
  /** term -> tf-idf weight (already multiplied by idf) */
  vec: Map<string, number>;
  /** L2 norm of vec, for cosine similarity */
  norm: number;
}

export interface BeatIndex {
  entries: BeatIndexEntry[];
  /** term -> beat-balanced inverse-beat-frequency weight */
  idf: Map<string, number>;
}

export type BeatDecision =
  | "assign"
  | "skip_empty"
  | "skip_low_score"
  | "skip_margin"
  | "skip_support";

export interface BeatClassification {
  /** The assigned beat slug, or null when no beat is a confident fit. */
  slug: string | null;
  /** Top few beats and their cosine scores (descending). */
  scores: { slug: string; score: number }[];
  /** top / runner-up score ratio (Infinity when only one beat matched). */
  margin: number;
  /** The distinctive terms that drove the winner (human-readable). */
  topTerms: string[];
  /** Count of distinctive (high-IDF) supporting terms for the winner. */
  supportCount: number;
  decision: BeatDecision;
}

/** Keep only topical tokens — drop pure numbers (years, counts) and web noise. */
function signalTokens(text: string): string[] {
  return orderedTokens(text).filter((t) => !NOISE_TOKENS.has(t) && !/^\d+$/.test(t));
}

/** Split a field into unigram + bigram + trigram terms, order-preserving. */
function fieldTerms(text: string): string[] {
  const toks = signalTokens(text);
  const out: string[] = toks.slice();
  for (let n = 2; n <= NGRAM_MAX; n += 1) {
    for (let i = 0; i + n <= toks.length; i += 1) {
      out.push(toks.slice(i, i + n).join("_"));
    }
  }
  return out;
}

/**
 * Accumulate field-weighted term frequencies. `includeBody` is false when
 * LEARNING a beat's vocabulary (bodies are too noisy to train on) and true when
 * scoring a query document (body is a weak tiebreak signal).
 */
function weightedTerms(parts: ClassifyParts, includeBody: boolean): Map<string, number> {
  const m = new Map<string, number>();
  const add = (text: string | null | undefined, w: number) => {
    if (!text) return;
    for (const t of fieldTerms(text)) m.set(t, (m.get(t) ?? 0) + w);
  };
  add(parts.title, FIELD_WEIGHTS.title);
  add(parts.leadSnippet, FIELD_WEIGHTS.leadSnippet);
  add(parts.excerpt, FIELD_WEIGHTS.excerpt);
  add((parts.domain ?? "").replace(/[.\-_]+/g, " "), FIELD_WEIGHTS.domain);
  if (includeBody) add((parts.text ?? "").slice(0, BODY_CAP), FIELD_WEIGHTS.text);
  return m;
}

/**
 * Build the corpus-backed, beat-balanced index. `beats` supplies the seed
 * vocabulary (name/description/slant) and the set of valid beats; `labeled`
 * supplies real documents whose beat is already known (bodies are ignored when
 * training). Labels for unknown beats are ignored. Pure and deterministic.
 */
export function buildBeatIndex(beats: BeatSource[], labeled: LabeledDoc[] = []): BeatIndex {
  const profiles = new Map<string, Map<string, number>>();
  const ensure = (slug: string): Map<string, number> => {
    let p = profiles.get(slug);
    if (!p) {
      p = new Map();
      profiles.set(slug, p);
    }
    return p;
  };

  // Seed each beat with its own name/description/slant vocabulary.
  for (const b of beats) {
    const p = ensure(b.slug);
    for (const t of fieldTerms([b.name, b.description ?? "", b.slant ?? ""].join(" "))) {
      p.set(t, (p.get(t) ?? 0) + SEED_WEIGHT);
    }
  }

  // Learn real vocabulary from already-labeled documents — clean fields only.
  for (const d of labeled) {
    if (!profiles.has(d.beatSlug)) continue;
    const p = profiles.get(d.beatSlug)!;
    for (const [t, w] of weightedTerms(d, false)) p.set(t, (p.get(t) ?? 0) + w);
  }

  // Beat-balanced document frequency: how many distinct beats contain a term.
  const numBeats = profiles.size;
  const beatDf = new Map<string, number>();
  for (const p of profiles.values()) {
    for (const t of p.keys()) beatDf.set(t, (beatDf.get(t) ?? 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [t, df] of beatDf) {
    idf.set(t, Math.log((numBeats + 1) / (df + 1)) + 1);
  }

  // Build each beat's tf-idf vector (log-damped tf * idf) and its L2 norm.
  const entries: BeatIndexEntry[] = [];
  for (const [slug, p] of profiles) {
    const vec = new Map<string, number>();
    let sumSq = 0;
    for (const [t, raw] of p) {
      const w = (1 + Math.log(raw)) * (idf.get(t) ?? 0);
      if (w <= 0) continue;
      vec.set(t, w);
      sumSq += w * w;
    }
    entries.push({ slug, vec, norm: Math.sqrt(sumSq) });
  }
  return { entries, idf };
}

/**
 * Classify a document to its best-fitting beat, returning the full decision
 * (cosine scores, margin, decisive terms) for debug logging. Deterministic.
 */
export function classifyBeatDetailed(parts: ClassifyParts, index: BeatIndex): BeatClassification {
  const q = weightedTerms(parts, true);
  // Build the query tf-idf vector.
  const qvec = new Map<string, number>();
  let qSumSq = 0;
  for (const [t, tf] of q) {
    const w = (1 + Math.log(tf)) * (index.idf.get(t) ?? 0);
    if (w <= 0) continue;
    qvec.set(t, w);
    qSumSq += w * w;
  }
  const qNorm = Math.sqrt(qSumSq);
  if (qNorm === 0) {
    return { slug: null, scores: [], margin: 0, topTerms: [], supportCount: 0, decision: "skip_empty" };
  }

  const scored = index.entries.map((e) => {
    if (e.norm === 0) return { slug: e.slug, score: 0, contrib: [], support: 0 };
    let dot = 0;
    const contrib: { term: string; c: number; idf: number }[] = [];
    // Iterate the smaller of the two vectors.
    const [small, big] = qvec.size <= e.vec.size ? [qvec, e.vec] : [e.vec, qvec];
    for (const [t, wv] of small) {
      const ov = big.get(t);
      if (ov === undefined) continue;
      const c = wv * ov;
      dot += c;
      contrib.push({ term: t, c, idf: index.idf.get(t) ?? 0 });
    }
    contrib.sort((a, b) => b.c - a.c);
    const support = contrib.filter((x) => x.idf >= DISTINCTIVE_IDF).length;
    return { slug: e.slug, score: dot / (qNorm * e.norm), contrib, support };
  });
  scored.sort((a, b) => b.score - a.score);

  const top = scored[0];
  const secondScore = scored[1]?.score ?? 0;
  const scores = scored.slice(0, 3).map((s) => ({ slug: s.slug, score: s.score }));
  const margin = secondScore > 0 ? top.score / secondScore : Infinity;
  const topTerms = top.contrib.slice(0, 6).map((x) => x.term.replace(/_/g, " "));

  let decision: BeatDecision;
  if (top.score < MIN_SCORE) decision = "skip_low_score";
  else if (top.score < MIN_MARGIN_RATIO * secondScore) decision = "skip_margin";
  else if (top.support < MIN_SUPPORT) decision = "skip_support";
  else decision = "assign";

  return {
    slug: decision === "assign" ? top.slug : null,
    scores,
    margin,
    topTerms,
    supportCount: top.support,
    decision,
  };
}

/** Classify a document to its best-fitting beat slug, or null when uncertain. */
export function classifyBeat(parts: ClassifyParts, index: BeatIndex): string | null {
  return classifyBeatDetailed(parts, index).slug;
}

/** Extract a bare host from a URL for use as a weak domain signal. */
export function domainFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Load the trustworthy labeled corpus used to learn beat vocabularies: published
 * articles (filed under their editor-chosen category = beat) and ingest-queue
 * rows discovered for a specific beat. Deliberately EXCLUDES
 * source_documents.beat_slug — that is largely this classifier's own past output,
 * so training on it is circular. Bounded so it stays cheap.
 */
export async function loadLabeledCorpus(): Promise<LabeledDoc[]> {
  const out: LabeledDoc[] = [];

  const arts = await db
    .select({
      beatSlug: articlesTable.categorySlug,
      title: articlesTable.title,
      excerpt: articlesTable.dek,
    })
    .from(articlesTable)
    .where(eq(articlesTable.status, "published"))
    .orderBy(articlesTable.id)
    .limit(4000);
  for (const a of arts) {
    if (!a.beatSlug) continue;
    out.push({ beatSlug: a.beatSlug, title: a.title, excerpt: a.excerpt });
  }

  const queued = await db
    .select({
      beatSlug: sourceIngestQueueTable.beatSlug,
      leadSnippet: sourceIngestQueueTable.leadSnippet,
      url: sourceIngestQueueTable.url,
    })
    .from(sourceIngestQueueTable)
    .where(isNotNull(sourceIngestQueueTable.beatSlug))
    .orderBy(sourceIngestQueueTable.id)
    .limit(4000);
  for (const q of queued) {
    if (!q.beatSlug) continue;
    out.push({ beatSlug: q.beatSlug, leadSnippet: q.leadSnippet, domain: domainFromUrl(q.url) });
  }

  return out;
}

// Small in-process cache so ingest-time classification doesn't rebuild the
// corpus on every document. The taxonomy + corpus change slowly; a short TTL
// keeps admin edits and freshly-labeled docs picked up without a restart.
let cached: { index: BeatIndex; at: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Load (and cache) the corpus-backed beat index. */
export async function loadBeatIndex(): Promise<BeatIndex> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.index;
  const [rows, labeled] = await Promise.all([
    db
      .select({
        slug: beatsTable.slug,
        name: beatsTable.name,
        description: beatsTable.description,
        slant: beatsTable.slant,
      })
      .from(beatsTable),
    loadLabeledCorpus(),
  ]);
  const index = buildBeatIndex(rows, labeled);
  cached = { index, at: now };
  return index;
}

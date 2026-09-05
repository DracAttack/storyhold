// --- 64-bit SimHash for near-duplicate text detection --------------------
// Charikar SimHash over word shingles. Two documents whose SimHashes differ by
// only a few bits (small Hamming distance) are near-duplicates — the standard
// signal for syndicated / reprinted articles. Deliberately ZERO-import (its own
// tokenizer + a fast 64-bit FNV-1a hash) so it stays trivially unit-testable in
// isolation, with no DB/logger import chain. Represented as a 16-char lowercase
// hex string so it fits a plain text column.

const MASK64 = (1n << 64n) - 1n;

/** FNV-1a 64-bit hash of a token, returned as a BigInt in [0, 2^64). */
function fnv1a64(token: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < token.length; i++) {
    hash ^= BigInt(token.charCodeAt(i) & 0xff);
    // charCodeAt can exceed a byte; fold the high byte in too for stability.
    hash = (hash * 0x100000001b3n) & MASK64;
    hash ^= BigInt((token.charCodeAt(i) >> 8) & 0xff);
    hash = (hash * 0x100000001b3n) & MASK64;
  }
  return hash & MASK64;
}

/** Lowercase alphanumeric word tokens. Self-contained (no shared tokenizer). */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * Compute the 64-bit SimHash of a text as a 16-char hex string. Uses word-level
 * (unigram, bag-of-words) features: this is robust for detecting syndicated
 * reprints and light rewrites — a handful of swapped words shifts only a few
 * bits, while genuinely different articles land tens of bits apart. Word-shingle
 * features were tried but proved over-sensitive (a 3-word edit moved ~9 bits).
 * Empty/near-empty text yields "0000000000000000".
 */
export function simhash64(text: string): string {
  const feats = tokenize(text);
  if (feats.length === 0) return "0".repeat(16);

  // Per-bit signed accumulator.
  const bits = new Array<number>(64).fill(0);
  for (const f of feats) {
    const h = fnv1a64(f);
    for (let b = 0; b < 64; b++) {
      if ((h >> BigInt(b)) & 1n) bits[b]! += 1;
      else bits[b]! -= 1;
    }
  }

  let result = 0n;
  for (let b = 0; b < 64; b++) {
    if (bits[b]! > 0) result |= 1n << BigInt(b);
  }
  return result.toString(16).padStart(16, "0");
}

/** Hamming distance (number of differing bits) between two hex SimHashes. */
export function hammingDistance(a: string, b: string): number {
  let x = (BigInt("0x" + a) ^ BigInt("0x" + b)) & MASK64;
  let count = 0;
  while (x > 0n) {
    x &= x - 1n; // clear the lowest set bit
    count++;
  }
  return count;
}

/**
 * Whether two SimHashes are near-duplicates. Default threshold of 6 bits over 64
 * catches syndicated reprints and light rewrites (measured ~3 bits) while staying
 * far below the tens-of-bits distance of genuinely different articles.
 *
 * IMPORTANT: a SimHash match alone is NOT sufficient evidence of duplication.
 * Unigram bag-of-words SimHash converges on long English prose (common words
 * dominate the per-bit vote), so unrelated long articles can land within a few
 * bits of each other — in production this falsely marked hundreds of unrelated
 * documents as duplicates. Always confirm a SimHash candidate with
 * `shingleContainment` on the actual texts before treating it as a duplicate.
 */
export function isNearDuplicate(a: string, b: string, maxDistance = 6): boolean {
  if (!a || !b) return false;
  if (a === "0".repeat(16) || b === "0".repeat(16)) return false;
  return hammingDistance(a, b) <= maxDistance;
}

/** Distinct word-level 3-shingles of a text (order-sensitive phrase features). */
function shingleSet(text: string, n = 3): Set<string> {
  const tokens = tokenize(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= tokens.length; i++) {
    out.add(tokens.slice(i, i + n).join(" "));
  }
  return out;
}

/**
 * Containment similarity between two texts over distinct 3-word shingles:
 * |A ∩ B| / min(|A|, |B|), in [0, 1]. Containment (not Jaccard) so a syndicated
 * excerpt fully contained in a longer original still scores ~1. Genuinely
 * different articles share almost no exact 3-word phrases (score ≈ 0), while a
 * reprint or light rewrite keeps most phrasing intact (score near 1). Used as
 * the verification gate behind SimHash candidate matching. Returns 0 when
 * either text is too short to form a shingle.
 */
export function shingleContainment(a: string, b: string): number {
  const sa = shingleSet(a);
  const sb = shingleSet(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  let shared = 0;
  for (const s of small) if (large.has(s)) shared++;
  return shared / small.size;
}

/**
 * Number of distinct word-level 3-shingles in a text. Used as a floor before
 * trusting `shingleContainment`: containment divides by the SMALLER side, so a
 * thin extraction (site chrome, nav links) can clear a high containment score
 * against an unrelated article purely because it has almost no phrases of its
 * own. Callers should require a minimum distinct-shingle count on both sides.
 */
export function countShingles(text: string, n = 3): number {
  return shingleSet(text, n).size;
}

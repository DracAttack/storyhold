/**
 * Deterministic SEO title/description derivation, shared by the client SPA
 * (`useSeo` calls) and the production meta-injecting server so both emit
 * identical `<title>` / description tags for crawlers and social scrapers.
 *
 * Pure functions only — NO React or DOM imports — so the Node server can import
 * this module without pulling in browser-only code.
 */

/** Target length for the document/OG/Twitter title (before "| BrainHook"). */
export const SEO_TITLE_MAX = 55;
/** Description clamp window: keep within [MIN, MAX] characters when deriving. */
export const SEO_DESCRIPTION_MIN = 120;
export const SEO_DESCRIPTION_MAX = 155;

/** Collapse whitespace and trim. Returns "" for null/undefined. */
function normalize(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Truncate at a word boundary so the result never exceeds `max` characters.
 * When `ellipsis` is true and the text was cut, a trailing "…" is appended
 * (and the budget is reserved so the final string still fits within `max`).
 */
function truncateAtWord(text: string, max: number, ellipsis: boolean): string {
  if (text.length <= max) return text;
  const budget = ellipsis ? max - 1 : max;
  const slice = text.slice(0, budget);
  const lastSpace = slice.lastIndexOf(" ");
  // Prefer a word boundary, but fall back to a hard cut for a single very long
  // word so we never return an empty/near-empty string.
  const cut = lastSpace > budget * 0.5 ? slice.slice(0, lastSpace) : slice;
  const trimmed = cut.replace(/[\s,;:.!?-]+$/, "");
  return ellipsis ? `${trimmed}…` : trimmed;
}

/** The four headline surfaces a hook mode can be assigned to. */
export type HookSurface = "h1" | "seoTitle" | "social" | "newsletter";

/** Structural shape of a stored hook variant (mode + its headline text). */
export interface HookVariantLike {
  mode: string;
  text: string;
}

/** Structural shape of the mode→surface assignment map. */
export interface HookAssignmentsLike {
  h1?: string | null;
  seoTitle?: string | null;
  social?: string | null;
  newsletter?: string | null;
}

/**
 * Resolve the assigned hook text for a given surface: look up the mode assigned
 * to that surface and return the matching variant's text. Returns undefined when
 * variants/assignments are absent, the surface is unassigned, or the matching
 * variant has no text — so callers cleanly fall back to today's behavior.
 */
export function resolveHookText(
  variants: HookVariantLike[] | null | undefined,
  assignments: HookAssignmentsLike | null | undefined,
  surface: HookSurface,
): string | undefined {
  if (!variants || variants.length === 0 || !assignments) return undefined;
  const mode = assignments[surface];
  if (!mode) return undefined;
  const variant = variants.find((v) => v.mode === mode);
  const text = normalize(variant?.text);
  return text || undefined;
}

/**
 * Resolve the document/OG/Twitter title (WITHOUT the "| BrainHook" suffix — the
 * callers append the brand). Priority: the assigned hook text, then the editor
 * override, then a concise title (≤~55 chars, trimmed at a word boundary, no
 * ellipsis) derived from the full headline. The hook/override are trusted as
 * deliberate copy and returned as-is; only the headline fallback is truncated.
 * The visible H1 always stays the full headline.
 */
export function resolveSeoTitle(
  headline: string,
  override?: string | null,
  hookText?: string | null,
): string {
  const h = normalize(hookText);
  if (h) return h;
  const o = normalize(override);
  if (o) return o;
  return truncateAtWord(normalize(headline), SEO_TITLE_MAX, false);
}

/**
 * Resolve the social share title (og:title / twitter:title). Priority: the
 * assigned social hook text, then the full headline. Social titles aren't
 * length-clamped — platforms wrap or truncate them in their own cards.
 */
export function resolveSocialTitle(
  headline: string,
  hookText?: string | null,
): string {
  const h = normalize(hookText);
  if (h) return h;
  return normalize(headline);
}

/**
 * Trim a run of dangling whitespace and clause punctuation (commas, dashes,
 * semicolons, colons) from the end of a string — but KEEP a terminal sentence
 * ender (`.`/`!`/`?`) so a complete sentence stays complete.
 */
function trimDangling(s: string): string {
  return s.replace(/[\s,;:—–-]+$/, "").trim();
}

/**
 * Clamp an over-long description so it reads as a COMPLETE thought within `max`
 * characters — never a mid-sentence cut with a trailing "…" (which shows up
 * verbatim in search results and looks unfinished).
 *
 * Strategy, in order:
 *  1. Greedily keep as many whole sentences as fit (preferred — a true sentence).
 *  2. Otherwise cut at the latest natural boundary within budget (sentence ender,
 *     then a strong clause break like — – ; :, then a comma, then a word break),
 *     so the result ends on a self-contained clause with no ellipsis.
 */
function clampToCompleteThought(text: string, max: number, min: number): string {
  if (text.length <= max) return text;

  // 1) Accumulate whole sentences while they fit.
  const sentences = text.match(/[^.!?]+[.!?]+(?:["'”’)\]]+)?\s*/g) ?? [];
  let acc = "";
  for (const sentence of sentences) {
    const next = acc + sentence;
    if (next.trim().length <= max) acc = next;
    else break;
  }
  acc = acc.trim();
  if (acc.length >= min) return acc;

  // 2) No substantial whole-sentence prefix — cut at the best boundary in budget.
  const window = text.slice(0, max);
  const strong: number[] = []; // sentence enders + strong clause breaks
  const weak: number[] = []; // commas
  for (let i = 0; i < window.length; i++) {
    const ch = window[i];
    if (".!?;:—–".includes(ch)) strong.push(i + 1);
    else if (ch === ",") weak.push(i + 1);
  }
  const latest = (positions: number[], floor: number): number => {
    let best = -1;
    for (const p of positions) if (p >= floor && p <= max) best = p;
    return best;
  };
  const half = Math.floor(max * 0.5);
  let cut = latest(strong, min);
  if (cut < 0) cut = latest(strong, half);
  if (cut < 0) cut = latest(weak, half);
  if (cut < 0) {
    const lastSpace = window.lastIndexOf(" ");
    cut = lastSpace > half ? lastSpace : window.length;
  }
  return trimDangling(window.slice(0, cut));
}

/**
 * Resolve the meta/OG/Twitter (and JSON-LD) description. Uses the editor
 * override when non-blank, else derives one from `source` (the dek for
 * articles, the beat description for categories). Derived descriptions are
 * clamped to a COMPLETE thought within ≤155 chars (whole sentences when they
 * fit, otherwise a clean clause boundary) — never a mid-sentence cut with a
 * trailing ellipsis. Returns undefined when there is no override and no source.
 */
export function resolveSeoDescription(
  source: string | null | undefined,
  override?: string | null,
): string | undefined {
  const o = normalize(override);
  if (o) return o;
  const s = normalize(source);
  if (!s) return undefined;
  return clampToCompleteThought(s, SEO_DESCRIPTION_MAX, SEO_DESCRIPTION_MIN);
}

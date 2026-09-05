// --- Per-feed keyword filter --------------------------------------------
// A PURE predicate that decides whether a feed item survives a feed's optional
// keyword filter. Lets a BROAD feed be narrowed to relevant topics without a
// parallel filtering engine: an item passes only if it matches at least one
// include term (empty include list = allow all) AND matches none of the exclude
// terms. Matching is case-insensitive substring against the item's title +
// summary text. No network, no DB, no logger — kept unit-testable in isolation.

/** The subset of a feed's config the keyword filter needs. */
export interface KeywordFilterConfig {
  includeTerms?: string[] | null;
  excludeTerms?: string[] | null;
}

/** The subset of a parsed item the keyword filter reads. */
export interface FilterableItem {
  title: string | null;
  summary?: string | null;
}

/** Lowercase, trim, and drop empty/whitespace-only terms. */
function normalizeTerms(terms: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of terms) {
    if (typeof raw !== "string") continue;
    const t = raw.trim().toLowerCase();
    if (t.length > 0) out.push(t);
  }
  return out;
}

/**
 * Decide whether an item passes a feed's keyword filter.
 *
 * - Include terms: if any are configured, the item must contain at least one.
 *   An empty include list means "no include constraint" (allow all).
 * - Exclude terms: if the item contains any, it is rejected (exclude wins over
 *   include).
 *
 * A feed with no include and no exclude terms passes everything (the default,
 * so existing feeds behave exactly as before).
 */
export function feedItemPassesFilter(item: FilterableItem, filter: KeywordFilterConfig): boolean {
  const includeTerms = normalizeTerms(filter.includeTerms ?? []);
  const excludeTerms = normalizeTerms(filter.excludeTerms ?? []);

  // Fast path: no filter configured → everything passes.
  if (includeTerms.length === 0 && excludeTerms.length === 0) return true;

  const haystack = `${item.title ?? ""} ${item.summary ?? ""}`.toLowerCase();

  if (excludeTerms.some((term) => haystack.includes(term))) return false;
  if (includeTerms.length > 0 && !includeTerms.some((term) => haystack.includes(term))) return false;

  return true;
}

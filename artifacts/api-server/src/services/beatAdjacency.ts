/**
 * Beat adjacency taxonomy.
 *
 * Every author has a PRIMARY beat plus optional sub-beats. Without a guard,
 * sub-beats can be set to anything, which let writers drift into unrelated
 * territory (e.g. a political-science author publishing climate-physics or
 * neurochemistry pieces). This map defines, per beat slug, the set of OTHER
 * beats that are close enough to be a credible sub-beat for a writer anchored
 * in that primary beat.
 *
 * The map is treated as UNDIRECTED: it is symmetrised at load time, so if A
 * lists B then B is automatically adjacent to A even if the literal entry was
 * only written once.
 *
 * NOTE: adjacency is NO LONGER a live gate on admin-curated sub-beats. The
 * author admin routes and runtime beat resolution use {@link normalizeSubBeats}
 * (de-dupe + drop primary, no adjacency filter) so an admin's explicit pick is
 * authoritative. {@link filterAdjacentSubBeats} now only seeds brand-new authors
 * and powers the one-time re-curation migration.
 */

/** Raw adjacency declarations (slug → neighbouring slugs). Symmetrised below. */
const BEAT_ADJACENCY_RAW: Record<string, string[]> = {
  "astronomy-universe": [
    "earth-climate",
    "hidden-science-everyday",
    "science-history",
    "weird-creepy",
    "technology-future",
  ],
  "earth-climate": [
    "astronomy-universe",
    "hidden-science-everyday",
    "gross-science",
    "science-history",
  ],
  "money-psychology-habits": [
    "psychology-behavior",
    "relationships-communication",
    "political-science",
    "technology-future",
  ],
  "gross-science": [
    "hidden-science-everyday",
    "brain-health-longevity",
    "weird-creepy",
    "earth-climate",
  ],
  "hidden-science-everyday": [
    "astronomy-universe",
    "earth-climate",
    "gross-science",
    "technology-future",
    "science-history",
    "weird-creepy",
  ],
  "brain-health-longevity": [
    "psychology-behavior",
    "gross-science",
    "relationships-communication",
  ],
  "political-science": [
    "money-psychology-habits",
    "psychology-behavior",
    "technology-future",
    "science-history",
  ],
  "psychology-behavior": [
    "brain-health-longevity",
    "relationships-communication",
    "money-psychology-habits",
    "political-science",
  ],
  "relationships-communication": [
    "psychology-behavior",
    "brain-health-longevity",
    "money-psychology-habits",
    "technology-future",
  ],
  "science-history": [
    "astronomy-universe",
    "earth-climate",
    "hidden-science-everyday",
    "technology-future",
    "political-science",
    "weird-creepy",
  ],
  "technology-future": [
    "hidden-science-everyday",
    "science-history",
    "political-science",
    "money-psychology-habits",
    "relationships-communication",
    "astronomy-universe",
  ],
  "weird-creepy": [
    "gross-science",
    "hidden-science-everyday",
    "science-history",
    "astronomy-universe",
  ],
};

/** Symmetrised adjacency: slug → Set of adjacent slugs (both directions). */
const ADJACENCY: Map<string, Set<string>> = (() => {
  const map = new Map<string, Set<string>>();
  const ensure = (slug: string): Set<string> => {
    let set = map.get(slug);
    if (!set) {
      set = new Set<string>();
      map.set(slug, set);
    }
    return set;
  };
  for (const [slug, neighbours] of Object.entries(BEAT_ADJACENCY_RAW)) {
    const set = ensure(slug);
    for (const n of neighbours) {
      if (n === slug) continue;
      set.add(n);
      ensure(n).add(slug); // undirected: keep both sides consistent
    }
  }
  return map;
})();

/** True if `slug` is a recognised beat in the adjacency taxonomy. */
export function isKnownBeat(slug: string): boolean {
  return ADJACENCY.has(slug);
}

/**
 * True if `candidate` is an acceptable sub-beat for an author whose PRIMARY beat
 * is `mainSlug`. A beat is never adjacent to itself. If the primary beat is not
 * in the taxonomy we fail OPEN (return true) so an author on an unmapped/new
 * beat is never silently stripped of all sub-beats.
 */
export function isAdjacentBeat(mainSlug: string, candidate: string): boolean {
  if (candidate === mainSlug) return false;
  const set = ADJACENCY.get(mainSlug);
  if (!set) return true; // unknown primary beat → don't enforce
  return set.has(candidate);
}

/**
 * Filter a list of sub-beat slugs down to only those adjacent to `mainSlug`,
 * preserving order and dropping duplicates and the primary beat itself. Returns
 * the input (minus the primary/dupes) unchanged when `mainSlug` is unmapped, so
 * the rule only ever TRIMS known beats and never blocks new ones.
 */
export function filterAdjacentSubBeats(
  mainSlug: string,
  subSlugs: readonly string[] | null | undefined,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>([mainSlug]);
  for (const slug of subSlugs ?? []) {
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    if (isAdjacentBeat(mainSlug, slug)) out.push(slug);
  }
  return out;
}

/**
 * Clean a list of sub-beat slugs WITHOUT applying the adjacency taxonomy:
 * de-duplicates, preserves order, and drops empty slugs and the primary beat
 * itself (you can't sub-beat yourself). This is the normalisation used for
 * admin-curated sub-beats and runtime beat resolution — an admin explicitly
 * assigning a sub-beat is the editorial authority, so we honour their pick
 * even when it isn't "adjacent" to the primary beat. The adjacency map is now
 * only used by the one-time re-curation migration, not as a live gate.
 */
export function normalizeSubBeats(
  mainSlug: string,
  subSlugs: readonly string[] | null | undefined,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>([mainSlug]);
  for (const slug of subSlugs ?? []) {
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

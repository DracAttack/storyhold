import {
  db,
  authorsTable,
  articlesTable,
  topicIdeasTable,
  type Author,
} from "@workspace/db";
import { and, eq, gte, inArray, sql } from "drizzle-orm";

// --- Variety-aware author assignment ----------------------------------------
// Shared ranking used by EVERY automated author-decision point (cockpit
// promote, Trend Radar scout + draft/send-to-ideas, bulk beat idea generation,
// custom-idea auto-pick). It replaces the old "primary-beat authors always
// win" tiering: sub-beat coverage is a genuine qualification, so primary and
// sub-beat coverers compete in ONE pool, and the deciding signal is recent
// WORKLOAD — the writer with the fewest recent assignments (articles started
// in the last RECENT_WINDOW_DAYS plus their current approved-idea bank) ranks
// first. Primary-beat fit only breaks ties, then name for determinism.
//
// This both spreads work across the desk (the variety the editor asked for)
// and still prevents the historical pile-up failure mode (a sub-beat writer
// collecting three pieces in one night because his idea bank happened to be
// smallest): every assignment immediately increases the writer's recent load,
// sinking them for the next pick.

const RECENT_WINDOW_DAYS = 14;

export interface RankedAuthor {
  author: Author;
  /** The target beat is this writer's PRIMARY beat (vs sub-beat coverage). */
  primaryFit: boolean;
  /** Articles started in the recent window + current approved-idea bank. */
  recentLoad: number;
}

/**
 * Rank the active writers covering `beatSlug` (primary OR sub-beat, one pool)
 * for a new assignment, lightest recent workload first. Pass `beatSlug: null`
 * to rank a whole roster by workload when there is no target beat (e.g. the
 * custom-idea auto-pick). `opts.authors` skips the roster fetch when the
 * caller already holds it. Returns [] when nobody covers the beat.
 */
export async function rankCoveringAuthors(
  beatSlug: string | null,
  opts: { authors?: Author[] } = {},
): Promise<RankedAuthor[]> {
  const roster =
    opts.authors ??
    ((await db.select().from(authorsTable).where(eq(authorsTable.active, true))) as Author[]);
  const pool = beatSlug
    ? roster.filter(
        (a) => a.categorySlug === beatSlug || (a.subBeats ?? []).includes(beatSlug),
      )
    : roster;
  if (pool.length === 0) return [];

  const ids = pool.map((a) => a.id);
  const cutoff = new Date(Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [articleRows, ideaRows] = await Promise.all([
    db
      .select({ authorId: articlesTable.authorId, n: sql<number>`count(*)::int` })
      .from(articlesTable)
      .where(and(inArray(articlesTable.authorId, ids), gte(articlesTable.createdAt, cutoff)))
      .groupBy(articlesTable.authorId),
    db
      .select({ authorId: topicIdeasTable.authorId, n: sql<number>`count(*)::int` })
      .from(topicIdeasTable)
      .where(and(inArray(topicIdeasTable.authorId, ids), eq(topicIdeasTable.status, "approved")))
      .groupBy(topicIdeasTable.authorId),
  ]);
  const load = new Map<string, number>();
  for (const r of articleRows) load.set(r.authorId, (load.get(r.authorId) ?? 0) + Number(r.n));
  for (const r of ideaRows) {
    if (r.authorId) load.set(r.authorId, (load.get(r.authorId) ?? 0) + Number(r.n));
  }

  return pool
    .map((author) => ({
      author,
      primaryFit: beatSlug != null && author.categorySlug === beatSlug,
      recentLoad: load.get(author.id) ?? 0,
    }))
    .sort(
      (a, b) =>
        a.recentLoad - b.recentLoad ||
        Number(b.primaryFit) - Number(a.primaryFit) ||
        a.author.name.localeCompare(b.author.name),
    );
}

/**
 * Build the candidate shape `pickBestAuthorForIdea` expects from a ranked
 * pool, carrying the workload + fit context so the LLM picker can weigh
 * variety (not just fit) and the prompt can tell the model the list is
 * ordered lightest-loaded first.
 */
export function toRankedPickCandidates(
  ranked: RankedAuthor[],
  slugToName: Map<string, string>,
) {
  return ranked.map((r) => ({
    id: r.author.id,
    name: r.author.name,
    category: r.author.category,
    bio: r.author.bio,
    voicePrompt: r.author.voicePrompt,
    subBeatNames: (r.author.subBeats ?? []).map((s) => slugToName.get(s) ?? s),
    recentLoad: r.recentLoad,
    primaryFit: r.primaryFit,
  }));
}

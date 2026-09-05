// --- Cross-Beat Radar — DB/LLM glue + run job (Task #340) --------------------
// Walks the bridge concepts (from the beat-affinity profiles), runs the pure
// gate pipeline in crossBeatRadar.ts against each concept's trusted vault
// evidence, and for the top qualifying candidates makes ONE cheap LLM call to
// phrase the pitch, dedupe-checks it against existing coverage, creates a
// PENDING topic idea for the lightest-loaded covering writer, and records the
// suggestion row.
//
// Idempotency & memory: cross_beat_radar_suggestions.dedupe_key
// (concept + sorted top beat pair) is claimed per suggestion. Rows with
// status pending/dismissed — and skips with PERMANENT reasons (overlap,
// llm_refusal) — are never retried; transient skips (author capacity, AI
// paused, LLM error) are retried on later runs via upsert.

import {
  db,
  conceptsTable,
  crossBeatRadarSuggestionsTable,
  sourceConceptEdgesTable,
  sourceDocumentsTable,
  topicIdeasTable,
  beatsTable,
  type CrossBeatRadarSuggestion,
} from "@workspace/db";
import { and, eq, gte, inArray } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "../lib/logger";
import { resolveDirective, isAiFunctionEnabled, resolveModel } from "./aiSettings";
import { recordTextUsage } from "./aiUsage";
import { extractBalancedJson } from "./researchFallback";
import { listBridgeConcepts } from "./conceptBeatAffinityJob";
import { findOverlappingArticles, findOverlappingIdeas } from "./dedupe";
import { rankCoveringAuthors } from "./authorAssignment";
import { countApprovedIdeas, getApprovedIdeaCap } from "./articles";
import {
  evaluateRadarCandidate,
  applyOverlapGate,
  radarDedupeKey,
  RADAR_MIN_EDGE_CONFIDENCE,
  RADAR_MAX_SUGGESTIONS_PER_RUN,
  RADAR_OVERLAP_THRESHOLD,
  type RadarEvidenceDoc,
} from "./crossBeatRadar";

export interface CrossBeatRadarSummary {
  bridgeConcepts: number;
  candidatesEvaluated: number;
  suggestionsCreated: number;
  skipped: number;
}

// Skip reasons that are permanent (never retried). Everything else is
// transient and the dedupe row is retried (upserted) on a later run.
const PERMANENT_SKIP_REASONS = new Set(["overlap", "llm_refusal"]);

// In-process run claim (single-server assumption). Claimed synchronously
// BEFORE the first await so concurrent POSTs can't both start a run.
let radarRunInFlight = false;

export function isCrossBeatRadarRunning(): boolean {
  return radarRunInFlight;
}

/** Trusted-evidence load for a set of concepts (edge-confidence gated). */
async function loadEvidenceByConcept(
  conceptIds: string[],
): Promise<Map<string, RadarEvidenceDoc[]>> {
  const out = new Map<string, RadarEvidenceDoc[]>();
  if (conceptIds.length === 0) return out;
  const rows = await db
    .select({
      conceptId: sourceConceptEdgesTable.conceptId,
      docId: sourceDocumentsTable.id,
      url: sourceDocumentsTable.url,
      tier: sourceDocumentsTable.authorityTier,
      familyId: sourceDocumentsTable.sourceFamilyId,
      publishedAt: sourceDocumentsTable.publishedAt,
      fetchedAt: sourceDocumentsTable.fetchedAt,
      createdAt: sourceDocumentsTable.createdAt,
    })
    .from(sourceConceptEdgesTable)
    .innerJoin(
      sourceDocumentsTable,
      eq(sourceConceptEdgesTable.sourceDocumentId, sourceDocumentsTable.id),
    )
    .where(
      and(
        inArray(sourceConceptEdgesTable.conceptId, conceptIds),
        gte(sourceConceptEdgesTable.confidence, RADAR_MIN_EDGE_CONFIDENCE),
        eq(sourceDocumentsTable.lifecycleStatus, "active"),
      ),
    );
  for (const row of rows) {
    const list = out.get(row.conceptId) ?? [];
    list.push({
      docId: row.docId,
      url: row.url,
      tier: row.tier,
      familyId: row.familyId,
      newestAt: row.publishedAt ?? row.fetchedAt ?? row.createdAt,
    });
    out.set(row.conceptId, list);
  }
  return out;
}

interface RadarPitch {
  title: string;
  angle: string;
  // Explicit editorial refusal from the model ("this material can't support a
  // pitch"). Permanent skip. Distinct from `incomplete` — a malformed or
  // truncated response — which is a TECHNICAL failure and must stay retryable.
  refusal: string | null;
  incomplete: boolean;
  // 1-based indexes (into the supplied source list) the model cited as
  // backing the angle. Empty for refusals/incomplete responses.
  supportingIndexes: number[];
}

/** What each source contributes to the grounding block of the prompt. */
export interface RadarPitchSource {
  url: string;
  tier: string;
  title: string | null;
  publishedAt: Date | null;
  excerpt: string | null;
}

/** One cheap phrasing call. Throws on API failure; refusal comes back typed. */
async function phrasePitch(input: {
  term: string;
  definition: string;
  beatNames: string[];
  evidence: RadarPitchSource[];
}): Promise<RadarPitch> {
  const directive = await resolveDirective("cross_beat_radar");
  const model = await resolveModel("cross_beat_radar");
  const shown = input.evidence.slice(0, 8);
  const sourceList = shown
    .map((e, i) => {
      const bits = [`${i + 1}. [${e.tier}] ${e.title ?? e.url}`];
      if (e.publishedAt) bits.push(`   Published: ${e.publishedAt.toISOString().slice(0, 10)}`);
      if (e.excerpt) bits.push(`   Excerpt: ${e.excerpt}`);
      return bits.join("\n");
    })
    .join("\n");
  const prompt = `${directive}

Concept: ${input.term}${input.definition ? `\nDefinition: ${input.definition}` : ""}
The two beats to blend: ${input.beatNames.join(" + ")}

Fresh trusted sources backing this concept (numbered — cite by number):
${sourceList}

Respond with ONLY a JSON object:
{ "title": "<punchy magazine headline blending the two beats through the concept>", "angle": "<2-3 sentences: the specific cross-beat angle, grounded ONLY in what the numbered sources above actually say — what makes this crossover interesting now>", "supportingSources": [<the source numbers that directly back the angle — at least one>], "refusal": null }
The angle must be supportable by the listed sources; do not invent facts beyond them.
If the material cannot honestly support a compelling cross-beat pitch, respond with { "title": "", "angle": "", "supportingSources": [], "refusal": "<one short sentence why>" }.`;
  const message = await anthropic.messages.create(
    {
      model,
      max_tokens: 700,
      temperature: 0.7,
      messages: [{ role: "user", content: prompt }],
    },
    { timeout: 60_000 },
  );
  recordTextUsage({ operation: "crossBeatRadarPitch", model, message });
  const block = message.content[0];
  const text = block && block.type === "text" ? block.text : "";
  let parsed: Partial<RadarPitch> & { supportingSources?: unknown };
  try {
    parsed = extractBalancedJson<Partial<RadarPitch> & { supportingSources?: unknown }>(text);
  } catch {
    // Unparseable output is a technical failure, not an editorial refusal.
    return { title: "", angle: "", refusal: null, incomplete: true, supportingIndexes: [] };
  }
  const refusal =
    typeof parsed.refusal === "string" && parsed.refusal.trim() ? parsed.refusal.trim() : null;
  const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
  const angle = typeof parsed.angle === "string" ? parsed.angle.trim() : "";
  const supportingIndexes = Array.isArray(parsed.supportingSources)
    ? parsed.supportingSources
        .filter((n): n is number => typeof n === "number" && Number.isInteger(n))
        .filter((n) => n >= 1 && n <= shown.length)
    : [];
  if (refusal) return { title: "", angle: "", refusal, incomplete: false, supportingIndexes: [] };
  // Missing fields or zero valid citations = incomplete (retryable), NOT a
  // refusal — a weak attempt must not permanently blacklist the pairing.
  if (!title || !angle || supportingIndexes.length === 0) {
    return { title, angle, refusal: null, incomplete: true, supportingIndexes };
  }
  return { title, angle, refusal: null, incomplete: false, supportingIndexes };
}

/**
 * Pick the lightest-loaded writer covering the primary beat who still has
 * approved-idea headroom. Deterministic — no LLM. Null when nobody fits.
 */
export async function pickRadarAuthor(
  primaryBeatSlug: string,
): Promise<{ id: string; name: string } | null> {
  const ranked = await rankCoveringAuthors(primaryBeatSlug);
  const cap = await getApprovedIdeaCap();
  for (const r of ranked) {
    const approved = await countApprovedIdeas(r.author.id);
    if (approved < cap) return { id: r.author.id, name: r.author.name };
  }
  return null;
}

type UpsertableSuggestion = {
  conceptId: string;
  conceptTerm: string;
  conceptSlug: string;
  dedupeKey: string;
  primaryBeatSlug: string;
  secondaryBeatSlugs: string[];
  title: string;
  angle: string;
  score: number;
  bridgeBeats: Array<{ beatSlug: string; weight: number }>;
  evidenceSnapshot: Array<{ docId: string; url: string; tier: string; familyId: string | null }>;
  status: "pending" | "skipped";
  skipReason: string | null;
  ideaId: string | null;
};

/**
 * Grounding material for the pitch prompt — titles, dates, and a short
 * excerpt per doc so the model can actually read what it's citing (URLs
 * alone are opaque to it). Fetched only for the docs of paid candidates.
 */
async function loadPitchGrounding(
  docIds: string[],
): Promise<Map<string, { title: string | null; publishedAt: Date | null; excerpt: string | null }>> {
  const out = new Map<string, { title: string | null; publishedAt: Date | null; excerpt: string | null }>();
  if (docIds.length === 0) return out;
  const rows = await db
    .select({
      id: sourceDocumentsTable.id,
      title: sourceDocumentsTable.title,
      publishedAt: sourceDocumentsTable.publishedAt,
      leadSnippet: sourceDocumentsTable.leadSnippet,
      extractedText: sourceDocumentsTable.extractedText,
    })
    .from(sourceDocumentsTable)
    .where(inArray(sourceDocumentsTable.id, docIds));
  for (const row of rows) {
    const raw = (row.leadSnippet?.trim() || row.extractedText?.trim() || "").replace(/\s+/g, " ");
    out.set(row.id, {
      title: row.title?.trim() || null,
      publishedAt: row.publishedAt,
      excerpt: raw ? raw.slice(0, 400) : null,
    });
  }
  return out;
}

type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Insert-or-retry: transient skips are overwritten; settled rows untouched. */
async function upsertSuggestion(
  row: UpsertableSuggestion,
  now: Date,
  executor: DbExecutor = db,
): Promise<void> {
  await executor
    .insert(crossBeatRadarSuggestionsTable)
    .values({ ...row, updatedAt: now })
    .onConflictDoUpdate({
      target: crossBeatRadarSuggestionsTable.dedupeKey,
      set: {
        title: row.title,
        angle: row.angle,
        score: row.score,
        bridgeBeats: row.bridgeBeats,
        evidenceSnapshot: row.evidenceSnapshot,
        status: row.status,
        skipReason: row.skipReason,
        ideaId: row.ideaId,
        updatedAt: now,
      },
      // Only retryable rows get overwritten: transient skips. Pending,
      // dismissed, and permanently-skipped rows are settled memory.
      setWhere: and(
        eq(crossBeatRadarSuggestionsTable.status, "skipped"),
        inArray(
          crossBeatRadarSuggestionsTable.skipReason,
          TRANSIENT_SKIP_REASONS_FOR_SQL,
        ),
      ),
    });
}

// Transient reasons must be enumerable for the setWhere filter.
const TRANSIENT_SKIP_REASONS_FOR_SQL = ["author_capacity", "ai_paused", "llm_error"];

/**
 * One radar run: gate all bridge concepts, pitch the top candidates (bounded
 * by RADAR_MAX_SUGGESTIONS_PER_RUN paid calls), create pending ideas.
 */
export async function runCrossBeatRadar(now: Date = new Date()): Promise<CrossBeatRadarSummary> {
  const summary: CrossBeatRadarSummary = {
    bridgeConcepts: 0,
    candidatesEvaluated: 0,
    suggestionsCreated: 0,
    skipped: 0,
  };

  const bridges = await listBridgeConcepts();
  summary.bridgeConcepts = bridges.length;
  if (bridges.length === 0) return summary;

  const [existing, beatRows, concepts] = await Promise.all([
    db
      .select({
        dedupeKey: crossBeatRadarSuggestionsTable.dedupeKey,
        status: crossBeatRadarSuggestionsTable.status,
        skipReason: crossBeatRadarSuggestionsTable.skipReason,
      })
      .from(crossBeatRadarSuggestionsTable),
    db.select({ slug: beatsTable.slug, name: beatsTable.name }).from(beatsTable),
    loadConceptDefinitions(bridges.map((b) => b.conceptId)),
  ]);
  const beatNameBySlug = new Map(beatRows.map((b) => [b.slug, b.name]));
  const settledKeys = new Set(
    existing
      .filter(
        (r) =>
          r.status !== "skipped" ||
          (r.skipReason != null && PERMANENT_SKIP_REASONS.has(r.skipReason)),
      )
      .map((r) => r.dedupeKey),
  );

  const evidenceByConcept = await loadEvidenceByConcept(bridges.map((b) => b.conceptId));

  // Gate everything first (pure, free), then rank by score.
  const passing: Array<{
    bridge: (typeof bridges)[number];
    dedupeKey: string;
    trustedDocs: RadarEvidenceDoc[];
    score: number;
  }> = [];
  for (const bridge of bridges) {
    const topPair = bridge.beats.slice(0, 2).map((b) => b.beatSlug);
    const dedupeKey = radarDedupeKey(bridge.conceptId, topPair);
    if (settledKeys.has(dedupeKey)) continue;
    summary.candidatesEvaluated += 1;
    const result = evaluateRadarCandidate(
      {
        conceptId: bridge.conceptId,
        term: bridge.term,
        slug: bridge.slug,
        beats: bridge.beats,
        evidence: evidenceByConcept.get(bridge.conceptId) ?? [],
      },
      now,
    );
    if (!result.passed) continue; // gate failures are free retries next run
    passing.push({ bridge, dedupeKey, trustedDocs: result.trustedDocs, score: result.score });
  }
  passing.sort((a, b) => b.score - a.score || a.bridge.term.localeCompare(b.bridge.term));

  const aiEnabled = await isAiFunctionEnabled("cross_beat_radar");

  let paidCalls = 0;
  for (const candidate of passing) {
    if (paidCalls >= RADAR_MAX_SUGGESTIONS_PER_RUN) break;
    const { bridge, dedupeKey, trustedDocs, score } = candidate;
    const topPair = bridge.beats.slice(0, 2);
    const primaryBeatSlug = topPair[0]!.beatSlug;
    const secondaryBeatSlugs = topPair.slice(1).map((b) => b.beatSlug);
    const evidenceSnapshot = trustedDocs.slice(0, 12).map((d) => ({
      docId: d.docId,
      url: d.url,
      tier: d.tier,
      familyId: d.familyId,
    }));
    const base: Omit<UpsertableSuggestion, "status" | "skipReason" | "ideaId" | "title" | "angle"> = {
      conceptId: bridge.conceptId,
      conceptTerm: bridge.term,
      conceptSlug: bridge.slug,
      dedupeKey,
      primaryBeatSlug,
      secondaryBeatSlugs,
      score,
      bridgeBeats: bridge.beats.map((b) => ({ beatSlug: b.beatSlug, weight: b.weight })),
      evidenceSnapshot,
    };
    const skip = async (skipReason: string) => {
      summary.skipped += 1;
      await upsertSuggestion(
        { ...base, title: "", angle: "", status: "skipped", skipReason, ideaId: null },
        now,
      );
    };

    if (!aiEnabled) {
      await skip("ai_paused");
      continue;
    }

    // Author capacity BEFORE the paid call.
    const author = await pickRadarAuthor(primaryBeatSlug);
    if (!author) {
      await skip("author_capacity");
      continue;
    }

    // Paid pitch call (counts against the per-run cap regardless of outcome).
    paidCalls += 1;
    const pitchDocs = evidenceSnapshot.slice(0, 8);
    let pitch: RadarPitch;
    try {
      const grounding = await loadPitchGrounding(pitchDocs.map((d) => d.docId));
      pitch = await phrasePitch({
        term: bridge.term,
        definition: concepts.get(bridge.conceptId) ?? "",
        beatNames: topPair.map((b) => beatNameBySlug.get(b.beatSlug) ?? b.beatSlug),
        evidence: pitchDocs.map((e) => {
          const g = grounding.get(e.docId);
          return {
            url: e.url,
            tier: e.tier,
            title: g?.title ?? null,
            publishedAt: g?.publishedAt ?? null,
            excerpt: g?.excerpt ?? null,
          };
        }),
      });
    } catch (err) {
      logger.warn({ err, concept: bridge.slug }, "crossBeatRadar: pitch call failed");
      await skip("llm_error");
      continue;
    }
    if (pitch.incomplete) {
      // Technical failure (malformed/truncated/uncited response) — transient,
      // retried on a later run. Must NOT be recorded as a permanent refusal.
      logger.warn({ concept: bridge.slug }, "crossBeatRadar: incomplete pitch response");
      await skip("llm_error");
      continue;
    }
    if (pitch.refusal) {
      await skip("llm_refusal");
      continue;
    }
    // Mark which snapshot docs the model cited as backing the angle.
    const supportingDocIds = new Set(
      pitch.supportingIndexes.map((n) => pitchDocs[n - 1]?.docId).filter(Boolean),
    );
    const citedSnapshot = evidenceSnapshot.map((e) =>
      supportingDocIds.has(e.docId) ? { ...e, supporting: true } : e,
    );

    // Gate 4 — overlap vs existing coverage, on the REAL pitched title/angle.
    const [articleHits, ideaHits] = await Promise.all([
      findOverlappingArticles(pitch.title, pitch.angle, { threshold: RADAR_OVERLAP_THRESHOLD }),
      findOverlappingIdeas(pitch.title, pitch.angle, { threshold: RADAR_OVERLAP_THRESHOLD }),
    ]);
    const gated = applyOverlapGate(
      { passed: true, failedGate: null, trustedDocs, independentFamilies: 0, score },
      articleHits.length + ideaHits.length,
    );
    if (!gated.passed) {
      await skip("overlap");
      continue;
    }

    // Create the pending idea + suggestion row atomically — if the suggestion
    // upsert fails, the idea must not survive orphaned (a future run would
    // then create a duplicate; same pattern as coverage-map promote).
    const primaryBeatName = beatNameBySlug.get(primaryBeatSlug) ?? primaryBeatSlug;
    await db.transaction(async (tx) => {
      const [idea] = await tx
        .insert(topicIdeasTable)
        .values({
          authorId: author.id,
          title: pitch.title,
          angle: pitch.angle,
          category: primaryBeatName,
          categorySlug: primaryBeatSlug,
          secondaryBeats: secondaryBeatSlugs,
          status: "pending",
          notes: `From Cross-Beat Radar: "${bridge.term}" bridges ${topPair
            .map((b) => beatNameBySlug.get(b.beatSlug) ?? b.beatSlug)
            .join(" + ")} with ${trustedDocs.length} trusted sources across ${new Set(
            trustedDocs.map((d) => d.familyId ?? d.docId),
          ).size} independent families.`,
        })
        .returning({ id: topicIdeasTable.id });
      await upsertSuggestion(
        {
          ...base,
          evidenceSnapshot: citedSnapshot,
          title: pitch.title,
          angle: pitch.angle,
          status: "pending",
          skipReason: null,
          ideaId: idea?.id ?? null,
        },
        now,
        tx,
      );
    });
    summary.suggestionsCreated += 1;
  }

  return summary;
}

/** Definitions for the pitch prompt (hover definition is short + canonical). */
async function loadConceptDefinitions(conceptIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (conceptIds.length === 0) return out;
  const rows = await db
    .select({ id: conceptsTable.id, definition: conceptsTable.hoverDefinition })
    .from(conceptsTable)
    .where(inArray(conceptsTable.id, conceptIds));
  for (const row of rows) out.set(row.id, row.definition);
  return out;
}

/**
 * Start a radar run (admin trigger + cron tick). Claims the in-process slot
 * synchronously; returns started=false when a run is already in flight. The
 * work runs in an unawaited promise — callers 202 immediately.
 */
export function startCrossBeatRadarRun(): { started: boolean } {
  if (radarRunInFlight) return { started: false };
  radarRunInFlight = true;

  void (async () => {
    try {
      const summary = await runCrossBeatRadar();
      logger.info(summary, "crossBeatRadar: run complete");
    } catch (err) {
      logger.error({ err }, "crossBeatRadar: run failed");
    } finally {
      radarRunInFlight = false;
    }
  })();

  return { started: true };
}

export type { CrossBeatRadarSuggestion };

import {
  db,
  sourceDocumentsTable,
  sourceChunksTable,
  sourceVaultJobsTable,
  articleSourcesTable,
  articlesTable,
  vaultClaimsTable,
  claimExtractionReceiptsTable,
  type SourceDocument,
  type SourceChunk,
  type SourceVaultJob,
  type SourceAuthorityTier,
  type SourceLifecycleStatus,
  type SourceDocStatus,
  type ArticleSourceRole,
  type ArticleSourceStatus,
} from "@workspace/db";
import { and, asc, desc, eq, gt, ilike, ne, or, isNull, isNotNull, inArray, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { scheduleClaimExtraction } from "./claimExtraction";
import { scanForPromptInjection } from "./promptInjectionGuard";
import { cascadeSourceRetraction } from "./retractionCascade";
import { createHash } from "node:crypto";
import {
  fetchAndExtract,
  extractFromDocumentBytes,
  checkRobots,
  QUALITY_THRESHOLD,
  UnsafeUrlError,
  FetchError,
  classifyRecheck,
  resolveCanonicalUrl,
  type RecheckOutcome,
  type ExtractedSource,
} from "./sourceFetch";
import { detectDocumentType, DocumentExtractionError } from "./documentExtract";
import { simhash64, hammingDistance, shingleContainment, countShingles } from "./simhash";
import { screenForDedupe, MIN_CONTAINMENT_SHINGLES, type DedupeScreen } from "./dedupeEligibility";
import { classifyAuthority, isMetadataOnlySource, isReviewArticleTitle } from "./sourceAuthority";
import {
  AUTHORITY_RANK,
  computeRepresentativeScore,
  decideRepresentative,
  type RepScoreInput,
  type RepresentativeScore,
} from "./representativeScore";
import { chunkText } from "./sourceChunk";
import { classifyBeat, loadBeatIndex } from "./beatClassifier";
import { tagSourceDocumentConcepts } from "./conceptEdges";
import {
  isPerplexityConfigured,
  PerplexityNotConfiguredError,
  type SearchLead,
} from "./perplexity";
import { searchWithFallback } from "./researchFallback";
import {
  embedTexts,
  isEmbeddingConfigured,
  isEmbeddingPaid,
  embeddingProvider,
  EmbeddingNotConfiguredError,
} from "./embeddings";
import {
  VaultBudgetGuard,
  VaultBudgetExceededError,
  isSourceVaultEnabled,
  getTodayVaultSpendUsd,
  VAULT_DAILY_BUDGET_USD,
  VAULT_RUN_BUDGET_USD,
} from "./sourceVaultBudget";

// --- Source Vault orchestration (Phase 0 spike) --------------------------
// Ties the pieces together: discover (Perplexity search) → fetch+extract (SSRF
// safe) → quality gate → chunk → embed (pluggable provider) → store vectors,
// plus semantic retrieval over the stored chunks. Discovery and embedding are
// gated independently (isPerplexityConfigured for search, isEmbeddingConfigured
// for embed/retrieve); paid paths are bounded by the VaultBudgetGuard (free/
// local embedding is gated only by the kill-switch). When a capability is
// unavailable, operations degrade cleanly (documents are stored as
// low_quality/extracted/held rather than crashing).

const EMBED_BATCH_SIZE = 16;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Serialize a vector to the pgvector text literal `[a,b,c]`. */
function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

// Near-duplicate SimHash cutoff (bits over 64) — see simhash.ts for calibration.
const SIMHASH_NEAR_DUP_BITS = 6;
// SimHash is only a prefilter (unigram SimHash converges on long prose, see
// simhash.ts); a candidate must be confirmed with ≥ this much distinct 3-word
// shingle containment on the actual texts to count as a duplicate. Reprints and
// light rewrites score near 1.0; unrelated articles score ≈ 0.
const SIMHASH_VERIFY_MIN_CONTAINMENT = 0.5;
// Cap the number of candidate texts fetched per incoming doc (closest-first).
const SIMHASH_VERIFY_MAX_CANDIDATES = 5;
// A representative scan bound: comparing an incoming doc against every stored
// representative is linear; cap it so ingestion stays predictable on a large
// vault. Foundation-level (no ANN index); revisit if the vault grows huge.
const DEDUP_SCAN_LIMIT = 5000;
// Default freshness horizon: a document is eligible to be marked `stale` this
// many days after it was last fetched, unless the source specifies otherwise.
const DEFAULT_STALE_AFTER_DAYS = 180;

/** Resolve the authority tier for a doc, preserving any manual override.
 * Pass the FULL URL (not just the host) whenever available so path-based
 * classifier rules (opinion sections, index pages, show pages) apply.
 * Pass `title` and `excerpt` so review-article signals (systematic review,
 * meta-analysis, etc.) in either the title or abstract can downgrade a
 * primary-tier domain to `reported`. */
function resolveAuthority(
  existing: SourceDocument | null,
  urlOrDomain: string,
  title?: string | null,
  excerpt?: string | null,
): { authorityTier: SourceAuthorityTier; authoritySource: "auto" | "manual"; authorityReason: string } {
  if (existing && existing.authoritySource === "manual") {
    return {
      authorityTier: existing.authorityTier,
      authoritySource: "manual",
      authorityReason: existing.authorityReason ?? "manual override",
    };
  }
  const c = classifyAuthority(urlOrDomain);
  // Academic review articles synthesise prior literature — they are not
  // original experimental research. Downgrade primary-classified docs whose
  // title or excerpt/abstract contains review signals (systematic review,
  // meta-analysis, etc.) to `reported`, so they are not displayed as "Primary source".
  if (c.tier === "primary" && (title || excerpt) && isReviewArticleTitle(title ?? "", excerpt)) {
    return {
      authorityTier: "reported",
      authoritySource: "auto",
      authorityReason: `review article (title/abstract signals literature synthesis) from ${c.reason}`,
    };
  }
  return { authorityTier: c.tier, authoritySource: "auto", authorityReason: c.reason };
}

/** The dedup decision for an incoming document. */
interface DedupPlan {
  duplicateOfId: string | null;
  dedupeReason: string | null;
  sourceFamilyId: string | null;
  /** When set, this existing representative must be demoted under the incoming. */
  demoteRepId: string | null;
}

/**
 * Decide whether an incoming document duplicates an existing one, and which of
 * the pair should be the family representative. Detection is layered, strongest
 * signal first: (1) identical content hash, (2) shared canonical URL, (3) near-
 * duplicate SimHash (syndication / light rewrite). Representative choice is
 * authority-first, quality-second via decideRepresentative: a strictly higher
 * tier wins (the "wire penalty" for syndicated copies), same-tier ties are
 * broken by the composite representative score, and a one-tier-lower challenger
 * can rescue a family whose representative is materially defective
 * (`demoteRepId` re-points a previously-stored weaker representative under the
 * incoming). Non-duplicates start their own family (id assigned by the caller).
 */
async function planDedup(params: {
  selfId: string;
  contentHash: string;
  contentSimhash: string;
  /** Extracted title of the incoming doc — used by the junk/boilerplate
   * screen (captcha walls, redirect stubs share identical text and would
   * otherwise hash-match into giant fake families). */
  title: string | null;
  /** Full extracted text of the incoming doc — used to VERIFY SimHash
   * candidates with real phrase overlap before accepting a duplicate. */
  extractedText: string;
  canonicalUrl: string | null;
  authorityTier: SourceAuthorityTier;
  /** Incoming doc facts for the score comparison (chunk count excluded — the
   * incoming doc hasn't been embedded yet, so chunks would rig the contest). */
  incoming: Omit<RepScoreInput, "authorityTier" | "canonicalUrl" | "chunkCount">;
}): Promise<DedupPlan> {
  const { selfId, contentHash, contentSimhash, extractedText, canonicalUrl, authorityTier } = params;

  // Eligibility screen (see dedupeEligibility.ts): junk extractions (captcha
  // walls, redirect stubs, bare "- YouTube" pages) never enter dedupe at all —
  // they can't match, can't be matched, and can't become or demote a family
  // representative. Thin docs (too few words for text signals) may only match
  // via the canonical-URL layer, which is pure URL identity.
  const selfScreen = screenForDedupe(params.title, params.incoming.wordCount);
  if (selfScreen === "junk") {
    return { duplicateOfId: null, dedupeReason: null, sourceFamilyId: null, demoteRepId: null };
  }

  // Quality floor: below-bar docs (about to be held as low_quality, never
  // embedded) sit out dedupe entirely — they must not join families, become
  // representatives, or demote real docs. Skipping dedupe here also lets the
  // caller reach the quality hold (a doc marked duplicate returns early with
  // status "extracted", which would dodge the low_quality hold and leave a
  // below-bar doc eligible for the re-embed sweep if its family later
  // dissolves).
  if (params.incoming.qualityScore < QUALITY_THRESHOLD) {
    return { duplicateOfId: null, dedupeReason: null, sourceFamilyId: null, demoteRepId: null };
  }

  // Candidate representatives: never compare against self or against docs that
  // are already duplicates (we only cluster under representatives). Docs held
  // as failed/low_quality are excluded from the pool — they are not in
  // retrieval, so clustering under them hides a good doc behind a bad rep.
  const reps = await db
    .select({
      id: sourceDocumentsTable.id,
      url: sourceDocumentsTable.url,
      canonicalUrl: sourceDocumentsTable.canonicalUrl,
      title: sourceDocumentsTable.title,
      contentHash: sourceDocumentsTable.contentHash,
      contentSimhash: sourceDocumentsTable.contentSimhash,
      authorityTier: sourceDocumentsTable.authorityTier,
      authoritySource: sourceDocumentsTable.authoritySource,
      sourceFamilyId: sourceDocumentsTable.sourceFamilyId,
      domain: sourceDocumentsTable.domain,
      qualityScore: sourceDocumentsTable.qualityScore,
      wordCount: sourceDocumentsTable.wordCount,
      chunkCount: sourceDocumentsTable.chunkCount,
      extractionMethod: sourceDocumentsTable.extractionMethod,
      publishedAt: sourceDocumentsTable.publishedAt,
      paywallDetected: sourceDocumentsTable.paywallDetected,
      excerptOnly: sourceDocumentsTable.excerptOnly,
      status: sourceDocumentsTable.status,
      lifecycleStatus: sourceDocumentsTable.lifecycleStatus,
    })
    .from(sourceDocumentsTable)
    .where(
      and(
        ne(sourceDocumentsTable.id, selfId),
        isNull(sourceDocumentsTable.duplicateOfId),
        ne(sourceDocumentsTable.status, "failed"),
        ne(sourceDocumentsTable.status, "low_quality"),
      ),
    )
    .limit(DEDUP_SCAN_LIMIT);

  const repScreens = new Map<string, DedupeScreen>(
    reps.map((r) => [r.id, screenForDedupe(r.title, r.wordCount)]),
  );

  const match = await (async () => {
    // 1) Exact content hash — only trusted when BOTH sides pass the full text
    // screen. Identical boilerplate ("Checking your browser…", "Redirecting")
    // is literally the same text without being the same article; in prod this
    // built a 41-member fake family out of unrelated captcha-blocked URLs.
    if (selfScreen === "eligible" && contentHash) {
      for (const r of reps) {
        if (r.contentHash && r.contentHash === contentHash && repScreens.get(r.id) === "eligible") {
          return { rep: r, reason: "identical content (same content hash)" };
        }
      }
    }
    // 2) Shared canonical URL (either direction) — URL identity, no text
    // involved, so thin docs may still match here. Junk reps stay excluded so
    // a real doc can never be attached under a junk-extraction family.
    if (canonicalUrl) {
      for (const r of reps) {
        if (repScreens.get(r.id) === "junk") continue;
        if (r.url === canonicalUrl || (r.canonicalUrl && r.canonicalUrl === canonicalUrl)) {
          return { rep: r, reason: "shares canonical URL" };
        }
      }
    }
    // 3) Near-duplicate SimHash (syndicated copy / light rewrite) — but ONLY as
    // a cheap prefilter. Unigram SimHash CONVERGES on long English prose
    // (common words dominate the bit votes), so unrelated articles routinely
    // land within the bit threshold — in prod this falsely marked hundreds of
    // unrelated docs as duplicates, silently keeping them out of retrieval.
    // Every SimHash candidate must therefore be CONFIRMED by real phrase
    // overlap (distinct 3-word shingle containment) on the actual texts before
    // it is accepted as a duplicate — and containment itself is only trusted
    // when BOTH texts clear a distinct-shingle floor (containment divides by
    // the smaller side, so a thin nav-heavy extraction can otherwise clear the
    // bar against an unrelated article). Candidates are checked closest-first;
    // text fetches are capped to bound the cost.
    if (
      selfScreen === "eligible" &&
      contentSimhash &&
      contentSimhash !== "0".repeat(16) &&
      extractedText &&
      countShingles(extractedText) >= MIN_CONTAINMENT_SHINGLES
    ) {
      const candidates = reps
        .map((r) => {
          if (repScreens.get(r.id) !== "eligible") return null;
          if (!r.contentSimhash || r.contentSimhash === "0".repeat(16)) return null;
          const dist = hammingDistance(contentSimhash, r.contentSimhash);
          return dist <= SIMHASH_NEAR_DUP_BITS ? { rep: r, dist } : null;
        })
        .filter((c): c is { rep: (typeof reps)[number]; dist: number } => c !== null)
        .sort((a, b) => a.dist - b.dist)
        .slice(0, SIMHASH_VERIFY_MAX_CANDIDATES);
      for (const c of candidates) {
        const [row] = await db
          .select({ extractedText: sourceDocumentsTable.extractedText })
          .from(sourceDocumentsTable)
          .where(eq(sourceDocumentsTable.id, c.rep.id))
          .limit(1);
        const repText = row?.extractedText;
        if (!repText || countShingles(repText) < MIN_CONTAINMENT_SHINGLES) continue;
        const containment = shingleContainment(extractedText, repText);
        if (containment >= SIMHASH_VERIFY_MIN_CONTAINMENT) {
          return {
            rep: c.rep,
            reason: `near-duplicate (SimHash distance ${c.dist}, shingle containment ${containment.toFixed(2)})`,
          };
        }
      }
    }
    return null;
  })();

  if (!match) {
    return { duplicateOfId: null, dedupeReason: null, sourceFamilyId: null, demoteRepId: null };
  }

  const rep = match.rep;

  const decision = decideRepresentative(
    {
      ...params.incoming,
      authorityTier,
      canonicalUrl,
      chunkCount: 0,
    },
    {
      authorityTier: rep.authorityTier,
      authoritySource: rep.authoritySource,
      qualityScore: rep.qualityScore,
      wordCount: rep.wordCount,
      chunkCount: rep.chunkCount,
      canonicalUrl: rep.canonicalUrl,
      domain: rep.domain,
      extractionMethod: rep.extractionMethod,
      publishedAt: rep.publishedAt,
      paywallDetected: rep.paywallDetected,
      excerptOnly: rep.excerptOnly,
      status: rep.status,
      lifecycleStatus: rep.lifecycleStatus,
    },
  );

  // Representative swap is reserved for fully-eligible incoming docs: a thin
  // doc (which can only have matched via the canonical-URL layer) may join a
  // family as a duplicate but must never become the representative — the rep
  // is what retrieval reads.
  if (decision.winner === "incoming" && selfScreen === "eligible") {
    // The incoming doc becomes the family representative; the previously-stored
    // rep is demoted under it (applyDedupPlan repoints the whole family).
    return {
      duplicateOfId: null,
      dedupeReason: null,
      sourceFamilyId: null, // Option B: family id = current representative id (the incoming doc)
      demoteRepId: rep.id,
    };
  }

  return {
    duplicateOfId: rep.id,
    dedupeReason: `${match.reason}; kept representative: ${decision.reason}`,
    sourceFamilyId: rep.id, // Option B: family id = current representative id
    demoteRepId: null,
  };
}

async function recordJob(
  kind: SourceVaultJob["kind"],
  input: Record<string, unknown>,
): Promise<string> {
  const [row] = await db
    .insert(sourceVaultJobsTable)
    .values({ kind, input, status: "running" })
    .returning({ id: sourceVaultJobsTable.id });
  return row!.id;
}

async function finishJob(
  id: string,
  status: SourceVaultJob["status"],
  patch: { result?: Record<string, unknown>; error?: string; costUsd?: number },
): Promise<void> {
  await db
    .update(sourceVaultJobsTable)
    .set({
      status,
      result: patch.result ?? null,
      error: patch.error ?? null,
      costUsd: (patch.costUsd ?? 0).toFixed(6),
      finishedAt: new Date(),
    })
    .where(eq(sourceVaultJobsTable.id, id));
}

/** Public status snapshot for the admin page. */
export interface VaultStatus {
  perplexityConfigured: boolean;
  embeddingProvider: string;
  embeddingConfigured: boolean;
  enabled: boolean;
  dailyBudgetUsd: number;
  runBudgetUsd: number;
  todaySpendUsd: number;
  documentCount: number;
  embeddedCount: number;
  chunkCount: number;
}

export async function getVaultStatus(): Promise<VaultStatus> {
  const [[docs], [embedded], [chunks], spend] = await Promise.all([
    db.select({ n: sql<string>`count(*)` }).from(sourceDocumentsTable),
    db
      .select({ n: sql<string>`count(*)` })
      .from(sourceDocumentsTable)
      .where(eq(sourceDocumentsTable.status, "embedded")),
    db.select({ n: sql<string>`count(*)` }).from(sourceChunksTable),
    getTodayVaultSpendUsd(),
  ]);
  return {
    perplexityConfigured: isPerplexityConfigured(),
    embeddingProvider: embeddingProvider(),
    embeddingConfigured: isEmbeddingConfigured(),
    enabled: isSourceVaultEnabled(),
    dailyBudgetUsd: VAULT_DAILY_BUDGET_USD,
    runBudgetUsd: VAULT_RUN_BUDGET_USD,
    todaySpendUsd: spend,
    documentCount: Number(docs?.n ?? 0),
    embeddedCount: Number(embedded?.n ?? 0),
    chunkCount: Number(chunks?.n ?? 0),
  };
}

/**
 * Compact, log-safe view of a DB error. Drizzle's query errors embed the FULL
 * bound-params blob in `message` — for chunk inserts that means dozens of
 * 384-dim embedding vectors flooding the deploy logs while the actual Postgres
 * error hides (unlogged) in `cause`. Keep a short message prefix and surface
 * the underlying cause instead.
 */
function dbErrSummary(err: unknown): { message: string; cause?: string; stack?: string } {
  if (!(err instanceof Error)) return { message: String(err) };
  const message =
    err.message.length > 400 ? `${err.message.slice(0, 400)}…[truncated]` : err.message;
  const cause = err.cause instanceof Error ? err.cause.message : undefined;
  const stack = err.stack
    ? err.stack.split("\n").slice(0, 6).join("\n")
    : undefined;
  return { message, ...(cause ? { cause } : {}), ...(stack ? { stack } : {}) };
}

/**
 * Embed a document's text and atomically replace its stored chunks + embedding
 * metadata. The expensive embedding calls (and the budget `guard.check()`) run
 * BEFORE any DB write, so a budget stop or provider failure leaves the prior
 * state completely untouched — no partial/leaked chunks and no half-updated
 * document status. The delete + insert + document-status update commit together
 * in a single transaction, so retrieval never sees an incompletely-embedded doc.
 */
async function embedAndStoreChunks(
  documentId: string,
  text: string,
  guard: VaultBudgetGuard,
): Promise<{ document: SourceDocument; chunkCount: number; provider: string; model: string; dimensions: number }> {
  const chunks = chunkText(text);
  const provider = embeddingProvider();

  // Nothing to embed: atomically clear any prior chunks and mark extracted.
  if (chunks.length === 0) {
    const document = await db.transaction(async (tx) => {
      await tx.delete(vaultClaimsTable).where(eq(vaultClaimsTable.sourceDocumentId, documentId));
      await tx
        .delete(claimExtractionReceiptsTable)
        .where(eq(claimExtractionReceiptsTable.sourceDocumentId, documentId));
      await tx.delete(sourceChunksTable).where(eq(sourceChunksTable.documentId, documentId));
      const [updated] = await tx
        .update(sourceDocumentsTable)
        .set({
          status: "extracted",
          chunkCount: 0,
          embeddingProvider: null,
          embeddingModel: null,
          embeddingDimensions: null,
          updatedAt: new Date(),
        })
        .where(eq(sourceDocumentsTable.id, documentId))
        .returning();
      return updated!;
    });
    return { document, chunkCount: 0, provider, model: "", dimensions: 0 };
  }

  // 1) Embed everything first (network + budget checks), OUTSIDE any DB tx, so a
  //    failure here never mutates persisted state.
  let model = "";
  let dimensions = 0;
  const rows: (typeof sourceChunksTable.$inferInsert)[] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    await guard.check();
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const { vectors, model: batchModel, dimensions: batchDims, provider: batchProvider } =
      await embedTexts(batch.map((c) => c.content));
    model = batchModel;
    dimensions = batchDims;
    for (let j = 0; j < batch.length; j += 1) {
      const c = batch[j]!;
      rows.push({
        documentId,
        chunkIndex: c.index,
        content: c.content,
        contentHash: c.contentHash,
        charCount: c.charCount,
        embedding: vectors[j]!,
        embeddingProvider: batchProvider,
        embeddingModel: batchModel,
        dimensions: batchDims,
      });
    }
  }

  // 2) Swap chunks + flip document to "embedded" in ONE transaction.
  const document = await db.transaction(async (tx) => {
    // Serialize concurrent embeds of the SAME document (ingest path, re-embed
    // sweep, and makeRepresentative can overlap): without this lock, both
    // transactions delete (each seeing no committed rows from the other) and
    // then both insert, so the second commit dies on the
    // source_chunks(document_id, chunk_index) unique key. Locking the parent
    // document row first makes the loser wait, and its delete then clears the
    // winner's rows before re-inserting — same end state, no error.
    await tx.execute(
      sql`select id from ${sourceDocumentsTable} where ${sourceDocumentsTable.id} = ${documentId} for update`,
    );
    // Chunk IDs are evidence pointers for extracted claims. Remove the old
    // claim graph atomically before replacing chunks; cascading relationships
    // and article-use rows prevents stale provenance after a re-embed.
    await tx.delete(vaultClaimsTable).where(eq(vaultClaimsTable.sourceDocumentId, documentId));
    await tx
      .delete(claimExtractionReceiptsTable)
      .where(eq(claimExtractionReceiptsTable.sourceDocumentId, documentId));
    await tx.delete(sourceChunksTable).where(eq(sourceChunksTable.documentId, documentId));
    await tx.insert(sourceChunksTable).values(rows);
    const [updated] = await tx
      .update(sourceDocumentsTable)
      .set({
        status: "embedded",
        chunkCount: rows.length,
        embeddingProvider: provider,
        embeddingModel: model,
        embeddingDimensions: dimensions,
        updatedAt: new Date(),
      })
      .where(eq(sourceDocumentsTable.id, documentId))
      .returning();
    return updated!;
  });

  if (rows.length > 0 && document.evidenceEligible) {
    scheduleClaimExtraction(document.id);
  }
  return { document, chunkCount: rows.length, provider, model, dimensions };
}

/** Outcome of a re-embed sweep run. */
export interface ReembedSweepResult {
  candidates: number;
  embedded: number;
  failed: number;
  stoppedBy: "done" | "budget" | "disabled" | "empty";
}

/**
 * Re-embed sweep: pick up documents stranded at status "extracted" with usable
 * text but zero chunks — i.e. the fetch+extract succeeded but embedding never
 * completed (a transient provider failure, or embedding disabled at ingest
 * time). Embedding a good document is idempotent and, for the default LOCAL
 * provider, free, so such a document should never stay permanently unsearchable;
 * this sweep is what guarantees that (embedding otherwise only ever happens once,
 * at ingest). Each embed flips the doc to "embedded" and it drops out of the
 * candidate set, so repeated runs converge and then no-op.
 *
 * Scope is deliberately narrow so it can NEVER touch the correctly-excluded
 * states: `status = "extracted"` skips both `failed` (no text) and `low_quality`
 * (below the quality bar, held out until an admin approves), and the
 * `duplicate_of_id IS NULL` guard skips syndicated copies (representatives only
 * are embedded). Bounded per run, budget-guarded (paid providers only), and
 * never throws — a per-doc failure is logged and the sweep moves on.
 */
export async function reembedExtractedDocuments(
  now: Date = new Date(),
  limit = 25,
): Promise<ReembedSweepResult> {
  const result: ReembedSweepResult = { candidates: 0, embedded: 0, failed: 0, stoppedBy: "empty" };

  // Same gates as the ingest embed path: honor the kill-switch and skip entirely
  // when no embedding provider is configured (no work is possible).
  if (!isSourceVaultEnabled() || !isEmbeddingConfigured()) {
    result.stoppedBy = "disabled";
    return result;
  }

  // Wrap the candidate fetch + whole sweep so an unexpected DB error (e.g. the
  // select itself) can NEVER escape — this runs fire-and-forget from the cron
  // tick, so it must honor its never-throws contract and just stop cleanly.
  try {
    const bounded = Math.min(Math.max(limit, 1), 200);
    const candidates = await db
      .select({ id: sourceDocumentsTable.id, text: sourceDocumentsTable.extractedText })
      .from(sourceDocumentsTable)
      .where(
        and(
          eq(sourceDocumentsTable.status, "extracted"),
          eq(sourceDocumentsTable.chunkCount, 0),
          gt(sourceDocumentsTable.wordCount, 0),
          isNull(sourceDocumentsTable.duplicateOfId),
          isNotNull(sourceDocumentsTable.extractedText),
        ),
      )
      .orderBy(asc(sourceDocumentsTable.createdAt))
      .limit(bounded);

    result.candidates = candidates.length;
    if (candidates.length === 0) return result;

    let guard: VaultBudgetGuard;
    try {
      guard = await VaultBudgetGuard.start("reembed sweep", { paid: isEmbeddingPaid(), now });
    } catch (err) {
      result.stoppedBy = err instanceof VaultBudgetExceededError ? "budget" : "disabled";
      return result;
    }

    for (const doc of candidates) {
      const text = doc.text ?? "";
      if (!text.trim()) continue;
      try {
        await guard.check(now);
      } catch (err) {
        // Budget/kill-switch stop: leave the remaining docs for a later sweep.
        result.stoppedBy = err instanceof VaultBudgetExceededError ? "budget" : "disabled";
        return result;
      }
      try {
        const { chunkCount } = await embedAndStoreChunks(doc.id, text, guard);
        if (chunkCount > 0) result.embedded += 1;
      } catch (err) {
        if (err instanceof VaultBudgetExceededError) {
          result.stoppedBy = "budget";
          return result;
        }
        result.failed += 1;
        logger.warn(
          { err: dbErrSummary(err), documentId: doc.id },
          "reembedExtractedDocuments: embed failed",
        );
      }
    }

    result.stoppedBy = "done";
    return result;
  } catch (err) {
    // Fetch/setup failure: never propagate — log and report a clean stop.
    logger.error({ err: dbErrSummary(err) }, "reembedExtractedDocuments: sweep failed");
    result.stoppedBy = "disabled";
    return result;
  }
}

/** Outcome of an ingest attempt. */
export interface IngestResult {
  document: SourceDocument;
  embedded: boolean;
  note: string;
}

/**
 * Ingest a single URL end-to-end: SSRF-safe fetch, extract, quality-score, and
 * (when the quality bar is met or the caller approves low quality AND Perplexity
 * is configured) chunk + embed + store. An existing document for the same URL is
 * updated in place. On a fetch/SSRF failure the document is recorded with status
 * "failed" and the error, never crashing.
 */
export async function ingestUrl(
  rawUrl: string,
  opts: {
    approveLowQuality?: boolean;
    discoveredVia?: SourceDocument["discoveredVia"];
    leadSnippet?: string;
    beatSlug?: string | null;
  } = {},
): Promise<IngestResult> {
  const jobId = await recordJob("ingest_url", { url: rawUrl, ...opts });

  try {
    // Look up any prior record for this URL up front: needed to preserve a manual
    // authority override, detect content changes, and honor do-not-refetch.
    const existing = await getDocumentByUrl(rawUrl);

    // Respect a prior do-not-refetch decision (e.g. robots disallow / paywall).
    if (existing?.doNotRefetch) {
      await finishJob(jobId, "succeeded", { result: { documentId: existing.id, embedded: false, skipped: true } });
      const patched = await touchLastChecked(existing.id);
      return { document: patched, embedded: false, note: "Skipped: marked do-not-refetch." };
    }

    // --- Fetch policy: robots.txt ------------------------------------------
    const robots = await checkRobots(rawUrl);
    if (!robots.allowed) {
      const auth = resolveAuthority(existing, rawUrl);
      const doc = await upsertDocument({
        url: rawUrl,
        domain: safeHost(rawUrl),
        discoveredVia: opts.discoveredVia ?? "manual_url",
        leadSnippet: opts.leadSnippet ?? null,
        beatSlug: opts.beatSlug ?? null,
        status: "failed",
        error: "robots.txt disallows fetching this URL",
        robotsStatus: robots.status,
        fetchAllowed: false,
        doNotRefetch: true,
        policyNotes: robots.note,
        lifecycleStatus: "unavailable",
        lastCheckedAt: new Date(),
        authorityTier: auth.authorityTier,
        authoritySource: auth.authoritySource,
        authorityReason: auth.authorityReason,
      });
      await finishJob(jobId, "succeeded", { result: { documentId: doc.id, embedded: false, robotsBlocked: true } });
      return { document: doc, embedded: false, note: "Not fetched: robots.txt disallows this URL." };
    }

    let extracted;
    try {
      extracted = await fetchAndExtract(rawUrl);
    } catch (err) {
      if (
        err instanceof UnsafeUrlError ||
        err instanceof FetchError ||
        err instanceof DocumentExtractionError
      ) {
        const doc = await upsertDocument({
          url: rawUrl,
          domain: safeHost(rawUrl),
          discoveredVia: opts.discoveredVia ?? "manual_url",
          leadSnippet: opts.leadSnippet ?? null,
          beatSlug: opts.beatSlug ?? null,
          status: "failed",
          error: err.message,
          httpStatus: err instanceof FetchError ? err.httpStatus ?? null : null,
          robotsStatus: robots.status,
          fetchAllowed: true,
          lastCheckedAt: new Date(),
        });
        await finishJob(jobId, "failed", { error: err.message, result: { documentId: doc.id } });
        return { document: doc, embedded: false, note: `Fetch failed: ${err.message}` };
      }
      throw err;
    }

    return persistExtractedSource(extracted, {
      url: rawUrl,
      existing,
      discoveredVia: opts.discoveredVia ?? "manual_url",
      leadSnippet: opts.leadSnippet ?? null,
      beatSlug: opts.beatSlug ?? null,
      approveLowQuality: opts.approveLowQuality,
      robotsStatus: robots.status,
      jobId,
    });
  } catch (err) {
    const summary = dbErrSummary(err);
    await finishJob(jobId, "failed", { error: summary.cause ?? summary.message });
    logger.error({ err: summary, url: rawUrl }, "sourceVault: ingest failed unexpectedly");
    throw err;
  }
}

/**
 * Store an already-extracted source and run the shared post-extraction pipeline:
 * dedup classification → quality gate → budget-guarded chunk + embed. Shared by
 * ingestUrl (fetched HTML/documents) and ingestUpload (uploaded documents). The
 * caller owns the job row; this helper finalizes it on every terminal path.
 * `forceDoNotRefetch` marks uploads (there is no origin to re-fetch).
 */
async function persistExtractedSource(
  extracted: ExtractedSource,
  ctx: {
    url: string;
    existing: SourceDocument | null;
    discoveredVia: SourceDocument["discoveredVia"];
    leadSnippet: string | null;
    beatSlug?: string | null;
    approveLowQuality?: boolean;
    robotsStatus: string | null;
    forceDoNotRefetch?: boolean;
    jobId: string;
  },
): Promise<IngestResult> {
  const { url, existing, jobId } = ctx;
  const contentHash = sha256(extracted.text);
  const contentSimhash = simhash64(extracted.text);
  const now = new Date();
  // Uploads have a synthetic upload:// URL with no meaningful host — fall back
  // to the extracted domain for those; real fetches pass the full URL so
  // path-based rules apply. Pass both title and excerpt so review-article
  // signals in the title OR abstract can downgrade primary → reported.
  const auth = resolveAuthority(existing, url.startsWith("http") ? url : extracted.domain, extracted.title, extracted.excerpt);

  // Lifecycle: detect a content change vs the prior fetch of this URL.
  const contentChanged = !!existing && existing.contentHash != null && existing.contentHash !== contentHash;
  const contentChangedAt = contentChanged ? now : existing?.contentChangedAt ?? null;
  // Default freshness horizon from this fetch (source can override later).
  const staleAfter = new Date(now.getTime() + DEFAULT_STALE_AFTER_DAYS * 24 * 60 * 60 * 1000);
  // A paywall/excerpt-only page shouldn't be hammered on every batch; uploads
  // have no origin to re-fetch at all.
  const doNotRefetch = extracted.excerptOnly || ctx.forceDoNotRefetch === true;

  // canonicalUrl: prefer the page-declared canonical, normalize YouTube URLs to
  // their watch?v=<id> form, and fall back to the post-redirect final URL, then
  // the originally requested URL — never a bogus placeholder value.
  const canonicalUrl = resolveCanonicalUrl(extracted.canonicalUrl, extracted.finalUrl, url);

  // Captcha / bot-check detection: a page-challenge interstitial (Cloudflare,
  // Akamai, reCAPTCHA, etc.) can be served even for high-authority domains
  // when the crawler IP is a datacenter address. Detect via title and leading
  // body text and short-circuit to "failed" immediately — keep the row as
  // metadata so we know the URL was attempted, but do NOT chunk/embed or let
  // the domain tier masquerade as document quality.
  //
  // Strategy: title match alone is conclusive. Body match is used only when
  // wordCount < 300 (challenge pages sometimes pad with nav/footer text).
  const captchaRe =
    /checking your browser|are you a robot|recaptcha|captcha|just a moment\b|cloudflare ray id|please verify you are human|enable javascript to|attention required|bot detection|akamai challenge/i;
  const captchaTitleHit = captchaRe.test(extracted.title ?? "");
  const captchaBodyHit =
    extracted.wordCount < 300 && captchaRe.test((extracted.text ?? "").slice(0, 500));
  if (captchaTitleHit || captchaBodyHit) {
    const doc = await upsertDocument({
      url,
      domain: extracted.domain,
      title: extracted.title,
      canonicalUrl,
      discoveredVia: ctx.discoveredVia,
      leadSnippet: ctx.leadSnippet,
      beatSlug: ctx.beatSlug ?? null,
      httpStatus: extracted.httpStatus,
      fetchedAt: now,
      robotsStatus: ctx.robotsStatus,
      fetchAllowed: true,
      lifecycleStatus: "unavailable",
      doNotRefetch: false,
      lastCheckedAt: now,
      status: "failed",
      error: "Bot check / captcha page — no article content extracted.",
      qualityFlags: ["captcha_blocked", "no_article_body"],
      authorityTier: auth.authorityTier,
      authoritySource: auth.authoritySource,
      authorityReason: auth.authorityReason,
    });
    await finishJob(jobId, "failed", { error: "captcha_blocked", result: { documentId: doc.id } });
    return { document: doc, embedded: false, note: "Blocked: bot check or captcha page." };
  }

  // Index/listing/catalog pages (category hubs, tag pages, feeds, Wikipedia
  // Category: pages, music-catalog product pages…) can only ever yield
  // navigation metadata, never an article body. Keep them as metadata-only
  // rows: status low_quality, never embedded — regardless of the heuristic
  // quality score. An explicit approveLowQuality still overrides.
  const metadataOnly = isMetadataOnlySource(url);
  // Prompt-injection guard: scan extracted text for instruction-override patterns
  // before storing. Detected documents are held as low_quality and excluded from
  // embedding and drafting pools. A false positive is recoverable via
  // approveLowQuality; a missed injection affecting prose is not.
  const injectionScan = scanForPromptInjection(extracted.text);
  if (injectionScan.detected) {
    logger.warn(
      { url, pattern: injectionScan.matchedPattern },
      "sourceVault: prompt-injection pattern detected in source text — holding as low_quality",
    );
  }
  const belowBar = extracted.qualityScore < QUALITY_THRESHOLD || metadataOnly || injectionScan.detected;

  // Beat resolution: prefer the caller-supplied beat (every automated path —
  // feeds, discovery, ingest queue — carries one), then the existing row's beat
  // on re-ingest. When both are absent (e.g. a manual URL/upload with no beat)
  // fall back to the deterministic classifier so the document is still
  // clustering-eligible instead of stranded with a null beat. Never overrides an
  // explicit beat, and stays null when no beat is a confident fit.
  let resolvedBeatSlug = ctx.beatSlug ?? existing?.beatSlug ?? null;
  if (!resolvedBeatSlug) {
    try {
      const index = await loadBeatIndex();
      resolvedBeatSlug = classifyBeat(
        {
          title: extracted.title,
          excerpt: extracted.excerpt,
          leadSnippet: ctx.leadSnippet,
          text: extracted.text,
          domain: extracted.domain,
        },
        index,
      );
    } catch (err) {
      logger.warn({ err, url }, "sourceVault: beat classification fallback failed");
    }
  }

  const baseDoc = {
    url,
    canonicalUrl,
    domain: extracted.domain,
    title: extracted.title,
    author: extracted.author,
    excerpt: extracted.excerpt,
    publishedAt: extracted.publishedAt,
    discoveredVia: ctx.discoveredVia,
    leadSnippet: ctx.leadSnippet,
    beatSlug: resolvedBeatSlug,
    httpStatus: extracted.httpStatus,
    fetchedAt: now,
    extractionMethod: extracted.extractionMethod,
    extractedText: extracted.text,
    wordCount: extracted.wordCount,
    contentHash,
    contentSimhash,
    qualityScore: extracted.qualityScore,
    qualityFlags: [
      ...(metadataOnly ? [...extracted.qualityFlags, "index_page_metadata_only"] : extracted.qualityFlags),
      ...(injectionScan.detected ? ["prompt_injection_suspected"] : []),
    ],
    error: null as string | null,
    // Fetch policy
    robotsStatus: ctx.robotsStatus,
    fetchAllowed: true,
    paywallDetected: extracted.paywallDetected,
    excerptOnly: extracted.excerptOnly,
    doNotRefetch,
    policyNotes: extracted.policyNotes,
    // Lifecycle
    lifecycleStatus: "active" as SourceLifecycleStatus,
    lastCheckedAt: now,
    contentChangedAt,
    staleAfter,
    // Authority
    authorityTier: auth.authorityTier,
    authoritySource: auth.authoritySource,
    authorityReason: auth.authorityReason,
  };

  // Store the document first (so it has an id for dedup/family bookkeeping),
  // then classify duplication against existing representatives.
  const stored = await upsertDocument({ ...baseDoc, status: "extracted", chunkCount: 0 });
  if (injectionScan.detected) {
    await db.execute(
      sql`UPDATE "source_documents" SET "prompt_injection_suspected" = true WHERE "id" = ${stored.id}`,
    );
  }
  const dedup = await planDedup({
    selfId: stored.id,
    contentHash,
    contentSimhash,
    title: extracted.title,
    extractedText: extracted.text,
    canonicalUrl,
    authorityTier: auth.authorityTier,
    incoming: {
      authoritySource: auth.authoritySource,
      qualityScore: extracted.qualityScore,
      wordCount: extracted.wordCount,
      domain: extracted.domain,
      extractionMethod: extracted.extractionMethod,
      publishedAt: extracted.publishedAt,
      paywallDetected: extracted.paywallDetected,
      excerptOnly: extracted.excerptOnly,
      status: "extracted",
      lifecycleStatus: "active",
    },
  });
  const doc = await applyDedupPlan(stored, dedup);

  // Duplicates are stored for provenance but never embedded (retrieval reads
  // representatives only).
  if (dedup.duplicateOfId) {
    await finishJob(jobId, "succeeded", {
      result: { documentId: doc.id, embedded: false, duplicateOfId: dedup.duplicateOfId },
    });
    return { document: doc, embedded: false, note: `Stored as duplicate (${dedup.dedupeReason}).` };
  }

  // Task #338: deterministic concept tagging for every non-duplicate ingest.
  // Fire-and-forget — never blocks or fails ingestion (the fn never throws,
  // and re-checks document eligibility itself).
  void tagSourceDocumentConcepts(doc.id);

  const canEmbed = isEmbeddingConfigured() && (!belowBar || ctx.approveLowQuality === true);
  if (!canEmbed) {
    const status: SourceDocument["status"] = belowBar ? "low_quality" : "extracted";
    const held = await upsertDocument({ ...baseDoc, status, chunkCount: 0 });
    if (injectionScan.detected) {
      await db.execute(
        sql`UPDATE "source_documents" SET "prompt_injection_suspected" = true WHERE "id" = ${held.id}`,
      );
    }
    const note = metadataOnly
      ? "Held: index/listing page — metadata only, not embeddable article content."
      : belowBar
      ? `Held: quality ${extracted.qualityScore} < ${QUALITY_THRESHOLD} (${extracted.qualityFlags.join(", ") || "flags"})`
      : isEmbeddingConfigured()
        ? "Extracted."
        : "Extracted; embedding skipped (embedding provider not configured).";
    await finishJob(jobId, "succeeded", { result: { documentId: held.id, embedded: false } });
    return { document: { ...held, sourceFamilyId: doc.sourceFamilyId }, embedded: false, note };
  }

  let guard: VaultBudgetGuard;
  try {
    guard = await VaultBudgetGuard.start(`ingest ${url}`, { paid: isEmbeddingPaid() });
  } catch (err) {
    if (err instanceof VaultBudgetExceededError) {
      await finishJob(jobId, "succeeded", { result: { documentId: doc.id, embedded: false } });
      return { document: doc, embedded: false, note: `Stored (not embedded): ${err.message}` };
    }
    throw err;
  }

  let embed;
  try {
    embed = await embedAndStoreChunks(doc.id, extracted.text, guard);
  } catch (err) {
    if (
      err instanceof VaultBudgetExceededError ||
      err instanceof EmbeddingNotConfiguredError ||
      err instanceof PerplexityNotConfiguredError
    ) {
      await finishJob(jobId, "succeeded", { result: { documentId: doc.id, embedded: false } });
      return { document: doc, embedded: false, note: `Stored (not embedded): ${err.message}` };
    }
    throw err;
  }

  const { document: updated, chunkCount, dimensions, model } = embed;
  const spend = await getTodayVaultSpendUsd();
  await finishJob(jobId, "succeeded", {
    result: { documentId: doc.id, embedded: chunkCount > 0, chunkCount },
    costUsd: spend,
  });
  return {
    document: updated,
    embedded: chunkCount > 0,
    note: `Embedded ${chunkCount} chunk(s) at ${dimensions} dims (${model}).`,
  };
}

/** Max decoded size for an uploaded document (matches the JSON body cap headroom). */
const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Ingest an uploaded document (PDF/DOCX/PPTX/…) end-to-end: decode, detect type,
 * extract text, quality-score, and (when the bar is met or approved) chunk +
 * embed + store — reusing the exact same pipeline as URL ingestion. The document
 * gets a synthetic `upload://<sha256>` URL (content-addressed, so re-uploading
 * the same file updates in place) and is marked do-not-refetch (no origin). An
 * unsupported file type or a parse failure is recorded as a "failed" document
 * with the error — never silently dropped.
 */
export async function ingestUpload(params: {
  filename: string;
  contentBase64: string;
  contentType?: string;
  approveLowQuality?: boolean;
  beatSlug?: string | null;
}): Promise<IngestResult> {
  const jobId = await recordJob("ingest_url", { upload: params.filename });

  try {
    const bytes = Buffer.from(params.contentBase64, "base64");
    if (bytes.length === 0) throw new Error("Uploaded file is empty or not valid base64.");
    if (bytes.length > UPLOAD_MAX_BYTES) {
      throw new Error(`File exceeds the ${Math.round(UPLOAD_MAX_BYTES / (1024 * 1024))} MB upload cap.`);
    }

    const type = detectDocumentType({
      contentType: params.contentType,
      url: params.filename,
      bytes,
    });

    // Content-addressed URL so a re-upload of the same bytes updates in place.
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const url = `upload://${contentHash}`;
    const existing = await getDocumentByUrl(url);

    // Unsupported file type → record a failed document (never silently store).
    if (!type) {
      const doc = await upsertDocument({
        url,
        domain: "upload",
        discoveredVia: "manual_upload",
        title: params.filename,
        status: "failed",
        error: `Unsupported upload type: ${params.filename} (${params.contentType ?? "unknown content-type"})`,
        fetchAllowed: false,
        doNotRefetch: true,
        lastCheckedAt: new Date(),
      });
      await finishJob(jobId, "failed", {
        error: "unsupported_upload_type",
        result: { documentId: doc.id },
      });
      return {
        document: doc,
        embedded: false,
        note: `Unsupported file type: ${params.filename}. Supported: PDF, DOCX, PPTX, XLSX, ODT, ODP, ODS.`,
      };
    }

    let extracted: ExtractedSource;
    try {
      extracted = await extractFromDocumentBytes(bytes, { type, url, filename: params.filename });
    } catch (err) {
      if (err instanceof DocumentExtractionError) {
        const doc = await upsertDocument({
          url,
          domain: "upload",
          discoveredVia: "manual_upload",
          title: params.filename,
          status: "failed",
          error: err.message,
          fetchAllowed: false,
          doNotRefetch: true,
          lastCheckedAt: new Date(),
        });
        await finishJob(jobId, "failed", { error: err.message, result: { documentId: doc.id } });
        return { document: doc, embedded: false, note: `Extraction failed: ${err.message}` };
      }
      throw err;
    }

    return persistExtractedSource(extracted, {
      url,
      existing,
      discoveredVia: "manual_upload",
      leadSnippet: null,
      beatSlug: params.beatSlug ?? null,
      approveLowQuality: params.approveLowQuality,
      robotsStatus: null,
      forceDoNotRefetch: true,
      jobId,
    });
  } catch (err) {
    const summary = dbErrSummary(err);
    await finishJob(jobId, "failed", { error: summary.cause ?? summary.message });
    logger.error(
      { err: summary, filename: params.filename },
      "sourceVault: upload ingest failed unexpectedly",
    );
    throw err;
  }
}

/**
 * Approve a held low_quality document and embed it now. Throws if the document
 * has no extracted text or no embedding provider is configured.
 */
export async function approveAndEmbed(documentId: string): Promise<IngestResult> {
  const doc = await getDocument(documentId);
  if (!doc) throw new Error("Document not found.");
  if (!doc.extractedText || doc.extractedText.trim().length === 0) {
    throw new Error("Document has no extracted text to embed.");
  }
  if (!isEmbeddingConfigured()) throw new EmbeddingNotConfiguredError();

  const jobId = await recordJob("ingest_url", { documentId, approve: true });
  const guard = await VaultBudgetGuard.start(`approve ${documentId}`, { paid: isEmbeddingPaid() });
  try {
    const { document: updated, chunkCount, dimensions, model } = await embedAndStoreChunks(
      doc.id,
      doc.extractedText,
      guard,
    );
      const spend = await getTodayVaultSpendUsd();
    await finishJob(jobId, "succeeded", { result: { documentId, chunkCount }, costUsd: spend });
    return {
      document: updated,
      embedded: chunkCount > 0,
      note: `Embedded ${chunkCount} chunk(s) at ${dimensions} dims (${model}).`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishJob(jobId, "failed", { error: message });
    throw err;
  }
}

/** Discover fresh source leads via Perplexity search. Does NOT ingest. */
export async function searchLeads(
  query: string,
  opts: { maxResults?: number; recencyDays?: number; domains?: string[] } = {},
): Promise<SearchLead[]> {
  const jobId = await recordJob("search", { query, ...opts });
  const guard = await VaultBudgetGuard.start(`search ${query}`);
  try {
    await guard.check();
    // Search now returns ALL leads tagged with a role (Task #227) — Perplexity
    // first, Claude fallback when it is down (Task #341). The manual "search
    // leads" admin surface is for finding INGESTABLE sources, so keep it
    // evidence-only here; markers/junk are handled by the automated discovery
    // path (which records them for Trend Radar), not this manual tool.
    const leads = (await searchWithFallback(query, opts)).filter((l) => l.role === "evidence");
    const spend = await getTodayVaultSpendUsd();
    await finishJob(jobId, "succeeded", { result: { count: leads.length }, costUsd: spend });
    return leads;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishJob(jobId, "failed", { error: message });
    throw err;
  }
}

/** A semantic retrieval hit: a chunk plus its parent document + similarity. */
export interface RetrievalHit {
  chunkId: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  similarity: number;
  document: {
    id: string;
    url: string;
    title: string | null;
    domain: string;
  };
}

/**
 * Semantic retrieval: embed the query, then rank stored chunks by cosine
 * similarity (pgvector `<=>`). Returns [] when there are no embedded chunks.
 * Throws EmbeddingNotConfiguredError when no embedding provider is configured.
 */
export async function semanticSearch(
  query: string,
  opts: { limit?: number } = {},
): Promise<RetrievalHit[]> {
  if (!isEmbeddingConfigured()) throw new EmbeddingNotConfiguredError();
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 50);

  const jobId = await recordJob("retrieve", { query, limit });
  const guard = await VaultBudgetGuard.start(`retrieve ${query}`, { paid: isEmbeddingPaid() });
  try {
    await guard.check();
    const { vectors, provider, model } = await embedTexts([query]);
    const queryVec = vectors[0];
    if (!queryVec || queryVec.length === 0) {
      await finishJob(jobId, "succeeded", { result: { count: 0 } });
      return [];
    }
    const literal = toVectorLiteral(queryVec);

    // Cosine distance expression. For the standard 384-dim local embeddings we
    // cast the dimensionless column to vector(384) so the query matches — and can
    // use — the partial HNSW index (source_chunks_embedding_hnsw_idx). Other
    // dimensions (no ANN index) fall back to the exact sequential scan.
    const distanceExpr =
      queryVec.length === 384
        ? sql`(c."embedding"::vector(384)) <=> ${literal}::vector(384)`
        : sql`c."embedding" <=> ${literal}::vector`;

    const rows = await db.execute<{
      chunk_id: string;
      document_id: string;
      chunk_index: number;
      content: string;
      similarity: number;
      url: string;
      title: string | null;
      domain: string;
    }>(sql`
      SELECT
        c."id" AS chunk_id,
        c."document_id" AS document_id,
        c."chunk_index" AS chunk_index,
        c."content" AS content,
        1 - (${distanceExpr}) AS similarity,
        d."url" AS url,
        d."title" AS title,
        d."domain" AS domain
      FROM "source_chunks" c
      JOIN "source_documents" d ON d."id" = c."document_id"
      WHERE c."dimensions" = ${queryVec.length}
        AND d."status" = 'embedded'
        AND d."lifecycle_status" = 'active'
        AND d."duplicate_of_id" IS NULL
        AND d."evidence_eligible" IS DISTINCT FROM false
        AND c."embedding_provider" = ${provider}
        AND c."embedding_model" = ${model}
      ORDER BY ${distanceExpr} ASC
      LIMIT ${limit}
    `);

    const hits: RetrievalHit[] = (rows.rows ?? rows).map((r) => ({
      chunkId: r.chunk_id,
      documentId: r.document_id,
      chunkIndex: r.chunk_index,
      content: r.content,
      similarity: Number(r.similarity),
      document: { id: r.document_id, url: r.url, title: r.title, domain: r.domain },
    }));
    const spend = await getTodayVaultSpendUsd();
    await finishJob(jobId, "succeeded", { result: { count: hits.length }, costUsd: spend });
    return hits;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishJob(jobId, "failed", { error: message });
    throw err;
  }
}

/**
 * Semantic retrieval over the glossary-concept lane only (evidenceEligible =
 * false, discoveredVia = 'glossary_concept'). Used exclusively to build the
 * INTERNAL CONCEPT MEMORY section injected into draft prompts. These hits are
 * NEVER mixed with evidence results and must never count as source coverage.
 * Returns [] (no throw) when embeddings are not configured.
 */
export async function searchGlossaryConcepts(
  query: string,
  opts: { limit?: number } = {},
): Promise<RetrievalHit[]> {
  if (!isEmbeddingConfigured()) return [];
  const limit = Math.min(Math.max(opts.limit ?? 6, 1), 20);

  let queryVec: number[];
  let provider: string;
  let model: string;
  try {
    const result = await embedTexts([query]);
    queryVec = result.vectors[0] ?? [];
    provider = result.provider;
    model = result.model;
  } catch {
    return [];
  }
  if (queryVec.length === 0) return [];

  const literal = toVectorLiteral(queryVec);
  const distanceExpr =
    queryVec.length === 384
      ? sql`(c."embedding"::vector(384)) <=> ${literal}::vector(384)`
      : sql`c."embedding" <=> ${literal}::vector`;

  const rows = await db.execute<{
    chunk_id: string;
    document_id: string;
    chunk_index: number;
    content: string;
    similarity: number;
    url: string;
    title: string | null;
    domain: string;
  }>(sql`
    SELECT
      c."id" AS chunk_id,
      c."document_id" AS document_id,
      c."chunk_index" AS chunk_index,
      c."content" AS content,
      1 - (${distanceExpr}) AS similarity,
      d."url" AS url,
      d."title" AS title,
      d."domain" AS domain
    FROM "source_chunks" c
    JOIN "source_documents" d ON d."id" = c."document_id"
    WHERE c."dimensions" = ${queryVec.length}
      AND d."status" = 'embedded'
      AND d."lifecycle_status" = 'active'
      AND d."discovered_via" = 'glossary_concept'
      AND d."evidence_eligible" = false
      AND d."duplicate_of_id" IS NULL
      AND c."embedding_provider" = ${provider}
      AND c."embedding_model" = ${model}
    ORDER BY ${distanceExpr} ASC
    LIMIT ${limit}
  `);

  return (rows.rows ?? rows).map((r) => ({
    chunkId: r.chunk_id,
    documentId: r.document_id,
    chunkIndex: r.chunk_index,
    content: r.content,
    similarity: Number(r.similarity),
    document: { id: r.document_id, url: r.url, title: r.title, domain: r.domain },
  }));
}

// --- Storage helpers ------------------------------------------------------

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

async function upsertDocument(
  values: Partial<SourceDocument> & { url: string; domain: string },
): Promise<SourceDocument> {
  const [row] = await db
    .insert(sourceDocumentsTable)
    .values({ ...values, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: sourceDocumentsTable.url,
      set: { ...values, updatedAt: new Date() },
    })
    .returning();
  return row!;
}

async function getDocumentByUrl(url: string): Promise<SourceDocument | null> {
  const [row] = await db
    .select()
    .from(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.url, url))
    .limit(1);
  return row ?? null;
}

/** Record a fresh lifecycle check without changing anything else. */
async function touchLastChecked(id: string): Promise<SourceDocument> {
  const [row] = await db
    .update(sourceDocumentsTable)
    .set({ lastCheckedAt: new Date(), updatedAt: new Date() })
    .where(eq(sourceDocumentsTable.id, id))
    .returning();
  return row!;
}

/**
 * Apply a dedup plan to the just-stored document: mark it a duplicate, or set it
 * as its own family root, and (for the wire-penalty promotion path) demote a
 * previously-stored weaker representative under it — clearing that old rep's
 * embedded chunks so retrieval stops surfacing it.
 */
async function applyDedupPlan(stored: SourceDocument, plan: DedupPlan): Promise<SourceDocument> {
  if (plan.duplicateOfId) {
    const [row] = await db
      .update(sourceDocumentsTable)
      .set({
        duplicateOfId: plan.duplicateOfId,
        dedupeReason: plan.dedupeReason,
        sourceFamilyId: plan.sourceFamilyId,
        updatedAt: new Date(),
      })
      .where(eq(sourceDocumentsTable.id, stored.id))
      .returning();
    return row!;
  }

  // Non-duplicate: this doc is (or stays) a family representative. Family
  // invariant (Option B): sourceFamilyId always equals the CURRENT
  // representative's id, so "who is canon?" has one answer everywhere.
  const familyId = plan.sourceFamilyId ?? stored.id;

  const demoteRepId = plan.demoteRepId;
  if (demoteRepId) {
    await db.transaction(async (tx) => {
      // Lock the outgoing representative so a concurrent manual swap or ingest
      // can't interleave with this demotion; skip gracefully if someone else
      // already demoted it (it is no longer a representative).
      const [oldRep] = await tx
        .select({ id: sourceDocumentsTable.id, duplicateOfId: sourceDocumentsTable.duplicateOfId })
        .from(sourceDocumentsTable)
        .where(eq(sourceDocumentsTable.id, demoteRepId))
        .limit(1)
        .for("update");
      if (!oldRep || oldRep.duplicateOfId !== null) return;
      const now = new Date();
      // Demote the old representative under the incoming doc, and record the
      // supersession on its lifecycle so retrieval retires it (the lifecycle
      // filter excludes non-active docs) with a durable pointer to its successor.
      await tx
        .update(sourceDocumentsTable)
        .set({
          duplicateOfId: stored.id,
          dedupeReason: "superseded by a better copy in family",
          sourceFamilyId: familyId,
          lifecycleStatus: "superseded",
          supersededById: stored.id,
          updatedAt: now,
        })
        .where(eq(sourceDocumentsTable.id, demoteRepId));
      // Repoint EVERY other family member at the new representative — both
      // direct duplicates of the old rep AND anything sharing its family key
      // (Option B: sourceFamilyId always equals the current rep's id).
      await tx
        .update(sourceDocumentsTable)
        .set({ duplicateOfId: stored.id, sourceFamilyId: familyId, updatedAt: now })
        .where(
          and(
            ne(sourceDocumentsTable.id, stored.id),
            ne(sourceDocumentsTable.id, demoteRepId),
            or(
              eq(sourceDocumentsTable.duplicateOfId, demoteRepId),
              eq(sourceDocumentsTable.sourceFamilyId, demoteRepId),
            ),
          ),
        );
      // Claims point at chunk IDs and inherit the representative's family ID.
      // Remove them before deleting the chunks so stale evidence cannot survive
      // a representative swap or be counted as a second independent family.
      await tx.delete(vaultClaimsTable).where(eq(vaultClaimsTable.sourceDocumentId, demoteRepId));
      await tx
        .delete(claimExtractionReceiptsTable)
        .where(eq(claimExtractionReceiptsTable.sourceDocumentId, demoteRepId));
      // The demoted doc must no longer be retrievable as a representative.
      await tx.delete(sourceChunksTable).where(eq(sourceChunksTable.documentId, demoteRepId));
      await tx
        .update(sourceDocumentsTable)
        .set({ status: "extracted", chunkCount: 0, updatedAt: now })
        .where(and(eq(sourceDocumentsTable.id, demoteRepId), eq(sourceDocumentsTable.status, "embedded")));
    });
  }

  const [row] = await db
    .update(sourceDocumentsTable)
    .set({ sourceFamilyId: familyId, duplicateOfId: null, dedupeReason: null, updatedAt: new Date() })
    .where(eq(sourceDocumentsTable.id, stored.id))
    .returning();
  return row!;
}

// Re-fetch an `active` source at most this often to confirm it's still live and
// unchanged. Shorter than the freshness (stale) window so a change / retraction /
// takedown surfaces before a source silently ages into `stale`.
const RECHECK_INTERVAL_DAYS = 7;
// Cap how many documents one recheck run re-fetches. Fetch-only (no embedding →
// free), but bounded so a single cron tick stays quick.
const RECHECK_BATCH = 10;

/** Transition counts from a lifecycle recheck run. */
export interface RecheckSummary {
  checked: number;
  unavailable: number;
  retracted: number;
  corrected: number;
  changed: number;
  unchanged: number;
}

/**
 * Re-fetch a URL for a lifecycle recheck and map the result to a RecheckOutcome.
 * A robots-block, definitive 404/410, or SSRF refusal is `gone` (→ unavailable);
 * any other fetch failure is `transient` (leave the document unchanged rather
 * than retiring a live source on a network blip).
 */
async function recheckFetch(url: string): Promise<RecheckOutcome> {
  const robots = await checkRobots(url);
  if (!robots.allowed) return { kind: "gone" };
  try {
    const extracted = await fetchAndExtract(url);
    return { kind: "fetched", text: extracted.text, contentHash: sha256(extracted.text) };
  } catch (err) {
    if (err instanceof UnsafeUrlError) return { kind: "gone" };
    if (err instanceof FetchError && (err.httpStatus === 404 || err.httpStatus === 410)) {
      return { kind: "gone" };
    }
    return { kind: "transient" };
  }
}

/**
 * Lifecycle recheck: re-fetch a bounded batch of `active` documents that are due
 * (last checked > RECHECK_INTERVAL_DAYS ago, honoring do-not-refetch) and apply
 * deterministic transitions via classifyRecheck — `unavailable` when the source
 * is gone (404/410 / robots-block / unsafe), `retracted` on a retraction notice,
 * and a correction flag + content_changed_at when the body changed. Fetch-only
 * (no embedding → free); never throws per document. A document that leaves
 * `active` is dropped from retrieval by the semanticSearch lifecycle filter.
 * Returns transition counts.
 */
export async function recheckActiveDocuments(
  now: Date = new Date(),
  limit: number = RECHECK_BATCH,
): Promise<RecheckSummary> {
  const summary: RecheckSummary = {
    checked: 0,
    unavailable: 0,
    retracted: 0,
    corrected: 0,
    changed: 0,
    unchanged: 0,
  };
  if (!isSourceVaultEnabled()) return summary;

  const cutoff = new Date(now.getTime() - RECHECK_INTERVAL_DAYS * 24 * 60 * 60 * 1000);
  const due = await db
    .select()
    .from(sourceDocumentsTable)
    .where(
      and(
        eq(sourceDocumentsTable.lifecycleStatus, "active"),
        eq(sourceDocumentsTable.doNotRefetch, false),
        sql`(${sourceDocumentsTable.lastCheckedAt} IS NULL OR ${sourceDocumentsTable.lastCheckedAt} < ${cutoff})`,
      ),
    )
    .orderBy(sql`${sourceDocumentsTable.lastCheckedAt} ASC NULLS FIRST`)
    .limit(limit);

  for (const doc of due) {
    try {
      const outcome = await recheckFetch(doc.url);
      const decision = classifyRecheck({ outcome, priorContentHash: doc.contentHash });

      const patch: Partial<SourceDocument> = { lastCheckedAt: now, updatedAt: new Date() };
      if (decision.lifecycleStatus) {
        patch.lifecycleStatus = decision.lifecycleStatus as SourceLifecycleStatus;
      }
      if (decision.correctionDetected !== null) patch.correctionDetected = decision.correctionDetected;
      if (decision.contentChanged && outcome.kind === "fetched") {
        patch.contentChangedAt = now;
        patch.contentHash = outcome.contentHash;
      }
      await db.update(sourceDocumentsTable).set(patch).where(eq(sourceDocumentsTable.id, doc.id));

      // Fire-and-forget cascade for any non-active lifecycle transition.
      if (decision.lifecycleStatus && decision.lifecycleStatus !== "active") {
        void cascadeSourceRetraction(doc.id, decision.lifecycleStatus);
      }

      summary.checked += 1;
      if (decision.lifecycleStatus === "unavailable") summary.unavailable += 1;
      else if (decision.lifecycleStatus === "retracted") summary.retracted += 1;
      else if (decision.correctionDetected) summary.corrected += 1;
      else if (decision.contentChanged) summary.changed += 1;
      else summary.unchanged += 1;
    } catch (err) {
      logger.warn({ err, url: doc.url }, "sourceVault: lifecycle recheck failed for document");
    }
  }
  return summary;
}

export interface ListDocumentsParams {
  authorityTier?: SourceAuthorityTier;
  status?: SourceDocStatus;
  lifecycleStatus?: SourceLifecycleStatus;
  beat?: string;
  duplicates?: "all" | "only" | "exclude";
  usefulness?: "published" | "evidence" | "draft" | "orphaned";
  q?: string;
  sort?:
    | "recent"
    | "updated"
    | "oldest_unreviewed"
    | "authority"
    | "oldest"
    | "quality"
    | "words"
    | "most_used";
  limit?: number;
  offset?: number;
  /** Filter to only the source documents snapshotted in this evidence packet. */
  packetId?: string;
}

export type SourceDocumentListItem = SourceDocument & { usageCount: number };

/**
 * Filtered, sorted, paginated document listing for the admin "source
 * intelligence" console. Returns each row plus a `usageCount` (how many articles
 * cite it, from article_sources) and the total row count for the active filter
 * so the UI can page. Sorting by `most_used` orders on that same usage subquery.
 */
export async function listDocuments(
  params: ListDocumentsParams = {},
): Promise<{ items: SourceDocumentListItem[]; total: number }> {
  const conds = [];
  if (params.authorityTier) conds.push(eq(sourceDocumentsTable.authorityTier, params.authorityTier));
  if (params.status) conds.push(eq(sourceDocumentsTable.status, params.status));
  if (params.lifecycleStatus)
    conds.push(eq(sourceDocumentsTable.lifecycleStatus, params.lifecycleStatus));
  if (params.beat) conds.push(eq(sourceDocumentsTable.beatSlug, params.beat));
  if (params.duplicates === "only") conds.push(isNotNull(sourceDocumentsTable.duplicateOfId));
  else if (params.duplicates === "exclude") conds.push(isNull(sourceDocumentsTable.duplicateOfId));
  // Usefulness — derived from the article↔source graph (article_sources joined to
  // articles). "published"/"draft" join through to the citing article's status;
  // "evidence" keys off the link role; "orphaned" is the absence of any link.
  if (params.usefulness === "published") {
    conds.push(
      sql`exists (select 1 from ${articleSourcesTable} asrc join ${articlesTable} art on art.id = asrc.article_id where asrc.source_document_id = ${sourceDocumentsTable.id} and art.status = 'published')`,
    );
  } else if (params.usefulness === "evidence") {
    conds.push(
      sql`exists (select 1 from ${articleSourcesTable} asrc where asrc.source_document_id = ${sourceDocumentsTable.id} and asrc.role = 'evidence')`,
    );
  } else if (params.usefulness === "draft") {
    conds.push(
      sql`exists (select 1 from ${articleSourcesTable} asrc join ${articlesTable} art on art.id = asrc.article_id where asrc.source_document_id = ${sourceDocumentsTable.id} and art.status in ('draft', 'scheduled'))`,
    );
  } else if (params.usefulness === "orphaned") {
    conds.push(
      sql`not exists (select 1 from ${articleSourcesTable} asrc where asrc.source_document_id = ${sourceDocumentsTable.id})`,
    );
  }
  const q = params.q?.trim();
  if (q) {
    const like = `%${q.toLowerCase()}%`;
    conds.push(
      sql`(lower(${sourceDocumentsTable.url}) like ${like} or lower(coalesce(${sourceDocumentsTable.title}, '')) like ${like} or lower(${sourceDocumentsTable.domain}) like ${like})`,
    );
  }
  if (params.packetId) {
    // Restrict to source documents whose id appears in the evidence packet's
    // snapshotted `sources` JSONB array (each element has an "id" string field).
    conds.push(
      sql`${sourceDocumentsTable.id}::text in (
        select jsonb_array_elements(ep.sources)->>'id'
        from evidence_packets ep
        where ep.id = ${params.packetId}::uuid
      )`,
    );
  }
  const whereExpr = conds.length ? and(...conds) : undefined;

  const usageCount = sql<number>`(select count(*)::int from ${articleSourcesTable} where ${articleSourcesTable.sourceDocumentId} = ${sourceDocumentsTable.id})`;

  // Strongest → weakest authority tier as a numeric rank so "authority" sort can
  // surface primary/firsthand sources first (unknown/unclassified sink to the bottom).
  const authorityRank = sql`case ${sourceDocumentsTable.authorityTier}
    when 'primary' then 6
    when 'firsthand' then 5
    when 'wire' then 4
    when 'commentary' then 3
    when 'social' then 2
    when 'aggregator' then 1
    else 0 end`;

  const orderBy = (() => {
    switch (params.sort) {
      case "updated":
        // Newest updated first; never-updated rows fall back to creation time.
        return [desc(sql`coalesce(${sourceDocumentsTable.updatedAt}, ${sourceDocumentsTable.createdAt})`)];
      case "oldest_unreviewed":
        // Never-rechecked (NULL lastCheckedAt) first, then least-recently checked.
        return [sql`${sourceDocumentsTable.lastCheckedAt} asc nulls first`, asc(sourceDocumentsTable.createdAt)];
      case "authority":
        return [desc(authorityRank), desc(sourceDocumentsTable.createdAt)];
      case "oldest":
        return [asc(sourceDocumentsTable.createdAt)];
      case "quality":
        return [desc(sourceDocumentsTable.qualityScore), desc(sourceDocumentsTable.createdAt)];
      case "words":
        return [desc(sourceDocumentsTable.wordCount), desc(sourceDocumentsTable.createdAt)];
      case "most_used":
        return [desc(usageCount), desc(sourceDocumentsTable.createdAt)];
      default:
        return [desc(sourceDocumentsTable.createdAt)];
    }
  })();

  const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
  const offset = Math.max(params.offset ?? 0, 0);

  const rows = await db
    .select({ doc: sourceDocumentsTable, usageCount })
    .from(sourceDocumentsTable)
    .where(whereExpr)
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset);

  const [countRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(sourceDocumentsTable)
    .where(whereExpr);

  return {
    items: rows.map((r) => ({ ...r.doc, usageCount: Number(r.usageCount) })),
    total: Number(countRow?.total ?? 0),
  };
}

export interface SourceRef {
  id: string;
  url: string;
  domain: string;
  title: string | null;
  status: SourceDocStatus;
  lifecycleStatus: SourceLifecycleStatus;
  authorityTier: SourceAuthorityTier | null;
  authoritySource: string | null;
  authorityReason: string | null;
  dedupeReason: string | null;
  fetchAllowed: boolean;
  paywallDetected: boolean;
  excerptOnly: boolean;
  qualityScore: number;
  wordCount: number;
  chunkCount: number;
  extractionMethod: string | null;
  canonicalUrl: string | null;
  publishedAt: Date | null;
  /** Composite representative score (with chunks) + human-readable reasons. */
  representativeScore: number;
  representativeReasons: string[];
}

export interface SourceArticleUsage {
  articleId: string;
  articleSlug: string;
  articleTitle: string;
  articleStatus: string;
  role: ArticleSourceRole;
  tier: string;
  status: ArticleSourceStatus;
  anchorText: string | null;
  url: string;
  createdAt: Date;
}

export interface RelatedSource {
  id: string;
  url: string;
  domain: string;
  title: string | null;
  authorityTier: SourceAuthorityTier | null;
  similarity: number;
}

export interface DocumentContext {
  duplicateOf: SourceRef | null;
  duplicates: SourceRef[];
  articles: SourceArticleUsage[];
  relatedSources: RelatedSource[];
  /** Composite representative score for THIS document (with chunks). */
  representativeScore: number;
  representativeReasons: string[];
}

const SOURCE_REF_COLUMNS = {
  id: sourceDocumentsTable.id,
  url: sourceDocumentsTable.url,
  domain: sourceDocumentsTable.domain,
  title: sourceDocumentsTable.title,
  status: sourceDocumentsTable.status,
  lifecycleStatus: sourceDocumentsTable.lifecycleStatus,
  authorityTier: sourceDocumentsTable.authorityTier,
  authoritySource: sourceDocumentsTable.authoritySource,
  authorityReason: sourceDocumentsTable.authorityReason,
  dedupeReason: sourceDocumentsTable.dedupeReason,
  fetchAllowed: sourceDocumentsTable.fetchAllowed,
  paywallDetected: sourceDocumentsTable.paywallDetected,
  excerptOnly: sourceDocumentsTable.excerptOnly,
  qualityScore: sourceDocumentsTable.qualityScore,
  wordCount: sourceDocumentsTable.wordCount,
  chunkCount: sourceDocumentsTable.chunkCount,
  extractionMethod: sourceDocumentsTable.extractionMethod,
  canonicalUrl: sourceDocumentsTable.canonicalUrl,
  publishedAt: sourceDocumentsTable.publishedAt,
} as const;

/** Attach the composite representative score (with chunks) to a raw ref row. */
function toSourceRef(row: Omit<SourceRef, "representativeScore" | "representativeReasons">): SourceRef {
  const score = computeRepresentativeScore(
    {
      authorityTier: row.authorityTier ?? "unknown",
      authoritySource: row.authoritySource,
      qualityScore: row.qualityScore,
      wordCount: row.wordCount,
      chunkCount: row.chunkCount,
      canonicalUrl: row.canonicalUrl,
      domain: row.domain,
      extractionMethod: row.extractionMethod,
      publishedAt: row.publishedAt,
      paywallDetected: row.paywallDetected,
      excerptOnly: row.excerptOnly,
      status: row.status,
      lifecycleStatus: row.lifecycleStatus,
    },
    { includeChunks: true },
  );
  return { ...row, representativeScore: score.total, representativeReasons: score.reasons };
}

/**
 * Relationship + provenance context for one document: the representative it
 * duplicates (if any), the docs that duplicate IT, the articles that cite it,
 * and the nearest other documents by STORED-vector similarity. The related
 * lookup reuses the persisted 384-dim chunk vectors only — it never calls the
 * embedding provider, so it adds no cost.
 */
export async function getDocumentContext(doc: SourceDocument): Promise<DocumentContext> {
  const duplicateOfPromise: Promise<SourceRef | null> = doc.duplicateOfId
    ? db
        .select(SOURCE_REF_COLUMNS)
        .from(sourceDocumentsTable)
        .where(eq(sourceDocumentsTable.id, doc.duplicateOfId))
        .limit(1)
        .then((rows) => (rows[0] ? toSourceRef(rows[0]) : null))
    : Promise.resolve(null);

  const duplicatesPromise = db
    .select(SOURCE_REF_COLUMNS)
    .from(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.duplicateOfId, doc.id))
    .orderBy(desc(sourceDocumentsTable.createdAt))
    .then((rows) => rows.map(toSourceRef));

  const articlesPromise: Promise<SourceArticleUsage[]> = db
    .select({
      articleId: articlesTable.id,
      articleSlug: articlesTable.slug,
      articleTitle: articlesTable.title,
      articleStatus: articlesTable.status,
      role: articleSourcesTable.role,
      tier: articleSourcesTable.tier,
      status: articleSourcesTable.status,
      anchorText: articleSourcesTable.anchorText,
      url: articleSourcesTable.url,
      createdAt: articleSourcesTable.createdAt,
    })
    .from(articleSourcesTable)
    .innerJoin(articlesTable, eq(articlesTable.id, articleSourcesTable.articleId))
    .where(eq(articleSourcesTable.sourceDocumentId, doc.id))
    .orderBy(desc(articleSourcesTable.createdAt));

  const [duplicateOf, duplicates, articles, relatedSources] = await Promise.all([
    duplicateOfPromise,
    duplicatesPromise,
    articlesPromise,
    getRelatedSources(doc.id),
  ]);

  const selfScore = computeRepresentativeScore(
    {
      authorityTier: doc.authorityTier ?? "unknown",
      authoritySource: doc.authoritySource,
      qualityScore: doc.qualityScore,
      wordCount: doc.wordCount,
      chunkCount: doc.chunkCount,
      canonicalUrl: doc.canonicalUrl,
      domain: doc.domain,
      extractionMethod: doc.extractionMethod,
      publishedAt: doc.publishedAt,
      paywallDetected: doc.paywallDetected,
      excerptOnly: doc.excerptOnly,
      status: doc.status,
      lifecycleStatus: doc.lifecycleStatus,
    },
    { includeChunks: true },
  );

  return {
    duplicateOf,
    duplicates,
    articles,
    relatedSources,
    representativeScore: selfScore.total,
    representativeReasons: selfScore.reasons,
  };
}

/**
 * Nearest other documents to `id` using ONLY the stored 384-dim chunk vectors:
 * cross-join this doc's chunks against every other doc's chunks, take the best
 * (minimum cosine distance) per other document, and return the closest few. No
 * embedding calls, so no spend. Returns [] when this doc has no 384-dim chunks.
 */
async function getRelatedSources(id: string, limit = 6): Promise<RelatedSource[]> {
  const rows = await db.execute<{ id: string; distance: number }>(sql`
    SELECT c2."document_id" AS id,
           MIN((c1."embedding"::vector(384)) <=> (c2."embedding"::vector(384))) AS distance
    FROM "source_chunks" c1
    JOIN "source_chunks" c2
      ON c2."document_id" <> c1."document_id" AND c2."dimensions" = 384
    WHERE c1."document_id" = ${id} AND c1."dimensions" = 384
    GROUP BY c2."document_id"
    ORDER BY distance ASC
    LIMIT ${limit}
  `);
  const hits = (rows.rows ?? rows) as Array<{ id: string; distance: number }>;
  if (hits.length === 0) return [];
  const byId = new Map(hits.map((h) => [h.id, Number(h.distance)]));
  const docs = await db
    .select({
      id: sourceDocumentsTable.id,
      url: sourceDocumentsTable.url,
      domain: sourceDocumentsTable.domain,
      title: sourceDocumentsTable.title,
      authorityTier: sourceDocumentsTable.authorityTier,
    })
    .from(sourceDocumentsTable)
    .where(inArray(sourceDocumentsTable.id, Array.from(byId.keys())));
  return docs
    .map((d) => ({ ...d, similarity: 1 - (byId.get(d.id) ?? 1) }))
    .sort((a, b) => b.similarity - a.similarity);
}

/**
 * Set a document's editorial lifecycle status (e.g. retract as junk). Optionally
 * flags `doNotRefetch` so the automated re-fetch loop leaves it alone, and
 * appends a short note to policyNotes for an audit trail. Manual retraction is
 * how an admin removes a bad source from retrieval WITHOUT deleting it.
 */
export async function setDocumentLifecycle(
  id: string,
  lifecycleStatus: SourceLifecycleStatus,
  opts: { doNotRefetch?: boolean; note?: string } = {},
): Promise<SourceDocument | null> {
  const existing = await getDocument(id);
  if (!existing) return null;
  const note = opts.note?.trim();
  const policyNotes = note
    ? [existing.policyNotes, note].filter(Boolean).join(" · ")
    : existing.policyNotes;
  const [row] = await db
    .update(sourceDocumentsTable)
    .set({
      lifecycleStatus,
      ...(opts.doNotRefetch === undefined ? {} : { doNotRefetch: opts.doNotRefetch }),
      policyNotes,
      lastCheckedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(sourceDocumentsTable.id, id))
    .returning();
  return row ?? null;
}

export async function getDocument(id: string): Promise<SourceDocument | null> {
  const [row] = await db
    .select()
    .from(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.id, id))
    .limit(1);
  return row ?? null;
}

/** A document's chunks WITHOUT the raw vectors (metadata only, for inspection). */
export async function getDocumentChunks(
  documentId: string,
): Promise<Array<Omit<SourceChunk, "embedding">>> {
  return db
    .select({
      id: sourceChunksTable.id,
      documentId: sourceChunksTable.documentId,
      chunkIndex: sourceChunksTable.chunkIndex,
      content: sourceChunksTable.content,
      contentHash: sourceChunksTable.contentHash,
      charCount: sourceChunksTable.charCount,
      embeddingProvider: sourceChunksTable.embeddingProvider,
      embeddingModel: sourceChunksTable.embeddingModel,
      dimensions: sourceChunksTable.dimensions,
      createdAt: sourceChunksTable.createdAt,
    })
    .from(sourceChunksTable)
    .where(eq(sourceChunksTable.documentId, documentId))
    .orderBy(sourceChunksTable.chunkIndex);
}

/**
 * Manually pin (or clear) a document's authority tier. A manual pin sets
 * authoritySource='manual' so it PERSISTS across re-ingest/recheck (resolveAuthority
 * skips the auto classifier for manual docs). Passing tier=null reverts to auto:
 * the domain classifier is re-run immediately so the row reflects the auto tier.
 */
export async function setDocumentAuthority(
  id: string,
  tier: SourceAuthorityTier | null,
  reason?: string,
): Promise<SourceDocument | null> {
  const existing = await getDocument(id);
  if (!existing) return null;
  const patch =
    tier === null
      ? (() => {
          const c = classifyAuthority(existing.domain);
          return { authorityTier: c.tier, authoritySource: "auto" as const, authorityReason: c.reason };
        })()
      : {
          authorityTier: tier,
          authoritySource: "manual" as const,
          authorityReason: reason?.trim() || "manual override",
        };
  const [row] = await db
    .update(sourceDocumentsTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(sourceDocumentsTable.id, id))
    .returning();
  return row ?? null;
}

/**
 * Promote a document as the canonical representative: record (or clear) its
 * canonical URL and/or pin an authority tier in one action. Setting a tier here
 * marks authoritySource='manual' so it persists across re-ingest, exactly like
 * setDocumentAuthority. Passing canonicalUrl=null/empty clears the stored value.
 * At least one of canonicalUrl / tier should be provided; a no-op patch simply
 * touches updatedAt and returns the row unchanged.
 */
export async function promoteCanonical(
  id: string,
  opts: {
    canonicalUrl?: string | null;
    tier?: SourceAuthorityTier;
    reason?: string;
  } = {},
): Promise<SourceDocument | null> {
  const existing = await getDocument(id);
  if (!existing) return null;
  const patch: Partial<typeof sourceDocumentsTable.$inferInsert> = { updatedAt: new Date() };
  if (opts.canonicalUrl !== undefined) {
    const trimmed = opts.canonicalUrl?.trim();
    patch.canonicalUrl = trimmed ? trimmed : null;
  }
  if (opts.tier) {
    patch.authorityTier = opts.tier;
    patch.authoritySource = "manual";
    patch.authorityReason = opts.reason?.trim() || "promoted as canonical";
  }
  const [row] = await db
    .update(sourceDocumentsTable)
    .set(patch)
    .where(eq(sourceDocumentsTable.id, id))
    .returning();
  return row ?? null;
}

/** Error thrown when a representative swap is not applicable. */
export class NotADuplicateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotADuplicateError";
  }
}

/**
 * Manually swap the family representative: promote a duplicate to be the
 * family's canonical, retrievable copy. The whole swap is one transaction so
 * a family is never half-swapped. Final state:
 *   target.duplicateOfId = null            (it IS the representative)
 *   oldRep.duplicateOfId = target.id       (demoted under the new rep)
 *   all other duplicates → target.id
 *   every family member's sourceFamilyId = target.id   (Option B invariant)
 *   old rep chunks deleted (no longer retrievable)
 * Embedding of the new representative happens AFTER commit, best-effort — the
 * regular re-embed sweep picks it up later if the immediate attempt is skipped
 * or fails (budget, provider not configured, …).
 */
export async function makeRepresentative(
  id: string,
): Promise<{ document: SourceDocument; embedded: boolean; note: string }> {
  const document = await db.transaction(async (tx) => {
    // 0. Lock + re-read the target inside the transaction so a concurrent
    //    ingest/dedup or another swap cannot interleave with this one.
    const [target] = await tx
      .select()
      .from(sourceDocumentsTable)
      .where(eq(sourceDocumentsTable.id, id))
      .limit(1)
      .for("update");
    if (!target) throw new NotADuplicateError("Document not found");
    if (!target.duplicateOfId) {
      throw new NotADuplicateError("Document is already a family representative");
    }

    // Resolve the family ROOT representative. Legacy data may have chains
    // (target → A → B where B is the real rep); walk up with row locks so the
    // whole chain is normalized under the new rep, not just the direct parent.
    const chainIds: string[] = [];
    let rootId = target.duplicateOfId;
    for (let hops = 0; hops < 20; hops++) {
      const [parent] = await tx
        .select({
          id: sourceDocumentsTable.id,
          duplicateOfId: sourceDocumentsTable.duplicateOfId,
        })
        .from(sourceDocumentsTable)
        .where(eq(sourceDocumentsTable.id, rootId))
        .limit(1)
        .for("update");
      if (!parent) break;
      if (!parent.duplicateOfId || parent.duplicateOfId === target.id || chainIds.includes(parent.duplicateOfId)) break;
      chainIds.push(parent.id);
      rootId = parent.duplicateOfId;
    }

    const now = new Date();
    // 1. Target becomes the representative (and rejoins retrieval if it had
    //    been retired as superseded).
    const [updated] = await tx
      .update(sourceDocumentsTable)
      .set({
        duplicateOfId: null,
        dedupeReason: null,
        sourceFamilyId: target.id,
        supersededById: null,
        lifecycleStatus: target.lifecycleStatus === "superseded" ? "active" : target.lifecycleStatus,
        updatedAt: now,
      })
      .where(eq(sourceDocumentsTable.id, target.id))
      .returning();
    // 2. The old root representative is demoted under the new one.
    await tx
      .update(sourceDocumentsTable)
      .set({
        duplicateOfId: target.id,
        dedupeReason: "manually demoted — admin chose another representative",
        sourceFamilyId: target.id,
        lifecycleStatus: "superseded",
        supersededById: target.id,
        updatedAt: now,
      })
      .where(eq(sourceDocumentsTable.id, rootId));
    // 3. EVERY other family member points at the new representative: docs in
    //    the parent chain, direct duplicates of any chain node or the old
    //    root, and anything sharing the family key (Option B invariant:
    //    sourceFamilyId always equals the current rep's id).
    const familyKeys = [rootId, ...chainIds, ...(target.sourceFamilyId ? [target.sourceFamilyId] : [])];
    await tx
      .update(sourceDocumentsTable)
      .set({ duplicateOfId: target.id, sourceFamilyId: target.id, updatedAt: now })
      .where(
        and(
          ne(sourceDocumentsTable.id, target.id),
          ne(sourceDocumentsTable.id, rootId),
          or(
            inArray(sourceDocumentsTable.id, familyKeys),
            inArray(sourceDocumentsTable.duplicateOfId, familyKeys),
            inArray(sourceDocumentsTable.sourceFamilyId, familyKeys),
          ),
        ),
      );
    // 4. Claims point at chunk IDs and inherit the representative's family ID.
    // Remove them before deleting the chunks so stale evidence cannot survive
    // a representative swap or be counted as a second independent family.
    await tx.delete(vaultClaimsTable).where(eq(vaultClaimsTable.sourceDocumentId, rootId));
    await tx
      .delete(claimExtractionReceiptsTable)
      .where(eq(claimExtractionReceiptsTable.sourceDocumentId, rootId));
    // The demoted rep must no longer be retrievable.
    await tx.delete(sourceChunksTable).where(eq(sourceChunksTable.documentId, rootId));
    await tx
      .update(sourceDocumentsTable)
      .set({ status: "extracted", chunkCount: 0, updatedAt: now })
      .where(and(eq(sourceDocumentsTable.id, rootId), eq(sourceDocumentsTable.status, "embedded")));
    return updated!;
  });

  // After commit: best-effort immediate embed of the new representative, using
  // the same gates as the ingest path. Failure here is non-fatal — the
  // re-embed sweep will retry on the next cron tick.
  if (
    document.status === "extracted" &&
    document.chunkCount === 0 &&
    (document.extractedText ?? "").trim().length > 0 &&
    isSourceVaultEnabled() &&
    isEmbeddingConfigured()
  ) {
    try {
      const guard = await VaultBudgetGuard.start("make representative", {
        paid: isEmbeddingPaid(),
        now: new Date(),
      });
      const { document: embeddedDoc, chunkCount } = await embedAndStoreChunks(
        document.id,
        document.extractedText ?? "",
        guard,
      );
      return {
        document: embeddedDoc,
        embedded: true,
        note: `Now the family representative; embedded with ${chunkCount} chunks.`,
      };
    } catch (err) {
      logger.warn(
        { err: dbErrSummary(err), documentId: document.id },
        "makeRepresentative: immediate embed failed",
      );
      return {
        document,
        embedded: false,
        note: "Now the family representative. Embedding will be retried automatically.",
      };
    }
  }

  return {
    document,
    embedded: document.status === "embedded",
    note:
      document.status === "embedded"
        ? "Now the family representative (already embedded)."
        : "Now the family representative. Embedding will run automatically when eligible.",
  };
}

export async function deleteDocument(id: string): Promise<boolean> {
  const rows = await db
    .delete(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.id, id))
    .returning({ id: sourceDocumentsTable.id });
  return rows.length > 0;
}

/**
 * Re-run the domain classifier on every auto-classified document.
 * Manually-pinned rows (authoritySource = 'manual') are never touched.
 * Includes title and excerpt in the classification so review-article signals
 * (systematic review, meta-analysis, etc.) correctly downgrade primary-tier
 * preprint/journal docs to `reported` — matching the live ingest path.
 * Returns counts of updated vs unchanged rows.
 */
export async function reclassifyAutoDomains(): Promise<{ updated: number; unchanged: number }> {
  const docs = await db
    .select({
      id: sourceDocumentsTable.id,
      url: sourceDocumentsTable.url,
      title: sourceDocumentsTable.title,
      excerpt: sourceDocumentsTable.excerpt,
      authorityTier: sourceDocumentsTable.authorityTier,
    })
    .from(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.authoritySource, "auto"));

  let updated = 0;
  let unchanged = 0;

  for (const doc of docs) {
    // Pass null for `existing` (we've already filtered to auto-only) so the
    // review-article downgrade check applies — same logic as the live ingest path.
    const { authorityTier: tier, authorityReason: reason } = resolveAuthority(
      null,
      doc.url,
      doc.title,
      doc.excerpt,
    );
    if (tier === doc.authorityTier) {
      unchanged++;
      continue;
    }
    await db
      .update(sourceDocumentsTable)
      .set({ authorityTier: tier, authorityReason: reason, updatedAt: new Date() })
      .where(eq(sourceDocumentsTable.id, doc.id));
    updated++;
  }

  return { updated, unchanged };
}

// Maximum documents the repair sweep corrects in one run. Keeps each cron tick
// bounded; subsequent daily ticks drain any residual back-catalog.
const REPAIR_REVIEW_BATCH = 500;

// SQL ILIKE patterns mirroring the REVIEW_TITLE_RE regex terms. These act as a
// DB-side pre-filter: only docs whose title or excerpt already signal literature
// synthesis are fetched, so non-review primaries are NEVER included in the
// candidate set. Because matched rows are then updated to `reported` (dropping
// out of the primary tier), every successful run makes monotonic progress toward
// zero remaining misclassified docs — the bounded LIMIT can never cause the sweep
// to get stuck re-scanning the same non-review prefix forever.
const REVIEW_SIGNAL_PATTERNS = [
  "%systematic review%",
  "%meta-analysis%",
  "%meta analysis%",
  "%a review of%",
  "%literature review%",
  "%scoping review%",
  "%narrative review%",
  "%cochrane review%",
  "%integrative review%",
];

/**
 * Repair sweep: find auto-classified `primary` documents whose title (populated
 * after initial ingest) now matches a review-article signal — systematic review,
 * meta-analysis, etc. — and downgrade them to `reported`.
 *
 * Preprint servers (arxiv.org, biorxiv.org, medrxiv.org, ssrn.com) and academic
 * journal domains classify as `primary` by default. When a URL is first stored
 * (e.g. during robots-block or a feed enqueue) the title can be null, so the
 * review-article downgrade in `resolveAuthority` never fires. This sweep corrects
 * that misclassification once the title is written.
 *
 * Review-signal patterns are pushed into the SQL WHERE clause (ILIKE), so only
 * actual candidates are fetched. The in-process `isReviewArticleTitle` check
 * applies word-boundary precision on top. Because matched rows are updated to
 * `reported`, they leave the `primary` tier and cannot re-appear in future runs —
 * monotonic drain is guaranteed regardless of how many non-review primary docs
 * exist in the vault.
 *
 * Manually-pinned rows (authoritySource = 'manual') are never touched.
 */
export async function repairMisclassifiedReviewArticles(
  limit = REPAIR_REVIEW_BATCH,
): Promise<{ repaired: number }> {
  const bounded = Math.min(Math.max(limit, 1), REPAIR_REVIEW_BATCH);

  // Build SQL OR conditions: title ILIKE any_pattern OR excerpt ILIKE any_pattern.
  // PostgreSQL ILIKE on a NULL column returns NULL (false), so null excerpts are
  // skipped safely without an explicit IS NOT NULL guard.
  const signalConditions = REVIEW_SIGNAL_PATTERNS.flatMap((p) => [
    ilike(sourceDocumentsTable.title, p),
    ilike(sourceDocumentsTable.excerpt, p),
  ]);

  const candidates = await db
    .select({
      id: sourceDocumentsTable.id,
      url: sourceDocumentsTable.url,
      title: sourceDocumentsTable.title,
      excerpt: sourceDocumentsTable.excerpt,
    })
    .from(sourceDocumentsTable)
    .where(
      and(
        eq(sourceDocumentsTable.authoritySource, "auto"),
        eq(sourceDocumentsTable.authorityTier, "primary"),
        isNotNull(sourceDocumentsTable.title),
        or(...signalConditions),
      ),
    )
    .orderBy(asc(sourceDocumentsTable.createdAt))
    .limit(bounded);

  let repaired = 0;
  for (const doc of candidates) {
    // isReviewArticleTitle applies word-boundary precision (REVIEW_TITLE_RE) on
    // top of the SQL ILIKE pre-filter — guards against any ILIKE false positives.
    if (!isReviewArticleTitle(doc.title ?? "", doc.excerpt)) continue;
    const c = classifyAuthority(doc.url);
    await db
      .update(sourceDocumentsTable)
      .set({
        authorityTier: "reported",
        authorityReason: `review article (title/abstract signals literature synthesis) from ${c.reason}`,
        updatedAt: new Date(),
      })
      .where(eq(sourceDocumentsTable.id, doc.id));
    repaired++;
  }

  return { repaired };
}

export async function listRecentJobs(limit = 20): Promise<SourceVaultJob[]> {
  return db
    .select()
    .from(sourceVaultJobsTable)
    .orderBy(desc(sourceVaultJobsTable.createdAt))
    .limit(limit);
}

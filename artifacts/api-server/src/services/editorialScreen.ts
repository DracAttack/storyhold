import {
  db,
  sourceDocumentsTable,
  evidencePacketsTable,
  trendMarkersTable,
  articlesTable,
  articleSourcesTable,
  topicIdeasTable,
  type SourceDocument,
  type EvidencePacket,
  type EvidenceResearchMode,
  type PacketSource,
  type PacketChunk,
  type PacketClaim,
  type PacketContradiction,
  type PacketQuote,
  type PacketRetrievalContext,
  type ArticleBlock,
  type VerificationReport,
  type Author,
  type TopicIdea,
} from "@workspace/db";
import { and, count, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { recordArticleClaimUses } from "./claimGraph";
import { stripInternalArticleLinks } from "./verificationText";
import { getStoryCluster, listStoryClusters } from "./storyClusters";
import { AUTHORITY_TIER_ORDER, isTrustedAuthorityTier } from "./clusterScore";
import type { SourceAuthorityTier } from "@workspace/db";
import {
  llmEditorialScreen,
  llmVerifyDraftAgainstPacket,
  AiFunctionDisabledError,
  type EditorialScreenInput,
  type EditorialScreenSourceInput,
} from "./llm";
import { semanticSearch, searchGlossaryConcepts } from "./sourceVault";
import { planConceptRetrieval } from "./conceptEdges";
import { syntheticEdgeSimilarity } from "./conceptQueryPlanner";
import {
  extractRequiredEntities,
  sourceIsOnCase,
  assignSourceRole,
  isCorePacketRole,
  type RequiredEntities,
} from "./packetRelevance";
import { EmbeddingNotConfiguredError, isEmbeddingConfigured } from "./embeddings";
import { findOverlappingArticles } from "./dedupe";
import { PerplexityNotConfiguredError } from "./perplexity";
import { researchWithFallback, isResearchCapabilityAvailable } from "./researchFallback";
import { VaultBudgetGuard, VaultBudgetExceededError } from "./sourceVaultBudget";
import { isAiFunctionEnabled } from "./aiSettings";

// --- Editorial screening & evidence packets (Task #200) -----------------
// Applies the CHEAP editorial-screen AI to an already-qualified story cluster to
// force an editorial decision, then snapshots the evidence into an IMMUTABLE,
// VERSIONED packet. The research gate is vault-first: the newsroom's own memory
// (chunks + existing articles + prior packets) is consulted BEFORE any paid
// Perplexity Sonar call, and Deep Research is off unless explicitly requested
// and within the vault budget. This module does NOT draft, verify, publish, or
// touch media — it only decides + records evidence.

export class EditorialScreenError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "EditorialScreenError";
  }
}

export interface BuildPacketOptions {
  // How much research to use. Defaults to vault_only (no paid call). sonar /
  // deep_research escalate to Perplexity ONLY within budget; on any budget or
  // config failure the build degrades cleanly back to vault_only.
  research?: EvidenceResearchMode;
  // Skip rebuilding when the latest packet's source fingerprint is unchanged
  // (used by the auto-screen so a stable cluster is screened only once). Manual
  // triggers leave this false to always produce a fresh version on demand.
  skipIfUnchanged?: boolean;
  // The editorial-screen model call. Defaults to the real llmEditorialScreen;
  // injectable so concurrency tests can drive a deterministic decision and
  // exercise the real version-allocation / unique-constraint retry loop without
  // a network/model call. Production callers never set this.
  screen?: typeof llmEditorialScreen;
}

export interface BuildPacketResult {
  packet: EvidencePacket;
  created: boolean;
}

// Normalize text for verbatim quote verification: collapse whitespace + lower.
function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

// Rank sources strongest authority first, then most-recent, then id for a
// stable deterministic order.
function orderByAuthority(docs: SourceDocument[]): SourceDocument[] {
  return [...docs].sort((a, b) => {
    const ra = AUTHORITY_TIER_ORDER.indexOf(a.authorityTier as SourceAuthorityTier);
    const rb = AUTHORITY_TIER_ORDER.indexOf(b.authorityTier as SourceAuthorityTier);
    const na = ra === -1 ? AUTHORITY_TIER_ORDER.length : ra;
    const nb = rb === -1 ? AUTHORITY_TIER_ORDER.length : rb;
    if (na !== nb) return na - nb;
    const ta = (a.publishedAt ?? a.fetchedAt)?.getTime() ?? 0;
    const tb = (b.publishedAt ?? b.fetchedAt)?.getTime() ?? 0;
    if (ta !== tb) return tb - ta;
    return a.id.localeCompare(b.id);
  });
}

// A stable fingerprint of the cluster's member sources: ids + lifecycle +
// updated timestamps. Changes whenever a source is added/removed or mutated.
function fingerprintSources(docs: SourceDocument[]): string {
  return docs
    .map((d) => `${d.id}:${d.lifecycleStatus}:${d.updatedAt?.getTime() ?? 0}`)
    .sort()
    .join("|");
}

function toPacketSource(d: SourceDocument, entities?: RequiredEntities): PacketSource {
  const base: PacketSource = {
    id: d.id,
    url: d.url,
    domain: d.domain,
    title: d.title,
    author: d.author,
    authorityTier: d.authorityTier,
    lifecycleStatus: d.lifecycleStatus,
    publishedAt: d.publishedAt?.toISOString() ?? null,
    fetchedAt: d.fetchedAt?.toISOString() ?? null,
    excerptOnly: d.excerptOnly,
    paywallDetected: d.paywallDetected,
    sourceFamilyId: d.sourceFamilyId,
  };
  if (entities) {
    base.role = assignSourceRole({
      onCase: sourceIsOnCase(`${d.title ?? ""} ${sourceExcerpt(d)}`, entities),
      authorityTier: d.authorityTier,
      domain: d.domain,
      title: d.title,
      url: d.url,
    });
  }
  return base;
}

// The excerpt shown to the screen model for a source — prefer the extracted
// body, fall back to the stored excerpt/lead snippet.
function sourceExcerpt(d: SourceDocument): string {
  return (d.extractedText || d.excerpt || d.leadSnippet || "").trim();
}

/** The latest (highest-version) packet for a cluster, or null. */
export async function getLatestPacket(clusterId: string): Promise<EvidencePacket | null> {
  const [row] = await db
    .select()
    .from(evidencePacketsTable)
    .where(eq(evidencePacketsTable.clusterId, clusterId))
    .orderBy(desc(evidencePacketsTable.version))
    .limit(1);
  return row ?? null;
}

/** All packet versions for a cluster, newest version first. */
export async function listPackets(clusterId: string): Promise<EvidencePacket[]> {
  return db
    .select()
    .from(evidencePacketsTable)
    .where(eq(evidencePacketsTable.clusterId, clusterId))
    .orderBy(desc(evidencePacketsTable.version));
}

/** A single packet by id, or null. */
export async function getPacket(id: string): Promise<EvidencePacket | null> {
  const [row] = await db
    .select()
    .from(evidencePacketsTable)
    .where(eq(evidencePacketsTable.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Build (and persist) an evidence packet for one qualified cluster. Loads the
 * cluster's full source documents, gathers vault-first retrieval context,
 * optionally escalates to a paid research call (within budget), runs the cheap
 * editorial-screen model, and inserts a new immutable version. Returns the
 * packet plus whether a new version was created (false = returned an unchanged
 * existing packet when skipIfUnchanged was set).
 */
export async function buildEvidencePacket(
  clusterId: string,
  opts: BuildPacketOptions = {},
): Promise<BuildPacketResult> {
  const requested: EvidenceResearchMode = opts.research ?? "vault_only";
  const cluster = await getStoryCluster(clusterId);
  if (!cluster) throw new EditorialScreenError(404, "Story cluster not found.");

  // Load FULL source documents (getStoryCluster only returns summaries; we need
  // the policy + body fields for quote verification and the excerpt).
  const docs = await db
    .select()
    .from(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.clusterId, clusterId));
  if (docs.length === 0) {
    throw new EditorialScreenError(422, "Cluster has no source documents to screen.");
  }

  const ordered = orderByAuthority(docs);
  const fingerprint = fingerprintSources(ordered);

  const prior = await getLatestPacket(clusterId);
  if (opts.skipIfUnchanged && prior && prior.sourcesFingerprint === fingerprint) {
    return { packet: prior, created: false };
  }

  // --- Vault-first retrieval context (always, no paid call) ---------------
  // Concept-aware expansion (Task #338): if the cluster mentions glossary
  // concepts, append their aliases/related terms so retrieval also finds
  // sources phrased in the concept's other vocabulary. No match = identical
  // query; planConceptRetrieval never throws.
  const baseQuery = [cluster.label, ...cluster.keywords].filter(Boolean).join(" ");
  const conceptPlan = await planConceptRetrieval(baseQuery);
  const query = [baseQuery, ...conceptPlan.expansionTerms].join(" ").slice(0, 400);

  let chunks: PacketChunk[] = [];
  if (isEmbeddingConfigured()) {
    try {
      const hits = await semanticSearch(query, { limit: 8 });
      chunks = hits.map((h) => ({
        chunkId: h.chunkId,
        documentId: h.documentId,
        content: h.content,
        similarity: h.similarity,
      }));
    } catch (err) {
      // Degrade cleanly — retrieval is a bonus, not a hard dependency.
      if (!(err instanceof EmbeddingNotConfiguredError)) {
        logger.warn({ err, clusterId }, "editorial screen: semanticSearch failed; continuing vault-only without chunks");
      }
    }
  }

  let existingArticleTitles: string[] = [];
  try {
    const overlaps = await findOverlappingArticles(cluster.label, cluster.keywords.join(" "), {
      threshold: 0.2,
      limit: 6,
    });
    existingArticleTitles = overlaps.map((o) => o.article.title);
  } catch (err) {
    logger.warn({ err, clusterId }, "editorial screen: overlap lookup failed; continuing");
  }

  // --- Optional paid research escalation (vault-first gate) ----------------
  let researchMode: EvidenceResearchMode = "vault_only";
  let researchNote: string | null = null;
  let sonarUsed = false;
  if (requested !== "vault_only") {
    if (!(await isResearchCapabilityAvailable())) {
      researchNote = "Paid research requested but no research provider is configured; used vault only.";
    } else {
      try {
        const guard = await VaultBudgetGuard.start(`editorial research ${clusterId}`, { paid: true });
        await guard.check();
        const deep = requested === "deep_research";
        const sys =
          "You are a newsroom research assistant. Given a story topic, return a concise, factual briefing of the most important verified facts, key figures, dates, and any notable disagreements between sources. Be terse and cite what you can.";
        const user = `Topic: ${cluster.label}\nBeat: ${cluster.beat}\nKeywords: ${cluster.keywords.join(", ")}`;
        const res = await researchWithFallback(sys, user, {
          deep,
          maxTokens: 1200,
          operation: "editorialResearch",
        });
        researchMode = deep ? "deep_research" : "sonar";
        sonarUsed = true;
        researchNote = res.content
          ? res.content + (res.citations.length ? `\n\nSources: ${res.citations.join(", ")}` : "")
          : "Research call returned no content.";
      } catch (err) {
        if (err instanceof VaultBudgetExceededError) {
          researchNote = `Paid research skipped (${err.message}); used vault only.`;
        } else if (err instanceof PerplexityNotConfiguredError) {
          researchNote = "Paid research requested but Perplexity is not configured; used vault only.";
        } else {
          logger.warn({ err, clusterId }, "editorial screen: paid research failed; degrading to vault-only");
          researchNote = "Paid research failed; used vault only.";
        }
      }
    }
  }

  // --- The cheap forced editorial decision ---------------------------------
  const screenSources: EditorialScreenSourceInput[] = ordered.map((d, i) => ({
    index: i + 1,
    authorityTier: d.authorityTier,
    domain: d.domain,
    title: d.title,
    author: d.author,
    publishedAt: d.publishedAt?.toISOString() ?? null,
    lifecycleStatus: d.lifecycleStatus,
    excerpt: sourceExcerpt(d),
  }));

  const input: EditorialScreenInput = {
    cluster: {
      label: cluster.label,
      beat: cluster.beat,
      score: cluster.score,
      keywords: cluster.keywords,
    },
    sources: screenSources,
    chunks: chunks.map((c) => c.content),
    existingArticles: existingArticleTitles,
    prior: prior ? { version: prior.version, decision: prior.decision } : null,
    research: researchNote,
    clusterId,
  };

  let screen;
  try {
    screen = await (opts.screen ?? llmEditorialScreen)(input);
  } catch (err) {
    if (err instanceof AiFunctionDisabledError) {
      throw new EditorialScreenError(409, "Editorial screening is paused in the AI Control Center.");
    }
    throw err;
  }

  // --- Map model source-indexes back to real source ids --------------------
  const byIndex = new Map<number, SourceDocument>();
  ordered.forEach((d, i) => byIndex.set(i + 1, d));
  const idxToId = (n: number): string | null => byIndex.get(n)?.id ?? null;
  const idxsToIds = (ns: number[]): string[] => {
    const ids = ns.map(idxToId).filter((v): v is string => v !== null);
    return Array.from(new Set(ids));
  };

  const claims: PacketClaim[] = screen.claims.map((c) => ({
    text: c.text,
    sourceIds: idxsToIds(c.sourceIndexes),
  }));
  const contradictions: PacketContradiction[] = screen.contradictions.map((c) => ({
    summary: c.summary,
    sourceIds: idxsToIds(c.sourceIndexes),
  }));

  // Verify quotes against the stored source text and compute the allowed-to-
  // quote policy flag. Offsets are null (the vault stores chunk text, not
  // character offsets into the original page).
  const quoteCandidates: PacketQuote[] = screen.quoteCandidates.map((q) => {
    const src = q.sourceIndex != null ? byIndex.get(q.sourceIndex) ?? null : null;
    const sourceId = src?.id ?? null;
    let verified = false;
    if (src) {
      const haystack = normalizeForMatch(sourceExcerpt(src));
      const needle = normalizeForMatch(q.text);
      verified = needle.length > 0 && haystack.includes(needle);
    }
    const allowedToQuote =
      verified &&
      !!src &&
      src.lifecycleStatus === "active" &&
      src.fetchAllowed &&
      !src.paywallDetected;
    return {
      text: q.text,
      attribution: q.attribution,
      sourceId,
      offsetStart: null,
      offsetEnd: null,
      verified,
      allowedToQuote,
    };
  });

  // Roles are DISPLAY-ONLY on the cluster path: cluster members are
  // case-specific by construction (they were clustered onto this story), so
  // the role never changes the cluster decision or the authority floor here.
  const clusterEntities = extractRequiredEntities(cluster.label, cluster.keywords.join(" "));
  const packetSources: PacketSource[] = ordered.map((d) => toPacketSource(d, clusterEntities));
  const topAuthorityTier = packetSources[0]?.authorityTier ?? null;

  // --- Deterministic authority floor ---------------------------------------
  // A packet may only auto-approve for drafting when at least one TRUSTED-tier
  // source (primary / government-academic, wire, or an established outlet's
  // firsthand reporting) corroborates it. Unknown, niche, and self-published
  // leads are allowed into discovery and into the packet, but cannot clear the
  // bar on their own — so an approve_draft backed solely by weak sources is
  // downgraded to needs_human_editor and surfaced for a human. The human can
  // review it or promote a source into a trusted tier in Source Vault (which
  // makes isTrustedAuthorityTier true and lets a re-screen approve). Only an
  // ACTIVE trusted source counts — a superseded/removed one can't vouch. This
  // runs on the REAL classified sources, independent of the model's judgment.
  const hasTrustedCorroboration = ordered.some(
    (d) =>
      d.lifecycleStatus === "active" &&
      isTrustedAuthorityTier(d.authorityTier as SourceAuthorityTier | null),
  );
  let decision = screen.decision;
  let decisionReasons = screen.reasons;
  if (decision === "approve_draft" && !hasTrustedCorroboration) {
    decision = "needs_human_editor";
    // Count non-dismissed trend markers on this cluster so the held reason can
    // distinguish "quiet, no evidence" from "buzzing on social but unverified" —
    // markers are a velocity signal ONLY and can never clear the authority floor.
    let markerCount = 0;
    try {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(trendMarkersTable)
        .where(
          and(
            eq(trendMarkersTable.clusterId, clusterId),
            ne(trendMarkersTable.status, "dismissed"),
          ),
        );
      markerCount = Number(row?.n ?? 0);
    } catch (err) {
      logger.warn({ err, clusterId }, "editorial screen: marker count lookup failed");
    }
    const buzzNote =
      markerCount > 0
        ? ` There ${markerCount === 1 ? "is" : "are"} ${markerCount} trend marker${
            markerCount === 1 ? "" : "s"
          } (social buzz) on this story, but social markers are a public-interest signal only — they do not count as evidence. Escalate a marker to verify it before it can corroborate.`
        : "";
    decisionReasons = [
      ...screen.reasons,
      "Held for a human: no trusted-tier source (primary, government/academic, wire, or established outlet) corroborates this yet — only unknown or self-published leads. Add or manually promote a trusted source in Source Vault before drafting." +
        buzzNote,
    ];
  }

  const retrievalContext: PacketRetrievalContext = {
    query,
    vaultHitCount: chunks.length,
    existingArticleTitles,
    priorPacketVersion: prior?.version ?? null,
    priorDecision: prior?.decision ?? null,
    sonarUsed,
    researchNote,
    generatedAt: new Date().toISOString(),
  };

  const baseValues = {
    clusterId,
    beatSlug: cluster.beatSlug,
    beat: cluster.beat,
    label: cluster.label,
    decision,
    decisionReasons,
    doNotDraftReason: screen.doNotDraftReason,
    researchMode,
    model: screen.model,
    sources: packetSources,
    supportingChunks: chunks,
    claims,
    contradictions,
    quoteCandidates,
    retrievalContext,
    sourcesFingerprint: fingerprint,
    sourceCount: packetSources.length,
    topAuthorityTier,
  };

  // Version allocation must be serialized per cluster: two concurrent
  // screenings (manual /screen + cron overlap, or an admin double-click) that
  // both read the same current max version would compute the same next version
  // and collide on the unique(cluster_id, version) index. A bare
  // read-then-insert with a fixed-attempt retry stampedes under >2 concurrency
  // (only one writer wins per round, so a handful of racers exhausts the
  // attempts and 500s). Instead, take a transaction-scoped Postgres advisory
  // lock keyed on the cluster (same pattern as the guarded migrations in
  // seed.ts) so the read-max + insert is atomic per cluster: every caller gets a
  // distinct, monotonic version and no insert ever conflicts.
  const inserted = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`evidence_packet_version:${clusterId}`}))`,
    );
    const [current] = await tx
      .select({ version: evidencePacketsTable.version })
      .from(evidencePacketsTable)
      .where(eq(evidencePacketsTable.clusterId, clusterId))
      .orderBy(desc(evidencePacketsTable.version))
      .limit(1);
    const nextVersion = (current?.version ?? 0) + 1;
    const [row] = await tx
      .insert(evidencePacketsTable)
      .values({ ...baseValues, version: nextVersion })
      .returning();
    return row;
  });

  if (!inserted) throw new EditorialScreenError(500, "Failed to persist evidence packet.");
  const nextVersion = inserted.version;
  logger.info(
    { clusterId, version: nextVersion, decision, researchMode, sources: packetSources.length },
    "editorial screen: packet created",
  );
  return { packet: inserted, created: true };
}

// --- Auto-grounding a manual idea from the Source Vault (Task #233) ----------
// A manual idea has no story cluster, so buildEvidencePacket (cluster-centric)
// can't ground it. buildEvidencePacketForIdea reuses the SAME vault-first
// retrieval + screening + version-allocation machinery but drives it from an
// idea + author: it semantic-searches the vault, auto-selects the strongest
// supporting sources/chunks (no editor picking), enforces the same deterministic
// authority floor, and — when the vault is strong enough — inserts an immutable
// packet keyed on the idea id (its synthetic "cluster"). On pass it attaches the
// new evidencePacketId to the idea so the existing packet-grounded draft path
// takes over unchanged. On fail it returns a reason so the caller can hold the
// idea (needs_sources) or run a controlled harvest first.

export interface IdeaGroundingResult {
  ok: boolean;
  reason: string;
  packet?: EvidencePacket;
  sourceCount: number;
  chunkCount: number;
  hasTrustedCorroboration: boolean;
  /** Sources with a CORE role (core_evidence / primary_record) — the gate metric. */
  coreSourceCount?: number;
}

// Minimum evidence for an auto-built idea packet to ground a draft: at least
// two distinct CORE sources (core_evidence / primary_record — sources that are
// actually about THIS story, not framing/context/background), at least one
// retrieved chunk, and at least one ACTIVE trusted-tier source among the core
// (the same authority floor buildEvidencePacket applies to approve_draft).
const MIN_IDEA_PACKET_CORE_SOURCES = 2;
const MIN_IDEA_PACKET_CHUNKS = 1;
// Packet size caps: total sources, and how many off-case background_only
// sources may ride along (never counted toward the gate).
const MAX_PACKET_SOURCES = 8;
const MAX_BACKGROUND_SOURCES = 2;

// A source document is unusable for grounding when it's not live, has no
// extractable body, is a duplicate/failed/low-quality row, or is excerpt-only.
// These are excluded UNLESS nothing better exists (the caller then holds).
function isGroundingCandidate(d: SourceDocument): boolean {
  if (d.lifecycleStatus !== "active") return false;
  if (d.status === "failed" || d.status === "low_quality") return false;
  if (d.duplicateOfId) return false;
  if (d.excerptOnly) return false;
  return sourceExcerpt(d).length > 0;
}

// Rank grounding candidates strongest first: authority tier, then extraction
// quality, then best chunk similarity, then recency, then id (stable). Domain
// diversity is enforced separately by the caller.
function rankGroundingDocs(
  docs: SourceDocument[],
  bestSimilarity: Map<string, number>,
): SourceDocument[] {
  return [...docs].sort((a, b) => {
    const ra = AUTHORITY_TIER_ORDER.indexOf(a.authorityTier as SourceAuthorityTier);
    const rb = AUTHORITY_TIER_ORDER.indexOf(b.authorityTier as SourceAuthorityTier);
    const na = ra === -1 ? AUTHORITY_TIER_ORDER.length : ra;
    const nb = rb === -1 ? AUTHORITY_TIER_ORDER.length : rb;
    if (na !== nb) return na - nb;
    if (b.qualityScore !== a.qualityScore) return b.qualityScore - a.qualityScore;
    const sa = bestSimilarity.get(a.id) ?? 0;
    const sb = bestSimilarity.get(b.id) ?? 0;
    if (sb !== sa) return sb - sa;
    const ta = (a.publishedAt ?? a.fetchedAt)?.getTime() ?? 0;
    const tb = (b.publishedAt ?? b.fetchedAt)?.getTime() ?? 0;
    if (ta !== tb) return tb - ta;
    return a.id.localeCompare(b.id);
  });
}

// Keep at most one source per source-family so the packet doesn't lean on a
// single outlet republished many times (syndication guard). Falls back to
// `domain` only when a family id is absent. Order-preserving (input must
// already be ranked). NOTE: this does NOT enforce domain diversity — two
// different articles from the same newsroom have different family IDs and both
// survive. Domain diversity among core sources is enforced separately in the
// sufficiency gate below (uniqueCoreDomains check).
function dedupeByFamily(docs: SourceDocument[]): SourceDocument[] {
  const seen = new Set<string>();
  const out: SourceDocument[] = [];
  for (const d of docs) {
    const key = d.sourceFamilyId ?? d.domain;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

export interface GroundedPacketInput {
  /** The packet's cluster key (idea id, or the prior packet's clusterId on refresh). */
  clusterKey: string;
  title: string;
  angle: string | null;
  beat: string | null;
  beatSlug: string | null;
  /** Extra terms appended to the semantic query (e.g. the author's beat name). */
  extraQueryTerms?: string[];
  /** Recorded in retrievalContext.researchNote for auditability. */
  researchNote?: string;
  screen?: typeof llmEditorialScreen;
}

/**
 * Build an entity-gated, vault-grounded evidence packet with NO topic_ideas
 * side effects. Shared by buildEvidencePacketForIdea (which stamps the idea)
 * and refreshArticleEvidence (post-draft packet version bumps).
 *
 * The packet does NOT lock until discovery proves the vault holds enough
 * CASE-SPECIFIC evidence: required entities are extracted from the title +
 * angle, every candidate source is relevance-gated against them and given an
 * editorial role, and only core-role sources (core_evidence / primary_record)
 * count toward the sufficiency gate. Off-case sources are kept only as capped
 * background_only context. On gate failure the caller runs the web source
 * scout and retries — so the harvest happens BEFORE the packet ever locks.
 */
export async function buildGroundedPacket(input: GroundedPacketInput): Promise<IdeaGroundingResult> {
  const { clusterKey, title, angle, beat, beatSlug } = input;
  const fail = (reason: string, extra: Partial<IdeaGroundingResult> = {}): IdeaGroundingResult => ({
    ok: false,
    reason,
    sourceCount: 0,
    chunkCount: 0,
    hasTrustedCorroboration: false,
    coreSourceCount: 0,
    ...extra,
  });

  if (!isEmbeddingConfigured()) {
    return fail("Source Vault retrieval is unavailable (no embedding provider configured).");
  }

  // --- Required entities: what every CORE source must actually mention -------
  const entities = extractRequiredEntities(title, angle);

  // --- Build a focused semantic query from the idea + author context ---------
  // Concept-aware expansion (Task #338): match the IDEA text (title + angle)
  // against the glossary lexicon; append matched concepts' aliases + related
  // terms so the vault search also finds sources using other vocabulary for
  // the same concept. No concept match = empty plan = identical behavior.
  const ideaText = [title, angle].filter(Boolean).join(" ");
  const conceptPlan = await planConceptRetrieval(ideaText);
  const baseQuery = [title, angle, beat, ...(input.extraQueryTerms ?? [])]
    .filter(Boolean)
    .join(" ");
  const query = [baseQuery, ...conceptPlan.expansionTerms].join(" ").slice(0, 400);

  // --- Vault-first retrieval -------------------------------------------------
  let hits;
  try {
    hits = await semanticSearch(query, { limit: 24 });
  } catch (err) {
    if (err instanceof EmbeddingNotConfiguredError) {
      return fail("Source Vault retrieval is unavailable (no embedding provider configured).");
    }
    logger.warn({ err, clusterKey }, "auto-ground: semanticSearch failed");
    return fail("Source Vault retrieval failed.");
  }
  if (hits.length === 0) {
    return fail("No Source Vault matches for this idea yet.");
  }

  // Best chunk similarity per document, and the set of matched document ids.
  const bestSimilarity = new Map<string, number>();
  for (const h of hits) {
    const prev = bestSimilarity.get(h.documentId) ?? 0;
    if (h.similarity > prev) bestSimilarity.set(h.documentId, h.similarity);
  }

  // Relevance floor: if the best chunk similarity across ALL vault matches is
  // below the threshold, the vault is returning off-topic material (e.g. a
  // politically unrelated article or a generic editorial piece matches on
  // topic-adjacent keywords but not on the actual story). Treat this as a vault
  // miss so the harvest-retry path can search with more targeted queries.
  const MIN_GROUNDING_SIMILARITY = 0.15;
  const globalMaxSimilarity = hits.length > 0 ? Math.max(...hits.map((h) => h.similarity)) : 0;
  if (globalMaxSimilarity < MIN_GROUNDING_SIMILARITY) {
    return fail(
      `Source Vault returned off-topic matches (best chunk similarity: ${globalMaxSimilarity.toFixed(3)}, minimum: ${MIN_GROUNDING_SIMILARITY}). The Vault has no relevant sources for this idea yet.`,
    );
  }

  // Blend in concept-edge-linked documents (Task #338) AFTER the relevance
  // floor: edges widen the candidate pool but can never make an off-topic
  // query look grounded. Edge docs get a modest SYNTHETIC similarity (capped
  // below strong real hits) so ranking still prefers semantic evidence; docs
  // the search already found keep their real (higher) similarity.
  for (const edge of conceptPlan.edgeDocs) {
    if (!bestSimilarity.has(edge.documentId)) {
      bestSimilarity.set(edge.documentId, syntheticEdgeSimilarity(edge.confidence));
    }
  }

  const documentIds = Array.from(bestSimilarity.keys());

  const docs = await db
    .select()
    .from(sourceDocumentsTable)
    .where(inArray(sourceDocumentsTable.id, documentIds));
  if (docs.length === 0) {
    return fail("Matched vault chunks have no live source documents.");
  }

  // Prefer clean grounding candidates; only widen to the raw matched set when
  // nothing clean exists (the caller will still gate on the authority floor).
  const candidates = docs.filter(isGroundingCandidate);
  const pool = candidates.length > 0 ? candidates : docs.filter((d) => sourceExcerpt(d).length > 0);
  if (pool.length === 0) {
    return fail("Matched vault sources have no usable extracted text.");
  }

  // --- Relevance gate + role assignment --------------------------------------
  // Every candidate is checked against the story's required entities and given
  // an editorial role. Off-case sources (background_only) are EXCLUDED from
  // selection except a small capped tail — they can never lock a packet.
  const roleOf = new Map<string, ReturnType<typeof assignSourceRole>>();
  for (const d of pool) {
    roleOf.set(
      d.id,
      assignSourceRole({
        onCase: sourceIsOnCase(`${d.title ?? ""} ${sourceExcerpt(d)}`, entities),
        authorityTier: d.authorityTier,
        domain: d.domain,
        title: d.title,
        url: d.url,
      }),
    );
  }
  const onCasePool = pool.filter((d) => roleOf.get(d.id) !== "background_only");
  const offCasePool = pool.filter((d) => roleOf.get(d.id) === "background_only");

  const rankedOn = dedupeByFamily(rankGroundingDocs(onCasePool, bestSimilarity));
  const selectedOn = rankedOn.slice(0, MAX_PACKET_SOURCES);
  const backgroundBudget = Math.min(MAX_BACKGROUND_SOURCES, MAX_PACKET_SOURCES - selectedOn.length);
  const selectedOff =
    backgroundBudget > 0
      ? dedupeByFamily(rankGroundingDocs(offCasePool, bestSimilarity)).slice(0, backgroundBudget)
      : [];
  const ordered = [...selectedOn, ...selectedOff];

  const coreDocs = selectedOn.filter((d) => isCorePacketRole(roleOf.get(d.id)));
  const coreSourceCount = coreDocs.length;
  // Domain diversity: family dedup prevents syndication (one outlet → many IDs)
  // but two genuinely separate articles from the same newsroom survive it. Count
  // distinct domains across core sources so a single outlet can't satisfy the
  // minimum corroboration requirement on its own.
  const uniqueCoreDomains = new Set(coreDocs.map((d) => d.domain)).size;

  // Authority floor scoped to CORE sources: framing/context/background sources
  // can never vouch for the packet on their own.
  const hasTrustedCorroboration = coreDocs.some(
    (d) =>
      d.lifecycleStatus === "active" &&
      isTrustedAuthorityTier(d.authorityTier as SourceAuthorityTier | null),
  );

  // Supporting chunks: the retrieved hits that belong to the selected sources,
  // strongest similarity first, capped so the packet stays compact.
  const selectedIds = new Set(ordered.map((d) => d.id));
  const chunks: PacketChunk[] = hits
    .filter((h) => selectedIds.has(h.documentId))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 12)
    .map((h) => ({
      chunkId: h.chunkId,
      documentId: h.documentId,
      content: h.content,
      similarity: h.similarity,
    }));

  // --- Deterministic sufficiency gate (core sources, not raw counts) ---------
  // The packet may only lock when discovery found enough CASE-SPECIFIC core
  // evidence. Naming the core count in the reason matters: it is what tells
  // the caller (and the held-idea note) that the web source scout must run.
  if (
    coreSourceCount < MIN_IDEA_PACKET_CORE_SOURCES ||
    uniqueCoreDomains < MIN_IDEA_PACKET_CORE_SOURCES ||
    chunks.length < MIN_IDEA_PACKET_CHUNKS ||
    !hasTrustedCorroboration
  ) {
    const entityNote =
      entities.strong.length > 0 ? ` Required entities: ${entities.strong.join(", ")}.` : "";
    return fail(
      `Not enough case-specific evidence (${coreSourceCount} core source${coreSourceCount === 1 ? "" : "s"} of ${MIN_IDEA_PACKET_CORE_SOURCES} required, ${uniqueCoreDomains} distinct domain${uniqueCoreDomains === 1 ? "" : "s"} of ${MIN_IDEA_PACKET_CORE_SOURCES} required; ${selectedOn.length} on-case source${selectedOn.length === 1 ? "" : "s"}, ${chunks.length} excerpt${chunks.length === 1 ? "" : "s"}, trusted-tier core corroboration: ${hasTrustedCorroboration ? "yes" : "no"}).${entityNote}`,
      {
        sourceCount: ordered.length,
        chunkCount: chunks.length,
        hasTrustedCorroboration,
        coreSourceCount,
      },
    );
  }

  // --- Existing-coverage context (free) --------------------------------------
  let existingArticleTitles: string[] = [];
  try {
    const overlaps = await findOverlappingArticles(title, angle ?? "", {
      threshold: 0.2,
      limit: 6,
    });
    existingArticleTitles = overlaps.map((o) => o.article.title);
  } catch (err) {
    logger.warn({ err, clusterKey }, "auto-ground: overlap lookup failed; continuing");
  }

  // --- Glossary concept context (free, best-effort) -------------------------
  // Retrieve relevant internal glossary concepts from the vault's glossary_concept
  // lane to inject as INTERNAL CONCEPT MEMORY. These are editorial context only
  // and must NEVER be mixed with evidence or count toward source coverage.
  let glossaryContext: string | undefined;
  try {
    const glossaryHits = await searchGlossaryConcepts(query, { limit: 6 });
    if (glossaryHits.length > 0) {
      glossaryContext = glossaryHits
        .map((h) => h.content.trim())
        .filter((c) => c.length > 0)
        .join("\n\n---\n\n")
        .slice(0, 1200);
    }
  } catch (err) {
    logger.debug({ err, clusterKey }, "auto-ground: glossary concept search skipped");
  }

  // --- Cheap forced editorial screen (best-effort) ---------------------------
  // Extracts claims / quote candidates / contradictions to enrich the packet.
  // Never a paid research call. If screening is paused in AI Control we still
  // produce a usable packet from the sources + chunks alone (empty claims).
  const screenSources: EditorialScreenSourceInput[] = ordered.map((d, i) => ({
    index: i + 1,
    authorityTier: d.authorityTier,
    domain: d.domain,
    title: d.title,
    author: d.author,
    publishedAt: d.publishedAt?.toISOString() ?? null,
    lifecycleStatus: d.lifecycleStatus,
    excerpt: sourceExcerpt(d),
  }));

  const keywords = [beat, ...title.split(/\s+/).slice(0, 8)].filter((v): v is string => !!v);
  const screenInput: EditorialScreenInput = {
    cluster: { label: title, beat: beat ?? "", score: 0, keywords },
    sources: screenSources,
    chunks: chunks.map((c) => c.content),
    existingArticles: existingArticleTitles,
    prior: null,
    research: null,
    glossaryContext,
    clusterId: clusterKey,
  };

  let screen: Awaited<ReturnType<typeof llmEditorialScreen>> | null = null;
  try {
    screen = await (input.screen ?? llmEditorialScreen)(screenInput);
  } catch (err) {
    if (err instanceof AiFunctionDisabledError) {
      logger.info({ clusterKey }, "auto-ground: editorial screen paused; packet built from sources only");
    } else {
      logger.warn({ err, clusterKey }, "auto-ground: editorial screen failed; packet built from sources only");
    }
  }

  const byIndex = new Map<number, SourceDocument>();
  ordered.forEach((d, i) => byIndex.set(i + 1, d));
  const idxToId = (n: number): string | null => byIndex.get(n)?.id ?? null;
  const idxsToIds = (ns: number[]): string[] => {
    const ids = ns.map(idxToId).filter((v): v is string => v !== null);
    return Array.from(new Set(ids));
  };

  const claims: PacketClaim[] = (screen?.claims ?? []).map((c) => ({
    text: c.text,
    sourceIds: idxsToIds(c.sourceIndexes),
  }));
  const contradictions: PacketContradiction[] = (screen?.contradictions ?? []).map((c) => ({
    summary: c.summary,
    sourceIds: idxsToIds(c.sourceIndexes),
  }));
  const quoteCandidates: PacketQuote[] = (screen?.quoteCandidates ?? []).map((q) => {
    const src = q.sourceIndex != null ? byIndex.get(q.sourceIndex) ?? null : null;
    const sourceId = src?.id ?? null;
    let verified = false;
    if (src) {
      const haystack = normalizeForMatch(sourceExcerpt(src));
      const needle = normalizeForMatch(q.text);
      verified = needle.length > 0 && haystack.includes(needle);
    }
    const allowedToQuote =
      verified && !!src && src.lifecycleStatus === "active" && src.fetchAllowed && !src.paywallDetected;
    return {
      text: q.text,
      attribution: q.attribution,
      sourceId,
      offsetStart: null,
      offsetEnd: null,
      verified,
      allowedToQuote,
    };
  });

  const packetSources: PacketSource[] = ordered.map((d) => ({
    ...toPacketSource(d),
    role: roleOf.get(d.id) ?? null,
  }));
  const topAuthorityTier = packetSources[0]?.authorityTier ?? null;
  const fingerprint = fingerprintSources(ordered);

  const retrievalContext: PacketRetrievalContext = {
    query,
    vaultHitCount: chunks.length,
    existingArticleTitles,
    priorPacketVersion: null,
    priorDecision: null,
    sonarUsed: false,
    researchNote:
      input.researchNote ?? "Auto-grounded from Source Vault for a manual idea (Task #233).",
    generatedAt: new Date().toISOString(),
    requiredEntities: [...entities.strong, ...entities.weak],
  };

  const baseValues = {
    clusterId: clusterKey, // synthetic cluster = the idea itself (or the prior packet's cluster on refresh)
    beatSlug: beatSlug ?? "",
    beat: beat ?? "",
    label: title,
    decision: "approve_draft" as const,
    decisionReasons: [
      `Auto-grounded from Source Vault: ${coreSourceCount} core source${coreSourceCount === 1 ? "" : "s"} (${packetSources.length} total), ${chunks.length} supporting excerpts, trusted-tier core corroboration present.`,
    ],
    doNotDraftReason: null,
    researchMode: "vault_only" as EvidenceResearchMode,
    model: screen?.model ?? "vault_only",
    sources: packetSources,
    supportingChunks: chunks,
    claims,
    contradictions,
    quoteCandidates,
    retrievalContext,
    sourcesFingerprint: fingerprint,
    sourceCount: packetSources.length,
    topAuthorityTier,
  };

  // Concurrency-safe version allocation, keyed on the cluster key (same
  // advisory-lock pattern as buildEvidencePacket) so overlapping build attempts
  // never collide on unique(cluster_id, version).
  const inserted = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`evidence_packet_version:${clusterKey}`}))`,
    );
    const [current] = await tx
      .select({ version: evidencePacketsTable.version })
      .from(evidencePacketsTable)
      .where(eq(evidencePacketsTable.clusterId, clusterKey))
      .orderBy(desc(evidencePacketsTable.version))
      .limit(1);
    const nextVersion = (current?.version ?? 0) + 1;
    const [row] = await tx
      .insert(evidencePacketsTable)
      .values({ ...baseValues, version: nextVersion })
      .returning();
    return row;
  });

  if (!inserted) return fail("Failed to persist auto-grounded evidence packet.");

  logger.info(
    {
      clusterKey,
      packetId: inserted.id,
      version: inserted.version,
      sources: packetSources.length,
      coreSources: coreSourceCount,
      chunks: chunks.length,
    },
    "auto-ground: evidence packet created",
  );

  return {
    ok: true,
    reason: "grounded_from_vault",
    packet: inserted,
    sourceCount: packetSources.length,
    chunkCount: chunks.length,
    hasTrustedCorroboration,
    coreSourceCount,
  };
}

/**
 * Ground a manual idea from the Source Vault. Thin wrapper over
 * buildGroundedPacket that derives the beat/query from the idea + author and,
 * on success, stamps the new packet id onto the idea so the packet-grounded
 * draft path takes over unchanged.
 */
export async function buildEvidencePacketForIdea(
  idea: TopicIdea,
  author: Author,
  opts: { screen?: typeof llmEditorialScreen } = {},
): Promise<IdeaGroundingResult> {
  const beat = idea.category ?? author.category;
  const beatSlug = idea.categorySlug ?? author.categorySlug;

  // Cross-sectional (Task #258): if the idea carries secondary subjects, fold
  // their beat names into the retrieval query so the packet spans evidence
  // across ALL of the idea's beats — not just the primary. Purely additive; an
  // idea without secondaries behaves exactly as before.
  const { resolveSecondaryBeatNames } = await import("./articles");
  const secondaryBeatNames = await resolveSecondaryBeatNames(idea.secondaryBeats);
  const extraQueryTerms = Array.from(
    new Set([author.category, ...secondaryBeatNames].filter((v): v is string => !!v)),
  );

  const res = await buildGroundedPacket({
    clusterKey: idea.id,
    title: idea.title,
    angle: idea.angle,
    beat,
    beatSlug,
    extraQueryTerms,
    screen: opts.screen,
  });

  if (res.ok && res.packet) {
    await db
      .update(topicIdeasTable)
      .set({ evidencePacketId: res.packet.id, updatedAt: new Date() })
      .where(eq(topicIdeasTable.id, idea.id));
  }
  return res;
}

export interface ScreeningRunSummary {
  screened: number;
  created: number;
  skipped: number;
  errors: number;
}

/**
 * Auto-screen the top open/active qualified clusters that lack a current packet
 * (or whose sources changed since their last packet). Runs vault_only (never a
 * paid call) and skips clusters whose fingerprint is unchanged. Cheap and
 * idempotent — safe to run from the cron tick. Manual admin triggers call
 * buildEvidencePacket directly and always produce a fresh version.
 */
export async function runEditorialScreening(now: Date = new Date()): Promise<ScreeningRunSummary> {
  void now;
  const summary: ScreeningRunSummary = { screened: 0, created: 0, skipped: 0, errors: 0 };
  if (!(await isAiFunctionEnabled("editorial_screen"))) return summary;

  const clusters = await listStoryClusters({
    status: "active",
    excludeCovered: true,
    includeSources: false,
    limit: 10,
  });

  for (const cluster of clusters) {
    summary.screened++;
    try {
      const res = await buildEvidencePacket(cluster.id, {
        research: "vault_only",
        skipIfUnchanged: true,
      });
      if (res.created) summary.created++;
      else summary.skipped++;
    } catch (err) {
      if (err instanceof AiFunctionDisabledError) break; // paused mid-run
      if (err instanceof EditorialScreenError && (err.status === 422 || err.status === 404)) {
        summary.skipped++;
        continue;
      }
      summary.errors++;
      logger.warn({ err, clusterId: cluster.id }, "editorial screen: auto-screen failed for cluster");
    }
  }
  logger.info({ ...summary }, "editorial screen: auto-screening run complete");
  return summary;
}

// Quarantine only on HARD failures — claims that CONTRADICT the packet,
// invented sources/attributions, or a checker error (we could not confirm
// fidelity, so hold for a human). Unsupported-but-plausible extrapolation is
// recorded as advisory findings only: these are opinion/analysis pieces, and
// going beyond the packet's explicit claims is expected editorial voice, not
// a publication blocker (operator decision — the old status!=="passed" rule
// quarantined legitimate opinion writing). Exported pure for tests.
export function shouldQuarantineReport(report: {
  status: "passed" | "flagged" | "error";
  contradictedClaims: unknown[];
  inventedSources: unknown[];
}): boolean {
  return (
    report.status === "error" ||
    report.contradictedClaims.length > 0 ||
    report.inventedSources.length > 0
  );
}

// --- Post-draft evidence verification (#201) ---------------------------------
// After a packet-grounded draft is written, check it AGAINST its locked evidence
// packet only (no live web) and record the findings on the article. Only a HARD
// failure (see shouldQuarantineReport) is quarantined via articles.quarantinedAt
// so it is hidden from every public read until a human clears it; advisory-only
// findings leave the article visible. A draft whose verification is paused in AI Control is recorded as
// skipped but NOT quarantined (an operator pause is not a failed draft). This
// function is best-effort and never throws into the drafting pipeline.

// Counts evidence-role rows in article_sources for a given article and compares
// them to the packet's source list to produce per-source coverage information.
// Used by the auto-publish gate and verification advisory findings.
export async function checkPacketSourceCoverage(
  articleId: string,
  packet: EvidencePacket,
): Promise<{
  evidenceCount: number;
  packetSourceCount: number;
  activePacketSourceCount: number;
  /** Packet URLs (active sources only) not found in article_sources evidence rows. */
  missingFromBody: string[];
  /** True when no active packet source URL appears in article_sources — the hold condition. */
  noPacketIntersection: boolean;
}> {
  const evidenceSources = await db
    .select({ url: articleSourcesTable.url })
    .from(articleSourcesTable)
    .where(and(eq(articleSourcesTable.articleId, articleId), eq(articleSourcesTable.role, "evidence")));

  const evidenceUrls = new Set(evidenceSources.map((s) => s.url));
  // Only consider active packet sources (not low_quality/failed) for the
  // intersection check, matching the eligibility filter applied when weaving
  // source links into the article body.
  const activeSources = packet.sources.filter(
    (s) => s.lifecycleStatus !== "low_quality" && s.lifecycleStatus !== "failed",
  );
  const activePacketUrls = activeSources.map((s) => s.url);
  const missingFromBody = activePacketUrls.filter((url) => !evidenceUrls.has(url));
  const noPacketIntersection = activePacketUrls.length > 0 && missingFromBody.length === activePacketUrls.length;

  return {
    evidenceCount: evidenceSources.length,
    packetSourceCount: packet.sources.length,
    activePacketSourceCount: activePacketUrls.length,
    missingFromBody,
    noPacketIntersection,
  };
}

export async function verifyPacketGroundedDraft(args: {
  articleId: string;
  title: string;
  body: ArticleBlock[];
  packet: EvidencePacket;
  // When true (admin re-run), a PASSING result also clears any existing
  // quarantine — the human fixed the draft and re-verified it. The pipeline
  // never sets this (a fresh passing draft was never quarantined to begin with).
  clearQuarantineOnPass?: boolean;
}): Promise<VerificationReport | null> {
  const { articleId, title, body, packet } = args;
  const bodyText = stripInternalArticleLinks(
    body
      .filter((b) => b.type !== "image" && b.type !== "takeaways")
      .map((b) => ("content" in b ? b.content : ""))
      .join("\n\n")
      .trim(),
  );

  let report: VerificationReport;
  try {
    const result = await llmVerifyDraftAgainstPacket({
      title,
      bodyText,
      packet: {
        label: packet.label,
        claims: packet.claims.map((c) => ({ text: c.text })),
        sources: packet.sources.map((s) => ({ url: s.url, domain: s.domain, title: s.title })),
        quotes: packet.quoteCandidates
          .filter((q) => q.allowedToQuote && q.verified)
          .map((q) => ({ text: q.text, attribution: q.attribution })),
        contradictions: packet.contradictions.map((c) => ({ summary: c.summary })),
      },
      clusterId: packet.clusterId,
      packetId: packet.id,
    });
    report = {
      status: result.status,
      checkedAt: new Date().toISOString(),
      model: result.model,
      summary: result.summary,
      unsupportedClaims: result.unsupportedClaims,
      contradictedClaims: result.contradictedClaims,
      inventedSources: result.inventedSources,
    };
    // Advisory: flag when NO packet sources appear in article_sources. This
    // mirrors the auto-publish hold condition (zero evidence sources) and is
    // informational only — it never quarantines. Only non-rejected (active)
    // packet sources are considered; legacy packets with all-excluded sources
    // are not flagged. Emitting a single finding (not one per missing URL)
    // keeps the report readable.
    try {
      const coverage = await checkPacketSourceCoverage(articleId, packet);
      // Only consider packet sources with an active lifecycle status (not
      // low_quality or failed), mirroring the sources eligible for body weaving.
      // Emit an advisory when none of the active packet sources appear in
      // article_sources (empty intersection), regardless of whether other
      // non-packet evidence rows exist. This matches the auto-publish hold
      // condition and is more precise than checking total evidenceCount alone.
      if (coverage.noPacketIntersection) {
        report = {
          ...report,
          advisoryFindings: [
            {
              findingType: "missing_packet_source",
              detail: `None of this article's ${coverage.activePacketSourceCount} active packet source${coverage.activePacketSourceCount === 1 ? "" : "s"} appear in the evidence graph (article_sources). Auto-publish will be held until at least one packet source is woven into article_sources — run source-graph repair or the 'Check source coverage' backfill.`,
            },
          ],
        };
      }
    } catch (coverageErr) {
      logger.warn({ err: coverageErr, articleId }, "coverage check failed (advisory skipped)");
    }
  } catch (err) {
    if (err instanceof AiFunctionDisabledError) {
      // Verification is paused in AI Control — record that it was skipped, but do
      // NOT quarantine (a paused check is an operator choice, not a failed draft).
      const skipped: VerificationReport = {
        status: "error",
        checkedAt: new Date().toISOString(),
        model: null,
        summary: "Post-draft verification is paused in AI Control; draft was not checked.",
        unsupportedClaims: [],
        contradictedClaims: [],
        inventedSources: [],
      };
      await db
        .update(articlesTable)
        .set({ verificationReport: skipped, updatedAt: new Date() })
        .where(eq(articlesTable.id, articleId));
      logger.info({ articleId, packetId: packet.id }, "draft verification skipped (paused)");
      return skipped;
    }
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), articleId, packetId: packet.id },
      "draft verification failed unexpectedly",
    );
    // Persist the failed attempt (status:"error") so downstream gates can see
    // WHEN verification last failed and throttle retries — but never
    // quarantine here (a verifier crash is not a failed draft).
    const failed: VerificationReport = {
      status: "error",
      checkedAt: new Date().toISOString(),
      model: null,
      summary: `Verification failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
      unsupportedClaims: [],
      contradictedClaims: [],
      inventedSources: [],
    };
    try {
      await db
        .update(articlesTable)
        .set({ verificationReport: failed, updatedAt: new Date() })
        .where(eq(articlesTable.id, articleId));
    } catch {
      // best-effort — never throw into the drafting pipeline
    }
    return null;
  }

  const shouldQuarantine = shouldQuarantineReport(report);
  await db
    .update(articlesTable)
    .set({
      verificationReport: report,
      ...(shouldQuarantine
        ? { quarantinedAt: new Date() }
        : args.clearQuarantineOnPass
          ? { quarantinedAt: null }
          : {}),
      updatedAt: new Date(),
    })
    .where(eq(articlesTable.id, articleId));

  // Replace the article's claim-use snapshot after every verification.
  // Passing an empty chunk list clears stale provenance when a later check
  // quarantines the article.
  void recordArticleClaimUses(
    articleId,
    shouldQuarantine ? [] : packet.supportingChunks.map((chunk) => chunk.chunkId),
  ).catch((err) =>
    logger.warn(
      { err, articleId, packetId: packet.id },
      "article claim-use synchronization failed",
    ),
  );

  logger.info(
    {
      articleId,
      packetId: packet.id,
      status: report.status,
      quarantined: shouldQuarantine,
      unsupported: report.unsupportedClaims.length,
      contradicted: report.contradictedClaims.length,
      invented: report.inventedSources.length,
    },
    "draft verification complete",
  );
  return report;
}

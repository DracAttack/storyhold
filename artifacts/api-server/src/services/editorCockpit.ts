import {
  db,
  authorsTable,
  topicIdeasTable,
  storyClustersTable,
  sourceDocumentsTable,
  editorialReviewActionsTable,
  type Author,
  type EditorialRejectionReason,
  type EditorialReviewSurface,
} from "@workspace/db";
import { and, eq, sql, inArray, isNull } from "drizzle-orm";
import {
  listStoryClusters,
  getStoryCluster,
  recomputeStoryCluster,
  textMatchesClusterKeywords,
  type StoryClusterWithSources,
} from "./storyClusters";
import {
  getLatestPacket,
  getPacket,
  buildEvidencePacket,
  EditorialScreenError,
} from "./editorialScreen";
import {
  countApprovedIdeas,
  getApprovedIdeaCap,
  startDraftArticleFromIdea,
} from "./articles";
import { rankCoveringAuthors } from "./authorAssignment";
import { searchLeads, ingestUrl } from "./sourceVault";
import { isSourceVaultEnabled } from "./sourceVaultBudget";
import { isResearchCapabilityAvailable } from "./researchFallback";
import { getSiteSettings } from "./siteSettings";
import { logger } from "../lib/logger";

// --- Editor cockpit (Task #202) ----------------------------------------
// A deterministic daily digest that helps a human editor spend their attention
// where it matters, then act with one click. NO new AI call is made here — the
// "why this matters" and "estimated angle" are composed from data the pipeline
// ALREADY recorded (cluster scores, source counts, screening claims). Actions
// route into the EXISTING idea → draft → human-publish funnel; nothing here ever
// auto-publishes.

const CANDIDATE_LIMIT = 8;
const PACKET_LIMIT = 8;
const QUARANTINE_LIMIT = 12;

export class EditorCockpitError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "EditorCockpitError";
  }
}

export interface CockpitCandidate {
  clusterId: string;
  beat: string;
  beatSlug: string;
  label: string;
  score: number;
  sourceCount: number;
  familyCount: number;
  topAuthorityTier: string | null;
  lastSeenAt: string;
  hasPacket: boolean;
  latestDecision: string | null;
  whyThisMatters: string;
  estimatedAngle: string;
  watched: boolean;
  watchedAt: string | null;
}

export interface CockpitPacketItem {
  clusterId: string;
  packetId: string;
  version: number;
  beat: string;
  beatSlug: string;
  label: string;
  decision: string;
  doNotDraftReason: string | null;
  sourceCount: number;
  claimCount: number;
  contradictionCount: number;
  topAuthorityTier: string | null;
  createdAt: string;
  whyThisMatters: string;
  estimatedAngle: string;
  /** True when at least one source in this packet has been retracted/made unavailable/superseded/stale. The packet needs re-screening before promoting. */
  stalePacket: boolean;
}

export interface EditorCockpit {
  generatedAt: string;
  topCandidates: CockpitCandidate[];
  topPackets: CockpitPacketItem[];
  quarantineQueue: CockpitPacketItem[];
}

function relativeAge(iso: string, now: Date): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const h = Math.round(ms / (1000 * 60 * 60));
  if (h < 1) return "under an hour ago";
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function candidateWhy(c: StoryClusterWithSources, now: Date): string {
  const tier = c.topAuthorityTier ? `, strongest source tier: ${c.topAuthorityTier}` : "";
  // "Outlets" = independent voices: distinct source families capped by distinct
  // domains. Raw familyCount alone misled here — 58 GovInfo documents (each its
  // own family, all govinfo.gov) displayed as "58 outlets" when it is ONE.
  const voices =
    c.domainCount > 0 ? Math.min(c.familyCount, c.domainCount) : c.familyCount;
  const outlets = voices > 0 ? ` across ${voices} outlet${voices === 1 ? "" : "s"}` : "";
  return `Score ${c.score}/100 — ${c.sourceCount} source${c.sourceCount === 1 ? "" : "s"}${outlets}${tier}. Last activity ${relativeAge(c.lastSeenAt.toISOString?.() ?? String(c.lastSeenAt), now)}.`;
}

// Returns true when `label` looks like a bare hostname rather than a real
// headline (e.g. "gov.info", "govinfo.gov", "who.int"). Used as a guard to
// substitute a synthesized description instead of surfacing the raw domain.
function isDomainishLabel(label: string): boolean {
  const t = label.trim();
  if (!t || t.includes(" ")) return false;
  // Must contain a dot + a valid TLD suffix, and contain no Title Case words
  // that signal a real headline.
  return /\.[a-z]{2,}(?:\.[a-z]{2,})?$/i.test(t);
}

// Build a readable angle from cluster keywords when the label is a bare domain.
// Capitalises the first keyword and formats as a topical description.
function keywordAngle(keywords: string[]): string {
  const kws = keywords.slice(0, 6);
  if (kws.length === 0) return "";
  const lead = (kws[0]!.charAt(0).toUpperCase() + kws[0]!.slice(1)).replace(/_/g, " ");
  const rest = kws.slice(1).map((k) => k.replace(/_/g, " "));
  return rest.length > 0 ? `${lead}: ${rest.join(", ")}` : lead;
}

// The "estimated angle" is deterministic: the cluster's human-readable label
// (itself derived from the strongest member headline) framed as an angle. When
// the label is a bare domain (e.g. "gov.info"), keywords synthesize a topical
// description instead — and when keywords are ALSO empty, a beat-based
// placeholder is used so a raw domain never surfaces as the angle. No AI.
function candidateAngle(label: string, keywords: string[], beat: string): string {
  if (isDomainishLabel(label)) {
    const kw = keywordAngle(keywords);
    return kw || `New ${beat} source activity — no headline extracted yet`;
  }
  return label;
}

// Same guard applied to packet labels / first-claim fallback. When both first
// claim AND label are absent or domain-ish, synthesise from keywords, falling
// back to a beat-based placeholder rather than ever echoing a bare domain.
function packetAngle(firstClaim: string | null, label: string, keywords: string[], beat: string): string {
  if (firstClaim && !isDomainishLabel(firstClaim)) return firstClaim;
  if (!isDomainishLabel(label)) return label;
  const kw = keywordAngle(keywords);
  return kw || `New ${beat} source activity — no headline extracted yet`;
}

/**
 * Build the editor cockpit digest. Read-only aggregation over recorded data —
 * no AI call. Top candidates are the hottest OPEN clusters; top packets are the
 * clusters whose latest screen cleared them to draft; the quarantine queue is
 * the clusters the AI screen couldn't decide (needs a human call).
 */
export async function getEditorCockpit(now: Date = new Date()): Promise<EditorCockpit> {
  const clusters = await listStoryClusters({
    status: "active",
    includeSources: false,
    limit: CANDIDATE_LIMIT,
  });

  // Fetch watched state for all candidate cluster IDs in one query so we can
  // include watched/watchedAt in the CockpitCandidate response.
  const clusterIds = clusters.map((c) => c.id);
  const watchedRows =
    clusterIds.length > 0
      ? await db
          .select({ id: storyClustersTable.id, watched: storyClustersTable.watched, watchedAt: storyClustersTable.watchedAt })
          .from(storyClustersTable)
          .where(inArray(storyClustersTable.id, clusterIds))
      : [];
  const watchedById = new Map(watchedRows.map((r) => [r.id, r]));

  const topCandidates: CockpitCandidate[] = clusters.map((c) => {
    const watchRow = watchedById.get(c.id);
    return {
      clusterId: c.id,
      beat: c.beat,
      beatSlug: c.beatSlug,
      label: c.label,
      score: c.score,
      sourceCount: c.sourceCount,
      familyCount: c.familyCount,
      topAuthorityTier: c.topAuthorityTier,
      lastSeenAt: c.lastSeenAt.toISOString?.() ?? String(c.lastSeenAt),
      hasPacket: false,
      latestDecision: null,
      whyThisMatters: candidateWhy(c, now),
      estimatedAngle: candidateAngle(c.label, c.keywords, c.beat),
      watched: watchRow?.watched ?? false,
      watchedAt: watchRow?.watchedAt ? (watchRow.watchedAt instanceof Date ? watchRow.watchedAt.toISOString() : String(watchRow.watchedAt)) : null,
    };
  });

  // Latest evidence packet per OPEN cluster (DISTINCT ON keeps the highest
  // version), then split by the screen's decision. Rejected / covered clusters
  // are excluded (coverage_status = 'open' + the reject decisions filtered out).
  const rows = (
    await db.execute(sql`
      SELECT DISTINCT ON (p.cluster_id)
        p.id AS packet_id,
        p.cluster_id AS cluster_id,
        p.version AS version,
        p.beat AS beat,
        p.beat_slug AS beat_slug,
        p.label AS label,
        p.decision AS decision,
        p.do_not_draft_reason AS do_not_draft_reason,
        p.decision_reasons AS decision_reasons,
        p.source_count AS source_count,
        p.top_authority_tier AS top_authority_tier,
        p.created_at AS created_at,
        p.stale_packet AS stale_packet,
        jsonb_array_length(p.claims) AS claim_count,
        jsonb_array_length(p.contradictions) AS contradiction_count,
        (p.claims -> 0 ->> 'text') AS first_claim,
        c.keywords AS cluster_keywords
      FROM evidence_packets p
      JOIN story_clusters c ON c.id = p.cluster_id
      WHERE c.coverage_status = 'open'
      ORDER BY p.cluster_id, p.version DESC
    `)
  ).rows as Array<Record<string, unknown>>;

  const items: CockpitPacketItem[] = rows.map((r) => {
    const decision = String(r.decision);
    const claimCount = Number(r.claim_count ?? 0);
    const contradictionCount = Number(r.contradiction_count ?? 0);
    const sourceCount = Number(r.source_count ?? 0);
    const doNotDraftReason = r.do_not_draft_reason ? String(r.do_not_draft_reason) : null;
    const firstClaim = r.first_claim ? String(r.first_claim) : null;
    const label = String(r.label);
    const clusterKeywords = Array.isArray(r.cluster_keywords)
      ? (r.cluster_keywords as unknown[]).map((k) => String(k))
      : [];
    const reasons = Array.isArray(r.decision_reasons)
      ? (r.decision_reasons as unknown[]).map((x) => String(x))
      : [];
    const createdAt = new Date(String(r.created_at)).toISOString();

    let whyThisMatters: string;
    if (decision === "approve_draft") {
      const contra = contradictionCount > 0 ? `, ${contradictionCount} noted contradiction${contradictionCount === 1 ? "" : "s"} to resolve` : "";
      whyThisMatters = `Screen cleared this to draft: ${claimCount} verified claim${claimCount === 1 ? "" : "s"} from ${sourceCount} source${sourceCount === 1 ? "" : "s"}${contra}.`;
    } else {
      whyThisMatters = doNotDraftReason
        ? `AI wasn't confident: ${doNotDraftReason} Needs a human call.`
        : reasons.length
          ? `AI wasn't confident: ${reasons.join("; ")}. Needs a human call.`
          : `AI wasn't confident — needs a human call. (${sourceCount} source${sourceCount === 1 ? "" : "s"})`;
    }

    return {
      clusterId: String(r.cluster_id),
      packetId: String(r.packet_id),
      version: Number(r.version ?? 0),
      beat: String(r.beat),
      beatSlug: String(r.beat_slug),
      label,
      decision,
      doNotDraftReason,
      sourceCount,
      claimCount,
      contradictionCount,
      topAuthorityTier: r.top_authority_tier ? String(r.top_authority_tier) : null,
      createdAt,
      whyThisMatters,
      // Deterministic estimated angle: the packet's strongest claim if present,
      // else the cluster label. Falls back to a keyword synopsis when both are
      // bare domains (e.g. "gov.info"). No AI.
      estimatedAngle: packetAngle(firstClaim, label, clusterKeywords, String(r.beat)),
      stalePacket: r.stale_packet === true || r.stale_packet === "true",
    };
  });

  const byNewest = (a: CockpitPacketItem, b: CockpitPacketItem) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();

  const topPackets = items
    .filter((i) => i.decision === "approve_draft")
    .sort(byNewest)
    .slice(0, PACKET_LIMIT);
  const quarantineQueue = items
    .filter((i) => i.decision === "needs_human_editor")
    .sort(byNewest)
    .slice(0, QUARANTINE_LIMIT);

  // Flag candidates that already have a latest packet + its decision, so the UI
  // can show whether a hot cluster has been screened yet.
  const latestByCluster = new Map(items.map((i) => [i.clusterId, i.decision]));
  for (const cand of topCandidates) {
    const d = latestByCluster.get(cand.clusterId);
    if (d) {
      cand.hasPacket = true;
      cand.latestDecision = d;
    }
  }

  return {
    generatedAt: now.toISOString(),
    topCandidates,
    topPackets,
    quarantineQueue,
  };
}

// Resolve an active author who covers the cluster's beat. Workload-first
// variety (see authorAssignment.ts): primary and sub-beat coverers compete in
// ONE pool ranked by fewest recent assignments (articles in the last 14 days
// + approved-idea bank), with primary-beat fit only breaking ties — sub-beat
// writers get genuine consideration instead of only being a fallback tier.
// The historical pile-up (a sub-beat writer collecting three pieces in one
// night because his idea bank happened to be smallest) stays guarded: every
// promotion creates an article, which raises that writer's recent load and
// sinks them for the next pick. Refuses if nobody covers the beat at all.
async function resolveCoveringAuthor(beatSlug: string): Promise<Author> {
  const ranked = await rankCoveringAuthors(beatSlug);
  if (ranked.length === 0) {
    throw new EditorCockpitError(
      422,
      "No active writer covers this beat — assign a writer to it before promoting.",
    );
  }
  return ranked[0]!.author;
}

// Executor accepted by helpers that need to run either standalone or inside a
// transaction (mirrors the ArticleDateTx pattern in articles.ts).
type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Atomically claim an OPEN cluster by flipping its coverage status. The
// conditional `WHERE coverage_status = 'open'` makes this a single-winner claim:
// two concurrent promote/reject clicks on the same cluster race here and exactly
// one UPDATE returns a row. Returns true for the winner, false if the cluster was
// already dispositioned (or does not exist — the caller checks existence first).
async function claimOpenCluster(
  clusterId: string,
  to: "covered" | "do_not_cover",
  reason: string | null,
  executor: DbExecutor = db,
): Promise<boolean> {
  const rows = await executor
    .update(storyClustersTable)
    .set({
      coverageStatus: to,
      coverageReason: reason,
      coverageResurfaceAfter: null,
      coveredArticleId: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(storyClustersTable.id, clusterId),
        eq(storyClustersTable.coverageStatus, "open"),
      ),
    )
    .returning({ id: storyClustersTable.id });
  return rows.length > 0;
}

export interface PromoteClusterInput {
  packetId?: string | null;
  surface: EditorialReviewSurface;
  note?: string | null;
  createdBy?: string | null;
  editorialLabelOverride?: string | null;
}

export interface PromoteClusterResult {
  clusterId: string;
  ideaId: string;
  authorId: string;
  authorName: string;
}

/**
 * Promote a cluster into the content funnel: resolve a covering writer, create an
 * approved topic idea grounded in the cluster's strongest source, launch the
 * EXISTING background draft pipeline (force past dedupe — the editor explicitly
 * chose this), mark the cluster covered, and record the editor's action. This
 * produces a DRAFT for the editor to review; it NEVER auto-publishes.
 */
export async function promoteCluster(
  clusterId: string,
  input: PromoteClusterInput,
): Promise<PromoteClusterResult> {
  const cluster = await getStoryCluster(clusterId);
  if (!cluster) throw new EditorCockpitError(404, "Cluster not found");
  if (cluster.coverageStatus !== "open") {
    throw new EditorCockpitError(409, "This cluster has already been dispositioned.");
  }

  // Fail closed: a cluster may only be promoted to a draft once an evidence
  // packet has actually cleared editorial screening. An explicit packetId (the
  // version the editor was looking at) wins; otherwise the latest version is
  // used. Only approve_draft (ready to draft) and needs_human_editor (the model
  // punted and a human is explicitly overriding here) may promote — reject_*,
  // approve_research (needs more sourcing), and "no packet at all" cannot.
  const packet = input.packetId ? await getPacket(input.packetId) : await getLatestPacket(clusterId);
  if (!packet) {
    throw new EditorCockpitError(
      409,
      "This cluster has no evidence packet yet. Run editorial screening before promoting.",
    );
  }
  if (packet.clusterId !== clusterId) {
    throw new EditorCockpitError(400, "The chosen evidence packet belongs to a different cluster.");
  }
  if (packet.decision !== "approve_draft" && packet.decision !== "needs_human_editor") {
    throw new EditorCockpitError(
      409,
      `This cluster's evidence packet is "${packet.decision}" — only an approved packet can be promoted to a draft.`,
    );
  }
  // A stale packet means at least one source has been retracted, superseded, or
  // otherwise invalidated since the packet was screened. The prior approve_draft
  // decision no longer reflects the current evidence; promoting it would ground
  // an article in discredited sources. Re-run editorial screening to build a
  // fresh packet before promoting.
  if (packet.stalePacket) {
    throw new EditorCockpitError(
      409,
      "This cluster's evidence packet is stale — one or more sources have been retracted or superseded since screening. Re-run editorial screening to get a fresh packet before promoting.",
    );
  }

  const author = await resolveCoveringAuthor(cluster.beatSlug);

  const approvedCount = await countApprovedIdeas(author.id);
  const ideaCap = await getApprovedIdeaCap();
  if (approvedCount >= ideaCap) {
    throw new EditorCockpitError(
      409,
      `${author.name} already has ${approvedCount} approved ideas (cap ${ideaCap}). Draft some of them first.`,
    );
  }

  // Ground the angle in the strongest recorded source so the draft can cite it.
  const topSource = cluster.sources[0];
  const groundedAngle = topSource?.url
    ? `${cluster.label} (Source: ${topSource.domain} — ${topSource.url})`
    : cluster.label;

  // Durable outcome of a promote = an approved pipeline idea + the coverage
  // memory + the recorded editor action. Do all three atomically so they can
  // never diverge on a partial failure, and so a double-click produces exactly
  // one idea: the single-winner cluster claim is the first statement in the
  // transaction, so the loser's UPDATE matches no row and the whole tx aborts.
  let idea: typeof topicIdeasTable.$inferSelect;
  try {
    idea = await db.transaction(async (tx) => {
      const claimed = await claimOpenCluster(
        clusterId,
        "covered",
        "Promoted to pipeline idea from Editor Cockpit",
        tx,
      );
      if (!claimed) {
        throw new EditorCockpitError(409, "This cluster has already been dispositioned.");
      }
      const [created] = await tx
        .insert(topicIdeasTable)
        .values({
          authorId: author.id,
          title: cluster.label,
          angle: groundedAngle,
          category: cluster.beat,
          categorySlug: cluster.beatSlug,
          status: "approved",
          // Evidence lineage: the packet that gated this promotion + its cluster,
          // carried through to the drafted article for traceability + grounding.
          evidencePacketId: packet.id,
          clusterId,
          notes: `Promoted from Editor Cockpit${input.note ? ` · ${input.note}` : ""}`,
        })
        .returning();
      if (!created) throw new EditorCockpitError(500, "Failed to create idea from cluster");
      await tx.insert(editorialReviewActionsTable).values({
        clusterId,
        packetId: packet.id,
        surface: input.surface,
        action: "promote",
        promotedIdeaId: created.id,
        note: input.note ?? null,
        createdBy: input.createdBy ?? null,
      });
      return created;
    });
  } catch (e) {
    if (e instanceof EditorCockpitError) throw e;
    logger.error({ err: e, clusterId }, "Promote: failed to record promotion");
    throw new EditorCockpitError(500, "Could not promote this cluster.");
  }

  // Hand the approved idea to the EXISTING background draft pipeline (force — the
  // editor's explicit choice). This produces a DRAFT for review; it NEVER
  // auto-publishes. Like every manual trigger in BrainHook this is fire-and-forget:
  // if the kickoff throws, the idea stays approved in the author's bank and the
  // pipeline drafts it later, so the promotion (idea + coverage) still stands.
  try {
    await startDraftArticleFromIdea(author.id, idea.id, {
      force: true,
      ...(input.editorialLabelOverride ? { editorialLabelOverride: input.editorialLabelOverride } : {}),
    });
  } catch (e) {
    logger.error(
      { err: e, clusterId, ideaId: idea.id },
      "Promote: background draft kickoff failed; idea remains approved for retry",
    );
  }

  return { clusterId, ideaId: idea.id, authorId: author.id, authorName: author.name };
}

export interface RejectClusterInput {
  reason: EditorialRejectionReason;
  packetId?: string | null;
  surface: EditorialReviewSurface;
  note?: string | null;
  createdBy?: string | null;
}

/**
 * Reject a cluster: record do-not-cover coverage memory (so it stops resurfacing)
 * and persist the structured rejection reason for the feedback loop.
 */
export async function rejectCluster(
  clusterId: string,
  input: RejectClusterInput,
): Promise<{ clusterId: string }> {
  const cluster = await getStoryCluster(clusterId);
  if (!cluster) throw new EditorCockpitError(404, "Cluster not found");

  // Claim + record the rejection atomically. The single-winner claim is the first
  // statement, so a duplicate click (or a race with a concurrent promote) matches
  // no row and the whole transaction aborts with a clean 409 — we never record two
  // disposition actions for the same cluster, and the reason can't diverge.
  try {
    await db.transaction(async (tx) => {
      const claimed = await claimOpenCluster(
        clusterId,
        "do_not_cover",
        input.note ? `${input.reason}: ${input.note}` : input.reason,
        tx,
      );
      if (!claimed) {
        throw new EditorCockpitError(409, "This cluster has already been dispositioned.");
      }
      await tx.insert(editorialReviewActionsTable).values({
        clusterId,
        packetId: input.packetId ?? null,
        surface: input.surface,
        action: "reject",
        rejectionReason: input.reason,
        note: input.note ?? null,
        createdBy: input.createdBy ?? null,
      });
    });
  } catch (e) {
    if (e instanceof EditorCockpitError) throw e;
    logger.error({ err: e, clusterId }, "Reject: failed to record rejection");
    throw new EditorCockpitError(500, "Could not reject this cluster.");
  }

  return { clusterId };
}

export interface SourceBoostResult {
  clusterId: string;
  query: string;
  leadsFound: number;
  added: number;
  attached: number;
  failed: number;
  rescreened: boolean;
  decision: string | null;
  promotable: boolean;
  message: string;
}

// Only these two decisions can be promoted (mirror of promoteCluster's server
// guard + the client canPromote). Used to report whether a boost lifted the
// cluster over the promotion bar.
const PROMOTABLE_DECISIONS = new Set(["approve_draft", "needs_human_editor"]);

const MAX_BOOST_LEADS = 5;

// Per-cluster in-flight guard: a source boost fires paid search + embeds + a
// screen call, so a double-click (or two tabs) must not run it twice. The UI
// disables the button while pending; this is the server-side backstop. Single
// server assumption (same as the rest of the manual-trigger paths).
const boostInFlight = new Set<string>();

/**
 * "Find sources" for a cluster that can't be promoted yet. Runs a targeted
 * Perplexity source search for the cluster's current subject, ingests + embeds
 * each evidence lead synchronously (only what passes the quality bar is stored),
 * attaches the fresh, unclustered docs to THIS cluster, recomputes it, then
 * re-screens (vault-only, no paid research) so the packet reflects the new
 * sourcing. Reports whether the cluster is now promotable.
 *
 * Cost note: this makes a paid Perplexity search + one editorial-screen model
 * call, so it is a deliberate, one-click manual action — never automated. The
 * VaultBudgetGuard inside searchLeads/ingest bounds runaway spend.
 */
export async function boostClusterSources(clusterId: string): Promise<SourceBoostResult> {
  if (!isSourceVaultEnabled()) {
    throw new EditorCockpitError(503, "The Source Vault is disabled.");
  }
  if (!(await isResearchCapabilityAvailable())) {
    throw new EditorCockpitError(
      503,
      "Source search is unavailable — no research provider (Perplexity or the Claude fallback) is configured.",
    );
  }

  const cluster = await getStoryCluster(clusterId);
  if (!cluster) throw new EditorCockpitError(404, "Cluster not found");

  if (boostInFlight.has(clusterId)) {
    throw new EditorCockpitError(409, "A source search is already running for this story.");
  }
  boostInFlight.add(clusterId);
  try {
    return await runBoost(clusterId, cluster);
  } finally {
    boostInFlight.delete(clusterId);
  }
}

async function runBoost(
  clusterId: string,
  cluster: NonNullable<Awaited<ReturnType<typeof getStoryCluster>>>,
): Promise<SourceBoostResult> {
  const priorPacket = await getLatestPacket(clusterId);
  const priorDecision = priorPacket?.decision ?? null;

  const settings = await getSiteSettings();
  const subject = [cluster.label, ...cluster.keywords].filter(Boolean).join(" ").slice(0, 300);
  const beatText = cluster.beat ? ` (${cluster.beat})` : "";
  const query = `Latest reporting and primary sources on: ${subject}${beatText}. Recent, specific, citable coverage.`;

  const recencyDays =
    (cluster.beatSlug ? settings.sourceFreshnessByBeat[cluster.beatSlug] : undefined) ??
    (settings.sourceFreshnessDefaultDays > 0 ? settings.sourceFreshnessDefaultDays : 14);
  const domains = settings.sourceDiscoveryAllowedDomains ?? [];

  let leads: Awaited<ReturnType<typeof searchLeads>>;
  try {
    leads = await searchLeads(query, {
      maxResults: MAX_BOOST_LEADS,
      recencyDays,
      domains: domains.length > 0 ? domains : undefined,
    });
  } catch (e) {
    logger.error({ err: e, clusterId }, "Source boost: lead search failed");
    throw new EditorCockpitError(502, "Source search failed. Try again in a moment.");
  }

  const leadsFound = leads.length;
  if (leadsFound === 0) {
    return {
      clusterId,
      query,
      leadsFound: 0,
      added: 0,
      attached: 0,
      failed: 0,
      rescreened: false,
      decision: priorDecision,
      promotable: PROMOTABLE_DECISIONS.has(priorDecision ?? ""),
      message: "No new sources found for this subject.",
    };
  }

  // Ingest each lead end-to-end (SSRF-safe fetch + extract + quality gate +
  // embed). Parallel: each URL is independent and ingestUrl never throws.
  const settled = await Promise.allSettled(
    leads.map((lead) =>
      ingestUrl(lead.url, {
        discoveredVia: "manual_url",
        leadSnippet: lead.snippet ?? undefined,
        beatSlug: cluster.beatSlug,
      }),
    ),
  );

  let added = 0;
  let failed = 0;
  const attachIds: string[] = [];
  settled.forEach((r, i) => {
    if (r.status !== "fulfilled") {
      failed++;
      return;
    }
    const doc = r.value.document;
    const passed =
      (doc.status === "embedded" || doc.status === "extracted") &&
      doc.lifecycleStatus === "active" &&
      !doc.duplicateOfId;
    if (!passed) {
      failed++;
      return;
    }
    added++;
    // Attach to THIS cluster only if (a) it isn't already assigned somewhere —
    // never steal a doc from another story — and (b) it clears the SAME lexical
    // relevance gate the normal clustering pass uses. Boost bypasses the async
    // clustering pass, so without this an authoritative-but-off-topic result
    // could be forced onto the cluster and skew the authority floor / screen.
    if (doc.clusterId) return;
    const lead = leads[i];
    const matchText = [doc.title ?? "", doc.excerpt ?? "", lead?.snippet ?? "", lead?.title ?? ""].join(" ");
    if (textMatchesClusterKeywords(cluster.keywords, matchText)) attachIds.push(doc.id);
  });

  let attached = 0;
  if (attachIds.length > 0) {
    const now = new Date();
    const res = await db
      .update(sourceDocumentsTable)
      .set({ clusterId, clusteredAt: now, updatedAt: now })
      .where(and(inArray(sourceDocumentsTable.id, attachIds), isNull(sourceDocumentsTable.clusterId)))
      .returning({ id: sourceDocumentsTable.id });
    attached = res.length;
    if (attached > 0) {
      try {
        await recomputeStoryCluster(clusterId);
      } catch (e) {
        logger.warn({ err: e, clusterId }, "Source boost: recompute failed (non-fatal)");
      }
    }
  }

  // Re-screen from the vault (no paid research) so the packet reflects the new
  // sourcing and its decision (and promotability) can change. Always builds a
  // fresh version. Degrade cleanly if screening is paused or has no docs.
  let rescreened = false;
  let decision: string | null = priorDecision;
  let screenNote = "";
  try {
    // skipIfUnchanged: when the boost found leads but attached NOTHING to this
    // cluster, its source set (and fingerprint) is unchanged — reuse the prior
    // packet instead of re-billing the screen model for an identical input.
    // When sources DID attach, the fingerprint changed and this builds fresh.
    const { packet } = await buildEvidencePacket(clusterId, {
      research: "vault_only",
      skipIfUnchanged: true,
    });
    rescreened = true;
    decision = packet.decision;
  } catch (e) {
    if (e instanceof EditorialScreenError) {
      screenNote =
        e.status === 409
          ? " Re-screen skipped — editorial screening is paused in the AI Control Center."
          : " Sources added, but re-screening did not complete.";
    } else {
      logger.warn({ err: e, clusterId }, "Source boost: re-screen failed (non-fatal)");
      screenNote = " Sources added, but re-screening did not complete.";
    }
  }

  const promotable = PROMOTABLE_DECISIONS.has(decision ?? "");
  const parts: string[] = [];
  parts.push(
    added === 0
      ? `Found ${leadsFound} lead${leadsFound === 1 ? "" : "s"}, but none passed the quality bar.`
      : `Added ${added} source${added === 1 ? "" : "s"}${attached > 0 ? ` (${attached} attached to this story)` : ""}.`,
  );
  if (rescreened) {
    const label = decision ?? "screened";
    parts.push(
      promotable
        ? `Re-screened as “${label}” — you can promote it now.`
        : `Re-screened as “${label}” — still not enough to promote.`,
    );
  } else {
    parts.push(screenNote.trim() || "Re-screen did not run.");
  }

  logger.info(
    { clusterId, leadsFound, added, attached, failed, rescreened, decision, promotable },
    "Source boost complete",
  );

  return {
    clusterId,
    query,
    leadsFound,
    added,
    attached,
    failed,
    rescreened,
    decision,
    promotable,
    message: parts.join(" "),
  };
}

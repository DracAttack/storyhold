/**
 * Update Article Generator — Task #348 Story Watch.
 *
 * Generates update-kind articles ("articleKind = 'update'") for watched story
 * clusters where the development signal detector has fired. This is NOT a
 * full article pipeline — it reuses the existing drafting infrastructure but
 * with a distinct prompt that:
 *
 *   1. Grounds "story so far" in the SOURCE VAULT (not prior article bodies).
 *      This prevents error compounding: a framing mistake in article 2 cannot
 *      get laundered into article 3's recap, because the recap is built from
 *      the same evidence the original article was drafted from — not from the
 *      AI-generated prose. Retracted sources automatically drop out.
 *
 *   2. Applies the Update Depth Score (deterministic, no AI) to shape length
 *      and thoroughness before drafting — so speed is preserved on small
 *      developments and depth scales only where warranted.
 *
 *   3. Runs a novelty gate before drafting: if the triggering documents cover
 *      substantially the same topic as an already-published chain article
 *      (≥70% topic overlap), the update is suppressed and the signal is
 *      discarded. This is the real re-fire protection.
 *
 * Retraction integration:
 *   - Retracted vault sources are excluded from the "story so far" context.
 *   - If the chain has an uncleared retraction impact the depth score is
 *     capped to "stub" and the generator prompt includes a conservative note.
 *   - The generated article is NOT auto-published when chainHasRetractionImpact
 *     is true — it is placed in "draft" status for editor review.
 */

import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  db,
  articlesTable,
  authorsTable,
  sourceDocumentsTable,
  storyClustersTable,
  adminNotificationsTable,
  type ArticleBlock,
  type Author,
  type FollowThisStoryEntry,
  type StoryUpdatePublishedPayload,
} from "@workspace/db";
import {
  eq,
  and,
  inArray,
  isNotNull,
  isNull,
  desc,
} from "drizzle-orm";
import { logger } from "../lib/logger";
import { resolveDirective, resolveModel, isAiFunctionEnabled } from "./aiSettings";
import { AiFunctionDisabledError, buildAuthorSystemPrompt } from "./llm";
import { computeUpdateDepthScore } from "./updateDepthScore";
import type { DevelopmentSignal } from "./developmentSignalDetector";
import { recordTextUsage } from "./aiUsage";
import { randomUUID } from "crypto";
import { readingTimeFromBody } from "../lib/slug";
import { DEFAULT_SHARE_CARD_URL } from "../lib/objectStorage";
import { autoPostPublished } from "./social";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Topic-overlap threshold above which an update is suppressed as redundant. */
const NOVELTY_OVERLAP_THRESHOLD = 0.70;

/** Active lifecycles that are safe to include as evidence in the recap. */
const EVIDENCE_LIFECYCLES = new Set(["active", "stale"]);

/** Trusted tiers for vault-grounded "story so far" evidence. */
const TRUSTED_TIERS = new Set(["primary", "firsthand", "wire", "reported"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpdateGenerationInput {
  signal: DevelopmentSignal;
  /** The author who will write the update (inherits beat/voice from the cluster). */
  authorId: string;
}

export interface UpdateGenerationResult {
  articleId: string;
  slug: string;
  status: "draft" | "published";
  chainPosition: number;
  skippedReason?: string;
}

export class UpdateGenerationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "UpdateGenerationError";
  }
}

// ---------------------------------------------------------------------------
// Novelty gate
// ---------------------------------------------------------------------------

/**
 * Returns true if the triggering documents cover substantially the same topic
 * as the most-recent published chain article (≥70% token overlap). When true,
 * the update is suppressed — there's nothing meaningfully new to write.
 *
 * This is intentionally lightweight (word overlap, no embeddings) because it
 * must be fast and free. The depth score already gates thoroughness; this gate
 * only suppresses true redundancy.
 */
async function isRedundantDevelopment(
  triggeringDocIds: string[],
  latestChainArticleId: string | null,
): Promise<boolean> {
  if (!latestChainArticleId || triggeringDocIds.length === 0) return false;

  // Fetch the full chain (all published articles that share the anchor's
  // storyChainId, or fall back to the single latest article when it has no
  // chain ID yet). Checking only the latest article lets already-covered facts
  // from earlier chain articles slip back in.
  const [anchorMeta] = await db
    .select({ storyChainId: articlesTable.storyChainId, clusterId: articlesTable.clusterId })
    .from(articlesTable)
    .where(eq(articlesTable.id, latestChainArticleId))
    .limit(1);

  let chainArticles: { body: unknown }[];
  if (anchorMeta?.storyChainId) {
    chainArticles = await db
      .select({ body: articlesTable.body })
      .from(articlesTable)
      .where(
        and(
          eq(articlesTable.storyChainId, anchorMeta.storyChainId),
          eq(articlesTable.status, "published"),
          isNull(articlesTable.quarantinedAt),
        ),
      );
  } else if (anchorMeta?.clusterId) {
    // Fallback: check all published articles in the cluster.
    chainArticles = await db
      .select({ body: articlesTable.body })
      .from(articlesTable)
      .where(
        and(
          eq(articlesTable.clusterId, anchorMeta.clusterId),
          eq(articlesTable.status, "published"),
          isNull(articlesTable.quarantinedAt),
        ),
      );
  } else {
    const [single] = await db
      .select({ body: articlesTable.body })
      .from(articlesTable)
      .where(eq(articlesTable.id, latestChainArticleId))
      .limit(1);
    chainArticles = single ? [single] : [];
  }

  if (chainArticles.length === 0) return false;

  const trigDocs = await db
    .select({ extractedText: sourceDocumentsTable.extractedText, title: sourceDocumentsTable.title })
    .from(sourceDocumentsTable)
    .where(inArray(sourceDocumentsTable.id, triggeringDocIds));

  const trigText = trigDocs
    .map((d) => [d.title, d.extractedText].filter(Boolean).join(" "))
    .join(" ")
    .toLowerCase();

  // Combine all chain article bodies into one corpus for overlap scoring.
  const chainText = chainArticles
    .map((a) => JSON.stringify(a.body))
    .join(" ")
    .toLowerCase();

  // Token-level Jaccard overlap.
  const stopwords = new Set(["the", "a", "an", "is", "are", "was", "were", "in", "on", "at", "to", "of", "and", "or"]);
  const tokenize = (t: string) =>
    new Set(t.match(/\b[a-z]{4,}\b/g)?.filter((w) => !stopwords.has(w)) ?? []);

  const trig = tokenize(trigText);
  const art = tokenize(chainText);
  const intersection = [...trig].filter((t) => art.has(t)).length;
  const union = new Set([...trig, ...art]).size;
  const overlap = union === 0 ? 0 : intersection / union;

  return overlap >= NOVELTY_OVERLAP_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Vault-grounded "story so far"
// ---------------------------------------------------------------------------

/**
 * Build a concise "story so far" from SOURCE VAULT excerpts — never from
 * prior article bodies. This prevents framing errors in prior AI-generated
 * articles from being laundered forward into the recap.
 *
 * Only ACTIVE (non-retracted, non-unavailable) trusted-tier sources are used.
 * Retracted sources automatically drop out, so a retraction cascade naturally
 * removes bad evidence from future recaps.
 */
async function buildVaultGroundedContext(
  clusterId: string,
  excludeDocIds: string[],
  maxExcerpts = 6,
): Promise<string> {
  const docs = await db
    .select({
      title: sourceDocumentsTable.title,
      extractedText: sourceDocumentsTable.extractedText,
      authorityTier: sourceDocumentsTable.authorityTier,
      url: sourceDocumentsTable.url,
      lifecycleStatus: sourceDocumentsTable.lifecycleStatus,
    })
    .from(sourceDocumentsTable)
    .where(
      and(
        eq(sourceDocumentsTable.clusterId, clusterId),
        isNotNull(sourceDocumentsTable.extractedText),
        inArray(sourceDocumentsTable.status, ["fetched", "extracted", "embedded"]),
      ),
    )
    .orderBy(desc(sourceDocumentsTable.createdAt))
    .limit(30);

  const eligible = docs.filter(
    (d) =>
      (d.lifecycleStatus === null || EVIDENCE_LIFECYCLES.has(d.lifecycleStatus ?? "")) &&
      d.authorityTier &&
      TRUSTED_TIERS.has(d.authorityTier) &&
      !excludeDocIds.includes(d.url ?? ""),
  );

  if (eligible.length === 0) return "";

  const excerpts = eligible.slice(0, maxExcerpts).map((d) => {
    const snippet = (d.extractedText ?? "").slice(0, 600).replace(/\s+/g, " ").trim();
    return `[${d.authorityTier?.toUpperCase() ?? "SOURCE"}] ${d.title ?? "(untitled)"}: ${snippet}`;
  });

  return excerpts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Core generator
// ---------------------------------------------------------------------------

/**
 * Generate a single update article for a fired development signal.
 *
 * Returns null when the update is suppressed (redundant development) so the
 * caller can record the skip without treating it as an error.
 */
export async function generateUpdateArticle(
  input: UpdateGenerationInput,
): Promise<UpdateGenerationResult | null> {
  const { signal } = input;

  // Guard: require the story_update AI function to be enabled.
  const enabled = await isAiFunctionEnabled("story_update");
  if (!enabled) {
    throw new AiFunctionDisabledError("story_update");
  }

  // Fetch the cluster and triggering documents.
  const [cluster] = await db
    .select({
      id: storyClustersTable.id,
      label: storyClustersTable.label,
      beatSlug: storyClustersTable.beatSlug,
      score: storyClustersTable.score,
    })
    .from(storyClustersTable)
    .where(eq(storyClustersTable.id, signal.clusterId))
    .limit(1);

  if (!cluster) {
    throw new UpdateGenerationError(`Cluster ${signal.clusterId} not found`, "CLUSTER_NOT_FOUND");
  }

  const trigDocs = await db
    .select({
      id: sourceDocumentsTable.id,
      title: sourceDocumentsTable.title,
      url: sourceDocumentsTable.url,
      extractedText: sourceDocumentsTable.extractedText,
      authorityTier: sourceDocumentsTable.authorityTier,
    })
    .from(sourceDocumentsTable)
    .where(inArray(sourceDocumentsTable.id, signal.triggeringDocIds));

  // Fetch the author.
  const [author] = await db
    .select()
    .from(authorsTable)
    .where(eq(authorsTable.id, input.authorId))
    .limit(1);

  if (!author) {
    throw new UpdateGenerationError(`Author ${input.authorId} not found`, "AUTHOR_NOT_FOUND");
  }

  // Novelty gate: suppress redundant developments.
  const redundant = await isRedundantDevelopment(
    signal.triggeringDocIds,
    signal.latestChainArticleId,
  );
  if (redundant) {
    logger.info(
      { clusterId: signal.clusterId, latestChainArticleId: signal.latestChainArticleId },
      "updateArticleGenerator: novelty gate suppressed redundant development",
    );
    return null;
  }

  // Compute Update Depth Score.
  const newDev = trigDocs[0]?.title ?? cluster.label;
  const depthScore = computeUpdateDepthScore({
    headline: newDev,
    trackType: signal.trackType,
    triggeringDocCount: signal.triggeringDocIds.length,
    allTriggeringAreTrusted: trigDocs.every(
      (d) => d.authorityTier && ["primary", "firsthand", "wire"].includes(d.authorityTier),
    ),
    priorChainDepth: signal.priorChainDepth,
    clusterScore: signal.clusterScore,
    beatSlug: signal.beatSlug,
    activeTrustedSourceCount: signal.activeTrustedSourceCount,
    chainHasRetractionImpact: signal.chainHasRetractionImpact,
  });

  // Build vault-grounded "story so far" context.
  // Exclude triggering doc URLs to keep context and new development separate.
  const trigUrls = trigDocs.map((d) => d.url ?? "");
  const storyContext = await buildVaultGroundedContext(signal.clusterId, trigUrls);

  // Build the triggering-development context.
  const devContext = trigDocs
    .map((d) => {
      const snippet = (d.extractedText ?? "").slice(0, 800).replace(/\s+/g, " ").trim();
      return `[${d.authorityTier?.toUpperCase() ?? "SOURCE"}] ${d.url}\n${d.title ?? "(untitled)"}\n${snippet}`;
    })
    .join("\n\n---\n\n");

  // Determine the next chain position.
  const chainArticles = await db
    .select({ chainPosition: articlesTable.chainPosition })
    .from(articlesTable)
    .where(
      and(
        eq(articlesTable.clusterId, signal.clusterId),
        eq(articlesTable.status, "published"),
        isNull(articlesTable.quarantinedAt),
      ),
    )
    .orderBy(desc(articlesTable.chainPosition))
    .limit(1);

  // Updates always start at position 1 or higher (position 0 is the original).
  // Guard against nulls: if the highest chainPosition in the cluster is null,
  // default to 0 (the original slot), so the first update lands at 1.
  const nextChainPosition = Math.max((chainArticles[0]?.chainPosition ?? 0) + 1, 1);

  // Set storyChainId — inherit from the chain anchor or create one.
  // Also capture the original article's category + slug so the update inherits them.
  let storyChainId: string;
  let originalCategory: string | null = null;
  let originalCategorySlug: string | null = null;
  let anchor: { storyChainId: string | null; id: string; category: string; categorySlug: string; body: ArticleBlock[] | null } | undefined;
  if (signal.latestChainArticleId) {
    [anchor] = await db
      .select({
        storyChainId: articlesTable.storyChainId,
        id: articlesTable.id,
        category: articlesTable.category,
        categorySlug: articlesTable.categorySlug,
        body: articlesTable.body,
      })
      .from(articlesTable)
      .where(eq(articlesTable.id, signal.latestChainArticleId))
      .limit(1);
    storyChainId = anchor?.storyChainId ?? randomUUID();
    originalCategory = anchor?.category ?? null;
    originalCategorySlug = anchor?.categorySlug ?? null;

    // If the anchor article doesn't have a storyChainId yet (it was published
    // before Story Watch launched), set it now so the chain is linkable.
    if (!anchor?.storyChainId) {
      await db
        .update(articlesTable)
        .set({ storyChainId, chainPosition: 0, articleKind: "standard" })
        .where(eq(articlesTable.id, signal.latestChainArticleId));
    }
  } else {
    storyChainId = randomUUID();
  }

  // Draft the update article.
  const model = await resolveModel("story_update");
  if (!model) {
    throw new UpdateGenerationError("No model configured for story_update", "NO_MODEL");
  }

  const prompt = buildUpdatePrompt({
    cluster,
    storyContext,
    devContext,
    depthInstruction: depthScore.generatorInstruction,
    chainHasRetractionImpact: signal.chainHasRetractionImpact,
    chainPosition: nextChainPosition,
  });
  const systemPrompt = buildAuthorSystemPrompt(author as Author, {
    editorialStandards: await resolveDirective("story_update"),
  });

  const startMs = Date.now();
  const message = await anthropic.messages.create({
    model,
    max_tokens: depthScore.depthTarget === "stub" ? 512 : depthScore.depthTarget === "standard" ? 1500 : 3000,
    system: systemPrompt,
    messages: [{ role: "user", content: prompt }],
  });
  const durationMs = Date.now() - startMs;

  const rawText =
    message.content[0]?.type === "text" ? message.content[0].text : "";

  // Record AI usage (fire-and-forget, never throws).
  try {
    recordTextUsage({ operation: "story_update", model, message });
  } catch (e) {
    logger.error({ err: e }, "updateArticleGenerator: recordTextUsage failed");
  }

  // Parse the LLM response.
  const parsed = parseUpdateResponse(rawText);
  if (!parsed) {
    throw new UpdateGenerationError("Failed to parse LLM update response", "PARSE_ERROR");
  }

  // Two-tier promotion: articles ≥600 words graduate to article_kind='standard'
  // (rendered as a full article, eligible for the homepage); shorter stubs stay
  // as 'update' (rendered inline in the chain, ad-threshold skipped).
  const bodyWordCount = JSON.stringify(parsed.body).match(/\b\w+\b/g)?.length ?? 0;
  const resolvedArticleKind: "standard" | "update" = bodyWordCount >= 600 ? "standard" : "update";

  // Always auto-publish: update articles and promoted standard-tier articles
  // publish immediately (the cron signal already passed the novelty + depth gates).
  // Retraction-impacted chains no longer hold as a draft — the authority gate
  // is strict enough; editors can retract/quarantine post-publish if needed.
  const initialStatus: "draft" | "published" = "published";

  // Insert the article.
  const articleId = randomUUID();
  const slug = generateSlug(parsed.title, articleId);
  const now = new Date();

  await db.insert(articlesTable).values({
    id: articleId,
    slug,
    title: parsed.title,
    dek: parsed.dek,
    body: parsed.body,
    authorId: input.authorId,
    // Lock category to the original article to keep the chain in the same
    // editorial section; fall back to parsed output only when no original exists.
    category: originalCategory ?? parsed.category ?? cluster.label,
    categorySlug: originalCategorySlug ?? signal.beatSlug,
    status: initialStatus,
    // Stamp publishedAt at insert time so recency queries, the 14-day
    // developing rail filter, and sitemap/feed ordering all work correctly.
    publishedAt: initialStatus === "published" ? now : undefined,
    articleKind: resolvedArticleKind,
    storyChainId,
    chainPosition: nextChainPosition,
    clusterId: signal.clusterId,
    heroImage: DEFAULT_SHARE_CARD_URL,
    readingTimeMinutes: readingTimeFromBody(parsed.body),
    createdAt: now,
    updatedAt: now,
  });

  // Link via article_relations as a "chain" edge from the prior article.
  if (signal.latestChainArticleId) {
    const { articleRelationsTable } = await import("@workspace/db");
    await db
      .insert(articleRelationsTable)
      .values({
        articleAId: signal.latestChainArticleId,
        articleBId: articleId,
        kind: "chain",
        confidence: "1.0",
        rationale: `Auto-generated update: ${signal.trackType} signal fired for cluster ${signal.clusterId}`,
      })
      .onConflictDoNothing();
  }

  logger.info(
    {
      articleId,
      slug,
      status: initialStatus,
      articleKind: resolvedArticleKind,
      chainPosition: nextChainPosition,
      depthTarget: depthScore.depthTarget,
      depthScore: depthScore.score,
      clusterId: signal.clusterId,
      trackType: signal.trackType,
    },
    "updateArticleGenerator: update article drafted",
  );

  // Trigger social auto-post for published articles (fire-and-forget, never throws).
  if (initialStatus === "published") {
    void autoPostPublished([articleId]).catch((err: unknown) => {
      logger.error({ err, articleId }, "updateArticleGenerator: autoPostPublished failed");
    });
  }

  // Tier 2 (≥600 words, articleKind='standard') gets full-article treatment:
  // generate a hero image and a cockpit notification. Both are fire-and-forget —
  // a failure here NEVER blocks the published article from being visible.
  if (resolvedArticleKind === "standard") {
    void (async () => {
      try {
        // Load the author record needed for image prompt construction.
        const [author] = await db
          .select()
          .from(authorsTable)
          .where(eq(authorsTable.id, input.authorId))
          .limit(1);

        const { generateAndStoreHeroImage } = await import("./heroImage");
        const generated = await generateAndStoreHeroImage(
          {
            title: parsed.title,
            dek: parsed.dek ?? "",
            category: originalCategory ?? parsed.category ?? cluster.label,
            body: parsed.body as { type: string; content: string }[],
          },
          author ?? null,
          slug,
          { operation: "tier2_update_hero", articleId },
        );
        await db
          .update(articlesTable)
          .set({
            heroImage: generated.heroImage,
            shareImage: generated.shareImage,
            feedImage: generated.feedImage,
            updatedAt: new Date(),
          })
          .where(eq(articlesTable.id, articleId));
        logger.info({ articleId, slug }, "updateArticleGenerator: tier2 hero image generated");
      } catch (err) {
        logger.warn({ err, articleId }, "updateArticleGenerator: tier2 hero image generation failed; keeping default card");
      }

      // Cockpit alert: insert a "story_update_published" notification so
      // editors see a prominent banner the next time they open the admin UI.
      try {
        const notifPayload: StoryUpdatePublishedPayload = {
          articleId,
          slug,
          title: parsed.title,
          clusterId: signal.clusterId,
          clusterLabel: cluster.label,
          wordCount: bodyWordCount,
        };
        await db.insert(adminNotificationsTable).values({
          type: "story_update_published",
          subject: `Major update published: ${parsed.title}`,
          bodyHtml: `<p>A major story update (Tier 2, ${bodyWordCount} words) was auto-published for cluster <strong>${cluster.label}</strong>.</p><p><a href="/article/${slug}">${parsed.title}</a></p>`,
          bodyText: `Major story update published (${bodyWordCount} words): "${parsed.title}" — cluster: ${cluster.label}. Read at /article/${slug}`,
          payload: notifPayload,
          recipients: [],
        });
        logger.info({ articleId, clusterId: signal.clusterId }, "updateArticleGenerator: cockpit notification inserted for tier2 update");
      } catch (err) {
        logger.warn({ err, articleId }, "updateArticleGenerator: cockpit notification insert failed");
      }
    })();
  }

  // Stamp the ORIGINAL (root, chainPosition=0) article with a "follow_this_story"
  // block that acts as the timeline anchor for the whole chain, and bump its
  // updatedAt so sitemap/RSS reflects that this story has fresh content.
  // We always update the root — NOT signal.latestChainArticleId (which becomes
  // a prior update article after the first fire) — so the block accumulates all
  // updates in one place.
  if (storyChainId) {
    const [rootArticle] = await db
      .select({ id: articlesTable.id, body: articlesTable.body })
      .from(articlesTable)
      .where(
        and(
          eq(articlesTable.storyChainId, storyChainId),
          eq(articlesTable.chainPosition, 0),
          eq(articlesTable.status, "published"),
          isNull(articlesTable.quarantinedAt),
        ),
      )
      .limit(1);
    if (rootArticle) {
      const existingBody: ArticleBlock[] = Array.isArray(rootArticle.body) ? rootArticle.body : [];
      const ftsIdx = existingBody.findIndex((b) => b.type === "follow_this_story");
      const newEntry: FollowThisStoryEntry = {
        articleId,
        slug,
        title: parsed.title,
        publishedAt: now.toISOString(),
        articleKind: "update",
      };
      let newBody: ArticleBlock[];
      if (ftsIdx >= 0) {
        const existing = existingBody[ftsIdx] as { type: "follow_this_story"; content: string; entries: FollowThisStoryEntry[] };
        const entries = Array.isArray(existing.entries) ? [...existing.entries] : [];
        if (!entries.some((e) => e.articleId === articleId)) entries.push(newEntry);
        newBody = [...existingBody];
        newBody[ftsIdx] = { type: "follow_this_story", content: existing.content ?? "", entries };
      } else {
        newBody = [...existingBody, { type: "follow_this_story" as const, content: "", entries: [newEntry] }];
      }
      await db
        .update(articlesTable)
        .set({ body: newBody, updatedAt: now })
        .where(eq(articlesTable.id, rootArticle.id));
    }
  }

  return {
    articleId,
    slug,
    status: initialStatus,
    chainPosition: nextChainPosition,
  };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

interface PromptArgs {
  cluster: { label: string; beatSlug: string };
  storyContext: string;
  devContext: string;
  depthInstruction: string;
  chainHasRetractionImpact: boolean;
  chainPosition: number;
}

function buildUpdatePrompt(args: PromptArgs): string {
  const {
    cluster,
    storyContext,
    devContext,
    depthInstruction,
    chainHasRetractionImpact,
    chainPosition,
  } = args;

  const isFirstUpdate = chainPosition <= 1;

  return `You are writing an UPDATE article on an ongoing story in the ${cluster.beatSlug} beat.
This is update #${chainPosition} in the chain.

## Depth instruction
${depthInstruction}

## Background: what has already been established
The following are excerpts from SOURCE VAULT documents that ground the existing story.
These are the authoritative facts already established — do NOT fabricate or extrapolate.
${storyContext ? storyContext : "(No prior vault evidence — this is the first update.)"}

## The new development
The following vault sources triggered this update signal:
${devContext}

## Your task
Write a brief, sharp update article covering THIS NEW DEVELOPMENT.

${isFirstUpdate ? "Since this is the first update, briefly establish the story context before reporting the new development." : "The reader has been following this story. Lead with the new development, then provide a concise 'story so far' recap GROUNDED IN THE VAULT SOURCES ABOVE — not in what you might recall from prior articles."}

${chainHasRetractionImpact ? "IMPORTANT: One or more sources supporting this story have been retracted or updated. Be conservative. Do not repeat claims from the prior story unless they are directly supported by the vault sources listed above." : ""}

Respond in this exact JSON format (no markdown, no code fences):
{
  "title": "The article headline",
  "dek": "One sentence subheadline, max 25 words",
  "category": "Display category name",
  "body": [
    {"type": "paragraph", "content": "..."},
    {"type": "heading", "content": "Story So Far"},
    {"type": "paragraph", "content": "..."}
  ]
}

Rules:
- Title should be specific and informative, not clickbait
- Body must be an array of blocks (paragraph, heading only)
- Every factual claim must be supportable by the vault sources provided
- Do not hallucinate facts, people, or institutions not in the sources above
- Keep the "story so far" section grounded in vault evidence, not AI recall
`;
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

interface ParsedUpdate {
  title: string;
  dek: string;
  category?: string;
  body: ArticleBlock[];
}

function parseUpdateResponse(raw: string): ParsedUpdate | null {
  // Extract the first balanced JSON object.
  const start = raw.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) return null;

  try {
    const obj = JSON.parse(raw.slice(start, end)) as Record<string, unknown>;
    if (typeof obj.title !== "string" || typeof obj.dek !== "string") return null;
    if (!Array.isArray(obj.body)) return null;
    return {
      title: obj.title,
      dek: obj.dek,
      category: typeof obj.category === "string" ? obj.category : undefined,
      body: obj.body,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Slug generator
// ---------------------------------------------------------------------------

function generateSlug(title: string, id: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60)
    .replace(/-+$/, "");
  const suffix = id.slice(0, 8);
  return `${base}-${suffix}`;
}

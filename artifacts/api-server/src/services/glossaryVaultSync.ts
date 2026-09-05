/**
 * Glossary → Source Vault sync (Task #306).
 *
 * Keeps an internal "glossary_concept" lane in the Source Vault up to date:
 * each live/draft concept is upserted as a source_document (evidenceEligible =
 * false, discoveredVia = 'glossary_concept') so its definitions, hover text,
 * Wikipedia extract, aliases, linked article slugs, and last-verified timestamp
 * are semantically searchable for INTERNAL CONCEPT MEMORY injection during
 * drafting.
 *
 * These rows are NEVER returned by the standard evidence semanticSearch (the
 * evidenceEligible = false filter blocks them) and NEVER count toward source
 * coverage, authority floor, or verifier support. They exist solely to prime
 * the draft LLM with on-brand term definitions and prevent duplicate concept
 * creation by surfacing existing entries as background context.
 *
 * Content hash: sha256(docText + "|status:" + status + "|conf:" + definitionConfidence)
 * — so re-embedding is triggered any time the prose, aliases, relationships,
 * verification state, or confidence score changes.
 *
 * Hidden concepts: the corresponding vault doc's lifecycleStatus is set to
 * 'unavailable' so it is excluded from all retrieval without losing the row.
 *
 * Pagination: reconcileGlossaryVault processes ALL concepts in cursor-ordered
 * batches of BATCH_SIZE; hidden concept docs are deactivated in a second pass.
 */

import { createHash } from "node:crypto";
import { eq, ne, and, gt, asc, inArray } from "drizzle-orm";
import {
  db,
  conceptsTable,
  conceptAliasesTable,
  conceptRelationshipsTable,
  articleConceptMentionsTable,
  articlesTable,
  sourceDocumentsTable,
  sourceConceptEdgesTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { refreshConceptEdges } from "./conceptEdges";

const GLOSSARY_DOMAIN = "brainhook.internal";
const BATCH_SIZE = 100;

export function glossaryPseudoUrl(conceptId: string): string {
  return `brainhook://glossary/${conceptId}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Fetch the slugs of published articles that mention this concept (for inclusion
 * in the vault document to support cross-link awareness during drafting).
 */
async function buildLinkedArticleSlugs(conceptId: string): Promise<string[]> {
  try {
    const rows = await db
      .select({ slug: articlesTable.slug })
      .from(articleConceptMentionsTable)
      .innerJoin(articlesTable, eq(articleConceptMentionsTable.articleId, articlesTable.id))
      .where(
        and(
          eq(articleConceptMentionsTable.conceptId, conceptId),
          eq(articlesTable.status, "published"),
        ),
      )
      .limit(30);
    return rows.map((r) => r.slug);
  } catch {
    return [];
  }
}

/**
 * Build a structured plain-text document from a concept's data.
 * Includes definition, aliases, relationships, linked article slugs, and
 * last-verified timestamp — everything the draft LLM needs for concept memory.
 */
function buildGlossaryDocText(
  concept: typeof conceptsTable.$inferSelect,
  aliases: Array<{ alias: string }>,
  relatedTerms: Array<{ relationType: string; term: string }>,
  linkedArticleSlugs: string[],
): string {
  const parts: string[] = [`GLOSSARY CONCEPT: ${concept.term}`, `SLUG: ${concept.slug}`, ``];

  if (concept.definition) {
    parts.push(`DEFINITION: ${concept.definition}`);
  }
  if (concept.hoverDefinition) {
    parts.push(``, `HOVER: ${concept.hoverDefinition}`);
  }
  if (concept.wikiTitle && concept.wikiExtract) {
    parts.push(``, `WIKIPEDIA: ${concept.wikiTitle}`, ``, concept.wikiExtract.slice(0, 800));
  }
  if (concept.realLifeExample) {
    parts.push(``, `REAL LIFE EXAMPLE: ${concept.realLifeExample}`);
  }
  if (concept.whatItIsnt) {
    parts.push(``, `WHAT IT IS NOT: ${concept.whatItIsnt}`);
  }
  if (concept.commonlyMisusedOnline) {
    parts.push(``, `COMMONLY MISUSED ONLINE: ${concept.commonlyMisusedOnline}`);
  }
  // Sort all variable-order arrays so the hash is deterministic regardless of
  // DB row-return order. Without sorting, inserting/deleting an alias can
  // shuffle the join order and trigger an unnecessary re-embed.
  const aliasTerms = aliases.map((a) => a.alias).filter(Boolean).sort();
  if (aliasTerms.length > 0) {
    parts.push(``, `ALIASES: ${aliasTerms.join(", ")}`);
  }
  const related = relatedTerms
    .filter((r) => r.relationType !== "distinct_from")
    .sort((a, b) => a.term.localeCompare(b.term));
  const distinct = relatedTerms
    .filter((r) => r.relationType === "distinct_from")
    .sort((a, b) => a.term.localeCompare(b.term));
  if (related.length > 0) {
    parts.push(``, `RELATED CONCEPTS: ${related.map((r) => `${r.relationType}: ${r.term}`).join("; ")}`);
  }
  if (distinct.length > 0) {
    parts.push(``, `DISTINCT FROM (not the same concept): ${distinct.map((r) => r.term).join(", ")}`);
  }
  const sortedSlugs = [...linkedArticleSlugs].sort();
  if (sortedSlugs.length > 0) {
    parts.push(``, `LINKED ARTICLES (${sortedSlugs.length}): ${sortedSlugs.join(", ")}`);
  }
  if (concept.lastProcessedAt) {
    parts.push(``, `LAST VERIFIED: ${concept.lastProcessedAt.toISOString().slice(0, 10)}`);
  }
  return parts.join("\n").trim();
}

/**
 * Compute the content hash that gates re-embedding. Incorporates both the
 * prose document text AND the current verification state (status +
 * definitionConfidence) so a re-verification cycle that updates confidence
 * without changing the prose still triggers a re-embed.
 */
function buildContentHash(
  docText: string,
  concept: Pick<typeof conceptsTable.$inferSelect, "status" | "definitionConfidence">,
): string {
  const stateKey = `|status:${concept.status}|conf:${concept.definitionConfidence ?? 0}`;
  return sha256(docText + stateKey);
}

export interface GlossaryVaultSyncResult {
  ok: boolean;
  action: "created" | "updated" | "skipped" | "deactivated" | "failed";
}

/**
 * Deactivate the vault doc for a concept that has been hard-deleted from
 * conceptsTable. Safe to call fire-and-forget — does not require the concept
 * row to still exist. No-ops if the vault doc is already unavailable or
 * doesn't exist. Used by the admin DELETE /concepts/:id route.
 */
export async function deactivateConceptVaultDoc(conceptId: string): Promise<void> {
  try {
    await db
      .update(sourceDocumentsTable)
      .set({ lifecycleStatus: "unavailable", updatedAt: new Date() })
      .where(
        and(
          eq(sourceDocumentsTable.url, glossaryPseudoUrl(conceptId)),
          ne(sourceDocumentsTable.lifecycleStatus, "unavailable"),
        ),
      );
  } catch (err) {
    logger.warn({ err, conceptId }, "glossary vault: failed to deactivate deleted concept doc");
  }
}

/**
 * Upsert a single concept's vault document. Re-embeds only when the content
 * hash changes (prose, aliases, relationships, or verification state). For
 * hidden concepts the vault doc is set to lifecycleStatus='unavailable'.
 * Safe to call fire-and-forget — logs errors, never throws.
 */
export async function syncConceptToVault(conceptId: string): Promise<GlossaryVaultSyncResult> {
  try {
    const concept = await db
      .select()
      .from(conceptsTable)
      .where(eq(conceptsTable.id, conceptId))
      .limit(1)
      .then((r) => r[0] ?? null);
    if (!concept) return { ok: false, action: "failed" };

    const pseudoUrl = glossaryPseudoUrl(conceptId);

    // Hidden concepts: deactivate the vault doc if one exists.
    if (concept.status === "hidden") {
      const existing = await db
        .select({ id: sourceDocumentsTable.id })
        .from(sourceDocumentsTable)
        .where(eq(sourceDocumentsTable.url, pseudoUrl))
        .limit(1)
        .then((r) => r[0] ?? null);
      if (existing) {
        await db
          .update(sourceDocumentsTable)
          .set({ lifecycleStatus: "unavailable", updatedAt: new Date() })
          .where(eq(sourceDocumentsTable.url, pseudoUrl));
        logger.info({ conceptId, conceptTerm: concept.term }, "glossary vault: deactivated hidden concept");
        return { ok: true, action: "deactivated" };
      }
      return { ok: true, action: "skipped" };
    }

    const [aliases, relatedTerms, linkedArticleSlugs] = await Promise.all([
      db
        .select({ alias: conceptAliasesTable.alias })
        .from(conceptAliasesTable)
        .where(eq(conceptAliasesTable.conceptId, conceptId)),
      db
        .select({
          relationType: conceptRelationshipsTable.relationType,
          term: conceptsTable.term,
        })
        .from(conceptRelationshipsTable)
        .innerJoin(conceptsTable, eq(conceptRelationshipsTable.toConceptId, conceptsTable.id))
        .where(eq(conceptRelationshipsTable.fromConceptId, conceptId)),
      buildLinkedArticleSlugs(conceptId),
    ]);

    const docText = buildGlossaryDocText(concept, aliases, relatedTerms, linkedArticleSlugs);
    const contentHash = buildContentHash(docText, concept);

    const existing = await db
      .select({
        id: sourceDocumentsTable.id,
        contentHash: sourceDocumentsTable.contentHash,
        lifecycleStatus: sourceDocumentsTable.lifecycleStatus,
      })
      .from(sourceDocumentsTable)
      .where(eq(sourceDocumentsTable.url, pseudoUrl))
      .limit(1)
      .then((r) => r[0] ?? null);

    // Only skip if content is unchanged AND the doc is already active.
    // A previously-hidden concept that's now live has an unavailable doc that
    // must be reactivated even when the prose content hasn't changed.
    if (existing && existing.contentHash === contentHash && existing.lifecycleStatus === "active") {
      return { ok: true, action: "skipped" };
    }

    const now = new Date();
    const wordCount = docText.split(/\s+/).filter(Boolean).length;

    await db
      .insert(sourceDocumentsTable)
      .values({
        url: pseudoUrl,
        domain: GLOSSARY_DOMAIN,
        title: `Glossary: ${concept.term}`,
        discoveredVia: "glossary_concept",
        extractedText: docText,
        wordCount,
        contentHash,
        qualityScore: 100,
        qualityFlags: [],
        // "extracted" so the cron re-embed sweep picks this up and embeds it.
        status: "extracted",
        extractionMethod: "glossary_sync",
        fetchedAt: now,
        fetchAllowed: false,
        doNotRefetch: true,
        authorityTier: "reference",
        authoritySource: "manual",
        authorityReason: "internal BrainHook glossary concept",
        lifecycleStatus: "active",
        evidenceEligible: false,
      })
      .onConflictDoUpdate({
        target: sourceDocumentsTable.url,
        set: {
          title: `Glossary: ${concept.term}`,
          extractedText: docText,
          wordCount,
          contentHash,
          // Reset to "extracted" so the re-embed sweep re-embeds with new text.
          status: "extracted",
          chunkCount: 0,
          fetchedAt: now,
          updatedAt: now,
          lifecycleStatus: "active",
          evidenceEligible: false,
        },
      });

    const action: GlossaryVaultSyncResult["action"] = existing ? "updated" : "created";
    logger.info({ conceptId, conceptTerm: concept.term, action }, "glossary vault: synced concept");
    return { ok: true, action };
  } catch (err) {
    logger.error({ err, conceptId }, "glossary vault: sync failed");
    return { ok: false, action: "failed" };
  }
}

export interface GlossaryVaultReconcileResult {
  synced: number;
  skipped: number;
  deactivated: number;
  orphaned: number;
  failed: number;
}

/**
 * Full reconciliation pass over ALL concepts (no hard cap). Three passes:
 *  Pass 1 — cursor-paginated upsert of all non-hidden concepts.
 *  Pass 2 — bulk deactivate vault docs for hidden concepts.
 *  Pass 3 — deactivate orphaned vault docs whose concept was hard-deleted.
 * Called by the hourly cron tick; each upsert is idempotent so safe to interrupt.
 */
export async function reconcileGlossaryVault(): Promise<GlossaryVaultReconcileResult> {
  let synced = 0;
  let skipped = 0;
  let deactivated = 0;
  let orphaned = 0;
  let failed = 0;

  // ── Pass 1: sync all non-hidden concepts (cursor-paginated) ─────────────
  let afterId: string | null = null;
  for (;;) {
    const batch = await db
      .select({ id: conceptsTable.id })
      .from(conceptsTable)
      .where(
        afterId
          ? and(ne(conceptsTable.status, "hidden"), gt(conceptsTable.id, afterId))
          : ne(conceptsTable.status, "hidden"),
      )
      .orderBy(asc(conceptsTable.id))
      .limit(BATCH_SIZE);

    if (batch.length === 0) break;

    for (const { id } of batch) {
      const result = await syncConceptToVault(id);
      if (!result.ok) failed++;
      else if (result.action === "skipped") skipped++;
      else synced++;
      // Task #338: a created/updated vault doc means the concept's content
      // (term, aliases, definition, …) changed — re-tag its source edges so
      // the edge set tracks term/alias edits. Never throws.
      if (result.ok && (result.action === "created" || result.action === "updated")) {
        await refreshConceptEdges(id);
      }
    }

    if (batch.length < BATCH_SIZE) break;
    afterId = batch[batch.length - 1]!.id;
  }

  // ── Pass 2: deactivate vault docs for hidden concepts ───────────────────
  let hiddenAfterId: string | null = null;
  for (;;) {
    const hiddenBatch = await db
      .select({ id: conceptsTable.id })
      .from(conceptsTable)
      .where(
        hiddenAfterId
          ? and(eq(conceptsTable.status, "hidden"), gt(conceptsTable.id, hiddenAfterId))
          : eq(conceptsTable.status, "hidden"),
      )
      .orderBy(asc(conceptsTable.id))
      .limit(BATCH_SIZE);

    if (hiddenBatch.length === 0) break;

    const pseudoUrls = hiddenBatch.map((c) => glossaryPseudoUrl(c.id));
    const activeDocs = await db
      .select({ url: sourceDocumentsTable.url })
      .from(sourceDocumentsTable)
      .where(
        and(
          inArray(sourceDocumentsTable.url, pseudoUrls),
          ne(sourceDocumentsTable.lifecycleStatus, "unavailable"),
        ),
      );

    if (activeDocs.length > 0) {
      const urlsToDeactivate = activeDocs.map((d) => d.url);
      await db
        .update(sourceDocumentsTable)
        .set({ lifecycleStatus: "unavailable", updatedAt: new Date() })
        .where(inArray(sourceDocumentsTable.url, urlsToDeactivate));
      deactivated += activeDocs.length;
    }

    // Task #338: hidden concepts must not keep source edges (they are gone
    // from retrieval + glossary). Hard-deleted concepts are covered by the
    // FK ON DELETE CASCADE; hidden ones need this explicit sweep.
    await db
      .delete(sourceConceptEdgesTable)
      .where(inArray(sourceConceptEdgesTable.conceptId, hiddenBatch.map((c) => c.id)));

    if (hiddenBatch.length < BATCH_SIZE) break;
    hiddenAfterId = hiddenBatch[hiddenBatch.length - 1]!.id;
  }

  // ── Pass 3: deactivate orphaned vault docs (concepts deleted from DB) ────
  // Fetch all active glossary-lane vault docs, then check which conceptIds
  // still exist in conceptsTable. Any miss means the concept was hard-deleted
  // and the vault doc should be deactivated so it cannot appear in retrieval.
  const activeDocs = await db
    .select({ url: sourceDocumentsTable.url })
    .from(sourceDocumentsTable)
    .where(
      and(
        eq(sourceDocumentsTable.discoveredVia, "glossary_concept"),
        ne(sourceDocumentsTable.lifecycleStatus, "unavailable"),
      ),
    );

  if (activeDocs.length > 0) {
    const conceptIds = activeDocs
      .map((d) => d.url.match(/^brainhook:\/\/glossary\/(.+)$/)?.[1])
      .filter((id): id is string => !!id);

    if (conceptIds.length > 0) {
      // Chunk to avoid hitting SQL IN-clause limits with very large catalogs.
      const CHUNK = 500;
      const existingIds = new Set<string>();
      for (let i = 0; i < conceptIds.length; i += CHUNK) {
        const chunk = conceptIds.slice(i, i + CHUNK);
        const rows = await db
          .select({ id: conceptsTable.id })
          .from(conceptsTable)
          .where(inArray(conceptsTable.id, chunk));
        for (const r of rows) existingIds.add(r.id);
      }

      const orphanUrls = activeDocs
        .map((d) => ({
          url: d.url,
          conceptId: d.url.match(/^brainhook:\/\/glossary\/(.+)$/)?.[1],
        }))
        .filter(({ conceptId }) => conceptId && !existingIds.has(conceptId))
        .map(({ url }) => url);

      if (orphanUrls.length > 0) {
        // Chunk the deactivation updates for the same reason.
        for (let i = 0; i < orphanUrls.length; i += CHUNK) {
          const chunk = orphanUrls.slice(i, i + CHUNK);
          await db
            .update(sourceDocumentsTable)
            .set({ lifecycleStatus: "unavailable", updatedAt: new Date() })
            .where(inArray(sourceDocumentsTable.url, chunk));
        }
        orphaned += orphanUrls.length;
        logger.info({ orphaned }, "glossary vault: deactivated orphaned vault docs for deleted concepts");
      }
    }
  }

  logger.info({ synced, skipped, deactivated, orphaned, failed }, "glossary vault: reconcile complete");
  return { synced, skipped, deactivated, orphaned, failed };
}

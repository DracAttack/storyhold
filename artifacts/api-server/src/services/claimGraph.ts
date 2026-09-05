import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  db,
  vaultClaimsTable,
  claimRelationshipsTable,
  articleClaimUsesTable,
  CLAIM_RELATIONSHIP_TYPES,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { isAiFunctionEnabled, resolveDirective, resolveModel } from "./aiSettings";
import { recordTextUsage } from "./aiUsage";
import { extractBalancedJson } from "./researchFallback";
import { VaultBudgetGuard } from "./sourceVaultBudget";
import {
  planClaimReconciliation,
  type PlannedReconciliationPair,
  type ReconciliationClaim,
} from "./claimReconciliationPlan";

const RECONCILIATION_SIMILARITY = 0.8;
const RECONCILIATION_BATCH_SIZE = 20;

function normalizeVector(value: unknown): number[] | null {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value !== "string") return null;
  return value.replace(/^\[|\]$/g, "").split(",").filter(Boolean).map(Number);
}

async function writeRelationship(
  a: string,
  b: string,
  relationshipType: (typeof CLAIM_RELATIONSHIP_TYPES)[number],
  confidence: number,
  model: string,
  notes?: string | null,
): Promise<void> {
  const [claimAId, claimBId] = a < b ? [a, b] : [b, a];
  await db
    .insert(claimRelationshipsTable)
    .values({ claimAId, claimBId, relationshipType, confidence, reconcilerModel: model, notes })
    .onConflictDoUpdate({
      target: [claimRelationshipsTable.claimAId, claimRelationshipsTable.claimBId],
      set: { relationshipType, confidence, reconcilerModel: model, notes, reconciledAt: new Date() },
    });
}

export async function reconcileClaimsForConcept(conceptSlug: string): Promise<{
  candidates: number;
  deterministic: number;
  llmPairs: number;
  relationships: number;
}> {
  if (!(await isAiFunctionEnabled("claim_reconciliation"))) {
    return { candidates: 0, deterministic: 0, llmPairs: 0, relationships: 0 };
  }
  const result = await db.execute(sql`
    SELECT c.id, c.status, COALESCE(c.override_text, c.claim) AS claim,
           c.exact_evidence_span AS evidence, c.source_family_id AS family_id,
           ch.embedding::text AS embedding
    FROM vault_claims c
    JOIN source_concept_edges edge ON edge.source_document_id = c.source_document_id
    JOIN concepts concept ON concept.id = edge.concept_id
    LEFT JOIN source_chunks ch ON ch.id = c.source_chunk_ids[1]
    WHERE concept.slug = ${conceptSlug}
      AND c.status IN ('extracted','reconciled')
  `);
  const claims: ReconciliationClaim[] = result.rows.map((r) => ({
    id: String(r.id),
    status: r.status === "reconciled" ? "reconciled" : "extracted",
    claim: String(r.claim),
    evidence: String(r.evidence),
    familyId: r.family_id ? String(r.family_id) : null,
    embedding: normalizeVector(r.embedding),
  }));

  const { pendingIds, pairs } = planClaimReconciliation(claims, RECONCILIATION_SIMILARITY);
  const ambiguous: PlannedReconciliationPair[] = [];
  let deterministic = 0;
  let relationships = 0;
  for (const pair of pairs) {
    if (pair.sameFamily) {
      await writeRelationship(pair.a.id, pair.b.id, "same_family_repeat", 1, "deterministic-family");
      deterministic += 1;
      relationships += 1;
    } else {
      ambiguous.push(pair);
    }
  }

  const model = await resolveModel("claim_reconciliation");
  const directive = await resolveDirective("claim_reconciliation");
  const guard = ambiguous.length > 0
    ? await VaultBudgetGuard.start(`claim reconciliation ${conceptSlug}`)
    : null;
  const retryIds = new Set<string>();
  const pendingIdSet = new Set(pendingIds);
  for (let offset = 0; offset < ambiguous.length; offset += RECONCILIATION_BATCH_SIZE) {
    await guard?.check();
    const batch = ambiguous.slice(offset, offset + RECONCILIATION_BATCH_SIZE);
    const pairs = batch.map((p, i) => ({
      pair: i,
      claimA: p.a.claim,
      evidenceA: p.a.evidence,
      claimB: p.b.claim,
      evidenceB: p.b.evidence,
    }));
    const prompt = `${directive}

Allowed relationshipType values: ${CLAIM_RELATIONSHIP_TYPES.filter((x) => x !== "same_family_repeat").join(", ")}.
Return ONLY JSON: {"pairs":[{"pair":0,"relationshipType":"supports","confidence":0.9,"notes":"brief reason"}]}.
Every supplied pair must receive exactly one conservative classification.

PAIRS
${JSON.stringify(pairs)}`;
    const message = await anthropic.messages.create(
      { model, max_tokens: 2_500, temperature: 0, messages: [{ role: "user", content: prompt }] },
      { timeout: 90_000 },
    );
    recordTextUsage({ operation: "claimReconciliation", model, message });
    const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    const parsed = extractBalancedJson<{ pairs?: Array<{ pair?: number; relationshipType?: string; confidence?: number; notes?: string }> }>(text);
    const resolvedPairIndexes = new Set<number>();
    for (const item of parsed.pairs ?? []) {
      if (!Number.isInteger(item.pair) || item.pair! < 0 || item.pair! >= batch.length) continue;
      if (
        !item.relationshipType ||
        !(CLAIM_RELATIONSHIP_TYPES as readonly string[]).includes(item.relationshipType) ||
        item.relationshipType === "same_family_repeat"
      ) continue;
      if (resolvedPairIndexes.has(item.pair!)) continue;
      const p = batch[item.pair!]!;
      await writeRelationship(
        p.a.id,
        p.b.id,
        item.relationshipType as (typeof CLAIM_RELATIONSHIP_TYPES)[number],
        Math.max(0, Math.min(1, Number(item.confidence ?? p.similarity))),
        model,
        item.notes ?? null,
      );
      resolvedPairIndexes.add(item.pair!);
      relationships += 1;
    }
    // Do not mark a claim complete when the AI omitted or malformed one of its
    // candidate pairs. It remains extracted and can be retried on the next run.
    for (let i = 0; i < batch.length; i += 1) {
      if (resolvedPairIndexes.has(i)) continue;
      const pair = batch[i]!;
      if (pendingIdSet.has(pair.a.id)) retryIds.add(pair.a.id);
      if (pendingIdSet.has(pair.b.id)) retryIds.add(pair.b.id);
    }
  }

  const completedPendingIds = pendingIds.filter((id) => !retryIds.has(id));
  if (completedPendingIds.length > 0) {
    await db
      .update(vaultClaimsTable)
      .set({ status: "reconciled", updatedAt: new Date() })
      .where(inArray(vaultClaimsTable.id, completedPendingIds));
  }
  return { candidates: ambiguous.length + deterministic, deterministic, llmPairs: ambiguous.length, relationships };
}

export async function reconcilePendingClaimConcepts(limit = 5) {
  const rows = await db.execute(sql`
    SELECT DISTINCT concept.slug
    FROM concepts concept
    JOIN source_concept_edges edge ON edge.concept_id = concept.id
    JOIN vault_claims c ON c.source_document_id = edge.source_document_id
    WHERE c.status = 'extracted'
    ORDER BY concept.slug
    LIMIT ${limit}
  `);
  const results = [];
  for (const row of rows.rows) {
    const slug = String(row.slug);
    try {
      results.push({ slug, ...(await reconcileClaimsForConcept(slug)) });
    } catch (err) {
      logger.error({ err, slug }, "claim reconciliation failed for concept");
    }
  }
  return results;
}

export async function listClaimsForConcept(
  conceptSlug: string,
  opts: { limit?: number; offset?: number } = {},
) {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 25));
  const offset = Math.max(0, opts.offset ?? 0);
  const items = await db.execute(sql`
    SELECT c.id, c.claim, c.override_text, c.claim_type, c.certainty, c.population,
           c.timeframe, c.status, c.created_at, c.source_family_id,
           (
             SELECT count(*)::int
             FROM claim_relationships relationship_row
             JOIN vault_claims related ON related.id = CASE
               WHEN relationship_row.claim_a_id = c.id THEN relationship_row.claim_b_id
               ELSE relationship_row.claim_a_id
             END
             WHERE (relationship_row.claim_a_id = c.id OR relationship_row.claim_b_id = c.id)
               AND related.status NOT IN ('low_quality','failed')
               AND relationship_row.relationship_type IN (
                 'supports','independently_corroborates','partially_supports'
               )
           ) AS supporting_count,
           (
             SELECT count(*)::int
             FROM claim_relationships relationship_row
             JOIN vault_claims related ON related.id = CASE
               WHEN relationship_row.claim_a_id = c.id THEN relationship_row.claim_b_id
               ELSE relationship_row.claim_a_id
             END
             WHERE (relationship_row.claim_a_id = c.id OR relationship_row.claim_b_id = c.id)
               AND related.status NOT IN ('low_quality','failed')
               AND relationship_row.relationship_type = 'contradicts'
           ) AS contradicting_count,
           (
             SELECT count(*)::int
             FROM claim_relationships relationship_row
             JOIN vault_claims related ON related.id = CASE
               WHEN relationship_row.claim_a_id = c.id THEN relationship_row.claim_b_id
               ELSE relationship_row.claim_a_id
             END
             WHERE (relationship_row.claim_a_id = c.id OR relationship_row.claim_b_id = c.id)
               AND related.status NOT IN ('low_quality','failed')
               AND relationship_row.relationship_type IN (
                 'qualifies','different_population','different_definition'
               )
           ) AS qualifying_count,
           (
             SELECT count(DISTINCT family_id)::int
             FROM (
               SELECT c.source_family_id AS family_id
               UNION
               SELECT related.source_family_id
               FROM claim_relationships relationship_row
               JOIN vault_claims related ON related.id = CASE
                 WHEN relationship_row.claim_a_id = c.id THEN relationship_row.claim_b_id
                 ELSE relationship_row.claim_a_id
               END
               WHERE (relationship_row.claim_a_id = c.id OR relationship_row.claim_b_id = c.id)
                 AND related.status NOT IN ('low_quality','failed')
             ) active_families
             WHERE family_id IS NOT NULL
           ) AS independent_family_count,
           (
             SELECT count(DISTINCT article_id)::int
             FROM article_claim_uses WHERE claim_id = c.id
           ) AS article_count
    FROM vault_claims c
    JOIN source_concept_edges edge ON edge.source_document_id = c.source_document_id
    JOIN concepts concept ON concept.id = edge.concept_id
    WHERE concept.slug = ${conceptSlug} AND c.status <> 'failed'
    ORDER BY c.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const summaryResult = await db.execute(sql`
    WITH linked AS (
      SELECT DISTINCT c.id, c.status, c.certainty, c.created_at, c.source_family_id
      FROM vault_claims c
      JOIN source_concept_edges edge ON edge.source_document_id = c.source_document_id
      JOIN concepts concept ON concept.id = edge.concept_id
      WHERE concept.slug = ${conceptSlug}
        AND c.status NOT IN ('failed','low_quality')
    ), support AS (
      SELECT linked.id,
        (
          SELECT count(DISTINCT family_id)::int
          FROM (
            SELECT linked.source_family_id AS family_id
            UNION
            SELECT related.source_family_id
            FROM claim_relationships relationship_row
            JOIN vault_claims related ON related.id = CASE
              WHEN relationship_row.claim_a_id = linked.id THEN relationship_row.claim_b_id
              ELSE relationship_row.claim_a_id
            END
            WHERE (relationship_row.claim_a_id = linked.id OR relationship_row.claim_b_id = linked.id)
              AND related.status NOT IN ('low_quality','failed')
              AND relationship_row.relationship_type IN (
                'supports','independently_corroborates','partially_supports'
              )
          ) supporting_families
          WHERE family_id IS NOT NULL
        ) AS family_count
      FROM linked
    )
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE support.family_count >= 2)::int AS strongly_corroborated,
      count(*) FILTER (
        WHERE linked.certainty = 'disputed' OR EXISTS (
          SELECT 1
          FROM claim_relationships relationship_row
          JOIN vault_claims related ON related.id = CASE
            WHEN relationship_row.claim_a_id = linked.id THEN relationship_row.claim_b_id
            ELSE relationship_row.claim_a_id
          END
          WHERE (relationship_row.claim_a_id = linked.id OR relationship_row.claim_b_id = linked.id)
            AND related.status NOT IN ('low_quality','failed')
            AND relationship_row.relationship_type IN (
              'qualifies','contradicts','different_population','different_definition'
            )
        )
      )::int AS qualified_disputed,
      count(*) FILTER (WHERE support.family_count < 2)::int AS single_family,
      count(*) FILTER (WHERE linked.created_at >= now() - interval '90 days')::int AS new_90_days,
      (
        SELECT count(DISTINCT article_use.article_id)::int
        FROM article_claim_uses article_use
        WHERE article_use.claim_id IN (SELECT id FROM linked)
      ) AS articles_using
    FROM linked
    JOIN support ON support.id = linked.id
  `);
  return {
    items: items.rows,
    summary: summaryResult.rows[0] ?? {},
    limit,
    offset,
  };
}

export async function getClaimDetail(id: string) {
  const claimResult = await db.execute(sql`
    SELECT c.*, d.title AS source_title, d.url AS source_url, d.domain AS source_domain,
      (
        SELECT count(DISTINCT family_id)::int
        FROM (
          SELECT c.source_family_id AS family_id
          UNION
          SELECT related_family.source_family_id
          FROM claim_relationships relationship_row
          JOIN vault_claims related_family ON related_family.id = CASE
            WHEN relationship_row.claim_a_id = c.id THEN relationship_row.claim_b_id
            ELSE relationship_row.claim_a_id
          END
          WHERE (relationship_row.claim_a_id = c.id OR relationship_row.claim_b_id = c.id)
            AND related_family.status NOT IN ('low_quality','failed')
        ) active_families
        WHERE family_id IS NOT NULL
      ) AS independent_family_count
    FROM vault_claims c JOIN source_documents d ON d.id = c.source_document_id
    WHERE c.id = ${id}::uuid LIMIT 1
  `);
  if (!claimResult.rows[0]) return null;
  const [relationships, articles] = await Promise.all([
    db.execute(sql`
      SELECT r.*, related.id AS related_claim_id,
             COALESCE(related.override_text, related.claim) AS related_claim,
             related.source_family_id AS related_family_id
      FROM claim_relationships r
      JOIN vault_claims related ON related.id = CASE WHEN r.claim_a_id = ${id}::uuid THEN r.claim_b_id ELSE r.claim_a_id END
      WHERE (r.claim_a_id = ${id}::uuid OR r.claim_b_id = ${id}::uuid)
        AND related.status NOT IN ('low_quality','failed')
      ORDER BY r.reconciled_at DESC
    `),
    db.execute(sql`
      SELECT a.id, a.slug, a.title
      FROM article_claim_uses acu JOIN articles a ON a.id = acu.article_id
      WHERE acu.claim_id = ${id}::uuid ORDER BY acu.created_at DESC
    `),
  ]);
  return { claim: claimResult.rows[0], relationships: relationships.rows, articles: articles.rows };
}

export async function updateClaim(
  id: string,
  patch: { status?: "low_quality" | "extracted"; overrideText?: string | null },
  adminEmail: string,
) {
  return db.transaction(async (tx) => {
    const shouldReconcile =
      patch.status === "extracted" ||
      (patch.overrideText !== undefined && patch.status !== "low_quality");
    const nextStatus = patch.status === "low_quality"
      ? "low_quality"
      : shouldReconcile
        ? "extracted"
        : undefined;
    const [updated] = await tx
      .update(vaultClaimsTable)
      .set({
        ...(nextStatus ? { status: nextStatus } : {}),
        ...(patch.overrideText !== undefined
          ? { overrideText: patch.overrideText?.trim() || null }
          : {}),
        reviewedBy: adminEmail,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(vaultClaimsTable.id, id))
      .returning();
    if (!updated) return null;

    if (nextStatus === "low_quality" || shouldReconcile) {
      await tx
        .delete(claimRelationshipsTable)
        .where(
          sql`${claimRelationshipsTable.claimAId} = ${id}::uuid OR ${claimRelationshipsTable.claimBId} = ${id}::uuid`,
        );
    }
    return updated;
  });
}

export async function recordArticleClaimUses(articleId: string, chunkIds: string[]): Promise<number> {
  const claims = chunkIds.length === 0
    ? []
    : await db
        .select({ id: vaultClaimsTable.id })
        .from(vaultClaimsTable)
        .where(
          and(
            sql`${vaultClaimsTable.sourceChunkIds} && ${chunkIds}::uuid[]`,
            inArray(vaultClaimsTable.status, ["extracted", "reconciled"]),
          ),
        );

  await db.transaction(async (tx) => {
    // Verification can be repeated with a new packet. Replace the old snapshot
    // instead of accumulating claims the current article no longer relies on.
    await tx.delete(articleClaimUsesTable).where(eq(articleClaimUsesTable.articleId, articleId));
    if (claims.length > 0) {
      await tx
        .insert(articleClaimUsesTable)
        .values(claims.map((claim) => ({ articleId, claimId: claim.id })))
        .onConflictDoNothing();
    }
  });
  return claims.length;
}

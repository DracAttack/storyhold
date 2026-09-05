import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  db,
  sourceChunksTable,
  sourceDocumentsTable,
  vaultClaimsTable,
  claimCalibrationRunsTable,
  claimCalibrationResultsTable,
  claimExtractionReceiptsTable,
  type SourceDocument,
  CLAIM_CERTAINTY,
  CLAIM_TYPES,
} from "@workspace/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { logger } from "../lib/logger";
import { isAiFunctionEnabled, resolveDirective, resolveModel } from "./aiSettings";
import { computeGeminiTextCost, computeTextCost, recordTextUsage } from "./aiUsage";
import { VaultBudgetGuard } from "./sourceVaultBudget";
import { acquireJobLock, finishJob, getJobState, heartbeatJob, isJobRunning } from "./jobState";

export const CLAIM_EXTRACTOR_VERSION = "claims-v1";
const SECTION_WORD_TARGET = 1_500; // roughly 2,000 tokens
const MIN_SECTION_WORDS = 80;
const MAX_CLAIMS_PER_SECTION = 6;
const CLAIM_BACKFILL_JOB = "claim_backfill";
const CLAIM_CALIBRATION_JOB = "claim_calibration";
const CLAIM_JOB_TTL_MS = 2 * 60 * 1000;

export interface DocumentSection {
  text: string;
  chunkIds: string[];
  chunkRanges: Array<{ id: string; start: number; end: number }>;
}

const extractedClaimSchema = z.object({
  claim: z.string().min(1),
  claimType: z.enum(CLAIM_TYPES),
  subject: z.string().min(1),
  relationship: z.string().min(1),
  object: z.string().min(1),
  context: z.string().nullable().optional(),
  population: z.string().nullable().optional(),
  timeframe: z.string().nullable().optional(),
  geographicScope: z.string().nullable().optional(),
  qualifiers: z.record(z.string(), z.unknown()).optional().default({}),
  certainty: z.enum(CLAIM_CERTAINTY),
  exactEvidenceSpan: z.string().min(1),
});
type ExtractedClaim = z.infer<typeof extractedClaimSchema>;

export interface ExtractionResult {
  claims: Array<ExtractedClaim & { sourceChunkIds: string[] }>;
  inputTokens: number;
  outputTokens: number;
  invalidJson: number;
  spanFailures: number;
  noClaimSections: number;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export async function reconstructDocumentSections(documentId: string): Promise<DocumentSection[]> {
  const chunks = await db
    .select({ id: sourceChunksTable.id, content: sourceChunksTable.content })
    .from(sourceChunksTable)
    .where(eq(sourceChunksTable.documentId, documentId))
    .orderBy(asc(sourceChunksTable.chunkIndex));

  const sections: DocumentSection[] = [];
  let start = 0;
  while (start < chunks.length) {
    const picked: typeof chunks = [];
    let words = 0;
    let cursor = start;
    while (cursor < chunks.length && (words < SECTION_WORD_TARGET || picked.length === 0)) {
      const chunk = chunks[cursor]!;
      picked.push(chunk);
      words += wordCount(chunk.content);
      cursor += 1;
    }
    let text = "";
    const chunkRanges: DocumentSection["chunkRanges"] = [];
    for (const chunk of picked) {
      if (text) text += "\n\n";
      const rangeStart = text.length;
      text += chunk.content;
      chunkRanges.push({ id: chunk.id, start: rangeStart, end: text.length });
    }
    sections.push({ text, chunkIds: picked.map((c) => c.id), chunkRanges });
    if (cursor >= chunks.length) break;
    start = Math.max(start + 1, cursor - 1); // one-chunk overlap
  }
  return sections;
}

function chunkIdsForSpan(section: DocumentSection, span: string): string[] {
  const start = section.text.indexOf(span);
  if (start < 0) return [];
  const end = start + span.length;
  return section.chunkRanges
    .filter((range) => range.end > start && range.start < end)
    .map((range) => range.id);
}

function parseJsonArray(text: string): unknown[] {
  const start = text.indexOf("[");
  if (start < 0) throw new Error("No JSON array in claim extraction response.");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quoted) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (char === "[") depth += 1;
    if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        const value = JSON.parse(text.slice(start, i + 1));
        if (!Array.isArray(value)) throw new Error("Claim extraction response was not an array.");
        return value;
      }
    }
  }
  throw new Error("Unbalanced JSON array in claim extraction response.");
}

export function buildClaimExtractionPrompt(
  section: DocumentSection,
  documentMeta: Pick<SourceDocument, "title" | "domain" | "publishedAt" | "authorityTier">,
  directive: string,
): string {
  return `${directive}

SOURCE METADATA
Title: ${documentMeta.title ?? "Untitled"}
Domain: ${documentMeta.domain}
Published: ${documentMeta.publishedAt?.toISOString() ?? "unknown"}
Authority: ${documentMeta.authorityTier}

SOURCE SECTION
<<<
${section.text}
>>>

Return ONLY a JSON array with at most ${MAX_CLAIMS_PER_SECTION} objects. Each object must contain:
claim, claimType (${CLAIM_TYPES.join(" | ")}), subject, relationship, object,
context, population, timeframe, geographicScope, qualifiers (object),
certainty (${CLAIM_CERTAINTY.join(" | ")}), exactEvidenceSpan.

exactEvidenceSpan MUST be an exact verbatim substring copied from SOURCE SECTION.
Extract no claim that is not explicitly supported by the section. Return [] when there are no useful factual claims.`;
}

export function parseClaimExtractionText(
  section: DocumentSection,
  text: string,
  inputTokens = 0,
  outputTokens = 0,
): ExtractionResult {
  let raw: unknown[];
  try {
    raw = parseJsonArray(text);
  } catch {
    return { claims: [], inputTokens, outputTokens, invalidJson: 1, spanFailures: 0, noClaimSections: 0 };
  }

  const claims: ExtractionResult["claims"] = [];
  let shapeFailures = 0;
  let spanFailures = 0;
  for (const item of raw.slice(0, MAX_CLAIMS_PER_SECTION)) {
    const parsed = extractedClaimSchema.safeParse(item);
    if (!parsed.success) {
      shapeFailures += 1;
      continue;
    }
    const sourceChunkIds = chunkIdsForSpan(section, parsed.data.exactEvidenceSpan);
    if (sourceChunkIds.length === 0) {
      spanFailures += 1;
      continue;
    }
    claims.push({ ...parsed.data, sourceChunkIds });
  }
  return {
    claims,
    inputTokens,
    outputTokens,
    invalidJson: shapeFailures > 0 ? 1 : 0,
    spanFailures,
    noClaimSections:
      claims.length === 0 && shapeFailures === 0 && spanFailures === 0 ? 1 : 0,
  };
}

export async function extractClaimsFromSection(
  section: DocumentSection,
  documentMeta: Pick<SourceDocument, "title" | "domain" | "publishedAt" | "authorityTier">,
): Promise<ExtractionResult> {
  if (!(await isAiFunctionEnabled("claim_extraction"))) {
    return { claims: [], inputTokens: 0, outputTokens: 0, invalidJson: 0, spanFailures: 0, noClaimSections: 0 };
  }
  if (wordCount(section.text) < MIN_SECTION_WORDS) {
    return { claims: [], inputTokens: 0, outputTokens: 0, invalidJson: 0, spanFailures: 0, noClaimSections: 0 };
  }

  const model = await resolveModel("claim_extraction");
  const directive = await resolveDirective("claim_extraction");
  const prompt = buildClaimExtractionPrompt(section, documentMeta, directive);

  const message = await anthropic.messages.create(
    {
      model,
      max_tokens: 2_000,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    },
    { timeout: 90_000 },
  );
  recordTextUsage({ operation: "claimExtraction", model, message });
  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const text = message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n");

  return parseClaimExtractionText(section, text, inputTokens, outputTokens);
}

function eligibleDocument(doc: SourceDocument): boolean {
  return (
    doc.evidenceEligible &&
    doc.status === "embedded" &&
    doc.lifecycleStatus === "active" &&
    doc.duplicateOfId === null &&
    doc.discoveredVia !== "glossary_concept" &&
    !doc.promptInjectionSuspected &&
    !["social", "aggregator", "reference", "unknown"].includes(doc.authorityTier)
  );
}

export interface DocumentClaimExtractionStats {
  sections: number;
  claims: number;
  inputTokens: number;
  outputTokens: number;
  invalidJson: number;
  spanFailures: number;
  noClaimSections: number;
}

export function isUsableClaimSection(section: DocumentSection): boolean {
  return wordCount(section.text) >= MIN_SECTION_WORDS;
}

export async function loadEligibleClaimDocument(documentId: string): Promise<SourceDocument | null> {
  const [doc] = await db
    .select()
    .from(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.id, documentId))
    .limit(1);
  return doc && eligibleDocument(doc) ? doc : null;
}

export async function persistClaimsForSection(
  doc: SourceDocument,
  result: ExtractionResult,
): Promise<number> {
  let inserted = 0;
  for (const claim of result.claims) {
    const uniqueChunkIds = [...new Set(claim.sourceChunkIds)];
    const lockKey = [
      doc.id,
      CLAIM_EXTRACTOR_VERSION,
      claim.claim,
      claim.exactEvidenceSpan,
    ].join("\u001f");
    const wasInserted = await db.transaction(async (tx) => {
      // Live ingest and a backfill can discover the same new document at once.
      // Serialize only this exact claim key, then re-check while holding the
      // lock so the two paths cannot create duplicate rows.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      const currentChunks = await tx
        .select({ id: sourceChunksTable.id })
        .from(sourceChunksTable)
        .where(
          and(
            eq(sourceChunksTable.documentId, doc.id),
            inArray(sourceChunksTable.id, uniqueChunkIds),
          ),
        )
        .for("share");
      if (currentChunks.length !== uniqueChunkIds.length) {
        throw new Error(`Source chunks changed during claim extraction for document ${doc.id}; retrying against the new chunks.`);
      }
      const [existing] = await tx
        .select({ id: vaultClaimsTable.id })
        .from(vaultClaimsTable)
        .where(
          and(
            eq(vaultClaimsTable.sourceDocumentId, doc.id),
            eq(vaultClaimsTable.extractorVersion, CLAIM_EXTRACTOR_VERSION),
            eq(vaultClaimsTable.claim, claim.claim),
            eq(vaultClaimsTable.exactEvidenceSpan, claim.exactEvidenceSpan),
          ),
        )
        .limit(1);
      if (existing) return false;
      await tx.insert(vaultClaimsTable).values({
        sourceDocumentId: doc.id,
        sourceFamilyId: doc.sourceFamilyId ?? doc.id,
        sourceChunkIds: claim.sourceChunkIds,
        claim: claim.claim,
        claimType: claim.claimType,
        subject: claim.subject,
        relationship: claim.relationship,
        object: claim.object,
        context: claim.context ?? null,
        population: claim.population ?? null,
        timeframe: claim.timeframe ?? null,
        geographicScope: claim.geographicScope ?? null,
        qualifiers: claim.qualifiers,
        certainty: claim.certainty,
        exactEvidenceSpan: claim.exactEvidenceSpan,
        extractorVersion: CLAIM_EXTRACTOR_VERSION,
      });
      return true;
    });
    if (wasInserted) inserted += 1;
  }
  return inserted;
}

export async function recordDocumentExtractionReceipt(
  doc: SourceDocument,
  stats: Pick<DocumentClaimExtractionStats, "sections" | "claims">,
  provider: "anthropic" | "gemini_batch",
): Promise<void> {
  await db
    .insert(claimExtractionReceiptsTable)
    .values({
      sourceDocumentId: doc.id,
      extractorVersion: CLAIM_EXTRACTOR_VERSION,
      contentHash: doc.contentHash,
      status: "succeeded",
      sectionsProcessed: stats.sections,
      claimsExtracted: stats.claims,
      provider,
      error: null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        claimExtractionReceiptsTable.sourceDocumentId,
        claimExtractionReceiptsTable.extractorVersion,
      ],
      set: {
        contentHash: doc.contentHash,
        status: "succeeded",
        sectionsProcessed: stats.sections,
        claimsExtracted: stats.claims,
        provider,
        error: null,
        updatedAt: new Date(),
      },
    });
}

export async function recordDocumentExtractionFailure(
  doc: SourceDocument,
  stats: Pick<DocumentClaimExtractionStats, "sections" | "claims">,
  provider: "anthropic" | "gemini_batch",
  error: string,
): Promise<void> {
  await db
    .insert(claimExtractionReceiptsTable)
    .values({
      sourceDocumentId: doc.id,
      extractorVersion: CLAIM_EXTRACTOR_VERSION,
      contentHash: doc.contentHash,
      status: "failed",
      sectionsProcessed: stats.sections,
      claimsExtracted: stats.claims,
      provider,
      error,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        claimExtractionReceiptsTable.sourceDocumentId,
        claimExtractionReceiptsTable.extractorVersion,
      ],
      set: {
        contentHash: doc.contentHash,
        status: "failed",
        sectionsProcessed: stats.sections,
        claimsExtracted: stats.claims,
        provider,
        error,
        updatedAt: new Date(),
      },
    });
}

export async function extractClaimsForDocument(
  documentId: string,
  opts: {
    persist?: boolean;
    calibrationRunId?: string;
    guard?: VaultBudgetGuard;
  } = {},
): Promise<DocumentClaimExtractionStats> {
  const doc = await loadEligibleClaimDocument(documentId);
  const empty: DocumentClaimExtractionStats = {
    sections: 0,
    claims: 0,
    inputTokens: 0,
    outputTokens: 0,
    invalidJson: 0,
    spanFailures: 0,
    noClaimSections: 0,
  };
  if (!doc || !(await isAiFunctionEnabled("claim_extraction"))) return empty;

  if (opts.persist !== false) {
    const [receipt] = await db
      .select({ id: claimExtractionReceiptsTable.id, contentHash: claimExtractionReceiptsTable.contentHash })
      .from(claimExtractionReceiptsTable)
      .where(
        and(
          eq(claimExtractionReceiptsTable.sourceDocumentId, documentId),
          eq(claimExtractionReceiptsTable.extractorVersion, CLAIM_EXTRACTOR_VERSION),
          eq(claimExtractionReceiptsTable.status, "succeeded"),
        ),
      )
      .limit(1);
    if (receipt && receipt.contentHash === doc.contentHash) return empty;
  }

  const guard = opts.guard ?? (await VaultBudgetGuard.start(`claim extraction ${documentId}`));
  const sections = await reconstructDocumentSections(documentId);
  const totals: DocumentClaimExtractionStats = { ...empty };
  for (const section of sections) {
    if (!isUsableClaimSection(section)) continue;
    await guard.check();

    if (!(await isAiFunctionEnabled("claim_extraction"))) {
      throw new Error("Claim extraction was paused before the document finished.");
    }
    const result = await extractClaimsFromSection(section, doc);
    totals.sections += 1;
    totals.claims += result.claims.length;
    totals.inputTokens += result.inputTokens;
    totals.outputTokens += result.outputTokens;
    totals.invalidJson += result.invalidJson;
    totals.spanFailures += result.spanFailures;
    totals.noClaimSections += result.noClaimSections;

    if (opts.calibrationRunId) {
      await db.insert(claimCalibrationResultsTable).values({
        runId: opts.calibrationRunId,
        sourceDocumentId: documentId,
        sourceChunkIds: section.chunkIds,
        claims: result.claims,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        invalidJson: result.invalidJson,
        spanFailures: result.spanFailures,
      });
    } else if (opts.persist !== false) {
      await persistClaimsForSection(doc, result);
    }
  }

  if (opts.persist !== false) {
    if (totals.invalidJson > 0 || totals.spanFailures > 0) {
      const message =
        `Claim extraction validation failed for ${doc.id}: ` +
        `${totals.invalidJson} invalid JSON section(s), ` +
        `${totals.spanFailures} unverifiable evidence span(s).`;
      await recordDocumentExtractionFailure(doc, totals, "anthropic", message);
      throw new Error(message);
    }
    await recordDocumentExtractionReceipt(doc, totals, "anthropic");
  }
  return totals;
}

export function scheduleClaimExtraction(documentId: string): void {
  void extractClaimsForDocument(documentId).catch((err) =>
    logger.warn({ err, documentId }, "claim extraction failed after vault ingest"),
  );
}

export async function listEligibleDocumentIds(limit: number, afterId?: string): Promise<string[]> {
  const rows = await db.execute(sql`
    SELECT d.id
    FROM source_documents d
    WHERE d.evidence_eligible = true
      AND d.status = 'embedded'
      AND d.lifecycle_status = 'active'
      AND d.duplicate_of_id IS NULL
      AND d.discovered_via <> 'glossary_concept'
      AND d.prompt_injection_suspected = false
      AND d.authority_tier NOT IN ('social','aggregator','reference','unknown')
      AND (${afterId ?? null}::uuid IS NULL OR d.id > ${afterId ?? null}::uuid)
      AND NOT EXISTS (
        SELECT 1 FROM claim_extraction_receipts receipt
        WHERE receipt.source_document_id = d.id
          AND receipt.extractor_version = ${CLAIM_EXTRACTOR_VERSION}
          AND receipt.status = 'succeeded'
          AND receipt.content_hash IS NOT DISTINCT FROM d.content_hash
      )
    ORDER BY d.id
    LIMIT ${limit}
  `);
  return rows.rows.map((r) => String(r.id));
}

export async function countEligibleClaimDocuments(): Promise<number> {
  const result = await db.execute(sql`
    SELECT count(*)::int AS count
    FROM source_documents d
    WHERE d.evidence_eligible = true
      AND d.status = 'embedded'
      AND d.lifecycle_status = 'active'
      AND d.duplicate_of_id IS NULL
      AND d.discovered_via <> 'glossary_concept'
      AND d.prompt_injection_suspected = false
      AND d.authority_tier NOT IN ('social','aggregator','reference','unknown')
      AND NOT EXISTS (
        SELECT 1 FROM claim_extraction_receipts receipt
        WHERE receipt.source_document_id = d.id
          AND receipt.extractor_version = ${CLAIM_EXTRACTOR_VERSION}
          AND receipt.status = 'succeeded'
          AND receipt.content_hash IS NOT DISTINCT FROM d.content_hash
      )
  `);
  return Number(result.rows[0]?.count ?? 0);
}

export async function startClaimCalibration(sampleSize = 1_000): Promise<{ started: boolean; alreadyRunning: boolean }> {
  if (!(await isAiFunctionEnabled("claim_extraction"))) {
    throw new Error("Claim extraction is paused in AI Control.");
  }
  const runId = await acquireJobLock(CLAIM_CALIBRATION_JOB, { ttlMs: CLAIM_JOB_TTL_MS, progress: {} });
  if (!runId) return { started: false, alreadyRunning: true };

  void (async () => {
    let progress: Record<string, unknown> = { processed: 0, total: 0 };
    const timer = setInterval(() => {
      void heartbeatJob(CLAIM_CALIBRATION_JOB, runId, progress).catch((err) =>
        logger.warn({ err }, "claim calibration heartbeat failed"),
      );
    }, 30_000);
    let calibrationId: string | null = null;
    try {
      const [run] = await db.insert(claimCalibrationRunsTable).values({}).returning();
      if (!run) throw new Error("Failed to create claim calibration report.");
      calibrationId = run.id;

      const filterResult = await db.execute(sql`
        SELECT
          count(*) FILTER (WHERE evidence_eligible = false)::int AS evidence_ineligible,
          count(*) FILTER (WHERE status <> 'embedded')::int AS not_embedded,
          count(*) FILTER (WHERE lifecycle_status <> 'active')::int AS inactive_lifecycle,
          count(*) FILTER (WHERE duplicate_of_id IS NOT NULL)::int AS non_representative,
          count(*) FILTER (WHERE discovered_via = 'glossary_concept')::int AS glossary_documents,
          count(*) FILTER (WHERE prompt_injection_suspected = true)::int AS prompt_injection,
          count(*) FILTER (WHERE authority_tier IN ('social','aggregator','reference','unknown'))::int AS excluded_authority
        FROM source_documents
      `);
      const filterRow = filterResult.rows[0] ?? {};
      const filterCounts = Object.fromEntries(
        Object.entries(filterRow).map(([key, value]) => [key, Number(value ?? 0)]),
      );

      const idsResult = await db.execute(sql`
        WITH eligible AS (
          SELECT id, authority_tier, COALESCE(beat_slug, 'unassigned') AS beat,
                 discovered_via, COALESCE(source_family_id, id) AS family_id
          FROM source_documents
          WHERE evidence_eligible = true
            AND status = 'embedded'
            AND lifecycle_status = 'active'
            AND duplicate_of_id IS NULL
            AND discovered_via <> 'glossary_concept'
            AND prompt_injection_suspected = false
            AND authority_tier NOT IN ('social','aggregator','reference','unknown')
        ), family_representatives AS (
          SELECT *,
                 row_number() OVER (
                   PARTITION BY family_id
                   ORDER BY random()
                 ) AS family_rank
          FROM eligible
        ), ranked AS (
          SELECT id,
                 row_number() OVER (
                   PARTITION BY authority_tier, beat, discovered_via
                   ORDER BY random()
                 ) AS stratum_rank
          FROM family_representatives
          WHERE family_rank = 1
        )
        SELECT id FROM ranked
        ORDER BY stratum_rank, random()
        LIMIT ${sampleSize}
      `);
      const ids = idsResult.rows.map((row) => String(row.id));
      const totals = {
        sections: 0,
        claims: 0,
        inputTokens: 0,
        outputTokens: 0,
        invalidJson: 0,
        spanFailures: 0,
        noClaimSections: 0,
        noClaimDocuments: 0,
      };
      progress = { processed: 0, total: ids.length, ...totals };
      const guard = await VaultBudgetGuard.start(`claim calibration ${runId}`);
      for (let i = 0; i < ids.length; i += 1) {
        await guard.check();
        const result = await extractClaimsForDocument(ids[i]!, {
          persist: false,
          calibrationRunId: run.id,
          guard,
        });
        totals.sections += result.sections;
        totals.claims += result.claims;
        totals.inputTokens += result.inputTokens;
        totals.outputTokens += result.outputTokens;
        totals.invalidJson += result.invalidJson;
        totals.spanFailures += result.spanFailures;
        totals.noClaimSections += result.noClaimSections;
        if (
          result.sections > 0 &&
          result.noClaimSections === result.sections
        ) totals.noClaimDocuments += 1;
        progress = { processed: i + 1, total: ids.length, ...totals };
        await heartbeatJob(CLAIM_CALIBRATION_JOB, runId, progress);
      }

      const duplicateResult = await db.execute(sql`
        SELECT CASE WHEN count(*) = 0 THEN 0 ELSE
          1 - (count(DISTINCT lower(trim((result->>'claim'))))::real / count(*)::real)
        END AS rate
        FROM claim_calibration_results result_row,
             jsonb_array_elements(result_row.claims) result
        WHERE result_row.run_id = ${run.id}
      `);
      const duplicateRate = Number(duplicateResult.rows[0]?.rate ?? 0);
      const usefulClaims = totals.claims * Math.max(0, 1 - duplicateRate);
      const model = await resolveModel("claim_extraction");
      const costUsd = computeTextCost({
        model,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        webSearches: 0,
      });
      await db
        .update(claimCalibrationRunsTable)
        .set({
          status: "succeeded",
          documentsSampled: ids.length,
          sectionsProcessed: totals.sections,
          claimsExtracted: totals.claims,
          noClaimSections: totals.noClaimSections,
          noClaimDocuments: totals.noClaimDocuments,
          filterCounts,
          invalidJsonCount: totals.invalidJson,
          spanVerificationFailures: totals.spanFailures,
          duplicateRate,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          costUsd,
          costPerSource: ids.length ? costUsd / ids.length : 0,
          costPerUsefulClaim: usefulClaims > 0 ? costUsd / usefulClaims : 0,
          finishedAt: new Date(),
        })
        .where(eq(claimCalibrationRunsTable.id, run.id));
      await finishJob(CLAIM_CALIBRATION_JOB, runId, "succeeded", { progress });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (calibrationId) {
        await db
          .update(claimCalibrationRunsTable)
          .set({ status: "failed", error: message, finishedAt: new Date() })
          .where(eq(claimCalibrationRunsTable.id, calibrationId));
      }
      await finishJob(CLAIM_CALIBRATION_JOB, runId, "failed", { progress, error: message });
      logger.error({ err }, "claim calibration failed");
    } finally {
      clearInterval(timer);
    }
  })().catch((err) => logger.error({ err }, "claim calibration state update failed"));

  return { started: true, alreadyRunning: false };
}

export async function getLatestClaimCalibration() {
  const rows = await db.select().from(claimCalibrationRunsTable).orderBy(sql`${claimCalibrationRunsTable.createdAt} DESC`).limit(1);
  return rows[0] ?? null;
}

export async function startClaimBackfill(opts: { dryRun?: boolean; batchSize?: number } = {}) {
  if (!(await isAiFunctionEnabled("claim_extraction"))) {
    throw new Error("Claim extraction is paused in AI Control.");
  }
  const calibration = await getLatestClaimCalibration();
  if (!calibration || calibration.status !== "succeeded") {
    throw new Error("A successful claim calibration is required before backfill.");
  }

  const boundedBatchSize = Math.min(500, Math.max(1, opts.batchSize ?? 500));
  if (opts.dryRun) {
    const [eligibleDocuments, sampleIds] = await Promise.all([
      countEligibleClaimDocuments(),
      listEligibleDocumentIds(100),
    ]);
    let estimatedWords = 0;
    for (const id of sampleIds) {
      const sections = await reconstructDocumentSections(id);
      estimatedWords += sections
        .filter(isUsableClaimSection)
        .reduce((total, section) => total + wordCount(section.text), 0);
    }
    const estimatedInputTokens = Math.ceil(estimatedWords * 1.33);
    const outputRatio = calibration.inputTokens > 0
      ? calibration.outputTokens / calibration.inputTokens
      : 0.08;
    const estimatedOutputTokens = Math.ceil(estimatedInputTokens * outputRatio);
    const model = process.env.CLAIM_BATCH_MODEL ?? "gemini-2.5-flash-lite";
    const estimatedCostUsd = computeGeminiTextCost({
      model,
      inputTokens: estimatedInputTokens,
      outputTokens: estimatedOutputTokens,
      batch: true,
    });
    const projectionScale = sampleIds.length > 0 ? eligibleDocuments / sampleIds.length : 0;
    const projectedInputTokens = Math.ceil(estimatedInputTokens * projectionScale);
    const projectedOutputTokens = Math.ceil(estimatedOutputTokens * projectionScale);
    const projectedCostUsd = computeGeminiTextCost({
      model,
      inputTokens: projectedInputTokens,
      outputTokens: projectedOutputTokens,
      batch: true,
    });
    return {
      started: false,
      alreadyRunning: false,
      dryRun: true,
      documentsSampled: sampleIds.length,
      eligibleDocuments,
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedCostUsd,
      projectedInputTokens,
      projectedOutputTokens,
      projectedCostUsd,
      model,
    };
  }

  const previous = await getJobState(CLAIM_BACKFILL_JOB);
  const resumeProgress = previous?.status === "running" ? previous.progress ?? {} : {};
  const runId = await acquireJobLock(CLAIM_BACKFILL_JOB, {
    ttlMs: CLAIM_JOB_TTL_MS,
    progress: resumeProgress,
  });
  if (!runId) return { started: false, alreadyRunning: true, dryRun: false };

  void import("./claimBatchBackfill")
    .then(({ runGeminiClaimBackfill }) =>
      runGeminiClaimBackfill({
        runId,
        batchSize: boundedBatchSize,
        resumeProgress,
      }),
    )
    .catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      await finishJob(CLAIM_BACKFILL_JOB, runId, "failed", { error: message });
      logger.error({ err }, "claim backfill failed to start");
    });

  return { started: true, alreadyRunning: false, dryRun: false };
}

export async function getClaimJobsStatus() {
  const [calibration, backfill] = await Promise.all([
    getJobState(CLAIM_CALIBRATION_JOB),
    getJobState(CLAIM_BACKFILL_JOB),
  ]);
  return {
    calibration: { ...calibration, running: isJobRunning(calibration, CLAIM_JOB_TTL_MS) },
    backfill: { ...backfill, running: isJobRunning(backfill, CLAIM_JOB_TTL_MS) },
  };
}

import { ai } from "@workspace/integrations-gemini-ai";
import {
  aiUsageEventsTable,
  claimExtractionReceiptsTable,
  db,
  type SourceDocument,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { isAiFunctionEnabled, resolveDirective } from "./aiSettings";
import { recordGeminiTextUsage } from "./aiUsage";
import {
  CLAIM_EXTRACTOR_VERSION,
  buildClaimExtractionPrompt,
  isUsableClaimSection,
  listEligibleDocumentIds,
  loadEligibleClaimDocument,
  parseClaimExtractionText,
  persistClaimsForSection,
  reconstructDocumentSections,
  recordDocumentExtractionReceipt,
  type DocumentClaimExtractionStats,
  type DocumentSection,
} from "./claimExtraction";
import { finishJob, heartbeatJob } from "./jobState";
import { VaultBudgetGuard } from "./sourceVaultBudget";
import {
  createClaimBatchManifest,
  manifestDocumentIds,
  normalizeClaimBatchManifest,
  restoreClaimBatchManifestOrder,
  type ClaimBatchManifestEntry,
} from "./claimBatchManifest";

const CLAIM_BACKFILL_JOB = "claim_backfill";
const HEARTBEAT_MS = 30_000;
const POLL_MS = 30_000;
const MAX_INLINE_BYTES = 15 * 1024 * 1024;
const TERMINAL_STATES = new Set([
  "JOB_STATE_SUCCEEDED",
  "JOB_STATE_FAILED",
  "JOB_STATE_CANCELLED",
  "JOB_STATE_EXPIRED",
]);

type BackfillProgress = Record<string, unknown> & {
  processed: number;
  claims: number;
  failed: number;
  batchesSubmitted: number;
  afterId?: string;
  providerJobName?: string;
  providerState?: string;
  batchDocumentIds?: string[];
  batchManifest?: ClaimBatchManifestEntry[];
  batchRequests?: number;
  model: string;
};

interface BatchInput {
  document: SourceDocument;
  section: DocumentSection;
  sectionIndex: number;
  prompt: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeProgress(value: unknown, model: string): BackfillProgress {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    processed: Number(raw.processed ?? 0),
    claims: Number(raw.claims ?? 0),
    failed: Number(raw.failed ?? 0),
    batchesSubmitted: Number(raw.batchesSubmitted ?? 0),
    afterId: typeof raw.afterId === "string" ? raw.afterId : undefined,
    providerJobName: typeof raw.providerJobName === "string" ? raw.providerJobName : undefined,
    providerState: typeof raw.providerState === "string" ? raw.providerState : undefined,
    batchDocumentIds: Array.isArray(raw.batchDocumentIds)
      ? raw.batchDocumentIds.map(String)
      : undefined,
    batchManifest: normalizeClaimBatchManifest(raw.batchManifest),
    batchRequests: Number(raw.batchRequests ?? 0) || undefined,
    model: typeof raw.model === "string" && raw.model ? raw.model : model,
  };
}

async function markFailedReceipt(doc: SourceDocument, error: string): Promise<void> {
  await db
    .insert(claimExtractionReceiptsTable)
    .values({
      sourceDocumentId: doc.id,
      extractorVersion: CLAIM_EXTRACTOR_VERSION,
      contentHash: doc.contentHash,
      status: "failed",
      provider: "gemini_batch",
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
        provider: "gemini_batch",
        error,
        updatedAt: new Date(),
      },
    });
}

async function hasSuccessfulReceipt(doc: SourceDocument): Promise<boolean> {
  const [receipt] = await db
    .select({ id: claimExtractionReceiptsTable.id })
    .from(claimExtractionReceiptsTable)
    .where(
      and(
        eq(claimExtractionReceiptsTable.sourceDocumentId, doc.id),
        eq(claimExtractionReceiptsTable.extractorVersion, CLAIM_EXTRACTOR_VERSION),
        eq(claimExtractionReceiptsTable.status, "succeeded"),
        sql`${claimExtractionReceiptsTable.contentHash} IS NOT DISTINCT FROM ${doc.contentHash}`,
      ),
    )
    .limit(1);
  return Boolean(receipt);
}

async function buildInputs(
  documentIds: string[],
  directive: string,
): Promise<{
  inputs: BatchInput[];
  includedIds: string[];
  immediatelyCompleted: number;
  immediatelyFailed: number;
}> {
  const inputs: BatchInput[] = [];
  const includedIds: string[] = [];
  let immediatelyCompleted = 0;
  let immediatelyFailed = 0;
  let bytes = 0;

  for (const documentId of documentIds) {
    const document = await loadEligibleClaimDocument(documentId);
    if (!document || await hasSuccessfulReceipt(document)) continue;
    const sections = (await reconstructDocumentSections(document.id)).filter(isUsableClaimSection);
    if (sections.length === 0) {
      await recordDocumentExtractionReceipt(
        document,
        { sections: 0, claims: 0 },
        "gemini_batch",
      );
      immediatelyCompleted += 1;
      continue;
    }

    const documentInputs = sections.map((section, sectionIndex) => ({
      document,
      section,
      sectionIndex,
      prompt: buildClaimExtractionPrompt(section, document, directive),
    }));
    const documentBytes = documentInputs.reduce(
      (total, input) => total + Buffer.byteLength(input.prompt, "utf8"),
      0,
    );
    if (inputs.length > 0 && bytes + documentBytes > MAX_INLINE_BYTES) break;
    if (documentBytes > MAX_INLINE_BYTES) {
      await markFailedReceipt(document, "Document exceeds Gemini inline Batch API size limit.");
      immediatelyFailed += 1;
      continue;
    }
    inputs.push(...documentInputs);
    includedIds.push(document.id);
    bytes += documentBytes;
  }

  return { inputs, includedIds, immediatelyCompleted, immediatelyFailed };
}

async function rebuildSubmittedInputs(
  documentIds: string[],
  directive: string,
): Promise<BatchInput[]> {
  const inputs: BatchInput[] = [];
  for (const documentId of documentIds) {
    const document = await loadEligibleClaimDocument(documentId);
    if (!document) {
      throw new Error(`Cannot safely resume Gemini batch: document ${documentId} is no longer eligible.`);
    }
    const sections = (await reconstructDocumentSections(document.id)).filter(isUsableClaimSection);
    if (sections.length === 0) {
      throw new Error(`Cannot safely resume Gemini batch: document ${documentId} has no usable sections.`);
    }
    inputs.push(...sections.map((section, sectionIndex) => ({
      document,
      section,
      sectionIndex,
      // The provider already has the original prompt. This rebuilt prompt is
      // retained only so BatchInput remains the same shape as a new request.
      prompt: buildClaimExtractionPrompt(section, document, directive),
    })));
  }
  return inputs;
}

function responseText(response: {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
} | undefined): string {
  return (response?.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n");
}

async function pollBatch(
  name: string,
  onState: (state: string) => Promise<void>,
) {
  let job = await ai.batches.get({ name });
  for (;;) {
    const state = String(job.state ?? "JOB_STATE_UNSPECIFIED");
    await onState(state);
    if (TERMINAL_STATES.has(state)) return job;
    await sleep(POLL_MS);
    job = await ai.batches.get({ name });
  }
}

async function recordBatchUsageOnce(input: {
  providerJobName: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  const [existing] = await db
    .select({ id: aiUsageEventsTable.id })
    .from(aiUsageEventsTable)
    .where(
      and(
        eq(aiUsageEventsTable.provider, "gemini"),
        eq(aiUsageEventsTable.operation, "claimExtraction"),
        eq(aiUsageEventsTable.mode, "batch"),
        eq(aiUsageEventsTable.reason, input.providerJobName),
      ),
    )
    .limit(1);
  if (existing) return;
  await recordGeminiTextUsage({
    operation: "claimExtraction",
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    batch: true,
    reason: input.providerJobName,
  });
}

export async function runGeminiClaimBackfill(args: {
  runId: string;
  batchSize: number;
  resumeProgress: unknown;
}): Promise<void> {
  const configuredModel = process.env.CLAIM_BATCH_MODEL ?? "gemini-2.5-flash-lite";
  let progress = normalizeProgress(args.resumeProgress, configuredModel);
  const model = progress.model;
  const timer = setInterval(() => {
    void heartbeatJob(CLAIM_BACKFILL_JOB, args.runId, progress).catch((err) =>
      logger.warn({ err }, "claim backfill heartbeat failed"),
    );
  }, HEARTBEAT_MS);

  try {
    const guard = await VaultBudgetGuard.start(`claim backfill ${args.runId}`);
    const directive = await resolveDirective("claim_extraction");

    for (;;) {
      await guard.check();
      if (!(await isAiFunctionEnabled("claim_extraction"))) {
        throw new Error("Claim extraction was paused in AI Control.");
      }
      const resumingProviderJob = Boolean(progress.providerJobName);
      const requestedIds = resumingProviderJob
        ? progress.batchManifest?.length
          ? manifestDocumentIds(progress.batchManifest)
          : progress.batchDocumentIds ?? []
        : await listEligibleDocumentIds(args.batchSize, progress.afterId);
      if (requestedIds.length === 0) {
        if (resumingProviderJob) {
          throw new Error("Cannot safely resume Gemini batch: stored request identity is missing.");
        }
        break;
      }

      const built = resumingProviderJob
        ? await (async () => {
            const candidates = await rebuildSubmittedInputs(requestedIds, directive);
            if (progress.batchManifest?.length) {
              return {
                inputs: restoreClaimBatchManifestOrder(
                  progress.batchManifest,
                  candidates,
                  CLAIM_EXTRACTOR_VERSION,
                ),
                includedIds: requestedIds,
                immediatelyCompleted: 0,
                immediatelyFailed: 0,
              };
            }
            // Backward-compatible recovery for a provider job submitted before
            // manifests were deployed. Rebuild every original document without
            // skipping successful receipts, and require the old request count.
            if (!progress.batchRequests) {
              throw new Error(
                "Cannot safely resume legacy Gemini batch: stored request count is missing.",
              );
            }
            if (candidates.length !== progress.batchRequests) {
              throw new Error(
                `Cannot safely resume legacy Gemini batch: rebuilt ${candidates.length} of ${progress.batchRequests} requests.`,
              );
            }
            progress.batchManifest = createClaimBatchManifest(
              candidates,
              CLAIM_EXTRACTOR_VERSION,
            );
            await heartbeatJob(CLAIM_BACKFILL_JOB, args.runId, progress);
            return {
              inputs: candidates,
              includedIds: requestedIds,
              immediatelyCompleted: 0,
              immediatelyFailed: 0,
            };
          })()
        : await buildInputs(requestedIds, directive);
      progress.processed += built.immediatelyCompleted + built.immediatelyFailed;
      progress.failed += built.immediatelyFailed;
      if (built.inputs.length === 0) {
        progress.afterId = requestedIds.at(-1);
        progress.providerJobName = undefined;
        progress.batchDocumentIds = undefined;
        progress.batchManifest = undefined;
        progress.batchRequests = undefined;
        await heartbeatJob(CLAIM_BACKFILL_JOB, args.runId, progress);
        continue;
      }

      let providerJobName = progress.providerJobName;
      if (!providerJobName) {
        const created = await ai.batches.create({
          model,
          src: built.inputs.map((input) => ({
            contents: [{ role: "user", parts: [{ text: input.prompt }] }],
            metadata: {
              documentId: input.document.id,
              sectionIndex: String(input.sectionIndex),
            },
            config: {
              temperature: 0,
              maxOutputTokens: 2_000,
              responseMimeType: "application/json",
            },
          })),
          config: {
            displayName: `vault-claims-${args.runId.slice(0, 8)}-${progress.batchesSubmitted + 1}`,
          },
        });
        if (!created.name) throw new Error("Gemini Batch API did not return a job name.");
        providerJobName = created.name;
        progress.batchesSubmitted += 1;
        progress.providerJobName = providerJobName;
        progress.batchDocumentIds = built.includedIds;
        progress.batchManifest = createClaimBatchManifest(
          built.inputs,
          CLAIM_EXTRACTOR_VERSION,
        );
        progress.batchRequests = built.inputs.length;
        progress.providerState = String(created.state ?? "JOB_STATE_PENDING");
        await heartbeatJob(CLAIM_BACKFILL_JOB, args.runId, progress);
      }

      const completed = await pollBatch(providerJobName, async (state) => {
        progress.providerState = state;
        await heartbeatJob(CLAIM_BACKFILL_JOB, args.runId, progress);
      });
      const state = String(completed.state ?? "JOB_STATE_UNSPECIFIED");
      if (state !== "JOB_STATE_SUCCEEDED") {
        progress.providerJobName = undefined;
        progress.batchDocumentIds = undefined;
        progress.batchManifest = undefined;
        progress.batchRequests = undefined;
        await heartbeatJob(CLAIM_BACKFILL_JOB, args.runId, progress);
        throw new Error(
          `Gemini batch ${providerJobName} ended as ${state}: ${completed.error?.message ?? "unknown provider error"}`,
        );
      }

      const responses = completed.dest?.inlinedResponses ?? [];
      if (responses.length !== built.inputs.length) {
        progress.providerJobName = undefined;
        progress.batchDocumentIds = undefined;
        progress.batchManifest = undefined;
        progress.batchRequests = undefined;
        await heartbeatJob(CLAIM_BACKFILL_JOB, args.runId, progress);
        throw new Error(
          `Gemini batch returned ${responses.length} responses for ${built.inputs.length} requests.`,
        );
      }

      const byDocument = new Map<string, {
        document: SourceDocument;
        stats: DocumentClaimExtractionStats;
        failed: boolean;
        errors: string[];
      }>();
      let batchInputTokens = 0;
      let batchOutputTokens = 0;
      const completedDocumentIds = new Set<string>();
      for (const documentId of built.includedIds) {
        const document = built.inputs.find((input) => input.document.id === documentId)?.document;
        if (document && await hasSuccessfulReceipt(document)) {
          completedDocumentIds.add(documentId);
        }
      }

      for (let i = 0; i < built.inputs.length; i += 1) {
        const input = built.inputs[i]!;
        const inline = responses[i]!;
        const usage = inline.response?.usageMetadata;
        const inputTokens = Number(usage?.promptTokenCount ?? 0);
        const outputTokens = Number(usage?.candidatesTokenCount ?? 0);
        batchInputTokens += inputTokens;
        batchOutputTokens += outputTokens;
        // Keep the response index aligned with the original manifest, but do
        // not write or recount a document that completed before this worker
        // resumed (or via live extraction while the provider job was running).
        if (completedDocumentIds.has(input.document.id)) continue;
        const current = byDocument.get(input.document.id) ?? {
          document: input.document,
          stats: {
            sections: 0,
            claims: 0,
            inputTokens: 0,
            outputTokens: 0,
            invalidJson: 0,
            spanFailures: 0,
            noClaimSections: 0,
          },
          failed: false,
          errors: [],
        };

        if (inline.error || !inline.response) {
          current.failed = true;
          current.errors.push(inline.error?.message ?? "Gemini returned no response.");
          byDocument.set(input.document.id, current);
          continue;
        }

        const result = parseClaimExtractionText(
          input.section,
          responseText(inline.response),
          inputTokens,
          outputTokens,
        );
        current.stats.sections += 1;
        current.stats.claims += result.claims.length;
        current.stats.inputTokens += result.inputTokens;
        current.stats.outputTokens += result.outputTokens;
        current.stats.invalidJson += result.invalidJson;
        current.stats.spanFailures += result.spanFailures;
        current.stats.noClaimSections += result.noClaimSections;
        if (result.invalidJson > 0 || result.spanFailures > 0) {
          current.failed = true;
          if (result.invalidJson > 0) {
            current.errors.push(`Section ${input.sectionIndex} returned invalid JSON.`);
          }
          if (result.spanFailures > 0) {
            current.errors.push(
              `Section ${input.sectionIndex} had ${result.spanFailures} unverifiable evidence span(s).`,
            );
          }
        } else {
          await persistClaimsForSection(input.document, result);
        }
        byDocument.set(input.document.id, current);
      }

      await recordBatchUsageOnce({
        providerJobName,
        model,
        inputTokens: batchInputTokens,
        outputTokens: batchOutputTokens,
      });

      for (const item of byDocument.values()) {
        if (item.failed) {
          await markFailedReceipt(item.document, item.errors.join(" "));
          progress.failed += 1;
        } else {
          await recordDocumentExtractionReceipt(item.document, item.stats, "gemini_batch");
          progress.claims += item.stats.claims;
        }
        progress.processed += 1;
      }

      progress.afterId = built.includedIds.at(-1) ?? requestedIds.at(-1);
      progress.providerJobName = undefined;
      progress.providerState = undefined;
      progress.batchDocumentIds = undefined;
      progress.batchManifest = undefined;
      progress.batchRequests = undefined;
      await heartbeatJob(CLAIM_BACKFILL_JOB, args.runId, progress);
    }

    await finishJob(CLAIM_BACKFILL_JOB, args.runId, "succeeded", { progress });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishJob(CLAIM_BACKFILL_JOB, args.runId, "failed", {
      progress,
      error: message,
    });
    logger.error({ err }, "Gemini claim backfill failed");
  } finally {
    clearInterval(timer);
  }
}


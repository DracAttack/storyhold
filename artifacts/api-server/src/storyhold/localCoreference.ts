import type { AnalysisChunk } from "./worldAnalysis";

type JsonRecord = Record<string, unknown>;

export type LocalCoreferenceSpan = {
  sourceId: string;
  chunkId: string;
  clusterKey: string;
  surfaceForm: string;
  startOffset: number;
  endOffset: number;
  context: string;
  clusterMentions: string[];
};

export type LocalCoreferenceReceipt = {
  status: "disabled" | "completed" | "partial" | "failed";
  model: string;
  attemptedChunks: number;
  completedChunkIds: string[];
  mentionCount: number;
  elapsedMilliseconds: number;
  errors: string[];
};

export type LocalCoreferenceResult = {
  spans: LocalCoreferenceSpan[];
  receipt: LocalCoreferenceReceipt;
};

type CoreferenceDocument = {
  id: string;
  sourceId: string;
  text: string;
  currentStart: number;
  currentText: string;
};

const DEFAULT_MODEL = "biu-nlp/f-coref";
const PREVIOUS_CONTEXT_CHARACTERS = 4_000;
const MAXIMUM_DOCUMENT_CHARACTERS = 16_000;
const PRONOUNS = new Set([
  "he", "him", "his", "himself",
  "she", "her", "hers", "herself",
  "they", "them", "their", "theirs", "themself", "themselves",
  "it", "its", "itself",
]);

function clean(value: unknown, maximum: number): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\u0000/g, "").trim().slice(0, maximum)
    : "";
}

function sourceText(value: unknown, maximum: number): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\u0000/g, "").slice(0, maximum)
    : "";
}

function enabled(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLocaleLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function isLoopback(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function endpoint(): string | null {
  const explicit = process.env.STORYHOLD_LOCAL_COREFERENCE_URL?.trim();
  const ner = process.env.STORYHOLD_LOCAL_NER_URL?.trim();
  let value = explicit || "";
  if (!value && ner) {
    try {
      const url = new URL(ner);
      url.pathname = "/coreference";
      url.search = "";
      url.hash = "";
      value = url.toString();
    } catch {
      value = "";
    }
  }
  if (!value) return null;
  return enabled("STORYHOLD_LOCAL_MODELS_ALLOW_REMOTE", false) || isLoopback(value)
    ? value
    : null;
}

export function coreferenceSpanIsPronoun(surface: string): boolean {
  return PRONOUNS.has(
    surface.normalize("NFKC").replace(/[^\p{L}']/gu, "").toLocaleLowerCase(),
  );
}

export function buildCoreferenceDocuments(chunks: AnalysisChunk[]): CoreferenceDocument[] {
  const sorted = [...chunks].sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId) || left.index - right.index
  );
  const previousBySource = new Map<string, AnalysisChunk>();
  return sorted.flatMap((chunk): CoreferenceDocument[] => {
    const currentText = sourceText(chunk.content, MAXIMUM_DOCUMENT_CHARACTERS);
    if (!currentText.trim()) return [];
    const previous = previousBySource.get(chunk.sourceId);
    previousBySource.set(chunk.sourceId, chunk);
    const previousText = previous
      ? sourceText(previous.content, MAXIMUM_DOCUMENT_CHARACTERS).slice(-PREVIOUS_CONTEXT_CHARACTERS)
      : "";
    const prefix = previousText ? `${previousText}\n\n` : "";
    const room = Math.max(1, MAXIMUM_DOCUMENT_CHARACTERS - prefix.length);
    const boundedCurrent = currentText.slice(0, room);
    return [{
      id: chunk.id,
      sourceId: chunk.sourceId,
      text: `${prefix}${boundedCurrent}`,
      currentStart: prefix.length,
      currentText: boundedCurrent,
    }];
  });
}

function records(value: unknown, key: string): JsonRecord[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const nested = (value as JsonRecord)[key];
  return Array.isArray(nested)
    ? nested.filter(
        (item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function contextFor(content: string, start: number, end: number): string {
  return content
    .slice(Math.max(0, start - 140), Math.min(content.length, end + 180))
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
}

async function requestBatch(
  url: string,
  documents: CoreferenceDocument[],
  timeoutMilliseconds: number,
): Promise<JsonRecord> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        documents: documents.map(({ id, text }) => ({ id, text })),
        maxTokensInBatch: 3_000,
      }),
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => ({}))) as JsonRecord;
    if (!response.ok) {
      throw new Error(clean(payload.error, 500) || `HTTP ${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export async function extractLocalCoreference(params: {
  chunks: AnalysisChunk[];
  timeoutMilliseconds?: number;
  stopOnFailure?: boolean;
  resume?: LocalCoreferenceResult;
  onProgress?: (result: LocalCoreferenceResult) => Promise<void> | void;
  onCheckpoint?: () => Promise<void> | void;
}): Promise<LocalCoreferenceResult> {
  const startedAt = Date.now();
  const documents = buildCoreferenceDocuments(params.chunks);
  const model = process.env.STORYHOLD_LOCAL_COREFERENCE_MODEL?.trim() || DEFAULT_MODEL;
  const url = endpoint();
  const isEnabled = enabled("STORYHOLD_LOCAL_COREFERENCE_ENABLED", false);
  const baseReceipt = {
    model,
    attemptedChunks: documents.length,
    completedChunkIds: [] as string[],
    mentionCount: 0,
    elapsedMilliseconds: 0,
    errors: [] as string[],
  };
  if (!isEnabled || !url || documents.length === 0) {
    return {
      spans: [],
      receipt: { ...baseReceipt, status: "disabled", elapsedMilliseconds: Date.now() - startedAt },
    };
  }

  const validDocumentIds = new Set(documents.map((document) => document.id));
  const spans: LocalCoreferenceSpan[] = (params.resume?.spans ?? []).filter(
    (span) => validDocumentIds.has(span.chunkId),
  );
  const completedChunkIds: string[] = [
    ...new Set(
      (params.resume?.receipt.completedChunkIds ?? []).filter((id) =>
        validDocumentIds.has(id),
      ),
    ),
  ];
  const completedDocumentIds = new Set(completedChunkIds);
  const errors: string[] = [...(params.resume?.receipt.errors ?? [])];
  const remainingDocuments = documents.filter(
    (document) => !completedDocumentIds.has(document.id),
  );
  const batchSize = 12;
  for (let offset = 0; offset < remainingDocuments.length; offset += batchSize) {
    const batch = remainingDocuments.slice(offset, offset + batchSize);
    try {
      const payload = await requestBatch(
        url,
        batch,
        Math.max(15_000, params.timeoutMilliseconds ?? 180_000),
      );
      const byId = new Map(batch.map((document) => [document.id, document]));
      for (const returned of records(payload, "documents")) {
        const document = byId.get(clean(returned.id, 160));
        if (!document) continue;
        completedChunkIds.push(document.id);
        for (const cluster of records(returned, "clusters")) {
          const clusterKey = clean(cluster.id, 160);
          const mentions = records(cluster, "mentions").flatMap((mention) => {
            const surface = clean(mention.text, 240);
            const start = Number(mention.start);
            const end = Number(mention.end);
            return surface && Number.isInteger(start) && Number.isInteger(end) &&
              start >= 0 && end > start && end <= document.text.length
              ? [{ surface, start, end }]
              : [];
          });
          const clusterMentions = [...new Set(mentions.map((mention) => mention.surface))].slice(0, 32);
          if (!clusterKey || clusterMentions.length < 2) continue;
          for (const mention of mentions) {
            if (
              mention.start < document.currentStart ||
              mention.end > document.currentStart + document.currentText.length ||
              !coreferenceSpanIsPronoun(mention.surface)
            ) continue;
            const startOffset = mention.start - document.currentStart;
            const endOffset = mention.end - document.currentStart;
            spans.push({
              sourceId: document.sourceId,
              chunkId: document.id,
              clusterKey,
              surfaceForm: mention.surface,
              startOffset,
              endOffset,
              context: contextFor(document.currentText, startOffset, endOffset),
              clusterMentions,
            });
          }
        }
      }
      for (const document of batch) {
        if (!completedChunkIds.includes(document.id)) {
          errors.push(`${document.id}: the coreference service omitted this passage.`);
        }
      }
    } catch (error) {
      errors.push(
        `${batch[0]?.id ?? "batch"}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 600),
      );
      if (params.stopOnFailure) break;
    }
    const uniqueCompleted = [...new Set(completedChunkIds)];
    await params.onProgress?.({
      spans: [...spans],
      receipt: {
        status: uniqueCompleted.length === documents.length ? "completed" : "partial",
        model,
        attemptedChunks: documents.length,
        completedChunkIds: uniqueCompleted,
        mentionCount: spans.length,
        elapsedMilliseconds: Date.now() - startedAt,
        errors: errors.slice(0, 20),
      },
    });
    await params.onCheckpoint?.();
  }
  const uniqueCompleted = [...new Set(completedChunkIds)];
  const status: LocalCoreferenceReceipt["status"] = uniqueCompleted.length === documents.length
    ? "completed"
    : uniqueCompleted.length > 0
      ? "partial"
      : "failed";
  return {
    spans,
    receipt: {
      status,
      model,
      attemptedChunks: documents.length,
      completedChunkIds: uniqueCompleted,
      mentionCount: spans.length,
      elapsedMilliseconds: Date.now() - startedAt,
      errors: errors.slice(0, 20),
    },
  };
}

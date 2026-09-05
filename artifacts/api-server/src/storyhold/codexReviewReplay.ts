import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
import type { WorldFindings } from "./worldAnalysis";

type JsonRecord = Record<string, unknown>;

type ReplaySourceChunk = {
  chunkId: string;
  sourceId: string;
  content: string;
};

type ReplayRequest = {
  model?: unknown;
  messages?: unknown;
};

type ReplayCompletion = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: "stop";
  }>;
  usage: {
    prompt_tokens: 0;
    completion_tokens: 0;
    total_tokens: 0;
    prompt_tokens_details: { cached_tokens: 0; cache_creation_tokens: 0 };
    completion_tokens_details: { reasoning_tokens: 0 };
  };
};

export class CodexReviewReplayError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "CodexReviewReplayError";
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const EVIDENCE_FINDING_KEYS = [
  "worldRules",
  "locations",
  "factions",
  "institutions",
  "governments",
  "powerStructures",
  "creatures",
  "species",
  "technologies",
  "vehicles",
  "devices",
  "weapons",
  "powers",
  "titles",
  "ambiguous",
  "chapterSummaries",
  "chronology",
  "entityRelations",
  "entityRules",
  "claims",
  "cohesionProposals",
] as const;

const REQUIRED_ARRAY_KEYS = [
  "genres",
  "atmosphere",
  "themes",
  "recurringTerms",
  "openQuestions",
  "characters",
  ...EVIDENCE_FINDING_KEYS.filter((key) => key !== "claims"),
] as const;

const FINDING_LIMITS: Partial<Record<(typeof EVIDENCE_FINDING_KEYS)[number], number>> = {
  worldRules: 40,
  locations: 40,
  factions: 40,
  institutions: 40,
  governments: 40,
  powerStructures: 40,
  creatures: 40,
  species: 40,
  technologies: 40,
  vehicles: 40,
  devices: 40,
  weapons: 40,
  powers: 40,
  titles: 40,
  ambiguous: 40,
  entityRelations: 160,
  entityRules: 160,
  claims: 320,
  cohesionProposals: 40,
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function messageContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((item) => {
      if (!isRecord(item)) return [];
      return typeof item.text === "string" ? [item.text] : [];
    })
    .join("\n");
}

function messagesFromRequest(request: ReplayRequest): Array<{
  role: string;
  content: string;
}> {
  if (!Array.isArray(request.messages)) {
    throw new CodexReviewReplayError("The chat request must include a messages array.");
  }
  return request.messages.flatMap((message) => {
    if (!isRecord(message)) return [];
    const role = typeof message.role === "string" ? message.role : "";
    const content = messageContent(message.content);
    return role && content ? [{ role, content }] : [];
  });
}

function parseJsonAttribute(value: string | undefined, name: string): string {
  if (!value) throw new CodexReviewReplayError(`A SOURCE label omitted ${name}.`);
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "string" || !parsed.trim()) throw new Error("not text");
    return parsed;
  } catch {
    throw new CodexReviewReplayError(`A SOURCE label had an invalid ${name}.`);
  }
}

/** Extract only the exact SOURCE envelope emitted by worldAnalysisRequest. */
export function sourceChunksFromMessages(messages: Array<{ content: string }>): ReplaySourceChunk[] {
  const text = messages.map((message) => message.content).join("\n");
  const pattern =
    /<SOURCE\s+title=("(?:\\.|[^"\\])*")\s+chunkId=("(?:\\.|[^"\\])*")\s+sourceId=("(?:\\.|[^"\\])*")\s+index=(\d+)>\r?\n([\s\S]*?)\r?\n<\/SOURCE>/gu;
  const chunks: ReplaySourceChunk[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const chunkId = parseJsonAttribute(match[2], "chunkId");
    const sourceId = parseJsonAttribute(match[3], "sourceId");
    if (!UUID_PATTERN.test(chunkId)) {
      throw new CodexReviewReplayError(
        `SOURCE chunkId ${JSON.stringify(chunkId)} is not a current UUID.`,
      );
    }
    if (!UUID_PATTERN.test(sourceId)) {
      throw new CodexReviewReplayError(
        `SOURCE sourceId ${JSON.stringify(sourceId)} is not a UUID.`,
      );
    }
    if (seen.has(chunkId)) {
      throw new CodexReviewReplayError(`SOURCE chunkId ${chunkId} was repeated.`);
    }
    seen.add(chunkId);
    chunks.push({ chunkId, sourceId, content: match[5] ?? "" });
  }
  if (chunks.length === 0) {
    throw new CodexReviewReplayError(
      "The extraction request contained no valid current SOURCE chunks.",
    );
  }
  return chunks;
}

function filteredEvidence(
  value: unknown,
  chunks: Map<string, ReplaySourceChunk>,
): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  const result: JsonRecord[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const chunkId = typeof entry.chunkId === "string" ? entry.chunkId : "";
    const quote = typeof entry.quote === "string" ? normalizedText(entry.quote) : "";
    const chunk = chunks.get(chunkId);
    if (!chunk || !quote || quote.length > 500) continue;
    if (!normalizedText(chunk.content).includes(quote)) continue;
    const key = `${chunkId}\u0000${quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ chunkId, sourceId: chunk.sourceId, quote });
  }
  return result;
}

function hasFindingIdentity(
  key: (typeof EVIDENCE_FINDING_KEYS)[number],
  item: JsonRecord,
): boolean {
  const text = (value: unknown) => typeof value === "string" && value.trim().length > 0;
  if (key === "chapterSummaries") return text(item.chapterTitle) || text(item.title);
  if (key === "chronology") return text(item.name) || text(item.statement);
  if (key === "entityRelations") {
    return text(item.subject) && text(item.target) &&
      normalizedKey(item.subject) !== normalizedKey(item.target);
  }
  if (key === "entityRules") return text(item.entity) && text(item.name);
  if (key === "claims") {
    return text(item.subject) && text(item.predicate) &&
      (text(item.value) || text(item.object));
  }
  if (key === "cohesionProposals") {
    return (text(item.subject) || text(item.name)) && text(item.summary);
  }
  return text(item.name) || text(item.statement);
}

function filterEvidenceItems(
  key: (typeof EVIDENCE_FINDING_KEYS)[number],
  value: unknown,
  chunks: Map<string, ReplaySourceChunk>,
): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  const filtered = value.flatMap((item) => {
    if (!isRecord(item)) return [];
    if (!hasFindingIdentity(key, item)) return [];
    const evidence = filteredEvidence(item.evidence, chunks);
    if (evidence.length === 0) return [];
    return [{ ...item, evidence }];
  });
  const limit = FINDING_LIMITS[key];
  return typeof limit === "number" ? filtered.slice(0, limit) : filtered;
}

function filterCharacters(
  value: unknown,
  chunks: Map<string, ReplaySourceChunk>,
): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    if (typeof item.name !== "string" || !item.name.trim()) return [];
    const evidence = filteredEvidence(item.evidence, chunks);
    const relationshipWeb = Array.isArray(item.relationshipWeb)
      ? item.relationshipWeb.flatMap((relationship) => {
          if (!isRecord(relationship)) return [];
          const relationshipEvidence = filteredEvidence(
            relationship.evidence,
            chunks,
          );
          return relationshipEvidence.length
            ? [{ ...relationship, evidence: relationshipEvidence }]
            : [];
        })
      : [];
    // A character's profile evidence and an individual relationship can live
    // in different extraction batches. Keep the relationship-only slice so
    // the validated edge evidence can be reassembled later; the parser strips
    // unsupported profile fields from slices without profile evidence.
    if (evidence.length === 0 && relationshipWeb.length === 0) return [];
    if (evidence.length === 0) {
      return [{ name: item.name, evidence, relationshipWeb }];
    }
    return [{ ...item, evidence, relationshipWeb }];
  }).slice(0, 80);
}

function citedChunkIds(value: unknown): Set<string> {
  const result = new Set<string>();
  const visit = (item: unknown, key = "") => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child, key);
      return;
    }
    if (!isRecord(item)) return;
    if (key === "evidence" && typeof item.chunkId === "string") {
      result.add(item.chunkId);
    }
    for (const [childKey, child] of Object.entries(item)) visit(child, childKey);
  };
  visit(value);
  return result;
}

export function extractionReplayPayload(
  curated: WorldFindings,
  chunks: ReplaySourceChunk[],
  options: { includeGlobalContext?: boolean } = {},
): JsonRecord {
  const chunkMap = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
  const source = curated as unknown as JsonRecord;
  const payload: JsonRecord = { ...source };
  for (const key of EVIDENCE_FINDING_KEYS) {
    payload[key] = filterEvidenceItems(key, source[key], chunkMap);
  }
  payload.characters = filterCharacters(source.characters, chunkMap);
  if (options.includeGlobalContext === false) {
    // combineFindings deliberately joins batch-level summaries. A curated
    // whole-world summary is global rather than passage-local, so emit it once
    // instead of repeating the same prose for every replayed batch.
    payload.summary = "";
    payload.genres = [];
    payload.atmosphere = [];
    payload.themes = [];
    payload.recurringTerms = [];
    payload.openQuestions = [];
  }
  const cited = citedChunkIds(payload);
  payload.coverage = chunks.map((chunk) => ({
    chunkId: chunk.chunkId,
    status: cited.has(chunk.chunkId) ? "findings" : "no_findings",
  }));
  return payload;
}

function synthesisGroupFromMessages(messages: Array<{ content: string }>): JsonRecord {
  const userText = messages
    .filter((message) => message.content.includes("Reconcile this bounded group"))
    .map((message) => message.content)
    .at(-1);
  if (!userText) {
    throw new CodexReviewReplayError("The chronology request omitted its synthesis group.");
  }
  const marker = "later groups are merged deterministically:";
  const markerIndex = userText.lastIndexOf(marker);
  const jsonStart = userText.indexOf("{", Math.max(0, markerIndex));
  if (markerIndex < 0 || jsonStart < 0) {
    throw new CodexReviewReplayError("The chronology synthesis group was malformed.");
  }
  try {
    const parsed = JSON.parse(userText.slice(jsonStart).trim()) as unknown;
    if (!isRecord(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new CodexReviewReplayError("The chronology synthesis group was not valid JSON.");
  }
}

function evidenceChunkIdSet(value: unknown): Set<string> {
  const ids = citedChunkIds(value);
  for (const id of ids) {
    if (!UUID_PATTERN.test(id)) {
      throw new CodexReviewReplayError(
        `The chronology group cited non-UUID chunkId ${JSON.stringify(id)}.`,
      );
    }
  }
  return ids;
}

function synthesisEvidence(value: unknown, allowedIds: Set<string>): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  const result: JsonRecord[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const chunkId = typeof entry.chunkId === "string" ? entry.chunkId : "";
    const quote = typeof entry.quote === "string" ? normalizedText(entry.quote) : "";
    if (!allowedIds.has(chunkId) || !quote || quote.length > 500) continue;
    const key = `${chunkId}\u0000${quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...entry, chunkId, quote });
  }
  return result;
}

function normalizedKey(value: unknown): string {
  return typeof value === "string" ? normalizedText(value).toLocaleLowerCase() : "";
}

export function chronologyReplayPayload(
  curated: WorldFindings,
  group: JsonRecord,
): JsonRecord {
  const incomingChapters = Array.isArray(group.chapterSummaries)
    ? group.chapterSummaries.filter(isRecord)
    : [];
  const chapterKeys = incomingChapters.map((chapter) =>
    typeof chapter.chapterKey === "string" ? chapter.chapterKey.trim() : ""
  );
  if (chapterKeys.some((key) => !key)) {
    throw new CodexReviewReplayError("Every supplied chapter must have a chapterKey.");
  }
  if (new Set(chapterKeys).size !== chapterKeys.length) {
    throw new CodexReviewReplayError("The synthesis group repeated a chapterKey.");
  }
  const allowedEvidenceIds = evidenceChunkIdSet(group);
  const curatedByKey = new Map(
    curated.chapterSummaries.map((chapter) => [chapter.chapterKey, chapter]),
  );
  const chapterSummaries = incomingChapters.map((incoming, index) => {
    const chapterKey = chapterKeys[index]!;
    const preferred = curatedByKey.get(chapterKey) as unknown as JsonRecord | undefined;
    const evidence = synthesisEvidence(
      [...(Array.isArray(preferred?.evidence) ? preferred.evidence : []),
        ...(Array.isArray(incoming.evidence) ? incoming.evidence : [])],
      allowedEvidenceIds,
    );
    if (evidence.length === 0) {
      throw new CodexReviewReplayError(
        `Chapter ${JSON.stringify(chapterKey)} has no usable in-group evidence.`,
      );
    }
    return {
      ...incoming,
      ...(preferred ?? {}),
      sourceId: incoming.sourceId,
      sourceTitle: incoming.sourceTitle,
      chapterKey,
      sourceOrder: incoming.sourceOrder,
      evidence,
    };
  });

  const expectedKeys = new Set(chapterKeys);
  const incomingChronology = Array.isArray(group.chronology)
    ? group.chronology.filter(isRecord)
    : [];
  const chronologyAnchorKey = [...curated.chapterSummaries]
    .sort((left, right) =>
      left.sourceTitle.localeCompare(right.sourceTitle) ||
      left.sourceOrder - right.sourceOrder ||
      left.chapterKey.localeCompare(right.chapterKey)
    )[0]?.chapterKey;
  const emitsCanonicalChronology = chronologyAnchorKey
    ? expectedKeys.has(chronologyAnchorKey)
    : incomingChronology.length > 0;
  const curatedChronology = emitsCanonicalChronology
    ? curated.chronology as unknown as JsonRecord[]
    : [];
  const allowedChronologyEvidenceIds = new Set(allowedEvidenceIds);
  const allowedChronologyChapterKeys = new Set(expectedKeys);
  if (emitsCanonicalChronology) {
    // The production validator rechecks these citations against the complete
    // current chunk map. Let the one deterministic anchor group carry the
    // complete reviewed chronology so group boundaries cannot put flashbacks
    // back into reading order.
    for (const id of evidenceChunkIdSet(curatedChronology)) {
      allowedChronologyEvidenceIds.add(id);
    }
    for (const chapter of curated.chapterSummaries) {
      allowedChronologyChapterKeys.add(chapter.chapterKey);
    }
  }
  const chronologyByKey = new Map<string, JsonRecord>();
  // The curated review is already in canonical story-world order. Keep that
  // order through synthesis instead of inheriting upload/chapter order from
  // the draft group (which would put flashbacks and ancient history back in
  // reading order). Incoming rows remain useful as evidence/key fallbacks.
  for (const candidate of [...curatedChronology, ...incomingChronology]) {
    const evidence = synthesisEvidence(candidate.evidence, allowedChronologyEvidenceIds);
    if (evidence.length === 0) continue;
    const sourceChapterKeys = Array.isArray(candidate.sourceChapterKeys)
      ? candidate.sourceChapterKeys.filter(
          (key): key is string =>
            typeof key === "string" && allowedChronologyChapterKeys.has(key),
        )
      : [];
    const key = `${normalizedKey(candidate.name)}\u0000${normalizedKey(candidate.worldTimeLabel)}`;
    if (!normalizedKey(candidate.name)) continue;
    const current = chronologyByKey.get(key);
    if (!current) {
      chronologyByKey.set(key, { ...candidate, sourceChapterKeys, evidence });
      continue;
    }
    const currentEvidence = Array.isArray(current.evidence) ? current.evidence : [];
    const currentKeys = Array.isArray(current.sourceChapterKeys)
      ? current.sourceChapterKeys.filter((item): item is string => typeof item === "string")
      : [];
    chronologyByKey.set(key, {
      ...candidate,
      ...current,
      sourceChapterKeys: [...new Set([...currentKeys, ...sourceChapterKeys])],
      evidence: synthesisEvidence(
        [...currentEvidence, ...evidence],
        allowedChronologyEvidenceIds,
      ),
    });
  }
  return { chapterSummaries, chronology: [...chronologyByKey.values()] };
}

function completion(model: unknown, payload: JsonRecord): ReplayCompletion {
  return {
    id: `chatcmpl-storyhold-replay-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1_000),
    model: typeof model === "string" && model.trim()
      ? model
      : "storyhold-codex-review-replay",
    choices: [{
      index: 0,
      message: { role: "assistant", content: JSON.stringify(payload) },
      finish_reason: "stop",
    }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0, cache_creation_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

export function replayCompletionForRequest(
  curated: WorldFindings,
  request: ReplayRequest,
): ReplayCompletion {
  const messages = messagesFromRequest(request);
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
  // Only the trusted system message selects the replay operation. A manuscript
  // passage can contain arbitrary prose, including text that resembles the
  // synthesis instruction, and must never be allowed to switch handlers.
  const isSynthesis = system.includes("Storyhold's chronology editor");
  if (isSynthesis) {
    return completion(
      request.model,
      chronologyReplayPayload(curated, synthesisGroupFromMessages(messages)),
    );
  }
  const isExtraction =
    system.includes("reviewable world model") &&
    messages.some((message) => message.content.includes("<SOURCE "));
  if (!isExtraction) {
    throw new CodexReviewReplayError(
      "This replay server only accepts Storyhold world extraction and chronology synthesis prompts.",
    );
  }
  const extractionUserText = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
  const batchNumber = Number(
    extractionUserText.match(/source batch\s+(\d+)\s+of\s+\d+/iu)?.[1] ?? 1,
  );
  return completion(
    request.model,
    extractionReplayPayload(curated, sourceChunksFromMessages(messages), {
      includeGlobalContext: batchNumber === 1,
    }),
  );
}

export function validateCuratedWorldFindings(value: unknown): WorldFindings {
  if (!isRecord(value)) {
    throw new CodexReviewReplayError("The curated findings JSON must be one object.");
  }
  if (typeof value.summary !== "string") {
    throw new CodexReviewReplayError("The curated findings JSON omitted summary.");
  }
  for (const key of REQUIRED_ARRAY_KEYS) {
    if (!Array.isArray(value[key])) {
      throw new CodexReviewReplayError(
        `The curated findings JSON omitted required array ${key}.`,
      );
    }
  }
  if (value.claims !== undefined && !Array.isArray(value.claims)) {
    throw new CodexReviewReplayError("The curated findings claims field must be an array.");
  }
  const chapterSummaries = value.chapterSummaries;
  const chronology = value.chronology;
  if (!Array.isArray(chapterSummaries) || !Array.isArray(chronology)) {
    throw new CodexReviewReplayError(
      "The curated findings JSON omitted chapterSummaries or chronology.",
    );
  }
  const chapterKeys = new Set<string>();
  const ordersBySource = new Map<string, number[]>();
  for (const [index, raw] of chapterSummaries.entries()) {
    if (!isRecord(raw)) {
      throw new CodexReviewReplayError(`Curated chapter ${index + 1} was not an object.`);
    }
    const sourceId = typeof raw.sourceId === "string" ? raw.sourceId.trim() : "";
    const chapterKey = typeof raw.chapterKey === "string" ? raw.chapterKey.trim() : "";
    const sourceOrder = Number(raw.sourceOrder);
    if (!UUID_PATTERN.test(sourceId)) {
      throw new CodexReviewReplayError(`Curated chapter ${index + 1} had no current source UUID.`);
    }
    if (!chapterKey.startsWith(`${sourceId}:`)) {
      throw new CodexReviewReplayError(
        `Curated chapter ${index + 1} did not use a source-scoped chapterKey.`,
      );
    }
    if (chapterKeys.has(chapterKey)) {
      throw new CodexReviewReplayError(`Curated chapterKey ${chapterKey} was repeated.`);
    }
    if (!Number.isInteger(sourceOrder) || sourceOrder < 0) {
      throw new CodexReviewReplayError(`Curated chapter ${chapterKey} had an invalid sourceOrder.`);
    }
    chapterKeys.add(chapterKey);
    ordersBySource.set(sourceId, [...(ordersBySource.get(sourceId) ?? []), sourceOrder]);
  }
  for (const [sourceId, orders] of ordersBySource) {
    const sorted = [...orders].sort((left, right) => left - right);
    if (sorted.some((order, index) => order !== index)) {
      throw new CodexReviewReplayError(
        `Curated chapters for source ${sourceId} did not have unique contiguous sourceOrder values.`,
      );
    }
  }
  for (const [index, raw] of chronology.entries()) {
    if (!isRecord(raw)) {
      throw new CodexReviewReplayError(`Curated chronology event ${index + 1} was not an object.`);
    }
    const keys = Array.isArray(raw.sourceChapterKeys) ? raw.sourceChapterKeys : [];
    const unknown = keys.filter(
      (key): key is string => typeof key === "string" && !chapterKeys.has(key),
    );
    if (unknown.length > 0) {
      throw new CodexReviewReplayError(
        `Curated chronology event ${index + 1} cited unknown chapter keys: ${unknown.join(", ")}.`,
      );
    }
  }
  return value as unknown as WorldFindings;
}

export async function loadCuratedWorldFindings(filePath: string): Promise<WorldFindings> {
  const raw = await readFile(path.resolve(filePath), "utf8");
  try {
    return validateCuratedWorldFindings(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof CodexReviewReplayError) throw error;
    throw new CodexReviewReplayError(
      `Could not parse curated findings JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readJsonBody(request: IncomingMessage): Promise<ReplayRequest> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    length += chunk.length;
    if (length > 10 * 1024 * 1024) {
      throw new CodexReviewReplayError("The chat request exceeded 10 MiB.", 413);
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!isRecord(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new CodexReviewReplayError("The request body was not valid JSON.");
  }
}

function jsonResponse(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

export function createCodexReviewReplayServer(curated: WorldFindings) {
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        jsonResponse(response, 200, { status: "ok", databaseAccess: false });
        return;
      }
      if (
        request.method !== "POST" ||
        !request.url?.split("?", 1)[0]?.endsWith("/chat/completions")
      ) {
        throw new CodexReviewReplayError("Route not found.", 404);
      }
      const completionResult = replayCompletionForRequest(
        curated,
        await readJsonBody(request),
      );
      jsonResponse(response, 200, completionResult);
    } catch (error) {
      const replayError = error instanceof CodexReviewReplayError
        ? error
        : new CodexReviewReplayError(
            error instanceof Error ? error.message : String(error),
            500,
          );
      jsonResponse(response, replayError.statusCode, {
        error: {
          message: replayError.message,
          type: replayError.statusCode >= 500
            ? "server_error"
            : "invalid_request_error",
          code: "storyhold_codex_review_replay",
        },
      });
    }
  });
}

export async function startCodexReviewReplay(
  curated: WorldFindings,
  port: number,
): Promise<{ server: ReturnType<typeof createCodexReviewReplayServer>; port: number }> {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new CodexReviewReplayError("Port must be an integer from 0 through 65535.");
  }
  const server = createCodexReviewReplayServer(curated);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { server, port: (server.address() as AddressInfo).port };
}

async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length !== 2) {
    throw new CodexReviewReplayError(
      "Usage: tsx codexReviewReplay.ts <curated-world-findings.json> <port>",
    );
  }
  const port = Number(args[1]);
  const curated = await loadCuratedWorldFindings(args[0]!);
  const running = await startCodexReviewReplay(curated, port);
  console.log(
    `Storyhold Codex review replay listening at http://127.0.0.1:${running.port}/v1/chat/completions`,
  );
  const close = () => running.server.close(() => process.exit(0));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

const executedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (
  process.env.NODE_ENV !== "test" &&
  executedPath &&
  import.meta.url === pathToFileURL(executedPath).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

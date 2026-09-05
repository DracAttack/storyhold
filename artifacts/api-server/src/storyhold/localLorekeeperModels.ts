import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { estimatedTokensFromCharacters } from "./canonIntakePricing";

type JsonRecord = Record<string, unknown>;

export type LorekeeperRerankReceipt = {
  status: "disabled" | "completed" | "failed";
  stage: "minilm" | "bge";
  model: string;
  candidateCount: number;
  rankedCount: number;
  elapsedMilliseconds: number;
  error?: string;
};

export type LorekeeperNliResult = {
  id: string;
  contradiction: number;
  entailment: number;
  neutral: number;
  label: "contradiction" | "entailment" | "neutral";
};

export type LorekeeperNliReceipt = {
  status: "disabled" | "completed" | "failed";
  model: string;
  pairCount: number;
  elapsedMilliseconds: number;
  error?: string;
};

const DEFAULT_MINILM_MODEL = "cross-encoder/ms-marco-MiniLM-L6-v2";
const DEFAULT_BGE_MODEL = "BAAI/bge-reranker-v2-m3";
const DEFAULT_NLI_MODEL = "cross-encoder/nli-deberta-v3-xsmall";
const DEFAULT_QWEN_MODEL = "Qwen/Qwen3.5-4B-Instruct";

function envEnabled(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLocaleLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function loopbackEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function endpointFor(kind: "minilm" | "rerank" | "nli" | "qwen"): string | null {
  const explicit = process.env[
    kind === "minilm"
      ? "STORYHOLD_LOCAL_MINILM_URL"
      : kind === "rerank"
      ? "STORYHOLD_LOCAL_RERANKER_URL"
      : kind === "nli"
      ? "STORYHOLD_LOCAL_NLI_URL"
      : "STORYHOLD_LOCAL_QWEN_URL"
  ]?.trim();
  const ner = process.env.STORYHOLD_LOCAL_NER_URL?.trim();
  let value = explicit || "";
  if (!value && ner) {
    try {
      const url = new URL(ner);
      url.pathname = kind === "minilm"
        ? "/rerank/fast"
        : kind === "rerank"
        ? "/rerank/final"
        : kind === "nli"
        ? "/nli"
        : "/qwen/audit";
      url.search = "";
      url.hash = "";
      value = url.toString();
    } catch {
      value = "";
    }
  }
  if (!value) return null;
  const allowRemote = envEnabled("STORYHOLD_LOCAL_MODELS_ALLOW_REMOTE", false);
  return allowRemote || loopbackEndpoint(value) ? value : null;
}

function stageControlEndpoint(pathname: "/stage/activate" | "/stage/release"): string | null {
  const candidate = process.env.STORYHOLD_LOCAL_GLINER2_URL?.trim() ||
    process.env.STORYHOLD_LOCAL_NER_URL?.trim() ||
    process.env.STORYHOLD_LOCAL_RERANKER_URL?.trim() || "";
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    url.pathname = pathname;
    url.search = "";
    url.hash = "";
    const allowRemote = envEnabled("STORYHOLD_LOCAL_MODELS_ALLOW_REMOTE", false);
    return allowRemote || loopbackEndpoint(url.toString()) ? url.toString() : null;
  } catch {
    return null;
  }
}

function clean(value: unknown, maximum: number): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\u0000/g, "").trim().slice(0, maximum)
    : "";
}

function rows(value: unknown, key: string): JsonRecord[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const nested = (value as JsonRecord)[key];
  return Array.isArray(nested)
    ? nested.filter(
        (item): item is JsonRecord =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

async function postJson(
  endpoint: string,
  body: unknown,
  timeoutMilliseconds: number,
  deadlineUnixMs?: number,
): Promise<JsonRecord> {
  // Node's built-in fetch closes a request that has not returned response
  // headers after roughly five minutes, even when the caller's AbortSignal is
  // longer. A full CPU BGE pass can legitimately exceed that on a large book,
  // leaving Python to finish work whose socket has already disappeared. Use a
  // plain Node request so this explicit stage timeout is the only deadline.
  const url = new URL(endpoint);
  const serialized = JSON.stringify(body);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return await new Promise<JsonRecord>((resolve, reject) => {
    let settled = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      callback();
    };
    const pending = request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "content-length": Buffer.byteLength(serialized),
      },
    }, (response) => {
      let responseText = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        if (responseText.length <= 32 * 1024 * 1024) responseText += chunk;
      });
      response.on("error", (error) => finish(() => reject(error)));
      response.on("end", () => finish(() => {
        let payload: JsonRecord = {};
        try {
          payload = responseText ? JSON.parse(responseText) as JsonRecord : {};
        } catch {
          reject(new Error("The local model returned an invalid JSON response."));
          return;
        }
        const status = response.statusCode ?? 500;
        if (status < 200 || status >= 300) {
          reject(new Error(clean(payload.error, 500) || `HTTP ${status}`));
          return;
        }
        resolve(payload);
      }));
    });
    pending.setTimeout(timeoutMilliseconds, () => {
      pending.destroy(new Error(
        `The local model did not return within ${Math.ceil(timeoutMilliseconds / 1_000)} seconds.`,
      ));
    });
    pending.on("error", (error) => finish(() => reject(error)));
    if (deadlineUnixMs !== undefined) {
      // Socket inactivity is not a whole-request deadline: queued work and a
      // slowly streaming response must also respect the interactive budget.
      deadlineTimer = setTimeout(() => pending.destroy(new Error(
        "The local model reached its gameplay validation deadline.",
      )), Math.max(1, deadlineUnixMs - Date.now()));
    }
    pending.end(serialized);
  });
}

export type LorekeeperLocalStage =
  | "gliner1"
  | "gliner2"
  | "coreference"
  | "nli"
  | "minilm"
  | "bge"
  | "qwen";

export type LorekeeperQwenReceipt = {
  text: string;
  model: string;
  device: string;
  workerPid: number | null;
  inputTokens: number;
  outputTokens: number;
  elapsedMilliseconds: number;
};

export type LorekeeperQwenClassificationReceipt = {
  decisions: Array<{ index: number; code: "c" | "x" | "u" | "r" | "m"; confidence: number }>;
  model: string;
  device: string;
  workerPid: number | null;
  inputTokens: number;
  outputTokens: number;
  elapsedMilliseconds: number;
};

export async function classifyLorekeeperQwenAudit(params: {
  prompts: Array<{ index: number; text: string }>;
  timeoutMilliseconds?: number;
}): Promise<LorekeeperQwenClassificationReceipt> {
  const auditEndpoint = endpointFor("qwen");
  const enabled = envEnabled("STORYHOLD_LOCAL_QWEN_ENABLED", Boolean(auditEndpoint));
  if (!enabled || !auditEndpoint) throw new Error("Qwen local acceleration is not configured.");
  const endpointUrl = new URL(auditEndpoint);
  endpointUrl.pathname = "/qwen/classify";
  endpointUrl.search = "";
  endpointUrl.hash = "";
  const prompts = params.prompts.slice(0, 40).flatMap((prompt) => {
    const index = Math.round(Number(prompt.index));
    const text = clean(prompt.text, 8_000);
    return Number.isInteger(index) && index >= 0 && text ? [{ index, text }] : [];
  });
  if (!prompts.length) throw new Error("Qwen local acceleration received no classification records.");
  const payload = await postJson(
    endpointUrl.toString(),
    { prompts },
    Math.max(1_000, params.timeoutMilliseconds ?? 15 * 60_000),
  );
  const allowedCodes = new Set(["c", "x", "u", "r", "m"]);
  const decisions = rows(payload, "decisions").flatMap((entry) => {
    const index = Math.round(Number(entry.index));
    const code = clean(entry.code, 1) as LorekeeperQwenClassificationReceipt["decisions"][number]["code"];
    const confidence = Math.max(0, Math.min(1, Number(entry.confidence) || 0));
    return Number.isInteger(index) && index >= 0 && allowedCodes.has(code)
      ? [{ index, code, confidence }]
      : [];
  });
  if (decisions.length !== prompts.length || new Set(decisions.map((decision) => decision.index)).size !== decisions.length) {
    throw new Error("Qwen local acceleration did not classify every supplied record exactly once.");
  }
  return {
    decisions,
    model: clean(payload.model, 240) || process.env.STORYHOLD_LOCAL_QWEN_MODEL?.trim() || DEFAULT_QWEN_MODEL,
    device: clean(payload.device, 40) || "cpu",
    workerPid: Number.isInteger(Number(payload.workerPid)) ? Number(payload.workerPid) : null,
    inputTokens: Math.max(0, Math.round(Number(payload.inputTokens) || 0)),
    outputTokens: Math.max(0, Math.round(Number(payload.outputTokens) || decisions.length)),
    elapsedMilliseconds: Math.max(0, Math.round(Number(payload.elapsedMilliseconds) || 0)),
  };
}

export async function runLorekeeperQwenAudit(params: {
  prompt: string;
  maximumOutputTokens?: number;
  seed?: number;
  timeoutMilliseconds?: number;
  responseSchema?: Record<string, unknown>;
  jsonMode?: boolean;
}): Promise<LorekeeperQwenReceipt> {
  const endpoint = endpointFor("qwen");
  const enabled = envEnabled("STORYHOLD_LOCAL_QWEN_ENABLED", Boolean(endpoint));
  if (!enabled || !endpoint) {
    throw new Error("Qwen local acceleration is not configured.");
  }
  const prompt = clean(params.prompt, 32_000);
  if (!prompt) throw new Error("Qwen local acceleration received an empty audit prompt.");
  const payload = await postJson(
    endpoint,
    {
      prompt,
      maximumOutputTokens: Math.max(32, Math.min(2_400, Math.round(params.maximumOutputTokens ?? 240))),
      seed: Math.max(0, Math.min(2_147_483_647, Math.round(params.seed ?? 101))),
      responseSchema: params.responseSchema,
      jsonMode: params.jsonMode !== false,
    },
    Math.max(1_000, params.timeoutMilliseconds ?? 15 * 60_000),
  );
  const text = clean(payload.text, 32_000);
  if (!text) throw new Error("Qwen local acceleration returned no audit text.");
  return {
    text,
    model: clean(payload.model, 240) || process.env.STORYHOLD_LOCAL_QWEN_MODEL?.trim() || DEFAULT_QWEN_MODEL,
    device: clean(payload.device, 40) || "cpu",
    workerPid: Number.isInteger(Number(payload.workerPid)) ? Number(payload.workerPid) : null,
    inputTokens: Math.max(0, Math.round(Number(payload.inputTokens) || estimatedTokensFromCharacters(prompt.length))),
    outputTokens: Math.max(0, Math.round(Number(payload.outputTokens) || estimatedTokensFromCharacters(text.length))),
    elapsedMilliseconds: Math.max(0, Math.round(Number(payload.elapsedMilliseconds) || 0)),
  };
}

export async function activateLorekeeperStage(
  stage: LorekeeperLocalStage,
  timeoutMilliseconds = 15 * 60_000,
): Promise<{ stage: LorekeeperLocalStage; model: string; device: string }> {
  const endpoint = stageControlEndpoint("/stage/activate");
  if (!endpoint) throw new Error(`The required ${stage} intake stage is not configured.`);
  const payload = await postJson(endpoint, { stage }, timeoutMilliseconds);
  if (clean(payload.stage, 40) !== stage) {
    throw new Error(`The local model worker did not activate the required ${stage} stage.`);
  }
  return {
    stage,
    model: clean(payload.model, 240),
    device: clean(payload.device, 40) || "cpu",
  };
}

export async function releaseLorekeeperStage(): Promise<void> {
  const endpoint = stageControlEndpoint("/stage/release");
  if (!endpoint) return;
  await postJson(endpoint, {}, 30_000);
}

export async function rerankLorekeeperRows<T>(params: {
  query: string;
  rows: T[];
  id: (row: T) => string;
  text: (row: T) => string;
  maximumCandidates?: number;
  maximumResults?: number;
  timeoutMilliseconds?: number;
  stage?: "minilm" | "bge";
  required?: boolean;
}): Promise<{
  rows: T[];
  scoresById: Record<string, number>;
  receipt: LorekeeperRerankReceipt;
}> {
  const startedAt = Date.now();
  const stage = params.stage ?? "bge";
  const model = stage === "minilm"
    ? process.env.STORYHOLD_LOCAL_MINILM_MODEL?.trim() || DEFAULT_MINILM_MODEL
    : process.env.STORYHOLD_LOCAL_BGE_MODEL?.trim() ||
      process.env.STORYHOLD_LOCAL_RERANKER_MODEL?.trim() || DEFAULT_BGE_MODEL;
  const endpoint = endpointFor(stage === "minilm" ? "minilm" : "rerank");
  const enabled = envEnabled(
    stage === "minilm" ? "STORYHOLD_LOCAL_MINILM_ENABLED" : "STORYHOLD_LOCAL_RERANKER_ENABLED",
    Boolean(endpoint),
  );
  const maximumCandidates = Math.max(
    8,
    Math.min(800, params.maximumCandidates ?? 280),
  );
  const maximumResults = Math.max(
    1,
    Math.min(maximumCandidates, params.maximumResults ?? 96),
  );
  const candidates = params.rows.slice(0, maximumCandidates).flatMap((row) => {
    const id = clean(params.id(row), 160);
    const text = clean(params.text(row), 2_400);
    return id && text ? [{ id, text, row }] : [];
  });
  const fallback = params.rows.slice(0, maximumResults);
  if (!enabled || !endpoint || candidates.length === 0) {
    if (params.required && candidates.length > 0) {
      throw new Error(`${stage === "minilm" ? "MiniLM" : "BGE"} is required for Canon Intake but is not available.`);
    }
    return {
      rows: fallback,
      scoresById: {},
      receipt: {
        status: "disabled",
        stage,
        model,
        candidateCount: candidates.length,
        rankedCount: fallback.length,
        elapsedMilliseconds: Date.now() - startedAt,
      },
    };
  }
  try {
    const payload = await postJson(
      endpoint,
      {
        query: clean(params.query, 4_000),
        candidates: candidates.map(({ id, text }) => ({ id, text })),
        maximum: maximumResults,
      },
      Math.max(1_000, params.timeoutMilliseconds ?? 45_000),
    );
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate.row]));
    const rankedEntries = rows(payload, "rankings").flatMap((entry): Array<{
      id: string;
      row: T;
      score: number;
    }> => {
      const id = clean(entry.id, 160);
      const row = byId.get(id);
      const score = Number(entry.score);
      return row === undefined || !Number.isFinite(score)
        ? []
        : [{ id, row, score }];
    });
    const ranked = rankedEntries.map((entry) => entry.row);
    const scoresById = Object.fromEntries(
      rankedEntries.map((entry) => [entry.id, entry.score]),
    );
    const seen = new Set(ranked.map((row) => clean(params.id(row), 160)));
    const completed = [
      ...ranked,
      ...candidates
        .filter((candidate) => !seen.has(candidate.id))
        .map((candidate) => candidate.row),
    ].slice(0, maximumResults);
    if (!ranked.length) throw new Error("The local reranker returned no rankings.");
    return {
      rows: completed,
      scoresById,
      receipt: {
        status: "completed",
        stage,
        model: clean(payload.model, 240) || model,
        candidateCount: candidates.length,
        rankedCount: completed.length,
        elapsedMilliseconds: Date.now() - startedAt,
      },
    };
  } catch (error) {
    if (params.required) throw error;
    return {
      rows: fallback,
      scoresById: {},
      receipt: {
        status: "failed",
        stage,
        model,
        candidateCount: candidates.length,
        rankedCount: fallback.length,
        elapsedMilliseconds: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function inspectLorekeeperNliPairs(params: {
  pairs: Array<{ id: string; premise: string; hypothesis: string }>;
  timeoutMilliseconds?: number;
  deadlineUnixMs?: number;
}): Promise<{ results: LorekeeperNliResult[]; receipt: LorekeeperNliReceipt }> {
  const startedAt = Date.now();
  const model = process.env.STORYHOLD_LOCAL_NLI_MODEL?.trim() || DEFAULT_NLI_MODEL;
  const endpoint = endpointFor("nli");
  const enabled = envEnabled("STORYHOLD_LOCAL_NLI_ENABLED", Boolean(endpoint));
  const pairs = params.pairs.slice(0, 160).flatMap((pair) => {
    const id = clean(pair.id, 160);
    const premise = clean(pair.premise, 1_800);
    const hypothesis = clean(pair.hypothesis, 1_800);
    return id && premise && hypothesis ? [{ id, premise, hypothesis }] : [];
  });
  if (!enabled || !endpoint || pairs.length === 0) {
    return {
      results: [],
      receipt: {
        status: "disabled",
        model,
        pairCount: pairs.length,
        elapsedMilliseconds: Date.now() - startedAt,
      },
    };
  }
  try {
    const deadlineUnixMs = Number.isFinite(params.deadlineUnixMs)
      ? Math.trunc(params.deadlineUnixMs!) : undefined;
    if (deadlineUnixMs !== undefined && Date.now() >= deadlineUnixMs) {
      throw new Error("The gameplay validation deadline expired before the NLI check could run.");
    }
    const payload = await postJson(
      endpoint,
      { pairs, ...(deadlineUnixMs === undefined ? {} : { deadlineUnixMs }) },
      Math.max(1_000, params.timeoutMilliseconds ?? 45_000),
      deadlineUnixMs,
    );
    const results = rows(payload, "results").flatMap((entry): LorekeeperNliResult[] => {
      const id = clean(entry.id, 160);
      const contradiction = Math.max(0, Math.min(1, Number(entry.contradiction) || 0));
      const entailment = Math.max(0, Math.min(1, Number(entry.entailment) || 0));
      const neutral = Math.max(0, Math.min(1, Number(entry.neutral) || 0));
      const label = [
        ["contradiction", contradiction],
        ["entailment", entailment],
        ["neutral", neutral],
      ].sort((left, right) => Number(right[1]) - Number(left[1]))[0]?.[0];
      if (!id || !["contradiction", "entailment", "neutral"].includes(String(label))) {
        return [];
      }
      return [{
        id,
        contradiction,
        entailment,
        neutral,
        label: label as LorekeeperNliResult["label"],
      }];
    });
    return {
      results,
      receipt: {
        status: "completed",
        model: clean(payload.model, 240) || model,
        pairCount: pairs.length,
        elapsedMilliseconds: Date.now() - startedAt,
      },
    };
  } catch (error) {
    return {
      results: [],
      receipt: {
        status: "failed",
        model,
        pairCount: pairs.length,
        elapsedMilliseconds: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

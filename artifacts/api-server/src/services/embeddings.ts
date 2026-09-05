// --- Embedding provider selection (Source Vault Phase 0) -----------------
// The vault needs an embeddings model to turn text chunks + queries into
// vectors for pgvector retrieval. Local MiniLM remains the free default;
// Perplexity's current embeddings API is an explicit paid option.
//
// So embeddings are pluggable behind SOURCE_VAULT_EMBED_PROVIDER:
//   - "local"      → transformers.js all-MiniLM-L6-v2, in-process, free, 384-dim
//                    (DEFAULT; dynamically imported only when selected).
//   - "perplexity" → Perplexity's OpenAI-compatible /v1/embeddings API. It is
//                    enabled only when selected and PERPLEXITY_API_KEY is set.
//
// The DB vector column is dimensionless and every chunk records its own
// provider/model/dimensions, so switching providers needs no schema change and
// retrieval only compares same-dimension vectors.

export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  dimensions: number;
  provider: string;
}

/**
 * Thrown when the selected embedding provider cannot run (e.g. provider
 * "perplexity" with no API key). Provider-agnostic on purpose — the vault no
 * longer assumes Perplexity is the embedder, so gate failures must not surface a
 * Perplexity-specific error.
 */
export class EmbeddingNotConfiguredError extends Error {
  constructor(message = "No embedding provider is configured.") {
    super(message);
    this.name = "EmbeddingNotConfiguredError";
  }
}

export type EmbeddingProvider = "local" | "perplexity";

const LOCAL_MODEL = () =>
  process.env.SOURCE_VAULT_LOCAL_EMBED_MODEL?.trim() || "Xenova/all-MiniLM-L6-v2";
const OFFLINE_MODEL = "storyhold/offline-semantic-v1";
const OFFLINE_DIMENSIONS = 384;
let resolvedLocalModel: string | null = null;
let reportedOfflineFallback = false;

export function embeddingProvider(): EmbeddingProvider {
  // Paid cloud embeddings must be an explicit choice; local MiniLM remains the
  // predictable no-credential default.
  return process.env.SOURCE_VAULT_EMBED_PROVIDER?.trim() === "perplexity" ? "perplexity" : "local";
}

export function embeddingModelName(): string {
  return embeddingProvider() === "local"
    ? resolvedLocalModel ?? LOCAL_MODEL()
    : process.env.PERPLEXITY_EMBED_MODEL?.trim() || "pplx-embed-v1-0.6b";
}

/** True when the selected embedding provider can actually run. */
export function isEmbeddingConfigured(): boolean {
  if (embeddingProvider() === "local") return true;
  return Boolean(process.env.PERPLEXITY_API_KEY?.trim());
}

/** The paid embedding providers whose spend must be gated by the budget guard. */
export function isEmbeddingPaid(): boolean {
  return embeddingProvider() === "perplexity";
}

// Lazy singleton feature-extraction pipeline (model is downloaded + cached on
// first use). Typed loosely to avoid a hard type dependency on transformers.js.
let localPipe: Promise<(texts: string[], opts: object) => Promise<{ data: Float32Array; dims: number[] }>> | null =
  null;
let localInferenceTail: Promise<void> = Promise.resolve();

function serializeLocalInference<T>(operation: () => Promise<T>): Promise<T> {
  const result = localInferenceTail.then(operation, operation);
  localInferenceTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function getLocalPipe() {
  if (!localPipe) {
    localPipe = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      return (await pipeline("feature-extraction", LOCAL_MODEL())) as unknown as (
        texts: string[],
        opts: object,
      ) => Promise<{ data: Float32Array; dims: number[] }>;
    })();
  }
  return localPipe;
}

const SEMANTIC_FAMILIES: readonly (readonly string[])[] = [
  ["person", "people", "human", "character", "individual", "someone"],
  ["place", "location", "area", "region", "site", "destination"],
  ["city", "town", "village", "settlement", "metropolis", "capital"],
  ["home", "house", "apartment", "residence", "dwelling", "quarters"],
  ["company", "corporation", "conglomerate", "business", "firm", "employer"],
  ["faction", "group", "organization", "order", "clan", "guild", "collective"],
  ["government", "state", "authority", "regime", "administration", "council"],
  ["army", "military", "soldier", "trooper", "force", "battalion"],
  ["creature", "monster", "beast", "alien", "demon", "predator"],
  ["weapon", "gun", "rifle", "pistol", "sword", "blade", "armament"],
  ["vehicle", "car", "truck", "ship", "shuttle", "aircraft", "transport"],
  ["friend", "ally", "companion", "partner", "comrade", "supporter"],
  ["enemy", "rival", "foe", "opponent", "adversary", "threat"],
  ["family", "parent", "mother", "father", "sibling", "brother", "sister", "child"],
  ["love", "romance", "affection", "desire", "attraction", "intimacy"],
  ["fear", "terror", "horror", "dread", "panic", "afraid", "scared"],
  ["anger", "rage", "fury", "wrath", "irritation", "angry"],
  ["sad", "grief", "sorrow", "mourning", "despair", "unhappy"],
  ["happy", "joy", "delight", "pleasure", "celebration", "glad"],
  ["secret", "hidden", "concealed", "unknown", "classified", "mystery"],
  ["discover", "find", "locate", "uncover", "reveal", "learn"],
  ["speak", "say", "tell", "ask", "reply", "answer", "conversation"],
  ["travel", "move", "walk", "run", "drive", "fly", "journey"],
  ["fight", "battle", "combat", "attack", "defend", "violence", "war"],
  ["death", "dead", "die", "killed", "murder", "corpse", "fatal"],
  ["past", "history", "origin", "before", "earlier", "previous"],
  ["future", "later", "eventual", "coming", "tomorrow", "destiny"],
  ["rule", "law", "custom", "policy", "requirement", "restriction"],
  ["power", "ability", "talent", "skill", "strength", "capability"],
  ["money", "credit", "wealth", "cash", "finance", "payment", "debt"],
] as const;

const semanticFamilyByToken = new Map<string, number>();
SEMANTIC_FAMILIES.forEach((family, familyIndex) => {
  family.forEach((token) => semanticFamilyByToken.set(token, familyIndex));
});

function offlineTokens(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .match(/[a-z0-9']{2,}/g) ?? [];
}

function stemToken(value: string): string {
  if (value.length > 6 && value.endsWith("ingly")) return value.slice(0, -5);
  if (value.length > 5 && value.endsWith("ing")) return value.slice(0, -3);
  if (value.length > 5 && value.endsWith("ied")) return `${value.slice(0, -3)}y`;
  if (value.length > 4 && value.endsWith("ed")) return value.slice(0, -2);
  if (value.length > 4 && value.endsWith("es")) return value.slice(0, -2);
  if (value.length > 3 && value.endsWith("s")) return value.slice(0, -1);
  return value;
}

function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function addHashedFeature(vector: number[], feature: string, weight: number) {
  for (let projection = 0; projection < 3; projection += 1) {
    const hash = hash32(`${projection}:${feature}`);
    const bucket = hash % OFFLINE_DIMENSIONS;
    vector[bucket] = (vector[bucket] ?? 0) + (hash & 0x80000000 ? -weight : weight);
  }
}

/**
 * A fully offline retrieval vector used when the optional neural model has not
 * been downloaded yet. It combines word, stem, short phrase, subword, and
 * semantic-family features. It is deliberately deterministic so vectors made
 * on a laptop remain comparable after the project moves to Replit.
 */
export function offlineSemanticVector(value: string): number[] {
  const tokens = offlineTokens(value).slice(0, 3_000);
  const counts = new Map<string, number>();
  const add = (feature: string, amount = 1) =>
    counts.set(feature, (counts.get(feature) ?? 0) + amount);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const stem = stemToken(token);
    add(`word:${token}`, 1.35);
    if (stem !== token) add(`stem:${stem}`, 1.1);
    const family = semanticFamilyByToken.get(token) ?? semanticFamilyByToken.get(stem);
    if (family !== undefined) add(`meaning:${family}`, 2.25);
    if (token.length >= 5) {
      const padded = `^${token}$`;
      for (let offset = 0; offset <= padded.length - 4; offset += 1) {
        add(`sub:${padded.slice(offset, offset + 4)}`, 0.16);
      }
    }
    const next = tokens[index + 1];
    if (next) add(`pair:${stem}_${stemToken(next)}`, 0.6);
  }
  if (counts.size === 0) add("empty", 1);
  const vector = Array<number>(OFFLINE_DIMENSIONS).fill(0);
  for (const [feature, count] of counts) {
    addHashedFeature(vector, feature, Math.log1p(count));
  }
  const magnitude = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0)) || 1;
  return vector.map((item) => item / magnitude);
}

function offlineEmbed(texts: string[]): EmbeddingResult {
  return {
    vectors: texts.map(offlineSemanticVector),
    model: OFFLINE_MODEL,
    dimensions: OFFLINE_DIMENSIONS,
    provider: "local",
  };
}

async function localEmbed(texts: string[]): Promise<EmbeddingResult> {
  if (texts.length === 0) {
    const model = resolvedLocalModel ?? LOCAL_MODEL();
    return { vectors: [], model, dimensions: OFFLINE_DIMENSIONS, provider: "local" };
  }
  if (resolvedLocalModel === OFFLINE_MODEL) return offlineEmbed(texts);
  try {
    const model = LOCAL_MODEL();
    const pipe = await getLocalPipe();
    // Transformers.js pipelines share mutable execution buffers. Source,
    // memory, and scene-summary backfills can arrive together, so serialize
    // this tiny local stage rather than allowing one inference to corrupt
    // another's tensor shape.
    const out = await serializeLocalInference(() =>
      pipe(texts, { pooling: "mean", normalize: true }),
    );
    const rows = texts.length;
    const dims = Number(out.dims.at(-1) ?? 0);
    if (dims <= 0 || out.data.length !== rows * dims) {
      throw new Error(
        `Local embedding tensor shape ${JSON.stringify(out.dims)} does not match ${rows} input rows.`,
      );
    }
    const vectors: number[][] = [];
    for (let r = 0; r < rows; r++) {
      vectors.push(Array.from(out.data.slice(r * dims, (r + 1) * dims)));
    }
    resolvedLocalModel = model;
    return { vectors, model, dimensions: dims, provider: "local" };
  } catch (error) {
    resolvedLocalModel = OFFLINE_MODEL;
    if (!reportedOfflineFallback) {
      reportedOfflineFallback = true;
      process.stderr.write(
        `Storyhold neural embedding model is unavailable; using the bundled offline semantic index: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    return offlineEmbed(texts);
  }
}

/** Embed a batch of texts with the selected provider. */
export async function embedTexts(texts: string[]): Promise<EmbeddingResult> {
  if (embeddingProvider() === "local") return localEmbed(texts);
  // Loading the inherited Perplexity service also loads BrainHook's external
  // usage ledger. Keep that entire dependency graph out of local Storyhold
  // unless Perplexity embeddings were explicitly selected.
  const { perplexityEmbed } = await import("./perplexity");
  const { vectors, model, dimensions } = await perplexityEmbed(texts);
  return { vectors, model, dimensions, provider: "perplexity" };
}

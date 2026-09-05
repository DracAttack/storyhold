/**
 * Concept Explainer & Glossary — core pipeline.
 *
 * Implements a 7-step per-term flow for every published article:
 *  1. Perplexity detects and ranks difficult terms (structured output).
 *  2. BrainHook searches the Wikipedia REST API for candidate pages.
 *  3. Perplexity ranks candidates using the article's surrounding context (structured output).
 *  4. BrainHook retrieves the selected Wikipedia page directly + enqueues it in the Vault.
 *  5. BrainHook retrieves relevant Source Vault chunks via the existing local-embedding retrieval.
 *  6. Perplexity generates hover (≤40 words) + glossary (≤80 words) definitions (structured output).
 *  7. Perplexity verifies the definitions across four quality dimensions (structured output).
 *
 * All AI calls are routed through the ConceptLlmProvider interface — swap the provider
 * without rewriting the pipeline by returning a different implementation from
 * resolveConceptLlmProvider().
 *
 * Perplexity web search is deliberately DISABLED in every structured chat call
 * (disable_search: true) because all grounding context is supplied in the prompt.
 * We never ask Perplexity to search Wikipedia — that goes through the direct
 * MediaWiki REST / Action API.
 */

import { createHash } from "node:crypto";
import { z } from "zod/v4";
import {
  db,
  conceptsTable,
  conceptAliasesTable,
  articleConceptMentionsTable,
  conceptProcessingRunsTable,
  conceptSourcesTable,
  conceptRelationshipsTable,
  articlesTable,
  sourceDocumentsTable,
  type ArticleBlock,
} from "@workspace/db";
import { and, asc, eq, ilike, inArray, isNull, ne, or, sql, desc } from "drizzle-orm";
import { logger } from "../lib/logger";
import { deletePublicObject } from "../lib/objectStorage";
import { isAiFunctionEnabled, resolveDirective } from "./aiSettings";
import { PerplexityNotConfiguredError, type JsonSchemaObject } from "./perplexity";
import {
  structuredChatWithFallback,
  isResearchCapabilityAvailable,
} from "./researchFallback";
import { semanticSearch } from "./sourceVault";
import {
  searchWikipediaCandidates,
  fetchWikipediaPage,
  resolveWikipedia,
  enqueueWikipediaInVault,
  type WikipediaCandidate,
  type WikipediaPage,
} from "./wikipedia";
import { ACRONYMS } from "@workspace/content-utils";
import { captureSingleCard } from "./glossaryCardCapture";
import { getSiteSettings } from "./siteSettings";
import {
  acquireJobLock,
  heartbeatJob,
  finishJob,
  isCancelRequested,
  requestJobCancel,
  getJobState,
  isJobRunning,
} from "./jobState";
import { BudgetGuard, BudgetExceededError } from "./aiBudget";
import { filterConflatingAliases } from "./conceptAliasAudit";
import { syncConceptToVault } from "./glossaryVaultSync";
import { buildSurfaceFormRegex } from "./conceptTagger";

// ---------------------------------------------------------------------------
// JSON schemas for Perplexity response_format (strict mode)
// ---------------------------------------------------------------------------
// Each schema is paired with a Zod validator below. The JSON Schema drives the
// model's output shape; the Zod schema enforces it server-side before any DB write.

const DETECTION_JSON_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    concepts: {
      type: "array" as const,
      items: {
        type: "object",
        properties: {
          term: { type: "string" },
          matchedText: { type: "string" },
          paragraphIndex: { type: "integer" },
          confidence: { type: "number" },
          reasoning: { type: "string" },
        },
        required: ["term", "matchedText", "paragraphIndex", "confidence", "reasoning"],
        additionalProperties: false,
      },
    },
  },
  required: ["concepts"],
  additionalProperties: false,
};

const DISAMBIGUATION_JSON_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    bestKey: { type: "string" },
    confidence: { type: "number" },
    reasoning: { type: "string" },
  },
  required: ["bestKey", "confidence", "reasoning"],
  additionalProperties: false,
};

const DEFINITION_JSON_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    hoverDefinition: { type: "string" },
    glossaryDefinition: { type: "string" },
    realLifeExample: { type: "string" },
    whatItIsnt: { type: "string" },
    commonlyMisusedOnline: { type: "string" },
    confidence: { type: "number" },
    aliases: { type: "array" as const, items: { type: "string" } },
  },
  required: ["hoverDefinition", "glossaryDefinition", "realLifeExample", "whatItIsnt", "commonlyMisusedOnline", "confidence", "aliases"],
  additionalProperties: false,
};

const CLAIM_RELEVANCE_JSON_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    results: {
      type: "array" as const,
      items: {
        type: "object",
        properties: {
          idx: { type: "integer" },
          relevant: { type: "boolean" },
        },
        required: ["idx", "relevant"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

const VERIFICATION_JSON_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    meaningCorrect: { type: "boolean" },
    factuallySupported: { type: "boolean" },
    standalone: { type: "boolean" },
    clear: { type: "boolean" },
    confidence: { type: "number" },
    notes: { type: "string" },
  },
  required: [
    "meaningCorrect",
    "factuallySupported",
    "standalone",
    "clear",
    "confidence",
    "notes",
  ],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Zod validation schemas (server-side guard against bad model output)
// ---------------------------------------------------------------------------

const DetectedConceptItemSchema = z.object({
  term: z.string().min(1),
  matchedText: z.string().min(1),
  paragraphIndex: z.number().int().min(0),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

const DetectionOutputSchema = z.object({
  concepts: z.array(DetectedConceptItemSchema),
});
type DetectionOutput = z.infer<typeof DetectionOutputSchema>;

const DisambiguationOutputSchema = z.object({
  bestKey: z.string(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});
type DisambiguationOutput = z.infer<typeof DisambiguationOutputSchema>;

const DefinitionOutputSchema = z.object({
  hoverDefinition: z.string().min(1),
  glossaryDefinition: z.string().min(1),
  realLifeExample: z.string().min(1),
  whatItIsnt: z.string().min(1),
  commonlyMisusedOnline: z.string().min(1),
  confidence: z.number().min(0).max(1),
  aliases: z.array(z.string()),
});
type DefinitionOutput = z.infer<typeof DefinitionOutputSchema>;

const VerificationOutputSchema = z.object({
  meaningCorrect: z.boolean(),
  factuallySupported: z.boolean(),
  standalone: z.boolean(),
  clear: z.boolean(),
  confidence: z.number().min(0).max(1),
  notes: z.string(),
});
type VerificationOutput = z.infer<typeof VerificationOutputSchema>;

// ---------------------------------------------------------------------------
// ConceptLlmProvider — thin abstraction for future provider swaps
// ---------------------------------------------------------------------------
// All AI calls in the pipeline go through this interface. The concrete
// PerplexityConceptProvider below is the only current implementation; to add
// another provider return a different class from resolveConceptLlmProvider().

interface ConceptLlmProvider {
  /** Step 1 — detect difficult terms in article paragraphs. */
  detectConcepts(
    paragraphsText: string,
    directive: string,
  ): Promise<DetectionOutput>;

  /** Step 3 — rank Wikipedia candidates using the article context. */
  disambiguateWikiCandidates(
    term: string,
    articleContext: string,
    candidates: WikipediaCandidate[],
  ): Promise<DisambiguationOutput>;

  /** Step 6 — generate hover + glossary definitions. */
  generateDefinitions(
    term: string,
    articleContext: string,
    wikiExtract: string,
    vaultContext: string,
    directive: string,
  ): Promise<DefinitionOutput>;

  /** Step 7 — verify definition quality across four dimensions.
   *  NOTE: articleContext is intentionally excluded — the verifier must judge
   *  the glossary definition purely on its standalone merits. */
  verifyDefinition(
    term: string,
    wikiExtract: string,
    hoverDefinition: string,
    glossaryDefinition: string,
    directive: string,
  ): Promise<VerificationOutput>;
}

/** Perplexity implementation of the concept LLM provider. */
class PerplexityConceptProvider implements ConceptLlmProvider {
  async detectConcepts(paragraphsText: string, directive: string): Promise<DetectionOutput> {
    const raw = await structuredChatWithFallback<unknown>(
      directive,
      paragraphsText,
      DETECTION_JSON_SCHEMA,
      { schemaName: "concept_detection", operation: "concept_detection", maxTokens: 1024 },
    );
    const parsed = DetectionOutputSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues }, "concept: detection schema validation failed");
      return { concepts: [] };
    }
    return parsed.data;
  }

  async disambiguateWikiCandidates(
    term: string,
    articleContext: string,
    candidates: WikipediaCandidate[],
  ): Promise<DisambiguationOutput> {
    const system =
      "You are a disambiguation editor. Given a concept term, an article excerpt, and a list of " +
      "Wikipedia page candidates, choose the Wikipedia page that best represents the term AS USED " +
      "IN THIS ARTICLE. Consider context carefully — the same word can mean different things in " +
      "different fields. If none of the candidates are a good match, return an empty string for bestKey.";

    const candidateList = candidates
      .map(
        (c, i) =>
          `${i + 1}. key="${c.key}" title="${c.title}" description="${c.description}" excerpt="${c.excerpt}"`,
      )
      .join("\n");

    const user = [
      `Term: "${term}"`,
      "",
      "Article context:",
      articleContext.slice(0, 800),
      "",
      "Wikipedia candidates:",
      candidateList,
    ].join("\n");

    const raw = await structuredChatWithFallback<unknown>(
      system,
      user,
      DISAMBIGUATION_JSON_SCHEMA,
      { schemaName: "wiki_disambiguation", operation: "concept_detection", maxTokens: 256 },
    );
    const parsed = DisambiguationOutputSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues }, "concept: disambiguation schema validation failed");
      return { bestKey: candidates[0]?.key ?? "", confidence: 0.5, reasoning: "validation failed, using top result" };
    }
    return parsed.data;
  }

  async generateDefinitions(
    term: string,
    articleContext: string,
    wikiExtract: string,
    vaultContext: string,
    directive: string,
  ): Promise<DefinitionOutput> {
    const contextSections: string[] = [];
    if (wikiExtract) {
      contextSections.push(`Wikipedia extract:\n"${wikiExtract.slice(0, 700)}"`);
    }
    if (vaultContext) {
      contextSections.push(`Source Vault context:\n"${vaultContext.slice(0, 500)}"`);
    }
    if (articleContext) {
      contextSections.push(`Article context:\n"${articleContext.slice(0, 500)}"`);
    }

    const user = [
      `Term: "${term}"`,
      "",
      ...contextSections,
    ].join("\n\n");

    const raw = await structuredChatWithFallback<unknown>(
      directive,
      user,
      DEFINITION_JSON_SCHEMA,
      { schemaName: "concept_definition", operation: "concept_definition", maxTokens: 512 },
    );
    const parsed = DefinitionOutputSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn(
        { term, issues: parsed.error.issues },
        "concept: definition schema validation failed",
      );
      return null as unknown as DefinitionOutput;
    }
    return parsed.data;
  }

  async verifyDefinition(
    term: string,
    wikiExtract: string,
    hoverDefinition: string,
    glossaryDefinition: string,
    directive: string,
  ): Promise<VerificationOutput> {
    const user = [
      `Term: "${term}"`,
      "",
      `Hover definition: "${hoverDefinition}"`,
      `Glossary definition: "${glossaryDefinition}"`,
      "",
      wikiExtract ? `Wikipedia extract:\n"${wikiExtract.slice(0, 600)}"` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const raw = await structuredChatWithFallback<unknown>(
      directive,
      user,
      VERIFICATION_JSON_SCHEMA,
      { schemaName: "concept_verification", operation: "concept_verification", maxTokens: 256 },
    );
    const parsed = VerificationOutputSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn(
        { term, issues: parsed.error.issues },
        "concept: verification schema validation failed",
      );
      // Fail-open: treat as not-verified so concept stays draft
      return {
        meaningCorrect: false,
        factuallySupported: false,
        standalone: false,
        clear: false,
        confidence: 0,
        notes: "validation failed",
      };
    }
    return parsed.data;
  }
}

export function resolveConceptLlmProvider(): ConceptLlmProvider {
  // Future: inspect an env var or site setting to choose a different provider.
  return new PerplexityConceptProvider();
}

// ---------------------------------------------------------------------------
// External reference validation
// ---------------------------------------------------------------------------

/**
 * Validate a dictionary.com URL by following redirects and checking whether
 * the response is actually for the requested term. Dictionary.com redirects
 * unknown terms to phonetically similar entries and appends
 * `?mismatchType=misspelling` to the URL — that query param is the reliable
 * signal that they don't have this term.
 *
 * Returns `{ url, title }` if dictionary.com has the term, `null` otherwise.
 */
async function validateDictionaryComUrl(
  term: string,
  slug: string,
): Promise<{ url: string; title: string } | null> {
  const url = `https://www.dictionary.com/browse/${encodeURIComponent(slug)}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BrainHookBot/1.0)" },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    // Dictionary.com injects `mismatchType=misspelling` when it redirects to a
    // different term — presence of this param means they don't have ours.
    const finalUrl = new URL(res.url);
    if (finalUrl.searchParams.get("mismatchType")) return null;
    return { url, title: term };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Term formatting
// ---------------------------------------------------------------------------

// Acronym map imported from @workspace/content-utils — the single source of
// truth shared with the site's headline title-caser.  Add new entries there.

/**
 * Converts a concept term to Title Case.
 *
 * Rules applied in order (mirrors toArticleTitleCase in site/src/lib/utils.ts):
 * 1. The first word is always capitalised.
 * 2. Apostrophe normalisation: `\'` and `''` are collapsed to a plain apostrophe
 *    before any other processing.
 * 3. Tokens whose non-first characters already contain an uppercase letter are
 *    left completely unchanged — preserves acronyms (ADHD, DSM-5), proper brands,
 *    and intentional casing already supplied by the model.
 * 4. Leading non-letter characters are peeled off and reattached so the
 *    alphabetic word inside is cased correctly.  If the prefix contains a digit
 *    (e.g. "19th", "3D") the whole token is returned verbatim.
 * 5. Tokens whose lowercase pure form match the shared ACRONYMS map are replaced
 *    with their canonical form (e.g. "covid" → "COVID", "ai" → "AI").
 * 6. Small English function words are lowercased except at the very start.
 * 7. All other words have their first character capitalised.
 */
export function toConceptTitleCase(term: string): string {
  if (!term) return term;

  // Normalise stray escape sequences that can leak through JSON processing:
  //   \' → '   (backslash-apostrophe collapsed to plain apostrophe)
  //   '' → '   (double-apostrophe collapsed to single)
  const normalised = term.replace(/\\'/g, "'").replace(/''/g, "'");

  const STOP = new Set([
    "a", "an", "the", "and", "but", "or", "for", "nor",
    "on", "at", "to", "by", "in", "of", "up", "as",
  ]);

  let wordIndex = 0;
  return normalised.replace(/\S+/g, (token) => {
    const isFirst = wordIndex === 0;
    wordIndex++;

    // Peel off any leading non-letter characters (opening quotes, parentheses)
    // so we can examine and transform only the letter portion.
    const m = token.match(/^([^a-zA-Z]*)([a-zA-Z][\s\S]*)$/);
    if (!m) return token; // pure punctuation / numbers — leave untouched

    const [, lead, word] = m;

    // Numeric-hybrid guard: if the non-letter prefix contains a digit the
    // token is an alphanumeric hybrid (e.g. "19th", "3D") and we cannot
    // reliably case the letter suffix — return the whole token verbatim.
    if (/\d/.test(lead)) return token;

    // Preserve existing mixed casing entirely (covers "ADHD", "DSM-5",
    // "U.S.", mixed-case brands, etc.)
    if (/[A-Z]/.test(word.slice(1))) return token;

    const lower = word.toLowerCase();

    // Strip trailing closing punctuation (parens, quotes, commas, …) from the
    // lowercase form before stop-word / acronym lookup so that tokens like
    // "ai)" or "covid," match their allowlist keys.  The tail is reattached
    // verbatim.  We use the Unicode \p{L} / \p{N} property classes so that
    // non-ASCII letters in acronym suffixes (e.g. "α" in "tnf-α") are kept.
    const wordPure = lower.replace(/[^\p{L}\p{N}'-]+$/u, "");
    const wordTail = lower.slice(wordPure.length);

    // Acronym allowlist — canonical form takes precedence over stop-word
    // lowercasing and normal capitalisation.
    if (Object.prototype.hasOwnProperty.call(ACRONYMS, wordPure)) {
      return lead + ACRONYMS[wordPure]! + wordTail;
    }

    // Stop word mid-term: lowercase unless it is the first word.
    if (!isFirst && STOP.has(wordPure)) {
      return lead + lower;
    }

    return lead + lower.charAt(0).toUpperCase() + lower.slice(1);
  });
}

// ---------------------------------------------------------------------------
// Article text helpers
// ---------------------------------------------------------------------------

function buildParagraphList(blocks: ArticleBlock[]): Array<{ index: number; text: string }> {
  const paras: Array<{ index: number; text: string }> = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b && b.type === "paragraph" && b.content.trim().length > 0) {
      paras.push({ index: i, text: b.content });
    }
  }
  return paras;
}

function wordCount(blocks: ArticleBlock[]): number {
  return blocks
    .filter((b) => b.type === "paragraph")
    .reduce((n, b) => n + b.content.split(/\s+/).filter(Boolean).length, 0);
}

function maxConceptsForArticle(
  blocks: ArticleBlock[],
  caps: { maxDefault: number; maxLong: number },
): number {
  return wordCount(blocks) > 2500 ? caps.maxLong : caps.maxDefault;
}

function paragraphContextForTerm(
  paras: Array<{ index: number; text: string }>,
  paragraphIndex: number,
): string {
  // Grab the matched paragraph plus its immediate neighbours for context.
  const window = paras.filter(
    (p) => Math.abs(p.index - paragraphIndex) <= 1,
  );
  return window.map((p) => p.text).join("\n\n");
}

// ---------------------------------------------------------------------------
// Slug helpers
// ---------------------------------------------------------------------------

function termToSlug(term: string): string {
  return term
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Keyword-based heuristic to pick the "real life example" module context.
// Purely deterministic — no AI call. Falls back to "general" for everything else.
const MODULE_KEYWORDS: Record<string, string[]> = {
  behavioral: [
    "attachment", "trauma", "anxiety", "depression", "disorder", "syndrome",
    "personality", "behavior", "cognitive", "psychology", "therapy", "emotional",
    "stress", "phobia", "addiction", "habit", "learning", "social", "parenting",
    "relationship", "communication", "bias", "motivation", "empathy", "narcissism",
    "gaslighting", "boundaries", "mindset", "resilience",
  ],
  medical: [
    "neuro", "brain", "neuron", "synapse", "cortex", "hippocampus", "amygdala",
    "dopamine", "serotonin", "cortisol", "hormone", "inflammation", "immune",
    "gene", "genetic", "mutation", "cell", "tissue", "organ", "blood", "heart",
    "lung", "liver", "kidney", "cancer", "tumor", "disease", "infection", "virus",
    "bacteria", "medication", "drug", "surgery", "diagnosis", "symptom", "treatment",
    "clinical", "patient", "dosage", "side effect", "vaccine", "epidemic", "pandemic",
    "stroke", "seizure", "dementia", "parkinson", "alzheimer", "autism", "adhd",
  ],
  technical: [
    "algorithm", "api", "blockchain", "cloud", "compression", "cryptography",
    "database", "encryption", "framework", "gpu", "hardware", "internet", "ip",
    "machine learning", "neural network", "protocol", "router", "server", "software",
    "ssl", "tls", "virtual", "wifi", "ai", "artificial intelligence", "chip",
    "processor", "semiconductor", "transistor", "circuit", "network", "bandwidth",
    "latency", "throughput", "packet", "firewall", "proxy", "cdn", "dns",
    "programming", "code", "compiler", "runtime", "docker", "kubernetes",
    "container", "microservice", "architecture", "scaling", "load balancing",
    "data center", "storage", "ssd", "hdd", "memory", "ram", "cache", "index",
    "query", "schema", "table", "transaction", "replication", "sharding",
  ],
};

function resolveModuleType(term: string, extract: string): "behavioral" | "medical" | "technical" | "general" {
  const text = (term + " " + extract).toLowerCase();
  for (const [type, words] of Object.entries(MODULE_KEYWORDS)) {
    if (words.some((w) => text.includes(w))) {
      return type as "behavioral" | "medical" | "technical";
    }
  }
  return "general";
}

async function ensureUniqueSlug(base: string): Promise<string> {
  const existing = await db
    .select({ slug: conceptsTable.slug })
    .from(conceptsTable)
    .where(eq(conceptsTable.slug, base));
  if (existing.length === 0) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    const dup = await db
      .select({ slug: conceptsTable.slug })
      .from(conceptsTable)
      .where(eq(conceptsTable.slug, candidate));
    if (dup.length === 0) return candidate;
  }
  return `${base}-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mention anchoring (spec step 1): paragraph/sentence hashes + context snippet
// so a mention can be located (and detected as stale) after body edits reflow
// paragraph indexes or rewrite text.
// ---------------------------------------------------------------------------

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Split paragraph text into rough sentences (period/question/exclamation). */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface MentionAnchor {
  paragraphHash: string;
  sentenceHash: string;
  contextSnippet: string;
}

/**
 * Compute the anchoring metadata for a detected mention: hash of the containing
 * paragraph, hash of the sentence holding the first occurrence of the matched
 * term, and a ~240-char snippet centred on the match.
 */
function buildMentionAnchor(paragraphText: string, matchedTerm: string): MentionAnchor {
  const paragraphHash = shortHash(paragraphText);
  const lowerPara = paragraphText.toLowerCase();
  const lowerTerm = matchedTerm.toLowerCase();
  const matchIdx = lowerTerm ? lowerPara.indexOf(lowerTerm) : -1;

  // Sentence containing the first occurrence (fallback: whole paragraph).
  let sentence = paragraphText;
  if (matchIdx >= 0) {
    let offset = 0;
    for (const s of splitSentences(paragraphText)) {
      const start = paragraphText.indexOf(s, offset);
      if (start >= 0 && matchIdx >= start && matchIdx < start + s.length) {
        sentence = s;
        break;
      }
      if (start >= 0) offset = start + s.length;
    }
  }
  const sentenceHash = shortHash(sentence);

  // ~240-char window centred on the match (fallback: paragraph head).
  const WINDOW = 240;
  let contextSnippet: string;
  if (matchIdx >= 0) {
    const start = Math.max(0, matchIdx - Math.floor((WINDOW - matchedTerm.length) / 2));
    contextSnippet = paragraphText.slice(start, start + WINDOW).trim();
  } else {
    contextSnippet = paragraphText.slice(0, WINDOW).trim();
  }
  return { paragraphHash, sentenceHash, contextSnippet };
}

export async function findExistingConcept(term: string) {
  const lower = term.toLowerCase();
  const byTerm = await db
    .select()
    .from(conceptsTable)
    .where(ilike(conceptsTable.term, lower))
    .limit(1);
  if (byTerm.length > 0) return byTerm[0]!;

  const byAlias = await db
    .select({ concept: conceptsTable })
    .from(conceptAliasesTable)
    .innerJoin(conceptsTable, eq(conceptAliasesTable.conceptId, conceptsTable.id))
    .where(ilike(conceptAliasesTable.alias, lower))
    .limit(1);
  return byAlias[0]?.concept ?? null;
}

/**
 * Normalize a term for fuzzy matching:
 * - lowercased
 * - diacritics stripped (NFD + remove combining marks)
 * - hyphens / en-dashes / underscores → space
 * - non-alphanumeric (except spaces) stripped
 * - whitespace collapsed
 *
 * Catches "post-traumatic stress disorder" ↔ "Post Traumatic Stress Disorder".
 */
function normalizeTermForMatching(term: string): string {
  return term
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[-–—_]/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Step 4d — Canonical duplicate detection (Dice coefficient, canonical DB only)
// ---------------------------------------------------------------------------
//
// Compares the detected term against existing concepts in the canonical DB using
// Sørensen–Dice token-overlap similarity. NEVER reads vault chunks — the only
// inputs are `conceptsTable.term` and `conceptsTable.hoverDefinition`.
//
// >= CANONICAL_REUSE_THRESHOLD  → reuse existing concept (confident match)
// >= CANONICAL_MERGE_THRESHOLD  → create as draft, flag for merge-review
// <  CANONICAL_MERGE_THRESHOLD  → treat as a genuinely new concept

const CANONICAL_REUSE_THRESHOLD = 0.82;
const CANONICAL_MERGE_THRESHOLD = 0.60;

const DEDUP_STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "at", "to", "for", "and", "or", "but",
  "is", "are", "was", "were", "be", "been", "being", "it", "its", "this", "that",
  "from", "with", "by", "as", "into", "about", "not", "what", "how", "when",
  "who", "which", "can", "do", "does", "did", "will", "would", "may", "might",
  "should", "could", "have", "has", "had", "very", "also", "more",
]);

/**
 * Extract significant tokens from a term string for Dice coefficient comparison:
 * lowercased, punctuation-stripped, stopwords and short tokens removed.
 */
function extractSignificantTokens(text: string): Set<string> {
  return new Set(
    normalizeTermForMatching(text)
      .split(/\s+/)
      .filter((t) => t.length > 2 && !DEDUP_STOPWORDS.has(t)),
  );
}

/** Sørensen–Dice coefficient over two token sets. Returns 0–1. */
function diceCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  return (2 * intersection) / (a.size + b.size);
}

interface CanonicalDuplicateMatch {
  id: string;
  slug: string;
  similarity: number;
  action: "reuse" | "queue_merge";
}

/**
 * Query the canonical concepts registry for a near-duplicate of the detected term.
 * Uses Dice coefficient over canonical term + hover definition tokens.
 * Inputs are conceptsTable rows only — no vault chunk retrieval of any kind.
 * Returns null when embeddings/APIs are not needed or no match exceeds the threshold.
 */
export async function findCanonicalDuplicate(
  detectedTerm: string,
  paragraphContext: string,
): Promise<CanonicalDuplicateMatch | null> {
  try {
    const detectedTokens = extractSignificantTokens(detectedTerm);
    if (detectedTokens.size === 0) return null;

    // Context tokens augment the definition-blend step so that two different
    // terms appearing in the same type of article can be kept distinct by
    // their hover definitions diverging from the context words.
    const contextTokens = extractSignificantTokens(paragraphContext.slice(0, 300));
    const searchTokens = new Set<string>([...detectedTokens, ...contextTokens].slice(0, 15));

    // SQL-level pre-filter: find concepts whose term or hover definition
    // contains at least one significant token from the detected term.
    // This covers the full canonical registry without loading every row —
    // the ILIKE conditions narrow the candidates in the DB, and Dice over
    // term tokens guarantees recall for any token-overlapping near-duplicate.
    // (Abbreviation-vs-full-form pairs, e.g. PTSD ↔ Post-Traumatic Stress
    // Disorder, are already caught by alias match in Step 4a.)
    const tokenList = [...detectedTokens].slice(0, 6); // up to 6 OR branches
    const tokenConditions = tokenList.map((t) =>
      or(
        ilike(conceptsTable.term, `%${t}%`),
        ilike(conceptsTable.hoverDefinition, `%${t}%`),
      )!,
    );
    const candidates = await db
      .select({
        id: conceptsTable.id,
        slug: conceptsTable.slug,
        term: conceptsTable.term,
        hoverDefinition: conceptsTable.hoverDefinition,
      })
      .from(conceptsTable)
      .where(and(ne(conceptsTable.status, "hidden"), or(...tokenConditions)))
      .orderBy(asc(conceptsTable.id)); // deterministic, no artificial cap

    let bestMatch: CanonicalDuplicateMatch | null = null;

    for (const candidate of candidates) {
      const candidateTermTokens = extractSignificantTokens(candidate.term);
      const termSim = diceCoefficient(detectedTokens, candidateTermTokens);
      if (termSim < 0.40) continue; // fast-reject clearly unrelated terms

      // Blend term similarity with hover-definition/context overlap to
      // distinguish "depression" from "postpartum depression" etc.
      let similarity = termSim;
      if (candidate.hoverDefinition) {
        const defTokens = extractSignificantTokens(candidate.hoverDefinition);
        const contextSim = diceCoefficient(searchTokens, defTokens);
        // 70% term-level + 30% context/definition blend
        similarity = 0.7 * termSim + 0.3 * contextSim;
      }

      if (similarity >= CANONICAL_MERGE_THRESHOLD) {
        if (!bestMatch || similarity > bestMatch.similarity) {
          bestMatch = {
            id: candidate.id,
            slug: candidate.slug,
            similarity,
            action: similarity >= CANONICAL_REUSE_THRESHOLD ? "reuse" : "queue_merge",
          };
        }
      }
    }

    return bestMatch;
  } catch (err) {
    // Canonical dedup is best-effort — never block concept creation.
    logger.debug({ err, term: detectedTerm }, "concept: canonical dedup check skipped");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step 5 — Source Vault semantic retrieval
// ---------------------------------------------------------------------------

interface VaultRetrievalResult {
  context: string;
  sources: Array<{ url: string; relevanceScore: number; snippet: string }>;
}

// A candidate source for the claim-relevance filter. Carries a short snippet
// so the LLM can judge whether the source text actually supports a claim in
// the generated definition — not just the general topic area.
interface SourceCandidate {
  url: string;
  sourceType: "wikipedia" | "vault";
  snippet: string;
}

async function retrieveVaultContext(term: string, articleContext: string): Promise<VaultRetrievalResult> {
  try {
    const query = `${term} ${articleContext.slice(0, 200)}`.trim();
    const hits = await semanticSearch(query, { limit: 4 });
    if (hits.length === 0) return { context: "", sources: [] };
    const context = hits
      .map((h) => h.content.trim())
      .filter((c) => c.length > 0)
      .join("\n\n---\n\n")
      .slice(0, 1_200);
    // Collect unique source URLs with their best (highest) similarity score AND
    // the chunk content so the claim-relevance filter has text to evaluate.
    const urlMap = new Map<string, { score: number; snippet: string }>();
    for (const h of hits) {
      const existing = urlMap.get(h.document.url);
      if (!existing || h.similarity > existing.score) {
        urlMap.set(h.document.url, { score: h.similarity, snippet: h.content.slice(0, 500) });
      }
    }
    const sources = Array.from(urlMap.entries()).map(([url, { score, snippet }]) => ({
      url,
      relevanceScore: Math.round(score * 1000) / 1000,
      snippet,
    }));
    return { context, sources };
  } catch (err) {
    // Vault retrieval is best-effort — if embeddings aren't configured or the
    // vault is empty we simply proceed without it.
    logger.debug({ err, term }, "concept: vault retrieval skipped");
    return { context: "", sources: [] };
  }
}

// ---------------------------------------------------------------------------
// Claim-relevance filter (Step 6.5)
// ---------------------------------------------------------------------------
// After the definition is generated, each candidate source is tested: does it
// contain information that directly supports at least one stated claim in the
// definition — not just the general topic? Only claim-relevant sources are
// written to concept_sources (new pipeline) or kept in the trail (recheck).
//
// Uses a single batched LLM call per concept to minimize round trips.
// Fail-open: on any error, every candidate defaults to relevant=true so
// sources are never silently dropped due to infrastructure issues.

export async function filterClaimRelevantSources(
  definitionText: string,
  candidates: SourceCandidate[],
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (candidates.length === 0) return result;

  const snippetList = candidates
    .map((c, i) => `[${i}] ${c.snippet.slice(0, 400).trim() || "(no text available)"}`)
    .join("\n\n");

  const system =
    "You are a fact-checking assistant. Given a concept definition and numbered source snippets, " +
    "determine whether each source directly supports at least one specific factual claim stated " +
    "in the definition — not just the general topic area. Return structured JSON only.";

  const user = [
    `Definition: "${definitionText.slice(0, 300)}"`,
    "",
    "Source snippets:",
    snippetList,
    "",
    `For each of the ${candidates.length} source(s) (index 0 to ${candidates.length - 1}), ` +
    "output { idx: N, relevant: true|false }. " +
    "Mark relevant=true only if the snippet contains a specific fact, figure, or mechanism " +
    "that directly supports a claim in the definition — topical adjacency alone is not enough.",
  ].join("\n");

  try {
    const raw = await structuredChatWithFallback<unknown>(
      system,
      user,
      CLAIM_RELEVANCE_JSON_SCHEMA,
      { schemaName: "claim_relevance", operation: "concept_definition", maxTokens: 256 },
    );
    const parsed = z
      .object({ results: z.array(z.object({ idx: z.number().int(), relevant: z.boolean() })) })
      .safeParse(raw);
    if (parsed.success) {
      for (const r of parsed.data.results) {
        const candidate = candidates[r.idx];
        if (candidate) result.set(candidate.url, r.relevant);
      }
    } else {
      logger.warn({ issues: parsed.error.issues }, "concept: claim relevance response invalid, all sources pass");
    }
  } catch (err) {
    logger.debug({ err }, "concept: claim relevance filter error, all sources default to pass");
  }

  // Fail-open: any candidate not assessed by the model defaults to relevant=true.
  for (const c of candidates) {
    if (!result.has(c.url)) result.set(c.url, true);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Admin recheck — re-run claim-relevance filter on stored concept_sources rows
// ---------------------------------------------------------------------------

/**
 * Load a concept's stored definition + all its concept_sources rows, re-run
 * the claim-relevance filter, and update the claim_relevant column on each row.
 * Returns { checked, removed } where removed = sources flipped to false.
 *
 * Designed to be called per-concept (from the admin per-concept button) or
 * iterated in the bulk backfill route with a delay between concepts to avoid
 * LLM rate limits.
 */
export async function recheckConceptSources(conceptId: string): Promise<{ checked: number; removed: number }> {
  const [concept] = await db
    .select({
      id: conceptsTable.id,
      definition: conceptsTable.definition,
      wikiExtract: conceptsTable.wikiExtract,
    })
    .from(conceptsTable)
    .where(eq(conceptsTable.id, conceptId))
    .limit(1);
  if (!concept) return { checked: 0, removed: 0 };

  const sources = await db
    .select()
    .from(conceptSourcesTable)
    .where(eq(conceptSourcesTable.conceptId, conceptId));
  if (sources.length === 0) return { checked: 0, removed: 0 };

  // For vault sources, look up stored text in source_documents:
  // leadSnippet (search discovery snippet) → title fallback.
  const vaultUrls = sources.filter((s) => s.sourceType === "vault").map((s) => s.sourceUrl);
  const snippetByUrl = new Map<string, string>();
  if (vaultUrls.length > 0) {
    const docs = await db
      .select({
        url: sourceDocumentsTable.url,
        title: sourceDocumentsTable.title,
        leadSnippet: sourceDocumentsTable.leadSnippet,
      })
      .from(sourceDocumentsTable)
      .where(inArray(sourceDocumentsTable.url, vaultUrls));
    for (const d of docs) {
      snippetByUrl.set(d.url, d.leadSnippet ?? d.title ?? "");
    }
  }

  const candidates: SourceCandidate[] = sources.map((s) => ({
    url: s.sourceUrl,
    sourceType: s.sourceType,
    snippet:
      s.sourceType === "wikipedia"
        ? (concept.wikiExtract?.slice(0, 400) ?? "")
        : (snippetByUrl.get(s.sourceUrl) ?? ""),
  }));

  const relevanceMap = await filterClaimRelevantSources(concept.definition, candidates);

  let removed = 0;
  for (const [url, relevant] of relevanceMap) {
    await db
      .update(conceptSourcesTable)
      .set({ claimRelevant: relevant })
      .where(
        and(
          eq(conceptSourcesTable.conceptId, conceptId),
          eq(conceptSourcesTable.sourceUrl, url),
        ),
      );
    if (!relevant) removed++;
  }

  return { checked: sources.length, removed };
}

// ---------------------------------------------------------------------------
// Per-concept resolution pipeline (steps 2–7)
// ---------------------------------------------------------------------------

interface ResolvedConcept {
  id: string;
  slug: string;
}

export async function resolveOrCreateConcept(
  detectedTerm: string,
  paragraphContext: string,
  detectionConfidence: number,
  definitionThreshold: number,
  provider: ConceptLlmProvider,
): Promise<ResolvedConcept | null> {
  try {
    // Reuse existing concept if we already have one for this term/alias.
    const existing = await findExistingConcept(detectedTerm);
    if (existing) return { id: existing.id, slug: existing.slug };

    // ── Step 2: Wikipedia candidate search ────────────────────────────────
    const candidates = await searchWikipediaCandidates(detectedTerm, 5);

    // ── Step 3: Perplexity candidate disambiguation ────────────────────────
    let selectedKey: string | null = null;
    if (candidates.length > 0) {
      const disambiguation = await provider.disambiguateWikiCandidates(
        detectedTerm,
        paragraphContext,
        candidates,
      );
      // Treat low confidence or empty key as "no match found"
      if (disambiguation.bestKey.trim() && disambiguation.confidence >= 0.55) {
        selectedKey = disambiguation.bestKey.trim();
      }
    }

    // ── Step 4: Wikipedia page retrieval + vault enqueue ───────────────────
    let wikiPage: WikipediaPage | null = null;
    if (selectedKey) {
      wikiPage = await fetchWikipediaPage(selectedKey);
      if (wikiPage) {
        void enqueueWikipediaInVault(wikiPage, detectedTerm);
      }
    }

    // ── Step 4b: Dedupe by Wikipedia page ID ───────────────────────────────
    // A detected term variant (plural, alternate casing, abbreviated form) may
    // map to the same Wikipedia article as an already-stored concept. Reuse the
    // existing concept rather than creating a near-duplicate.
    if (wikiPage?.pageId) {
      const byPageId = await db
        .select({ id: conceptsTable.id, slug: conceptsTable.slug })
        .from(conceptsTable)
        .where(eq(conceptsTable.wikiPageId, wikiPage.pageId))
        .limit(1);
      if (byPageId.length > 0) {
        logger.info(
          { term: detectedTerm, wikiPageId: wikiPage.pageId, existingId: byPageId[0]!.id },
          "concept: reusing existing concept matched by Wikipedia page ID",
        );
        return { id: byPageId[0]!.id, slug: byPageId[0]!.slug };
      }
    }

    // ── Step 4c: Normalized variant match ─────────────────────────────────
    // Catches hyphen/space/punctuation variants that the exact ilike match
    // misses: "post-traumatic stress disorder" ↔ "Post Traumatic Stress Disorder".
    const normalizedDetected = normalizeTermForMatching(detectedTerm);
    const normalizedDetectedWithDash = detectedTerm.replace(/\s+/g, "-").toLowerCase();
    if (
      normalizedDetected !== detectedTerm.toLowerCase() ||
      normalizedDetectedWithDash !== detectedTerm.toLowerCase()
    ) {
      const byNormalized =
        (await findExistingConcept(normalizedDetected)) ??
        (await findExistingConcept(normalizedDetectedWithDash));
      if (byNormalized) {
        logger.info(
          { term: detectedTerm, normalized: normalizedDetected, existingId: byNormalized.id },
          "concept: reusing existing concept matched by normalized variant",
        );
        return { id: byNormalized.id, slug: byNormalized.slug };
      }
    }

    // ── Step 4d: Canonical duplicate detection ─────────────────────────────
    // Dice-coefficient comparison over the canonical concepts DB (term + hover
    // definition tokens). NEVER reads vault chunks — canonical DB only.
    const canonicalMatch = await findCanonicalDuplicate(detectedTerm, paragraphContext);
    if (canonicalMatch?.action === "reuse") {
      logger.info(
        { term: detectedTerm, matchedId: canonicalMatch.id, similarity: canonicalMatch.similarity },
        "concept: reusing existing concept matched by canonical token similarity",
      );
      return { id: canonicalMatch.id, slug: canonicalMatch.slug };
    }
    // canonicalMatch?.action === "queue_merge" is handled after creation below.

    // ── Step 5: Source Vault semantic retrieval ────────────────────────────
    const vaultResult = await retrieveVaultContext(detectedTerm, paragraphContext);

    // ── Step 6: Definition generation ─────────────────────────────────────
    const definitionDirective = await resolveDirective("concept_definition");
    const definitionResult = await provider.generateDefinitions(
      detectedTerm,
      paragraphContext,
      wikiPage?.extract ?? "",
      vaultResult.context,
      definitionDirective,
    );

    if (!definitionResult || !definitionResult.hoverDefinition || !definitionResult.glossaryDefinition) {
      logger.debug({ term: detectedTerm }, "concept: definition generation returned null/empty");
      return null;
    }

    // ── Step 7: Definition verification ───────────────────────────────────
    // Verifier never sees article context — it must judge the glossary definition
    // purely on its standalone merits, without being anchored to any article.
    const verificationEnabled = await isAiFunctionEnabled("concept_verification");
    let verifiedConfidence = definitionResult.confidence;
    let verificationNotes = "verification skipped";
    let verificationStandalone = true;

    if (verificationEnabled) {
      const verificationDirective = await resolveDirective("concept_verification");
      const verification = await provider.verifyDefinition(
        detectedTerm,
        wikiPage?.extract ?? "",
        definitionResult.hoverDefinition,
        definitionResult.glossaryDefinition,
        verificationDirective,
      );
      // Final confidence = minimum of generation confidence and verification confidence.
      // Any false dimension drags the score down via the directive, but we take
      // the stricter of the two numbers to be conservative.
      verifiedConfidence = Math.min(definitionResult.confidence, verification.confidence);
      verificationNotes = verification.notes;
      verificationStandalone = verification.standalone;
      logger.debug(
        { term: detectedTerm, verifiedConf: verifiedConfidence, standalone: verificationStandalone, notes: verificationNotes },
        "concept: verification complete",
      );
    }

    // ── Persist the concept ────────────────────────────────────────────────
    const slug = await ensureUniqueSlug(termToSlug(detectedTerm));
    const canonicalTerm = toConceptTitleCase(detectedTerm);

    // Quarantine: auto-hide concepts whose glossary definition is not standalone
    // (article-context-dependent) or whose confidence is too low to trust.
    let quarantineReason: string | null = null;
    const status: "live" | "draft" | "hidden" = (() => {
      if (!verificationStandalone) {
        quarantineReason = `Glossary definition is article-specific, not a canonical standalone entry. ${verificationNotes}`.trim();
        return "hidden";
      }
      if (verifiedConfidence < 0.4) {
        quarantineReason = `Definition confidence too low (${verifiedConfidence.toFixed(2)}) — may be inaccurate or unverifiable. ${verificationNotes}`.trim();
        return "hidden";
      }
      return verifiedConfidence >= definitionThreshold ? "live" : "draft";
    })();

    // Resolve dictionary.com reference. Wikipedia is stored separately in
    // wikiUrl/wikiTitle; externalUrl/externalTitle hold the validated dict.com
    // entry (or null if dict.com doesn't have this term). Both sources are
    // shown independently on the glossary page as "Learn more" links.
    const dictEntry = await validateDictionaryComUrl(detectedTerm, slug);
    const externalUrl = dictEntry?.url ?? null;
    const externalTitle = dictEntry?.title ?? null;

    // Determine module type based on term category
    const moduleType = resolveModuleType(detectedTerm, wikiPage?.extract ?? "");

    const [created] = await db
      .insert(conceptsTable)
      .values({
        slug,
        term: canonicalTerm,
        definition: definitionResult.glossaryDefinition,
        hoverDefinition: definitionResult.hoverDefinition,
        wikiPageId: wikiPage?.pageId ?? null,
        wikiUrl: wikiPage?.url ?? null,
        wikiTitle: wikiPage?.title ?? null,
        wikiExtract: wikiPage?.extract ?? null,
        wikiRevId: wikiPage?.revId ?? null,
        externalUrl,
        externalTitle,
        realLifeExample: definitionResult.realLifeExample,
        whatItIsnt: definitionResult.whatItIsnt,
        commonlyMisusedOnline: definitionResult.commonlyMisusedOnline,
        moduleType,
        detectionConfidence,
        definitionConfidence: verifiedConfidence,
        status,
        quarantineReason,
        lastProcessedAt: new Date(),
      })
      .returning({ id: conceptsTable.id, slug: conceptsTable.slug });

    if (!created) return null;

    // ── Record provenance in concept_sources ────────────────────────────────
    // Fire-and-forget: source recording is audit metadata only; a failure here
    // must never prevent the concept from being returned to the caller.
    // Step 6.5: run the claim-relevance filter so only sources that directly
    // support a stated claim are written — claim_relevant=true on accepted rows.
    void (async () => {
      try {
        const candidates: Array<SourceCandidate & { relevanceScore: number }> = [];
        // Wikipedia grounding document — use the extract as the snippet
        if (wikiPage?.url) {
          candidates.push({
            url: wikiPage.url,
            sourceType: "wikipedia",
            snippet: wikiPage.extract?.slice(0, 500) ?? "",
            relevanceScore: 1.0,
          });
        }
        // Source Vault documents used in the definition prompt — carry chunk content
        for (const vs of vaultResult.sources) {
          candidates.push({
            url: vs.url,
            sourceType: "vault",
            snippet: vs.snippet,
            relevanceScore: vs.relevanceScore,
          });
        }
        if (candidates.length === 0) return;
        const relevanceMap = await filterClaimRelevantSources(
          definitionResult.glossaryDefinition,
          candidates,
        );
        // Only insert sources that passed the filter (relevant=true or defaulted pass).
        // false = explicitly rejected — skip insertion rather than mark it stored.
        const sourceRows = candidates
          .filter((c) => relevanceMap.get(c.url) !== false)
          .map((c) => ({
            conceptId: created.id,
            sourceUrl: c.url,
            sourceType: c.sourceType,
            relevanceScore: c.relevanceScore,
            claimRelevant: true as boolean | null,
          }));
        if (sourceRows.length > 0) {
          await db.insert(conceptSourcesTable).values(sourceRows).onConflictDoNothing();
        }
      } catch (err) {
        logger.debug({ err, conceptId: created.id }, "concept: source recording skipped");
      }
    })();

    // Persist aliases — with a conflation guard: a model-proposed alias that
    // matches ANOTHER concept's canonical term is NOT a synonym (both entries
    // provably coexist), so it is rejected and recorded as `distinct_from`
    // instead of silently gluing two distinct concepts together.
    const canonicalLower = canonicalTerm.toLowerCase();
    const uniqueAliases = [
      ...new Set(
        definitionResult.aliases
          .map((a) => a.toLowerCase().trim())
          .filter((a) => a.length > 0 && a !== canonicalLower),
      ),
    ];
    if (uniqueAliases.length > 0) {
      const { safe, rejected } = await filterConflatingAliases(uniqueAliases);
      if (safe.length > 0) {
        await db.insert(conceptAliasesTable).values(
          safe.map((alias) => ({
            conceptId: created.id,
            alias,
            isPrimary: false,
          })),
        );
      }
      for (const r of rejected) {
        try {
          await db.insert(conceptRelationshipsTable).values({
            fromConceptId: created.id,
            toConceptId: r.conceptId,
            relationType: "distinct_from",
            note: `Auto: the model proposed "${r.alias}" as an alias of "${canonicalTerm}", but it is a distinct glossary concept.`,
          });
        } catch (err: unknown) {
          if (!(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "23505")) {
            logger.warn({ err, alias: r.alias }, "concept: distinct_from insert failed for rejected alias");
          }
        }
        logger.info(
          { term: canonicalTerm, alias: r.alias, conflictsWith: r.conceptSlug },
          "concept: alias rejected (names a distinct concept), recorded distinct_from",
        );
      }
    }

    // ── Merge-queue: flag potential near-duplicate for admin review ──────────
    // When Step 4d found a near-duplicate (MERGE_THRESHOLD ≤ sim < REUSE_THRESHOLD),
    // force the new concept to draft (never live as a twin) and record a see_also
    // relationship with a merge note so admins can evaluate and consolidate.
    if (canonicalMatch?.action === "queue_merge") {
      if (status === "live") {
        try {
          await db
            .update(conceptsTable)
            .set({ status: "draft" })
            .where(eq(conceptsTable.id, created.id));
        } catch (err) {
          logger.warn({ err, conceptId: created.id }, "concept: merge-queue draft downgrade failed");
        }
      }
      try {
        await db
          .insert(conceptRelationshipsTable)
          .values({
            fromConceptId: created.id,
            toConceptId: canonicalMatch.id,
            relationType: "see_also",
            note: `Auto: potential near-duplicate (canonical token similarity ${canonicalMatch.similarity.toFixed(3)}). Review for merge — one of these concepts may be redundant.`,
          })
          .onConflictDoNothing();
      } catch (err) {
        logger.warn(
          { err, conceptId: created.id, targetId: canonicalMatch.id },
          "concept: merge-queue relationship insert failed",
        );
      }
      logger.info(
        { term: canonicalTerm, similarity: canonicalMatch.similarity, targetId: canonicalMatch.id },
        "concept: created as draft — queued for merge review with similar existing concept",
      );
    }

    logger.info(
      { term: canonicalTerm, slug, status, verifiedConf: verifiedConfidence, notes: verificationNotes },
      "concept: created",
    );
    // Fire-and-forget: sync the new concept to the vault glossary lane so its
    // definition is available as INTERNAL CONCEPT MEMORY for future drafts.
    // The cron re-embed sweep embeds it on the next tick; sync failures are
    // non-fatal (logged only, never block concept creation).
    void syncConceptToVault(created.id);
    return { id: created.id, slug: created.slug };
  } catch (err) {
    if (err instanceof PerplexityNotConfiguredError) throw err;
    logger.error({ err, term: detectedTerm }, "concept: failed to resolve or create concept");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main pipeline entry point
// ---------------------------------------------------------------------------

export interface ProcessConceptsResult {
  articleId: string;
  conceptsFound: number;
  mentionsCreated: number;
  status: "ok" | "skipped" | "failed";
  reason?: string;
}

/**
 * Run the full 7-step concept detection + definition pipeline for a single
 * published article. Fire-and-forget safe — all errors are caught and logged.
 *
 * @param articleId - UUID of the article to process
 * @param force     - Skip the "already processed" check and rerun
 */
export async function processArticleConcepts(
  articleId: string,
  force = false,
): Promise<ProcessConceptsResult> {
  const base = { articleId, conceptsFound: 0, mentionsCreated: 0 };

  try {
    // Guard: some research provider must be usable (Perplexity, or the Claude
    // fallback — Task #341). The reason string stays "perplexity_not_configured"
    // because admin surfaces key off it.
    if (!(await isResearchCapabilityAvailable())) {
      return { ...base, status: "skipped", reason: "perplexity_not_configured" };
    }

    // Guard: concept explainers must be enabled
    const settings = await getSiteSettings();
    if (!settings.conceptExplainersEnabled) {
      return { ...base, status: "skipped", reason: "explainers_disabled" };
    }

    // Guard: concept_detection AI function must be enabled
    const detectionEnabled = await isAiFunctionEnabled("concept_detection");
    if (!detectionEnabled) {
      return { ...base, status: "skipped", reason: "concept_detection_disabled" };
    }

    // Load article body (needed for hash-gated idempotency check below)
    const [article] = await db
      .select({
        body: articlesTable.body,
        status: articlesTable.status,
        conceptExplainersDisabled: articlesTable.conceptExplainersDisabled,
      })
      .from(articlesTable)
      .where(eq(articlesTable.id, articleId))
      .limit(1);

    if (!article || article.status !== "published") {
      return { ...base, status: "skipped", reason: "not_published" };
    }

    // Guard: per-article kill-switch
    if (article.conceptExplainersDisabled) {
      return { ...base, status: "skipped", reason: "article_disabled" };
    }

    // Compute a short content hash so that re-processed articles (edited body)
    // rerun the pipeline, while unedited articles are skipped idempotently.
    const bodyHash = createHash("sha256")
      .update(JSON.stringify(article.body))
      .digest("hex")
      .slice(0, 16);

    // Guard: skip if already successfully processed with the SAME body hash
    // (unless forced). A body edit clears the guard and triggers reprocessing.
    if (!force) {
      const prior = await db
        .select({ id: conceptProcessingRunsTable.id, contentHash: conceptProcessingRunsTable.contentHash })
        .from(conceptProcessingRunsTable)
        .where(
          and(
            eq(conceptProcessingRunsTable.articleId, articleId),
            eq(conceptProcessingRunsTable.status, "ok"),
          ),
        )
        .orderBy(desc(conceptProcessingRunsTable.createdAt))
        .limit(1);
      if (prior.length > 0 && prior[0]!.contentHash === bodyHash) {
        return { ...base, status: "skipped", reason: "already_processed" };
      }
    }

    const blocks: ArticleBlock[] = Array.isArray(article.body)
      ? (article.body as ArticleBlock[])
      : [];
    const paras = buildParagraphList(blocks);
    if (paras.length === 0) {
      return { ...base, status: "skipped", reason: "no_paragraphs" };
    }

    // ── Step 1: Perplexity concept detection ──────────────────────────────
    const detectionDirective = await resolveDirective("concept_detection");
    const paragraphsText = paras
      .map((p) => `[Paragraph ${p.index}]: ${p.text}`)
      .join("\n\n");

    const provider = resolveConceptLlmProvider();
    const detectionResult = await provider.detectConcepts(paragraphsText, detectionDirective);

    const detectionThreshold = settings.conceptDetectionThreshold;
    const definitionThreshold = settings.conceptDefinitionThreshold;

    // Skipped-candidate ledger for admin oversight — records every candidate
    // the pipeline saw but did not publish, with the filtering reason.
    const skippedCandidates: Array<{ term: string; reason: string; confidence: number }> = [];

    // Filter by detection confidence threshold
    const qualified = detectionResult.concepts.filter((c) => {
      if (c.confidence >= detectionThreshold) return true;
      skippedCandidates.push({ term: c.term, reason: "below_threshold", confidence: c.confidence });
      return false;
    });

    // Short-word / common-word guard: single ordinary English words are almost
    // never glossary-worthy concepts — verbs of movement, prepositions, simple
    // adjectives ("live", "peace", "grace") pick up false-positive matches in
    // compound phrases. Require a significantly higher confidence threshold for
    // any single-token term shorter than 8 characters OR whose normalized form is
    // in a known common-word set. Multi-word terms (technical compound nouns like
    // "vapor-pressure deficit") are always allowed through regardless of length.
    const COMMON_SINGLE_WORDS = new Set([
      // Articles / determiners
      "a", "an", "the",
      // Prepositions
      "at", "by", "for", "from", "in", "into", "of", "on", "onto", "out",
      "over", "per", "to", "up", "via", "with",
      // Copulas / auxiliaries
      "be", "been", "being", "is", "are", "was", "were", "have", "has", "had",
      "do", "does", "did", "will", "would", "can", "could", "may", "might",
      "shall", "should",
      // Common movement / state verbs (gerund/base form)
      "go", "going", "run", "running", "live", "living", "stand", "standing",
      "sit", "sitting", "move", "moving", "hold", "holding", "keep", "keeping",
      "turn", "turning", "feel", "feeling", "work", "working", "play", "playing",
      "stay", "staying", "set", "get", "getting", "make", "making", "let",
      "put", "come", "coming", "give", "giving", "take", "taking", "say",
      "see", "seem", "try", "trying", "use", "using", "want", "wanting",
      "need", "call", "show", "start", "leave", "think",
      // Common short nouns / adjectives that aren't specialized terms
      "bit", "end", "form", "kind", "lack", "level", "link", "list", "loss",
      "low", "mass", "mean", "mode", "move", "note", "null", "open", "part",
      "path", "plan", "pool", "rate", "rest", "role", "rule", "safe", "sale",
      "same", "scan", "self", "sign", "size", "skip", "slot", "sort", "span",
      "step", "stop", "sum", "task", "team", "term", "test", "text", "time",
      "true", "type", "unit", "user", "view", "wait", "wake", "walk", "wave",
      "way", "word", "zone",
      // Common short words that appear in compound nouns (the trouble category)
      "base", "case", "class", "code", "core", "data", "date", "down", "else",
      "even", "fact", "fall", "fast", "file", "flow", "free", "full", "gate",
      "good", "grow", "hand", "hard", "head", "help", "high", "home", "idea",
      "line", "load", "long", "look", "loop", "main", "map", "mark", "match",
      "more", "much", "name", "near", "next", "node", "norm", "once", "only",
      "order", "out", "over", "page", "pass", "past", "peer", "pick", "pipe",
      "place", "plant", "point", "post", "race", "read", "real", "right",
      "root", "round", "run", "side", "site", "slow", "small", "snap",
      "space", "state", "still", "store", "such", "tag", "tail", "then",
      "this", "tick", "tier", "till", "tip", "title", "top", "tree", "true",
      "try", "tune", "turn", "two", "when", "with", "wrap", "year",
    ]);
    // Threshold above which a short/common single-word term is still accepted.
    const SHORT_WORD_CONFIDENCE_FLOOR = 0.85;
    const qualifiedAfterWordGuard = qualified.filter((c) => {
      const norm = c.term.trim().toLowerCase().replace(/[-–—_]/g, " ").replace(/\s+/g, " ");
      const isSingleWord = !norm.includes(" ");
      if (!isSingleWord) return true; // multi-word terms always pass
      const isShort = norm.length < 8;
      const isCommon = COMMON_SINGLE_WORDS.has(norm);
      if ((isShort || isCommon) && c.confidence < SHORT_WORD_CONFIDENCE_FLOOR) {
        skippedCandidates.push({ term: c.term, reason: "short_common_word", confidence: c.confidence });
        return false;
      }
      return true;
    });

    if (qualifiedAfterWordGuard.length === 0) {
      await db.insert(conceptProcessingRunsTable).values({
        articleId,
        status: "ok",
        conceptsFound: 0,
        mentionsCreated: 0,
        model: "perplexity-sonar",
        contentHash: bodyHash,
        skippedCandidates,
      });
      return { ...base, status: "ok" };
    }

    // Apply density caps (admin-configurable, default 8 short / 12 long) plus
    // a fixed max of 2 per paragraph.
    const cap = maxConceptsForArticle(blocks, {
      maxDefault: settings.conceptDensityMaxDefault,
      maxLong: settings.conceptDensityMaxLong,
    });
    let totalAccepted = 0;
    const paraCounts = new Map<number, number>();
    const capped = qualifiedAfterWordGuard.filter((t) => {
      if (totalAccepted >= cap) {
        skippedCandidates.push({ term: t.term, reason: "density_cap", confidence: t.confidence });
        return false; // total cap
      }
      const paraCount = paraCounts.get(t.paragraphIndex) ?? 0;
      if (paraCount >= 2) {
        skippedCandidates.push({ term: t.term, reason: "density_cap", confidence: t.confidence });
        return false; // per-paragraph cap
      }
      paraCounts.set(t.paragraphIndex, paraCount + 1);
      totalAccepted++;
      return true;
    });

    // Process each qualified term through steps 2–7, collecting the NEW
    // mention set first — the swap below is all-or-nothing, so a mid-loop
    // failure never leaves the article with half its mentions deleted.
    type NewMention = {
      articleId: string;
      conceptId: string;
      matchedTerm: string;
      paragraphIndex: number;
      paragraphHash: string;
      sentenceHash: string;
      contextSnippet: string;
      confidence: number;
    };
    const newMentions: NewMention[] = [];
    const seenConceptIds = new Set<string>();
    for (const detected of capped) {
      const paragraphContext = paragraphContextForTerm(paras, detected.paragraphIndex);

      let concept: ResolvedConcept | null = null;
      try {
        concept = await resolveOrCreateConcept(
          detected.term.trim(),
          paragraphContext,
          detected.confidence,
          definitionThreshold,
          provider,
        );
      } catch (err) {
        if (err instanceof PerplexityNotConfiguredError) throw err; // propagate
        logger.warn({ err, term: detected.term }, "concept: resolveOrCreate failed, continuing");
      }

      if (!concept) {
        // Resolution/verification failed or definition confidence was too low
        skippedCandidates.push({ term: detected.term, reason: "not_created", confidence: detected.confidence });
        continue;
      }
      // One mention per (article, concept) — mirrors the DB unique constraint.
      if (seenConceptIds.has(concept.id)) continue;
      seenConceptIds.add(concept.id);

      const matchedTerm = detected.matchedText || detected.term;
      const paragraphText =
        paras.find((p) => p.index === detected.paragraphIndex)?.text ?? paragraphContext;

      // Word-boundary guard: verify the matched surface form actually appears at
      // a word boundary in the paragraph text before persisting the mention.
      // This catches cases where the LLM reports a surface form that only occurs
      // mid-compound (e.g. "peace" inside "peacefulness") — if the regex finds
      // zero boundary-safe hits, the mention is silently discarded. Uses the same
      // alphanumeric lookaround pattern as the renderers (client + SSR) and the
      // conceptTagger, so all three components agree on what counts as a match.
      const boundaryRe = buildSurfaceFormRegex(matchedTerm);
      if (boundaryRe && !boundaryRe.test(paragraphText)) {
        logger.debug(
          { term: matchedTerm, paragraphIndex: detected.paragraphIndex },
          "concept: surface form has no word-boundary hit in paragraph; discarding mention",
        );
        skippedCandidates.push({ term: detected.term, reason: "no_boundary_match", confidence: detected.confidence });
        continue;
      }

      const anchor = buildMentionAnchor(paragraphText, matchedTerm);
      newMentions.push({
        articleId,
        conceptId: concept.id,
        matchedTerm,
        paragraphIndex: detected.paragraphIndex,
        ...anchor,
        confidence: detected.confidence,
      });
    }

    // Atomically REPLACE this article's mention set so reprocessing an edited
    // body removes stale mentions (terms no longer present / moved paragraphs)
    // instead of accreting onto the old set. Old concept ids are captured so
    // article_count is recomputed for concepts that LOST this article too.
    const priorRows = await db
      .select({ conceptId: articleConceptMentionsTable.conceptId })
      .from(articleConceptMentionsTable)
      .where(eq(articleConceptMentionsTable.articleId, articleId));
    const priorConceptIds = priorRows.map((r) => r.conceptId);

    await db.transaction(async (tx) => {
      await tx
        .delete(articleConceptMentionsTable)
        .where(eq(articleConceptMentionsTable.articleId, articleId));
      if (newMentions.length > 0) {
        await tx.insert(articleConceptMentionsTable).values(newMentions);
      }
    });
    const mentionsCreated = newMentions.length;

    // Recompute article_count over the UNION of old and new concept ids so
    // both gained and lost mentions are reflected.
    const affectedConceptIds = [
      ...new Set([...priorConceptIds, ...newMentions.map((m) => m.conceptId)]),
    ];
    if (affectedConceptIds.length > 0) {
      await db
        .update(conceptsTable)
        .set({
          articleCount: sql`(
            SELECT COUNT(DISTINCT acm.article_id)
            FROM article_concept_mentions acm
            INNER JOIN articles a ON a.id = acm.article_id AND a.status = 'published'
            WHERE acm.concept_id = concepts.id
          )`,
          updatedAt: new Date(),
        })
        .where(inArray(conceptsTable.id, affectedConceptIds));
    }

    await db.insert(conceptProcessingRunsTable).values({
      articleId,
      status: "ok",
      conceptsFound: capped.length,
      mentionsCreated,
      model: "perplexity-sonar",
      contentHash: bodyHash,
      skippedCandidates,
    });

    return { ...base, conceptsFound: capped.length, mentionsCreated, status: "ok" };
  } catch (err) {
    if (err instanceof PerplexityNotConfiguredError) {
      logger.warn({ articleId }, "concept: Perplexity not configured, skipping");
      return { ...base, status: "skipped", reason: "perplexity_not_configured" };
    }
    logger.error({ err, articleId }, "concept: processArticleConcepts failed");
    try {
      await db.insert(conceptProcessingRunsTable).values({
        articleId,
        status: "failed",
        conceptsFound: 0,
        mentionsCreated: 0,
        model: "perplexity-sonar",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    } catch {}
    return { ...base, status: "failed" };
  }
}

// ---------------------------------------------------------------------------
// Backfill — durable, pausable, budget-aware
// ---------------------------------------------------------------------------
// Progress durability comes from the concept_processing_runs ledger itself:
// each successfully processed article gets an "ok" run row, and the candidate
// query below excludes those, so a paused/crashed/redeployed backfill resumes
// exactly where it left off. The background_jobs lock row (runId-fenced, per
// the repo's heavy-job convention) provides cross-instance mutual exclusion,
// live progress for the admin poller, and a cooperative pause flag.

const CONCEPT_BACKFILL_JOB = "concept_backfill";
const CONCEPT_BACKFILL_TTL_MS = 3 * 60 * 1000; // stale takeover after 3 min without heartbeat

export interface BackfillConceptsResult {
  processed: number;
  skipped: number;
  failed: number;
  stoppedReason?: "paused" | "budget_exceeded" | null;
}

async function countRemainingBackfillArticles(): Promise<{ total: number; remaining: number }> {
  const res = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM articles WHERE status = 'published') AS total,
      (SELECT COUNT(*) FROM articles a
        WHERE a.status = 'published'
          AND a.concept_explainers_disabled = false
          AND NOT EXISTS (
            SELECT 1 FROM concept_processing_runs r
            WHERE r.article_id = a.id AND r.status = 'ok'
          )) AS remaining
  `);
  const row = res.rows[0] as { total: unknown; remaining: unknown } | undefined;
  // Raw SQL aggregates come back as strings — coerce.
  return { total: Number(row?.total ?? 0), remaining: Number(row?.remaining ?? 0) };
}

/**
 * Backfill concept processing for published articles that have not yet been
 * successfully processed. Processes up to `limit` articles per invocation
 * (cron ticks call with a small limit; the admin "Start backfill" button uses
 * a large one). Cooperatively pauses via requestConceptBackfillPause and
 * stops cleanly when the AI budget guard trips.
 */
export async function backfillConcepts(limit = 20): Promise<BackfillConceptsResult> {
  const result: BackfillConceptsResult = { processed: 0, skipped: 0, failed: 0, stoppedReason: null };

  const runId = await acquireJobLock(CONCEPT_BACKFILL_JOB, {
    ttlMs: CONCEPT_BACKFILL_TTL_MS,
    progress: { processed: 0, skipped: 0, failed: 0, remaining: null },
  });
  if (!runId) return result; // another live run holds the lock

  try {
    // Budget guard: refuses to start when bulk jobs are disabled or the daily
    // ceiling is already crossed; per-article check() stops the loop cleanly.
    let guard: BudgetGuard;
    try {
      guard = await BudgetGuard.start("concept backfill");
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        logger.warn({ reason: err.message }, "concept: backfill blocked by budget");
        result.stoppedReason = "budget_exceeded";
        await finishJob(CONCEPT_BACKFILL_JOB, runId, "succeeded", {
          progress: { ...result, stoppedReason: "budget_exceeded" },
        });
        return result;
      }
      throw err;
    }

    const processed = db
      .select({ articleId: conceptProcessingRunsTable.articleId })
      .from(conceptProcessingRunsTable)
      .where(eq(conceptProcessingRunsTable.status, "ok"));

    const candidates = await db
      .select({ id: articlesTable.id })
      .from(articlesTable)
      .where(
        and(
          eq(articlesTable.status, "published"),
          eq(articlesTable.conceptExplainersDisabled, false),
          sql`${articlesTable.id} NOT IN (${processed})`,
        ),
      )
      .orderBy(desc(articlesTable.publishedAt))
      .limit(limit);

    const { remaining: startRemaining } = await countRemainingBackfillArticles();

    for (const { id } of candidates) {
      // Cooperative pause (admin button sets the cancel flag on the job row)
      if (await isCancelRequested(CONCEPT_BACKFILL_JOB)) {
        result.stoppedReason = "paused";
        break;
      }
      // Budget check before each article — throws when a ceiling is crossed
      try {
        await guard.check();
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          logger.warn({ reason: err.message }, "concept: backfill stopped by budget");
          result.stoppedReason = "budget_exceeded";
          break;
        }
        throw err;
      }

      const r = await processArticleConcepts(id);
      if (r.status === "ok") result.processed++;
      else if (r.status === "skipped") result.skipped++;
      else result.failed++;

      await heartbeatJob(CONCEPT_BACKFILL_JOB, runId, {
        processed: result.processed,
        skipped: result.skipped,
        failed: result.failed,
        remaining: Math.max(0, startRemaining - result.processed),
      });
    }

    const { remaining } = await countRemainingBackfillArticles();
    await finishJob(CONCEPT_BACKFILL_JOB, runId, "succeeded", {
      progress: { ...result, remaining },
    });
  } catch (err) {
    logger.error({ err }, "concept: backfill failed");
    await finishJob(CONCEPT_BACKFILL_JOB, runId, "failed", {
      progress: { ...result },
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
  }
  return result;
}

export async function isConceptBackfillRunning(): Promise<boolean> {
  const state = await getJobState(CONCEPT_BACKFILL_JOB);
  // Stale-heartbeat runs count as NOT running (matches acquireJobLock takeover),
  // so a crashed fire-and-forget run never deadlocks the admin button.
  return isJobRunning(state, CONCEPT_BACKFILL_TTL_MS);
}

/** Request cooperative pause of the running backfill. Returns false when idle. */
export async function requestConceptBackfillPause(): Promise<boolean> {
  return requestJobCancel(CONCEPT_BACKFILL_JOB);
}

export interface ConceptBackfillProgress {
  running: boolean;
  status: string;
  processed: number;
  skipped: number;
  failed: number;
  totalPublished: number;
  remaining: number;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  stoppedReason: string | null;
}

/** Durable progress snapshot for the admin poller. */
export async function getConceptBackfillProgress(): Promise<ConceptBackfillProgress> {
  const [state, counts] = await Promise.all([
    getJobState(CONCEPT_BACKFILL_JOB),
    countRemainingBackfillArticles(),
  ]);
  const progress = (state?.progress ?? {}) as Record<string, unknown>;
  return {
    running: isJobRunning(state, CONCEPT_BACKFILL_TTL_MS),
    status: state?.status ?? "idle",
    processed: Number(progress.processed ?? 0),
    skipped: Number(progress.skipped ?? 0),
    failed: Number(progress.failed ?? 0),
    totalPublished: counts.total,
    remaining: counts.remaining,
    error: state?.error ?? null,
    startedAt: state?.startedAt ?? null,
    finishedAt: state?.finishedAt ?? null,
    stoppedReason: typeof progress.stoppedReason === "string" ? progress.stoppedReason : null,
  };
}

// ---------------------------------------------------------------------------
// Merge duplicates
// ---------------------------------------------------------------------------

/**
 * Merge `sourceId` into `targetId`: mentions are re-pointed (dropping any that
 * would duplicate an existing target mention), the source term + its aliases
 * become aliases of the target, grounding sources move over, the source
 * concept row is deleted, and the target's article count is recomputed.
 * Returns the surviving target concept, or null when either id is missing.
 */
export async function mergeConcepts(
  sourceId: string,
  targetId: string,
): Promise<(typeof conceptsTable.$inferSelect) | null> {
  if (sourceId === targetId) return null;
  const rows = await db
    .select()
    .from(conceptsTable)
    .where(inArray(conceptsTable.id, [sourceId, targetId]));
  const source = rows.find((r) => r.id === sourceId);
  const target = rows.find((r) => r.id === targetId);
  if (!source || !target) return null;

  await db.transaction(async (tx) => {
    // Drop source mentions that would collide with an existing target mention
    await tx.execute(sql`
      DELETE FROM article_concept_mentions m
      WHERE m.concept_id = ${sourceId}
        AND EXISTS (
          SELECT 1 FROM article_concept_mentions t
          WHERE t.concept_id = ${targetId} AND t.article_id = m.article_id
        )
    `);
    // Re-point the rest
    await tx.execute(sql`
      UPDATE article_concept_mentions SET concept_id = ${targetId}
      WHERE concept_id = ${sourceId}
    `);
    // Source term + aliases become aliases of the target (skip duplicates,
    // skip anything equal to the target's own term). No unique constraint on
    // (concept_id, alias) exists, so dedupe via NOT EXISTS instead of ON CONFLICT.
    await tx.execute(sql`
      INSERT INTO concept_aliases (concept_id, alias, is_primary)
      SELECT ${targetId}, x.alias, false
      FROM (
        SELECT lower(${source.term}) AS alias
        UNION
        SELECT lower(alias) FROM concept_aliases WHERE concept_id = ${sourceId}
      ) x
      WHERE x.alias <> lower(${target.term})
        AND NOT EXISTS (
          SELECT 1 FROM concept_aliases e
          WHERE e.concept_id = ${targetId} AND lower(e.alias) = x.alias
        )
    `);
    // Move grounding sources (dedupe by (concept_id, source_url))
    await tx.execute(sql`
      INSERT INTO concept_sources (concept_id, source_url, source_type, relevance_score)
      SELECT ${targetId}, source_url, source_type, relevance_score
      FROM concept_sources WHERE concept_id = ${sourceId}
      ON CONFLICT (concept_id, source_url) DO NOTHING
    `);
    // Re-point Term of the Day history — the rows double as the cooldown
    // ledger and engagement history, and would otherwise cascade-delete with
    // the source concept. Snapshotted slug/term keep old posts readable.
    await tx.execute(sql`
      UPDATE term_of_day_posts SET concept_id = ${targetId}
      WHERE concept_id = ${sourceId}
    `);
    // Re-point curated relationships to the target, skipping self-links and
    // duplicates (unique on from/to/type). Whatever remains on the source
    // cascade-deletes with it — including any source↔target link, which is
    // meaningless once they are the same entry.
    await tx.execute(sql`
      INSERT INTO concept_relationships (from_concept_id, to_concept_id, relation_type, note)
      SELECT ${targetId}, to_concept_id, relation_type, note
      FROM concept_relationships
      WHERE from_concept_id = ${sourceId} AND to_concept_id <> ${targetId}
      ON CONFLICT (from_concept_id, to_concept_id, relation_type) DO NOTHING
    `);
    await tx.execute(sql`
      INSERT INTO concept_relationships (from_concept_id, to_concept_id, relation_type, note)
      SELECT from_concept_id, ${targetId}, relation_type, note
      FROM concept_relationships
      WHERE to_concept_id = ${sourceId} AND from_concept_id <> ${targetId}
      ON CONFLICT (from_concept_id, to_concept_id, relation_type) DO NOTHING
    `);
    // A Term-of-the-Day block on either entry survives the merge (e.g. a
    // blocked drug-name duplicate must not make the survivor postable).
    if (source.termOfDayBlocked && !target.termOfDayBlocked) {
      await tx
        .update(conceptsTable)
        .set({ termOfDayBlocked: true })
        .where(eq(conceptsTable.id, targetId));
    }
    // Delete the source concept (cascades its remaining aliases/sources)
    await tx.delete(conceptsTable).where(eq(conceptsTable.id, sourceId));
    // Recompute the target's published-article count
    await tx
      .update(conceptsTable)
      .set({
        articleCount: sql`(
          SELECT COUNT(DISTINCT acm.article_id)
          FROM article_concept_mentions acm
          INNER JOIN articles a ON a.id = acm.article_id AND a.status = 'published'
          WHERE acm.concept_id = concepts.id
        )`,
        updatedAt: new Date(),
      })
      .where(eq(conceptsTable.id, targetId));
  });

  // Best-effort cleanup of the loser's stored share-card images in object
  // storage (feed card, reels/snap card, composed og share image). Runs after
  // the transaction commits — a storage hiccup must never roll back the merge —
  // and is fire-and-forget so the admin response is not delayed.
  void deleteConceptStoredImages(source).catch((err) => {
    logger.warn({ err, conceptId: source.id, slug: source.slug }, "concept merge: share-card cleanup failed");
  });

  const [merged] = await db
    .select()
    .from(conceptsTable)
    .where(eq(conceptsTable.id, targetId))
    .limit(1);
  return merged ?? null;
}

/**
 * Delete a concept's stored card images from public object storage. Keys are
 * derived from the stored URLs (never guessed from slug patterns) so renamed
 * storage layouts stay correct. Missing files are a no-op.
 */
async function deleteConceptStoredImages(concept: {
  id: string;
  slug: string;
  cardImageUrl: string | null;
  reelsImageUrl: string | null;
  shareImage: string | null;
}): Promise<void> {
  const PUBLIC_PREFIX = "/api/storage/public-objects/";
  const keys = [concept.cardImageUrl, concept.reelsImageUrl, concept.shareImage]
    .filter((u): u is string => typeof u === "string" && u.startsWith(PUBLIC_PREFIX))
    .map((u) => u.slice(PUBLIC_PREFIX.length));
  for (const key of keys) {
    try {
      const deleted = await deletePublicObject(key);
      if (deleted) logger.info({ conceptId: concept.id, key }, "concept merge: deleted stored image");
    } catch (err) {
      logger.warn({ err, conceptId: concept.id, key }, "concept merge: failed to delete stored image");
    }
  }
}

// ---------------------------------------------------------------------------
// Per-article disable
// ---------------------------------------------------------------------------

/** Toggle the per-article Concept Explainer kill-switch. Returns null if the article is unknown. */
export async function setArticleConceptsDisabled(
  articleId: string,
  disabled: boolean,
): Promise<{ articleId: string; disabled: boolean } | null> {
  const res = await db
    .update(articlesTable)
    .set({ conceptExplainersDisabled: disabled })
    .where(eq(articlesTable.id, articleId))
    .returning({ id: articlesTable.id });
  if (res.length === 0) return null;
  return { articleId, disabled };
}

// ---------------------------------------------------------------------------
// Run history & cost reporting
// ---------------------------------------------------------------------------

export async function getConceptProcessingRuns(limit = 50) {
  const rows = await db
    .select({
      run: conceptProcessingRunsTable,
      articleTitle: articlesTable.title,
      articleSlug: articlesTable.slug,
      articleDisabled: articlesTable.conceptExplainersDisabled,
    })
    .from(conceptProcessingRunsTable)
    .innerJoin(articlesTable, eq(conceptProcessingRunsTable.articleId, articlesTable.id))
    .orderBy(desc(conceptProcessingRunsTable.createdAt), desc(conceptProcessingRunsTable.id))
    .limit(limit);
  return rows.map((r) => ({
    id: r.run.id,
    articleId: r.run.articleId,
    articleTitle: r.articleTitle,
    articleSlug: r.articleSlug,
    articleDisabled: r.articleDisabled,
    status: r.run.status,
    conceptsFound: r.run.conceptsFound,
    mentionsCreated: r.run.mentionsCreated,
    model: r.run.model,
    errorMessage: r.run.errorMessage,
    skippedCandidates: r.run.skippedCandidates ?? [],
    createdAt: r.run.createdAt.toISOString(),
  }));
}

const CONCEPT_AI_FUNCTIONS = ["concept_detection", "concept_definition", "concept_verification"] as const;

export async function getConceptCostSummary() {
  const res = await db.execute(sql`
    SELECT operation AS fn,
           COUNT(*) AS calls,
           COALESCE(SUM(cost_usd), 0) AS total_usd,
           COALESCE(SUM(cost_usd) FILTER (WHERE created_at >= now() - interval '30 days'), 0) AS usd_30d,
           MAX(model) AS last_model
    FROM ai_usage_events
    WHERE operation IN ('concept_detection', 'concept_definition', 'concept_verification')
    GROUP BY operation
  `);
  const byFn = new Map(
    res.rows.map((row) => {
      const r = row as Record<string, unknown>;
      return [String(r.fn), r] as const;
    }),
  );
  const functions = CONCEPT_AI_FUNCTIONS.map((fn) => {
    const r = byFn.get(fn);
    return {
      function: fn,
      calls: Number(r?.calls ?? 0),
      totalUsd: Number(r?.total_usd ?? 0),
      usd30d: Number(r?.usd_30d ?? 0),
      lastModel: r?.last_model ? String(r.last_model) : null,
    };
  });
  return {
    functions,
    totalUsd: functions.reduce((s, f) => s + f.totalUsd, 0),
    totalUsd30d: functions.reduce((s, f) => s + f.usd30d, 0),
  };
}

// ---------------------------------------------------------------------------
// Public helpers for admin & public routes
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Bulk operations
// ---------------------------------------------------------------------------

/**
 * Scans EVERY published article against EVERY concept (term + aliases) and
 * inserts any missing mentions. Pure DB work — no AI calls. Fire-and-forget
 * safe; existing mentions are skipped via onConflictDoNothing.
 */
export async function bulkScanAllConcepts(
  force = false,
): Promise<{ concepts: number; newMentions: number }> {
  const allConcepts = await db
    .select({ id: conceptsTable.id, term: conceptsTable.term })
    .from(conceptsTable)
    .orderBy(asc(conceptsTable.term));

  const articles = await db
    .select({ id: articlesTable.id, body: articlesTable.body })
    .from(articlesTable)
    .where(and(eq(articlesTable.status, "published"), isNull(articlesTable.quarantinedAt)));

  // Force mode: wipe ALL existing mentions so every concept is re-evaluated
  // with word-boundary matching. Corrects over-linked concepts from previous runs.
  if (force) {
    await db.delete(articleConceptMentionsTable);
  }

  // Pre-load all existing mention pairs so we can skip without hitting the DB.
  const existingRows = force
    ? []
    : await db
        .select({
          conceptId: articleConceptMentionsTable.conceptId,
          articleId: articleConceptMentionsTable.articleId,
        })
        .from(articleConceptMentionsTable);
  const mentionSet = new Set(existingRows.map((r) => `${r.conceptId}:${r.articleId}`));

  let totalNew = 0;

  for (const concept of allConcepts) {
    const aliasRows = await db
      .select({ alias: conceptAliasesTable.alias })
      .from(conceptAliasesTable)
      .where(eq(conceptAliasesTable.conceptId, concept.id));

    const searchTerms = [concept.term, ...aliasRows.map((a) => a.alias)].sort(
      (a, b) => b.length - a.length,
    );

    let created = 0;

    for (const article of articles) {
      if (mentionSet.has(`${concept.id}:${article.id}`)) continue;

      const blocks = (article.body ?? []) as Array<{ type: string; content: string }>;
      let foundIdx = -1;
      let matchedTerm = "";
      let foundContent = "";

      // Build word-boundary regex patterns (longer terms first to avoid a short
      // alias shadowing a longer alias that shares a prefix).
      const patterns = searchTerms.map((t) => ({
        term: t,
        re: new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
      }));

      let tMatchPos = 0;
      outer: for (let i = 0; i < blocks.length; i++) {
        if (blocks[i]?.type !== "paragraph") continue;
        for (const { term, re } of patterns) {
          const m = re.exec(blocks[i]!.content);
          if (m) {
            foundIdx = i;
            matchedTerm = term;
            foundContent = blocks[i]!.content;
            tMatchPos = m.index;
            break outer;
          }
        }
      }

      if (foundIdx === -1) continue;

      const paragraphHash = createHash("sha256").update(foundContent).digest("hex").slice(0, 16);
      const sentStart = Math.max(0, foundContent.lastIndexOf(". ", tMatchPos) + 2);
      const sentEndRaw = foundContent.indexOf(". ", tMatchPos + matchedTerm.length);
      const sentEnd = sentEndRaw === -1 ? foundContent.length : sentEndRaw + 1;
      const sentence = foundContent.slice(sentStart, sentEnd).trim();
      const sentenceHash = createHash("sha256").update(sentence).digest("hex").slice(0, 16);

      const centre = tMatchPos + Math.floor(matchedTerm.length / 2);
      let rawSnippet = foundContent.slice(
        Math.max(0, centre - 120),
        Math.min(foundContent.length, centre + 120),
      );
      const snipStartSpace = rawSnippet.indexOf(" ");
      if (snipStartSpace > 0 && snipStartSpace < 25) rawSnippet = rawSnippet.slice(snipStartSpace + 1);
      if (!/[.!?]$/.test(rawSnippet)) {
        const snipEndSpace = rawSnippet.lastIndexOf(" ");
        if (snipEndSpace > rawSnippet.length - 25) rawSnippet = rawSnippet.slice(0, snipEndSpace);
      }

      await db
        .insert(articleConceptMentionsTable)
        .values({
          articleId: article.id,
          conceptId: concept.id,
          matchedTerm,
          paragraphIndex: foundIdx,
          paragraphHash,
          sentenceHash,
          contextSnippet: rawSnippet,
          confidence: 1.0,
        })
        .onConflictDoNothing();

      mentionSet.add(`${concept.id}:${article.id}`);
      created++;
    }

    // In force mode every concept's count must be rewritten — even ones that
    // dropped back to 0 after their old (substring-matched) mentions were wiped.
    if (created > 0 || force) {
      const [countRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(articleConceptMentionsTable)
        .where(eq(articleConceptMentionsTable.conceptId, concept.id));
      await db
        .update(conceptsTable)
        .set({ articleCount: Number(countRow?.count ?? 0), updatedAt: new Date() })
        .where(eq(conceptsTable.id, concept.id));
    }

    totalNew += created;
  }

  logger.info({ concepts: allConcepts.length, newMentions: totalNew }, "bulk scan-all concepts complete");
  return { concepts: allConcepts.length, newMentions: totalNew };
}

/**
 * Regenerates the enrichment fields (realLifeExample, whatItIsnt,
 * commonlyMisusedOnline) for every concept that is currently missing at
 * least one of them. Calls generateDefinitions with the stored wiki extract
 * as context and overwrites only the three enrichment columns so existing
 * hover/glossary text is never touched.
 *
 * @param force  When true, regenerates ALL concepts regardless of nulls.
 */
// ---------------------------------------------------------------------------
// Bulk recompose — module-level state for status polling + cancel
// ---------------------------------------------------------------------------

const _bulkRecomposeState = {
  running: false,
  processed: 0,
  skipped: 0,
  failed: 0,
  total: 0,
  cancelRequested: false,
};

export function getBulkRecomposeStatus(): {
  running: boolean;
  processed: number;
  skipped: number;
  failed: number;
  total: number;
} {
  return { ..._bulkRecomposeState };
}

/**
 * Request a cooperative stop. The recompose loop checks this flag between
 * concepts and halts after the current one finishes. Returns true when a run
 * was active, false when already idle.
 */
export function requestBulkRecomposeCancel(): boolean {
  if (_bulkRecomposeState.running && !_bulkRecomposeState.cancelRequested) {
    _bulkRecomposeState.cancelRequested = true;
    return true;
  }
  return false;
}

export async function bulkRecomposeConceptDefinitions(force = false): Promise<{
  processed: number;
  skipped: number;
  failed: number;
}> {
  _bulkRecomposeState.running = true;
  _bulkRecomposeState.processed = 0;
  _bulkRecomposeState.skipped = 0;
  _bulkRecomposeState.failed = 0;
  _bulkRecomposeState.total = 0;
  _bulkRecomposeState.cancelRequested = false;
  const result = { processed: 0, skipped: 0, failed: 0 };

  const aiEnabled = await isAiFunctionEnabled("concept_definition");
  if (!aiEnabled) {
    logger.warn("bulk recompose: concept_definition AI function is disabled");
    return result;
  }

  const where = force
    ? sql`TRUE`
    : sql`(${conceptsTable.realLifeExample} IS NULL OR ${conceptsTable.whatItIsnt} IS NULL OR ${conceptsTable.commonlyMisusedOnline} IS NULL)`;

  const concepts = await db
    .select({
      id: conceptsTable.id,
      term: conceptsTable.term,
      wikiExtract: conceptsTable.wikiExtract,
    })
    .from(conceptsTable)
    .where(where)
    .orderBy(asc(conceptsTable.term));

  if (concepts.length === 0) {
    logger.info("bulk recompose: no concepts to process");
    _bulkRecomposeState.running = false;
    return result;
  }

  _bulkRecomposeState.total = concepts.length;

  const provider = resolveConceptLlmProvider();
  const directive = await resolveDirective("concept_definition");

  try {
    for (const concept of concepts) {
      if (_bulkRecomposeState.cancelRequested) {
        logger.info(result, "bulk recompose: cancelled by admin");
        break;
      }
      try {
        const defResult = await provider.generateDefinitions(
          concept.term,
          "",
          concept.wikiExtract ?? "",
          "",
          directive,
        );

        if (!defResult?.realLifeExample && !defResult?.whatItIsnt && !defResult?.commonlyMisusedOnline) {
          result.skipped++;
          _bulkRecomposeState.skipped = result.skipped;
          continue;
        }

        await db
          .update(conceptsTable)
          .set({
            realLifeExample: defResult.realLifeExample ?? undefined,
            whatItIsnt: defResult.whatItIsnt ?? undefined,
            commonlyMisusedOnline: defResult.commonlyMisusedOnline ?? undefined,
            updatedAt: new Date(),
          })
          .where(eq(conceptsTable.id, concept.id));

        result.processed++;
        _bulkRecomposeState.processed = result.processed;
      } catch (err) {
        logger.warn({ err, conceptId: concept.id, term: concept.term }, "bulk recompose: concept failed");
        result.failed++;
        _bulkRecomposeState.failed = result.failed;
      }
    }
  } finally {
    _bulkRecomposeState.running = false;
  }

  logger.info(result, "bulk recompose concepts complete");
  return result;
}

// ---------------------------------------------------------------------------
// Backfill & review sweep — admin-marked concepts (backfill_requested)
// ---------------------------------------------------------------------------
// Targeted "fix these specific terms" pass, marked one-by-one from the card
// viewer. For each marked concept: re-resolve the Wikipedia grounding,
// re-retrieve Source Vault context, regenerate ALL definition fields (hover,
// glossary, real-life example, what-it-isn't, misused-online), re-verify, then
// recapture both stored card snapshots. The mark is cleared ONLY on success so
// failures stay visibly queued for a retry.

const _backfillMarkedState = {
  running: false,
  processed: 0,
  failed: 0,
  total: 0,
  current: null as string | null,
  cancelRequested: false,
};

export function getBackfillMarkedStatus(): {
  running: boolean;
  processed: number;
  failed: number;
  total: number;
  current: string | null;
} {
  const { cancelRequested: _ignored, ...rest } = _backfillMarkedState;
  return { ...rest };
}

/** Cooperative stop — checked between concepts. Returns true when a run was active. */
export function requestBackfillMarkedCancel(): boolean {
  if (_backfillMarkedState.running && !_backfillMarkedState.cancelRequested) {
    _backfillMarkedState.cancelRequested = true;
    return true;
  }
  return false;
}

/**
 * Synchronously claim the sweep run slot (no awaits — safe against concurrent
 * POSTs). Returns false if a run is already active. The caller must either
 * invoke backfillMarkedConcepts() (whose finally releases the slot) or call
 * releaseBackfillMarkedClaim() if it bails out before starting.
 */
export function tryClaimBackfillMarkedRun(): boolean {
  if (_backfillMarkedState.running) return false;
  _backfillMarkedState.running = true;
  _backfillMarkedState.processed = 0;
  _backfillMarkedState.failed = 0;
  _backfillMarkedState.total = 0;
  _backfillMarkedState.current = null;
  _backfillMarkedState.cancelRequested = false;
  return true;
}

/** Release a claim taken via tryClaimBackfillMarkedRun without running the sweep. */
export function releaseBackfillMarkedClaim(): void {
  _backfillMarkedState.running = false;
}

/** Must only be called after a successful tryClaimBackfillMarkedRun(). */
export async function backfillMarkedConcepts(): Promise<{ processed: number; failed: number }> {
  const result = { processed: 0, failed: 0 };

  try {
    const aiEnabled = await isAiFunctionEnabled("concept_definition");
    if (!aiEnabled) {
      logger.warn("backfill-marked: concept_definition AI function is disabled");
      return result;
    }

    const marked = await db
      .select({
        id: conceptsTable.id,
        term: conceptsTable.term,
        wikiExtract: conceptsTable.wikiExtract,
        externalUrl: conceptsTable.externalUrl,
        externalTitle: conceptsTable.externalTitle,
      })
      .from(conceptsTable)
      .where(eq(conceptsTable.backfillRequested, true))
      .orderBy(asc(conceptsTable.term));

    if (marked.length === 0) {
      logger.info("backfill-marked: no concepts are marked");
      return result;
    }
    _backfillMarkedState.total = marked.length;

    const provider = resolveConceptLlmProvider();
    const definitionDirective = await resolveDirective("concept_definition");
    const verificationEnabled = await isAiFunctionEnabled("concept_verification");
    const verificationDirective = verificationEnabled
      ? await resolveDirective("concept_verification")
      : "";

    for (const concept of marked) {
      if (_backfillMarkedState.cancelRequested) {
        logger.info(result, "backfill-marked: cancelled by admin");
        break;
      }
      _backfillMarkedState.current = concept.term;
      try {
        // ── Re-resolve Wikipedia grounding (best-effort) ──────────────────
        const wikiPage = await resolveWikipedia(concept.term).catch(() => null);
        const wikiExtract = wikiPage?.extract ?? concept.wikiExtract ?? "";

        // ── Source Vault semantic retrieval ───────────────────────────────
        const vaultResult = await retrieveVaultContext(concept.term, "");

        // ── Regenerate the full definition set ────────────────────────────
        const defResult = await provider.generateDefinitions(
          concept.term,
          "",
          wikiExtract,
          vaultResult.context,
          definitionDirective,
        );
        if (!defResult?.hoverDefinition || !defResult.glossaryDefinition) {
          logger.warn({ term: concept.term }, "backfill-marked: definition generation returned empty");
          result.failed++;
          _backfillMarkedState.failed = result.failed;
          continue;
        }

        // ── Verify (glossary definition judged standalone — no article ctx) ─
        let verifiedConfidence = defResult.confidence;
        let verificationStandalone = true;
        let verificationNotes = "verification skipped";
        if (verificationEnabled) {
          const verification = await provider.verifyDefinition(
            concept.term,
            wikiExtract,
            defResult.hoverDefinition,
            defResult.glossaryDefinition,
            verificationDirective,
          );
          verifiedConfidence = Math.min(defResult.confidence, verification.confidence);
          verificationStandalone = verification.standalone;
          verificationNotes = verification.notes;
        }

        // Hard failures quarantine exactly like the create path; otherwise the
        // existing status is preserved — "review" is the admin's job, the sweep
        // never auto-promotes.
        const hardFail = !verificationStandalone || verifiedConfidence < 0.4;
        const quarantinePatch = hardFail
          ? {
              status: "hidden" as const,
              quarantineReason: !verificationStandalone
                ? `Glossary definition is article-specific, not a canonical standalone entry. ${verificationNotes}`.trim()
                : `Definition confidence too low (${verifiedConfidence.toFixed(2)}) — may be inaccurate or unverifiable. ${verificationNotes}`.trim(),
            }
          : {};

        await db
          .update(conceptsTable)
          .set({
            definition: defResult.glossaryDefinition,
            hoverDefinition: defResult.hoverDefinition,
            realLifeExample: defResult.realLifeExample ?? undefined,
            whatItIsnt: defResult.whatItIsnt ?? undefined,
            commonlyMisusedOnline: defResult.commonlyMisusedOnline ?? undefined,
            definitionConfidence: verifiedConfidence,
            ...(wikiPage
              ? {
                  wikiPageId: wikiPage.pageId,
                  wikiUrl: wikiPage.url,
                  wikiTitle: wikiPage.title,
                  wikiExtract: wikiPage.extract,
                  wikiRevId: wikiPage.revId ?? null,
                  externalUrl: wikiPage.url,
                  externalTitle: wikiPage.title,
                  moduleType: resolveModuleType(concept.term, wikiPage.extract),
                }
              : {}),
            ...quarantinePatch,
            backfillRequested: false,
            lastProcessedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(conceptsTable.id, concept.id));

        // Refresh the vault mirror + Wikipedia ingest (fire-and-forget).
        if (wikiPage) void enqueueWikipediaInVault(wikiPage, concept.term);
        void syncConceptToVault(concept.id);

        // ── Force-recapture both stored card snapshots ────────────────────
        // Best-effort: a busy capture engine must not fail the data backfill —
        // the admin can recapture manually from the same page.
        try {
          await captureSingleCard(concept.id);
        } catch (err) {
          logger.warn({ err, term: concept.term }, "backfill-marked: card recapture failed (data updated)");
        }

        result.processed++;
        _backfillMarkedState.processed = result.processed;
        if (hardFail) {
          logger.warn(
            { term: concept.term, notes: verificationNotes },
            "backfill-marked: regenerated but quarantined (hard verification failure)",
          );
        }
      } catch (err) {
        logger.warn({ err, conceptId: concept.id, term: concept.term }, "backfill-marked: concept failed");
        result.failed++;
        _backfillMarkedState.failed = result.failed;
      }
    }
  } finally {
    _backfillMarkedState.running = false;
    _backfillMarkedState.current = null;
  }

  logger.info(result, "backfill-marked sweep complete");
  return result;
}

export async function getConceptWithDetails(conceptId: string) {
  const [concept] = await db
    .select()
    .from(conceptsTable)
    .where(eq(conceptsTable.id, conceptId))
    .limit(1);
  if (!concept) return null;

  const aliases = await db
    .select()
    .from(conceptAliasesTable)
    .where(eq(conceptAliasesTable.conceptId, conceptId));

  return { ...concept, aliases };
}

/**
 * All live concept mentions for an article, ordered by paragraph index.
 * Used by the public article route and the concept card overlay.
 */
export async function getArticleConceptMentions(articleId: string) {
  const rows = await db
    .select({
      mention: articleConceptMentionsTable,
      concept: conceptsTable,
    })
    .from(articleConceptMentionsTable)
    .innerJoin(conceptsTable, eq(articleConceptMentionsTable.conceptId, conceptsTable.id))
    .where(
      and(
        eq(articleConceptMentionsTable.articleId, articleId),
        eq(conceptsTable.status, "live"),
        // Per-concept admin switch — disabled concepts never hover-annotate.
        eq(conceptsTable.hoverEnabled, true),
      ),
    )
    .orderBy(articleConceptMentionsTable.paragraphIndex);

  return rows.map((r) => ({
    id: r.mention.id,
    matchedTerm: r.mention.matchedTerm,
    paragraphIndex: r.mention.paragraphIndex,
    confidence: r.mention.confidence,
    concept: {
      id: r.concept.id,
      slug: r.concept.slug,
      term: r.concept.term,
      hoverDefinition: r.concept.hoverDefinition,
      definition: r.concept.definition,
      wikiUrl: r.concept.wikiUrl,
      // Hidden-term flag — hover surfaces stay allowed, page links do not.
      termOfDayBlocked: r.concept.termOfDayBlocked,
    },
  }));
}

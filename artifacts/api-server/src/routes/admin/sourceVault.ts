import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import {
  getVaultStatus,
  listDocuments,
  getDocument,
  getDocumentChunks,
  getDocumentContext,
  deleteDocument,
  ingestUrl,
  ingestUpload,
  approveAndEmbed,
  searchLeads,
  semanticSearch,
  setDocumentAuthority,
  setDocumentLifecycle,
  promoteCanonical,
  makeRepresentative,
  reclassifyAutoDomains,
  NotADuplicateError,
} from "../../services/sourceVault";
import { enqueueUrls, getQueueStats, listQueue } from "../../services/sourceIngestQueue";
import {
  SOURCE_AUTHORITY_TIER,
  SOURCE_DOC_STATUS,
  SOURCE_LIFECYCLE_STATUS,
} from "@workspace/db";
import { PerplexityNotConfiguredError, PerplexityApiError } from "../../services/perplexity";
import { EmbeddingNotConfiguredError } from "../../services/embeddings";
import {
  VaultBudgetExceededError,
  isSourceVaultEnabled,
} from "../../services/sourceVaultBudget";
import { UnsafeUrlError } from "../../services/sourceFetch";

const router: IRouter = Router();

// Map a service error to an HTTP response. Provider-unconfigured / budget /
// disabled all surface as 503 (temporarily unavailable) so the admin UI can show
// a clean "not configured / paused" state rather than a hard 500.
function handleServiceError(res: import("express").Response, e: unknown, log?: import("express").Request["log"]): void {
  if (e instanceof PerplexityNotConfiguredError || e instanceof EmbeddingNotConfiguredError) {
    res.status(503).json({ error: "not_configured", message: e.message });
    return;
  }
  if (e instanceof PerplexityApiError) {
    const isQuota = e.status === 401 || e.status === 429;
    res.status(503).json({
      error: isQuota ? "perplexity_quota" : "perplexity_error",
      message: isQuota
        ? "Perplexity is out of quota or in cooldown. Top up at perplexity.ai/settings/api and try again."
        : e.message,
    });
    return;
  }
  if (e instanceof VaultBudgetExceededError) {
    res.status(503).json({ error: e.reason, message: e.message });
    return;
  }
  if (e instanceof UnsafeUrlError) {
    res.status(400).json({ error: "unsafe_url", message: e.message });
    return;
  }
  log?.error({ err: e }, "source-vault: request failed");
  res.status(500).json({ error: "internal", message: e instanceof Error ? e.message : String(e) });
}

router.get("/source-vault/status", async (_req, res) => {
  res.json(await getVaultStatus());
});

const listDocumentsQuerySchema = z.object({
  authorityTier: z.enum(SOURCE_AUTHORITY_TIER).optional(),
  status: z.enum(SOURCE_DOC_STATUS).optional(),
  lifecycleStatus: z.enum(SOURCE_LIFECYCLE_STATUS).optional(),
  beat: z.string().min(1).optional(),
  duplicates: z.enum(["all", "only", "exclude"]).optional(),
  usefulness: z.enum(["published", "evidence", "draft", "orphaned"]).optional(),
  q: z.string().optional(),
  sort: z
    .enum([
      "recent",
      "updated",
      "oldest_unreviewed",
      "authority",
      "oldest",
      "quality",
      "words",
      "most_used",
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  packetId: z.string().uuid().optional(),
});

router.get("/source-vault/documents", async (req, res) => {
  const parsed = listDocumentsQuerySchema.safeParse(req.query ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", issues: parsed.error.issues });
    return;
  }
  res.json(await listDocuments(parsed.data));
});

const ingestSchema = z.object({
  url: z.string().min(1),
  approveLowQuality: z.boolean().optional(),
  leadSnippet: z.string().optional(),
  // Optional tier to immediately pin after ingestion (sets authoritySource = 'manual').
  authorityTier: z.enum(SOURCE_AUTHORITY_TIER).optional(),
});

router.post("/source-vault/ingest", async (req, res) => {
  const parsed = ingestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }
  try {
    const result = await ingestUrl(parsed.data.url, {
      approveLowQuality: parsed.data.approveLowQuality,
      leadSnippet: parsed.data.leadSnippet,
      discoveredVia: "manual_url",
    });
    // If an explicit tier was requested, pin it immediately so it survives re-ingest.
    if (parsed.data.authorityTier) {
      const pinned = await setDocumentAuthority(
        result.document.id,
        parsed.data.authorityTier,
        "Pinned at submission",
      );
      if (pinned) result.document = pinned;
    }
    res.json(result);
  } catch (e) {
    handleServiceError(res, e, req.log);
  }
});

// Bulk re-classify all auto-classified documents using the latest domain rules.
// Manually-pinned rows are never touched.
router.post("/source-vault/reclassify-domains", async (_req, res) => {
  const result = await reclassifyAutoDomains();
  res.json(result);
});

const uploadSchema = z.object({
  filename: z.string().min(1),
  contentBase64: z.string().min(1),
  contentType: z.string().optional(),
  approveLowQuality: z.boolean().optional(),
  beatSlug: z.string().optional(),
});

// Strictly validate base64 up front. Buffer.from(str, "base64") is lenient —
// it silently strips invalid characters rather than rejecting malformed input,
// so junk bytes could reach extraction. Reject clearly instead of storing
// garbage: require the standard alphabet, valid padding, and non-empty output.
function decodeBase64Strict(input: string): Buffer | null {
  const cleaned = input.replace(/\s+/g, "");
  if (cleaned.length === 0) return null;
  if (cleaned.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) return null;
  const bytes = Buffer.from(cleaned, "base64");
  if (bytes.length === 0) return null;
  return bytes;
}

router.post("/source-vault/upload", async (req, res) => {
  const parsed = uploadSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }
  if (decodeBase64Strict(parsed.data.contentBase64) === null) {
    res.status(400).json({
      error: "invalid_base64",
      message:
        "The uploaded file could not be decoded — it may be corrupted or was not encoded correctly. Please choose the file again.",
    });
    return;
  }
  if (!isSourceVaultEnabled()) {
    res.status(503).json({ error: "disabled", message: "Source Vault is disabled." });
    return;
  }
  try {
    const result = await ingestUpload({
      filename: parsed.data.filename,
      contentBase64: parsed.data.contentBase64,
      contentType: parsed.data.contentType,
      approveLowQuality: parsed.data.approveLowQuality,
      beatSlug: parsed.data.beatSlug,
    });
    res.json(result);
  } catch (e) {
    handleServiceError(res, e, req.log);
  }
});

const searchSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().min(1).max(25).optional(),
  recencyDays: z.number().int().min(1).optional(),
  domains: z.array(z.string().min(1)).optional(),
});

router.post("/source-vault/search", async (req, res) => {
  const parsed = searchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }
  try {
    // If the caller didn't provide an explicit domain override, apply the
    // configured allowlist from site settings so the manual "Discover leads"
    // flow respects the same domain filter as the automated discovery pass.
    let domains = parsed.data.domains;
    if (!domains || domains.length === 0) {
      const { getSiteSettings } = await import("../../services/siteSettings");
      const settings = await getSiteSettings();
      const allowed = settings.sourceDiscoveryAllowedDomains ?? [];
      if (allowed.length > 0) domains = allowed;
    }
    const leads = await searchLeads(parsed.data.query, {
      maxResults: parsed.data.maxResults,
      recencyDays: parsed.data.recencyDays,
      domains,
    });
    res.json({ leads });
  } catch (e) {
    handleServiceError(res, e, req.log);
  }
});

const retrieveSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
});

router.post("/source-vault/retrieve", async (req, res) => {
  const parsed = retrieveSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }
  try {
    const hits = await semanticSearch(parsed.data.query, { limit: parsed.data.limit });
    res.json({ hits });
  } catch (e) {
    handleServiceError(res, e, req.log);
  }
});

// Registered after the static sub-paths above so they take precedence.
router.get("/source-vault/documents/:id", async (req, res) => {
  const doc = await getDocument(req.params.id);
  if (!doc) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [chunks, context] = await Promise.all([
    getDocumentChunks(doc.id),
    getDocumentContext(doc),
  ]);
  res.json({
    document: doc,
    extractedText: doc.extractedText ?? null,
    chunks,
    duplicateOf: context.duplicateOf,
    duplicates: context.duplicates,
    articles: context.articles,
    relatedSources: context.relatedSources,
    representativeScore: context.representativeScore,
    representativeReasons: context.representativeReasons,
  });
});

router.post("/source-vault/documents/:id/make-representative", async (req, res) => {
  try {
    const result = await makeRepresentative(req.params.id);
    res.json(result);
  } catch (e) {
    if (e instanceof NotADuplicateError) {
      const status = e.message === "Document not found" ? 404 : 409;
      res.status(status).json({ error: "not_a_duplicate", message: e.message });
      return;
    }
    handleServiceError(res, e, req.log);
  }
});

router.delete("/source-vault/documents/:id", async (req, res) => {
  const deleted = await deleteDocument(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ deleted: true });
});

router.post("/source-vault/documents/:id/approve", async (req, res) => {
  try {
    const result = await approveAndEmbed(req.params.id);
    res.json(result);
  } catch (e) {
    if (e instanceof Error && e.message === "Document not found.") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    handleServiceError(res, e, req.log);
  }
});

const authoritySchema = z.object({
  // null clears the manual pin (revert to the auto classifier).
  tier: z.enum(SOURCE_AUTHORITY_TIER).nullable().optional(),
  reason: z.string().optional(),
});

router.post("/source-vault/documents/:id/authority", async (req, res) => {
  const parsed = authoritySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }
  const doc = await setDocumentAuthority(
    req.params.id,
    parsed.data.tier ?? null,
    parsed.data.reason,
  );
  if (!doc) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(doc);
});

const canonicalSchema = z
  .object({
    // null/"" clears the stored canonical URL; omit to leave it unchanged.
    canonicalUrl: z.string().nullable().optional(),
    // Omit to leave the current authority tier unchanged.
    tier: z.enum(SOURCE_AUTHORITY_TIER).optional(),
    reason: z.string().optional(),
  })
  .refine((v) => v.canonicalUrl !== undefined || v.tier !== undefined, {
    message: "Provide at least one of canonicalUrl or tier.",
  });

router.post("/source-vault/documents/:id/canonical", async (req, res) => {
  const parsed = canonicalSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }
  const doc = await promoteCanonical(req.params.id, {
    canonicalUrl: parsed.data.canonicalUrl,
    tier: parsed.data.tier,
    reason: parsed.data.reason,
  });
  if (!doc) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(doc);
});

const lifecycleSchema = z.object({
  lifecycleStatus: z.enum(SOURCE_LIFECYCLE_STATUS),
  doNotRefetch: z.boolean().optional(),
  note: z.string().optional(),
});

router.post("/source-vault/documents/:id/lifecycle", async (req, res) => {
  const parsed = lifecycleSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }
  const doc = await setDocumentLifecycle(req.params.id, parsed.data.lifecycleStatus, {
    doNotRefetch: parsed.data.doNotRefetch,
    note: parsed.data.note,
  });
  if (!doc) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  // Fire-and-forget cascade to dependent articles, packets, and concepts when
  // the lifecycle transitions to a non-active status via the admin UI. This
  // mirrors the automated paths (recheckActiveDocuments / markStaleDocuments).
  const NON_ACTIVE_LIFECYCLE = new Set(["retracted", "unavailable", "stale", "superseded"]);
  if (NON_ACTIVE_LIFECYCLE.has(parsed.data.lifecycleStatus)) {
    const docId = req.params.id;
    void import("../../services/retractionCascade")
      .then(({ cascadeSourceRetraction }) =>
        cascadeSourceRetraction(docId, parsed.data.lifecycleStatus),
      )
      .catch((e) =>
        req.log?.error({ err: e, docId }, "sourceVault lifecycle route: cascade failed (non-fatal)"),
      );
  }

  res.json(doc);
});

// --- Bounded batch ingestion queue ---------------------------------------
router.get("/source-vault/queue", async (_req, res) => {
  const [items, stats] = await Promise.all([listQueue(), getQueueStats()]);
  res.json({ items, stats });
});

const enqueueSchema = z.object({
  urls: z.array(z.string().min(1)).min(1),
  approveLowQuality: z.boolean().optional(),
  // How these URLs were found: bulk paste defaults to manual_url; discovery
  // leads pass perplexity_search so the queue can distinguish them.
  discoveredVia: z.enum(["manual_url", "perplexity_search"]).optional(),
  // Optional per-URL lead context (search snippet), aligned by index with urls.
  leadSnippets: z.array(z.string()).optional(),
});

router.post("/source-vault/queue/enqueue", async (req, res) => {
  const parsed = enqueueSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }
  if (!isSourceVaultEnabled()) {
    res.status(503).json({ error: "disabled", message: "Source Vault is disabled." });
    return;
  }
  const result = await enqueueUrls(parsed.data.urls, {
    approveLowQuality: parsed.data.approveLowQuality,
    discoveredVia: parsed.data.discoveredVia ?? "manual_url",
    leadSnippets: parsed.data.leadSnippets,
  });
  res.json(result);
});

export default router;

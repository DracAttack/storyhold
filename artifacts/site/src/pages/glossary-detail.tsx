/**
 * /glossary/:slug — full glossary entry for a single concept.
 * Dark editorial design: Dossier tilt-card hero + Field Index golden panels.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useLocation } from "wouter";
import { toArticleTitleCase } from "@/lib/utils";
import {
  ExternalLink,
  ArrowLeft,
  Lightbulb,
  Ban,
  BookOpen,
  Share2,
  Download,
  Quote,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  Shield,
  Zap,
  ShieldAlert,
  AlertTriangle,
  ChevronRight,
  ArrowRight,
  Info,
  RotateCcw,
} from "lucide-react";
import { useSeo, getSiteOrigin } from "@/lib/seo";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useGetPublicSiteSettings } from "@workspace/api-client-react";
import { DisplayAd } from "@/components/ads/DisplayAd";
import { AD_SLOTS } from "@/components/ads/adsense-config";
import { trackEvent } from "@/lib/analytics";
import NotFound from "./not-found";
import brainMark from "@/assets/brainhook-mark.png";
import SwipeNextConceptPrompt from "@/components/glossary/SwipeNextConceptPrompt";
import { getVisitedConcepts, recordVisitedConcept } from "@/lib/visitedConcepts";
import { isLatinAlias } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { downloadImage } from "@/lib/downloadImage";
import { useIsDesktop } from "@/hooks/use-mobile";

interface ConceptArticle {
  slug: string;
  title: string;
  publishedAt: string | null;
}

interface RelatedConcept {
  matchedAlias: string;
  slug: string;
  term: string;
}

// Direction-aware labels for curated relationships (distinct_from has its own
// callout box). The API already normalizes direction — an incoming parent_of
// arrives here as subtype_of and vice versa — so labels read correctly from
// this concept's point of view.
const RELATION_LABELS: Record<string, string> = {
  subtype_of: "A type of",
  parent_of: "Includes",
  antonym: "Opposite of",
  related: "Related to",
  see_also: "See also",
};
const RELATION_LABEL_ORDER = ["subtype_of", "parent_of", "antonym", "related", "see_also"] as const;

function dedupeRelatedConcepts(concepts: RelatedConcept[]): RelatedConcept[] {
  const seen = new Set<string>();
  return concepts.filter((c) => {
    if (seen.has(c.slug)) return false;
    seen.add(c.slug);
    return true;
  });
}

interface SeenInBrainHook {
  articleSlug: string;
  articleTitle: string;
  contextSnippet: string;
  paragraphIndex: number;
  matchedTerm?: string | null;
}

interface SourceTrailItem {
  sourceUrl: string;
  sourceType: "wikipedia" | "vault";
  relevanceScore: number;
  title?: string | null;
  author?: string | null;
  publisher?: string | null;
  publishedAt?: string | null;
  verifiedAt?: string | null;
  authorityTier?: string | null;
}

interface ConceptDetail {
  id: string;
  slug: string;
  term: string;
  hoverDefinition: string;
  definition: string;
  wikiUrl: string | null;
  wikiTitle: string | null;
  wikiExtract: string | null;
  articleCount: number;
  aliases: Array<{ id: string; alias: string; isPrimary: boolean }>;
  articles: ConceptArticle[];
  relatedConcepts?: RelatedConcept[];
  externalUrl: string | null;
  externalTitle: string | null;
  realLifeExample: string | null;
  whatItIsnt: string | null;
  commonlyMisusedOnline: string | null;
  seenInBrainHook: SeenInBrainHook[];
  moduleType: "behavioral" | "medical" | "technical" | "general" | null;
  sourceTrail: SourceTrailItem[];
  updatedAt: string | null;
  lastProcessedAt: string | null;
  shareImage?: string | null;
  cardImageUrl?: string | null;
  relationships?: Array<{ relationType: string; term: string; slug: string }>;
}

/**
 * Strip phrases the AI sometimes adds that reference internal article context
 * rather than the term's actual definition.
 */
function scrubContextPhrases(text: string): string {
  return text
    .replace(/\bin the context of (this|the) article[,]?\s*/gi, "")
    .replace(/\bas used in (this|the) article[,]?\s*/gi, "")
    .replace(/\bin this article[,']?s? context[,]?\s*/gi, "")
    .replace(/\bwithin (this|the) article[,]?\s*/gi, "")
    .replace(/\bas discussed in (this|the) article[,]?\s*/gi, "")
    .replace(/\bfor (the purposes of|the context of) (this|the) article[,]?\s*/gi, "")
    .replace(/\bin the article[,]?\s*/gi, "")
    .replace(/^\s*,\s*/, "")
    .trim();
}

/**
 * Trim a raw contextSnippet (which may start/end mid-word from the DB extraction)
 * to clean word boundaries, wrap in "…" ellipsis quotes, and highlight the
 * matched term inline in amber.
 */
function stripHtml(html: string): string {
  // Remove all HTML tags so snippet text can be sliced and highlighted safely.
  return html.replace(/<[^>]*>/g, "");
}

function formatSnippet(raw: string, term: string, matchedTerm?: string | null): React.ReactNode {
  let s = stripHtml(raw).trim();

  // Trim start to word boundary — skip partial first word (up to 25 chars)
  if (s.length > 0 && !/^\s/.test(s)) {
    const firstSpace = s.indexOf(" ");
    if (firstSpace > 0 && firstSpace < 25) s = s.slice(firstSpace + 1);
  }
  // Trim end to word boundary — drop partial last word (within 25 chars of end)
  if (s.length > 0 && !/[.!?'"]$/.test(s)) {
    const lastSpace = s.lastIndexOf(" ");
    if (lastSpace > 0 && lastSpace > s.length - 25) s = s.slice(0, lastSpace);
  }

  // Find the canonical term (case-insensitive) to highlight in amber
  const lower = s.toLowerCase();
  const termLower = term.toLowerCase();
  let idx = lower.indexOf(termLower);
  let highlightLen = term.length;

  // If the canonical term isn't in the snippet, try the surface form that was
  // actually matched — it may be an alias (e.g. "attachment styles" instead of
  // "attachment patterns"). This ensures the amber highlight always appears.
  if (idx === -1 && matchedTerm && matchedTerm.toLowerCase() !== termLower) {
    const matchedLower = matchedTerm.toLowerCase();
    const aliasIdx = lower.indexOf(matchedLower);
    if (aliasIdx !== -1) {
      idx = aliasIdx;
      highlightLen = matchedTerm.length;
    }
  }

  const open = "\u201c\u2026";  // "…
  const close = "\u2026\u201d"; // …"

  if (idx === -1) {
    return <>{open}{s}{close}</>;
  }

  return (
    <>
      {open}
      {s.slice(0, idx)}
      <span className="text-[#F5A84E] not-italic">{s.slice(idx, idx + highlightLen)}</span>
      {s.slice(idx + highlightLen)}
      {close}
    </>
  );
}

function useConceptDetail(slug: string) {
  return useQuery<ConceptDetail>({
    queryKey: ["concept-detail", slug],
    queryFn: async () => {
      const res = await fetch(`/api/public/concepts/${encodeURIComponent(slug)}`);
      if (res.status === 404) return null as unknown as ConceptDetail;
      if (!res.ok) throw new Error("Failed to load concept");
      return res.json();
    },
    staleTime: 10 * 60 * 1000,
  });
}

/** Build a UTM-tagged URL for a given share action. */
function buildUtmUrl(slug: string, source: string): string {
  try {
    const url = new URL(`/glossary/${slug}`, window.location.origin);
    url.searchParams.set("utm_source", source);
    url.searchParams.set("utm_medium", "social");
    url.searchParams.set("utm_campaign", "glossary_share");
    url.searchParams.set("utm_content", slug);
    return url.toString();
  } catch {
    return `${window.location.origin}/glossary/${slug}`;
  }
}

/** Copy text to clipboard with fallback. */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return true;
  } catch {
    return false;
  }
}


/**
 * Reader-friendly label for a source-trail entry.
 */
function sourceTrailLabel(s: SourceTrailItem): string {
  let host = "";
  try {
    host = new URL(s.sourceUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    // fall through
  }
  if (s.sourceType === "wikipedia" || host === "wikipedia.org" || host.endsWith(".wikipedia.org")) return "Wikipedia overview";
  if (host === "doi.org" || host.endsWith(".doi.org") || host === "pubmed.ncbi.nlm.nih.gov" || host === "ncbi.nlm.nih.gov") return "Peer-reviewed study";
  if (host === "nih.gov" || host.endsWith(".nih.gov")) return "NIH overview";
  if (host.endsWith(".gov")) return "Government source";
  switch (s.authorityTier) {
    case "primary": return "Primary source";
    case "firsthand": return "Official statement";
    case "wire": return "Wire service report";
    case "reported": return "News report";
    case "commentary": return "Commentary";
    case "reference": return "Background reference";
    default: return "Web source";
  }
}

const HIGHLIGHT_PRIORITY: Array<{ label: string; highlight: string }> = [
  { label: "Peer-reviewed study", highlight: "peer-reviewed research" },
  { label: "Government source", highlight: "government sources" },
  { label: "NIH overview", highlight: "NIH material" },
  { label: "Primary source", highlight: "primary sources" },
  { label: "Wire service report", highlight: "wire service reporting" },
  { label: "News report", highlight: "news reporting" },
  { label: "Wikipedia overview", highlight: "Wikipedia" },
];

function summarizeSourceTrail(trail: SourceTrailItem[]): { count: number; highlight: string; lastVerified: string | null } {
  const count = trail.length;
  const labels = new Set(trail.map(sourceTrailLabel));
  const highlight = HIGHLIGHT_PRIORITY.find((p) => labels.has(p.label))?.highlight ?? "reference sources";
  const timestamps = trail
    .map((s) => (s.verifiedAt ? Date.parse(s.verifiedAt) : Number.NaN))
    .filter((t) => Number.isFinite(t));
  const lastVerified = timestamps.length > 0
    ? new Date(Math.max(...timestamps)).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : null;
  return { count, highlight, lastVerified };
}

// Dark-themed share toolbar matching the editorial design.
function ShareToolbar({ data }: { data: ConceptDetail }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [regenning, setRegenning] = useState(false);
  const slug = data.slug;
  const { email } = useAuth();
  const queryClient = useQueryClient();

  const flash = (key: string) => {
    setCopied(key);
    window.setTimeout(() => setCopied(null), 2000);
  };

  const handleCopyDefinition = async () => {
    const text = `${data.term}\n\n${scrubContextPhrases(data.definition)}\n\n${buildUtmUrl(slug, "copy_definition")}`;
    if (await writeClipboard(text)) {
      flash("definition");
      trackEvent("glossary_share", { item_id: slug, item_name: data.term, platform: "copy_definition" });
    }
  };

  const handleCopyCitation = async () => {
    const iso = data.updatedAt ?? data.lastProcessedAt;
    const dateStr = iso
      ? new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
      : "n.d.";
    const canonical = `${getSiteOrigin()}/glossary/${slug}`;
    const text = `BrainHook. (${dateStr}). ${data.term}. BrainHook Glossary. ${canonical}`;
    if (await writeClipboard(text)) {
      flash("citation");
      trackEvent("glossary_share", { item_id: slug, item_name: data.term, platform: "copy_citation" });
    }
  };

  const downloadUrl = async (url: string) => {
    await downloadImage(url, `brainhook-glossary-${slug}.png`);
    trackEvent("glossary_share", { item_id: slug, item_name: data.term, platform: "download_card" });
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      // Canonical snapshot already stored — fetch and force-download it.
      if (data.cardImageUrl) {
        await downloadUrl(data.cardImageUrl);
        return;
      }
      // No stored snapshot yet — only an admin can trigger the server-side
      // capture (headless Chromium screenshots the CSS card). Public
      // visitors never hit the admin endpoint.
      if (!email) return;
      const r = await fetch(`/api/admin/concepts/${data.id}/capture-card`, {
        method: "POST",
        credentials: "include",
      });
      if (!r.ok) return;
      const { url } = (await r.json()) as { url: string };
      await queryClient.invalidateQueries({ queryKey: ["concept-detail", slug] });
      await downloadUrl(url);
    } finally {
      setDownloading(false);
    }
  };

  const handleRegen = async () => {
    setRegenning(true);
    try {
      await fetch(`/api/admin/concepts/${data.id}/card`, {
        method: "DELETE",
        credentials: "include",
      });
      await queryClient.invalidateQueries({ queryKey: ["concept-detail", slug] });
    } finally {
      setRegenning(false);
    }
  };

  const btn = "inline-flex items-center gap-1.5 rounded border border-[#2A2A32] bg-[#17171C] px-3 py-2 text-xs font-medium text-[#C9C4B9] hover:border-[#F5A84E]/60 hover:text-[#F5A84E] transition-colors";

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={handleCopyDefinition} className={btn}>
          {copied === "definition" ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
          {copied === "definition" ? "Copied" : "Copy definition"}
        </button>
        {(data.cardImageUrl || email) && (
          <button type="button" onClick={() => { void handleDownload(); }} disabled={downloading} className={btn}>
            <Download className="h-3.5 w-3.5" />
            {downloading ? "Preparing…" : "Download card"}
          </button>
        )}
        <button type="button" onClick={handleCopyCitation} className={btn}>
          {copied === "citation" ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Quote className="h-3.5 w-3.5" />}
          {copied === "citation" ? "Copied" : "Copy citation"}
        </button>
        {email && data.cardImageUrl && (
          <button
            type="button"
            onClick={() => { void handleRegen(); }}
            disabled={regenning}
            className={`${btn} border-amber-800/40 text-amber-500/70 hover:border-amber-500/60 hover:text-amber-400`}
            title="Clear stored snapshot so the next download re-captures a fresh card"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {regenning ? "Clearing…" : "Regen card"}
          </button>
        )}
      </div>
    </>
  );
}

function SourceTrailBox({ trail }: { trail: SourceTrailItem[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!trail || trail.length === 0) return null;
  const { count, highlight, lastVerified } = summarizeSourceTrail(trail);
  return (
    <div className="rounded-xl border border-[#2A2A32] bg-[#17171C] px-5 py-4 mb-6">
      <div className="flex items-start gap-3">
        <Shield className="h-5 w-5 text-[#F5A84E] mt-0.5 shrink-0" />
        <div className="flex-1">
          <p className="text-sm text-[#C9C4B9]">
            Based on{" "}
            <span className="font-semibold text-[#EEEBE4]">{count} reference source{count !== 1 ? "s" : ""}</span>
            {", including "}
            <span className="font-medium text-[#EEEBE4]">{highlight}</span>.
            {lastVerified && (
              <> Last verified <span className="text-[#9B968C]">{lastVerified}</span>.</>
            )}
          </p>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-1 mt-2 text-xs font-medium text-[#F5A84E] hover:text-[#F5A84E]/80"
          >
            {expanded ? <><ChevronUp className="h-3 w-3" /> Hide sources</> : <><ChevronDown className="h-3 w-3" /> Show sources</>}
          </button>
          {expanded && (
            <ul className="mt-3 space-y-2.5">
              {trail.map((s, i) => {
                const label = sourceTrailLabel(s);
                const published = s.publishedAt
                  ? new Date(s.publishedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
                  : null;
                const linkText = s.title?.trim() || s.sourceUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
                return (
                  <li key={i} className="text-xs">
                    <div className="flex items-center gap-2">
                      <span className="inline-block rounded px-1.5 py-0.5 font-medium bg-[#F5A84E]/10 text-[#F5A84E] shrink-0">{label}</span>
                      <a href={s.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-[#F5A84E] hover:underline truncate max-w-[280px] sm:max-w-[400px]">
                        {linkText}
                      </a>
                    </div>
                    {(s.publisher || s.author || published) && (
                      <div className="mt-0.5 ml-0.5 text-[#9B968C]">{[s.publisher, s.author, published].filter(Boolean).join(" · ")}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export default function GlossaryDetail() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug ?? "";
  const { data, isLoading, isError } = useConceptDetail(slug);

  // Site-wide ad master switch — same pattern as article.tsx.
  // Default to off while loading so ads never flash when disabled.
  const { data: siteSettings } = useGetPublicSiteSettings();
  const adsEnabled = siteSettings?.adsEnabled === true;
  const isDesktop = useIsDesktop();

  // Canonicalise merged-away slugs: the API resolves old alias slugs to the
  // surviving concept, whose own slug comes back in the payload. Replace the
  // URL (no history entry) so shares/bookmarks show the canonical address.
  const [, navigate] = useLocation();
  useEffect(() => {
    if (data?.slug && slug && data.slug !== slug) {
      navigate(`/glossary/${data.slug}`, { replace: true });
    }
  }, [data?.slug, slug, navigate]);

  // Record this concept as visited so swipe-next can exclude it.
  useEffect(() => {
    if (data?.slug) recordVisitedConcept(data.slug);
  }, [data?.slug]);

  // Prefetch the next concept for swipe-to-navigate.
  const { data: nextConceptData } = useQuery({
    queryKey: ["next-concept", data?.slug],
    queryFn: async () => {
      if (!data?.slug) return null;
      const visited = getVisitedConcepts();
      const res = await fetch(`/api/public/concepts/${data.slug}/next`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visited }),
      });
      if (!res.ok) return null;
      return res.json() as Promise<{ next: { slug: string; term: string } | null }>;
    },
    enabled: !!data?.slug,
    staleTime: 30_000,
  });

  const cleanDefinition = data ? scrubContextPhrases(data.definition) : "";
  const cleanHover = data ? scrubContextPhrases(data.hoverDefinition) : "";

  // Shuffle the seenInBrainHook entries once per data load so different visits
  // surface different article snippets (API returns up to 30, ordered by date).
  const shuffledMentions = useMemo(() => {
    if (!data?.seenInBrainHook) return [];
    const arr = [...data.seenInBrainHook];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    return arr;
  }, [data?.seenInBrainHook]);

  // Unified article list: all articles enriched with context snippets where available.
  const snippetBySlug = useMemo(() => {
    const map = new Map<string, SeenInBrainHook>();
    for (const s of (data?.seenInBrainHook ?? [])) map.set(s.articleSlug, s);
    return map;
  }, [data?.seenInBrainHook]);

  // Lead with seenInBrainHook articles (already shuffled, ALL have context snippets),
  // then append any remaining linked articles that didn't get a snippet.
  const allLinkedArticles = useMemo(() => {
    const seenSlugs = new Set<string>();
    const snippetArticles: ConceptArticle[] = shuffledMentions.map((s) => {
      seenSlugs.add(s.articleSlug);
      return { slug: s.articleSlug, title: s.articleTitle, publishedAt: null };
    });
    const rest = (data?.articles ?? []).filter((a) => !seenSlugs.has(a.slug));
    return [...snippetArticles, ...rest];
  }, [shuffledMentions, data?.articles]);

  const [visibleArticleCount, setVisibleArticleCount] = useState(20);

  const origin = getSiteOrigin();
  const termJsonLd = data
    ? {
        "@context": "https://schema.org",
        "@type": "DefinedTerm",
        name: data.term,
        description: cleanHover || cleanDefinition,
        url: `${origin}/glossary/${data.slug}`,
        sameAs: [...(data.wikiUrl ? [data.wikiUrl] : []), ...(data.externalUrl ? [data.externalUrl] : [])].filter(Boolean),
        inDefinedTermSet: { "@type": "DefinedTermSet", name: "BrainHook Glossary", url: `${origin}/glossary` },
      }
    : { "@context": "https://schema.org", "@type": "DefinedTermSet", name: "BrainHook Glossary", url: `${origin}/glossary` };

  useSeo({
    title: data ? `${data.term} — BrainHook Glossary` : "Glossary — BrainHook",
    description: data ? cleanHover || cleanDefinition : "Plain-English definitions of terms used in BrainHook articles.",
    noindex: false,
    ...(data?.cardImageUrl ? { image: `${origin}${data.cardImageUrl}`, imageWidth: 1200, imageHeight: 1470, imageAlt: `${data.term} — BrainHook Glossary` } : {}),
    jsonLd: termJsonLd,
  });

  useEffect(() => {
    if (!data) return;
    trackEvent("glossary_view", { content_type: "glossary_detail", item_id: data.slug, item_name: data.term });
  }, [data?.slug]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#0D0D10] flex items-center justify-center">
        <div className="text-[#9B968C] text-sm animate-pulse">Loading…</div>
      </div>
    );
  }

  if (isError || !data) return <NotFound />;

  // Build a lookup of alias text → concept slug for inline interlinking.
  // Aliases that have since become their own concept show up in relatedConcepts
  // (or will after the backfill runs). Match case-insensitively.
  const relatedByTerm = new Map<string, RelatedConcept>();
  for (const rc of data.relatedConcepts ?? []) {
    relatedByTerm.set(rc.term.toLowerCase(), rc);
    relatedByTerm.set(rc.matchedAlias.toLowerCase(), rc);
  }

  const allRelationships = data.relationships ?? [];
  const distinctFrom = allRelationships.filter((r) => r.relationType === "distinct_from");
  const otherRelationships = RELATION_LABEL_ORDER.map((type) => ({
    type,
    label: RELATION_LABELS[type]!,
    items: allRelationships.filter((r) => r.relationType === type),
  })).filter((g) => g.items.length > 0);

  const relatedConcepts = dedupeRelatedConcepts(data.relatedConcepts ?? []);

  // Build the independent "Learn more" sources. Wikipedia and dictionary.com
  // are shown as separate links when each is available.
  const learnMoreLinks: Array<{ href: string; label: string; sublabel: string }> = [];
  if (data.wikiUrl) {
    learnMoreLinks.push({ href: data.wikiUrl, label: "Learn more", sublabel: data.wikiTitle ?? "Wikipedia" });
  }
  if (data.externalUrl) {
    learnMoreLinks.push({ href: data.externalUrl, label: "Learn more", sublabel: data.externalTitle ?? "Dictionary" });
  }

  return (
    <div className="min-h-screen bg-[#0D0D10] text-[#EEEBE4]">
      <main className="max-w-[1280px] mx-auto px-6 md:px-12 pt-8 pb-16">

        {/* ─── Top bar — back link + eyebrow ─────────────────────────── */}
        <div className="flex items-center justify-between mb-8">
          <Link
            href="/glossary"
            className="inline-flex items-center gap-1.5 text-sm text-[#9B968C] hover:text-[#F5A84E] transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            All terms
          </Link>
          <div className="flex items-center gap-3">
            <div className="h-px w-6 bg-[#F5A84E]" />
            <span className="text-[#F5A84E] font-bold text-xs tracking-[0.2em] uppercase hidden sm:inline">
              BrainHook Glossary
            </span>
          </div>
        </div>

        {/* ─── Two-column layout ──────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-16 items-start">

          {/* ── LEFT COLUMN — hero content ────────────────────────────── */}
          <div className="lg:col-span-8 space-y-8">

            {/* ── Glassmorphism hero card — contains the h1 ────────────────── */}
            {/* CSS-rendered; never depends on a generated image file. Clicking triggers share. */}
            <div
              className="relative group cursor-pointer"
              role="button"
              tabIndex={0}
              aria-label={`Share: ${data.term}`}
              onClick={async () => {
                const url = buildUtmUrl(data.slug, "share");
                const cleanDef = scrubContextPhrases(data.definition);
                const correction = data.whatItIsnt
                  ? scrubContextPhrases(data.whatItIsnt).match(/^[^.!?]+[.!?]/)?.[0]?.trim() ?? null
                  : null;
                const text = correction ? `${correction} ${cleanDef}` : `${data.term}: ${cleanDef}`;
                if (navigator.share) {
                  try { await navigator.share({ title: data.term, text, url }); } catch { /* dismissed */ }
                } else {
                  await writeClipboard(url);
                }
              }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") e.currentTarget.click(); }}
            >
              {/* Amber glow plate behind the card */}
              <div className="absolute -inset-3 bg-gradient-to-br from-[#F5A84E]/10 to-transparent border border-[#F5A84E]/20 rounded-xl transform rotate-[2deg] transition-transform duration-300 group-hover:rotate-[1deg]" />

              {/* Main card body */}
              <div className="relative overflow-hidden rounded-lg border border-[#2A2A32] shadow-2xl shadow-black/70 transform -rotate-[1deg] transition-transform duration-300 group-hover:rotate-0">
                {/* Background gradient */}
                <div className="absolute inset-0 bg-gradient-to-br from-[#18181F] via-[#101018] to-[#080810]" />
                {/* Amber bloom — bottom-right corner */}
                <div className="absolute -bottom-16 -right-16 w-80 h-80 bg-[#F5A84E]/8 rounded-full blur-3xl pointer-events-none" />
                {/* Top amber hairline */}
                <div className="absolute top-0 inset-x-0 h-[2px] bg-gradient-to-r from-transparent via-[#F5A84E]/70 to-transparent" />
                {/* Glass sheen */}
                <div className="absolute inset-0 bg-gradient-to-br from-white/[0.025] to-transparent pointer-events-none" />

                <div className="relative p-8 md:p-10">
                  {/* Eyebrow — logo mark + wordmark + amber GLOSSARY (enlarged) */}
                  <div className="flex items-center gap-3 mb-6">
                    <img src={brainMark} alt="" aria-hidden="true" width={40} height={40} className="h-10 w-10 select-none" />
                    <span className="font-serif font-bold text-xl text-white tracking-tight">
                      Brain<span className="text-[#F5A84E]">Hook</span>
                    </span>
                    <div className="h-px w-5 bg-[#2A2A32]" />
                    <span className="text-[#F5A84E] font-bold text-sm tracking-[0.2em] uppercase">Glossary</span>
                  </div>

                  {/* Term */}
                  <h1 className="font-serif text-3xl md:text-5xl font-bold text-white leading-[1.05] tracking-tight mb-5">
                    {data.term}
                  </h1>

                  {/* Definition — white, slightly smaller for balance */}
                  <p className="text-[#EEEBE4] text-sm md:text-base leading-relaxed mb-5 max-w-xl">
                    {cleanDefinition || cleanHover}
                  </p>

                  {/* Card footer */}
                  <div className="pt-5 border-t border-[#2A2A32]/60 flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-[0.2em] text-[#9B968C]">brainhook.net/glossary</span>
                    <div className="flex items-center gap-3">
                      <span className="text-[10px] uppercase tracking-widest text-[#F5A84E]/60 group-hover:text-[#F5A84E]/90 transition-colors duration-300 flex items-center gap-1">
                        <Share2 className="w-3 h-3" /> Share
                      </span>
                      <div className="flex items-center gap-1">
                        <div className="w-1.5 h-1.5 rounded-full bg-[#F5A84E]" />
                        <div className="w-1 h-1 rounded-full bg-[#F5A84E]/50" />
                        <div className="w-0.5 h-0.5 rounded-full bg-[#F5A84E]/25" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Share toolbar */}
            <ShareToolbar data={data} />

            {/* ── Explainer panels (Field Index golden style) ── */}
            {data.realLifeExample && (
              <section className="bg-[#17171C] border border-[#2A2A32] p-6 md:p-8 rounded-xl relative overflow-hidden group">
                <div className="absolute top-0 left-0 w-1 h-full bg-[#2DD4BF]/50 group-hover:bg-[#2DD4BF]/80 transition-colors duration-200" />
                <div className="flex items-center gap-2 mb-4 text-[#2DD4BF]">
                  <Zap className="w-5 h-5" />
                  <h3 className="font-serif text-lg font-bold text-white">
                    {data.moduleType === "medical"
                      ? "What this does and why researchers care"
                      : data.moduleType === "technical"
                      ? "Where it appears and what happens when it fails"
                      : "What this means in real life"}
                  </h3>
                </div>
                <p className="text-[#C9C4B9] leading-relaxed">{scrubContextPhrases(data.realLifeExample)}</p>
              </section>
            )}

            {data.whatItIsnt && (
              <section className="bg-[#17171C] border border-[#2A2A32] p-6 md:p-8 rounded-xl relative overflow-hidden group">
                <div className="absolute top-0 left-0 w-1 h-full bg-[#F5A84E]/60 group-hover:bg-[#F5A84E] transition-colors duration-200" />
                <div className="flex items-center gap-2 mb-4 text-[#F5A84E]">
                  <ShieldAlert className="w-5 h-5" />
                  <h3 className="font-serif text-lg font-bold text-white">What it isn’t</h3>
                </div>
                <p className="text-[#C9C4B9] leading-relaxed">{scrubContextPhrases(data.whatItIsnt)}</p>
              </section>
            )}

            {data.commonlyMisusedOnline && (
              <section className="bg-[#17171C] border border-[#2A2A32] p-6 md:p-8 rounded-xl relative overflow-hidden group">
                <div className="absolute top-0 left-0 w-1 h-full bg-red-900/50 group-hover:bg-red-500/80 transition-colors duration-200" />
                <div className="flex items-center gap-2 mb-4 text-red-400">
                  <AlertTriangle className="w-5 h-5" />
                  <h3 className="font-serif text-lg font-bold text-white">Commonly misused online</h3>
                </div>
                <p className="text-[#C9C4B9] leading-relaxed">{scrubContextPhrases(data.commonlyMisusedOnline)}</p>
              </section>
            )}

            {/* ── Source trail ── */}
            <SourceTrailBox trail={data.sourceTrail} />

            {/* ── Articles featuring this term ── */}
            {allLinkedArticles.length > 0 && (() => {
              const visible = allLinkedArticles.slice(0, visibleArticleCount);
              const hasMore = allLinkedArticles.length > visibleArticleCount;
              // Split into chunks with ad slots between them
              const chunk1 = visible.slice(0, 6);
              const chunk2 = visible.slice(6, 14);
              const chunk3 = visible.slice(14);
              const renderCard = (article: ConceptArticle) => {
                const snippet = snippetBySlug.get(article.slug);
                return (
                  <Link
                    key={article.slug}
                    href={`/article/${article.slug}`}
                    className="border border-[#2A2A32] p-5 rounded-xl hover:bg-[#17171C] transition-colors group cursor-pointer block mb-4"
                    style={{ breakInside: "avoid" }}
                    onClick={() =>
                      trackEvent("concept_article_click", {
                        item_id: data.slug,
                        item_name: data.term,
                        content_type: "concept",
                        source: "glossary_detail",
                      })
                    }
                  >
                    {snippet?.contextSnippet ? (
                      <>
                        <Quote className="w-4 h-4 text-[#4A4A5A] mb-2 group-hover:text-[#F5A84E] transition-colors" />
                        <p className="text-[#C9C4B9] italic text-sm mb-3 leading-relaxed">
                          {formatSnippet(snippet.contextSnippet, data.term, snippet.matchedTerm)}
                        </p>
                      </>
                    ) : null}
                    <div className="flex items-center justify-between gap-2">
                      <span className={`font-bold uppercase tracking-wider group-hover:text-white transition-colors ${snippet?.contextSnippet ? "text-xs text-[#9B968C]" : "text-sm text-[#C9C4B9]"}`}>
                        {toArticleTitleCase(article.title)}
                      </span>
                      <ChevronRight className="w-4 h-4 shrink-0 text-[#4A4A5A] group-hover:text-[#F5A84E]" />
                    </div>
                  </Link>
                );
              };
              return (
                <div id="articles">
                  <div className="flex items-center gap-2 mb-6">
                    <BookOpen className="w-5 h-5 text-[#F5A84E]" />
                    <h3 className="font-serif text-xl font-bold text-white">Seen in BrainHook</h3>
                    <span className="text-sm text-[#6B6B7A] ml-1">{data.articleCount} {data.articleCount === 1 ? "article" : "articles"}</span>
                  </div>

                  {/* Chunk 1 */}
                  <div style={{ columns: "2", gap: "1rem" }}>
                    {chunk1.map(renderCard)}
                  </div>

                  {/* Ad slot 1 */}
                  {adsEnabled && visible.length > 6 && <DisplayAd />}

                  {/* Chunk 2 */}
                  {chunk2.length > 0 && (
                    <div style={{ columns: "2", gap: "1rem" }}>
                      {chunk2.map(renderCard)}
                    </div>
                  )}

                  {/* Ad slot 2 */}
                  {adsEnabled && visible.length > 14 && <DisplayAd />}

                  {/* Chunk 3 */}
                  {chunk3.length > 0 && (
                    <div style={{ columns: "2", gap: "1rem" }}>
                      {chunk3.map(renderCard)}
                    </div>
                  )}

                  {/* Load more */}
                  {hasMore && (
                    <div className="mt-6 text-center">
                      <button
                        onClick={() => setVisibleArticleCount((n) => n + 10)}
                        className="inline-flex items-center gap-2 text-sm text-[#F5A84E] border border-[#F5A84E]/30 rounded-lg px-4 py-2 hover:bg-[#F5A84E]/10 transition-colors"
                      >
                        Load more
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                      <p className="text-xs text-[#4A4A5A] mt-2">
                        Showing {visible.length} of {allLinkedArticles.length}
                      </p>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          {/* ── RIGHT COLUMN — Quick Facts locked at the top, ad below ──── */}
          <div className="lg:col-span-4">
            <div className="bg-[#17171C] border border-[#2A2A32] rounded-xl shadow-2xl shadow-black/50 overflow-hidden">
              <div className="bg-[#0D0D10] border-b border-[#2A2A32] py-4 px-6 flex items-center gap-2">
                <Info className="w-4 h-4 text-[#F5A84E]" />
                <h3 className="font-serif text-base font-bold text-white tracking-wide uppercase">
                  Quick Facts
                </h3>
              </div>

              <div className="p-6 space-y-6">

                {/* Aliases */}
                {data.aliases.filter((a) => isLatinAlias(a.alias)).length > 0 && (
                  <div>
                    <h4 className="flex items-center gap-1.5 text-[#7EC8E3] text-[10px] font-bold uppercase tracking-[0.2em] mb-3">
                      <Lightbulb className="w-3 h-3 shrink-0" />
                      Also known as
                    </h4>
                    <ul className="space-y-2">
                      {data.aliases.filter((a) => isLatinAlias(a.alias)).map((a) => {
                        const linked = relatedByTerm.get(a.alias.toLowerCase());
                        return (
                          <li key={a.id}>
                            {linked ? (
                              <Link
                                href={`/glossary/${linked.slug}`}
                                className="flex items-center gap-1.5 text-[15px] text-[#F5A84E] hover:underline"
                                onClick={() =>
                                  trackEvent("glossary_related_term_click", {
                                    item_id: linked.slug,
                                    item_name: linked.term,
                                    content_type: "concept",
                                    source: "glossary_alias_link",
                                  })
                                }
                              >
                                <div className="w-1.5 h-1.5 rounded-full bg-[#F5A84E] shrink-0" />
                                {a.alias}
                                <ChevronRight className="h-3 w-3 opacity-60 ml-auto" />
                              </Link>
                            ) : (
                              <span className="flex items-center gap-2 text-[15px] text-[#EEEBE4]">
                                <div className="w-1.5 h-1.5 rounded-full bg-[#4A4A5A] shrink-0" />
                                {a.alias}
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

                {/* Not to be confused with */}
                {distinctFrom.length > 0 && (
                  <div>
                    <h4 className="text-[#9B968C] text-[10px] font-bold uppercase tracking-[0.2em] mb-3">
                      Not to be confused with
                    </h4>
                    <div className="flex flex-col gap-2">
                      {distinctFrom.map((r) => (
                        <Link
                          key={r.slug}
                          href={`/glossary/${r.slug}`}
                          className="bg-[#0D0D10] border border-[#F5A84E]/20 hover:border-[#F5A84E]/60 text-[#F5A84E] text-sm px-3 py-2 rounded-md transition-colors flex items-center justify-between group"
                          onClick={() =>
                            trackEvent("glossary_related_term_click", {
                              item_id: r.slug,
                              item_name: r.term,
                              content_type: "concept",
                              source: "glossary_distinct_from",
                            })
                          }
                        >
                          <span>{r.term}</span>
                          <ChevronRight className="w-3.5 h-3.5 transform group-hover:translate-x-0.5 transition-transform" />
                        </Link>
                      ))}
                    </div>
                  </div>
                )}

                {/* Direction-aware relationships */}
                {otherRelationships.length > 0 && (
                  <div>
                    <h4 className="text-[#9B968C] text-[10px] font-bold uppercase tracking-[0.2em] mb-3">
                      Connections
                    </h4>
                    <div className="space-y-2">
                      {otherRelationships.map(({ type, label, items }) =>
                        items.map((r) => (
                          <Link
                            key={`${type}:${r.slug}`}
                            href={`/glossary/${r.slug}`}
                            className="bg-[#0D0D10] border border-[#2A2A32] hover:border-[#4A4A5A] p-3 rounded-lg flex items-center justify-between group transition-colors"
                            onClick={() =>
                              trackEvent("glossary_related_term_click", {
                                item_id: r.slug,
                                item_name: r.term,
                                content_type: "concept",
                                source: `glossary_${type}`,
                              })
                            }
                          >
                            <div className="flex flex-col">
                              <span className="text-[#9B968C] text-[10px] uppercase tracking-wider mb-0.5">{label}</span>
                              <span className="text-white text-sm font-medium">{r.term}</span>
                            </div>
                            <ChevronRight className="w-4 h-4 text-[#4A4A5A] group-hover:text-white transition-colors" />
                          </Link>
                        ))
                      )}
                    </div>
                  </div>
                )}

                {/* Related concepts — shared-alias neighbors */}
                {relatedConcepts.length > 0 && (
                  <div>
                    <h4 className="text-[#9B968C] text-[10px] font-bold uppercase tracking-[0.2em] mb-3">
                      Related concepts
                    </h4>
                    <div className="flex flex-wrap gap-2">
                      {relatedConcepts.map((rc) => (
                        <Link
                          key={rc.slug}
                          href={`/glossary/${rc.slug}`}
                          className="bg-[#0D0D10] border border-[#2A2A32] hover:border-[#4A4A5A] text-[#C9C4B9] hover:text-white text-sm px-3 py-1.5 rounded-md transition-colors"
                          onClick={() =>
                            trackEvent("glossary_related_term_click", {
                              item_id: rc.slug,
                              item_name: rc.term,
                              content_type: "concept",
                              source: "glossary_detail",
                            })
                          }
                        >
                          {rc.term}
                        </Link>
                      ))}
                    </div>
                  </div>
                )}

                {/* Divider */}
                {(data.aliases.length > 0 || distinctFrom.length > 0 || otherRelationships.length > 0 || relatedConcepts.length > 0) && (
                  <div className="h-px w-full bg-[#2A2A32]" />
                )}

                {/* Seen in BrainHook — 3 most recent article links */}
                {data.seenInBrainHook && data.seenInBrainHook.length > 0 && (
                  <div>
                    <h4 className="flex items-center gap-1.5 text-[#F5A84E] text-[10px] font-bold uppercase tracking-[0.2em] mb-3">
                      <BookOpen className="w-3 h-3 shrink-0" />
                      Seen in BrainHook
                    </h4>
                    <ul className="space-y-2">
                      {shuffledMentions.slice(0, 3).map((item) => (
                        <li key={item.articleSlug}>
                          <Link
                            href={`/article/${item.articleSlug}`}
                            className="text-sm text-[#C9C4B9] hover:text-[#F5A84E] hover:underline transition-colors leading-snug block"
                            onClick={() =>
                              trackEvent("concept_article_click", {
                                item_id: data.slug,
                                item_name: data.term,
                                content_type: "concept",
                                source: "quick_facts_sidebar",
                              })
                            }
                          >
                            {item.articleTitle}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* External references — Wikipedia and/or dictionary.com */}
                {learnMoreLinks.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between group"
                    onClick={() =>
                      trackEvent("concept_external_click", {
                        item_id: data.slug,
                        item_name: data.term,
                        content_type: "concept",
                        source: "glossary_sidebar",
                      })
                    }
                  >
                    <div className="flex items-center gap-3 text-[#EEEBE4]">
                      <div className="bg-[#2A2A32] p-2 rounded-md group-hover:bg-[#F5A84E] transition-colors">
                        <ExternalLink className="w-4 h-4 text-[#9B968C] group-hover:text-white" />
                      </div>
                      <div className="flex flex-col">
                        <span className="text-sm font-bold text-white group-hover:text-[#F5A84E] transition-colors">
                          {link.label}
                        </span>
                        <span className="text-xs text-[#9B968C]">{link.sublabel}</span>
                      </div>
                    </div>
                    <ArrowRight className="w-4 h-4 text-[#4A4A5A] group-hover:text-[#F5A84E] transform group-hover:translate-x-0.5 transition-all" />
                  </a>
                ))}
              </div>
            </div>

            {/* Vertical banner ad — directly under Quick Facts. Same universal
                toggle as every other unit (site setting adsEnabled) and
                collapses entirely when AdSense reports the slot unfilled.
                Only mounted on desktop widths: the sidebar stacks under the
                content on mobile, and mounting a hidden <ins> would fire a
                zero-width ad request AdSense can never fill. */}
            {adsEnabled && isDesktop && (
              <DisplayAd
                slot={AD_SLOTS.rectangle}
                format="vertical"
                className="my-6"
                maxHeight={600}
              />
            )}
          </div>

        </div>
      <SwipeNextConceptPrompt
        conceptSlug={slug}
        target={nextConceptData?.next ?? undefined}
      />
      </main>
    </div>
  );
}
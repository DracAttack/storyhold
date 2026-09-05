import { useMemo, useEffect, useRef, useState } from "react";
import { useParams, Link } from "wouter";
import { toArticleTitleCase } from "@/lib/utils";
import { motion, useScroll, useSpring } from "framer-motion";
import { format } from "date-fns";
import ArticleCard from "@/components/article/ArticleCard";
import SubscribePrompt from "@/components/article/SubscribePrompt";
import SwipeNextPrompt from "@/components/article/SwipeNextPrompt";
import AdminEditLink from "@/components/article/AdminEditLink";
import ResponsiveImage from "@/components/article/ResponsiveImage";
import ShareButtons from "@/components/article/ShareButtons";
import EditorialTrustBox from "@/components/article/EditorialTrustBox";
import { Clock } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import NotFound from "./not-found";
import { InlineAd } from "@/components/ads/InlineAd";
import { DisplayAd } from "@/components/ads/DisplayAd";
import { useGetPublicArticle, useListPublicArticles, useGetRelatedArticles, getNextArticle, useGetPublicSiteSettings, useRecordPageView, useSubscribeNewsletter, useGetArticleChain } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { captureTrafficSource } from "@/lib/analytics";
import { recordJourneyView, trackInternalClick } from "@/lib/journey";
import { getVisitedArticles, recordVisitedArticle } from "@/lib/visitedArticles";
import { resolveImage, handleImageError } from "@/lib/heroImage";
import { useSeo, getSiteOrigin } from "@/lib/seo";
import { resolveSeoTitle, resolveSeoDescription, resolveSocialTitle, resolveHookText } from "@/lib/seoText";
import { shouldPromptSubscribe, markSubscribePrompted, markSubscribed } from "@/lib/subscription";
import ConceptCard from "@/components/article/ConceptCard";

function toAbsolute(url: string): string {
  if (!url) return url;
  if (url.startsWith("http")) return url;
  try {
    return new URL(url, getSiteOrigin()).href;
  } catch {
    return url;
  }
}


// Render paragraph prose that may contain inline Markdown links. Two kinds are
// supported:
//   - External citation links — [phrase](https://…) — open in a new tab and are
//     marked nofollow (study/source citations).
//   - Internal rabbit-hole links — [phrase](/article/<slug>) — render as real
//     in-app links via wouter's <Link> (client-side navigation, plain crawlable
//     followable <a href>, NOT nofollow/new-tab) and are styled distinctly.
// Anything else is left as plain text, so older articles (plain prose) render
// unchanged.
// Inline tokens supported inside paragraph text: Markdown links, **bold**, and
// *italic*. Bold is tried before italic so `**x**` isn't mis-read as italic.
// Emphasis content must be non-empty and not start/end with whitespace, which
// keeps stray asterisks (e.g. "5 * 3") from accidentally emphasizing. Anything
// unmatched stays plain text, so older plain-prose articles render unchanged.
// Kept in sync with renderInlineHtml in server/index.ts.
const INLINE_TOKEN_RE =
  /\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/article\/[^\s)]+)\)|\*\*([^\s*](?:[^*]*[^\s*])?)\*\*|\*([^\s*](?:[^*]*[^\s*])?)\*/g;
// The model is asked to emit Markdown links, but it occasionally writes a raw
// HTML <a href="…">label</a> tag instead. Those would otherwise render as
// literal angle-bracket text, so normalize them back to Markdown before parsing
// (strip any stray inner tags from the label). Kept identical to the SSR copy
// in server/index.ts.
const HTML_ANCHOR_RE = /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
function htmlAnchorsToMarkdown(text: string): string {
  return text.replace(HTML_ANCHOR_RE, (_m, _q, href, label) => {
    const cleanLabel = String(label).replace(/<[^>]+>/g, "").trim();
    const cleanHref = String(href).trim();
    return `[${cleanLabel || cleanHref}](${cleanHref})`;
  });
}
// Citation markers: when an in-body external link's URL matches one of the
// article's references, a small superscript [n] follows the link, jumping to
// the matching entry in the numbered References list (#ref-n). URLs are
// normalized (protocol/www/trailing-slash/hash stripped) so trivial variants
// still match. Kept in sync with the SSR copy in server/index.ts.
function normalizeCitationUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}${u.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}
type RefNumberByUrl = Map<string, number>;
function renderInline(raw: string, refNumbers?: RefNumberByUrl): React.ReactNode {
  return parseInline(htmlAnchorsToMarkdown(raw), "i", refNumbers);
}

/** True when a link points to an article on this site, whether stored as a
 *  root-relative path or a full URL on the current origin. */
function isInternalLink(href: string): boolean {
  if (href.startsWith("/article/")) return true;
  try {
    const u = new URL(href);
    return u.pathname.startsWith("/article/");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Concept annotation
// ---------------------------------------------------------------------------
// Given a raw paragraph string and an array of concept mentions (each with a
// surfaceForm that is the exact casing used in the article), split the text on
// the FIRST occurrence of each surface form and wrap it in a ConceptCard.
// Only annotates the first occurrence per concept per paragraph to keep noise low.
// Falls back to plain renderInline for any segment that has no concept hits,
// so existing markdown/citation rendering is fully preserved.
type ConceptMentionInfo = { conceptId: string; slug: string; term: string; hoverDefinition: string; surfaceForm: string; paragraphIndex: number; wikiUrl: string | null; hidden?: boolean };

/** Escape a string for literal use inside a RegExp. */
function escapeRegExpChars(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
 * Build a word-boundary–safe, case-insensitive regex for a concept surface form.
 * Uses alphanumeric lookarounds (not `\b`) so terms that end in a non-word char
 * still anchor correctly. Inner whitespace/hyphens are flexible so
 * "vapor-pressure deficit" matches both the hyphenated and spaced variant.
 * Returns null for empty or whitespace-only forms.
 */
function buildBoundarySafeConceptRegex(surfaceForm: string): RegExp | null {
  const trimmed = surfaceForm.trim();
  if (!trimmed) return null;
  const words = trimmed.split(/[\s-]+/).filter(Boolean);
  if (words.length === 0) return null;
  const pattern = words.map(escapeRegExpChars).join("[\\s-]+");
  return new RegExp(`(?<![A-Za-z0-9])${pattern}(?![A-Za-z0-9])`, "i");
}

// Compute ranges that must not be annotated: markdown links [text](url),
// HTML anchors <a …>…</a>, and bold/italic markers themselves. Concept cards
// inside these zones would nest interactive elements inside links (invalid HTML)
// or corrupt the existing rendering.
function computeExclusionZones(raw: string): Array<{ start: number; end: number }> {
  const zones: Array<{ start: number; end: number }> = [];
  // Markdown links [label](url)
  const mdLink = /\[([^\]]*)\]\((https?:\/\/[^\s)]+|\/article\/[^\s)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdLink.exec(raw)) !== null) {
    zones.push({ start: m.index, end: m.index + m[0].length });
  }
  // Raw HTML anchors
  const htmlAnchor = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
  while ((m = htmlAnchor.exec(raw)) !== null) {
    zones.push({ start: m.index, end: m.index + m[0].length });
  }
  // Bold **…** markers
  const bold = /\*\*[^\s*](?:[^*]*[^\s*])?\*\*/g;
  while ((m = bold.exec(raw)) !== null) {
    zones.push({ start: m.index, end: m.index + m[0].length });
  }
  // Italic *…* markers
  const italic = /\*[^\s*](?:[^*]*[^\s*])?\*/g;
  while ((m = italic.exec(raw)) !== null) {
    zones.push({ start: m.index, end: m.index + m[0].length });
  }
  return zones;
}

function renderParagraphWithConcepts(
  raw: string,
  refNumbers: RefNumberByUrl | undefined,
  concepts: ConceptMentionInfo[],
): React.ReactNode {
  if (concepts.length === 0) return renderInline(raw, refNumbers);

  // Compute excluded ranges (markdown links, HTML anchors, bold/italic markers)
  const excluded = computeExclusionZones(raw);
  function isExcluded(start: number, end: number): boolean {
    return excluded.some((z) => start < z.end && end > z.start);
  }

  // Build a sorted list of (position, concept) hits in this paragraph text,
  // earliest first. Use a word-boundary–safe regex (alphanumeric lookarounds)
  // so that a surface form like "peace" doesn't match inside "peacefulness"
  // and "standing" doesn't match inside "outstanding". Case-insensitive.
  type Hit = { start: number; end: number; concept: ConceptMentionInfo };
  const hits: Hit[] = [];
  for (const c of concepts) {
    const re = buildBoundarySafeConceptRegex(c.surfaceForm);
    if (!re) continue;
    const m = re.exec(raw);
    if (!m) continue;
    const idx = m.index;
    const end = idx + m[0].length;
    // Skip if inside an excluded zone (link/emphasis syntax)
    if (isExcluded(idx, end)) continue;
    // Skip if overlapping a previously found hit
    if (hits.some((h) => idx < h.end && end > h.start)) continue;
    hits.push({ start: idx, end, concept: c });
  }
  if (hits.length === 0) return renderInline(raw, refNumbers);
  hits.sort((a, b) => a.start - b.start);

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < hits.length; i++) {
    const { start, end, concept } = hits[i]!;
    if (start > cursor) {
      nodes.push(
        <span key={`pre-${i}`}>{renderInline(raw.slice(cursor, start), refNumbers)}</span>,
      );
    }
    nodes.push(
      <ConceptCard
        key={`c-${concept.conceptId}`}
        term={concept.term}
        hoverDefinition={concept.hoverDefinition}
        slug={concept.slug}
        wikiUrl={concept.wikiUrl}
        hidden={concept.hidden}
      >
        {raw.slice(start, end)}
      </ConceptCard>,
    );
    cursor = end;
  }
  if (cursor < raw.length) {
    nodes.push(<span key="tail">{renderInline(raw.slice(cursor), refNumbers)}</span>);
  }
  return nodes;
}
// Recursive so emphasis can nest inside a link label (and vice versa). A fresh
// RegExp per call keeps the global lastIndex isolated across recursion.
function parseInline(text: string, keyPrefix: string, refNumbers?: RefNumberByUrl): React.ReactNode {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(INLINE_TOKEN_RE.source, "g");
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const k = `${keyPrefix}-${key++}`;
    if (match[2] !== undefined) {
      const href = match[2];
      const inner = parseInline(match[1]!, k);
      if (isInternalLink(href)) {
        // Normalise to root-relative so wouter Link works
        const linkHref = href.startsWith("/") ? href : new URL(href).pathname;
        nodes.push(
          <Link
            key={k}
            href={linkHref}
            className="internal-link"
          >
            {inner}
          </Link>,
        );
      } else {
        nodes.push(
          <a
            key={k}
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
          >
            {inner}
          </a>,
        );
        const refNum = refNumbers?.get(normalizeCitationUrl(href));
        if (refNum) {
          nodes.push(
            <sup key={`${k}-ref`} className="ml-0.5">
              <a
                href={`#ref-${refNum}`}
                aria-label={`Jump to reference ${refNum}`}
                className="text-[0.7em] font-semibold text-primary no-underline hover:underline"
              >
                [{refNum}]
              </a>
            </sup>,
          );
        }
      }
    } else if (match[3] !== undefined) {
      nodes.push(
        <strong key={k} className="font-semibold">
          {parseInline(match[3], k, refNumbers)}
        </strong>,
      );
    } else if (match[4] !== undefined) {
      nodes.push(<em key={k}>{parseInline(match[4], k, refNumbers)}</em>);
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes.length > 0 ? nodes : text;
}

export default function ArticlePage() {
  const params = useParams();
  const slug = params.slug ?? "";
  const { data: article, isLoading, error } = useGetPublicArticle(slug);

  // Self-hosted page-view counter. Fire once per article (best-effort) when its
  // data resolves; the server ignores unknown/unpublished slugs. A ref guards
  // against double-counting within a single mount (e.g. React strict mode).
  const recordView = useRecordPageView();
  const viewedSlugRef = useRef<string | null>(null);
  useEffect(() => {
    const viewedSlug = article?.slug;
    if (!viewedSlug || viewedSlugRef.current === viewedSlug) return;
    viewedSlugRef.current = viewedSlug;
    recordView.mutate({ data: { slug: viewedSlug, ...captureTrafficSource(), ...recordJourneyView(viewedSlug) } });
    // Remember this article for the session so the swipe-to-next lookup skips it
    // (keeps the relevance-first pick from ping-ponging back to what we just read).
    recordVisitedArticle(viewedSlug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article?.slug]);
  // Full list is kept ONLY to resolve manual `relatedArticle` blocks by slug.
  const { data: allData } = useListPublicArticles();
  // Topically-ranked neighbors for the auto inline callouts + "More like this"
  // rail (server reuses the concept-similarity engine; recency/category are only
  // tiebreakers), replacing the old client-side category-shuffle.
  const { data: relatedData } = useGetRelatedArticles(slug);
  // Swipe-to-next target: relevance-first but exhaustive. The server prefers the
  // most closely RELATED unseen article and falls back to a deterministic catalog
  // walk when the related pool is spent, so a swipe always advances. We post the
  // slugs already seen this session so it can skip them (the "most related" pick
  // is symmetric, so without this it would ping-pong between two articles). Keyed
  // on the current slug, but forced always-stale (staleTime 0, overriding the
  // 30s default) so revisiting an article — e.g. A→B→back to A — recomputes the
  // target from the CURRENT visited set instead of serving a cached pick from
  // before B was seen (which would re-suggest B and reintroduce a short loop).
  const { data: nextData } = useQuery({
    queryKey: ["getNextArticle", slug],
    queryFn: () => getNextArticle(slug, { visited: getVisitedArticles() }),
    enabled: Boolean(slug),
    staleTime: 0,
    refetchOnMount: "always",
  });
  const { data: siteSettings } = useGetPublicSiteSettings();
  // Site-wide ad master switch. Only render ad spots once we've confirmed they
  // are enabled — defaulting to off while loading avoids a flash of ads (and
  // empty containers) when the editor has turned them off.
  const adsEnabled = siteSettings?.adsEnabled === true;

  // Word count for the 200-word ad threshold: update articles shorter than 200
  // words are thin (a brief factual update, not a full read) and don't show ads.
  // Standard articles always show ads when adsEnabled; update articles require
  // at least 200 words so ad density remains reasonable relative to prose length.
  const articleWordCount = useMemo(() => {
    if (!article?.body) return 0;
    return (article.body as { type?: string; content?: string }[])
      .filter((b) => b.type !== "image")
      .reduce((acc, b) => acc + (b.content?.split(/\s+/).filter(Boolean).length ?? 0), 0);
  }, [article?.body]);
  const showAds = adsEnabled && (article?.articleKind !== "update" || articleWordCount >= 200);

  // Story chain: load when this article is part of an update chain (either as
  // the original or as an update). Skip when the slug hasn't resolved yet.
  const isPartOfChain = Boolean(article?.storyChainId);
  const { data: chainData } = useGetArticleChain(slug, {
    query: { queryKey: ["getArticleChain", slug], enabled: Boolean(slug) && isPartOfChain, staleTime: 60000 },
  });

  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, { stiffness: 100, damping: 30, restDelta: 0.001 });

  // Nudge readers to subscribe once they're ~a quarter of the way through, by
  // opening a centered modal that blurs the article behind it until they
  // subscribe or dismiss it. This fires AT MOST ONCE PER BROWSING SESSION (not
  // per article): the first time it shows, it records a sessionStorage flag, and
  // it's also suppressed entirely for visitors we already know subscribed (a
  // persistent localStorage flag set when they submit the newsletter form). See
  // lib/subscription.ts. A local ref guards against double-firing within this
  // mount before the effect re-checks.
  const [showSubscribePrompt, setShowSubscribePrompt] = useState(false);
  const [ctaEmail, setCtaEmail] = useState("");
  const [ctaWebsite, setCtaWebsite] = useState("");
  const ctaSubscribe = useSubscribeNewsletter();
  const handleCtaSubscribe = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = ctaEmail.trim();
    if (!trimmed || ctaSubscribe.isPending) return;
    ctaSubscribe.mutate(
      { data: { email: trimmed, website: ctaWebsite } },
      {
        onSuccess: (result) => {
          markSubscribed();
          toast.success(result.alreadySubscribed ? "You're already on the list!" : "You're in — see you Sunday.");
          setCtaEmail("");
        },
        onError: () => toast.error("Couldn't subscribe. Please try again."),
      },
    );
  };
  const subscribePromptFiredRef = useRef(false);
  useEffect(() => {
    subscribePromptFiredRef.current = false;
    if (!shouldPromptSubscribe()) return;
    const unsubscribe = scrollYProgress.on("change", (value) => {
      if (subscribePromptFiredRef.current) return;
      if (value >= 0.25) {
        subscribePromptFiredRef.current = true;
        markSubscribePrompted();
        setShowSubscribePrompt(true);
      }
    });
    return () => unsubscribe();
  }, [scrollYProgress, article?.slug]);

  // Concept annotations — fetch live concepts for this article (fire-and-forget,
  // best-effort; never blocks the article from rendering).
  const { data: conceptData } = useQuery<{ concepts: Array<{ conceptId: string; slug: string; term: string; hoverDefinition: string; surfaceForm: string; paragraphIndex: number; wikiUrl: string | null }> }>({
    queryKey: ["articleConcepts", slug],
    queryFn: () => fetch(`/api/public/articles/${encodeURIComponent(slug)}/concepts`).then((r) => r.ok ? r.json() : { concepts: [] }),
    enabled: Boolean(slug),
    staleTime: 10 * 60 * 1000,
  });
  const conceptMentions = conceptData?.concepts ?? [];

  // The server returns up to 6 topically-ranked neighbors (most-related first).
  // The prominent "More like this" rail takes the top 4; the inline body
  // callouts take the next 2, so the two sets never overlap. (Memoized so they
  // don't recompute on scroll-driven re-renders, and defined before any early
  // return to keep hook order stable.)
  const bottomRelated = useMemo(
    () => (relatedData?.items ?? []).slice(0, 4),
    [relatedData?.items],
  );
  const inlineRelated = useMemo(
    () => (relatedData?.items ?? []).slice(4, 7),
    [relatedData?.items],
  );

  // Raw hero (the literal article photo): the on-page image and JSON-LD image.
  const heroImage = article ? toAbsolute(resolveImage(article.heroImage)) : undefined;
  // Branded composite share card for og:image / twitter:image, falling back to
  // the raw hero when no composite exists.
  const seoImage = article
    ? article.shareImage
      ? toAbsolute(resolveImage(article.shareImage))
      : heroImage
    : undefined;
  const usingComposite = !!article?.shareImage;
  // Editor SEO overrides fall back to deterministic derivation when blank.
  // Priority for each surface: assigned hook → editor override → derivation.
  // The visible H1 uses the assigned `h1` hook when set, else the full headline.
  const displayHeadline = article
    ? resolveHookText(article.hookVariants, article.hookAssignments, "h1") ?? toArticleTitleCase(article.title)
    : "";
  const seoTitle = article
    ? resolveSeoTitle(
        article.title,
        article.seoTitle,
        resolveHookText(article.hookVariants, article.hookAssignments, "seoTitle"),
      )
    : "Loading";
  const socialTitle = article
    ? resolveSocialTitle(
        article.title,
        resolveHookText(article.hookVariants, article.hookAssignments, "social"),
      )
    : undefined;
  const seoDescription = article
    ? resolveSeoDescription(article.dek, article.seoDescription)
    : undefined;
  // url → 1-based reference number, so in-body citation links can carry a
  // superscript marker pointing at the numbered References list entry.
  const refNumbers = useMemo(() => {
    const map = new Map<string, number>();
    (article?.references ?? []).forEach((ref, i) => {
      map.set(normalizeCitationUrl(ref.url), i + 1);
    });
    return map;
  }, [article?.references]);

  const articleJsonLd = useMemo(() => {
    if (!article) return null;
    const canonical = `${getSiteOrigin()}/article/${article.slug}`;
    const articleBlock: Record<string, unknown> = {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: resolveHookText(article.hookVariants, article.hookAssignments, "h1") ?? article.title,
      description: resolveSeoDescription(article.dek, article.seoDescription) ?? article.dek,
      image: heroImage ? [heroImage] : undefined,
      datePublished: article.publishedAt,
      dateModified: article.editorial.updatedAt,
      author: { "@type": "Person", name: article.author.name },
      editor: { "@type": "Person", name: "Damien Lynn" },
      publisher: {
        "@type": "Organization",
        name: "BrainHook",
        legalName: "Brainhook Media",
        logo: { "@type": "ImageObject", url: `${getSiteOrigin()}/favicon.svg` },
      },
      mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
      articleSection: article.category,
    };
    // Deduplicated concept term blocks for the single managed JSON-LD script.
    const seen = new Set<string>();
    const termBlocks = conceptMentions
      .filter((c) => {
        if (seen.has(c.conceptId)) return false;
        seen.add(c.conceptId);
        return true;
      })
      .map((c) => ({
        "@context": "https://schema.org",
        "@type": "DefinedTerm",
        name: c.term,
        description: c.hoverDefinition,
        url: `${getSiteOrigin()}/glossary/${c.slug}`,
        inDefinedTermSet: {
          "@type": "DefinedTermSet",
          name: "BrainHook Glossary",
          url: `${getSiteOrigin()}/glossary`,
        },
        ...(c.wikiUrl ? { sameAs: c.wikiUrl } : {}),
      }));
    return {
      "@context": "https://schema.org",
      "@graph": [articleBlock, ...termBlocks],
    };
  }, [article, heroImage, conceptMentions]);

  useSeo({
    title: seoTitle,
    socialTitle,
    description: seoDescription,
    canonicalPath: `/article/${slug}`,
    image: seoImage,
    // Composite share card is 1200×630; the raw hero fallback is 16:9 (~1600×900).
    imageWidth: seoImage ? (usingComposite ? 1200 : 1600) : undefined,
    imageHeight: seoImage ? (usingComposite ? 630 : 900) : undefined,
    imageAlt: article ? article.title : undefined,
    type: "article",
    jsonLd: articleJsonLd,
  });

  if (isLoading) return <div className="container mx-auto px-4 py-24 text-center text-muted-foreground">Loading…</div>;
  if (error || !article) return <NotFound />;

  const related = bottomRelated;

  const totalBlocks = article.body.length;
  // Inline ad positions, scaled to article length. Short articles get few or
  // no in-body ads (AdSense policy: content must clearly outweigh ads), the
  // positions are spread evenly through the body, and the Set dedupes any
  // collisions so two ads can never stack at the same block index (the old
  // fixed 0.2/0.4/0.6/0.8 slots collided on articles under ~6 blocks).
  const inlineAdCount =
    totalBlocks >= 16 ? 4 : totalBlocks >= 12 ? 3 : totalBlocks >= 8 ? 2 : totalBlocks >= 6 ? 1 : 0;
  const inlineAdSlots = new Set<number>();
  for (let i = 1; i <= inlineAdCount; i++) {
    const raw = Math.min(totalBlocks - 1, Math.floor((totalBlocks * i) / (inlineAdCount + 1)));
    // Shift ad slots to the next paragraph boundary. Ads directly after
    // headings, images, or pull quotes feel jarring and violate AdSense
    // placement policies. Skip the slot if no paragraph exists after the raw
    // position (rare, but possible on very short articles).
    let s = raw;
    while (s < totalBlocks && article.body[s].type !== "paragraph") s += 1;
    if (s < totalBlocks) inlineAdSlots.add(s);
  }
  const hasManualRelated = article.body.some((b) => b.type === "relatedArticle");
  const suppressAutoRelated = hasManualRelated && !article.forceAutoRelated;
  const relatedSlotPositions = [0.25, 0.5, 0.75];
  // Same collision class the inline-ad slots had: on very short articles the
  // floored positions can land on the same block index, stacking two related
  // cards back-to-back. Nudge collisions forward to the next free index; if
  // there is no free index left, park the card at -1 (never matches) so it is
  // simply dropped rather than duplicated.
  const relatedSlots: number[] = [];
  if (!suppressAutoRelated) {
    // Inline ad positions already occupy their block indices; related cards
    // must not land on top of them (or on top of each other).
    const taken = new Set<number>(inlineAdSlots);
    inlineRelated.forEach((_, i) => {
      let s = Math.max(0, Math.min(totalBlocks - 1, Math.floor(totalBlocks * relatedSlotPositions[i])));
      while (taken.has(s) && s < totalBlocks - 1) s += 1;
      if (taken.has(s)) {
        relatedSlots.push(-1);
        return;
      }
      taken.add(s);
      relatedSlots.push(s);
    });
  }
  const relatedLabels = ["Related to this article", "This may also interest you", "Worth a read"];
  const articlesBySlug = new Map((allData?.items ?? []).map((a) => [a.slug, a] as const));

  return (
    <article className="pb-24 overflow-x-hidden">
      <SubscribePrompt open={showSubscribePrompt} onOpenChange={setShowSubscribePrompt} />
      <SwipeNextPrompt articleSlug={article.slug} target={nextData?.next ?? undefined} />
      <motion.div className="fixed top-0 left-0 right-0 h-1 bg-primary z-[100] origin-left" style={{ scaleX }} />

      <header className="relative overflow-hidden text-center" style={{ minHeight: 500 }}>
        {/* Hero image — very lightly fuzzed background */}
        <div className="absolute inset-0 pointer-events-none">
          <ResponsiveImage
            src={article.heroImage}
            alt=""
            aria-hidden
            widths={[800, 1200, 1600]}
            sizes="100vw"
            width={1600}
            height={900}
            priority
            className="w-full h-full object-cover"
            style={{ filter: "brightness(0.48) blur(1px)", transform: "scale(1.04)", transformOrigin: "center" } as React.CSSProperties}
          />
        </div>
        {/* Ultra-light scrim — just enough for text legibility */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: "linear-gradient(to bottom, rgba(13,13,16,0.35) 0%, rgba(13,13,16,0.60) 85%, rgba(13,13,16,0.85) 100%)" }}
        />
        {/* Frosted glass panel wrapping the text — very subtle */}
        <div className="relative z-10 container mx-auto px-4 pt-20 pb-10 max-w-4xl max-md:pl-[38px]">
        <Link
          href={`/category/${article.categorySlug}`}
          className="inline-block text-xs font-bold uppercase tracking-widest text-primary border border-primary/40 rounded-full px-4 py-1.5 mb-6 hover:bg-primary/10 transition-colors"
        >
          {article.category}
        </Link>
        <h1 className="font-serif text-4xl md:text-5xl lg:text-6xl font-bold leading-tight mb-6 text-foreground">{displayHeadline}</h1>
        <p className="text-xl md:text-2xl text-foreground/85 font-body leading-relaxed mb-8 max-w-3xl mx-auto">{article.dek}</p>

        <div className="flex items-center justify-center gap-4 text-sm mt-8 border-y border-border py-4 flex-wrap">
          <Link href={`/author/${article.author.slug}`} className="flex items-center gap-2 group">
            {article.author.avatarUrl ? (
              <img src={resolveImage(article.author.avatarUrl)} onError={handleImageError} alt={article.author.name} width={32} height={32} loading="lazy" decoding="async" className="h-8 w-8 rounded-full bg-primary/10 object-cover" />
            ) : (
              <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center font-bold text-primary">
                {article.author.name.charAt(0)}
              </div>
            )}
            <span className="font-semibold group-hover:text-primary transition-colors">{article.author.name}</span>
          </Link>
          <span className="text-muted-foreground">•</span>
          <span className="text-muted-foreground">{format(new Date(article.publishedAt), "MMMM d, yyyy")}</span>
          <span className="text-muted-foreground">•</span>
          <span className="text-muted-foreground flex items-center gap-1">
            <Clock className="h-3 w-3" /> {article.readingTimeMinutes} min read
          </span>
          <AdminEditLink articleId={article.id} />
        </div>

        {article.references.length > 0 && (
          <div className="flex justify-center mt-3">
            <a
              href="#references"
              className="text-xs font-semibold uppercase tracking-widest text-primary hover:underline underline-offset-4"
            >
              Sources &amp; Methodology &darr;
            </a>
          </div>
        )}

        </div>{/* /inner z-10 */}
      </header>

      {showAds && <div className="container mx-auto px-4 max-w-4xl"><DisplayAd /></div>}

      {/* ── Story chain banner ── */}
      {chainData && (
        <div className="container mx-auto px-4 max-w-[90ch] max-md:pl-[38px] mt-6">
          <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 px-5 py-4">
            <div className="flex items-center gap-2 mb-3">
              <span
                className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-amber-400"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-400" />
                </span>
                Developing story
              </span>
            </div>

            {/* Original article link (only show when viewing an update) */}
            {article.articleKind === "update" && (
              <div className="mb-3">
                <span className="text-xs text-muted-foreground uppercase tracking-wider" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                  Original story:{" "}
                </span>
                <Link
                  href={`/article/${chainData.original.slug}`}
                  className="text-sm font-medium text-primary hover:underline underline-offset-4"
                >
                  {chainData.original.title}
                </Link>
              </div>
            )}

            {/* Update chain */}
            {chainData.updates.length > 0 && (
              <div>
                <span className="text-xs text-muted-foreground uppercase tracking-wider" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                  {chainData.updates.length === 1 ? "1 update" : `${chainData.updates.length} updates`}
                  {" "}to this story:
                </span>
                <ul className="mt-2 space-y-1.5">
                  {chainData.updates.map((update) => (
                    <li key={update.id} className="flex items-baseline gap-2">
                      <span className="text-amber-400 text-xs shrink-0">↳</span>
                      <Link
                        href={`/article/${update.slug}`}
                        className={`text-sm hover:underline underline-offset-4 ${update.slug === slug ? "font-semibold text-foreground cursor-default pointer-events-none" : "text-primary"}`}
                      >
                        {update.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Part of a series: prev/next navigation by chain position.
                fullChain = [original, ...updates] already sorted by chainPosition. */}
            {(() => {
              const fullChain = [chainData.original, ...chainData.updates];
              const currentIdx = fullChain.findIndex((a) => a.slug === slug);
              const prevItem = currentIdx > 0 ? fullChain[currentIdx - 1] : null;
              const nextItem = currentIdx >= 0 && currentIdx < fullChain.length - 1 ? fullChain[currentIdx + 1] : null;
              if (!prevItem && !nextItem) return null;
              return (
                <div className="flex items-center justify-between gap-4 mt-4 pt-3 border-t border-amber-400/20">
                  <div className="flex-1">
                    {prevItem && (
                      <Link href={`/article/${prevItem.slug}`} className="group flex items-start gap-1.5 text-left">
                        <span className="text-amber-400 text-sm mt-0.5 shrink-0 group-hover:translate-x-[-2px] transition-transform">←</span>
                        <div>
                          <div className="text-[10px] uppercase tracking-widest text-muted-foreground" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                            {currentIdx === 1 ? "Original story" : "Previous update"}
                          </div>
                          <div className="text-xs text-primary group-hover:underline underline-offset-4 line-clamp-2 leading-snug">
                            {prevItem.title}
                          </div>
                        </div>
                      </Link>
                    )}
                  </div>
                  <div className="flex-1 text-right">
                    {nextItem && (
                      <Link href={`/article/${nextItem.slug}`} className="group flex items-start gap-1.5 justify-end text-right">
                        <div>
                          <div className="text-[10px] uppercase tracking-widest text-muted-foreground" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                            Next update
                          </div>
                          <div className="text-xs text-primary group-hover:underline underline-offset-4 line-clamp-2 leading-snug">
                            {nextItem.title}
                          </div>
                        </div>
                        <span className="text-amber-400 text-sm mt-0.5 shrink-0 group-hover:translate-x-[2px] transition-transform">→</span>
                      </Link>
                    )}
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      <div className="container mx-auto px-4 max-w-[90ch] max-md:pl-[38px]">
        <div className="prose prose-lg dark:prose-invert prose-p:font-body prose-headings:font-serif prose-primary mx-auto w-full max-w-full overflow-hidden break-words">
          {article.body.map((block, index) => (
            <div key={index} className="w-full max-w-full overflow-hidden">
              {block.type === "paragraph" && <p>{renderParagraphWithConcepts(block.content ?? "", refNumbers, conceptMentions.filter(c => c.paragraphIndex === index))}</p>}
              {block.type === "heading" && (
                <h2 className="!font-serif !font-bold !text-3xl md:!text-4xl !mt-16 !mb-6 !pt-6 !border-t-2 !border-primary/30 !leading-tight">
                  {block.content}
                </h2>
              )}
              {block.type === "pullquote" && (
                <blockquote className="font-serif italic text-2xl md:text-3xl text-primary my-10 border-l-4 border-primary pl-6">
                  "{block.content}"
                </blockquote>
              )}
              {block.type === "takeaways" && (
                <div className="not-prose my-8 rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 px-6 py-5">
                  <p className="text-xs font-bold uppercase tracking-widest text-emerald-700 dark:text-emerald-400 mb-3">What you can do</p>
                  <ul className="space-y-2">
                    {(block.items ?? []).map((item, ii) => (
                      <li key={ii} className="flex items-start gap-2.5 text-sm text-foreground/90 leading-snug">
                        <span className="mt-0.5 shrink-0 h-4 w-4 rounded-full bg-emerald-500/20 dark:bg-emerald-500/30 flex items-center justify-center">
                          <span className="block h-1.5 w-1.5 rounded-full bg-emerald-600 dark:bg-emerald-400" />
                        </span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {block.type === "image" && (
                <figure className="my-10">
                  <ResponsiveImage
                    src={block.content ?? ""}
                    alt="Article visual"
                    widths={[400, 800, 1200]}
                    sizes="(min-width: 768px) 70ch, 100vw"
                    width={1600}
                    height={900}
                    className="rounded-lg shadow-md w-full"
                  />
                </figure>
              )}
              {block.type === "relatedArticle" && (() => {
                const target = articlesBySlug.get(block.content ?? "");
                if (!target || target.id === article.id) return null;
                return (
                  <Link
                    href={`/article/${target.slug}`}
                    onClick={() => trackInternalClick({ toSlug: target.slug, fromSlug: article.slug, placement: "inline_manual" })}
                    className="not-prose my-8 group flex items-center gap-4 border-l-4 border-primary bg-primary/5 rounded-r px-4 py-3 hover:bg-primary/10 transition-colors"
                  >
                    <div className="relative shrink-0 h-20 w-20 sm:h-24 sm:w-24 overflow-hidden rounded bg-muted">
                      <ResponsiveImage
                        src={target.heroImage}
                        alt=""
                        widths={[160, 320]}
                        sizes="96px"
                        width={320}
                        height={320}
                        className="transition-transform duration-500 group-hover:scale-105"
                        style={{
                          position: "absolute",
                          inset: 0,
                          width: "100%",
                          height: "100%",
                          maxWidth: "none",
                          margin: 0,
                          objectFit: "cover",
                          objectPosition: "center",
                          display: "block",
                        }}
                      />
                    </div>
                    <div className="min-w-0 flex flex-col justify-center">
                      <div className="text-[11px] uppercase tracking-widest font-bold text-primary mb-1.5">
                        Suggested article
                      </div>
                      <div className="font-serif text-base sm:text-lg md:text-xl font-bold leading-snug text-foreground group-hover:text-primary transition-colors">
                        {toArticleTitleCase(target.title)} →
                      </div>
                    </div>
                  </Link>
                );
              })()}
              {showAds && inlineAdSlots.has(index) && <InlineAd />}
              {relatedSlots.map((s, i) =>
                index === s ? (
                  <Link
                    key={`rel-${i}`}
                    href={`/article/${inlineRelated[i].slug}`}
                    onClick={() => trackInternalClick({ toSlug: inlineRelated[i].slug, fromSlug: article.slug, placement: "inline_auto", recommendationRank: i + 4 })}
                    className="not-prose my-8 group flex items-center gap-4 border-l-4 border-primary bg-primary/5 rounded-r px-4 py-3 hover:bg-primary/10 transition-colors"
                  >
                    <div className="relative shrink-0 h-20 w-20 sm:h-24 sm:w-24 overflow-hidden rounded bg-muted">
                      <ResponsiveImage
                        src={inlineRelated[i].heroImage}
                        alt=""
                        widths={[160, 320]}
                        sizes="96px"
                        width={320}
                        height={320}
                        className="transition-transform duration-500 group-hover:scale-105"
                        style={{
                          position: "absolute",
                          inset: 0,
                          width: "100%",
                          height: "100%",
                          maxWidth: "none",
                          margin: 0,
                          objectFit: "cover",
                          objectPosition: "center",
                          display: "block",
                        }}
                      />
                    </div>
                    <div className="min-w-0 flex flex-col justify-center">
                      <div className="text-[11px] uppercase tracking-widest font-bold text-primary mb-1.5">
                        {relatedLabels[i]}
                      </div>
                      <div className="font-serif text-base sm:text-lg md:text-xl font-bold leading-snug text-foreground group-hover:text-primary transition-colors">
                        {toArticleTitleCase(inlineRelated[i].title)} →
                      </div>
                    </div>
                  </Link>
                ) : null,
              )}
            </div>
          ))}
        </div>

        {/* ── "Loved This Article?" subscribe CTA ── */}
        <div className="mt-12 flex flex-col items-center gap-4 text-center">
          <div className="space-y-1">
            <h3 className="font-serif text-2xl font-bold">Loved This Article?</h3>
            <p className="text-foreground/85 text-sm">Get stories like this every Sunday morning — no spam, ever.</p>
          </div>
          <form onSubmit={handleCtaSubscribe} className="flex flex-col sm:flex-row gap-3 w-full max-w-sm">
            <input
              type="text"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              value={ctaWebsite}
              onChange={(e) => setCtaWebsite(e.target.value)}
              style={{ position: "absolute", left: "-9999px", height: 0, width: 0, opacity: 0 }}
            />
            <Input
              type="email"
              placeholder="Your email address"
              value={ctaEmail}
              onChange={(e) => setCtaEmail(e.target.value)}
              disabled={ctaSubscribe.isPending}
              className="h-11 rounded-full"
              required
            />
            <Button type="submit" disabled={ctaSubscribe.isPending} className="h-11 px-6 rounded-full font-bold shrink-0">
              {ctaSubscribe.isPending ? "…" : "Subscribe"}
            </Button>
          </form>
        </div>

        <EditorialTrustBox editorial={article.editorial} references={article.references} />

        {article.slug === slug && (
          <div className="mt-10 pt-8 border-t border-border flex flex-col items-center gap-4 text-center">
            <div className="max-w-xl space-y-1.5">
              <p className="font-serif text-2xl font-bold leading-tight">Feel a Little Smarter? Rage Dump Averted?</p>
              <p className="text-foreground/85">
                Share it with someone you know will benefit from knowing this.
              </p>
            </div>
            <ShareButtons url={`/article/${article.slug}`} slug={article.slug} title={article.title} image={seoImage} socialPack={article.socialPack} label="Share" />
          </div>
        )}

        <div data-swipe-author-card className="mt-10 pt-8 border-t border-border flex items-start gap-4">
          {article.author.avatarUrl ? (
            <img src={resolveImage(article.author.avatarUrl)} alt={article.author.name} width={64} height={64} loading="lazy" decoding="async" className="h-16 w-16 rounded-full bg-primary/10 shrink-0 object-cover" />
          ) : (
            <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center font-bold text-primary text-xl shrink-0">
              {article.author.name.charAt(0)}
            </div>
          )}
          <div>
            <h4 className="font-bold text-lg mb-1">About {article.author.name}</h4>
            <p className="text-foreground/85">{article.author.bio}</p>
            <Link href={`/author/${article.author.slug}`} className="inline-block mt-2 text-sm font-semibold text-primary hover:underline decoration-2 underline-offset-4">
              All stories by {article.author.name} &rarr;
            </Link>
          </div>
        </div>

        <div className="mt-10 pt-6 border-t border-border">
          <p className="text-xs leading-relaxed text-foreground/85">
            <span className="font-bold">DISCLAIMER:</span> BrainHook articles are editorial and
            informational, not professional advice. Articles may include research summaries,
            interpretation, opinion, and uncertainty. Content about health, mental health, law,
            finance, safety, or relationships should not be treated as diagnosis, treatment, legal
            advice, financial advice, or personal instruction.
          </p>
        </div>
      </div>

      {showAds && <div className="container mx-auto px-4 max-w-4xl mt-8"><DisplayAd /></div>}

      {related.length > 0 && (
        <section className="container mx-auto px-4 mt-8 max-w-6xl border-t border-border pt-8">
          <h3 className="font-serif text-3xl font-bold mb-10 text-center">More like this</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8">
            {related.map((r, index) => (
              <motion.div key={r.id} initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ duration: 0.4, delay: index * 0.1 }}>
                <ArticleCard
                  article={r}
                  onSelect={() => trackInternalClick({ toSlug: r.slug, fromSlug: article.slug, placement: "more_like_this", recommendationRank: index + 1 })}
                />
              </motion.div>
            ))}
          </div>
        </section>
      )}
    </article>
  );
}

import { useParams, useSearch, Link } from "wouter";
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import ArticleCard from "@/components/article/ArticleCard";
import { trackInternalClick } from "@/lib/journey";
import ResponsiveImage from "@/components/article/ResponsiveImage";
import {
  useListPublicArticles,
  getListPublicArticlesQueryKey,
  listPublicArticles,
  type PublicArticleSummary,
} from "@workspace/api-client-react";
import { useBeats } from "@/lib/useBeats";
import { resolveImage } from "@/lib/heroImage";
import { useSeo, getSiteOrigin, buildSiteGraph } from "@/lib/seo";

const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, "");
const PAGE_SIZE = 24;

function buildAuthorJsonLd(
  slug: string,
  name: string,
  bio: string | undefined,
  origin: string,
): Record<string, unknown> {
  const personUrl = `${origin}/author/${slug}`;
  const siteNodes = (buildSiteGraph(origin)["@graph"] as Record<string, unknown>[]);
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "ProfilePage",
        "@id": `${personUrl}#profilepage`,
        name: `${name} — BrainHook`,
        description: bio
          ? `${bio} Stories by ${name} on BrainHook.`
          : `All stories by ${name} on BrainHook.`,
        url: personUrl,
        mainEntity: {
          "@type": "Person",
          "@id": `${personUrl}#person`,
          name,
          ...(bio ? { description: bio } : {}),
          url: personUrl,
        },
        publisher: { "@id": `${origin}/#organization` },
      },
      ...siteNodes,
    ],
  };
}

export default function AuthorPage() {
  const params = useParams();
  const authorSlug = params.author || "";
  const search = useSearch();
  const page = Math.max(1, parseInt(new URLSearchParams(search).get("page") ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  // First page: the author's most-recent published stories, newest first.
  const { data, isLoading } = useListPublicArticles(
    { author: authorSlug, order: "recent", limit: PAGE_SIZE, offset },
    {
      query: {
        enabled: Boolean(authorSlug),
        queryKey: getListPublicArticlesQueryKey({
          author: authorSlug,
          order: "recent",
          limit: PAGE_SIZE,
          offset,
        }),
      },
    },
  );
  const firstItems = data?.items ?? [];

  // Subsequent pages loaded on demand via "Load more", paging past the current
  // page in stable newest-first order so loading more never reshuffles what's
  // already shown.
  const [olderItems, setOlderItems] = useState<PublicArticleSummary[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);

  useEffect(() => {
    setOlderItems([]);
    setLoadingMore(false);
    setReachedEnd(false);
  }, [authorSlug, page]);

  const items = useMemo(() => {
    const seen = new Set(firstItems.map((a) => a.id));
    const merged = [...firstItems];
    for (const a of olderItems) {
      if (!seen.has(a.id)) {
        seen.add(a.id);
        merged.push(a);
      }
    }
    return merged;
  }, [firstItems, olderItems]);

  async function loadMore() {
    if (loadingMore || reachedEnd || !authorSlug) return;
    setLoadingMore(true);
    try {
      const res = await listPublicArticles({
        author: authorSlug,
        order: "recent",
        offset: offset + PAGE_SIZE + olderItems.length,
        limit: PAGE_SIZE,
      });
      const batch = res.items ?? [];
      setOlderItems((prev) => [...prev, ...batch]);
      if (batch.length < PAGE_SIZE) setReachedEnd(true);
    } catch {
      // Swallow: leave the button so the reader can retry.
    } finally {
      setLoadingMore(false);
    }
  }

  const canLoadMore = firstItems.length >= PAGE_SIZE && !reachedEnd;

  const authorName = items[0]?.author.name ?? authorSlug;
  const authorBio = items[0]?.author.bio;
  const authorAvatar = items[0]?.author.avatarUrl;
  const categorySlug = items[0]?.author.categorySlug;

  const { beats } = useBeats();
  const beat = beats.find((b) => b.slug === categorySlug);
  const heroSrc = beat?.heroImageUrl
    ? resolveImage(beat.heroImageUrl)
    : categorySlug
      ? `${baseUrl}/category-heroes/${categorySlug}.jpg`
      : "";

  // A loaded-but-empty author page is a thin page: noindex it so unknown/empty
  // author URLs don't enter the index. Only flips after a successful load so a
  // transient fetch error never stamps noindex onto a real page.
  const isEmptyAuthor = data !== undefined && firstItems.length === 0;

  const origin = getSiteOrigin();
  const jsonLd =
    !isEmptyAuthor && firstItems.length > 0
      ? buildAuthorJsonLd(authorSlug, authorName, authorBio, origin)
      : undefined;

  useSeo({
    title: `${authorName} — BrainHook`,
    description: `All stories by ${authorName} on BrainHook.`,
    canonicalPath: page > 1 ? `/author/${authorSlug}?page=${page}` : `/author/${authorSlug}`,
    type: "website",
    noindex: isEmptyAuthor,
    jsonLd,
  });

  const prevHref =
    page > 1
      ? page === 2
        ? `/author/${authorSlug}`
        : `/author/${authorSlug}?page=${page - 1}`
      : null;
  // nextHref is always derived from the stable ?page=N URL — it's a crawlable
  // link to the next archive page regardless of whether "Load more" is shown.
  const nextHref = firstItems.length >= PAGE_SIZE ? `/author/${authorSlug}?page=${page + 1}` : null;

  return (
    <div className="pb-24">
      <header className="relative overflow-hidden text-center" style={{ minHeight: 420 }}>
        {/* Hero image — blurred + dimmed, same treatment as article pages */}
        <div className="absolute inset-0 pointer-events-none">
          {heroSrc && (
            <ResponsiveImage
              key={heroSrc}
              src={heroSrc}
              alt=""
              ariaHidden
              priority
              hideOnError
              widths={[768, 1280, 1600]}
              sizes="100vw"
              width={1600}
              height={900}
              className="w-full h-full object-cover animate-in fade-in duration-300"
              style={{ filter: "brightness(0.48) blur(1px)", transform: "scale(1.04)", transformOrigin: "center" } as React.CSSProperties}
            />
          )}
        </div>
        {/* Scrim */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: "linear-gradient(to bottom, rgba(13,13,16,0.35) 0%, rgba(13,13,16,0.60) 85%, rgba(13,13,16,0.85) 100%)" }}
        />
        <div className="relative z-10 container mx-auto px-4 py-16 md:py-24 flex flex-col items-center text-center gap-5 max-md:pl-[38px]">
          {/* Avatar */}
          {authorAvatar ? (
            <img
              src={resolveImage(authorAvatar)}
              alt={authorName}
              width={80}
              height={80}
              className="h-20 w-20 rounded-full object-cover ring-2 ring-primary ring-offset-4 ring-offset-black/60 mx-auto"
            />
          ) : authorName !== authorSlug ? (
            <div className="h-20 w-20 rounded-full bg-primary/20 ring-2 ring-primary ring-offset-4 ring-offset-black/60 flex items-center justify-center font-serif font-bold text-3xl text-primary mx-auto">
              {authorName.charAt(0)}
            </div>
          ) : null}

          <span className="inline-block text-xs font-bold uppercase tracking-widest text-primary border border-primary/40 rounded-full px-4 py-1.5">
            All stories by
          </span>

          <motion.h1
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="font-serif text-4xl md:text-5xl lg:text-6xl font-bold text-foreground leading-tight"
          >
            {authorName}
          </motion.h1>

          {beat && (
            <Link
              href={`/category/${beat.slug}`}
              className="inline-flex items-center gap-2 text-sm text-primary/80 hover:text-primary transition-colors font-medium tracking-wide"
            >
              <span className="w-5 h-px bg-primary/50 inline-block" />
              {beat.name}
              <span className="w-5 h-px bg-primary/50 inline-block" />
            </Link>
          )}

          {authorBio && (
            <>
              <div className="w-10 h-px bg-primary/40 mx-auto" />
              <p className="text-foreground/80 max-w-xl text-base md:text-lg leading-relaxed">
                {authorBio}
              </p>
            </>
          )}
        </div>
      </header>

      <section className="container mx-auto px-4 py-16">
        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-x-5 gap-y-6 sm:gap-y-10">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-64 bg-muted animate-pulse rounded" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="text-center text-muted-foreground">No published stories yet.</p>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-x-5 gap-y-6 sm:gap-y-10">
              {items.map((article, i) => (
                <motion.div
                  key={article.id}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, delay: (i % 5) * 0.1 }}
                >
                  <ArticleCard
                    article={article}
                    onSelect={() => trackInternalClick({ toSlug: article.slug, placement: "author_page" })}
                  />
                </motion.div>
              ))}
            </div>

            {/* Crawlable pagination links — always rendered as <a> when a
                previous or next page exists, so bots can follow the full
                archive without executing JS. The "Load more" button below is
                a progressive-enhancement layer on top of these links. */}
            {(prevHref || nextHref) && (
              <nav className="flex justify-center gap-4 mt-10" aria-label="Pagination">
                {prevHref && (
                  <a
                    href={prevHref}
                    className="inline-flex items-center justify-center rounded-full border border-border bg-background px-8 py-3 text-sm font-medium transition-colors hover:bg-muted"
                  >
                    ← Newer stories
                  </a>
                )}
                {nextHref && (
                  <a
                    href={nextHref}
                    className="inline-flex items-center justify-center rounded-full border border-border bg-background px-8 py-3 text-sm font-medium transition-colors hover:bg-muted"
                  >
                    Older stories →
                  </a>
                )}
              </nav>
            )}

            {canLoadMore && (
              <div className="flex justify-center mt-6">
                <button
                  type="button"
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="inline-flex items-center justify-center rounded-full border border-border bg-background px-8 py-3 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {loadingMore ? "Loading…" : "Load more stories"}
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

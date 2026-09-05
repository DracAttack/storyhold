import { useParams, useSearch } from "wouter";
import { useEffect, useMemo, useState } from "react";
import ArticleCard from "@/components/article/ArticleCard";
import { trackInternalClick } from "@/lib/journey";
import ResponsiveImage from "@/components/article/ResponsiveImage";
import { motion } from "framer-motion";
import {
  listPublicArticles,
  useListPublicArticles,
  getListPublicArticlesQueryKey,
  type PublicArticleSummary,
} from "@workspace/api-client-react";
import { useBeats } from "@/lib/useBeats";
import { resolveImage } from "@/lib/heroImage";
import { useSeo, getSiteOrigin, buildSiteGraph } from "@/lib/seo";
import { resolveSeoDescription } from "@/lib/seoText";

const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, "");
const PAGE_SIZE = 24;

function humanizeSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function buildCategoryJsonLd(
  slug: string,
  name: string,
  description: string,
  items: PublicArticleSummary[],
  origin: string,
): Record<string, unknown> {
  const pageUrl = `${origin}/category/${slug}`;
  const siteNodes = (buildSiteGraph(origin)["@graph"] as Record<string, unknown>[]);
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "CollectionPage",
        "@id": `${pageUrl}#collectionpage`,
        name: `${name} — BrainHook`,
        description,
        url: pageUrl,
        mainEntity: {
          "@type": "ItemList",
          itemListElement: items.slice(0, 10).map((a, i) => ({
            "@type": "ListItem",
            position: i + 1,
            url: `${origin}/article/${a.slug}`,
            name: a.title,
          })),
        },
        publisher: { "@id": `${origin}/#organization` },
      },
      ...siteNodes,
    ],
  };
}

export default function CategoryPage() {
  const params = useParams();
  const categorySlug = params.category || "";
  const search = useSearch();
  const page = Math.max(1, parseInt(new URLSearchParams(search).get("page") ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const { beats } = useBeats();
  const meta = beats.find((c) => c.slug === categorySlug);

  // Fetch the current archive page in newest-first order. This is consistent
  // with the SSR paginated output so bots and JS clients see the same content.
  const { data, isLoading } = useListPublicArticles(
    { category: categorySlug, order: "recent", limit: PAGE_SIZE, offset },
    {
      query: {
        enabled: Boolean(categorySlug),
        queryKey: getListPublicArticlesQueryKey({
          category: categorySlug,
          order: "recent",
          limit: PAGE_SIZE,
          offset,
        }),
      },
    },
  );
  const firstItems = data?.items ?? [];

  // Inline "Load more" loads additional stories past the current page without a
  // full navigation, for JS-enabled clients.
  const [olderItems, setOlderItems] = useState<PublicArticleSummary[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);

  useEffect(() => {
    setOlderItems([]);
    setLoadingMore(false);
    setReachedEnd(false);
  }, [categorySlug, page]);

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
    if (loadingMore || reachedEnd || !categorySlug) return;
    setLoadingMore(true);
    try {
      const res = await listPublicArticles({
        category: categorySlug,
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

  const catName = meta?.name ?? humanizeSlug(categorySlug);
  const catDescription =
    resolveSeoDescription(meta?.description, meta?.seoDescription) ??
    `Stories from our ${catName} desk on BrainHook.`;

  const isEmptyCategory = data !== undefined && firstItems.length === 0;

  const origin = getSiteOrigin();
  const jsonLd =
    !isEmptyCategory && firstItems.length > 0
      ? buildCategoryJsonLd(categorySlug, catName, catDescription, firstItems, origin)
      : undefined;

  useSeo({
    title: `${catName} — BrainHook`,
    description: catDescription,
    canonicalPath: page > 1 ? `/category/${categorySlug}?page=${page}` : `/category/${categorySlug}`,
    type: "website",
    noindex: isEmptyCategory,
    jsonLd,
  });

  const prevHref =
    page > 1
      ? page === 2
        ? `/category/${categorySlug}`
        : `/category/${categorySlug}?page=${page - 1}`
      : null;
  const nextHref =
    firstItems.length >= PAGE_SIZE ? `/category/${categorySlug}?page=${page + 1}` : null;

  const heroSrc = meta?.heroImageUrl
    ? resolveImage(meta.heroImageUrl)
    : categorySlug
      ? `${baseUrl}/category-heroes/${categorySlug}.jpg`
      : "";

  return (
    <div className="pb-24">
      <header className="relative overflow-hidden text-center" style={{ minHeight: 500 }}>
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
        <div className="relative z-10 container mx-auto px-4 py-20 md:py-28 flex flex-col items-center text-center gap-5 max-md:pl-[38px]">
          <span className="inline-block text-xs font-bold uppercase tracking-widest text-primary border border-primary/40 rounded-full px-4 py-1.5">
            Coverage Desk
          </span>

          <motion.h1
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="font-serif text-5xl md:text-6xl lg:text-7xl font-bold text-foreground leading-tight"
          >
            {catName}
          </motion.h1>

          <div className="w-10 h-px bg-primary/50 mx-auto" />

          <p className="text-foreground/80 max-w-xl text-base md:text-lg leading-relaxed">
            {meta?.description?.trim()
              ? meta.description
              : `Stories from our ${catName} desk.`}
          </p>
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
          <p className="text-center text-muted-foreground">No stories in this category yet.</p>
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
                    onSelect={() => trackInternalClick({ toSlug: article.slug, placement: "category_page" })}
                  />
                </motion.div>
              ))}
            </div>

            {/* Crawlable pagination — always rendered as <a> so bots can follow
                the full archive. The "Load more" button is a JS progressive
                enhancement layer on top. */}
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

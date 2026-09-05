import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { Search as SearchIcon } from "lucide-react";
import { motion } from "framer-motion";
import ArticleCard from "@/components/article/ArticleCard";
import { trackInternalClick } from "@/lib/journey";
import { useListPublicArticles, getListPublicArticlesQueryKey } from "@workspace/api-client-react";
import { useSeo } from "@/lib/seo";

export default function SearchPage() {
  const searchString = useSearch();
  const [, navigate] = useLocation();
  const initialQ = new URLSearchParams(searchString).get("q") ?? "";
  const [term, setTerm] = useState(initialQ);

  // Keep the input in sync when the URL query changes (e.g. header search,
  // back/forward navigation).
  useEffect(() => {
    setTerm(initialQ);
  }, [initialQ]);

  const trimmed = initialQ.trim();
  const { data, isLoading, isFetching } = useListPublicArticles(
    { q: trimmed, limit: 50 },
    {
      query: {
        enabled: trimmed.length > 0,
        queryKey: getListPublicArticlesQueryKey({ q: trimmed, limit: 50 }),
      },
    },
  );
  const items = data?.items ?? [];

  useSeo({
    title: trimmed ? `Search: ${trimmed} — BrainHook` : "Search — BrainHook",
    description: "Search BrainHook for real research with no BS.",
    canonicalPath: "/search",
    type: "website",
    noindex: true,
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const next = term.trim();
    navigate(next ? `/search?q=${encodeURIComponent(next)}` : "/search");
  }

  return (
    <div className="container mx-auto px-4 py-12 md:py-16 pb-24">
      <h1 className="font-serif text-4xl md:text-5xl font-bold mb-2">Search</h1>
      <p className="text-muted-foreground mb-6">Find a story across the BrainHook archive.</p>

      <form onSubmit={submit} className="relative max-w-xl mb-12">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground pointer-events-none" />
        <input
          type="search"
          autoFocus
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search articles…"
          aria-label="Search articles"
          className="w-full h-12 rounded-full border border-input bg-transparent pl-11 pr-28 text-base shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button
          type="submit"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex items-center justify-center rounded-full bg-primary px-5 h-9 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
        >
          Search
        </button>
      </form>

      {!trimmed ? (
        <p className="text-muted-foreground">Type a word or phrase above to search.</p>
      ) : isLoading || isFetching ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-x-5 gap-y-6 sm:gap-y-10">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-64 bg-muted animate-pulse rounded" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="text-muted-foreground">
          No stories match <strong className="text-foreground">“{trimmed}”</strong>. Try a different word.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground mb-6">
            {items.length} result{items.length === 1 ? "" : "s"} for{" "}
            <strong className="text-foreground">“{trimmed}”</strong>
          </p>
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
                  onSelect={() => trackInternalClick({ toSlug: article.slug, placement: "search" })}
                />
              </motion.div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

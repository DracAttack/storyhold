/**
 * /glossary — alphabetical index of all live concepts, letter-by-letter with
 * per-letter pagination (25 terms per page). "Popular" and "Recently added"
 * sorts show a flat paginated list instead.
 */

import { useState, useEffect } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useSeo, getSiteOrigin } from "@/lib/seo";
import { useQuery } from "@tanstack/react-query";
import { trackEvent } from "@/lib/analytics";

interface ConceptSummary {
  id: string;
  slug: string;
  term: string;
  hoverDefinition: string;
  articleCount: number;
}

type GlossarySort = "alpha" | "popular" | "recent";

const PAGE_SIZE = 25;
const ALL_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const SORT_TABS: Array<{ value: GlossarySort; label: string }> = [
  { value: "alpha", label: "A–Z" },
  { value: "popular", label: "Popular" },
  { value: "recent", label: "Recently added" },
];

async function fetchConcepts(
  params: URLSearchParams,
): Promise<{ concepts: ConceptSummary[]; total: number }> {
  const res = await fetch(`/api/public/concepts?${params}`);
  if (!res.ok) throw new Error("Failed to fetch glossary");
  return res.json();
}

/** Compact pagination button list with ellipsis for long ranges. */
function pageNumbers(total: number, current: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | "…")[] = [];
  if (current <= 4) {
    for (let i = 1; i <= Math.min(5, total); i++) pages.push(i);
    pages.push("…");
    pages.push(total);
  } else if (current >= total - 3) {
    pages.push(1);
    pages.push("…");
    for (let i = Math.max(total - 4, 2); i <= total; i++) pages.push(i);
  } else {
    pages.push(1);
    pages.push("…");
    for (let i = current - 1; i <= current + 1; i++) pages.push(i);
    pages.push("…");
    pages.push(total);
  }
  return pages;
}

export default function GlossaryIndex() {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [, navigate] = useLocation();
  const searchString = useSearch();

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Derive all view state from URL so the page is bookmarkable / shareable.
  const urlParams = new URLSearchParams(searchString);
  const activeLetter = (urlParams.get("letter") ?? "A").toUpperCase().slice(0, 1);
  const sort = (urlParams.get("sort") as GlossarySort | null) ?? "alpha";
  // In search mode page is always 1 (debounced query drives the lookup,
  // not the URL, so we don't want a stale page offset from a prior letter view).
  const isSearching = debouncedQ.length >= 2;
  const urlPage = Math.max(1, Number(urlParams.get("page") ?? "1"));
  const page = isSearching ? 1 : urlPage;
  const isAlpha = sort === "alpha" && !isSearching;

  function goToLetter(l: string) {
    navigate(`/glossary?letter=${l}&sort=alpha`);
  }
  function goToPage(p: number) {
    const np = new URLSearchParams(searchString);
    np.set("page", String(p));
    navigate(`/glossary?${np.toString()}`);
  }
  function setSort(s: GlossarySort) {
    if (s === "alpha") {
      navigate(`/glossary?letter=${activeLetter}&sort=alpha`);
    } else {
      navigate(`/glossary?sort=${s}`);
    }
    trackEvent("glossary_sort", { method: s, content_type: "glossary_index" });
  }

  // Build the API query params from current view state.
  const queryParams = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String((page - 1) * PAGE_SIZE),
  });
  if (isSearching) {
    queryParams.set("q", debouncedQ);
  } else if (isAlpha) {
    queryParams.set("letter", activeLetter);
  } else {
    queryParams.set("sort", sort);
  }

  const queryKey = isSearching
    ? ["glossary-search", debouncedQ, page]
    : isAlpha
      ? ["glossary-letter", activeLetter, page]
      : ["glossary-sort", sort, page];

  const { data, isLoading, isError } = useQuery<{
    concepts: ConceptSummary[];
    total: number;
  }>({
    queryKey,
    queryFn: () => fetchConcepts(queryParams),
    staleTime: 5 * 60 * 1000,
  });

  const concepts = data?.concepts ?? [];
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  const origin = getSiteOrigin();
  useSeo({
    title: isAlpha
      ? `Glossary: ${activeLetter} — BrainHook`
      : "Glossary — BrainHook",
    description:
      "Plain-English definitions of scientific, technical, and domain-specific terms used in BrainHook articles.",
    noindex: false,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "DefinedTermSet",
      name: "BrainHook Glossary",
      url: `${origin}/glossary`,
      hasDefinedTerm: concepts.map((c) => ({
        "@type": "DefinedTerm",
        name: c.term,
        description: c.hoverDefinition,
        url: `${origin}/glossary/${c.slug}`,
      })),
    },
  });

  useEffect(() => {
    trackEvent("glossary_view", { content_type: "glossary_index" });
  }, []);

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10 max-md:pl-[38px]">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight mb-2">Glossary</h1>
        <p className="text-muted-foreground text-base">
          Plain-English definitions of terms you may encounter in BrainHook articles.
        </p>
      </div>

      {/* Search */}
      <div className="mb-6">
        <input
          type="search"
          placeholder="Search terms…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-full max-w-sm rounded-lg border border-input bg-background px-4 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      {/* Sort tabs — hidden while searching (search mode is always flat+ranked) */}
      {!isSearching && (
        <div className="flex gap-1.5 mb-6" role="tablist" aria-label="Sort glossary">
          {SORT_TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={sort === t.value}
              onClick={() => setSort(t.value)}
              className={[
                "px-3 py-1.5 rounded-full text-xs font-semibold transition-colors",
                sort === t.value
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-secondary-foreground hover:bg-secondary/70",
              ].join(" ")}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* Letter navigation — A–Z mode only */}
      {isAlpha && (
        <nav
          className="flex flex-wrap gap-1 mb-8"
          aria-label="Browse by letter"
        >
          {ALL_LETTERS.map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => goToLetter(l)}
              aria-current={l === activeLetter ? "page" : undefined}
              className={[
                "h-7 w-7 flex items-center justify-center rounded text-xs font-semibold transition-colors",
                l === activeLetter
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-secondary-foreground hover:bg-primary hover:text-primary-foreground",
              ].join(" ")}
            >
              {l}
            </button>
          ))}
        </nav>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="py-20 text-center text-muted-foreground text-sm animate-pulse">
          Loading…
        </div>
      )}

      {/* Error */}
      {isError && (
        <div className="py-20 text-center text-muted-foreground text-sm">
          Could not load the glossary. Please try again later.
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !isError && concepts.length === 0 && (
        <div className="py-20 text-center text-muted-foreground text-sm">
          {isSearching
            ? `No terms found matching "${debouncedQ}".`
            : isAlpha
              ? `No glossary terms starting with "${activeLetter}".`
              : "No glossary terms yet."}
        </div>
      )}

      {/* Section heading for letter mode */}
      {isAlpha && !isLoading && concepts.length > 0 && (
        <div className="border-b border-border pb-1 mb-4">
          <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
            {activeLetter}
            {" — "}
            {data!.total} {data!.total === 1 ? "term" : "terms"}
            {totalPages > 1 ? `, page ${page} of ${totalPages}` : ""}
          </h2>
        </div>
      )}

      {/* Term list */}
      {!isLoading && !isError && concepts.length > 0 && (
        <ul className="space-y-2 mb-8">
          {concepts.map((t) => (
            <li key={t.id}>
              <Link
                href={`/glossary/${t.slug}`}
                className="group flex items-baseline gap-2"
              >
                <span className="font-semibold text-foreground group-hover:text-primary transition-colors">
                  {t.term}
                </span>
                <span className="text-sm text-muted-foreground line-clamp-1 flex-1 min-w-0">
                  — {t.hoverDefinition}
                </span>
                {t.articleCount > 0 && (
                  <span className="text-xs text-muted-foreground/60 shrink-0">
                    {t.articleCount}{" "}
                    {t.articleCount === 1 ? "article" : "articles"}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {/* Pagination */}
      {!isLoading && !isError && totalPages > 1 && (
        <nav
          className="flex items-center justify-center gap-1"
          aria-label="Pagination"
        >
          <button
            type="button"
            onClick={() => goToPage(page - 1)}
            disabled={page === 1}
            aria-label="Previous page"
            className="h-8 w-8 flex items-center justify-center rounded text-sm text-muted-foreground hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>

          {pageNumbers(totalPages, page).map((p, i) =>
            p === "…" ? (
              <span
                key={`ellipsis-${i}`}
                className="h-8 w-8 flex items-center justify-center text-sm text-muted-foreground"
              >
                …
              </span>
            ) : (
              <button
                key={p}
                type="button"
                onClick={() => goToPage(p)}
                aria-current={p === page ? "page" : undefined}
                className={[
                  "h-8 min-w-[2rem] px-1 flex items-center justify-center rounded text-sm font-medium transition-colors",
                  p === page
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-secondary",
                ].join(" ")}
              >
                {p}
              </button>
            ),
          )}

          <button
            type="button"
            onClick={() => goToPage(page + 1)}
            disabled={page === totalPages}
            aria-label="Next page"
            className="h-8 w-8 flex items-center justify-center rounded text-sm text-muted-foreground hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </nav>
      )}
    </div>
  );
}

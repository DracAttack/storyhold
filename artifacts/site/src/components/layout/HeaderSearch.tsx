import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Search, X, Loader2, BookOpen } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { trackInternalClick } from "@/lib/journey";
import { useListPublicArticles, getListPublicArticlesQueryKey } from "@workspace/api-client-react";

interface ConceptResult {
  id: string;
  slug: string;
  term: string;
  hoverDefinition: string;
  articleCount: number;
}

/**
 * Score a piece of text against a query for relevance ranking.
 * Returns 4 (exact) → 3 (starts with) → 2 (word starts with) → 1 (contains).
 */
function relevanceScore(text: string, query: string): number {
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (t === q) return 4;
  if (t.startsWith(q)) return 3;
  if (t.split(/[\s\-–—,()]+/).some((w) => w.startsWith(q))) return 2;
  return 1;
}

/**
 * Inline, real-time header search. Returns both articles and glossary terms in
 * a single dropdown, sorted so the closest match surfaces first within each
 * section. Clicking a result navigates to that article or glossary page.
 */
export default function HeaderSearch() {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [debounced, setDebounced] = useState("");
  const [, navigate] = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Debounce typing so we don't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(term.trim()), 250);
    return () => clearTimeout(t);
  }, [term]);

  const query = debounced.length >= 2 ? debounced : "";

  // Articles search (generated hook).
  const { data: articleData, isFetching: articlesFetching } = useListPublicArticles(
    { q: query, limit: 6 },
    {
      query: {
        enabled: query.length > 0,
        queryKey: getListPublicArticlesQueryKey({ q: query, limit: 6 }),
        staleTime: 30_000,
      },
    },
  );

  // Concepts / glossary search (raw fetch — no generated hook for this endpoint).
  const { data: conceptData, isFetching: conceptsFetching } = useQuery<{
    concepts: ConceptResult[];
    total: number;
  }>({
    queryKey: ["header-search-concepts", query],
    queryFn: async () => {
      const res = await fetch(
        `/api/public/concepts?q=${encodeURIComponent(query)}&limit=5`,
      );
      if (!res.ok) throw new Error("Failed to search glossary");
      return res.json();
    },
    enabled: query.length > 0,
    staleTime: 30_000,
  });

  const isFetching = articlesFetching || conceptsFetching;

  // Sort each result set by relevance score so the best match leads.
  const rawArticles = query.length > 0 ? (articleData?.items ?? []) : [];
  const rawConcepts = query.length > 0 ? (conceptData?.concepts ?? []) : [];

  const articles = [...rawArticles].sort(
    (a, b) => relevanceScore(b.title, query) - relevanceScore(a.title, query),
  );
  const concepts = [...rawConcepts].sort(
    (a, b) => relevanceScore(b.term, query) - relevanceScore(a.term, query),
  );

  const hasResults = articles.length > 0 || concepts.length > 0;

  // Focus the input when the bar slides open.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 60);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open]);

  // Close on Escape and on click outside the search area.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node))
        setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  function close() {
    setOpen(false);
    setTerm("");
    setDebounced("");
  }

  function goToArticle(slug: string) {
    trackInternalClick({ toSlug: slug, placement: "search" });
    close();
    navigate(`/article/${slug}`);
  }

  function goToConcept(slug: string) {
    close();
    navigate(`/glossary/${slug}`);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        className="inline-flex items-center justify-center h-9 w-9 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        title="Search"
        aria-label={open ? "Close search" : "Search articles and glossary"}
        aria-expanded={open}
        aria-controls="header-search-panel"
      >
        {open ? <X className="h-5 w-5" /> : <Search className="h-5 w-5" />}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            id="header-search-panel"
            ref={panelRef}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="absolute left-0 right-0 top-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 shadow-lg overflow-hidden"
          >
            <div className="container mx-auto px-4 py-3">
              <div className="relative max-w-xl mx-auto">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                <input
                  ref={inputRef}
                  type="search"
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                  placeholder="Search articles and glossary…"
                  aria-label="Search articles and glossary"
                  className="w-full h-11 rounded-full border border-input bg-background pl-10 pr-10 text-base shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                {isFetching && (
                  <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
                )}
              </div>

              {query.length > 0 && (
                <div className="max-w-xl mx-auto mt-2 pb-1 max-h-[60vh] overflow-y-auto">
                  {!hasResults && !isFetching && (
                    <p className="px-3 py-3 text-sm text-muted-foreground">
                      No results for{" "}
                      <strong className="text-foreground">"{query}"</strong>.
                    </p>
                  )}

                  {/* Articles section */}
                  {articles.length > 0 && (
                    <>
                      {concepts.length > 0 && (
                        <p className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                          Articles
                        </p>
                      )}
                      <ul className="divide-y divide-border/60">
                        {articles.map((a) => (
                          <li key={a.id}>
                            <button
                              type="button"
                              onClick={() => goToArticle(a.slug)}
                              className="w-full flex items-center gap-3 px-2 py-2.5 text-left rounded-md hover:bg-muted transition-colors"
                            >
                              {a.heroImage ? (
                                <img
                                  src={`${a.heroImage}${a.heroImage.includes("?") ? "&" : "?"}w=96`}
                                  alt=""
                                  aria-hidden="true"
                                  className="h-12 w-16 shrink-0 rounded object-cover bg-muted"
                                  loading="lazy"
                                />
                              ) : null}
                              <span className="min-w-0">
                                <span className="block text-sm font-semibold leading-snug line-clamp-2">
                                  {a.title}
                                </span>
                                <span className="block text-xs text-muted-foreground mt-0.5">
                                  {a.category} · {a.readingTimeMinutes} min read
                                </span>
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}

                  {/* Glossary terms section */}
                  {concepts.length > 0 && (
                    <>
                      <p className="px-2 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                        Glossary
                      </p>
                      <ul className="divide-y divide-border/60">
                        {concepts.map((c) => (
                          <li key={c.id}>
                            <button
                              type="button"
                              onClick={() => goToConcept(c.slug)}
                              className="w-full flex items-center gap-3 px-2 py-2.5 text-left rounded-md hover:bg-muted transition-colors"
                            >
                              <span className="h-12 w-16 shrink-0 rounded bg-muted/60 flex items-center justify-center">
                                <BookOpen className="h-5 w-5 text-muted-foreground/50" />
                              </span>
                              <span className="min-w-0">
                                <span className="block text-sm font-semibold leading-snug">
                                  {c.term}
                                </span>
                                <span className="block text-xs text-muted-foreground mt-0.5 line-clamp-1">
                                  {c.hoverDefinition}
                                </span>
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

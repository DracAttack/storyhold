import { Link } from "wouter";
import { motion } from "framer-motion";
import { Clock } from "lucide-react";
import type { PublicArticleSummary } from "@workspace/api-client-react";
import ResponsiveImage from "@/components/article/ResponsiveImage";
import AdminEditLink from "@/components/article/AdminEditLink";
import { toArticleTitleCase } from "@/lib/utils";

function DevelopingBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-amber-400 border border-amber-400/40 rounded-full px-2 py-0.5 leading-none"
      style={{ fontFamily: "'JetBrains Mono', monospace" }}
    >
      <span className="relative flex h-1.5 w-1.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-400" />
      </span>
      Update
    </span>
  );
}

export default function ArticleCard({
  article,
  featured = false,
  priority = false,
  onSelect,
}: {
  article: PublicArticleSummary;
  featured?: boolean;
  /** Above-the-fold card (e.g. home hero): load its image eagerly. */
  priority?: boolean;
  /**
   * Fired (best-effort) when the reader activates THIS card's article link
   * (image or headline) — used for anonymous internal-click tracking. NOT fired
   * for the card's category/author links. Never affects navigation.
   */
  onSelect?: () => void;
}) {
  if (featured) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6 }}
        className="relative overflow-hidden"
        style={{ height: "520px" }}
      >
        {/* Full-bleed hero image */}
        <Link href={`/article/${article.slug}`} onClick={onSelect} className="absolute inset-0 block">
          <ResponsiveImage
            src={article.heroImage}
            alt={article.title}
            widths={[800, 1200, 1600]}
            sizes="100vw"
            width={1600}
            height={900}
            priority={priority}
            className="w-full h-full object-cover"
            style={{ filter: "brightness(0.48) blur(1px)" } as React.CSSProperties}
          />
        </Link>

        {/* Bottom gradient scrim */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: "linear-gradient(to top, hsl(var(--background)) 0%, transparent 60%)" }}
        />

        {/* Overlay content layer — shifted right on desktop so the fixed
            chevron pill (34px at left-0, z-40) doesn't cover the spine text.
            The hero image stays full-bleed; only text/chrome moves. */}
        <div className="absolute inset-0 z-10 md:left-[44px]">
          {/* Vertical category spine — B Ink signature element */}
          <div
            className="absolute left-0 top-0 bottom-0 flex items-center justify-center max-md:justify-end max-md:pr-1"
            style={{ width: 48, borderRight: "1px solid rgba(245,168,78,0.25)" }}
          >
            <Link
              href={`/category/${article.categorySlug}`}
              className="bh-hero-spine text-primary hover:text-primary/80 transition-colors"
              aria-label={`Category: ${article.category}`}
            >
              {article.category}
            </Link>
          </div>

          {/* Glass info panel — headline + meta only (no body text on glass) */}
          <div
            className="bh-hero-panel absolute"
            style={{ bottom: 40, left: 64, width: "fit-content", maxWidth: "min(680px, calc(100% - 120px))", padding: "28px 32px 24px" }}
          >
          {/* Eyebrow */}
          <div className="flex items-center gap-3 mb-4">
            <div
              className="text-primary"
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10,
                fontWeight: 500,
                letterSpacing: "2px",
                textTransform: "uppercase",
                borderBottom: "1px solid rgba(245,168,78,0.35)",
                paddingBottom: 4,
              }}
            >
              Featured
            </div>
            {article.articleKind === "update" && <DevelopingBadge />}
          </div>

          {/* Headline — smaller to leave room for dek */}
          <Link href={`/article/${article.slug}`} onClick={onSelect} className="block group">
            <h1
              className="font-serif font-bold text-foreground leading-tight mb-0 group-hover:text-primary transition-colors"
              style={{ fontSize: "clamp(24px, 3vw, 38px)", lineHeight: 1.08, letterSpacing: "-0.02em", maxWidth: 820 }}
            >
              {toArticleTitleCase(article.title)}
            </h1>
          </Link>

          {/* Dek — lead-in blurb */}
          {article.dek && (
            <p
              className="text-foreground/80 leading-relaxed mt-3 line-clamp-2"
              style={{ fontFamily: "'Lato', sans-serif", fontSize: "clamp(13px, 1.1vw, 15px)" }}
            >
              {article.dek}
            </p>
          )}

          {/* Meta row — 600w on glass ✓ */}
          <div
            className="flex items-center gap-3 mt-4 pt-4 text-muted-foreground"
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              fontWeight: 500,
              borderTop: "1px solid rgba(245,168,78,0.12)",
            }}
          >
            <Link
              href={`/author/${article.author.slug}`}
              className="hover:text-primary transition-colors"
            >
              {article.author.name}
            </Link>
            <span className="text-border">·</span>
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" /> {article.readingTimeMinutes} min
            </span>
            <AdminEditLink articleId={article.id} />
            <Link
              href={`/article/${article.slug}`}
              onClick={onSelect}
              className="ml-auto text-primary font-bold uppercase hover:text-foreground transition-colors"
              style={{ letterSpacing: "0.10em", fontSize: 11 }}
            >
              Read →
            </Link>
          </div>
        </div>
      </div>
      </motion.div>
    );
  }

  return (
    <motion.div className="group flex flex-row gap-4 sm:flex-col sm:gap-0 h-full">
      <Link
        href={`/article/${article.slug}`}
        onClick={onSelect}
        className="block shrink-0 w-28 aspect-[4/3] sm:w-auto sm:mb-3 overflow-hidden"
      >
        <ResponsiveImage
          src={article.heroImage}
          alt={article.title}
          widths={[200, 400, 600]}
          sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 112px"
          width={800}
          height={600}
          priority={priority}
          className="object-cover w-full h-full transition-transform duration-500 group-hover:scale-105"
          style={{ filter: "brightness(0.75)" } as React.CSSProperties}
        />
      </Link>
      <div className="flex flex-col min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-1.5">
          <Link
            href={`/category/${article.categorySlug}`}
            className="text-[11px] sm:text-xs font-bold uppercase tracking-wider text-primary hover:text-primary/80"
            style={{ fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1.5px" }}
          >
            {article.category}
          </Link>
          {article.articleKind === "update" && <DevelopingBadge />}
        </div>
        <Link href={`/article/${article.slug}`} onClick={onSelect} className="block group-hover:text-primary transition-colors">
          <h3 className="font-serif text-base sm:text-lg font-bold leading-snug line-clamp-3 sm:line-clamp-2">{toArticleTitleCase(article.title)}</h3>
        </Link>
        <p className="hidden sm:block text-foreground/85 text-sm leading-relaxed mt-2 mb-4 line-clamp-2 flex-grow">{article.dek}</p>
        <div className="flex items-center justify-between gap-2 mt-1.5 sm:mt-auto sm:pt-3 sm:border-t sm:border-border">
          <Link
            href={`/author/${article.author.slug}`}
            className="text-xs font-medium truncate hover:text-primary transition-colors"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            {article.author.name}
          </Link>
          <span className="text-muted-foreground text-xs flex items-center gap-1 shrink-0" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            <Clock className="h-3 w-3" /> {article.readingTimeMinutes} min
            <AdminEditLink articleId={article.id} className="text-xs" />
          </span>
        </div>
      </div>
    </motion.div>
  );
}

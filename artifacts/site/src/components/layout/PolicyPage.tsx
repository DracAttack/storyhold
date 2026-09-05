import { motion } from "framer-motion";
import type { ReactNode } from "react";

interface PolicyPageProps {
  eyebrow: string;
  title: ReactNode;
  intro?: ReactNode;
  /** Optional human-readable last-updated label, e.g. "June 2026". */
  updated?: string;
  children: ReactNode;
}

/**
 * Shared shell for trust/policy pages (Privacy, Terms, Editorial, Corrections,
 * Contact). Mirrors the About page's hero + prose treatment so the whole set
 * shares one visual language.
 */
export default function PolicyPage({ eyebrow, title, intro, updated, children }: PolicyPageProps) {
  return (
    <div className="pb-24">
      <header className="bg-primary text-primary-foreground py-16 md:py-24">
        <div className="container mx-auto px-4 text-center max-w-4xl relative">
          <div
            className="absolute inset-0 opacity-10 pointer-events-none"
            style={{
              backgroundImage:
                "radial-gradient(circle at 2px 2px, currentColor 1px, transparent 0)",
              backgroundSize: "24px 24px",
            }}
          ></div>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <span className="text-sm font-bold uppercase tracking-widest mb-6 block text-primary-foreground/80">
              {eyebrow}
            </span>
            <h1 className="font-serif text-4xl md:text-6xl font-bold leading-tight mb-6">{title}</h1>
            {intro && (
              <p className="text-lg md:text-xl font-body leading-relaxed text-primary-foreground/90 max-w-2xl mx-auto">
                {intro}
              </p>
            )}
          </motion.div>
        </div>
      </header>

      <section className="container mx-auto px-4 py-16 max-w-3xl">
        <article className="prose prose-lg dark:prose-invert prose-primary mx-auto prose-headings:font-serif">
          {updated && (
            <p className="text-sm text-muted-foreground !mt-0">Last updated: {updated}</p>
          )}
          {children}
        </article>
      </section>
    </div>
  );
}

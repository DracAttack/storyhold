import { format } from "date-fns";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import type {
  PublicArticleEditorial,
  PublicArticleReference,
} from "@workspace/api-client-react";

// "How this article was produced" — the editorial fingerprint box shown at the
// bottom of every article. Everything here is derived deterministically
// server-side (no AI): the work-type label, the fact-check timestamp where an
// automated verification report exists (falling back to the article's
// last-updated date), and the deduplicated external references list, which is
// folded directly into this box. External links are nofollow'd, matching the
// in-body citation link policy.

// Display names for the editorial work-type labels. "Original reporting" and
// "Commentary" exist in the contract for future manual designation but are
// never auto-derived today.
const LABEL_TEXT: Record<PublicArticleEditorial["label"], string> = {
  original_reporting: "Original reporting",
  research_synthesis: "Research synthesis",
  analysis: "Analysis",
  explainer: "Explainer",
  commentary: "Commentary",
};

// One-line explanation of what each work type means, so the label is a claim
// the reader can evaluate rather than jargon.
const LABEL_DESCRIPTION: Record<PublicArticleEditorial["label"], string> = {
  original_reporting: "Introduces information BrainHook obtained firsthand.",
  research_synthesis: "Connects findings from multiple published sources into one explanation.",
  analysis: "Interprets existing published research and explains what it means.",
  explainer: "Makes a complex subject understandable using established knowledge.",
  commentary: "Presents an argument or viewpoint based on known facts.",
};

export default function EditorialTrustBox({
  editorial,
  references,
}: {
  editorial: PublicArticleEditorial;
  references: PublicArticleReference[];
}) {
  const dateLine = editorial.factCheckedAt
    ? `Last fact-checked ${format(new Date(editorial.factCheckedAt), "MMMM d, yyyy")}`
    : `Last updated ${format(new Date(editorial.updatedAt), "MMMM d, yyyy")}`;
  return (
    <aside
      id="references"
      aria-label="How this article was produced"
      className="not-prose mt-16 scroll-mt-24 rounded-lg border border-border bg-muted/40 px-5 py-4 text-sm"
    >
      <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-2.5">
        How this article was produced
      </p>
      {editorial.retractionNotice && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-50/60 px-3 py-2.5 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
          <p className="text-xs leading-relaxed">
            <span className="font-semibold">Source notice:</span>{" "}
            One or more sources cited in this article have been marked retracted, unavailable, or
            superseded. Our editorial team is reviewing the evidence base. We will update or annotate
            the article once the review is complete.
          </p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 px-3 py-0.5 text-[11px] font-bold uppercase tracking-widest text-primary">
          <ShieldCheck className="h-3.5 w-3.5" />
          {LABEL_TEXT[editorial.label]}
        </span>
        <span className="text-muted-foreground">{dateLine}</span>
      </div>
      <p className="mt-2 leading-relaxed text-muted-foreground">
        {LABEL_DESCRIPTION[editorial.label]}
      </p>
      {references.length > 0 && (
        <div className="mt-4 border-t border-border pt-4">
          <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
            References
          </p>
          <ol className="list-decimal space-y-2.5 pl-5 marker:text-muted-foreground">
            {references.map((ref, i) => {
              // Bibliography sub-line: "Author/org · Publisher · Date" — only
              // the pieces we actually know, never anchor text or guesses.
              const metaParts = [
                ref.authors,
                ref.publisher,
                ref.publishedAt ? format(new Date(ref.publishedAt), "MMMM d, yyyy") : null,
              ].filter((part): part is string => !!part);
              const isDownload = /\.pdf($|[?#])|\/article\/download\/|\.(docx?|xlsx?|pptx?|odt|ods|odp)($|[?#])/i.test(ref.url);
              const isBackgroundRef = ref.tier === "reference";
              return (
                <li key={ref.url} id={`ref-${i + 1}`} className="break-words scroll-mt-24">
                  <a
                    href={ref.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="font-medium text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
                  >
                    {ref.name}
                  </a>
                  <div className="text-xs leading-relaxed text-muted-foreground">
                    {metaParts.length > 0 && <span>{metaParts.join(" · ")}</span>}
                    {metaParts.length > 0 && <span> — </span>}
                    <span className="opacity-70">{ref.domain}</span>
                    {isBackgroundRef && (
                      <span className="ml-1.5 rounded border border-amber-400/60 bg-amber-50 px-1 py-px text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-500/40">
                        Background reference
                      </span>
                    )}
                    {isDownload && (
                      <span className="ml-1.5 rounded border border-border px-1 py-px text-[10px] font-medium uppercase tracking-wide opacity-80">
                        Download
                      </span>
                    )}
                  </div>
                  {ref.note ? (
                    <p className="mt-0.5 text-xs italic leading-relaxed text-muted-foreground/80">
                      {ref.note}
                    </p>
                  ) : null}
                  {isDownload && (
                    <p className="mt-0.5 text-[10px] italic leading-snug text-muted-foreground/60">
                      Third-party file — BrainHook does not own, create, or control this document. It is provided as a research reference only and does not represent our views or opinions. Download at your own risk.
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
      <p className="mt-4 leading-relaxed text-muted-foreground">
        Edited and reviewed by{" "}
        <span className="font-semibold text-foreground">BrainHook Media Editorial Desk</span>.
      </p>
    </aside>
  );
}

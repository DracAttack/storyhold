import React, { useState } from "react";
import { BookOpen, ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  dossierEvidenceCounts,
  dossierEvidenceFieldLabel,
  dossierEvidenceSourceLabel,
  dossierEvidenceStatusLabel,
} from "@/lib/dossierEvidence";
import { DOSSIER_PREVIEW_ITEMS, dossierListWindow } from "@/lib/dossierListWindow";
import type { DossierProseReview } from "@/lib/storyholdApi";

type EvidenceSources = readonly { id: string; title: string }[];
type EvidenceField = DossierProseReview["fields"][number];

function EvidenceStatus({ status }: { status: EvidenceField["status"] }) {
  return <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${status === "verified" || status === "supported" ? "border-emerald-300/20 bg-emerald-300/5 text-emerald-200" : status === "needs_attention" || status === "needs_evidence" ? "border-sky-300/25 bg-sky-300/5 text-sky-200" : "border-white/10 text-muted-foreground"}`}>
    {dossierEvidenceStatusLabel(status)}
  </span>;
}

function EvidenceSection({ field, sources }: { field: EvidenceField; sources: EvidenceSources }) {
  const [visibleCount, setVisibleCount] = useState(DOSSIER_PREVIEW_ITEMS);
  const page = dossierListWindow(field.items, visibleCount);
  return <details className="group/section border-t border-white/8">
    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
      <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open/section:rotate-180" />
      <span className="mr-auto text-sm font-medium">{dossierEvidenceFieldLabel(field.field)}</span>
      <span className="text-[11px] text-muted-foreground">{field.reviewedItems ?? field.verifiedItems} of {field.totalItems} Reviewed</span>
      <EvidenceStatus status={field.status} />
    </summary>
    <div className="space-y-1 px-4 pb-3">
      {field.field === "relationships" ? <p className="px-3 py-2 text-xs leading-5 text-muted-foreground">These are written connection notes. Structured relationship links have their own verification.</p> : null}
      {page.visibleValues.map((item, index) => <details key={index} className="group/item rounded-lg bg-black/15">
        <summary className="flex cursor-pointer list-none items-start gap-2 px-3 py-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
          <ChevronDown aria-hidden="true" className="mt-1 h-3 w-3 shrink-0 text-muted-foreground transition-transform group-open/item:rotate-180" />
          <span className="min-w-0 flex-1 line-clamp-2 break-words text-xs leading-5 group-open/item:line-clamp-none">{item.text}</span>
          <EvidenceStatus status={item.status} />
        </summary>
        <div className="space-y-2 border-t border-white/8 px-3 py-3">
          {item.status === "author_controlled" ? <p className="text-xs leading-5 text-muted-foreground">This detail is controlled by your edits. It is not presented as a source-checked interpretation.</p> : null}
          {item.status === "not_reviewed" ? <p className="text-xs leading-5 text-muted-foreground">There is no saved item-level check for this exact wording. That does not mean it is wrong.</p> : null}
          {item.reviewBasis === "existing_text_audit" ? <p className="text-xs leading-5 text-muted-foreground">This is a review of existing wording, not a change to your canon. The text has not been deleted or rewritten.</p> : null}
          {item.explanation ? <p className="whitespace-pre-wrap break-words text-xs leading-5 text-foreground/85">{item.explanation}</p> : null}
          {item.retrievalRequests?.length ? <div className="space-y-1 text-xs leading-5 text-muted-foreground"><p className="font-medium">Worth Checking</p><ul className="list-disc space-y-1 pl-4">{item.retrievalRequests.map((request, requestIndex) => <li key={requestIndex} className="break-words">{request}</li>)}</ul></div> : null}
          {item.evidence.map((evidence, quoteIndex) => <blockquote key={quoteIndex} className="rounded-lg border-l-2 border-primary/40 bg-black/15 px-3 py-2">
            <p className="whitespace-pre-wrap break-words text-xs leading-5 text-foreground/85">{evidence.quote}</p>
            <cite className="mt-1 block text-[10px] not-italic text-muted-foreground">{dossierEvidenceSourceLabel(evidence.sourceId, sources)}</cite>
          </blockquote>)}
        </div>
      </details>)}
      {field.items.length > DOSSIER_PREVIEW_ITEMS ? <div className="flex flex-wrap items-center gap-2 pt-2">
        <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">Showing {page.shownCount} of {page.total}</span>
        {page.hasMore ? <><Button type="button" size="sm" variant="outline" onClick={() => setVisibleCount(page.nextCount)}>Show More</Button><Button type="button" size="sm" variant="ghost" onClick={() => setVisibleCount(page.total)}>Show All</Button></> : null}
        {page.shownCount > DOSSIER_PREVIEW_ITEMS ? <Button type="button" size="sm" variant="ghost" onClick={() => setVisibleCount(DOSSIER_PREVIEW_ITEMS)}>Show Fewer</Button> : null}
      </div> : null}
    </div>
  </details>;
}

export function DossierEvidence({ review, loading = false, error = false, sources = [] }: {
  review: DossierProseReview | null | undefined;
  loading?: boolean;
  error?: boolean;
  sources?: EvidenceSources;
}) {
  const counts = review ? dossierEvidenceCounts(review) : null;
  return <details className="group/evidence rounded-2xl border border-white/8 bg-white/[0.025]">
    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
      <BookOpen aria-hidden="true" className="h-4 w-4 text-primary" />
      <span className="mr-auto font-serif text-lg font-bold">Evidence by Section</span>
      {loading ? <Loader2 aria-label="Loading Evidence" className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : counts ? <span className="text-xs text-muted-foreground">{counts.reviewed} of {counts.total} Items Reviewed</span> : null}
      <ChevronDown aria-hidden="true" className="h-4 w-4 text-muted-foreground transition-transform group-open/evidence:rotate-180" />
    </summary>
    <p className="border-t border-white/8 px-4 py-3 text-xs leading-5 text-muted-foreground">See which exact dossier details have been reviewed against source passages. Not Yet Checked means there is no saved item-level check, not that the detail is wrong. Source-Supported means the passages support the existing wording; Canon-Verified means the detail was also accepted into your world's canon. Author-Controlled details reflect your edits. Relationships and abilities have separate evidence.</p>
    {loading ? <p className="px-4 pb-3 text-xs text-muted-foreground" role="status">Loading section evidence…</p> : error || !review ? <p className="px-4 pb-3 text-xs text-muted-foreground" role="status">Section evidence could not be loaded. Reopen this dossier to try again; its review status has not changed.</p> : review.fields.length ? review.fields.map((field) => <EvidenceSection key={field.field} field={field} sources={sources} />) : <p className="px-4 pb-3 text-xs text-muted-foreground">No section-level evidence information is available for this dossier yet.</p>}
  </details>;
}

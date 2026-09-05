import type { DossierCompassPerspective, DossierCompassReview, SocioPoliticalAxis } from "./storyholdApi";

export function compassPerspectiveLabel(value?: DossierCompassPerspective): string {
  return value === "demonstrated_behavior" ? "Demonstrated Conduct" : value === "self_description" ? "Self-Description"
    : value === "others_interpretation" ? "Another Character’s Interpretation" : value === "mixed" ? "Mixed Viewpoints" : "Viewpoint Not Specified";
}

export function compassEvidenceLabel(axes?: readonly string[], perspective?: DossierCompassPerspective): string {
  const dimensions = [axes?.includes("economic") ? "Economic Position" : "", axes?.includes("authority") ? "Authority and Liberty" : ""].filter(Boolean);
  return [dimensions.length ? dimensions.join(" · ") : "Compass Interpretation", perspective ? compassPerspectiveLabel(perspective) : ""].filter(Boolean).join(" · ");
}

/** Confidence alone cannot certify an interpretation. A saved author choice
 * stays visible, while missing/stale item proof leaves the old estimate intact. */
export function dossierCompassView(axis: SocioPoliticalAxis, ownerChanged: boolean, review?: DossierCompassReview | null) {
  const authorControlled = ownerChanged || review?.status === "author_controlled";
  const estimate = review?.estimate;
  const exact = Boolean(estimate && Number.isFinite(estimate.economic) && Number.isFinite(estimate.authority)
    && estimate.economic === axis.economic && estimate.authority === axis.authority
    && estimate.label === axis.label && estimate.rationale === axis.rationale);
  const sourceBacked = !authorControlled && review?.status === "supported" && exact && Boolean(review.evidence.length);
  const status = authorControlled ? "author_controlled" : sourceBacked ? "supported"
    : review?.status === "needs_attention" ? "needs_attention" : review?.status === "needs_evidence" ? "needs_evidence" : "not_reviewed";
  const label = status === "author_controlled" ? "Author-Controlled" : status === "supported" ? "Source-Backed Interpretation"
    : status === "needs_attention" ? "Needs Attention" : status === "needs_evidence" ? "Needs More Evidence" : "Unreviewed Estimate";
  const timeframe = sourceBacked && estimate ? estimate.validFromLabel && estimate.validUntilLabel
    ? `From ${estimate.validFromLabel} Until ${estimate.validUntilLabel}` : estimate.validFromLabel
      ? `From ${estimate.validFromLabel}` : estimate.validUntilLabel ? `Until ${estimate.validUntilLabel}` : "Timeframe Not Specified" : undefined;
  const perspective = sourceBacked && estimate ? [compassPerspectiveLabel(estimate.perspective),
    estimate.epistemicHolderName?.trim() || (estimate.epistemicHolderId ? "Another Character’s View" : "")].filter(Boolean).join(" · ") : undefined;
  const retainReview = !authorControlled && (sourceBacked || status === "needs_attention" || status === "needs_evidence");
  return { status, label, authorControlled, sourceBacked, timeframe, perspective,
    explanation: authorControlled ? "This compass is protected by your author controls; it is not an automatically verified conclusion."
      : retainReview ? review?.explanation : "The existing estimate is preserved, but no current source-backed review is recorded for this exact position.",
    evidence: retainReview ? review?.evidence ?? [] : [], retrievalRequests: retainReview ? review?.retrievalRequests ?? [] : [] };
}

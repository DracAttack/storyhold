import type { EntityAiReviewQuote } from "./storyholdApi";

type SearchQuote = Pick<EntityAiReviewQuote, "resume" | "executionMode" | "retrievalExpansion">;

/** Presentation only: never fetch, retry, or run a model to explain a quote. */
export function entityReviewRetrievalNotice(quote: SearchQuote | null): { heading: string; detail: string } | null {
  if (!quote || quote.resume || quote.executionMode !== "connected" || !quote.retrievalExpansion) return null;
  const report = quote.retrievalExpansion;
  const counts = [report.searchedItems, report.addedPassages, report.noMatchItems,
    report.budgetDeferredItems, report.alreadyCoveredItems, report.skippedReviews];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0) || counts.every((count) => count === 0)) return null;
  const amount = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString()} ${count === 1 ? one : many}`;
  const heading = report.addedPassages > 0
    ? `Found ${amount(report.addedPassages, "Additional Passage")} for Unresolved Details.`
    : report.alreadyCoveredItems > 0
      ? `${amount(report.alreadyCoveredItems, "Detail")} Already ${report.alreadyCoveredItems === 1 ? "Has" : "Have"} Selected Passages.`
      : report.budgetDeferredItems > 0 ? "Some Matching Passages Could Not Be Included."
        : report.searchedItems > 0 ? "No Additional Passages Found." : "Some Details Still Need a Source Search.";
  const details = ["These are search leads, not verified facts."];
  if (report.noMatchItems > 0) details.push(`No new matches for ${amount(report.noMatchItems, "detail")}; they still need checking.`);
  if (report.budgetDeferredItems > 0) details.push(`Matching passages for ${amount(report.budgetDeferredItems, "detail")} could not all be included in this review; those details still need checking.`);
  if (report.addedPassages > 0 && report.alreadyCoveredItems > 0) details.push(`${amount(report.alreadyCoveredItems, "Detail")} already ${report.alreadyCoveredItems === 1 ? "has" : "have"} passages selected.`);
  if (report.skippedReviews > 0) details.push(`${amount(report.skippedReviews, "Earlier review")} could not be used for this search.`);
  if (!report.addedPassages && !report.noMatchItems && !report.budgetDeferredItems) details.push("Unresolved details may still need more evidence.");
  return { heading, detail: details.join(" ") };
}

import type { DossierProseReview } from "./storyholdApi";

const fieldLabels: Record<string, string> = {
  aliases: "Names and Nicknames",
  summary: "Dossier Summary",
  details: "Known Facts",
  role: "Role",
  traits: "Personality",
  motivations: "Motivations",
  fears: "Fears",
  capabilities: "Capabilities",
  history: "History",
  origins: "Origins",
  powers: "Powers",
  moralSystem: "Values and Beliefs",
  physicalCharacteristics: "Appearance",
  knowledge: "Knowledge",
  secrets: "Secrets",
  relationships: "Connection Notes",
};

export function dossierEvidenceFieldLabel(field: string): string {
  return fieldLabels[field] ?? "Other Details";
}

export function dossierEvidenceStatusLabel(status: DossierProseReview["fields"][number]["status"]): string {
  return {
    verified: "Canon-Verified",
    supported: "Source-Supported",
    needs_attention: "Needs Attention",
    needs_evidence: "Needs More Evidence",
    partial: "Partly Checked",
    not_reviewed: "Not Yet Checked",
    author_controlled: "Author-Controlled",
  }[status];
}

export function dossierEvidenceCounts(review: DossierProseReview) {
  return review.fields.reduce((counts, field) => ({
    checked: counts.checked + (field.sourceCheckedItems ?? field.verifiedItems),
    reviewed: counts.reviewed + (field.reviewedItems ?? field.verifiedItems),
    total: counts.total + field.totalItems,
  }), { checked: 0, reviewed: 0, total: 0 });
}

export function dossierEvidenceSourceLabel(
  sourceId: string,
  sources: readonly { id: string; title: string }[] = [],
): string {
  return sources.find((source) => source.id === sourceId)?.title || "Source Passage";
}

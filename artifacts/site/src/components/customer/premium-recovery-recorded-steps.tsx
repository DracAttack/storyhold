import React from "react";
import { formatRecoveryCost, formatRecoveryTimestamp, type PremiumRecoveryReview } from "@/lib/premiumRecoveryApi";
import { toArticleTitleCase } from "@/lib/utils";

export const recoveryStepTitle = (stepKey: string, index: number) => {
  const kind = stepKey.split(":", 1)[0]?.toLowerCase();
  if (stepKey === "legacy:review-total") return "Entire Legacy Review";
  const labels: Record<string, string> = {
    verification: "Canon Evidence Review",
    chronology: "World Clock Review",
    graph: "Relationship Review",
    stats: "Character Ability Review",
    prose: "Dossier Review",
    claim: "Canon Claim Review",
  };
  const savedIndex = /:(\d+)$/u.exec(stepKey)?.[1];
  const sequence = savedIndex === undefined ? index + 1 : Number(savedIndex) + 1;
  return `${labels[kind] ?? "Provider Request"} ${sequence}`;
};

export const recoveryStepStatusLabel = (status: string, needsDecision: boolean) => needsDecision
  ? "Charge Verification Required"
  : ["completed", "rejected"].includes(status)
    ? "Provider Usage Recorded"
    : toArticleTitleCase(status.replaceAll("_", " "));

type RecoveryStep = PremiumRecoveryReview["steps"][number];

export const recoveryProviderDescription = (step: RecoveryStep) => step.stepKey === "legacy:review-total"
  ? "The Original Provider and Model Were Not Reliably Recorded"
  : `${step.provider || "Unrecorded Provider"} · ${step.model || "Unrecorded Model"}`;

export function PremiumRecoveryRecordedSteps({ review }: { review: PremiumRecoveryReview }) {
  const steps = review.steps.filter((step) => !step.needsDecision);
  if (steps.length === 0) return null;
  const legacy = review.recoveryMode === "legacy_total_attestation";
  return <details className="rounded-lg border p-3">
    <summary className="cursor-pointer text-sm font-medium">{legacy ? "Saved Journal Context" : "Recorded Steps"} ({steps.length})</summary>
    <p className="mt-2 text-xs text-muted-foreground">{legacy
      ? <>These surviving rows are context and known-cost evidence, not a complete per-request accounting record. Their combined known cost is a lower bound of {formatRecoveryCost(review.knownCostMicros)}. Verify the provider’s total for the entire review below.</>
      : <>Provider usage for these requests is fully recorded and cannot be edited here. Total already recorded across the run: {formatRecoveryCost(review.knownCostMicros)}.</>}</p>
    <ul className="mt-3 max-h-64 space-y-3 overflow-y-auto text-xs">
      {steps.map((step, index) => <li key={step.stepKey} className="space-y-1 break-words border-t pt-3">
        <p className="font-medium">{recoveryStepTitle(step.stepKey, index)}</p>
        <p className="text-muted-foreground">{recoveryProviderDescription(step)}</p>
        <p>{legacy ? "Saved Journal Evidence" : recoveryStepStatusLabel(step.status, step.needsDecision)} · {formatRecoveryCost(step.knownCostMicros)}</p>
        <p className="text-muted-foreground">Sent: {formatRecoveryTimestamp(step.dispatchedAt)} · Last Saved: {formatRecoveryTimestamp(step.lastRecordedAt)}</p>
        <details><summary className="cursor-pointer text-muted-foreground">Technical Reference</summary><p className="mt-1 break-all font-mono">{step.stepKey}</p></details>
      </li>)}
    </ul>
  </details>;
}

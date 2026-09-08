export type CreditUsageSummary = {
  allTimeCredits: number;
  sevenDayCredits: number;
  todayCredits: number;
  settledRequests: number;
};

export type CreditUsageEntry = {
  operation: string;
  provider: string | null;
  model: string | null;
  credits: number;
  costMicros: number;
  settledAt: string;
};

export type CreditUsageReport = {
  summary: CreditUsageSummary;
  recent: CreditUsageEntry[];
  provider: {
    summary: {
      allTimeCostMicros: number;
      sevenDayCostMicros: number;
      todayCostMicros: number;
      unchargedCostMicros: number;
      requests: number;
    };
    recent: Array<{
      operation: string;
      provider: string | null;
      model: string | null;
      costMicros: number;
      creditsCharged: number;
      occurredAt: string;
      failed: boolean;
    }>;
  };
};

function apiBase() {
  return `${(import.meta.env?.BASE_URL ?? "/").replace(/\/$/, "")}/api/storyhold`;
}

export async function getCreditUsage(signal?: AbortSignal): Promise<CreditUsageReport> {
  const response = await fetch(`${apiBase()}/admin/credit-usage`, {
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(response.status === 403
      ? "Credit usage is available to the owner and administrators only."
      : "Credit usage could not be loaded.");
  }
  return response.json() as Promise<CreditUsageReport>;
}
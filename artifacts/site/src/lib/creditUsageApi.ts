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
    filters: {
      from: string | null;
      to: string | null;
      operation: string | null;
      operations: string[];
    };
    summary: {
      allTimeCostMicros: number;
      sevenDayCostMicros: number;
      todayCostMicros: number;
      unchargedCostMicros: number;
      requests: number;
    };
    groups: Array<{
      provider: string;
      model: string;
      costMicros: number;
      completedCostMicros: number;
      failedCostMicros: number;
      requests: number;
      completedRequests: number;
      failedRequests: number;
    }>;
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

export type CreditUsageFilters = {
  from?: string;
  to?: string;
  operation?: string;
};

function apiBase() {
  return `${(import.meta.env?.BASE_URL ?? "/").replace(/\/$/, "")}/api/storyhold`;
}

export async function getCreditUsage(filters: CreditUsageFilters = {}, signal?: AbortSignal): Promise<CreditUsageReport> {
  const query = new URLSearchParams();
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  if (filters.operation) query.set("operation", filters.operation);
  const suffix = query.size ? `?${query.toString()}` : "";
  const response = await fetch(`${apiBase()}/admin/credit-usage${suffix}`, {
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
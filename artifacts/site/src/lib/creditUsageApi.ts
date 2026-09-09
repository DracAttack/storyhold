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

function creditUsageQuery(filters: CreditUsageFilters): string {
  const query = new URLSearchParams();
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  if (filters.operation) query.set("operation", filters.operation);
  return query.size ? `?${query.toString()}` : "";
}

export async function getCreditUsage(filters: CreditUsageFilters = {}, signal?: AbortSignal): Promise<CreditUsageReport> {
  const response = await fetch(`${apiBase()}/admin/credit-usage${creditUsageQuery(filters)}`, {
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

export async function getProviderCostCsv(filters: CreditUsageFilters = {}, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(`${apiBase()}/admin/credit-usage/export.csv${creditUsageQuery(filters)}`, {
    credentials: "include",
    headers: { Accept: "text/csv" },
    signal,
  });
  if (!response.ok) {
    throw new Error(response.status === 401 || response.status === 403
      ? "Provider cost exports are available to the signed-in owner and administrators only."
      : "Provider costs could not be exported. Please try again.");
  }
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/csv")) {
    throw new Error("The provider cost export was not returned. Refresh the page and try again.");
  }
  return response.blob();
}

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Coins, DollarSign, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getCreditUsage, type CreditUsageFilters, type CreditUsageReport } from "@/lib/creditUsageApi";
import { toArticleTitleCase } from "@/lib/utils";

const dollars = (micros: number) => new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
}).format(micros / 1_000_000);

const operationLabel = (value: string) => toArticleTitleCase(value.replaceAll("_", " "));

export default function CreditUsage() {
  const [report, setReport] = useState<CreditUsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<CreditUsageFilters>({});

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      setReport(await getCreditUsage(filters, signal));
    } catch (reason) {
      if (signal?.aborted) return;
      setError(reason instanceof Error ? reason.message : "Credit usage could not be loaded.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <main className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Owner Accounting</p>
            <h1 className="mt-2 font-serif text-3xl font-bold">Testing Credit Usage</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Settled Storyhold credits and provider cost exposure are reported separately. This page is never shown to players.</p>
          </div>
          <Button variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </header>

        {error ? <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">{error}</p> : null}
        {!report && loading ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading settled usage…</p> : null}
        {report ? <>
          <section>
            <h2 className="font-serif text-xl font-semibold">Settled Storyhold Credit Charges</h2>
            <p className="mt-1 text-xs text-muted-foreground">Only finalized charges. Active and released reservations are excluded.</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-3" aria-label="Settled credit charge totals">
            {[
              ["Today", report.summary.todayCredits.toLocaleString()],
              ["Last 7 Days", report.summary.sevenDayCredits.toLocaleString()],
              ["All Time", report.summary.allTimeCredits.toLocaleString()],
            ].map(([label, value]) => <Card key={label} className="p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
              <p className="mt-2 flex items-center gap-2 text-2xl font-bold"><Coins className="h-5 w-5 text-primary" /> {value}</p>
            </Card>)}
            </div>
          </section>

          <section>
            <h2 className="font-serif text-xl font-semibold">Estimated Provider Cost Exposure</h2>
            <p className="mt-1 text-xs text-muted-foreground">Actual provider-billable usage, including failed responses. These dollar amounts are not Storyhold credit charges.</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Provider cost totals">
              {[
                ["Today", dollars(report.provider.summary.todayCostMicros)],
                ["Last 7 Days", dollars(report.provider.summary.sevenDayCostMicros)],
                ["All Time", dollars(report.provider.summary.allTimeCostMicros)],
                ["Not Converted to Credit Charges", dollars(report.provider.summary.unchargedCostMicros)],
              ].map(([label, value]) => <Card key={label} className="p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
                <p className="mt-2 flex items-center gap-2 text-2xl font-bold"><DollarSign className="h-5 w-5 text-primary" /> {value}</p>
              </Card>)}
            </div>
          </section>

          <Card className="p-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1.3fr_auto] lg:items-end">
              <label className="space-y-1.5 text-sm font-medium">
                <span>From</span>
                <Input type="date" value={filters.from ?? ""} max={filters.to} onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value || undefined }))} />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                <span>Through</span>
                <Input type="date" value={filters.to ?? ""} min={filters.from} onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value || undefined }))} />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                <span>Operation</span>
                <Select value={filters.operation ?? "all"} onValueChange={(value) => setFilters((current) => ({ ...current, operation: value === "all" ? undefined : value }))}>
                  <SelectTrigger><SelectValue placeholder="All operations" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Operations</SelectItem>
                    {report.provider.filters.operations.map((value) => <SelectItem key={value} value={value}>{operationLabel(value)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </label>
              <Button variant="outline" onClick={() => setFilters({})} disabled={!filters.from && !filters.to && !filters.operation}>Clear</Button>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">Provider totals, breakdown, and recent provider usage reflect these filters.</p>
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b p-4">
              <h2 className="font-serif text-xl font-semibold">Cost by Provider and Model</h2>
              <p className="mt-1 text-xs text-muted-foreground">Completed requests and billable failures are shown separately within each total.</p>
            </div>
            {report.provider.groups.length ? <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="bg-muted/50 text-xs uppercase tracking-[0.1em] text-muted-foreground">
                  <tr><th className="px-4 py-3">Provider / Model</th><th className="px-4 py-3">Total Cost</th><th className="px-4 py-3">Completed</th><th className="px-4 py-3">Billable Failures</th><th className="px-4 py-3">Requests</th></tr>
                </thead>
                <tbody className="divide-y">
                  {report.provider.groups.map((group) => <tr key={`${group.provider}-${group.model}`}>
                    <td className="px-4 py-3 font-medium">{group.provider} / <span className="text-muted-foreground">{group.model}</span></td>
                    <td className="px-4 py-3 font-mono text-xs">{dollars(group.costMicros)}</td>
                    <td className="px-4 py-3"><span className="flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4 text-emerald-500" /> {dollars(group.completedCostMicros)} <span className="text-muted-foreground">({group.completedRequests})</span></span></td>
                    <td className="px-4 py-3"><span className="flex items-center gap-1.5"><AlertTriangle className="h-4 w-4 text-amber-500" /> {dollars(group.failedCostMicros)} <span className="text-muted-foreground">({group.failedRequests})</span></span></td>
                    <td className="px-4 py-3 tabular-nums">{group.requests.toLocaleString()}</td>
                  </tr>)}
                </tbody>
              </table>
            </div> : <p className="p-6 text-sm text-muted-foreground">No provider-billable usage matches these filters.</p>}
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b p-4">
              <h2 className="font-serif text-xl font-semibold">Recent Provider Usage</h2>
              <p className="mt-1 text-xs text-muted-foreground">{report.provider.summary.requests.toLocaleString()} provider-billable requests, whether or not a credit charge settled.</p>
            </div>
            {report.provider.recent.length ? <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="bg-muted/50 text-xs uppercase tracking-[0.1em] text-muted-foreground">
                  <tr><th className="px-4 py-3">Operation</th><th className="px-4 py-3">Provider / Model</th><th className="px-4 py-3">Outcome</th><th className="px-4 py-3">Provider Cost</th><th className="px-4 py-3">Credit Charge</th><th className="px-4 py-3">Occurred</th></tr>
                </thead>
                <tbody className="divide-y">
                  {report.provider.recent.map((entry, index) => <tr key={`${entry.occurredAt}-${entry.operation}-${index}`}>
                    <td className="px-4 py-3 font-medium">{operationLabel(entry.operation)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{entry.provider || "Unknown"}{entry.model ? ` / ${entry.model}` : ""}</td>
                    <td className="px-4 py-3">{entry.failed
                      ? <span className="inline-flex items-center gap-1.5 font-medium text-amber-500"><AlertTriangle className="h-4 w-4" /> Billable failure</span>
                      : <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4 text-emerald-500" /> Completed</span>}</td>
                    <td className="px-4 py-3 font-mono text-xs">{dollars(entry.costMicros)}</td>
                    <td className="px-4 py-3 tabular-nums">{entry.creditsCharged > 0 ? `${entry.creditsCharged.toLocaleString()} credits` : "None"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{new Date(entry.occurredAt).toLocaleString()}</td>
                  </tr>)}
                </tbody>
              </table>
            </div> : <p className="p-6 text-sm text-muted-foreground">No provider-billable usage has been recorded for this administrator account.</p>}
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b p-4">
              <h2 className="font-serif text-xl font-semibold">Recent Settled Requests</h2>
              <p className="mt-1 text-xs text-muted-foreground">{report.summary.settledRequests.toLocaleString()} settled requests on this account.</p>
            </div>
            {report.recent.length ? <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="bg-muted/50 text-xs uppercase tracking-[0.1em] text-muted-foreground">
                  <tr><th className="px-4 py-3">Operation</th><th className="px-4 py-3">Provider / Model</th><th className="px-4 py-3">Credits</th><th className="px-4 py-3">Estimated Cost</th><th className="px-4 py-3">Settled</th></tr>
                </thead>
                <tbody className="divide-y">
                  {report.recent.map((entry, index) => <tr key={`${entry.settledAt}-${entry.operation}-${index}`}>
                    <td className="px-4 py-3 font-medium">{operationLabel(entry.operation)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{entry.provider || "Internal"}{entry.model ? ` / ${entry.model}` : ""}</td>
                    <td className="px-4 py-3 tabular-nums">{entry.credits.toLocaleString()}</td>
                    <td className="px-4 py-3 font-mono text-xs">{dollars(entry.costMicros)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{new Date(entry.settledAt).toLocaleString()}</td>
                  </tr>)}
                </tbody>
              </table>
            </div> : <p className="p-6 text-sm text-muted-foreground">No settled credit usage has been recorded for this administrator account.</p>}
          </Card>
        </> : null}
      </div>
    </main>
  );
}
import { useCallback, useEffect, useState } from "react";
import { Coins, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getCreditUsage, type CreditUsageReport } from "@/lib/creditUsageApi";
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

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      setReport(await getCreditUsage(signal));
    } catch (reason) {
      if (signal?.aborted) return;
      setError(reason instanceof Error ? reason.message : "Credit usage could not be loaded.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

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
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Credits and estimated provider cost settled against your administrator account. This page is never shown to players.</p>
          </div>
          <Button variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </header>

        {error ? <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">{error}</p> : null}
        {!report && loading ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading settled usage…</p> : null}
        {report ? <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Credit usage totals">
            {[
              ["Today", report.summary.todayCredits.toLocaleString()],
              ["Last 7 Days", report.summary.sevenDayCredits.toLocaleString()],
              ["All Time", report.summary.allTimeCredits.toLocaleString()],
              ["Estimated Provider Cost", dollars(report.summary.allTimeCostMicros)],
            ].map(([label, value]) => <Card key={label} className="p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
              <p className="mt-2 flex items-center gap-2 text-2xl font-bold"><Coins className="h-5 w-5 text-primary" /> {value}</p>
            </Card>)}
          </section>

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
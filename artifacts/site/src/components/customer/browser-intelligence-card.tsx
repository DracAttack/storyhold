import { useEffect, useState } from "react";
import { Cpu, HardDrive, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  inspectBrowserLorekeeper,
  inspectBrowserLorekeeperCache,
  removeBrowserLorekeeperCache,
  type BrowserLorekeeperCacheStatus,
  type BrowserLorekeeperCapability,
} from "@/lib/browserLorekeeper";
import {
  getBrowserLorekeeperPreference,
  setBrowserLorekeeperPreference,
  type BrowserLorekeeperPreference,
} from "@/lib/browserLorekeeperSettings";

function storageLabel(bytes: number | null) {
  if (bytes === null) return "Storage use unavailable";
  if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB used by this browser`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB used by this browser`;
}

export function BrowserIntelligenceCard() {
  const [preference, setPreference] = useState<BrowserLorekeeperPreference>(() =>
    getBrowserLorekeeperPreference(),
  );
  const [capability, setCapability] = useState<BrowserLorekeeperCapability | null>(null);
  const [cache, setCache] = useState<BrowserLorekeeperCacheStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async (checkCache = preference === "enabled") => {
    const nextCapability = await inspectBrowserLorekeeper();
    const nextCache = checkCache
      ? await inspectBrowserLorekeeperCache().catch(() => ({
          cachedModels: [],
          usageBytes: null,
          quotaBytes: null,
        }))
      : null;
    setCapability(nextCapability);
    setCache(nextCache);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const enable = () => {
    if (!capability?.supported) return;
    setBrowserLorekeeperPreference("enabled");
    setPreference("enabled");
    void refresh(true);
    toast.success("Private browser intelligence is enabled on this device.");
  };

  const disable = () => {
    setBrowserLorekeeperPreference("disabled");
    setPreference("disabled");
    toast.success("Private browser intelligence is disabled on this device.");
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await removeBrowserLorekeeperCache();
      setBrowserLorekeeperPreference("disabled");
      setPreference("disabled");
      await refresh(false);
      toast.success("The downloaded private models were removed from this browser.");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "The browser model cache could not be removed.");
    } finally {
      setBusy(false);
    }
  };

  const cached = Boolean(cache?.cachedModels.length);
  return (
    <Card className="rounded-3xl border-white/8 bg-[#121115] p-6">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
        <div className="max-w-2xl">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
              <Cpu className="h-5 w-5" />
            </span>
            <div>
              <h2 className="font-serif text-2xl font-bold">Private Browser Intelligence</h2>
              <p className="text-sm text-muted-foreground">Optional, device-local Storyhold assistance</p>
            </div>
          </div>
          <p className="mt-4 text-sm leading-6 text-muted-foreground">
            When enabled, Storyhold can download Private Story Intelligence into this browser for intake checks, dossier retrieval, and supported play. The first use may download hundreds of megabytes. Manuscript passages handled here stay on this device; Storyhold's evidence verifier still decides what becomes canon.
          </p>
          <div className="mt-4 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5">
              {capability === null ? "Checking this device…" : capability.supported ? "Private acceleration is ready on this device" : capability.reason}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5">
              {cached ? <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" /> : <HardDrive className="h-3.5 w-3.5" />}
              {cached ? `${cache?.cachedModels.length} model${cache?.cachedModels.length === 1 ? "" : "s"} cached` : "No model downloaded"}
            </span>
            {cache?.usageBytes !== null && cache?.usageBytes !== undefined ? (
              <span className="rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5">
                {storageLabel(cache.usageBytes)}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:w-48">
          {preference === "enabled" ? (
            <Button type="button" variant="outline" className="rounded-xl" onClick={disable}>
              Disable on this device
            </Button>
          ) : (
            <Button type="button" className="rounded-xl" disabled={!capability?.supported} onClick={enable}>
              Enable on this device
            </Button>
          )}
          {cached || preference !== "unset" ? (
            <Button type="button" variant="ghost" className="rounded-xl text-muted-foreground" disabled={busy} onClick={() => void remove()}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
              Remove any download
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

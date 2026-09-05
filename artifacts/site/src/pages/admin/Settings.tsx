import { useEffect, useState } from "react";
import {
  useGetAdminSettings,
  useUpdateAdminSettings,
  useSendTestDigest,
  useGetSiteSettings,
  useUpdateSiteSettings,
  useListBeats,
  getGetAdminSettingsQueryKey,
  getGetSiteSettingsQueryKey,
  getListAdminNotificationsQueryKey,
} from "@workspace/api-client-react";
import type { SiteSettings, UpdateSiteSettingsInput } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Mail, Megaphone, Factory, CopyCheck, Clock, Send, Facebook, Laugh, Radar } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function hourLabel(h: number): string {
  const hh = String(h).padStart(2, "0");
  return `${hh}:00 UTC`;
}

export default function AdminSettings() {
  const { data, isLoading } = useGetAdminSettings();
  const qc = useQueryClient();

  const update = useUpdateAdminSettings({
    mutation: {
      onSuccess: () => {
        toast.success("Notification settings updated");
        qc.invalidateQueries({ queryKey: getGetAdminSettingsQueryKey() });
      },
      onError: () => toast.error("Failed to update settings"),
    },
  });

  const { data: siteSettings, isLoading: siteLoading } = useGetSiteSettings();

  const updateSite = useUpdateSiteSettings({
    mutation: {
      onSuccess: (res) => {
        toast.success(res.adsEnabled ? "Ads are now shown site-wide" : "Ads are now hidden site-wide");
        qc.invalidateQueries({ queryKey: getGetSiteSettingsQueryKey() });
      },
      onError: () => toast.error("Failed to update ad visibility"),
    },
  });

  const updatePipeline = useUpdateSiteSettings({
    mutation: {
      onSuccess: (res) => {
        toast.success(res.pipelineEnabled ? "Content pipeline resumed" : "Content pipeline paused");
        qc.invalidateQueries({ queryKey: getGetSiteSettingsQueryKey() });
      },
      onError: () => toast.error("Failed to update pipeline state"),
    },
  });

  const updateDedupe = useUpdateSiteSettings({
    mutation: {
      onSuccess: (res) => {
        toast.success(res.dedupeScanEnabled ? "Daily dedup scan resumed" : "Daily dedup scan paused");
        qc.invalidateQueries({ queryKey: getGetSiteSettingsQueryKey() });
      },
      onError: () => toast.error("Failed to update dedup scan state"),
    },
  });

  const updateSocial = useUpdateSiteSettings({
    mutation: {
      onSuccess: (res) => {
        toast.success(
          res.socialAutoPostEnabled
            ? "Auto-posting to Facebook is on"
            : "Auto-posting to Facebook is off",
        );
        qc.invalidateQueries({ queryKey: getGetSiteSettingsQueryKey() });
      },
      onError: () => toast.error("Failed to update Facebook auto-post state"),
    },
  });

  const updateMeme = useUpdateSiteSettings({
    mutation: {
      onSuccess: (res) => {
        toast.success(
          res.memeQueueActivated
            ? res.memeQueuePaused
              ? "Meme queue paused"
              : "Meme queue active"
            : "Meme queue dormant",
        );
        qc.invalidateQueries({ queryKey: getGetSiteSettingsQueryKey() });
      },
      onError: () => toast.error("Failed to update meme queue state"),
    },
  });

  const updateDiscovery = useUpdateSiteSettings({
    mutation: {
      onSuccess: (res) => {
        toast.success(
          res.sourceDiscoveryEnabled
            ? "Source Vault discovery resumed"
            : "Source Vault discovery paused",
        );
        qc.invalidateQueries({ queryKey: getGetSiteSettingsQueryKey() });
      },
      onError: () => toast.error("Failed to update Source Vault discovery"),
    },
  });

  const updateHotHarvest = useUpdateSiteSettings({
    mutation: {
      onSuccess: (res) => {
        toast.success(
          res.hotMarkerHarvestEnabled
            ? "Hot-buzz harvesting resumed"
            : "Hot-buzz harvesting paused",
        );
        qc.invalidateQueries({ queryKey: getGetSiteSettingsQueryKey() });
      },
      onError: () => toast.error("Failed to update hot-buzz harvesting"),
    },
  });

  const updateSourceLinks = useUpdateSiteSettings({
    mutation: {
      onSuccess: () => {
        toast.success("Source-link strategy saved");
        qc.invalidateQueries({ queryKey: getGetSiteSettingsQueryKey() });
      },
      onError: () => toast.error("Failed to update source-link strategy"),
    },
  });

  const updateDraftResearch = useUpdateSiteSettings({
    mutation: {
      onSuccess: () => {
        toast.success("Draft research mode saved");
        qc.invalidateQueries({ queryKey: getGetSiteSettingsQueryKey() });
      },
      onError: () => toast.error("Failed to update draft research mode"),
    },
  });

  const updateClusters = useUpdateSiteSettings({
    mutation: {
      onSuccess: (res) => {
        toast.success(
          res.semanticClusterReconcileEnabled
            ? "Semantic cluster reconciler enabled"
            : "Semantic cluster reconciler disabled",
        );
        qc.invalidateQueries({ queryKey: getGetSiteSettingsQueryKey() });
      },
      onError: () => toast.error("Failed to update cluster reconciler setting"),
    },
  });

  const sendTest = useSendTestDigest({
    mutation: {
      onSuccess: (res) => {
        const recipientCount = res.recipients?.length ?? 0;
        if (res.skipped === "nothing_to_report") {
          toast("Nothing to report yet — no recent drafts or pending ideas.");
        } else if (res.notificationId) {
          toast.success(`Digest generated for ${recipientCount} recipient${recipientCount === 1 ? "" : "s"}.`);
        } else {
          toast(res.skipped ? `Skipped: ${res.skipped}` : "Done");
        }
        qc.invalidateQueries({ queryKey: getListAdminNotificationsQueryKey() });
      },
      onError: () => toast.error("Failed to send test digest"),
    },
  });

  if (isLoading || !data) return <div className="p-4 md:p-8"><Loader2 className="animate-spin" /></div>;

  return (
    <div className="p-4 md:p-8 space-y-8 max-w-3xl">
      <div>
        <h1 className="font-serif text-3xl font-bold">Settings</h1>
        <p className="text-muted-foreground mt-1">Notification preferences for {data.email}</p>
      </div>

      <Card className="p-6 space-y-6">
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-muted-foreground" />
              <h2 className="font-medium">Daily Editorial Digest</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              After each daily pipeline run, generate a digest of new pending ideas and drafts with deep-links into the admin.
              Toggle this off to unsubscribe — your email will be skipped while other admins continue to receive it.
            </p>
          </div>
          <Switch
            checked={data.digestEnabled}
            disabled={update.isPending}
            onCheckedChange={(checked) => update.mutate({ data: { digestEnabled: checked } })}
          />
        </div>

        <div className="border-t pt-4 flex items-center justify-between gap-4">
          <div className="text-sm text-muted-foreground">
            Digests are stored in the <Link href="/admin/notifications" className="text-primary hover:underline">notifications inbox</Link> and written to the server mailbox directory. No external email service is used.
          </div>
          <Button variant="outline" size="sm" disabled={sendTest.isPending} onClick={() => sendTest.mutate()}>
            {sendTest.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Send test digest
          </Button>
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Megaphone className="h-4 w-4 text-muted-foreground" />
              <h2 className="font-medium">Show Ads on the Site</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Master switch for every ad spot on the public site (the banners at the top and bottom of
              articles and the in-article units). Turn it off to hide all ads for every visitor — useful
              while AdSense review is pending or for an ad-free period. Changes take effect without a redeploy.
            </p>
          </div>
          <Switch
            checked={siteSettings?.adsEnabled ?? false}
            disabled={siteLoading || updateSite.isPending}
            onCheckedChange={(checked) => updateSite.mutate({ data: { adsEnabled: checked } })}
          />
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Factory className="h-4 w-4 text-muted-foreground" />
              <h2 className="font-medium">Run the Content Pipeline</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Master switch for the automated content machine — the hourly job that generates ideas and
              drafts new articles. Turn it off to pause all automated drafting (useful to control cost or
              while you review the queue). Already-scheduled articles still publish on time, and the manual
              "Run pipeline now" button still works. Changes take effect without a redeploy.
            </p>
          </div>
          <Switch
            checked={siteSettings?.pipelineEnabled ?? false}
            disabled={siteLoading || updatePipeline.isPending}
            onCheckedChange={(checked) => updatePipeline.mutate({ data: { pipelineEnabled: checked } })}
          />
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <CopyCheck className="h-4 w-4 text-muted-foreground" />
              <h2 className="font-medium">Run the daily duplicate scan</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Master switch for the daily AI scan that finds near-duplicate published articles and
              quarantines the newer one for review. Turn it off to stop the scheduled run and save on
              AI compute. The manual "Scan now" button on the{" "}
              <Link href="/admin/duplicates" className="text-primary hover:underline">Dupes</Link>{" "}
              page still works. Changes take effect without a redeploy.
            </p>
          </div>
          <Switch
            checked={siteSettings?.dedupeScanEnabled ?? false}
            disabled={siteLoading || updateDedupe.isPending}
            onCheckedChange={(checked) => updateDedupe.mutate({ data: { dedupeScanEnabled: checked } })}
          />
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Radar className="h-4 w-4 text-muted-foreground" />
              <h2 className="font-medium">Source Vault automatic discovery</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Master switch for the hourly job that discovers fresh leads (Trend Radar signal URLs
              and per-beat web search) and ingests them into the Source Vault, then groups them into
              story clusters you can triage in{" "}
              <Link href="/admin/trends" className="text-primary hover:underline">Trend Radar</Link>.
              Discovery is budget-guarded and fails closed. Turn it off to stop the paid web search
              (clustering of already-ingested sources still runs). Your trusted RSS feeds keep
              polling on their own schedule either way — manage those in{" "}
              <Link href="/admin/feeds" className="text-primary hover:underline">Feeds</Link>.
              Changes take effect without a redeploy.
            </p>
          </div>
          <Switch
            checked={siteSettings?.sourceDiscoveryEnabled ?? false}
            disabled={siteLoading || updateDiscovery.isPending}
            onCheckedChange={(checked) => updateDiscovery.mutate({ data: { sourceDiscoveryEnabled: checked } })}
          />
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Radar className="h-4 w-4 text-muted-foreground" />
              <h2 className="font-medium">Hot-buzz auto-harvest</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              When a topic's trend markers cross the buzz thresholds below, automatically run a
              bounded source harvest for it after clustering — searching the Source Vault first
              (free), then Perplexity restricted to your allowed domains (budget-guarded). It uses
              the marker's title, snippet, and beat to find real reporting —{" "}
              <span className="font-medium">never</span> the social URL itself. Requires Source Vault
              discovery to be enabled; fails closed. You can also trigger it per-marker with
              "Investigate this buzz" in{" "}
              <Link href="/admin/trends" className="text-primary hover:underline">Trend Radar</Link>.
              Changes take effect without a redeploy.
            </p>
          </div>
          <Switch
            checked={siteSettings?.hotMarkerHarvestEnabled ?? false}
            disabled={siteLoading || updateHotHarvest.isPending}
            onCheckedChange={(checked) =>
              updateHotHarvest.mutate({ data: { hotMarkerHarvestEnabled: checked } })
            }
          />
        </div>
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="space-y-1">
            <span className="text-sm font-medium">Min observations</span>
            <p className="text-xs text-muted-foreground">
              A topic qualifies once its markers have been observed at least this many times.
            </p>
            <Input
              type="number"
              min={1}
              max={100}
              className="w-32"
              defaultValue={siteSettings?.hotMarkerObservationThreshold ?? 3}
              disabled={siteLoading || updateHotHarvest.isPending}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (
                  Number.isFinite(v) &&
                  v >= 1 &&
                  v <= 100 &&
                  v !== siteSettings?.hotMarkerObservationThreshold
                ) {
                  updateHotHarvest.mutate({ data: { hotMarkerObservationThreshold: v } });
                }
              }}
            />
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium">Min distinct platforms</span>
            <p className="text-xs text-muted-foreground">
              …or a topic qualifies once it's been seen on at least this many distinct platforms.
            </p>
            <Input
              type="number"
              min={1}
              max={20}
              className="w-32"
              defaultValue={siteSettings?.hotMarkerPlatformThreshold ?? 2}
              disabled={siteLoading || updateHotHarvest.isPending}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (
                  Number.isFinite(v) &&
                  v >= 1 &&
                  v <= 20 &&
                  v !== siteSettings?.hotMarkerPlatformThreshold
                ) {
                  updateHotHarvest.mutate({ data: { hotMarkerPlatformThreshold: v } });
                }
              }}
            />
          </label>
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Radar className="h-4 w-4 text-muted-foreground" />
              <h2 className="font-medium">Semantic cluster reconciler</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              After each clustering tick, an LLM judge (Haiku) reviews borderline cluster pairs —
              same beat, Jaccard similarity 0.08–0.18 — and decides whether they cover the same
              underlying story. Confirmed same-story pairs are merged (smaller cluster archived),
              and verdicts are cached so unchanged pairs are never re-judged. Also requires the{" "}
              <span className="font-medium">cluster_reconcile_judge</span> AI function to be enabled
              in AI Controls. Audit trail visible in{" "}
              <Link href="/admin/trends" className="text-primary hover:underline">Trend Radar → Clusters → Semantic merges</Link>.
              Off by default — only turn on once you have active story clusters.
              Changes take effect without a redeploy.
            </p>
          </div>
          <Switch
            checked={siteSettings?.semanticClusterReconcileEnabled ?? false}
            disabled={siteLoading || updateClusters.isPending}
            onCheckedChange={(checked) =>
              updateClusters.mutate({ data: { semanticClusterReconcileEnabled: checked } })
            }
          />
        </div>
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="space-y-1">
            <span className="text-sm font-medium">Jaccard low</span>
            <p className="text-xs text-muted-foreground">
              Pairs below this threshold are definitively distinct — LLM is not called. (Default 0.08)
            </p>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.01}
              className="w-32"
              defaultValue={siteSettings?.reconcileJaccardLow ?? 0.08}
              disabled={siteLoading || updateClusters.isPending}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 0 && v < (siteSettings?.reconcileJaccardHigh ?? 0.18)) {
                  updateClusters.mutate({ data: { reconcileJaccardLow: v } });
                }
              }}
            />
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium">Jaccard high</span>
            <p className="text-xs text-muted-foreground">
              Upper bound of the borderline window sent to the LLM judge. Pairs above this threshold are outside the window and skipped. (Default 0.18)
            </p>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.01}
              className="w-32"
              defaultValue={siteSettings?.reconcileJaccardHigh ?? 0.18}
              disabled={siteLoading || updateClusters.isPending}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v > (siteSettings?.reconcileJaccardLow ?? 0.08) && v <= 1) {
                  updateClusters.mutate({ data: { reconcileJaccardHigh: v } });
                }
              }}
            />
          </label>
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Radar className="h-4 w-4 text-muted-foreground" />
              <h2 className="font-medium">Source-Link Strategy</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              How external SOURCE citations are added to articles — both at draft time and by the
              "Add source links" backfill. Vault-first modes prefer the evidence packet and Source
              Vault before spending on paid web search. Packet-backed articles never web-search.
              Changes take effect without a redeploy. (In development, web-search modes are
              automatically downgraded to vault-only unless explicitly opted in.)
            </p>
          </div>
          <Select
            value={siteSettings?.sourceLinkInsertionMode ?? "vault_first_with_capped_search"}
            disabled={siteLoading || updateSourceLinks.isPending}
            onValueChange={(value) =>
              updateSourceLinks.mutate({
                data: { sourceLinkInsertionMode: value as UpdateSiteSettingsInput["sourceLinkInsertionMode"] },
              })
            }
          >
            <SelectTrigger className="w-64 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Off — no source links</SelectItem>
              <SelectItem value="vault_only">Vault only — no web search</SelectItem>
              <SelectItem value="vault_first_with_capped_search">
                Vault-first + capped search (recommended)
              </SelectItem>
              <SelectItem value="legacy_web_search">Legacy web search</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Radar className="h-4 w-4 text-muted-foreground" />
              <h2 className="font-medium">Draft Research Mode</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              How every draft is grounded before it is written. Auto-ground first builds an evidence
              packet from the Source Vault and drafts from its excerpts with NO draft-time web search.
              If the Vault is too thin: <strong>Vault required</strong> holds the idea as
              "Needs sources"; <strong>Vault-first, harvest if needed</strong> (recommended) runs a
              controlled Source Harvest for the beat, retries once, then holds if still weak;
              <strong> Legacy web search</strong> is an emergency override that drafts via the old
              web-search path. Changes take effect without a redeploy. (In development, web-search
              modes are downgraded unless explicitly opted in.)
            </p>
          </div>
          <Select
            value={siteSettings?.draftResearchMode ?? "vault_first_harvest_if_needed"}
            disabled={siteLoading || updateDraftResearch.isPending}
            onValueChange={(value) =>
              updateDraftResearch.mutate({
                data: { draftResearchMode: value as UpdateSiteSettingsInput["draftResearchMode"] },
              })
            }
          >
            <SelectTrigger className="w-64 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="vault_required">Vault required — hold if thin</SelectItem>
              <SelectItem value="vault_first_harvest_if_needed">
                Vault-first, harvest if needed (recommended)
              </SelectItem>
              <SelectItem value="legacy_web_search">Legacy web search (override)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Facebook className="h-4 w-4 text-muted-foreground" />
              <h2 className="font-medium">Auto-Post New Articles to Facebook</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              When on, each article that publishes on the automated schedule is posted to the
              connected Facebook Page (headline + link; Facebook builds its own preview). This does
              not affect articles you publish manually — use the "Post to Facebook" button on an
              article for those. Requires the Facebook connection to be configured. Changes take
              effect without a redeploy.
            </p>
          </div>
          <Switch
            checked={siteSettings?.socialAutoPostEnabled ?? false}
            disabled={siteLoading || updateSocial.isPending}
            onCheckedChange={(checked) => updateSocial.mutate({ data: { socialAutoPostEnabled: checked } })}
          />
        </div>
      </Card>

      <Card className="p-6 space-y-6">
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Laugh className="h-4 w-4 text-muted-foreground" />
              <h2 className="font-medium">Auto-Post Memes to Facebook</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              When active, approved memes are posted to the connected Facebook Page on the daily meme
              schedule — up to three a day at 10am, 4pm and 7pm Phoenix time, separate from the
              article-link slots. Approving a meme always enqueues it; this switch only controls
              whether the queue posts automatically. Requires the Facebook connection. Changes take
              effect without a redeploy.
            </p>
          </div>
          <Switch
            checked={siteSettings?.memeQueueActivated ?? false}
            disabled={siteLoading || updateMeme.isPending}
            onCheckedChange={(checked) => updateMeme.mutate({ data: { memeQueueActivated: checked } })}
          />
        </div>
        {siteSettings?.memeQueueActivated && (
          <div className="border-t pt-4 flex items-start justify-between gap-6">
            <div className="space-y-1">
              <h3 className="text-sm font-medium">Pause the Meme Queue</h3>
              <p className="text-sm text-muted-foreground">
                Temporarily hold all automatic meme posting without losing the queue. Approved memes
                stay queued and resume posting when you switch this off.
              </p>
            </div>
            <Switch
              checked={siteSettings?.memeQueuePaused ?? false}
              disabled={siteLoading || updateMeme.isPending}
              onCheckedChange={(checked) => updateMeme.mutate({ data: { memeQueuePaused: checked } })}
            />
          </div>
        )}
      </Card>

      {siteSettings ? <PipelineTiming settings={siteSettings} /> : null}
      {siteSettings ? <SourceFreshness settings={siteSettings} /> : null}
      {siteSettings ? <SourceDiscoveryDomains settings={siteSettings} /> : null}
    </div>
  );
}

function SourceDiscoveryDomains({ settings }: { settings: SiteSettings }) {
  const qc = useQueryClient();
  const save = useUpdateSiteSettings({
    mutation: {
      onSuccess: () => {
        toast.success("Discovery domain list saved");
        qc.invalidateQueries({ queryKey: getGetSiteSettingsQueryKey() });
      },
      onError: () => toast.error("Failed to save domain list"),
    },
  });

  const [raw, setRaw] = useState(
    () => (settings.sourceDiscoveryAllowedDomains ?? []).join("\n"),
  );
  useEffect(() => {
    setRaw((settings.sourceDiscoveryAllowedDomains ?? []).join("\n"));
  }, [settings]);

  const onSave = () => {
    const domains = raw
      .split("\n")
      .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
      .filter((d) => d.length > 0);
    save.mutate({ data: { sourceDiscoveryAllowedDomains: domains } });
  };

  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Radar className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-medium">Source Discovery Domain Allowlist</h2>
      </div>
      <p className="text-sm text-muted-foreground -mt-2">
        <strong>Optional.</strong> Discovery already filters results automatically using the same
        source-authority logic the newsroom uses for citations — social platforms (YouTube, Reddit,
        X, TikTok) and content aggregators (MSN, Yahoo, BuzzFeed) are dropped, and primary research,
        government/academic, wire, and established outlets are kept. You do <em>not</em> need to
        maintain a list. Use this only to <em>further</em> restrict discovery to a specific set of
        sites — one bare domain per line (e.g. <code className="font-mono text-xs">reuters.com</code>).
        Leave empty to let the automatic quality filter do its job across the open web.
      </p>
      <textarea
        className="w-full min-h-[120px] rounded-md border bg-background px-3 py-2 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-ring"
        placeholder={"reuters.com\napnews.com\nscientificamerican.com"}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        spellCheck={false}
      />
      <Button size="sm" disabled={save.isPending} onClick={onSave}>
        {save.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
        Save domain list
      </Button>
    </Card>
  );
}

function SourceFreshness({ settings }: { settings: SiteSettings }) {
  const qc = useQueryClient();
  const { data: beatsData } = useListBeats();
  const save = useUpdateSiteSettings({
    mutation: {
      onSuccess: () => {
        toast.success("Freshness thresholds updated");
        qc.invalidateQueries({ queryKey: getGetSiteSettingsQueryKey() });
      },
      onError: () => toast.error("Failed to update freshness thresholds"),
    },
  });

  const [defaultDays, setDefaultDays] = useState(settings.sourceFreshnessDefaultDays);
  // Per-beat/sub-beat overrides as editable strings ("" = use the default).
  const [byBeat, setByBeat] = useState<Record<string, string>>({});
  useEffect(() => {
    setDefaultDays(settings.sourceFreshnessDefaultDays);
    const next: Record<string, string> = {};
    for (const [slug, days] of Object.entries(settings.sourceFreshnessByBeat ?? {})) {
      next[slug] = String(days);
    }
    setByBeat(next);
  }, [settings]);

  const beats = beatsData?.items ?? [];

  const clampDays = (v: string, fallback: number) => {
    const n = Number.parseInt(v, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.min(365, Math.max(1, n));
  };

  const onSave = () => {
    const overrides: Record<string, number> = {};
    for (const [slug, raw] of Object.entries(byBeat)) {
      const trimmed = raw.trim();
      if (trimmed === "") continue;
      const n = Number.parseInt(trimmed, 10);
      if (Number.isNaN(n)) continue;
      overrides[slug] = Math.min(365, Math.max(1, n));
    }
    save.mutate({
      data: {
        sourceFreshnessDefaultDays: clampDays(String(defaultDays), 7),
        sourceFreshnessByBeat: overrides,
      },
    });
  };

  return (
    <Card className="p-6 space-y-6">
      <div className="flex items-center gap-2">
        <Radar className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-medium">Source Freshness Thresholds</h2>
      </div>
      <p className="text-sm text-muted-foreground -mt-4">
        How recent a supporting source must be to keep a story cluster "active". A cluster with no
        sources newer than its beat's window ages to dormant and drops out of the "hot now" ranking.
        Set a per-beat override to make a fast-moving beat stricter or a slow beat more lenient; leave
        an override blank to use the default. Changes take effect without a redeploy.
      </p>

      <div className="space-y-1.5 max-w-xs">
        <Label htmlFor="freshDefault">Default freshness (days)</Label>
        <Input
          id="freshDefault"
          type="number"
          min={1}
          max={365}
          value={defaultDays}
          onChange={(e) => setDefaultDays(clampDays(e.target.value, 7))}
        />
      </div>

      {beats.length > 0 && (
        <div className="space-y-3 border-t pt-4">
          <h3 className="text-sm font-medium">Per-Beat Overrides</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
            {beats.map((b) => (
              <div key={b.id} className="flex items-center justify-between gap-3">
                <Label htmlFor={`fresh-${b.slug}`} className="text-sm text-muted-foreground truncate">
                  {b.name}
                </Label>
                <Input
                  id={`fresh-${b.slug}`}
                  type="number"
                  min={1}
                  max={365}
                  placeholder={`${defaultDays}`}
                  className="w-24 shrink-0"
                  value={byBeat[b.slug] ?? ""}
                  onChange={(e) => setByBeat((m) => ({ ...m, [b.slug]: e.target.value }))}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <Button size="sm" disabled={save.isPending} onClick={onSave}>
        {save.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
        Save freshness thresholds
      </Button>
    </Card>
  );
}

function PipelineTiming({ settings }: { settings: SiteSettings }) {
  const qc = useQueryClient();
  const save = useUpdateSiteSettings({
    mutation: {
      onSuccess: () => {
        toast.success("Schedule updated");
        qc.invalidateQueries({ queryKey: getGetSiteSettingsQueryKey() });
      },
      onError: () => toast.error("Failed to update schedule"),
    },
  });

  // Local draft state synced from the loaded settings.
  const [form, setForm] = useState(settings);
  useEffect(() => setForm(settings), [settings]);

  const set = <K extends keyof SiteSettings>(key: K, value: SiteSettings[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const num = (v: string, min: number, max: number, fallback: number) => {
    const n = Number.parseInt(v, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };

  const saveFields = (data: UpdateSiteSettingsInput) => save.mutate({ data });

  return (
    <Card className="p-6 space-y-8">
      <div className="flex items-center gap-2">
        <Clock className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-medium">Pipeline Timing &amp; Triggers</h2>
      </div>
      <p className="text-sm text-muted-foreground -mt-4">
        Fine-tune when each automated job runs and the conditions that trigger it. All times are in UTC.
        Changes take effect without a redeploy.
      </p>

      {/* Content generation */}
      <section className="space-y-4 border-t pt-6">
        <div>
          <h3 className="font-medium text-sm">Content Generation</h3>
          <p className="text-sm text-muted-foreground">
            Restrict automated idea/draft generation to a window of UTC hours, and cap how many
            ready-to-draft ideas each author may bank before generation pauses for them.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="activeStart">Active from (hour)</Label>
            <Input
              id="activeStart"
              type="number"
              min={0}
              max={23}
              value={form.contentActiveStartHour}
              onChange={(e) => set("contentActiveStartHour", num(e.target.value, 0, 23, 0))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="activeEnd">Active until (hour)</Label>
            <Input
              id="activeEnd"
              type="number"
              min={0}
              max={23}
              value={form.contentActiveEndHour}
              onChange={(e) => set("contentActiveEndHour", num(e.target.value, 0, 23, 23))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ideaCap">Approved-idea cap</Label>
            <Input
              id="ideaCap"
              type="number"
              min={1}
              max={500}
              value={form.approvedIdeaCap}
              onChange={(e) => set("approvedIdeaCap", num(e.target.value, 1, 500, 20))}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Window {hourLabel(form.contentActiveStartHour)} – {hourLabel(form.contentActiveEndHour)}
          {form.contentActiveStartHour > form.contentActiveEndHour ? " (overnight, wraps past midnight)" : ""}.
          Authors slotted outside this window are skipped that hour.
        </p>
        <Button
          size="sm"
          disabled={save.isPending}
          onClick={() =>
            saveFields({
              contentActiveStartHour: form.contentActiveStartHour,
              contentActiveEndHour: form.contentActiveEndHour,
              approvedIdeaCap: form.approvedIdeaCap,
            })
          }
        >
          {save.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
          Save content settings
        </Button>
      </section>

      {/* Publishing & maintenance */}
      <section className="space-y-4 border-t pt-6">
        <div>
          <h3 className="font-medium text-sm">Publishing &amp; Maintenance Loop</h3>
          <p className="text-sm text-muted-foreground">
            How often the background loop runs and the delays before unattended ideas/drafts are
            auto-handled. Publishing of already-scheduled articles always runs and is never blocked.
          </p>
        </div>
        <div className="space-y-1.5 max-w-xs">
          <Label htmlFor="checkMinutes">Check every (minutes)</Label>
          <Input
            id="checkMinutes"
            type="number"
            min={1}
            max={60}
            value={form.publishCheckMinutes}
            onChange={(e) => set("publishCheckMinutes", num(e.target.value, 1, 60, 2))}
          />
        </div>
        <div className="flex items-center justify-between gap-6">
          <div className="space-y-0.5">
            <Label>Auto-approve unattended ideas</Label>
            <p className="text-xs text-muted-foreground">Flip pending ideas to approved once they go stale.</p>
          </div>
          <Switch
            checked={form.autoApproveEnabled}
            onCheckedChange={(c) => set("autoApproveEnabled", c)}
          />
        </div>
        <div className="space-y-1.5 max-w-xs">
          <Label htmlFor="approveHours">Auto-approve after (hours)</Label>
          <Input
            id="approveHours"
            type="number"
            min={1}
            max={2160}
            disabled={!form.autoApproveEnabled}
            value={form.autoApproveHours}
            onChange={(e) => set("autoApproveHours", num(e.target.value, 1, 2160, 48))}
          />
        </div>
        <div className="flex items-center justify-between gap-6">
          <div className="space-y-0.5">
            <Label>Auto-lock unattended drafts</Label>
            <p className="text-xs text-muted-foreground">Lock stale drafts into their reserved slot (never publishes early).</p>
          </div>
          <Switch
            checked={form.autoLockEnabled}
            onCheckedChange={(c) => set("autoLockEnabled", c)}
          />
        </div>
        <div className="space-y-1.5 max-w-xs">
          <Label htmlFor="lockHours">Auto-lock after (hours)</Label>
          <Input
            id="lockHours"
            type="number"
            min={1}
            max={2160}
            disabled={!form.autoLockEnabled}
            value={form.autoLockHours}
            onChange={(e) => set("autoLockHours", num(e.target.value, 1, 2160, 48))}
          />
        </div>
        <Button
          size="sm"
          disabled={save.isPending}
          onClick={() =>
            saveFields({
              publishCheckMinutes: form.publishCheckMinutes,
              autoApproveEnabled: form.autoApproveEnabled,
              autoApproveHours: form.autoApproveHours,
              autoLockEnabled: form.autoLockEnabled,
              autoLockHours: form.autoLockHours,
            })
          }
        >
          {save.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
          Save publishing settings
        </Button>
      </section>

      {/* Weekly newsletter */}
      <section className="space-y-4 border-t pt-6">
        <div className="flex items-center gap-2">
          <Send className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-medium text-sm">Weekly Newsletter Schedule</h3>
        </div>
        <p className="text-sm text-muted-foreground -mt-2">
          When the "This week on BrainHook" roundup is sent to subscribers. Gated by the master
          newsletter switch (managed elsewhere in admin).
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Day of week</Label>
            <Select
              value={String(form.weeklyNewsletterWeekday)}
              onValueChange={(v) => set("weeklyNewsletterWeekday", Number(v))}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {WEEKDAYS.map((d, i) => (
                  <SelectItem key={i} value={String(i)}>{d}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="newsletterHour">Hour (UTC)</Label>
            <Input
              id="newsletterHour"
              type="number"
              min={0}
              max={23}
              value={form.weeklyNewsletterHour}
              onChange={(e) => set("weeklyNewsletterHour", num(e.target.value, 0, 23, 15))}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Sends {WEEKDAYS[form.weeklyNewsletterWeekday]} at {hourLabel(form.weeklyNewsletterHour)}.
        </p>
        <Button
          size="sm"
          disabled={save.isPending}
          onClick={() =>
            saveFields({
              weeklyNewsletterWeekday: form.weeklyNewsletterWeekday,
              weeklyNewsletterHour: form.weeklyNewsletterHour,
            })
          }
        >
          {save.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
          Save newsletter schedule
        </Button>
      </section>

      {/* Dedup scan */}
      <section className="space-y-4 border-t pt-6">
        <div className="flex items-center gap-2">
          <CopyCheck className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-medium text-sm">Duplicate Scan Schedule</h3>
        </div>
        <p className="text-sm text-muted-foreground -mt-2">
          When the AI duplicate scan runs. Gated by the master duplicate-scan switch above.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <Label>Frequency</Label>
            <Select
              value={form.dedupeScanFrequency}
              onValueChange={(v) => set("dedupeScanFrequency", v as SiteSettings["dedupeScanFrequency"])}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Day of week</Label>
            <Select
              value={String(form.dedupeScanWeekday)}
              onValueChange={(v) => set("dedupeScanWeekday", Number(v))}
              disabled={form.dedupeScanFrequency !== "weekly"}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {WEEKDAYS.map((d, i) => (
                  <SelectItem key={i} value={String(i)}>{d}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dedupeHour">Hour (UTC)</Label>
            <Input
              id="dedupeHour"
              type="number"
              min={0}
              max={23}
              value={form.dedupeScanHour}
              onChange={(e) => set("dedupeScanHour", num(e.target.value, 0, 23, 9))}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Runs {form.dedupeScanFrequency === "weekly" ? WEEKDAYS[form.dedupeScanWeekday] : "every day"} at{" "}
          {hourLabel(form.dedupeScanHour)}.
        </p>
        <Button
          size="sm"
          disabled={save.isPending}
          onClick={() =>
            saveFields({
              dedupeScanFrequency: form.dedupeScanFrequency as UpdateSiteSettingsInput["dedupeScanFrequency"],
              dedupeScanWeekday: form.dedupeScanWeekday,
              dedupeScanHour: form.dedupeScanHour,
            })
          }
        >
          {save.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
          Save scan schedule
        </Button>
      </section>
    </Card>
  );
}

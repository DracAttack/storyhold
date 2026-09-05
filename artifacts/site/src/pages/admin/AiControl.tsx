import { useEffect, useState } from "react";
import {
  useGetAiSettings,
  useUpdateAiFunction,
  useResetAiFunction,
  useGetSiteSettings,
  useUpdateSiteSettings,
  useGetAiUsageRouting,
  getGetAiSettingsQueryKey,
  getGetSiteSettingsQueryKey,
  getGetAiUsageRoutingQueryKey,
  type AiFunction,
  type AiRoutingOverviewFunctionsItem,
  type AiRoutingOverviewModelsItem,
} from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  RotateCcw,
  Save,
  Factory,
  CopyCheck,
  Newspaper,
  Mail,
  ChevronDown,
  AlertTriangle,
  Cpu,
} from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

const TIER_LABEL: Record<string, string> = {
  cheap: "Cheap",
  medium: "Mid",
  expensive: "Expensive",
};

const TIER_BADGE: Record<string, "secondary" | "default" | "destructive"> = {
  cheap: "secondary",
  medium: "default",
  expensive: "destructive",
};

function FunctionCard({
  fn,
  routing,
  models,
}: {
  fn: AiFunction;
  routing?: AiRoutingOverviewFunctionsItem;
  models: AiRoutingOverviewModelsItem[];
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(fn.directive);
  const [open, setOpen] = useState(false);

  // Re-sync the editor when the server view changes (after save/reset), but only
  // while the editor is collapsed so we never clobber an in-progress edit.
  useEffect(() => {
    if (!open) setDraft(fn.directive);
  }, [fn.directive, open]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getGetAiSettingsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetAiUsageRoutingQueryKey() });
  };

  const toggle = useUpdateAiFunction({
    mutation: {
      onSuccess: (res) => {
        toast.success(res.enabled ? `${res.label} enabled` : `${res.label} paused`);
        invalidate();
      },
      onError: () => toast.error("Failed to update function"),
    },
  });

  const setModel = useUpdateAiFunction({
    mutation: {
      onSuccess: () => {
        toast.success("Model updated");
        invalidate();
      },
      onError: () => toast.error("Failed to update model"),
    },
  });

  const save = useUpdateAiFunction({
    mutation: {
      onSuccess: () => {
        toast.success("Directive saved");
        invalidate();
      },
      onError: () => toast.error("Failed to save directive"),
    },
  });

  const reset = useResetAiFunction({
    mutation: {
      onSuccess: (res) => {
        setDraft(res.directive);
        toast.success("Reverted to default directive");
        invalidate();
      },
      onError: () => toast.error("Failed to reset directive"),
    },
  });

  const busy = toggle.isPending || save.isPending || reset.isPending;
  const dirty = draft !== fn.directive;

  return (
    <Card className="p-5 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-medium">{fn.label}</h3>
            {fn.isOverridden ? (
              <Badge variant="secondary" className="text-[10px]">Custom directive</Badge>
            ) : null}
            {!fn.enabled ? (
              <Badge variant="destructive" className="text-[10px]">Paused</Badge>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">{fn.description}</p>
        </div>
        <Switch
          checked={fn.enabled}
          disabled={toggle.isPending}
          onCheckedChange={(checked) =>
            toggle.mutate({ key: fn.key, data: { enabled: checked } })
          }
        />
      </div>

      {!fn.enabled ? (
        <p className="text-xs text-muted-foreground border-l-2 border-muted pl-3">
          While paused: {fn.degrade}
        </p>
      ) : null}

      {routing ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Cpu className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            {routing.usesImages ? (
              <span className="text-xs text-muted-foreground">
                Image model (fixed): <span className="font-medium text-foreground">{routing.model}</span>
              </span>
            ) : routing.perAuthorModel ? (
              <span className="text-xs text-muted-foreground">
                Model chosen per author — not routable here.
              </span>
            ) : (
              <>
                <Select
                  value={routing.model}
                  disabled={setModel.isPending}
                  onValueChange={(value) =>
                    setModel.mutate({ key: fn.key, data: { model: value } })
                  }
                >
                  <SelectTrigger className="h-8 w-[240px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((m) => (
                      <SelectItem key={m.id} value={m.id} className="text-xs">
                        {m.label} · {TIER_LABEL[m.tier] ?? m.tier}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {setModel.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                ) : null}
                {routing.modelOverride ? (
                  <button
                    type="button"
                    className="text-[11px] text-muted-foreground underline hover:text-foreground"
                    onClick={() => setModel.mutate({ key: fn.key, data: { model: null } })}
                  >
                    reset to default ({routing.defaultModel})
                  </button>
                ) : (
                  <Badge variant="outline" className="text-[10px]">Default</Badge>
                )}
              </>
            )}
            {!routing.usesImages ? (
              <Badge variant={TIER_BADGE[routing.costTier] ?? "secondary"} className="text-[10px]">
                {TIER_LABEL[routing.costTier] ?? routing.costTier}
              </Badge>
            ) : null}
            {routing.usesWebSearch ? (
              <Badge variant="outline" className="text-[10px]">Web search</Badge>
            ) : null}
            {routing.bulkEligible ? (
              <Badge variant="outline" className="text-[10px]">Bulk</Badge>
            ) : null}
          </div>
          {routing.warnings.map((w) => (
            <p
              key={w}
              className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-500 border-l-2 border-amber-400 pl-3"
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{w}</span>
            </p>
          ))}
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        {open ? "Hide directive" : "Edit directive"}
      </button>

      {open ? (
        <div className="space-y-2">
          {fn.placeholders.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Available placeholders (kept verbatim):{" "}
              {fn.placeholders.map((p) => (
                <code key={p} className="mx-0.5 rounded bg-muted px-1 py-0.5 text-[11px]">
                  {`{{${p}}}`}
                </code>
              ))}
            </p>
          ) : null}
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={10}
            className="font-mono text-xs leading-relaxed"
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={busy || !dirty}
              onClick={() => save.mutate({ key: fn.key, data: { directive: draft } })}
            >
              {save.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
              Save directive
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !fn.isOverridden}
              onClick={() => reset.mutate({ key: fn.key })}
            >
              {reset.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-2" />}
              Reset to default
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

export default function AiControl() {
  const { data, isLoading } = useGetAiSettings();
  const { data: siteSettings, isLoading: siteLoading } = useGetSiteSettings();
  const { data: routing } = useGetAiUsageRouting();
  const qc = useQueryClient();

  const routingByKey = new Map(
    (routing?.functions ?? []).map((f) => [f.key, f]),
  );
  const models = routing?.models ?? [];

  const updateSite = useUpdateSiteSettings({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetSiteSettingsQueryKey() });
      },
      onError: () => toast.error("Failed to update pipeline state"),
    },
  });

  if (isLoading || !data) {
    return <div className="p-4 md:p-8"><Loader2 className="animate-spin" /></div>;
  }

  const pipelines: {
    key: "pipelineEnabled" | "dedupeScanEnabled" | "weeklyNewsletterEnabled" | "dailyDigestEnabled";
    label: string;
    description: string;
    icon: typeof Factory;
    onLabel: string;
    offLabel: string;
  }[] = [
    {
      key: "pipelineEnabled",
      label: "Content pipeline",
      description:
        "Hourly automated job that generates ideas and drafts new articles. Pausing stops all automated drafting; scheduled articles still publish and the manual \"Run pipeline now\" button still works.",
      icon: Factory,
      onLabel: "Content pipeline resumed",
      offLabel: "Content pipeline paused",
    },
    {
      key: "dedupeScanEnabled",
      label: "Daily duplicate scan",
      description:
        "Daily AI scan that finds near-duplicate published articles and quarantines the newer one. Pausing stops the scheduled run; the manual \"Scan now\" button still works.",
      icon: CopyCheck,
      onLabel: "Daily dedup scan resumed",
      offLabel: "Daily dedup scan paused",
    },
    {
      key: "weeklyNewsletterEnabled",
      label: "Weekly newsletter blast",
      description:
        "Saturday roundup emailed to all active subscribers. Pausing stops the scheduled weekly send.",
      icon: Newspaper,
      onLabel: "Weekly newsletter resumed",
      offLabel: "Weekly newsletter paused",
    },
    {
      key: "dailyDigestEnabled",
      label: "Daily editorial digest",
      description:
        "After each daily pipeline run, an internal digest of new drafts and pending ideas is generated for admins. Pausing skips digest generation.",
      icon: Mail,
      onLabel: "Daily digest resumed",
      offLabel: "Daily digest paused",
    },
  ];

  return (
    <div className="p-4 md:p-8 space-y-10 max-w-4xl">
      <div>
        <h1 className="font-serif text-3xl font-bold">AI Control Center</h1>
        <p className="text-muted-foreground mt-1">
          Steer every AI function with a custom directive, pause individual functions (the pipeline
          degrades safely instead of breaking), and pause whole automated pipelines. Changes take
          effect within ~30 seconds without a redeploy.
        </p>
      </div>

      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="font-serif text-xl font-bold">Automated pipelines</h2>
          <p className="text-sm text-muted-foreground">Master switches for the scheduled jobs.</p>
        </div>
        <div className="grid gap-3">
          {pipelines.map((p) => {
            const Icon = p.icon;
            const checked = siteSettings?.[p.key] ?? false;
            return (
              <Card key={p.key} className="p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Icon className="h-4 w-4 text-muted-foreground" />
                      <h3 className="font-medium">{p.label}</h3>
                    </div>
                    <p className="text-sm text-muted-foreground">{p.description}</p>
                  </div>
                  <Switch
                    checked={checked}
                    disabled={siteLoading || updateSite.isPending}
                    onCheckedChange={(value) => {
                      updateSite.mutate(
                        { data: { [p.key]: value } },
                        {
                          onSuccess: () => toast.success(value ? p.onLabel : p.offLabel),
                        },
                      );
                    }}
                  />
                </div>
              </Card>
            );
          })}
        </div>
      </section>

      {routing ? (
        <section className="space-y-3">
          <Separator />
          <div className="space-y-1">
            <h2 className="font-serif text-xl font-bold">Model routing &amp; budget</h2>
            <p className="text-sm text-muted-foreground">
              Route non-critical functions off the expensive default model, and keep an eye on the
              spend guardrails that stop unattended bulk jobs.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Card className="p-4">
              <div className="text-2xl font-bold tabular-nums">
                {routing.budget.todaySpendUsd.toLocaleString(undefined, {
                  style: "currency",
                  currency: "USD",
                })}
              </div>
              <div className="text-xs text-muted-foreground mt-1">Spent today (UTC)</div>
            </Card>
            <Card className="p-4">
              <div className="text-2xl font-bold tabular-nums">
                ${routing.budget.dailyBudgetUsd.toLocaleString()}
              </div>
              <div className="text-xs text-muted-foreground mt-1">Daily bulk-job ceiling</div>
            </Card>
            <Card className="p-4">
              <div className="text-2xl font-bold tabular-nums">
                ${routing.budget.bulkRunBudgetUsd.toLocaleString()}
              </div>
              <div className="text-xs text-muted-foreground mt-1">Per-run ceiling</div>
            </Card>
            <Card className="p-4">
              <div className="flex items-center gap-2">
                <Badge variant={routing.budget.bulkJobsEnabled ? "secondary" : "destructive"}>
                  {routing.budget.bulkJobsEnabled ? "Enabled" : "Disabled"}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground mt-1">Unattended bulk jobs</div>
            </Card>
          </div>
        </section>
      ) : null}

      {data.groups.map((group) => {
        const fns = data.functions.filter((f) => f.group === group.id);
        if (fns.length === 0) return null;
        return (
          <section key={group.id} className="space-y-3">
            <Separator />
            <div className="space-y-1">
              <h2 className="font-serif text-xl font-bold">{group.label}</h2>
              <p className="text-sm text-muted-foreground">{group.description}</p>
            </div>
            <div className="grid gap-3">
              {fns.map((fn) => (
                <FunctionCard
                  key={fn.key}
                  fn={fn}
                  routing={routingByKey.get(fn.key)}
                  models={models}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

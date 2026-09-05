import { useEffect, useState } from "react";
import {
  usePreviewTermOfDay,
  useQueueTermOfDayNow,
  usePostTermOfDayDraft,
  useListTermOfDayHistory,
  useGetSiteSettings,
  useUpdateSiteSettings,
  useUpdateAdminConcept,
  getPreviewTermOfDayQueryKey,
  getListTermOfDayHistoryQueryKey,
  getGetSiteSettingsQueryKey,
  type TermOfDayCandidate,
  type TermOfDayHistoryItem,
  type TermOfDayRunResult,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  Dices,
  Send,
  BookOpen,
  History,
  ExternalLink,
  Settings2,
  ImageIcon,
  HelpCircle,
  Ban,
} from "lucide-react";
import { toast } from "sonner";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

function InfoTip({ children }: { children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <HelpCircle className="h-3.5 w-3.5 text-muted-foreground cursor-help inline-block align-text-bottom ml-1" />
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs leading-relaxed">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-amber-100 text-amber-800" },
  posting: { label: "Posting…", className: "bg-blue-100 text-blue-800" },
  posted: { label: "Posted", className: "bg-emerald-100 text-emerald-800" },
  failed: { label: "Failed", className: "bg-red-100 text-red-800" },
  skipped: { label: "Skipped", className: "bg-muted text-muted-foreground" },
};

function runResultToast(r: TermOfDayRunResult) {
  if (r.status === "posted") toast.success(`Posted "${r.slug ?? "term"}" to Facebook`);
  else if (r.status === "drafted") toast.success(`Drafted "${r.slug ?? "term"}" (draft-only mode)`);
  else if (r.status === "skipped") toast.info(`Skipped: ${r.reason ?? "no eligible term"}`);
  else if (r.status === "failed") toast.error(`Posting failed: ${r.reason ?? "unknown error"}`);
  else toast.info("Term of the Day is disabled");
}

function CandidateCard({ c }: { c: TermOfDayCandidate }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-serif text-2xl font-bold">{c.term}</span>
        <Badge variant="outline">{c.beatSlug || "no beat"}</Badge>
        {c.moduleType ? <Badge variant="outline">{c.moduleType}</Badge> : null}
        <Badge variant="secondary">weight {c.weight.toFixed(2)}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">{c.definition || c.hoverDefinition}</p>
      <div className="text-xs text-muted-foreground">
        {c.publishedArticleCount} linked article{c.publishedArticleCount === 1 ? "" : "s"}
        {c.lastPostedDate ? ` · last featured ${c.lastPostedDate}` : " · never featured"}
      </div>
      {c.cardImageUrl ? (
        <div className="pt-1">
          <div className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
            <ImageIcon className="h-3 w-3" /> Facebook card (will be attached to post)
          </div>
          <img
            src={c.cardImageUrl}
            alt={`${c.term} card`}
            className="rounded-lg border shadow-sm w-full"
          />
        </div>
      ) : (
        <div className="pt-1 text-xs text-amber-600 flex items-center gap-1.5">
          <ImageIcon className="h-3 w-3 shrink-0" />
          No card image captured — post will go text-only. Generate one in Glossary Cards.
        </div>
      )}
      {c.breakdown.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {c.breakdown.map((w, i) => (
            <span key={i} className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              {w.reason} {w.delta}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AdminTermOfDay() {
  const qc = useQueryClient();
  const [excluded, setExcluded] = useState<string[]>([]);
  const excludeParam = excluded.length ? { exclude: excluded.join(",") } : undefined;

  const { data: preview, isLoading: previewLoading, isFetching: previewFetching } =
    usePreviewTermOfDay(excludeParam);
  const { data: history, isLoading: historyLoading } = useListTermOfDayHistory({ limit: 30 });
  const { data: settings } = useGetSiteSettings();

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: getPreviewTermOfDayQueryKey() });
    qc.invalidateQueries({ queryKey: getListTermOfDayHistoryQueryKey() });
  };

  const queueNow = useQueueTermOfDayNow({
    mutation: {
      onSuccess: (r) => {
        runResultToast(r);
        invalidateAll();
      },
      onError: (e) => {
        const r = (e as { data?: TermOfDayRunResult })?.data;
        if (r?.status) {
          runResultToast(r);
        } else {
          toast.error("Failed to run Term of the Day");
        }
        invalidateAll();
      },
    },
  });

  const postDraft = usePostTermOfDayDraft({
    mutation: {
      onSuccess: (r) => {
        runResultToast(r);
        invalidateAll();
      },
      onError: (e) => {
        const r = (e as { data?: TermOfDayRunResult })?.data;
        if (r?.reason) toast.error(`Could not post draft: ${r.reason}`);
        else toast.error("Could not post draft");
        invalidateAll();
      },
    },
  });

  const updateSettings = useUpdateSiteSettings({
    mutation: {
      onSuccess: () => {
        toast.success("Term of the Day settings updated");
        qc.invalidateQueries({ queryKey: getGetSiteSettingsQueryKey() });
        qc.invalidateQueries({ queryKey: getPreviewTermOfDayQueryKey() });
      },
      onError: () => toast.error("Failed to update settings"),
    },
  });

  const reroll = () => {
    const slug = preview?.candidate?.slug;
    if (slug) setExcluded((prev) => (prev.includes(slug) ? prev : [...prev, slug]));
  };

  const blockConcept = useUpdateAdminConcept({
    mutation: {
      onSuccess: (updated) => {
        toast.success(`"${updated.term}" blocked from Term of the Day`);
        qc.invalidateQueries({ queryKey: getPreviewTermOfDayQueryKey() });
      },
      onError: () => toast.error("Failed to block term"),
    },
  });

  const blockTerm = (c: TermOfDayCandidate) => {
    if (blockConcept.isPending) return;
    if (!confirm(`Block "${c.term}" from ever being picked for Term of the Day?\n\nYou can undo this from the 4:5 card gallery (Media Library → Glossary FB Cards).`)) return;
    blockConcept.mutate({ id: c.conceptId, data: { termOfDayBlocked: true } });
    // Also drop it from this session's reroll pool immediately.
    setExcluded((prev) => (prev.includes(c.slug) ? prev : [...prev, c.slug]));
  };

  const busy = queueNow.isPending || postDraft.isPending;

  return (
    <div className="space-y-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="font-serif text-2xl font-bold flex items-center gap-2">
              <BookOpen className="h-6 w-6" /> Term of the Day
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              One glossary term posted to Facebook daily — deterministic selection, branded card, no AI.
            </p>
          </div>
          <Button onClick={() => queueNow.mutate({ data: { force: true, slug: preview?.candidate?.slug } })} disabled={busy}>
            {queueNow.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Send className="h-4 w-4 mr-2" />
            )}
            Queue today's post now
          </Button>
        </div>

        {/* Preview */}
        <Card className="p-5 space-y-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h2 className="font-semibold flex items-center gap-2">
              Today's pick (preview)
              {preview ? (
                <span className="text-xs font-normal text-muted-foreground">
                  {preview.poolSize} eligible term{preview.poolSize === 1 ? "" : "s"}
                </span>
              ) : null}
            </h2>
            <div className="flex items-center gap-2">
              {excluded.length > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setExcluded([])}>
                  Reset reroll
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => preview?.candidate && blockTerm(preview.candidate)}
                disabled={previewFetching || blockConcept.isPending || !preview?.candidate}
                className="text-destructive hover:text-destructive"
              >
                {blockConcept.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Ban className="h-4 w-4 mr-2" />
                )}
                Block term
              </Button>
              <Button variant="outline" size="sm" onClick={reroll} disabled={previewFetching || !preview?.candidate}>
                {previewFetching ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Dices className="h-4 w-4 mr-2" />
                )}
                Reroll
              </Button>
            </div>
          </div>

          {previewLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Building preview…
            </div>
          ) : preview?.candidate ? (
            <div className="grid md:grid-cols-2 gap-5 items-start">
              <CandidateCard c={preview.candidate} />
              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Facebook caption
                </Label>
                <pre className="text-sm whitespace-pre-wrap bg-muted/50 rounded-md p-3 font-sans">
                  {preview.caption}
                </pre>
                {preview.trackedUrl && (
                  <div className="text-xs text-muted-foreground break-all">
                    Link: {preview.trackedUrl}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No eligible term right now — check cooldowns, beat filters, and the minimum-articles setting.
            </p>
          )}

          {preview && preview.topCandidates.length > 0 && (
            <details className="pt-1">
              <summary className="text-sm text-muted-foreground cursor-pointer select-none">
                Top candidates by weight
              </summary>
              <div className="mt-2 divide-y border rounded-md">
                {preview.topCandidates.map((c) => (
                  <div key={c.slug} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                    <span className="truncate">{c.term}</span>
                    <span className="flex items-center gap-2 shrink-0">
                      <Badge variant="outline" className="text-[11px]">{c.beatSlug || "—"}</Badge>
                      <span className="tabular-nums text-muted-foreground">{c.weight.toFixed(2)}</span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground hover:text-destructive"
                            disabled={blockConcept.isPending}
                            onClick={() => blockTerm(c)}
                          >
                            <Ban className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Block from Term of the Day</TooltipContent>
                      </Tooltip>
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </Card>

        {/* Settings */}
        <Card className="p-5 space-y-4">
          <h2 className="font-semibold flex items-center gap-2">
            <Settings2 className="h-4 w-4" /> Settings
          </h2>
          {!settings ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="flex items-center justify-between gap-3 border rounded-md p-3">
                  <div>
                    <div className="text-sm font-medium">Enabled</div>
                    <div className="text-xs text-muted-foreground">Daily automated post</div>
                  </div>
                  <Switch
                    checked={settings.termOfDayEnabled}
                    onCheckedChange={(v) => updateSettings.mutate({ data: { termOfDayEnabled: v } })}
                  />
                </div>
                <div className="flex items-center justify-between gap-3 border rounded-md p-3">
                  <div>
                    <div className="text-sm font-medium">Draft-only</div>
                    <div className="text-xs text-muted-foreground">Hold for review, never auto-send</div>
                  </div>
                  <Switch
                    checked={settings.termOfDayDraftOnly}
                    onCheckedChange={(v) => updateSettings.mutate({ data: { termOfDayDraftOnly: v } })}
                  />
                </div>
                <div className="flex items-center justify-between gap-3 border rounded-md p-3">
                  <div>
                    <div className="text-sm font-medium">Card image</div>
                    <div className="text-xs text-muted-foreground">Branded template card</div>
                  </div>
                  <Switch
                    checked={settings.termOfDayImageEnabled}
                    onCheckedChange={(v) => updateSettings.mutate({ data: { termOfDayImageEnabled: v } })}
                  />
                </div>
                <div className="flex items-center justify-between gap-3 border rounded-md p-3">
                  <div>
                    <div className="text-sm font-medium">Engagement weighting</div>
                    <div className="text-xs text-muted-foreground">Boost terms that performed</div>
                  </div>
                  <Switch
                    checked={settings.termOfDayEngagementWeighting}
                    onCheckedChange={(v) =>
                      updateSettings.mutate({ data: { termOfDayEngagementWeighting: v } })
                    }
                  />
                </div>
              </div>

              <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">
                    Post hour (UTC)
                    <InfoTip>
                      The UTC hour when the first daily Term of the Day is posted. Only one post per slot per calendar day is attempted. If the time has already passed, it triggers immediately.
                    </InfoTip>
                  </Label>
                  <Select
                    value={String(settings.termOfDayHourUtc)}
                    onValueChange={(v) => updateSettings.mutate({ data: { termOfDayHourUtc: Number(v) } })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 24 }, (_, h) => (
                        <SelectItem key={h} value={String(h)}>
                          {String(h).padStart(2, "0")}:00 UTC
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">
                    Second post hour (UTC)
                    <InfoTip>
                      Optional second Term of the Day post each day, with a different term. Set to Off to post only once per day. Note: two posts per day use up the term pool twice as fast under the cooldown.
                    </InfoTip>
                  </Label>
                  <Select
                    value={settings.termOfDayHour2Utc === null ? "off" : String(settings.termOfDayHour2Utc)}
                    onValueChange={(v) =>
                      updateSettings.mutate({ data: { termOfDayHour2Utc: v === "off" ? null : Number(v) } })
                    }
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="off">Off (once per day)</SelectItem>
                      {Array.from({ length: 24 }, (_, h) => (
                        <SelectItem key={h} value={String(h)}>
                          {String(h).padStart(2, "0")}:00 UTC
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <NumberSetting
                  label={
                    <span>
                      Cooldown (days)
                      <InfoTip>
                        After a term is posted (or drafted), how many days must pass before it is eligible again. Minimum 180 days — posted terms always stay out of the pool for at least six months. A longer cooldown increases variety but may exhaust the pool on small catalogs.
                      </InfoTip>
                    </span>
                  }
                  value={settings.termOfDayCooldownDays}
                  min={180}
                  max={3650}
                  onSave={(n) => updateSettings.mutate({ data: { termOfDayCooldownDays: n } })}
                />
                <NumberSetting
                  label={
                    <span>
                      Min linked articles
                      <InfoTip>
                        A concept must have at least this many linked BrainHook articles to qualify. Raising this filters out thin terms and ensures every post has a meaty back-catalog to point readers to.
                      </InfoTip>
                    </span>
                  }
                  value={settings.termOfDayMinArticles}
                  min={0}
                  max={50}
                  onSave={(n) => updateSettings.mutate({ data: { termOfDayMinArticles: n } })}
                />
                <NumberSetting
                  label={
                    <span>
                      Max hashtags
                      <InfoTip>
                        The most hashtags appended to the Facebook caption. The engine picks from the concept's category, sub-category, and top terms, then trims to this cap.
                      </InfoTip>
                    </span>
                  }
                  value={settings.termOfDayMaxHashtags}
                  min={2}
                  max={15}
                  onSave={(n) => updateSettings.mutate({ data: { termOfDayMaxHashtags: n } })}
                />
              </div>

              <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <NumberSetting
                  label={
                    <span>
                      General-interest strength
                      <InfoTip>
                        How strongly to boost terms whose articles span many categories (science, space, tech, etc.). Higher values favor broad-appeal topics; zero disables this entirely and treats all terms equally.
                      </InfoTip>
                    </span>
                  }
                  value={settings.termOfDayGeneralInterestStrength}
                  min={0}
                  max={3}
                  step={0.1}
                  onSave={(n) => updateSettings.mutate({ data: { termOfDayGeneralInterestStrength: n } })}
                />
                <NumberSetting
                  label={
                    <span>
                      Technical-penalty strength
                      <InfoTip>
                        How strongly to penalize highly technical jargon terms. A value of 1 is the full penalty; 0 means no suppression. This keeps the feed from reading like an index instead of a magazine.
                      </InfoTip>
                    </span>
                  }
                  value={settings.termOfDayTechnicalPenaltyStrength}
                  min={0}
                  max={1}
                  step={0.1}
                  onSave={(n) => updateSettings.mutate({ data: { termOfDayTechnicalPenaltyStrength: n } })}
                />
                <NumberSetting
                  label={
                    <span>
                      Beat-balance window
                      <InfoTip>
                        The number of most-recent posts the engine looks back to enforce beat diversity. If the last N posts are all from the same category, the next pick gets a steep penalty so no single beat hogs the feed.
                      </InfoTip>
                    </span>
                  }
                  value={settings.termOfDayBeatWindow}
                  min={0}
                  max={60}
                  onSave={(n) => updateSettings.mutate({ data: { termOfDayBeatWindow: n } })}
                />
              </div>

              <div className="grid sm:grid-cols-3 gap-4">
                <ListSetting
                  label={
                    <span>
                      Included beats (empty = all)
                      <InfoTip>
                        If you enter slugs (e.g. "science,space"), only concepts whose dominant beat matches one of these are eligible. Leave blank to allow all beats. Useful for themed weeks or curation experiments.
                      </InfoTip>
                    </span>
                  }
                  value={settings.termOfDayIncludedBeats}
                  onSave={(v) => updateSettings.mutate({ data: { termOfDayIncludedBeats: v } })}
                />
                <ListSetting
                  label={
                    <span>
                      Excluded beats
                      <InfoTip>
                        Enter beat slugs (e.g. "politics,opinion") to permanently remove those categories from the daily pool. This overrides any inclusion list — a beat that is both included and excluded is excluded.
                      </InfoTip>
                    </span>
                  }
                  value={settings.termOfDayExcludedBeats}
                  onSave={(v) => updateSettings.mutate({ data: { termOfDayExcludedBeats: v } })}
                />
                <ListSetting
                  label={
                    <span>
                      Excluded module types
                      <InfoTip>
                        Some concepts have a content module type (e.g. "newsletter", "explainer", "fact-check"). Enter module names here to skip those shapes. If you exclude the only module a term has, it becomes ineligible.
                      </InfoTip>
                    </span>
                  }
                  value={settings.termOfDayExcludedModuleTypes}
                  onSave={(v) => updateSettings.mutate({ data: { termOfDayExcludedModuleTypes: v } })}
                />
              </div>
            </div>
          )}
        </Card>

        {/* History */}
        <Card className="p-5 space-y-3">
          <h2 className="font-semibold flex items-center gap-2">
            <History className="h-4 w-4" /> History
            {history ? (
              <span className="text-xs font-normal text-muted-foreground">{history.total} total</span>
            ) : null}
          </h2>
          {historyLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : !history || history.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No posts yet. Use "Queue today's post now" to run the first one.
            </p>
          ) : (
            <div className="divide-y border rounded-md">
              {history.items.map((item) => (
                <HistoryRow
                  key={item.id}
                  item={item}
                  onPostDraft={(id) => postDraft.mutate({ id, data: { force: true } })}
                  posting={postDraft.isPending}
                />
              ))}
            </div>
          )}
        </Card>
    </div>
  );
}

function NumberSetting({
  label,
  value,
  min,
  max,
  step,
  onSave,
}: {
  label: React.ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  onSave: (n: number) => void;
}) {
  const [draft, setDraft] = useState<string>(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);
  const changed = Number(draft) !== value && draft !== "";
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <div className="flex gap-2">
        <Input
          type="number"
          value={draft}
          min={min}
          max={max}
          step={step ?? 1}
          onChange={(e) => setDraft(e.target.value)}
        />
        {changed && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const n = Number(draft);
              if (Number.isNaN(n) || n < min || n > max) {
                toast.error(`Must be between ${min} and ${max}`);
                return;
              }
              onSave(n);
            }}
          >
            Save
          </Button>
        )}
      </div>
    </div>
  );
}

function ListSetting({
  label,
  value,
  onSave,
}: {
  label: React.ReactNode;
  value: string[];
  onSave: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState<string>(value.join(", "));
  const serverValue = value.join(", ");
  useEffect(() => {
    setDraft(serverValue);
  }, [serverValue]);
  const parsed = draft.split(",").map((s) => s.trim()).filter(Boolean);
  const changed = parsed.join(",") !== value.join(",");
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <div className="flex gap-2">
        <Input
          value={draft}
          placeholder="comma-separated slugs"
          onChange={(e) => setDraft(e.target.value)}
        />
        {changed && (
          <Button size="sm" variant="outline" onClick={() => onSave(parsed)}>
            Save
          </Button>
        )}
      </div>
    </div>
  );
}

function HistoryRow({
  item,
  onPostDraft,
  posting,
}: {
  item: TermOfDayHistoryItem;
  posting: boolean;
  onPostDraft: (id: string) => void;
}) {
  const badge = STATUS_BADGE[item.status] ?? STATUS_BADGE.skipped;
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 text-sm flex-wrap">
      <span className="tabular-nums text-muted-foreground shrink-0">{item.postDate}</span>
      <span className="font-medium truncate max-w-[16rem]">{item.term}</span>
      <Badge variant="outline" className="text-[11px]">{item.beatSlug || "—"}</Badge>
      <Badge className={`text-[11px] ${badge.className}`} variant="secondary">
        {badge.label}
      </Badge>
      {item.imageUrl && (
        <span title="Has card image">
          <ImageIcon className="h-3.5 w-3.5 text-muted-foreground" />
        </span>
      )}
      {item.failureReason && (
        <span className="text-xs text-red-600 truncate max-w-[18rem]" title={item.failureReason}>
          {item.failureReason}
        </span>
      )}
      <span className="flex-1" />
      {item.status === "draft" && (
        <Button size="sm" variant="outline" onClick={() => onPostDraft(item.id)} disabled={posting}>
          {posting ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1.5" />}
          Post now
        </Button>
      )}
      {item.facebookPostUrl && (
        <a
          href={item.facebookPostUrl}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground hover:text-foreground"
          title="View on Facebook"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
      )}
    </div>
  );
}

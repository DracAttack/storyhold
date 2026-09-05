import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  BookOpenCheck,
  Check,
  ChevronDown,
  ChevronUp,
  Coins,
  Feather,
  Loader2,
  LockKeyhole,
  Save,
  Sparkles,
} from "lucide-react";
import { Link, useParams } from "wouter";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ProfileFrame } from "@/components/customer/profile-frame";
import { useAuth } from "@/lib/auth";
import { useSeo } from "@/lib/seo";
import {
  createCampaignStoryDraft,
  getCampaignStory,
  StoryholdApiError,
  updateCampaignStoryDraft,
  type CampaignStoryDraft,
  type CampaignStorySession,
} from "@/lib/storyholdApi";

function requestId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `story_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

type StoryGenerationInput = {
  turnIds: string[];
  title: string;
  settings: {
    pov: "first_person" | "third_limited" | "third_omniscient";
    tense: "past" | "present";
    length: "scene" | "chapter";
    fidelity: "strict" | "novelistic";
    voiceNotes: string;
  };
};

type PendingStoryGeneration = {
  version: 2;
  campaignId: string;
  fingerprint: string;
  playerId: string;
  requestId: string;
};

function generationStorageKey(playerId: string, campaignId: string) {
  return `storyhold:pending-story-generation:${playerId}:${campaignId}`;
}

function generationFingerprint(value: string) {
  // Keep private titles, notes, and scene selections out of browser storage.
  // Once work reaches the server, the exact request is frozen there instead.
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ (code + index), 0x85ebca6b);
  }
  return `${(left >>> 0).toString(36)}:${(right >>> 0).toString(36)}:${value.length}`;
}

function pendingFingerprint(
  campaignId: string,
  input: StoryGenerationInput,
) {
  return generationFingerprint(JSON.stringify({
    campaignId,
    turnIds: input.turnIds,
    title: input.title,
    settings: {
      pov: input.settings.pov,
      tense: input.settings.tense,
      length: input.settings.length,
      fidelity: input.settings.fidelity,
      voiceNotes: input.settings.voiceNotes,
    },
  }));
}

function readPendingGeneration(
  playerId: string,
  campaignId: string,
): PendingStoryGeneration | null {
  const key = generationStorageKey(playerId, campaignId);
  try {
    const parsed = JSON.parse(
      sessionStorage.getItem(key) || "null",
    ) as Partial<PendingStoryGeneration> | null;
    const structurallyValid = parsed?.version === 2 && parsed.playerId === playerId &&
      parsed.campaignId === campaignId && typeof parsed.fingerprint === "string" &&
      /^[a-z0-9]+:[a-z0-9]+:\d+$/i.test(parsed.fingerprint) &&
      typeof parsed.requestId === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(parsed.requestId) &&
      parsed.requestId.length <= 80;
    if (!structurallyValid) {
      sessionStorage.removeItem(key);
      return null;
    }
    return parsed as PendingStoryGeneration;
  } catch {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // Storage may itself be blocked. There is nothing else to clean up.
    }
    return null;
  }
}

function writePendingGeneration(
  playerId: string,
  campaignId: string,
  pending: PendingStoryGeneration | null,
) {
  try {
    const key = generationStorageKey(playerId, campaignId);
    if (pending) sessionStorage.setItem(key, JSON.stringify(pending));
    else sessionStorage.removeItem(key);
  } catch {
    // A blocked storage API must not prevent Story Studio from running; the
    // in-memory request identity still protects ordinary retries in this tab.
  }
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : "Story Studio could not finish that work.";
}

export default function CampaignStory() {
  const auth = useAuth();
  const { id = "" } = useParams<{ id: string }>();
  const [session, setSession] = useState<CampaignStorySession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState("");
  const [pov, setPov] = useState<"first_person" | "third_limited" | "third_omniscient">("third_limited");
  const [tense, setTense] = useState<"past" | "present">("past");
  const [length, setLength] = useState<"scene" | "chapter">("chapter");
  const [fidelity, setFidelity] = useState<"strict" | "novelistic">("strict");
  const [voiceNotes, setVoiceNotes] = useState("");
  const [generating, setGenerating] = useState(false);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftProse, setDraftProse] = useState("");
  const [saving, setSaving] = useState(false);
  const pendingGenerationRef = useRef<PendingStoryGeneration | null>(null);
  const generationInFlightRef = useRef<string | null>(null);
  const pageIdentity = `${auth.userId ?? "signed-out"}:${id}`;
  const pageIdentityRef = useRef(pageIdentity);
  const loadedSessionIdentityRef = useRef<string | null>(null);
  pageIdentityRef.current = pageIdentity;
  const sessionIsCurrent = Boolean(
    session && loadedSessionIdentityRef.current === pageIdentity,
  );

  const activeDraft = useMemo(
    () => session?.drafts.find((draft) => draft.id === activeDraftId) ?? null,
    [activeDraftId, session?.drafts],
  );

  useSeo({
    title: sessionIsCurrent && session
      ? `${session.campaign.name} — Story Studio`
      : "Story Studio",
    description: "Shape committed Storyhold scenes into editable fiction.",
    canonicalPath: `/profile/campaigns/${id}/story`,
    noindex: true,
  });

  useEffect(() => {
    pendingGenerationRef.current = null;
    generationInFlightRef.current = null;
    loadedSessionIdentityRef.current = null;
    setSession(null);
    setError(null);
    setSelectedIds([]);
    setExpandedIds(new Set());
    setTitle("");
    setPov("third_limited");
    setTense("past");
    setLength("chapter");
    setFidelity("strict");
    setVoiceNotes("");
    setGenerating(false);
    setActiveDraftId(null);
    setDraftTitle("");
    setDraftProse("");
    const playerId = auth.userId;
    if (!playerId || !id) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    void getCampaignStory(id)
      .then((response) => {
        if (!active) return;
        loadedSessionIdentityRef.current = `${playerId}:${response.campaign.id}`;
        setSession(response);
        const latest = response.drafts[0];
        if (latest) setActiveDraftId(latest.id);
        const saved = response.pendingAdaptation;
        if (saved) {
          const savedInput: StoryGenerationInput = {
            turnIds: saved.turnIds,
            title: saved.title,
            settings: saved.settings,
          };
          const pending: PendingStoryGeneration = {
            version: 2,
            playerId,
            campaignId: response.campaign.id,
            requestId: saved.requestId,
            fingerprint: pendingFingerprint(response.campaign.id, savedInput),
          };
          pendingGenerationRef.current = pending;
          writePendingGeneration(playerId, response.campaign.id, pending);
          setSelectedIds(saved.turnIds);
          setTitle(saved.title);
          setPov(saved.settings.pov);
          setTense(saved.settings.tense);
          setLength(saved.settings.length);
          setFidelity(saved.settings.fidelity);
          setVoiceNotes(saved.settings.voiceNotes);
          setError(
            "Story Studio restored an unfinished adaptation. Choose Generate to continue the same saved work.",
          );
        } else {
          pendingGenerationRef.current = null;
          writePendingGeneration(playerId, response.campaign.id, null);
          const recent = response.storyBeats.slice(-Math.min(8, response.limits.maxSelectedTurns));
          setSelectedIds(recent.map((beat) => beat.id));
        }
      })
      .catch((reason) => {
        if (active) setError(errorMessage(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [auth.userId, id]);

  useEffect(() => {
    if (!activeDraft) return;
    setDraftTitle(activeDraft.title);
    setDraftProse(activeDraft.prose);
  }, [activeDraft]);

  const selectBeat = (beatId: string) => {
    if (!session) return;
    const orderedIds = session.storyBeats.map((beat) => beat.id);
    const clicked = orderedIds.indexOf(beatId);
    if (clicked < 0) return;
    if (!selectedIds.length) {
      setSelectedIds([beatId]);
      return;
    }
    const selectedIndexes = selectedIds.map((selected) => orderedIds.indexOf(selected));
    const first = Math.min(...selectedIndexes);
    const last = Math.max(...selectedIndexes);
    if (selectedIds.includes(beatId)) {
      if (selectedIds.length === 1) setSelectedIds([]);
      else if (clicked === first) setSelectedIds(orderedIds.slice(first + 1, last + 1));
      else if (clicked === last) setSelectedIds(orderedIds.slice(first, last));
      else setSelectedIds([beatId]);
      return;
    }
    const nextFirst = Math.min(first, clicked);
    const nextLast = Math.max(last, clicked);
    const range = orderedIds.slice(nextFirst, nextLast + 1);
    if (range.length > session.limits.maxSelectedTurns) {
      toast.error(`A single draft can use up to ${session.limits.maxSelectedTurns} scenes.`);
      return;
    }
    setSelectedIds(range);
  };

  const generate = async () => {
    if (!auth.userId || !session || selectedIds.length === 0 || generationInFlightRef.current) return;
    const requestedPageIdentity = `${auth.userId}:${session.campaign.id}`;
    const settings = { pov, tense, length, fidelity, voiceNotes };
    const input = {
      turnIds: selectedIds,
      title,
      settings,
    };
    const fingerprint = pendingFingerprint(session.campaign.id, input);
    let pending = pendingGenerationRef.current ??
      readPendingGeneration(auth.userId, session.campaign.id);
    if (pending && pending.fingerprint !== fingerprint) {
      const saved = session.pendingAdaptation;
      if (saved?.requestId === pending.requestId) {
        pendingGenerationRef.current = pending;
        setSelectedIds(saved.turnIds);
        setTitle(saved.title);
        setPov(saved.settings.pov);
        setTense(saved.settings.tense);
        setLength(saved.settings.length);
        setFidelity(saved.settings.fidelity);
        setVoiceNotes(saved.settings.voiceNotes);
        const message = "A saved adaptation is still waiting. Story Studio restored its scenes and settings; choose Generate again to finish that same work.";
        setError(message);
        toast.error(message);
        return;
      }
      pendingGenerationRef.current = null;
      writePendingGeneration(auth.userId, session.campaign.id, null);
      pending = null;
    }
    const generationRequestId = pending?.fingerprint === fingerprint
      ? pending.requestId
      : requestId();
    pendingGenerationRef.current = {
      version: 2,
      campaignId: session.campaign.id,
      fingerprint,
      playerId: auth.userId,
      requestId: generationRequestId,
    };
    writePendingGeneration(auth.userId, session.campaign.id, pendingGenerationRef.current);
    generationInFlightRef.current = generationRequestId;
    setGenerating(true);
    setError(null);
    try {
      const response = await createCampaignStoryDraft({
        campaignId: session.campaign.id,
        turnIds: selectedIds,
        requestId: generationRequestId,
        title,
        settings,
      });
      if (pendingGenerationRef.current?.requestId === generationRequestId) {
        pendingGenerationRef.current = null;
      }
      writePendingGeneration(auth.userId, session.campaign.id, null);
      if (pageIdentityRef.current !== requestedPageIdentity) return;
      setSession((current) =>
        current
          ? {
              ...current,
              drafts: [response.draft, ...current.drafts.filter((draft) => draft.id !== response.draft.id)],
              credits: response.creditsRemaining ?? current.credits,
              pendingAdaptation: null,
            }
          : current,
      );
      setActiveDraftId(response.draft.id);
      toast.success("Your chapter draft is ready. The campaign itself was not changed.");
    } catch (reason) {
      const terminalClientError = reason instanceof StoryholdApiError &&
        reason.status >= 400 && reason.status < 500 && reason.status !== 409 &&
        reason.payload.retrySameRequest !== true;
      const terminalRequest = reason instanceof StoryholdApiError &&
        (reason.payload.retrySameRequest === false || terminalClientError);
      if (terminalRequest) {
        if (pendingGenerationRef.current?.requestId === generationRequestId) {
          pendingGenerationRef.current = null;
        }
        writePendingGeneration(auth.userId, session.campaign.id, null);
        setSession((current) => current ? { ...current, pendingAdaptation: null } : current);
      } else {
        setSession((current) => current ? {
          ...current,
          pendingAdaptation: {
            requestId: generationRequestId,
            turnIds: [...selectedIds],
            title,
            settings,
            createdAt: new Date().toISOString(),
          },
        } : current);
      }
      if (pageIdentityRef.current !== requestedPageIdentity) return;
      const message = errorMessage(reason);
      setError(message);
      toast.error(message);
    } finally {
      if (generationInFlightRef.current === generationRequestId) {
        generationInFlightRef.current = null;
        setGenerating(false);
      }
    }
  };

  const saveDraft = async () => {
    if (!session || !activeDraft) return;
    setSaving(true);
    try {
      const response = await updateCampaignStoryDraft({
        campaignId: session.campaign.id,
        draftId: activeDraft.id,
        revision: activeDraft.revision,
        title: draftTitle,
        prose: draftProse,
      });
      setSession((current) =>
        current
          ? {
              ...current,
              drafts: current.drafts.map((draft) =>
                draft.id === response.draft.id ? response.draft : draft,
              ),
            }
          : current,
      );
      toast.success(`Saved revision ${response.draft.revision}.`);
    } catch (reason) {
      toast.error(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ProfileFrame>
      {loading || (session !== null && !sessionIsCurrent) ? (
        <div className="grid min-h-[55vh] place-items-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : error && !sessionIsCurrent ? (
        <Card className="rounded-3xl border-red-400/20 bg-red-400/[0.05] p-7">
          <h1 className="font-serif text-3xl font-bold">Story Studio Could Not Open.</h1>
          <p className="mt-3 text-sm text-muted-foreground">{error}</p>
        </Card>
      ) : sessionIsCurrent && session ? (
        <div className="space-y-6">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <Link
                href={`/profile/campaigns/${session.campaign.id}/play`}
                className="inline-flex items-center text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft className="mr-2 h-4 w-4" /> Back to the game
              </Link>
              <p className="mt-6 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                {session.campaign.worldName}
              </p>
              <h1 className="mt-2 font-serif text-4xl font-bold">Story Studio</h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
                Choose what really happened, then shape it into fiction. Drafts are editable and cannot alter campaign canon.
              </p>
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-white/8 bg-white/[0.025] px-4 py-3 text-sm">
              <Coins className="h-4 w-4 text-primary" />
              <span className="text-muted-foreground">Credits</span>
              <strong>{session.unlimitedCredits ? "Unlimited" : session.credits}</strong>
            </div>
          </div>

          {session.storyBeats.length === 0 ? (
            <Card className="rounded-3xl border-white/8 bg-white/[0.025] p-10 text-center">
              <BookOpenCheck className="mx-auto h-9 w-9 text-primary" />
              <h2 className="mt-5 font-serif text-2xl font-bold">The First Scene Is Still Waiting.</h2>
              <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-muted-foreground">
                Once you accept a few campaign turns, they will appear here as chapter-ready story beats.
              </p>
              <Button asChild className="mt-6 rounded-xl">
                <Link href={`/profile/campaigns/${session.campaign.id}/play`}>Return to the game</Link>
              </Button>
            </Card>
          ) : (
            <div className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(380px,1.05fr)]">
              <section className="min-w-0 space-y-4">
                <Card className="rounded-3xl border-white/8 bg-white/[0.025] p-5 sm:p-6">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Scene Ledger</p>
                      <h2 className="mt-2 font-serif text-2xl font-bold">What Actually Happened</h2>
                      <p className="mt-2 text-xs leading-5 text-muted-foreground">
                        Select one continuous run. Clicking farther away includes the scenes between.
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="rounded-lg"
                        onClick={() =>
                          setSelectedIds(
                            session.storyBeats
                              .slice(-Math.min(8, session.limits.maxSelectedTurns))
                              .map((beat) => beat.id),
                          )
                        }
                      >
                        Recent scenes
                      </Button>
                      <Button variant="ghost" size="sm" className="rounded-lg" onClick={() => setSelectedIds([])}>
                        Clear
                      </Button>
                    </div>
                  </div>
                  <div className="mt-5 max-h-[720px] space-y-2 overflow-y-auto pr-1">
                    {session.storyBeats.map((beat) => {
                      const selected = selectedIds.includes(beat.id);
                      const expanded = expandedIds.has(beat.id);
                      return (
                        <article
                          key={beat.id}
                          className={`rounded-2xl border p-4 transition-colors ${
                            selected
                              ? "border-primary/40 bg-primary/[0.075]"
                              : "border-white/8 bg-black/15 hover:border-white/15"
                          }`}
                        >
                          <div className="flex items-start gap-3">
                            <button
                              type="button"
                              onClick={() => selectBeat(beat.id)}
                              aria-pressed={selected}
                              className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md border transition-colors ${
                                selected
                                  ? "border-primary bg-primary text-primary-foreground"
                                  : "border-white/15 text-transparent hover:border-primary/40"
                              }`}
                            >
                              <Check className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => selectBeat(beat.id)}
                              className="min-w-0 flex-1 text-left"
                            >
                              <div className="flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                                <span>Turn {beat.turnNumber}</span>
                                {beat.worldTimeLabel ? <span>{beat.worldTimeLabel}</span> : null}
                                {beat.outcome !== "none" ? <Badge variant="outline" className="h-5 px-1.5 text-[9px]">{beat.outcome}</Badge> : null}
                              </div>
                              <h3 className="mt-2 text-sm font-semibold leading-6">
                                {beat.sceneSummary || beat.playerAction}
                              </h3>
                            </button>
                            <button
                              type="button"
                              aria-label={expanded ? "Collapse scene" : "Expand scene"}
                              onClick={() =>
                                setExpandedIds((current) => {
                                  const next = new Set(current);
                                  if (next.has(beat.id)) next.delete(beat.id);
                                  else next.add(beat.id);
                                  return next;
                                })
                              }
                              className="rounded-lg p-1.5 text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
                            >
                              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                            </button>
                          </div>
                          {expanded ? (
                            <div className="mt-4 border-t border-white/8 pt-4">
                              <p className="text-xs font-semibold text-primary">Player</p>
                              <p className="mt-1 text-sm leading-6 text-muted-foreground">{beat.playerAction}</p>
                              <p className="mt-4 whitespace-pre-wrap font-serif text-[15px] leading-7 text-foreground/85">{beat.narration}</p>
                              {beat.consequences.length ? (
                                <div className="mt-4 flex flex-wrap gap-2">
                                  {beat.consequences.slice(0, 5).map((change, index) => (
                                    <Badge key={`${change.subject}-${index}`} variant="outline" className="border-white/10 text-[10px]">
                                      {change.subject}: {change.summary}
                                    </Badge>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                </Card>
              </section>

              <section className="min-w-0 space-y-4">
                <Card className="rounded-3xl border-white/8 bg-white/[0.025] p-5 sm:p-6">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Shape the Draft</p>
                      <h2 className="mt-2 font-serif text-2xl font-bold">From Play to Prose</h2>
                    </div>
                    <Badge variant="outline" className="border-primary/20 text-primary">
                      {selectedIds.length} scene{selectedIds.length === 1 ? "" : "s"}
                    </Badge>
                  </div>
                  <div className="mt-5 space-y-4">
                    <label className="block text-sm font-medium">
                      Working title <span className="font-normal text-muted-foreground">(optional)</span>
                      <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} className="mt-2 h-11 rounded-xl bg-black/20" placeholder="Let Storyhold choose" />
                    </label>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="text-sm font-medium">Point of view
                        <Select value={pov} onValueChange={(value) => setPov(value as typeof pov)}>
                          <SelectTrigger className="mt-2 h-11 rounded-xl bg-[#17151a]"><SelectValue /></SelectTrigger>
                          <SelectContent><SelectItem value="third_limited">Third person, close</SelectItem><SelectItem value="first_person">First person</SelectItem><SelectItem value="third_omniscient">Third person, wide</SelectItem></SelectContent>
                        </Select>
                      </label>
                      <label className="text-sm font-medium">Tense
                        <Select value={tense} onValueChange={(value) => setTense(value as typeof tense)}>
                          <SelectTrigger className="mt-2 h-11 rounded-xl bg-[#17151a]"><SelectValue /></SelectTrigger>
                          <SelectContent><SelectItem value="past">Past tense</SelectItem><SelectItem value="present">Present tense</SelectItem></SelectContent>
                        </Select>
                      </label>
                      <label className="text-sm font-medium">Draft size
                        <Select value={length} onValueChange={(value) => setLength(value as typeof length)}>
                          <SelectTrigger className="mt-2 h-11 rounded-xl bg-[#17151a]"><SelectValue /></SelectTrigger>
                          <SelectContent><SelectItem value="chapter">Full chapter</SelectItem><SelectItem value="scene">Single scene</SelectItem></SelectContent>
                        </Select>
                      </label>
                      <label className="text-sm font-medium">Adaptation style
                        <Select value={fidelity} onValueChange={(value) => setFidelity(value as typeof fidelity)}>
                          <SelectTrigger className="mt-2 h-11 rounded-xl bg-[#17151a]"><SelectValue /></SelectTrigger>
                          <SelectContent><SelectItem value="strict">Strictly faithful</SelectItem><SelectItem value="novelistic">More novelistic texture</SelectItem></SelectContent>
                        </Select>
                      </label>
                    </div>
                    <label className="block text-sm font-medium">Voice notes <span className="font-normal text-muted-foreground">(optional)</span>
                      <Textarea value={voiceNotes} onChange={(event) => setVoiceNotes(event.target.value)} maxLength={800} className="mt-2 min-h-20 rounded-xl bg-black/20" placeholder="Spare and tense, close to Addison's perspective…" />
                    </label>
                    <div className="rounded-xl border border-white/8 bg-black/15 p-3 text-xs leading-5 text-muted-foreground">
                      <LockKeyhole className="mr-1.5 inline h-3.5 w-3.5 text-primary" />
                      Story Studio can enrich description and transitions. It cannot change accepted outcomes or add new canon.
                    </div>
                    {error ? <p className="rounded-xl border border-red-400/20 bg-red-400/[0.05] p-3 text-sm text-red-200">{error}</p> : null}
                    <Button className="h-12 w-full rounded-xl" disabled={generating || selectedIds.length === 0 || !session.runtime.configured} onClick={generate}>
                      {generating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                      {generating ? "Shaping your draft…" : "Create story draft"}
                    </Button>
                    {!session.runtime.configured ? <p className="text-center text-xs text-amber-200">Connect a storyteller before adapting scenes.</p> : <p className="text-center text-[11px] text-muted-foreground">Storyhold holds credits while this runs. Unused held credits return automatically; higher actual usage may use additional available credits.</p>}
                  </div>
                </Card>

                {session.drafts.length ? (
                  <Card className="rounded-3xl border-white/8 bg-white/[0.025] p-5 sm:p-6">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Manuscript Drafts</p>
                        <h2 className="mt-2 font-serif text-2xl font-bold">Keep Writing Here</h2>
                      </div>
                      <Select value={activeDraftId ?? undefined} onValueChange={setActiveDraftId}>
                        <SelectTrigger className="h-10 w-full rounded-xl bg-[#17151a] sm:w-64"><SelectValue placeholder="Choose a draft" /></SelectTrigger>
                        <SelectContent>{session.drafts.map((draft) => <SelectItem key={draft.id} value={draft.id}>{draft.title} · r{draft.revision}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    {activeDraft ? (
                      <div className="mt-5 space-y-4">
                        <Input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} maxLength={160} className="h-11 rounded-xl bg-black/20 font-serif text-lg font-bold" />
                        <p className="rounded-xl border border-white/8 bg-black/15 p-3 text-xs leading-5 text-muted-foreground">{activeDraft.chapterSummary}</p>
                        <Textarea value={draftProse} onChange={(event) => setDraftProse(event.target.value)} className="min-h-[520px] resize-y rounded-xl bg-[#0e0d10] font-serif text-[16px] leading-8" />
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <p className="text-xs text-muted-foreground">Revision {activeDraft.revision} · Based on {activeDraft.sourceTurnIds.length} committed scene{activeDraft.sourceTurnIds.length === 1 ? "" : "s"}</p>
                          <Button variant="outline" className="rounded-xl" disabled={saving || !draftProse.trim()} onClick={saveDraft}>
                            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                            Save revision
                          </Button>
                        </div>
                        {activeDraft.adaptationNotes.length ? (
                          <details className="rounded-xl border border-white/8 bg-black/15 p-3 text-xs text-muted-foreground">
                            <summary className="cursor-pointer font-semibold text-foreground/80">Adaptation Notes</summary>
                            <ul className="mt-3 list-disc space-y-2 pl-5">{activeDraft.adaptationNotes.map((note, index) => <li key={index}>{note}</li>)}</ul>
                          </details>
                        ) : null}
                      </div>
                    ) : null}
                  </Card>
                ) : (
                  <Card className="rounded-3xl border-dashed border-white/10 bg-white/[0.015] p-7 text-center">
                    <Feather className="mx-auto h-7 w-7 text-primary" />
                    <p className="mt-4 font-serif text-xl font-bold">Your first chapter will live here.</p>
                    <p className="mt-2 text-sm text-muted-foreground">It stays on Storyhold with its sources and every saved revision.</p>
                  </Card>
                )}
              </section>
            </div>
          )}
        </div>
      ) : null}
    </ProfileFrame>
  );
}

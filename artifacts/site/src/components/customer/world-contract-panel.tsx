import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, CheckCircle2, Dice5, LockKeyhole, Loader2, ScrollText, Trash2, UserRound } from "lucide-react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  campaignStartAnchor,
  campaignStartChoices,
  defaultCampaignStartChoice,
} from "@/lib/campaignStarts";
import { createCampaign, deleteWorld, updateWorldContract, type CampaignExperienceMode, type ResolutionMode, type WorldContract, type WorldDetail } from "@/lib/storyholdApi";

function joined(value: unknown): string {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string").join("\n") : "";
}

function split(value: string): string[] {
  return value.split(/\r?\n|;/).map((item) => item.trim()).filter(Boolean).slice(0, 20);
}

function normalizedContract(detail: WorldDetail): WorldContract {
  const contract = detail.world.worldContract ?? ({} as WorldContract);
  return {
    identity: contract.identity || "",
    premise: contract.premise || detail.world.premise || "",
    tone: contract.tone || detail.world.genre || "",
    startingPoint: contract.startingPoint || "",
    constraints: Array.isArray(contract.constraints) ? contract.constraints : [],
    exclusions: Array.isArray(contract.exclusions) ? contract.exclusions : [],
    worldRules: Array.isArray(contract.worldRules) ? contract.worldRules : [],
    playerPriorities: Array.isArray(contract.playerPriorities) ? contract.playerPriorities : [],
  };
}

export function WorldContractPanel({ detail, onChanged }: { detail: WorldDetail; onChanged: () => void }) {
  const [, navigate] = useLocation();
  const initial = normalizedContract(detail);
  const startChoices = campaignStartChoices(detail);
  const initialStartChoice = defaultCampaignStartChoice(startChoices);
  const manuscriptWordCount = detail.sources
    .filter((source) => source.processingStatus === "ready" && source.sourceKind === "manuscript" && source.canonStatus !== "reference")
    .reduce((total, source) => total + source.wordCount, 0);
  const authorModeAccess = detail.authorModeAccess ?? {
    eligible: manuscriptWordCount >= 10_000,
    manuscriptWordCount,
    uploadedManuscriptWordCount: manuscriptWordCount,
    qualifiedSourceCount: 0,
    rejectedSourceCount: 0,
    sourceAssessments: [],
    requiredManuscriptWords: 10_000,
    requiredStoryDraftWords: 1_000,
    requiredStoryDraftTurns: 6,
    unlockedBy: manuscriptWordCount >= 10_000 ? ("manuscript" as const) : null,
  };
  const rejectedAuthorSources = authorModeAccess.sourceAssessments.filter(
    (source) => !source.qualifies,
  );
  const [premise, setPremise] = useState(initial.premise);
  const [tone, setTone] = useState(initial.tone);
  const [startingPoint, setStartingPoint] = useState(initial.startingPoint);
  const [constraints, setConstraints] = useState(joined(initial.constraints));
  const [exclusions, setExclusions] = useState(joined(initial.exclusions));
  const [resolutionMode, setResolutionMode] = useState<ResolutionMode>(detail.world.resolutionMode || "story_first");
  const [campaignName, setCampaignName] = useState(`${detail.world.name} - New story`);
  const [characterChoice, setCharacterChoice] = useState("");
  const [characterName, setCharacterName] = useState("");
  const [characterConcept, setCharacterConcept] = useState("");
  const [initialObjective, setInitialObjective] = useState("");
  const [campaignStartingPoint, setCampaignStartingPoint] = useState(
    initialStartChoice?.value || initial.startingPoint,
  );
  const [selectedStartChoiceId, setSelectedStartChoiceId] = useState(
    initialStartChoice?.id || "",
  );
  const [experienceMode, setExperienceMode] = useState<CampaignExperienceMode>(
    detail.world.creationMode !== "quickstart" && authorModeAccess.eligible ? "author" : "solo",
  );
  const [busy, setBusy] = useState(false);
  const [createdCampaignId, setCreatedCampaignId] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const next = normalizedContract(detail);
    const nextStartChoices = campaignStartChoices(detail);
    const nextDefaultStart = defaultCampaignStartChoice(nextStartChoices);
    setPremise(next.premise);
    setTone(next.tone);
    setStartingPoint(next.startingPoint);
    setSelectedStartChoiceId((current) =>
      nextStartChoices.some((choice) => choice.id === current)
        ? current
        : nextDefaultStart?.id || "",
    );
    setCampaignStartingPoint((current) =>
      current || nextDefaultStart?.value || next.startingPoint,
    );
    setConstraints(joined(next.constraints));
    setExclusions(joined(next.exclusions));
    setResolutionMode(detail.world.resolutionMode || "story_first");
    if (!authorModeAccess.eligible) setExperienceMode("solo");
  }, [detail]);

  // A launch link belongs to the exact beginning that produced it. Editing
  // any launch choice clears that link so it can never appear to represent a
  // different character, mode, objective, or canon boundary.
  useEffect(() => {
    setCreatedCampaignId("");
  }, [
    campaignName,
    campaignStartingPoint,
    characterChoice,
    characterConcept,
    characterName,
    experienceMode,
    exclusions,
    initialObjective,
    premise,
    resolutionMode,
    selectedStartChoiceId,
    startingPoint,
    tone,
    constraints,
  ]);

  const contract: WorldContract = {
    identity: initial.identity,
    premise,
    tone,
    startingPoint,
    constraints: split(constraints),
    exclusions: split(exclusions),
    worldRules: initial.worldRules,
    playerPriorities: initial.playerPriorities,
  };

  const saveDraft = async () => {
    setBusy(true);
    try {
      await updateWorldContract({
        worldId: detail.world.id,
        worldContract: contract,
        resolutionMode,
        contentSettings: detail.world.contentSettings ?? { sexualContent: "off", violence: "standard" },
        worldClockName: detail.world.worldClockName,
      });
      toast.success("World foundation saved.");
      onChanged();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "The world foundation could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (experienceMode === "author" && !authorModeAccess.eligible) {
      toast.error("Author mode unlocks after 10,000 words of qualifying story prose or a substantial Storyhold adaptation of at least six committed scenes.");
      return;
    }
    if (!characterChoice && characterConcept.trim().length < 3 && characterName.trim().length < 2) {
      toast.error("Choose an existing character or describe who you are playing.");
      return;
    }
    setBusy(true);
    try {
      await updateWorldContract({
        worldId: detail.world.id,
        worldContract: contract,
        resolutionMode,
        contentSettings: detail.world.contentSettings ?? { sexualContent: "off", violence: "standard" },
        worldClockName: detail.world.worldClockName,
      });
      const [choiceKind, choiceId] = characterChoice.split(":");
      const existingCharacter = choiceKind === "canonical"
        ? detail.canonicalCharacters.find((character) => character.id === choiceId)
        : undefined;
      const existingEntity = choiceKind === "entity"
        ? detail.entities.find((entity) => entity.id === choiceId)
        : undefined;
      const selectedStartAnchor = campaignStartAnchor(startChoices, selectedStartChoiceId);
      const response = await createCampaign({
        worldId: detail.world.id,
        name: campaignName,
        characterId: existingCharacter?.id,
        worldEntityId: existingEntity?.id,
        characterName: existingCharacter?.name || existingEntity?.name || characterName,
        characterConcept,
        startingPoint: campaignStartingPoint || startingPoint || premise,
        initialObjective,
        canonAnchorEventId: selectedStartAnchor.canonAnchorEventId,
        canonAnchorMode: selectedStartAnchor.canonAnchorMode,
        resolutionMode,
        experienceMode,
      });
      setCreatedCampaignId(response.campaign.id);
      toast.success("The starting state is locked and the World Clock has begun.");
      onChanged();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "The campaign could not be created.");
    } finally {
      setBusy(false);
    }
  };

  const permanentlyDeleteWorld = async () => {
    if (deleteConfirmation !== detail.world.name || deleting) return;
    setDeleting(true);
    try {
      await deleteWorld({
        worldId: detail.world.id,
        confirmationName: deleteConfirmation,
      });
      toast.success(`${detail.world.name} was permanently deleted.`);
      navigate("/profile/worlds");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "The world could not be deleted.");
      setDeleting(false);
    }
  };

  const playableEntities = detail.entities
    .filter((entity) => entity.entityType === "character" && entity.pullStatus === "active")
    .sort((left, right) => left.name.localeCompare(right.name));
  const entityNames = new Set(playableEntities.map((entity) => entity.name.trim().toLocaleLowerCase()));
  const unlinkedCanonicalCharacters = detail.canonicalCharacters.filter(
    (character) => !entityNames.has(character.name.trim().toLocaleLowerCase()),
  );
  const hasExistingCharacters = playableEntities.length + unlinkedCanonicalCharacters.length > 0;
  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_0.72fr]">
      <Card className="rounded-3xl border-white/8 bg-white/[0.025] p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">World Foundation</p>
            <h2 className="mt-2 font-serif text-3xl font-bold">What Stays True About This World</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Keep the shared premise, tone, and boundaries here. Each campaign remembers the world as it was when that story began, so different characters can explore it without overwriting one another.</p>
          </div>
          <Badge variant="outline" className="shrink-0 border-primary/20 text-primary">Editable</Badge>
        </div>

        <div className="mt-6 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="contract-premise">World Premise</Label>
            <Textarea id="contract-premise" value={premise} onChange={(event) => setPremise(event.target.value)} placeholder="What is true about this world" maxLength={6_000} disabled={busy} className="min-h-24 rounded-xl" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2"><Label htmlFor="contract-tone">Tone</Label><Input id="contract-tone" value={tone} onChange={(event) => setTone(event.target.value)} maxLength={1_000} disabled={busy} className="rounded-xl" /></div>
            <div className="space-y-2"><Label htmlFor="contract-resolution">Resolution Style</Label><select id="contract-resolution" value={resolutionMode} onChange={(event) => setResolutionMode(event.target.value as ResolutionMode)} disabled={busy} className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm"><option value="story_first">Story-First</option><option value="light_rules">Light Rules</option><option value="tactical">Tactical</option><option value="custom">Custom</option></select></div>
          </div>
          <div className="space-y-2"><Label htmlFor="contract-start">Suggested Starting Point</Label><Textarea id="contract-start" value={startingPoint} onChange={(event) => setStartingPoint(event.target.value)} placeholder="A reusable default for new campaigns" maxLength={2_000} disabled={busy} className="min-h-20 rounded-xl" /></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2"><Label htmlFor="contract-constraints">Fixed Constraints</Label><Textarea id="contract-constraints" value={constraints} onChange={(event) => setConstraints(event.target.value)} placeholder="One per line" maxLength={4_000} disabled={busy} className="min-h-24 rounded-xl" /></div>
            <div className="space-y-2"><Label htmlFor="contract-exclusions">Exclusions</Label><Textarea id="contract-exclusions" value={exclusions} onChange={(event) => setExclusions(event.target.value)} placeholder="Works, plots, themes, or elements to avoid" maxLength={4_000} disabled={busy} className="min-h-24 rounded-xl" /></div>
          </div>
          <Button type="button" variant="outline" onClick={() => void saveDraft()} disabled={busy} className="w-full rounded-xl">{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ScrollText className="mr-2 h-4 w-4" />} Save World Foundation</Button>
        </div>
      </Card>

      <div className="space-y-5">
        <Card className="rounded-3xl border-primary/20 bg-primary/[0.04] p-5 sm:p-6">
          <Dice5 className="h-5 w-5 text-primary" />
          <h2 className="mt-4 font-serif text-2xl font-bold">Start a Campaign</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">Choose who you will play, what they want, and where their story begins. Storyhold preserves the canon they can know at that moment.</p>
          <form onSubmit={start} className="mt-5">
            <fieldset disabled={busy} className="space-y-3 disabled:opacity-70">
            <Input value={campaignName} onChange={(event) => setCampaignName(event.target.value)} placeholder="Campaign name" maxLength={140} className="rounded-xl" />
            <div className="grid grid-cols-2 gap-2 rounded-2xl border border-white/8 bg-black/15 p-1.5">
              <button type="button" disabled={!authorModeAccess.eligible} aria-pressed={experienceMode === "author"} onClick={() => setExperienceMode("author")} className={`rounded-xl px-3 py-2.5 text-left text-xs transition-colors ${experienceMode === "author" ? "bg-primary text-primary-foreground" : authorModeAccess.eligible ? "text-muted-foreground hover:text-foreground" : "cursor-not-allowed text-muted-foreground/45"}`}>
                <span className="block font-semibold">Author Mode</span>
                <span className="mt-1 block opacity-75">{authorModeAccess.eligible ? "You control canon; rerolls and branches are free." : "Locked until Storyhold verifies 10,000 words of story prose, or a substantial adaptation of at least six played scenes."}</span>
              </button>
              <button type="button" aria-pressed={experienceMode === "solo"} onClick={() => setExperienceMode("solo")} className={`rounded-xl px-3 py-2.5 text-left text-xs transition-colors ${experienceMode === "solo" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                <span className="block font-semibold">Solo Game</span>
                <span className="mt-1 block opacity-75">Consequences stand unless you spend credits to re-roll or create an alternate branch.</span>
              </button>
            </div>
            <div className={`rounded-xl border px-3 py-2 text-[11px] leading-5 ${authorModeAccess.eligible ? "border-emerald-300/15 bg-emerald-300/[0.04] text-emerald-100/75" : "border-amber-300/15 bg-amber-300/[0.05] text-amber-100/75"}`}>
              {authorModeAccess.unlockedBy === "story_draft" ? (
                <p>Author access is unlocked by a Storyhold prose adaptation based on at least {authorModeAccess.requiredStoryDraftTurns.toLocaleString()} committed scenes and containing at least {authorModeAccess.requiredStoryDraftWords.toLocaleString()} words of continuous prose.</p>
              ) : authorModeAccess.eligible ? (
                <p>Author access verified: {authorModeAccess.manuscriptWordCount.toLocaleString()} words of continuous narrative across {authorModeAccess.qualifiedSourceCount.toLocaleString()} source{authorModeAccess.qualifiedSourceCount === 1 ? "" : "s"}.</p>
              ) : (
                <p>Author safeguard: {authorModeAccess.manuscriptWordCount.toLocaleString()} of {authorModeAccess.requiredManuscriptWords.toLocaleString()} qualifying narrative words. Character sheets, templates, reference notes, repeated filler, placeholder text, and token prose drafts do not count.</p>
              )}
              {rejectedAuthorSources.length > 0 ? (
                <details className="mt-1.5">
                  <summary className="cursor-pointer font-semibold">Why {rejectedAuthorSources.length.toLocaleString()} source{rejectedAuthorSources.length === 1 ? " was" : "s were"} not counted</summary>
                  <ul className="mt-1 space-y-1 pl-4">
                    {rejectedAuthorSources.slice(0, 12).map((source) => (
                      <li key={source.sourceId || source.title}><span className="font-medium">{source.title}:</span> {source.explanation}</li>
                    ))}
                    {rejectedAuthorSources.length > 12 ? <li>And {(rejectedAuthorSources.length - 12).toLocaleString()} more sources.</li> : null}
                  </ul>
                </details>
              ) : null}
            </div>
            {hasExistingCharacters ? (
              <select value={characterChoice} onChange={(event) => setCharacterChoice(event.target.value)} className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm"><option value="">Create a new character</option>{playableEntities.map((entity) => <option key={entity.id} value={`entity:${entity.id}`}>Play as {entity.name}</option>)}{unlinkedCanonicalCharacters.map((character) => <option key={character.id} value={`canonical:${character.id}`}>Play as {character.name}</option>)}</select>
            ) : null}
            {!characterChoice ? (
              <>
                <Input value={characterName} onChange={(event) => setCharacterName(event.target.value)} placeholder="Character name (optional)" maxLength={140} className="rounded-xl" />
                <Textarea value={characterConcept} onChange={(event) => setCharacterConcept(event.target.value)} placeholder="Who are you playing? Give as much or as little detail as you want." maxLength={3_000} className="min-h-24 rounded-xl" />
              </>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="campaign-objective">Opening Objective (Optional)</Label>
              <Input
                id="campaign-objective"
                value={initialObjective}
                onChange={(event) => setInitialObjective(event.target.value)}
                placeholder="What does your character want to accomplish first?"
                maxLength={240}
                className="rounded-xl"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="campaign-start">Where This Campaign Begins</Label>
              <div className="grid gap-2">
                {startChoices.map((choice) => {
                  const selected = selectedStartChoiceId === choice.id;
                  return (
                    <button
                      key={choice.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => {
                        setSelectedStartChoiceId(choice.id);
                        setCampaignStartingPoint(choice.value);
                      }}
                      className={`rounded-xl border p-3 text-left transition-colors ${
                        selected
                          ? "border-primary/40 bg-primary/[0.08]"
                          : "border-white/8 bg-black/15 hover:border-white/15"
                      }`}
                    >
                      <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-primary">
                        {choice.eyebrow}
                      </span>
                      <span className="mt-1 block text-sm font-semibold">{choice.label}</span>
                      <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                        {choice.description}
                      </span>
                    </button>
                  );
                })}
              </div>
              <Textarea id="campaign-start" value={campaignStartingPoint} onChange={(event) => setCampaignStartingPoint(event.target.value)} placeholder="Optional. Leave blank to use the world's suggested beginning." maxLength={3_000} className="min-h-24 rounded-xl" />
              <p className="text-[11px] leading-5 text-muted-foreground">
                Choose a frame, then edit anything you want. Storyhold locks the final text when the campaign begins.
              </p>
            </div>
            <Button type="submit" disabled={Boolean(createdCampaignId)} className="h-11 w-full rounded-xl">{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <LockKeyhole className="mr-2 h-4 w-4" />} {createdCampaignId ? "Beginning Locked" : "Lock This Beginning"}</Button>
            </fieldset>
          </form>
          {createdCampaignId ? <div className="mt-4 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.05] p-3 text-sm text-emerald-200"><div className="flex items-start gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /><span>The beginning is locked and ready to play.</span></div><Button asChild size="sm" className="mt-3 w-full rounded-lg"><Link href={`/profile/campaigns/${createdCampaignId}/play`}>Enter the Story <ArrowRight className="ml-2 h-4 w-4" /></Link></Button></div> : null}
        </Card>

        {detail.campaigns.length ? (
          <Card className="rounded-3xl border-white/8 bg-white/[0.025] p-5">
            <div className="flex items-center gap-2"><UserRound className="h-5 w-5 text-primary" /><h3 className="font-serif text-xl font-bold">Existing Campaigns</h3></div>
            <div className="mt-4 space-y-2">{detail.campaigns.map((campaign) => <div key={campaign.id} className="flex items-center justify-between gap-3 rounded-xl border border-white/8 bg-black/15 p-3"><div className="min-w-0"><p className="truncate font-semibold">{campaign.name}</p><p className="mt-1 text-xs text-muted-foreground">{campaign.characterName || "No perspective character"} - {campaign.eventCount} visible clock event{campaign.eventCount === 1 ? "" : "s"}</p></div><Button asChild size="sm" variant="outline" className="shrink-0 rounded-lg"><Link href={`/profile/campaigns/${campaign.id}/play`}>Play <ArrowRight className="ml-1.5 h-3.5 w-3.5" /></Link></Button></div>)}</div>
          </Card>
        ) : null}
      </div>

      <Card className="rounded-3xl border-red-400/20 bg-red-500/[0.035] p-5 sm:p-6 xl:col-span-2">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-red-300">Danger Zone</p><h2 className="mt-2 font-serif text-2xl font-bold">Delete This World</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Permanently removes its manuscripts, dossiers, cards, chronology, campaigns, branches, and generated story state. This cannot be undone.</p></div>
          <Button type="button" variant="outline" className="shrink-0 rounded-xl border-red-400/30 text-red-200 hover:bg-red-500/10 hover:text-red-100" onClick={() => { setDeleteConfirmation(""); setDeleteOpen(true); }}><Trash2 className="mr-2 h-4 w-4" /> Delete World</Button>
        </div>
      </Card>

      <AlertDialog open={deleteOpen} onOpenChange={(open) => { if (!deleting) setDeleteOpen(open); }}>
        <AlertDialogContent className="border-red-400/25">
          <AlertDialogHeader className="items-center text-center sm:text-center">
            <Trash2 className="h-8 w-8 text-red-300" />
            <AlertDialogTitle className="font-serif text-2xl">Delete {detail.world.name}?</AlertDialogTitle>
            <AlertDialogDescription className="max-w-md text-center leading-6">This permanently deletes the entire world and everything created inside it. Type the world name exactly to continue.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2"><Label htmlFor="delete-world-confirmation">Type <strong className="text-foreground">{detail.world.name}</strong></Label><Input id="delete-world-confirmation" value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} disabled={deleting} autoComplete="off" className="text-center" /></div>
          <AlertDialogFooter className="sm:justify-center">
            <AlertDialogCancel disabled={deleting}>Keep world</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 text-white hover:bg-red-500" disabled={deleting || deleteConfirmation !== detail.world.name} onClick={(event) => { event.preventDefault(); void permanentlyDeleteWorld(); }}>{deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Permanently delete world</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

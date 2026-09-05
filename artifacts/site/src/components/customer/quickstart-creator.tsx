import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Check, Dice5, LockKeyhole, Sparkles, WandSparkles } from "lucide-react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createCampaign, createWorld, type ResolutionMode, type WorldContract } from "@/lib/storyholdApi";
import { prepareAdventureSetup } from "@/lib/adventureSetupApi";

function lines(value: string): string[] {
  return value
    .split(/\r?\n|;/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function suggestedName(value: string): string {
  const framingRemoved = value
    // Treat "an original story set in …" as framing, not a world title.
    // Without this, a perfectly useful premise becomes the visibly broken
    // title "An Original Story Set In The" on the first world card.
    .replace(/^(?:an?\s+)?original\s+(?:story|adventure|rpg|campaign)\s+(?:set\s+)?in\s+(?:the\s+)?/i, "")
    .replace(/^(i am|i'm|we are|we're)\s+/i, "");
  const titleSeed = framingRemoved.split(/[,;:.!?]/, 1)[0]!.trim() || framingRemoved;
  const cleaned = titleSeed
    .replace(/[^a-z0-9' -]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ").filter(Boolean).slice(0, 6);
  if (!words.length) return "Untitled World";
  return words.map((word) => word[0]!.toLocaleUpperCase() + word.slice(1)).join(" ");
}

export function QuickstartCreator() {
  const [, navigate] = useLocation();
  const [worldPremise, setWorldPremise] = useState("");
  const [characterConcept, setCharacterConcept] = useState("");
  const [worldName, setWorldName] = useState("");
  const [characterName, setCharacterName] = useState("");
  const [tone, setTone] = useState("");
  const [startingPoint, setStartingPoint] = useState("");
  const [initialObjective, setInitialObjective] = useState("");
  const [constraints, setConstraints] = useState("");
  const [exclusions, setExclusions] = useState("");
  const [resolutionMode, setResolutionMode] = useState<ResolutionMode>("story_first");
  const [prepared, setPrepared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ worldId: string; worldName: string; campaignId: string } | null>(null);

  const contract = useMemo<WorldContract>(() => ({
    // This contract belongs to the reusable world. The player's role is
    // frozen separately on the campaign, so a later hero does not inherit it.
    identity: worldPremise.trim(),
    premise: worldPremise.trim(),
    tone: tone.trim() || "Responsive, character-driven play",
    startingPoint: startingPoint.trim() || "Begin at the first consequential moment of an ordinary day.",
    constraints: lines(constraints),
    exclusions: lines(exclusions),
    worldRules: [],
    playerPriorities: ["Let unusual actions receive fair, committed rulings before resolution."],
  }), [constraints, exclusions, startingPoint, tone, worldPremise]);

  // A prepared preview represents one exact set of inputs. Changing any part
  // of it must not leave an old world/campaign link looking current.
  useEffect(() => {
    setPrepared(false);
    setCreated(null);
  }, [
    characterConcept,
    characterName,
    constraints,
    exclusions,
    initialObjective,
    resolutionMode,
    startingPoint,
    tone,
    worldName,
    worldPremise,
  ]);

  const prepare = (event: FormEvent) => {
    event.preventDefault();
    if (worldPremise.trim().length < 8) {
      toast.error("Tell Storyhold what kind of world this adventure begins in.");
      return;
    }
    if (characterConcept.trim().length < 3) {
      toast.error("Tell Storyhold who you will play.");
      return;
    }
    setPrepared(true);
    setCreated(null);
  };

  const begin = async () => {
    if (busy) return;
    if (created) {
      navigate(`/profile/campaigns/${created.campaignId}/play`);
      return;
    }
    setBusy(true);
    try {
      const name = worldName.trim() || suggestedName(worldPremise);
      const world = await createWorld({
        name,
        premise: worldPremise,
        genre: tone,
        creationMode: "quickstart",
        resolutionMode,
        worldContract: contract,
      });
      const campaign = await createCampaign({
        worldId: world.id,
        name: `${name} - First Story`,
        characterName: characterName.trim() || "Player Character",
        characterConcept,
        startingPoint: contract.startingPoint,
        initialObjective,
        resolutionMode,
        experienceMode: "solo",
      });
      setCreated({ worldId: world.id, worldName: world.name, campaignId: campaign.campaign.id });
      // Preparation belongs to this saved campaign. A failed or lost response
      // must lead to its retry card, never another world creation.
      try {
        const result = await prepareAdventureSetup(campaign.campaign.id);
        toast.success(result.adventureSetup.status === "ready"
          ? `${world.name} is ready.`
          : "Your beginning is saved. Storyhold is preparing your adventure.");
      } catch {
        toast.error("Your beginning is saved. You can finish preparing it from your adventure.");
      }
      navigate(`/profile/campaigns/${campaign.campaign.id}/play`);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Storyhold could not create this world.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
      <Card className="rounded-3xl border-white/10 bg-[#121115] p-5 md:p-7">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Start a New Adventure</p>
        <h2 className="mt-2 font-serif text-3xl font-bold">Give Storyhold a World and a Role.</h2>
        <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
          Start from zero with only a few sentences. Storyhold keeps the setting and your character separate, locks the beginning when you approve it, and lets both grow through play.
        </p>

        <form onSubmit={prepare} className="mt-7">
          <fieldset disabled={busy} className="space-y-4 disabled:opacity-70">
          <div className="space-y-2">
            <Label htmlFor="quick-world-premise">What Kind of World Is This?</Label>
            <Textarea
              id="quick-world-premise"
              value={worldPremise}
              onChange={(event) => setWorldPremise(event.target.value)}
              placeholder="An original anime-style workplace fantasy where demons live openly among humans and magic always carries a practical cost."
              maxLength={6_000}
              className="min-h-32 rounded-xl"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="quick-character-concept">Who Will You Play?</Label>
            <Textarea
              id="quick-character-concept"
              value={characterConcept}
              onChange={(event) => setCharacterConcept(event.target.value)}
              placeholder="A disgraced demon prince working at a sandwich shop to make rent, hiding both his title and how little power he has left."
              maxLength={3_000}
              className="min-h-24 rounded-xl"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="quick-world-name">World Name</Label>
              <Input id="quick-world-name" value={worldName} onChange={(event) => setWorldName(event.target.value)} placeholder="Optional - Storyhold can name it" maxLength={140} className="rounded-xl" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="quick-character-name">Character Name</Label>
              <Input id="quick-character-name" value={characterName} onChange={(event) => setCharacterName(event.target.value)} placeholder="Optional" maxLength={140} className="rounded-xl" />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="quick-tone">Tone or Genre</Label>
              <Input id="quick-tone" value={tone} onChange={(event) => setTone(event.target.value)} placeholder="Anime workplace comedy with real stakes" maxLength={1_000} className="rounded-xl" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="resolution-mode">How Should Uncertainty Feel?</Label>
              <select id="resolution-mode" value={resolutionMode} onChange={(event) => setResolutionMode(event.target.value as ResolutionMode)} className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm">
                <option value="story_first">Story-First — Hidden Rulings</option>
                <option value="light_rules">Light Rules — Visible Outcomes and Factors</option>
                <option value="tactical">Tactical — Visible Mechanics and Modifiers</option>
                <option value="custom">Custom or Imported Rules</option>
              </select>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="quick-start">Where Should the First Scene Begin? (Optional)</Label>
              <Input id="quick-start" value={startingPoint} onChange={(event) => setStartingPoint(event.target.value)} placeholder="Halfway through a disastrous lunch rush" maxLength={2_000} className="rounded-xl" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="quick-objective">What Do You Want to Accomplish First? (Optional)</Label>
              <Input id="quick-objective" value={initialObjective} onChange={(event) => setInitialObjective(event.target.value)} placeholder="Keep the shop open without revealing my magic" maxLength={240} className="rounded-xl" />
            </div>
          </div>
          <details className="group rounded-2xl border border-white/8 bg-black/15 p-4">
            <summary className="cursor-pointer list-none text-sm font-semibold text-foreground marker:hidden">
              Optional Boundaries and Fixed Facts
              <span className="ml-2 text-xs font-normal text-muted-foreground group-open:hidden">Add only if they matter</span>
            </summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="quick-constraints">Facts or Limitations</Label>
                <Textarea id="quick-constraints" value={constraints} onChange={(event) => setConstraints(event.target.value)} placeholder="One per line. Rent is due Friday; magic must have a cost..." maxLength={4_000} className="min-h-24 rounded-xl" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="quick-exclusions">Avoid or Do Not Imitate</Label>
                <Textarea id="quick-exclusions" value={exclusions} onChange={(event) => setExclusions(event.target.value)} placeholder="Named stories, characters, plotlines, themes, or other boundaries" maxLength={4_000} className="min-h-24 rounded-xl" />
              </div>
            </div>
          </details>
          <Button type="submit" className="h-11 w-full rounded-xl">
            <WandSparkles className="mr-2 h-4 w-4" /> Prepare My Beginning
          </Button>
          </fieldset>
        </form>
      </Card>

      <Card className="rounded-3xl border-white/10 bg-[linear-gradient(145deg,rgba(56,189,248,0.09),rgba(18,17,21,0.96)_45%)] p-5 md:p-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">World Contract</p>
            <h2 className="mt-2 font-serif text-3xl font-bold">{prepared ? "This Is Where Your Canon Begins." : "Nothing Is Locked Yet."}</h2>
          </div>
          <LockKeyhole className="h-7 w-7 text-primary" />
        </div>

        {prepared ? (
          <div className="mt-6 space-y-4">
            <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">You Are</p>
              <p className="mt-2 text-sm leading-6">{characterConcept.trim()}</p>
            </div>
            <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">The World</p>
              <p className="mt-2 text-sm leading-6">{contract.premise}</p>
            </div>
            <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Begin Here</p>
              <p className="mt-2 text-sm leading-6">{contract.startingPoint}</p>
            </div>
            {initialObjective.trim() ? (
              <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">First Goal</p>
                <p className="mt-2 text-sm leading-6">{initialObjective.trim()}</p>
              </div>
            ) : null}
            {[...contract.constraints, ...contract.exclusions.map((item) => `Do not use: ${item}`)].length ? (
              <div className="space-y-2">
                {[...contract.constraints, ...contract.exclusions.map((item) => `Do not use: ${item}`)].map((item) => (
                  <div key={item} className="flex items-start gap-2 text-sm text-muted-foreground">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> {item}
                  </div>
                ))}
              </div>
            ) : null}
            <div className="rounded-2xl border border-primary/20 bg-primary/[0.05] p-4 text-sm leading-6 text-muted-foreground">
              The world, your role, and the opening situation are locked when play begins. Later discoveries can add to that beginning without silently rewriting it.
            </div>
            <p className="text-xs text-muted-foreground">Adventure Preparation and Play Use Credits.</p>
            {created ? (
              <Button asChild className="w-full rounded-xl">
                <Link href={`/profile/campaigns/${created.campaignId}/play`}>{busy ? "Preparing Your Adventure..." : `Enter ${created.worldName}`}</Link>
              </Button>
            ) : (
              <Button type="button" onClick={() => void begin()} disabled={busy} className="h-11 w-full rounded-xl">
                {busy ? <Sparkles className="mr-2 h-4 w-4 animate-pulse" /> : <Dice5 className="mr-2 h-4 w-4" />}
                {busy ? "Locking the Starting State..." : "Lock This Beginning and Start the Adventure"}
              </Button>
            )}
          </div>
        ) : (
          <div className="mt-6 space-y-3 text-sm leading-6 text-muted-foreground">
            <p>Storyhold will preserve three different things:</p>
            <div className="rounded-2xl border border-white/8 bg-black/15 p-4"><strong className="text-foreground">What is fixed:</strong> your stated identity, limitations, and beginning.</div>
            <div className="rounded-2xl border border-white/8 bg-black/15 p-4"><strong className="text-foreground">What can grow:</strong> people, places, mechanics, and consequences discovered during play.</div>
            <div className="rounded-2xl border border-white/8 bg-black/15 p-4"><strong className="text-foreground">What stays private:</strong> unrevealed plans, hidden clocks, motives, and causal machinery.</div>
          </div>
        )}
      </Card>
    </div>
  );
}

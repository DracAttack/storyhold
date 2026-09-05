import { useEffect, useState } from "react";
import { Check, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getStoryPreferences, updateStoryPreferences, type StoryPreferences } from "@/lib/storyholdApi";

const defaults: StoryPreferences = {
  adultEnabled: false,
  ageAttestedAt: null,
  ageAttestationVersion: null,
  sexualContentLevel: "off",
  violenceLevel: "standard",
  narrativeLength: "balanced",
  anonymousLearningEnabled: false,
  localModelTrainingEnabled: false,
  updatedAt: null,
};

export function StoryPreferencesCard() {
  const [preferences, setPreferences] = useState(defaults);
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void getStoryPreferences()
      .then((response) => {
        if (!active) return;
        setPreferences(response.preferences);
        setAgeConfirmed(response.preferences.adultEnabled);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const response = await updateStoryPreferences({
        adultEnabled: preferences.adultEnabled,
        ageConfirmed,
        sexualContentLevel: preferences.adultEnabled ? preferences.sexualContentLevel : "off",
        violenceLevel: preferences.violenceLevel,
        narrativeLength: preferences.narrativeLength,
        anonymousLearningEnabled: preferences.anonymousLearningEnabled,
        localModelTrainingEnabled: preferences.localModelTrainingEnabled,
      });
      setPreferences(response.preferences);
      toast.success("Story preferences saved.");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Preferences could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="rounded-3xl border-white/8 bg-[#121115] p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Story Settings</p>
          <h2 className="mt-2 font-serif text-2xl font-bold">Your Default Experience</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">These are account defaults. Individual worlds can be less intense, but never more permissive than the account using them.</p>
        </div>
        {loading ? <Loader2 className="h-5 w-5 animate-spin text-primary" /> : <ShieldCheck className="h-6 w-6 text-primary" />}
      </div>

      {!loading ? (
        <div className="mt-6 grid gap-5 lg:grid-cols-3">
          <div className="space-y-2">
            <label htmlFor="sexual-content" className="text-sm font-semibold">Sexual content</label>
            <select id="sexual-content" value={preferences.sexualContentLevel} onChange={(event) => setPreferences((current) => ({ ...current, sexualContentLevel: event.target.value as StoryPreferences["sexualContentLevel"] }))} disabled={!preferences.adultEnabled} className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm disabled:opacity-50">
              <option value="off">Off</option>
              <option value="fade_to_black">Fade to black</option>
              <option value="explicit">Explicit adult writing</option>
            </select>
          </div>
          <div className="space-y-2">
            <label htmlFor="violence-content" className="text-sm font-semibold">Violence</label>
            <select id="violence-content" value={preferences.violenceLevel} onChange={(event) => setPreferences((current) => ({ ...current, violenceLevel: event.target.value as StoryPreferences["violenceLevel"] }))} className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm">
              <option value="standard">Standard detail</option>
              <option value="graphic">Graphic blood and gore</option>
            </select>
          </div>
          <div className="space-y-2">
            <label htmlFor="narrative-length" className="text-sm font-semibold">Narrative length</label>
            <select id="narrative-length" value={preferences.narrativeLength} onChange={(event) => setPreferences((current) => ({ ...current, narrativeLength: event.target.value as StoryPreferences["narrativeLength"] }))} className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm">
              <option value="concise">Concise</option>
              <option value="balanced">Balanced</option>
              <option value="expansive">Expansive</option>
            </select>
          </div>
        </div>
      ) : null}

      {!loading ? (
        <div className="mt-5 rounded-2xl border border-white/8 bg-black/20 p-4">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={preferences.adultEnabled}
              onChange={(event) => {
                const enabled = event.target.checked;
                setPreferences((current) => ({
                  ...current,
                  adultEnabled: enabled,
                  sexualContentLevel: enabled ? current.sexualContentLevel : "off",
                }));
                if (!enabled) setAgeConfirmed(false);
              }}
              className="mt-1 h-4 w-4 rounded border-white/20 accent-primary"
            />
            <span><strong className="block text-sm">Enable adult mode</strong><span className="mt-1 block text-xs leading-5 text-muted-foreground">Adult mode remains off until you explicitly enable it. It never changes the permanent prohibitions around minors and exploitative material.</span></span>
          </label>
          {preferences.adultEnabled ? (
            <label className="mt-4 flex cursor-pointer items-start gap-3 border-t border-white/8 pt-4">
              <input type="checkbox" checked={ageConfirmed} onChange={(event) => setAgeConfirmed(event.target.checked)} className="mt-1 h-4 w-4 rounded border-white/20 accent-primary" />
              <span><strong className="block text-sm">I am 18 years old or older and want to turn on this setting.</strong><span className="mt-1 block text-xs leading-5 text-muted-foreground">Your confirmation time and policy version are recorded with your account. Storyhold does not request identity documents.</span></span>
            </label>
          ) : null}
        </div>
      ) : null}

      {!loading ? (
        <div className="mt-5 rounded-2xl border border-white/8 bg-black/20 p-4">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={preferences.localModelTrainingEnabled}
              onChange={(event) =>
                setPreferences((current) => ({
                  ...current,
                  localModelTrainingEnabled: event.target.checked,
                }))
              }
              className="mt-1 h-4 w-4 rounded border-white/20 accent-primary"
            />
            <span>
              <strong className="block text-sm">Save my rated turns for future private-model training</strong>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                Separate and optional. When you rate a turn, Storyhold may keep that turn, its scene context, and your note in a private held dataset. Nothing is exported or used to train a model automatically. Turning this off deletes held examples that have not been approved.
              </span>
            </span>
          </label>
        </div>
      ) : null}

      {!loading ? (
        <div className="mt-5 rounded-2xl border border-white/8 bg-black/20 p-4">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={preferences.anonymousLearningEnabled}
              onChange={(event) =>
                setPreferences((current) => ({
                  ...current,
                  anonymousLearningEnabled: event.target.checked,
                }))
              }
              className="mt-1 h-4 w-4 rounded border-white/20 accent-primary"
            />
            <span>
              <strong className="block text-sm">Help Storyhold learn from play patterns</strong>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                Optional. Your thumbs and aspect tags may contribute broad, anonymous patterns such as pacing preferences during dialogue or exploration. Private notes, prose, worlds, characters, account IDs, and canon are never copied into the shared learning store.
              </span>
            </span>
          </label>
        </div>
      ) : null}

      {!loading ? <Button type="button" onClick={() => void save()} disabled={saving || (preferences.adultEnabled && !ageConfirmed)} className="mt-5 w-full rounded-xl">{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />} Save story settings</Button> : null}
    </Card>
  );
}

import { useListCategories } from "@workspace/api-client-react";
import { Label } from "@/components/ui/label";
import { Loader2, Check } from "lucide-react";

type Props = {
  primarySlug: string;
  subBeats: string[];
  onChange: (next: string[]) => void;
  /** Optional saving indicator surfaced when auto-saving on toggle. */
  saving?: boolean;
  /** Set true to show "Saved" briefly after a successful auto-save. */
  justSaved?: boolean;
};

export function SubBeatsPicker({ primarySlug, subBeats, onChange, saving, justSaved }: Props) {
  const { data, isLoading } = useListCategories();
  const cats = data?.items ?? [];

  const toggle = (slug: string) => {
    if (subBeats.includes(slug)) onChange(subBeats.filter((s) => s !== slug));
    else onChange([...subBeats, slug]);
  };

  // All beats except the author's primary (you can't sub-beat yourself).
  const available = cats.filter((c) => c.categorySlug !== primarySlug);
  // Slugs assigned to this author that aren't in the master list — surface
  // them as warning chips so the user can still see and remove them.
  const orphanSubs = subBeats.filter(
    (s) => s !== primarySlug && !available.some((c) => c.categorySlug === s),
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>Additional beats this author can cover</Label>
        <span className="text-xs text-muted-foreground h-4 flex items-center gap-1">
          {saving && <><Loader2 className="h-3 w-3 animate-spin" /> Saving…</>}
          {!saving && justSaved && <><Check className="h-3 w-3 text-emerald-600" /> Saved</>}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Pick any additional beats this author can credibly write about — for example, a
        microbiologist whose primary is biology might also cover astrobiology. The AI keeps
        most ideas on the primary beat and uses these for genuinely cross-disciplinary stories.
        Changes save automatically.
      </p>

      <div className="flex flex-wrap gap-2 pt-1">
        {isLoading && <span className="text-xs text-muted-foreground">Loading beats…</span>}
        {available.map((c) => {
          const checked = subBeats.includes(c.categorySlug);
          return (
            <button
              key={c.categorySlug}
              type="button"
              onClick={() => toggle(c.categorySlug)}
              className={`text-xs px-3 py-1 rounded-full border transition ${
                checked
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background hover:bg-muted border-input"
              }`}
            >
              {checked ? "✓ " : ""}
              {c.category}
            </button>
          );
        })}
        {orphanSubs.map((slug) => (
          <button
            key={slug}
            type="button"
            onClick={() => toggle(slug)}
            className="text-xs px-3 py-1 rounded-full border border-amber-400 bg-amber-50 text-amber-800"
            title="This beat slug isn't in the master list — click to remove."
          >
            ✓ {slug}
          </button>
        ))}
      </div>
    </div>
  );
}

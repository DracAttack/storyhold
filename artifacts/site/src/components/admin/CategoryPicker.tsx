import { useListCategories } from "@workspace/api-client-react";
import { Label } from "@/components/ui/label";

type Props = {
  category: string;
  categorySlug: string;
  onChange: (next: { category: string; categorySlug: string }) => void;
  required?: boolean;
};

export function CategoryPicker({ category, categorySlug, onChange, required }: Props) {
  const { data, isLoading, isError } = useListCategories();
  const cats = data?.items ?? [];
  const isUnknown = !!categorySlug && !isLoading && !cats.some((c) => c.categorySlug === categorySlug);

  return (
    <div className="space-y-1">
      <Label>Primary beat</Label>
      <select
        className="border rounded h-10 px-3 text-sm bg-background w-full"
        value={categorySlug || ""}
        disabled={isLoading || isError}
        required={required}
        onChange={(e) => {
          const v = e.target.value;
          const match = cats.find((c) => c.categorySlug === v);
          if (match) onChange({ category: match.category, categorySlug: match.categorySlug });
        }}
      >
        <option value="" disabled>
          {isLoading ? "Loading beats…" : isError ? "Couldn't load beats" : "Choose a beat"}
        </option>
        {cats.map((c) => (
          <option key={c.categorySlug} value={c.categorySlug}>
            {c.category}
          </option>
        ))}
        {isUnknown && (
          <option value={categorySlug}>{category} (legacy)</option>
        )}
      </select>
      <p className="text-xs text-muted-foreground">
        Pick from the magazine's curated beats. Article ideas and drafts will be filed under this beat.
      </p>
    </div>
  );
}

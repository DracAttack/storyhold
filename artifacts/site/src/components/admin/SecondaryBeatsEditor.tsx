import { useListCategories } from "@workspace/api-client-react";
import { X } from "lucide-react";

type Props = {
  /** The idea/article's primary beat slug — never selectable as a secondary. */
  primarySlug: string;
  /** Current secondary beat slugs. */
  value: string[];
  /** Called with the next list whenever a subject is added or removed. */
  onChange: (next: string[]) => void;
  /** Read-only rendering (badges only, no add/remove controls). */
  disabled?: boolean;
};

/**
 * Compact editor for an idea/article's cross-sectional secondary subjects
 * (Task #258). Admin-only internal metadata — these never surface to readers.
 * Renders each secondary as a violet chip with a remove button plus an
 * "Add subject" dropdown listing the remaining beats (excluding the primary
 * and already-selected ones).
 */
export function SecondaryBeatsEditor({ primarySlug, value, onChange, disabled }: Props) {
  const { data } = useListCategories();
  const cats = data?.items ?? [];
  const nameBySlug = new Map(cats.map((c) => [c.categorySlug, c.category]));
  const available = cats.filter(
    (c) => c.categorySlug !== primarySlug && !value.includes(c.categorySlug),
  );

  const remove = (slug: string) => onChange(value.filter((s) => s !== slug));
  const add = (slug: string) => {
    if (!slug || slug === primarySlug || value.includes(slug)) return;
    onChange([...value, slug]);
  };

  if (disabled && value.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {value.length > 0 && (
        <span className="text-[10px] uppercase tracking-wide text-violet-600 font-semibold">Crossover</span>
      )}
      {value.map((s) => (
        <span
          key={s}
          className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-violet-100 text-violet-700"
          title="Cross-sectional secondary subject (admin-only — never shown to readers or in the article's public category)"
        >
          + {nameBySlug.get(s) ?? s}
          {!disabled && (
            <button
              type="button"
              onClick={() => remove(s)}
              className="hover:text-violet-900"
              title="Remove this secondary subject"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
      {!disabled && available.length > 0 && (
        <select
          className="text-xs border rounded-full px-2 py-0.5 bg-background text-muted-foreground"
          value=""
          onChange={(e) => add(e.target.value)}
          title="Add a cross-sectional secondary subject (admin-only)"
        >
          <option value="">+ Add subject…</option>
          {available.map((c) => (
            <option key={c.categorySlug} value={c.categorySlug}>
              {c.category}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

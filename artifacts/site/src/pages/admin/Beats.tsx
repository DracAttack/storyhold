import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListBeats,
  useCreateBeat,
  useUpdateBeat,
  useDeleteBeat,
  useRegenerateBeatImage,
  getListBeatsQueryKey,
  getListCategoriesQueryKey,
  type BeatWithUsage,
} from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Loader2, Plus, Trash2, Save, X, ImageIcon, RefreshCw } from "lucide-react";
import { toast } from "sonner";

const apiBase = import.meta.env.BASE_URL.replace(/\/$/, "");
const resolveImg = (src: string) =>
  src.startsWith("http") || src.startsWith("data:") ? src : `${apiBase}${src}`;

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function BeatRow({ beat }: { beat: BeatWithUsage }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    name: beat.name,
    slug: beat.slug,
    description: beat.description ?? "",
    seoDescription: beat.seoDescription ?? "",
    slant: beat.slant ?? "",
  });
  const update = useUpdateBeat();
  const del = useDeleteBeat();
  const regenImage = useRegenerateBeatImage();

  const totalUsage = beat.usage.authorsPrimary + beat.usage.authorsSubBeat + beat.usage.articles;

  const onRegenerateImage = async () => {
    try {
      await regenImage.mutateAsync({ id: beat.id });
      await qc.invalidateQueries({ queryKey: getListBeatsQueryKey() });
      // Bust the public beats cache so /category/{slug} picks up the new hero.
      await qc.invalidateQueries({ queryKey: ["public", "beats"] });
      toast.success("Category image generated");
    } catch (e: unknown) {
      const msg =
        (e as { response?: { data?: { message?: string; error?: string } } })?.response?.data?.message ??
        (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        "Image generation failed";
      toast.error(msg);
    }
  };

  const onSave = async () => {
    try {
      await update.mutateAsync({
        id: beat.id,
        data: {
          name: form.name.trim(),
          slug: form.slug.trim(),
          description: form.description.trim() || null,
          seoDescription: form.seoDescription.trim() || null,
          slant: form.slant.trim() || null,
        },
      });
      await qc.invalidateQueries({ queryKey: getListBeatsQueryKey() });
      await qc.invalidateQueries({ queryKey: getListCategoriesQueryKey() });
      // Bust the public beats cache so /category/{slug} meta picks up the change.
      await qc.invalidateQueries({ queryKey: ["public", "beats"] });
      toast.success("Beat updated");
      setEditing(false);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Failed to update beat";
      toast.error(msg);
    }
  };

  const onDelete = async () => {
    if (!window.confirm(`Delete beat "${beat.name}"? This cannot be undone.`)) return;
    try {
      await del.mutateAsync({ id: beat.id });
      await qc.invalidateQueries({ queryKey: getListBeatsQueryKey() });
      await qc.invalidateQueries({ queryKey: getListCategoriesQueryKey() });
      toast.success("Beat deleted");
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string; usage?: BeatWithUsage["usage"] } } };
      const u = err?.response?.data?.usage;
      const detail = u
        ? ` (${u.authorsPrimary} primary author(s), ${u.authorsSubBeat} sub-beat author(s), ${u.articles} article(s))`
        : "";
      toast.error((err?.response?.data?.error ?? "Failed to delete beat") + detail);
    }
  };

  if (!editing) {
    return (
      <Card className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="shrink-0">
                <div className="relative w-40 aspect-video rounded-md overflow-hidden bg-muted border">
                  {beat.heroImageUrl ? (
                    <img
                      src={resolveImg(beat.heroImageUrl)}
                      alt=""
                      className="absolute inset-0 w-full h-full object-cover"
                    />
                  ) : (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground gap-1">
                      <ImageIcon className="h-5 w-5" />
                      <span className="text-[11px]">No image yet</span>
                    </div>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2 w-40"
                  onClick={onRegenerateImage}
                  disabled={regenImage.isPending}
                  title="Generate a fresh AI hero image for this category"
                >
                  {regenImage.isPending ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-1" />
                  )}
                  {beat.heroImageUrl ? "Regenerate" : "Generate image"}
                </Button>
              </div>
              <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-3 flex-wrap">
              <h3 className="font-serif text-lg font-semibold">{beat.name}</h3>
              <code className="text-xs text-muted-foreground">{beat.slug}</code>
            </div>
            {beat.description && (
              <p className="text-sm text-muted-foreground mt-1">{beat.description}</p>
            )}
            {beat.slant ? (
              <div className="mt-3 text-sm">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">Slant</span>
                <p className="mt-0.5 italic">{beat.slant}</p>
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground italic">No editorial slant set.</p>
            )}
            <div className="mt-3 flex gap-4 text-xs text-muted-foreground">
              <span>{beat.usage.authorsPrimary} primary author{beat.usage.authorsPrimary === 1 ? "" : "s"}</span>
              <span>{beat.usage.authorsSubBeat} sub-beat author{beat.usage.authorsSubBeat === 1 ? "" : "s"}</span>
              <span>{beat.usage.articles} article{beat.usage.articles === 1 ? "" : "s"}</span>
            </div>
              </div>
            </div>
          </div>
          <div className="flex items-start gap-2 shrink-0">
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Edit</Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={onDelete}
              disabled={del.isPending || totalUsage > 0}
              title={totalUsage > 0 ? "Reassign authors and articles before deleting." : "Delete beat"}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-5 border-primary/40">
      <div className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label htmlFor={`name-${beat.id}`}>Name</Label>
            <Input
              id={`name-${beat.id}`}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor={`slug-${beat.id}`}>Slug</Label>
            <Input
              id={`slug-${beat.id}`}
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value })}
            />
            <p className="text-xs text-muted-foreground mt-1">Renaming the slug updates all authors and articles using this beat.</p>
          </div>
        </div>
        <div>
          <Label htmlFor={`desc-${beat.id}`}>Category page subtitle</Label>
          <Textarea
            id={`desc-${beat.id}`}
            rows={2}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="One line shown under the category name on its public page."
          />
          <p className="text-xs text-muted-foreground mt-1">Appears under the title on /category/{form.slug || beat.slug}. Leave blank to use the default.</p>
        </div>
        <div>
          <div className="flex items-center justify-between">
            <Label htmlFor={`seodesc-${beat.id}`}>SEO description (search &amp; social)</Label>
            <span className={`text-xs ${form.seoDescription.length > 160 ? "text-amber-700" : "text-muted-foreground"}`}>
              {form.seoDescription.length}/120–155
            </span>
          </div>
          <Textarea
            id={`seodesc-${beat.id}`}
            rows={2}
            value={form.seoDescription}
            onChange={(e) => setForm({ ...form, seoDescription: e.target.value })}
            placeholder={form.description || "Description for Google and social shares of this category page."}
          />
          <p className="text-xs text-muted-foreground mt-1">Meta/OG description for /category/{form.slug || beat.slug}. Not shown on the page. Leave blank to derive from the subtitle.</p>
        </div>
        <div>
          <Label htmlFor={`slant-${beat.id}`}>Editorial slant (fed to the LLM)</Label>
          <Textarea
            id={`slant-${beat.id}`}
            rows={3}
            value={form.slant}
            onChange={(e) => setForm({ ...form, slant: e.target.value })}
            placeholder="e.g. Skeptical of pop neuroscience. Always foreground methodology limits."
          />
          <p className="text-xs text-muted-foreground mt-1">BrainHook's house take on this beat. Authors writing for this beat will see this in their idea-generation prompt.</p>
        </div>
        <div className="flex gap-2 justify-end">
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            <X className="h-4 w-4 mr-1" /> Cancel
          </Button>
          <Button size="sm" onClick={onSave} disabled={update.isPending}>
            {update.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
            Save
          </Button>
        </div>
      </div>
    </Card>
  );
}

function NewBeatCard({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const create = useCreateBeat();
  const [form, setForm] = useState({ name: "", slug: "", description: "", seoDescription: "", slant: "" });
  const [slugTouched, setSlugTouched] = useState(false);

  const onSubmit = async () => {
    if (!form.name.trim() || !form.slug.trim()) {
      toast.error("Name and slug are required.");
      return;
    }
    try {
      await create.mutateAsync({
        data: {
          name: form.name.trim(),
          slug: form.slug.trim(),
          description: form.description.trim() || null,
          seoDescription: form.seoDescription.trim() || null,
          slant: form.slant.trim() || null,
        },
      });
      await qc.invalidateQueries({ queryKey: getListBeatsQueryKey() });
      await qc.invalidateQueries({ queryKey: getListCategoriesQueryKey() });
      toast.success("Beat created");
      onDone();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Failed to create beat";
      toast.error(msg);
    }
  };

  return (
    <Card className="p-5 border-dashed border-primary/40">
      <h3 className="font-serif text-lg font-semibold mb-3">New beat</h3>
      <div className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label htmlFor="new-name">Name</Label>
            <Input
              id="new-name"
              value={form.name}
              onChange={(e) => {
                const name = e.target.value;
                setForm((f) => ({ ...f, name, slug: slugTouched ? f.slug : slugify(name) }));
              }}
              placeholder="e.g. Food & Cooking Science"
            />
          </div>
          <div>
            <Label htmlFor="new-slug">Slug</Label>
            <Input
              id="new-slug"
              value={form.slug}
              onChange={(e) => { setSlugTouched(true); setForm({ ...form, slug: e.target.value }); }}
              placeholder="e.g. food-cooking-science"
            />
          </div>
        </div>
        <div>
          <Label htmlFor="new-desc">Category page subtitle</Label>
          <Textarea
            id="new-desc"
            rows={2}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="One line shown under the category name on its public page."
          />
        </div>
        <div>
          <Label htmlFor="new-seodesc">SEO description (search &amp; social)</Label>
          <Textarea
            id="new-seodesc"
            rows={2}
            value={form.seoDescription}
            onChange={(e) => setForm({ ...form, seoDescription: e.target.value })}
            placeholder="Meta/OG description for Google and social shares. Leave blank to derive from the subtitle."
          />
        </div>
        <div>
          <Label htmlFor="new-slant">Editorial slant (fed to the LLM)</Label>
          <Textarea
            id="new-slant"
            rows={3}
            value={form.slant}
            onChange={(e) => setForm({ ...form, slant: e.target.value })}
            placeholder="The angle BrainHook takes on this beat."
          />
        </div>
        <div className="flex gap-2 justify-end">
          <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
          <Button size="sm" onClick={onSubmit} disabled={create.isPending}>
            {create.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
            Create beat
          </Button>
        </div>
      </div>
    </Card>
  );
}

export default function Beats() {
  const { data, isLoading } = useListBeats();
  const [creating, setCreating] = useState(false);

  const items = data?.items ?? [];

  return (
    <div className="p-4 md:p-8 max-w-4xl">
      <div className="flex items-start justify-between gap-3 mb-6">
        <div>
          <h1 className="font-serif text-3xl font-bold mb-1">Beats</h1>
          <p className="text-muted-foreground">The magazine's editorial beats, sorted alphabetically. Each beat has a slant that shapes how the LLM proposes ideas.</p>
        </div>
        {!creating && (
          <Button className="shrink-0" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4 mr-1" /> New beat
          </Button>
        )}
      </div>

      {creating && <div className="mb-4"><NewBeatCard onDone={() => setCreating(false)} /></div>}

      {isLoading ? (
        <Loader2 className="animate-spin text-muted-foreground" />
      ) : (
        <div className="space-y-3">
          {items.map((b) => (
            <BeatRow key={b.id} beat={b} />
          ))}
          {items.length === 0 && !creating && (
            <p className="text-sm text-muted-foreground">No beats yet. Create one to get started.</p>
          )}
        </div>
      )}
    </div>
  );
}

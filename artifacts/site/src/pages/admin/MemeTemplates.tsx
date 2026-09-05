import { useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import {
  useListMemeTemplates,
  useCreateMemeTemplate,
  useUpdateMemeTemplate,
  useDisableMemeTemplate,
  getListMemeTemplatesQueryKey,
  type MemeTemplate,
  type MemeTextArea,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Loader2,
  ArrowLeft,
  Plus,
  Upload,
  ImagePlus,
  EyeOff,
  Eye,
  Pencil,
  Trash2,
  Search,
} from "lucide-react";
import { toast } from "sonner";

const LAYOUTS = [
  { value: "classic_top_bottom", label: "Classic (top + bottom)" },
  { value: "split_panel", label: "Split panel" },
  { value: "headline_caption", label: "Headline + caption" },
  { value: "explainer", label: "Explainer (long paragraph)" },
] as const;

const ALIGNS = ["left", "center", "right"] as const;
const VALIGNS = ["top", "middle", "bottom"] as const;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

function newTextArea(key: string): MemeTextArea {
  return {
    key,
    label: key,
    x: 0.1,
    y: 0.1,
    width: 0.8,
    height: 0.2,
    fontSize: 0.08,
    align: "center",
    valign: "middle",
    color: "white",
    outline: true,
    uppercase: true,
  };
}

function extractError(e: unknown, fallback: string): string {
  return e && typeof e === "object" && "error" in e && typeof (e as { error?: unknown }).error === "string"
    ? (e as { error: string }).error
    : fallback;
}

/** Editor for a template's fractional (0–1) text-area boxes. */
function TextAreasEditor({
  areas,
  onChange,
}: {
  areas: MemeTextArea[];
  onChange: (next: MemeTextArea[]) => void;
}) {
  const update = (i: number, patch: Partial<MemeTextArea>) => {
    onChange(areas.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  };
  const remove = (i: number) => onChange(areas.filter((_, idx) => idx !== i));
  const num = (v: string, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>Text areas</Label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange([...areas, newTextArea(`field${areas.length + 1}`)])}
        >
          <Plus className="h-3.5 w-3.5 mr-1" /> Add area
        </Button>
      </div>
      {areas.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No text areas defined — the layout’s default placement is used.
        </p>
      ) : (
        <div className="space-y-3">
          {areas.map((a, i) => (
            <Card key={i} className="p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Input
                  className="h-8"
                  value={a.key}
                  onChange={(e) => update(i, { key: e.target.value })}
                  placeholder="key (top/bottom/extra)"
                />
                <Input
                  className="h-8"
                  value={a.label}
                  onChange={(e) => update(i, { label: e.target.value })}
                  placeholder="label"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-destructive"
                  onClick={() => remove(i)}
                  aria-label="Remove text area"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                {(["x", "y", "width", "height", "fontSize"] as const).map((f) => (
                  <div key={f} className="space-y-1">
                    <Label className="text-[10px] uppercase text-muted-foreground">{f}</Label>
                    <Input
                      className="h-8"
                      type="number"
                      step="0.01"
                      min={0}
                      max={1}
                      value={a[f]}
                      onChange={(e) => update(i, { [f]: num(e.target.value, a[f]) })}
                    />
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase text-muted-foreground">Align</Label>
                  <Select value={a.align} onValueChange={(v) => update(i, { align: v as MemeTextArea["align"] })}>
                    <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ALIGNS.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase text-muted-foreground">V-align</Label>
                  <Select value={a.valign} onValueChange={(v) => update(i, { valign: v as MemeTextArea["valign"] })}>
                    <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {VALIGNS.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase text-muted-foreground">Color</Label>
                  <Input
                    className="h-8"
                    value={a.color}
                    onChange={(e) => update(i, { color: e.target.value })}
                    placeholder="white / #fff"
                  />
                </div>
              </div>
              <div className="flex items-center gap-4 pt-1">
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox checked={a.outline} onCheckedChange={(c) => update(i, { outline: c === true })} />
                  Outline
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox checked={a.uppercase} onCheckedChange={(c) => update(i, { uppercase: c === true })} />
                  Uppercase
                </label>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MemeTemplates() {
  const qc = useQueryClient();
  const [includeInactive, setIncludeInactive] = useState(false);
  const [search, setSearch] = useState("");
  const { data, isLoading } = useListMemeTemplates({ includeInactive });
  const allTemplates: MemeTemplate[] = data?.items ?? [];

  const templates = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allTemplates;
    return allTemplates.filter((t) => t.name.toLowerCase().includes(q));
  }, [allTemplates, search]);

  const createTemplate = useCreateMemeTemplate();
  const updateTemplate = useUpdateMemeTemplate();
  const disableTemplate = useDisableMemeTemplate();

  // --- Create form state ---
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [layout, setLayout] = useState<string>("classic_top_bottom");
  const [recommendedFieldCount, setRecommendedFieldCount] = useState(2);
  const [sourceNotes, setSourceNotes] = useState("");
  const [licenseNotes, setLicenseNotes] = useState("");
  const [dataUrl, setDataUrl] = useState("");
  const [fileName, setFileName] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  // --- Edit form state ---
  const [editing, setEditing] = useState<MemeTemplate | null>(null);
  const [eName, setEName] = useState("");
  const [eLayout, setELayout] = useState<string>("classic_top_bottom");
  const [eFieldCount, setEFieldCount] = useState(2);
  const [eSourceNotes, setESourceNotes] = useState("");
  const [eLicenseNotes, setELicenseNotes] = useState("");
  const [eDataUrl, setEDataUrl] = useState("");
  const [eFileName, setEFileName] = useState("");
  const [eAreas, setEAreas] = useState<MemeTextArea[]>([]);
  const editFileInput = useRef<HTMLInputElement>(null);

  function refresh() {
    qc.invalidateQueries({ queryKey: getListMemeTemplatesQueryKey() });
  }

  function resetForm() {
    setName("");
    setLayout("classic_top_bottom");
    setRecommendedFieldCount(2);
    setSourceNotes("");
    setLicenseNotes("");
    setDataUrl("");
    setFileName("");
  }

  function openEdit(t: MemeTemplate) {
    setEditing(t);
    setEName(t.name);
    setELayout(t.layout);
    setEFieldCount(t.recommendedFieldCount);
    setESourceNotes(t.sourceNotes);
    setELicenseNotes(t.licenseNotes);
    setEAreas(t.textAreas ?? []);
    setEDataUrl("");
    setEFileName("");
  }

  const handleFile = async (file: File | undefined, set: (url: string) => void, setN: (n: string) => void) => {
    if (!file) return;
    try {
      set(await readFileAsDataUrl(file));
      setN(file.name);
    } catch {
      toast.error("Could not read that image.");
    }
  };

  const handleCreate = async () => {
    if (!name.trim() || !dataUrl) {
      toast.error("Name and an image are required.");
      return;
    }
    try {
      await createTemplate.mutateAsync({
        data: {
          name: name.trim(),
          dataUrl,
          layout,
          recommendedFieldCount,
          sourceNotes: sourceNotes.trim() || undefined,
          licenseNotes: licenseNotes.trim() || undefined,
        },
      });
      toast.success("Template added.");
      setOpen(false);
      resetForm();
      refresh();
    } catch (e: unknown) {
      toast.error(extractError(e, "Could not create the template."));
    }
  };

  const handleSaveEdit = async () => {
    if (!editing) return;
    if (!eName.trim()) {
      toast.error("Name is required.");
      return;
    }
    try {
      await updateTemplate.mutateAsync({
        id: editing.id,
        data: {
          name: eName.trim(),
          layout: eLayout,
          recommendedFieldCount: eFieldCount,
          sourceNotes: eSourceNotes,
          licenseNotes: eLicenseNotes,
          textAreas: eAreas,
          ...(eDataUrl ? { dataUrl: eDataUrl } : {}),
        },
      });
      toast.success("Template saved.");
      setEditing(null);
      refresh();
    } catch (e: unknown) {
      toast.error(extractError(e, "Could not save the template."));
    }
  };

  const handleToggleActive = async (t: MemeTemplate) => {
    try {
      if (t.active) {
        await disableTemplate.mutateAsync({ id: t.id });
        toast.success("Template disabled.");
      } else {
        await updateTemplate.mutateAsync({ id: t.id, data: { active: true } });
        toast.success("Template re-enabled.");
      }
      refresh();
    } catch {
      toast.error("Could not update the template.");
    }
  };

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Button asChild variant="ghost" size="sm" className="-ml-2 mb-1">
            <Link href="/admin/memes">
              <ArrowLeft className="h-4 w-4 mr-1" /> Memes
            </Link>
          </Button>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ImagePlus className="h-6 w-6" /> Meme templates
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Curated meme backdrops the editor can compose text onto. Upload your own licensed
            artwork — you are responsible for usage rights.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIncludeInactive((v) => !v)}
          >
            {includeInactive ? <EyeOff className="h-4 w-4 mr-1" /> : <Eye className="h-4 w-4 mr-1" />}
            {includeInactive ? "Hide disabled" : "Show disabled"}
          </Button>
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> New template
          </Button>
        </div>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Search templates by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : templates.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">
          {allTemplates.length === 0
            ? "No templates yet. Click “New template” to add one."
            : "No templates match your search."}
        </Card>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {templates.map((t) => (
            <Card key={t.id} className={`overflow-hidden ${t.active ? "" : "opacity-60"}`}>
              <img src={t.imageUrl} alt={t.name} className="w-full h-32 object-cover bg-muted" />
              <div className="p-3 space-y-2">
                <div className="flex items-center gap-1 flex-wrap">
                  {t.isCurated && <Badge variant="outline">Curated</Badge>}
                  {!t.active && <Badge variant="outline" className="bg-zinc-100 text-zinc-700">Disabled</Badge>}
                </div>
                <p className="font-medium text-sm truncate" title={t.name}>{t.name}</p>
                <p className="text-xs text-muted-foreground">
                  {LAYOUTS.find((l) => l.value === t.layout)?.label ?? t.layout}
                  {t.textAreas?.length ? ` · ${t.textAreas.length} areas` : ""}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => openEdit(t)}
                  >
                    <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => handleToggleActive(t)}
                    disabled={disableTemplate.isPending || updateTemplate.isPending}
                  >
                    {t.active ? "Disable" : "Re-enable"}
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) resetForm(); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New meme template</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Distracted boyfriend" />
            </div>
            <div className="space-y-2">
              <Label>Image</Label>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0], setDataUrl, setFileName)}
              />
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
                  <Upload className="h-4 w-4 mr-1" /> Choose image
                </Button>
                {fileName && <span className="text-xs text-muted-foreground truncate">{fileName}</span>}
              </div>
              {dataUrl && (
                <img src={dataUrl} alt="" className="mt-2 h-28 rounded border object-contain bg-muted" />
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Layout</Label>
                <Select value={layout} onValueChange={setLayout}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LAYOUTS.map((l) => (
                      <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Text fields</Label>
                <Input
                  type="number"
                  min={1}
                  max={8}
                  value={recommendedFieldCount}
                  onChange={(e) => setRecommendedFieldCount(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Source notes (optional)</Label>
              <Input value={sourceNotes} onChange={(e) => setSourceNotes(e.target.value)} placeholder="Where it came from" />
            </div>
            <div className="space-y-2">
              <Label>License notes (optional)</Label>
              <Input value={licenseNotes} onChange={(e) => setLicenseNotes(e.target.value)} placeholder="Usage rights" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setOpen(false); resetForm(); }}>Cancel</Button>
            <Button onClick={handleCreate} disabled={createTemplate.isPending}>
              {createTemplate.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
              Add template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editing} onOpenChange={(o) => { if (!o) setEditing(null); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit template</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input value={eName} onChange={(e) => setEName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Template image</Label>
                <input
                  ref={editFileInput}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => handleFile(e.target.files?.[0], setEDataUrl, setEFileName)}
                />
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => editFileInput.current?.click()}>
                    <Upload className="h-4 w-4 mr-1" /> Replace image
                  </Button>
                  {eFileName && <span className="text-xs text-muted-foreground truncate">{eFileName}</span>}
                </div>
                <img
                  src={eDataUrl || editing.imageUrl}
                  alt=""
                  className="mt-2 h-28 rounded border object-contain bg-muted"
                />
                {!eDataUrl && (
                  <p className="text-[11px] text-muted-foreground">Current image — choose a file to replace it.</p>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Layout</Label>
                  <Select value={eLayout} onValueChange={setELayout}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {LAYOUTS.map((l) => (
                        <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Text fields</Label>
                  <Input
                    type="number"
                    min={1}
                    max={8}
                    value={eFieldCount}
                    onChange={(e) => setEFieldCount(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Source notes</Label>
                <Input value={eSourceNotes} onChange={(e) => setESourceNotes(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>License notes</Label>
                <Input value={eLicenseNotes} onChange={(e) => setELicenseNotes(e.target.value)} />
              </div>
              <TextAreasEditor areas={eAreas} onChange={setEAreas} />
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={handleSaveEdit} disabled={updateTemplate.isPending}>
              {updateTemplate.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Pencil className="h-4 w-4 mr-1" />}
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

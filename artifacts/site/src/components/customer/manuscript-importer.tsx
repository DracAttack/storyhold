import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  FolderOpen,
  Globe2,
  Layers3,
  ListOrdered,
  Loader2,
  Sparkles,
  Trash2,
  Upload,
  UsersRound,
} from "lucide-react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth";
import {
  analyzeWorldSources,
  createWorld,
  getCanonIntakePreflight,
  getWorld,
  listWorlds,
  updateWorldChronology,
  uploadWorldSource,
  type WorldDetail,
  type CanonIntakePreflight,
  type ReferenceKnowledgeScope,
  type ReferenceLoreStatus,
  type WorldSource,
  type WorldSummary,
} from "@/lib/storyholdApi";

type QueueStatus = "waiting" | "uploading" | "uploaded" | "failed";

type QueuedSource = {
  id: string;
  file: File;
  sourceKind: WorldSource["sourceKind"];
  relation: WorldSource["chronologyRelation"];
  label: string;
  notes: string;
  fileAsChapter: boolean;
  status: QueueStatus;
  error: string;
  source: WorldSource | null;
};

type ImportResult = {
  worldId: string;
  worldName: string;
  uploaded: number;
  failed: number;
  detail: WorldDetail | null;
};

const acceptedExtensions = [
  ".pdf",
  ".epub",
  ".docx",
  ".txt",
  ".md",
  ".pptx",
  ".xlsx",
  ".odt",
  ".odp",
  ".ods",
];

const sourceKinds: Array<[WorldSource["sourceKind"], string]> = [
  ["manuscript", "Book or Manuscript"],
  ["character_sheet", "Character Sheet"],
  ["setting_guide", "Setting or World Guide"],
  ["ruleset", "Ruleset"],
  ["timeline", "Timeline"],
  ["notes", "Notes"],
  ["reference", "Reference Material"],
  ["other", "Other"],
];

const chronologyRelations: Array<[WorldSource["chronologyRelation"], string]> = [
  ["origin", "Beginning / Earliest Source"],
  ["continues", "Continues the Previous Source"],
  ["precedes", "Occurs Before the Previous Source"],
  ["parallel", "Runs Alongside the Previous Source"],
  ["overlaps", "Overlaps the Previous Source"],
  ["alternate", "Alternate Continuity"],
  ["reference", "Reference Only — No Story Position"],
  ["unspecified", "Let Storyhold Infer It"],
];

const queuePageSize = 40;
const naturalFilenameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function sourceId(file: File): string {
  return `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`;
}

function filePath(file: File) {
  return file.webkitRelativePath || file.name;
}

function fileIdentity(file: File) {
  return `${filePath(file)}:${file.size}:${file.lastModified}`;
}

function naturallySortedFiles(files: File[]) {
  return [...files].sort((left, right) =>
    naturalFilenameCollator.compare(filePath(left), filePath(right)),
  );
}

function inferSourceKind(filename: string): WorldSource["sourceKind"] {
  const value = filename.toLocaleLowerCase();
  if (/character|sheet|profile|cast/.test(value)) return "character_sheet";
  if (/timeline|chronology/.test(value)) return "timeline";
  if (/rule|system|mechanic/.test(value)) return "ruleset";
  if (/setting|world.?bible|lore|guide/.test(value)) return "setting_guide";
  if (/note|outline|idea/.test(value)) return "notes";
  return "manuscript";
}

function filenameLooksLikeChapter(filename: string) {
  const stem = filename.replace(/\.[^.]+$/u, "");
  return /(?:^|[ _.-])(?:ch(?:apter)?[ _.-]*\d+|chapter[ _.-]+(?:[ivxlcdm]+|[a-z]+)|prologue|epilogue|interlude)(?:[ _.-]|$)/iu.test(stem);
}

function isAccepted(file: File): boolean {
  const filename = file.name.toLocaleLowerCase();
  return acceptedExtensions.some((extension) => filename.endsWith(extension));
}

export function ManuscriptImporter({
  targetWorldId = "",
  referenceMode = false,
}: {
  targetWorldId?: string;
  referenceMode?: boolean;
}) {
  const auth = useAuth();
  const [, navigate] = useLocation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [worlds, setWorlds] = useState<WorldSummary[]>([]);
  const [mode, setMode] = useState<"new" | "existing">(
    targetWorldId ? "existing" : "new",
  );
  const [selectedWorldId, setSelectedWorldId] = useState(targetWorldId);
  const [queue, setQueue] = useState<QueuedSource[]>([]);
  const [worldName, setWorldName] = useState("");
  const [genre, setGenre] = useState("");
  const [atmosphere, setAtmosphere] = useState("");
  const [premise, setPremise] = useState("");
  const [letAiDecide, setLetAiDecide] = useState(false);
  const [chronologySummary, setChronologySummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [queuePage, setQueuePage] = useState(0);
  const [expandedSourceId, setExpandedSourceId] = useState<string | null>(null);
  const [positionDrafts, setPositionDrafts] = useState<Record<string, string>>({});
  const [stage, setStage] = useState("Choose Everything That Belongs to This World");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [intakeGate, setIntakeGate] = useState<CanonIntakePreflight | null>(null);
  const [referenceKnowledgeScope, setReferenceKnowledgeScope] =
    useState<ReferenceKnowledgeScope>("director_only");
  const [referenceKnownBy, setReferenceKnownBy] = useState("");
  const [referenceLoreStatus, setReferenceLoreStatus] =
    useState<ReferenceLoreStatus>("supplemental");

  useEffect(() => {
    if (!auth.email) return;
    let active = true;
    void listWorlds()
      .then((response) => {
        if (!active) return;
        setWorlds(response.worlds);
        if (targetWorldId) setSelectedWorldId(targetWorldId);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [auth.email, targetWorldId]);

  useEffect(() => {
    folderInputRef.current?.setAttribute("webkitdirectory", "");
    folderInputRef.current?.setAttribute("directory", "");
  }, []);

  useEffect(() => {
    const lastPage = Math.max(0, Math.ceil(queue.length / queuePageSize) - 1);
    setQueuePage((current) => Math.min(current, lastPage));
  }, [queue.length]);

  const selectedWorld = worlds.find((world) => world.id === selectedWorldId) ?? null;

  const addFiles = (files: File[], options: { chapterFolder?: boolean } = {}) => {
    const rejected = files.filter((file) => !isAccepted(file));
    if (rejected.length) {
      toast.error(`${rejected.length} unsupported file${rejected.length === 1 ? " was" : "s were"} skipped.`);
    }
    const accepted = naturallySortedFiles(files.filter(isAccepted));
    if (!accepted.length) return;
    setQueue((current) => {
      const duplicateKeys = new Set(
        current.map((item) => fileIdentity(item.file)),
      );
      const next = [...current];
      for (const file of accepted) {
        const key = fileIdentity(file);
        if (duplicateKeys.has(key)) continue;
        const sourceKind = referenceMode ? "reference" : inferSourceKind(file.name);
        const storyPosition = next.filter(
          (item) => item.sourceKind === "manuscript" || item.sourceKind === "timeline",
        ).length + (mode === "existing" ? 1 : 0);
        next.push({
          id: sourceId(file),
          file,
          sourceKind,
          relation:
            sourceKind === "reference" || sourceKind === "ruleset"
              ? "reference"
              : storyPosition === 0
                ? "origin"
                : "continues",
          label: "",
          notes: "",
          fileAsChapter:
            sourceKind === "manuscript" &&
            (options.chapterFolder === true || filenameLooksLikeChapter(file.name)),
          status: "waiting",
          error: "",
          source: null,
        });
        duplicateKeys.add(key);
      }
      return next;
    });
    setResult(null);
    setQueuePage(0);
    setStage("Review the Source Order Before Importing");
    if (!referenceMode && !worldName.trim() && accepted[0]) {
      setWorldName(accepted[0].name.replace(/\.[^.]+$/, "").slice(0, 140));
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    addFiles(Array.from(event.dataTransfer.files));
  };

  const updateQueued = (id: string, patch: Partial<QueuedSource>) => {
    setQueue((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  };

  const moveQueued = (index: number, direction: -1 | 1) => {
    setQueue((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item!);
      return next;
    });
  };

  const moveQueuedTo = (id: string, requestedPosition: number) => {
    const boundedPosition = Math.min(queue.length, Math.max(1, requestedPosition));
    setQueue((current) => {
      const index = current.findIndex((item) => item.id === id);
      if (index < 0) return current;
      const target = Math.min(current.length - 1, Math.max(0, boundedPosition - 1));
      if (target === index) return current;
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item!);
      return next;
    });
    setPositionDrafts((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setQueuePage(Math.max(0, Math.floor((boundedPosition - 1) / queuePageSize)));
  };

  const sortQueueNaturally = () => {
    setQueue((current) =>
      [...current].sort((left, right) =>
        naturalFilenameCollator.compare(filePath(left.file), filePath(right.file)),
      ),
    );
    setQueuePage(0);
    setPositionDrafts({});
  };

  const resetStorySequence = () => {
    let narrativeIndex = mode === "existing" ? 1 : 0;
    setQueue((current) => current.map((item) => {
      const narrative = item.sourceKind === "manuscript" || item.sourceKind === "timeline";
      if (!narrative) return item;
      const relation = narrativeIndex === 0 ? "origin" : "continues";
      narrativeIndex += 1;
      return { ...item, relation };
    }));
  };

  const queuePageCount = Math.max(1, Math.ceil(queue.length / queuePageSize));
  const queuePageStart = queuePage * queuePageSize;
  const visibleQueue = queue.slice(queuePageStart, queuePageStart + queuePageSize);
  const compactQueue = queue.length > 12;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!auth.email) {
      toast.error("Sign in before importing a world.");
      return;
    }
    if (queue.length === 0) {
      toast.error("Choose at least one source first.");
      return;
    }
    if (mode === "new" && worldName.trim().length < 2) {
      toast.error("Give this world a name.");
      return;
    }
    if (mode === "existing" && !selectedWorldId) {
      toast.error("Choose the world these sources belong to.");
      return;
    }

    setBusy(true);
    setResult(null);
    setIntakeGate(null);
    setQueue((current) =>
      current.map((item) => ({ ...item, status: "waiting", error: "", source: null })),
    );
    try {
      let worldId = selectedWorldId;
      let activeWorldName = selectedWorld?.name ?? worldName.trim();
      let existingSources: WorldSource[] = [];
      if (mode === "new") {
        setStage("Creating the World and Its Working Canon…");
        const world = await createWorld({
          name: worldName,
          genre: letAiDecide ? "" : genre,
          premise: letAiDecide ? "" : premise,
          inferMetadata: letAiDecide,
          creationMode: "import",
          worldContract: {
            premise: letAiDecide ? "" : premise,
            tone: letAiDecide ? "" : atmosphere || genre,
          },
        });
        worldId = world.id;
        activeWorldName = world.name;
      } else {
        setStage("Opening the Existing Canon…");
        const detail = await getWorld(worldId);
        existingSources = detail.sources;
      }

      const uploadedSources: Array<{ queued: QueuedSource; source: WorldSource }> = [];
      let failed = 0;
      const importBatchId = crypto.randomUUID();
      for (let index = 0; index < queue.length; index += 1) {
        const item = queue[index]!;
        updateQueued(item.id, { status: "uploading" });
        setStage(`Reading ${index + 1} of ${queue.length}: ${item.file.name}`);
        try {
          const uploaded = await uploadWorldSource({
            worldId,
            file: item.file,
            sourceClass: "original_author",
            canonStatus: item.sourceKind === "reference" ? "reference" : "candidate",
            sourceKind: item.sourceKind,
            chronologyOrder: existingSources.length + index,
            chronologyRelation: item.relation,
            chronologyLabel: item.label,
            chronologyNotes: item.notes,
            fileAsChapter: item.fileAsChapter,
            relativePath: filePath(item.file),
            importBatchId,
            importBatchPosition: index,
            importBatchSize: queue.length,
            // The importer performs one complete world-level credit preflight
            // after every selected file is staged, then starts intake itself.
            deferAnalysis: true,
            referenceKnowledgeScope,
            referenceKnownBy: referenceKnownBy
              .split(/[,;\n]/u)
              .map((value) => value.trim())
              .filter(Boolean),
            referenceLoreStatus,
          });
          uploadedSources.push({ queued: item, source: uploaded.source });
          updateQueued(item.id, { status: "uploaded", source: uploaded.source });
        } catch (reason) {
          failed += 1;
          updateQueued(item.id, {
            status: "failed",
            error: reason instanceof Error ? reason.message : "This source could not be imported.",
          });
        }
      }

      if (uploadedSources.length === 0) {
        throw new Error("None of the selected sources could be imported.");
      }

      setStage("Saving the Source Chronology…");
      const chronologySources = [
        ...existingSources.map((source) => ({
          sourceId: source.id,
          sourceKind: source.sourceKind,
          relation: source.chronologyRelation,
          label: source.chronologyLabel,
          notes: source.chronologyNotes,
        })),
        ...uploadedSources.map(({ queued, source }) => ({
          sourceId: source.id,
          sourceKind: queued.sourceKind,
          relation: queued.relation,
          label: queued.label,
          notes: queued.notes,
        })),
      ];
      await updateWorldChronology({
        worldId,
        summary: chronologySummary,
        sources: chronologySources,
      });

      const reviewableUpload = uploadedSources.some(
        ({ queued }) => queued.sourceKind !== "reference",
      );
      if (reviewableUpload && failed > 0) {
        const detail = await getWorld(worldId);
        setResult({
          worldId,
          worldName: activeWorldName,
          uploaded: uploadedSources.length,
          failed,
          detail,
        });
        setStage("Sources Saved; Canon Intake Has Not Started");
        toast.error("Fix or remove the files that need attention, then start Canon Intake. No credits were used.");
        return;
      }
      const preflight = reviewableUpload
        ? await getCanonIntakePreflight(worldId)
        : null;
      setIntakeGate(preflight);
      if (preflight?.largeIntake) {
        const balance = preflight.unlimited
          ? "an unlimited owner balance"
          : `${preflight.availableCredits.toLocaleString()} available credits`;
        toast.warning(
          `Large Canon Intake: ${preflight.wordCount.toLocaleString()} words need ${preflight.requiredCredits.toLocaleString()} credits, with ${balance}.`,
          { duration: 12_000 },
        );
      }
      if (preflight && !preflight.canStart) {
        const detail = await getWorld(worldId);
        setResult({
          worldId,
          worldName: activeWorldName,
          uploaded: uploadedSources.length,
          failed,
          detail,
        });
        setStage(preflight.overLimit
          ? "This World Is Over the Canon Intake Word Limit"
          : "Add Credits to Begin Canon Intake");
        toast.error(
          preflight.overLimit
            ? `Canon Intake accepts up to ${preflight.wordLimit.toLocaleString()} words. No credits were used.`
            : `This intake needs ${preflight.requiredCredits.toLocaleString()} credits; ${preflight.availableCredits.toLocaleString()} are available. No credits were used.`,
          { duration: 12_000 },
        );
        return;
      }
      setStage(
        reviewableUpload
          ? "Discovering People, Places, and Chronology…"
          : "Shelving Background References in Lorekeeper…",
      );
      const queuedReview = reviewableUpload
        ? await analyzeWorldSources(worldId)
        : null;
      if (reviewableUpload) {
        setStage("Opening Canon Intake…");
        toast.success(`${uploadedSources.length} source${uploadedSources.length === 1 ? "" : "s"} added to ${activeWorldName}.`);
        const runQuery = queuedReview?.run.id
          ? `?run=${encodeURIComponent(queuedReview.run.id)}`
          : "";
        navigate(`/profile/worlds/${worldId}/intake${runQuery}`);
        return;
      }
      const detail: WorldDetail | null = await getWorld(worldId);
      setResult({
        worldId,
        worldName: activeWorldName,
        uploaded: uploadedSources.length,
        failed,
        detail,
      });
      setStage(failed ? "The World Is Saved, with a Few Files Needing Attention" : "The World Is Ready");
      toast.success(`${uploadedSources.length} source${uploadedSources.length === 1 ? "" : "s"} added to ${activeWorldName}.`);
    } catch (reason) {
      setStage("The Import Stopped Before It Was Finished");
      toast.error(reason instanceof Error ? reason.message : "We could not finish this import.");
    } finally {
      setBusy(false);
    }
  };

  const findings = useMemo(() => {
    const detail = result?.detail;
    return [
      {
        label: "Characters",
        value:
          (detail?.characterDrafts.length ?? 0) +
          (detail?.canonicalCharacters.length ?? 0),
        icon: UsersRound,
      },
      {
        label: "Places",
        value: detail?.breakdown?.locations.length ?? 0,
        icon: Globe2,
      },
      {
        label: "Clock events",
        value:
          (detail?.worldClockEvents.length ?? 0) +
          (detail?.breakdown?.chronology.length ?? 0),
        icon: Sparkles,
      },
    ];
  }, [result]);

  return (
    <div className="grid gap-6 xl:grid-cols-[1.12fr_0.88fr]">
      <Card className="rounded-3xl border-white/10 bg-[#121115] p-5 md:p-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              {referenceMode ? "Lorekeeper Reference Upload" : "Multi-Source Import"}
            </p>
            <h2 className="mt-2 font-serif text-3xl font-bold">
              {referenceMode ? "Add Background Without Changing Canon." : "Build One World from Everything."}
            </h2>
            <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
              {referenceMode
                ? "These files become universe lore: Lorekeeper can use their setting rules, history, terminology, and flavor while keeping story canon and each character's knowledge separate."
                : "Add complete books, sequels, character sheets, rules, timelines, and notes together. Each remains a distinct, cited source inside the same canon."}
            </p>
          </div>
          <Layers3 className="h-7 w-7 shrink-0 text-primary" />
        </div>

        <form onSubmit={submit} className="mt-7 space-y-5">
          {referenceMode ? (
            <div className="grid gap-3 rounded-2xl border border-sky-300/15 bg-sky-300/[0.04] p-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="reference-lore-status">What kind of lore is this?</Label>
                <select
                  id="reference-lore-status"
                  value={referenceLoreStatus}
                  onChange={(event) => setReferenceLoreStatus(event.target.value as ReferenceLoreStatus)}
                  className="mt-2 h-10 w-full rounded-xl border border-input bg-background px-3 text-sm"
                >
                  <option value="official">Official Universe Lore</option>
                  <option value="licensed">Licensed Adaptation or Sourcebook</option>
                  <option value="supplemental">Supplemental Reference</option>
                  <option value="homebrew">Homebrew or House Lore</option>
                  <option value="disputed">Disputed Interpretation</option>
                </select>
              </div>
              <div>
                <Label htmlFor="reference-knowledge-scope">Who starts out knowing it?</Label>
                <select
                  id="reference-knowledge-scope"
                  value={referenceKnowledgeScope}
                  onChange={(event) => setReferenceKnowledgeScope(event.target.value as ReferenceKnowledgeScope)}
                  className="mt-2 h-10 w-full rounded-xl border border-input bg-background px-3 text-sm"
                >
                  <option value="director_only">Lorekeeper Only</option>
                  <option value="common">Common Knowledge</option>
                  <option value="selected">Only Selected Characters</option>
                  <option value="discoverable">Discoverable During Play</option>
                </select>
              </div>
              {referenceKnowledgeScope === "selected" ? (
                <div className="sm:col-span-2">
                  <Label htmlFor="reference-known-by">Known by</Label>
                  <Input
                    id="reference-known-by"
                    className="mt-2"
                    value={referenceKnownBy}
                    onChange={(event) => setReferenceKnownBy(event.target.value.slice(0, 2_000))}
                    placeholder="Driver, Miranda — separate names with commas"
                  />
                </div>
              ) : null}
              <p className="text-xs leading-5 text-muted-foreground sm:col-span-2">
                Lorekeeper may use this as real universe background. It still cannot claim that an event happened in your story or that a character knows it unless the selected scope allows that knowledge or play reveals it.
              </p>
            </div>
          ) : null}
          {!targetWorldId ? (
            <div className="grid grid-cols-2 gap-2 rounded-2xl border border-white/8 bg-black/20 p-1.5">
              <button
                type="button"
                onClick={() => setMode("new")}
                className={`rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors ${mode === "new" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                Create a new world
              </button>
              <button
                type="button"
                onClick={() => setMode("existing")}
                disabled={worlds.length === 0}
                className={`rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors disabled:opacity-40 ${mode === "existing" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                Add to an existing world
              </button>
            </div>
          ) : null}

          {mode === "existing" ? (
            <div className="space-y-2">
              <Label htmlFor="existing-world">World</Label>
              <select
                id="existing-world"
                value={selectedWorldId}
                onChange={(event) => setSelectedWorldId(event.target.value)}
                disabled={Boolean(targetWorldId) || busy}
                className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm"
              >
                <option value="">Choose a world</option>
                {worlds.map((world) => (
                  <option key={world.id} value={world.id}>
                    {world.name} ({world.sourceCount} source{world.sourceCount === 1 ? "" : "s"})
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="world-name">World name</Label>
                <Input
                  id="world-name"
                  value={worldName}
                  onChange={(event) => setWorldName(event.target.value)}
                  placeholder="ASHES"
                  maxLength={140}
                  className="rounded-xl"
                />
              </div>

              <label
                htmlFor="let-ai-decide"
                className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-4 transition-colors ${
                  letAiDecide
                    ? "border-primary/45 bg-primary/[0.09]"
                    : "border-white/8 bg-black/20 hover:border-primary/25"
                }`}
              >
                <Checkbox
                  id="let-ai-decide"
                  checked={letAiDecide}
                  onCheckedChange={(checked) => setLetAiDecide(checked === true)}
                  disabled={busy}
                  className="mt-0.5"
                />
                <span>
                  <span className="flex items-center gap-2 text-sm font-semibold">
                    <Sparkles className="h-4 w-4 text-primary" /> Let Storyhold decide
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                    After reading the sources, the first AI pass will generate the genre,
                    atmosphere, and central premise for this world.
                  </span>
                </span>
              </label>

              {!letAiDecide ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="world-genre">Genre</Label>
                    <Input
                      id="world-genre"
                      value={genre}
                      onChange={(event) => setGenre(event.target.value)}
                      placeholder="Horror science fiction"
                      maxLength={160}
                      className="rounded-xl"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="world-atmosphere">Atmosphere</Label>
                    <Input
                      id="world-atmosphere"
                      value={atmosphere}
                      onChange={(event) => setAtmosphere(event.target.value)}
                      placeholder="Claustrophobic corporate dread"
                      maxLength={1_000}
                      className="rounded-xl"
                    />
                  </div>
                </div>
              ) : null}
            </div>
          )}

          {mode === "new" && !letAiDecide ? (
            <div className="space-y-2">
              <Label htmlFor="world-premise">What matters most about this world?</Label>
              <Textarea
                id="world-premise"
                value={premise}
                onChange={(event) => setPremise(event.target.value)}
                placeholder="Optional: the central premise, where play should begin, or facts Storyhold must preserve."
                maxLength={6_000}
                className="min-h-24 rounded-xl"
              />
            </div>
          ) : null}

          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="sr-only"
            accept={acceptedExtensions.join(",")}
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              event.currentTarget.value = "";
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            className="sr-only"
            accept={acceptedExtensions.join(",")}
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []), { chapterFolder: true });
              event.currentTarget.value = "";
            }}
          />
          <div
            onDragEnter={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            className={`rounded-2xl border border-dashed p-5 transition-colors ${dragging ? "border-primary bg-primary/[0.09]" : "border-primary/30 bg-primary/[0.035]"}`}
          >
            <div className="flex items-start gap-4">
              <span className="rounded-xl bg-primary/10 p-3 text-primary">
                <Upload className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">Add manuscripts or drop them here</span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  Complete books work. When you have chapter files, upload the folder: separate chapters give Storyhold more precise chronology, citations, and coverage.
                </span>
              </span>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <Button type="button" variant="outline" className="rounded-xl" onClick={() => fileInputRef.current?.click()} disabled={busy}>
                <FileText className="mr-2 h-4 w-4" /> Choose files
              </Button>
              <Button type="button" variant="outline" className="rounded-xl" onClick={() => folderInputRef.current?.click()} disabled={busy}>
                <FolderOpen className="mr-2 h-4 w-4" /> Choose a chapter folder
              </Button>
            </div>
            <p className="mt-3 text-[11px] leading-5 text-muted-foreground">
              Hundreds of files are supported and naturally ordered by folder and filename. Each file can be up to 100 MB.
            </p>
          </div>

          {queue.length ? (
            <div className="space-y-3">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <Label>Source order and chronology</Label>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Put narrative sources in their likely story order. References can remain outside the timeline.
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {queue.length} file{queue.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={sortQueueNaturally} disabled={busy || queue.length < 2}>
                  <ListOrdered className="mr-2 h-3.5 w-3.5" /> Sort by folder and filename
                </Button>
                <Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={resetStorySequence} disabled={busy || queue.length < 2}>
                  Reset story sequence
                </Button>
              </div>
              {visibleQueue.map((item, pageIndex) => {
                const index = queuePageStart + pageIndex;
                const detailsOpen = !compactQueue || expandedSourceId === item.id;
                return (
                <div key={item.id} className={`rounded-2xl border border-white/8 bg-black/20 ${compactQueue ? "p-2.5" : "p-4"}`}>
                  <div className="flex items-start gap-3">
                    <label className="shrink-0" title="Move directly to this position">
                      <span className="sr-only">Position for {item.file.name}</span>
                      <input
                        type="number"
                        min={1}
                        max={queue.length}
                        value={positionDrafts[item.id] ?? String(index + 1)}
                        onChange={(event) => setPositionDrafts((current) => ({ ...current, [item.id]: event.target.value }))}
                        onBlur={(event) => {
                          const position = Number.parseInt(event.currentTarget.value, 10);
                          if (Number.isFinite(position)) moveQueuedTo(item.id, position);
                          else setPositionDrafts((current) => {
                            const next = { ...current };
                            delete next[item.id];
                            return next;
                          });
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                        disabled={busy}
                        className="h-8 w-12 rounded-lg border border-input bg-primary/10 px-1 text-center text-xs font-bold text-primary"
                      />
                    </label>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold" title={filePath(item.file)}>{filePath(item.file)}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {formatNumber(item.file.size)} bytes
                            {item.status === "uploading" ? " - uploading" : ""}
                            {item.status === "uploaded" ? " - saved" : ""}
                            {item.status === "failed" ? ` - ${item.error}` : ""}
                          </p>
                        </div>
                        <div className="flex shrink-0 gap-1">
                          {compactQueue ? (
                            <button type="button" aria-label={`Edit details for ${item.file.name}`} disabled={busy} onClick={() => setExpandedSourceId((current) => current === item.id ? null : item.id)} className="rounded-lg p-1.5 text-muted-foreground hover:bg-white/5 hover:text-foreground disabled:opacity-25">
                              <ChevronDown className={`h-4 w-4 transition-transform ${detailsOpen ? "rotate-180" : ""}`} />
                            </button>
                          ) : null}
                          <button type="button" aria-label="Move source up" disabled={busy || index === 0} onClick={() => moveQueued(index, -1)} className="rounded-lg p-1.5 text-muted-foreground hover:bg-white/5 hover:text-foreground disabled:opacity-25">
                            <ArrowUp className="h-4 w-4" />
                          </button>
                          <button type="button" aria-label="Move source down" disabled={busy || index === queue.length - 1} onClick={() => moveQueued(index, 1)} className="rounded-lg p-1.5 text-muted-foreground hover:bg-white/5 hover:text-foreground disabled:opacity-25">
                            <ArrowDown className="h-4 w-4" />
                          </button>
                          <button type="button" aria-label="Remove source" disabled={busy} onClick={() => setQueue((current) => current.filter((entry) => entry.id !== item.id))} className="rounded-lg p-1.5 text-muted-foreground hover:bg-red-400/10 hover:text-red-300 disabled:opacity-25">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                      <div className={`${compactQueue ? "mt-2" : "mt-3"} grid gap-2 sm:grid-cols-2`}>
                        <select
                          value={item.sourceKind}
                          onChange={(event) => updateQueued(item.id, { sourceKind: event.target.value as WorldSource["sourceKind"] })}
                          disabled={busy}
                          aria-label={`Type for ${item.file.name}`}
                          className="h-9 rounded-lg border border-input bg-background px-2 text-xs"
                        >
                          {sourceKinds.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                        <select
                          value={item.relation}
                          onChange={(event) => updateQueued(item.id, { relation: event.target.value as WorldSource["chronologyRelation"] })}
                          disabled={busy}
                          aria-label={`Chronology for ${item.file.name}`}
                          className="h-9 rounded-lg border border-input bg-background px-2 text-xs"
                        >
                          {chronologyRelations.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                      </div>
                      {detailsOpen ? (
                        <div className="mt-2 grid gap-2">
                          <Input
                            value={item.label}
                            onChange={(event) => updateQueued(item.id, { label: event.target.value })}
                            disabled={busy}
                            placeholder="Optional time label: Year 18, three months later..."
                            maxLength={240}
                            className="h-9 rounded-lg text-xs"
                          />
                          <Input
                            value={item.notes}
                            onChange={(event) => updateQueued(item.id, { notes: event.target.value })}
                            disabled={busy}
                            placeholder="Optional source note: flashbacks, alternate POV, draft status..."
                            maxLength={500}
                            className="h-9 rounded-lg text-xs"
                          />
                          {item.sourceKind === "manuscript" ? (
                            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-white/8 bg-black/15 px-3 py-2 text-xs text-muted-foreground">
                              <Checkbox
                                checked={item.fileAsChapter}
                                onCheckedChange={(checked) => updateQueued(item.id, { fileAsChapter: checked === true })}
                                disabled={busy}
                              />
                              Use the filename as this chapter’s heading when the file has no internal heading
                            </label>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              );})}
              {queuePageCount > 1 ? (
                <div className="flex items-center justify-between rounded-xl border border-white/8 bg-black/15 px-3 py-2 text-xs text-muted-foreground">
                  <Button type="button" variant="ghost" size="sm" className="h-8 rounded-lg" disabled={busy || queuePage === 0} onClick={() => setQueuePage((current) => Math.max(0, current - 1))}>
                    <ChevronLeft className="mr-1 h-4 w-4" /> Previous
                  </Button>
                  <span>Files {queuePageStart + 1}–{Math.min(queue.length, queuePageStart + visibleQueue.length)} of {queue.length}</span>
                  <Button type="button" variant="ghost" size="sm" className="h-8 rounded-lg" disabled={busy || queuePage >= queuePageCount - 1} onClick={() => setQueuePage((current) => Math.min(queuePageCount - 1, current + 1))}>
                    Next <ChevronRight className="ml-1 h-4 w-4" />
                  </Button>
                </div>
              ) : null}
              <Textarea
                value={chronologySummary}
                onChange={(event) => setChronologySummary(event.target.value)}
                disabled={busy}
                placeholder="Optional chronology note: Book Two begins eighteen months after Book One but includes earlier flashbacks."
                maxLength={2_000}
                className="min-h-20 rounded-xl text-sm"
              />
            </div>
          ) : null}

          {queue.length ? (
            <div className="rounded-2xl border border-amber-300/25 bg-amber-300/[0.07] p-4 text-sm leading-6 text-amber-50">
              {queue.every((item) => item.sourceKind === "reference") ? (
                <>
                  <p className="flex items-center gap-2 font-semibold"><BookOpen className="h-4 w-4 text-primary" /> Reference-only files do not launch a paid canon review</p>
                  <p className="mt-1 text-xs leading-5 text-amber-50/75">Lorekeeper stores their extracted text as universe lore. The Director may use it for setting rules and flavor, but it cannot turn it into a story event or give it to a character without the selected knowledge scope.</p>
                </>
              ) : (
                <>
                  <p className="flex items-center gap-2 font-semibold"><Sparkles className="h-4 w-4 text-primary" /> Importing automatically starts Canon Intake</p>
                  <p className="mt-1 text-xs leading-5 text-amber-50/75">Canon Intake reads and organizes your material into the cited Lorekeeper world, then stops when that world is ready. Premium Deep Reading starts only if you choose it afterward. Work is saved as intake finishes, and retrying or resuming the same uploaded material does not charge again for completed work.</p>
                  <p className="mt-2 text-xs leading-5 text-amber-50/75">One world intake can contain up to 250,000 words across any number of files. Storyhold checks and reserves the complete balance before reading begins; an intake over 150,000 words needs more than 250 credits.</p>
                </>
              )}
            </div>
          ) : null}

          <Button type="submit" className="h-11 w-full rounded-xl" disabled={busy || queue.length === 0}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
            {busy ? stage : `Import ${queue.length || "these"} source${queue.length === 1 ? "" : "s"}`}
          </Button>
          {queue.some((item) => item.sourceKind !== "reference") ? (
            <p className="text-center text-[11px] leading-5 text-muted-foreground">
              Starting Canon Intake means you accept the <Link href="/credit-terms" target="_blank" className="font-semibold text-primary hover:underline">Credits and Intake Policy</Link> and <Link href="/refunds" target="_blank" className="font-semibold text-primary hover:underline">Refund Policy</Link>.
            </p>
          ) : null}
        </form>
      </Card>

      <Card className="rounded-3xl border-white/10 bg-[linear-gradient(145deg,rgba(56,189,248,0.09),rgba(18,17,21,0.96)_45%)] p-5 md:p-7">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              Canon intake
            </p>
            <h2 className="mt-2 font-serif text-3xl font-bold">{stage}</h2>
          </div>
          {busy ? <Loader2 className="h-6 w-6 animate-spin text-primary" /> : result ? <CheckCircle2 className="h-7 w-7 text-emerald-400" /> : <BookOpen className="h-7 w-7 text-primary" />}
        </div>

        {result ? (
          <div className="mt-6 space-y-5">
            {intakeGate && !intakeGate.canStart ? (
              <div className="rounded-2xl border border-amber-300/30 bg-amber-300/[0.08] p-4">
                <p className="font-semibold text-amber-50">Your files are safe. No intake credits were charged.</p>
                <p className="mt-2 text-sm leading-6 text-amber-50/75">
                  {intakeGate.overLimit
                    ? `This world contains ${intakeGate.wordCount.toLocaleString()} words; one Canon Intake accepts up to ${intakeGate.wordLimit.toLocaleString()}.`
                    : `The complete intake needs ${intakeGate.requiredCredits.toLocaleString()} credits and your account has ${intakeGate.availableCredits.toLocaleString()}. Add credits, then return to this world and start Canon Intake.`}
                </p>
                {!intakeGate.overLimit ? <Button asChild className="mt-3 rounded-xl"><Link href="/credits">Add credits</Link></Button> : null}
              </div>
            ) : null}
            <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
              <p className="font-semibold">{result.worldName}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {result.uploaded} source{result.uploaded === 1 ? "" : "s"} added
                {result.failed ? `; ${result.failed} needs attention` : ""}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {findings.map((finding) => (
                <div key={finding.label} className="rounded-2xl border border-white/8 bg-white/[0.025] p-3 sm:p-4">
                  <finding.icon className="h-4 w-4 text-primary" />
                  <div className="mt-3 font-serif text-3xl font-bold">{finding.value}</div>
                  <div className="mt-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{finding.label}</div>
                </div>
              ))}
            </div>
            <p className="text-sm leading-6 text-muted-foreground">
              Every file remains separately cited. You can adjust the overall chronology and add more sources from the world itself.
            </p>
            {result.detail?.world.metadataInferenceStatus === "generated" ? (
              <div className="rounded-2xl border border-primary/25 bg-primary/[0.07] p-4">
                <p className="flex items-center gap-2 font-semibold">
                  <Sparkles className="h-4 w-4 text-primary" /> Storyhold filled in the world
                </p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  <span className="text-foreground">Genre:</span>{" "}
                  {result.detail.world.genre || "Still open"}
                  <br />
                  <span className="text-foreground">Atmosphere:</span>{" "}
                  {result.detail.world.worldContract.tone || "Still open"}
                </p>
              </div>
            ) : result.detail?.world.metadataInferenceStatus === "requested" ? (
              <div className="rounded-2xl border border-white/8 bg-black/20 p-4 text-sm leading-6 text-muted-foreground">
                The sources are safely indexed. Genre, atmosphere, and premise will be filled
                in when Premium Deep Reading completes.
              </div>
            ) : null}
            <Button asChild className="w-full rounded-xl">
              <Link href={`/profile/worlds/${result.worldId}`}>Open {result.worldName}</Link>
            </Button>
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            {[
              [FileText, "Separate evidence", "Books, sheets, rules, and notes remain distinct sources."],
              [Layers3, "One canonical world", "All sources share stable world and canon identifiers."],
              [Sparkles, "Chronology without false precision", "Use exact dates, relative order, overlap, or let Storyhold infer uncertainty."],
            ].map(([Icon, title, copy]) => {
              const ItemIcon = Icon as typeof FileText;
              return (
                <div key={String(title)} className="flex gap-3 rounded-2xl border border-white/8 bg-black/15 p-4">
                  <ItemIcon className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                  <div>
                    <p className="font-semibold">{String(title)}</p>
                    <p className="mt-1 text-sm leading-5 text-muted-foreground">{String(copy)}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

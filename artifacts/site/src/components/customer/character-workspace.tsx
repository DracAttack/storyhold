import { useState, useRef } from "react";
import {
  FileText,
  Paperclip,
  Link as LinkIcon,
  MoreVertical,
  Pencil,
  Trash2,
  ArrowUp,
  ArrowDown,
  File,
  FileImage,
  FileAudio,
  FileVideo,
  FileArchive,
  BookOpen,
  Map,
  Clock,
  Loader2,
  Save,
  Download,
} from "lucide-react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type WorkspaceItemKind = "note" | "file" | "source" | "scene";

export interface CharacterWorkspaceItem {
  id: string;
  kind: WorkspaceItemKind;
  title: string;
  body?: string;
  objectPath?: string;
  referenceId?: string;
  file?: {
    name: string;
    size: number;
    type: string;
  };
  provenance: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CharacterWorkspaceReference {
  id: string;
  kind: "source" | "scene";
  title: string;
  metadata?: string;
}

export interface CharacterWorkspaceProps {
  worldId: string;
  characterId: string;
  items: CharacterWorkspaceItem[];
  references: CharacterWorkspaceReference[];
  onAddNote: (title: string, body: string) => Promise<void>;
  onAddFile: (file: File) => Promise<void>;
  onLinkReference: (kind: "source" | "scene", referenceId: string, title: string) => Promise<void>;
  onUpdateItem: (id: string, updates: Partial<CharacterWorkspaceItem>) => Promise<void>;
  onRemoveItem: (id: string) => Promise<void>;
  onReorderItems: (itemIds: string[]) => Promise<void>;
  onOpenFile: (id: string) => Promise<void>;
}

function formatBytes(bytes: number, decimals = 1) {
  if (!+bytes) return '0 Bytes'
  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`
}

function FileIconForType({ type, className }: { type: string, className?: string }) {
  if (type.startsWith("image/")) return <FileImage className={className} />;
  if (type.startsWith("audio/")) return <FileAudio className={className} />;
  if (type.startsWith("video/")) return <FileVideo className={className} />;
  if (type.includes("zip") || type.includes("tar") || type.includes("compressed")) return <FileArchive className={className} />;
  return <File className={className} />;
}

function provenanceLabel(kind: WorkspaceItemKind) {
  if (kind === "file") return "Uploaded manually";
  if (kind === "source" || kind === "scene") return "Linked manually";
  return "Added manually";
}

export function CharacterWorkspace({
  worldId,
  characterId,
  items,
  references,
  onAddNote,
  onAddFile,
  onLinkReference,
  onUpdateItem,
  onRemoveItem,
  onReorderItems,
  onOpenFile,
}: CharacterWorkspaceProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [noteDialogOpen, setNoteDialogOpen] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteTitle, setNoteTitle] = useState("");
  const [noteBody, setNoteBody] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [linkKind, setLinkKind] = useState<"source" | "scene">("source");
  const [linkId, setLinkId] = useState("");

  const sortedItems = [...items].sort((a, b) => a.sortOrder - b.sortOrder);

  const handleOpenNewNote = () => {
    setEditingNoteId(null);
    setNoteTitle("");
    setNoteBody("");
    setNoteDialogOpen(true);
  };

  const handleOpenEditItem = (item: CharacterWorkspaceItem) => {
    setEditingNoteId(item.id);
    setNoteTitle(item.title);
    setNoteBody(item.body || "");
    setNoteDialogOpen(true);
  };

  const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

  const handleSaveNote = async () => {
    if (!noteTitle.trim()) {
      toast.error("A title is required.");
      return;
    }
    setIsSubmitting(true);
    try {
      if (editingNoteId) {
        const existing = items.find((item) => item.id === editingNoteId);
        await onUpdateItem(editingNoteId, existing?.kind === "note" ? { title: noteTitle, body: noteBody } : { title: noteTitle });
        toast.success("Note updated.");
      } else {
        await onAddNote(noteTitle, noteBody);
        toast.success("Note created.");
      }
      setNoteDialogOpen(false);
    } catch (e) {
      toast.error(errorMessage(e, "Could not save the item."));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setIsSubmitting(true);
    const toastId = toast.loading("Uploading file...");
    try {
      await onAddFile(file);
      toast.success("File attached.", { id: toastId });
    } catch (err) {
      toast.error(errorMessage(err, "Could not attach file."), { id: toastId });
    } finally {
      setIsSubmitting(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleSaveLink = async () => {
    const selected = references.find((reference) => reference.id === linkId && reference.kind === linkKind);
    if (!selected) {
      toast.error("Select a record to link.");
      return;
    }
    setIsSubmitting(true);
    try {
      await onLinkReference(linkKind, selected.id, selected.title);
      toast.success("Link added.");
      setLinkDialogOpen(false);
      setLinkId("");
    } catch (e) {
      toast.error(errorMessage(e, "Could not add link."));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemove = async (id: string) => {
    if (!window.confirm("Remove this workspace item? This cannot be undone.")) return;
    const toastId = toast.loading("Removing item...");
    try {
      await onRemoveItem(id);
      toast.success("Item removed.", { id: toastId });
    } catch (e) {
      toast.error(errorMessage(e, "Could not remove item."), { id: toastId });
    }
  };

  const handleMove = async (index: number, direction: "up" | "down") => {
    const newIndex = direction === "up" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= sortedItems.length) return;
    
    const newItems = [...sortedItems];
    const temp = newItems[index];
    newItems[index] = newItems[newIndex];
    newItems[newIndex] = temp;
    
    const newOrderIds = newItems.map(i => i.id);
    try {
      await onReorderItems(newOrderIds);
    } catch (e) {
      toast.error(errorMessage(e, "Could not reorder items."));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/10 pb-4">
        <div>
          <h2 className="font-serif text-2xl font-bold flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-primary" />
            Notes &amp; Files
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            A private scratchpad and file folio for this character.
          </p>
        </div>
        
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <Button 
            variant="outline" 
            size="sm" 
            className="border-primary/20 bg-primary/5 text-primary hover:bg-primary/10 transition-colors"
            onClick={handleOpenNewNote}
          >
            <FileText className="h-3.5 w-3.5 mr-1.5" />
            New Note
          </Button>
          <Button 
            variant="outline" 
            size="sm"
            className="border-white/10 bg-black/20 hover:bg-white/5 transition-colors"
            onClick={() => fileInputRef.current?.click()}
            disabled={isSubmitting}
          >
            <Paperclip className="h-3.5 w-3.5 mr-1.5" />
            Attach File
          </Button>
          <input 
            type="file" 
            className="hidden" 
            ref={fileInputRef} 
            onChange={handleFileSelect} 
            accept=".pdf,.epub,.docx,.txt,.md,.markdown,.pptx,.xlsx,.odt,.odp,.ods,.jpg,.jpeg,.png,.gif,.webp,application/pdf,application/epub+zip,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.oasis.opendocument.text,application/vnd.oasis.opendocument.presentation,application/vnd.oasis.opendocument.spreadsheet,image/jpeg,image/png,image/gif,image/webp"
          />
          <Button 
            variant="outline" 
            size="sm"
            className="border-white/10 bg-black/20 hover:bg-white/5 transition-colors"
            onClick={() => {
              setLinkKind("source");
              setLinkId("");
              setLinkDialogOpen(true);
            }}
          >
            <LinkIcon className="h-3.5 w-3.5 mr-1.5" />
            Link
          </Button>
        </div>
      </div>

      {sortedItems.length === 0 ? (
        <Card className="rounded-2xl border border-dashed border-white/10 bg-black/10 p-8 text-center transition-colors hover:border-primary/30 hover:bg-primary/[0.02]">
          <BookOpen className="mx-auto h-8 w-8 text-muted-foreground/40 mb-3" />
          <h3 className="font-serif text-lg font-bold text-foreground/70">The folio is empty</h3>
          <p className="mt-1 text-sm text-muted-foreground max-w-md mx-auto">
            Keep character-specific notes, attach reference images, or link directly to scenes and sources that matter.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {sortedItems.map((item, index) => (
            <div
              key={item.id} 
              className="group relative flex items-start gap-4 rounded-xl border border-white/5 bg-black/15 p-4 shadow-sm transition-colors hover:border-primary/20 hover:bg-primary/[0.03]"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  {item.kind === "note" && <FileText className="h-4 w-4 text-primary/70 shrink-0" />}
                  {item.kind === "file" && <FileIconForType type={item.file?.type || ""} className="h-4 w-4 text-emerald-500/70 shrink-0" />}
                  {item.kind === "source" && <BookOpen className="h-4 w-4 text-blue-400/70 shrink-0" />}
                  {item.kind === "scene" && <Map className="h-4 w-4 text-purple-400/70 shrink-0" />}
                  
                    <h4 className="font-serif font-bold text-foreground/90 truncate">
                      {(item.kind === "source" || item.kind === "scene")
                        ? references.find((candidate) => candidate.id === item.referenceId && candidate.kind === item.kind)?.title ?? item.title
                        : item.title}
                    </h4>
                  
                  <Badge variant="outline" className="ml-2 bg-black/20 border-white/10 text-[9px] uppercase tracking-wider text-muted-foreground shrink-0">
                    {item.kind}
                  </Badge>
                </div>
                
                {item.kind === "note" && item.body && (
                  <p className="mt-2 text-sm leading-relaxed text-foreground/80 line-clamp-3 whitespace-pre-wrap">
                    {item.body}
                  </p>
                )}
                
                {item.kind === "file" && item.file && (
                  <p className="mt-2 text-xs text-muted-foreground flex items-center gap-3">
                    <span className="font-mono">{formatBytes(item.file.size)}</span>
                    <span className="uppercase">{item.file.type.split('/')[1] || item.file.type}</span>
                  </p>
                )}
                
                {(item.kind === "source" || item.kind === "scene") && (() => {
                  const reference = references.find((candidate) => candidate.id === item.referenceId && candidate.kind === item.kind);
                  return (
                  <p className="mt-2 text-xs text-muted-foreground flex flex-wrap items-center gap-1.5">
                    <LinkIcon className="h-3 w-3" />
                    <span className="font-medium text-foreground/80">{reference?.title ?? "Linked record"}</span>
                    {reference?.metadata ? <span>· {reference.metadata}</span> : null}
                  </p>
                  );
                })()}
                
                <div className="mt-3 flex items-center gap-3 text-[10px] text-muted-foreground/60 font-medium">
                  <span className="flex items-center gap-1.5">
                    <Clock className="h-3 w-3" />
                    {new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(item.updatedAt))}
                  </span>
                  <span>•</span>
                  <span>{provenanceLabel(item.kind)}</span>
                </div>
              </div>

              <div className="shrink-0 flex items-center">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground">
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-40 border-white/10 bg-black/90 backdrop-blur-xl">
                    {item.kind === "file" && (
                      <DropdownMenuItem onClick={() => void onOpenFile(item.id).catch((error) => toast.error(errorMessage(error, "Could not open the file.")))} className="cursor-pointer focus:bg-primary/15 focus:text-primary">
                        <Download className="mr-2 h-4 w-4" /> Open / Download
                      </DropdownMenuItem>
                    )}
                    {(item.kind === "note" || item.kind === "file" || item.kind === "source" || item.kind === "scene") && (
                      <DropdownMenuItem onClick={() => handleOpenEditItem(item)} className="cursor-pointer focus:bg-primary/15 focus:text-primary">
                        <Pencil className="mr-2 h-4 w-4" /> Edit
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem 
                      onClick={() => handleMove(index, "up")} 
                      disabled={index === 0}
                      className="cursor-pointer focus:bg-white/10"
                    >
                      <ArrowUp className="mr-2 h-4 w-4" /> Move Up
                    </DropdownMenuItem>
                    <DropdownMenuItem 
                      onClick={() => handleMove(index, "down")} 
                      disabled={index === sortedItems.length - 1}
                      className="cursor-pointer focus:bg-white/10"
                    >
                      <ArrowDown className="mr-2 h-4 w-4" /> Move Down
                    </DropdownMenuItem>
                    <DropdownMenuSeparator className="bg-white/10" />
                    <DropdownMenuItem onClick={() => handleRemove(item.id)} className="cursor-pointer text-red-400 focus:bg-red-400/10 focus:text-red-400">
                      <Trash2 className="mr-2 h-4 w-4" /> Remove
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Note Dialog */}
      <Dialog open={noteDialogOpen} onOpenChange={setNoteDialogOpen}>
        <DialogContent className="sm:max-w-[600px] border-primary/20 bg-black/95 backdrop-blur-xl">
          <DialogHeader>
            <DialogTitle className="font-serif text-2xl text-primary">
              {editingNoteId ? "Edit Item" : "New Note"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label htmlFor="note-title" className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Title
              </label>
              <Input 
                id="note-title"
                value={noteTitle}
                onChange={(e) => setNoteTitle(e.target.value)}
                placeholder="A notable observation..."
                className="border-white/10 bg-black/20 focus-visible:border-primary/50 text-foreground"
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="note-body" className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Content {editingNoteId && !items.find((item) => item.id === editingNoteId && item.kind === "note") ? "(notes only)" : ""}
              </label>
              <Textarea 
                id="note-body"
                value={noteBody}
                onChange={(e) => setNoteBody(e.target.value)}
                placeholder="Details, theories, reminders..."
                disabled={Boolean(editingNoteId && !items.find((item) => item.id === editingNoteId && item.kind === "note"))}
                className="min-h-[200px] border-white/10 bg-black/20 focus-visible:border-primary/50 text-foreground leading-relaxed"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setNoteDialogOpen(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button 
              onClick={handleSaveNote} 
              disabled={isSubmitting || !noteTitle.trim()}
              className="bg-primary text-primary-foreground font-bold shadow-md hover:brightness-110"
            >
              {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              {editingNoteId ? "Save Changes" : "Create Note"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Link Dialog */}
      <Dialog open={linkDialogOpen} onOpenChange={setLinkDialogOpen}>
        <DialogContent className="sm:max-w-[425px] border-primary/20 bg-black/95 backdrop-blur-xl">
          <DialogHeader>
            <DialogTitle className="font-serif text-2xl text-primary">
              Link Record
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Record Type
              </label>
              <Select value={linkKind} onValueChange={(v: "source" | "scene") => setLinkKind(v)}>
                <SelectTrigger className="border-white/10 bg-black/20 storyhold-select text-foreground">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-white/10 bg-[#19171b] text-[#f8f2e9]">
                  <SelectItem value="source">Source</SelectItem>
                  <SelectItem value="scene">Scene</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Available record
              </label>
              <Select value={linkId} onValueChange={setLinkId}>
                <SelectTrigger className="border-white/10 bg-black/20 storyhold-select text-foreground"><SelectValue placeholder={`Choose a ${linkKind}`} /></SelectTrigger>
                <SelectContent className="border-white/10 bg-[#19171b] text-[#f8f2e9]">
                  {references.filter((reference) => reference.kind === linkKind).map((reference) => (
                    <SelectItem key={reference.id} value={reference.id}>{reference.title}{reference.metadata ? ` · ${reference.metadata}` : ""}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {references.filter((reference) => reference.kind === linkKind).length === 0 ? <p className="text-xs text-muted-foreground">No available {linkKind}s can be linked yet.</p> : null}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setLinkDialogOpen(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button 
              onClick={handleSaveLink} 
              disabled={isSubmitting || !linkId}
              className="bg-primary text-primary-foreground font-bold shadow-md hover:brightness-110"
            >
              {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <LinkIcon className="mr-2 h-4 w-4" />}
              Add Link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

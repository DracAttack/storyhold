import { useState, type FormEvent } from "react";
import { ExternalLink, FileUp, Globe2, Loader2, Search, ShieldCheck } from "lucide-react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  addWorldExternalReference,
  discoverWorldExternalReferences,
  type ReferenceKnowledgeScope,
  type ReferenceLoreStatus,
  type WorldDetail,
  type WorldReferenceLead,
} from "@/lib/storyholdApi";

export function WorldLorekeeperPanel({
  detail,
  onChanged,
}: {
  detail: WorldDetail;
  onChanged: () => void;
}) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [query, setQuery] = useState("");
  const [leads, setLeads] = useState<WorldReferenceLead[]>([]);
  const [knowledgeScope, setKnowledgeScope] =
    useState<ReferenceKnowledgeScope>("director_only");
  const [knownBy, setKnownBy] = useState("");
  const [loreStatus, setLoreStatus] =
    useState<ReferenceLoreStatus>("supplemental");
  const references = detail.externalReferences ?? [];
  const uploadedReferences = detail.sources.filter(
    (source) => source.sourceKind === "reference" || source.canonStatus === "reference",
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!url.trim() || saving) return;
    setSaving(true);
    try {
      const response = await addWorldExternalReference({
        worldId: detail.world.id,
        url: url.trim(),
        title: title.trim() || undefined,
        reviewStatus: "approved",
        knowledgeScope,
        knownBy: knownBy.split(/[,;\n]/u).map((value) => value.trim()).filter(Boolean),
        loreStatus,
      });
      setUrl("");
      setTitle("");
      onChanged();
      if (response.reference.extractionStatus === "ready") {
        toast.success("Lorekeeper ingested the reference as background context.");
      } else {
        toast.warning("The link was saved, but Lorekeeper could not read its contents yet.");
      }
    } catch (reason) {
      toast.error(
        reason instanceof Error ? reason.message : "Lorekeeper could not ingest that page.",
      );
    } finally {
      setSaving(false);
    }
  };

  const discover = async () => {
    if (discovering) return;
    setDiscovering(true);
    try {
      const response = await discoverWorldExternalReferences({
        worldId: detail.world.id,
        query: query.trim() || `${detail.world.name} ${detail.world.genre} official lore setting guide`,
      });
      setQuery(response.query);
      setLeads(response.leads);
      if (!response.leads.length) toast.info("Lorekeeper did not find a useful public reference for that search.");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Lorekeeper could not search for references.");
    } finally {
      setDiscovering(false);
    }
  };

  const ingestLead = async (lead: WorldReferenceLead) => {
    if (saving) return;
    setSaving(true);
    try {
      await addWorldExternalReference({
        worldId: detail.world.id,
        query,
        title: lead.title,
        url: lead.url,
        publisher: lead.publisher,
        summary: lead.summary,
        reviewStatus: "approved",
        knowledgeScope,
        knownBy: knownBy.split(/[,;\n]/u).map((value) => value.trim()).filter(Boolean),
        loreStatus,
      });
      setLeads((current) => current.filter((candidate) => candidate.url !== lead.url));
      onChanged();
      toast.success("Lorekeeper ingested the selected universe reference.");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Lorekeeper could not ingest that reference.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mt-5 rounded-3xl border-sky-300/15 bg-sky-300/[0.035] p-6">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-sky-300/20 bg-sky-300/[0.08] text-sky-200">
          <Globe2 className="h-5 w-5" />
        </span>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-200/80">Lorekeeper Vault</p>
          <h2 className="mt-1 font-serif text-2xl font-bold">Outside Reference Shelf</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            Add setting guides, wikis, rules, licensed fiction, or your own reference files. Lorekeeper can use them as real universe lore and consistent background flavor while keeping story canon and each character's personal knowledge separate.
          </p>
        </div>
      </div>

      <form onSubmit={submit} className="mt-5 grid gap-3 rounded-2xl border border-white/8 bg-black/15 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(180px,0.45fr)_auto] sm:items-end">
        <div>
          <Label htmlFor="lorekeeper-reference-url">Website address</Label>
          <Input
            id="lorekeeper-reference-url"
            className="mt-2 bg-black/20"
            type="url"
            required
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/world-guide"
          />
        </div>
        <div>
          <Label htmlFor="lorekeeper-reference-title">Label (optional)</Label>
          <Input
            id="lorekeeper-reference-title"
            className="mt-2 bg-black/20"
            value={title}
            onChange={(event) => setTitle(event.target.value.slice(0, 300))}
            placeholder="Lore guide"
          />
        </div>
        <Button type="submit" disabled={saving || !url.trim()} className="rounded-xl">
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Globe2 className="mr-2 h-4 w-4" />}
          Ingest page
        </Button>
      </form>

      <div className="mt-3 grid gap-3 rounded-2xl border border-white/8 bg-black/10 p-4 md:grid-cols-3">
        <div>
          <Label htmlFor="lorekeeper-lore-status">Lore authority</Label>
          <select id="lorekeeper-lore-status" value={loreStatus} onChange={(event) => setLoreStatus(event.target.value as ReferenceLoreStatus)} className="mt-2 h-10 w-full rounded-xl border border-input bg-background px-3 text-sm">
            <option value="official">Official universe lore</option>
            <option value="licensed">Licensed adaptation or sourcebook</option>
            <option value="supplemental">Supplemental reference</option>
            <option value="homebrew">Homebrew or house lore</option>
            <option value="disputed">Disputed interpretation</option>
          </select>
        </div>
        <div>
          <Label htmlFor="lorekeeper-knowledge-scope">Character knowledge</Label>
          <select id="lorekeeper-knowledge-scope" value={knowledgeScope} onChange={(event) => setKnowledgeScope(event.target.value as ReferenceKnowledgeScope)} className="mt-2 h-10 w-full rounded-xl border border-input bg-background px-3 text-sm">
            <option value="director_only">Lorekeeper only</option>
            <option value="common">Common knowledge</option>
            <option value="selected">Known by selected characters</option>
            <option value="discoverable">Discoverable during play</option>
          </select>
        </div>
        <div>
          <Label htmlFor="lorekeeper-known-by">Known by {knowledgeScope === "selected" ? "(required)" : "(optional)"}</Label>
          <Input id="lorekeeper-known-by" className="mt-2 bg-black/20" value={knownBy} onChange={(event) => setKnownBy(event.target.value.slice(0, 2_000))} disabled={knowledgeScope !== "selected"} placeholder="Driver, Miranda" />
        </div>
        <p className="text-xs leading-5 text-muted-foreground md:col-span-3">
          “Lorekeeper only” can shape consistent causality without appearing in a character's thoughts. “Discoverable” may surface through a plausible terminal, archive, witness, artifact, or investigation—and only then becomes character knowledge.
        </p>
      </div>

      <div className="mt-3 rounded-2xl border border-white/8 bg-black/10 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <Label htmlFor="lorekeeper-reference-search">Find related public lore</Label>
            <Input id="lorekeeper-reference-search" className="mt-2 bg-black/20" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`e.g. ${detail.world.name} licensed novels setting lore`} />
          </div>
          <Button type="button" variant="outline" onClick={() => void discover()} disabled={discovering} className="rounded-xl">
            {discovering ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
            Find lore
          </Button>
        </div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">Search returns candidates first. Nothing is added until you choose it, and Lorekeeper reads only public pages the site permits it to access.</p>
        {leads.length ? (
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {leads.map((lead) => (
              <div key={lead.url} className="rounded-xl border border-white/8 bg-black/15 p-3">
                <p className="text-sm font-semibold">{lead.title}</p>
                <p className="mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground">{lead.summary}</p>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <span className="truncate text-[10px] uppercase tracking-wide text-sky-100/70">{lead.publisher}</span>
                  <Button type="button" size="sm" onClick={() => void ingestLead(lead)} disabled={saving} className="h-8 rounded-lg">Add to Lorekeeper</Button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex flex-col gap-3 rounded-2xl border border-white/8 bg-black/10 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-2 text-sm leading-6 text-muted-foreground">
          <ShieldCheck className="mt-1 h-4 w-4 shrink-0 text-sky-200" />
          <span>Reference uploads stay outside the story chronology and do not trigger a paid manuscript review. Their lore authority and character-knowledge scope are preserved.</span>
        </div>
        <Button asChild variant="outline" className="shrink-0 rounded-xl">
          <Link href={`/profile/import?world=${detail.world.id}&reference=1`}>
            <FileUp className="mr-2 h-4 w-4" /> Upload references
          </Link>
        </Button>
      </div>

      {references.length || uploadedReferences.length ? (
        <details className="mt-4 rounded-2xl border border-white/8 bg-black/10 px-4 py-3">
          <summary className="cursor-pointer text-sm font-semibold">
            Saved references <span className="font-normal text-muted-foreground">({references.length + uploadedReferences.length})</span>
          </summary>
          <div className="mt-3 grid gap-2 border-t border-white/8 pt-3 md:grid-cols-2">
            {references.map((reference) => (
              <a key={reference.id} href={reference.url} target="_blank" rel="noreferrer" className="rounded-xl border border-white/8 bg-black/15 p-3 transition-colors hover:border-sky-300/30">
                <span className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{reference.title}</span>
                    <span className="mt-1 block text-[10px] uppercase tracking-wide text-sky-100/70">
                      {reference.extractionStatus === "ready"
                        ? `${reference.wordCount.toLocaleString()} words indexed`
                        : reference.extractionStatus === "failed"
                          ? "Saved · reading failed"
                          : "Saved lore summary"} · {reference.loreStatus} · {reference.knowledgeScope.replaceAll("_", " ")}
                    </span>
                  </span>
                  <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </span>
                {reference.summary ? <span className="mt-2 block line-clamp-3 text-xs leading-5 text-muted-foreground">{reference.summary}</span> : null}
                {reference.processingError ? <span className="mt-2 block text-xs leading-5 text-amber-200/80">{reference.processingError}</span> : null}
              </a>
            ))}
            {uploadedReferences.map((reference) => (
              <div key={reference.id} className="rounded-xl border border-white/8 bg-black/15 p-3">
                <p className="truncate text-sm font-semibold">{reference.title}</p>
                <p className="mt-1 text-[10px] uppercase tracking-wide text-sky-100/70">
                  Uploaded reference · {reference.wordCount.toLocaleString()} words · {(reference.referenceLoreStatus ?? "supplemental").replaceAll("_", " ")} · {(reference.referenceKnowledgeScope ?? "director_only").replaceAll("_", " ")}
                </p>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </Card>
  );
}

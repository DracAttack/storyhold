import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type DragEvent,
} from "react";
import { Link, useParams } from "wouter";
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  BrainCircuit,
  Check,
  CheckCircle2,
  Clock3,
  Database,
  FileArchive,
  FileText,
  Fingerprint,
  Loader2,
  LockKeyhole,
  Map,
  MessageSquareWarning,
  RefreshCw,
  SearchCheck,
  Send,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Upload,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  analyzeWorldSources,
  applyCanonDiscrepancy,
  explainCanonDiscrepancy,
  getWorld,
  reportCanonDiscrepancy,
  reviewCharacterDraft,
  reviewCohesionProposal,
  uploadWorldSource,
  type CharacterDraft,
  type CanonDiscrepancyReport,
  type CohesionProposal,
  type NamedFinding,
  type WorldDetail,
  type WorldSource,
} from "@/lib/storyholdApi";

const supportedExtensions =
  ".pdf,.epub,.docx,.txt,.md,.markdown,.pptx,.xlsx,.odt,.odp,.ods";

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sourceClassLabel(value: string): string {
  return (
    {
      original_author: "Original work",
      user_created: "User-created",
      licensed: "Licensed",
      public_domain: "Public domain",
      reference: "Research reference",
      fan_created: "Unofficial / fan-created",
    }[value] ?? value
  );
}

function reviewStatus(source: WorldSource): {
  label: string;
  variant: "default" | "secondary" | "destructive" | "outline";
} | null {
  if (source.aiReviewStatus === "reviewed") {
    return {
      label: `AI reviewed v${source.aiAnalysisVersion}`,
      variant: "default",
    };
  }
  if (source.aiReviewStatus === "running")
    return { label: "AI reviewing", variant: "secondary" };
  if (source.aiReviewStatus === "queued")
    return { label: "AI review queued", variant: "secondary" };
  if (source.localScanStatus === "running")
    return { label: "Local scan running", variant: "secondary" };
  if (
    source.localScanStatus === "pending" ||
    source.localScanStatus === "queued"
  )
    return { label: "Local scan queued", variant: "secondary" };
  if (source.aiReviewStatus === "waiting")
    return { label: "Waiting for AI review", variant: "outline" };
  if (
    source.localScanStatus === "failed" ||
    source.aiReviewStatus === "failed"
  )
    return { label: "Review needs attention", variant: "destructive" };
  return null;
}

function SourceRow({ source }: { source: WorldSource }) {
  const sourceReview = reviewStatus(source);
  return (
    <div className="flex flex-col gap-3 border-b px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <div
          className={`mt-0.5 rounded-lg p-2 ${source.processingStatus === "ready" ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive"}`}
        >
          <FileText className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-medium">{source.title}</h3>
            <Badge
              variant={
                source.processingStatus === "ready"
                  ? "secondary"
                  : "destructive"
              }
            >
              {source.documentType.toUpperCase()}
            </Badge>
            <Badge variant="outline">{source.canonStatus}</Badge>
            {sourceReview ? (
              <Badge variant={sourceReview.variant}>{sourceReview.label}</Badge>
            ) : null}
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {source.originalFilename}
          </p>
          {source.processingError ? (
            <p className="mt-2 text-xs text-destructive">
              {source.processingError}
            </p>
          ) : null}
        </div>
      </div>
      <div className="grid shrink-0 grid-cols-3 gap-4 text-right text-xs">
        <div>
          <div className="font-medium tabular-nums">
            {formatNumber(source.wordCount)}
          </div>
          <div className="text-muted-foreground">words</div>
        </div>
        <div>
          <div className="font-medium tabular-nums">
            {formatNumber(source.chunkCount)}
          </div>
          <div className="text-muted-foreground">passages</div>
        </div>
        <div>
          <div className="font-medium tabular-nums">
            {formatBytes(source.byteSize)}
          </div>
          <div className="text-muted-foreground">file</div>
        </div>
      </div>
    </div>
  );
}

const cohesionClassifications = [
  ["needs_research", "Needs research"],
  ["canon_correction", "Possible canon correction"],
  ["intentional_contradiction", "Intentional contradiction"],
  ["unreliable_narration", "Unreliable narration"],
  ["alternate_edition", "Alternate edition / timeline"],
] as const;

function CohesionProposalCard({
  proposal,
  classification,
  reviewing,
  onClassification,
  onReview,
}: {
  proposal: CohesionProposal;
  classification: string;
  reviewing: boolean;
  onClassification: (value: string) => void;
  onReview: (decision: "approve" | "dismiss") => void;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={
                  proposal.severity === "conflict"
                    ? "destructive"
                    : proposal.severity === "warning"
                      ? "secondary"
                      : "outline"
                }
              >
                {proposal.kind}
              </Badge>
              <Badge variant="outline">{proposal.reviewStatus}</Badge>
            </div>
            <h3 className="mt-3 font-serif text-lg font-bold">
              {proposal.subject}
            </h3>
          </div>
          <MessageSquareWarning className="h-5 w-5 text-amber-600" />
        </div>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          {proposal.summary}
        </p>
        {proposal.evidence[0]?.quote ? (
          <blockquote className="mt-3 border-l-2 border-amber-500/40 pl-3 text-xs italic leading-5 text-muted-foreground">
            {proposal.evidence[0].quote}
          </blockquote>
        ) : null}
      </div>
      {proposal.reviewStatus === "pending" ? (
        <div className="space-y-3 border-t bg-muted/25 px-5 py-4">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div className="space-y-2">
              <Label>How should Storyhold remember this?</Label>
              <Select
                value={classification}
                onValueChange={onClassification}
                disabled={reviewing}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {cohesionClassifications.map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={reviewing}
                onClick={() => onReview("dismiss")}
              >
                Dismiss
              </Button>
              <Button
                size="sm"
                disabled={reviewing}
                onClick={() => onReview("approve")}
              >
                {reviewing ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Check className="mr-1.5 h-4 w-4" />
                )}
                Record decision
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            This records a resolution for later canon editing. It never changes
            canon by itself.
          </p>
        </div>
      ) : null}
    </Card>
  );
}

function DiscrepancyReportCard({
  report,
  reasoning,
  busy,
  onReasoning,
  onExplain,
  onApply,
}: {
  report: CanonDiscrepancyReport;
  reasoning: string;
  busy: boolean;
  onReasoning: (value: string) => void;
  onExplain: () => void;
  onApply: () => void;
}) {
  const status = {
    needs_reason: { label: "Needs your reason", variant: "secondary" as const },
    correction_offered: {
      label: "Correction found",
      variant: "default" as const,
    },
    applied: { label: "Canon corrected", variant: "default" as const },
    rejected: { label: "No change made", variant: "outline" as const },
  }[report.status];
  return (
    <Card className="overflow-hidden border-primary/15">
      <div className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Badge variant={status.variant}>{status.label}</Badge>
            <p className="mt-3 font-medium leading-6">{report.claim}</p>
          </div>
          {report.status === "applied" ? (
            <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
          ) : (
            <SearchCheck className="h-5 w-5 shrink-0 text-primary" />
          )}
        </div>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          {report.explanation}
        </p>
        {report.proposedAmendment ? (
          <div className="mt-4 rounded-lg border bg-muted/35 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Canon amendment
            </div>
            <div className="mt-1 font-medium">
              {report.proposedAmendment.subject}
            </div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {report.proposedAmendment.statement}
            </p>
          </div>
        ) : null}
        {report.evidence[0]?.quote ? (
          <blockquote className="mt-4 border-l-2 border-primary/30 pl-3 text-xs italic leading-5 text-muted-foreground">
            {report.evidence[0].quote}
          </blockquote>
        ) : null}
      </div>
      {report.status === "needs_reason" ? (
        <div className="border-t bg-muted/20 p-4">
          <Label htmlFor={`discrepancy-reason-${report.id}`}>
            Why can’t the current fact be right?
          </Label>
          <Textarea
            id={`discrepancy-reason-${report.id}`}
            className="mt-2"
            value={reasoning}
            onChange={(event) => onReasoning(event.target.value)}
            placeholder="For example: the story begins in 2012, so this character cannot have been born in 2015."
            rows={3}
            maxLength={4000}
            disabled={busy}
          />
          <Button
            className="mt-3"
            size="sm"
            onClick={onExplain}
            disabled={busy || reasoning.trim().length < 20}
          >
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-2 h-4 w-4" />
            )}
            Review my reason
          </Button>
        </div>
      ) : report.status === "correction_offered" ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/20 p-4">
          <p className="text-xs text-muted-foreground">
            Applying this adds a traceable amendment. Original sources stay
            untouched.
          </p>
          <Button size="sm" onClick={onApply} disabled={busy}>
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Check className="mr-2 h-4 w-4" />
            )}
            Use this correction
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function FindingSection({
  title,
  icon: Icon,
  items,
}: {
  title: string;
  icon: typeof Map;
  items: NamedFinding[];
}) {
  if (items.length === 0) return null;
  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="h-5 w-5 text-primary" />
        <h3 className="font-serif text-lg font-bold">{title}</h3>
      </div>
      <Accordion type="multiple">
        {items.slice(0, 30).map((item, index) => (
          <AccordionItem
            key={`${item.name}-${index}`}
            value={`${title}-${index}`}
          >
            <AccordionTrigger>{item.name}</AccordionTrigger>
            <AccordionContent>
              <p className="leading-6 text-muted-foreground">
                {item.summary || "No summary supplied."}
              </p>
              {item.evidence?.[0]?.quote ? (
                <blockquote className="mt-3 border-l-2 border-primary/30 pl-3 text-xs italic text-muted-foreground">
                  {item.evidence[0].quote}
                </blockquote>
              ) : null}
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </Card>
  );
}

function CharacterCard({
  draft,
  reviewing,
  onReview,
}: {
  draft: CharacterDraft;
  reviewing: boolean;
  onReview: (decision: "approve" | "reject") => void;
}) {
  const profileGroups = [
    ["Traits", draft.profile.traits],
    ["Motivations", draft.profile.motivations],
    ["Fears", draft.profile.fears],
    ["Capabilities", draft.profile.capabilities],
    ["Relationships", draft.profile.relationships],
    ["Knowledge", draft.profile.knowledge],
    ["Secrets", draft.profile.secrets],
  ].filter(
    (entry): entry is [string, string[]] =>
      Array.isArray(entry[1]) && entry[1].length > 0,
  );
  const percent = Math.round(draft.confidence * 100);

  return (
    <Card className="overflow-hidden">
      <div className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="rounded-full bg-primary/10 p-2.5 text-primary">
              <UserRound className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-serif text-xl font-bold">{draft.name}</h3>
                <Badge
                  variant={
                    draft.reviewStatus === "approved"
                      ? "default"
                      : draft.reviewStatus === "rejected"
                        ? "destructive"
                        : "secondary"
                  }
                >
                  {draft.reviewStatus}
                </Badge>
              </div>
              <p className="mt-1 text-sm font-medium text-primary/80">
                {draft.role || "Role not yet established"}
              </p>
            </div>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div className="font-semibold text-foreground">{percent}%</div>
            <div>draft confidence</div>
          </div>
        </div>
        <p className="mt-4 text-sm leading-6 text-muted-foreground">
          {draft.summary || "No grounded summary was extracted."}
        </p>

        {profileGroups.length > 0 ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {profileGroups.map(([label, values]) => (
              <div key={label} className="rounded-md bg-muted/60 p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {label}
                </div>
                <div className="mt-1 text-sm">{values.join(" · ")}</div>
              </div>
            ))}
          </div>
        ) : null}

        {draft.evidence?.[0]?.quote ? (
          <blockquote className="mt-4 border-l-2 border-primary/30 pl-3 text-xs italic leading-5 text-muted-foreground">
            {draft.evidence[0].quote}
          </blockquote>
        ) : null}
      </div>
      {draft.reviewStatus === "draft" ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/25 px-5 py-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <LockKeyhole className="h-3.5 w-3.5" /> Approval creates a locked
            canonical origin.
          </div>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={reviewing}
              onClick={() => onReview("reject")}
            >
              <X className="mr-1.5 h-4 w-4" />
              Reject
            </Button>
            <Button
              size="sm"
              disabled={reviewing}
              onClick={() => onReview("approve")}
            >
              {reviewing ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Check className="mr-1.5 h-4 w-4" />
              )}
              Approve as canon
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

export default function WorldStudio() {
  const { id = "" } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<WorldDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [sourceClass, setSourceClass] = useState("original_author");
  const [canonStatus, setCanonStatus] = useState("candidate");
  const [uploading, setUploading] = useState(false);
  const [uploadPosition, setUploadPosition] = useState(0);
  const [startingAnalysis, setStartingAnalysis] = useState(false);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewingProposalId, setReviewingProposalId] = useState<string | null>(
    null,
  );
  const [proposalClassifications, setProposalClassifications] = useState<
    Record<string, string>
  >({});
  const [discrepancyClaim, setDiscrepancyClaim] = useState("");
  const [submittingDiscrepancy, setSubmittingDiscrepancy] = useState(false);
  const [discrepancyReasoning, setDiscrepancyReasoning] = useState<
    Record<string, string>
  >({});
  const [resolvingDiscrepancyId, setResolvingDiscrepancyId] = useState<
    string | null
  >(null);

  const load = useCallback(
    async (showLoading = false) => {
      if (!id) return;
      if (showLoading) setLoading(true);
      try {
        const result = await getWorld(id);
        setDetail(result);
        setError(null);
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : "The world could not be loaded.",
        );
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [id],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  const analysisActive =
    detail?.latestRun?.status === "queued" ||
    detail?.latestRun?.status === "running";
  const automaticReviewPending =
    detail?.sources.some(
      (source) =>
        source.localScanStatus === "pending" ||
        source.localScanStatus === "queued" ||
        source.localScanStatus === "running" ||
        (detail.ai.configured &&
          (source.aiReviewStatus === "waiting" ||
            source.aiReviewStatus === "queued" ||
            source.aiReviewStatus === "running")),
    ) ?? false;
  useEffect(() => {
    if (!analysisActive && !automaticReviewPending) return;
    const timer = window.setInterval(() => void load(false), 1_250);
    return () => window.clearInterval(timer);
  }, [analysisActive, automaticReviewPending, load]);

  const totalWords = useMemo(
    () =>
      detail?.sources.reduce((sum, source) => sum + source.wordCount, 0) ?? 0,
    [detail],
  );
  const totalChunks = useMemo(
    () =>
      detail?.sources.reduce((sum, source) => sum + source.chunkCount, 0) ?? 0,
    [detail],
  );
  const analyzableChunks = useMemo(
    () =>
      detail?.sources
        .filter(
          (source) =>
            source.processingStatus === "ready" &&
            (source.canonStatus === "candidate" ||
              source.canonStatus === "canon"),
        )
        .reduce((sum, source) => sum + source.chunkCount, 0) ?? 0,
    [detail],
  );
  const waitingForAi = useMemo(
    () =>
      detail?.sources.filter((source) =>
        ["waiting", "queued", "running"].includes(source.aiReviewStatus),
      ).length ?? 0,
    [detail],
  );
  const aiReviewed = useMemo(
    () =>
      detail?.sources.filter(
        (source) => source.aiReviewStatus === "reviewed",
      ).length ?? 0,
    [detail],
  );

  const addFiles = (incoming: File[]) => {
    setFiles((current) => {
      const known = new Set(
        current.map((file) => `${file.name}:${file.size}:${file.lastModified}`),
      );
      return [
        ...current,
        ...incoming.filter(
          (file) =>
            !known.has(`${file.name}:${file.size}:${file.lastModified}`),
        ),
      ];
    });
  };

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    addFiles(Array.from(event.dataTransfer.files));
  };

  const uploadFiles = async () => {
    if (!detail || files.length === 0) return;
    setUploading(true);
    let successes = 0;
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]!;
      setUploadPosition(index + 1);
      if (file.size > 100 * 1024 * 1024) {
        toast.error(`${file.name} is over the 100 MB local limit.`);
        continue;
      }
      try {
        await uploadWorldSource({
          worldId: detail.world.id,
          file,
          sourceClass,
          canonStatus,
        });
        successes += 1;
      } catch (reason) {
        toast.error(
          `${file.name}: ${reason instanceof Error ? reason.message : "upload failed"}`,
        );
      }
    }
    setUploading(false);
    setUploadPosition(0);
    if (successes > 0) {
      toast.success(
        `${successes} source${successes === 1 ? "" : "s"} indexed in ${detail.world.name}.`,
      );
      setFiles([]);
      await load(false);
    }
  };

  const startAnalysis = async () => {
    if (!detail) return;
    if (detail.ai.billable) {
      const confirmed = window.confirm(
        `This forces a full cohesion check of every included source. It will send source passages to ${detail.ai.provider} and may create provider charges. Continue?`,
      );
      if (!confirmed) return;
    }
    setStartingAnalysis(true);
    try {
      await analyzeWorldSources(detail.world.id);
      toast.success(
        detail.ai.configured
          ? "Full cohesion check started."
          : "Private local inventory refresh started.",
      );
      await load(false);
    } catch (reason) {
      toast.error(
        reason instanceof Error ? reason.message : "Analysis could not start.",
      );
    } finally {
      setStartingAnalysis(false);
    }
  };

  const reviewProposal = async (
    proposal: CohesionProposal,
    decision: "approve" | "dismiss",
  ) => {
    if (!detail) return;
    const classification =
      proposalClassifications[proposal.id] ?? "needs_research";
    setReviewingProposalId(proposal.id);
    try {
      await reviewCohesionProposal({
        worldId: detail.world.id,
        proposalId: proposal.id,
        decision,
        classification: decision === "approve" ? classification : undefined,
      });
      toast.success(
        decision === "approve"
          ? "Cohesion decision recorded without changing canon."
          : "Cohesion proposal dismissed.",
      );
      await load(false);
    } catch (reason) {
      toast.error(
        reason instanceof Error
          ? reason.message
          : "The cohesion decision could not be saved.",
      );
    } finally {
      setReviewingProposalId(null);
    }
  };

  const submitDiscrepancy = async () => {
    if (!detail || discrepancyClaim.trim().length < 8) return;
    setSubmittingDiscrepancy(true);
    try {
      const result = await reportCanonDiscrepancy({
        worldId: detail.world.id,
        claim: discrepancyClaim,
      });
      setDiscrepancyClaim("");
      if (result.canonChanged) {
        toast.success("The continuity correction was applied.");
      } else if (result.report.status === "correction_offered") {
        toast.success("Storyhold found a supported correction.");
      } else {
        toast.info("Storyhold needs your reason before changing canon.");
      }
      await load(false);
    } catch (reason) {
      toast.error(
        reason instanceof Error
          ? reason.message
          : "The discrepancy could not be reviewed.",
      );
    } finally {
      setSubmittingDiscrepancy(false);
    }
  };

  const explainDiscrepancy = async (report: CanonDiscrepancyReport) => {
    if (!detail) return;
    const reasoning = discrepancyReasoning[report.id]?.trim() ?? "";
    if (reasoning.length < 20) return;
    setResolvingDiscrepancyId(report.id);
    try {
      const result = await explainCanonDiscrepancy({
        worldId: detail.world.id,
        reportId: report.id,
        reasoning,
      });
      setDiscrepancyReasoning((current) => {
        const next = { ...current };
        delete next[report.id];
        return next;
      });
      if (result.canonChanged) {
        toast.success("The continuity logic was valid and canon was amended.");
      } else if (result.report.status === "correction_offered") {
        toast.success("Storyhold found a correction for you to review.");
      } else if (result.report.status === "rejected") {
        toast.info("No supported reason to change canon was found.");
      } else {
        toast.info("Storyhold still needs a more specific reason.");
      }
      await load(false);
    } catch (reason) {
      toast.error(
        reason instanceof Error
          ? reason.message
          : "The explanation could not be reviewed.",
      );
    } finally {
      setResolvingDiscrepancyId(null);
    }
  };

  const applyDiscrepancy = async (report: CanonDiscrepancyReport) => {
    if (!detail) return;
    setResolvingDiscrepancyId(report.id);
    try {
      await applyCanonDiscrepancy({
        worldId: detail.world.id,
        reportId: report.id,
      });
      toast.success("Canon was amended. The original source remains intact.");
      await load(false);
    } catch (reason) {
      toast.error(
        reason instanceof Error
          ? reason.message
          : "The correction could not be applied.",
      );
    } finally {
      setResolvingDiscrepancyId(null);
    }
  };

  const reviewDraft = async (
    draft: CharacterDraft,
    decision: "approve" | "reject",
  ) => {
    if (!detail) return;
    if (decision === "approve") {
      const confirmed = window.confirm(
        `Approve ${draft.name} as a canonical character? The extracted origin becomes locked; later changes must happen through events or explicit amendments.`,
      );
      if (!confirmed) return;
    }
    setReviewingId(draft.id);
    try {
      await reviewCharacterDraft({
        worldId: detail.world.id,
        draftId: draft.id,
        decision,
      });
      toast.success(
        decision === "approve"
          ? `${draft.name} is now canonical.`
          : `${draft.name} was rejected.`,
      );
      await load(false);
    } catch (reason) {
      toast.error(
        reason instanceof Error
          ? reason.message
          : "The review could not be saved.",
      );
    } finally {
      setReviewingId(null);
    }
  };

  if (loading && !detail) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Opening World Studio…
      </div>
    );
  }
  if (error && !detail) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <Card className="border-destructive/40 p-6">
          <p className="font-medium text-destructive">{error}</p>
          <Button asChild variant="outline" className="mt-4">
            <Link href="/admin/worlds">Back to worlds</Link>
          </Button>
        </Card>
      </div>
    );
  }
  if (!detail) return null;

  const run = detail.latestRun;
  const breakdown = detail.breakdown;
  const pendingCohesionProposals = detail.cohesionProposals.filter(
    (proposal) => proposal.reviewStatus === "pending",
  );

  return (
    <div
      className="mx-auto max-w-7xl space-y-6 p-4 md:p-8"
      data-testid="world-studio-detail"
    >
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-3 mb-3">
          <Link href="/admin/worlds">
            <ArrowLeft className="mr-2 h-4 w-4" />
            All worlds
          </Link>
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              <span>World Studio</span>
              <span className="text-muted-foreground/50">/</span>
              <span>{detail.edition.name}</span>
            </div>
            <h1 className="font-serif text-3xl font-bold md:text-4xl">
              {detail.world.name}
            </h1>
            <p className="mt-2 max-w-3xl text-muted-foreground">
              {detail.world.premise ||
                "Add books, manuscripts, rules, and notes. Storyhold will build a reviewable world model from the source evidence."}
            </p>
          </div>
          <Button variant="outline" onClick={() => void load(false)}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>
        <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
          <Fingerprint className="h-3.5 w-3.5" />
          <span className="font-mono">world:{detail.world.id}</span>
          <span>·</span>
          <span className="font-mono">edition:{detail.edition.id}</span>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          {
            label: "Source documents",
            value: detail.sources.length,
            icon: FileArchive,
          },
          {
            label: "Indexed words",
            value: formatNumber(totalWords),
            icon: ScrollText,
          },
          {
            label: "Retrievable passages",
            value: formatNumber(totalChunks),
            icon: Database,
          },
          {
            label: "Canonical characters",
            value: detail.canonicalCharacters.length,
            icon: Users,
          },
        ].map(({ label, value, icon: Icon }) => (
          <Card key={label} className="p-5">
            <Icon className="mb-4 h-5 w-5 text-primary" />
            <div className="text-3xl font-bold tabular-nums">{value}</div>
            <div className="mt-1 text-sm text-muted-foreground">{label}</div>
          </Card>
        ))}
      </div>

      <section className="space-y-4" data-testid="discrepancy-injector">
        <Card className="border-primary/25 bg-primary/[0.025] p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <div className="rounded-lg bg-primary/10 p-2.5 text-primary">
                <SearchCheck className="h-5 w-5" />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-serif text-xl font-bold">
                    Notice something inconsistent?
                  </h2>
                  <Badge variant="secondary">Player-facing</Badge>
                </div>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                  Describe what seems wrong. Storyhold will check this world’s
                  sources, amendments, and locked history before deciding
                  whether canon should change.
                </p>
              </div>
            </div>
          </div>
          <Label htmlFor="canon-discrepancy" className="mt-5 block">
            What doesn’t add up?
          </Label>
          <Textarea
            id="canon-discrepancy"
            className="mt-2"
            value={discrepancyClaim}
            onChange={(event) => setDiscrepancyClaim(event.target.value)}
            placeholder="Martha’s recorded birth year is 2015, but the story begins in 2012."
            rows={3}
            maxLength={3000}
            disabled={submittingDiscrepancy}
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-2xl text-xs leading-5 text-muted-foreground">
              Continuity can be corrected. This cannot grant new abilities,
              possessions, knowledge, or bypass a locked character start.
            </p>
            <Button
              onClick={() => void submitDiscrepancy()}
              disabled={
                submittingDiscrepancy || discrepancyClaim.trim().length < 8
              }
            >
              {submittingDiscrepancy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <SearchCheck className="mr-2 h-4 w-4" />
              )}
              Check discrepancy
            </Button>
          </div>
        </Card>

        {detail.discrepancyReports.length > 0 ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-serif text-lg font-bold">Recent checks</h2>
              {detail.canonAmendments.length > 0 ? (
                <Badge variant="outline">
                  {detail.canonAmendments.length} active amendment
                  {detail.canonAmendments.length === 1 ? "" : "s"}
                </Badge>
              ) : null}
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {detail.discrepancyReports.slice(0, 8).map((report) => (
                <DiscrepancyReportCard
                  key={report.id}
                  report={report}
                  reasoning={discrepancyReasoning[report.id] ?? ""}
                  busy={resolvingDiscrepancyId === report.id}
                  onReasoning={(value) =>
                    setDiscrepancyReasoning((current) => ({
                      ...current,
                      [report.id]: value,
                    }))
                  }
                  onExplain={() => void explainDiscrepancy(report)}
                  onApply={() => void applyDiscrepancy(report)}
                />
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <div className="flex items-center gap-3 pt-2">
        <div className="h-px flex-1 bg-border" />
        <Badge variant="outline">Creator workshop</Badge>
        <div className="h-px flex-1 bg-border" />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(340px,.85fr)]">
        <Card className="p-6">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-primary/10 p-2.5 text-primary">
              <BrainCircuit className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-serif text-xl font-bold">
                  Automatic world review
                </h2>
                <Badge variant={detail.ai.configured ? "default" : "secondary"}>
                  {detail.ai.configured
                    ? "AI connected"
                    : "Development extraction"}
                </Badge>
              </div>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {detail.ai.explanation}
              </p>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                Every upload is indexed locally first. New or changed source
                passages receive one AI pass automatically when a provider is
                available; otherwise they remain in a durable backlog and are
                picked up after AI is connected.
              </p>
            </div>
          </div>

          {run?.status === "queued" || run?.status === "running" ? (
            <div className="mt-5 rounded-lg border bg-muted/30 p-4">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="flex items-center gap-2 font-medium">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  {run.stage}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {run.progress}%
                </span>
              </div>
              <Progress className="mt-3" value={run.progress} />
              <p className="mt-2 text-xs text-muted-foreground">
                {formatNumber(run.chunkCount)} passages · {run.model} ·{" "}
                {run.incremental ? "new material only" : "full world pass"}
              </p>
            </div>
          ) : run?.status === "failed" ? (
            <div className="mt-5 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
              <div className="flex items-center gap-2 font-medium text-destructive">
                <AlertTriangle className="h-4 w-4" />
                Analysis failed
              </div>
              <p className="mt-1 text-muted-foreground">{run.error}</p>
            </div>
          ) : breakdown ? (
            <div className="mt-5 flex items-center gap-3 rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-4">
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
              <div>
                <div className="font-medium">
                  Draft world model v{breakdown.version} is ready
                </div>
                <div className="text-xs text-muted-foreground">
                  {breakdown.provider} · {breakdown.model} · awaiting review
                </div>
              </div>
            </div>
          ) : null}

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button
              onClick={() => void startAnalysis()}
              disabled={
                startingAnalysis ||
                analysisActive ||
                analyzableChunks === 0 ||
                uploading
              }
            >
              {startingAnalysis ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="mr-2 h-4 w-4" />
              )}
              {detail.ai.configured
                ? "Run full cohesion check"
                : "Refresh local inventory"}
            </Button>
            <span className="text-xs text-muted-foreground">
              {detail.ai.billable
                ? `${aiReviewed} reviewed · ${waitingForAi} waiting · new-source AI passes run automatically.`
                : `${waitingForAi} waiting for future AI review · local passes have no model charges.`}
            </span>
          </div>
        </Card>

        <Card className="p-6">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-primary/10 p-2.5 text-primary">
              <Upload className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-serif text-xl font-bold">
                Add source material
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Upload whole books together or one source at a time.
              </p>
            </div>
          </div>
          <label
            htmlFor="world-source-files"
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
            className="mt-5 flex cursor-pointer flex-col items-center rounded-lg border-2 border-dashed p-6 text-center transition-colors hover:border-primary/50 hover:bg-primary/[0.02]"
          >
            <Upload className="h-7 w-7 text-muted-foreground" />
            <span className="mt-2 text-sm font-medium">
              Choose files or drop them here
            </span>
            <span className="mt-1 text-xs text-muted-foreground">
              PDF, EPUB, DOCX, TXT, Markdown, presentations and spreadsheets ·
              100 MB each
            </span>
          </label>
          <input
            id="world-source-files"
            className="sr-only"
            type="file"
            multiple
            accept={supportedExtensions}
            onChange={(event) => addFiles(Array.from(event.target.files ?? []))}
          />

          {files.length > 0 ? (
            <div className="mt-4 space-y-2">
              {files.map((file, index) => (
                <div
                  key={`${file.name}:${file.lastModified}`}
                  className="flex items-center justify-between gap-3 rounded-md bg-muted/60 px-3 py-2 text-sm"
                >
                  <span className="min-w-0 truncate">{file.name}</span>
                  <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                    <span>{formatBytes(file.size)}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      disabled={uploading}
                      onClick={() =>
                        setFiles((current) =>
                          current.filter(
                            (_, currentIndex) => currentIndex !== index,
                          ),
                        )
                      }
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Material ownership</Label>
              <Select
                value={sourceClass}
                onValueChange={setSourceClass}
                disabled={uploading}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="original_author">Original work</SelectItem>
                  <SelectItem value="user_created">User-created</SelectItem>
                  <SelectItem value="licensed">Licensed</SelectItem>
                  <SelectItem value="public_domain">Public domain</SelectItem>
                  <SelectItem value="reference">Research reference</SelectItem>
                  <SelectItem value="fan_created">
                    Unofficial / fan-created
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Canon treatment</Label>
              <Select
                value={canonStatus}
                onValueChange={setCanonStatus}
                disabled={uploading}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="candidate">Candidate evidence</SelectItem>
                  <SelectItem value="canon">Declared canon</SelectItem>
                  <SelectItem value="reference">Reference only</SelectItem>
                  <SelectItem value="excluded">Store but exclude</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button
            className="mt-4 w-full"
            variant="secondary"
            onClick={() => void uploadFiles()}
            disabled={uploading || files.length === 0}
          >
            {uploading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <FileArchive className="mr-2 h-4 w-4" />
            )}
            {uploading
              ? `Indexing ${uploadPosition} of ${files.length}`
              : `Upload ${files.length || ""} source${files.length === 1 ? "" : "s"}`}
          </Button>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
          <div>
            <h2 className="font-serif text-xl font-bold">Source shelf</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Raw files are preserved; extracted passages are scoped to this
              world and edition before retrieval. Reference-only and excluded
              sources remain stored but do not feed the draft canon breakdown.
            </p>
          </div>
          <Badge variant="outline">
            {sourceClassLabel(sourceClass)} upload default
          </Badge>
        </div>
        {detail.sources.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No source material yet.
          </div>
        ) : (
          detail.sources.map((source) => (
            <SourceRow key={source.id} source={source} />
          ))
        )}
      </Card>

      {pendingCohesionProposals.length > 0 ? (
        <section className="space-y-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">
                Creator-only audit
              </div>
              <h2 className="mt-1 font-serif text-2xl font-bold">
                Internal cohesion inbox
              </h2>
              <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                Storyhold found possible contradictions, duplicates, or
                continuity questions for a creator to inspect. Players never
                need to manage this queue, and no AI pass can silently rewrite
                the canon ledger.
              </p>
            </div>
            <Badge variant="secondary">
              {pendingCohesionProposals.length} awaiting review
            </Badge>
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            {pendingCohesionProposals.map((proposal) => (
              <CohesionProposalCard
                key={proposal.id}
                proposal={proposal}
                classification={
                  proposalClassifications[proposal.id] ?? "needs_research"
                }
                reviewing={reviewingProposalId === proposal.id}
                onClassification={(value) =>
                  setProposalClassifications((current) => ({
                    ...current,
                    [proposal.id]: value,
                  }))
                }
                onReview={(decision) =>
                  void reviewProposal(proposal, decision)
                }
              />
            ))}
          </div>
        </section>
      ) : null}

      {breakdown ? (
        <section className="space-y-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                Reviewable, not canon
              </div>
              <h2 className="mt-1 font-serif text-2xl font-bold">
                World breakdown
              </h2>
            </div>
            <Badge variant="secondary">Draft v{breakdown.version}</Badge>
          </div>
          <Card className="p-6">
            <div className="flex items-start gap-3">
              <BookOpen className="mt-0.5 h-6 w-6 shrink-0 text-primary" />
              <div>
                <h3 className="font-serif text-xl font-bold">
                  Working overview
                </h3>
                <p className="mt-2 leading-7 text-muted-foreground">
                  {breakdown.summary || "No overview was extracted."}
                </p>
              </div>
            </div>
            {[...breakdown.genres, ...breakdown.themes].length > 0 ? (
              <div className="mt-5 flex flex-wrap gap-2">
                {[...breakdown.genres, ...breakdown.themes].map((item) => (
                  <Badge key={item} variant="outline">
                    {item}
                  </Badge>
                ))}
              </div>
            ) : null}
            {breakdown.recurringTerms.length > 0 ? (
              <div className="mt-5 border-t pt-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Recurring source terms
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {breakdown.recurringTerms.join(" · ")}
                </p>
              </div>
            ) : null}
          </Card>
          <div className="grid gap-5 lg:grid-cols-2">
            <FindingSection
              title="World rules"
              icon={ShieldCheck}
              items={breakdown.worldRules}
            />
            <FindingSection
              title="Locations"
              icon={Map}
              items={breakdown.locations}
            />
            <FindingSection
              title="Factions"
              icon={Users}
              items={breakdown.factions}
            />
            <FindingSection
              title="Chronology"
              icon={Clock3}
              items={breakdown.chronology}
            />
          </div>
          {breakdown.openQuestions.length > 0 ? (
            <Card className="p-5">
              <h3 className="font-serif text-lg font-bold">Open questions</h3>
              <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
                {breakdown.openQuestions.map((question) => (
                  <li key={question} className="flex gap-2">
                    <span className="text-primary">•</span>
                    <span>{question}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </section>
      ) : null}

      {detail.characterDrafts.length > 0 ||
      detail.canonicalCharacters.length > 0 ? (
        <section className="space-y-5">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              Evidence first
            </div>
            <h2 className="mt-1 font-serif text-2xl font-bold">
              Character sheets
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              These are candidates until you review them. A development scan
              identifies recurring names; a connected model fills grounded
              motivations, relationships, knowledge, and secrets.
            </p>
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            {detail.characterDrafts.map((draft) => (
              <CharacterCard
                key={draft.id}
                draft={draft}
                reviewing={reviewingId === draft.id}
                onReview={(decision) => void reviewDraft(draft, decision)}
              />
            ))}
          </div>
          {detail.canonicalCharacters.length > 0 ? (
            <Card className="p-5">
              <div className="flex items-center gap-2">
                <LockKeyhole className="h-5 w-5 text-emerald-600" />
                <h3 className="font-serif text-lg font-bold">
                  Approved canonical characters
                </h3>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {detail.canonicalCharacters.map((character) => (
                  <Badge key={character.id} variant="secondary">
                    <Check className="mr-1 h-3 w-3" />
                    {character.name}
                  </Badge>
                ))}
              </div>
            </Card>
          ) : null}
        </section>
      ) : null}

      <Card className="border-primary/20 bg-primary/[0.025] p-5">
        <div className="flex items-start gap-3">
          <BrainCircuit className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div>
            <h3 className="font-semibold">Storyhold AI connections</h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Storyhold routes play, world analysis, and canon review through
              its own provider gateway. Each result is checked before it can
              become persistent state. Development extraction stays local;
              connected analysis uses bounded, evidence-labelled batches.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}

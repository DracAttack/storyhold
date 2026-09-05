import { useParams, useLocation, Link } from "wouter";
import {
  useGetArticle,
  useUpdateArticle,
  usePublishArticle,
  useUnpublishArticle,
  usePostArticleToFacebook,
  useScheduleArticle,
  useDeleteArticle,
  useRegenerateArticleImage,
  useUploadArticleHeroImage,
  useRestoreArticleHeroImage,
  useRegenerateArticleSection,
  useReassignArticleAuthor,
  useListAuthors,
  useListCategories,
  useBackfillArticleInternalLinks,
  useUndoArticleInternalLinks,
  useBackfillArticleSourceLinks,
  useUndoArticleSourceLinks,
  useRefreshArticleCitations,
  useListPublicArticles,
  useGetRelatedArticles,
  getGetRelatedArticlesQueryKey,
  useRegenerateArticleHooks,
  useVerifyArticle,
  useRedraftArticle,
  useRefreshArticleEvidence,
  useClearArticleQuarantine,
  useGetEvidencePacket,
  useListMemes,
  useCreateMemeForArticle,
  useRepostMeme,
  getListMemesQueryKey,
  getGetArticleQueryKey,
  getListArticlesQueryKey,
  useGetArticleAiCost,
  getGetArticleAiCostQueryKey,
  HookMode,
  UpdateArticleInputEditorialLabelOverride,
  type ArticleBlock,
  type Article,
  type PublicArticleSummary,
  type HookVariant,
  type HookAssignments,
  type SocialPack,
  type VerificationReport,
  type VerificationFinding,
  type AdvisoryFinding,
} from "@workspace/api-client-react";
import { handleImageError, resolveImage, withImageParams } from "@/lib/heroImage";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SecondaryBeatsEditor } from "@/components/admin/SecondaryBeatsEditor";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Loader2, Trash2, Plus, ArrowUp, ArrowDown, ImageIcon, RefreshCw, Link2, Undo2, X, BookMarked, ExternalLink, Facebook, Laugh, Upload } from "lucide-react";
import { toast } from "sonner";
import { useEffect, useRef, useState } from "react";
import { format } from "date-fns";

// Headline hook surfaces + human labels (the four places a hook angle maps to).
const HOOK_SURFACES: { key: keyof HookAssignments; label: string; hint: string }[] = [
  { key: "h1", label: "Headline (H1)", hint: "the headline shown on the article page" },
  { key: "seoTitle", label: "SEO title", hint: "browser tab + Google result title" },
  { key: "social", label: "Social card", hint: "og:title / Twitter card title" },
  { key: "newsletter", label: "Newsletter", hint: "title used in email roundups" },
];
const HOOK_MODE_LABELS: Record<HookMode, string> = {
  [HookMode.curiosity]: "Curiosity",
  [HookMode.contrarian]: "Contrarian",
  [HookMode.emotional]: "Emotional",
  [HookMode.news_peg]: "News peg",
  [HookMode.plain_seo]: "Plain / SEO",
};
// Social pack fields rendered as editable rows (key → label + multiline?).
const SOCIAL_FIELDS: { key: keyof SocialPack; label: string; rows: number }[] = [
  { key: "twitter", label: "X / Twitter (≤280)", rows: 2 },
  { key: "threads", label: "Threads", rows: 3 },
  { key: "pinterestTitle", label: "Pinterest title", rows: 1 },
  { key: "pinterestDescription", label: "Pinterest description", rows: 3 },
  { key: "reddit", label: "Reddit title", rows: 2 },
  { key: "newsletterBlurb", label: "Newsletter blurb", rows: 3 },
  { key: "quoteCard", label: "Quote card", rows: 2 },
];

const BLOCK_TYPES: ArticleBlock["type"][] = ["paragraph", "heading", "pullquote", "image", "relatedArticle", "takeaways"];
const BLOCK_LABELS: Partial<Record<ArticleBlock["type"], string>> & Record<"paragraph" | "heading" | "pullquote" | "image" | "relatedArticle" | "takeaways", string> = {
  paragraph: "paragraph",
  heading: "heading",
  pullquote: "pullquote",
  image: "image",
  relatedArticle: "suggested article",
  takeaways: "what you can do",
};

// Links live in paragraph text as plain markdown. Two kinds are supported here:
//   - internal rabbit-hole links — `[phrase](/article/slug)`
//   - external source links      — `[phrase](https://example.com/…)`
// This mirrors the public renderer's INLINE_LINK_RE so the editor sees exactly
// what the live article will render. (The separate link-COVERAGE tooling in
// InternalLinks.tsx still counts /article/ links only — that is intentional.)
const LINK_RE = /\[([^\]]+)\]\((\/article\/[^\s)]+|https?:\/\/[^\s)]+)\)/g;

interface ParsedLink {
  full: string;
  phrase: string;
  href: string;
  external: boolean;
  slug: string; // article slug for internal links; "" for external
  label: string; // compact target shown on the chip
  // Character span of the full markdown within the paragraph content, so removal
  // and overlap checks are position-precise (not first-match heuristics).
  start: number;
  end: number;
}

function linkLabel(href: string, external: boolean): string {
  if (!external) return href.replace("/article/", "/");
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return href;
  }
}

function extractLinks(content: string): ParsedLink[] {
  const out: ParsedLink[] = [];
  LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(content))) {
    const href = m[2]!;
    const external = !href.startsWith("/article/");
    out.push({
      full: m[0],
      phrase: m[1]!,
      href,
      external,
      slug: external ? "" : href.replace("/article/", ""),
      label: linkLabel(href, external),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

// Turn whatever was typed/pasted into the link field into a usable external
// href, or null if it is not a plausible URL. Accepts full http/https URLs and
// bare domains like "example.com/path" (https:// is assumed).
function normalizeExternalUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw || raw.startsWith("/")) return null;
  let candidate = raw;
  if (!/^https?:\/\//i.test(candidate)) {
    // Only treat as a bare domain if it has a dot and no whitespace.
    if (/\s/.test(candidate) || !/^[^\s/]+\.[^\s/]+/.test(candidate)) return null;
    candidate = `https://${candidate}`;
  }
  try {
    const u = new URL(candidate);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname.includes(".")) return null;
    // Percent-encode parentheses so the stored `[text](href)` markdown survives
    // the `[^\s)]+` link regex (editor + public renderer). Browsers decode these
    // back, so links like en.wikipedia.org/wiki/Foo_(bar) still resolve.
    return u.toString().replace(/\(/g, "%28").replace(/\)/g, "%29");
  } catch {
    return null;
  }
}

function RelatedArticlePicker({
  slug,
  excludeSlug,
  onChange,
}: {
  slug: string;
  excludeSlug: string;
  onChange: (slug: string) => void;
}) {
  const { data } = useListPublicArticles();
  const items: PublicArticleSummary[] = (data?.items ?? []).filter((a) => a.slug !== excludeSlug);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const selected = items.find((a) => a.slug === slug);
  const q = query.trim().toLowerCase();
  const matches = q
    ? items.filter((a) => a.title.toLowerCase().includes(q) || a.category.toLowerCase().includes(q))
    : items;
  return (
    <div className="space-y-2">
      <div className="relative">
        <Input
          placeholder={selected ? "Search to change article…" : "Search articles by title…"}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
        {open && matches.length > 0 && (
          <div className="absolute z-10 mt-1 w-full max-h-64 overflow-y-auto rounded-md border bg-background shadow-md">
            {matches.map((a) => (
              <button
                key={a.id}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onChange(a.slug); setQuery(""); setOpen(false); }}
                className="block w-full text-left px-3 py-2 hover:bg-muted text-sm border-b last:border-b-0"
              >
                <div className="font-medium truncate">{a.title}</div>
                <div className="text-xs text-muted-foreground">{a.category}</div>
              </button>
            ))}
          </div>
        )}
      </div>
      {selected ? (
        <div className="flex items-center gap-3 border rounded-md p-2 bg-muted/40">
          <img src={withImageParams(resolveImage(selected.heroImage), 200)} onError={handleImageError} alt="" className="h-12 w-12 object-cover rounded" />
          <div className="min-w-0 flex-1">
            <div className="text-xs uppercase tracking-wide text-primary font-bold">{selected.category}</div>
            <div className="font-serif font-bold truncate">{selected.title}</div>
          </div>
        </div>
      ) : slug ? (
        <div className="text-xs text-rose-700 italic">Article not found ({slug}). Pick another or remove this block.</div>
      ) : (
        <div className="text-xs text-muted-foreground italic">Pick an article from the search above.</div>
      )}
    </div>
  );
}

// Searchable link picker used when wrapping a text selection. Returns the chosen
// target's full href to the caller — either an internal `/article/slug` (picked
// from the article list) or an external `https://…` URL (typed/pasted directly).
function LinkTargetPicker({
  selectedText,
  excludeSlug,
  onPick,
  onCancel,
}: {
  selectedText: string;
  excludeSlug: string;
  onPick: (href: string) => void;
  onCancel: () => void;
}) {
  const { data } = useListPublicArticles();
  const items: PublicArticleSummary[] = (data?.items ?? []).filter((a) => a.slug !== excludeSlug);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const externalUrl = normalizeExternalUrl(query);
  const matches = (q
    ? items.filter((a) => a.title.toLowerCase().includes(q) || a.category.toLowerCase().includes(q))
    : items
  ).slice(0, 8);
  return (
    <div className="rounded-md border bg-muted/30 p-2 space-y-2">
      <div className="text-xs text-muted-foreground">
        Linking <span className="font-medium text-foreground">"{selectedText}"</span> to:
      </div>
      <Input
        autoFocus
        placeholder="Search articles, or paste any URL…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && externalUrl) {
            e.preventDefault();
            onPick(externalUrl);
          }
        }}
      />
      <div className="max-h-56 overflow-y-auto rounded border bg-background divide-y">
        {externalUrl && (
          <button
            type="button"
            onClick={() => onPick(externalUrl)}
            className="block w-full text-left px-3 py-2 hover:bg-muted text-sm"
          >
            <div className="font-medium flex items-center gap-1.5">
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              Link to this URL
            </div>
            <div className="text-xs text-muted-foreground truncate">{externalUrl}</div>
          </button>
        )}
        {matches.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => onPick(`/article/${a.slug}`)}
            className="block w-full text-left px-3 py-2 hover:bg-muted text-sm"
          >
            <div className="font-medium truncate">{a.title}</div>
            <div className="text-xs text-muted-foreground truncate">{a.category} · /{a.slug}</div>
          </button>
        ))}
        {matches.length === 0 && !externalUrl && (
          <div className="px-3 py-2 text-sm text-muted-foreground">
            No matching articles. Paste a full URL (https://…) to link out instead.
          </div>
        )}
      </div>
      <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
    </div>
  );
}

// Blue meme card shown in the article editor when this article has one or more
// memes. Surfaces published memes (status + posted date + Facebook link) and a
// "Create another meme" action — recirculation is always allowed, even after a
// meme has already been posted.
function ArticleMemesCard({ articleId }: { articleId: string }) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const memesQuery = useListMemes(
    { articleId },
    { query: { queryKey: getListMemesQueryKey({ articleId }) } },
  );
  const createMeme = useCreateMemeForArticle();
  const repost = useRepostMeme();
  const [repostingId, setRepostingId] = useState<string | null>(null);
  const memes = memesQuery.data?.items ?? [];

  const handleCreateAnother = async () => {
    if (createMeme.isPending) return;
    try {
      const meme = await createMeme.mutateAsync({ id: articleId });
      navigate(`/admin/memes/${meme.id}`);
    } catch {
      toast.error("Could not start a new meme for this article.");
    }
  };

  const handleRepost = async (memeId: string) => {
    if (repostingId) return;
    if (
      !window.confirm(
        "Repost this meme to Facebook now? A fresh copy is posted; the original meme is kept as-is.",
      )
    )
      return;
    setRepostingId(memeId);
    try {
      const res = await repost.mutateAsync({ id: memeId });
      if (res.status === "posted") {
        toast.success("Reposted to Facebook.");
      } else if (res.status === "disabled") {
        toast.error("Facebook posting is not configured.");
      } else {
        toast.error(res.error ?? res.reason ?? `Repost ${res.status}.`);
      }
      await qc.invalidateQueries({ queryKey: getListMemesQueryKey({ articleId }) });
    } catch {
      toast.error("Could not repost this meme.");
    } finally {
      setRepostingId(null);
    }
  };

  if (memesQuery.isLoading || memes.length === 0) return null;

  const statusStyle: Record<string, string> = {
    posted: "bg-emerald-100 text-emerald-700",
    posting: "bg-blue-100 text-blue-700",
    queued: "bg-blue-100 text-blue-700",
    scheduled: "bg-blue-100 text-blue-700",
    approved: "bg-indigo-100 text-indigo-700",
    generated: "bg-amber-100 text-amber-700",
    draft: "bg-muted text-muted-foreground",
    failed: "bg-red-100 text-red-700",
  };
  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const hasPublished = memes.some((m) => m.status === "posted");

  return (
    <Card className="p-6 border-blue-300 bg-blue-50/60">
      <div className="flex items-center justify-between gap-3 mb-1 flex-wrap">
        <h2 className="font-serif text-xl font-bold flex items-center gap-2">
          <Laugh className="h-5 w-5 text-blue-600" /> Memes
        </h2>
        <Button onClick={handleCreateAnother} disabled={createMeme.isPending} variant="outline" size="sm">
          {createMeme.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Create another meme
        </Button>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        {hasPublished
          ? "This article already has a published meme — that doesn't block making another. Recirculate it any time."
          : "This article has meme drafts in progress. You can also start a fresh one any time."}
      </p>
      <ul className="space-y-3">
        {memes.map((m) => (
          <li key={m.id} className="flex items-center gap-3 rounded-md border bg-background p-3">
            <Link href={`/admin/memes/${m.id}`} className="shrink-0">
              <div className="h-16 w-16 overflow-hidden rounded bg-muted flex items-center justify-center">
                {m.composedImageUrl ? (
                  <img src={m.composedImageUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <Laugh className="h-6 w-6 text-muted-foreground" />
                )}
              </div>
            </Link>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={`inline-block rounded px-2 py-0.5 text-xs font-medium capitalize ${statusStyle[m.status] ?? "bg-muted text-muted-foreground"}`}
                >
                  {m.status === "posted" ? "Published" : m.status}
                </span>
                {m.status === "posted" && m.postedAt && (
                  <span className="text-xs text-muted-foreground">{fmt(m.postedAt)}</span>
                )}
                {m.status !== "posted" && m.scheduledAt && (
                  <span className="text-xs text-muted-foreground">Scheduled {fmt(m.scheduledAt)}</span>
                )}
              </div>
              <p className="mt-1 truncate text-sm">{m.jokeDescription || m.socialHook || "Untitled meme"}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {m.composedImageUrl && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleRepost(m.id)}
                  disabled={repostingId !== null}
                  title={
                    m.status === "posted"
                      ? "Post this meme to Facebook again"
                      : "Post this meme to Facebook now"
                  }
                >
                  {repostingId === m.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Repost
                </Button>
              )}
              {m.facebookPostUrl && (
                <a
                  href={m.facebookPostUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 hover:text-blue-700"
                  title="View Facebook post"
                >
                  <Facebook className="h-4 w-4" />
                </a>
              )}
              <Link
                href={`/admin/memes/${m.id}`}
                className="text-muted-foreground hover:text-foreground"
                title="Open meme editor"
              >
                <ExternalLink className="h-4 w-4" />
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// Human labels + tones for per-source packet roles. CORE roles (core_evidence,
// primary_record) are the only ones that counted toward locking the packet.
const PACKET_ROLE_BADGES: Record<string, { label: string; className: string }> = {
  core_evidence: { label: "core evidence", className: "bg-emerald-100 text-emerald-900" },
  primary_record: { label: "primary record", className: "bg-emerald-100 text-emerald-900" },
  prosecution_framing: { label: "prosecution framing", className: "bg-slate-100 text-slate-700" },
  defense_or_advocacy_framing: { label: "defense/advocacy framing", className: "bg-slate-100 text-slate-700" },
  reported_context: { label: "reported context", className: "bg-slate-100 text-slate-700" },
  background_only: { label: "background only", className: "bg-amber-100 text-amber-900" },
};

// Compact read-only view of the locked evidence packet a draft was grounded on.
function EvidencePacketView({ packetId }: { packetId: string }) {
  const { data: packet, isLoading, isError } = useGetEvidencePacket(packetId);
  if (isLoading) return <p className="text-xs text-muted-foreground">Loading evidence packet…</p>;
  if (isError || !packet) return <p className="text-xs text-muted-foreground">Evidence packet unavailable.</p>;
  const requiredEntities = packet.retrievalContext?.requiredEntities ?? [];
  return (
    <div className="rounded-md border bg-background p-3 text-sm space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium">{packet.label}</span>
        <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">{packet.decision}</span>
        <span className="text-xs text-muted-foreground">v{packet.version} · {packet.beat}</span>
        <span className="text-xs text-muted-foreground">{packet.sourceCount} source{packet.sourceCount === 1 ? "" : "s"} · top tier {packet.topAuthorityTier}</span>
      </div>
      {requiredEntities.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Required entities: {requiredEntities.join(", ")}
        </p>
      )}
      {packet.claims.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-1">Supported claims ({packet.claims.length})</p>
          <ul className="list-disc pl-5 space-y-0.5">
            {packet.claims.slice(0, 8).map((c, i) => (
              <li key={i} className="text-xs text-muted-foreground">{c.text}</li>
            ))}
          </ul>
        </div>
      )}
      {packet.sources.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-1">Sources</p>
          <ul className="space-y-0.5">
            {packet.sources.map((s, i) => {
              const badge = s.role ? PACKET_ROLE_BADGES[s.role] : undefined;
              return (
                <li key={i} className="text-xs">
                  <a href={s.url} target="_blank" rel="noreferrer" className="text-blue-600 hover:text-blue-700 break-all">
                    {s.title ?? s.domain}
                  </a>{" "}
                  <span className="text-muted-foreground">(tier {s.authorityTier})</span>
                  {badge && (
                    <span className={`ml-1 px-1.5 py-0.5 rounded-full font-medium ${badge.className}`}>
                      {badge.label}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// Post-draft evidence verification panel (#201): shows the quarantine banner,
// the verification report (findings the draft asserts beyond its locked packet),
// a re-run button, and the grounding evidence packet. Only rendered for
// packet-grounded articles (article.evidencePacketId set).
function EvidenceVerificationCard({
  article,
  onRerun,
  isVerifying,
  onClearQuarantine,
  isClearingQuarantine,
  onRefreshEvidence,
  isRefreshingEvidence,
}: {
  article: Article;
  onRerun: () => void;
  isVerifying: boolean;
  onClearQuarantine: () => void;
  isClearingQuarantine: boolean;
  onRefreshEvidence: () => void;
  isRefreshingEvidence: boolean;
}) {
  const [showPacket, setShowPacket] = useState(false);
  const report = article.verificationReport;
  const quarantined = !!article.quarantinedAt;
  const status = report?.status;
  // "Flagged" with only unsupported (advisory) findings is a soft note, not a
  // failure — hard failures are contradicted claims / invented sources, which
  // are what actually quarantine an article.
  const hasHardFindings =
    (report?.contradictedClaims?.length ?? 0) > 0 || (report?.inventedSources?.length ?? 0) > 0;
  const softFlagOnly = status === "flagged" && !hasHardFindings;
  const tone =
    quarantined || status === "error" || hasHardFindings
      ? "border-rose-300 bg-rose-50/60"
      : softFlagOnly
        ? "border-amber-300 bg-amber-50/60"
        : status === "passed"
          ? "border-emerald-300 bg-emerald-50/60"
          : "border-slate-300 bg-slate-50/60";
  const renderFindings = (title: string, items: VerificationFinding[] | undefined) =>
    items && items.length > 0 ? (
      <div>
        <p className="text-xs font-semibold text-rose-800 mb-1">{title} ({items.length})</p>
        <ul className="space-y-1">
          {items.map((f, i) => (
            <li key={i} className="text-xs text-rose-900">
              <span className="font-medium">{f.claim}</span> — <span className="text-rose-800">{f.detail}</span>
            </li>
          ))}
        </ul>
      </div>
    ) : null;
  const renderAdvisoryFindings = (items: AdvisoryFinding[] | undefined) =>
    items && items.length > 0 ? (
      <div className="rounded-md border border-amber-300 bg-amber-50/70 px-3 py-2 space-y-1.5">
        <p className="text-xs font-semibold text-amber-800">Advisory ({items.length}) — informational only, does not block publication</p>
        <ul className="space-y-1">
          {items.map((f, i) => (
            <li key={i} className="text-xs text-amber-900">
              <span className="font-medium font-mono">{f.findingType}</span> — {f.detail}
              {f.url && (
                <a
                  href={f.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-1 inline-flex items-center gap-0.5 text-amber-700 underline underline-offset-2"
                >
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </li>
          ))}
        </ul>
      </div>
    ) : null;
  return (
    <Card className={`p-4 space-y-3 text-sm ${tone}`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="font-serif text-lg font-bold flex items-center gap-2">
          <BookMarked className="h-5 w-5" /> Evidence verification
        </h2>
        <div className="flex items-center gap-2 flex-wrap">
          {quarantined && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-rose-200 text-rose-900 font-medium">Quarantined — hidden from site</span>
          )}
          {status && (
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${status === "passed" ? "bg-emerald-200 text-emerald-900" : softFlagOnly ? "bg-amber-200 text-amber-900" : "bg-rose-200 text-rose-900"}`}>
              {status === "passed" ? "Passed" : softFlagOnly ? "Advisory notes" : status === "flagged" ? "Flagged" : "Check error"}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={onRerun} disabled={isVerifying || isRefreshingEvidence}>
            {isVerifying ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            Re-run verification
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onRefreshEvidence}
            disabled={isRefreshingEvidence || isVerifying}
            title="Rebuild the evidence packet from the current Source Vault (picks up sources added after drafting) and re-verify this draft against it. The body is not changed."
          >
            {isRefreshingEvidence ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <BookMarked className="h-4 w-4 mr-2" />}
            Refresh evidence
          </Button>
          {quarantined && (
            <Button variant="destructive" size="sm" onClick={onClearQuarantine} disabled={isClearingQuarantine}>
              {isClearingQuarantine && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Clear quarantine — show on site
            </Button>
          )}
        </div>
      </div>
      {article.holdReason === "no_evidence_sources" && (
        <div className="rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <span className="font-semibold">Held — no sources:</span> this article was held at auto-publish because its evidence packet sources were not found in the article body.{" "}
          <a
            href={article.evidencePacketId ? `/admin/source-vault?packetId=${article.evidencePacketId}&articleId=${article.id}` : "/admin/source-vault"}
            className="underline underline-offset-2 text-amber-700 hover:text-amber-900"
          >
            Open Source Vault
          </a>{" "}
          to review and attach sources, then re-run verification.
        </div>
      )}
      {report ? (
        <>
          <p className="text-xs text-muted-foreground">
            Checked against the locked evidence packet{report.model ? ` · ${report.model}` : ""}
            {report.checkedAt ? ` · ${format(new Date(report.checkedAt), "PP p")}` : ""}. A passing check does not remove the need for human review.
          </p>
          {report.summary && <p className="text-sm">{report.summary}</p>}
          {renderFindings("Advisory — goes beyond the evidence packet (does not block publication)", report.unsupportedClaims)}
          {renderFindings("Contradicted claims", report.contradictedClaims)}
          {renderFindings("Invented sources", report.inventedSources)}
          {renderAdvisoryFindings(report.advisoryFindings)}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">Not verified yet. Re-run to check this draft against its evidence packet.</p>
      )}
      {article.evidencePacketId && (
        <div>
          <Button variant="ghost" size="sm" className="px-0 h-auto text-xs" onClick={() => setShowPacket((v) => !v)}>
            {showPacket ? "Hide" : "Show"} grounding evidence packet
          </Button>
          {showPacket && <div className="mt-2"><EvidencePacketView packetId={article.evidencePacketId} /></div>}
        </div>
      )}
    </Card>
  );
}

export default function ArticleEditor() {
  const { id } = useParams() as { id: string };
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { data: article, isLoading } = useGetArticle(id);
  // Beat options come from the full master list (/categories = whole beats
  // table), NOT useBeats() (/public/beats), which hides beats with no published
  // articles and would drop newly-added beats from the category dropdown.
  const { data: categoriesData } = useListCategories();
  const beats = (categoriesData?.items ?? []).map((c) => ({
    slug: c.categorySlug,
    name: c.category,
  }));
  const { data: publicList } = useListPublicArticles();
  const continuesId = article?.continuesArticleId ?? null;
  const parentLookupId = continuesId ?? "";
  const { data: parentArticle } = useGetArticle<Article>(parentLookupId, {
    query: {
      queryKey: getGetArticleQueryKey(parentLookupId),
      enabled: Boolean(continuesId),
    },
  });
  // Auto-picked related neighbors (what readers currently see). Only meaningful
  // once the article is published; used to preview + seed the manual override.
  const articleSlug = article?.slug ?? "";
  const articlePublished = article?.status === "published";
  const {
    data: autoRelatedData,
    refetch: refetchAutoRelated,
    isFetching: autoRelatedFetching,
  } = useGetRelatedArticles(articleSlug, {
    query: {
      queryKey: getGetRelatedArticlesQueryKey(articleSlug),
      enabled: Boolean(articleSlug) && articlePublished,
    },
  });

  const [title, setTitle] = useState("");
  const [dek, setDek] = useState("");
  const [seoTitle, setSeoTitle] = useState("");
  const [seoDescription, setSeoDescription] = useState("");
  const [slug, setSlug] = useState("");
  const [heroImage, setHeroImage] = useState("");
  const [body, setBody] = useState<ArticleBlock[]>([]);
  const [categorySlug, setCategorySlug] = useState("");
  // Cross-sectional secondary subjects (Task #258): admin-only internal metadata.
  const [secondaryBeats, setSecondaryBeats] = useState<string[]>([]);
  const [forceAutoRelated, setForceAutoRelated] = useState(false);
  // Editor-curated related-article override. null = automatic topical ranking;
  // a (possibly empty) array = manual mode where the editor picks the related set.
  const [relatedSlugs, setRelatedSlugs] = useState<string[] | null>(null);
  const [relatedQuery, setRelatedQuery] = useState("");
  const [authorId, setAuthorId] = useState("");
  const [scheduleAt, setScheduleAt] = useState("");
  // Headline hook kit + ready-to-post social copy. Null when never generated.
  const [hookVariants, setHookVariants] = useState<HookVariant[] | null>(null);
  const [hookAssignments, setHookAssignments] = useState<HookAssignments | null>(null);
  const [socialPack, setSocialPack] = useState<SocialPack | null>(null);
  // Manual editorial label override. null = auto-detect; one of the 5 label
  // values = use this label in the trust box regardless of source count.
  const [editorialLabelOverride, setEditorialLabelOverride] = useState<UpdateArticleInputEditorialLabelOverride | null>(null);
  // Tracks the current text selection inside a paragraph textarea so a chosen
  // target can wrap exactly that span as an internal link.
  const [linkSel, setLinkSel] = useState<{ index: number; start: number; end: number } | null>(null);
  const [linkPickerFor, setLinkPickerFor] = useState<number | null>(null);

  useEffect(() => {
    if (article) {
      setTitle(article.title);
      setDek(article.dek);
      setSeoTitle(article.seoTitle ?? "");
      setSeoDescription(article.seoDescription ?? "");
      setSlug(article.slug);
      setHeroImage(article.heroImage);
      setBody(article.body);
      setCategorySlug(article.categorySlug);
      setSecondaryBeats(article.secondaryBeats ?? []);
      setForceAutoRelated(article.forceAutoRelated ?? false);
      setRelatedSlugs(article.relatedSlugs ?? null);
      setAuthorId(article.authorId);
      setHookVariants(article.hookVariants ?? null);
      setHookAssignments(article.hookAssignments ?? null);
      setSocialPack(article.socialPack ?? null);
      setEditorialLabelOverride(article.editorialLabelOverride ?? null);
    }
  }, [article]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getGetArticleQueryKey(id) });
    qc.invalidateQueries({ queryKey: getListArticlesQueryKey() });
  };

  const update = useUpdateArticle({ mutation: { onSuccess: () => { toast.success("Saved"); invalidate(); }, onError: () => toast.error("Save failed") } });
  const publish = usePublishArticle({ mutation: { onSuccess: () => { toast.success("Published"); invalidate(); }, onError: () => toast.error("Publish failed") } });
  const clearQuarantine = useClearArticleQuarantine({
    mutation: {
      onSuccess: () => { toast.success("Quarantine cleared — article is visible on the site"); invalidate(); },
      onError: () => toast.error("Failed to clear quarantine"),
    },
  });
  const unpublish = useUnpublishArticle({ mutation: { onSuccess: () => { toast.success("Unpublished"); invalidate(); } } });
  const postToFacebook = usePostArticleToFacebook({
    mutation: {
      onSuccess: () => toast.success("Posted to Facebook"),
      onError: (err) => {
        const e = err as unknown as { data?: { error?: string; message?: string } };
        toast.error(e?.data?.error ?? e?.data?.message ?? "Facebook post failed");
      },
    },
  });
  const schedule = useScheduleArticle({
    mutation: {
      onSuccess: () => { toast.success("Scheduled"); invalidate(); },
      onError: (err) => {
        const e = err as unknown as { data?: { error?: string; message?: string } };
        if (e?.data?.error === "no_evidence_sources") {
          toast.error("Cannot schedule: no evidence sources. Add sources in Source Vault, then re-run verification.");
        } else {
          toast.error("Schedule failed");
        }
      },
    },
  });
  const remove = useDeleteArticle({ mutation: { onSuccess: () => { toast.success("Deleted"); qc.invalidateQueries({ queryKey: getListArticlesQueryKey() }); setLocation("/admin/articles"); } } });
  const regenImage = useRegenerateArticleImage({
    mutation: {
      onSuccess: (a) => {
        setHeroImage(a.heroImage);
        invalidate();
        toast.success("New hero image ready");
      },
      onError: () => toast.error("Image generation failed"),
    },
  });
  const uploadHeroRef = useRef<HTMLInputElement>(null);
  const uploadHero = useUploadArticleHeroImage({
    mutation: {
      onSuccess: (a) => {
        setHeroImage(a.heroImage);
        invalidate();
        toast.success("Hero image uploaded");
      },
      onError: () => toast.error("Upload failed"),
    },
  });
  const restoreHero = useRestoreArticleHeroImage({
    mutation: {
      onSuccess: (a) => {
        setHeroImage(a.heroImage);
        invalidate();
        toast.success("Hero image restored");
      },
      onError: () => toast.error("Restore failed"),
    },
  });
  function handleHeroFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      uploadHero.mutate({ id, data: { dataUrl } });
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }
  const regenSection = useRegenerateArticleSection({
    mutation: {
      onSuccess: (a) => { setBody(a.body); toast.success("Block written"); invalidate(); },
      onError: (err) => {
        const e = err as unknown as { data?: { error?: string; message?: string } };
        toast.error(e?.data?.message ?? e?.data?.error ?? "Section regeneration failed");
      },
    },
  });
  const regenHooks = useRegenerateArticleHooks({
    mutation: {
      onSuccess: (a) => {
        setHookVariants(a.hookVariants ?? null);
        setHookAssignments(a.hookAssignments ?? null);
        setSocialPack(a.socialPack ?? null);
        toast.success("Hooks & social pack regenerated");
        invalidate();
      },
      onError: () => toast.error("Hook generation failed"),
    },
  });
  const verify = useVerifyArticle({
    mutation: {
      onSuccess: (a) => {
        const st = a.verificationReport?.status;
        // Only hard failures (contradicted claims, invented sources, checker
        // error) quarantine — advisory-only flags stay visible on the site.
        if (st === "passed") toast.success("Evidence check passed — human review still required.");
        else if (st === "flagged" && a.quarantinedAt) toast.warning("Evidence check found serious conflicts — article quarantined.");
        else if (st === "flagged") toast.info("Evidence check left advisory notes — article stays visible.");
        else toast.warning("Evidence check could not run — article quarantined.");
        invalidate();
      },
      onError: (e) => {
        const msg = (e as { response?: { data?: { message?: string; error?: string } } })?.response?.data;
        toast.error(msg?.message ?? msg?.error ?? "Verification failed");
      },
    },
  });
  const refreshEvidence = useRefreshArticleEvidence({
    mutation: {
      onSuccess: (res) => {
        const st = res.verificationStatus;
        if (st === "passed") {
          toast.success(`Evidence refreshed (packet v${res.packetVersion}) — the draft now verifies cleanly against the new packet.`);
        } else if (st === "flagged") {
          toast.warning(`Evidence refreshed (packet v${res.packetVersion}) — verification still has findings. Review them, then redraft or clear quarantine.`);
        } else {
          toast.warning(`Evidence refreshed (packet v${res.packetVersion}) — but the verification check could not run.`);
        }
        invalidate();
      },
      onError: (e) => {
        const msg = (e as { response?: { data?: { message?: string; error?: string } } })?.response?.data;
        toast.error(msg?.message ?? msg?.error ?? "Evidence refresh failed");
      },
    },
  });
  const redraft = useRedraftArticle({
    mutation: {
      onSuccess: () => {
        toast.success("Article re-drafted — review the new body and publish when ready.");
        invalidate();
      },
      onError: (e) => {
        const msg = (e as { response?: { data?: { message?: string; error?: string } } })?.response?.data;
        toast.error(msg?.message ?? msg?.error ?? "Re-draft failed");
      },
    },
  });
  const backfillLinks = useBackfillArticleInternalLinks({
    mutation: {
      onSuccess: (res) => {
        setBody(res.article.body);
        if (res.skipped === "no_candidates") toast.info("No other published articles to link to yet.");
        else if (res.skipped) toast.info("No good spots for internal links were found.");
        else if (res.linksAdded > 0) toast.success(`Added ${res.linksAdded} internal link${res.linksAdded === 1 ? "" : "s"}.`);
        else toast.info("No internal links were added.");
        invalidate();
      },
      onError: () => toast.error("Adding internal links failed"),
    },
  });
  const undoLinks = useUndoArticleInternalLinks({
    mutation: {
      onSuccess: (res) => {
        setBody(res.article.body);
        if (res.restored) toast.success("Reverted to the version before internal links were added.");
        else toast.info("Nothing to undo — no internal-link backfill on this article.");
        invalidate();
      },
      onError: () => toast.error("Undo failed"),
    },
  });
  const backfillSourceLinks = useBackfillArticleSourceLinks({
    mutation: {
      onSuccess: (res) => {
        setBody(res.article.body);
        if (res.skipped === "not_published") toast.info("Only published articles can get source links.");
        else if (res.skipped === "at_target") toast.info("This article already has the maximum source links.");
        else if (res.skipped === "no_paragraphs") toast.info("This article has no paragraphs to add source links to.");
        else if (res.skipped) toast.info("No verifiable sources were found to link.");
        else if (res.linksAdded > 0) toast.success(`Added ${res.linksAdded} source link${res.linksAdded === 1 ? "" : "s"}.`);
        else toast.info("No source links were added.");
        invalidate();
      },
      onError: () => toast.error("Adding source links failed"),
    },
  });
  const undoSourceLinks = useUndoArticleSourceLinks({
    mutation: {
      onSuccess: (res) => {
        setBody(res.article.body);
        if (res.restored) toast.success("Reverted to the version before source links were added.");
        else toast.info("Nothing to undo — no source-link backfill on this article.");
        invalidate();
      },
      onError: () => toast.error("Undo failed"),
    },
  });
  const refreshCitations = useRefreshArticleCitations({
    mutation: {
      onSuccess: (res) => {
        if (res.updated > 0)
          toast.success(`Updated ${res.updated} reference title${res.updated === 1 ? "" : "s"}.`);
        else if (res.fetched > 0)
          toast.info("Re-fetched references but no new titles found — sources may be bot-walled.");
        else
          toast.info("No references to refresh on this article.");
        invalidate();
      },
      onError: () => toast.error("Citation refresh failed"),
    },
  });
  const reassign = useReassignArticleAuthor({
    mutation: {
      onSuccess: () => { toast.success("Author updated"); invalidate(); },
      onError: (err) => {
        const e = err as unknown as { data?: { error?: string } };
        toast.error(e?.data?.error ?? "Couldn't reassign the author");
      },
    },
  });
  const { data: authorsData } = useListAuthors();
  const authorNameOf = (aid: string) => authorsData?.items.find((a) => a.id === aid)?.name ?? "this author";
  // Active authors, plus the article's current author even if it's now inactive,
  // so the dropdown always shows a valid current selection.
  const authorOptions = (() => {
    const all = authorsData?.items ?? [];
    const active = all.filter((a) => a.active);
    if (article && !active.some((a) => a.id === article.authorId)) {
      const current = all.find((a) => a.id === article.authorId);
      if (current) return [current, ...active];
    }
    return active;
  })();
  const [regenIndex, setRegenIndex] = useState<number | null>(null);
  const handleRegen = (i: number) => {
    const instructions = window.prompt("What should this block say? (optional — leave blank to develop whatever's already pasted in)", "") ?? undefined;
    // The server rewrites the block from the PERSISTED body, so any unsaved edits
    // (e.g. a custom paragraph you just added) must be saved first — otherwise it
    // rewrites stale content (or throws "block index out of range" when the new
    // block is past the end of the saved body) and the success handler's setBody
    // would overwrite your unsaved paragraph with the server's stale version.
    const run = () => {
      setRegenIndex(i);
      regenSection.mutate({ id, data: { blockIndex: i, ...(instructions ? { instructions } : {}) } }, { onSettled: () => setRegenIndex(null) });
    };
    if (hasUnsavedChanges()) saveThen(run);
    else run();
  };

  if (isLoading || !article) return <div className="p-4 md:p-8"><Loader2 className="animate-spin" /></div>;

  const currentData = () => ({
    title,
    dek,
    // Send null for blank overrides so the server clears the column and the site
    // falls back to its deterministic derivation.
    seoTitle: seoTitle.trim() ? seoTitle.trim() : null,
    seoDescription: seoDescription.trim() ? seoDescription.trim() : null,
    slug,
    heroImage,
    body,
    categorySlug,
    // Empty array => null so the server clears the field.
    secondaryBeats: secondaryBeats.length ? secondaryBeats : null,
    forceAutoRelated,
    // Empty array => null so the server restores automatic topical ranking.
    relatedSlugs: relatedSlugs && relatedSlugs.length ? relatedSlugs : null,
    hookVariants,
    hookAssignments,
    socialPack,
    editorialLabelOverride,
  });
  const authorDirty = () => !!article && authorId !== article.authorId;
  const fieldsDirty = () =>
    !!article && (
      title !== article.title ||
      dek !== article.dek ||
      (seoTitle.trim() || "") !== (article.seoTitle ?? "") ||
      (seoDescription.trim() || "") !== (article.seoDescription ?? "") ||
      slug !== article.slug ||
      heroImage !== article.heroImage ||
      categorySlug !== article.categorySlug ||
      JSON.stringify(secondaryBeats.length ? secondaryBeats : null) !== JSON.stringify(article.secondaryBeats ?? null) ||
      forceAutoRelated !== (article.forceAutoRelated ?? false) ||
      JSON.stringify(relatedSlugs && relatedSlugs.length ? relatedSlugs : null) !== JSON.stringify(article.relatedSlugs ?? null) ||
      JSON.stringify(body) !== JSON.stringify(article.body) ||
      JSON.stringify(hookVariants) !== JSON.stringify(article.hookVariants ?? null) ||
      JSON.stringify(hookAssignments) !== JSON.stringify(article.hookAssignments ?? null) ||
      JSON.stringify(socialPack) !== JSON.stringify(article.socialPack ?? null) ||
      editorialLabelOverride !== (article.editorialLabelOverride ?? null)
    );
  const hasUnsavedChanges = () => fieldsDirty() || authorDirty();
  // Persist field edits (via update) and any author change (via the dedicated
  // reassign endpoint), then run `next`. The author swap goes last so a
  // scheduled article's slot recompute sees the freshly-saved fields.
  const saveThen = (next: () => void) => {
    const afterFields = () => {
      if (authorDirty()) reassign.mutate({ id, data: { authorId } }, { onSuccess: () => next() });
      else next();
    };
    if (fieldsDirty()) update.mutate({ id, data: currentData() }, { onSuccess: afterFields });
    else afterFields();
  };
  const save = () => saveThen(() => {});
  const publishNow = () => saveThen(() => publish.mutate({ id }));
  const scheduleNow = () => saveThen(() => schedule.mutate({ id, data: { scheduledFor: new Date(scheduleAt).toISOString() } }));

  const updateBlock = (i: number, patch: Partial<ArticleBlock>) => setBody(body.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));
  const moveBlock = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= body.length) return;
    const next = [...body];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setBody(next);
  };
  const removeBlock = (i: number) => setBody(body.filter((_, idx) => idx !== i));
  const addBlock = (after: number, type: ArticleBlock["type"]) => {
    const next = [...body];
    const newBlock: ArticleBlock = type === "takeaways"
      ? { type: "takeaways", items: [""] }
      : ({ type, content: "" } as ArticleBlock);
    next.splice(after + 1, 0, newBlock);
    setBody(next);
  };

  // --- Manual internal-link editing (no AI; pure body-markdown manipulation) ---
  // Remove a single internal link from a paragraph, leaving the anchor text in place.
  const removeLink = (i: number, link: ParsedLink) => {
    const b = body[i];
    if (!b) return;
    // Remove by exact character span (computed from the same content rendered),
    // so the clicked chip is the one removed even with duplicate links.
    const bc = b.content ?? "";
    updateBlock(i, { content: bc.slice(0, link.start) + link.phrase + bc.slice(link.end) });
    toast.success("Link removed — Save to apply.");
  };
  // Open the target picker for block i, but only if there is a usable selection
  // that doesn't overlap an existing link.
  const openLinkPicker = (i: number) => {
    const b = body[i];
    if (!b || !linkSel || linkSel.index !== i || linkSel.end <= linkSel.start) {
      toast.info("Select some text in the paragraph first, then click “Link selected text”.");
      return;
    }
    // Position-based overlap: reject if the selection intersects any existing
    // link span (including selecting text *inside* an anchor, which has no
    // bracket chars but would still produce nested/invalid markdown).
    const overlaps = extractLinks(b.content ?? "").some(
      (lk) => linkSel.start < lk.end && linkSel.end > lk.start,
    );
    if (overlaps) {
      toast.error("Your selection overlaps an existing link — adjust it and try again.");
      return;
    }
    setLinkPickerFor(i);
  };
  // Wrap the tracked selection in block i as `[text](href)` — href is either an
  // internal `/article/slug` or an external `https://…` URL.
  const addLinkToSelection = (i: number, href: string) => {
    const b = body[i];
    if (!b || !linkSel || linkSel.index !== i) {
      setLinkPickerFor(null);
      toast.error("Selection was lost — re-select the text and try again.");
      return;
    }
    const bc2 = b.content ?? "";
    const before = bc2.slice(0, linkSel.start);
    const selected = bc2.slice(linkSel.start, linkSel.end);
    const after = bc2.slice(linkSel.end);
    if (!selected.trim()) {
      toast.error("Nothing selected to link.");
      return;
    }
    // Defense-in-depth: never wrap a span that overlaps an existing link.
    const overlaps = extractLinks(b.content ?? "").some(
      (lk) => linkSel.start < lk.end && linkSel.end > lk.start,
    );
    if (overlaps) {
      setLinkPickerFor(null);
      setLinkSel(null);
      toast.error("Your selection overlaps an existing link.");
      return;
    }
    updateBlock(i, { content: `${before}[${selected}](${href})${after}` });
    setLinkPickerFor(null);
    setLinkSel(null);
    toast.success("Link added — Save to apply.");
  };

  // Mirror the inline-callout layout math from the public article page so editors
  // can see how many auto related callouts will be injected and roughly where.
  // Auto callouts use positions [0.25, 0.5, 0.75] and fill up to 3 from the pool
  // of other published articles; manual relatedArticle blocks suppress them unless
  // "also show auto-picked related callouts" (forceAutoRelated) is on.
  const RELATED_SLOT_POSITIONS = [0.25, 0.5, 0.75];
  const autoPoolSize = (publicList?.items ?? []).filter((a) => a.id !== id).length;
  const manualRelatedCount = body.filter((b) => b.type === "relatedArticle").length;
  const suppressAutoRelated = manualRelatedCount > 0 && !forceAutoRelated;
  const autoCalloutCount = suppressAutoRelated ? 0 : Math.min(RELATED_SLOT_POSITIONS.length, autoPoolSize);
  const autoCalloutPositions = RELATED_SLOT_POSITIONS.slice(0, autoCalloutCount).map((p) => `~${Math.round(p * 100)}%`);

  // ---- Related-articles override (manual re-roll/curation) ----
  // null => automatic topical ranking; an array => manual mode (the editor owns
  // the related set). Resolve slugs -> summaries via the published-article list.
  const publicBySlug = new Map((publicList?.items ?? []).map((a) => [a.slug, a]));
  const autoRelatedItems = autoRelatedData?.items ?? [];
  const autoRelatedSlugs = autoRelatedItems.map((a) => a.slug);
  const relatedManual = relatedSlugs !== null;
  const relatedTitle = (s: string) => publicBySlug.get(s)?.title ?? autoRelatedItems.find((a) => a.slug === s)?.title ?? s;
  // Candidate pool for the "add" picker: published articles, excluding self and
  // anything already chosen, filtered by the search box.
  const relatedQ = relatedQuery.trim().toLowerCase();
  const relatedCandidates = (publicList?.items ?? [])
    .filter((a) => a.id !== id && a.slug !== articleSlug && !(relatedSlugs ?? []).includes(a.slug))
    .filter((a) => !relatedQ || a.title.toLowerCase().includes(relatedQ) || a.slug.includes(relatedQ))
    .slice(0, 8);
  const addRelated = (s: string) => {
    setRelatedSlugs((prev) => {
      const list = prev ?? [];
      if (list.includes(s) || list.length >= 12) return list;
      return [...list, s];
    });
    setRelatedQuery("");
  };
  const removeRelated = (s: string) => setRelatedSlugs((prev) => (prev ?? []).filter((x) => x !== s));
  const moveRelated = (i: number, dir: -1 | 1) =>
    setRelatedSlugs((prev) => {
      if (!prev) return prev;
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const enableManualRelated = () => setRelatedSlugs((prev) => prev ?? [...autoRelatedSlugs]);
  const resetRelatedToAuto = () => setRelatedSlugs(null);
  const fillFromAuto = async () => {
    const res = await refetchAutoRelated();
    setRelatedSlugs([...(res.data?.items ?? []).map((a) => a.slug)]);
  };

  return (
    <div className="p-4 md:p-8 max-w-5xl space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <span className={`text-xs px-2 py-0.5 rounded-full ${article.status === "published" ? "bg-emerald-100 text-emerald-700" : article.status === "scheduled" ? "bg-amber-100 text-amber-700" : "bg-muted text-muted-foreground"}`}>{article.status}</span>
          <span className="text-xs text-muted-foreground ml-2">{article.category} · Updated {format(new Date(article.updatedAt), "MMM d, h:mm a")}</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button onClick={save} disabled={update.isPending}>{update.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Save</Button>
          {article.status === "published" && (
            <Button
              variant="outline"
              onClick={() => (hasUnsavedChanges() ? saveThen(() => backfillLinks.mutate({ id })) : backfillLinks.mutate({ id }))}
              disabled={backfillLinks.isPending || undoLinks.isPending || update.isPending || reassign.isPending}
              title="Weave a few contextual links to other published articles into this article's prose"
            >
              {backfillLinks.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Link2 className="h-4 w-4 mr-2" />}
              Add internal links
            </Button>
          )}
          {article.status === "published" && (article.internalLinksBackup?.length ?? 0) > 0 && (
            <Button
              variant="ghost"
              onClick={() => undoLinks.mutate({ id })}
              disabled={undoLinks.isPending || backfillLinks.isPending}
              title="Undo the internal-link backfill and restore the previous version"
            >
              {undoLinks.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Undo2 className="h-4 w-4 mr-2" />}
              Undo links
            </Button>
          )}
          {article.status === "published" && (
            <Button
              variant="outline"
              onClick={() => (hasUnsavedChanges() ? saveThen(() => backfillSourceLinks.mutate({ id })) : backfillSourceLinks.mutate({ id }))}
              disabled={backfillSourceLinks.isPending || undoSourceLinks.isPending || update.isPending || reassign.isPending}
              title="Find and link a few verified external sources for claims in this article (never fabricates URLs, never rewords prose)"
            >
              {backfillSourceLinks.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <BookMarked className="h-4 w-4 mr-2" />}
              Add source links
            </Button>
          )}
          {article.status === "published" && (article.sourceLinksBackup?.length ?? 0) > 0 && (
            <Button
              variant="ghost"
              onClick={() => undoSourceLinks.mutate({ id })}
              disabled={undoSourceLinks.isPending || backfillSourceLinks.isPending}
              title="Undo the source-link backfill and restore the previous version"
            >
              {undoSourceLinks.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Undo2 className="h-4 w-4 mr-2" />}
              Undo sources
            </Button>
          )}
          {article.status === "published" && (
            <Button
              variant="outline"
              onClick={() => refreshCitations.mutate({ id })}
              disabled={refreshCitations.isPending}
              title="Re-fetch the bibliographic title, authors, and publisher for each reference on this article — fixes references showing article prose instead of a real title"
            >
              {refreshCitations.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
              {refreshCitations.isPending ? "Refreshing references…" : "Refresh references"}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => {
              if (!window.confirm("Re-draft will regenerate the article body from scratch using current vault evidence, then move it back to draft. Hero image, slug, and author are kept. Continue?")) return;
              saveThen(() => redraft.mutate({ id }));
            }}
            disabled={redraft.isPending || update.isPending}
            title="Regenerate the article body from scratch using current vault evidence — keeps hero image, slug, and author"
          >
            {redraft.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            {redraft.isPending ? "Re-drafting…" : "Re-draft"}
          </Button>
          {article.status !== "published" && <Button variant="default" onClick={publishNow} disabled={publish.isPending || update.isPending}>Publish now</Button>}
          {article.status === "published" && <Button variant="outline" onClick={() => saveThen(() => unpublish.mutate({ id }))}>Unpublish</Button>}
          {article.status === "published" && (
            <Button variant="outline" onClick={() => postToFacebook.mutate({ id })} disabled={postToFacebook.isPending}>
              {postToFacebook.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Facebook className="h-4 w-4 mr-2" />}
              Post to Facebook
            </Button>
          )}
          <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} className="border rounded px-2 py-1 text-sm bg-background" />
          <Button variant="outline" disabled={!scheduleAt || schedule.isPending || update.isPending} onClick={scheduleNow}>Schedule</Button>
          <Button variant="ghost" size="icon" onClick={() => { if (confirm("Delete this article permanently?")) remove.mutate({ id }); }}><Trash2 className="h-4 w-4 text-rose-600" /></Button>
        </div>
      </div>

      {article.evidencePacketId && article.holdReason === "no_evidence_sources" && (
        <Card className="p-3 border-amber-400 bg-amber-50/70 text-sm flex items-start gap-2">
          <span className="text-xs px-2 py-0.5 rounded-full bg-amber-200 text-amber-900 font-semibold shrink-0 mt-0.5">Held — no sources</span>
          <span className="text-amber-900">
            This article cannot be scheduled: its evidence packet has no sources linked in the article body.{" "}
            <a
              href={`/admin/source-vault?packetId=${article.evidencePacketId}&articleId=${id}`}
              className="underline underline-offset-2 text-amber-700 hover:text-amber-900"
            >
              Open Source Vault
            </a>{" "}
            to attach sources, then re-run verification before scheduling.
          </span>
        </Card>
      )}

      {continuesId && (
        <Card className="p-3 border-amber-300 bg-amber-50/60 text-sm flex items-center gap-2">
          <span className="text-xs px-2 py-0.5 rounded-full bg-amber-200 text-amber-900 font-medium">Follow-up</span>
          <span className="text-muted-foreground">Continues</span>
          {parentArticle ? (
            <Link href={`/admin/articles/${continuesId}`} className="font-medium text-amber-900 hover:underline truncate">
              "{parentArticle.title}"
            </Link>
          ) : (
            <span className="text-muted-foreground italic">earlier article</span>
          )}
        </Card>
      )}

      {article.evidencePacketId && (
        <EvidenceVerificationCard
          article={article}
          onRerun={() => verify.mutate({ id })}
          isVerifying={verify.isPending}
          onClearQuarantine={() => clearQuarantine.mutate({ id })}
          isClearingQuarantine={clearQuarantine.isPending}
          onRefreshEvidence={() => refreshEvidence.mutate({ id })}
          isRefreshingEvidence={refreshEvidence.isPending}
        />
      )}

      <Card className="p-6 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <Label>Hero image URL</Label>
            <div className="flex gap-2">
              <Input value={heroImage} onChange={(e) => setHeroImage(e.target.value)} disabled={regenImage.isPending || uploadHero.isPending} />
              <input
                ref={uploadHeroRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleHeroFileChange}
              />
              <Button
                variant="outline"
                size="icon"
                onClick={() => uploadHeroRef.current?.click()}
                disabled={regenImage.isPending || uploadHero.isPending}
                title="Upload hero image from file"
              >
                {uploadHero.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={() => regenImage.mutate({ id })}
                disabled={regenImage.isPending || uploadHero.isPending}
                title="Regenerate hero image with AI"
              >
                {regenImage.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>
        {heroImage && (
          <div className="relative rounded-lg overflow-hidden">
            <img
              src={withImageParams(resolveImage(heroImage), 900)}
              onError={handleImageError}
              alt=""
              className={`max-h-72 object-cover w-full transition-opacity ${regenImage.isPending || uploadHero.isPending ? "opacity-40" : "opacity-100"}`}
            />
            {(regenImage.isPending || uploadHero.isPending) && (
              <div className="absolute inset-0 flex items-center justify-center bg-background/30 backdrop-blur-sm">
                <div className="flex items-center gap-3 px-4 py-2 rounded-full bg-background/90 shadow-lg border">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm font-medium">
                    {uploadHero.isPending ? "Uploading hero image…" : "Generating new hero image… (~10s)"}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
        {(article.heroImageHistory?.length ?? 0) > 0 && (
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">
              Previous versions ({article.heroImageHistory!.length}) — click “Use this” to restore
            </Label>
            <div className="flex flex-wrap gap-3">
              {article.heroImageHistory!.map((v) => (
                <div key={v.heroImage} className="w-28 space-y-1">
                  <div className="relative rounded-md overflow-hidden border">
                    <img
                      src={withImageParams(resolveImage(v.heroImage), 200)}
                      onError={handleImageError}
                      alt=""
                      className="h-16 w-full object-cover"
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full h-7 text-xs"
                    onClick={() => restoreHero.mutate({ id, data: { heroImage: v.heroImage } })}
                    disabled={regenImage.isPending || uploadHero.isPending || restoreHero.isPending}
                  >
                    {restoreHero.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Use this"}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      <ArticleMemesCard articleId={id} />

      <Card className="p-6 space-y-4">
        <div>
          <Label>Title</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} className="text-2xl font-serif font-bold h-auto py-2" />
          {(article.titleCandidates?.length ?? 0) > 0 && (
            <div className="mt-2 space-y-1">
              <p className="text-xs text-muted-foreground">
                AI title suggestions (your idea title is the working title — click to swap):
              </p>
              <div className="flex flex-wrap gap-2">
                {article.titleCandidates!.map((cand, i) => {
                  const isActive = cand === title;
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setTitle(cand)}
                      className={`text-left text-sm px-3 py-1.5 rounded-full border transition-colors max-w-full ${
                        isActive
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-muted/40 hover:bg-primary/10 hover:border-primary border-border text-foreground"
                      }`}
                      title={isActive ? "Currently selected" : "Use this title"}
                    >
                      {cand}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <div><Label>Subhead</Label><Textarea rows={2} value={dek} onChange={(e) => setDek(e.target.value)} /></div>
        <div className="rounded-md border bg-muted/30 p-4 space-y-3">
          <p className="text-sm font-medium">Search &amp; social (SEO)</p>
          <p className="text-xs text-muted-foreground -mt-2">
            Optional. Controls the browser tab title and the title/description shown in Google and social shares — not the headline on the page. Leave blank to auto-generate from the title and subhead.
          </p>
          <div>
            <div className="flex items-center justify-between">
              <Label>SEO title</Label>
              <span className={`text-xs ${seoTitle.length > 60 ? "text-amber-700" : "text-muted-foreground"}`}>
                {seoTitle.length}/~55
              </span>
            </div>
            <Input
              value={seoTitle}
              onChange={(e) => setSeoTitle(e.target.value)}
              placeholder={article.title}
            />
          </div>
          <div>
            <div className="flex items-center justify-between">
              <Label>SEO description</Label>
              <span className={`text-xs ${seoDescription.length > 160 ? "text-amber-700" : "text-muted-foreground"}`}>
                {seoDescription.length}/120–155
              </span>
            </div>
            <Textarea
              rows={2}
              value={seoDescription}
              onChange={(e) => setSeoDescription(e.target.value)}
              placeholder={article.dek}
            />
          </div>
        </div>
        <div className="rounded-md border bg-muted/30 p-4 space-y-2">
          <p className="text-sm font-medium">Editorial type</p>
          <p className="text-xs text-muted-foreground -mt-1">
            Shown in the "How this article was produced" trust box. Auto-detect chooses based on source count (Research Synthesis requires 3+ primary sources or an evidence packet). Set a manual override if the auto-label is wrong for this piece.
          </p>
          <select
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
            value={editorialLabelOverride ?? ""}
            onChange={(e) => setEditorialLabelOverride((e.target.value || null) as UpdateArticleInputEditorialLabelOverride | null)}
          >
            <option value="">Auto-detect</option>
            <option value="research_synthesis">Research Synthesis</option>
            <option value="analysis">Analysis</option>
            <option value="explainer">Explainer</option>
            <option value="original_reporting">Original Reporting</option>
            <option value="commentary">Commentary</option>
          </select>
          {editorialLabelOverride && (
            <p className="text-xs text-amber-700">
              Override active — the trust box will show "{editorialLabelOverride.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}" regardless of source count.
            </p>
          )}
        </div>
        <div className="rounded-md border bg-muted/30 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Headline hooks &amp; social pack</p>
              <p className="text-xs text-muted-foreground">
                Five headline angles you can map onto each surface, plus ready-to-post social copy. Click Save to persist edits.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={regenHooks.isPending}
              onClick={() => regenHooks.mutate({ id })}
            >
              {regenHooks.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              <span className="ml-2">Regenerate</span>
            </Button>
          </div>

          {(!hookVariants || hookVariants.length === 0) && !socialPack ? (
            <p className="text-xs text-muted-foreground italic">
              No hooks generated yet. Click Regenerate to create headline variants and a social pack.
            </p>
          ) : null}

          {hookVariants && hookVariants.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Headline variants</p>
              {hookVariants.map((v, i) => (
                <div key={v.mode} className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">{HOOK_MODE_LABELS[v.mode] ?? v.mode}</Label>
                    <button
                      type="button"
                      className="text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => navigator.clipboard?.writeText(v.text).then(() => toast.success("Copied"))}
                    >
                      Copy
                    </button>
                  </div>
                  <Textarea
                    rows={2}
                    value={v.text}
                    onChange={(e) =>
                      setHookVariants((prev) =>
                        (prev ?? []).map((x, idx) => (idx === i ? { ...x, text: e.target.value } : x)),
                      )
                    }
                  />
                </div>
              ))}

              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Surface assignments</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {HOOK_SURFACES.map((s) => (
                    <div key={s.key}>
                      <Label className="text-xs" title={s.hint}>{s.label}</Label>
                      <select
                        className="w-full border rounded-md px-2 py-1.5 text-sm bg-background"
                        value={hookAssignments?.[s.key] ?? ""}
                        onChange={(e) => {
                          const val = e.target.value;
                          setHookAssignments((prev) => {
                            const next = { ...(prev ?? {}) } as HookAssignments;
                            if (val) next[s.key] = val as HookMode;
                            else delete next[s.key];
                            return next;
                          });
                        }}
                      >
                        <option value="">Auto (fallback)</option>
                        {hookVariants.map((v) => (
                          <option key={v.mode} value={v.mode}>{HOOK_MODE_LABELS[v.mode] ?? v.mode}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {socialPack && (
            <div className="space-y-3 border-t pt-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Social pack</p>
              {SOCIAL_FIELDS.map((f) => {
                const value = (socialPack[f.key] as string) ?? "";
                return (
                  <div key={f.key} className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">{f.label}</Label>
                      <button
                        type="button"
                        className="text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => navigator.clipboard?.writeText(value).then(() => toast.success("Copied"))}
                      >
                        Copy
                      </button>
                    </div>
                    <Textarea
                      rows={f.rows}
                      value={value}
                      onChange={(e) =>
                        setSocialPack((prev) => (prev ? { ...prev, [f.key]: e.target.value } : prev))
                      }
                    />
                  </div>
                );
              })}
              {socialPack.altCaptions && socialPack.altCaptions.length > 0 && (
                <div className="space-y-1">
                  <Label className="text-xs">Alt captions</Label>
                  {socialPack.altCaptions.map((cap, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input
                        value={cap}
                        onChange={(e) =>
                          setSocialPack((prev) =>
                            prev
                              ? { ...prev, altCaptions: prev.altCaptions.map((c, idx) => (idx === i ? e.target.value : c)) }
                              : prev,
                          )
                        }
                      />
                      <button
                        type="button"
                        className="text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => navigator.clipboard?.writeText(cap).then(() => toast.success("Copied"))}
                      >
                        Copy
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div><Label>Slug</Label><Input value={slug} onChange={(e) => setSlug(e.target.value)} /></div>
          <div>
            <Label>Category</Label>
            <select
              className="w-full border rounded-md px-3 py-2 text-sm bg-background"
              value={categorySlug}
              onChange={(e) => setCategorySlug(e.target.value)}
            >
              {beats.length === 0 && <option value={categorySlug}>{article.category}</option>}
              {beats.map((b) => (
                <option key={b.slug} value={b.slug}>{b.name}</option>
              ))}
            </select>
            {categorySlug !== article.categorySlug && (
              <p className="text-xs text-amber-700 mt-1">
                Reclassifying from <span className="font-medium">{article.category}</span> — click Save to apply.
              </p>
            )}
            <div className="mt-2">
              <SecondaryBeatsEditor
                primarySlug={categorySlug}
                value={secondaryBeats}
                onChange={setSecondaryBeats}
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Cross-sectional secondary subjects (admin-only — never shown to readers or in the public category). Click Save to apply.
              </p>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <Label>Author</Label>
            <select
              className="w-full border rounded-md px-3 py-2 text-sm bg-background"
              value={authorId}
              onChange={(e) => setAuthorId(e.target.value)}
            >
              {authorOptions.length === 0 && <option value={authorId}>{authorNameOf(article.authorId)}</option>}
              {authorOptions.map((a) => (
                <option key={a.id} value={a.id}>{a.name}{a.active ? "" : " (inactive)"}</option>
              ))}
            </select>
            {authorId !== article.authorId && (
              <p className="text-xs text-amber-700 mt-1">
                Reassigning from <span className="font-medium">{authorNameOf(article.authorId)}</span>
                {article.status === "scheduled"
                  ? " — it'll move to the new author's next free slot when you Save."
                  : " — click Save to apply."}
              </p>
            )}
          </div>
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex items-center justify-between gap-4 mb-2 flex-wrap">
          <h2 className="font-serif text-xl font-bold">Related articles</h2>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${relatedManual ? "bg-primary/10 text-primary" : "bg-emerald-100 text-emerald-700"}`}>
            {relatedManual ? "Manual selection" : "Automatic (by topic)"}
          </span>
        </div>
        <p className="text-xs text-muted-foreground mb-4 max-w-2xl">
          These power the "More like this" rail and the inline "related to this article" callouts.
          The first 3 appear in the rail; the next 3 become inline callouts. Switch to manual to fix
          any off-topic picks.
        </p>

        {!relatedManual ? (
          <div className="space-y-3">
            {!articlePublished ? (
              <p className="text-sm text-muted-foreground">
                Auto-picked neighbors are computed once the article is published. You can still switch to
                a manual selection now.
              </p>
            ) : autoRelatedItems.length > 0 ? (
              <ol className="space-y-1.5">
                {autoRelatedItems.map((a, i) => (
                  <li key={a.slug} className="flex items-center gap-2 text-sm">
                    <span className="text-xs text-muted-foreground w-5 shrink-0">{i + 1}.</span>
                    <span className="truncate">{a.title}</span>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0">
                      {i < 3 ? "rail" : "inline"}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">
                No strong topical matches — readers see no related articles here (which is correct when
                nothing is genuinely related).
              </p>
            )}
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={enableManualRelated}>
                Choose manually
              </Button>
              {articlePublished && (
                <Button type="button" variant="ghost" size="sm" onClick={() => refetchAutoRelated()} disabled={autoRelatedFetching}>
                  <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${autoRelatedFetching ? "animate-spin" : ""}`} />
                  Refresh
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {(relatedSlugs ?? []).length > 0 ? (
              <ol className="space-y-1.5">
                {(relatedSlugs ?? []).map((s, i) => (
                  <li key={s} className="flex items-center gap-2 text-sm rounded-md border px-2 py-1.5">
                    <span className="text-xs text-muted-foreground w-5 shrink-0">{i + 1}.</span>
                    <span className="truncate flex-1">{relatedTitle(s)}</span>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0">
                      {i < 3 ? "rail" : "inline"}
                    </span>
                    <button type="button" className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30" onClick={() => moveRelated(i, -1)} disabled={i === 0} title="Move up">
                      <ArrowUp className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30" onClick={() => moveRelated(i, 1)} disabled={i === (relatedSlugs ?? []).length - 1} title="Move down">
                      <ArrowDown className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" className="p-1 text-muted-foreground hover:text-destructive" onClick={() => removeRelated(s)} title="Remove">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">
                No articles selected yet — if you leave this empty and save, it falls back to automatic.
                Add some below to curate the set.
              </p>
            )}

            <div className="relative max-w-md">
              <Input
                value={relatedQuery}
                onChange={(e) => setRelatedQuery(e.target.value)}
                placeholder="Search articles to add…"
                disabled={(relatedSlugs ?? []).length >= 12}
              />
              {relatedQuery.trim() && relatedCandidates.length > 0 && (
                <div className="absolute z-10 mt-1 w-full rounded-md border bg-background shadow-md max-h-64 overflow-auto">
                  {relatedCandidates.map((a) => (
                    <button
                      key={a.slug}
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                      onClick={() => addRelated(a.slug)}
                    >
                      <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{a.title}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {articlePublished && (
                <Button type="button" variant="outline" size="sm" onClick={fillFromAuto} disabled={autoRelatedFetching}>
                  <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${autoRelatedFetching ? "animate-spin" : ""}`} />
                  Re-roll from auto picks
                </Button>
              )}
              <Button type="button" variant="ghost" size="sm" onClick={resetRelatedToAuto}>
                Reset to automatic
              </Button>
              <span className="text-xs text-muted-foreground">Save to apply.</span>
            </div>
          </div>
        )}
      </Card>

      <Card className="p-6">
        <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
          <h2 className="font-serif text-xl font-bold">Body</h2>
          {manualRelatedCount > 0 && (
            <label className="flex items-start gap-2 text-sm cursor-pointer select-none max-w-md">
              <input
                type="checkbox"
                className="mt-1"
                checked={forceAutoRelated}
                onChange={(e) => setForceAutoRelated(e.target.checked)}
              />
              <span>
                <span className="font-medium">Also show auto-picked related callouts</span>
                <span className="block text-xs text-muted-foreground">
                  By default, placing a suggested-article block turns off the random related callouts. Enable this to keep your manual picks <em>and</em> the usual auto callouts.
                </span>
              </span>
            </label>
          )}
        </div>
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium text-muted-foreground">Related callouts:</span>
          {manualRelatedCount > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
              {manualRelatedCount} manual
            </span>
          )}
          {autoCalloutCount > 0 ? (
            <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">
              {autoCalloutCount} auto callout{autoCalloutCount > 1 ? "s" : ""} at {autoCalloutPositions.join(" / ")}
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
              No auto callouts
              {suppressAutoRelated
                ? " (suppressed by manual picks)"
                : autoPoolSize === 0
                  ? " (no other articles yet)"
                  : ""}
            </span>
          )}
        </div>
        <div className="space-y-3">
          {body.map((block, i) => (
            <div key={i} className="border rounded-lg p-3 space-y-2">
              <div className="flex items-center gap-2">
                <select className="border rounded px-2 py-1 text-xs bg-background" value={block.type} onChange={(e) => updateBlock(i, { type: e.target.value as ArticleBlock["type"] })}>
                  {BLOCK_TYPES.map((t) => <option key={t} value={t}>{BLOCK_LABELS[t]}</option>)}
                </select>
                <div className="flex-1" />
                <Button size="icon" variant="ghost" onClick={() => moveBlock(i, -1)}><ArrowUp className="h-4 w-4" /></Button>
                <Button size="icon" variant="ghost" onClick={() => moveBlock(i, 1)}><ArrowDown className="h-4 w-4" /></Button>
                {block.type !== "image" && block.type !== "relatedArticle" && (
                  <Button size="icon" variant="ghost" onClick={() => handleRegen(i)} disabled={regenSection.isPending || update.isPending || reassign.isPending} title="Write this block with AI from what's pasted here (in the author's voice)">
                    {regenSection.isPending && regenIndex === i ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  </Button>
                )}
                <Button size="icon" variant="ghost" onClick={() => removeBlock(i)}><Trash2 className="h-4 w-4 text-rose-600" /></Button>
              </div>
              {block.type === "relatedArticle" ? (
                <RelatedArticlePicker
                  slug={block.content ?? ""}
                  excludeSlug={slug}
                  onChange={(s) => updateBlock(i, { content: s })}
                />
              ) : block.type === "takeaways" ? (
                <div className="space-y-2">
                  {(block.items ?? []).map((item, ii) => (
                    <div key={ii} className="flex items-center gap-2">
                      <span className="shrink-0 text-xs text-muted-foreground w-4 text-right">{ii + 1}.</span>
                      <input
                        type="text"
                        className="flex-1 border rounded px-2 py-1 text-sm bg-background"
                        value={item}
                        placeholder="Concrete action the reader can take…"
                        onChange={(e) => {
                          const next = [...(block.items ?? [])];
                          next[ii] = e.target.value;
                          updateBlock(i, { items: next } as Partial<ArticleBlock>);
                        }}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="shrink-0 h-7 w-7"
                        onClick={() => {
                          const next = (block.items ?? []).filter((_, idx) => idx !== ii);
                          updateBlock(i, { items: next.length ? next : [""] } as Partial<ArticleBlock>);
                        }}
                      >
                        <Trash2 className="h-3 w-3 text-rose-500" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    onClick={() => updateBlock(i, { items: [...(block.items ?? []), ""] } as Partial<ArticleBlock>)}
                    disabled={(block.items ?? []).length >= 7}
                  >
                    <Plus className="h-3 w-3 mr-1" />Add bullet
                  </Button>
                </div>
              ) : (
                <>
                  <Textarea
                    rows={block.type === "paragraph" ? 4 : 2}
                    value={block.content ?? ""}
                    onChange={(e) => {
                      updateBlock(i, { content: e.target.value });
                      // Selection offsets are stale once the text changes.
                      if (linkSel?.index === i) setLinkSel(null);
                    }}
                    onSelect={(e) => {
                      const t = e.currentTarget;
                      setLinkSel({ index: i, start: t.selectionStart ?? 0, end: t.selectionEnd ?? 0 });
                    }}
                    placeholder={block.type === "image" ? "Image URL" : block.type === "heading" ? "Section heading" : block.type === "pullquote" ? "A single striking sentence" : "Paragraph text"}
                    className={block.type === "heading" ? "font-serif font-bold text-xl" : block.type === "pullquote" ? "italic" : ""}
                  />
                  {block.type === "paragraph" && (() => {
                    const links = extractLinks(block.content ?? "");
                    return (
                      <div className="space-y-1.5">
                        {links.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-xs text-muted-foreground mr-0.5">Links:</span>
                            {links.map((lk, li) => (
                              <span
                                key={li}
                                title={lk.href}
                                className={`inline-flex items-center gap-1 rounded-full text-xs px-2 py-0.5 max-w-full ${lk.external ? "bg-amber-500/15 text-amber-700" : "bg-primary/10 text-primary"}`}
                              >
                                {lk.external ? <ExternalLink className="h-3 w-3 shrink-0" /> : <Link2 className="h-3 w-3 shrink-0" />}
                                <span className="truncate">{lk.phrase}</span>
                                <span className="opacity-60 shrink-0 truncate">→ {lk.label}</span>
                                <button
                                  type="button"
                                  onClick={() => removeLink(i, lk)}
                                  title="Remove this link"
                                  className="ml-0.5 hover:text-rose-600 shrink-0"
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                        {linkPickerFor === i ? (
                          <LinkTargetPicker
                            selectedText={linkSel && linkSel.index === i ? (block.content ?? "").slice(linkSel.start, linkSel.end) : ""}
                            excludeSlug={slug}
                            onPick={(href) => addLinkToSelection(i, href)}
                            onCancel={() => setLinkPickerFor(null)}
                          />
                        ) : (
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => openLinkPicker(i)}>
                            <Link2 className="h-3 w-3 mr-1" />Link selected text
                          </Button>
                        )}
                      </div>
                    );
                  })()}
                </>
              )}
              <div className="flex gap-1 pt-1 flex-wrap">
                {BLOCK_TYPES.map((t) => (
                  <Button key={t} size="sm" variant="ghost" className="h-7 text-xs" onClick={() => addBlock(i, t)}>
                    <Plus className="h-3 w-3 mr-1" />{BLOCK_LABELS[t]}
                  </Button>
                ))}
              </div>
            </div>
          ))}
          {body.length === 0 && (
            <Button variant="outline" onClick={() => setBody([{ type: "paragraph", content: "" }])}>
              <Plus className="h-4 w-4 mr-2" />Add first block
            </Button>
          )}
        </div>
      </Card>

      <ArticleAiCostCard articleId={id} />
    </div>
  );
}

function ArticleAiCostCard({ articleId }: { articleId: string }) {
  const { data, isLoading } = useGetArticleAiCost(articleId, {
    query: { queryKey: getGetArticleAiCostQueryKey(articleId), staleTime: 60000 },
  });

  if (isLoading) return null;
  if (!data || data.totalCalls === 0) return null;

  function usd(n: number) {
    if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
    return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
  }

  const maxOpCost = Math.max(0, ...data.byOperation.map((o) => o.costUsd));

  return (
    <Card className="p-6 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">AI spend for this article</h3>
        <span className="text-lg font-bold tabular-nums">{usd(data.totalCostUsd)}</span>
      </div>
      <div className="text-xs text-muted-foreground">
        {data.totalCalls} AI calls · {data.totalInputTokens.toLocaleString()} input tokens · {data.totalOutputTokens.toLocaleString()} output tokens{data.totalImages > 0 ? ` · ${data.totalImages} image${data.totalImages > 1 ? "s" : ""}` : ""}
      </div>
      {data.byOperation.length > 0 && (
        <div className="space-y-1.5 pt-1">
          {data.byOperation.map((o) => {
            const pct = maxOpCost > 0 ? Math.round((o.costUsd / maxOpCost) * 100) : 0;
            const labels: Record<string, string> = {
              generateArticleDraft: "Draft",
              generateHooksAndSocialPack: "Headlines + social",
              generateAndStoreHeroImage: "Hero image",
              insertInternalLinks: "Internal links",
              insertSourceLinks: "Source links",
              regenerateBlock: "Block regeneration",
              backfillHooksAndSocialPack: "Hook backfill",
              regenerateHooksAndSocialPack: "Hook regen",
            };
            const label = labels[o.operation] ?? o.operation;
            return (
              <div key={o.operation} className="flex items-center gap-2 text-xs">
                <div className="w-32 shrink-0 truncate text-muted-foreground" title={label}>{label}</div>
                <div className="flex-1 bg-muted rounded-full h-1.5 overflow-hidden">
                  <div className="bg-primary h-full rounded-full" style={{ width: `${pct}%` }} />
                </div>
                <div className="w-16 text-right tabular-nums font-medium">{usd(o.costUsd)}</div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

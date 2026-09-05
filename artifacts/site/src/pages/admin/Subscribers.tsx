import { useState } from "react";
import {
  useListSubscribers,
  useListSuppressedSubscribers,
  useListBeats,
  useUpdateSubscriber,
  useSendTestNewsletter,
  useRemoveSubscribers,
  useSendSubscriberBroadcast,
  getListSubscribersQueryKey,
  getListSuppressedSubscribersQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Inbox, Download, Send, ShieldX, Ban, Megaphone } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

const EVERYTHING = "__everything__";

function reasonLabel(reason: string | null | undefined): string {
  switch (reason) {
    case "complaint":
      return "Spam complaint";
    case "manual":
      return "Removed manually";
    case "bounce":
      return "Hard bounce";
    case null:
    case undefined:
      return "Suppressed";
    default:
      // Bounce sub-types (e.g. "Permanent") arrive verbatim from Resend.
      return `Bounce (${reason})`;
  }
}

function reasonClasses(reason: string | null | undefined): string {
  if (reason === "complaint") return "bg-red-100 text-red-800 border-red-200";
  if (reason === "manual") return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-orange-100 text-orange-800 border-orange-200";
}

export default function AdminSubscribers() {
  const { data, isLoading } = useListSubscribers();
  const { data: suppressedData } = useListSuppressedSubscribers();
  const { data: beatsData } = useListBeats();
  const qc = useQueryClient();
  const beats = beatsData?.items ?? [];
  const nameBySlug = new Map(beats.map((b) => [b.slug, b.name]));

  const updateSubscriber = useUpdateSubscriber();
  const sendTest = useSendTestNewsletter();
  const removeSubscribers = useRemoveSubscribers();
  const sendBroadcast = useSendSubscriberBroadcast();

  const [testEmail, setTestEmail] = useState("");
  const [testCategory, setTestCategory] = useState<string>(EVERYTHING);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [removeInput, setRemoveInput] = useState("");

  const [broadcastSubject, setBroadcastSubject] = useState("");
  const [broadcastBody, setBroadcastBody] = useState("");

  const suppressed = suppressedData?.items ?? [];

  const refreshAll = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: getListSubscribersQueryKey() }),
      qc.invalidateQueries({ queryKey: getListSuppressedSubscribersQueryKey() }),
    ]);
  };

  const handleExport = () => {
    if (!data || data.items.length === 0) return;
    const header = "email,subscribed_at,preferred_category\n";
    const rows = data.items
      .map(
        (s) =>
          `${s.email},${new Date(s.createdAt).toISOString()},${s.preferredCategory ?? ""}`,
      )
      .join("\n");
    const blob = new Blob([header + rows], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `brainhook-subscribers-${format(new Date(), "yyyy-MM-dd")}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleChangeCategory = async (email: string, value: string) => {
    const preferredCategory = value === EVERYTHING ? null : value;
    setPendingEmail(email);
    try {
      await updateSubscriber.mutateAsync({ email, data: { preferredCategory } });
      await qc.invalidateQueries({ queryKey: getListSubscribersQueryKey() });
      toast.success(
        preferredCategory
          ? `Preference set to ${nameBySlug.get(preferredCategory) ?? preferredCategory}`
          : "Preference set to Everything",
      );
    } catch (e) {
      const msg =
        (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        "Failed to update preference";
      toast.error(msg);
    } finally {
      setPendingEmail(null);
    }
  };

  const handleTestFire = async () => {
    const email = testEmail.trim();
    if (!email) {
      toast.error("Enter an email address to send the test to.");
      return;
    }
    const preferredCategory = testCategory === EVERYTHING ? null : testCategory;
    try {
      const res = await sendTest.mutateAsync({ data: { email, preferredCategory } });
      if (res.delivered) {
        const variant = res.categoryLabel ? `${res.categoryLabel} edition` : "general digest";
        toast.success(`Test newsletter sent to ${email} (${variant}, via ${res.provider}).`);
      } else if (res.skipped === "no_articles") {
        toast.error("No published articles to include — nothing was sent.");
      } else {
        toast.error(`Test not delivered (provider: ${res.provider}).`);
      }
    } catch (e) {
      const msg =
        (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        "Failed to send test newsletter";
      toast.error(msg);
    }
  };

  // Single-row removal (X button) and bulk paste both funnel through the same
  // mutation; the server splits/normalizes/dedupes whatever it receives.
  const removeEmails = async (emails: string[], clearInput: boolean) => {
    try {
      const res = await removeSubscribers.mutateAsync({ data: { emails } });
      await refreshAll();
      if (clearInput) setRemoveInput("");
      const parts: string[] = [`${res.existing} removed`];
      if (res.added > 0) parts.push(`${res.added} pre-blocked`);
      toast.success(`Suppressed ${res.requested} address${res.requested === 1 ? "" : "es"} (${parts.join(", ")}).`);
    } catch (e) {
      const msg =
        (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        "Failed to suppress addresses";
      toast.error(msg);
    }
  };

  const handleBulkRemove = async () => {
    const emails = removeInput
      .split(/[\s,;]+/)
      .map((e) => e.trim())
      .filter(Boolean);
    if (emails.length === 0) {
      toast.error("Paste one or more email addresses to remove.");
      return;
    }
    await removeEmails(emails, true);
  };

  if (isLoading || !data)
    return (
      <div className="p-4 md:p-8">
        <Loader2 className="animate-spin" />
      </div>
    );

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-4xl">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl font-bold">Subscribers</h1>
          <p className="text-muted-foreground mt-1">
            {data.total} active newsletter signup{data.total === 1 ? "" : "s"}
            {suppressed.length > 0 && ` · ${suppressed.length} suppressed`}
          </p>
        </div>
        <Button onClick={handleExport} disabled={data.items.length === 0} variant="outline">
          <Download className="h-4 w-4 mr-2" /> Export CSV
        </Button>
      </div>

      {/* Test fire: preview the weekly newsletter to any address, optionally
          tailored to a category exactly as a real subscriber's choice would be. */}
      <Card className="p-5 space-y-3">
        <div>
          <h2 className="font-serif text-lg font-bold">Send a test newsletter</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Fires the weekly roundup to one address so you can preview it. Pick a category to see a
            tailored edition, or leave it on Everything for the general digest.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Input
            type="email"
            placeholder="you@example.com"
            value={testEmail}
            onChange={(e) => setTestEmail(e.target.value)}
            className="max-w-xs"
          />
          <select
            className="border rounded-md px-2 py-1.5 text-sm bg-background min-w-[12rem]"
            value={testCategory}
            onChange={(e) => setTestCategory(e.target.value)}
          >
            <option value={EVERYTHING}>Everything (general digest)</option>
            {beats.map((b) => (
              <option key={b.id} value={b.slug}>
                {b.name}
              </option>
            ))}
          </select>
          <Button onClick={handleTestFire} disabled={sendTest.isPending}>
            {sendTest.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Send className="h-4 w-4 mr-2" />
            )}
            Send test
          </Button>
        </div>
      </Card>

      {/* Custom broadcast: send a one-off branded message to every active
          subscriber. Uses the same template and unsubscribe link as the weekly
          newsletter, but with a fully custom subject and body. */}
      <Card className="p-5 space-y-3">
        <div>
          <h2 className="font-serif text-lg font-bold flex items-center gap-2">
            <Megaphone className="h-4 w-4" /> Broadcast to all subscribers
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Send a custom message to every active subscriber. Uses the same BrainHook branding
            and unsubscribe link as the newsletter. Blank lines become paragraph breaks.
          </p>
        </div>
        <div className="space-y-2">
          <Input
            placeholder="Subject line"
            value={broadcastSubject}
            onChange={(e) => setBroadcastSubject(e.target.value)}
            className="max-w-md"
          />
          <Textarea
            placeholder="Your message... (blank lines = new paragraphs)"
            value={broadcastBody}
            onChange={(e) => setBroadcastBody(e.target.value)}
            rows={6}
          />
        </div>
        <div className="flex justify-end">
          <Button
            onClick={async () => {
              const subject = broadcastSubject.trim();
              const body = broadcastBody.trim();
              if (!subject || !body) {
                toast.error("Enter a subject and message body.");
                return;
              }
              try {
                const res = await sendBroadcast.mutateAsync({ data: { subject, body } });
                if (res.started) {
                  if ((res.sent ?? 0) > 0) {
                    toast.success(`Broadcast sent to ${res.sent} subscriber${res.sent === 1 ? "" : "s"}.`);
                  } else {
                    toast.info("Broadcast started but no subscribers were emailed.");
                  }
                } else {
                  toast.error("Could not start broadcast — another one may be running.");
                }
              } catch (e) {
                const msg =
                  (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
                  "Failed to send broadcast";
                toast.error(msg);
              }
            }}
            disabled={sendBroadcast.isPending}
            variant="outline"
          >
            {sendBroadcast.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Megaphone className="h-4 w-4 mr-2" />
            )}
            Send broadcast
          </Button>
        </div>
      </Card>

      {/* Manual removal: paste bad/bounced/false addresses to suppress in bulk.
          Suppressed addresses are excluded from all sends and can't re-subscribe.
          Records are never deleted. Hard bounces & spam complaints are handled
          automatically by the Resend webhook; this is for everything else. */}
      <Card className="p-5 space-y-3">
        <div>
          <h2 className="font-serif text-lg font-bold flex items-center gap-2">
            <Ban className="h-4 w-4" /> Remove addresses
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Paste one or more addresses (commas, spaces, or new lines) to suppress them. They are
            excluded from every send and blocked from silently re-subscribing — nothing is deleted.
            Unknown addresses are pre-blocked. Bounces &amp; spam complaints are caught automatically.
          </p>
        </div>
        <Textarea
          placeholder={"bad@example.com\nfake@nowhere.test, another@bad.com"}
          value={removeInput}
          onChange={(e) => setRemoveInput(e.target.value)}
          rows={3}
          className="font-mono text-sm"
        />
        <div className="flex justify-end">
          <Button
            onClick={handleBulkRemove}
            disabled={removeSubscribers.isPending}
            variant="destructive"
          >
            {removeSubscribers.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <ShieldX className="h-4 w-4 mr-2" />
            )}
            Suppress addresses
          </Button>
        </div>
      </Card>

      {data.items.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">
          <Inbox className="h-8 w-8 mx-auto mb-2 opacity-40" />
          No active subscribers yet. They will appear here as readers sign up in the footer.
        </Card>
      ) : (
        <Card className="divide-y">
          <div className="flex items-center gap-4 px-4 py-2 text-xs uppercase tracking-wide text-muted-foreground">
            <span className="flex-1">Email</span>
            <span className="w-48 shrink-0">Newsletter choice</span>
            <span className="w-24 shrink-0 text-right">Joined</span>
            <span className="w-9 shrink-0" />
          </div>
          {data.items.map((s) => {
            const value = s.preferredCategory ?? EVERYTHING;
            const isPending = pendingEmail === s.email;
            return (
              <div key={s.email} className="flex items-center gap-4 px-4 py-3 text-sm">
                <span className="flex-1 font-medium truncate">{s.email}</span>
                <span className="w-48 shrink-0 flex items-center gap-2">
                  <select
                    className="border rounded-md px-2 py-1 text-sm bg-background w-full disabled:opacity-50"
                    value={value}
                    disabled={isPending}
                    onChange={(e) => handleChangeCategory(s.email, e.target.value)}
                  >
                    <option value={EVERYTHING}>Everything</option>
                    {beats.map((b) => (
                      <option key={b.id} value={b.slug}>
                        {b.name}
                      </option>
                    ))}
                    {/* A stored slug that no longer matches a beat still shows
                        so the admin can see/repair it. */}
                    {s.preferredCategory && !nameBySlug.has(s.preferredCategory) && (
                      <option value={s.preferredCategory}>{s.preferredCategory} (removed)</option>
                    )}
                  </select>
                  {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />}
                </span>
                <span className="w-24 shrink-0 text-right text-muted-foreground">
                  {format(new Date(s.createdAt), "MMM d, yyyy")}
                </span>
                <button
                  type="button"
                  title="Remove (suppress) this subscriber"
                  onClick={() => removeEmails([s.email], false)}
                  disabled={removeSubscribers.isPending}
                  className="w-9 shrink-0 flex items-center justify-center text-muted-foreground hover:text-destructive disabled:opacity-40"
                >
                  <ShieldX className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </Card>
      )}

      {/* Suppressed list — durable record of who was removed and why. Bounces and
          complaints land here automatically via the Resend webhook; manual
          removals show "Removed manually". */}
      {suppressed.length > 0 && (
        <div className="space-y-3">
          <div>
            <h2 className="font-serif text-xl font-bold">Suppressed</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              These addresses are excluded from every send and can't re-subscribe. Records are kept
              for audit — they are never deleted.
            </p>
          </div>
          <Card className="divide-y">
            <div className="flex items-center gap-4 px-4 py-2 text-xs uppercase tracking-wide text-muted-foreground">
              <span className="flex-1">Email</span>
              <span className="w-44 shrink-0">Reason</span>
              <span className="w-28 shrink-0 text-right">Suppressed</span>
            </div>
            {suppressed.map((s) => (
              <div key={s.email} className="flex items-center gap-4 px-4 py-3 text-sm">
                <span className="flex-1 font-medium truncate text-muted-foreground">{s.email}</span>
                <span className="w-44 shrink-0">
                  <span
                    className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${reasonClasses(s.suppressionReason)}`}
                  >
                    {reasonLabel(s.suppressionReason)}
                  </span>
                </span>
                <span className="w-28 shrink-0 text-right text-muted-foreground">
                  {s.suppressedAt ? format(new Date(s.suppressedAt), "MMM d, yyyy") : "—"}
                </span>
              </div>
            ))}
          </Card>
        </div>
      )}
    </div>
  );
}

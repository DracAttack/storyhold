import { useState } from "react";
import { useListAdminNotifications, useGetAdminNotification, getGetAdminNotificationQueryKey } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Loader2, Mail, Inbox } from "lucide-react";
import { format } from "date-fns";
import { Link } from "wouter";

export default function AdminNotifications() {
  const { data, isLoading } = useListAdminNotifications();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data: detail } = useGetAdminNotification(selectedId ?? "", {
    query: { enabled: !!selectedId, queryKey: getGetAdminNotificationQueryKey(selectedId ?? "") },
  });

  if (isLoading || !data) return <div className="p-4 md:p-8"><Loader2 className="animate-spin" /></div>;

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-serif text-3xl font-bold">Notifications</h1>
          <p className="text-muted-foreground mt-1">Daily digests generated after each pipeline run</p>
        </div>
        <Link href="/admin/settings" className="text-sm text-primary hover:underline">Settings →</Link>
      </div>

      {data.items.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">
          <Inbox className="h-8 w-8 mx-auto mb-2 opacity-40" />
          No digests yet. They will appear after the next daily pipeline run.
        </Card>
      ) : (
        <div className="grid grid-cols-12 gap-6">
          <div className="col-span-5 space-y-2">
            {data.items.map((n) => {
              const active = selectedId === n.id;
              return (
                <button
                  key={n.id}
                  onClick={() => setSelectedId(n.id)}
                  className={`w-full text-left p-4 rounded-md border transition ${active ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"}`}
                >
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Mail className="h-3 w-3" />
                    {format(new Date(n.createdAt), "MMM d, yyyy h:mm a")}
                  </div>
                  <div className="font-medium mt-1 text-sm">{n.subject}</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {n.payload.drafts.length} draft{n.payload.drafts.length === 1 ? "" : "s"} · {n.payload.pendingIdeas.length} pending idea{n.payload.pendingIdeas.length === 1 ? "" : "s"} · {n.recipients.length} recipient{n.recipients.length === 1 ? "" : "s"}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="col-span-7">
            {!selectedId ? (
              <Card className="p-10 text-center text-muted-foreground">Select a digest to preview.</Card>
            ) : !detail ? (
              <Card className="p-10"><Loader2 className="animate-spin mx-auto" /></Card>
            ) : (
              <Card className="p-0 overflow-hidden">
                <div className="p-4 border-b">
                  <div className="font-medium">{detail.subject}</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    To: {detail.recipients.length === 0 ? "(no enabled recipients)" : detail.recipients.join(", ")}
                  </div>
                </div>
                <iframe
                  title="digest preview"
                  srcDoc={detail.bodyHtml}
                  className="w-full bg-white"
                  style={{ height: 520, border: 0 }}
                />
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

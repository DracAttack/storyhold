import { useState } from "react";
import { Clock, Image as ImageIcon, Trash2, RotateCcw, Copy, AlertCircle, Pencil, Check, X, Loader2, CalendarClock } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useDeletePost, useRetryPost, useUpdatePost } from "@/hooks/api";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

interface Post {
  id: string;
  imageUrl: string;
  caption: string;
  scheduledAt?: string;
  timezone?: string;
  status: string;
  errorMessage?: string;
}

const EDITABLE_STATUSES = ["draft", "scheduling", "scheduled", "failed"];
const RESCHEDULABLE_STATUSES = ["draft", "scheduled", "failed"];
const DELETABLE_STATUSES = ["draft", "scheduling", "scheduled", "failed", "cancelled"];

// Convert a UTC instant to a "YYYY-MM-DDTHH:mm" wall-clock string in the given timezone
function toLocalInputValue(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}`;
}

export function PostCard({ post }: { post: Post }) {
  const deletePost = useDeletePost();
  const retryPost = useRetryPost();
  const updateCaption = useUpdatePost();
  const reschedulePost = useUpdatePost();

  const [isEditing, setIsEditing] = useState(false);
  const [editedCaption, setEditedCaption] = useState(post.caption || "");
  const [isRescheduling, setIsRescheduling] = useState(false);
  const [newTime, setNewTime] = useState("");

  const handleDelete = async () => {
    try {
      await deletePost.mutateAsync(post.id);
      toast.success("Post deleted");
    } catch (err: any) {
      toast.error(`Failed to delete: ${err.message}`);
    }
  };

  const handleRetry = async () => {
    try {
      await retryPost.mutateAsync(post.id);
      toast.success("Retrying post...");
    } catch (err: any) {
      toast.error(`Failed to retry: ${err.message}`);
    }
  };

  const startEditing = () => {
    setEditedCaption(post.caption || "");
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setEditedCaption(post.caption || "");
  };

  const saveCaption = async () => {
    try {
      await updateCaption.mutateAsync({ id: post.id, caption: editedCaption });
      setIsEditing(false);
      toast.success("Caption updated");
    } catch (err: any) {
      toast.error(`Failed to update caption: ${err.message}`);
    }
  };

  const copyCaption = () => {
    navigator.clipboard.writeText(post.caption || "");
    toast.success("Caption copied to clipboard");
  };

  const startRescheduling = () => {
    const tz = post.timezone || "America/Phoenix";
    setNewTime(post.scheduledAt ? toLocalInputValue(post.scheduledAt, tz) : "");
    setIsRescheduling(true);
  };

  const cancelRescheduling = () => {
    setIsRescheduling(false);
    setNewTime("");
  };

  const saveNewTime = async () => {
    if (!newTime) {
      toast.error("Pick a date and time first.");
      return;
    }
    try {
      await reschedulePost.mutateAsync({ id: post.id, scheduledAtLocal: newTime });
      setIsRescheduling(false);
      toast.success("Posting time updated");
    } catch (err: any) {
      toast.error(`Failed to reschedule: ${err.message}`);
    }
  };

  const getStatusBadge = () => {
    switch (post.status) {
      case "draft": return <Badge variant="secondary" className="bg-muted text-muted-foreground">Draft</Badge>;
      case "scheduling": return <Badge variant="secondary" className="bg-yellow-500/20 text-yellow-500 hover:bg-yellow-500/30">Scheduling</Badge>;
      case "scheduled": return <Badge variant="secondary" className="bg-primary/20 text-primary hover:bg-primary/30">Scheduled</Badge>;
      case "posted": return <Badge variant="secondary" className="bg-green-500/20 text-green-500 hover:bg-green-500/30">Posted</Badge>;
      case "failed": return <Badge variant="destructive" className="bg-destructive/20 text-destructive hover:bg-destructive/30">Failed</Badge>;
      case "cancelled": return <Badge variant="secondary" className="bg-muted text-muted-foreground">Cancelled</Badge>;
      default: return <Badge variant="outline">{post.status}</Badge>;
    }
  };

  const formattedDate = post.scheduledAt ? new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: post.timezone || 'UTC'
  }).format(new Date(post.scheduledAt)) : "Unscheduled";

  const canEdit = EDITABLE_STATUSES.includes(post.status);
  const canReschedule = RESCHEDULABLE_STATUSES.includes(post.status);
  const canDelete = DELETABLE_STATUSES.includes(post.status);

  return (
    <Card className="overflow-hidden bg-card border-border hover:border-border/80 transition-colors shadow-sm" data-testid={`card-post-${post.id}`}>
      <div className="flex flex-col sm:flex-row h-full">
        <div className="relative w-full sm:w-32 h-40 sm:h-auto bg-muted/50 border-r border-border">
          {post.imageUrl ? (
            <img src={post.imageUrl} alt="Post thumbnail" className="w-full h-full object-cover" loading="lazy" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-muted-foreground">
              <ImageIcon className="w-8 h-8 opacity-50" />
            </div>
          )}
        </div>

        <div className="flex-1 flex flex-col p-4">
          <div className="flex items-center justify-between mb-2 gap-4 flex-wrap">
            {getStatusBadge()}

            {isRescheduling ? (
              <div className="flex items-center gap-2 flex-wrap">
                <Input
                  type="datetime-local"
                  value={newTime}
                  onChange={(e) => setNewTime(e.target.value)}
                  className="h-8 w-auto text-xs bg-background"
                  data-testid={`input-reschedule-${post.id}`}
                />
                <Button variant="ghost" size="sm" onClick={cancelRescheduling} disabled={reschedulePost.isPending} className="text-xs h-8" data-testid={`btn-cancel-reschedule-${post.id}`}>
                  <X className="w-3.5 h-3.5" />
                </Button>
                <Button size="sm" onClick={saveNewTime} disabled={reschedulePost.isPending} className="text-xs h-8 bg-primary hover:bg-primary/90 text-primary-foreground" data-testid={`btn-save-reschedule-${post.id}`}>
                  {reschedulePost.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Check className="w-3.5 h-3.5 mr-1" />}
                  Save
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <div className="flex items-center text-xs text-muted-foreground font-mono">
                  <Clock className="w-3.5 h-3.5 mr-1.5" />
                  {formattedDate}
                </div>
                {canReschedule && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={startRescheduling}
                    className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                    title="Change posting time"
                    data-testid={`btn-reschedule-${post.id}`}
                  >
                    <CalendarClock className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
            )}
          </div>

          <div className="flex-1">
            {isEditing ? (
              <div className="flex flex-col gap-2">
                <Textarea
                  value={editedCaption}
                  onChange={(e) => setEditedCaption(e.target.value)}
                  className="resize-none min-h-[80px] border-input focus-visible:ring-primary bg-background text-sm"
                  placeholder="Write a caption..."
                  data-testid={`input-edit-caption-${post.id}`}
                />
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{editedCaption.length} characters</span>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" onClick={cancelEditing} disabled={updateCaption.isPending} className="text-xs h-7" data-testid={`btn-cancel-caption-${post.id}`}>
                      <X className="w-3.5 h-3.5 mr-1" /> Cancel
                    </Button>
                    <Button size="sm" onClick={saveCaption} disabled={updateCaption.isPending} className="text-xs h-7 bg-primary hover:bg-primary/90 text-primary-foreground" data-testid={`btn-save-caption-${post.id}`}>
                      {updateCaption.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Check className="w-3.5 h-3.5 mr-1" />}
                      Save
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-foreground/90 line-clamp-3 leading-relaxed" data-testid={`text-caption-${post.id}`}>
                {post.caption || <span className="text-muted-foreground italic">No caption provided.</span>}
              </p>
            )}
          </div>

          {post.errorMessage && post.status === 'failed' && (
            <div className="mt-3 text-xs p-2 rounded bg-destructive/10 text-destructive flex items-start">
              <AlertCircle className="w-3.5 h-3.5 mr-1.5 mt-0.5 shrink-0" />
              <span>{post.errorMessage}</span>
            </div>
          )}

          <div className="flex items-center justify-end mt-4 gap-2 pt-3 border-t border-border/50">
            <Button variant="ghost" size="sm" onClick={copyCaption} className="text-xs h-8 text-muted-foreground hover:text-foreground" data-testid={`btn-copy-${post.id}`}>
              <Copy className="w-3.5 h-3.5 mr-1.5" /> Copy
            </Button>

            {canEdit && !isEditing && (
              <Button variant="ghost" size="sm" onClick={startEditing} className="text-xs h-8 text-muted-foreground hover:text-foreground" data-testid={`btn-edit-caption-${post.id}`}>
                <Pencil className="w-3.5 h-3.5 mr-1.5" /> Edit
              </Button>
            )}

            {post.status === 'failed' && (
              <Button variant="outline" size="sm" onClick={handleRetry} className="text-xs h-8" data-testid={`btn-retry-${post.id}`}>
                <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Retry
              </Button>
            )}

            {canDelete && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-xs h-8 text-destructive hover:text-destructive hover:bg-destructive/10" data-testid={`btn-delete-${post.id}`}>
                    <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Delete
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete post?</AlertDialogTitle>
                    <AlertDialogDescription>
                      {post.status === 'scheduled'
                        ? "This will cancel the scheduled post on Zernio and permanently remove it from your queue."
                        : "This will permanently remove this post from your queue."}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleDelete} className="bg-destructive hover:bg-destructive/90 text-destructive-foreground">Delete</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

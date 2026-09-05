import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
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
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { runPremiumWorldReview } from "@/lib/storyholdApi";

export function WorldPremiumReviewButton(props: {
  worldId: string;
  disabled?: boolean;
  label?: string;
  className?: string;
  initialGuidance?: string;
  onStarted?: (runId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [guidance, setGuidance] = useState("");

  const start = async () => {
    if (starting || props.disabled) return;
    setStarting(true);
    try {
      const response = await runPremiumWorldReview(props.worldId, {
        guidance: guidance.trim(),
      });
      toast.success("Premium AI verification has started.");
      setOpen(false);
      props.onStarted?.(response.run.id);
    } catch (reason) {
      toast.error(
        reason instanceof Error
          ? reason.message
          : "Premium verification could not be started.",
      );
    } finally {
      setStarting(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className={props.className ?? "rounded-xl"}
        disabled={props.disabled || starting}
        onClick={() => {
          setGuidance(props.initialGuidance ?? "");
          setOpen(true);
        }}
      >
        {starting ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Sparkles className="mr-2 h-4 w-4" />
        )}
        {props.label ?? "Run premium AI verification"}
      </Button>

      <AlertDialog open={open} onOpenChange={(next) => !starting && setOpen(next)}>
        <AlertDialogContent className="border-primary/30 bg-[#111014] sm:max-w-xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif text-2xl">
              Run premium AI verification?
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3 text-sm leading-6">
              <span className="block">
                Your local Lorekeeper world is already saved and usable. This optional connected review rechecks the local findings against the source passages, deepens dossiers, and reconciles the world timeline.
              </span>
              <span className="block">
                Storyhold holds credits while the review runs. Unused held credits return automatically; higher actual usage may use additional available credits. You can leave it for later and keep using the locally built world.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="mt-1">
            <label htmlFor={`premium-guidance-${props.worldId}`} className="text-sm font-semibold">
              Optional direction for this review
            </label>
            <Textarea
              id={`premium-guidance-${props.worldId}`}
              className="mt-2 min-h-24 resize-y"
              value={guidance}
              onChange={(event) => setGuidance(event.target.value)}
              placeholder={'For example: “Echo is not Alec’s literal daughter. Recheck that relationship and every passage that describes it.”'}
              maxLength={4_000}
            />
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Storyhold saves this as an owner instruction and applies it to future reviews of this world.
            </p>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={starting}>Not now</AlertDialogCancel>
            <AlertDialogAction
              disabled={starting}
              onClick={(event) => {
                event.preventDefault();
                void start();
              }}
            >
              {starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Start premium review
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

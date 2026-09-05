import { useEffect, useState, type FormEvent } from "react";
import { Loader2, Shield } from "lucide-react";
import { toast } from "sonner";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import {
  registerStoryholdAccount,
  signInStoryholdAccount,
} from "@/lib/storyholdPublicApi";

export type AuthMode = "register" | "signin";

export function AccountDialog({
  open,
  mode,
  onOpenChange,
  onModeChange,
}: {
  open: boolean;
  mode: AuthMode;
  onOpenChange: (open: boolean) => void;
  onModeChange: (mode: AuthMode) => void;
}) {
  const auth = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setPassword("");
    setAcceptedTerms(false);
  }, [open, mode]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "register") {
        await registerStoryholdAccount({ displayName, email, password, acceptedTerms, termsVersion: "2026-08-23" });
      } else {
        await signInStoryholdAccount({ email, password });
      }
      await auth.refresh();
      onOpenChange(false);
      toast.success(
        mode === "register"
          ? "Your Storyhold account is ready."
          : "Welcome back to Storyhold.",
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "We could not finish that request.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden border-primary/20 bg-[#111014] p-0 sm:max-w-md sm:rounded-2xl">
        <div className="border-b border-white/8 bg-[radial-gradient(circle_at_top_right,rgba(56,189,248,0.18),transparent_45%)] px-7 py-6">
          <div className="mb-5 flex items-center gap-2 text-primary">
            <Shield className="h-5 w-5" />
            <span className="font-serif text-xl font-bold">Storyhold</span>
          </div>
          <DialogHeader>
            <DialogTitle className="font-serif text-3xl">
              {mode === "register"
                ? "Create your Storyhold account."
                : "Return to your worlds."}
            </DialogTitle>
            <DialogDescription className="mt-2 leading-6">
              {mode === "register"
                ? "Save your worlds, characters, and adventures. You will start with 40 credits."
                : "Sign in to continue your saved worlds and adventures."}
            </DialogDescription>
          </DialogHeader>
        </div>
        <form onSubmit={submit} className="space-y-4 px-7 pb-7">
          {mode === "register" ? (
            <div className="space-y-2">
              <Label htmlFor="storyhold-name">What should we call you?</Label>
              <Input
                id="storyhold-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Mara"
                autoComplete="name"
                maxLength={80}
              />
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="storyhold-email">Email</Label>
            <Input
              id="storyhold-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              required
            />
          </div>
          {mode === "register" ? <label className="flex items-start gap-3 rounded-xl border border-white/8 bg-black/20 p-3 text-xs leading-5 text-muted-foreground"><input type="checkbox" checked={acceptedTerms} onChange={(event) => setAcceptedTerms(event.target.checked)} required className="mt-0.5 h-4 w-4 shrink-0 accent-[hsl(var(--primary))]" /><span>I agree to the <Link href="/terms" target="_blank" className="font-semibold text-primary hover:underline">Terms of Use</Link> and acknowledge the <Link href="/privacy" target="_blank" className="font-semibold text-primary hover:underline">Privacy notice</Link>.</span></label> : null}
          <div className="space-y-2">
            <Label htmlFor="storyhold-password">Password</Label>
            <Input
              id="storyhold-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={mode === "register" ? "At least 8 characters" : "Your password"}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              minLength={8}
              maxLength={128}
              required
            />
          </div>
          {error ? (
            <p className="rounded-lg border border-red-400/20 bg-red-400/8 px-3 py-2 text-sm text-red-200">
              {error}
            </p>
          ) : null}
          <Button type="submit" className="h-11 w-full rounded-lg" disabled={busy || (mode === "register" && !acceptedTerms)}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {mode === "register" ? "Create free account" : "Sign in"}
          </Button>
          <button
            type="button"
            className="w-full text-sm text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => onModeChange(mode === "register" ? "signin" : "register")}
          >
            {mode === "register"
              ? "Already have an account? Sign in"
              : "New here? Create a free account"}
          </button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

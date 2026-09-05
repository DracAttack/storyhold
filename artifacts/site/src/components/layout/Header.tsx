import { Link } from "wouter";
import { Lock } from "lucide-react";
import brainMark from "@/assets/brainhook-mark.png";
import HeaderSearch from "@/components/layout/HeaderSearch";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useSubscribeNewsletter } from "@workspace/api-client-react";
import { useBeats } from "@/lib/useBeats";
import { markSubscribed } from "@/lib/subscription";

export default function Header() {
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [preferredCategory, setPreferredCategory] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const { email: signedInEmail } = useAuth();
  const isSignedIn = Boolean(signedInEmail);
  const { beats } = useBeats();
  const subscribe = useSubscribeNewsletter();

  const handleSubscribe = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || subscribe.isPending) return;
    subscribe.mutate(
      { data: { email: trimmed, website, preferredCategory: preferredCategory || undefined } },
      {
        onSuccess: (result) => {
          markSubscribed();
          toast.success(
            result.alreadySubscribed
              ? "You're already on the list. Welcome back to BrainHook."
              : "You're in. Welcome to BrainHook.",
          );
          setEmail("");
          setIsDialogOpen(false);
        },
        onError: () => {
          toast.error("Couldn't subscribe. Please check your email and try again.");
        },
      },
    );
  };

  return (
    <header className="sticky top-0 z-50 w-full border-b border-primary/10 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto px-4 h-16 flex items-center justify-between gap-4">
        {/* Logo: icon + "Brain" white / "Hook" amber — one word, two tones */}
        <Link
          href="/"
          className="flex items-center gap-2 font-serif font-bold tracking-tight shrink-0 hover:opacity-90 transition-opacity"
          style={{ fontSize: "clamp(20px, 2vw, 26px)", letterSpacing: "-0.02em" }}
        >
          <img src={brainMark} alt="" aria-hidden="true" width={28} height={28} className="h-7 w-7 select-none" />
          <span className="text-foreground">Brain<span className="text-primary">Hook</span></span>
        </Link>

        <div className="flex items-center gap-2">
          <HeaderSearch />
          {isSignedIn && (
            <Link
              href="/admin"
              className="inline-flex items-center gap-1.5 border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:border-primary hover:text-primary transition-colors"
              title={`Signed in as ${signedInEmail}`}
            >
              <Lock className="h-3.5 w-3.5" />
              Admin
            </Link>
          )}
          <Link
            href="/glossary"
            className="hidden sm:inline-flex items-center border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:border-primary hover:text-primary transition-colors"
          >
            Glossary
          </Link>
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="border-primary text-primary hover:bg-primary hover:text-primary-foreground font-semibold tracking-wide uppercase text-xs"
              >
                Subscribe
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Join BrainHook</DialogTitle>
                <DialogDescription>Real Research. No BS.</DialogDescription>
              </DialogHeader>
              <form onSubmit={handleSubscribe} className="flex flex-col gap-2 mt-4">
                <input
                  type="text"
                  name="website"
                  tabIndex={-1}
                  autoComplete="off"
                  aria-hidden="true"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  className="absolute left-[-9999px] h-0 w-0 opacity-0"
                  style={{ position: "absolute", left: "-9999px" }}
                />
                <select
                  value={preferredCategory}
                  onChange={(e) => setPreferredCategory(e.target.value)}
                  disabled={subscribe.isPending}
                  aria-label="Preferred subject"
                  className="flex h-9 w-full border border-input bg-background px-3 py-1 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="">Everything — surprise me</option>
                  {beats.map((b) => (
                    <option key={b.slug} value={b.slug}>{b.name}</option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <Input
                    type="email"
                    placeholder="Your email address"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={subscribe.isPending}
                    className="flex-1"
                    required
                  />
                  <Button type="submit" disabled={subscribe.isPending}>
                    {subscribe.isPending ? "Subscribing…" : "Subscribe"}
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </header>
  );
}

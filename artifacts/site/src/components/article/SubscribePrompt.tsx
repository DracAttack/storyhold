import { useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Link } from "wouter";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useSubscribeNewsletter } from "@workspace/api-client-react";
import { useBeats } from "@/lib/useBeats";
import { markSubscribed, markSubscribeToastDismissed } from "@/lib/subscription";

/**
 * Centered, article-blurring subscribe modal shown once per browsing session as
 * a reader gets into an article (see article.tsx). It's a compact echo of the
 * main NewsletterCTA box (cream-on-primary card, dotted pattern, same headline)
 * and adds a "preferred subject" selector so the reader can tailor what lands in
 * their inbox. Built on the Radix dialog primitive directly — rather than the
 * shared ui/dialog wrapper — so the overlay can blur ("fuzz") the page behind it
 * without changing the look of the Header's subscribe dialog. Radix gives us the
 * focus trap, Escape-to-close, scroll lock, and outside-click dismissal.
 */
export default function SubscribePrompt({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [preferredCategory, setPreferredCategory] = useState("");
  const { beats } = useBeats();
  const subscribe = useSubscribeNewsletter();
  // Tracks whether this close is the result of a successful signup, so that
  // closing the modal any other way (X / Escape / outside-click) is recorded as
  // a dismissal and suppresses the nudge for 30 days.
  const subscribedRef = useRef(false);

  const handleOpenChange = (next: boolean) => {
    if (!next && !subscribedRef.current) {
      markSubscribeToastDismissed();
    }
    onOpenChange(next);
  };

  const handleSubscribe = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || subscribe.isPending) return;
    subscribe.mutate(
      { data: { email: trimmed, website, preferredCategory: preferredCategory || undefined } },
      {
        onSuccess: (result) => {
          subscribedRef.current = true;
          markSubscribed();
          toast.success(
            result.alreadySubscribed
              ? "You're already on the list. Welcome back to BrainHook."
              : "You're in. Welcome to BrainHook.",
          );
          setEmail("");
          onOpenChange(false);
        },
        onError: () => {
          toast.error("Couldn't subscribe. Please check your email and try again.");
        },
      },
    );
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-foreground/40 backdrop-blur-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl bg-primary p-6 text-primary-foreground shadow-2xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:p-8"
        >
          <div
            className="pointer-events-none absolute inset-0 opacity-10"
            style={{
              backgroundImage: "radial-gradient(circle at 2px 2px, currentColor 1px, transparent 0)",
              backgroundSize: "24px 24px",
            }}
          />
          <DialogPrimitive.Close
            className="absolute right-3 top-3 z-20 rounded-full p-1.5 text-primary-foreground transition-colors hover:bg-primary-foreground/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </DialogPrimitive.Close>

          <div className="relative z-10 text-center">
            <DialogPrimitive.Title className="font-serif text-2xl font-bold sm:text-3xl">
              Brilliant ideas, delivered weekly.
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="mx-auto mt-3 mb-6 max-w-sm text-sm text-primary-foreground/80 sm:text-base">
              Join our family of curious minds getting BrainHook every week. Pick a subject and
              we'll tailor it to your inbox. No spam, ever.
            </DialogPrimitive.Description>

            <form onSubmit={handleSubscribe} className="flex flex-col gap-3 text-left">
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
              <Input
                type="email"
                placeholder="Your email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={subscribe.isPending}
                className="h-12 rounded-full border-0 bg-primary-foreground px-4 text-primary focus-visible:ring-2 focus-visible:ring-primary-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-primary"
                required
              />
              <select
                value={preferredCategory}
                onChange={(e) => setPreferredCategory(e.target.value)}
                disabled={subscribe.isPending}
                aria-label="Preferred subject"
                className="h-12 w-full rounded-full border-0 bg-primary-foreground px-4 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-primary"
              >
                <option value="">Everything — surprise me</option>
                {beats.map((b) => (
                  <option key={b.slug} value={b.slug}>
                    {b.name}
                  </option>
                ))}
              </select>
              <Button
                type="submit"
                variant="secondary"
                disabled={subscribe.isPending}
                className="h-12 rounded-full font-bold"
              >
                {subscribe.isPending ? "Subscribing…" : "Subscribe"}
              </Button>
            </form>

            <p className="mt-4 text-xs text-primary-foreground/60">
              By subscribing, you agree to our{" "}
              <Link href="/terms" className="underline hover:text-primary-foreground">
                Terms of Use
              </Link>{" "}
              and{" "}
              <Link href="/privacy" className="underline hover:text-primary-foreground">
                Privacy Policy
              </Link>
              .
            </p>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

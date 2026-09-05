import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUnsubscribeNewsletter } from "@workspace/api-client-react";
import { useSeo } from "@/lib/seo";
import { clearSubscribed } from "@/lib/subscription";

type Phase = "loading" | "done" | "error";

export default function UnsubscribePage() {
  useSeo({
    title: "Unsubscribe — BrainHook",
    description: "Manage your BrainHook newsletter subscription.",
    canonicalPath: "/unsubscribe",
    type: "website",
    noindex: true,
  });

  const unsubscribe = useUnsubscribeNewsletter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [email, setEmail] = useState<string | null>(null);
  const [alreadyOff, setAlreadyOff] = useState(false);
  // Run exactly once on mount — guards against React 18 StrictMode double-invoke.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const token = new URLSearchParams(window.location.search).get("token")?.trim();
    if (!token) {
      setPhase("error");
      return;
    }

    unsubscribe.mutate(
      { data: { token } },
      {
        onSuccess: (result) => {
          // This browser unsubscribed — let the in-article nudge return.
          clearSubscribed();
          setEmail(result.email ?? null);
          setAlreadyOff(Boolean(result.alreadyUnsubscribed));
          setPhase("done");
        },
        onError: () => setPhase("error"),
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="container mx-auto px-4 py-24 flex justify-center">
      <div className="w-full max-w-md text-center space-y-6">
        {phase === "loading" && (
          <>
            <Loader2 className="h-10 w-10 mx-auto animate-spin text-muted-foreground" />
            <p className="text-muted-foreground">Processing your request…</p>
          </>
        )}

        {phase === "done" && (
          <>
            <CheckCircle2 className="h-12 w-12 mx-auto text-primary" />
            <h1 className="font-serif text-3xl font-bold">
              {alreadyOff ? "You're already unsubscribed" : "You've been unsubscribed"}
            </h1>
            <p className="text-muted-foreground leading-relaxed">
              {email ? (
                <>
                  <span className="font-medium text-foreground">{email}</span> will no longer
                  receive newsletter emails from BrainHook.
                </>
              ) : (
                <>You will no longer receive newsletter emails from BrainHook.</>
              )}{" "}
              We're sorry to see you go — you can resubscribe anytime from the footer.
            </p>
            <Button asChild>
              <Link href="/">Back to BrainHook</Link>
            </Button>
          </>
        )}

        {phase === "error" && (
          <>
            <AlertCircle className="h-12 w-12 mx-auto text-destructive" />
            <h1 className="font-serif text-3xl font-bold">This link didn't work</h1>
            <p className="text-muted-foreground leading-relaxed">
              The unsubscribe link is missing or invalid. It may have already been used, or the
              address was copied incompletely. If you keep getting our emails, reply to one and
              we'll remove you.
            </p>
            <Button asChild variant="outline">
              <Link href="/">Back to BrainHook</Link>
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

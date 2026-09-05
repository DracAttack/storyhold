import { Link } from "wouter";
import { Rss } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useBeats } from "@/lib/useBeats";
import { useSubscribeNewsletter } from "@workspace/api-client-react";
import { markSubscribed } from "@/lib/subscription";
import { openPrivacyChoices } from "@/lib/consent";

export default function Footer() {
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [preferredCategory, setPreferredCategory] = useState("");
  const { beats } = useBeats();
  const subscribe = useSubscribeNewsletter();

  const handleManageChoices = async () => {
    const shown = await openPrivacyChoices();
    if (!shown) {
      toast("Consent options aren't available here", {
        description:
          "The consent message applies in the EEA, UK, and Switzerland. You can still opt out of personalized ads via Google Ads Settings and aboutads.info/choices.",
      });
    }
  };

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
        },
        onError: () => {
          toast.error("Couldn't subscribe. Please check your email and try again.");
        },
      },
    );
  };

  return (
    <footer className="bg-card text-card-foreground border-t mt-auto">
      <div className="container mx-auto px-4 py-12 md:py-16 max-md:pl-9">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-12 lg:gap-24">
          <div className="space-y-6">
            <div>
              <Link href="/" className="font-serif text-2xl font-bold tracking-tight text-primary">BrainHook</Link>
              <p className="mt-4 text-muted-foreground text-sm leading-relaxed max-w-sm">Exploring the universe within and without. Real research without the clickbait.</p>
            </div>
            <div className="flex gap-4">
              <a
                href="/rss.xml"
                target="_blank"
                rel="noopener noreferrer"
                title="RSS feed"
                aria-label="RSS feed"
                className="text-muted-foreground hover:text-primary inline-flex items-center gap-2 text-sm"
              >
                <Rss className="h-5 w-5" />
                <span>RSS</span>
              </a>
            </div>
            <div>
              <h3 className="font-serif font-semibold text-lg mb-4">Company</h3>
              <ul className="space-y-3">
                <li><Link href="/contact" className="text-muted-foreground hover:text-primary text-sm">Contact</Link></li>
                <li><Link href="/about" className="text-muted-foreground hover:text-primary text-sm">About Us</Link></li>
                <li><Link href="/glossary" className="text-muted-foreground hover:text-primary text-sm">Glossary</Link></li>
                <li><Link href="/editorial-policy" className="text-muted-foreground hover:text-primary text-sm">Editorial Policy</Link></li>
                <li><Link href="/corrections" className="text-muted-foreground hover:text-primary text-sm">Corrections Policy</Link></li>
                <li><Link href="/privacy" className="text-muted-foreground hover:text-primary text-sm">Privacy Policy</Link></li>
                <li><Link href="/terms" className="text-muted-foreground hover:text-primary text-sm">Terms of Use</Link></li>
              </ul>
            </div>
          </div>
          <div>
            <h3 className="font-serif font-semibold text-lg mb-4">Categories</h3>
            <ul className="space-y-3">
              {beats.map((c) => (
                <li key={c.slug}><Link href={`/category/${c.slug}`} className="text-muted-foreground hover:text-primary text-sm">{c.name}</Link></li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="font-serif font-semibold text-lg mb-4">Subscribe</h3>
            <p className="text-muted-foreground text-sm mb-4">Get our best stories delivered to your inbox every week.</p>
            <form onSubmit={handleSubscribe} className="flex flex-col gap-2">
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
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">Everything — surprise me</option>
                {beats.map((b) => (
                  <option key={b.slug} value={b.slug}>{b.name}</option>
                ))}
              </select>
              <div className="flex flex-col sm:flex-row gap-2">
                <Input type="email" placeholder="Email address" value={email} onChange={(e) => setEmail(e.target.value)} disabled={subscribe.isPending} className="bg-background" required />
                <Button type="submit" className="shrink-0" disabled={subscribe.isPending}>{subscribe.isPending ? "Subscribing…" : "Subscribe"}</Button>
              </div>
            </form>
          </div>
        </div>
        <div className="mt-16 pt-8 border-t border-border flex flex-col md:flex-row items-center justify-between gap-4 text-xs text-muted-foreground">
          <p>© {new Date().getFullYear()} Brainhook Media · Phoenix, AZ, USA. All rights reserved.</p>
          <div className="flex flex-col sm:flex-row items-center gap-3 sm:gap-4">
            <button
              type="button"
              onClick={handleManageChoices}
              className="hover:text-primary underline-offset-4 hover:underline"
            >
              Manage privacy choices
            </button>
            <a href="mailto:editor@brainhook.net" className="hover:text-primary">editor@brainhook.net</a>
          </div>
        </div>
      </div>
    </footer>
  );
}

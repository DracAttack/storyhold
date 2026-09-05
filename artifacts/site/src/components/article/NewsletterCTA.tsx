import { useState } from "react";
import { Link } from "wouter";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { useSubscribeNewsletter } from "@workspace/api-client-react";
import { useBeats } from "@/lib/useBeats";
import { markSubscribed } from "@/lib/subscription";

export default function NewsletterCTA() {
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [preferredCategory, setPreferredCategory] = useState("");
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
        },
        onError: () => {
          toast.error("Couldn't subscribe. Please check your email and try again.");
        },
      },
    );
  };

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      className="bg-primary text-primary-foreground rounded-2xl p-8 md:p-12 lg:p-16 my-16 text-center max-w-4xl mx-auto overflow-hidden relative"
    >
      <div className="absolute inset-0 opacity-10 pointer-events-none" style={{ backgroundImage: 'radial-gradient(circle at 2px 2px, currentColor 1px, transparent 0)', backgroundSize: '24px 24px' }}></div>
      <div className="relative z-10">
        <h2 className="font-serif text-3xl md:text-4xl font-bold mb-4">Brilliant ideas, delivered weekly.</h2>
        <p className="text-primary-foreground/80 max-w-xl mx-auto mb-8 text-lg">
          Join our family of curious minds who receive our top stories, exclusive insights, and editorial updates every Sunday morning. No spam, ever.
        </p>
        <form onSubmit={handleSubscribe} className="flex flex-col gap-3 max-w-md mx-auto">
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
            className="bg-primary-foreground text-primary h-12 px-4 rounded-full border-0 w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-primary"
          >
            <option value="">Everything — surprise me</option>
            {beats.map((b) => (
              <option key={b.slug} value={b.slug}>{b.name}</option>
            ))}
          </select>
          <div className="flex flex-col sm:flex-row gap-3">
            <Input
              type="email"
              placeholder="Your email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={subscribe.isPending}
              className="bg-primary-foreground text-primary h-12 px-4 rounded-full border-0 focus-visible:ring-2 focus-visible:ring-primary-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-primary"
              required
            />
            <Button type="submit" variant="secondary" disabled={subscribe.isPending} className="h-12 px-8 rounded-full font-bold">
              {subscribe.isPending ? "Subscribing…" : "Subscribe"}
            </Button>
          </div>
        </form>
        <p className="text-primary-foreground/60 text-xs mt-4">
          By subscribing, you agree to our{" "}
          <Link href="/terms" className="underline hover:text-primary-foreground">Terms of Use</Link>{" "}
          and{" "}
          <Link href="/privacy" className="underline hover:text-primary-foreground">Privacy Policy</Link>.
        </p>
      </div>
    </motion.div>
  );
}
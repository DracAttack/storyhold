import { useEffect, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  Coins,
  LogOut,
  Sparkles,
  Upload,
  UserRound,
} from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ProfileFrame } from "@/components/customer/profile-frame";
import { StoryPreferencesCard } from "@/components/customer/story-preferences";
import { BrowserIntelligenceCard } from "@/components/customer/browser-intelligence-card";
import { useAuth } from "@/lib/auth";
import { useSeo } from "@/lib/seo";
import { listWorlds } from "@/lib/storyholdApi";

export default function Profile() {
  const auth = useAuth();
  const [worldCount, setWorldCount] = useState(0);

  useSeo({
    title: "Your profile",
    description: "Your private Storyhold account.",
    canonicalPath: "/profile",
    noindex: true,
  });

  useEffect(() => {
    if (!auth.email) return;
    let active = true;
    void listWorlds()
      .then((response) => {
        if (active) setWorldCount(response.worlds.length);
      })
      .catch(() => {
        if (active) setWorldCount(0);
      });
    return () => {
      active = false;
    };
  }, [auth.email]);

  return (
    <ProfileFrame>
      <section>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">
          Your Storyhold
        </p>
        <h1 className="mt-3 font-serif text-4xl font-bold tracking-tight sm:text-5xl">
          Welcome back, {auth.displayName || "traveler"}.
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground">
          Your worlds, writing, and credits stay together here.
        </p>
      </section>

      <div className="mt-9 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Card className="rounded-2xl border-primary/25 bg-primary/[0.055] p-5">
          <BookOpen className="h-5 w-5 text-primary" />
          <p className="mt-5 text-sm text-muted-foreground">Saved worlds</p>
          <p className="mt-1 font-serif text-4xl font-bold">{worldCount}</p>
          <Link href="/profile/worlds" className="mt-5 inline-flex items-center text-sm font-semibold text-primary">
            Open my worlds <ArrowRight className="ml-1.5 h-4 w-4" />
          </Link>
        </Card>
        <Card className="rounded-2xl border-white/8 bg-white/[0.025] p-5">
          <Coins className="h-5 w-5 text-primary" />
          <p className="mt-5 text-sm text-muted-foreground">Available credits</p>
          <p className="mt-1 font-serif text-4xl font-bold">
            {auth.unlimitedCredits ? "Unlimited" : auth.credits}
          </p>
          <Link href="/credits" className="mt-5 inline-flex items-center text-sm font-semibold text-primary">
            View credit options <ArrowRight className="ml-1.5 h-4 w-4" />
          </Link>
        </Card>
        <Card className="rounded-2xl border-white/8 bg-white/[0.025] p-5 sm:col-span-2 xl:col-span-1">
          <Upload className="h-5 w-5 text-primary" />
          <p className="mt-5 font-serif text-2xl font-bold">Bring in your writing</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Turn a book, draft, or setting guide into a world you can explore.
          </p>
          <Link href="/profile/import" className="mt-5 inline-flex items-center text-sm font-semibold text-primary">
            Import a world <ArrowRight className="ml-1.5 h-4 w-4" />
          </Link>
        </Card>
      </div>

      <div className="mt-8">
        <StoryPreferencesCard />
      </div>

      <div className="mt-8">
        <BrowserIntelligenceCard />
      </div>

      <div className="mt-8 grid gap-5 lg:grid-cols-[1.25fr_0.75fr]">
        <Card className="rounded-3xl border-white/8 bg-[#121115] p-6">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
              <Sparkles className="h-5 w-5" />
            </span>
            <div>
              <h2 className="font-serif text-2xl font-bold">Choose Your Next Step</h2>
              <p className="text-sm text-muted-foreground">Start fresh or return to something familiar.</p>
            </div>
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <Button asChild className="h-auto min-h-12 w-full justify-start rounded-xl px-4 py-3">
              <Link href="/play">
                <Sparkles className="mr-2 h-4 w-4" /> Try a new scene
              </Link>
            </Button>
            <Button asChild variant="outline" className="h-auto min-h-12 w-full justify-start rounded-xl px-4 py-3">
              <Link href="/profile/worlds">
                <BookOpen className="mr-2 h-4 w-4" /> Return to my worlds
              </Link>
            </Button>
          </div>
        </Card>

        <Card className="rounded-3xl border-white/8 bg-white/[0.025] p-6">
          <div className="flex items-center gap-3">
            <UserRound className="h-5 w-5 text-primary" />
            <h2 className="font-serif text-2xl font-bold">Account</h2>
          </div>
          <p className="mt-5 truncate text-sm font-semibold">{auth.email}</p>
          <Button
            variant="ghost"
            className="mt-5 w-full justify-start rounded-xl text-muted-foreground"
            onClick={() => void auth.signOut()}
          >
            <LogOut className="mr-2 h-4 w-4" /> Sign out
          </Button>
        </Card>
      </div>
    </ProfileFrame>
  );
}

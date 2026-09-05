import {
  ArrowRight,
  BookOpen,
  Check,
  Compass,
  Drama,
  Feather,
  Globe2,
  Orbit,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useCustomerAccount } from "@/components/customer/customer-shell";
import { useAuth } from "@/lib/auth";
import { useSeo } from "@/lib/seo";
import { toChicagoTitleCase } from "@/lib/utils";
import { FEATURED_SCENARIO_IDS, findStoryholdScenario } from "@/lib/storyholdScenarios";

const OPENINGS_META = {
  "erased-name": {
    icon: Drama,
    image: "/world-dark-fantasy.webp",
    imageAlt: "A golden citadel rising above a sea of clouds",
  },
  "company-found-something": {
    icon: Orbit,
    image: "/world-corporate-horror.webp",
    imageAlt: "A rain-soaked corporate megacity beneath an immense spacecraft",
  },
  "impossible-number": {
    icon: Feather,
    image: "/world-everyday-mystery.webp",
    imageAlt: "A lamplit accounting office overlooking a rainy small town",
  },
} satisfies Record<
  (typeof FEATURED_SCENARIO_IDS)[number],
  { icon: typeof Drama; image: string; imageAlt: string }
>;

const openings = FEATURED_SCENARIO_IDS.map((id) => {
  const scenario = findStoryholdScenario(id);
  if (!scenario) throw new Error(`Missing featured scenario: ${id}`);
  const meta = OPENINGS_META[id];
  return {
    ...scenario,
    ...meta,
  };
});

export default function Home() {
  const auth = useAuth();
  const { openAccount } = useCustomerAccount();

  useSeo({
    title: "Storyhold — Worlds that remember",
    description:
      "Create any world, become any character, and play stories where choices remain meaningful.",
    canonicalPath: "/",
    type: "website",
  });

  return (
    <main>
      <section className="relative isolate min-h-[690px] overflow-hidden border-b border-white/10">
        <img
          src="/storyhold-library-hero-v2.webp"
          alt="A vast shadowed library lit by moonlight and amber lamps"
          className="absolute inset-0 -z-30 h-full w-full object-cover object-center"
        />
        <div className="absolute inset-0 -z-20 bg-[linear-gradient(90deg,rgba(7,7,10,0.68),rgba(7,7,10,0.28)_55%,rgba(7,7,10,0.42)),linear-gradient(0deg,#0c0b0e_0%,transparent_30%,rgba(7,7,10,0.18)_100%)]" />
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_52%_42%,transparent_0%,rgba(5,5,7,0.07)_58%,rgba(5,5,7,0.3)_100%)]" />

        <div className="mx-auto flex min-h-[690px] max-w-7xl items-center px-4 py-24 sm:px-6 lg:px-8">
          <div className="max-w-4xl">
            <div className="mb-7 inline-flex items-center gap-2 border border-primary/35 bg-[#17130d]/80 px-4 py-2 text-xs font-bold uppercase tracking-[0.2em] text-primary shadow-[0_8px_35px_rgba(0,0,0,0.35)] backdrop-blur-md">
              <Sparkles className="h-3.5 w-3.5" /> Where Stories Become Living Worlds
            </div>
            <h1 className="max-w-4xl font-serif text-5xl font-semibold uppercase leading-[0.92] tracking-[-0.035em] text-[#f6f1e7] drop-shadow-[0_3px_20px_rgba(0,0,0,0.75)] sm:text-7xl lg:text-[5.8rem]">
              Enter Any World.
              <span className="mt-2 block text-primary">Live a Story That Remembers.</span>
            </h1>
            <p className="mt-7 max-w-2xl text-lg leading-8 text-[#d0cbc2] drop-shadow-md sm:text-xl">
              Begin with one sentence or bring an entire universe. Become anyone,
              make consequential choices, and keep playing after other AI stories
              would have forgotten the plot.
            </p>
            <div className="mt-10 flex flex-col gap-3 sm:flex-row">
              <Button
                asChild
                className="h-13 w-full px-7 text-base font-bold shadow-[0_12px_40px_rgba(56,189,248,0.24)] sm:w-auto"
              >
                <Link href="/play">
                  Begin your journey <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              {auth.email ? (
                <Button
                  asChild
                  variant="outline"
                  className="h-13 w-full border-white/30 bg-black/25 px-7 text-base backdrop-blur-md sm:w-auto"
                >
                  <Link href="/profile/import">
                    <BookOpen className="mr-2 h-4 w-4" /> Bring your world
                  </Link>
                </Button>
              ) : (
                <Button
                  variant="outline"
                  className="h-13 border-white/30 bg-black/25 px-7 text-base backdrop-blur-md"
                  onClick={() => openAccount("register")}
                >
                  <BookOpen className="mr-2 h-4 w-4" /> Create free account
                </Button>
              )}
            </div>
            <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-xs font-semibold uppercase tracking-[0.13em] text-[#aaa49b]">
              {["Any Genre", "Rules Optional", "Persistent Worlds"].map((item) => (
                <span key={item} className="flex items-center gap-2">
                  <Check className="h-3.5 w-3.5 text-primary" /> {item}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-white/8 bg-[#0b0a0f] py-20 sm:py-24">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-3xl text-center">
            <p className="text-xs font-bold uppercase tracking-[0.24em] text-primary">
              Choose Your First Door
            </p>
            <h2 className="mt-4 font-serif text-4xl font-semibold uppercase tracking-[-0.025em] sm:text-5xl">
              No Prescribed World. No Prescribed Role.
            </h2>
            <p className="mt-5 text-base leading-7 text-muted-foreground">
              These are only sparks. Storyhold can begin anywhere your imagination does.
            </p>
          </div>

          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {openings.map((opening) => (
              <Card
                key={opening.id}
                className="group relative isolate min-h-[410px] overflow-hidden border-white/10 bg-[#111015] p-0 shadow-[0_18px_55px_rgba(0,0,0,0.22)] hover:border-[#b285ff]/35 transition-colors"
              >
                <img
                  src={opening.image}
                  alt={opening.imageAlt}
                  loading="lazy"
                  className="absolute inset-x-0 top-0 -z-20 h-[58%] w-full object-cover saturate-[1.08] contrast-[1.03] transition-transform duration-700 group-hover:scale-[1.035]"
                />
                <div className="absolute inset-0 -z-10 bg-[linear-gradient(to_bottom,transparent_24%,rgba(8,8,11,0.2)_46%,#111015_61%)]" />
                <div className="flex h-full min-h-[410px] flex-col p-7">
                  <div className="flex items-center justify-between">
                    <span className="border border-white/20 bg-black/55 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-white/85 backdrop-blur-sm">
                      {toChicagoTitleCase(opening.genre)}
                    </span>
                    <span className="grid h-9 w-9 place-items-center rounded-full border border-white/15 bg-black/45 text-white/70 backdrop-blur-sm">
                      <opening.icon className="h-5 w-5" />
                    </span>
                  </div>
                  <div className="mt-auto pt-32">
                    <h3 className="font-serif text-3xl font-semibold uppercase leading-[1.02] text-[#f4efe5]">
                      {toChicagoTitleCase(opening.title)}
                    </h3>
                    <p className="mt-4 text-sm leading-6 text-muted-foreground">
                      {opening.premise}
                    </p>
                    <Link
                      href={`/profile/import?mode=idea&scenario=${opening.id}`}
                      className="mt-7 inline-flex min-h-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.035] px-4 text-sm font-bold text-[#e9dfca] transition-all duration-300 hover:border-violet-300/45 hover:bg-violet-400/20 hover:text-violet-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300/70"
                    >
                      Start from Here <ArrowRight className="ml-2 h-4 w-4" />
                    </Link>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section className="border-b border-white/8 bg-[#0f0e12] py-20 sm:py-24">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-3xl text-center">
            <p className="text-xs font-bold uppercase tracking-[0.24em] text-primary">
              Why Storyhold Works
            </p>
            <h2 className="mt-4 font-serif text-4xl font-semibold uppercase tracking-[-0.025em] sm:text-5xl">
              The World Keeps Up with You.
            </h2>
            <p className="mt-5 text-base leading-7 text-muted-foreground">
              Settle into a character and keep playing without explaining the past again every ten minutes.
            </p>
          </div>
          <div className="mt-12 grid gap-px overflow-hidden border border-white/10 bg-white/10 md:grid-cols-3">
            {[
              [
                BookOpen,
                "It remembers what matters",
                "People remember what you said. Places keep the marks you left. Old decisions return when they should.",
              ],
              [
                ShieldCheck,
                "Your beginning means something",
                "Who you are at the start remains meaningful. Growth is earned inside the story, not granted mid-scene.",
              ],
              [
                Compass,
                "It follows the story anywhere",
                "Epic quests, tense negotiations, quiet relationships, workplace drama, and everything between them.",
              ],
            ].map(([Icon, title, copy]) => {
              const FeatureIcon = Icon as typeof BookOpen;
              return (
                <div key={String(title)} className="bg-[#111015] p-7 sm:p-8">
                  <FeatureIcon className="h-7 w-7 text-primary" />
                  <h3 className="mt-6 font-serif text-2xl font-semibold uppercase leading-tight">
                    {toChicagoTitleCase(String(title))}
                  </h3>
                  <p className="mt-4 text-sm leading-6 text-muted-foreground">{String(copy)}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="py-20 sm:py-24">
        <div className="mx-auto grid max-w-7xl gap-10 px-4 sm:px-6 lg:grid-cols-[0.85fr_1.15fr] lg:items-center lg:px-8">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.24em] text-primary">
              Your Worlds, Your Way
            </p>
            <h2 className="mt-4 font-serif text-4xl font-semibold uppercase tracking-[-0.025em] sm:text-5xl">
              Begin from Nothing. Or Bring Everything.
            </h2>
            <p className="mt-5 text-base leading-7 text-muted-foreground">
              Describe a premise and step inside, or turn your novels, drafts, and setting guides into a world you can explore from any point of view.
            </p>
            <Button asChild variant="outline" className="mt-8 h-12 px-6">
              <Link href={auth.email ? "/profile/import" : "/profile"}>
                {auth.email ? "Import my writing" : "See what an account includes"}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card className="border-primary/25 bg-[linear-gradient(145deg,rgba(56,189,248,0.1),rgba(34,197,94,0.025))] p-7 sm:translate-y-5">
              <Globe2 className="h-7 w-7 text-primary" />
              <h3 className="mt-6 font-serif text-3xl font-semibold uppercase">Make a New World</h3>
              <p className="mt-4 text-sm leading-6 text-muted-foreground">
                Give Storyhold a genre, a role, and a problem. Let the rest reveal itself as you play.
              </p>
            </Card>
            <Card className="border-white/10 bg-white/[0.025] p-7">
              <BookOpen className="h-7 w-7 text-primary" />
              <h3 className="mt-6 font-serif text-3xl font-semibold uppercase">Enter Your Own Fiction</h3>
              <p className="mt-4 text-sm leading-6 text-muted-foreground">
                Bring finished books or works in progress, then explore what happens next.
              </p>
            </Card>
          </div>
        </div>
      </section>

      <section className="relative overflow-hidden border-t border-white/8 bg-[#0b0a0f] py-24">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(56,189,248,0.12),transparent_48%)]" />
        <div className="relative mx-auto max-w-3xl px-4 text-center sm:px-6">
          <BookOpen className="mx-auto h-11 w-11 text-primary" />
          <h2 className="mt-6 font-serif text-4xl font-semibold uppercase sm:text-5xl">
            Your Next World Is Waiting.
          </h2>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-7 text-muted-foreground">
            One sentence is enough. A whole universe is welcome.
          </p>
          <Button asChild className="mt-9 h-12 px-7 text-base font-bold">
            <Link href="/play">
              Try Storyhold <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </section>
    </main>
  );
}

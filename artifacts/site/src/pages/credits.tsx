import { ChevronDown, Coins, ShieldCheck, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useCustomerAccount } from "@/components/customer/customer-shell";
import { useAuth } from "@/lib/auth";
import { useSeo } from "@/lib/seo";

const packages = [
  {
    name: "Spark",
    credits: 250,
    price: "$5",
    copy: "For a handful of focused scenes or a smaller world.",
    estimate: "About 15-40 standard scenes",
  },
  {
    name: "Chronicle",
    credits: 900,
    price: "$18",
    copy: "For a serious story arc with room to wander.",
    estimate: "About 55-140 standard scenes",
    featured: true,
  },
  {
    name: "Saga",
    credits: 1_750,
    price: "$35",
    copy: "For long campaigns and substantial imported worlds.",
    estimate: "About 110-275 standard scenes",
  },
];

export default function Credits() {
  const auth = useAuth();
  const { openAccount } = useCustomerAccount();
  useSeo({
    title: "Credits",
    description: "Add Storyhold credits to keep your worlds and adventures moving.",
    canonicalPath: "/credits",
  });

  const choosePackage = (name: string) => {
    if (!auth.email) {
      openAccount("register");
      return;
    }
    toast.info(`${name} checkout is disabled in this local test build.`);
  };

  return (
    <main>
      <section className="relative overflow-hidden border-b border-white/8 py-10 sm:py-12">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(56,189,248,0.14),transparent_48%)]" />
        <div className="relative mx-auto max-w-3xl px-4 text-center sm:px-6">
          <Coins className="mx-auto h-8 w-8 text-primary" />
          <h1 className="mt-4 font-serif text-4xl font-bold sm:text-5xl">Stay While the Story Earns It.</h1>
          <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
            Start free. Short scenes stay light; longer scenes, deeper reasoning, and full-world reading use more credits.
          </p>
          {auth.email ? (
            <div className="mx-auto mt-5 flex max-w-md items-center justify-between rounded-2xl border border-primary/25 bg-primary/[0.07] px-4 py-3 text-left">
              <div>
                <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground">
                  {auth.displayName || auth.email}
                </p>
                <p className="mt-1 font-semibold">Your Account Balance</p>
              </div>
              <div className="font-serif text-3xl font-bold text-primary">
                {auth.unlimitedCredits ? "Unlimited" : auth.credits}
              </div>
            </div>
          ) : (
            <Button className="mt-7 rounded-xl" onClick={() => openAccount("register")}>
              Create an account with 40 credits
            </Button>
          )}
        </div>
      </section>

      <section className="bg-[#0f0e11]/70 py-10 sm:py-12">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mx-auto flex max-w-2xl flex-col items-center text-center">
            <Badge variant="outline" className="border-primary/25 text-primary">
              Preview packages
            </Badge>
            <h2 className="mt-3 font-serif text-3xl font-bold">Choose How Far You Want to Go.</h2>
          </div>
          <div className="mx-auto mt-6 grid max-w-5xl gap-3 md:grid-cols-3">
            {packages.map((pack) => (
              <Card
                key={pack.name}
                className={`relative rounded-2xl p-5 ${
                  pack.featured
                    ? "border-primary/45 bg-primary/[0.06]"
                    : "border-white/8 bg-white/[0.025]"
                }`}
              >
                {pack.featured ? (
                  <Badge className="absolute right-5 top-5">Most popular</Badge>
                ) : null}
                <p className="text-sm font-semibold text-muted-foreground">{pack.name}</p>
                <div className="mt-4 flex items-end gap-2">
                  <span className="font-serif text-4xl font-bold">
                    {new Intl.NumberFormat().format(pack.credits)}
                  </span>
                  <span className="pb-1 text-sm text-muted-foreground">credits</span>
                </div>
                <p className="mt-2 text-2xl font-semibold text-primary">{pack.price}</p>
                <p className="mt-3 text-sm leading-5 text-muted-foreground">
                  {pack.copy}
                </p>
                <p className="mt-3 text-xs font-semibold text-foreground/80">{pack.estimate}</p>
                <Button
                  variant={pack.featured ? "default" : "outline"}
                  className="mt-4 w-full rounded-xl"
                  onClick={() => choosePackage(pack.name)}
                >
                  {auth.email ? `Choose ${pack.name}` : "Create account"}
                </Button>
              </Card>
            ))}
          </div>
          <p className="mx-auto mt-5 max-w-3xl text-center text-xs leading-5 text-muted-foreground">Scene estimates are a planning range, not a promise. Longer replies, deeper reasoning, large-world recall, and manuscript analysis use more credits; brief scenes use fewer.</p>
          <details className="group mx-auto mt-5 max-w-4xl rounded-2xl border border-white/8 bg-black/15">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold"><span>How credits and Canon Intake work</span><ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" /></summary>
            <div className="grid gap-3 border-t border-white/8 p-4 sm:grid-cols-2">
            <div className="flex gap-3 rounded-xl bg-black/15 p-3">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <div>
                <p className="text-sm font-semibold">Your Balance Follows Your Account</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Credits are used automatically as Storyhold completes work. Canon Intake saves each completed stage, so a paused or resumed intake does not charge again for work already finished.
                </p>
              </div>
            </div>
            <div className="flex gap-3 rounded-xl bg-black/15 p-3">
              <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <div>
                <p className="text-sm font-semibold">Canon Intake and Purchases</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  A 150,000-word world intake uses 250 credits. One intake can contain up to 250,000 words. Add more credits whenever you want to continue; purchases are disabled in this preview.
                </p>
                <p className="mt-2 text-xs">Read the <Link href="/credit-terms" className="font-semibold text-primary hover:underline">Credits and Intake Policy</Link> and <Link href="/refunds" className="font-semibold text-primary hover:underline">Refund Policy</Link>.</p>
              </div>
            </div>
            </div>
          </details>
        </div>
      </section>
    </main>
  );
}

import type { ReactNode } from "react";
import { BookOpen, Coins, Loader2, LogIn, Upload, UserRound } from "lucide-react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { useCustomerAccount } from "./customer-shell";

const profileNavigation = [
  { href: "/profile", label: "Overview", icon: UserRound },
  { href: "/profile/worlds", label: "My Worlds", icon: BookOpen },
  { href: "/profile/import", label: "Create or Import", icon: Upload },
];

export function ProfileFrame({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [location] = useLocation();
  const { openAccount } = useCustomerAccount();

  if (!auth.isLoaded) {
    return (
      <main className="grid min-h-[65vh] place-items-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </main>
    );
  }

  if (!auth.email) {
    return (
      <main className="relative grid min-h-[70vh] place-items-center overflow-hidden px-4 py-20">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(56,189,248,0.13),transparent_48%)]" />
        <div className="storyhold-glass relative w-full max-w-xl rounded-3xl p-7 text-center sm:p-10">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-primary/25 bg-primary/10 text-primary">
            <LogIn className="h-6 w-6" />
          </span>
          <h1 className="mt-6 font-serif text-4xl font-bold">Your Worlds Live with Your Account.</h1>
          <p className="mx-auto mt-4 max-w-md text-base leading-7 text-muted-foreground">
            Sign in to see your saved worlds, import your writing, and continue the stories you have started.
          </p>
          <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
            <Button className="h-11 rounded-lg px-6" onClick={() => openAccount("signin")}>
              Sign In
            </Button>
            <Button
              variant="outline"
              className="h-11 rounded-lg px-6"
              onClick={() => openAccount("register")}
            >
              Create Free Account
            </Button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto grid w-full max-w-7xl gap-4 px-4 py-5 sm:px-6 lg:grid-cols-[214px_minmax(0,1fr)] lg:gap-6 lg:px-8 lg:py-9">
      <aside>
        <div className="storyhold-glass rounded-2xl p-2 lg:sticky lg:top-24 lg:p-3">
          <div className="hidden px-3 pb-4 pt-2 lg:block">
            <p className="truncate font-semibold">{auth.displayName || auth.email}</p>
            <p className="mt-1 truncate text-xs text-muted-foreground">{auth.email}</p>
          </div>
          <nav className="grid grid-cols-3 gap-1 lg:grid-cols-1" aria-label="Profile navigation">
            {profileNavigation.map((item) => {
              const active =
                item.href === "/profile"
                  ? location === item.href
                  : location === item.href ||
                    location.startsWith(`${item.href}/`) ||
                    (item.href === "/profile/worlds" &&
                      location.startsWith("/profile/campaigns/"));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex min-w-0 flex-col items-center gap-1 rounded-xl px-1.5 py-2 text-center text-[11px] transition-colors lg:flex-row lg:gap-3 lg:px-3 lg:py-2.5 lg:text-left lg:text-sm ${
                    active
                      ? "border border-primary/20 bg-gradient-to-br from-primary/18 to-primary/[0.06] font-semibold text-primary shadow-[0_8px_20px_-16px_rgba(56,189,248,0.65),inset_0_1px_0_rgba(255,255,255,0.06)]"
                      : "text-muted-foreground hover:bg-white/[0.035] hover:text-foreground"
                  }`}
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </nav>
          <Link
            href="/credits"
            className="mt-3 hidden items-center justify-between rounded-xl border border-white/8 bg-black/20 px-3 py-3 text-sm transition-colors hover:border-primary/25 lg:flex"
          >
            <span className="flex items-center gap-2 text-muted-foreground">
              <Coins className="h-4 w-4 text-primary" /> Credits
            </span>
            <strong>{auth.unlimitedCredits ? "Unlimited" : auth.credits}</strong>
          </Link>
        </div>
      </aside>
      <div className="min-w-0">{children}</div>
    </main>
  );
}

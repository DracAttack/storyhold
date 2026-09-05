import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { BookOpen, Coins, LogOut, Sparkles, UserRound } from "lucide-react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { AccountDialog, type AuthMode } from "./account-dialog";

type CustomerAccountActions = {
  openAccount: (mode?: AuthMode) => void;
};

const CustomerAccountContext = createContext<CustomerAccountActions | null>(null);

const navigation = [
  { href: "/", label: "Home" },
  { href: "/play", label: "Play" },
  { href: "/profile/worlds", label: "My Worlds" },
  { href: "/credits", label: "Credits" },
];

function isActive(location: string, href: string) {
  if (href === "/") return location === "/";
  if (href === "/profile/worlds") return location.startsWith("/profile/worlds") || location.startsWith("/profile/campaigns/");
  return location === href || location.startsWith(`${href}/`);
}

export function useCustomerAccount(): CustomerAccountActions {
  const context = useContext(CustomerAccountContext);
  if (!context) {
    throw new Error("useCustomerAccount must be used within CustomerShell.");
  }
  return context;
}

export function CustomerShell({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [location] = useLocation();
  const [accountOpen, setAccountOpen] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("register");

  const openAccount = (mode: AuthMode = "register") => {
    setAuthMode(mode);
    setAccountOpen(true);
  };

  const initial = (auth.displayName || auth.email || "S").trim().charAt(0).toUpperCase();

  return (
    <CustomerAccountContext.Provider value={{ openAccount }}>
      <div className="min-h-screen overflow-x-hidden bg-transparent text-[#f2eee6]">
        <AccountDialog
          open={accountOpen}
          mode={authMode}
          onOpenChange={setAccountOpen}
          onModeChange={setAuthMode}
        />

        <header className="sticky top-0 z-40 border-b border-white/10 bg-[#09090d]/70 shadow-[0_14px_40px_-28px_rgba(0,0,0,0.95)] backdrop-blur-2xl supports-[backdrop-filter]:bg-[#09090d]/58">
          <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
            <Link href="/" className="flex items-center gap-2.5" aria-label="Storyhold home">
              <span className="grid h-9 w-9 place-items-center text-primary">
                <BookOpen className="h-6 w-6" />
              </span>
              <span className="font-serif text-2xl font-semibold uppercase tracking-[0.04em]">Storyhold</span>
            </Link>

            <nav className="hidden items-center gap-7 text-sm md:flex" aria-label="Main navigation">
              {navigation.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={
                    isActive(location, item.href)
                      ? "font-semibold text-primary"
                      : "text-muted-foreground transition-colors hover:text-foreground"
                  }
                >
                  {item.label}
                </Link>
              ))}
            </nav>

            <div className="flex items-center gap-2">
              {auth.email ? (
                <>
                  <Link
                    href="/credits"
                    className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5 text-xs transition-colors hover:border-primary/35 sm:flex"
                    aria-label={auth.unlimitedCredits ? "Unlimited credits" : `${auth.credits} credits`}
                  >
                    <Coins className="h-3.5 w-3.5 text-primary" />
                    <span className="font-semibold text-foreground">
                      {auth.unlimitedCredits ? "Unlimited" : auth.credits}
                    </span>
                    {!auth.unlimitedCredits ? (
                      <span className="text-muted-foreground">credits</span>
                    ) : null}
                  </Link>
                  <Link
                    href="/profile"
                    className="grid h-9 w-9 place-items-center rounded-full border border-primary/35 bg-primary/10 text-sm font-bold text-primary transition-colors hover:bg-primary/15"
                    aria-label="Open profile"
                  >
                    {initial}
                  </Link>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="hidden rounded-lg sm:inline-flex"
                    onClick={() => void auth.signOut()}
                    aria-label="Sign out"
                  >
                    <LogOut className="h-4 w-4" />
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="rounded-lg"
                    onClick={() => openAccount("signin")}
                  >
                    Sign In
                  </Button>
                  <Button
                    size="sm"
                    className="rounded-lg"
                    onClick={() => openAccount("register")}
                  >
                    Sign Up
                  </Button>
                </>
              )}
            </div>
          </div>

          <nav
            className="flex h-11 items-center gap-5 overflow-x-auto border-t border-white/6 px-4 text-xs md:hidden"
            aria-label="Mobile navigation"
          >
            {navigation.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`shrink-0 ${
                  isActive(location, item.href)
                    ? "font-semibold text-primary"
                    : "text-muted-foreground"
                }`}
              >
                {item.label}
              </Link>
            ))}
            {auth.email ? (
              <Link
                href="/profile"
                className={`shrink-0 ${
                  location === "/profile" || location.startsWith("/profile/import")
                    ? "font-semibold text-primary"
                    : "text-muted-foreground"
                }`}
              >
                Profile
              </Link>
            ) : null}
          </nav>
        </header>

        {children}

        <footer className="border-t border-white/8 bg-[#09080a]/72 shadow-[0_-18px_50px_-38px_rgba(56,189,248,0.18)] backdrop-blur-xl">
          <div className="mx-auto grid max-w-7xl gap-6 px-4 py-8 sm:px-6 md:grid-cols-[1fr_auto] md:items-end lg:px-8">
            <div>
              <div className="flex items-center gap-2 text-foreground">
                <BookOpen className="h-5 w-5 text-primary" />
                <span className="font-serif text-lg font-semibold uppercase tracking-[0.04em]">Storyhold</span>
              </div>
              <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
                Create any world. Become anyone. Let every choice matter.
              </p>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-3 text-sm text-muted-foreground">
              <Link href="/play" className="flex items-center gap-1.5 hover:text-foreground">
                <Sparkles className="h-3.5 w-3.5" /> Play
              </Link>
              <Link href="/profile/worlds" className="flex items-center gap-1.5 hover:text-foreground">
                <BookOpen className="h-3.5 w-3.5" /> My Worlds
              </Link>
              <Link href="/profile" className="flex items-center gap-1.5 hover:text-foreground">
                <UserRound className="h-3.5 w-3.5" /> Profile
              </Link>
              <Link href="/help" className="hover:text-foreground">Help</Link>
              <Link href="/privacy" className="hover:text-foreground">Privacy</Link>
              <Link href="/terms" className="hover:text-foreground">Terms</Link>
              <Link href="/credit-terms" className="hover:text-foreground">Credits Policy</Link>
              <Link href="/refunds" className="hover:text-foreground">Refunds</Link>
            </div>
          </div>
        </footer>
      </div>
    </CustomerAccountContext.Provider>
  );
}

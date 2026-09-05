import { Link, useLocation } from "wouter";
import { Settings, History, LayoutList, BarChart3, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import logoUrl from "@/assets/bpd-logo.png";

export function Header() {
  const [location] = useLocation();

  const navClass = (active: boolean) =>
    active
      ? "text-foreground bg-muted/60"
      : "text-muted-foreground hover:text-foreground";

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-14 max-w-screen-2xl items-center px-4 md:px-8">
        <Link href="/queue" className="flex items-center mr-6 shrink-0" data-testid="link-home">
          <img
            src={logoUrl}
            alt="BPD-isms"
            className="h-8 md:h-9 object-contain drop-shadow-[0_0_12px_rgba(217,70,239,0.5)]"
            data-testid="img-header-logo"
          />
        </Link>
        <div className="flex flex-1 items-center justify-between space-x-2 md:justify-end">
          <nav className="flex items-center gap-1">
            <Link href="/queue">
              <Button variant="ghost" size="sm" className={navClass(location === "/" || location === "/queue")} data-testid="link-queue">
                <LayoutList className="h-4 w-4 mr-1.5" />
                Queue
              </Button>
            </Link>
            <Link href="/history">
              <Button variant="ghost" size="sm" className={navClass(location === "/history")} data-testid="link-history">
                <History className="h-4 w-4 mr-1.5" />
                History
              </Button>
            </Link>
            <Link href="/stats">
              <Button variant="ghost" size="sm" className={navClass(location === "/stats")} data-testid="link-stats">
                <BarChart3 className="h-4 w-4 mr-1.5" />
                Stats
              </Button>
            </Link>
            <Link href="/settings">
              <Button variant="ghost" size="icon" className={navClass(location === "/settings")} data-testid="btn-settings">
                <Settings className="h-5 w-5" />
                <span className="sr-only">Settings</span>
              </Button>
            </Link>
            {/* BrainHook admin lives outside this SPA — plain anchor, full page load. */}
            <a href="/admin" data-testid="link-brainhook-admin">
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground border-l border-border/40 rounded-none pl-3 ml-1"
              >
                <ArrowLeft className="h-4 w-4 mr-1.5" />
                BrainHook
              </Button>
            </a>
          </nav>
        </div>
      </div>
    </header>
  );
}

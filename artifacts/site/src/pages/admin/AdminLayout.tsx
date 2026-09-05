import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { LayoutDashboard, Users, FileText, LogOut, Home, Mail, Settings, Lightbulb, Tags, Menu, AtSign, Share2, Link2, ImageIcon, CopyCheck, Waypoints, Radar, BrainCircuit, DollarSign, Facebook, Laugh, Library, ClipboardList, Gauge, Rss, BookOpen, FileImage, ShieldAlert, Loader2, Network, Map } from "lucide-react";
import { useEffect, useState } from "react";
import { GlosaryCaptureProvider } from "@/lib/glossaryCaptureContext";
import { useGlossaryCapture } from "@/lib/useGlossaryCapture";
import { useListWatchedClusters } from "@workspace/api-client-react";

function GlosaryCaptureStatusPill() {
  const { running, progress, stop } = useGlossaryCapture();
  if (!running || progress.total === 0) return null;
  const pct = Math.round((progress.done / progress.total) * 100);
  return (
    <div className="mx-3 mb-2 p-3 rounded-lg bg-amber-500/8 border border-amber-500/20">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-amber-300">
          <Loader2 className="h-3 w-3 animate-spin" />
          Capturing {progress.format === "feed" ? "4:5" : progress.format === "reel" ? "9:16" : ""} cards…
        </div>
        <button
          onClick={stop}
          className="text-[10px] text-red-400/70 hover:text-red-400 transition-colors"
        >
          Stop
        </button>
      </div>
      <div className="h-1 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-amber-500 rounded-full transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[10px] text-muted-foreground mt-1">
        {progress.done} / {progress.total} · {progress.stored} saved
      </p>
    </div>
  );
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const { email, signOut } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Sidebar badge: total unread signals across all watched story clusters.
  const { data: watchedData } = useListWatchedClusters();
  const watchedNewCount = (watchedData?.items ?? []).reduce(
    (sum, c) => sum + (c.newDocsSinceViewed ?? 0),
    0,
  );

  // Close mobile drawer on navigation.
  useEffect(() => { setDrawerOpen(false); }, [location]);

  const topNav = [
    { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
  ];

  const navGroups = [
    {
      label: "Content",
      items: [
        { href: "/admin/articles", label: "Articles", icon: FileText },
        { href: "/admin/ideas", label: "Ideas", icon: Lightbulb },
        { href: "/admin/authors", label: "Authors", icon: Users },
        { href: "/admin/beats", label: "Beats", icon: Tags },
        { href: "/admin/concepts", label: "Concepts", icon: BookOpen },
        { href: "/admin/media-library", label: "Media Library", icon: FileImage },
      ],
    },
    {
      label: "Sources & Trust",
      items: [
        { href: "/admin/editor-cockpit", label: "Editor Cockpit", icon: ClipboardList },
        { href: "/admin/source-vault", label: "Source Vault", icon: Library },
        { href: "/admin/source-links", label: "Source Links", icon: Link2 },
        { href: "/admin/internal-links", label: "Internal Links", icon: Waypoints },
        { href: "/admin/source-gaps", label: "Source Gaps", icon: ClipboardList },
        { href: "/admin/source-health", label: "Source Health", icon: ShieldAlert },
        { href: "/admin/duplicates", label: "Duplicates", icon: CopyCheck },
        { href: "/admin/back-catalog", label: "Source Harvest", icon: Radar },
        { href: "/admin/feeds", label: "Feeds", icon: Rss },
      ],
    },
    {
      label: "Distribution",
      items: [
        { href: "/admin/social-queue", label: "Social Queue", icon: Facebook },
        { href: "/admin/term-of-day", label: "Term of the Day", icon: BookOpen },
        { href: "/admin/shares", label: "Shares", icon: Share2 },
        { href: "/admin/memes", label: "Memes", icon: Laugh },
        { href: "/admin/share-cards", label: "Share Cards", icon: ImageIcon },
        { href: "/admin/utm-builder", label: "UTM Builder", icon: Link2 },
      ],
    },
    {
      label: "Intelligence",
      items: [
        { href: "/admin/coverage-map", label: "Coverage Map", icon: Map },
        { href: "/admin/trends", label: "Trend Radar", icon: Radar },
        { href: "/admin/cross-beat", label: "Cross-Beat Radar", icon: Network },
        { href: "/admin/ai-control", label: "AI Control", icon: BrainCircuit },
        { href: "/admin/shadow-metrics", label: "Shadow Metrics", icon: Gauge },
        { href: "/admin/ai-costs", label: "AI Costs", icon: DollarSign },
        { href: "/admin/notifications", label: "Notifications", icon: Mail },
        { href: "/admin/subscribers", label: "Subscribers", icon: AtSign },
      ],
    },
    {
      label: "System",
      items: [{ href: "/admin/settings", label: "Settings", icon: Settings }],
    },
  ];

  const handleSignOut = async () => {
    await signOut();
    setLocation("/admin/login");
  };

  const navContents = (
    <>
      <div className="p-6 border-b">
        <Link href="/" className="font-serif text-xl font-bold text-primary">BrainHook</Link>
        <p className="text-xs text-muted-foreground mt-1">Editor desk</p>
      </div>
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {topNav.map((n) => {
          const active = n.href === "/admin" ? location === "/admin" : location.startsWith(n.href);
          const Icon = n.icon;
          return (
            <Link key={n.href} href={n.href} className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium ${active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
              <Icon className="h-4 w-4" /> {n.label}
            </Link>
          );
        })}
        {navGroups.map((group) => (
          <div key={group.label} className="mt-3">
            <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
              {group.label}
            </div>
            {group.items.map((n) => {
              const active = location.startsWith(n.href);
              const Icon = n.icon;
              const isCockpit = n.href === "/admin/editor-cockpit";
              const badge = isCockpit && watchedNewCount > 0 ? watchedNewCount : null;
              return (
                <Link key={n.href} href={n.href} className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium ${active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
                  <Icon className="h-4 w-4" /> {n.label}
                  {badge !== null && (
                    <span className="ml-auto min-w-[18px] h-[18px] px-1 rounded-full bg-blue-500 text-white text-[10px] font-bold leading-[18px] text-center shrink-0">
                      {badge}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <GlosaryCaptureStatusPill />
      <div className="p-3 border-t space-y-2">
        <div className="px-3 py-2 text-xs text-muted-foreground truncate">{email}</div>
        <Link href="/" className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
          <Home className="h-4 w-4" /> View site
        </Link>
        <Button variant="ghost" size="sm" className="w-full justify-start" onClick={handleSignOut}>
          <LogOut className="h-4 w-4 mr-2" /> Sign out
        </Button>
      </div>
    </>
  );

  return (
    <GlosaryCaptureProvider>
    <div className="min-h-screen bg-muted/30 md:flex">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-60 bg-card border-r flex-col shrink-0">
        {navContents}
      </aside>

      {/* Mobile top bar */}
      <div className="md:hidden flex items-center justify-between border-b bg-card px-3 py-2 sticky top-0 z-30">
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open admin menu">
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="p-0 w-64 flex flex-col">
            {navContents}
          </SheetContent>
        </Sheet>
        <Link href="/" className="font-serif text-lg font-bold text-primary">BrainHook</Link>
        <div className="w-9" />
      </div>

      <main className="flex-1 min-w-0 overflow-x-hidden">{children}</main>
    </div>
    </GlosaryCaptureProvider>
  );
}

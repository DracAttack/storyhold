import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  BookOpen,
  Home,
  LogOut,
  Menu,
  ShieldCheck,
  MessagesSquare,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { isPremiumRecoveryOperator } from "@/lib/premiumRecoveryApi";
import { listManualStorytellerEntries } from "@/lib/manualStorytellerApi";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

export default function StoryholdAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [location, setLocation] = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { email, role, signOut } = useAuth();
  const [manualEnabled, setManualEnabled] = useState(false);
  useEffect(() => {
    setManualEnabled(false);
    if (!isPremiumRecoveryOperator(role)) return;
    const controller = new AbortController();
    void listManualStorytellerEntries(controller.signal)
      .then((result) => { if (!controller.signal.aborted) setManualEnabled(result.enabled); })
      .catch(() => { /* The optional local test queue stays hidden when unavailable. */ });
    return () => controller.abort();
  }, [role]);

  const handleSignOut = async () => {
    await signOut();
    setLocation("/admin/login");
  };

  const nav = (
    <>
      <div className="border-b p-6">
        <Link
          href="/"
          aria-label="Storyhold Home"
          className="font-serif text-xl font-bold text-primary"
        >
          Storyhold
        </Link>
        <p className="mt-1 text-xs text-muted-foreground">Owner workspace</p>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        <Link
          href="/"
          className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Home className="h-4 w-4" /> Main Site
        </Link>
        <Link
          href="/admin/worlds"
          className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium ${location === "/admin/worlds" || location.startsWith("/admin/worlds/") ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
        >
          <BookOpen className="h-4 w-4" /> World Studio
        </Link>
        {isPremiumRecoveryOperator(role) && <Link
          href="/admin/premium-recovery"
          className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium ${location === "/admin/premium-recovery" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
        >
          <ShieldCheck className="h-4 w-4" /> Premium Recovery
        </Link>}
        {manualEnabled && isPremiumRecoveryOperator(role) ? <Link
          href="/admin/manual-storyteller"
          className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium ${location === "/admin/manual-storyteller" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
        >
          <MessagesSquare className="h-4 w-4" /> Manual Storyteller
        </Link> : null}
      </nav>
      <div className="space-y-2 border-t p-3">
        <div className="truncate px-3 py-2 text-xs text-muted-foreground">
          {email}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start"
          onClick={handleSignOut}
        >
          <LogOut className="mr-2 h-4 w-4" /> Sign out
        </Button>
      </div>
    </>
  );

  return (
    <div className="min-h-screen bg-muted/30 md:flex">
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-card md:flex">
        {nav}
      </aside>
      <div className="sticky top-0 z-30 flex items-center justify-between border-b bg-card px-3 py-2 md:hidden">
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Open Storyhold menu"
            >
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="flex w-64 flex-col p-0">
            <SheetTitle className="sr-only">Storyhold navigation</SheetTitle>
            <SheetDescription className="sr-only">
              Storyhold owner tools and World Studio.
            </SheetDescription>
            {nav}
          </SheetContent>
        </Sheet>
        <Link
          href="/"
          aria-label="Storyhold Home"
          className="font-serif text-lg font-bold text-primary"
        >
          Storyhold
        </Link>
        <div className="w-9" />
      </div>
      <main className="min-w-0 flex-1 overflow-x-hidden">{children}</main>
    </div>
  );
}

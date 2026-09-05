import * as React from "react";
import {
  Redirect,
  Route,
  Router as WouterRouter,
  Switch,
  useLocation,
} from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Toaster as SonnerToaster } from "sonner";
import { CustomerShell } from "@/components/customer/customer-shell";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import { queryClient } from "@/lib/queryClient";
import { isPremiumRecoveryOperator } from "@/lib/premiumRecoveryApi";
import { useSeo } from "@/lib/seo";
import CampaignPlay from "@/pages/campaign-play";
import CampaignStory from "@/pages/campaign-story";
import Credits from "@/pages/credits";
import Home from "@/pages/home";
import Play from "@/pages/play";
import Profile from "@/pages/profile";
import ProfileImport from "@/pages/profile-import";
import ProfileCharacter from "@/pages/profile-character";
import ProfileEntity from "@/pages/profile-entity";
import ProfileWorld from "@/pages/profile-world";
import ProfileWorldIntake from "@/pages/profile-world-intake";
import ProfileWorlds from "@/pages/profile-worlds";
import { StoryholdCreditTerms, StoryholdHelp, StoryholdPrivacy, StoryholdRefunds, StoryholdTerms } from "@/pages/storyhold-legal";

// Only Storyhold owner surfaces are routed. The imported magazine files remain
// dormant in the repository and are not bundled into the active application.
const StoryholdAdminLayout = React.lazy(
  () => import("@/pages/admin/StoryholdAdminLayout"),
);
const AdminWorlds = React.lazy(() => import("@/pages/admin/Worlds"));
const AdminWorldStudio = React.lazy(() => import("@/pages/admin/WorldStudio"));
const AdminPremiumRecovery = React.lazy(() => import("@/pages/admin/PremiumRecovery"));
const AdminManualStoryteller = React.lazy(() => import("@/pages/admin/ManualStoryteller"));
const AdminLogin = React.lazy(() => import("@/pages/admin/AdminLogin"));
const NotAuthorized = React.lazy(() => import("@/pages/admin/NotAuthorized"));

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function AdminFallback() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

function PublicRoutes() {
  return (
    <CustomerShell>
      <Switch>
        <Route path="/profile/campaigns/:id/play" component={CampaignPlay} />
        <Route path="/profile/campaigns/:id/story" component={CampaignStory} />
        <Route path="/profile/worlds/:worldId/characters/:characterId" component={ProfileCharacter} />
        <Route path="/profile/worlds/:worldId/entities/:entityId" component={ProfileEntity} />
        <Route path="/profile/worlds/:worldId/intake" component={ProfileWorldIntake} />
        <Route path="/profile/worlds/:id" component={ProfileWorld} />
        <Route path="/profile/worlds" component={ProfileWorlds} />
        <Route path="/profile/import" component={ProfileImport} />
        <Route path="/profile" component={Profile} />
        <Route path="/play" component={Play} />
        <Route path="/credits" component={Credits} />
        <Route path="/terms" component={StoryholdTerms} />
        <Route path="/credit-terms" component={StoryholdCreditTerms} />
        <Route path="/refunds" component={StoryholdRefunds} />
        <Route path="/privacy" component={StoryholdPrivacy} />
        <Route path="/help" component={StoryholdHelp} />
        <Route path="/" component={Home} />
        <Route>
          <Redirect to="/" />
        </Route>
      </Switch>
    </CustomerShell>
  );
}

function useAdminSeo() {
  useSeo({ title: "Storyhold — Owner tools", noindex: true });
}

function AdminGuard({ children, operatorOnly = false }: { children: React.ReactNode; operatorOnly?: boolean }) {
  useAdminSeo();
  const { isLoaded, email, role, isForbidden } = useAuth();
  if (!isLoaded) return <AdminFallback />;
  if (!email && !isForbidden) return <Redirect to="/admin/login" />;
  const allowed = operatorOnly
    ? isPremiumRecoveryOperator(role)
    : ["owner", "admin", "creator"].includes(role ?? "");
  return (
    <React.Suspense fallback={<AdminFallback />}>
      {isForbidden || !allowed ? (
        <NotAuthorized />
      ) : (
        <StoryholdAdminLayout>{children}</StoryholdAdminLayout>
      )}
    </React.Suspense>
  );
}

function AdminLoginRoute() {
  useAdminSeo();
  return (
    <React.Suspense fallback={<AdminFallback />}>
      <AdminLogin />
    </React.Suspense>
  );
}

function AdminOrPublicFallback() {
  const [location] = useLocation();
  if (location === "/admin" || location.startsWith("/admin/")) {
    return <Redirect to="/admin/worlds" />;
  }
  return <PublicRoutes />;
}

function AppRoutes() {
  return (
    <Switch>
      <Route path="/admin/login">
        <AdminLoginRoute />
      </Route>
      <Route path="/admin/premium-recovery">
        <AdminGuard operatorOnly>
          <AdminPremiumRecovery />
        </AdminGuard>
      </Route>
      <Route path="/admin/manual-storyteller">
        <AdminGuard operatorOnly>
          <AdminManualStoryteller />
        </AdminGuard>
      </Route>
      <Route path="/admin/worlds/:id">
        <AdminGuard>
          <AdminWorldStudio />
        </AdminGuard>
      </Route>
      <Route path="/admin/worlds">
        <AdminGuard>
          <AdminWorlds />
        </AdminGuard>
      </Route>
      <Route path="/admin">
        <Redirect to="/admin/worlds" />
      </Route>
      <Route>
        <AdminOrPublicFallback />
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <TooltipProvider>
            <AppRoutes />
            <Toaster />
            <SonnerToaster richColors closeButton position="top-right" />
          </TooltipProvider>
        </AuthProvider>
      </QueryClientProvider>
    </WouterRouter>
  );
}

export default App;

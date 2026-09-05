import type { ReactNode } from "react";
import { useMe } from "@/hooks/api";

// BPD-isms is admin-only and shares the BrainHook admin session. If the visitor
// has no valid admin session, /api/me returns 401 and we show a sign-in prompt
// linking to the main site's /admin/login rather than letting the app render
// and fail every request. After signing in there, the shared cookie unlocks
// this tool on the same domain.
export function AuthGate({ children }: { children: ReactNode }) {
  const { isLoading, isError } = useMe();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
        <p className="text-sm">Checking access…</p>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <div className="w-full max-w-sm rounded-lg border border-border bg-card p-8 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-foreground">Admin sign-in required</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            BPD-isms is restricted to BrainHook admins. Sign in to continue.
          </p>
          <a
            href="/admin/login"
            className="mt-6 inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90"
          >
            Go to admin sign-in
          </a>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

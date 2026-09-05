import { QueryClient, QueryCache } from "@tanstack/react-query";
import { ApiError } from "@workspace/api-client-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/**
 * If any admin-area query throws a 401, the session is no longer valid.
 * Flush React Query, then send the user back to /admin/login so they can
 * re-authenticate. Without this, a stale 401 cached against an
 * owner-tool query would render forever as an "unauthorized" error
 * even after a fresh login.
 */
const queryCache = new QueryCache({
  onError: (err) => {
    if (!isAuthError(err)) return;
    if (typeof window === "undefined") return;
    if (!(window.location.pathname === "/admin" || window.location.pathname.startsWith("/admin/"))) return;
    const loginPath = `${basePath}/admin/login`;
    if (window.location.pathname === loginPath) return;
    queryClient.clear();
    window.location.assign(loginPath);
  },
});

export const queryClient: QueryClient = new QueryClient({
  queryCache,
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, err) => {
        if (isAuthError(err)) return false;
        return failureCount < 1;
      },
    },
  },
});

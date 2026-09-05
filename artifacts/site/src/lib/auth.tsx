import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

type AuthState = {
  email: string | null;
  userId: string | null;
  role: string | null;
  displayName: string | null;
  credits: number;
  unlimitedCredits: boolean;
  isLoaded: boolean;
  isForbidden: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState>({
  email: null,
  userId: null,
  role: null,
  displayName: null,
  credits: 0,
  unlimitedCredits: false,
  isLoaded: false,
  isForbidden: false,
  refresh: async () => {},
  signOut: async () => {},
});

const apiBase = (() => {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${base}/api`;
})();

// Lightweight hint (NOT a credential) that this browser has signed in as an
// admin before. It only decides whether we bother calling /api/admin/me on
// load; the server session cookie remains the source of truth.
const SESSION_MARKER_KEY = "storyhold.session";
const LEGACY_SESSION_MARKER_KEY = "storyhold.admin.session";

function setSessionMarker() {
  try {
    localStorage.setItem(SESSION_MARKER_KEY, "1");
  } catch {
    // localStorage may be unavailable (private mode, etc.) — the marker is only
    // an optimization, so failing to persist it is harmless.
  }
}

function clearSessionMarker() {
  try {
    localStorage.removeItem(SESSION_MARKER_KEY);
    localStorage.removeItem(LEGACY_SESSION_MARKER_KEY);
  } catch {
    // See setSessionMarker — safe to ignore.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [email, setEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [credits, setCredits] = useState(0);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isForbidden, setIsForbidden] = useState(false);
  const checkedRef = useRef(false);

  const refresh = async () => {
    checkedRef.current = true;
    try {
      const res = await fetch(`${apiBase}/storyhold/auth/me`, {
        credentials: "include",
      });
      if (res.ok) {
        const data = (await res.json()) as {
          email: string;
          userId: string;
          role: string;
          displayName: string;
          credits: number;
        };
        setEmail(data.email);
        setUserId(data.userId);
        setRole(data.role);
        setDisplayName(data.displayName);
        setCredits(data.credits);
        setIsForbidden(false);
        setSessionMarker();
      } else if (res.status === 403) {
        setEmail(null);
        setUserId(null);
        setRole(null);
        setDisplayName(null);
        setCredits(0);
        setIsForbidden(true);
        clearSessionMarker();
      } else {
        setEmail(null);
        setUserId(null);
        setRole(null);
        setDisplayName(null);
        setCredits(0);
        setIsForbidden(false);
        clearSessionMarker();
      }
    } catch {
      setEmail(null);
      setUserId(null);
      setRole(null);
      setDisplayName(null);
      setCredits(0);
      setIsForbidden(false);
    } finally {
      setIsLoaded(true);
    }
  };

  const signOut = async () => {
    await fetch(`${apiBase}/storyhold/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
    setEmail(null);
    setUserId(null);
    setRole(null);
    setDisplayName(null);
    setCredits(0);
    setIsForbidden(false);
    clearSessionMarker();
  };

  // The server cookie is the only source of truth. Always check it once when
  // the app loads so a valid customer or owner session cannot be hidden merely
  // because a browser hint was cleared or a protected route opened directly.
  useEffect(() => {
    if (checkedRef.current) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AuthContext.Provider
      value={{
        email,
        userId,
        role,
        displayName,
        credits,
        unlimitedCredits: role === "owner" || role === "admin",
        isLoaded,
        isForbidden,
        refresh,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

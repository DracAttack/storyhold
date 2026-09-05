/**
 * Glossary card capture — client for the SERVER-SIDE capture pipeline.
 *
 * Capture no longer happens in this browser: the API server drives a
 * headless Chromium at /card-render and screenshots the real CSS card
 * (see api-server services/glossaryCardCapture.ts). This provider just
 * starts/cancels server batch runs, polls their progress, and exposes the
 * single-card capture endpoint — the UI surface (Backfill / Rebuild All /
 * Recapture buttons, progress bar) is unchanged.
 *
 * Because the batch runs on the server, it survives admin navigation AND
 * page reloads; the provider re-attaches to an in-flight run on mount.
 */

import { createContext, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/** Which card output a batch targets — batches are format-scoped on the
 *  server (a feed run never touches stored reel cards and vice versa). */
export type CaptureFormat = "feed" | "reel";

export interface CaptureProgress {
  done:  number;
  total: number;
  stored: number;
  mode: "backfill" | "rebuild-all" | null;
  format: CaptureFormat | null;
}

interface ServerBatchStatus {
  running: boolean;
  mode: "backfill" | "rebuild-all" | null;
  format: CaptureFormat | null;
  done: number;
  total: number;
  stored: number;
  lastError: string | null;
}

interface GlosaryCaptureCtx {
  running:     boolean;
  progress:    CaptureProgress;
  busySingle:  string | null; // concept.id currently in a one-shot capture
  startBackfill:  (format: CaptureFormat, onComplete?: () => void) => void;
  startRebuildAll:(format: CaptureFormat, onComplete?: () => void) => void;
  stop:           () => void;
  /** Server-side capture+store for one concept (BOTH formats). Resolves true on success. */
  captureAndStore:(concept: { id: string }) => Promise<boolean>;
}

const Ctx = createContext<GlosaryCaptureCtx | null>(null);

const POLL_MS = 1500;
const IDLE_PROGRESS: CaptureProgress = { done: 0, total: 0, stored: 0, mode: null, format: null };

async function fetchStatus(): Promise<ServerBatchStatus | null> {
  try {
    const r = await fetch("/api/admin/concepts/capture-cards/status", { credentials: "include" });
    if (!r.ok) return null;
    return (await r.json()) as ServerBatchStatus;
  } catch {
    return null;
  }
}

export function GlosaryCaptureProvider({ children }: { children: ReactNode }) {
  const [running,    setRunning]    = useState(false);
  const [progress,   setProgress]   = useState<CaptureProgress>(IDLE_PROGRESS);
  const [busySingle, setBusySingle] = useState<string | null>(null);
  const pollTimer   = useRef<ReturnType<typeof setInterval> | null>(null);
  const onCompleteRef = useRef<(() => void) | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const applyStatus = useCallback((s: ServerBatchStatus) => {
    if (s.running) {
      setRunning(true);
      setProgress({ done: s.done, total: s.total, stored: s.stored, mode: s.mode, format: s.format });
    } else {
      setRunning(false);
      setProgress(IDLE_PROGRESS);
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollTimer.current) return;
    pollTimer.current = setInterval(() => {
      void fetchStatus().then((s) => {
        if (!s) return; // transient fetch error — keep polling
        applyStatus(s);
        if (!s.running) {
          stopPolling();
          const cb = onCompleteRef.current;
          onCompleteRef.current = null;
          cb?.();
        }
      });
    }, POLL_MS);
  }, [applyStatus, stopPolling]);

  // Re-attach to an in-flight server batch on mount (survives reloads).
  useEffect(() => {
    void fetchStatus().then((s) => {
      if (s?.running) {
        applyStatus(s);
        startPolling();
      }
    });
    return stopPolling;
  }, [applyStatus, startPolling, stopPolling]);

  const startBatch = useCallback((mode: "backfill" | "rebuild-all", format: CaptureFormat, onComplete?: () => void) => {
    if (running || busySingle) return;
    void (async () => {
      try {
        const r = await fetch("/api/admin/concepts/capture-cards/start", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ mode, format }),
        });
        if (!r.ok) return; // 409 = already running elsewhere; status poll will pick it up
        const body = (await r.json()) as { started: boolean; total: number };
        if (!body.started) { onComplete?.(); return; }
        onCompleteRef.current = onComplete ?? null;
        setRunning(true);
        setProgress({ done: 0, total: body.total, stored: 0, mode, format });
        startPolling();
      } catch { /* network hiccup — leave UI idle */ }
    })();
  }, [running, busySingle, startPolling]);

  const startBackfill   = useCallback((format: CaptureFormat, onComplete?: () => void) => startBatch("backfill", format, onComplete), [startBatch]);
  const startRebuildAll = useCallback((format: CaptureFormat, onComplete?: () => void) => startBatch("rebuild-all", format, onComplete), [startBatch]);

  const stop = useCallback(() => {
    void fetch("/api/admin/concepts/capture-cards/cancel", {
      method: "POST",
      credentials: "include",
    }).catch(() => {});
    // Keep polling — the server stops after the in-flight card finishes.
  }, []);

  const captureAndStore = useCallback(async (concept: { id: string }): Promise<boolean> => {
    if (running || busySingle) return false;
    setBusySingle(concept.id);
    try {
      const r = await fetch(`/api/admin/concepts/${concept.id}/capture-card`, {
        method: "POST",
        credentials: "include",
      });
      return r.ok;
    } catch {
      return false;
    } finally {
      setBusySingle(null);
    }
  }, [running, busySingle]);

  return (
    <Ctx.Provider value={{ running, progress, busySingle, startBackfill, startRebuildAll, stop, captureAndStore }}>
      {children}
    </Ctx.Provider>
  );
}

// Hook lives in useGlossaryCapture.ts to satisfy Vite Fast Refresh
// (a file may only export React components OR hooks, not both).
export { Ctx };
export type { GlosaryCaptureCtx };

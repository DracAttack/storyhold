import { useEffect, useRef, useState } from "react";
import { ensureAdSenseLoaded } from "./loadAdSense";

type AdStatus = "loading" | "filled" | "unfilled";

// Shared logic for manual AdSense units. Loads the AdSense script on demand
// (route-scoped: the loader is no longer in the global shell, so ad code only
// ever runs on pages that actually mount an ad unit), pushes the ad request
// exactly once per mount (guarded against StrictMode double-invokes and
// re-renders) and tracks the slot's fill status so callers can collapse
// unfilled slots cleanly instead of leaving an empty box.
export function useAdSense<T extends HTMLElement>() {
  const insRef = useRef<T>(null);
  const pushed = useRef(false);
  const [status, setStatus] = useState<AdStatus>("loading");

  useEffect(() => {
    const ins = insRef.current;
    if (!ins || pushed.current) return;

    // No-op if the production meta server already injected the script tag for
    // this article route; injects it otherwise (SPA navigation, dev mode).
    ensureAdSenseLoaded();

    // If AdSense already attached an ad to this element, don't push again —
    // a second push on a filled <ins> throws "already have ads in them".
    if (ins.getAttribute("data-adsbygoogle-status")) {
      pushed.current = true;
    } else {
      try {
        (window.adsbygoogle = window.adsbygoogle || []).push({});
        pushed.current = true;
      } catch {
        // AdSense reports its own errors to the console; nothing to do here.
      }
    }

    const readStatus = () => {
      const s = ins.getAttribute("data-ad-status");
      if (s === "filled") setStatus("filled");
      else if (s === "unfilled") setStatus("unfilled");
    };
    readStatus();

    const observer = new MutationObserver(readStatus);
    observer.observe(ins, { attributes: true, attributeFilter: ["data-ad-status"] });

    // Collapse the reserved space if AdSense hasn't responded after a generous
    // window. Slow networks, consent-message interaction (EEA/UK), and first-
    // page cold loads can all take longer than a few seconds. Only collapse on
    // a fallback timer; explicit "unfilled" from AdSense is handled immediately
    // by the MutationObserver above.
    const timeout = setTimeout(() => {
      if (!ins.getAttribute("data-ad-status")) setStatus("unfilled");
    }, 30000);

    return () => { observer.disconnect(); clearTimeout(timeout); };
  }, []);

  return { insRef, status };
}

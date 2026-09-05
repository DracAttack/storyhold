import { refreshAnalyticsConsentListener } from "@/lib/analytics";
import { ADSENSE_CLIENT } from "./adsense-config";

/**
 * Lazy, idempotent injector for the AdSense loader script.
 *
 * The loader used to sit in the global HTML shell, which meant every route in
 * the SPA — admin screens, search, unsubscribe, policy pages, 404s — contacted
 * Google's ad servers even though no ad unit ever rendered there. Google's
 * policies prohibit ad code on screens without publisher content, and
 * route-scoped loading is the defensible implementation of that.
 *
 * Now the script loads in exactly two ways, both scoped to monetized routes:
 *
 *  1. The production meta server injects the <script> tag into the head for
 *     article and glossary routes (see buildHeadBlock in server/index.ts),
 *     so real visitors and crawlers get it in the initial HTML on ad-bearing
 *     pages.
 *  2. This function runs when an ad component actually mounts (see
 *     useAdSense), covering SPA navigations onto an article and dev mode,
 *     where there is no meta server.
 *
 * The querySelector guard makes the two paths safe together: if the server
 * already injected the tag, this is a no-op. Calling `adsbygoogle.push` before
 * the script finishes loading is safe — the queue is a plain array shim until
 * the loader replaces it.
 *
 * Note: Google's consent message (AdSense → Privacy & messaging) is delivered
 * through this same loader, so EEA/UK/CH visitors see the consent prompt on
 * ad-bearing pages — which are the only pages where consent is needed, since
 * no ad code runs anywhere else and GA runs cookieless-by-default in those
 * regions until consent (see src/lib/analytics.ts).
 */

const LOADER_SRC_PREFIX = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js";

let injected = false;

// Monetized routes: the AdSense loader (and its consent message) only makes
// sense on pages that can actually carry ad units. SPA navigation from an
// article to /privacy, /search, /about, etc. must NOT lazily inject the
// script — once loaded it cannot be unloaded and Auto Ads may still evaluate
// the non-monetized route.
const MONETIZED_PATH_RE = /^\/($|article\/|category\/|author\/|glossary)/;

export function ensureAdSenseLoaded(): void {
  if (typeof document === "undefined") return;
  // Route boundary: on non-monetized SPA pages the script stays out entirely.
  if (!MONETIZED_PATH_RE.test(document.location.pathname)) return;

  // The CMP is delivered by this loader and may appear after Analytics started.
  // Give the consent bridge a fresh retry window whenever an ad-bearing route
  // requests AdSense, including when the server already injected the script.
  refreshAnalyticsConsentListener();

  if (injected) return;
  injected = true;
  if (document.querySelector(`script[src^="${LOADER_SRC_PREFIX}"]`)) return;
  const script = document.createElement("script");
  script.async = true;
  script.src = `${LOADER_SRC_PREFIX}?client=${encodeURIComponent(ADSENSE_CLIENT)}`;
  script.crossOrigin = "anonymous";
  script.addEventListener("load", refreshAnalyticsConsentListener, { once: true });
  document.head.appendChild(script);
}

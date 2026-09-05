import { clearJourneyIdentity } from "./journey";

// Google Analytics 4 (gtag) integration.
//
// The bootstrap (dataLayer queue + Consent Mode defaults + gtag.js loader) now
// lives in artifacts/site/index.html so it runs synchronously before React.
// This module provides the defensive fallback for dev/test shells that do not
// serve that HTML, the SPA route-change page_view calls, and the TCF CMP
// consent-update listener.
//
// The HTML bootstrap sends Google's normal first-load page_view immediately.
// The SPA tracker calls trackPageView only after the URL changes, preventing
// first-load timing gaps without double-counting later navigation.

const GA_MEASUREMENT_ID = "G-758BNJ92TC";

type GtagFn = (...args: unknown[]) => void;

declare global {
  interface Window {
    dataLayer?: IArguments[];
    gtag?: GtagFn;
    __brainhookGaBootstrapped?: boolean;
  }
}

let initialized = false;
let tcfListenerAttached = false;
let tcfRetryTimer: number | undefined;
let tcfRetryDeadline = 0;

type TcfData = {
  purpose?: { consents?: Record<number, boolean> };
  eventStatus?: string;
};

function attachTcfConsentListener(gtag: GtagFn): boolean {
  if (tcfListenerAttached) return true;

  const tcfapi = (window as unknown as { __tcfapi?: (...args: unknown[]) => void }).__tcfapi;
  if (typeof tcfapi !== "function") return false;

  try {
    tcfapi(
      "addEventListener",
      2,
      (tcData: TcfData, success: boolean) => {
        if (!success || !tcData) return;
        if (tcData.eventStatus !== "tcloaded" && tcData.eventStatus !== "useractioncomplete") return;

        const consents = tcData.purpose?.consents ?? {};
        gtag("consent", "update", {
          ad_storage: consents[1] ? "granted" : "denied",
          analytics_storage: consents[1] ? "granted" : "denied",
          ad_user_data: consents[1] && consents[7] ? "granted" : "denied",
          ad_personalization: consents[3] && consents[4] ? "granted" : "denied",
        });
        if (!consents[1]) clearJourneyIdentity();
      },
    );
    tcfListenerAttached = true;
    return true;
  } catch {
    return false;
  }
}

function scheduleTcfConsentListener(gtag: GtagFn): void {
  if (attachTcfConsentListener(gtag)) {
    if (tcfRetryTimer !== undefined) {
      window.clearTimeout(tcfRetryTimer);
      tcfRetryTimer = undefined;
    }
    return;
  }

  if (Date.now() >= tcfRetryDeadline || tcfRetryTimer !== undefined) return;
  tcfRetryTimer = window.setTimeout(() => {
    tcfRetryTimer = undefined;
    scheduleTcfConsentListener(gtag);
  }, 500);
}

/**
 * Connect GA4 to Google's consent system. This can be called again when
 * AdSense loads later during SPA navigation; retries are bounded to 30 seconds
 * after the most recent call and stop permanently once the listener is attached.
 */
export function refreshAnalyticsConsentListener(): void {
  if (!isAnalyticsEnabled()) return;
  const gtag = ensureGtagBootstrap();
  tcfRetryDeadline = Math.max(tcfRetryDeadline, Date.now() + 30_000);
  scheduleTcfConsentListener(gtag);
}

export function isAnalyticsEnabled(): boolean {
  return typeof window !== "undefined";
}

function ensureGtagBootstrap(): GtagFn {
  window.dataLayer = window.dataLayer || [];
  if (!window.gtag) {
    window.gtag = function gtag(..._args: unknown[]): void {
      // Match Google's canonical snippet exactly. gtag.js consumes the
      // Arguments object queued here; do not replace it with a nested array.
      window.dataLayer!.push(arguments);
    };
  }
  return window.gtag;
}

/**
 * Attach the runtime consent listener and provide a defensive fallback for
 * development/test shells. Production is bootstrapped synchronously in
 * index.html before the React bundle runs.
 */
export function initAnalytics(): void {
  if (initialized || !isAnalyticsEnabled()) return;
  initialized = true;

  const gtag = ensureGtagBootstrap();

  // Defensive fallback: if this module is ever mounted outside the normal
  // Vite HTML shell, initialize GA here once instead of silently doing nothing.
  if (!window.__brainhookGaBootstrapped) {
    gtag("js", new Date());
    gtag("config", GA_MEASUREMENT_ID, {
      send_page_view: window.location.pathname !== "/card-render",
    });
    window.__brainhookGaBootstrapped = true;
  }

  // Avoid adding the loader twice. In production index.html already contains it.
  if (!document.querySelector(`script[src*="googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}"]`)) {
    const script = document.createElement("script");
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_MEASUREMENT_ID)}`;
    document.head.appendChild(script);
  }

  refreshAnalyticsConsentListener();
}

/** Send a GA4 page_view for an SPA route change. */
export function trackPageView(path: string, title?: string): void {
  if (!isAnalyticsEnabled() || !window.gtag) return;
  window.gtag("event", "page_view", {
    page_path: path,
    page_location: window.location.href,
    page_title: title ?? document.title,
  });
}

/** Send an arbitrary GA4 event. Best-effort; never throws. */
export function trackEvent(name: string, params?: Record<string, unknown>): void {
  if (!isAnalyticsEnabled() || !window.gtag) return;
  window.gtag("event", name, params ?? {});
}

/** Convenience wrapper for an article share-button click. */
export function trackShare(platform: string, slug: string, title: string): void {
  trackEvent("share", { method: platform, item_id: slug, content_type: "article", item_name: title });
}

/**
 * Coarse, PII-free traffic-source attribution for a page view, derived from the
 * landing URL's UTM params (preferred), else the external referrer host, else
 * "direct". Mirrors the classic source/medium model so the self-hosted page-view
 * report can show WHERE a view came from, not just totals. The referrer is
 * reduced to its bare host (no path/query), and same-origin referrers are
 * ignored so internal navigation doesn't masquerade as a referral.
 */
export interface TrafficSource {
  source: string;
  medium: string;
  campaign?: string;
  content?: string;
  referrerHost?: string;
}

export function captureTrafficSource(): TrafficSource {
  if (typeof window === "undefined") return { source: "direct", medium: "none" };

  const params = new URLSearchParams(window.location.search);
  const utmSource = (params.get("utm_source") ?? "").trim();
  const utmMedium = (params.get("utm_medium") ?? "").trim();
  const utmCampaign = (params.get("utm_campaign") ?? "").trim();
  const utmContent = (params.get("utm_content") ?? "").trim();

  let referrerHost = "";
  try {
    if (document.referrer) {
      const host = new URL(document.referrer).hostname.replace(/^www\./, "");
      const self = window.location.hostname.replace(/^www\./, "");
      if (host && host !== self) referrerHost = host;
    }
  } catch {
    // Malformed referrer — ignore and fall through to "direct".
  }

  if (utmSource) {
    return {
      source: utmSource.toLowerCase(),
      medium: (utmMedium || "(unknown)").toLowerCase(),
      campaign: utmCampaign || undefined,
      content: utmContent || undefined,
      referrerHost: referrerHost || undefined,
    };
  }
  if (referrerHost) {
    return { source: referrerHost, medium: "referral", referrerHost };
  }
  return { source: "direct", medium: "none" };
}

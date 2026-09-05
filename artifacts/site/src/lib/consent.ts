import { ensureAdSenseLoaded } from "@/components/ads/loadAdSense";

/**
 * Reopen Google's certified consent message (AdSense → Privacy & messaging, a
 * Funding Choices TCF CMP) so a visitor can review or withdraw their
 * advertising / analytics cookie consent — the "Manage privacy choices"
 * control referenced in the Privacy Policy and the footer.
 *
 * The CMP ships inside the AdSense loader, which we scope to article routes
 * (see loadAdSense.ts), so it is NOT present on the privacy page or in the
 * footer on first paint. This is a user-initiated action (no ad slots render),
 * so we load the CMP on demand and show the revocation message once Funding
 * Choices signals it is ready.
 *
 * Resolves `true` if the consent UI was shown, `false` if the CMP never became
 * available (e.g. a region where the message doesn't apply, or ads/CMP not yet
 * configured) so callers can fall back to the documented opt-out links.
 */
export function openPrivacyChoices(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);

  const show = (): boolean => {
    const fn = window.googlefc?.showRevocationMessage;
    if (typeof fn === "function") {
      fn();
      return true;
    }
    return false;
  };

  // CMP already loaded (e.g. navigated here from an article) — show immediately.
  if (show()) return Promise.resolve(true);

  ensureAdSenseLoaded();
  window.googlefc = window.googlefc || {};
  window.googlefc.callbackQueue = window.googlefc.callbackQueue || [];

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    // Funding Choices runs queued callbacks once it has initialized.
    window.googlefc!.callbackQueue!.push(() => finish(show()));

    // Safety net: some regions/configs never fire the queue, so poll briefly
    // and then give up, letting the caller fall back to the opt-out links.
    const started = Date.now();
    const poll = window.setInterval(() => {
      if (settled) {
        window.clearInterval(poll);
        return;
      }
      if (show()) {
        window.clearInterval(poll);
        finish(true);
        return;
      }
      if (Date.now() - started > 4000) {
        window.clearInterval(poll);
        finish(false);
      }
    }, 300);
  });
}

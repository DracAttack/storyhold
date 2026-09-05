export {};

declare global {
  interface Window {
    adsbygoogle: Array<Record<string, unknown>>;
    /**
     * Google Funding Choices / AdSense "Privacy & messaging" CMP API. Present
     * only after the AdSense loader has initialized. `showRevocationMessage`
     * reopens the consent choices; `callbackQueue` runs functions once the CMP
     * is ready. See src/lib/consent.ts.
     */
    googlefc?: {
      showRevocationMessage?: () => void;
      callbackQueue?: Array<(() => void) | Record<string, () => void>>;
    };
  }
}

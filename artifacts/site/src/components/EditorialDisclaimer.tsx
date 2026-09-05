import { EDITORIAL_DISCLAIMER_HTML } from "@/lib/policyContent";

/**
 * Reusable renderer for the "Editorial and Informational Disclaimer". The
 * copy lives in `src/lib/policyContent.ts` (the shared policy source of
 * truth, also consumed by the SSR meta server). The Contact, Corrections,
 * and Editorial Policy pages already include the disclaimer via their shared
 * `bodyHtml`, so this component currently has no call sites — it exists for
 * any future page that needs the disclaimer standalone. Rendered as raw
 * trusted markup so it inherits the surrounding `prose` styling.
 */
export default function EditorialDisclaimer() {
  return <div dangerouslySetInnerHTML={{ __html: EDITORIAL_DISCLAIMER_HTML }} />;
}

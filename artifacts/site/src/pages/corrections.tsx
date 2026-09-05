import PolicyPage from "@/components/layout/PolicyPage";
import { useSeo } from "@/lib/seo";
import { CORRECTIONS_POLICY } from "@/lib/policyContent";

/**
 * Thin renderer over the shared policy copy in `src/lib/policyContent.ts` —
 * the single source of truth also consumed by the production meta server's
 * crawler prerender. Edit the copy THERE, not here, so the visible page and
 * the server-rendered page can never drift apart. The body HTML is trusted,
 * hand-authored markup from our own module (never user input), which is why
 * `dangerouslySetInnerHTML` is safe here.
 */
export default function CorrectionsPage() {
  useSeo({
    title: "Corrections Policy — BrainHook",
    description:
      "BrainHook is committed to accuracy. Learn how to report an error, how we evaluate correction requests, and how we update published articles transparently.",
    canonicalPath: "/corrections",
    type: "website",
  });

  return (
    <PolicyPage
      eyebrow={CORRECTIONS_POLICY.eyebrow}
      title={CORRECTIONS_POLICY.title}
      intro={CORRECTIONS_POLICY.intro}
      updated={CORRECTIONS_POLICY.updated}
    >
      <div dangerouslySetInnerHTML={{ __html: CORRECTIONS_POLICY.bodyHtml }} />
    </PolicyPage>
  );
}

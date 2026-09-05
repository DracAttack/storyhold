import PolicyPage from "@/components/layout/PolicyPage";
import { useSeo } from "@/lib/seo";
import { TERMS_OF_USE } from "@/lib/policyContent";

/**
 * Thin renderer over the shared policy copy in `src/lib/policyContent.ts` —
 * the single source of truth also consumed by the production meta server's
 * crawler prerender. Edit the copy THERE, not here, so the visible page and
 * the server-rendered page can never drift apart. The body HTML is trusted,
 * hand-authored markup from our own module (never user input), which is why
 * `dangerouslySetInnerHTML` is safe here.
 */
export default function TermsPage() {
  useSeo({
    title: "Terms of Use — BrainHook",
    description:
      "The terms and conditions that govern your use of BrainHook, including acceptable use, intellectual property, disclaimers, and limitations of liability.",
    canonicalPath: "/terms",
    type: "website",
  });

  return (
    <PolicyPage
      eyebrow={TERMS_OF_USE.eyebrow}
      title={TERMS_OF_USE.title}
      intro={TERMS_OF_USE.intro}
      updated={TERMS_OF_USE.updated}
    >
      <div dangerouslySetInnerHTML={{ __html: TERMS_OF_USE.bodyHtml }} />
    </PolicyPage>
  );
}

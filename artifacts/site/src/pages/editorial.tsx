import PolicyPage from "@/components/layout/PolicyPage";
import { useSeo } from "@/lib/seo";
import { EDITORIAL_POLICY } from "@/lib/policyContent";

/**
 * Thin renderer over the shared policy copy in `src/lib/policyContent.ts` —
 * the single source of truth also consumed by the production meta server's
 * crawler prerender. Edit the copy THERE, not here, so the visible page and
 * the server-rendered page can never drift apart. The body HTML is trusted,
 * hand-authored markup from our own module (never user input), which is why
 * `dangerouslySetInnerHTML` is safe here.
 */
export default function EditorialPage() {
  useSeo({
    title: "Editorial Policy & Standards — BrainHook",
    description:
      "How BrainHook produces its research: rigorous editorial review, sourcing standards, and our commitment to accuracy and transparency.",
    canonicalPath: "/editorial-policy",
    type: "website",
  });

  return (
    <PolicyPage
      eyebrow={EDITORIAL_POLICY.eyebrow}
      title={EDITORIAL_POLICY.title}
      intro={EDITORIAL_POLICY.intro}
      updated={EDITORIAL_POLICY.updated}
    >
      <div dangerouslySetInnerHTML={{ __html: EDITORIAL_POLICY.bodyHtml }} />
    </PolicyPage>
  );
}

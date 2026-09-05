import PolicyPage from "@/components/layout/PolicyPage";
import { useSeo } from "@/lib/seo";
import { CONTACT_PAGE } from "@/lib/policyContent";

/**
 * Thin renderer over the shared policy copy in `src/lib/policyContent.ts` —
 * the single source of truth also consumed by the production meta server's
 * crawler prerender. Edit the copy THERE, not here, so the visible page and
 * the server-rendered page can never drift apart. The body HTML is trusted,
 * hand-authored markup from our own module (never user input), which is why
 * `dangerouslySetInnerHTML` is safe here.
 */
export default function ContactPage() {
  useSeo({
    title: "Contact Us — BrainHook",
    description:
      "Get in touch with the BrainHook editorial team — for story tips, corrections, press inquiries, advertising, or general feedback.",
    canonicalPath: "/contact",
    type: "website",
  });

  return (
    <PolicyPage
      eyebrow={CONTACT_PAGE.eyebrow}
      title={CONTACT_PAGE.title}
      intro={CONTACT_PAGE.intro}
      updated={CONTACT_PAGE.updated}
    >
      <div dangerouslySetInnerHTML={{ __html: CONTACT_PAGE.bodyHtml }} />
    </PolicyPage>
  );
}

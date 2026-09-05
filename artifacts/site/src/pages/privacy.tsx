import PolicyPage from "@/components/layout/PolicyPage";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useSeo } from "@/lib/seo";
import { PRIVACY_POLICY } from "@/lib/policyContent";
import { openPrivacyChoices } from "@/lib/consent";

/**
 * Thin renderer over the shared policy copy in `src/lib/policyContent.ts` —
 * the single source of truth also consumed by the production meta server's
 * crawler prerender. Edit the copy THERE, not here, so the visible page and
 * the server-rendered page can never drift apart. The body HTML is trusted,
 * hand-authored markup from our own module (never user input), which is why
 * `dangerouslySetInnerHTML` is safe here.
 *
 * The "Manage privacy choices" button is a React control appended after the
 * body (it can't live in the trusted HTML string because it needs an onClick).
 * It reopens Google's certified consent message; the footer carries the same
 * control site-wide.
 */
export default function PrivacyPage() {
  useSeo({
    title: "Privacy Policy — BrainHook",
    description:
      "How BrainHook collects, uses, and protects your information — including newsletter data, cookies, and third-party advertising and analytics vendors such as Google AdSense.",
    canonicalPath: "/privacy",
    type: "website",
  });

  const handleManageChoices = async () => {
    const shown = await openPrivacyChoices();
    if (!shown) {
      toast("Consent options aren't available here", {
        description:
          "The consent message applies in the EEA, UK, and Switzerland. You can still opt out of personalized ads via Google Ads Settings and aboutads.info/choices.",
      });
    }
  };

  return (
    <PolicyPage
      eyebrow={PRIVACY_POLICY.eyebrow}
      title={PRIVACY_POLICY.title}
      intro={PRIVACY_POLICY.intro}
      updated={PRIVACY_POLICY.updated}
    >
      <div dangerouslySetInnerHTML={{ __html: PRIVACY_POLICY.bodyHtml }} />
      <div className="not-prose mt-10 border-t pt-8">
        <Button type="button" variant="outline" onClick={handleManageChoices}>
          Manage privacy choices
        </Button>
      </div>
    </PolicyPage>
  );
}

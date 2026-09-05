import { cn } from "@/lib/utils";
import { ADSENSE_CLIENT, AD_SLOTS } from "./adsense-config";
import { useAdSense } from "./useAdSense";

interface InlineAdProps {
  /** Numeric AdSense ad-unit slot ID. Defaults to the in-article unit. */
  slot?: string;
  className?: string;
}

// Manual, responsive in-article ad unit. Drop it anywhere inside an article
// body. Renders a fluid in-article <ins> and collapses cleanly when the slot
// is unfilled (no fake placeholder box).
export function InlineAd({ slot = AD_SLOTS.inArticle, className }: InlineAdProps) {
  const { insRef, status } = useAdSense<HTMLModElement>();

  if (status === "unfilled") return null;

  return (
    <div
      className={cn("not-prose flex flex-col w-full my-10", className)}
      // Reserve approximate ad height until AdSense reports fill status so the
      // article body doesn't jump when the ad loads (CLS / Core Web Vitals).
      // Collapses to natural height once filled; unmounts entirely if unfilled.
      style={status === "loading" ? { minHeight: 250 } : undefined}
    >
      {status === "filled" && (
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
          Advertisement
        </span>
      )}
      <ins
        ref={insRef}
        className="adsbygoogle"
        style={{ display: "block", width: "100%", textAlign: "center" }}
        data-ad-client={ADSENSE_CLIENT}
        data-ad-slot={slot}
        data-ad-format="fluid"
        data-ad-layout="in-article"
        data-full-width-responsive="true"
      />
    </div>
  );
}

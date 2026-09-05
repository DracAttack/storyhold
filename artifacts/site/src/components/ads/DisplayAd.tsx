import { cn } from "@/lib/utils";
import { ADSENSE_CLIENT, AD_SLOTS } from "./adsense-config";
import { useAdSense } from "./useAdSense";

interface DisplayAdProps {
  /** Numeric AdSense ad-unit slot ID. Defaults to the leaderboard unit. */
  slot?: string;
  className?: string;
  /** Optional max height for the ad container (e.g. leaderboard banners). */
  maxHeight?: number;
  /**
   * AdSense responsive format hint. "auto" (default) lets Google pick any
   * shape; "vertical" requests tall/skyscraper creatives for sidebars.
   */
  format?: "auto" | "vertical" | "horizontal" | "rectangle";
}

// Manual, responsive display ad unit for non-inline placements (leaderboards,
// rectangles, sidebars). Collapses cleanly when the slot is unfilled.
export function DisplayAd({
  slot = AD_SLOTS.leaderboard,
  className,
  maxHeight,
  format = "auto",
}: DisplayAdProps) {
  const { insRef, status } = useAdSense<HTMLModElement>();

  if (status === "unfilled") return null;

  return (
    <div
      className={cn("not-prose flex flex-col w-full my-8", className)}
      // Reserve approximate ad height until AdSense reports fill status so
      // surrounding content doesn't jump when the ad loads (CLS / Core Web
      // Vitals). Collapses once filled; unmounts entirely if unfilled.
      style={status === "loading" ? { minHeight: Math.min(maxHeight ?? 280, 280) } : undefined}
    >
      {status === "filled" && (
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
          Advertisement
        </span>
      )}
      <ins
        ref={insRef}
        className="adsbygoogle"
        style={{ display: "block", width: "100%", ...(maxHeight ? { maxHeight } : {}) }}
        data-ad-client={ADSENSE_CLIENT}
        data-ad-slot={slot}
        data-ad-format={format}
        data-full-width-responsive={format === "auto" ? "true" : "false"}
      />
    </div>
  );
}

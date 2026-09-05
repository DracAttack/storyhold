/**
 * The exact stored-card canvases. Each concept produces TWO independently
 * rendered outputs — the SAME shared card component in two native CSS
 * layout formats (never one composition resized/letterboxed into the other):
 *
 *   - "feed" — 4:5 card (1080×1350) on a 1200×1470 transparent canvas.
 *     The Facebook feed / Term of the Day card
 *     (concepts.card_image_url, stored under glossary-cards-fb/).
 *   - "reel" — 9:16 card (1080×1920) on a 1200×2040 transparent canvas.
 *     The reels/stories card
 *     (concepts.reels_image_url, stored under glossary-cards/).
 *
 * The card sits centered inside a CANVAS_PAD border of TRANSPARENT padding
 * with the stacked-card decoration rendered around it — a rotated dark
 * backing sheet plus a rotated amber sheet (the same look as the admin
 * gallery previews), so the stored PNG carries the full CSS "stacked card"
 * aesthetic instead of being a flush-cropped rectangle. The capture
 * screenshots with omitBackground, so everything outside the sheets stays
 * transparent. This component is what the server-side headless-Chromium
 * capture screenshots (via the /card-render page) — it IS the stored PNG.
 */

import {
  GlossaryShareCard,
  CARD_FORMAT_DIMS,
  type CardFormat,
  type ConceptForCard,
} from "@/components/GlossaryShareCard";

export type CardVariant = CardFormat;

/** Card dimensions per variant (the inner card itself). */
export const VARIANT_DIMS = CARD_FORMAT_DIMS;

/** Transparent padding around the card that hosts the stacked-sheet look.
 *  Sized so the rotated sheets (max overhang ≈ 46px) never clip. */
export const CANVAS_PAD = 60;

/** Final stored-PNG dimensions per variant (card + padding). */
export const CAPTURE_CANVAS_DIMS: Record<CardVariant, { w: number; h: number }> = {
  feed: { w: CARD_FORMAT_DIMS.feed.w + CANVAS_PAD * 2, h: CARD_FORMAT_DIMS.feed.h + CANVAS_PAD * 2 },
  reel: { w: CARD_FORMAT_DIMS.reel.w + CANVAS_PAD * 2, h: CARD_FORMAT_DIMS.reel.h + CANVAS_PAD * 2 },
};

export function GlossaryCardCanvas({
  concept,
  id,
  variant = "feed",
}: {
  concept: ConceptForCard;
  id?: string;
  variant?: CardVariant;
}) {
  const { w, h } = VARIANT_DIMS[variant];
  const outer = CAPTURE_CANVAS_DIMS[variant];
  return (
    <div
      id={id}
      style={{
        width: outer.w,
        height: outer.h,
        position: "relative",
        background: "transparent",
        overflow: "hidden",
      }}
    >
      {/* Dark backing sheet — rotated, sits furthest back */}
      <div
        style={{
          position: "absolute",
          top: CANVAS_PAD - 24,
          left: CANVAS_PAD - 24,
          width: w + 48,
          height: h + 48,
          borderRadius: 36,
          transform: "rotate(-1deg)",
          background: "linear-gradient(145deg, #141414 0%, #000000 55%, #0a0a0a 100%)",
          boxShadow: "inset 0 3px 0 rgba(255,255,255,0.07), inset 0 -3px 0 rgba(0,0,0,0.9)",
        }}
      />
      {/* Amber accent sheet — rotated the other way */}
      <div
        style={{
          position: "absolute",
          top: CANVAS_PAD - 12,
          left: CANVAS_PAD - 12,
          width: w + 24,
          height: h + 24,
          borderRadius: 36,
          transform: "rotate(2deg)",
          background: "linear-gradient(135deg, rgba(245,168,78,0.10) 0%, rgba(245,168,78,0.02) 55%, transparent 100%)",
          border: "3px solid rgba(245,168,78,0.20)",
        }}
      />
      {/* The card itself — centered, on top of the sheets */}
      <div
        style={{
          position: "absolute",
          top: CANVAS_PAD,
          left: CANVAS_PAD,
          width: w,
          height: h,
          borderRadius: 28,
          overflow: "hidden",
          boxShadow: "0 0 0 3px #2A2A32",
        }}
      >
        <GlossaryShareCard concept={concept} captureMode format={variant} />
      </div>
    </div>
  );
}

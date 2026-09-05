/**
 * GlossaryShareCard — CSS-rendered share card with two native layout formats:
 *
 *   - "reel" — 1080×1920 (9:16 portrait), reels/stories.
 *   - "feed" — 1080×1350 (4:5 portrait), Facebook feed / Term of the Day.
 *
 * ONE shared component, two CSS geometry variants — never a resized or
 * letterboxed copy of the other format. Each format is rendered natively in
 * headless Chromium and screenshotted at its exact output dimensions.
 *
 * Font sizes are fully dynamic in two passes:
 *   1. A heuristic contentScale derived from total character volume gives a
 *      good first guess (short cards large and airy, dense cards smaller).
 *   2. A measurement-based fit pass then reads the ACTUAL rendered height of
 *      the text column and shrinks further if it overflows — so long
 *      definitions can never bleed past the footer, on either format.
 * The card sets data-fitted="true" once the fit loop settles; the
 * /card-render capture page waits for that flag before screenshotting.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Lightbulb } from "lucide-react";
import brainMark from "@/assets/brainhook-mark.png";
import nebulaBg           from "@/assets/nebula-bg.jpg";
import bgMagnetar         from "@/assets/card-bg-magnetar.jpg";
import bgEclipse          from "@/assets/card-bg-eclipse.png";
import bgCoral            from "@/assets/card-bg-coral.png";
import bgRainforest       from "@/assets/card-bg-rainforest.png";
import bgForensic         from "@/assets/card-bg-forensic.jpg";
import bgCliffside        from "@/assets/card-bg-cliffside.jpg";
import bgFireball         from "@/assets/card-bg-fireball.jpg";
import bgDeadStar         from "@/assets/card-bg-deadstar.jpg";
import bgParasite         from "@/assets/card-bg-parasite.jpg";
import bgButterflyNebula  from "@/assets/card-bg-butterfly-nebula.jpg";
import bgPlanetNine       from "@/assets/card-bg-planet-nine.jpg";
import bgBacteria         from "@/assets/card-bg-bacteria.jpg";
import bgBlackHole        from "@/assets/card-bg-blackhole.jpg";
import bgReef             from "@/assets/card-bg-reef.jpg";
import bgQuasar           from "@/assets/card-bg-quasar.jpg";
import bgStudio           from "@/assets/card-bg-studio.jpg";
import bgBrain            from "@/assets/card-bg-brain.jpg";
import bgStreamer         from "@/assets/card-bg-streamer.jpg";
import bgWebbStars        from "@/assets/card-bg-webb-stars.jpg";
import bgSolarStorm       from "@/assets/card-bg-solar-storm.jpg";
import bgStellarSnake     from "@/assets/card-bg-stellar-snake.jpg";
import bgTelescope        from "@/assets/card-bg-telescope.jpg";
import bgChagas           from "@/assets/card-bg-chagas.jpg";
import bgRomanTelescope   from "@/assets/card-bg-roman-telescope.jpg";
import bgFoxMouse         from "@/assets/card-bg-fox-mouse.jpg";
import bgDnaNeuron        from "@/assets/card-bg-dna-neuron.jpg";
import bgKrasProtein      from "@/assets/card-bg-kras-protein.jpg";
import { isLatinAlias } from "@/lib/utils";

/** Full pool of card backgrounds (28 images). */
const CARD_BACKGROUNDS: string[] = [
  nebulaBg,
  bgMagnetar,
  bgEclipse,
  bgCoral,
  bgRainforest,
  bgForensic,
  bgCliffside,
  bgFireball,
  bgDeadStar,
  bgParasite,
  bgButterflyNebula,
  bgPlanetNine,
  bgBacteria,
  bgBlackHole,
  bgReef,
  bgQuasar,
  bgStudio,
  bgBrain,
  bgStreamer,
  bgWebbStars,
  bgSolarStorm,
  bgStellarSnake,
  bgTelescope,
  bgChagas,
  bgRomanTelescope,
  bgFoxMouse,
  bgDnaNeuron,
  bgKrasProtein,
];

/** Stable, deterministic pick from the pool keyed on concept id. */
function pickBackground(id: string): string {
  const hash = id.split("").reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0, 0);
  return CARD_BACKGROUNDS[Math.abs(hash) % CARD_BACKGROUNDS.length];
}

export interface ConceptForCard {
  id: string;
  slug: string;
  term: string;
  definition: string;
  hoverDefinition: string;
  realLifeExample: string | null;
  whatItIsnt: string | null;
  commonlyMisusedOnline: string | null;
  moduleType: string | null;
  aliases: string[];
  /** Stored 4:5 feed card URL (glossary-cards-fb/{slug}-card.png). */
  cardImageUrl?: string | null;
  /** Stored 9:16 reels card URL (glossary-cards/{slug}-snap.png). */
  reelsImageUrl?: string | null;
  /** Hero image from a randomly-selected linked article — used as card background. */
  heroImageUrl?: string | null;
  /** Admin opt-out: never eligible for Term of the Day. */
  termOfDayBlocked?: boolean;
  /** Admin mark: queued for the "backfill & review" regeneration sweep. */
  backfillRequested?: boolean;
}

const W = 1080;

export type CardFormat = "reel" | "feed";

/**
 * Per-format geometry. The reel values are the original 9:16 design; the
 * feed variant is a native 4:5 layout — tighter spacing, smaller brand
 * block, and a content-scale multiplier for the reduced vertical room.
 */
const FORMAT_GEOM = {
  reel: {
    h: 1920,
    contentPadding: "60px 72px 56px",
    brandMark: 70, brandTitleFs: 44, brandSubFs: 19, brandGap: 20, brandMb: 40,
    termFsMult: 1,
    termMbAlias: 22, termMbNoAlias: 28,
    aliasMb: 28,
    dividerMb: 32,
    defMb: 36,
    sectionMb: 28,
    footerPt: 22, footerMt: 28,
    /** Multiplier on the volume-derived content scale (vertical room). */
    csMult: 1, csMin: 0.48,
  },
  feed: {
    h: 1350,
    contentPadding: "44px 64px 40px",
    brandMark: 58, brandTitleFs: 38, brandSubFs: 17, brandGap: 16, brandMb: 26,
    termFsMult: 0.88,
    termMbAlias: 16, termMbNoAlias: 20,
    aliasMb: 20,
    dividerMb: 22,
    defMb: 26,
    sectionMb: 20,
    footerPt: 18, footerMt: 20,
    csMult: 0.78, csMin: 0.4,
  },
} as const;

export const CARD_FORMAT_DIMS: Record<CardFormat, { w: number; h: number }> = {
  reel: { w: W, h: FORMAT_GEOM.reel.h },
  feed: { w: W, h: FORMAT_GEOM.feed.h },
};

// Term title: scales only with the term's own length (it's always 1–2 lines).
function termFs(term: string): number {
  const l = term.length;
  if (l <= 12) return 87;
  if (l <= 20) return 75;
  if (l <= 30) return 65;
  if (l <= 42) return 57;
  return 49;
}

/**
 * Derive a scale multiplier from total content volume using a sqrt curve.
 *
 * Font size ∝ 1/√total — this naturally keeps text large for sparse cards
 * (fills the space) while shrinking proportionally for dense ones.
 * Reference point: at 300 chars the card is near-full at base font sizes.
 * The overflow:hidden on the top section ensures the footer is always visible
 * even if the very densest cards clip the last line of the final section.
 */
function computeContentScale(
  def: string,
  rl: string | null,
  wii: string | null,
  cm: string | null,
): number {
  const total = def.length + (rl?.length ?? 0) + (wii?.length ?? 0) + (cm?.length ?? 0);
  const ref = 300; // chars at which scale = 1.0 and the card fills nicely
  const raw = Math.sqrt(ref / Math.max(total, ref));
  return Math.max(0.48, Math.min(1.0, raw));
}

function ScaleWrapper({
  children,
  scale,
  height,
  innerRef,
}: {
  children: React.ReactNode;
  scale: number;
  height: number;
  innerRef?: React.RefCallback<HTMLDivElement>;
}) {
  return (
    <div style={{ position: "relative", width: "100%", height: height * scale, overflow: "hidden" }}>
      <div
        ref={innerRef}
        style={{
          width: W,
          height,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          position: "absolute",
          top: 0,
          left: 0,
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function GlossaryShareCard({
  concept,
  onCardRef,
  captureMode = false,
  format = "reel",
}: {
  concept: ConceptForCard;
  onCardRef?: React.RefCallback<HTMLDivElement>;
  /**
   * When true, bypasses ResizeObserver scaling and always renders at scale=1
   * (the container must be exactly W=1080px wide). Used by the /card-render
   * headless-capture page so the screenshot PNG is always correctly sized.
   */
  captureMode?: boolean;
  /** Native layout format — "reel" 1080×1920 (default) or "feed" 1080×1350. */
  format?: CardFormat;
}) {
  const G = FORMAT_GEOM[format];
  const H = G.h;
  const outerRef = useRef<HTMLDivElement>(null);
  const [observedScale, setObservedScale] = useState(0.5);
  const scale = captureMode ? 1 : observedScale;

  // ── Measurement-based fit pass ─────────────────────────────────────────
  // The heuristic content scale is only an estimate; this loop measures the
  // real rendered height of the text column and shrinks the fonts until the
  // content genuinely fits above the footer. Transform scaling does not
  // affect scrollHeight/clientHeight, so measurements are exact regardless
  // of the preview zoom.
  const FIT_FLOOR = 0.5; // never shrink below half the heuristic size
  const measureRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  const [fitted, setFitted] = useState(false);
  const [fontsTick, setFontsTick] = useState(0);

  const contentKey = `${concept.id}|${format}|${concept.term}|${concept.definition}|${concept.hoverDefinition}|${concept.realLifeExample ?? ""}|${concept.whatItIsnt ?? ""}|${concept.commonlyMisusedOnline ?? ""}|${concept.aliases.join(",")}`;

  useLayoutEffect(() => {
    setFit(1);
    setFitted(false);
  }, [contentKey]);

  // Re-measure once webfonts finish loading (late font swap can change layout).
  useEffect(() => {
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (!cancelled) setFontsTick((t) => t + 1);
    });
    return () => { cancelled = true; };
  }, []);

  useLayoutEffect(() => {
    const el = measureRef.current;
    if (!el) { setFitted(true); return; }
    const overflow = el.scrollHeight - el.clientHeight;
    if (overflow > 1 && fit > FIT_FLOOR) {
      // Shrink proportionally to the measured overflow (fonts scale line
      // height too, so one ratio step converges fast; the loop guards the rest).
      const ratio = el.clientHeight / el.scrollHeight;
      setFit((f) => Math.max(FIT_FLOOR, f * Math.min(0.98, ratio * 0.99)));
      if (fitted) setFitted(false);
    } else if (!fitted) {
      setFitted(true);
    }
  });
  // fontsTick participates via the re-render it triggers; reference it so
  // linters see the dependency intent.
  void fontsTick;

  /** One background per concept — stable across re-renders; varies across cards. */
  const fallbackBg = useMemo(() => pickBackground(concept.id), [concept.id]);

  useEffect(() => {
    if (captureMode) return; // scale is fixed at 1 — no observer needed
    const el = outerRef.current;
    if (!el) return;
    // Guard: offsetWidth can momentarily report 0 during React re-renders
    // (e.g. while a parent state update is in flight). Ignore those callbacks
    // so the card never collapses to zero height mid-rebuild.
    const update = () => { const w = el.offsetWidth; if (w > 10) setObservedScale(w / W); };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [captureMode]);

  const def = concept.definition || concept.hoverDefinition;
  const hasAlias = concept.aliases.length > 0;
  const hasRL    = !!concept.realLifeExample;
  const hasWII   = !!concept.whatItIsnt;
  const hasCM    = !!concept.commonlyMisusedOnline;

  const rlLabel =
    concept.moduleType === "medical"
      ? "WHAT IT DOES"
      : concept.moduleType === "technical"
      ? "WHERE IT APPEARS"
      : "IN REAL LIFE";

  const aliasText = concept.aliases.filter(isLatinAlias).slice(0, 5).join(" · ");

  // ── Dynamic font sizes ────────────────────────────────────────────────
  // Base sizes represent the ideal for a short card. The content scale
  // shrinks all of them proportionally as total text volume grows; the
  // format multiplier accounts for the feed card's reduced vertical room.
  const heuristicCs = Math.max(
    G.csMin,
    computeContentScale(def, concept.realLifeExample, concept.whatItIsnt, concept.commonlyMisusedOnline) * G.csMult,
  );
  // The measured fit multiplier may push below the heuristic floor — that
  // floor is a taste guard for the estimate, but real overflow beats taste.
  const cs = Math.max(0.3, heuristicCs * fit);
  const BASE_DEF_BODY    = 64; // definition prose  — at scale 1.0, fills ~300-char card
  const BASE_SEC_BODY    = 54; // section body prose — proportional to def
  const BASE_SEC_LABEL   = 26; // coloured section header labels
  const BASE_ALIAS_BODY  = 58; // alias value text
  const defBodyFs      = Math.round(BASE_DEF_BODY    * cs);
  const secBodyFs      = Math.round(BASE_SEC_BODY    * cs);
  const secLabelFs     = secBodyFs; // same size as body text beneath each label
  const aliasLabelFs   = secBodyFs; // same constraint as all other coloured labels
  const aliasBodyFs    = Math.round(BASE_ALIAS_BODY  * cs);
  const footerUrlFs    = 37; // fixed — not constrained by dynamic content scale

  return (
    <div ref={outerRef} className="w-full">
      <ScaleWrapper scale={scale} height={H} innerRef={onCardRef}>
        {/* ── Card shell ─────────────────────────────────────────────── */}
        <div
          data-fitted={fitted ? "true" : "false"}
          style={{
            width: W,
            height: H,
            background: "linear-gradient(160deg, #18181F 0%, #101018 55%, #080810 100%)",
            display: "flex",
            flexDirection: "column",
            fontFamily: "system-ui, -apple-system, sans-serif",
            overflow: "hidden",
            position: "relative",
          }}
        >
          {/* ── Background: linked article hero (or pool fallback) ── */}
          <img src={concept.heroImageUrl ?? fallbackBg} alt="" style={{
            position: "absolute", inset: 0,
            width: "100%", height: "100%",
            objectFit: "cover", objectPosition: "50% 30%",
            opacity: 0.82, pointerEvents: "none", zIndex: 0,
            userSelect: "none",
          }} />

          {/* Subtle edge vignette — keeps text legible without burying the image */}
          <div style={{
            position: "absolute", inset: 0,
            background: "radial-gradient(ellipse 80% 70% at 50% 46%, transparent 30%, rgba(4,2,10,0.55) 100%)",
            pointerEvents: "none", zIndex: 1,
          }} />

          {/* Light dark wash — just enough to lift text off the nebula */}
          <div style={{
            position: "absolute", inset: 0,
            background: "rgba(4,2,12,0.28)",
            pointerEvents: "none", zIndex: 2,
          }} />

          {/* Glass sheen — top-left corner reflection */}
          <div style={{
            position: "absolute", inset: 0,
            background: "linear-gradient(138deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.01) 25%, transparent 50%)",
            pointerEvents: "none", zIndex: 3,
          }} />

          {/* ── Stacked-card effect (inside the 1080×1920 frame) ───────── */}
          {/* Outer card frame — amber border inset from edges; visible at any crop level */}
          <div style={{
            position: "absolute", inset: 18,
            border: "1.5px solid rgba(245,168,78,0.28)",
            borderRadius: 14,
            pointerEvents: "none", zIndex: 4,
          }} />
          {/* Inner card frame — lighter second ring for double-card depth */}
          <div style={{
            position: "absolute", inset: 36,
            border: "1px solid rgba(245,168,78,0.10)",
            borderRadius: 8,
            pointerEvents: "none", zIndex: 4,
          }} />
          {/* Right-edge depth strip — simulates card thickness/stack */}
          <div style={{
            position: "absolute", top: 18, right: 18, bottom: 18, width: 1,
            background: "rgba(245,168,78,0.18)",
            pointerEvents: "none", zIndex: 4,
          }} />
          {/* Bottom-edge depth strip */}
          <div style={{
            position: "absolute", left: 18, right: 18, bottom: 18, height: 1,
            background: "rgba(245,168,78,0.18)",
            pointerEvents: "none", zIndex: 4,
          }} />

          {/* Amber gleam — soft glow backing */}
          <div style={{
            position: "absolute",
            top: 0, left: 0, right: 0, height: 10,
            background: "linear-gradient(180deg, rgba(245,168,78,0.18) 0%, transparent 100%)",
            pointerEvents: "none", zIndex: 7,
          }} />
          {/* Amber gleam — thin bright line, fades at both edges */}
          <div style={{
            position: "absolute",
            top: 0, left: 0, right: 0, height: 2,
            background: "linear-gradient(90deg, transparent 0%, rgba(245,168,78,0.04) 5%, rgba(245,168,78,0.65) 22%, rgba(255,210,120,1.00) 44%, rgba(255,235,180,1.00) 52%, rgba(255,210,120,1.00) 60%, rgba(245,168,78,0.60) 76%, rgba(245,168,78,0.03) 93%, transparent 100%)",
            pointerEvents: "none", zIndex: 8,
          }} />

          {/* Synapse network — axon lines + soma nodes. The viewBox height
              tracks the format so nothing stretches; on the shorter feed
              card the lower nodes simply clip out of frame (decorative). */}
          <svg
            viewBox={`0 0 1080 ${H}`}
            xmlns="http://www.w3.org/2000/svg"
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 5 }}
          >
            <g fill="none" strokeLinecap="round">
              <path d="M540,1020 C460,820 280,640 160,430"    stroke="#F5A84E" strokeWidth="1"   opacity="0.11"/>
              <path d="M540,1020 C620,800 820,620 940,390"    stroke="#F5A84E" strokeWidth="0.9" opacity="0.10"/>
              <path d="M540,1020 C420,1000 220,1060 80,1130"  stroke="#F5A84E" strokeWidth="0.8" opacity="0.09"/>
              <path d="M540,1020 C680,1020 900,1060 1020,1110" stroke="#F5A84E" strokeWidth="0.8" opacity="0.09"/>
              <path d="M540,1020 C500,1180 440,1380 380,1600"  stroke="#F5A84E" strokeWidth="1"   opacity="0.10"/>
              <path d="M540,1020 C600,1200 660,1380 700,1620"  stroke="#F5A84E" strokeWidth="0.9" opacity="0.09"/>
              <path d="M160,430  C380,310 660,280 940,390"    stroke="#2DD4BF" strokeWidth="0.8" opacity="0.09"/>
              <path d="M80,1130  C200,1260 340,1480 380,1600"  stroke="#2DD4BF" strokeWidth="0.7" opacity="0.08"/>
              <path d="M1020,1110 C940,1280 800,1460 700,1620" stroke="#2DD4BF" strokeWidth="0.7" opacity="0.08"/>
              <path d="M360,730  C290,640 180,580 100,520"    stroke="#F5A84E" strokeWidth="0.6" opacity="0.08"/>
              <path d="M740,710  C820,630 920,560 1000,480"   stroke="#F5A84E" strokeWidth="0.6" opacity="0.08"/>
              <path d="M470,1200 C360,1280 240,1320 130,1380"  stroke="#2DD4BF" strokeWidth="0.6" opacity="0.07"/>
              <path d="M620,1200 C740,1280 880,1320 980,1380"  stroke="#2DD4BF" strokeWidth="0.6" opacity="0.07"/>
            </g>
            <g fill="#F5A84E">
              <circle cx="540"  cy="1020" r="6"   opacity="0.22"/>
              <circle cx="160"  cy="430"  r="4.5" opacity="0.18"/>
              <circle cx="940"  cy="390"  r="4"   opacity="0.16"/>
              <circle cx="80"   cy="1130" r="4"   opacity="0.16"/>
              <circle cx="1020" cy="1110" r="4"   opacity="0.16"/>
              <circle cx="380"  cy="1600" r="4"   opacity="0.15"/>
              <circle cx="700"  cy="1620" r="4"   opacity="0.15"/>
              <circle cx="360"  cy="730"  r="3"   opacity="0.14"/>
              <circle cx="740"  cy="710"  r="3"   opacity="0.14"/>
            </g>
            <g fill="#2DD4BF">
              <circle cx="540"  cy="390"  r="3.5" opacity="0.16"/>
              <circle cx="100"  cy="520"  r="3"   opacity="0.13"/>
              <circle cx="1000" cy="480"  r="3"   opacity="0.13"/>
              <circle cx="130"  cy="1380" r="3"   opacity="0.12"/>
              <circle cx="980"  cy="1380" r="3"   opacity="0.12"/>
            </g>
            <g fill="#FFFFFF" opacity="0.12">
              <circle cx="160"  cy="430"  r="1.5"/>
              <circle cx="940"  cy="390"  r="1.5"/>
              <circle cx="80"   cy="1130" r="1.5"/>
              <circle cx="1020" cy="1110" r="1.5"/>
              <circle cx="380"  cy="1600" r="1.5"/>
              <circle cx="700"  cy="1620" r="1.5"/>
            </g>
          </svg>

          {/* ── Content area: frosted glass panel over Vitruvian bg ── */}
          <div style={{
            flex: 1,
            padding: G.contentPadding,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            position: "relative",
            zIndex: 6,
            background: "linear-gradient(168deg, rgba(14,8,28,0.72) 0%, rgba(6,3,16,0.78) 100%)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07), inset 0 -1px 0 rgba(245,168,78,0.10)",
          }}>
            {/* Top section: clips at footer boundary — measured by the fit
                pass, which shrinks fonts until scrollHeight fits. */}
            <div ref={measureRef} style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>

              {/* Brand block */}
              <div style={{ display: "flex", alignItems: "center", gap: G.brandGap, marginBottom: G.brandMb, flexShrink: 0 }}>
                <img src={brainMark} alt="" style={{ width: G.brandMark, height: G.brandMark }} />
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{
                    fontFamily: "Georgia, 'Times New Roman', serif",
                    fontWeight: 700, fontSize: G.brandTitleFs,
                    color: "#FFFFFF", letterSpacing: -0.5, lineHeight: 1,
                  }}>
                    Brain<span style={{ color: "#F5A84E" }}>Hook</span>
                  </span>
                  <span style={{
                    fontWeight: 800, fontSize: G.brandSubFs,
                    color: "#F5A84E", letterSpacing: 4.5, textTransform: "uppercase",
                  }}>
                    Glossary
                  </span>
                </div>
              </div>

              {/* Term */}
              <div style={{
                fontFamily: "Georgia, 'Times New Roman', serif",
                fontWeight: 700,
                fontSize: Math.round(termFs(concept.term) * G.termFsMult),
                color: "#FBF9F4",
                lineHeight: 1.05, letterSpacing: -1.5,
                marginBottom: hasAlias ? G.termMbAlias : G.termMbNoAlias,
                flexShrink: 0,
              }}>
                {concept.term}
              </div>

              {/* Also known as */}
              {hasAlias && (
                <div style={{
                  borderLeft: "4px solid #5BA4BF",
                  paddingLeft: 22, marginBottom: G.aliasMb,
                  flexShrink: 0, display: "flex", flexDirection: "column", gap: 6,
                }}>
                  <span style={{ fontWeight: 700, fontSize: aliasLabelFs, color: "#7EC8E3", letterSpacing: 2.5, textTransform: "uppercase", display: "flex", alignItems: "center", gap: 10 }}>
                    <Lightbulb style={{ width: aliasLabelFs, height: aliasLabelFs, flexShrink: 0 }} />
                    Also known as
                  </span>
                  <span style={{ fontWeight: 700, fontSize: aliasBodyFs, color: "#FBF9F4" }}>
                    {aliasText}
                  </span>
                </div>
              )}

              {/* Amber divider */}
              <div style={{ height: 1, background: "rgba(245,168,78,0.25)", marginBottom: G.dividerMb, flexShrink: 0 }} />

              {/* Definition */}
              <div style={{
                fontFamily: "Georgia, 'Times New Roman', serif",
                fontWeight: 700, fontSize: defBodyFs,
                color: "#FBF9F4", lineHeight: 1.65,
                marginBottom: (hasRL || hasWII || hasCM) ? G.defMb : 0,
                flexShrink: 0,
              }}>
                {def}
              </div>

              {/* ── In real life — teal ── */}
              {hasRL && (
                <div style={{
                  borderLeft: "4px solid #2DD4BF", paddingLeft: 22,
                  marginBottom: (hasWII || hasCM) ? G.sectionMb : 0,
                  flexShrink: 0, display: "flex", flexDirection: "column", gap: 8,
                }}>
                  <span style={{ fontWeight: 700, fontSize: secLabelFs, color: "#2DD4BF", letterSpacing: 2.5, textTransform: "uppercase" }}>
                    ⚡ {rlLabel}
                  </span>
                  <span style={{ fontWeight: 700, fontSize: secBodyFs, color: "#FBF9F4", lineHeight: 1.6 }}>
                    {concept.realLifeExample}
                  </span>
                </div>
              )}

              {/* ── What it isn't — amber ── */}
              {hasWII && (
                <div style={{
                  borderLeft: "4px solid #F5A84E", paddingLeft: 22,
                  marginBottom: hasCM ? G.sectionMb : 0,
                  flexShrink: 0, display: "flex", flexDirection: "column", gap: 8,
                }}>
                  <span style={{ fontWeight: 700, fontSize: secLabelFs, color: "#F5A84E", letterSpacing: 2.5, textTransform: "uppercase" }}>
                    🛡️ What it isn't
                  </span>
                  <span style={{ fontWeight: 700, fontSize: secBodyFs, color: "#FBF9F4", lineHeight: 1.6 }}>
                    {concept.whatItIsnt}
                  </span>
                </div>
              )}

              {/* ── Commonly misused — red ── */}
              {hasCM && (
                <div style={{
                  borderLeft: "4px solid #F87171", paddingLeft: 22,
                  flexShrink: 0, display: "flex", flexDirection: "column", gap: 8,
                }}>
                  <span style={{ fontWeight: 700, fontSize: secLabelFs, color: "#F87171", letterSpacing: 2.5, textTransform: "uppercase" }}>
                    ⚠️ Commonly misused
                  </span>
                  <span style={{ fontWeight: 700, fontSize: secBodyFs, color: "#FBF9F4", lineHeight: 1.6 }}>
                    {concept.commonlyMisusedOnline}
                  </span>
                </div>
              )}

            </div>{/* end top section */}

            {/* Footer */}
            <div style={{
              borderTop: "1px solid #2A2A32",
              paddingTop: G.footerPt, marginTop: G.footerMt,
              display: "flex", justifyContent: "space-between", alignItems: "center",
              flexShrink: 0,
            }}>
              <span style={{ fontSize: footerUrlFs, color: "#9B968C", letterSpacing: 0.5 }}>
                brainhook.net/glossary
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#F5A84E" }} />
                <div style={{ width: 7,  height: 7,  borderRadius: "50%", background: "rgba(245,168,78,0.5)" }} />
                <div style={{ width: 5,  height: 5,  borderRadius: "50%", background: "rgba(245,168,78,0.25)" }} />
              </div>
            </div>

          </div>{/* end content area */}
        </div>
      </ScaleWrapper>
    </div>
  );
}

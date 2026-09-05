/**
 * ConceptCard — inline dotted-underline trigger + hover/tap card.
 *
 * Desktop: shows a floating bubble on hover. Rendered via a portal at the
 * document body level (position:fixed) so it is never clipped by overflow or
 * z-index stacking from the article layout. Uses a 150ms close-delay so the
 * cursor can travel from trigger → card without the card disappearing.
 *
 * Mobile: tap to open; tap outside to close.
 */

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Link } from "wouter";
import { ExternalLink, ArrowUpRight } from "lucide-react";
import { trackEvent } from "@/lib/analytics";

interface ConceptCardProps {
  children: ReactNode;
  term: string;
  hoverDefinition: string;
  slug: string;
  wikiUrl?: string | null;
  /** Hidden terms have no public glossary page — suppress the link. */
  hidden?: boolean;
}

interface CardPos {
  /* horizontal centre of the trigger */
  cx: number;
  /* anchor y: either the top-of-trigger (if card opens below) or bottom-of-trigger (opens above) */
  anchorY: number;
  side: "top" | "bottom";
}

const CARD_WIDTH = 288; // px — keep in sync with inline style below
const CARD_MARGIN = 16; // min horizontal margin from viewport edge
const SIDE_OFFSET = 10; // gap between trigger and card edge

export default function ConceptCard({
  children,
  term,
  hoverDefinition,
  slug,
  wikiUrl,
  hidden,
}: ConceptCardProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CardPos>({ cx: 0, anchorY: 0, side: "top" });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTracked = useRef(false);

  /* ── helpers ─────────────────────────────────────────────── */
  const clearClose = useCallback(() => {
    if (closeTimer.current != null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    clearClose();
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  }, [clearClose]);

  const openCard = useCallback(() => {
    clearClose();
    if (!openTracked.current) {
      openTracked.current = true;
      trackEvent("concept_card_open", {
        item_id: slug,
        item_name: term,
        content_type: "concept",
      });
    }

    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Clamp horizontal centre so card never bleeds off screen
      const cx = Math.min(
        Math.max(rect.left + rect.width / 2, CARD_WIDTH / 2 + CARD_MARGIN),
        vw - CARD_WIDTH / 2 - CARD_MARGIN,
      );
      // Prefer opening above; flip below if insufficient space above
      const spaceAbove = rect.top;
      const spaceBelow = vh - rect.bottom;
      const side: "top" | "bottom" =
        spaceAbove >= 160 || spaceAbove >= spaceBelow ? "top" : "bottom";
      setPos({
        cx,
        anchorY: side === "top" ? rect.top - SIDE_OFFSET : rect.bottom + SIDE_OFFSET,
        side,
      });
    }
    setOpen(true);
  }, [clearClose, slug, term]);

  /* ── outside click closes the card ───────────────────────── */
  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => {
      // e.target can be null or a non-Node (shadow root, SVG doc) in some
      // browsers — guard before calling contains() or it throws a TypeError.
      const target = e.target;
      if (!(target instanceof Node)) return;
      // Clicks that land inside the trigger (toggles the card) or inside the
      // portal card (e.g. wouter <Link>, external <a>) are ignored so their
      // native click handlers still fire.
      if (triggerRef.current?.contains(target) ?? false) return;
      if (cardRef.current?.contains(target) ?? false) return;
      setOpen(false);
    };
    // Use 'click' (not mousedown/touchstart) so that wouter Link's onClick
    // fires first at the target, then bubbles here.  If we used mousedown
    // the document listener would fire *before* the Link's click handler and
    // unmount the portal, swallowing the navigation.
    document.addEventListener("click", onOutside);
    return () => document.removeEventListener("click", onOutside);
  }, [open]);

  /* ── scrolling closes ────────────────────────────────────── */
  // The card is position:fixed, so it does NOT follow the page when the user
  // scrolls — it would visibly decouple from its trigger term. Any scroll
  // (page or nested container, mouse wheel or touch) dismisses it, same as
  // tapping elsewhere. A short grace period absorbs the browser's own
  // scroll-into-view adjustment that can fire right as the trigger is focused.
  const openedAt = useRef(0);
  useEffect(() => {
    if (!open) return;
    openedAt.current = Date.now();
    const onScroll = () => {
      if (Date.now() - openedAt.current < 150) return;
      setOpen(false);
    };
    // capture:true so scrolls inside nested scrollable elements also dismiss
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => window.removeEventListener("scroll", onScroll, { capture: true });
  }, [open]);

  /* ── escape closes ───────────────────────────────────────── */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  /* ── compute card position style ───────────────────────── */
  const cardStyle: React.CSSProperties = {
    position: "fixed",
    width: CARD_WIDTH,
    left: pos.cx - CARD_WIDTH / 2,
    zIndex: 99999,
    // Cream bubble colours — explicit so dark-theme variables don't override
    background: "#FEFCE8",
    color: "#111",
    ...(pos.side === "top"
      ? { bottom: window.innerHeight - pos.anchorY }
      : { top: pos.anchorY }),
  };

  /* ── caret (small triangle) pointing toward the trigger ─── */
  const caretBase: React.CSSProperties = {
    position: "absolute",
    left: "50%",
    transform: "translateX(-50%)",
    width: 0,
    height: 0,
    border: "7px solid transparent",
  };
  const caretDown: React.CSSProperties = {
    ...caretBase,
    bottom: -14,
    borderTopColor: "#FEFCE8",
  };
  const caretUp: React.CSSProperties = {
    ...caretBase,
    top: -14,
    borderBottomColor: "#FEFCE8",
  };

  return (
    <>
      {/* ── trigger ───────────────────────────────────────── */}
      <button
        ref={triggerRef}
        type="button"
        className={[
          "cursor-help font-bold border-b border-dotted pb-[1px]",
          "border-foreground/60 hover:border-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "transition-colors",
        ].join(" ")}
        aria-expanded={open}
        aria-label={`Definition of ${term}`}
        onMouseEnter={openCard}
        onMouseLeave={scheduleClose}
        onClick={() => {
          if (!open) openCard();
          else setOpen(false);
        }}
        onFocus={openCard}
        onBlur={scheduleClose}
      >
        {children}
      </button>

      {/* ── portal card ───────────────────────────────────── */}
      {open &&
        createPortal(
          <div
            ref={cardRef}
            style={cardStyle}
            onMouseEnter={clearClose}
            onMouseLeave={scheduleClose}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
          >
            {/* bubble */}
            <div
              style={{
                borderRadius: 14,
                padding: "14px 16px 12px",
                boxShadow:
                  "0 8px 30px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.1)",
              }}
            >
              {/* Term */}
              <p
                style={{
                  margin: "0 0 6px 0",
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "#666",
                }}
              >
                {term}
              </p>

              {/* Definition */}
              <p style={{ margin: "0 0 10px 0", fontSize: 14, lineHeight: 1.55, color: "#111" }}>
                {hoverDefinition}
              </p>

              {/* Divider */}
              <hr style={{ border: "none", borderTop: "1px solid #e5e1d8", margin: "0 0 8px 0" }} />

              {/* Footer links */}
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                {!hidden && (
                <Link
                  href={`/glossary/${slug}`}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    fontSize: 13,
                    fontWeight: 700,
                    color: "#b45309",
                    textDecoration: "none",
                  }}
                  onClick={() => {
                    trackEvent("concept_glossary_click", {
                      item_id: slug,
                      item_name: term,
                      content_type: "concept",
                    });
                    setOpen(false);
                  }}
                  onMouseEnter={(e) =>
                    ((e.currentTarget as HTMLElement).style.textDecoration = "underline")
                  }
                  onMouseLeave={(e) =>
                    ((e.currentTarget as HTMLElement).style.textDecoration = "none")
                  }
                >
                  Full definition
                  <ArrowUpRight style={{ width: 14, height: 14 }} />
                </Link>
                )}

                {wikiUrl && (
                  <a
                    href={wikiUrl}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      fontSize: 12,
                      color: "#888",
                      textDecoration: "none",
                    }}
                    onClick={() =>
                      trackEvent("concept_wikipedia_click", {
                        item_id: slug,
                        item_name: term,
                        content_type: "concept",
                        source: "card",
                      })
                    }
                  >
                    Wikipedia
                    <ExternalLink style={{ width: 12, height: 12 }} />
                  </a>
                )}
              </div>
            </div>

            {/* caret */}
            <div style={pos.side === "top" ? caretDown : caretUp} />
          </div>,
          document.body,
        )}
    </>
  );
}

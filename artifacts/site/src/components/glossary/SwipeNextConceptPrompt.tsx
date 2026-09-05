import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import swipeThumb from "@/assets/swipe-thumb.png";

/**
 * Swipe-to-navigate gesture for glossary concept pages.
 *
 * Mirrors SwipeNextPrompt for articles — same gesture, same desktop chevron,
 * same auto-hide hint — but navigates to /glossary/:slug and shows once the
 * reader scrolls ~halfway through the concept definition.
 *
 * Swipe LEFT  → next concept (related, then alphabetical)
 * Swipe RIGHT → back a screen (browser history, else /glossary)
 */
export default function SwipeNextConceptPrompt({
  conceptSlug,
  target,
}: {
  conceptSlug: string;
  target: { slug: string; term: string } | undefined;
}) {
  const [, setLocation] = useLocation();
  const reduceMotion = useReducedMotion();
  const [visible, setVisible] = useState(false);

  const halfwayFiredRef = useRef(false);
  const activatedRef = useRef(false);
  const visibleRef = useRef(false);
  const pointerTypeRef = useRef<string>("");

  const [isDesktop] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(hover: hover) and (pointer: fine)").matches &&
      navigator.maxTouchPoints === 0,
  );

  const targetSlug = target?.slug;

  // Reset per-view state on concept navigation (SPA keeps component mounted).
  useEffect(() => {
    halfwayFiredRef.current = false;
    activatedRef.current = false;
    visibleRef.current = false;
    setVisible(false);
  }, [conceptSlug]);

  const reveal = () => {
    if (!targetSlug || activatedRef.current || visibleRef.current || halfwayFiredRef.current) return;
    halfwayFiredRef.current = true;
    visibleRef.current = true;
    setVisible(true);
  };

  // Trigger: reader scrolls ~halfway through the page.
  useEffect(() => {
    if (!targetSlug) return;
    const onScroll = () => {
      if (activatedRef.current || halfwayFiredRef.current) return;
      const doc = document.documentElement;
      const scrollable = doc.scrollHeight - window.innerHeight;
      if (scrollable <= 0) return;
      if (window.scrollY / scrollable >= 0.5) reveal();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conceptSlug, targetSlug]);

  const activate = (_method: "swipe" | "click") => {
    if (activatedRef.current || !targetSlug) return;
    activatedRef.current = true;
    visibleRef.current = false;
    setVisible(false);
    setLocation(`/glossary/${targetSlug}`);
  };

  const goBack = () => {
    if (visibleRef.current) {
      visibleRef.current = false;
      setVisible(false);
    }
    if (window.history.length > 1) window.history.back();
    else setLocation("/glossary");
  };

  const dismiss = () => {
    if (!visibleRef.current) return;
    visibleRef.current = false;
    setVisible(false);
  };

  // Always-on horizontal swipe gesture.
  useEffect(() => {
    let start: { x: number; y: number } | null = null;
    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (t) start = { x: t.clientX, y: t.clientY };
    };
    const onTouchEnd = (e: TouchEvent) => {
      const s = start;
      start = null;
      const t = e.changedTouches[0];
      if (!s || !t) return;
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);
      if (adx > 45 && adx > ady * 1.2) {
        if (dx < 0) activate("swipe");
        else goBack();
      }
    };
    const onTouchCancel = () => { start = null; };
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchCancel, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchCancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conceptSlug, targetSlug]);

  // Auto-hide hint 2s after reader scrolls/taps (700ms grace period first).
  useEffect(() => {
    if (!visible) return;
    let armed = false;
    let hideTimer: number | undefined;
    const armTimer = window.setTimeout(() => { armed = true; }, 700);
    const scheduleHide = () => {
      if (!armed || hideTimer !== undefined) return;
      hideTimer = window.setTimeout(() => dismiss(), 2000);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") dismiss(); };
    window.addEventListener("scroll", scheduleHide, { passive: true });
    window.addEventListener("touchstart", scheduleHide, { passive: true });
    window.addEventListener("click", scheduleHide);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(armTimer);
      if (hideTimer !== undefined) window.clearTimeout(hideTimer);
      window.removeEventListener("scroll", scheduleHide);
      window.removeEventListener("touchstart", scheduleHide);
      window.removeEventListener("click", scheduleHide);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!target || !targetSlug) return null;

  // DESKTOP — persistent chevron, expands to pill when hint is active.
  if (isDesktop) {
    return (
      <div className="fixed bottom-6 right-6 z-40 select-none">
        <button
          type="button"
          aria-label={`Next glossary term: ${target.term}`}
          onClick={() => activate("click")}
          className="flex items-center rounded-full border border-white/15 bg-neutral-900/95 py-2.5 pl-3 pr-2.5 text-white shadow-2xl backdrop-blur-sm transition-colors hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          <AnimatePresence initial={false}>
            {visible && (
              <motion.span
                key="click-next-label"
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, width: 0 }}
                animate={reduceMotion ? { opacity: 1 } : { opacity: 1, width: "auto" }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, width: 0 }}
                transition={{ duration: reduceMotion ? 0.15 : 0.3, ease: "easeOut" }}
                className="overflow-hidden whitespace-nowrap text-sm font-medium"
              >
                <span className="pl-1 pr-2">Next glossary term</span>
              </motion.span>
            )}
          </AnimatePresence>
          <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0" />
        </button>
      </div>
    );
  }

  // MOBILE — thumb-swipe graphic with "Got it" dismiss.
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="swipe-next-concept-prompt"
          aria-label={`Swipe to read the next term: ${target.term}`}
          className="pointer-events-none fixed bottom-0 right-0 z-40 touch-pan-y select-none"
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.85 }}
          animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.85 }}
          transition={{ duration: reduceMotion ? 0.15 : 0.3, ease: "easeOut" }}
        >
          <div className="pointer-events-none relative h-[19rem] w-[19rem] translate-x-[30%] translate-y-[32%] overflow-hidden rounded-full bg-neutral-900/95 text-white shadow-2xl backdrop-blur-sm">
            <button
              type="button"
              aria-label={`Next term: ${target.term}`}
              onPointerDown={(e) => { pointerTypeRef.current = e.pointerType; }}
              onClick={() => {
                if (pointerTypeRef.current === "touch") return;
                activate("click");
              }}
              className="pointer-events-auto absolute inset-0 touch-pan-y focus:outline-none"
            >
              {reduceMotion ? (
                <img
                  src={swipeThumb}
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                  className="absolute right-2 top-4 h-[22.5rem] w-auto select-none"
                />
              ) : (
                <motion.img
                  src={swipeThumb}
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                  className="absolute right-2 top-4 h-[22.5rem] w-auto select-none"
                  animate={{ x: [40, -40], opacity: [0, 1, 1, 0] }}
                  transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut", times: [0, 0.2, 0.8, 1] }}
                />
              )}
            </button>
            <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-neutral-900 via-neutral-900/85 to-transparent" />
            <p className="pointer-events-none absolute left-6 top-7 w-44 text-center text-lg font-semibold leading-tight">
              Swipe for
              <br />
              next term
            </p>
            <button
              type="button"
              onClick={() => { activatedRef.current = true; dismiss(); }}
              onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); dismiss(); } }}
              className="pointer-events-auto absolute left-9 top-[10.75rem] touch-pan-y rounded-full border border-white/40 bg-neutral-900/80 px-5 py-1.5 text-sm font-medium text-white backdrop-blur-sm transition-colors hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              Got it
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

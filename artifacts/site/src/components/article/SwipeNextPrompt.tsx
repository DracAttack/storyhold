import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import type { PublicArticleSummary } from "@workspace/api-client-react";
import { trackInternalClick, trackSwipeEvent } from "@/lib/journey";
import { isFirstArticleForSwipeHint } from "@/lib/swipeHint";
import swipeThumb from "@/assets/swipe-thumb.png";

/**
 * Swipe-to-navigate gesture for article pages, plus a small INFORMATIONAL hint
 * that tells the reader the gesture exists.
 *
 * The gesture is ALWAYS ON (whenever there is a next article to advance to),
 * regardless of whether the hint is on screen:
 *   - swipe LEFT  → next article (the deterministic catalog successor from
 *                   GET /public/articles/:slug/next — category then date order,
 *                   NOT the symmetric "More like this" rank-1 neighbor, which
 *                   ping-ponged between the same two articles)
 *   - swipe RIGHT → back a screen (browser history, else home)
 *
 * The hint is purely a display. It appears only on the FIRST article a reader
 * opens in a browsing session — at ~50% scroll and again at the author card —
 * and never again that session (see lib/swipeHint.ts, mirroring the subscribe
 * nudge's session bookkeeping). Once shown it auto-hides 0.5s after the reader
 * scrolls (incl. a vertical swipe) or taps, so it gets out of the way as soon as
 * they do anything; a short grace period after it appears keeps the revealing
 * scroll from closing it instantly.
 *
 * Lifecycle (anonymous, PII-free) is reported via the journey beacons:
 *   - impression  — each time the hint becomes visible (once per trigger)
 *   - activation  — reader swipes to the next article (or clicks the hint on
 *                   desktop); `method` = swipe | click
 *   - dismissal   — the hint goes away without the reader taking the suggestion
 *
 * DESKTOP (fine pointer, e.g. mouse/trackpad): the thumb-swipe graphic is a
 * touch metaphor, so it never shows. Instead a small always-present chevron
 * button sits in the bottom-right corner (click → next article — the always-on
 * counterpart of the swipe gesture). The SAME hint triggers and timing expand
 * it into a "Click for next article" pill, and the SAME auto-hide collapses it
 * back to just the chevron after a few seconds.
 *
 * Honors prefers-reduced-motion; all per-view state resets when `articleSlug`
 * changes (SPA navigation keeps this component mounted across articles).
 */
export default function SwipeNextPrompt({
  articleSlug,
  target,
}: {
  /** Slug of the article currently being read (the swipe's origin). */
  articleSlug: string;
  /** Next article (catalog successor) to advance to, or undefined when none. */
  target: PublicArticleSummary | undefined;
}) {
  const [, setLocation] = useLocation();
  const reduceMotion = useReducedMotion();
  const [visible, setVisible] = useState(false);
  // Per-view guards. Each reveal trigger (halfway scroll, author card) fires at
  // most once; `activatedRef` permanently stops the hint for this view. All reset
  // when `articleSlug` changes.
  const halfwayFiredRef = useRef(false);
  const authorFiredRef = useRef(false);
  const activatedRef = useRef(false);
  // Mirror of `visible` readable inside callbacks (which close over stale state)
  // so a trigger never re-fires while the hint is already up, and so dismiss is
  // idempotent across overlapping events.
  const visibleRef = useRef(false);
  // Whether the current article is the session's first read (the only article the
  // informational hint is allowed to appear on). Computed per article.
  const firstArticleRef = useRef(false);
  // The pointer kind that initiated the current interaction. Touch taps fire a
  // synthetic click, so we record the kind on pointerdown and let the hint's own
  // `onClick` activate only for mouse/pen — touch goes through the swipe path.
  const pointerTypeRef = useRef<string>("");
  // Fine-pointer (mouse/trackpad) devices get the chevron affordance instead of
  // the thumb-swipe graphic. Computed once — device class doesn't change
  // mid-session, and hybrids (touch laptops) keep the swipe gesture regardless.
  // Fine-pointer AND no touch capability = true desktop. Some mobile browsers
  // incorrectly report (hover: hover) and (pointer: fine), so we also require
  // maxTouchPoints === 0 to avoid showing the desktop chevron on touch devices.
  const [isDesktop] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(hover: hover) and (pointer: fine)").matches &&
      navigator.maxTouchPoints === 0,
  );

  const targetSlug = target?.slug;

  // Reset per-view state and recompute first-article eligibility whenever the
  // article changes (SPA navigation keeps this component mounted across articles).
  useEffect(() => {
    halfwayFiredRef.current = false;
    authorFiredRef.current = false;
    activatedRef.current = false;
    visibleRef.current = false;
    setVisible(false);
    firstArticleRef.current = isFirstArticleForSwipeHint(articleSlug);
  }, [articleSlug]);

  // Shared reveal: shows the hint for a given trigger at most once per view, and
  // only on the session's first article. Skips when already resolved (activated)
  // or already visible — so the two triggers never stack.
  const reveal = (trigger: "halfway" | "author") => {
    if (!targetSlug || !firstArticleRef.current) return;
    if (activatedRef.current || visibleRef.current) return;
    const firedRef = trigger === "halfway" ? halfwayFiredRef : authorFiredRef;
    if (firedRef.current) return;
    firedRef.current = true;
    visibleRef.current = true;
    setVisible(true);
    trackSwipeEvent({ articleSlug, targetSlug, eventType: "impression" });
  };

  // Trigger 1: reader scrolls ~halfway through the page.
  useEffect(() => {
    if (!targetSlug || !firstArticleRef.current) return;
    const onScroll = () => {
      if (activatedRef.current || halfwayFiredRef.current) return;
      const doc = document.documentElement;
      const scrollable = doc.scrollHeight - window.innerHeight;
      if (scrollable <= 0) return;
      const progress = window.scrollY / scrollable;
      if (progress >= 0.5) reveal("halfway");
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    // Run once in case the page is already past the threshold (e.g. short body).
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articleSlug, targetSlug]);

  // Trigger 2: reader reaches the author card / bio at the end of the article.
  useEffect(() => {
    if (!targetSlug || !firstArticleRef.current) return;
    const card = document.querySelector("[data-swipe-author-card]");
    if (!card) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) reveal("author");
        }
      },
      { threshold: 0.4 },
    );
    observer.observe(card);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articleSlug, targetSlug]);

  const activate = (method: "swipe" | "click") => {
    if (activatedRef.current || !targetSlug) return;
    activatedRef.current = true;
    visibleRef.current = false;
    setVisible(false);
    trackSwipeEvent({ articleSlug, targetSlug, eventType: "activation", method });
    trackInternalClick({
      toSlug: targetSlug,
      fromSlug: articleSlug,
      placement: "swipe_next",
      recommendationRank: 1,
      interactionType: method === "swipe" ? "swipe" : "click",
    });
    setLocation(`/article/${targetSlug}`);
  };

  // Swipe right → go back a screen, falling back to the home feed when there's
  // nothing in-session to return to. If the hint happened to be up, records a
  // dismissal (the suggestion wasn't taken) and hides it.
  const goBack = () => {
    if (visibleRef.current) {
      visibleRef.current = false;
      setVisible(false);
      if (targetSlug) trackSwipeEvent({ articleSlug, targetSlug, eventType: "dismissal" });
    }
    if (window.history.length > 1) window.history.back();
    else setLocation("/");
  };

  // Hide the current showing without resolving the view. Idempotent (guards on
  // visibleRef) so overlapping events only report one dismissal.
  const dismiss = () => {
    if (!visibleRef.current) return;
    visibleRef.current = false;
    setVisible(false);
    if (targetSlug) trackSwipeEvent({ articleSlug, targetSlug, eventType: "dismissal" });
  };

  // Always-on navigation gesture (independent of the hint): a horizontal swipe
  // LEFT advances to the next article — the catalog successor (category then
  // date), not the related rail — only when there is one; RIGHT always goes back
  // a screen. Bound to the window so it
  // works anywhere on the page. Touch listeners are passive (never preventDefault)
  // so normal scrolling is unaffected.
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
        if (dx < 0) activate("swipe"); // swipe left → next article
        else goBack(); // swipe right → back a screen
      }
    };
    const onTouchCancel = () => {
      start = null;
    };
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchCancel, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchCancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articleSlug, targetSlug]);

  // Auto-hide the informational hint 2s after the reader scrolls (incl. a
  // vertical swipe) or taps. A ~0.7s grace period after it appears keeps the
  // revealing scroll from dismissing it instantly. Escape closes it immediately.
  useEffect(() => {
    if (!visible) return;
    let armed = false;
    let hideTimer: number | undefined;
    const armTimer = window.setTimeout(() => {
      armed = true;
    }, 700);
    const scheduleHide = () => {
      if (!armed || hideTimer !== undefined) return;
      hideTimer = window.setTimeout(() => dismiss(), 2000);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
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

  // DESKTOP: no thumb graphic. A small chevron button is always available in
  // the bottom-right corner (the click counterpart of the always-on swipe
  // gesture). The hint triggers expand it into a labelled pill; the shared
  // auto-hide collapses it back to just the chevron on the same timing.
  if (isDesktop) {
    return (
      <div className="fixed bottom-6 right-6 z-40 select-none">
        <button
          type="button"
          aria-label={`Read the next article: ${target.title}`}
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
                <span className="pl-1 pr-2">Click for next article</span>
              </motion.span>
            )}
          </AnimatePresence>
          <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0" />
        </button>
      </div>
    );
  }

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="swipe-next-prompt"
          aria-label={`Swipe to read the next article: ${target.title}`}
          className="pointer-events-none fixed bottom-0 right-0 z-40 touch-pan-y select-none"
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.85 }}
          animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.85 }}
          transition={{ duration: reduceMotion ? 0.15 : 0.3, ease: "easeOut" }}
        >
          {/* Dark circle bleeding off the bottom-right corner; only the top-left
              arc is on screen, where the content sits. The circle itself is
              decorative (pointer-events-none) so swipes pass through to the window
              gesture listener — only the two buttons capture taps. */}
          <div className="pointer-events-none relative h-[19rem] w-[19rem] translate-x-[30%] translate-y-[32%] overflow-hidden rounded-full bg-neutral-900/95 text-white shadow-2xl backdrop-blur-sm">
            {/* The thumb fills the whole circle and "swipes" across it. It also
                doubles as the desktop click-to-advance target — touch taps are
                ignored, since the swipe gesture / "Got it" drive things on touch. */}
            <button
              type="button"
              aria-label={`Read the next article: ${target.title}`}
              onPointerDown={(e) => {
                pointerTypeRef.current = e.pointerType;
              }}
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
                  transition={{
                    duration: 1.8,
                    repeat: Infinity,
                    ease: "easeInOut",
                    times: [0, 0.2, 0.8, 1],
                  }}
                />
              )}
            </button>

            {/* Top scrim keeps the label readable over the thumb line-art. */}
            <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-neutral-900 via-neutral-900/85 to-transparent" />

            <p className="pointer-events-none absolute left-6 top-7 w-44 text-center text-lg font-semibold leading-tight">
              Swipe for
              <br />
              next story
            </p>

            <button
              type="button"
              onClick={() => {
                // "Got it" is an explicit, permanent dismissal for this view —
                // stop the author-card trigger from re-revealing it.
                activatedRef.current = true;
                dismiss();
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  dismiss();
                }
              }}
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

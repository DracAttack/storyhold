/**
 * /card-render — headless-capture surface for glossary share cards.
 *
 * This page renders NOTHING until the server-side capture service (headless
 * Chromium driven by the API server) injects concept data via the
 * window.__renderCard(data) hook. Once the cards are mounted and their
 * fonts + hero images have finished loading, the page sets
 * window.__CARD_READY = true and the capture service screenshots BOTH
 * canvases: #card-canvas-feed (1200×1470 — 4:5 card on its stacked-sheet
 * plate) and #card-canvas-reel (1200×2040 — 9:16 card on its plate) — two
 * stored outputs from one render. The page forces a transparent background
 * while a card is mounted so the omitBackground screenshot keeps the
 * padding around the stacked sheets fully transparent.
 *
 * No data is fetched here and nothing is rendered for ordinary visitors —
 * the route is an intentionally blank, noindexed shell.
 */

import { useEffect, useState } from "react";
import { useSeo } from "@/lib/seo";
import { GlossaryCardCanvas } from "@/components/GlossaryCardCanvas";
import type { ConceptForCard } from "@/components/GlossaryShareCard";

declare global {
  interface Window {
    __renderCard?: (data: ConceptForCard) => void;
    __CARD_READY?: boolean;
  }
}

async function waitForImages(el: HTMLElement): Promise<void> {
  const imgs = Array.from(el.querySelectorAll<HTMLImageElement>("img"));
  if (!imgs.length) return;
  await Promise.all(
    imgs.map((img) =>
      img.complete
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            img.addEventListener("load",  () => resolve(), { once: true });
            img.addEventListener("error", () => resolve(), { once: true });
            setTimeout(resolve, 8000);
          }),
    ),
  );
}

export default function CardRender() {
  useSeo({ title: "Card Render — BrainHook", noindex: true });
  const [concept, setConcept] = useState<ConceptForCard | null>(null);

  // Expose the injection hook for the headless capture service.
  useEffect(() => {
    window.__renderCard = (data: ConceptForCard) => {
      window.__CARD_READY = false;
      setConcept(data);
    };
    return () => {
      delete window.__renderCard;
    };
  }, []);

  // Transparent page background while capturing — the theme paints an opaque
  // body background which would otherwise show through the transparent
  // padding around the stacked-card sheets in the omitBackground screenshot.
  useEffect(() => {
    const html = document.documentElement;
    const prevHtml = html.style.background;
    const prevBody = document.body.style.background;
    html.style.background = "transparent";
    document.body.style.background = "transparent";
    return () => {
      html.style.background = prevHtml;
      document.body.style.background = prevBody;
    };
  }, []);

  // After the cards mount: wait for fonts + hero images + the cards'
  // measurement-based fit pass (data-fitted="true"), then signal ready.
  useEffect(() => {
    if (!concept) return;
    let cancelled = false;
    void (async () => {
      try {
        await document.fonts.ready;
        for (const canvasId of ["card-canvas-feed", "card-canvas-reel"]) {
          const el = document.getElementById(canvasId);
          if (el) await waitForImages(el);
        }
        // Wait for both cards' overflow-fit loops to settle (bounded — the
        // loop converges in a handful of frames; 5s is a generous ceiling).
        const deadline = Date.now() + 5000;
        const allFitted = () =>
          ["card-canvas-feed", "card-canvas-reel"].every((id) => {
            const el = document.getElementById(id);
            return !el || !!el.querySelector('[data-fitted="true"]');
          });
        while (!allFitted() && Date.now() < deadline && !cancelled) {
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
        }
        // Two rAFs so the browser has painted the final layout.
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      } finally {
        if (!cancelled) window.__CARD_READY = true;
      }
    })();
    return () => { cancelled = true; };
  }, [concept]);

  if (!concept) {
    // Blank shell — nothing for ordinary visitors.
    return <div style={{ minHeight: "100vh", background: "#0B0A0D" }} />;
  }

  return (
    <div style={{ background: "transparent", minHeight: "100vh" }}>
      <GlossaryCardCanvas id="card-canvas-feed" concept={concept} variant="feed" />
      <GlossaryCardCanvas id="card-canvas-reel" concept={concept} variant="reel" />
    </div>
  );
}

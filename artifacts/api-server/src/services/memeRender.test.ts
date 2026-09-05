import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  W,
  PAD,
  SHADOW_BLEED_PX,
  computeHeadlinePanelSlots,
  computeExplainerLayout,
  planOverlayCaption,
  renderTextLayer,
} from "./memeRender";

const execFileAsync = promisify(execFile);

const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

// Read back the actual pixel dimensions magick wrote, so the clipping assertions
// check the real rendered output rather than our intended box.
async function pngSize(file: string): Promise<{ w: number; h: number }> {
  const { stdout } = await execFileAsync("magick", ["identify", "-format", "%w %h", file]);
  const [w, h] = stdout.trim().split(/\s+/).map(Number);
  return { w, h };
}

// ── #176: text never overlaps ───────────────────────────────────────────────
// The headline_caption panel lays kicker/headline/caption out as contiguous,
// north-anchored slots. They must never collide and every box must be tall
// enough to render into, regardless of whether a kicker is present.
for (const hasKicker of [false, true]) {
  test(`headline panel slots never overlap (kicker=${hasKicker})`, () => {
    const slots = computeHeadlinePanelSlots(hasKicker);

    // Content width is shared, positive, and inside the canvas.
    assert.equal(slots.contentWidth, W - PAD * 2);
    assert.ok(slots.contentWidth > 0 && slots.contentWidth < W);

    // The panel sits below the square photo and inside the extended canvas.
    assert.equal(slots.totalH, W + slots.panelH);
    assert.ok(slots.panelH > 0);

    // Every slot has a strictly positive height (no zero/negative boxes).
    if (hasKicker) {
      assert.ok(slots.kicker, "kicker slot should exist when requested");
      assert.ok(slots.kicker!.h > 0);
    } else {
      assert.equal(slots.kicker, null);
    }
    assert.ok(slots.headline.h > 0);
    assert.ok(slots.caption.h > 0);

    // Ordered, non-overlapping, all within the panel region [W, totalH].
    let cursor = W;
    const ordered = [slots.kicker, slots.headline, slots.caption].filter(
      (s): s is { y: number; h: number } => s != null,
    );
    for (const slot of ordered) {
      assert.ok(slot.y >= cursor, `slot starts at/after the previous slot's end`);
      assert.ok(slot.y + slot.h <= slots.totalH, `slot fits inside the canvas`);
      cursor = slot.y + slot.h;
    }
  });
}

// The explainer panel is sized to fit its already-rendered (fixed point size)
// headline + body layers: the panel must contain the whole content block, the
// headline must sit above the body with no overlap, and everything must land
// inside the extended canvas — with or without a headline.
for (const hasHeadline of [false, true]) {
  test(`explainer layout fits content with no overlap (headline=${hasHeadline})`, () => {
    const headlineH = hasHeadline ? 180 : 0;
    const bodyH = 460;
    const layout = computeExplainerLayout({ headlineH, bodyH, hasHeadline });

    assert.equal(layout.contentWidth, W - PAD * 2);
    assert.ok(layout.contentWidth > 0 && layout.contentWidth < W);

    assert.equal(layout.totalH, W + layout.panelH);
    assert.ok(layout.panelH > 0);

    // Body sits below the square photo and inside the canvas.
    assert.ok(layout.bodyY >= W, "body starts below the photo");
    assert.ok(layout.bodyY + bodyH <= layout.totalH, "body fits inside the canvas");

    if (hasHeadline) {
      assert.ok(layout.headlineY != null, "headline Y should exist when requested");
      assert.ok(layout.headlineY! >= W, "headline starts below the photo");
      // Headline ends before the body starts (no overlap).
      assert.ok(layout.headlineY! + headlineH <= layout.bodyY, "headline is above the body");
    } else {
      assert.equal(layout.headlineY, null);
    }
  });
}

// A long body grows the panel to fit (no crushing); a short body is padded up to
// the minimum panel height and stays centered/inside (no dead gap).
test("explainer layout grows for long copy and pads short copy", () => {
  const tall = computeExplainerLayout({ headlineH: 200, bodyH: 1200, hasHeadline: true });
  assert.ok(tall.bodyY + 1200 <= tall.totalH, "long body still fits the grown panel");
  assert.ok(tall.panelH > Math.round(W * 0.3), "panel grew beyond the minimum for long copy");

  const short = computeExplainerLayout({ headlineH: 0, bodyH: 40, hasHeadline: false });
  assert.ok(short.panelH >= Math.round(W * 0.3), "short body padded to the minimum panel");
  assert.ok(short.bodyY >= W, "short body starts below the photo");
  assert.ok(short.bodyY + 40 <= short.totalH, "short body fits inside the canvas");

  // Blank copy (zero measured heights) must still yield a valid, in-canvas panel.
  const blank = computeExplainerLayout({ headlineH: 0, bodyH: 0, hasHeadline: false });
  assert.ok(blank.panelH >= Math.round(W * 0.3), "blank copy falls back to the minimum panel");
  assert.equal(blank.totalH, W + blank.panelH);
  assert.ok(blank.bodyY >= W && blank.bodyY <= blank.totalH, "blank body Y stays inside the canvas");
  assert.equal(blank.headlineY, null);
});

const LONG_TEXT =
  "This is an absurdly long meme caption that would never fit at full size " +
  "and absolutely must be scaled down by ImageMagick instead of being clipped " +
  "off at the top and bottom edges of its layout box";

// ── #176: text never clips (core glyphs) ─────────────────────────────────────
// renderTextLayer must shrink-fit into its box: even a very long string rendered
// into a small box must come back no larger than that box in BOTH dimensions.
// The outlined path has no drop shadow, so the rendered layer is exactly the
// shrink-fitted core text — proving the `-resize WxH>` clamp itself never clips.
test("renderTextLayer shrink-fits long text inside its box (core, never clips)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "meme-render-test-"));
  try {
    const out = path.join(dir, "long-core.png");
    const box = { width: 600, height: 200 };
    const ok = await renderTextLayer(out, LONG_TEXT, {
      width: box.width,
      height: box.height,
      pointsize: 80,
      color: "white",
      font: FONT,
      outline: true,
      uppercase: false,
      align: "center",
    });
    assert.equal(ok, true);
    const size = await pngSize(out);
    assert.ok(size.w <= box.width, `width ${size.w} <= ${box.width}`);
    assert.ok(size.h <= box.height, `height ${size.h} <= ${box.height}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── #176: production (non-outlined) path stays within box + shadow budget ─────
// The shipped headline/caption text renders with outline:false, which adds a soft
// drop shadow AFTER the shrink-fit. This is the exact path whose shadow bleed
// once pushed a layer past its box. Assert the rendered layer never exceeds the
// box by more than the documented SHADOW_BLEED_PX budget in either dimension —
// catching any regression that lets the real output clip or balloon.
test("renderTextLayer (production shadow path) stays within box + shadow budget", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "meme-render-test-"));
  try {
    const out = path.join(dir, "long-shadow.png");
    const box = { width: 600, height: 200 };
    const ok = await renderTextLayer(out, LONG_TEXT, {
      width: box.width,
      height: box.height,
      pointsize: 80,
      color: "white",
      font: FONT,
      outline: false,
      uppercase: false,
      align: "center",
    });
    assert.equal(ok, true);
    const size = await pngSize(out);
    assert.ok(
      size.w <= box.width + SHADOW_BLEED_PX,
      `width ${size.w} <= ${box.width} + ${SHADOW_BLEED_PX}`,
    );
    assert.ok(
      size.h <= box.height + SHADOW_BLEED_PX,
      `height ${size.h} <= ${box.height} + ${SHADOW_BLEED_PX}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Short text keeps its size (not upscaled) and still fits the box.
test("renderTextLayer keeps short text within its box", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "meme-render-test-"));
  try {
    const out = path.join(dir, "short.png");
    const box = { width: 600, height: 200 };
    const ok = await renderTextLayer(out, "WOW", {
      width: box.width,
      height: box.height,
      pointsize: 80,
      color: "white",
      font: FONT,
      outline: true,
      uppercase: true,
      align: "center",
    });
    assert.equal(ok, true);
    const size = await pngSize(out);
    assert.ok(size.w <= box.width + 8, `width ${size.w} <= ${box.width}`);
    assert.ok(size.h <= box.height + 8, `height ${size.h} <= ${box.height}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Blank text renders nothing (returns false) — guards the "skip empty slot" path.
test("renderTextLayer returns false for blank text", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "meme-render-test-"));
  try {
    const out = path.join(dir, "blank.png");
    const ok = await renderTextLayer(out, "   ", {
      width: 600,
      height: 200,
      pointsize: 80,
      color: "white",
      font: FONT,
      outline: false,
      uppercase: false,
      align: "center",
    });
    assert.equal(ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── overlay caption planner (size cap + scrim decision) ──────────────────────
// A calm, mid-dark band needs no scrim and keeps the full base size.
test("planOverlayCaption: calm band gets no scrim and full size", () => {
  const plan = planOverlayCaption({
    band: { brightness: 0.35, busyness: 0.08 },
    zone: "top",
    baseMaxPt: 100,
    hintClear: true,
  });
  assert.equal(plan.scrim, false);
  assert.equal(plan.maxPointsize, 100);
});

// A busy band always scrims (white text fights the detail), and when the model
// did not flag the zone as clear the caption is also shrunk.
test("planOverlayCaption: busy band scrims; shrinks when zone not clear", () => {
  const clear = planOverlayCaption({
    band: { brightness: 0.4, busyness: 0.3 },
    zone: "bottom",
    baseMaxPt: 100,
    hintClear: true,
  });
  assert.equal(clear.scrim, true);
  assert.equal(clear.maxPointsize, 100, "clear zone keeps full size even if busy");

  const notClear = planOverlayCaption({
    band: { brightness: 0.4, busyness: 0.3 },
    zone: "bottom",
    baseMaxPt: 100,
    hintClear: false,
  });
  assert.equal(notClear.scrim, true);
  assert.equal(notClear.maxPointsize, 85, "busy + not-clear shrinks the cap");
});

// A bright band scrims on the hard threshold regardless of the hint.
test("planOverlayCaption: bright band scrims even when zone is clear", () => {
  const plan = planOverlayCaption({
    band: { brightness: 0.8, busyness: 0.05 },
    zone: "top",
    baseMaxPt: 90,
    hintClear: true,
  });
  assert.equal(plan.scrim, true);
});

// A borderline band stays clean when the model kept the zone clear, but the
// softer threshold trips a scrim once the model says the zone is NOT clear.
test("planOverlayCaption: hint breaks ties on a borderline band", () => {
  const band = { brightness: 0.58, busyness: 0.16 };
  const clear = planOverlayCaption({ band, zone: "top", baseMaxPt: 100, hintClear: true });
  assert.equal(clear.scrim, false, "clear hint keeps a borderline band scrim-free");
  const notClear = planOverlayCaption({ band, zone: "top", baseMaxPt: 100, hintClear: false });
  assert.equal(notClear.scrim, true, "not-clear hint scrims a borderline band");
});

// ── size cap (maxPointsize) ──────────────────────────────────────────────────
// Without a cap, a short line balloons to fill a tall box. With a cap, the same
// short line renders far smaller — proving the cap stops the ballooning — while
// still never exceeding the box.
test("renderTextLayer caps short text instead of ballooning to fill the box", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "meme-render-test-"));
  try {
    const box = { width: 600, height: 300 };
    const uncapped = path.join(dir, "uncapped.png");
    await renderTextLayer(uncapped, "WOW", {
      width: box.width,
      height: box.height,
      pointsize: 80,
      color: "white",
      font: FONT,
      outline: true,
      uppercase: true,
      align: "center",
    });
    const capped = path.join(dir, "capped.png");
    await renderTextLayer(capped, "WOW", {
      width: box.width,
      height: box.height,
      pointsize: 80,
      color: "white",
      font: FONT,
      outline: true,
      uppercase: true,
      align: "center",
      maxPointsize: 60,
    });
    const big = await pngSize(uncapped);
    const small = await pngSize(capped);
    // The capped render must be meaningfully shorter than the box-filling one and
    // still fit inside the box.
    assert.ok(small.h < big.h, `capped height ${small.h} < uncapped ${big.h}`);
    assert.ok(small.h <= box.height, `capped height ${small.h} <= ${box.height}`);
    assert.ok(small.h < box.height * 0.6, `capped short text stays small (${small.h})`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A long caption that cannot fit at the cap must fall back to box auto-fit so it
// shrinks to fit rather than clipping — i.e. the cap never causes overflow.
test("renderTextLayer cap falls back to box-fit for long text (never clips)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "meme-render-test-"));
  try {
    const box = { width: 600, height: 200 };
    const out = path.join(dir, "long-capped.png");
    const ok = await renderTextLayer(out, LONG_TEXT, {
      width: box.width,
      height: box.height,
      pointsize: 80,
      color: "white",
      font: FONT,
      outline: true,
      uppercase: false,
      align: "center",
      maxPointsize: 90,
    });
    assert.equal(ok, true);
    const size = await pngSize(out);
    assert.ok(size.w <= box.width, `width ${size.w} <= ${box.width}`);
    assert.ok(size.h <= box.height, `height ${size.h} <= ${box.height}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

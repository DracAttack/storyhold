import { DEFAULT_SHARE_CARD_URL } from "./objectStorage";

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function readingTimeFromBody(body: { type: string; content?: string; items?: string[] }[]): number {
  const words = body
    .filter((b) => b.type !== "image" && b.type !== "takeaways")
    .reduce((acc, b) => acc + (b.content ?? "").split(/\s+/).filter(Boolean).length, 0);
  return Math.max(3, Math.round(words / 220));
}

export function pickHeroImage(_slug?: string, _seed?: number): string {
  // No stock-photo (picsum) fallbacks anywhere: a failed, disabled, or missing
  // hero resolves to the branded "BrainHook on black" default card — the same
  // design as the homepage social card.
  return DEFAULT_SHARE_CARD_URL;
}

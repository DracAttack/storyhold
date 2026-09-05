// Central AdSense configuration.
//
// The publisher (client) ID and ad-unit slot IDs below are live, created in the
// AdSense dashboard (Ads → By ad unit). On non-authorized domains (such as
// localhost) or when a slot has no fill, the ad units collapse cleanly instead
// of rendering a placeholder box. The loader script is route-scoped, NOT in
// the global shell: the production meta server injects it for article routes
// (server/index.ts buildHeadBlock) and ./loadAdSense.ts injects it lazily when
// an ad unit mounts. The `google-adsense-account` meta in index.html is the
// site-verification signal only and stays global.

export const ADSENSE_CLIENT = "ca-pub-2106395417721931";

export const AD_SLOTS = {
  // In-article fluid unit reused at each inline position in the article body.
  inArticle: "8202032023",
  // Responsive "Display" auto unit for leaderboard / top & bottom placements.
  leaderboard: "5824409997",
  // Same responsive Display unit, reused for sidebar / rectangle placements.
  rectangle: "5824409997",
} as const;

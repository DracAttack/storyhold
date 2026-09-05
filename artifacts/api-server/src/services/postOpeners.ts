// ---------------------------------------------------------------------------
// Time-aware post openers — shared by Term of the Day and the article drip
// queue. Audience anchor is Phoenix time (UTC-7, no DST), same anchor the
// posting slots use. Pure and logger-free.
//
// Editorial direction: post language MAY be self-referential (BrainHook by
// name) — only hashtags may not. Openers rotate deterministically per seed so
// previews are stable, and they read like a human choosing words for the time
// of day the post lands ("with your morning coffee", "as you head to bed").
// ---------------------------------------------------------------------------

export type Daypart = "morning" | "midday" | "afternoon" | "evening" | "night";

const PHOENIX_UTC_OFFSET = -7; // Arizona: no DST, fixed offset year-round.

/** Map a UTC hour (0-23) to the Phoenix-local daypart it lands in. */
export function phoenixDaypartFromUtcHour(hourUtc: number): Daypart {
  const local = ((Math.round(hourUtc) + PHOENIX_UTC_OFFSET) % 24 + 24) % 24;
  if (local >= 5 && local < 11) return "morning";
  if (local >= 11 && local < 14) return "midday";
  if (local >= 14 && local < 18) return "afternoon";
  if (local >= 18 && local < 22) return "evening";
  return "night";
}

/** Deterministic pick — stable for a given seed so previews don't churn. */
export function pickBySeed<T>(arr: readonly T[], seed: string): T {
  const code = [...seed].reduce((s, ch) => s + ch.charCodeAt(0), 0);
  return arr[code % arr.length]!;
}

/**
 * Openers for article drip-queue posts, prepended to the stored caption at
 * post time (the snapshot caption itself is never regenerated). Keyed by the
 * daypart the post actually goes out in.
 */
const ARTICLE_OPENERS: Record<Daypart, readonly string[]> = {
  morning: [
    "Here's a BrainHook worth your time this morning.",
    "Something worth knowing over your morning coffee. ☕",
    "A read worth a few minutes before the day gets going.",
    "Start the day curious.",
  ],
  midday: [
    "Get hooked on this over lunch.",
    "A midday curiosity break — you've earned it.",
    "Here's a BrainHook to chew on with your lunch.",
    "Halfway through the day — time for something interesting.",
  ],
  afternoon: [
    "Here's something to get your mind rolling this afternoon.",
    "An afternoon detour for your brain.",
    "A BrainHook for the home stretch of your day.",
    "Something worth reading this afternoon.",
  ],
  evening: [
    "Something to think about this evening.",
    "Wind down with this one tonight.",
    "Here's a BrainHook to end the day on.",
    "One more interesting thing before the day's done.",
  ],
  night: [
    "Something to think about as you head to bed.",
    "One last thing to mull over before you call it a night.",
    "A late-night BrainHook for the night owls. 🦉",
    "Still up? Here's something worth the scroll.",
  ],
};

/** Pick the article-post opener for a daypart, stable per seed. */
export function pickArticleOpener(daypart: Daypart, seed: string): string {
  return pickBySeed(ARTICLE_OPENERS[daypart], seed);
}

/**
 * Openers for the twice-daily glossary term post. Deliberately NO
 * "term/word of the day" phrasing — with two posts a day the "of the day"
 * framing reads wrong. Self-referential BrainHook flavor is allowed here.
 */
const TERM_OPENERS: Record<Daypart, readonly ((term: string) => string)[]> = {
  morning: [
    (t) => `🧠 Here's one worth knowing today: ${t}`,
    (t) => `☕ Something to learn with your morning coffee — ${t}`,
    (t) => `💡 Start the day knowing something new: ${t}`,
    (t) => `📚 A BrainHook for your morning: ${t}`,
  ],
  midday: [
    (t) => `🧠 A lunchtime brain snack: ${t}`,
    (t) => `💡 Take a minute over lunch and learn this one: ${t}`,
    (t) => `📖 Midday pick worth knowing: ${t}`,
    (t) => `🧩 Sharpen your lexicon on your break: ${t}`,
  ],
  afternoon: [
    (t) => `💡 An afternoon pick-me-up for your vocabulary: ${t}`,
    (t) => `🧠 Beat the slump — learn this one: ${t}`,
    (t) => `📌 Worth knowing before the day's out: ${t}`,
    (t) => `🔤 Here's one to file under "things worth knowing": ${t}`,
  ],
  evening: [
    (t) => `🌆 One to think about this evening: ${t}`,
    (t) => `💡 End the day knowing something new: ${t}`,
    (t) => `📖 An evening read for the curious: ${t}`,
    (t) => `🧠 Tonight's BrainHook: ${t}`,
  ],
  night: [
    (t) => `🌙 Something to mull over as you head to bed: ${t}`,
    (t) => `💡 One last thing to learn before lights out: ${t}`,
    (t) => `🦉 For the night owls — this one's worth knowing: ${t}`,
    (t) => `🧠 A late-night BrainHook: ${t}`,
  ],
};

/** Pick the glossary-term opener for a daypart, stable per seed. */
export function pickTermOpener(daypart: Daypart, seed: string, term: string): string {
  return pickBySeed(TERM_OPENERS[daypart], seed)(term);
}

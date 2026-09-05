import { DateTime } from "luxon";
import type { BpdismsPostingSlot as PostingSlot } from "@workspace/db";
import type { BpdismsSocialPost as SocialPost } from "@workspace/db";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function findNextAvailableSlot(params: {
  postingSlots: PostingSlot[];
  existingScheduledPosts: SocialPost[];
  timezone: string;
  after: Date;
}): Date | null {
  const { postingSlots, existingScheduledPosts, timezone, after } = params;

  const enabledSlots = postingSlots.filter((s) => s.enabled);
  if (enabledSlots.length === 0) return null;

  const occupiedTimes = new Set(
    existingScheduledPosts
      .filter((p) => p.status !== "cancelled")
      .map((p) => p.scheduledAt.getTime()),
  );

  const startDt = DateTime.fromJSDate(after, { zone: timezone });

  for (let dayOffset = 0; dayOffset < 365; dayOffset++) {
    const day = startDt.startOf("day").plus({ days: dayOffset });
    const dayName = DAY_NAMES[day.weekday % 7] as string;

    for (const slot of enabledSlots) {
      let daysOfWeek: string[];
      try {
        daysOfWeek = JSON.parse(slot.daysOfWeekJson) as string[];
      } catch {
        daysOfWeek = [...DAY_NAMES];
      }

      if (!daysOfWeek.includes(dayName)) continue;

      const [hourStr, minuteStr] = slot.timeOfDay.split(":");
      const hour = parseInt(hourStr ?? "9", 10);
      const minute = parseInt(minuteStr ?? "0", 10);

      const candidate = day.set({ hour, minute, second: 0, millisecond: 0 });

      if (candidate <= startDt) continue;

      const candidateUtc = candidate.toJSDate();
      if (occupiedTimes.has(candidateUtc.getTime())) continue;

      return candidateUtc;
    }
  }

  return null;
}

export function findConsecutiveSlots(params: {
  postingSlots: PostingSlot[];
  existingScheduledPosts: SocialPost[];
  timezone: string;
  after: Date;
  count: number;
}): Date[] {
  const { postingSlots, existingScheduledPosts, timezone, after, count } = params;

  const enabledSlots = postingSlots.filter((s) => s.enabled);
  if (enabledSlots.length === 0) return [];

  const occupiedTimes = new Set(
    existingScheduledPosts
      .filter((p) => p.status !== "cancelled")
      .map((p) => p.scheduledAt.getTime()),
  );

  const results: Date[] = [];
  const startDt = DateTime.fromJSDate(after, { zone: timezone });

  for (let dayOffset = 0; dayOffset < 365 && results.length < count; dayOffset++) {
    const day = startDt.startOf("day").plus({ days: dayOffset });
    const dayName = DAY_NAMES[day.weekday % 7] as string;

    const sortedSlots = [...enabledSlots].sort((a, b) =>
      a.timeOfDay.localeCompare(b.timeOfDay),
    );

    for (const slot of sortedSlots) {
      if (results.length >= count) break;

      let daysOfWeek: string[];
      try {
        daysOfWeek = JSON.parse(slot.daysOfWeekJson) as string[];
      } catch {
        daysOfWeek = [...DAY_NAMES];
      }

      if (!daysOfWeek.includes(dayName)) continue;

      const [hourStr, minuteStr] = slot.timeOfDay.split(":");
      const hour = parseInt(hourStr ?? "9", 10);
      const minute = parseInt(minuteStr ?? "0", 10);

      const candidate = day.set({ hour, minute, second: 0, millisecond: 0 });

      if (candidate <= startDt) continue;

      const candidateUtc = candidate.toJSDate();

      if (occupiedTimes.has(candidateUtc.getTime())) continue;

      occupiedTimes.add(candidateUtc.getTime());
      results.push(candidateUtc);
    }
  }

  return results;
}

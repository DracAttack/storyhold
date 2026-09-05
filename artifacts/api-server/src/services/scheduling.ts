import { db, articlesTable } from "@workspace/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

/**
 * Minimum lead time between a draft's creation and its first valid publish
 * slot. Drafts are scheduled at least this far out (target 72–96h) so the
 * 48h auto-lock job always fires comfortably before the slot is reached and
 * never races the publisher.
 */
export const MIN_SCHEDULE_LEAD_MS = 72 * 60 * 60 * 1000;

/** How far ahead to scan for a free cadence slot before giving up. */
const SLOT_LOOKAHEAD_DAYS = 400;

export interface SlotAuthor {
  id: string;
  cadence: string;
  weekday: number | null;
  secondWeekday?: number | null;
  dayOfMonth?: number | null;
  runHourUtc: number | null;
}

/**
 * The cadence-defining fields of an author, used to compute and validate
 * publishing slots independent of the rest of the author row.
 */
export interface CadenceSpec {
  cadence: string;
  weekday: number | null;
  secondWeekday?: number | null;
  dayOfMonth?: number | null;
  runHourUtc: number;
}

/** Cadences whose slots land on a named weekday (and so use `weekday`). */
export function cadenceUsesWeekday(cadence: string): boolean {
  return cadence === "weekly" || cadence === "biweekly" || cadence === "twice_weekly";
}

/** Random UTC hour-of-day (0–23). */
export function pickRandomHour(rng: () => number = Math.random): number {
  return Math.floor(rng() * 24);
}

/** Random day-of-month (1–28) — capped at 28 so every month has the day. */
export function pickRandomDayOfMonth(rng: () => number = Math.random): number {
  return Math.floor(rng() * 28) + 1;
}

/** Clamp a day-of-month into the safe 1–28 range (default 1 when unset). */
export function clampDayOfMonth(d: number | null | undefined): number {
  const n = d ?? 1;
  if (!Number.isFinite(n)) return 1;
  return Math.min(28, Math.max(1, Math.trunc(n)));
}

/**
 * True when the (epoch-anchored) week containing `day` is an "even" biweekly
 * week. This is NOT ISO week numbering — it is a stable every-other-week parity
 * anchored to the Unix epoch, which is all the biweekly cadence needs.
 */
function isEvenBiweeklyWeek(day: Date): boolean {
  const epochDay = Math.floor(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) / 86_400_000,
  );
  return Math.floor(epochDay / 7) % 2 === 0;
}

/**
 * Pick a weekday (0=Sunday … 6=Saturday) that is different from `current`.
 *
 * When `counts` (a length-7 array of how many authors currently sit on each
 * weekday) is supplied, the choice is biased toward the least-occupied
 * eligible days so the publishing load stays evenly spread across the week
 * (the "one or two authors a day" goal); ties are broken at random. Without
 * `counts` it is a uniform random pick among the six other days.
 */
export function pickRotatedWeekday(
  current: number | null,
  counts?: readonly number[],
  rng: () => number = Math.random,
): number {
  const candidates = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== current);
  let pool = candidates;
  if (counts) {
    let min = Infinity;
    for (const d of candidates) min = Math.min(min, counts[d] ?? 0);
    pool = candidates.filter((d) => (counts[d] ?? 0) === min);
  }
  return pool[Math.floor(rng() * pool.length)]!;
}

/** Stable per-author, per-UTC-hour slot key (authorId|YYYY-MM-DD-HH UTC). */
export function slotKey(authorId: string, d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  return `${authorId}|${y}-${m}-${day}-${h}`;
}

/**
 * True when a candidate UTC `slot` (a calendar day) falls on the author's
 * cadence. Hour matching is checked separately by {@link slotMatchesCadence};
 * this only judges the *day*.
 *
 * - daily: every day
 * - weekly: only `weekday`
 * - twice_weekly: `weekday` or `secondWeekday`
 * - biweekly: `weekday`, but only on even biweekly weeks (every other week)
 * - monthly: only on the clamped `dayOfMonth` (1–28)
 */
export function dayMatchesCadence(spec: CadenceSpec, day: Date): boolean {
  const dow = day.getUTCDay();
  switch (spec.cadence) {
    case "daily":
      return true;
    case "twice_weekly":
      return (
        (spec.weekday !== null && spec.weekday === dow) ||
        ((spec.secondWeekday ?? null) !== null && spec.secondWeekday === dow)
      );
    case "weekly":
      return spec.weekday !== null && spec.weekday === dow;
    case "biweekly":
      return spec.weekday !== null && spec.weekday === dow && isEvenBiweeklyWeek(day);
    case "monthly":
      return day.getUTCDate() === clampDayOfMonth(spec.dayOfMonth);
    default:
      // Unknown cadence → behave like weekly when a weekday is set.
      return spec.weekday !== null && spec.weekday === dow;
  }
}

/**
 * Generate this author's cadence slots for `days` days starting from the UTC
 * day that contains `horizonStart`. Each matching day yields one slot at
 * `runHourUtc`. Supports daily, twice-weekly, weekly, biweekly, and monthly.
 */
export function computeSlots(spec: CadenceSpec, horizonStart: Date, days: number): Date[] {
  const slots: Date[] = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(horizonStart);
    day.setUTCDate(day.getUTCDate() + i);
    if (!dayMatchesCadence(spec, day)) continue;
    slots.push(
      new Date(
        Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), spec.runHourUtc, 0, 0),
      ),
    );
  }
  return slots;
}

/**
 * True when an exact `slotAt` timestamp sits on the author's cadence — both the
 * right calendar day (per {@link dayMatchesCadence}) and exactly on the
 * author's run hour with zeroed minutes/seconds. Used to validate admin slot
 * swaps and to detect off-cadence pending events during a reslot.
 */
export function slotMatchesCadence(spec: CadenceSpec, slotAt: Date): boolean {
  if (slotAt.getUTCMinutes() !== 0 || slotAt.getUTCSeconds() !== 0) return false;
  if (slotAt.getUTCHours() !== spec.runHourUtc) return false;
  return dayMatchesCadence(spec, slotAt);
}

/**
 * Earliest cadence slot at or after `minTime` that is not already in
 * `occupied`. Returns null if no free slot is found within the lookahead.
 */
export function nextFreeSlot(
  author: SlotAuthor,
  minTime: Date,
  occupied: Set<string>,
  lookaheadDays = SLOT_LOOKAHEAD_DAYS,
): Date | null {
  const startDay = new Date(Date.UTC(minTime.getUTCFullYear(), minTime.getUTCMonth(), minTime.getUTCDate()));
  const slots = computeSlots(
    {
      cadence: author.cadence,
      weekday: author.weekday,
      secondWeekday: author.secondWeekday ?? null,
      dayOfMonth: author.dayOfMonth ?? null,
      runHourUtc: author.runHourUtc ?? 14,
    },
    startDay,
    lookaheadDays,
  );
  for (const slot of slots) {
    if (slot.getTime() < minTime.getTime()) continue;
    if (occupied.has(slotKey(author.id, slot))) continue;
    return slot;
  }
  return null;
}

/**
 * Slot keys already reserved by this author's pending articles — both
 * `scheduled` articles and `draft` articles that already carry a reserved
 * `scheduled_for`. Used to avoid double-booking a slot when assigning a new
 * draft's slot or auto-locking a stale draft.
 */
export async function reservedSlotKeysForAuthor(
  authorId: string,
  excludeArticleId?: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ id: articlesTable.id, scheduledFor: articlesTable.scheduledFor })
    .from(articlesTable)
    .where(
      and(
        eq(articlesTable.authorId, authorId),
        inArray(articlesTable.status, ["draft", "scheduled"]),
        isNotNull(articlesTable.scheduledFor),
      ),
    );
  const set = new Set<string>();
  for (const r of rows) {
    if (excludeArticleId && r.id === excludeArticleId) continue;
    if (!r.scheduledFor) continue;
    set.add(slotKey(authorId, new Date(r.scheduledFor)));
  }
  return set;
}

/**
 * Pick the slot a freshly-created draft should reserve: the earliest free
 * cadence slot at least `MIN_SCHEDULE_LEAD_MS` (72h) after `now`.
 */
export async function assignDraftScheduleSlot(
  author: SlotAuthor,
  now: Date = new Date(),
  excludeArticleId?: string,
): Promise<Date | null> {
  const minTime = new Date(now.getTime() + MIN_SCHEDULE_LEAD_MS);
  const occupied = await reservedSlotKeysForAuthor(author.id, excludeArticleId);
  return nextFreeSlot(author, minTime, occupied);
}

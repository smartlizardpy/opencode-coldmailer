/**
 * When it is acceptable to send.
 *
 * A cold email that arrives at 03:14 on a Sunday is read as a machine before it is read at
 * all, and a run started in the evening will happily work through the night at one message
 * a minute. This is the guard that stops that, and it is deliberately a guard rather than a
 * scheduler: nothing is queued for later, sends are simply refused outside the window and
 * resume on their own inside it.
 *
 * Everything is in the machine's local time. We do not know the recipient's timezone - the
 * research pipeline never learns it - and inventing one from a TLD would be worse than
 * honest local time, so the UI says which timezone it is using.
 */

export interface SendWindow {
  enabled: boolean;
  /** Local hour the window opens, 0-23. */
  startHour: number;
  /** Local hour it closes, 0-23. Exclusive: 17 means the last send may start at 16:59. */
  endHour: number;
  /** Days it applies to, 0 = Sunday through 6 = Saturday. */
  days: number[];
}

export const DEFAULT_WINDOW: SendWindow = {
  enabled: false,
  startHour: 9,
  endHour: 17,
  // Weekdays. Saturday and Sunday cold email is both less effective and more annoying.
  days: [1, 2, 3, 4, 5],
};

export function normaliseWindow(w: Partial<SendWindow> | undefined): SendWindow {
  const clampHour = (n: unknown, fallback: number): number => {
    const v = Math.floor(Number(n));
    return Number.isFinite(v) && v >= 0 && v <= 23 ? v : fallback;
  };
  const days = Array.isArray(w?.days)
    ? [...new Set(w.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
    : DEFAULT_WINDOW.days;
  return {
    enabled: !!w?.enabled,
    startHour: clampHour(w?.startHour, DEFAULT_WINDOW.startHour),
    endHour: clampHour(w?.endHour, DEFAULT_WINDOW.endHour),
    days: days.length ? days : DEFAULT_WINDOW.days,
  };
}

/**
 * True when `at` falls inside the window.
 *
 * A window whose end is at or before its start wraps past midnight - 22 to 6 is a valid way
 * to say "overnight", even though it is a poor way to send cold email. The day is taken from
 * when the window opened, so a Friday 22:00-06:00 window is still open at 02:00 on Saturday.
 */
export function isOpen(w: SendWindow, at: Date = new Date()): boolean {
  if (!w.enabled) return true;
  const hour = at.getHours();
  const day = at.getDay();

  if (w.startHour < w.endHour) return w.days.includes(day) && hour >= w.startHour && hour < w.endHour;
  if (w.startHour === w.endHour) return false;   // an empty window, not a 24-hour one

  // Wrapping. Before midnight belongs to today; after midnight belongs to yesterday.
  if (hour >= w.startHour) return w.days.includes(day);
  if (hour < w.endHour) return w.days.includes((day + 6) % 7);
  return false;
}

/**
 * When the window next opens, or undefined if it is open now.
 *
 * Walks forward minute by minute over at most eight days. A closed-form answer would have to
 * reason about wrapping windows and day sets at the same time, and this runs once per refused
 * send - correctness is worth more than the microseconds.
 */
export function nextOpen(w: SendWindow, from: Date = new Date()): Date | undefined {
  if (isOpen(w, from)) return undefined;
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  for (let i = 0; i < 8 * 24 * 60; i++) {
    cursor.setMinutes(cursor.getMinutes() + 1);
    if (isOpen(w, cursor)) return cursor;
  }
  return undefined;   // days: [] cannot happen after normaliseWindow, but never loop forever
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Human summary, e.g. "09:00-17:00, Mon to Fri". */
export function describeWindow(w: SendWindow): string {
  if (!w.enabled) return "any time";
  const hh = (n: number) => `${String(n).padStart(2, "0")}:00`;
  const weekdays = [1, 2, 3, 4, 5];
  const sameAsWeekdays = w.days.length === 5 && weekdays.every((d) => w.days.includes(d));
  const days = w.days.length === 7 ? "every day"
    : sameAsWeekdays ? "Mon to Fri"
    : w.days.length === 1 ? `${DAY_NAMES[w.days[0]]}s`
    : w.days.map((d) => SHORT[d]).join(", ");
  return `${hh(w.startHour)}-${hh(w.endHour)}, ${days}`;
}

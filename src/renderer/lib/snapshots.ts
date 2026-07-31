/**
 * Saying when a backup was taken, in the terms someone actually thinks in.
 *
 * A filename is not an answer to "which one do I want". "Tuesday 3:12 PM" is,
 * and so is "14 March, 9:05 AM" for one from months ago — the point of the
 * distinction is that a recent backup is placed by weekday and an old one by
 * date, which is how people hold time.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function describeSnapshot(takenAt: string, now: Date = new Date()): string {
  const when = new Date(takenAt);
  if (Number.isNaN(when.getTime())) return "an unknown time";

  const clock = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const elapsed = now.getTime() - when.getTime();

  if (elapsed < 0) return `${when.toLocaleDateString(undefined, dateParts(when, now))}, ${clock}`;
  if (isSameDay(when, now)) return `today at ${clock}`;
  if (isSameDay(when, new Date(now.getTime() - DAY))) return `yesterday at ${clock}`;
  if (elapsed < 7 * DAY) {
    return `${when.toLocaleDateString(undefined, { weekday: "long" })} at ${clock}`;
  }
  return `${when.toLocaleDateString(undefined, dateParts(when, now))} at ${clock}`;
}

/** The year is only worth saying when it isn't this one. */
function dateParts(when: Date, now: Date): Intl.DateTimeFormatOptions {
  return {
    day: "numeric",
    month: "long",
    year: when.getFullYear() === now.getFullYear() ? undefined : "numeric",
  };
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** How long ago, for "last copied" lines that want to be glanced at. */
export function describeElapsed(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "never";
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "never";

  const elapsed = now.getTime() - when.getTime();
  if (elapsed < 2 * MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.round(elapsed / MINUTE)} minutes ago`;
  if (elapsed < DAY) {
    const hours = Math.round(elapsed / HOUR);
    return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  }
  const days = Math.round(elapsed / DAY);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

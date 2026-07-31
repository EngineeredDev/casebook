/**
 * What the files in `backups/` are called, and which of them get to stay.
 *
 * All naming and all retention, and no filesystem at all — every function here
 * is a decision about a list of strings. That is deliberate: retention is the
 * part of the backup system that *deletes* things, so it is the part where a
 * subtle mistake is silent and permanent, and it is worth being able to test it
 * exhaustively without a disk.
 *
 * The scheme extends the old one rather than replacing it. `data-2026-07-31.json`
 * still means what it always meant, so a folder full of backups written by an
 * earlier Casebook needs no migration and loses nothing.
 *
 * Four kinds live here:
 *
 * - **Dailies**, `data-YYYY-MM-DD.json`, one per day, sixty kept.
 * - **Intervals**, `data-YYYY-MM-DD-HHMM.json`, at most one per fifteen minutes
 *   of editing, two days kept. These are what bound a bad day's loss to
 *   minutes instead of to everything since breakfast.
 * - **Monthlies**, which are not a separate file at all — the first daily of
 *   each month is simply exempted from pruning for two years. That is the tier
 *   that survives a corruption noticed late, where every recent copy already
 *   has the damage in it.
 * - **Preserved**, `data-pre-*.json` and `data-corrupt-*.json`: one-off files
 *   written either side of something irreversible — a schema migration,
 *   switching encryption on or off — or when an unreadable file was rescued.
 *   Never pruned by anything, because each one is the only copy of a state that
 *   cannot be reconstructed, and each marks an event that happens rarely enough
 *   that keeping them forever costs nothing.
 *
 * A `.enc` suffix rides along on any of them; `backups/` legitimately holds
 * both plaintext-era and encrypted-era files at once, and which era a file
 * belongs to has no bearing on how long it is kept.
 */

/** Sixty days of dailies. */
const KEEP_DAILIES = 60;
/** Intervals are for "this morning" — after a couple of days the daily is enough. */
const KEEP_INTERVAL_DAYS = 2;
/** Two years of first-of-the-month copies. */
const KEEP_MONTHLY_MONTHS = 24;

const DAILY = /^data-(\d{4}-\d{2}-\d{2})\.json(\.enc)?$/;
const INTERVAL = /^data-(\d{4}-\d{2}-\d{2})-(\d{2}\d{2})\.json(\.enc)?$/;
/** Taken either side of something irreversible, or rescued from one. */
const PRESERVED = /^data-(?:pre-[a-z0-9]+|corrupt)-.+\.json(\.enc)?$/;

export type SnapshotKind = "daily" | "interval" | "preserved";

export interface Snapshot {
  name: string;
  kind: SnapshotKind;
  /** YYYY-MM-DD. Empty for a preserved file, whose name isn't a promise about dates. */
  date: string;
  /** HHMM, for intervals only. */
  time: string | null;
  encrypted: boolean;
}

/** Local YYYY-MM-DD. Local, not UTC: "which day is this" is a question about her day. */
export function dayStamp(when: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

/** Local HHMM, the minute part of an interval snapshot's name. */
export function minuteStamp(when: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(when.getHours())}${pad(when.getMinutes())}`;
}

export function dailyName(when: Date = new Date(), encrypted = false): string {
  return `data-${dayStamp(when)}.json${encrypted ? ".enc" : ""}`;
}

export function intervalName(when: Date = new Date(), encrypted = false): string {
  return `data-${dayStamp(when)}-${minuteStamp(when)}.json${encrypted ? ".enc" : ""}`;
}

/**
 * What a filename in `backups/` is, or null if it is nothing we recognise.
 *
 * Null covers `.bad` files — snapshots that failed to parse and were renamed
 * out of the way — along with anything a user happened to drop in the folder.
 * Neither is offered for restore and neither is ever deleted: this code does
 * not delete files it cannot account for.
 */
export function classify(name: string): Snapshot | null {
  const interval = INTERVAL.exec(name);
  if (interval) {
    return {
      name,
      kind: "interval",
      date: interval[1]!,
      time: interval[2]!,
      encrypted: Boolean(interval[3]),
    };
  }
  const daily = DAILY.exec(name);
  if (daily) {
    return { name, kind: "daily", date: daily[1]!, time: null, encrypted: Boolean(daily[2]) };
  }
  if (PRESERVED.test(name)) {
    return { name, kind: "preserved", date: "", time: null, encrypted: name.endsWith(".enc") };
  }
  return null;
}

/** Newest first — the order every list of snapshots is shown and searched in. */
export function newestFirst(snapshots: Snapshot[]): Snapshot[] {
  return snapshots.toSorted((a, b) => sortKey(b).localeCompare(sortKey(a)));
}

function sortKey(snapshot: Snapshot): string {
  // A daily sorts above every interval on the same date: it was written at the
  // first save of the day and represents the day as a whole, so when both are
  // candidates for a restore the daily is the more conservative answer.
  return `${snapshot.date}-${snapshot.time ?? "9999"}`;
}

/** Shift a YYYY-MM-DD back by whole days, staying in local time. */
function daysBefore(date: string, days: number): string {
  const when = new Date(`${date}T12:00:00`);
  when.setDate(when.getDate() - days);
  return dayStamp(when);
}

/** Shift a YYYY-MM back by whole months. */
function monthsBefore(month: string, months: number): string {
  const when = new Date(`${month}-01T12:00:00`);
  when.setMonth(when.getMonth() - months);
  return dayStamp(when).slice(0, 7);
}

/**
 * Which files to delete, given everything currently in `backups/`.
 *
 * Returns names rather than doing anything, so the caller decides when — and
 * whether — deleting is safe. Nothing unrecognised is ever returned: this
 * function proposes deleting only files it can name the purpose of.
 */
export function snapshotsToPrune(names: string[], now: Date = new Date()): string[] {
  const snapshots = names
    .map(classify)
    .filter((snapshot): snapshot is Snapshot => snapshot !== null);

  const today = dayStamp(now);
  const intervalCutoff = daysBefore(today, KEEP_INTERVAL_DAYS);
  const monthlyCutoff = monthsBefore(today.slice(0, 7), KEEP_MONTHLY_MONTHS);

  const dailies = newestFirst(snapshots.filter((snapshot) => snapshot.kind === "daily"));
  const keptDailies = new Set(dailies.slice(0, KEEP_DAILIES).map((snapshot) => snapshot.name));

  // The first daily of each month, which is the one the monthly tier is made
  // of. Computed over every daily present rather than over the sixty being
  // kept — the whole point is to hold on to copies far older than that.
  const firstOfMonth = new Map<string, string>();
  for (const daily of dailies) {
    // Iterating newest-first, so the last one written for a month wins, and the
    // last one seen is the earliest.
    firstOfMonth.set(daily.date.slice(0, 7), daily.name);
  }
  for (const [month, name] of firstOfMonth) {
    if (month >= monthlyCutoff) keptDailies.add(name);
  }

  return snapshots
    .filter((snapshot) => {
      if (snapshot.kind === "preserved") return false;
      if (snapshot.kind === "interval") return snapshot.date < intervalCutoff;
      return !keptDailies.has(snapshot.name);
    })
    .map((snapshot) => snapshot.name);
}

/** All dates are local-timezone calendar dates serialized as YYYY-MM-DD. */

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function todayYmd(): string {
  return ymd(new Date());
}

export function addDaysYmd(s: string, n: number): string {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

/** Monday of the week containing the given date. */
export function weekStartYmd(s: string): string {
  const d = parseYmd(s);
  const dow = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  d.setDate(d.getDate() - dow);
  return ymd(d);
}

/** Every Monday from the week containing `from` through the week containing `to`. */
export function listWeeks(from: string, to: string): string[] {
  const weeks: string[] = [];
  let w = weekStartYmd(from);
  const last = weekStartYmd(to);
  while (w <= last) {
    weeks.push(w);
    w = addDaysYmd(w, 7);
  }
  return weeks;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const MONTHS_FULL = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function fmtDayLabel(s: string): string {
  const d = parseYmd(s);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** "July 2026" — the timeline's sticky section rule. */
export function fmtMonthLabel(s: string): string {
  const d = parseYmd(s);
  return `${MONTHS_FULL[d.getMonth()]} ${d.getFullYear()}`;
}

/** "Fri, Jul 24" — a day heading sitting under a month that already has the year. */
export function fmtDayHeading(s: string): string {
  const d = parseYmd(s);
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** The first of the month containing the given date — the timeline's section key. */
export function monthStartYmd(s: string): string {
  return `${s.slice(0, 7)}-01`;
}

export function fmtWeekLabel(weekYmd: string): string {
  return fmtDayLabel(weekYmd);
}

export function fmtFullDate(s: string): string {
  const d = parseYmd(s);
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** "1h 30m" for entry rows and tooltips. */
export function fmtDuration(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

/** Decimal hours for aggregates: "12.5" (unit added by caller/axis). */
export function toHours(minutes: number): number {
  return Math.round((minutes / 60) * 10) / 10;
}

export function fmtHours(minutes: number): string {
  return `${toHours(minutes)}h`;
}

export interface DateRange {
  from: string;
  to: string;
}

export interface RangePreset {
  key: string;
  label: string;
  range: () => DateRange;
}

export function schoolYearStart(startMonth: number): string {
  const now = new Date();
  const year = now.getMonth() + 1 >= startMonth ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-${String(startMonth).padStart(2, "0")}-01`;
}

/** A chosen range plus how to describe it — `key` is what round-trips through the URL. */
export interface RangeSelection {
  key: string;
  label: string;
  range: DateRange;
}

export const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Resolve a preset key to a selection; null when the key isn't one we know. */
export function presetRange(key: string, schoolYearStartMonth: number): RangeSelection | null {
  const preset = rangePresets(schoolYearStartMonth).find((p) => p.key === key);
  return preset ? { key: preset.key, label: preset.label, range: preset.range() } : null;
}

export function defaultRange(schoolYearStartMonth: number, key = "12-weeks"): RangeSelection {
  return presetRange(key, schoolYearStartMonth) ?? presetRange("12-weeks", schoolYearStartMonth)!;
}

export function rangePresets(schoolYearStartMonth: number): RangePreset[] {
  return [
    {
      key: "this-week",
      label: "This week",
      range: () => ({ from: weekStartYmd(todayYmd()), to: todayYmd() }),
    },
    {
      key: "4-weeks",
      label: "Last 4 weeks",
      range: () => ({ from: addDaysYmd(weekStartYmd(todayYmd()), -21), to: todayYmd() }),
    },
    {
      key: "12-weeks",
      label: "Last 12 weeks",
      range: () => ({ from: addDaysYmd(weekStartYmd(todayYmd()), -77), to: todayYmd() }),
    },
    {
      key: "school-year",
      label: "School year to date",
      range: () => ({ from: schoolYearStart(schoolYearStartMonth), to: todayYmd() }),
    },
    {
      key: "all",
      label: "All time",
      range: () => ({ from: "0000-01-01", to: "9999-12-31" }),
    },
  ];
}

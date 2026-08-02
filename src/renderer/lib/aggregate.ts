import type { Category, DataDoc, Entry, Student } from "../../shared/types.ts";
import { listWeeks, weekStartYmd, type DateRange } from "./time.ts";

/**
 * How a group entry's minutes count against each attending student:
 * - "service": each student is credited the full duration (IEP service-minutes view)
 * - "share":   the duration is split evenly (true workload view)
 */
export type Attribution = "service" | "share";

export function minutesForStudent(entry: Entry, attribution: Attribution): number {
  // The zero case is school-level work. Every caller computes this before its
  // loop over `studentIds` — a loop that then does not run — so the value is
  // discarded rather than used, and the guard is what keeps that a harmless
  // dead number instead of an Infinity looking for somewhere to land.
  if (attribution === "service" || entry.studentIds.length === 0) return entry.minutes;
  return entry.minutes / entry.studentIds.length;
}

export function inRange(entry: Entry, range: DateRange): boolean {
  return entry.date >= range.from && entry.date <= range.to;
}

export function filterEntries(entries: Entry[], range: DateRange): Entry[] {
  return entries.filter((e) => inRange(e, range));
}

/** Clamp an open-ended preset range to the span the data actually covers. */
export function effectiveRange(entries: Entry[], range: DateRange): DateRange | null {
  const first = entries[0];
  if (!first) return null;
  let min = first.date;
  let max = first.date;
  for (const e of entries) {
    if (e.date < min) min = e.date;
    if (e.date > max) max = e.date;
  }
  const from = range.from > min ? range.from : min;
  const to = range.to < max ? range.to : max;
  return from <= to ? { from, to } : null;
}

/**
 * Number of Monday-weeks the (clamped) range spans — the divisor for per-week
 * averages.
 *
 * School-level entries clamp the range like any others, which is the single
 * place that time touches a per-student number: a week she spent entirely in
 * meetings still counts as a week, and as one her students were seen for zero
 * minutes in. Averaging over it reports that rather than dropping the week.
 */
export function weekCount(entries: Entry[], range: DateRange): number {
  const eff = effectiveRange(entries, range);
  if (!eff) return 0;
  return listWeeks(eff.from, eff.to).length;
}

export interface GroupTotals {
  direct: number;
  indirect: number;
  total: number;
}

export function categoryGroupOf(categoryId: string, categories: Category[]): "direct" | "indirect" {
  return categories.find((c) => c.id === categoryId)?.group ?? "indirect";
}

export function isUntimed(categoryId: string, categories: Category[]): boolean {
  return !!categories.find((c) => c.id === categoryId)?.untimed;
}

/**
 * Work no single student's name belongs on — a crisis-team meeting, a classroom
 * lesson, a duty period, an hour spent building next term's schedule.
 *
 * It is real clock time, so it counts toward every total that claims to be one;
 * it has no student, so it counts toward no per-student number at all. Both
 * halves of that are the point: a caseload's cost is understated exactly by the
 * labour a headcount cannot hold.
 */
export function isSchoolLevel(entry: Entry): boolean {
  return entry.studentIds.length === 0;
}

/**
 * Entries that carry no minutes by design. Counted rather than summed — they are
 * invisible to every hours-based rollup, so this is the only place they surface.
 */
export function untimedCount(entries: Entry[], categories: Category[]): number {
  return entries.filter((e) => isUntimed(e.categoryId, categories)).length;
}

/** True clock-time totals for the range (each entry counted once, not per student). */
export function clockTotals(entries: Entry[], categories: Category[]): GroupTotals {
  const t: GroupTotals = { direct: 0, indirect: 0, total: 0 };
  for (const e of entries) {
    t.total += e.minutes;
    t[categoryGroupOf(e.categoryId, categories)] += e.minutes;
  }
  return t;
}

/**
 * The school-level slice of a range on its own.
 *
 * Every per-student view excludes this time by construction, so any page
 * showing a total and a per-student breakdown side by side has a gap between
 * them that needs a number to explain it. Without this the two just disagree.
 */
export function schoolLevelTotals(entries: Entry[], categories: Category[]): GroupTotals {
  return clockTotals(entries.filter(isSchoolLevel), categories);
}

export interface WeekGroupRow {
  week: string;
  direct: number;
  indirect: number;
}

/** Weekly clock minutes split direct/indirect, zero-filled across the range's weeks. */
export function weeklyByGroup(
  entries: Entry[],
  categories: Category[],
  range: DateRange,
): WeekGroupRow[] {
  const eff = effectiveRange(entries, range);
  if (!eff) return [];
  const rows = new Map<string, WeekGroupRow>();
  for (const w of listWeeks(eff.from, eff.to)) rows.set(w, { week: w, direct: 0, indirect: 0 });
  for (const e of entries) {
    const row = rows.get(weekStartYmd(e.date));
    if (row) row[categoryGroupOf(e.categoryId, categories)] += e.minutes;
  }
  return [...rows.values()];
}

export interface StudentTotals {
  student: Student;
  direct: number;
  indirect: number;
  total: number;
  avgPerWeek: number;
  entryCount: number;
  /**
   * How many of `entryCount` carry no minutes by design. Subtract to count
   * sessions — a no-show is an event, not a session, and it is invisible to
   * every minutes-based field above.
   */
  untimed: number;
}

export function perStudentTotals(
  entries: Entry[],
  students: Student[],
  categories: Category[],
  attribution: Attribution,
  range: DateRange,
): StudentTotals[] {
  const weeks = weekCount(entries, range) || 1;
  const map = new Map<string, StudentTotals>();
  for (const s of students) {
    map.set(s.id, {
      student: s,
      direct: 0,
      indirect: 0,
      total: 0,
      avgPerWeek: 0,
      entryCount: 0,
      untimed: 0,
    });
  }
  for (const e of entries) {
    const per = minutesForStudent(e, attribution);
    const group = categoryGroupOf(e.categoryId, categories);
    const untimed = isUntimed(e.categoryId, categories);
    for (const sid of e.studentIds) {
      const row = map.get(sid);
      if (!row) continue;
      row.total += per;
      row[group] += per;
      row.entryCount += 1;
      if (untimed) row.untimed += 1;
    }
  }
  const out = [...map.values()].filter((r) => r.entryCount > 0 || r.student.active);
  for (const r of out) r.avgPerWeek = r.total / weeks;
  return out.toSorted((a, b) => b.total - a.total);
}

export interface CategoryTotal {
  category: Category;
  minutes: number;
  count: number;
}

/**
 * Kept on entry count rather than minutes so untimed categories survive — for
 * those, the count is the whole story. Callers plotting hours should drop rows
 * with no minutes themselves.
 */
export function perCategoryTotals(entries: Entry[], categories: Category[]): CategoryTotal[] {
  const map = new Map<string, { minutes: number; count: number }>();
  for (const e of entries) {
    const row = map.get(e.categoryId) ?? { minutes: 0, count: 0 };
    row.minutes += e.minutes;
    row.count += 1;
    map.set(e.categoryId, row);
  }
  return categories
    .map((category) => ({ category, ...(map.get(category.id) ?? { minutes: 0, count: 0 }) }))
    .filter((r) => r.count > 0)
    .toSorted((a, b) => b.minutes - a.minutes || b.count - a.count);
}

/** week -> studentId -> minutes, zero-filled weeks; for trend lines and the weekly CSV. */
export function studentWeekMatrix(
  entries: Entry[],
  attribution: Attribution,
  range: DateRange,
): { weeks: string[]; byWeek: Map<string, Map<string, number>> } {
  const eff = effectiveRange(entries, range);
  if (!eff) return { weeks: [], byWeek: new Map() };
  const weeks = listWeeks(eff.from, eff.to);
  const byWeek = new Map<string, Map<string, number>>(weeks.map((w) => [w, new Map()]));
  for (const e of entries) {
    const wk = byWeek.get(weekStartYmd(e.date));
    if (!wk) continue;
    const per = minutesForStudent(e, attribution);
    for (const sid of e.studentIds) wk.set(sid, (wk.get(sid) ?? 0) + per);
  }
  return { weeks, byWeek };
}

/**
 * One student's weekly direct/indirect split, zero-filled across the range.
 * Distinct from `weeklyByGroup`, which sums raw clock time for the whole
 * caseload: a single-student chart has to credit group sessions through the
 * selected attribution, or every group hour would show up here in full.
 */
export function studentWeeklyByGroup(
  entries: Entry[],
  categories: Category[],
  studentId: string,
  attribution: Attribution,
  range: DateRange,
): WeekGroupRow[] {
  const mine = entries.filter((e) => e.studentIds.includes(studentId));
  const eff = effectiveRange(mine, range);
  if (!eff) return [];
  const rows = new Map<string, WeekGroupRow>();
  for (const w of listWeeks(eff.from, eff.to)) rows.set(w, { week: w, direct: 0, indirect: 0 });
  for (const e of mine) {
    const row = rows.get(weekStartYmd(e.date));
    if (row) row[categoryGroupOf(e.categoryId, categories)] += minutesForStudent(e, attribution);
  }
  return [...rows.values()];
}

/** Every entry the student attended, newest first. */
export function studentEntries(entries: Entry[], studentId: string): Entry[] {
  return entries
    .filter((e) => e.studentIds.includes(studentId))
    .toSorted((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}

/**
 * The shape of a student's service over a window, as facts rather than prose.
 *
 * This is the half of "summarise this student" that needs no model at all
 * (docs/local-llm.md §5): how often she is actually seeing them, how long the
 * quiet stretches were, how many times they did not turn up. All of it is a
 * query over structured entries, so it is instant and it is always right —
 * which is exactly what a model is worst at and this is best at.
 */
export interface ServicePattern {
  /** Direct-service sessions that carried time. What a mandate is measured in. */
  sessions: number;
  /** Mean days between consecutive sessions. Null with fewer than two. */
  meanDaysBetween: number | null;
  /** Stretches of at least `GAP_DAYS` with no direct service, longest first. */
  gaps: ServiceGap[];
  /** No-shows and cancellations — untimed categories, which store zero minutes. */
  missed: number;
  /** The most recent direct session, or null when there has not been one. */
  lastSession: string | null;
}

export interface ServiceGap {
  /** The session before the quiet stretch, and the one that ended it. */
  from: string;
  to: string;
  days: number;
}

/**
 * Three weeks. Long enough to skip a fortnight's holiday and a single missed
 * week without crying wolf, short enough that a term's silence is caught.
 */
const GAP_DAYS = 21;

export function servicePattern(
  entries: Entry[],
  categories: Category[],
  studentId: string,
): ServicePattern {
  const mine = entries.filter((e) => e.studentIds.includes(studentId));
  const missed = mine.filter((e) => isUntimed(e.categoryId, categories)).length;

  // Untimed events are deliberately excluded from the cadence: a no-show is
  // evidence that a session did *not* happen, and counting it as one would
  // report a student as seen regularly on the strength of their absences.
  const dates = mine
    .filter(
      (e) =>
        categoryGroupOf(e.categoryId, categories) === "direct" &&
        !isUntimed(e.categoryId, categories),
    )
    .map((e) => e.date)
    .toSorted((a, b) => a.localeCompare(b));

  const gaps: ServiceGap[] = [];
  let spanned = 0;
  for (let i = 1; i < dates.length; i += 1) {
    const days = daysBetween(dates[i - 1]!, dates[i]!);
    spanned += days;
    if (days >= GAP_DAYS) gaps.push({ from: dates[i - 1]!, to: dates[i]!, days });
  }

  return {
    sessions: dates.length,
    meanDaysBetween: dates.length > 1 ? Math.round(spanned / (dates.length - 1)) : null,
    gaps: gaps.toSorted((a, b) => b.days - a.days),
    missed,
    lastSession: dates[dates.length - 1] ?? null,
  };
}

/**
 * Whole days between two calendar dates. Built from UTC midnights on purpose:
 * local-time arithmetic across a daylight-saving boundary is off by one, and a
 * "21 days" threshold that moves twice a year is a bug nobody would look for.
 */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export interface MandateRow {
  student: Student;
  mandated: number;
  /** Average actual service minutes per week over the range. */
  actualPerWeek: number;
}

/** Mandate comparisons always use service attribution — mandates are per-student service minutes. */
export function mandateComparison(
  entries: Entry[],
  students: Student[],
  categories: Category[],
  range: DateRange,
): MandateRow[] {
  const totals = perStudentTotals(entries, students, categories, "service", range);
  return totals
    .filter((t) => t.student.iep && t.student.mandatedMinutesPerWeek)
    .map((t) => ({
      student: t.student,
      mandated: t.student.mandatedMinutesPerWeek!,
      actualPerWeek: t.avgPerWeek,
    }))
    .toSorted((a, b) => b.actualPerWeek - a.actualPerWeek);
}

export interface WeeklySummaryRow {
  week: string;
  /**
   * Null on the school-level row — the week's meetings, lessons and systems
   * time, which no student column can hold. At most one such row per week.
   */
  student: Student | null;
  direct: number;
  indirect: number;
  total: number;
  /** Untimed events (no-shows and the like) — a count, not minutes. */
  untimed: number;
}

/**
 * One row per student per week, plus one school-level row per week that has
 * any — the pivot-table-friendly export.
 *
 * That extra row is what makes the file sum back to real clock time. Without it
 * a "weekly totals" export silently drops a whole category of work, which is
 * the bug this feature exists to fix, faithfully reproduced in a spreadsheet.
 */
export function weeklySummaryRows(
  entries: Entry[],
  students: Student[],
  categories: Category[],
  attribution: Attribution,
  // Unused: rows are derived from `entries`, which the caller has already
  // filtered to the range. Kept so the signature matches its sibling exports.
  _range: DateRange,
): WeeklySummaryRow[] {
  /** Stands in for a student id on the school-level row. Ids are UUIDs, so "" cannot collide. */
  const SCHOOL = "";
  const key = (w: string, sid: string) => `${w}|${sid}`;
  const acc = new Map<string, WeeklySummaryRow>();
  const byId = new Map(students.map((s) => [s.id, s]));

  const bump = (
    w: string,
    sid: string,
    student: Student | null,
    group: "direct" | "indirect",
    untimed: boolean,
    minutes: number,
  ) => {
    let row = acc.get(key(w, sid));
    if (!row) {
      row = { week: w, student, direct: 0, indirect: 0, total: 0, untimed: 0 };
      acc.set(key(w, sid), row);
    }
    if (untimed) {
      row.untimed += 1;
      return;
    }
    row[group] += minutes;
    row.total += minutes;
  };

  for (const e of entries) {
    const w = weekStartYmd(e.date);
    const group = categoryGroupOf(e.categoryId, categories);
    const untimed = isUntimed(e.categoryId, categories);

    if (isSchoolLevel(e)) {
      // Minutes as logged, with no attribution applied: attribution divides a
      // session among the students who attended it, and there are none here.
      bump(w, SCHOOL, null, group, untimed, e.minutes);
      continue;
    }
    const per = minutesForStudent(e, attribution);
    for (const sid of e.studentIds) {
      const student = byId.get(sid);
      if (!student) continue;
      bump(w, sid, student, group, untimed, per);
    }
  }

  return [...acc.values()].toSorted(
    (a, b) =>
      a.week.localeCompare(b.week) ||
      // School-level closes out its week: it is the row that is not a student,
      // so it reads as a subtotal under the names it is not one of.
      Number(!a.student) - Number(!b.student) ||
      (a.student?.name ?? "").localeCompare(b.student?.name ?? ""),
  );
}

export function studentName(doc: DataDoc, id: string): string {
  return doc.students.find((s) => s.id === id)?.name ?? "(deleted)";
}

export function categoryName(doc: DataDoc, id: string): string {
  return doc.categories.find((c) => c.id === id)?.name ?? "(deleted)";
}

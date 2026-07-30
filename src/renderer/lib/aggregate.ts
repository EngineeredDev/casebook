import type { Category, DataDoc, Entry, Student } from "../../shared/types.ts";
import { listWeeks, weekStartYmd, type DateRange } from "./time.ts";

/**
 * How a group entry's minutes count against each attending student:
 * - "service": each student is credited the full duration (IEP service-minutes view)
 * - "share":   the duration is split evenly (true workload view)
 */
export type Attribution = "service" | "share";

export function minutesForStudent(entry: Entry, attribution: Attribution): number {
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

/** Number of Monday-weeks the (clamped) range spans — the divisor for per-week averages. */
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
  student: Student;
  direct: number;
  indirect: number;
  total: number;
  /** Untimed events (no-shows and the like) — a count, not minutes. */
  untimed: number;
}

/** One row per student per week (weeks with time only) — the pivot-table-friendly export. */
export function weeklySummaryRows(
  entries: Entry[],
  students: Student[],
  categories: Category[],
  attribution: Attribution,
  // Unused: rows are derived from `entries`, which the caller has already
  // filtered to the range. Kept so the signature matches its sibling exports.
  _range: DateRange,
): WeeklySummaryRow[] {
  const key = (w: string, sid: string) => `${w}|${sid}`;
  const acc = new Map<string, WeeklySummaryRow>();
  const byId = new Map(students.map((s) => [s.id, s]));
  for (const e of entries) {
    const w = weekStartYmd(e.date);
    const per = minutesForStudent(e, attribution);
    const group = categoryGroupOf(e.categoryId, categories);
    const untimed = isUntimed(e.categoryId, categories);
    for (const sid of e.studentIds) {
      const student = byId.get(sid);
      if (!student) continue;
      let row = acc.get(key(w, sid));
      if (!row) {
        row = { week: w, student, direct: 0, indirect: 0, total: 0, untimed: 0 };
        acc.set(key(w, sid), row);
      }
      if (untimed) {
        row.untimed += 1;
        continue;
      }
      row[group] += per;
      row.total += per;
    }
  }
  return [...acc.values()].toSorted(
    (a, b) => a.week.localeCompare(b.week) || a.student.name.localeCompare(b.student.name),
  );
}

export function studentName(doc: DataDoc, id: string): string {
  return doc.students.find((s) => s.id === id)?.name ?? "(deleted)";
}

export function categoryName(doc: DataDoc, id: string): string {
  return doc.categories.find((c) => c.id === id)?.name ?? "(deleted)";
}

/**
 * The school-level rules, which are decisions rather than compile errors.
 *
 * Every assertion here is one of the two halves of `isSchoolLevel`'s contract:
 * time with no student counts toward the totals that claim to be clock time,
 * and toward no per-student number at all. Nothing enforces either at the type
 * level — an entry with no students typechecks everywhere — so this file is
 * what keeps the audit from quietly rotting.
 */

import { describe, expect, it } from "vitest";
import type { Category, Entry, Student } from "../../shared/types.ts";
import {
  clockTotals,
  isSchoolLevel,
  mandateComparison,
  perStudentTotals,
  schoolLevelTotals,
  weeklyByGroup,
  weeklySummaryRows,
} from "./aggregate.ts";
import { weekStartYmd, type DateRange } from "./time.ts";

const DIRECT: Category = { id: "c-direct", name: "Direct service", group: "direct" };
const INDIRECT: Category = { id: "c-indirect", name: "Case management", group: "indirect" };
const NOSHOW: Category = { id: "c-noshow", name: "No-show", group: "direct", untimed: true };
const CATEGORIES = [DIRECT, INDIRECT, NOSHOW];

const casey: Student = {
  id: "s-casey",
  name: "Casey",
  iep: true,
  mandatedMinutesPerWeek: 60,
  active: true,
  createdAt: "2026-01-05T09:00:00.000Z",
};
const devon: Student = {
  id: "s-devon",
  name: "Devon",
  iep: false,
  active: true,
  createdAt: "2026-01-05T09:00:00.000Z",
};
const STUDENTS = [casey, devon];

/** Both Mondays, so the week arithmetic in the assertions is visible. */
const WEEK_1 = "2026-05-04";
const WEEK_2 = "2026-05-11";
const RANGE: DateRange = { from: "2026-05-04", to: "2026-05-17" };

let seq = 0;
function entry(patch: Partial<Entry> = {}): Entry {
  seq += 1;
  return {
    id: `e-${seq}`,
    date: WEEK_1,
    minutes: 30,
    categoryId: DIRECT.id,
    studentIds: [],
    createdAt: "2026-05-04T09:00:00.000Z",
    ...patch,
  };
}

describe("isSchoolLevel", () => {
  it("is true only when nobody is on the entry", () => {
    expect(isSchoolLevel(entry({ studentIds: [] }))).toBe(true);
    expect(isSchoolLevel(entry({ studentIds: [casey.id] }))).toBe(false);
    expect(isSchoolLevel(entry({ studentIds: [casey.id, devon.id] }))).toBe(false);
  });
});

describe("school-level time counts as clock time", () => {
  const entries = [
    entry({ studentIds: [casey.id], minutes: 30, categoryId: DIRECT.id }),
    entry({ studentIds: [], minutes: 45, categoryId: INDIRECT.id }),
  ];

  it("lands in clockTotals under its own category group", () => {
    expect(clockTotals(entries, CATEGORIES)).toEqual({ direct: 30, indirect: 45, total: 75 });
  });

  it("lands in the weekly direct/indirect split", () => {
    const week = weeklyByGroup(entries, CATEGORIES, RANGE).find((w) => w.week === WEEK_1);
    expect(week).toEqual({ week: WEEK_1, direct: 30, indirect: 45 });
  });

  it("is reportable on its own, so a page can explain the gap it opens", () => {
    expect(schoolLevelTotals(entries, CATEGORIES)).toEqual({
      direct: 0,
      indirect: 45,
      total: 45,
    });
  });
});

describe("school-level time reaches no per-student number", () => {
  const entries = [
    entry({ studentIds: [casey.id], minutes: 30 }),
    entry({ studentIds: [], minutes: 600 }),
  ];

  it("leaves per-student totals untouched", () => {
    const rows = perStudentTotals(entries, STUDENTS, CATEGORIES, "share", RANGE);
    expect(rows.find((r) => r.student.id === casey.id)?.total).toBe(30);
    expect(rows.find((r) => r.student.id === devon.id)?.total).toBe(0);
    // The 600 minutes are nowhere in this table — that gap is the point.
    expect(rows.reduce((sum, r) => sum + r.total, 0)).toBe(30);
  });

  it("cannot inflate a mandate comparison", () => {
    const studentOnly = [entry({ studentIds: [casey.id], minutes: 30 })];
    const both = [...studentOnly, entry({ studentIds: [], minutes: 600 })];
    expect(mandateComparison(both, STUDENTS, CATEGORIES, RANGE)).toEqual(
      mandateComparison(studentOnly, STUDENTS, CATEGORIES, RANGE),
    );
  });

  it("does widen the per-week divisor when it falls in an otherwise empty week", () => {
    // Deliberate, and worth pinning down because it is the one way school-level
    // work moves a per-student number. `weekCount` clamps to the span the data
    // covers, and school-level work is data: a week spent entirely in meetings
    // is a week her students were seen for zero minutes, and averaging over it
    // says so instead of dropping the week from the denominator.
    const oneWeek = [entry({ date: WEEK_1, studentIds: [casey.id], minutes: 60 })];
    const twoWeeks = [...oneWeek, entry({ date: WEEK_2, studentIds: [], minutes: 300 })];
    expect(mandateComparison(oneWeek, STUDENTS, CATEGORIES, RANGE)[0]?.actualPerWeek).toBe(60);
    expect(mandateComparison(twoWeeks, STUDENTS, CATEGORIES, RANGE)[0]?.actualPerWeek).toBe(30);
  });

  it("does not create a phantom student row", () => {
    const rows = perStudentTotals([entry({ studentIds: [] })], [], CATEGORIES, "share", RANGE);
    expect(rows).toEqual([]);
  });
});

describe("weeklySummaryRows", () => {
  it("emits one school-level row per week, sorted under that week's students", () => {
    const rows = weeklySummaryRows(
      [
        entry({ date: WEEK_1, studentIds: [devon.id], minutes: 30 }),
        entry({ date: WEEK_1, studentIds: [casey.id], minutes: 30 }),
        entry({ date: WEEK_1, studentIds: [], minutes: 45, categoryId: INDIRECT.id }),
        entry({ date: WEEK_1, studentIds: [], minutes: 15, categoryId: INDIRECT.id }),
        entry({ date: WEEK_2, studentIds: [], minutes: 20, categoryId: INDIRECT.id }),
      ],
      STUDENTS,
      CATEGORIES,
      "share",
      RANGE,
    );

    expect(rows.map((r) => [r.week, r.student?.name ?? null, r.total])).toEqual([
      [WEEK_1, "Casey", 30],
      [WEEK_1, "Devon", 30],
      // Same week's school-level work accumulates into a single closing row.
      [WEEK_1, null, 60],
      [WEEK_2, null, 20],
    ]);
  });

  it("sums back to real clock time, which is the whole reason the row exists", () => {
    const entries = [
      entry({ studentIds: [casey.id, devon.id], minutes: 60 }),
      entry({ studentIds: [], minutes: 45, categoryId: INDIRECT.id }),
    ];
    const rows = weeklySummaryRows(entries, STUDENTS, CATEGORIES, "share", RANGE);
    expect(rows.reduce((sum, r) => sum + r.total, 0)).toBe(clockTotals(entries, CATEGORIES).total);
  });

  it("never divides school-level minutes, whichever attribution is picked", () => {
    const entries = [entry({ studentIds: [], minutes: 45, categoryId: INDIRECT.id })];
    for (const attribution of ["share", "service"] as const) {
      const [row] = weeklySummaryRows(entries, STUDENTS, CATEGORIES, attribution, RANGE);
      expect(row?.student).toBeNull();
      expect(row?.indirect).toBe(45);
    }
  });

  it("counts an untimed school-level event rather than adding minutes for it", () => {
    const [row] = weeklySummaryRows(
      [entry({ studentIds: [], minutes: 0, categoryId: NOSHOW.id })],
      STUDENTS,
      CATEGORIES,
      "share",
      RANGE,
    );
    // A cancelled staff meeting is as loggable as a no-show.
    expect(row?.untimed).toBe(1);
    expect(row?.total).toBe(0);
  });

  it("keys the school-level row on the week, not on a student id that isn't there", () => {
    const rows = weeklySummaryRows(
      [
        entry({ date: WEEK_1, studentIds: [] }),
        entry({ date: "2026-05-06", studentIds: [] }), // same week, different day
      ],
      STUDENTS,
      CATEGORIES,
      "share",
      RANGE,
    );
    expect(weekStartYmd("2026-05-06")).toBe(WEEK_1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.total).toBe(60);
  });
});

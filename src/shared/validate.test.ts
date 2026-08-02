/**
 * The last gate a document passes through before it becomes the file
 * everything else depends on.
 *
 * Two properties matter here and they pull against each other. It has to refuse
 * a document that would be unreadable or would quietly stop adding up — the
 * whole reason it exists is that the old check looked at five array *types* and
 * let an entry with `"30"` minutes straight through. And it must not refuse a
 * document that is merely untidy, because the untidy states are ones the app
 * produces on purpose: deleting a category leaves the entries that used it, and
 * a validator that refused those would refuse every save after a deletion.
 *
 * So the shape of this file is: for each field, one test that a real value
 * passes and one that a plausible wrong value does not.
 */

import { describe, expect, it } from "vitest";
import { emptyDoc, type DataDoc, type Entry, type Student } from "./types.ts";
import { docRefusal, validateDoc } from "./validate.ts";

const CATEGORY = "cat-direct";

function entry(patch: Partial<Entry> = {}): Entry {
  return {
    id: "e-1",
    date: "2026-03-04",
    minutes: 30,
    categoryId: CATEGORY,
    studentIds: ["s-1"],
    createdAt: "2026-03-04T09:00:00.000Z",
    ...patch,
  };
}

function student(patch: Partial<Student> = {}): Student {
  return {
    id: "s-1",
    name: "Ada",
    iep: true,
    active: true,
    createdAt: "2026-01-05T09:00:00.000Z",
    ...patch,
  };
}

/** A document the app itself would produce, which must always be accepted. */
function doc(patch: Partial<DataDoc> = {}): DataDoc {
  return {
    ...emptyDoc(),
    rev: 4,
    categories: [{ id: CATEGORY, name: "Individual counseling", group: "direct" }],
    students: [student()],
    entries: [entry()],
    ...patch,
  };
}

/** The fatal reasons, so a test can say which one it expected. */
function fatal(candidate: unknown): string[] {
  return validateDoc(candidate).fatal;
}

describe("a document the app wrote", () => {
  it("passes", () => {
    expect(validateDoc(doc())).toEqual({ fatal: [], warnings: [] });
  });

  it("passes when it is brand new and empty", () => {
    expect(fatal(emptyDoc())).toEqual([]);
  });

  it("passes with every optional field present and every one absent", () => {
    expect(
      fatal(
        doc({
          categories: [
            { id: CATEGORY, name: "Absent", group: "direct", untimed: true, archived: true },
          ],
          students: [student({ mandatedMinutesPerWeek: 60, grade: "4" })],
          entries: [entry({ startTime: "10:55", note: "<p>Talked.</p>" })],
          importMappings: { "routine session": CATEGORY },
        }),
      ),
    ).toEqual([]);
  });

  it("passes a school-level entry, which belongs to nobody on purpose", () => {
    expect(fatal(doc({ entries: [entry({ studentIds: [] })] }))).toEqual([]);
  });
});

describe("what it refuses", () => {
  it("refuses anything that isn't a document at all", () => {
    expect(fatal(null)).toHaveLength(1);
    expect(fatal("a string")).toHaveLength(1);
    expect(fatal([])).not.toEqual([]);
  });

  it("refuses a version from another era", () => {
    expect(fatal(doc({ version: 2 as DataDoc["version"] }))).toEqual([
      expect.stringContaining("version"),
    ]);
  });

  it("refuses null settings, which typeof calls an object", () => {
    // The bug this started as: `typeof null === "object"`, so a document with
    // null settings saved happily and then failed the stricter check on the way
    // back in at next launch — a file the app wrote and could not read.
    expect(fatal(doc({ settings: null as unknown as DataDoc["settings"] }))).toEqual([
      expect.stringContaining("settings"),
    ]);
  });

  it("refuses a school year that isn't a month", () => {
    const settings = { clinicianName: "", schoolYearStartMonth: 13 };
    expect(fatal(doc({ settings }))).toEqual([expect.stringContaining("schoolYearStartMonth")]);
  });

  it("refuses minutes that are a string, a fraction, negative, or absurd", () => {
    for (const minutes of ["30" as unknown as number, 22.5, -30, 60 * 25]) {
      expect(fatal(doc({ entries: [entry({ minutes })] })), `minutes: ${minutes}`).toEqual([
        expect.stringContaining("minutes"),
      ]);
    }
  });

  it("refuses a date that isn't one, including a day that doesn't exist", () => {
    // "2026-02-31" matches the pattern and is not a date. Every report that
    // groups by week would file it in a week it does not belong to.
    for (const date of ["next Tuesday", "2026-3-4", "2026-02-31", "", 20260304 as never]) {
      expect(fatal(doc({ entries: [entry({ date })] })), `date: ${date}`).toEqual([
        expect.stringContaining("date"),
      ]);
    }
  });

  it("refuses a start time that isn't a clock time", () => {
    for (const startTime of ["25:00", "9:05", "10:60", "morning"]) {
      expect(fatal(doc({ entries: [entry({ startTime })] })), startTime).toEqual([
        expect.stringContaining("startTime"),
      ]);
    }
  });

  it("accepts a start time that is absent or explicitly null", () => {
    expect(fatal(doc({ entries: [entry({ startTime: null })] }))).toEqual([]);
    expect(fatal(doc({ entries: [entry({ startTime: undefined })] }))).toEqual([]);
  });

  it("refuses an item with no id, because an empty id can never resolve", () => {
    expect(fatal(doc({ entries: [entry({ id: "" })] }))).toEqual([expect.stringContaining("id")]);
    expect(fatal(doc({ students: [student({ id: "" })] }))).toEqual([
      expect.stringContaining("id"),
    ]);
  });

  it("refuses a fractional mandate, which makes every compliance figure wrong", () => {
    expect(fatal(doc({ students: [student({ mandatedMinutesPerWeek: 22.5 })] }))).toEqual([
      expect.stringContaining("mandatedMinutesPerWeek"),
    ]);
  });

  it("accepts a mandate that is null or absent, which is how a non-IEP student looks", () => {
    expect(fatal(doc({ students: [student({ mandatedMinutesPerWeek: null })] }))).toEqual([]);
    expect(fatal(doc({ students: [student({ iep: false })] }))).toEqual([]);
  });

  it("refuses mappings that are an array, which typeof also calls an object", () => {
    const importMappings = [CATEGORY] as unknown as DataDoc["importMappings"];
    expect(fatal(doc({ importMappings }))).toEqual([expect.stringContaining("importMappings")]);
  });

  it("names every problem it found, not only the first", () => {
    const problems = fatal(
      doc({ entries: [entry({ id: "", date: "nope", minutes: -1 }), entry({ minutes: 1.5 })] }),
    );
    expect(problems.length).toBeGreaterThan(3);
  });

  it("walks a null array without throwing on it", () => {
    // The validator must survive the documents it exists to catch.
    expect(() => fatal(doc({ entries: null as unknown as Entry[] }))).not.toThrow();
    expect(fatal(doc({ entries: null as unknown as Entry[] }))).toEqual([
      expect.stringContaining("entries"),
    ]);
  });
});

describe("what it merely mentions", () => {
  it("lets an entry keep a category she has deleted", () => {
    // Deleting a category deliberately leaves the entries that used it, and the
    // UI renders "(deleted)". Refusing this would refuse every save after a
    // deletion — worse than not validating at all.
    const result = validateDoc(doc({ entries: [entry({ categoryId: "cat-gone" })] }));
    expect(result.fatal).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("category")]);
  });

  it("lets an entry keep a student who is no longer on the roster", () => {
    const result = validateDoc(doc({ entries: [entry({ studentIds: ["s-gone"] })] }));
    expect(result.fatal).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("student")]);
  });

  it("says nothing about references when there is nothing to check them against", () => {
    // A document mid-restore can legitimately have entries and no categories
    // yet. Warning on every one of them would be noise, not a signal.
    const result = validateDoc(doc({ categories: [], students: [] }));
    expect(result.warnings).toEqual([]);
  });
});

describe("the sentence it hands back", () => {
  it("is null for a document that may be written", () => {
    expect(docRefusal(doc())).toBeNull();
  });

  it("names what was wrong", () => {
    expect(docRefusal(doc({ entries: [entry({ minutes: -5 })] }))).toContain("minutes");
  });

  it("stays short even when everything is wrong", () => {
    const entries = Array.from({ length: 40 }, (_, i) => entry({ id: `e-${i}`, minutes: -1 }));
    const message = docRefusal(doc({ entries }))!;
    expect(message).toContain("and 35 more");
    expect(message.length).toBeLessThan(400);
  });
});

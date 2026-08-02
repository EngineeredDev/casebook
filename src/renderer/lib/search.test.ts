/**
 * The query language's flags.
 *
 * `matchEntry` is tested against hand-built `IndexedEntry` values rather than
 * through `buildIndex`, which parses note HTML with DOMParser and so needs a
 * DOM these tests deliberately do not have. That is the right seam anyway: the
 * flags are decisions about entries, and the index is just where the strings
 * were precomputed.
 *
 * The non-school flags are covered too, because they were a nested ternary
 * until `matchFlag` split them apart and a silently-shifted branch is exactly
 * what that kind of refactor loses.
 */

import { describe, expect, it } from "vitest";
import type { Category, Entry } from "../../shared/types.ts";
import { matchEntry, parseQuery, type IndexedEntry } from "./search.ts";

const DIRECT: Category = { id: "c-direct", name: "Direct service", group: "direct" };

function entry(patch: Partial<Entry> = {}): Entry {
  return {
    id: "e-1",
    date: "2026-05-04",
    minutes: 30,
    categoryId: DIRECT.id,
    studentIds: [],
    createdAt: "2026-05-04T09:00:00.000Z",
    ...patch,
  };
}

function indexed(patch: Partial<IndexedEntry> = {}): IndexedEntry {
  return {
    entry: entry(),
    students: [],
    category: DIRECT,
    group: "direct",
    untimed: false,
    iep: false,
    note: "",
    haystack: "direct service 2026-05-04",
    ...patch,
  };
}

const matches = (query: string, idx: IndexedEntry) => !!matchEntry(parseQuery(query), idx);

const schoolLevel = indexed({ entry: entry({ studentIds: [] }) });
const oneStudent = indexed({ entry: entry({ studentIds: ["s-casey"] }) });
const groupSession = indexed({ entry: entry({ studentIds: ["s-casey", "s-devon"] }) });

describe("parseQuery", () => {
  it("reads is:school as a flag rather than as text with a colon in it", () => {
    expect(parseQuery("is:school").terms).toEqual([
      { kind: "flag", flag: "school", negated: false },
    ]);
  });

  it("keeps the is: and student: namespaces apart", () => {
    expect(parseQuery("is:student").terms).toEqual([
      { kind: "flag", flag: "student", negated: false },
    ]);
    expect(parseQuery("student:casey").terms).toEqual([
      { kind: "field", field: "student", value: "casey", negated: false },
    ]);
  });
});

describe("is:school and is:student", () => {
  it("selects entries with nobody on them", () => {
    expect(matches("is:school", schoolLevel)).toBe(true);
    expect(matches("is:school", oneStudent)).toBe(false);
    expect(matches("is:school", groupSession)).toBe(false);
  });

  it("is an exact complement", () => {
    for (const idx of [schoolLevel, oneStudent, groupSession]) {
      expect(matches("is:student", idx)).toBe(!matches("is:school", idx));
    }
  });

  it("negates", () => {
    expect(matches("-is:school", oneStudent)).toBe(true);
    expect(matches("-is:school", schoolLevel)).toBe(false);
  });
});

describe("the flags that were already there", () => {
  it("is:group still means more than one student, not merely some", () => {
    expect(matches("is:group", groupSession)).toBe(true);
    expect(matches("is:group", oneStudent)).toBe(false);
    expect(matches("is:group", schoolLevel)).toBe(false);
  });

  it("keeps untimed, timed, iep and has:note on their own branches", () => {
    expect(matches("is:untimed", indexed({ untimed: true }))).toBe(true);
    expect(matches("is:untimed", indexed({ untimed: false }))).toBe(false);
    expect(matches("is:timed", indexed({ untimed: false }))).toBe(true);
    expect(matches("is:timed", indexed({ untimed: true }))).toBe(false);
    expect(matches("is:iep", indexed({ iep: true }))).toBe(true);
    expect(matches("is:iep", indexed({ iep: false }))).toBe(false);
    expect(matches("has:note", indexed({ note: "guardian called" }))).toBe(true);
    expect(matches("has:note", indexed({ note: "" }))).toBe(false);
  });

  it("a school-level entry is never an IEP entry — it has no student to be one", () => {
    expect(matches("is:iep", schoolLevel)).toBe(false);
  });
});

describe("flags combine with everything else", () => {
  it("ANDs with a category term", () => {
    const idx = indexed({
      entry: entry({ studentIds: [] }),
      category: { id: "c-mtss", name: "MTSS meeting", group: "indirect" },
      haystack: "mtss meeting",
    });
    expect(matches("is:school cat:mtss", idx)).toBe(true);
    expect(matches("is:school cat:documentation", idx)).toBe(false);
  });
});

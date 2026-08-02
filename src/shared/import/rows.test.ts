/**
 * What the review grid promises, in the only place it can be checked cheaply.
 *
 * The bug that produced this file: the grid displayed a corrected start time
 * and the commit path wrote the *parsed* one, so a time she had fixed, looked
 * at and confirmed reverted in the permanent record — the worst shape of bug
 * for a clinical log, because she watched herself fix it. The defence is not a
 * test that the time survives, it is that one function decides what a row means
 * and both consumers read it. These tests hold that function to it.
 *
 * So every field a person can correct gets the same two assertions: her edit
 * wins, and her *emptying* of the field wins too. The second is the one that
 * fell over — `?? entry.startTime` silently reinstates a time she deleted.
 */

import { describe, expect, it } from "vitest";
import type { Category, Entry } from "../types.ts";
import type { ChunkFlag, ParsedEntry } from "./types.ts";
import { effectiveRow, effectiveRows, type RowContext, type RowEdit } from "./rows.ts";

/**
 * Category names deliberately share no words with the type phrase below.
 * `resolvePhrase` falls back to lexical matching against category names, so a
 * category called "Routine session" would resolve "Routine Session" on its own
 * and the tests here would stop being about the mapping table at all.
 */
const DIRECT: Category = { id: "cat-direct", name: "Individual counseling", group: "direct" };
const NO_SHOW: Category = { id: "cat-noshow", name: "Absent", group: "direct", untimed: true };

function entry(patch: Partial<ParsedEntry> = {}, line = 0): ParsedEntry {
  return {
    chunk: { id: "c1", text: "…", startLine: line, endLine: line + 1 },
    date: "2026-03-04",
    startTime: "10:55",
    minutes: 25,
    typePhrase: "Routine Session",
    note: "<p>Worked on the letter.</p>",
    flags: [],
    ...patch,
  };
}

function context(patch: Partial<RowContext> = {}): RowContext {
  return {
    categories: [DIRECT, NO_SHOW],
    mappings: { "routine session": DIRECT.id },
    aiMappings: {},
    aiRows: {},
    phraseMinutes: {},
    studentId: "student-1",
    existing: [],
    ...patch,
  };
}

function row(edit: RowEdit = {}, e = entry(), ctx = context()) {
  return effectiveRow(e, edit, ctx);
}

describe("a field she corrected", () => {
  it("commits the start time she typed, not the one the document said", () => {
    expect(row({ startTime: "11:30" }).startTime).toBe("11:30");
  });

  it("keeps a start time she deleted deleted", () => {
    // `?? entry.startTime` would put "10:55" straight back. An empty string is
    // a decision, not a missing value.
    expect(row({ startTime: "" }).startTime).toBe("");
  });

  it("falls back to the parsed time when she has not touched the field", () => {
    expect(row({}).startTime).toBe("10:55");
  });

  it("reads as no time at all when the header carried none", () => {
    expect(row({}, entry({ startTime: null, flags: ["no-time"] })).startTime).toBe("");
  });

  it("takes her date, minutes, note and category over the parsed ones", () => {
    const r = row({
      date: "2026-03-11",
      minutes: 45,
      note: "<p>Rewritten.</p>",
      categoryId: NO_SHOW.id,
    });
    expect(r.date).toBe("2026-03-11");
    expect(r.note).toBe("<p>Rewritten.</p>");
    expect(r.category).toBe(NO_SHOW);
    // Untimed wins over her 45: the category, not the number, decides.
    expect(r.minutes).toBe(0);
  });
});

describe("the category a row lands in", () => {
  it("uses her persisted mapping for the phrase", () => {
    expect(row().category).toBe(DIRECT);
  });

  it("prefers her decision to the model's for the same phrase", () => {
    const ctx = context({
      mappings: { "routine session": NO_SHOW.id },
      aiMappings: { "routine session": DIRECT.id },
    });
    const r = row({}, entry(), ctx);
    expect(r.category).toBe(NO_SHOW);
    expect(r.fromAi).toBe(false);
  });

  it("marks a row still resting on the model, and never calls it ready", () => {
    const ctx = context({ mappings: {}, aiMappings: { "routine session": DIRECT.id } });
    const r = row({}, entry(), ctx);
    expect(r.fromAi).toBe(true);
    expect(r.status).toBe("check");
  });

  it("takes a per-row guess for an entry that carries no phrase", () => {
    const ctx = context({ mappings: {}, aiRows: { 0: DIRECT.id } });
    const r = row({}, entry({ typePhrase: null, flags: ["no-type-phrase"] }), ctx);
    expect(r.category).toBe(DIRECT);
    expect(r.fromAi).toBe(true);
  });

  it("ignores a mapping pointing at a category that no longer exists", () => {
    const ctx = context({ mappings: { "routine session": "cat-deleted" } });
    expect(row({}, entry(), ctx).category).toBeNull();
  });
});

describe("how long a row says it was", () => {
  it("stores zero for an untimed category however long the header ran", () => {
    expect(row({ categoryId: NO_SHOW.id }).minutes).toBe(0);
  });

  it("uses her per-phrase duration when the header only gave one time", () => {
    const flags: ChunkFlag[] = ["assumed-duration"];
    const ctx = context({ phraseMinutes: { "routine session": 30 } });
    expect(row({}, entry({ minutes: 15, flags }), ctx).minutes).toBe(30);
  });

  it("lets her typed minutes beat the per-phrase duration", () => {
    const flags: ChunkFlag[] = ["assumed-duration"];
    const ctx = context({ phraseMinutes: { "routine session": 30 } });
    expect(row({ minutes: 20 }, entry({ minutes: 15, flags }), ctx).minutes).toBe(20);
  });
});

describe("what a row admits to", () => {
  it("is incomplete without a date", () => {
    expect(row({}, entry({ date: null })).status).toBe("incomplete");
  });

  it("is incomplete without a category", () => {
    expect(row({}, entry(), context({ mappings: {} })).status).toBe("incomplete");
  });

  it("is incomplete at zero minutes in a timed category", () => {
    expect(row({ minutes: 0 }).status).toBe("incomplete");
  });

  it("is ready at zero minutes in an untimed one", () => {
    expect(row({ categoryId: NO_SHOW.id }).status).toBe("ready");
  });

  it("stops flagging an assumed duration once she has typed one", () => {
    const e = entry({ flags: ["assumed-duration"] });
    expect(row({}, e).unresolved).toEqual(["assumed-duration"]);
    expect(row({ minutes: 30 }, e).unresolved).toEqual([]);
    expect(row({ minutes: 30 }, e).status).toBe("ready");
  });

  it("stops flagging a missing phrase once she has chosen a category", () => {
    const e = entry({ typePhrase: null, flags: ["no-type-phrase"] });
    expect(row({ categoryId: DIRECT.id }, e).unresolved).toEqual([]);
  });

  it("keeps flagging a weak header, which no correction answers", () => {
    const e = entry({ flags: ["weak-header"] });
    expect(row({ date: "2026-03-11", minutes: 30 }, e).unresolved).toEqual(["weak-header"]);
  });
});

describe("the duplicate warning", () => {
  const existing: Entry[] = [
    {
      id: "e1",
      date: "2026-03-04",
      minutes: 25,
      categoryId: DIRECT.id,
      studentIds: ["student-1"],
      createdAt: "2026-03-04T10:00:00.000Z",
    },
  ];

  it("fires on the same student, date and category", () => {
    expect(row({}, entry(), context({ existing })).duplicate).toBe(true);
  });

  it("stays quiet for a different student", () => {
    expect(row({}, entry(), context({ existing, studentId: "student-2" })).duplicate).toBe(false);
  });

  it("stays quiet before she has chosen a student", () => {
    expect(row({}, entry(), context({ existing, studentId: null })).duplicate).toBe(false);
  });

  it("follows the date she corrected, not the one that was parsed", () => {
    expect(row({ date: "2026-03-11" }, entry(), context({ existing })).duplicate).toBe(false);
  });
});

describe("resolving a whole document", () => {
  it("matches each entry with the edits stored under its own start line", () => {
    const entries = [
      entry({}, 0),
      entry({ chunk: { id: "c2", text: "…", startLine: 7, endLine: 9 } }, 7),
    ];
    const rows = effectiveRows(entries, { 7: { startTime: "13:05" } }, context());
    expect(rows.map((r) => r.line)).toEqual([0, 7]);
    expect(rows.map((r) => r.startTime)).toEqual(["10:55", "13:05"]);
  });
});

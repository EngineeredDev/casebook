/**
 * The rules a half-typed entry is held under.
 *
 * Two of them do real work and both are easy to get wrong in opposite
 * directions. "Has she typed anything" cannot be "does this differ from a blank
 * form", because a blank form already has 30 minutes and a student scope in it
 * — that reading would put a confirmation dialog in front of every quit, which
 * is how people learn to click through them. And it cannot be "is the note
 * non-empty" either, because an emptied rich-text editor leaves `<p></p>`
 * behind: a non-empty string that is not a note.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDraft,
  draftHasContent,
  hasUnsavedDraft,
  readDraft,
  resetDraft,
  watchDraft,
  writeDraft,
  type LogDraft,
} from "./draft.ts";

/** The form as it looks the moment the page is opened and nothing is typed. */
function blank(patch: Partial<LogDraft> = {}): LogDraft {
  return {
    date: "2026-03-04",
    studentIds: [],
    scope: "student",
    categoryId: null,
    minutes: 30,
    customMinutes: "",
    startTime: "",
    note: "",
    ...patch,
  };
}

beforeEach(resetDraft);

describe("whether there is anything to lose", () => {
  it("says no to a form nobody has touched", () => {
    expect(draftHasContent(blank())).toBe(false);
  });

  it("says no to the defaults the form arrives with", () => {
    // 30 minutes and "student" are what the page shows before she does
    // anything. Counting them would mean every quit asks.
    expect(draftHasContent(blank({ minutes: 30, scope: "student" }))).toBe(false);
  });

  it("says no to a note the editor has been emptied of", () => {
    expect(draftHasContent(blank({ note: "<p></p>" }))).toBe(false);
    expect(draftHasContent(blank({ note: "<p><br></p>" }))).toBe(false);
  });

  it("says yes to a note with words in it", () => {
    expect(draftHasContent(blank({ note: "<p>Student asked to talk about home.</p>" }))).toBe(true);
  });

  it("says yes to a student, a category, a time or a typed duration", () => {
    expect(draftHasContent(blank({ studentIds: ["s-1"] }))).toBe(true);
    expect(draftHasContent(blank({ categoryId: "cat-1" }))).toBe(true);
    expect(draftHasContent(blank({ startTime: "10:55" }))).toBe(true);
    expect(draftHasContent(blank({ customMinutes: 25 }))).toBe(true);
  });
});

describe("holding it", () => {
  it("gives back what was put in", () => {
    const typed = blank({ note: "<p>Half a sentence</p>" });
    writeDraft(typed);
    expect(readDraft()).toEqual(typed);
    expect(hasUnsavedDraft()).toBe(true);
  });

  it("holds nothing rather than an empty draft", () => {
    // So that emptying the form by hand and never having typed in it are the
    // same state, and "is there unsaved work" stays one null check.
    writeDraft(blank());
    expect(readDraft()).toBeNull();
    expect(hasUnsavedDraft()).toBe(false);
  });

  it("forgets a saved entry immediately", () => {
    writeDraft(blank({ note: "<p>Saved now</p>" }));
    clearDraft();
    expect(readDraft()).toBeNull();
    expect(hasUnsavedDraft()).toBe(false);
  });
});

describe("telling the store", () => {
  it("speaks up when there is suddenly something to lose, and when there isn't", () => {
    const told = vi.fn();
    watchDraft(told);

    writeDraft(blank({ note: "<p>a</p>" }));
    expect(told).toHaveBeenCalledTimes(1);

    clearDraft();
    expect(told).toHaveBeenCalledTimes(2);
  });

  it("stays quiet while she is only typing", () => {
    // This runs on every keystroke and the one consumer is an IPC call. The
    // answer only changes twice in a note: when it starts and when it ends.
    const told = vi.fn();
    watchDraft(told);

    writeDraft(blank({ note: "<p>S</p>" }));
    writeDraft(blank({ note: "<p>St</p>" }));
    writeDraft(blank({ note: "<p>Stu</p>" }));

    expect(told).toHaveBeenCalledTimes(1);
  });

  it("stops telling a watcher that has let go", () => {
    const told = vi.fn();
    watchDraft(told)();
    writeDraft(blank({ note: "<p>a</p>" }));
    expect(told).not.toHaveBeenCalled();
  });
});

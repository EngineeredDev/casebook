/**
 * The formatter every export goes through. Small enough to read, and load
 * bearing enough that a wrong quote silently corrupts a spreadsheet rather
 * than failing.
 */

import { describe, expect, it } from "vitest";
import { toCsv } from "./csv.ts";

describe("toCsv", () => {
  it("quotes only the cells that need it", () => {
    expect(toCsv([["plain", "has,comma", 'has"quote', "has\nnewline"]])).toBe(
      'plain,"has,comma","has""quote","has\nnewline"',
    );
  });

  it("joins rows with CRLF, which is what spreadsheets expect", () => {
    expect(toCsv([["a"], ["b"]])).toBe("a\r\nb");
  });

  it("keeps an empty cell empty rather than dropping the column", () => {
    // How a school-level row carries its blank Student and IEP cells: the
    // commas have to survive, or every column after them shifts left.
    expect(toCsv([["2026-05-04", "", "School-level", "", 45]])).toBe(
      "2026-05-04,,School-level,,45",
    );
  });

  it("writes numbers without quoting them", () => {
    expect(toCsv([[0, 45, 0.8]])).toBe("0,45,0.8");
  });
});

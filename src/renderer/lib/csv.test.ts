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

describe("toCsv and cells a spreadsheet would run", () => {
  it("marks a text cell that opens with a formula character as text", () => {
    // It takes her having typed the name, so it is not a live threat — but the
    // export is a file she hands to someone else, and Excel runs the cell on
    // open rather than showing it.
    expect(toCsv([["=SUM(A1:A9)"], ["+1-555-0100"], ["-Ada"], ["@here"]])).toBe(
      "'=SUM(A1:A9)\r\n'+1-555-0100\r\n'-Ada\r\n'@here",
    );
  });

  it("catches the leading whitespace that hides a formula character", () => {
    // Excel trims before it decides, so "\t=cmd" is still a formula. The CR is
    // also quoted, and has to be: the prefix would otherwise leave a bare CR in
    // the middle of a row and end it three characters early.
    expect(toCsv([["\t=1+1", "\r=1+1"]])).toBe(`'\t=1+1,"'\r=1+1"`);
  });

  it("leaves a negative number a number", () => {
    // The one thing this guard must not do. Minutes and hours reach toCsv as
    // numbers; prefixing them would export '-45 as text and every total in her
    // report would be wrong — a much worse and much likelier outcome than the
    // formula cell above.
    expect(toCsv([[-45, -0.8, 45]])).toBe("-45,-0.8,45");
  });

  it("leaves an ordinary name alone", () => {
    // The prefix is invisible in a spreadsheet but not in a plain-text file, so
    // it has to land only on the cells that need it.
    expect(toCsv([["Ada Lovelace", "2026-05-04", "School-level", ""]])).toBe(
      "Ada Lovelace,2026-05-04,School-level,",
    );
  });
});

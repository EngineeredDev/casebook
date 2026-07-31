/**
 * What the import workbench is allowed to get wrong, and what it isn't.
 *
 * The stakes are asymmetric and the tests are shaped around that. A field
 * prefilled wrongly costs a correction in the review grid. A *dropped* chunk
 * costs an entry that silently never existed — she would have no way to know,
 * because the thing missing from the grid is the thing she can't see. So the
 * heaviest coverage here is on segmentation and on the promise that every line
 * of a document ends up somewhere.
 *
 * Fixtures are inlined rather than read from `docs/samples/`: this file is
 * compiled by the renderer's tsconfig as well as the node one, so it cannot
 * import `node:fs`. The real sample is exercised by the eval harness in
 * `scripts/llm-eval/`, which is where drift between the two would surface.
 */

import { describe, expect, it } from "vitest";
import { parseImport } from "./parse.ts";
import { DEFAULT_MINUTES } from "./types.ts";

/** `docs/samples/sample-student-doc.txt`, verbatim as of 2026-07-31. */
const SAMPLE = `9/25/2025 @ 11:45-12:00 Requested Session
Student emailed and required a session to discuss writing a letter to their biological father. Student used session to discuss ongoing concerns and strong emotions around the lack of contact they have. Student and this writer will meet next week to discuss more.

9/29/2025 @ 10:55-11:20 Requested Session
Student requested a follow up session after discussing previous week.

10/6/2025 @ 10:55-11:20 Routine Session
Student used their session to create a rough draft of the letter to their dad.

10/20/2025 @ 9:15AM
This writer was contacted by admissions counselor regarding this student.

This writer and AC recommended that the Dad call UCS.

AC and this writer followed up with DCF.

10/30/2025 @ 10:20 Email to Parent

Wrote the following email to parent:

Hi X,

Thank you for chatting with me today. I've listed the contact information we discussed below:

Individual Therapists:

Therapist 1
555-555-5555

Therapist 2
555-555-5555`;

describe("the real sample document", () => {
  const parsed = parseImport(SAMPLE);

  it("finds every entry and invents none", () => {
    expect(parsed.entries).toHaveLength(5);
  });

  it("reads the dates", () => {
    expect(parsed.entries.map((e) => e.date)).toEqual([
      "2025-09-25",
      "2025-09-29",
      "2025-10-06",
      "2025-10-20",
      "2025-10-30",
    ]);
  });

  it("resolves a range that crosses noon without being told it does", () => {
    // 11:45-12:00 is a quarter hour, not eleven and a half.
    expect(parsed.entries[0]!.startTime).toBe("11:45");
    expect(parsed.entries[0]!.minutes).toBe(15);
    expect(parsed.entries[0]!.flags).not.toContain("assumed-duration");
  });

  it("reads ordinary morning ranges", () => {
    expect(parsed.entries[1]!.minutes).toBe(25);
    expect(parsed.entries[2]!.minutes).toBe(25);
  });

  it("defaults a single time to fifteen minutes and says that it did", () => {
    const single = parsed.entries[3]!;
    expect(single.startTime).toBe("09:15");
    expect(single.minutes).toBe(DEFAULT_MINUTES);
    expect(single.flags).toContain("assumed-duration");
  });

  it("flags the one entry with no type phrase — the model's actual job", () => {
    expect(parsed.entries[3]!.typePhrase).toBeNull();
    expect(parsed.entries[3]!.flags).toContain("no-type-phrase");
    // And only that one. The rest are a lookup, not an inference.
    const untyped = parsed.entries.filter((e) => e.typePhrase === null);
    expect(untyped).toHaveLength(1);
  });

  it("keeps the type phrases exactly as she wrote them", () => {
    expect(parsed.entries.map((e) => e.typePhrase)).toEqual([
      "Requested Session",
      "Requested Session",
      "Routine Session",
      null,
      "Email to Parent",
    ]);
  });

  it("harvests four decisions from five entries", () => {
    expect(parsed.phrases).toEqual([
      { phrase: "Requested Session", key: "requested session", count: 2 },
      { phrase: "Routine Session", key: "routine session", count: 1 },
      { phrase: "Email to Parent", key: "email to parent", count: 1 },
    ]);
  });

  it("carries a whole embedded email into one note rather than shredding it", () => {
    // Six paragraphs, blank lines and all. This is the case that breaks the
    // moment anything starts treating a blank line as an entry boundary.
    const email = parsed.entries[4]!.note;
    expect(email.match(/<p>/g)).toHaveLength(6);
    expect(email).toContain("Wrote the following email to parent:");
    expect(email).toContain("Therapist 2<br>555-555-5555");
  });

  it("keeps the multi-paragraph note under the untyped header", () => {
    expect(parsed.entries[3]!.note.match(/<p>/g)).toHaveLength(3);
    expect(parsed.entries[3]!.note).toContain("followed up with DCF.");
  });

  it("leaves no preamble, because the document opens on a header", () => {
    expect(parsed.preamble).toBe("");
  });

  it("loses not one line of the source", () => {
    const covered = parsed.entries.flatMap((e) =>
      SAMPLE.split("\n").slice(e.chunk.startLine, e.chunk.endLine + 1),
    );
    expect(covered.join("\n")).toBe(SAMPLE);
  });
});

describe("segmentation", () => {
  it("never splits on a date inside a note when the header form is used", () => {
    const doc = [
      "9/25/2025 @ 11:45-12:00 Routine Session",
      "We agreed to meet again.",
      "10/2/2025 is the date she suggested, and 3/4 of the group agreed.",
      "Nothing else came up.",
    ].join("\n");
    const parsed = parseImport(doc);
    // The interior date opens a line, but it is followed by prose — the weak
    // fallback is fenced precisely so this stays one entry.
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.note).toContain("is the date she suggested");
  });

  it("accepts a date at line start when a label follows, and marks it weak", () => {
    const parsed = parseImport("11/4/2025 Routine Session\nShe came in upset.");
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.flags).toContain("weak-header");
    expect(parsed.entries[0]!.flags).toContain("no-time");
    expect(parsed.entries[0]!.typePhrase).toBe("Routine Session");
  });

  it("accepts a date and time with the @ left out", () => {
    const parsed = parseImport("11/4/2025 9:00-9:30 Routine Session");
    expect(parsed.entries[0]!.minutes).toBe(30);
    expect(parsed.entries[0]!.flags).toContain("weak-header");
  });

  it("keeps text above the first header instead of eating it", () => {
    const parsed = parseImport("Jordan R.\nCounseling log 2025-26\n\n9/25/2025 @ 10:00 Check-in");
    expect(parsed.preamble).toBe("Jordan R.\nCounseling log 2025-26");
    expect(parsed.entries).toHaveLength(1);
  });

  it("hands back the whole document when it recognises nothing", () => {
    const doc = "Some notes I typed with no dates at all.\n\nAnother thought.";
    const parsed = parseImport(doc);
    expect(parsed.entries).toEqual([]);
    expect(parsed.preamble).toBe(doc);
  });

  it("does not read a bare number as a time", () => {
    // Without the guard, `3` becomes three o'clock and swallows the phrase.
    const parsed = parseImport("10/20/2025 3 Ways to Cope");
    expect(parsed.entries[0]!.typePhrase).toBe("3 Ways to Cope");
    expect(parsed.entries[0]!.startTime).toBeNull();
  });

  it("refuses dates that are not dates", () => {
    expect(parseImport("13/45/2025 Session").entries).toEqual([]);
    expect(parseImport("2/30/2025 Session").entries).toEqual([]);
  });
});

describe("manual boundaries", () => {
  const doc = [
    "9/25/2025 @ 10:00 Routine Session", // line 0
    "She came in upset.", // line 1
    "10/2/2025 is a date she mentioned, capitalised oddly.", // line 2
    "Follow-up needed.", // line 3
  ].join("\n");

  it("merges an entry into the one above when a boundary is suppressed", () => {
    // Over-splitting is fixed by taking a boundary away. The false header's
    // line has to survive as note text — it was always prose.
    const split = parseImport("9/25/2025 @ 10:00 A\nnote\n10/2/2025 Wrongly Split\nmore");
    expect(split.entries).toHaveLength(2);

    const merged = parseImport("9/25/2025 @ 10:00 A\nnote\n10/2/2025 Wrongly Split\nmore", {
      suppressedBoundaries: [2],
    });
    expect(merged.entries).toHaveLength(1);
    expect(merged.entries[0]!.note).toContain("10/2/2025 Wrongly Split");
    expect(merged.entries[0]!.note).toContain("more");
  });

  it("splits at a line that looks like nothing, without eating it", () => {
    // Under-splitting is the dangerous direction — an entry that silently never
    // existed. Forcing a boundary on ordinary prose has to keep that prose.
    // The document splits into one entry on its own: line 2 opens with a date
    // but continues in lowercase prose, which the weak guard correctly refuses.
    expect(parseImport(doc).entries).toHaveLength(1);

    const forced = parseImport(doc, { forcedBoundaries: [3] });
    expect(forced.entries).toHaveLength(2);
    expect(forced.entries[1]!.note).toBe("<p>Follow-up needed.</p>");
    expect(forced.entries[1]!.date).toBeNull();
    // Nothing was read off that line, so every field is up for review.
    expect(forced.entries[1]!.flags).toContain("weak-header");
    expect(forced.entries[1]!.flags).toContain("no-type-phrase");
  });

  it("still loses no line when boundaries are moved by hand", () => {
    const forced = parseImport(doc, { forcedBoundaries: [1, 3], suppressedBoundaries: [2] });
    const covered = forced.entries.flatMap((e) =>
      doc.split("\n").slice(e.chunk.startLine, e.chunk.endLine + 1),
    );
    expect(covered.join("\n")).toBe(doc);
  });
});

describe("clock readings", () => {
  const minutesOf = (header: string) => parseImport(header).entries[0]!;

  it.each([
    ["9/25/2025 @ 11:45-12:00", "11:45", 15],
    ["9/25/2025 @ 12:45-1:15", "12:45", 30],
    ["9/25/2025 @ 9:15am-10:00am", "09:15", 45],
    ["9/25/2025 @ 9:15 AM - 9:45 AM", "09:15", 30],
    ["9/25/2025 @ 1:00-1:30", "13:00", 30],
    ["9/25/2025 @ 8:00-8:30", "08:00", 30],
    ["9/25/2025 @ 11:00 to 11:45", "11:00", 45],
    ["9/25/2025 @ 2:15p.m.-3:00p.m.", "14:15", 45],
  ])("reads %s as %s for %i minutes", (header, start, minutes) => {
    const entry = minutesOf(header);
    expect(entry.startTime).toBe(start);
    expect(entry.minutes).toBe(minutes);
  });

  it("puts an afternoon hour after noon when nobody said so", () => {
    // 1:15 is quarter past one, not quarter past one in the morning — the
    // school-day clock is the whole reason a header can omit the meridiem.
    expect(minutesOf("9/25/2025 @ 1:15 Parent call").startTime).toBe("13:15");
  });

  it("honours an explicit meridiem over the school-day assumption", () => {
    expect(minutesOf("9/25/2025 @ 8:00am-8:30am").startTime).toBe("08:00");
    expect(minutesOf("9/25/2025 @ 12:00pm-12:30pm").startTime).toBe("12:00");
  });

  it("falls back to the default when a range runs backwards", () => {
    const entry = minutesOf("9/25/2025 @ 10:00am-9:00am Session");
    expect(entry.minutes).toBe(DEFAULT_MINUTES);
    expect(entry.flags).toContain("implausible-range");
    expect(entry.flags).toContain("assumed-duration");
  });

  it("refuses a range long enough to be a misreading", () => {
    const entry = minutesOf("9/25/2025 @ 9:00am-11:00pm Session");
    expect(entry.minutes).toBe(DEFAULT_MINUTES);
    expect(entry.flags).toContain("implausible-range");
  });
});

describe("notes", () => {
  it("escapes markup rather than letting it through", () => {
    const parsed = parseImport("9/25/2025 @ 10:00 Note\nShe said <b>no</b> & left.");
    expect(parsed.entries[0]!.note).toBe("<p>She said &lt;b&gt;no&lt;/b&gt; &amp; left.</p>");
  });

  it("keeps single newlines as breaks and blank lines as paragraphs", () => {
    const parsed = parseImport("9/25/2025 @ 10:00 Note\nLine one\nLine two\n\nNew para");
    expect(parsed.entries[0]!.note).toBe("<p>Line one<br>Line two</p><p>New para</p>");
  });

  it("is empty when a header carries no body", () => {
    expect(parseImport("9/25/2025 @ 10:00 No-show").entries[0]!.note).toBe("");
  });
});

describe("yearless dates", () => {
  it("places autumn months in the year the school year opened", () => {
    const parsed = parseImport("9/25 @ 10:00 Session", {
      schoolYearStartMonth: 8,
      referenceDate: "2026-03-01",
    });
    expect(parsed.entries[0]!.date).toBe("2025-09-25");
  });

  it("places spring months in the following calendar year", () => {
    const parsed = parseImport("2/10 @ 10:00 Session", {
      schoolYearStartMonth: 8,
      referenceDate: "2025-10-01",
    });
    expect(parsed.entries[0]!.date).toBe("2026-02-10");
  });
});

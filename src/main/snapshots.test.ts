/**
 * Retention, checked against the failures it exists to survive.
 *
 * The interesting tests here are not "does it keep sixty dailies" but the two
 * shapes the plan was written around: a corruption noticed months later, where
 * every recent copy already contains the damage and only a monthly is still
 * clean; and a busy morning, where the daily is hours stale and the intervals
 * are the difference between losing minutes and losing the day.
 */

import { describe, expect, it } from "vitest";
import { classify, dailyName, newestFirst, snapshotsToPrune, type Snapshot } from "./snapshots.ts";

/** The day the tests are anchored to; nothing here reads the real clock. */
const NOW = new Date("2026-07-31T14:30:00");

function daily(date: string, encrypted = false): string {
  return `data-${date}.json${encrypted ? ".enc" : ""}`;
}

function interval(date: string, time: string): string {
  return `data-${date}-${time}.json`;
}

/** `count` consecutive dailies ending on `lastDate`, oldest first. */
function dailyRun(lastDate: string, count: number): string[] {
  const names: string[] = [];
  const cursor = new Date(`${lastDate}T12:00:00`);
  for (let i = 0; i < count; i += 1) {
    names.push(dailyName(cursor));
    cursor.setDate(cursor.getDate() - 1);
  }
  return names.toReversed();
}

describe("reading a filename", () => {
  it("recognises the four kinds", () => {
    expect(classify("data-2026-07-31.json")).toMatchObject({ kind: "daily", date: "2026-07-31" });
    expect(classify("data-2026-07-31-1430.json")).toMatchObject({
      kind: "interval",
      date: "2026-07-31",
      time: "1430",
    });
    expect(classify("data-pre-v2-2026-07-27.json")).toMatchObject({ kind: "preserved" });
    expect(classify("data-corrupt-2026-07-31-0912.json")).toMatchObject({ kind: "preserved" });
  });

  it("carries the encrypted flag without letting it change anything else", () => {
    // Both eras sit in backups/ together once encryption is switched on, and a
    // file's era has no bearing on how long it is kept.
    expect(classify("data-2026-07-31.json.enc")).toMatchObject({
      kind: "daily",
      date: "2026-07-31",
      encrypted: true,
    });
    expect(classify("data-2026-07-31.json")).toMatchObject({ encrypted: false });
  });

  it("refuses to account for anything it doesn't recognise", () => {
    // Which is what stops pruning from touching them. A `.bad` file has already
    // failed to parse and is kept out of the restore list; the rest is whatever
    // happened to be in the folder, and deleting a stranger's file is not this
    // code's business.
    for (const name of [
      "data-2026-07-31.json.bad",
      "data.json",
      "data.json.prev",
      "keyfile.json",
      "notes.txt",
      "data-2026-7-31.json",
      "data-2026-07-31-14300.json",
      ".DS_Store",
    ]) {
      expect(classify(name), name).toBeNull();
    }
  });
});

describe("ordering", () => {
  it("puts the newest first, and the daily above its own day's intervals", () => {
    const names = [
      interval("2026-07-30", "0915"),
      daily("2026-07-31"),
      interval("2026-07-31", "1430"),
      daily("2026-07-30"),
      interval("2026-07-31", "0900"),
    ];
    const ordered = newestFirst(names.map(classify).filter(Boolean) as Snapshot[]);

    // The daily leads its day because it is the first save of that day and so
    // the most conservative thing to restore from among that day's copies.
    expect(ordered.map((s) => s.name)).toEqual([
      daily("2026-07-31"),
      interval("2026-07-31", "1430"),
      interval("2026-07-31", "0900"),
      daily("2026-07-30"),
      interval("2026-07-30", "0915"),
    ]);
  });
});

describe("pruning", () => {
  it("has nothing to say about an empty folder", () => {
    expect(snapshotsToPrune([], NOW)).toEqual([]);
  });

  it("keeps sixty dailies, and the monthlies that outrank them", () => {
    // Seventy days ending today runs 2026-05-23 → 2026-07-31. The newest sixty
    // start at 2026-06-02, which leaves ten older ones — but two of those ten
    // are the first daily their month has, so they stay. That interaction is
    // the whole design: the sixty-day window is a floor, not a ceiling.
    const names = dailyRun("2026-07-31", 70);
    const pruned = snapshotsToPrune(names, NOW);

    expect(pruned).toEqual(names.slice(1, 9));
    expect(pruned).not.toContain(daily("2026-05-23")); // May's first
    expect(pruned).not.toContain(daily("2026-06-01")); // June's first
    expect(pruned).not.toContain(daily("2026-06-02")); // sixtieth-newest
    expect(pruned).not.toContain(daily("2026-07-31"));
  });

  it("keeps the first daily of every month for two years", () => {
    // The failure this is for: a bug wipes some entries in March, nobody
    // notices until July. Every daily still held is from the last sixty days
    // and has the damage in it. The March monthly does not.
    const names = [
      daily("2024-06-01"), // just over two years old
      daily("2024-08-01"),
      daily("2025-03-01"),
      daily("2025-03-02"),
      daily("2026-03-01"),
      daily("2026-03-14"),
      ...dailyRun("2026-07-31", 60),
    ];
    const pruned = snapshotsToPrune(names, NOW);

    expect(pruned).toContain(daily("2024-06-01"));
    expect(pruned).toContain(daily("2025-03-02"));
    expect(pruned).toContain(daily("2026-03-14"));

    expect(pruned).not.toContain(daily("2024-08-01"));
    expect(pruned).not.toContain(daily("2025-03-01"));
    expect(pruned).not.toContain(daily("2026-03-01"));
  });

  it("treats the earliest daily in a month as that month's keeper", () => {
    // The month's first *daily*, not the first of the month — the app isn't
    // opened every day, and a month whose first working day is the 4th still
    // needs a monthly.
    const names = [daily("2025-02-04"), daily("2025-02-05"), ...dailyRun("2026-07-31", 60)];
    const pruned = snapshotsToPrune(names, NOW);

    expect(pruned).toContain(daily("2025-02-05"));
    expect(pruned).not.toContain(daily("2025-02-04"));
  });

  it("keeps two days of intervals and drops the rest", () => {
    const names = [
      interval("2026-07-31", "1430"),
      interval("2026-07-31", "0900"),
      interval("2026-07-30", "1615"),
      interval("2026-07-29", "1100"),
      interval("2026-07-28", "1000"),
      interval("2026-06-01", "0800"),
    ];
    const pruned = snapshotsToPrune(names, NOW);

    expect(pruned).toEqual([interval("2026-07-28", "1000"), interval("2026-06-01", "0800")]);
  });

  it("never proposes deleting a preserved file", () => {
    // Each of these is the only copy of a state nothing can reconstruct: what
    // the data looked like before a schema migration, or the unreadable file a
    // restore replaced.
    const names = [
      "data-pre-v2-2020-01-01.json",
      "data-corrupt-2019-05-05-0900.json",
      ...dailyRun("2026-07-31", 70),
    ];
    const pruned = snapshotsToPrune(names, NOW);

    expect(pruned).not.toContain("data-pre-v2-2020-01-01.json");
    expect(pruned).not.toContain("data-corrupt-2019-05-05-0900.json");
    expect(pruned).toHaveLength(8);
  });

  it("never proposes deleting a file it doesn't recognise", () => {
    const names = [
      "data.json.prev",
      "keyfile.json",
      "data-2026-01-01.json.bad",
      "Screenshot.png",
      ...dailyRun("2026-07-31", 70),
    ];
    const pruned = snapshotsToPrune(names, NOW);

    expect(pruned).toHaveLength(8);
    for (const stranger of ["data.json.prev", "keyfile.json", "Screenshot.png"]) {
      expect(pruned).not.toContain(stranger);
    }
    expect(pruned).not.toContain("data-2026-01-01.json.bad");
  });

  it("counts encrypted and plaintext snapshots as one history", () => {
    // Switching encryption on mid-year must not double the retention or halve
    // it: a day is a day, whichever era wrote it.
    const names = [
      ...dailyRun("2026-05-31", 35).map((n) => `${n}.enc`),
      ...dailyRun("2026-07-31", 35),
    ];
    const pruned = snapshotsToPrune(names, NOW);

    expect(pruned).toHaveLength(70 - 60 - 2);
  });

  it("ranks dailies without letting intervals into the count", () => {
    // Interval names are longer than daily names and sort between them, so a
    // prune that ranked the mixed list lexicographically would push real
    // dailies out of the sixty and keep intervals instead. Each tier is counted
    // against its own rule.
    const dailies = dailyRun("2026-07-31", 70);
    const names = [...dailies, interval("2026-07-31", "0900"), interval("2026-05-30", "0800")];
    const pruned = snapshotsToPrune(names, NOW);

    expect(pruned).toEqual([...dailies.slice(1, 9), interval("2026-05-30", "0800")]);
    expect(pruned).not.toContain(interval("2026-07-31", "0900"));
  });
});

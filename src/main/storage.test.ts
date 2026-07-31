/**
 * The storage layer, pinned down before it is rewritten.
 *
 * Everything here is about one file holding a year of somebody's work, so the
 * failures worth catching are the quiet ones rather than the loud ones. A crash
 * announces itself; a document that loads as empty because the folder merely
 * went missing, a migration that runs without leaving a way back, a rotation
 * that prunes a file it did not write — those all look like the app working.
 * The assertions are therefore mostly about what is on disk afterwards, not
 * about what was returned.
 *
 * Nothing here asserts on the temp file an atomic write goes through. That name
 * belongs to writeFileAtomic and is free to change; what has to stay true is
 * the contents of the file it renames into place.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_VERSION, SEED_CATEGORIES } from "../shared/types.ts";
import { doc, entry, tempApp } from "../test/helpers.ts";
import {
  checkSnapshots,
  copyMissingBackups,
  listSnapshots,
  loadDoc,
  massDeletion,
  newestRestorable,
  preserveUnreadable,
  resetSnapshotState,
  saveDoc,
  setCodec,
  snapshotOnQuit,
} from "./storage.ts";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** A document in the shape version 1 had, where a note was plain text. */
function v1Doc(entries: unknown[]): unknown {
  return { ...doc({ students: 1, entries: 0 }), version: 1, entries };
}

/**
 * Pin the clock. Every backup is named after the day it was taken, and "once
 * per day" is the whole of the rotation policy, so a test that let the real
 * date through would be asserting on the morning it happened to run.
 */
function onDay(stamp: string): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${stamp}T12:00:00`));
}

/** Consecutive local dates as YYYY-MM-DD, for filling a backups folder. */
function datesFrom(start: string, count: number): string[] {
  const first = new Date(`${start}T12:00:00`);
  const pad = (n: number) => String(n).padStart(2, "0");
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
    return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
  });
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  // storage.ts remembers when it last took an interval snapshot and what it
  // last wrote, and this file imports it once for every test in it. Without
  // this, the second test in a run inherits the first one's idea of the time.
  resetSnapshotState();
  setCodec(null);
});

/** Every name in backups/, sorted, for asserting on a whole folder at once. */
function backupNames(app: { backupDir: string }): string[] {
  return existsSync(app.backupDir) ? readdirSync(app.backupDir).toSorted() : [];
}

describe("loadDoc", () => {
  it("returns an empty document and writes it, so a first run leaves a file behind", () => {
    const app = tempApp();

    const loaded = loadDoc();
    expect(loaded.version).toBe(DATA_VERSION);
    expect(loaded.rev).toBe(0);
    expect(loaded.students).toEqual([]);
    expect(loaded.entries).toEqual([]);
    expect(loaded.categories).toHaveLength(SEED_CATEGORIES.length);

    // The write matters more than the return value. The categories are seeded
    // with fresh UUIDs, so a run that returned them without saving would hand
    // the renderer ids that mean nothing to the next launch.
    expect(readJson(app.dataFile)).toEqual(loaded);
  });

  it("refuses to invent one when the folder it was told to use has gone", async () => {
    const app = tempApp({ packaged: true });
    rmSync(app.dataDir, { recursive: true });

    /**
     * config.ts memoizes what it read in a module-level variable that outlives
     * this test's temp folder. This is the only test in the file that reaches
     * it — dataDir() short-circuits before readConfig() in a development build,
     * and dataDirIsConfigured() does the same — so it takes a private copy of
     * the module graph and leaves the statically imported one with an empty
     * cache for everything after it.
     */
    vi.resetModules();
    const storage = await import("./storage.ts");

    // Naming the folder is the point of the message: "renamed it in Finder" and
    // "the external drive isn't mounted" are both fixable, but only by somebody
    // who can see which path the app went looking in.
    expect(() => storage.loadDoc()).toThrow(app.dataDir);
    expect(() => storage.loadDoc()).toThrow(/isn't there/);
    // And it must not quietly recreate the folder on the way past, which would
    // turn the next launch into a convincing new install.
    expect(existsSync(app.dataDir)).toBe(false);
  });

  it("throws on a data.json that isn't JSON at all", () => {
    const app = tempApp();
    writeFileSync(app.dataFile, '{"version": 2, "rev": 1, "entries": [');

    expect(() => loadDoc()).toThrow();
    // Nothing was salvaged and nothing was overwritten: a truncated file is
    // still the best copy of her work in this folder.
    expect(readFileSync(app.dataFile, "utf8")).toBe('{"version": 2, "rev": 1, "entries": [');
  });

  /**
   * Each of these parses as JSON and none of them is a Casebook document —
   * a settings file, a package.json, an export from something else. Rejecting
   * them here is worth it because the alternative is worse than a crash: the
   * object travels all the way to the renderer, the first `doc.students.length`
   * throws inside a component with no error boundary above it, and the window
   * goes white with nothing said about why.
   */
  const notCasebookFiles: [string, unknown][] = [
    ["has no entries array", { ...doc(), entries: undefined }],
    ["has null settings", { ...doc(), settings: null }],
    ["is a bare array", [doc()]],
    ["has a rev that is a string", { ...doc(), rev: "1" }],
  ];

  it.each(notCasebookFiles)("rejects a file that %s", (_shape, value) => {
    const app = tempApp();
    writeJson(app.dataFile, value);

    expect(() => loadDoc()).toThrow("it isn't a Casebook data file.");
  });
});

describe("the v1 migration", () => {
  it("rewrites plain-text notes as the HTML the editor now expects", () => {
    const app = tempApp();
    onDay("2026-03-14");
    writeJson(
      app.dataFile,
      v1Doc([
        entry({ id: "e-breaks", note: "First line\nSecond line" }),
        entry({ id: "e-paras", note: "Para one\n\n\nPara two" }),
        entry({ id: "e-escapes", note: "Ampersands & <angle> brackets" }),
      ]),
    );

    const loaded = loadDoc();
    const noteFor = (id: string) => loaded.entries.find((e) => e.id === id)?.note;

    expect(loaded.version).toBe(DATA_VERSION);
    expect(noteFor("e-breaks")).toBe("<p>First line<br>Second line</p>");
    // Two newlines or ten, it is one paragraph break — matching how the old
    // textarea rendered rather than how many times she hit return.
    expect(noteFor("e-paras")).toBe("<p>Para one</p><p>Para two</p>");
    // Escaping is unconditional because every v1 note came from a plain input
    // and so is text, even when it happens to look like markup.
    expect(noteFor("e-escapes")).toBe("<p>Ampersands &amp; &lt;angle&gt; brackets</p>");
  });

  it("drops the note key entirely when there was nothing worth keeping in it", () => {
    const app = tempApp();
    onDay("2026-03-14");
    writeJson(
      app.dataFile,
      v1Doc([
        entry({ id: "e-empty", note: "" }),
        entry({ id: "e-blank", note: "  \n  " }),
        { ...entry({ id: "e-wrong-type" }), note: 42 },
        entry({ id: "e-absent" }),
      ]),
    );

    for (const e of loadDoc().entries) {
      // Not `note: ""` and not `note: undefined` — the key is gone, which is
      // what keeps "has a note" a single check everywhere downstream.
      expect(Object.hasOwn(e, "note")).toBe(false);
    }
  });

  it("writes the migrated document back, and keeps the file it replaced", () => {
    const app = tempApp();
    onDay("2026-03-14");
    const original = v1Doc([entry({ id: "e-1", note: "Before the migration" })]);
    writeJson(app.dataFile, original);

    const loaded = loadDoc();

    // The migration has to stick. Left unwritten it would run again on every
    // launch, re-escaping the HTML it produced the time before.
    expect(readJson(app.dataFile)).toEqual(loaded);

    // A snapshot of its own, outside the tiers: those are keyed to the day and
    // the quarter-hour and either could already exist, which on any day the app
    // had already been opened would leave the migration with no way back.
    const preserved = backupNames(app).filter((name) =>
      name.startsWith(`data-pre-v${DATA_VERSION}-`),
    );
    expect(preserved).toHaveLength(1);
    expect(readJson(join(app.backupDir, preserved[0]!))).toEqual(original);
  });

  it("keeps both snapshots when a second v1 file turns up the same day", () => {
    const app = tempApp();
    onDay("2026-03-14");

    writeJson(app.dataFile, v1Doc([entry({ note: "the file that was here first" })]));
    loadDoc();

    // Restoring a pre-v2 backup by hand puts the app in front of a second v1
    // file on a day it has already migrated one. Each is the only copy of a
    // state nothing can reconstruct, so the second must not land on the first's
    // name — which is what the old "write only if the name is free" did, by
    // silently writing nothing at all.
    writeJson(app.dataFile, v1Doc([entry({ note: "a restored backup" })]));
    loadDoc();

    const preserved = backupNames(app).filter((name) => name.startsWith("data-pre-v"));
    expect(preserved).toHaveLength(2);
    const contents = preserved.map((name) => JSON.stringify(readJson(join(app.backupDir, name))));
    expect(new Set(contents).size).toBe(2);
  });

  it("leaves a document already at the current version exactly as it is", () => {
    const app = tempApp();
    const current = doc({ students: 2, entries: 3 });
    writeJson(app.dataFile, current);

    expect(loadDoc()).toEqual(current);
    // Nothing migrated, so nothing was snapshotted — an ordinary launch does
    // not accumulate a backups folder just by opening the file.
    expect(existsSync(app.backupDir)).toBe(false);
  });

  it("refuses a version it has never heard of rather than guessing", () => {
    const app = tempApp();
    writeJson(app.dataFile, { ...doc(), version: 99 });

    // A document from a newer build, opened by an older one. Reading it with
    // today's assumptions and then saving over it is how the newer fields get
    // dropped on the floor.
    expect(() => loadDoc()).toThrow("Unsupported data version: 99");
  });
});

describe("saveDoc", () => {
  it("creates the data folder on demand and round-trips through loadDoc", () => {
    const app = tempApp();
    rmSync(app.dataDir, { recursive: true });
    const written = doc({ students: 3, entries: 7 });

    saveDoc(written);

    // The folder is made by the first save rather than at startup, so this is
    // the path every brand-new install takes.
    expect(existsSync(app.dataFile)).toBe(true);
    expect(loadDoc()).toEqual(written);
  });
});

describe("the snapshot tiers", () => {
  it("writes the day's snapshot on the first save, and leaves it alone after", () => {
    const app = tempApp();
    onDay("2026-03-14");

    const morning = doc({ students: 1, entries: 1 });
    saveDoc(morning);
    expect(backupNames(app)).toEqual(["data-2026-03-14.json"]);

    // Later saves the same day do not touch it. The daily is what the file
    // looked like at the start of the day; refreshing it on every save would
    // reduce it to a copy of the file it exists to be a way back from.
    vi.setSystemTime(new Date("2026-03-14T12:05:00"));
    saveDoc(doc({ students: 4, entries: 9 }));
    expect(readJson(join(app.backupDir, "data-2026-03-14.json"))).toEqual(morning);
  });

  it("starts a new one when the day rolls over", () => {
    const app = tempApp();
    onDay("2026-03-14");
    saveDoc(doc({ students: 1, entries: 1 }));

    onDay("2026-03-15");
    const today = doc({ students: 2, entries: 6 });
    saveDoc(today);

    expect(backupNames(app)).toEqual(["data-2026-03-14.json", "data-2026-03-15.json"]);
    expect(readJson(join(app.backupDir, "data-2026-03-15.json"))).toEqual(today);
  });

  it("keeps the outgoing version beside the live file", () => {
    const app = tempApp();
    onDay("2026-03-14");
    const before = doc({ students: 2, entries: 4 });
    const after = doc({ students: 2, entries: 5 });

    saveDoc(before);
    saveDoc(after, before);

    // The cheapest guard in the whole scheme, and the one that covers the most
    // common disaster: a save that lands and shouldn't have. Everything else is
    // measured in quarter-hours; this is measured in one save.
    expect(readJson(`${app.dataFile}.prev`)).toEqual(before);
    expect(readJson(app.dataFile)).toEqual(after);
  });

  it("takes an interval snapshot once a quarter of an hour of editing has passed", () => {
    const app = tempApp();
    onDay("2026-03-14");
    saveDoc(doc({ entries: 1 }));

    // Five minutes in: the daily already speaks for this moment.
    vi.setSystemTime(new Date("2026-03-14T12:05:00"));
    saveDoc(doc({ entries: 2 }));
    expect(backupNames(app)).toEqual(["data-2026-03-14.json"]);

    vi.setSystemTime(new Date("2026-03-14T12:20:00"));
    const afternoon = doc({ entries: 3 });
    saveDoc(afternoon);

    expect(backupNames(app)).toEqual(["data-2026-03-14-1220.json", "data-2026-03-14.json"]);
    expect(readJson(join(app.backupDir, "data-2026-03-14-1220.json"))).toEqual(afternoon);
  });

  it("doesn't write an interval snapshot beside the daily it would duplicate", () => {
    const app = tempApp();
    onDay("2026-03-14");
    saveDoc(doc());

    // Both would hold byte-identical contents. Two files saying one thing is
    // just noise in a folder someone has to read at 7:45 in the morning.
    expect(backupNames(app)).toEqual(["data-2026-03-14.json"]);
  });

  it("forces a last snapshot on the way out", () => {
    const app = tempApp();
    onDay("2026-03-14");
    saveDoc(doc({ entries: 1 }));

    vi.setSystemTime(new Date("2026-03-14T12:10:00"));
    const lastThing = doc({ entries: 7 });
    saveDoc(lastThing);

    // Quitting at ten past would otherwise cost the ten minutes since the last
    // snapshot, and quitting is exactly when the app stops being able to take
    // one later.
    snapshotOnQuit();
    expect(backupNames(app)).toContain("data-2026-03-14-1210.json");
    expect(readJson(join(app.backupDir, "data-2026-03-14-1210.json"))).toEqual(lastThing);
  });

  it("takes no parting snapshot when nothing was saved since the last one", () => {
    const app = tempApp();
    onDay("2026-03-14");
    saveDoc(doc());
    const before = backupNames(app);

    snapshotOnQuit();
    snapshotOnQuit();

    expect(backupNames(app)).toEqual(before);
  });

  it("prunes to the retention rules, and only ever its own files", () => {
    const app = tempApp();
    const days = datesFrom("2025-12-02", 70);
    onDay("2026-03-15");
    mkdirSync(app.backupDir, { recursive: true });
    for (const day of days) {
      writeFileSync(join(app.backupDir, `data-${day}.json`), JSON.stringify(doc()));
    }
    // Neither of these is part of any rotation and neither may be removed. The
    // migration snapshot in particular is the only copy of a pre-v2 document
    // anywhere, so losing it to a rotation it was never in would be permanent.
    writeFileSync(join(app.backupDir, "data-pre-v2-2026-01-09.json"), "{}");
    writeFileSync(join(app.backupDir, "notes-from-the-old-app.txt"), "");

    saveDoc(doc());

    const left = backupNames(app);
    expect(left).toContain("data-pre-v2-2026-01-09.json");
    expect(left).toContain("notes-from-the-old-app.txt");
    // Sixty dailies plus today's, and the first-of-month copies that outrank
    // the sixty-day window.
    expect(left).toContain("data-2026-03-15.json");
    expect(left).toContain("data-2025-12-02.json");
    expect(left).toContain("data-2026-01-01.json");
    expect(left).not.toContain("data-2025-12-03.json");
  });

  it("refuses to prune when the snapshot it just wrote won't read back", () => {
    const app = tempApp();
    const days = datesFrom("2025-12-02", 70);
    onDay("2026-03-15");
    mkdirSync(app.backupDir, { recursive: true });
    for (const day of days) {
      writeFileSync(join(app.backupDir, `data-${day}.json`), JSON.stringify(doc()));
    }

    // A codec that writes something unreadable stands in for whatever would
    // really cause this — a failing disk, a bug in a future encoder. The point
    // is the consequence: a run of bad snapshots must not age out the good
    // copies behind them, one day at a time, until nothing readable is left.
    setCodec({
      suffix: "",
      encode: () => Buffer.from("this is not a document"),
      decode: (blob) => blob.toString("utf8"),
    });
    saveDoc(doc());

    expect(backupNames(app)).toContain("data-2025-12-03.json");
    expect(backupNames(app).filter((n) => n.startsWith("data-2025-12"))).toHaveLength(30);
  });
});

describe("the deletion tripwire", () => {
  it("lets ordinary edits through", () => {
    const before = doc({ students: 20, entries: 200 });
    // Adding, editing, and deleting one at a time — which is all the app can do.
    expect(massDeletion(before, before)).toBeNull();
    expect(massDeletion(before, { ...before, entries: before.entries.slice(0, 199) })).toBeNull();
    expect(massDeletion(before, { ...before, entries: [...before.entries, entry()] })).toBeNull();
    expect(massDeletion(before, { ...before, students: before.students.slice(0, 19) })).toBeNull();
  });

  it("catches a document that lost most of itself", () => {
    const before = doc({ students: 20, entries: 200 });
    const after = { ...before, entries: before.entries.slice(0, 20) };

    expect(massDeletion(before, after)).toEqual({ students: 0, entries: 180 });
  });

  it("stays quiet on a small caseload, where a fifth is a couple of entries", () => {
    // The instruction was that this must never fire on real work. Someone with
    // eight entries deleting three of them is having an ordinary morning, and a
    // guard that cried wolf there would be clicked through by the time it
    // mattered.
    const before = doc({ students: 2, entries: 8 });
    expect(massDeletion(before, { ...before, entries: [] })).toBeNull();
  });

  it("notices a roster wipe even when the entries survive", () => {
    const before = doc({ students: 40, entries: 100 });
    const after = { ...before, students: before.students.slice(0, 5) };

    expect(massDeletion(before, after)).toEqual({ students: 35, entries: 0 });
  });
});

describe("finding something to restore", () => {
  it("offers the newest snapshot that actually reads", () => {
    const app = tempApp();
    onDay("2026-03-14");
    const good = doc({ students: 3, entries: 12 });
    saveDoc(good);

    // Newer than the good one, and unreadable. Giving up at the first failure
    // would mean a folder with one damaged recent snapshot reports nothing to
    // restore at all.
    writeFileSync(join(app.backupDir, "data-2026-03-14-1300.json"), "{ truncated");

    const found = newestRestorable();
    expect(found?.summary.name).toBe("data-2026-03-14.json");
    expect(found?.summary).toMatchObject({ students: 3, entries: 12, readable: true });
    expect(found?.doc).toEqual(good);
  });

  it("finds nothing when there is nothing", () => {
    tempApp();
    expect(newestRestorable()).toBeNull();
  });

  it("moves an unreadable live file aside instead of over", () => {
    const app = tempApp();
    onDay("2026-03-14");
    writeFileSync(app.dataFile, "{ this file is ruined");

    const preserved = preserveUnreadable();

    // However broken it is, it is still the most recent copy of her work that
    // exists, and the odds of getting something out of it by hand are not zero
    // — which is what they become the moment it is overwritten.
    expect(preserved).not.toBeNull();
    expect(existsSync(app.dataFile)).toBe(false);
    expect(readFileSync(preserved!, "utf8")).toBe("{ this file is ruined");
    expect(backupNames(app)[0]).toMatch(/^data-corrupt-2026-03-14-\d{4}\.json$/);
  });
});

describe("checking the backups", () => {
  it("renames what it cannot read, so the recovery scan skips it next time", () => {
    const app = tempApp();
    onDay("2026-03-14");
    saveDoc(doc());
    writeFileSync(join(app.backupDir, "data-2026-03-13.json"), "{ truncated");

    const report = checkSnapshots();

    expect(report.checked).toBe(2);
    expect(report.unreadable).toEqual(["data-2026-03-13.json"]);
    expect(backupNames(app)).toContain("data-2026-03-13.json.bad");
    // A `.bad` file is no longer a snapshot as far as anything else is
    // concerned: not offered for restore, and never pruned either.
    expect(listSnapshots().map((s) => s.name)).toEqual(["data-2026-03-14.json"]);
  });

  it("says what each snapshot holds, so there is something to choose between", () => {
    const app = tempApp();
    onDay("2026-03-14");
    saveDoc(doc({ students: 5, entries: 40 }));
    vi.setSystemTime(new Date("2026-03-14T12:30:00"));
    saveDoc(doc({ students: 6, entries: 41 }));

    const listed = listSnapshots();
    expect(listed.map((s) => s.name)).toEqual([
      "data-2026-03-14.json",
      "data-2026-03-14-1230.json",
    ]);
    expect(listed[1]).toMatchObject({ students: 6, entries: 41, readable: true, encrypted: false });
    expect(existsSync(app.backupDir)).toBe(true);
  });
});

describe("copyMissingBackups", () => {
  it("copies the json files and reports exactly the names it wrote", () => {
    const app = tempApp();
    const from = join(app.root, "source-backups");
    const to = join(app.root, "target-backups");
    mkdirSync(from, { recursive: true });
    writeFileSync(join(from, "data-2026-01-01.json"), '{"day":1}');
    writeFileSync(join(from, "data-2026-01-02.json"), '{"day":2}');
    // Finder leaves these around in any folder somebody has opened, and they
    // are not backups.
    writeFileSync(join(from, ".DS_Store"), "");
    writeFileSync(join(from, "notes.txt"), "");

    expect(copyMissingBackups(from, to).toSorted()).toEqual([
      "data-2026-01-01.json",
      "data-2026-01-02.json",
    ]);
    expect(readdirSync(to).toSorted()).toEqual(["data-2026-01-01.json", "data-2026-01-02.json"]);
    expect(readFileSync(join(to, "data-2026-01-01.json"), "utf8")).toBe('{"day":1}');
  });

  it("leaves a name the destination already has exactly as it found it", () => {
    const app = tempApp();
    const from = join(app.root, "source-backups");
    const to = join(app.root, "target-backups");
    mkdirSync(from, { recursive: true });
    mkdirSync(to, { recursive: true });
    writeFileSync(join(from, "data-2026-01-01.json"), '{"from":"source"}');
    writeFileSync(join(from, "data-2026-01-02.json"), '{"from":"source"}');
    writeFileSync(join(to, "data-2026-01-01.json"), '{"from":"destination"}');

    // Two installs can each hold a data-2026-01-01.json and they are not the
    // same file. Skipping it is not enough either — the name has to stay out of
    // the return value, because a caller undoing a failed copy deletes what it
    // was handed, and that would take a backup it never wrote.
    expect(copyMissingBackups(from, to)).toEqual(["data-2026-01-02.json"]);
    expect(readFileSync(join(to, "data-2026-01-01.json"), "utf8")).toBe('{"from":"destination"}');
  });

  it("does nothing when the source folder isn't there", () => {
    const app = tempApp();
    const to = join(app.root, "target-backups");

    expect(copyMissingBackups(join(app.root, "never-existed"), to)).toEqual([]);
    // An install that has never been backed up is ordinary, not an error, and
    // it should not leave an empty backups folder in its wake.
    expect(existsSync(to)).toBe(false);
  });

  it("does not create the destination for a source holding nothing to copy", () => {
    const app = tempApp();
    const from = join(app.root, "source-backups");
    const to = join(app.root, "target-backups");
    mkdirSync(from, { recursive: true });
    writeFileSync(join(from, "notes.txt"), "");

    expect(copyMissingBackups(from, to)).toEqual([]);
    expect(existsSync(to)).toBe(false);
  });
});

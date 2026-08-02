/**
 * Bringing the previous Casebook's data across, with the passphrase in the
 * picture.
 *
 * Finding the old install is not what is tested here — that is a LaunchAgent, a
 * plist and an executable somewhere under ~/Applications, none of which a test
 * should be conjuring on the machine it runs on. What is tested is the part
 * that writes: an import is the one operation that replaces the whole live
 * document in a single move, and it does it from a file it has not parsed, into
 * a folder whose era it does not get to choose.
 *
 * The bug this file exists for reported success and did nothing. With the
 * passphrase on, the import wrote `data.json` while `data.json.enc` went on
 * winning every read — so the panel said "imported 9 entries", the app stayed
 * empty, and a complete plaintext copy of her records sat in the folder she had
 * put a passphrase on precisely so that could not happen.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataDoc } from "../shared/types.ts";
import { doc, tempApp, type TempApp } from "../test/helpers.ts";
import { enable, lock } from "./encryption.ts";
import { importInstall } from "./legacy.ts";
import { loadDoc, resetSnapshotState, saveDoc, setCodec } from "./storage.ts";

const PASSPHRASE = "the one she actually uses";

let app: TempApp;

beforeEach(() => {
  app = tempApp();
  resetSnapshotState();
  setCodec(null);
  vi.useFakeTimers();
  // Pinned because the snapshot the import takes is named after the day.
  vi.setSystemTime(new Date("2026-07-31T09:00:00"));
});

afterEach(() => {
  // encryption.ts holds the data key in a module-level variable that outlives a
  // test in this file, and storage.ts holds the codec that goes with it.
  lock();
  vi.useRealTimers();
});

/** The old install: a folder with a data.json in it and a backups/ behind it. */
function oldInstall(contents: DataDoc): string {
  const dir = join(app.root, "old-casebook");
  mkdirSync(join(dir, "backups"), { recursive: true });
  writeFileSync(join(dir, "data.json"), JSON.stringify(contents, null, 2));
  writeFileSync(join(dir, "backups", "data-2026-03-14.json"), JSON.stringify(contents, null, 2));
  return dir;
}

function names(): string[] {
  return existsSync(app.backupDir) ? readdirSync(app.backupDir).toSorted() : [];
}

describe("importInstall with the passphrase on", () => {
  it("writes the document where the app will actually read it back", async () => {
    saveDoc(doc({ students: 1, entries: 2 }));
    await enable(PASSPHRASE);
    const theirs = doc({ students: 4, entries: 9 });
    const dir = oldInstall(theirs);

    expect(importInstall(dir)).toEqual({ ok: true, entries: 9, students: 4 });

    // The whole of the bug, in one assertion: the import used to report these
    // counts while `data.json.enc` went on winning every read, so the app was
    // still showing the two entries it had before.
    expect(loadDoc()).toEqual(theirs);

    expect(existsSync(`${app.dataFile}.enc`)).toBe(true);
    // And no plaintext twin of her records left in the folder — not the live
    // file, and not the old install's snapshots carried across beside it.
    expect(existsSync(app.dataFile)).toBe(false);
    expect(readFileSync(`${app.dataFile}.enc`).toString("latin1")).not.toContain("Student 1");
    expect(names().every((name) => name.endsWith(".json.enc"))).toBe(true);
    expect(names()).toContain("data-2026-03-14.json.enc");
  });

  it("keeps the file it replaced, named for the era that file is in", async () => {
    saveDoc(doc({ students: 3, entries: 6 }));
    await enable(PASSPHRASE);
    const replaced = readFileSync(`${app.dataFile}.enc`);
    const dir = oldInstall(doc({ students: 4, entries: 9 }));

    expect(importInstall(dir)).toMatchObject({ ok: true });

    // "Nothing here is worth keeping" is a judgement somebody made in a dialog,
    // and the snapshot costs a few kilobytes. It went missing entirely when the
    // folder was encrypted, because the old code looked for `data.json` — the
    // one name that is never there once the passphrase is on.
    const preserved = names().filter((name) => name.startsWith("data-pre-import-"));
    expect(preserved).toEqual(["data-pre-import-2026-07-31.json.enc"]);
    // A byte copy of what was live, so the suffix is not decoration: an
    // encrypted file under a plain name is a snapshot the restore panel will
    // offer and then fail to open.
    expect(readFileSync(join(app.backupDir, preserved[0]!))).toEqual(replaced);
  });

  it("refuses while locked instead of importing into a folder it can't write", async () => {
    saveDoc(doc({ students: 3, entries: 6 }));
    await enable(PASSPHRASE);
    const live = readFileSync(`${app.dataFile}.enc`);
    const before = names();
    lock();
    const dir = oldInstall(doc({ students: 4, entries: 9 }));

    // Locked means there is no codec, so every write on this path would land in
    // the wrong era: a plaintext live file the app would never read, and the old
    // install's snapshots byte-copied in readable beside it.
    expect(importInstall(dir)).toEqual({
      error: "Casebook is locked. Unlock it with your passphrase, then import.",
    });

    expect(existsSync(app.dataFile)).toBe(false);
    expect(readFileSync(`${app.dataFile}.enc`)).toEqual(live);
    expect(names()).toEqual(before);
  });
});

describe("importInstall without one", () => {
  it("still writes a plain data.json, and still keeps what it replaced", () => {
    const mine = doc({ students: 1, entries: 2 });
    saveDoc(mine);
    const theirs = doc({ students: 4, entries: 9 });
    const dir = oldInstall(theirs);

    expect(importInstall(dir)).toEqual({ ok: true, entries: 9, students: 4 });

    // The ordinary case, and the one every install that has never touched the
    // passphrase takes. Nothing about routing the write through the codec is
    // allowed to change it.
    expect(existsSync(`${app.dataFile}.enc`)).toBe(false);
    expect(JSON.parse(readFileSync(app.dataFile, "utf8"))).toEqual(theirs);
    expect(loadDoc()).toEqual(theirs);
    expect(names()).toContain("data-pre-import-2026-07-31.json");
    expect(
      JSON.parse(readFileSync(join(app.backupDir, "data-pre-import-2026-07-31.json"), "utf8")),
    ).toEqual(mine);
    expect(names()).toContain("data-2026-03-14.json");
  });
});

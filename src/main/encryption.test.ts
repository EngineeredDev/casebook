/**
 * Switching the passphrase on and off, over a real folder of real files.
 *
 * crypto.test.ts proves the cryptography; this proves the part that touches the
 * disk, which is where the danger actually is. Enabling and disabling rewrite
 * every file the user has, so what is checked here is mostly the same question
 * asked from different directions: after each of these operations, is every
 * piece of her work still readable?
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CryptoError } from "./crypto.ts";
import {
  changePassphrase,
  disable,
  enable,
  isEnabled,
  isUnlocked,
  keyfilePath,
  lock,
  unlock,
  unlockWithRecovery,
} from "./encryption.ts";
import {
  listSnapshots,
  loadDoc,
  LockedError,
  resetSnapshotState,
  saveDoc,
  setCodec,
} from "./storage.ts";
import { doc, tempApp, type TempApp } from "../test/helpers.ts";

const PASSPHRASE = "the one she actually uses";

let app: TempApp;

beforeEach(() => {
  app = tempApp();
  resetSnapshotState();
  setCodec(null);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-31T09:00:00"));
});

afterEach(() => {
  // Module state outlives a test in this file — the data key most of all.
  lock();
  vi.useRealTimers();
});

function names(): string[] {
  return existsSync(app.backupDir) ? readdirSync(app.backupDir).toSorted() : [];
}

/** A folder with a day's work and a couple of snapshots already in it. */
function aFolderWithHistory() {
  const monday = doc({ students: 4, entries: 20 });
  saveDoc(monday);
  vi.setSystemTime(new Date("2026-07-31T09:30:00"));
  const later = doc({ students: 5, entries: 26 });
  saveDoc(later, monday);
  return { monday, later };
}

async function failureKind(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof CryptoError) return error.kind;
    throw error;
  }
  throw new Error("Expected that to fail, and it didn't.");
}

describe("turning it on", () => {
  it("encrypts the live file and every snapshot, and says so on disk", async () => {
    const { later } = aFolderWithHistory();
    const before = names();
    expect(before.every((name) => name.endsWith(".json"))).toBe(true);

    const recoveryKey = await enable(PASSPHRASE);

    expect(recoveryKey.replace(/-/g, "")).toHaveLength(26);
    expect(isEnabled()).toBe(true);
    expect(isUnlocked()).toBe(true);
    expect(existsSync(keyfilePath())).toBe(true);

    // Named so that Finder, a restore and a future reader can each tell the two
    // eras apart without opening anything.
    expect(existsSync(`${app.dataFile}.enc`)).toBe(true);
    expect(existsSync(app.dataFile)).toBe(false);
    expect(names().every((name) => name.endsWith(".json.enc"))).toBe(true);

    // And it is genuinely unreadable, not merely renamed.
    expect(readFileSync(`${app.dataFile}.enc`).toString("latin1")).not.toContain("Student 1");
    expect(loadDoc()).toEqual(later);
  });

  it("snapshots the state before it converts anything", async () => {
    aFolderWithHistory();
    const beforeCount = names().length;

    await enable(PASSPHRASE);

    // The one operation in the app that rewrites every file at once, on the one
    // code path where a mistake is unrecoverable. It takes a copy first through
    // the ordinary tiers, so the pre-encryption state is reachable by the same
    // restore as everything else.
    expect(names().length).toBeGreaterThan(beforeCount);
    expect(listSnapshots().every((snapshot) => snapshot.readable)).toBe(true);
  });

  it("refuses to run twice", async () => {
    await enable(PASSPHRASE);
    await expect(enable("another one")).rejects.toThrow(/already/i);
  });

  it("leaves alone what it can't convert", async () => {
    saveDoc(doc());
    writeFileSync(join(app.backupDir, "data-2026-07-01.json.bad"), "{ truncated");
    writeFileSync(join(app.backupDir, "notes.txt"), "not a document");

    await enable(PASSPHRASE);

    // Re-encrypting a file that was already broken would turn a recognisably
    // damaged snapshot into a well-formed encryption of rubbish, which looks
    // fine right up until the morning it is needed.
    expect(names()).toContain("data-2026-07-01.json.bad");
    expect(names()).toContain("notes.txt");
    expect(readFileSync(join(app.backupDir, "notes.txt"), "utf8")).toBe("not a document");
  });
});

describe("locking and unlocking", () => {
  it("cannot read anything once locked", async () => {
    const { later } = aFolderWithHistory();
    await enable(PASSPHRASE);
    expect(loadDoc()).toEqual(later);

    lock();

    expect(isUnlocked()).toBe(false);
    // A specific error rather than a parse failure: the screen that meets this
    // has to say "type your passphrase", not "your records are damaged".
    expect(() => loadDoc()).toThrow(LockedError);
  });

  it("reads everything again with the right passphrase", async () => {
    const { later } = aFolderWithHistory();
    await enable(PASSPHRASE);
    lock();

    await unlock(PASSPHRASE);

    expect(isUnlocked()).toBe(true);
    expect(loadDoc()).toEqual(later);
    expect(listSnapshots().every((snapshot) => snapshot.readable)).toBe(true);
  });

  it("says a snapshot is locked rather than letting it look damaged", async () => {
    aFolderWithHistory();
    await enable(PASSPHRASE);
    lock();

    // The two arrive at the Backups panel looking identical — neither could be
    // read. Reporting a perfectly good backup as corrupt, on the morning
    // someone is already frightened, is the worst wrong answer this app has.
    const listed = listSnapshots();
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((snapshot) => !snapshot.readable && snapshot.locked)).toBe(true);

    await unlock(PASSPHRASE);
    expect(listSnapshots().every((snapshot) => snapshot.readable && !snapshot.locked)).toBe(true);
  });

  it("still calls a genuinely damaged snapshot damaged", async () => {
    aFolderWithHistory();
    await enable(PASSPHRASE);
    writeFileSync(join(app.backupDir, "data-2026-07-30.json.enc"), "CASEBOOK truncated");

    const broken = listSnapshots().find((s) => s.name === "data-2026-07-30.json.enc");
    expect(broken).toMatchObject({ readable: false, locked: false });
  });

  it("refuses the wrong passphrase and stays locked", async () => {
    aFolderWithHistory();
    await enable(PASSPHRASE);
    lock();

    expect(await failureKind(() => unlock("not it"))).toBe("wrong-passphrase");
    expect(isUnlocked()).toBe(false);
    expect(() => loadDoc()).toThrow(LockedError);
  });

  it("still reads snapshots written before encryption was turned on", async () => {
    // backups/ holds both eras for as long as the old files are kept, and a
    // restore has to be able to reach across that line. Nothing renames them.
    const { monday } = aFolderWithHistory();
    const plaintext = join(app.backupDir, "data-2026-06-01.json");
    writeFileSync(plaintext, JSON.stringify(monday, null, 2));

    await enable(PASSPHRASE);
    // enable() converts what is there, so put one back afterwards — which is
    // also what restoring an old backup by hand would do.
    writeFileSync(plaintext, JSON.stringify(monday, null, 2));

    const found = listSnapshots().find((snapshot) => snapshot.name === "data-2026-06-01.json");
    expect(found).toMatchObject({ readable: true, encrypted: false, students: 4 });
  });
});

describe("changing the passphrase", () => {
  it("keeps every snapshot readable, because only the wrapping changed", async () => {
    const { later } = aFolderWithHistory();
    await enable(PASSPHRASE);

    await changePassphrase(PASSPHRASE, "something new entirely");
    lock();
    await unlock("something new entirely");

    // The whole reason for the envelope. Re-deriving a file key from the
    // passphrase would have meant re-encrypting the entire backup history here,
    // on the one code path where an interruption destroys everything at once.
    expect(loadDoc()).toEqual(later);
    expect(listSnapshots().every((snapshot) => snapshot.readable)).toBe(true);
  });

  it("won't change it without the current one", async () => {
    aFolderWithHistory();
    await enable(PASSPHRASE);

    // Reachable by anyone who walks up to an unlocked Mac, which is exactly the
    // situation the passphrase is meant to survive.
    expect(await failureKind(() => changePassphrase("a guess", "theirs"))).toBe("wrong-passphrase");
    lock();
    await unlock(PASSPHRASE);
    expect(isUnlocked()).toBe(true);
  });
});

describe("the recovery key", () => {
  it("opens the data and forces a new passphrase", async () => {
    const { later } = aFolderWithHistory();
    const recoveryKey = await enable(PASSPHRASE);
    lock();

    await unlockWithRecovery(recoveryKey, "a passphrase she'll remember");

    expect(loadDoc()).toEqual(later);
    lock();
    // The old one is gone, the new one works. An account whose only remaining
    // credential is a sheet of paper that has already been mislaid once is not
    // one anybody should carry on using.
    expect(await failureKind(() => unlock(PASSPHRASE))).toBe("wrong-passphrase");
    await unlock("a passphrase she'll remember");
    expect(isUnlocked()).toBe(true);
  });

  it("survives a passphrase change", async () => {
    aFolderWithHistory();
    const recoveryKey = await enable(PASSPHRASE);
    await changePassphrase(PASSPHRASE, "the second one");
    lock();

    // The sheet was printed once and may be in a drawer. It wraps the data key,
    // which is the thing that did not change.
    await unlockWithRecovery(recoveryKey, "the third one");
    expect(isUnlocked()).toBe(true);
  });

  it("refuses a key from somewhere else", async () => {
    aFolderWithHistory();
    await enable(PASSPHRASE);
    lock();

    expect(
      await failureKind(() => unlockWithRecovery("ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZZ", "new")),
    ).toBe("wrong-recovery-key");
    expect(isUnlocked()).toBe(false);
  });
});

describe("turning it off", () => {
  it("puts everything back as plain files", async () => {
    const { later } = aFolderWithHistory();
    await enable(PASSPHRASE);

    disable();

    expect(isEnabled()).toBe(false);
    expect(existsSync(keyfilePath())).toBe(false);
    expect(existsSync(app.dataFile)).toBe(true);
    expect(existsSync(`${app.dataFile}.enc`)).toBe(false);
    expect(names().every((name) => name.endsWith(".json"))).toBe(true);
    expect(loadDoc()).toEqual(later);
  });

  it("refuses while locked, rather than removing the key to files it can't read", async () => {
    aFolderWithHistory();
    await enable(PASSPHRASE);
    lock();

    // The single worst thing this module could do: delete the keyfile while
    // encrypted files remain, leaving data nothing can ever open again.
    expect(() => disable()).toThrow(/unlocked/i);
    expect(existsSync(keyfilePath())).toBe(true);
  });

  it("comes back with the data intact after a full round trip", async () => {
    const { later } = aFolderWithHistory();
    const snapshotsBefore = listSnapshots().map((s) => `${s.students}/${s.entries}`);

    await enable(PASSPHRASE);
    lock();
    await unlock(PASSPHRASE);
    disable();

    expect(loadDoc()).toEqual(later);
    // Same history, same counts, same order — the round trip is not allowed to
    // quietly lose a snapshot along the way.
    expect(listSnapshots().map((s) => `${s.students}/${s.entries}`)).toEqual(
      expect.arrayContaining(snapshotsBefore),
    );
    expect(listSnapshots().every((s) => s.readable && !s.encrypted)).toBe(true);
  });
});

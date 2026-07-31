/**
 * The second copy, and the rule that keeps it from asking permission.
 *
 * Most of what follows is ordinary reconciliation — copy what's missing, remove
 * what's gone, don't re-copy what's already there. The test that carries the
 * design is "never reads the folder it writes to": it runs the whole thing
 * against a directory the process is allowed to write and search but not list,
 * which is the shape macOS imposes on a TCC-protected location. If any code
 * path ever reaches for `readdir` or reads a mirrored file back, that test is
 * where it shows up — and in the real app it would instead show up as a
 * permission prompt after every self-update, which is the failure this whole
 * approach exists to avoid.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  LocalFolderTarget,
  TargetError,
  type BackupTarget,
  type TargetStatus,
  type TargetTrouble,
} from "./backuptarget.ts";
import { mirrorStatus, reconcile, type MirrorSource } from "./mirror.ts";
import { tempApp, type TempApp } from "../test/helpers.ts";

let app: TempApp;
let mirrorDir: string;

beforeEach(() => {
  app = tempApp();
  mirrorDir = join(app.root, "Mirror");
  mkdirSync(app.backupDir, { recursive: true });
  // The destination exists, because a folder picker is where it comes from.
  mkdirSync(mirrorDir, { recursive: true });
});

/** A snapshot in backups/, of the kind the mirror is meant to carry. */
function snapshot(name: string, contents = `{"name":"${name}"}`): MirrorSource {
  const path = join(app.backupDir, name);
  writeFileSync(path, contents);
  return { name, path };
}

function local(): LocalFolderTarget {
  return new LocalFolderTarget(mirrorDir);
}

function mirrored(name: string): string | null {
  const path = join(mirrorDir, name);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

describe("a local folder as a destination", () => {
  it("reports an absent folder as unreachable rather than failing", async () => {
    // The everyday case: the external drive isn't plugged in. It is not an
    // error, it is a copy that happens later.
    const gone = new LocalFolderTarget(join(app.root, "NotMounted"));
    expect(await gone.status()).toEqual({ reachable: false, trouble: "unreachable" });
  });

  it("never creates the folder itself", async () => {
    // The hazard this avoids is specific to macOS: an unmounted volume has no
    // mountpoint, so creating the path would put a real directory on the boot
    // disk that shadows the drive when it is next plugged in — and every backup
    // afterwards would go somewhere nobody thinks to look.
    const unmounted = join(app.root, "Volumes", "Backup");
    const target = new LocalFolderTarget(unmounted);

    await reconcile(target, [snapshot("data-2026-07-31.json")]);
    expect(existsSync(unmounted)).toBe(false);
  });

  it("treats deleting something that isn't there as done", async () => {
    // The end state is what matters, and it is already the end state. A mirror
    // that threw here would be one the user could break by tidying up in Finder.
    await expect(local().delete("never-existed.json")).resolves.toBeUndefined();
  });

  it("says what went wrong in terms worth repeating to a person", async () => {
    mkdirSync(mirrorDir, { recursive: true });
    chmodSync(mirrorDir, 0o500);
    try {
      await expect(local().put("x.json", Buffer.from("{}"))).rejects.toMatchObject({
        trouble: "denied",
      });
    } finally {
      chmodSync(mirrorDir, 0o700);
    }
  });

  it("leaves no half-written file under a name a sync service is watching", async () => {
    // Written to one side and renamed into place, so Dropbox or iCloud never
    // starts uploading a partial file and never produces a conflict copy.
    const target = local();
    await target.put("data-2026-07-31-1500.json", Buffer.from('{"entries":[]}'));
    expect(mirrored("data-2026-07-31-1500.json")).toBe('{"entries":[]}');
    expect(existsSync(join(mirrorDir, "data-2026-07-31-1500.json.part"))).toBe(false);
  });
});

describe("reconciling", () => {
  it("copies everything the first time", async () => {
    const sources = [snapshot("data-2026-07-29.json"), snapshot("data-2026-07-30.json")];
    const report = await reconcile(local(), sources);

    expect(report).toEqual({ state: "done", copied: 2, removed: 0, total: 2 });
    expect(mirrored("data-2026-07-29.json")).toBe('{"name":"data-2026-07-29.json"}');
    expect(mirrored("data-2026-07-30.json")).toBe('{"name":"data-2026-07-30.json"}');
  });

  it("does nothing at all the second time", async () => {
    const sources = [snapshot("data-2026-07-29.json")];
    await reconcile(local(), sources);
    const again = await reconcile(local(), sources);

    // Runs on every snapshot and at every launch. Re-uploading two days of
    // backups each time would make a synced folder churn for no reason.
    expect(again).toEqual({ state: "done", copied: 0, removed: 0, total: 1 });
  });

  it("puts back a file someone deleted at the destination", async () => {
    const sources = [snapshot("data-2026-07-29.json")];
    await reconcile(local(), sources);
    rmSync(join(mirrorDir, "data-2026-07-29.json"));

    // The manifest still claims it is there; the stat says otherwise, and the
    // stat wins. This is the whole self-healing story — and the reason
    // verification is a stat rather than trust in our own records.
    const report = await reconcile(local(), sources);
    expect(report).toMatchObject({ state: "done", copied: 1 });
    expect(mirrored("data-2026-07-29.json")).not.toBeNull();
  });

  it("re-copies a file that changed underneath it", async () => {
    // Snapshots never change, but keyfile.json does — a passphrase change
    // rewrites it, to the same length, with entirely different contents. Size
    // alone would miss that, which is why the modification time is recorded too.
    const keyfile = snapshot("keyfile.json", '{"wrap":"first"}');
    await reconcile(local(), [keyfile]);
    expect(mirrored("keyfile.json")).toBe('{"wrap":"first"}');

    writeFileSync(keyfile.path, '{"wrap":"secnd"}');
    const report = await reconcile(local(), [keyfile]);

    expect(report).toMatchObject({ copied: 1 });
    expect(mirrored("keyfile.json")).toBe('{"wrap":"secnd"}');
  });

  it("removes what the data folder no longer has", async () => {
    const kept = snapshot("data-2026-07-30.json");
    const aged = snapshot("data-2026-05-01.json");
    await reconcile(local(), [kept, aged]);

    rmSync(aged.path);
    const report = await reconcile(local(), [kept]);

    expect(report).toEqual({ state: "done", copied: 0, removed: 1, total: 1 });
    expect(mirrored("data-2026-05-01.json")).toBeNull();
    expect(mirrored("data-2026-07-30.json")).not.toBeNull();
  });

  it("skips quietly when the destination isn't there", async () => {
    const report = await reconcile(new LocalFolderTarget(join(app.root, "NotMounted")), [
      snapshot("data-2026-07-30.json"),
    ]);
    // Quiet, and specifically not an exception: an unplugged drive must never
    // reach the user as an error they have to dismiss mid-session.
    expect(report).toEqual({ state: "skipped", trouble: "unreachable" });
  });

  it("does nothing when no destination is configured", async () => {
    expect(await reconcile(null, [snapshot("data-2026-07-30.json")])).toEqual({ state: "off" });
  });

  it("starts a new manifest when the destination changes", async () => {
    const sources = [snapshot("data-2026-07-30.json")];
    await reconcile(local(), sources);

    // Records about the old folder say nothing about the new one. Keeping them
    // would mean the new folder is never filled — the manifest would insist
    // everything had already been copied there.
    const elsewhere = join(app.root, "Mirror Two");
    mkdirSync(elsewhere);
    const report = await reconcile(new LocalFolderTarget(elsewhere), sources);
    expect(report).toMatchObject({ state: "done", copied: 1 });
    expect(existsSync(join(elsewhere, "data-2026-07-30.json"))).toBe(true);
  });

  it("never reads the folder it writes to", async () => {
    // Write and search, but not list — the shape macOS gives a TCC-protected
    // location that has been written to but never granted read access. A
    // `readdir` anywhere in this code path fails with EACCES here, and would
    // cost a permission prompt after every self-update in the real app.
    mkdirSync(mirrorDir, { recursive: true });
    const sources = [snapshot("data-2026-07-29.json"), snapshot("data-2026-07-30.json")];
    await reconcile(local(), sources);

    chmodSync(mirrorDir, 0o300);
    try {
      writeFileSync(sources[1]!.path, '{"changed":true}');
      const report = await reconcile(local(), [sources[1]!]);
      // Copied the changed file, pruned the vanished one, read nothing.
      expect(report).toEqual({ state: "done", copied: 1, removed: 1, total: 1 });
    } finally {
      chmodSync(mirrorDir, 0o700);
    }
    expect(mirrored("data-2026-07-30.json")).toBe('{"changed":true}');
    expect(mirrored("data-2026-07-29.json")).toBeNull();
  });
});

/** A destination that fails on demand, for the cases a real folder won't produce. */
class FlakyTarget implements BackupTarget {
  readonly label = "flaky";
  readonly written: string[] = [];
  failOn: string | null = null;
  trouble: TargetTrouble = "full";
  private readonly present = new Map<string, number>();

  status(): Promise<TargetStatus> {
    return Promise.resolve({ reachable: true });
  }

  put(name: string, contents: Buffer): Promise<void> {
    if (name === this.failOn) {
      return Promise.reject(new TargetError(this.trouble, `refused ${name}`));
    }
    this.written.push(name);
    this.present.set(name, contents.byteLength);
    return Promise.resolve();
  }

  stat(name: string): Promise<{ size: number } | null> {
    const size = this.present.get(name);
    return Promise.resolve(size === undefined ? null : { size });
  }

  delete(name: string): Promise<void> {
    this.present.delete(name);
    return Promise.resolve();
  }
}

describe("when a copy fails partway", () => {
  it("keeps what it managed and reports the trouble", async () => {
    const sources = [
      snapshot("data-2026-07-28.json"),
      snapshot("data-2026-07-29.json"),
      snapshot("data-2026-07-30.json"),
    ];
    const target = new FlakyTarget();
    target.failOn = "data-2026-07-29.json";

    const report = await reconcile(target, sources);
    expect(report).toEqual({ state: "partial", copied: 1, removed: 0, trouble: "full" });

    // The next pass has to pick up where this one stopped rather than start
    // over — on a full disk or a drive pulled mid-copy, starting over means
    // never finishing.
    target.failOn = null;
    const second = await reconcile(target, sources);
    expect(second).toMatchObject({ state: "done", copied: 2 });
    expect(target.written).toEqual([
      "data-2026-07-28.json",
      "data-2026-07-29.json",
      "data-2026-07-30.json",
    ]);
  });

  it("never prunes on a run that didn't finish copying", async () => {
    // Pruning first, then failing, would leave the destination holding strictly
    // less than it did before — the one direction a backup may never move.
    const kept = snapshot("data-2026-07-30.json");
    const aged = snapshot("data-2026-05-01.json");
    const target = new FlakyTarget();
    await reconcile(target, [kept, aged]);

    rmSync(aged.path);
    target.failOn = "data-2026-07-31.json";
    const report = await reconcile(target, [kept, snapshot("data-2026-07-31.json")]);

    expect(report).toMatchObject({ state: "partial", removed: 0 });
    expect(await target.stat("data-2026-05-01.json")).not.toBeNull();
  });
});

describe("what Settings is told", () => {
  it("says nothing is configured when nothing is", () => {
    expect(mirrorStatus(null)).toMatchObject({ target: null, fileCount: 0, stale: false });
  });

  it("reports the last successful copy and how many files are out there", async () => {
    await reconcile(local(), [snapshot("data-2026-07-29.json"), snapshot("data-2026-07-30.json")]);
    const status = mirrorStatus(mirrorDir);

    expect(status.target).toBe(mirrorDir);
    expect(status.fileCount).toBe(2);
    expect(status.lastSuccessAt).not.toBeNull();
    expect(status.lastTrouble).toBeNull();
    expect(status.stale).toBe(false);
  });

  it("is not stale merely for having never worked", async () => {
    // A mirror configured five minutes ago onto a drive that isn't plugged in
    // yet is not a problem worth a banner. Staleness measures a copy that used
    // to happen and has stopped.
    await reconcile(new LocalFolderTarget(join(app.root, "NotMounted")), [
      snapshot("data-2026-07-30.json"),
    ]);
    const status = mirrorStatus(join(app.root, "NotMounted"));

    expect(status.lastSuccessAt).toBeNull();
    expect(status.lastTrouble).toBe("unreachable");
    expect(status.stale).toBe(false);
  });
});

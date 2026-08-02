/**
 * Where a second copy of the backups goes, and the seam that keeps it
 * replaceable.
 *
 * Today there is one implementation: a folder the user picks — an external
 * drive, a network share, or a folder some cloud service already syncs. A
 * Google Drive or Dropbox connector would be another implementation of the same
 * four calls against an HTTP API, and nothing in mirror.ts would change. That
 * is the entire reason this is an interface rather than four functions.
 *
 * **There is no `list`, and that is not an oversight.** macOS gates *reading*
 * protected locations — Documents, Desktop, Downloads, removable and network
 * volumes, iCloud Drive — behind a permission prompt, but does not gate
 * *writing*, and `stat` on a path you already know is free. TCC keys those
 * grants to the app's code signature, and Casebook is ad-hoc signed, so its
 * identity changes with every self-update: anything that reads inside the
 * mirror folder would re-prompt after each update, forever. A mirror that only
 * ever writes new files, stats paths it already knows about, and deletes by
 * name from its own records never asks for anything, wherever the user points
 * it. The manifest in mirror.ts is what owns the knowledge of what exists,
 * precisely so that nothing here has to look.
 *
 * So: no `readdir`, no reading a mirrored file back, ever. See the note on
 * `writeWithoutReading` for the one place this gets subtle.
 */

import { existsSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/** Why a destination couldn't be used, in the terms the UI has to explain. */
export type TargetTrouble =
  /** The drive isn't plugged in, the share isn't mounted, the folder is gone. */
  | "unreachable"
  /** It's there, but this app may not write to it. */
  | "denied"
  /** Out of space. Worth its own word — it is the one the user can act on. */
  | "full"
  | "unknown";

export class TargetError extends Error {
  constructor(
    readonly trouble: TargetTrouble,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "TargetError";
  }
}

export type TargetStatus = { reachable: true } | { reachable: false; trouble: TargetTrouble };

/**
 * Async and error-typed throughout, because the next implementation is an HTTP
 * API where every one of these is a request that can fail in ways a local
 * folder cannot.
 *
 * Every `name` below is a bare filename and an implementation is entitled to
 * refuse anything else — see `refuseName`.
 */
export interface BackupTarget {
  /** What to call this destination on screen. */
  readonly label: string;
  /** Whether it can be written to right now. Never throws; an unplugged drive is an answer. */
  status(): Promise<TargetStatus>;
  /** Write, replacing whatever is there. Throws `TargetError`. */
  put(name: string, contents: Buffer): Promise<void>;
  /**
   * Size of a file this target was told about, or null if it isn't there.
   * Nothing the destination does makes this fail — a missing file and a drive
   * that has gone away are both "it isn't there" — but a name that isn't a
   * filename is refused rather than answered.
   */
  stat(name: string): Promise<{ size: number } | null>;
  /** Remove by name. Absent is success — the end state is what matters. */
  delete(name: string): Promise<void>;
}

/**
 * Whether a name may be joined onto the destination folder, as the error to
 * reject with — or null when it is fine.
 *
 * Every name that gets this far came out of the mirror manifest, which this app
 * wrote and nothing else reads, so a separator in one is not somebody attacking:
 * whoever could edit that file could already delete anything of hers directly,
 * as her. It is a manifest that got damaged — a truncated write, a bad sector, a
 * sync service that merged two copies of it — and the cost of trusting it anyway
 * is that `join` quietly resolves `../../Documents/caseload.docx` into a real
 * path outside the folder she picked, which `delete` then unlinks. The folder
 * she picked is the only place this class may touch, so that is checked on the
 * way in rather than assumed about the file.
 *
 * `basename(name) === name` is the whole test: it rejects separators, absolute
 * paths and trailing slashes at once. `.` and `..` survive it — `basename("..")`
 * is `".."` — so they are named, and an empty name is too, because it joins to
 * the folder itself.
 */
function refuseName(dir: string, name: string): TargetError | null {
  if (name.length > 0 && name !== "." && name !== ".." && basename(name) === name) return null;
  return new TargetError(
    "unknown",
    `${JSON.stringify(name)} isn't a file name, so nothing in ${dir} was touched.`,
  );
}

/** Map a Node filesystem error onto something worth saying to a person. */
function troubleFrom(error: unknown): TargetTrouble {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return "unreachable";
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "denied";
  if (code === "ENOSPC" || code === "EDQUOT") return "full";
  return "unknown";
}

export class LocalFolderTarget implements BackupTarget {
  constructor(private readonly dir: string) {}

  get label(): string {
    return this.dir;
  }

  /**
   * The folder has to be there already, and this never creates it.
   *
   * It arrives from a folder picker, so it exists when it is chosen. Later
   * absence means something specific: the drive was unplugged, the share went
   * down, the folder was moved. Creating it in that moment is the worst
   * available response on macOS — an unmounted volume has no mountpoint under
   * `/Volumes`, so `mkdir -p /Volumes/Backup/Casebook` fabricates a real
   * directory on the boot disk that then *shadows* the drive when it is next
   * plugged in. Every backup after that goes to a folder nobody will ever look
   * in, and the drive it was supposed to protect quietly stops receiving them.
   */
  status(): Promise<TargetStatus> {
    // `existsSync` is a stat, which costs no permission even on a protected
    // volume. Notably this does not try to list the folder or read anything in
    // it — that is the whole discipline.
    if (!existsSync(this.dir)) {
      return Promise.resolve({ reachable: false, trouble: "unreachable" });
    }
    return Promise.resolve({ reachable: true });
  }

  put(name: string, contents: Buffer): Promise<void> {
    const refusal = refuseName(this.dir, name);
    if (refusal) return Promise.reject(refusal);
    try {
      writeWithoutReading(join(this.dir, name), contents);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(
        new TargetError(troubleFrom(error), `Couldn't write ${name} to ${this.dir}.`, {
          cause: error,
        }),
      );
    }
  }

  stat(name: string): Promise<{ size: number } | null> {
    // Refused rather than answered with null, which the reconciler would read as
    // "not copied yet" and follow with a `put` of the same bad name.
    const refusal = refuseName(this.dir, name);
    if (refusal) return Promise.reject(refusal);
    try {
      return Promise.resolve({ size: statSync(join(this.dir, name)).size });
    } catch {
      // Missing, or on a volume that has gone away. Either way the answer the
      // reconciler wants is "it isn't there", and it will decide what to do.
      return Promise.resolve(null);
    }
  }

  delete(name: string): Promise<void> {
    // The one that has to hold even though "absent is success" below would
    // happily swallow it. This is the call that unlinks, and a bad name reaching
    // it is the only mistake in this file that cannot be taken back.
    const refusal = refuseName(this.dir, name);
    if (refusal) return Promise.reject(refusal);
    try {
      unlinkSync(join(this.dir, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return Promise.reject(
          new TargetError(troubleFrom(error), `Couldn't remove ${name} from ${this.dir}.`, {
            cause: error,
          }),
        );
      }
    }
    return Promise.resolve();
  }
}

/**
 * Write a file into the mirror without ever opening the folder for reading.
 *
 * Deliberately *not* `writeFileAtomic`. That one finishes by opening the parent
 * directory read-only to fsync it, which is the strongest durability macOS
 * offers and exactly the shape of syscall the rule above exists to avoid —
 * opening a directory handle inside a location TCC protects is the kind of
 * access that can raise a prompt, and a prompt after every self-update is the
 * failure this design is built to prevent. The trade is worth taking: the
 * mirror is a bonus third copy of files whose originals are already durable in
 * `backups/`, so a power cut costs this copy at most one file, and the next
 * reconcile notices the size is wrong and writes it again.
 *
 * Still temp-then-rename, so a sync service watching the folder never sees a
 * half-written file under a name it has started uploading.
 */
function writeWithoutReading(path: string, contents: Buffer): void {
  const temp = `${path}.part`;
  writeFileSync(temp, contents);
  try {
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The original error is the one worth reporting.
    }
    throw error;
  }
}

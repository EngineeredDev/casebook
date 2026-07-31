/**
 * Writing a file so that neither a crash nor a power cut can damage it.
 *
 * Its own module because everything that matters goes through it and the
 * dependency graph would otherwise forbid that: `storage.ts` imports `paths.ts`
 * imports `config.ts`, so config — which records where the data folder is, and
 * is therefore worth exactly as much as the data — could not have imported this
 * from storage without a cycle.
 */

import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * How many temp files this process has made. Part of the temp name, so two
 * writes that overlap — a snapshot taken while a save is in flight — cannot
 * pick the same scratch file and interleave into each other.
 */
let tempWrites = 0;

/**
 * Write a file so that neither a crash nor a power cut can leave it damaged.
 *
 * Rename is what makes it atomic: APFS renames are transactional, so a reader
 * sees either the whole old file or the whole new one, and the old file is
 * never the thing being modified. That much the app has always done, and it is
 * enough for a crash — a process that dies has no say in what the kernel does
 * with writes it already accepted.
 *
 * What it is not enough for is losing power. The rename is metadata and the
 * contents are data, and the two reach the platter independently: the directory
 * entry can be durable while the bytes it points at are not, which resolves
 * after reboot as a present-but-empty or partial data.json — the whole file,
 * gone, from a save that reported success. So the contents are flushed with
 * `fsyncSync` before the rename, and the directory is flushed after it. On
 * macOS both are `F_FULLFSYNC`, Apple's real flush-to-permanent-storage
 * primitive rather than the one that lies for speed.
 *
 * Two details worth not rediscovering:
 *
 * - The payload is a `Buffer`, not a string. `writeFileSync(path, str, {flush:
 *   true})` looks like it would do all of this in one call, and for a utf8
 *   string it silently skips the fsync entirely (nodejs/node#60539) — the
 *   fast path drops the option. A write that quietly isn't durable is worse
 *   than one that never claimed to be.
 * - The cost is ~15–30 ms per full flush regardless of payload size, so ~30–60
 *   ms here. Saves are debounced at 500 ms; nobody will meet this.
 */
export function writeFileAtomic(path: string, contents: string | Buffer): void {
  tempWrites += 1;
  const tmp = `${path}.${process.pid}-${tempWrites}.tmp`;
  // Already bytes when it arrives from the encrypting codec; utf8 otherwise.
  const payload = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8");

  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, payload);
    // Before the rename, deliberately. A failure here means the temp file's
    // contents are in doubt, and renaming a doubtful file over a good one is
    // the single worst move available.
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  try {
    renameSync(tmp, path);
  } catch (error) {
    // Leaving the scratch file behind would litter the data folder with one
    // more corpse per failed save, in the folder the user is told to look at.
    try {
      unlinkSync(tmp);
    } catch {
      // The original error is the one worth reporting.
    }
    throw error;
  }

  syncDirectory(dirname(path));
}

/**
 * Flush the directory entry the rename just created.
 *
 * Best-effort on purpose. By the time this runs the contents are already
 * durable and the rename has already happened, so a failure costs the extra
 * guarantee and nothing else — the file is exactly as safe as it was in every
 * version of this app that shipped before. Throwing would instead report a
 * successful save as a failure, which stops the in-memory document advancing
 * and turns the next save into a conflict the user cannot resolve. That is a
 * real loss traded for a theoretical one.
 */
function syncDirectory(dir: string): void {
  let fd: number;
  try {
    fd = openSync(dir, "r");
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    // See above.
  } finally {
    closeSync(fd);
  }
}

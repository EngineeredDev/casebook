/**
 * Keeping a second copy of the backups somewhere that isn't this Mac.
 *
 * The gap this closes is the worst one in the audit: one folder, one SSD. A
 * stolen laptop or a dead disk currently ends with everything gone, and no
 * amount of snapshot retention inside `~/Casebook` helps with that — the
 * snapshots are in the folder being lost.
 *
 * Three rules shape all of it:
 *
 * 1. **Only immutable files go out.** Snapshots are written once under a name
 *    that is never reused, so a folder synced by Dropbox or iCloud never sees a
 *    file change underneath it — no conflict copies, no half-uploaded edits.
 *    The live `data.json` is deliberately never mirrored; the newest snapshot
 *    is at most fifteen minutes behind it, and mirroring a file that changes
 *    every few seconds is how sync services produce "data (conflicted copy)".
 * 2. **The manifest is the only thing that knows what's out there.** Nothing
 *    ever lists or reads the mirror folder — see the long note in
 *    backuptarget.ts for why that would cost a permission prompt after every
 *    self-update. Reconciling means statting names we already recorded and
 *    writing whatever is missing.
 * 3. **Failure is quiet.** An unplugged drive is not an error the user has to
 *    dismiss; it is a copy that will be made later. Nothing here ever blocks a
 *    save, and nothing here ever throws at a caller — the report says what
 *    happened and the UI decides whether it is worth mentioning yet.
 */

import { app } from "electron";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import type { BackupTarget, TargetTrouble } from "./backuptarget.ts";
import { TargetError } from "./backuptarget.ts";

/** A file in the data folder that ought to have a copy at the destination. */
export interface MirrorSource {
  /** The name it takes at the destination — a bare filename, never a path. */
  name: string;
  /** Where to read it from, on our side. */
  path: string;
}

/**
 * What we believe is at the destination, and what the local file looked like
 * when we put it there. Size and modification time rather than a hash: the
 * snapshots never change once written, so this is enough to notice the one file
 * that does — the keyfile, after a passphrase change — without reading twenty
 * megabytes of backups on every pass.
 */
interface Record_ {
  size: number;
  modifiedMs: number;
  copiedAt: string;
}

interface Manifest {
  version: 1;
  /**
   * Which destination these records describe. Pointing the mirror at a
   * different folder makes every record meaningless, and silently keeping them
   * would mean the new folder is never filled in — the manifest would claim
   * everything was already copied.
   */
  target: string;
  files: Record<string, Record_>;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastTrouble: TargetTrouble | null;
}

export type MirrorReport =
  /** Nothing was attempted: no destination is configured. */
  | { state: "off" }
  /** The destination wasn't there. Not an error — try again later. */
  | { state: "skipped"; trouble: TargetTrouble }
  | { state: "done"; copied: number; removed: number; total: number }
  /**
   * Started, then stopped — the drive was pulled mid-copy, or the volume filled
   * up. Whatever was copied before that stays recorded, so the next pass picks
   * up where this one stopped rather than starting over.
   */
  | { state: "partial"; copied: number; removed: number; trouble: TargetTrouble };

/** How long a destination may be unreachable before it is worth saying so. */
export const STALE_AFTER_DAYS = 7;

function manifestPath(): string {
  // On our side of the fence, always: this is bookkeeping about a remote place,
  // and it must never be the thing we have to read *from* that place.
  return join(app.getPath("userData"), "mirror-manifest.json");
}

function emptyManifest(target: string): Manifest {
  return {
    version: 1,
    target,
    files: {},
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastTrouble: null,
  };
}

function readManifest(target: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath(), "utf8"));
  } catch {
    // No manifest, or an unreadable one. Both mean the same thing and both
    // self-heal: an empty manifest says nothing has been copied, every file
    // gets statted at the destination, and only what is genuinely absent is
    // written. Losing this file costs one slow pass, never a lost backup.
    return emptyManifest(target);
  }
  if (typeof parsed !== "object" || parsed === null) return emptyManifest(target);
  const candidate = parsed as Manifest;
  if (candidate.version !== 1 || candidate.target !== target) return emptyManifest(target);
  if (typeof candidate.files !== "object" || candidate.files === null) {
    return emptyManifest(target);
  }
  return {
    ...emptyManifest(target),
    ...candidate,
    files: candidate.files,
  };
}

function writeManifest(manifest: Manifest): void {
  try {
    writeFileAtomic(manifestPath(), JSON.stringify(manifest, null, 2));
  } catch (error) {
    // The mirror is a bonus copy and its bookkeeping is a bonus on top of that.
    // A failure to record what was copied means the next pass re-stats and
    // re-copies more than it needed to, which is slow rather than wrong.
    console.error("Couldn't write the mirror manifest:", error);
  }
}

function troubleOf(error: unknown): TargetTrouble {
  return error instanceof TargetError ? error.trouble : "unknown";
}

/**
 * Bring the destination into line with `sources`, then record what happened.
 *
 * Never throws. Everything that can go wrong here is a thing that should leave
 * the app working and the primary backups untouched.
 */
export async function reconcile(
  target: BackupTarget | null,
  sources: MirrorSource[],
): Promise<MirrorReport> {
  if (!target) return { state: "off" };

  const manifest = readManifest(target.label);
  manifest.lastAttemptAt = new Date().toISOString();

  const availability = await target.status();
  if (!availability.reachable) {
    manifest.lastTrouble = availability.trouble;
    writeManifest(manifest);
    return { state: "skipped", trouble: availability.trouble };
  }

  let copied = 0;
  let removed = 0;

  try {
    for (const source of sources) {
      // One at a time, deliberately. `Promise.all` here would start two hundred
      // concurrent writes at an external drive or — once a connector exists —
      // at somebody's API, and it would also destroy the property the partial
      // case depends on: that everything counted as copied really was copied
      // before the failure, so the next pass resumes rather than restarts.
      // eslint-disable-next-line no-await-in-loop
      if (await copyIfMissing(target, manifest, source)) copied += 1;
    }
    // Only after everything present has been dealt with. Pruning first would,
    // on a run that then fails, leave the destination holding strictly less
    // than it did before — the one direction a backup must never move.
    removed = await prune(target, manifest, sources);
  } catch (error) {
    const trouble = troubleOf(error);
    manifest.lastTrouble = trouble;
    writeManifest(manifest);
    return { state: "partial", copied, removed, trouble };
  }

  manifest.lastTrouble = null;
  manifest.lastSuccessAt = new Date().toISOString();
  writeManifest(manifest);
  return { state: "done", copied, removed, total: Object.keys(manifest.files).length };
}

/** True if it wrote something. */
async function copyIfMissing(
  target: BackupTarget,
  manifest: Manifest,
  source: MirrorSource,
): Promise<boolean> {
  let local: { size: number; modifiedMs: number };
  try {
    const stats = statSync(source.path);
    local = { size: stats.size, modifiedMs: stats.mtimeMs };
  } catch {
    // Gone between being listed and being read — pruned by a retention pass
    // running alongside this one. The next reconcile will not offer it.
    return false;
  }

  const recorded = manifest.files[source.name];
  if (recorded && recorded.size === local.size && recorded.modifiedMs === local.modifiedMs) {
    // We believe this one is already there. Confirm by statting the name we
    // wrote — free, even on a protected volume — which is also what makes the
    // mirror self-heal after someone deletes files in it by hand.
    const there = await target.stat(source.name);
    if (there && there.size === local.size) return false;
  }

  await target.put(source.name, readFileSync(source.path));
  manifest.files[source.name] = { ...local, copiedAt: new Date().toISOString() };
  return true;
}

/** Remove what the destination holds that the data folder no longer does. */
async function prune(
  target: BackupTarget,
  manifest: Manifest,
  sources: MirrorSource[],
): Promise<number> {
  const wanted = new Set(sources.map((source) => source.name));
  let removed = 0;
  for (const name of Object.keys(manifest.files)) {
    if (wanted.has(name)) continue;
    // By name, from our own records. This is the only kind of delete available
    // without listing the folder, and it is the reason the manifest exists.
    // Sequential for the same reasons as the copy loop above.
    // eslint-disable-next-line no-await-in-loop
    await target.delete(name);
    delete manifest.files[name];
    removed += 1;
  }
  return removed;
}

export interface MirrorStatus {
  /** Absolute path of the destination, or null when the mirror is off. */
  target: string | null;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastTrouble: TargetTrouble | null;
  fileCount: number;
  /**
   * Unreachable for long enough to be worth one gentle banner. Never true
   * before a first successful copy has ever happened — a mirror configured five
   * minutes ago and not yet reachable is not a problem, it is a drive that is
   * about to be plugged in.
   */
  stale: boolean;
}

export function mirrorStatus(target: string | null): MirrorStatus {
  if (!target) {
    return {
      target: null,
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastTrouble: null,
      fileCount: 0,
      stale: false,
    };
  }
  const manifest = readManifest(target);
  return {
    target,
    lastSuccessAt: manifest.lastSuccessAt,
    lastAttemptAt: manifest.lastAttemptAt,
    lastTrouble: manifest.lastTrouble,
    fileCount: Object.keys(manifest.files).length,
    stale: isStale(manifest.lastSuccessAt),
  };
}

function isStale(lastSuccessAt: string | null): boolean {
  if (!lastSuccessAt) return false;
  const elapsed = Date.now() - new Date(lastSuccessAt).getTime();
  return elapsed > STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
}

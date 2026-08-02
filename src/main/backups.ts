/**
 * The policy layer over snapshots and the mirror: when copies happen, and what
 * Settings is told about them.
 *
 * Kept apart from storage.ts because the two answer different questions.
 * Storage knows how to write a snapshot; this knows that a save should not wait
 * for one to be copied to an external drive, that a drive which has been
 * unplugged for a fortnight is worth one sentence and never a dialog, and that
 * a restore must snapshot the thing it is about to replace.
 */

import { shell } from "electron";
import { mkdirSync } from "node:fs";
import type {
  BackupsState,
  MirrorState,
  RecoveryOffer,
  RestoreResult,
  SnapshotSummary,
} from "../shared/api.ts";
import type { DataDoc } from "../shared/types.ts";
import { LocalFolderTarget } from "./backuptarget.ts";
import { readConfig, writeConfig } from "./config.ts";
import { mirrorStatus, reconcile } from "./mirror.ts";
import { backupDir } from "./paths.ts";
import {
  forceSnapshot,
  listSnapshots,
  LockedError,
  mirrorSources,
  newestRestorable,
  preserveUnreadable,
  readSnapshot,
  saveDoc,
} from "./storage.ts";

function mirrorDir(): string | null {
  return readConfig().mirrorDir ?? null;
}

function target(): LocalFolderTarget | null {
  const dir = mirrorDir();
  return dir ? new LocalFolderTarget(dir) : null;
}

export function currentMirrorState(): MirrorState {
  const status = mirrorStatus(mirrorDir());
  return {
    dir: status.target,
    lastSuccessAt: status.lastSuccessAt,
    lastAttemptAt: status.lastAttemptAt,
    trouble: status.lastTrouble,
    fileCount: status.fileCount,
    stale: status.stale,
  };
}

/**
 * The pass currently running, if there is one. Reconciling reads every snapshot
 * and writes some of them; two at once would fight over the manifest and copy
 * the same files twice.
 *
 * Callers that arrive mid-pass join this one rather than being told "already
 * busy" — and `wantedAgain` makes the running pass go round once more, so what
 * they wanted copied is copied before their promise resolves. Returning the
 * current state immediately instead would be a lie in the one case it matters:
 * a mirror that has just been configured would report zero files, having in
 * fact copied all of them a moment later.
 */
let inFlight: Promise<MirrorState> | null = null;
let wantedAgain = false;

/**
 * Copy anything outstanding, without making anybody wait.
 *
 * Called after a save and at launch. Deliberately returns nothing and never
 * rejects: a save has already succeeded by the time this starts, and the mirror
 * is a bonus copy — an unplugged drive must not be able to turn a successful
 * save into an error, a retry, or a delay.
 */
export function mirrorSoon(): void {
  void runMirror();
}

function runMirror(): Promise<MirrorState> {
  if (inFlight) {
    wantedAgain = true;
    return inFlight;
  }
  inFlight = passes().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function passes(): Promise<MirrorState> {
  try {
    do {
      wantedAgain = false;
      // Sequential by nature: this is a loop *because* a request that arrived
      // mid-pass has to be served after it, not alongside it.
      // eslint-disable-next-line no-await-in-loop
      const report = await reconcile(target(), mirrorSources());
      if (report.state === "partial" || report.state === "skipped") {
        // Recorded in the manifest and shown in Settings. Not raised here:
        // there is no moment during ordinary use when this is worth a dialog.
        console.warn("Mirror incomplete:", report);
      }
    } while (wantedAgain);
  } catch (error) {
    console.error("Mirror failed:", error);
  }
  return currentMirrorState();
}

/** The Settings button, which unlike `mirrorSoon` is allowed to be waited on. */
export function mirrorNow(): Promise<MirrorState> {
  return runMirror();
}

/**
 * Point the mirror somewhere, and wait for the first copy.
 *
 * Awaited, unlike every other trigger, because this is the one the user is
 * watching: they have just chosen a folder and the next thing they read is how
 * many files are in it. Every other caller fires and forgets.
 */
export function setMirrorDir(dir: string | null): Promise<MirrorState> {
  writeConfig({ ...readConfig(), mirrorDir: dir ?? undefined });
  if (!dir) return Promise.resolve(currentMirrorState());
  return mirrorNow();
}

export function backupsState(): BackupsState {
  return { dir: backupDir(), snapshots: listSnapshots(), mirror: currentMirrorState() };
}

export function revealBackups(): void {
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });
  void shell.openPath(dir);
}

/**
 * What to offer when the live file cannot be read.
 *
 * `locked` is the distinction that matters: an encrypted folder opened before
 * unlocking fails to parse exactly like a damaged one, and telling someone
 * their records are corrupt when in fact they simply have not typed their
 * passphrase yet would be the worst wrong answer this app could give.
 */
export function recoveryOffer(): RecoveryOffer {
  try {
    const found = newestRestorable();
    return { snapshot: found?.summary ?? null, locked: false };
  } catch (error) {
    if (error instanceof LockedError) return { snapshot: null, locked: true };
    return { snapshot: null, locked: false };
  }
}

/**
 * Replace the live document with a snapshot.
 *
 * Two things happen before anything is overwritten, and both are the difference
 * between a restore being reversible and being a second disaster. The current
 * state is snapshotted, so choosing the wrong backup is undoable; and an
 * unreadable live file is moved aside under a preserved name rather than
 * written over, because however broken it is, it is still the most recent copy
 * of her work in existence.
 */
export function restore(
  name: string,
  current: DataDoc | null,
): { result: RestoreResult; doc: DataDoc | null } {
  let restored: DataDoc;
  try {
    restored = readSnapshot(name);
  } catch (error) {
    return { result: { error: `That backup couldn't be read — ${message(error)}` }, doc: null };
  }

  let preserved: string | null = null;
  try {
    if (current) {
      /**
       * Reachable: the live file is fine and this is a deliberate roll-back
       * from Settings. The snapshot of the current state is what makes it
       * undoable, and the panel promises that undo twice on screen.
       *
       * Forced rather than written through the ordinary tiers, because the
       * tiers can decline. If today's daily already exists and the interval
       * isn't due, `saveDoc` produces no listable snapshot at all — the
       * outgoing state lands only in `data.json.prev`, which the very next
       * ordinary edit overwrites. The promise on screen would then be false
       * exactly once: after a restore she wanted to take back.
       */
      forceSnapshot(current, "restore");
    } else {
      preserved = preserveUnreadable();
    }
  } catch (error) {
    return {
      result: {
        error: `Couldn't set the current data aside, so nothing was changed — ${message(error)}`,
      },
      doc: null,
    };
  }

  // A restore is a new revision, not a return to an old one: the renderer is
  // holding a rev of its own and has to be able to tell that the file moved on.
  const next: DataDoc = { ...restored, rev: (current?.rev ?? restored.rev) + 1 };
  try {
    saveDoc(next);
  } catch (error) {
    return { result: { error: `Couldn't write the restored data — ${message(error)}` }, doc: null };
  }

  mirrorSoon();
  return { result: { ok: true, rev: next.rev, preserved }, doc: next };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { SnapshotSummary };

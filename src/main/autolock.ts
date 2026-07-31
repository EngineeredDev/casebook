/**
 * Locking the app when nobody is at it.
 *
 * The threat encryption actually meets on a school desk is not a stolen laptop
 * — it is a session left open while she walks a student back to class. Unlocked
 * at launch and unlocked all day is most of the protection given away, so this
 * exists; but it is off by default, because a lock that interrupts work gets
 * turned off and never comes back.
 *
 * Idleness comes from `powerMonitor.getSystemIdleTime`, which measures the
 * machine rather than this window. That is the right question here: Casebook
 * sitting behind a browser while she types somewhere else is not unattended,
 * and locking it then would be an interruption with nothing to show for it.
 * Screen lock and sleep are honoured immediately, whatever the delay is set to.
 */

import { app, powerMonitor } from "electron";
import { readConfig, writeConfig } from "./config.ts";
import { isEnabled, isUnlocked, lock } from "./encryption.ts";

/** How often to ask. Coarse on purpose — this is a timer, not a stopwatch. */
const POLL_MS = 30 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;
let announce: (() => void) | null = null;
/**
 * Whether the window still has edits on their way to disk.
 *
 * Locking drops the key, and the renderer's unsaved copy then has nowhere to go
 * — the save that would have landed half a second later fails against a locked
 * folder and the edit is gone. The window is half a second wide, and it is
 * exactly the half-second after she types the last thing before walking away.
 */
let hasPendingEdits: () => boolean = () => false;

export function autoLockMinutes(): number | null {
  return readConfig().autoLockMinutes ?? null;
}

export function setAutoLockMinutes(minutes: number | null): void {
  writeConfig({ ...readConfig(), autoLockMinutes: minutes });
  restartTimer();
}

/**
 * Start watching. `onLocked` tells the renderer, which has a document in memory
 * that has to go back behind the unlock screen — locking the main process while
 * the window carried on showing student names would protect nothing.
 */
export function startAutoLock(options: {
  onLocked: () => void;
  pendingEdits: () => boolean;
}): void {
  announce = options.onLocked;
  hasPendingEdits = options.pendingEdits;

  // Whatever the idle delay says, these mean she has left. Both are free to
  // honour and both are moments a passphrase is expected to matter.
  powerMonitor.on("lock-screen", () => lockAndTell());
  powerMonitor.on("suspend", () => lockAndTell());

  restartTimer();
}

function restartTimer(): void {
  if (timer) clearInterval(timer);
  timer = null;
  const minutes = autoLockMinutes();
  if (minutes === null) return;

  timer = setInterval(() => {
    if (!isEnabled() || !isUnlocked()) return;
    // Waiting is free: the next tick is thirty seconds away, and by then the
    // save has landed. Locking now would strand it.
    if (hasPendingEdits()) return;
    if (powerMonitor.getSystemIdleTime() >= minutes * 60) lockAndTell();
  }, POLL_MS);
  // Never a reason to hold the process open.
  timer.unref?.();
}

export function lockAndTell(): void {
  if (!isEnabled() || !isUnlocked()) return;
  lock();
  announce?.();
}

/** Whether Lock Now should be offered at all. */
export function canLock(): boolean {
  return app.isReady() && isEnabled() && isUnlocked();
}

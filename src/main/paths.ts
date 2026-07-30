import { app } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The folder holding data.json and backups/ — the two files that are the
 * clinician's actual work, and the only thing in this project worth backing up.
 *
 * `~/Casebook` rather than `~/Documents`: visible, covered by Time Machine, and
 * decisively *not* TCC-protected. macOS gates Documents behind a permission
 * prompt keyed to the app's code signature, and an ad-hoc signature has no
 * stable identity, so every update could re-ask for access to the folder the
 * app cannot run without.
 *
 * A development run uses the repo root instead, so working on the app never
 * touches the real thing.
 */
export function dataDir(): string {
  return app.isPackaged ? join(homedir(), "Casebook") : app.getAppPath();
}

export function dataFile(): string {
  return join(dataDir(), "data.json");
}

export function backupDir(): string {
  return join(dataDir(), "backups");
}

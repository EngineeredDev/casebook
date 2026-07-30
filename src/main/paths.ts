import { app } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import { readConfig } from "./config.ts";

/**
 * `~/Casebook` — the folder holding data.json and backups/, which is the
 * clinician's actual work and the only thing in this project worth backing up.
 *
 * Not `~/Documents`, and the reason is specific: Documents is TCC-protected,
 * macOS gates it behind a permission prompt keyed to the app's code signature,
 * and an ad-hoc signature has no stable identity to key on — so every update
 * could re-ask for access to the folder the app cannot run without. `~/Casebook`
 * is visible, covered by Time Machine, and subject to none of that.
 */
export function defaultDataDir(): string {
  return join(homedir(), "Casebook");
}

/**
 * Where the data actually is. A development run is pinned to the repo root: it
 * has to be impossible for work on the app to write to the real folder, and the
 * configured path belongs to the installed copy.
 */
export function dataDir(): string {
  if (!app.isPackaged) return app.getAppPath();
  return readConfig().dataDir ?? defaultDataDir();
}

/** False in development, where the folder is fixed — see `dataDir`. */
export function canRelocate(): boolean {
  return app.isPackaged;
}

/**
 * Whether the folder was chosen rather than defaulted to. It changes what a
 * missing data file means: nothing at all in `~/Casebook` is a new install,
 * while nothing at a path someone deliberately set is a folder that has gone
 * somewhere (see loadDoc).
 */
export function dataDirIsConfigured(): boolean {
  return canRelocate() && readConfig().dataDir !== undefined;
}

export function dataFile(): string {
  return join(dataDir(), "data.json");
}

export function backupDir(): string {
  return join(dataDir(), "backups");
}

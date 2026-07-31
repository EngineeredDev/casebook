/**
 * The contract between the main process and the renderer — the whole of it.
 *
 * This replaces the loopback HTTP API the app used to talk to. Where that had
 * status codes, this has a discriminated union: the renderer still needs to
 * tell a revision conflict from a document the main process rejected from a
 * write that failed and might succeed next time, because it does something
 * different in each case (see store.tsx).
 */

import type { DataDoc } from "./types.ts";

export type SaveResult =
  | { ok: true; rev: number }
  /**
   * The document on disk moved on without us — was HTTP 409. The migration plan
   * called this field `serverRev`; there is no server any more, and the rev it
   * carries is the one the main process is holding, so it is named for that.
   */
  | { conflict: true; currentRev: number }
  /**
   * `retryable` is the old 5xx/4xx split. A failed disk write is worth trying
   * again on a widening interval; a document the main process refuses to
   * accept will be refused identically forever, and re-sending it only spends
   * the retry budget proving that.
   */
  | { error: string; retryable: boolean };

export type ExportResult =
  | { saved: true; path: string }
  /** The user dismissed the save dialog. Not an error; say nothing. */
  | { saved: false }
  | { error: string };

export interface DataLocation {
  /** Absolute path to the folder holding data.json and backups/. */
  dir: string;
  /** False in a development build, where the folder is pinned to the repo. */
  relocatable: boolean;
}

export type RelocateResult = { ok: true; dir: string } | { error: string };

/**
 * A pre-Electron Casebook found on this Mac: a folder with a data.json in it,
 * and whatever is still around that would keep starting it.
 */
export interface LegacyInstall {
  dir: string;
  entries: number;
  students: number;
  /** ISO timestamp of the old data.json, so the offer can say how recent it is. */
  modified: string;
  backups: number;
  executable: string | null;
  launchAgent: string | null;
}

export type ImportResult = { ok: true; entries: number; students: number } | { error: string };

/**
 * What retiring actually managed to do, rather than just that it returned.
 * The three can all be false — an install whose agent was already unloaded and
 * whose executable is already gone — and saying "removed" to that is how a UI
 * ends up reporting work it did not do.
 */
export type RetireResult =
  | { ok: true; stoppedAgent: boolean; removedPlist: boolean; removedExecutable: boolean }
  | { error: string };

/** A published release newer than the running app. */
export interface UpdateInfo {
  /** Without the leading v — what app.getVersion() would report. */
  version: string;
  /** The zip, fetched by the main process. Never handed to the renderer to download. */
  downloadUrl: string;
  /** The release page, for the "download it yourself" path when anything fails. */
  releaseUrl: string;
}

export type UpdateCheck =
  | { available: true; info: UpdateInfo }
  /** Up to date. Carries the running version so the UI can show it. */
  | { available: false; version: string }
  | { error: string };

/**
 * Whether this copy can replace itself where it stands. False for a dev build,
 * for an app translocated to a read-only mount, and for one installed somewhere
 * the current account cannot write — each of which needs different advice.
 */
export type SelfUpdateAbility = { ok: true } | { ok: false; reason: string };

export interface UpdateState {
  version: string;
  available: UpdateInfo | null;
  selfUpdate: SelfUpdateAbility;
}

/** On success the app is already on its way down to restart, so this rarely returns. */
export type UpdateInstallResult = { ok: true } | { error: string };

export interface CasebookApi {
  getDoc(): Promise<DataDoc>;
  saveDoc(doc: DataDoc): Promise<SaveResult>;
  /** Offers a save dialog, then writes `contents` wherever it points. */
  exportFile(name: string, contents: string): Promise<ExportResult>;
  /**
   * Whether edits are still on their way to disk. Closing the window while
   * this is true asks before discarding them — the job `beforeunload` did in
   * the browser, which Electron cancels silently rather than prompting for.
   */
  setUnsaved(unsaved: boolean): Promise<void>;

  getDataLocation(): Promise<DataLocation>;
  revealDataFolder(): Promise<void>;
  /** Folder-picking dialog. Null when dismissed. */
  chooseDataFolder(): Promise<string | null>;
  /** Copies the data to `target`, verifies it arrived, then switches over. */
  relocateData(target: string): Promise<RelocateResult>;

  /** An older install, if one is sitting where the installer used to put it. */
  findLegacyInstall(): Promise<LegacyInstall | null>;
  /** The same, for a copy that is somewhere less obvious. Null when dismissed. */
  chooseLegacyInstall(): Promise<LegacyInstall | null>;
  /** Refused unless the current document is still empty. */
  importLegacyData(dir: string): Promise<ImportResult>;
  /** Removes the old install's LaunchAgent, its plist and its executable. */
  retireLegacyInstall(dir: string): Promise<RetireResult>;

  /** The running version, plus whatever a background check has already found. */
  getUpdateState(): Promise<UpdateState>;
  /** Asks GitHub now, rather than waiting for the next scheduled check. */
  checkForUpdate(): Promise<UpdateCheck>;
  /** Opens the release page in the default browser, for installing by hand. */
  openReleasePage(): Promise<void>;
  /**
   * Downloads the update the main process already knows about, swaps the app
   * bundle and restarts. Takes no argument on purpose: the renderer does not get
   * to say what gets downloaded or where it is written.
   */
  installUpdate(): Promise<UpdateInstallResult>;
  /**
   * Called when a background check finds one, so a window that was already open
   * hears about it. Returns its own unsubscribe.
   */
  onUpdateAvailable(listener: (info: UpdateInfo) => void): () => void;
}

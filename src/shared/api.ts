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

/** How much a refused save would have removed. Both counts, so the wording can be exact. */
export interface MassDeletion {
  students: number;
  entries: number;
}

export type SaveResult =
  | { ok: true; rev: number }
  /**
   * The document on disk moved on without us — was HTTP 409. The migration plan
   * called this field `serverRev`; there is no server any more, and the rev it
   * carries is the one the main process is holding, so it is named for that.
   */
  | { conflict: true; currentRev: number }
  /**
   * The save would remove far more than an edit plausibly can, so it was not
   * written. The renderer asks, and sends it again with `confirmed` set if the
   * answer is yes. Nothing is lost by refusing once: the document is still in
   * the window, and the only cost of a false alarm is one dialog.
   */
  | { confirmDeletion: MassDeletion }
  /**
   * `retryable` is the old 5xx/4xx split. A failed disk write is worth trying
   * again on a widening interval; a document the main process refuses to
   * accept will be refused identically forever, and re-sending it only spends
   * the retry budget proving that.
   */
  | { error: string; retryable: boolean };

/** One file in `backups/`, described well enough to choose between them. */
export interface SnapshotSummary {
  name: string;
  /** ISO timestamp taken from the file, since the name carries no seconds. */
  takenAt: string;
  students: number;
  entries: number;
  /** False when the file is present but could not be parsed. */
  readable: boolean;
  encrypted: boolean;
  /**
   * Unreadable only because Casebook is locked, rather than because anything is
   * wrong with it.
   *
   * Stated rather than inferred from `encrypted && !readable`. Telling someone
   * a perfectly good backup is damaged is the worst wrong answer a list of
   * backups can give, and it is one an inference gets to make on its own the
   * first time these two facts come apart.
   */
  locked: boolean;
}

/**
 * What the launch-failure screen is offered instead of a dead end.
 *
 * `locked` separates "this data is encrypted and we haven't unlocked it" from
 * "this data is damaged" — they look identical to a parser and could not be
 * more different to the person reading the screen.
 */
export interface RecoveryOffer {
  snapshot: SnapshotSummary | null;
  locked: boolean;
}

export type RestoreResult =
  /** `preserved` names where the unreadable file was moved, when there was one. */
  { ok: true; rev: number; preserved: string | null } | { error: string };

export type CheckBackupsResult = { checked: number; unreadable: string[] };

/** Why the mirror couldn't be written to, in the words the UI uses. */
export type MirrorTrouble = "unreachable" | "denied" | "full" | "unknown";

export interface MirrorState {
  /** Null when no second location is configured, which is the default. */
  dir: string | null;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  trouble: MirrorTrouble | null;
  fileCount: number;
  /** Unreachable long enough to be worth one gentle banner. Never before a first success. */
  stale: boolean;
}

export interface BackupsState {
  dir: string;
  snapshots: SnapshotSummary[];
  mirror: MirrorState;
}

/**
 * Whether the passphrase is on, and whether it has been given yet.
 *
 * Two separate facts. "Enabled but not unlocked" is the state at every launch
 * once encryption is on, and it is the only one that has to come before the
 * document loads.
 */
export interface EncryptionState {
  enabled: boolean;
  unlocked: boolean;
  /** Minutes of idleness before locking. Null means never, which is the default. */
  autoLockMinutes: number | null;
}

/**
 * Failures carry a kind so the wording can differ where the difference matters:
 * a mistyped recovery key is a "check what you typed", a wrong one is "that
 * isn't the sheet for this data", and neither is "this file is damaged".
 */
export type EncryptionFailure =
  | "wrong-passphrase"
  | "wrong-recovery-key"
  | "malformed-recovery-key"
  | "corrupt"
  | "unsupported-version"
  | "other";

export type UnlockResult = { ok: true } | { error: string; kind: EncryptionFailure };

/**
 * The recovery key is returned exactly once, here. It is derived from nothing
 * and stored nowhere, so if it is not written down at this moment it cannot be
 * produced again — which is why enabling is gated on saying it was.
 */
export type EnableEncryptionResult = { ok: true; recoveryKey: string } | { error: string };

export type EncryptionResult = { ok: true } | { error: string; kind: EncryptionFailure };

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
  /**
   * `confirmed` re-sends a document the deletion tripwire refused. It is a
   * separate argument rather than a flag on the document so that it cannot
   * survive a round trip through disk and quietly disarm the guard forever.
   */
  saveDoc(doc: DataDoc, confirmed?: boolean): Promise<SaveResult>;
  /** Offers a save dialog, then writes `contents` wherever it points. */
  exportFile(name: string, contents: string): Promise<ExportResult>;
  /**
   * Whether edits are still on their way to disk. Closing the window while
   * this is true asks before discarding them — the job `beforeunload` did in
   * the browser, which Electron cancels silently rather than prompting for.
   */
  setUnsaved(unsaved: boolean): Promise<void>;

  /**
   * What could be restored, asked only once loading has already failed. Kept
   * off `getDoc` so the ordinary path stays a document or a throw.
   */
  getRecoveryOffer(): Promise<RecoveryOffer>;
  /** Snapshots and the state of the second location, for the Backups panel. */
  getBackups(): Promise<BackupsState>;
  /**
   * Replaces the live document with a snapshot. Takes a snapshot of the current
   * state first, so restoring is itself undoable, and moves an unreadable live
   * file aside rather than over it.
   */
  restoreSnapshot(name: string): Promise<RestoreResult>;
  /** Parses every snapshot; renames the unreadable ones so the recovery scan skips them. */
  checkBackups(): Promise<CheckBackupsResult>;
  revealBackupsFolder(): Promise<void>;

  /**
   * Asked before the document, since when encryption is on the document cannot
   * be read until this says it has been unlocked.
   */
  getEncryptionState(): Promise<EncryptionState>;
  /** Encrypts the data folder and hands back the recovery key, once. */
  enableEncryption(passphrase: string): Promise<EnableEncryptionResult>;
  /** Decrypts everything back to plain files. Only while unlocked. */
  disableEncryption(): Promise<EncryptionResult>;
  unlock(passphrase: string): Promise<UnlockResult>;
  /** The way in when the passphrase is gone. Setting a new one is not optional. */
  unlockWithRecoveryKey(recoveryKey: string, newPassphrase: string): Promise<UnlockResult>;
  /** Re-wraps the same data key, so every snapshot ever taken stays readable. */
  changePassphrase(current: string, next: string): Promise<EncryptionResult>;
  /** Drop the key and the document from memory now. */
  lockNow(): Promise<void>;
  setAutoLockMinutes(minutes: number | null): Promise<EncryptionState>;
  /** Fires when the idle timer or the menu item locked the app. Returns its own unsubscribe. */
  onLocked(listener: () => void): () => void;

  /**
   * Just the second location's state, without the snapshot list.
   *
   * Separate from `getBackups` because that one opens and parses every file in
   * `backups/` to report what is in each — right for a panel someone has
   * deliberately navigated to, far too much for a banner that renders at every
   * launch.
   */
  getMirrorState(): Promise<MirrorState>;
  /** Folder-picking dialog for the second location. Null when dismissed. */
  chooseMirrorFolder(): Promise<string | null>;
  /** Point the mirror at a folder, or pass null to turn it off. */
  setMirrorFolder(dir: string | null): Promise<MirrorState>;
  /** Copy anything outstanding now, rather than waiting for the next snapshot. */
  syncMirrorNow(): Promise<MirrorState>;

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

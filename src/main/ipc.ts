/**
 * The main-process end of the bridge. Everything the renderer can ask for
 * arrives here, and nothing here trusts that it arrived from the preload.
 *
 * This is also where the document lives. There is exactly one copy of it in
 * memory, the renderer holds a copy it edits, and the revision counter is what
 * keeps the two honest — the same job the HTTP layer did, minus the HTTP.
 */

import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import type {
  BackupsState,
  CheckBackupsResult,
  DataLocation,
  EnableEncryptionResult,
  EncryptionFailure,
  EncryptionResult,
  EncryptionState,
  UnlockResult,
  ExportResult,
  ImportResult,
  LegacyInstall,
  MirrorState,
  RecoveryOffer,
  RelocateResult,
  RestoreResult,
  RetireResult,
  SaveResult,
  UpdateCheck,
  UpdateInstallResult,
  UpdateState,
} from "../shared/api.ts";
import { DATA_VERSION, type DataDoc } from "../shared/types.ts";
import type {
  AiState,
  CategoryReply,
  CategoryRequest,
  LlmResult,
  MemoryAdvice,
  ModelStatus,
  SummaryChunk,
  SummaryRequest,
} from "../shared/llm.ts";
import {
  aiState,
  downloadModel,
  modelStatus,
  pauseDownload,
  removeModel,
  setActiveModel,
  setAiEnabled,
} from "./llm/model.ts";
import { classify, memoryAdvice, shutdown as shutdownInference, summarize } from "./llm/service.ts";
import {
  backupsState,
  currentMirrorState,
  mirrorNow,
  mirrorSoon,
  recoveryOffer,
  restore,
  revealBackups,
  setMirrorDir,
} from "./backups.ts";
import { autoLockMinutes, lockAndTell, setAutoLockMinutes } from "./autolock.ts";
import { CryptoError } from "./crypto.ts";
import { relocateData } from "./datafolder.ts";
import { buildMenu } from "./menu.ts";
import {
  changePassphrase,
  disable as disableEncryption,
  enable as enableEncryption,
  EnableFailed,
  isEnabled,
  isUnlocked,
  unlock,
  unlockWithRecovery,
} from "./encryption.ts";
import { describeInstall, findInstall, importInstall, retireInstall } from "./legacy.ts";
import { canRelocate, dataDir, dataFile } from "./paths.ts";
import { isRendererUrl } from "./renderer.ts";
import { checkSnapshots, loadDoc, massDeletion, saveDoc } from "./storage.ts";
import { canSelfUpdate, installUpdate } from "./selfupdate.ts";
import { checkForUpdate, getAvailableUpdate } from "./updater.ts";

/** Null until the first successful read; see the `doc:get` handler. */
let doc: DataDoc | null = null;

/**
 * Reported by the renderer, read by the window on its way closed. Starts false:
 * nothing has been edited before the app has finished opening.
 */
let unsaved = false;

export function hasUnsavedChanges(): boolean {
  return unsaved;
}

/**
 * `contextIsolation` and `sandbox` keep page scripts out of the preload, but
 * the preload's channels are still reachable from whatever the renderer is
 * showing. Checking the sender's origin means a frame that is not this app —
 * a navigation that slipped past window.ts, an injected iframe — gets nothing.
 */
function fromRenderer(event: IpcMainInvokeEvent): boolean {
  try {
    const url = event.senderFrame?.url;
    return url !== undefined && isRendererUrl(url);
  } catch {
    // Reading `url` on a frame that has already gone throws.
    return false;
  }
}

function handle<A extends unknown[], R>(
  channel: string,
  handler: (...args: A) => R | Promise<R>,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromRenderer(event)) throw new Error(`Refused ${channel}: unrecognised sender`);
    return handler(...(args as A));
  });
}

/**
 * Shape check on the way in. The renderer is the only thing that sends
 * documents and it sends whole ones, so this is a guard against a bug rather
 * than against an attacker — but it is the last point at which a malformed
 * document can be stopped before it reaches the file everything depends on.
 */
function isDataDoc(candidate: unknown): candidate is DataDoc {
  if (typeof candidate !== "object" || candidate === null) return false;
  const d = candidate as DataDoc;
  return (
    d.version === DATA_VERSION &&
    typeof d.rev === "number" &&
    Array.isArray(d.categories) &&
    Array.isArray(d.students) &&
    Array.isArray(d.entries) &&
    // `!== null` is not pedantry: typeof null is "object", so without it a
    // document with null settings saves happily and then fails the stricter
    // check on the way back in at next launch — a file the app wrote and
    // cannot read.
    typeof d.settings === "object" &&
    d.settings !== null &&
    hasValidMappings(d)
  );
}

/**
 * The import mappings, if there are any, are a flat string-to-string object.
 *
 * Checked here rather than trusted because this is the one field the renderer
 * writes from parsed document text rather than from a form — the phrase comes
 * out of her Google Doc — and a shape that isn't this one would be written
 * straight into data.json and then read back forever. An array passes
 * `typeof === "object"`, hence the explicit rejection.
 */
function hasValidMappings(d: DataDoc): boolean {
  if (d.importMappings === undefined) return true;
  if (typeof d.importMappings !== "object" || d.importMappings === null) return false;
  if (Array.isArray(d.importMappings)) return false;
  return Object.values(d.importMappings).every((id) => typeof id === "string");
}

/**
 * Read lazily, so a data file that cannot be parsed becomes an error the
 * renderer can show and offer to retry, rather than a main process that dies
 * before there is a window to say so in. The old server had no such option: it
 * threw on startup and the browser tab just never loaded.
 */
function currentDoc(): DataDoc {
  if (doc) return doc;
  try {
    doc = loadDoc();
  } catch (error) {
    throw new Error(`Couldn't read ${dataFile()} — ${(error as Error).message}`, { cause: error });
  }
  return doc;
}

/**
 * No students and no entries — so an import cannot bury anything that took
 * work to produce. Categories and the clinician name are not consulted: they
 * exist in a brand-new document too, and an upgrade wants the old install's
 * versions of both anyway.
 */
function nothingRecordedYet(): boolean {
  const current = currentDoc();
  return current.students.length === 0 && current.entries.length === 0;
}

/** The window a dialog should hang off, so it opens as a sheet rather than free-floating. */
function dialogParent(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Carry the kind across the bridge rather than the exception.
 *
 * The renderer words a wrong passphrase, a mistyped recovery key and a damaged
 * keyfile quite differently, and recovering which happened by matching on a
 * message string is how those three end up sharing one wrong sentence.
 */
function failure(error: unknown): { error: string; kind: EncryptionFailure } {
  if (error instanceof CryptoError) return { error: error.message, kind: error.kind };
  return { error: describe(error), kind: "other" };
}

/**
 * How progress and streamed text reach open windows. Supplied by index.ts,
 * which is the only place in the app that talks to `webContents` — the modules
 * that produce the events know nothing about windows, exactly as autolock.ts
 * and updater.ts already do.
 */
export interface Broadcast {
  /**
   * One event for the whole of the AI settings — the switch, the chosen model,
   * and every catalogue entry's state. Sent as a single value because these are
   * not independent: a download finishing changes what "on" means, and two
   * events that could arrive in either order would let a panel render a state
   * that never existed.
   */
  aiState(state: AiState): void;
  summaryChunk(chunk: SummaryChunk): void;
}

export function registerIpc(broadcast: Broadcast): void {
  handle("doc:get", (): DataDoc => currentDoc());

  handle("doc:save", (candidate: unknown, confirmed: unknown): SaveResult => {
    /**
     * Read rather than refuse when the cache is empty. `legacy:import` drops it
     * deliberately, and a save already in flight when that happens used to come
     * back `retryable: true` to a renderer whose retry path only ever re-sends
     * the same document — five attempts that could not succeed, then a "Save
     * failed" whose Retry button ran the sixth. Reloading here turns that into
     * an ordinary conflict, which the renderer already knows how to report.
     */
    let current: DataDoc;
    try {
      current = currentDoc();
    } catch (error) {
      // The file is unreadable. Worth retrying — a volume that just went away
      // may come back — and the message names the path.
      return { error: (error as Error).message, retryable: true };
    }
    if (!isDataDoc(candidate)) return { error: "Malformed document", retryable: false };
    if (candidate.rev !== current.rev) return { conflict: true, currentRev: current.rev };

    /**
     * The app removes one entry at a time and has no "delete everything"
     * anywhere, so a document arriving with a fifth of the log missing did not
     * get that way by being edited. Refusing costs one dialog on a false alarm
     * and nothing at all the rest of the time; the document is still in the
     * window either way, so nothing is lost by asking.
     */
    if (confirmed !== true) {
      const losing = massDeletion(current, candidate);
      if (losing) return { confirmDeletion: losing };
    }

    const next: DataDoc = { ...candidate, rev: current.rev + 1 };
    try {
      // `current` becomes data.json.prev — the outgoing version, which bounds
      // the damage of a save that lands but shouldn't have to a single save.
      saveDoc(next, current);
    } catch (error) {
      // A write that failed must not advance the in-memory doc: leaving it
      // ahead of the file would make the next save a phantom conflict and lose
      // the renderer's edits to something it cannot resolve.
      console.error("Save failed:", error);
      return {
        error: `Could not write the data file: ${(error as Error).message}`,
        retryable: true,
      };
    }
    doc = next;
    // After the save has already succeeded, and never awaited. The second copy
    // must not be able to slow a save down or fail one.
    mirrorSoon();
    return { ok: true, rev: next.rev };
  });

  /* ---------- backups ---------- */

  handle("backup:offer", (): RecoveryOffer => recoveryOffer());

  handle("backup:list", (): BackupsState => backupsState());

  handle("backup:restore", (name: unknown): RestoreResult => {
    if (typeof name !== "string") return { error: "That isn't a backup Casebook can read." };
    /**
     * Null when the live file cannot be read, which is the whole reason this
     * exists — and the case where `restore` moves that file aside instead of
     * snapshotting it. Deliberately not `currentDoc()`, which throws.
     */
    let current: DataDoc | null = doc;
    if (!current) {
      try {
        current = loadDoc();
      } catch {
        current = null;
      }
    }
    const { result, doc: restored } = restore(name, current);
    if ("ok" in result) doc = restored;
    return result;
  });

  handle("backup:check", (): CheckBackupsResult => checkSnapshots());

  handle("backup:reveal", (): void => {
    revealBackups();
  });

  /* ---------- the passphrase ---------- */

  handle(
    "encryption:state",
    (): EncryptionState => ({
      enabled: isEnabled(),
      unlocked: isUnlocked(),
      autoLockMinutes: autoLockMinutes(),
    }),
  );

  handle("encryption:unlock", async (passphrase: unknown): Promise<UnlockResult> => {
    if (typeof passphrase !== "string") return { error: "Enter your passphrase.", kind: "other" };
    try {
      await unlock(passphrase);
    } catch (error) {
      return failure(error);
    }
    // The cached document was read — or failed to be read — while locked.
    doc = null;
    // "Lock Now" is disabled while there is nothing to lock, and its enabled
    // state is baked into the built menu rather than evaluated on open.
    buildMenu();
    return { ok: true };
  });

  handle(
    "encryption:recover",
    async (recoveryKey: unknown, nextPassphrase: unknown): Promise<UnlockResult> => {
      if (typeof recoveryKey !== "string" || typeof nextPassphrase !== "string") {
        return { error: "Enter your recovery key and a new passphrase.", kind: "other" };
      }
      if (nextPassphrase.length === 0) {
        return { error: "Choose a new passphrase.", kind: "other" };
      }
      try {
        await unlockWithRecovery(recoveryKey, nextPassphrase);
      } catch (error) {
        return failure(error);
      }
      doc = null;
      buildMenu();
      return { ok: true };
    },
  );

  handle("encryption:enable", async (passphrase: unknown): Promise<EnableEncryptionResult> => {
    if (typeof passphrase !== "string" || passphrase.length === 0) {
      return { error: "Choose a passphrase." };
    }
    try {
      const recoveryKey = await enableEncryption(passphrase);
      // Everything on disk moved to `.enc`; the cached copy's provenance is
      // fine but the next read has to go through the new codec.
      doc = null;
      buildMenu();
      mirrorSoon();
      return { ok: true, recoveryKey };
    } catch (error) {
      // The state is not necessarily unchanged, so the cached document and the
      // menu are rebuilt on the way out of a failure too.
      doc = null;
      buildMenu();
      const failed = `Casebook couldn't turn on the passphrase — ${describe(error)}`;
      // Only ever set when encryption was left on and the sheet is still the
      // one copy of the way back in. See EnableFailed.
      const stranded = error instanceof EnableFailed ? error.recoveryKey : null;
      return stranded ? { error: failed, recoveryKey: stranded } : { error: failed };
    }
  });

  handle("encryption:disable", (): EncryptionResult => {
    try {
      disableEncryption();
      doc = null;
      buildMenu();
      mirrorSoon();
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  });

  handle(
    "encryption:change",
    async (current: unknown, next: unknown): Promise<EncryptionResult> => {
      if (typeof current !== "string" || typeof next !== "string" || next.length === 0) {
        return { error: "Enter your current passphrase and a new one.", kind: "other" };
      }
      try {
        await changePassphrase(current, next);
        mirrorSoon();
        return { ok: true };
      } catch (error) {
        return failure(error);
      }
    },
  );

  handle("encryption:lock", (): void => {
    lockAndTell();
    doc = null;
    buildMenu();
  });

  handle("encryption:auto-lock", (minutes: unknown): EncryptionState => {
    const value =
      minutes === null || (typeof minutes === "number" && Number.isInteger(minutes) && minutes > 0)
        ? minutes
        : null;
    setAutoLockMinutes(value);
    return { enabled: isEnabled(), unlocked: isUnlocked(), autoLockMinutes: autoLockMinutes() };
  });

  /* ---------- the second location ---------- */

  handle("mirror:state", (): MirrorState => currentMirrorState());

  handle("mirror:choose", async (): Promise<string | null> => {
    const window = dialogParent();
    const options = {
      title: "Choose where to keep a second copy",
      message: "Pick a folder on an external drive, a network share, or one a cloud service syncs.",
      buttonLabel: "Keep copies here",
      properties: ["openDirectory" as const, "createDirectory" as const],
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle("mirror:set", (target: unknown): Promise<MirrorState> => {
    if (target !== null && typeof target !== "string") {
      return Promise.resolve(currentMirrorState());
    }
    return setMirrorDir(target);
  });

  handle("mirror:sync", (): Promise<MirrorState> => mirrorNow());

  handle("doc:set-unsaved", (pending: unknown): void => {
    unsaved = pending === true;
  });

  /**
   * Exports go through a real save dialog. The renderer used to make a blob and
   * click an invisible anchor at it, which is a browser trick with no meaning
   * here — and the dialog is better anyway: she picks where the file lands
   * instead of hunting through Downloads for it afterwards.
   */
  handle("file:export", async (name: unknown, contents: unknown): Promise<ExportResult> => {
    if (typeof name !== "string" || typeof contents !== "string") {
      return { error: "Malformed export request" };
    }
    const extension = extname(name).slice(1);
    const window = dialogParent();
    const options = {
      defaultPath: join(app.getPath("downloads"), name),
      filters: extension ? [{ name: extension.toUpperCase(), extensions: [extension] }] : undefined,
      /**
       * Said at the moment it becomes true, rather than only in Settings. An
       * export is a deliberate copy of student records in plain text, and
       * someone who has just turned on a passphrase would reasonably assume it
       * travelled with the file.
       */
      message: isEnabled()
        ? "This file is saved without the passphrase — anyone who opens it can read it."
        : undefined,
    };

    // Attached to the window as a sheet where there is one to attach it to.
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { saved: false };

    try {
      writeFileSync(result.filePath, contents);
    } catch (error) {
      return { error: (error as Error).message };
    }
    return { saved: true, path: result.filePath };
  });

  /* ---------- where the data lives ---------- */

  handle("folder:get", (): DataLocation => ({ dir: dataDir(), relocatable: canRelocate() }));

  handle("folder:reveal", (): void => {
    // The folder is created on demand, and "Show in Finder" is a perfectly
    // ordinary reason for it to come into existence.
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    void shell.openPath(dir);
  });

  handle("folder:choose", async (): Promise<string | null> => {
    const window = dialogParent();
    const options = {
      title: "Choose a folder for your Casebook data",
      buttonLabel: "Use this folder",
      defaultPath: dataDir(),
      properties: ["openDirectory" as const, "createDirectory" as const],
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle("folder:relocate", (target: unknown): RelocateResult => {
    if (!canRelocate()) {
      return { error: "A development build always keeps its data in the repository." };
    }
    if (typeof target !== "string") return { error: "That isn't a folder Casebook can use." };
    return relocateData(target);
  });

  /* ---------- the Casebook that came before ---------- */

  /**
   * Offered only while there is nothing here to lose. Importing over a document
   * she has been using would be a data-loss bug wearing a helpful face.
   */
  handle("legacy:find", (): LegacyInstall | null => (nothingRecordedYet() ? findInstall() : null));

  handle("legacy:choose", async (): Promise<LegacyInstall | null> => {
    const window = dialogParent();
    const options = {
      title: "Find your old Casebook",
      message: "Choose the old Casebook app, or the folder its data.json is in.",
      buttonLabel: "Use this",
      properties: ["openFile" as const, "openDirectory" as const],
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    const picked = result.canceled ? undefined : result.filePaths[0];
    if (!picked) return null;

    // Pointing at the executable is the intuitive thing to do, and the data
    // sits beside it — so accept either and work out which this was.
    let dir = picked;
    try {
      if (!statSync(picked).isDirectory()) dir = dirname(picked);
    } catch {
      return null;
    }

    const found = describeInstall(dir);
    if (!found) {
      // Said here rather than handed back as an error, because "null" already
      // means "she changed her mind" and the two should not look the same.
      const message = {
        type: "info" as const,
        message: "No Casebook data there.",
        detail: `${dir} doesn't contain a data.json. Look for the folder holding the old Casebook app.`,
      };
      await (window ? dialog.showMessageBox(window, message) : dialog.showMessageBox(message));
      return null;
    }
    return found;
  });

  handle("legacy:import", (dir: unknown): ImportResult => {
    if (typeof dir !== "string") return { error: "That isn't a folder Casebook can read." };
    if (!nothingRecordedYet()) {
      return { error: "Casebook already has entries in it, so nothing was imported." };
    }
    const result = importInstall(dir);
    // Unconditionally, including on failure. Dropping the cached copy makes the
    // next read come off the file rather than out of memory, and after an
    // import that got partway there is no longer any reason to believe the two
    // agree — holding a stale in-memory document whose rev matches the
    // renderer's is precisely how the next save overwrites what was imported.
    doc = null;
    return result;
  });

  /* ---------- updates ---------- */

  handle(
    "update:state",
    (): UpdateState => ({
      version: app.getVersion(),
      available: getAvailableUpdate(),
      selfUpdate: canSelfUpdate(),
    }),
  );

  handle("update:check", (): Promise<UpdateCheck> => checkForUpdate());

  handle("update:install", (): Promise<UpdateInstallResult> => {
    // The renderer names nothing here. What gets downloaded is whatever the
    // main process's own check found, at the URL GitHub gave it — a channel
    // that accepted a URL would be a channel for installing anything.
    const info = getAvailableUpdate();
    if (!info) return Promise.resolve({ error: "There's no update to install." });
    return installUpdate(info);
  });

  handle("update:open-release", async (): Promise<void> => {
    const info = getAvailableUpdate();
    // The URL is one this process built from GitHub's own response, never one
    // the renderer supplied — openExternal hands a string to the OS, and the
    // renderer is not allowed to choose what that string is.
    await shell.openExternal(
      info?.releaseUrl ?? "https://github.com/EngineeredDev/casebook/releases/latest",
    );
  });

  /* ---------- AI features ---------- */

  handle("llm:status", (): ModelStatus => modelStatus());

  handle("llm:state", (): AiState => aiState());

  handle("llm:set-enabled", (enabled: unknown): AiState => {
    setAiEnabled(enabled === true);
    // Off means off now, not after the idle timer. She switched it off to stop
    // it doing something, and a host that keeps its gigabytes for another
    // minute is the app disagreeing with her about what the switch does.
    if (enabled !== true) shutdownInference();
    const state = aiState();
    broadcast.aiState(state);
    return state;
  });

  handle("llm:select-model", (id: unknown): AiState => {
    if (typeof id !== "string") return aiState();
    setActiveModel(id);
    // The running host has the old weights loaded. service.ts would notice on
    // the next job, but there is no reason to keep several gigabytes of a model
    // she has stopped using.
    shutdownInference();
    const state = aiState();
    broadcast.aiState(state);
    return state;
  });

  handle("llm:download", (id: unknown): AiState => {
    if (typeof id !== "string") return aiState();
    // Deliberately not awaited: gigabytes take minutes and the renderer needs
    // an answer now. Progress and completion both arrive as broadcasts.
    void downloadModel(id, broadcast.aiState);
    return aiState();
  });

  handle("llm:pause-download", (): AiState => {
    pauseDownload();
    return aiState();
  });

  handle("llm:remove", async (id: unknown): Promise<AiState> => {
    if (typeof id !== "string") return aiState();
    // Stop the process before deleting what it has open. Removing a model out
    // from under a running load is how you get a crash instead of a tidy-up.
    shutdownInference();
    await removeModel(id);
    const state = aiState();
    broadcast.aiState(state);
    return state;
  });

  handle("llm:memory", (): MemoryAdvice => memoryAdvice());

  handle("llm:category", (request: unknown): Promise<LlmResult<CategoryReply>> => {
    if (!isCategoryRequest(request)) {
      return Promise.resolve({ unavailable: "crashed", message: "Malformed request." });
    }
    return classify(request);
  });

  handle("llm:summary", (request: unknown): Promise<LlmResult<string>> => {
    if (!isSummaryRequest(request)) {
      return Promise.resolve({ unavailable: "crashed", message: "Malformed request." });
    }
    // The id the renderer minted, put back on every chunk on its way out. The
    // host's own job id never leaves this process, and would mean nothing to a
    // listener anyway.
    return summarize(request, (text) =>
      broadcast.summaryChunk({ requestId: request.requestId, text }),
    );
  });

  handle("legacy:retire", (dir: unknown): RetireResult => {
    if (typeof dir !== "string") return { error: "That isn't a folder Casebook can read." };
    // retireInstall re-describes the folder itself before touching anything, so
    // the "is this still an old install" precondition is enforced next to the
    // deletes rather than trusted from here — or from the renderer.
    return retireInstall(dir);
  });
}

/**
 * Shape checks for the two requests that carry structured data from the
 * renderer. Lighter than `isDataDoc` because nothing here is written to disk —
 * the cost of a malformed one is a wasted inference, not a damaged file — but
 * present because the alternative is handing unvalidated shapes to a native
 * library in another process.
 */
function isCategoryRequest(value: unknown): value is CategoryRequest {
  if (typeof value !== "object" || value === null) return false;
  const r = value as CategoryRequest;
  return (
    (r.kind === "classify-entry" || r.kind === "suggest-mapping") &&
    Array.isArray(r.samples) &&
    r.samples.every((s) => typeof s === "string") &&
    Array.isArray(r.categories) &&
    r.categories.every((c) => typeof c?.id === "string" && typeof c?.name === "string")
  );
}

function isSummaryRequest(value: unknown): value is SummaryRequest {
  if (typeof value !== "object" || value === null) return false;
  const r = value as SummaryRequest;
  return (
    // Required, not optional: an untagged request would stream chunks nothing
    // could claim, and the summary would silently never appear.
    typeof r.requestId === "string" &&
    r.requestId.length > 0 &&
    typeof r.studentName === "string" &&
    typeof r.windowLabel === "string" &&
    Array.isArray(r.notes) &&
    r.notes.every((n) => typeof n?.date === "string" && typeof n?.text === "string")
  );
}

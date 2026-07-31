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
  DataLocation,
  ExportResult,
  ImportResult,
  LegacyInstall,
  RelocateResult,
  RetireResult,
  SaveResult,
  UpdateCheck,
  UpdateInstallResult,
  UpdateState,
} from "../shared/api.ts";
import { DATA_VERSION, type DataDoc } from "../shared/types.ts";
import { relocateData } from "./datafolder.ts";
import { describeInstall, findInstall, importInstall, retireInstall } from "./legacy.ts";
import { canRelocate, dataDir, dataFile } from "./paths.ts";
import { isRendererUrl } from "./renderer.ts";
import { backupIfNeeded, loadDoc, saveDoc } from "./storage.ts";
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
    typeof d.settings === "object"
  );
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

export function registerIpc(): void {
  handle("doc:get", (): DataDoc => currentDoc());

  handle("doc:save", (candidate: unknown): SaveResult => {
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

    const next: DataDoc = { ...candidate, rev: current.rev + 1 };
    try {
      backupIfNeeded();
      saveDoc(next);
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
    return { ok: true, rev: next.rev };
  });

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

  handle("legacy:retire", (dir: unknown): RetireResult => {
    if (typeof dir !== "string") return { error: "That isn't a folder Casebook can read." };
    // retireInstall re-describes the folder itself before touching anything, so
    // the "is this still an old install" precondition is enforced next to the
    // deletes rather than trusted from here — or from the renderer.
    return retireInstall(dir);
  });
}

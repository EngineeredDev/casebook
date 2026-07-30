/**
 * The main-process end of the bridge. Everything the renderer can ask for
 * arrives here, and nothing here trusts that it arrived from the preload.
 *
 * This is also where the document lives. There is exactly one copy of it in
 * memory, the renderer holds a copy it edits, and the revision counter is what
 * keeps the two honest — the same job the HTTP layer did, minus the HTTP.
 */

import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { ExportResult, SaveResult } from "../shared/api.ts";
import { DATA_VERSION, type DataDoc } from "../shared/types.ts";
import { dataFile } from "./paths.ts";
import { RENDERER_ORIGIN } from "./renderer.ts";
import { backupIfNeeded, loadDoc, saveDoc } from "./storage.ts";

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
    return url !== undefined && URL.parse(url)?.origin === RENDERER_ORIGIN;
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

export function registerIpc(): void {
  /**
   * Read lazily, so a data file that cannot be parsed becomes an error the
   * renderer can show and offer to retry, rather than a main process that dies
   * before there is a window to say so in. The old server had no such option:
   * it threw on startup and the browser tab just never loaded.
   */
  handle("doc:get", (): DataDoc => {
    if (doc) return doc;
    try {
      doc = loadDoc();
    } catch (error) {
      throw new Error(`Couldn't read ${dataFile()} — ${(error as Error).message}`, {
        cause: error,
      });
    }
    return doc;
  });

  handle("doc:save", (candidate: unknown): SaveResult => {
    if (!doc) return { error: "Casebook hasn't finished opening your data.", retryable: true };
    if (!isDataDoc(candidate)) return { error: "Malformed document", retryable: false };
    if (candidate.rev !== doc.rev) return { conflict: true, serverRev: doc.rev };

    const next: DataDoc = { ...candidate, rev: doc.rev + 1 };
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
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
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
}

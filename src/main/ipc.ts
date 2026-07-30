/**
 * The main-process end of the bridge. Everything the renderer can ask for
 * arrives here, and nothing here trusts that it arrived from the preload.
 *
 * The document itself is still in memory only — main/storage.ts and the disk
 * arrive with the data layer.
 */

import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { SaveResult } from "../shared/api.ts";
import { DATA_VERSION, emptyDoc, type DataDoc } from "../shared/types.ts";
import { RENDERER_ORIGIN } from "./renderer.ts";

let doc: DataDoc = emptyDoc();

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
  handle("doc:get", (): DataDoc => doc);

  handle("doc:save", (candidate: unknown): SaveResult => {
    if (!isDataDoc(candidate)) return { error: "Malformed document", retryable: false };
    if (candidate.rev !== doc.rev) return { conflict: true, serverRev: doc.rev };
    doc = { ...candidate, rev: doc.rev + 1 };
    return { ok: true, rev: doc.rev };
  });

  handle("doc:set-unsaved", (pending: unknown): void => {
    unsaved = pending === true;
  });
}

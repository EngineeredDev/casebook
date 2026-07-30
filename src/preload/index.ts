/**
 * The only bridge between the renderer and everything that can touch the disk.
 *
 * It runs sandboxed, which is why this file is CommonJS and why it is
 * deliberately dull: no logic, no filesystem, nothing but named channels. Every
 * function here is one the renderer is allowed to call; the main process still
 * checks who is calling (see main/ipc.ts) rather than trusting that this file
 * is the only caller.
 */

import { contextBridge, ipcRenderer } from "electron";
import type { CasebookApi } from "../shared/api.ts";

const api: CasebookApi = {
  getDoc: () => ipcRenderer.invoke("doc:get"),
  saveDoc: (doc) => ipcRenderer.invoke("doc:save", doc),
  setUnsaved: (unsaved) => ipcRenderer.invoke("doc:set-unsaved", unsaved),
  exportFile: (name, contents) => ipcRenderer.invoke("file:export", name, contents),
};

contextBridge.exposeInMainWorld("casebook", api);

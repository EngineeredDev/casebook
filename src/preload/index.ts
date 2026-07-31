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
import type { CasebookApi, UpdateInfo } from "../shared/api.ts";
import type { AiState, ModelStatus } from "../shared/llm.ts";

const api: CasebookApi = {
  getDoc: () => ipcRenderer.invoke("doc:get"),
  saveDoc: (doc, confirmed) => ipcRenderer.invoke("doc:save", doc, confirmed === true),
  setUnsaved: (unsaved) => ipcRenderer.invoke("doc:set-unsaved", unsaved),
  exportFile: (name, contents) => ipcRenderer.invoke("file:export", name, contents),

  getRecoveryOffer: () => ipcRenderer.invoke("backup:offer"),
  getBackups: () => ipcRenderer.invoke("backup:list"),
  restoreSnapshot: (name) => ipcRenderer.invoke("backup:restore", name),
  checkBackups: () => ipcRenderer.invoke("backup:check"),
  revealBackupsFolder: () => ipcRenderer.invoke("backup:reveal"),

  getEncryptionState: () => ipcRenderer.invoke("encryption:state"),
  enableEncryption: (passphrase) => ipcRenderer.invoke("encryption:enable", passphrase),
  disableEncryption: () => ipcRenderer.invoke("encryption:disable"),
  unlock: (passphrase) => ipcRenderer.invoke("encryption:unlock", passphrase),
  unlockWithRecoveryKey: (recoveryKey, newPassphrase) =>
    ipcRenderer.invoke("encryption:recover", recoveryKey, newPassphrase),
  changePassphrase: (current, next) => ipcRenderer.invoke("encryption:change", current, next),
  lockNow: () => ipcRenderer.invoke("encryption:lock"),
  setAutoLockMinutes: (minutes) => ipcRenderer.invoke("encryption:auto-lock", minutes),
  onLocked: (listener: () => void) => {
    const forward = () => listener();
    ipcRenderer.on("encryption:locked", forward);
    return () => ipcRenderer.removeListener("encryption:locked", forward);
  },

  getMirrorState: () => ipcRenderer.invoke("mirror:state"),
  chooseMirrorFolder: () => ipcRenderer.invoke("mirror:choose"),
  setMirrorFolder: (dir) => ipcRenderer.invoke("mirror:set", dir),
  syncMirrorNow: () => ipcRenderer.invoke("mirror:sync"),

  getDataLocation: () => ipcRenderer.invoke("folder:get"),
  revealDataFolder: () => ipcRenderer.invoke("folder:reveal"),
  chooseDataFolder: () => ipcRenderer.invoke("folder:choose"),
  relocateData: (target) => ipcRenderer.invoke("folder:relocate", target),

  findLegacyInstall: () => ipcRenderer.invoke("legacy:find"),
  chooseLegacyInstall: () => ipcRenderer.invoke("legacy:choose"),
  importLegacyData: (dir) => ipcRenderer.invoke("legacy:import", dir),
  retireLegacyInstall: (dir) => ipcRenderer.invoke("legacy:retire", dir),

  getUpdateState: () => ipcRenderer.invoke("update:state"),
  checkForUpdate: () => ipcRenderer.invoke("update:check"),
  openReleasePage: () => ipcRenderer.invoke("update:open-release"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  onUpdateAvailable: (listener: (info: UpdateInfo) => void) => {
    // The event object never crosses the bridge — only the payload. Handing a
    // renderer an IpcRendererEvent would hand it `sender`, and with it a way
    // back into the preload's privileges.
    const forward = (_event: unknown, info: UpdateInfo) => listener(info);
    ipcRenderer.on("update:available", forward);
    return () => ipcRenderer.removeListener("update:available", forward);
  },

  getModelStatus: () => ipcRenderer.invoke("llm:status"),
  getAiState: () => ipcRenderer.invoke("llm:state"),
  setAiEnabled: (enabled) => ipcRenderer.invoke("llm:set-enabled", enabled),
  selectModel: (id) => ipcRenderer.invoke("llm:select-model", id),
  startModelDownload: (id) => ipcRenderer.invoke("llm:download", id),
  pauseModelDownload: () => ipcRenderer.invoke("llm:pause-download"),
  removeModel: (id) => ipcRenderer.invoke("llm:remove", id),
  getMemoryAdvice: () => ipcRenderer.invoke("llm:memory"),
  suggestCategory: (request) => ipcRenderer.invoke("llm:category", request),
  summarizeNotes: (request) => ipcRenderer.invoke("llm:summary", request),

  onAiState: (listener: (state: AiState) => void) => {
    const forward = (_event: unknown, state: AiState) => listener(state);
    ipcRenderer.on("llm:ai-state", forward);
    return () => ipcRenderer.removeListener("llm:ai-state", forward);
  },

  /**
   * The same event, narrowed to the one field the rest of the app cares about.
   * A field pick is as much logic as this file is allowed, and it is worth it:
   * the alternative is a second broadcast channel carrying a value derived from
   * the first, which can then be stale relative to it.
   */
  onModelStatus: (listener: (status: ModelStatus) => void) => {
    const forward = (_event: unknown, state: AiState) => listener(state.active);
    ipcRenderer.on("llm:ai-state", forward);
    return () => ipcRenderer.removeListener("llm:ai-state", forward);
  },

  onSummaryChunk: (listener: (chunk: string) => void) => {
    const forward = (_event: unknown, chunk: string) => listener(chunk);
    ipcRenderer.on("llm:summary-chunk", forward);
    return () => ipcRenderer.removeListener("llm:summary-chunk", forward);
  },
};

contextBridge.exposeInMainWorld("casebook", api);

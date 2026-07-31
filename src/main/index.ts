import { app, BrowserWindow, session } from "electron";
import { startAutoLock } from "./autolock.ts";
import { mirrorSoon } from "./backups.ts";
import { snapshotOnQuit } from "./storage.ts";
import { hasUnsavedChanges, registerIpc } from "./ipc.ts";
import { buildMenu } from "./menu.ts";
import { registerAppScheme, serveRenderer } from "./renderer.ts";
import { settlePendingUpdate } from "./selfupdate.ts";
import { startUpdateChecks } from "./updater.ts";
import { shutdown as shutdownInference } from "./llm/service.ts";
import { createWindow } from "./window.ts";

/**
 * Fixed once and never changed: `userData` is derived from it, so a later edit
 * would silently orphan every setting stored under the old name.
 */
app.setName("Casebook");

// Has to happen before the app is ready — see renderer.ts.
registerAppScheme();

/**
 * One Casebook at a time. Two copies would each hold the whole document in
 * memory and write the same file from their own stale copy of it, which is how
 * a day's entries disappear. The port-probing this replaces did the same job
 * for the same reason, less reliably.
 */
if (app.requestSingleInstanceLock()) {
  app.on("second-instance", focusWindow);
  void app.whenReady().then(start);
} else {
  app.quit();
}

function start(): void {
  // Nothing in this app needs a camera, a microphone, notifications or a
  // location, so no request for one can even reach a prompt.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, grant) =>
    grant(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);

  app.setAboutPanelOptions({
    applicationName: "Casebook",
    applicationVersion: app.getVersion(),
  });

  // Reaching a clean start is the only evidence that a swapped-in update
  // actually works, and the only thing that authorises deleting the bundle it
  // replaced. Before any window, so a crash later still counts as "it started".
  settlePendingUpdate();

  serveRenderer();
  registerIpc({
    /**
     * The only place `webContents` is touched for the AI features, matching how
     * updates and locking already work: the modules that produce these events
     * know nothing about windows.
     */
    modelStatus: (status) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send("llm:model-status", status);
      }
    },
    summaryChunk: (chunk) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send("llm:summary-chunk", chunk);
      }
    },
  });
  buildMenu();
  createWindow();

  // Clicking the Dock icon with no window open.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Tell whatever window is open. Settings asks for itself when it mounts, so
  // this only has to cover a check that finishes while she is already looking
  // at something else.
  startUpdateChecks((info) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("update:available", info);
    }
  });

  // Catch the second location up on whatever it missed — a drive that was
  // unplugged all week, or snapshots taken while it was.
  mirrorSoon();

  // The window has the document in memory, so locking the main process without
  // telling it would protect the files and leave the student names on screen.
  startAutoLock({
    onLocked: () => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send("encryption:locked");
      }
    },
    pendingEdits: hasUnsavedChanges,
  });
}

/**
 * One last snapshot on the way out, so quitting at ten past never costs the ten
 * minutes since the last one. Synchronous and on `will-quit`, which is the last
 * moment the app is still able to write anything at all.
 */
/**
 * The inference process must not outlive the app. It is a child utilityProcess
 * so Electron would take it down anyway, but doing it here means the 3.5 GB it
 * may be holding is released while the app is closing rather than as part of
 * whatever the OS gets round to.
 */
app.on("before-quit", () => {
  shutdownInference();
});

app.on("will-quit", () => {
  snapshotOnQuit();
});

/** Opening the app again while it is already running just brings it forward. */
function focusWindow(): void {
  const [window] = BrowserWindow.getAllWindows();
  if (!window) {
    createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

app.on("window-all-closed", () => {
  // Deliberately does nothing. Without a listener Electron quits with the last
  // window; on macOS an app is expected to stay in the Dock, where clicking it
  // opens a window again. Cmd-Q is what quits.
});

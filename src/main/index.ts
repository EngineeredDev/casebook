import { app, BrowserWindow, session } from "electron";
import { registerIpc } from "./ipc.ts";
import { buildMenu } from "./menu.ts";
import { registerAppScheme, serveRenderer } from "./renderer.ts";
import { startUpdateChecks } from "./updater.ts";
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

  serveRenderer();
  registerIpc();
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
}

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

import { app, BrowserWindow, dialog, nativeTheme, shell } from "electron";
import { join } from "node:path";
import { hasUnsavedChanges } from "./ipc.ts";
import { RENDERER_ORIGIN, RENDERER_URL } from "./renderer.ts";

/**
 * Mantine's body background in each scheme. The window is painted with one of
 * these before the renderer exists, so the first frame is already the right
 * color rather than a white rectangle that turns dark a moment later.
 *
 * `nativeTheme` is the best guess available here: the actual choice lives in
 * the renderer's localStorage, which the main process cannot read. Someone
 * running the app against the system preference — nearly everyone — gets it
 * right, and the window stays hidden until first paint either way.
 */
const BODY_LIGHT = "#ffffff";
const BODY_DARK = "#242424";

/** Schemes a link in a clinical note may plausibly use, and nothing else. */
const EXTERNAL_SCHEMES = new Set(["https:", "http:", "mailto:"]);

/**
 * Whether the window is closing because the app is quitting, which changes what
 * confirming the close should do. Registered once here rather than per window,
 * so reopening from the Dock doesn't stack listeners.
 */
let quitting = false;
app.on("before-quit", () => {
  quitting = true;
});

/**
 * Hands a URL to the real browser, or drops it. Anything that reaches here came
 * from page content — a link typed into a note — so the scheme is checked
 * before `shell.openExternal`, which will otherwise happily launch a `file:`
 * path or a registered custom scheme belonging to some other application.
 */
function openExternal(url: string): void {
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    return;
  }
  if (EXTERNAL_SCHEMES.has(scheme)) void shell.openExternal(url);
}

export function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 940,
    minHeight: 620,
    title: "Casebook",
    backgroundColor: nativeTheme.shouldUseDarkColors ? BODY_DARK : BODY_LIGHT,
    // Shown once the renderer has painted, so opening the app is one step from
    // nothing to the app rather than two through an empty frame.
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      // Electron's defaults, restated because they are the entire security
      // model of this app now: the renderer gets no Node, no shared globals
      // with the preload, and runs in Chromium's sandbox.
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });

  window.once("ready-to-show", () => window.show());

  // Nothing in this app opens a second window. A target=_blank in a note goes
  // to the browser instead.
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });

  // The router navigates with pushState, which never reaches here. A real
  // navigation therefore means a link was followed — and the only place it may
  // lead is back into the app itself.
  window.webContents.on("will-navigate", (event, url) => {
    if (URL.parse(url)?.origin === RENDERER_ORIGIN) return;
    event.preventDefault();
    openExternal(url);
  });

  guardClose(window);

  void window.loadURL(RENDERER_URL);
  return window;
}

/**
 * Saves are debounced and can be retrying in the background, so closing the
 * window is occasionally the one action that loses work. Asking costs a click
 * on the rare occasion it fires and nothing at all the rest of the time —
 * `hasUnsavedChanges()` is false within half a second of the last edit.
 */
function guardClose(window: BrowserWindow): void {
  let confirmed = false;
  window.on("close", (event) => {
    if (confirmed || !hasUnsavedChanges()) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(window, {
      type: "warning",
      buttons: ["Close anyway", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: "Casebook hasn't finished saving.",
      detail: "Some recent changes may not be written to disk yet.",
    });
    if (choice !== 0) {
      quitting = false;
      return;
    }
    confirmed = true;
    // Cancelling the close also cancelled the quit that asked for it, so
    // closing the window now would leave the app sitting in the Dock with
    // nothing open — Cmd-Q would have to be pressed twice.
    if (quitting) app.quit();
    else window.close();
  });
}

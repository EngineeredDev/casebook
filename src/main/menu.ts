import { app, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { reloadWindow } from "./window.ts";

const REPO_URL = "https://github.com/EngineeredDev/casebook";

/**
 * The macOS menu bar. Spelled out rather than assembled from `role: "appMenu"`
 * and friends so there is somewhere obvious to hang app-specific items as they
 * arrive; the individual roles still carry the standard labels, shortcuts and
 * behavior, which is the part not worth reimplementing.
 */
export function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        // Not `role: "reload"`, which discards unsaved edits without asking.
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: reloadWindow },
        // Kept in the shipped build on purpose: it is the only way to see what
        // went wrong on a machine that isn't this one.
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Casebook on GitHub",
          click: () => void shell.openExternal(REPO_URL),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

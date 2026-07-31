/**
 * The `electron` module, as far as a test is concerned.
 *
 * Everything in src/main reaches electron for one thing before it can do
 * anything else: where this app is allowed to put files. The alternative to
 * this file is threading a filesystem root through every function that writes —
 * a parameter existing only to serve the tests, on exactly the code paths where
 * the real argument had better be the real one. So Vitest aliases the whole
 * module here instead (see vitest.config.ts) and a test says where the app
 * lives, without src/main knowing tests exist.
 *
 * Only the surface tests actually reach is implemented. Everything else throws
 * rather than returning a plausible-looking nothing: a test that wanders into
 * territory this stub doesn't cover should fail where it wandered, not three
 * assertions later on a value that was never real.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

interface State {
  /** What `dataDir()` resolves to in a development build. */
  appPath: string;
  /** Holds config.json, and nothing this app writes for the user. */
  userData: string;
  downloads: string;
  home: string;
  /**
   * False by default, because that is the branch pinning `dataDir()` to the app
   * path, which needs no config file to be meaningful. Tests about relocation —
   * the only feature gated on being packaged — set it true.
   */
  packaged: boolean;
}

/**
 * Kept on `globalThis` rather than in a module-level variable, and the reason is
 * specific: `config.ts` memoizes what it read, so tests that change the config
 * have to call `vi.resetModules()` — which reloads *this* file too. State held
 * here would be reset alongside it, silently pointing the next import back at
 * the placeholders below. On the global it outlives the module registry, which
 * is exactly the lifetime it wants.
 */
const STATE = Symbol.for("casebook.test.electron");

function state(): State {
  const globals = globalThis as Record<symbol, State | undefined>;
  return (globals[STATE] ??= placeholders());
}

function placeholders(): State {
  // Deliberately somewhere that does not exist. A test that forgot to call
  // `setAppDirs` gets ENOENT on the first write rather than quietly creating a
  // Casebook folder in whoever's home directory ran the suite.
  return { ...dirsUnder(join(tmpdir(), "casebook-unconfigured")), packaged: false };
}

function dirsUnder(root: string): Omit<State, "packaged"> {
  return {
    appPath: join(root, "app"),
    userData: join(root, "userData"),
    downloads: join(root, "downloads"),
    home: root,
  };
}

/** Point the stub at a real temporary tree. */
export function setAppDirs(root: string, packaged = false): void {
  Object.assign(state(), dirsUnder(root), { packaged });
}

/** Undo `setAppDirs`, so one test's leftovers can't reach the next. */
export function resetAppDirs(): void {
  Object.assign(state(), placeholders());
}

export const app = {
  get isPackaged(): boolean {
    return state().packaged;
  },
  name: "Casebook",

  getPath(name: string): string {
    switch (name) {
      case "userData":
        return state().userData;
      case "downloads":
        return state().downloads;
      case "home":
        return state().home;
      case "temp":
        return tmpdir();
      default:
        throw new Error(`electron stub: no path named "${name}"`);
    }
  },

  getAppPath(): string {
    return state().appPath;
  },

  getVersion(): string {
    return "0.0.0-test";
  },

  setName(): void {},
  setAboutPanelOptions(): void {},

  /**
   * Storage code registers no listeners, but `window.ts` attaches a
   * `before-quit` handler at import time. Swallowing it is enough — nothing
   * under test emits app events.
   */
  on(): void {},
};

function unavailable(what: string): never {
  throw new Error(
    `electron stub: ${what} is not implemented. ` +
      `If a test needs it, add it here rather than reaching for the real module.`,
  );
}

export const dialog = {
  showMessageBox: () => unavailable("dialog.showMessageBox"),
  showMessageBoxSync: () => unavailable("dialog.showMessageBoxSync"),
  showOpenDialog: () => unavailable("dialog.showOpenDialog"),
  showSaveDialog: () => unavailable("dialog.showSaveDialog"),
};

export const ipcMain = {
  handle: () => unavailable("ipcMain.handle"),
};

export const shell = {
  openPath: () => unavailable("shell.openPath"),
  openExternal: () => unavailable("shell.openExternal"),
};

export const BrowserWindow = {
  getAllWindows: (): unknown[] => [],
  getFocusedWindow: (): unknown => null,
};

export const Menu = {
  buildFromTemplate: () => unavailable("Menu.buildFromTemplate"),
  setApplicationMenu: () => unavailable("Menu.setApplicationMenu"),
};

export const nativeTheme = { shouldUseDarkColors: false };

export const session = {
  defaultSession: {
    setPermissionRequestHandler: () => unavailable("session permission handlers"),
    setPermissionCheckHandler: () => unavailable("session permission handlers"),
  },
};

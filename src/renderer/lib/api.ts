/**
 * The renderer's one door to the main process. Everything the app can do
 * outside its own window goes through `window.casebook`, which the preload
 * script puts there (see preload/index.ts); this module is where the renderer
 * agrees to that shape and the only place the global is named.
 */

import type { CasebookApi } from "../../shared/api.ts";

declare global {
  interface Window {
    casebook?: CasebookApi;
  }
}

/**
 * Read on use rather than at import, so a preload that failed to load surfaces
 * as a message inside the app's own error handling instead of a blank window.
 */
export function api(): CasebookApi {
  const bridge = window.casebook;
  if (!bridge) throw new Error("Casebook's data bridge didn't load. Quit and open it again.");
  return bridge;
}

/**
 * The message out of a rejected bridge call. Electron wraps whatever the main
 * process threw in "Error invoking remote method 'doc:get': ", which is true
 * and unhelpful — the part worth showing someone is what follows it.
 */
export function bridgeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, "");
}

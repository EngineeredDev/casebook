import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The main process, plus the renderer's pure lib.
 *
 * Renderer *components* are still verified by driving the real app over CDP,
 * which exercises Mantine, the router and the bridge together — a unit test of
 * a button is a test of a mock. But `src/renderer/lib` is arithmetic over
 * plain objects: aggregation, the search query language, CSV formatting. Its
 * bugs are wrong numbers in a printed report rather than a misplaced control,
 * and they are invisible on screen, which is exactly the kind CDP cannot see.
 *
 * `environment: "node"` is enough for that lib because nothing in it touches
 * the DOM on import. The one exception is `noteExcerpt`, which parses HTML with
 * DOMParser — so `buildIndex` is not directly testable here, and search tests
 * build their IndexedEntry fixtures by hand instead. That is the better seam
 * anyway; no jsdom dependency has to exist to get at it.
 *
 * The alias is the whole trick for the main process: `electron` resolves to a
 * stub that lets a test say where the app's folders are (see
 * src/test/electron.ts). Without it every import under src/main fails at load,
 * because the real module is a native binding that only exists inside an
 * Electron process.
 */
export default defineConfig({
  resolve: {
    alias: {
      electron: fileURLToPath(new URL("./src/test/electron.ts", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    /**
     * A file per worker process. These tests write real files and several of
     * them reach modules that memoize (config.ts caches what it read), so the
     * isolation is doing real work rather than costing startup for nothing.
     */
    isolate: true,
  },
});

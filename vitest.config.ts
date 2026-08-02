import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Two suites, because they need two different worlds.
 *
 * **node** — the main process, plus the renderer's pure lib. `src/renderer/lib`
 * is arithmetic over plain objects: aggregation, the search query language, CSV
 * formatting. Its bugs are wrong numbers in a printed report rather than a
 * misplaced control, and they are invisible on screen, which is exactly the kind
 * driving the real app cannot see.
 *
 * `environment: "node"` is enough for that lib because nothing in it touches the
 * DOM on import. The one exception is `noteExcerpt`, which parses HTML with
 * DOMParser — so `buildIndex` is not directly testable there, and search tests
 * build their IndexedEntry fixtures by hand instead. That is the better seam
 * anyway.
 *
 * **jsdom** — `.test.tsx` only, for the handful of component behaviours that
 * are neither arithmetic nor visible. Most of what a component does is still
 * verified by driving the real app, which exercises Mantine, the router and the
 * bridge together; a unit test of a button is a test of a mock. What earns a
 * component test is a rule about *time*: an unsaved draft surviving a
 * navigation, a stream from an abandoned request being ignored. Both are
 * invisible on a screenshot and both were shipped wrong.
 *
 * The alias is the whole trick for the main process: `electron` resolves to a
 * stub that lets a test say where the app's folders are (see
 * src/test/electron.ts). Without it every import under src/main fails at load,
 * because the real module is a native binding that only exists inside an
 * Electron process.
 */
const alias = {
  electron: fileURLToPath(new URL("./src/test/electron.ts", import.meta.url)),
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "node",
          include: ["src/**/*.test.ts"],
          environment: "node",
          /**
           * A file per worker process. These tests write real files and several
           * of them reach modules that memoize (config.ts caches what it read),
           * so the isolation is doing real work rather than costing startup for
           * nothing.
           */
          isolate: true,
        },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: "dom",
          include: ["src/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["./src/test/dom.ts"],
        },
      },
    ],
  },
});

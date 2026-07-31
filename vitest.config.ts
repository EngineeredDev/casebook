import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Tests for the main process only. The renderer is verified by driving the real
 * app over CDP, which exercises Mantine, the router and the bridge together;
 * what needs unit tests is the half that writes to disk, where a bug is
 * measured in lost work rather than in a misplaced button.
 *
 * The alias is the whole trick: `electron` resolves to a stub that lets a test
 * say where the app's folders are (see src/test/electron.ts). Without it every
 * import under src/main fails at load, because the real module is a native
 * binding that only exists inside an Electron process.
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

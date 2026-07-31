import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";

/**
 * Absolute asset URLs in the production renderer.
 *
 * electron-vite hard-sets `base: './'` for production builds — it assumes the
 * renderer is loaded from a fixed file:// path — and does it from a plugin that
 * runs before user config, so setting `base` in this file has no effect. This
 * plugin runs after and sets it back.
 *
 * It matters because the router puts real paths in the address bar. A relative
 * `./assets/index.js` inside app://casebook/students/<id> is requested from
 * app://casebook/students/assets/index.js, which is nowhere.
 */
function absoluteAssetBase(): Plugin {
  return {
    name: "casebook:absolute-asset-base",
    config: () => ({ base: "/" }),
  };
}

/**
 * Three builds out of one config, into out/{main,preload,renderer}. Entry
 * points are electron-vite's defaults — src/main/index.ts, src/preload/index.ts
 * and src/renderer/index.html — so they are not restated here.
 *
 * Two things about this project are worth knowing before editing:
 *
 * - package.json has no `"type": "module"`, so main and preload build as
 *   CommonJS. That is not incidental: a preload script running with
 *   `sandbox: true` cannot be an ES module, and one module format across the
 *   Node side is simpler than two.
 * - Every React/Mantine/Tiptap package is a devDependency. Vite bundles the
 *   renderer completely, so nothing under node_modules is needed at runtime;
 *   `dependencies` is reserved for anything the packaged main process must
 *   still be able to `require`, and electron-builder ships exactly that.
 *   node-llama-cpp is the first entry it has ever had, and it must stay
 *   external: bundling it breaks the on-disk layout its native binaries are
 *   found through, in packaged builds only, while dev keeps working.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        /**
         * Two entry points, not one. The inference host runs in its own
         * `utilityProcess` and so needs its own bundle — and electron-vite has
         * exactly three build targets, none of which is "another Node entry",
         * so it rides along on the main build and lands beside index.js.
         * `service.ts` finds it at `join(__dirname, "llm-host.js")`.
         */
        input: {
          index: "src/main/index.ts",
          "llm-host": "src/main/llm/host.ts",
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react(), absoluteAssetBase()],
  },
});

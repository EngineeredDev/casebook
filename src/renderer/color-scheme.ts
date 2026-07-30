/**
 * Stamps the stored color scheme onto <html> before React mounts, so dark mode
 * doesn't start the app with a flash of white.
 *
 * This was an inline <script> in index.html. It is a module now because the
 * packaged app is served under `script-src 'self'` (see main/renderer.ts), and
 * one inline script is all it takes to need `'unsafe-inline'` — the thing the
 * policy exists to refuse. Imported first from index.tsx, so it runs ahead of
 * everything it is protecting.
 *
 * The window is also created hidden and painted with Mantine's body color
 * until the renderer's first frame, which covers the moment before this runs.
 */

const STORAGE_KEY = "mantine-color-scheme-value";

try {
  const stored = localStorage.getItem(STORAGE_KEY);
  const scheme =
    stored === "light" || stored === "dark"
      ? stored
      : matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  document.documentElement.setAttribute("data-mantine-color-scheme", scheme);
} catch {
  // Storage can be unavailable; the default light scheme is a fine fallback.
}

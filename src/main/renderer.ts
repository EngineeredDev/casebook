/**
 * Where the renderer comes from, and how it is served.
 *
 * In development that is electron-vite's dev server over http. In a packaged
 * build it is a custom `app://` protocol reading the Vite output out of the
 * asar. Not `file://`: the app puts real paths in the address bar
 * (`/students/<id>`), and a file URL has no way to answer one of those with the
 * app shell. Serving over a registered protocol is also what Electron's own
 * security checklist asks for.
 */

import { net, protocol } from "electron";
import { statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";

const SCHEME = "app";
const HOST = "casebook";

/** electron-vite sets this while `electron-vite dev` is running; never in a build. */
const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL;

/** What the window loads. */
export const RENDERER_URL = DEV_SERVER_URL ?? `${SCHEME}://${HOST}/`;

const RENDERER_LOCATION = new URL(RENDERER_URL);

/**
 * Whether a URL is this app. Navigation checks and every IPC handler ask, so a
 * page that somehow ends up somewhere else can neither keep the window nor
 * reach the disk.
 *
 * Emphatically not an `origin` comparison, which is the obvious way to write
 * this and is wrong here. Node's URL reports `origin` as the *string* "null"
 * for every non-special scheme — `app:` and `file:` alike — so comparing
 * origins in the main process quietly accepts `app://anywhere-else/` and
 * `file:///` as if they were this app, turning both checks into no-ops in the
 * packaged build while continuing to work in development, where the dev server
 * has a real http origin. Chromium knows `app:` is a standard scheme and would
 * answer correctly; the main process is not Chromium.
 */
export function isRendererUrl(candidate: string): boolean {
  const url = URL.parse(candidate);
  return (
    url !== null &&
    url.protocol === RENDERER_LOCATION.protocol &&
    url.host === RENDERER_LOCATION.host
  );
}

/**
 * Everything is same-origin and local, so the policy can be a deny-list of one:
 * `default-src 'none'` and then only what the app actually uses.
 *
 * `style-src` has to allow inline styles — Mantine writes its theme out as a
 * `<style>` element of CSS variables at runtime, and Tiptap's editor does the
 * same. Scripts have no such exception: the one inline script this app used to
 * carry (the pre-paint color-scheme stamp) was moved into a module for exactly
 * that reason, so `script-src 'self'` holds with nothing weakening it.
 *
 * Only the packaged build gets this. The dev server is plain http and Electron
 * will say so in the console; that warning is expected and does not apply to
 * what ships.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Has to run before `app.whenReady()`, and describes the scheme rather than
 * serving it: `standard` is what gives the pages an origin (and therefore
 * localStorage, which holds the color-scheme choice) and makes `history`
 * paths resolve; `secure` keeps Chromium from treating it as a downgrade.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

/** Guards against `..` and percent-encoded escapes climbing out of the bundle. */
function resolveWithin(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const file = normalize(join(root, decoded));
  return file === root || file.startsWith(root + sep) ? file : null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

async function serveFile(path: string): Promise<Response> {
  const res = await net.fetch(pathToFileURL(path).toString());
  // Only the document carries a policy; repeating it on every asset would
  // change nothing about what the page is allowed to do.
  if (extname(path) !== ".html") return res;
  const headers = new Headers(res.headers);
  headers.set("Content-Security-Policy", CSP);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Serves the built renderer, with the SPA fallback the old `"/*"` route
 * provided: a path that names no file is a client-side route, so it gets
 * index.html and the router takes it from there. A path that names a *file*
 * that isn't there is a genuine 404 — answering a missing script with HTML
 * only turns a build mistake into a syntax error further away from its cause.
 */
export function serveRenderer(): void {
  const root = join(__dirname, "../renderer");
  const indexHtml = join(root, "index.html");

  protocol.handle(SCHEME, async (request) => {
    const { host, pathname } = new URL(request.url);
    if (host !== HOST) return new Response("Not found", { status: 404 });

    const file = resolveWithin(root, pathname);
    if (file && isFile(file)) return serveFile(file);
    // "Names a file" is decided on the decoded path, the same string
    // resolveWithin looked for. Testing the raw one would read `%2E` as an
    // ordinary character and 404 a client route the router would have handled.
    if (!extname(file ?? pathname)) return serveFile(indexHtml);
    return new Response("Not found", { status: 404 });
  });
}

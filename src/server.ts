import index from "./index.html";
import { loadDoc, saveDoc, backupIfNeeded, isCompiled, dataDir } from "./storage.ts";
import { DATA_VERSION, type DataDoc } from "./types.ts";

const APP_NAME = "casebook";
const BASE_PORT = 4321;
/**
 * Loopback only. Bun.serve defaults to 0.0.0.0, which put the whole document —
 * student names, entries, notes — on every interface, readable by anything on
 * the same school network with no authentication.
 *
 * The literal IP is used rather than "localhost" everywhere a connection is
 * made, because "localhost" resolves to ::1 first on some Windows setups and
 * would then miss an IPv4-only listener.
 *
 * The hosted demo is the one exception — a container has to answer its own
 * network to be reachable at all. It opts in by setting PORT, and only the
 * from-source build honours it: the compiled executable, the thing that lands
 * on a clinician's machine, cannot be talked into binding wide by a stray
 * environment variable.
 */
const HOSTED_PORT = !isCompiled() && process.env.PORT ? Number(process.env.PORT) : null;
const HOST = HOSTED_PORT === null ? "127.0.0.1" : "0.0.0.0";
/**
 * The local build binds both loopback families, because the browser is sent to
 * DISPLAY_HOST, which resolves to ::1 ahead of 127.0.0.1 on macOS. A v4-only
 * listener would make every launch pay a failed IPv6 connect before the
 * browser's Happy Eyeballs fallback reached 127.0.0.1. Unused when hosted —
 * 0.0.0.0 already covers the container's own v4 addresses.
 */
const HOST_V6 = "::1";
/**
 * RFC 6761 reserves "localhost" and its subdomains for loopback, so this needs
 * no hosts-file entry and no admin rights — which matters on a school-managed
 * device. Chrome, Edge and Firefox additionally map *.localhost to loopback
 * internally, which covers Windows, where the OS resolver only knows the bare
 * name and would fail on a subdomain.
 *
 * This is a display name over the same loopback bind, not mDNS: resolution
 * never leaves the machine and nothing is advertised to the network.
 */
const DISPLAY_HOST = "casebook.localhost";
/** Distinguishes this process in health checks — macOS lets two sockets "bind" the same port. */
const INSTANCE = crypto.randomUUID();

/** Bracket-wraps IPv6 literals so the host can go in a URL. */
function origin(host: string, port: number): string {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

let doc: DataDoc = loadDoc();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function validateDoc(candidate: unknown): candidate is DataDoc {
  if (typeof candidate !== "object" || candidate === null) return false;
  const d = candidate as DataDoc;
  return (
    d.version === DATA_VERSION &&
    typeof d.rev === "number" &&
    Array.isArray(d.categories) &&
    Array.isArray(d.students) &&
    Array.isArray(d.entries) &&
    typeof d.settings === "object"
  );
}

function startServer(port: number, hostname = HOST) {
  return Bun.serve({
    port,
    hostname,
    development: !isCompiled() && process.env.NODE_ENV !== "production",
    routes: {
      // Catch-all so client-side routes survive a reload: /students/<id> has to
      // return the app shell, not a 404. Bun matches most-specific-first, so the
      // /api routes below and the bundler's own /_bun/* assets are unaffected.
      "/*": index,
      "/api/health": () => json({ app: APP_NAME, ok: true, instance: INSTANCE }),
      "/api/data": {
        GET: () => json(doc),
        PUT: async (req) => {
          const candidate = await req.json().catch(() => null);
          if (!validateDoc(candidate)) return json({ error: "Malformed document" }, 400);
          if (candidate.rev !== doc.rev) {
            return json({ error: "Revision conflict", serverRev: doc.rev }, 409);
          }
          backupIfNeeded();
          const next: DataDoc = { ...candidate, rev: doc.rev + 1 };
          saveDoc(next);
          doc = next;
          return json({ ok: true, rev: next.rev });
        },
      },
    },
  });
}

async function healthOf(
  port: number,
  host = HOST,
): Promise<{ app?: string; instance?: string } | null> {
  try {
    const res = await fetch(`${origin(host, port)}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return (await res.json()) as { app?: string; instance?: string };
  } catch {
    return null;
  }
}

function openBrowser(url: string) {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // Browser launch is best-effort; the URL is printed either way.
  }
}

/**
 * Another copy of this app already owns the port. Re-open its tab and leave,
 * so a second double-click focuses the running instance instead of starting a
 * rival one that would write the same data.json from a stale in-memory doc.
 */
function focusExisting(port: number): never {
  const running = origin(DISPLAY_HOST, port);
  console.log(`Already running at ${running}`);
  openBrowser(running);
  process.exit(0);
}

/**
 * Called after failing to take a port we had just probed as free — two launches
 * landing together. Re-probes now that our own listener is gone, so the answer
 * comes from whoever actually holds it. If that is another copy of us, focus it;
 * advancing to the next port instead is what leaves two instances live.
 */
async function yieldPort(port: number): Promise<void> {
  const winner = (await healthOf(port)) ?? (await healthOf(port, HOST_V6));
  if (winner?.app === APP_NAME) focusExisting(port);
}

let server: ReturnType<typeof startServer> | null = null;
let port = BASE_PORT;
if (HOSTED_PORT !== null) {
  // One app per container: nothing else can be holding the port, and the probe
  // below would have to guess a routable address to talk to a 0.0.0.0 listener.
  port = HOSTED_PORT;
  server = startServer(port);
} else {
  for (; port < BASE_PORT + 10; port++) {
    // macOS doesn't reliably reject a second bind, so probe the port first.
    // Both families are probed because the browser resolves DISPLAY_HOST to ::1
    // first: a foreign app holding ::1 would capture the tab even with
    // 127.0.0.1 free, so that port is no good to us either.
    const [v4, v6] = await Promise.all([healthOf(port), healthOf(port, HOST_V6)]);
    const existing = v4 ?? v6;
    // A previous double-click left an instance up — just focus it.
    if (existing?.app === APP_NAME) focusExisting(port);
    if (existing) continue; // some other HTTP app owns this port
    try {
      server = startServer(port);
    } catch {
      // A real EADDRINUSE: someone bound between the probe and here.
      await yieldPort(port);
      continue;
    }
    // Confirm this process actually receives traffic on the port it claims.
    const mine = await healthOf(port);
    if (mine?.instance === INSTANCE) break;
    server.stop(true);
    server = null;
    await yieldPort(port);
  }
}
if (!server) {
  console.error(`No free port found (${BASE_PORT}-${BASE_PORT + 9}).`);
  process.exit(1);
}

if (HOSTED_PORT === null) {
  // Best effort: the app is fully usable on v4 alone, and ::1 does not exist
  // where IPv6 is disabled. Verified like the v4 bind so a foreign listener
  // can't quietly answer for DISPLAY_HOST; if the claim fails, the browser
  // falls back to 127.0.0.1 and still lands here.
  try {
    const v6 = startServer(port, HOST_V6);
    const mine = await healthOf(port, HOST_V6);
    if (mine?.instance !== INSTANCE) v6.stop(true);
  } catch {
    // No IPv6 loopback on this machine; the v4 listener carries it.
  }
}

const url = origin(HOSTED_PORT === null ? DISPLAY_HOST : HOST, port);
console.log(`Casebook running at ${url}`);
console.log(`Data file: ${dataDir()}/data.json`);
if (isCompiled()) openBrowser(url);

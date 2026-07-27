import index from "./index.html";
import { loadDoc, saveDoc, backupIfNeeded, isCompiled, dataDir } from "./storage.ts";
import { DATA_VERSION, type DataDoc } from "./types.ts";

const APP_NAME = "school-clinician-tracker";
const BASE_PORT = 4321;
/**
 * Loopback only. Bun.serve defaults to 0.0.0.0, which put the whole document —
 * student names, entries, notes — on every interface, readable by anything on
 * the same school network with no authentication.
 *
 * The literal IP is used rather than "localhost" everywhere a connection is
 * made, because "localhost" resolves to ::1 first on some Windows setups and
 * would then miss an IPv4-only listener.
 */
const HOST = "127.0.0.1";
/** Distinguishes this process in health checks — macOS lets two sockets "bind" the same port. */
const INSTANCE = crypto.randomUUID();

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

function startServer(port: number) {
  return Bun.serve({
    port,
    hostname: HOST,
    development: !isCompiled() && process.env.NODE_ENV !== "production",
    routes: {
      "/": index,
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

async function healthOf(port: number): Promise<{ app?: string; instance?: string } | null> {
  try {
    const res = await fetch(`http://${HOST}:${port}/api/health`, {
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

let server: ReturnType<typeof startServer> | null = null;
let port = BASE_PORT;
for (; port < BASE_PORT + 10; port++) {
  // macOS doesn't reliably reject a second bind, so probe the port first.
  const existing = await healthOf(port);
  if (existing?.app === APP_NAME) {
    // A previous double-click left an instance up — just focus it.
    console.log(`Already running at http://${HOST}:${port}`);
    openBrowser(`http://${HOST}:${port}`);
    process.exit(0);
  }
  if (existing) continue; // some other HTTP app owns this port
  try {
    server = startServer(port);
  } catch {
    continue;
  }
  // Confirm this process actually receives traffic on the port it claims.
  const mine = await healthOf(port);
  if (mine?.instance === INSTANCE) break;
  server.stop(true);
  server = null;
}
if (!server) {
  console.error(`No free port found (${BASE_PORT}-${BASE_PORT + 9}).`);
  process.exit(1);
}

const url = `http://${HOST}:${port}`;
console.log(`Clinician Tracker running at ${url}`);
console.log(`Data file: ${dataDir()}/data.json`);
if (isCompiled()) openBrowser(url);

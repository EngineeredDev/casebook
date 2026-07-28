import {
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
  copyFileSync,
  renameSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { emptyDoc, DATA_VERSION, type DataDoc, type Entry } from "./types.ts";

/** True when running as a `bun build --compile` binary rather than `bun src/server.ts`. */
export function isCompiled(): boolean {
  return Bun.main.includes("$bunfs") || Bun.main.includes("~BUN");
}

/**
 * Data lives next to the executable when compiled (so the folder is self-contained
 * and portable), and in the repo root during development.
 */
export function dataDir(): string {
  if (isCompiled()) return dirname(process.execPath);
  return join(import.meta.dir, "..");
}

const DATA_FILE = () => join(dataDir(), "data.json");
const BACKUP_DIR = () => join(dataDir(), "backups");
const KEEP_BACKUPS = 30;

/** Local YYYY-MM-DD, used to name backup files. */
function dayStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Wrap a v1 plain-text note as HTML. Every v1 note is plain text by
 * construction — the old field was a plain input — so escaping is unconditional
 * and needs no HTML sniffing. Blank lines become paragraphs, single newlines
 * become breaks, matching how the old textarea rendered.
 */
function plainToHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${esc(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function migrate(raw: DataDoc & { version: number }): DataDoc {
  if (raw.version === DATA_VERSION) return raw;
  if (raw.version !== 1) throw new Error(`Unsupported data version: ${raw.version}`);
  return {
    ...raw,
    version: DATA_VERSION,
    entries: raw.entries.map((e: Entry) => {
      if (typeof e.note !== "string" || !e.note.trim()) {
        const { note: _drop, ...rest } = e;
        return rest;
      }
      return { ...e, note: plainToHtml(e.note) };
    }),
  };
}

export function loadDoc(): DataDoc {
  const path = DATA_FILE();
  if (!existsSync(path)) {
    const doc = emptyDoc();
    saveDoc(doc);
    return doc;
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const doc = migrate(raw);
  if (doc !== raw) {
    // A dedicated snapshot, not backupIfNeeded() — that one is a no-op once
    // today's rolling backup exists, which would leave a migration with no way
    // back on any day the app had already been opened.
    const dir = BACKUP_DIR();
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, `data-pre-v${DATA_VERSION}-${dayStamp()}.json`);
    if (!existsSync(dest)) copyFileSync(path, dest);
    saveDoc(doc);
    console.log(
      `Migrated data.json from version ${raw.version} to ${DATA_VERSION}. ` +
        `Previous file saved to ${dest}`,
    );
  }
  return doc;
}

/** Atomic write: temp file in the same directory, then rename over the original. */
export function saveDoc(doc: DataDoc): void {
  const path = DATA_FILE();
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(doc, null, 2));
  renameSync(tmp, path);
}

/** Copy today's first pre-write state into backups/, pruning to the newest N. */
export function backupIfNeeded(): void {
  const src = DATA_FILE();
  if (!existsSync(src)) return;
  const dir = BACKUP_DIR();
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `data-${dayStamp()}.json`);
  if (existsSync(dest)) return;
  copyFileSync(src, dest);
  const backups = readdirSync(dir)
    .filter((f) => /^data-\d{4}-\d{2}-\d{2}\.json$/.test(basename(f)))
    .sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - KEEP_BACKUPS))) {
    unlinkSync(join(dir, old));
  }
}

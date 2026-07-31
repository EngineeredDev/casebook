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
import { join, basename } from "node:path";
import { emptyDoc, DATA_VERSION, type DataDoc, type Entry } from "../shared/types.ts";
import { backupDir, dataDir, dataDirIsConfigured, dataFile } from "./paths.ts";

const KEEP_BACKUPS = 30;

/** Local YYYY-MM-DD, used to name backup files. */
export function dayStamp(): string {
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

/**
 * Enough of a shape to migrate and then use. Deliberately looser than
 * `isDataDoc` in ipc.ts, which guards documents arriving from the renderer and
 * so insists on the current version — a file on disk is allowed to be older.
 *
 * Without this, a data.json that parses as JSON but isn't a Casebook document
 * travels all the way to the renderer, where the first `doc.students.length`
 * throws and — there being no error boundary — leaves a white window. A file
 * that isn't the thing it claims to be is exactly as unusable as one that isn't
 * valid JSON, and should fail in the same place.
 */
function looksLikeDoc(raw: unknown): raw is DataDoc & { version: number } {
  if (typeof raw !== "object" || raw === null) return false;
  const d = raw as DataDoc;
  return (
    typeof d.version === "number" &&
    typeof d.rev === "number" &&
    Array.isArray(d.categories) &&
    Array.isArray(d.students) &&
    Array.isArray(d.entries) &&
    typeof d.settings === "object" &&
    d.settings !== null
  );
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
  const path = dataFile();
  if (!existsSync(path)) {
    /**
     * No data file usually means a new install. It means something else when
     * the folder came from the config and has since gone: renamed in Finder,
     * an external drive that isn't mounted, a synced folder that hasn't come
     * down yet. Assuming a fresh start there would open an empty app, write an
     * empty data.json into a folder that has to be created first, and offer to
     * import from an install that no longer exists — with nothing anywhere
     * saying her records had not been found.
     */
    if (dataDirIsConfigured() && !existsSync(dataDir())) {
      throw new Error(
        `the folder ${dataDir()} isn't there. If it moved, put it back — or point Casebook at its new home in Settings.`,
      );
    }
    const doc = emptyDoc();
    saveDoc(doc);
    return doc;
  }
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!looksLikeDoc(raw)) throw new Error("it isn't a Casebook data file.");
  const doc = migrate(raw);
  if (doc !== raw) {
    // A dedicated snapshot, not backupIfNeeded() — that one is a no-op once
    // today's rolling backup exists, which would leave a migration with no way
    // back on any day the app had already been opened.
    const dir = backupDir();
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
export function writeFileAtomic(path: string, contents: string): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

export function saveDoc(doc: DataDoc): void {
  // The data folder is created on demand rather than at first run, so the very
  // first save is also the one that has to make it.
  mkdirSync(dataDir(), { recursive: true });
  writeFileAtomic(dataFile(), JSON.stringify(doc, null, 2));
}

/**
 * Copy every backup that isn't already at the destination, leaving the source
 * untouched. Same-named files are left alone rather than overwritten: two
 * folders can hold a `data-2026-03-14.json` from different installs, and the
 * one already in the destination is the one this app has been keeping.
 *
 * Returns the names it actually wrote — which is what lets a caller that fails
 * partway through take back exactly what it put there and nothing else.
 */
export function copyMissingBackups(from: string, to: string): string[] {
  let names: string[];
  try {
    names = readdirSync(from);
  } catch {
    return []; // No backups/ in the source. Nothing to bring over.
  }
  const wanted = names.filter((name) => name.endsWith(".json"));
  if (wanted.length === 0) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of wanted) {
    const dest = join(to, name);
    if (existsSync(dest)) continue;
    copyFileSync(join(from, name), dest);
    copied.push(name);
  }
  return copied;
}

/** Copy today's first pre-write state into backups/, pruning to the newest N. */
export function backupIfNeeded(): void {
  const src = dataFile();
  if (!existsSync(src)) return;
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `data-${dayStamp()}.json`);
  if (existsSync(dest)) return;
  copyFileSync(src, dest);
  const backups = readdirSync(dir)
    .filter((f) => /^data-\d{4}-\d{2}-\d{2}\.json$/.test(basename(f)))
    .toSorted();
  for (const old of backups.slice(0, Math.max(0, backups.length - KEEP_BACKUPS))) {
    unlinkSync(join(dir, old));
  }
}

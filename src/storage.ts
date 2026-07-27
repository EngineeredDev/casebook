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
import { emptyDoc, type DataDoc } from "./types.ts";

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

export function loadDoc(): DataDoc {
  const path = DATA_FILE();
  if (!existsSync(path)) {
    const doc = emptyDoc();
    saveDoc(doc);
    return doc;
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (raw.version !== 1) throw new Error(`Unsupported data version: ${raw.version}`);
  return raw as DataDoc;
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
  const today = new Date();
  const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const dest = join(dir, `data-${stamp}.json`);
  if (existsSync(dest)) return;
  copyFileSync(src, dest);
  const backups = readdirSync(dir)
    .filter((f) => /^data-\d{4}-\d{2}-\d{2}\.json$/.test(basename(f)))
    .sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - KEEP_BACKUPS))) {
    unlinkSync(join(dir, old));
  }
}

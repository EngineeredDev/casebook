/**
 * App settings that cannot live in the data document, because they are about
 * where the data document is.
 *
 * Kept in Electron's `userData` directory, which is derived from the app name
 * set in main/index.ts — the reason that name is fixed and never edited.
 */

import { app } from "electron";
import { mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

export interface Config {
  /** Absolute path to the folder holding data.json. Absent means the default. */
  dataDir?: string;
  /**
   * Absolute path to a second place the backups are copied to — an external
   * drive, a synced folder, a share. Absent means the mirror is off, which is
   * the default and always a deliberate choice to change.
   */
  mirrorDir?: string;
  /**
   * Minutes of idleness before Casebook locks itself, when encryption is on.
   * Absent or null means never; only a positive whole number means anything.
   */
  autoLockMinutes?: number | null;

  /**
   * Anything a newer Casebook wrote that this one has never heard of.
   *
   * Carried through reads and writes untouched. Without it, `writeConfig({
   * ...readConfig(), … })` — which is how every setting is changed — would
   * quietly erase every key this build doesn't know, so running an older
   * Casebook once (a downgrade, a second copy on the same Mac) would strip the
   * newer one's settings the first time anything was saved.
   */
  [unknown: string]: unknown;
}

let cache: Config | null = null;

function configFile(): string {
  return join(app.getPath("userData"), "config.json");
}

/**
 * The settings a candidate actually contains, with anything malformed left out.
 *
 * Applied on the way in *and* on the way out, deliberately. When only reads
 * validated, `writeConfig` could persist — and cache — a value that the next
 * launch would then reject and drop, so the running session and every session
 * after it disagreed about where the data folder was. Values are checked where
 * they enter the file, not only where they leave it.
 */
function normalize(raw: unknown): Config {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const { dataDir, mirrorDir, autoLockMinutes, ...rest } = raw as Config;

  const config: Config = { ...rest };
  // A relative path would be resolved against whatever the working directory
  // happened to be, which for a double-clicked app is "/".
  if (typeof dataDir === "string" && isAbsolute(dataDir)) config.dataDir = dataDir;
  if (typeof mirrorDir === "string" && isAbsolute(mirrorDir)) config.mirrorDir = mirrorDir;
  if (autoLockMinutes === null) config.autoLockMinutes = null;
  else if (Number.isInteger(autoLockMinutes) && (autoLockMinutes as number) > 0) {
    config.autoLockMinutes = autoLockMinutes as number;
  }
  return config;
}

export function readConfig(): Config {
  if (cache) return cache;

  let raw: string;
  try {
    raw = readFileSync(configFile(), "utf8");
  } catch {
    // No config file. That is the normal state for anyone who has never moved
    // the data folder, and the defaults are exactly right.
    cache = {};
    return cache;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // A file that exists and says something unreadable is not the same as no
    // file. Falling back to the default here would look through the wrong
    // folder, find nothing, and present a fresh empty Casebook to someone
    // whose records are sitting in the folder this file was supposed to name.
    throw new Error(
      `Casebook can't read its settings file (${configFile()}) — ${(error as Error).message}`,
      { cause: error },
    );
  }

  cache = normalize(parsed);
  return cache;
}

export function writeConfig(next: Config): void {
  const dir = app.getPath("userData");
  mkdirSync(dir, { recursive: true });
  // Through the durable writer, which is a stronger guarantee than this file
  // used to get. It holds one string, but losing it is losing the app's memory
  // of where the data folder was moved to — after which Casebook opens on
  // ~/Casebook, finds nothing, and looks exactly like a fresh install to
  // someone whose records are sitting in a folder nothing now points at.
  const config = normalize(next);
  writeFileAtomic(configFile(), JSON.stringify(config, null, 2));
  cache = config;
}

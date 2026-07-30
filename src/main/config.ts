/**
 * App settings that cannot live in the data document, because they are about
 * where the data document is.
 *
 * Kept in Electron's `userData` directory, which is derived from the app name
 * set in main/index.ts — the reason that name is fixed and never edited.
 */

import { app } from "electron";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface Config {
  /** Absolute path to the folder holding data.json. Absent means the default. */
  dataDir?: string;
}

let cache: Config | null = null;

function configFile(): string {
  return join(app.getPath("userData"), "config.json");
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

  const config: Config = {};
  if (typeof parsed === "object" && parsed !== null) {
    const { dataDir } = parsed as Config;
    // A relative path would be resolved against whatever the working directory
    // happened to be, which for a double-clicked app is "/".
    if (typeof dataDir === "string" && isAbsolute(dataDir)) config.dataDir = dataDir;
  }
  cache = config;
  return cache;
}

export function writeConfig(next: Config): void {
  const dir = app.getPath("userData");
  mkdirSync(dir, { recursive: true });
  const path = configFile();
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, path);
  cache = next;
}

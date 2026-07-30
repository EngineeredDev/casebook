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
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configFile(), "utf8"));
  } catch {
    // No config yet, or one that cannot be read. Either way the defaults apply
    // and the app opens; refusing to start over a settings file would be a poor
    // trade for something with a working fallback.
    parsed = {};
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

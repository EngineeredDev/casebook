/**
 * Moving the data folder somewhere else.
 *
 * Copy, verify, switch, and leave the original exactly where it was. Never
 * move-and-hope: the one thing this operation must not be able to do is end up
 * with the config pointing at a folder that does not hold a complete copy of
 * her work. Deleting the old one is her call, made later, with both copies in
 * front of her.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import type { RelocateResult } from "../shared/api.ts";
import { readConfig, writeConfig } from "./config.ts";
import { backupDir, dataDir, dataFile } from "./paths.ts";
import { copyMissingBackups, writeFileAtomic } from "./storage.ts";

function isInside(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(parent + sep);
}

export function relocateData(target: string): RelocateResult {
  if (typeof target !== "string" || !isAbsolute(target)) {
    return { error: "That isn't a folder Casebook can use." };
  }

  const source = dataDir();
  if (target === source) return { ok: true, dir: source };
  // Both directions. A folder inside the current one is the obvious mistake;
  // a folder *containing* it is the quieter one — choosing the home folder
  // would scatter data.json and a backups/ directory loose into it and leave
  // the old copy nested inside the new location.
  if (isInside(target, source) || isInside(source, target)) {
    return { error: "Pick a folder that doesn't overlap the one Casebook uses now." };
  }

  const sourceFile = dataFile();
  if (!existsSync(sourceFile)) {
    return { error: `There's no data.json in ${source} to move.` };
  }
  const targetFile = join(target, "data.json");
  if (existsSync(targetFile)) {
    return { error: `${target} already has a data.json in it. Pick an empty folder.` };
  }

  let contents: string;
  try {
    contents = readFileSync(sourceFile, "utf8");
    mkdirSync(target, { recursive: true });
    writeFileAtomic(targetFile, contents);
    copyMissingBackups(backupDir(), join(target, "backups"));
  } catch (error) {
    return { error: `Couldn't copy your data there — ${(error as Error).message}` };
  }

  // Read it back off the disk it was just written to. Anything that went wrong
  // between here and there — a full volume, a network share that accepted the
  // write and dropped it — shows up now, while the config still points at the
  // folder that definitely works.
  let written: string;
  try {
    written = readFileSync(targetFile, "utf8");
  } catch (error) {
    return { error: `The copy couldn't be read back — ${(error as Error).message}` };
  }
  if (written !== contents) {
    return { error: "The copy didn't match the original, so nothing was changed." };
  }

  writeConfig({ ...readConfig(), dataDir: target });
  return { ok: true, dir: target };
}

/**
 * Bringing data over from the Casebook that came before this one.
 *
 * That version was a single executable that wrote data.json beside itself and
 * ran from a LaunchAgent at every login, so the whole of a previous install is:
 * a folder somewhere under ~/Applications, an executable in it, and a plist in
 * ~/Library/LaunchAgents. This module finds it, copies the data out of it, and
 * — once she says so — retires the parts that would otherwise keep starting a
 * second Casebook every morning.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { ImportResult, LegacyInstall, RetireResult } from "../shared/api.ts";
import { backupDir, dataDir, dataFile } from "./paths.ts";
import { copyMissingBackups, dayStamp, writeFileAtomic } from "./storage.ts";

const LAUNCH_AGENT_LABEL = "com.casebook.server";
/** What scripts/install-macos.sh named the executable, and the only name we delete. */
const EXECUTABLE_NAME = "Casebook";

function launchAgentPlist(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

/**
 * The path the LaunchAgent starts, which is the most reliable pointer to where
 * the old app actually lives — she may well have installed it somewhere else.
 *
 * plutil prints its complaints on stdout, so a failed extract comes back
 * looking like a path. Trust the exit status first, then the shape of the
 * answer. (scripts/install-macos.sh learned this the same way.)
 */
function executableFromLaunchAgent(): string | null {
  const plist = launchAgentPlist();
  if (!existsSync(plist)) return null;
  const extracted = spawnSync(
    "plutil",
    ["-extract", "ProgramArguments.0", "raw", "-o", "-", plist],
    { encoding: "utf8" },
  );
  if (extracted.status !== 0) return null;
  const path = extracted.stdout.trim();
  return path && isAbsolute(path) ? path : null;
}

function countBackups(dir: string): number {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

/** What, if anything, an old install looks like in this folder. */
export function describeInstall(dir: string): LegacyInstall | null {
  const file = join(dir, "data.json");
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null) return null;
  const { entries, students } = doc as { entries?: unknown; students?: unknown };
  if (!Array.isArray(entries)) return null;

  const fromAgent = executableFromLaunchAgent();
  const executable =
    fromAgent && dirname(fromAgent) === dir
      ? fromAgent
      : existsSync(join(dir, EXECUTABLE_NAME))
        ? join(dir, EXECUTABLE_NAME)
        : null;

  return {
    dir,
    entries: entries.length,
    students: Array.isArray(students) ? students.length : 0,
    modified: statSync(file).mtime.toISOString(),
    backups: countBackups(join(dir, "backups")),
    executable,
    launchAgent: existsSync(launchAgentPlist()) ? launchAgentPlist() : null,
  };
}

/**
 * Where the old install is, if it is anywhere obvious. The LaunchAgent is asked
 * first because it names the exact path; ~/Applications/Casebook is the
 * installer's default and covers an agent that has already been removed.
 */
export function findInstall(): LegacyInstall | null {
  const current = dataDir();
  const fromAgent = executableFromLaunchAgent();
  const candidates = [
    ...(fromAgent ? [dirname(fromAgent)] : []),
    join(homedir(), "Applications", "Casebook"),
  ];
  for (const dir of candidates) {
    if (dir === current) continue;
    const found = describeInstall(dir);
    if (found) return found;
  }
  return null;
}

/**
 * Copy an old install's data into the current data folder. The caller has
 * already established that there is nothing here worth keeping — see the
 * `legacy:import` handler — but this still snapshots whatever it is about to
 * replace, because "nothing worth keeping" is a judgement and the snapshot
 * costs a few kilobytes.
 */
export function importInstall(dir: string): ImportResult {
  const found = describeInstall(dir);
  if (!found) return { error: `There's no Casebook data in ${dir}.` };
  if (dir === dataDir()) return { error: "That's the folder Casebook is already using." };

  try {
    mkdirSync(dataDir(), { recursive: true });
    const destination = dataFile();
    if (existsSync(destination)) {
      const backups = backupDir();
      mkdirSync(backups, { recursive: true });
      copyFileSync(destination, join(backups, `data-pre-import-${dayStamp()}.json`));
    }
    writeFileAtomic(destination, readFileSync(join(dir, "data.json"), "utf8"));
    copyMissingBackups(join(dir, "backups"), backupDir());
  } catch (error) {
    return { error: `Couldn't bring the data over — ${(error as Error).message}` };
  }
  return { ok: true, entries: found.entries, students: found.students };
}

/**
 * Stop the old install starting itself again. The LaunchAgent goes, the plist
 * goes, and the executable goes — but the folder and everything else in it
 * stays, because that is where the original data.json and its backups are and
 * this is not the moment to be deleting a second copy of her work.
 */
export function retireInstall(dir: string): RetireResult {
  const problems: string[] = [];

  // Fails when nothing is loaded, which is the normal case on a Mac that has
  // been restarted since the old app last ran.
  spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${LAUNCH_AGENT_LABEL}`]);

  const plist = launchAgentPlist();
  if (existsSync(plist)) {
    try {
      unlinkSync(plist);
    } catch (error) {
      problems.push(`couldn't remove ${plist} (${(error as Error).message})`);
    }
  }

  // Only ever the executable this project installs, in the folder the import
  // came from. A plist edited by hand is not licence to delete a path of
  // someone else's choosing.
  const executable = join(dir, EXECUTABLE_NAME);
  if (basename(executable) === EXECUTABLE_NAME && existsSync(executable)) {
    try {
      unlinkSync(executable);
    } catch (error) {
      problems.push(`couldn't remove ${executable} (${(error as Error).message})`);
    }
  }

  return problems.length > 0 ? { error: problems.join("; ") } : { ok: true };
}

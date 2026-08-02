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
import { isEnabled, isUnlocked } from "./encryption.ts";
import { backupDir, dataDir } from "./paths.ts";
import { copyMissingBackups, dayStamp, liveDataFile, writeLiveDocument } from "./storage.ts";

const LAUNCH_AGENT_LABEL = "com.casebook.server";
/**
 * What scripts/install-macos.sh called the executable when it downloaded one.
 * Only a fallback: the installer also accepted a path to a copy she already
 * had, under whatever name it happened to carry, so the LaunchAgent is the
 * better source of truth and is asked first.
 */
const DEFAULT_EXECUTABLE_NAME = "Casebook";

function launchAgentPlist(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

function currentUid(): number {
  return process.getuid?.() ?? 0;
}

function serviceTarget(): string {
  return `gui/${currentUid()}/${LAUNCH_AGENT_LABEL}`;
}

/**
 * Whether launchd is holding the old job right now.
 *
 * Asked rather than inferred from `bootout`'s exit status: that returns a
 * distinct code for "nothing was loaded", which is the ordinary case on a Mac
 * restarted since the old app last ran, and decoding launchctl's codes to tell
 * that apart from a real failure is guesswork this can simply avoid.
 */
function agentIsLoaded(): boolean {
  return spawnSync("launchctl", ["print", serviceTarget()], { encoding: "utf8" }).status === 0;
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

  // Whether the one LaunchAgent on this Mac is the thing that starts *this*
  // folder's install, rather than merely existing somewhere.
  const fromAgent = executableFromLaunchAgent();
  const agentStartsThisInstall = fromAgent !== null && dirname(fromAgent) === dir;

  const executable = agentStartsThisInstall
    ? fromAgent
    : existsSync(join(dir, DEFAULT_EXECUTABLE_NAME))
      ? join(dir, DEFAULT_EXECUTABLE_NAME)
      : null;

  return {
    dir,
    entries: entries.length,
    students: Array.isArray(students) ? students.length : 0,
    modified: statSync(file).mtime.toISOString(),
    backups: countBackups(join(dir, "backups")),
    executable,
    // The plist is a single global file, so attributing it to whatever folder
    // was asked about is how retiring a stray *copy* of the old data ends up
    // booting out the install that is actually running. It counts as this
    // folder's only when it names an executable in it.
    launchAgent: agentStartsThisInstall ? launchAgentPlist() : null,
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
  /**
   * Locked means there is no codec, so the import would write plaintext into an
   * encrypted folder and the app would go on reading `data.json.enc` — success
   * reported, nothing imported, a readable copy of her records left behind.
   * Refusing is the honest answer, and unlocking is a thing she can do.
   */
  if (isEnabled() && !isUnlocked()) {
    return { error: "Casebook is locked. Unlock it with your passphrase, then import." };
  }

  try {
    // Order matters. The live document is written last, and everything that can
    // fail — reading the source, making the folder, snapshotting what is here,
    // carrying the old backups across — happens before it. A failure halfway
    // through then means the current data file was never touched, rather than
    // leaving the disk holding an imported document this process has not read
    // and would overwrite on the next save.
    const contents = readFileSync(join(dir, "data.json"), "utf8");
    mkdirSync(dataDir(), { recursive: true });
    const existing = liveDataFile();
    if (existing) {
      const backups = backupDir();
      mkdirSync(backups, { recursive: true });
      // Named for the era it is in, not the era the folder is in: this is a
      // byte copy of whatever is live, so an encrypted original stays encrypted
      // and keeps the suffix that says so.
      const suffix = existing.endsWith(".enc") ? ".enc" : "";
      copyFileSync(existing, join(backups, `data-pre-import-${dayStamp()}.json${suffix}`));
    }
    copyMissingBackups(join(dir, "backups"), backupDir());
    /**
     * Through the codec, so with a passphrase on this writes `data.json.enc` —
     * the file `liveDataFile` will actually read back. Writing `data.json`
     * directly was the bug: the encrypted file kept winning every read, so the
     * import reported success with entry counts, the app stayed empty, and a
     * full plaintext copy of her records sat in the folder she had put a
     * passphrase on.
     *
     * A stale plaintext `data.json` left by an *interrupted* enable is not
     * removed here. It is somebody else's mess to clean up — deleting a file
     * this function has not snapshotted, on a path where the folder is already
     * in a state it should not be in, is exactly the move the rest of this
     * codebase refuses to make.
     */
    writeLiveDocument(contents);
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
  // Re-described here rather than taken on trust from the caller: everything
  // below deletes something, and this is what establishes both that there is an
  // old install in this folder and which paths belong to it.
  const found = describeInstall(dir);
  if (!found) return { error: `There's no Casebook install in ${dir}.` };

  const problems: string[] = [];
  let stoppedAgent = false;
  let removedPlist = false;
  let removedExecutable = false;

  if (found.launchAgent) {
    const wasLoaded = agentIsLoaded();
    if (wasLoaded) {
      spawnSync("launchctl", ["bootout", serviceTarget()], { encoding: "utf8" });
      stoppedAgent = !agentIsLoaded();
    }
    if (wasLoaded && !stoppedAgent) {
      // Deleting the plist now would take away the only handle on a job that is
      // still running — and still respawning, since the installer wrote
      // KeepAlive into it. Better to leave both and say so.
      problems.push(
        `couldn't stop it starting at login — launchd still has ${LAUNCH_AGENT_LABEL} loaded`,
      );
    } else {
      try {
        unlinkSync(found.launchAgent);
        removedPlist = true;
      } catch (error) {
        problems.push(`couldn't remove ${found.launchAgent} (${(error as Error).message})`);
      }
    }
  }

  // describeInstall only ever reports an executable directly inside `dir` —
  // either the path the LaunchAgent names, checked against this folder, or the
  // installer's default name found in it. A plist edited by hand is still not
  // licence to delete a path of someone else's choosing.
  if (found.executable) {
    // launchd is not the only way it can be running: double-clicking it starts
    // a copy launchd knows nothing about, and macOS unlinks a running
    // executable without complaint — so the kill is what makes the delete mean
    // anything. Exit status 1 is "nothing matched", which is the usual case.
    spawnSync("pkill", ["-x", "-u", String(currentUid()), basename(found.executable)]);
    try {
      unlinkSync(found.executable);
      removedExecutable = true;
    } catch (error) {
      problems.push(`couldn't remove ${found.executable} (${(error as Error).message})`);
    }
  }

  if (problems.length > 0) return { error: problems.join("; ") };
  return { ok: true, stoppedAgent, removedPlist, removedExecutable };
}

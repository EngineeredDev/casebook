/**
 * Replacing Casebook.app with a newer one, in place.
 *
 * This is the one operation in the whole project that can strand her on a
 * broken install, so the shape of it is chosen around that rather than around
 * being tidy. The failure to design against is "half-swapped app, no way back",
 * not "the update didn't happen" — an update that declines to happen costs her
 * nothing, because the install script is still there and still works.
 *
 * Three things follow:
 *
 * 1. The new bundle is verified *before* the old one is disturbed. A truncated
 *    download extracts perfectly happily and fails at launch with a dialog that
 *    explains nothing, so it is checked while backing out is still free.
 * 2. The old bundle is renamed aside, never deleted. It stays on disk until the
 *    new version has actually started and said so — a marker written on a clean
 *    launch, not the swap returning without throwing.
 * 3. Anything that fails after the rename puts the old bundle back.
 *
 * Every download here goes through Node's fetch for the reason given in
 * updater.ts: Chromium-side downloads acquire com.apple.quarantine, and a
 * quarantined app gets translocated to a read-only mount where it cannot
 * update itself again.
 */

import { app } from "electron";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { UpdateInfo, UpdateInstallResult } from "../shared/api.ts";

/** Records a swap that has happened but has not yet been confirmed by a launch. */
interface PendingUpdate {
  from: string;
  to: string;
  /** The renamed-aside bundle, kept until the new version proves it starts. */
  oldBundle: string;
  at: string;
}

function pendingFile(): string {
  return join(app.getPath("userData"), "pending-update.json");
}

/**
 * The .app directory, from the executable inside it. Returns null anywhere the
 * layout is not a bundle — a development run, most obviously, where there is
 * nothing to replace.
 */
export function appBundlePath(): string | null {
  if (!app.isPackaged) return null;
  const bundle = resolve(app.getPath("exe"), "..", "..", "..");
  return bundle.endsWith(".app") && existsSync(bundle) ? bundle : null;
}

/**
 * Whether this copy is in a position to replace itself at all, and why not if
 * it isn't. Checked before the offer is made rather than after she accepts it.
 */
export function canSelfUpdate(): { ok: true } | { ok: false; reason: string } {
  const bundle = appBundlePath();
  if (!bundle) return { ok: false, reason: "A development build doesn't update itself." };

  // Gatekeeper runs a quarantined app from a randomised read-only mount. The
  // path gives it away, and nothing about this operation can work from there.
  if (bundle.includes("/AppTranslocation/")) {
    return {
      ok: false,
      reason:
        "Casebook is running from a temporary read-only copy, which macOS does when an app is opened straight from a download. Reinstall it with the install script and updates will work from then on.",
    };
  }

  try {
    // Write access to the *parent*: the swap renames and creates inside it.
    // /Applications is admin-group writable, so an admin account needs no
    // elevation; a standard account installs to ~/Applications instead.
    accessSync(dirname(bundle), constants.W_OK);
  } catch {
    return {
      ok: false,
      reason: `Casebook can't write to ${dirname(bundle)}, so it can't replace itself there.`,
    };
  }
  return { ok: true };
}

function versionOf(bundle: string): string | null {
  try {
    const plist = join(bundle, "Contents", "Info.plist");
    const out = execFileSync(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleShortVersionString", plist],
      { encoding: "utf8" },
    );
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Everything that can be checked about a bundle before trusting it with the
 * place the real one occupies. The signature is ad-hoc and proves nothing about
 * who built it — but it is a whole-bundle checksum, which is exactly the
 * question being asked here: did all of this arrive intact?
 */
function verifyBundle(bundle: string, expectedVersion: string): string | null {
  if (!existsSync(bundle)) return "the download didn't contain Casebook.app.";
  try {
    execFileSync("codesign", ["--verify", "--deep", "--strict", bundle], { stdio: "ignore" });
  } catch {
    return "the downloaded app failed its signature check, so it arrived damaged.";
  }
  const found = versionOf(bundle);
  if (!found) return "the downloaded app doesn't report a version.";
  if (found !== expectedVersion) {
    return `the download says it is version ${found}, but ${expectedVersion} was expected.`;
  }
  return null;
}

async function download(url: string, to: string): Promise<void> {
  const response = await fetch(url, {
    headers: { "User-Agent": `Casebook/${app.getVersion()}` },
    // Generous: this is ~115 MB and she may be on school wifi.
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!response.ok) throw new Error(`the download answered ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error("the download was empty.");
  writeFileSync(to, bytes);
}

/**
 * Download, verify, swap, and ask Electron to restart into the result. Returns
 * only on failure — on success the process is on its way out.
 */
export async function installUpdate(info: UpdateInfo): Promise<UpdateInstallResult> {
  const allowed = canSelfUpdate();
  if (!allowed.ok) return { error: allowed.reason };

  const bundle = appBundlePath();
  if (!bundle) return { error: "A development build doesn't update itself." };

  const work = join(app.getPath("temp"), `casebook-update-${info.version}`);
  const oldBundle = `${bundle}.old`;
  const cleanUp = () => rmSync(work, { recursive: true, force: true });

  try {
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });

    const zip = join(work, "Casebook.zip");
    await download(info.downloadUrl, zip);

    // ditto, not unzip: it is what round-trips a signed bundle with its
    // symlinks, execute bits and signature intact.
    try {
      execFileSync("ditto", ["-x", "-k", zip, join(work, "extracted")], { stdio: "ignore" });
    } catch {
      // The most likely cause by far is a truncated download, and ditto's own
      // complaint is a shell command line she has no use for.
      cleanUp();
      return { error: "Casebook wasn't replaced — the download arrived damaged." };
    }
    const staged = join(work, "extracted", "Casebook.app");

    const problem = verifyBundle(staged, info.version);
    if (problem) {
      cleanUp();
      return { error: `Casebook wasn't replaced — ${problem}` };
    }

    // Nothing above this line has touched the installed app. Everything below
    // it has to be able to put things back.
    rmSync(oldBundle, { recursive: true, force: true });
    renameSync(bundle, oldBundle);

    try {
      // A copy rather than a rename: the temp directory can be on a different
      // volume, where rename fails outright.
      execFileSync("ditto", [staged, bundle], { stdio: "ignore" });
      const placed = verifyBundle(bundle, info.version);
      if (placed) throw new Error(placed);
    } catch (error) {
      rmSync(bundle, { recursive: true, force: true });
      renameSync(oldBundle, bundle);
      cleanUp();
      return {
        error: `Casebook wasn't replaced — ${(error as Error).message} The version you were running is untouched.`,
      };
    }

    const pending: PendingUpdate = {
      from: app.getVersion(),
      to: info.version,
      oldBundle,
      at: new Date().toISOString(),
    };
    writeFileSync(pendingFile(), JSON.stringify(pending, null, 2));
    cleanUp();

    app.relaunch();
    app.quit();
    return { ok: true };
  } catch (error) {
    cleanUp();
    return { error: `Casebook wasn't replaced — ${(error as Error).message}` };
  }
}

/**
 * Called once on a clean start. If the previous run swapped the bundle, this is
 * the launch that proves the new one works, and the only thing that authorises
 * deleting the copy it replaced.
 *
 * A pending record whose version does *not* match means the new bundle did not
 * end up being what started. The old copy is deliberately left on disk in that
 * case: it is the way back, and this is not the code that should be deciding to
 * throw it away.
 */
export function settlePendingUpdate(): void {
  const path = pendingFile();
  if (!existsSync(path)) return;

  let pending: PendingUpdate;
  try {
    pending = JSON.parse(readFileSync(path, "utf8")) as PendingUpdate;
  } catch {
    rmSync(path, { force: true });
    return;
  }

  if (pending.to === app.getVersion()) {
    rmSync(pending.oldBundle, { recursive: true, force: true });
    rmSync(path, { force: true });
    console.log(`Updated from ${pending.from} to ${pending.to}.`);
    return;
  }

  console.warn(
    `An update to ${pending.to} was staged but this is ${app.getVersion()}. ` +
      `Leaving ${pending.oldBundle} in place — it is the copy to go back to.`,
  );
  rmSync(path, { force: true });
}

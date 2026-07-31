/**
 * Turning the passphrase on and off, and holding the data key while the app is
 * unlocked.
 *
 * This is the only phase of the hardening plan that *adds* a way to lose data,
 * which is why it ships last — on top of a backup net built to catch mistakes
 * in exactly this file. Three rules follow from that, and every function here
 * obeys them:
 *
 * 1. **Snapshot before converting.** Enabling and disabling rewrite every file
 *    in the data folder. Both force one first, under a name nothing prunes, so
 *    the state before the conversion stays reachable by the same restore as
 *    everything else — and stays reachable forever, since this happens a
 *    handful of times in the life of an install.
 * 2. **Write the new file, read it back, then delete the old one.** Never the
 *    other order. An interruption then leaves both copies, which is untidy and
 *    fixable; the other order leaves neither, which is not.
 * 3. **The key never leaves this process.** The renderer sends a passphrase and
 *    receives a yes or a no. It never sees the data key, and no part of the
 *    bridge can be made to hand it over.
 *
 * The passphrase is typed once per launch and cached nowhere on disk. See
 * crypto.ts for why the Keychain was ruled out rather than merely skipped.
 */

import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import {
  createKeyfile,
  CryptoError,
  decryptJson,
  encryptJson,
  isEncrypted,
  parseKeyfile,
  rewrapPassphrase,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
  type Keyfile,
} from "./crypto.ts";
import { backupDir, dataDir, dataFile } from "./paths.ts";
import {
  forceSnapshot,
  liveDataFile,
  loadDoc,
  resetSnapshotState,
  setCodec,
  type DocumentCodec,
} from "./storage.ts";
import type { DataDoc } from "../shared/types.ts";

/**
 * Live only while unlocked, and only here. Dropped by `lock`, which is also
 * what the idle timer and the Lock Now menu item call.
 */
let dek: Buffer | null = null;
let keyfile: Keyfile | null = null;

export function keyfilePath(): string {
  return join(dataDir(), "keyfile.json");
}

/** Encryption is on exactly when there is a keyfile. There is no second flag to disagree with. */
export function isEnabled(): boolean {
  return existsSync(keyfilePath());
}

export function isUnlocked(): boolean {
  return dek !== null;
}

function readKeyfile(): Keyfile {
  return parseKeyfile(JSON.parse(readFileSync(keyfilePath(), "utf8")));
}

/**
 * The codec storage.ts uses while unlocked.
 *
 * It decrypts what is encrypted and passes through what is not, which is not a
 * convenience — `backups/` legitimately holds snapshots from before encryption
 * was switched on, and a restore has to be able to reach them. Writing is
 * always encrypted; only reading accepts both.
 */
function codecFor(key: Buffer): DocumentCodec {
  return {
    suffix: ".enc",
    encode: (json) => encryptJson(key, json),
    decode: (blob) => (isEncrypted(blob) ? decryptJson(key, blob) : blob.toString("utf8")),
  };
}

function hold(key: Buffer, file: Keyfile): void {
  dek = key;
  keyfile = file;
  setCodec(codecFor(key));
}

/**
 * Forget everything. Called by Lock Now, by the idle timer, and on the way into
 * a passphrase change that failed partway.
 */
export function lock(): void {
  dek?.fill(0);
  dek = null;
  keyfile = null;
  setCodec(null);
  // The cached serialization is plaintext, and is what a snapshot-at-quit would
  // be written from. Holding it past a lock would defeat the lock.
  resetSnapshotState();
}

export function unlock(passphrase: string): Promise<void> {
  const file = readKeyfile();
  return unlockWithPassphrase(file, passphrase).then((key) => {
    hold(key, file);
  });
}

/**
 * The way back in when the passphrase is gone. Setting a new one is not
 * optional: an account whose only remaining credential is a sheet of paper that
 * has already been mislaid once is not an account anybody should keep using.
 */
export async function unlockWithRecovery(
  recoveryKey: string,
  nextPassphrase: string,
): Promise<void> {
  const file = readKeyfile();
  const key = await unlockWithRecoveryKey(file, recoveryKey);
  const rewrapped = await rewrapPassphrase(file, key, nextPassphrase);
  writeFileAtomic(keyfilePath(), JSON.stringify(rewrapped, null, 2));
  hold(key, rewrapped);
}

export async function changePassphrase(current: string, next: string): Promise<void> {
  const file = keyfile ?? readKeyfile();
  // Re-derived from the passphrase just typed rather than trusting the unlocked
  // session, so that someone walking up to an unlocked Mac cannot change it
  // without knowing the current one.
  const key = await unlockWithPassphrase(file, current);
  const rewrapped = await rewrapPassphrase(file, key, next);
  writeFileAtomic(keyfilePath(), JSON.stringify(rewrapped, null, 2));
  hold(key, rewrapped);
}

/* ---------- switching it on and off ---------- */

/**
 * Encrypt the data folder, and hand back the recovery key exactly once.
 *
 * The returned key exists nowhere else and is derived from nothing; if it is
 * not written down at this moment it cannot be produced again. The UI is
 * responsible for making that impossible to skip past.
 */
export async function enable(passphrase: string): Promise<string> {
  if (isEnabled()) throw new Error("Casebook is already using a passphrase.");

  // Before anything is rewritten. Forced rather than left to the tiers: those
  // would go ahead with the newest snapshot up to fifteen minutes stale, which
  // is the wrong trade on the one operation that touches every file at once.
  forceSnapshot(loadDoc(), "encryption");

  const { keyfile: file, dek: key, recoveryKey } = await createKeyfile(passphrase);
  // The keyfile lands first. A conversion interrupted after this leaves
  // encrypted files whose key is on disk; the other order would leave encrypted
  // files with no key anywhere, which is the one unrecoverable outcome.
  writeFileAtomic(keyfilePath(), JSON.stringify(file, null, 2));
  hold(key, file);

  convert("encrypt", key);
  return recoveryKey;
}

/** Decrypt everything back to plain files and remove the keyfile. */
export function disable(): void {
  if (!dek) throw new Error("Casebook has to be unlocked before the passphrase can be removed.");

  forceSnapshot(loadDoc(), "plaintext");

  const key = dek;
  convert("decrypt", key);
  // Last, for the same reason the keyfile was written first: while any
  // encrypted file remains, the key that opens it must still be there.
  unlinkSync(keyfilePath());
  lock();
}

/**
 * Rewrite every document in the data folder in the other era.
 *
 * File by file, and each one written, read back and only then replaced. The
 * loop is deliberately not transactional — a folder half-converted is
 * completely readable, because every reader decides an individual file's era
 * from its first bytes rather than from a global flag.
 */
function convert(direction: "encrypt" | "decrypt", key: Buffer): void {
  const toEncrypted = direction === "encrypt";

  const live = liveDataFile();
  if (live) convertFile(live, toEncrypted, key);

  let names: string[];
  try {
    names = readdirSync(backupDir());
  } catch {
    return;
  }
  for (const name of names) {
    // `.bad` files failed to parse already and `.tmp` files are somebody's
    // interrupted write. Neither is a document, and re-encoding either would
    // only produce a differently-broken file.
    if (name.endsWith(".bad") || name.endsWith(".tmp") || name.endsWith(".part")) continue;
    convertFile(join(backupDir(), name), toEncrypted, key);
  }

  // The previous-save fallback, which lives beside the live file rather than in
  // backups/ and so is not reached by either loop above.
  for (const suffix of [".prev", ".prev.enc"]) {
    const path = `${dataFile()}${suffix}`;
    if (existsSync(path)) convertFile(path, toEncrypted, key);
  }
}

function convertFile(path: string, toEncrypted: boolean, key: Buffer): void {
  const blob = readFileSync(path);
  if (isEncrypted(blob) === toEncrypted) return; // Already in the era we want.

  let json: string;
  try {
    json = toEncrypted ? blob.toString("utf8") : decryptJson(key, blob);
    // Parsed, not merely decoded. Converting a file that was already damaged
    // would produce a well-formed encryption of rubbish, and quietly turn a
    // recognisably-broken snapshot into one that looks fine until it is needed.
    JSON.parse(json);
  } catch {
    console.warn(`Leaving ${path} as it is — it isn't a document this can convert.`);
    return;
  }

  const next = toEncrypted ? `${path}.enc` : path.replace(/\.enc$/, "");
  if (next === path) return;

  writeFileAtomic(next, toEncrypted ? encryptJson(key, json) : Buffer.from(json, "utf8"));

  // Read back before the original goes anywhere. This is the whole safety of
  // the conversion: until this succeeds, the file that was there is still there.
  const written = readFileSync(next);
  const check = toEncrypted ? decryptJson(key, written) : written.toString("utf8");
  if (check !== json) {
    unlinkSync(next);
    throw new Error(`Converting ${path} didn't produce a readable file, so nothing was removed.`);
  }
  unlinkSync(path);
}

/**
 * A document read without unlocking, for nothing. Kept as the single place that
 * knows locking makes reads fail, so callers can ask rather than catch.
 */
export function requireUnlocked(): DataDoc {
  if (isEnabled() && !isUnlocked())
    throw new CryptoError("wrong-passphrase", "Casebook is locked.");
  return loadDoc();
}

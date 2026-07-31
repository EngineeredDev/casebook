/**
 * The cryptography behind the optional passphrase, and nothing else — no
 * filesystem, no Electron, no policy about when any of it runs. That lives in
 * encryption.ts; this file is the part that has to be right in isolation.
 *
 * **Envelope, not direct encryption.** A random 32-byte data key encrypts every
 * file, and the passphrase never touches a snapshot. It only wraps that data
 * key. The alternative — deriving a file key from the passphrase — means
 * changing the passphrase re-encrypts the entire backup history, which is a
 * long operation over the user's whole record that must not be interrupted, on
 * the exact code path where a mistake destroys everything at once. Wrapping
 * makes a passphrase change a rewrite of one small file, and leaves every
 * snapshot ever taken readable.
 *
 * The data key is wrapped twice, independently: once by a key derived from the
 * passphrase, and once by a recovery key printed at enable time. Either opens
 * it; neither can be computed from the other. That second wrap is the whole
 * mitigation for the failure this feature introduces — a forgotten passphrase —
 * and it is why the recovery sheet is not optional in the UI.
 *
 * **No Keychain, deliberately.** Electron's `safeStorage` ties its key to the
 * app's code signature, and this app is ad-hoc signed, so every self-update is
 * a different app as far as the Keychain is concerned. Best case that is a
 * system password prompt after each update; worst case Chromium silently
 * generates a fresh key and everything encrypted under the old one is gone for
 * good. A passphrase typed once per launch has none of that, and is stronger.
 */

import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";

/**
 * scrypt, at OWASP's interactive parameters. Node has it built in, which is the
 * other half of why it was chosen: a native Argon2 module would have to be kept
 * binary-compatible with every Electron upgrade, and a module that fails to
 * load is a data folder that cannot be opened.
 *
 * N=2^17 with r=8 asks for 128 MiB — comfortably above Node's 32 MiB default
 * for `maxmem`, which is why that is passed explicitly. Getting it wrong throws
 * rather than silently weakening anything.
 */
const KDF = { name: "scrypt", N: 2 ** 17, r: 8, p: 1, keyLength: 32 } as const;
const KDF_MAXMEM = 192 * 1024 * 1024;

const SALT_BYTES = 16;
const DEK_BYTES = 32;
/** 96 bits, the size AES-GCM is defined for; anything else forces re-hashing. */
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const CIPHER = "aes-256-gcm";

/**
 * `*.json.enc` starts with this, so a file's era is decidable from its first
 * bytes rather than from its name. `backups/` legitimately holds both — the
 * snapshots from before encryption was switched on stay exactly as they were —
 * and every reader has to be able to tell them apart without guessing.
 */
const MAGIC = Buffer.from("CASEBOOK", "ascii");
const FORMAT_VERSION = 1;
/** magic + version, authenticated as additional data so neither can be edited. */
const HEADER_BYTES = MAGIC.length + 1;

/** 16 bytes of key material, which is 26 characters once encoded. */
const RECOVERY_BYTES = 16;
/** Crockford's alphabet: no I, L, O or U — nothing that can be misread aloud or in handwriting. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export type CryptoFailure =
  /** The passphrase is wrong. Indistinguishable, by design, from a tampered wrap. */
  | "wrong-passphrase"
  | "wrong-recovery-key"
  /** The recovery key isn't the right shape — worth saying, since it's transcribed by hand. */
  | "malformed-recovery-key"
  /** The bytes are not what they claim to be: truncated, edited, or never ours. */
  | "corrupt"
  /** Written by a newer Casebook than this one. */
  | "unsupported-version";

/**
 * Everything that goes wrong here is something the UI has to phrase differently,
 * so the kind travels with the error rather than being recovered from a message.
 */
export class CryptoError extends Error {
  constructor(
    readonly kind: CryptoFailure,
    message: string,
  ) {
    super(message);
    this.name = "CryptoError";
  }
}

/** One wrapped copy of the data key. Base64 because the keyfile is JSON. */
export interface Wrap {
  salt: string;
  nonce: string;
  tag: string;
  ciphertext: string;
}

/**
 * `keyfile.json`. Kept in the data folder, alongside what it unlocks, and copied
 * into `backups/` and out to the mirror — an offsite backup that needs a file
 * which only ever existed on the machine that died is not a backup.
 *
 * It holds no secret. Both wraps are useless without a passphrase or the
 * recovery key, so it travels wherever the data travels without weakening it.
 */
export interface Keyfile {
  casebook: "keyfile";
  version: 1;
  kdf: { name: "scrypt"; N: number; r: number; p: number; keyLength: number };
  wraps: { passphrase: Wrap; recovery: Wrap };
  createdAt: string;
}

function derive(secret: string, salt: Buffer, params: Keyfile["kdf"]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // The async form, because the synchronous one blocks for a second or more.
    // On the main process that is a frozen window and a bridge that answers
    // nothing — during unlock, which is the first thing anyone sees.
    scrypt(
      secret.normalize("NFKC"),
      salt,
      params.keyLength,
      { N: params.N, r: params.r, p: params.p, maxmem: KDF_MAXMEM },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

function wrap(key: Buffer, salt: Buffer, dek: Buffer): Wrap {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(CIPHER, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
  return {
    salt: salt.toString("base64"),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function unwrap(key: Buffer, entry: Wrap, failure: CryptoFailure): Buffer {
  const decipher = createDecipheriv(CIPHER, key, Buffer.from(entry.nonce, "base64"));
  decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(entry.ciphertext, "base64")),
      decipher.final(),
    ]);
  } catch {
    // GCM refuses to return anything it cannot authenticate, so a wrong key and
    // an edited wrap fail identically — which is the property that makes this
    // the passphrase check as well as the unwrap.
    throw new CryptoError(failure, "That didn't unlock the data key.");
  }
}

/**
 * A new data key, wrapped both ways. The returned recovery key is the only time
 * it exists in a readable form anywhere: it is derived from nothing and stored
 * nowhere, so if it is not written down at this moment it is not recoverable.
 */
export async function createKeyfile(
  passphrase: string,
): Promise<{ keyfile: Keyfile; dek: Buffer; recoveryKey: string }> {
  const dek = randomBytes(DEK_BYTES);
  const recoveryKey = generateRecoveryKey();

  const passphraseSalt = randomBytes(SALT_BYTES);
  const recoverySalt = randomBytes(SALT_BYTES);
  const [passphraseKey, recoveryDerived] = await Promise.all([
    derive(passphrase, passphraseSalt, KDF),
    derive(canonicalRecoveryKey(recoveryKey), recoverySalt, KDF),
  ]);

  const keyfile: Keyfile = {
    casebook: "keyfile",
    version: 1,
    kdf: { ...KDF },
    wraps: {
      passphrase: wrap(passphraseKey, passphraseSalt, dek),
      recovery: wrap(recoveryDerived, recoverySalt, dek),
    },
    createdAt: new Date().toISOString(),
  };

  passphraseKey.fill(0);
  recoveryDerived.fill(0);
  return { keyfile, dek, recoveryKey };
}

export async function unlockWithPassphrase(keyfile: Keyfile, passphrase: string): Promise<Buffer> {
  const entry = keyfile.wraps.passphrase;
  const key = await derive(passphrase, Buffer.from(entry.salt, "base64"), keyfile.kdf);
  try {
    return unwrap(key, entry, "wrong-passphrase");
  } finally {
    key.fill(0);
  }
}

export async function unlockWithRecoveryKey(
  keyfile: Keyfile,
  recoveryKey: string,
): Promise<Buffer> {
  const canonical = canonicalRecoveryKey(recoveryKey);
  const entry = keyfile.wraps.recovery;
  const key = await derive(canonical, Buffer.from(entry.salt, "base64"), keyfile.kdf);
  try {
    return unwrap(key, entry, "wrong-recovery-key");
  } finally {
    key.fill(0);
  }
}

/**
 * A new passphrase over the same data key. Every snapshot ever written stays
 * readable, and the recovery sheet printed at enable time keeps working —
 * it wraps the data key, which is the thing that did not change.
 */
export async function rewrapPassphrase(
  keyfile: Keyfile,
  dek: Buffer,
  passphrase: string,
): Promise<Keyfile> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(passphrase, salt, KDF);
  try {
    return {
      ...keyfile,
      // Re-stated at current parameters: a keyfile made by an older version
      // gets today's cost the next time the passphrase is set, rather than
      // being pinned to whatever was recommended when it was created.
      kdf: { ...KDF },
      wraps: { ...keyfile.wraps, passphrase: wrap(key, salt, dek) },
    };
  } finally {
    key.fill(0);
  }
}

/* ---------- the file format ---------- */

/**
 * `magic | version | nonce | tag | ciphertext`, with the header authenticated
 * as additional data. Fixed-width and front-loaded so a reader can decide what
 * it is holding from the first nine bytes without parsing anything.
 */
export function encryptJson(dek: Buffer, json: string): Buffer {
  const header = Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION])]);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(CIPHER, dek, nonce);
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  return Buffer.concat([header, nonce, cipher.getAuthTag(), ciphertext]);
}

export function decryptJson(dek: Buffer, blob: Buffer): string {
  if (!isEncrypted(blob)) {
    throw new CryptoError("corrupt", "That file isn't an encrypted Casebook file.");
  }
  const version = blob[MAGIC.length];
  if (version !== FORMAT_VERSION) {
    throw new CryptoError(
      "unsupported-version",
      `This file was written by a newer version of Casebook (format ${String(version)}).`,
    );
  }
  const header = blob.subarray(0, HEADER_BYTES);
  const nonce = blob.subarray(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES);
  const tag = blob.subarray(HEADER_BYTES + NONCE_BYTES, HEADER_BYTES + NONCE_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(HEADER_BYTES + NONCE_BYTES + TAG_BYTES);
  if (nonce.length < NONCE_BYTES || tag.length < TAG_BYTES) {
    throw new CryptoError("corrupt", "That file is too short to be a complete Casebook file.");
  }

  const decipher = createDecipheriv(CIPHER, dek, nonce);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new CryptoError("corrupt", "That file couldn't be decrypted with this data key.");
  }
}

/** Whether a file is one of ours and encrypted, decided from its first bytes. */
export function isEncrypted(blob: Buffer): boolean {
  return blob.length >= HEADER_BYTES && blob.subarray(0, MAGIC.length).equals(MAGIC);
}

/* ---------- the recovery key ---------- */

function generateRecoveryKey(): string {
  const bytes = randomBytes(RECOVERY_BYTES);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(value >>> bits) & 31];
    }
  }
  // 128 bits is not a multiple of five, so the last character carries the
  // remaining three bits padded with zeroes.
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return groupsOfFive(out);
}

function groupsOfFive(raw: string): string {
  const groups: string[] = [];
  for (let i = 0; i < raw.length; i += 5) groups.push(raw.slice(i, i + 5));
  // 26 characters leaves a stray single character at the end; it joins the
  // group before it rather than standing alone, which reads as a typo.
  if (groups.length > 1 && groups.at(-1)!.length < 3) {
    const tail = groups.pop()!;
    groups[groups.length - 1] += tail;
  }
  return groups.join("-");
}

/**
 * What actually gets fed to the KDF: the key as typed, reduced to the only form
 * that matters. Dashes and spaces are cosmetic, case is not significant, and
 * Crockford defines I and L as 1 and O as 0 precisely because a key read off
 * paper will be transcribed by someone who cannot tell them apart.
 */
export function canonicalRecoveryKey(typed: string): string {
  const cleaned = typed
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (cleaned.length === 0 || ![...cleaned].every((c) => CROCKFORD.includes(c))) {
    throw new CryptoError(
      "malformed-recovery-key",
      "That doesn't look like a recovery key. It's 26 letters and digits, in groups of five.",
    );
  }
  return cleaned;
}

/* ---------- reading a keyfile off disk ---------- */

/**
 * A keyfile that parsed as JSON is not yet a keyfile. Everything here is
 * reached by way of a file that travels between machines, through a mirror
 * folder, and possibly a cloud sync — so it is validated rather than cast, and
 * a bad one says so instead of throwing somewhere further in on a base64 decode
 * of `undefined`.
 */
export function parseKeyfile(raw: unknown): Keyfile {
  const bad = (why: string): never => {
    throw new CryptoError("corrupt", `keyfile.json ${why}`);
  };
  if (typeof raw !== "object" || raw === null) return bad("isn't an object.");
  const candidate = raw as Keyfile;
  if (candidate.casebook !== "keyfile") return bad("isn't a Casebook keyfile.");
  if (candidate.version !== 1) {
    throw new CryptoError(
      "unsupported-version",
      `keyfile.json was written by a newer version of Casebook (version ${String(candidate.version)}).`,
    );
  }

  const { kdf, wraps } = candidate;
  if (typeof kdf !== "object" || kdf === null || kdf.name !== "scrypt") {
    return bad("names a key-derivation function this version can't use.");
  }
  for (const field of ["N", "r", "p", "keyLength"] as const) {
    if (!Number.isInteger(kdf[field]) || kdf[field] <= 0) return bad(`has a bad ${field}.`);
  }
  // scrypt is only defined for a power-of-two cost. Without this the failure
  // arrives from inside node:crypto as a generic error, on the unlock screen,
  // wearing none of the context that would explain it.
  if ((kdf.N & (kdf.N - 1)) !== 0) return bad("has a cost that isn't a power of two.");
  // A hostile or corrupted keyfile could otherwise name parameters that ask for
  // more memory than the process can have, which fails as a crash rather than
  // as a message about a file.
  if (128 * kdf.N * kdf.r > KDF_MAXMEM) return bad("asks for more memory than Casebook allows.");

  if (typeof wraps !== "object" || wraps === null) return bad("has no wrapped keys in it.");
  for (const which of ["passphrase", "recovery"] as const) {
    const entry = wraps[which];
    if (typeof entry !== "object" || entry === null) return bad(`has no ${which} key in it.`);
    for (const field of ["salt", "nonce", "tag", "ciphertext"] as const) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        return bad(`has a bad ${which} ${field}.`);
      }
    }
  }
  return candidate;
}

/**
 * The one part of this app where a bug is unrecoverable.
 *
 * Everywhere else a mistake costs some work and a restore from a snapshot. Here
 * a mistake means the snapshots are the thing that cannot be read — so these
 * tests lean on the properties that would let that happen quietly: that the
 * recovery key really is a second, independent way in; that changing the
 * passphrase does not strand the history; and that every way of getting it
 * wrong fails loudly and distinguishably rather than returning plausible bytes.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  canonicalRecoveryKey,
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

const PASSPHRASE = "correct horse battery staple";

/**
 * scrypt at these parameters costs a few hundred milliseconds a call, which is
 * the point of it. One keyfile is made for the whole file and the tests that
 * need their own say so — otherwise the suite spends most of its time proving
 * that key derivation is slow.
 */
let shared: Awaited<ReturnType<typeof createKeyfile>>;
beforeAll(async () => {
  shared = await createKeyfile(PASSPHRASE);
}, 30_000);

/** The kind, not the message — that is the whole reason CryptoError carries one. */
async function failureKind(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof CryptoError) return error.kind;
    throw error;
  }
  throw new Error("Expected that to fail, and it didn't.");
}

/** The same, for the halves that need no key derivation and so aren't async. */
function failureKindOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof CryptoError) return error.kind;
    throw error;
  }
  throw new Error("Expected that to fail, and it didn't.");
}

/** Flip one bit, without tripping over `noUncheckedIndexedAccess` on a Buffer. */
function corrupted(blob: Buffer, index: number): Buffer {
  const copy = Buffer.from(blob);
  copy.writeUInt8(copy.readUInt8(index) ^ 1, index);
  return copy;
}

describe("a new keyfile", () => {
  it("produces a 32-byte data key and a written-down recovery key", () => {
    expect(shared.dek).toHaveLength(32);
    // 26 characters of Crockford, grouped for transcription. Whoever reads this
    // off a sheet of paper is the reason for the grouping and for the alphabet.
    expect(shared.recoveryKey.replace(/-/g, "")).toHaveLength(26);
    expect(shared.recoveryKey).toMatch(/^[0-9A-HJKMNP-TV-Z-]+$/);
    expect(shared.recoveryKey).toContain("-");
  });

  it("holds no secret itself", () => {
    // The keyfile travels with the data: into backups/, out to the mirror, and
    // one day to a cloud folder. If the data key were recoverable from it, all
    // of that would be shipping the lock and the key in the same envelope.
    const serialized = JSON.stringify(shared.keyfile);
    expect(serialized).not.toContain(shared.dek.toString("base64"));
    expect(serialized).not.toContain(shared.recoveryKey);
    expect(serialized).not.toContain(shared.recoveryKey.replace(/-/g, ""));
    expect(serialized).not.toContain(PASSPHRASE);
  });

  it("is never the same twice", async () => {
    const other = await createKeyfile(PASSPHRASE);
    expect(other.dek.equals(shared.dek)).toBe(false);
    expect(other.recoveryKey).not.toBe(shared.recoveryKey);
    expect(other.keyfile.wraps.passphrase.salt).not.toBe(shared.keyfile.wraps.passphrase.salt);
  });
});

describe("unlocking", () => {
  it("returns the same data key for the right passphrase", async () => {
    const dek = await unlockWithPassphrase(shared.keyfile, PASSPHRASE);
    expect(dek.equals(shared.dek)).toBe(true);
  });

  it("refuses the wrong passphrase", async () => {
    expect(await failureKind(() => unlockWithPassphrase(shared.keyfile, "not it"))).toBe(
      "wrong-passphrase",
    );
    // Including the near-miss: a passphrase off by one character has to fail
    // exactly as hard as one that is nothing like it.
    expect(await failureKind(() => unlockWithPassphrase(shared.keyfile, PASSPHRASE + " "))).toBe(
      "wrong-passphrase",
    );
  });

  it("opens with the recovery key instead", async () => {
    const dek = await unlockWithRecoveryKey(shared.keyfile, shared.recoveryKey);
    expect(dek.equals(shared.dek)).toBe(true);
  });

  it("accepts a recovery key transcribed by a human", async () => {
    // Every one of these is what someone actually types from a printed sheet.
    // Crockford's alphabet exists so that reading I for 1 or O for 0 is not a
    // failure, and none of that helps unless the parsing honours it.
    //
    // Checked at the normalizing step rather than by unlocking seven times:
    // each unlock is a full scrypt derivation, and what is actually in question
    // here is whether these all name the same key — not whether AES works.
    const canonical = canonicalRecoveryKey(shared.recoveryKey);
    const typed = [
      shared.recoveryKey.toLowerCase(),
      shared.recoveryKey.replace(/-/g, ""),
      shared.recoveryKey.replace(/-/g, " "),
      `  ${shared.recoveryKey}  `,
      shared.recoveryKey.replace(/1/g, "I"),
      shared.recoveryKey.replace(/1/g, "l"),
      shared.recoveryKey.replace(/0/g, "O"),
    ];
    for (const attempt of typed) {
      expect(canonicalRecoveryKey(attempt), `failed for ${attempt}`).toBe(canonical);
    }

    // And once end to end, from the messiest form, so the normalizing is
    // actually wired to the unlock rather than merely agreeing with itself.
    const messy = `  ${shared.recoveryKey.toLowerCase().replace(/-/g, " ")}  `;
    expect((await unlockWithRecoveryKey(shared.keyfile, messy)).equals(shared.dek)).toBe(true);
  });

  it("tells a mistyped recovery key from a wrong one", async () => {
    // Worth separating: one means "check what you typed", the other means "that
    // is not the sheet for this data", and they need different words on screen.
    expect(await failureKind(() => unlockWithRecoveryKey(shared.keyfile, "not-a-key!"))).toBe(
      "malformed-recovery-key",
    );
    expect(await failureKind(() => unlockWithRecoveryKey(shared.keyfile, ""))).toBe(
      "malformed-recovery-key",
    );
    const wrongButValid = "ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZZ";
    expect(await failureKind(() => unlockWithRecoveryKey(shared.keyfile, wrongButValid))).toBe(
      "wrong-recovery-key",
    );
  });

  it("rejects U, which Crockford leaves out on purpose", () => {
    // Excluded so that no generated key can spell anything unfortunate, and
    // silently accepting it would mean two spellings of the same key.
    expect(() => canonicalRecoveryKey("UUUUU-UUUUU-UUUUU-UUUUU-UUUUUU")).toThrow(CryptoError);
  });

  it("wants all 26 characters, which is what it says it wants", () => {
    // A key is one length and only one, so anything shorter or longer is a
    // transcription mistake and has to be told apart from a key off the wrong
    // sheet — that distinction is the entire reason there are two failure kinds.
    // Any length used to be accepted, so someone who typed four groups and
    // pressed return was told the key was wrong, which sends her looking for a
    // different sheet instead of at the line she is on.
    const raw = shared.recoveryKey.replace(/-/g, "");
    expect(failureKindOf(() => canonicalRecoveryKey(raw.slice(0, 25)))).toBe(
      "malformed-recovery-key",
    );
    expect(failureKindOf(() => canonicalRecoveryKey(raw.slice(0, 5)))).toBe(
      "malformed-recovery-key",
    );
    expect(failureKindOf(() => canonicalRecoveryKey(`${raw}Z`))).toBe("malformed-recovery-key");
    expect(failureKindOf(() => canonicalRecoveryKey(`${raw}${raw}`))).toBe(
      "malformed-recovery-key",
    );

    // And the real thing, at full length, still normalizes to itself.
    expect(canonicalRecoveryKey(shared.recoveryKey)).toBe(raw);
    expect(raw).toHaveLength(26);
  });
});

describe("changing the passphrase", () => {
  let rewrapped: Keyfile;
  beforeAll(async () => {
    rewrapped = await rewrapPassphrase(shared.keyfile, shared.dek, "a completely different one");
  }, 30_000);

  it("keeps the same data key, so nothing already written needs re-encrypting", async () => {
    const dek = await unlockWithPassphrase(rewrapped, "a completely different one");
    expect(dek.equals(shared.dek)).toBe(true);
  });

  it("stops the old passphrase working", async () => {
    expect(await failureKind(() => unlockWithPassphrase(rewrapped, PASSPHRASE))).toBe(
      "wrong-passphrase",
    );
  });

  it("leaves the recovery sheet valid", async () => {
    // The sheet was printed once, at enable time, and may be in a drawer. A
    // passphrase change that quietly invalidated it would remove the only
    // safety net this feature has, at the moment nobody is looking.
    const dek = await unlockWithRecoveryKey(rewrapped, shared.recoveryKey);
    expect(dek.equals(shared.dek)).toBe(true);
  });
});

describe("the file format", () => {
  const plaintext = JSON.stringify({ students: [{ name: "Régine —" }], note: "🩺" });

  it("round-trips, including text that isn't ASCII", () => {
    const blob = encryptJson(shared.dek, plaintext);
    expect(decryptJson(shared.dek, blob)).toBe(plaintext);
  });

  it("looks like nothing, twice over", () => {
    const blob = encryptJson(shared.dek, plaintext);
    // No plaintext anywhere in it, and two encryptions of the same document
    // differ — a fixed nonce would leak that a file had not changed, which over
    // a folder of daily snapshots is a diary of which days had entries in them.
    expect(blob.toString("latin1")).not.toContain("Régine");
    expect(blob.toString("utf8")).not.toContain("students");
    expect(encryptJson(shared.dek, plaintext).equals(blob)).toBe(false);
  });

  it("is identifiable without being readable", () => {
    // backups/ legitimately holds both eras at once. Deciding which is which
    // from the bytes rather than the filename is what lets a restore offer a
    // pre-encryption snapshot and a post-encryption one in the same list.
    expect(isEncrypted(encryptJson(shared.dek, plaintext))).toBe(true);
    expect(isEncrypted(Buffer.from(plaintext, "utf8"))).toBe(false);
    expect(isEncrypted(Buffer.alloc(0))).toBe(false);
    expect(isEncrypted(Buffer.from("CASEBOO", "ascii"))).toBe(false);
  });

  it("refuses the wrong data key", async () => {
    const other = await createKeyfile("someone else's");
    const blob = encryptJson(shared.dek, plaintext);
    expect(failureKindOf(() => decryptJson(other.dek, blob))).toBe("corrupt");
  });

  it("notices every kind of tampering", () => {
    const original = encryptJson(shared.dek, plaintext);

    // The last byte of the ciphertext.
    expect(
      failureKindOf(() => decryptJson(shared.dek, corrupted(original, original.length - 1))),
    ).toBe("corrupt");

    // The nonce is not secret and is not itself authenticated, but changing it
    // makes the tag fail to verify — the same outcome by a different route.
    expect(failureKindOf(() => decryptJson(shared.dek, corrupted(original, 10)))).toBe("corrupt");

    // The magic, which is what decides the file is ours at all.
    expect(failureKindOf(() => decryptJson(shared.dek, corrupted(original, 0)))).toBe("corrupt");

    // A version this build doesn't know needs its own answer: "a newer Casebook
    // wrote this" is a different problem from "this file is damaged", and
    // telling someone to restore from a backup would be the wrong advice.
    const future = Buffer.from(original);
    future.writeUInt8(99, 8);
    expect(failureKindOf(() => decryptJson(shared.dek, future))).toBe("unsupported-version");

    // Truncation at every boundary: mid-header, exactly the header, mid-nonce,
    // mid-tag, and a complete header with nothing after it.
    for (const length of [0, 8, 9, 20, 36, 37]) {
      expect(
        failureKindOf(() => decryptJson(shared.dek, original.subarray(0, length))),
        `truncated to ${length} bytes`,
      ).toBe("corrupt");
    }
  });
});

describe("reading a keyfile off disk", () => {
  it("accepts one it wrote", () => {
    const roundTripped: unknown = JSON.parse(JSON.stringify(shared.keyfile));
    expect(parseKeyfile(roundTripped)).toEqual(shared.keyfile);
  });

  it("rejects anything that isn't one", () => {
    for (const junk of [null, 42, "keyfile", [], {}, { casebook: "data" }]) {
      expect(
        failureKindOf(() => parseKeyfile(junk)),
        JSON.stringify(junk),
      ).toBe("corrupt");
    }
  });

  it("says so when a newer Casebook wrote it", () => {
    const future = { ...shared.keyfile, version: 2 };
    expect(failureKindOf(() => parseKeyfile(future))).toBe("unsupported-version");
  });

  it("rejects damaged or hostile parameters", () => {
    const cases: Record<string, unknown> = {
      "no kdf": { ...shared.keyfile, kdf: null },
      "a KDF we don't have": {
        ...shared.keyfile,
        kdf: { ...shared.keyfile.kdf, name: "argon2id" },
      },
      "a nonsense cost": { ...shared.keyfile, kdf: { ...shared.keyfile.kdf, N: 0 } },
      "a cost scrypt isn't defined for": {
        ...shared.keyfile,
        kdf: { ...shared.keyfile.kdf, N: 3 },
      },
      // Left unchecked this is not a bad message, it is the process dying:
      // scrypt asked for tens of gigabytes.
      "a ruinous cost": { ...shared.keyfile, kdf: { ...shared.keyfile.kdf, N: 2 ** 30 } },
      "no wraps": { ...shared.keyfile, wraps: null },
      "no recovery wrap": {
        ...shared.keyfile,
        wraps: { passphrase: shared.keyfile.wraps.passphrase },
      },
      "an empty tag": {
        ...shared.keyfile,
        wraps: {
          ...shared.keyfile.wraps,
          passphrase: { ...shared.keyfile.wraps.passphrase, tag: "" },
        },
      },
    };
    for (const [why, candidate] of Object.entries(cases)) {
      expect(
        failureKindOf(() => parseKeyfile(candidate)),
        why,
      ).toBe("corrupt");
    }
  });

  it("refuses a keyfile that would take an afternoon to open", () => {
    // The memory ceiling bounds N and r and says nothing about p, which buys
    // time for free. This is the damage with no symptom to report: not a crash
    // and not a message, just a passphrase she typed correctly and an unlock
    // screen that never comes back, on the one file she cannot work around.
    for (const p of [17, 1024, 2 ** 20, Number.MAX_SAFE_INTEGER]) {
      expect(
        failureKindOf(() => parseKeyfile({ ...shared.keyfile, kdf: { ...shared.keyfile.kdf, p } })),
        `p=${String(p)}`,
      ).toBe("corrupt");
    }
  });

  it("refuses a key size AES-256 can't take", () => {
    // A 16-byte key derives fine and then reaches `createDecipheriv`, which
    // answers with a bare "Invalid key length" from inside node:crypto — an
    // unhandled error on the unlock screen, wearing nothing that names the file
    // it came out of or suggests what to do about it.
    for (const keyLength of [16, 24, 31, 33, 64]) {
      expect(
        failureKindOf(() =>
          parseKeyfile({ ...shared.keyfile, kdf: { ...shared.keyfile.kdf, keyLength } }),
        ),
        `keyLength=${String(keyLength)}`,
      ).toBe("corrupt");
    }
  });

  it("refuses wraps whose parts decode to the wrong number of bytes", () => {
    // Base64 that isn't base64 does not fail — `Buffer.from` drops what it
    // cannot read and returns the rest — so every one of these looks like a
    // perfectly good string and only stops being one after it is decoded. A
    // short nonce and a short tag are both raw exceptions out of node:crypto
    // rather than a sentence about a damaged file, and a salt of the wrong
    // length derives a key that will never open anything, which reads to her as
    // a passphrase she has apparently forgotten.
    const b64 = (bytes: number): string => Buffer.alloc(bytes, 7).toString("base64");
    const cases: Record<string, Record<string, string>> = {
      "a short salt": { salt: b64(8) },
      "a long salt": { salt: b64(32) },
      "a short nonce": { nonce: b64(8) },
      "a nonce sized like a block": { nonce: b64(16) },
      "a short tag": { tag: b64(8) },
      "a long tag": { tag: b64(32) },
      "a salt that isn't base64 at all": { salt: "!!!!!!!!!!!!!!!!!!!!!!!!" },
    };
    for (const [why, patch] of Object.entries(cases)) {
      const candidate = {
        ...shared.keyfile,
        wraps: {
          ...shared.keyfile.wraps,
          passphrase: { ...shared.keyfile.wraps.passphrase, ...patch },
        },
      };
      expect(
        failureKindOf(() => parseKeyfile(candidate)),
        why,
      ).toBe("corrupt");

      // And the same damage in the recovery wrap, which is the half nobody looks
      // at until it is the only way in.
      const recovery = {
        ...shared.keyfile,
        wraps: {
          ...shared.keyfile.wraps,
          recovery: { ...shared.keyfile.wraps.recovery, ...patch },
        },
      };
      expect(
        failureKindOf(() => parseKeyfile(recovery)),
        `recovery: ${why}`,
      ).toBe("corrupt");
    }
  });
});

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { MassDeletion, SnapshotSummary } from "../shared/api.ts";
import { DATA_VERSION, emptyDoc, type DataDoc, type Entry } from "../shared/types.ts";
import { writeFileAtomic } from "./atomic.ts";
import { backupDir, dataDir, dataDirIsConfigured, dataFile } from "./paths.ts";
import type { MirrorSource } from "./mirror.ts";
import {
  classify,
  dailyName,
  dayStamp,
  intervalName,
  minuteStamp,
  newestFirst,
  snapshotsToPrune,
  type Snapshot,
} from "./snapshots.ts";

/** At most one interval snapshot per fifteen minutes of actual editing. */
const INTERVAL_MS = 15 * 60 * 1000;

/**
 * How documents become bytes on the way to disk.
 *
 * A seam rather than a branch, so that nothing in this file has to know whether
 * encryption is on. When it is, encryption.ts installs a codec that encrypts
 * and appends `.enc`; the snapshot tiers, the retention rules and the restore
 * scan are then unchanged and untouched by it, which is the point — the phase
 * that adds a way to lose data should add as little new code to the phase that
 * prevents it as possible.
 */
export interface DocumentCodec {
  /** Appended to every filename this codec writes. */
  suffix: "" | ".enc";
  encode(json: string): Buffer;
  /** Throws if the bytes aren't something this codec can read. */
  decode(blob: Buffer): string;
}

/**
 * The magic an encrypted file starts with, duplicated here rather than imported
 * so that the plaintext path has no dependency on the crypto module at all —
 * this check runs at every launch, including the launches where encryption has
 * never been switched on.
 */
const ENCRYPTED_MAGIC = "CASEBOOK";

export class LockedError extends Error {
  constructor() {
    super("This data is encrypted. Casebook needs the passphrase before it can read it.");
    this.name = "LockedError";
  }
}

const PLAIN: DocumentCodec = {
  suffix: "",
  encode: (json) => Buffer.from(json, "utf8"),
  decode: (blob) => {
    if (blob.subarray(0, ENCRYPTED_MAGIC.length).toString("ascii") === ENCRYPTED_MAGIC) {
      // Reached by opening an encrypted folder before unlocking, and by a
      // restore that meets an encrypted snapshot from a locked session. Both
      // want the unlock screen, not a parse error.
      throw new LockedError();
    }
    return blob.toString("utf8");
  },
};

let codec: DocumentCodec = PLAIN;

/** Install the encrypting codec, or pass null to go back to plain files. */
export function setCodec(next: DocumentCodec | null): void {
  codec = next ?? PLAIN;
}

export function isEncrypting(): boolean {
  return codec.suffix === ".enc";
}

/* ---------- reading ---------- */

/**
 * Wrap a v1 plain-text note as HTML. Every v1 note is plain text by
 * construction — the old field was a plain input — so escaping is unconditional
 * and needs no HTML sniffing. Blank lines become paragraphs, single newlines
 * become breaks, matching how the old textarea rendered.
 */
function plainToHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${esc(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/**
 * A document mid-migration, which by definition is not a `DataDoc` yet — its
 * version is whichever era wrote it. `DataDoc & { version: number }` would not
 * do: the intersection narrows straight back to the current version and the
 * chain below stops compiling against its own earlier steps.
 */
type Versioned = Omit<DataDoc, "version"> & { version: number };

/**
 * Enough of a shape to migrate and then use. Deliberately looser than
 * `isDataDoc` in ipc.ts, which guards documents arriving from the renderer and
 * so insists on the current version — a file on disk is allowed to be older.
 *
 * Without this, a data.json that parses as JSON but isn't a Casebook document
 * travels all the way to the renderer, where the first `doc.students.length`
 * throws and — there being no error boundary — leaves a white window. A file
 * that isn't the thing it claims to be is exactly as unusable as one that isn't
 * valid JSON, and should fail in the same place.
 */
function looksLikeDoc(raw: unknown): raw is Versioned {
  if (typeof raw !== "object" || raw === null) return false;
  const d = raw as DataDoc;
  return (
    typeof d.version === "number" &&
    typeof d.rev === "number" &&
    Array.isArray(d.categories) &&
    Array.isArray(d.students) &&
    Array.isArray(d.entries) &&
    typeof d.settings === "object" &&
    d.settings !== null
  );
}

/** v1 → v2: notes were plain text and became HTML. */
function notesToHtml(raw: Versioned): Versioned {
  return {
    ...raw,
    version: 2,
    entries: raw.entries.map((e: Entry) => {
      if (typeof e.note !== "string" || !e.note.trim()) {
        const { note: _drop, ...rest } = e;
        return rest;
      }
      return { ...e, note: plainToHtml(e.note) };
    }),
  };
}

/**
 * v2 → v3: the import workbench gained somewhere to remember what her type
 * phrases mean. Nothing to convert — a document that has never imported
 * anything simply has no mappings, and leaving the field absent rather than
 * writing an empty object keeps a migrated file byte-identical to an
 * unmigrated one apart from the version.
 */
function addImportMappings(raw: Versioned): Versioned {
  return { ...raw, version: 3 };
}

/**
 * Forward one step at a time, so a document from any era arrives at the
 * current one. A chain rather than a switch on the source version: the v1
 * document that has been sitting in someone's backups folder since before
 * notes were HTML has to pass through v2's conversion on its way to v3, and a
 * flat mapping from 1 to 3 would either duplicate that work or forget it.
 */
function migrate(raw: Versioned): DataDoc {
  let doc: Versioned = raw;
  if (doc.version === 1) doc = notesToHtml(doc);
  if (doc.version === 2) doc = addImportMappings(doc);
  // Anything left is either from the future — a newer Casebook wrote it — or a
  // version that never existed. Both are refusals rather than guesses.
  if (doc.version !== DATA_VERSION) throw new Error(`Unsupported data version: ${raw.version}`);
  // Returned by identity rather than rebuilt, because `loadDoc` tells "this was
  // migrated" from "this was already current" by reference — and a fresh object
  // every launch would snapshot and re-save a document nothing had changed.
  return doc as DataDoc;
}

/** Decode, parse and validate one file. Throws for every way it can fail. */
function readDocumentFile(path: string): Versioned {
  const raw: unknown = JSON.parse(codec.decode(readFileSync(path)));
  if (!looksLikeDoc(raw)) throw new Error("it isn't a Casebook data file.");
  return raw;
}

/**
 * Where the live document is, whichever era wrote it.
 *
 * `data.json` and `data.json.enc` are never both authoritative, but both can
 * exist: switching encryption on writes one and removes the other, and an
 * interrupted switch could leave both. The encrypted one wins, because the only
 * way it exists at all is that encryption was turned on.
 */
export function liveDataFile(): string | null {
  const encrypted = `${dataFile()}.enc`;
  if (existsSync(encrypted)) return encrypted;
  if (existsSync(dataFile())) return dataFile();
  return null;
}

export function loadDoc(): DataDoc {
  const path = liveDataFile();
  if (!path) {
    /**
     * No data file usually means a new install. It means something else when
     * the folder came from the config and has since gone: renamed in Finder,
     * an external drive that isn't mounted, a synced folder that hasn't come
     * down yet. Assuming a fresh start there would open an empty app, write an
     * empty data.json into a folder that has to be created first, and offer to
     * import from an install that no longer exists — with nothing anywhere
     * saying her records had not been found.
     */
    if (dataDirIsConfigured() && !existsSync(dataDir())) {
      throw new Error(
        `the folder ${dataDir()} isn't there. If it moved, put it back — or point Casebook at its new home in Settings.`,
      );
    }
    /**
     * Written, but not snapshotted. This is initialisation rather than a save:
     * there is no work to protect yet, and taking the day's daily here would
     * spend it on an empty document — so a first day's entries would have no
     * daily behind them until tomorrow, and a folder's oldest surviving backup
     * would be a record of nothing.
     */
    const doc = emptyDoc();
    mkdirSync(dataDir(), { recursive: true });
    writeDocument(dataFile() + codec.suffix, JSON.stringify(doc, null, 2));
    return doc;
  }

  const raw = readDocumentFile(path);
  const doc = migrate(raw);
  if (doc !== raw) {
    // A dedicated snapshot, not one of the tiers — those are keyed to the day
    // and the quarter-hour, and either could already exist, which would leave a
    // migration with no way back on any day the app had already been opened.
    const dir = backupDir();
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, preservedName(`pre-v${DATA_VERSION}`));
    copyFileSync(path, dest);
    saveDoc(doc);
    console.log(
      `Migrated data.json from version ${raw.version} to ${DATA_VERSION}. ` +
        `Previous file saved to ${dest}`,
    );
  }
  return doc;
}

/**
 * A free name for a one-off snapshot that nothing may ever prune.
 *
 * Every one of these is the only copy of a state that cannot be reconstructed —
 * what the data looked like before a schema migration, or the unreadable file a
 * restore replaced — so the one thing this must not do is land on a name that
 * is already taken. The old code wrote only when the day's name was free, which
 * meant restoring a pre-v2 backup by hand on a day the app had already migrated
 * something silently skipped the snapshot. The minute narrows that; the counter
 * closes it.
 */
function preservedName(reason: string): string {
  const now = new Date();
  const base = `data-${reason}-${dayStamp(now)}-${minuteStamp(now)}`;
  const dir = backupDir();
  for (let attempt = 1; ; attempt += 1) {
    const name = `${base}${attempt === 1 ? "" : `-${attempt}`}.json${codec.suffix}`;
    if (!existsSync(join(dir, name))) return name;
  }
}

/* ---------- writing ---------- */

/**
 * The serialization of the document currently on disk, and when a snapshot was
 * last taken from it. Held so that quitting can force a final snapshot without
 * re-reading — and, more importantly, so that every snapshot is written from a
 * string this process produced rather than copied from a file whose contents
 * nothing has checked.
 */
let lastSerialized: string | null = null;
let lastIntervalAt: number | null = null;
let savedSinceSnapshot = false;

function writeDocument(path: string, serialized: string): void {
  writeFileAtomic(path, codec.encode(serialized));
}

/**
 * Write a document to the live path, in whatever era the folder is currently in.
 *
 * For the one caller that has a document as text rather than as a `DataDoc` and
 * must not go through the snapshot tiers: the legacy import, which is copying
 * another install's file in wholesale. It used to assemble `data.json` itself
 * and write it plain, which with encryption on produced a folder where
 * `data.json.enc` still won every read — so the import reported success with
 * entry counts, the app stayed empty, and a full plaintext copy of her records
 * sat in a folder she had put a passphrase on.
 *
 * Returns the path it actually wrote, because with encryption on that is not
 * the path the caller would have guessed.
 */
export function writeLiveDocument(serialized: string): string {
  mkdirSync(dataDir(), { recursive: true });
  const path = dataFile() + codec.suffix;
  writeDocument(path, serialized);
  return path;
}

export function saveDoc(next: DataDoc, previous?: DataDoc | null): void {
  // The data folder is created on demand rather than at first run, so the very
  // first save is also the one that has to make it.
  mkdirSync(dataDir(), { recursive: true });
  const serialized = JSON.stringify(next, null, 2);

  /**
   * The outgoing version, kept beside the live file.
   *
   * This is the cheapest thing in the whole plan and covers the most common
   * disaster: a save that lands but shouldn't have. Everything else is measured
   * in quarter-hours; this is measured in one save. Written before the file it
   * is a fallback for, so it can never describe a state that was never live.
   */
  if (previous) {
    writeDocument(`${dataFile()}.prev${codec.suffix}`, JSON.stringify(previous, null, 2));
  }

  writeDocument(dataFile() + codec.suffix, serialized);
  lastSerialized = serialized;
  savedSinceSnapshot = true;
  takeSnapshots(serialized, new Date());
}

/**
 * Write whichever tiers are due, then prune — but only ever from the string
 * that was just written, never by copying the file back off the disk. A blind
 * copy would faithfully preserve a data.json that something else had already
 * damaged, and fill the backups folder with unreadable snapshots.
 */
function takeSnapshots(serialized: string, now: Date): void {
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });
  let newest: string | null = null;

  const daily = dailyName(now, isEncrypting());
  if (!existsSync(join(dir, daily))) {
    writeDocument(join(dir, daily), serialized);
    newest = daily;
    // The daily is this minute's snapshot too; writing an interval beside it
    // with byte-identical contents would be two files saying one thing.
    lastIntervalAt = now.getTime();
  }

  if (lastIntervalAt === null || now.getTime() - lastIntervalAt >= INTERVAL_MS) {
    const interval = intervalName(now, isEncrypting());
    writeDocument(join(dir, interval), serialized);
    lastIntervalAt = now.getTime();
    newest = interval;
  }

  if (newest) {
    savedSinceSnapshot = false;
    prune(dir, newest);
  }
}

/**
 * A snapshot right now, whatever the tiers would have said, under a name
 * nothing ever prunes.
 *
 * For the operations that rewrite the whole folder in one go — turning
 * encryption on or off. Leaving those to the ordinary rules would mean going
 * ahead with the newest copy up to fifteen minutes stale, which is the wrong
 * trade on the one code path where a mistake reaches every file at once. The
 * name is preserved rather than dated because these happen a handful of times
 * in the life of an install, and each marks a before that cannot be rebuilt.
 */
export function forceSnapshot(doc: DataDoc, reason: string): string {
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });
  const name = preservedName(`pre-${reason}`);
  writeDocument(join(dir, name), JSON.stringify(doc, null, 2));
  return join(dir, name);
}

/**
 * A last snapshot on the way out, if anything has been saved since the last one.
 *
 * Without it, quitting at 3:10 after a snapshot at 3:00 loses ten minutes to
 * the next mishap — and quitting is exactly when the app stops being able to
 * take one later.
 */
export function snapshotOnQuit(): void {
  if (!savedSinceSnapshot || lastSerialized === null) return;
  try {
    const dir = backupDir();
    mkdirSync(dir, { recursive: true });
    const name = intervalName(new Date(), isEncrypting());
    writeDocument(join(dir, name), lastSerialized);
    savedSinceSnapshot = false;
  } catch (error) {
    // Quitting must not be preventable by a failing disk.
    console.error("Couldn't take a final snapshot:", error);
  }
}

/**
 * Delete what retention says to delete — but only once the snapshot just
 * written has been read back and parsed.
 *
 * That precondition is the point. Pruning is the only thing here that destroys
 * anything, and the state in which it would do the most damage is exactly the
 * state where new snapshots have started coming out wrong: a run of unreadable
 * files would otherwise age out every good copy behind them, one day at a time,
 * until the backups folder was full of nothing.
 */
function prune(dir: string, newest: string): void {
  try {
    readDocumentFile(join(dir, newest));
  } catch (error) {
    console.error(`Not pruning backups: ${newest} didn't read back cleanly.`, error);
    return;
  }
  try {
    for (const name of snapshotsToPrune(readdirSync(dir))) {
      unlinkSync(join(dir, name));
    }
  } catch (error) {
    // A folder that cannot be pruned is a folder that grows, which is a great
    // deal better than a save that fails.
    console.error("Couldn't prune backups:", error);
  }
}

/* ---------- the deletion tripwire ---------- */

/** More than a fifth of the roster or the log, and more than ten of them. */
const TRIPWIRE_FRACTION = 0.2;
const TRIPWIRE_MINIMUM = 10;

/**
 * Whether a save removes so much at once that it is more likely a bug than an
 * edit.
 *
 * The app deletes one entry at a time and has no "remove all" anywhere, so a
 * document arriving with a fifth of the log missing did not get that way by
 * being edited. The thresholds are deliberately loose — the plan's instruction
 * was that this must never fire on legitimate work, and a tripwire that cries
 * wolf gets clicked through, which is worse than not having one.
 *
 * Returns what would be lost, or null when the save is ordinary.
 */
export function massDeletion(current: DataDoc, next: DataDoc): MassDeletion | null {
  const students = current.students.length - next.students.length;
  const entries = current.entries.length - next.entries.length;
  const alarming = (lost: number, before: number) =>
    lost > TRIPWIRE_MINIMUM && lost > before * TRIPWIRE_FRACTION;

  if (alarming(students, current.students.length) || alarming(entries, current.entries.length)) {
    return { students: Math.max(students, 0), entries: Math.max(entries, 0) };
  }
  return null;
}

/* ---------- snapshots, for restoring and for the mirror ---------- */

function listSnapshotFiles(): Snapshot[] {
  let names: string[];
  try {
    names = readdirSync(backupDir());
  } catch {
    return [];
  }
  return newestFirst(names.map(classify).filter((s): s is Snapshot => s !== null));
}

/**
 * Every snapshot, newest first, with the headline counts that let someone
 * choose between them. Reading each one is the only way to have those counts,
 * and this runs when a person is looking at a list rather than on any hot path.
 */
export function listSnapshots(): SnapshotSummary[] {
  const dir = backupDir();
  return listSnapshotFiles().map((snapshot) => {
    const path = join(dir, snapshot.name);
    const takenAt = fileTime(path);
    try {
      const doc = readDocumentFile(path);
      return {
        name: snapshot.name,
        takenAt,
        students: doc.students.length,
        entries: doc.entries.length,
        readable: true,
        encrypted: snapshot.encrypted,
        locked: false,
      };
    } catch (error) {
      return {
        name: snapshot.name,
        takenAt,
        students: 0,
        entries: 0,
        readable: false,
        encrypted: snapshot.encrypted,
        // The difference between "type your passphrase" and "this is damaged".
        locked: error instanceof LockedError,
      };
    }
  });
}

function fileTime(path: string): string {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/**
 * The newest snapshot that actually reads, for the offer made when the live
 * file cannot be opened.
 *
 * Newest-first and stopping at the first success, so a folder whose recent
 * snapshots are damaged still finds the last good one instead of giving up.
 */
export function newestRestorable(): { summary: SnapshotSummary; doc: DataDoc } | null {
  const dir = backupDir();
  for (const snapshot of listSnapshotFiles()) {
    const path = join(dir, snapshot.name);
    try {
      const raw = readDocumentFile(path);
      return {
        summary: {
          name: snapshot.name,
          takenAt: fileTime(path),
          students: raw.students.length,
          entries: raw.entries.length,
          readable: true,
          encrypted: snapshot.encrypted,
          locked: false,
        },
        doc: migrate(raw),
      };
    } catch {
      // Damaged, or encrypted while we are locked. Either way it is not the one
      // being offered; keep going back.
    }
  }
  return null;
}

/**
 * Move the unreadable live file out of the way, under a name nothing prunes.
 *
 * Always before a restore overwrites it. Whatever is wrong with it, it is still
 * the most recent copy of her work that exists, and the odds of recovering
 * something from it by hand are not zero — which they become the moment it is
 * overwritten.
 */
export function preserveUnreadable(): string | null {
  const path = liveDataFile();
  if (!path) return null;
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, preservedName("corrupt"));
  renameSync(path, dest);
  return dest;
}

/** Read one snapshot by name, for a restore the user picked from a list. */
export function readSnapshot(name: string): DataDoc {
  if (basename(name) !== name) throw new Error("That isn't a snapshot Casebook can read.");
  if (!classify(name)) throw new Error("That isn't a snapshot Casebook can read.");
  return migrate(readDocumentFile(join(backupDir(), name)));
}

/**
 * Parse every snapshot, and rename the ones that fail so the recovery scan
 * skips them instantly rather than re-reading them at the worst possible moment.
 */
export function checkSnapshots(): { checked: number; unreadable: string[] } {
  const dir = backupDir();
  const unreadable: string[] = [];
  const snapshots = listSnapshotFiles();
  for (const snapshot of snapshots) {
    const path = join(dir, snapshot.name);
    try {
      readDocumentFile(path);
    } catch (error) {
      // A locked encrypted snapshot is not a damaged one, and renaming it
      // would be the single most destructive thing this function could do.
      if (error instanceof LockedError) continue;
      try {
        renameSync(path, `${path}.bad`);
        unreadable.push(snapshot.name);
      } catch {
        unreadable.push(snapshot.name);
      }
    }
  }
  return { checked: snapshots.length, unreadable };
}

/**
 * What the mirror should carry: every snapshot, plus the keyfile if there is
 * one. Never `data.json` — it changes every few seconds, and a file that
 * changes under a sync service is how conflict copies are made.
 */
export function mirrorSources(): MirrorSource[] {
  const dir = backupDir();
  const sources: MirrorSource[] = listSnapshotFiles().map((snapshot) => ({
    name: snapshot.name,
    path: join(dir, snapshot.name),
  }));
  // An offsite copy that cannot be decrypted is not a backup.
  const keyfile = join(dataDir(), "keyfile.json");
  if (existsSync(keyfile)) sources.push({ name: "keyfile.json", path: keyfile });
  return sources;
}

/**
 * Copy every backup that isn't already at the destination, leaving the source
 * untouched. Same-named files are left alone rather than overwritten: two
 * folders can hold a `data-2026-03-14.json` from different installs, and the
 * one already in the destination is the one this app has been keeping.
 *
 * Snapshots arriving from a plaintext install land encrypted when the
 * destination folder is encrypted. Byte-copying them instead would leave a
 * year of somebody's clinical notes readable inside a folder she has put a
 * passphrase on — every one of them a file `convert()` would only ever touch
 * again if she happened to toggle encryption a second time.
 *
 * Returns the names it actually wrote — which is what lets a caller that fails
 * partway through take back exactly what it put there and nothing else.
 */
export function copyMissingBackups(from: string, to: string): string[] {
  let names: string[];
  try {
    names = readdirSync(from);
  } catch {
    return []; // No backups/ in the source. Nothing to bring over.
  }
  const wanted = names.filter((name) => name.endsWith(".json") || name.endsWith(".json.enc"));
  if (wanted.length === 0) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of wanted) {
    const written = carryOver(join(from, name), to, name);
    if (written) copied.push(written);
  }
  return copied;
}

/**
 * Bring one snapshot across, in the destination folder's era. Returns the name
 * written, or null when there was already one of that name there.
 */
function carryOver(source: string, to: string, name: string): string | null {
  const wantEncrypted = isEncrypting() && !name.endsWith(".enc");
  const destName = wantEncrypted ? `${name}${codec.suffix}` : name;
  // Both spellings, so a folder holding data-2026-03-14.json.enc does not
  // acquire a plaintext twin of the same day under the other name.
  if (existsSync(join(to, name)) || existsSync(join(to, destName))) return null;

  if (wantEncrypted) {
    const blob = readFileSync(source);
    try {
      // Parsed, not merely decoded — the same rule convertFile follows. A
      // damaged snapshot re-encoded is a well-formed encryption of rubbish,
      // which looks fine until the day it is the file she needs.
      const json = blob.toString("utf8");
      JSON.parse(json);
      writeDocument(join(to, destName), json);
      return destName;
    } catch {
      // Not a document this can re-encode. Copied as-is, staying recognisably
      // what it is rather than becoming plausibly something else.
    }
  }

  copyFileSync(source, join(to, name));
  return name;
}

/** Forget what this process was holding. Only for tests and for locking. */
export function resetSnapshotState(): void {
  lastSerialized = null;
  lastIntervalAt = null;
  savedSinceSnapshot = false;
}

export { dayStamp };

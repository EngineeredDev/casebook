/**
 * The weights on disk: whether the feature is on at all, which model is chosen,
 * where they live, getting them, and giving the space back.
 *
 * **They do not live in the data folder, and that is deliberate.** The
 * migration plan's one-liner put them there; this is the considered version.
 * `~/Casebook` is backed up, mirrored to a second location, and copy-verified
 * when it moves — all of which exists to protect a 100 KB document nobody can
 * reconstruct. Gigabytes that Hugging Face will hand back on request have no
 * business riding through any of that. It would multiply every backup, make the
 * mirror unusable over a slow link, and turn relocating the data folder into a
 * several-minute copy.
 *
 * So: `userData/models/`, alongside `config.json`, next to nothing that
 * `backups.ts`, `mirror.ts` or `datafolder.ts` will ever look at.
 *
 * The catalogue itself is in shared/models.ts, where the renderer can read it
 * too. Everything here is about one Mac's copy of it.
 */

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { createHash, type Hash } from "node:crypto";
import { totalmem } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { app } from "electron";
import type { AiState, ModelStatus } from "../../shared/llm.ts";
import { isKnownModelId, MODELS, modelChoice, type ModelChoice } from "../../shared/models.ts";
import { readConfig, writeConfig } from "../config.ts";

export function modelsDir(): string {
  return join(app.getPath("userData"), "models");
}

export function modelPath(choice: ModelChoice): string {
  return join(modelsDir(), choice.file);
}

/** Where a download accumulates before it is known to be complete. */
function partialPath(choice: ModelChoice): string {
  return `${modelPath(choice)}.partial`;
}

/**
 * One download at a time, on purpose.
 *
 * Two of these at once on a school network is how both of them get rate
 * limited, and the largest entry in the catalogue is 19 GB — the panel says
 * "one at a time" and this is what makes that true rather than advisory.
 */
let downloading: {
  id: string;
  received: number;
  total: number | null;
  abort: AbortController;
} | null = null;
/** Keyed by model id: a failure on one says nothing about the others. */
const lastError = new Map<string, string>();

/* ---------- the switch, and the choice ---------- */

/**
 * Whether the AI features are on.
 *
 * Absent means off, with one exception: an install that already downloaded
 * weights under the old build had no switch to set, and taking its features
 * away on upgrade would look like a bug rather than a default. Having weights
 * on disk *is* the earlier build's opt-in, so it counts as one.
 */
export function aiEnabled(): boolean {
  const setting = readConfig().aiEnabled;
  if (typeof setting === "boolean") return setting;
  return MODELS.some((m) => existsSync(modelPath(m)));
}

export function setAiEnabled(enabled: boolean): void {
  writeConfig({ ...readConfig(), aiEnabled: enabled });
}

export function activeModel(): ModelChoice {
  return modelChoice(readConfig().aiModel);
}

export function setActiveModel(id: string): void {
  // Refused rather than resolved: an id that is not in the catalogue can only
  // come from a renderer that made it up, and writing it would silently change
  // her choice to the default the next time anything read it back.
  if (!isKnownModelId(id)) return;
  writeConfig({ ...readConfig(), aiModel: id });
}

export function activeModelPath(): string {
  return modelPath(activeModel());
}

export function activeModelDownloaded(): boolean {
  return existsSync(activeModelPath());
}

/* ---------- what is on this Mac ---------- */

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** One model's state, with no reference to the switch. */
function entryStatus(choice: ModelChoice): ModelStatus {
  if (downloading?.id === choice.id) {
    return {
      state: "downloading",
      receivedBytes: downloading.received,
      totalBytes: downloading.total,
    };
  }
  if (existsSync(modelPath(choice))) return { state: "ready", bytes: sizeOf(modelPath(choice)) };
  const failure = lastError.get(choice.id);
  if (failure) return { state: "error", message: failure };
  const partial = sizeOf(partialPath(choice));
  if (partial > 0) return { state: "paused", receivedBytes: partial, totalBytes: null };
  return { state: "absent" };
}

/**
 * The active model's status — what the workbench and the summary panel gate on.
 *
 * The switch is folded in here rather than left for callers to remember. A
 * screen that asked "is a model ready" and got `ready` for weights the features
 * are switched off from would be the whole bug this state exists to prevent.
 */
export function modelStatus(): ModelStatus {
  if (!aiEnabled()) return { state: "off" };
  return entryStatus(activeModel());
}

export function aiState(): AiState {
  const enabled = aiEnabled();
  const models = MODELS.map((m) => ({ id: m.id, status: entryStatus(m) }));
  return {
    enabled,
    activeId: activeModel().id,
    active: enabled ? entryStatus(activeModel()) : { state: "off" },
    machineBytes: totalmem(),
    diskBytes: MODELS.reduce((sum, m) => sum + sizeOf(modelPath(m)) + sizeOf(partialPath(m)), 0),
    models,
  };
}

export function isDownloading(): boolean {
  return downloading !== null;
}

/* ---------- getting them ---------- */

/**
 * Fetch one model's weights, resuming whatever is already on disk.
 *
 * Node's global `fetch`, never `net.fetch`. The reason is written down in
 * updater.ts and applies identically here: a Chromium-side download acquires
 * `com.apple.quarantine`, and a quarantined file inside the app's own support
 * directory is a way to get the app translocated and everything about its
 * on-disk layout quietly moved.
 *
 * Resume matters more than it looks. Anonymous Hugging Face downloads are rate
 * limited per IP, and a school network behind one NAT can be told 429 partway
 * through several gigabytes. Keeping the partial file means the answer to that
 * is "try again later", not "start again".
 */
export async function downloadModel(id: string, onProgress: (state: AiState) => void) {
  if (downloading) return;
  if (!isKnownModelId(id)) return;
  const choice = modelChoice(id);
  if (existsSync(modelPath(choice))) return;

  mkdirSync(modelsDir(), { recursive: true });
  const already = sizeOf(partialPath(choice));
  const abort = new AbortController();
  downloading = { id, received: already, total: null, abort };
  lastError.delete(id);

  try {
    /**
     * Pinned to a commit, never `main`. A branch moves, and a repo owner
     * replacing a quantisation in place would change what Casebook installs
     * with nothing in this repository recording it — and would corrupt every
     * resume in flight, because a resume appends to a partial of the file that
     * no longer exists upstream. The bytes are then a splice of two models
     * that loads far enough to answer badly.
     */
    const url = `https://huggingface.co/${choice.repo}/resolve/${choice.revision}/${choice.file}?download=true`;
    const response = await fetch(url, {
      signal: abort.signal,
      headers: already > 0 ? { Range: `bytes=${already}-` } : {},
    });
    if (!response.ok || !response.body) {
      throw new Error(
        response.status === 429
          ? "Hugging Face is rate-limiting this network. Try again later, or from home."
          : `The download failed (${response.status}).`,
      );
    }

    // A server that ignored the Range header sends 200 and the whole file;
    // appending to the partial would produce a corrupt GGUF that only fails
    // much later, at load, looking like a broken model rather than a bad resume.
    const resumed = response.status === 206;
    const from = resumed ? already : 0;
    const length = Number(response.headers.get("content-length") ?? 0);
    downloading.total = length > 0 ? from + length : null;
    downloading.received = from;

    /**
     * The digest covers the whole file, so a resume has to be seeded with what
     * is already on disk before the new bytes arrive. That costs one read of
     * the partial — paid only when resuming, which is already the slow path.
     */
    const hash = createHash("sha256");
    if (resumed) await feed(hash, partialPath(choice));

    let lastReport = 0;
    const sink = createWriteStream(partialPath(choice), { flags: resumed ? "a" : "w" });
    const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    body.on("data", (piece: Buffer) => {
      hash.update(piece);
      if (!downloading) return;
      downloading.received += piece.length;
      // Once a second is plenty for a progress bar and keeps the IPC quiet.
      const now = Date.now();
      if (now - lastReport > 1000) {
        lastReport = now;
        onProgress(aiState());
      }
    });
    await pipeline(body, sink);

    // Before the rename, so nothing that failed either check can ever be
    // loaded. A stream that ends early is indistinguishable from one that
    // finished, and a GGUF missing its tail fails much later, at load, looking
    // like a broken model rather than a broken download.
    verify(choice, hash);

    // Only now is it the model. Renaming last means a crash mid-download can
    // never leave a truncated file sitting under the name the loader trusts.
    renameSync(partialPath(choice), modelPath(choice));
    downloading = null;
    onProgress(aiState());
  } catch (error) {
    downloading = null;
    if (abort.signal.aborted) {
      // Paused on purpose. The partial file stays, which is the whole point.
      onProgress(aiState());
      return;
    }
    lastError.set(id, (error as Error).message);
    onProgress(aiState());
  }
}

/** Pour a file that is already on disk into a running digest. */
function feed(hash: Hash, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (piece) => hash.update(piece));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
}

/**
 * Refuse to install anything that isn't byte-for-byte what the catalogue says.
 *
 * The size is the cheap check and catches the common failure — a stream that
 * ended early looks exactly like one that finished. The digest is the one that
 * catches everything else: a proxy that served a cached older file, a resume
 * that spliced two revisions together, a disk that dropped a block.
 *
 * The partial is deleted on failure rather than kept. Everywhere else in this
 * module a partial is precious, because it is minutes of somebody's download —
 * but a partial that failed verification is bytes nothing will ever accept, and
 * keeping it means the next attempt resumes onto poison and fails identically,
 * forever.
 */
function verify(choice: ModelChoice, hash: Hash): void {
  const path = partialPath(choice);
  const bytes = sizeOf(path);
  const digest = hash.digest("hex");
  const wrong =
    bytes !== choice.downloadBytes
      ? `it is ${bytes} bytes and should be ${choice.downloadBytes}`
      : digest !== choice.sha256
        ? `its contents don't match the published checksum`
        : null;
  if (!wrong) return;

  try {
    unlinkSync(path);
  } catch {
    // The message below is the one worth reporting.
  }
  throw new Error(`The download didn't arrive intact — ${wrong}. Try again.`);
}

export function pauseDownload(): void {
  downloading?.abort.abort();
}

/**
 * Hand the disk back for one model. Removes the finished file and any partial,
 * and takes the folder with it when nothing else is in there — an empty
 * `models/` left behind is a small lie about whether anything is installed.
 */
export async function removeModel(id: string): Promise<void> {
  if (!isKnownModelId(id)) return;
  const choice = modelChoice(id);
  if (downloading?.id === id) pauseDownload();
  lastError.delete(id);
  await Promise.all(
    [modelPath(choice), partialPath(choice)].map(async (path) => {
      try {
        await unlink(path);
      } catch {
        // Already gone is the outcome we wanted.
      }
    }),
  );
  try {
    if ((await readdir(modelsDir())).length === 0) rmSync(modelsDir(), { recursive: true });
  } catch {
    // A folder that will not go is not worth failing a removal over.
  }
}

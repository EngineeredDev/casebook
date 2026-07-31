/**
 * The weights on disk: where they live, getting them, and giving the space
 * back.
 *
 * **They do not live in the data folder, and that is deliberate.** The
 * migration plan's one-liner put them there; this is the considered version.
 * `~/Casebook` is backed up, mirrored to a second location, and copy-verified
 * when it moves — all of which exists to protect a 100 KB document nobody can
 * reconstruct. A 2.3 GB file that Hugging Face will hand back on request has
 * no business riding through any of that. It would multiply every backup, make
 * the mirror unusable over a slow link, and turn relocating the data folder
 * into a several-minute copy.
 *
 * So: `userData/models/`, alongside `config.json`, next to nothing that
 * `backups.ts`, `mirror.ts` or `datafolder.ts` will ever look at.
 */

import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { app } from "electron";
import type { ModelStatus } from "../../shared/llm.ts";

/**
 * The model, pinned exactly. A quantisation is not a detail — it decides the
 * file size, the wired memory, and the numbers in the eval report — so this
 * names one file rather than a repo and a preference.
 *
 * Qwen3-4B-Instruct-2507 at Q4_K_M, chosen in docs/local-llm.md §2 and measured
 * in scripts/llm-eval. Apache 2.0, so downloading it inside the app is
 * unambiguously fine.
 */
export const MODEL = {
  repo: "unsloth/Qwen3-4B-Instruct-2507-GGUF",
  file: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
  /** What the settings panel promises before she agrees to the download. */
  approxBytes: 2_500_000_000,
  label: "Qwen3 4B Instruct",
} as const;

/** Weights, plus the 4k KV cache and compute buffers, wired under Metal. */
export const NEEDED_BYTES = 3_500_000_000;

export function modelsDir(): string {
  return join(app.getPath("userData"), "models");
}

export function modelPath(): string {
  return join(modelsDir(), MODEL.file);
}

/** Where a download accumulates before it is known to be complete. */
function partialPath(): string {
  return `${modelPath()}.partial`;
}

let downloading: { received: number; total: number | null; abort: AbortController } | null = null;
let lastError: string | null = null;

export function modelStatus(): ModelStatus {
  if (downloading) {
    return {
      state: "downloading",
      receivedBytes: downloading.received,
      totalBytes: downloading.total,
    };
  }
  if (existsSync(modelPath())) return { state: "ready", bytes: sizeOf(modelPath()) };
  if (lastError) return { state: "error", message: lastError };
  const partial = sizeOf(partialPath());
  if (partial > 0) return { state: "paused", receivedBytes: partial, totalBytes: null };
  return { state: "absent" };
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function isDownloading(): boolean {
  return downloading !== null;
}

/**
 * Fetch the weights, resuming whatever is already on disk.
 *
 * Node's global `fetch`, never `net.fetch`. The reason is written down in
 * updater.ts and applies identically here: a Chromium-side download acquires
 * `com.apple.quarantine`, and a quarantined file inside the app's own support
 * directory is a way to get the app translocated and everything about its
 * on-disk layout quietly moved.
 *
 * Resume matters more than it looks. Anonymous Hugging Face downloads are rate
 * limited per IP, and a school network behind one NAT can be told 429 partway
 * through 2.3 GB. Keeping the partial file means the answer to that is "try
 * again later", not "start again".
 */
export async function downloadModel(onProgress: (status: ModelStatus) => void): Promise<void> {
  if (downloading) return;
  if (existsSync(modelPath())) return;

  mkdirSync(modelsDir(), { recursive: true });
  const already = sizeOf(partialPath());
  const abort = new AbortController();
  downloading = { received: already, total: null, abort };
  lastError = null;

  try {
    const url = `https://huggingface.co/${MODEL.repo}/resolve/main/${MODEL.file}?download=true`;
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

    let lastReport = 0;
    const sink = createWriteStream(partialPath(), { flags: resumed ? "a" : "w" });
    const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    body.on("data", (piece: Buffer) => {
      if (!downloading) return;
      downloading.received += piece.length;
      // Once a second is plenty for a progress bar and keeps the IPC quiet.
      const now = Date.now();
      if (now - lastReport > 1000) {
        lastReport = now;
        onProgress(modelStatus());
      }
    });
    await pipeline(body, sink);

    // Only now is it the model. Renaming last means a crash mid-download can
    // never leave a truncated file sitting under the name the loader trusts.
    renameSync(partialPath(), modelPath());
    downloading = null;
    onProgress(modelStatus());
  } catch (error) {
    downloading = null;
    if (abort.signal.aborted) {
      // Paused on purpose. The partial file stays, which is the whole point.
      onProgress(modelStatus());
      return;
    }
    lastError = (error as Error).message;
    onProgress(modelStatus());
  }
}

export function pauseDownload(): void {
  downloading?.abort.abort();
}

/**
 * Hand the disk back. Removes the finished file and any partial, and takes the
 * folder with it when nothing else is in there — an empty `models/` left behind
 * is a small lie about whether the feature is installed.
 */
export async function removeModel(): Promise<void> {
  pauseDownload();
  lastError = null;
  await Promise.all(
    [modelPath(), partialPath()].map(async (path) => {
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

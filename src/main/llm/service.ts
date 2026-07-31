/**
 * Owning the inference process: when it exists, what it is allowed to be doing,
 * and when it stops.
 *
 * The rule the whole design hangs on is **the model is never resident while she
 * is just using Casebook.** It is spawned when a job arrives, it runs one job
 * at a time, and it exits a minute after the last one. On an 8 GB machine an
 * idle 3.5 GB of wired memory is not a cost that can be amortised — it is the
 * difference between the app being usable and the machine swapping.
 */

/*
 * `unicorn/require-post-message-target-origin` fires on every postMessage here
 * and is wrong about all of them: this is Electron's utilityProcess channel
 * (`parentPort` / `UtilityProcess.postMessage`), not `window.postMessage`.
 * There is no origin to pass, and passing one would be a type error.
 */
/* eslint-disable unicorn/require-post-message-target-origin */

import { join } from "node:path";
import { utilityProcess, type UtilityProcess } from "electron";
import type {
  CategoryReply,
  CategoryRequest,
  HostReply,
  HostRequest,
  LlmResult,
  MemoryAdvice,
  SummaryRequest,
} from "../../shared/llm.ts";
import { availableMemory } from "./memory.ts";
import { activeModel, activeModelDownloaded, activeModelPath, aiEnabled } from "./model.ts";

/**
 * Long enough that reviewing an import does not pay the load cost on every
 * row, short enough that she gets the memory back before noticing it went.
 */
const IDLE_MS = 60_000;

/** A job that hangs is worse than one that fails; nothing here should take this long. */
const JOB_TIMEOUT_MS = 180_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onChunk?: (chunk: string) => void;
  timer: ReturnType<typeof setTimeout>;
  /**
   * Which process this job was sent to. Switching models kills one host and
   * forks another, and for a couple of seconds both exist — without this, the
   * old one's exit would reject a job the new one is busily working on.
   */
  owner: UtilityProcess;
}

let child: UtilityProcess | null = null;
/** The weights the running host loaded, so a changed choice can be noticed. */
let loadedPath: string | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * One job at a time, enforced by chaining onto the previous one's promise
 * rather than by a boolean. llama.cpp is holding a single context sequence;
 * two overlapping prompts do not queue politely, they interleave.
 */
let chain: Promise<unknown> = Promise.resolve();

/** Sized from the chosen model: a 19 GB mixture of experts is not a 2.5 GB 4B. */
export function memoryAdvice(): MemoryAdvice {
  const availableBytes = availableMemory();
  const neededBytes = activeModel().runBytes;
  return {
    availableBytes,
    neededBytes,
    // Zero means vm_stat could not be read. Unknown is not a refusal: a check
    // that disables the feature because a diagnostic moved would be worse than
    // no check at all.
    enough: availableBytes === 0 || availableBytes >= neededBytes,
  };
}

function spawn(): UtilityProcess {
  const path = activeModelPath();
  if (child && loadedPath === path) return child;
  // A host holding the model she just switched away from is worse than no host:
  // it would answer, plausibly, with the wrong weights. Its jobs are its own
  // (see `owner`), so this is safe with work in flight.
  if (child) shutdown();
  /**
   * Built as a second rollup input beside `index.js` — electron-vite has only
   * main/preload/renderer targets, so the host rides along on the main build
   * and lands next to us. Same `__dirname` idiom as the preload path.
   */
  const entry = join(__dirname, "llm-host.js");
  const spawned = utilityProcess.fork(entry, [path], {
    // The weights load faster and the app stays responsive when inference is
    // not competing with the UI for scheduling priority.
    serviceName: "casebook-inference",
    stdio: "inherit",
  });

  spawned.on("message", (message: HostReply) => {
    if ("ready" in message) return;
    const waiting = pending.get(message.id);
    if (!waiting) return;
    if ("chunk" in message) {
      waiting.onChunk?.(message.chunk);
      return;
    }
    clearTimeout(waiting.timer);
    pending.delete(message.id);
    if (message.ok) waiting.resolve(message.value);
    else waiting.reject(new Error(message.error));
  });

  spawned.on("exit", () => {
    if (child === spawned) {
      child = null;
      loadedPath = null;
    }
    // Anything still waiting on *this* process was in it when it died. Failing
    // those explicitly is the difference between a feature that says it crashed
    // and a spinner that never stops.
    for (const [id, waiting] of pending) {
      if (waiting.owner !== spawned) continue;
      clearTimeout(waiting.timer);
      waiting.reject(new Error("The AI helper stopped unexpectedly."));
      pending.delete(id);
    }
  });

  child = spawned;
  loadedPath = path;
  return spawned;
}

function touchIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    shutdown();
  }, IDLE_MS);
}

/** Stop the inference process and hand its memory back. Safe to call any time. */
export function shutdown(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (!child) return;
  const dying = child;
  child = null;
  loadedPath = null;
  try {
    dying.postMessage({ id: 0, kind: "shutdown" } satisfies HostRequest);
  } catch {
    // Already gone.
  }
  // It gets a moment to dispose the context politely, then it goes regardless.
  // Nothing it is holding needs to survive, and quitting must not be blockable
  // by an inference process that will not answer.
  setTimeout(() => dying.kill(), 2000);
}

/**
 * `Omit<HostRequest, "id">` collapses a union to the keys its members share,
 * which here is just `kind` — so the request payload silently disappears from
 * the type. Distributing over the union keeps each variant whole.
 */
type WithoutId<T> = T extends { id: number } ? Omit<T, "id"> : never;

function send<T>(request: WithoutId<HostRequest>, onChunk?: (chunk: string) => void): Promise<T> {
  const id = nextId++;
  const proc = spawn();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("The AI helper took too long and was stopped."));
      shutdown();
    }, JOB_TIMEOUT_MS);
    pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      onChunk,
      timer,
      owner: proc,
    });
    proc.postMessage({ ...request, id } as HostRequest);
  });
}

/**
 * Run a job, once the ones before it have finished.
 *
 * Failures are values rather than throws all the way out to the renderer: none
 * of this is load-bearing, and every caller's correct response to "it did not
 * work" is to carry on without it.
 */
async function run<T>(work: () => Promise<T>): Promise<LlmResult<T>> {
  // Checked here as well as in the UI. The renderer hides every affordance when
  // the switch is off, but "no screen currently offers it" is a weaker promise
  // than "the process will not run", and the switch is the one she was given to
  // mean the second thing.
  if (!aiEnabled()) {
    return { unavailable: "disabled", message: "The AI features are switched off in Settings." };
  }
  if (!activeModelDownloaded()) {
    return { unavailable: "no-model", message: "That model hasn't been downloaded yet." };
  }
  const memory = memoryAdvice();
  if (!memory.enough) {
    return {
      unavailable: "low-memory",
      message:
        "There isn't enough free memory to run the AI features right now. " +
        "Closing a few apps — a browser especially — should be enough.",
    };
  }

  const attempt = chain.then(work, work);
  // The chain must survive a failed job, or one error stops every later one.
  chain = attempt.catch(() => undefined);
  try {
    const value = await attempt;
    touchIdleTimer();
    return { ok: true, value };
  } catch (error) {
    touchIdleTimer();
    return { unavailable: "crashed", message: (error as Error).message };
  }
}

export function classify(request: CategoryRequest): Promise<LlmResult<CategoryReply>> {
  return run(() => send<CategoryReply>({ kind: "category", request }));
}

export function summarize(
  request: SummaryRequest,
  onChunk: (chunk: string) => void,
): Promise<LlmResult<string>> {
  return run(() => send<string>({ kind: "summary", request }, onChunk));
}

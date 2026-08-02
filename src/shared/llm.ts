/**
 * The AI features' contract: what the renderer can ask for, and the protocol
 * the inference process speaks.
 *
 * Kept apart from `api.ts` because this is the one subsystem that is allowed
 * not to exist. Every type here describes something optional — a model that
 * may never be downloaded, a process that is usually not running, an answer
 * that is always allowed to be "I don't know". Nothing in the app's ordinary
 * paths may come to depend on any of it.
 */

/**
 * Where one model is, as a value a panel can render.
 *
 * Everything outside the settings panel asks one question of this — is it
 * `ready` — and gets the right answer for free in every other case. That is why
 * `off` is a state here rather than a separate flag beside it: a switch the
 * import workbench had to remember to consult is a switch it will one day
 * forget to consult.
 */
export type ModelStatus =
  /** The AI features are switched off. The default, and where installs start. */
  | { state: "off" }
  /** Switched on, but these weights are not on this Mac. */
  | { state: "absent" }
  | { state: "downloading"; receivedBytes: number; totalBytes: number | null }
  /** Downloaded and usable. `bytes` is what removing it would hand back. */
  | { state: "ready"; bytes: number }
  /** A download that stopped partway. The bytes on disk are kept and resumed. */
  | { state: "paused"; receivedBytes: number; totalBytes: number | null }
  | { state: "error"; message: string };

/** One catalogue entry's state on this Mac. `id` indexes into `MODELS`. */
export interface ModelEntryStatus {
  id: string;
  status: ModelStatus;
}

/**
 * Everything the settings panel needs in one value, and the single thing the
 * main process broadcasts when any of it changes.
 *
 * `active.state` is what the rest of the app gates on, and it already accounts
 * for the switch: turning the features off makes it `off` no matter what is on
 * disk, so nothing downloaded goes on being used by a screen that missed the
 * change.
 */
export interface AiState {
  enabled: boolean;
  /** The chosen model's id, whether or not it has been downloaded. */
  activeId: string;
  /** The chosen model's status, or `off` when the features are switched off. */
  active: ModelStatus;
  /** `os.totalmem()`, so the panel can say which models this Mac can hold. */
  machineBytes: number;
  /** Weights and part-downloads on disk right now, across every model. */
  diskBytes: number;
  models: ModelEntryStatus[];
}

/**
 * Why a job could not run. Separated from a plain error string because the
 * settings panel and the workbench say different things for each, and
 * "not enough memory" in particular is advice rather than a fault.
 */
export type LlmUnavailable =
  /** Switched off in Settings. Not a fault, and not something to offer a retry for. */
  | "disabled"
  | "no-model"
  | "low-memory"
  /** The inference process died. Retrying is reasonable; it is respawned. */
  | "crashed"
  | "busy";

export interface MemoryAdvice {
  /** Bytes macOS could hand over without swapping — see `availableMemory`. */
  availableBytes: number;
  /** What loading the model and a 4k context is expected to wire. */
  neededBytes: number;
  enough: boolean;
}

/**
 * One category question. `evidence` is a quotation the answer claims to rest
 * on; the main process checks it appears in `sourceText` and blanks the
 * category when it does not (see `checkGrounded`).
 */
export interface CategoryRequest {
  kind: "classify-entry" | "suggest-mapping";
  /** For `suggest-mapping`, the phrase being decided. */
  phrase?: string;
  /** The record, or up to three records using the phrase. */
  samples: string[];
  categories: { id: string; name: string; group: "direct" | "indirect"; untimed?: boolean }[];
}

export interface CategoryReply {
  /** A category id, or null — including null because the answer was distrusted. */
  categoryId: string | null;
  /** Set when an answer was thrown out, for the log and for honest UI copy. */
  rejected: "unknown-category" | "evidence-not-in-source" | null;
  /** Milliseconds the model spent, for the progress UI and for LLM-4 A/B work. */
  elapsedMs: number;
}

export type LlmResult<T> =
  | { ok: true; value: T }
  | { unavailable: LlmUnavailable; message: string };

/** A grounded, never-persisted narrative summary of some notes (LLM-3). */
export interface SummaryRequest {
  /**
   * Who asked. Minted by the renderer, echoed on every chunk of the answer.
   *
   * Not redundant with the host's own numeric job id, which never leaves the
   * main process. Chunks are broadcast to every window, and jobs being
   * *executed* one at a time is not the same as their output being *addressed*
   * — a listener that has moved on to another student is still a listener.
   */
  requestId: string;
  studentName: string;
  /** Dated plain-text notes, oldest first. Already stripped of HTML. */
  notes: { date: string; text: string }[];
  windowLabel: string;
}

/**
 * One piece of a streamed summary, and the request it belongs to.
 *
 * The id is the whole reason this is an object rather than a string. Without
 * it, navigating away from one student mid-stream and starting another's
 * summary put the first child's narrative under the second child's name — the
 * remaining chunks of the abandoned job going to whichever component happened
 * to be listening. In a clinical tool that is the worst thing a stream can do.
 */
export interface SummaryChunk {
  requestId: string;
  text: string;
}

/* ---------- the wire between the main process and the inference host ---------- */

export type HostRequest =
  | { id: number; kind: "category"; request: CategoryRequest }
  | { id: number; kind: "summary"; request: SummaryRequest }
  | { id: number; kind: "shutdown" };

export type HostReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string }
  /** Streamed summary text. Several of these precede the final reply. */
  | { id: number; chunk: string }
  /** Sent once the weights are resident, so the UI can stop saying "starting". */
  | { ready: true };

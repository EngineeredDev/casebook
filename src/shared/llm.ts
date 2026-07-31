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

/** Where the AI features are, as one value the settings panel can render. */
export type ModelStatus =
  /** Never enabled. The default, and the state most installs stay in. */
  | { state: "absent" }
  | { state: "downloading"; receivedBytes: number; totalBytes: number | null }
  /** Downloaded and usable. `bytes` is what removing it would hand back. */
  | { state: "ready"; bytes: number }
  /** A download that stopped partway. The bytes on disk are kept and resumed. */
  | { state: "paused"; receivedBytes: number; totalBytes: number | null }
  | { state: "error"; message: string };

/**
 * Why a job could not run. Separated from a plain error string because the
 * settings panel and the workbench say different things for each, and
 * "not enough memory" in particular is advice rather than a fault.
 */
export type LlmUnavailable =
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
  studentName: string;
  /** Dated plain-text notes, oldest first. Already stripped of HTML. */
  notes: { date: string; text: string }[];
  windowLabel: string;
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

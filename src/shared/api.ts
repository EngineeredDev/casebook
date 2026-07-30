/**
 * The contract between the main process and the renderer — the whole of it.
 *
 * This replaces the loopback HTTP API the app used to talk to. Where that had
 * status codes, this has a discriminated union: the renderer still needs to
 * tell a revision conflict from a document the main process rejected from a
 * write that failed and might succeed next time, because it does something
 * different in each case (see store.tsx).
 */

import type { DataDoc } from "./types.ts";

export type SaveResult =
  | { ok: true; rev: number }
  /** The document on disk moved on without us — was HTTP 409. */
  | { conflict: true; serverRev: number }
  /**
   * `retryable` is the old 5xx/4xx split. A failed disk write is worth trying
   * again on a widening interval; a document the main process refuses to
   * accept will be refused identically forever, and re-sending it only spends
   * the retry budget proving that.
   */
  | { error: string; retryable: boolean };

export interface CasebookApi {
  getDoc(): Promise<DataDoc>;
  saveDoc(doc: DataDoc): Promise<SaveResult>;
  /**
   * Whether edits are still on their way to disk. Closing the window while
   * this is true asks before discarding them — the job `beforeunload` did in
   * the browser, which Electron cancels silently rather than prompting for.
   */
  setUnsaved(unsaved: boolean): Promise<void>;
}

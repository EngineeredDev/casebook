/**
 * The half-typed entry, kept somewhere the app cannot lose it by accident.
 *
 * Everything else in Casebook is built around not losing her work: an atomic
 * writer, a `.prev` beside the live file, three tiers of snapshot, a mirror.
 * All of it starts the moment an entry is *saved*. Before that the note lived
 * in `useState` inside `LogPage`, invisible to every one of those mechanisms —
 * so the header said "Saved" while a note was half-written, and navigating to
 * another page, reloading, closing the window, or the idle lock firing all
 * discarded it without a word.
 *
 * Hence module scope rather than a context. It survives a navigation because
 * the router unmounts the page, and it survives a lock because `StoreProvider`
 * swaps the whole tree for `UnlockScreen` — both of which take any React state
 * with them and neither of which touches a module. Retaining it across a lock
 * is deliberate: a half-typed note abandoned on a desk is precisely when the
 * lock should fire, and holding the text in the renderer's heap is no worse
 * than what the garbage collector was already leaving there. The data key is
 * still scrubbed in the main process, and nothing renders while locked.
 *
 * Scope, stated plainly: this is the *new entry* form. Editing an existing
 * entry fills the same fields from something already on disk, so treating that
 * as a draft would report unsaved changes for as long as an edit link is open.
 * An edit's unsaved changes are a real gap and a separate one.
 */

export type DraftScope = "student" | "school";

/** Exactly the fields of the log form that were component state and nothing else. */
export interface LogDraft {
  /** YYYY-MM-DD. Held here as well as in the URL — see `date` in LogPage. */
  date: string;
  studentIds: string[];
  scope: DraftScope;
  categoryId: string | null;
  minutes: number | null;
  customMinutes: number | "";
  startTime: string;
  note: string;
}

/**
 * Whether anything here is worth warning about.
 *
 * Deliberately not "differs from a blank form". `minutes` starts at 30 and
 * `scope` at "student", and a form showing only those has had nothing typed
 * into it — treating that as unsaved work would put a confirmation dialog in
 * front of every quit, which is how people learn to click through them.
 *
 * A `<p></p>` note is what an emptied rich-text editor leaves behind: a
 * non-empty string that is not a note. `isBlankNote` in lib/notes.ts is the
 * same judgement, duplicated here rather than imported so this module stays
 * free of the editor's schema.
 */
export function draftHasContent(draft: LogDraft): boolean {
  return (
    draft.studentIds.length > 0 ||
    draft.categoryId !== null ||
    draft.startTime !== "" ||
    draft.customMinutes !== "" ||
    (draft.note !== "" && draft.note.replace(/<[^>]*>/g, "").trim() !== "")
  );
}

let held: LogDraft | null = null;
const watchers = new Set<() => void>();

/** What the log form should come back to, or null when there is nothing to restore. */
export function readDraft(): LogDraft | null {
  return held;
}

/**
 * Record the form's current contents, or clear them.
 *
 * A draft with nothing in it is stored as null rather than as an empty draft,
 * so "is there unsaved work" is one null check and emptying the form by hand is
 * indistinguishable from never having typed in it.
 */
export function writeDraft(next: LogDraft | null): void {
  const was = held !== null;
  held = next && draftHasContent(next) ? next : null;
  // Only when the *answer* changes. This runs on every keystroke, and the one
  // consumer is an IPC call.
  if (was !== (held !== null)) for (const watcher of watchers) watcher();
}

export function clearDraft(): void {
  writeDraft(null);
}

/** Whether there is typing nobody has saved. Read by the store's unsaved report. */
export function hasUnsavedDraft(): boolean {
  return held !== null;
}

/** Told when `hasUnsavedDraft` changes, never merely when the text does. */
export function watchDraft(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

/** Only for tests, which share one module instance across a file. */
export function resetDraft(): void {
  held = null;
  watchers.clear();
}

/**
 * What the deterministic layer makes of a pasted Google Doc, before anything —
 * a person, a heuristic, or the model — has confirmed any of it.
 *
 * Every field here is a proposal. Nothing in this folder writes an entry, and
 * nothing downstream of it may commit one without a person having looked: the
 * review grid is where correctness actually comes from, and these types exist
 * to give it something to show and something to argue with. Hence `flags` —
 * a chunk that was read confidently and one that was guessed at both arrive as
 * a `ParsedEntry`, and the only thing separating them is what they admit to.
 */

/**
 * Why a chunk, or one of its fields, is not to be trusted.
 *
 * Each of these puts its row into the "check" state in the review grid. They
 * are not errors — every one of them still produces a usable value — they are
 * the places where the value came from a rule rather than from the document.
 */
export type ChunkFlag =
  /** Split on the loose date-at-line-start fallback rather than the `@` form. */
  | "weak-header"
  /** The header carried one time, so the duration is a default and not a reading. */
  | "assumed-duration"
  /** Two times, but the second isn't after the first — or the gap is absurd. */
  | "implausible-range"
  /** The header carried no time at all. */
  | "no-time"
  /** The header carried no type phrase, so there is nothing to map to a category. */
  | "no-type-phrase";

/** A run of source lines, kept exactly as written so the left pane can show it. */
export interface SourceChunk {
  /**
   * Unique within one parse and stable across re-renders, so review rows can be
   * keyed by it. Sequential rather than random specifically so that tests and
   * the eval harness can name a chunk.
   */
  id: string;
  /** The source text, header line included. Never modified, never trimmed. */
  text: string;
  /** 0-based line offsets into the original document, inclusive, for highlighting. */
  startLine: number;
  endLine: number;
}

/**
 * One proposed entry. Shaped to be *nearly* an `Entry` but deliberately not one:
 * there is no `categoryId` (that is the mapping step's job, and it needs her
 * real categories), no `studentIds` (chosen once for the whole import), and no
 * id. A type that could be spread straight into `addEntry` would be an
 * invitation to do exactly that.
 */
export interface ParsedEntry {
  chunk: SourceChunk;
  /** YYYY-MM-DD. Null only when a header matched but its date did not resolve. */
  date: string | null;
  /** HH:MM on a 24-hour clock, or null when the header carried no time. */
  startTime: string | null;
  /**
   * Never null. When the header gave a usable range this is read from it;
   * otherwise it is `DEFAULT_MINUTES`, and `assumed-duration` says so. A
   * nullable duration would push the decision into every consumer, and the
   * user's decision (docs/local-llm.md §4) was a default plus a flag.
   */
  minutes: number;
  /** The type phrase exactly as written, or null. The mapping table's key. */
  typePhrase: string | null;
  /** The note body as editor-schema HTML. Empty string when the chunk had none. */
  note: string;
  flags: ChunkFlag[];
}

/** One distinct type phrase in a document, and how often it turned up. */
export interface PhraseUse {
  /** As written, from its first appearance — what the mapping step displays. */
  phrase: string;
  /** `normalizePhrase(phrase)`. What the persisted mapping is actually keyed by. */
  key: string;
  count: number;
}

export interface ParsedDoc {
  entries: ParsedEntry[];
  /**
   * Whatever sat above the first header — in her docs, the student's name and
   * a title. Carried rather than dropped because "nothing is ever dropped" is
   * the rule, and because silently eating the one line that says whose document
   * this is would be the worst thing this parser could do quietly.
   */
  preamble: string;
  /** Distinct phrases in first-appearance order, for the mapping step. */
  phrases: PhraseUse[];
}

/**
 * The duration a single-timed header gets.
 *
 * Her docs usually mean a no-show when they write one time, but not always —
 * sometimes the end time just wasn't written down. Her decision was to default
 * these to 15 minutes and flag the row: if the phrase maps to an untimed
 * category the app stores 0 minutes regardless, so the default costs nothing
 * in exactly the case it is most likely to be wrong about.
 */
export const DEFAULT_MINUTES = 15;

/**
 * Longer than this and the range was misread rather than long. A school
 * clinician's single logged event does not run eight hours, and treating a
 * misparse as a very long session is how a week's totals quietly stop meaning
 * anything.
 */
export const MAX_PLAUSIBLE_MINUTES = 480;

/**
 * What a reviewed import row actually *is*, once her corrections have been laid
 * over what the parser proposed — step 4 of the import pipeline
 * (docs/local-llm.md §4).
 *
 * This module exists because the review grid used to derive those values in one
 * place and read them back in another. The grid rendered a corrected start time
 * and the commit path wrote `entry.startTime`, so a time she had fixed, looked
 * at and confirmed reverted to the parsed value in the permanent record. A field
 * that is displayed from one expression and committed from a different one will
 * drift again; the fix is not to correct the second expression but to remove it.
 *
 * So: one function decides what a row means, the grid renders its result, the
 * commit writes its result, and neither of them derives anything. Everything
 * here is pure — no React, no store — which is the other half of the point,
 * because it is the part worth testing and the grid is not.
 */

import type { Category, Entry, ImportMappings } from "../types.ts";
import type { ChunkFlag, ParsedEntry } from "./types.ts";
import { normalizePhrase, resolvePhrase } from "./phrases.ts";

/** What a person changed about one row. Absent keys mean "as parsed". */
export interface RowEdit {
  date?: string;
  startTime?: string;
  minutes?: number;
  categoryId?: string;
  note?: string;
}

/**
 * How ready a row is to be written.
 *
 * `incomplete` cannot be committed at all. `check` can, but only deliberately —
 * it marks a row still resting on a rule or a suggestion rather than on the
 * document or on her.
 */
export type RowStatus = "ready" | "check" | "incomplete";

/**
 * Everything the review grid needs about one row, and everything commit writes.
 *
 * `entry` and `edit` are carried along because the grid still shows what the
 * document said and what she changed. They are for display and for the mapping
 * bookkeeping at commit time — no consumer should be re-deriving a committed
 * value from them.
 */
export interface EffectiveRow {
  entry: ParsedEntry;
  /** The chunk's first line number; the key her edits are stored under. */
  line: number;
  edit: RowEdit;
  category: Category | null;
  minutes: number;
  date: string | null;
  /** HH:MM, or "" for no time. Empty commits as null, like the log form. */
  startTime: string;
  note: string;
  unresolved: ChunkFlag[];
  status: RowStatus;
  duplicate: boolean;
  /** The category is still the model's opinion — nobody has agreed with it yet. */
  fromAi: boolean;
}

/**
 * Everything outside a row that changes what the row means.
 *
 * `mappings` and `aiMappings` stay separate all the way down here rather than
 * being merged by the caller, because the difference is what `fromAi` is
 * computed from: a row resting on a suggestion has to be able to say so.
 */
export interface RowContext {
  /** Her live, unarchived categories. */
  categories: readonly Category[];
  /** Her decisions, persisted across imports. Always win. */
  mappings: Readonly<ImportMappings>;
  /** The model's proposals for this document only. */
  aiMappings: Readonly<ImportMappings>;
  /** The model's per-row guesses, for entries carrying no phrase, keyed by line. */
  aiRows: Readonly<Record<number, string>>;
  /** Per-phrase duration for rows whose header never said one. */
  phraseMinutes: Readonly<Record<string, number>>;
  /** Who the import is for; null before she has chosen. Duplicates need it. */
  studentId: string | null;
  /** Entries already in the document, for the duplicate warning. */
  existing: readonly Entry[];
}

/** The category a row lands in: her override, else the mapping table. */
function categoryFor(entry: ParsedEntry, edit: RowEdit, line: number, ctx: RowContext) {
  const byId = (id: string) => ctx.categories.find((c) => c.id === id) ?? null;
  if (edit.categoryId) return byId(edit.categoryId);
  if (entry.typePhrase) {
    // Spread order is the policy: a decision she made overrides a suggestion
    // for the same phrase, always.
    const hit = resolvePhrase(
      entry.typePhrase,
      { ...ctx.aiMappings, ...ctx.mappings },
      ctx.categories,
    );
    return hit ? byId(hit.categoryId) : null;
  }
  const guessed = ctx.aiRows[line];
  return guessed ? byId(guessed) : null;
}

function minutesFor(
  entry: ParsedEntry,
  edit: RowEdit,
  category: Category | null,
  ctx: RowContext,
): number {
  // An untimed category stores zero however long the header said it was.
  // Consistent with the log form, and the reason a wrong duration on a no-show
  // costs nothing.
  if (category?.untimed) return 0;
  if (edit.minutes !== undefined) return edit.minutes;
  if (entry.flags.includes("assumed-duration") && entry.typePhrase) {
    const preset = ctx.phraseMinutes[normalizePhrase(entry.typePhrase)];
    if (preset) return preset;
  }
  return entry.minutes;
}

/** One parsed entry plus her corrections, resolved into what will be written. */
export function effectiveRow(entry: ParsedEntry, edit: RowEdit, ctx: RowContext): EffectiveRow {
  const line = entry.chunk.startLine;
  const category = categoryFor(entry, edit, line, ctx);
  const minutes = minutesFor(entry, edit, category, ctx);
  const date = edit.date ?? entry.date;
  const note = edit.note ?? entry.note;

  /**
   * `!== undefined` rather than `??`, so that clearing the time field is a
   * decision the row keeps. `edit.startTime === ""` means "she deleted the
   * time"; falling back to the parsed value there would put it straight back.
   */
  const startTime = edit.startTime !== undefined ? edit.startTime : (entry.startTime ?? "");

  /**
   * A flag stops mattering once she has answered the question it was asking.
   * Leaving them all lit would mean a row she has fully corrected still nags,
   * and a grid where everything is flagged is a grid where nothing is.
   */
  const unresolved = entry.flags.filter((flag) => {
    if (flag === "no-type-phrase") return edit.categoryId === undefined;
    if (flag === "assumed-duration" || flag === "no-time" || flag === "implausible-range") {
      return edit.minutes === undefined && !(category?.untimed ?? false);
    }
    return true;
  });

  /**
   * Whether this row's category is still the model's opinion. Such a row is
   * never "ready", however complete it looks — the eval put per-entry
   * classification at 81%, and a row nobody has agreed with yet has not been
   * reviewed just because every field is filled in.
   */
  const key = entry.typePhrase ? normalizePhrase(entry.typePhrase) : null;
  const fromAi =
    edit.categoryId === undefined &&
    !!category &&
    (key
      ? ctx.aiMappings[key] !== undefined && ctx.mappings[key] === undefined
      : ctx.aiRows[line] !== undefined);

  const status: RowStatus =
    !date || !category || (!category.untimed && minutes <= 0)
      ? "incomplete"
      : unresolved.length > 0 || fromAi
        ? "check"
        : "ready";

  const duplicate =
    !!ctx.studentId &&
    !!date &&
    !!category &&
    ctx.existing.some(
      (e) =>
        e.date === date &&
        e.categoryId === category.id &&
        e.studentIds.includes(ctx.studentId as string),
    );

  return {
    entry,
    line,
    edit,
    category,
    minutes,
    date,
    startTime,
    note,
    unresolved,
    status,
    duplicate,
    fromAi,
  };
}

/** Every parsed entry resolved against the edits stored under its start line. */
export function effectiveRows(
  entries: readonly ParsedEntry[],
  edits: Readonly<Record<number, RowEdit>>,
  ctx: RowContext,
): EffectiveRow[] {
  return entries.map((entry) => effectiveRow(entry, edits[entry.chunk.startLine] ?? {}, ctx));
}

/**
 * The timeline's search: a small query language over entries, run entirely in
 * the browser against the document already in memory.
 *
 * Typing bare words matches anything about an entry — its note, the students on
 * it, the category, the date. Prefixing a word with a field narrows it:
 *
 *     coping cards            both words appear somewhere
 *     "coping cards"          that exact phrase
 *     student:casey iep       Casey's IEP-related entries
 *     note:guardian           the word appears in the note specifically
 *     has:note is:group       group sessions that carry a note
 *     after:2026-05 -cat:doc  since May, excluding documentation
 *
 * Every term must match — terms AND together — and a leading "-" negates one.
 * An unrecognized field ("foo:bar") is matched as ordinary text rather than
 * rejected, so a typo narrows the results instead of erroring.
 *
 * Deliberately not fuzzy. Newest-first order is the point of the page, and
 * relevance ranking would have to fight it; a clinician looking for "the
 * Ruiz email" wants every entry that says Ruiz, in the order they happened.
 */

import type { Category, DataDoc, Entry, Student } from "../../shared/types.ts";
import { noteExcerpt } from "./notes.ts";
import { fmtDayLabel } from "./time.ts";

/** An entry with everything search needs precomputed — built once per document. */
export interface IndexedEntry {
  entry: Entry;
  students: Student[];
  category: Category | null;
  group: "direct" | "indirect";
  untimed: boolean;
  /** Any attending student is on an IEP. */
  iep: boolean;
  /** The note as lower-cased plain text; "" when there is none. */
  note: string;
  /** Everything a bare word can match apart from the note, lower-cased. */
  haystack: string;
}

/**
 * Newest day first, and within a day in the order the day happened — the same
 * ordering the Log page uses for its day list, so an entry sits in the same
 * place relative to its neighbours on both pages.
 */
function byNewestDay(a: Entry, b: Entry): number {
  return (
    b.date.localeCompare(a.date) ||
    (a.startTime ?? "99:99").localeCompare(b.startTime ?? "99:99") ||
    a.createdAt.localeCompare(b.createdAt)
  );
}

export function buildIndex(doc: DataDoc): IndexedEntry[] {
  const studentsById = new Map(doc.students.map((s) => [s.id, s]));
  const categoriesById = new Map(doc.categories.map((c) => [c.id, c]));

  return doc.entries.toSorted(byNewestDay).map((entry) => {
    const students = entry.studentIds
      .map((id) => studentsById.get(id))
      .filter((s): s is Student => !!s);
    const category = categoriesById.get(entry.categoryId) ?? null;
    return {
      entry,
      students,
      category,
      group: category?.group ?? "indirect",
      untimed: !!category?.untimed,
      iep: students.some((s) => s.iep),
      // Parsing note HTML is the expensive part of the index, which is why the
      // index is built per document rather than per keystroke.
      note: entry.note ? noteExcerpt(entry.note, Infinity).toLowerCase() : "",
      haystack: [
        students.map((s) => s.name).join(" "),
        category?.name ?? "",
        entry.date,
        fmtDayLabel(entry.date),
        entry.startTime ?? "",
      ]
        .join(" ")
        .toLowerCase(),
    };
  });
}

/* ---------- the query language ---------- */

type TextField = "student" | "category" | "note";
type DateOp = "before" | "after" | "on";
type Flag = "note" | "group" | "untimed" | "timed" | "iep";

type Term =
  | { kind: "text"; value: string; negated: boolean }
  | { kind: "field"; field: TextField; value: string; negated: boolean }
  | { kind: "date"; op: DateOp; value: string; negated: boolean }
  | { kind: "flag"; flag: Flag; negated: boolean };

const TEXT_FIELDS: Record<string, TextField> = {
  student: "student",
  s: "student",
  category: "category",
  cat: "category",
  c: "category",
  note: "note",
  n: "note",
};

const DATE_OPS: Record<string, DateOp> = {
  before: "before",
  until: "before",
  after: "after",
  since: "after",
  on: "on",
  date: "on",
};

const FLAGS: Record<string, Flag> = {
  note: "note",
  notes: "note",
  group: "group",
  untimed: "untimed",
  timed: "timed",
  iep: "iep",
};

/** A partial date is legal: "2026", "2026-07", "2026-07-24". */
const PARTIAL_YMD = /^\d{4}(-\d{2})?(-\d{2})?$/;

export interface ParsedQuery {
  terms: Term[];
  /** Words to visibly mark in the list — bare and note terms, lower-cased. */
  highlight: string[];
  isEmpty: boolean;
}

/**
 * Split on whitespace, except inside double quotes. The quotes themselves are
 * dropped, so `student:"casey l"` arrives as one token with its space intact.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of input) {
    if (ch === '"') {
      quoted = !quoted;
    } else if (!quoted && /\s/.test(ch)) {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

export function parseQuery(input: string): ParsedQuery {
  const terms: Term[] = [];
  const highlight: string[] = [];

  for (const token of tokenize(input)) {
    const negated = token.startsWith("-");
    const body = negated ? token.slice(1) : token;
    if (!body) continue;

    const colon = body.indexOf(":");
    const prefix = colon > 0 ? body.slice(0, colon).toLowerCase() : "";
    const rest = colon > 0 ? body.slice(colon + 1) : "";

    if (prefix && rest) {
      const field = TEXT_FIELDS[prefix];
      if (field) {
        terms.push({ kind: "field", field, value: rest.toLowerCase(), negated });
        if (field === "note" && !negated) highlight.push(rest.toLowerCase());
        continue;
      }
      const op = DATE_OPS[prefix];
      if (op && PARTIAL_YMD.test(rest)) {
        terms.push({ kind: "date", op, value: rest, negated });
        continue;
      }
      if (prefix === "has" || prefix === "is") {
        const flag = FLAGS[rest.toLowerCase()];
        if (flag) {
          terms.push({ kind: "flag", flag, negated });
          continue;
        }
      }
      // Falls through: an unknown prefix is just text that happens to have a
      // colon in it, which is what someone pasting an id or a time expects.
    }

    const value = body.toLowerCase();
    terms.push({ kind: "text", value, negated });
    if (!negated) highlight.push(value);
  }

  return { terms, highlight, isEmpty: terms.length === 0 };
}

/** Why an entry matched — enough to flag a hit hiding inside a collapsed note. */
export interface Match {
  inNote: boolean;
}

/** Null when the entry fails any term; otherwise where the match landed. */
export function matchEntry(query: ParsedQuery, idx: IndexedEntry): Match | null {
  let inNote = false;

  for (const term of query.terms) {
    let hit = false;
    let noteHit = false;

    switch (term.kind) {
      case "text":
        noteHit = !!idx.note && idx.note.includes(term.value);
        hit = noteHit || idx.haystack.includes(term.value);
        break;
      case "field":
        if (term.field === "note") {
          noteHit = !!idx.note && idx.note.includes(term.value);
          hit = noteHit;
        } else if (term.field === "student") {
          hit = idx.students.some((s) => s.name.toLowerCase().includes(term.value));
        } else {
          hit = (idx.category?.name.toLowerCase() ?? "").includes(term.value);
        }
        break;
      case "date": {
        /* Inclusive `after`, exclusive `before`, so the natural pair
           `after:2026-05-01 before:2026-06-01` is exactly May. Both read
           correctly for a partial date too: after:2026-05 starts at May 1, and
           before:2026-05 stops before it. */
        const date = idx.entry.date;
        hit =
          term.op === "on"
            ? date.startsWith(term.value)
            : term.op === "before"
              ? date < term.value
              : date >= term.value;
        break;
      }
      case "flag":
        hit =
          term.flag === "note"
            ? !!idx.note
            : term.flag === "group"
              ? idx.entry.studentIds.length > 1
              : term.flag === "untimed"
                ? idx.untimed
                : term.flag === "timed"
                  ? !idx.untimed
                  : idx.iep;
        break;
    }

    if (term.negated ? hit : !hit) return null;
    if (noteHit && !term.negated) inNote = true;
  }

  return { inNote };
}

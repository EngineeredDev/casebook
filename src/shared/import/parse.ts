/**
 * Segmentation and field prefill — steps 1 and 2 of the import pipeline
 * (docs/local-llm.md §4).
 *
 * This is the layer the whole feature is built to survive on. If the model is
 * never downloaded, never enabled, or turns out to be useless, everything below
 * still runs and still fills in most of every row; the model's job is the
 * residue. So the rules here are conservative on purpose: a chunk this file is
 * unsure about says so in `flags` and lands in the review grid's "check" state,
 * rather than being quietly improved by a guess.
 *
 * Two things are load-bearing and easy to break later:
 *
 * - **Only header lines split a document.** Blank lines mean nothing — her
 *   notes contain whole pasted emails, with greetings, blank lines and contact
 *   lists. Anything that starts treating a blank line as a boundary will shred
 *   those notes into fragments.
 * - **Nothing is ever dropped.** Text above the first header comes back as
 *   `preamble`; everything under a header becomes that entry's note verbatim.
 *   There is no path through this file that discards source text.
 */

import { noteToHtml, trimBlankEdges } from "./html.ts";
// The same normaliser the mapping table is keyed by. Sharing it is what stops
// the segmentation pass and the persisted mappings from drifting apart on what
// counts as the same phrase.
import { normalizePhrase } from "./phrases.ts";
import {
  DEFAULT_MINUTES,
  MAX_PLAUSIBLE_MINUTES,
  type ChunkFlag,
  type ParsedDoc,
  type ParsedEntry,
  type PhraseUse,
} from "./types.ts";

export interface ParseOptions {
  /**
   * 1-12, from her settings. Only consulted for a header whose date omits the
   * year, which her documents have not actually done — it is the fallback the
   * plan asked for rather than a path with a known caller.
   */
  schoolYearStartMonth?: number;
  /** YYYY-MM-DD. Which school year a yearless date belongs to is relative to this. */
  referenceDate?: string;
}

/**
 * A date at the very start of a line. Month-first: these are US school
 * records, and `9/25/2025` has no second reading in that context.
 *
 * The year is optional here and validated later, because rejecting yearless
 * dates in the pattern would also reject the `@` form (`9/25 @ 11:45`), which
 * is unambiguously a header whatever the year turns out to be.
 */
const DATE_RE = /^[ \t]*(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?/;

/**
 * One clock reading. The minutes and the meridiem are both optional in the
 * pattern but not both absent in practice — `readTime` rejects a bare number,
 * so `3 Ways to Cope` in a header cannot be read as three o'clock.
 */
const TIME_RE = /^[ \t]*(\d{1,2})(?::(\d{2}))?[ \t]*(?:([apAP])\.?[mM]\.?)?/;

/** What separates the two halves of a range. `to` needs a word boundary; `-` does not. */
const RANGE_SEP_RE = /^[ \t]*(?:-|–|—|to\b)[ \t]*/;

/** Punctuation left stranded between the time and the type phrase. */
const LEADING_JUNK_RE = /^[ \t]*[-–—:,]+[ \t]*/;

/**
 * How long a trailing phrase may be before a weak header stops being credible.
 * A type phrase is two or three words; a sentence that happens to start with a
 * date is prose. Generous, because the cost of a false split is one click in
 * the review grid and the cost of a missed split is a lost entry.
 */
const MAX_WEAK_PHRASE = 60;

interface Header {
  date: string | null;
  startMinutes: number | null;
  endMinutes: number | null;
  phrase: string | null;
  /** Matched by the loose fallback rather than the `date @ time` form. */
  weak: boolean;
}

export function parseImport(text: string, options: ParseOptions = {}): ParsedDoc {
  const lines = text.split(/\r?\n/);
  const found: { line: number; header: Header }[] = [];
  for (const [index, line] of lines.entries()) {
    const header = matchHeader(line ?? "", options);
    if (header) found.push({ line: index, header });
  }

  if (found.length === 0) {
    // Not a failure and not empty: it is a document whose shape this parser did
    // not recognise, and every word of it still has to reach the person.
    return { entries: [], preamble: trimBlankEdges(text), phrases: [] };
  }

  const preamble = trimBlankEdges(lines.slice(0, found[0]!.line).join("\n"));

  const entries = found.map((hit, i): ParsedEntry => {
    const endLine = (found[i + 1]?.line ?? lines.length) - 1;
    const body = lines.slice(hit.line + 1, endLine + 1).join("\n");
    return buildEntry(
      hit.header,
      {
        id: `c${i + 1}`,
        text: lines.slice(hit.line, endLine + 1).join("\n"),
        startLine: hit.line,
        endLine,
      },
      body,
    );
  });

  return { entries, preamble, phrases: harvestPhrases(entries) };
}

function buildEntry(header: Header, chunk: ParsedEntry["chunk"], body: string): ParsedEntry {
  const flags: ChunkFlag[] = [];
  if (header.weak) flags.push("weak-header");

  /**
   * `assumed-duration` is the canonical "this number is a default" flag: it is
   * present exactly when `minutes` did not come from the document. `no-time`
   * and `implausible-range` say *why*, and always travel with it, so a consumer
   * that only wants to know whether to trust the number has one flag to check.
   */
  let minutes = DEFAULT_MINUTES;
  if (header.startMinutes === null) {
    flags.push("no-time", "assumed-duration");
  } else if (header.endMinutes === null) {
    flags.push("assumed-duration");
  } else {
    const span = header.endMinutes - header.startMinutes;
    if (span <= 0 || span > MAX_PLAUSIBLE_MINUTES) {
      flags.push("implausible-range", "assumed-duration");
    } else {
      minutes = span;
    }
  }

  if (!header.phrase) flags.push("no-type-phrase");

  return {
    chunk,
    date: header.date,
    startTime: header.startMinutes === null ? null : fmtClock(header.startMinutes),
    minutes,
    typePhrase: header.phrase,
    note: noteToHtml(body),
    flags,
  };
}

/**
 * Whether a line opens an entry, and what it says if so.
 *
 * The `@` convention carries the precision here: `date @ time` cannot occur
 * inside a note by accident, so the strong form needs no further guard. The
 * fallback — a date at line start without the `@` — can, so it is fenced by
 * `plausibleWeakPhrase` and everything it admits is marked `weak-header` for
 * the grid to question.
 */
function matchHeader(line: string, options: ParseOptions): Header | null {
  const m = DATE_RE.exec(line);
  if (!m) return null;
  const date = resolveDate(m[1]!, m[2]!, m[3], options);
  if (!date) return null;

  let rest = line.slice(m[0].length);
  const strong = /^[ \t]*@/.test(rest);
  if (strong) rest = rest.replace(/^[ \t]*@[ \t]*/, "");

  const range = readTimeRange(rest);
  const phrase = (range ? range.rest : rest).replace(LEADING_JUNK_RE, "").trim() || null;

  if (!strong && !range && !plausibleWeakPhrase(phrase)) return null;

  return {
    date,
    startMinutes: range?.start ?? null,
    endMinutes: range?.end ?? null,
    phrase,
    weak: !strong,
  };
}

/**
 * A date at line start with no `@` and no time is only a header if what follows
 * looks like a label rather than a sentence. Lowercase openings are the tell:
 * `9/25/2025 was the first time she…` is a note, `9/25/2025 Routine Session`
 * is a header.
 */
function plausibleWeakPhrase(phrase: string | null): boolean {
  if (phrase === null) return true;
  return phrase.length <= MAX_WEAK_PHRASE && !/^[a-z]/.test(phrase);
}

/* ---------- dates ---------- */

function resolveDate(
  monthRaw: string,
  dayRaw: string,
  yearRaw: string | undefined,
  options: ParseOptions,
): string | null {
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const year = yearRaw === undefined ? inferYear(month, options) : expandYear(yearRaw);
  // Round-trip through Date so that 2/30 and 4/31 are rejected rather than
  // silently rolling forward into March and May.
  const probe = new Date(year, month - 1, day);
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
    return null;
  }
  return `${year}-${pad(month)}-${pad(day)}`;
}

function expandYear(raw: string): number {
  const n = Number(raw);
  // Two digits are this century. A school record from 1999 is not a thing this
  // app will ever be asked to import.
  return raw.length <= 2 ? 2000 + n : n;
}

/**
 * Which year a yearless date meant, assuming it belongs to the school year
 * containing `referenceDate`. Months at or after the rollover month open the
 * year; months before it fall in the spring half and so belong to the next
 * calendar year.
 */
function inferYear(month: number, options: ParseOptions): number {
  const startMonth = options.schoolYearStartMonth ?? 8;
  const reference = options.referenceDate ?? isoToday();
  const refYear = Number(reference.slice(0, 4));
  const refMonth = Number(reference.slice(5, 7));
  const openedIn = refMonth >= startMonth ? refYear : refYear - 1;
  return month >= startMonth ? openedIn : openedIn + 1;
}

function isoToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/* ---------- times ---------- */

interface TimeRange {
  start: number;
  end: number | null;
  rest: string;
}

function readTimeRange(s: string): TimeRange | null {
  const first = readTime(s);
  if (!first) return null;
  const sep = RANGE_SEP_RE.exec(first.rest);
  if (!sep) return { start: first.minutes, end: null, rest: first.rest };
  const second = readTime(first.rest.slice(sep[0].length));
  if (!second) return { start: first.minutes, end: null, rest: first.rest };
  return {
    start: first.minutes,
    // Resolved against the first: `11:45-12:00` is a quarter hour, and the
    // second reading is what says the pair crossed noon.
    end: resolveAgainst(second, first),
    rest: second.rest,
  };
}

interface Reading {
  hour: number;
  minute: number;
  meridiem: "am" | "pm" | null;
  minutes: number;
  rest: string;
}

function readTime(s: string): Reading | null {
  const m = TIME_RE.exec(s);
  if (!m) return null;
  const hour = Number(m[1]);
  const minutePart = m[2];
  const meridiemPart = m[3];
  // A bare integer is not a time. Without this, `10/20/2025 3 Ways to Cope`
  // reads as three o'clock and eats the phrase that says what the entry was.
  if (minutePart === undefined && meridiemPart === undefined) return null;
  const minute = minutePart === undefined ? 0 : Number(minutePart);
  if (hour > 23 || minute > 59) return null;
  const meridiem =
    meridiemPart === undefined ? null : meridiemPart.toLowerCase() === "a" ? "am" : "pm";
  return {
    hour,
    minute,
    meridiem,
    minutes: toMinutes(hour, minute, meridiem),
    rest: s.slice(m[0].length),
  };
}

/**
 * A clock reading as minutes past midnight, resolved on a school-day clock when
 * the writer left the meridiem off — which she usually does.
 *
 * The school day runs morning through afternoon and never wraps, so the hours
 * order themselves: 8–11 are morning, 12 is noon, and 1–7 are afternoon. That
 * single assumption is what makes `11:45-12:00` fifteen minutes and
 * `12:45-1:15` half an hour without either header having to say am or pm.
 *
 * It is also the one place this file will be wrong about a real document: an
 * 8pm parent phone call reads as 8am. It costs a corrected field in the grid,
 * and the alternative — refusing to guess — costs a corrected field on every
 * row instead.
 */
function toMinutes(hour: number, minute: number, meridiem: "am" | "pm" | null): number {
  let h = hour;
  if (meridiem === "am") h = hour === 12 ? 0 : hour;
  else if (meridiem === "pm") h = hour === 12 ? 12 : hour + 12;
  else if (hour >= 1 && hour <= 7) h = hour + 12;
  return h * 60 + minute;
}

/**
 * The end of a range, given how the start resolved. An explicit meridiem on
 * either half wins; otherwise a second reading that lands before the first is
 * pushed past noon, which is the only way an afternoon end time can be told
 * apart from a morning one when neither says.
 */
function resolveAgainst(end: Reading, start: Reading): number {
  if (end.meridiem !== null) return end.minutes;
  if (end.minutes > start.minutes) return end.minutes;
  const pushed = end.minutes + 12 * 60;
  return pushed > start.minutes && pushed - start.minutes <= MAX_PLAUSIBLE_MINUTES
    ? pushed
    : end.minutes;
}

function fmtClock(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/* ---------- phrases ---------- */

/**
 * The distinct type phrases a document uses, in first-appearance order.
 *
 * This is what turns category normalisation from a per-entry inference problem
 * into one decision per phrase — the reason the import feature is worth
 * shipping with the model switched off.
 */
function harvestPhrases(entries: ParsedEntry[]): PhraseUse[] {
  const byKey = new Map<string, PhraseUse>();
  for (const entry of entries) {
    if (!entry.typePhrase) continue;
    const key = normalizePhrase(entry.typePhrase);
    if (!key) continue;
    const seen = byKey.get(key);
    if (seen) seen.count += 1;
    else byKey.set(key, { phrase: entry.typePhrase, key, count: 1 });
  }
  return [...byKey.values()];
}

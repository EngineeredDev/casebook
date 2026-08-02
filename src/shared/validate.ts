/**
 * What a Casebook document is allowed to contain, checked item by item.
 *
 * The guard this replaces looked at five array *types* and stopped there, which
 * meant an entry with a `minutes` of `"30"`, or a date of `"next Tuesday"`, or
 * no id at all, was written to disk without complaint. A malformed item is not
 * a crash — it is a number that quietly stops adding up in a report, or a
 * document that throws on every future launch because one entry in the middle
 * of it is the wrong shape.
 *
 * Two things this deliberately is not.
 *
 * It is **not a defence against an attacker.** The renderer is the only thing
 * that sends documents, and it is this app. Someone who can send arbitrary IPC
 * has already lost the user the machine. This is a guard against a bug in code
 * we wrote, placed at the last point where a bad document can be stopped before
 * it reaches the file everything else depends on.
 *
 * It is **not a schema for the whole world.** Dangling references — an entry
 * naming a category or a student that has been deleted — are *reported* and not
 * refused, because they are a state the app produces on purpose: deleting a
 * category leaves the entries that used it, and the UI renders "(deleted)". A
 * validator that refused them would refuse a save the moment she deleted
 * anything, which is the one thing worse than not validating at all.
 */

import { DATA_VERSION, type DataDoc } from "./types.ts";

/** YYYY-MM-DD, and a real day — "2026-02-31" parses and is not a date. */
const YMD = /^\d{4}-\d{2}-\d{2}$/;
/** HH:MM on a 24-hour clock. */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * A minute count nothing sane exceeds. A week has 10,080 minutes in it; an
 * entry claiming more than a day is a parse error somewhere upstream, and one
 * of them silently ruins every total it is included in.
 */
const MAX_MINUTES = 24 * 60;

export interface DocProblems {
  /** Reasons the document must not be written. Empty means it may be. */
  fatal: string[];
  /**
   * Things wrong with it that are nonetheless legitimate states — dangling
   * references, almost always. Worth a line in the log, never a refusal.
   */
  warnings: string[];
}

export function validateDoc(candidate: unknown): DocProblems {
  const fatal: string[] = [];
  const warnings: string[] = [];
  const bad = (why: string) => fatal.push(why);

  if (typeof candidate !== "object" || candidate === null) {
    return { fatal: ["it isn't an object"], warnings };
  }
  const doc = candidate as DataDoc;

  if (doc.version !== DATA_VERSION) bad(`version is ${format(doc.version)}, not ${DATA_VERSION}`);
  if (!isCount(doc.rev)) bad(`rev is ${format(doc.rev)}`);

  // The three arrays are checked for being arrays before anything walks them,
  // so a null `entries` reports as itself rather than as a TypeError from
  // inside this function.
  const settingsOk = isObject(doc.settings);
  if (!settingsOk) bad(`settings is ${format(doc.settings)}`);
  else {
    if (typeof doc.settings.clinicianName !== "string") {
      bad(`settings.clinicianName is ${format(doc.settings.clinicianName)}`);
    }
    const month = doc.settings.schoolYearStartMonth;
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      bad(`settings.schoolYearStartMonth is ${format(month)}`);
    }
  }

  const categoryIds = new Set<string>();
  if (!Array.isArray(doc.categories)) bad(`categories is ${format(doc.categories)}`);
  else {
    doc.categories.forEach((category, i) => {
      const at = `categories[${i}]`;
      if (!isObject(category)) return bad(`${at} is ${format(category)}`);
      if (!isId(category.id)) bad(`${at}.id is ${format(category.id)}`);
      else categoryIds.add(category.id);
      if (typeof category.name !== "string") bad(`${at}.name is ${format(category.name)}`);
      if (category.group !== "direct" && category.group !== "indirect") {
        bad(`${at}.group is ${format(category.group)}`);
      }
      if (!isOptionalBool(category.untimed)) bad(`${at}.untimed is ${format(category.untimed)}`);
      if (!isOptionalBool(category.archived)) bad(`${at}.archived is ${format(category.archived)}`);
    });
  }

  const studentIds = new Set<string>();
  if (!Array.isArray(doc.students)) bad(`students is ${format(doc.students)}`);
  else {
    doc.students.forEach((student, i) => {
      const at = `students[${i}]`;
      if (!isObject(student)) return bad(`${at} is ${format(student)}`);
      if (!isId(student.id)) bad(`${at}.id is ${format(student.id)}`);
      else studentIds.add(student.id);
      if (typeof student.name !== "string") bad(`${at}.name is ${format(student.name)}`);
      if (typeof student.iep !== "boolean") bad(`${at}.iep is ${format(student.iep)}`);
      if (typeof student.active !== "boolean") bad(`${at}.active is ${format(student.active)}`);
      if (typeof student.createdAt !== "string")
        bad(`${at}.createdAt is ${format(student.createdAt)}`);
      if (student.grade !== undefined && typeof student.grade !== "string") {
        bad(`${at}.grade is ${format(student.grade)}`);
      }
      const mandate = student.mandatedMinutesPerWeek;
      // Null and absent both mean "not set", and are how a non-IEP student
      // looks. A fractional or negative mandate is neither.
      if (mandate !== undefined && mandate !== null && !isMinutes(mandate)) {
        bad(`${at}.mandatedMinutesPerWeek is ${format(mandate)}`);
      }
    });
  }

  if (!Array.isArray(doc.entries)) bad(`entries is ${format(doc.entries)}`);
  else {
    doc.entries.forEach((entry, i) => {
      const at = `entries[${i}]`;
      if (!isObject(entry)) return bad(`${at} is ${format(entry)}`);
      if (!isId(entry.id)) bad(`${at}.id is ${format(entry.id)}`);
      if (!isDate(entry.date)) bad(`${at}.date is ${format(entry.date)}`);
      if (!isMinutes(entry.minutes)) bad(`${at}.minutes is ${format(entry.minutes)}`);
      if (!isId(entry.categoryId)) bad(`${at}.categoryId is ${format(entry.categoryId)}`);
      else if (categoryIds.size > 0 && !categoryIds.has(entry.categoryId)) {
        warnings.push(`${at} is in a category that no longer exists`);
      }
      if (typeof entry.createdAt !== "string") bad(`${at}.createdAt is ${format(entry.createdAt)}`);
      if (entry.startTime !== undefined && entry.startTime !== null && !isTime(entry.startTime)) {
        bad(`${at}.startTime is ${format(entry.startTime)}`);
      }
      if (entry.note !== undefined && typeof entry.note !== "string") {
        bad(`${at}.note is ${format(entry.note)}`);
      }
      if (!Array.isArray(entry.studentIds)) bad(`${at}.studentIds is ${format(entry.studentIds)}`);
      else {
        // An empty array is school-level work, which is a deliberate state and
        // not a missing student — see Entry.studentIds.
        entry.studentIds.forEach((id, j) => {
          if (!isId(id)) bad(`${at}.studentIds[${j}] is ${format(id)}`);
          else if (studentIds.size > 0 && !studentIds.has(id)) {
            warnings.push(`${at} names a student who is no longer on the roster`);
          }
        });
      }
    });
  }

  if (doc.importMappings !== undefined) {
    // An array passes `typeof === "object"`, hence the explicit rejection: the
    // phrase keys come out of her pasted Google Doc rather than from a form.
    if (!isObject(doc.importMappings) || Array.isArray(doc.importMappings)) {
      bad(`importMappings is ${format(doc.importMappings)}`);
    } else {
      for (const [phrase, id] of Object.entries(doc.importMappings)) {
        if (!isId(id)) bad(`importMappings[${JSON.stringify(phrase)}] is ${format(id)}`);
        else if (categoryIds.size > 0 && !categoryIds.has(id)) {
          warnings.push(`importMappings[${JSON.stringify(phrase)}] points at a deleted category`);
        }
      }
    }
  }

  return { fatal, warnings };
}

/** The whole verdict as one sentence, or null when there is nothing to refuse. */
export function docRefusal(candidate: unknown): string | null {
  const { fatal } = validateDoc(candidate);
  if (fatal.length === 0) return null;
  // Bounded. A document whose every entry is malformed would otherwise produce
  // a message longer than the document.
  const shown = fatal.slice(0, 5).join("; ");
  const rest = fatal.length > 5 ? `, and ${fatal.length - 5} more` : "";
  return `${shown}${rest}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Non-empty, because "" is a reference that can never resolve. */
function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isCount(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0;
}

/** Whole minutes, never negative, never longer than a day. */
function isMinutes(value: unknown): boolean {
  return isCount(value) && (value as number) <= MAX_MINUTES;
}

/**
 * A real calendar date, not merely something shaped like one. `2026-02-31`
 * matches the pattern, and every report that groups by week would put it in a
 * week it does not belong to.
 */
function isDate(value: unknown): boolean {
  if (typeof value !== "string" || !YMD.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function isTime(value: unknown): boolean {
  return typeof value === "string" && HHMM.test(value);
}

function isOptionalBool(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

/** A value named in an error message, short enough to belong in one. */
function format(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "missing";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  if (typeof value === "string")
    return value.length > 30 ? `a ${value.length}-character string` : JSON.stringify(value);
  return String(value);
}

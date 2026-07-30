export type CategoryGroup = "direct" | "indirect";

export interface Category {
  id: string;
  name: string;
  group: CategoryGroup;
  /**
   * Records that something happened without recording time — a no-show, a
   * cancellation. Entries in an untimed category are always 0 minutes, so they
   * count toward event tallies but never toward hours. Rare: the exception, not
   * the rule, hence optional and absent by default.
   */
  untimed?: boolean;
  archived?: boolean;
}

export interface Student {
  id: string;
  name: string;
  iep: boolean;
  /** Weekly service minutes the IEP mandates; null/undefined when not set or not IEP. */
  mandatedMinutesPerWeek?: number | null;
  grade?: string;
  active: boolean;
  createdAt: string;
}

export interface Entry {
  id: string;
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  minutes: number;
  categoryId: string;
  /** One or more students; >1 means a group session. */
  studentIds: string[];
  /** Optional clock time, HH:MM (24h), for future timeline views. */
  startTime?: string | null;
  /**
   * Clinical note as HTML, constrained to the editor schema (see
   * frontend/lib/notes.ts). Absent when empty. Was plain text in doc version 1;
   * storage.ts migrates those forward. Never exported except in the JSON backup.
   */
  note?: string;
  createdAt: string;
}

export interface Settings {
  clinicianName: string;
  /** 1-12; month the school year rolls over (used by "School year to date"). */
  schoolYearStartMonth: number;
}

/** Bumped to 2 when notes became HTML rather than plain text. */
export const DATA_VERSION = 2;

export interface DataDoc {
  version: typeof DATA_VERSION;
  /** Optimistic-concurrency revision; the main process increments it on every accepted save. */
  rev: number;
  settings: Settings;
  categories: Category[];
  students: Student[];
  entries: Entry[];
}

export const SEED_CATEGORIES: Omit<Category, "id">[] = [
  { name: "Direct service — individual", group: "direct" },
  { name: "Direct service — group", group: "direct" },
  { name: "Crisis response", group: "direct" },
  { name: "Assessment / evaluation", group: "direct" },
  // Grouped with direct service because that's the slot it replaces; the group
  // is cosmetic for untimed categories, which contribute no minutes either way.
  { name: "No-show / cancellation", group: "direct", untimed: true },
  { name: "IEP meeting", group: "indirect" },
  { name: "Parent contact", group: "indirect" },
  { name: "Teacher / staff consultation", group: "indirect" },
  { name: "Case management", group: "indirect" },
  { name: "Documentation", group: "indirect" },
  { name: "Other", group: "indirect" },
];

export function emptyDoc(): DataDoc {
  return {
    version: DATA_VERSION,
    rev: 0,
    settings: { clinicianName: "", schoolYearStartMonth: 8 },
    categories: SEED_CATEGORIES.map((c) => ({ ...c, id: crypto.randomUUID() })),
    students: [],
    entries: [],
  };
}

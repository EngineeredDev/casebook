export type CategoryGroup = "direct" | "indirect";

export interface Category {
  id: string;
  name: string;
  group: CategoryGroup;
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
  note?: string;
  createdAt: string;
}

export interface Settings {
  clinicianName: string;
  /** 1-12; month the school year rolls over (used by "School year to date"). */
  schoolYearStartMonth: number;
}

export interface DataDoc {
  version: 1;
  /** Optimistic-concurrency revision; server increments on every accepted PUT. */
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
  { name: "IEP meeting", group: "indirect" },
  { name: "Parent contact", group: "indirect" },
  { name: "Teacher / staff consultation", group: "indirect" },
  { name: "Case management", group: "indirect" },
  { name: "Documentation", group: "indirect" },
  { name: "Other", group: "indirect" },
];

export function emptyDoc(): DataDoc {
  return {
    version: 1,
    rev: 0,
    settings: { clinicianName: "", schoolYearStartMonth: 8 },
    categories: SEED_CATEGORIES.map((c) => ({ ...c, id: crypto.randomUUID() })),
    students: [],
    entries: [],
  };
}

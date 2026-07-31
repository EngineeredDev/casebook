/**
 * Scaffolding shared by the main-process tests: a throwaway app tree, and the
 * document fixtures most of them start from.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { DATA_VERSION, type DataDoc, type Entry, type Student } from "../shared/types.ts";
import { resetAppDirs, setAppDirs } from "./electron.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  resetAppDirs();
});

export interface TempApp {
  /** The throwaway tree everything below lives inside. */
  root: string;
  /** The folder holding data.json and backups/ — whatever `dataDir()` will return. */
  dataDir: string;
  dataFile: string;
  backupDir: string;
  userData: string;
}

/**
 * A complete app tree under a fresh temp directory, torn down after the test.
 *
 * `packaged` is not just a flag: an unpackaged run pins the data folder to the
 * app path, while a packaged one consults config.json and *defaults to
 * `~/Casebook` in the real home directory* when it finds nothing. So packaged
 * mode writes a config here rather than leaving it to the caller — a test that
 * forgot would not fail, it would quietly read and rewrite the actual data file
 * belonging to whoever ran the suite.
 */
export function tempApp({ packaged = false } = {}): TempApp {
  const root = mkdtempSync(join(tmpdir(), "casebook-"));
  roots.push(root);
  setAppDirs(root, packaged);

  const userData = join(root, "userData");
  const dataDir = packaged ? join(root, "Casebook") : join(root, "app");
  mkdirSync(userData, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  if (packaged) {
    writeFileSync(join(userData, "config.json"), JSON.stringify({ dataDir }));
  }

  return {
    root,
    dataDir,
    dataFile: join(dataDir, "data.json"),
    backupDir: join(dataDir, "backups"),
    userData,
  };
}

let counter = 0;

/** Distinct but predictable, so a failing assertion names something recognisable. */
function id(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter).padStart(4, "0")}`;
}

export function student(name: string, patch: Partial<Student> = {}): Student {
  return {
    id: id("student"),
    name,
    iep: false,
    active: true,
    createdAt: "2026-01-05T09:00:00.000Z",
    ...patch,
  };
}

export function entry(patch: Partial<Entry> = {}): Entry {
  return {
    id: id("entry"),
    date: "2026-01-05",
    minutes: 30,
    categoryId: "category-direct",
    studentIds: [],
    createdAt: "2026-01-05T09:00:00.000Z",
    ...patch,
  };
}

/**
 * A document with `students` students and `entries` entries in it. Most tests
 * care only about the counts — retention, the deletion tripwire, restore
 * offers — so the contents are filler and the shape is what matters.
 */
type DocOptions = Omit<Partial<DataDoc>, "students" | "entries"> & {
  students?: number;
  entries?: number;
};

export function doc({ students = 2, entries = 5, ...patch }: DocOptions = {}): DataDoc {
  const roster = Array.from({ length: students }, (_, i) => student(`Student ${i + 1}`));
  return {
    version: DATA_VERSION,
    rev: 1,
    settings: { clinicianName: "Test Clinician", schoolYearStartMonth: 8 },
    categories: [{ id: "category-direct", name: "Direct service", group: "direct" }],
    students: roster,
    entries: Array.from({ length: entries }, (_, i) => {
      const attendee = roster[i % roster.length];
      return entry({ studentIds: attendee ? [attendee.id] : [] });
    }),
    ...patch,
  };
}

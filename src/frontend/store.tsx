import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Category, DataDoc, Entry, Student } from "../types.ts";

export type SaveState = "saved" | "saving" | "error" | "conflict";

interface StoreValue {
  doc: DataDoc;
  saveState: SaveState;
  mutate: (fn: (doc: DataDoc) => DataDoc) => void;
  reload: () => void;
  addStudent: (partial: { name: string; iep: boolean }) => Student;
  updateStudent: (id: string, patch: Partial<Student>) => void;
  addEntry: (partial: Omit<Entry, "id" | "createdAt">) => void;
  updateEntry: (id: string, patch: Partial<Entry>) => void;
  deleteEntry: (id: string) => void;
  addCategory: (name: string, group: Category["group"]) => void;
  updateCategory: (id: string, patch: Partial<Category>) => void;
}

const StoreContext = createContext<StoreValue | null>(null);

const SAVE_DEBOUNCE_MS = 500;

export function StoreProvider({ children }: { children: ReactNode }) {
  const [doc, setDoc] = useState<DataDoc | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");

  const docRef = useRef<DataDoc | null>(null);
  docRef.current = doc;
  const dirtyRef = useRef(false);
  const inFlightRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/data");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const fresh = (await res.json()) as DataDoc;
      dirtyRef.current = false;
      setDoc(fresh);
      setSaveState("saved");
    } catch (err) {
      setLoadError(String(err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const flush = useCallback(async () => {
    if (inFlightRef.current) return;
    const current = docRef.current;
    if (!current || !dirtyRef.current) return;
    inFlightRef.current = true;
    dirtyRef.current = false;
    setSaveState("saving");
    try {
      const res = await fetch("/api/data", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(current),
      });
      if (res.status === 409) {
        setSaveState("conflict");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { rev } = (await res.json()) as { rev: number };
      setDoc((d) => (d ? { ...d, rev } : d));
      setSaveState(dirtyRef.current ? "saving" : "saved");
    } catch {
      dirtyRef.current = true;
      setSaveState("error");
    } finally {
      inFlightRef.current = false;
      if (dirtyRef.current) {
        timerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
      }
    }
  }, []);

  const mutate = useCallback(
    (fn: (d: DataDoc) => DataDoc) => {
      setDoc((d) => {
        if (!d) return d;
        return fn(d);
      });
      dirtyRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  // Retry failed saves when the tab regains focus; warn before closing with unsaved edits.
  useEffect(() => {
    const onFocus = () => {
      if (dirtyRef.current) flush();
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current || inFlightRef.current) e.preventDefault();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [flush]);

  const addStudent = useCallback(
    (partial: { name: string; iep: boolean }): Student => {
      const student: Student = {
        id: crypto.randomUUID(),
        name: partial.name.trim(),
        iep: partial.iep,
        mandatedMinutesPerWeek: null,
        active: true,
        createdAt: new Date().toISOString(),
      };
      mutate((d) => ({ ...d, students: [...d.students, student] }));
      return student;
    },
    [mutate],
  );

  const updateStudent = useCallback(
    (id: string, patch: Partial<Student>) =>
      mutate((d) => ({
        ...d,
        students: d.students.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      })),
    [mutate],
  );

  const addEntry = useCallback(
    (partial: Omit<Entry, "id" | "createdAt">) =>
      mutate((d) => ({
        ...d,
        entries: [
          ...d.entries,
          { ...partial, id: crypto.randomUUID(), createdAt: new Date().toISOString() },
        ],
      })),
    [mutate],
  );

  const updateEntry = useCallback(
    (id: string, patch: Partial<Entry>) =>
      mutate((d) => ({
        ...d,
        entries: d.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)),
      })),
    [mutate],
  );

  const deleteEntry = useCallback(
    (id: string) => mutate((d) => ({ ...d, entries: d.entries.filter((e) => e.id !== id) })),
    [mutate],
  );

  const addCategory = useCallback(
    (name: string, group: Category["group"]) =>
      mutate((d) => ({
        ...d,
        categories: [...d.categories, { id: crypto.randomUUID(), name: name.trim(), group }],
      })),
    [mutate],
  );

  const updateCategory = useCallback(
    (id: string, patch: Partial<Category>) =>
      mutate((d) => ({
        ...d,
        categories: d.categories.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      })),
    [mutate],
  );

  if (loadError) {
    return (
      <div className="empty-state">
        <p>Couldn't load your data: {loadError}</p>
        <button className="btn primary" onClick={load}>
          Retry
        </button>
      </div>
    );
  }
  if (!doc) return <div className="empty-state">Loading…</div>;

  return (
    <StoreContext.Provider
      value={{
        doc,
        saveState,
        mutate,
        reload: load,
        addStudent,
        updateStudent,
        addEntry,
        updateEntry,
        deleteEntry,
        addCategory,
        updateCategory,
      }}
    >
      {children}
    </StoreContext.Provider>
  );
}

export function useStore(): StoreValue {
  const v = useContext(StoreContext);
  if (!v) throw new Error("useStore outside StoreProvider");
  return v;
}

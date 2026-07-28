import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Alert, Button, Center, Loader, Stack } from "@mantine/core";
import type { Category, DataDoc, Entry, Student } from "../types.ts";

export type SaveState = "saved" | "saving" | "retrying" | "error" | "conflict";

interface StoreValue {
  doc: DataDoc;
  saveState: SaveState;
  mutate: (fn: (doc: DataDoc) => DataDoc) => void;
  reload: () => void;
  retrySave: () => void;
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
/**
 * A failing save backs off instead of hammering: 1s, 2s, 4s, 8s, 16s, then it
 * stops and waits for the user. Retrying forever is what a broken server turns
 * into a request loop, and past a certain point the retry is not going to be
 * the thing that fixes it — a person looking at the error is.
 */
const RETRY_BASE_MS = 1000;
const MAX_RETRIES = 5;

export function StoreProvider({ children }: { children: ReactNode }) {
  const [doc, setDoc] = useState<DataDoc | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");

  const docRef = useRef<DataDoc | null>(null);
  docRef.current = doc;
  const dirtyRef = useRef(false);
  const inFlightRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef(0);
  /**
   * Set while saves are failing. Edits made in that window ride the backoff
   * timer rather than scheduling their own request — otherwise every keystroke
   * against a down server would restart the debounce and cancel the backoff.
   */
  const failingRef = useRef(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/data");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const fresh = (await res.json()) as DataDoc;
      dirtyRef.current = false;
      failingRef.current = false;
      attemptsRef.current = 0;
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
    // Null means nothing more is scheduled: the attempt either succeeded with
    // nothing left to send, or failed in a way another request won't mend.
    let nextAttemptMs: number | null = null;
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
      // The server rejected the document itself. Re-sending the same bytes
      // gets the same answer, so this ends the run rather than spending the
      // retry budget proving it.
      if (res.status >= 400 && res.status < 500) {
        dirtyRef.current = true;
        failingRef.current = true;
        setSaveState("error");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { rev } = (await res.json()) as { rev: number };
      failingRef.current = false;
      attemptsRef.current = 0;
      setDoc((d) => (d ? { ...d, rev } : d));
      setSaveState(dirtyRef.current ? "saving" : "saved");
      if (dirtyRef.current) nextAttemptMs = SAVE_DEBOUNCE_MS;
    } catch {
      // Network failure or a 5xx — both plausibly transient, both worth a
      // bounded number of retries on a widening interval.
      dirtyRef.current = true;
      failingRef.current = true;
      attemptsRef.current += 1;
      if (attemptsRef.current > MAX_RETRIES) {
        setSaveState("error");
      } else {
        nextAttemptMs = RETRY_BASE_MS * 2 ** (attemptsRef.current - 1);
        setSaveState("retrying");
      }
    } finally {
      inFlightRef.current = false;
      if (dirtyRef.current && nextAttemptMs !== null) {
        timerRef.current = setTimeout(flush, nextAttemptMs);
      }
    }
  }, []);

  /**
   * Deliberate "try again" — from the failure alert or from returning to the
   * tab. The budget resets because the user is asserting something changed.
   */
  const retrySave = useCallback(() => {
    if (!dirtyRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    attemptsRef.current = 0;
    failingRef.current = false;
    flush();
  }, [flush]);

  const mutate = useCallback(
    (fn: (d: DataDoc) => DataDoc) => {
      setDoc((d) => {
        if (!d) return d;
        return fn(d);
      });
      dirtyRef.current = true;
      // The backoff timer already owns the next attempt and is holding the
      // whole document; restarting the debounce here would cancel it and put
      // the request loop back.
      if (failingRef.current) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  // Retry failed saves when the tab regains focus; warn before closing with unsaved edits.
  useEffect(() => {
    const onFocus = () => {
      retrySave();
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
  }, [retrySave]);

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

  // Built once per doc change rather than per render: every consumer re-renders
  // whenever this value's identity changes, and the actions are already
  // useCallback-stable. It has to be computed above the early returns below,
  // so it carries the null case rather than being guarded by it.
  const value = useMemo(
    () =>
      doc
        ? {
            doc,
            saveState,
            mutate,
            reload: load,
            retrySave,
            addStudent,
            updateStudent,
            addEntry,
            updateEntry,
            deleteEntry,
            addCategory,
            updateCategory,
          }
        : null,
    [
      doc,
      saveState,
      mutate,
      load,
      retrySave,
      addStudent,
      updateStudent,
      addEntry,
      updateEntry,
      deleteEntry,
      addCategory,
      updateCategory,
    ],
  );

  if (loadError) {
    return (
      <Center h="100vh" p="md">
        <Stack align="center" gap="sm">
          <Alert color="red" title="Couldn't load your data" variant="light">
            {loadError}
          </Alert>
          <Button onClick={load}>Retry</Button>
        </Stack>
      </Center>
    );
  }
  if (!value) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const v = useContext(StoreContext);
  if (!v) throw new Error("useStore outside StoreProvider");
  return v;
}

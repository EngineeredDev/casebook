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
import type { Category, DataDoc, Entry, Student } from "../shared/types.ts";
import { api, bridgeMessage } from "./lib/api.ts";

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
 * stops and waits for the user. Retrying forever is what a disk it cannot write
 * to turns
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
   * made while the disk is refusing writes would restart the debounce and
   * cancel the backoff.
   */
  const failingRef = useRef(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const fresh = await api().getDoc();
      dirtyRef.current = false;
      failingRef.current = false;
      attemptsRef.current = 0;
      setDoc(fresh);
      setSaveState("saved");
    } catch (err) {
      setLoadError(bridgeMessage(err));
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
    // nothing left to send, or failed in a way another attempt won't mend.
    let nextAttemptMs: number | null = null;
    try {
      const result = await api().saveDoc(current);
      if ("conflict" in result) {
        // Nothing here can resolve it — the alert offers a reload, which is the
        // only move that can't lose the file's version — but which two
        // revisions disagreed is the difference between diagnosing this later
        // and guessing at it.
        console.warn(
          `Save conflict: sent rev ${current.rev}, the data file is at rev ${result.currentRev}.`,
        );
        setSaveState("conflict");
        return;
      }
      if ("error" in result) {
        // Something the main process refuses to write — a malformed document —
        // is refused identically forever, so this ends the run rather than
        // spending the retry budget proving it. A failed disk write is the
        // other kind and is thrown into the retry path below.
        if (!result.retryable) {
          dirtyRef.current = true;
          failingRef.current = true;
          setSaveState("error");
          return;
        }
        throw new Error(result.error);
      }
      failingRef.current = false;
      attemptsRef.current = 0;
      setDoc((d) => (d ? { ...d, rev: result.rev } : d));
      setSaveState(dirtyRef.current ? "saving" : "saved");
      if (dirtyRef.current) nextAttemptMs = SAVE_DEBOUNCE_MS;
    } catch {
      // A write that failed on disk, or a bridge call that didn't come back at
      // all — both plausibly transient, both worth a bounded number of retries
      // on a widening interval.
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
   * Deliberate "try again" — from the failure alert or from coming back to the
   * window. The budget resets because the user is asserting something changed.
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

  // Retry failed saves when the window regains focus.
  useEffect(() => {
    const onFocus = () => {
      retrySave();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [retrySave]);

  /**
   * Keep the main process told whether anything is still on its way to disk, so
   * that closing the window can ask first. `beforeunload` did this in the
   * browser and does not translate: Electron honours the cancellation but shows
   * no dialog, so the window would simply refuse to close and never say why.
   *
   * Every moment either fact can change is a render that changed `doc` or
   * `saveState`, so those are the dependencies.
   */
  useEffect(() => {
    if (!doc) return;
    void api().setUnsaved(dirtyRef.current || inFlightRef.current || saveState !== "saved");
  }, [doc, saveState]);

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

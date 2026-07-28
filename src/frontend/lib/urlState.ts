/**
 * View state that belongs in the URL — the range picker, the attribution
 * toggle, the day being logged, the entry being edited.
 *
 * Two conventions hold throughout: a param is **omitted when it holds its
 * default**, so /dashboard and /students/<id> stay clean and only a deliberate
 * choice shows up in the address bar; and an unknown or malformed value falls
 * back to the default rather than throwing, because a hand-edited URL should
 * never white-screen the app.
 */

import { useCallback, useMemo } from "react";
import { useSearchParams } from "./router.tsx";
import { defaultRange, presetRange, todayYmd, YMD_RE, type RangeSelection } from "./time.ts";
import type { Attribution } from "./aggregate.ts";

const DEFAULT_ATTRIBUTION: Attribution = "share";

export function useRangeParam(
  schoolYearStartMonth: number,
  defaultKey?: string,
): [RangeSelection, (next: RangeSelection) => void] {
  const [params, setParams] = useSearchParams();
  const key = params.get("range");
  const from = params.get("from");
  const to = params.get("to");

  let value: RangeSelection;
  if (key === "custom" && from && to && YMD_RE.test(from) && YMD_RE.test(to) && from <= to) {
    value = { key: "custom", label: `${from} – ${to}`, range: { from, to } };
  } else {
    value =
      (key ? presetRange(key, schoolYearStartMonth) : null) ??
      defaultRange(schoolYearStartMonth, defaultKey);
  }

  const set = useCallback(
    (next: RangeSelection) => {
      setParams((p) => {
        p.delete("from");
        p.delete("to");
        if (next.key === "custom") {
          p.set("range", "custom");
          p.set("from", next.range.from);
          p.set("to", next.range.to);
        } else if (next.key === defaultKey || (!defaultKey && next.key === "12-weeks")) {
          p.delete("range");
        } else {
          p.set("range", next.key);
        }
      });
    },
    [setParams, defaultKey],
  );

  return [value, set];
}

export function useAttributionParam(): [Attribution, (next: Attribution) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get("attr");
  const value: Attribution = raw === "service" ? "service" : DEFAULT_ATTRIBUTION;

  const set = useCallback(
    (next: Attribution) => {
      setParams((p) => {
        if (next === DEFAULT_ATTRIBUTION) p.delete("attr");
        else p.set("attr", next);
      });
    },
    [setParams],
  );

  return [value, set];
}

/** A checkbox-style flag: present as "1" when on, absent when off. */
export function useFlagParam(name: string): [boolean, (next: boolean) => void] {
  const [params, setParams] = useSearchParams();
  const set = useCallback(
    (next: boolean) => {
      setParams((p) => {
        if (next) p.set(name, "1");
        else p.delete(name);
      });
    },
    [setParams, name],
  );
  return [params.get(name) === "1", set];
}

/**
 * Free text in the query string — the timeline's search box.
 *
 * Written on every keystroke rather than debounced, like every other filter on
 * the page: `useSearchParams` replaces rather than pushes, so this costs one
 * `replaceState` per character and never grows the back stack. Reload and
 * "copy link" then reproduce a search exactly.
 */
export function useTextParam(name: string): [string, (next: string) => void] {
  const [params, setParams] = useSearchParams();
  const set = useCallback(
    (next: string) => {
      setParams((p) => {
        const trimmed = next.trim();
        if (trimmed) p.set(name, next);
        else p.delete(name);
      });
    },
    [setParams, name],
  );
  return [params.get(name) ?? "", set];
}

/**
 * A set of ids as one comma-separated param. Memoized on the raw string so the
 * array identity only changes when the selection does, and callers can use it
 * as a dependency without recomputing on every render.
 */
export function useIdsParam(name: string): [string[], (next: string[]) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(name) ?? "";
  const value = useMemo(() => (raw ? raw.split(",").filter(Boolean) : []), [raw]);

  const set = useCallback(
    (next: string[]) => {
      setParams((p) => {
        if (next.length) p.set(name, next.join(","));
        else p.delete(name);
      });
    },
    [setParams, name],
  );

  return [value, set];
}

/** One of a fixed set of values; anything else in the URL reads as the default. */
export function useEnumParam<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(name) as T | null;
  const value = raw && allowed.includes(raw) ? raw : fallback;

  const set = useCallback(
    (next: T) => {
      setParams((p) => {
        if (next === fallback) p.delete(name);
        else p.set(name, next);
      });
    },
    [setParams, name, fallback],
  );

  return [value, set];
}

/** The Log page's day. Absent means today, which is what it means to open the app. */
export function useDateParam(): [string, (next: string) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get("date");
  const value = raw && YMD_RE.test(raw) ? raw : todayYmd();

  const set = useCallback(
    (next: string) => {
      setParams((p) => {
        if (next === todayYmd()) p.delete("date");
        else p.set("date", next);
      });
    },
    [setParams],
  );

  return [value, set];
}

/**
 * How the Log page was arrived at: where to return to after an edit that came
 * from elsewhere, whether to focus the form, and any student to seed it with.
 *
 * Router state rather than query params, unlike everything above: these are
 * one-shot signals about a form that is about to be filled in and cleared, not
 * a view worth linking to or restoring on reload.
 */
export interface LogNavState {
  returnTo?: string;
  focus?: boolean;
  /** Student id to pre-select, for "Log time" pressed on a student's page. */
  student?: string;
}

export function logEditPath(entryId: string, date: string): string {
  return `/log?date=${date}&edit=${encodeURIComponent(entryId)}`;
}

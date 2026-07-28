/**
 * A router for six routes and one dynamic segment.
 *
 * Deliberately not react-router: everything that library adds beyond this file
 * — nested layouts, loaders, lazy routes, navigation blocking, scroll
 * restoration — is either unusable in its declarative mode or meaningless in a
 * single-user app served from loopback with no code splitting. See
 * docs/routing-and-student-page.md §4.
 */

import { useCallback, useMemo, useSyncExternalStore, type ComponentPropsWithoutRef } from "react";

/**
 * Every navigable view as a closed union, so the render switch is
 * exhaustiveness-checked and `studentId` is a `string` rather than the
 * `string | undefined` a generic path matcher has to return.
 */
export type Route =
  | { page: "log" }
  | { page: "dashboard" }
  | { page: "students" }
  | { page: "student"; studentId: string }
  | { page: "reports" }
  | { page: "notFound" };

export function parseRoute(pathname: string): Route {
  const [head, second] = pathname.split("/").filter(Boolean);
  if (!head) return { page: "log" };
  if (head === "students") {
    return second ? { page: "student", studentId: decodeURIComponent(second) } : { page: "students" };
  }
  if (head === "log" || head === "dashboard" || head === "reports") return { page: head };
  return { page: "notFound" };
}

export const studentPath = (id: string) => `/students/${encodeURIComponent(id)}`;

/* ---------- history as an external store ---------- */

const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  window.addEventListener("popstate", fn);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("popstate", fn);
  };
}

interface HistoryEntry {
  href: string;
  /** Caller-supplied state — survives reload, never appears in the URL. */
  state: unknown;
  /** Unique per history entry, so repeating the same navigation is still observable. */
  key: number;
}

/**
 * useSyncExternalStore compares snapshots by identity, so this must return the
 * very same object until something actually changes — rebuilding it on every
 * read would re-render forever.
 */
let snapshot: HistoryEntry = { href: "", state: null, key: 0 };
let nextKey = 1;

function getSnapshot(): HistoryEntry {
  const href = window.location.pathname + window.location.search;
  const raw = window.history.state as { usr?: unknown; key?: number } | null;
  const state = raw?.usr ?? null;
  const key = raw?.key ?? 0;
  if (href !== snapshot.href || state !== snapshot.state || key !== snapshot.key) {
    snapshot = { href, state, key };
  }
  return snapshot;
}

export interface NavOptions {
  replace?: boolean;
  state?: unknown;
}

export function navigate(to: string, opts: NavOptions = {}): void {
  const entry = { usr: opts.state ?? null, key: nextKey++ };
  if (opts.replace) window.history.replaceState(entry, "", to);
  else window.history.pushState(entry, "", to);
  for (const listener of listeners) listener();
}

/* ---------- hooks ---------- */

export interface RouterLocation {
  pathname: string;
  /**
   * Includes the leading "?" when non-empty, exactly like the DOM's
   * `location.search`. Dropping it makes `pathname + search` concatenate into a
   * corrupt path, which is precisely how a "return here afterwards" link breaks.
   */
  search: string;
  params: URLSearchParams;
  state: unknown;
  /** Changes on every navigation, including a repeat of the current one. */
  key: number;
}

export function useLocation(): RouterLocation {
  const entry = useSyncExternalStore(subscribe, getSnapshot);
  return useMemo(() => {
    const q = entry.href.indexOf("?");
    const pathname = q === -1 ? entry.href : entry.href.slice(0, q);
    const search = q === -1 ? "" : entry.href.slice(q);
    return {
      pathname,
      search,
      // URLSearchParams strips a leading "?" itself.
      params: new URLSearchParams(search),
      state: entry.state,
      key: entry.key,
    };
  }, [entry]);
}

export function useRoute(): Route {
  const { pathname } = useLocation();
  return useMemo(() => parseRoute(pathname), [pathname]);
}

/** Prefix match, so /students/abc-123 still lights the Students nav item. */
export function useIsActive(to: string): boolean {
  const { pathname } = useLocation();
  return pathname === to || pathname.startsWith(`${to}/`);
}

export type SetSearchParams = (
  update: (params: URLSearchParams) => void,
  opts?: NavOptions,
) => void;

/**
 * Read and write the current path's query string. Writes default to `replace`
 * so the back button steps between pages rather than between filter values.
 */
export function useSearchParams(): [URLSearchParams, SetSearchParams] {
  const { pathname, params } = useLocation();
  const set = useCallback<SetSearchParams>(
    (update, opts = {}) => {
      // Read live rather than closing over `params`, so two writes in one tick compose.
      const next = new URLSearchParams(window.location.search);
      update(next);
      const qs = next.toString();
      navigate(qs ? `${pathname}?${qs}` : pathname, { replace: true, ...opts });
    },
    [pathname],
  );
  return [params, set];
}

/* ---------- Link ---------- */

export interface LinkProps extends Omit<ComponentPropsWithoutRef<"a">, "href"> {
  to: string;
  replace?: boolean;
  state?: unknown;
}

/**
 * Client-side navigation that still behaves like a link. Modified clicks and
 * middle-clicks fall through to the browser untouched, so "open in new tab",
 * "copy link address", and the status-bar URL preview all keep working — the
 * things people quietly rely on and notice immediately when a SPA breaks them.
 */
export function Link({ to, replace, state, onClick, ...rest }: LinkProps) {
  return (
    <a
      href={to}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (rest.target && rest.target !== "_self") return;
        event.preventDefault();
        navigate(to, { replace, state });
      }}
      {...rest}
    />
  );
}

/**
 * What jsdom is missing that Mantine and the app expect to be there.
 *
 * Kept to the genuine gaps. Every stub here is a small lie, and a lie a test
 * asserts on becomes a test of the lie — so nothing is stubbed to a *value*
 * that a test could meaningfully check. `matchMedia` always says no, which is
 * the honest answer for a window with no size; the observers do nothing, which
 * is what they do in a document that never lays out.
 */

import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// React Testing Library unmounts between tests only if asked, and a component
// left mounted keeps its subscriptions — which is the very thing some of these
// tests are about.
afterEach(cleanup);

// Mantine reads this on mount for its colour scheme and its responsive props.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

class Nothing {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

vi.stubGlobal("ResizeObserver", Nothing);
vi.stubGlobal("IntersectionObserver", Nothing);

// jsdom has no layout, so it has no scrolling either. Mantine's Combobox keeps
// the highlighted option in view on a timer, and the throw lands outside any
// test's stack — an uncaught exception rather than a failed assertion.
Element.prototype.scrollIntoView = () => {};

// `crypto.randomUUID` needs a secure context, which jsdom is not. Real
// randomness is not the point — distinctness is, since these ids exist to tell
// one request from another.
if (!globalThis.crypto?.randomUUID) {
  let n = 0;
  Object.defineProperty(globalThis.crypto ?? (globalThis.crypto = {} as Crypto), "randomUUID", {
    writable: true,
    value: () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, "0")}`,
  });
}

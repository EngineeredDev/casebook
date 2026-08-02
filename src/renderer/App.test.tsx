/**
 * What is left on the screen when a render throws.
 *
 * Not a test of a component's appearance — a test that the app has a floor at
 * all. Before the boundary, any thrown error unmounted the whole tree and left
 * a grey window: no message, no reload, and no devtools to open in a packaged
 * Electron app. The three things asserted here are the three things that screen
 * has to offer, and each of them was reachable only by force-quitting before.
 *
 * `ErrorBoundary` is exercised directly rather than through `App`, because
 * mounting App means mounting the store and the bridge — the very things a
 * boundary is not allowed to depend on.
 */

import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CasebookApi } from "../shared/api.ts";
import { ErrorBoundary } from "./App.tsx";

/** The everyday shape of this: a page reading a field off something undefined. */
function Broken(): never {
  throw new Error("Cannot read properties of undefined (reading 'name')");
}

function show(children: React.ReactNode) {
  return render(
    <MantineProvider>
      <ErrorBoundary>{children}</ErrorBoundary>
    </MantineProvider>,
  );
}

beforeEach(() => {
  // React reports every caught error through console.error, and the boundary
  // logs it a second time on purpose. Both are the expected output of a test
  // whose whole subject is a thrown error, so they are silenced rather than
  // left to make a passing run look like a failing one.
  vi.spyOn(console, "error").mockImplementation(() => {});
  delete window.casebook;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a render that throws", () => {
  it("leaves the children alone when nothing throws", () => {
    show(<p>The log</p>);
    expect(screen.getByText("The log")).toBeTruthy();
  });

  it("says what happened instead of emptying the window", () => {
    show(<Broken />);
    expect(screen.getByText(/Casebook hit a problem/)).toBeTruthy();
    // Her first question is whether the records are gone. It is answered on the
    // screen, above the fold, before anything technical.
    expect(screen.getByText(/Nothing has been deleted/)).toBeTruthy();
    expect(screen.getByText(/reading 'name'/)).toBeTruthy();
  });

  it("offers the two things she can actually do about it", () => {
    show(<Broken />);
    expect(screen.getByRole("button", { name: /Reload Casebook/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Show data folder in Finder/ })).toBeTruthy();
  });

  it("opens the data folder when asked", async () => {
    const revealDataFolder = vi.fn(() => Promise.resolve());
    window.casebook = { revealDataFolder } as unknown as CasebookApi;

    show(<Broken />);
    await userEvent.click(screen.getByRole("button", { name: /Show data folder in Finder/ }));

    expect(revealDataFolder).toHaveBeenCalledTimes(1);
  });

  it("survives a bridge that is missing too", async () => {
    // `api()` throws when the preload never loaded, and a preload that never
    // loaded is a plausible reason to be on this screen in the first place. A
    // throw out of the click handler would take down the last screen standing.
    show(<Broken />);
    await userEvent.click(screen.getByRole("button", { name: /Show data folder in Finder/ }));

    expect(screen.getByText(/Casebook hit a problem/)).toBeTruthy();
  });
});

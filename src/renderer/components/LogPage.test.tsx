/**
 * What happens to a note that has been typed but not saved.
 *
 * The rule being pinned is about *time*, which is why it needs a DOM and could
 * not be a unit test: the draft has to still be there after the page has been
 * unmounted and mounted again. Everything the app does to protect her work —
 * the atomic writer, the `.prev` copy, three tiers of snapshot, the mirror —
 * begins at the moment an entry is saved, and this is the window before that,
 * where a half-written note used to live in `useState` and go wherever
 * `useState` goes.
 *
 * The rich-text editor is stubbed to a textarea. ProseMirror in jsdom is a
 * large amount of machinery to stand up for a test that is not about it, and
 * what matters here is that the note's *text* comes back, not how it is edited.
 */

import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataDoc } from "../../shared/types.ts";
import { hasUnsavedDraft, readDraft, resetDraft } from "../lib/draft.ts";
import { LogPage } from "./LogPage.tsx";

const doc = {
  version: 3,
  rev: 1,
  settings: { clinicianName: "", schoolYearStartMonth: 8 },
  categories: [
    { id: "cat-direct", name: "Individual counseling", group: "direct" },
    { id: "cat-noshow", name: "Absent", group: "direct", untimed: true },
  ],
  students: [{ id: "s-ada", name: "Ada", iep: true, active: true, createdAt: "2026-01-05T09:00" }],
  entries: [],
} as unknown as DataDoc;

const addEntry = vi.fn();

vi.mock("../store.tsx", () => ({
  useStore: () => ({
    doc,
    addEntry: (...args: unknown[]) => addEntry(...args),
    updateEntry: vi.fn(),
    deleteEntry: vi.fn(),
    addStudent: vi.fn(),
  }),
}));

/**
 * The editor reduced to the one thing these tests need of it: somewhere for the
 * note's text to live. Its own "Log entry" button is left out — the page has a
 * second one of its own, which is the one driven below.
 */
vi.mock("./NoteEditor.tsx", () => ({
  NoteEditor: ({ value, onChange }: { value: string; onChange: (html: string) => void }) => (
    <textarea
      aria-label="Note"
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  ),
}));

function show() {
  return render(
    <MantineProvider>
      <LogPage />
    </MantineProvider>,
  );
}

const note = () => screen.getByLabelText("Note") as HTMLTextAreaElement;
const startTime = () => screen.getByLabelText(/Start time/) as HTMLInputElement;

beforeEach(() => {
  resetDraft();
  addEntry.mockClear();
  window.history.replaceState(null, "", "/log");
});

afterEach(resetDraft);

describe("a note she has started but not saved", () => {
  it("is still there when the page comes back", async () => {
    // The whole finding, in one test. Leaving /log for any other page unmounts
    // this component, and everything in the form went with it — silently, while
    // the header said "Saved".
    const first = show();
    await userEvent.type(note(), "Student asked to talk about home.");
    await userEvent.type(startTime(), "10:55");

    first.unmount();
    show();

    expect(note().value).toBe("Student asked to talk about home.");
    expect(startTime().value).toBe("10:55");
  });

  it("counts as unsaved work the moment there are words in it", async () => {
    show();
    expect(hasUnsavedDraft()).toBe(false);

    await userEvent.type(note(), "A");

    // Which is what reaches the main process, and therefore what stands between
    // her and a window that closes over it, or a Cmd-R that reloads past it.
    expect(hasUnsavedDraft()).toBe(true);
  });

  it("remembers the day it was being written for", async () => {
    // The date is the one field that already survived a navigation, because it
    // is in the URL — but only while she is on this page. Coming back to a bare
    // /log would otherwise pair a note written for a Tuesday in March with
    // today, and saving it would file the session on the wrong day.
    window.history.replaceState(null, "", "/log?date=2026-03-04");
    const first = show();
    await userEvent.type(note(), "Written on the fourth.");
    expect(readDraft()?.date).toBe("2026-03-04");

    first.unmount();
    window.history.replaceState(null, "", "/log");
    show();

    expect(note().value).toBe("Written on the fourth.");
    expect(readDraft()?.date).toBe("2026-03-04");
  });

  it("is let go of once it has been saved", async () => {
    // Otherwise the entry she just wrote comes back as a draft of itself the
    // next time she opens the log, and is written a second time.
    const first = show();
    await userEvent.type(note(), "Talked about the letter.");
    await userEvent.type(screen.getByPlaceholderText(/Type a student's name/), "Ada");
    await userEvent.click(await screen.findByRole("option", { name: /Ada/, hidden: true }));
    await userEvent.click(screen.getByText("Individual counseling"));

    await userEvent.click(screen.getByRole("button", { name: "Log entry" }));

    expect(addEntry).toHaveBeenCalledTimes(1);
    expect(hasUnsavedDraft()).toBe(false);
    expect(note().value).toBe("");

    // And it is gone for the next mount too, not merely cleared on screen.
    first.unmount();
    show();
    expect(note().value).toBe("");
  });
});

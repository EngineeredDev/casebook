/**
 * Getting at an earlier note without a mouse.
 *
 * Reading the last few notes while writing today's is the whole reason the
 * expanded editor exists, and each of those rows was a div with an onClick on
 * it: no focus, no Enter, and nothing at all announced. Cursor and hover made
 * it look like a control while being unreachable from the keyboard she is
 * already using — her hands are on it, because she has just been typing.
 *
 * ProseMirror does mount in jsdom, so this drives the real component rather
 * than a stub. Nothing here touches the writing surface; the rows are ordinary
 * DOM either way.
 */

import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DataDoc } from "../../shared/types.ts";
import { NoteEditor } from "./NoteEditor.tsx";

const doc = {
  version: 3,
  rev: 1,
  settings: { clinicianName: "", schoolYearStartMonth: 8 },
  categories: [{ id: "cat-direct", name: "Individual counseling", group: "direct" }],
  students: [{ id: "s-ada", name: "Ada", iep: true, active: true, createdAt: "2026-01-05T09:00" }],
  entries: [
    {
      id: "e-1",
      date: "2026-04-28",
      minutes: 30,
      categoryId: "cat-direct",
      studentIds: ["s-ada"],
      note: "<p>Talked about the letter from home.</p>",
      createdAt: "2026-04-28T09:00:00.000Z",
    },
  ],
} as unknown as DataDoc;

vi.mock("../store.tsx", () => ({ useStore: () => ({ doc }) }));

function show() {
  return render(
    <MantineProvider>
      <NoteEditor
        value=""
        onChange={vi.fn()}
        onSubmit={() => true}
        canSubmit
        submitLabel="Log entry"
        studentIds={["s-ada"]}
        schoolLevel={false}
        editingId={null}
        date="2026-05-04"
      />
    </MantineProvider>,
  );
}

/** Past notes only exist in the expanded view, so every test opens it first. */
async function expand() {
  await userEvent.click(screen.getByRole("button", { name: "Expand note editor" }));
}

describe("a past note in the expanded editor", () => {
  it("is a control the keyboard can reach", async () => {
    show();
    await expand();

    const row = await screen.findByRole("button", { name: /Talked about the letter/ });
    row.focus();

    // A div with an onClick cannot hold focus at all: calling focus() on one
    // leaves activeElement on the body, which is exactly what shipped.
    expect(document.activeElement).toBe(row);
  });

  it("opens on Enter, the same as it does on a click", async () => {
    show();
    await expand();

    const row = await screen.findByRole("button", { name: /Talked about the letter/ });
    row.focus();
    await userEvent.keyboard("{Enter}");

    // The excerpt is replaced by the note itself — the one thing the row is for.
    expect(await screen.findByText("Talked about the letter from home.")).toBeTruthy();
    expect(row.getAttribute("aria-expanded")).toBe("true");
  });

  it("closes again on Space, so the keyboard can undo what it did", async () => {
    show();
    await expand();

    const row = await screen.findByRole("button", { name: /Talked about the letter/ });
    row.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");

    expect(row.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("the note editor's controls", () => {
  it("gives the writing surface a name of its own", async () => {
    // The visible "Note" label is a <label> with nothing to point at, because
    // ProseMirror builds the editable node itself. Without the attribute the
    // main thing on the screen reaches a screen reader as an unnamed text box.
    show();
    expect(await screen.findByLabelText("Note")).toBeTruthy();
  });
});

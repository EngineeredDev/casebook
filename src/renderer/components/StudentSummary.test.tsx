/**
 * Whose summary is on the screen.
 *
 * Summary text is broadcast to every window, an abandoned job goes on
 * producing it, and a component that has moved on to another student is still
 * subscribed. That combination put one child's narrative under another child's
 * name — the worst thing a stream can do in a clinical tool, and completely
 * invisible in a screenshot, because every individual frame looks like a
 * summary being written.
 *
 * So this file is about *time*, which is why it exists at all: none of it is
 * arithmetic the node suite could check, and none of it is a layout the real
 * app would show you. Every test drives the same shape — start a run, take
 * control of the stream, change something underneath it, and ask what the view
 * is now claiming.
 */

import { MantineProvider } from "@mantine/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CasebookApi } from "../../shared/api.ts";
import type { SummaryChunk } from "../../shared/llm.ts";
import type { DataDoc, Entry, Student } from "../../shared/types.ts";
import { NotesSummary } from "./StudentSummary.tsx";

const settings = { schoolYearStartMonth: 8 } as DataDoc["settings"];

vi.mock("../store.tsx", () => ({ useStore: () => ({ doc: { settings } }) }));

function student(id: string, name: string): Student {
  return { id, name, iep: true, active: true, createdAt: "2026-01-05T09:00:00.000Z" };
}

/** One note, dated today, so it lands inside every window the Select offers. */
function notes(studentId: string, text: string): Entry[] {
  return [
    {
      id: `entry-${studentId}`,
      date: new Date().toISOString().slice(0, 10),
      minutes: 30,
      categoryId: "cat-1",
      studentIds: [studentId],
      note: `<p>${text}</p>`,
      createdAt: "2026-07-01T09:00:00.000Z",
    },
  ];
}

/**
 * The bridge, with the summary call held open.
 *
 * `summarizeNotes` never resolves on its own — the test resolves it — because
 * everything worth asserting here happens while a request is still in flight.
 * The request ids are recorded in order, so a test can address the run it
 * abandoned as easily as the one it is watching.
 */
function bridge() {
  const listeners = new Set<(chunk: SummaryChunk) => void>();
  const ids: string[] = [];
  let finish: ((value: string) => void) | null = null;

  const api = {
    getModelStatus: () => Promise.resolve({ state: "ready" }),
    onModelStatus: () => () => {},
    onSummaryChunk: (listener: (chunk: SummaryChunk) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    summarizeNotes: (request: { requestId: string }) => {
      ids.push(request.requestId);
      return new Promise<{ ok: true; value: string }>((resolve) => {
        finish = (value) => resolve({ ok: true, value });
      });
    },
  } as unknown as CasebookApi;

  window.casebook = api;
  return {
    ids,
    /** Broadcast to everything listening, exactly as the main process does. */
    emit: (requestId: string, text: string) => {
      for (const listener of listeners) listener({ requestId, text });
    },
    finish: (value: string) => finish?.(value),
    listenerCount: () => listeners.size,
  };
}

function show(who: Student, text = "worked on the letter") {
  return render(
    <MantineProvider>
      <NotesSummary student={who} entries={notes(who.id, text)} />
    </MantineProvider>,
  );
}

async function summarise() {
  const button = await screen.findByRole("button", { name: /summarise|again/i });
  await userEvent.click(button);
}

const ADA = student("s-ada", "Ada");
const BEN = student("s-ben", "Ben");

beforeEach(() => {
  delete window.casebook;
});

describe("a summary that is still arriving", () => {
  it("renders the chunks belonging to the run it started", async () => {
    const wire = bridge();
    show(ADA);
    await summarise();
    await waitFor(() => expect(wire.ids).toHaveLength(1));

    wire.emit(wire.ids[0]!, "Ada has been ");
    wire.emit(wire.ids[0]!, "settling in well.");

    expect(await screen.findByText(/Ada has been settling in well\./)).toBeTruthy();
  });

  it("ignores the chunks of a run that was left behind", async () => {
    // The repro, exactly: start Ada's summary, move to Ben, start his. Ada's
    // job is still running and still broadcasting, and the view on screen has
    // Ben's name on it.
    const wire = bridge();
    const ada = show(ADA);
    await summarise();
    await waitFor(() => expect(wire.ids).toHaveLength(1));
    const adasRun = wire.ids[0]!;

    ada.unmount();
    show(BEN);
    await summarise();
    await waitFor(() => expect(wire.ids).toHaveLength(2));

    wire.emit(adasRun, "Ada disclosed something at home.");

    // Nothing of Ada's, under any circumstances. A `queryByText` rather than a
    // wait, because the assertion is about what must never appear.
    expect(screen.queryByText(/Ada disclosed/)).toBeNull();

    wire.emit(wire.ids[1]!, "Ben has attended every session.");
    expect(await screen.findByText(/Ben has attended every session\./)).toBeTruthy();
  });

  it("drops a run she has moved off, even in the same view", async () => {
    // Changing the window is the same problem without a navigation: `text` was
    // cleared and the buffer was not, so the abandoned run's next chunk put the
    // whole of the old answer back — under a heading that now says something
    // else.
    const wire = bridge();
    show(ADA);
    await summarise();
    await waitFor(() => expect(wire.ids).toHaveLength(1));
    wire.emit(wire.ids[0]!, "Across the last 90 days, ");
    expect(await screen.findByText(/Across the last 90 days,/)).toBeTruthy();

    await userEvent.click(screen.getByRole("combobox"));
    // `hidden` because the dropdown is positioned by Floating UI, which has
    // nothing to measure in jsdom and so leaves it `display: none`. The options
    // are rendered and clickable; they are only invisible to a layout that
    // never happens.
    await userEvent.click(
      await screen.findByRole("option", { name: "Last 30 days", hidden: true }),
    );

    wire.emit(wire.ids[0]!, "Ada made progress.");
    expect(screen.queryByText(/Across the last 90 days,/)).toBeNull();
    expect(screen.queryByText(/Ada made progress\./)).toBeNull();
  });

  it("throws away the finished answer too, not just the chunks", async () => {
    // The resolved value is a whole summary of the wrong student. Filtering the
    // stream and not the result would have made the bug rarer and stranger
    // rather than fixing it.
    const wire = bridge();
    const ada = show(ADA);
    await summarise();
    await waitFor(() => expect(wire.ids).toHaveLength(1));

    ada.unmount();
    show(BEN);
    await summarise();
    await waitFor(() => expect(wire.ids).toHaveLength(2));

    wire.finish("Ada's full summary.");
    await Promise.resolve();

    expect(screen.queryByText(/Ada's full summary\./)).toBeNull();
  });

  it("lets go of its subscription when the view goes away", async () => {
    // The listener used to be unsubscribed in `run`'s `finally`, so a component
    // unmounted mid-stream stayed subscribed until its job finished — which is
    // what made a second view reachable by the first one's chunks at all.
    const wire = bridge();
    const ada = show(ADA);
    await summarise();
    await waitFor(() => expect(wire.listenerCount()).toBe(1));

    ada.unmount();

    expect(wire.listenerCount()).toBe(0);
  });
});

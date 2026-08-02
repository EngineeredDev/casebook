/**
 * The promise the Backups panel makes out loud, held to.
 *
 * Restoring is the one action in the app that replaces everything at once, and
 * the panel tells her twice that the state she is replacing is kept and can be
 * picked back off the list. A restore that leaves nothing listable does not
 * look broken — it looks like a restore — right up until the moment she wants
 * to undo it, which is the only moment it matters.
 */

import { existsSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doc, tempApp } from "../test/helpers.ts";
import { listSnapshots, resetSnapshotState, saveDoc, setCodec } from "./storage.ts";
import { classify } from "./snapshots.ts";
import { restore } from "./backups.ts";

beforeEach(() => {
  resetSnapshotState();
  setCodec(null);
});

afterEach(() => {
  vi.useRealTimers();
});

/** The one snapshot in the folder, insisted on rather than assumed. */
function onlyBackup(dir: string): string {
  const found = existsSync(dir) ? readdirSync(dir).toSorted() : [];
  expect(found).toHaveLength(1);
  return found[0] as string;
}

describe("restoring a snapshot", () => {
  it("leaves the state it replaced on the list, even when the tiers would decline", () => {
    const app = tempApp();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T09:00:00"));

    // The setup that used to lose the undo: today's daily already exists, so a
    // tiered save has nothing left to write and the outgoing document would
    // survive only in data.json.prev — which the very next ordinary edit
    // overwrites.
    const original = doc({ students: 1, entries: 1 });
    saveDoc(original);
    const backup = onlyBackup(app.backupDir);
    expect(backup).toBe("data-2026-03-14.json");

    // A morning's work on top of it, then a roll-back to where the day started.
    vi.setSystemTime(new Date("2026-03-14T09:05:00"));
    const current = doc({ students: 3, entries: 12 });
    saveDoc(current, original);

    const { result } = restore(backup, current);
    expect(result).toMatchObject({ ok: true });

    const listed = listSnapshots();
    const undo = listed.find((s) => s.name.includes("pre-restore"));
    expect(undo, `no undo snapshot among ${listed.map((s) => s.name).join(", ")}`).toBeDefined();
    // And it holds what she is undoing back to, not what she restored.
    expect(undo).toMatchObject({ students: 3, entries: 12, readable: true });
  });

  it("names the undo snapshot so nothing ever prunes it", () => {
    // Retention is decided from the filename alone, and it never deletes a
    // preserved one. A datestamped undo would be an ordinary daily, and
    // ordinary dailies are exactly what pruning is for — so the name is the
    // whole guarantee that the way back is still there in a month.
    const app = tempApp();
    const current = doc({ students: 2, entries: 4 });
    saveDoc(current);
    const backup = onlyBackup(app.backupDir);

    restore(backup, current);

    const undo = listSnapshots().find((s) => s.name.includes("pre-restore"));
    expect(undo).toBeDefined();
    expect(classify(undo!.name)?.kind).toBe("preserved");
  });
});

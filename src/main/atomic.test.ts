/**
 * What can be checked about a durable write without pulling the plug.
 *
 * The property that actually matters here — that the contents have reached
 * permanent storage before the rename makes them visible — is not observable
 * from inside the process that asked for it. What is observable is everything
 * around it: that the file arrives whole, that the old one is never the thing
 * being edited, and that nothing is left lying in the data folder afterwards.
 * The fsync itself is covered by asserting it is *reached* — a directory fsync
 * that threw would fail these tests by taking the write down with it.
 */

import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeFileAtomic } from "./atomic.ts";
import { tempApp } from "../test/helpers.ts";

/** Anything writeFileAtomic left behind — the whole point is that there is none. */
function debris(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

describe("writeFileAtomic", () => {
  it("writes a file that wasn't there", () => {
    const app = tempApp();
    const path = join(app.dataDir, "data.json");
    writeFileAtomic(path, '{"hello":"world"}');
    expect(readFileSync(path, "utf8")).toBe('{"hello":"world"}');
    expect(debris(app.dataDir)).toEqual([]);
  });

  it("replaces a file that was", () => {
    const app = tempApp();
    const path = join(app.dataDir, "data.json");
    writeFileSync(path, "the old contents");
    writeFileAtomic(path, "the new contents");
    expect(readFileSync(path, "utf8")).toBe("the new contents");
    expect(debris(app.dataDir)).toEqual([]);
  });

  it("round-trips text that isn't ASCII", () => {
    // The payload is converted to a Buffer explicitly rather than handed over as
    // a string, so this is the assertion that the conversion says utf8 — a
    // clinical note with an em dash or a name with an accent in it is ordinary,
    // and latin1 would mangle both silently.
    const app = tempApp();
    const path = join(app.dataDir, "data.json");
    const contents = JSON.stringify({ note: "Régine — 90 % ✓", emoji: "🩺" });
    writeFileAtomic(path, contents);
    expect(readFileSync(path, "utf8")).toBe(contents);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      note: "Régine — 90 % ✓",
      emoji: "🩺",
    });
  });

  it("leaves no scratch file behind across many writes", () => {
    // The temp name carries a counter precisely so overlapping writes cannot
    // collide. Nothing here overlaps — the writer is synchronous — but a
    // counter that failed to advance would show up as a name being reused.
    const app = tempApp();
    for (let i = 0; i < 25; i += 1) {
      writeFileAtomic(join(app.dataDir, `snapshot-${i}.json`), `{"n":${i}}`);
    }
    expect(debris(app.dataDir)).toEqual([]);
    expect(readdirSync(app.dataDir)).toHaveLength(25);
  });

  it("cleans up after itself when the rename can't happen", () => {
    // A directory standing where the file should go: the write succeeds, the
    // rename cannot. Without the cleanup this would leave one scratch file per
    // failed save in the folder the user is told to go and look at.
    const app = tempApp();
    const path = join(app.dataDir, "data.json");
    mkdirSync(path);

    expect(() => writeFileAtomic(path, "{}")).toThrow();
    expect(debris(app.dataDir)).toEqual([]);
  });

  it("fails without touching the existing file when it cannot write at all", () => {
    const app = tempApp();
    const locked = join(app.dataDir, "locked");
    mkdirSync(locked);
    const path = join(locked, "data.json");
    writeFileSync(path, "the work of a school year");
    chmodSync(locked, 0o500);

    try {
      expect(() => writeFileAtomic(path, "{}")).toThrow();
      // The guarantee that matters on a failed save: the previous contents are
      // still the contents. A writer that truncated first would have destroyed
      // them before discovering it could not write.
      expect(readFileSync(path, "utf8")).toBe("the work of a school year");
    } finally {
      // Or the temp-directory cleanup in helpers.ts cannot remove it.
      chmodSync(locked, 0o700);
    }
  });
});

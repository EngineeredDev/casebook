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
 *
 * The rest cannot be provoked by a real filesystem on demand — a short write
 * needs the disk to fill up mid-call — so the last group injects them. Only
 * `writeSync` and `fsyncSync` are ever intercepted, and only when a test asks;
 * everything else in `node:fs`, here and in the helpers, is the real thing.
 */

import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomic } from "./atomic.ts";
import { tempApp } from "../test/helpers.ts";

/**
 * Where the fault-injection tests hand in their misbehaviour. Hoisted because
 * `vi.mock`'s factory is, and reset after every test so an escaped fault cannot
 * quietly break the file's other half.
 */
const fault = vi.hoisted(() => ({
  onWrite: null as
    | null
    | ((real: typeof import("node:fs").writeSync, fd: number, buf: Buffer, at: number) => number),
  onFsync: null as null | (() => void),
}));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    default: real,
    writeSync: (fd: number, buffer: Buffer, offset?: number, length?: number) =>
      fault.onWrite
        ? fault.onWrite(real.writeSync, fd, buffer, offset ?? 0)
        : real.writeSync(fd, buffer, offset, length),
    fsyncSync: (fd: number) => {
      fault.onFsync?.();
      return real.fsyncSync(fd);
    },
  };
});

afterEach(() => {
  fault.onWrite = null;
  fault.onFsync = null;
});

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

describe("writeFileAtomic under a failing disk", () => {
  /** A year of work, and the thing every assertion below is protecting. */
  const PRECIOUS = JSON.stringify({ entries: Array.from({ length: 400 }, (_, i) => ({ i })) });

  /** An existing good file plus the path to overwrite it with something new. */
  function existing() {
    const app = tempApp();
    const path = join(app.dataDir, "data.json");
    writeFileSync(path, PRECIOUS);
    return { app, path };
  }

  it("keeps writing until the whole buffer is out", () => {
    // The one that matters. A short write followed by a successful fsync and a
    // successful rename replaces a good file with a truncated one and reports
    // success — so the loop is the difference between a saved document and a
    // silently halved one.
    const { app, path } = existing();
    let calls = 0;
    fault.onWrite = (real, fd, buffer, at) => {
      calls += 1;
      // Never accept more than half of what is left.
      const half = Math.max(1, Math.ceil((buffer.length - at) / 2));
      return real(fd, buffer, at, half);
    };

    writeFileAtomic(path, "the new contents, delivered in pieces");

    expect(calls).toBeGreaterThan(1);
    expect(readFileSync(path, "utf8")).toBe("the new contents, delivered in pieces");
    expect(debris(app.dataDir)).toEqual([]);
  });

  it("gives up rather than spinning when a write stops making progress", () => {
    const { app, path } = existing();
    fault.onWrite = () => 0;

    expect(() => writeFileAtomic(path, "{}")).toThrow(/stopped making progress/);
    expect(readFileSync(path, "utf8")).toBe(PRECIOUS);
    expect(debris(app.dataDir)).toEqual([]);
  });

  it("leaves the old file and no scratch file when the write throws", () => {
    const { app, path } = existing();
    fault.onWrite = () => {
      throw new Error("ENOSPC: no space left on device");
    };

    expect(() => writeFileAtomic(path, "{}")).toThrow(/ENOSPC/);
    expect(readFileSync(path, "utf8")).toBe(PRECIOUS);
    expect(debris(app.dataDir)).toEqual([]);
  });

  it("leaves the old file and no scratch file when the flush throws", () => {
    // The temp file is fully written here — it is only its *durability* that
    // failed. Renaming it anyway would put a file of doubtful contents over a
    // good one, so the write fails and takes its scratch file with it.
    const { app, path } = existing();
    fault.onFsync = () => {
      throw new Error("EIO: the disk is going");
    };

    expect(() => writeFileAtomic(path, "{}")).toThrow(/EIO/);
    expect(readFileSync(path, "utf8")).toBe(PRECIOUS);
    expect(debris(app.dataDir)).toEqual([]);
  });
});

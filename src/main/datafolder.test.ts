/**
 * Moving the data folder: the one thing this app does that can lose everything,
 * and the reason it is written as copy-verify-switch rather than as a move.
 *
 * Two properties matter more than any error message here. The source is never
 * touched, so "nothing was moved" stays a true thing to tell her whatever
 * happened. And a failure partway leaves the target holding nothing this
 * function put there — a half-written data.json would trip the "already has a
 * data.json in it" guard on the way back in, which makes the obvious next move,
 * trying the same folder again, the one move that cannot work.
 *
 * Everything runs packaged. dataDir() only consults the config in a packaged
 * build and relocation is off entirely in a development one, so there is no
 * unpackaged version of this test to write. That also forces the module reload
 * before each test: a successful relocation leaves the memoized config naming a
 * temp folder that is deleted moments later, and the next test would otherwise
 * resolve its data folder to the previous test's rubble.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { doc, tempApp, type TempApp } from "../test/helpers.ts";

beforeEach(() => {
  vi.resetModules();
});

/** An installed app with a document and a couple of backups behind it. */
function populated(): { app: TempApp; contents: string } {
  const app = tempApp({ packaged: true });
  const contents = JSON.stringify(doc({ students: 3, entries: 8 }), null, 2);
  writeFileSync(app.dataFile, contents);
  mkdirSync(app.backupDir, { recursive: true });
  writeFileSync(join(app.backupDir, "data-2026-01-01.json"), '{"day":1}');
  writeFileSync(join(app.backupDir, "data-2026-01-02.json"), '{"day":2}');
  return { app, contents };
}

describe("relocateData", () => {
  it("copies everything across and leaves the original where it was", async () => {
    const { app, contents } = populated();
    const target = join(app.root, "Moved");
    const { relocateData } = await import("./datafolder.ts");

    expect(relocateData(target)).toEqual({ ok: true, dir: target });

    expect(readFileSync(join(target, "data.json"), "utf8")).toBe(contents);
    expect(readdirSync(join(target, "backups")).toSorted()).toEqual([
      "data-2026-01-01.json",
      "data-2026-01-02.json",
    ]);

    // Deleting the old copy is her call, made later with both folders in front
    // of her, so a successful move ends with two of everything.
    expect(readFileSync(app.dataFile, "utf8")).toBe(contents);
    expect(readdirSync(app.backupDir)).toHaveLength(2);

    // Both halves of the switch: the file the next launch reads, and the cache
    // this launch goes on using.
    expect(JSON.parse(readFileSync(join(app.userData, "config.json"), "utf8"))).toEqual({
      dataDir: target,
    });
    const { dataDir } = await import("./paths.ts");
    expect(dataDir()).toBe(target);
  });

  it("refuses a target that isn't an absolute path", async () => {
    const { app } = populated();
    const { relocateData } = await import("./datafolder.ts");

    // Resolved against the working directory it would land somewhere nobody
    // picked, which for a double-clicked app is "/".
    expect(relocateData("Moved")).toEqual({ error: "That isn't a folder Casebook can use." });
    expect(existsSync(join(app.root, "Moved"))).toBe(false);
  });

  it("refuses a folder inside the one Casebook uses now", async () => {
    const { app } = populated();
    const target = join(app.dataDir, "backups", "somewhere");
    const { relocateData } = await import("./datafolder.ts");

    expect(relocateData(target)).toEqual({
      error: "Pick a folder that doesn't overlap the one Casebook uses now.",
    });
    expect(existsSync(target)).toBe(false);
  });

  it("refuses a folder that contains it", async () => {
    const { app } = populated();
    const { relocateData } = await import("./datafolder.ts");

    // The quieter of the two mistakes: choosing the home folder would scatter a
    // data.json and a backups/ directory loose into it and leave the old copy
    // nested inside the new location.
    expect(relocateData(app.root)).toEqual({
      error: "Pick a folder that doesn't overlap the one Casebook uses now.",
    });
    expect(existsSync(join(app.root, "data.json"))).toBe(false);
    expect(existsSync(join(app.root, "backups"))).toBe(false);
  });

  it("is a no-op when the target is the folder already in use", async () => {
    const { app } = populated();
    const configBefore = readFileSync(join(app.userData, "config.json"), "utf8");
    const { relocateData } = await import("./datafolder.ts");

    // Reported as success because it is one: she asked for the data to be in
    // that folder and it is. The overlap guard below would otherwise reject it.
    expect(relocateData(app.dataDir)).toEqual({ ok: true, dir: app.dataDir });
    expect(readFileSync(join(app.userData, "config.json"), "utf8")).toBe(configBefore);
    expect(readdirSync(app.dataDir).toSorted()).toEqual(["backups", "data.json"]);
  });

  it("refuses a target that already has a data.json in it", async () => {
    const { app } = populated();
    const target = join(app.root, "Moved");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "data.json"), '{"someone":"else"}');
    const { relocateData } = await import("./datafolder.ts");

    expect(relocateData(target)).toEqual({
      error: `${target} already has a data.json in it. Pick an empty folder.`,
    });
    // Whoever that file belongs to — an older install, a second clinician on a
    // shared drive — overwriting it is the outcome this whole feature is shaped
    // around avoiding.
    expect(readFileSync(join(target, "data.json"), "utf8")).toBe('{"someone":"else"}');
  });

  it("refuses when there is nothing in the current folder to move", async () => {
    const app = tempApp({ packaged: true });
    const target = join(app.root, "Moved");
    const { relocateData } = await import("./datafolder.ts");

    expect(relocateData(target)).toEqual({
      error: `There's no data.json in ${app.dataDir} to move.`,
    });
    // No empty folder left behind at the target either, so nothing about the
    // failed attempt is visible in Finder afterwards.
    expect(existsSync(target)).toBe(false);
  });

  it("takes back everything it wrote when the copy fails partway", async () => {
    const { app, contents } = populated();
    const target = join(app.root, "Moved");
    mkdirSync(target, { recursive: true });
    /**
     * A file sitting where backups/ needs to be a directory. The data.json copy
     * succeeds, the mkdirSync inside copyMissingBackups then throws, and that
     * ordering is the whole point: the failures worth undoing are the ones that
     * happen after something has already been written.
     */
    writeFileSync(join(target, "backups"), "not a directory");
    const { relocateData } = await import("./datafolder.ts");

    expect(relocateData(target)).toEqual({
      error: expect.stringContaining("Couldn't copy your data there"),
    });

    // The file that was put in the way, and nothing else. No data.json to make
    // the retry impossible, and no half-renamed temp file to puzzle over.
    expect(readdirSync(target)).toEqual(["backups"]);

    expect(readFileSync(app.dataFile, "utf8")).toBe(contents);
    expect(readdirSync(app.backupDir)).toHaveLength(2);
    const { readConfig } = await import("./config.ts");
    expect(readConfig()).toEqual({ dataDir: app.dataDir });
  });
});

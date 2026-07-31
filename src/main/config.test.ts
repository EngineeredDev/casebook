/**
 * config.json — a file whose only job is to say where the real file is.
 *
 * What is being guarded here is quiet rather than loud. A config that cannot be
 * read, or that names somewhere unusable, must not soften into "use the default
 * folder": the default is empty on a machine where the data was deliberately
 * moved, and an empty Casebook is indistinguishable from a fresh install to
 * everyone except the person whose year of records it just stopped showing.
 *
 * Every test reloads the module, because readConfig() memoizes into a
 * module-level variable and that is the point of it — the config is read once
 * per launch. A cache filled by one test names a temp folder that the next test
 * has already deleted. The electron stub keeps its state on globalThis
 * precisely so it survives vi.resetModules() (see src/test/electron.ts), which
 * is why the tempApp() call above each reset does not have to be repeated after
 * it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tempApp, type TempApp } from "../test/helpers.ts";

beforeEach(() => {
  vi.resetModules();
});

function writeConfigFile(app: TempApp, contents: string): void {
  writeFileSync(join(app.userData, "config.json"), contents);
}

function readConfigFile(app: TempApp): unknown {
  return JSON.parse(readFileSync(join(app.userData, "config.json"), "utf8"));
}

describe("readConfig", () => {
  it("is empty when there is no file, which is the normal state", async () => {
    tempApp();
    const { readConfig } = await import("./config.ts");

    // Anyone who has never moved the data folder has no config.json at all, and
    // the defaults are exactly right for them.
    expect(readConfig()).toEqual({});
  });

  it("refuses to guess when the file is there and cannot be parsed", async () => {
    const app = tempApp();
    writeConfigFile(app, "{ dataDir: /Volumes/Backup/Casebook");
    const { readConfig } = await import("./config.ts");

    // Naming the path is most of the value of the message: the fix is to open
    // that file, and nothing else in the app will say where it lives.
    expect(() => readConfig()).toThrow(join(app.userData, "config.json"));
  });

  it("ignores a relative dataDir, which would resolve against the wrong folder", async () => {
    const app = tempApp();
    writeConfigFile(app, JSON.stringify({ dataDir: "Casebook" }));
    const { readConfig } = await import("./config.ts");

    // A double-clicked app's working directory is "/", so a relative path here
    // names somewhere nobody chose.
    expect(readConfig()).toEqual({});
  });

  it("keeps an absolute one", async () => {
    const app = tempApp();
    const chosen = join(app.root, "Somewhere Else");
    writeConfigFile(app, JSON.stringify({ dataDir: chosen }));
    const { readConfig } = await import("./config.ts");

    // Not checked for existence, deliberately: loadDoc is the one with
    // something useful to say about a folder that has gone, and it can only say
    // it if the path survives this far.
    expect(readConfig()).toEqual({ dataDir: chosen });
  });

  it("carries a key it doesn't recognise straight through", async () => {
    const app = tempApp();
    const chosen = join(app.root, "Somewhere Else");
    writeConfigFile(app, JSON.stringify({ dataDir: chosen, windowWidth: 1200 }));
    const { readConfig, writeConfig } = await import("./config.ts");

    expect(readConfig()).toEqual({ dataDir: chosen, windowWidth: 1200 });

    // The point of keeping it. Every setting is changed by spreading the
    // current config and overwriting one field, so a build that dropped what it
    // didn't recognise would strip a newer build's settings the first time
    // anything here was saved — and the self-updater makes running an older
    // copy a thing that can happen.
    writeConfig({ ...readConfig(), mirrorDir: join(app.root, "Mirror") });
    expect(readConfigFile(app)).toMatchObject({ windowWidth: 1200 });
  });

  it.each(["[1, 2, 3]", "null", '"/Users/someone/Casebook"', "42"])(
    "reads %s as no configuration at all",
    async (contents) => {
      const app = tempApp();
      writeConfigFile(app, contents);
      const { readConfig } = await import("./config.ts");

      // These parse, so the unreadable-file path never fires; they just have no
      // dataDir in them, which is the same situation as having no file.
      expect(readConfig()).toEqual({});
    },
  );
});

describe("writeConfig", () => {
  it("round-trips through the file and through the cache", async () => {
    const app = tempApp();
    const chosen = join(app.root, "Somewhere Else");
    const { readConfig, writeConfig } = await import("./config.ts");

    writeConfig({ dataDir: chosen });
    expect(readConfigFile(app)).toEqual({ dataDir: chosen });
    // The same instance answers from memory afterwards. Nothing re-reads the
    // file in a running app, so this is the value paths.ts sees for the rest of
    // the session — a relocation that updated only the file would move the data
    // and go on reading from where it used to be.
    expect(readConfig()).toEqual({ dataDir: chosen });

    vi.resetModules();
    const nextLaunch = await import("./config.ts");
    expect(nextLaunch.readConfig()).toEqual({ dataDir: chosen });
  });

  it("applies the same filtering a read does", async () => {
    const app = tempApp();
    const { readConfig, writeConfig } = await import("./config.ts");

    writeConfig({ dataDir: "Casebook" });

    // A relative path is dropped on the way in as well as on the way out. When
    // only reads checked, this session would go on using "Casebook" — resolved
    // against a working directory that is "/" for a double-clicked app — while
    // every later launch dropped it and fell back to ~/Casebook. The two would
    // disagree about where the records live, and only one of them would be
    // where the records actually were.
    expect(readConfig()).toEqual({});
    expect(readConfigFile(app)).toEqual({});

    vi.resetModules();
    const nextLaunch = await import("./config.ts");
    expect(nextLaunch.readConfig()).toEqual({});
  });

  it("keeps an auto-lock delay only when it is a positive whole number", async () => {
    const app = tempApp();
    const { readConfig, writeConfig } = await import("./config.ts");

    for (const bad of [0, -5, 1.5, "10", Number.NaN]) {
      writeConfig({ autoLockMinutes: bad as number });
      expect(readConfig(), `accepted ${String(bad)}`).toEqual({});
    }

    // Null is not a malformed number, it is the way to say "never".
    writeConfig({ autoLockMinutes: null });
    expect(readConfig()).toEqual({ autoLockMinutes: null });

    writeConfig({ autoLockMinutes: 15 });
    expect(readConfig()).toEqual({ autoLockMinutes: 15 });
    expect(readConfigFile(app)).toEqual({ autoLockMinutes: 15 });
  });
});

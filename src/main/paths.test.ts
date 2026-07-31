/**
 * The test seam itself, checked before anything relies on it.
 *
 * Every other test file in src/main writes real files to the folder `dataDir()`
 * names. If the electron stub were wired up wrongly, those writes would still
 * succeed — into `~/Casebook`, on the machine running the suite. So this file
 * asserts the one property everything else assumes: the data folder is inside
 * the temp tree, in both of the modes `paths.ts` distinguishes.
 */

import { describe, expect, it } from "vitest";
import { tempApp } from "../test/helpers.ts";
import { backupDir, canRelocate, dataDir, dataDirIsConfigured, dataFile } from "./paths.ts";

describe("the data folder", () => {
  it("is the app path in a development build", () => {
    const app = tempApp();
    expect(dataDir()).toBe(app.dataDir);
    expect(dataDir().startsWith(app.root)).toBe(true);
    expect(dataFile()).toBe(app.dataFile);
    expect(backupDir()).toBe(app.backupDir);
  });

  it("cannot be relocated in a development build", () => {
    tempApp();
    expect(canRelocate()).toBe(false);
    // Never true when relocation is off, whatever the config says — the check
    // exists to tell "new install" from "the folder went missing", and a dev
    // build's folder is pinned rather than chosen.
    expect(dataDirIsConfigured()).toBe(false);
  });

  it("comes from the config in a packaged build", () => {
    const app = tempApp({ packaged: true });
    expect(dataDir()).toBe(app.dataDir);
    expect(dataDir().startsWith(app.root)).toBe(true);
    expect(canRelocate()).toBe(true);
    expect(dataDirIsConfigured()).toBe(true);
  });
});

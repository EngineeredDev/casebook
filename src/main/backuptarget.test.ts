/**
 * The rule that keeps a local destination inside the folder she picked.
 *
 * Everything else about `LocalFolderTarget` — that it never creates the folder,
 * never lists it, never leaves a half-written file under a name a sync service
 * is watching — is covered in mirror.test.ts, alongside the reconciler that
 * drives it. What is here is the one thing that is not about mirroring at all:
 * every name reaching this class comes out of `mirror-manifest.json`, and a
 * damaged manifest with a separator in a key turns `join` into a path *outside*
 * the destination, which `put` then writes to and `delete` then unlinks.
 *
 * Nobody has to be attacking for that to happen. Anyone able to edit that file
 * could already remove her files directly, as her; a truncated write or a merged
 * copy from a synced folder cannot, and is the realistic way a `../` ends up in
 * there. What these tests bound is the blast radius, not an intruder.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { LocalFolderTarget, TargetError } from "./backuptarget.ts";
import { tempApp, type TempApp } from "../test/helpers.ts";

let app: TempApp;
let mirrorDir: string;
/** Where a `../` lands, holding something worth not losing. */
let outside: string;
let hers: string;

beforeEach(() => {
  app = tempApp();
  mirrorDir = join(app.root, "Mirror");
  outside = join(app.root, "Documents");
  hers = join(outside, "escape.json");
  // Both folders exist: the destination because a folder picker is where it
  // comes from, and the rest of her disk because it is simply there.
  mkdirSync(mirrorDir, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(hers, "a year of work");
});

function local(): LocalFolderTarget {
  return new LocalFolderTarget(mirrorDir);
}

/**
 * Every way a manifest key can stop being a filename. The relative escapes and
 * the absolute paths are the two kinds that reach somewhere else; the rest
 * resolve to the destination folder itself, where `put` and `delete` would be
 * operating on the directory rather than on anything in it.
 */
function notFilenames(): string[] {
  return [
    "../escape.json",
    "../../escape.json",
    "sub/../../escape.json",
    "a/b",
    "a/",
    ".",
    "..",
    "/etc/hosts",
    hers,
    "",
  ];
}

/** Run one call per bad name and insist every one of them was refused. */
async function allRefused(call: (name: string) => Promise<unknown>): Promise<void> {
  await Promise.all(
    notFilenames().map(async (name) => {
      await expect(call(name), name).rejects.toBeInstanceOf(TargetError);
    }),
  );
}

describe("a local folder refuses a name that isn't one", () => {
  it("refuses it on the way in to put, and writes nothing anywhere", async () => {
    await allRefused((name) => local().put(name, Buffer.from("{}")));

    // Not one of them left anything behind, in the folder or beside it — not
    // even the `.part` file the write would have started with.
    expect(readdirSync(mirrorDir)).toEqual([]);
    expect(readdirSync(outside)).toEqual(["escape.json"]);
    expect(readFileSync(hers, "utf8")).toBe("a year of work");
  });

  it("refuses it on the way in to delete, and unlinks nothing", async () => {
    // The one that costs something irreversible. `../escape.json` resolves to a
    // real file of hers, and `unlinkSync` does not ask about it twice.
    const bystander = join(mirrorDir, "data-2026-07-30.json");
    writeFileSync(bystander, "{}");

    await allRefused((name) => local().delete(name));

    expect(existsSync(hers)).toBe(true);
    expect(existsSync(bystander)).toBe(true);
    expect(existsSync(mirrorDir)).toBe(true);
  });

  it("refuses it on the way in to stat rather than answering", async () => {
    // Answering null would be worse than it looks: the reconciler reads null as
    // "not copied yet" and follows it with a `put` of the same bad name, so a
    // quiet null here is how a refused name becomes a write attempt anyway.
    await allRefused((name) => local().stat(name));
  });

  it("says which name it refused", async () => {
    // This ends up in the mirror manifest's `lastTrouble` and in the log, and
    // the fix is to find that key in the manifest and take it out — which needs
    // the key.
    await expect(local().put("../escape.json", Buffer.from("{}"))).rejects.toMatchObject({
      name: "TargetError",
      message: expect.stringContaining("../escape.json"),
    });
  });
});

describe("a local folder still does its job", () => {
  it("puts, stats and deletes an ordinary snapshot name", async () => {
    // The guard sits on the path everything real goes through, so what is most
    // worth checking is that everything real still goes through it.
    const target = local();
    const name = "data-2026-07-31-1500.json";

    await target.put(name, Buffer.from('{"entries":[]}'));
    expect(readFileSync(join(mirrorDir, name), "utf8")).toBe('{"entries":[]}');
    expect(await target.stat(name)).toEqual({ size: 14 });

    await target.delete(name);
    expect(existsSync(join(mirrorDir, name))).toBe(false);
    // And absent is still success for a name that is a name.
    await expect(target.delete(name)).resolves.toBeUndefined();
    expect(await target.stat(name)).toBeNull();
  });

  it("accepts the names this app actually writes", async () => {
    // Dots, dashes and digits all through them. A guard that turned any of these
    // away would stop the mirror dead, which is a worse failure than the one it
    // is there to prevent.
    const target = local();
    const names = ["keyfile.json", "data-2026-05-01.json", "data-2026-05-01-0915.json.enc"];
    await Promise.all(
      names.map(async (name) => {
        await expect(target.put(name, Buffer.from("{}")), name).resolves.toBeUndefined();
      }),
    );
    expect(readdirSync(mirrorDir).toSorted()).toEqual([
      "data-2026-05-01-0915.json.enc",
      "data-2026-05-01.json",
      "keyfile.json",
    ]);
  });
});

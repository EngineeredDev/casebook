/**
 * The catalogue is data, not logic, so what is worth testing is the handful of
 * things a careless edit to it would break silently.
 *
 * Whether a repo and filename actually exist on Hugging Face is not testable
 * here — that needs the network, and a test suite that fails when a school
 * network is slow is a test suite people learn to skip. It is checked by hand
 * when an entry is added; see the note at the top of models.ts.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_ID, fitsMachine, isKnownModelId, MODELS, modelChoice } from "./models.ts";

const GiB = 1024 ** 3;

describe("the model catalogue", () => {
  it("has unique ids, because they are written into config.json", () => {
    const ids = MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique filenames, because they share one folder", () => {
    // Two entries pointing at the same filename would appear to download each
    // other: one finishing would make the other read as "downloaded", and
    // removing either would take both.
    const files = MODELS.map((m) => m.file);
    expect(new Set(files).size).toBe(files.length);
  });

  it("names a default that is in the list", () => {
    expect(isKnownModelId(DEFAULT_MODEL_ID)).toBe(true);
  });

  it("offers exactly one model that has actually been measured", () => {
    // The "Measured here" badge is a claim about scripts/llm-eval having been
    // run. Adding a second one without running it is the easy way to turn an
    // honest label into a decorative one.
    expect(MODELS.filter((m) => m.measured)).toHaveLength(1);
    expect(MODELS.find((m) => m.measured)?.id).toBe(DEFAULT_MODEL_ID);
  });

  it("quotes memory that exceeds the download, and a Mac that exceeds the memory", () => {
    for (const model of MODELS) {
      // Weights plus KV cache plus compute buffers is always more than the file,
      // and a figure that slipped below it would silently disarm the memory
      // check that stops the app from swapping.
      expect(model.runBytes, model.id).toBeGreaterThan(model.downloadBytes);
      expect(model.wantsMachineBytes, model.id).toBeGreaterThan(model.runBytes);
    }
  });

  it("offers her 8 GB Air exactly one model, and offers it the default", () => {
    // The machine the whole design was sized against. If a change to the
    // catalogue ever leaves this empty, the feature has quietly become
    // desktop-only for the person it was built for.
    const forHerAir = MODELS.filter((m) => fitsMachine(m, 8 * GiB));
    expect(forHerAir.map((m) => m.id)).toEqual([DEFAULT_MODEL_ID]);
  });

  it("opens up as the Mac gets bigger, and never the other way", () => {
    const counts = [8, 16, 24, 32].map(
      (size) => MODELS.filter((m) => fitsMachine(m, size * GiB)).length,
    );
    expect(counts).toEqual([...counts].toSorted((a, b) => a - b));
    // A 32 GB Mac — the one these are developed on — must be offered all of
    // them, or an entry has been added that nothing here can ever try.
    expect(counts.at(-1)).toBe(MODELS.length);
  });

  it("resolves an unknown id to the default rather than throwing", () => {
    // This is the downgrade path: an id written by a newer Casebook. The old
    // build runs on the default and leaves config.json alone.
    expect(modelChoice("something-else-entirely").id).toBe(DEFAULT_MODEL_ID);
    expect(modelChoice(undefined).id).toBe(DEFAULT_MODEL_ID);
  });
});

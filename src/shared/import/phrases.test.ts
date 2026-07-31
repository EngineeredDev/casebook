/**
 * The mapping table's two jobs: never ask the same question twice, and never
 * answer one it wasn't sure about.
 *
 * The second is the one worth testing hard. A suggestion is persisted the
 * moment she accepts it, and an inherited wrong mapping quietly miscategorises
 * every future import of every future document — so returning null is a
 * correct and frequent answer, and a test suite that only checked for matches
 * would push this file in exactly the wrong direction.
 */

import { describe, expect, it } from "vitest";
import { normalizePhrase, resolvePhrase, suggestCategory } from "./phrases.ts";

/** Her real seed categories, ids stubbed to something readable. */
const CATEGORIES = [
  { id: "individual", name: "Direct service — individual" },
  { id: "group", name: "Direct service — group" },
  { id: "crisis", name: "Crisis response" },
  { id: "assessment", name: "Assessment / evaluation" },
  { id: "noshow", name: "No-show / cancellation" },
  { id: "iep", name: "IEP meeting" },
  { id: "parent", name: "Parent contact" },
  { id: "teacher", name: "Teacher / staff consultation" },
  { id: "casemgmt", name: "Case management" },
  { id: "documentation", name: "Documentation" },
  { id: "other", name: "Other" },
];

describe("normalizePhrase", () => {
  it.each([
    ["Routine Session", "routine session"],
    ["routine session.", "routine session"],
    ["Routine  Session", "routine session"],
    ["  Routine Session  ", "routine session"],
    ["Email to Parent!", "email to parent"],
    ["Teacher/staff consult", "teacher staff consult"],
  ])("reads %o as %o", (input, expected) => {
    expect(normalizePhrase(input)).toBe(expected);
  });
});

describe("suggestCategory", () => {
  it("finds a category that genuinely shares a word", () => {
    expect(suggestCategory("Email to Parent", CATEGORIES)?.categoryId).toBe("parent");
    expect(suggestCategory("IEP Meeting", CATEGORIES)?.categoryId).toBe("iep");
    expect(suggestCategory("Crisis", CATEGORIES)?.categoryId).toBe("crisis");
  });

  it("folds an abbreviation into the word it abbreviates", () => {
    expect(suggestCategory("Teacher consult", CATEGORIES)?.categoryId).toBe("teacher");
  });

  it("declines to guess when her category names say nothing about the phrase", () => {
    // The two commonest phrases in her sample. Nothing in "Direct service —
    // individual" indicates that a "Routine Session" is one, and a confident
    // wrong answer here would be inherited by every later import.
    expect(suggestCategory("Routine Session", CATEGORIES)).toBeNull();
    expect(suggestCategory("Requested Session", CATEGORIES)).toBeNull();
    expect(suggestCategory("Follow up", CATEGORIES)).toBeNull();
  });

  it("declines on an empty or punctuation-only phrase", () => {
    expect(suggestCategory("", CATEGORIES)).toBeNull();
    expect(suggestCategory("—", CATEGORIES)).toBeNull();
  });
});

describe("resolvePhrase", () => {
  const decided = { "routine session": "individual", "email to parent": "parent" };

  it("prefers a decision she already made", () => {
    const hit = resolvePhrase("Routine Session", decided, CATEGORIES);
    expect(hit).toEqual({ categoryId: "individual", score: 1 });
  });

  it("lets a variant spelling inherit the decision rather than re-asking", () => {
    expect(resolvePhrase("routine sess.", decided, CATEGORIES)?.categoryId).toBe("individual");
    expect(resolvePhrase("Routine session", decided, CATEGORIES)?.categoryId).toBe("individual");
  });

  it("ignores a mapping whose category no longer exists", () => {
    // A restore, or an archived category. This must read as "not mapped yet",
    // never as a silent miscategorisation into a category that isn't there.
    const stale = { "routine session": "deleted-category-id" };
    expect(resolvePhrase("Routine Session", stale, CATEGORIES)).toBeNull();
  });

  it("falls through to the category names when nothing has been decided", () => {
    expect(resolvePhrase("IEP Meeting", {}, CATEGORIES)?.categoryId).toBe("iep");
  });

  it("still declines when neither decisions nor names help", () => {
    expect(resolvePhrase("Requested Session", decided, CATEGORIES)).toBeNull();
  });

  it("does not let a loose similarity inherit someone else's decision", () => {
    // "Parent" alone overlaps "email to parent" only half way, which is below
    // the bar for inheriting — but "Parent contact" is a real category name,
    // so the fallback is what answers, and it answers correctly.
    expect(resolvePhrase("Parent", decided, CATEGORIES)?.categoryId).toBe("parent");
  });
});

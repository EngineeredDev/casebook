/**
 * The context budget, at its edges.
 *
 * There is one failure mode in this file and it is silent: more text goes to
 * the model than the context holds, llama.cpp keeps what fits, and the summary
 * describes the surviving part as though it were the whole term. Nothing about
 * the output says a word of it went missing — which is why the budget is
 * enforced by arithmetic here rather than noticed later.
 *
 * Both edges tested below are tail cases. A hand-typed note rarely reaches
 * 1,500 words, and an "Everything" range has to cover several years before the
 * reduce step overflows. They are worth pinning because they are exactly the
 * inputs nobody tries by hand, and because "she asked for the whole picture" is
 * the one request where a quietly partial answer is worst.
 */

import { describe, expect, it } from "vitest";
import { planPasses, planReduce, reducePrompt, summaryPrompt } from "./summary.ts";

/** Comfortably over CHARS_PER_PASS, which is 9,000. */
const HUGE = 12_000;

function words(n: number, word = "session "): string {
  return word.repeat(Math.ceil(n / word.length)).slice(0, n);
}

function note(date: string, length: number) {
  return { date, text: words(length) };
}

/** What one pass will actually be handed, so a budget can be checked against it. */
const rendered = (pass: { date: string; text: string }[]) =>
  pass.map((n) => `[${n.date}]\n${n.text}`).join("\n\n").length;

describe("planning the passes", () => {
  it("keeps a normal term in one pass", () => {
    const notes = Array.from({ length: 12 }, (_, i) => note(`2026-03-${10 + i}`, 200));
    expect(planPasses(notes)).toHaveLength(1);
  });

  it("splits a single note too long to be a pass on its own", () => {
    // The overflow check could only decide where *between* notes to cut, so one
    // oversized note went through whole and the context silently ate the tail.
    const passes = planPasses([note("2026-03-04", HUGE)]);
    expect(passes.length).toBeGreaterThan(1);
    for (const pass of passes) expect(rendered(pass)).toBeLessThanOrEqual(9000 + 200);
  });

  it("keeps the date on every piece of a note it split", () => {
    // Every claim in a summary is cited by date, and the panel tells her to
    // check them against the notes below. A piece that arrived undated could be
    // summarised into a point she has no way to verify.
    const passes = planPasses([note("2026-03-04", HUGE)]);
    for (const pass of passes) {
      for (const piece of pass) expect(piece.date).toBe("2026-03-04");
    }
  });

  it("loses none of an oversized note's words", () => {
    const text = words(HUGE);
    const rejoined = planPasses([{ date: "2026-03-04", text }])
      .flat()
      .map((n) => n.text)
      .join("");
    // Trimmed at the cuts, so compare on the letters rather than the spacing.
    expect(rejoined.replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
  });

  it("cuts on a blank line when there is one to cut on", () => {
    const first = words(8000);
    const text = `${first}\n\n${words(6000)}`;
    const pieces = planPasses([{ date: "2026-03-04", text }]).flat();
    // The paragraph is not split down the middle: the first piece is exactly
    // the first paragraph, ending where the blank line was.
    expect(pieces[0]!.text).toBe(first.trimEnd());
  });

  it("still splits when there is no blank line anywhere near the cut", () => {
    const pieces = planPasses([{ date: "2026-03-04", text: words(HUGE, "x") }]).flat();
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(piece.text.length).toBeLessThanOrEqual(9000);
  });

  it("splits a long note without dragging its neighbours into extra passes", () => {
    const notes = [note("2026-03-01", 100), note("2026-03-02", HUGE), note("2026-03-03", 100)];
    const passes = planPasses(notes);
    for (const pass of passes) expect(rendered(pass)).toBeLessThanOrEqual(9000 + 200);
  });
});

describe("planning the reduce", () => {
  it("asks for one reduce when the summaries fit in one", () => {
    expect(planReduce([words(500), words(500), words(500)])).toHaveLength(1);
  });

  it("folds in layers when they do not", () => {
    // reducePrompt concatenated whatever it was given, so every pass staying
    // inside the context did not stop the *reduce* from overflowing — at the
    // last step, where the truncation is least visible and gets described as
    // the whole picture.
    const parts = Array.from({ length: 30 }, () => words(1500));
    const groups = planReduce(parts);
    expect(groups.length).toBeGreaterThan(1);
    for (const group of groups) {
      expect(group.join("").length).toBeLessThanOrEqual(9000 + 1500);
    }
  });

  it("carries every summary into exactly one group", () => {
    const parts = Array.from({ length: 30 }, (_, i) => `${i}:${words(1500)}`);
    expect(planReduce(parts).flat()).toEqual(parts);
  });

  it("still makes progress on a single summary bigger than the budget", () => {
    // Cannot happen while parts come back capped at 500 tokens, but a loop that
    // relies on the group count falling must not be able to spin if it does.
    const groups = planReduce([words(HUGE), words(HUGE)]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.length === 1)).toBe(true);
  });
});

describe("the prompts themselves", () => {
  it("dates every note it shows the model", () => {
    const prompt = summaryPrompt({
      requestId: "r-1",
      studentName: "Ada",
      windowLabel: "Last 90 days",
      notes: [note("2026-03-04", 20)],
    });
    expect(prompt).toContain("[2026-03-04]");
    expect(prompt).toContain("Cite the date in brackets");
  });

  it("numbers the periods it is combining, oldest first", () => {
    const prompt = reducePrompt(["first", "second"], "This school year");
    expect(prompt.indexOf("PERIOD 1")).toBeLessThan(prompt.indexOf("PERIOD 2"));
    expect(prompt).toContain("Keep negations exactly as written");
  });
});

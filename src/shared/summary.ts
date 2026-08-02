/**
 * What a notes summary asks for, and the rules that keep it honest (LLM-3,
 * docs/local-llm.md §5).
 *
 * The risk here is different in kind from the import feature's. An import error
 * is visible — a wrong category sits in a grid waiting to be corrected. A
 * summary error is invisible: fluent, plausible, and about a real child. The
 * characteristic small-model failures are **dates, numbers and negations**, and
 * "did not attend" becoming "attended" in a summary of a clinical record is the
 * worst single output this app could produce.
 *
 * Three things follow, and all three are load-bearing:
 *
 * 1. Every claim must carry the date it came from, so the summary can be
 *    checked against the notes it is displayed beside without leaving the page.
 * 2. The prompt restricts the model to what appears in the notes, and says so
 *    repeatedly, because a summariser's default training is to be helpful and
 *    add context.
 * 3. **It is never persisted.** Not to data.json, not to exports, not to
 *    reports. The clinical record stays entirely human-authored; there is no
 *    path by which AI text can later be mistaken for something she wrote.
 */

import type { SummaryRequest } from "./llm.ts";

export const SUMMARY_SYSTEM_PROMPT =
  "You summarise a school clinician's own counseling notes for her, so she can " +
  "reread a term quickly. You work only from the notes given to you. You never " +
  "add background, never infer a diagnosis, never suggest what to do next, and " +
  "never soften or dramatise what is written. If the notes do not say something, " +
  "it is not in the summary. These are professional records that routinely " +
  "describe difficult events; summarising them accurately is the job.";

/**
 * Roughly how much of the notes fit in one pass. The context is capped at 4096
 * tokens and the reply and instructions need room, so this is deliberately well
 * under it — chunking early costs a second pass, and overrunning costs a
 * silently truncated set of notes that the summary then confidently describes
 * as the whole term.
 */
const CHARS_PER_PASS = 9000;

/** Notes as dated plain text, oldest first, exactly as the model will see them. */
function render(notes: SummaryRequest["notes"]): string {
  return notes.map((n) => `[${n.date}]\n${n.text}`).join("\n\n");
}

export function summaryPrompt(request: SummaryRequest): string {
  return [
    `These are counseling notes for one student (${request.windowLabel}).`,
    "",
    render(request.notes),
    "",
    "Write a short summary for the clinician who wrote these notes.",
    "",
    "Rules:",
    "- Use only what appears above. Add nothing.",
    "- Cite the date in brackets after each point, exactly as it appears.",
    "- Keep negations exactly as written. If a note says something did not",
    "  happen, the summary must say it did not happen.",
    "- Do not repeat numbers or dates that are not written above.",
    "- If the notes are too thin to summarise, say so instead of filling it out.",
    "",
    "Format: three to six bullet points, then one line naming anything left open.",
  ].join("\n");
}

/**
 * Split notes into passes that fit the context, then summarise the summaries.
 *
 * Grouped by month rather than by an arbitrary character count wherever it can
 * be, because a boundary that falls inside a week produces two summaries that
 * each describe half of the same episode — and the reduce step has no way to
 * know they were one thing.
 */
export function planPasses(notes: SummaryRequest["notes"]): SummaryRequest["notes"][] {
  if (render(notes).length <= CHARS_PER_PASS) return [notes];

  const passes: SummaryRequest["notes"][] = [];
  let current: SummaryRequest["notes"] = [];
  let month = "";
  let size = 0;
  for (const note of divide(notes)) {
    const noteMonth = note.date.slice(0, 7);
    const wouldOverflow = size + note.text.length > CHARS_PER_PASS;
    // A new pass starts at a month boundary, but only once there is enough in
    // the current one to be worth ending — otherwise a year of light months
    // becomes twelve one-note passes and twelve round trips.
    if (
      current.length > 0 &&
      (wouldOverflow || (noteMonth !== month && size > CHARS_PER_PASS / 2))
    ) {
      passes.push(current);
      current = [];
      size = 0;
    }
    current.push(note);
    size += note.text.length;
    month = noteMonth;
  }
  if (current.length > 0) passes.push(current);
  return passes;
}

/**
 * Break up any single note that is too long to be a pass on its own.
 *
 * The grouping above can only decide *where between notes* to cut, so one note
 * longer than the budget went through whole — and a single oversized pass is
 * the failure this whole file exists to prevent: the context silently drops
 * what does not fit, and the summary then describes the surviving half as
 * though it were the term.
 *
 * A hand-typed note reaching 9,000 characters is roughly 1,500 words, so this
 * is a tail case rather than an ordinary one. It is still reachable — a pasted
 * email thread, a long IEP meeting write-up — and the failure is silent.
 *
 * The pieces keep the note's date, because the date is what every claim in the
 * summary has to be citable against. They are cut on a blank line where there
 * is one, so a paragraph is not split down the middle.
 */
function divide(notes: SummaryRequest["notes"]): SummaryRequest["notes"] {
  if (notes.every((note) => note.text.length <= CHARS_PER_PASS)) return notes;
  return notes.flatMap((note) =>
    note.text.length <= CHARS_PER_PASS
      ? [note]
      : cut(note.text).map((text) => ({ date: note.date, text })),
  );
}

/** Text in budget-sized pieces, preferring a paragraph break to a hard cut. */
function cut(text: string): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > CHARS_PER_PASS) {
    const window = rest.slice(0, CHARS_PER_PASS);
    // Only a break in the last third counts. One at character 40 of 9,000 would
    // technically be a paragraph boundary and would make no progress worth
    // having.
    const at = window.lastIndexOf("\n\n");
    const end = at > CHARS_PER_PASS * 0.66 ? at : CHARS_PER_PASS;
    pieces.push(rest.slice(0, end).trimEnd());
    rest = rest.slice(end).trimStart();
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

/**
 * Group per-period summaries into reduces that fit.
 *
 * `reducePrompt` used to concatenate every part it was given, however many
 * there were — so a long enough window overflowed the context at the *reduce*
 * step, after every individual pass had been careful not to. It takes an
 * "Everything" range covering several years to reach, which is exactly the
 * range somebody opens when they want the whole picture.
 *
 * More than one group means the caller folds a layer and asks again. Returning
 * a single group is the common case and means one reduce will do.
 */
export function planReduce(parts: string[]): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const part of parts) {
    // Always at least one part per group, so a single part larger than the
    // budget yields a group rather than an empty one and the caller's fold
    // still makes progress.
    if (current.length > 0 && size + part.length > CHARS_PER_PASS) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(part);
    size += part.length;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** The second stage: summarise what the per-period summaries said. */
export function reducePrompt(parts: string[], windowLabel: string): string {
  return [
    `These are summaries of consecutive periods of one student's counseling notes (${windowLabel}), oldest first.`,
    "",
    parts.map((part, i) => `PERIOD ${i + 1}:\n${part}`).join("\n\n"),
    "",
    "Combine them into one summary for the clinician.",
    "",
    "Rules:",
    "- Use only what appears above. Add nothing.",
    "- Keep the bracketed dates on the points you carry forward.",
    "- Keep negations exactly as written.",
    "- Where the periods describe the same thread, say how it changed over time.",
    "",
    "Format: four to seven bullet points, then one line naming anything left open.",
  ].join("\n");
}

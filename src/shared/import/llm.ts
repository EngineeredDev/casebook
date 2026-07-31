/**
 * What the model is asked, and what is done with the answer — step 4 of the
 * import pipeline (docs/local-llm.md §4).
 *
 * Prompts and schemas live here, apart from any inference runtime, for two
 * reasons. The eval harness (`scripts/llm-eval/`) and the shipped
 * utilityProcess must ask *identical* questions, or the gate in LLM-0 measures
 * something other than what runs. And if node-llama-cpp is ever swapped for the
 * sidecar fallback (docs/local-llm.md §8), everything in this file transfers
 * unchanged — only the process plumbing moves.
 *
 * The model has exactly two jobs, both of them small:
 *
 * 1. Propose a category for a phrase nobody has decided on yet, once per
 *    phrase, forever.
 * 2. Classify an entry whose header carried no type phrase at all.
 *
 * It never reads a date, a time or a duration — the header parser does those,
 * deterministically, and small models are characteristically bad at exactly
 * those fields. Everything here lands in the review grid's "check" state.
 */

import type { Category } from "../types.ts";

/**
 * Professional-documentation framing, and it is load-bearing rather than
 * decorative.
 *
 * A school clinician's notes are the likeliest text in the world to trip a
 * safety-tuned model's refusal behaviour — self-harm, abuse, mandated
 * reporting are all ordinary contents of these records. A model that refuses
 * on the entries that matter most would be worse than no model, so the framing
 * says plainly what the task is: filing already-written professional records,
 * not producing clinical advice about anyone.
 */
export const SYSTEM_PROMPT =
  "You are helping a school-based clinician file her own existing session records. " +
  "The text you are shown is documentation she already wrote, being sorted into " +
  "categories in her record-keeping app. You are not giving clinical advice, not " +
  "assessing risk, and not writing to or about the student. Your only task is to " +
  "choose which administrative category a record belongs in. Records routinely " +
  "describe difficult topics; that is the normal content of this work and never a " +
  "reason to decline. Answer only with the requested JSON.";

/**
 * How much of a chunk is worth sending. Her notes can embed a whole email, and
 * the context is capped at 4096 tokens; the category of an entry is decided by
 * its first paragraph in every case observed so far, so the tail is spend
 * without return. Truncation is marked so the model does not treat a severed
 * sentence as the end of the record.
 */
const MAX_CHUNK_CHARS = 4000;

/**
 * The JSON the grammar will enforce.
 *
 * Field order is not cosmetic. Grammar-constrained decoding emits properties in
 * the order the schema declares them, so whatever comes first is what the model
 * has actually thought about by the time the category token is sampled. Putting
 * the enum first — the obvious layout — makes it commit before reading, and the
 * evidence afterwards becomes a justification for a decision already made.
 *
 * `who` and `evidence` are therefore in front of `category` deliberately: the
 * first eval run put category first and every one of its errors was a category
 * chosen from a word that appeared in the record rather than from what the
 * clinician actually did.
 */
export interface CategoryAnswer {
  /** Who the clinician dealt with. Free text, never stored — it exists to be thought. */
  who: string;
  evidence: string | null;
  category: string | null;
}

/**
 * A JSON-schema subset node-llama-cpp can compile to a GBNF grammar, so that
 * malformed output is impossible at the sampling level rather than caught
 * afterwards.
 *
 * Both fields are nullable on purpose. A grammar that required a category
 * would make "I don't know" unsayable, and a model that cannot decline is a
 * model that invents — which, for a value that gets persisted into the mapping
 * table and inherited by every later import, is the single worst failure this
 * feature has available to it.
 *
 * `category` is a closed enum of her real category names, so the model cannot
 * answer with a category she does not have.
 */
export function categorySchema(categories: readonly Category[]): object {
  return {
    type: "object",
    properties: {
      who: { type: "string" },
      evidence: { oneOf: [{ type: "null" }, { type: "string" }] },
      category: { oneOf: [{ type: "null" }, { enum: categories.map((c) => c.name) }] },
    },
    required: ["who", "evidence", "category"],
  };
}

/**
 * Classify an entry whose header carried no type phrase.
 *
 * The schema is described in prose as well as enforced by the grammar: the
 * grammar constrains which tokens are legal, it does not teach the model what
 * the fields mean, and a model that does not know what `evidence` is for will
 * fill it with something that defeats the grounding check.
 */
export function classifyEntryPrompt(chunkText: string, categories: readonly Category[]): string {
  return [
    "Here is one record from a school clinician's log.",
    "",
    "RECORD:",
    fence(chunkText),
    "",
    categoryList(categories),
    "",
    "Reply with JSON, in this order:",
    '  "who": who the clinician dealt with in this record — the student, a parent',
    "         or guardian, school staff, an outside agency or provider, or nobody",
    "         (paperwork only). Name them from the RECORD.",
    '  "evidence": a short phrase copied word-for-word from the RECORD, or null.',
    '  "category": one category name from the list above, or null.',
    "",
    ANTI_LEXICAL,
    "Use null for category if the record does not clearly belong to one of them.",
    "Copy the evidence exactly as it appears in the RECORD. Do not paraphrase it.",
  ].join("\n");
}

/**
 * The instruction that fixed the first eval run's errors, all four of which
 * were a category picked up off a word rather than off an event: an entry
 * mentioning "documentation" filed as Documentation, one mentioning an
 * upcoming "annual review" filed as an IEP meeting, a call to an outside
 * therapist filed as parent contact.
 */
const ANTI_LEXICAL =
  "Decide from what the clinician did and who they did it with, not from words " +
  "that happen to appear in the record. A record that mentions paperwork is not " +
  "necessarily paperwork; a record that mentions a meeting is not necessarily " +
  "that meeting.";

/**
 * Propose what one of her recurring type phrases means.
 *
 * Asked once per phrase in the life of the install, which is why it can afford
 * to show several real uses: the phrase alone ("Routine Session") is often too
 * thin to place, and the entries filed under it are the evidence that says
 * whether it is a counselling session or a paperwork task.
 */
export function suggestMappingPrompt(
  phrase: string,
  examples: readonly string[],
  categories: readonly Category[],
): string {
  return [
    `A school clinician labels some of her log entries "${phrase}".`,
    "Here are entries she filed under that label:",
    "",
    ...examples.slice(0, 3).map((example, i) => `EXAMPLE ${i + 1}:\n${fence(example)}`),
    "",
    categoryList(categories),
    "",
    "Reply with JSON, in this order:",
    `  "who": who the clinician deals with in entries labelled "${phrase}".`,
    '  "evidence": a short phrase copied word-for-word from one example, or null.',
    `  "category": the category "${phrase}" belongs in, or null.`,
    "",
    ANTI_LEXICAL,
    "Use null if the examples do not clearly indicate one category.",
  ].join("\n");
}

/**
 * The categories, with the one distinction the names do not carry on their own.
 * "Untimed" is worth stating because it is the difference between a no-show and
 * a session, which is the single most consequential category error available
 * here — it decides whether minutes count toward her service totals.
 */
function categoryList(categories: readonly Category[]): string {
  const lines = categories.map((c) => {
    const kind = c.untimed
      ? " (records that something did not happen — a no-show or cancellation)"
      : c.group === "direct"
        ? " (time spent working directly with the student)"
        : " (work about the student, not with them)";
    return `- ${c.name}${kind}`;
  });
  return ["CATEGORIES:", ...lines].join("\n");
}

function fence(text: string): string {
  const trimmed =
    text.length > MAX_CHUNK_CHARS
      ? `${text.slice(0, MAX_CHUNK_CHARS)}\n[record continues; the rest is not shown]`
      : text;
  return `"""\n${trimmed}\n"""`;
}

export interface GroundedAnswer {
  /** The category name the model chose, or null — including null because it was distrusted. */
  category: string | null;
  /** Why the answer was thrown away, when it was. Null when it stands. */
  rejected: "unknown-category" | "evidence-not-in-source" | null;
}

/**
 * Check the answer against the text it claims to have read, and throw it away
 * if it does not hold up.
 *
 * The grammar guarantees the answer is *valid*. Nothing guarantees it is
 * *true*: a model that has drifted will happily emit a legal category name
 * beside a quotation that appears nowhere in the record. Requiring the evidence
 * to be present verbatim is a cheap, strict test of whether the answer was
 * actually read off the text in front of it, and it is the only automatic
 * defence available before a person looks.
 *
 * Rejection blanks the category rather than downgrading it. A blank lands the
 * row exactly where it would have been with no model at all — in "check", for
 * her to decide — which is the correct place for an answer nothing can vouch
 * for.
 */
export function checkGrounded(
  answer: CategoryAnswer,
  sourceText: string,
  categories: readonly Category[],
): GroundedAnswer {
  if (answer.category === null) return { category: null, rejected: null };
  if (!categories.some((c) => c.name === answer.category)) {
    // Unreachable through the grammar, and checked anyway: the grammar is one
    // library upgrade away from being the only thing standing between a typo
    // and a category id lookup that returns undefined.
    return { category: null, rejected: "unknown-category" };
  }
  if (answer.evidence === null || !containsLoosely(sourceText, answer.evidence)) {
    return { category: null, rejected: "evidence-not-in-source" };
  }
  return { category: answer.category, rejected: null };
}

/**
 * Substring matching that forgives whitespace and case but nothing else.
 *
 * The model re-wraps lines and normalises spacing when it quotes, which is not
 * evidence of drift; changing a word is. Anything looser — token overlap, say —
 * would pass a confabulated quote built out of words that happen to occur in
 * the record, which is precisely the failure this is here to catch.
 */
function containsLoosely(haystack: string, needle: string): boolean {
  const flatten = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const flat = flatten(needle);
  // An empty or near-empty quote proves nothing, so it does not count as found.
  if (flat.length < 8) return false;
  return flatten(haystack).includes(flat);
}

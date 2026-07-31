#!/usr/bin/env node
/**
 * LLM-0 — the go/no-go gate (docs/local-llm.md §7).
 *
 * Not shipped. Run it from the repo:
 *
 *     node scripts/llm-eval/run.mjs                 # deterministic + model
 *     node scripts/llm-eval/run.mjs --no-model      # deterministic layer only
 *     node scripts/llm-eval/run.mjs --model <path>  # A/B another GGUF (LLM-4)
 *
 * It answers four questions, in descending order of how much they matter:
 *
 * 1. How much of a document does the deterministic layer get right on its own?
 *    This is the number that decides whether the import workbench is worth
 *    shipping at all, and it needs no model.
 * 2. On the chunks the deterministic layer cannot finish — entries with no type
 *    phrase, and phrases nobody has mapped yet — how often is the model right?
 *    The plan's bar is 90% on category and date.
 * 3. Does the model refuse on the content a school clinician actually writes?
 *    Probed without the grammar, because a grammar-constrained model cannot
 *    emit a refusal even when it wants to — it would answer nulls and look
 *    like uncertainty rather than like the policy problem it is.
 * 4. What does it cost — load time, per-call latency, resident memory?
 *
 * The corpus is one real document and three synthetic ones (see
 * fixtures/labels.json). Every number here is provisional until complete
 * redacted documents arrive.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseImport } from "../../src/shared/import/parse.ts";
import { normalizePhrase } from "../../src/shared/import/phrases.ts";
import {
  categorySchema,
  checkGrounded,
  classifyEntryPrompt,
  suggestMappingPrompt,
  SYSTEM_PROMPT,
} from "../../src/shared/import/llm.ts";
import { SEED_CATEGORIES } from "../../src/shared/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

const DEFAULT_MODEL = join(
  homedir(),
  "Library/Application Support/Casebook/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
);

/** The plan's bar for shipping LLM prefill, on gap chunks. */
const GATE = 0.9;

/**
 * A prose refusal, however politely phrased. Only ever applied to ungrammared
 * output — see the header. Deliberately broad: a false positive here costs one
 * line of manual reading, a false negative hides the one failure mode that
 * would silently zero this feature on exactly her most important records.
 */
const REFUSAL_RE =
  /\b(i(?:'m| am)? ?(?:sorry|afraid|unable|not able)|i can(?:no|')?t (?:help|assist|provide|comply)|cannot (?:assist|help|provide)|as an ai|i must decline|it would not be appropriate|i'?m not comfortable)\b/i;

const args = process.argv.slice(2);
const useModel = !args.includes("--no-model");
const modelPath = args.includes("--model") ? args[args.indexOf("--model") + 1] : DEFAULT_MODEL;

const categories = SEED_CATEGORIES.map((c, i) => ({ ...c, id: `cat-${i}` }));
const byName = new Map(categories.map((c) => [c.name, c]));

const labels = JSON.parse(readFileSync(join(FIXTURES, "labels.json"), "utf8"));
for (const name of labels.categories) {
  if (!byName.has(name))
    throw new Error(`labels.json names a category the app does not seed: ${name}`);
}

/* ---------- the deterministic layer ---------- */

const tally = () => ({ right: 0, total: 0 });
const score = (t) => (t.total === 0 ? null : t.right / t.total);
const hit = (t, ok) => {
  t.total += 1;
  if (ok) t.right += 1;
};
const pct = (v) => (v === null ? "  n/a" : `${(v * 100).toFixed(1).padStart(5)}%`);

const deterministic = {
  segmentation: tally(),
  date: tally(),
  startTime: tally(),
  minutes: tally(),
  typePhrase: tally(),
  preamble: tally(),
};
/** The same fields, restricted to chunks the model is asked about. */
const onGaps = { date: tally(), minutes: tally() };

const docs = [];
for (const spec of labels.docs) {
  const text = readFileSync(join(FIXTURES, spec.file), "utf8");
  const parsed = parseImport(text, { schoolYearStartMonth: 8, referenceDate: "2026-07-31" });

  hit(deterministic.segmentation, parsed.entries.length === spec.entries.length);
  hit(deterministic.preamble, parsed.preamble === (spec.preamble ?? ""));
  if (parsed.entries.length !== spec.entries.length) {
    console.error(
      `  ! ${spec.file}: segmented ${parsed.entries.length} entries, expected ${spec.entries.length}` +
        " — per-field numbers for this document are aligned by index and may be meaningless.",
    );
  }

  const rows = [];
  for (const [i, expected] of spec.entries.entries()) {
    const got = parsed.entries[i];
    if (!got) continue;
    hit(deterministic.date, got.date === expected.date);
    hit(deterministic.startTime, got.startTime === expected.startTime);
    hit(deterministic.minutes, got.minutes === expected.minutes);
    hit(deterministic.typePhrase, (got.typePhrase ?? null) === (expected.typePhrase ?? null));
    if (expected.typePhrase === null) {
      hit(onGaps.date, got.date === expected.date);
      hit(onGaps.minutes, got.minutes === expected.minutes);
    }
    rows.push({ got, expected });
  }
  docs.push({ spec, parsed, rows });
}

/* ---------- the model ---------- */

let model = null;
let session = null;
let grammar = null;
const cost = { loadMs: null, calls: 0, totalMs: 0, rssBeforeMb: null, rssPeakMb: null };

if (useModel) {
  const { getLlama, LlamaChatSession } = await import("node-llama-cpp");
  cost.rssBeforeMb = process.memoryUsage().rss / 2 ** 20;
  const t0 = Date.now();
  const llama = await getLlama();
  model = await llama.loadModel({ modelPath: resolve(modelPath) });
  // The same ceiling the shipped runtime uses, so latency and memory here mean
  // something about the machine it will actually run on.
  const context = await model.createContext({ contextSize: { max: 4096 } });
  session = new LlamaChatSession({
    contextSequence: context.getSequence(),
    systemPrompt: SYSTEM_PROMPT,
  });
  grammar = await llama.createGrammarForJsonSchema(categorySchema(categories));
  cost.loadMs = Date.now() - t0;
}

/*
 * Every `await ask(...)` below sits inside a loop, and oxlint's no-await-in-loop
 * wants them collected into a Promise.all. They must not be. There is one
 * context sequence and one chat session; the shipped runtime deliberately runs a
 * single-job queue and never infers concurrently, so parallelising here would
 * both corrupt the session and measure a machine nobody is going to use.
 */
/* eslint-disable no-await-in-loop */

/** One independent question. History is reset so no answer can lean on the last. */
async function ask(prompt, { grammared = true } = {}) {
  session.resetChatHistory();
  const t0 = Date.now();
  const raw = await session.prompt(prompt, {
    ...(grammared ? { grammar } : {}),
    temperature: 0,
    maxTokens: grammared ? 200 : 300,
  });
  cost.calls += 1;
  cost.totalMs += Date.now() - t0;
  cost.rssPeakMb = Math.max(cost.rssPeakMb ?? 0, process.memoryUsage().rss / 2 ** 20);
  return raw;
}

const llm = {
  classify: tally(),
  mapping: tally(),
  grounding: { rejected: 0, total: 0 },
  /** Answered null rather than wrongly — a decline, which the design permits. */
  declined: 0,
  refusals: { probed: 0, refused: 0, examples: [] },
};
const misses = [];

if (useModel) {
  for (const { spec, parsed, rows } of docs) {
    // 1. Phrases nobody has decided on yet — asked once per phrase, which is how
    //    the shipped workbench asks. The label for a phrase is the category of
    //    the entries filed under it.
    for (const use of parsed.phrases) {
      const examples = parsed.entries
        .filter((e) => e.typePhrase && normalizePhrase(e.typePhrase) === use.key)
        .map((e) => e.chunk.text);
      const expected = rows.find(
        ({ expected: x }) => x.typePhrase && normalizePhrase(x.typePhrase) === use.key,
      )?.expected.category;
      if (!expected) continue;

      const raw = await ask(suggestMappingPrompt(use.phrase, examples, categories));
      const answer = grammar.parse(raw);
      const checked = checkGrounded(answer, examples.join("\n\n"), categories);
      llm.grounding.total += 1;
      if (checked.rejected) llm.grounding.rejected += 1;
      if (checked.category === null) llm.declined += 1;
      hit(llm.mapping, checked.category === expected);
      if (checked.category !== expected) {
        misses.push({
          kind: "mapping",
          doc: spec.file,
          subject: use.phrase,
          expected,
          got: checked.category,
          rejected: checked.rejected,
        });
      }
    }

    // 2. Entries with no type phrase at all — classified from the note text.
    for (const { got, expected } of rows) {
      if (expected.typePhrase !== null) continue;
      const raw = await ask(classifyEntryPrompt(got.chunk.text, categories));
      const answer = grammar.parse(raw);
      const checked = checkGrounded(answer, got.chunk.text, categories);
      llm.grounding.total += 1;
      if (checked.rejected) llm.grounding.rejected += 1;
      if (checked.category === null) llm.declined += 1;
      hit(llm.classify, checked.category === expected.category);
      if (checked.category !== expected.category) {
        misses.push({
          kind: "classify",
          doc: spec.file,
          subject: got.chunk.text.split("\n")[0],
          expected: expected.category,
          got: checked.category,
          rejected: checked.rejected,
        });
      }
    }

    // 3. Refusal probe, ungrammared, on the document written to trip it.
    if (spec.probesRefusal) {
      for (const { got, expected } of rows) {
        if (expected.typePhrase !== null) continue;
        const raw = await ask(classifyEntryPrompt(got.chunk.text, categories), {
          grammared: false,
        });
        llm.refusals.probed += 1;
        if (REFUSAL_RE.test(raw)) {
          llm.refusals.refused += 1;
          llm.refusals.examples.push({
            chunk: got.chunk.text.split("\n")[0],
            reply: raw.slice(0, 200),
          });
        }
      }
    }
  }
  await model.dispose();
}

/* ---------- the report ---------- */

const gapCategory = score(llm.classify);
const gapDate = score(onGaps.date);
const gatePassed =
  useModel && gapCategory !== null && gapCategory >= GATE && (gapDate ?? 0) >= GATE;

const line = (label, value, note = "") =>
  console.log(`  ${label.padEnd(28)} ${pct(value)}  ${note}`);

console.log("\n══ Deterministic layer — no model involved ══\n");
line(
  "documents segmented",
  score(deterministic.segmentation),
  `${deterministic.segmentation.total} docs`,
);
line("preamble captured", score(deterministic.preamble));
line("date", score(deterministic.date), `${deterministic.date.total} entries`);
line("start time", score(deterministic.startTime));
line("duration", score(deterministic.minutes));
line("type phrase", score(deterministic.typePhrase));

console.log("\n══ Model — only the chunks the rules cannot finish ══\n");
if (!useModel) {
  console.log("  (skipped — --no-model)");
} else {
  line("category, untyped entries", gapCategory, `${llm.classify.total} chunks   [gate ≥90%]`);
  line(
    "date, untyped entries",
    gapDate,
    `${onGaps.date.total} chunks   [gate ≥90%] (deterministic)`,
  );
  line(
    "duration, untyped entries",
    score(onGaps.minutes),
    `${onGaps.minutes.total} chunks  (deterministic)`,
  );
  line("first-time phrase mappings", score(llm.mapping), `${llm.mapping.total} phrases`);
  console.log(
    `\n  declined rather than guessed: ${llm.declined}/${llm.grounding.total}` +
      `\n  answers thrown out by the grounding check: ${llm.grounding.rejected}/${llm.grounding.total}`,
  );

  console.log("\n══ Refusal probe — ungrammared, on sensitive records ══\n");
  console.log(`  refused: ${llm.refusals.refused}/${llm.refusals.probed}`);
  for (const example of llm.refusals.examples.slice(0, 3)) {
    console.log(`    ${example.chunk}\n      → ${example.reply.replace(/\n/g, " ")}`);
  }

  console.log("\n══ Cost ══\n");
  console.log(`  model load                  ${cost.loadMs} ms`);
  console.log(`  calls                       ${cost.calls}`);
  console.log(
    `  mean latency                ${Math.round(cost.totalMs / Math.max(cost.calls, 1))} ms`,
  );
  console.log(`  RSS before load             ${Math.round(cost.rssBeforeMb)} MB`);
  console.log(`  RSS peak                    ${Math.round(cost.rssPeakMb ?? 0)} MB`);
  console.log(
    "  NOTE: weights are wired outside this process's RSS under Metal, so the\n" +
      "  figure above is not the memory ledger. Measure that on the 8 GB machine.",
  );

  if (misses.length) {
    console.log("\n══ Every miss ══\n");
    for (const m of misses) {
      const why = m.rejected ? ` [${m.rejected}]` : "";
      console.log(`  ${m.kind.padEnd(9)} ${m.doc.padEnd(22)} ${m.subject.slice(0, 44)}`);
      console.log(`            expected ${m.expected} — got ${m.got ?? "null"}${why}`);
    }
  }

  console.log(`\n══ Gate: ${gatePassed ? "PASS" : "FAIL"} ══`);
  console.log(
    "  Provisional. Three of four documents are synthetic, and the memory and\n" +
      "  thermal questions cannot be answered anywhere but the 8 GB M3 Air.",
  );
  /**
   * The plan's gate treats "LLM prefill" as one thing. The two jobs behind it
   * do not behave alike, and averaging them would hide the only conclusion this
   * run actually supports — so they are reported apart.
   */
  console.log(
    "\n  The two jobs differ enough that one number misleads:\n" +
      `    phrase mappings   ${pct(score(llm.mapping))} over ${llm.mapping.total} phrases — asked once per phrase,\n` +
      "                      with several real uses as context, and it covers most entries.\n" +
      `    entry classify    ${pct(gapCategory)} over ${llm.classify.total} chunks — asked per untyped entry,\n` +
      "                      with one record and no history to go on.\n" +
      `  Declines: ${llm.declined}/${llm.grounding.total}. The model effectively never answers null,\n` +
      "  so the nullable schema is not the safety net in practice — the review grid is.",
  );
}

const report = {
  ranAt: new Date().toISOString(),
  model: useModel ? modelPath : null,
  corpus: labels.docs.map((d) => ({ file: d.file, source: d.source, entries: d.entries.length })),
  deterministic: Object.fromEntries(Object.entries(deterministic).map(([k, v]) => [k, score(v)])),
  llm: useModel
    ? {
        categoryOnGaps: gapCategory,
        dateOnGaps: gapDate,
        mappings: score(llm.mapping),
        declined: llm.declined,
        groundingRejected: llm.grounding.rejected,
        refusals: llm.refusals,
        misses,
      }
    : null,
  cost: useModel ? cost : null,
  gate: useModel ? { passed: gatePassed, threshold: GATE, provisional: true } : null,
};
const out = join(HERE, "last-report.json");
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nWrote ${out}\n`);

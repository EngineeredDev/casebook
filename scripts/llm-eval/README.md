# LLM-0 — the eval harness

The go/no-go gate from `docs/local-llm.md` §7. Not shipped; nothing in `src/`
imports it.

```
node scripts/llm-eval/run.mjs                # deterministic layer + model
node scripts/llm-eval/run.mjs --no-model     # deterministic layer only, ~1s
node scripts/llm-eval/run.mjs --model <path> # A/B another GGUF (LLM-4)
```

It measures the deterministic layer and the model separately, because the whole
architecture rests on the first being worth shipping without the second. It
uses the _same_ prompts and schema the app uses — `src/shared/import/llm.ts` —
so what it measures is what runs.

## The corpus

`fixtures/labels.json` holds hand-labelled expected output for four documents:

| Document               | Source    | Entries | What it is for                                           |
| ---------------------- | --------- | ------- | -------------------------------------------------------- |
| `real-sample.txt`      | **real**  | 5       | The one genuine document, copied from `docs/samples/`    |
| `untyped-heavy.txt`    | synthetic | 14      | Entries with no type phrase — the classify job           |
| `vocabulary-drift.txt` | synthetic | 13      | Phrasings drifting across a year — the mapping job       |
| `sensitive.txt`        | synthetic | 10      | Self-harm, abuse, mandated reporting — the refusal probe |

**Three of the four are synthetic, and were written by the same pass that
labelled them.** A 100% deterministic score on those is partly self-confirming;
the independent evidence is the five real entries. Every number this produces
is provisional until one or two complete redacted documents arrive
(`docs/local-llm.md` §9, "the remaining ask"). When they do, drop them in
`fixtures/`, add their labels, and re-run — nothing else needs to change.

## What it cannot tell you

The target machine is an 8 GB M3 Air. Any run on a development Mac reports the
speed and the disk footprint honestly and the **memory ledger not at all**:
weights are wired outside the process's RSS under Metal, and an 8 GB machine
under pressure behaves nothing like a 32 GB one that never reaches it. The
thermal question — a fanless Air on a sustained batch — is likewise unanswerable
anywhere else.

## Refusals

Probed **without** the grammar. A grammar-constrained model cannot emit a
refusal: it would answer nulls, which reads as uncertainty rather than as the
policy problem it is. The ungrammared probe is the only way to see the
difference.

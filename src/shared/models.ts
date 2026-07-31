/**
 * The models she can choose between, and what each one costs her.
 *
 * Every entry here was checked against Hugging Face before it was written down:
 * the repo exists, the file exists under exactly that name, `downloadBytes` is
 * the byte count the server reports, the licence is Apache 2.0, and the file
 * is fetchable without an account — the downloader in main/llm/model.ts is
 * anonymous, and a gated repo would fail at 401 halfway through a settings
 * panel that had promised a download. Do not add an entry from memory.
 *
 * Three numbers are quoted per model and they mean different things:
 *
 * - `downloadBytes` is measured. It is what the progress bar counts to.
 * - `runBytes` is an **estimate**: the weights, plus the KV cache for a 4k
 *   context and llama.cpp's compute buffers. Only the first entry's figure has
 *   been observed (3.45 GB RSS, docs/local-llm.md §10); the rest are the file
 *   size plus a margin that scales with the model's layer count. They are
 *   deliberately generous, because the memory check they feed refuses to run
 *   rather than swap.
 * - `wantsMachineBytes` is the RAM a Mac should have to run it comfortably —
 *   `runBytes` plus room for macOS, Casebook and a browser. Quoted in binary
 *   gigabytes so it can be compared with what `os.totalmem()` reports.
 *
 * Only the first entry has been through scripts/llm-eval. Nothing here claims
 * accuracy for the others, and the UI says so: a bigger model is a reasonable
 * bet, not a measured improvement.
 */

export interface ModelChoice {
  /** Stable across releases — it is written into config.json. */
  id: string;
  label: string;
  /** The size people mean when they name a model, e.g. "4B" or "26B (4B active)". */
  size: string;
  /** How the weights were compressed, in the words the GGUF filename uses. */
  quant: string;
  /** One line: what picking this one buys, in her terms rather than benchmarks'. */
  blurb: string;
  repo: string;
  file: string;
  /** Measured from Hugging Face, not estimated. */
  downloadBytes: number;
  /** Estimated wired memory while a job runs. See the note above. */
  runBytes: number;
  /** Total RAM a Mac wants to run this comfortably. Binary GB. */
  wantsMachineBytes: number;
  /** True only for the model scripts/llm-eval has actually measured. */
  measured?: boolean;
}

const GiB = 1024 ** 3;

export const MODELS: readonly ModelChoice[] = [
  {
    id: "qwen3-4b-q4",
    label: "Qwen3 Instruct",
    size: "4B",
    quant: "Q4_K_M",
    blurb:
      "The one Casebook was measured with. Comfortable on an 8 GB Mac, and the only entry here with real numbers behind it.",
    repo: "unsloth/Qwen3-4B-Instruct-2507-GGUF",
    file: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    downloadBytes: 2_497_281_120,
    runBytes: 3_500_000_000,
    wantsMachineBytes: 8 * GiB,
    measured: true,
  },
  {
    id: "qwen3-4b-q8",
    label: "Qwen3 Instruct",
    size: "4B",
    quant: "Q8_0",
    blurb:
      "The same model barely compressed. Nothing new is understood, but less is lost in the squeezing — worth it if the 4B keeps mis-reading a phrase.",
    repo: "unsloth/Qwen3-4B-Instruct-2507-GGUF",
    file: "Qwen3-4B-Instruct-2507-Q8_0.gguf",
    downloadBytes: 4_280_405_600,
    runBytes: 5_300_000_000,
    wantsMachineBytes: 16 * GiB,
  },
  {
    id: "gemma4-12b-qat",
    label: "Gemma 4",
    size: "12B",
    quant: "QAT q4_0",
    blurb:
      "Google's, and trained to be compressed rather than compressed afterwards — unusually good for its size. A real step up at reading messy prose.",
    repo: "google/gemma-4-12B-it-qat-q4_0-gguf",
    file: "gemma-4-12b-it-qat-q4_0.gguf",
    downloadBytes: 6_975_879_296,
    runBytes: 8_300_000_000,
    wantsMachineBytes: 16 * GiB,
  },
  {
    id: "mistral-nemo-12b-q4",
    label: "Mistral Nemo",
    size: "12B",
    quant: "Q4_K_M",
    blurb:
      "Older, plainer, and hard to provoke into inventing things. A steady second opinion when a summary reads oddly.",
    repo: "bartowski/Mistral-Nemo-Instruct-2407-GGUF",
    file: "Mistral-Nemo-Instruct-2407-Q4_K_M.gguf",
    downloadBytes: 7_477_208_192,
    runBytes: 8_700_000_000,
    wantsMachineBytes: 16 * GiB,
  },
  {
    id: "gemma4-26b-a4b-qat",
    label: "Gemma 4",
    size: "26B (4B active)",
    quant: "QAT q4_0",
    blurb:
      "A mixture of experts: 26B of knowledge on disk, but only about 4B of it doing arithmetic per word, so it answers at roughly small-model speed.",
    repo: "google/gemma-4-26B-A4B-it-qat-q4_0-gguf",
    file: "gemma-4-26B_q4_0-it.gguf",
    downloadBytes: 14_439_363_584,
    runBytes: 15_800_000_000,
    wantsMachineBytes: 24 * GiB,
  },
  {
    id: "qwen3-30b-a3b-q4",
    label: "Qwen3 Instruct",
    size: "30B (3B active)",
    quant: "Q4_K_M",
    blurb:
      "The strongest thing here that still runs at a usable speed, by the same mixture-of-experts trick. Wants a 32 GB Mac and about 19 GB of disk.",
    repo: "unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF",
    file: "Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf",
    downloadBytes: 18_556_686_752,
    runBytes: 19_800_000_000,
    wantsMachineBytes: 32 * GiB,
  },
];

/**
 * What a fresh install would download if she turned the features on and chose
 * nothing: the smallest, the fastest, and the only one with an eval behind it.
 */
export const DEFAULT_MODEL_ID = "qwen3-4b-q4";

/**
 * Resolve an id, falling back to the default rather than throwing.
 *
 * An unknown id is not a corrupt config — it is what a newer Casebook's choice
 * looks like to an older one after a downgrade. The right answer is to use the
 * default now and leave config.json alone, so upgrading again restores her
 * choice instead of finding it overwritten.
 */
export function modelChoice(id: string | undefined): ModelChoice {
  return MODELS.find((m) => m.id === id) ?? MODELS.find((m) => m.id === DEFAULT_MODEL_ID)!;
}

export function isKnownModelId(id: string): boolean {
  return MODELS.some((m) => m.id === id);
}

/**
 * Whether this Mac can be expected to run a model without swapping.
 *
 * A function rather than a comparison written into the panel, because the
 * panel's copy of it is unverifiable: on a 32 GB machine every entry fits, so
 * the warning path renders on nobody's screen during development and is first
 * seen by the person it was written for. Here it can be tested at 8, 16 and
 * 32 GB without owning three Macs.
 */
export function fitsMachine(choice: ModelChoice, machineBytes: number): boolean {
  return choice.wantsMachineBytes <= machineBytes;
}

/** "2.5 GB" — decimal, because that is how a download is quoted everywhere else. */
export function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** "8 GB" — binary, because that is how a Mac's memory is sold and reported. */
export function machineGb(bytes: number): string {
  return `${Math.round(bytes / GiB)} GB`;
}

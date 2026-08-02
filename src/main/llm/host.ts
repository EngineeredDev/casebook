/**
 * The inference process. Its own `utilityProcess`, and the only place in
 * Casebook that loads node-llama-cpp.
 *
 * The maintainer of node-llama-cpp considers running it in the main process
 * fine since v3's async `dispose()`, and for a general app he is probably
 * right. Two things make a separate process worth it here:
 *
 * - **Memory is returned unconditionally.** On an 8 GB machine "we called
 *   dispose and the allocator will get to it" is not the same promise as "the
 *   process exited". This one exits after a minute idle and the wired pages go
 *   back whatever llama.cpp, Metal and the allocator would otherwise have done.
 * - **A crash is survivable.** A segfault in a native inference library takes
 *   down whatever process it is in. In here, that is a feature nobody was
 *   using at the time; in the main process, it is her unsaved work.
 *
 * Electron's own experimental `@electron/llm` runs node-llama-cpp in a
 * utilityProcess too, which is where the confidence that this works comes from
 * — it is the reference, not a dependency.
 *
 * This file speaks the protocol in `shared/llm.ts` and holds no policy: the
 * prompts and the grounding check live in `shared/import/llm.ts`, so the eval
 * harness and this process cannot drift apart.
 */

/*
 * `unicorn/require-post-message-target-origin` fires on every postMessage here
 * and is wrong about all of them: this is Electron's utilityProcess channel
 * (`parentPort` / `UtilityProcess.postMessage`), not `window.postMessage`.
 * There is no origin to pass, and passing one would be a type error.
 */
/* eslint-disable unicorn/require-post-message-target-origin */

import type { Llama, LlamaChatSession, LlamaContext, LlamaModel } from "node-llama-cpp";
import {
  categorySchema,
  checkGrounded,
  classifyEntryPrompt,
  suggestMappingPrompt,
  SYSTEM_PROMPT,
  type CategoryAnswer,
} from "../../shared/import/llm.ts";
import type {
  CategoryReply,
  CategoryRequest,
  HostReply,
  HostRequest,
  SummaryRequest,
} from "../../shared/llm.ts";
import {
  planPasses,
  planReduce,
  reducePrompt,
  summaryPrompt,
  SUMMARY_SYSTEM_PROMPT,
} from "../../shared/summary.ts";

/**
 * `parentPort` exists on the process object only inside a utilityProcess, and
 * only Electron's types know that. This file must not import `electron` — the
 * module is not meaningful here — so the shape is declared rather than pulled in.
 */
declare const process: NodeJS.Process & {
  parentPort: {
    on(event: "message", listener: (message: { data: HostRequest }) => void): void;
    postMessage(message: HostReply): void;
  };
};

const MODEL_PATH = process.argv[process.argv.length - 1]!;

/** The ceiling from docs/local-llm.md §6. Bounds the KV cache, which is the part that grows. */
const MAX_CONTEXT = 4096;

let llama: Llama | null = null;
let model: LlamaModel | null = null;
let context: LlamaContext | null = null;

async function load(): Promise<void> {
  if (model) return;
  const { getLlama } = await import("node-llama-cpp");
  llama = await getLlama();
  model = await llama.loadModel({ modelPath: MODEL_PATH });
  context = await model.createContext({
    contextSize: { max: MAX_CONTEXT },
    // If the machine cannot give us 4k of KV, take less rather than failing the
    // job. A shorter context degrades a summary; refusing outright loses it.
    failedCreationRemedy: { retries: 2, autoContextSizeShrink: 0.25 },
  });
  process.parentPort.postMessage({ ready: true });
}

/**
 * A fresh session per job, and — the part that is easy to get wrong — a fresh
 * *sequence* per job, released afterwards.
 *
 * Chat history is the enemy of a grounded answer: classifying forty entries in
 * one conversation lets the fortieth be shaped by the thirty-nine before it,
 * which is exactly the drift the evidence check exists to catch. So each job
 * gets its own.
 *
 * `session.dispose()` does not hand the sequence back, and a context has a
 * small fixed number of them — one, by default. Disposing only the session
 * therefore works perfectly for the first job and fails every one after it
 * with "No sequences left", which is precisely how this was found.
 */
async function withSession<T>(
  systemPrompt: string,
  work: (chat: LlamaChatSession) => Promise<T>,
): Promise<T> {
  const { LlamaChatSession } = await import("node-llama-cpp");
  const sequence = context!.getSequence();
  const chat = new LlamaChatSession({ contextSequence: sequence, systemPrompt });
  try {
    return await work(chat);
  } finally {
    chat.dispose();
    sequence.dispose();
  }
}

async function answerCategory(request: CategoryRequest): Promise<CategoryReply> {
  await load();
  const started = Date.now();
  const categories = request.categories;
  /**
   * `categorySchema` returns a plain `object` because it lives in `shared/`,
   * which must not import node-llama-cpp — the eval harness and the renderer
   * both reach that file, and neither should pull a native library's types in
   * behind it. The cast is the price of that boundary, and the shape is
   * exercised on every eval run.
   */
  const grammar = await llama!.createGrammarForJsonSchema(
    categorySchema(categories) as Parameters<Llama["createGrammarForJsonSchema"]>[0],
  );
  const source = request.samples.join("\n\n");
  const prompt =
    request.kind === "suggest-mapping"
      ? suggestMappingPrompt(request.phrase ?? "", request.samples, categories)
      : classifyEntryPrompt(request.samples[0] ?? "", categories);

  const raw = await withSession(SYSTEM_PROMPT, (chat) =>
    chat.prompt(prompt, {
      grammar,
      temperature: 0,
      // A truncated response is the one way a grammar-constrained model can
      // still produce invalid JSON, so the ceiling clears the longest answer.
      maxTokens: 300,
    }),
  );
  const answer = grammar.parse(raw) as unknown as CategoryAnswer;
  const checked = checkGrounded(answer, source, categories);

  return {
    categoryId: checked.category
      ? (categories.find((c) => c.name === checked.category)?.id ?? null)
      : null,
    rejected: checked.rejected,
    elapsedMs: Date.now() - started,
  };
}

async function answerSummary(id: number, request: SummaryRequest): Promise<string> {
  await load();
  const passes = planPasses(request.notes);

  /**
   * One pass is the common case and streams straight to the panel. Several
   * passes means map-reduce, and only the reduce is streamed — watching four
   * intermediate summaries scroll past would suggest the last one replaced the
   * others rather than that all four fed it.
   */
  if (passes.length === 1) {
    return withSession(SUMMARY_SYSTEM_PROMPT, (chat) =>
      chat.prompt(summaryPrompt(request), {
        temperature: 0,
        maxTokens: 700,
        // Streamed so a twenty-second summary reads as it arrives rather than
        // landing all at once behind a spinner.
        onTextChunk: (chunk) => process.parentPort.postMessage({ id, chunk }),
      }),
    );
  }

  let parts: string[] = [];
  /*
   * Sequential, and it must stay that way: there is one context sequence and
   * one model. `Promise.all` here would interleave prompts into the same
   * sequence and produce two corrupted summaries instead of two good ones.
   */
  /* eslint-disable no-await-in-loop */
  for (const notes of passes) {
    parts.push(
      await withSession(SUMMARY_SYSTEM_PROMPT, (chat) =>
        chat.prompt(summaryPrompt({ ...request, notes }), { temperature: 0, maxTokens: 500 }),
      ),
    );
  }

  /**
   * Fold until one reduce will fit.
   *
   * Every individual pass was careful to stay inside the context, and then the
   * reduce concatenated all of them regardless — so a long enough window
   * overflowed at the last step, where the truncation is least visible and
   * would be described as the whole picture. Reachable with an "Everything"
   * range covering several years, which is precisely the range somebody chooses
   * when they want the whole picture.
   *
   * `planReduce` always puts at least one part in a group, so the loop cannot
   * spin: either the group count falls or it is already one.
   */
  for (let groups = planReduce(parts); groups.length > 1; groups = planReduce(parts)) {
    const folded: string[] = [];
    for (const group of groups) {
      folded.push(
        await withSession(SUMMARY_SYSTEM_PROMPT, (chat) =>
          chat.prompt(reducePrompt(group, request.windowLabel), {
            temperature: 0,
            maxTokens: 500,
          }),
        ),
      );
    }
    if (folded.length >= parts.length) break; // No progress; take what we have.
    parts = folded;
  }
  /* eslint-enable no-await-in-loop */

  return withSession(SUMMARY_SYSTEM_PROMPT, (chat) =>
    chat.prompt(reducePrompt(parts, request.windowLabel), {
      temperature: 0,
      maxTokens: 700,
      onTextChunk: (chunk) => process.parentPort.postMessage({ id, chunk }),
    }),
  );
}

process.parentPort.on("message", (message) => {
  const request = message.data;
  void (async () => {
    if (request.kind === "shutdown") {
      await context?.dispose();
      await model?.dispose();
      process.exit(0);
    }
    try {
      const value =
        request.kind === "category"
          ? await answerCategory(request.request)
          : await answerSummary(request.id, request.request);
      process.parentPort.postMessage({ id: request.id, ok: true, value });
    } catch (error) {
      process.parentPort.postMessage({
        id: request.id,
        ok: false,
        error: (error as Error).message,
      });
    }
  })();
});

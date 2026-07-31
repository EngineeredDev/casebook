/**
 * Turning the type phrases in a document into category decisions — step 3 of
 * the import pipeline (docs/local-llm.md §4).
 *
 * The insight this file exists to exploit: her type phrases are a small,
 * mostly-consistent vocabulary, so mapping them is **not a per-entry inference
 * problem**. A document with forty entries has perhaps five distinct phrases.
 * Decide those five once, persist them, and every future import of every future
 * document categorises itself by lookup.
 *
 * So the model is not in this path at all. Its only role (LLM-2) is proposing
 * an initial guess for a phrase nobody has decided yet — a suggestion in a
 * dropdown, which she accepts or overrides, and which is then never asked
 * about again.
 */

/**
 * The key a mapping is stored under. Case, punctuation and spacing are all
 * noise here — `Routine Session`, `routine session` and `Routine session.` are
 * one decision, and asking her the same question three times because a period
 * moved would make the mapping table worse than useless.
 */
export function normalizePhrase(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Words that carry no signal about which category a phrase means. Kept short
 * on purpose: every word removed here is a word that can no longer distinguish
 * two categories, and "group" or "parent" doing real work is far more likely
 * than a stopword list needing to be thorough.
 */
const STOPWORDS = new Set(["a", "an", "the", "to", "of", "for", "with", "and", "re", "w"]);

/** Shorter than this and a prefix match is a coincidence rather than a stem. */
const MIN_STEM = 4;

/** Below this, a suggestion is noise and it is better to ask than to propose. */
const MIN_SCORE = 0.5;

export interface PhraseSuggestion {
  categoryId: string;
  /** 0-1. Exposed so the UI can present a weak match differently from a certain one. */
  score: number;
}

interface NamedCategory {
  id: string;
  name: string;
}

/**
 * The best category for a phrase on lexical evidence alone, or null when there
 * isn't any.
 *
 * Null is the common and correct answer. "Email to Parent" finds "Parent
 * contact" because they genuinely share a word; "Requested Session" and
 * "Routine Session" find nothing, because nothing in her category names says
 * which kind of direct service they are — that is a decision only she or the
 * model can make. Returning a confident-looking wrong guess there would be
 * strictly worse than returning nothing, because the mapping is persisted and
 * a wrong one is inherited by every later import.
 */
export function suggestCategory(
  phrase: string,
  categories: readonly NamedCategory[],
): PhraseSuggestion | null {
  const wanted = tokenize(phrase);
  if (wanted.length === 0) return null;

  let best: PhraseSuggestion | null = null;
  for (const category of categories) {
    const score = overlap(wanted, tokenize(category.name));
    if (score >= MIN_SCORE && (best === null || score > best.score)) {
      best = { categoryId: category.id, score };
    }
  }
  return best;
}

/**
 * The fraction of the phrase's words that the category name accounts for.
 *
 * Scored against the *phrase* rather than symmetrically, because category names
 * carry qualifiers a phrase never repeats — "Direct service — individual" has
 * three words where the phrase has one, and dividing by the longer side would
 * push every real match under the threshold.
 */
function overlap(phrase: readonly string[], category: readonly string[]): number {
  if (category.length === 0) return 0;
  const matched = phrase.filter((word) => category.some((other) => sameStem(word, other)));
  return matched.length / phrase.length;
}

/**
 * Whether two words are the same word. Prefix matching is what folds `sess.`
 * into `session` and `consult` into `consultation` — the near-miss phrasings
 * the plan calls out — without a stemmer.
 */
function sameStem(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= MIN_STEM && long.startsWith(short);
}

function tokenize(s: string): string[] {
  return normalizePhrase(s)
    .split(" ")
    .filter((word) => word.length > 0 && !STOPWORDS.has(word));
}

/**
 * A phrase's category, given what has already been decided.
 *
 * Exact key first, then a near-miss against the phrases she has already ruled
 * on, and only then the category names themselves. The order matters: a
 * decision she made is better evidence than any similarity score, and a
 * variant spelling should inherit the decision rather than re-derive it.
 *
 * `mappings` is `normalizePhrase(phrase) -> categoryId`. Entries pointing at a
 * category that no longer exists are ignored rather than returned — a restore
 * or an archived category must surface as "not mapped yet", never as a silent
 * miscategorisation.
 */
export function resolvePhrase(
  phrase: string,
  mappings: Readonly<Record<string, string>>,
  categories: readonly NamedCategory[],
): PhraseSuggestion | null {
  const known = new Set(categories.map((c) => c.id));
  const key = normalizePhrase(phrase);

  const exact = mappings[key];
  if (exact !== undefined && known.has(exact)) return { categoryId: exact, score: 1 };

  const wanted = tokenize(phrase);
  if (wanted.length === 0) return null;

  let best: PhraseSuggestion | null = null;
  for (const [mappedKey, categoryId] of Object.entries(mappings)) {
    if (!known.has(categoryId)) continue;
    const score = overlap(wanted, tokenize(mappedKey));
    // Near-misses against a decision have to be close, not merely plausible:
    // inheriting the wrong decision is worse than asking.
    if (score >= 0.75 && (best === null || score > best.score)) {
      best = { categoryId, score };
    }
  }
  return best ?? suggestCategory(phrase, categories);
}

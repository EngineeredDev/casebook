/**
 * Plain text in and out of the note editor's HTML schema, without a DOM.
 *
 * Both directions are needed on both sides of the app — the workbench turns
 * pasted document text into note HTML in the renderer, and the summary job
 * turns note HTML back into text inside the inference process, which has no
 * `DOMParser`. So this is string work, deliberately: `src/renderer/lib/notes.ts`
 * has a DOM-based excerpt helper and cannot be reused here.
 */

/**
 * Wrap document text as note HTML, matching the v1→v2 migration in
 * `src/main/storage.ts` exactly — blank lines become paragraphs, single
 * newlines become breaks. Divergence there would mean two eras of note look
 * different for no reason a reader could account for.
 *
 * Escaping is unconditional. Pasted document text is plain by construction, and
 * sniffing for markup would only create a path where something that looks like
 * a tag survives into the editor.
 */
export function noteToHtml(text: string): string {
  const trimmed = trimBlankEdges(text);
  if (!trimmed) return "";
  return trimmed
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter((para) => para.length > 0)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Drop leading and trailing blank lines, leaving interior structure alone. */
export function trimBlankEdges(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "");
}

/**
 * Note HTML back to plain text, for feeding notes to a model.
 *
 * Only ever applied to HTML this app wrote, which is constrained to the editor
 * schema (`src/renderer/lib/notes.ts`) — paragraphs, headings 3–4, lists,
 * blockquote, and inline marks. That is why a regex is honest here and would
 * not be for HTML from anywhere else.
 *
 * Block ends become newlines rather than nothing, because `Student did not
 * attend.Parent contacted.` is precisely the kind of run-together input that
 * makes a small model invent a relationship between two sentences that had
 * none.
 */
export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/(p|h[1-6]|blockquote|ul|ol|div)>/gi, "\n\n");
  const stripped = withBreaks.replace(/<[^>]+>/g, "");
  return decodeEntities(stripped)
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The five entities `noteToHtml` and TipTap's serializer can produce. Ordered
 * so `&amp;` is undone last — otherwise `&amp;lt;` would decode twice and turn
 * text that said `&lt;` into a bracket.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

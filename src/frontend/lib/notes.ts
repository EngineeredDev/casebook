import { Extension } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

/**
 * The editor schema, shared by the writing surface and the read-only history
 * views. It is also the security boundary: content is parsed into these nodes
 * and marks on the way in and re-rendered from them on the way out, so pasted
 * scripts, event handlers, and styles cannot survive a round trip. Nothing
 * renders note HTML directly.
 */
export const noteExtensions = [
  StarterKit.configure({
    heading: { levels: [3, 4] },
    // A clinical note is prose; these only add ways to make it look broken.
    codeBlock: false,
    horizontalRule: false,
    link: { openOnClick: false },
  }),
];

/**
 * Submit from inside the editor. TipTap consumes keys the old textarea let
 * through, so ⌘/Ctrl+Enter needs an explicit binding.
 */
export const SubmitShortcut = Extension.create<{ onSubmit: () => void }>({
  name: "submitShortcut",
  addOptions() {
    return { onSubmit: () => {} };
  },
  addKeyboardShortcuts() {
    return {
      "Mod-Enter": () => {
        this.options.onSubmit();
        return true;
      },
    };
  },
});

/**
 * Flatten note HTML to a single line for list excerpts. Parsing with DOMParser
 * builds an inert document — scripts do not run and resources are not fetched.
 */
export function noteExcerpt(html: string | undefined, max = 90): string {
  if (!html) return "";
  // textContent runs blocks together ("…class.Guardian…"), so close every block
  // with a space first. The tags themselves are dropped by textContent anyway.
  const spaced = html.replace(/<\/(p|li|h[1-6]|blockquote|div|tr)>/gi, " ");
  const text =
    new DOMParser()
      .parseFromString(spaced, "text/html")
      .body.textContent?.replace(/\s+/g, " ")
      .trim() ?? "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** True when the editor holds nothing worth saving. */
export function isBlankNote(html: string | undefined): boolean {
  return noteExcerpt(html, Infinity).length === 0;
}

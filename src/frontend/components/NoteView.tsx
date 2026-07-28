import { Typography } from "@mantine/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { noteExtensions } from "../lib/notes.ts";

/**
 * A stored note, rendered read-only. Content is re-parsed through the editor
 * schema rather than injected as HTML, so only known nodes and marks survive —
 * the same boundary that constrains what can be written constrains what can be
 * displayed, with no sanitizer and no dangerouslySetInnerHTML. See
 * docs/rich-notes-spec.md §8.
 *
 * Lives apart from NoteEditor so the read-only views — student page, past-notes
 * list — don't pull the writing surface in behind them.
 */
export function ReadOnlyNote({ html }: { html: string }) {
  const editor = useEditor({ extensions: noteExtensions, content: html, editable: false });
  if (!editor) return null;
  return (
    <Typography p={0}>
      <EditorContent editor={editor} />
    </Typography>
  );
}

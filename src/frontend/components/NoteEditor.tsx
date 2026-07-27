import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActionIcon,
  Box,
  Button,
  Flex,
  Group,
  Modal,
  Stack,
  Text,
  Tooltip,
  Typography,
} from "@mantine/core";
import { RichTextEditor } from "@mantine/tiptap";
import { EditorContent, useEditor } from "@tiptap/react";
import { IconArrowsDiagonal, IconArrowsDiagonalMinimize2 } from "@tabler/icons-react";
import { useStore } from "../store.tsx";
import { categoryName } from "../lib/aggregate.ts";
import { fmtDayLabel, fmtFullDate } from "../lib/time.ts";
import { noteExtensions, noteExcerpt, SubmitShortcut } from "../lib/notes.ts";

/**
 * A previous note, rendered read-only. Content is re-parsed through the editor
 * schema rather than injected as HTML, so only known nodes and marks survive.
 * Mounted lazily — one editor instance per note the clinician actually opens.
 */
function ReadOnlyNote({ html }: { html: string }) {
  const editor = useEditor({ extensions: noteExtensions, content: html, editable: false });
  if (!editor) return null;
  return (
    <Typography p={0}>
      <EditorContent editor={editor} />
    </Typography>
  );
}

/**
 * Earlier notes for the same students — the reason the expanded view exists.
 * Writing today's note while reading the last few is the actual workflow.
 */
function PastNotes({
  studentIds,
  excludeEntryId,
}: {
  studentIds: string[];
  excludeEntryId: string | null;
}) {
  const { doc } = useStore();
  const [openId, setOpenId] = useState<string | null>(null);

  const items = useMemo(
    () =>
      doc.entries
        .filter(
          (e) =>
            e.id !== excludeEntryId &&
            !!e.note &&
            e.studentIds.some((id) => studentIds.includes(id)),
        )
        .sort(
          (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt),
        )
        .slice(0, 12),
    [doc.entries, studentIds, excludeEntryId],
  );

  if (studentIds.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        Pick a student to see their earlier notes here.
      </Text>
    );
  }
  if (items.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        No earlier notes for {studentIds.length > 1 ? "these students" : "this student"} yet.
      </Text>
    );
  }

  return (
    <Stack gap={0}>
      {items.map((e) => {
        const open = openId === e.id;
        return (
          <Box
            key={e.id}
            py="xs"
            style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
          >
            <Group
              gap="xs"
              wrap="nowrap"
              align="baseline"
              style={{ cursor: "pointer" }}
              onClick={() => setOpenId(open ? null : e.id)}
            >
              <Text size="xs" c="dimmed" w={52} style={{ flex: "none" }}>
                {fmtDayLabel(e.date)}
              </Text>
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Text size="xs" c="dimmed">
                  {categoryName(doc, e.categoryId)}
                </Text>
                {!open && (
                  <Text size="sm" truncate>
                    {noteExcerpt(e.note)}
                  </Text>
                )}
              </Box>
            </Group>
            {open && (
              <Box mt={4} pl={60} className="note-body">
                <ReadOnlyNote html={e.note!} />
              </Box>
            )}
          </Box>
        );
      })}
    </Stack>
  );
}

export function NoteEditor({
  value,
  onChange,
  onSubmit,
  canSubmit,
  submitLabel,
  studentIds,
  editingId,
  date,
}: {
  value: string;
  onChange: (html: string) => void;
  /** Returns false when the entry was incomplete and nothing was saved. */
  onSubmit: () => boolean;
  canSubmit: boolean;
  submitLabel: string;
  studentIds: string[];
  editingId: string | null;
  date: string;
}) {
  const { doc } = useStore();
  const [expanded, setExpanded] = useState(false);

  // Read through a ref so the shortcut, configured once, never sees a stale submit.
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;

  /** Collapse only on a save that actually happened, so nothing is written out of sight. */
  const submitAndCollapse = () => {
    if (submitRef.current()) setExpanded(false);
  };

  const editor = useEditor({
    extensions: [
      ...noteExtensions,
      SubmitShortcut.configure({ onSubmit: submitAndCollapse }),
    ],
    content: value,
    onUpdate: ({ editor }) => onChange(editor.isEmpty ? "" : editor.getHTML()),
  });

  // Pull in changes that came from outside the editor — starting an edit, or
  // the form resetting after a submit.
  useEffect(() => {
    if (!editor) return;
    const current = editor.isEmpty ? "" : editor.getHTML();
    if (value !== current) editor.commands.setContent(value || "", { emitUpdate: false });
  }, [value, editor]);

  const names = studentIds
    .map((id) => doc.students.find((s) => s.id === id)?.name)
    .filter(Boolean)
    .join(", ");

  /**
   * One editor instance, rendered either inline or inside the modal — never
   * both, so the ProseMirror DOM node has a single parent and undo history
   * survives expanding.
   */
  const surface = (
    <RichTextEditor
      editor={editor}
      /* Expanded, the editor is a flex child that has to fill the modal column
         so the writing surface uses the height rather than the toolbar floating
         above a short box. */
      style={
        expanded
          ? { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }
          : undefined
      }
    >
      <RichTextEditor.Toolbar>
        <RichTextEditor.ControlsGroup>
          <RichTextEditor.Bold />
          <RichTextEditor.Italic />
          <RichTextEditor.Underline />
        </RichTextEditor.ControlsGroup>
        <RichTextEditor.ControlsGroup>
          <RichTextEditor.BulletList />
          <RichTextEditor.OrderedList />
        </RichTextEditor.ControlsGroup>
        {expanded && (
          <>
            <RichTextEditor.ControlsGroup>
              <RichTextEditor.H3 />
              <RichTextEditor.H4 />
              <RichTextEditor.Blockquote />
            </RichTextEditor.ControlsGroup>
            <RichTextEditor.ControlsGroup>
              <RichTextEditor.ClearFormatting />
              <RichTextEditor.Undo />
              <RichTextEditor.Redo />
            </RichTextEditor.ControlsGroup>
          </>
        )}
      </RichTextEditor.Toolbar>
      <RichTextEditor.Content
        className="note-body note-surface"
        mih={expanded ? undefined : 96}
        mah={expanded ? undefined : 300}
        style={
          expanded
            ? { flex: 1, minHeight: 0, overflowY: "auto" }
            : { overflowY: "auto" }
        }
      />
    </RichTextEditor>
  );

  return (
    <Box>
      <Group justify="space-between" align="center" mb={4} wrap="nowrap">
        <Text component="label" size="sm" fw={500}>
          Note{" "}
          <Text span size="xs" c="dimmed" fw={400}>
            Optional
          </Text>
        </Text>
        <Tooltip label="Expand for a full editor and past notes">
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label="Expand note editor"
            onClick={() => setExpanded(true)}
          >
            <IconArrowsDiagonal size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>

      {!expanded && surface}

      <Modal
        opened={expanded}
        onClose={() => setExpanded(false)}
        size="85%"
        padding="md"
        title={
          <Group gap="xs" wrap="nowrap">
            <Text fw={600} size="sm">
              {names || "Note"}
            </Text>
            <Text size="sm" c="dimmed">
              {fmtFullDate(date)}
            </Text>
          </Group>
        }
        /* A fixed tall shell so the two columns can share the height and scroll
           independently, rather than the modal growing with the note. */
        styles={{
          content: { height: "85vh", display: "flex", flexDirection: "column" },
          body: {
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            gap: "var(--mantine-spacing-md)",
          },
        }}
      >
        <Flex gap="md" align="stretch" style={{ flex: 1, minHeight: 0 }}>
          <Box style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            {expanded && surface}
          </Box>

          {/* Reading the last few notes while writing today's is the whole point
              of the expanded view, so they sit alongside rather than below. */}
          <Stack gap={4} w={340} style={{ minHeight: 0 }}>
            <Text size="sm" fw={500}>
              Past notes
            </Text>
            <Box style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
              <PastNotes studentIds={studentIds} excludeEntryId={editingId} />
            </Box>
          </Stack>
        </Flex>

        <Group gap="xs" justify="space-between">
          <Button
            variant="default"
            leftSection={<IconArrowsDiagonalMinimize2 size={16} />}
            onClick={() => setExpanded(false)}
          >
            Collapse
          </Button>
          <Group gap="xs">
            <Text size="xs" c="dimmed">
              ⌘↵
            </Text>
            <Button disabled={!canSubmit} onClick={submitAndCollapse}>
              {submitLabel}
            </Button>
          </Group>
        </Group>
      </Modal>
    </Box>
  );
}

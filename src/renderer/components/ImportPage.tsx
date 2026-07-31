/**
 * The import workbench — LLM-1 (docs/local-llm.md §4).
 *
 * A year of a student's sessions lives in a Google Doc, and the alternative to
 * this page is typing them into the log one at a time. So the job is not to be
 * clever: it is to turn "fill in a form" into "glance at a row", forty times,
 * without ever letting something wrong through unseen.
 *
 * Three things shape everything below.
 *
 * **Nothing is committed without review.** Every row starts unconfirmed, and
 * only confirmed rows are written. There is no "import all" — the button
 * commits what she has looked at, and the count on it says how many that is.
 *
 * **The model is not required and is not here.** Every field on this page is
 * filled by the deterministic parser and the phrase mapping table. LLM-2 adds
 * suggestions into the same slots; if it never arrives, or is switched off,
 * nothing on this page changes shape. That is the whole point of the design.
 *
 * **Corrections go back through the parser.** Merging and splitting entries
 * does not edit an array of chunks in the UI — it toggles a line number and
 * re-runs `parseImport`. One piece of code decides where entries begin, and it
 * is the one with the tests.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Text,
  Textarea,
  Title,
  Tooltip,
} from "@mantine/core";
import { DatePickerInput, TimeInput } from "@mantine/dates";
import { RichTextEditor } from "@mantine/tiptap";
import { useEditor } from "@tiptap/react";
import {
  IconAlertTriangle,
  IconCheck,
  IconClock,
  IconCopyMinus,
  IconFileImport,
  IconScissors,
} from "@tabler/icons-react";
import { useStore } from "../store.tsx";
import type { Category, ImportMappings } from "../../shared/types.ts";
import type { ParsedEntry } from "../../shared/import/types.ts";
import { parseImport } from "../../shared/import/parse.ts";
import { normalizePhrase, resolvePhrase } from "../../shared/import/phrases.ts";
import { isBlankNote, noteExtensions } from "../lib/notes.ts";
import { fmtDuration, fmtFullDate } from "../lib/time.ts";
import { navigate } from "../lib/router.tsx";
import { ReadOnlyNote } from "./NoteView.tsx";

/** What a person changed about one row. Absent keys mean "as parsed". */
interface RowEdit {
  date?: string;
  startTime?: string;
  minutes?: number;
  categoryId?: string;
  note?: string;
}

/**
 * Edits and confirmations are keyed by the chunk's **first line number**, not
 * by its id.
 *
 * Chunk ids are positional (`c1`, `c2`…), so merging two entries renumbers
 * every row after it and her edits would land on the wrong ones. A start line
 * is stable under exactly the operations that renumber ids, which makes it the
 * only honest key here.
 */
type ByLine<T> = Record<number, T>;

type RowStatus = "ready" | "check" | "incomplete";

export function ImportPage() {
  const { doc, addEntries, setImportMappings } = useStore();

  const categories = useMemo(() => doc.categories.filter((c) => !c.archived), [doc.categories]);
  const [studentId, setStudentId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const [forced, setForced] = useState<number[]>([]);
  const [suppressed, setSuppressed] = useState<number[]>([]);
  const [edits, setEdits] = useState<ByLine<RowEdit>>({});
  const [confirmed, setConfirmed] = useState<ByLine<true>>({});
  const [mappings, setMappings] = useState<ImportMappings>({});
  /** Per-phrase duration for rows whose header never said one. */
  const [phraseMinutes, setPhraseMinutes] = useState<Record<string, number>>({});
  const [editingNote, setEditingNote] = useState<number | null>(null);
  const [justCommitted, setJustCommitted] = useState<number | null>(null);

  const parsed = useMemo(
    () =>
      source
        ? parseImport(source, {
            schoolYearStartMonth: doc.settings.schoolYearStartMonth,
            forcedBoundaries: forced,
            suppressedBoundaries: suppressed,
          })
        : null,
    [source, forced, suppressed, doc.settings.schoolYearStartMonth],
  );

  const student = doc.students.find((s) => s.id === studentId) ?? null;

  const read = () => {
    setSource(text);
    setForced([]);
    setSuppressed([]);
    setEdits({});
    setConfirmed({});
    setPhraseMinutes({});
    setJustCommitted(null);
    setMappings({ ...doc.importMappings });
  };

  const startOver = () => {
    setSource("");
    setText("");
    setJustCommitted(null);
  };

  /** The category a row lands in: her override, else the mapping table. */
  const categoryFor = useCallback(
    (entry: ParsedEntry, edit: RowEdit): Category | null => {
      if (edit.categoryId) return categories.find((c) => c.id === edit.categoryId) ?? null;
      if (!entry.typePhrase) return null;
      const hit = resolvePhrase(entry.typePhrase, mappings, categories);
      return hit ? (categories.find((c) => c.id === hit.categoryId) ?? null) : null;
    },
    [categories, mappings],
  );

  const minutesFor = useCallback(
    (entry: ParsedEntry, edit: RowEdit, category: Category | null): number => {
      // An untimed category stores zero however long the header said it was.
      // Consistent with the log form, and the reason a wrong duration on a
      // no-show costs nothing.
      if (category?.untimed) return 0;
      if (edit.minutes !== undefined) return edit.minutes;
      if (entry.flags.includes("assumed-duration") && entry.typePhrase) {
        const preset = phraseMinutes[normalizePhrase(entry.typePhrase)];
        if (preset) return preset;
      }
      return entry.minutes;
    },
    [phraseMinutes],
  );

  const rows = useMemo(() => {
    if (!parsed) return [];
    return parsed.entries.map((entry) => {
      const line = entry.chunk.startLine;
      const edit = edits[line] ?? {};
      const category = categoryFor(entry, edit);
      const minutes = minutesFor(entry, edit, category);
      const date = edit.date ?? entry.date;
      const note = edit.note ?? entry.note;

      /**
       * A flag stops mattering once she has answered the question it was
       * asking. Leaving them all lit would mean a row she has fully corrected
       * still nags, and a grid where everything is flagged is a grid where
       * nothing is.
       */
      const unresolved = entry.flags.filter((flag) => {
        if (flag === "no-type-phrase") return edit.categoryId === undefined;
        if (flag === "assumed-duration" || flag === "no-time" || flag === "implausible-range") {
          return edit.minutes === undefined && !(category?.untimed ?? false);
        }
        return true;
      });

      const status: RowStatus =
        !date || !category || (!category.untimed && minutes <= 0)
          ? "incomplete"
          : unresolved.length > 0
            ? "check"
            : "ready";

      const duplicate =
        !!studentId &&
        !!date &&
        !!category &&
        doc.entries.some(
          (e) =>
            e.date === date && e.categoryId === category.id && e.studentIds.includes(studentId),
        );

      return { entry, line, edit, category, minutes, date, note, unresolved, status, duplicate };
    });
  }, [parsed, edits, categoryFor, minutesFor, studentId, doc.entries]);

  const ready = rows.filter((r) => confirmed[r.line] && r.status !== "incomplete");

  const patch = (line: number, next: RowEdit) =>
    setEdits((was) => ({ ...was, [line]: { ...was[line], ...next } }));

  const toggleConfirm = (line: number) =>
    setConfirmed((was) => {
      const next = { ...was };
      if (next[line]) delete next[line];
      else next[line] = true;
      return next;
    });

  const commit = useCallback(() => {
    if (!studentId || ready.length === 0) return;
    addEntries(
      ready.map((r) => ({
        date: r.date!,
        minutes: r.minutes,
        categoryId: r.category!.id,
        studentIds: [studentId],
        startTime: r.entry.startTime ?? null,
        // "<p></p>" is a non-empty string but an empty note.
        note: isBlankNote(r.note) ? undefined : r.note,
      })),
    );
    /**
     * Her mapping decisions outlive the import that produced them — that is the
     * entire reason categorising is one decision per phrase and not per entry.
     *
     * Every phrase a committed row actually relied on is recorded, not just the
     * ones she picked from the dropdown herself. Accepting this page's
     * suggestion by confirming the row is a decision too, and leaving those
     * unrecorded would ask her the same question again on the next document —
     * which is precisely the cost this table exists to remove.
     *
     * A row where she overrode the category is skipped: that is a statement
     * about one entry, not about what the phrase means, and promoting it would
     * silently re-file every later entry that shares the label.
     */
    const decided: ImportMappings = { ...mappings };
    for (const row of ready) {
      if (!row.entry.typePhrase || !row.category || row.edit.categoryId) continue;
      decided[normalizePhrase(row.entry.typePhrase)] = row.category.id;
    }
    setImportMappings(decided);
    setJustCommitted(ready.length);
    setSource("");
    setText("");
  }, [studentId, ready, addEntries, setImportMappings, mappings]);

  // ⌘↵ commits, matching the log form's shortcut for the same intent.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        commit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commit]);

  if (justCommitted !== null) {
    return (
      <Card>
        <Stack gap="md">
          <Alert color="teal" icon={<IconCheck size={18} />} title="Imported">
            {justCommitted} {justCommitted === 1 ? "entry" : "entries"} added
            {student ? ` for ${student.name}` : ""}. They are ordinary entries now — edit or delete
            them from the log like any other.
          </Alert>
          <Group>
            <Button variant="default" onClick={() => setJustCommitted(null)}>
              Import another document
            </Button>
            {student && (
              <Button variant="subtle" onClick={() => navigate(`/students/${student.id}`)}>
                See {student.name}
              </Button>
            )}
          </Group>
        </Stack>
      </Card>
    );
  }

  if (!parsed) {
    return (
      <PastePane
        students={doc.students}
        studentId={studentId}
        onStudent={setStudentId}
        text={text}
        onText={setText}
        onRead={read}
      />
    );
  }

  const undecided = parsed.phrases.filter(
    (use) => !resolvePhrase(use.phrase, mappings, categories),
  );

  return (
    <Stack gap="md">
      <Card>
        <Group justify="space-between" wrap="nowrap" align="flex-end">
          <Box style={{ minWidth: 0 }}>
            <Title order={4}>
              {parsed.entries.length} {parsed.entries.length === 1 ? "entry" : "entries"}
              {student ? ` for ${student.name}` : ""}
            </Title>
            <Text size="sm" c="dimmed">
              Check each row, then confirm it. Only confirmed rows are imported.
            </Text>
          </Box>
          <Group gap="xs" wrap="nowrap" style={{ flex: "none" }} align="flex-end">
            {/* Stays here for the whole review, not just on the paste screen.
                Reading the document first and choosing the student afterwards is
                a reasonable way to work — and without this the commit button
                says "pick a student" while offering nowhere to pick one. */}
            <StudentSelect
              students={doc.students}
              studentId={studentId}
              onStudent={setStudentId}
              w={220}
              size="xs"
            />
            <Button variant="subtle" color="gray" onClick={startOver}>
              Start over
            </Button>
          </Group>
        </Group>
        {parsed.preamble && (
          <Alert mt="sm" variant="light" color="gray" title="Text above the first entry">
            <Text size="xs" style={{ whiteSpace: "pre-wrap" }}>
              {parsed.preamble}
            </Text>
            <Text size="xs" c="dimmed" mt={4}>
              Not imported — it is not part of any entry. Shown so nothing goes missing quietly.
            </Text>
          </Alert>
        )}
      </Card>

      <MappingCard
        phrases={parsed.phrases}
        undecided={undecided.length}
        categories={categories}
        mappings={mappings}
        onMap={(key, categoryId) =>
          setMappings((was) => {
            const next = { ...was };
            if (categoryId) next[key] = categoryId;
            else delete next[key];
            return next;
          })
        }
        phraseMinutes={phraseMinutes}
        onPhraseMinutes={(key, minutes) => setPhraseMinutes((was) => ({ ...was, [key]: minutes }))}
        assumedByPhrase={countAssumed(parsed.entries)}
      />

      <Card p={0}>
        {rows.map((row, i) => (
          <ReviewRow
            key={row.line}
            row={row}
            first={i === 0}
            categories={categories}
            confirmed={!!confirmed[row.line]}
            onConfirm={() => toggleConfirm(row.line)}
            onPatch={(next) => patch(row.line, next)}
            onEditNote={() => setEditingNote(row.line)}
            onMerge={() => setSuppressed((was) => [...was, row.line])}
            onSplit={(absoluteLine) => setForced((was) => [...was, absoluteLine])}
          />
        ))}
      </Card>

      <Card style={{ position: "sticky", bottom: 0, zIndex: 2 }} className="no-print">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs">
            <Badge color="teal" variant="light">
              {rows.filter((r) => r.status === "ready").length} ready
            </Badge>
            <Badge color="ember" variant="light">
              {rows.filter((r) => r.status === "check").length} to check
            </Badge>
            <Badge color="gray" variant="light">
              {rows.filter((r) => r.status === "incomplete").length} incomplete
            </Badge>
          </Group>
          <Group gap="xs" wrap="nowrap">
            {!studentId && (
              <Text size="sm" c="dimmed">
                Pick a student before importing
              </Text>
            )}
            <Button
              leftSection={<IconFileImport size={16} />}
              disabled={!studentId || ready.length === 0}
              onClick={commit}
            >
              Import {ready.length} confirmed
            </Button>
          </Group>
        </Group>
      </Card>

      <NoteModal
        opened={editingNote !== null}
        html={rows.find((r) => r.line === editingNote)?.note ?? ""}
        onClose={() => setEditingNote(null)}
        onSave={(html) => {
          if (editingNote !== null) patch(editingNote, { note: html });
          setEditingNote(null);
        }}
      />
    </Stack>
  );
}

/** How many rows using each phrase never said how long they were. */
function countAssumed(entries: readonly ParsedEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    if (!entry.typePhrase || !entry.flags.includes("assumed-duration")) continue;
    const key = normalizePhrase(entry.typePhrase);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/* ---------- step one: what to import, and for whom ---------- */

function PastePane({
  students,
  studentId,
  onStudent,
  text,
  onText,
  onRead,
}: {
  students: { id: string; name: string; active: boolean }[];
  studentId: string | null;
  onStudent: (id: string | null) => void;
  text: string;
  onText: (t: string) => void;
  onRead: () => void;
}) {
  return (
    <Card>
      <Stack gap="md">
        <Box>
          <Title order={4}>Import from a document</Title>
          <Text size="sm" c="dimmed">
            In Google Docs, File → Download → Plain text, or just select the whole document and copy
            it. Paste it below. Nothing is saved until you review it.
          </Text>
        </Box>

        <StudentSelect
          students={students}
          studentId={studentId}
          onStudent={onStudent}
          w={320}
          label="Whose document is this?"
          description="One document per student — every entry here will be filed under them."
        />

        <Textarea
          label="Paste the document"
          placeholder={"9/25/2025 @ 11:45-12:00 Requested Session\nStudent emailed and requested…"}
          value={text}
          onChange={(e) => onText(e.currentTarget.value)}
          autosize
          minRows={12}
          maxRows={24}
          styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)", fontSize: 12 } }}
        />

        <Group>
          <Button disabled={!text.trim()} onClick={onRead}>
            Read the document
          </Button>
          <Text size="xs" c="dimmed">
            You can pick the student afterwards — the chooser stays with you through the review.
          </Text>
        </Group>
      </Stack>
    </Card>
  );
}

/**
 * Whose document this is. Present on both screens, because the answer can be
 * changed right up until the moment the entries are written and there is no
 * point at which it stops being editable.
 */
function StudentSelect({
  students,
  studentId,
  onStudent,
  w,
  size,
  label,
  description,
}: {
  students: { id: string; name: string; active: boolean }[];
  studentId: string | null;
  onStudent: (id: string | null) => void;
  w: number;
  size?: string;
  label?: string;
  description?: string;
}) {
  const options = students
    .filter((s) => s.active)
    .map((s) => ({ value: s.id, label: s.name }))
    .toSorted((a, b) => a.label.localeCompare(b.label));

  return (
    <Select
      label={label}
      description={description}
      placeholder="Pick a student"
      data={options}
      value={studentId}
      onChange={onStudent}
      searchable
      w={w}
      size={size}
      error={!studentId}
    />
  );
}

/* ---------- step two: one decision per phrase ---------- */

function MappingCard({
  phrases,
  undecided,
  categories,
  mappings,
  onMap,
  phraseMinutes,
  onPhraseMinutes,
  assumedByPhrase,
}: {
  phrases: { phrase: string; key: string; count: number }[];
  undecided: number;
  categories: Category[];
  mappings: ImportMappings;
  onMap: (key: string, categoryId: string | null) => void;
  phraseMinutes: Record<string, number>;
  onPhraseMinutes: (key: string, minutes: number) => void;
  assumedByPhrase: Record<string, number>;
}) {
  if (phrases.length === 0) return null;
  const options = categories.map((c) => ({ value: c.id, label: c.name }));

  return (
    <Card>
      <Group justify="space-between" mb="xs">
        <Box>
          <Title order={5}>What her labels mean</Title>
          <Text size="sm" c="dimmed">
            Decided once and remembered. The next document you import will already know these.
          </Text>
        </Box>
        {undecided > 0 && (
          <Badge color="ember" variant="light">
            {undecided} still to decide
          </Badge>
        )}
      </Group>

      <Stack gap="xs">
        {phrases.map((use) => {
          const hit = resolvePhrase(use.phrase, mappings, categories);
          // An exact decision scores 1. Anything less is this page's guess, and
          // it is shown as a guess rather than silently accepted.
          const guessed = !!hit && hit.score < 1;
          const assumed = assumedByPhrase[use.key] ?? 0;
          return (
            <Group key={use.key} gap="xs" wrap="nowrap" align="flex-end">
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Text size="sm" fw={500} truncate>
                  {use.phrase}
                </Text>
                <Text size="xs" c="dimmed">
                  {use.count} {use.count === 1 ? "entry" : "entries"}
                  {guessed ? " · suggested from the name, check it" : ""}
                </Text>
              </Box>
              <Select
                size="xs"
                w={230}
                placeholder="Choose a category"
                data={options}
                value={hit?.categoryId ?? null}
                onChange={(v) => onMap(use.key, v)}
                error={!hit}
                style={{ flex: "none" }}
              />
              {assumed > 0 && (
                <Tooltip
                  label={`${assumed} of these never said how long they were. Set a length for all of them.`}
                >
                  <NumberInput
                    size="xs"
                    w={110}
                    min={0}
                    suffix=" min"
                    placeholder="length"
                    value={phraseMinutes[use.key] ?? ""}
                    onChange={(v) => onPhraseMinutes(use.key, Number(v) || 0)}
                    style={{ flex: "none" }}
                  />
                </Tooltip>
              )}
            </Group>
          );
        })}
      </Stack>
    </Card>
  );
}

/* ---------- step three: the grid where correctness comes from ---------- */

const STATUS_COLOR: Record<RowStatus, string> = {
  ready: "teal",
  check: "ember",
  incomplete: "gray",
};

interface Row {
  entry: ParsedEntry;
  line: number;
  edit: RowEdit;
  category: Category | null;
  minutes: number;
  date: string | null;
  note: string;
  unresolved: string[];
  status: RowStatus;
  duplicate: boolean;
}

function ReviewRow({
  row,
  first,
  categories,
  confirmed,
  onConfirm,
  onPatch,
  onEditNote,
  onMerge,
  onSplit,
}: {
  row: Row;
  first: boolean;
  categories: Category[];
  confirmed: boolean;
  onConfirm: () => void;
  onPatch: (next: RowEdit) => void;
  onEditNote: () => void;
  onMerge: () => void;
  onSplit: (absoluteLine: number) => void;
}) {
  const { entry, category, minutes, date, note, status, duplicate } = row;
  const border = { borderTop: "1px solid var(--mantine-color-default-border)" };

  if (confirmed) {
    return (
      <Group gap="xs" wrap="nowrap" px="md" py={6} style={border}>
        <IconCheck size={16} color="var(--mantine-color-teal-6)" style={{ flex: "none" }} />
        <Text size="sm" style={{ flex: "none" }} className="tnum">
          {date ? fmtFullDate(date) : "no date"}
        </Text>
        <Text size="sm" c="dimmed" truncate style={{ flex: 1, minWidth: 0 }}>
          {category?.name ?? "no category"} · {fmtDuration(minutes)}
        </Text>
        <Button size="compact-xs" variant="subtle" color="gray" onClick={onConfirm}>
          Undo
        </Button>
      </Group>
    );
  }

  return (
    <Box px="md" py="sm" style={border}>
      <Group align="flex-start" wrap="nowrap" gap="md">
        {/* The source, with every line a place to cut. Clicking the first line
            folds this entry into the one above; clicking any other starts a new
            entry there. Both go back through the parser. */}
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Group gap={6} mb={4}>
            <Badge size="xs" color={STATUS_COLOR[status]} variant="light">
              {status}
            </Badge>
            {row.unresolved.map((flag) => (
              <Badge key={flag} size="xs" variant="outline" color="gray">
                {FLAG_LABEL[flag] ?? flag}
              </Badge>
            ))}
            {duplicate && (
              <Tooltip label="An entry with this date and category already exists for this student.">
                <Badge
                  size="xs"
                  color="red"
                  variant="light"
                  leftSection={<IconAlertTriangle size={11} />}
                >
                  possible duplicate
                </Badge>
              </Tooltip>
            )}
          </Group>
          <Box
            style={{
              fontFamily: "var(--mantine-font-family-monospace)",
              fontSize: 11,
              maxHeight: 190,
              overflowY: "auto",
            }}
          >
            {entry.chunk.text.split("\n").map((sourceLine, offset) => {
              const absolute = entry.chunk.startLine + offset;
              const isHeader = offset === 0;
              const canMerge = isHeader && !first;
              const canSplit = !isHeader && sourceLine.trim().length > 0;
              const label = canMerge
                ? "Join this entry onto the one above"
                : canSplit
                  ? "Start a new entry at this line"
                  : "";
              return (
                <Group key={absolute} gap={4} wrap="nowrap" align="flex-start">
                  <Box w={18} style={{ flex: "none" }}>
                    {(canMerge || canSplit) && (
                      <Tooltip label={label} openDelay={400}>
                        <ActionIcon
                          size={16}
                          variant="subtle"
                          color="gray"
                          aria-label={label}
                          onClick={() => (canMerge ? onMerge() : onSplit(absolute))}
                        >
                          {canMerge ? <IconCopyMinus size={12} /> : <IconScissors size={12} />}
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </Box>
                  <Text
                    size="xs"
                    ff="monospace"
                    fw={isHeader ? 600 : 400}
                    c={isHeader ? undefined : "dimmed"}
                    style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", flex: 1 }}
                  >
                    {sourceLine || " "}
                  </Text>
                </Group>
              );
            })}
          </Box>
        </Box>

        {/* What will actually be written. */}
        <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
          <Group gap="xs" wrap="nowrap" align="flex-end">
            <DatePickerInput
              size="xs"
              label="Date"
              value={date}
              onChange={(v) => onPatch({ date: v ?? undefined })}
              error={!date}
              style={{ flex: 1, minWidth: 0 }}
            />
            <TimeInput
              size="xs"
              label="Time"
              leftSection={<IconClock size={13} />}
              value={row.edit.startTime ?? entry.startTime ?? ""}
              onChange={(e) => onPatch({ startTime: e.currentTarget.value })}
              w={110}
              style={{ flex: "none" }}
            />
          </Group>
          <Group gap="xs" wrap="nowrap" align="flex-end">
            <Select
              size="xs"
              label="Category"
              placeholder="Choose"
              data={categories.map((c) => ({ value: c.id, label: c.name }))}
              value={category?.id ?? null}
              onChange={(v) => onPatch({ categoryId: v ?? undefined })}
              error={!category}
              style={{ flex: 1, minWidth: 0 }}
            />
            <NumberInput
              size="xs"
              label="Minutes"
              min={0}
              value={minutes}
              onChange={(v) => onPatch({ minutes: Number(v) || 0 })}
              disabled={category?.untimed ?? false}
              description={category?.untimed ? "untimed" : undefined}
              w={100}
              style={{ flex: "none" }}
            />
          </Group>

          <Box>
            <Group justify="space-between" mb={2}>
              <Text size="xs" fw={500}>
                Note
              </Text>
              <Button size="compact-xs" variant="subtle" onClick={onEditNote}>
                Edit
              </Button>
            </Group>
            <Box
              style={{
                maxHeight: 90,
                overflowY: "auto",
                border: "1px solid var(--mantine-color-default-border)",
                borderRadius: 4,
                padding: "4px 8px",
              }}
            >
              {isBlankNote(note) ? (
                <Text size="xs" c="dimmed">
                  No note
                </Text>
              ) : (
                <ReadOnlyNote html={note} />
              )}
            </Box>
          </Box>

          <Group justify="flex-end">
            <Button
              size="xs"
              variant={status === "incomplete" ? "default" : "light"}
              disabled={status === "incomplete"}
              leftSection={<IconCheck size={14} />}
              onClick={onConfirm}
            >
              {status === "incomplete" ? "Fill in what's missing" : "Confirm"}
            </Button>
          </Group>
        </Stack>
      </Group>
    </Box>
  );
}

const FLAG_LABEL: Record<string, string> = {
  "weak-header": "check the split",
  "assumed-duration": "length assumed",
  "no-time": "no time given",
  "implausible-range": "times don't add up",
  "no-type-phrase": "no label to go on",
};

/* ---------- the note editor, minus the log form it usually lives in ---------- */

function NoteModal({
  opened,
  html,
  onClose,
  onSave,
}: {
  opened: boolean;
  html: string;
  onClose: () => void;
  onSave: (html: string) => void;
}) {
  const editor = useEditor({ extensions: noteExtensions, content: html }, [opened]);

  return (
    <Modal opened={opened} onClose={onClose} title="Edit note" size="lg" centered>
      <Stack gap="sm">
        <RichTextEditor editor={editor}>
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
          </RichTextEditor.Toolbar>
          <RichTextEditor.Content className="note-body note-surface" mih={200} mah={420} />
        </RichTextEditor>
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onSave(editor?.isEmpty ? "" : (editor?.getHTML() ?? html))}>
            Save note
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

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
  Loader,
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
  IconSparkles,
} from "@tabler/icons-react";
import { useStore } from "../store.tsx";
import type { Category, ImportMappings } from "../../shared/types.ts";
import type { ParsedEntry } from "../../shared/import/types.ts";
import { parseImport } from "../../shared/import/parse.ts";
import { normalizePhrase, resolvePhrase } from "../../shared/import/phrases.ts";
import { effectiveRows } from "../../shared/import/rows.ts";
import type { EffectiveRow, RowEdit, RowStatus } from "../../shared/import/rows.ts";
import { isBlankNote, noteExtensions } from "../lib/notes.ts";
import { api, bridgeMessage } from "../lib/api.ts";
import { fmtDuration, fmtFullDate } from "../lib/time.ts";
import { navigate } from "../lib/router.tsx";
import { ReadOnlyNote } from "./NoteView.tsx";

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

  /**
   * What the model proposed, kept apart from what she decided.
   *
   * Two separate stores rather than one merged map, because the difference has
   * to survive all the way to the badge on the row. Her decisions always win,
   * and anything still resting on a suggestion is shown as resting on one.
   */
  const [aiMappings, setAiMappings] = useState<ImportMappings>({});
  const [aiRows, setAiRows] = useState<Record<number, string>>({});
  const [aiProgress, setAiProgress] = useState<{ done: number; total: number } | null>(null);
  const [aiTrouble, setAiTrouble] = useState<string | null>(null);
  const [modelReady, setModelReady] = useState(false);

  useEffect(() => {
    api()
      .getModelStatus()
      .then((status) => setModelReady(status.state === "ready"))
      .catch(() => setModelReady(false));
    return api().onModelStatus((status) => setModelReady(status.state === "ready"));
  }, []);

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
    setAiMappings({});
    setAiRows({});
    setAiTrouble(null);
    setMappings({ ...doc.importMappings });
  };

  const startOver = () => {
    setSource("");
    setText("");
    setJustCommitted(null);
  };

  /**
   * What every row actually means, resolved once. The grid renders these and
   * `commit` writes these — see src/shared/import/rows.ts for why deriving a
   * committed value anywhere else is the bug this shape exists to prevent.
   */
  const rows = useMemo(
    () =>
      parsed
        ? effectiveRows(parsed.entries, edits, {
            categories,
            mappings,
            aiMappings,
            aiRows,
            phraseMinutes,
            studentId,
            existing: doc.entries,
          })
        : [],
    [
      parsed,
      edits,
      categories,
      mappings,
      aiMappings,
      aiRows,
      phraseMinutes,
      studentId,
      doc.entries,
    ],
  );

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

  /**
   * Ask the model for the two things the rules cannot supply: a category for a
   * phrase nobody has decided on, and a category for an entry that carries no
   * phrase at all.
   *
   * Sequential, because the inference host runs a single-job queue — firing
   * these off together would queue behind each other anyway, and the progress
   * count would be a lie. Every answer lands in a suggestion store, never in
   * her decisions, and every affected row stays in "check".
   */
  const fillGaps = async () => {
    if (!parsed) return;
    setAiTrouble(null);

    const decided = { ...aiMappings, ...mappings };
    const phrases = parsed.phrases.filter((use) => !resolvePhrase(use.phrase, decided, categories));
    const untyped = rows.filter(
      (row) => !row.entry.typePhrase && row.edit.categoryId === undefined,
    );

    const forModel = categories.map((c) => ({
      id: c.id,
      name: c.name,
      group: c.group,
      untimed: c.untimed,
    }));
    const total = phrases.length + untyped.length;
    if (total === 0) return;
    setAiProgress({ done: 0, total });

    let done = 0;
    const step = () => {
      done += 1;
      setAiProgress({ done, total });
    };

    try {
      /* eslint-disable no-await-in-loop */
      for (const use of phrases) {
        const samples = parsed.entries
          .filter((e) => e.typePhrase && normalizePhrase(e.typePhrase) === use.key)
          .map((e) => e.chunk.text);
        const result = await api().suggestCategory({
          kind: "suggest-mapping",
          phrase: use.phrase,
          samples,
          categories: forModel,
        });
        if (!("ok" in result)) {
          setAiTrouble(result.message);
          break;
        }
        if (result.value.categoryId) {
          const id = result.value.categoryId;
          setAiMappings((was) => ({ ...was, [use.key]: id }));
        }
        step();
      }

      for (const row of untyped) {
        const result = await api().suggestCategory({
          kind: "classify-entry",
          samples: [row.entry.chunk.text],
          categories: forModel,
        });
        if (!("ok" in result)) {
          setAiTrouble(result.message);
          break;
        }
        if (result.value.categoryId) {
          const id = result.value.categoryId;
          setAiRows((was) => ({ ...was, [row.line]: id }));
        }
        step();
      }
      /* eslint-enable no-await-in-loop */
    } catch (error) {
      setAiTrouble(bridgeMessage(error));
    } finally {
      setAiProgress(null);
    }
  };

  const commit = useCallback(() => {
    if (!studentId || ready.length === 0) return;
    addEntries(
      ready.map((r) => ({
        date: r.date!,
        minutes: r.minutes,
        categoryId: r.category!.id,
        studentIds: [studentId],
        startTime: r.startTime || null,
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
            {modelReady && (
              <Button
                variant="light"
                leftSection={aiProgress ? <Loader size={14} /> : <IconSparkles size={16} />}
                disabled={aiProgress !== null}
                onClick={() => void fillGaps()}
              >
                {aiProgress
                  ? `Suggesting ${aiProgress.done}/${aiProgress.total}`
                  : "Suggest the gaps"}
              </Button>
            )}
            <Button variant="subtle" color="gray" onClick={startOver}>
              Start over
            </Button>
          </Group>
        </Group>
        {aiTrouble && (
          <Alert mt="sm" color="ember" variant="light" title="The AI helper couldn't finish">
            {aiTrouble} Everything already filled in is unaffected, and the rest can be set by hand
            as usual.
          </Alert>
        )}
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
        aiMappings={aiMappings}
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
  aiMappings,
  undecided,
  categories,
  mappings,
  onMap,
  phraseMinutes,
  onPhraseMinutes,
  assumedByPhrase,
}: {
  phrases: { phrase: string; key: string; count: number }[];
  aiMappings: ImportMappings;
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
  const merged = { ...aiMappings, ...mappings };

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
          const hit = resolvePhrase(use.phrase, merged, categories);
          // Three provenances, and the difference is worth showing: she decided
          // it, the model proposed it, or this page matched it off the category
          // name. Only the first is a decision.
          const fromAi = mappings[use.key] === undefined && aiMappings[use.key] !== undefined;
          const guessed = !fromAi && !!hit && hit.score < 1;
          const assumed = assumedByPhrase[use.key] ?? 0;
          return (
            <Group key={use.key} gap="xs" wrap="nowrap" align="flex-end">
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Text size="sm" fw={500} truncate>
                  {use.phrase}
                </Text>
                <Text size="xs" c={fromAi ? "grape" : "dimmed"}>
                  {use.count} {use.count === 1 ? "entry" : "entries"}
                  {fromAi ? " · suggested by the AI helper, check it" : ""}
                  {guessed ? " · matched from the category name, check it" : ""}
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
  row: EffectiveRow;
  first: boolean;
  categories: Category[];
  confirmed: boolean;
  onConfirm: () => void;
  onPatch: (next: RowEdit) => void;
  onEditNote: () => void;
  onMerge: () => void;
  onSplit: (absoluteLine: number) => void;
}) {
  const { entry, category, minutes, date, startTime, note, status, duplicate } = row;
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
            {row.fromAi && (
              <Tooltip label="Suggested by the AI helper from the text on the left. Check it — this is the part it is least reliable at.">
                <Badge
                  size="xs"
                  color="grape"
                  variant="light"
                  leftSection={<IconSparkles size={11} />}
                >
                  AI guess
                </Badge>
              </Tooltip>
            )}
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
              value={startTime}
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

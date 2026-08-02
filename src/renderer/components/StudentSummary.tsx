/**
 * Two ways of answering "how has this student been going" — LLM-3
 * (docs/local-llm.md §5).
 *
 * They are separate components on purpose, and the order they appear in is an
 * argument. `PatternsPanel` is a query over structured entries: how often she
 * saw them, how long the quiet stretches were, how many times they did not turn
 * up. It is instant, it is always correct, and it needs no model — so it is
 * first, and it is what shows when the AI features are off.
 *
 * `NotesSummary` is the part a model is actually for: the narrative buried in
 * the notes. It is displayed beside the notes it came from, labelled, and
 * **never written anywhere**. Not to data.json, not to an export, not to a
 * report. The clinical record stays entirely human-authored, so no future
 * reader can mistake generated text for something she wrote.
 */

import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  CopyButton,
  Group,
  Loader,
  Select,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconCopy,
  IconRefresh,
  IconSparkles,
  IconCheck,
} from "@tabler/icons-react";
import type { Entry, Student } from "../../shared/types.ts";
import { useStore } from "../store.tsx";
import { htmlToText } from "../../shared/import/html.ts";
import { servicePattern } from "../lib/aggregate.ts";
import { api, bridgeMessage } from "../lib/api.ts";
import { fmtFullDate } from "../lib/time.ts";

/* ---------- the half that needs no model ---------- */

export function PatternsPanel({
  entries,
  studentId,
  rangeLabel,
}: {
  entries: Entry[];
  studentId: string;
  rangeLabel: string;
}) {
  const { doc } = useStore();
  const pattern = servicePattern(entries, doc.categories, studentId);

  if (pattern.sessions === 0 && pattern.missed === 0) return null;

  return (
    <Card>
      <Group justify="space-between" mb="xs">
        <Text fw={600} size="sm">
          Pattern of service
        </Text>
        <Text size="xs" c="dimmed">
          {rangeLabel}
        </Text>
      </Group>

      <Group gap="lg" mb={pattern.gaps.length ? "sm" : 0}>
        <Fact label="Sessions" value={String(pattern.sessions)} />
        <Fact
          label="Typically"
          value={pattern.meanDaysBetween === null ? "—" : `every ${pattern.meanDaysBetween} days`}
        />
        <Fact label="Missed or cancelled" value={String(pattern.missed)} />
        <Fact
          label="Last seen"
          value={pattern.lastSession ? fmtFullDate(pattern.lastSession) : "—"}
        />
      </Group>

      {pattern.gaps.length > 0 && (
        <Box>
          <Text size="xs" fw={500} mb={4}>
            Gaps of three weeks or more
          </Text>
          <Stack gap={2}>
            {pattern.gaps.slice(0, 4).map((gap) => (
              <Text key={`${gap.from}-${gap.to}`} size="xs" c="dimmed">
                <Text span fw={600} c="ember">
                  {gap.days} days
                </Text>{" "}
                — {fmtFullDate(gap.from)} to {fmtFullDate(gap.to)}
              </Text>
            ))}
          </Stack>
        </Box>
      )}
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" fw={600}>
        {value}
      </Text>
    </Box>
  );
}

/* ---------- the half a model is for ---------- */

const WINDOWS = [
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "year", label: "This school year" },
  { value: "all", label: "Everything shown" },
] as const;

export function NotesSummary({
  student,
  entries,
}: {
  student: Student;
  /** Already narrowed to this student and the page's range, newest first. */
  entries: Entry[];
}) {
  const { doc } = useStore();
  const [ready, setReady] = useState(false);
  const [window_, setWindow] = useState<string>("90");
  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  /**
   * The run this view is currently showing, and the text accumulated for it.
   *
   * A ref rather than state because chunks arrive many times a second and none
   * of them is a reason to re-render twice. Null means nothing on screen
   * belongs to a run any more — she has changed student or window — and every
   * chunk still in flight is now somebody else's.
   */
  const active = useRef<{ id: string; text: string } | null>(null);

  useEffect(() => {
    api()
      .getModelStatus()
      .then((status) => setReady(status.state === "ready"))
      .catch(() => setReady(false));
    return api().onModelStatus((status) => setReady(status.state === "ready"));
  }, []);

  /**
   * Subscribed for as long as this view exists, rather than for the length of
   * a run. Chunks are broadcast to every window and an abandoned job goes on
   * producing them, so the guarantee has to come from the id on each chunk —
   * and a subscription tied to a run outlives the run anyway, because the only
   * thing that ended it was `finally`.
   */
  useEffect(
    () =>
      api().onSummaryChunk((chunk) => {
        const run = active.current;
        if (!run || run.id !== chunk.requestId) return;
        run.text += chunk.text;
        setText(run.text);
      }),
    [],
  );

  // A summary describes one student over one window. Both of those changing
  // must clear it, or she is reading last student's answer under this one's
  // name — including the rest of an answer that is still arriving.
  useEffect(() => {
    active.current = null;
    setText("");
    setTrouble(null);
  }, [student.id, window_]);

  if (!ready) return null;

  const notes = selectNotes(entries, window_, doc.settings.schoolYearStartMonth);
  const label = WINDOWS.find((w) => w.value === window_)?.label ?? "";

  const run = async () => {
    const requestId = crypto.randomUUID();
    active.current = { id: requestId, text: "" };
    setRunning(true);
    setTrouble(null);
    setText("");
    try {
      const result = await api().summarizeNotes({
        requestId,
        studentName: student.name,
        windowLabel: label,
        notes,
      });
      // She may have changed student or window while this was running, in which
      // case the question on screen is no longer the one this answers. The
      // whole answer is as capable of landing under the wrong name as a chunk.
      if (active.current?.id !== requestId) return;
      if ("ok" in result) setText(result.value);
      else setTrouble(result.message);
    } catch (error) {
      if (active.current?.id === requestId) setTrouble(bridgeMessage(error));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card>
      <Group justify="space-between" mb="xs" wrap="nowrap">
        <Group gap={8}>
          <IconSparkles size={16} />
          <Text fw={600} size="sm">
            Summarise notes
          </Text>
          <Badge size="xs" color="grape" variant="light">
            AI-generated
          </Badge>
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Select
            size="xs"
            w={150}
            data={[...WINDOWS]}
            value={window_}
            onChange={(v) => setWindow(v ?? "90")}
            allowDeselect={false}
          />
          <Button
            size="compact-sm"
            variant="light"
            leftSection={
              running ? (
                <Loader size={12} />
              ) : text ? (
                <IconRefresh size={14} />
              ) : (
                <IconSparkles size={14} />
              )
            }
            disabled={running || notes.length === 0}
            onClick={() => void run()}
          >
            {running ? "Reading…" : text ? "Again" : "Summarise"}
          </Button>
        </Group>
      </Group>

      {notes.length === 0 ? (
        <Text size="xs" c="dimmed">
          No notes in this window to summarise.
        </Text>
      ) : (
        <Text size="xs" c="dimmed" mb={text || running ? "xs" : 0}>
          {notes.length} {notes.length === 1 ? "note" : "notes"}, {label.toLowerCase()}. Written by
          a model running on this Mac; nothing leaves it.
        </Text>
      )}

      {trouble && (
        <Alert color="ember" variant="light" icon={<IconAlertTriangle size={16} />}>
          {trouble}
        </Alert>
      )}

      {(text || running) && (
        <Box>
          <Box
            className="note-body"
            style={{
              whiteSpace: "pre-wrap",
              fontSize: "var(--mantine-font-size-sm)",
              borderLeft: "3px solid var(--mantine-color-grape-4)",
              paddingLeft: 12,
            }}
          >
            {text}
            {running && !text && (
              <Text size="sm" c="dimmed">
                Reading the notes…
              </Text>
            )}
          </Box>
          {!running && text && (
            <Group justify="space-between" mt="xs">
              <Text size="xs" c="dimmed">
                Check the dates against the notes below. This is not saved anywhere and never
                becomes part of the record.
              </Text>
              <CopyButton value={text}>
                {({ copied, copy }) => (
                  <Tooltip label={copied ? "Copied" : "Copy"}>
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color={copied ? "teal" : "gray"}
                      leftSection={copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
                      onClick={copy}
                    >
                      Copy
                    </Button>
                  </Tooltip>
                )}
              </CopyButton>
            </Group>
          )}
        </Box>
      )}
    </Card>
  );
}

/**
 * The notes the model will see: oldest first, stripped to dated plain text.
 *
 * Oldest first matters. A summary that reads the term backwards describes
 * improvement as decline, and nothing in the prompt would catch it.
 */
function selectNotes(
  entries: Entry[],
  window_: string,
  schoolYearStartMonth: number,
): { date: string; text: string }[] {
  const from = windowStart(window_, schoolYearStartMonth);
  return entries
    .filter((e) => !!e.note && e.date >= from)
    .map((e) => ({ date: e.date, text: htmlToText(e.note!) }))
    .filter((n) => n.text.length > 0)
    .toSorted((a, b) => a.date.localeCompare(b.date));
}

function windowStart(window_: string, schoolYearStartMonth: number): string {
  if (window_ === "all") return "0000-01-01";
  if (window_ === "year") {
    const now = new Date();
    const year =
      now.getMonth() + 1 >= schoolYearStartMonth ? now.getFullYear() : now.getFullYear() - 1;
    return `${year}-${String(schoolYearStartMonth).padStart(2, "0")}-01`;
  }
  const days = Number(window_);
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

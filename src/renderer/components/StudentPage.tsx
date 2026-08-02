import { useEffect, useMemo, useState } from "react";
import {
  ActionIcon,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Collapse,
  Grid,
  Group,
  NumberInput,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { BarChart } from "@mantine/charts";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconArrowLeft,
  IconChevronDown,
  IconChevronRight,
  IconPencil,
  IconPencilPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useStore } from "../store.tsx";
import { NotesSummary, PatternsPanel } from "./StudentSummary.tsx";
import { useChartPalette } from "../theme.tsx";
import type { Entry } from "../../shared/types.ts";
import {
  categoryName,
  filterEntries,
  isUntimed,
  mandateComparison,
  perStudentTotals,
  studentEntries,
  studentWeeklyByGroup,
} from "../lib/aggregate.ts";
import { fmtDayLabel, fmtDuration, fmtWeekLabel, toHours } from "../lib/time.ts";
import { Link, navigate, studentPath, useLocation } from "../lib/router.tsx";
import {
  logEditPath,
  timelinePath,
  useAttributionParam,
  useFlagParam,
  useRangeParam,
  type LogNavState,
} from "../lib/urlState.ts";
import { noteExcerpt } from "../lib/notes.ts";
import { ReadOnlyNote } from "./NoteView.tsx";
import {
  ATTRIBUTION_OPTIONS,
  ChartCard,
  ChartTooltip,
  DeleteEntryModal,
  IepBadge,
  MandateBar,
  RangePicker,
  Seg,
  StatTile,
  attributionNote,
} from "./ui.tsx";

const fmtH = (v: number) => `${v}h`;

const EMPTY_TOTALS = {
  direct: 0,
  indirect: 0,
  total: 0,
  avgPerWeek: 0,
  entryCount: 0,
  untimed: 0,
};

function NotFound() {
  return (
    <Card>
      <Stack align="center" gap="xs" py="xl">
        <Text fw={600}>Student not found</Text>
        <Text size="sm" c="dimmed">
          That student doesn't exist, or was removed from the roster.
        </Text>
        <Button component={Link} to="/students" variant="default" mt="xs">
          Back to Students
        </Button>
      </Stack>
    </Card>
  );
}

export function StudentPage({ studentId }: { studentId: string }) {
  const { doc, updateStudent, deleteEntry } = useStore();
  const palette = useChartPalette();
  const location = useLocation();
  /**
   * All time by default, unlike Dashboard and Reports. The reason to open this
   * page is to find history and old notes, and a 12-week window hides most of both.
   */
  const [range, setRange] = useRangeParam(doc.settings.schoolYearStartMonth, "all");
  const [attribution, setAttribution] = useAttributionParam();
  const [notesOnly, setNotesOnly] = useFlagParam("notes");
  const [detailsOpen, details] = useDisclosure(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingDelete, setPendingDelete] = useState<Entry | null>(null);

  const student = doc.students.find((s) => s.id === studentId) ?? null;

  /**
   * The name field, held locally so that emptying it to retype it is not the
   * same act as saving an empty name. See the input for what that used to do.
   */
  const [name, setName] = useState(student?.name ?? "");
  // Following the record, but only when it is a different record. Re-syncing on
  // every change to `student` would overwrite what she is in the middle of
  // typing with what the last keystroke happened to persist.
  useEffect(() => {
    setName(doc.students.find((s) => s.id === studentId)?.name ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId]);

  const inRange = useMemo(() => filterEntries(doc.entries, range.range), [doc.entries, range]);
  const mine = useMemo(() => studentEntries(inRange, studentId), [inRange, studentId]);
  const withNotes = useMemo(() => mine.filter((e) => !!e.note), [mine]);
  const visible = notesOnly ? withNotes : mine;

  const totals =
    useMemo(
      () =>
        perStudentTotals(inRange, doc.students, doc.categories, attribution, range.range).find(
          (r) => r.student.id === studentId,
        ),
      [inRange, doc.students, doc.categories, attribution, range, studentId],
    ) ?? EMPTY_TOTALS;

  const weekly = useMemo(
    () =>
      studentWeeklyByGroup(inRange, doc.categories, studentId, attribution, range.range).map(
        (r) => ({
          week: fmtWeekLabel(r.week),
          Direct: toHours(r.direct),
          Indirect: toHours(r.indirect),
        }),
      ),
    [inRange, doc.categories, studentId, attribution, range],
  );

  const mandate = useMemo(
    () =>
      mandateComparison(inRange, doc.students, doc.categories, range.range).find(
        (m) => m.student.id === studentId,
      ) ?? null,
    [inRange, doc.students, doc.categories, range, studentId],
  );

  // Filtering to notes is a request to read them, so they open with the filter.
  useEffect(() => {
    if (notesOnly) setExpanded(new Set(withNotes.map((e) => e.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notesOnly]);

  if (!student) return <NotFound />;

  const toggleNote = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const startEdit = (entry: Entry) =>
    navigate(logEditPath(entry.id, entry.date), {
      state: { returnTo: location.pathname + location.search } satisfies LogNavState,
    });

  const remove = (entry: Entry) => {
    deleteEntry(entry.id);
    setPendingDelete(null);
    notifications.show({
      message: entry.minutes ? `Deleted ${fmtDuration(entry.minutes)} entry` : "Deleted entry",
      color: "gray",
    });
  };

  /** An entry with a note is clinical documentation — deleting it asks first. */
  const askDelete = (entry: Entry) => {
    if (entry.note) setPendingDelete(entry);
    else remove(entry);
  };

  const sessions = totals.entryCount - totals.untimed;
  const subtitle = [
    student.grade ? `Grade ${student.grade}` : null,
    student.iep && student.mandatedMinutesPerWeek
      ? `${fmtDuration(student.mandatedMinutesPerWeek)}/wk mandate`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Stack gap="md">
      <Box>
        <Anchor component={Link} to="/students" size="sm" c="dimmed">
          <Group gap={4} wrap="nowrap">
            <IconArrowLeft size={14} />
            Students
          </Group>
        </Anchor>

        <Group justify="space-between" align="flex-start" wrap="nowrap" mt={6}>
          <Box>
            <Group gap="xs">
              <Title order={2}>{student.name}</Title>
              <IepBadge iep={student.iep} />
              {!student.active && (
                <Badge size="sm" variant="default">
                  inactive
                </Badge>
              )}
            </Group>
            {subtitle && (
              <Text size="sm" c="dimmed" mt={2}>
                {subtitle}
              </Text>
            )}
          </Box>
          <Group gap="xs" wrap="nowrap" className="no-print" style={{ flex: "none" }}>
            <Button
              size="xs"
              leftSection={<IconPencilPlus size={14} />}
              /* Router state, not a query param — see LogNavState. Every press
                 pushes a fresh history entry, so coming here from a second
                 student's page re-seeds the form rather than doing nothing. */
              onClick={() =>
                navigate("/log", { state: { student: student.id } satisfies LogNavState })
              }
            >
              Log time
            </Button>
            <Button variant="default" size="xs" onClick={details.toggle}>
              {detailsOpen ? "Done" : "Edit details"}
            </Button>
          </Group>
        </Group>
      </Box>

      <Collapse expanded={detailsOpen}>
        <Card className="no-print">
          <Grid>
            <Grid.Col span={{ base: 12, sm: 6 }}>
              <TextInput
                label="Name"
                value={name}
                onChange={(e) => {
                  const next = e.currentTarget.value;
                  setName(next);
                  // A blank field is a moment in the middle of retyping a name,
                  // not a name. Every keystroke of clearing one used to be
                  // persisted, so stopping there — or navigating away — left a
                  // nameless student on the roster with entries attached to
                  // them, and nothing on the page said so.
                  if (next.trim()) updateStudent(student.id, { name: next.trim() });
                }}
                onBlur={() => {
                  // She emptied it and left. Show what is actually on the
                  // record, which is the last real name she typed.
                  if (!name.trim()) setName(student.name);
                }}
              />
            </Grid.Col>
            <Grid.Col span={{ base: 6, sm: 3 }}>
              <NumberInput
                label="Mandated min/week"
                min={0}
                // A mandate is whole minutes a week. Mantine allows decimals by
                // default, and "22.5" in this box makes every compliance
                // percentage on the caseload report slightly and unaccountably
                // wrong. The ceiling is a school week, generously.
                max={2400}
                allowDecimal={false}
                allowNegative={false}
                clampBehavior="strict"
                disabled={!student.iep}
                placeholder={student.iep ? "e.g. 30" : "IEP only"}
                value={student.mandatedMinutesPerWeek ?? ""}
                onChange={(v) =>
                  updateStudent(student.id, {
                    mandatedMinutesPerWeek: v === "" ? null : Math.round(Number(v)),
                  })
                }
              />
            </Grid.Col>
            <Grid.Col span={{ base: 6, sm: 3 }}>
              <TextInput
                label="Grade"
                placeholder="e.g. 4"
                value={student.grade ?? ""}
                onChange={(e) =>
                  updateStudent(student.id, { grade: e.currentTarget.value || undefined })
                }
              />
            </Grid.Col>
          </Grid>
          <Group mt="md" gap="lg">
            <Switch
              label="IEP student"
              checked={student.iep}
              onChange={(e) => updateStudent(student.id, { iep: e.currentTarget.checked })}
            />
            <Button
              variant="default"
              size="xs"
              onClick={() => updateStudent(student.id, { active: !student.active })}
            >
              {student.active ? "Mark inactive (left caseload)" : "Reactivate"}
            </Button>
          </Group>
        </Card>
      </Collapse>

      <Group gap="sm" className="no-print">
        <RangePicker
          schoolYearStartMonth={doc.settings.schoolYearStartMonth}
          value={range}
          onChange={setRange}
        />
        <Seg options={ATTRIBUTION_OPTIONS} value={attribution} onChange={setAttribution} />
        <Text size="xs" c="dimmed">
          {attributionNote(attribution)}
        </Text>
      </Group>

      <SimpleGrid cols={{ base: 2, sm: totals.untimed ? 5 : 4 }} spacing="sm">
        <StatTile
          label="Total time"
          value={`${toHours(totals.total)}h`}
          sub={range.label.toLowerCase()}
        />
        <StatTile label="Avg per week" value={`${toHours(totals.avgPerWeek)}h`} />
        <StatTile
          label="Direct time"
          value={totals.total ? `${Math.round((totals.direct / totals.total) * 100)}%` : "—"}
          sub={`${toHours(totals.direct)}h of ${toHours(totals.total)}h`}
        />
        <StatTile label="Sessions" value={sessions} sub="entries with time" />
        {totals.untimed > 0 && (
          <StatTile
            label="Untimed"
            value={totals.untimed}
            sub="no-shows and the like"
            /* The list below this is every entry for the student; the Timeline is
               where it can be narrowed to just the ones that didn't happen. */
            to={timelinePath(range, { students: [studentId], q: "is:untimed" })}
          />
        )}
      </SimpleGrid>

      {mandate && (
        <Card>
          <Text fw={600} size="sm">
            IEP mandate vs actual
          </Text>
          <Text size="xs" c="dimmed" mt={2} mb="sm">
            Avg service minutes per week — group time counted in full to each attendee, regardless
            of the toggle above, because a mandate is written in service minutes.
          </Text>
          <MandateBar
            mandated={mandate.mandated}
            actualPerWeek={mandate.actualPerWeek}
            /* Headroom above the larger of the two. On the dashboard the scale is
               shared across students so the bars compare; alone on one student's
               page the axis would otherwise end exactly at their own value and
               the bar would read 100% full no matter what the number is. */
            max={Math.max(mandate.actualPerWeek, mandate.mandated, 1) * 1.25}
            palette={palette}
          />
        </Card>
      )}

      <ChartCard
        title="Hours per week"
        sub={`Split direct vs indirect · ${attributionNote(attribution).toLowerCase()}`}
        table={{
          headers: ["Week", "Direct (h)", "Indirect (h)", "Total (h)"],
          rows: weekly.map((w) => [
            w.week,
            w.Direct,
            w.Indirect,
            Math.round((w.Direct + w.Indirect) * 10) / 10,
          ]),
        }}
      >
        {weekly.length === 0 ? (
          <Text size="sm" c="dimmed" ta="center" py="xl">
            No time logged for {student.name} in this range.
          </Text>
        ) : (
          <BarChart
            h={220}
            data={weekly}
            dataKey="week"
            type="stacked"
            withLegend
            legendProps={{ verticalAlign: "top", height: 32 }}
            series={[
              { name: "Direct", color: palette.direct },
              { name: "Indirect", color: palette.indirect },
            ]}
            maxBarWidth={24}
            barProps={(series) => ({
              stroke: palette.surface,
              strokeWidth: 1,
              radius: series.name === "Indirect" ? [4, 4, 0, 0] : 0,
            })}
            gridAxis="x"
            tickLine="none"
            strokeDasharray="0"
            valueFormatter={fmtH}
            yAxisProps={{ tickFormatter: fmtH }}
            tooltipProps={{ content: (p: any) => <ChartTooltip {...p} formatter={fmtH} /> }}
          />
        )}
      </ChartCard>

      {/* The deterministic panel first, and always. The AI one renders nothing
          at all when the model is not downloaded, so this page reads the same
          for someone who never turns the feature on. */}
      <PatternsPanel entries={inRange} studentId={studentId} rangeLabel={range.label} />
      <NotesSummary student={student} entries={mine} />

      <Card>
        <Group justify="space-between" mb="sm" wrap="nowrap">
          <Text fw={600} size="sm">
            {notesOnly ? `Notes (${withNotes.length})` : `Entries (${mine.length})`}
          </Text>
          <Switch
            size="xs"
            className="no-print"
            label="Notes only"
            checked={notesOnly}
            onChange={(e) => setNotesOnly(e.currentTarget.checked)}
          />
        </Group>

        {visible.length === 0 ? (
          <Text size="sm" c="dimmed" ta="center" py="xl">
            {mine.length === 0
              ? "Nothing logged in this range."
              : "No notes on any entry in this range."}
          </Text>
        ) : (
          <Stack gap={0}>
            {visible.map((entry) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                studentId={studentId}
                expanded={expanded.has(entry.id)}
                onToggleNote={() => toggleNote(entry.id)}
                onEdit={() => startEdit(entry)}
                onDelete={() => askDelete(entry)}
              />
            ))}
          </Stack>
        )}
      </Card>

      <DeleteEntryModal
        entry={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={remove}
      />
    </Stack>
  );
}

function EntryRow({
  entry,
  studentId,
  expanded,
  onToggleNote,
  onEdit,
  onDelete,
}: {
  entry: Entry;
  studentId: string;
  expanded: boolean;
  onToggleNote: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { doc } = useStore();
  const category = doc.categories.find((c) => c.id === entry.categoryId);
  const untimed = isUntimed(entry.categoryId, doc.categories);
  const peers = entry.studentIds.filter((id) => id !== studentId);

  return (
    <Box py={8} style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}>
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <Text size="xs" c="dimmed" w={48} mt={3} className="tnum" style={{ flex: "none" }}>
          {fmtDayLabel(entry.date)}
        </Text>
        <Text
          size="sm"
          fw={600}
          w={54}
          c={untimed ? "dimmed" : undefined}
          className="tnum"
          style={{ flex: "none" }}
        >
          {untimed ? "—" : fmtDuration(entry.minutes)}
        </Text>
        <span className={`cat-dot ${category?.group ?? "indirect"}`} style={{ marginTop: 6 }} />

        <Box style={{ flex: 1, minWidth: 0 }}>
          <Text size="sm">
            {categoryName(doc, entry.categoryId)}
            {entry.startTime ? (
              <Text span size="xs" c="dimmed">
                {" "}
                · {entry.startTime}
              </Text>
            ) : null}
          </Text>

          {peers.length > 0 && (
            <Text size="xs" c="dimmed">
              with{" "}
              {peers.map((id, i) => (
                <span key={id}>
                  {i > 0 && ", "}
                  <Anchor
                    component={Link}
                    to={studentPath(id)}
                    size="xs"
                    c="dimmed"
                    underline="always"
                  >
                    {doc.students.find((s) => s.id === id)?.name ?? "(deleted)"}
                  </Anchor>
                </span>
              ))}
            </Text>
          )}

          {entry.note && (
            <Box mt={4}>
              <Group
                gap={4}
                wrap="nowrap"
                align="flex-start"
                style={{ cursor: "pointer" }}
                onClick={onToggleNote}
                role="button"
                tabIndex={0}
                aria-expanded={expanded}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onToggleNote();
                  }
                }}
              >
                {expanded ? (
                  <IconChevronDown size={13} style={{ flex: "none", marginTop: 3 }} />
                ) : (
                  <IconChevronRight size={13} style={{ flex: "none", marginTop: 3 }} />
                )}
                {/* Expanded, the excerpt is replaced by the note itself below —
                    but the chevron still needs a label, or it sits alone on the
                    row looking like a rendering bug. */}
                <Text size="sm" c="dimmed" truncate>
                  {expanded ? "Note" : noteExcerpt(entry.note)}
                </Text>
              </Group>
              {expanded && (
                <Box className="note-body" pl={17}>
                  <ReadOnlyNote html={entry.note} />
                </Box>
              )}
            </Box>
          )}
        </Box>

        <Group gap={2} wrap="nowrap" className="no-print" style={{ flex: "none" }}>
          <Tooltip label="Edit on the Log page">
            <ActionIcon variant="subtle" color="gray" aria-label="Edit entry" onClick={onEdit}>
              <IconPencil size={15} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Delete">
            <ActionIcon variant="subtle" color="red" aria-label="Delete entry" onClick={onDelete}>
              <IconTrash size={15} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>
    </Box>
  );
}

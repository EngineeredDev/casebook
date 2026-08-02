import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActionIcon,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Center,
  Group,
  Highlight,
  Loader,
  MultiSelect,
  Popover,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconChevronDown,
  IconChevronRight,
  IconClockOff,
  IconFilterOff,
  IconHelpCircle,
  IconPencil,
  IconSearch,
  IconTrash,
  IconUsers,
  IconX,
} from "@tabler/icons-react";
import { useStore } from "../store.tsx";
import type { Entry } from "../../shared/types.ts";
import { isSchoolLevel } from "../lib/aggregate.ts";
import { buildIndex, matchEntry, parseQuery, type IndexedEntry } from "../lib/search.ts";
import { fmtDayHeading, fmtDuration, fmtMonthLabel, monthStartYmd, toHours } from "../lib/time.ts";
import { Link, navigate, studentPath, useLocation } from "../lib/router.tsx";
import {
  logEditPath,
  useEnumParam,
  useFlagParam,
  useIdsParam,
  useRangeParam,
  useTextParam,
  type LogNavState,
} from "../lib/urlState.ts";
import { ReadOnlyNote } from "./NoteView.tsx";
import { DeleteEntryModal, RangePicker, Seg } from "./ui.tsx";

/**
 * How many entries are added each time the bottom comes into view. Large enough
 * that a normal scroll never waits on it, small enough that the first paint of
 * a multi-year caseload isn't hundreds of rows deep.
 */
const PAGE = 60;

const GROUPS = ["all", "direct", "indirect"] as const;
type GroupFilter = (typeof GROUPS)[number];

const GROUP_OPTIONS: { key: GroupFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "direct", label: "Direct" },
  { key: "indirect", label: "Indirect" },
];

const SEARCH_HELP: [string, string][] = [
  ["coping cards", "both words appear somewhere on the entry"],
  ['"coping cards"', "that exact phrase"],
  ["student:casey", "entries a matching student attended"],
  ["cat:iep", "entries in a matching category"],
  ["note:guardian", "the word appears in the note specifically"],
  ["has:note", "only entries carrying a note"],
  ["is:group", "sessions with more than one student"],
  ["is:school", "no student on it — also is:student"],
  ["is:untimed", "no-shows and cancellations"],
  ["is:iep", "entries for an IEP student"],
  ["after:2026-05", "on or after — also before:, on:"],
  ["-documentation", "a leading minus excludes"],
];

function SearchHelp() {
  return (
    <Popover width={360} position="bottom-end" shadow="md" withArrow>
      <Popover.Target>
        <ActionIcon variant="subtle" color="gray" aria-label="Search syntax">
          <IconHelpCircle size={16} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <Text size="xs" fw={600} mb={6}>
          Search
        </Text>
        <Text size="xs" c="dimmed" mb="xs">
          Typed words match the note, the students, and the category. Every term has to match.
        </Text>
        <Stack gap={4}>
          {SEARCH_HELP.map(([syntax, meaning]) => (
            <Group key={syntax} gap="xs" wrap="nowrap" align="baseline">
              <Text size="xs" ff="monospace" w={120} style={{ flex: "none" }}>
                {syntax}
              </Text>
              <Text size="xs" c="dimmed">
                {meaning}
              </Text>
            </Group>
          ))}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

interface Row {
  idx: IndexedEntry;
  /** The search matched inside this entry's note — which stays collapsed. */
  inNote: boolean;
}

interface DayStats {
  minutes: number;
  count: number;
  untimed: number;
}

export function TimelinePage() {
  const { doc, deleteEntry } = useStore();
  const location = useLocation();

  const [range, setRange] = useRangeParam(doc.settings.schoolYearStartMonth);
  const [query, setQuery] = useTextParam("q");
  const [studentIds, setStudentIds] = useIdsParam("students");
  const [categoryIds, setCategoryIds] = useIdsParam("cats");
  const [group, setGroup] = useEnumParam<GroupFilter>("group", GROUPS, "all");
  const [notesOnly, setNotesOnly] = useFlagParam("notes");

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingDelete, setPendingDelete] = useState<Entry | null>(null);
  const [limit, setLimit] = useState(PAGE);

  const { from, to } = range.range;

  const index = useMemo(() => buildIndex(doc), [doc]);
  const parsed = useMemo(() => parseQuery(query), [query]);
  const studentFilter = useMemo(() => new Set(studentIds), [studentIds]);
  const categoryFilter = useMemo(() => new Set(categoryIds), [categoryIds]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const idx of index) {
      const e = idx.entry;
      if (e.date < from || e.date > to) continue;
      if (studentFilter.size && !e.studentIds.some((id) => studentFilter.has(id))) continue;
      if (categoryFilter.size && !categoryFilter.has(e.categoryId)) continue;
      if (group !== "all" && idx.group !== group) continue;
      if (notesOnly && !idx.note) continue;
      const match = matchEntry(parsed, idx);
      if (!match) continue;
      out.push({ idx, inNote: match.inNote });
    }
    return out;
  }, [index, from, to, studentFilter, categoryFilter, group, notesOnly, parsed]);

  /* Day headers count the whole matching day, not just the part scrolled into
     view, so a total never changes under you as more rows load. */
  const dayStats = useMemo(() => {
    const stats = new Map<string, DayStats>();
    for (const { idx } of rows) {
      const row = stats.get(idx.entry.date) ?? { minutes: 0, count: 0, untimed: 0 };
      row.minutes += idx.entry.minutes;
      row.count += 1;
      if (idx.untimed) row.untimed += 1;
      stats.set(idx.entry.date, row);
    }
    return stats;
  }, [rows]);

  const totals = useMemo(() => {
    let minutes = 0;
    let untimed = 0;
    let notes = 0;
    // Start time is optional and plenty of people never fill it in. Reserving
    // its column regardless leaves an empty gutter down the whole page, so the
    // column exists only when something in view actually has one.
    let anyStartTime = false;
    for (const { idx } of rows) {
      minutes += idx.entry.minutes;
      if (idx.untimed) untimed += 1;
      if (idx.note) notes += 1;
      if (idx.entry.startTime) anyStartTime = true;
    }
    return { minutes, untimed, notes, anyStartTime };
  }, [rows]);

  /** Months, each holding its days, over the slice that is actually rendered. */
  const months = useMemo(() => {
    const out: { month: string; days: { date: string; items: Row[] }[] }[] = [];
    for (const row of rows.slice(0, limit)) {
      const date = row.idx.entry.date;
      const month = monthStartYmd(date);
      let lastMonth = out[out.length - 1];
      if (!lastMonth || lastMonth.month !== month) {
        lastMonth = { month, days: [] };
        out.push(lastMonth);
      }
      let lastDay = lastMonth.days[lastMonth.days.length - 1];
      if (!lastDay || lastDay.date !== date) {
        lastDay = { date, items: [] };
        lastMonth.days.push(lastDay);
      }
      lastDay.items.push(row);
    }
    return out;
  }, [rows, limit]);

  // Any filter change starts the list over — the URL is the filter state, so
  // one dependency covers the search box, the pickers, and the back button.
  useEffect(() => {
    setLimit(PAGE);
  }, [location.search]);

  const hasMore = limit < rows.length;
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    // Rebuilt whenever the limit moves: an observer that is already intersecting
    // does not fire again on its own, so a fresh one is what keeps a fast scroll
    // (or a short list on a tall screen) loading rather than stalling.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setLimit((l) => l + PAGE);
      },
      { rootMargin: "800px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, limit, rows.length]);

  const studentOptions = useMemo(
    () =>
      doc.students
        .map((s) => ({ value: s.id, label: s.iep ? `${s.name} · IEP` : s.name }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [doc.students],
  );

  const categoryOptions = useMemo(
    () =>
      (["direct", "indirect"] as const).map((g) => ({
        group: g === "direct" ? "Direct time" : "Indirect time",
        items: doc.categories
          .filter((c) => c.group === g)
          .map((c) => ({ value: c.id, label: c.archived ? `${c.name} (archived)` : c.name })),
      })),
    [doc.categories],
  );

  const filtered =
    !!query.trim() ||
    studentIds.length > 0 ||
    categoryIds.length > 0 ||
    group !== "all" ||
    notesOnly ||
    range.key !== "all";

  // `replace`, like every other filter write on the page: Back should step to
  // the previous page, not back through a filter you deliberately cleared.
  const clearAll = () => navigate("/timeline", { replace: true });

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

  return (
    <Stack gap="md">
      <Card className="no-print">
        <Stack gap="sm">
          <TextInput
            placeholder="Search notes, students, categories…"
            leftSection={<IconSearch size={15} />}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            rightSectionWidth={query ? 64 : 36}
            /* Mantine makes the right section click-through by default, which
               would leave both of these buttons dead. */
            rightSectionPointerEvents="all"
            rightSection={
              <Group gap={2} wrap="nowrap">
                {query && (
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    aria-label="Clear search"
                    onClick={() => setQuery("")}
                  >
                    <IconX size={15} />
                  </ActionIcon>
                )}
                <SearchHelp />
              </Group>
            }
          />

          <Group gap="xs" align="center">
            <RangePicker
              schoolYearStartMonth={doc.settings.schoolYearStartMonth}
              value={range}
              onChange={setRange}
            />
            {/* The two pickers take all the width the fixed controls leave, and
                split it evenly. Picking several students should widen the pills
                across the row rather than stacking them into a taller input.
                `miw` is the floor at which they give up and the row wraps. */}
            <MultiSelect
              size="sm"
              miw={200}
              style={{ flex: 1 }}
              placeholder={studentIds.length ? undefined : "All students"}
              data={studentOptions}
              value={studentIds}
              onChange={setStudentIds}
              searchable
              clearable
              hidePickedOptions
              nothingFoundMessage="No students"
            />
            <MultiSelect
              size="sm"
              miw={200}
              style={{ flex: 1 }}
              placeholder={categoryIds.length ? undefined : "All categories"}
              data={categoryOptions}
              value={categoryIds}
              onChange={setCategoryIds}
              searchable
              clearable
              hidePickedOptions
              nothingFoundMessage="No categories"
            />
            <Seg options={GROUP_OPTIONS} value={group} onChange={setGroup} />
            <Switch
              size="xs"
              label="Has a note"
              checked={notesOnly}
              onChange={(e) => setNotesOnly(e.currentTarget.checked)}
            />
            {filtered && (
              <Button
                variant="subtle"
                color="gray"
                size="compact-sm"
                leftSection={<IconFilterOff size={14} />}
                onClick={clearAll}
              >
                Clear
              </Button>
            )}
          </Group>

          <Text size="xs" c="dimmed">
            {rows.length === doc.entries.length
              ? `${rows.length} entries`
              : `${rows.length} of ${doc.entries.length} entries`}
            {" · "}
            {toHours(totals.minutes)}h{totals.untimed > 0 && ` · ${totals.untimed} untimed`}
            {totals.notes > 0 && ` · ${totals.notes} with notes`}
          </Text>
        </Stack>
      </Card>

      {rows.length === 0 ? (
        <Card>
          <Stack align="center" gap="xs" py="xl">
            <Text fw={600}>Nothing matches</Text>
            <Text size="sm" c="dimmed" ta="center">
              {doc.entries.length === 0
                ? "No time has been logged yet."
                : "Try a shorter search, or widen the date range."}
            </Text>
            {filtered && (
              <Button variant="default" mt="xs" onClick={clearAll}>
                Clear filters
              </Button>
            )}
          </Stack>
        </Card>
      ) : (
        <Box>
          {/* No card around the entries. Boxing a scroll of history in cards
              turns a filtered result of one entry per day into a column of
              mostly-border; the rules already separating rows are enough
              structure, and the point of the page is an unbroken scroll. */}
          {months.map(({ month, days }) => (
            <Box key={month} mb="lg">
              <Box className="timeline-month">
                <Text size="xs" fw={700} tt="uppercase" lts={0.6} c="dimmed">
                  {fmtMonthLabel(month)}
                </Text>
              </Box>

              {days.map(({ date, items }) => {
                const stats = dayStats.get(date)!;
                return (
                  <Box key={date} mt="md">
                    <Group justify="space-between" wrap="nowrap" mb={2}>
                      <Text fw={600} size="sm">
                        {fmtDayHeading(date)}
                      </Text>
                      <Group gap={6} wrap="nowrap">
                        {stats.untimed > 0 && (
                          <Badge variant="default" leftSection={<IconClockOff size={11} />}>
                            {stats.untimed}
                          </Badge>
                        )}
                        <Text size="xs" c="dimmed" className="tnum">
                          {stats.minutes > 0 && `${fmtDuration(stats.minutes)} · `}
                          {stats.count} {stats.count === 1 ? "entry" : "entries"}
                        </Text>
                      </Group>
                    </Group>

                    {/* Each row draws its own top rule, so the first one doubles
                        as the line under the day heading. */}
                    <Stack gap={0}>
                      {items.map((row) => (
                        <TimelineRow
                          key={row.idx.entry.id}
                          row={row}
                          highlight={parsed.highlight}
                          showTime={totals.anyStartTime}
                          expanded={expanded.has(row.idx.entry.id)}
                          onToggleNote={() => toggleNote(row.idx.entry.id)}
                          onEdit={() => startEdit(row.idx.entry)}
                          onDelete={() => askDelete(row.idx.entry)}
                        />
                      ))}
                    </Stack>
                  </Box>
                );
              })}
            </Box>
          ))}

          {hasMore && (
            <Center ref={sentinelRef} py="lg">
              <Group gap="xs">
                <Loader size="xs" />
                <Text size="xs" c="dimmed">
                  {rows.length - limit} older {rows.length - limit === 1 ? "entry" : "entries"}
                </Text>
              </Group>
            </Center>
          )}
          {!hasMore && rows.length > PAGE && (
            <Text size="xs" c="dimmed" ta="center" py="lg">
              That's everything.
            </Text>
          )}
        </Box>
      )}

      <DeleteEntryModal
        entry={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={remove}
      />
    </Stack>
  );
}

function TimelineRow({
  row,
  highlight,
  showTime,
  expanded,
  onToggleNote,
  onEdit,
  onDelete,
}: {
  row: Row;
  highlight: string[];
  /** False when nothing in the list has a start time, so the column is dropped. */
  showTime: boolean;
  expanded: boolean;
  onToggleNote: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { idx, inNote } = row;
  const { entry, students, category, untimed } = idx;

  return (
    <Box py={7} style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}>
      <Group gap="xs" wrap="nowrap" align="flex-start">
        {showTime && (
          <Text size="xs" c="dimmed" w={46} mt={3} className="tnum" style={{ flex: "none" }}>
            {entry.startTime ?? ""}
          </Text>
        )}
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
        <span className={`cat-dot ${idx.group}`} style={{ marginTop: 6 }} />

        <Box style={{ flex: 1, minWidth: 0 }}>
          <Group gap={6} wrap="nowrap">
            <Highlight component="span" size="sm" highlight={highlight}>
              {category?.name ?? "(deleted)"}
            </Highlight>
            {entry.studentIds.length > 1 && (
              <Tooltip label="Group session">
                <IconUsers size={13} stroke={1.6} opacity={0.5} style={{ flex: "none" }} />
              </Tooltip>
            )}
          </Group>

          {/* Quiet and italic rather than a badge: this line is the row's cast
              of names, and school-level work belongs in that slot saying what
              it is — not sitting there as an empty space that reads as a
              student who failed to load. */}
          {isSchoolLevel(entry) ? (
            <Text size="xs" c="dimmed" fs="italic">
              School-level
            </Text>
          ) : (
            <Text size="xs" c="dimmed">
              {entry.studentIds.map((id, i) => {
                const student = students.find((s) => s.id === id);
                return (
                  <span key={id}>
                    {i > 0 && ", "}
                    {student ? (
                      <Anchor
                        component={Link}
                        to={studentPath(id)}
                        size="xs"
                        c="dimmed"
                        underline="hover"
                      >
                        <Highlight component="span" size="xs" highlight={highlight}>
                          {student.name}
                        </Highlight>
                      </Anchor>
                    ) : (
                      "(deleted)"
                    )}
                  </span>
                );
              })}
            </Text>
          )}

          {/* Notes stay shut until asked for — no excerpt, so the list reads as
              a schedule and a note is never half-read over someone's shoulder.
              A search hit inside one says so, since the text that matched is
              behind the fold. */}
          {entry.note && (
            <Box mt={2}>
              <UnstyledButton onClick={onToggleNote} aria-expanded={expanded}>
                <Group gap={3} wrap="nowrap">
                  {expanded ? (
                    <IconChevronDown size={13} style={{ flex: "none" }} />
                  ) : (
                    <IconChevronRight size={13} style={{ flex: "none" }} />
                  )}
                  <Text size="xs" c={inNote ? "clinical" : "dimmed"} fw={inNote ? 600 : 400}>
                    {expanded ? "Hide note" : inNote ? "Note · matches search" : "Note"}
                  </Text>
                </Group>
              </UnstyledButton>
              {expanded && (
                <Box className="note-body" pl={16}>
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

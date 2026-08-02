import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Chip,
  Combobox,
  Grid,
  Group,
  NumberInput,
  Pill,
  PillsInput,
  Stack,
  Text,
  Tooltip,
  useCombobox,
} from "@mantine/core";
import { DatePickerInput, TimeInput } from "@mantine/dates";
import { notifications } from "@mantine/notifications";
import {
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconClockOff,
  IconPencil,
  IconSchool,
  IconTrash,
  IconUsers,
} from "@tabler/icons-react";
import { useStore } from "../store.tsx";
import type { Entry, Student } from "../../shared/types.ts";
import { isSchoolLevel } from "../lib/aggregate.ts";
import { addDaysYmd, fmtDuration, fmtFullDate, todayYmd } from "../lib/time.ts";
import { navigate, useLocation, useSearchParams } from "../lib/router.tsx";
import { useDateParam, type LogNavState } from "../lib/urlState.ts";
import { clearDraft, readDraft, writeDraft } from "../lib/draft.ts";
import { DeleteEntryModal, IepBadge, Seg } from "./ui.tsx";
import { NoteEditor } from "./NoteEditor.tsx";
import { isBlankNote, noteExcerpt } from "../lib/notes.ts";

const DURATION_PRESETS = [5, 10, 15, 20, 30, 45, 60, 90];

const CREATE_PLAIN = "$create";
const CREATE_IEP = "$create-iep";

/**
 * Who an entry is about. "school" is the only route to an entry with no
 * students on it — the picker cannot be emptied into that state by itself — so
 * an unattributed entry is always something she chose and never something a
 * half-filled form produced on her behalf.
 */
type Scope = "student" | "school";

const SCOPE_OPTIONS: { key: Scope; label: string }[] = [
  { key: "student", label: "Student(s)" },
  { key: "school", label: "School-level" },
];

/**
 * "Optional" rides inline with the label rather than using `description`, which
 * renders on its own line and pushes that field's input out of line with its
 * neighbours in a row.
 */
const optionalLabel = (text: string) => (
  <>
    {text}{" "}
    <Text span size="xs" c="dimmed" fw={400}>
      Optional
    </Text>
  </>
);

function StudentPicker({
  selectedIds,
  onChange,
  inputRef,
  disabled,
}: {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  /** School-level mode. Shown rather than hidden, so the state is legible. */
  disabled?: boolean;
}) {
  const { doc, addStudent } = useStore();
  const [search, setSearch] = useState("");
  const combobox = useCombobox({
    onDropdownClose: () => combobox.resetSelectedOption(),
    onDropdownOpen: () => combobox.updateSelectedOptionIndex("active"),
  });

  const selected = selectedIds
    .map((id) => doc.students.find((s) => s.id === id))
    .filter((s): s is Student => !!s);

  const query = search.trim().toLowerCase();
  const matches = useMemo(
    () =>
      doc.students
        .filter((s) => s.active && !selectedIds.includes(s.id))
        .filter((s) => !query || s.name.toLowerCase().includes(query))
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .slice(0, 8),
    [doc.students, query, selectedIds],
  );

  const exactMatch = doc.students.some((s) => s.name.toLowerCase() === query);
  const canCreate = query.length > 0 && !exactMatch;

  const handleSubmit = (value: string) => {
    if (value === CREATE_PLAIN || value === CREATE_IEP) {
      const student = addStudent({ name: search.trim(), iep: value === CREATE_IEP });
      onChange([...selectedIds, student.id]);
    } else {
      onChange([...selectedIds, value]);
    }
    setSearch("");
    combobox.updateSelectedOptionIndex("active");
  };

  return (
    <Combobox store={combobox} onOptionSubmit={handleSubmit} withinPortal={false}>
      <Combobox.DropdownTarget>
        <PillsInput
          onClick={() => !disabled && combobox.openDropdown()}
          size="sm"
          disabled={disabled}
        >
          <Pill.Group>
            {selected.map((s) => (
              <Pill
                key={s.id}
                withRemoveButton
                onRemove={() => onChange(selectedIds.filter((id) => id !== s.id))}
              >
                {s.name}
                {s.iep ? " · IEP" : ""}
              </Pill>
            ))}
            <Combobox.EventsTarget>
              <PillsInput.Field
                ref={inputRef}
                value={search}
                disabled={disabled}
                placeholder={
                  disabled
                    ? "No student — school-level"
                    : selected.length
                      ? "Add another student…"
                      : "Type a student's name…"
                }
                onFocus={() => !disabled && combobox.openDropdown()}
                onBlur={() => combobox.closeDropdown()}
                onChange={(event) => {
                  combobox.openDropdown();
                  combobox.updateSelectedOptionIndex();
                  setSearch(event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Backspace" && search.length === 0 && selectedIds.length) {
                    event.preventDefault();
                    onChange(selectedIds.slice(0, -1));
                  }
                }}
              />
            </Combobox.EventsTarget>
          </Pill.Group>
        </PillsInput>
      </Combobox.DropdownTarget>

      <Combobox.Dropdown>
        <Combobox.Options>
          {matches.map((s) => (
            <Combobox.Option value={s.id} key={s.id}>
              <Group gap="xs" wrap="nowrap">
                <span>{s.name}</span>
                <IepBadge iep={s.iep} />
              </Group>
            </Combobox.Option>
          ))}
          {canCreate && (
            <>
              <Combobox.Option value={CREATE_PLAIN}>
                <Text size="sm">
                  Add <strong>{search.trim()}</strong>
                </Text>
              </Combobox.Option>
              <Combobox.Option value={CREATE_IEP}>
                <Text size="sm">
                  Add <strong>{search.trim()}</strong> as an IEP student
                </Text>
              </Combobox.Option>
            </>
          )}
          {!canCreate && matches.length === 0 && (
            <Combobox.Empty>
              {doc.students.length === 0 ? "Type a name to add your first student" : "No matches"}
            </Combobox.Empty>
          )}
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  );
}

export function LogPage() {
  const { doc, addEntry, updateEntry, deleteEntry } = useStore();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const [date, setDate] = useDateParam();
  /**
   * Whatever was half-typed last time this page was mounted, read once.
   *
   * Read at initialisation rather than restored by an effect, so the first
   * paint already has it — an effect would show her an empty form and then
   * fill it, which looks like the app losing her note and finding it again.
   */
  const [restored] = useState(readDraft);
  const [studentIds, setStudentIds] = useState<string[]>(restored?.studentIds ?? []);
  const [scope, setScope] = useState<Scope>(restored?.scope ?? "student");
  const [categoryId, setCategoryId] = useState<string | null>(restored?.categoryId ?? null);
  const [minutes, setMinutes] = useState<number | null>(restored?.minutes ?? 30);
  const [customMinutes, setCustomMinutes] = useState<number | "">(restored?.customMinutes ?? "");
  const [startTime, setStartTime] = useState(restored?.startTime ?? "");
  const [note, setNote] = useState(restored?.note ?? "");
  /** Backfilling a student's history means logging a run of entries for the same
   *  student, so their selection survives the reset that follows each save. */
  const [keepStudents, setKeepStudents] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Entry | null>(null);
  const studentInputRef = useRef<HTMLInputElement>(null);
  /**
   * Bumped to ask for the student picker back. Focusing it straight from a
   * handler would be a no-op coming out of school-level mode — the input is
   * still disabled at that point, and only stops being so on the re-render the
   * handler's own state updates cause.
   */
  const [focusRequest, setFocusRequest] = useState(0);

  useEffect(() => {
    if (focusRequest) studentInputRef.current?.focus();
  }, [focusRequest]);

  /** The entry under edit lives in the URL, so an edit link is shareable and survives reload. */
  const editingId = params.get("edit");
  const editingEntry = editingId ? (doc.entries.find((e) => e.id === editingId) ?? null) : null;
  const editingMissing = !!editingId && !editingEntry;
  const { returnTo, focus, student: seedStudent } = (location.state ?? {}) as LogNavState;

  /**
   * The day the restored draft was being written for.
   *
   * The date is the one form field that already survived a navigation, because
   * it lives in the URL — but only while she is on this page. Coming back to a
   * bare `/log` would otherwise pair a note written for a Tuesday in March with
   * today's date, and saving it would file the session on the wrong day without
   * ever looking wrong. An explicit `?date=` in the URL wins: that is someone
   * asking for a particular day right now.
   */
  useEffect(() => {
    const wanted = restored?.date;
    if (!wanted || editingId || params.get("date") || wanted === todayYmd()) return;
    setDate(wanted);
    // Once, on the mount that restored the draft. Re-running would fight the
    // date picker every time she changed the day.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Everything typed into the form, held outside the React tree so that
   * unmounting this page — a navigation, a reload, a lock — cannot take it.
   *
   * Edits are excluded. An edit fills these same fields from an entry that is
   * already on disk, so recording it as a draft would report unsaved work for
   * as long as an edit link was open, and a warning that is always on is a
   * warning nobody reads.
   */
  useEffect(() => {
    if (editingId) return;
    writeDraft({ date, studentIds, scope, categoryId, minutes, customMinutes, startTime, note });
  }, [editingId, date, studentIds, scope, categoryId, minutes, customMinutes, startTime, note]);

  // Keyed on location.key, not on `focus`, so pressing "Log time" while already
  // here refocuses rather than doing nothing.
  useEffect(() => {
    if (focus) studentInputRef.current?.focus();
  }, [location.key, focus]);

  // Same reasoning for the seed: arriving from a second student's page while
  // still on /log has to re-seed. An edit link wins over a seed — it fills every
  // field below, including the students, and must not be half-overwritten.
  useEffect(() => {
    if (!seedStudent || editingId) return;
    setStudentIds([seedStudent]);
    // Arriving from a student's page is unambiguously about that student, so it
    // takes the form out of school-level mode too. Seeding a picker that is
    // disabled and empty on screen would look like the seed had been dropped.
    setScope("student");
  }, [location.key, seedStudent, editingId]);

  const categories = doc.categories.filter((c) => !c.archived);
  const directCats = categories.filter((c) => c.group === "direct");
  const indirectCats = categories.filter((c) => c.group === "indirect");

  // Untimed categories (no-shows, cancellations) force the duration to zero. The
  // duration state is left untouched rather than reset, so switching back to a
  // timed category restores whatever was picked before.
  const untimed = !!doc.categories.find((c) => c.id === categoryId)?.untimed;
  const pickedMinutes = customMinutes === "" ? minutes : Number(customMinutes);
  const effectiveMinutes = untimed ? 0 : pickedMinutes;
  const valid =
    (scope === "school" || studentIds.length > 0) &&
    !!categoryId &&
    (untimed || (!!pickedMinutes && pickedMinutes > 0 && Number.isFinite(pickedMinutes)));

  /**
   * The one door into school-level, and it clears the picker on the way
   * through. Nothing else in the form can empty the selection, so an entry with
   * no students is always a decision and never a leftover.
   */
  const changeScope = (next: Scope) => {
    setScope(next);
    if (next === "school") setStudentIds([]);
    else setFocusRequest((n) => n + 1);
  };

  const dayEntries = useMemo(
    () =>
      doc.entries
        .filter((e) => e.date === date)
        .sort(
          (a, b) =>
            (a.startTime ?? "99").localeCompare(b.startTime ?? "99") ||
            a.createdAt.localeCompare(b.createdAt),
        ),
    [doc.entries, date],
  );
  const dayTotal = dayEntries.reduce((sum, e) => sum + e.minutes, 0);
  const dayUntimed = dayEntries.filter(
    (e) => doc.categories.find((c) => c.id === e.categoryId)?.untimed,
  ).length;

  const clearFields = ({ keep = false } = {}) => {
    // Scope rides with the students it governs: keeping them keeps the mode, so
    // a run of school-level entries chains the same way a run for one student
    // does. Clearing them returns to the student default rather than leaving
    // the next entry silently unattributed.
    if (!keep) {
      setStudentIds([]);
      setScope("student");
    }
    setCategoryId(null);
    setMinutes(30);
    setCustomMinutes("");
    setStartTime("");
    setNote("");
    // Straight away rather than waiting for the effect above, which runs after
    // the next render — and `submit` navigates away on some paths, so there
    // may not be one. A saved entry left behind as a draft would come back as
    // a duplicate of itself the next time she opened the log.
    clearDraft();
  };

  const resetForm = (opts?: { keep?: boolean }) => {
    clearFields(opts);
    setParams((p) => p.delete("edit"));
  };

  /**
   * Fill the form from whichever entry the URL names. Keyed on the id alone and
   * deliberately not on `doc`: the store saves on a 500ms debounce, so
   * re-running on every document change would overwrite what is being typed.
   */
  useEffect(() => {
    if (!editingId) return;
    const entry = doc.entries.find((e) => e.id === editingId);
    if (!entry) return;
    setStudentIds(entry.studentIds);
    // Read off the entry rather than left at whatever the form was showing, so
    // opening a school-level entry for edit and saving it again cannot quietly
    // re-attribute it — or, the other way round, strip a student off one.
    setScope(isSchoolLevel(entry) ? "school" : "student");
    setCategoryId(entry.categoryId);
    setStartTime(entry.startTime ?? "");
    setNote(entry.note ?? "");
    // A zero-minute entry has no duration to restore; leave the picker on its
    // default so it reads sensibly if the category is switched to a timed one.
    if (entry.minutes === 0 || DURATION_PRESETS.includes(entry.minutes)) {
      setMinutes(entry.minutes || 30);
      setCustomMinutes("");
    } else {
      setMinutes(null);
      setCustomMinutes(entry.minutes);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  /** Returns whether an entry was actually written, so callers can react to it. */
  const submit = (): boolean => {
    if (!valid) return false;
    const payload = {
      date,
      minutes: effectiveMinutes!,
      categoryId: categoryId!,
      // Derived from the scope rather than read straight off the picker: there
      // is then no ordering of state updates in which a selection left over
      // from a moment ago can be written onto a school-level entry.
      studentIds: scope === "school" ? [] : studentIds,
      startTime: startTime || null,
      // "<p></p>" is a non-empty string but an empty note.
      note: isBlankNote(note) ? undefined : note,
    };
    if (editingId) updateEntry(editingId, payload);
    else addEntry(payload);
    // An edit that arrived from a student page goes back there, so the round
    // trip lands where it started with that page's filters intact.
    if (editingId && returnTo) {
      clearFields();
      navigate(returnTo);
      return true;
    }
    // Only a brand-new entry chains: finishing an edit hands the form back empty
    // either way, so the checkbox stays out of that path.
    const keep = keepStudents && !editingId;
    resetForm({ keep });
    // Holding the students means the category is the next field to fill, so
    // refocusing the picker would only reopen its dropdown over the form.
    if (!keep) setFocusRequest((n) => n + 1);
    return true;
  };

  const cancelEdit = () => {
    if (returnTo) {
      clearFields();
      navigate(returnTo);
      return;
    }
    resetForm();
  };

  const startEdit = (entry: Entry) => {
    setParams((p) => {
      p.set("edit", entry.id);
      if (entry.date === todayYmd()) p.delete("date");
      else p.set("date", entry.date);
    });
  };

  const removeEntry = (entry: Entry) => {
    deleteEntry(entry.id);
    setPendingDelete(null);
    if (editingId === entry.id) resetForm();
    notifications.show({
      message: entry.minutes ? `Deleted ${fmtDuration(entry.minutes)} entry` : "Deleted entry",
      color: "gray",
    });
  };

  /** An entry with a note is clinical documentation — deleting it asks first. */
  const askDelete = (entry: Entry) => {
    if (entry.note) setPendingDelete(entry);
    else removeEntry(entry);
  };

  const catChip = (c: (typeof categories)[number]) => (
    <Chip
      key={c.id}
      value={c.id}
      size="sm"
      variant="outline"
      color={c.group === "direct" ? "clinical" : "ember"}
    >
      <Group gap={6} wrap="nowrap" component="span">
        <span className={`cat-dot ${c.group}`} />
        {c.name}
        {c.untimed && <IconClockOff size={13} stroke={1.6} opacity={0.7} />}
      </Group>
    </Chip>
  );

  return (
    <>
      <Grid>
        <Grid.Col span={{ base: 12, lg: 7 }}>
          <Card>
            <Text fw={600} mb="md">
              {editingId ? "Edit entry" : "Log time"}
            </Text>

            {editingMissing && (
              <Alert variant="light" color="gray" mb="md" p="xs">
                <Group justify="space-between" wrap="nowrap" gap="sm">
                  <Text size="xs">That entry no longer exists — it may have been deleted.</Text>
                  <Button size="compact-xs" variant="default" onClick={cancelEdit}>
                    Dismiss
                  </Button>
                </Group>
              </Alert>
            )}

            <Stack gap="md">
              <Group grow align="flex-start">
                <DatePickerInput
                  label="Date"
                  value={date}
                  onChange={(v) => setDate(v ?? todayYmd())}
                  leftSection={
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      size="sm"
                      aria-label="Previous day"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDate(addDaysYmd(date, -1));
                      }}
                    >
                      <IconChevronLeft size={16} />
                    </ActionIcon>
                  }
                  rightSection={
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      size="sm"
                      aria-label="Next day"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDate(addDaysYmd(date, 1));
                      }}
                    >
                      <IconChevronRight size={16} />
                    </ActionIcon>
                  }
                />
                <TimeInput
                  label={optionalLabel("Start time")}
                  leftSection={<IconClock size={16} />}
                  value={startTime}
                  onChange={(e) => setStartTime(e.currentTarget.value)}
                />
              </Group>

              <Box>
                <Text component="label" size="sm" fw={500} display="block" mb={6}>
                  Duration
                </Text>
                {untimed ? (
                  <Alert variant="light" color="gray" p="xs" icon={<IconClockOff size={16} />}>
                    <Text size="xs">
                      Untimed category — logged as an event, with no minutes counted toward your
                      day.
                    </Text>
                  </Alert>
                ) : (
                  <Group gap={6} align="center">
                    <Chip.Group
                      multiple={false}
                      value={customMinutes === "" && minutes ? String(minutes) : ""}
                      onChange={(v) => {
                        setMinutes(Number(v));
                        setCustomMinutes("");
                      }}
                    >
                      <Group gap={6}>
                        {DURATION_PRESETS.map((m) => (
                          <Chip key={m} value={String(m)} size="sm" variant="outline">
                            {m}m
                          </Chip>
                        ))}
                      </Group>
                    </Chip.Group>
                    <NumberInput
                      size="xs"
                      w={110}
                      min={1}
                      placeholder="Custom"
                      suffix=" min"
                      value={customMinutes}
                      onChange={(v) => {
                        setCustomMinutes(v === "" ? "" : Number(v));
                        if (v !== "") setMinutes(null);
                      }}
                    />
                  </Group>
                )}
              </Box>

              <Box>
                <Group justify="space-between" align="center" mb={4} wrap="nowrap">
                  <Text component="label" size="sm" fw={500}>
                    Who
                  </Text>
                  <Seg options={SCOPE_OPTIONS} value={scope} onChange={changeScope} />
                </Group>
                <StudentPicker
                  selectedIds={studentIds}
                  onChange={setStudentIds}
                  inputRef={studentInputRef}
                  disabled={scope === "school"}
                />
                {scope === "school" ? (
                  <Alert
                    variant="light"
                    color="gray"
                    mt="xs"
                    p="xs"
                    icon={<IconSchool size={16} />}
                  >
                    <Text size="xs">
                      School-level — a meeting, a classroom lesson, staff time, coverage. The
                      minutes count toward your day and your totals, and toward no student's record.
                    </Text>
                  </Alert>
                ) : (
                  studentIds.length > 1 && (
                    <Alert
                      variant="light"
                      color="gray"
                      mt="xs"
                      p="xs"
                      icon={<IconUsers size={16} />}
                    >
                      <Text size="xs">
                        Group session — the time counts once toward your day, and per-student views
                        can show it in full or split.
                      </Text>
                    </Alert>
                  )
                )}
              </Box>

              <Box>
                <Text component="label" size="sm" fw={500} display="block" mb={6}>
                  Category
                </Text>
                <Chip.Group multiple={false} value={categoryId ?? ""} onChange={setCategoryId}>
                  <Text size="xs" c="dimmed" mb={4}>
                    Direct time
                  </Text>
                  <Group gap={6} mb="xs">
                    {directCats.map(catChip)}
                  </Group>
                  <Text size="xs" c="dimmed" mb={4}>
                    Indirect time
                  </Text>
                  <Group gap={6}>{indirectCats.map(catChip)}</Group>
                </Chip.Group>
              </Box>

              <NoteEditor
                value={note}
                onChange={setNote}
                onSubmit={submit}
                canSubmit={valid}
                submitLabel={editingId ? "Save changes" : "Log entry"}
                studentIds={studentIds}
                schoolLevel={scope === "school"}
                editingId={editingId}
                date={date}
              />

              <Group justify="space-between" gap="sm">
                <Group>
                  <Button disabled={!valid} onClick={submit}>
                    {editingId ? "Save changes" : "Log entry"}
                  </Button>
                  {editingId && (
                    <Button variant="default" onClick={cancelEdit}>
                      {returnTo ? "Cancel" : "Cancel edit"}
                    </Button>
                  )}
                </Group>
                {!editingId && (
                  <Checkbox
                    size="sm"
                    label="Create another entry"
                    checked={keepStudents}
                    onChange={(e) => setKeepStudents(e.currentTarget.checked)}
                  />
                )}
              </Group>
            </Stack>
          </Card>
        </Grid.Col>

        <Grid.Col span={{ base: 12, lg: 5 }}>
          <Card>
            <Group justify="space-between" mb="sm" wrap="nowrap">
              <Text fw={600} size="sm">
                {fmtFullDate(date)}
              </Text>
              <Group gap={6} wrap="nowrap">
                {dayUntimed > 0 && (
                  <Badge variant="default" leftSection={<IconClockOff size={11} />}>
                    {dayUntimed}
                  </Badge>
                )}
                {dayTotal > 0 && (
                  <Badge variant="light" color="gray">
                    {fmtDuration(dayTotal)}
                  </Badge>
                )}
              </Group>
            </Group>

            {dayEntries.length === 0 ? (
              <Text size="sm" c="dimmed" ta="center" py="xl">
                No entries for this day yet.
              </Text>
            ) : (
              <Stack gap={2}>
                {dayEntries.map((e) => {
                  const cat = doc.categories.find((c) => c.id === e.categoryId);
                  const schoolLevel = isSchoolLevel(e);
                  const names = e.studentIds
                    .map((id) => doc.students.find((s) => s.id === id)?.name ?? "(deleted)")
                    .join(", ");
                  return (
                    <Group
                      key={e.id}
                      gap="xs"
                      wrap="nowrap"
                      py={6}
                      style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
                    >
                      <Text
                        size="sm"
                        fw={600}
                        w={58}
                        c={cat?.untimed ? "dimmed" : undefined}
                        className="tnum"
                        style={{ flex: "none" }}
                      >
                        {cat?.untimed ? "—" : fmtDuration(e.minutes)}
                      </Text>
                      <span className={`cat-dot ${cat?.group ?? "indirect"}`} />
                      <Box style={{ flex: 1, minWidth: 0 }}>
                        {/* Named where a student would be named, so the row is
                            legibly about something rather than missing a name. */}
                        <Text
                          size="sm"
                          truncate
                          c={schoolLevel ? "dimmed" : undefined}
                          fs={schoolLevel ? "italic" : undefined}
                        >
                          {schoolLevel ? "School-level" : names}
                        </Text>
                        <Text size="xs" c="dimmed" truncate>
                          {cat?.name ?? "(deleted)"}
                          {e.startTime ? ` · ${e.startTime}` : ""}
                          {e.note ? ` · ${noteExcerpt(e.note, 60)}` : ""}
                        </Text>
                      </Box>
                      <Group gap={2} wrap="nowrap" style={{ flex: "none" }}>
                        <Tooltip label="Edit">
                          <ActionIcon
                            variant="subtle"
                            color="gray"
                            aria-label="Edit entry"
                            onClick={() => startEdit(e)}
                          >
                            <IconPencil size={15} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Delete">
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            aria-label="Delete entry"
                            onClick={() => askDelete(e)}
                          >
                            <IconTrash size={15} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    </Group>
                  );
                })}
              </Stack>
            )}
          </Card>
        </Grid.Col>
      </Grid>

      <DeleteEntryModal
        entry={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={removeEntry}
      />
    </>
  );
}

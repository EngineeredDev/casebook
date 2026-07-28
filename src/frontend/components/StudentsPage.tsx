import { useMemo, useState } from "react";
import {
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Switch,
  Table,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { IconChevronDown, IconChevronUp, IconSearch, IconSelector } from "@tabler/icons-react";
import { useStore } from "../store.tsx";
import { filterEntries, perStudentTotals } from "../lib/aggregate.ts";
import { addDaysYmd, fmtDuration, todayYmd, toHours, weekStartYmd } from "../lib/time.ts";
import { Link, navigate, studentPath } from "../lib/router.tsx";
import { IepBadge } from "./ui.tsx";

const ALL_TIME = { from: "0000-01-01", to: "9999-12-31" };

type SortKey = "name" | "mandate" | "recent" | "all";

function Th({
  children,
  sortKey,
  sort,
  onSort,
  numeric,
}: {
  children: React.ReactNode;
  sortKey: SortKey;
  sort: { key: SortKey; reversed: boolean };
  onSort: (key: SortKey) => void;
  numeric?: boolean;
}) {
  const active = sort.key === sortKey;
  const Icon = active ? (sort.reversed ? IconChevronUp : IconChevronDown) : IconSelector;
  return (
    <Table.Th className={numeric ? "num" : undefined}>
      <UnstyledButton onClick={() => onSort(sortKey)} w="100%">
        <Group gap={4} justify={numeric ? "flex-end" : "flex-start"} wrap="nowrap">
          <Text size="xs" fw={600}>
            {children}
          </Text>
          <Icon size={13} stroke={1.5} opacity={active ? 1 : 0.4} />
        </Group>
      </UnstyledButton>
    </Table.Th>
  );
}

export function StudentsPage() {
  const { doc, addStudent } = useStore();
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState("");
  const [newIep, setNewIep] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; reversed: boolean }>({
    key: "name",
    reversed: false,
  });

  const last4 = { from: addDaysYmd(weekStartYmd(todayYmd()), -21), to: todayYmd() };
  const recent = useMemo(
    () =>
      new Map(
        perStudentTotals(
          filterEntries(doc.entries, last4),
          doc.students,
          doc.categories,
          "share",
          last4,
        ).map((r) => [r.student.id, r]),
      ),
    [doc],
  );
  const allTime = useMemo(
    () =>
      new Map(
        perStudentTotals(doc.entries, doc.students, doc.categories, "share", ALL_TIME).map((r) => [
          r.student.id,
          r,
        ]),
      ),
    [doc],
  );

  const roster = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = doc.students
      .filter((s) => showInactive || s.active)
      .filter((s) => !q || s.name.toLowerCase().includes(q));
    const value = (id: string, key: SortKey) => {
      switch (key) {
        case "mandate":
          return doc.students.find((s) => s.id === id)?.mandatedMinutesPerWeek ?? 0;
        case "recent":
          return recent.get(id)?.avgPerWeek ?? 0;
        case "all":
          return allTime.get(id)?.total ?? 0;
        default:
          return 0;
      }
    };
    const sorted = [...rows].sort((a, b) =>
      sort.key === "name"
        ? a.name.localeCompare(b.name)
        : value(b.id, sort.key) - value(a.id, sort.key),
    );
    return sort.reversed ? sorted.reverse() : sorted;
  }, [doc.students, query, showInactive, sort, recent, allTime]);

  const onSort = (key: SortKey) =>
    setSort((s) => ({ key, reversed: s.key === key ? !s.reversed : false }));

  const create = () => {
    if (!newName.trim()) return;
    const s = addStudent({ name: newName, iep: newIep });
    setNewName("");
    setNewIep(false);
    navigate(studentPath(s.id));
  };

  return (
    <Card>
      <Group justify="space-between" mb="sm" wrap="nowrap">
        <Text fw={600}>Roster</Text>
        <Switch
          size="xs"
          label="Show inactive"
          checked={showInactive}
          onChange={(e) => setShowInactive(e.currentTarget.checked)}
        />
      </Group>

      <Group align="flex-end" gap="xs" mb="sm">
        <TextInput
          style={{ flex: 1 }}
          placeholder="Search students"
          leftSection={<IconSearch size={15} />}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
      </Group>

      <Group align="flex-end" gap="xs" mb="md">
        <TextInput
          style={{ flex: 1 }}
          label="New student"
          placeholder="Full name or initials"
          value={newName}
          onChange={(e) => setNewName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
          }}
        />
        <Checkbox
          label="IEP"
          pb={8}
          checked={newIep}
          onChange={(e) => setNewIep(e.currentTarget.checked)}
        />
        <Button disabled={!newName.trim()} onClick={create}>
          Add
        </Button>
      </Group>

      {roster.length === 0 ? (
        <Text size="sm" c="dimmed" ta="center" py="xl">
          {doc.students.length === 0 ? "No students yet." : "No students match that search."}
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={420}>
          <Table highlightOnHover fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Th sortKey="name" sort={sort} onSort={onSort}>
                  Student
                </Th>
                <Th sortKey="mandate" sort={sort} onSort={onSort} numeric>
                  Mandate/wk
                </Th>
                <Th sortKey="recent" sort={sort} onSort={onSort} numeric>
                  Last 4 wks
                </Th>
                <Th sortKey="all" sort={sort} onSort={onSort} numeric>
                  All time
                </Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {roster.map((s) => (
                <Table.Tr
                  key={s.id}
                  onClick={() => navigate(studentPath(s.id))}
                  style={{ cursor: "pointer" }}
                >
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      {/* A real anchor inside the clickable row, so the name
                          is keyboard-reachable and "open in new tab" works. */}
                      <Anchor
                        component={Link}
                        to={studentPath(s.id)}
                        size="sm"
                        fw={500}
                        c="inherit"
                        underline="hover"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {s.name}
                      </Anchor>
                      <IepBadge iep={s.iep} />
                      {!s.active && (
                        <Badge size="xs" variant="default">
                          inactive
                        </Badge>
                      )}
                    </Group>
                  </Table.Td>
                  <Table.Td className="num">
                    {s.iep && s.mandatedMinutesPerWeek ? fmtDuration(s.mandatedMinutesPerWeek) : "—"}
                  </Table.Td>
                  <Table.Td className="num">
                    {recent.get(s.id)?.total ? `${toHours(recent.get(s.id)!.avgPerWeek)}h/wk` : "—"}
                  </Table.Td>
                  <Table.Td className="num">
                    {allTime.get(s.id)?.total ? `${toHours(allTime.get(s.id)!.total)}h` : "—"}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      <Text size="xs" c="dimmed" mt="xs">
        Averages use workload share (group time split among attendees). Open a student for their
        full history and notes.
      </Text>
    </Card>
  );
}

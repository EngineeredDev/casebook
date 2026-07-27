import { useMemo, useState } from "react";
import {
  Box,
  Button,
  Group,
  Menu,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  useComputedColorScheme,
  useMantineColorScheme,
} from "@mantine/core";
import { BarChart } from "@mantine/charts";
import { IconDownload, IconPrinter } from "@tabler/icons-react";
import { useStore } from "../store.tsx";
import { useChartPalette } from "../theme.tsx";
import {
  categoryName,
  clockTotals,
  filterEntries,
  mandateComparison,
  perCategoryTotals,
  perStudentTotals,
  weekCount,
  weeklyByGroup,
  weeklySummaryRows,
  type Attribution,
} from "../lib/aggregate.ts";
import { downloadCsv, downloadFile } from "../lib/csv.ts";
import { fmtDuration, fmtWeekLabel, toHours, todayYmd } from "../lib/time.ts";
import {
  ATTRIBUTION_OPTIONS,
  ChartTooltip,
  RangePicker,
  Seg,
  StatTile,
  attributionNote,
  defaultRange,
} from "./ui.tsx";

const fmtH = (v: number) => `${v}h`;

export function ReportsPage() {
  const { doc, mutate } = useStore();
  const palette = useChartPalette();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const computed = useComputedColorScheme("light");
  const [range, setRange] = useState(() => defaultRange(doc.settings.schoolYearStartMonth));
  const [attribution, setAttribution] = useState<Attribution>("share");

  const entries = useMemo(() => filterEntries(doc.entries, range.range), [doc.entries, range]);
  const weeks = weekCount(entries, range.range);
  const totals = useMemo(() => clockTotals(entries, doc.categories), [entries, doc.categories]);
  const students = useMemo(
    () =>
      perStudentTotals(entries, doc.students, doc.categories, attribution, range.range).filter(
        (s) => s.total > 0,
      ),
    [entries, doc.students, doc.categories, attribution, range],
  );
  const mandates = useMemo(
    () => mandateComparison(entries, doc.students, doc.categories, range.range),
    [entries, doc.students, doc.categories, range],
  );
  const catTotals = useMemo(
    () => perCategoryTotals(entries, doc.categories),
    [entries, doc.categories],
  );
  const weekly = useMemo(
    () =>
      weeklyByGroup(entries, doc.categories, range.range).map((r) => ({
        week: fmtWeekLabel(r.week),
        Direct: toHours(r.direct),
        Indirect: toHours(r.indirect),
      })),
    [entries, doc.categories, range],
  );

  const topCategory = (studentId: string): string => {
    const byCat = new Map<string, number>();
    for (const e of entries) {
      if (!e.studentIds.includes(studentId)) continue;
      byCat.set(e.categoryId, (byCat.get(e.categoryId) ?? 0) + e.minutes);
    }
    let best: string | null = null;
    let max = 0;
    for (const [cid, min] of byCat) {
      if (min > max) {
        max = min;
        best = cid;
      }
    }
    return best ? categoryName(doc, best) : "—";
  };

  const note = attributionNote(attribution);

  /** Charts take literal colors, so dark mode would print white text on white paper. */
  const print = () => {
    if (computed !== "dark") {
      window.print();
      return;
    }
    const restore = colorScheme;
    setColorScheme("light");
    setTimeout(() => {
      window.print();
      setColorScheme(restore);
    }, 250);
  };

  const exportWeeklyCsv = () => {
    const rows = weeklySummaryRows(entries, doc.students, doc.categories, attribution, range.range);
    downloadCsv(`weekly-summary-${todayYmd()}.csv`, [
      ["Week of", "Student", "IEP", "Direct min", "Indirect min", "Total min", "Total hours"],
      ...rows.map((r) => [
        r.week,
        r.student.name,
        r.student.iep ? "Y" : "N",
        Math.round(r.direct),
        Math.round(r.indirect),
        Math.round(r.total),
        toHours(r.total),
      ]),
    ]);
  };

  /** Notes are deliberately absent — clinical narrative never leaves the app. */
  const exportRawCsv = () => {
    const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
    downloadCsv(`raw-entries-${todayYmd()}.csv`, [
      ["Date", "Start", "Students", "Group size", "Category", "Direct/Indirect", "Minutes"],
      ...sorted.map((e) => [
        e.date,
        e.startTime ?? "",
        e.studentIds
          .map((id) => doc.students.find((s) => s.id === id)?.name ?? "(deleted)")
          .join("; "),
        e.studentIds.length,
        categoryName(doc, e.categoryId),
        doc.categories.find((c) => c.id === e.categoryId)?.group ?? "",
        e.minutes,
      ]),
    ]);
  };

  const exportBackup = () => {
    downloadFile(
      `clinician-tracker-backup-${todayYmd()}.json`,
      JSON.stringify(doc, null, 2),
      "application/json",
    );
  };

  const generated = new Date().toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <Stack gap="md">
      <Group gap="sm" className="no-print">
        <RangePicker
          schoolYearStartMonth={doc.settings.schoolYearStartMonth}
          value={range}
          onChange={setRange}
        />
        <Seg options={ATTRIBUTION_OPTIONS} value={attribution} onChange={setAttribution} />
        <TextInput
          w={210}
          placeholder="Clinician name (for header)"
          value={doc.settings.clinicianName}
          onChange={(e) =>
            mutate((d) => ({ ...d, settings: { ...d.settings, clinicianName: e.target.value } }))
          }
        />
        <Group gap="xs" ml="auto">
          <Menu position="bottom-end" shadow="md">
            <Menu.Target>
              <Button variant="default" leftSection={<IconDownload size={16} />}>
                Export
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>Spreadsheets · no notes</Menu.Label>
              <Menu.Item onClick={exportWeeklyCsv}>CSV · weekly summary</Menu.Item>
              <Menu.Item onClick={exportRawCsv}>CSV · raw entries</Menu.Item>
              <Menu.Divider />
              <Menu.Label>Backup</Menu.Label>
              {/* The one export that carries notes — it has to, or a restore
                  would silently lose every one of them. Say so at the point of
                  export rather than burying it in a doc. */}
              <Menu.Item onClick={exportBackup}>
                Full data file (JSON)
                <Text size="xs" c="dimmed">
                  Includes notes — for restoring, not sharing
                </Text>
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
          <Button leftSection={<IconPrinter size={16} />} onClick={print}>
            Print / Save PDF
          </Button>
        </Group>
      </Group>

      <Paper withBorder p="xl" className="report-sheet">
        <Title order={1}>Caseload time report</Title>
        <Text size="sm" c="dimmed" mt={4} mb="lg">
          {doc.settings.clinicianName ? `${doc.settings.clinicianName} · ` : ""}
          {range.label} · generated {generated}
        </Text>

        <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm" mb="lg">
          <StatTile label="Total time" value={`${toHours(totals.total)}h`} />
          <StatTile
            label="Avg per week"
            value={weeks ? `${toHours(totals.total / weeks)}h` : "—"}
          />
          <StatTile label="Students" value={students.length} />
          <StatTile
            label="Direct / Indirect"
            value={
              totals.total
                ? `${Math.round((totals.direct / totals.total) * 100)} / ${Math.round(
                    (totals.indirect / totals.total) * 100,
                  )}`
                : "—"
            }
          />
        </SimpleGrid>

        <Box className="report-section" mb="lg">
          <Title order={2} mb="xs">
            Hours per week
          </Title>
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
        </Box>

        <Box className="report-section" mb="lg">
          <Title order={2} mb="xs">
            Time per student
          </Title>
          <Table fz="xs" withTableBorder striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Student</Table.Th>
                <Table.Th>IEP</Table.Th>
                <Table.Th className="num">Mandate/wk</Table.Th>
                <Table.Th className="num">Total</Table.Th>
                <Table.Th className="num">Avg/wk</Table.Th>
                <Table.Th className="num">Direct %</Table.Th>
                <Table.Th>Top category</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {students.map((s) => (
                <Table.Tr key={s.student.id}>
                  <Table.Td fw={500}>{s.student.name}</Table.Td>
                  <Table.Td>{s.student.iep ? "Yes" : "—"}</Table.Td>
                  <Table.Td className="num">
                    {s.student.iep && s.student.mandatedMinutesPerWeek
                      ? fmtDuration(s.student.mandatedMinutesPerWeek)
                      : "—"}
                  </Table.Td>
                  <Table.Td className="num">{toHours(s.total)}h</Table.Td>
                  <Table.Td className="num">{toHours(s.avgPerWeek)}h</Table.Td>
                  <Table.Td className="num">
                    {s.total ? Math.round((s.direct / s.total) * 100) : 0}%
                  </Table.Td>
                  <Table.Td>{topCategory(s.student.id)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          <Text size="xs" c="dimmed" mt={6}>
            {note}
          </Text>
        </Box>

        {mandates.length > 0 && (
          <Box className="report-section" mb="lg">
            <Title order={2} mb="xs">
              IEP mandated vs actual service time
            </Title>
            <Table fz="xs" withTableBorder striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Student</Table.Th>
                  <Table.Th className="num">Mandated/wk</Table.Th>
                  <Table.Th className="num">Actual/wk</Table.Th>
                  <Table.Th className="num">Difference</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {mandates.map((m) => {
                  const diff = m.actualPerWeek - m.mandated;
                  return (
                    <Table.Tr key={m.student.id}>
                      <Table.Td fw={500}>{m.student.name}</Table.Td>
                      <Table.Td className="num">{fmtDuration(m.mandated)}</Table.Td>
                      <Table.Td className="num">{fmtDuration(m.actualPerWeek)}</Table.Td>
                      <Table.Td className="num">
                        {diff < 0
                          ? `−${fmtDuration(Math.abs(diff))} under`
                          : `+${fmtDuration(diff)} over`}
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
            <Text size="xs" c="dimmed" mt={6}>
              Actual counts service minutes: group sessions credited in full to each attendee.
            </Text>
          </Box>
        )}

        <Box className="report-section" mb="lg">
          <Title order={2} mb="xs">
            Time by category
          </Title>
          <Table fz="xs" withTableBorder striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Category</Table.Th>
                <Table.Th>Type</Table.Th>
                <Table.Th className="num">Hours</Table.Th>
                <Table.Th className="num">Share</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {catTotals.map((c) => (
                <Table.Tr key={c.category.id}>
                  <Table.Td>{c.category.name}</Table.Td>
                  <Table.Td>{c.category.group === "direct" ? "Direct" : "Indirect"}</Table.Td>
                  <Table.Td className="num">{toHours(c.minutes)}h</Table.Td>
                  <Table.Td className="num">
                    {totals.total ? Math.round((c.minutes / totals.total) * 100) : 0}%
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Box>

        <Text size="xs" c="dimmed">
          Produced with Clinician Tracker. Total time counts each entry once (actual clock time);
          per-student numbers follow the selected attribution method. {note}
        </Text>
      </Paper>
    </Stack>
  );
}

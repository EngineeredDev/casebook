import { useMemo } from "react";
import {
  Anchor,
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
  schoolLevelTotals,
  untimedCount,
  weekCount,
  weeklyByGroup,
  weeklySummaryRows,
} from "../lib/aggregate.ts";
import { exportCsv, exportFile } from "../lib/export.ts";
import { fmtDuration, fmtWeekLabel, toHours, todayYmd } from "../lib/time.ts";
import { useAttributionParam, useRangeParam } from "../lib/urlState.ts";
import { Link, studentPath } from "../lib/router.tsx";
import {
  ATTRIBUTION_OPTIONS,
  ChartTooltip,
  RangePicker,
  Seg,
  StatTile,
  attributionNote,
} from "./ui.tsx";

const fmtH = (v: number) => `${v}h`;

export function ReportsPage() {
  const { doc, mutate } = useStore();
  const palette = useChartPalette();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const computed = useComputedColorScheme("light");
  const [range, setRange] = useRangeParam(doc.settings.schoolYearStartMonth);
  const [attribution, setAttribution] = useAttributionParam();

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
  const untimed = useMemo(() => untimedCount(entries, doc.categories), [entries, doc.categories]);
  const schoolLevel = useMemo(
    () => schoolLevelTotals(entries, doc.categories),
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

  /**
   * Charts take literal colors, so dark mode would print white text on white
   * paper. Switch to light, print, switch back.
   *
   * The switch back waits for `afterprint` rather than for a delay. It used to
   * follow `window.print()` on the next line, which was safe in a browser
   * because print() blocks there until the job is placed — Electron does not
   * guarantee that, and a print() that returns immediately would restore dark
   * mode while the page was still being rendered for paper, producing exactly
   * the unreadable report the switch exists to prevent. The timeout is a
   * backstop for an `afterprint` that never arrives; without it a failure here
   * would leave the app stuck in light mode.
   */
  const print = () => {
    if (computed !== "dark") {
      window.print();
      return;
    }
    const restore = colorScheme;
    setColorScheme("light");

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener("afterprint", finish);
      clearTimeout(backstop);
      setColorScheme(restore);
    };
    window.addEventListener("afterprint", finish);
    const backstop = setTimeout(finish, 60_000);

    // One beat for the repaint, so the dialog previews the light-mode page.
    setTimeout(() => window.print(), 250);
  };

  const exportWeeklyCsv = () => {
    const rows = weeklySummaryRows(entries, doc.students, doc.categories, attribution, range.range);
    void exportCsv(`weekly-summary-${todayYmd()}.csv`, [
      [
        "Week of",
        "Student",
        "Scope",
        "IEP",
        "Direct min",
        "Indirect min",
        "Total min",
        "Total hours",
        "Untimed events",
      ],
      // A school-level row leaves Student and IEP genuinely empty rather than
      // carrying a marker like "(none)", which would sort and filter as though
      // it were somebody's name. "Scope" is what identifies the row, so an
      // empty name cell can never be mistaken for missing data.
      ...rows.map((r) => [
        r.week,
        r.student?.name ?? "",
        r.student ? "Student" : "School-level",
        r.student ? (r.student.iep ? "Y" : "N") : "",
        Math.round(r.direct),
        Math.round(r.indirect),
        Math.round(r.total),
        toHours(r.total),
        r.untimed,
      ]),
    ]);
  };

  /** Notes are deliberately absent — clinical narrative never leaves the app. */
  const exportRawCsv = () => {
    const sorted = entries.toSorted((a, b) => a.date.localeCompare(b.date));
    void exportCsv(`raw-entries-${todayYmd()}.csv`, [
      [
        "Date",
        "Start",
        "Students",
        "Group size",
        "Category",
        "Direct/Indirect",
        "Minutes",
        "Untimed",
      ],
      ...sorted.map((e) => [
        e.date,
        e.startTime ?? "",
        // School-level entries fall out of this as an empty cell, which is the
        // wanted answer — a literal like "(none)" would sort and filter as a
        // student name. Empty is unambiguous here because a student who was
        // deleted still prints as "(deleted)" rather than as nothing, and a
        // group size of 0 says the same thing in the next column.
        e.studentIds
          .map((id) => doc.students.find((s) => s.id === id)?.name ?? "(deleted)")
          .join("; "),
        e.studentIds.length,
        categoryName(doc, e.categoryId),
        doc.categories.find((c) => c.id === e.categoryId)?.group ?? "",
        e.minutes,
        // Distinguishes a deliberate no-time event from a genuine zero, which
        // the Minutes column alone can't do.
        doc.categories.find((c) => c.id === e.categoryId)?.untimed ? "Y" : "N",
      ]),
    ]);
  };

  const exportBackup = () => {
    void exportFile(`casebook-backup-${todayYmd()}.json`, JSON.stringify(doc, null, 2));
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

        {/* The untimed tile only appears once there is something to report, so a
            clinician who never uses untimed categories keeps the tidy four. */}
        <SimpleGrid cols={{ base: 2, sm: untimed ? 5 : 4 }} spacing="sm" mb="lg">
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
          {untimed > 0 && <StatTile label="Untimed" value={untimed} sub="events logged" />}
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
                  <Table.Td fw={500}>
                    {/* Prints as plain text; on screen it opens the student's page. */}
                    <Anchor
                      component={Link}
                      to={studentPath(s.student.id)}
                      c="inherit"
                      underline="hover"
                      inherit
                    >
                      {s.student.name}
                    </Anchor>
                  </Table.Td>
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
          {/* This table and the "Total time" tile above it no longer agree once
              there is school-level work, because nothing in a per-student table
              can hold it. Printed on paper with no way to ask, an unexplained
              gap between two totals reads as an arithmetic error. */}
          {schoolLevel.total > 0 && (
            <Text size="xs" c="dimmed" mt={2}>
              Excludes {toHours(schoolLevel.total)}h of school-level work — meetings, lessons and
              systems time with no student attached. It is counted in the totals above and in Time
              by category below.
            </Text>
          )}
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
                <Table.Th className="num">Entries</Table.Th>
                <Table.Th className="num">Hours</Table.Th>
                <Table.Th className="num">Share</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {catTotals.map((c) => (
                <Table.Tr key={c.category.id}>
                  <Table.Td>{c.category.name}</Table.Td>
                  <Table.Td>
                    {c.category.untimed
                      ? "Untimed"
                      : c.category.group === "direct"
                        ? "Direct"
                        : "Indirect"}
                  </Table.Td>
                  <Table.Td className="num">{c.count}</Table.Td>
                  <Table.Td className="num">
                    {c.category.untimed ? "—" : `${toHours(c.minutes)}h`}
                  </Table.Td>
                  <Table.Td className="num">
                    {c.category.untimed
                      ? "—"
                      : `${totals.total ? Math.round((c.minutes / totals.total) * 100) : 0}%`}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          {untimed > 0 && (
            <Text size="xs" c="dimmed" mt={6}>
              Untimed categories record that something happened — a no-show, a cancellation —
              without adding minutes, so they carry a count instead of hours.
            </Text>
          )}
        </Box>

        <Text size="xs" c="dimmed">
          Produced with Casebook. Total time counts each entry once (actual clock time); per-student
          numbers follow the selected attribution method. {note}
        </Text>
      </Paper>
    </Stack>
  );
}

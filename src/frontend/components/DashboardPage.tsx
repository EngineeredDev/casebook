import { useMemo, useState } from "react";
import { Card, Chip, Grid, Group, SimpleGrid, Stack, Text } from "@mantine/core";
import { BarChart, LineChart } from "@mantine/charts";
import { useStore } from "../store.tsx";
import { useChartPalette } from "../theme.tsx";
import type { ChartPalette } from "../lib/palette.ts";
import {
  clockTotals,
  filterEntries,
  mandateComparison,
  perCategoryTotals,
  perStudentTotals,
  studentWeekMatrix,
  untimedCount,
  weekCount,
  weeklyByGroup,
  type Attribution,
} from "../lib/aggregate.ts";
import { fmtDuration, fmtWeekLabel, toHours } from "../lib/time.ts";
import { timelinePath, useAttributionParam, useRangeParam } from "../lib/urlState.ts";
import {
  ATTRIBUTION_OPTIONS,
  ChartCard,
  ChartTooltip,
  MandateBar,
  RangePicker,
  Seg,
  StatTile,
} from "./ui.tsx";

const fmtH = (v: number) => `${v}h`;

/** Shared tooltip wiring for every chart on this page. */
const tooltip = { content: (p: any) => <ChartTooltip {...p} formatter={fmtH} /> };
const tooltipWithLabels = (labels: Record<string, string>) => ({
  content: (p: any) => <ChartTooltip {...p} formatter={fmtH} labels={labels} />,
});

/** Hairline solid gridlines rather than Mantine's default dashes. */
const GRID = "0";

/**
 * Mantine's `gridAxis` names the axis the lines run *along*, not the direction
 * they are drawn: "x" renders horizontal lines and "y" renders vertical ones.
 * Gridlines belong on the value axis, so vertical-bar charts use "x" and
 * horizontal-bar charts use "y".
 */

export function DashboardPage() {
  const { doc } = useStore();
  const palette = useChartPalette();
  const [range, setRange] = useRangeParam(doc.settings.schoolYearStartMonth);
  const [attribution, setAttribution] = useAttributionParam();

  const entries = useMemo(() => filterEntries(doc.entries, range.range), [doc.entries, range]);
  const weeks = weekCount(entries, range.range);
  const totals = useMemo(() => clockTotals(entries, doc.categories), [entries, doc.categories]);
  const students = useMemo(
    () => perStudentTotals(entries, doc.students, doc.categories, attribution, range.range),
    [entries, doc.students, doc.categories, attribution, range],
  );
  const withTime = students.filter((s) => s.total > 0);

  const iepShare = useMemo(() => {
    const shareTotals = perStudentTotals(
      entries,
      doc.students,
      doc.categories,
      "share",
      range.range,
    );
    const total = shareTotals.reduce((s, r) => s + r.total, 0);
    if (!total) return null;
    const iep = shareTotals.filter((r) => r.student.iep).reduce((s, r) => s + r.total, 0);
    // `minutes` rather than the rounded percentage decides whether the tile
    // links: a caseload with a sliver of IEP time rounds to 0% but still has
    // entries to show.
    return { pct: Math.round((iep / total) * 100), minutes: iep };
  }, [entries, doc.students, doc.categories, range]);

  const weekly = useMemo(
    () =>
      weeklyByGroup(entries, doc.categories, range.range).map((r) => ({
        week: fmtWeekLabel(r.week),
        Direct: toHours(r.direct),
        Indirect: toHours(r.indirect),
      })),
    [entries, doc.categories, range],
  );

  /** Untimed categories are dropped here — an hours chart has no bar to draw for them. */
  const categoryRows = useMemo(
    () =>
      perCategoryTotals(entries, doc.categories)
        .filter((r) => r.minutes > 0)
        .map((r) => ({
          name: r.category.name,
          hours: toHours(r.minutes),
        })),
    [entries, doc.categories],
  );

  const untimed = useMemo(() => untimedCount(entries, doc.categories), [entries, doc.categories]);

  const mandates = useMemo(
    () => mandateComparison(entries, doc.students, doc.categories, range.range),
    [entries, doc.students, doc.categories, range],
  );

  if (doc.entries.length === 0) {
    return (
      <Card>
        <Stack align="center" gap="xs" py="xl">
          <Text fw={600}>No data yet</Text>
          <Text size="sm" c="dimmed">
            Log your first entry and the dashboard will light up.
          </Text>
        </Stack>
      </Card>
    );
  }

  const directPct = totals.total ? Math.round((totals.direct / totals.total) * 100) : 0;

  return (
    <Stack gap="md">
      <Group gap="sm" className="no-print">
        <RangePicker
          schoolYearStartMonth={doc.settings.schoolYearStartMonth}
          value={range}
          onChange={setRange}
        />
        <Seg options={ATTRIBUTION_OPTIONS} value={attribution} onChange={setAttribution} />
        <Text size="xs" c="dimmed">
          {attribution === "share"
            ? "Group time split among attendees — true workload."
            : "Group time credited in full to each attendee — IEP service view."}
        </Text>
      </Group>

      {/* Tiles that stand for a set of entries open that set on the Timeline,
          filtered and dated to match. "Avg per week" and "Students seen" don't:
          neither is a list of entries, so neither has a list to open. */}
      <SimpleGrid cols={{ base: 2, sm: 3, lg: untimed ? 6 : 5 }} spacing="sm">
        <StatTile
          label="Total time"
          value={`${toHours(totals.total)}h`}
          sub={range.label.toLowerCase()}
          to={entries.length ? timelinePath(range) : undefined}
        />
        <StatTile
          label="Avg per week"
          value={weeks ? `${toHours(totals.total / weeks)}h` : "—"}
          sub={`${weeks} week${weeks === 1 ? "" : "s"} of data`}
        />
        <StatTile
          label="Students seen"
          value={withTime.length}
          sub={`${doc.students.filter((s) => s.active).length} on roster`}
        />
        <StatTile
          label="Direct time"
          value={`${directPct}%`}
          sub={`${toHours(totals.direct)}h of ${toHours(totals.total)}h`}
          to={totals.direct ? timelinePath(range, { group: "direct" }) : undefined}
        />
        <StatTile
          label="IEP workload"
          value={iepShare == null ? "—" : `${iepShare.pct}%`}
          sub="share of tracked time"
          to={iepShare?.minutes ? timelinePath(range, { q: "is:iep" }) : undefined}
        />
        {untimed > 0 && (
          <StatTile
            label="Untimed"
            value={untimed}
            sub="no-shows and the like"
            to={timelinePath(range, { q: "is:untimed" })}
          />
        )}
      </SimpleGrid>

      {entries.length === 0 ? (
        <Card>
          <Text size="sm" c="dimmed" ta="center" py="xl">
            No entries in this range.
          </Text>
        </Card>
      ) : (
        <Grid>
          <Grid.Col span={12}>
            <WeeklyChart weekly={weekly} palette={palette} />
          </Grid.Col>
          <Grid.Col span={{ base: 12, lg: 7 }}>
            <StudentLoadChart students={withTime} palette={palette} />
          </Grid.Col>
          <Grid.Col span={{ base: 12, lg: 5 }}>
            <CategoryChart rows={categoryRows} palette={palette} />
          </Grid.Col>
          <Grid.Col span={12}>
            <MandateChart mandates={mandates} palette={palette} />
          </Grid.Col>
          <Grid.Col span={12}>
            <TrendChart
              entries={entries}
              attribution={attribution}
              range={range.range}
              palette={palette}
              topStudents={withTime}
            />
          </Grid.Col>
        </Grid>
      )}
    </Stack>
  );
}

function WeeklyChart({
  weekly,
  palette,
}: {
  weekly: { week: string; Direct: number; Indirect: number }[];
  palette: ChartPalette;
}) {
  return (
    <ChartCard
      title="Hours per week"
      sub="Actual clock time, split direct vs indirect"
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
      <BarChart
        h={260}
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
        strokeDasharray={GRID}
        valueFormatter={fmtH}
        yAxisProps={{ tickFormatter: fmtH }}
        tooltipProps={tooltip}
      />
    </ChartCard>
  );
}

/**
 * Axis label that appends an IEP marker, so the flag isn't carried by color
 * alone. Lives at module scope so the tick keeps a stable component type;
 * Recharts clones it with x/y/payload, and data/palette come from the caller.
 */
function StudentLoadTick({
  x = 0,
  y = 0,
  payload,
  rows,
  palette,
}: {
  x?: number;
  y?: number;
  payload?: { value?: string };
  rows: { name: string; iep: boolean }[];
  palette: ChartPalette;
}) {
  const row = rows.find((d) => d.name === payload?.value);
  return (
    <text x={x} y={y} dy={4} textAnchor="end" fill={palette.textSecondary} fontSize={12}>
      {payload?.value}
      {row?.iep ? (
        <tspan fill={palette.series[0]} fontSize={9} fontWeight={700} dx={4} dy={-1}>
          IEP
        </tspan>
      ) : null}
    </text>
  );
}

function StudentLoadChart({
  students,
  palette,
}: {
  students: ReturnType<typeof perStudentTotals>;
  palette: ChartPalette;
}) {
  const data = students.map((s) => ({
    name: s.student.name,
    iep: s.student.iep,
    Direct: toHours(s.direct),
    Indirect: toHours(s.indirect),
    totalH: toHours(s.total),
    avgH: toHours(s.avgPerWeek),
  }));
  const height = Math.max(180, data.length * 34 + 60);

  return (
    <ChartCard
      title="Time per student"
      sub="Ranked by total time in range"
      table={{
        headers: ["Student", "Direct (h)", "Indirect (h)", "Total (h)", "Avg h/wk"],
        rows: data.map((d) => [
          d.name + (d.iep ? " (IEP)" : ""),
          d.Direct,
          d.Indirect,
          d.totalH,
          d.avgH,
        ]),
      }}
    >
      <BarChart
        h={height}
        data={data}
        dataKey="name"
        orientation="vertical"
        type="stacked"
        withLegend
        legendProps={{ verticalAlign: "top", height: 32 }}
        series={[
          { name: "Direct", color: palette.direct },
          { name: "Indirect", color: palette.indirect },
        ]}
        maxBarWidth={18}
        barProps={(series) => ({
          stroke: palette.surface,
          strokeWidth: 1,
          radius: series.name === "Indirect" ? [0, 4, 4, 0] : 0,
        })}
        gridAxis="y"
        tickLine="none"
        strokeDasharray={GRID}
        valueFormatter={fmtH}
        xAxisProps={{ tickFormatter: fmtH }}
        yAxisProps={{ width: 140, tick: <StudentLoadTick rows={data} palette={palette} /> }}
        tooltipProps={tooltip}
      />
    </ChartCard>
  );
}

function CategoryChart({
  rows,
  palette,
}: {
  rows: { name: string; hours: number }[];
  palette: ChartPalette;
}) {
  const height = Math.max(180, rows.length * 32 + 60);
  return (
    <ChartCard
      title="Where the time goes"
      sub="Actual clock time by category"
      table={{ headers: ["Category", "Hours"], rows: rows.map((r) => [r.name, r.hours]) }}
    >
      <BarChart
        h={height}
        data={rows}
        dataKey="name"
        orientation="vertical"
        series={[{ name: "hours", label: "Time", color: palette.series[0] }]}
        maxBarWidth={16}
        barProps={{ radius: [0, 4, 4, 0] }}
        withBarValueLabel
        valueLabelProps={{ position: "right", fill: palette.textSecondary, fontSize: 11 }}
        gridAxis="y"
        tickLine="none"
        strokeDasharray={GRID}
        valueFormatter={fmtH}
        xAxisProps={{ tickFormatter: fmtH }}
        yAxisProps={{ width: 172 }}
        tooltipProps={tooltipWithLabels({ hours: "Time" })}
      />
    </ChartCard>
  );
}

function MandateChart({
  mandates,
  palette,
}: {
  mandates: ReturnType<typeof mandateComparison>;
  palette: ChartPalette;
}) {
  const max = Math.max(...mandates.map((m) => Math.max(m.actualPerWeek, m.mandated)), 1);
  return (
    <ChartCard
      title="IEP mandate vs actual"
      sub="Avg service minutes per week (group time counted in full) · marker = mandated"
      table={{
        headers: ["Student", "Mandated/wk", "Actual/wk"],
        rows: mandates.map((m) => [
          m.student.name,
          fmtDuration(m.mandated),
          fmtDuration(m.actualPerWeek),
        ]),
      }}
    >
      {mandates.length === 0 ? (
        <Text size="sm" c="dimmed" ta="center" py="xl">
          No IEP students with mandated minutes yet — set them on the Students tab to unlock this
          view.
        </Text>
      ) : (
        <Stack gap={6}>
          {mandates.map((m) => (
            <MandateBar
              key={m.student.id}
              name={m.student.name}
              mandated={m.mandated}
              actualPerWeek={m.actualPerWeek}
              max={max}
              palette={palette}
            />
          ))}
        </Stack>
      )}
    </ChartCard>
  );
}

function TrendChart({
  entries,
  attribution,
  range,
  palette,
  topStudents,
}: {
  entries: ReturnType<typeof filterEntries>;
  attribution: Attribution;
  range: { from: string; to: string };
  palette: ChartPalette;
  topStudents: ReturnType<typeof perStudentTotals>;
}) {
  /**
   * Color follows the student's position in this pool rather than the order
   * they were picked, so deselecting one line never repaints the others.
   * Capped at the number of categorical slots so two lines can't collide.
   */
  const pool = topStudents.slice(0, palette.series.length);
  const [selected, setSelected] = useState<string[]>(() =>
    pool.slice(0, 3).map((s) => s.student.id),
  );
  const matrix = useMemo(
    () => studentWeekMatrix(entries, attribution, range),
    [entries, attribution, range],
  );

  /**
   * Series keys are synthetic because Mantine reads a "." in a series name as a
   * nested-object path — a student named "Casey L." would silently lose its
   * legend and tooltip label. Display names ride along as `label`.
   */
  const series = pool
    .map((s, i) => ({
      key: `s${i}`,
      id: s.student.id,
      name: s.student.name,
      color: palette.series[i],
    }))
    .filter((s) => selected.includes(s.id));
  const labels = Object.fromEntries(series.map((s) => [s.key, s.name]));

  const data = matrix.weeks.map((w) => {
    const row: Record<string, string | number> = { week: fmtWeekLabel(w) };
    for (const s of series) row[s.key] = toHours(matrix.byWeek.get(w)?.get(s.id) ?? 0);
    return row;
  });

  return (
    <ChartCard
      title="Student trends week by week"
      sub="Pick up to 6 students to compare"
      table={{
        headers: ["Week", ...series.map((s) => `${s.name} (h)`)],
        rows: data.map((r) => [r.week as string, ...series.map((s) => r[s.key] as number)]),
      }}
    >
      <Chip.Group
        multiple
        value={series.map((s) => s.id)}
        onChange={(v) => setSelected(v.length > 6 ? v.slice(-6) : v)}
      >
        <Group gap={6} mb="sm">
          {pool.map((s) => (
            <Chip key={s.student.id} value={s.student.id} size="xs" variant="outline">
              {s.student.name}
            </Chip>
          ))}
        </Group>
      </Chip.Group>

      {series.length === 0 ? (
        <Text size="sm" c="dimmed" ta="center" py="xl">
          Select a student above.
        </Text>
      ) : (
        <LineChart
          h={260}
          data={data}
          dataKey="week"
          withLegend
          legendProps={{ verticalAlign: "top", height: 32 }}
          series={series.map((s) => ({ name: s.key, label: s.name, color: s.color }))}
          curveType="monotone"
          strokeWidth={2}
          withDots={false}
          activeDotProps={{ r: 4, stroke: palette.surface, strokeWidth: 2 }}
          gridAxis="x"
          tickLine="none"
          strokeDasharray={GRID}
          valueFormatter={fmtH}
          yAxisProps={{ tickFormatter: fmtH }}
          tooltipProps={tooltipWithLabels(labels)}
        />
      )}
    </ChartCard>
  );
}

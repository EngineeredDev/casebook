import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useStore } from "../store.tsx";
import { useTheme } from "../theme.tsx";
import {
  clockTotals,
  filterEntries,
  mandateComparison,
  perCategoryTotals,
  perStudentTotals,
  studentWeekMatrix,
  weekCount,
  weeklyByGroup,
  type Attribution,
} from "../lib/aggregate.ts";
import { fmtDuration, fmtWeekLabel, toHours } from "../lib/time.ts";
import { ChartCard, ChartTooltip, IepBadge, LegendRow, RangePicker, Seg, StatTile, defaultRange } from "./ui.tsx";

const fmtH = (v: number) => `${v}h`;

export function DashboardPage() {
  const { doc } = useStore();
  const { palette } = useTheme();
  const [range, setRange] = useState(() => defaultRange(doc.settings.schoolYearStartMonth));
  const [attribution, setAttribution] = useState<Attribution>("share");

  const entries = useMemo(() => filterEntries(doc.entries, range.range), [doc.entries, range]);
  const weeks = weekCount(entries, range.range);
  const totals = useMemo(() => clockTotals(entries, doc.categories), [entries, doc.categories]);
  const students = useMemo(
    () => perStudentTotals(entries, doc.students, doc.categories, attribution, range.range),
    [entries, doc.students, doc.categories, attribution, range],
  );
  const withTime = students.filter((s) => s.total > 0);

  const iepShare = useMemo(() => {
    const shareTotals = perStudentTotals(entries, doc.students, doc.categories, "share", range.range);
    const total = shareTotals.reduce((s, r) => s + r.total, 0);
    if (!total) return null;
    const iep = shareTotals.filter((r) => r.student.iep).reduce((s, r) => s + r.total, 0);
    return Math.round((iep / total) * 100);
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

  const categoryRows = useMemo(
    () =>
      perCategoryTotals(entries, doc.categories).map((r) => ({
        name: r.category.name,
        hours: toHours(r.minutes),
        minutes: r.minutes,
      })),
    [entries, doc.categories],
  );

  const mandates = useMemo(
    () => mandateComparison(entries, doc.students, doc.categories, range.range),
    [entries, doc.students, doc.categories, range],
  );

  if (doc.entries.length === 0) {
    return (
      <div className="empty-state">
        <h2>No data yet</h2>
        <p>Log your first entry on the Log tab and the dashboard will light up.</p>
      </div>
    );
  }

  const directPct = totals.total ? Math.round((totals.direct / totals.total) * 100) : 0;

  return (
    <div>
      <div className="filter-row no-print">
        <RangePicker
          schoolYearStartMonth={doc.settings.schoolYearStartMonth}
          value={range}
          onChange={setRange}
        />
        <Seg
          options={[
            { key: "share", label: "Workload share" },
            { key: "service", label: "Service minutes" },
          ]}
          value={attribution}
          onChange={setAttribution}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          {attribution === "share"
            ? "Group time split among attendees — true workload."
            : "Group time credited in full to each attendee — IEP service view."}
        </span>
      </div>

      <div className="stat-row">
        <StatTile
          label="Total time"
          value={`${toHours(totals.total)}h`}
          sub={`${range.label.toLowerCase()}`}
        />
        <StatTile
          label="Avg per week"
          value={weeks ? `${toHours(totals.total / weeks)}h` : "—"}
          sub={`${weeks} week${weeks === 1 ? "" : "s"} of data`}
        />
        <StatTile label="Students seen" value={withTime.length} sub={`${doc.students.filter((s) => s.active).length} on roster`} />
        <StatTile label="Direct time" value={`${directPct}%`} sub={`${toHours(totals.direct)}h of ${toHours(totals.total)}h`} />
        <StatTile
          label="IEP workload"
          value={iepShare == null ? "—" : `${iepShare}%`}
          sub="share of tracked time"
        />
      </div>

      {entries.length === 0 ? (
        <div className="empty-state">No entries in this range.</div>
      ) : (
        <div className="chart-grid">
          <WeeklyChart weekly={weekly} palette={palette} />
          <StudentLoadChart students={withTime} palette={palette} />
          <CategoryChart rows={categoryRows} palette={palette} />
          <MandateChart mandates={mandates} />
          <TrendChart
            doc={doc}
            entries={entries}
            attribution={attribution}
            range={range.range}
            palette={palette}
            topStudents={withTime}
          />
        </div>
      )}
    </div>
  );
}

function WeeklyChart({
  weekly,
  palette,
}: {
  weekly: { week: string; Direct: number; Indirect: number }[];
  palette: ReturnType<typeof useTheme>["palette"];
}) {
  return (
    <ChartCard
      title="Hours per week"
      sub="Actual clock time, split direct vs indirect"
      wide
      legend={
        <LegendRow
          items={[
            { label: "Direct", color: palette.direct },
            { label: "Indirect", color: palette.indirect },
          ]}
        />
      }
      table={{
        headers: ["Week", "Direct (h)", "Indirect (h)", "Total (h)"],
        rows: weekly.map((w) => [w.week, w.Direct, w.Indirect, Math.round((w.Direct + w.Indirect) * 10) / 10]),
      }}
    >
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={weekly} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid stroke={palette.gridline} vertical={false} />
          <XAxis
            dataKey="week"
            tickLine={false}
            axisLine={{ stroke: palette.baseline }}
            tick={{ fill: palette.muted, fontSize: 11 }}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={{ fill: palette.muted, fontSize: 11 }}
            tickFormatter={fmtH}
          />
          <Tooltip
            cursor={{ fill: palette.gridline, opacity: 0.35 }}
            content={<ChartTooltip formatter={fmtH} />}
          />
          <Bar isAnimationActive={false} dataKey="Direct" stackId="w" fill={palette.direct} maxBarSize={24} stroke={palette.surface} strokeWidth={1} />
          <Bar
            isAnimationActive={false}
            dataKey="Indirect"
            stackId="w"
            fill={palette.indirect}
            maxBarSize={24}
            radius={[4, 4, 0, 0]}
            stroke={palette.surface}
            strokeWidth={1}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

function StudentLoadChart({
  students,
  palette,
}: {
  students: ReturnType<typeof perStudentTotals>;
  palette: ReturnType<typeof useTheme>["palette"];
}) {
  const data = students.map((s) => ({
    name: s.student.name,
    iep: s.student.iep,
    Direct: toHours(s.direct),
    Indirect: toHours(s.indirect),
    totalH: toHours(s.total),
    avgH: toHours(s.avgPerWeek),
  }));
  const height = Math.max(160, data.length * 34 + 50);

  const Tick = (props: { x?: number; y?: number; payload?: { value?: string } }) => {
    const { x = 0, y = 0, payload } = props;
    const row = data.find((d) => d.name === payload?.value);
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
  };

  return (
    <ChartCard
      title="Time per student"
      sub="Ranked by total time in range · label shows avg hours/week"
      wide
      legend={
        <LegendRow
          items={[
            { label: "Direct", color: palette.direct },
            { label: "Indirect", color: palette.indirect },
          ]}
        />
      }
      table={{
        headers: ["Student", "Direct (h)", "Indirect (h)", "Total (h)", "Avg h/wk"],
        rows: data.map((d) => [d.name + (d.iep ? " (IEP)" : ""), d.Direct, d.Indirect, d.totalH, d.avgH]),
      }}
    >
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 64, left: 40, bottom: 0 }}>
          <CartesianGrid stroke={palette.gridline} horizontal={false} />
          <XAxis
            type="number"
            tickLine={false}
            axisLine={{ stroke: palette.baseline }}
            tick={{ fill: palette.muted, fontSize: 11 }}
            tickFormatter={fmtH}
          />
          <YAxis type="category" dataKey="name" width={130} tickLine={false} axisLine={false} tick={<Tick />} />
          <Tooltip
            cursor={{ fill: palette.gridline, opacity: 0.35 }}
            content={<ChartTooltip formatter={fmtH} />}
          />
          <Bar isAnimationActive={false} dataKey="Direct" stackId="s" fill={palette.direct} maxBarSize={18} stroke={palette.surface} strokeWidth={1} />
          <Bar
            isAnimationActive={false}
            dataKey="Indirect"
            stackId="s"
            fill={palette.indirect}
            maxBarSize={18}
            radius={[0, 4, 4, 0]}
            stroke={palette.surface}
            strokeWidth={1}
          >
            <LabelList
              dataKey="avgH"
              position="right"
              formatter={(v: number) => `${v}h/wk`}
              style={{ fill: palette.textSecondary, fontSize: 11, fontVariantNumeric: "tabular-nums" }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

function CategoryChart({
  rows,
  palette,
}: {
  rows: { name: string; hours: number; minutes: number }[];
  palette: ReturnType<typeof useTheme>["palette"];
}) {
  const height = Math.max(150, rows.length * 32 + 50);
  return (
    <ChartCard
      title="Where the time goes"
      sub="Actual clock time by category"
      table={{
        headers: ["Category", "Hours"],
        rows: rows.map((r) => [r.name, r.hours]),
      }}
    >
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 52, left: 60, bottom: 0 }}>
          <CartesianGrid stroke={palette.gridline} horizontal={false} />
          <XAxis
            type="number"
            tickLine={false}
            axisLine={{ stroke: palette.baseline }}
            tick={{ fill: palette.muted, fontSize: 11 }}
            tickFormatter={fmtH}
          />
          <YAxis
            type="category"
            dataKey="name"
            width={150}
            tickLine={false}
            axisLine={false}
            tick={{ fill: palette.textSecondary, fontSize: 12 }}
          />
          <Tooltip
            cursor={{ fill: palette.gridline, opacity: 0.35 }}
            content={<ChartTooltip formatter={fmtH} />}
          />
          <Bar isAnimationActive={false} dataKey="hours" name="Time" fill={palette.series[0]} maxBarSize={16} radius={[0, 4, 4, 0]}>
            <LabelList
              dataKey="hours"
              position="right"
              formatter={fmtH}
              style={{ fill: palette.textSecondary, fontSize: 11, fontVariantNumeric: "tabular-nums" }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

function MandateChart({ mandates }: { mandates: ReturnType<typeof mandateComparison> }) {
  const max = Math.max(...mandates.map((m) => Math.max(m.actualPerWeek, m.mandated)), 1);
  return (
    <ChartCard
      title="IEP mandate vs actual"
      sub="Avg service minutes per week (group time counted in full) · tick = mandated"
      table={{
        headers: ["Student", "Mandated/wk", "Actual/wk"],
        rows: mandates.map((m) => [m.student.name, fmtDuration(m.mandated), fmtDuration(m.actualPerWeek)]),
      }}
    >
      {mandates.length === 0 ? (
        <div className="empty-state">
          No IEP students with mandated minutes yet.
          <br />
          Set them on the Students tab to unlock this view.
        </div>
      ) : (
        <div>
          {mandates.map((m) => {
            const diff = m.actualPerWeek - m.mandated;
            const under = diff < -1;
            return (
              <div className="bullet-row" key={m.student.id}>
                <span className="bullet-name">{m.student.name}</span>
                <div className="bullet-track">
                  <div className="bullet-fill" style={{ width: `${(m.actualPerWeek / max) * 100}%` }} />
                  <div className="bullet-tick" style={{ left: `${(m.mandated / max) * 100}%` }} />
                </div>
                <span className="bullet-val">
                  {fmtDuration(m.actualPerWeek)} vs {fmtDuration(m.mandated)}
                  {" · "}
                  {under ? (
                    <span className="under">▼ {fmtDuration(Math.abs(diff))} under</span>
                  ) : (
                    <span>+{fmtDuration(Math.max(0, diff))} over</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </ChartCard>
  );
}

function TrendChart({
  doc,
  entries,
  attribution,
  range,
  palette,
  topStudents,
}: {
  doc: ReturnType<typeof useStore>["doc"];
  entries: ReturnType<typeof filterEntries>;
  attribution: Attribution;
  range: { from: string; to: string };
  palette: ReturnType<typeof useTheme>["palette"];
  topStudents: ReturnType<typeof perStudentTotals>;
}) {
  const [selected, setSelected] = useState<string[]>(() =>
    topStudents.slice(0, 3).map((s) => s.student.id),
  );
  const matrix = useMemo(
    () => studentWeekMatrix(entries, attribution, range),
    [entries, attribution, range],
  );

  const shown = selected.filter((id) => doc.students.some((s) => s.id === id));
  const data = matrix.weeks.map((w) => {
    const row: Record<string, string | number> = { week: fmtWeekLabel(w) };
    for (const id of shown) {
      const name = doc.students.find((s) => s.id === id)?.name ?? "?";
      row[name] = toHours(matrix.byWeek.get(w)?.get(id) ?? 0);
    }
    return row;
  });

  const toggle = (id: string) =>
    setSelected((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= 6 ? cur : [...cur, id],
    );

  const names = shown.map((id) => doc.students.find((s) => s.id === id)?.name ?? "?");

  return (
    <ChartCard
      title="Student trends week by week"
      sub="Pick up to 6 students to compare"
      wide
      legend={
        names.length > 0 ? (
          <LegendRow items={names.map((n, i) => ({ label: n, color: palette.series[i], line: true }))} />
        ) : undefined
      }
      table={{
        headers: ["Week", ...names.map((n) => `${n} (h)`)],
        rows: data.map((r) => [r.week as string, ...names.map((n) => r[n] as number)]),
      }}
    >
      <div className="chip-row" style={{ marginBottom: 10 }}>
        {topStudents.slice(0, 12).map((s) => (
          <button
            key={s.student.id}
            type="button"
            className={`chip small${shown.includes(s.student.id) ? " selected" : ""}`}
            onClick={() => toggle(s.student.id)}
          >
            {s.student.name}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <div className="empty-state">Select a student above.</div>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={data} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
            <CartesianGrid stroke={palette.gridline} vertical={false} />
            <XAxis
              dataKey="week"
              tickLine={false}
              axisLine={{ stroke: palette.baseline }}
              tick={{ fill: palette.muted, fontSize: 11 }}
            />
            <YAxis tickLine={false} axisLine={false} tick={{ fill: palette.muted, fontSize: 11 }} tickFormatter={fmtH} />
            <Tooltip
              cursor={{ stroke: palette.baseline, strokeWidth: 1 }}
              content={<ChartTooltip formatter={fmtH} />}
            />
            {names.map((n, i) => (
              <Line
                isAnimationActive={false}
                key={n}
                type="monotone"
                dataKey={n}
                stroke={palette.series[i]}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, stroke: palette.surface, strokeWidth: 2 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

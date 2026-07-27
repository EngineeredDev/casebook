import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
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
  weekCount,
  weeklyByGroup,
  weeklySummaryRows,
  categoryName,
  type Attribution,
} from "../lib/aggregate.ts";
import { downloadCsv, downloadFile } from "../lib/csv.ts";
import { fmtDuration, fmtWeekLabel, toHours, todayYmd } from "../lib/time.ts";
import { ChartTooltip, LegendRow, RangePicker, Seg, defaultRange } from "./ui.tsx";

const fmtH = (v: number) => `${v}h`;

export function ReportsPage() {
  const { doc, mutate } = useStore();
  const { palette } = useTheme();
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
  const catTotals = useMemo(() => perCategoryTotals(entries, doc.categories), [entries, doc.categories]);
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

  const attributionNote =
    attribution === "share"
      ? "Group sessions are split evenly among attendees (workload view)."
      : "Group sessions are credited in full to each attendee (service-minutes view).";

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

  const exportRawCsv = () => {
    const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
    downloadCsv(`raw-entries-${todayYmd()}.csv`, [
      ["Date", "Start", "Students", "Group size", "Category", "Direct/Indirect", "Minutes", "Note"],
      ...sorted.map((e) => [
        e.date,
        e.startTime ?? "",
        e.studentIds.map((id) => doc.students.find((s) => s.id === id)?.name ?? "(deleted)").join("; "),
        e.studentIds.length,
        categoryName(doc, e.categoryId),
        doc.categories.find((c) => c.id === e.categoryId)?.group ?? "",
        e.minutes,
        e.note ?? "",
      ]),
    ]);
  };

  const exportBackup = () => {
    downloadFile(`clinician-tracker-backup-${todayYmd()}.json`, JSON.stringify(doc, null, 2), "application/json");
  };

  const generated = new Date().toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div>
      <div className="report-toolbar no-print">
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
        <input
          className="input"
          style={{ width: 200 }}
          placeholder="Clinician name (for header)"
          value={doc.settings.clinicianName}
          onChange={(e) =>
            mutate((d) => ({ ...d, settings: { ...d.settings, clinicianName: e.target.value } }))
          }
        />
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn" onClick={exportWeeklyCsv}>
          CSV · weekly
        </button>
        <button className="btn" onClick={exportRawCsv}>
          CSV · raw
        </button>
        <button className="btn" onClick={exportBackup}>
          Backup JSON
        </button>
        <button className="btn primary" onClick={() => window.print()}>
          Print / Save PDF
        </button>
      </div>

      <div className="report-sheet">
        <h1>Caseload time report</h1>
        <div className="report-meta">
          {doc.settings.clinicianName ? `${doc.settings.clinicianName} · ` : ""}
          {range.label} · generated {generated}
        </div>

        <div className="stat-row">
          <div className="stat-tile">
            <div className="stat-label">Total time</div>
            <div className="stat-value">{toHours(totals.total)}h</div>
          </div>
          <div className="stat-tile">
            <div className="stat-label">Avg per week</div>
            <div className="stat-value">{weeks ? `${toHours(totals.total / weeks)}h` : "—"}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-label">Students</div>
            <div className="stat-value">{students.length}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-label">Direct / Indirect</div>
            <div className="stat-value">
              {totals.total
                ? `${Math.round((totals.direct / totals.total) * 100)} / ${Math.round((totals.indirect / totals.total) * 100)}`
                : "—"}
            </div>
          </div>
        </div>

        <div className="report-section">
          <h2>Hours per week</h2>
          <LegendRow
            items={[
              { label: "Direct", color: palette.direct },
              { label: "Indirect", color: palette.indirect },
            ]}
          />
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={weekly} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid stroke={palette.gridline} vertical={false} />
              <XAxis
                dataKey="week"
                tickLine={false}
                axisLine={{ stroke: palette.baseline }}
                tick={{ fill: palette.muted, fontSize: 11 }}
              />
              <YAxis tickLine={false} axisLine={false} tick={{ fill: palette.muted, fontSize: 11 }} tickFormatter={fmtH} />
              <Tooltip cursor={{ fill: palette.gridline, opacity: 0.35 }} content={<ChartTooltip formatter={fmtH} />} />
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
        </div>

        <div className="report-section">
          <h2>Time per student</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>Student</th>
                <th>IEP</th>
                <th className="num">Mandate/wk</th>
                <th className="num">Total</th>
                <th className="num">Avg/wk</th>
                <th className="num">Direct %</th>
                <th>Top category</th>
              </tr>
            </thead>
            <tbody>
              {students.map((s) => (
                <tr key={s.student.id}>
                  <td>
                    <strong>{s.student.name}</strong>
                  </td>
                  <td>{s.student.iep ? "Yes" : "—"}</td>
                  <td className="num">
                    {s.student.iep && s.student.mandatedMinutesPerWeek
                      ? fmtDuration(s.student.mandatedMinutesPerWeek)
                      : "—"}
                  </td>
                  <td className="num">{toHours(s.total)}h</td>
                  <td className="num">{toHours(s.avgPerWeek)}h</td>
                  <td className="num">{s.total ? Math.round((s.direct / s.total) * 100) : 0}%</td>
                  <td>{topCategory(s.student.id)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="footnote">{attributionNote}</div>
        </div>

        {mandates.length > 0 && (
          <div className="report-section">
            <h2>IEP mandated vs actual service time</h2>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Student</th>
                  <th className="num">Mandated/wk</th>
                  <th className="num">Actual/wk</th>
                  <th className="num">Difference</th>
                </tr>
              </thead>
              <tbody>
                {mandates.map((m) => {
                  const diff = m.actualPerWeek - m.mandated;
                  return (
                    <tr key={m.student.id}>
                      <td>
                        <strong>{m.student.name}</strong>
                      </td>
                      <td className="num">{fmtDuration(m.mandated)}</td>
                      <td className="num">{fmtDuration(m.actualPerWeek)}</td>
                      <td className="num">
                        {diff < 0 ? `−${fmtDuration(Math.abs(diff))} under` : `+${fmtDuration(diff)} over`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="footnote">
              Actual counts service minutes: group sessions credited in full to each attendee.
            </div>
          </div>
        )}

        <div className="report-section">
          <h2>Time by category</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>Category</th>
                <th>Type</th>
                <th className="num">Hours</th>
                <th className="num">Share</th>
              </tr>
            </thead>
            <tbody>
              {catTotals.map((c) => (
                <tr key={c.category.id}>
                  <td>{c.category.name}</td>
                  <td>{c.category.group === "direct" ? "Direct" : "Indirect"}</td>
                  <td className="num">{toHours(c.minutes)}h</td>
                  <td className="num">{totals.total ? Math.round((c.minutes / totals.total) * 100) : 0}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="footnote report-section">
          Produced with Clinician Tracker. Total time counts each entry once (actual clock time);
          per-student numbers follow the selected attribution method. {attributionNote}
        </div>
      </div>
    </div>
  );
}

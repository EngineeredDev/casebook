import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTheme } from "../theme.tsx";
import { rangePresets, type DateRange, todayYmd, addDaysYmd } from "../lib/time.ts";

export function useClickOutside(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);
  return ref;
}

export function StatTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="stat-tile">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub != null && <div className="stat-delta">{sub}</div>}
    </div>
  );
}

export function Seg<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg" role="group">
      {options.map((o) => (
        <button
          key={o.key}
          className={o.key === value ? "active" : ""}
          onClick={() => onChange(o.key)}
          type="button"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export interface RangeSelection {
  key: string;
  label: string;
  range: DateRange;
}

export function defaultRange(schoolYearStartMonth: number): RangeSelection {
  const preset = rangePresets(schoolYearStartMonth).find((p) => p.key === "12-weeks")!;
  return { key: preset.key, label: preset.label, range: preset.range() };
}

export function RangePicker({
  schoolYearStartMonth,
  value,
  onChange,
}: {
  schoolYearStartMonth: number;
  value: RangeSelection;
  onChange: (v: RangeSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState(addDaysYmd(todayYmd(), -28));
  const [customTo, setCustomTo] = useState(todayYmd());
  const ref = useClickOutside(() => setOpen(false));
  const presets = rangePresets(schoolYearStartMonth);

  return (
    <div className="range-menu-wrap" ref={ref}>
      <button className="btn" type="button" onClick={() => setOpen((o) => !o)}>
        {value.label} ▾
      </button>
      {open && (
        <div className="range-menu">
          {presets.map((p) => (
            <button
              key={p.key}
              type="button"
              className="range-item"
              onClick={() => {
                onChange({ key: p.key, label: p.label, range: p.range() });
                setOpen(false);
              }}
            >
              <span>{p.label}</span>
              {value.key === p.key && <span className="check">✓</span>}
            </button>
          ))}
          <div className="range-custom">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              aria-label="Custom range start"
            />
            <span>–</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              aria-label="Custom range end"
            />
            <button
              className="btn small"
              type="button"
              disabled={!customFrom || !customTo || customFrom > customTo}
              onClick={() => {
                onChange({
                  key: "custom",
                  label: `${customFrom} – ${customTo}`,
                  range: { from: customFrom, to: customTo },
                });
                setOpen(false);
              }}
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function IepBadge({ iep }: { iep: boolean }) {
  if (!iep) return null;
  return <span className="badge iep">IEP</span>;
}

/**
 * Chart container with a "view as table" twin so no value is gated behind
 * hover or color perception.
 */
export function ChartCard({
  title,
  sub,
  wide,
  legend,
  table,
  children,
}: {
  title: string;
  sub?: string;
  wide?: boolean;
  legend?: ReactNode;
  table?: { headers: string[]; rows: (string | number)[][] };
  children: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <div className={`chart-card${wide ? " wide" : ""}`}>
      <div className="card-head">
        <div>
          <div className="card-title">{title}</div>
          {sub && <div className="card-sub">{sub}</div>}
        </div>
        {table && (
          <button
            className="btn small no-print"
            type="button"
            onClick={() => setShowTable((s) => !s)}
          >
            {showTable ? "Chart" : "Table"}
          </button>
        )}
      </div>
      {legend}
      {showTable && table ? (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                {table.headers.map((h, i) => (
                  <th key={h} className={i === 0 ? "" : "num"}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} className={j === 0 ? "" : "num"}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        children
      )}
    </div>
  );
}

export function LegendRow({ items }: { items: { label: string; color: string; line?: boolean }[] }) {
  return (
    <div className="legend-row">
      {items.map((i) => (
        <span key={i.label} className="legend-key">
          <span
            className={i.line ? "legend-line" : "legend-swatch"}
            style={{ background: i.color }}
          />
          {i.label}
        </span>
      ))}
    </div>
  );
}

/** Recharts custom tooltip: values lead, series names follow, line keys not boxes. */
export function ChartTooltip({
  active,
  label,
  payload,
  formatter,
}: {
  active?: boolean;
  label?: string | number;
  payload?: { name?: string; value?: number | string; color?: string }[];
  formatter?: (v: number) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="chart-tooltip">
      {label != null && <div className="tt-title">{String(label)}</div>}
      {payload.map((p, i) => (
        <div className="tt-row" key={i}>
          <span className="tt-key" style={{ background: p.color }} />
          <span className="tt-val">
            {formatter && typeof p.value === "number" ? formatter(p.value) : String(p.value)}
          </span>
          <span className="tt-name">{p.name}</span>
        </div>
      ))}
    </div>
  );
}

/** 12-point sparkline in the de-emphasis hue, current period in the accent. */
export function Sparkline({ points, width = 96, height = 28 }: { points: number[]; width?: number; height?: number }) {
  const { palette } = useTheme();
  if (points.length < 2) return null;
  const max = Math.max(...points, 1);
  const step = width / (points.length - 1);
  const y = (v: number) => height - 3 - (v / max) * (height - 6);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
  const lastX = (points.length - 1) * step;
  return (
    <svg width={width} height={height} aria-hidden="true">
      <path d={d} fill="none" stroke={palette.deEmphasis} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastX} cy={y(points[points.length - 1])} r="4" fill={palette.series[0]} stroke={palette.surface} strokeWidth="2" />
    </svg>
  );
}

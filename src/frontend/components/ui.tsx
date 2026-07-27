import { useState, type ReactNode } from "react";
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Menu,
  Paper,
  SegmentedControl,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { DatePickerInput } from "@mantine/dates";
import {
  IconCalendar,
  IconCheck,
  IconChartBar,
  IconChevronDown,
  IconTable,
} from "@tabler/icons-react";
import { rangePresets, type DateRange } from "../lib/time.ts";
import type { Attribution } from "../lib/aggregate.ts";

export function StatTile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <Paper withBorder p="sm">
      <Text size="xs" c="dimmed" fw={600} tt="uppercase" lts={0.4}>
        {label}
      </Text>
      <Text fz={26} fw={600} lh={1.2} mt={4} className="tnum">
        {value}
      </Text>
      {sub != null && (
        <Text size="xs" c="dimmed" mt={2}>
          {sub}
        </Text>
      )}
    </Paper>
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
    <SegmentedControl
      size="xs"
      value={value}
      onChange={(v) => onChange(v as T)}
      data={options.map((o) => ({ value: o.key, label: o.label }))}
    />
  );
}

export const ATTRIBUTION_OPTIONS: { key: Attribution; label: string }[] = [
  { key: "share", label: "Workload share" },
  { key: "service", label: "Service minutes" },
];

export function attributionNote(attribution: Attribution): string {
  return attribution === "share"
    ? "Group sessions are split evenly among attendees (workload view)."
    : "Group sessions are credited in full to each attendee (service-minutes view).";
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
  const [opened, setOpened] = useState(false);
  const [custom, setCustom] = useState<[string | null, string | null]>([null, null]);
  const presets = rangePresets(schoolYearStartMonth);
  const [from, to] = custom;

  return (
    <Menu
      opened={opened}
      onChange={setOpened}
      width={280}
      shadow="md"
      position="bottom-start"
      closeOnItemClick={false}
    >
      <Menu.Target>
        <Button
          variant="default"
          leftSection={<IconCalendar size={16} />}
          rightSection={<IconChevronDown size={14} />}
        >
          {value.label}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {presets.map((p) => (
          <Menu.Item
            key={p.key}
            rightSection={value.key === p.key ? <IconCheck size={14} /> : null}
            onClick={() => {
              onChange({ key: p.key, label: p.label, range: p.range() });
              setOpened(false);
            }}
          >
            {p.label}
          </Menu.Item>
        ))}
        <Menu.Divider />
        <Menu.Label>Custom range</Menu.Label>
        <Box px="xs" pb="xs">
          <DatePickerInput
            type="range"
            size="xs"
            placeholder="Start – end"
            value={custom}
            onChange={setCustom}
          />
          <Button
            fullWidth
            size="xs"
            mt={6}
            disabled={!from || !to}
            onClick={() => {
              if (!from || !to) return;
              onChange({ key: "custom", label: `${from} – ${to}`, range: { from, to } });
              setOpened(false);
            }}
          >
            Apply
          </Button>
        </Box>
      </Menu.Dropdown>
    </Menu>
  );
}

export function IepBadge({ iep }: { iep: boolean }) {
  if (!iep) return null;
  return (
    <Badge size="xs" variant="light" color="clinical">
      IEP
    </Badge>
  );
}

export interface TableTwin {
  headers: string[];
  rows: (string | number)[][];
}

/** Plain-table rendering of a chart's data — the first column is a label, the rest are numbers. */
export function DataTable({ headers, rows }: TableTwin) {
  return (
    <Table.ScrollContainer minWidth={320}>
      <Table striped highlightOnHover fz="xs">
        <Table.Thead>
          <Table.Tr>
            {headers.map((h, i) => (
              <Table.Th key={h} className={i === 0 ? undefined : "num"}>
                {h}
              </Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((r, i) => (
            <Table.Tr key={i}>
              {r.map((c, j) => (
                <Table.Td key={j} className={j === 0 ? undefined : "num"}>
                  {c}
                </Table.Td>
              ))}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

/**
 * Chart container with a "view as table" twin so no value is gated behind
 * hover or color perception.
 */
export function ChartCard({
  title,
  sub,
  legend,
  table,
  children,
}: {
  title: string;
  sub?: string;
  legend?: ReactNode;
  table?: TableTwin;
  children: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <Card h="100%">
      <Group justify="space-between" align="flex-start" wrap="nowrap" mb="xs">
        <div>
          <Text fw={600} size="sm">
            {title}
          </Text>
          {sub && (
            <Text size="xs" c="dimmed" mt={2}>
              {sub}
            </Text>
          )}
        </div>
        {table && (
          <Tooltip label={showTable ? "Show chart" : "Show data table"}>
            <ActionIcon
              variant="subtle"
              color="gray"
              className="no-print"
              aria-label={showTable ? "Show chart" : "Show data table"}
              onClick={() => setShowTable((s) => !s)}
            >
              {showTable ? <IconChartBar size={16} /> : <IconTable size={16} />}
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
      {legend}
      {showTable && table ? <DataTable {...table} /> : children}
    </Card>
  );
}

export function LegendRow({
  items,
}: {
  items: { label: string; color: string; line?: boolean }[];
}) {
  return (
    <Group gap="md" mb="xs">
      {items.map((i) => (
        <Group key={i.label} gap={6} wrap="nowrap">
          <span className={i.line ? "legend-line" : "legend-swatch"} style={{ background: i.color }} />
          <Text size="xs" c="dimmed">
            {i.label}
          </Text>
        </Group>
      ))}
    </Group>
  );
}

interface TooltipPayloadItem {
  name?: string;
  value?: number | string;
  color?: string;
}

/**
 * Chart tooltip: values lead, series names follow.
 *
 * `labels` maps a series key to its display name. Series keys must not contain
 * a "." — Mantine reads that as a nested-object path — so charts keyed by
 * anything user-named pass synthetic keys plus this map.
 */
export function ChartTooltip({
  label,
  payload,
  formatter,
  labels,
}: {
  label?: ReactNode;
  payload?: TooltipPayloadItem[] | null;
  formatter?: (v: number) => string;
  labels?: Record<string, string>;
}) {
  const items = (payload ?? [])
    .filter((p) => p.value != null)
    .map((p) => ({ ...p, name: (p.name && labels?.[p.name]) ?? p.name }));
  if (items.length === 0) return null;
  return (
    <Paper withBorder shadow="md" px="sm" py="xs">
      {label != null && (
        <Text size="xs" c="dimmed" mb={4}>
          {label}
        </Text>
      )}
      <Stack gap={2}>
        {items.map((item, i) => (
          <Group key={i} gap={6} wrap="nowrap">
            <span className="legend-swatch" style={{ background: item.color }} />
            <Text size="xs" fw={600} className="tnum">
              {formatter && typeof item.value === "number" ? formatter(item.value) : String(item.value)}
            </Text>
            <Text size="xs" c="dimmed">
              {item.name}
            </Text>
          </Group>
        ))}
      </Stack>
    </Paper>
  );
}

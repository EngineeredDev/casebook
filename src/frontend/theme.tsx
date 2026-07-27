import {
  createTheme,
  useComputedColorScheme,
  Button,
  Card,
  NumberInput,
  Paper,
  Select,
  Table,
  TextInput,
  Tooltip,
  type MantineColorsTuple,
} from "@mantine/core";
import { PALETTES, type ChartPalette, type ThemeMode } from "./lib/palette.ts";

/**
 * Blue ramp built around the validated chart hue: shade 6 is the light-mode
 * "direct" series color and shade 5 the dark-mode one, so the app chrome and
 * the charts can never drift apart.
 */
const clinical: MantineColorsTuple = [
  "#edf4fd",
  "#d9e8fa",
  "#b0cef5",
  "#85b3ef",
  "#5f9bea",
  "#3987e5",
  "#2a78d6",
  "#2168bd",
  "#1a589f",
  "#124680",
];

/** Warm counterpart to `clinical`, matching the "indirect" series color. */
const ember: MantineColorsTuple = [
  "#fdf2ee",
  "#fbe7de",
  "#f6cabb",
  "#f1ab93",
  "#ed9072",
  "#eb7f5d",
  "#eb6834",
  "#d0562a",
  "#ba4b23",
  "#a13d19",
];

export const theme = createTheme({
  primaryColor: "clinical",
  primaryShade: { light: 6, dark: 5 },
  colors: { clinical, ember },
  defaultRadius: "sm",
  /** Compact density: shrinks every rem-based size by 5%. */
  scale: 0.95,
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  headings: {
    fontWeight: "600",
    sizes: {
      h1: { fontSize: "1.6rem" },
      h2: { fontSize: "1.15rem" },
      h3: { fontSize: "1rem" },
    },
  },
  components: {
    Button: Button.extend({ defaultProps: { size: "sm" } }),
    TextInput: TextInput.extend({ defaultProps: { size: "sm" } }),
    NumberInput: NumberInput.extend({ defaultProps: { size: "sm" } }),
    Select: Select.extend({ defaultProps: { size: "sm" } }),
    Table: Table.extend({ defaultProps: { verticalSpacing: "xs", horizontalSpacing: "sm" } }),
    Card: Card.extend({ defaultProps: { withBorder: true, radius: "md", padding: "md" } }),
    Paper: Paper.extend({ defaultProps: { radius: "md" } }),
    Tooltip: Tooltip.extend({ defaultProps: { withArrow: true, fz: "xs" } }),
  },
});

/**
 * Chart colors for the active color scheme. Charts take literal color values
 * rather than CSS variables, so this mirrors Mantine's scheme into the
 * validated dataviz palette.
 */
export function useChartPalette(): ChartPalette {
  const scheme = useComputedColorScheme("light") as ThemeMode;
  return PALETTES[scheme];
}

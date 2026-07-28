/**
 * Reference dataviz palette (validated — see dataviz skill palette.md).
 * Categorical slots are assigned in fixed order, never cycled or generated.
 */
export type ThemeMode = "light" | "dark";

export interface ChartPalette {
  series: string[];
  surface: string;
  textPrimary: string;
  textSecondary: string;
  muted: string;
  gridline: string;
  baseline: string;
  direct: string;
  indirect: string;
  deEmphasis: string;
  successText: string;
  critical: string;
}

export const PALETTES: Record<ThemeMode, ChartPalette> = {
  light: {
    series: [
      "#2a78d6",
      "#eb6834",
      "#1baf7a",
      "#eda100",
      "#e87ba4",
      "#008300",
      "#4a3aa7",
      "#e34948",
    ],
    surface: "#fcfcfb",
    textPrimary: "#0b0b0b",
    textSecondary: "#52514e",
    muted: "#898781",
    gridline: "#e1e0d9",
    baseline: "#c3c2b7",
    direct: "#2a78d6",
    indirect: "#eb6834",
    deEmphasis: "#c3c2b7",
    successText: "#006300",
    critical: "#d03b3b",
  },
  dark: {
    series: [
      "#3987e5",
      "#d95926",
      "#199e70",
      "#c98500",
      "#d55181",
      "#008300",
      "#9085e9",
      "#e66767",
    ],
    surface: "#1a1a19",
    textPrimary: "#ffffff",
    textSecondary: "#c3c2b7",
    muted: "#898781",
    gridline: "#2c2c2a",
    baseline: "#383835",
    direct: "#3987e5",
    indirect: "#d95926",
    deEmphasis: "#52514e",
    successText: "#0ca30c",
    critical: "#d03b3b",
  },
};

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { PALETTES, type ChartPalette, type ThemeMode } from "./lib/palette.ts";

interface ThemeValue {
  mode: ThemeMode;
  palette: ChartPalette;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

function initialMode(): ThemeMode {
  const stored = localStorage.getItem("theme");
  if (stored === "light" || stored === "dark") return stored;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(initialMode);

  useEffect(() => {
    document.documentElement.dataset.theme = mode;
  }, [mode]);

  const toggle = () => {
    setMode((m) => {
      const next = m === "light" ? "dark" : "light";
      localStorage.setItem("theme", next);
      return next;
    });
  };

  return (
    <ThemeContext.Provider value={{ mode, palette: PALETTES[mode], toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeValue {
  const v = useContext(ThemeContext);
  if (!v) throw new Error("useTheme outside ThemeProvider");
  return v;
}

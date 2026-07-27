import { useState } from "react";
import { StoreProvider, useStore } from "./store.tsx";
import { ThemeProvider, useTheme } from "./theme.tsx";
import { LogPage } from "./components/LogPage.tsx";
import { DashboardPage } from "./components/DashboardPage.tsx";
import { StudentsPage } from "./components/StudentsPage.tsx";
import { ReportsPage } from "./components/ReportsPage.tsx";

type Page = "log" | "dashboard" | "students" | "reports";

const TABS: { key: Page; label: string }[] = [
  { key: "log", label: "Log" },
  { key: "dashboard", label: "Dashboard" },
  { key: "students", label: "Students" },
  { key: "reports", label: "Reports" },
];

function SaveStatus() {
  const { saveState } = useStore();
  const text =
    saveState === "saved"
      ? "All changes saved"
      : saveState === "saving"
        ? "Saving…"
        : saveState === "conflict"
          ? "Sync conflict"
          : "Save failed — retrying";
  return <span className={`save-status${saveState === "error" || saveState === "conflict" ? " error" : ""}`}>{text}</span>;
}

function ConflictBanner() {
  const { saveState, reload } = useStore();
  if (saveState !== "conflict") return null;
  return (
    <div className="banner">
      <span>
        Another window saved changes first. Reload to pick up the latest data — unsynced edits in
        this window will be lost.
      </span>
      <button className="btn primary" onClick={reload}>
        Reload data
      </button>
    </div>
  );
}

function Shell() {
  const [page, setPage] = useState<Page>("log");
  const { mode, toggle } = useTheme();
  return (
    <>
      <header className="app-header">
        <div className="app-title">
          <span className="logo-dot" />
          Clinician Tracker
        </div>
        <nav className="nav-tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`nav-tab${page === t.key ? " active" : ""}`}
              onClick={() => setPage(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="header-right">
          <SaveStatus />
          <button className="theme-toggle" onClick={toggle} title="Toggle theme">
            {mode === "light" ? "◐ Dark" : "◑ Light"}
          </button>
        </div>
      </header>
      <main className="app-main">
        <ConflictBanner />
        {page === "log" && <LogPage />}
        {page === "dashboard" && <DashboardPage />}
        {page === "students" && <StudentsPage />}
        {page === "reports" && <ReportsPage />}
      </main>
    </>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <StoreProvider>
        <Shell />
      </StoreProvider>
    </ThemeProvider>
  );
}

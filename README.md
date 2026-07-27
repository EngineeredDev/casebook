# Clinician Tracker

Local-first time tracking for a school-based clinician. Answers the question
**"how many hours per week does this student actually take?"** — across direct
therapy, IEP meetings, parent contact, documentation, crisis response, and the
rest — so caseload conversations can happen with numbers instead of vibes.

Everything lives in one folder. No accounts, no cloud, no install. The app is a
single compiled executable that serves a browser UI at `http://localhost:4321`
and stores all data in a human-readable `data.json` next to the executable.

## Running it (for the clinician)

1. Copy the folder for your platform out of `dist/` (e.g. `dist/mac-arm/`).
2. Double-click `ClinicianTracker`. Your browser opens the app.
3. That's it. Your data is the `data.json` file next to the app — copy that one
   file to back up everything. The app also keeps a rolling 30 days of daily
   snapshots in `backups/`.

First-run notes:

- **macOS**: unsigned app — right-click → Open the first time (or
  `xattr -d com.apple.quarantine ClinicianTracker` if it was downloaded).
- **Windows**: SmartScreen will warn — "More info" → "Run anyway".
- If the machine is district-managed and blocks unsigned executables, that's a
  known risk; test this **before** relying on it (see Smoke test below).

Double-clicking twice is safe — a second launch notices the running copy and
just reopens the browser tab.

## Smoke test for a locked-down school machine

Copy `dist/<platform>/ClinicianTracker` to the target machine and run it. If it
prints `Clinician Tracker running at http://localhost:4321` and the page loads,
you're clear. If IT policy blocks it, the fallback plan is repackaging the same
frontend as a single HTML file using the File System Access API (storage layer
swap only — not built yet).

## Concepts

- **Entry**: date + minutes + category + one or more students, with optional
  start time and note. Entries with multiple students are **group sessions**.
- **Attribution** (toggle on Dashboard/Reports):
  - *Workload share* — group time is split evenly among attendees. True cost
    view; per-student numbers sum to real clock time.
  - *Service minutes* — group time credited in full to each attendee. Matches
    how IEP service delivery is counted.
  - Overall totals always count each entry once (actual clock time).
- **Categories** are grouped *direct* vs *indirect* — editable on the Students
  tab; archived categories keep their history.
- **Students** carry an IEP flag and optional mandated minutes/week, which
  powers the mandate-vs-actual view (always computed with service minutes).
- Weeks start Monday. "School year to date" rolls over in August.

## Reports & exports

The Reports tab renders a print-ready sheet (Print / Save PDF button), plus:

- **CSV · weekly** — one row per student per week (pivot-table friendly)
- **CSV · raw** — every entry as a row
- **Backup JSON** — the whole data file, timestamped

## Development

Requires [mise](https://mise.jdx.dev) (pins Bun) — or any Bun ≥ 1.3.

```sh
bun install
bun run dev          # http://localhost:4321, hot reload
```

Dev mode stores `data.json` in the repo root (gitignored). Delete it to reset.
The current one contains seeded demo data.

```sh
bun run build:all    # dist/{mac-arm,mac-intel,windows}/
```

Cross-compiles from any machine via `bun build --compile`. Each binary embeds
the entire frontend; the only files it creates are `data.json` and `backups/`
beside itself.

### Architecture

- `src/server.ts` — Bun.serve: static frontend via HTML imports + a 3-route API
  (`GET/PUT /api/data`, `GET /api/health`). Whole-document saves with a
  revision counter; concurrent-window conflicts return 409.
- `src/storage.ts` — atomic writes (temp file + rename), daily rotating backups.
- `src/frontend/` — React 19 + Recharts. `lib/aggregate.ts` holds all rollup
  math; `lib/palette.ts` is the validated chart palette (light + dark).

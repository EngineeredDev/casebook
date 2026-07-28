# Casebook

Local-first time tracking for a school-based clinician. Answers the question
**"how many hours per week does this student actually take?"** — across direct
therapy, IEP meetings, parent contact, documentation, crisis response, and the
rest — so caseload conversations can happen with numbers instead of vibes.

Everything lives in one folder. No accounts, no cloud, no install. The app is a
single compiled executable that serves a browser UI at
`http://clinician.localhost:4321`
and stores all data in a human-readable `data.json` next to the executable.

## Running it (for the clinician)

1. Copy the folder for your platform out of `dist/` (e.g. `dist/mac-arm/`).
2. Double-click `Casebook`. Your browser opens the app.
3. That's it. Your data is the `data.json` file next to the app — copy that one
   file to back up everything. The app also keeps a rolling 30 days of daily
   snapshots in `backups/`.

First-run notes:

- **macOS**: unsigned app — right-click → Open the first time (or
  `xattr -d com.apple.quarantine Casebook` if it was downloaded).
- **Windows**: SmartScreen will warn — "More info" → "Run anyway".
- If the machine is district-managed and blocks unsigned executables, that's a
  known risk; test this **before** relying on it (see Smoke test below).

Double-clicking twice is safe — a second launch notices the running copy and
just reopens the browser tab.

## Smoke test for a locked-down school machine

Copy `dist/<platform>/Casebook` to the target machine and run it. If it
prints `Casebook running at http://casebook.localhost:4321` and the
page loads,
you're clear. If IT policy blocks it, the fallback plan is repackaging the same
frontend as a single HTML file using the File System Access API (storage layer
swap only — not built yet).

## Concepts

- **Entry**: date + minutes + category + one or more students, with optional
  start time and note. Entries with multiple students are **group sessions**;
  entries in an untimed category carry 0 minutes (see Categories below).
- **Notes** are formatted clinical notes (bold, italic, underline, lists,
  headings). The ⤢ button opens a full-height editor alongside that student's
  earlier notes. ⌘/Ctrl+Enter saves.
  - Notes **never leave the app**: not in either CSV, not on the printed report.
    The only export that carries them is the full JSON backup, which has to —
    otherwise restoring it would lose every note — and it says so in the menu.
  - They are stored as HTML in `data.json`, in plain text on disk. Anyone with
    the computer can read them.
- **Attribution** (toggle on Dashboard/Reports):
  - *Workload share* — group time is split evenly among attendees. True cost
    view; per-student numbers sum to real clock time.
  - *Service minutes* — group time credited in full to each attendee. Matches
    how IEP service delivery is counted.
  - Overall totals always count each entry once (actual clock time).
- **Categories** are grouped *direct* vs *indirect* — editable on the Students
  tab; archived categories keep their history.
  - A category can also be marked **untimed** (the ⊘ button next to it). Picking
    an untimed category on the Log tab hides the duration picker and files the
    entry at 0 minutes — for no-shows and cancellations, which are worth
    recording as events but take no time. They never move an hours total; they
    show up as counts: the day header on the Log tab, an *Untimed* tile and an
    *Entries* column on Dashboard/Reports, and a column in both CSVs. Most
    setups need one such category, or none.
- **Students** carry an IEP flag and optional mandated minutes/week, which
  powers the mandate-vs-actual view (always computed with service minutes).
  - Clicking a student on the Students tab opens their own page: totals, hours
    per week, mandate vs actual, and every entry they appear in with its note
    readable in place. **Notes only** filters the list to entries that have one
    and opens them for reading. Editing an entry from there hands off to the Log
    tab and returns you when you save, so there is one place entries are written.
- Weeks start Monday. "School year to date" rolls over in August.

## Reports & exports

The Reports tab renders a print-ready sheet. The Print / Save PDF button
temporarily switches the app to light mode so charts print legibly on paper,
then switches back. Also available:

- **CSV · weekly** — one row per student per week (pivot-table friendly), with
  an *Untimed events* count column
- **CSV · raw** — every entry as a row, notes excluded; an *Untimed* Y/N column
  separates a deliberate no-time event from a genuine zero
- **Backup JSON** — the whole data file, timestamped. Contains notes; it's for
  restoring, not for handing to anyone.

## Hosted demo

For showing the app to someone without handing them a binary to run:
<https://casebook-demo-production.up.railway.app>

This is a demo, not a deployment of the product — the product is still the
local executable above. Two things follow from that:

- **The API is unauthenticated**, exactly as it is locally, so anyone with the
  link can read *and* change what they see. Only ever point it at the seeded
  caseload in `seed/demo-data.json` (invented students, placeholder notes).
  Never a real one.
- **Nothing entered there survives.** `seed/demo-data.json` is baked into the
  image as `data.json`, so every container start — including a restart after a
  visitor edits something — comes back up on the same known-good caseload.

```sh
docker build -t casebook:demo .
docker run --rm -e PORT=8080 -p 8080:8080 casebook:demo
railway up                    # redeploy after a change
```

`Dockerfile` runs the app from source under Bun rather than shipping a compiled
binary, because `bun build --compile` embeds the frontend but also flips the app
into executable mode — data next to the binary, browser auto-launch — neither of
which a container wants. `railway.json` pins the Dockerfile builder and points
the healthcheck at `/api/health`.

The demo is the one place the server binds beyond loopback. It does so only when
`PORT` is set *and* the process isn't a compiled binary, so the executable that
lands on a clinician's machine cannot be talked into answering the network by a
stray environment variable. See the comment on `HOST` in `src/server.ts`.

## Development

Requires [mise](https://mise.jdx.dev) (pins Bun) — or any Bun ≥ 1.3.

```sh
bun install
bun run dev          # http://clinician.localhost:4321, hot reload
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
  revision counter; concurrent-window conflicts return 409. Bound to `127.0.0.1`
  and `[::1]` — the API is unauthenticated, so it must not answer the network.
  The browser is pointed at `clinician.localhost`, which RFC 6761 reserves for
  loopback: no hosts-file entry, no admin rights, and unlike mDNS nothing is
  advertised to the network. Both loopback families are bound because that name
  resolves to `::1` before `127.0.0.1` on macOS.
  A second launch does not start a second instance — it probes `/api/health`,
  finds the running copy, re-opens its tab and exits.
  The page route is a catch-all (`"/*"`) so a reload on a client-side route like
  `/students/<id>` returns the app rather than a 404; Bun matches
  most-specific-first, so `/api/*` and the bundled assets are unaffected.
- `src/storage.ts` — atomic writes (temp file + rename), daily rotating backups,
  and the data-version migration (v1 → v2 turned plain-text notes into HTML,
  snapshotting the old file to `backups/data-pre-v2-<date>.json`).
- `src/frontend/` — React 19 + [Mantine](https://mantine.dev) (UI + charts).
  `lib/aggregate.ts` holds all rollup math; `lib/palette.ts` is the validated
  chart palette (light + dark), and `theme.tsx` ties Mantine's primary color to
  the same blue the charts use. `app.css` carries only what Mantine doesn't:
  the two series colors, number formatting, and the print rules.
- `src/frontend/lib/router.tsx` — ~130 lines of router, no dependency. Six routes
  and one dynamic segment don't need a path matcher, they need a union type, so
  the page switch is exhaustiveness-checked and `studentId` is a `string` rather
  than `string | undefined`. `lib/urlState.ts` puts view state in the query
  string (`?range` `?attr` `?date` `?edit` `?notes`), omitting each param when it
  holds its default and falling back rather than throwing on a bad value.
  Why not react-router: `docs/routing-and-student-page.md` §4.

| Route | |
|---|---|
| `/log` | `?date=YYYY-MM-DD` `?edit=<entryId>` |
| `/dashboard` | `?range=<key>` `?attr=share\|service` |
| `/students` | |
| `/students/:id` | `?range` `?attr` `?notes=1` |
| `/reports` | `?range` `?attr` |

Mantine needs no PostCSS here — its prebuilt stylesheets are imported in
`index.tsx` and Bun bundles them directly.

Notes use [Tiptap](https://tiptap.dev) via `@mantine/tiptap`. Everything used is
MIT and runs entirely offline; Tiptap's paid tiers only cover their cloud
services (collaboration, comments, AI), none of which are here. Note HTML is
never injected with `dangerouslySetInnerHTML` — read-only views re-parse it
through the same editor schema, so nothing outside that schema can render. See
`docs/rich-notes-spec.md`.

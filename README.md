# Casebook

Local-first time tracking for a school-based clinician. Answers the question
**"how many hours per week does this student actually take?"** — across direct
therapy, IEP meetings, parent contact, documentation, crisis response, and the
rest — so caseload conversations can happen with numbers instead of vibes.

A Mac app. No accounts, no cloud, nothing listening on a port. All data lives in
one folder — `~/Casebook` — as a human-readable `data.json` beside a `backups/`
directory.

## Installing it (for the clinician)

Paste this into Terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/EngineeredDev/casebook/main/scripts/install-macos.sh | sh
```

It downloads the app, puts it in `/Applications`, and opens it. Casebook is then
an ordinary Mac app: it's in the Dock, in Spotlight, and it opens when you open
it.

Apple silicon (M1 and later) only. Run the same command again to upgrade —
your data is never touched. To remove it, add `-s -- --uninstall` to the pipe.

**Why Terminal rather than a download?** Because it is genuinely the easier
path here, not the technical one. Casebook is signed, but not by a certificate
Apple recognises — that costs $99/year and this app has one user. macOS treats
files downloaded by a _browser_ as suspect and files downloaded by `curl` as
ordinary, so this command sidesteps a dialog the download route has to argue
with. See below.

### If you would rather click something

Download `Casebook-mac-arm64.dmg` from the
[latest release](https://github.com/EngineeredDev/casebook/releases/latest),
open it, and drag Casebook to Applications. The first launch takes four extra
steps, once, ever:

1. Double-click Casebook. macOS says **"Apple could not verify…"**. Click
   **Done** — not Move to Trash.
2. Open **System Settings → Privacy & Security**, scroll down, and click
   **Open Anyway** next to the message about Casebook.
3. Double-click Casebook again and confirm.
4. Enter your Mac password.

This is Gatekeeper doing its job: it cannot tell an app signed by nobody from a
malicious one, so it asks you to vouch for it. Right-click → Open no longer
works for this — macOS 15 removed that shortcut.

### Your data, and backing it up

Everything Casebook knows is in **`~/Casebook`** — that's a folder called
`Casebook` in your home folder. Copy that folder and you have copied everything:
the current data and a rolling 30 days of daily snapshots.

The app and the data are separate things. Deleting the app does not touch your
data; replacing the app on upgrade does not touch it either. Settings → _Show in
Finder_ opens the folder, and _Move to another folder…_ relocates it (copying
and verifying before it switches over, and leaving the old copy for you to
delete once you're happy).

Coming from the older Casebook — the one that opened in a browser tab? Open the
new app and it will find your old data, offer to bring it across, and offer to
stop the old one starting at login. Let it do that rather than deleting anything
yourself.

## A locked-down school Mac is still the open question

If the target machine is district-managed, **test there before relying on any of
this.** MDM can block Terminal outright and can remove the Open Anyway button
entirely, which closes both paths above with no override available. Nothing
about the app being a Mac app rather than a browser tab changes that risk in
either direction.

If IT policy blocks it, the fallback is repackaging the same frontend as a
single HTML file using the File System Access API — a storage-layer swap, not a
rewrite. Not built.

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
- **Timeline** is every entry ever logged, newest day first, on one page you
  keep scrolling — months stick to the top as they pass, and each day carries
  its own total. Notes stay **collapsed** here: the list reads as a schedule,
  and a note only opens when you click it.
  - The search box matches the note text, the students, and the category at
    once, and understands a few narrowing prefixes — `student:casey`,
    `cat:iep`, `note:guardian`, `has:note`, `is:group`, `is:untimed`, `is:iep`,
    `before:` / `after:` / `on:`, `"exact phrase"`, and a leading `-` to
    exclude. Every term has to match; the `?` button next to the box lists them
    all.
  - Dates take a full day, a month, or a year — `on:2026-06` is all of June.
    `after:` includes its day and `before:` excludes it, so
    `after:2026-05-01 before:2026-06-01` is exactly May.
  - When a search matches inside a note, the row says so rather than opening
    it, so a hit is never something you didn't ask to see on screen.
  - Filters for date range, students, categories, direct/indirect, and
    has-a-note sit above the list, and all of it lives in the URL — a search
    worth keeping is a bookmark.
- **Attribution** (toggle on Dashboard/Reports):
  - _Workload share_ — group time is split evenly among attendees. True cost
    view; per-student numbers sum to real clock time.
  - _Service minutes_ — group time credited in full to each attendee. Matches
    how IEP service delivery is counted.
  - Overall totals always count each entry once (actual clock time).
- **Categories** are grouped _direct_ vs _indirect_ — editable on the Categories
  tab; archived categories keep their history.
  - A category can also be marked **untimed** (the ⊘ button next to it). Picking
    an untimed category on the Log tab hides the duration picker and files the
    entry at 0 minutes — for no-shows and cancellations, which are worth
    recording as events but take no time. They never move an hours total; they
    show up as counts: the day header on the Log tab, an _Untimed_ tile and an
    _Entries_ column on Dashboard/Reports, and a column in both CSVs. Most
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
  an _Untimed events_ count column
- **CSV · raw** — every entry as a row, notes excluded; an _Untimed_ Y/N column
  separates a deliberate no-time event from a genuine zero
- **Backup JSON** — the whole data file, timestamped. Contains notes; it's for
  restoring, not for handing to anyone.

Each of these opens a save dialog, so the file lands where you put it.

## Development

Requires [mise](https://mise.jdx.dev) (pins Node) — or any recent Node.

```sh
npm install
npm run dev      # Electron window, hot reload
npm run check    # typecheck, lint, format
npm run dist     # dist/Casebook-mac-arm64.{zip,dmg}
```

A development build keeps `data.json` in the repo root (gitignored) rather than
in `~/Casebook`, so working on the app cannot touch real records. Delete it to
reset.

Releasing is a tag: see [RELEASING.md](RELEASING.md).

The app icon is generated from `build/icon.svg` by
`npx electron scripts/make-icon.cjs`; `build/icon.icns` is committed, so that
only needs running when the mark changes.

### Architecture

Three processes, Electron-standard. There is no HTTP server and nothing binds a
port — the unauthenticated loopback API the browser version needed is gone
rather than ported.

- `src/main/` — the Node side, and the only thing that touches the disk.
  - `index.ts` sets up the app, the single-instance lock (a second launch
    focuses the existing window), and the global permission denials.
  - `storage.ts` — atomic writes (temp file + rename), daily rotating backups,
    and the data-version migration (v1 → v2 turned plain-text notes into HTML,
    snapshotting the old file to `backups/data-pre-v2-<date>.json`).
  - `ipc.ts` — the whole main-process API. Holds the one in-memory copy of the
    document; the revision counter keeps it and the renderer's copy honest, and
    a save whose write fails does not advance it. What was HTTP 409 is now a
    typed `{conflict: true}` result.
  - `renderer.ts` — serves the built frontend over a custom `app://` protocol
    with an SPA fallback, so reloading `/students/<id>` returns the app rather
    than a 404. Also where the CSP lives.
  - `paths.ts` / `config.ts` / `datafolder.ts` — where the data folder is, and
    moving it. `~/Casebook` by default: visible, Time-Machine-covered, and not
    TCC-protected, which `~/Documents` is — macOS gates that folder behind a
    permission prompt keyed to the app's code signature, and an ad-hoc signature
    has no stable identity, so every update could re-trigger it.
  - `legacy.ts` — finding the pre-Electron install, copying its data across, and
    retiring its LaunchAgent.
- `src/preload/index.ts` — the `contextBridge` surface, and the only route
  between the two. `contextIsolation` and `sandbox` are on, `nodeIntegration`
  off, and every IPC handler checks the sender's frame.
- `src/shared/` — `types.ts` (the data document) and `api.ts` (the IPC
  contract), imported by both sides.
- `src/renderer/` — React 19 + [Mantine](https://mantine.dev) (UI + charts).
  `lib/aggregate.ts` holds all rollup math; `lib/palette.ts` is the validated
  chart palette (light + dark), and `theme.tsx` ties Mantine's primary color to
  the same blue the charts use. `app.css` carries only what Mantine doesn't:
  the two series colors, number formatting, and the print rules.
- `src/renderer/lib/router.tsx` — ~130 lines of router, no dependency. Seven
  routes and one dynamic segment don't need a path matcher, they need a union
  type, so the page switch is exhaustiveness-checked and `studentId` is a
  `string` rather than `string | undefined`. `lib/urlState.ts` puts view state in
  the query string, omitting each param when it holds its default and falling
  back rather than throwing on a bad value.
  Why not react-router: see the comment at the top of that file.
- `src/renderer/lib/search.ts` — the Timeline's query language: an index built
  once per document (parsing note HTML is the expensive part, so it does not
  happen per keystroke) and a parser for the `field:value` / `-negated` /
  `"quoted"` syntax. Deliberately not fuzzy — newest-first order is the point of
  the page, and relevance ranking would have to fight it.

| Route           |                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------- |
| `/log`          | `?date=YYYY-MM-DD` `?edit=<entryId>`                                                        |
| `/timeline`     | `?q=<search>` `?range` `?students=<ids>` `?cats=<ids>` `?group=direct\|indirect` `?notes=1` |
| `/dashboard`    | `?range=<key>` `?attr=share\|service`                                                       |
| `/students`     |                                                                                             |
| `/students/:id` | `?range` `?attr` `?notes=1`                                                                 |
| `/reports`      | `?range` `?attr`                                                                            |

### Packaging

`electron-builder.yml` produces a zip and a DMG, arm64 only. Three things there
are load-bearing and quiet when they break, so CI asserts all of them on every
build:

- **`identity: "-"`** — ad-hoc signing. Not a preference: macOS kills an
  unsigned arm64 binary on exec. `hardenedRuntime` stays off, because it buys
  nothing without notarization and electron-builder mis-signs when the two are
  combined.
- **Fuses** — `runAsNode`, `enableNodeOptionsEnvironmentVariable` and
  `enableNodeCliInspectArguments` are compiled off at package time, closing the
  "run this app as a plain Node process" hole. Irreversible from outside the
  binary, and unrecoverable if a build ships without them.
- **Artifact names carry no version**, so
  `releases/latest/download/Casebook-mac-arm64.zip` is a URL the install script
  can construct without asking an API what the current version is.

Mantine needs no PostCSS here — its prebuilt stylesheets are imported in
`index.tsx` and Vite bundles them directly.

Notes use [Tiptap](https://tiptap.dev) via `@mantine/tiptap`. Everything used is
MIT and runs entirely offline; Tiptap's paid tiers only cover their cloud
services (collaboration, comments, AI), none of which are here. Note HTML is
never injected with `dangerouslySetInnerHTML` — read-only views re-parse it
through the same editor schema, so nothing outside that schema can render.

## License

MIT — see [LICENSE](LICENSE).

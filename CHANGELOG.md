# Changelog

What changed in Casebook, read from the clinician's side rather than the
code's — the same test RELEASING.md applies to version numbers. If an entry
here would mean nothing to someone who only uses the app, it belongs in the
commit message instead.

The section for a version is what CI publishes as that release's notes, so
this file is written before the tag, not after it. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
semver as RELEASING.md defines it.

## [Unreleased]

### Added

- **Log work that isn't about one student.** A crisis-team meeting, an SEL
  lesson, staff PD, schedule building, a duty period — a School-level switch
  above the student picker records time with nobody's name on it. It counts
  toward your day, your weekly hours and your category totals, and toward no
  student's record. Until now the only way to log any of it was to invent a
  student, which quietly spoiled headcounts and per-student averages.
- **A School-level tile** on the Dashboard, once there is any, opening that
  time on the Timeline.
- **`is:school` and `is:student`** in Timeline search, alongside `is:group`.

### Changed

- **The weekly summary CSV has a new "Scope" column** between Student and IEP,
  reading `Student` or `School-level`, and a school-level row per week that has
  any. The file now adds back up to your real clock time; before this it
  silently left out any work with no student on it.
- **The Dashboard's IEP tile** now says "share of student time" rather than
  "share of tracked time". The number has not changed — it was always measured
  against student work, and that only became a distinction worth drawing once
  school-level time existed.
- **The printed report** notes how many hours of school-level work sit outside
  its per-student table, so the table and the total no longer appear to
  disagree.

## [0.2.0] — 2026-07-31

Two large pieces: a backup and recovery net under the data, and a local
language model that reads a year of Google Doc into reviewable rows. Both are
off the critical path — the model is optional and off by default, and the
backup work changes nothing about how the app is used.

### Added

- **Import a student's document.** Paste a year of Google Doc and get a page
  of rows to check: date, start time, minutes, category. Only rows you confirm
  are written — there is no "import all" — and a row stops flagging itself
  once the field it was asking about has been answered.
- **Type phrases are remembered once each.** A phrase you map to a category
  stays mapped, and travels with the categories it names through restores,
  encryption and a folder move.
- **An optional local model fills the gaps.** Entries the deterministic reader
  cannot type get a suggested category, always labelled as an AI guess and
  never able to reach "ready" without review. Everything runs on this Mac;
  nothing is sent anywhere.
- **Student summaries.** "How has this student been going" answered over a
  date range, with the underlying entries alongside so the answer can be
  checked against them.
- **A switch and a model picker.** The AI is off by default and can be turned
  off again at any time; when it is on, you choose which of it runs. An
  install that already has weights on disk counts as having opted in.
- **A second copy somewhere that isn't this Mac.** Settings takes an external
  drive, a network share, or a folder something already syncs, and keeps the
  backups mirrored there. An unplugged drive is skipped quietly; the app only
  mentions it after seven days unreachable.
- **Optional passphrase encryption** for the data folder, off by default. Both
  turning it on and turning it off force a snapshot first, under a name
  nothing ever prunes.
- **A way back when the data file won't open.** A damaged `data.json` now
  offers the backups instead of a dead end.

### Changed

- **Saves now survive losing power, not just crashing.** Contents are flushed
  to permanent storage before the rename and the directory after it. Costs
  roughly 30–60 ms against a 500 ms debounce, so it is never felt.
- **A bad day now costs minutes rather than everything since morning.** One
  backup a day is replaced by four tiers — the outgoing version on every save,
  one per fifteen minutes of editing, dailies kept sixty, and monthlies exempt
  from pruning for two years. Existing daily filenames are unchanged, so a
  folder written by 0.1.0 needs no migration and loses nothing.
- **A save that arrives missing a fifth of the roster or the log is refused**
  and asks first. The app deletes one entry at a time and has no "remove all",
  so a document that lost a fifth of itself did not get that way by editing.

### Data

- `data.json` is now **version 3**, adding import mappings. Older files migrate
  on open through every intermediate version, and a pre-migration snapshot is
  preserved first. A document that has never imported anything is unchanged.

### Internal

- The storage layer got a test harness before it was rewritten, and the
  `check` script now runs the suite alongside typecheck, lint and format.
- The local model has an eval harness (`scripts/llm-eval`) that runs the same
  prompts and schema the app uses. Measured before shipping: the deterministic
  reader is 100% across 42 labelled entries, phrase mapping 100% over 15, and
  per-entry classification 81% over 16 — short of the 90% the plan wanted, and
  shipped anyway because those rows are otherwise blank and an 81% suggestion
  you can see and override beats nothing. Three of the four eval documents are
  synthetic, so treat the model numbers as provisional.

## [0.1.0] — 2026-07-31

First release of Casebook as a Mac app: an installed, ad-hoc signed bundle
with its own Dock icon that replaces itself when there is a newer one, built
and published from CI. Everything before this was a login item.

[Unreleased]: https://github.com/EngineeredDev/casebook/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/EngineeredDev/casebook/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/EngineeredDev/casebook/releases/tag/v0.1.0

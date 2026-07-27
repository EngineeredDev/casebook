import { useMemo, useRef, useState } from "react";
import { useStore } from "../store.tsx";
import type { Entry, Student } from "../../types.ts";
import { addDaysYmd, fmtDuration, fmtFullDate, todayYmd } from "../lib/time.ts";
import { IepBadge, useClickOutside } from "./ui.tsx";

const DURATION_PRESETS = [5, 10, 15, 20, 30, 45, 60, 90];

function StudentPicker({
  selectedIds,
  onChange,
}: {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const { doc, addStudent } = useStore();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const ref = useClickOutside(() => setOpen(false));

  const selected = selectedIds
    .map((id) => doc.students.find((s) => s.id === id))
    .filter((s): s is Student => !!s);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return doc.students
      .filter((s) => s.active && !selectedIds.includes(s.id))
      .filter((s) => !q || s.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 8);
  }, [doc.students, query, selectedIds]);

  const exactMatch = doc.students.some(
    (s) => s.name.toLowerCase() === query.trim().toLowerCase(),
  );

  const pick = (id: string) => {
    onChange([...selectedIds, id]);
    setQuery("");
    setHl(0);
    inputRef.current?.focus();
  };

  const create = (iep: boolean) => {
    const name = query.trim();
    if (!name) return;
    const student = addStudent({ name, iep });
    pick(student.id);
  };

  return (
    <div className="picker" ref={ref}>
      <div className="picker-chips" onClick={() => inputRef.current?.focus()}>
        {selected.map((s) => (
          <span className="student-chip" key={s.id}>
            {s.name}
            <IepBadge iep={s.iep} />
            <button
              type="button"
              aria-label={`Remove ${s.name}`}
              onClick={() => onChange(selectedIds.filter((id) => id !== s.id))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="picker-input"
          placeholder={selected.length ? "Add another student…" : "Type a student's name…"}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setHl(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHl((h) => Math.min(h + 1, matches.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHl((h) => Math.max(h - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (matches[hl]) pick(matches[hl].id);
              else if (query.trim() && !exactMatch) create(false);
            } else if (e.key === "Backspace" && !query && selectedIds.length) {
              onChange(selectedIds.slice(0, -1));
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
        />
      </div>
      {open && (query.trim() || matches.length > 0) && (
        <div className="picker-menu">
          {matches.map((s, i) => (
            <button
              key={s.id}
              type="button"
              className={`picker-item${i === hl ? " hl" : ""}`}
              onMouseEnter={() => setHl(i)}
              onClick={() => pick(s.id)}
            >
              <span>
                {s.name} <IepBadge iep={s.iep} />
              </span>
            </button>
          ))}
          {query.trim() && !exactMatch && (
            <div className="picker-create">
              <span className="who">
                New student: <strong>{query.trim()}</strong>
              </span>
              <button type="button" className="btn small" onClick={() => create(false)}>
                Add
              </button>
              <button type="button" className="btn small" onClick={() => create(true)}>
                Add as IEP
              </button>
            </div>
          )}
          {!query.trim() && matches.length === 0 && (
            <div className="picker-create">
              <span className="who">Type a name to add your first student</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function LogPage() {
  const { doc, addEntry, updateEntry, deleteEntry } = useStore();
  const [studentIds, setStudentIds] = useState<string[]>([]);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [minutes, setMinutes] = useState<number | null>(30);
  const [customMinutes, setCustomMinutes] = useState("");
  const [date, setDate] = useState(todayYmd());
  const [startTime, setStartTime] = useState("");
  const [note, setNote] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  const categories = doc.categories.filter((c) => !c.archived);
  const directCats = categories.filter((c) => c.group === "direct");
  const indirectCats = categories.filter((c) => c.group === "indirect");

  const effectiveMinutes = customMinutes ? Number(customMinutes) : minutes;
  const valid =
    studentIds.length > 0 &&
    !!categoryId &&
    !!effectiveMinutes &&
    effectiveMinutes > 0 &&
    Number.isFinite(effectiveMinutes);

  const dayEntries = useMemo(
    () =>
      doc.entries
        .filter((e) => e.date === date)
        .sort((a, b) => (a.startTime ?? "99").localeCompare(b.startTime ?? "99") || a.createdAt.localeCompare(b.createdAt)),
    [doc.entries, date],
  );
  const dayTotal = dayEntries.reduce((sum, e) => sum + e.minutes, 0);

  const resetForm = (keepDate = true) => {
    setStudentIds([]);
    setCategoryId(null);
    setMinutes(30);
    setCustomMinutes("");
    setStartTime("");
    setNote("");
    setEditingId(null);
    if (!keepDate) setDate(todayYmd());
  };

  const submit = () => {
    if (!valid) return;
    const payload = {
      date,
      minutes: effectiveMinutes!,
      categoryId: categoryId!,
      studentIds,
      startTime: startTime || null,
      note: note.trim() || undefined,
    };
    if (editingId) updateEntry(editingId, payload);
    else addEntry(payload);
    resetForm();
  };

  const startEdit = (entry: Entry) => {
    setEditingId(entry.id);
    setStudentIds(entry.studentIds);
    setCategoryId(entry.categoryId);
    setDate(entry.date);
    setStartTime(entry.startTime ?? "");
    setNote(entry.note ?? "");
    if (DURATION_PRESETS.includes(entry.minutes)) {
      setMinutes(entry.minutes);
      setCustomMinutes("");
    } else {
      setMinutes(null);
      setCustomMinutes(String(entry.minutes));
    }
  };

  return (
    <div className="log-layout">
      <div className="card">
        <h2 className="card-title">{editingId ? "Edit entry" : "Log time"}</h2>
        <div className="card-sub">
          {editingId ? "Editing an existing entry." : "Student → what you did → how long. That's it."}
        </div>
        <div className="form-grid">
          <div className="field">
            <label>Student(s)</label>
            <StudentPicker selectedIds={studentIds} onChange={setStudentIds} />
            {studentIds.length > 1 && (
              <span className="hint">
                Group session — time counts once toward your day, and per-student views can show it
                full or split.
              </span>
            )}
          </div>

          <div className="field">
            <label>Category</label>
            <div className="group-label">Direct time</div>
            <div className="cat-grid">
              {directCats.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`cat-btn${categoryId === c.id ? " selected" : ""}`}
                  onClick={() => setCategoryId(c.id)}
                >
                  <span className="cat-dot" style={{ background: "var(--direct)" }} />
                  {c.name}
                </button>
              ))}
            </div>
            <div className="group-label">Indirect time</div>
            <div className="cat-grid">
              {indirectCats.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`cat-btn${categoryId === c.id ? " selected" : ""}`}
                  onClick={() => setCategoryId(c.id)}
                >
                  <span className="cat-dot" style={{ background: "var(--indirect)" }} />
                  {c.name}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label>Duration</label>
            <div className="chip-row">
              {DURATION_PRESETS.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`chip${minutes === m && !customMinutes ? " selected" : ""}`}
                  onClick={() => {
                    setMinutes(m);
                    setCustomMinutes("");
                  }}
                >
                  {m}m
                </button>
              ))}
              <input
                className="input"
                style={{ width: 110 }}
                type="number"
                min={1}
                placeholder="Custom (min)"
                value={customMinutes}
                onChange={(e) => setCustomMinutes(e.target.value)}
              />
            </div>
          </div>

          <div className="form-cols">
            <div className="field">
              <label>Date</label>
              <div className="date-stepper">
                <button className="btn icon" type="button" onClick={() => setDate(addDaysYmd(date, -1))}>
                  ◀
                </button>
                <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                <button className="btn icon" type="button" onClick={() => setDate(addDaysYmd(date, 1))}>
                  ▶
                </button>
              </div>
            </div>
            <div className="field">
              <label>
                Start time <span className="muted">(optional)</span>
              </label>
              <input className="input" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </div>
            <div className="field">
              <label>
                Note <span className="muted">(optional)</span>
              </label>
              <input
                className="input"
                placeholder="e.g. re-eval meeting"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
              />
            </div>
          </div>

          <div className="flex-between">
            <button className="btn primary" type="button" disabled={!valid} onClick={submit}>
              {editingId ? "Save changes" : "Log entry"}
            </button>
            {editingId && (
              <button className="btn" type="button" onClick={() => resetForm()}>
                Cancel edit
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2 className="card-title">{fmtFullDate(date)}</h2>
          <span className="secondary">{dayTotal ? fmtDuration(dayTotal) : ""}</span>
        </div>
        {dayEntries.length === 0 ? (
          <div className="empty-state">No entries for this day yet.</div>
        ) : (
          <div>
            {dayEntries.map((e) => {
              const cat = doc.categories.find((c) => c.id === e.categoryId);
              const names = e.studentIds
                .map((id) => doc.students.find((s) => s.id === id)?.name ?? "(deleted)")
                .join(", ");
              return (
                <div className="entry-row" key={e.id}>
                  <span className="entry-min">{fmtDuration(e.minutes)}</span>
                  <span
                    className="cat-dot"
                    style={{ background: cat?.group === "direct" ? "var(--direct)" : "var(--indirect)" }}
                  />
                  <div className="entry-main">
                    <div className="entry-students">{names}</div>
                    <div className="entry-meta">
                      {cat?.name ?? "(deleted)"}
                      {e.startTime ? ` · ${e.startTime}` : ""}
                      {e.note ? ` · ${e.note}` : ""}
                    </div>
                  </div>
                  <div className="entry-actions">
                    <button className="btn small" type="button" onClick={() => startEdit(e)}>
                      Edit
                    </button>
                    <button
                      className="btn small danger-text"
                      type="button"
                      onClick={() => deleteEntry(e.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

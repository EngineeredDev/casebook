import { useMemo, useState } from "react";
import { useStore } from "../store.tsx";
import type { CategoryGroup } from "../../types.ts";
import {
  filterEntries,
  perStudentTotals,
  studentWeekMatrix,
  categoryName,
} from "../lib/aggregate.ts";
import { addDaysYmd, fmtDuration, fmtDayLabel, todayYmd, toHours, weekStartYmd } from "../lib/time.ts";
import { IepBadge, Sparkline } from "./ui.tsx";

const ALL_TIME = { from: "0000-01-01", to: "9999-12-31" };

export function StudentsPage() {
  const { doc, addStudent, addCategory, updateCategory } = useStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newIep, setNewIep] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [newCatGroup, setNewCatGroup] = useState<CategoryGroup>("indirect");

  const last4 = { from: addDaysYmd(weekStartYmd(todayYmd()), -21), to: todayYmd() };
  const recent = useMemo(
    () =>
      new Map(
        perStudentTotals(filterEntries(doc.entries, last4), doc.students, doc.categories, "share", last4).map(
          (r) => [r.student.id, r],
        ),
      ),
    [doc],
  );
  const allTime = useMemo(
    () =>
      new Map(
        perStudentTotals(doc.entries, doc.students, doc.categories, "share", ALL_TIME).map((r) => [
          r.student.id,
          r,
        ]),
      ),
    [doc],
  );

  const roster = doc.students
    .filter((s) => showInactive || s.active)
    .sort((a, b) => a.name.localeCompare(b.name));

  const selected = doc.students.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="students-layout">
      <div>
        <div className="card">
          <div className="card-head">
            <h2 className="card-title">Roster</h2>
            <label style={{ fontSize: 12.5 }} className="secondary">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
              />{" "}
              Show inactive
            </label>
          </div>
          <div className="inline-form mt-8">
            <div className="field" style={{ flex: 1, minWidth: 180 }}>
              <label>New student</label>
              <input
                className="input"
                placeholder="Full name or initials"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newName.trim()) {
                    const s = addStudent({ name: newName, iep: newIep });
                    setSelectedId(s.id);
                    setNewName("");
                    setNewIep(false);
                  }
                }}
              />
            </div>
            <label style={{ paddingBottom: 10 }} className="secondary">
              <input type="checkbox" checked={newIep} onChange={(e) => setNewIep(e.target.checked)} /> IEP
            </label>
            <button
              className="btn primary"
              disabled={!newName.trim()}
              onClick={() => {
                const s = addStudent({ name: newName, iep: newIep });
                setSelectedId(s.id);
                setNewName("");
                setNewIep(false);
              }}
            >
              Add
            </button>
          </div>

          {roster.length === 0 ? (
            <div className="empty-state">No students yet.</div>
          ) : (
            <div className="mt-16" style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Student</th>
                    <th className="num">Mandate/wk</th>
                    <th className="num">Last 4 wks</th>
                    <th className="num">All time</th>
                  </tr>
                </thead>
                <tbody>
                  {roster.map((s) => (
                    <tr key={s.id} className="row-click" onClick={() => setSelectedId(s.id)}>
                      <td>
                        <strong>{s.name}</strong> <IepBadge iep={s.iep} />{" "}
                        {!s.active && <span className="badge inactive">inactive</span>}
                      </td>
                      <td className="num">
                        {s.iep && s.mandatedMinutesPerWeek ? fmtDuration(s.mandatedMinutesPerWeek) : "—"}
                      </td>
                      <td className="num">
                        {recent.get(s.id)?.total ? `${toHours(recent.get(s.id)!.avgPerWeek)}h/wk` : "—"}
                      </td>
                      <td className="num">
                        {allTime.get(s.id)?.total ? `${toHours(allTime.get(s.id)!.total)}h` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="footnote">Averages use workload share (group time split among attendees).</div>
            </div>
          )}
        </div>

        <div className="card">
          <h2 className="card-title">Categories</h2>
          <div className="card-sub">Rename, regroup, or archive. Archived categories keep their history.</div>
          <table className="data-table">
            <tbody>
              {doc.categories.map((c) => (
                <tr key={c.id}>
                  <td style={{ width: "45%" }}>
                    <input
                      className="input"
                      value={c.name}
                      onChange={(e) => updateCategory(c.id, { name: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      className="input"
                      value={c.group}
                      onChange={(e) => updateCategory(c.id, { group: e.target.value as CategoryGroup })}
                    >
                      <option value="direct">Direct</option>
                      <option value="indirect">Indirect</option>
                    </select>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      className="btn small"
                      onClick={() => updateCategory(c.id, { archived: !c.archived })}
                    >
                      {c.archived ? "Restore" : "Archive"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="inline-form mt-8">
            <input
              className="input"
              style={{ flex: 1, minWidth: 160 }}
              placeholder="New category name"
              value={newCatName}
              onChange={(e) => setNewCatName(e.target.value)}
            />
            <select
              className="input"
              style={{ width: 110 }}
              value={newCatGroup}
              onChange={(e) => setNewCatGroup(e.target.value as CategoryGroup)}
            >
              <option value="direct">Direct</option>
              <option value="indirect">Indirect</option>
            </select>
            <button
              className="btn"
              disabled={!newCatName.trim()}
              onClick={() => {
                addCategory(newCatName, newCatGroup);
                setNewCatName("");
              }}
            >
              Add category
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        {!selected ? (
          <div className="empty-state">Select a student to see details.</div>
        ) : (
          <StudentDetail key={selected.id} studentId={selected.id} />
        )}
      </div>
    </div>
  );
}

function StudentDetail({ studentId }: { studentId: string }) {
  const { doc, updateStudent } = useStore();
  const student = doc.students.find((s) => s.id === studentId)!;

  const last12From = addDaysYmd(weekStartYmd(todayYmd()), -77);
  const trendRange = { from: last12From, to: todayYmd() };
  const matrix = useMemo(
    () => studentWeekMatrix(filterEntries(doc.entries, trendRange), "share", trendRange),
    [doc.entries],
  );
  const spark = matrix.weeks.map((w) => matrix.byWeek.get(w)?.get(studentId) ?? 0);

  const all = useMemo(
    () =>
      perStudentTotals(doc.entries, doc.students, doc.categories, "share", {
        from: "0000-01-01",
        to: "9999-12-31",
      }).find((r) => r.student.id === studentId),
    [doc, studentId],
  );

  const recentEntries = doc.entries
    .filter((e) => e.studentIds.includes(studentId))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, 8);

  return (
    <div>
      <div className="card-head">
        <h2 style={{ fontSize: 18 }}>
          {student.name} <IepBadge iep={student.iep} />
        </h2>
        <Sparkline points={spark.length >= 2 ? spark : [0, 0]} />
      </div>
      <div className="card-sub">
        {all && all.total > 0
          ? `${toHours(all.total)}h all time · ${Math.round((all.direct / all.total) * 100)}% direct · sparkline = last 12 weeks`
          : "No time logged yet."}
      </div>

      <div className="form-grid mt-16">
        <div className="form-cols">
          <div className="field">
            <label>IEP status</label>
            <select
              className="input"
              value={student.iep ? "iep" : "no"}
              onChange={(e) => updateStudent(student.id, { iep: e.target.value === "iep" })}
            >
              <option value="no">Non-IEP</option>
              <option value="iep">IEP</option>
            </select>
          </div>
          <div className="field">
            <label>Mandated min/week</label>
            <input
              className="input"
              type="number"
              min={0}
              disabled={!student.iep}
              placeholder={student.iep ? "e.g. 30" : "IEP only"}
              value={student.mandatedMinutesPerWeek ?? ""}
              onChange={(e) =>
                updateStudent(student.id, {
                  mandatedMinutesPerWeek: e.target.value ? Number(e.target.value) : null,
                })
              }
            />
          </div>
          <div className="field">
            <label>Grade</label>
            <input
              className="input"
              placeholder="e.g. 4"
              value={student.grade ?? ""}
              onChange={(e) => updateStudent(student.id, { grade: e.target.value || undefined })}
            />
          </div>
        </div>
        <div className="field">
          <label>Name</label>
          <input
            className="input"
            value={student.name}
            onChange={(e) => updateStudent(student.id, { name: e.target.value })}
          />
        </div>
        <div>
          <button
            className="btn"
            onClick={() => updateStudent(student.id, { active: !student.active })}
          >
            {student.active ? "Mark inactive (left caseload)" : "Reactivate"}
          </button>
        </div>
      </div>

      <h3 className="card-title mt-16">Recent entries</h3>
      {recentEntries.length === 0 ? (
        <div className="empty-state">None yet.</div>
      ) : (
        recentEntries.map((e) => (
          <div className="entry-row" key={e.id}>
            <span className="entry-min">{fmtDuration(e.minutes)}</span>
            <div className="entry-main">
              <div className="entry-meta">
                {fmtDayLabel(e.date)} · {categoryName(doc, e.categoryId)}
                {e.studentIds.length > 1 ? ` · group of ${e.studentIds.length}` : ""}
                {e.note ? ` · ${e.note}` : ""}
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

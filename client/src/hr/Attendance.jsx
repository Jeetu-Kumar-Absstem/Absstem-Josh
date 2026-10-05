import { useEffect, useMemo, useState } from "react";
import { DeskCard, DeskChip, DeskStat, NoticeBanner, PageHero, getDeskStatusAppearance } from "../shared/joshUi";
import { apiFetch, getApiErrorMessage } from "./api";

function queueTone(status) {
  return getDeskStatusAppearance(status, {
    success: ["present", "approved"],
    info: ["pending"],
    warning: ["late", "missing"],
    danger: ["absent"],
    fallbackTone: "#f5f7fb",
  });
}

export default function Attendance() {
  const [rows, setRows] = useState([]);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [regularization, setRegularization] = useState({
    employee: "",
    date: "",
    reason: "",
  });

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const data = await apiFetch("/hr/attendance");
        if (!active) return;
        setRows(Array.isArray(data?.rows) ? data.rows : []);
      } catch (error) {
        if (!active) return;
        setNotice(getApiErrorMessage(error, "Could not load attendance right now."));
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, []);

  const filteredRows = useMemo(() => {
    const needle = String(query || "").trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => `${row.employee} ${row.department} ${row.status} ${row.note}`.toLowerCase().includes(needle));
  }, [rows, query]);

  const stats = useMemo(() => {
    const present = rows.filter((row) => row.status === "present").length;
    const exceptions = rows.filter((row) => ["late_mark", "missing_punch", "regularization_pending"].includes(row.status)).length;
    const onLeave = rows.filter((row) => row.status === "leave").length;
    const pending = rows.filter((row) => row.status === "regularization_pending").length;
    return { present, exceptions, onLeave, pending };
  }, [rows]);

  async function updateStatus(id, status, note, outTime = null) {
    try {
      const data = await apiFetch(`/hr/attendance/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status, note, out_time: outTime }),
      });
      setRows((current) => current.map((row) => (row.id === id ? data.row : row)));
    } catch (error) {
      setNotice(getApiErrorMessage(error, "Could not update attendance right now."));
    }
  }

  async function submitRegularization() {
    if (!regularization.employee.trim() || !regularization.date.trim() || !regularization.reason.trim()) {
      setNotice("Fill employee, date, and reason before sending regularization.");
      return;
    }
    try {
      const data = await apiFetch("/hr/attendance", {
        method: "POST",
        body: JSON.stringify(regularization),
      });
      setRows((current) => [data.row, ...current]);
      setRegularization({ employee: "", date: "", reason: "" });
      setNotice("Regularization request added to the attendance queue.");
    } catch (error) {
      setNotice(getApiErrorMessage(error, "Could not create regularization right now."));
    }
  }

  return (
    <div style={{ maxWidth: 1480 }}>
      <PageHero
        eyebrow="People Time Control"
        title="Attendance"
        description="Review daily presence, late marks, missing punches, and regularization requests from one compact HR desk."
        actions={
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button type="button" onClick={() => window.location.reload()}>Refresh</button>
          </div>
        }
        stats={[
          { label: "Present today", value: String(stats.present), tone: "#147a3d" },
          { label: "Exceptions", value: String(stats.exceptions), tone: "#9f2042" },
          { label: "On leave", value: String(stats.onLeave), tone: "#8b5a00" },
          { label: "Regularization pending", value: String(stats.pending), tone: "#234a8f" },
        ]}
      />

      <NoticeBanner tone="info" message={notice} />

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(280px, 0.34fr) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <DeskCard title="Regularization Request" subtitle="Use this when an employee needs a punch or duty correction">
          <div style={{ display: "grid", gap: 10 }}>
            <input value={regularization.employee} onChange={(e) => setRegularization((current) => ({ ...current, employee: e.target.value }))} placeholder="Employee name" />
            <input type="date" value={regularization.date} onChange={(e) => setRegularization((current) => ({ ...current, date: e.target.value }))} />
            <textarea rows={4} value={regularization.reason} onChange={(e) => setRegularization((current) => ({ ...current, reason: e.target.value }))} placeholder="Reason for regularization" />
            <button type="button" onClick={submitRegularization}>Send For Review</button>
          </div>
          <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
            <DeskStat label="Late mark rule" value="3+" tone="#9f2042" />
            <DeskStat label="Review mode" value="HR + manager" tone="#234a8f" />
          </div>
        </DeskCard>

        <DeskCard title="Daily Attendance Queue" subtitle="Search by employee, department, or exception type">
          <div style={{ display: "grid", gap: 12 }}>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search attendance queue" />
            {loading ? <div style={{ fontSize: 13, opacity: 0.68 }}>Loading attendance...</div> : null}
            <div style={{ display: "grid", gap: 12 }}>
              {filteredRows.map((row) => {
                const tone = queueTone(row.status);
                return (
                  <div
                    key={row.id}
                    style={{
                      border: "1px solid #e6ebf2",
                      borderRadius: 18,
                      padding: 14,
                      background: "#ffffff",
                      display: "grid",
                      gap: 10,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                      <div>
                        <div style={{ fontWeight: 800 }}>{row.employee}</div>
                        <div style={{ marginTop: 4, fontSize: 13, opacity: 0.72 }}>
                          {[row.department, row.shift, row.in_time ? `In ${row.in_time}` : null, row.out_time ? `Out ${row.out_time}` : null].filter(Boolean).join(" • ")}
                        </div>
                      </div>
                      <DeskChip label={row.status.replace(/_/g, " ")} tone={tone.tone} color={tone.color} />
                    </div>
                    <div style={{ fontSize: 13, opacity: 0.76 }}>{row.note}</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {row.status === "missing_punch" || row.status === "regularization_pending" ? (
                        <button type="button" onClick={async () => { await updateStatus(row.id, "present", "Regularization approved.", "18:35"); setNotice(`Attendance corrected for ${row.employee}.`); }}>
                          Approve
                        </button>
                      ) : null}
                      {row.status === "late_mark" ? (
                        <button type="button" onClick={async () => { await updateStatus(row.id, "present", "Late mark reviewed and accepted."); setNotice(`Late mark reviewed for ${row.employee}.`); }}>
                          Mark Reviewed
                        </button>
                      ) : null}
                      {row.status !== "leave" ? (
                        <button type="button" onClick={async () => { await updateStatus(row.id, "leave", "Moved to approved leave for today."); setNotice(`Leave recorded for ${row.employee}.`); }}>
                          Put On Leave
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
              {!loading && !filteredRows.length ? <div style={{ fontSize: 13, opacity: 0.66 }}>No attendance records yet.</div> : null}
            </div>
          </div>
        </DeskCard>
      </div>
    </div>
  );
}

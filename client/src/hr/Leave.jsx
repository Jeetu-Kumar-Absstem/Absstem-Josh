import { useEffect, useMemo, useState } from "react";
import { DeskCard, DeskChip, NoticeBanner, PageHero } from "../shared/joshUi";
import { apiFetch, getApiErrorMessage } from "./api";

function leaveTone(status) {
  if (status === "approved") return { tone: "#effcf3", color: "#0b7d45" };
  if (status === "rejected") return { tone: "#fff2f3", color: "#9f2042" };
  return { tone: "#fff6e8", color: "#8b5a00" };
}

export default function Leave({ launch = null, onConsumeLaunch = null } = {}) {
  const [requests, setRequests] = useState([]);
  const [holidays, setHolidays] = useState([]);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [focusLeaveId, setFocusLeaveId] = useState(null);
  const [form, setForm] = useState({
    employee: "",
    leave_type: "Casual",
    start_date: "",
    end_date: "",
    total_days: "1",
    reason: "",
  });

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    const leaveId = Number(launch.leave_id || launch.leaveId || launch.id);
    if (Number.isFinite(leaveId) && leaveId > 0) setFocusLeaveId(leaveId);
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const data = await apiFetch("/hr/leave");
        if (!active) return;
        setRequests(Array.isArray(data?.requests) ? data.requests : []);
        setHolidays(Array.isArray(data?.holidays) ? data.holidays : []);
      } catch (error) {
        if (!active) return;
        setNotice(getApiErrorMessage(error, "Could not load leave records right now."));
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!focusLeaveId) return;
    const el = document.getElementById(`leave-request-${focusLeaveId}`);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [focusLeaveId, requests]);

  const orderedRequests = useMemo(() => {
    if (!focusLeaveId) return requests;
    const focused = requests.filter((item) => Number(item.id) === Number(focusLeaveId));
    const rest = requests.filter((item) => Number(item.id) !== Number(focusLeaveId));
    return [...focused, ...rest];
  }, [requests, focusLeaveId]);

  const stats = useMemo(() => {
    const pending = requests.filter((item) => item.status === "pending").length;
    const approved = requests.filter((item) => item.status === "approved").length;
    return [
      { label: "Pending leave", value: String(pending), tone: "#8b5a00" },
      { label: "Approved leave", value: String(approved), tone: "#0b7d45" },
      { label: "Holiday count", value: String(holidays.length), tone: "#234a8f" },
    ];
  }, [requests, holidays.length]);

  async function submitLeave() {
    if (!form.employee.trim() || !form.start_date || !form.end_date || !form.total_days) {
      setNotice("Fill employee, dates, and total days before sending leave.");
      return;
    }
    try {
      const data = await apiFetch("/hr/leave", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setRequests((current) => [data.request, ...current]);
      setForm({ employee: "", leave_type: "Casual", start_date: "", end_date: "", total_days: "1", reason: "" });
      setNotice("Leave request created.");
    } catch (error) {
      setNotice(getApiErrorMessage(error, "Could not create leave right now."));
    }
  }

  async function updateLeave(id, status, employee) {
    try {
      const data = await apiFetch(`/hr/leave/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      setRequests((current) => current.map((item) => (item.id === id ? data.request : item)));
      setNotice(`${employee} leave marked ${status}.`);
    } catch (error) {
      setNotice(getApiErrorMessage(error, "Could not update leave right now."));
    }
  }

  return (
    <div style={{ maxWidth: 1480 }}>
      <PageHero
        eyebrow="Employee Leave"
        title="Leave"
        description="Create leave requests, approve pending applications, and keep a working view of nearby holidays from one compact HR page."
        stats={stats}
      />

      <NoticeBanner tone="info" message={notice} />

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(300px, 0.34fr) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <DeskCard title="New Leave Request" subtitle="Casual, sick, earned, and special leave">
          <div style={{ display: "grid", gap: 10 }}>
            <input value={form.employee} onChange={(e) => setForm((current) => ({ ...current, employee: e.target.value }))} placeholder="Employee name" />
            <select value={form.leave_type} onChange={(e) => setForm((current) => ({ ...current, leave_type: e.target.value }))}>
              <option value="Casual">Casual</option>
              <option value="Sick">Sick</option>
              <option value="Earned">Earned</option>
              <option value="Special">Special</option>
            </select>
            <input type="date" value={form.start_date} onChange={(e) => setForm((current) => ({ ...current, start_date: e.target.value }))} />
            <input type="date" value={form.end_date} onChange={(e) => setForm((current) => ({ ...current, end_date: e.target.value }))} />
            <input value={form.total_days} onChange={(e) => setForm((current) => ({ ...current, total_days: e.target.value }))} placeholder="Total days" />
            <textarea rows={4} value={form.reason} onChange={(e) => setForm((current) => ({ ...current, reason: e.target.value }))} placeholder="Reason" />
            <button type="button" onClick={submitLeave}>Create Leave Request</button>
          </div>

          <div style={{ marginTop: 16, borderTop: "1px solid #eef1f6", paddingTop: 14 }}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>Upcoming Holidays</div>
            <div style={{ display: "grid", gap: 8 }}>
              {holidays.slice(0, 6).map((item) => (
                <div key={item.id} style={{ fontSize: 13, opacity: 0.78 }}>
                  {[item.holiday_date?.slice?.(0, 10) || item.holiday_date, item.holiday_name, item.holiday_type].filter(Boolean).join(" • ")}
                </div>
              ))}
              {!holidays.length ? <div style={{ fontSize: 13, opacity: 0.66 }}>No holidays added yet.</div> : null}
            </div>
          </div>
        </DeskCard>

        <DeskCard title="Leave Queue" subtitle="Approve, reject, and track employee leave">
          <div style={{ display: "grid", gap: 12 }}>
            {loading ? <div style={{ fontSize: 13, opacity: 0.68 }}>Loading leave queue...</div> : null}
            {orderedRequests.map((item) => {
              const tone = leaveTone(item.status);
              const focused = Number(item.id) === Number(focusLeaveId);
              return (
                <div
                  id={`leave-request-${item.id}`}
                  key={item.id}
                  style={{
                    border: focused ? "2px solid #96b5ff" : "1px solid #e6ebf2",
                    borderRadius: 18,
                    padding: 14,
                    background: focused ? "#f5f8ff" : "#fff",
                    display: "grid",
                    gap: 10,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>{item.employee}</div>
                      <div style={{ marginTop: 4, fontSize: 13, opacity: 0.72 }}>
                        {[item.leave_type, item.start_date?.slice?.(0, 10) || item.start_date, item.end_date?.slice?.(0, 10) || item.end_date, `${item.total_days} day(s)`].join(" • ")}
                      </div>
                    </div>
                    <DeskChip label={item.status} tone={tone.tone} color={tone.color} />
                  </div>
                  <div style={{ fontSize: 13, opacity: 0.8 }}>{item.reason || "No reason provided."}</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {item.status === "pending" ? (
                      <>
                        <button type="button" onClick={() => updateLeave(item.id, "approved", item.employee)}>Approve</button>
                        <button type="button" onClick={() => updateLeave(item.id, "rejected", item.employee)}>Reject</button>
                      </>
                    ) : null}
                  </div>
                </div>
              );
            })}
            {!loading && !requests.length ? <div style={{ fontSize: 13, opacity: 0.66 }}>No leave requests yet.</div> : null}
          </div>
        </DeskCard>
      </div>
    </div>
  );
}

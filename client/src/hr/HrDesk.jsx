import { useEffect, useMemo, useState } from "react";
import { DeskCard, DeskChip, DeskStat, DeskTopStrip, MiniMetric, NoticeBanner, getDeskStatusAppearance } from "../shared/joshUi";
import { apiFetch, getApiErrorMessage } from "./api";

function money(value) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Number(value || 0));
}

function toneForLevel(level) {
  if (level === "danger") return { tone: "#fff2f3", color: "#9f2042" };
  if (level === "warning") return { tone: "#fff6e8", color: "#8b5a00" };
  if (level === "info") return { tone: "#eef4ff", color: "#234a8f" };
  return { tone: "#effcf3", color: "#0b7d45" };
}

function QueueRow({ title, subtitle, meta, actionLabel, tone, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        all: "unset",
        cursor: "pointer",
        border: "1px solid #e6ebf2",
        borderRadius: 18,
        padding: 14,
        background: "#ffffff",
        display: "grid",
        gap: 10,
        boxShadow: "0 8px 22px rgba(20, 31, 51, 0.05)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
        <div>
          <div style={{ fontWeight: 800 }}>{title}</div>
          <div style={{ marginTop: 4, fontSize: 13, opacity: 0.74, lineHeight: 1.5 }}>{subtitle}</div>
        </div>
        <DeskChip label={actionLabel} tone={tone.tone} color={tone.color} />
      </div>
      <div style={{ fontSize: 12, opacity: 0.68 }}>{meta}</div>
    </button>
  );
}

export default function HrDesk({ onNavigate = null } = {}) {
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [actionBusyId, setActionBusyId] = useState(null);
  const [attendanceAlerts, setAttendanceAlerts] = useState([]);
  const [expenseAlerts, setExpenseAlerts] = useState([]);
  const [plannerAlerts, setPlannerAlerts] = useState([]);
  const [eventAlerts, setEventAlerts] = useState([]);
  const [leaveAlerts, setLeaveAlerts] = useState([]);
  const [salarySlipAlerts, setSalarySlipAlerts] = useState([]);

  async function loadDesk() {
    setLoading(true);
    try {
      const data = await apiFetch("/hr/desk");
      setAttendanceAlerts(Array.isArray(data?.attendance_alerts) ? data.attendance_alerts : []);
      setExpenseAlerts(Array.isArray(data?.expense_alerts) ? data.expense_alerts : []);
      setPlannerAlerts(Array.isArray(data?.planner_alerts) ? data.planner_alerts : []);
      setEventAlerts(Array.isArray(data?.event_alerts) ? data.event_alerts : []);
      setLeaveAlerts(Array.isArray(data?.leave_alerts) ? data.leave_alerts : []);
      setSalarySlipAlerts(Array.isArray(data?.salary_slip_alerts) ? data.salary_slip_alerts : []);
    } catch (error) {
      setNotice(getApiErrorMessage(error, "Could not load the HR desk right now."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDesk().catch(() => {});
  }, []);

  async function updateExpense(item, status, message) {
    setActionBusyId(`expense-${item.id}`);
    try {
      await apiFetch(`/hr/expenses/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      setNotice(message);
      await loadDesk();
    } catch (error) {
      setNotice(getApiErrorMessage(error, "Could not update the expense claim."));
    } finally {
      setActionBusyId(null);
    }
  }

  async function updateLeave(item, status) {
    setActionBusyId(`leave-${item.id}`);
    try {
      await apiFetch(`/hr/leave/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      setNotice(`${item.employee} leave marked ${status}.`);
      await loadDesk();
    } catch (error) {
      setNotice(getApiErrorMessage(error, "Could not update the leave request."));
    } finally {
      setActionBusyId(null);
    }
  }

  const topMetrics = useMemo(
    () => [
      {
        label: "Attendance exceptions",
        value: String(attendanceAlerts.length),
        tone: "#9f2042",
        note: "Open attendance queue",
        onClick: () => onNavigate?.("attendance", { resetQuote: true }),
      },
      {
        label: "Expense approvals",
        value: String(expenseAlerts.length),
        tone: "#8b5a00",
        note: "Open expenses queue",
        onClick: () => onNavigate?.("expenses", { resetQuote: true }),
      },
      {
        label: "Leave approvals",
        value: String(leaveAlerts.length),
        tone: "#7c3aed",
        note: "Open leave queue",
        onClick: () => onNavigate?.("leave", { resetQuote: true }),
      },
      {
        label: "Salary slips pending",
        value: String(salarySlipAlerts.length),
        tone: "#0f766e",
        note: "Open salary slips",
        onClick: () => onNavigate?.("salary_slips", { resetQuote: true }),
      },
    ],
    [attendanceAlerts.length, expenseAlerts.length, leaveAlerts.length, salarySlipAlerts.length, onNavigate]
  );

  const summary = useMemo(
    () => ({
      pendingExpenseAmount: expenseAlerts
        .filter((item) => item.status !== "returned")
        .reduce((sum, item) => sum + Number(item.amount || 0), 0),
      overdueActivities: plannerAlerts.filter((item) => item.status === "overdue").length + leaveAlerts.length,
      registrationOpen: eventAlerts.filter((item) => item.status === "registration_open" || item.status === "slots_filling").length + salarySlipAlerts.length,
      attendanceToday: attendanceAlerts.length,
    }),
    [attendanceAlerts, expenseAlerts, plannerAlerts, eventAlerts, leaveAlerts, salarySlipAlerts]
  );

  return (
    <div style={{ maxWidth: 1480 }}>
      <DeskTopStrip
        title="HR Desk"
        actions={
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button type="button" onClick={() => onNavigate?.("attendance", { resetQuote: true })}>Open Attendance</button>
            <button type="button" onClick={() => onNavigate?.("expenses", { resetQuote: true })}>Open Expenses</button>
            <button type="button" onClick={() => onNavigate?.("activity_planner", { resetQuote: true })}>Open Planner</button>
            <button type="button" onClick={() => onNavigate?.("events", { resetQuote: true })}>Open Events</button>
            <button type="button" onClick={() => onNavigate?.("leave", { resetQuote: true })}>Open Leave</button>
            <button type="button" onClick={() => onNavigate?.("salary", { resetQuote: true })}>Open Salary</button>
            <button type="button" onClick={() => onNavigate?.("hr_admin", { resetQuote: true })}>Open HR Admin</button>
          </div>
        }
        metrics={topMetrics}
      />

      <NoticeBanner tone="success" message={notice} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginTop: 16 }}>
        <DeskStat label="Today's attendance checks" value={summary.attendanceToday} tone="#9f2042" />
        <DeskStat label="Pending expense amount" value={`INR ${money(summary.pendingExpenseAmount)}`} tone="#8b5a00" />
        <DeskStat label="Plans + leave pending" value={summary.overdueActivities} tone="#234a8f" />
        <DeskStat label="Events + slips pending" value={summary.registrationOpen} tone="#147a3d" />
      </div>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(280px, 0.34fr)", gap: 16, alignItems: "start" }}>
        <div style={{ display: "grid", gap: 16 }}>
          <DeskCard title="Attendance Queue" subtitle="Regularization, late marks, and roster gaps">
            <div style={{ display: "grid", gap: 12 }}>
              {attendanceAlerts.map((item) => {
                const tone = toneForLevel(item.level);
                return (
                  <QueueRow
                    key={item.id}
                    title={item.employee}
                    subtitle={item.issue}
                    meta={`${item.day} • Next action: ${item.action}`}
                    actionLabel="Open Attendance"
                    tone={tone}
                    onClick={() => {
                      setNotice(`Attendance action opened for ${item.employee}.`);
                      onNavigate?.("attendance", { resetQuote: true });
                    }}
                  />
                );
              })}
              {!loading && !attendanceAlerts.length ? <div style={{ fontSize: 13, opacity: 0.66 }}>No attendance exceptions right now.</div> : null}
            </div>
          </DeskCard>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16 }}>
            <DeskCard title="Expense Queue" subtitle="Approve claims here — open Expenses only when you need the full desk">
              <div style={{ display: "grid", gap: 12 }}>
                {expenseAlerts.map((item) => {
                  const tone = getDeskStatusAppearance(item.status, {
                    warning: ["pending", "manager_pending"],
                    info: ["accounts", "accounts_pending"],
                    danger: ["returned"],
                    fallbackTone: "#eef4ff",
                  });
                  const busy = actionBusyId === `expense-${item.id}`;
                  return (
                    <div
                      key={item.id}
                      style={{
                        border: "1px solid #e6ebf2",
                        borderRadius: 18,
                        padding: 14,
                        background: "#ffffff",
                        display: "grid",
                        gap: 10,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                        <div>
                          <div style={{ fontWeight: 800 }}>{`${item.employee} • INR ${money(item.amount)}`}</div>
                          <div style={{ marginTop: 4, fontSize: 13, opacity: 0.74, lineHeight: 1.5 }}>{item.claim}</div>
                        </div>
                        <DeskChip label={String(item.status || "").replace(/_/g, " ")} tone={tone.tone} color={tone.color} />
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.68 }}>{item.action}</div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {item.status === "manager_pending" || item.status === "pending" ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              updateExpense(item, "accounts_pending", `Claim approved by manager for ${item.employee}.`)
                            }
                          >
                            {busy ? "Working…" : "Approve → Accounts"}
                          </button>
                        ) : null}
                        {item.status === "accounts_pending" || item.status === "accounts" ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => updateExpense(item, "reimbursed", `Reimbursement marked for ${item.employee}.`)}
                          >
                            {busy ? "Working…" : "Mark reimbursed"}
                          </button>
                        ) : null}
                        {item.status !== "reimbursed" && item.status !== "returned" ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => updateExpense(item, "returned", `Claim returned to ${item.employee}.`)}
                          >
                            Return
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="button-ghost"
                          onClick={() =>
                            onNavigate?.("expenses", {
                              resetQuote: true,
                              expensesLaunch: { claim_id: item.id },
                            })
                          }
                        >
                          Open claim
                        </button>
                      </div>
                    </div>
                  );
                })}
                {!loading && !expenseAlerts.length ? <div style={{ fontSize: 13, opacity: 0.66 }}>No expense approvals pending right now.</div> : null}
              </div>
            </DeskCard>

            <DeskCard title="Activity Queue" subtitle="Daily plans and overdue follow-up">
              <div style={{ display: "grid", gap: 12 }}>
                {plannerAlerts.map((item) => {
                  const tone = getDeskStatusAppearance(item.status, {
                    info: ["planned", "progress"],
                    danger: ["overdue"],
                    fallbackTone: "#f6f7fb",
                  });
                  return (
                    <QueueRow
                      key={item.id}
                      title={item.title}
                      subtitle={item.owner}
                      meta={`Due: ${item.due} • ${item.action}`}
                      actionLabel="Open Planner"
                      tone={tone}
                      onClick={() => {
                        setNotice(`Planner opened for ${item.title}.`);
                        onNavigate?.("activity_planner", { resetQuote: true });
                      }}
                    />
                  );
                })}
                {!loading && !plannerAlerts.length ? <div style={{ fontSize: 13, opacity: 0.66 }}>No planner actions waiting right now.</div> : null}
              </div>
            </DeskCard>

            <DeskCard title="Events Queue" subtitle="Broadcast, itinerary, and registration visibility">
              <div style={{ display: "grid", gap: 12 }}>
                {eventAlerts.map((item) => {
                  const tone = getDeskStatusAppearance(item.status, {
                    warning: ["open", "filling", "pending"],
                    success: ["published"],
                    fallbackTone: "#eef4ff",
                  });
                  return (
                    <QueueRow
                      key={item.id}
                      title={item.title}
                      subtitle={`Date: ${item.date}`}
                      meta={`${item.status.replace(/_/g, " ")} • ${item.action}`}
                      actionLabel="Open Events"
                      tone={tone}
                      onClick={() => {
                        setNotice(`Events workspace opened for ${item.title}.`);
                        onNavigate?.("events", { resetQuote: true });
                      }}
                    />
                  );
                })}
                {!loading && !eventAlerts.length ? <div style={{ fontSize: 13, opacity: 0.66 }}>No event actions waiting right now.</div> : null}
              </div>
            </DeskCard>

            <DeskCard title="Leave And Payroll Queue" subtitle="Approve leave here — open Leave for full history">
              <div style={{ display: "grid", gap: 12 }}>
                {leaveAlerts.map((item) => {
                  const tone = toneForLevel(item.level);
                  const busy = actionBusyId === `leave-${item.id}`;
                  return (
                    <div
                      key={`leave-${item.id}`}
                      style={{
                        border: "1px solid #e6ebf2",
                        borderRadius: 18,
                        padding: 14,
                        background: "#ffffff",
                        display: "grid",
                        gap: 10,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                        <div>
                          <div style={{ fontWeight: 800 }}>{item.employee}</div>
                          <div style={{ marginTop: 4, fontSize: 13, opacity: 0.74, lineHeight: 1.5 }}>{item.issue}</div>
                        </div>
                        <DeskChip label="pending" tone={tone.tone} color={tone.color} />
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.68 }}>{`${item.day} • ${item.action}`}</div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button type="button" disabled={busy} onClick={() => updateLeave(item, "approved")}>
                          {busy ? "Working…" : "Approve"}
                        </button>
                        <button type="button" disabled={busy} onClick={() => updateLeave(item, "rejected")}>
                          Reject
                        </button>
                        <button
                          type="button"
                          className="button-ghost"
                          onClick={() =>
                            onNavigate?.("leave", {
                              resetQuote: true,
                              leaveLaunch: { leave_id: item.id },
                            })
                          }
                        >
                          Open leave
                        </button>
                      </div>
                    </div>
                  );
                })}
                {salarySlipAlerts.map((item) => {
                  const tone = getDeskStatusAppearance(item.status, {
                    warning: ["generated"],
                    success: ["paid"],
                    fallbackTone: "#eef4ff",
                  });
                  return (
                    <QueueRow
                      key={`slip-${item.id}`}
                      title={`${item.employee} • INR ${money(item.amount)}`}
                      subtitle={item.claim}
                      meta={`${item.status.replace(/_/g, " ")} • ${item.action}`}
                      actionLabel="Open Salary Slips"
                      tone={tone}
                      onClick={() => {
                        setNotice(`Salary slips opened for ${item.employee}.`);
                        onNavigate?.("salary_slips", { resetQuote: true });
                      }}
                    />
                  );
                })}
                {!loading && !leaveAlerts.length && !salarySlipAlerts.length ? <div style={{ fontSize: 13, opacity: 0.66 }}>No leave or payroll actions waiting right now.</div> : null}
              </div>
            </DeskCard>
          </div>
        </div>

        <DeskCard title="Next Best Actions" subtitle="Use the desk as an action dashboard, not a static overview.">
          <div style={{ display: "grid", gap: 10 }}>
            <button type="button" onClick={() => onNavigate?.("attendance", { resetQuote: true })} style={{ textAlign: "left" }}>
              Review missing punches
            </button>
            <button type="button" onClick={() => onNavigate?.("expenses", { resetQuote: true })} style={{ textAlign: "left" }}>
              Clear manager approvals
            </button>
            <button type="button" onClick={() => onNavigate?.("activity_planner", { resetQuote: true })} style={{ textAlign: "left" }}>
              Close overdue plans
            </button>
            <button type="button" onClick={() => onNavigate?.("events", { resetQuote: true })} style={{ textAlign: "left" }}>
              Publish event reminders
            </button>
            <button type="button" onClick={() => onNavigate?.("leave", { resetQuote: true })} style={{ textAlign: "left" }}>
              Clear pending leave requests
            </button>
            <button type="button" onClick={() => onNavigate?.("salary_slips", { resetQuote: true })} style={{ textAlign: "left" }}>
              Close pending salary payouts
            </button>
          </div>
          <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
            <MiniMetric label="Employee model" value="User Master linked" />
            <MiniMetric label="Expense route" value="Manager -> Accounts" />
            <MiniMetric label="Planner style" value="Action driven" />
            <MiniMetric label="Events mode" value="Calendar + broadcast" />
            <MiniMetric label="Payroll mode" value="Salary + slips" />
          </div>
          {loading ? <div style={{ fontSize: 13, opacity: 0.68, marginTop: 12 }}>Loading HR queues...</div> : null}
        </DeskCard>
      </div>
    </div>
  );
}

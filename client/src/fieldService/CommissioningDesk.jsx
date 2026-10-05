import { useCallback, useEffect, useMemo, useState } from "react";
import { PressFitLinker, toast } from "../shared/joshUi";
import CommissioningCompletionModal from "./CommissioningCompletionModal";

async function apiFetch(path, options) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error("Request failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  return d.toLocaleDateString();
}

function assignErrorMessage(err) {
  const code = err?.data?.error;
  if (code === "ENGINEER_REQUIRED") return "Select a field engineer before linking.";
  if (code === "ENGINEER_NOT_FOUND") return "That engineer was not found or is inactive.";
  if (code === "ALREADY_COMPLETED") return "Completed tickets cannot be reassigned.";
  if (code === "NOT_FOUND") return "Commissioning ticket not found.";
  if (code === "FORBIDDEN") return "You do not have permission to assign this ticket.";
  if (typeof err?.data?.detail === "string" && err.data.detail.trim()) return err.data.detail.trim();
  if (typeof code === "string" && code.trim()) return code.trim();
  return err?.message || "Could not assign engineer.";
}

const STATUS_STYLE = {
  Pending: { tone: "#fff7ea", color: "#8b5a00" },
  In_Progress: { tone: "#eef4ff", color: "#234a8f" },
  Completed: { tone: "#eefbf3", color: "#0b7d45" },
};

/**
 * Field engineer desk — commissioning tickets assigned to the logged-in user (or all if SuperAdmin).
 */
export default function CommissioningDesk({ me }) {
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mineOnly, setMineOnly] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [activeTicket, setActiveTicket] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newSoId, setNewSoId] = useState("");
  const [engineers, setEngineers] = useState([]);
  const [engineersLoading, setEngineersLoading] = useState(false);
  const [assignTicketId, setAssignTicketId] = useState("");
  const [assignEngineerId, setAssignEngineerId] = useState("");

  const isSuper = me?.group_name === "SuperAdmin";

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (mineOnly && !isSuper) params.set("mine", "1");
      if (mineOnly && isSuper) params.set("mine", "1");
      if (statusFilter) params.set("status", statusFilter);
      const data = await apiFetch(`/field-service/tickets?${params.toString()}`);
      setTickets(Array.isArray(data?.tickets) ? data.tickets : []);
    } catch (err) {
      setError(err?.data?.error || err?.data?.detail || "Failed to load commissioning tickets.");
      setTickets([]);
    } finally {
      setLoading(false);
    }
  }, [mineOnly, statusFilter, isSuper]);

  const loadEngineers = useCallback(async () => {
    setEngineersLoading(true);
    try {
      const data = await apiFetch("/field-service/engineers");
      setEngineers(Array.isArray(data?.engineers) ? data.engineers : []);
    } catch {
      setEngineers([]);
    } finally {
      setEngineersLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  useEffect(() => {
    loadEngineers().catch(() => {});
  }, [loadEngineers]);

  const openCount = useMemo(
    () => tickets.filter((t) => String(t.status) !== "Completed").length,
    [tickets]
  );

  const assignableTickets = useMemo(
    () => tickets.filter((t) => String(t.status) !== "Completed"),
    [tickets]
  );

  const selectedAssignTicket = useMemo(
    () => assignableTickets.find((t) => String(t.id) === String(assignTicketId)) || null,
    [assignableTickets, assignTicketId]
  );

  const selectedEngineer = useMemo(
    () => engineers.find((e) => String(e.id) === String(assignEngineerId)) || null,
    [engineers, assignEngineerId]
  );

  const engineerAlreadyLinked =
    selectedAssignTicket &&
    selectedEngineer &&
    Number(selectedAssignTicket.assigned_engineer_id) === Number(selectedEngineer.id);

  async function createTicket() {
    const salesOrderId = Number(newSoId);
    if (!Number.isFinite(salesOrderId) || salesOrderId <= 0) {
      setError("Enter a valid sales order id.");
      return;
    }
    setCreating(true);
    setError("");
    setNotice("");
    try {
      await apiFetch("/field-service/tickets", {
        method: "POST",
        body: JSON.stringify({
          sales_order_id: salesOrderId,
          assigned_engineer_id: me?.id,
          scheduled_date: new Date().toISOString().slice(0, 10),
          status: "Pending",
        }),
      });
      setNewSoId("");
      setNotice("Commissioning ticket created.");
      await refresh();
    } catch (err) {
      setError(err?.data?.error || err?.data?.detail || "Failed to create ticket.");
    } finally {
      setCreating(false);
    }
  }

  async function markInProgress(ticket) {
    setError("");
    try {
      await apiFetch(`/field-service/tickets/${ticket.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "In_Progress" }),
      });
      await refresh();
    } catch (err) {
      setError(err?.data?.error || "Failed to update ticket.");
    }
  }

  async function pressFitAssignEngineer() {
    if (!selectedAssignTicket?.id) {
      const err = new Error("Select a commissioning ticket first.");
      err.data = { error: "INVALID_ID" };
      throw err;
    }
    if (!selectedEngineer?.id) {
      const err = new Error("Select a field engineer before linking.");
      err.data = { error: "ENGINEER_REQUIRED" };
      throw err;
    }
    const data = await apiFetch(`/field-service/tickets/${selectedAssignTicket.id}/assign-engineer`, {
      method: "POST",
      body: JSON.stringify({ assigned_engineer_id: selectedEngineer.id }),
    });
    const name = data?.ticket?.assigned_engineer_name || selectedEngineer.full_name || selectedEngineer.email;
    const soLabel = selectedAssignTicket.so_number || `SO #${selectedAssignTicket.sales_order_id}`;
    setNotice(`${name} press-fit to ${soLabel} (ticket #${selectedAssignTicket.id}).`);
    await refresh();
    return data;
  }

  function engineerLabel(eng) {
    if (!eng) return "Select engineer";
    return eng.full_name || eng.email || `User #${eng.id}`;
  }

  function ticketRightLabel(ticket) {
    if (!ticket) return "Dispatch ticket";
    const so = ticket.so_number || `SO #${ticket.sales_order_id}`;
    return `${so} · Ticket #${ticket.id}`;
  }

  return (
    <div style={{ maxWidth: 1200 }}>
      <div
        style={{
          border: "1px solid #dde5f1",
          borderRadius: 22,
          padding: 18,
          background: "linear-gradient(135deg, #ebfffb 0%, #ffffff 45%, #eef4ff 100%)",
          marginBottom: 16,
        }}
      >
        <div style={{ fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", opacity: 0.56 }}>Field service</div>
        <h2 style={{ margin: "8px 0 0", fontSize: 28 }}>Commissioning desk</h2>
        <div style={{ fontSize: 13, opacity: 0.74, marginTop: 8, maxWidth: 720, lineHeight: 1.6 }}>
          Complete on-site commissioning to start warranty clocks and unlock commissioning milestones. Dispatch remains gated by site readiness on the sales order.
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14, alignItems: "center" }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>{openCount} open</span>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
            <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
            Assigned to me
          </label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ minHeight: 34 }}>
            <option value="">All statuses</option>
            <option value="Pending">Pending</option>
            <option value="In_Progress">In progress</option>
            <option value="Completed">Completed</option>
          </select>
          <button type="button" onClick={() => refresh()} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {error ? (
        <div style={{ color: "#9f1428", marginBottom: 12, padding: "10px 12px", borderRadius: 10, background: "#fff2f4", border: "1px solid #f0b7c1" }}>
          {error}
        </div>
      ) : null}
      {notice ? (
        <div style={{ color: "#0d6b33", marginBottom: 12, padding: "10px 12px", borderRadius: 10, background: "#effbf4", border: "1px solid #b9e7c8" }}>
          {notice}
        </div>
      ) : null}

      <div
        style={{
          border: "1px solid #dfe5ef",
          borderRadius: 16,
          padding: 14,
          background: "#fff",
          marginBottom: 16,
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", opacity: 0.6 }}>New ticket</div>
        <input
          placeholder="Sales order id"
          value={newSoId}
          onChange={(e) => setNewSoId(e.target.value)}
          style={{ minWidth: 160, minHeight: 34, borderRadius: 8, border: "1px solid #b8c5da", padding: "0 10px" }}
        />
        <button type="button" onClick={createTicket} disabled={creating}>
          {creating ? "Creating…" : "Create & assign to me"}
        </button>
      </div>

      <div
        style={{
          border: "1px solid #dfe5ef",
          borderRadius: 16,
          padding: 16,
          background: "#fff",
          marginBottom: 16,
          display: "grid",
          gap: 12,
        }}
      >
        <div>
          <div style={{ fontWeight: 800, fontSize: 14 }}>Press-fit engineer → ticket</div>
          <div style={{ fontSize: 12, opacity: 0.65, marginTop: 4, lineHeight: 1.5 }}>
            Physical interlock before travel — crimp locks the field engineer onto the commissioning / dispatch ticket.
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          <label style={{ display: "grid", gap: 6, fontSize: 12, fontWeight: 700, color: "#475569" }}>
            Open ticket
            <select
              value={assignTicketId}
              onChange={(e) => setAssignTicketId(e.target.value)}
              disabled={loading}
              style={{ fontWeight: 600, color: "#16202b", minHeight: 38 }}
            >
              <option value="">Select ticket…</option>
              {assignableTickets.map((t) => (
                <option key={t.id} value={String(t.id)}>
                  {t.so_number || `SO #${t.sales_order_id}`} · Ticket #{t.id}
                  {t.assigned_engineer_name ? ` · ${t.assigned_engineer_name}` : " · unassigned"}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 12, fontWeight: 700, color: "#475569" }}>
            Field engineer
            <select
              value={assignEngineerId}
              onChange={(e) => setAssignEngineerId(e.target.value)}
              disabled={engineersLoading}
              style={{ fontWeight: 600, color: "#16202b", minHeight: 38 }}
            >
              <option value="">{engineersLoading ? "Loading engineers…" : "Select engineer…"}</option>
              {engineers.map((eng) => (
                <option key={eng.id} value={String(eng.id)}>
                  {engineerLabel(eng)}
                  {eng.user_code ? ` · ${eng.user_code}` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>

        {selectedAssignTicket && selectedEngineer ? (
          <div style={{ overflowX: "auto", background: "#f8fafc", borderRadius: 14, padding: 14, border: "1px solid #e8eef6" }}>
            <div style={{ minWidth: 320 }}>
              <PressFitLinker
                leftLabel={engineerLabel(selectedEngineer)}
                rightLabel={ticketRightLabel(selectedAssignTicket)}
                linked={Boolean(engineerAlreadyLinked)}
                linkLabel="Assign engineer"
                linkedLabel="Assigned · Crimped"
                onLink={pressFitAssignEngineer}
                onError={(err) => toast(assignErrorMessage(err), "error")}
                onLinked={() =>
                  toast(
                    `${engineerLabel(selectedEngineer)} linked to ${ticketRightLabel(selectedAssignTicket)}`,
                    "success"
                  )
                }
              />
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 12, opacity: 0.55 }}>Select a ticket and engineer to enable the press-fit linker.</div>
        )}
      </div>

      <div style={{ border: "1px solid #dfe5ef", borderRadius: 16, overflow: "hidden", background: "#fff" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#f6f8fc" }}>
              <th style={{ padding: "10px 12px", textAlign: "left", width: 150 }}>Sales order</th>
              <th style={{ padding: "10px 12px", textAlign: "left" }}>Customer</th>
              <th style={{ padding: "10px 12px", textAlign: "left", width: 160 }}>Engineer</th>
              <th style={{ padding: "10px 12px", textAlign: "left", width: 120 }}>Scheduled</th>
              <th style={{ padding: "10px 12px", textAlign: "center", width: 120 }}>Status</th>
              <th style={{ padding: "10px 12px", textAlign: "center", width: 220 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} style={{ padding: 16, opacity: 0.7, textAlign: "center" }}>
                  Loading tickets…
                </td>
              </tr>
            ) : tickets.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: 16, opacity: 0.7, textAlign: "center" }}>
                  No commissioning tickets match this filter.
                </td>
              </tr>
            ) : (
              tickets.map((ticket) => {
                const style = STATUS_STYLE[ticket.status] || STATUS_STYLE.Pending;
                const done = String(ticket.status) === "Completed";
                return (
                  <tr key={ticket.id} style={{ borderTop: "1px solid #edf1f7" }}>
                    <td style={{ padding: "12px" }}>
                      <div style={{ fontWeight: 700 }}>{ticket.so_number || `SO #${ticket.sales_order_id}`}</div>
                      <div style={{ fontSize: 12, opacity: 0.6 }}>Ticket #{ticket.id}</div>
                    </td>
                    <td style={{ padding: "12px" }}>{ticket.customer_name || "—"}</td>
                    <td style={{ padding: "12px" }}>{ticket.assigned_engineer_name || "—"}</td>
                    <td style={{ padding: "12px" }}>{fmtDate(ticket.scheduled_date)}</td>
                    <td style={{ padding: "12px", textAlign: "center" }}>
                      <span
                        style={{
                          display: "inline-flex",
                          padding: "3px 9px",
                          borderRadius: 999,
                          background: style.tone,
                          color: style.color,
                          fontWeight: 700,
                          fontSize: 12,
                        }}
                      >
                        {ticket.status}
                      </span>
                    </td>
                    <td style={{ padding: "12px", textAlign: "center" }}>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
                        {!done ? (
                          <button
                            type="button"
                            className="button-ghost"
                            onClick={() => {
                              setAssignTicketId(String(ticket.id));
                              if (ticket.assigned_engineer_id) {
                                setAssignEngineerId(String(ticket.assigned_engineer_id));
                              }
                            }}
                          >
                            Assign
                          </button>
                        ) : null}
                        {!done && ticket.status === "Pending" ? (
                          <button type="button" onClick={() => markInProgress(ticket)}>
                            Start
                          </button>
                        ) : null}
                        {!done ? (
                          <button type="button" onClick={() => setActiveTicket(ticket)}>
                            Complete commissioning
                          </button>
                        ) : (
                          <span style={{ fontSize: 12, opacity: 0.65 }}>
                            Signed {fmtDate(ticket.client_signoff_date)}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {activeTicket ? (
        <CommissioningCompletionModal
          me={me}
          ticket={activeTicket}
          onClose={() => setActiveTicket(null)}
          onCompleted={(data) => {
            setActiveTicket(null);
            const unlocked = Array.isArray(data?.unlocked_milestones) ? data.unlocked_milestones.length : 0;
            const assets = Array.isArray(data?.warranty?.assets) ? data.warranty.assets.length : 0;
            setNotice(`Commissioning locked. Warranty assets updated: ${assets}. Milestones unlocked: ${unlocked}.`);
            refresh().catch(() => {});
          }}
        />
      ) : null}
    </div>
  );
}

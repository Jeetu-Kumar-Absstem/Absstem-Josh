import { useEffect, useMemo, useState } from "react";
import ConfirmDraftCard from "../components/ConfirmDraftCard";
import { compressReceiptImage } from "../hr/compressImage";
import { buildServiceTicketAssignDraft } from "../shared/aiDrafts";
import { toast } from "../shared/joshUi";

async function apiFetch(path, options) {
  const res = await fetch(path, {
    credentials: "include",
    headers: options?.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.detail || data?.error || "Request failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function statusLabel(value) {
  return String(value || "").replace(/_/g, " ");
}

export default function ServiceTickets({ launch = null, onConsumeLaunch = null, onOpenMyDuty = null, onOpenJobCard = null }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tickets, setTickets] = useState([]);
  const [summary, setSummary] = useState(null);
  const [bootstrap, setBootstrap] = useState({ customers: [], users: [], job_assets: [], field_my_day: null, note: "" });
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [filter, setFilter] = useState("open");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    customer_id: "",
    complaint_type: "complaint",
    ticket_priority: "normal",
    symptom_summary: "",
    site_name: "",
    site_address: "",
    reported_by: "",
    job_asset_id: "",
    assigned_to_user_id: "",
  });
  const [assignUserId, setAssignUserId] = useState("");
  const [visitForm, setVisitForm] = useState({ scheduled_date: "", visit_notes: "", engineer_user_id: "" });
  const [signatory, setSignatory] = useState("");
  const [assignDraft, setAssignDraft] = useState(null);
  const [weekFrom, setWeekFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [scheduleEngineerId, setScheduleEngineerId] = useState("");
  const [scheduleByDate, setScheduleByDate] = useState({});
  const [selectedScheduleDay, setSelectedScheduleDay] = useState("");
  const [closeNote, setCloseNote] = useState("");

  const selectedTicket = detail?.ticket || null;
  const visits = detail?.visits || [];
  const ticketStatus = String(selectedTicket?.ticket_status || "");
  const ticketIsFinished = ["resolved", "closed", "cancelled"].includes(ticketStatus);
  const hasCompletedVisit = visits.some((v) => v.visit_status === "completed");
  const bomLines = detail?.asset_bom_lines || [];

  const customerAssets = useMemo(() => {
    const cid = Number(form.customer_id || selectedTicket?.customer_id);
    if (!cid) return bootstrap.job_assets || [];
    return (bootstrap.job_assets || []).filter((a) => Number(a.customer_id) === cid);
  }, [bootstrap.job_assets, form.customer_id, selectedTicket?.customer_id]);

  async function loadList() {
    const params = new URLSearchParams();
    if (filter === "mine") params.set("assigned_to", "me");
    else if (filter === "unassigned") params.set("assigned_to", "unassigned");
    else if (filter && filter !== "all") params.set("status", filter === "open" ? "" : filter);
    if (filter === "open") {
      /* show open-ish via client filter below */
    }
    if (q.trim()) params.set("q", q.trim());
    const scheduleParams = new URLSearchParams({ from: weekFrom });
    if (scheduleEngineerId) scheduleParams.set("engineer_id", scheduleEngineerId);
    const [list, sum, boot, schedule] = await Promise.all([
      apiFetch(`/service-tickets?${params.toString()}`),
      apiFetch("/service-tickets/summary"),
      apiFetch("/service-tickets/bootstrap"),
      apiFetch(`/service-tickets/schedule?${scheduleParams.toString()}`).catch(() => null),
    ]);
    let rows = Array.isArray(list?.tickets) ? list.tickets : [];
    if (filter === "open") {
      rows = rows.filter((t) => ["open", "assigned", "in_progress", "waiting_customer"].includes(t.ticket_status));
    }
    setTickets(rows);
    setSummary(sum?.summary || null);
    setBootstrap({
      customers: boot?.customers || [],
      users: boot?.users || [],
      job_assets: boot?.job_assets || [],
      field_my_day: boot?.field_my_day || null,
      note: boot?.note || "",
    });
    setScheduleByDate(schedule?.by_date && typeof schedule.by_date === "object" ? schedule.by_date : {});
    if (!selectedScheduleDay) setSelectedScheduleDay(weekFrom);
  }

  async function loadDetail(id) {
    if (!id) {
      setDetail(null);
      return;
    }
    const data = await apiFetch(`/service-tickets/${id}`);
    setDetail(data);
    setAssignUserId(data?.ticket?.assigned_to_user_id ? String(data.ticket.assigned_to_user_id) : "");
    setVisitForm((prev) => ({
      ...prev,
      engineer_user_id: data?.ticket?.assigned_to_user_id ? String(data.ticket.assigned_to_user_id) : prev.engineer_user_id,
    }));
  }

  async function refreshAll(preferredId = selectedId) {
    setLoading(true);
    setError("");
    try {
      await loadList();
      if (preferredId) await loadDetail(preferredId);
    } catch (e) {
      setError(e?.data?.detail || e?.data?.error || e.message || "Failed to load service tickets.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshAll().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, weekFrom, scheduleEngineerId]);

  useEffect(() => {
    const launchId = Number(launch?.ticket_id || launch?.ticketId);
    if (!Number.isFinite(launchId) || launchId <= 0) return;
    setSelectedId(launchId);
    loadDetail(launchId).catch(() => {});
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launch]);

  async function createTicket(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const payload = {
        ...form,
        customer_id: Number(form.customer_id),
        job_asset_id: form.job_asset_id ? Number(form.job_asset_id) : null,
        assigned_to_user_id: form.assigned_to_user_id ? Number(form.assigned_to_user_id) : null,
      };
      const data = await apiFetch("/service-tickets", { method: "POST", body: JSON.stringify(payload) });
      toast("Ticket created.", "success");
      setCreating(false);
      setForm({
        customer_id: "",
        complaint_type: "complaint",
        ticket_priority: "normal",
        symptom_summary: "",
        site_name: "",
        site_address: "",
        reported_by: "",
        job_asset_id: "",
        assigned_to_user_id: "",
      });
      setSelectedId(data?.ticket?.id || null);
      await refreshAll(data?.ticket?.id || null);
    } catch (err) {
      toast(err?.data?.detail || err?.data?.error || "Could not create ticket.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function linkAsset(jobAssetId) {
    if (!selectedTicket || busy) return;
    setBusy(true);
    try {
      const data = await apiFetch(`/service-tickets/${selectedTicket.id}`, {
        method: "PUT",
        body: JSON.stringify({ job_asset_id: jobAssetId ? Number(jobAssetId) : null }),
      });
      setDetail(data);
      toast(jobAssetId ? "Job asset linked." : "Job asset cleared.", "success");
      await loadList();
    } catch (err) {
      toast(err?.data?.detail || err?.data?.error || "Could not update asset.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function setTicketStatus(nextStatus) {
    if (!selectedTicket || busy) return;
    setBusy(true);
    try {
      const note = closeNote.trim();
      const payload = { ticket_status: nextStatus };
      if (note) {
        const stamp = new Date().toLocaleDateString();
        payload.remarks = [selectedTicket.remarks, `${statusLabel(nextStatus)} ${stamp}: ${note}`].filter(Boolean).join("\n").slice(-2000);
      }
      const data = await apiFetch(`/service-tickets/${selectedTicket.id}`, { method: "PUT", body: JSON.stringify(payload) });
      setDetail(data);
      setCloseNote("");
      toast(
        nextStatus === "closed" ? "Ticket closed." : nextStatus === "resolved" ? "Ticket marked resolved." : "Ticket reopened.",
        "success"
      );
      await loadList();
    } catch (err) {
      toast(err?.data?.detail || err?.data?.error || "Could not update ticket status.", "error");
    } finally {
      setBusy(false);
    }
  }

  function openAssignDraft() {
    if (!selectedTicket || !assignUserId) return;
    const engineer = (bootstrap.users || []).find((u) => Number(u.id) === Number(assignUserId));
    const draft = buildServiceTicketAssignDraft({
      ticket: selectedTicket,
      engineerUserId: assignUserId,
      engineerName: engineer?.full_name || engineer?.email || "",
    });
    if (!draft) {
      toast("Could not draft engineer assignment.", "error");
      return;
    }
    setAssignDraft(draft);
  }

  async function confirmAssignDraft(data) {
    setAssignDraft(null);
    if (data) setDetail(data);
    toast("Engineer assigned.", "success");
    await loadList();
  }

  async function assignEngineer() {
    openAssignDraft();
  }

  async function scheduleVisit(e) {
    e.preventDefault();
    if (!selectedTicket || busy) return;
    if (!selectedTicket.job_asset_id) {
      toast("Link a job asset before scheduling a visit.", "error");
      return;
    }
    setBusy(true);
    try {
      const data = await apiFetch(`/service-tickets/${selectedTicket.id}/visits`, {
        method: "POST",
        body: JSON.stringify({
          scheduled_date: visitForm.scheduled_date || null,
          visit_notes: visitForm.visit_notes || null,
          engineer_user_id: visitForm.engineer_user_id ? Number(visitForm.engineer_user_id) : null,
        }),
      });
      setDetail(data);
      toast("Visit scheduled.", "success");
    } catch (err) {
      toast(err?.data?.detail || err?.data?.error || "Could not schedule visit.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function visitAction(visitId, action) {
    if (!selectedTicket || busy) return;
    setBusy(true);
    try {
      const data = await apiFetch(`/service-tickets/${selectedTicket.id}/visits/${visitId}`, {
        method: "PUT",
        body: JSON.stringify({ action }),
      });
      setDetail(data);
      toast(
        action === "check_in"
          ? "Site visit checked in. Keep attendance punch in Field My Day."
          : "Visit updated.",
        "success"
      );
    } catch (err) {
      toast(err?.data?.detail || err?.data?.error || "Visit update failed.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function uploadSignedReport(visitId, file) {
    if (!selectedTicket || !file || busy) return;
    setBusy(true);
    try {
      let uploadFile = file;
      try {
        const compressed = await compressReceiptImage(file);
        uploadFile = compressed?.file || file;
      } catch {
        uploadFile = file;
      }
      const body = new FormData();
      body.append("signed_report", uploadFile, uploadFile.name || "signed-report.jpg");
      if (signatory.trim()) body.append("customer_signatory_name", signatory.trim());
      const res = await fetch(`/service-tickets/${selectedTicket.id}/visits/${visitId}/signed-report`, {
        method: "POST",
        credentials: "include",
        body,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw Object.assign(new Error("upload failed"), { data, status: res.status });
      setDetail(data);
      toast("Signed report uploaded.", "success");
    } catch (err) {
      toast(err?.data?.detail || err?.data?.error || "Upload failed.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function raiseMrn(visitId = null) {
    if (!selectedTicket) return;
    setBusy(true);
    try {
      const complaintType = String(selectedTicket.complaint_type || "").toLowerCase();
      const jobType = complaintType === "installation" || complaintType === "commissioning" ? "installation" : "service";
      const payload = {
        job_type: jobType,
        job_status: "submitted",
        site_name: selectedTicket.site_name || null,
      };
      if (visitId) payload.service_ticket_visit_id = Number(visitId);
      const data = await apiFetch(`/job-cards/from-service-ticket/${selectedTicket.id}`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const jobCardId = data?.job_card?.id;
      toast(`MRN ${data?.job_card?.job_card_number || ""} raised.`, "success");
      if (jobCardId && typeof onOpenJobCard === "function") {
        onOpenJobCard(jobCardId);
      }
    } catch (err) {
      toast(err?.data?.detail || err?.data?.error || "Could not raise MRN.", "error");
    } finally {
      setBusy(false);
    }
  }

  const stats = [
    { label: "Open", value: summary?.open_count ?? "—", key: "open" },
    { label: "Unassigned", value: summary?.unassigned_count ?? "—", key: "unassigned" },
    { label: "Overdue", value: summary?.overdue_count ?? "—", key: "open" },
    { label: "Mine", value: summary?.mine_count ?? "—", key: "mine" },
  ];

  return (
    <div className="service-tickets-shell">
      <div className="service-tickets-hero">
        <div>
          <div className="panel-kicker">Aftermarket</div>
          <h3>Service Tickets</h3>
          <p>Complaint intake, engineer assignment, site visits, and signed reports for AT pilot.</p>
        </div>
        <div className="service-tickets-hero-actions">
          <button type="button" className="button-primary compact-button service-tap" onClick={() => setCreating((v) => !v)} disabled={busy}>
            {creating ? "Close form" : "New ticket"}
          </button>
          <button type="button" className="button-ghost compact-button service-tap" onClick={() => refreshAll()} disabled={loading || busy}>
            Refresh
          </button>
          {typeof onOpenMyDuty === "function" ? (
            <button type="button" className="button-ghost compact-button service-tap" onClick={() => onOpenMyDuty()}>
              Field My Day
            </button>
          ) : null}
        </div>
      </div>

      <div className="service-tickets-note">
        {bootstrap.note || "Visit check-in marks the site visit only. Attendance punch stays in Field My Day."}
        {bootstrap.field_my_day ? (
          <span>
            {" "}
            Today: <strong>{bootstrap.field_my_day.attendance_status || "—"}</strong>
            {bootstrap.field_my_day.in_time ? ` · in ${bootstrap.field_my_day.in_time}` : ""}
            {bootstrap.field_my_day.out_time ? ` · out ${bootstrap.field_my_day.out_time}` : ""}
          </span>
        ) : (
          <span> No Field My Day punch recorded for today yet.</span>
        )}
      </div>

      <div className="service-tickets-stats">
        {stats.map((item) => (
          <button key={item.label} type="button" className="service-tickets-stat" onClick={() => setFilter(item.key)}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </button>
        ))}
      </div>

      <div className="service-tickets-week" style={{ margin: "12px 0 18px", padding: 12, border: "1px solid #e7ebf3", borderRadius: 16, background: "#fbfcfe" }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
          <strong style={{ fontSize: 14 }}>Engineer week</strong>
          <label style={{ fontSize: 13 }}>
            From{" "}
            <input
              type="date"
              value={weekFrom}
              onChange={(e) => {
                setWeekFrom(e.target.value);
                setSelectedScheduleDay(e.target.value);
              }}
            />
          </label>
          <label style={{ fontSize: 13 }}>
            Engineer{" "}
            <select value={scheduleEngineerId} onChange={(e) => setScheduleEngineerId(e.target.value)}>
              <option value="">All</option>
              {(bootstrap.users || []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name || u.email}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 8 }}>
          {Array.from({ length: 7 }).map((_, idx) => {
            const d = new Date(`${weekFrom}T00:00:00`);
            d.setDate(d.getDate() + idx);
            const key = d.toISOString().slice(0, 10);
            const dayVisits = scheduleByDate[key] || [];
            const active = selectedScheduleDay === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setSelectedScheduleDay(key)}
                style={{
                  textAlign: "left",
                  border: active ? "1px solid #0f766e" : "1px solid #e7ebf3",
                  background: active ? "#ebfffb" : "#fff",
                  borderRadius: 12,
                  padding: 8,
                  minHeight: 72,
                }}
              >
                <div style={{ fontSize: 11, opacity: 0.65 }}>{key.slice(5)}</div>
                <strong style={{ fontSize: 16 }}>{dayVisits.length}</strong>
                <div style={{ fontSize: 11, opacity: 0.7 }}>visits</div>
              </button>
            );
          })}
        </div>
        {selectedScheduleDay && (scheduleByDate[selectedScheduleDay] || []).length > 0 ? (
          <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
            {(scheduleByDate[selectedScheduleDay] || []).slice(0, 8).map((v) => (
              <button
                key={v.visit_id}
                type="button"
                className="button-ghost compact-button"
                style={{ justifyContent: "flex-start" }}
                onClick={() => setSelectedId(v.ticket_id)}
              >
                {v.ticket_number} · {v.customer_name} · {v.engineer_name || "Unassigned"} · {statusLabel(v.visit_status)}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {creating ? (
        <form className="service-tickets-create" onSubmit={createTicket}>
          <h4>New complaint ticket</h4>
          <label>
            Customer
            <select required value={form.customer_id} onChange={(e) => setForm((f) => ({ ...f, customer_id: e.target.value, job_asset_id: "" }))}>
              <option value="">Select customer</option>
              {bootstrap.customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.customer_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Complaint type
            <select value={form.complaint_type} onChange={(e) => setForm((f) => ({ ...f, complaint_type: e.target.value }))}>
              {["complaint", "breakdown", "installation", "commissioning", "preventive", "other"].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            Priority
            <select value={form.ticket_priority} onChange={(e) => setForm((f) => ({ ...f, ticket_priority: e.target.value }))}>
              {["critical", "high", "normal", "low"].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            Symptom / complaint
            <textarea required rows={3} value={form.symptom_summary} onChange={(e) => setForm((f) => ({ ...f, symptom_summary: e.target.value }))} />
          </label>
          <label>
            Site name
            <input value={form.site_name} onChange={(e) => setForm((f) => ({ ...f, site_name: e.target.value }))} />
          </label>
          <label>
            Job asset (optional now — required before visit)
            <select value={form.job_asset_id} onChange={(e) => setForm((f) => ({ ...f, job_asset_id: e.target.value }))}>
              <option value="">Link later</option>
              {customerAssets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.serial_no} · {a.finished_good_item_name || a.finished_good_item_code || a.site_name || a.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            Assign engineer (optional)
            <select value={form.assigned_to_user_id} onChange={(e) => setForm((f) => ({ ...f, assigned_to_user_id: e.target.value }))}>
              <option value="">Unassigned</option>
              {bootstrap.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name || u.email}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="button-primary service-tap" disabled={busy}>
            {busy ? "Saving…" : "Create ticket"}
          </button>
        </form>
      ) : null}

      <div className="service-tickets-filters">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="open">Open queue</option>
          <option value="unassigned">Unassigned</option>
          <option value="mine">Mine</option>
          <option value="all">All</option>
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ticket, customer, site" onKeyDown={(e) => e.key === "Enter" && refreshAll()} />
        <button type="button" className="button-ghost compact-button" onClick={() => refreshAll()}>
          Apply
        </button>
      </div>

      {error ? <div className="service-tickets-error">{error}</div> : null}

      <div className="service-tickets-layout">
        <div className="service-tickets-list">
          {loading ? <div className="service-tickets-empty">Loading…</div> : null}
          {!loading && !tickets.length ? <div className="service-tickets-empty">No tickets in this filter.</div> : null}
          {tickets.map((row) => (
            <button
              key={row.id}
              type="button"
              className={`service-tickets-row ${Number(selectedId) === Number(row.id) ? "is-selected" : ""}`}
              onClick={() => {
                setSelectedId(row.id);
                loadDetail(row.id).catch(() => toast("Could not open ticket.", "error"));
              }}
            >
              <strong>{row.ticket_number}</strong>
              <span>{row.customer_name}</span>
              <em>
                {statusLabel(row.ticket_status)} · {row.ticket_priority}
                {row.assigned_to_name ? ` · ${row.assigned_to_name}` : " · Unassigned"}
              </em>
            </button>
          ))}
        </div>

        <div className="service-tickets-detail">
          {!selectedTicket ? <div className="service-tickets-empty">Select a ticket.</div> : null}
          {selectedTicket ? (
            <>
              <div className="service-tickets-detail-head">
                <div>
                  <h4>{selectedTicket.ticket_number}</h4>
                  <p>
                    {selectedTicket.customer_name} · {statusLabel(selectedTicket.ticket_status)} · {selectedTicket.complaint_type}
                  </p>
                </div>
                <button type="button" className="button-primary compact-button service-tap" onClick={() => raiseMrn()} disabled={busy}>
                  {busy ? "Working…" : "Raise MRN"}
                </button>
              </div>
              <p className="service-tickets-symptom">{selectedTicket.symptom_summary}</p>

              <section className="service-tickets-panel">
                <h5>{ticketIsFinished ? `Ticket ${statusLabel(ticketStatus)}` : "Finish this ticket"}</h5>
                {!ticketIsFinished && !hasCompletedVisit ? (
                  <p className="service-warn">No completed site visit yet. Close only if the issue was fixed remotely or is no longer needed.</p>
                ) : null}
                {ticketStatus !== "closed" && ticketStatus !== "cancelled" ? (
                  <input
                    placeholder="Closing note (what was done)"
                    value={closeNote}
                    onChange={(e) => setCloseNote(e.target.value)}
                    disabled={busy}
                  />
                ) : null}
                <div className="service-visit-actions">
                  {!ticketIsFinished ? (
                    <button type="button" className="service-tap" disabled={busy} onClick={() => setTicketStatus("resolved")}>
                      Mark resolved
                    </button>
                  ) : null}
                  {ticketStatus !== "closed" && ticketStatus !== "cancelled" ? (
                    <button type="button" className="button-primary service-tap" disabled={busy} onClick={() => setTicketStatus("closed")}>
                      Close ticket
                    </button>
                  ) : null}
                  {ticketIsFinished ? (
                    <button type="button" className="service-tap" disabled={busy} onClick={() => setTicketStatus("open")}>
                      Reopen
                    </button>
                  ) : null}
                </div>
              </section>

              <section className="service-tickets-panel">
                <h5>Installed package (required before visit)</h5>
                {selectedTicket.job_asset_id ? (
                  <div className="service-asset-card">
                    <strong>
                      {selectedTicket.job_asset_serial || `Asset #${selectedTicket.job_asset_id}`}
                    </strong>
                    <div>{selectedTicket.job_asset_item_name || selectedTicket.job_asset_item_code || "Package"}</div>
                    <div>{selectedTicket.job_asset_site_name || selectedTicket.site_name || "—"}</div>
                  </div>
                ) : (
                  <p className="service-warn">No job asset linked yet. Link one before scheduling a site visit.</p>
                )}
                <label>
                  Link / change job asset
                  <select
                    value={selectedTicket.job_asset_id || ""}
                    onChange={(e) => linkAsset(e.target.value)}
                    disabled={busy}
                  >
                    <option value="">Select asset</option>
                    {customerAssets.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.serial_no} · {a.finished_good_item_name || a.finished_good_item_code || a.id}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="service-bom-list">
                  <h6>BOM / consumables on this package</h6>
                  {!bomLines.length ? <p>No BOM snapshot lines on this asset.</p> : null}
                  {bomLines.slice(0, 40).map((line) => (
                    <div key={line.id} className="service-bom-line">
                      <strong>{line.installed_item_code}</strong>
                      <span>{line.installed_item_name || "—"}</span>
                      <em>
                        {line.qty_installed} {line.uom || ""}
                      </em>
                    </div>
                  ))}
                </div>
              </section>

              <section className="service-tickets-panel">
                <h5>Assign engineer</h5>
                <div className="service-assign-row">
                  <select value={assignUserId} onChange={(e) => setAssignUserId(e.target.value)} disabled={busy || Boolean(assignDraft)}>
                    <option value="">Select engineer</option>
                    {bootstrap.users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.full_name || u.email}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="button-primary service-tap" onClick={assignEngineer} disabled={busy || !assignUserId || Boolean(assignDraft)}>
                    Draft assign
                  </button>
                </div>
                {assignDraft ? (
                  <div style={{ marginTop: 12 }}>
                    <ConfirmDraftCard
                      draft={assignDraft}
                      editableRemarks
                      onCancel={() => setAssignDraft(null)}
                      onConfirmed={confirmAssignDraft}
                      onError={(err) => toast(err?.data?.detail || err?.data?.error || "Assign failed.", "error")}
                    />
                  </div>
                ) : null}
              </section>

              <section className="service-tickets-panel">
                <h5>Site visits</h5>
                <form className="service-visit-create" onSubmit={scheduleVisit}>
                  <input type="date" value={visitForm.scheduled_date} onChange={(e) => setVisitForm((f) => ({ ...f, scheduled_date: e.target.value }))} />
                  <select value={visitForm.engineer_user_id} onChange={(e) => setVisitForm((f) => ({ ...f, engineer_user_id: e.target.value }))}>
                    <option value="">Engineer</option>
                    {bootstrap.users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.full_name || u.email}
                      </option>
                    ))}
                  </select>
                  <input
                    placeholder="Visit notes"
                    value={visitForm.visit_notes}
                    onChange={(e) => setVisitForm((f) => ({ ...f, visit_notes: e.target.value }))}
                  />
                  <button type="submit" className="button-primary service-tap" disabled={busy || !selectedTicket.job_asset_id}>
                    Schedule visit
                  </button>
                </form>

                {visits.map((visit) => (
                  <article key={visit.id} className="service-visit-card">
                    <div>
                      <strong>
                        Visit #{visit.visit_no} · {statusLabel(visit.visit_status)}
                      </strong>
                      <div>
                        {visit.scheduled_date || "No date"} · {visit.engineer_name || "Unassigned"}
                      </div>
                      {visit.checked_in_at ? <div>Checked in: {new Date(visit.checked_in_at).toLocaleString()}</div> : null}
                      {visit.checked_out_at ? <div>Checked out: {new Date(visit.checked_out_at).toLocaleString()}</div> : null}
                    </div>
                    <div className="service-visit-actions">
                      <button type="button" className="service-tap" disabled={busy || visit.visit_status === "completed"} onClick={() => visitAction(visit.id, "check_in")}>
                        Check in at site
                      </button>
                      <button type="button" className="service-tap" disabled={busy} onClick={() => visitAction(visit.id, "check_out")}>
                        Complete visit
                      </button>
                      <button type="button" className="service-tap" disabled={busy} onClick={() => raiseMrn(visit.id)}>
                        Raise MRN
                      </button>
                    </div>
                    <label className="service-signatory">
                      Customer signatory
                      <input value={signatory} onChange={(e) => setSignatory(e.target.value)} placeholder="Name on signed report" />
                    </label>
                    <label className="service-upload-tap">
                      Upload signed report photo
                      <input
                        type="file"
                        accept="image/*,.pdf,.heic,.heif"
                        capture="environment"
                        disabled={busy}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) uploadSignedReport(visit.id, file);
                          e.target.value = "";
                        }}
                      />
                    </label>
                    {visit.has_signed_report ? (
                      <a href={`/service-tickets/${selectedTicket.id}/visits/${visit.id}/signed-report`} target="_blank" rel="noreferrer">
                        View signed report
                      </a>
                    ) : null}
                  </article>
                ))}
              </section>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

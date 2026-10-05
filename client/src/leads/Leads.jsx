import { useEffect, useMemo, useState } from "react";
import ConfirmDraftCard from "../components/ConfirmDraftCard";
import { buildLeadToQuoteDraft } from "../shared/aiDrafts";
import { useGlobalTimeline } from "../timeline/GlobalTimelineContext";
import { appendTimelineParams } from "../timeline/globalTimeline";
import { DormancyChip, ListCountSummary } from "../shared/listScale";
import { SortTh, useSortedRows } from "../shared/tableSort";

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

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

function getLeadAttributionLabel(lead) {
  return lead?.marketing_campaign_name || lead?.marketing_exhibition_name || lead?.lead_source_name || "—";
}

function getPriorityBadge(priority) {
  const p = String(priority || "").toLowerCase();
  if (p === "urgent" || p === "critical") {
    return { bg: "#fef2f2", color: "#991b1b", border: "#fecaca" };
  }
  if (p === "high") {
    return { bg: "#fff7ed", color: "#c2410c", border: "#fed7aa" };
  }
  if (p === "low") {
    return { bg: "#f8fafc", color: "#64748b", border: "#e2e8f0" };
  }
  return { bg: "#eff6ff", color: "#1d4ed8", border: "#bfdbfe" }; // medium / default
}

function getStatusBadge(status) {
  const s = String(status || "").toLowerCase();
  if (s === "order_won" || s === "won") {
    return { bg: "#ecfdf5", color: "#047857", border: "#a7f3d0" };
  }
  if (s === "quoted") {
    return { bg: "#eff6ff", color: "#1d4ed8", border: "#bfdbfe" };
  }
  if (s === "qualified" || s === "follow_up") {
    return { bg: "#fefce8", color: "#a16207", border: "#fde047" };
  }
  if (s === "lost" || s === "cancelled" || s === "closed_no_action") {
    return { bg: "#fef2f2", color: "#b91c1c", border: "#fecaca" };
  }
  return { bg: "#f1f5f9", color: "#475569", border: "#cbd5e1" }; // new / other
}

const LEAD_PIPELINE_STATUSES = [
  "new",
  "qualified",
  "follow_up",
  "quoted",
  "order_won",
  "lost",
  "closed",
  "closed_no_action",
  "cancelled",
];
const LEAD_CLOSING_STATUSES = new Set(["lost", "closed", "closed_no_action", "cancelled", "order_won"]);
const LEAD_PRIORITY_RANK = { urgent: 0, critical: 0, high: 1, medium: 2, low: 3 };
const LEAD_SORT_SPEC = {
  lead_number: { type: "string", defaultDir: "desc" },
  company_name: { type: "string", defaultDir: "asc" },
  status: { type: "string", defaultDir: "asc" },
  priority: { type: "number", defaultDir: "asc" },
  attribution: { type: "string", defaultDir: "asc" },
  handoff: { type: "string", defaultDir: "asc" },
  assigned_to_name: { type: "string", defaultDir: "asc" },
};

function leadSortValue(row, column) {
  if (column === "priority") return LEAD_PRIORITY_RANK[String(row.priority || "medium").toLowerCase()] ?? 2;
  if (column === "attribution") return getLeadAttributionLabel(row);
  if (column === "handoff") return getLeadHandoffStage(row).label;
  if (column === "assigned_to_name") return row.assigned_to_name || "";
  return row[column];
}

function getLeadHandoffStage(lead) {
  const lifecycle = String(lead?.lifecycle_status || "").toLowerCase();
  if (lifecycle === "won" || lead?.converted_sales_order_id || lead?.converted_to_order_at) {
    return { key: "won", label: "Won", tone: "#effcf3", color: "#0b7d45" };
  }
  if (lifecycle === "lost") {
    return { key: "lost", label: "Lost", tone: "#fef2f2", color: "#b91c1c" };
  }
  if (lifecycle === "negotiation" || lead?.converted_quote_id || lead?.converted_to_quote_at) {
    return { key: "negotiation", label: "Negotiation", tone: "#eef4ff", color: "#234a8f" };
  }
  if (lifecycle === "sql") {
    return { key: "sql", label: "SQL", tone: "#fff8ea", color: "#8b5a00" };
  }
  if (lifecycle === "mql" || lead?.assigned_to) {
    return { key: "mql", label: "MQL", tone: "#f4f0ff", color: "#6b35b5" };
  }
  return { key: "new_lead", label: "New Lead", tone: "#f6f7fb", color: "#58627a" };
}

export default function Leads({ onOpenQuote, onOpenSalesOrder, onOpenCustomer, me, launch = null, onConsumeLaunch = null }) {
  const timeline = useGlobalTimeline();
  const [view, setView] = useState({ type: "list" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [leads, setLeads] = useState([]);
  const [listMeta, setListMeta] = useState(null);
  const [sources, setSources] = useState([]);
  const [users, setUsers] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [exhibitions, setExhibitions] = useState([]);
  const [filters, setFilters] = useState({
    status: "",
    sourceId: "",
    campaignId: "",
    exhibitionId: "",
    assignedTo: "",
    handoff: "",
    queue: "",
  });

  const currentId = view.type === "detail" ? view.id : null;

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    const openLeadId = Number(launch.lead_id || launch.leadId);
    setFilters((prev) => ({
      ...prev,
      status: typeof launch.status === "string" ? launch.status : prev.status,
      sourceId: launch.sourceId != null ? String(launch.sourceId) : prev.sourceId,
      campaignId: launch.campaignId != null ? String(launch.campaignId) : prev.campaignId,
      exhibitionId: launch.exhibitionId != null ? String(launch.exhibitionId) : prev.exhibitionId,
      assignedTo: typeof launch.assignedTo === "string" ? launch.assignedTo : prev.assignedTo,
      handoff: typeof launch.handoff === "string" ? launch.handoff : prev.handoff,
      queue: typeof launch.queue === "string" ? launch.queue : prev.queue,
    }));
    if (Number.isFinite(openLeadId) && openLeadId > 0) {
      setView({ type: "detail", id: openLeadId });
    } else {
      setView({ type: "list" });
    }
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  useEffect(() => {
    Promise.all([apiFetch("/leads/sources"), apiFetch("/leads/users"), apiFetch("/leads/attribution-options")])
      .then(([s, u, a]) => {
        setSources(Array.isArray(s?.sources) ? s.sources : []);
        setUsers(Array.isArray(u?.users) ? u.users : []);
        setCampaigns(Array.isArray(a?.campaigns) ? a.campaigns : []);
        setExhibitions(Array.isArray(a?.exhibitions) ? a.exhibitions : []);
      })
      .catch(() => {});
  }, []);

  async function loadList(nextFilters = filters) {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (nextFilters.queue) params.set("queue", nextFilters.queue);
      if (nextFilters.assignedTo === "me" && !nextFilters.queue) params.set("assignedTo", "me");
      if (nextFilters.assignedTo === "unassigned" && !nextFilters.queue) params.set("assignedTo", "unassigned");
      if (nextFilters.status) params.set("status", nextFilters.status);
      appendTimelineParams(params, timeline);
      const data = await apiFetch(`/leads${params.toString() ? `?${params.toString()}` : ""}`);
      setLeads(Array.isArray(data?.leads) ? data.leads : []);
      setListMeta(data?.list || null);
    } catch (e) {
      setError("Failed to load leads.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (view.type === "list") loadList(filters);
  }, [view.type, filters.queue, filters.assignedTo, filters.status, timeline.revision, timeline.date_from, timeline.date_to, timeline.preset]);

  const sourceOptions = useMemo(() => {
    const list = [{ id: "", name: "—" }];
    for (const s of sources) list.push({ id: String(s.id), name: s.source_name });
    return list;
  }, [sources]);

  const userOptions = useMemo(() => {
    const list = [{ id: "", name: "—" }];
    for (const u of users) list.push({ id: String(u.id), name: u.full_name });
    return list;
  }, [users]);
  const isSuperAdmin = me?.group_name === "SuperAdmin";
  const leadPermissions = me?.permissions?.screens?.leads || {};
  const customerPermissions = me?.permissions?.screens?.customers || {};
  const quotePermissions = me?.permissions?.screens?.quotes || {};
  const canCreateLead = isSuperAdmin || Boolean(leadPermissions.can_create);
  const canEditLead = isSuperAdmin || Boolean(leadPermissions.can_edit);
  const canConvertLead = isSuperAdmin || Boolean(customerPermissions.can_create || customerPermissions.can_edit);
  const canCreateQuote = isSuperAdmin || Boolean(quotePermissions.can_create);
  const filteredLeads = useMemo(() => {
    return leads.filter((lead) => {
      if (filters.status && String(lead.status || "") !== filters.status) return false;
      if (filters.sourceId && String(lead.lead_source_id || "") !== filters.sourceId) return false;
      if (filters.campaignId && String(lead.marketing_campaign_id || "") !== filters.campaignId) return false;
      if (filters.exhibitionId && String(lead.marketing_exhibition_id || "") !== filters.exhibitionId) return false;
      if (filters.assignedTo === "assigned" && !lead.assigned_to) return false;
      if (filters.assignedTo === "unassigned" && lead.assigned_to) return false;
      if (filters.assignedTo === "me" && String(lead.assigned_to || "") !== String(me?.id || "")) return false;
      if (filters.handoff && getLeadHandoffStage(lead).key !== filters.handoff) return false;
      return true;
    });
  }, [filters, leads, me?.id]);
  const { sort, onSort, sorted: sortedLeads } = useSortedRows(
    filteredLeads,
    LEAD_SORT_SPEC,
    { column: "lead_number", dir: "desc" },
    { storageKey: "josh.leads.sort.v1", getValue: leadSortValue, tieBreak: (row) => row.lead_number }
  );
  const listStats = useMemo(() => {
    const stageOf = (lead) => getLeadHandoffStage(lead).key;
    return {
      total: filteredLeads.length,
      attributed: filteredLeads.filter((lead) => Boolean(lead.marketing_campaign_id || lead.marketing_exhibition_id || lead.lead_source_id)).length,
      handoff: filteredLeads.filter((lead) => ["mql", "sql"].includes(stageOf(lead))).length,
      quoted: filteredLeads.filter((lead) => stageOf(lead) === "negotiation").length,
      ordered: filteredLeads.filter((lead) => stageOf(lead) === "won").length,
      dormant: filteredLeads.filter((lead) => lead.is_dormant).length,
    };
  }, [filteredLeads]);
  const statsScopeHint =
    listMeta && Number(listMeta.total_count) > leads.length
      ? `Counts cover the ${leads.length.toLocaleString("en-IN")} newest loaded leads`
      : "";
  const statusChoices = useMemo(() => {
    const fromData = leads.map((lead) => String(lead.status || "").trim()).filter(Boolean);
    return Array.from(new Set([...LEAD_PIPELINE_STATUSES, ...fromData])).sort();
  }, [leads]);
  const stageStrip = useMemo(() => {
    return LEAD_PIPELINE_STATUSES.map((status) => ({
      key: status,
      label: status.replace(/_/g, " "),
      count: leads.filter((lead) => String(lead.status || "") === status).length,
    }));
  }, [leads]);
  const queueChips = [
    { key: "", label: "All" },
    { key: "mine", label: "Assigned to me" },
    { key: "due_today", label: "Due today" },
    { key: "sla_breached", label: "SLA breached" },
    { key: "overdue", label: "Overdue / stale" },
    { key: "quoted_not_ordered", label: "Quoted not ordered" },
  ];

  if (view.type === "new") {
    return (
      <LeadCreate
        sources={sourceOptions}
        campaigns={campaigns}
        exhibitions={exhibitions}
        onCancel={() => setView({ type: "list" })}
        onCreated={(id) => setView({ type: "detail", id })}
      />
    );
  }

  if (view.type === "detail") {
    return (
      <LeadDetail
        id={currentId}
        users={userOptions}
        onOpenQuote={onOpenQuote}
        onOpenSalesOrder={onOpenSalesOrder}
        onOpenCustomer={onOpenCustomer}
        canEditLead={canEditLead}
        canConvertLead={canConvertLead}
        canCreateQuote={canCreateQuote}
        onBack={() => setView({ type: "list" })}
      />
    );
  }

  return (
    <div style={{ maxWidth: 1280 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <h2 style={{ margin: 0, flex: 1 }}>Leads</h2>
        {canCreateLead ? <button onClick={() => setView({ type: "new" })}>New Lead</button> : null}
        <button onClick={loadList} disabled={loading}>
          Refresh
        </button>
      </div>
      <div style={{ fontSize: 13, opacity: 0.74, marginTop: 8 }}>
        Shared Sales + Marketing workspace for attribution, qualification, handoff, and commercial conversion visibility.
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        {queueChips.map((chip) => (
          <button
            key={chip.key || "all"}
            type="button"
            onClick={() => setFilters((prev) => ({ ...prev, queue: chip.key, assignedTo: chip.key === "mine" ? "me" : chip.key ? prev.assignedTo : prev.assignedTo }))}
            style={{
              border: filters.queue === chip.key ? "1px solid #96b5ff" : "1px solid #dfe5ef",
              background: filters.queue === chip.key ? "#eef4ff" : "#fff",
              color: filters.queue === chip.key ? "#1f5eff" : "#17304d",
              borderRadius: 999,
              padding: "6px 12px",
              fontSize: 12,
              fontWeight: 800,
              cursor: "pointer",
            }}
          >
            {chip.label}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
        {stageStrip.map((stage) => (
          <button
            key={stage.key}
            type="button"
            onClick={() =>
              setFilters((prev) => ({
                ...prev,
                status: prev.status === stage.key ? "" : stage.key,
                queue: "",
              }))
            }
            style={{
              border: filters.status === stage.key ? "1px solid #86efac" : "1px solid #e5e7eb",
              background: filters.status === stage.key ? "#ecfdf5" : "#fafafa",
              color: "#14532d",
              borderRadius: 8,
              padding: "8px 10px",
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
              minWidth: 88,
              textAlign: "left",
            }}
          >
            <div style={{ textTransform: "capitalize" }}>{stage.label}</div>
            <div style={{ fontSize: 16, marginTop: 2 }}>{stage.count}</div>
          </button>
        ))}
      </div>

      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}

      <div className="lead-metric-grid">
        {[
          { label: "Leads In View", value: listStats.total },
          { label: "Attributed", value: listStats.attributed },
          { label: "MQL / SQL", value: listStats.handoff },
          { label: "Negotiation / Quoted", value: listStats.quoted },
          { label: "Won / SO", value: listStats.ordered },
          { label: "Dormant", value: listStats.dormant },
        ].map((card) => (
          <div key={card.label} className="lead-metric-card" title={statsScopeHint || undefined}>
            <div style={{ fontSize: 12, opacity: 0.7 }}>{card.label}</div>
            <div style={{ fontSize: 26, fontWeight: 700, marginTop: 4 }}>{card.value}</div>
          </div>
        ))}
      </div>
      {statsScopeHint ? (
        <div style={{ marginTop: 6, fontSize: 11, color: "#64748b" }}>{statsScopeHint}; the total below is the full server count.</div>
      ) : null}

      <div style={{ marginTop: 16, border: "1px solid #e5e5e5", borderRadius: 10, padding: 12 }}>
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 10 }}>Shared Filters</div>
        <div className="lead-filter-grid">
          <Field label="Status">
            <select value={filters.status} onChange={(e) => setFilters((prev) => ({ ...prev, status: e.target.value }))} style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}>
              <option value="">All</option>
              {statusChoices.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Lead Source">
            <select value={filters.sourceId} onChange={(e) => setFilters((prev) => ({ ...prev, sourceId: e.target.value }))} style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}>
              {sourceOptions.map((source) => (
                <option key={source.id || "all"} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Campaign">
            <select value={filters.campaignId} onChange={(e) => setFilters((prev) => ({ ...prev, campaignId: e.target.value, exhibitionId: e.target.value ? "" : prev.exhibitionId }))} style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}>
              <option value="">All</option>
              {campaigns.map((campaign) => (
                <option key={campaign.id} value={String(campaign.id)}>
                  {campaign.campaign_name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Exhibition">
            <select value={filters.exhibitionId} onChange={(e) => setFilters((prev) => ({ ...prev, exhibitionId: e.target.value, campaignId: e.target.value ? "" : prev.campaignId }))} style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}>
              <option value="">All</option>
              {exhibitions.map((exhibition) => (
                <option key={exhibition.id} value={String(exhibition.id)}>
                  {exhibition.exhibition_name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Owner">
            <select value={filters.assignedTo} onChange={(e) => setFilters((prev) => ({ ...prev, assignedTo: e.target.value }))} style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}>
              <option value="">All</option>
              <option value="assigned">Assigned</option>
              <option value="unassigned">Unassigned</option>
              <option value="me">Assigned to me</option>
            </select>
          </Field>
          <Field label="Handoff Stage">
            <select value={filters.handoff} onChange={(e) => setFilters((prev) => ({ ...prev, handoff: e.target.value }))} style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}>
              <option value="">All</option>
              <option value="new_lead">New Lead</option>
              <option value="mql">MQL</option>
              <option value="sql">SQL</option>
              <option value="negotiation">Negotiation / Quoted</option>
              <option value="won">Won / SO</option>
              <option value="lost">Lost</option>
            </select>
          </Field>
        </div>
      </div>

      <ListCountSummary
        visible={sortedLeads.length}
        loaded={leads.length}
        total={listMeta?.total_count}
        cap={listMeta?.cap || 200}
        entityLabel="leads"
        loading={loading}
        extra={listStats.dormant ? `${listStats.dormant} dormant` : null}
      />

      <div className="cd-table-responsive" style={{ marginTop: 16, border: "1px solid #e2e8f0", borderRadius: 8, background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
        <table className="cd-table" style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <thead>
            <tr>
              <SortTh column="lead_number" label="Lead #" sort={sort} spec={LEAD_SORT_SPEC} onSort={onSort} className="col-left" style={{ width: "130px" }} />
              <SortTh column="company_name" label="Company" sort={sort} spec={LEAD_SORT_SPEC} onSort={onSort} className="col-left" />
              <SortTh column="status" label="Status" sort={sort} spec={LEAD_SORT_SPEC} onSort={onSort} className="col-center" style={{ width: "120px" }} align="center" />
              <SortTh column="priority" label="Priority" sort={sort} spec={LEAD_SORT_SPEC} onSort={onSort} className="col-center" style={{ width: "100px" }} align="center" />
              <SortTh column="attribution" label="Attribution" sort={sort} spec={LEAD_SORT_SPEC} onSort={onSort} className="col-left" style={{ width: "180px" }} />
              <SortTh column="handoff" label="Handoff Stage" sort={sort} spec={LEAD_SORT_SPEC} onSort={onSort} className="col-center" style={{ width: "160px" }} align="center" />
              <SortTh column="assigned_to_name" label="Assigned To" sort={sort} spec={LEAD_SORT_SPEC} onSort={onSort} className="col-left" style={{ width: "140px" }} />
              <th style={{ width: "80px" }} className="col-center">Action</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} style={{ textAlign: "center", padding: "24px 12px", color: "#64748b" }}>
                  Loading leads…
                </td>
              </tr>
            ) : sortedLeads.length ? (
              sortedLeads.map((l) => {
                const handoff = getLeadHandoffStage(l);
                const statusBadge = getStatusBadge(l.status);
                const priorityBadge = getPriorityBadge(l.priority);
                return (
                  <tr
                    key={l.id}
                    onClick={() => setView({ type: "detail", id: l.id })}
                    style={{ cursor: "pointer" }}
                  >
                    <td className="col-left" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontWeight: 700, color: "#1e40af" }}>
                      {l.lead_number}
                    </td>
                    <td className="col-left" style={{ fontWeight: 600, color: "#1e293b" }}>
                      {l.company_name}
                    </td>
                    <td className="col-center">
                      <div style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", justifyContent: "center", alignItems: "center" }}>
                        <span
                          style={{
                            display: "inline-block",
                            padding: "2px 8px",
                            borderRadius: 999,
                            fontSize: 11,
                            fontWeight: 700,
                            textTransform: "capitalize",
                            background: statusBadge.bg,
                            color: statusBadge.color,
                            border: `1px solid ${statusBadge.border}`,
                          }}
                        >
                          {String(l.status || "new").replaceAll("_", " ")}
                        </span>
                        <DormancyChip row={l} />
                      </div>
                    </td>
                    <td className="col-center">
                      <span
                        style={{
                          display: "inline-block",
                          padding: "2px 8px",
                          borderRadius: 999,
                          fontSize: 11,
                          fontWeight: 700,
                          textTransform: "capitalize",
                          background: priorityBadge.bg,
                          color: priorityBadge.color,
                          border: `1px solid ${priorityBadge.border}`,
                        }}
                      >
                        {l.priority || "medium"}
                      </span>
                    </td>
                    <td className="col-left" style={{ fontSize: 12, color: "#475569" }}>
                      {getLeadAttributionLabel(l)}
                    </td>
                    <td className="col-center">
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          padding: "2px 8px",
                          borderRadius: 999,
                          background: handoff.tone,
                          color: handoff.color,
                          border: `1px solid ${handoff.color}33`,
                          fontSize: 11,
                          fontWeight: 700,
                        }}
                      >
                        {handoff.label}
                      </span>
                    </td>
                    <td className="col-left" style={{ color: l.assigned_to_name ? "#334155" : "#94a3b8" }}>
                      {l.assigned_to_name || "—"}
                    </td>
                    <td className="col-center">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setView({ type: "detail", id: l.id });
                        }}
                        style={{
                          padding: "3px 8px",
                          fontSize: 11,
                          fontWeight: 600,
                          borderRadius: 4,
                          border: "1px solid #cbd5e1",
                          background: "#f8fafc",
                          color: "#334155",
                          cursor: "pointer",
                        }}
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={8} style={{ textAlign: "center", padding: "24px 12px", color: "#94a3b8" }}>
                  No leads match the current shared filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LeadCreateResultModal({ result, onClose, onOpenLead, onAppendExisting, onContinueNew }) {
  if (!result) return null;
  const isSuccess = result.kind === "success";
  const isDuplicate = result.kind === "duplicate";
  const title = isSuccess ? "Lead created" : isDuplicate ? "Existing lead found" : "Could not create lead";
  const accent = isSuccess ? "#0f766e" : isDuplicate ? "#b45309" : "#b91c1c";
  const primaryDup = isDuplicate && Array.isArray(result.duplicates) ? result.duplicates[0] : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="lead-create-result-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.45)",
        display: "grid",
        placeItems: "center",
        zIndex: 80,
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: "min(520px, 100%)",
          background: "#fff",
          borderRadius: 12,
          border: "1px solid #e2e8f0",
          boxShadow: "0 18px 40px rgba(15, 23, 42, 0.18)",
          padding: 20,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.04em", color: accent, textTransform: "uppercase" }}>
          {isSuccess ? "Success" : isDuplicate ? "Duplicate" : "Error"}
        </div>
        <h3 id="lead-create-result-title" style={{ margin: "6px 0 10px" }}>
          {title}
        </h3>
        <p style={{ margin: "0 0 14px", color: "#334155", lineHeight: 1.45 }}>{result.message}</p>

        {isSuccess && result.lead ? (
          <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 12, marginBottom: 14 }}>
            <div>
              <strong>{result.lead.lead_number || `Lead #${result.lead.id}`}</strong>
            </div>
            <div style={{ color: "#475569", marginTop: 4 }}>{result.lead.company_name}</div>
          </div>
        ) : null}

        {isDuplicate && Array.isArray(result.duplicates) && result.duplicates.length ? (
          <div style={{ display: "grid", gap: 8, marginBottom: 14 }}>
            {result.duplicates.slice(0, 5).map((row) => (
              <div key={row.lead_id} style={{ background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 8, padding: 12 }}>
                <div>
                  <strong>{row.lead_number || `Lead #${row.lead_id}`}</strong>
                  <span style={{ marginLeft: 8, color: "#9a3412" }}>{row.status}</span>
                </div>
                <div style={{ marginTop: 4, color: "#7c2d12" }}>{row.company_name}</div>
                <div style={{ marginTop: 6, fontSize: 13, color: "#9a3412" }}>
                  Matched phone: {row.contact_phone || row.matched_phone || "—"}
                  {row.contact_name ? ` · ${row.contact_name}` : ""}
                  {row.contact_email ? ` · ${row.contact_email}` : ""}
                </div>
                {typeof onOpenLead === "function" ? (
                  <button
                    type="button"
                    style={{ marginTop: 8 }}
                    onClick={() => onOpenLead(row.lead_id)}
                  >
                    Open existing lead
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
          {isDuplicate ? (
            <>
              <button
                type="button"
                onClick={() => onContinueNew?.()}
              >
                Continue to add new
              </button>
              <button
                type="button"
                onClick={() => primaryDup?.lead_id && onAppendExisting?.(primaryDup.lead_id)}
                disabled={!primaryDup?.lead_id}
              >
                Append to existing
              </button>
            </>
          ) : null}
          {isSuccess && result.lead?.id && typeof onOpenLead === "function" ? (
            <button type="button" onClick={() => onOpenLead(result.lead.id)}>
              Open lead
            </button>
          ) : null}
          <button type="button" onClick={onClose}>
            {isSuccess ? "Done" : isDuplicate ? "Cancel" : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}

function LeadCreate({ sources, campaigns, exhibitions, onCancel, onCreated }) {
  const [companyName, setCompanyName] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [exhibitionId, setExhibitionId] = useState("");
  const [priority, setPriority] = useState("medium");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [pincode, setPincode] = useState("");
  const [city, setCity] = useState("");
  const [stateName, setStateName] = useState("");
  const [pendingPayload, setPendingPayload] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  function buildPayload(extra = {}) {
    return {
      company_name: companyName,
      lead_source_id: sourceId ? Number(sourceId) : null,
      marketing_campaign_id: campaignId ? Number(campaignId) : null,
      marketing_exhibition_id: exhibitionId ? Number(exhibitionId) : null,
      priority,
      pincode: pincode || null,
      city: city || null,
      state: stateName || null,
      contacts: contactName
        ? [
            {
              full_name: contactName,
              email: contactEmail || null,
              phone: contactPhone || null,
              is_primary: true,
            },
          ]
        : [],
      ...extra,
    };
  }

  async function lookupPincode(code) {
    const pin = String(code || "").replace(/\D+/g, "").slice(0, 6);
    setPincode(pin);
    if (pin.length !== 6) return;
    try {
      const data = await apiFetch(`/geo/pincode/${pin}`);
      if (data?.city) setCity(data.city);
      if (data?.state) setStateName(data.state);
    } catch {
      /* unknown pin is fine */
    }
  }

  async function submit(e, extra = {}) {
    e?.preventDefault?.();
    if (saving) return;
    setSaving(true);
    setError("");
    setResult(null);
    const payload = buildPayload(extra);
    setPendingPayload(payload);
    try {
      const data = await apiFetch("/leads", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setResult({
        kind: "success",
        message: data?.appended ? "Touchpoint appended to the existing lead." : "Lead saved successfully.",
        lead: data?.lead || null,
      });
    } catch (err) {
      const code = String(err?.data?.error || "");
      if (err?.status === 409 && code === "LEAD_DUPLICATE_PHONE") {
        setResult({
          kind: "duplicate",
          message: err?.data?.message || "Existing lead found.",
          duplicates: Array.isArray(err?.data?.duplicates) ? err.data.duplicates : [],
        });
      } else {
        const detail = err?.data?.detail || err?.data?.error || "Failed to create lead.";
        setResult({
          kind: "error",
          message: String(detail),
        });
        setError(String(detail));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <form onSubmit={(e) => submit(e)} style={{ maxWidth: 720 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <h2 style={{ margin: 0, flex: 1 }}>New Lead</h2>
        <button type="button" onClick={onCancel} disabled={saving}>
          Back
        </button>
        <button type="submit" disabled={saving}>
          {saving ? "Creating…" : "Create"}
        </button>
      </div>

      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}

      <div style={{ marginTop: 16 }}>
        <Field label="Company Name">
          <input
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            required
            disabled={saving}
            style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
          />
        </Field>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Lead Source">
            <select
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              disabled={saving}
              style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
            >
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Priority">
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              disabled={saving}
              style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
            >
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </Field>
        </div>

        <h3 style={{ marginTop: 18 }}>Marketing Attribution (optional)</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Campaign">
            <select
              value={campaignId}
              onChange={(e) => {
                setCampaignId(e.target.value);
                if (e.target.value) setExhibitionId("");
              }}
              disabled={saving}
              style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
            >
              <option value="">—</option>
              {campaigns.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.campaign_name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Exhibition">
            <select
              value={exhibitionId}
              onChange={(e) => {
                setExhibitionId(e.target.value);
                if (e.target.value) setCampaignId("");
              }}
              disabled={saving}
              style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
            >
              <option value="">—</option>
              {exhibitions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.exhibition_name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <h3 style={{ marginTop: 18 }}>Primary Contact (optional)</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Full Name">
            <input
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              disabled={saving}
              style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
            />
          </Field>
          <Field label="Email">
            <input
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              disabled={saving}
              style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
            />
          </Field>
          <Field label="Phone">
            <input
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              disabled={saving}
              style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
            />
          </Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <Field label="Pincode">
            <input
              value={pincode}
              onChange={(e) => lookupPincode(e.target.value)}
              disabled={saving}
              placeholder="6-digit PIN"
              style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
            />
          </Field>
          <Field label="City">
            <input
              value={city}
              onChange={(e) => setCity(e.target.value)}
              disabled={saving}
              style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
            />
          </Field>
          <Field label="State">
            <input
              value={stateName}
              onChange={(e) => setStateName(e.target.value)}
              disabled={saving}
              style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
            />
          </Field>
        </div>
      </div>
    </form>
      <LeadCreateResultModal
        result={result}
        onClose={() => {
          const leadId = result?.kind === "success" ? result?.lead?.id : null;
          setResult(null);
          if (leadId) onCreated(leadId);
        }}
        onOpenLead={(id) => {
          setResult(null);
          onCreated(id);
        }}
        onAppendExisting={async (leadId) => {
          setResult(null);
          await submit(null, { append_to_lead_id: leadId, ...(pendingPayload || {}) });
        }}
        onContinueNew={async () => {
          setResult(null);
          await submit(null, { force_new_lead: true, ...(pendingPayload || {}) });
        }}
      />
    </>
  );
}

function LeadDetail({ id, users, onOpenQuote, onOpenSalesOrder, onOpenCustomer, onBack, canEditLead, canConvertLead, canCreateQuote }) {
  const [loading, setLoading] = useState(true);
  const [lead, setLead] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [activities, setActivities] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [error, setError] = useState("");
  const [converting, setConverting] = useState(false);
  const [creatingQuote, setCreatingQuote] = useState(false);
  const [quoteDraft, setQuoteDraft] = useState(null);

  const [activityType, setActivityType] = useState("note");
  const [activitySubject, setActivitySubject] = useState("");
  const [activityNotes, setActivityNotes] = useState("");
  const [activityDueAt, setActivityDueAt] = useState("");
  const [savingActivity, setSavingActivity] = useState(false);

  const [assignedTo, setAssignedTo] = useState("");
  const [assignReason, setAssignReason] = useState("");
  const [assignSlaHours, setAssignSlaHours] = useState("24");
  const [savingAssign, setSavingAssign] = useState(false);

  const [pipelineStatus, setPipelineStatus] = useState("new");
  const [lifecycleStatus, setLifecycleStatus] = useState("new_lead");
  const [salesActivity, setSalesActivity] = useState("uncontacted");
  const [temperature, setTemperature] = useState("warm");
  const [pipelinePriority, setPipelinePriority] = useState("medium");
  const [taxonomy, setTaxonomy] = useState(null);
  const [touchpoints, setTouchpoints] = useState([]);
  const [contactOutcome, setContactOutcome] = useState("");
  const [pincode, setPincode] = useState("");
  const [city, setCity] = useState("");
  const [stateName, setStateName] = useState("");
  const [closeReason, setCloseReason] = useState("");
  const [competitorName, setCompetitorName] = useState("");
  const [savingPipeline, setSavingPipeline] = useState(false);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch(`/leads/${id}`);
      setLead(data?.lead || null);
      setContacts(Array.isArray(data?.contacts) ? data.contacts : []);
      setActivities(Array.isArray(data?.activities) ? data.activities : []);
      setAssignments(Array.isArray(data?.assignments) ? data.assignments : []);
      setTouchpoints(Array.isArray(data?.touchpoints) ? data.touchpoints : []);
      setAssignedTo(data?.lead?.assigned_to ? String(data.lead.assigned_to) : "");
      setPipelineStatus(data?.lead?.status || "new");
      setLifecycleStatus(data?.lead?.lifecycle_status || "new_lead");
      setSalesActivity(data?.lead?.sales_activity_status || "uncontacted");
      setTemperature(data?.lead?.sales_temperature || "warm");
      setPipelinePriority(data?.lead?.priority || "medium");
      setCloseReason(data?.lead?.close_reason || "");
      setCompetitorName(data?.lead?.competitor_name || "");
      setAssignSlaHours(String(data?.lead?.assign_sla_hours || 24));
      setPincode(data?.lead?.pincode || "");
      setCity(data?.lead?.city || "");
      setStateName(data?.lead?.state || "");
    } catch {
      setError("Failed to load lead.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    apiFetch("/leads/taxonomy").then(setTaxonomy).catch(() => {});
  }, [id]);

  async function addActivity(e) {
    e.preventDefault();
    setSavingActivity(true);
    try {
      await apiFetch(`/leads/${id}/activities`, {
        method: "POST",
        body: JSON.stringify({
          activity_type: activityType,
          subject: activitySubject,
          notes: activityNotes,
          due_at: activityDueAt ? new Date(activityDueAt).toISOString() : null,
          contact_outcome: contactOutcome || null,
        }),
      });
      setActivitySubject("");
      setActivityNotes("");
      setActivityDueAt("");
      await load();
    } catch {
      setError("Failed to add activity.");
    } finally {
      setSavingActivity(false);
    }
  }

  async function saveAssignment(e) {
    e.preventDefault();
    if (!assignedTo) return;
    setSavingAssign(true);
    try {
      await apiFetch(`/leads/${id}/assign`, {
        method: "POST",
        body: JSON.stringify({
          assigned_to: Number(assignedTo),
          assignment_reason: assignReason,
          assign_sla_hours: Number(assignSlaHours) || 24,
          require_next_activity: true,
        }),
      });
      setAssignReason("");
      await load();
    } catch {
      setError("Failed to assign lead.");
    } finally {
      setSavingAssign(false);
    }
  }

  async function savePipeline(e) {
    e.preventDefault();
    setSavingPipeline(true);
    setError("");
    try {
      await apiFetch(`/leads/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: pipelineStatus,
          lifecycle_status: lifecycleStatus,
          sales_activity_status: salesActivity,
          sales_temperature: temperature,
          priority: pipelinePriority,
          close_reason: closeReason || null,
          competitor_name: competitorName || null,
          pincode: pincode || null,
          city: city || null,
          state: stateName || null,
        }),
      });
      await load();
    } catch (err) {
      if (err?.data?.error === "CLOSE_REASON_REQUIRED") {
        setError("Closing statuses require a close reason.");
      } else {
        setError("Failed to update pipeline status.");
      }
    } finally {
      setSavingPipeline(false);
    }
  }

  async function convertToCustomer() {
    setConverting(true);
    setError("");
    try {
      await apiFetch(`/leads/${id}/convert-to-customer`, { method: "POST" });
      await load();
    } catch (e) {
      if (e?.data?.error === "CUSTOMER_PERMISSION_REQUIRED") {
        setError("Customer conversion follows customer permissions.");
      } else {
        setError("Failed to convert lead to customer.");
      }
    } finally {
      setConverting(false);
    }
  }

  async function createQuote() {
    const draft = buildLeadToQuoteDraft({ lead, contacts });
    if (!draft) {
      setError("Lead is not ready for a quote draft.");
      return;
    }
    setError("");
    setQuoteDraft(draft);
  }

  async function confirmQuoteDraft(data) {
    setCreatingQuote(true);
    setQuoteDraft(null);
    try {
      const quoteId = data?.quote?.id;
      if (quoteId && typeof onOpenQuote === "function") onOpenQuote(quoteId, { builder: true });
      await load();
    } finally {
      setCreatingQuote(false);
    }
  }

  if (loading) return <div style={{ paddingTop: 12 }}>Loading…</div>;
  if (error) return <div style={{ paddingTop: 12, color: "#b00020" }}>{error}</div>;
  if (!lead) return <div style={{ paddingTop: 12 }}>Not found.</div>;

  return (
    <div style={{ maxWidth: 1000 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={onBack}>Back</button>
        <div style={{ flex: 1, minWidth: 200 }}>
          <h2 style={{ margin: 0 }}>{lead.company_name}</h2>
          <div style={{ opacity: 0.75, fontSize: 12 }}>
            {lead.lead_number} • {lead.lifecycle_status || lead.status} • {lead.sales_activity_status || "—"} • {lead.sales_temperature || lead.priority}
            {lead.engagement_score != null ? ` • score ${Number(lead.engagement_score).toFixed(0)}` : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {lead.converted_quote_id && typeof onOpenQuote === "function" ? (
            <button type="button" onClick={() => onOpenQuote(lead.converted_quote_id)}>
              Open Quote
            </button>
          ) : null}
          {lead.converted_sales_order_id && typeof onOpenSalesOrder === "function" ? (
            <button type="button" onClick={() => onOpenSalesOrder(lead.converted_sales_order_id)}>
              Open Sales Order
            </button>
          ) : null}
          {canCreateQuote ? (
            <button type="button" onClick={createQuote} disabled={creatingQuote || Boolean(quoteDraft)}>
              {creatingQuote ? "Starting quote…" : lead?.customer_id ? "Draft Quote" : "Draft Customer + Quote"}
            </button>
          ) : null}
        </div>
      </div>

      {quoteDraft ? (
        <div style={{ marginTop: 16 }}>
          <ConfirmDraftCard
            draft={quoteDraft}
            onCancel={() => setQuoteDraft(null)}
            onConfirmed={(data) => confirmQuoteDraft(data)}
            onError={(e) => {
              if (e?.data?.error === "LEAD_NOT_LINKED_TO_CUSTOMER") setError("Convert lead to customer first.");
              else if (e?.data?.error === "CUSTOMER_PERMISSION_REQUIRED") {
                setError("Customer create rights are required to start a quote from this lead.");
              } else setError(e?.data?.error || "Failed to create quote.");
              setQuoteDraft(null);
            }}
          />
        </div>
      ) : null}

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 8, padding: 12 }}>
          <h3 style={{ marginTop: 0 }}>Contacts</h3>
          {contacts.length ? (
            contacts.map((c) => (
              <div key={c.id} style={{ padding: "8px 0", borderBottom: "1px solid #f2f2f2" }}>
                <div style={{ fontWeight: 600 }}>
                  {c.full_name} {c.is_primary ? "(Primary)" : ""}
                </div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>
                  {[c.email, c.phone, c.designation].filter(Boolean).join(" • ") || "—"}
                </div>
              </div>
            ))
          ) : (
            <div style={{ opacity: 0.7 }}>No contacts.</div>
          )}
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 8, padding: 12 }}>
          <h3 style={{ marginTop: 0 }}>Customer</h3>
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
            {lead.customer_name ? `Linked: ${lead.customer_name}` : "Not linked"}
          </div>
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
            Attribution: {lead.marketing_campaign_name || lead.marketing_exhibition_name || lead.lead_source_name || "Not tagged"}
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {lead.customer_id && typeof onOpenCustomer === "function" ? (
              <button type="button" onClick={() => onOpenCustomer(Number(lead.customer_id))}>
                Open Customer
              </button>
            ) : null}
            {canConvertLead ? (
              <button
                type="button"
                onClick={convertToCustomer}
                disabled={converting || Boolean(lead.customer_id)}
              >
                Convert Lead to Customer
              </button>
            ) : null}
          </div>
          {!canConvertLead || !canCreateQuote ? (
            <div style={{ fontSize: 12, opacity: 0.72, marginTop: 10 }}>
              {!canConvertLead ? "Customer conversion follows customer permissions. " : ""}
              {!canCreateQuote ? "Quote creation follows quote permissions." : ""}
            </div>
          ) : null}

          <div style={{ marginTop: 16, borderTop: "1px solid #f2f2f2", paddingTop: 16 }}>
            <h3 style={{ marginTop: 0 }}>Lifecycle & sales activity</h3>
            {canEditLead ? (
              <form onSubmit={savePipeline}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <Field label="Lifecycle">
                    <select
                      value={lifecycleStatus}
                      onChange={(e) => setLifecycleStatus(e.target.value)}
                      style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
                    >
                      {(taxonomy?.lifecycle || [{ code: lifecycleStatus, label: lifecycleStatus }]).map((item) => (
                        <option key={item.code} value={item.code}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Sales activity">
                    <select
                      value={salesActivity}
                      onChange={(e) => setSalesActivity(e.target.value)}
                      style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
                    >
                      {(taxonomy?.sales_activity || [{ code: salesActivity, label: salesActivity }]).map((item) => (
                        <option key={item.code} value={item.code}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <Field label="Temperature">
                    <select
                      value={temperature}
                      onChange={(e) => setTemperature(e.target.value)}
                      style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
                    >
                      {(taxonomy?.temperatures || [{ code: "warm", label: "Warm" }]).map((item) => (
                        <option key={item.code} value={item.code}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Legacy status">
                    <select
                      value={pipelineStatus}
                      onChange={(e) => setPipelineStatus(e.target.value)}
                      style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
                    >
                      {LEAD_PIPELINE_STATUSES.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                  <Field label="Pincode">
                    <input
                      value={pincode}
                      onChange={(e) => setPincode(e.target.value)}
                      style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
                    />
                  </Field>
                  <Field label="City">
                    <input
                      value={city}
                      onChange={(e) => setCity(e.target.value)}
                      style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
                    />
                  </Field>
                  <Field label="State">
                    <input
                      value={stateName}
                      onChange={(e) => setStateName(e.target.value)}
                      style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
                    />
                  </Field>
                </div>
                <Field label="Priority">
                  <select
                    value={pipelinePriority}
                    onChange={(e) => setPipelinePriority(e.target.value)}
                    style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
                  >
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                  </select>
                </Field>
                {LEAD_CLOSING_STATUSES.has(pipelineStatus) ? (
                  <>
                    <Field label="Close reason (required)">
                      <input
                        value={closeReason}
                        onChange={(e) => setCloseReason(e.target.value)}
                        required
                        style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
                      />
                    </Field>
                    <Field label="Competitor (optional)">
                      <input
                        value={competitorName}
                        onChange={(e) => setCompetitorName(e.target.value)}
                        style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
                      />
                    </Field>
                  </>
                ) : null}
                <button type="submit" disabled={savingPipeline}>
                  {savingPipeline ? "Saving…" : "Save Pipeline"}
                </button>
              </form>
            ) : (
              <div style={{ fontSize: 12, opacity: 0.72 }}>
                Status: {lead.status} · Priority: {lead.priority}
                {lead.close_reason ? ` · Close: ${lead.close_reason}` : ""}
              </div>
            )}
          </div>

          <div style={{ marginTop: 16, borderTop: "1px solid #f2f2f2", paddingTop: 16 }}>
            <h3 style={{ marginTop: 0 }}>Channel history</h3>
            {touchpoints.length ? (
              <div style={{ display: "grid", gap: 8 }}>
                {touchpoints.map((tp) => (
                  <div key={tp.id} style={{ fontSize: 13, padding: "8px 10px", background: "#f8fafc", borderRadius: 8 }}>
                    <strong>{String(tp.channel || "manual").replace(/_/g, " ")}</strong>
                    {" · "}
                    {tp.occurred_at ? new Date(tp.occurred_at).toLocaleString() : "—"}
                    {tp.match_method ? ` · ${tp.match_method}` : ""}
                    {tp.utm_source ? ` · utm ${tp.utm_source}` : ""}
                    {tp.gclid ? " · gclid" : ""}
                    {tp.fbclid ? " · fbclid" : ""}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, opacity: 0.7 }}>No channel touchpoints yet.</div>
            )}
          </div>

          <div style={{ marginTop: 16, borderTop: "1px solid #f2f2f2", paddingTop: 16 }}>
            <h3 style={{ marginTop: 0 }}>Assignment</h3>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
              Current: {lead.assigned_to_name || "—"}
              {lead.assigned_at ? ` · Assigned ${new Date(lead.assigned_at).toLocaleString()}` : ""}
              {lead.assign_sla_hours ? ` · SLA ${lead.assign_sla_hours}h` : ""}
            </div>
            {canEditLead ? (
              <form onSubmit={saveAssignment}>
                <Field label="Assign To">
                  <select
                    value={assignedTo}
                    onChange={(e) => setAssignedTo(e.target.value)}
                    style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
                  >
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Assign SLA hours">
                  <input
                    type="number"
                    min="1"
                    max="168"
                    value={assignSlaHours}
                    onChange={(e) => setAssignSlaHours(e.target.value)}
                    style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
                  />
                </Field>
                <Field label="Reason (optional)">
                  <input
                    value={assignReason}
                    onChange={(e) => setAssignReason(e.target.value)}
                    style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
                  />
                </Field>
                <button type="submit" disabled={savingAssign}>
                  Save Assignment
                </button>
              </form>
            ) : (
              <div style={{ fontSize: 12, opacity: 0.72 }}>Assignment changes follow lead edit permissions.</div>
            )}

            {assignments.length ? (
              <div style={{ marginTop: 12 }}>
                <h4 style={{ margin: "12px 0 8px" }}>History</h4>
                {assignments.slice(0, 8).map((a) => (
                  <div key={a.id} style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>
                    {a.assigned_to_name} by {a.assigned_by_name}
                    {a.assignment_reason ? ` • ${a.assignment_reason}` : ""}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {canEditLead ? (
        <div style={{ marginTop: 16, border: "1px solid #e5e5e5", borderRadius: 8, padding: 12 }}>
          <h3 style={{ marginTop: 0 }}>Add Activity</h3>
          <form onSubmit={addActivity}>
            <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 12 }}>
              <Field label="Type">
                <select
                  value={activityType}
                  onChange={(e) => setActivityType(e.target.value)}
                  style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
                >
                  <option value="note">note</option>
                  <option value="call">call</option>
                  <option value="meeting">meeting</option>
                  <option value="email">email</option>
                  <option value="whatsapp">whatsapp</option>
                </select>
              </Field>
              <Field label="Subject">
                <input
                  value={activitySubject}
                  onChange={(e) => setActivitySubject(e.target.value)}
                  required
                  style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
                />
              </Field>
            </div>
            <Field label="Contact outcome">
              <select
                value={contactOutcome}
                onChange={(e) => setContactOutcome(e.target.value)}
                style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
              >
                <option value="">—</option>
                {(taxonomy?.contact_outcomes || []).map((code) => (
                  <option key={code} value={code}>
                    {code.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Due (optional)">
              <input
                type="datetime-local"
                value={activityDueAt}
                onChange={(e) => setActivityDueAt(e.target.value)}
                style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
              />
            </Field>
            <Field label="Notes (optional)">
              <textarea
                value={activityNotes}
                onChange={(e) => setActivityNotes(e.target.value)}
                rows={3}
                style={{ width: "100%", padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
              />
            </Field>
            <button type="submit" disabled={savingActivity}>
              Add Activity
            </button>
          </form>
        </div>
      ) : null}

      <div style={{ marginTop: 16, border: "1px solid #e5e5e5", borderRadius: 8, padding: 12 }}>
        <h3 style={{ marginTop: 0 }}>Activities</h3>
        {activities.length ? (
          activities.map((a) => (
            <div key={a.id} style={{ padding: "8px 0", borderBottom: "1px solid #f2f2f2" }}>
              <div style={{ fontWeight: 600 }}>
                {a.activity_type}: {a.subject}
              </div>
              <div style={{ fontSize: 12, opacity: 0.8 }}>
                {(a.created_by_name || "—") +
                  (a.activity_at ? ` • ${new Date(a.activity_at).toLocaleString()}` : "") +
                  (a.due_at ? ` • due ${new Date(a.due_at).toLocaleString()}` : "")}
              </div>
              {a.notes ? <div style={{ marginTop: 6 }}>{a.notes}</div> : null}
            </div>
          ))
        ) : (
          <div style={{ opacity: 0.7 }}>No activities.</div>
        )}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { toast } from "../shared/joshUi";

const STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "triaged", label: "Triaged" },
  { value: "done", label: "Done" },
  { value: "wont_fix", label: "Won't fix" },
];

const TYPE_OPTIONS = [
  { value: "all", label: "All types" },
  { value: "blocked", label: "Blocked" },
  { value: "confusing", label: "Confusing" },
  { value: "suggestion", label: "Suggestion" },
];

async function apiFetch(path, options) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || "Request failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function formatWhen(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function typeLabel(value) {
  if (value === "blocked") return "Blocked";
  if (value === "confusing") return "Confusing";
  if (value === "suggestion") return "Suggestion";
  return value || "—";
}

export default function PilotFeedbackNotes({ onNavigate }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState([]);
  const [summary, setSummary] = useState(null);
  const [statusFilter, setStatusFilter] = useState("open");
  const [typeFilter, setTypeFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [triageBusy, setTriageBusy] = useState(false);
  async function loadAll() {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (typeFilter !== "all") params.set("note_type", typeFilter);
      if (query.trim()) params.set("q", query.trim());
      params.set("limit", "200");

      const [list, sum] = await Promise.all([
        apiFetch(`/hr/pilot-feedback?${params.toString()}`),
        apiFetch("/hr/pilot-feedback/summary"),
      ]);
      const rows = Array.isArray(list?.notes) ? list.notes : [];
      setNotes(rows);
      setSummary(sum?.summary || null);
      setDrafts((prev) => {
        const next = { ...prev };
        for (const row of rows) {
          if (!next[row.id]) {
            next[row.id] = {
              status: row.status || "open",
              triage_note: row.triage_note || "",
            };
          }
        }
        return next;
      });
    } catch (e) {
      setError(e?.data?.error || "Failed to load pilot notes.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, typeFilter]);

  const stats = useMemo(() => {
    const s = summary || {};
    return [
      { label: "Open", value: s.open_count ?? "—", note: "Waiting triage", accent: "#b45309" },
      { label: "Blocked", value: s.blocked_open ?? "—", note: "Live blockers", accent: "#b91c1c" },
      { label: "Confusing", value: s.confusing_open ?? "—", note: "Clarity gaps", accent: "#1d4ed8" },
      { label: "Suggestions", value: s.suggestion_open ?? "—", note: "Improve later", accent: "#0f766e" },
    ];
  }, [summary]);

  function setDraft(id, patch) {
    setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }));
  }

  async function saveTriage(row) {
    const draft = drafts[row.id] || { status: row.status, triage_note: row.triage_note || "" };
    setBusyId(row.id);
    try {
      await apiFetch(`/hr/pilot-feedback/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: draft.status,
          triage_note: draft.triage_note,
        }),
      });
      toast("Note updated.", "success");
      await loadAll();
    } catch (e) {
      toast(e?.data?.error || "Could not update note.", "error");
    } finally {
      setBusyId(null);
    }
  }

  async function runCursorTriage() {
    if (triageBusy) return;
    const openCount = Number(summary?.open_count || notes.filter((n) => n.status === "open").length || 0);
    if (!openCount) {
      toast("No open notes to triage.", "error");
      return;
    }
    setTriageBusy(true);
    try {
      const data = await apiFetch("/hr/pilot-feedback/run-triage", { method: "POST", body: "{}" });
      const count = Number(data?.note_count || 0);
      toast(
        count
          ? `Sent ${count} open note${count === 1 ? "" : "s"} to Cursor. Review the proposal when it finishes.`
          : "Triage started in Cursor.",
        "success"
      );
    } catch (e) {
      const code = String(e?.data?.error || "");
      const message =
        code === "NO_OPEN_NOTES"
          ? "No open notes to triage."
          : code === "TRIAGE_WEBHOOK_NOT_CONFIGURED"
            ? "Cursor triage webhook is not configured on the server."
            : code === "TRIAGE_WEBHOOK_FAILED"
              ? "Cursor webhook failed. Check the automation is active and the token is valid."
              : e?.data?.error || "Could not start Cursor triage.";
      toast(message, "error");
    } finally {
      setTriageBusy(false);
    }
  }

  return (
    <div className="pilot-notes-shell">
      <div className="pilot-notes-hero">
        <div>
          <div className="panel-kicker">Pilot queue</div>
          <h3>Live feedback notes</h3>
          <p>Newest pilot notes from every desk. Triage blockers first, then confusion, then suggestions.</p>
        </div>
        <div className="pilot-notes-hero-actions">
          <button
            type="button"
            className="button-primary compact-button"
            onClick={() => runCursorTriage()}
            disabled={loading || triageBusy}
          >
            {triageBusy ? "Starting…" : "Run triage"}
          </button>
          <button type="button" className="button-ghost compact-button" onClick={() => loadAll()} disabled={loading}>
            Refresh
          </button>
          {typeof onNavigate === "function" ? (
            <button type="button" className="button-ghost compact-button" onClick={() => onNavigate("superadmin_home", { resetQuote: true })}>
              SuperAdmin Home
            </button>
          ) : null}
        </div>
      </div>

      <div className="pilot-notes-stats">
        {stats.map((item) => (
          <article key={item.label} className="pilot-notes-stat" style={{ borderTopColor: item.accent }}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
            <em>{item.note}</em>
          </article>
        ))}
      </div>

      <div className="pilot-notes-filters">
        <label>
          <span>Status</span>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">All statuses</option>
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Type</span>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            {TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className="pilot-notes-search">
          <span>Search</span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, desk, doc no., text"
            onKeyDown={(e) => {
              if (e.key === "Enter") loadAll();
            }}
          />
        </label>
        <button type="button" className="button-primary compact-button" onClick={() => loadAll()} disabled={loading}>
          Apply
        </button>
      </div>

      {error ? <div className="pilot-notes-error">{error}</div> : null}
      {loading ? <div className="pilot-notes-empty">Loading notes…</div> : null}
      {!loading && !notes.length ? <div className="pilot-notes-empty">No notes match this filter.</div> : null}

      <div className="pilot-notes-list">
        {notes.map((row) => {
          const draft = drafts[row.id] || { status: row.status, triage_note: row.triage_note || "" };
          return (
            <article key={row.id} className="pilot-notes-card" data-type={row.note_type} data-status={row.status}>
              <div className="pilot-notes-card-top">
                <div className="pilot-notes-badges">
                  <span className={`pilot-notes-badge type-${row.note_type}`}>{typeLabel(row.note_type)}</span>
                  <span className={`pilot-notes-badge status-${row.status}`}>{row.status}</span>
                  <span className="pilot-notes-badge">{row.company_code || row.company_code_resolved || "—"}</span>
                </div>
                <time>{formatWhen(row.created_at)}</time>
              </div>

              <div className="pilot-notes-meta">
                <strong>{row.created_by_name || row.created_by_email}</strong>
                <span>{row.created_by_email}</span>
                <span>
                  Desk: {row.desk_label || row.desk_page}
                  {typeof onNavigate === "function" && row.desk_page ? (
                    <>
                      {" · "}
                      <button type="button" className="linkish-button" onClick={() => onNavigate(row.desk_page, { resetQuote: true })}>
                        Open desk
                      </button>
                    </>
                  ) : null}
                </span>
                {row.reference_no ? <span>Ref: {row.reference_no}</span> : null}
                {row.has_screenshot || row.screenshot_attachment_id ? (
                  <a href={`/hr/pilot-feedback/${row.id}/screenshot`} target="_blank" rel="noreferrer">
                    Screenshot
                  </a>
                ) : null}
              </div>

              <p className="pilot-notes-body">{row.note_body}</p>

              <div className="pilot-notes-triage">
                <label>
                  <span>Status</span>
                  <select
                    value={draft.status}
                    disabled={busyId === row.id}
                    onChange={(e) => setDraft(row.id, { status: e.target.value })}
                  >
                    {STATUS_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="pilot-notes-triage-note">
                  <span>Triage note</span>
                  <input
                    type="text"
                    value={draft.triage_note}
                    disabled={busyId === row.id}
                    onChange={(e) => setDraft(row.id, { triage_note: e.target.value })}
                    placeholder="Fix planned / explained / deferred"
                  />
                </label>
                <button
                  type="button"
                  className="button-primary compact-button"
                  disabled={busyId === row.id}
                  onClick={() => saveTriage(row)}
                >
                  {busyId === row.id ? "Saving…" : "Save"}
                </button>
              </div>

              {row.triaged_by_name || row.triaged_at ? (
                <div className="pilot-notes-triage-meta">
                  Last triage: {row.triaged_by_name || "—"} · {formatWhen(row.triaged_at)}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}

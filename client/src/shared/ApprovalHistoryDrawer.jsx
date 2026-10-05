import { useEffect, useMemo, useState } from "react";
import { DeskChip, NoticeBanner } from "./joshUi";

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

function fmtDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function actionLabel(action) {
  if (action === "submitted") return "Submitted";
  if (action === "approved") return "Approved";
  if (action === "sent_back") return "Sent Back";
  if (action === "posted") return "Posted";
  return action || "—";
}

function scopeLabel(row) {
  const parts = [];
  if (row.policy_group_name) parts.push(row.policy_group_name);
  if (row.policy_role_name) parts.push(row.policy_role_name);
  return parts.length ? parts.join(" / ") : row.policy_id ? "Policy" : "—";
}

function actionTone(action) {
  const a = String(action || "").toLowerCase();
  if (["approved", "posted"].includes(a)) return { tone: "#effcf3", color: "#0b7d45" };
  if (["sent_back"].includes(a)) return { tone: "#fff6e8", color: "#8b5a00" };
  if (["submitted"].includes(a)) return { tone: "#eef4ff", color: "#234a8f" };
  return { tone: "#f5f6fa", color: "#5d6782" };
}

export default function ApprovalHistoryDrawer({
  open,
  onClose,
  docType,
  docId,
  remarks,
  onRemarksChange,
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [rows, setRows] = useState([]);

  const key = useMemo(() => `${docType}:${docId}`, [docType, docId]);

  useEffect(() => {
    if (!open) return;
    const id = Number(docId);
    if (!docType || !Number.isFinite(id) || id <= 0) return;
    setLoading(true);
    setError("");
    apiFetch(`/approval-history/${encodeURIComponent(docType)}/${encodeURIComponent(String(id))}`)
      .then((data) => setRows(Array.isArray(data?.history) ? data.history : []))
      .catch((e) => setError(e?.data?.error || "Failed to load approval history."))
      .finally(() => setLoading(false));
  }, [open, key]);

  if (!open) return null;

  return (
    <>
      <div
        onClick={onClose}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose?.();
        }}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.25)",
          zIndex: 60,
        }}
      />
      <aside
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          height: "100vh",
          width: 480,
          maxWidth: "92vw",
          background: "#f8faff",
          borderLeft: "1px solid #dfe6f2",
          zIndex: 61,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ padding: 16, borderBottom: "1px solid #e2e8f3", display: "flex", gap: 12, alignItems: "center", background: "#ffffff" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Approval History</div>
            <div style={{ fontWeight: 800, marginTop: 4, fontSize: 18 }}>
              {docType} #{docId}
            </div>
          </div>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <div style={{ padding: 16, borderBottom: "1px solid #e2e8f3", background: "#ffffff" }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Remarks For Next Action</div>
          <textarea
            value={remarks || ""}
            onChange={(e) => onRemarksChange?.(e.target.value)}
            rows={4}
            style={{ width: "100%", padding: 10, borderRadius: 12, border: "1px solid #d8dfeb", resize: "vertical" }}
            placeholder="Type approval / send-back remarks to be recorded with your next action."
          />
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginTop: 10 }}>
            <button type="button" onClick={() => onRemarksChange?.("")}>
              Clear
            </button>
            <button type="button" onClick={() => apiFetch(`/approval-history/${encodeURIComponent(docType)}/${encodeURIComponent(String(docId))}`).then((data) => setRows(Array.isArray(data?.history) ? data.history : [])).catch(() => {})}>
              Refresh History
            </button>
          </div>
        </div>

        <div style={{ padding: 16, overflow: "auto" }}>
          <NoticeBanner tone="error" message={error} />
          {loading ? <div style={{ padding: 10, opacity: 0.75 }}>Loading history…</div> : null}

          {!loading && !rows.length ? (
            <div style={{ padding: 16, borderRadius: 16, background: "#ffffff", border: "1px dashed #d5dcec", opacity: 0.75 }}>No history recorded yet.</div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {rows.map((row) => {
                const tone = actionTone(row.action);
                return (
                <div key={row.id} style={{ border: "1px solid #e5edf7", borderRadius: 14, padding: 12, background: "#ffffff" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
                    <DeskChip label={actionLabel(row.action).toUpperCase()} tone={tone.tone} color={tone.color} />
                    <div style={{ fontSize: 12, opacity: 0.72 }}>{fmtDateTime(row.acted_at)}</div>
                  </div>
                  <div style={{ fontSize: 13, opacity: 0.9, marginTop: 6 }}>
                    {(row.acted_by_name || row.acted_by_email) ? `${row.acted_by_name || row.acted_by_email}` : "—"}
                    {Number(row.action_level || 0) > 0 ? ` • L${row.action_level}` : ""}
                    {row.policy_id ? ` • ${scopeLabel(row)}` : ""}
                  </div>
                  {row.remarks ? (
                    <div style={{ marginTop: 10, padding: 10, background: "#f8faff", borderRadius: 10, whiteSpace: "pre-wrap", border: "1px solid #edf2fb" }}>
                      {row.remarks}
                    </div>
                  ) : (
                    <div style={{ marginTop: 10, opacity: 0.6 }}>No remarks.</div>
                  )}
                </div>
              )})}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
